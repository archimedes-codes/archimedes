//! Tests for what `db/mod.rs` keeps: `Db::open` and its migration gates,
//! `SCHEMA`, `LAST_ACTIVITY`, `set_journal_pragmas`.
//!
//! The gate COUNT is deliberately not stated here, because it moves with every gated
//! column and a stale figure reads as a broken guard. Measure it when you need it:
//! `grep -c 'gate(&mut conn' src-tauri/src/storage/db/mod.rs`, and the `(table,
//! column)` surface itself is DERIVED by [`gated_columns_in_open_source`] below rather
//! than listed.
//!
//! The mirror (ADR 0113) gives every production sibling a test child of the same
//! name; this child is the one that mirrors the PARENT, because `open`, `gate`,
//! `SCHEMA` and `LAST_ACTIVITY` stay in `mod.rs` — the gate-count pin
//! (`each_cluster_schema_omits_exactly_one_gated_column`, counting through
//! [`gated_columns_in_open_source`]) reads this parent's source text and counts
//! the gates inside `open`, so moving them would move the pin's premise.

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
    //
    // IT NOW OMITS EXACTLY ONE GATED COLUMN, and that is a fix this branch made.
    // The fixture used to stop at `sort_order` and carry no `parent_session_id`,
    // so `Db::open` ran the `sessions.parent_session_id` gate inside a test about
    // TITLING — the isolation collapse `each_cluster_schema_omits_exactly_one_gated_column`
    // exists to catch, and invisible there because that pin only walks the
    // `SCHEMA_WITHOUT_*` cluster fixtures while this one is inline. The assertions
    // below never noticed: an added NULL column changes nothing they read. The
    // column is here now so this test observes its own gate.
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
            sort_order INTEGER NOT NULL DEFAULT 0,
            parent_session_id TEXT,
            -- COMPLETE EXCEPT `title_stage`, and that is the isolation rule: this
            -- fixture's ONLY job is the `title_stage` gate's data step, so every
            -- OTHER gated column — `ready` included — is here to keep its own gate
            -- silent. See the census in `support.rs`'s header for the two lists.
            ready INTEGER
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

