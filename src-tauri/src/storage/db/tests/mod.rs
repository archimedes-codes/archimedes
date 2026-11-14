use super::*;

/// (settings trust) a NEW space row is born `trusted` per the flag
/// (the INSERT writes `trusted` from the flag). Asserted via
/// `list_spaces()` (NOT `space_trusted` — a canonicalize failure
/// fail-closes to `false` on a nonexistent path, a misleading red).
/// Real temp dirs for the paths (a nonexistent path canonicalize-
/// fails → `space_key` falls back to the raw string; the canonical
/// key is asserted here).
#[test]
fn upsert_space_insert_sets_trusted_from_the_flag() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-trusted-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).unwrap();
    let a = dir.join("a");
    std::fs::create_dir_all(&a).unwrap();
    let b = dir.join("b");
    std::fs::create_dir_all(&b).unwrap();
    db.upsert_space(a.to_str().unwrap(), true).unwrap();
    db.upsert_space(b.to_str().unwrap(), false).unwrap();
    let rows = db.list_spaces().unwrap();
    let a_canon = std::fs::canonicalize(&a).unwrap().display().to_string();
    let b_canon = std::fs::canonicalize(&b).unwrap().display().to_string();
    let row_a = rows.iter().find(|r| r.path == a_canon).unwrap();
    let row_b = rows.iter().find(|r| r.path == b_canon).unwrap();
    assert!(
        row_a.trusted,
        "the INSERT writes `trusted` from the flag (true)"
    );
    assert!(
        !row_b.trusted,
        "the INSERT writes `trusted` from the flag (false)"
    );
}

/// (settings trust) a re-upsert on an EXISTING row never touches the
/// trust flag (the CONFLICT branch only refreshes `last_opened_at`
/// — no retroactive trust): `false` → trust ON → re-upsert `false`
/// → the row is STILL trusted.
#[test]
fn upsert_space_conflict_leaves_the_existing_trust_untouched() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-trusted-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).unwrap();
    let c = dir.join("c");
    std::fs::create_dir_all(&c).unwrap();
    let c_canon = std::fs::canonicalize(&c).unwrap().display().to_string();
    db.upsert_space(&c_canon, false).unwrap();
    db.set_space_trusted(&c_canon, true).unwrap();
    db.upsert_space(&c_canon, false).unwrap();
    let rows = db.list_spaces().unwrap();
    let row = rows.iter().find(|r| r.path == c_canon).unwrap();
    assert!(row.trusted, "the CONFLICT branch never touches `trusted`");
}

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

/// (ADR 0016) `list_sessions(false)` never returns archived rows;
/// `list_sessions(true)` returns them with the flag set. Mixed-list
/// parity: with a mix of archived and non-archived rows, the default
/// list returns EXACTLY the non-archived row and the full list returns
/// both with the correct flags.
#[test]
fn list_sessions_filters_archived_by_default() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let mk = |id: &str| SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": id,
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    // Two sessions; one of them gets archived.
    db.record_session(&mk("sess-1"))
        .expect("record_session should succeed");
    db.record_session(&mk("sess-2"))
        .expect("record_session should succeed");
    assert!(
        db.set_session_archived("sess-1", true)
            .expect("set_session_archived should succeed"),
        "a matching row returns true"
    );
    let visible = db
        .list_sessions(false)
        .expect("list_sessions(false) should succeed");
    assert_eq!(
        visible.len(),
        1,
        "list_sessions(false) returns exactly the non-archived row"
    );
    assert_eq!(
        visible[0].id, "sess-2",
        "the default list returns the non-archived row"
    );
    assert!(
        !visible[0].archived,
        "list_sessions(false) never returns archived rows"
    );
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 2, "list_sessions(true) returns both rows");
    let by_id: std::collections::HashMap<&str, &bool> =
        all.iter().map(|r| (r.id.as_str(), &r.archived)).collect();
    assert_eq!(
        by_id["sess-1"], &true,
        "the archived flag is set on the row"
    );
    assert_eq!(by_id["sess-2"], &false, "the non-archived flag is clear");
}

/// (ADR 0016) `set_session_archived` on an id with no row is a no-op:
/// `Ok(false)` (mirrors `set_space_trusted`'s documented behavior).
#[test]
fn set_session_archived_is_a_noop_for_an_unknown_id() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    assert!(
        !db.set_session_archived("no-such-session", true)
            .expect("should not error"),
        "a missing row is a no-op returning false"
    );
}

/// The list is ordered by `sort_order`, then `id DESC`: the position the
/// user (or a drag) gave a row decides where it sits, and nothing else
/// moves it (ADR 0075 — `docs/decisions/0075-list-position-is-not-evidence.md`).
///
/// The fixture makes `sort_order` and recency DISAGREE: the last-listed
/// session gets the newest transcript, so the old recency `ORDER BY` would
/// have floated it to the top. A fixture where both orders agreed would pass
/// under either statement and prove nothing.
#[test]
fn list_sessions_orders_by_sort_order_then_id_desc() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortlist-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    // Recorded through `record_session` so `sort_order` is actually written
    // (raw INSERTs would leave every row on `DEFAULT 0` and tie the list).
    for id in ["s_x", "s_y", "s_z"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }
    // Re-number them into a NON-recency sequence: `s_y` leads, the row
    // recorded first (`s_x`) lands last.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for (id, value) in [("s_x", 2_i64), ("s_y", 0), ("s_z", 1)] {
            conn.execute(
                "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
                params![id, value],
            )
            .expect("sort_order write should succeed");
        }
    }
    // The LAST-listed row gets the newest transcript: recency says it leads,
    // its number says it trails, and the number is what wins.
    db.record_message("s_x", "user", None, "{\"text\":\"hi\"}")
        .expect("record_message should succeed");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_y", "s_z", "s_x"],
        "rows come back in `sort_order` order even though the last one has \
         the newest message — position is not evidence of recency"
    );
}

/// Two rows sharing a `sort_order` break the tie on `id DESC`, and BOTH arms
/// of the statement order identically: the archived-inclusive read is the
/// OTHER arm, so it is a real second assertion (it can fail on its own) and
/// not a copy of the first — one shared `ORDER BY` is what keeps them from
/// drifting.
///
/// Recency is made to disagree (the first-id row carries the newest
/// transcript), so the assertion cannot be satisfied by the old ordering.
#[test]
fn list_sessions_ties_break_on_id_desc() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sorttie-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.record_session(&title_session("s_a"))
        .expect("record s_a");
    db.record_session(&title_session("s_b"))
        .expect("record s_b");
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        conn.execute("UPDATE sessions SET sort_order = 5", [])
            .expect("tie the two rows on one number");
    }
    // `s_a`'s transcript is the newer one, so the old recency key would put
    // `s_a` FIRST; the tie-break is what puts `s_b` first here. The
    // `created_at` is written EXPLICITLY and far in the future: both rows
    // were recorded inside the same millisecond, so a `record_message`
    // timestamp could TIE their last activity and let the old statement
    // reach the same `id DESC` answer for the wrong reason.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_a', 'user', NULL, '{}', 9_999_999_999_999)",
            [],
        )
        .expect("fixture message row");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_b", "s_a"],
        "an equal `sort_order` breaks on `id DESC`, never on recency"
    );

    // Archive one of the two tied rows: the second read now runs the
    // archived-inclusive arm over the same pair.
    assert!(db
        .set_session_archived("s_a", true)
        .expect("set_session_archived should succeed"));
    let ids: Vec<String> = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_b", "s_a"],
        "the archived-inclusive arm orders the tied pair identically"
    );
}

/// (ADR 0075 behaviour pin) Transcript activity never moves a row: the
/// session with the NEWEST message sits in the MIDDLE of the `sort_order`
/// sequence and stays there. The old statement floated it to the top on
/// every persisted message, which is the bug ADR 0075 exists to kill.
#[test]
fn list_sessions_ignores_transcript_activity() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortidle-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    for id in ["s_a", "s_b", "s_c"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }
    // Reverse the numbers: the sequence becomes [s_c, s_b, s_a], so `s_b`
    // is the MIDDLE row.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for (id, value) in [("s_a", 2_i64), ("s_b", 1), ("s_c", 0)] {
            conn.execute(
                "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
                params![id, value],
            )
            .expect("sort_order write should succeed");
        }
    }
    // The middle row gets the only (and therefore newest) transcript. The
    // `created_at` is written EXPLICITLY and far in the future so the old
    // recency key deterministically floats this row to the TOP: with three
    // rows recorded inside one millisecond a `record_message` timestamp
    // could tie every row's last activity, and the old statement's own
    // `id DESC` tie-break would then answer `["s_c", "s_b", "s_a"]` — the
    // expected order, for the wrong reason, i.e. a vacuous green.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_b', 'user', NULL, '{}', 9_999_999_999_999)",
            [],
        )
        .expect("fixture message row");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_c", "s_b", "s_a"],
        "the session with the newest message keeps its middle position"
    );
}

/// CHARACTERISATION (ADR 0075, the pin Task 1 exists for): `session_recency`'s
/// `last_active_at` equals what the OLD recency expression — the one
/// `list_sessions` used to `ORDER BY` — yields for the same row. The
/// expectation is read by raw SQL that SPELLS the `COALESCE(MAX …)`
/// expression out in full and deliberately does NOT interpolate
/// `LAST_ACTIVITY`: recomputing the expectation from the const under test
/// would make this pin green on any edit to that const (the same reasoning
/// `tauriBarrel.test.ts` gives for its literal list, and the reasoning
/// `list_sessions_ties_break_on_id_desc` gives for its explicit timestamp).
///
/// The fixture covers the three shapes that can break the equivalence:
/// - `s_msg_new`: one message, so "newest" is unambiguous;
/// - `s_msg_old`: TWO messages inserted **smaller-last**, so an implementation
///   that read "the last message by id" instead of `MAX()` answers
///   `1_600_000_000_000` here while the real expression answers
///   `9_000_000_000_000` — the test cannot pass by accident;
/// - `s_no_messages`: `MAX()` over no rows is `NULL`, which SQLite sorts LAST
///   in a `DESC` list (the reason `RECENT_FIRST`'s `COALESCE` exists) — so the
///   entry must be PRESENT and equal the row's own `created_at`, never
///   NULL/absent;
/// - `s_archived`: the Archived section sorts by recency, so an archived
///   session with no recency entry is the bug this task must not ship.
///
/// Every message row is written by RAW SQL with an EXPLICIT far-future
/// `created_at`, never by `record_message`: `record_session` and
/// `record_message` both stamp `now_ms()`, so rows written inside one test
/// land in the same millisecond and recency cannot separate them at all — a
/// `record_message` fixture would tie every row and let the assertion pass for
/// the wrong reason (the trap T01 records and carries forward here).
#[test]
fn session_recency_matches_the_old_coalesce_expression() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-recency-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    for id in ["s_msg_new", "s_msg_old", "s_no_messages", "s_archived"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }

    // `s_msg_new`: the single newest transcript stamp, far in the future.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_msg_new', 'user', NULL, '{}', 9_999_999_999_999)",
            [],
        )
        .expect("fixture message row");
    // `s_msg_old`: TWO rows inserted SMALLER-LAST — the newest is the FIRST
    // insert, so `MAX()` and "last row by id" disagree (see the doc comment).
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_msg_old', 'user', NULL, '{}', 9_000_000_000_000)",
            [],
        )
        .expect("fixture message row (newer, inserted first)");
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_msg_old', 'agent-text', 'k0', '{}', 1_600_000_000_000)",
            [],
        )
        .expect("fixture message row (older, inserted LAST)");
    // `s_no_messages`: nothing written — the `COALESCE` fallback case.
    // `s_archived`: archived, no messages.
    assert!(db
        .set_session_archived("s_archived", true)
        .expect("set_session_archived should succeed"));

    let rows = db
        .session_recency()
        .expect("session_recency should succeed");

    // The OLD expression, spelled out rather than interpolated — the whole
    // point of a characterisation test.
    let old_key = |id: &str| -> i64 {
        db.conn
            .lock()
            .expect("db mutex poisoned")
            .query_row(
                "SELECT COALESCE((SELECT MAX(m.created_at) FROM messages m \
                  WHERE m.session_id = sessions.id), sessions.created_at) \
                 FROM sessions WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .expect("the old recency expression must resolve for a stored id")
    };

    for id in ["s_msg_new", "s_msg_old", "s_no_messages", "s_archived"] {
        let entry = rows
            .iter()
            .find(|r| r.session_id == id)
            .unwrap_or_else(|| panic!("`session_recency` must return an entry for {id}"));
        assert_eq!(
            entry.last_active_at,
            old_key(id),
            "`{id}`'s recency equals what the OLD expression yields for the same row"
        );
    }

    // The `MAX()`-not-last-inserted half, pinned as a NUMBER as well as
    // against the expression: `s_msg_old`'s newest stamp is its FIRST insert.
    assert_eq!(
        rows.iter()
            .find(|r| r.session_id == "s_msg_old")
            .expect("`s_msg_old` is listed")
            .last_active_at,
        9_000_000_000_000,
        "recency is `MAX(created_at)`, not the last-inserted row's stamp"
    );

    // The no-messages case, spelled out separately: the entry EXISTS (an
    // absent key would strand the row in T03's recency map) and equals the
    // row's own `created_at` — never NULL, never absent.
    let created_at: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT created_at FROM sessions WHERE id = 's_no_messages'",
            [],
            |r| r.get(0),
        )
        .expect("the row's own created_at");
    let fallback = rows
        .iter()
        .find(|r| r.session_id == "s_no_messages")
        .expect("a session with no messages still gets a recency entry");
    assert_eq!(
        fallback.last_active_at, created_at,
        "the `COALESCE` falls back to the row's own `created_at` \
         (`MAX()` over no rows is NULL, which SQLite sorts LAST in a DESC list)"
    );

    // The archived half: the Archived section sorts by recency, so the row
    // must be in the result at all.
    assert!(
        rows.iter().any(|r| r.session_id == "s_archived"),
        "an archived session gets a recency entry — the Archived section sorts by it"
    );
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

/// (ADR 0075) `session_recency` covers EVERY non-subagent session — archived
/// included, matching `list_sessions(true)`'s key set exactly — and excludes
/// `is_subagent = 1` rows.
///
/// The subagent row's PRESENCE in the table is witnessed by raw SQL against
/// `db.conn`: that is the only witness that exists, because `list_sessions`
/// filters hidden rows out of every read path (the shape
/// `list_sessions_hides_subagent_rows_but_their_transcripts_load` establishes).
/// Without it, "no third entry" would be indistinguishable from "the fixture
/// never wrote the row".
#[test]
fn session_recency_covers_archived_and_excludes_subagent_rows() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-recencycover-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    db.record_session(&title_session("main-1"))
        .expect("record main-1");
    db.record_session(&title_session("arch-1"))
        .expect("record arch-1");
    assert!(db
        .set_session_archived("arch-1", true)
        .expect("set_session_archived should succeed"));
    let sub = SessionInfo {
        session_id: "sub-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: true,
    };
    db.record_session(&sub).expect("record subagent");

    let ids: Vec<String> = db
        .session_recency()
        .expect("session_recency should succeed")
        .into_iter()
        .map(|r| r.session_id)
        .collect();
    assert_eq!(
        ids,
        vec!["arch-1", "main-1"],
        "every non-subagent session is returned (archived included) and \
         the subagent row is not — exactly `list_sessions(true)`'s key set"
    );

    // The hidden row is really in the table (raw SQL — the only witness).
    let hidden: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id = 'sub-1'",
            [],
            |r| r.get(0),
        )
        .expect("count the subagent row");
    assert_eq!(
        hidden, 1,
        "the subagent row exists in `sessions` — it was EXCLUDED, not missing"
    );
}

/// (ADR 0075, D11 reversed) `session_recency` carries the row's OWN stored
/// order number, so ONE frontend sequence can interleave live and stored
/// rows: a resumed Session's row is in this result set (every non-subagent
/// row is), and its position is knowable without a second round-trip.
///
/// TWO halves, and the second is the point:
///  (a) each reported number EQUALS that row's `sort_order` column as read
///      by the file's own `sort_order_of` helper — the payload ECHOES the
///      column, it derives nothing;
///  (b) after `reorder_sessions` the reported numbers MOVE with it, so
///      `Db::session_recency` and `Db::reorder_sessions` — the write path a
///      drag uses — AGREE about the column. A boot order map built from a
///      reader that disagreed with the writer would reshuffle the list the
///      user just arranged, which is the exact bug this branch exists to
///      kill.
///
/// Sessions go in through `record_session`, never raw `INSERT`s: a raw row
/// keeps `DEFAULT 0` and would tie all three, so the numbers would prove
/// nothing (T01/T02's fixture rule). The expectations are literal integers,
/// never recomputed from a constant under test.
#[test]
fn session_recency_reports_the_manual_order_number_and_reorder_moves_it() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-recencyorder-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    for id in ["a", "b", "c"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }

    let reported = |id: &str| -> i64 {
        db.session_recency()
            .expect("session_recency should succeed")
            .into_iter()
            .find(|r| r.session_id == id)
            .unwrap_or_else(|| panic!("`session_recency` must return an entry for {id}"))
            .sort_order
    };

    // (a) The payload echoes the COLUMN, row by row — not the position in
    // the returned `Vec` (which is ordered by `id`, so on this fixture the
    // two would coincide; `sort_order_of` is the independent witness).
    for (id, number) in [("a", 0), ("b", 1), ("c", 2)] {
        assert_eq!(
            reported(id),
            sort_order_of(&db, "sessions", "id", id),
            "`{id}`'s reported number is the row's own `sort_order` column"
        );
        assert_eq!(
            reported(id),
            number,
            "`{id}` was recorded {number}th, so it holds the number {number} \
             (the bottom-join `MAX + 1` in record order)"
        );
    }

    // (b) The write path a drag uses moves the reported number too.
    let ids: Vec<String> = ["c", "a", "b"].iter().map(|s| s.to_string()).collect();
    db.reorder_sessions(&ids)
        .expect("reorder_sessions should succeed");
    assert_eq!(
        vec![reported("a"), reported("b"), reported("c")],
        vec![1, 2, 0],
        "after `reorder_sessions([c, a, b])` the reported numbers are the \
         new slice indices — the reader and the writer agree about the column"
    );
}

/// Spaces order by `sort_order` with `path ASC` breaking ties. The fixture
/// gives the FIRST-listed row the LOWEST `last_opened_at`, so the old
/// recency statement would have returned the reverse-ish order; and the
/// second half ties two rows so the tie-break itself is pinned (and pinned
/// as stable across reads, not re-derived from recency).
#[test]
fn list_spaces_orders_by_sort_order_then_path() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacelist-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    // Upserted z, m, a: `sort_order` 0,1,2 while `path ASC` is a,m,z — the
    // two orders disagree, so the tie-break half below is not vacuous.
    let dirs = [dir.join("zzz"), dir.join("mmm"), dir.join("aaa")];
    for d in &dirs {
        std::fs::create_dir_all(d).unwrap();
    }
    let keys: Vec<String> = dirs
        .iter()
        .map(|d| {
            db.upsert_space(d.to_str().unwrap(), false)
                .expect("upsert_space should succeed");
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    // Recency says the opposite: the first-listed row is the STALEST.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for (key, opened) in [(&keys[0], 1_000_i64), (&keys[1], 3_000), (&keys[2], 2_000)] {
            conn.execute(
                "UPDATE spaces SET last_opened_at = ?2 WHERE path = ?1",
                params![key, opened],
            )
            .expect("last_opened_at write should succeed");
        }
    }

    let paths: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        paths, keys,
        "rows come back in `sort_order` order although the first is the least recently opened"
    );

    // Tie two rows on one number: they must come back `path ASC` (`a`
    // before `m`), NOT in the order their `last_opened_at` values imply.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for key in [&keys[1], &keys[2]] {
            conn.execute(
                "UPDATE spaces SET sort_order = 7 WHERE path = ?1",
                params![key],
            )
            .expect("tie the two rows on one number");
        }
    }
    let paths: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        paths,
        vec![keys[0].clone(), keys[2].clone(), keys[1].clone()],
        "a tied `sort_order` breaks on `path ASC` and never on recency"
    );
}

/// A minimal recorded-session shape for the title tests (the title
/// itself is never part of the literal — nothing writes it through
/// `record_session`, only through `set_session_title`).
fn title_session(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": id,
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    }
}

/// The session's title is written at stage 0 (transitioning to stage 1):
/// the first `set_session_title` writes the title and returns
/// `true`, and both `session()` and `list_sessions()` read it back (the
/// naming pass's write must reach the boot fetch that lists sessions).
#[test]
fn set_session_title_writes_a_null_title_and_reads_back() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");
    // A recorded session starts UNTITLED (`record_session` inserts NULL title and title_stage 0).
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title,
        None,
        "a recorded session has no title yet"
    );
    assert!(
        db.set_session_title("sess-1", "Refactor the auth middleware")
            .expect("set_session_title should succeed"),
        "a session with no title is written, so the call returns true"
    );
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title
            .as_deref(),
        Some("Refactor the auth middleware"),
        "the title is stored on the row"
    );
    // …and it surfaces in the listing the boot fetch uses.
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert_eq!(
        all[0].title.as_deref(),
        Some("Refactor the auth middleware"),
        "list_sessions reads the title back"
    );
}

