//! Tests for what `db/mod.rs` keeps: `Db::open` and its twelve migration gates,
//! `SCHEMA`, `LAST_ACTIVITY`, `set_journal_pragmas`.
//!
//! The mirror (ADR 0113) gives every production sibling a test child of the same
//! name; this child is the one that mirrors the PARENT, because `open`, `gate`,
//! `SCHEMA` and `LAST_ACTIVITY` stay in `mod.rs` — the gate-count pin
//! (`the_three_task_tables_are_in_schema_and_have_no_gate_entry`) reads this
//! parent's source text and counts the twelve gates inside `open`, so moving them
//! would move the pin's premise.

use crate::storage::db::*;

use super::support::*;

/// (the FK migration) A crash MID-BATCH leaves a stale
/// `native_messages_migrated` table behind (the original
/// `native_messages` still exists, WITHOUT the FK): the next
/// `Db::open` must RECOVER (the migration is atomic +
/// crash-idempotent — pre-fix the re-run hit `CREATE TABLE …
/// already exists` and `Db::open` errored forever, bricking startup).
#[test]
fn a_crashed_fk_migration_recovers_on_the_next_open() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-migration-test-", "scratch");
    let path = dir.join("t.db");
    // A pre-existing database: `native_messages` WITHOUT the FK (the
    // pre-migration schema) + a session row + a transcript row.
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL
        );
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        INSERT INTO sessions VALUES ('s1', 'archimedes', '/tmp', 1, NULL, '{}');
        INSERT INTO native_messages VALUES ('s1', 0, 'user', '{}', 1);",
    )
    .unwrap();
    // The mid-batch CRASH state: a stale `native_messages_migrated`
    // table left behind.
    conn.execute_batch(
        "CREATE TABLE native_messages_migrated (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        INSERT INTO native_messages_migrated VALUES ('s1', 9, 'assistant', '{}', 2);",
    )
    .unwrap();
    drop(conn);
    // The next `Db::open` must SUCCEED (the migration is atomic +
    // crash-idempotent).
    let db = Db::open(&path).expect("the migration is crash-idempotent/atomic");
    // ...and the FK is in place now.
    let fk: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('native_messages') \
             WHERE \"table\" = 'sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fk, 1, "the FK is in place after recovery");
    // ...and the pre-existing rows survived the migration (the stale
    // `native_messages_migrated`'s rows were NOT merged in — only the
    // original table's rows are the transcript).
    let n: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM native_messages WHERE session_id = 's1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "the pre-existing transcript row survived");
}

/// (finding 5) A legacy crash state: a crash under the pre-fix
/// autocommit code between `DROP TABLE native_messages` and the
/// `RENAME` leaves `native_messages` GONE with the rows living in
/// `native_messages_migrated`. `Db::open` must RECOVER (rename the
/// migrated table — the rows survive + the FK is restored), not error
/// forever (pre-fix the re-run hit `INSERT … SELECT … FROM
/// native_messages` → "no such table" → rollback → `Db::open` errored
/// forever, bricking startup).
#[test]
fn a_crashed_fk_migration_with_native_messages_gone_recovers_on_the_next_open() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-migration-test-", "scratch");
    let path = dir.join("t.db");
    // The crash state: `native_messages` is GONE (dropped + autocommitted)
    // and the rows live in `native_messages_migrated` (created WITH the FK
    // + the copy, autocommitted).
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL
        );
        CREATE TABLE native_messages_migrated (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        INSERT INTO sessions VALUES ('s1', 'archimedes', '/tmp', 1, NULL, '{}');
        INSERT INTO native_messages_migrated VALUES ('s1', 0, 'user', '{}', 1);",
    )
    .unwrap();
    drop(conn);
    // The next `Db::open` must SUCCEED (the migration recovers the crash
    // state by renaming the migrated table).
    let db = Db::open(&path).expect("the migration recovers the crash state");
    // ...and the FK is in place (the migrated table was created with it).
    let fk: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('native_messages') \
             WHERE \"table\" = 'sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fk, 1, "the FK is in place after recovery");
    // ...and the rows SURVIVED the recovery (the migrated table's rows
    // are the transcript now).
    let n: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM native_messages WHERE session_id = 's1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "the transcript row survived the recovery");
}

