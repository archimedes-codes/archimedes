//! Tests for `db/parent_link.rs`: the ONE verb that writes
//! `sessions.parent_session_id`.
//!
//! The verb's whole contract is WRITE-ONCE, so the tests are the two halves of
//! that sentence: the first write lands, and nothing can change it afterwards.
//! They run over a real file (never `:memory:`) because the column's NULL-ness
//! is a property of the stored row, not of a connection.

use crate::storage::db::*;

use super::support::*;

/// The first parent write lands and reports `true`.
///
/// `true` is `Ok(n > 0)` — the verb reports whether a row changed rather than
/// whether the ids were plausible, which is the `set_session_archived` dialect.
#[test]
fn the_first_parent_write_lands_and_reports_true() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-parent-link-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("c1"))
        .expect("record the child row");
    assert!(
        db.set_session_parent_if_unset("c1", "p1")
            .expect("first write"),
        "the first write on a NULL-parent row changes it"
    );
    assert_eq!(
        raw_column(
            &db,
            "SELECT parent_session_id FROM sessions WHERE id = 'c1'"
        ),
        vec!["p1".to_string()],
        "the value that landed is the one the caller passed"
    );
}

/// A second parent write is refused and the first value survives.
///
/// The second call names a DIFFERENT parent on purpose: the contract is not "a
/// repeated write is idempotent", it is "the first value is immortal". The
/// mechanism is the `IS NULL` clause in the `UPDATE`'s WHERE — once the column
/// is non-NULL that predicate matches nothing forever, so the statement cannot
/// reach the row again whether the new parent agrees with the old one or not.
#[test]
fn a_second_parent_write_is_refused_and_the_first_value_survives() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-parent-link-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("c1"))
        .expect("record the child row");
    assert!(
        db.set_session_parent_if_unset("c1", "p1")
            .expect("first write"),
        "the first write lands"
    );
    assert!(
        !db.set_session_parent_if_unset("c1", "p2")
            .expect("second write"),
        "a write that would REPLACE a known parent reports false and changes nothing"
    );
    assert_eq!(
        raw_column(
            &db,
            "SELECT parent_session_id FROM sessions WHERE id = 'c1'"
        ),
        vec!["p1".to_string()],
        "the first parent is immortal — a re-link is not this verb's to grant"
    );
}

/// A row whose `parent_session_id` is NULL accepts its first write.
///
/// This is the arm that fails if anyone ever gives the column a `DEFAULT ''`:
/// the `IS NULL` predicate would then match NOTHING on any row `record_session`
/// creates, and the write-once verb would quietly become a never-verb — the
/// caller would keep getting `false` and the column would stay empty forever
/// with no error anywhere.
#[test]
fn a_null_parent_row_is_settable() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-parent-link-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    // Every row `record_session` creates starts with no known parent.
    db.record_session(&title_session("c1"))
        .expect("record the child row");
    assert_eq!(
        raw_scalar(
            &db,
            "SELECT COUNT(*) FROM sessions WHERE parent_session_id IS NULL"
        ),
        1,
        "a freshly recorded row has NO parent — the state this verb exists to leave"
    );
    assert!(
        db.set_session_parent_if_unset("c1", "p1")
            .expect("write on a NULL row"),
        "the NULL row accepts its one write"
    );
}

/// Linking an unknown id is a no-op and reports `false`.
///
/// A miss is the STEADY STATE, not a failure: the child's row is created by the
/// pinned crate's `ensure_session_row` when its first frame persists, so a
/// caller that links before the row exists is normal, and it must learn "nothing
/// changed" rather than an error. `set_session_archived` is the precedent for a
/// `Db` verb that answers `false` for an id that matches no row.
#[test]
fn linking_an_unknown_id_is_a_no_op_and_reports_false() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-parent-link-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("c1"))
        .expect("record one row so the count below is not vacuously zero");
    assert!(
        !db.set_session_parent_if_unset("nope", "p1")
            .expect("unknown id"),
        "an id that matches no row reports false"
    );
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM sessions"),
        1,
        "and it creates no row — this verb links, it never invents"
    );
}
