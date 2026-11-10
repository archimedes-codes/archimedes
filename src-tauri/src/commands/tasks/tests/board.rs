//! A1's board-command unit tests, moved VERBATIM out of `tasks.rs`'s inline
//! `#[cfg(test)] mod tests { … }` so the file could carry the repo's mandated
//! `mod tests;` + `tests/` directory shape (AGENTS.md: the split shape is
//! `mod tests;` + a directory, NOT a `tests.rs` sibling) for A4's
//! `start_task_session` tree. The five test NAMES are unchanged — only their
//! module path's spelling of `super::` had to become `crate::commands::tasks::`,
//! because `super` here is `tests`, not `tasks`.

use crate::agent::TasksError;
use crate::commands::tasks::{
    board_call, handoff_instructions, pick_compact_target, require_title,
};
use crate::storage::TaskSessionRow;

fn link(session: &str, stage: Option<&str>) -> TaskSessionRow {
    TaskSessionRow {
        task_id: "tsk_1".to_string(),
        session_id: session.to_string(),
        stage_slug: stage.map(str::to_string),
    }
}

/// (MANDATORY title contract) The Task title reuses the session namer's
/// cleaner — whitespace collapses, ONE matching quote layer strips — and an
/// input that cleans to nothing is a REJECTION, never a raw-string fallback.
///
/// The `""` / `''` cases are the reachable ones the orchestrator measured
/// against the real `clean_title`: both are non-empty after trimming, strip
/// their matching quote pair, and clean to `None`. A `raw` fallback would
/// have written a card whose label is a quote character.
#[test]
fn require_title_cleans_like_the_session_namer_and_refuses_an_empty_one() {
    assert_eq!(
        require_title("  Porting   the board \n").as_deref(),
        Ok("Porting the board"),
        "whitespace runs collapse and the ends trim — the same chain naming.rs runs"
    );
    assert_eq!(
        require_title("\"Porting the board\"").as_deref(),
        Ok("Porting the board"),
        "one layer of matching double quotes strips"
    );
    assert_eq!(
        require_title("'x'").as_deref(),
        Ok("x"),
        "and single quotes too"
    );
    assert_eq!(
        require_title("\"a\" and \"b\"").as_deref(),
        Ok("\"a\" and \"b\""),
        "a title that quotes WITHIN itself is not a wrapped title, so it is left alone"
    );

    for raw in ["", "   ", "\n\t \n", "\"\"", "''"] {
        let err = require_title(raw).expect_err("{raw:?} cleans to nothing and must be refused");
        assert_eq!(err.kind(), "empty_title", "for {raw:?}");
        assert_eq!(err, TasksError::EmptyTitle, "for {raw:?}");
    }
}

/// A Task title is NOT capped. The card's label is the user's own sentence, and
/// cutting it at 80 characters DESTROYS TEXT: `tasks.title` is `NOT NULL`, the
/// truncation is lossy, and nothing else stores the remainder — a body is only
/// written when the draft had a second line, so a long single-line card loses
/// everything past the cut with no way back. This was measured on a real card:
/// `What is the default action for notifications, i want to be able to click a notif`
/// — 80 chars, mid-word, `body` NULL.
///
/// The cap belongs to the SESSION namer, where it is a pi parity rule
/// (`replace(/\s+/g, " ").trim().replace(quoteRe).slice(0, 80)`) on a title a
/// MODEL invented. A card's title is not that artefact, and the two share the
/// cleaning CHAIN (whitespace collapse, one quote layer) without sharing the cut.
#[test]
fn a_long_task_title_is_kept_whole_and_never_cut_at_the_session_namer_cap() {
    let long = "What is the default action for notifications, i want to be able to click a notification and have it open the session that raised it";
    // 132 chars. Spelled as a literal because `TITLE_MAX_CHARS` lives in the private
    // `mod session` and is deliberately NOT re-exported through the `agent` hop to
    // satisfy a test; naming.rs pins the constant's VALUE itself.
    assert!(
        long.chars().count() > 80,
        "the fixture must exceed the session namer's 80-char cap or this proves nothing"
    );
    let got = require_title(long).expect("a long title is valid");
    assert_eq!(
        got, long,
        "the user's sentence is stored as typed, not truncated"
    );
    assert_eq!(got.chars().count(), long.chars().count());
}