/// (ADR 0016) A pre-existing database whose `sessions` table predates
/// the `archived` column must open CLEANLY (the one-time migration adds
/// the column with a `DEFAULT 0` backfill) and the pre-existing rows
/// must read `archived == false` (the default).
///
/// The fixture is `SCHEMA_WITHOUT_ARCHIVED`: every OTHER gated column is
/// present, so the `trusted` / `context_usage_json` / `is_subagent` /
/// `todos_json` / `cost_usd` / two `sort_order` gates and the pre-rip-out
/// `agent_id` purge all stay silent and this test observes its own gate.
#[test]
fn archived_column_migration_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_ARCHIVED,
        // A cwd that does not exist on disk (the idiom the sort-order fixtures
        // use): the phase-11 space backfill skips it, so the fixture stays about
        // the ONE session row and the silence below is provable. The original
        // fixture's `/tmp` was never asserted — the row's `id` and `archived`
        // are what this test reads.
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/x/nope-not-a-folder', 1, '{}');",
    );
    // The next `Db::open` must SUCCEED (the migration adds the column).
    let db = Db::open(&path).expect("the archived migration is one-time and idempotent");
    // ...and the column is in place now.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'archived'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the archived column is in place after the migration"
    );
    // Isolation, asserted rather than assumed: the sibling gates were silent,
    // so the ONE row this fixture seeded is the only row `Db::open` saw — no
    // space row was backfilled from a `sessions` cwd, no seed renumbered it.
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM spaces"),
        0,
        "the phase-11 space backfill stayed silent (the `/tmp` cwd of the fixture \
         row is not canonicalizable to a fresh space row here, so a space row \
         would mean a sibling gate ran inside this test)"
    );
    // ...and the pre-existing row reads `archived == false` (the default).
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed");
    assert_eq!(rows.len(), 1, "the pre-existing row survived");
    assert_eq!(rows[0].id, "s1");
    assert!(
        !rows[0].archived,
        "a pre-existing row reads archived == false"
    );
    // ...and a SECOND open of the already-migrated database is a clean
    // no-op (the `pragma_table_info` gate skips the ALTER) — the
    // migration is idempotent: the row survives re-opening intact with
    // `archived == false`.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed on the second open");
    assert_eq!(rows.len(), 1, "the pre-existing row survived the re-open");
    assert_eq!(rows[0].id, "s1");
    assert!(
        !rows[0].archived,
        "the re-opened row still reads archived == false"
    );
}

