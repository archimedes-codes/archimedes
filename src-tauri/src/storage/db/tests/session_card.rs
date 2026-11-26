//! Tests for `db/session_card.rs`: the session→card read the advance advice opens
//! with (D16 — `mark_done` holds a Session id and nothing else, so the card, the
//! Space and the frozen launching column have to be resolved from that one value).
//!
//! This child is the mirror of `db/session_card.rs` under ADR 0113's rule, and it
//! owns ONE question: which card does a Session own, and what does that card sit on.
//! The dedupe that reads `task_sessions` for a DIFFERENT reason (has this link
//! already launched?) is pinned beside its own subject in [`super::advise`].
//!
//! # The property this file exists to hold
//!
//! **The newest link wins, and `Db::task_numbers()` says so too.** Both reads answer
//! "which card does this Session wear" and they must never disagree — a badge on one
//! card and an advance computed against another is the same card in two places. So
//! the rule is not restated here as prose a second implementation can ignore: the
//! last test asserts the two reads land on the same card, on the same fixture, with
//! a hand-off in the middle. A `MAX(rowid)` that drifted to `MIN(rowid)` in one of
//! the two would redden there and not in a review.
//!
//! # Why the tests reach through `Db::card_of_session` and not the `_on` form
//!
//! `card_of_session_on` takes a `&Connection` the caller already holds, and a test
//! cannot hold `Db`'s private guard. The wrapper is one line and takes the lock, so
//! what these assertions grade is the SQL — the join, the winner rule, the projection
//! — which is the part with the failure modes. The `_on` shape is exercised by
//! [`super::advise`] (the only production caller), where the advice holds the guard.

use crate::storage::Db;

use super::support::*;

/// A recorded Session — the FK target every `task_sessions` link needs.
///
/// `link_session` does not check the Session exists (the `ON DELETE CASCADE` FK
/// rejects a dangling link at the statement instead), so a test that skipped this
/// would get a foreign-key error rather than the row it meant to write.
fn record(db: &Db, id: &str) {
    db.record_session(&title_session(id))
        .expect("record_session");
}

/// (the ordinary case) one link, and the read names that card, its Space, and the
/// column the link froze.
///
/// `launched_slug` is the FROZEN lane — `task_sessions.stage_slug`, where the card
/// was when the Session was linked, not where it sits now. The advice needs it
/// because "which edge fires" is a question about the column the work STARTED in.
#[test]
fn one_link_resolves_the_card_its_space_and_the_column_the_link_froze() {
    let (_dir, db, space) = seeded("card-one-link");
    let card = db
        .create_task(&space, "one link", None, None)
        .expect("create_task");
    record(&db, "s-one");
    db.link_session(&card.id, "s-one", Some("backlog"))
        .expect("link_session");

    let card_of = db
        .card_of_session("s-one")
        .expect("the read never fails on a linked Session")
        .expect("the Session has a card");

    assert_eq!(card_of.task_id, card.id, "the card the link names");
    assert_eq!(
        card_of.space_path, space,
        "and the Space that card lives in"
    );
    assert_eq!(
        card_of.launched_slug.as_deref(),
        Some("backlog"),
        "the frozen launching column, read off the link and not off the card"
    );
    assert!(
        card_of.own_link_rowid > 0,
        "`own_link_rowid` is the link row's own `rowid` — the D17 dedupe compares \
         against it, so a zero here would make every search match; got {}",
        card_of.own_link_rowid
    );
    assert_eq!(
        card_of.own_link_rowid,
        raw_i64s(
            &db,
            "SELECT rowid FROM task_sessions WHERE session_id = 's-one'"
        )
        .into_iter()
        .next()
        .expect("the link row exists"),
        "and it is the REAL rowid the database gave that row, not a re-derived one"
    );
}

/// (D16's ambiguity, resolved) a Session handed between cards answers with the
/// NEWEST link, and the newest link's `stage_slug` is the one that comes back.
///
/// 31 of 104 live cards hold more than one linked Session and a Session travels, so
/// this is not a corner. The older link stays in the table — the read picks a winner,
/// it does not clean up.
#[test]
fn the_newest_link_wins_when_a_session_has_been_handed_between_cards() {
    let (_dir, db, space) = seeded("card-two-links");
    let first = db
        .create_task(&space, "the first card", None, None)
        .expect("create_task");
    let second = db
        .create_task(&space, "the second card", None, None)
        .expect("create_task");
    record(&db, "s-handed");
    db.link_session(&first.id, "s-handed", Some("backlog"))
        .expect("link the first card");
    db.link_session(&second.id, "s-handed", Some("doing"))
        .expect("link the second card");

    let card_of = db
        .card_of_session("s-handed")
        .expect("read")
        .expect("the Session has a card");

    assert_eq!(
        card_of.task_id, second.id,
        "the LAST link wins — `rowid` is SQLite's insert-order counter and \
         `task_numbers` follows the same one"
    );
    assert_eq!(
        card_of.launched_slug.as_deref(),
        Some("doing"),
        "and the frozen column rides the WINNING row, not the first link's"
    );
    assert!(
        card_of.own_link_rowid
            > raw_i64s(
                &db,
                &format!(
                    "SELECT rowid FROM task_sessions WHERE task_id = '{}' \
                     AND session_id = 's-handed'",
                    first.id
                )
            )
            .into_iter()
            .next()
            .expect("the first link row exists"),
        "the returned rowid is the newer row's"
    );
}

