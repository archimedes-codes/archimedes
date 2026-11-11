//! Tauri commands for the per-Space Task board (spec §2 — ADR 0090).
//!
//! EIGHTEEN commands. Seventeen of them are a `spawn_blocking` delegation to
//! `impl Db` in `storage/db.rs`, in the shape `commands/spaces.rs` sets:
//! `State<'_, Arc<Db>>` first, `state.inner().clone()` into the closure,
//! `Result<_, TasksError>` out. The eighteenth, [`start_task_session`], returns the
//! `SessionError` family instead because it is a Session command wearing board
//! clothing — see its own doc.
//!
//! The seventeen delegations are the seven the board shipped with
//! ([`get_board`], [`create_task`], [`get_task`], [`edit_task`], [`move_task`],
//! [`reorder_tasks`], [`link_session`]) plus the eight issue #179 added: the six
//! Stage verbs ([`create_stage`], [`rename_stage`], [`set_stage_skill`],
//! [`set_stage_next`], [`reorder_stages`], [`delete_stage`]) and the
//! Strict-workflow pair ([`set_board_strict`], [`get_board_strict`]) — plus the
//! two issue #180 artifact commands ([`write_artifact`], [`get_artifact`]), which
//! delegate too but refuse three things BEFORE the storage layer is reached (see
//! the artifact section for why each refusal lives here).
//!
//! Three of the seventeen do NOT go through [`board_call`], and it is not an
//! oversight: [`set_board_strict`] and [`get_board_strict`] write and read the
//! `spaces` table, so their storage layer answers `DbError` rather than
//! `BoardError`, and `board_call` is typed to `BoardError`. They go through
//! [`db_call`], its twin for that family — the same two-layer flattening, mapping
//! every failure to `Other` because `DbError` has no absence cases to preserve.
//! `commands/spaces.rs` maps the same `DbError` by hand for the same reason, and no
//! `From<DbError> for TasksError` is added here. [`write_artifact`] is the third:
//! its body composes command-layer refusals that only exist in the wire family, so
//! it goes through [`wire_call`].
//!
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
use crate::storage::{
    Artifact, ArtifactMeta, Db, StageRow, StageWithTasks, TaskRow, TaskSessionRow,
};

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
/// of matching quotes strips) rather than writing the chain a second time. It
/// reaches here through the two-hop `pub(crate) use` chain in `agent/mod.rs` +
/// `agent/session/mod.rs`, because `mod naming` and `mod session` are both
/// private and stay that way.
///
/// `max_chars` is `None`, so a Task title is NOT capped. The namer's 80-char cut
/// is pi parity on a title a MODEL invented; a card's title is the user's own
/// sentence and `tasks.title` has nowhere to put the overflow — a one-line draft
/// truncated at 80 loses the rest for good, which is exactly what a user hit
/// before this parameter existed (`body` was `NULL` because the draft had no
/// second line to become a body). The cap lives at the CALL SITE, so lifting it
/// for tasks could never lift it for session titles.
///
/// The Ok payload is the CLEANED title and that is what gets stored: the caller
/// writes what this approved, never what it was handed.
fn require_title(raw: &str) -> Result<String, TasksError> {
    crate::agent::clean_title(raw, None).ok_or(TasksError::EmptyTitle)
}

/// Derive a Stage slug from a label (spec §5): lowercase; every run of
/// whitespace and every non-`[a-z0-9-]` character collapses to a single `-`; a
/// label with no slug characters at all derives `""`, which `create_stage`
/// refuses.
///
/// A WIRE rule, so it lives here and not in `storage/db.rs` — the exact reason
/// [`require_title`] is here too: text mangling belongs at the boundary, and the
/// storage layer has no business importing the agent layer (nor a second copy of
/// this chain). The rule is also why `rename_stage` does NOT call this: a rename
/// changes the LABEL only, and the slug is frozen (spec §5), so re-deriving it
/// would move the key that every `tasks.stage_slug` in the column points at.
///
/// Deliberately NOT a `clean_title` reuse: that cleaner collapses whitespace and
/// strips quotes for a title that is displayed raw, whereas a slug must also fold
/// punctuation (`"Deep Dives!"` → `deep-dives`, not `deep dives!`) because it is
/// the string `move_task`'s error and a card's `<task stage="…">` block report.
fn stage_slug_from_label(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                // Uppercase FOLDS to lowercase rather than becoming a separator.
                // Spec §5's first word is "lowercase", and its own example is
                // `"Deep Dives!"` → `deep-dives`: treating `D` as a non-`[a-z0-9-]`
                // character would spell that `eep-ives` and quietly drop the first
                // letter of every capitalised label a user types.
                c.to_ascii_lowercase()
            } else if c.is_ascii_digit() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
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