/// (native-only rip-out) A pre-rip-out database (`sessions` WITH the
/// `agent_id` column) must open CLEANLY on `Db::open`: the one-way
/// migration deletes ALL external `sessions` rows (`agent_id <> 'archimedes'`
/// — the built-in `pi` + any user-configured external entries; their
/// `messages` rows cascade via the FK) and drops the `agent_id` column.
/// The `messages` table STAYS (the native display transcript) and the
/// `archimedes` row + its `messages` / `native_messages` rows are intact.
/// Idempotent: a SECOND `Db::open` on the same file is a clean no-op
/// (the `PRAGMA table_info` probe is the guard).
#[test]
fn opening_a_pre_rip_out_database_migrates_it() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-riput-test-", "scratch");
    let path = dir.join("t.db");
    // A pre-rip-out database: the CURRENT schema with the `agent_id`
    // column still on `sessions` (the pre-feature shape).
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0
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
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
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
        );
        -- (a) the built-in `pi` external entry + a display row.
        INSERT INTO sessions VALUES ('s-pi', 'pi', '/tmp', 1, NULL, '{}', 0);
        INSERT INTO messages VALUES (1, 's-pi', 'agent-text', 'm1', '{}', 1);
        -- (b) a user-configured external entry + a display row.
        INSERT INTO sessions VALUES ('s-cc', 'claude-code', '/tmp', 2, NULL, '{}', 0);
        INSERT INTO messages VALUES (2, 's-cc', 'agent-text', 'm2', '{}', 2);
        -- (c) the native entry + display + provider transcript rows.
        INSERT INTO sessions VALUES ('s-native', 'archimedes', '/tmp', 3, NULL, '{}', 0);
        INSERT INTO messages VALUES (3, 's-native', 'agent-text', 'm3', '{}', 3);
        INSERT INTO native_messages VALUES ('s-native', 0, 'user', '{}', 3);",
    )
    .unwrap();
    drop(conn);
    // `Db::open` must SUCCEED (the migration is one-way + idempotent).
    let db = Db::open(&path).expect("the pre-rip-out migration must not brick startup");
    let conn = db.conn.lock().expect("db mutex poisoned");
    // The `messages` table STILL EXISTS (the native display transcript).
    let messages_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        messages_exists, 1,
        "the messages table survives the migration (the native display transcript)"
    );
    // `sessions` has NO `agent_id` column (the migration dropped it).
    let has_agent_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'agent_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has_agent_id, 0,
        "the agent_id column is gone after the migration"
    );
    // The external rows are GONE with their `messages` rows (the FK cascade).
    let external_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id IN ('s-pi', 's-cc')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        external_sessions, 0,
        "the pi + claude-code session rows are deleted"
    );
    let external_messages: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id IN ('s-pi', 's-cc')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        external_messages, 0,
        "the external messages rows cascaded away"
    );
    // The `archimedes` row SURVIVES with its `messages` + `native_messages`
    // rows intact.
    let native_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_sessions, 1, "the archimedes session row survived");
    let native_messages: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_messages, 1, "the native messages row survived");
    let native_transcript: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM native_messages WHERE session_id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_transcript, 1, "the native transcript row survived");
    // A SECOND `Db::open` on the same file is a clean no-op (idempotency —
    // the `PRAGMA table_info` probe is the guard): the rows are intact.
    drop(conn);
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let conn = db.conn.lock().expect("db mutex poisoned");
    let has_agent_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'agent_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has_agent_id, 0,
        "the re-open is a no-op (the column stays dropped)"
    );
    let native_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_sessions, 1, "the native row survived the re-open");
}

/// The DRIFT GUARD beside the characterisation test: `LAST_ACTIVITY` equals
/// the old expression, spelled as a LITERAL here. The moment anyone edits the
/// const this reddens, so the characterisation above has to be re-decided
/// rather than silently drifting with it.
///
/// The right-hand side is the ONE-LINE spelling on purpose (the const itself
/// carries `\\`-continuations): the assertion says out loud that the const's
/// multi-line form and this single-line form are the same expression, which a
/// whitespace-normalising comparison would not.
#[test]
fn the_last_activity_const_matches_the_expression_the_row_prints() {
    assert_eq!(
        LAST_ACTIVITY,
        "COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = sessions.id), sessions.created_at)"
    );
}

#[test]
fn title_stage_migrates_existing_titled_sessions_to_stage_2_and_untitled_to_0() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-mig-test-", "scratch");
    let path = dir.join("t.db");
    // A pre-existing database: the `sessions` table WITHOUT `title_stage`.
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
            is_subagent INTEGER NOT NULL DEFAULT 0,
            todos_json TEXT,
            cost_usd REAL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO sessions (id, cwd, created_at, title, capabilities_json)
        VALUES ('s-titled', '/tmp', 1, 'Pre-existing Title', '{}');
        INSERT INTO sessions (id, cwd, created_at, title, capabilities_json)
        VALUES ('s-untitled', '/tmp', 2, NULL, '{}');",
    )
    .unwrap();
    drop(conn);

    // The next `Db::open` must SUCCEED (the migration adds title_stage and backfills titled rows).
    let db = Db::open(&path).expect("the title_stage migration is one-time and idempotent");

    // Verify column exists
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'title_stage'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(has, 1, "the title_stage column is in place after migration");

    // Verify row values
    let titled = db.session("s-titled").unwrap().expect("s-titled exists");
    assert_eq!(titled.title.as_deref(), Some("Pre-existing Title"));
    assert_eq!(
        titled.title_stage, 2,
        "pre-existing titled session migrated to stage 2"
    );

    let untitled = db
        .session("s-untitled")
        .unwrap()
        .expect("s-untitled exists");
    assert_eq!(untitled.title, None);
    assert_eq!(
        untitled.title_stage, 0,
        "pre-existing untitled session migrated to stage 0"
    );

    // list_sessions projection agrees
    let all = db.list_sessions(true).unwrap();
    let titled_listed = all.iter().find(|s| s.id == "s-titled").unwrap();
    assert_eq!(titled_listed.title_stage, 2);
    let untitled_listed = all.iter().find(|s| s.id == "s-untitled").unwrap();
    assert_eq!(untitled_listed.title_stage, 0);

    // Idempotency: re-opening does not error or alter stage
    drop(db);
    let db2 = Db::open(&path).expect("re-opening migrated db succeeds");
    let titled2 = db2.session("s-titled").unwrap().unwrap();
    assert_eq!(titled2.title_stage, 2);
}