/// A pre-existing database whose `sessions` table predates the
/// `parent_session_id` column must open CLEANLY (the one-time migration adds the
/// column), and the pre-existing rows must read `parent_session_id == NULL`.
///
/// `NULL` — not `''` — is the load-bearing half of this test, and it is the same
/// argument `cost_usd_column_migration_on_a_preexisting_db` above makes about a
/// phantom `$0.00`: roughly half the children already in a live database have NO
/// parent to record (their parent row is gone), so a `DEFAULT ''` would fabricate
/// an empty-string parent for every one of them and the column would stop being a
/// fact. The migration therefore has NO `DEFAULT` and NO backfill.
///
/// The second half pins the column carries NO foreign key, at rest, in BOTH
/// places its DDL can be spelled — see the two read targets below.
#[test]
fn parent_session_id_column_migration_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-parent-test-", "scratch");
    // A pre-existing database: the `sessions` table WITHOUT `parent_session_id`.
    // Every OTHER gated column IS present, so this test isolates the
    // `parent_session_id` gate (the sibling migrations are no-ops here) — the same
    // isolation the `cost_usd` migration test above practices, now spelled as the
    // shared `SCHEMA_WITHOUT_PARENT_SESSION_ID` constant.
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_PARENT_SESSION_ID,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/tmp', 1, '{}');",
    );
    // The next `Db::open` must SUCCEED (the migration adds the column).
    let db = Db::open(&path).expect("the parent_session_id migration is one-time and idempotent");
    // ...and the column is in place now.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'parent_session_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the parent_session_id column is in place after the migration"
    );
    // And it has NO default. A `DEFAULT ''` would pass the NULL assertions below
    // only by lying — every migrated row would read "this child's parent is the
    // session whose id is the empty string", a parent that never existed, which is
    // the phantom-`$0.00` defect one column over. Pinned directly on
    // `dflt_value`, because a `DEFAULT NULL` someone later "improves" to
    // `DEFAULT ''` would otherwise slip through the value assertions.
    let default_value: Option<String> = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT dflt_value FROM pragma_table_info('sessions') WHERE name = 'parent_session_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        default_value, None,
        "`parent_session_id` has NO column DEFAULT — NULL means 'parent never known', \
         '' would fabricate a parent the ~50% already-orphaned children never had"
    );
    // ...and the pre-existing row reads NULL. Read through the raw connection
    // because nothing on `SessionRow` reads the column: `rows::SESSION_COLUMNS` is
    // deliberately unchanged, so the column is invisible to the row structs and
    // only SQL sees it.
    let parent: Option<String> = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT parent_session_id FROM sessions WHERE id = 's1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        parent, None,
        "a pre-existing row reads parent_session_id == NULL (no parent was ever known)"
    );
    // ...and a SECOND open of the already-migrated database is a clean no-op (the
    // `pragma_table_info` gate skips the ALTER) — the migration is idempotent.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'parent_session_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the re-open neither drops nor duplicates the column"
    );

    // ── The at-rest no-FK pin ────────────────────────────────────────────────
    //
    // NOTHING enforced this decision before now: the column ships with no foreign
    // key on purpose, and a reviewer adding the "obvious" `REFERENCES
    // sessions(id)` to tidy the schema would break both halves of the design at
    // once. A `ON DELETE CASCADE` FK would delete the CHILD `sessions` rows, which
    // the design forbids — the row survives because it carries `cost_usd` and costs
    // 0.6 MB for 2,643 rows — and a RESTRICTing (or `SET NULL`) FK would refuse the
    // ~50% of existing children whose parent is already deleted, i.e. it would
    // refuse the future writes too. A dangling `parent_session_id` is a storable,
    // expected state; the in-tree precedent is `sessions.cwd`, which carries no FK
    // to `spaces` for the identical reason (`db/mod.rs`'s board-table comment: a
    // board that cascaded away with the tab would lose a person's whole workflow to
    // a click that deletes nothing else). `task_sessions.session_id` is the
    // COUNTER-example — that link DOES cascade, because a Session has a delete verb
    // and a Task does not.
    //
    // TWO READ TARGETS, and both are live — the shape
    // `no_board_table_has_a_foreign_key_to_spaces` records. `SCHEMA` is the DDL
    // batch, where a reviewer would most obviously write the FK. The `include_str!`
    // arm asks the same question of `db/mod.rs`, whose gate block carries DDL that
    // lives OUTSIDE `SCHEMA` and is therefore invisible to the first arm: the new
    // `ALTER TABLE sessions ADD COLUMN parent_session_id …` is exactly such DDL.
    assert!(
        !SCHEMA.contains("parent_session_id TEXT REFERENCES"),
        "`parent_session_id` carries NO foreign key by decision — a cascading FK would \
         delete the child `sessions` rows the design keeps, and a RESTRICTing one would \
         refuse the ~50% already-orphaned children; got {SCHEMA}"
    );
    assert!(
        !include_str!("../mod.rs").contains("ADD COLUMN parent_session_id TEXT REFERENCES"),
        "and the gate's own `ALTER` carries no FK either — that statement is DDL \
         outside `SCHEMA`, so the arm above cannot see it"
    );
}