#[test]
fn set_session_title_stage_transitions_from_0_to_1() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-stage-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");

    let initial = db.session("sess-1").unwrap().unwrap();
    assert_eq!(initial.title_stage, 0);
    assert_eq!(initial.title, None);

    let ok = db
        .set_session_title_stage("sess-1", "Stage 1 Title", 0, 1)
        .expect("set_session_title_stage should succeed");
    assert!(ok, "transition from 0 to 1 returns true");

    let updated = db.session("sess-1").unwrap().unwrap();
    assert_eq!(updated.title_stage, 1);
    assert_eq!(updated.title.as_deref(), Some("Stage 1 Title"));

    let listed = db.list_sessions(true).unwrap();
    assert_eq!(listed[0].title_stage, 1);
    assert_eq!(listed[0].title.as_deref(), Some("Stage 1 Title"));
}

#[test]
fn set_session_title_stage_transitions_from_1_to_2() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-stage-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");

    assert!(db
        .set_session_title_stage("sess-1", "Stage 1 Title", 0, 1)
        .expect("transition 0 -> 1 succeeds"));

    let ok = db
        .set_session_title_stage("sess-1", "Stage 2 Title", 1, 2)
        .expect("set_session_title_stage should succeed");
    assert!(ok, "transition from 1 to 2 returns true");

    let updated = db.session("sess-1").unwrap().unwrap();
    assert_eq!(updated.title_stage, 2);
    assert_eq!(updated.title.as_deref(), Some("Stage 2 Title"));
}

#[test]
fn set_session_title_stage_fails_on_mismatched_from_stage() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-stage-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");

    // Attempt 1 -> 2 when currently at stage 0
    let ok = db
        .set_session_title_stage("sess-1", "Stage 2 Title", 1, 2)
        .expect("query should succeed");
    assert!(!ok, "transition from mismatched from_stage returns false");

    let row = db.session("sess-1").unwrap().unwrap();
    assert_eq!(row.title_stage, 0);
    assert_eq!(row.title, None);

    // Advance to stage 1
    assert!(db
        .set_session_title_stage("sess-1", "Stage 1 Title", 0, 1)
        .unwrap());

    // Attempt 0 -> 1 again when already at stage 1
    let ok = db
        .set_session_title_stage("sess-1", "Another Stage 1", 0, 1)
        .expect("query should succeed");
    assert!(!ok, "repeat 0 -> 1 returns false");
    let row = db.session("sess-1").unwrap().unwrap();
    assert_eq!(row.title_stage, 1);
    assert_eq!(row.title.as_deref(), Some("Stage 1 Title"));

    // Attempt 2 -> 3 when at stage 1
    let ok = db
        .set_session_title_stage("sess-1", "Stage 3", 2, 3)
        .expect("query should succeed");
    assert!(!ok, "transition from mismatched stage returns false");
    let row = db.session("sess-1").unwrap().unwrap();
    assert_eq!(row.title_stage, 1);
    assert_eq!(row.title.as_deref(), Some("Stage 1 Title"));
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

/// A title that already exists is NEVER overwritten — a second
/// `set_session_title` returns `false` and leaves the FIRST title (the
/// generated title from an earlier turn, or one a future rename
/// affordance wrote, wins). This is the race guard: the naming pass may
/// fire on several turns, and only the first write lands.
#[test]
fn set_session_title_never_overwrites_an_existing_title() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");
    db.set_session_title("sess-1", "First title")
        .expect("the first write should succeed");
    assert!(
        !db.set_session_title("sess-1", "Second title")
            .expect("set_session_title should not error on a titled row"),
        "a titled row writes nothing, so the call returns false"
    );
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title
            .as_deref(),
        Some("First title"),
        "the first title survives the second call"
    );
}

/// `set_session_title` on an id with no row is a no-op: `Ok(false)`
/// (mirrors `set_session_archived` — a missing row is not an error).
#[test]
fn set_session_title_is_a_noop_for_an_unknown_id() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    assert!(
        !db.set_session_title("no-such-session", "Any title")
            .expect("should not error"),
        "a missing row is a no-op returning false"
    );
}

/// A re-`record_session` (the resume re-record) never clears the stored
/// title — the `ON CONFLICT … DO UPDATE` branch must not touch `title`
/// (resuming a titled session must not erase its label, exactly as it
/// must not un-archive it).
#[test]
fn record_session_preserves_the_title() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = title_session("sess-1");
    db.record_session(&session)
        .expect("record_session should succeed");
    db.set_session_title("sess-1", "Kept title")
        .expect("set_session_title should succeed");
    // The resume re-record (the same upsert, a refreshed row).
    db.record_session(&session)
        .expect("re-record should succeed");
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title
            .as_deref(),
        Some("Kept title"),
        "a re-record never clears the stored title"
    );
}

/// A re-`record_session` (the resume re-record) never resets the stored
/// `cost_usd` — the `ON CONFLICT … DO UPDATE` branch touches only `cwd` /
/// `capabilities_json` / `is_subagent`, so a session that has spent money
/// keeps its figure across a resume. The seeded figures below are TOTALS (the
/// snapshot contract since Fulcrum T2), so the pin reads the LAST total.
///
/// This is load-bearing and was pinned only in prose: `record_session`'s doc
/// and `record_session_cost`'s both lean on the DO UPDATE list being narrow.
/// A future column added to that list (or the cost moved into the INSERT
/// column list with a `excluded.cost_usd` update) would silently zero a
/// resumed session's total — the figure the user sees in the sidebar would
/// reset under a reopen while the provider keeps billing, and since a parent's
/// stored total now also carries its children's money (folded into the parent's
/// accumulator), a reset base would drop that too. Mirrors
/// `record_session_preserves_the_title` /
/// `record_session_preserves_the_archived_flag` for the cost column.
#[test]
fn record_session_preserves_the_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = title_session("sess-1");
    db.record_session(&session)
        .expect("record_session should succeed");
    // The stored figure (two frames' worth of TOTALS, so the assertion is not
    // accidentally pinning "one write" rather than "no clobber"). Under the
    // snapshot contract each call overwrites with the session's running total,
    // so the row ends on the LAST total — `0.00002` — not the sum the old
    // delta pair added to (`0.00003243`).
    db.record_session_cost("sess-1", 0.00001243)
        .expect("record_session_cost should succeed");
    db.record_session_cost("sess-1", 0.00002)
        .expect("record_session_cost should succeed");
    // The resume re-record (the same upsert, a refreshed row).
    db.record_session(&session)
        .expect("re-record should succeed");
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .cost_usd,
        Some(0.00002),
        "a re-record never resets the stored cost total"
    );
    // And through the LIST read the sidebar / resume path actually uses.
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert_eq!(
        all[0].cost_usd,
        Some(0.00002),
        "the last total survives a re-record on the list read too"
    );
}

/// (ADR 0016) A re-`record_session` (the resume re-record) never clears
/// the archived flag — the `ON CONFLICT … DO UPDATE` branch must not
/// touch `archived` (no retroactive un-archive).
#[test]
fn record_session_preserves_the_archived_flag() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = SessionInfo {
        session_id: "sess-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": "sess-1",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&session)
        .expect("record_session should succeed");
    // The `is_subagent` flag is written (the `record_session` upsert).
    let row = db.session("sess-1").unwrap().unwrap();
    assert!(!row.is_subagent);
    db.set_session_archived("sess-1", true)
        .expect("set_session_archived should succeed");
    // The resume re-record (the same upsert, a refreshed row).
    db.record_session(&session)
        .expect("re-record should succeed");
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert!(
        all[0].archived,
        "a re-record never clears the archived flag"
    );
}

/// `update_session_capabilities` updates `capabilities_json` while preserving
/// `title`, `cost_usd`, and `sort_order` (the row's manual list position, ADR 0075).
#[test]
fn update_session_capabilities_updates_envelope_and_preserves_other_columns() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-caps-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = title_session("sess-1");
    db.record_session(&session)
        .expect("record_session should succeed");
    db.set_session_title("sess-1", "Kept title")
        .expect("set_session_title should succeed");
    db.record_session_cost("sess-1", 0.000042)
        .expect("record_session_cost should succeed");
    let initial_sort_order = sort_order_of(&db, "sessions", "id", "sess-1");

    let new_caps = serde_json::json!({
        "native": true,
        "model": "tama/b",
        "loadSession": true,
        "thinkingLevel": "xhigh",
    })
    .to_string();

    db.update_session_capabilities("sess-1", &new_caps)
        .expect("update_session_capabilities should succeed");

    let row = db
        .session("sess-1")
        .expect("session should succeed")
        .expect("the row exists");

    assert_eq!(row.capabilities_json, new_caps);
    assert_eq!(row.title.as_deref(), Some("Kept title"));
    assert_eq!(row.cost_usd, Some(0.000042));
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "sess-1"),
        initial_sort_order,
        "updating capabilities must never renumber sort_order (ADR 0075)"
    );
}

/// Calling `update_session_capabilities` on a non-existent session id succeeds
/// without error and creates no row (a silent no-op, mirroring `record_session_cost`).
#[test]
fn update_session_capabilities_on_a_missing_row_is_a_silent_no_op() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-caps-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");

    let caps = serde_json::json!({
        "native": true,
        "model": "tama/b",
    })
    .to_string();

    db.update_session_capabilities("nonexistent", &caps)
        .expect("a missing row is a no-op returning Ok(())");
    assert!(
        db.session("nonexistent").expect("session lookup").is_none(),
        "nothing was written for a row that does not exist"
    );
    assert!(db.list_sessions(true).expect("list_sessions").is_empty());
}

/// (ADR 0025 §3) A subagent `sessions` row (`is_subagent = 1`) is
/// HIDDEN from `list_sessions` (the `is_subagent = 0` filter) but its
/// transcript rows are still loadable (`load_native_messages` works
/// for subagent ids — it does NOT filter on `is_subagent`).
#[test]
fn list_sessions_hides_subagent_rows_but_their_transcripts_load() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-subagent-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    // A main session row.
    let main = SessionInfo {
        session_id: "main-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&main).expect("record main");
    // A subagent session row (hidden).
    let sub = SessionInfo {
        session_id: "sub-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: true,
    };
    db.record_session(&sub).expect("record subagent");
    // `list_sessions` (both variants) hides the subagent row.
    let all = db.list_sessions(true).expect("list");
    assert_eq!(all.len(), 1, "only the main session is listed");
    assert_eq!(all[0].id, "main-1");
    // The subagent's transcript is still loadable (no `is_subagent` filter).
    db.insert_native_message("sub-1", 0, "system", r#"{\"role\":\"system\"}"#)
        .expect("insert subagent transcript");
    let rows = db
        .load_native_messages("sub-1")
        .expect("load subagent transcript");
    assert_eq!(rows.len(), 1, "the subagent transcript loads");
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

/// `record_session_context_usage` persists the session's last known
/// context usage (the frontend's context-percentage display for a
/// CLOSED session — the store drops it on close, but the row keeps
/// it): `session()` / `list_sessions()` read it back, and
/// `record_session` (the resume re-record) does NOT clobber it.
#[test]
fn record_session_context_usage_persists_and_survives_record_session() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-context-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = SessionInfo {
        session_id: "sess-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": "sess-1",
            "loadSession": true,
        }),
        config_options: None,
        context_usage: None,
        cost_usd: None,
        archived: false,
        title: None,
        is_subagent: false,
    };
    db.record_session(&session)
        .expect("record_session should succeed");
    // Persist the last known usage (the `context_usage_update` frame's
    // values — the provider's `input_tokens` vs the model's window).
    db.record_session_context_usage("sess-1", 53_760, 128_000)
        .expect("record_session_context_usage should succeed");
    // `session()` reads it back.
    let row = db
        .session("sess-1")
        .expect("session should succeed")
        .unwrap();
    let usage: serde_json::Value =
        serde_json::from_str(&row.context_usage_json.unwrap()).expect("the usage is JSON");
    assert_eq!(usage["used"], 53_760);
    assert_eq!(usage["window"], 128_000);
    // `list_sessions()` reads it back too.
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert!(all[0].context_usage_json.is_some());
    // The resume re-record (the same upsert, a refreshed row) must NOT
    // clobber the persisted usage (the `record_session` DO UPDATE never
    // touches `context_usage_json`).
    db.record_session(&session)
        .expect("re-record should succeed");
    let row = db
        .session("sess-1")
        .expect("session should succeed")
        .unwrap();
    let usage: serde_json::Value = serde_json::from_str(&row.context_usage_json.unwrap())
        .expect("the usage survived the re-record");
    assert_eq!(
        usage["used"], 53_760,
        "a re-record never clobbers the context usage"
    );
}

/// `messages_page` pages newest-first by id, returns ascending order,
/// and reports `has_more` correctly across boundaries and exact fits.
#[test]
fn messages_page_paginates_and_reports_has_more() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-page-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let mk = |id: &str| SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": id,
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&mk("sess-1"))
        .expect("record_session should succeed");
    db.record_session(&mk("sess-2"))
        .expect("record_session should succeed");

    for i in 0..7 {
        db.record_message("sess-1", "agent-text", Some(&format!("k{i}")), "{}")
            .expect("record_message should succeed");
    }
    for i in 0..2 {
        db.record_message("sess-2", "agent-text", Some(&format!("k2_{i}")), "{}")
            .expect("record_message should succeed");
    }

    // messages_page(s, None, Some(3)) returns the LAST 3 in ascending order with has_more == true
    let (p1, has_more) = db
        .messages_page("sess-1", None, Some(3))
        .expect("messages_page should succeed");
    assert_eq!(p1.len(), 3);
    assert!(has_more);
    assert_eq!(p1[0].message_key.as_deref(), Some("k4"));
    assert_eq!(p1[1].message_key.as_deref(), Some("k5"));
    assert_eq!(p1[2].message_key.as_deref(), Some("k6"));
    assert!(p1.iter().all(|r| r.session_id == "sess-1"));

    // messages_page(s, Some(<oldest returned id>), Some(3)) returns the previous 3 ascending, has_more == true
    let oldest_id = p1[0].id;
    let (p2, has_more) = db
        .messages_page("sess-1", Some(oldest_id), Some(3))
        .expect("messages_page should succeed");
    assert_eq!(p2.len(), 3);
    assert!(has_more);
    assert_eq!(p2[0].message_key.as_deref(), Some("k1"));
    assert_eq!(p2[1].message_key.as_deref(), Some("k2"));
    assert_eq!(p2[2].message_key.as_deref(), Some("k3"));
    assert!(p2.iter().all(|r| r.session_id == "sess-1"));

    // the next page returns 1 row with has_more == false
    let oldest_id_p2 = p2[0].id;
    let (p3, has_more) = db
        .messages_page("sess-1", Some(oldest_id_p2), Some(3))
        .expect("messages_page should succeed");
    assert_eq!(p3.len(), 1);
    assert!(!has_more);
    assert_eq!(p3[0].message_key.as_deref(), Some("k0"));
    assert!(p3.iter().all(|r| r.session_id == "sess-1"));

    // messages_page(s, None, Some(7)) returns 7 with has_more == false (exact fit)
    let (p_all, has_more) = db
        .messages_page("sess-1", None, Some(7))
        .expect("messages_page should succeed");
    assert_eq!(p_all.len(), 7);
    assert!(!has_more);
    assert_eq!(p_all[0].message_key.as_deref(), Some("k0"));
    assert_eq!(p_all[6].message_key.as_deref(), Some("k6"));
    assert!(p_all.iter().all(|r| r.session_id == "sess-1"));

    // messages_page(s, None, None) equals messages_for(s) with has_more == false
    let (p_none, has_more) = db
        .messages_page("sess-1", None, None)
        .expect("messages_page should succeed");
    let for_all = db
        .messages_for("sess-1")
        .expect("messages_for should succeed");
    assert_eq!(p_none, for_all);
    assert!(!has_more);

    // the other session's rows never appear
    assert!(p_all.iter().all(|r| r.session_id == "sess-1"));
    let (p_sess2, has_more2) = db
        .messages_page("sess-2", None, None)
        .expect("messages_page should succeed");
    assert_eq!(p_sess2.len(), 2);
    assert!(!has_more2);
    assert!(p_sess2.iter().all(|r| r.session_id == "sess-2"));
}

#[test]
fn record_session_todos_roundtrips_and_clears() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-todos-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    // Initially None
    assert_eq!(db.session_todos("s1").unwrap(), None);

    // Roundtrips Some
    let todos = r#"[{"content":"task1","status":"pending"}]"#;
    db.record_session_todos("s1", Some(todos)).unwrap();
    assert_eq!(db.session_todos("s1").unwrap(), Some(todos.to_string()));

    // None clears to None
    db.record_session_todos("s1", None).unwrap();
    assert_eq!(db.session_todos("s1").unwrap(), None);

    // Missing session id is a no-op returning Ok(()) and session_todos returns None
    db.record_session_todos("nonexistent", Some(todos)).unwrap();
    assert_eq!(db.session_todos("nonexistent").unwrap(), None);
}

/// A `cost_update` frame's TOTAL is stored as-is (issue #105; snapshot contract
/// per Fulcrum T2's amendment of ADR 0082's limit 7): the stored figure EQUALS
/// the last frame's cumulative total, and the first frame turns the row's
/// `NULL` ("never reported") into a figure.
///
/// Superseded shape: this pin used to assert `0.0001 + 0.0001 = 0.0002` because
/// the wire carried per-call DELTAS and the Supervisor summed them. The frames
/// now carry the running total, so the second frame of the pair below is
/// `0.0002` as a TOTAL and the store's job is only to keep the newest snapshot —
/// which is why the accumulation now happens on the emitter, not here.
#[test]
fn a_cost_frame_accumulates_into_the_stored_figure() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    // Before any frame: no figure at all (NOT a zero).
    assert_eq!(db.session_cost("s1").unwrap(), None);

    // One frame: the first TOTAL lands verbatim — the first frame creates the
    // figure out of the row's `NULL`.
    db.record_session_cost("s1", 0.0001).unwrap();
    let after_one = db.session_cost("s1").unwrap().expect("a figure exists");
    assert!(
        (after_one - 0.0001).abs() < 1e-12,
        "the first frame stores its own total, got {after_one}"
    );

    // The second frame carries the CUMULATIVE total (`0.0002` = the same two
    // calls the old delta pair summed to) and the row reads exactly that.
    db.record_session_cost("s1", 0.0002).unwrap();
    let after_two = db.session_cost("s1").unwrap().expect("a figure exists");
    assert!(
        (after_two - 0.0002).abs() < 1e-12,
        "the row holds the LAST frame's total, got {after_two}"
    );

    // The stored figure is the row's own column — `session()` and
    // `list_sessions()` both project it (the two queries stay in lockstep),
    // which is what lets a CLOSED session keep its figure (issue #105).
    let row = db.session("s1").unwrap().expect("the row is there");
    let stored = row.cost_usd.expect("the row carries the figure");
    assert!(
        (stored - 0.0002).abs() < 1e-12,
        "`session()` reads the last total, got {stored}"
    );
    let listed = db.list_sessions(true).expect("list_sessions").remove(0);
    let listed = listed.cost_usd.expect("the listed row carries the figure");
    assert!(
        (listed - 0.0002).abs() < 1e-12,
        "`list_sessions()` reads the last total, got {listed}"
    );
}

/// `NULL` and `Some(0.0)` are DIFFERENT stored values (issue #105, D5,
/// ADR 0082). This is the D5 pin: "no call ever reported a cost" renders
/// NOTHING and "a call reported a real zero" renders `$0.00` — collapsing
/// them is the phantom-`$0.00` defect, so the distinction has to survive
/// the write → read round-trip, not just the wire.
#[test]
fn a_null_cost_and_a_real_zero_are_different() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    // A fresh row: NO figure. Not `Some(0.0)` — `None`.
    assert_eq!(
        db.session_cost("s1").unwrap(),
        None,
        "a session that never reported a cost reads None, not 0.0"
    );
    let row = db.session("s1").unwrap().expect("the row is there");
    assert_eq!(
        row.cost_usd, None,
        "`session()` reports absence, not a fabricated zero"
    );

    // A call that reported a REAL zero turns `NULL` into `Some(0.0)` — a
    // figure, distinguishable from the absence above.
    db.record_session_cost("s1", 0.0).unwrap();
    assert_eq!(
        db.session_cost("s1").unwrap(),
        Some(0.0),
        "a reported zero is a figure and must survive the round-trip as Some(0.0)"
    );
    let row = db.session("s1").unwrap().expect("the row is there");
    assert_eq!(row.cost_usd, Some(0.0), "`session()` agrees");
    let listed = db.list_sessions(true).expect("list_sessions").remove(0);
    assert_eq!(listed.cost_usd, Some(0.0), "`list_sessions()` agrees");
}

