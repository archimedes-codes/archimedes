//! The VERB-BY-VERB behaviour half: that each host tool reaches the matching `Db`
//! method, that a refusal crosses as the model-facing sentence rather than a panic or
//! an `Ok`, and that the deadline is provable.
//!
//! These are the cases that lived in `router.rs`'s inline `mod tests` as
//! `run_task_call_*`. They move here because the code they test moved — ADR 0113's
//! Mirror rule — and the router no longer owns any board logic. What the router's own
//! tests keep is the ROUTING (the reply address, the diagnostics on a miss), which is
//! the thing only `route_event` can prove.
//!
//! Non-vacuity, unchanged from the originals: swap one arm's `Db` method for another
//! (say `get_artifact` calling `write_artifact`) and the case below naming that verb
//! reddens; delete the `spawn_blocking` and the runtime's own "no reactor" behaviour
//! is not what catches it — the assertions on the returned payload are.

use std::sync::Arc;

use serde_json::json;

use crate::agent::host_tools::{exec, run};
use crate::storage::Db;

async fn seeded(prefix: &str) -> (crate::test_support::ScratchDir, Arc<Db>, String) {
    let dir = crate::test_support::ScratchDir::in_env_temp(prefix, "db");
    let db = Arc::new(Db::open(&dir.join("db.sqlite")).expect("a temp db opens"));
    let space = "/host-tools/verbs";
    db.get_board(space)
        .expect("get_board seeds the five stages");
    let task = db
        .create_task(space, "a card", Some("the body"), None)
        .expect("create_task");
    (dir, db, task.id)
}

/// The text of a single-text-block result, for the assertions that read the
/// model-facing sentence rather than the payload.
fn text_of(result: &crate::agent::tools::ToolResult) -> String {
    match result.content.first() {
        Some(crate::agent::tools::ContentBlock::Text { text }) => text.clone(),
        other => panic!("expected a text block, got {other:?}"),
    }
}

#[tokio::test]
async fn a_write_and_a_read_round_trip_an_artifact_through_the_db() {
    let (_dir, db, task_id) = seeded("ht-verb-roundtrip-").await;

    let written = run(
        &db,
        "write_artifact",
        json!({ "task_id": task_id, "key": "spec", "markdown": "HOST-SENTINEL" }),
    )
    .await
    .expect("write_artifact over the host-tool path");
    let meta = &written.details.as_ref().expect("the meta rides details")["artifactMeta"];
    assert_eq!(meta["key"], "spec", "the meta names the key");
    assert_eq!(
        meta["bytes"],
        json!("HOST-SENTINEL".len()),
        "`bytes` is the byte length, and it is camelCase on the wire"
    );

    let read = run(
        &db,
        "get_artifact",
        json!({ "task_id": task_id, "key": "spec" }),
    )
    .await
    .expect("get_artifact over the host-tool path");
    assert_eq!(
        text_of(&read),
        "HOST-SENTINEL",
        "the markdown IS the content — this is the whole point of the verb"
    );

    // The row is in the DESKTOP's table — the executor answered from real storage,
    // it did not echo its argument.
    let direct = db
        .get_artifact(&task_id, "spec")
        .expect("direct read")
        .expect("the row exists");
    assert_eq!(direct.markdown, "HOST-SENTINEL");
}

#[tokio::test]
async fn a_missing_row_answers_a_sentence_and_not_an_error() {
    let (_dir, db, _task_id) = seeded("ht-verb-null-").await;

    // Absence is an ANSWER. An `is_error` result invites the model to retry the same
    // id, and 0.7.0's arms were explicit about that; the wire's `null` encoding is
    // gone (the executor builds the `ToolResult` now) but the BEHAVIOUR is carried.
    let missing = run(&db, "get_task", json!({ "task_id": "tsk_absent" }))
        .await
        .expect("absence is an answer, not an error");
    assert!(
        !missing.is_error,
        "an absent card is NOT a failed tool result"
    );
    assert_eq!(text_of(&missing), "no task found for `tsk_absent`");
    assert!(
        missing.details.is_none(),
        "and it reports no row it does not have"
    );

    let no_artifact = run(
        &db,
        "get_artifact",
        json!({ "task_id": "tsk_absent", "key": "spec" }),
    )
    .await
    .expect("an absent artifact is an answer too");
    assert!(!no_artifact.is_error);
    assert_eq!(
        text_of(&no_artifact),
        "no artifact `spec` for task `tsk_absent`"
    );
}

