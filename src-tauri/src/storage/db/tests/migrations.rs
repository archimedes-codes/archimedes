//! Tests for `db/migrations.rs`: the one-time `todos_json` backfill, the two
//! `sort_order` seeds (ADR 0073, ADR 0075), and the `sessions.is_subagent`
//! gate's arrival value.
//!
//! The data steps are the sibling half of a gate — `gate` commits the `ALTER` and
//! the data step as ONE transaction — so these tests are about re-open behaviour:
//! a seed that ran twice would duplicate the ADR 0075 numbers.
//!
//! The `is_subagent` test sits here rather than in [`super::open`], where the
//! other per-column gate tests live, for a size reason and a subject reason:
//! `open.rs` is the largest un-ledgered child in this tree and the derivation
//! added to it, and this file is the one whose subject is "what the gate's data
//! step leaves behind" — which is exactly what `is_subagent`'s `DEFAULT 0`
//! assertion is.

use crate::storage::db::*;

use super::support::*;

#[test]
fn legacy_db_migration_backfills_newest_non_read_todos_once() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-todos-backfill-", "scratch");
    let path = dir.join("t.db");

    // Pre-migration DB: WITHOUT todos_json
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            context_usage_json TEXT,
            is_subagent INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            message_key TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, kind, message_key)
        );
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        CREATE TABLE spaces (
            path TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            trusted INTEGER NOT NULL DEFAULT 0
        );",
    )
    .unwrap();

    // Main session s1, subagent session s_child, empty session s_empty
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) VALUES ('s1', '/tmp', 1, '{}', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) VALUES ('s_child', '/tmp', 1, '{}', 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) VALUES ('s_empty', '/tmp', 1, '{}', 0)",
        [],
    )
    .unwrap();

    // For s1:
    // (1) oldest write with task1
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (1, 's1', 'tool-call', 'tc1', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"task1\",\"status\":\"pending\"}]}}', 1)",
        [],
    )
    .unwrap();
    // (2) newer with operation: 'read'
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (2, 's1', 'tool-call', 'tc2', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"read\",\"todoList\":[]}}', 2)",
        [],
    )
    .unwrap();
    // (3) newest write with task2
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (3, 's1', 'tool-call', 'tc3', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"task2\",\"status\":\"in_progress\",\"description\":\"d2\"}]}}', 3)",
        [],
    )
    .unwrap();
    // (4) malformed payload_json row
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (4, 's1', 'tool-call', 'tc4', 'not valid json at all { manage_todo_list', 4)",
        [],
    )
    .unwrap();

    // For s_child: write row
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (5, 's_child', 'tool-call', 'tc_c', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"child_task\",\"status\":\"pending\"}]}}', 5)",
        [],
    )
    .unwrap();

    drop(conn);

    // Open via Db::open: Db::open succeeds despite the malformed row
    let db = Db::open(&path).expect("Db::open should succeed");

    // s1 holds task2 (the newest non-read write)
    let s1_todos = db
        .session_todos("s1")
        .expect("session_todos should succeed");
    assert!(s1_todos.is_some(), "s1 should have backfilled todos");
    let val: serde_json::Value = serde_json::from_str(&s1_todos.unwrap()).unwrap();
    assert_eq!(
        val,
        serde_json::json!([{"content":"task2","status":"in_progress","description":"d2"}])
    );

    // s_child's session_todos is None (subagents never backfilled)
    assert_eq!(db.session_todos("s_child").unwrap(), None);

    // s_empty ends with todos_json == None
    assert_eq!(db.session_todos("s_empty").unwrap(), None);

    // Mutate s1's todos_json with a sentinel
    db.record_session_todos("s1", Some("sentinel")).unwrap();
    drop(db);

    // Re-open Db::open(&path): assert the sentinel survived (proves backfill does NOT re-run)
    let db2 = Db::open(&path).expect("re-open should succeed");
    assert_eq!(
        db2.session_todos("s1").unwrap(),
        Some("sentinel".to_string())
    );
}