/// A REPLAYED `cost_update` frame OVERWRITES the stored figure to the SAME
/// value — it cannot double (Fulcrum T2, amending ADR 0082's limit 7).
///
/// This is the replacement for `a_replayed_cost_frame_doubles_the_stored_figure`,
/// which that test's own docblock and `persist.rs`'s module doc both said must
/// be DELETED — not adjusted — the moment the write became idempotent. It did:
/// a frame now carries the session's CUMULATIVE total, so the write is a
/// snapshot `UPDATE … SET cost_usd = ?2` and re-delivering the same frame is a
/// no-op by construction, with nothing to dedupe on.
///
/// The shape of the assertion is what makes it a pin rather than a tautology:
/// it asserts the SECOND read equals the FIRST (a snapshot), and it asserts the
/// value is the frame's own total and NOT `2 × frame` — the increment this
/// method used to perform would satisfy the first reading of "still a figure"
/// while failing both.
#[test]
fn a_replayed_cost_frame_overwrites_to_the_same_figure() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    let frame = 0.0000341;
    db.record_session_cost("s1", frame).unwrap();
    let once = db.session_cost("s1").unwrap().expect("a figure exists");
    // Arm the doubling check BEFORE the replay: under the retired increment the
    // stored figure after the second write is `2 × frame`, so the delta below
    // is ~`frame` and this fails for the reason the pin exists to catch — a
    // replay that GROWS the figure. (A `twice == once` assertion alone would
    // also fail on a float wobble; this one names the growth.)
    db.record_session_cost("s1", frame).unwrap();
    let twice = db.session_cost("s1").unwrap().expect("a figure exists");
    let growth = twice - once;
    assert!(
        growth.abs() < 1e-12,
        "a replayed TOTAL frame must leave the figure exactly where it was; \
         the stored figure grew by {growth} (the retired increment would grow \
         it by a whole frame, {frame}): once={once}, twice={twice}"
    );
    assert!(
        (twice - frame).abs() < 1e-12,
        "the stored figure IS the frame's total, not `2 × frame` \
         (the retired increment): got {twice}, frame={frame}"
    );

    // A LATER, larger total replaces the earlier one — the store tracks the
    // newest snapshot, it does not remember the highest.
    db.record_session_cost("s1", 0.00009).unwrap();
    let moved = db.session_cost("s1").unwrap().expect("a figure exists");
    assert!(
        (moved - 0.00009).abs() < 1e-12,
        "a newer total replaces the older snapshot, got {moved}"
    );
    // And a replay of THAT frame is a no-op too.
    db.record_session_cost("s1", 0.00009).unwrap();
    let replayed = db.session_cost("s1").unwrap().expect("a figure exists");
    assert!(
        (replayed - 0.00009).abs() < 1e-12,
        "the second replay is also a no-op, got {replayed}"
    );
}

/// `record_session_cost` on a MISSING row is a silent `Ok(())` and writes
/// nothing (issue #105, Trap 1's evidence).
///
/// This mirrors `record_session_todos_roundtrips_and_clears`'s last two
/// lines for the sibling method, and it is NOT an oversight to be "fixed"
/// into an error: it is the proof that the CALLER — `apply_interactive_event`,
/// via `ensure_session_row` — is responsible for the row's existence. A
/// subagent's first `cost_update` can arrive before any `StoreFrame` has
/// created its row, and a bare `UPDATE … WHERE id = ?1` would then discard
/// the money without a sound. This method's silence is why the cost arm has
/// to ensure the row first.
#[test]
fn record_session_cost_on_a_missing_row_is_a_silent_no_op() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");

    // No `record_session`, no row. The write succeeds and touches nothing.
    db.record_session_cost("nonexistent", 0.0001)
        .expect("a missing row is a no-op returning Ok(())");
    assert_eq!(
        db.session_cost("nonexistent").unwrap(),
        None,
        "nothing was written for a row that does not exist"
    );
    // And no row was CREATED by the attempt (an upsert here would be the
    // wrong fix — `ensure_session_row` owns row creation).
    assert!(db.list_sessions(true).expect("list_sessions").is_empty());
}

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

/// The pre-`sort_order` schema: the current `SCHEMA` with the
/// `sort_order` column absent from BOTH `sessions` and `spaces` — i.e.
/// exactly what a database written before the manual-order columns looks
/// like. `native_messages` keeps its FK so the phase-10 FK migration
/// stays quiet and the fixture exercises only the seed under test.
fn create_pre_sort_order_db(path: &Path) {
    let conn = Connection::open(path).expect("raw open of the fixture db");
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
            todos_json TEXT
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
        );",
    )
    .expect("fixture schema should build");
    drop(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// The pre-existing-database fixture for the migration-gate cluster.
//
// The five pre-existing-database gate tests each used to open a raw
// `Connection`, hand-write a schema with ONE column missing, seed rows and drop
// the conn —
// five copies of the same skeleton. `preexisting_db` owns that skeleton; the
// `SCHEMA_WITHOUT_*` constants below are its only schema argument.
//
// ISOLATION IS THE LOAD-BEARING PROPERTY OF THESE STRINGS. Each is the full
// 5-table `CREATE` batch (sessions + stages + spaces + messages +
// native_messages) with EXACTLY ONE gate's column absent and every OTHER
// gated column present, so `Db::open`'s other gates find their column and stay
// SILENT: the test observes its own gate, not twelve gates at once. Two of the
// five fixtures were NOT isolated before this consolidation (the `archived` one
// also omitted `trusted`, both `sort_order`s, `context_usage_json`,
// `is_subagent`, `todos_json` and `cost_usd`, and carried `agent_id` — so it
// also ran the pre-rip-out purge and both seeds; the `context_usage` one was
// similar). Making them isolated is the point of the change; the gate under
// test is unchanged in every case, and each gate keeps its own dedicated test.
//
// That is also why `create_pre_sort_order_db` must NEVER serve these five: its
// schema omits BOTH `sort_order` columns at once, so handing it to (say) the
// `archived` test would run the two sort-order SEEDS inside a test that is about
// `archived` — the isolation collapse the plan forbids. It stays in use for the
// five pre-0075 fixtures that genuinely want both columns absent.
// ─────────────────────────────────────────────────────────────────────────────

/// The `spaces` table as a post-trust, post-sort_order database has it — the
/// half every cluster fixture uses EXCEPT the one whose gate owns this table.
/// (A macro rather than a `const`, because [`legacy_batch!`] concatenates
/// literals.)
macro_rules! legacy_spaces_with_sort_order {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `spaces` table WITHOUT `sort_order` (`trusted` and `board_strict`
/// present, so the trust and strict-workflow gates stay quiet) — only the space
/// sort-order gate can fire on it. `board_strict` MUST be here: a fixture that
/// dropped it too would omit TWO gated columns and run two gates.
macro_rules! legacy_spaces_without_sort_order {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `spaces` table WITHOUT `board_strict` (`trusted` and `sort_order`
/// present) — only the strict-workflow gate can fire on it.
macro_rules! legacy_spaces_without_board_strict {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `sessions` table with EVERY gated column present — the spelling every
/// fixture that is not about a `sessions` gate uses, so those gates stay quiet.
macro_rules! legacy_sessions_complete {
    () => {
        "
CREATE TABLE sessions (
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
    title_stage INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `stages` table as a post-#179 database has it — BOTH new columns present,
/// so neither `stages` gate fires. EVERY cluster fixture carries this spelling
/// except the two whose gate owns this table: `Db::open` probes `stages` too
/// now, so a fixture with NO `stages` table at all would count as omitting both
/// columns and break the isolation assert on all eight fixtures at once.
macro_rules! legacy_stages_complete {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    on_enter_skill TEXT,
    next_slugs TEXT,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `on_enter_skill` (`next_slugs` present) — only the
/// Stage-Skill gate can fire on it.
macro_rules! legacy_stages_without_on_enter_skill {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    next_slugs TEXT,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `next_slugs` (`on_enter_skill` present) — only the
/// transition-graph gate can fire on it.
macro_rules! legacy_stages_without_next_slugs {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    on_enter_skill TEXT,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table as pre-#179 code wrote it — NEITHER new column. For the
/// migration tests ONLY (a cluster fixture must never use it: it omits two
/// gated columns at once, which is the isolation collapse the cluster pin
/// forbids).
macro_rules! legacy_stages_pre_task_board_config {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `messages` + `native_messages` half of every fixture here — no gate in
/// this cluster touches either table. `native_messages` carries its
/// `ON DELETE CASCADE` FK, so `Db::open`'s FK-rewrite batch stays quiet on every
/// fixture below; a fixture that omitted the FK would be testing that rewrite,
/// not its own gate.
macro_rules! legacy_tail {
    () => {
        "
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
"
    };
}

/// Assemble one legacy fixture batch: the `sessions` DDL the caller spells as a
/// literal, the `spaces` spelling the caller picks, and the two tables NO gate in
/// this cluster touches.
///
/// A macro rather than a function or `const` concatenation because `&str`
/// concatenation is not a const operation and `concat!` needs LITERALS — hence
/// the `sessions` DDL arriving as a literal argument, and the two `spaces`
/// spellings plus the tail living here once each so no fixture can invent its own.
///
/// `stages` defaults to [`legacy_stages_complete!`]: `Db::open` probes `stages`
/// for two gated columns now, so a fixture that omitted the table entirely would
/// count as omitting BOTH and run two gates — the isolation collapse the cluster
/// pin below exists to catch. A fixture whose gate owns `stages` (or `spaces`)
/// picks that arm instead.
macro_rules! legacy_batch {
    ($sessions:expr, spaces_with_sort_order) => {
        concat!(
            $sessions,
            legacy_stages_complete!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    ($sessions:expr, spaces_without_sort_order) => {
        concat!(
            $sessions,
            legacy_stages_complete!(),
            legacy_spaces_without_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, stages_without_on_enter_skill) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_on_enter_skill!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, stages_without_next_slugs) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_next_slugs!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, spaces_without_board_strict) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_complete!(),
            legacy_spaces_without_board_strict!(),
            legacy_tail!()
        )
    };
}

/// The full 5-table batch with ONLY `sessions.archived` missing. Every other
/// gated column is present, so the sibling gates are no-ops on this fixture.
/// `agent_id` is absent too: the pre-rip-out purge is a DIFFERENT gate with its
/// own test (`opening_a_pre_rip_out_database_migrates_it`), and a fixture that
/// carried the column would run that purge as a side effect.
const SCHEMA_WITHOUT_ARCHIVED: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `sessions.context_usage_json` missing.
const SCHEMA_WITHOUT_CONTEXT_USAGE: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `sessions.cost_usd` missing — the isolation
/// the `dflt_value` pin depends on.
const SCHEMA_WITHOUT_COST_USD: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `spaces.sort_order` missing (`sessions` is
/// complete, so the SESSION seed cannot fire — that is the isolation this
/// constant exists to provide).
const SCHEMA_WITHOUT_SPACE_SORT_ORDER: &str = legacy_batch!(
    "
CREATE TABLE sessions (
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
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_without_sort_order
);

/// The full 5-table batch with ONLY `sessions.sort_order` missing (`spaces` is
/// complete, so the SPACE seed cannot fire).
const SCHEMA_WITHOUT_SESSION_SORT_ORDER: &str = legacy_batch!(
    "
CREATE TABLE sessions (
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
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `stages.on_enter_skill` missing (`sessions`
/// and `spaces` are complete, so no sibling gate fires — and the gate this
/// fixture isolates now backfills only the `research` Skill; the migration claim
/// lives in `the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row`).
const SCHEMA_WITHOUT_STAGES_ON_ENTER_SKILL: &str =
    legacy_batch!(complete_sessions, stages_without_on_enter_skill);

/// The full 5-table batch with ONLY `stages.next_slugs` missing — the plain
/// single-ALTER gate (deliberately NO data step, ADR 0099: NULL = unconfigured).
const SCHEMA_WITHOUT_STAGES_NEXT_SLUGS: &str =
    legacy_batch!(complete_sessions, stages_without_next_slugs);

/// The full 5-table batch with ONLY `spaces.board_strict` missing — the plain
/// single-ALTER gate for the Strict-workflow opt-in.
const SCHEMA_WITHOUT_SPACES_BOARD_STRICT: &str =
    legacy_batch!(complete_sessions, spaces_without_board_strict);

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

/// Create a legacy database file WITHOUT opening `Db` — raw SQLite only.
///
/// `Db::open` is the code under test here (its gates are what these tests
/// observe), so the fixture must be the raw file: this factory never opens a
/// `Db`, and the conn is dropped before returning so `Db::open` gets the file
/// to itself.
///
/// `legacy_schema` is the full 5-table `CREATE` batch with the ONE gated column
/// under test missing and every OTHER gated column present (see the
/// `SCHEMA_WITHOUT_*` constants — get this wrong and a sibling gate runs inside
/// the test); `rows` seeds the pre-existing data.
fn preexisting_db(dir: &Path, legacy_schema: &str, rows: &str) -> std::path::PathBuf {
    let path = dir.join("t.db");
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    conn.execute_batch(&format!(
        "{legacy_schema}{rows}",
        legacy_schema = legacy_schema,
        rows = rows
    ))
    .expect("fixture schema");
    drop(conn);
    path
}

/// Reads a single TEXT column through the raw connection (the row structs
/// never select `sort_order`, so the seed assertions go straight to SQL).
fn raw_column(db: &Db, sql: &str) -> Vec<String> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let rows = guard
        .prepare(sql)
        .expect("prepare should succeed")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query should succeed")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should read");
    rows
}

/// The same for an INTEGER column (the `sort_order` values themselves).
fn raw_i64s(db: &Db, sql: &str) -> Vec<i64> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let rows = guard
        .prepare(sql)
        .expect("prepare should succeed")
        .query_map([], |row| row.get::<_, i64>(0))
        .expect("query should succeed")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should read");
    rows
}

/// One row's `sort_order`, keyed by a TEXT primary key (a path or an id).
fn sort_order_of(db: &Db, table: &str, key_column: &str, key: &str) -> i64 {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            &format!(
                "SELECT sort_order FROM {table} WHERE {key_column} = ?1",
                table = table,
                key_column = key_column
            ),
            params![key],
            |row| row.get(0),
        )
        .expect("sort_order should read")
}

/// The one scalar of an INTEGER column (a `COUNT(*)`-shaped assertion).
fn raw_scalar(db: &Db, sql: &str) -> i64 {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(sql, [], |row| row.get(0))
        .expect("scalar query should succeed")
}

/// A minimal session shape on a caller-supplied cwd (the
/// `record_session_preserves_the_archived_flag` literal, with the cwd
/// and the subagent flag left to the caller).
fn session_on(id: &str, cwd: &Path, is_subagent: bool) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: cwd.to_path_buf(),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent,
    }
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

/// A NEW space row joins the list at the BOTTOM (`MAX + 1`), not at the
/// top and not by name. Asserted through raw SQL because `list_spaces`
/// still sorts by recency until the `ORDER BY` swap.
///
/// The dir names are chosen so that INSERTION order is NOT `path ASC`
/// order — otherwise the `path ASC` tie-break would satisfy the assertion
/// on its own and the test would pass vacuously.
#[test]
fn upsert_space_new_row_joins_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacebottom-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = dir.join("zzz-first-inserted");
    let b = dir.join("mmm-second-inserted");
    let c = dir.join("aaa-third-inserted");
    for d in [&a, &b, &c] {
        std::fs::create_dir_all(d).unwrap();
    }
    db.upsert_space(a.to_str().unwrap(), false)
        .expect("upsert a");
    db.upsert_space(b.to_str().unwrap(), false)
        .expect("upsert b");
    db.upsert_space(c.to_str().unwrap(), false)
        .expect("upsert c");

    let keys: Vec<String> = [a, b, c]
        .iter()
        .map(|d| std::fs::canonicalize(d).unwrap().display().to_string())
        .collect();
    let order = raw_column(
        &db,
        "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC",
    );
    assert_eq!(
        order, keys,
        "rows come back in INSERTION order, i.e. each new row joined at the bottom"
    );
    assert_eq!(
        raw_i64s(&db, "SELECT sort_order FROM spaces ORDER BY sort_order ASC"),
        vec![0, 1, 2],
        "the numbers grow from the bottom, one per row"
    );
}

/// A RE-TOUCH never renumbers: the `ON CONFLICT … DO UPDATE` branch
/// refreshes `last_opened_at` and must not touch `sort_order`. This is the
/// feature (a click must not move the tab) and simultaneously the resume
/// hazard (a re-touch used to be what moved a row to the top).
///
/// The dir names make INSERTION order contradict `path ASC`, so the
/// assertion cannot be satisfied by the tie-break on rows that all still
/// carry `DEFAULT 0`.
#[test]
fn upsert_space_retouch_does_not_renumber() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spaceretouch-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = dir.join("zzz-first-and-retouched");
    let b = dir.join("aaa-second");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let key_a = std::fs::canonicalize(&a).unwrap().display().to_string();
    let key_b = std::fs::canonicalize(&b).unwrap().display().to_string();

    db.upsert_space(a.to_str().unwrap(), false)
        .expect("upsert a");
    db.upsert_space(b.to_str().unwrap(), false)
        .expect("upsert b");
    db.upsert_space(a.to_str().unwrap(), false)
        .expect("re-touch a");

    assert_eq!(
        sort_order_of(&db, "spaces", "path", &key_a),
        0,
        "a re-touched row keeps the number it joined at"
    );
    assert_eq!(
        raw_column(
            &db,
            "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC"
        ),
        vec![key_a, key_b],
        "the re-touched row did not move"
    );
}

/// A NEW session row joins at the BOTTOM too. The ids are chosen so `id
/// DESC` (the old tie-break) contradicts insertion order, so the assertion
/// cannot be satisfied by the tie-break alone.
#[test]
fn record_session_new_row_joins_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sessbottom-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.record_session(&session_on("s_first", Path::new("/tmp/proj"), false))
        .expect("record s_first");
    db.record_session(&session_on("s_second", Path::new("/tmp/proj"), false))
        .expect("record s_second");

    assert_eq!(
        raw_column(
            &db,
            "SELECT id FROM sessions ORDER BY sort_order ASC, id DESC"
        ),
        vec!["s_first", "s_second"],
        "rows come back in RECORD order, i.e. each new row joined at the bottom"
    );
    assert_eq!(
        raw_i64s(
            &db,
            "SELECT sort_order FROM sessions ORDER BY sort_order ASC"
        ),
        vec![0, 1],
        "the numbers grow from the bottom, one per row"
    );
}

/// A RE-RECORD never renumbers: a resume re-runs `record_session`, and the
/// `ON CONFLICT … DO UPDATE` branch must leave the row's position alone.
///
/// A second row is recorded alongside the re-recorded one on purpose: with
/// only one row in the table every number is `0` and "unchanged" is
/// trivially true, so the neighbouring row is what makes the assertion
/// observable (its id is below the re-recorded one so the `id DESC`
/// tie-break cannot hide a shared number).
#[test]
fn record_session_re_record_does_not_renumber() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sessretouch-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let resumed = session_on("s_resumed", Path::new("/tmp/proj"), false);
    db.record_session(&resumed)
        .expect("record s_resumed (it joins at 0)");
    db.record_session(&session_on("s_other", Path::new("/tmp/proj"), false))
        .expect("record s_other (it joins below at 1)");
    db.record_session(&resumed)
        .expect("re-record s_resumed (the resume path re-runs record_session)");

    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_resumed"),
        0,
        "the re-recorded row keeps the number it joined at"
    );
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_other"),
        1,
        "and the row below it is not dragged up or pushed down by the re-record"
    );
}

/// (hazard H4) The phase-11 space-backfill INSERT carries the same
/// bottom-join expression. On this upgrade path — stored sessions, an
/// EMPTY `spaces` table — the seed numbers nothing, so an unpatched
/// `DEFAULT 0` would tie every backfilled row and hand the user an
/// alphabetical list on the very boot the spec promises is unchanged.
///
/// Asserted ORDER-AGNOSTICALLY on purpose: the backfill reads
/// `SELECT DISTINCT cwd FROM sessions`, which has no defined order, so the
/// test pins distinctness only and never encodes that nondeterminism.
#[test]
fn backfilled_space_rows_join_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacebackfill-test-", "scratch");
    let path = dir.join("t.db");
    let cwd_a = dir.join("cwd_a");
    let cwd_b = dir.join("cwd_b");
    // The cwds MUST exist for the backfill's canonicalization.
    std::fs::create_dir_all(&cwd_a).unwrap();
    std::fs::create_dir_all(&cwd_b).unwrap();
    create_pre_sort_order_db(&path);
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    for (id, cwd) in [("s_a", &cwd_a), ("s_b", &cwd_b)] {
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
             VALUES (?1, ?2, 1, '{}', 0)",
            params![id, cwd.display().to_string()],
        )
        .expect("fixture session row");
    }
    drop(conn);

    let db = Db::open(&path).expect("the backfill must number its rows");
    let total = raw_scalar(&db, "SELECT COUNT(*) FROM spaces");
    let distinct = raw_scalar(&db, "SELECT COUNT(DISTINCT sort_order) FROM spaces");
    let at_zero = raw_scalar(&db, "SELECT COUNT(*) FROM spaces WHERE sort_order = 0");
    assert_eq!(total, 2, "the backfill created one row per existing cwd");
    assert_eq!(
        distinct, 2,
        "the backfilled rows carry DISTINCT numbers — the seed numbered nothing here, \
         so an unpatched INSERT leaves every row on DEFAULT 0"
    );
    assert_eq!(
        at_zero, 1,
        "exactly one row sits at 0 — not every backfilled row tied there"
    );
}
/// `reorder_spaces` writes the given slice as `sort_order`, in one call:
/// the slice INDEX becomes the value, so the list comes back exactly as
/// handed and the numbers are the dense `0..n` the caller implied.
#[test]
fn reorder_spaces_writes_the_given_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reordersp-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let keys = ["aaa", "mmm", "zzz"].map(|n| {
        let d = dir.join(n);
        std::fs::create_dir_all(&d).unwrap();
        d
    });
    for d in &keys {
        db.upsert_space(d.to_str().unwrap(), false)
            .expect("upsert_space should succeed");
    }
    // The canonical keys — exactly the strings `list_spaces()` returns, which
    // is where the frontend's ids come from.
    let paths: Vec<String> = keys
        .iter()
        .map(|d| std::fs::canonicalize(d).unwrap().display().to_string())
        .collect();
    let (a, b, c) = (paths[0].clone(), paths[1].clone(), paths[2].clone());
    // The dragged order the plan names: `[c, a, b]`.
    let wanted = vec![c.clone(), a.clone(), b.clone()];

    db.reorder_spaces(&wanted)
        .expect("reorder_spaces should succeed");

    let listed: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        listed, wanted,
        "the list comes back in the order the caller passed"
    );
    assert_eq!(
        raw_i64s(&db, "SELECT sort_order FROM spaces ORDER BY sort_order ASC"),
        vec![0, 1, 2],
        "the slice index became the value, densely from 0"
    );
    assert_eq!(sort_order_of(&db, "spaces", "path", &c), 0);
    assert_eq!(sort_order_of(&db, "spaces", "path", &a), 1);
    assert_eq!(sort_order_of(&db, "spaces", "path", &b), 2);
}

/// A reorder is PERSISTED work, not a view: it survives a close + re-open,
/// i.e. the one-time seed gate stays closed and does not clobber the order.
#[test]
fn reorder_spaces_survives_a_reopen() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reopentest-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let keys: Vec<String> = ["aaa", "mmm", "zzz"]
        .iter()
        .map(|n| {
            let d = dir.join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    for k in &keys {
        db.upsert_space(k, false)
            .expect("upsert_space should succeed");
    }
    let wanted = vec![keys[2].clone(), keys[0].clone(), keys[1].clone()];
    db.reorder_spaces(&wanted)
        .expect("reorder_spaces should succeed");
    drop(db);

    let db = Db::open(&path).expect("re-open must succeed");
    let listed: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        listed, wanted,
        "the reorder survives the re-open — the seed gate did not fire and did not renumber"
    );
}

/// An id the caller never heard of is a NO-OP, not an error, and it still
/// occupies its slot: the slice index is the value, so the two known rows
/// land at 1 and 2. This pins the documented semantics rather than leaving
/// them undefined.
#[test]
fn reorder_spaces_with_an_unknown_path_is_not_an_error() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reordernope-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let keys: Vec<String> = ["aaa", "mmm"]
        .iter()
        .map(|n| {
            let d = dir.join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    for k in &keys {
        db.upsert_space(k, false)
            .expect("upsert_space should succeed");
    }

    let unknown = format!("/nope-{}", uuid::Uuid::new_v4());
    let slice = vec![unknown, keys[0].clone(), keys[1].clone()];
    assert!(
        db.reorder_spaces(&slice).is_ok(),
        "an id matching no row updates nothing and is not an error"
    );
    assert_eq!(
        sort_order_of(&db, "spaces", "path", &keys[0]),
        1,
        "the unknown id occupied slot 0, so the first known row is at 1"
    );
    assert_eq!(
        sort_order_of(&db, "spaces", "path", &keys[1]),
        2,
        "and the second known row at 2"
    );
}

/// `reorder_sessions` writes the visible slice's order AND renumbers hidden
/// subagent rows too (hazard H1's consequence: the bottom-join `MAX + 1` is
/// global, so a hidden row occupies a number and the caller may legitimately
/// hand one back). `list_sessions` filters `is_subagent = 0`, so the hidden
/// row never appears in ANY `list_*` result and the ONLY witness that its
/// number moved is raw SQL against the connection.
#[test]
fn reorder_sessions_writes_the_given_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reorderses-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let cwd = Path::new("/tmp/proj");
    for id in ["s_0", "s_1", "s_2"] {
        db.record_session(&session_on(id, cwd, false))
            .expect("record_session should succeed");
    }
    db.record_session(&session_on("s_hidden", cwd, true))
        .expect("record the subagent row");
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_hidden"),
        3,
        "the hidden row consumed the next global number"
    );

    // The hidden row goes to the FRONT, so its number provably moves 3 → 0;
    // the visible three keep the relative order the plan names.
    let slice: Vec<String> = ["s_hidden", "s_2", "s_0", "s_1"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    db.reorder_sessions(&slice)
        .expect("reorder_sessions should succeed");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_2", "s_0", "s_1"],
        "the visible rows come back in the order the caller passed"
    );
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_hidden"),
        0,
        "the hidden subagent row was renumbered by id like any other"
    );
    drop(db);

    let db = Db::open(&path).expect("re-open must succeed");
    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_2", "s_0", "s_1"],
        "the reorder survives the re-open"
    );
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_hidden"),
        0,
        "and the hidden row's new number survives it too"
    );
}

