//! Tests for `db/artifacts.rs`: `task_artifacts`' storage half (issue #180 D1,
//! spec §1, ADR 0100) — the key grammar, the 256 KB cap, the upsert, the two
//! refusals `write_artifact` makes because NO foreign key will make them, and the
//! board's keys-only projection.

use crate::storage::db::*;

use super::support::*;

// ── Task artifacts (issue #180, spec §1, ADR 0100) ──────────────────────────
//
// A **Task artifact** is a named markdown document owned by a Task: one row of
// `task_artifacts` keyed `PRIMARY KEY (task_id, key)`. Everything the tests
// below exist to protect follows from two decisions, and each one has a test
// that can actually SEE it:
//
//   - the markdown lives IN the database (ADR 0100: a `docs/roadmap/` file is
//     deleted on ship, so a file-backed artifact is content that dies when the
//     work succeeds), and
//   - the BOARD never carries it. The board payload carries KEYS — names only —
//     so the payload-side test asserts the absence of the content, not merely
//     the presence of the keys. A test that only checks keys are present cannot
//     see a content leak, and that split is the whole design.
//
// There is NO artifact delete, NO versioning, and NO per-artifact metadata
// column, and these tests deliberately do not grow any: a `status` column would
// hand the board a second, contradictory state vocabulary (**Stage** is the only
// state authority), and a delete verb would re-open ADR 0090's amendment item.

/// (`write_artifact`, the UPSERT) two writes to one `(task_id, key)` leave ONE
/// row, the second `markdown` wins, `created_at` SURVIVES and `updated_at` moves.
///
/// `PRIMARY KEY (task_id, key)` is what makes this an overwrite rather than a
/// second card holding a second `spec`, so the row COUNT is a load-bearing
/// assertion, not tidiness. `created_at` surviving is the other one: it is the
/// artifact's age, and a `DO UPDATE SET` list that includes it silently re-dates
/// every artifact the model touches.
///
/// MUTATION (compiles, changes what is returned): add `created_at = \
/// excluded.created_at` to the `DO UPDATE SET` list — the third assertion reddens
/// while the row count and the markdown stay green.
#[test]
fn write_artifact_upserts_one_row_per_key_and_the_second_wins() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-artifact-upsert-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let space = board_space("upsert");
    let task = db
        .create_task(&space, "upsert me", None, None)
        .expect("create");

    let first = db
        .write_artifact(&task.id, "spec", "the first draft")
        .expect("first write");
    assert_eq!(first.key, "spec", "the meta names the key it wrote");
    assert_eq!(
        first.bytes,
        "the first draft".len(),
        "`bytes` is the UTF-8 BYTE length of what was written"
    );

    // now_ms() is millisecond-resolution; a sleep keeps `updated_at > created_at`
    // a fact rather than a coin flip.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let second = db
        .write_artifact(&task.id, "spec", "the second draft, rewritten")
        .expect("second write");
    assert_eq!(
        second.bytes,
        "the second draft, rewritten".len(),
        "the second write's byte count is the SECOND document's"
    );

    let rows = artifact_rows(&path);
    assert_eq!(
        rows.len(),
        1,
        "ONE row per key, ever — a second row would put two `spec`s on one card; \
         got {rows:?}"
    );
    let (row_task, row_key, row_markdown, row_created, row_updated) = &rows[0];
    assert_eq!(row_task, &task.id, "the row is the card's");
    assert_eq!(row_key, "spec", "under the same key");
    assert_eq!(
        row_markdown, "the second draft, rewritten",
        "the second write's markdown wins"
    );
    assert_eq!(
        *row_created, first.updated_at,
        "`created_at` SURVIVES the overwrite — it is the artifact's age, not its \
         last touch (the mutation this test exists for)"
    );
    assert!(
        *row_updated > first.updated_at,
        "`updated_at` moved: {} must be later than {}",
        row_updated,
        first.updated_at
    );
    assert_eq!(
        second.updated_at, *row_updated,
        "and the meta reports the row's own `updated_at`, not a second clock reading"
    );

    // Two DIFFERENT keys are two rows — the PK is the pair, not the key alone.
    db.write_artifact(&task.id, "research", "findings")
        .expect("a second key");
    assert_eq!(
        artifact_rows(&path).len(),
        2,
        "one row per (task_id, key): a Task holds zero or MORE artifacts"
    );
}

