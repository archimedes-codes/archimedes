//! The SEVEN board / artifact executors, run Supervisor-side (ADR 0102 D1).
//!
//! These were `fulcrum-harness` 0.7.0's `tools/exec/task_tools.rs` `exec_*` arms.
//! They move here because their substance is the desktop's SQLite: the Worker has no
//! `Db` and cannot have one (ADR 0025 makes this process the sole SQLite writer), so
//! the answer is computed HERE and shipped back over
//! [`Inbound::HostToolResponse`](fulcrum_harness::worker::protocol::Inbound::HostToolResponse).
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
//! Six of the seven verbs have an INHERENT `Db` method of the same name with a
//! THINNER shape, and Rust prefers inherent methods. So `db.move_task(…)` binds the
//! desktop's own `move_task`, whose [`storage::MoveOutcome`] is `{ on_enter }` ALONE
//! — no `toStage`, no `note` — and `db.get_task(…)` binds the one whose row has no
//! `artifactKeys`. A `TaskDetail` answer needs both.
//!
//! Until this commit, `impl TaskStore for Db` is what FORCED the full shape, and
//! `run_task_call` spelled every arm `<Db as TaskStore>::verb(…)` to reach it. The
//! trait is deleted. NOTHING forces the shape now. So every arm below runs the
//! inherent verb and then maps to the wire DTO with a WRITTEN-OUT struct literal, and
//! `super::tests::shape` asserts the three load-bearing keys on the decoded value —
//! never on source text, because a `contains` on a string cannot see a wrong type
//! being serialized. The mutation that test exists to catch is passing the storage
//! shape straight through: it COMPILES, it is desktop-green and CI-green, and every
//! `move_task` answer is missing `toStage`.
//!
//! [`storage::MoveOutcome`]: crate::storage::MoveOutcome

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::agent::tools::ToolResult;
use crate::storage::{
    BoardError, BoardRow, Db, HostToolError, MoveToolOutcome, TaskDetail, TaskRow,
};

/// Run one board/artifact host-tool call against the Supervisor's `Db`.
///
/// The body of the `WorkerInboundEvent::HostToolCall` router arm, factored out so it
/// is testable without a live Worker: the arm needs a `WorkerManager` and an attached
/// session to deliver its answer, this needs only a `Db`, a tool NAME and the params
/// the Worker sent.
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
pub(crate) async fn run(db: &Arc<Db>, tool: &str, params: Value) -> Result<ToolResult, String> {
    exec(db, tool, &params).await.map_err(|e| e.to_string())
}

/// The name-keyed dispatch. Kept separate from [`run`] so the sentence-wrapping of
/// the error half lives in exactly one place.
async fn exec(db: &Arc<Db>, tool: &str, params: &Value) -> Result<ToolResult, HostToolError> {
    match tool {
        "list_board" => list_board(db, params).await,
        "get_task" => get_task(db, params).await,
        "create_task" => create_task(db, params).await,
        "edit_task" => edit_task(db, params).await,
        "move_task" => move_task(db, params).await,
        "get_artifact" => get_artifact(db, params).await,
        "write_artifact" => write_artifact(db, params).await,
        other => Err(HostToolError::Invalid {
            message: format!("`{other}` is not a host tool this Supervisor implements"),
        }),
    }
}

// ── The seven verbs ──────────────────────────────────────────────────────────

