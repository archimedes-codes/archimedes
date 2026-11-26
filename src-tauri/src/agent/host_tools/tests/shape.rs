//! THE SHAPE ASSERTION — the pin the lossy-twin trap exists to justify.
//!
//! ADR 0102 §"The lossy inherent twins" calls spelling an arm back to the inherent
//! twin "the most likely way to break this", and it is the ONE mutation this commit
//! can make that ships green without this file. So this file asserts the three
//! load-bearing keys — `toStage`, `note`, `artifactKeys` — on the DECODED VALUE of
//! what each executor actually returns.
//!
//! # Why an assertion on a VALUE and never on source text
//!
//! A `contains` on a file's text cannot see a wrong type being serialized. It can be
//! satisfied by a comment, by a docstring, by a string literal in an unrelated
//! sentence, and by the very code that is broken (a doc comment that says `toStage`
//! sits beside an arm that omits it). This file calls the executor and inspects the
//! JSON that comes back. Nothing about that is satisfiable by prose.
//!
//! # The mutation this reddens on, and why it is the one that matters
//!
//! In `exec::move_task`, replace the written-out `MoveToolOutcome { .. }` literal
//! with the storage outcome the inherent verb answered with:
//!
//! ```text
//! // BROKEN — compiles, and every move_task answer loses `toStage`
//! let out = spawn_board("move_task", move || Db::move_task(&db, &space_path, &task_id, &to_stage)).await?;
//! return Ok(ToolResult::ok_text(text, Some(to_details("moveOutcome", &out)?)));
//! ```
//!
//! That COMPILES. It is desktop-green, CI-green, `pnpm build`-green, and every
//! `move_task` answer in production is missing `toStage`.
//! `a_move_task_answer_carries_to_stage_on_enter_and_note_all_three` reddens on it,
//! because `crate::storage::MoveOutcome` has exactly one field and no `to_stage` to
//! serialize. The sibling assertion on `artifactKeys` reddens on the same mistake in
//! `get_task` (the inherent row has no artifact keys).
//!
//! # Why these are not re-spelled payload literals
//!
//! Each assertion checks a KEY IS PRESENT (and, where the value is knowable, holds
//! the right thing) after a round trip through `serde_json::Value`. The shape the
//! frontend pins is the set of keys and their types; that is exactly what is asserted.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent::host_tools::run;
use crate::storage::Db;

/// A `Db` with one Space seeded and one card, plus an artifact on that card.
///
/// The artifact exists on purpose: `artifactKeys` is the half of the shape that a
/// fixture without one could not distinguish from an absent field — an empty `Vec`
/// and a missing key both read as "no chips", so only a card WITH an artifact proves
/// the key is being carried and not merely defaulted.
async fn seeded(
    prefix: &str,
    with_artifact: bool,
) -> (crate::test_support::ScratchDir, Arc<Db>, String) {
    let dir = crate::test_support::ScratchDir::in_env_temp(prefix, "db");
    let db = Arc::new(Db::open(&dir.join("db.sqlite")).expect("a temp db opens"));
    let space = "/host-tools/shape";
    db.get_board(space)
        .expect("get_board seeds the five stages");
    let task = db
        .create_task(space, "a card", Some("the body"), None)
        .expect("create_task");
    if with_artifact {
        db.write_artifact(&task.id, "research", "# notes")
            .expect("write_artifact");
    }
    (dir, db, task.id)
}

/// Pull one tool result's `details` envelope out, failing LOUDLY on its absence
/// rather than unwrapping a `None` into an opaque panic.
fn details_of(result: &crate::agent::tools::ToolResult, verb: &str) -> Value {
    assert!(
        !result.is_error,
        "`{verb}` returned a FAILED result — the shape cannot be asserted on a \
         failure: {:?}",
        result
            .content
            .first()
            .map(|c| format!("{c:?}"))
            .unwrap_or_default(),
    );
    result.details.clone().unwrap_or_else(|| {
        panic!(
            "`{verb}` answered with NO `details` — the frontend's \
             tool-details reader has nothing to render, and the pinned key is gone"
        )
    })
}