/// The other half: whitespace still collapses and one quote layer still strips,
/// so lifting the cut did not quietly drop the cleaning. Both rules are the
/// session namer's and are still shared with it — this pins that the SHARED chain
/// survived the change, which a test that only checked length could not see.
#[test]
fn an_uncapped_title_still_gets_the_shared_cleaning() {
    let padded = format!("  \"{}   keeps   its  inner spacing\"\n", "a".repeat(100));
    let got = require_title(&padded).expect("valid");
    assert!(
        !got.starts_with('"') && !got.ends_with('"'),
        "one quote layer strips: {got}"
    );
    assert!(!got.contains("   "), "whitespace runs collapse: {got}");
    assert_eq!(got.split_whitespace().count(), got.split(' ').count());
    assert!(got.len() > 80, "and it is still uncapped: {}", got.len());
}

/// The `empty_title` kind is the wire discriminator the frontend branches on
/// (ADR 0063), so it is pinned as a literal rather than derived.
#[test]
fn tasks_error_kinds_are_the_wire_strings() {
    assert_eq!(TasksError::EmptyTitle.kind(), "empty_title");
    assert_eq!(
        TasksError::NotFound("no task with id tsk_x".into()).kind(),
        "not_found"
    );
    assert_eq!(TasksError::Database("busy".into()).kind(), "database");
    assert_eq!(TasksError::Other("join".into()).kind(), "other");
    // `NotFound`'s message passes through UNPREFIXED — the storage layer
    // already composed the sentence (and, for a bad slug, the valid-stage
    // list ADR 0090 requires). Re-wrapping it would put two sentences in the
    // one field the user reads.
    assert_eq!(
        TasksError::NotFound("no stage x (valid stages: doing)".into()).to_string(),
        "no stage x (valid stages: doing)"
    );
}

/// (`on_enter: compact`) the boost targets the Session linked at the stage
/// being LEFT; failing that, the newest link; with no links at all, `None`
/// is what surfaces "no live session to compact" rather than a silent no-op.
#[test]
fn pick_compact_target_prefers_the_link_at_the_stage_being_left() {
    let links = vec![
        link("sess-old", Some("backlog")),
        link("sess-research", Some("research")),
        link("sess-newest", Some("doing")),
    ];
    assert_eq!(
        pick_compact_target(Some("research"), &links)
            .expect("a link exists for research")
            .session_id,
        "sess-research",
        "the stage being LEFT decides which Session compacts (spec §2's reason \
         task_sessions carries a stage_slug at all)"
    );
    assert_eq!(
        pick_compact_target(Some("approved"), &links)
            .expect("no link at that stage, so the newest one")
            .session_id,
        "sess-newest",
        "no link at the from-stage falls back to the NEWEST link"
    );
    assert_eq!(
        pick_compact_target(None, &links)
            .expect("no from-stage, so the newest one")
            .session_id,
        "sess-newest"
    );
    assert!(
        pick_compact_target(Some("backlog"), &[]).is_none(),
        "a card with no linked Session has nothing to boost — the caller surfaces \
         `no live session to compact` instead of reporting a boost that never ran"
    );
}

/// The handoff sentence names BOTH stages (spec §5's suggested text), so the
/// summary the model writes is about the right span of work.
#[test]
fn handoff_instructions_name_both_stages() {
    let text = handoff_instructions(Some("doing"), "done");
    assert!(
        text.contains("**doing**") && text.contains("**done**"),
        "{text}"
    );
    let unknown = handoff_instructions(None, "done");
    assert!(
        unknown.contains("the previous stage") && unknown.contains("**done**"),
        "{unknown}"
    );
}

