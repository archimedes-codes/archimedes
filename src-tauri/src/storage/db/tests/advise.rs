//! Tests for `db/advise.rs`: the single decider both the `mark_done` claim and the
//! settle fallback ask, whose input is a Session id and whose answer is a launch
//! instruction.
//!
//! This child is the mirror of `db/advise.rs`. It owns the ARM ORDER as well as the
//! arms, because the order is the load-bearing part of the design: the ceiling is a
//! read that must answer ahead of the dedupe's early return, and the step is a write
//! that must stay behind it. A test that only checks "the right answer eventually came
//! out" passes under the wrong order, so this file's most important case
//! (`the_ceiling_answers_before_the_dedupe_does`) builds a fixture where BOTH would
//! fire and asserts which one did.
//!
//! # THREE CHILDREN FOR ONE PRODUCTION FILE, and where the line falls
//!
//! ADR 0112's 1,000-code-line test gate reddened this child at 1,042, and the sanctioned
//! answer was a subject split and never a threshold edit — the `stages` →
//! `stage_lifecycle` + `stage_setters` pair is the precedent for splitting ONE
//! production file's tests by subject. This child keeps the ARMS and their ORDER;
//! [`super::advise_cost`] took the settled-cost bank and the ceiling's accumulation, and
//! [`super::advise_outcome`] took the edge the model chose and the two doors' agreement
//! on it. Three subjects, three ways to fail: a wrong arm order still answers
//! `advance: false`; a missing bank leaves every arm answering correctly about a number
//! that never moved; a discarded outcome launches the right shape of thing down the wrong
//! edge.
//!
//! TWO TESTS STRADDLE THE LINE and stay here on purpose, because both ask arm 5 "which
//! edge fires" for a SINGLE door, which is this child's subject: `arm 5: which edge
//! fires` owns `a_named_outcome_fires_the_edge_labelled_with_it` and
//! `an_unmatched_outcome_falls_back_to_the_head_and_says_so`. What moved to
//! `advise_outcome` is the question only the PAIR of doors can ask — does the settle
//! resolve the edge the claim resolved — plus the dedupe-scope measurement that rejects
//! the card-scoped backstop. The fixtures all three children read live in
//! [`super::support`].
//!
//! # What is deliberately NOT mocked
//!
//! Every assertion drives a real `Db` through real SQL. There is no board slice to
//! stub because there is no slice on this path — which is the point — and the headline
//! case asserts the absence of a board read rather than merely not making one.
//!
//! # The two scopes of arm 3, and why one fixture is not enough
//!
//! The positive case's matching row belongs to a **different Session** on the same
//! card, because a successful launch links the *newly started* Session and not the
//! claimer. The negative case puts **two link rows on the claimer alone** — one of them
//! at the destination slug — and asserts NO dedupe. Those two together are what pin
//! "card-scoped, bounded by the claimer's own rowid": a search that dropped the card
//! scope, or dropped the rowid bound, passes one of them and fails the other. Either
//! misreading alone makes the arm silently dead or silently fatal, and the first
//! draft's "equal rowid" case passes under BOTH readings and pins nothing.

use rusqlite::params;

use crate::storage::db::{ChainStop, Db, StageRow};
use crate::storage::{DEFAULT_AUTO_CEILING_USD, DEFAULT_AUTO_MAX_STEPS};

use super::support::*;

/// Re-point one link row's FROZEN lane.
///
/// Raw SQL, because `task_sessions` is keyed `(task_id, session_id)` and
/// `Db::link_session` is `INSERT OR IGNORE` — the FIRST link wins by design, so there is
/// no verb that re-points a lane and a test that needs the shape must write it. Both
/// callers of the real thing go through `launchTaskSession`, which moves the card and
/// then links a Session that has never been linked to this card before.
fn relink(db: &Db, task_id: &str, session_id: &str, slug: &str) {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "UPDATE task_sessions SET stage_slug = ?3 WHERE task_id = ?1 AND session_id = ?2",
            params![task_id, session_id, slug],
        )
        .expect("re-point the frozen lane");
}

// ── arm 0: no card ───────────────────────────────────────────────────────────

/// A Session that owns no card is told so, and EVERY number is absent rather than
/// invented — no Space was resolved, so there is no bound to quote.
#[test]
fn a_session_that_owns_no_card_is_unlinked_and_carries_no_invented_bound() {
    let (_dir, db, _space, _task_id) = fixture("adv-unlinked");
    record(&db, "s-loose");
    db.set_session_ready("s-loose", Some(true), None)
        .expect("a claim from a cardless Session still writes its own flag");

    let a = advice(&db, "s-loose", None, Some(99.0));
    assert!(!a.advance, "nothing advances for a card nobody owns");
    assert_eq!(a.reason, "unlinked");
    assert!(a.stop.is_none(), "a missing card is not a chain stop");
    assert!(a.destination.is_none());
    assert_eq!(
        (
            a.max_steps,
            a.ceiling_usd,
            a.task_id.clone(),
            a.space_path.clone()
        ),
        (None, None, None, None),
        "`unlinked` is the ONE arm that carries no numbers: reporting the shipped \
         20-step fallback here would report a bound for a Space that was never \
         resolved, which is the move `workflow_run_step` refuses for the same shape"
    );
    assert!(!a.already_launched);
}

// ── arm 1: no claim (D4) ─────────────────────────────────────────────────────

