//! The archive / delete retention TRIGGER tests — the two cores in
//! [`crate::commands::history`] that prune a Session's closed Subagent children.
//!
//! These eight tests moved out of `history.rs`'s inline `mod tests` the moment the
//! file measured over the 700-line production SEED (the guard is the seed, not the
//! 800 hard gate, because an un-ledgered file above the seed enters the ledger on
//! someone else's `--update`). The split is by subject — the command file against
//! its test tree — which is the shape `commands/tasks.rs` + `commands/tasks/tests/`
//! and `commands/files/` already ship, and ADR 0113's rule that where production is
//! ONE file its test children are named by subject.
//!
//! `#[tokio::test]` is load-bearing on every test that buffers rather than
//! stylistic: `buffer_or_write` probes for a runtime FIRST and WRITE-THROUGHS on a
//! thread without one, so a plain `#[test]` would land the rows on disk and make
//! the "still buffered" premise fail for a reason that looks exactly like a broken
//! prune.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fulcrum_harness::clock::now_ms;
use fulcrum_harness::seams::FulcrumPersistence;

use crate::commands::history::{delete_session_core, set_session_archived_core};
use crate::storage::{BatchingPersistence, Db};
use crate::types::SessionInfo;

/// A Subagent session shape (the prune targets `is_subagent = 1`).
fn subagent(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        cost_usd: None,
        context_usage: None,
        is_subagent: true,
    }
}

/// A main session shape.
fn main_session(id: &str) -> SessionInfo {
    SessionInfo {
        is_subagent: false,
        ..subagent(id)
    }
}

/// Point a child's `parent_session_id` at a parent through a SECOND raw
/// connection on the same file — deliberately NOT through the write-once link
/// verb in `storage/db/parent_link.rs`, whose call sites are pinned to exactly
/// two files (that sibling and its own mirror test) because this task ships that
/// verb WITHOUT a caller. A call from here would make it three and break that
/// pin; it would also couple the trigger tests to the link verb, so a bug there
/// could make a trigger test pass or fail.
fn link(path: &Path, child_id: &str, parent_id: &str) {
    {
        let conn = rusqlite::Connection::open(path).expect("raw open of the fixture db");
        conn.execute(
            "UPDATE sessions SET parent_session_id = ?1 WHERE id = ?2",
            rusqlite::params![parent_id, child_id],
        )
        .expect("link the fixture child");
    }
}

/// Backdate a session so the age-bound sweep would see it (unused by the
/// per-parent scope, which has no age bound, but it keeps the fixtures honest
/// about what a real closed child looks like).
fn age(path: &Path, id: &str, created_at: i64) {
    {
        let conn = rusqlite::Connection::open(path).expect("raw open of the fixture db");
        conn.execute(
            "UPDATE sessions SET created_at = ?1 WHERE id = ?2",
            rusqlite::params![created_at, id],
        )
        .expect("backdate the fixture session");
    }
}

/// A parent with rows and one aged child with 3 display rows + 2 native rows.
fn seed_parent_with_child(dir: &Path) -> (std::path::PathBuf, Arc<Db>) {
    let path = dir.join("t.db");
    let db = Arc::new(Db::open(&path).expect("db should open"));
    db.record_session(&main_session("p1")).expect("record p1");
    db.record_session(&subagent("child")).expect("record child");
    db.record_messages_batch(&[
        ("p1", "agent-text", Some("p0"), "{}"),
        ("p1", "agent-text", Some("p1"), "{}"),
        ("child", "agent-text", Some("c0"), "{}"),
        ("child", "agent-text", Some("c1"), "{}"),
        ("child", "tool-call", Some("c2"), "{}"),
    ])
    .expect("five display rows");
    db.replace_native_messages(
        "child",
        &[
            (1, "user".to_string(), "{}".to_string()),
            (2, "assistant".to_string(), "{}".to_string()),
        ],
    )
    .expect("two native rows");
    link(&path, "child", "p1");
    age(&path, "child", now_ms() - 48 * 3600 * 1000);
    (path, db)
}

/// A parent with rows and one aged child that holds NO display rows on disk
/// (plus two native rows), for the two tests that buffer through the decorator.
///
/// The child starts with an EMPTY display transcript on purpose: both tests
/// assert `messages_for(child)` is empty as their premise — "the rows are in
/// memory, not in the database" — and a child seeded with rows on disk would
/// answer non-empty before the core was even called, failing the premise for a
/// reason that has nothing to do with the prune.
fn seed_parent_with_buffered_child(dir: &Path) -> (std::path::PathBuf, Arc<Db>) {
    let path = dir.join("t.db");
    let db = Arc::new(Db::open(&path).expect("db should open"));
    db.record_session(&main_session("p1")).expect("record p1");
    db.record_session(&subagent("child")).expect("record child");
    db.record_messages_batch(&[
        ("p1", "agent-text", Some("p0"), "{}"),
        ("p1", "agent-text", Some("p1"), "{}"),
    ])
    .expect("the parent's own two rows");
    db.replace_native_messages(
        "child",
        &[
            (1, "user".to_string(), "{}".to_string()),
            (2, "assistant".to_string(), "{}".to_string()),
        ],
    )
    .expect("two native rows");
    link(&path, "child", "p1");
    age(&path, "child", now_ms() - 48 * 3600 * 1000);
    (path, db)
}