/// (sort_order) A FRESH database gains the column from `SCHEMA` alone —
/// no migration runs (the pragma gate in `Db::open` skips it).
#[test]
fn sort_order_columns_exist_on_a_fresh_database() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortfresh-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let conn = db.conn.lock().expect("db mutex poisoned");
    for table in ["spaces", "sessions"] {
        let has: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'sort_order'"
                ),
                [],
                |row| row.get(0),
            )
            .expect("pragma query should succeed");
        assert_eq!(
            has, 1,
            "a fresh database has sort_order on {table} straight from SCHEMA"
        );
    }
    drop(conn);
}

/// (sort_order) A pre-existing database is seeded in the order the user
/// was ALREADY looking at for spaces: `last_opened_at DESC, path ASC`.
/// The assertion pins BOTH halves of that read order — `/x/b` leads on
/// recency, and `/x/a` beats `/x/c` on the `path ASC` tie-break at a tied
/// timestamp. No `sessions` rows are inserted, so the phase-11 space
/// backfill cannot add rows and pollute the assertion.
///
/// The fixture is `SCHEMA_WITHOUT_SPACE_SORT_ORDER`: `spaces` lacks
/// `sort_order` (the gate under test) while `sessions` — empty here —
/// already CARRIES its own `sort_order`, so the SESSION seed stays silent and
/// this test observes the space seed alone. (The shared
/// `create_pre_sort_order_db` omits BOTH columns, which would run both seeds
/// here — that is exactly why it does not serve this test.)
#[test]
fn sort_order_seeded_in_the_old_space_order_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortspace-test-", "scratch");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_SPACE_SORT_ORDER,
        "INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/b', 1, 3000);
         INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/a', 1, 2000);
         INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/c', 1, 2000);",
    );

    let db = Db::open(&path).expect("the sort_order seed must not brick startup");
    // The column is in place (the gate's own ALTER), like every other gate test
    // in this cluster asserts.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('spaces') WHERE name = 'sort_order'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the spaces.sort_order column is in place after the migration"
    );
    let paths: Vec<String> = raw_column(
        &db,
        "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC",
    );
    assert_eq!(
        paths,
        vec!["/x/b", "/x/a", "/x/c"],
        "the seed numbers the spaces in the OLD display order \
         (last_opened_at DESC, then path ASC on a tied timestamp)"
    );
    // The ADR 0075 NUMBERS themselves, not just their order: the seed writes
    // 0-based positions in that read order, so a seed that numbered correctly
    // but started at 1 (or counted in the wrong direction) fails HERE even if a
    // future ORDER BY happened to forgive it.
    assert_eq!(
        (
            sort_order_of(&db, "spaces", "path", "/x/b"),
            sort_order_of(&db, "spaces", "path", "/x/a"),
            sort_order_of(&db, "spaces", "path", "/x/c"),
        ),
        (0, 1, 2),
        "the space seed numbers the rows 0, 1, 2 in the old display order"
    );
    // ...and a SECOND open is a clean no-op: the pragma gate is closed, so the
    // seed does not re-run and cannot renumber the rows.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the seeded db must succeed");
    assert_eq!(
        (
            sort_order_of(&db, "spaces", "path", "/x/b"),
            sort_order_of(&db, "spaces", "path", "/x/a"),
            sort_order_of(&db, "spaces", "path", "/x/c"),
        ),
        (0, 1, 2),
        "the re-open does not re-run the space seed — the numbers are untouched"
    );
    // Isolation, asserted rather than assumed: the numbers came from the SPACE
    // seed alone (the session gate never ran — its column was already there).
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM sessions"),
        0,
        "the fixture stayed spaces-only, so no session seed could have moved \
         anything this test reads"
    );
}