/// A settle with no prior claim does not move the card — and `ready = 0` is NOT a
/// claim, which is the half of this arm a `!= 0` reading gets backwards.
///
/// The turn-start clear writes `0` to every Session that has ever run a turn, so a
/// chain that treated `0` as evidence of a claim would advance a card on every settle
/// of every Session that ever ran. That is D4's whole refusal, and the pre-existing
/// "the chain fires whether or not the model claimed anything" defect.
#[test]
fn a_settle_with_no_prior_claim_is_unclaimed_and_both_null_and_zero_are_not_claims() {
    let (_dir, db, space, task_id) = fixture("adv-unclaimed");
    set_auto(&db, &space, "backlog", true);

    // `ready` NULL: never marked.
    linked(&db, "s-never", &task_id, "backlog");
    let a = advice(&db, "s-never", None, None);
    assert!(!a.advance);
    assert_eq!(a.reason, "unclaimed");
    assert!(a.stop.is_none(), "an un-claimed settle is not a bound trip");
    assert!(a.destination.is_none());

    // `ready` 0: checked, and the answer is no. THE DISTINGUISHING CASE.
    linked(&db, "s-cleared", &task_id, "backlog");
    db.set_session_ready("s-cleared", Some(false), None)
        .expect("the turn-start clear writes 0");
    let b = advice(&db, "s-cleared", None, None);
    assert!(!b.advance, "a stored `0` is an answer of NO, not a claim");
    assert_eq!(b.reason, "unclaimed");

    // And the arm carries every number it CAN carry — the Space was resolved here.
    assert_eq!(b.max_steps, Some(DEFAULT_AUTO_MAX_STEPS));
    assert_eq!(b.ceiling_usd, Some(DEFAULT_AUTO_CEILING_USD));
    assert_eq!(b.task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(b.space_path.as_deref(), Some(space.as_str()));

    // A Session id with no row at all answers rather than erroring — and it answers
    // `unlinked`, because arm 0 precedes arm 1: with no row there is no link, so the
    // card question is the first one that has no answer.
    let c = advice(&db, "s-does-not-exist", None, None);
    assert_eq!(
        c.reason, "unlinked",
        "no row, so no card, so the card arm fires"
    );

    // And NOTHING was written on any of these three paths.
    assert_eq!(run_row(&db, &task_id), None);
}

// ── the headline: claimed + auto, with no board ever opened ──────────────────

/// **THE HEADLINE.** A claim in an `auto` column answers `advance: true` with a
/// destination ROW — driven against a `Db` on which `get_board` has never been called.
///
/// The absence of a board read is asserted and not assumed: the seeded columns arrive
/// from `create_task`, so the decision above came out of the database with no seeding
/// and no slice. That distinction is the entire defect this feature removes — the chain
/// read the slice, the slice is unmounted in exactly the case an unattended chain
/// settles in, and `workflow_runs` consequently holds zero rows against 456 Sessions.
///
/// The destination is a whole `StageRow` and not a slug, because ADR 0098 is that the
/// Skill, the label and the prompt prefix come from ONE row and cannot disagree.
#[test]
fn a_claim_in_an_auto_column_answers_a_destination_row_with_no_board_ever_opened() {
    let (_dir, db, space, task_id) = fixture("adv-headline");
    // The column the Session was LAUNCHED in is the one whose `auto` flag decides.
    set_auto(&db, &space, "backlog", true);
    claim(&db, "s-headline", &task_id, "backlog");

    let a = advice(&db, "s-headline", None, None);

    assert!(
        a.advance,
        "`auto` on + a claim = advance; reason was {:?}",
        a.reason
    );
    assert_eq!(a.reason, "advanced", "the head edge fired, nothing named");
    assert!(a.stop.is_none());
    // The default board leaves `next_slugs` NULL, so this destination came from the
    // D15 `sort_order + 1` fallback: backlog(0) → research(1).
    assert_eq!(
        dest_slug(&a),
        Some("research".to_string()),
        "the fallback resolves the next column on an UNCONFIGURED board — the same \
         fallback that makes the forward gate bite on a default Space"
    );
    let dest = a.destination.as_ref().expect("a destination row");
    assert_eq!(dest.label, "Research", "the row is REAL, label and all");
    assert_eq!(
        dest.on_enter_skill.as_deref(),
        Some("research"),
        "and it carries the `onEnterSkill` the launch needs — one row answers slug, \
         label and Skill together (ADR 0098)"
    );
    assert_eq!(dest.space_path, space);
    assert_eq!(
        a.task_id.as_deref(),
        Some(task_id.as_str()),
        "the card rides the answer, because the claim path holds only a `sessionId` \
         and `launchTaskSession(spacePath, task, toStageSlug, catalogs)` needs both"
    );
    assert_eq!(a.space_path.as_deref(), Some(space.as_str()));
    assert!(!a.already_launched, "this link has not launched yet");
    assert_eq!(a.max_steps, Some(DEFAULT_AUTO_MAX_STEPS));
    assert_eq!(a.ceiling_usd, Some(DEFAULT_AUTO_CEILING_USD));

    // THE NO-SLICE PROOF: the columns exist from `create_task`'s seed alone, read
    // through the slice-free stage read. No `get_board` call appears anywhere above.
    let stages = db.list_stages(&space).expect("list_stages");
    assert_eq!(
        stages.len(),
        5,
        "the five seeded columns are there with no board open and no slice in this test"
    );
}

// ── arm 4: not auto ──────────────────────────────────────────────────────────

/// A claim in a NON-auto column stays put: `not_automatic`, no destination, and the
/// step is NOT spent — there is no launch to buy, so nothing to charge for it.
///
/// The bell surviving through the BOARD READ is pinned at the model's door, in
/// `agent/host_tools/tests/verbs.rs` via the `board_ready` helper, because that is
/// where the read the renderer uses is available. What is pinned HERE is the half that
/// file cannot see: the advice writes nothing on this arm, so nothing it does can have
/// cleared the flag.
#[test]
fn a_claim_in_a_non_auto_column_stays_and_says_not_automatic() {
    let (_dir, db, _space, task_id) = fixture("adv-non-auto");
    // `backlog` is NOT auto — the seed leaves every column off, and that is the case.
    claim(&db, "s-nonauto", &task_id, "backlog");

    let a = advice(&db, "s-nonauto", None, None);
    assert!(!a.advance);
    assert_eq!(a.reason, "not_automatic");
    assert!(
        a.stop.is_none(),
        "a non-auto column is a policy, not a bound"
    );
    assert!(a.destination.is_none());
    assert_eq!(a.task_id.as_deref(), Some(task_id.as_str()));
    assert!(!a.already_launched);

    // The card did not move and the claim is intact — the bell's two inputs.
    assert_eq!(
        db.get_task(&task_id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "backlog",
        "the card stays where it was"
    );
    assert_eq!(
        raw_i64s(&db, "SELECT ready FROM sessions WHERE id = 's-nonauto'"),
        vec![1],
        "and `ready` is STILL 1 — this arm writes nothing, so the amber bell a person \
         sees is untouched"
    );
    assert_eq!(
        run_row(&db, &task_id),
        None,
        "and NO step was spent: a chain that did not advance has nothing to bill, so \
         a step here would eat the bound with no launch to show for it"
    );
}

/// Flipping the SAME column to `auto` flips the answer, which is what makes
/// `stages.auto` the policy owner rather than a flag the decision ignores.
#[test]
fn the_same_claim_advances_once_the_column_is_flagged_auto() {
    let (_dir, db, space, task_id) = fixture("adv-auto-flip");
    claim(&db, "s-flip", &task_id, "backlog");
    assert_eq!(advice(&db, "s-flip", None, None).reason, "not_automatic");

    set_auto(&db, &space, "backlog", true);
    let a = advice(&db, "s-flip", None, None);
    assert!(
        a.advance,
        "one flag, read from the database, is the whole policy"
    );
    assert_eq!(dest_slug(&a), Some("research".to_string()));
}

// ── arm 5: which edge fires ──────────────────────────────────────────────────

/// `[]` is a VALUE and not a gap: a column configured to lead nowhere resolves no
/// destination, and the `sort_order + 1` fallback must NOT fire over it.
#[test]
fn an_empty_edge_list_resolves_no_destination_and_does_not_fall_back() {
    let (_dir, db, space, task_id) = fixture("adv-empty-edges");
    set_auto(&db, &space, "backlog", true);
    set_edges(&db, &space, "backlog", &[], &[]);
    claim(&db, "s-empty", &task_id, "backlog");

    let a = advice(&db, "s-empty", None, None);
    assert!(!a.advance);
    assert_eq!(a.reason, "no_next_stage");
    assert!(
        a.destination.is_none(),
        "`[]` means this column leads nowhere — answering `research` here would mean \
         the fallback fired over a CONFIGURED value, which is ADR 0099's `[]` ≠ NULL \
         collapse and would move a card its owner configured not to move"
    );
    assert_eq!(
        run_row(&db, &task_id),
        None,
        "and no step is spent on a chain with nowhere to go"
    );
}

/// A `NULL` column with a HOLE at `sort_order + 1` resolves NOTHING.
///
/// **The D15 limit, pinned rather than fixed.** `delete_stage` never compacts
/// `sort_order`, so after a middle column is deleted the column before the hole has no
/// `sort_order + 1` neighbour and the fallback finds no destination. TypeScript's
/// `nextStepSlugs` has the identical hole, so the two sides still answer one card the
/// same way — which is worth more than a one-sided fix. Widening this to `> sort_order`
/// would silently diverge from the frontend; a person reaches the far side of a hole in
/// two drags.
#[test]
fn a_null_column_before_a_sort_order_hole_resolves_nothing_and_that_is_pinned() {
    let (_dir, db, space, task_id) = fixture("adv-hole");
    // Delete a middle column. `approved` holds no card and no `next_slugs` names it on
    // a seeded board, so the delete is legal, and the hole is what it leaves behind.
    db.delete_stage(&space, "approved", None)
        .expect("delete a middle column");
    let orders: Vec<(String, i64)> = db
        .list_stages(&space)
        .expect("list_stages")
        .into_iter()
        .map(|s| (s.slug, s.sort_order))
        .collect();
    assert!(
        orders.iter().any(|(_, o)| *o == 1) && orders.iter().any(|(_, o)| *o == 3),
        "the fixture needs `sort_order` 1 and 3 to survive; got {orders:?}"
    );
    assert!(
        !orders.iter().any(|(_, o)| *o == 2),
        "`sort_order` 2 is the hole — `delete_stage` does not compact; got {orders:?}"
    );

    // `research` (sort_order 1) is the column immediately before the hole.
    set_auto(&db, &space, "research", true);
    db.move_task(
        &space,
        &task_id,
        "research",
        crate::storage::MoveAuthor::Person,
    )
    .expect("position the card (a person is unrestricted, D11)");
    claim(&db, "s-hole", &task_id, "research");

    let a = advice(&db, "s-hole", None, None);
    assert!(!a.advance, "the hole resolves no destination");
    assert_eq!(a.reason, "no_next_stage");
    assert!(
        a.destination.is_none(),
        "and NOT `doing` — skipping the hole would diverge from `nextStepSlugs`, which \
         stops at exactly this hole"
    );
}

/// The caller names an edge and that edge fires — including on a list that is only
/// PARTIALLY labelled, which is what the inner `Option` in `next_outcomes` exists for.
#[test]
fn a_named_outcome_fires_the_edge_labelled_with_it() {
    let (_dir, db, space, task_id) = fixture("adv-outcome-match");
    set_auto(&db, &space, "backlog", true);
    // `[null, "fail"]`: the FIRST edge is unlabelled, the second is `fail`. A
    // `Vec<String>` decoder fails the whole cell on that `null` and loses `fail` with
    // it, so this assertion is what Task 1's inner-`Option` deviation buys.
    set_edges(
        &db,
        &space,
        "backlog",
        &["research", "approved"],
        &[None, Some("fail")],
    );
    claim(&db, "s-named", &task_id, "backlog");

    let a = advice(&db, "s-named", Some("fail"), None);
    assert!(a.advance);
    assert_eq!(
        dest_slug(&a),
        Some("approved".to_string()),
        "the SECOND edge fired, not the head"
    );
    assert_eq!(
        a.reason, "advanced",
        "a matched edge says nothing about a fallback"
    );

    // And a claim that names nothing still takes the head — on its OWN card, so the
    // two halves of this test cannot meet through the dedupe.
    let head_card = db
        .create_task(&space, "the head-edge card", None, None)
        .expect("create_task");
    claim(&db, "s-head", &head_card.id, "backlog");
    let b = advice(&db, "s-head", None, None);
    assert!(b.advance);
    assert_eq!(dest_slug(&b), Some("research".to_string()));
    assert_eq!(b.reason, "advanced");
}

/// An outcome the board does not have falls back to the HEAD and says so.
///
/// A model inventing an edge name must not be able to stall a chain: an unlabelled
/// board is the ORDINARY case (every seeded Space is one), so a miss is neither an
/// error nor a refusal. The difference between "the edge you named fired" and "the head
/// fired instead of it" lives in `reason`, because no other field can carry it.
#[test]
fn an_unmatched_outcome_falls_back_to_the_head_and_says_so() {
    let (_dir, db, space, task_id) = fixture("adv-outcome-miss");
    set_auto(&db, &space, "backlog", true);
    set_edges(
        &db,
        &space,
        "backlog",
        &["research", "approved"],
        &[Some("ok"), Some("fail")],
    );
    claim(&db, "s-invented", &task_id, "backlog");

    let a = advice(&db, "s-invented", Some("escalated"), None);
    assert!(a.advance, "an invented outcome does not stall the chain");
    assert_eq!(
        dest_slug(&a),
        Some("research".to_string()),
        "the head fired"
    );
    assert_eq!(
        a.reason, "advanced_unnamed_edge",
        "and the answer says the head fired in place of the edge that was asked for"
    );

    // An UNLABELLED board (every seeded Space) with a named outcome lands here too.
    let (_d2, db2, space2, card2) = fixture("adv-outcome-unlabelled");
    set_auto(&db2, &space2, "backlog", true);
    claim(&db2, "s-unlabelled", &card2, "backlog");
    let b = advice(&db2, "s-unlabelled", Some("ok"), None);
    assert!(b.advance);
    assert_eq!(dest_slug(&b), Some("research".to_string()));
    assert_eq!(b.reason, "advanced_unnamed_edge");
}

// ── arm 3: the dedupe, both scopes ───────────────────────────────────────────

/// **THE POSITIVE CASE, CARD-SCOPED.** A link row at the destination belonging to a
/// DIFFERENT Session on the same card, written after the claimer's own row, is the
/// launch this dedupe exists to find.
///
/// This is the shape a SUCCESSFUL advance leaves behind: the claim resolved
/// `backlog → research`, the frontend moved the card and started a new Session, and
/// `Db::link_session` recorded THAT Session at `research`. When the claimer's turn
/// finally settles, the fallback must not launch a second Session for the same link.
///
/// The matching row belongs to `s-launched` and NOT to the claimer, and that is the
/// whole test: a Session-scoped search cannot find it, and the newest-link rule makes a
/// Session-scoped search structurally incapable of ever matching (the claimer's own row
/// is by definition the newest for that Session). One scope and this arm is dead.
#[test]
fn a_newer_link_at_the_destination_from_another_session_dedupes() {
    let (_dir, db, space, task_id) = fixture("adv-dedupe-hit");
    set_auto(&db, &space, "backlog", true);
    linked(&db, "s-claimer", &task_id, "backlog");
    db.set_session_ready("s-claimer", Some(true), None)
        .expect("claim");

    // The claim, first — with no launch row yet it advances, and spends the step.
    let opened = advice(&db, "s-claimer", None, None);
    assert!(opened.advance, "with no launch row yet, the claim advances");
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, None)),
        "and the claim spent one step"
    );

    // The launch the claim caused: a DIFFERENT Session, linked at the destination.
    record(&db, "s-launched");
    db.link_session(&task_id, "s-launched", Some("research"))
        .expect("the launch links the NEWLY STARTED Session at the destination");

    // The same claim, asked again now that the launch row exists.
    let a = advice(&db, "s-claimer", None, None);
    assert!(!a.advance, "this link already launched");
    assert_eq!(a.reason, "already_advanced");
    assert!(a.stop.is_none(), "nothing stopped — the link was taken");
    assert!(
        a.already_launched,
        "and the read rides the answer, because Task 4's close/no-close rule needs it \
         separately from `reason`"
    );
    assert!(a.destination.is_none(), "no second launch to instruct");
    assert_eq!(a.task_id.as_deref(), Some(task_id.as_str()));

    // The dedupe is a `task_sessions` question and NOT a `workflow_runs` one: the claim
    // spent a step, and a dedupe keyed on `steps` would answer "already advanced" at
    // the settle in exactly the case the fallback exists for — a model that ignored its
    // tool result would get neither a launch nor a fallback.
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, None)),
        "and the run row still reads ONE step — the dedupe fired with a step already \
         spent, which is the proof this arm is not keyed on `steps`. A dedupe keyed on \
         the run would answer `already_advanced` at the settle in exactly the case the \
         fallback exists for, and the fallback would be dead by construction"
    );
}