/// [`board_call`]'s twin for the two commands that speak to the `spaces` table.
///
/// The board's storage layer answers `BoardError`, whose two absence cases must
/// stay distinguishable from a database failure — hence the `From` impl
/// `board_call` applies. The Strict-workflow pair reads and writes
/// `spaces.board_strict`, so its storage layer answers `DbError`: a three-variant
/// type with NO absence cases at all (absence is a `false`/`Ok(false)` there, by
/// `set_space_trusted`'s precedent). Nothing may be flattened INTO `NotFound`
/// because there is nothing to flatten, and no `From<DbError> for TasksError` is
/// added for the same reason `tasks` has none for the rest of the family: a
/// blanket `Database(_)` mapping would be a second error-flattening path in this
/// file, and `commands/spaces.rs` already maps the same `DbError` by hand.
///
/// So every failure of either kind — a `DbError` from SQLite, or the join — is
/// `Other`, and the sentence is the storage layer's. Same generic-over-`E` shape
/// as `board_call` for the same stated reason: `spawn_blocking` hands back a
/// `tauri::Error` that this file's dialect does not name.
fn db_call<T, E: std::fmt::Display>(
    joined: Result<Result<T, crate::storage::DbError>, E>,
) -> Result<T, TasksError> {
    match joined {
        Ok(inner) => inner.map_err(|e| TasksError::Other(e.to_string())),
        Err(join) => Err(TasksError::Other(join.to_string())),
    }
}

/// The third flattener in this file, for the two commands whose body already
/// answers [`TasksError`] rather than a storage family.
///
/// Why a third and not a reuse: the artifact commands' refusals are a MIX — the
/// key grammar and the byte cap are command-layer verdicts that only exist in the
/// wire family, while a missing Task or a bad statement arrives from `BoardError`.
/// So the core composes both into `TasksError` (the type the command returns
/// anyway) and this helper's only job is the outer `JoinError` arm — the same
/// mapping [`board_call`] and [`db_call`] make, for the same stated reason (this
/// file's dialect does not name `tauri::Error`).
///
/// The distinction the other two helpers exist to protect is NOT lost: the core
/// maps its own `BoardError` through `TasksError::from`, which is exactly where
/// `MissingTask` → `NotFound` happens. Nothing is flattened into `Other` that had
/// a kind of its own.
fn wire_call<T, E: std::fmt::Display>(
    joined: Result<Result<T, TasksError>, E>,
) -> Result<T, TasksError> {
    match joined {
        Ok(inner) => inner,
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

/// The board for one Space: the six default stages seed lazily on this read
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

// ── issue #179 — the configurable Stage (spec §4/§4.1/§5, ADRs 0098 + 0099) ──
//
// The board's columns stop being frozen data. Six verbs edit a Stage row, and one
// per-Space flag decides whether the graph those rows describe is advice or a
// rule. All eight take ONLY `Arc<Db>` — none of them starts or compacts a Session,
// so none of them needs `Arc<SessionManager>`, and the file's "two entries need a
// second managed type" note stays true of `move_task` and `start_task_session`
// alone.

/// Add a column to one Space's board.
///
/// The slug is DERIVED HERE, before the blocking hop: label→slug is text mangling
/// and `storage/db.rs` has no business owning a display-string rule (the
/// `require_title` precedent, one file over). The derivation is the whole reason a
/// collision is possible at all, so the storage layer's refusal names the slugs
/// that ARE taken rather than suffixing — a silent `spike-2` is a slug nobody typed
/// (spec §5).
///
/// `skill` is the ADR 0098 launch Skill: the `$name` a Session started from this
/// column loads. `None` (or `null` from the wire) means the column launches
/// nothing, which is the state every pre-#179 column is in.
#[tauri::command]
pub async fn create_stage(
    state: State<'_, Arc<Db>>,
    space_path: String,
    label: String,
    skill: Option<String>,
) -> Result<StageRow, TasksError> {
    let slug = stage_slug_from_label(&label);
    if slug.is_empty() {
        // Refused HERE so the sentence is about the label the user typed rather
        // than about a slug they never saw. Storage refuses an empty slug too — it
        // is the last writer and cannot trust its caller to have mangled text —
        // so this early return is a nicer message, not the only guard.
        return Err(TasksError::Other(
            "cannot create a stage from this label".to_string(),
        ));
    }
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || {
            db.create_stage(&space_path, &slug, &label, skill.as_deref())
        })
        .await,
    )
}