/// (`write_artifact`, the gate) a `task_id` with no `tasks` row is refused with
/// `MissingTask` and writes NOTHING.
///
/// This is the refusal ADR 0100 calls out by name: there is no FK to catch a
/// dangling id, so the layer that knows the difference has to say so.
///
/// MUTATION: delete the existence check in `write_artifact` — the error assertion
/// reddens and the row count becomes 1.
#[test]
fn write_artifact_refuses_a_missing_task_and_writes_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-artifact-missing-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.get_board(&board_space("missing")).expect("seed");

    let err = db
        .write_artifact("tsk_missing", "spec", "content for nobody")
        .expect_err("a Task that does not exist must be refused, not written against");
    assert!(
        matches!(err, BoardError::MissingTask(ref id) if id == "tsk_missing"),
        "the refusal names the id it refused; got {err:?}"
    );
    let text = err.to_string();
    assert!(
        text.contains("tsk_missing") && text.contains("no task with id"),
        "the Display sentence is `no task with id {{id}}` and carries the id; got {text}"
    );
    assert_eq!(
        artifact_rows(&path).len(),
        0,
        "a rejection writes NOTHING — the `require_title` rule, at the storage seam"
    );
}

/// (`get_artifact`) asking for something that is not there is an answer, not an
/// error — and BOTH absences answer the same way: a missing key AND a missing
/// Task are `Ok(None)`, the `get_task` shape.
///
/// The READ path never refuses where the WRITE path does. That asymmetry is
/// deliberate (a card's dialog asks "is there a spec?" as an ordinary question)
/// and it is the reason no new `BoardError` variant was needed.
///
/// MUTATION: map `QueryReturnedNoRows` to `Err(e.into())` instead of `None` — the
/// two `Ok(None)` assertions become `Err`s.
#[test]
fn get_artifact_on_a_missing_artifact_is_ok_none() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-artifact-get-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("get");
    let task = db
        .create_task(&space, "read me", None, None)
        .expect("create");

    assert_eq!(
        db.get_artifact(&task.id, "no-such-key").expect("read"),
        None,
        "a missing ARTIFACT is `Ok(None)`"
    );
    assert_eq!(
        db.get_artifact("tsk_missing", "spec").expect("read"),
        None,
        "and a missing TASK answers the same way — the write path refuses, the read \
         path reports absence (the `get_task` shape)"
    );

    db.write_artifact(&task.id, "spec", "# The spec\n\nbody")
        .expect("write");
    let found = db
        .get_artifact(&task.id, "spec")
        .expect("read")
        .expect("the artifact is there now");
    assert_eq!(found.task_id, task.id, "all five fields ride back");
    assert_eq!(found.key, "spec");
    assert_eq!(
        found.markdown, "# The spec\n\nbody",
        "the READ path carries content"
    );
    assert_eq!(
        found.created_at, found.updated_at,
        "a first write is born with both stamps equal"
    );
}

/// (`Db::artifact_keys`) one card's keys, and an empty `Vec` — never an error,
/// never a `None` — for a card with no artifacts.
///
/// MUTATION: return `Vec` of `markdown` instead of `key` — the content appears
/// where a name belongs.
#[test]
fn artifact_keys_lists_one_tasks_keys_and_is_empty_for_none() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-artifact-keys-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("keys");
    let with = db
        .create_task(&space, "has artifacts", None, None)
        .expect("create");
    let without = db
        .create_task(&space, "has none", None, None)
        .expect("create");

    db.write_artifact(&with.id, "spec", "one").expect("write");
    db.write_artifact(&with.id, "research", "two")
        .expect("write");

    assert_eq!(
        db.artifact_keys(&with.id).expect("keys"),
        vec!["spec".to_string(), "research".to_string()],
        "the keys, oldest write first (the `Db::task_sessions` order)"
    );
    assert_eq!(
        db.artifact_keys(&without.id).expect("keys"),
        Vec::<String>::new(),
        "no artifacts is an empty list, not an error and not a None"
    );
}