/// Archiving a CLOSED parent prunes its children and still answers the flag.
#[test]
fn archiving_a_parent_prunes_its_children_and_keeps_the_flag_answer() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-archive-test-", "db");
    let (_path, db) = seed_parent_with_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));

    let got = set_session_archived_core(&db, &batched, "p1", true, /* is_live */ false)
        .expect("the archive core");
    assert!(got, "the flag landed — that is the wire's promise");
    assert_eq!(
        db.messages_for("child").expect("messages_for").len(),
        1,
        "the child keeps exactly its newest row"
    );
    assert!(
        db.load_native_messages("child").expect("native").is_empty(),
        "and loses its whole native transcript"
    );
    assert!(
        db.session("child").expect("session").is_some(),
        "the child's `sessions` row survives"
    );
    assert_eq!(
        db.messages_for("p1").expect("messages_for").len(),
        2,
        "the parent's OWN transcript is untouched — the prune scopes on children"
    );
}

/// THE LIVE-PARENT PIN: archiving a LIVE Session prunes NOTHING and flushes
/// NOTHING.
///
/// Archive is reachable for a live Session — the sidebar offers Archive on a
/// live row and the frontend commits the flag BEFORE it closes (ADR 0016's
/// 2026-10-20 amendment: "a live row offers Stop then Archive"), and
/// `Db::set_session_archived` is an id-only `UPDATE` with no liveness
/// condition. Without the `is_live` term the core would flush the child's
/// in-flight rows, delete all but the newest, and then the still-emitting
/// child would re-INSERT the rest at LARGER rowids at the end of a transcript
/// read `ORDER BY id` — the mis-ordering that is a correctness defect.
///
/// Non-vacuity: pass `false` for `is_live` and this goes red exactly the way
/// `archiving_drains_the_child_buffer_before_it_prunes` expects (one row left,
/// the newest key); dropping the `!is_live` term from the core reddens it with
/// no other change.
#[tokio::test]
async fn archiving_a_live_parent_does_not_prune_a_running_child() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-live-test-", "db");
    let (path, db) = seed_parent_with_buffered_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));
    // The child's rows are BUFFERED, not on disk — the state a mid-turn child
    // is actually in. `#[tokio::test]` is load-bearing here: `buffer_or_write`
    // probes for a runtime first and WRITE-THROUGHS without one, so a plain
    // `#[test]` would land these rows immediately and the premise below would
    // fail for a reason that looks like a broken prune.
    for i in 0..5 {
        batched
            .record_message("child", "agent-text", Some(&format!("k{i}")), "{}")
            .expect("buffered");
    }
    assert!(
        db.messages_for("child").expect("messages_for").is_empty(),
        "the premise: the rows are in memory, not in the database"
    );

    let got = set_session_archived_core(&db, &batched, "p1", true, /* is_live */ true)
        .expect("the archive core");
    assert!(
        got,
        "the flag still lands — a live archive succeeds, it just tidies nothing"
    );
    assert!(
        db.messages_for("child").expect("messages_for").is_empty(),
        "a live-parent archive neither flushes nor prunes, so nothing is on disk"
    );
    // And the buffer is still INTACT in its original order — the half that
    // proves no flush happened.
    batched.flush().expect("the later flush");
    let keys: Vec<Option<String>> = db
        .messages_for("child")
        .expect("messages_for")
        .iter()
        .map(|r| r.message_key.clone())
        .collect();
    assert_eq!(
        keys,
        vec!["k0", "k1", "k2", "k3", "k4"]
            .into_iter()
            .map(|k| Some(k.to_string()))
            .collect::<Vec<_>>(),
        "all five slots survive in order — the transcript was never trimmed and \
         never re-appended at larger rowids"
    );
    let _ = path;
}

/// Unarchiving prunes nothing: the prune is a way IN to Archived, not a
/// property of being archived.
#[test]
fn unarchiving_prunes_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-unarchive-test-", "db");
    let (_path, db) = seed_parent_with_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));

    let got = set_session_archived_core(&db, &batched, "p1", false, /* is_live */ false)
        .expect("the archive core");
    assert!(got, "the flag cleared");
    assert_eq!(
        db.messages_for("child").expect("messages_for").len(),
        3,
        "the child keeps all three rows"
    );
}

/// An id that matches no row answers `false` and deletes nothing — the
/// "matched a row" term of the guard.
#[test]
fn archiving_a_session_with_no_row_reports_false_and_prunes_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-norow-test-", "db");
    let (_path, db) = seed_parent_with_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));

    let got = set_session_archived_core(&db, &batched, "ghost", true, /* is_live */ false)
        .expect("the archive core");
    assert!(!got, "no row matched, so the answer is false");
    assert_eq!(
        db.messages_for("child").expect("messages_for").len(),
        3,
        "and an unrelated child's transcript is untouched"
    );
}