/// A pre-existing database whose `sessions` table predates the
/// `context_usage_json` column must open CLEANLY (the one-time
/// migration adds the column) and the pre-existing rows must read
/// `context_usage == None` (the default).
///
/// The fixture is `SCHEMA_WITHOUT_CONTEXT_USAGE`: every OTHER gated column is
/// present, so the sibling gates stay silent and this test observes its own.
#[test]
fn context_usage_column_migration_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-context-test-", "scratch");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_CONTEXT_USAGE,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, archived) \
         VALUES ('s1', '/tmp', 1, '{}', 0);",
    );
    // The next `Db::open` must SUCCEED (the migration adds the column).
    let db = Db::open(&path).expect("the context_usage migration is one-time and idempotent");
    // ...and the column is in place now.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'context_usage_json'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the context_usage_json column is in place after the migration"
    );
    // ...and the pre-existing row reads `context_usage == None` (no data yet).
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed");
    assert_eq!(rows.len(), 1, "the pre-existing row survived");
    assert!(
        rows[0].context_usage_json.is_none(),
        "a pre-existing row reads context_usage == None"
    );
    // ...and a SECOND open of the already-migrated database is a clean
    // no-op (the `pragma_table_info` gate skips the ALTER) — the
    // migration is idempotent.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed on the second open");
    assert!(
        rows[0].context_usage_json.is_none(),
        "the re-opened row still reads context_usage == None"
    );
}

/// A pre-existing database whose `sessions` table predates the
/// `cost_usd` column must open CLEANLY (the one-time migration adds the
/// column) and the pre-existing rows must read `cost_usd == None`
/// (issue #105).
///
/// `None` — not `0.0` — is the load-bearing half of this test: a column
/// `DEFAULT 0` would migrate every old row to "this session spent
/// nothing", which is a FIGURE the provider never reported, and the
/// renderer would print `$0.00` under sessions that were never priced
/// (the D5 defect, ADR 0082). The migration therefore has no `DEFAULT`
/// and NO backfill — cost data never existed anywhere, so there is
/// nothing honest to backfill.
#[test]
fn cost_usd_column_migration_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    // A pre-existing database: the `sessions` table WITHOUT `cost_usd`.
    // Every OTHER gated column IS present, so this test isolates the
    // `cost_usd` gate (the sibling migrations are no-ops here) — the same
    // isolation the `context_usage_json` migration test above practices, now
    // spelled as the shared `SCHEMA_WITHOUT_COST_USD` constant.
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_COST_USD,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/tmp', 1, '{}');",
    );
    // The next `Db::open` must SUCCEED (the migration adds the column).
    let db = Db::open(&path).expect("the cost_usd migration is one-time and idempotent");
    // ...and the column is in place now.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'cost_usd'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the cost_usd column is in place after the migration"
    );
    // And it has NO default. A `DEFAULT 0` would pass the assertion below
    // only by lying — every migrated row would read "spent nothing", a
    // figure the provider never reported (the phantom-`$0.00` defect, D5 /
    // ADR 0082). Pinned directly, because the `None` assertions below would
    // ALSO pass under a `DEFAULT NULL` that someone later "improves".
    let default_value: Option<String> = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT dflt_value FROM pragma_table_info('sessions') WHERE name = 'cost_usd'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        default_value, None,
        "`cost_usd` has NO column DEFAULT — NULL means 'never reported', 0 means 'reported zero'"
    );
    // ...and the pre-existing row reads `cost_usd == None` — never `0.0`.
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed");
    assert_eq!(rows.len(), 1, "the pre-existing row survived");
    assert_eq!(
        rows[0].cost_usd, None,
        "a pre-existing row reads cost_usd == None (no figure was ever reported)"
    );
    // `session()` reads it the same way (the two queries stay in lockstep).
    let row = db
        .session("s1")
        .expect("session should succeed")
        .expect("the pre-existing row is there");
    assert_eq!(
        row.cost_usd, None,
        "the resume read agrees with the list read"
    );
    // ...and a SECOND open of the already-migrated database is a clean
    // no-op (the `pragma_table_info` gate skips the ALTER) — the
    // migration is idempotent.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed on the second open");
    assert_eq!(
        rows[0].cost_usd, None,
        "the re-opened row still reads cost_usd == None"
    );
}

