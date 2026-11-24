//! Tauri commands for session history: list, load, archive, delete.
//!
//! History is owned by the client (this app): the frontend calls
//! `list_sessions` on boot to populate the session list, `load_history`
//! when a stored session is opened (or paged on scroll-up, ADR 0073),
//! `set_session_archived` to archive / unarchive a session (ADR 0016),
//! `delete_session` to remove a session (and, via `ON DELETE CASCADE`, its
//! messages), `session_recency` for recency as a FIELD now that list position
//! is not evidence (ADR 0075), and `reorder_sessions` when a drag rewrites the
//! manual order of one Space's visible slice.
//!
//! Both archive and delete are also the retention TRIGGERS: each drains the batch
//! buffer and then prunes the transcripts of the Session's closed Subagent children
//! (one row survives per child, the child's `sessions` row always survives).
//! `set_session_archived` does it on the way IN only, and NOT at all for a LIVE
//! Session — ADR 0016's 2026-10-20 amendment lets a live row be archived directly,
//! and pruning a mid-turn child would trim its transcript out from under it and
//! resurrect the rest out of order.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent::errors::HistoryError;
use crate::agent::worker::manager::WorkerManager;
use crate::agent::{SessionError, SessionInfo, SessionManager};
use crate::storage::{BatchingPersistence, Db, DbError, MessageRow, SessionRecency};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub rows: Vec<MessageRow>,
    pub has_more: bool,
    /// Task 2 fills this; Task 1 always `None`.
    pub todos: Option<serde_json::Value>,
}

/// All stored sessions, in the user's MANUAL ORDER (see `Db::list_sessions`),
/// as `SessionInfo` (camelCase over IPC). Position says nothing about recency
/// (ADR 0075, `docs/decisions/0075-list-position-is-not-evidence.md`).
///
/// `include_archived` (ADR 0016, `Option` → the frontend may omit the
/// argument): `false` (the default) hides archived sessions; `true`
/// returns them with the `archived` flag set (the frontend splits the
/// boot list client-side).
///
/// Each row carries `config_options` synthesized from the stored
/// `model` / `thinkingLevel` (the same resolution as the resume — the
/// frontend's `SessionConfigSelect` renders them in the stored session's
/// composer, disabled) and `context_usage` read from the row's
/// `context_usage_json` (the last known usage — the frontend's store
/// drops it on close, so the row is the source of truth for the stored
/// session's context bar). Delegates to `SessionManager::list_sessions`
/// (the manager's `effective_catalog` — the user's providers, not the
/// test-only static catalog).
#[tauri::command]
pub async fn list_sessions(
    state: State<'_, Arc<SessionManager>>,
    include_archived: Option<bool>,
) -> Result<Vec<SessionInfo>, SessionError> {
    // Zero-cost direct return: the manager already answers with `SessionError`,
    // so this command carries its own family's wire error and needs no mapping
    // and no wrapper type. The error type is chosen by the WIRE, not by the
    // file: the five `DbError`-backed commands below return `HistoryError`
    // because their wire is the history surface (ADR 0063, Finding 20).
    state.list_sessions(include_archived.unwrap_or(false)).await
}