/// (sort_order) A pre-existing database is seeded in the order the user
/// was ALREADY looking at for sessions: last activity (the `COALESCE`
/// expression) then `id DESC`. That order is neither `id DESC` alone nor
/// `created_at DESC` alone, so the assertion pins the whole expression.
///
/// The fixture is `SCHEMA_WITHOUT_SESSION_SORT_ORDER`: `sessions` lacks
/// `sort_order` (the gate under test) while `spaces` — empty here — already
/// CARRIES its own, so the SPACE seed stays silent and this test observes the
/// session seed alone.
#[test]
fn sort_order_seeded_in_the_old_session_order_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortsess-test-", "scratch");
    // A cwd that does not exist on disk: the phase-11 space backfill skips
    // it, so the fixture stays about sessions only.
    // The OLDEST-created session (`s_old_used`) is the most recently USED one.
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_SESSION_SORT_ORDER,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_old_used', '/x/nope-not-a-folder', 1000, '{}', 0);
         INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_stale', '/x/nope-not-a-folder', 2000, '{}', 0);
         INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_fresh', '/x/nope-not-a-folder', 3000, '{}', 0);
         INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
         VALUES ('s_old_used','user',NULL,'{}',9999);",
    );

    let db = Db::open(&path).expect("the sort_order seed must not brick startup");
    // The column is in place (the gate's own ALTER), like every other gate test
    // in this cluster asserts.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'sort_order'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the sessions.sort_order column is in place after the migration"
    );
    let ids: Vec<String> = raw_column(
        &db,
        "SELECT id FROM sessions ORDER BY sort_order ASC, id DESC",
    );
    assert_eq!(
        ids,
        vec!["s_old_used", "s_fresh", "s_stale"],
        "the seed numbers the sessions in the OLD display order \
         (last activity DESC, then id DESC)"
    );
    // The ADR 0075 NUMBERS themselves, not just their order (the space twin
    // above pins the same shape): the seed writes 0-based positions.
    assert_eq!(
        (
            sort_order_of(&db, "sessions", "id", "s_old_used"),
            sort_order_of(&db, "sessions", "id", "s_fresh"),
            sort_order_of(&db, "sessions", "id", "s_stale"),
        ),
        (0, 1, 2),
        "the session seed numbers the rows 0, 1, 2 in the old display order"
    );
    // ...and a SECOND open is a clean no-op: the pragma gate is closed, so the
    // seed does not re-run and cannot renumber the rows.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the seeded db must succeed");
    assert_eq!(
        (
            sort_order_of(&db, "sessions", "id", "s_old_used"),
            sort_order_of(&db, "sessions", "id", "s_fresh"),
            sort_order_of(&db, "sessions", "id", "s_stale"),
        ),
        (0, 1, 2),
        "the re-open does not re-run the session seed — the numbers are untouched"
    );
    // Isolation, asserted rather than assumed: the fixture seeded no space
    // rows and every cwd is uncanonicalizable, so the space seed had nothing to
    // number and the backfill had nothing to insert.
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM spaces"),
        0,
        "no space row exists, so the space seed could not have influenced \
         anything this test reads"
    );
}

/// (sort_order) The seed is GATED, not merely idempotent: after the first
/// open the pragma gate is closed, so a re-open never rewrites the
/// numbers. The sentinel idiom from
/// `legacy_db_migration_backfills_newest_non_read_todos_once`.
#[test]
fn sort_order_seed_does_not_rerun_on_reopen() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortonce-test-", "scratch");
    let path = dir.join("t.db");
    create_pre_sort_order_db(&path);
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    conn.execute(
        "INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/a', 1, 1000)",
        [],
    )
    .expect("fixture space row");
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_a', '/x/nope-not-a-folder', 1, '{}', 0)",
        [],
    )
    .expect("fixture session row");
    drop(conn);

    let db = Db::open(&path).expect("first open should seed the column");
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        conn.execute(
            "UPDATE spaces SET sort_order = 4242 WHERE path = ?1",
            params!["/x/a"],
        )
        .expect("sentinel space write");
        conn.execute(
            "UPDATE sessions SET sort_order = 77 WHERE id = ?1",
            params!["s_a"],
        )
        .expect("sentinel session write");
    }
    drop(db);

    let db = Db::open(&path).expect("re-open of the migrated db must succeed");
    let conn = db.conn.lock().expect("db mutex poisoned");
    let space_value: i64 = conn
        .query_row(
            "SELECT sort_order FROM spaces WHERE path = ?1",
            params!["/x/a"],
            |row| row.get(0),
        )
        .expect("read the space sentinel");
    let session_value: i64 = conn
        .query_row(
            "SELECT sort_order FROM sessions WHERE id = ?1",
            params!["s_a"],
            |row| row.get(0),
        )
        .expect("read the session sentinel");
    assert_eq!(
        space_value, 4242,
        "the seed gate is closed on the second open, so the space sentinel survives"
    );
    assert_eq!(
        session_value, 77,
        "the seed gate is closed on the second open, so the session sentinel survives"
    );
}