/// **THE NEGATIVE TWIN.** Two link rows on the CLAIMER ALONE must not dedupe.
///
/// The claimer's OLDER row sits on a different card and carries the destination slug;
/// its NEWER row is the card under test, launched at `backlog`. So:
///   - dropping the CARD scope would find the older row and wrongly answer
///     `already_advanced`, killing every advance for a Session that has ever been
///     handed between cards — a third of the live board's cards;
///   - dropping the `rowid > own` bound would find the claimer's own row wherever it
///     points and answer the same way.
#[test]
fn two_link_rows_on_the_claimer_alone_do_not_dedupe() {
    let (_dir, db, space, task_id) = fixture("adv-dedupe-miss");
    set_auto(&db, &space, "backlog", true);

    // An OTHER card, launched at what will be the destination, linked FIRST.
    let other = db
        .create_task(&space, "a card this Session used to own", None, None)
        .expect("create_task");
    linked(&db, "s-handed", &other.id, "research");
    // Then the card under test, launched at `backlog` — the NEWER link, so the
    // newest-link rule makes it the card that wins.
    db.link_session(&task_id, "s-handed", Some("backlog"))
        .expect("the newer link");
    db.set_session_ready("s-handed", Some(true), None)
        .expect("claim");

    let a = advice(&db, "s-handed", None, None);
    assert!(
        a.advance,
        "reason was {:?} — the dedupe matched a row outside the card, or matched the \
         claimer's own row without the rowid bound. Either reading fires this arm on \
         every handed-off Session",
        a.reason
    );
    assert_eq!(dest_slug(&a), Some("research".to_string()));
    assert!(
        !a.already_launched,
        "the dedupe READ is false, and it is the same read the arm would have used"
    );
}