/// A stored session's transcript page, in insertion order (ADR 0073).
///
/// Bounded by `limit` (newest rows first) and `before_id` (cursor for
/// paging older rows). When omitted, returns all rows up to `before_id`
/// with `has_more = false`.
pub(crate) fn history_page(
    db: &Db,
    session_id: &str,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<HistoryPage, DbError> {
    let (rows, has_more) = db.messages_page(session_id, before_id, limit)?;
    let todos = if before_id.is_none() {
        db.session_todos(session_id)?
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    } else {
        None
    };
    Ok(HistoryPage {
        rows,
        has_more,
        todos,
    })
}

/// Crosses the `spawn_blocking` join for the history reads (#155).
///
/// Two arms, and they mean different things: `Ok(Err(DbError))` is the database
/// refusing, and each `DbError` variant keeps its OWN `HistoryError` kind through
/// `From` — "SQLite refused" and "the disk failed" stay two answers on the wire
/// (ADR 0063, Finding 20). `Err(join)` is the blocking closure DIED, which before
/// this task was not reachable at all because the read ran inline on the async
/// worker.
///
/// The join lands on `HistoryError::Io`, the variant
/// `commands/files/mod.rs::read_file_bytes` maps its own `JoinError` to for the
/// same reason: `HistoryError` has no catch-all arm and adding one would widen
/// the wire vocabulary for a case the frontend cannot act on differently from an
/// i/o failure. The sentence is the join's own (`Display`), so a panic inside the
/// read is legible in the log rather than flattened to a bare kind.
///
/// Generic over `E` (the join error) rather than naming it, exactly as
/// `commands/tasks.rs::board_call` is: `spawn_blocking` hands back a
/// `tauri::Error`, and `tauri::async_runtime` re-exports the handle types but NOT
/// that error, so naming the concrete type would mean importing it past the
/// dialect this file speaks. `Display` is all the arm needs.
fn history_call<T, E: std::fmt::Display>(
    joined: Result<Result<T, DbError>, E>,
) -> Result<T, HistoryError> {
    match joined {
        Ok(inner) => inner.map_err(HistoryError::from),
        Err(join) => Err(HistoryError::Io(join.to_string())),
    }
}

/// [`load_history`]'s testable core (#155 Task 4) — the `save_settings_and_push`
/// / `write_artifact_core` shape, for the reason those record: `tauri::State` has
/// no public constructor, so the command wrapper cannot be called from a unit
/// test (`commands/settings.rs`, `commands/agents.rs`, `commands/tasks.rs`).
///
/// The body is the one the command ran inline before: [`history_page`] against
/// the same `Db`, the same arguments, the same order. What changes is WHERE it
/// runs. `db.messages_page` and `db.session_todos` take the `StdMutex<Connection>`
/// the per-token writer holds, and calling them inline blocked a **tokio worker**
/// on that mutex — head-of-line blocking on the same lock the transcript writer
/// is on, so a boot-time history read could stall an unrelated async task for the
/// length of the query. `Arc<Db>` is `Send + Sync` (`Db { conn: StdMutex<Connection> }`,
/// `Connection: Send`, the `Mutex` supplying `Sync`), so the read moves whole onto
/// a worker thread and the async worker only awaits the join.
///
/// No lock is held across the `.await` (the guard is function-local inside each
/// `Db` method), which is what makes the crossing safe at all.
pub(crate) async fn load_history_core(
    db: Arc<Db>,
    session_id: String,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<HistoryPage, HistoryError> {
    // The house precedent (`commands/spaces.rs::space_for_path`, stated as the
    // rule at `commands/files/mod.rs`): `tauri::async_runtime::spawn_blocking`,
    // NOT `tokio::task::spawn_blocking` — both compile, one file speaking two
    // dialects does not.
    history_call(
        tauri::async_runtime::spawn_blocking(move || {
            history_page(&db, &session_id, limit, before_id)
        })
        .await,
    )
}

#[tauri::command]
pub async fn load_history(
    state: State<'_, Arc<Db>>,
    session_id: String,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<HistoryPage, HistoryError> {
    // A thin unwrap + delegate: everything the wire answers is decided by
    // `load_history_core`, which the in-file tests call directly.
    load_history_core(state.inner().clone(), session_id, limit, before_id).await
}

/// Archive (or unarchive) a stored session (ADR 0016), and on the way IN prune
/// the transcripts of its closed Subagent children.
///
/// `is_live` is the CALLER's answer to "is this Session running right now?" — see
/// [`set_session_archived_core`]. A live Session prunes NOTHING.
#[tauri::command]
pub async fn set_session_archived(
    state: State<'_, Arc<Db>>,
    batched: State<'_, Arc<BatchingPersistence>>,
    // The crate's `test_*`-named accessor, deliberately NOT `#[cfg(test)]`-gated
    // for exactly this kind of consumer. It is the only public per-session
    // liveness predicate that needs no edit inside `agent/session/`: `SessionState`'s
    // own `live` field is private to that module, and the file that could expose it
    // is frozen. A parent is always a MAIN session, so `workers` — the map this
    // reads — is the right one. `commands/spaces.rs`'s `set_space_trusted` is the
    // in-tree precedent for a command taking this `State`.
    wm: State<'_, Arc<WorkerManager>>,
    session_id: String,
    archived: bool,
) -> Result<bool, HistoryError> {
    set_session_archived_core(
        state.inner().as_ref(),
        batched.inner().as_ref(),
        &session_id,
        archived,
        wm.test_is_attached(&session_id),
    )
    .map_err(HistoryError::from)
}

/// The archive trigger's testable core (the `history_page` / `load_history_core`
/// shape — `tauri::State` has no public constructor, so a wrapper is unreachable
/// from a unit test and the decision has to live where a test can reach it).
///
/// ORDER, and the guard, are the whole of this function's content:
///
///   1. the flag — the wire's promise, and the only step whose failure is returned;
///   2. drain the batch buffer, but ONLY if the prune is going to run;
///   3. prune this Session's children.
///
/// Steps 2 and 3 run only when `archived` is `true` AND the flag update matched a
/// row AND `!is_live`. Unarchiving prunes nothing (the prune is a way IN to
/// Archived, not a property of being archived), an unknown id prunes nothing, and
/// a LIVE Session prunes nothing — and when the prune is skipped the flush is
/// skipped too, because the flush exists only to make the prune safe. A live-parent
/// archive therefore touches no transcript at all, exactly as it did before this
/// trigger existed. That guard is load-bearing and not defensive: the sidebar offers
/// Archive on a live row and the frontend commits the flag BEFORE it closes the
/// Session (ADR 0016's 2026-10-20 amendment — "a live row offers Stop then
/// Archive"), while `Db::set_session_archived` is an id-only `UPDATE` with no
/// liveness condition, correct for the flag and useless as a guard. Prune a
/// mid-turn child and you flush its in-flight rows, delete all but the newest, and
/// then the still-emitting child re-INSERTs the rest at LARGER rowids at the END of
/// a transcript that reads `ORDER BY id` — a mis-ordered transcript, which is a
/// correctness defect the user caused by one click.
///
/// The flush comes BEFORE the prune, and not the other way round: the buffer holds
/// the newest rows of a transcript the prune is about to trim, so pruning first
/// deletes nothing and the later flush resurrects every row at a larger rowid.
/// `flush()` (the whole buffer) and NOT `flush_session(session_id)`, because the
/// buffer is keyed by session id and a Subagent's rows sit under the CHILD's own
/// id — the trigger holds the PARENT's, so a per-session flush would drain nothing
/// for the children while looking like it did.
///
/// A failed flush and a failed prune are both LOGGED AND SWALLOWED, exactly as
/// `lib.rs`'s `flush_batched` and the session layer's per-session flush treat a
/// failed flush ("a dropped batch must be loud in the debug log"). Returning `Err`
/// for either would tell a user their archive failed when the archive landed — the
/// asymmetry ADR 0016's amendment argues about ("the close is best-effort; the flag
/// is not"). The bytes are not lost either way: the age-bound sweep reaches the same
/// rows later.
///
/// The flush also may NOT happen inside a transaction: it writes through the same
/// `Db` whose connection this function's other steps hold, so flushing while a
/// transaction were open would deadlock. Hence three separate autocommit calls.
pub(crate) fn set_session_archived_core(
    db: &Db,
    batched: &BatchingPersistence,
    session_id: &str,
    archived: bool,
    is_live: bool,
) -> Result<bool, DbError> {
    let matched = db.set_session_archived(session_id, archived)?;
    if archived && matched && !is_live {
        if let Err(e) = batched.flush() {
            crate::agent::debuglog::log(&format!(
                "archive of {session_id}: batching flush FAILED — buffered rows this \
                 interval are lost and the child prune below may resurrect them: {e}"
            ));
        }
        if let Err(e) = db.prune_closed_subagent_transcripts_of_parent(session_id) {
            crate::agent::debuglog::log(&format!(
                "archive of {session_id}: child transcript prune FAILED — the age-bound \
                 sweep reaches these rows later: {e}"
            ));
        }
    }
    Ok(matched)
}

/// Delete a stored session, pruning its closed Subagent children FIRST.
#[tauri::command]
pub async fn delete_session(
    state: State<'_, Arc<Db>>,
    batched: State<'_, Arc<BatchingPersistence>>,
    session_id: String,
) -> Result<(), HistoryError> {
    delete_session_core(
        state.inner().as_ref(),
        batched.inner().as_ref(),
        &session_id,
    )
    .map_err(HistoryError::from)
}

/// The delete trigger's testable core. Same drain, same prune, same swallow
/// policy as [`set_session_archived_core`], and no `is_live` guard: delete is
/// confined to STORED sessions (the Archived section, or Settings → Detached), so
/// no live-parent path exists to guard HERE — the asymmetry ADR 0016 draws between
/// the two verbs, and the reason only archive carries the parameter.
///
/// The prune runs BEFORE the parent row is deleted, so the selector executes while
/// the parent still exists. There is no foreign key on `parent_session_id`, so a
/// crash between the prune and the delete cannot strand the children in a state the
/// selector cannot reach — it leaves them untrimmed with a dangling
/// `parent_session_id`, which is a storable, expected state and one the age-bound
/// sweep reaches again within 24 hours. Wrapping both in one transaction is not
/// available: it would have to span the flush, and the flush writes through this
/// same connection.
///
/// Deleting the parent is NOT enough on its own, which is the reason this verb
/// exists at all: `ON DELETE CASCADE` destroys the PARENT's rows — including the
/// ones that name its children — while the children themselves survive. In the
/// measured database 1,325 of 2,643 children are already orphaned exactly that way,
/// their transcripts unreachable by any parent-scoped query.
pub(crate) fn delete_session_core(
    db: &Db,
    batched: &BatchingPersistence,
    session_id: &str,
) -> Result<(), DbError> {
    if let Err(e) = batched.flush() {
        crate::agent::debuglog::log(&format!(
            "delete of {session_id}: batching flush FAILED — buffered rows this \
             interval are lost and the child prune below may resurrect them: {e}"
        ));
    }
    if let Err(e) = db.prune_closed_subagent_transcripts_of_parent(session_id) {
        crate::agent::debuglog::log(&format!(
            "delete of {session_id}: child transcript prune FAILED — the age-bound \
             sweep reaches these rows later: {e}"
        ));
    }
    db.delete_session(session_id)
}

/// Every non-subagent session's recency as an explicit FIELD (ADR 0075).
#[tauri::command]
pub async fn session_recency(
    state: State<'_, Arc<Db>>,
) -> Result<Vec<SessionRecency>, HistoryError> {
    session_recency_rows(&state).map_err(HistoryError::from)
}

pub(crate) fn session_recency_rows(db: &Db) -> Result<Vec<SessionRecency>, DbError> {
    db.session_recency()
}

/// Rewrite the manual order of the given session ids in ONE transaction.
/// Only a drag calls this (ADR 0075); the ids are the visible slice of ONE Space.
#[tauri::command]
pub async fn reorder_sessions(
    state: State<'_, Arc<Db>>,
    ids: Vec<String>,
) -> Result<(), HistoryError> {
    reorder_session_rows(&state, &ids).map_err(HistoryError::from)
}

pub(crate) fn reorder_session_rows(db: &Db, ids: &[String]) -> Result<(), DbError> {
    db.reorder_sessions(ids)
}

#[cfg(test)]
mod tests;
