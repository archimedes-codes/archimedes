//! The host-tool executors, run Supervisor-side (ADR 0102 D1).
//!
//! These were `fulcrum-harness` 0.7.0's `tools/exec/task_tools.rs` `exec_*` arms.
//! They move here because their substance is the desktop's SQLite: the Worker has no
//! `Db` and cannot have one (ADR 0025 makes this process the sole SQLite writer), so
//! the answer is computed HERE and shipped back over
//! [`Inbound::HostToolResponse`](fulcrum_harness::worker::protocol::Inbound::HostToolResponse).
//!
//! # The layout of this module
//!
//!   * **this file** — the name-keyed dispatch ([`exec`], entered through [`run`]),
//!     the parameter readers (`req_str` / `opt_str` / `missing`), the shared shaping
//!     (`to_details`, `row_result`) and the blocking-pool wrapper ([`spawn_host_call`]).
//!     Every verb needs all of these and only one of them is a board verb, which is
//!     why they sit above the split rather than inside one half of it;
//!   * [`board`] — the seven board / artifact verb bodies;
//!   * [`session`] — the one verb whose subject is the calling Session rather than a
//!     card, and therefore the one verb that reads [`run`]'s origin identity.
//!
//! # What the move REMOVES, and why that is not a loss
//!
//! 0.7.0's arm had five parts: take the seam handle, validate params, park on the
//! seam racing the turn token, DECODE the answer into a DTO, shape the result. Parts
//! three and four are gone and both disappearances are structural:
//!
//!   * **the park** — an `HostTool` executor in the Worker owns the park, the
//!     oneshot registration order and the turn-token vote now
//!     (`worker/host_tools.rs` there). There is no `TaskCaller` to park on and no
//!     `ctx.cancel` in this process to race.
//!   * **the decode** — 0.7.0's `run_task_call` returned a `serde_json::Value` and
//!     the Worker re-derived the DTO from it, which is where the
//!     `"task response was not a move outcome"` family of failures came from. This
//!     code builds the `ToolResult` directly, so no answer is ever re-decoded and
//!     that whole failure class ceases to exist. It is not moved; it is gone.
//!
//! Parts one, two and five are here, and part five's payloads are a contract:
//! `src/lib/toolDetailsRegistry.test.ts` pins `details.board`, `details.task`,
//! `details.moveOutcome` and `details.artifactMeta` in a frozen 39-key tuple, so the
//! `json!` keys below must stay byte-identical in SHAPE even though the producing
//! file changed. `super::tests::shape` asserts that on decoded VALUES.
//!
//! # THE LOSSY-TWIN RULE — read this before editing any arm
//!
//! Six of the seven board verbs have an INHERENT `Db` method of the same name with a
//! THINNER shape, and Rust prefers inherent methods. So `db.move_task(…)` binds the
//! desktop's own `move_task`, whose [`storage::MoveOutcome`] is `{ on_enter }` ALONE
//! — no `toStage`, no `note` — and `db.get_task(…)` binds the one whose row has no
//! `artifactKeys`. A `TaskDetail` answer needs both.
//!
//! Until this commit, `impl TaskStore for Db` is what FORCED the full shape, and
//! `run_task_call` spelled every arm `<Db as TaskStore>::verb(…)` to reach it. The
//! trait is deleted. NOTHING forces the shape now. So every arm runs the inherent
//! verb and then maps to the wire DTO with a WRITTEN-OUT struct literal, and
//! `super::tests::shape` asserts the three load-bearing keys on the decoded value —
//! never on source text, because a `contains` on a string cannot see a wrong type
//! being serialized. The mutation that test exists to catch is passing the storage
//! shape straight through: it COMPILES, it is desktop-green and CI-green, and every
//! `move_task` answer is missing `toStage`.
//!
//! [`storage::MoveOutcome`]: crate::storage::MoveOutcome

mod board;
mod session;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::agent::tools::ToolResult;
use crate::storage::{Db, HostToolError, TaskRow};