/// (the two hand-position gates) a pre-existing database whose `stages` table
/// predates BOTH canvas columns must open CLEANLY, and every pre-existing column
/// must read `None` for both — and BOTH columns must arrive with NO SQL `DEFAULT`.
///
/// `None` — not `0` — is the load-bearing half, and it is
/// `the_auto_max_steps_gate_arrives_null_on_a_preexisting_space`'s argument moved
/// from a spend bound to a screen coordinate: `NULL` means "this column was never
/// hand-arranged, so the canvas lays it out with dagre", which is the state every
/// row in every existing database is in. A `DEFAULT 0` would migrate all of them
/// into "hand-placed at the origin", so the first canvas open after an upgrade
/// would stack every node in the user's workflow at (0, 0) and bypass dagre for
/// all of them — a layout nobody arranged, which is the phantom-`$0.00` shape
/// (ADR 0082) wearing a coordinate. `0.0` is a CONFIGURED answer ("pinned to the
/// top edge") and must never arrive by migration.
///
/// `dflt_value` is pinned DIRECTLY, because the `None` assertions would also pass
/// under a `DEFAULT` someone later "improves". Both gates are exercised in one
/// test through a loop rather than two tests because the two columns are one
/// decision (a node's position) and the claim about them is identical; the loop
/// opens each fixture as its OWN database, so each open still observes exactly one
/// gate (the isolation `each_cluster_schema_omits_exactly_one_gated_column` pins).
#[test]
fn both_position_gates_arrive_null_on_a_preexisting_board() {
    for (fixture, column) in [
        (SCHEMA_WITHOUT_STAGES_POSITION_X, "position_x"),
        (SCHEMA_WITHOUT_STAGES_POSITION_Y, "position_y"),
    ] {
        let dir = crate::test_support::ScratchDir::in_env_temp("db-position-gate-", "scratch");
        let space = format!("/board-space/position-gate-{column}");
        let path = preexisting_db(
            &dir,
            fixture,
            &format!(
                "INSERT INTO spaces (path, created_at, last_opened_at, trusted, sort_order) \
                 VALUES ('{space}', 1, 1, 0, 0);\n\
                 INSERT INTO stages (space_path, slug, label, sort_order) VALUES \
                   ('{space}','backlog','Backlog',0),\
                   ('{space}','doing','Doing',1);\n"
            ),
        );

        {
            let db = Db::open(&path).expect("the position gate runs on open");
            let default_value: Option<String> = db
                .conn
                .lock()
                .expect("db mutex poisoned")
                .query_row(
                    &format!(
                        "SELECT dflt_value FROM pragma_table_info('stages') \
                         WHERE name = '{column}'"
                    ),
                    [],
                    |row| row.get(0),
                )
                .expect("pragma_table_info should read");
            assert_eq!(
                default_value, None,
                "`{column}` has NO column DEFAULT — 0 is a hand-placed coordinate \
                 and must not arrive by migration"
            );

            let stages = db.list_stages(&space).expect("list_stages");
            assert_eq!(stages.len(), 2, "the two pre-existing rows survived");
            assert!(
                stages
                    .iter()
                    .all(|s| s.position_x.is_none() && s.position_y.is_none()),
                "every migrated column reads BOTH coordinates as None — an \
                 upgraded board has nothing hand-arranged, so dagre still owns it; \
                 got {:?}",
                stages
                    .iter()
                    .map(|s| (s.slug.clone(), s.position_x, s.position_y))
                    .collect::<Vec<_>>()
            );
        }

        // A SECOND open of the already-migrated file is a clean no-op (the
        // `pragma_table_info` probe skips the `ALTER`) and nothing flipped.
        let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
        assert!(
            db.list_stages(&space)
                .expect("list_stages")
                .iter()
                .all(|s| s.position_x.is_none() && s.position_y.is_none()),
            "the gate ran once, not twice"
        );
    }
}

