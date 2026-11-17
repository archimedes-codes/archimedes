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

/// (MANDATORY title contract) `require_title` REFUSES every input that
/// `clean_title` cleans to nothing — and nothing else.
///
/// NARROWED, deliberately. This test used to assert the CLEANED string too
/// (`Ok("Porting the board")`), which was true while this layer owned the clean. It
/// no longer returns a value at all: the clean moved to `Db::create_task` /
/// `Db::edit_task`, the one path both the IPC door and the `TaskStore` seam pass
/// through. The CHAIN is pinned where the chain lives (`text::tests`) and the STORED
/// result is pinned at storage (`db_create_task_stores_the_cleaned_title`); a test
/// here that re-asserted the cleaned string would be asserting a contract this
/// function no longer has.
///
/// The `""` / `''` cases are the reachable ones the orchestrator measured against
/// the real `clean_title`: both are non-empty after trimming, strip their matching
/// quote pair, and clean to `None`. `trim().is_empty()` alone — the predicate a
/// shortcut would reach for — is `false` for both, so a refusal written from it
/// would let a card labelled with a bare quote pair through.
#[test]
fn require_title_cleans_like_the_session_namer_and_refuses_an_empty_one() {
    // Every input that survives the chain is ACCEPTED, whatever it becomes —
    // including the ones whose cleaned form this layer no longer sees.
    for raw in [
        "  Porting   the board \n",
        "\"Porting the board\"",
        "'x'",
        "\"a\" and \"b\"",
        "  \" Foo \"  ",
    ] {
        require_title(raw)
            .unwrap_or_else(|e| panic!("{raw:?} is a title and must pass; got {e:?}"));
    }

    for raw in ["", "   ", "\n\t \n", "\"\"", "''"] {
        let err = require_title(raw).expect_err("{raw:?} cleans to nothing and must be refused");
        assert_eq!(err.kind(), "empty_title", "for {raw:?}");
        assert_eq!(err, TasksError::EmptyTitle, "for {raw:?}");
    }
}

/// A Task title is NOT capped, and this asserts the half this layer can still see:
/// a 132-char title is a legal title, so nothing on this path cuts it.
///
/// The assertion that the 132 characters arrive WHOLE in the COLUMN is now
/// `db_create_task_stores_the_cleaned_title`'s — storage is what stores it, and
/// `require_title` returns no string to measure any more. What this one still
/// protects is the refusal side of the same rule: if someone reintroduced the
/// namer's 80-char cut at this call site (`clean_title(raw, Some(80))`), a long
/// title would still pass here, so this test alone cannot catch that. The storage
/// test can, and it is the one the property is really pinned by.
///
/// The cap belongs to the SESSION namer, where it is a pi parity rule
/// (`replace(/\s+/g, " ").trim().replace(quoteRe).slice(0, 80)`) on a title a
/// MODEL invented. A card's title is not that artefact, and the two share the
/// cleaning CHAIN (whitespace collapse, one quote layer) without sharing the cut.
#[test]
fn a_long_task_title_is_kept_whole_and_never_cut_at_the_session_namer_cap() {
    let long = "What is the default action for notifications, i want to be able to click a notification and have it open the session that raised it";
    // 132 chars. Spelled as a literal because `TITLE_MAX_CHARS` lives in the private
    // `mod session` and is deliberately NOT re-exported to satisfy a test; naming.rs
    // pins the constant's VALUE itself.
    assert!(
        long.chars().count() > 80,
        "the fixture must exceed the session namer's 80-char cap or this proves nothing"
    );
    require_title(long).expect("a long title is a VALID title — the cut is not applied here");
}