/// Rename a column's LABEL. The slug is FROZEN (spec §5) — see
/// `Db::rename_stage` for why writing the key would orphan every card in it.
#[tauri::command]
pub async fn rename_stage(
    state: State<'_, Arc<Db>>,
    space_path: String,
    slug: String,
    label: String,
) -> Result<StageRow, TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || db.rename_stage(&space_path, &slug, &label))
            .await,
    )
}

/// Set or clear the Skill a Session started from this column loads (ADR 0098).
///
/// `skill: None` clears it to NULL. This is the write that replaces
/// `lib/taskPrompt.ts`'s `TASK_LAUNCH_MODES` switch — the reason that constant was
/// deleted rather than kept as a fallback is ADR 0098's, and in short: two
/// authorities deciding one question, and the database was already winning.
#[tauri::command]
pub async fn set_stage_skill(
    state: State<'_, Arc<Db>>,
    space_path: String,
    slug: String,
    skill: Option<String>,
) -> Result<StageRow, TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || {
            db.set_stage_skill(&space_path, &slug, skill.as_deref())
        })
        .await,
    )
}

/// Set one column's outgoing transitions (ADR 0099). `slugs` is the button-render
/// order and arrives verbatim — this layer does not sort, dedupe or filter it,
/// because a dropped destination is a workflow that shrank; `Db::set_stage_next`
/// refuses an unknown slug or a self-loop by name.
///
/// An EMPTY `slugs` is a meaningful write, not a no-op: it stores `[]`, which means
/// "this column leads nowhere" — distinct from NULL's "unconfigured, unconstrained".
#[tauri::command]
pub async fn set_stage_next(
    state: State<'_, Arc<Db>>,
    space_path: String,
    slug: String,
    slugs: Vec<String>,
) -> Result<StageRow, TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || db.set_stage_next(&space_path, &slug, &slugs))
            .await,
    )
}

/// Rewrite the board's column order in one pass.
///
/// `slugs` is the board's whole visible slice in its new order and the index
/// becomes each column's stored `sort_order`, so this layer must NOT sort, dedupe
/// or tidy it — the order it is handed IS the order that lands. The fourth instance
/// of the verb (`reorder_spaces` / `reorder_sessions` / `reorder_tasks` / this) and
/// it follows `reorder_spaces`: an unknown slug is a silent no-op, because the
/// editor passes every column it shows.
///
/// Writes `sort_order` ONLY. ADR 0099 splits the two questions on purpose —
/// `sort_order` is "where does this render", `next_slugs` is "what may a Task go to
/// next" — and neither is derived from the other, so a drag that reorders columns
/// cannot quietly change which drags are legal.
#[tauri::command]
pub async fn reorder_stages(
    state: State<'_, Arc<Db>>,
    space_path: String,
    slugs: Vec<String>,
) -> Result<(), TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || db.reorder_stages(&space_path, &slugs)).await,
    )
}

/// Delete a column, optionally relocating its cards first.
///
/// `relocate_to` is the parameter that makes the editor's "where do these cards
/// go?" step answerable in one round trip: `None` with cards inside is the
/// refusal (naming the count and the slugs available), `Some(slug)` is the bulk
/// relocation. The relocation is ONE `UPDATE` inside the delete's transaction and
/// NEVER a `move_task` per card — `move_task` reads the destination's `on_enter`
/// and the boost happens in THIS layer, so reusing it here would fire one
/// compaction per card as a side effect of deleting a column (spec §4.1 spells the
/// asymmetry out because reusing the verb reads like good deduplication). That is
/// also why this command returns `()` and not an outcome: there is no
/// `MoveOutcome` to report, by design.
#[tauri::command]
pub async fn delete_stage(
    state: State<'_, Arc<Db>>,
    space_path: String,
    slug: String,
    relocate_to: Option<String>,
) -> Result<(), TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || {
            db.delete_stage(&space_path, &slug, relocate_to.as_deref())
        })
        .await,
    )
}