/// Derive the `(table, column)` surface `Db::open` ACTUALLY gates, by parsing the
/// `gate(&mut conn, "table", "column"` call sites out of the parent's own text.
///
/// WHY THIS EXISTS. `each_cluster_schema_omits_exactly_one_gated_column` below
/// carries a hand-maintained `GATED` list, and until this function existed the
/// ONLY thing tying that list to the code was a bare
/// `assert_eq!(source.matches("gate(&mut conn, ").count(), 19)` in the sibling
/// pin. A count of the CALL PREFIX cannot see the table or the column, so both
/// failure directions were green at once: `GATED` could name a column no gate
/// probes, and a 20th gate could arrive on a column `GATED` never lists, and the
/// two numbers still agreed. This function turns the count into a DERIVATION —
/// the set is parsed from the source, so a gate and its `GATED` entry can no
/// longer disagree silently. AGENTS.md's rule is the reason: a guard that passes
/// vacuously is decoration.
///
/// THE INSTRUMENT is the same literal the table-ban loop in
/// [`the_three_task_tables_are_in_schema_and_have_no_gate_entry`] already
/// searches for (`gate(&mut conn, "{table}"`), so it is an instrument this file
/// has already proven it can use, not a new one. Its shape is deliberately
/// STRICT: after the table's closing quote the text MUST begin `, "` — a gate
/// written with a different spelling (a named argument, a line break, a
/// `conn` under another name) PANICS here rather than being skipped, because a
/// parser that waves through what it cannot read is exactly the vacuous guard
/// this replaced. The cluster pin additionally asserts the derived count equals
/// the plain call-prefix count, which is what proves the parser saw EVERY call
/// site rather than a prefix of them.
fn gated_columns_in_open_source() -> Vec<(&'static str, &'static str)> {
    // `include_str!` yields `&'static str`, so every slice below is `'static` too
    // and the returned Vec can outlive the parse.
    let source: &'static str = include_str!("../mod.rs");
    const CALL: &str = "gate(&mut conn, \"";
    let mut found: Vec<(&'static str, &'static str)> = Vec::new();
    let mut rest = source;
    while let Some(at) = rest.find(CALL) {
        let after_table = &rest[at + CALL.len()..];
        let table_end = after_table.find('"').expect(
            "a `gate(&mut conn, \"` call must be followed by a table name and its closing quote",
        );
        let table = &after_table[..table_end];
        let after_table_name = &after_table[table_end + 1..];
        assert!(
            after_table_name.starts_with(", \""),
            "the gate on `{table}` is not spelled `gate(&mut conn, \"{table}\", \
             \"column\", …)` — this parser refuses to SKIP a call shape it cannot \
             read, because a skipped call site is a gated column no assertion sees"
        );
        // `, "` is THREE characters (comma, space, quote) — slicing at 2 would
        // leave the opening quote on the column and parse every column as `""`.
        let after_column_quote = &after_table_name[3..];
        let column_end = after_column_quote
            .find('"')
            .expect("the column name must be a quoted literal closed with `\"`");
        let column = &after_column_quote[..column_end];
        found.push((table, column));
        rest = &after_column_quote[column_end + 1..];
    }
    found
}

