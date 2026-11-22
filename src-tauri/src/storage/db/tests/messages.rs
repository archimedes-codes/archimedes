//! Tests for `db/messages.rs`: the `messages` transcript verbs and the
//! `native_messages` display transcript — chiefly `record_messages_batch`, whose
//! whole claim is ONE commit for the batch (issue #155).
//!
//! The commit counter these tests read is `wal_frame_count` in [`super::support`]
//! (the `-wal` sidecar's length), and why the two `PRAGMA`-level candidates are not
//! commit counters is recorded there.

use crate::storage::db::*;

use crate::types::SessionInfo;

use super::support::*;

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

/// (#155, the batch path) `record_messages_batch` writes N rows with FEWER
/// frames than N commits would produce — i.e. it is not N commits.
///
/// The counter is the `-wal` file's frame count, read before and after; see
/// [`wal_frame_count`] for why that is a commit counter and why the two
/// `PRAGMA`-level candidates are not. The assertion is an inequality with a
/// reason, not a magic number: N commits append >= N frames (one commit frame
/// each), so a delta BELOW N cannot be N commits. Measured against the
/// per-row-loop mutation this replaces, the delta is 3×N (each autocommit
/// re-writes the leaf page plus its commit frame); one transaction writes 3
/// frames for the same rows.
///
/// The row round-trip is asserted in the same test so a mutation that writes
/// nothing cannot pass by producing zero frames.
#[test]
fn record_messages_batch_writes_n_rows_in_one_commit() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-batch-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("s_batch"))
        .expect("record_session");
    let wal = dir.join("t.db-wal");
    // The premise, pinned: WAL really is on, or there is no `-wal` to count and
    // the test would pass on an empty file for the wrong reason.
    assert!(
        wal.exists(),
        "the premise: the database is in WAL, so commits land as frames in {:?}",
        wal.display()
    );

    const N: usize = 12;
    // The keys and payloads are OWNED (they vary per row), so build them first
    // and borrow them into the `&[...]` the method takes.
    let keys: Vec<String> = (0..N).map(|i| format!("k{i}")).collect();
    let payloads: Vec<String> = (0..N)
        .map(|i| format!("{{\"text\":\"frame {i}\"}}"))
        .collect();
    let batch: Vec<(&str, &str, Option<&str>, &str)> = keys
        .iter()
        .zip(payloads.iter())
        .map(|(k, p)| ("s_batch", "agent-text", Some(k.as_str()), p.as_str()))
        .collect();

    let before = wal_frame_count(&db, &wal);
    db.record_messages_batch(&batch)
        .expect("record_messages_batch should succeed");
    let after = wal_frame_count(&db, &wal);

    assert!(
        after > before,
        "the batch actually committed (frames {before} -> {after})"
    );
    assert!(
        after - before < N as u64,
        "N={N} rows must not cost N commits: N separate commits append at          least N frames (one commit frame each), and this batch appended {} —          one transaction writing its dirty pages plus a single commit frame          (before={before}, after={after})",
        after - before
    );
    let stored = db.messages_for("s_batch").expect("messages_for");
    assert_eq!(stored.len(), N, "every row of the batch round-trips");
    for (i, row) in stored.iter().enumerate() {
        assert_eq!(row.message_key.as_deref(), Some(keys[i].as_str()));
        assert_eq!(row.payload_json, payloads[i], "row {i} round-trips");
    }
}

/// (#155, the batch path) The batch is ONE transaction in the atomicity sense
/// too: a row that fails partway through rolls the WHOLE batch back, so a flush
/// is all-or-nothing and never leaves half a transcript stored.
///
/// This is the direct proof of "one transaction" — the frame count above shows
/// commits happened together, this shows they cannot happen PARTLY. The failing
/// row is an FK violation (a `messages` row for a session that does not exist,
/// and `foreign_keys` is ON in every `Db::open`), which is a real constraint
/// rather than a contrived one, and it fails on the SECOND of three rows so the
/// first is genuinely written-then-unwritten.
///
/// The mutation this pins: dropping the `transaction()` and executing per row
/// leaves row 1 committed behind the failure.
#[test]
fn record_messages_batch_rolls_back_the_whole_batch_when_one_row_fails() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-batch-rb-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.record_session(&title_session("s_ok"))
        .expect("record_session");

    let batch = [
        ("s_ok", "agent-text", Some("first"), "{\"text\":\"kept\"}"),
        (
            "s_no_such_session",
            "agent-text",
            Some("bad"),
            "{\"text\":\"fk violation\"}",
        ),
        ("s_ok", "agent-text", Some("last"), "{\"text\":\"kept\"}"),
    ];
    db.record_messages_batch(&batch)
        .expect_err("an FK-violating row must fail the batch");

    let stored = db.messages_for("s_ok").expect("messages_for");
    assert!(
        stored.is_empty(),
        "the whole batch rolled back — a transaction that committed rows 1 and          3 before failing on row 2 would leave them here: got {stored:?}"
    );
}

/// (#155, the batch path) A key that appears TWICE inside one batch is an
/// UPSERT, not an error — the same `ON CONFLICT … DO UPDATE` `record_message`
/// uses, so a stream that re-sends a `messageId` (the accumulated-text case the
/// module docs describe) collapses to one row holding the LAST payload.
///
/// Without the conflict clause this is a `UNIQUE constraint failed` and the
/// whole batch rolls back — losing the frames that were fine.
#[test]
fn record_messages_batch_upserts_a_key_that_appears_twice_in_one_batch() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-batch-dup-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.record_session(&title_session("s_dup"))
        .expect("record_session");

    let batch = [
        (
            "s_dup",
            "agent-text",
            Some("same-key"),
            "{\"text\":\"first\"}",
        ),
        ("s_dup", "user", None, "{\"text\":\"a user row\"}"),
        (
            "s_dup",
            "agent-text",
            Some("same-key"),
            "{\"text\":\"last wins\"}",
        ),
    ];
    db.record_messages_batch(&batch)
        .expect("a repeated key inside one batch is an upsert, not an error");

    let stored = db.messages_for("s_dup").expect("messages_for");
    assert_eq!(
        stored.len(),
        2,
        "the duplicate collapsed to one row: got {stored:?}"
    );
    let dup = stored
        .iter()
        .find(|r| r.message_key.as_deref() == Some("same-key"))
        .expect("the upserted row is there");
    assert_eq!(
        dup.payload_json, "{\"text\":\"last wins\"}",
        "the LAST write in the batch is what stands (the same excluded.* \
         semantics as record_message)"
    );
}