/// Run one host-tool call against the Supervisor's `Db`.
///
/// The body of the `WorkerInboundEvent::HostToolCall` router arm, factored out so it
/// is testable without a live Worker: the arm needs a `WorkerManager` and an attached
/// session to deliver its answer, this needs only a `Db`, a tool NAME and the params
/// the Worker sent.
///
/// `origin` / `is_subagent` sit HERE and not on the individual verbs because a host
/// verb whose subject is the caller takes that subject from the FRAME and never from
/// `params`: `params` is untrusted model JSON and a session id in it is a session id
/// the model chose, while `origin` is the `session_id` the Worker put on the frame and
/// `is_subagent` is the router's own answer to "is this frame's sender a child". The
/// board verbs ignore both, which is precisely why they ride the one entry point every
/// verb passes through rather than being re-decided per arm.
///
/// The `Err` half is a `String` because that is what the frame carries —
/// `Inbound::HostToolResponse` holds a `Result<ToolResult, String>`, since a crate
/// that has no idea what a host tool is cannot name a host tool's failure kind. The
/// crate turns that string into `ToolResult::fail(message, None)`, which is exactly
/// the shape 0.7.0's arms produced for a refusal, so the model reads the same
/// sentence either way. [`HostToolError`]'s `Display` IS that sentence and it is
/// rendered exactly once, here.
///
/// An unknown name is a LOUD failure, never a silent one. The engine only composes
/// entries from `super::host_tool_specs()`, so reaching this arm with a name this
/// function does not handle means the two lists drifted apart — and the honest answer
/// to "advertised and unreachable" is a failure naming itself.
pub(crate) async fn run(
    db: &Arc<Db>,
    origin: Option<&str>,
    is_subagent: bool,
    tool: &str,
    params: Value,
) -> Result<ToolResult, String> {
    exec(db, origin, is_subagent, tool, &params)
        .await
        .map_err(|e| e.to_string())
}

/// The name-keyed dispatch. Kept separate from [`run`] so the sentence-wrapping of
/// the error half lives in exactly one place.
async fn exec(
    db: &Arc<Db>,
    origin: Option<&str>,
    is_subagent: bool,
    tool: &str,
    params: &Value,
) -> Result<ToolResult, HostToolError> {
    match tool {
        "list_board" => board::list_board(db, params).await,
        "get_task" => board::get_task(db, params).await,
        "create_task" => board::create_task(db, params).await,
        "edit_task" => board::edit_task(db, params).await,
        "move_task" => board::move_task(db, params).await,
        "get_artifact" => board::get_artifact(db, params).await,
        "write_artifact" => board::write_artifact(db, params).await,
        // The ONE verb whose subject is the calling Session, so the ONE verb the
        // frame identity is threaded into. The board verbs above take a card id from
        // `params` because a card is not the caller; this one takes no `params` at all
        // because its subject already arrived on the frame.
        "mark_done" => session::mark_done(db, origin, is_subagent).await,
        other => Err(HostToolError::Invalid {
            message: format!("`{other}` is not a host tool this Supervisor implements"),
        }),
    }
}

// ── The shared shaping ───────────────────────────────────────────────────────

/// The shared shaping for the two write verbs' row answer.
pub(super) fn row_result(verb: &str, row: TaskRow) -> Result<ToolResult, HostToolError> {
    Ok(ToolResult::ok_text(
        format!(
            "{verb} #{} [{}] {} — {}",
            row.number, row.space_path, row.id, row.title
        ),
        Some(to_details("task", &row)?),
    ))
}

/// Wrap one payload in the `details` envelope under its pinned key.
///
/// The KEY is the contract: `board` / `task` / `moveOutcome` / `artifactMeta` are
/// four of the 39 names in `toolDetailsRegistry.test.ts`'s frozen producer tuple, and
/// renaming one reddens `pnpm build` (the `AssertEqual` seal) and that file's vacuity
/// guard 4. A `json!` literal at each call site would work equally well; this exists
/// so the serialization failure has one sentence and one owner.
pub(super) fn to_details<T: serde::Serialize>(
    key: &str,
    value: &T,
) -> Result<Value, HostToolError> {
    serde_json::to_value(value)
        .map(|v| json!({ key: v }))
        .map_err(|e| HostToolError::Invalid {
            message: format!("host tool response could not be serialized: {e}"),
        })
}

// ── Parameter reading (0.7.0's `task_tools.rs` helpers, carried over verbatim) ──

