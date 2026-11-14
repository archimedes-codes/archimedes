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
    // The two #180 artifact refusals. Both are strings the frontend branches on,
    // and neither is derivable from the other two — a bad KEY and an oversized
    // PAYLOAD get different messages and different fixes.
    assert_eq!(
        TasksError::BadArtifactKey("Bad Key".into()).kind(),
        "bad_artifact_key"
    );
    assert_eq!(
        TasksError::ArtifactTooLarge {
            size: 300_000,
            max: 262_144,
        }
        .kind(),
        "artifact_too_large"
    );
    // And the `ArtifactTooLarge` envelope keeps `FilesError::ImageTooLarge`'s
    // shape (ADR 0063): `kind` + `message` PLUS `size`/`max` as JSON numbers, so
    // the frontend can say how far over the cap a write was without parsing the
    // sentence.
    let wire = tauri::ipc::InvokeError::from(TasksError::ArtifactTooLarge {
        size: 300_000,
        max: 262_144,
    })
    .0;
    assert_eq!(wire["kind"], serde_json::json!("artifact_too_large"));
    assert_eq!(wire["size"], serde_json::json!(300_000));
    assert_eq!(wire["max"], serde_json::json!(262_144));
    assert!(
        wire["message"]
            .as_str()
            .expect("the message is a string")
            .contains("262144"),
        "the message names the limit AND the size; got {wire}"
    );
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

// ── Task 3 — reading the three-state patch off the invoke body ───────────────
//
// `edit_task` used to take `Option<String>` per field, and Tauri collapses an
// ABSENT key and an explicit `null` into the same `None` — so the UI had no way to
// ask for a clear even after storage grew `FieldPatch::Clear` (Task 1). The
// command now reads presence off the raw body, and these tests pin the reader
// without a webview: the `require_title` precedent two tests up.
//
// The command goes through `wire_call` rather than `board_call`, because its body
// now composes wire-only refusals `BoardError` has no arm for — and `board_call` is
// typed to `BoardError`. That swap buys something it must also be shown NOT to
// cost: the storage layer's absences still have to arrive as `not_found`. The last
// test here is that proof, and it is the reason the swap is safe rather than
// convenient.