/// A link row at the destination that is OLDER than the claimer's own row does not
/// dedupe — the bound is "written after the claim", not "has ever existed".
///
/// The reachable shape is a card that visits the same column twice: it goes
/// backlog → research, comes back, and is claimed again. The old `research` link is
/// real and older, and honouring it would strand the card forever.
#[test]
fn an_older_link_at_the_destination_does_not_dedupe() {
    let (_dir, db, space, task_id) = fixture("adv-dedupe-older");
    set_auto(&db, &space, "backlog", true);
    // The FIRST visit's link, at the destination slug, written FIRST.
    linked(&db, "s-revisit", &task_id, "research");
    // The card came back to `backlog`; the frozen lane follows the relaunch. Raw SQL
    // because `link_session` is INSERT-OR-IGNORE on the (task_id, session_id) key.
    relink(&db, &task_id, "s-revisit", "backlog");
    db.set_session_ready("s-revisit", Some(true), None)
        .expect("claim");
    // A NEWER row belonging to someone else, at a DIFFERENT slug — so the destination
    // match has to be what decides, and not the rowid alone.
    record(&db, "s-other");
    db.link_session(&task_id, "s-other", Some("done"))
        .expect("a newer link, at the wrong slug");

    let a = advice(&db, "s-revisit", None, None);
    assert!(a.advance, "reason was {:?}", a.reason);
    assert_eq!(dest_slug(&a), Some("research".to_string()));
    assert!(
        !a.already_launched,
        "no row at `research` is newer than the claimer's own"
    );
}