/// A reorder renumbers ONLY the slice it was handed. The sidebar passes the
/// visible sessions of ONE Space, so another Space's rows keep their old
/// numbers and therefore COLLIDE with the freshly written ones — the expected
/// steady state of a global numbering with per-Space drags, not corruption
/// this call should have repaired.
///
/// The fixture records a1, b1, b2, a2 so Space A's two rows STRADDLE B's;
/// record them a1, a2, b1, b2 and no collision is possible at all.
#[test]
fn reorder_sessions_is_per_space_even_when_numbers_collide_across_spaces() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reorderps-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    // Canonical cwds, so the `cwd` string the rows store is the string we filter on.
    let dir_a = dir.join("space_a");
    let dir_b = dir.join("space_b");
    std::fs::create_dir_all(&dir_a).unwrap();
    std::fs::create_dir_all(&dir_b).unwrap();
    let a = std::fs::canonicalize(&dir_a).unwrap();
    let b = std::fs::canonicalize(&dir_b).unwrap();
    for id in ["a1", "b1", "b2", "a2"] {
        let cwd = if id.starts_with('a') { &a } else { &b };
        db.record_session(&session_on(id, cwd, false))
            .expect("record_session should succeed");
    }

    // Drag Space A's two visible rows only — B's rows are never passed.
    let slice: Vec<String> = ["a2", "a1"].iter().map(|s| s.to_string()).collect();
    db.reorder_sessions(&slice)
        .expect("reorder_sessions should succeed");

    let listed = db
        .list_sessions(false)
        .expect("list_sessions should succeed");
    let of = |root: &Path| -> Vec<String> {
        listed
            .iter()
            .filter(|r| r.cwd == root.display().to_string())
            .map(|r| r.id.clone())
            .collect()
    };
    assert_eq!(
        of(&a),
        vec!["a2", "a1"],
        "the dragged Space reads in the dragged order"
    );
    assert_eq!(
        of(&b),
        vec!["b1", "b2"],
        "the untouched Space keeps its own order, whatever the numbers now say"
    );
    let total = raw_scalar(&db, "SELECT COUNT(*) FROM sessions");
    let distinct = raw_scalar(&db, "SELECT COUNT(DISTINCT sort_order) FROM sessions");
    assert_eq!(
        (total, distinct),
        (4, 3),
        "`a1` now sits exactly where `b1` already was — a duplicate number \
         across Spaces is expected, and `ORDER BY sort_order ASC, id DESC` is \
         still total so every read stays deterministic"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The mapper drift guards (finding 12's PRIMARY guard).
//
// The hazard these exist for: a `SessionRow`/`MessageRow`/`SpaceRow` used to be
// built beside its own literal `SELECT` list, so a column added to (or moved
// in) the list without the positional ladder COMPILES and mis-maps at runtime.
// The const list + one mapper per type made the pair visible in one place;
// THESE tests are what make the pair checked.
//
// `column_count() == *_ROW_FIELDS` is asserted FIRST, before any value, so an
// APPENDED column reddens the very first assertion with a message that names
// the real problem (SELECT-vs-mapper arity) instead of failing later behind a
// chain of value mismatches. A reorder, a mid-insert or a removal breaks at
// least one of the value asserts that follow — every stored value is
// column-distinct for exactly that reason.
//
// HONEST SCOPE (see the plan's drift-proof): this test is the guard. The
// compile-time arity tie catches only a half-renumbered pair of literals, and
// the typed `get::<_, i64>` calls only turn a DDL TYPE change into a loud
// runtime conversion error. Neither sees the SELECT statement.
//
// These tests pass on their first run — no drift exists today (all three lists
// were verified byte-identical to their ladders before this change). They are
// standing guards: they go red the moment a drift is introduced.
// ─────────────────────────────────────────────────────────────────────────────

/// The PRIMARY guard for `SessionRow`: the SELECT the const builds and the
/// ladder in `session_row_from` agree in LENGTH (asserted first) and in ORDER
/// (asserted by the column-distinct values).
#[test]
fn session_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-session-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    // ONE self-identifying row: every stored value is its own column's name or
    // a distinct number. `archived` and `is_subagent` are deliberately
    // DIFFERENT (1 and 0) — two booleans both set to 1 could be swapped
    // without any value assert noticing, which would defeat the guard.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO sessions (id, cwd, created_at, title, capabilities_json,
                                   archived, context_usage_json, is_subagent, cost_usd)
             VALUES ('id', 'cwd', 2, 'title', 'cap', 1, 'ctx', 0, 9.5)",
            [],
        )
        .unwrap();
    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM sessions WHERE id = ?1",
            SESSION_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position): an appended
    // column is reported here rather than behind a chain of value mismatches.
    // HONEST LIMIT, verified by experiment: this assert alone CANNOT be the
    // guard. The statement is prepared from SESSION_COLUMNS itself, and the
    // arity tie below already forces SESSION_COLUMNS.len() ==
    // SESSION_ROW_FIELDS, so this comparison holds whenever the crate compiles.
    // The INDEPENDENT witness is the golden name list immediately after it.
    assert_eq!(
        stmt.column_count(),
        SESSION_ROW_FIELDS,
        "the SELECT built from SESSION_COLUMNS must have exactly SESSION_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         session_row_from is the drift this guard exists to catch"
    );
    // THE ACTUAL GUARD: the column list spelled a SECOND time, as a literal in
    // THIS test, derived from nothing in prod. Appending a column to
    // SESSION_COLUMNS (even together with a matching SESSION_ROW_FIELDS bump,
    // which is the one edit the arity tie cannot see) reddens THIS assert,
    // because nothing forces this literal to follow the prod const. Order is
    // pinned too, so a reorder fails here as well as in the value asserts.
    const EXPECTED_SESSION_COLUMNS: [&str; 10] = [
        "id",
        "cwd",
        "created_at",
        "title",
        "capabilities_json",
        "archived",
        "context_usage_json",
        "is_subagent",
        "cost_usd",
        "title_stage",
    ];
    assert_eq!(
        SESSION_COLUMNS.as_slice(),
        EXPECTED_SESSION_COLUMNS.as_slice(),
        "SESSION_COLUMNS drifted from the column list session_row_from maps: the \
         mapper reads these 10 columns in THIS order (field names in the same \
         order), so a column added to or moved in the const must be matched here \
         AND by a field in session_row_from"
    );
    // Map through the PRODUCTION mapper, on the production statement (the same
    // pairing a real read uses — `Db::session` calls `session_row_from` on this
    // exact SQL shape).
    let got = stmt
        .query_row(params!["id"], session_row_from)
        .expect("the self-identifying row maps");
    // The value asserts (in list order): a reorder / mid-insert / removal
    // breaks one of these.
    assert_eq!(got.id, "id");
    assert_eq!(got.cwd, "cwd");
    assert_eq!(got.created_at, 2);
    assert_eq!(got.title.as_deref(), Some("title"));
    assert_eq!(got.capabilities_json, "cap");
    assert!(got.archived, "column 5 (`archived`) maps to `archived`");
    assert_eq!(got.context_usage_json.as_deref(), Some("ctx"));
    assert!(
        !got.is_subagent,
        "column 7 (`is_subagent`) maps to `is_subagent` — it holds 0 while \
         `archived` holds 1, so a 5↔7 swap cannot pass both boolean asserts"
    );
    assert_eq!(got.cost_usd, Some(9.5));
}

/// The PRIMARY guard for `MessageRow` (6 columns) — same shape, same first
/// assert.
#[test]
fn message_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-message-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let conn = db.conn.lock().expect("db mutex poisoned");
    // The FK to `sessions` is live (the pragma `Db::open` sets), so the
    // transcript row needs its parent. The parent carries nothing the guard
    // reads — every asserted value lives on the message row.
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/tmp', 1, '{}')",
        [],
    )
    .unwrap();
    // One self-identifying message row: distinct value per column.
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at)
         VALUES (11, 's1', 'kind', 'key', 'payload', 12)",
        [],
    )
    .unwrap();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM messages WHERE id = ?1",
            MESSAGE_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position) — same honest
    // limit as the SessionRow guard: prepared from MESSAGE_COLUMNS and tied to
    // MESSAGE_ROW_FIELDS at compile time, this holds whenever the crate
    // compiles. The golden name list after it is the independent witness.
    assert_eq!(
        stmt.column_count(),
        MESSAGE_ROW_FIELDS,
        "the SELECT built from MESSAGE_COLUMNS must have exactly MESSAGE_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         message_row_from is the drift this guard exists to catch"
    );
    // THE ACTUAL GUARD: the list spelled a SECOND time, as a literal in THIS
    // test, derived from nothing in prod — so a coordinated append to
    // MESSAGE_COLUMNS + MESSAGE_ROW_FIELDS (the edit the arity tie cannot see)
    // reddens THIS assert. Order is pinned here as well as by the values below.
    const EXPECTED_MESSAGE_COLUMNS: [&str; 6] = [
        "id",
        "session_id",
        "kind",
        "message_key",
        "payload_json",
        "created_at",
    ];
    assert_eq!(
        MESSAGE_COLUMNS.as_slice(),
        EXPECTED_MESSAGE_COLUMNS.as_slice(),
        "MESSAGE_COLUMNS drifted from the column list message_row_from maps: the \
         mapper reads these 6 columns in THIS order (field names in the same \
         order), so a column added to or moved in the const must be matched here \
         AND by a field in message_row_from"
    );
    let got = stmt
        .query_row(params![11i64], message_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.id, 11);
    assert_eq!(got.session_id, "s1");
    assert_eq!(got.kind, "kind");
    assert_eq!(got.message_key.as_deref(), Some("key"));
    assert_eq!(got.payload_json, "payload");
    assert_eq!(got.created_at, 12);
}

/// The PRIMARY guard for `SpaceRow` (4 columns) — same shape, same first
/// assert. `trusted` is the INTEGER-as-bool column, so this also pins that the
/// mapper reads it as `i64 != 0` (the same shape `session_row_from` uses for
/// its two booleans).
#[test]
fn space_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-space-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    // No `sessions` row here on purpose: `Db::open`'s phase-11 backfill turns
    // every session cwd into a space row, and this guard wants exactly ONE
    // space — the one it inserted.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO spaces (path, created_at, last_opened_at, trusted) \
             VALUES ('path', 3, 4, 1)",
            [],
        )
        .unwrap();
    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM spaces WHERE path = ?1",
            SPACE_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position) — same honest
    // limit as the other two guards; the golden name list after it is the
    // independent witness.
    assert_eq!(
        stmt.column_count(),
        SPACE_ROW_FIELDS,
        "the SELECT built from SPACE_COLUMNS must have exactly SPACE_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         space_row_from is the drift this guard exists to catch. `sort_order` is \
         deliberately NOT one of them: SpaceRow has 4 fields by decision (see \
         SPACE_COLUMNS), so a fifth column here must fail THIS assert, not the \
         struct"
    );
    // THE ACTUAL GUARD: the list spelled a SECOND time, as a literal in THIS
    // test, derived from nothing in prod. This is also the assert that catches
    // `sort_order` being added to SPACE_COLUMNS — the decision SPACE_COLUMNS'
    // doc records would otherwise be editable in silence.
    const EXPECTED_SPACE_COLUMNS: [&str; 4] = ["path", "created_at", "last_opened_at", "trusted"];
    assert_eq!(
        SPACE_COLUMNS.as_slice(),
        EXPECTED_SPACE_COLUMNS.as_slice(),
        "SPACE_COLUMNS drifted from the column list space_row_from maps: the mapper \
         reads these 4 columns in THIS order, and `sort_order` stays OUT of the \
         projection by decision (adding it would change the Vec<SpaceRow> wire \
         type commands/spaces.rs returns)"
    );
    let got = stmt
        .query_row(params!["path"], space_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.path, "path");
    assert_eq!(got.created_at, 3);
    assert_eq!(got.last_opened_at, 4);
    assert!(
        got.trusted,
        "column 3 (`trusted`) maps to `trusted` via i64 != 0"
    );
}

// ── A1 — the Task board (spec §2, ADR 0090) ────────────────────────────────
//
// Three tables (`stages`, `tasks`, `task_sessions`), lazy stage seeding, and
// the per-Space `number` hand-out. The load-bearing assertions are the
// single-lock rendezvous in `create_task` and the ABSENCE of a foreign key on
// `space_path` — ADR 0090's whole reason for existing.
//
// The board's error type is `BoardError`, NOT `DbError`: `DbError` documents
// itself as STAYING THREE-VARIANT (it is the crate seam's type), and the board
// needs two absence cases the seam has no business carrying.

/// A Space path for the board tests. The tables carry NO foreign key on
/// `space_path` (ADR 0090), so these tests need no `spaces` row at all — which
/// is itself part of what they pin.
fn board_space(tag: &str) -> String {
    format!("/board-space/{tag}")
}

/// (ADR 0090) `number` is a per-Space, 1-based, never-reused label.
///
/// Three facts, one per assertion: the floor is `0` (the FIRST task in a Space
/// is `#1`, not `#0` — the DELIBERATE difference from this file's `sort_order`
/// `-1` join), the counter is per-Space, and a delete does NOT free a number
/// (reusing `#2` would silently re-point every historical mention of `T2`).
#[test]
fn create_task_numbers_are_per_space_and_1_based_and_never_reused() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-number-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = board_space("a");
    let b = board_space("b");

    let first = db.create_task(&a, "first", None, None).expect("create");
    assert_eq!(
        first.number, 1,
        "the FIRST task in a Space is `#1`: the `number` floor is 0 (ADR 0090), \
         NOT the `sort_order` idiom's -1"
    );
    let second = db.create_task(&a, "second", None, None).expect("create");
    assert_eq!(second.number, 2, "the second card is `#2`");

    let other = db.create_task(&b, "elsewhere", None, None).expect("create");
    assert_eq!(
        other.number, 1,
        "`number` is PER-Space — a second Space starts at `#1`"
    );

    // Never reused: with `#1, #2, #3` on the board, deleting the MIDDLE card
    // must not hand `#2` back to the next create — a fresh card is `#4`, and the
    // two survivors keep `#1` and `#3`. This is the half ADR 0090's "numbers are
    // never reused" that `MAX(number) + 1` can actually deliver, and A1 ships no
    // delete verb at all, so it is the whole reachable surface today. The
    // boundary (deleting the HIGHEST card does free its number) is documented on
    // `Db::create_task`, not asserted here — see the DEVIATION note.
    let third = db.create_task(&a, "third", None, None).expect("create");
    assert_eq!(third.number, 3);
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute("DELETE FROM tasks WHERE id = ?1", params![second.id])
        .unwrap();
    let fourth = db.create_task(&a, "fourth", None, None).expect("create");
    assert_eq!(
        fourth.number, 4,
        "a deleted card's number is not handed back — `#2` stays dead"
    );
    let survivors: Vec<i64> = db
        .list_tasks(&a)
        .expect("list_tasks")
        .iter()
        .map(|task| task.number)
        .collect();
    assert_eq!(
        survivors,
        vec![1, 3, 4],
        "the gap where `#2` was is VISIBLE, not renumbered away — re-pointing a          surviving card would be the same lie as reusing the number"
    );
}