/// (hazard H1) The seed renumbers EVERY session row, hidden subagent rows
/// included — no `WHERE`. `MAX + 1` is global and `ensure_session_row`
/// routes subagent rows through `record_session`, so a hidden row already
/// consumes a number: seeding only the visible rows would duplicate
/// values and tie them with the visible row at 0.
#[test]
fn sort_order_seed_numbers_subagent_rows_too() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortsub-test-", "scratch");
    let path = dir.join("t.db");
    create_pre_sort_order_db(&path);
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    for (id, is_subagent) in [("s_main_1", 0_i64), ("s_main_2", 0), ("s_sub", 1)] {
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
             VALUES (?1, '/x/nope-not-a-folder', 1, '{}', ?2)",
            params![id, is_subagent],
        )
        .expect("fixture session row");
    }
    drop(conn);

    let db = Db::open(&path).expect("the seed must number hidden rows too");
    let conn = db.conn.lock().expect("db mutex poisoned");
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .expect("count sessions");
    let distinct: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT sort_order) FROM sessions",
            [],
            |row| row.get(0),
        )
        .expect("count distinct sort_order");
    let at_zero: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE sort_order = 0",
            [],
            |row| row.get(0),
        )
        .expect("count rows at sort_order 0");
    assert_eq!(total, 3, "three fixture rows are stored");
    assert_eq!(
        distinct, 3,
        "every row (the hidden subagent row included) got its own number"
    );
    assert_eq!(
        at_zero, 1,
        "exactly one row sits at 0 — no tie with the hidden row"
    );
}

