//! Tests for `db/sessions.rs`: the `sessions` verbs (record, capabilities,
//! context usage, todos, cost, archive, title, order, recency, delete).
//!
//! ⚠️ This child is the mirror's ONE ledgered exception to ADR 0112's 1,000-code-line
//! test gate — the 31 session tests are one subject and ADR 0113 forbids naming a
//! second child for a subject that does not exist, so the size is baselined rather
//! than split further.

use crate::storage::db::*;

use crate::types::SessionInfo;

use super::support::*;

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

/// (the `ready` verb) `set_session_ready` writes the three states the column has
/// and reports whether a row matched.
///
/// The three writes are the whole contract, and the third one is the half a
/// `bool` cannot spell: `Some(true)` is the claim ("come look"), `Some(false)` is
/// an explicit answer ("checked, not ready"), and `None` CLEARS it back to
/// "never claimed" — the state a Session returns to when a new turn starts and the
/// old readiness is stale. A `bool` parameter would collapse that third state into
/// the second one, which is the `cost_usd` NULL ≠ 0 discipline with a flag in place
/// of a cost, and the reason this verb takes `Option<bool>` and binds `Option<i64>`.
///
/// The `None` arm is asserted against a row that previously held `1`, not a fresh
/// one: clearing a NULL is a no-op that a broken `UPDATE … = NULL` would also
/// survive, so only the `1 → NULL` transition proves the write lands.
///
/// A missing id returns `Ok(false)` — the same shape `set_session_archived` and
/// `set_session_title` have (a missing row is not an error).
#[test]
fn set_session_ready_roundtrips_all_three_states() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-readyverb-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");
    db.record_session(&title_session("sess-2"))
        .expect("record_session should succeed");

    // A fresh row is ABSENT, not answered — the column has no `DEFAULT`.
    assert_eq!(
        ready_of(&db, "sess-1"),
        None,
        "a recorded session reads NULL, not 0"
    );

    // 1 — the claim.
    assert!(
        db.set_session_ready("sess-1", Some(true))
            .expect("set_session_ready should succeed"),
        "a matching row returns true"
    );
    assert_eq!(ready_of(&db, "sess-1"), Some(1), "Some(true) writes 1");

    // 0 — the explicit answer, and NOT the same value as NULL.
    assert!(
        db.set_session_ready("sess-1", Some(false))
            .expect("set_session_ready should succeed"),
        "a matching row returns true"
    );
    assert_eq!(
        ready_of(&db, "sess-1"),
        Some(0),
        "Some(false) writes 0 — a stored answer, distinct from the absent state"
    );

    // NULL — the clear (the turn-start state).
    assert!(
        db.set_session_ready("sess-1", None)
            .expect("set_session_ready should succeed"),
        "a matching row returns true"
    );
    assert_eq!(
        ready_of(&db, "sess-1"),
        None,
        "None clears a stored 1/0 back to NULL"
    );

    // The write is per-row: `sess-2` was never touched.
    assert_eq!(
        ready_of(&db, "sess-2"),
        None,
        "the verb updates ONE row by id and no other"
    );

    // A missing id is a no-op returning false (mirrors `set_session_archived`).
    assert!(
        !db.set_session_ready("no-such-session", Some(true))
            .expect("should not error"),
        "a missing row is a no-op returning false"
    );
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM sessions WHERE ready IS NOT NULL"),
        0,
        "and it wrote nothing anywhere"
    );
}

/// One row's `ready` flag, read through the raw connection as `Option<i64>`.
///
/// It goes straight to SQL because `ready` is deliberately NOT in
/// `SESSION_COLUMNS`: the board read path (a later task) is what surfaces it, and
/// the `SessionRow` projection is not widened by this change — the same discipline
/// `board_strict` and the two auto-guard columns follow, where a column is read and
/// written by SQL alone and the wire type is untouched.
fn ready_of(db: &Db, id: &str) -> Option<i64> {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT ready FROM sessions WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .expect("the row exists")
}