/// (ADR 0090's rendezvous) `create_task` reads `MAX(number)` and inserts under
/// ONE `conn.lock()`, so N concurrent creates hand out N DISTINCT numbers.
///
/// This is the test the single lock is pinned by: with the read and the write
/// behind TWO separate locks, two threads can both read the same `MAX` and both
/// insert the same `number`. A `Barrier` makes the interleave likely rather
/// than theoretical — every thread is released on the same tick.
#[test]
fn create_task_reads_and_inserts_under_one_lock() {
    const N: usize = 12;
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-race-", "scratch");
    let db = std::sync::Arc::new(Db::open(&dir.join("t.db")).expect("db should open"));
    let space = board_space("race");
    let gate = std::sync::Barrier::new(N);

    let numbers: Vec<i64> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..N)
            .map(|i| {
                let db = db.clone();
                let space = space.clone();
                let gate = &gate;
                scope.spawn(move || {
                    gate.wait();
                    db.create_task(&space, &format!("racer {i}"), None, None)
                        .expect("create under contention")
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("thread").number)
            .collect()
    });

    let unique: std::collections::HashSet<i64> = numbers.iter().copied().collect();
    assert_eq!(
        unique.len(),
        N,
        "{N} concurrent creates must hand out {N} DISTINCT numbers; got {numbers:?}"
    );
    let mut sorted = numbers;
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        (1..=N as i64).collect::<Vec<i64>>(),
        "the numbers are exactly 1..={N} with no gap and no duplicate"
    );
}

/// (lazy seeding) `get_board` on a Space with no stage rows inserts the FIVE
/// defaults in `sort_order` order, and a SECOND call seeds nothing.
#[test]
fn get_board_seeds_the_five_default_stages_once() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-seed-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("fresh");

    let board = db.get_board(&space).expect("get_board seeds and reads");
    let columns: Vec<(&str, &str, i64, &str)> = board
        .iter()
        .map(|column| {
            (
                column.stage.slug.as_str(),
                column.stage.label.as_str(),
                column.stage.sort_order,
                column.stage.on_enter.as_str(),
            )
        })
        .collect();
    assert_eq!(
        columns,
        vec![
            ("backlog", "Backlog", 0, "none"),
            ("research", "Research", 1, "none"),
            ("approved", "Approved", 2, "none"),
            ("doing", "Doing", 3, "none"),
            ("done", "Done", 4, "none"),
        ],
        "the five defaults, in sort_order, label = slug capitalised, on_enter at \
         the DDL's DEFAULT 'none' (ADR 0107: the seeded `discuss` Stage is gone)"
    );
    let skills: Vec<(&str, Option<&str>)> = board
        .iter()
        .map(|column| {
            (
                column.stage.slug.as_str(),
                column.stage.on_enter_skill.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        skills,
        vec![
            ("backlog", None),
            ("research", Some("research")),
            ("approved", None),
            ("doing", None),
            ("done", None),
        ],
        "ADR 0098: exactly the one launch column carries a Skill, and the seed \
         spells it (not a second copy of `on_enter`)"
    );
    assert!(
        board.iter().all(|column| column.stage.next_slugs.is_none()),
        "the seed configures NO graph — NULL is unconfigured (ADR 0099)"
    );
    assert!(
        board.iter().all(|column| column.tasks.is_empty()),
        "a fresh Space has stages and no cards"
    );

    let again = db.get_board(&space).expect("second get_board");
    assert_eq!(
        again.len(),
        5,
        "a second board read must NOT re-seed — the seed is lazy AND idempotent"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "still exactly five stage rows after two reads"
    );
}

/// (the seed is per-Space) seeding one Space leaves another unseeded, so a
/// Space that never opens the board pays nothing (spec §2).
#[test]
fn seeding_one_space_leaves_another_space_unseeded() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-seed2-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let opened = board_space("opened");
    let never = board_space("never-opened");

    db.get_board(&opened).expect("seed the opened Space");
    assert_eq!(
        db.list_stages(&never).expect("list_stages").len(),
        0,
        "a Space whose board was never read has NO stage rows — the seed is lazy, \
         not a migration that writes for every existing Space"
    );
}

/// (the drag verb) `move_task` writes `stage_slug` + touches `updated_at` and
/// reports the DESTINATION stage's `on_enter`; an unknown slug is `MissingStage`
/// naming the slugs that DO exist (ADR 0090: the message names the valid ones so
/// the caller self-corrects without a discovery round trip).
#[test]
fn move_task_updates_stage_slug_and_reports_the_destination_on_enter() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-move-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("move");
    let task = db
        .create_task(&space, "drag me", None, None)
        .expect("create");
    assert_eq!(
        task.stage_slug, "backlog",
        "with no stage given, a card lands in the FIRST stage"
    );

    let outcome = db
        .move_task(&space, &task.id, "doing")
        .expect("move to a seeded stage");
    assert_eq!(
        outcome.on_enter, "none",
        "the destination's on_enter rides back to the caller — the COMMAND layer \
         decides what compaction to run, the storage layer never calls it"
    );

    let read = db
        .get_task(&task.id)
        .expect("get_task")
        .expect("the row exists");
    assert_eq!(read.stage_slug, "doing", "the stage moved");
    assert_eq!(read.number, task.number, "move_task never touches `number`");
    assert!(
        read.updated_at >= read.created_at,
        "`updated_at` is touched (>= created_at; a same-ms write may tie)"
    );

    let err = db
        .move_task(&space, &task.id, "nope")
        .expect_err("an unknown stage slug is a rejection, not a silent write");
    let BoardError::MissingStage { available, .. } = &err else {
        panic!("the unknown-stage arm must be MissingStage; got {err:?}");
    };
    assert!(
        available.contains("doing") && available.contains("backlog"),
        "the rejection names the valid slugs (ADR 0090); got {available}"
    );
}

/// (`on_enter` is data, read AFTER the write) a stage row carrying
/// `on_enter = 'compact'` reports it, so the command layer can run the boost.
#[test]
fn move_task_reports_a_compact_stage_so_the_command_can_boost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-compact-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("compact");
    db.get_board(&space).expect("seed");
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "UPDATE stages SET on_enter = 'compact' WHERE space_path = ?1 AND slug = 'doing'",
            params![space],
        )
        .unwrap();
    let task = db
        .create_task(&space, "boost me", None, None)
        .expect("create");

    let outcome = db
        .move_task(&space, &task.id, "doing")
        .expect("move into the compact stage");
    assert_eq!(outcome.on_enter, "compact");
}

/// (the link row) `link_session` records `(task, session, stage)`; `None`
/// resolves to the task's CURRENT stage, and a second link is IGNORED — the
/// first link keeps the stage it was made with, because that is the stage a
/// later `compact` moves FROM (spec §5).
#[test]
fn link_session_records_the_task_and_stage_and_keeps_the_first() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-link-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("link");
    let task = db
        .create_task(&space, "linked", None, None)
        .expect("create");
    // A REAL session row: `task_sessions.session_id` carries
    // `REFERENCES sessions(id) ON DELETE CASCADE` and `Db::open` turns the
    // `foreign_keys` pragma on, so a dangling id is rejected at the statement.
    db.record_session(&title_session("sess-1"))
        .expect("record the linked session");

    db.link_session(&task.id, "sess-1", None)
        .expect("link with no stage resolves the task's current stage");
    let rows = db.task_sessions(&task.id).expect("task_sessions");
    assert_eq!(
        rows.iter()
            .map(|r| (r.session_id.as_str(), r.stage_slug.as_deref()))
            .collect::<Vec<_>>(),
        vec![("sess-1", Some("backlog"))],
        "the row exists with the task's current stage"
    );

    db.link_session(&task.id, "sess-1", Some("doing"))
        .expect("a re-link is INSERT OR IGNORE, never an error");
    let rows = db.task_sessions(&task.id).expect("task_sessions");
    assert_eq!(
        rows.iter()
            .map(|r| (r.session_id.as_str(), r.stage_slug.as_deref()))
            .collect::<Vec<_>>(),
        vec![("sess-1", Some("backlog"))],
        "INSERT OR IGNORE keeps the FIRST row"
    );

    let err = db
        .link_session("tsk_missing", "sess-1", None)
        .expect_err("linking a Task that does not exist is a rejection");
    assert!(
        matches!(err, BoardError::MissingTask(_)),
        "a missing Task is a not-found, not a silent INSERT; got {err:?}"
    );
}

/// (`task_sessions.session_id` DOES carry the FK) the one FK the board has:
/// deleting the Session removes the link row, deleting the Space does not.
#[test]
fn task_sessions_cascade_with_the_session_and_not_with_the_space() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-fk-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("fk");
    let task = db.create_task(&space, "fk me", None, None).expect("create");
    db.record_session(&title_session("sess-fk"))
        .expect("record the session the link points at");
    db.link_session(&task.id, "sess-fk", None).expect("link");
    assert_eq!(db.task_sessions(&task.id).expect("links").len(), 1);

    db.delete_session("sess-fk")
        .expect("delete_session (the FK's ON DELETE CASCADE target)");
    assert_eq!(
        db.task_sessions(&task.id).expect("links").len(),
        0,
        "`task_sessions.session_id` reuses the file's `REFERENCES sessions(id) \
         ON DELETE CASCADE` clause, so a deleted Session drops the link"
    );
    assert!(
        db.get_task(&task.id).expect("get_task").is_some(),
        "the Task itself is NOT a child of the Session — it is the card"
    );
}

/// (ADR 0090, the load-bearing one) closing a Space tab runs `delete_space`;
/// the board must SURVIVE it. There is deliberately NO foreign key on
/// `space_path`, so nothing cascades.
#[test]
fn delete_space_leaves_the_board_rows_in_place() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-orphan-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("tab-closing");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed the stages");
    let task = db
        .create_task(&space, "survive me", None, None)
        .expect("create");
    db.record_session(&title_session("sess-keep"))
        .expect("record the linked session — the FK on session_id is live");
    db.link_session(&task.id, "sess-keep", None).expect("link");

    db.delete_space(&space).expect("delete_space (a tab close)");
    assert!(db.find_space(&space).expect("find_space").is_none());

    let board = db
        .get_board(&space)
        .expect("the board survives the tab close");
    assert_eq!(board.len(), 5, "the five stage rows are still there");
    assert_eq!(
        board
            .iter()
            .flat_map(|c| c.tasks.iter())
            .map(|t| t.task.id.as_str())
            .collect::<Vec<_>>(),
        vec![task.id.as_str()],
        "the card is still there — ADR 0090: a board that cascaded away on a tab \
         close loses a whole workflow to a click that deletes nothing else"
    );
    assert_eq!(
        db.task_sessions(&task.id)
            .expect("task_sessions")
            .iter()
            .map(|r| r.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-keep"],
        "and so is the Session link"
    );
}

/// (`edit_task`) the COALESCE patch writes ONLY the fields it is given, and
/// never the position or the label — `move_task` owns the stage, `number` is
/// never renumbered, and within-column position is a human concern (spec §3).
#[test]
fn edit_task_writes_only_the_fields_it_is_given() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("edit");
    let task = db
        .create_task(&space, "original", Some("body one"), None)
        .expect("create");

    let edited = db
        .edit_task(&task.id, Some("renamed"), None, Some("docs/x.md"))
        .expect("edit_task");
    assert_eq!(edited.title, "renamed", "the title is written");
    assert_eq!(
        edited.body.as_deref(),
        Some("body one"),
        "an absent body keeps the stored one (COALESCE, not an overwrite with NULL)"
    );
    assert_eq!(
        edited.spec_path.as_deref(),
        Some("docs/x.md"),
        "spec_path is written"
    );
    assert_eq!(
        edited.stage_slug, task.stage_slug,
        "edit_task NEVER touches the stage — that is move_task's job"
    );
    assert_eq!(
        edited.number, task.number,
        "edit_task never touches the number"
    );
    assert_eq!(
        edited.sort_order, task.sort_order,
        "edit_task never touches the position"
    );

    let err = db
        .edit_task("tsk_missing", Some("x"), None, None)
        .expect_err("editing a Task that does not exist is a rejection");
    assert!(matches!(err, BoardError::MissingTask(_)), "got {err:?}");
}

/// (`get_task`) a missing id is `Ok(None)` — the `find_space` shape: a read of
/// a card that was deleted is an answer, not an error.
#[test]
fn get_task_on_a_missing_id_is_ok_none() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-get-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    assert_eq!(
        db.get_task("tsk_nope").expect("get_task"),
        None,
        "a missing row is Ok(None)"
    );
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
    let source = include_str!("../../db.rs");
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
    let source = include_str!("../../db.rs");
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
    assert!(
        !source.contains("REFERENCES spaces"),
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

/// (the mapper drift guard, `space_row_from_…`'s sibling) the SELECT const and
/// the mapper cannot drift apart, and the golden column list is spelled a
/// second time here so a silent edit of `TASK_COLUMNS` reddens.
#[test]
fn task_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let space = board_space("mapper");
    let task = db
        .create_task(&space, "mapped", None, None)
        .expect("create");

    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM tasks WHERE id = ?1",
            TASK_COLUMNS.join(", ")
        ))
        .unwrap();
    assert_eq!(
        stmt.column_count(),
        TASK_ROW_FIELDS,
        "the SELECT built from TASK_COLUMNS must have exactly TASK_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         task_row_from is the drift this guard exists to catch"
    );
    const EXPECTED_TASK_COLUMNS: [&str; 10] = [
        "id",
        "space_path",
        "number",
        "title",
        "body",
        "spec_path",
        "stage_slug",
        "sort_order",
        "created_at",
        "updated_at",
    ];
    assert_eq!(
        TASK_COLUMNS.as_slice(),
        EXPECTED_TASK_COLUMNS.as_slice(),
        "TASK_COLUMNS drifted from the column list task_row_from maps"
    );
    let got = stmt
        .query_row(params![task.id], task_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.id, task.id);
    assert_eq!(got.number, task.number);
    assert_eq!(got.title, "mapped");
    assert_eq!(
        got.body, None,
        "the nullable `body` maps through get::<_, Option<String>>, not a bare get"
    );
    assert_eq!(got.spec_path, None);
    assert_eq!(got.stage_slug, "backlog");
}

/// (the mapper drift guard for `stages`) the same shape as the task one.
#[test]
fn stage_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let space = board_space("stage-mapper");
    db.get_board(&space).expect("seed");

    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM stages WHERE space_path = ?1 AND slug = ?2",
            STAGE_COLUMNS.join(", ")
        ))
        .unwrap();
    assert_eq!(
        stmt.column_count(),
        STAGE_ROW_FIELDS,
        "the SELECT built from STAGE_COLUMNS must have exactly STAGE_ROW_FIELDS columns"
    );
    const EXPECTED_STAGE_COLUMNS: [&str; 7] = [
        "space_path",
        "slug",
        "label",
        "sort_order",
        "on_enter",
        "on_enter_skill",
        "next_slugs",
    ];
    assert_eq!(
        STAGE_COLUMNS.as_slice(),
        EXPECTED_STAGE_COLUMNS.as_slice(),
        "STAGE_COLUMNS drifted from the column list stage_row_from maps"
    );
    let got = stmt
        .query_row(params![space, "doing"], stage_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.slug, "doing");
    assert_eq!(got.label, "Doing");
    assert_eq!(
        got.sort_order, 3,
        "`doing` sits at index 3 on the five-stage seed (ADR 0107 dropped the \
         seeded `discuss` row that used to push it down one)"
    );
    assert_eq!(got.on_enter, "none");
    assert_eq!(
        got.on_enter_skill, None,
        "`doing` launches nothing — and the mapper must read index 5, not skip it"
    );
    assert_eq!(
        got.next_slugs, None,
        "index 6 maps to the lenient JSON read, NULL on a seeded row"
    );
    let research = stmt
        .query_row(params![space, "research"], stage_row_from)
        .expect("the research row maps too");
    assert_eq!(
        research.on_enter_skill.as_deref(),
        Some("research"),
        "the two new fields map for a row that actually CARRIES a value — a mapper \
         that read index 5 as `None` for every row would pass the NULL case above"
    );
}

/// (the board read is ONE payload) `get_board` groups the cards under the stage
/// rows in stage order — empty columns included — so the frontend never joins.
#[test]
fn get_board_groups_tasks_under_their_stage_in_stage_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-group-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("group");
    db.get_board(&space).expect("seed");
    let one = db.create_task(&space, "one", None, None).expect("create");
    db.create_task(&space, "two", None, Some("done"))
        .expect("create");
    db.move_task(&space, &one.id, "done").expect("move");

    let board = db.get_board(&space).expect("get_board");
    let shaped: Vec<(&str, Vec<&str>)> = board
        .iter()
        .map(|c| {
            (
                c.stage.slug.as_str(),
                c.tasks.iter().map(|t| t.task.title.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        shaped,
        vec![
            ("backlog", vec![]),
            ("research", vec![]),
            ("approved", vec![]),
            ("doing", vec![]),
            ("done", vec!["one", "two"]),
        ],
        "every stage appears (empty columns too), in sort_order, each carrying its own cards"
    );
    assert_eq!(
        db.list_tasks(&space).expect("list_tasks").len(),
        2,
        "the flat read agrees with the grouped one"
    );
}

// ── issue #174: the board read carries each card's Sessions and its cost ───
//
// Eight pins for one new statement + one new wrapper type. The shape being
// pinned is `TaskCardView { task, sessions, costUsd }`, and the load-bearing
// half of it is ADR 0082's two meanings for `sessions.cost_usd`: `NULL` means
// "no model call ever reported a cost" (render NOTHING) and `0.0` means "a real
// zero" (render `$0.00`). Every cost test below exists to keep those two
// distinguishable through the fold — collapsing them at the board read would
// put a phantom `$0.00` on a card that has spent nothing measurable.

/// The board's cards as ONE flat list in column order — the shape the tests
/// below read, so each one says "the card" rather than re-spelling the find.
fn board_cards(db: &Db, space: &str) -> Vec<TaskCardView> {
    db.get_board(space)
        .expect("get_board")
        .into_iter()
        .flat_map(|column| column.tasks)
        .collect()
}

/// Record a Session (the FK on `task_sessions.session_id` requires the row to
/// exist before a link) and, when `cost` is `Some`, write its cost figure.
/// `None` leaves the column at NULL — "never reported", NOT zero.
fn record_linkable_session(db: &Db, id: &str, cwd: &str, cost: Option<f64>) {
    let mut info = title_session(id);
    info.cwd = std::path::PathBuf::from(cwd);
    db.record_session(&info)
        .expect("record_session (the link's FK target)");
    if let Some(total) = cost {
        db.record_session_cost(id, total)
            .expect("record_session_cost (a snapshot write)");
    }
}

/// (issue #174, the happy path) A card with two linked Sessions carries BOTH
/// link rows and ONE summed figure.
///
/// The cost arrives as a single number, not as two: summing it in TypeScript
/// would put ADR 0082's NULL/zero rule in a second language with nothing tying
/// the two together. The links come back OLDEST FIRST because that is the order
/// `Db::task_sessions` already publishes, so the card's "newest" is `last()` and
/// the two readers of this table agree.
#[test]
fn get_board_returns_each_card_with_its_linked_sessions_and_the_total_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-cost-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("cost");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "worked", None, None)
        .expect("create");

    record_linkable_session(&db, "sess-old", "/tmp/proj", Some(1.50));
    record_linkable_session(&db, "sess-new", "/tmp/proj", Some(0.25));
    db.link_session(&card.id, "sess-old", None).expect("link");
    db.link_session(&card.id, "sess-new", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(cards.len(), 1, "one card on this board");
    let view = &cards[0];
    assert_eq!(view.task.id, card.id, "the card itself rides along intact");
    assert_eq!(
        view.sessions
            .iter()
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-old", "sess-new"],
        "both links, OLDEST FIRST — the same order `Db::task_sessions` publishes, \
         so the card's newest is `last()`"
    );
    assert_eq!(
        view.cost_usd,
        Some(1.75),
        "ONE summed figure, computed server-side"
    );
    assert_eq!(
        view.sessions
            .iter()
            .map(|link| link.task_id.as_str())
            .collect::<Vec<_>>(),
        vec![card.id.as_str(), card.id.as_str()],
        "the link rows carry their own `task_id` — the same `TaskSessionRow` the \
         single-card read returns, not a new shape"
    );
}

/// (issue #174, the case that must NOT become `Some(0.0)`) a card with no links
/// has no Sessions and NO cost.
///
/// `Some(0.0)` here would render `$0.00` on a card that never ran a Session —
/// the exact phantom ADR 0082 forbids, and invisible to every other test because
/// it is a well-formed number in the wrong slot.
#[test]
fn a_card_with_no_links_gets_no_sessions_and_a_null_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-nolink-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("no-link");
    db.get_board(&space).expect("seed");
    db.create_task(&space, "untouched", None, None)
        .expect("create");
    // A Session exists in the database; it is simply not linked to this card.
    record_linkable_session(&db, "sess-unlinked", "/tmp/proj", Some(9.99));

    let cards = board_cards(&db, &space);
    assert_eq!(cards.len(), 1);
    assert!(
        cards[0].sessions.is_empty(),
        "no links, no sessions; got {:?}",
        cards[0].sessions
    );
    assert_eq!(
        cards[0].cost_usd, None,
        "`None` — never `Some(0.0)`. A card that has never run a Session has no \
         figure, not a free one."
    );
}