/// Isolation is these fixtures' load-bearing property, so it is ASSERTED rather
/// than commented: each `SCHEMA_WITHOUT_*` must omit EXACTLY ONE gated column
/// across both tables and carry every other one. If a fixture silently
/// loses a second column, the sibling gate fires inside that test and the test
/// stops being about its own gate — this fails first, with the fixture named.
#[test]
fn each_cluster_schema_omits_exactly_one_gated_column() {
    // (table, column) for every gate `Db::open` probes, in probe order.
    const GATED: [(&str, &str); 12] = [
        ("spaces", "trusted"),
        ("sessions", "archived"),
        ("sessions", "context_usage_json"),
        ("sessions", "is_subagent"),
        ("sessions", "todos_json"),
        ("sessions", "cost_usd"),
        ("spaces", "sort_order"),
        ("sessions", "sort_order"),
        ("sessions", "title_stage"),
        ("stages", "on_enter_skill"),
        ("stages", "next_slugs"),
        ("spaces", "board_strict"),
    ];
    let fixtures: [(&str, &str); 8] = [
        ("SCHEMA_WITHOUT_ARCHIVED", SCHEMA_WITHOUT_ARCHIVED),
        ("SCHEMA_WITHOUT_CONTEXT_USAGE", SCHEMA_WITHOUT_CONTEXT_USAGE),
        ("SCHEMA_WITHOUT_COST_USD", SCHEMA_WITHOUT_COST_USD),
        (
            "SCHEMA_WITHOUT_SPACE_SORT_ORDER",
            SCHEMA_WITHOUT_SPACE_SORT_ORDER,
        ),
        (
            "SCHEMA_WITHOUT_SESSION_SORT_ORDER",
            SCHEMA_WITHOUT_SESSION_SORT_ORDER,
        ),
        (
            "SCHEMA_WITHOUT_STAGES_ON_ENTER_SKILL",
            SCHEMA_WITHOUT_STAGES_ON_ENTER_SKILL,
        ),
        (
            "SCHEMA_WITHOUT_STAGES_NEXT_SLUGS",
            SCHEMA_WITHOUT_STAGES_NEXT_SLUGS,
        ),
        (
            "SCHEMA_WITHOUT_SPACES_BOARD_STRICT",
            SCHEMA_WITHOUT_SPACES_BOARD_STRICT,
        ),
    ];
    for (name, schema) in fixtures {
        let dir = crate::test_support::ScratchDir::in_env_temp("db-cluster-fixture-", "scratch");
        let path = preexisting_db(&dir, schema, "");
        let conn = Connection::open(&path).unwrap();
        let missing: Vec<(&str, &str)> = GATED
            .iter()
            .filter(|(table, column)| {
                let has: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                        rusqlite::params![*table, *column],
                        |row| row.get(0),
                    )
                    .unwrap();
                has == 0
            })
            .copied()
            .collect();
        assert_eq!(
            missing.len(),
            1,
            "`{name}` must omit EXACTLY ONE gated column so its sibling gates \
             stay silent; it omits {missing:?}"
        );
    }
}