/// THE FRONTEND CONTRACT, PINNED AS AN EXACT KEY SET.
///
/// `src/lib/toolDetailsRegistry.test.ts` freezes 39 producer keys and four fixture
/// payloads whose keys are spelled out in TypeScript. Presence assertions (every
/// other test in this file) cannot see an EXTRA key: a producer that added
/// `artifactCount` would keep all four fixture groups green while silently changing
/// the wire the frozen tuple describes. So this asserts set EQUALITY against the four
/// fixture payloads' key lists, copied from that file.
///
/// The mutation this exists for: add one field to `storage::BoardRow`, or rename one.
/// A rename reddens a presence test; only an equality assertion catches the addition,
/// and `pnpm build` reddens on the TS side — but a Rust-side red is what tells the
/// person who added the field, in the language they were editing.
#[tokio::test]
async fn every_details_payload_key_set_matches_the_frozen_frontend_fixtures() {
    let (_dir, db, task_id) = seeded("ht-shape-keysets-", true).await;

    // `details.board[]` — the 11 keys of the fixture's one row.
    let board = run(
        &db,
        "list_board",
        json!({ "space_path": "/host-tools/shape" }),
    )
    .await
    .expect("list_board");
    let board_keys = keys_of(&details_of(&board, "list_board")["board"][0]);
    assert_eq!(
        board_keys,
        expected(&[
            "id",
            "spacePath",
            "number",
            "title",
            "body",
            "specPath",
            "stageSlug",
            "sortOrder",
            "createdAt",
            "updatedAt",
            "artifactKeys",
        ]),
        "`details.board`'s row keys must be EXACTLY the fixture's — the frozen 39-key \
         tuple in toolDetailsRegistry.test.ts describes this payload"
    );

    // `details.task` — the WIDER of the two row shapes (the `get_task` one).
    let detail = run(&db, "get_task", json!({ "task_id": task_id.clone() }))
        .await
        .expect("get_task");
    assert_eq!(
        keys_of(&details_of(&detail, "get_task")["task"]),
        expected(&[
            "id",
            "spacePath",
            "number",
            "title",
            "body",
            "specPath",
            "stageSlug",
            "sortOrder",
            "createdAt",
            "updatedAt",
            "artifactKeys",
        ]),
        "`details.task` (the `TaskDetail` arm) is the same 11 keys as a board row"
    );

    // `details.moveOutcome` — all three, in the fixture's spelling.
    let moved = run(
        &db,
        "move_task",
        json!({ "space_path": "/host-tools/shape", "task_id": task_id.clone(), "to_stage": "done" }),
    )
    .await
    .expect("move_task");
    assert_eq!(
        keys_of(&details_of(&moved, "move_task")["moveOutcome"]),
        expected(&["toStage", "onEnter", "note"]),
        "`details.moveOutcome` is EXACTLY {{toStage,onEnter,note}}"
    );

    // `details.artifactMeta` — meta only.
    let written = run(
        &db,
        "write_artifact",
        json!({ "task_id": task_id, "key": "spec", "markdown": "doc" }),
    )
    .await
    .expect("write_artifact");
    assert_eq!(
        keys_of(&details_of(&written, "write_artifact")["artifactMeta"]),
        expected(&["key", "updatedAt", "bytes"]),
        "`details.artifactMeta` is EXACTLY {{key,updatedAt,bytes}}"
    );

    // The write verbs' `details.task` is that SAME key list MINUS `artifactKeys` —
    // the fixture documents both arms ("the write verbs' `TaskRow` is this DTO minus
    // `artifactKeys`"), so the narrower set is pinned too rather than inferred.
    let created = run(
        &db,
        "create_task",
        json!({ "space_path": "/host-tools/shape", "title": "keyset card" }),
    )
    .await
    .expect("create_task");
    let mut write_keys = expected(&[
        "id",
        "spacePath",
        "number",
        "title",
        "body",
        "specPath",
        "stageSlug",
        "sortOrder",
        "createdAt",
        "updatedAt",
    ]);
    assert_eq!(
        keys_of(&details_of(&created, "create_task")["task"]),
        write_keys,
        "the write answer's `details.task` is the row WITHOUT `artifactKeys`"
    );
    write_keys.sort();
    write_keys.dedup();
    assert_eq!(write_keys.len(), 10, "the narrower arm is 10 keys, not 11");
}