/// Isolation is these fixtures' load-bearing property, so it is ASSERTED rather
/// than commented: each `SCHEMA_WITHOUT_*` must omit EXACTLY ONE gated column
/// across both tables and carry every other one. If a fixture silently
/// loses a second column, the sibling gate fires inside that test and the test
/// stops being about its own gate — this fails first, with the fixture named.
///
/// THE `GATED` LIST IS PROVEN, NOT TRUSTED. It is asserted to be SET-EQUAL to
/// the gates [`gated_columns_in_open_source`] parses out of `db/mod.rs`, so this
/// test's denominator IS `Db::open`'s real migration surface. See that function
/// for why a bare count could not do this job.
///
/// WHAT THIS TEST DOES **NOT** CLAIM, and that narrowing is deliberate. It walks
/// the eighteen `SCHEMA_WITHOUT_*` fixtures and asserts each omits exactly one
/// gated column; it does NOT assert that every gated column has a fixture here.
/// THREE columns in `GATED` have no `SCHEMA_WITHOUT_*` string, and each was
/// checked by measurement rather than assumed — all three are covered by a
/// dedicated legacy-database test elsewhere:
///
///   * `sessions.todos_json` — its gate's DATA STEP is the whole subject of two
///     dedicated tests in [`super::migrations`]
///     (`legacy_db_migration_backfills_newest_non_read_todos_once` and
///     `legacy_db_migration_backfills_both_manage_todo_list_and_manage_checklist`),
///     each building a legacy `sessions` table with `todos_json` absent and
///     asserting the backfill's outcome and its run-once behaviour. Those
///     fixtures are NOT isolated (they are a genuinely old shape and omit several
///     gated columns at once), and they stay that way on purpose: `support.rs`'s
///     header records that a migration fixture wanting several gates to fire
///     together is the one legitimate multi-omission shape, and the ADR 0093 pins
///     are not this pin's to re-cut.
///   * `sessions.title_stage` — dedicated test
///     (`title_stage_migrates_existing_titled_sessions_to_stage_2_and_untitled_to_0`
///     above), whose inline fixture was **fixed by this change** to carry
///     `parent_session_id TEXT`, because it previously omitted TWO gated columns
///     and so ran the `parent_session_id` gate inside a test about titling. It
///     now omits exactly one, which is what the isolation rule asks — and it is
///     the ONE inline fixture the `ready` gate had to be added to for that to stay
///     true, because a fixture that gained `ready` while the macro gained it too
///     would silently run the `ready` gate inside a test about titling.
///   * `spaces.trusted` — dedicated legacy probe in the integration target
///     `src-tauri/tests/storage.rs::spaces_trusted_column_fresh_and_migrated`,
///     which builds the OLD three-column `spaces` table, opens `Db`, and asserts
///     the migrated row reads `trusted = false` and that a third open is a
///     no-op. That fixture is non-isolated (a three-column `spaces` runs every
///     `spaces` gate), and a unit twin would duplicate an assertion that already
///     exists and already names its column — so the honest record is "covered,
///     outside the cluster", not a second fixture.
///   * `sessions.is_subagent` — **the FOURTH this census used to name, and it is
///     no longer one of them.** Measured at the time: no test asserted anything
///     about this gate's outcome on a legacy database; the column was merely ABSENT
///     from several other fixtures' `CREATE TABLE sessions`, so the `ALTER` ran as
///     an unasserted side effect of someone else's test. It got
///     `SCHEMA_WITHOUT_IS_SUBAGENT` in [`super::support`] — in the cluster list
///     below, so this pin's isolation assertion covers it — and
///     `the_is_subagent_gate_arrives_zero_for_every_pre_existing_session` in
///     [`super::migrations`], beside the other data-step migration tests. It stays
///     listed here as the worked example of what this census is FOR: a gated column
///     with no legacy-database probe anywhere, found by measuring rather than by
///     someone shipping a migration bug. `sessions.ready` was found the same way and
///     arrived WITH its fixture and its pin in one change, which is why the count
///     above is THREE and not four.
///
/// The asymmetry that survives is therefore stated rather than hidden: the
/// cluster list is the set of gates whose fixture's ONLY job is the gate, and the
/// three columns above are the gates whose probe is a bigger test's subject. What
/// is no longer possible is the thing that was possible before — a gated column
/// with no legacy-database probe anywhere, discovered only when someone shipped a
/// migration bug.
#[test]
fn each_cluster_schema_omits_exactly_one_gated_column() {
    // (table, column) for every gate `Db::open` probes, in probe order. THE ORDER
    // IS DOCUMENTATION ONLY — the assertion below sorts both sides, so a reordered
    // `gate` call in `db/mod.rs` does not redden this test and a renamed or added
    // column does.
    const GATED: [(&str, &str); 21] = [
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
        ("stages", "auto"),
        ("stages", "prompt_prefix"),
        ("spaces", "board_strict"),
        ("sessions", "parent_session_id"),
        ("sessions", "ready"),
        ("spaces", "auto_max_steps"),
        ("spaces", "auto_ceiling_usd"),
        ("stages", "position_x"),
        ("stages", "position_y"),
        ("stages", "next_outcomes"),
    ];
    let fixtures: [(&str, &str); 18] = [
        ("SCHEMA_WITHOUT_ARCHIVED", SCHEMA_WITHOUT_ARCHIVED),
        ("SCHEMA_WITHOUT_CONTEXT_USAGE", SCHEMA_WITHOUT_CONTEXT_USAGE),
        ("SCHEMA_WITHOUT_IS_SUBAGENT", SCHEMA_WITHOUT_IS_SUBAGENT),
        ("SCHEMA_WITHOUT_COST_USD", SCHEMA_WITHOUT_COST_USD),
        (
            "SCHEMA_WITHOUT_PARENT_SESSION_ID",
            SCHEMA_WITHOUT_PARENT_SESSION_ID,
        ),
        ("SCHEMA_WITHOUT_READY", SCHEMA_WITHOUT_READY),
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
            "SCHEMA_WITHOUT_STAGES_NEXT_OUTCOMES",
            SCHEMA_WITHOUT_STAGES_NEXT_OUTCOMES,
        ),
        ("SCHEMA_WITHOUT_STAGES_AUTO", SCHEMA_WITHOUT_STAGES_AUTO),
        (
            "SCHEMA_WITHOUT_STAGES_PROMPT_PREFIX",
            SCHEMA_WITHOUT_STAGES_PROMPT_PREFIX,
        ),
        (
            "SCHEMA_WITHOUT_STAGES_POSITION_X",
            SCHEMA_WITHOUT_STAGES_POSITION_X,
        ),
        (
            "SCHEMA_WITHOUT_STAGES_POSITION_Y",
            SCHEMA_WITHOUT_STAGES_POSITION_Y,
        ),
        (
            "SCHEMA_WITHOUT_SPACES_BOARD_STRICT",
            SCHEMA_WITHOUT_SPACES_BOARD_STRICT,
        ),
        (
            "SCHEMA_WITHOUT_SPACES_AUTO_MAX_STEPS",
            SCHEMA_WITHOUT_SPACES_AUTO_MAX_STEPS,
        ),
        (
            "SCHEMA_WITHOUT_SPACES_AUTO_CEILING_USD",
            SCHEMA_WITHOUT_SPACES_AUTO_CEILING_USD,
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

    // ── THE DERIVATION: `GATED` is `Db::open`'s gate surface, not a list that
    //    happens to have the right length ────────────────────────────────────
    //
    // Three assertions, each closing one of the holes the bare count left open.
    let derived = gated_columns_in_open_source();

    // (1) The parser saw EVERY call site. `matches(…).count()` counts the literal
    // call prefix; this counts what the parser could actually read a table and a
    // column out of. If the two disagree, a gate is spelled in a shape the parser
    // did not understand — and (2) alone could then still pass, because a `GATED`
    // entry that was never parsed simply would not be in `derived`. So this is the
    // arm that makes (2) mean "every gate", not "the gates the parser liked".
    let call_sites = include_str!("../mod.rs")
        .matches("gate(&mut conn, ")
        .count();
    assert_eq!(
        derived.len(),
        call_sites,
        "the parser read {} `(table, column)` tuples but the source holds {} \
         `gate(&mut conn, ` call sites — a gate in an unreadable shape is a gated \
         column no assertion in this file sees",
        derived.len(),
        call_sites,
    );

    // (2) SET EQUALITY, both directions, after sorting (a `gate` reordered within
    // `Db::open` must not redden this; a column renamed, added or removed must).
    // Sorting also puts a DUPLICATE gate on the same column adjacent to its twin,
    // so a double gate on one column reddens here too — the two lists differ in
    // length and the printed diff shows the repeated pair. No separate
    // duplicate-detection arm is asserted: this one already fires first on that
    // input, and a guard that cannot be the thing that goes red is decoration.
    let mut want: Vec<(&str, &str)> = GATED.to_vec();
    let mut got = derived.clone();
    want.sort_unstable();
    got.sort_unstable();
    assert_eq!(
        got, want,
        "`GATED` (the SECOND list) and the gates parsed out of `db/mod.rs` (the \
         FIRST) disagree — an entry in the FIRST list is a gate no fixture in this \
         file can be built for (add the `SCHEMA_WITHOUT_*` fixture AND its \
         dedicated test, then update `GATED`), and an entry only in the SECOND \
         names a column no gate probes. A repeated pair is a gate that fires twice \
         on one column."
    );
}

/// (the schema guard, and the `gate()` rule) the board tables ride the
/// idempotent `CREATE TABLE IF NOT EXISTS` batch in `SCHEMA` and get NO
/// migration entry — `gate` is a TRANSACTION FACTORY for new COLUMNS on
/// existing tables, so a new TABLE must never appear in one. The name says
/// "three" from the #176 original; the list is FIVE since `task_artifacts`
/// (#180) and `workflow_runs` (the auto-chain run record) arrived, and the count
/// in the last assertion is whatever the tree measures — this change adds a
/// TABLE and two gated COLUMNS, so the list grows by one and the count by two.
///
/// The second loop names `tasks`, `task_sessions`, `task_artifacts` and
/// `workflow_runs`, and that narrowing is a decision rather than an oversight.
/// `stages` and `spaces` are the two tables that pre-date the #179 Stage-config
/// work with an OLDER shape, so gating a new COLUMN onto each of them is exactly
/// what the migration factory is for — `stages.on_enter_skill`,
/// `stages.next_slugs`, `spaces.board_strict` and the two `spaces` auto-guard
/// columns are gated on purpose, and a reader who "restores" the old board-table
/// ban would be banning the migration itself. What stays forbidden is a gate
/// naming a table that has NO pre-existing shape to repair: `tasks`,
/// `task_sessions`, `task_artifacts` and `workflow_runs` arrive whole from
/// `SCHEMA`, so a gate on any of them would be a lie.
#[test]
fn the_three_task_tables_are_in_schema_and_have_no_gate_entry() {
    for statement in [
        "CREATE TABLE IF NOT EXISTS stages",
        "CREATE TABLE IF NOT EXISTS tasks",
        "CREATE TABLE IF NOT EXISTS task_sessions",
        "CREATE TABLE IF NOT EXISTS task_artifacts",
        "CREATE TABLE IF NOT EXISTS workflow_runs",
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
    // Re-pointed at the PARENT's own text by the ADR 0113 split: every
    // `gate(&mut conn, …)` call lives inside `Db::open`, and `open` is what
    // `db/mod.rs` kept, so the parent is still the file whose gate surface this
    // counts. `migrations.rs` holds the four gate DATA STEPS and calls no gate.
    let source = include_str!("../mod.rs");
    for table in ["tasks", "task_sessions", "task_artifacts", "workflow_runs"] {
        let gated = format!("gate(&mut conn, \"{table}\"");
        assert_eq!(
            source.matches(&gated).count(),
            0,
            "`{table}` is a NEW TABLE, not a new column — it must not appear in a \
             `gate(` call ({gated})"
        );
    }
    // The gate SURFACE's size is no longer asserted here. It used to be
    // `assert_eq!(source.matches("gate(&mut conn, ").count(), 19)`, and that was
    // the bare count [`gated_columns_in_open_source`] replaced: a count of the
    // call PREFIX cannot see a table or a column, so it agreed with a `GATED`
    // list that named the wrong columns. It is now derived — set-equal to `GATED`
    // and cross-checked against the same call-prefix count — in
    // [`each_cluster_schema_omits_exactly_one_gated_column`], which is the one
    // place the number lives. Asserting 19 twice would mean a legitimate 20th
    // gate needs two coordinated edits and would put a rot-prone literal back into
    // the file this change was meant to take it out of. What this test owns, and
    // keeps, is the QUALITATIVE ban above: whatever the count turns out to be, no
    // gate may name a table that arrives whole from `SCHEMA`.
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
    // TWO READ TARGETS, and both are live.
    //
    // `SCHEMA` is the DDL batch — the place a reviewer would most obviously write
    // `REFERENCES spaces(path)` to "tidy the schema" — so the forbidden string is
    // searched there. The `include_str!` arm beside it asks the same question of the
    // WHOLE `db/mod.rs` text, and that is NOT redundant: `Db::open` stays in that
    // file and its migration path carries DDL of its own outside the `SCHEMA` const
    // (the `native_messages_migrated` batch spells `REFERENCES sessions(id) ON DELETE
    // CASCADE` at `db/mod.rs:837`), so a spaces FK added THERE is visible only to the
    // whole-file arm.
    //
    // The claim this comment used to carry — that the pre-split whole-file arm was
    // VACUOUS and "could not have gone red for a schema reason even before the split"
    // — was FALSE, and is retracted. Measured: `REFERENCES spaces(path)` added to the
    // `sessions` DDL inside `SCHEMA` reddened the whole-file arm at the base commit.
    // The narrower `SCHEMA` arm the split left behind is live too, but it narrowed
    // coverage: the same FK added to the `native_messages_migrated` DDL survives at
    // HEAD and was caught at base. Both arms are therefore kept.
    //
    // Non-vacuity, other direction (a wrong read target passing green): the positive
    // assertion BELOW on this same page finds `REFERENCES sessions(id) ON DELETE
    // CASCADE` inside the very same `SCHEMA` text, so `REFERENCES ` is proven present
    // in what the DDL arm reads. No assertion is added or weakened for that proof —
    // it is the pin's own existing positive arm.
    assert!(
        !SCHEMA.contains("REFERENCES spaces"),
        "nothing in the schema may reference `spaces` — `sessions.cwd` carries no \
         FK for the identical reason"
    );
    assert!(
        !include_str!("../mod.rs").contains("REFERENCES spaces"),
        "and nothing in `db/mod.rs` at all — `Db::open`'s own migration DDL lives \
         outside `SCHEMA` and is the half the DDL arm above cannot see"
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