/// (D16's stated consequence) the newest link's Space IS the Space the read answers
/// with, even when an older link sits in a different Space.
///
/// This is the case that makes the Space a resolved value rather than a parameter:
/// a Session cannot say which Space it "belongs" to, and the only question it CAN
/// answer is which card it was launched against most recently. The Space comes from
/// that card's row, so a hand-off across Spaces moves the Space with it.
#[test]
fn the_newest_links_space_is_the_space_the_read_answers_with() {
    let (_dir, db, first_space) = seeded("card-two-spaces");
    let second_space = board_space("card-two-spaces-b");
    let in_first = db
        .create_task(&first_space, "card in the first space", None, None)
        .expect("create_task");
    let in_second = db
        .create_task(&second_space, "card in the second space", None, None)
        .expect("create_task");
    record(&db, "s-travels");
    db.link_session(&in_first.id, "s-travels", Some("backlog"))
        .expect("link in the first space");
    db.link_session(&in_second.id, "s-travels", Some("research"))
        .expect("link in the second space");

    let card_of = db
        .card_of_session("s-travels")
        .expect("read")
        .expect("the Session has a card");

    assert_eq!(
        (card_of.task_id.as_str(), card_of.space_path.as_str()),
        (in_second.id.as_str(), second_space.as_str()),
        "the newest link's card AND that card's Space — an answer built from the \
         older link's Space would bound the chain against the wrong Space's budget"
    );
}

/// (no link, and a link to a card that is gone) both answer `Ok(None)`.
///
/// Two shapes, one answer, and both are ordinary: a Session started outside a card
/// has never been linked, and a link whose `task_id` no longer resolves is possible
/// because `task_sessions` carries NO foreign key on `task_id` (ADR 0090). The read
/// INNER-joins `tasks` for the same reason `task_numbers` does — a link it cannot
/// resolve produces absence, not a row built on a card that is not there.
#[test]
fn no_link_and_a_gone_card_both_answer_no_card() {
    let (_dir, db, space) = seeded("card-absent");
    record(&db, "s-never-linked");
    record(&db, "s-dangling");
    // A link written straight to the table, naming a card that does not exist. The
    // table has no FK on `task_id`, so this is the state a `delete_space` can leave.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO task_sessions (task_id, session_id, stage_slug) \
             VALUES ('tsk_gone', 's-dangling', 'backlog')",
            [],
        )
        .expect("the dangling link writes (there is no FK on task_id)");

    assert!(
        db.card_of_session("s-never_linked")
            .expect("read")
            .is_none(),
        "a Session with no link has no card"
    );
    assert!(
        db.card_of_session("s-dangling").expect("read").is_none(),
        "and a Session whose newest link names a gone card has none either — the \
         join drops it rather than inventing a Space for it"
    );
    // The other Session on the same card is unaffected: the absence is per-Session.
    let card = db
        .create_task(&space, "a real card", None, None)
        .expect("create_task");
    record(&db, "s-fine");
    db.link_session(&card.id, "s-fine", None)
        .expect("link_session");
    assert!(db.card_of_session("s-fine").expect("read").is_some());
}

/// **THE AGREEMENT PIN.** The two session→card reads land on the SAME card on the
/// SAME fixture, including across a hand-off.
///
/// This is the test the module header is about. `Db::task_numbers()` is the shipped
/// badge read and it has owned the `MAX(rowid)` newest-link-wins rule since ADR 0100;
/// this read copies that rule rather than reinventing it, and the copy is what this
/// asserts. A badge on card A and an advance computed against card B is the same
/// Session wearing two cards, and no other test in either file can see it — each one
/// alone would still be internally consistent.
///
/// The fixture is built for the disagreement: TWO links on ONE Session, so a `MIN`
/// in either read picks the other card and the two rows stop matching.
#[test]
fn card_of_session_and_task_numbers_agree_on_which_card_a_session_wears() {
    let (_dir, db, space) = seeded("card-agrees");
    let older = db
        .create_task(&space, "the older card", None, None)
        .expect("create_task");
    let newer = db
        .create_task(&space, "the newer card", None, None)
        .expect("create_task");
    record(&db, "s-agree");
    db.link_session(&older.id, "s-agree", Some("backlog"))
        .expect("link the older card");
    db.link_session(&newer.id, "s-agree", Some("approved"))
        .expect("link the newer card");

    let numbers = db.task_numbers().expect("task_numbers");
    let badge = numbers
        .iter()
        .find(|row| row.session_id == "s-agree")
        .expect("the badge read reports this Session");
    let card_of = db
        .card_of_session("s-agree")
        .expect("read")
        .expect("the Session has a card");

    assert_eq!(
        card_of.task_id, newer.id,
        "this read follows the newest link"
    );
    assert_eq!(
        badge.task_number, newer.number,
        "and so does the shipped badge read — the numbers are the newer card's"
    );
    // The strongest form: the SAME card identity, not two independently-derived
    // claims about it. `task_numbers` has no `task_id` on its row (deliberately —
    // rows.rs gives the reason), so the join-back is through `number`, which is
    // unique per Space and both rows carry it.
    assert_eq!(
        badge.stage_slug, card_of.launched_slug,
        "both reads report the SAME frozen lane for the same link row"
    );
    assert_eq!(
        card_of.launched_slug.as_deref(),
        Some("approved"),
        "and that lane is the NEWER link's — a `MIN(rowid)` anywhere in either read \
         would answer `backlog` here"
    );
}
