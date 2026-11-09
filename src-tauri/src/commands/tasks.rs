//! Tauri commands for the per-Space Task board (spec §2 — ADR 0090).
//!
//! EIGHT commands. Seven of them are a `spawn_blocking` delegation to `impl Db`
//! in `storage/db.rs`, in the shape `commands/spaces.rs` sets:
//! `State<'_, Arc<Db>>` first, `state.inner().clone()` into the closure,
//! `Result<_, TasksError>` out. The eighth, [`start_task_session`], returns the
//! `SessionError` family instead because it is a Session command wearing board
//! clothing — see its own doc.
//! The blocking rule is the file rule from `commands/files/mod.rs`, restated in
//! `spaces.rs`: SQLite work goes on a worker thread, and it is
//! `tauri::async_runtime::spawn_blocking`, not `tokio::task::spawn_blocking` —
//! both compile, one file speaking two dialects does not.
//!
//! What the storage layer does NOT do, and this layer therefore must: run a
//! stage's `on_enter` boost. Compacting needs the `SessionManager`, and `Db`
//! cannot name it — which is why `Db::move_task` returns the destination's
//! `on_enter` and the compaction happens HERE (spec §5).
//!
//! `start_task_session` (A4, spec §3) is the one command that needs BOTH managed
//! types: the `SessionManager` to start the Session and the `Db` to record the
//! `task_sessions` link. Its core is factored into
//! [`start_task_session_inner`] for the same reason `commands/settings.rs`
//! factors `save_settings_and_push` — `tauri::State` cannot be built in a unit
//! test, and "the start actually happens, then the link" is exactly the property
//! a green suite would otherwise fake.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent::{debuglog, EventSink, SessionError, SessionInfo, SessionManager, TasksError};
use crate::storage::{Db, StageWithTasks, TaskRow, TaskSessionRow};

/// What a `move_task` reports: the destination stage's `on_enter`, plus — only
/// when this layer owed the caller a boost it could not deliver — why.
///
/// The `boostNote` field is why this is a command-layer DTO and not a re-export
/// of the storage layer's `MoveOutcome`: the MOVE and the BOOST are two outcomes,
/// and folding them into one `Result` makes one of them lie. An `Err` would tell
/// the frontend that a drag which succeeded had failed; dropping the note would
/// be exactly the silent-green spec §5's caveat 2 calls out ("a stored
/// (non-live) Session is a silent no-op"). So the move's truth is `onEnter` and
/// the boost's truth is `boostNote`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTaskOutcome {
    /// `'none' | 'compact' | 'fresh'` — the stage the card landed in.
    pub on_enter: String,
    /// `Some(..)` when `onEnter == "compact"` and no compaction was delivered.
    /// `None` when nothing was owed, or when the boost was requested. A NOTE,
    /// never a failure: the card moved either way.
    pub boost_note: Option<String>,
}

/// The sentence for a `compact` stage that had nothing to compact.
///
/// Spec §5's caveat 2, stated rather than implied: `Ok(false)` from
/// `compact_session` means the Session is stored rather than live, so the boost
/// the user configured simply did not happen. Surfacing it is the whole point —
/// this repo keeps documenting the shape where a configured effect silently
/// fails to fire.
const NO_LIVE_SESSION: &str = "no live session to compact";

/// Clean a Task title, or refuse it.
///
/// `Err(EmptyTitle)` means "do not write this card": the raw input is NOT a
/// fallback. A whitespace-only or bare-quote title would otherwise land in
/// `tasks.title` — NOT NULL — as a card whose label is nothing, and the session
/// path (`naming.rs`) already refuses exactly that input, so a raw fallback would
/// make the two title writers disagree about what a title is.
///
/// Reuses the session namer's `clean_title` (whitespace runs collapse, ONE layer
/// of matching quotes strips, capped at 80 CHARS) rather than writing the chain a
/// second time. It reaches here through the two-hop `pub(crate) use` chain in
/// `agent/mod.rs` + `agent/session/mod.rs`, because `mod naming` and
/// `mod session` are both private and stay that way.
///
/// The Ok payload is the CLEANED title and that is what gets stored: the caller
/// writes what this approved, never what it was handed.
fn require_title(raw: &str) -> Result<String, TasksError> {
    crate::agent::clean_title(raw).ok_or(TasksError::EmptyTitle)
}