/// (ADR 0082's whole point, at the board read) a Session that reported a genuine
/// zero contributes `Some(0.0)`, not `None`.
///
/// `record_session_cost` is a snapshot write, so `0.0` is a figure a model call
/// actually produced. The card must render `$0.00` for it, which requires the
/// fold to preserve the distinction rather than treat zero as nothing.
#[test]
fn a_real_zero_cost_is_some_zero_not_null() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-zero-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("zero");
    db.get_board(&space).expect("seed");
    let card = db.create_task(&space, "free", None, None).expect("create");

    record_linkable_session(&db, "sess-zero", "/tmp/proj", Some(0.0));
    db.link_session(&card.id, "sess-zero", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(cards[0].sessions.len(), 1, "the link is there");
    assert_eq!(
        cards[0].cost_usd,
        Some(0.0),
        "a reported zero SURVIVES the fold as `Some(0.0)` — the card renders \
         `$0.00`, and `None` here would silently render nothing"
    );
}

/// (the fold IS SQL's SUM over nullable inputs) NULL iff EVERY input is NULL.
///
/// Two Sessions that never reported a cost sum to `None`. An implementation that
/// seeded the accumulator with `Some(0.0)` — the shape a `SUM`-free loop falls
/// into — passes the two-figure tests above and fails HERE.
#[test]
fn all_unreported_costs_sum_to_null_not_zero() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-null-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("all-null");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "unmeasured", None, None)
        .expect("create");

    record_linkable_session(&db, "sess-a", "/tmp/proj", None);
    record_linkable_session(&db, "sess-b", "/tmp/proj", None);
    db.link_session(&card.id, "sess-a", None).expect("link");
    db.link_session(&card.id, "sess-b", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(
        cards[0].sessions.len(),
        2,
        "both links are present — the NULLs are about COST, not about the link"
    );
    assert_eq!(
        cards[0].cost_usd, None,
        "every input NULL, so the sum is NULL. `Some(0.0)` here is the phantom \
         `$0.00` ADR 0082 exists to prevent."
    );
}

/// (one NULL does not poison the sum) `NULL + 2.00` is `Some(2.00)`.
///
/// SQL's `SUM` skips NULLs, and so must this fold: a Session that has never
/// reported must not erase the figure one of its siblings did report.
#[test]
fn one_reported_and_one_unreported_cost_yields_the_reported_figure() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-mixed-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("mixed");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "half measured", None, None)
        .expect("create");

    // Linked in the order that puts the NULL FIRST, so an implementation that
    // stopped at the first NULL would show up as `None` rather than limping past.
    record_linkable_session(&db, "sess-null", "/tmp/proj", None);
    record_linkable_session(&db, "sess-two", "/tmp/proj", Some(2.0));
    db.link_session(&card.id, "sess-null", None).expect("link");
    db.link_session(&card.id, "sess-two", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(cards[0].sessions.len(), 2);
    assert_eq!(
        cards[0].cost_usd,
        Some(2.0),
        "the reported figure survives; the unreported Session contributes nothing"
    );
}

/// (issue #174, the scoping rule) the link read is restricted to THIS Space's
/// cards by `task_id IN (SELECT id FROM tasks WHERE space_path = ?1)` — never by
/// the Session's `cwd`.
///
/// Both directions are pinned, because a `cwd` filter fails in BOTH of them:
///   - a linked Session whose `cwd` is NOT the card's Space must still appear
///     (`sessions` has no `space_path`; the Space is derived from `cwd`, and a
///     Session can be started from anywhere) — a `cwd` filter would DROP it;
///   - another Space's card, linked to a Session whose `cwd` IS this Space's
///     path, must contribute NOTHING here — a `cwd` filter would PULL it in.
///     The second card lives in another Space and its link is simply not in
///     this payload.
#[test]
fn get_board_does_not_include_another_spaces_links() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-scope-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("scoped");
    let other = board_space("scoped-other");
    db.get_board(&space).expect("seed");
    db.get_board(&other).expect("seed the other board");

    let mine = db.create_task(&space, "mine", None, None).expect("create");
    let theirs = db
        .create_task(&other, "theirs", None, None)
        .expect("create in another space");

    // MY card's Session runs somewhere ELSE (the default `/tmp/proj` cwd, which
    // is not this Space's path) — a `cwd` filter would drop this link.
    record_linkable_session(&db, "sess-mine-elsewhere", "/tmp/proj", Some(1.00));
    // THEIR card's Session runs IN MY Space — a `cwd` filter would pull this one in.
    record_linkable_session(&db, "sess-theirs-in-my-space", &space, Some(5.00));

    db.link_session(&mine.id, "sess-mine-elsewhere", None)
        .expect("link my card to a session with another cwd");
    db.link_session(&theirs.id, "sess-theirs-in-my-space", None)
        .expect("link the other card to a session inside my Space's directory");

    let cards = board_cards(&db, &space);
    assert_eq!(
        cards.iter().map(|c| c.sessions.len()).sum::<usize>(),
        1,
        "exactly ONE link row on this board — the other Space's card contributes \
         nothing even though its Session's `cwd` IS this Space's path"
    );
    assert_eq!(
        cards[0]
            .sessions
            .iter()
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-mine-elsewhere"],
        "and my own link survives although its Session's `cwd` is not this Space \
         — the restriction is by task_id, never by cwd"
    );
    assert_eq!(
        cards[0].cost_usd,
        Some(1.00),
        "the other Space's $5.00 Session is not folded into my card's figure"
    );

    // The far side reads its own link, and nothing of mine.
    let elsewhere = board_cards(&db, &other);
    assert_eq!(
        elsewhere
            .iter()
            .flat_map(|c| c.sessions.iter())
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-theirs-in-my-space"],
        "the other board sees its own link and none of mine"
    );
}

/// (issue #174, the falsifiable JOIN check) deleting a linked Session drops its
/// link row AND its share of the card's figure.
///
/// This is the test that replaces a `JOIN`-vs-`LEFT JOIN` mutation check: with
/// `foreign_keys` ON and `ON DELETE CASCADE`, a link to a missing Session cannot
/// exist, so no row distinguishes the two joins at this read. What CAN break is
/// the cascade not reaching the board — a stale link would leave a phantom count
/// and a figure that keeps charging for a deleted Session. Same delete path
/// `task_sessions_cascade_with_the_session_and_not_with_the_space` uses.
#[test]
fn deleting_a_linked_session_drops_its_link_row_and_its_share_of_the_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-cascade-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("cascade");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "two sessions", None, None)
        .expect("create");

    record_linkable_session(&db, "sess-keep", "/tmp/proj", Some(1.00));
    record_linkable_session(&db, "sess-drop", "/tmp/proj", Some(2.00));
    db.link_session(&card.id, "sess-keep", None).expect("link");
    db.link_session(&card.id, "sess-drop", None).expect("link");

    let before = board_cards(&db, &space);
    assert_eq!(before[0].sessions.len(), 2, "both links, to start with");
    assert_eq!(before[0].cost_usd, Some(3.00), "and the summed figure");

    db.delete_session("sess-drop")
        .expect("delete_session (the FK's ON DELETE CASCADE target)");

    let after = board_cards(&db, &space);
    assert_eq!(
        after[0]
            .sessions
            .iter()
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-keep"],
        "the cascade reaches the board read: the deleted Session's link is gone"
    );
    assert_eq!(
        after[0].cost_usd,
        Some(1.00),
        "and its $2.00 left the figure with it — a card that still charged for a \
         deleted Session would be a phantom cost"
    );
}

/// The DRIFT PIN for the board's card payload (issue #174).
///
/// `types.ts`'s `TaskCardView` is a HAND-WRITTEN mirror — no Rust↔TS shape pin
/// exists in this repo — so the FOUR key lists below (`FROZEN_CARD_KEYS`,
/// `FROZEN_TASK_KEYS`, `FROZEN_LINK_KEYS`) are spelled a second time in
/// `src/store/tasks.test.ts` as `the task card view wire keys are frozen (mirror
/// of the Rust pin)`, byte-identical. A rename on either side reddens one of the
/// two. Modelled on `closed_reason_spellings_are_frozen`.
#[test]
fn the_task_card_view_wire_keys_are_frozen() {
    // The TS mirror is `src/lib/tauri/types.ts`'s
    // `export interface TaskCardView { task: TaskRow; sessions: TaskSessionRow[];
    // costUsd: number | null; artifactKeys: string[]; }` — these FOUR keys, in
    // this order, no more. `artifactKeys` joined in #180 and is REQUIRED, never
    // optional: an optional field compiles against every fixture and renders
    // nothing when real data arrives.
    const FROZEN_CARD_KEYS: [&str; 4] = ["task", "sessions", "costUsd", "artifactKeys"];
    // The TS mirror of these TEN is `export interface TaskRow` in the same file.
    const FROZEN_TASK_KEYS: [&str; 10] = [
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
    ];
    // The TS mirror of these THREE is `export interface TaskSessionRow` in the
    // SAME file (`src/lib/tauri/types.ts`), spelled byte-identically by its
    // mirror test `the task card view wire keys are frozen (mirror of the Rust
    // pin)` in `src/store/tasks.test.ts`. This is the list the chip reads
    // (`sessions[].sessionId`), so it is frozen alongside the other two.
    const FROZEN_LINK_KEYS: [&str; 3] = ["taskId", "sessionId", "stageSlug"];

    let view = TaskCardView {
        task: TaskRow {
            id: "tsk_frozen".to_string(),
            space_path: "/board-space/frozen".to_string(),
            number: 1,
            title: "frozen".to_string(),
            body: None,
            spec_path: None,
            stage_slug: "backlog".to_string(),
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        },
        sessions: vec![TaskSessionRow {
            task_id: "tsk_frozen".to_string(),
            session_id: "sess-frozen".to_string(),
            stage_slug: None,
        }],
        cost_usd: Some(1.75),
        artifact_keys: vec!["spec".to_string()],
    };
    let value = serde_json::to_value(&view).expect("TaskCardView serializes");

    let mut card_keys: Vec<&str> = value
        .as_object()
        .expect("a struct serializes to a map")
        .keys()
        .map(String::as_str)
        .collect();
    card_keys.sort_unstable();
    let mut expected_card_keys = FROZEN_CARD_KEYS;
    expected_card_keys.sort_unstable();
    assert_eq!(
        card_keys, expected_card_keys,
        "the card payload is exactly `{{task, sessions, costUsd, artifactKeys}}` — \
         `#[serde(flatten)]` is deliberately NOT used, so the nested `task` key is \
         part of the wire shape, and `artifactKeys` is REQUIRED (never \
         `skip_serializing_if`), so a card with no artifacts sends `[]`"
    );

    let task = value.get("task").expect("the nested task key");
    let mut task_keys: Vec<&str> = task
        .as_object()
        .expect("task is a map")
        .keys()
        .map(String::as_str)
        .collect();
    task_keys.sort_unstable();
    let mut expected_task_keys = FROZEN_TASK_KEYS;
    expected_task_keys.sort_unstable();
    assert_eq!(
        task_keys, expected_task_keys,
        "`task` is the UNCHANGED 10-field `TaskRow` in camelCase — the wrapper adds \
         nothing to it, which is what keeps get_task/create_task/edit_task honest"
    );

    // The THIRD list: the nested link the chip actually reads. `sessions[0]` is
    // the only place `sessionId` reaches the card at all, so without this the
    // `session_id` ↔ `sessionId` seam sat unfrozen on a path the UI depends on —
    // a rename would redden nothing here and silently blank every chip.
    let link = &value["sessions"][0];
    let mut link_keys: Vec<&str> = link
        .as_object()
        .expect("a link is a map")
        .keys()
        .map(String::as_str)
        .collect();
    link_keys.sort_unstable();
    let mut expected_link_keys = FROZEN_LINK_KEYS;
    expected_link_keys.sort_unstable();
    assert_eq!(
        link_keys, expected_link_keys,
        "`sessions[]` is exactly `{{taskId, sessionId, stageSlug}}` — `sessionId` is \
         what the card's chip opens, so this key is load-bearing, not decoration"
    );

    assert_eq!(
        value.get("costUsd").and_then(serde_json::Value::as_f64),
        Some(1.75),
        "`cost_usd` rides the wire as `costUsd` (rename_all = camelCase)"
    );
    // The `None` half of ADR 0082 has to survive the wire too: the key must be
    // PRESENT and `null`, not absent. A `skip_serializing_if` would delete it and
    // the TS mirror's `number | null` would be a lie the frontend could not tell.
    let unmeasured = TaskCardView {
        task: view.task,
        sessions: vec![],
        cost_usd: None,
        artifact_keys: vec![],
    };
    let absent = serde_json::to_value(&unmeasured).expect("the null-cost card serializes");
    assert!(
        absent.get("costUsd").is_some(),
        "`costUsd` must be PRESENT when there is no figure — a `skip_serializing_if` \
         would make the key vanish and the TS mirror's `number | null` would be a lie"
    );
    assert!(
        absent.get("costUsd").expect("the key is there").is_null(),
        "…and it is JSON `null`, which is what `moneyOf(null)` renders as nothing"
    );
    // `artifactKeys` obeys the same rule as `costUsd`: PRESENT when there is
    // nothing to show. `Vec<String>` has no `None`, so an empty list is the whole
    // story — but a `skip_serializing_if = "Vec::is_empty"` would make the key
    // vanish and the TS mirror's required `artifactKeys: string[]` would be a lie
    // the frontend could not distinguish from a stale payload.
    assert_eq!(
        absent
            .get("artifactKeys")
            .and_then(serde_json::Value::as_array),
        Some(&Vec::<serde_json::Value>::new()),
        "`artifactKeys` must be PRESENT and `[]` on a card with no artifacts — a \
         required wire key, not an optional one"
    );
}

/// (issue #174, the drift pin) `get_board`'s link statement and
/// [`TASK_SESSION_COLUMNS`] select the SAME names in the SAME order.
///
/// Both reads hand their rows to the SAME positional mapper
/// [`task_session_row_from`] (position 0 → `task_id`, 1 → `session_id`, 2 →
/// `stage_slug`), but only `Db::task_sessions` builds its SQL FROM the const
/// (`TASK_SESSION_COLUMNS.join(", ")`); `get_board` spells its projection by
/// hand because it joins `sessions` and so must qualify every column with the
/// `ts.` alias — and the const's unqualified names are exactly what a
/// two-table join cannot reuse. That is why the const is interpolated where it
/// can be and pinned here where it cannot: the alternative (a `ts.`-prefixed
/// second projection built from the const) would be a second list to keep
/// honest, and it would bury a SQL literal this file documents in detail.
///
/// Source-text lint, not a DB assertion: a mutation that renames or reorders a
/// name in ONE of the two lists is invisible to every behavioural test until a
/// user's board silently reads `session_id` into `task_id`. Same technique the
/// schema guards above use (`include_str!` + `matches(…).count()`, and
/// `tests/provider_oidc.rs` lints `src/lib.rs` the same way).
///
/// Compared UNSORTED on purpose — unlike the wire-key pins above, where JSON
/// object key order is not observable on the wire, here order IS the contract,
/// because the mapper reads columns by POSITION.
#[test]
fn the_board_link_statement_selects_the_columns_the_const_owns() {
    let source = include_str!("../../db.rs");

    // ONE anchor, or `rfind` below would read an arbitrary statement and the
    // pin would grade the wrong SQL.
    const ANCHOR: &str = "FROM task_sessions ts";
    assert_eq!(
        source.matches(ANCHOR).count(),
        1,
        "this pin reads the projection that sits immediately before `{ANCHOR}`; a \
         second `task_sessions ts` read would silently point it at the wrong statement"
    );
    let head = &source[..source.find(ANCHOR).expect("the board's link statement")];
    let projection = &head[head
        .rfind("SELECT ")
        .expect("a SELECT ahead of the board's link statement")
        + "SELECT ".len()..];

    // The statement is a multi-line literal with `\` continuations; flatten it
    // so each selected term is one trimmed token.
    let flattened = projection.replace(['\\', '\n'], " ");
    let terms: Vec<&str> = flattened
        .split(',')
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .collect();

    assert!(
        terms.len() > TASK_SESSION_COLUMNS.len(),
        "the board's link projection must carry the const's {} columns PLUS the \
         joined cost column — it selected only {terms:?}",
        TASK_SESSION_COLUMNS.len()
    );

    // Drop the `ts.` alias: the const names columns UNQUALIFIED, the join must
    // not. Stripping the alias is what makes the two lists comparable at all.
    let selected: Vec<&str> = terms
        .iter()
        .map(|term| term.strip_prefix("ts.").unwrap_or(term))
        .collect();
    assert_eq!(
        &selected[..TASK_SESSION_COLUMNS.len()],
        &TASK_SESSION_COLUMNS[..],
        "`get_board` and `task_sessions` feed the SAME positional mapper, so they \
         must select the SAME names in the SAME order — the const holds \
         {TASK_SESSION_COLUMNS:?}, the board's link statement holds {selected:?} \
         (a rename or a reorder on either side mis-assigns every card's links)"
    );
    for term in &selected[..TASK_SESSION_COLUMNS.len()] {
        assert!(
            !term.contains('.'),
            "every mapped column must come from `task_sessions` itself — a \
             table-qualified name (`{term}`) in the first three means the mapper is \
             reading the JOINED `sessions` table"
        );
    }
    // Position 3 is not incidental: `get_board`'s row closure reads exactly
    // `row.get::<_, Option<f64>>(3)` as the cost. Columns AFTER it are free to
    // grow; a column at THIS index would silently become the card's figure.
    assert_eq!(
        selected[TASK_SESSION_COLUMNS.len()],
        "s.cost_usd",
        "position {} is what `get_board` reads as the card's cost — the mapper owns \
         0..{}, so the cost must sit at {}",
        TASK_SESSION_COLUMNS.len(),
        TASK_SESSION_COLUMNS.len(),
        TASK_SESSION_COLUMNS.len()
    );
}

/// (cards join at the BOTTOM) `sort_order` keeps this file's `-1` idiom — the
/// deliberate sibling of `number`'s `0` floor: a position index is zero-based,
/// a user-visible label is one-based.
#[test]
fn create_task_sort_order_is_zero_based_where_number_is_one_based() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-order-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("orders");
    let first = db.create_task(&space, "first", None, None).expect("create");
    let second = db
        .create_task(&space, "second", None, None)
        .expect("create");
    assert_eq!(
        (first.sort_order, first.number),
        (0, 1),
        "the FIRST card is position 0 with label #1 — the two idioms differ ON PURPOSE"
    );
    assert_eq!(
        (second.sort_order, second.number),
        (1, 2),
        "both climb together, from their own floors"
    );
}

/// (spec §3, the within-column drag verb) A drag INSIDE a column writes
/// `sort_order`, and it is the ONLY thing it writes.
///
/// Spec §3's table says a within-column drag writes "`sort_order` only", and
/// "Mirrored by nothing" names the absence of a HARNESS tool (ADR 0075 —
/// position is not evidence, so no tool needs to see it), NOT the absence of a
/// write. A1 shipped no verb that could perform that write at all, which made
/// the spec's own row unimplementable; `Db::reorder_tasks` is that verb,
/// patterned on `reorder_spaces`/`reorder_sessions`: the slice index becomes the
/// stored value, in ONE lock and ONE transaction.
///
/// Three things are pinned, one per assertion group:
///   - the permuted order is what reads back, densely from 0, through the board
///     read the UI actually renders from (`get_board`);
///   - `stage_slug` and `number` are UNTOUCHED — this is a position write, not a
///     move (that is `move_task`) and not a renumber (never, ADR 0090);
///   - another column's cards keep their numbers. `sort_order` is PER-SPACE, not
///     per-stage (see `create_task`'s `MAX(sort_order) … WHERE space_path = ?1`),
///     so a per-column reorder must not renumber across stages — the same
///     tolerated-collision state `reorder_sessions` documents.
#[test]
fn reorder_tasks_persists_the_new_within_stage_order_in_one_pass() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-reorder-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("reorder");
    db.get_board(&space).expect("seed the five stages");

    // Three cards in `backlog` (the first stage, so `stage_slug: None` lands
    // them there) and two in `done`. The `done` pair is the control group: it
    // sits at positions 3 and 4 because the bottom-join is per-Space, so an
    // implementation that renumbered the whole Space would move them and this
    // test would see it.
    let one = db.create_task(&space, "one", None, None).expect("create");
    let two = db.create_task(&space, "two", None, None).expect("create");
    let three = db.create_task(&space, "three", None, None).expect("create");
    assert_eq!(
        vec![one.sort_order, two.sort_order, three.sort_order],
        vec![0, 1, 2],
        "the three cards start in the order they were created"
    );
    let outside = db
        .create_task(&space, "outside-a", None, Some("done"))
        .expect("create in another stage");
    let outside_too = db
        .create_task(&space, "outside-b", None, Some("done"))
        .expect("create in another stage");

    // The dragged order: `[three, one, two]`.
    let dragged = vec![three.id.clone(), one.id.clone(), two.id.clone()];
    db.reorder_tasks(&space, "backlog", &dragged)
        .expect("reorder_tasks should succeed");

    let backlog = db
        .get_board(&space)
        .expect("get_board")
        .into_iter()
        .find(|column| column.stage.slug == "backlog")
        .expect("the seeded backlog column");
    let seen: Vec<(&str, i64)> = backlog
        .tasks
        .iter()
        .map(|task| (task.task.title.as_str(), task.task.sort_order))
        .collect();
    assert_eq!(
        seen,
        vec![("three", 0), ("one", 1), ("two", 2)],
        "the board reads back in the dragged order with the new positions, densely from 0"
    );

    // The write is POSITIONAL ONLY. Each dragged row is re-read by its GLOBAL id
    // rather than filtered out of `list_tasks`: the filtered form is VACUOUS — it
    // would select on `stage_slug` and then assert on `stage_slug`, so it would
    // pass even if the UPDATE had rewritten the column.
    for task in [&one, &two, &three] {
        let stored = db
            .get_task(&task.id)
            .expect("get_task")
            .expect("the dragged card is still there");
        assert_eq!(
            stored.stage_slug, "backlog",
            "a within-column reorder never changes `stage_slug` (that is `move_task`)"
        );
        assert_eq!(stored.number, task.number, "and never renumbers");
        assert_eq!(
            stored.updated_at, task.updated_at,
            "spec §3 writes `sort_order` ONLY — `updated_at` is a last-edited clock \
             and a reorder that moves it makes the clock lie (weak if the create ran \
             in the same millisecond, but it can never fail spuriously)"
        );
    }
    let numbers: Vec<i64> = db
        .list_tasks(&space)
        .expect("list_tasks")
        .iter()
        .filter(|task| task.stage_slug == "backlog")
        .map(|task| task.number)
        .collect();
    assert_eq!(
        numbers,
        vec![3, 1, 2],
        "`number` is a label that is NEVER renumbered (ADR 0090): read in the NEW \
         position order the labels come back 3,1,2 — visibly out of order, and that \
         is the correct outcome. A reorder that renumbered the labels would silently \
         re-point every historical mention of `T1`."
    );

    // The control group: `sort_order` is per-Space, so the numbers this call
    // never named stay exactly where they were.
    assert_eq!(
        sort_order_of(&db, "tasks", "id", &outside.id),
        outside.sort_order,
        "a card in ANOTHER STAGE keeps its own position — this verb writes only the ids it was handed"
    );
    assert_eq!(
        sort_order_of(&db, "tasks", "id", &outside_too.id),
        outside_too.sort_order,
        "and so does its neighbour"
    );
}