#[tokio::test]
async fn a_refusal_answers_the_model_facing_sentence_naming_the_offending_value() {
    let (_dir, db, task_id) = seeded("ht-verb-refusal-").await;

    // A dangling task id on a WRITE names the id (the storage gate exists because
    // `task_artifacts` has no FK to catch it).
    let err = run(
        &db,
        "write_artifact",
        json!({ "task_id": "tsk_dangling", "key": "spec", "markdown": "orphan" }),
    )
    .await
    .expect_err("a dangling id refuses");
    assert!(
        err.contains("tsk_dangling"),
        "the refusal names the id — the model reads this sentence verbatim and \
         cannot act on one that does not say what it rejected. Got: {err}"
    );
    assert!(
        err.contains("no task with id"),
        "and it is the STORAGE layer's own sentence, not a wrapper's paraphrase — \
         `BoardError`'s `Display` is the one owner. Got: {err}"
    );

    // A bad stage slug keeps the valid slugs in its sentence (ADR 0090's first
    // Consequence: name the valid ones so a model self-corrects without a discovery
    // round trip).
    let bad = run(
        &db,
        "move_task",
        json!({
            "space_path": "/host-tools/verbs",
            "task_id": task_id,
            "to_stage": "not-a-column",
        }),
    )
    .await
    .expect_err("an unknown slug refuses");
    assert!(
        bad.contains("backlog"),
        "a bad slug names the valid columns — got {bad}"
    );
}

/// The two artifact rules, ON THE HOST-TOOL PATH.
///
/// Non-vacuity: delete the storage checks and both assertions redden (an `Ok`
/// arrives); the row-count assertion at the end is what distinguishes a refusal that
/// wrote nothing from one that truncated.
#[tokio::test]
async fn an_illegal_artifact_key_and_an_oversized_markdown_are_refused_and_write_nothing() {
    let (_dir, db, task_id) = seeded("ht-verb-artifact-rules-").await;

    let err = run(
        &db,
        "write_artifact",
        json!({
            "task_id": task_id,
            "key": "My Spec",
            "markdown": "a document the model believed it saved",
        }),
    )
    .await
    .expect_err("the tool path must not be wider than the human's");
    assert!(
        err.contains("My Spec") && err.contains("[a-z0-9][a-z0-9-]{0,39}"),
        "the refusal names the key AND the grammar so the model self-corrects \
         without a second call — got {err}"
    );

    let err = run(
        &db,
        "write_artifact",
        json!({
            "task_id": task_id,
            "key": "spec",
            "markdown": "x".repeat(256 * 1024 + 1),
        }),
    )
    .await
    .expect_err("262145 bytes must be refused, never truncated");
    assert!(
        err.contains("262144") && err.contains("262145"),
        "the refusal names the LIMIT and the ACTUAL size — a model that cannot tell \
         how far over it went cannot decide what to cut — got {err}"
    );

    assert!(
        db.artifact_keys(&task_id)
            .expect("artifact_keys")
            .is_empty(),
        "and the refusals wrote NOTHING — no truncated spec sits on this card \
         pretending to be whole"
    );
}

#[tokio::test]
async fn a_missing_required_parameter_names_the_key() {
    let (_dir, db, _task_id) = seeded("ht-verb-params-").await;

    // A model that gets `space_path` back can fix it; one that gets `invalid params`
    // cannot. This is the reason the helper names the key.
    let err = run(&db, "list_board", json!({}))
        .await
        .expect_err("no space_path");
    assert!(
        err.contains("space_path"),
        "the refusal names the missing key — got {err}"
    );

    // A present-but-wrong-typed OPTIONAL is an error naming the key, not a silent
    // `None`: `body: 42` means the model meant to send something and sent the wrong
    // thing, and quietly dropping it would write a task without the body asked for.
    let err = run(
        &db,
        "create_task",
        json!({ "space_path": "/host-tools/verbs", "title": "t", "body": 42 }),
    )
    .await
    .expect_err("a wrong-typed optional refuses");
    assert!(
        err.contains("body"),
        "a wrong-typed optional names the key rather than being dropped — got {err}"
    );
}

#[tokio::test]
async fn an_optional_field_absent_or_null_leaves_the_card_field_alone() {
    let (_dir, db, task_id) = seeded("ht-verb-two-state-").await;

    // `None` and explicit `null` both mean LEAVE IT ALONE. This is the two-state
    // fold at the `FieldPatch` boundary, and the third state (`Clear`) stays
    // unreachable from the wire — deliberate and deferred, see the comment at
    // `exec::edit_task`.
    run(
        &db,
        "edit_task",
        json!({ "task_id": task_id, "title": "renamed", "body": null }),
    )
    .await
    .expect("an explicit null body leaves the body alone");
    let row = db.get_task(&task_id).expect("get_task").expect("the row");
    assert_eq!(row.title, "renamed");
    assert_eq!(
        row.body.as_deref(),
        Some("the body"),
        "`body: null` must NOT blank the column — only `FieldPatch::Clear` does that \
         and the wire has no spelling for it"
    );
}