/// `list_board` — one line per card, plus the rows in `details` for the UI.
///
/// `params`: `{ space_path: String }`.
///
/// There is NO inherent `Db::list_board` — the desktop's flat board read is
/// `list_tasks` — so this arm is the one that has to ADD the artifact keys itself,
/// one extra statement per card. The aggregate `artifact_keys_for_space` exists for
/// the board's OWN read (`get_board`) and is deliberately not used here: the trait
/// returned rows already filtered by the caller's verb, and re-deriving that filter
/// here would make a second owner of "which cards belong to this Space".
async fn list_board(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let space_path = req_str(params, "space_path")?;
    let db = db.clone();
    let space_path = space_path.to_string();
    // THE MAPPING, spelled out. `list_tasks` yields `TaskRow` (no `artifact_keys`,
    // `number: i64`); the answer needs `BoardRow` (`artifact_keys` REQUIRED,
    // `number: u32`). Returning `list_tasks`' rows directly compiles and ships a
    // board with no `artifactKeys`.
    let rows = spawn_board("list_board", move || {
        let cards = Db::list_tasks(&db, &space_path)?;
        cards
            .into_iter()
            .map(|row| {
                let id = row.id.clone();
                Ok(BoardRow {
                    id: row.id,
                    space_path: row.space_path,
                    // `number` is `MAX(number) + 1` per Space (ADR 0090), so it is
                    // positive and small by construction: a widening-free
                    // narrowing of a value this process handed out.
                    number: row.number as u32,
                    title: row.title,
                    body: row.body,
                    spec_path: row.spec_path,
                    stage_slug: row.stage_slug,
                    sort_order: row.sort_order,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    artifact_keys: Db::artifact_keys(&db, &id)?,
                })
            })
            .collect::<Result<Vec<BoardRow>, BoardError>>()
    })
    .await?;

    let details = to_details("board", &rows)?;
    if rows.is_empty() {
        return Ok(ToolResult::ok_text(
            "the board is empty".to_string(),
            Some(details),
        ));
    }
    Ok(ToolResult::ok_text(
        rows.iter().map(board_line).collect::<Vec<_>>().join("\n"),
        Some(details),
    ))
}

/// `get_task` — one task's full row.
///
/// `params`: `{ task_id: String }`.
async fn get_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let task_id = req_str(params, "task_id")?.to_string();
    let db = db.clone();
    // THE MAPPING, spelled out: `Db::get_task` yields `TaskRow`, the answer needs
    // `TaskDetail` — the same row PLUS the artifact key names the detail dialog
    // shows as chips.
    let read_task_id = task_id.clone();
    let row = spawn_board("get_task", move || {
        Db::get_task(&db, &read_task_id)?
            .map(|row| -> Result<TaskDetail, BoardError> {
                let id = row.id.clone();
                Ok(TaskDetail {
                    id: row.id,
                    space_path: row.space_path,
                    number: row.number as u32,
                    title: row.title,
                    body: row.body,
                    spec_path: row.spec_path,
                    stage_slug: row.stage_slug,
                    sort_order: row.sort_order,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    artifact_keys: Db::artifact_keys(&db, &id)?,
                })
            })
            .transpose()
    })
    .await?;

    match row {
        Some(t) => Ok(ToolResult::ok_text(
            format!(
                "#{} [{}] {} — {}{}\nbody: {}",
                t.number,
                t.stage_slug,
                t.id,
                t.title,
                if t.artifact_keys.is_empty() {
                    String::new()
                } else {
                    format!(" (artifacts: {})", t.artifact_keys.join(", "))
                },
                t.body.as_deref().unwrap_or("(none)"),
            ),
            Some(to_details("task", &t)?),
        )),
        // Asking for what is not there is an ANSWER, not an error: absence is what
        // the storage read returns for a missing row, and an `is_error` result
        // invites the model to retry the same id.
        None => Ok(ToolResult::ok_text(
            format!("no task found for `{task_id}`"),
            None,
        )),
    }
}

/// `create_task` — a new card on a Space's board.
///
/// `params`: `{ space_path, title }` required; `body`, `stage_slug` optional.
async fn create_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let space_path = req_str(params, "space_path")?.to_string();
    let title = req_str(params, "title")?.to_string();
    let body = opt_str(params, "body")?.map(str::to_string);
    let stage_slug = opt_str(params, "stage_slug")?.map(str::to_string);
    let db = db.clone();
    // The write answer is the storage `TaskRow` ITSELF — no DTO of its own. A write
    // touched no artifact, so its answer says nothing about them, and the storage
    // row is already exactly that shape field-for-field. This is why the DTO family
    // that moved is three types and not five.
    let row = spawn_board("create_task", move || {
        Db::create_task(
            &db,
            &space_path,
            &title,
            body.as_deref(),
            stage_slug.as_deref(),
        )
    })
    .await?;
    row_result("created", row)
}