/// The Strict-workflow opt-in (ADR 0099): does this Space's transition graph BIND
/// its drags, or only describe them?
///
/// Lands in THIS file rather than `commands/spaces.rs` even though it writes the
/// `spaces` table, because it is the board's toggle: it gates `move_task`, it
/// co-terminates with the six Stage commands it configures, and spec §4 spells its
/// signature in the board's command list. Which table a command writes is not what
/// groups commands — what the caller is doing with them is.
///
/// Not `board_call`: the storage call answers `DbError`, not `BoardError`, and
/// `board_call` is typed to the latter. The `Result<bool, DbError>` maps by hand,
/// exactly as `commands/spaces.rs` maps the same `Result` from
/// `set_space_trusted`; no `From<DbError> for TasksError` is added, since `tasks`
/// has no blanket `Database(_)` mapping to lean on and inventing one here would put
/// a second error-flattening path in the file. Whether a row matched is a fact the
/// board does not need (a Space with no row is Strict OFF, and the read says so),
/// so the `bool` is dropped on the way out.
#[tauri::command]
pub async fn set_board_strict(
    state: State<'_, Arc<Db>>,
    space_path: String,
    strict: bool,
) -> Result<(), TasksError> {
    let db = state.inner().clone();
    // The `bool` (did a `spaces` row match?) is dropped on the way out: a Space
    // with no row is Strict OFF, and `get_board_strict` says so, so the board has
    // nothing to do with the distinction. Spec §4's signature is `→ ()`.
    db_call(
        tauri::async_runtime::spawn_blocking(move || db.set_board_strict(&space_path, strict))
            .await,
    )
    .map(|_matched| ())
}

/// Read the Strict-workflow flag back (ADR 0099).
///
/// The write alone would leave the flag invisible: the Stage editor's
/// `Strict workflow` Switch has to be SEEDED from the stored value, and a board
/// header's Strict marker reads the same thing. So the read and the enforcement are
/// one contract — `Db::board_strict` keys `spaces` by `space_key` exactly as
/// `move_task`'s gate does, and both answer `false` for a Space with no `spaces`
/// row. The failure that contract prevents is the interesting one: a Switch showing
/// Strict ON over a board whose drags are all accepted.
///
/// The `bool` crosses the wire as a primitive — no board payload changes shape, so
/// no board reader, optimistic write, or reversion moves.
#[tauri::command]
pub async fn get_board_strict(
    state: State<'_, Arc<Db>>,
    space_path: String,
) -> Result<bool, TasksError> {
    let db = state.inner().clone();
    db_call(tauri::async_runtime::spawn_blocking(move || db.board_strict(&space_path)).await)
}

// ── Task artifacts (issue #180 D1, spec §1/§2, ADR 0100) ────────────────────
//
// TWO commands, and D1 ships them as a HUMAN surface only: nothing here
// advertises a verb to a model. There is no `trait TaskStore`, no `tool_specs()`
// entry, no `execute_tool` arm and no `<artifacts>` launch block — those are D2,
// and the launch block waits for the verbs that make its sentence true (spec,
// "Why `<artifacts>` waits for D2"). D1 is independently useful because a person
// can write and read a Task's documents through these two commands today.
// `commands/tasks/tests/artifacts.rs::d1_ships_no_model_facing_artifact_verb`
// pins the boundary from the source text, so an early D2 leak is a red test.

/// The artifact markdown ceiling: 256 KB (spec §1).
///
/// A CONST ALIAS of [`Db::MAX_ARTIFACT_MARKDOWN_BYTES`], not a second number.
/// Rust cannot `use` an associated const by path, so this spells it as an alias —
/// the VALUE still comes from storage, so editing storage's cap moves this one and
/// a divergent pair is not constructible. There is ONE cap and it lives in storage,
/// because storage is the single path BOTH doors to `task_artifacts` pass through:
/// this command, and D2's `impl TaskStore for Db`, which the `write_artifact` TOOL
/// reaches through. D1 owned the constant HERE and storage checked nothing, so the
/// tool path had no bound at all — and the bound is not decorative: the document
/// crosses a JSONL pipe on the way to the Worker (the Worker has no `Db`; the
/// Supervisor is the sole SQLite writer, ADR 0025), F1's grounding measured that the
/// crate's stdio JSONL readers carry NO line cap (the 1 MiB guard is the daemon
/// socket, a different transport), so an uncapped `TEXT` is an uncapped FRAME, and
/// the alternative to refusing is a truncated spec that reads as a complete one.
///
/// Modelled on `MAX_IMAGE_BYTES` in `agent/session/mod.rs`. It stays spelled
/// `MAX_ARTIFACT_MARKDOWN_BYTES` in this module so this file's tests and every
/// existing reader keep their name.
pub(crate) const MAX_ARTIFACT_MARKDOWN_BYTES: usize = Db::MAX_ARTIFACT_MARKDOWN_BYTES;