/// (the schema guard, and the `gate()` rule) the board tables ride the
/// idempotent `CREATE TABLE IF NOT EXISTS` batch in `SCHEMA` and get NO
/// migration entry — `gate` is a TRANSACTION FACTORY for new COLUMNS on
/// existing tables, so a new TABLE must never appear in one. The name says
/// "three" from the #176 original; the list is FOUR since `task_artifacts`
/// (#180) arrived, and the count in the last assertion is whatever the tree
/// measures — this change adds a TABLE, so it moves nothing.
///
/// The second loop names `tasks`, `task_sessions` and `task_artifacts`, and
/// that narrowing is a decision rather than an oversight. `stages` and `spaces`
/// are the two tables that pre-date the #179 Stage-config work with an OLDER
/// shape, so gating a new COLUMN onto each of them is exactly what the migration
/// factory is for — `stages.on_enter_skill`, `stages.next_slugs` and
/// `spaces.board_strict` are gated on purpose, and a reader who "restores" the
/// old board-table ban would be banning the migration itself. What stays
/// forbidden is a gate naming a table that has NO pre-existing shape to repair:
/// `tasks`, `task_sessions` and `task_artifacts` arrive whole from `SCHEMA`, so
/// a gate on any of them would be a lie.
#[test]
fn the_three_task_tables_are_in_schema_and_have_no_gate_entry() {
    for statement in [
        "CREATE TABLE IF NOT EXISTS stages",
        "CREATE TABLE IF NOT EXISTS tasks",
        "CREATE TABLE IF NOT EXISTS task_sessions",
        "CREATE TABLE IF NOT EXISTS task_artifacts",
    ] {
        assert_eq!(
            SCHEMA.matches(statement).count(),
            1,
            "`{statement}` must appear EXACTLY ONCE in SCHEMA"
        );
    }
    // The source-text half: no `gate(` call names a NEW TABLE. A gated COLUMN on
    // `tasks`/`task_sessions` would mean a pre-existing database held a `tasks`
    // table of some other shape, which it never did — and it would make
    // `each_cluster_schema_omits_exactly_one_gated_column`'s fixtures lie, so
    // this is the guard that keeps that test honest.
    // Re-pointed at the PARENT's own text by the ADR 0113 split: all twelve
    // `gate(&mut conn, …)` calls live inside `Db::open`, and `open` is what
    // `db/mod.rs` kept, so the parent is still the file whose gate surface this
    // counts. `migrations.rs` holds the three gate DATA STEPS and calls no gate.
    let source = include_str!("../mod.rs");
    for table in ["tasks", "task_sessions", "task_artifacts"] {
        let gated = format!("gate(&mut conn, \"{table}\"");
        assert_eq!(
            source.matches(&gated).count(),
            0,
            "`{table}` is a NEW TABLE, not a new column — it must not appear in a \
             `gate(` call ({gated})"
        );
    }
    // And the gate surface is still exactly the twelve additive columns: the 9
    // pre-#179 gates plus `stages.on_enter_skill`, `stages.next_slugs` and
    // `spaces.board_strict`.
    assert_eq!(
        source.matches("gate(&mut conn, ").count(),
        12,
        "the 12 gates are the whole migration surface; a NEW TABLE (as opposed to a
         new column on an existing one) must not add a 13th, and no gate may ever \
         name `tasks`, `task_sessions` or `task_artifacts`"
    );
}