// ── arm 2: the ceiling, and the arm order ────────────────────────────────────

/// **THE ARM-ORDER PIN.** Both the ceiling and the dedupe are true on ONE fixture and
/// the answer is `cost_ceiling`.
///
/// This is the test that fails if the ceiling moves below the dedupe — and it would
/// fail SILENTLY in production if it did not exist, because the wrong order still
/// returns `advance: false`. What differs is whether the money guard ever speaks: on
/// the claim-then-settle path the dedupe fires on every settle, so a ceiling evaluated
/// after it is a ceiling that is never evaluated at all once Task 4 replaces
/// `workflowRunStep`. That is D18's never-trips fail-open, reintroduced by ordering.
///
/// `already_launched` still rides the answer `true`, because the dedupe is a READ and
/// D20's rule is that the step WRITE stays behind it — not the read.
#[test]
fn the_ceiling_answers_before_the_dedupe_does() {
    let (_dir, db, space, task_id) = fixture("adv-arm-order");
    db.set_auto_guards(&space, Some(20), Some(10.0))
        .expect("a $10 ceiling");
    set_auto(&db, &space, "backlog", true);
    linked(&db, "s-both", &task_id, "backlog");
    db.set_session_ready("s-both", Some(true), None)
        .expect("claim");

    // Condition one: the dedupe WOULD fire.
    record(&db, "s-launched");
    db.link_session(&task_id, "s-launched", Some("research"))
        .expect("a newer link at the destination");
    // Condition two: the ceiling WOULD trip, against spend banked by an earlier settle.
    db.workflow_run_step(&space, &task_id, Some(12.0))
        .expect("bank $12 on the open run");

    let a = advice(&db, "s-both", None, None);
    assert!(!a.advance);
    assert_eq!(
        a.reason, "cost_ceiling",
        "arm 2 precedes arm 3 — `already_advanced` here means the ceiling moved below \
         the dedupe, and the ceiling is then unreachable on the only path that carries \
         a real cost figure"
    );
    assert_eq!(a.stop, Some(ChainStop::CostCeiling));
    assert!(
        a.already_launched,
        "the dedupe READ still rides the answer: Task 4 must NOT close this run, and \
         `reason` alone cannot say both `cost_ceiling` and `already launched`"
    );
    assert_eq!(a.ceiling_usd, Some(10.0));
}

/// The ceiling trips at a settle that carries a real delta, and **writes nothing**.
#[test]
fn the_ceiling_trips_at_a_settle_that_reports_a_figure_and_writes_no_step() {
    let (_dir, db, space, task_id) = fixture("adv-ceiling-settle");
    db.set_auto_guards(&space, Some(20), Some(10.0))
        .expect("a $10 ceiling");
    set_auto(&db, &space, "backlog", true);
    claim(&db, "s-settle", &task_id, "backlog");
    // The claim itself, which is what OPENS the run (the step verb is the upsert).
    assert!(advice(&db, "s-settle", None, None).advance);
    let before = run_row(&db, &task_id).expect("the claim opened a run");

    // …and the settle, carrying the real delta this is the only arm that ever gets.
    let a = advice(&db, "s-settle", None, Some(25.0));
    assert!(!a.advance);
    assert_eq!(a.reason, "cost_ceiling");
    assert_eq!(a.stop, Some(ChainStop::CostCeiling));
    assert_eq!(
        a.ceiling_usd,
        Some(10.0),
        "the ceiling the caller may quote"
    );
    assert_eq!(
        run_row(&db, &task_id),
        Some(before),
        "and the arm WROTE NOTHING — `steps` and `cost_usd` are exactly as the claim \
         left them. The ceiling is a read of money already spent"
    );
}