/// (fulcrum#20 prerequisite, spec §7 step 4) The ADR 0073 todos backfill matches
/// BOTH tool names, permanently.
///
/// `manage_todo_list` is frozen (ADR 0093) because the predicate below reads it
/// out of rows ALREADY WRITTEN in users' databases. When fulcrum#20 renames the
/// tool to `manage_checklist`, new rows arrive under the new spelling — and a
/// predicate that names only the old one backfills NOTHING for them: the
/// Checklist comes up empty after an upgrade, the migration reports success, and
/// no error is raised. That is the silent data loss ADR 0093 was written about,
/// and it is why this widening must RELEASE BEFORE the tag bump that carries the
/// rename.
///
/// Both literal sites are pinned here, because widening only one is the trap:
/// the SQL `LIKE` is the pre-filter and the JSON `title` comparison is the real
/// match. Widen only the SQL and the JSON arm skips every checklist row; widen
/// only the JSON and the SQL pre-filter never returns it. The two rows below are
/// deliberately in DIFFERENT sessions so a one-sided widening fails on one of
/// them rather than passing on an accident.
#[test]
fn legacy_db_migration_backfills_both_manage_todo_list_and_manage_checklist() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-checklist-backfill-", "scratch");
    let path = dir.join("t.db");

    // Pre-migration DB WITHOUT `todos_json` — the same fixture shape
    // `legacy_db_migration_backfills_newest_non_read_todos_once` uses, so this
    // test drives the real `Db::open` gate + backfill and not a helper.
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            context_usage_json TEXT,
            is_subagent INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            message_key TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, kind, message_key)
        );
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        CREATE TABLE spaces (
            path TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            trusted INTEGER NOT NULL DEFAULT 0
        );",
    )
    .unwrap();
    let insert_session = |id: &str| {
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
             VALUES (?1, '/tmp', 1, '{}', 0)",
            [id],
        )
        .unwrap();
    };
    insert_session("s_old");
    insert_session("s_new");
    insert_session("s_new_read");

    // The OLD spelling, in its own session.
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) \
         VALUES (1, 's_old', 'tool-call', 'tc_old', \
         '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"old task\",\"status\":\"pending\"}]}}', 1)",
        [],
    ).unwrap();
    // The NEW spelling, in a DIFFERENT session — this is the row a one-sided
    // widening loses, and losing it is silent.
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) \
         VALUES (2, 's_new', 'tool-call', 'tc_new', \
         '{\"title\":\"manage_checklist\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"checklist task\",\"status\":\"in_progress\"}]}}', 2)",
        [],
    ).unwrap();
    // The NEW spelling with `operation: "read"` — the read-skip rule must survive
    // the widening, or a read would overwrite a real write.
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) \
         VALUES (3, 's_new_read', 'tool-call', 'tc_read', \
         '{\"title\":\"manage_checklist\",\"rawInput\":{\"operation\":\"read\",\"todoList\":[]}}', 3)",
        [],
    ).unwrap();
    drop(conn);

    let db = Db::open(&path).expect("Db::open should succeed");

    let old = db.session_todos("s_old").expect("session_todos").expect(
        "the OLD spelling still backfills — the widening is a widen, not a replace; \
         dropping it is the same data loss arriving from the other side",
    );
    assert!(
        old.contains("old task"),
        "s1 keeps its manage_todo_list backfill; got {old}"
    );

    let new = db
        .session_todos("s_new")
        .expect("session_todos")
        .expect("the manage_checklist row must backfill too (fulcrum#20)");
    assert!(
        new.contains("checklist task"),
        "a manage_checklist write backfills exactly like a manage_todo_list one; got {new}"
    );

    assert_eq!(
        db.session_todos("s_new_read").expect("session_todos"),
        None,
        "the operation:read skip applies to the NEW name too — widening the match \
         must not widen what counts as a write"
    );
}