/// Flatten the TWO error layers a board command crosses: the join (the worker
/// thread died) and the storage error (the database refused, or the row is not
/// there).
///
/// `commands/spaces.rs` needs no such helper because its storage calls fail with
/// `DbError`, which every `SpacesError` arm already covers via a blanket
/// `Database(_)` mapping; here the storage layer speaks `BoardError` and two of
/// its three cases are ABSENCES that must not be flattened into a database error
/// (`not_found` is what tells the frontend to drop a card and tells a model its
/// slug was wrong — ADR 0090). Hence the `From<BoardError> for TasksError` in
/// `agent/errors.rs`, applied here once instead of once per command.
///
/// The `JoinError` arm is UNTESTABLE for the reason `spaces.rs` states: the
/// closure is pure against an `Arc<Db>` and owned arguments, so it panics only
/// on a genuine mutex poison. It is stated, not implied, and mapped rather than
/// left to a silent `unwrap_or`.
/// Generic over `E` (the join error) rather than naming it: `spawn_blocking`
/// hands back a `tauri::Error`, and `tauri::async_runtime` re-exports the tokio
/// handle types but NOT that error, so naming the concrete type here would mean
/// importing it past the module the file's own dialect says to speak. `Display`
/// is the only thing the arm needs.
fn board_call<T, E: std::fmt::Display>(
    joined: Result<Result<T, crate::storage::BoardError>, E>,
) -> Result<T, TasksError> {
    match joined {
        Ok(inner) => inner.map_err(TasksError::from),
        Err(join) => Err(TasksError::Other(join.to_string())),
    }
}

/// Which linked Session a `compact` boost should target.
///
/// The link made in the stage the card is LEAVING wins: `task_sessions.stage_slug`
/// exists precisely so "the stage it was in when linked" is what a later drag
/// compacts from (spec §2). With no such link, the NEWEST link is the honest
/// fallback (`Db::task_sessions` reads oldest-first, so `.last()` is newest).
/// `None` — no link at all — is what surfaces [`NO_LIVE_SESSION`].
///
/// A pure function over the rows, so the selection rule is testable without a
/// `SessionManager` and without a live Session.
fn pick_compact_target<'a>(
    from_stage: Option<&str>,
    links: &'a [TaskSessionRow],
) -> Option<&'a TaskSessionRow> {
    from_stage
        .and_then(|from| {
            links
                .iter()
                .rev()
                .find(|link| link.stage_slug.as_deref() == Some(from))
        })
        .or_else(|| links.last())
}

/// The handoff instruction text spec §5 suggests, with both stage names in it.
///
/// `None` from `from_stage` is the no-matching-link case, and the sentence says
/// "the previous stage" rather than inventing a name — the text is user-visible
/// in the transcript once the compaction runs.
fn handoff_instructions(from_stage: Option<&str>, to_stage: &str) -> String {
    format!(
        "Summarise the work completed while in stage **{from}**, for handoff into \
         **{to}**: decisions reached, files touched, and what remains.",
        from = from_stage.unwrap_or("the previous stage"),
        to = to_stage,
    )
}

/// The board for one Space: the five default stages seed lazily on this read
/// (spec §2), so opening a board is what creates a Space's columns.
#[tauri::command]
pub async fn get_board(
    state: State<'_, Arc<Db>>,
    space_path: String,
) -> Result<Vec<StageWithTasks>, TasksError> {
    let db = state.inner().clone();
    board_call(tauri::async_runtime::spawn_blocking(move || db.get_board(&space_path)).await)
}

/// Create a card. `title` goes through [`require_title`] FIRST, so a title that
/// cleans to nothing is a rejection (`empty_title`) and NO row is written.
///
/// `stageSlug: None` lands the card in the Space's first stage; `number` is
/// handed out per-Space, 1-based, never reused (ADR 0090).
#[tauri::command]
pub async fn create_task(
    state: State<'_, Arc<Db>>,
    space_path: String,
    title: String,
    body: Option<String>,
    stage_slug: Option<String>,
) -> Result<TaskRow, TasksError> {
    // BEFORE the blocking hop, and NOT inside `Db`: the title rule is a wire rule
    // (the session namer's own), and `storage/db.rs` has no business importing the
    // agent layer to enforce it. Returning early here is also what makes the
    // rejection write nothing — the card is not created and then renamed, it is
    // never created.
    let title = require_title(&title)?;
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || {
            db.create_task(&space_path, &title, body.as_deref(), stage_slug.as_deref())
        })
        .await,
    )
}