/// **D18's correction, pinned.** A claim with `cost_delta_usd = None` still trips
/// against spend an earlier settle banked.
///
/// `None` means the fold adds NOTHING, not that the comparison is skipped. A chain that
/// banked $12 against a $10 ceiling stops at its NEXT claim, before that link launches —
/// better than a settle-only promise would have been, and the reason the ceiling is not
/// purely lagged.
#[test]
fn a_claim_with_no_delta_still_trips_against_spend_an_earlier_settle_banked() {
    let (_dir, db, space, task_id) = fixture("adv-ceiling-claim");
    db.set_auto_guards(&space, Some(20), Some(10.0))
        .expect("a $10 ceiling");
    set_auto(&db, &space, "backlog", true);

    // A first link, claimed and then billed at its settle.
    claim(&db, "s-first", &task_id, "backlog");
    assert!(
        advice(&db, "s-first", None, None).advance,
        "the first claim is free"
    );
    db.workflow_run_step(&space, &task_id, Some(12.0))
        .expect("a settle bills $12");

    // A second link, claimed with NO figure of its own.
    claim(&db, "s-second", &task_id, "backlog");
    let a = advice(&db, "s-second", None, None);
    assert!(
        !a.advance,
        "banked $12 against a $10 ceiling trips at the NEXT claim, before that link \
         launches; got {:?}",
        a.reason
    );
    assert_eq!(a.reason, "cost_ceiling");
    assert_eq!(a.ceiling_usd, Some(10.0));
}

/// An unbilled chain NEVER trips a ceiling — not even a $0.00 one — and the step bound
/// is what stops it instead.
///
/// The ADR 0082 limitation, stated as behaviour: `cost_usd IS NULL` means "no Session in
/// this chain ever reported a figure", and reading that as `0.0` would make a chain that
/// reported nothing look like one that spent nothing — a guard that fails open forever.
/// So `None` cannot compare, and there is no `?? 0` anywhere on this path.
#[test]
fn an_unbilled_chain_cannot_trip_any_ceiling_including_a_zero_one() {
    let (_dir, db, space, task_id) = fixture("adv-unbilled");
    db.set_auto_guards(&space, Some(20), Some(0.0))
        .expect("a $0.00 ceiling — the tightest one a person can configure");
    set_auto(&db, &space, "backlog", true);
    claim(&db, "s-free", &task_id, "backlog");

    let a = advice(&db, "s-free", None, None);
    assert!(
        a.advance,
        "a chain that reported NO figure cannot trip a ceiling; got {:?}",
        a.reason
    );
    assert_eq!(
        a.ceiling_usd,
        Some(0.0),
        "and the answer carries the $0.00 so the caller can SAY the ceiling is zero \
         while knowing it is not what stopped anything"
    );
    assert_eq!(run_row(&db, &task_id), Some((1, None)));

    // THE DELTA ARM, inside this test. `None` is what the claim path sends and what
    // every case above exercises; the `Some(delta)` arm's baseline —
    // `banked.unwrap_or(0.0) + delta` — was guarded here by NOTHING, and it is the
    // arm a "tidy" fail-open targets: treating `banked: None` as "no spend" instead of
    // "no FIGURE" would let a first-ever $50 settle sail past a $10 ceiling.
    //
    // `Some(0.0)` against this run (open, `cost_usd` still NULL) is the tightest
    // probe of that baseline, and the honest answer is that it TRIPS: a REPORTED zero
    // is a figure, `0.0 + 0.0 >= 0.0`, and that is `>=` behaving as designed — the
    // same arithmetic both of `workflow_run_step`'s write arms perform
    // (`COALESCE(cost_usd, 0.0) + ?2`, and the INSERT that stores the delta verbatim).
    // What cannot trip is the ABSENCE of a figure, which is `a` above; a reported $0.00
    // is not an absence, and the pair of assertions is what makes this a NULL rule
    // rather than a broken ceiling.
    let reported_zero = advice(&db, "s-free", None, Some(0.0));
    assert!(
        !reported_zero.advance,
        "a REPORTED $0.00 delta against a $0.00 ceiling trips even on a run nothing \
         has banked on; got {:?}",
        reported_zero.reason
    );
    assert_eq!(
        reported_zero.reason, "cost_ceiling",
        "and it is the ceiling and not another arm that answered"
    );
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, None)),
        "the ceiling is READ-ONLY (D18): no second step, and the run's figure is \
         still NULL — the fold is arithmetic, not a write"
    );

    // The SAME chain, once a figure lands, does trip — which makes the case above a
    // NULL rule and not a broken ceiling.
    db.workflow_run_step(&space, &task_id, Some(0.0))
        .expect("a REPORTED $0.00");
    claim(&db, "s-billed", &task_id, "backlog");
    let b = advice(&db, "s-billed", None, None);
    assert!(!b.advance, "a REPORTED $0.00 against a $0.00 ceiling trips");
    assert_eq!(b.reason, "cost_ceiling");
}

// ── arm 6: the step ──────────────────────────────────────────────────────────

/// The step bound refuses at a claim, and the answer quotes the Space's OWN bound
/// rather than the shipped 20.
#[test]
fn the_step_bound_refuses_at_a_claim_and_reports_the_effective_bound() {
    let (_dir, db, space, task_id) = fixture("adv-max-steps");
    db.set_auto_guards(&space, Some(1), Some(100.0))
        .expect("a ONE-step bound");
    set_auto(&db, &space, "backlog", true);

    claim(&db, "s-one", &task_id, "backlog");
    let first = advice(&db, "s-one", None, None);
    assert!(first.advance, "a bound of 1 permits ONE advance");
    assert_eq!(
        first.max_steps,
        Some(1),
        "the Space's number, not the fallback"
    );

    // The second link: no dedupe hit (nothing launched), so the step is spent and the
    // bound trips.
    claim(&db, "s-two", &task_id, "backlog");
    let second = advice(&db, "s-two", None, None);
    assert!(!second.advance);
    assert_eq!(second.reason, "max_steps");
    assert_eq!(second.stop, Some(ChainStop::MaxSteps));
    assert_eq!(
        second.max_steps,
        Some(1),
        "the sentence the caller builds has to say \"1-step bound\", so the effective \
         bound rides the refusal and not only the success"
    );
    assert!(second.destination.is_none());
}

