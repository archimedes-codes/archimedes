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
        None,
        false,
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
        None,
        false,
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
    let missing = run(
        &db,
        None,
        false,
        "get_task",
        json!({ "task_id": "tsk_absent" }),
    )
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
        None,
        false,
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
        None,
        false,
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
        None,
        false,
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
        None,
        false,
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
        None,
        false,
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
    let err = run(&db, None, false, "list_board", json!({}))
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
        None,
        false,
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
        None,
        false,
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
        None,
        false,
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
    let err = run(&db, None, false, "not_a_host_tool", json!({}))
        .await
        .expect_err("an unhosted name is a failure, never a silent park");
    assert!(
        err.contains("not_a_host_tool"),
        "the refusal names the tool — got {err}"
    );
}

/// (D9 — the sentence IS the deliverable) a model's forward `move_task` is refused
/// on the HOST-TOOL PATH with the sentence that teaches it `mark_done`.
///
/// This is the model-facing half of the gate, and it is pinned HERE rather than only
/// in `storage/db/tests/tasks.rs` because the thing under test is what a model
/// READS: `BoardError`'s `Display`, folded through `From<BoardError> for
/// HostToolError` into `HostToolError::Invalid`, rendered once by `exec::run` and
/// carried as the frame's `String`. Six assertions, each closing a hole the others
/// leave:
///
///   1. it names `mark_done` — the refusal is worthless without the replacement;
///   2. it names BOTH columns — the model asked about two of them;
///   3. it names the CARD — the same argument `a_refusal_answers_the_model_facing_
///      sentence_naming_the_offending_value` makes for a dangling id;
///   4. it says the move is FORWARD, so the model can tell this refusal from a
///      `MissingStage` and does not retry with a different column at random;
///   5. it still offers backward/sideways, so a refusal does not read as "the board
///      is locked" and cost a turn to discover otherwise;
///   6. it contains NEITHER banned substring. That arm is not tidiness:
///      `surface.rs`'s `no_host_tool_spec_names_read_or_subagent` scans whole SPEC
///      text, and `worker_e2e`'s `!tools_section.contains("read")` assertion is only
///      meaningful while nothing the model can see contains it. A refusal sentence
///      reaches the model as a tool RESULT, so the same ban binds it — and the
///      obvious word for a board's second column, `ready`, contains `read`. `thread`,
///      `already`, `spread` and `reads` are out for the same reason. Nothing else in
///      the tree checks THIS string for those substrings, so without arm 6 a
///      rewording that reaches for "ready" reddens only the Windows leg's grep, far
///      from the edit that caused it.
///
/// The fixture is the DEFAULT board on purpose: `seeded` calls `get_board`, every
/// `next_slugs` is NULL, and the refusal therefore proves the D15 fallback is wired
/// all the way to the model's door — not just into the BFS.
#[tokio::test]
async fn a_models_forward_move_is_refused_with_the_sentence_that_teaches_mark_done() {
    let (_dir, db, task_id) = seeded("ht-verb-forward-").await;

    let err = run(
        &db,
        None,
        false,
        "move_task",
        json!({
            "space_path": "/host-tools/verbs",
            "task_id": task_id,
            "to_stage": "done",
        }),
    )
    .await
    .expect_err("a forward move on the default board refuses (D7 + D15)");

    assert!(
        err.contains("mark_done"),
        "the refusal names the verb that does the move — a model told only what it \
         CANNOT do tries again; got {err}"
    );
    assert!(
        err.contains("backlog") && err.contains("done"),
        "both columns it asked about are named; got {err}"
    );
    assert!(
        err.contains(&task_id),
        "and so is the card, the same rule the dangling-id refusal follows; got {err}"
    );
    assert!(
        err.contains("forward"),
        "the refusal says WHY, so the model does not read this as a bad slug and \
         retry with another column; got {err}"
    );
    assert!(
        err.contains("backward"),
        "and it says what this verb is still for, so a refusal is not mistaken for \
         a locked board; got {err}"
    );
    for banned in ["read", "subagent"] {
        assert!(
            !err.contains(banned),
            "the refusal contains `{banned}`, which makes worker_e2e's \
             !tools_section.contains(\"{banned}\") assertion pass while proving \
             nothing — rewrite the SENTENCE, not this test (`ready`, `thread`, \
             `already`, `spread` and `reads` all contain the substring). Got: {err}"
        );
    }

    // And the move did not happen, through the door a model can actually reach.
    let read = run(&db, None, false, "get_task", json!({ "task_id": task_id }))
        .await
        .expect("get_task")
        .details
        .expect("a found card carries its row");
    assert_eq!(
        read["task"]["stageSlug"], "backlog",
        "a refused move writes NOTHING, on the model's door as on the person's"
    );
}