#[tokio::test]
async fn an_empty_board_is_an_answer_that_still_carries_its_rows() {
    let dir = crate::test_support::ScratchDir::in_env_temp("ht-verb-empty-board-", "db");
    let db = Arc::new(Db::open(&dir.join("db.sqlite")).expect("a temp db opens"));

    let result = run(
        &db,
        "list_board",
        json!({ "space_path": "/host-tools/nothing-here" }),
    )
    .await
    .expect("an empty board is an answer");
    assert_eq!(text_of(&result), "the board is empty");
    assert_eq!(
        result
            .details
            .as_ref()
            .expect("the UI still gets its (empty) rows")["board"],
        json!([]),
        "the empty arm still rides `details.board`, so a reader never has to \
         distinguish \"empty\" from \"no payload\""
    );
}

#[tokio::test]
async fn an_unknown_tool_name_refuses_loudly_rather_than_parking() {
    let (_dir, db, _task_id) = seeded("ht-verb-unknown-").await;

    // ADR 0102 §2.5: "The daemon answers, it does not shrug." Reaching this with a
    // name `exec::exec` does not handle means `host_tool_specs()` and the dispatch
    // drifted apart — advertised and unreachable, the one failure class this whole
    // refactor can hide. The honest answer names itself.
    let err = run(&db, "not_a_host_tool", json!({}))
        .await
        .expect_err("an unhosted name is a failure, never a silent park");
    assert!(
        err.contains("not_a_host_tool"),
        "the refusal names the tool — got {err}"
    );
}

/// The title rule, ON THE HOST-TOOL PATH: a `create_task` whose title cleans to
/// nothing is refused with the ONE sentence, and writes no card.
///
/// Carried over from `tests/fulcrum_seams.rs`'s
/// `the_task_store_refuses_a_title_that_cleans_to_nothing_and_writes_no_card`, which
/// lost its subject when the trait went. It earns its place here for the same reason
/// the original earned its: the COMMAND door already refused this, and the tool path
/// must not be WIDER than the human's.
///
/// Non-vacuity, both halves: refuse titles generally and the LEGAL half reddens; drop
/// the storage check and the five `Invalid` assertions reddens.
#[tokio::test]
async fn a_title_that_cleans_to_nothing_is_refused_and_writes_no_card() {
    let (_dir, db, _task_id) = seeded("ht-verb-title-create-").await;

    for refused in ["", "   ", "\n\t \n", "\"\"", "''"] {
        let err = run(
            &db,
            "create_task",
            json!({
                "space_path": "/host-tools/verbs",
                "title": refused,
                "body": "a body a model wrote",
            }),
        )
        .await
        .expect_err("`{refused:?}` cleans to nothing, so the tool must refuse it");
        assert_eq!(
            err, "task title is empty after trimming",
            "the refusal is the `EmptyTitle` sentence, byte for byte, so a model reads              ONE sentence whichever door caught it (the command door answers the same)"
        );
    }

    // Exactly the one card the fixture made — five refusals wrote NOTHING, so no card
    // exists under a blank title and none was written and then renamed.
    let rows = db.list_tasks("/host-tools/verbs").expect("list_tasks");
    assert_eq!(
        rows.len(),
        1,
        "a refused title writes no card; got {rows:?}"
    );

    // The legal set is UNCHANGED: a real title still lands, and it lands CLEANED.
    // Without this half, "refuse blank titles" could be satisfied by refusing titles.
    let created = run(
        &db,
        "create_task",
        json!({ "space_path": "/host-tools/verbs", "title": "  a   model\'s   title  " }),
    )
    .await
    .expect("a real title is a legal create");
    let made = created.details.as_ref().expect("details")["task"].clone();
    assert_eq!(
        made["title"], "a model's title",
        "the CLEANED title is what is stored — one clean, at storage, for every door"
    );
    assert_eq!(
        db.list_tasks("/host-tools/verbs")
            .expect("list_tasks")
            .len(),
        2,
        "and the legal create landed — the rule did not narrow the legal set"
    );
}