/// Validate an artifact key, or refuse it — never clean it.
///
/// The grammar is `[a-z0-9][a-z0-9-]{0,39}`, and the predicate that decides it is
/// [`Db::artifact_key_is_well_formed`] in storage. This function deliberately does
/// NOT re-spell the character classes: two spellings of one grammar is how a rule
/// with two entry points grows two different answers, and entry points are exactly
/// what it now has. What this wrapper owns is the WIRE TYPE — the same refusal as
/// [`TasksError::BadArtifactKey`], naming the key and the grammar.
///
/// LOAD-BEARING, NOT COSMETIC: a key is interpolated into the `<task>` launch block
/// (ADR 0100). Stated honestly: `src/lib/taskPrompt.ts` runs every key through
/// `escapeAttr`, so an ill-formed key is NOT a live injection hole in that block
/// today. What this rule protects is the INVARIANT the ADR states — keys are
/// grammar-shaped — which the tool's door was not holding, so a model could persist
/// `My Spec` that a person could not, and the next surface that interpolates a key
/// WITHOUT escaping inherits the bug from a row this grammar exists to make
/// impossible. That is also why this rule REFUSES where [`require_title`] CLEANS —
/// a mangled key is a different key, and silently renaming a document the caller
/// asked for is the same class of lie as writing a title nobody typed.
pub(crate) fn require_artifact_key(raw: &str) -> Result<String, TasksError> {
    if Db::artifact_key_is_well_formed(raw) {
        // Rejects, never cleans: the caller's spelling comes back UNCHANGED, which
        // `require_artifact_key_validates_the_grammar` pins for every accepted key.
        Ok(raw.to_string())
    } else {
        Err(TasksError::BadArtifactKey(raw.to_string()))
    }
}

/// The byte-cap check, split out so the refusal is testable without `State`.
///
/// Refused and NEVER truncated. A truncation would read as a complete spec —
/// a document that ends mid-sentence carries no signal that it is incomplete,
/// which is the confident-well-formed-lie shape this repo keeps documenting.
///
/// The NUMBER comes from storage (see [`MAX_ARTIFACT_MARKDOWN_BYTES`]); what lives
/// here is the `TasksError` shape, which carries `size`/`max` a second time as
/// envelope keys so a frontend need not parse prose (ADR 0063).
fn require_artifact_size(markdown: &str) -> Result<(), TasksError> {
    if markdown.len() > MAX_ARTIFACT_MARKDOWN_BYTES {
        return Err(TasksError::ArtifactTooLarge {
            size: markdown.len(),
            max: MAX_ARTIFACT_MARKDOWN_BYTES,
        });
    }
    Ok(())
}

/// [`write_artifact`]'s testable core (the `start_task_session_inner` precedent —
/// `tauri::State` cannot be built in a unit test).
///
/// THREE refusals, in this order, and each one writes NOTHING:
///
///  1. the key grammar ([`require_artifact_key`]) — a key outside the ADR 0100
///     grammar, which the launch block escapes today but must not come to depend on;
///  2. the byte cap ([`require_artifact_size`]) — refused, never truncated;
///  3. a missing Task — the gate below.
///
/// ALL THREE are re-checked by `Db::write_artifact`, and that is now the rule's
/// home rather than a courtesy: D2's `impl TaskStore for Db` is a second door to
/// `task_artifacts` — the one the `write_artifact` TOOL reaches through — and it
/// skipped this function entirely, so for a while the model could persist what the
/// human could not. These pre-checks stay because they answer `TasksError` with the
/// friendlier envelope (the `artifact_too_large` `size`/`max` keys) and because a
/// rejection here never spends a connection; `From<BoardError> for TasksError` maps
/// the storage arms onto the SAME variants and sentences, so the two doors are
/// indistinguishable on the wire.
/// `the_storage_artifact_refusals_keep_the_command_envelope_exactly` pins that
/// equivalence, and `tests/fulcrum_seams.rs` pins the storage half.
///
/// The `get_task` gate is NOT redundant with `Db::write_artifact`'s own refusal,
/// and it is worth saying so because it looks redundant: `task_artifacts.task_id`
/// carries NO foreign key (ADR 0100, for ADR 0090's reason — the board must
/// survive a tab close, so nothing here cascades), so SQLite will not catch a
/// dangling Task id. A missing Task is therefore a deterministic error HERE, at the
/// seam that knows the difference, and ALSO one at the storage layer. Both refuse
/// on purpose: this refusal is what a caller sees, the storage one is what makes
/// the hole impossible to reach through any caller that skips this command. That
/// is `write_task_session_link`'s gate and its reasoning, copied.
///
/// Returns [`ArtifactMeta`] — identity, the fresh `updatedAt`, the byte count —
/// and NEVER the markdown: the caller just sent it.
pub(crate) fn write_artifact_core(
    db: &Db,
    task_id: &str,
    key: &str,
    markdown: &str,
) -> Result<ArtifactMeta, TasksError> {
    let key = require_artifact_key(key)?;
    require_artifact_size(markdown)?;
    if db
        .get_task(task_id)
        .map_err(|e| TasksError::Database(format!("task read {task_id}: {e}")))?
        .is_none()
    {
        // Rides the EXISTING `NotFound` kind — `From<BoardError>` already maps a
        // missing Task there, so no new wire string was invented for a case the
        // wire already means.
        return Err(TasksError::NotFound(format!("no task with id {task_id}")));
    }
    db.write_artifact(task_id, &key, markdown)
        .map_err(TasksError::from)
}