/// The three states, for all three keys. Absent → `Keep`, `null` → `Clear`, a
/// string → `Set` — and the string arrives UNCHANGED, because the cleaner is
/// `patch_title`'s business (a later test) and `body`/`specPath` have no cleaner at
/// all.
///
/// Table-driven over the SAME reader the command calls, with the three wire keys
/// spelled as the frontend spells them (`specPath`, camelCase — the JS wrapper's own
/// key). The camelCase spelling is load-bearing and easy to get wrong: Rust's own
/// parameter names were `spec_path`, and a reader that looked for `spec_path` here
/// would silently `Keep` every clear the UI sent — the exact silent-green shape,
/// since a `Keep` reports a successful call that changed nothing.
#[test]
fn edit_task_patch_extraction_keeps_absent_clears_null_and_sets_a_string() {
    use crate::commands::tasks::patch_field;
    use crate::storage::FieldPatch;

    let keys = ["title", "body", "specPath"];

    // ABSENT: no key at all (what `JSON.stringify` leaves behind for an
    // `undefined` argument) → every column is left alone.
    let absent = serde_json::Map::new();
    for key in keys {
        assert!(
            matches!(
                patch_field(&absent, key).expect("an absent key is not an error"),
                FieldPatch::Keep
            ),
            "an absent `{key}` must mean Keep, not Clear"
        );
    }

    // EXPLICIT NULL → Clear, including on `title` (this reader is the generic
    // one; refusing a cleared title is `patch_title`'s decision, tested below).
    let cleared: serde_json::Map<String, serde_json::Value> = keys
        .iter()
        .map(|k| ((*k).to_string(), serde_json::Value::Null))
        .collect();
    for key in keys {
        assert!(
            matches!(
                patch_field(&cleared, key).expect("a null is a patch, not an error"),
                FieldPatch::Clear
            ),
            "an explicit null `{key}` must mean Clear"
        );
    }

    // A STRING → Set, verbatim. `""` is a real write here and NOT a clear — that
    // is the whole reason Task 2's render guards exist, and the reader must not
    // quietly fold the two together.
    let set: serde_json::Map<String, serde_json::Value> = [
        ("title", "Renamed"),
        ("body", ""),
        ("specPath", "docs/spec.md"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
    .collect();
    for (key, want) in [
        ("title", "Renamed"),
        ("body", ""),
        ("specPath", "docs/spec.md"),
    ] {
        match patch_field(&set, key).expect("a string is a patch") {
            FieldPatch::Set(got) => assert_eq!(got, want, "`{key}` is written as given"),
            // Spelled out rather than `{other:?}`: `FieldPatch` derives nothing
            // (Task 1 added no derives), so the arms are named.
            FieldPatch::Keep => panic!("`{key}` must be Set({want:?}), got Keep"),
            FieldPatch::Clear => panic!("`{key}` must be Set({want:?}), got Clear"),
        }
    }

    // And the states are INDEPENDENT per key — a patch that clears one column does
    // not touch the other two, which is the property the whole verb exists for.
    let one: serde_json::Map<String, serde_json::Value> =
        [("specPath".to_string(), serde_json::Value::Null)]
            .into_iter()
            .collect();
    assert!(matches!(
        patch_field(&one, "specPath"),
        Ok(FieldPatch::Clear)
    ));
    assert!(matches!(patch_field(&one, "body"), Ok(FieldPatch::Keep)));
    assert!(matches!(patch_field(&one, "title"), Ok(FieldPatch::Keep)));
}

/// A field of the WRONG JSON type is REFUSED, naming the key and the type it
/// found — and refused with the existing `other` kind, not a minted one.
///
/// Kept-instead-of-refused would be the lie: `{"specPath": 42}` reporting
/// `Ok(task)` would tell the caller it had pointed the card at a spec file when the
/// call wrote nothing at all (ADR 0079's class). The message has to carry BOTH the
/// key and the type because the caller is a person reading a console, and
/// `specPath: 42` in a payload of five keys is not findable by "bad field".
#[test]
fn a_wrongly_typed_edit_task_field_is_refused_naming_the_key() {
    use crate::commands::tasks::patch_field;

    let cases: Vec<(&str, serde_json::Value, &str)> = vec![
        ("specPath", serde_json::json!(42), "number"),
        ("body", serde_json::json!(true), "boolean"),
        ("title", serde_json::json!(["a"]), "array"),
        ("body", serde_json::json!({ "path": "x" }), "object"),
    ];
    for (key, value, type_name) in cases {
        let mut body = serde_json::Map::new();
        body.insert("taskId".to_string(), serde_json::json!("tsk_1"));
        body.insert(key.to_string(), value);
        // Matched rather than `.expect_err(..)`: `FieldPatch` derives nothing
        // (Task 1 added no derives and this test does not widen storage for its own
        // convenience), so the `Ok` arm cannot be printed.
        let err = match patch_field(&body, key) {
            Ok(_) => panic!("a wrongly-typed `{key}` must be refused, not kept"),
            Err(err) => err,
        };
        assert_eq!(
            err.kind(),
            "other",
            "no new wire kind is minted for this (`tasks_error_kinds_are_the_wire_strings` \
             pins the set, and nothing on either side branches on a sixth)"
        );
        let message = err.to_string();
        assert!(
            message.contains(key),
            "the refusal must name the key the caller has to fix: {message}"
        );
        assert!(
            message.contains(type_name),
            "and the JSON type it found, for `{key}`: {message}"
        );
    }

    // `null` and a string are NOT refused (the two legal non-absent readings) —
    // asserted here so the refusal cannot be widened into "reject anything but a
    // present string", which would make a clear unreachable again.
    let mut ok = serde_json::Map::new();
    ok.insert("specPath".to_string(), serde_json::Value::Null);
    assert!(patch_field(&ok, "specPath").is_ok());
}

/// `title` is `NOT NULL`, so a `null` title is REFUSED rather than passed down.
///
/// The refusal lives HERE, beside `require_title`, not in `Db`: this layer is the
/// one that decides what a valid title is, for the empty case (`""` cleans to
/// nothing → `empty_title`) and for the absent case alike. `Db::edit_task`'s doc
/// says the same thing from the other side — a `Clear` that slipped past would
/// surface SQLite's constraint as a bare `database` error, which is
/// defence-in-depth and not a nicer answer.
///
/// The three readings, and the one that must NOT reach the cleaner:
/// absent → keep, `""` → refused, a string → cleaned.
#[test]
fn edit_task_refuses_to_clear_the_title_because_the_column_is_not_null() {
    use crate::commands::tasks::patch_title;

    let mut cleared = serde_json::Map::new();
    cleared.insert("title".to_string(), serde_json::Value::Null);
    let err = patch_title(&cleared).expect_err("a card must have a label");
    assert_eq!(err.kind(), "other");
    let message = err.to_string();
    assert!(
        message.contains("NOT NULL"),
        "the sentence says WHY a title cannot be cleared, not just that it \
         cannot: {message}"
    );
    assert!(message.contains("title"), "and names the field: {message}");

    // ABSENT is not a clear and is not a write: `None` here means "do not touch
    // the column", and it must not reach the cleaner, or omitting the field would
    // be the same as blanking it (the point the old comment made, which survives
    // the rewrite).
    let absent = serde_json::Map::new();
    assert_eq!(
        patch_title(&absent).expect("an absent title is a legal patch"),
        None,
        "an absent title is kept, and never cleaned"
    );

    // A SET title goes through the SAME cleaner a create runs, and comes back
    // cleaned (the contract `require_title_cleans_like_the_session_namer…` pins).
    let mut set = serde_json::Map::new();
    set.insert(
        "title".to_string(),
        serde_json::Value::String("  Porting   the board  ".to_string()),
    );
    assert_eq!(
        patch_title(&set)
            .expect("a real title is accepted")
            .as_deref(),
        Some("Porting the board"),
        "the caller gets back what this layer approved, not what it was handed"
    );

    // And the empty case keeps its OWN kind (`empty_title`), because the board
    // dialog branches on it to re-show the title field.
    let mut empty = serde_json::Map::new();
    empty.insert(
        "title".to_string(),
        serde_json::Value::String("   ".to_string()),
    );
    assert_eq!(
        patch_title(&empty)
            .expect_err("a blank title is refused")
            .kind(),
        "empty_title"
    );
}

/// (the `wire_call` swap's cost, pinned) reading the patch off the body moves this
/// command from [`board_call`] to [`wire_call`], and the storage layer's ABSENCES
/// must still reach the wire as `not_found` — not flattened into `other`.
///
/// Why this test exists at all: `wire_call`'s inner arm returns the `TasksError` it
/// is handed UNCHANGED, so the `not_found`/`database` distinction now depends on the
/// ONE `.map_err(TasksError::from)` inside the command's closure. Delete it and
/// nothing else reddens — a cleared spec path on a deleted card would report a
/// generic failure, the frontend would keep the card on the board (it only drops a
/// card on `not_found`, ADR 0090), and the user would stare at a card that is not
/// there. That is the silent-green shape, and it is the one risk the swap introduces
/// — so the mutation IS tested: replacing that `map_err` with a flattening one turns
/// the last assertion here red.
///
/// Driven through the REAL storage call and the REAL `wire_call`, the way
/// `reorder_tasks_refusals_reach_the_wire_naming_what_was_refused` drives the other
/// flattener: the outer `Ok` stands in for the join succeeding (the arm `board_call`
/// documents as untestable), everything inside is the composition the command runs.
#[test]
fn edit_task_still_reports_a_missing_card_as_not_found_after_the_wire_call_swap() {
    use crate::commands::tasks::wire_call;
    use crate::storage::{Db, FieldPatch};

    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-task-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-task-edit/space";
    db.get_board(space).expect("seed the five stages");
    let live = db
        .create_task(space, "live", Some("body"), None)
        .expect("create");
    // `create_task` takes a STAGE slug, not a spec path, so the pointer the card
    // cites is written by the verb this plan is about — which also makes the setup
    // exercise the `Set` arm before the `Clear` arms are asserted.
    db.edit_task(
        &live.id,
        FieldPatch::Keep,
        FieldPatch::Keep,
        FieldPatch::Set("docs/spec.md"),
    )
    .expect("point the card at a spec");

    // A clear that lands: the row comes back with both columns NULLed. This is the
    // end-to-end shape the whole plan is for, asserted at the layer below the wire.
    let row = wire_call(Ok::<_, String>(
        db.edit_task(
            &live.id,
            FieldPatch::Keep,
            FieldPatch::Clear,
            FieldPatch::Clear,
        )
        .map_err(crate::agent::TasksError::from),
    ))
    .expect("a clear on a live card succeeds");
    assert_eq!(row.body, None, "`body` is NULL");
    assert_eq!(row.spec_path, None, "`spec_path` is NULL");
    assert_eq!(row.title, live.title, "and the kept title is untouched");

    // A clear against a card that is not there: `not_found`, naming the id, through
    // the SAME composition the command's closure runs.
    let err = wire_call(Ok::<_, String>(
        db.edit_task(
            "tsk_gone",
            FieldPatch::Keep,
            FieldPatch::Clear,
            FieldPatch::Keep,
        )
        .map_err(crate::agent::TasksError::from),
    ))
    .expect_err("a missing card must be refused");
    let envelope = tauri::ipc::InvokeError::from(err).0;
    assert_eq!(
        envelope["kind"],
        serde_json::json!("not_found"),
        "an ABSENCE keeps its identity through `wire_call` — the frontend drops the \
         card on this discriminator and on nothing else"
    );
    assert_eq!(
        envelope["message"],
        serde_json::json!("no task with id tsk_gone"),
        "and the storage layer's sentence passes through UNPREFIXED"
    );
}