/// `edit_task` — change a card's title / body / spec path.
///
/// `params`: `{ task_id }` required; `title`, `body`, `spec_path` optional.
async fn edit_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let task_id = req_str(params, "task_id")?.to_string();
    let title = opt_str(params, "title")?.map(str::to_string);
    let body = opt_str(params, "body")?.map(str::to_string);
    let spec_path = opt_str(params, "spec_path")?.map(str::to_string);
    let db = db.clone();
    // TWO-state, and the third state is still unreachable: an absent or `null` wire
    // key means LEAVE THE FIELD ALONE (`FieldPatch::Keep`), so a model's `edit_task`
    // clears nothing. The wire payload the spec advertises has no spelling for
    // "blank it", and inventing one is a spec change, not a refactor — it is
    // deliberate and deferred (docs/research/edit-task-cannot-clear-a-field.md).
    use crate::storage::FieldPatch;
    let row = spawn_board("edit_task", move || {
        Db::edit_task(
            &db,
            &task_id,
            title.as_deref().map_or(FieldPatch::Keep, FieldPatch::Set),
            body.as_deref().map_or(FieldPatch::Keep, FieldPatch::Set),
            spec_path
                .as_deref()
                .map_or(FieldPatch::Keep, FieldPatch::Set),
        )
    })
    .await?;
    row_result("edited", row)
}

/// `move_task` — move a card to another stage.
///
/// `params`: `{ space_path, task_id, to_stage }`, all required.
///
/// THIS is the arm the lossy-twin rule is about. The inherent `Db::move_task` answers
/// with [`storage::MoveOutcome`], which is `{ on_enter }` — one field. The answer the
/// UI's `details.moveOutcome` and the model's text both need is
/// [`storage::MoveToolOutcome`]: `to_stage` / `on_enter` / `note`. Passing the storage
/// outcome through COMPILES and answers without `toStage`.
async fn move_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let space_path = req_str(params, "space_path")?.to_string();
    let task_id = req_str(params, "task_id")?.to_string();
    let to_stage = req_str(params, "to_stage")?.to_string();
    let db = db.clone();
    let destination = to_stage.clone();
    let outcome = spawn_board(
        "move_task",
        move || -> Result<MoveToolOutcome, BoardError> {
            let out = Db::move_task(&db, &space_path, &task_id, &to_stage)?;
            // THE MAPPING, spelled out. `to_stage` echoes the CALLER's argument: the
            // desktop's `move_task` refuses before it writes, so a successful move
            // always lands where it was told. `on_enter` becomes `Some` of the storage
            // value — it stays OPAQUE, this code never interprets it. `note` is `None`
            // because storage returns no note: the boost warning a note would describe
            // needs the `SessionManager`, which the storage layer cannot name, so it is
            // computed one layer UP in `commands/tasks.rs`'s `boost_note`. Reaching past
            // storage for that fact would put a claim here that storage cannot support.
            Ok(MoveToolOutcome {
                to_stage: destination,
                on_enter: Some(out.on_enter),
                note: None,
            })
        },
    )
    .await?;

    // `on_enter` is deliberately NOT in the model-facing text: it is opaque data for
    // the CALLER's layer (the boost needs the `SessionManager`), and describing it
    // here would be this code claiming to know what it means. It still rides
    // `details` so the reader can act on it.
    let mut text = format!("moved to `{}`", outcome.to_stage);
    if let Some(note) = outcome.note.as_deref() {
        text.push_str(&format!(" — {note}"));
    }
    Ok(ToolResult::ok_text(
        text,
        Some(to_details("moveOutcome", &outcome)?),
    ))
}

/// `get_artifact` — one artifact's full markdown.
///
/// `params`: `{ task_id, key }`, both required.
async fn get_artifact(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let task_id = req_str(params, "task_id")?.to_string();
    let key = req_str(params, "key")?.to_string();
    let db = db.clone();
    // No mapping: the storage `Artifact` was shaped to the crate's DTO on purpose
    // (the five names are identical), so this verb has never translated anything.
    let (read_task_id, read_key) = (task_id.clone(), key.clone());
    let artifact = spawn_board("get_artifact", move || {
        Db::get_artifact(&db, &read_task_id, &read_key)
    })
    .await?;
    match artifact {
        // The markdown IS the content — that is the whole point of the verb. NO
        // `details`: the markdown would then exist TWICE in one result (the
        // transcript row and the UI payload both persist), for a document the model
        // is about to hold in full anyway.
        Some(a) => Ok(ToolResult::ok_text(a.markdown, None)),
        None => Ok(ToolResult::ok_text(
            format!("no artifact `{key}` for task `{task_id}`"),
            None,
        )),
    }
}