/// A long title still gets the shared cleaning, and it is the CLEANED form that
/// lands — asserted END TO END through storage, because that is where the clean
/// happens now.
///
/// This is the uncapped-title property re-pointed at the layer that owns it. The
/// fixture is over 80 chars AFTER cleaning, so the two halves of the claim — the
/// chain ran, and the cut did not — are decided by one stored value rather than by
/// a return value no longer handed back.
#[test]
fn an_uncapped_title_still_gets_the_shared_cleaning() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-title-uncapped-", "scratch");
    let db = crate::storage::Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/board-space/uncapped-title";
    let padded = format!("  \"{}   keeps   its  inner spacing\"\n", "a".repeat(100));

    // The pre-flight accepts it, and passes the RAW string down.
    require_title(&padded).expect("a padded long title is a valid title");
    let task = db
        .create_task(space, &padded, None, None)
        .expect("create_task with an uncapped padded title");

    assert!(
        !task.title.starts_with('"') && !task.title.ends_with('"'),
        "one quote layer strips, at storage: {}",
        task.title
    );
    assert!(
        !task.title.contains("   "),
        "whitespace runs collapse, at storage: {}",
        task.title
    );
    assert_eq!(
        task.title.split_whitespace().count(),
        task.title.split(' ').count()
    );
    assert!(
        task.title.chars().count() > 80,
        "and it is still uncapped — the session namer's cut is not applied to cards: {}",
        task.title.chars().count()
    );
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
/// THE SPLIT, and it is not an inconsistency. The `Clear` refusal does stay HERE:
/// the seam maps `None → Keep` and `fulcrum-harness`'s `Option<&str>` is a registry
/// pin, so no wire value a model can send expresses a clear on title — this state is
/// reachable only from an IPC body, which makes it genuinely a rule about the wire. The
/// CLEAN and the EMPTY-REFUSAL have MOVED to `Db::edit_task`, because `tasks` has two
/// doors and a rule with two doors belongs on the path both pass through.
/// `Db::edit_task`'s doc says the same thing from the other side — a `Clear` that
/// slipped past would surface SQLite's constraint as a bare `database` error, which is
/// defence-in-depth and not a nicer answer.
///
/// The three readings, and what each one now does: absent → keep, `""` → refused, a
/// string → passed down RAW for storage to clean once.
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

    // A SET title is passed down UNCHANGED. This assertion flipped when the clean
    // moved to storage, and it is the flip that pins the whole design: the raw text
    // is what reaches `Db`, which cleans it exactly once. "Fixing" this back to
    // `Some("Porting the board")` by re-adding a clean here would restore the
    // double-clean hazard — `clean_title` is not idempotent, so two passes silently
    // rewrite a person's quote-padded title (`a_title_is_cleaned_once_not_twice`).
    let mut set = serde_json::Map::new();
    set.insert(
        "title".to_string(),
        serde_json::Value::String("  Porting   the board  ".to_string()),
    );
    assert_eq!(
        patch_title(&set).expect("a real title is accepted"),
        Some("  Porting   the board  "),
        "the RAW string goes down — storage cleans it once, and this layer must not"
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
/// ONE `.map_err(TasksError::from)` inside [`edit_task_core`]. Delete it and
/// nothing else reddens — a cleared spec path on a deleted card would report a
/// generic failure, the frontend would keep the card on the board (it only drops a
/// card on `not_found`, ADR 0090), and the user would stare at a card that is not
/// there. That is the silent-green shape, and it is the one risk the swap introduces
/// — so the mutation IS tested: replacing that `map_err` with a flattening one turns
/// the last assertion here red (verified: `left: "other"`, right: `"not_found"`).
///
/// Driven through [`edit_task_core`] — the function the command's closure calls —
/// plus the REAL `wire_call`, the way
/// `reorder_tasks_refusals_reach_the_wire_naming_what_was_refused` drives the other
/// flattener: the outer `Ok` stands in for the join succeeding (the arm `board_call`
/// documents as untestable), everything inside is the composition the command runs.
///
/// The core, not a hand-written `db.edit_task(..).map_err(..)`: an earlier shape of
/// this test typed that `map_err` ITSELF, so the very line it existed to protect was
/// a copy rather than the original, and flattening it inside the command left the
/// suite green (review #189). Driving the core means the assertion runs the mapping
/// the wire runs. `tauri::State` and `tauri::ipc::Request` cannot be built in a unit
/// test (the `start_task_session_inner` / `write_artifact_core` reason), and the
/// mock-runtime IPC test that could is `tests/ipc.rs` — `#![cfg(target_os = "linux")]`
/// for the macOS SIGSEGV its own header records — so the core is the seam that is
/// reachable from all three CI legs.
#[test]
fn edit_task_still_reports_a_missing_card_as_not_found_after_the_wire_call_swap() {
    use crate::commands::tasks::{edit_task_core, wire_call};
    use crate::storage::{Db, FieldPatch};

    /// Build the body the way the wire sends it: `taskId` plus whichever fields the
    /// caller named — an absent key is a `Keep` and cannot be spelled here.
    fn body(
        task_id: &str,
        fields: &[(&str, serde_json::Value)],
    ) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        map.insert("taskId".to_string(), serde_json::json!(task_id));
        for (key, value) in fields {
            map.insert((*key).to_string(), value.clone());
        }
        map
    }

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
    let row = wire_call(Ok::<_, String>(edit_task_core(
        &db,
        &body(
            &live.id,
            &[
                ("body", serde_json::Value::Null),
                ("specPath", serde_json::Value::Null),
            ],
        ),
    )))
    .expect("a clear on a live card succeeds");
    assert_eq!(row.body, None, "`body` is NULL");
    assert_eq!(row.spec_path, None, "`spec_path` is NULL");
    assert_eq!(row.title, live.title, "and the kept title is untouched");

    // A clear against a card that is not there: `not_found`, naming the id, through
    // the SAME composition the command's closure runs.
    let err = wire_call(Ok::<_, String>(edit_task_core(
        &db,
        &body("tsk_gone", &[("specPath", serde_json::Value::Null)]),
    )))
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

/// (the title rule keeps the SAME wire envelope on both doors) `BoardError::EmptyTitle`
/// maps onto `TasksError::EmptyTitle` so that the serialized envelope is
/// **byte-identical** to the one the command's own pre-flight produces for the same
/// input — mirroring `the_storage_artifact_refusals_keep_the_command_envelope_exactly`
/// one rule over.
///
/// WHY THIS IS A TEST AND NOT A CLAIM. Storage now enforces the title rule as the
/// backstop for BOTH of its verbs, and the command layer keeps its pre-flight so a bad
/// title spends no worker thread. That split is only safe while the two routes are
/// indistinguishable on the wire: AGENTS.md records that the ADR 0063 envelope has
/// several sites that must all agree, `kind` is what `store/tasks.ts` branches on, and
/// `message` is what `TasksBoard.tsx` renders under `role="alert"`. The two sentences
/// are byte-identical BY REQUIREMENT — a `Display` edit in one family and not the
/// other would put two different messages on the screen for one mistake, and each
/// family was previously pinned only against itself.
///
/// THE ROUTES ACTUALLY DRIVEN are the two real doors. The command's is
/// [`require_title`], the pre-flight the `create_task` command runs before it hops; the
/// storage door is `Db::create_task` / `Db::edit_task` called directly, which is the
/// shape `impl TaskStore for Db` delegates to and therefore the shape the model's
/// `create_task` / `edit_task` TOOL takes. Comparing the built `InvokeError` payloads
/// with `==` rather than merely the `kind` covers `kind` AND the full `message`
/// sentence in one assertion.
///
/// MUTATION: change the `Display` sentence on `BoardError::EmptyTitle` alone and every
/// assertion here reddens on `message` while `kind` stays green — exactly the drift
/// this test exists to catch. Re-spelling the sentence inside the `From` arm instead of
/// mapping variant-to-variant reddens the same way.
#[test]
fn the_storage_title_refusal_keeps_the_command_envelope_exactly() {
    use crate::commands::tasks::edit_task_core;
    use crate::storage::Db;

    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-title-envelope-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/board-space/title-envelope";
    let live = db
        .create_task(space, "a card with a label", None, None)
        .expect("create_task");

    for raw in ["", "   ", "\n\t \n", "\"\"", "''"] {
        // ── the CREATE door ───────────────────────────────────────────────────
        let via_command = require_title(raw).expect_err("the command's pre-flight refuses `{raw}`");
        let command_wire = tauri::ipc::InvokeError::from(via_command.clone()).0;
        let via_storage = TasksError::from(
            db.create_task(space, raw, None, None)
                .expect_err("the storage backstop refuses `{raw}` too"),
        );
        assert!(
            matches!(via_command, TasksError::EmptyTitle),
            "the command route is the title refusal, not something downstream; \
             got {via_command:?}"
        );
        assert!(
            matches!(via_storage, TasksError::EmptyTitle),
            "storage's refusal arrives as `EmptyTitle`, NOT as `Database` (a sqlite \
             complaint) or `Other` (a flattened JoinError); got {via_storage:?}"
        );
        assert_eq!(
            command_wire,
            tauri::ipc::InvokeError::from(via_storage).0,
            "a title refused by storage must reach the wire EXACTLY as one refused by \
             the command — same kind, same sentence (ADR 0063); for {raw:?}"
        );

        // ── the EDIT door, through the core the command's closure calls ───────
        let mut body = serde_json::Map::new();
        body.insert(
            "taskId".to_string(),
            serde_json::Value::String(live.id.clone()),
        );
        body.insert(
            "title".to_string(),
            serde_json::Value::String(raw.to_string()),
        );
        // The command's own pre-flight runs first inside `patch_title`, so the core
        // answers with the SAME `TasksError` the storage door answers with.
        let via_core = edit_task_core(&db, &body)
            .expect_err("the edit door refuses `{raw}` as firmly as the create door");
        assert_eq!(
            command_wire,
            tauri::ipc::InvokeError::from(via_core).0,
            "an EDIT refused for its title carries the same envelope as a CREATE \
             refused for the same title; for {raw:?}"
        );
    }

    // The envelope itself, pinned rather than derived — `empty_title` is the string
    // the board dialog branches on to re-show the title field.
    let envelope = tauri::ipc::InvokeError::from(TasksError::EmptyTitle).0;
    assert_eq!(
        envelope,
        serde_json::json!({"kind": "empty_title", "message": "task title is empty after trimming"}),
        "one kind, one sentence, whichever door caught it"
    );

    assert_eq!(
        db.get_task(&live.id)
            .expect("get_task")
            .expect("the card is still there")
            .title,
        "a card with a label",
        "and none of the refused edits changed the stored label"
    );
    assert_eq!(
        db.list_tasks(space).expect("list_tasks").len(),
        1,
        "five refused creates wrote NOTHING — the only row is the one this test made"
    );
}

/// (the badge's wire shape) The WIRE KEYS of `TaskNumberRow` are pinned as
/// literals: `serde_json::to_value` on a row yields exactly `sessionId`,
/// `stageSlug` and `taskNumber` — the three the frontend's mirror declares.
///
/// The KEYS are the load-bearing half, for the reason `history.rs`'s
/// `session_recency_rows_serializes_to_the_pinned_camel_case_keys` (this test's
/// model) gives: a dropped `#[serde(rename_all = "camelCase")]` changes no field
/// VALUE, so every value assertion on both sides of the wire stays green and the
/// breakage is invisible to the hand-written TypeScript mirror. Only a key
/// literal sees it.
///
/// The list is ALPHABETICAL, and that is the precedent's own discovery rather
/// than a choice: `serde_json::to_value` builds a `BTreeMap`-ordered object (the
/// `preserve_order` feature is off in this crate — `cargo tree -e features` shows
/// no `indexmap`), so the emitted order is sorted and the pin asserts THAT order,
/// exactly as the model does with
/// `["lastActiveAt", "sessionId", "sortOrder"]`. Order is asserted, not a sorted
/// set, because a key that disappears must redden this and not merely reorder.
///
/// The `null` half is the `TaskCardView` pin's rule for `costUsd`, applied to
/// `stageSlug`: a `None` row must serialise the key PRESENT and JSON `null`, so
/// the TS mirror's `stageSlug: string | null` stays true. An `Option` field
/// without a `null` would be absent from the object, and the frontend could not
/// tell "the link carried no stage" from "this Rust build does not send the
/// field at all" — the exact ambiguity ADR 0082's two-meanings rule exists to kill.
#[test]
fn task_number_rows_serializes_to_the_pinned_camel_case_keys() {
    let row = crate::storage::TaskNumberRow {
        session_id: "sess-pin".to_string(),
        task_number: 7,
        stage_slug: Some("research".to_string()),
    };
    let value = serde_json::to_value(&row).expect("TaskNumberRow serializes");
    let keys: Vec<&str> = value
        .as_object()
        .expect("a serialized TaskNumberRow is an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec!["sessionId", "stageSlug", "taskNumber"],
        "the wire keys are exactly the pinned camelCase triple, in the order \
         `serde_json` emits them (a dropped `rename_all` changes no value — only \
         this literal sees it)"
    );
    // The VALUE half, so a mapper wired to the wrong column cannot hide behind
    // three correct key names.
    assert_eq!(value["sessionId"], serde_json::json!("sess-pin"));
    assert_eq!(value["taskNumber"], serde_json::json!(7_i64));
    assert_eq!(value["stageSlug"], serde_json::json!("research"));

    // The `null` half: PRESENT and `null`, never absent.
    let unlinked = crate::storage::TaskNumberRow {
        session_id: "sess-null".to_string(),
        task_number: 1,
        stage_slug: None,
    };
    let value = serde_json::to_value(&unlinked).expect("a stage-less row serializes");
    let object = value
        .as_object()
        .expect("a serialized TaskNumberRow is an object");
    assert!(
        object.contains_key("stageSlug"),
        "`stageSlug` must be PRESENT on a `None` row — an absent key makes the TS \
         mirror's `stageSlug: string | null` a lie the frontend cannot tell apart \
         from a Rust build that never sends the field"
    );
    assert_eq!(
        object["stageSlug"],
        serde_json::Value::Null,
        "and its value is JSON `null`, the one spelling that reaches TS as `null`"
    );
}