/// One card by its GLOBAL id (`tsk_<uuid>`). `Ok(None)` when it is not there —
/// the `find_space` shape: asking for a deleted card is an answer, not an error.
#[tauri::command]
pub async fn get_task(
    state: State<'_, Arc<Db>>,
    task_id: String,
) -> Result<Option<TaskRow>, TasksError> {
    let db = state.inner().clone();
    board_call(tauri::async_runtime::spawn_blocking(move || db.get_task(&task_id)).await)
}

/// Patch a card's text. `None` keeps the stored value; the stage, the number and
/// the position are not this verb's to write — the stage is [`move_task`], the
/// position is [`reorder_tasks`] (spec §3's two drag verbs), and the number is
/// never written at all (ADR 0090).
#[tauri::command]
pub async fn edit_task(
    state: State<'_, Arc<Db>>,
    task_id: String,
    title: Option<String>,
    body: Option<String>,
    spec_path: Option<String>,
) -> Result<TaskRow, TasksError> {
    // A title patch goes through the same cleaner a create does. An ABSENT title
    // is "do not change it" and never reaches the cleaner — otherwise omitting
    // the field would be the same as blanking it.
    let title = match title.as_deref() {
        Some(raw) => Some(require_title(raw)?),
        None => None,
    };
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || {
            db.edit_task(
                &task_id,
                title.as_deref(),
                body.as_deref(),
                spec_path.as_deref(),
            )
        })
        .await,
    )
}

/// Move a card to another column, then run that column's `on_enter`.
///
/// The write happens first and alone (one lock, one read of the destination —
/// `Db::move_task`); the boost is this layer's job because the boost needs the
/// `SessionManager`, which storage cannot name.
#[tauri::command]
pub async fn move_task(
    state: State<'_, Arc<Db>>,
    sm: State<'_, Arc<SessionManager>>,
    space_path: String,
    task_id: String,
    to_stage: String,
) -> Result<MoveTaskOutcome, TasksError> {
    let db = state.inner().clone();
    // The FROM stage must be read BEFORE the write erases it, and the links with
    // it — that pair is what `pick_compact_target` chooses against. It is a
    // separate lock from the move's, and that is fine: the numbering invariant
    // in `Db::create_task` is the one ADR 0090 cares about, and a read that only
    // feeds a note cannot corrupt it.
    let (from_stage, links): (Option<String>, Vec<TaskSessionRow>) = {
        let db_read = db.clone();
        let task_id_read = task_id.clone();
        board_call(
            tauri::async_runtime::spawn_blocking(move || {
                let from_stage = db_read.get_task(&task_id_read)?.map(|task| task.stage_slug);
                let links = db_read.task_sessions(&task_id_read)?;
                Ok::<_, crate::storage::BoardError>((from_stage, links))
            })
            .await,
        )?
    };
    let outcome = {
        let db_move = db;
        let space_move = space_path;
        let task_move = task_id;
        // Cloned, not moved: `to_stage` is read again below for the handoff
        // sentence, and the sentence must name the stage the card actually
        // landed in — the same string, validated by the write.
        let stage_move = to_stage.clone();
        board_call(
            tauri::async_runtime::spawn_blocking(move || {
                db_move.move_task(&space_move, &task_move, &stage_move)
            })
            .await,
        )?
    };

    // The destination slug for the handoff sentence is the one the CALLER
    // supplied: `move_task` validated it against this Space's `stages` rows
    // before writing, so naming it is naming a stage that exists. A slug is what
    // a stage is addressed by below this layer, so the text is accurate whether
    // or not the row's `label` differs from it.
    let boost_note = if outcome.on_enter == "compact" {
        compact_linked_session(&sm, from_stage.as_deref(), &to_stage, &links).await
    } else {
        None
    };
    Ok(MoveTaskOutcome {
        on_enter: outcome.on_enter,
        boost_note,
    })
}