/// `write_artifact` — upsert one artifact, answering with its META only.
///
/// `params`: `{ task_id, key, markdown }`, all required.
async fn write_artifact(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let task_id = req_str(params, "task_id")?.to_string();
    let key = req_str(params, "key")?.to_string();
    let markdown = req_str(params, "markdown")?.to_string();
    let db = db.clone();
    // No mapping: the storage `ArtifactMeta` is field-for-field the wire shape.
    let meta = spawn_board("write_artifact", move || {
        Db::write_artifact(&db, &task_id, &key, &markdown)
    })
    .await?;
    // The meta, never the markdown back: the caller just sent it.
    Ok(ToolResult::ok_text(
        format!(
            "wrote artifact `{}` ({} bytes, updatedAt {})",
            meta.key, meta.bytes, meta.updated_at
        ),
        Some(to_details("artifactMeta", &meta)?),
    ))
}

// ── The shared shaping ───────────────────────────────────────────────────────

/// The board row's one-line summary (title, number, stage, artifact KEY names).
/// Never any markdown — the row does not carry any, and this is the sentence that
/// tells the model to go fetch one.
fn board_line(r: &BoardRow) -> String {
    let artifacts = if r.artifact_keys.is_empty() {
        "no artifacts".to_string()
    } else {
        format!("artifacts: {}", r.artifact_keys.join(", "))
    };
    format!(
        "#{} [{}] {} — {} ({})",
        r.number, r.stage_slug, r.id, r.title, artifacts
    )
}

/// The shared shaping for the two write verbs' row answer.
fn row_result(verb: &str, row: TaskRow) -> Result<ToolResult, HostToolError> {
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
fn to_details<T: serde::Serialize>(key: &str, value: &T) -> Result<Value, HostToolError> {
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
fn req_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, HostToolError> {
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
fn opt_str<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, HostToolError> {
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
/// And a call that NEVER returns becomes one too, at [`TASK_BOARD_CALL_TIMEOUT`] —
/// with its own sentence (`timed out`, not `failed`), because "the blocking task
/// died" and "the blocking task was still running after half a minute" are different
/// facts and the model reads both verbatim.
pub(super) async fn spawn_board<T, E, F>(verb: &'static str, f: F) -> Result<T, HostToolError>
where
    T: Send + 'static,
    E: Into<HostToolError> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    with_board_deadline(verb, async move {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| HostToolError::Io {
                message: format!("Supervisor `{verb}` board call failed: {e}"),
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
/// INSIDE the router arm's `tokio::spawn` (via [`run`] → [`spawn_board`]), so it
/// covers exactly two shapes and nothing else: the verb is still running, or the
/// verb finished and something downstream failed. A frame that never reaches its
/// Worker is the second shape — the verb ran fine and fast, so this bound never
/// fires for it and the failure is made VISIBLE by the arm's `diagnostics::record`
/// sites instead. And a task that PANICS, or that never runs at all (a spawn on a
/// shutting-down runtime), never reaches this line either — those two are covered by
/// NEITHER this bound nor a `record` site, and are the residual the docs name.
const TASK_BOARD_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Run one board future under [`TASK_BOARD_CALL_TIMEOUT`], mapping expiry to the `Io`
/// sentence the model reads. Factored out of [`spawn_board`] so the deadline is
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
    tokio::time::timeout(TASK_BOARD_CALL_TIMEOUT, f)
        .await
        .map_err(|_| HostToolError::Io {
            message: format!(
                "Supervisor `{verb}` board call timed out after {TASK_BOARD_CALL_TIMEOUT:?}"
            ),
        })?
        .map_err(Into::into)
}
