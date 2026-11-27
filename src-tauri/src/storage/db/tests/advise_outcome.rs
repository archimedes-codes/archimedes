//! Tests for **the edge the model chose, carried to the settle door** — the half of
//! `advise.rs` that reads `sessions.advance_outcome`, the name a `mark_done` claim
//! persisted beside its `ready` flag.
//!
//! WHY THIS CHILD EXISTS, and why the boundary sits here. ADR 0112's 1,000-code-line
//! test gate reddened `db/tests/advise.rs` at 1,042, and the sanctioned answer is a
//! subject split and never a threshold edit — the `stages` → `stage_lifecycle` +
//! `stage_setters` pair is the in-repo precedent for splitting ONE production file's
//! tests by subject. What this child owns is OUTCOME SELECTION ACROSS THE TWO DOORS
//! (which edge fires, at the claim and at the settle, and why they must agree);
//! [`super::advise`] owns the ARM ORDER and the arms themselves, and [`super::advise_cost`]
//! owns the settled-cost bank. The three fail differently, which is what makes the
//! boundary a subject boundary and not a line count. The shared fixtures live in
//! [`super::support`].
//!
//! THE DEFECT THIS CHILD EXISTS FOR. `next_outcomes` (this branch's own `f5de1834`) is
//! the feature that lets a model NAME the edge it wants; the claim door passed that name
//! and the settle door passed a literal `None`. The dedupe is DESTINATION-scoped, so a
//! `mark_done` naming `fail` launched `approved`, the settle resolved `research`, found
//! no newer link *at `research`*, fell through arm 3, spent a second step and launched
//! `research` TOO — two Sessions for one claim, on two columns, and the card ending
//! wherever the settle put it. The double-launch is the louder half; the quiet half is
//! that even with no second launch, a settle advancing down the first edge when the
//! model named the second sends the chain down the wrong edge and every edge label on
//! the board does nothing.
//!
//! The fix is one stored fact both doors read, so what these tests pin is AGREEMENT:
//! the same claim, resolved by each door as it really calls, must land on one edge. The
//! last test is the measurement behind REJECTING the card-scoped dedupe a reviewer
//! offered as a backstop, and it is a measurement rather than an opinion — see its
//! header for what a person's second launch actually writes.

use crate::storage::db::Db;

use super::support::*;

/// …and then it claims, NAMING an edge. The shape one turn in when the model used the
/// `outcome` parameter — the claim door writes the flag and the name in one statement,
/// and this helper is that statement and nothing more.
fn claim_named(db: &Db, session_id: &str, task_id: &str, launched_slug: &str, outcome: &str) {
    linked(db, session_id, task_id, launched_slug);
    db.set_session_ready(session_id, Some(true), Some(outcome))
        .expect("set_session_ready (named)");
}

// ── the outcome the model chose, carried to the settle door ──────────────────
//
// `next_outcomes` exists so a model can name which edge fires. The claim door passes
// that name; the settle door passed a literal `None`. The dedupe is DESTINATION-scoped,
// so a `mark_done` naming the second edge launched the second column, the settle then
// resolved the FIRST, found no newer link at the first, fell through arm 3, spent a
// second step and launched the first column TOO. Two Sessions started for one claim, on
// two columns, and the card ended wherever the settle put it — the model's answer was
// discarded at the second door.
//
// Even with no second launch the defect is real: a settle advancing down the first edge
// when the model named the second sends the chain down the wrong edge, which contradicts
// the whole thesis of the feature. These tests pin the ONE fact both doors now read.

/// A fan-out the model can route: `backlog` leads to `research` on `ok` and to
/// `approved` on `fail`, with BOTH columns auto so neither arm 4 refusal hides the
/// edge choice.
fn fan_out(db: &Db, space: &str) {
    set_auto(db, space, "backlog", true);
    set_auto(db, space, "approved", true);
    set_edges(
        db,
        space,
        "backlog",
        &["research", "approved"],
        &[Some("ok"), Some("fail")],
    );
}