/// The key set of a JSON object, sorted, for the equality assertions above.
fn keys_of(value: &Value) -> Vec<String> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("expected a JSON object to take the key set of, got {value}"))
        .keys()
        .cloned()
        .collect::<Vec<_>>()
}

/// The fixture's key list, sorted — so the comparison is set equality and an
/// assertion failure reads as a diff rather than an ordering artifact.
fn expected(keys: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = keys.iter().map(|s| s.to_string()).collect();
    v.sort();
    v
}

/// `move_task`'s answer carries ALL THREE keys: `toStage`, `onEnter`, `note`.
///
/// The mutation this exists for is in this file's module doc. `note` is asserted as
/// PRESENT-AND-NULL, not absent: the crate's DTO serialized an absent note as
/// `null`, `toolDetailsRegistry.test.ts`'s fixture spells the key, and a `None`
/// `Option` that serde dropped would be a shape drift the frontend's reader sees.
#[tokio::test]
async fn a_move_task_answer_carries_to_stage_on_enter_and_note_all_three() {
    let (_dir, db, task_id) = seeded("ht-shape-move-", false).await;

    let result = run(
        &db,
        "move_task",
        json!({
            "space_path": "/host-tools/shape",
            "task_id": task_id,
            "to_stage": "doing",
        }),
    )
    .await
    .expect("a valid move is not an error sentence");

    let details = details_of(&result, "move_task");
    let outcome = details.get("moveOutcome").expect(
        "the move answer rides `details.moveOutcome` — that key is one of the \
                 39 in toolDetailsRegistry.test.ts's frozen producer tuple",
    );

    // THE THREE KEYS. `to_stage` and `note` are the two the inherent
    // `crate::storage::MoveOutcome` does NOT have — that struct is `{ on_enter }`
    // alone — so both are evidence the explicit mapping ran and the inherent twin's
    // answer was not passed through.
    assert!(
        outcome.get("toStage").is_some(),
        "`toStage` MUST be present. The storage `MoveOutcome` has no `to_stage` \
         field, so a missing key here means `exec::move_task` serialized the \
         INHERENT `Db::move_task` answer instead of mapping to \
         `storage::MoveToolOutcome` — the lossy-twin trap. Got: {outcome}"
    );
    assert_eq!(
        outcome["toStage"], "doing",
        "`toStage` names the destination the CALLER asked for (the desktop's \
         `move_task` refuses before it writes, so a successful move lands where it \
         was told)"
    );
    assert!(
        outcome.get("onEnter").is_some(),
        "`onEnter` must be present and non-null — it is the destination stage's \
         `on_enter`, read inside the same lock as the write. Got: {outcome}"
    );
    assert_eq!(
        outcome["onEnter"], "none",
        "opaque data for the CALLER's layer, and this code never interprets it"
    );
    assert!(
        outcome.get("note").is_some(),
        "`note` must be PRESENT even when there is no note to make — the DTO's \
         `note: Option` serializes as `null` and the frontend fixture spells the \
         key, so a dropped key is a shape drift. Got: {outcome}"
    );
    assert!(
        outcome["note"].is_null(),
        "and it is `null` today: the boost note needs the `SessionManager`, which \
         storage cannot name, so it stays command-layer. Got: {outcome}"
    );

    // The model-facing text names the destination and NOT the opaque `onEnter`.
    let text = match &result.content[0] {
        crate::agent::tools::ContentBlock::Text { text } => text.clone(),
        other => panic!("a move answer is a text block, got {other:?}"),
    };
    assert!(
        text.contains("doing"),
        "the text names where the card landed — got {text}"
    );
    assert!(
        !text.contains("none"),
        "and it does NOT describe `onEnter`, which is opaque to this layer — got {text}"
    );
}