/// A missing or wrongly-typed string parameter, naming the KEY (a model that gets
/// `spacePath` back can fix it; one that gets `invalid params` cannot).
fn missing(key: &str) -> HostToolError {
    HostToolError::Invalid {
        message: format!("missing or invalid `{key}` string"),
    }
}

/// Read a REQUIRED string parameter.
pub(super) fn req_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, HostToolError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| missing(key))
}

/// Read an OPTIONAL string parameter. `Ok(None)` covers BOTH "absent" and
/// "explicit `null`" — the two spellings the wire can carry for "no value", which
/// the verbs below treat identically.
///
/// A present-but-wrong-typed value is an ERROR naming the key, not a silent `None`:
/// `body: 42` means the model meant to send something and sent the wrong thing, and
/// quietly dropping it would write a task without the body it was asked for.
pub(super) fn opt_str<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, HostToolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_str().map(Some).ok_or_else(|| missing(key)),
    }
}

// ── The blocking-pool wrapper (moved from `router.rs` with its executors) ──────

/// One board verb, on the blocking pool, with its error mapped.
///
/// Generic over the error the closure returns, and that is not generality for its own
/// sake: it is what lets a future verb whose storage method yields a different
/// desktop error join this one helper through its own `From` impl instead of
/// hand-spelling a `map_err` and drifting from the sentence table.
///
/// Every arm runs the SYNC inherent `Db` method inside `spawn_blocking`. That is not
/// defensive style — `rusqlite` is a blocking driver and `Db`'s methods take the
/// connection mutex, so calling one directly from this `async` fn would hold a tokio
/// worker thread for the duration of a SQLite statement.
///
/// A panicked blocking task, or a runtime shutting down mid-call, becomes an `Io`
/// naming the verb, because the model shows that sentence to the user's Session and
/// "the Supervisor's `move_task` call failed" is the truth.
///
/// And a call that NEVER returns becomes one too, at [`HOST_CALL_TIMEOUT`] —
/// with its own sentence (`timed out`, not `failed`), because "the blocking task
/// died" and "the blocking task was still running after half a minute" are different
/// facts and the model reads both verbatim.
pub(super) async fn spawn_host_call<T, E, F>(verb: &'static str, f: F) -> Result<T, HostToolError>
where
    T: Send + 'static,
    E: Into<HostToolError> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    with_board_deadline(verb, async move {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| HostToolError::Io {
                message: format!("Supervisor `{verb}` host call failed: {e}"),
            })?
            .map_err(Into::into)
    })
    .await
}

/// How long one Supervisor-side board call may run before the Worker is answered
/// with an error. Every layer below this is already bounded or already fast:
/// `busy_timeout` is 5 s, a healthy board read is sub-millisecond, and the verbs
/// take one mutex. So this is the backstop for a WEDGED `Db` — the one thing under
/// this bound that can run forever — and NOT a policy about how long a board read
/// should take. Nor is it how a DELIVERY failure is seen. This future is awaited
/// INSIDE the router arm's `tokio::spawn` (via [`run`] → [`spawn_host_call`]), so it
/// covers exactly two shapes and nothing else: the verb is still running, or the
/// verb finished and something downstream failed. A frame that never reaches its
/// Worker is the second shape — the verb ran fine and fast, so this bound never
/// fires for it and the failure is made VISIBLE by the arm's `diagnostics::record`
/// sites instead. And a task that PANICS, or that never runs at all (a spawn on a
/// shutting-down runtime), never reaches this line either — those two are covered by
/// NEITHER this bound nor a `record` site, and are the residual the docs name.
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Run one board future under [`HOST_CALL_TIMEOUT`], mapping expiry to the `Io`
/// sentence the model reads. Factored out of [`spawn_host_call`] so the deadline is
/// provable with a `pending()` future and a paused clock.
pub(super) async fn with_board_deadline<T, E, F>(
    verb: &'static str,
    f: F,
) -> Result<T, HostToolError>
where
    T: Send + 'static,
    E: Into<HostToolError>,
    F: std::future::Future<Output = Result<T, E>>,
{
    tokio::time::timeout(HOST_CALL_TIMEOUT, f)
        .await
        .map_err(|_| HostToolError::Io {
            message: format!("Supervisor `{verb}` host call timed out after {HOST_CALL_TIMEOUT:?}"),
        })?
        .map_err(Into::into)
}