/// (D11 on the host-tool path's counterpart) the SAME card, moved BACKWARD by the
/// model, is allowed — the sentence above is a forward refusal and nothing else.
///
/// Pinned beside it because a gate that refused everything would satisfy every
/// assertion in the test above except this one.
#[tokio::test]
async fn a_models_backward_move_still_answers_a_move_and_not_a_sentence() {
    let (_dir, db, task_id) = seeded("ht-verb-backward-").await;
    // Position the card by the human door: on the default board every column is
    // forward-reachable from `backlog`, so a model cannot get itself to `done`.
    db.move_task(
        "/host-tools/verbs",
        &task_id,
        "done",
        crate::storage::MoveAuthor::Person,
    )
    .expect("the person's door positions the card");

    let moved = run(
        &db,
        None,
        false,
        "move_task",
        json!({
            "space_path": "/host-tools/verbs",
            "task_id": task_id,
            "to_stage": "backlog",
        }),
    )
    .await
    .expect("backward is not forward (D10)");
    assert!(
        !moved.is_error,
        "a backward move is a move, not a refusal: {:?}",
        moved.content.first()
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
            None,
            false,
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
        None,
        false,
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
            &db, None, false,
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
        None,
        false,
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
        None,
        false,
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
/// `HOST_CALL_TIMEOUT` with the `Io` sentence the model reads.
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
    // `contains(&format!("{HOST_CALL_TIMEOUT:?}"))` — rebuilds the expected
    // substring from the SAME const the production sentence interpolates, so the two
    // can never disagree and the assertion is tautological; only a literal can fail
    // here (and `30s` is what that const renders as). And the literal is the WHOLE
    // PHRASE and not bare `"30s"`: a bare `30s` is a substring of `130s` and `230s`,
    // so it would still pass if the const were lengthened past the value this doc
    // argues for. Pinning `"timed out after 30s"` pins the sentence AND the number in
    // one assertion. (This is the spelling `main` carried; the move to `host_tools`
    // briefly dropped it to bare `"30s"` and a const of `from_secs(130)` then passed
    // this test — the measurement that put the whole phrase back.)
    assert!(
        sentence.contains("timed out after 30s"),
        "the sentence names the DURATION too, so a supporter can tell a wedged `Db` \
         from a misrouted frame without a stopwatch — got {sentence}"
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
    let err = exec::spawn_host_call::<i32, crate::storage::BoardError, _>("get_task", || {
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

// ── `mark_done` — the verb whose subject is the FRAME, not `params` ───────────
//
// These drive `run` DIRECTLY. They deliberately do NOT go through the
// `WorkerInboundEvent::HostToolCall` fixtures in `agent/session/tests/mod.rs`
// (`:2143`, `:2277`): those pin ADR 0117's DIAGNOSTICS paths, and their
// `manager_seeded` fixture never wires `worker_manager`, so nothing spawns, no verb
// executes and the assertions pass on a dropped frame. A `mark_done` test written
// there would be GREEN AND PROVE NOTHING — it could not tell a working verb from an
// absent arm.
//
// Non-vacuity, the mutation this family exists to catch: DELETE the `"mark_done"` arm
// from `exec::exec` and every case below reddens — the four that expect an answer
// because the dispatch's loud unknown-name refusal arrives instead of the write, and
// the two refusals because the sentence stops naming a Subagent / an origin id. Swap
// the write for `set_session_archived` and the board assertion reddens.

/// A recorded Session — the FK target a `task_sessions` link needs, and the row
/// `mark_done` writes.
///
/// Built here rather than borrowed from `storage/db/tests/support.rs`'s
/// `title_session`, which is `pub(super)` to that mirror tree and single-consumer by
/// its own file's rule; a second consumer would move it, and this commit has no
/// business re-partitioning another subject's fixtures.
fn record_session(db: &Db, id: &str) {
    db.record_session(&crate::agent::SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: json!({ "piSessionId": id, "loadSession": true }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session (the link's FK target)");
}

/// A card with ONE linked Session — the shape a real launch leaves behind, and the
/// only shape on which a `mark_done` claim is OBSERVABLE: the column itself is not in
/// `SESSION_COLUMNS`, so the board's per-card `ready` fold is the public read.
async fn card_with_session(
    prefix: &str,
    session_id: &str,
) -> (crate::test_support::ScratchDir, Arc<Db>, String) {
    let (dir, db, task_id) = seeded(prefix).await;
    record_session(&db, session_id);
    db.link_session(&task_id, session_id, None)
        .expect("link_session (the card's bell needs the link)");
    (dir, db, task_id)
}

/// The card's `ready` flag as the BOARD READ reports it — the channel that reaches
/// the renderer, and the one that survives a restart (Task 2).
fn board_ready(db: &Db, task_id: &str) -> bool {
    db.get_board("/host-tools/verbs")
        .expect("get_board")
        .iter()
        .flat_map(|stage| stage.tasks.iter())
        .find(|card| card.task.id == task_id)
        .unwrap_or_else(|| panic!("the card `{task_id}` is on the board"))
        .ready
}

#[tokio::test]
async fn mark_done_marks_the_frames_own_session_and_the_board_sees_the_claim() {
    let (_dir, db, task_id) = card_with_session("ht-verb-mark-done-", "sess-caller").await;
    assert!(
        !board_ready(&db, &task_id),
        "a fresh card is NOT claiming anything — the assertion below discriminates"
    );

    let result = run(&db, Some("sess-caller"), false, "mark_done", json!({}))
        .await
        .expect("a main Session's own `mark_done` is a legal call");

    assert!(!result.is_error, "the claim succeeds — it is not a refusal");
    assert!(
        text_of(&result).contains("done"),
        "the sentence tells the model its Session is done — got {:?}",
        text_of(&result)
    );
    assert!(
        result.details.is_none(),
        "and it ships NO `details` key: a new one costs four coordinated edits in \
         `toolDetailsRegistry.test.ts` and reddens `pnpm build`'s `AssertEqual` seal. \
         The mark reaches the UI through the BOARD read, not through a tool payload."
    );

    assert!(
        board_ready(&db, &task_id),
        "THE WRITE LANDED, seen through the board read the renderer uses"
    );
}

#[tokio::test]
async fn mark_done_twice_is_the_same_claim_and_still_succeeds() {
    let (_dir, db, task_id) = card_with_session("ht-verb-mark-done-twice-", "sess-caller").await;

    run(&db, Some("sess-caller"), false, "mark_done", json!({}))
        .await
        .expect("the first claim");
    let second = run(&db, Some("sess-caller"), false, "mark_done", json!({}))
        .await
        .expect("a model that calls it twice is not punished for it");

    assert!(
        !second.is_error,
        "the second call is an `Ok` — the write is an idempotent `UPDATE`, and a \
         refusal here would teach the model that a repeat is a problem"
    );
    assert!(board_ready(&db, &task_id));
}

#[tokio::test]
async fn mark_done_refuses_a_subagent_by_name_and_writes_nothing() {
    // A CHILD's frame carries the CHILD's own id, and a child's claim renders nowhere:
    // cards link to the launching Session, and a child's `todos_update` never persists
    // either (`router.rs:46-52`). So the child is REFUSED. A silent `Ok` here is the
    // exact defect this card exists to remove — a supporter could not tell it from a
    // mark that landed.
    let (_dir, db, task_id) = card_with_session("ht-verb-mark-done-child-", "sess-parent").await;

    let err = run(&db, Some("s-child"), true, "mark_done", json!({}))
        .await
        .expect_err("a Subagent's `mark_done` is a REFUSAL, never a no-op");

    assert!(
        err.contains("Subagent"),
        "the refusal names WHOSE call it rejected and WHY — the model reads this \
         verbatim and has to be able to change what it is doing — got {err}"
    );
    assert!(
        err.contains("launched"),
        "and it points at the fix: finish in the Session that launched the work — \
         got {err}"
    );
    assert!(
        !board_ready(&db, &task_id),
        "and the refusal wrote NOTHING — no card is claiming a handoff nobody made"
    );
}

#[tokio::test]
async fn mark_done_refuses_a_frame_with_no_origin_and_never_borrows_the_delivery_id() {
    // ADR 0117's rule, second consequence: a delivery id is not a reply address and it
    // is not a SUBJECT either. `task_reply_target`'s own doc refuses the fallback for
    // the same reason, and a fallback here would mark whichever Session the pump
    // happened to re-key the frame to.
    let (_dir, db, task_id) = card_with_session("ht-verb-mark-done-noorigin-", "sess-caller").await;

    let err = run(&db, None, false, "mark_done", json!({}))
        .await
        .expect_err("no origin id is a REFUSAL, never a default");

    assert!(
        err.contains("frame"),
        "the refusal says the frame carried no origin id — got {err}"
    );
    assert!(
        !board_ready(&db, &task_id),
        "and NOTHING was written: defaulting to the delivery id would be a mark on a \
         Session nobody chose"
    );
}

#[tokio::test]
async fn mark_done_ignores_a_session_id_the_model_put_in_params() {
    // THE UN-SPOOFABILITY PIN. `params` is untrusted model JSON; the frame's origin id
    // is Worker-supplied. A model that NAMES another session must move nothing — if
    // this verb ever learns to look in `params`, this is the case that reddens.
    let (dir, db, task_id) = card_with_session("ht-verb-mark-done-spoof-", "sess-caller").await;
    let victim = "/host-tools/verbs";
    let other_card = db
        .create_task(victim, "someone else's card", None, None)
        .expect("a second card");
    record_session(&db, "sess-victim");
    db.link_session(&other_card.id, "sess-victim", None)
        .expect("link the second card to the session the model names");

    let result = run(
        &db,
        Some("sess-caller"),
        false,
        "mark_done",
        json!({ "session_id": "sess-victim", "task_id": other_card.id }),
    )
    .await
    .expect("extra keys are ignored, not refused — the spec advertises no parameters");

    assert!(
        board_ready(&db, &task_id),
        "the CALLER's card is the one that claims it"
    );
    assert!(
        !board_ready(&db, &other_card.id),
        "and the session the model NAMED is untouched — the subject came from the \
         frame. Result was {:?}",
        text_of(&result)
    );
    drop(dir);
}

#[tokio::test]
async fn list_tools_advertises_mark_done_to_settings() {
    // The Settings half of the acceptance criteria, on the SAME door the user sees.
    // `commands/settings.rs`'s own test gains the verb in its host loop; this is the
    // one that asks the COMMAND rather than the spec list.
    let names = crate::commands::settings::list_tools()
        .await
        .expect("the composed tool list builds");
    assert!(
        names.iter().any(|n| n == "mark_done"),
        "`mark_done` must be in the Settings list or the user cannot disable it — \
         got {names:?}"
    );
    assert_eq!(
        names.len(),
        crate::agent::harness::tool_specs().len()
            + crate::agent::host_tools::host_tool_specs().len(),
        "and the Settings list is still exactly engine ++ host, each name once"
    );
}