/// `get_task`'s answer carries `artifactKeys` — the key the inherent row lacks.
#[tokio::test]
async fn a_get_task_answer_carries_artifact_keys_with_the_names_on_the_card() {
    let (_dir, db, task_id) = seeded("ht-shape-detail-", true).await;

    let result = run(&db, "get_task", json!({ "task_id": task_id.clone() }))
        .await
        .expect("a valid get_task is not an error sentence");

    let details = details_of(&result, "get_task");
    let task = details
        .get("task")
        .expect("the row rides `details.task`")
        .clone();

    assert!(
        task.get("artifactKeys").is_some(),
        "`artifactKeys` MUST be present. The inherent `Db::get_task` answers with a \
         `TaskRow`, which has no such field — `storage::TaskDetail` is that row PLUS \
         the keys — so a missing key here means the executor passed the storage row \
         through. Got: {task}"
    );
    assert_eq!(
        task["artifactKeys"],
        json!(["research"]),
        "the KEY names, and the fixture wrote exactly one"
    );
    // Keys only, never the document — the whole point of splitting `TaskDetail`
    // from `Artifact`.
    assert!(
        !task.to_string().contains("# notes"),
        "a row payload must never carry markdown — got {task}"
    );
    // `number` narrows to u32 on the DTO; assert it still arrives as a NUMBER, not
    // a string, so the narrowing at the mapping site cannot silently stringify.
    assert!(
        task["number"].is_number(),
        "`number` stays a JSON number across the i64 → u32 narrowing — got {task}"
    );
}

/// An artifact-less card answers `artifactKeys: []`, NOT an absent key and NOT `null`.
///
/// The sibling of the test above, and the one that catches the OTHER direction: an
/// executor that decided "no artifacts, so say nothing" would satisfy the fixture
/// above by accident only if it also dropped the key on a card that HAS one.
#[tokio::test]
async fn an_artifact_less_card_answers_artifact_keys_as_an_empty_array_not_an_absence() {
    let (_dir, db, task_id) = seeded("ht-shape-empty-keys-", false).await;

    let result = run(&db, "get_task", json!({ "task_id": task_id }))
        .await
        .expect("a valid get_task is not an error sentence");

    let task = details_of(&result, "get_task")["task"].clone();
    assert_eq!(
        task.get("artifactKeys"),
        Some(&json!([])),
        "`artifactKeys` is `Vec<String>`, REQUIRED and never `Option` — an \
         artifact-less card is `[]`. `null` or an absent key would make the \
         frontend's chip list branch on an absence the DTO cannot express. \
         Got: {task}"
    );
}

/// `list_board`'s rows carry `artifactKeys` too, and the board stays markdown-free.
#[tokio::test]
async fn a_board_answer_carries_artifact_keys_on_every_row() {
    let (_dir, db, task_id) = seeded("ht-shape-board-", true).await;

    let result = run(
        &db,
        "list_board",
        json!({ "space_path": "/host-tools/shape" }),
    )
    .await
    .expect("a valid list_board is not an error sentence");

    let board = details_of(&result, "list_board")
        .get("board")
        .expect("the rows ride `details.board`")
        .clone();
    let rows = board.as_array().expect("a board is a JSON array");
    assert_eq!(rows.len(), 1, "one card, got {board}");
    assert_eq!(
        rows[0]["artifactKeys"],
        json!(["research"]),
        "the board row carries the artifact KEY names — `storage::BoardRow` is the \
         storage `TaskRow` PLUS that field, and `Db::list_tasks` has no such field, \
         so this is the mapping site"
    );
    assert!(
        !board.to_string().contains("# notes"),
        "a board payload must never carry markdown — got {board}"
    );
    // The task's OWN artifact read still works, so the board's keys-only rule is a
    // shaping choice and not a storage failure wearing a disguise.
    let full = run(
        &db,
        "get_artifact",
        json!({ "task_id": task_id, "key": "research" }),
    )
    .await
    .expect("get_artifact");
    assert!(
        full.details.is_none(),
        "and the artifact answer carries NO `details` — the markdown would \
         otherwise exist twice in one result"
    );
}