/// (no FK on `space_path`, pinned from the DDL) the two board tables keyed by a
/// Space carry ZERO foreign keys, while `task_sessions.session_id` carries the
/// file's existing cascade clause verbatim. A reviewer adding the "obvious"
/// `REFERENCES spaces(path)` to keep the schema tidy fails here, not in a user's
/// database after a tab close.
#[test]
fn no_board_table_has_a_foreign_key_to_spaces() {
    let tasks = SCHEMA
        .split("CREATE TABLE IF NOT EXISTS tasks")
        .nth(1)
        .expect("the tasks DDL")
        .split(";")
        .next()
        .expect("the tasks DDL body");
    let stages = SCHEMA
        .split("CREATE TABLE IF NOT EXISTS stages")
        .nth(1)
        .expect("the stages DDL")
        .split(";")
        .next()
        .expect("the stages DDL body");
    for ddl in [tasks, stages] {
        assert!(
            !ddl.contains("REFERENCES"),
            "ADR 0090: no foreign key on space_path — a board that cascaded away \
             on a tab close loses a workflow; got {ddl}"
        );
    }
    // READS `SCHEMA`, not a file path — and that is the whole point of this arm.
    // It used to read `include_str!("../../db.rs")` and ask the question of a whole
    // source FILE, which made it VACUOUS: `REFERENCES spaces` occurs ZERO times in
    // that file's text either way, so this arm could not have gone red for a schema
    // reason even before the split (AGENTS.md / `docs/agents/repo-gotchas.md`:
    // "check the vacuity floor in that lint"). `SCHEMA` is the one place a reviewer
    // could actually write `REFERENCES spaces(path)` — the DDL batch — so the
    // forbidden string is now searched where it would appear, and the read target
    // travels with the split instead of breaking on it.
    //
    // The arm is also demonstrably NOT vacuous the other way (an empty or wrong
    // read target passing green): the positive assertion BELOW on this same page
    // finds `REFERENCES sessions(id) ON DELETE CASCADE` inside the very same
    // `SCHEMA` text. So `REFERENCES ` is proven present in what was read, and a
    // `REFERENCES spaces(path)` added to any of the four board DDLs is caught here
    // rather than in a user's database after a tab close. No assertion is added or
    // weakened for that proof — it is the pin's own existing positive arm.
    assert!(
        !SCHEMA.contains("REFERENCES spaces"),
        "nothing in the schema may reference `spaces` — `sessions.cwd` carries no \
         FK for the identical reason"
    );
    let links = SCHEMA
        .split("CREATE TABLE IF NOT EXISTS task_sessions")
        .nth(1)
        .expect("the task_sessions DDL");
    assert!(
        links.contains("REFERENCES sessions(id) ON DELETE CASCADE"),
        "`task_sessions.session_id` reuses the file's existing cascade clause verbatim"
    );
}

/// (the ADR 0090/0100 no-FK pin, extended to the fourth table) `task_artifacts`
/// appears EXACTLY ONCE in `SCHEMA` and its DDL body carries NO `REFERENCES`.
///
/// The asymmetry with `task_sessions` is the point, so it is asserted BOTH ways
/// in one place: the artifact table has no FK, the link table keeps its cascade.
/// A reviewer adding the "obvious" `REFERENCES tasks(id)` to tidy the schema
/// fails here — and what they would have broken is ADR 0090's own bug one level
/// down: an artifact dying because a Space tab closed.
#[test]
fn task_artifacts_are_in_schema_and_carry_no_foreign_key() {
    assert_eq!(
        SCHEMA
            .matches("CREATE TABLE IF NOT EXISTS task_artifacts")
            .count(),
        1,
        "`task_artifacts` must appear EXACTLY ONCE in SCHEMA"
    );
    let ddl = SCHEMA
        .split("CREATE TABLE IF NOT EXISTS task_artifacts")
        .nth(1)
        .expect("the task_artifacts DDL")
        .split(";")
        .next()
        .expect("the task_artifacts DDL body");
    assert!(
        !ddl.contains("REFERENCES"),
        "ADR 0100/0090: `task_artifacts` carries NO foreign key — an artifact that \
         cascaded away with a Space tab is ADR 0090's bug one level down; got {ddl}"
    );
    // The columns, pinned from the DDL text: the shape spec §1 froze. A column
    // renamed here and not in `Artifact` is a mapper bug the read-back tests
    // would catch, but a column ADDED (a `status`, say) is invisible to those and
    // is exactly the second state vocabulary the spec forbids.
    for column in ["task_id", "key", "markdown", "created_at", "updated_at"] {
        assert!(
            ddl.contains(column),
            "the task_artifacts DDL must declare `{column}`; got {ddl}"
        );
    }
    assert!(
        ddl.contains("PRIMARY KEY (task_id, key)"),
        "the composite PK is what makes an overwrite an UPSERT — one row per key, \
         ever; got {ddl}"
    );
    // And the contrast, so the asymmetry stays a decision rather than drift.
    let links = SCHEMA
        .split("CREATE TABLE IF NOT EXISTS task_sessions")
        .nth(1)
        .expect("the task_sessions DDL");
    assert!(
        links.contains("REFERENCES sessions(id) ON DELETE CASCADE"),
        "`task_sessions` KEEPS its cascade (a Session can be deleted; a Task has no \
         delete verb) — this pin is not a blanket ban on FKs"
    );
}

