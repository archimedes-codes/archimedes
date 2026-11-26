//! The SEVEN board / artifact verbs — the bodies the `exec` dispatch routes to.
//!
//! This file is those seven arms and nothing else: the `list_board` …
//! `write_artifact` bodies, carried over from the single `exec.rs` file VERBATIM so a
//! reviewer sees a pure move. The dispatch, the shared shaping, the parameter
//! readers and the blocking-pool wrapper live in [`super`], because the eight verbs
//! and the two halves of the `details` envelope share them and only one of them is a
//! board verb.
//!
//! # The lossy-twin rule applies to EVERY arm here
//!
//! Six of these seven have an INHERENT `Db` method of the same name with a THINNER
//! shape, and Rust prefers inherent methods — [`super`] carries the full statement of
//! the rule and of what the move out of `fulcrum-harness` 0.7.0 removed. The short
//! version, because it is the trap at each call site: `db.move_task(…)` binds the
//! desktop's own `move_task`, whose [`storage::MoveOutcome`] is `{ on_enter }` ALONE,
//! and `db.get_task(…)` binds the row with no `artifactKeys`. Every arm below runs the
//! inherent verb and then maps to the wire DTO with a WRITTEN-OUT struct literal, and
//! `crate::agent::host_tools::tests::shape` asserts the load-bearing keys on the
//! decoded VALUE — never on source text.
//!
//! [`storage::MoveOutcome`]: crate::storage::MoveOutcome

use std::sync::Arc;

use serde_json::Value;

use super::{opt_str, req_str, row_result, spawn_host_call, to_details};
use crate::agent::tools::ToolResult;
use crate::storage::{BoardError, BoardRow, Db, HostToolError, MoveToolOutcome, TaskDetail};

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
pub(super) async fn list_board(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let space_path = req_str(params, "space_path")?;
    let db = db.clone();
    let space_path = space_path.to_string();
    // THE MAPPING, spelled out. `list_tasks` yields `TaskRow` (no `artifact_keys`,
    // `number: i64`); the answer needs `BoardRow` (`artifact_keys` REQUIRED,
    // `number: u32`). Returning `list_tasks`' rows directly compiles and ships a
    // board with no `artifactKeys`.
    let rows = spawn_host_call("list_board", move || {
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
pub(super) async fn get_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let task_id = req_str(params, "task_id")?.to_string();
    let db = db.clone();
    // THE MAPPING, spelled out: `Db::get_task` yields `TaskRow`, the answer needs
    // `TaskDetail` — the same row PLUS the artifact key names the detail dialog
    // shows as chips.
    let read_task_id = task_id.clone();
    let row = spawn_host_call("get_task", move || {
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
pub(super) async fn create_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let space_path = req_str(params, "space_path")?.to_string();
    let title = req_str(params, "title")?.to_string();
    let body = opt_str(params, "body")?.map(str::to_string);
    let stage_slug = opt_str(params, "stage_slug")?.map(str::to_string);
    let db = db.clone();
    // The write answer is the storage `TaskRow` ITSELF — no DTO of its own. A write
    // touched no artifact, so its answer says nothing about them, and the storage
    // row is already exactly that shape field-for-field. This is why the DTO family
    // that moved is three types and not five.
    let row = spawn_host_call("create_task", move || {
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
pub(super) async fn edit_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
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
    let row = spawn_host_call("edit_task", move || {
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
pub(super) async fn move_task(db: &Arc<Db>, params: &Value) -> Result<ToolResult, HostToolError> {
    let space_path = req_str(params, "space_path")?.to_string();
    let task_id = req_str(params, "task_id")?.to_string();
    let to_stage = req_str(params, "to_stage")?.to_string();
    let db = db.clone();
    let destination = to_stage.clone();
    let outcome = spawn_host_call(
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
pub(super) async fn get_artifact(
    db: &Arc<Db>,
    params: &Value,
) -> Result<ToolResult, HostToolError> {
    let task_id = req_str(params, "task_id")?.to_string();
    let key = req_str(params, "key")?.to_string();
    let db = db.clone();
    // No mapping: the storage `Artifact` was shaped to the crate's DTO on purpose
    // (the five names are identical), so this verb has never translated anything.
    let (read_task_id, read_key) = (task_id.clone(), key.clone());
    let artifact = spawn_host_call("get_artifact", move || {
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
pub(super) async fn write_artifact(
    db: &Arc<Db>,
    params: &Value,
) -> Result<ToolResult, HostToolError> {
    let task_id = req_str(params, "task_id")?.to_string();
    let key = req_str(params, "key")?.to_string();
    let markdown = req_str(params, "markdown")?.to_string();
    let db = db.clone();
    // No mapping: the storage `ArtifactMeta` is field-for-field the wire shape.
    let meta = spawn_host_call("write_artifact", move || {
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