/// The two WRITE verbs answer `details.task` WITHOUT `artifactKeys`.
///
/// The negative half of the shape: the crate's write answer deliberately said nothing
/// about artifacts (a write touched none), and `toolDetailsRegistry.test.ts`'s `task`
/// fixture documents both shapes. An executor that "helpfully" added the keys to the
/// write answer would be a shape drift in the opposite direction, and this reddens.
#[tokio::test]
async fn a_write_answer_reports_the_row_without_artifact_keys() {
    let (_dir, db, _task_id) = seeded("ht-shape-write-", false).await;

    let created = run(
        &db,
        "create_task",
        json!({
            "space_path": "/host-tools/shape",
            "title": "second card",
            "stage_slug": "doing",
        }),
    )
    .await
    .expect("create_task");

    let row = details_of(&created, "create_task")
        .get("task")
        .expect("the new row rides `details.task`")
        .clone();
    assert_eq!(row["number"], json!(2), "numbered per Space");
    assert_eq!(row["stageSlug"], "doing");
    assert!(
        row.get("artifactKeys").is_none(),
        "a write says nothing about artifacts — the write answer is the storage \
         `TaskRow`, which has no such field. Got: {row}"
    );

    let edited = run(
        &db,
        "edit_task",
        json!({ "task_id": row["id"], "title": "renamed" }),
    )
    .await
    .expect("edit_task");
    let edited_row = details_of(&edited, "edit_task")
        .get("task")
        .expect("the edited row rides `details.task`")
        .clone();
    assert_eq!(edited_row["title"], "renamed");
    assert!(
        edited_row.get("artifactKeys").is_none(),
        "and `edit_task` shares that answer shape — got {edited_row}"
    );
}

/// `write_artifact`'s answer is `details.artifactMeta` with `{key, updatedAt, bytes}`
/// and NEVER the markdown back.
#[tokio::test]
async fn an_artifact_write_answer_is_meta_only_under_the_pinned_key() {
    let (_dir, db, task_id) = seeded("ht-shape-meta-", false).await;

    let result = run(
        &db,
        "write_artifact",
        json!({
            "task_id": task_id,
            "key": "spec",
            "markdown": "SHAPE-SENTINEL document text",
        }),
    )
    .await
    .expect("write_artifact");

    let meta = details_of(&result, "write_artifact")
        .get("artifactMeta")
        .expect("the meta rides `details.artifactMeta`")
        .clone();
    assert_eq!(meta["key"], "spec");
    assert!(
        meta["updatedAt"].is_number(),
        "`updatedAt` is the fresh stamp — got {meta}"
    );
    assert_eq!(
        meta["bytes"],
        json!("SHAPE-SENTINEL document text".len()),
        "`bytes` is the UTF-8 byte length stored"
    );
    assert!(
        meta.get("markdown").is_none(),
        "the write answer echoes NO document — returning it doubles a frame that \
         can be 256 KB for no information. Got: {meta}"
    );
    // `bytes` is NESTED inside `artifactMeta` and counts against THAT key, never as
    // the top-level `bytes` the fs `write` arm emits. The nesting rule is the
    // frontend's; this asserts the payload really is nested.
    let envelope = details_of(&result, "write_artifact");
    assert!(
        envelope.get("bytes").is_none(),
        "`bytes` must not appear at the TOP level of the envelope — that spelling \
         belongs to the fs `write` tool. Got: {envelope}"
    );
}