/// Deliver (or decline to deliver) a `compact` stage's boost.
///
/// Returns the NOTE to surface, `None` when a compaction was requested. Never an
/// `Err`: the card moved, and a failure to boost is a fact about the boost.
async fn compact_linked_session(
    sm: &Arc<SessionManager>,
    from_stage: Option<&str>,
    to_stage: &str,
    links: &[TaskSessionRow],
) -> Option<String> {
    let chosen = pick_compact_target(from_stage, links)?;
    let instructions = handoff_instructions(from_stage, to_stage);
    match sm
        .compact_session(&chosen.session_id, Some(instructions))
        .await
    {
        // `Ok(true)` means the frame was SENT, not that a summary exists — spec
        // §5's caveat 1. The outcome rides `compaction_start` / `compaction_end`,
        // so this command never reports a summary it does not have.
        Ok(true) => None,
        Ok(false) => Some(NO_LIVE_SESSION.to_string()),
        Err(e) => Some(e.to_string()),
    }
}

/// Rewrite the within-column order of one Space's cards, in one pass.
///
/// THE OTHER DRAG VERB (spec §3): `move_task` is the CROSS-column drag (writes
/// `stage_slug`, runs `on_enter`), this is the WITHIN-column drag (writes
/// `sort_order` and nothing else). `task_ids` is the column's whole visible slice
/// in its new order and the slice index becomes each card's stored position — so
/// this layer must NOT sort, dedupe or otherwise tidy the list; the order it is
/// handed IS the order that lands.
///
/// `stage_slug` scopes the write: a card that is not in that column of that Space
/// is refused by name (`not_found`) rather than silently repositioned, because
/// `tasks.id` is a global key and a caller CAN hand back a card from another
/// column or another Space (ADR 0090 — no foreign key, by design).
///
/// Not mirrored by any harness tool, deliberately: within a column, position is
/// not evidence (ADR 0075), so the model has no reason to see it. That is an
/// absence of TOOL surface, not of persistence.
#[tauri::command]
pub async fn reorder_tasks(
    state: State<'_, Arc<Db>>,
    space_path: String,
    stage_slug: String,
    task_ids: Vec<String>,
) -> Result<(), TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || {
            db.reorder_tasks(&space_path, &stage_slug, &task_ids)
        })
        .await,
    )
}

/// Link a Session to a card. `stageSlug: None` records the card's CURRENT stage.
///
/// Storage does an `INSERT OR IGNORE`, so the FIRST link wins: the stage it
/// recorded is the stage a later `compact` moves from, and overwriting it would
/// silently re-point the handoff.
#[tauri::command]
pub async fn link_session(
    state: State<'_, Arc<Db>>,
    task_id: String,
    session_id: String,
    stage_slug: Option<String>,
) -> Result<(), TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || {
            db.link_session(&task_id, &session_id, stage_slug.as_deref())
        })
        .await,
    )
}

// ── A4 — start a Task's Session (spec §3, the board's New-Task flow) ─────────

/// Write the `task_sessions` link row for a Session that has just been started.
///
/// `stage_slug: None` → the Task's CURRENT stage (the stage it was in when
/// linked — which is what a later drag into a `compact` column compacts FROM,
/// spec §2's reason the join carries a stage at all).
///
/// The `get_task` gate is NOT redundant with `Db::link_session`'s own refusal,
/// and that is worth stating because it looks redundant: `link_session` resolves
/// a `None` stage by reading the Task's row and errors only when BOTH the row and
/// the explicit stage are missing. Hand it an EXPLICIT stage for a Task that does
/// not exist and it inserts happily — `task_sessions.task_id` carries NO foreign
/// key (ADR 0090: the board must survive a tab close, so nothing here cascades),
/// so SQLite will not catch a dangling Task id. A missing Task is therefore a
/// deterministic error HERE, at the seam that knows the difference.
///
/// A Task's Session context is deliberately NOT seeded into
/// `StartEnv.system_prompt` (spec §3, SPEC FIX 2: a seed REPLACES the Worker's
/// main prompt and drops `<tools>`, the skills list, `cwd` and `AGENTS.md`); the
/// context arrives as the first USER message, `expandMentions`-style, and that is
/// the modal's job (A5), not this command's. Nor does this layer touch titles —
/// the naming pass owns those.
pub(crate) fn write_task_session_link(
    db: &Db,
    task_id: &str,
    session_id: &str,
    stage_slug: Option<&str>,
) -> Result<(), SessionError> {
    if db
        .get_task(task_id)
        .map_err(|e| SessionError::Io(format!("task read {task_id}: {e}")))?
        .is_none()
    {
        // `Command` rather than a new variant: the Session is ALREADY live and
        // already an ordinary sidebar row by the time this can fire, so the
        // honest sentence is about the link, and the caller can retry it.
        return Err(SessionError::Command {
            error: format!("task {task_id} not found"),
        });
    }
    db.link_session(task_id, session_id, stage_slug)
        .map_err(|e| SessionError::Io(format!("task link {task_id} → {session_id}: {e}")))
}