// ── #155: the journal pragmas + the batched message write ────────────────────

/// (issue #155, the whole-window jank) A fresh `Db::open` runs in WAL with
/// `synchronous = NORMAL` and a real `busy_timeout`.
///
/// WHY these three numbers and not a measurement: the measured cost of the
/// old default (rollback journal + `synchronous = FULL`) is 14–17 ms per
/// commit against 1.1–1.6 ms for WAL+FULL and ~0.12 ms for WAL+NORMAL, and
/// every streamed message was its own commit — so the user watched a
/// whole-window freeze while the UI thread waited on 3 `fdatasync`s per frame.
///
/// The readback is `PRAGMA journal_mode` on the app's OWN connection, compared
/// case-insensitively — the same read the production code makes, because
/// `journal_mode` can refuse SILENTLY (see the sibling test) and a `?` on
/// `pragma_update` would never see the refusal.
#[test]
fn a_fresh_db_opens_in_wal_with_normal_synchronous_and_a_busy_timeout() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-journal-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let conn = db.conn.lock().expect("db mutex poisoned");

    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("the journal_mode readback");
    assert_eq!(
        mode.to_lowercase(),
        "wal",
        "a fresh database runs in WAL — the rollback journal is what cost \
         3 fdatasyncs per commit"
    );
    let sync: i64 = conn
        .query_row("PRAGMA synchronous", [], |row| row.get(0))
        .expect("the synchronous readback");
    assert_eq!(
        sync, 1,
        "`synchronous = NORMAL` (1): the durability step WAL makes cheap, taken"
    );
    let busy: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .expect("the busy_timeout readback");
    assert!(
        busy > 0,
        "`busy_timeout` is non-zero — WAL lets a reader meet a writer, and \
         without a timeout that meeting is an immediate SQLITE_BUSY"
    );
}

/// (the degrade branch, unit-testable) A connection whose journal mode CANNOT
/// become WAL — `:memory:`, which refuses the change while `pragma_update`
/// returns `Ok` — comes back as `Some(reason)`, and the connection is still
/// open for business afterwards.
///
/// This is the real refusal, not a mock of one: `journal_mode = WAL` on an
/// in-memory database is a no-op SQLite accepts in silence, which is exactly
/// the failure mode the plan says `pragma_update_and_check`'s `?` cannot see.
/// A filesystem that refuses WAL (a network mount without the shared-memory
/// support) takes the same path: the readback disagrees with the request.
///
/// The two halves of the contract, both asserted: DEGRADE (a reason comes back,
/// never a panic, never an `Err` — `Db::open` must still start the app), and
/// NOT-BRICKED (the other two pragmas still land and the connection still
/// writes — a refused journal is not a refused database).
#[test]
fn set_journal_pragmas_reports_a_degrade_when_the_journal_mode_refuses_wal() {
    let mut conn = Connection::open_in_memory().expect("an in-memory connection");
    // The premise, pinned: this connection really does refuse WAL. Without
    // this the test would be asserting against a connection that accepts it,
    // and the degrade branch would never be reached.
    assert_eq!(
        conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .expect("the mode readback")
            .to_lowercase(),
        "memory",
        "the premise: an in-memory database cannot be switched to WAL"
    );

    let degraded = set_journal_pragmas(&mut conn);

    let reason = degraded.expect(
        "a refused WAL reports the degrade, it does not \
         pass as success",
    );
    assert!(
        reason.to_lowercase().contains("wal"),
        "the reason names what was refused, so the log line is actionable: \
         got {reason:?}"
    );
    // ...and the app is NOT bricked by the refusal: the other two pragmas still
    // apply (a rollback journal still benefits from the timeout — that is the
    // pragma that keeps a second `Db` on one file from erroring), and the
    // connection still writes.
    assert_eq!(
        conn.query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))
            .expect("the busy_timeout readback"),
        5000,
        "a degraded journal does not skip the remaining pragmas"
    );
    conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);")
        .expect("a refused WAL leaves a usable connection");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get::<_, i64>(0))
            .expect("the row count"),
        1,
        "and the write landed"
    );
}