/// (the scoping rule) An id the caller had no right to name is refused, loudly,
/// and NOTHING is written.
///
/// `tasks.id` is a GLOBAL key and `space_path` is not part of it, so a caller
/// can hand back a card from another stage or another Space. `reorder_spaces`
/// treats an unknown id as a no-op because a path matches no row at all; here an
/// id that EXISTS but is not in this `(space, stage)` slice is a different thing
/// — writing it would move a card the user is not looking at, possibly into a
/// column it is not in. `BoardError::MissingTask` names it (the same absence
/// variant `edit_task` uses: a WRITE the caller believes succeeded, not a read
/// that came back empty), and the atomicity half is the point — the rejection
/// happens inside the transaction, so the cards the caller DID name keep their
/// old positions rather than landing half-renumbered.
#[test]
fn reorder_tasks_refuses_a_foreign_id_and_writes_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-reord-nope-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("foreign");
    let other = board_space("other-space");
    db.get_board(&space).expect("seed");

    let one = db.create_task(&space, "one", None, None).expect("create");
    let two = db.create_task(&space, "two", None, None).expect("create");
    let three = db.create_task(&space, "three", None, None).expect("create");
    let in_done = db
        .create_task(&space, "in-done", None, Some("done"))
        .expect("create in another stage");
    let elsewhere = db
        .create_task(&other, "elsewhere", None, None)
        .expect("create in another space");

    // A card from another STAGE of the SAME Space, handed over AFTER two valid
    // ids. The two valid ids are deliberately at indices whose values DIFFER
    // from their stored positions (three was 2, one was 0; the slice would write
    // 0 and 1) — otherwise the "nothing was written" assertion below would pass
    // even with no rollback at all, which is exactly the vacuous pin this repo
    // keeps documenting.
    let err = db
        .reorder_tasks(
            &space,
            "backlog",
            &[one.id.clone(), three.id.clone(), in_done.id.clone()],
        )
        .expect_err("a card that is not in `backlog` must not be repositioned by this call");
    assert!(
        matches!(&err, BoardError::MissingTask(id) if id.as_str() == in_done.id.as_str()),
        "the error must be MissingTask NAMING the offending id, got {err:?}"
    );
    assert_eq!(
        (
            sort_order_of(&db, "tasks", "id", &one.id),
            sort_order_of(&db, "tasks", "id", &three.id),
            sort_order_of(&db, "tasks", "id", &in_done.id),
        ),
        (one.sort_order, three.sort_order, in_done.sort_order),
        "the rejection is ATOMIC — the two VALID ids in the same slice keep their OLD \
         positions rather than landing half-renumbered (the transaction rolled back)"
    );

    // A card from another SPACE (the ADR 0090 no-FK shape makes this reachable:
    // ids are global, `space_path` is just a column).
    let err = db
        .reorder_tasks(&space, "backlog", &[two.id.clone(), elsewhere.id.clone()])
        .expect_err("a card from another Space must not be repositioned by this call");
    assert!(
        matches!(&err, BoardError::MissingTask(id) if id.as_str() == elsewhere.id.as_str()),
        "the error must name the foreign id, got {err:?}"
    );
    assert_eq!(
        sort_order_of(&db, "tasks", "id", &elsewhere.id),
        elsewhere.sort_order,
        "the other Space's card is untouched"
    );

    // An id with no row at all is the same rejection, not a silent no-op: every
    // id this verb is handed is one the caller believes it just dragged.
    let ghost = format!("tsk_{}", uuid::Uuid::new_v4());
    let err = db
        .reorder_tasks(&space, "backlog", std::slice::from_ref(&ghost))
        .expect_err("an id matching no row is refused here");
    assert!(
        matches!(&err, BoardError::MissingTask(id) if id.as_str() == ghost.as_str()),
        "got {err:?}"
    );

    // A STAGE that does not exist in this Space is refused with the stage error
    // (ADR 0090's rule: name the valid slugs so the caller self-corrects).
    let err = db
        .reorder_tasks(&space, "nonsense", std::slice::from_ref(&one.id))
        .expect_err("a stage that is not one of this Space's columns is refused");
    assert!(
        matches!(&err, BoardError::MissingStage { wanted, .. } if wanted == "nonsense"),
        "got {err:?}"
    );

    // And the happy path still works AFTER the rejections (no poisoned state).
    db.reorder_tasks(&space, "backlog", &[two.id.clone(), one.id.clone()])
        .expect("a valid reorder still succeeds after the refusals");
    assert_eq!(
        (
            sort_order_of(&db, "tasks", "id", &two.id),
            sort_order_of(&db, "tasks", "id", &one.id),
        ),
        (0, 1),
        "the valid reorder landed"
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
    let source = include_str!("../../db.rs");
    let fn_body = source
        .split("fn backfill_session_todos")
        .nth(1)
        .expect("the backfill function")
        .split("\nfn ")
        .next()
        .expect("the backfill body");
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
    // a gate or a column name.
    assert!(
        !source.contains("checklist_json"),
        "sessions.todos_json is FROZEN (ADR 0093) — no column rename here"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// T1 (issue #179) — the configurable-Stage schema, its gated migration, the six
// Stage verbs, the Strict-workflow gate on `move_task`, and the `board_strict`
// read.
//
// Spec `docs/roadmap/task-board-stage-config.md` §3, §3.1, §4, §4.1, §4.2, §5;
// ADR 0098 (a Stage owns the launch Skill) and ADR 0099 (the transition graph,
// enforced only under a per-Space opt-in).
// ═════════════════════════════════════════════════════════════════════════════

/// The schema a pre-#179 database holds: the FIVE-column `stages`, the
/// `spaces` row with no `board_strict`, complete `sessions`, and the tail with
/// its FK so `Db::open`'s FK-rewrite batch stays quiet.
///
/// This is the string the migration tests hand [`preexisting_db`]. It is spelled
/// from the cluster's macros so a future column addition cannot quietly leave it
/// stale in one table while the other fixtures move — but note it is the ONLY
/// fixture allowed to omit TWO gated columns, because a migration test wants
/// every #179 gate to fire at once (the cluster fixtures must never use it).
const SCHEMA_PRE_TASK_BOARD_CONFIG: &str = concat!(
    legacy_sessions_complete!(),
    legacy_stages_pre_task_board_config!(),
    legacy_spaces_without_board_strict!(),
    legacy_tail!()
);

/// The five Stage rows a pre-#179 install holds for one Space, plus that
/// Space's `spaces` row (keyed RAW — the migration never re-keys `spaces`).
fn pre_task_board_rows(space: &str) -> String {
    format!(
        "INSERT INTO spaces (path, created_at, last_opened_at, trusted, sort_order) \
         VALUES ('{space}', 1, 1, 0, 0);\n\
         INSERT INTO stages (space_path, slug, label, sort_order) VALUES \
           ('{space}','backlog','Backlog',0),\
           ('{space}','research','Research',1),\
           ('{space}','approved','Approved',2),\
           ('{space}','doing','Doing',3),\
           ('{space}','done','Done',4);\n"
    )
}

/// Does this live database have `table.column`? (The fresh-database half of the
/// schema claim goes straight to `pragma_table_info`, because the point is that
/// the COLUMN exists without any `ALTER` having run.)
fn has_column(db: &Db, table: &str, column: &str) -> bool {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let has: i64 = guard
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            params![table, column],
            |row| row.get(0),
        )
        .expect("pragma_table_info should read");
    has > 0
}

/// `(slug, sort_order)` for one Space's stages, in `sort_order`.
fn stage_order(db: &Db, space: &str) -> Vec<(String, i64)> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = guard
        .prepare(
            "SELECT slug, sort_order FROM stages WHERE space_path = ?1 \
             ORDER BY sort_order ASC, slug ASC",
        )
        .expect("prepare");
    stmt.query_map(params![space], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })
    .expect("query")
    .collect::<Result<Vec<_>, _>>()
    .expect("rows")
}

/// (spec §3 + §3.1, the fresh path) a brand-new database gets all THREE new
/// columns from `SCHEMA` — no `ADD COLUMN` runs, because no gate's probe finds a
/// missing column — and seeds FIVE stages (ADR 0107 retired the seeded `discuss`).
#[test]
fn fresh_database_gets_the_three_new_columns_from_schema_and_seeds_five() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-fresh-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    for (table, column) in [
        ("stages", "on_enter_skill"),
        ("stages", "next_slugs"),
        ("spaces", "board_strict"),
    ] {
        assert!(
            has_column(&db, table, column),
            "a fresh database must get `{table}.{column}` from SCHEMA"
        );
    }

    let space = board_space("fresh-columns");
    let board = db.get_board(&space).expect("get_board seeds five");
    let shaped: Vec<(&str, i64, Option<&str>)> = board
        .iter()
        .map(|c| {
            (
                c.stage.slug.as_str(),
                c.stage.sort_order,
                c.stage.on_enter_skill.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        shaped,
        vec![
            ("backlog", 0, None),
            ("research", 1, Some("research")),
            ("approved", 2, None),
            ("doing", 3, None),
            ("done", 4, None),
        ],
        "five defaults in order, and only the one surviving launch column \
         carries a Skill (ADR 0098, as amended by ADR 0107)"
    );
    assert!(
        board.iter().all(|c| c.stage.next_slugs.is_none()),
        "`next_slugs` is NOT backfilled and the seed leaves it NULL — NULL means \
         unconfigured, not \"no edges\" (ADR 0099)"
    );
}

/// (ADR 0107 — the surviving half of spec §3.1) a pre-#179 database that has
/// the FIVE-column `stages` and no `on_enter_skill` gains the column and the ONE
/// launch Skill that still exists (`research`), and gains NO `discuss` row —
/// inventing a column for a retired Stage is no longer this gate's job, and a
/// Space that still carries a `discuss` column is user data the Stage editor
/// owns. A SECOND `Db::open` changes nothing.
///
/// This is the replacement pin for the three migration tests ADR 0107 deleted
/// with the `discuss` backfill: without it the surviving gate (the `ALTER` plus
/// the `research` UPDATE) would be untested on the migration path.
#[test]
fn the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-gate-", "scratch");
    let space = board_space("upgrade-me");
    let path = preexisting_db(
        &dir,
        SCHEMA_PRE_TASK_BOARD_CONFIG,
        &pre_task_board_rows(&space),
    );

    {
        let db = Db::open(&path).expect("the gate runs on open");

        // (a) `research` gained its launch Skill from the surviving UPDATE.
        assert_eq!(
            db.list_stages(&space)
                .expect("list_stages")
                .iter()
                .find(|s| s.slug == "research")
                .expect("the research row exists")
                .on_enter_skill
                .as_deref(),
            Some("research"),
            "the one launch Skill that still exists is backfilled (spec §3.1 \
             step 1, the step ADR 0107 kept)"
        );
        // (b) no `discuss` row was invented, and the five rows kept their indices.
        assert_eq!(
            stage_order(&db, &space),
            vec![
                ("backlog".to_string(), 0),
                ("research".to_string(), 1),
                ("approved".to_string(), 2),
                ("doing".to_string(), 3),
                ("done".to_string(), 4),
            ],
            "the gate inserts NO `discuss` row and shifts NO `sort_order` — the \
             pre-#179 board keeps the layout its owner has (ADR 0107)"
        );
        let has_discuss = {
            let guard = db.conn.lock().expect("db mutex poisoned");
            stage_slug_exists(&guard, &space, "discuss").expect("the probe reads")
        };
        assert!(
            !has_discuss,
            "no `discuss` column arrives on an upgraded Space — the retired Stage \
             must not be re-invented by a migration (ADR 0107)"
        );
        assert_eq!(
            db.list_stages(&space)
                .expect("list_stages")
                .iter()
                .filter(|s| s.on_enter_skill.is_some())
                .count(),
            1,
            "exactly ONE Stage carries a launch Skill after the gate — a surviving \
             `discuss` backfill would make this 2"
        );
        assert_eq!(
            raw_i64s(
                &db,
                &format!(
                    "SELECT COUNT(*) FROM stages WHERE space_path = '{space}' \
                     AND next_slugs IS NOT NULL"
                )
            )
            .first(),
            Some(&0),
            "`next_slugs` is still NOT backfilled (spec §3.1 step 4, ADR 0099)"
        );
        // The upgraded board is the five-column board the user sees.
        let board = db.get_board(&space).expect("get_board after the gate");
        assert_eq!(board.len(), 5, "five columns after one open");
    }

    // (c) Re-open the SAME file: the gate's probe now finds the column, so
    // nothing re-runs — no second row, no second shift, no re-backfill.
    let db = Db::open(&path).expect("a second open is a no-op");
    assert_eq!(
        stage_order(&db, &space),
        vec![
            ("backlog".to_string(), 0),
            ("research".to_string(), 1),
            ("approved".to_string(), 2),
            ("doing".to_string(), 3),
            ("done".to_string(), 4),
        ],
        "idempotent on re-open: neither a second `discuss` row nor a second shift"
    );
    assert_eq!(
        db.list_stages(&space)
            .expect("list_stages")
            .iter()
            .filter(|s| s.on_enter_skill.is_some())
            .count(),
        1,
        "the gate ran once, not twice"
    );
}

// ── The six Stage verbs (spec §4, §4.1, §5) ─────────────────────────────────

/// (spec §4 + §5) `create_stage` appends at the end, and refuses a slug
/// collision by NAMING the slugs that are taken rather than suffixing — a
/// silent `spike-2` is a slug nobody typed.
#[test]
fn create_stage_inserts_at_the_end_and_refuses_a_taken_slug_naming_the_valid_ones() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-create-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("create");
    db.get_board(&space).expect("seed the five");

    let made = db
        .create_stage(&space, "spike", "Spike!", Some("brainstorm"))
        .expect("create_stage");
    assert_eq!(made.slug, "spike");
    assert_eq!(
        made.label, "Spike!",
        "the LABEL is stored as the user typed it"
    );
    assert_eq!(made.sort_order, 5, "a new column joins at the END");
    assert_eq!(
        made.on_enter, "none",
        "the DDL default, not a second copy here"
    );
    assert_eq!(
        made.on_enter_skill.as_deref(),
        Some("brainstorm"),
        "ADR 0098: the Stage owns the launch Skill"
    );
    assert_eq!(made.next_slugs, None, "a new column starts unconfigured");

    let err = db
        .create_stage(&space, "research", "Research Again", None)
        .expect_err("a taken slug is refused, never suffixed");
    match err {
        BoardError::StageSlugTaken { slug, available } => {
            assert_eq!(slug, "research");
            assert!(
                available.contains("backlog") && available.contains("done"),
                "the refusal names the valid slugs (ADR 0090), got `{available}`"
            );
        }
        other => panic!("expected StageSlugTaken, got {other:?}"),
    }
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        6,
        "the refusal wrote nothing"
    );
}

/// (spec §5) an empty derived slug is a refusal in storage too, so the write
// path cannot be reached with a column nobody can name.
#[test]
fn create_stage_refuses_an_empty_slug() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-empty-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("empty-slug");
    db.get_board(&space).expect("seed");

    for slug in ["", "   "] {
        let err = db
            .create_stage(&space, slug, "Whitespace", None)
            .expect_err("{slug:?} is not a slug");
        assert!(
            matches!(err, BoardError::EmptyStageSlug),
            "for {slug:?}, got {err:?}"
        );
    }
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "neither refusal wrote a row"
    );
}

/// (spec §5 — the slug is FROZEN) `rename_stage` writes the LABEL and nothing
/// else, because `tasks.stage_slug` points at the slug by string with no FK.
#[test]
fn rename_stage_writes_only_the_label_and_keeps_the_slug() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-rename-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("rename");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "pointed card", None, Some("research"))
        .expect("create_task");

    let renamed = db
        .rename_stage(&space, "research", "Spike")
        .expect("rename_stage");
    assert_eq!(renamed.slug, "research", "the KEY never moves");
    assert_eq!(renamed.label, "Spike");
    assert_eq!(
        renamed.sort_order, 1,
        "and neither does the position (index 1 on the five-stage seed — ADR 0107 \
         dropped the `discuss` row that used to push `research` to 2)"
    );
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("the card")
            .stage_slug,
        "research",
        "the card still points at the same slug — the rename did not orphan it"
    );

    let err = db
        .rename_stage(&space, "nope", "Ghost")
        .expect_err("a missing stage is refused");
    assert!(
        matches!(err, BoardError::MissingStage { .. }),
        "got {err:?}"
    );
}

/// (ADR 0098) `set_stage_skill` sets the Skill and CLEARS it back to NULL.
#[test]
fn set_stage_skill_sets_and_clears_the_skill() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-skill-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("skill");
    db.get_board(&space).expect("seed");

    let set = db
        .set_stage_skill(&space, "approved", Some("review"))
        .expect("set");
    assert_eq!(set.on_enter_skill.as_deref(), Some("review"));

    let cleared = db
        .set_stage_skill(&space, "approved", None)
        .expect("clear to NULL");
    assert_eq!(
        cleared.on_enter_skill, None,
        "`None` clears the column rather than writing an empty string"
    );

    let err = db
        .set_stage_skill(&space, "ghost", Some("x"))
        .expect_err("a missing stage is refused BEFORE the write");
    assert!(
        matches!(err, BoardError::MissingStage { .. }),
        "got {err:?}"
    );
}

/// (ADR 0099) the edges round-trip: JSON at rest, `Vec<String>` back out.
#[test]
fn set_stage_next_persists_the_edges_and_round_trips_them() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-next-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("next");
    db.get_board(&space).expect("seed");

    let wanted = vec!["research".to_string(), "approved".to_string()];
    let set = db
        .set_stage_next(&space, "backlog", &wanted)
        .expect("set_stage_next");
    assert_eq!(
        set.next_slugs,
        Some(wanted.clone()),
        "button-render order is preserved, not sorted"
    );

    let raw = raw_column(
        &db,
        &format!("SELECT next_slugs FROM stages WHERE space_path = '{space}' AND slug = 'backlog'"),
    );
    assert_eq!(
        raw.first().map(|s| s.as_str()),
        Some(r#"["research","approved"]"#),
        "JSON-at-rest, following the `sessions.todos_json` precedent"
    );
    let read_back = db.get_board(&space).expect("get_board");
    assert_eq!(
        read_back[0].stage.next_slugs,
        Some(wanted),
        "and the board read parses it back"
    );
}

/// (spec §4) an unknown destination is a REJECTION naming the valid slugs, not a
/// silent drop — a dropped destination is a workflow that shrank.
#[test]
fn set_stage_next_refuses_an_unknown_slug_naming_the_valid_ones() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-next-404-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("next-404");
    db.get_board(&space).expect("seed");

    let wanted = vec!["done".to_string(), "sprint-review".to_string()];
    let err = db
        .set_stage_next(&space, "backlog", &wanted)
        .expect_err("an unknown destination is refused, not filtered");
    match err {
        BoardError::MissingStage { wanted, available } => {
            assert_eq!(wanted, "sprint-review");
            assert!(
                available.contains("research"),
                "the refusal names the valid slugs, got `{available}`"
            );
        }
        other => panic!("expected MissingStage, got {other:?}"),
    }
    assert_eq!(
        db.get_board(&space).expect("get_board")[0].stage.next_slugs,
        None,
        "the refusal wrote nothing at all — not even the valid half"
    );
}