/// (`get_board`, the payload) every card carries its own artifact KEYS, and a
/// card with none carries `[]`.
///
/// The other two fields are re-asserted here on purpose: the artifact SELECT is a
/// FOURTH statement under the SAME lock as the #174 links read, and a mistake in
/// how the rows are grouped would disturb the sessions/cost payload too.
///
/// MUTATION: drop the `artifact_keys` value from the `TaskCardView` construction
/// (compile error) or filter on the wrong tuple element — the second card's keys
/// appear on the first card.
#[test]
fn get_board_returns_each_card_with_its_artifact_keys_and_empty_for_none() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-artifacts-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("board-keys");
    db.get_board(&space).expect("seed");
    let first = db
        .create_task(&space, "documented", None, None)
        .expect("create");
    let second = db
        .create_task(&space, "undocumented", None, None)
        .expect("create");

    db.write_artifact(&first.id, "spec", "the spec")
        .expect("write");
    db.write_artifact(&first.id, "research", "the finding")
        .expect("write");

    let cards = board_cards(&db, &space);
    assert_eq!(cards.len(), 2, "two cards on this board");
    let first_card = cards
        .iter()
        .find(|card| card.task.id == first.id)
        .expect("the first card");
    let second_card = cards
        .iter()
        .find(|card| card.task.id == second.id)
        .expect("the second card");

    assert_eq!(
        first_card.artifact_keys,
        vec!["spec".to_string(), "research".to_string()],
        "the card that HAS artifacts carries both keys"
    );
    assert_eq!(
        second_card.artifact_keys,
        Vec::<String>::new(),
        "the card with none carries `[]` — a REQUIRED field, so it is present and \
         empty rather than absent"
    );
    for card in [&first_card, &second_card] {
        assert!(
            card.sessions.is_empty(),
            "the artifact read did not disturb the #174 sessions payload: {:?}",
            card.sessions
        );
        assert_eq!(
            card.cost_usd, None,
            "…nor the cost (`None`, never `Some(0.0)` — ADR 0082)"
        );
    }
}

/// (spec §1, the split's whole point) the board payload carries the artifact
/// KEYS and NOT ONE BYTE of the markdown.
///
/// This is the test the key-presence assertions CANNOT substitute for: a payload
/// that lists `spec` AND ships the document passes every "are the keys there?"
/// assertion. So the sentinel is asserted absent from the SERIALIZED payload,
/// while the key is asserted present in the same payload.
///
/// MUTATION: add `markdown` to the board's artifact SELECT and put it in the
/// card — the keys stay green and this test reddens. That is the leak.
#[test]
fn the_board_payload_carries_keys_only_never_the_markdown() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-nocontent-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("no-content");
    db.get_board(&space).expect("seed");
    let task = db
        .create_task(&space, "leaky board", None, None)
        .expect("create");

    const SENTINEL: &str = "TOP-SECRET-SENTINEL-9f3a1c-do-not-ship-this-to-the-board";
    db.write_artifact(&task.id, "spec", SENTINEL)
        .expect("write an artifact whose content is unmistakable");

    let board = db.get_board(&space).expect("get_board");
    let json = serde_json::to_string(&board).expect("the board serializes");
    assert!(
        !json.contains(SENTINEL),
        "the board payload must carry NO artifact content — a payload that ships the \
         markdown makes the keys-only split a lie. Found the sentinel in {json}"
    );
    let cards = board_cards(&db, &space);
    assert_eq!(
        cards[0].artifact_keys,
        vec!["spec".to_string()],
        "…while the NAME does ride along, which is what makes the assertion above a \
         leak test rather than an empty-payload test"
    );
}

/// (`artifact_keys_for_space`) the keys are scoped by `task_id IN (SELECT id
/// FROM tasks WHERE space_path = ?1)` — a card of ANOTHER Space contributes
/// none, in either direction.
///
/// The scoping question is "whose card is this", and only `task_id` answers it
/// (the #174 links comment, restated): a `cwd` filter would drop a card whose
/// Space is not a directory and pull in a neighbour's.
///
/// MUTATION: drop the `IN (SELECT …)` subquery so the statement scans the whole
/// table — Space B's key appears in Space A's answer and vice versa.
#[test]
fn artifact_keys_for_space_is_scoped_to_the_space() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-artifact-scope-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = board_space("scope-a");
    let b = board_space("scope-b");
    db.get_board(&a).expect("seed a");
    db.get_board(&b).expect("seed b");
    let task_a = db.create_task(&a, "in A", None, None).expect("create");
    let task_b = db.create_task(&b, "in B", None, None).expect("create");

    db.write_artifact(&task_a.id, "a-only-key", "A content")
        .expect("write");
    db.write_artifact(&task_b.id, "b-only-key", "B content")
        .expect("write");

    let keys_a = db.artifact_keys_for_space(&a).expect("keys for A");
    let keys_b = db.artifact_keys_for_space(&b).expect("keys for B");
    assert_eq!(
        keys_a,
        vec![(task_a.id.clone(), vec!["a-only-key".to_string()])],
        "Space A's answer is A's card and A's key, and nothing else"
    );
    assert_eq!(
        keys_b,
        vec![(task_b.id.clone(), vec!["b-only-key".to_string()])],
        "and the same holds for B — the scoping is symmetric, not a filter that \
         happens to work in one direction"
    );
    // The shape itself is the no-content guarantee for this method: a `String`
    // key list has nowhere to put a document.
    assert!(
        !keys_a
            .iter()
            .flat_map(|(_, keys)| keys.iter())
            .any(|k| k.contains("A content")),
        "keys only, by shape"
    );

    // An empty Space answers `vec![]`, not an error.
    assert_eq!(
        db.artifact_keys_for_space("/board-space/scope-empty")
            .expect("an empty space is an answer"),
        Vec::<(String, Vec<String>)>::new(),
        "a Space with no cards has no keys"
    );
}