/// **One STEP per SUCCESSFUL link, and the settle's COST still lands.** Claim → the
/// launch links a new Session → settle finds the dedupe, spends no further STEP, and
/// banks its delta.
///
/// The acceptance criterion in one fixture: `steps` is 1 after both calls, and the
/// settle's `already_advanced` came from `task_sessions`. The two halves of this arm
/// must not be collapsed into one — the STEP stays behind the dedupe (a step buys a
/// launch, and this launch was already bought) while the COST lands (money spent is a
/// fact about money already spent). The two tests below own the `None` half and the
/// accumulate half.
#[test]
fn a_successful_link_costs_one_step_across_claim_and_settle() {
    let (_dir, db, space, task_id) = fixture("adv-one-step");
    set_auto(&db, &space, "backlog", true);
    // The claimer is linked FIRST — the order a launch leaves behind, and the order
    // that makes the launch's own row NEWER, which is what arm 3 searches for.
    linked(&db, "s-claim", &task_id, "backlog");
    db.set_session_ready("s-claim", Some(true), None)
        .expect("claim");

    assert!(advice(&db, "s-claim", None, None).advance);
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, None)),
        "the claim spent exactly one step"
    );

    // The launch succeeds: the NEW Session is linked at the destination.
    record(&db, "s-launched");
    db.link_session(&task_id, "s-launched", Some("research"))
        .expect("the successful launch");

    // The claimer's turn settles and asks the same question, with a real delta.
    let settle = advice(&db, "s-claim", None, Some(0.5));
    assert_eq!(settle.reason, "already_advanced");
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, Some(0.5))),
        "`steps` is STILL 1 — the dedupe sits in front of the STEP write, so a dedupe \
         stop never buys a launch it will not make — but `cost_usd` is 0.5. Cost is not \
         a step: the money this turn spent is a fact about money already spent, and an \
         arm that returns before the only cost write DISCARDS it. That was the defect — \
         `cost_usd` stayed NULL on every fully-claimed chain, `banked` was always `None`, \
         and the ceiling compared one link's own spend and never the chain's"
    );
    assert!(settle.already_launched);
}

/// **The refused-launch double-spend, pinned as a decision.** If the claim's launch is
/// refused, `Db::link_session` never runs, arm 3 finds nothing, and the settle spends a
/// SECOND step for the same link.
///
/// Intended, and not a fail-open: a refused launch earns a retry and `max_steps` still
/// bounds the retries. It is pinned so it reads as a documented consequence rather than
/// a bug a later reader "fixes" by moving the step in front of the dedupe — which would
/// make the fallback dead.
#[test]
fn a_refused_launch_spends_a_second_step_and_that_is_the_decision() {
    let (_dir, db, space, task_id) = fixture("adv-refused-double");
    set_auto(&db, &space, "backlog", true);
    linked(&db, "s-claim", &task_id, "backlog");
    db.set_session_ready("s-claim", Some(true), None)
        .expect("claim");

    assert!(advice(&db, "s-claim", None, None).advance);
    assert_eq!(run_row(&db, &task_id), Some((1, None)));

    // The launch was REFUSED (no Skill, a dead worker, a rejected move): no link row.
    let settle = advice(&db, "s-claim", None, None);
    assert!(
        settle.advance,
        "no dedupe hit, so the fallback advances — a model that ignored its tool \
         result still gets its launch; reason was {:?}",
        settle.reason
    );
    assert_eq!(
        run_row(&db, &task_id),
        Some((2, None)),
        "and the same link spent a SECOND step. Bounded by `max_steps`, which is why \
         this is a retry and not a runaway"
    );
}

/// The advice takes its numbers from the step verb it delegates to and never from a
/// literal: a Space that configures 7 and $3 gets 7 and $3 back.
#[test]
fn the_effective_numbers_come_from_the_space_and_not_from_a_literal() {
    let (_dir, db, space, task_id) = fixture("adv-numbers");
    db.set_auto_guards(&space, Some(7), Some(3.0))
        .expect("7 steps, $3");
    set_auto(&db, &space, "backlog", true);
    claim(&db, "s-nums", &task_id, "backlog");

    let a = advice(&db, "s-nums", None, None);
    assert_eq!(a.max_steps, Some(7));
    assert_eq!(a.ceiling_usd, Some(3.0));

    // A Space that configured NOTHING gets the shipped fallbacks, and the answer says
    // so — an unset Space is BOUNDED and not unlimited.
    let (_d2, db2, space2, card2) = fixture("adv-numbers-default");
    set_auto(&db2, &space2, "backlog", true);
    claim(&db2, "s-defaults", &card2, "backlog");
    let b = advice(&db2, "s-defaults", None, None);
    assert_eq!(b.max_steps, Some(DEFAULT_AUTO_MAX_STEPS));
    assert_eq!(b.ceiling_usd, Some(DEFAULT_AUTO_CEILING_USD));
}

/// A Space with no `spaces` row still answers, bounded.
///
/// `auto_guards_on` answers `None`/`None` for a missing row and the fallbacks take over,
/// so a Detached Space chains inside the shipped bounds rather than outside any.
#[test]
fn a_space_with_no_bookkeeping_row_is_bounded_by_the_fallbacks() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-adv-no-space-row-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("adv-no-space-row");
    // NO `upsert_space` — the board tables carry no foreign key on `space_path`.
    let card = db
        .create_task(&space, "a detached card", None, None)
        .expect("create_task");
    set_auto(&db, &space, "backlog", true);
    claim(&db, "s-detached", &card.id, "backlog");

    let a = advice(&db, "s-detached", None, None);
    assert!(a.advance);
    assert_eq!(a.max_steps, Some(DEFAULT_AUTO_MAX_STEPS));
    assert_eq!(a.ceiling_usd, Some(DEFAULT_AUTO_CEILING_USD));
}