/// The command's testable core (the `save_settings_and_push` precedent at
/// `commands/settings.rs:62`: `tauri::State` cannot be constructed in a unit
/// test, so the body takes the pieces).
///
/// Create-then-link, and the link is the ONLY addition over what the plain
/// `start_session` command does — the start is the SAME
/// `SessionManager::start_session`, whose signature is untouched and whose chain
/// passes `system_prompt: None` so the Worker builds the real main prompt at seq
/// 0. The `?` on the start aborts BEFORE any link is attempted, so a failed
/// start leaves no stray row (pinned by `a_failed_start_writes_no_link_row`).
///
/// The sync `Db` write goes on `spawn_blocking` — the file rule from
/// `commands/files/mod.rs`, restated in `spaces.rs` and in this file's header:
/// SQLite work never runs on the async executor's thread.
pub(crate) async fn start_task_session_inner(
    manager: &SessionManager,
    db: Arc<Db>,
    sink: &Arc<dyn EventSink>,
    cwd: PathBuf,
    task_id: String,
    stage_slug: Option<String>,
) -> Result<SessionInfo, SessionError> {
    let info = manager.start_session(cwd, sink).await?;
    let session_id = info.session_id.clone();
    let link = tauri::async_runtime::spawn_blocking(move || {
        write_task_session_link(&db, &task_id, &session_id, stage_slug.as_deref())
    })
    .await;
    // Two layers, two meanings: the JOIN failing is a bug in this file (the
    // closure is pure against owned arguments and one `Arc<Db>`), the inner
    // `Err` is the database or the missing Task. Both map into `SessionError`;
    // neither is swallowed.
    match link {
        Ok(inner) => inner,
        Err(join) => Err(SessionError::Io(format!(
            "task-link write thread failed: {join}"
        ))),
    }?;
    Ok(info)
}

/// Start a real Session for a Task card, and record the `task_sessions` link.
///
/// The Session is ORDINARY: an ordinary `sessions` row with `is_subagent = 0`,
/// nothing hidden, nothing newly flagged — it appears in the sidebar exactly like
/// a Session started from the `+` button, which is the point (spec §3: "a card on
/// the board AND a row in the sidebar's Sessions list. Nothing is lost to a
/// dismissed dialog").
///
/// `stage_slug: None` records the Task's CURRENT stage. The return value is the
/// started Session's `SessionInfo`, so the frontend can drive it immediately
/// (`sendPrompt`, then the task-context first message A5 composes).
#[tauri::command]
pub async fn start_task_session(
    sink: State<'_, Arc<dyn EventSink>>,
    state: State<'_, Arc<SessionManager>>,
    db: State<'_, Arc<Db>>,
    cwd: String,
    task_id: String,
    stage_slug: Option<String>,
) -> Result<SessionInfo, SessionError> {
    let result = start_task_session_inner(
        state.inner(),
        db.inner().clone(),
        sink.inner(),
        PathBuf::from(cwd),
        task_id,
        stage_slug,
    )
    .await;
    if let Err(e) = &result {
        // The same sentence the command returns, at the same log the session
        // commands use, and the command NAME is the part a support log is
        // grepped by. `commands/sessions.rs`'s `logged` / `logged_line` helpers
        // are PRIVATE to that module and this task must not widen them (that
        // file stays byte-identical), so the line is inlined here — one
        // statement, no shared helper, no second flag to drift: `debuglog::log`
        // owns the enablement check.
        debuglog::log(&format!("ipc start_task_session FAILED: {e}"));
    }
    result
}

#[cfg(test)]
mod tests;