/// (the frozen names stay frozen) the widening adds a SECOND literal; it renames
/// nothing. `manage_todo_list` must still appear in the predicate, or every
/// pre-rename install loses its Checklist — ADR 0093's whole point.
#[test]
fn backfill_predicate_names_both_literals_and_renames_nothing() {
    // Reads `db/migrations.rs`, the sibling the ADR 0113 split moved the backfill
    // into. THE SLICE IS SCOPED BY `"\npub(super) fn "`, MEASURED, not guessed:
    // this file holds exactly THREE items and all three are `pub(super) fn` at
    // column 0, so `"\nfn "` — the delimiter this pin used while the code still
    // lived in the single `db.rs` — occurs ZERO times here and the slice silently
    // ran to end of file (6,736 of 8,307 chars: the backfill body PLUS both seed
    // functions PLUS the `///` doc comments above them — 17 `///` lines in the
    // slice against the body's own 7). It did NOT include the module doc comment:
    // `//!` occurs ZERO times in that slice, the module doc sits above the first
    // item and the slice starts inside `backfill_session_todos`. What it graded was
    // 81% of the file instead of the body. It worked at base only because the old
    // `db.rs` held ~20 column-0 `fn` items, and the next one after
    // `backfill_session_todos` happened to terminate the body there. The boundary is
    // asserted below so the next move fails LOUDLY instead of silently widening again.
    let source = include_str!("../migrations.rs");
    let fn_body = source
        .split("fn backfill_session_todos")
        .nth(1)
        .expect("the backfill function")
        .split("\npub(super) fn ")
        .next()
        .expect("the backfill body");
    // THE BOUNDARY ASSERTION — and it is written so that it CAN fail, which the
    // version it replaces could not. That one read
    // `assert!(!fn_body.contains("\npub(super) fn "))`, and `fn_body` is produced BY
    // `.split("\npub(super) fn ").next()`: the text before the first separator can
    // not contain that separator, so the assertion held on every possible input,
    // including the widened 6,736-char slice it was there to catch. A pin that
    // passes on the broken thing is worse than no pin.
    //
    // THIS ONE HAS TEETH, both halves measured at this commit: the correct 4,824-char
    // body contains NO `"fn "` at all (it is one function's statements — the SQL, the
    // loop, the two literals), while the widened 6,736-char slice contains it, because
    // what it swallowed was two further `pub(super) fn` declarations. So reverting the
    // delimiter to the old `"\nfn "` turns this assertion RED rather than leaving it
    // quietly true, which is the whole job of a boundary check.
    //
    // It is deliberately blunt: a nested `fn` added INSIDE the backfill body would
    // trip it too. That is the accepted cost, not an oversight — a body that has grown
    // an item of its own is exactly the moment the delimiter deserves a second look, and
    // the right response is to re-measure the slice and widen this assertion ON PURPOSE,
    // never to delete it. (Asserting instead that the slice ENDS on `}` was tried and is
    // wrong: the body runs to the separator, so it ends on the next item's `///` doc
    // line, not on a brace.)
    assert!(
        !fn_body.contains("fn "),
        "the slice escaped `backfill_session_todos` and ran into the next item — \
         the body terminator matched nothing, so the pin below would be grading a \
         whole file instead of a body (a body of ONE function contains no `fn `)"
    );
    assert!(
        !fn_body.contains("seed_space_sort_order"),
        "the slice is the backfill body alone — the seed siblings must not be in it"
    );
    assert!(
        fn_body.contains("manage_todo_list"),
        "the OLD literal must stay in the predicate — rows already written under it \
         are never rewritten (ADR 0093)"
    );
    assert!(
        fn_body.contains("manage_checklist"),
        "the NEW literal must be there too, permanently (fulcrum#20)"
    );
    // BOTH sites, counted rather than eyeballed: the SQL pre-filter and the JSON
    // title comparison. One of the two is the trap the other cannot cover.
    assert!(
        fn_body.contains("payload_json LIKE '%manage_todo_list%'")
            && fn_body.contains("payload_json LIKE '%manage_checklist%'"),
        "the SQL pre-filter must LIKE both names"
    );
    assert!(
        fn_body.contains("Some(\"manage_todo_list\")")
            || fn_body.contains("\"manage_todo_list\" |"),
        "the JSON title comparison must still accept the old name"
    );
    assert!(
        fn_body.contains("\"manage_checklist\"") || fn_body.contains("| \"manage_checklist\""),
        "the JSON title comparison must accept the new name too"
    );
    // `todos_json` is the third frozen name (a COLUMN) and this task never touches
    // a gate or a column name. TWO READ TARGETS, because the two halves of the risk
    // live in two files: the predicate this pin just scoped lives in `migrations.rs`
    // and the FROZEN DDL — the one place a rename could actually be written — is the
    // `SCHEMA` const, which `db/mod.rs` kept when the split moved the data steps
    // here. The first arm says no migration renames the column; the second is the
    // arm that carries the ADR 0093 weight. Reading only `migrations.rs` (what the
    // split left behind) let a rename inside `SCHEMA` pass the whole lib suite: the
    // behavioural tests stayed green because `db/mod.rs`'s gate re-adds the column
    // by `ALTER TABLE`, so this source-text arm was the ONLY guard.
    assert!(
        !source.contains("checklist_json"),
        "no migration step may rename the column (ADR 0093)"
    );
    assert!(
        !SCHEMA.contains("checklist_json"),
        "sessions.todos_json is FROZEN (ADR 0093) — no column rename here"
    );
}