/// (spec §4) a self-loop is a button that moves a card to the column it is
/// already in.
#[test]
fn set_stage_next_refuses_a_self_loop() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-loop-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("loop");
    db.get_board(&space).expect("seed");

    let err = db
        .set_stage_next(&space, "doing", &["doing".to_string()])
        .expect_err("a stage cannot lead to itself");
    assert!(
        matches!(&err, BoardError::SelfLoop { slug } if slug == "doing"),
        "got {err:?}"
    );
}

/// (ADR 0099's NULL-vs-empty distinction) `[]` is a CONFIGURED "no edges"
/// answer and must round-trip as `Some(vec![])`, while NULL stays the
/// unconfigured answer. Collapsing the two is the silent-green shape ADR 0099
/// rejects by name.
#[test]
fn set_stage_next_an_empty_slice_persists_explicit_no_edges() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-nedges-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("no-edges");
    db.get_board(&space).expect("seed");

    let set = db
        .set_stage_next(&space, "done", &[])
        .expect("[] is a legal configuration");
    assert_eq!(
        set.next_slugs,
        Some(vec![]),
        "explicit, and distinguishable"
    );

    let raw = raw_column(
        &db,
        &format!(
            "SELECT COALESCE(next_slugs,'NULL') FROM stages \
             WHERE space_path = '{space}' AND slug = 'done'"
        ),
    );
    assert_eq!(
        raw.first().map(|s| s.as_str()),
        Some("[]"),
        "at rest it is `[]`, NOT NULL — otherwise the two meanings collapse"
    );
}

/// (spec §4 — the `reorder_spaces` contract, not `reorder_tasks`'s) the whole
/// slice renumbers, index becomes `sort_order`, dense from 0, in one call.
#[test]
fn reorder_stages_persists_the_new_column_order_in_one_pass() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-order-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("order");
    db.get_board(&space).expect("seed");

    let slugs = ["done", "doing", "approved", "research", "backlog"]
        .map(str::to_string)
        .to_vec();
    db.reorder_stages(&space, &slugs).expect("reorder_stages");

    assert_eq!(
        stage_order(&db, &space),
        slugs
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as i64))
            .collect::<Vec<_>>(),
        "the caller's order IS the stored order, dense from 0"
    );
    let board = db.get_board(&space).expect("get_board");
    assert_eq!(
        board
            .iter()
            .map(|c| c.stage.slug.as_str())
            .collect::<Vec<_>>(),
        vec!["done", "doing", "approved", "research", "backlog"],
        "and the board renders that order"
    );
}

/// (spec §4) an unknown slug is a SILENT no-op — the `reorder_spaces` contract.
/// The board's editor passes every Stage it shows, so a row it never mentioned
/// keeps its place rather than failing the whole drag.
#[test]
fn reorder_stages_is_a_silent_no_op_on_an_unknown_slug() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-order2-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("order-ghost");
    db.get_board(&space).expect("seed");

    let slugs = vec![
        "done".to_string(),
        "ghost".to_string(),
        "backlog".to_string(),
    ];
    db.reorder_stages(&space, &slugs)
        .expect("an unknown slug is a no-op, not an error");

    let after = stage_order(&db, &space);
    let named =
        |slug: &str| -> Option<i64> { after.iter().find(|(s, _)| s == slug).map(|(_, o)| *o) };
    assert_eq!(named("done"), Some(0), "the named rows renumber…");
    assert_eq!(named("backlog"), Some(2), "…in the caller's order…");
    assert_eq!(named("ghost"), None, "…and the ghost wrote no row at all");
    for (slug, untouched) in [("research", 1), ("approved", 2), ("doing", 3)] {
        assert_eq!(
            named(slug),
            Some(untouched),
            "a row the caller never named keeps the position it had — the \
             `reorder_spaces` contract, not `reorder_tasks`'s refusal"
        );
    }
}

/// (spec §4.1, refusal one) deleting a Stage that holds cards would make them
/// INVISIBLE to `get_board` while they keep costing money — the no-FK
/// consequence ADR 0090 names. The error carries the count AND the alternatives.
#[test]
fn delete_stage_refuses_a_stage_that_holds_cards_and_names_the_count_and_the_slugs() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-cards-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-cards");
    db.get_board(&space).expect("seed");
    db.create_task(&space, "one", None, Some("doing"))
        .expect("create");
    db.create_task(&space, "two", None, Some("doing"))
        .expect("create");

    let err = db
        .delete_stage(&space, "doing", None)
        .expect_err("a Stage with cards is not deletable");
    match err {
        BoardError::StageNotEmpty {
            slug,
            count,
            available,
        } => {
            assert_eq!(slug, "doing");
            assert_eq!(count, 2, "the refusal counts what it is refusing");
            assert!(
                available.contains("done"),
                "and names where they could go, got `{available}`"
            );
        }
        other => panic!("expected StageNotEmpty, got {other:?}"),
    }
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "the refusal deleted nothing"
    );
}

/// (spec §4.1, refusal two, ADR 0099's Consequence) deleting a Stage another
/// Stage's graph points at would silently SHRINK a workflow. Filtering dangling
/// slugs at read time is the rejected alternative; this refusal is the chosen one.
#[test]
fn delete_stage_refuses_a_stage_another_stage_s_next_slugs_names_it() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-ref-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-referenced");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["doing".to_string()])
        .expect("backlog → doing");

    let err = db
        .delete_stage(&space, "doing", None)
        .expect_err("a referenced Stage is not deletable");
    match err {
        BoardError::StageReferenced { slug, referrers } => {
            assert_eq!(slug, "doing");
            assert_eq!(
                referrers, "backlog",
                "the refusal names the Stage that points here, so the user knows \
                 which graph to edit"
            );
        }
        other => panic!("expected StageReferenced, got {other:?}"),
    }

    // A Stage whose graph merely does not mention the target is not a referrer,
    // and a NULL graph never is (unconfigured must not block a delete).
    db.set_stage_next(&space, "backlog", &["done".to_string()])
        .expect("re-point the edge away");
    db.delete_stage(&space, "doing", None)
        .expect("with the edge gone, the delete goes through");
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        4,
        "one row deleted"
    );
}

/// (spec §4.1, refusal three) `create_task`'s first-column fallback and
/// `get_board`'s shape both assume at least one row.
#[test]
fn delete_stage_refuses_the_last_stage() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-last-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-last");
    db.get_board(&space).expect("seed");
    let only = db
        .create_stage(&space, "solo", "Solo", None)
        .expect("create_stage");
    // Empty the seeded five, leaving exactly one row.
    for slug in ["backlog", "research", "approved", "doing", "done"] {
        db.delete_stage(&space, slug, Some("solo"))
            .expect("clear the seeded columns into solo");
    }
    assert_eq!(db.list_stages(&space).expect("list_stages").len(), 1);

    let err = db
        .delete_stage(&space, "solo", None)
        .expect_err("the last column is not deletable");
    assert!(
        matches!(&err, BoardError::LastStage { slug } if slug == "solo"),
        "got {err:?}"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        1,
        "and the refusal left the one row that keeps the board a board — the \
         card-creating fallback still has somewhere to land"
    );
    assert_eq!(only.slug, "solo");
}

/// (spec §4.1's asymmetry, the five-compactions bug guard) the relocation is ONE
/// `UPDATE tasks SET stage_slug …`, NOT N `move_task` calls: `move_task` reads
/// the destination's `on_enter` and the command layer fires its boost, so
/// "empty this column first" would attempt N compactions as bookkeeping.
/// Observables: every card moved, `updated_at` UNTOUCHED (a relocation a delete
/// forced is not an edit), and the destination's `on_enter = 'compact'` fired
/// nothing — no Session, no link, no `MoveOutcome`.
#[test]
fn delete_stage_relocates_cards_with_one_update_without_touching_updated_at_or_on_enter() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-move-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-relocate");
    db.get_board(&space).expect("seed");
    let first = db
        .create_task(&space, "one", None, Some("doing"))
        .expect("create");
    let second = db
        .create_task(&space, "two", None, Some("doing"))
        .expect("create");
    // The destination asks for a compaction. If the relocation ran `move_task`,
    // this is where two boosts would be owed.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "UPDATE stages SET on_enter = 'compact' WHERE space_path = ?1 AND slug = 'done'",
            params![space],
        )
        .expect("make the destination a compact stage");
    // Plant a DISTINCTLY old `updated_at` rather than trusting the one
    // `create_task` stamped: a relocation landing in the same millisecond would
    // otherwise leave the "untouched" assert green by accident, and an
    // accidentally-green guard is how this assertion stops being a guard.
    const PLANTED: i64 = 1000;
    for id in [&first.id, &second.id] {
        db.conn
            .lock()
            .expect("db mutex poisoned")
            .execute(
                "UPDATE tasks SET updated_at = 1000 WHERE id = ?1",
                params![id],
            )
            .expect("plant the old timestamp");
    }

    db.delete_stage(&space, "doing", Some("done"))
        .expect("delete with a destination relocates");

    for id in [&first.id, &second.id] {
        let card = db.get_task(id).expect("get_task").expect("the card");
        assert_eq!(card.stage_slug, "done", "the card moved out");
    }
    let moved_updated: Vec<i64> = raw_i64s(
        &db,
        &format!("SELECT updated_at FROM tasks WHERE space_path = '{space}' ORDER BY number ASC"),
    );
    assert_eq!(
        moved_updated,
        vec![PLANTED, PLANTED],
        "`updated_at` is UNTOUCHED — the same reason `reorder_tasks` gives: a \
         relocation a delete forced is not an edit, and the planted timestamp \
         survived the relocation"
    );
    assert_eq!(
        db.task_sessions(&first.id).expect("links").len(),
        0,
        "the relocation created no Session and no link: the destination's \
         `compact` was never acted on"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        4,
        "and the emptied column is gone"
    );
}

/// (spec §4.1) a destination that is not one of THIS Space's columns is refused
/// by name — the same `missing_stage` sentence `move_task` composes.
#[test]
fn delete_stage_refuses_a_relocate_destination_that_is_not_a_stage_of_this_space() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-404-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-ghost-dest");
    db.get_board(&space).expect("seed");
    db.create_task(&space, "stays put", None, Some("doing"))
        .expect("create");

    let err = db
        .delete_stage(&space, "doing", Some("sprint-review"))
        .expect_err("the destination must be one of this Space's stages");
    assert!(
        matches!(&err, BoardError::MissingStage { wanted, .. } if wanted == "sprint-review"),
        "got {err:?}"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "a refused delete deleted the column AND stranded the card in no way at all"
    );
    assert_eq!(
        db.list_tasks(&space).expect("list_tasks")[0].stage_slug,
        "doing",
        "the card is still where it was"
    );
}

// ── The Strict workflow (ADR 0099) — the write, the read, and the gate ──────

/// (ADR 0099) the toggle persists both ways and reads back through
/// `Db::board_strict`; a Space with NO `spaces` row reads `false`, which is the
/// same answer `move_task`'s gate computes — the Switch and the gate cannot
/// disagree about a Space that has no row.
#[test]
fn set_board_strict_persists_1_and_0_and_reads_back() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-write-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-toggle");
    db.upsert_space(&space, false).expect("upsert_space");

    assert!(
        db.set_board_strict(&space, true).expect("set_board_strict"),
        "a matching row reports that it was touched"
    );
    assert!(
        db.board_strict(&space).expect("board_strict"),
        "the read sees what the write stored"
    );
    assert!(db
        .set_board_strict(&space, false)
        .expect("clear_board_strict"));
    assert!(
        !db.board_strict(&space).expect("board_strict"),
        "the flag is a toggle, not a ratchet"
    );
    assert_eq!(
        raw_i64s(
            &db,
            &format!("SELECT board_strict FROM spaces WHERE path = '{space}'")
        )
        .first(),
        Some(&0),
        "1 and 0 are the two stored values"
    );

    // A Space with no row at all: a silent no-op WRITE, and `false` READ.
    let nowhere = board_space("strict-no-row");
    assert!(
        !db.set_board_strict(&nowhere, true).expect("no-op write"),
        "mirrors `set_space_trusted`: a missing row is a diagnosable no-op"
    );
    assert!(
        !db.board_strict(&nowhere).expect("board_strict"),
        "and the read answers false, not an error"
    );
}

/// (ADR 0099's default) with no `spaces` row the board behaves EXACTLY as it did
/// before this feature: a non-edge drag is accepted. This is the assertion that
/// an upgrade changes nothing for the Spaces the board tests model.
#[test]
fn move_task_with_no_spaces_row_is_not_strict() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-norow-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-absent");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["done".to_string()])
        .expect("backlog → done only");
    let card = db
        .create_task(&space, "free card", None, None)
        .expect("create_task");

    let outcome = db
        .move_task(&space, &card.id, "approved")
        .expect("no spaces row → flag 0 → the check is skipped entirely");
    assert_eq!(outcome.on_enter, "none");
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "approved"
    );
}

/// (ADR 0099's whole reason for being opt-in) `board_strict = 0` is the DEFAULT,
/// so upgrading cannot change how an existing board answers a drag.
#[test]
fn move_task_with_board_strict_zero_accepts_a_non_edge_move() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-off-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-off");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, false).expect("explicitly off");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["done".to_string()])
        .expect("backlog → done only");
    let card = db
        .create_task(&space, "unconstrained", None, None)
        .expect("create_task");

    db.move_task(&space, &card.id, "approved")
        .expect("flag 0 skips the check entirely");
}

/// (spec §4.2) under `board_strict = 1`, a drag that is not an edge of the FROM
/// Stage's graph is refused BEFORE the write, and the sentence names the legal
/// destinations — the frontend's optimistic revert needs nothing more.
#[test]
fn move_task_with_board_strict_one_refuses_a_non_edge_move_naming_the_legal_destinations() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-on-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-on");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, true).expect("strict ON");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["done".to_string()])
        .expect("backlog → done, and nothing else");
    let card = db
        .create_task(&space, "governed card", None, None)
        .expect("create_task");

    let err = db
        .move_task(&space, &card.id, "approved")
        .expect_err("approved is not an edge of backlog");
    match err {
        BoardError::StrictMoveRefused { from, to, allowed } => {
            assert_eq!(from, "backlog", "the FROM stage is named");
            assert_eq!(to, "approved");
            assert_eq!(allowed, "done", "and so are the legal destinations");
        }
        other => panic!("expected StrictMoveRefused, got {other:?}"),
    }
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "backlog",
        "a refused move writes NOTHING"
    );

    // The legal edge, same configuration.
    db.move_task(&space, &card.id, "done")
        .expect("the configured edge is accepted");
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "done"
    );
}

/// (spec §4.2 + ADR 0099's NULL rule) `NULL` means UNCONFIGURED, not forbidden.
/// Under Strict, a Stage with no graph still accepts anything — otherwise every
/// existing board that opts in would refuse every drag.
#[test]
fn move_task_with_board_strict_one_and_null_next_slugs_accepts_any_move() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-null-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-null");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, true).expect("strict ON");
    db.get_board(&space)
        .expect("seed — every next_slugs is NULL");
    let card = db
        .create_task(&space, "unconfigured board", None, None)
        .expect("create_task");

    db.move_task(&space, &card.id, "done")
        .expect("NULL next_slugs passes unconditionally");
    db.move_task(&space, &card.id, "research")
        .expect("and it passes in both directions — position is not adjacency");
}

/// (ADR 0099's explicit consequence) an explicit `[]` under Strict is NOT the
/// same as NULL: it is a configured graph with no edges, so every move out of
/// that Stage is refused and the sentence says so instead of listing nothing.
#[test]
fn move_task_with_board_strict_one_and_an_empty_graph_refuses_everything() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-empty-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-empty");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, true).expect("strict ON");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &[])
        .expect("an explicit no-edge graph");
    let card = db
        .create_task(&space, "boxed in", None, None)
        .expect("create_task");

    let err = db
        .move_task(&space, &card.id, "done")
        .expect_err("a configured graph with no edges allows nothing");
    match err {
        BoardError::StrictMoveRefused { allowed, .. } => {
            assert!(
                !allowed.is_empty(),
                "the sentence must say WHY there are no destinations, got \
                 `{allowed}` — an empty list reads like a bug"
            );
        }
        other => panic!("expected StrictMoveRefused, got {other:?}"),
    }
}

/// (spec §3's leniency claim) a `next_slugs` cell that is not a JSON array is
/// "unconfigured" — it must NEVER blank the board or surface a parse error. The
/// strictness lives in the writer; the reader only has to survive data older or
/// foreigner than itself.
#[test]
fn next_slugs_that_is_not_a_json_array_reads_as_unconfigured() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-next-bad-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("bad-json");
    db.get_board(&space).expect("seed");

    for junk in ["not json", r#"{"a":1}"#, "42", r#"[1,2]"#] {
        db.conn
            .lock()
            .expect("db mutex poisoned")
            .execute(
                "UPDATE stages SET next_slugs = ?2 WHERE space_path = ?1 AND slug = 'backlog'",
                params![space, junk],
            )
            .expect("plant the foreign value");
        let board = db
            .get_board(&space)
            .expect("a bad cell must never blank the board");
        assert_eq!(board.len(), 5, "the whole board still arrives for {junk:?}");
        assert_eq!(
            board[0].stage.next_slugs, None,
            "`{junk:?}` reads as unconfigured, never as an error"
        );
    }
}

/// (Decision 6, the key-agreement pin) `Db::board_strict` reads back EXACTLY
/// what `set_board_strict` wrote, and both go through the SAME `space_key`
/// normalization the `move_task` gate uses. The interesting failure this pins is
/// the one the vet called out: a Strict Switch lit while drags are accepted.
///
/// The setup makes the two spellings differ ON PURPOSE: the `spaces` row is
/// keyed CANONICAL (what `upsert_space` stores) and the board rows are keyed by
/// the RAW spelling the caller happens to hold. A gate that read `spaces` by the
/// raw string would find no row, compute flag 0, and ACCEPT the illegal drag
/// while `board_strict(raw)` reports Strict ON — the Switch and the enforcement
/// disagreeing about the same Space.
#[test]
fn the_board_strict_read_and_the_move_gate_agree_on_a_non_canonical_path() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-key-", "scratch");
    let folder = dir.join("space folder");
    std::fs::create_dir_all(&folder).expect("the folder exists so canonicalize works");
    let canonical = std::fs::canonicalize(&folder)
        .expect("canonicalize")
        .display()
        .to_string();
    // The SAME folder, spelled through a `..` hop — a caller's raw string that
    // is not its own canonical form (a symlink or a `..` is exactly this).
    let raw = folder.join("..").join("space folder").display().to_string();

    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.upsert_space(&canonical, false)
        .expect("the row is keyed CANONICAL");
    db.set_board_strict(&raw, true)
        .expect("the toggle arrives with the RAW spelling");

    // The read normalizes, so both spellings answer the same thing.
    assert!(
        db.board_strict(&canonical).expect("read canonical"),
        "canonical sees the flag"
    );
    assert!(
        db.board_strict(&raw).expect("read raw"),
        "and so does the raw spelling — the read mirrors `set_space_trusted`'s \
         keying, it does not re-derive it differently"
    );

    // The enforcement agrees: the board rows are keyed RAW (that is what the
    // caller addressed), so the gate must still find the CANONICAL `spaces` row.
    db.get_board(&raw).expect("seed the raw-keyed board");
    db.set_stage_next(&raw, "backlog", &["done".to_string()])
        .expect("backlog → done only");
    let card = db
        .create_task(&raw, "governed through a symlink", None, None)
        .expect("create_task");

    let err = db
        .move_task(&raw, &card.id, "approved")
        .expect_err("the Switch is ON, so the gate must be ON too");
    assert!(
        matches!(err, BoardError::StrictMoveRefused { .. }),
        "the enforcement read the flag through `space_key`, got {err:?}"
    );
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "backlog",
        "and nothing was written"
    );
}

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

/// Every `task_artifacts` row, read through an INDEPENDENT connection to the
/// same file (the `link_rows` precedent in `commands/tasks/tests/seed.rs`): the
/// assertions below ask what the DATABASE holds, not what a `Db` method chose to
/// report about it, so a method that wrote nothing and returned a plausible meta
/// still reddens.
fn artifact_rows(db_path: &std::path::Path) -> Vec<(String, String, String, i64, i64)> {
    let conn = rusqlite::Connection::open(db_path).expect("an independent connection");
    let mut stmt = conn
        .prepare(
            "SELECT task_id, key, markdown, created_at, updated_at FROM task_artifacts \
             ORDER BY rowid ASC",
        )
        .expect("prepares");
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .expect("queries");
    rows.collect::<Result<_, _>>().expect("maps")
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