/// (ADR 0090, one level down) closing a Space tab leaves the artifact rows in
/// place — the same survival `delete_space_leaves_the_board_rows_in_place` pins
/// for the card, now for the document the card owns.
///
/// MUTATION: add `REFERENCES tasks(id) ON DELETE CASCADE` to the DDL and a
/// `DELETE FROM task_artifacts` to `delete_space` — the count drops to 0.
#[test]
fn delete_space_leaves_the_artifact_rows_in_place() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-artifact-orphan-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let space = board_space("tab-close");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed the stages");
    let task = db
        .create_task(&space, "survive the tab close", None, None)
        .expect("create");
    db.write_artifact(&task.id, "spec", "the finding the research session wrote")
        .expect("write");

    db.delete_space(&space)
        .expect("delete_space (a tab close deletes from `spaces` alone)");
    assert!(
        db.find_space(&space).expect("find_space").is_none(),
        "the Space row is gone — that is what a tab close does"
    );

    let rows = artifact_rows(&path);
    assert_eq!(
        rows.len(),
        1,
        "ADR 0090: the artifact SURVIVES the tab close — a document that died \
         because a folder was closed is the bug this table exists to prevent; \
         got {rows:?}"
    );
    assert_eq!(rows[0].2, "the finding the research session wrote");
    assert_eq!(
        db.get_artifact(&task.id, "spec")
            .expect("get_artifact")
            .expect("the artifact is still readable"),
        Artifact {
            task_id: task.id.clone(),
            key: "spec".to_string(),
            markdown: "the finding the research session wrote".to_string(),
            created_at: rows[0].3,
            updated_at: rows[0].4,
        },
        "and it reads back through the same path, unchanged"
    );
}

/// (why the gate is load-bearing, pinned at the SQL level) SQLite does NOT
/// reject a dangling `task_id` — the table has no FK — so the ONLY thing between
/// a dangling artifact and the database is the gate in `write_artifact`.
///
/// This test asserts the HOLE, not the protection (#3 above pins the
/// protection). It exists so a future reader does not "simplify" the gate away
/// on the assumption that the schema would catch it anyway.
///
/// MUTATION: add `REFERENCES tasks(id)` to the DDL and this direct INSERT starts
/// failing — which is the point: the schema would then be doing what the gate
/// does, and ADR 0090's no-cascade rule would be broken to get there.
#[test]
fn write_artifact_refuses_a_dangling_task_id_there_is_no_fk_to_catch_it() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-artifact-dangling-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.get_board(&board_space("dangling")).expect("seed");

    // The gate refuses…
    db.write_artifact("tsk_never_existed", "spec", "orphan")
        .expect_err("the gate refuses a Task that is not there");

    // …but the SCHEMA would have accepted it. Foreign keys are ON in this
    // database (`Db::open` turns the pragma on — the reason `link_session` can
    // rely on the `sessions` FK), so a successful insert here is proof about the
    // DDL, not about a pragma left off.
    let conn = rusqlite::Connection::open(&path).expect("an independent connection");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("turn the FK enforcement ON for this connection too");
    let inserted = conn.execute(
        "INSERT INTO task_artifacts (task_id, key, markdown, created_at, updated_at) \
         VALUES ('tsk_never_existed', 'spec', 'orphan', 1, 1)",
        [],
    );
    assert_eq!(
        inserted.expect("the statement is valid SQL against this DDL"),
        1,
        "the INSERT SUCCEEDS with FK enforcement on — there is no FK to catch it"
    );
    assert!(
        db.get_task("tsk_never_existed")
            .expect("get_task")
            .is_none(),
        "…and the row now dangles: no `tasks` row owns it"
    );
    assert_eq!(
        artifact_rows(&path).len(),
        1,
        "so the dangling row EXISTS in the database, written by the caller that the \
         gate turned away. This is what removing the gate would let through."
    );
}