/// (the `is_subagent` gate) a pre-existing database whose `sessions` table
/// predates the `is_subagent` column must open CLEANLY, and EVERY pre-existing
/// row must arrive with the flag OFF.
///
/// THIS PIN EXISTS BECAUSE THE GATE HAD NO ASSERTION AT ALL. Measured before it
/// was written: no test anywhere asserted anything about this gate's outcome. The
/// column was merely ABSENT from several other fixtures' `CREATE TABLE sessions`,
/// so the `ALTER` ran as an unasserted side effect of someone else's test and
/// nothing read the result. `each_cluster_schema_omits_exactly_one_gated_column`
/// records that finding per column; this is the one of the four it names that was
/// genuinely uncovered rather than covered elsewhere.
///
/// `false` — not `true` — is the load-bearing half, and the consequence of
/// getting it backwards is the whole session list vanishing. `list_sessions`
/// filters `is_subagent = 0`, so a column that arrived `1` (or a gate that
/// backfilled `1`) would hide every session a person already had on the launch
/// after they upgraded — ADR 0025 §6's "no data migration" is exactly this
/// decision, and `dflt_value` is pinned below for the same reason the
/// `prompt_prefix` and auto-guard pins exist: the `!s.is_subagent` assertions
/// would ALSO pass under a `DEFAULT 1` plus a `UPDATE … = 0` backfill, so without
/// the `dflt_value` arm a later "improvement" could invert the migration's meaning
/// and stay green.
///
/// The fixture is `SCHEMA_WITHOUT_IS_SUBAGENT`: every OTHER gated column is
/// present, so the sibling gates stay silent and this test observes its own gate.
///
/// WHY THIS SITE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
/// the lock guards `Db`'s ONE shared `rusqlite::Connection` — a single, shared
/// resource a panic mid-transaction can leave genuinely unusable — so this
/// `.expect` panics rather than recovering, matching every other site in this
/// tree; the worked example to cite is the production `record_messages_batch`.
#[test]
fn the_is_subagent_gate_arrives_zero_for_every_pre_existing_session() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-subagent-gate-", "scratch");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_IS_SUBAGENT,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/x/nope-not-a-folder', 1, '{}');\n\
         INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s2', '/x/nope-not-a-folder', 2, '{}');\n",
    );

    {
        let db = Db::open(&path).expect("the is_subagent gate runs on open");
        let has: i64 = db
            .conn
            .lock()
            .expect("db mutex poisoned")
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'is_subagent'",
                [],
                |row| row.get(0),
            )
            .expect("pragma_table_info should read");
        assert_eq!(
            has, 1,
            "the `is_subagent` column is in place after the gate"
        );

        // The DDL's DEFAULT, pinned directly rather than inferred from the reads.
        let default_value: Option<String> = db
            .conn
            .lock()
            .expect("db mutex poisoned")
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('sessions') WHERE name = 'is_subagent'",
                [],
                |row| row.get(0),
            )
            .expect("pragma_table_info should read");
        assert_eq!(
            default_value.as_deref(),
            Some("0"),
            "`is_subagent` arrives `DEFAULT 0` — an existing row IS a main session \
             (ADR 0025 §6: no data migration)"
        );

        let rows = db.list_sessions(true).expect("list_sessions");
        assert_eq!(rows.len(), 2, "the two pre-existing rows survived");
        assert!(
            rows.iter().all(|s| !s.is_subagent),
            "every migrated row reads `is_subagent == false` — a row that arrived \
             `true` would be filtered out of `list_sessions` and the session would \
             vanish from the list after an upgrade; got {:?}",
            rows.iter()
                .map(|s| (s.id.clone(), s.is_subagent))
                .collect::<Vec<_>>()
        );
        // The read itself is the proof the flag is 0 and not merely present:
        // `list_sessions` filters `is_subagent = 0`, so a row that arrived `1`
        // could not be returned here at all — the count above would be 0.
        assert_eq!(
            raw_scalar(&db, "SELECT COUNT(*) FROM sessions WHERE is_subagent = 1"),
            0,
            "NOT ONE row was migrated into the subagent flag — the gate carries no \
             backfill and the DEFAULT holds"
        );
    }

    // A SECOND open of the already-migrated file is a clean no-op (the
    // `pragma_table_info` probe skips the `ALTER`), and nothing flipped.
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    assert_eq!(
        db.list_sessions(true).expect("list_sessions").len(),
        2,
        "the gate ran once, not twice, and the rows are still visible"
    );
}