/// The same rule on the EDIT verb: a title that cleans to nothing is refused and the
/// card KEEPS its label.
///
/// The defect was on TWO verbs, and the edit half is the worse one — a
/// `Set("")` is fully expressible on the wire, so a model could blank a label a person
/// had typed. Note what this does NOT cover: an ABSENT title is a KEEP, not a clear
/// (`Clear` is unreachable from the wire this spec advertises — see
/// `a_write_answer_reports_the_row_without_artifact_keys`'s sibling in `mapping.rs`).
#[tokio::test]
async fn an_edit_with_a_title_that_cleans_to_nothing_keeps_the_stored_label() {
    let (_dir, db, task_id) = seeded("ht-verb-title-edit-").await;

    for refused in ["", "   ", "\n\t \n", "\"\"", "''"] {
        let err = run(
            &db,
            "edit_task",
            json!({ "task_id": task_id, "title": refused }),
        )
        .await
        .expect_err(
            "`{refused:?}` cleans to nothing, so the edit verb must refuse it rather              than write it over a title somebody typed",
        );
        assert_eq!(
            err, "task title is empty after trimming",
            "the same sentence the create verb and the command door answer with"
        );
    }

    let stored = db.get_task(&task_id).expect("get_task").expect("the card");
    assert_eq!(
        stored.title, "a card",
        "the stored label is EXACTLY what it was — refused before the UPDATE, not          written and then complained about; got {:?}",
        stored.title
    );

    // The legal half, both states: a named title is stored CLEANED, and an absent one
    // is a KEEP.
    let renamed = run(
        &db,
        "edit_task",
        json!({ "task_id": task_id, "title": "  renamed   by   the   model  " }),
    )
    .await
    .expect("a real title is a legal edit");
    assert_eq!(
        renamed.details.as_ref().expect("details")["task"]["title"],
        "renamed by the model"
    );

    let untouched = run(
        &db,
        "edit_task",
        json!({ "task_id": task_id, "body": "a new body" }),
    )
    .await
    .expect("an absent title is a KEEP, not a clear");
    assert_eq!(
        untouched.details.as_ref().expect("details")["task"]["title"],
        "renamed by the model",
        "an absent title leaves the label alone — the verb is still two-state"
    );
    assert_eq!(
        db.get_task(&task_id)
            .expect("get_task")
            .expect("the card")
            .body
            .as_deref(),
        Some("a new body"),
        "and the field it WAS given lands"
    );
}

/// The deadline, PROVEN: a board future that never completes is answered at
/// `TASK_BOARD_CALL_TIMEOUT` with the `Io` sentence the model reads.
///
/// `start_paused` (precedented at `provider_auth/refresh.rs:948`, `:1083`) is what
/// makes this cheap — tokio auto-advances its own clock once nothing but a timer is
/// left, so the 30 s elapse in microseconds. The turbofish on `pending()` is required:
/// a bare `pending()` cannot infer its type.
///
/// Non-vacuity, carried over with the code it tests: delete the `timeout` from
/// `with_board_deadline` and this test hangs FOREVER (a `#[tokio::test]` carries no
/// timeout of its own, and with no timer left to advance to the paused clock never
/// moves) — which is the mutation proof, run as
/// `timeout 60 cargo test --lib -- a_board_call_still_running`.
#[tokio::test(start_paused = true)]
async fn a_board_call_still_running_at_the_deadline_answers_an_io_error_naming_the_verb() {
    let err = exec::with_board_deadline(
        "get_artifact",
        std::future::pending::<Result<serde_json::Value, crate::storage::HostToolError>>(),
    )
    .await
    .expect_err("a board call still running at the deadline is an error, never silence");
    let sentence = err.to_string();
    assert!(
        sentence.contains("get_artifact") && sentence.contains("timed out"),
        "the sentence names the VERB and the expiry — the model reads this verbatim \
         and must be able to tell which call died — got {err:?}"
    );
    // The duration is a LITERAL on purpose. The other spelling —
    // `contains(&format!("{TASK_BOARD_CALL_TIMEOUT:?}"))` — rebuilds the expected
    // substring from the SAME const the production sentence interpolates, so the two
    // can never disagree and the assertion is tautological; only a literal can fail
    // here (and `30s` is what that const renders as).
    assert!(
        sentence.contains("30s"),
        "the sentence names the bound itself — got {sentence}"
    );
}

/// A blocking task that DIED (panicked, or a runtime shutting down) says FAILED and
/// not TIMED OUT — the two are different facts and the model reads both verbatim.
#[tokio::test]
async fn a_board_call_whose_blocking_task_died_still_says_failed_and_not_timed_out() {
    // NO `Db` fixture, and that is the point of the case: the failure it pins happens
    // BEFORE any storage is touched, so the helper's `JoinError` arm is what is under
    // test and a database would only be scenery.
    //
    // A closure that panics inside `spawn_blocking` is a `JoinError`, and the honest
    // sentence about that is `failed`. The `&'static str` leak makes the closure
    // `'static` so the panic lands INSIDE the blocking task and reaches the
    // `JoinError` arm rather than aborting the test process.
    let err = exec::spawn_board::<i32, crate::storage::BoardError, _>("get_task", || {
        let boom: &'static str = Box::leak("deliberate blocking-task panic".into());
        panic!("{boom}")
    })
    .await
    .expect_err("a dead blocking task is an error, never silence");
    let sentence = err.to_string();
    assert!(
        sentence.contains("get_task") && sentence.contains("failed"),
        "`failed`, naming the verb — got {sentence}"
    );
    assert!(
        !sentence.contains("timed out"),
        "and NOT `timed out`: the call did not run long, it died. Conflating the two \
         tells the model to wait. Got: {sentence}"
    );
}