/// Deleting a parent prunes its children FIRST, while the parent row still
/// exists — then the parent's own row goes and the children survive.
#[test]
fn deleting_a_parent_prunes_its_children_before_the_cascade() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-delete-test-", "db");
    let (_path, db) = seed_parent_with_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));

    delete_session_core(&db, &batched, "p1").expect("the delete core");
    assert!(
        db.session("p1").expect("session").is_none(),
        "the parent's row is gone — that is what the wire asked for"
    );
    assert!(
        db.session("child").expect("session").is_some(),
        "the child's row SURVIVES its parent (no FK, by decision)"
    );
    assert_eq!(
        db.messages_for("child").expect("messages_for").len(),
        1,
        "and its transcript was trimmed before the parent went"
    );
    assert!(
        db.load_native_messages("child").expect("native").is_empty(),
        "native rows gone too"
    );
}

/// THE RESURRECTION PIN: the flush happens BEFORE the prune.
///
/// Non-vacuity, both directions. Swap the two statements in the core and this
/// goes red — the prune would delete nothing (nothing is on disk yet), the
/// later flush would re-INSERT all five slots with NEW, LARGER rowids, and
/// because the `sessions` row was deliberately KEPT the FK cannot refuse them,
/// so `messages_for` (which orders by `id`) answers five rows with the old ones
/// appended at the END. Substitute `flush_session(parent_id)` for `flush()` and
/// it goes red too, because the buffer is keyed by the CHILD's own id and
/// draining the parent's drains nothing.
#[tokio::test]
async fn archiving_drains_the_child_buffer_before_it_prunes() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-resurrect-test-", "db");
    let (_path, db) = seed_parent_with_buffered_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));
    for i in 0..5 {
        batched
            .record_message("child", "agent-text", Some(&format!("k{i}")), "{}")
            .expect("buffered");
    }
    assert!(
        db.messages_for("child").expect("messages_for").is_empty(),
        "the premise: the rows are in memory"
    );

    let got = set_session_archived_core(&db, &batched, "p1", true, /* is_live */ false)
        .expect("the archive core");
    assert!(got, "the flag landed");
    let kept = db.messages_for("child").expect("messages_for");
    assert_eq!(
        kept.len(),
        1,
        "the child is left with ONE row, not five resurrected ones"
    );
    assert_eq!(
        kept[0].message_key.as_deref(),
        Some("k4"),
        "and it is the NEWEST — the drained rows were pruned, not re-appended"
    );
}

/// A prune that REFUSES does not make the archive fail: the flag is the wire's
/// promise, the prune is housekeeping behind it.
#[test]
fn archiving_reports_success_even_when_the_prune_refuses() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-prune-fail-test-", "db");
    let (path, db) = seed_parent_with_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));
    // Drop the table the prune deletes from, so its statement genuinely
    // refuses (the `history_page`-join test's trick, and a real `Sqlite`
    // error rather than a hand-built one).
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open of the fixture db");
        conn.execute("DROP TABLE messages", [])
            .expect("drop the table the prune deletes from");
    }

    let got = set_session_archived_core(&db, &batched, "p1", true, /* is_live */ false)
        .expect("the archive core");
    assert!(
        got,
        "the flag landed, so the archive succeeded — a failed tidy is logged, \
         not reported to the user as a failed archive"
    );
    assert!(
        db.session("p1")
            .expect("session")
            .expect("the row is there")
            .archived,
        "and the flag is really set"
    );
}

/// The flush twin: a failed flush does not make the archive fail either.
///
/// This is the test that makes the `?`-less flush load-bearing rather than
/// incidental — with `batched.flush()?` in the core it goes red with
/// `Err(DbError::Sqlite(_))`, which is the exact wrong answer, because the
/// flag landed. `lib.rs`'s own `flush_batched` and the session layer's
/// per-session flush both treat a failed flush as "loud in the debug log,
/// swallowed", and so does this.
#[tokio::test]
async fn archiving_reports_success_even_when_the_flush_refuses() {
    let dir = crate::test_support::ScratchDir::in_env_temp("history-flush-fail-test-", "db");
    let (path, db) = seed_parent_with_child(&dir);
    let batched = BatchingPersistence::with_interval(db.clone(), Duration::from_secs(600));
    for i in 0..5 {
        batched
            .record_message("child", "agent-text", Some(&format!("k{i}")), "{}")
            .expect("buffered");
    }
    // The table the batch writes to goes BETWEEN the buffering and the
    // archive, so the flush is what refuses.
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open of the fixture db");
        conn.execute("DROP TABLE messages", [])
            .expect("drop the table the flush writes to");
    }

    let got = set_session_archived_core(&db, &batched, "p1", true, /* is_live */ false)
        .expect("the archive core");
    assert!(
        got,
        "a failed flush is swallowed — telling the user their archive failed \
         when it landed is the asymmetry ADR 0016's amendment argues about"
    );
}