/// **THE DOUBLE-LAUNCH PIN.** A `mark_done` naming `fail` launches `approved`; the
/// settle must NOT then launch `research`.
///
/// The two doors are the two real callers, spelled as they really call: the claim names
/// the outcome, the settle names nothing because it has no such thing to report. Under
/// the defect the settle resolved `research`, found no newer link *at `research`* (the
/// launch linked `approved`), fell through arm 3, spent a second step and answered
/// `advance: true` at `research` — so the frontend started a second Session and the card
/// moved to a column the model did not choose.
#[test]
fn a_named_outcome_that_already_launched_does_not_launch_the_head_edge_too() {
    let (_dir, db, space, task_id) = fixture("adv-outcome-double");
    fan_out(&db, &space);
    claim_named(&db, "s-fail", &task_id, "backlog", "fail");

    // Door one — the claim. It names `fail` and must resolve `approved`.
    let claim = advice(&db, "s-fail", Some("fail"), None);
    assert!(claim.advance, "the claim is answered");
    assert_eq!(
        dest_slug(&claim),
        Some("approved".to_string()),
        "the edge the model named fired, not the head"
    );

    // The launch succeeds: the NEW Session is linked at `approved`.
    linked(&db, "s-approved-run", &task_id, "approved");

    // Door two — the settle. It carries no outcome, because a settle has none.
    let settle = advice(&db, "s-fail", None, Some(0.4));
    assert_eq!(
        settle.reason, "already_advanced",
        "the link the model chose HAS launched — the settle must get out of the way. \
         `advanced` here means the settle resolved a different destination than the \
         claim did, found no newer link at the destination it invented, and launched \
         a second column"
    );
    assert!(
        !settle.advance,
        "and it issues no instruction: a second launch is the double-launch this pins"
    );
    assert!(settle.already_launched);
    assert_eq!(
        dest_slug(&settle),
        None,
        "no destination rides a refusal — otherwise the frontend has a row to launch \
         from on a payload that just said not to"
    );
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, Some(0.4))),
        "exactly ONE step was bought for this link, and the settle's cost is banked \
         against it. A SECOND step here is the same link charged twice"
    );
}

/// **THE WRONG-EDGE PIN.** With no launch yet on the card, the settle resolves the
/// SECOND edge — the one the model named — and not the head.
///
/// This is the half of the defect that has nothing to do with launching twice: a chain
/// that silently takes the head edge after a model named a different one is a workflow
/// whose labels do nothing, and it is invisible because everything still moves.
#[test]
fn the_settle_door_resolves_the_edge_the_model_named_and_not_the_head() {
    let (_dir, db, space, task_id) = fixture("adv-outcome-wrong-edge");
    fan_out(&db, &space);
    claim_named(&db, "s-fail2", &task_id, "backlog", "fail");

    assert_eq!(
        dest_slug(&advice(&db, "s-fail2", Some("fail"), None)),
        Some("approved".to_string()),
        "the door that has the name resolves the named edge"
    );

    // No launch row at all, so the dedupe cannot fire and arm 5/6/7 are reached.
    let settle = advice(&db, "s-fail2", None, None);
    assert!(settle.advance);
    assert_eq!(
        dest_slug(&settle),
        Some("approved".to_string()),
        "`research` here is the head edge standing in for a choice the model already \
         made and the settle threw away"
    );
    assert_eq!(
        settle.reason, "advanced",
        "not `advanced_unnamed_edge` — the edge the model named IS the edge that fired, \
         so the hedge would be a lie about a fallback"
    );
}