/// (`reorder_tasks`' error path, spec §3) A card the caller had no right to
/// name arrives at the wire as `not_found` NAMING the id — not as a generic
/// database error, and not as a silent success.
///
/// Driven through the REAL storage call and the real [`board_call`] the
/// command delegates to, so this pins the COMPOSITION rather than re-asserting
/// the `From<BoardError>` arms in isolation: `Db::reorder_tasks` refuses a
/// foreign id, `board_call` maps it, and the `InvokeError` envelope carries the
/// two fields the frontend branches on (ADR 0063).
///
/// Why the id must survive the trip: `reorder_tasks` is handed a whole
/// column's slice. A rejection that says only "reorder failed" leaves the user
/// (or a model) no way to find which card did not belong, and the honest
/// alternative — reporting `Ok` — would show a board that had not moved.
#[test]
fn reorder_tasks_refusals_reach_the_wire_naming_what_was_refused() {
    use crate::storage::{BoardError, Db};

    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-task-reorder-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-task-reorder/space";
    let other_space = "/cmd-task-reorder/elsewhere";
    db.get_board(space).expect("seed the five stages");
    let mine = db.create_task(space, "mine", None, None).expect("create");
    let in_done = db
        .create_task(space, "in-done", None, Some("done"))
        .expect("create in another stage");
    let elsewhere = db
        .create_task(other_space, "elsewhere", None, None)
        .expect("create in another space");

    // The two foreign-id refusals, each fed through the command layer's own
    // mapping: a card from another STAGE, and one from another SPACE.
    let foreign: Vec<(Vec<String>, String)> = vec![
        (
            vec![mine.id.clone(), in_done.id.clone()],
            in_done.id.clone(),
        ),
        (
            vec![mine.id.clone(), elsewhere.id.clone()],
            elsewhere.id.clone(),
        ),
    ];
    for (ids, named) in foreign {
        // The outer `Ok` stands in for the `spawn_blocking` JOIN succeeding —
        // the arm `board_call`'s own doc states is untestable, since the
        // closure is pure against owned arguments. Everything inside it is the
        // real storage call and the real mapping the command runs. `String`
        // names the join-error slot: `board_call` is generic over it precisely
        // so the caller need not import `tauri::Error`, and the arm is not
        // taken here.
        let storage = Ok::<_, String>(db.reorder_tasks(space, "backlog", &ids));
        let err = board_call(storage).expect_err("a foreign id must be refused");
        assert_eq!(
            err.kind(),
            "not_found",
            "an ABSENCE keeps its identity rather than flattening into `database`"
        );
        assert_eq!(
            err.to_string(),
            format!("no task with id {named}"),
            "the message names the id the caller has to fix"
        );

        // The envelope the webview actually receives (ADR 0063): `kind` is the
        // discriminator the frontend switches on, `message` the sentence it
        // shows. Read through `InvokeError`'s public `.0` — it is a newtype
        // over the `serde_json::Value` this repo hand-builds, so there is
        // nothing to re-parse.
        let envelope = tauri::ipc::InvokeError::from(err).0;
        assert_eq!(envelope["kind"], serde_json::json!("not_found"));
        assert_eq!(
            envelope["message"],
            serde_json::json!(format!("no task with id {named}"))
        );
    }

    // A STAGE that is not one of this Space's columns keeps ADR 0090's
    // self-correction payload through the same mapping.
    let raw = db.reorder_tasks(space, "nonsense", std::slice::from_ref(&mine.id));
    assert!(matches!(raw, Err(BoardError::MissingStage { .. })));
    let err = board_call(Ok::<_, String>(raw)).expect_err("an unknown stage must be refused");
    let message = err.to_string();
    assert_eq!(err.kind(), "not_found");
    assert!(
        message.contains("nonsense") && message.contains("backlog") && message.contains("done"),
        "the rejection names the valid slugs so the caller self-corrects: {message}"
    );

    // And the success path maps to `Ok(())` — the unit the TS wrapper's
    // `Promise<void>` is pinned to.
    board_call(Ok::<_, String>(db.reorder_tasks(
        space,
        "backlog",
        std::slice::from_ref(&mine.id),
    )))
    .expect("a valid reorder maps to Ok");
}