/// [`get_artifact`]'s testable core. One delegation, no gate.
///
/// The command deliberately does NOT check `get_task` first: absence is an
/// ANSWER on the read path, not an error, and a missing Task and a missing key are
/// the same reply (`Ok(None)`) — the [`get_task`] command's own shape. Gating here
/// would make the dialog's ordinary question "does this card have a spec?" a
/// failure mode.
///
/// Answers `BoardError` (not the wire family) because it composes NO command-layer
/// refusal — there is nothing here to add to the wire vocabulary — so the command
/// reuses [`board_call`] like the fifteen other delegations do, and no extra
/// flattener is invented for a read that has no opinions.
pub(crate) fn get_artifact_core(
    db: &Db,
    task_id: &str,
    key: &str,
) -> Result<Option<Artifact>, crate::storage::BoardError> {
    db.get_artifact(task_id, key)
}

/// Write (UPSERT) one Task artifact; answers `{ key, updatedAt, bytes }` and
/// NEVER the markdown (the caller has it — spec §2).
///
/// One row per `(task_id, key)`, ever: the second write wins and `createdAt`
/// survives. Refuses (writing NOTHING) a key outside `[a-z0-9][a-z0-9-]{0,39}`
/// (`bad_artifact_key`, naming the key and the grammar), a markdown over 256 KB
/// (`artifact_too_large`, naming the limit AND the size), or a Task that does not
/// exist (`not_found`). See [`write_artifact_core`] for why each refusal is where
/// it is.
///
/// Both artifact commands take ONLY the `Db` — no `SessionManager`, no `EventSink`
/// — because they are pure database writes, unlike [`start_task_session`].
#[tauri::command]
pub async fn write_artifact(
    state: State<'_, Arc<Db>>,
    task_id: String,
    key: String,
    markdown: String,
) -> Result<ArtifactMeta, TasksError> {
    // The two PURE refusals run before this hop, so a rejection never even spends
    // a worker thread — the `create_task` title rule, in the same building. They
    // are re-checked inside [`write_artifact_core`] (cheap, and what makes the core
    // safe for a caller that did not come through here); neither can write, because
    // both run before any statement does.
    let key = require_artifact_key(&key)?;
    require_artifact_size(&markdown)?;
    let db = state.inner().clone();
    wire_call(
        tauri::async_runtime::spawn_blocking(move || {
            write_artifact_core(&db, &task_id, &key, &markdown)
        })
        .await,
    )
}

/// Read one Task artifact; `null` when the artifact OR the Task is absent —
/// asking for something that is not there is an answer, not an error (the
/// [`get_task`] shape).
///
/// This is the ONE place artifact content crosses the wire. The board payload
/// carries `artifactKeys` alone, so a document travels only when a person opens a
/// card and picks a key.
#[tauri::command]
pub async fn get_artifact(
    state: State<'_, Arc<Db>>,
    task_id: String,
    key: String,
) -> Result<Option<Artifact>, TasksError> {
    let db = state.inner().clone();
    board_call(
        tauri::async_runtime::spawn_blocking(move || get_artifact_core(&db, &task_id, &key)).await,
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