/// The claim's name is a fact about the CLAIM, so a claim that names nothing must not
/// inherit a previous turn's name — a Session that runs a second turn and marks done
/// with no outcome takes the head edge, exactly as it did before the first turn named one.
#[test]
fn a_claim_that_names_nothing_clears_the_previous_turns_named_edge() {
    let (_dir, db, space, task_id) = fixture("adv-outcome-cleared");
    fan_out(&db, &space);
    claim_named(&db, "s-twice", &task_id, "backlog", "fail");
    assert_eq!(
        dest_slug(&advice(&db, "s-twice", Some("fail"), None)),
        Some("approved".to_string())
    );

    // The next turn, spelled as it actually happens: the turn-start clear writes
    // `ready = 0` AND wipes the stored name in the one statement `set_session_ready`
    // is, and then this turn's `mark_done` claims again and names nothing. Both halves
    // of the previous claim go together — which is exactly why they are one statement.
    db.set_session_ready("s-twice", Some(false), None)
        .expect("the turn-start clear");
    db.set_session_ready("s-twice", Some(true), None)
        .expect("the second turn claims, naming nothing");

    let a = advice(&db, "s-twice", None, None);
    assert_eq!(
        dest_slug(&a),
        Some("research".to_string()),
        "the head fires — a stale name from a turn that is over must not route this one"
    );
    assert_eq!(a.reason, "advanced");
}

// ── the dedupe's scope, and why the card-scoped backstop was REJECTED ─────────
//
// A reviewer offered widening arm 3's dedupe to `WHERE task_id = ?1 AND rowid > ?2`
// (dropping `stage_slug`) so a destination mismatch could not slip past arm 3 even if
// the two doors resolved different edges. That backstop was considered and REJECTED,
// and the test below is the measurement behind the rejection rather than an opinion
// about it.
//
// What the widening would actually catch is now nil: both doors resolve the edge from
// the one stored `sessions.advance_outcome`, which is what the two tests above pin.
// What it would break is a person. Measured, not assumed: `move_task` — the drag —
// writes NO `task_sessions` row at all (it is an `UPDATE` on `tasks.stage_slug`, and
// `Db::link_session` is the only production writer of the link table), so a DRAG is
// invisible to this arm either way and the reviewer's worry is not about drags. But a
// person's second LAUNCH on the card goes through `startTaskSession` →
// `write_task_session_link` → `link_session`, which writes a row at whatever column the
// card landed in — and a card-scoped predicate matches that row at ANY slug. So the
// widening would answer `already_advanced` at a link nobody launched, spend no step,
// and leave the card sitting there with the amber bell and no sentence, because
// `already_advanced` is the SILENT arm. The widening buys a guard against a case the
// stored outcome already closed and costs a person their launch.

/// **THE BACKSTOP MEASUREMENT.** A person's second launch on the card writes a link row
/// at a slug the chain did not choose; the destination-scoped dedupe correctly ignores it,
/// and a card-scoped one would have killed the advance.
///
/// The two halves are the same card, the same claim, the same rowid ordering. Only the
/// predicate's scope differs, and this is the pin that says which scope is right.
#[test]
fn a_persons_second_launch_on_the_card_does_not_dedupe_the_chains_own_link() {
    let (_dir, db, space, task_id) = fixture("adv-human-launch");
    set_auto(&db, &space, "backlog", true);
    claim(&db, "s-chain", &task_id, "backlog");

    // A person launches a Session in `done` — the card's own card, a deliberate second
    // launch, written AFTER the chain's link and at a slug the chain never chose. This
    // is `startTaskSession` → `write_task_session_link` → `link_session`, the only
    // production path that writes this table besides the chain's own launch.
    record(&db, "s-human");
    db.link_session(&task_id, "s-human", Some("done"))
        .expect("the person's launch links at the column it landed in");

    let a = advice(&db, "s-chain", None, None);
    assert!(
        a.advance,
        "reason was {:?} — a card-scoped dedupe would answer `already_advanced` here, \
         and `already_advanced` is SILENT: no step, no launch, no sentence, and a card \
         that looks abandoned. The person's launch is not this link's launch",
        a.reason
    );
    assert_eq!(dest_slug(&a), Some("research".to_string()));
    assert!(
        !a.already_launched,
        "the dedupe READ is destination-scoped, and no row at `research` is newer"
    );
}