/// A board reduced to ONE column resolves no destination and says so, rather than
/// inventing one or failing.
///
/// The launched column IS `auto` here, so arm 4 does not answer first and `no_next_stage`
/// is genuinely arm 5's — an `auto` column with no edge out of it.
///
/// The reachable path is `delete_stage` against a `tasks` table with no production
/// delete verb (ADR 0090): a card can outlive most of its board's columns.
#[test]
fn a_board_with_one_column_resolves_no_destination() {
    let (_dir, db, space, task_id) = fixture("adv-one-column");
    claim(&db, "s-orphan", &task_id, "backlog");

    // Empty the board to one column. `delete_stage` refuses a column that holds cards
    // and refuses the LAST column, so the card is relocated as it goes.
    for slug in ["done", "doing", "approved"] {
        db.delete_stage(&space, slug, None)
            .expect("delete a column holding no cards");
    }
    db.delete_stage(&space, "backlog", Some("research"))
        .expect("relocate the card, then delete its column");
    // The frozen lane still names the deleted `backlog`; point it at the survivor so
    // this case pins the ONE-COLUMN board and not the gone-column arm, which has its
    // own test below.
    relink(&db, &task_id, "s-orphan", "research");
    set_auto(&db, &space, "research", true);
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        1,
        "one column survives — `delete_stage` refuses the last"
    );

    let a = advice(&db, "s-orphan", None, None);
    assert!(!a.advance);
    assert_eq!(a.reason, "no_next_stage");
    assert!(a.destination.is_none());
    assert_eq!(a.task_id.as_deref(), Some(task_id.as_str()));
}

/// A link whose launching column has been deleted advances nowhere.
///
/// `task_sessions.stage_slug` is FROZEN and nothing rewrites it when `delete_stage`
/// removes that column, so the column whose `auto` flag would decide can be gone. The
/// answer is `not_automatic` — there is no flag to read — and NOT a guess at the first
/// column, which would move a card on the strength of a column nobody launched it in.
#[test]
fn a_link_whose_launching_column_is_gone_advances_nowhere() {
    let (_dir, db, space, task_id) = fixture("adv-gone-column");
    claim(&db, "s-gone", &task_id, "approved");
    set_auto(&db, &space, "approved", true);
    db.delete_stage(&space, "approved", Some("doing"))
        .expect("delete the launching column");

    let a = advice(&db, "s-gone", None, None);
    assert!(!a.advance);
    assert_eq!(
        a.reason, "not_automatic",
        "no launched column, so no `auto` flag to read and nothing to advance"
    );
    assert!(a.destination.is_none());
    assert_eq!(
        run_row(&db, &task_id),
        None,
        "and no step was spent for a column that does not exist"
    );
}

/// A stop arm asked twice writes nothing extra.
///
/// The settle fallback can be asked twice — a retry, a re-render, a model that calls
/// `mark_done` again — and a stop arm that incremented on every ask would eat the
/// budget with questions.
#[test]
fn asking_twice_about_a_stop_arm_spends_nothing_extra() {
    let (_dir, db, space, task_id) = fixture("adv-idempotent");
    db.set_auto_guards(&space, Some(20), Some(10.0))
        .expect("a $10 ceiling");
    set_auto(&db, &space, "backlog", true);
    claim(&db, "s-twice", &task_id, "backlog");
    db.workflow_run_step(&space, &task_id, None)
        .expect("open the run the ceiling is read against");
    let before = run_row(&db, &task_id).expect("the run is open");

    let first = advice(&db, "s-twice", None, Some(50.0));
    let second = advice(&db, "s-twice", None, Some(50.0));
    assert_eq!(first.reason, "cost_ceiling");
    assert_eq!(second.reason, "cost_ceiling");
    assert_eq!(
        run_row(&db, &task_id),
        Some(before),
        "two ceiling asks, zero writes — the step verb was never reached"
    );
}

/// The advice never consults the destination's `auto` flag — only the LAUNCHED column's.
///
/// The policy question is "is the column the work was done in automatic?", which is what
/// ADR 0119 §6 and `workflowChain.ts` both implement and what Task 4's rewrite keeps. A
/// destination flagged `auto` whose origin is not stays put; an origin flagged `auto`
/// whose destination is not still advances, because the destination's flag governs the
/// NEXT claim and not this one.
#[test]
fn the_origin_columns_flag_decides_and_not_the_destinations() {
    let (_dir, db, space, task_id) = fixture("adv-which-flag");
    // `research` (the destination) is auto; `backlog` (the origin) is not.
    set_auto(&db, &space, "research", true);
    claim(&db, "s-dest-auto", &task_id, "backlog");
    assert_eq!(
        advice(&db, "s-dest-auto", None, None).reason,
        "not_automatic",
        "a destination flagged `auto` does not authorise leaving a column that is not"
    );

    // The mirror, on a SECOND Space so the first half's flag cannot leak in: origin
    // `research` auto, destination `approved` NOT auto.
    let (_d2, db2, space2, card2) = fixture("adv-which-flag-b");
    set_auto(&db2, &space2, "research", true);
    db2.move_task(
        &space2,
        &card2,
        "research",
        crate::storage::MoveAuthor::Person,
    )
    .expect("position the card in the auto column");
    claim(&db2, "s-origin-auto", &card2, "research");
    let a = advice(&db2, "s-origin-auto", None, None);
    assert!(a.advance, "the ORIGIN's flag is the policy");
    assert_eq!(dest_slug(&a), Some("approved".to_string()));
    let dest: &StageRow = a.destination.as_ref().expect("a destination row");
    assert!(
        !dest.auto,
        "and the destination is NOT auto — advancing out of an auto column into a          non-auto one is what `auto` means: this column hands off, the next one stops"
    );
}
