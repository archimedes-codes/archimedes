//! Tests for the **settled COST on `advise.rs`'s early-return arms** — the money a
//! settle carries when it returns ahead of the step verb, and the ceiling that only
//! accumulates if that money is banked.
//!
//! WHY THIS CHILD EXISTS, and why the boundary sits here. ADR 0112's 1,000-code-line
//! test gate reddened `db/tests/advise.rs` at 1,042 once the bank's own cases landed,
//! and the sanctioned answer is a subject split and never a threshold edit. The subject
//! boundary is real and not a line-count convenience: `super::advise` owns the ARM ORDER
//! and the arms — which door answers first, and what it answers — while this child owns
//! one WRITE and the one guard it feeds, the running total `workflow_runs.cost_usd` and
//! the ceiling read of it. The two subjects fail differently: a wrong arm order still
//! returns `advance: false`, whereas a missing bank leaves every arm answering correctly
//! about a number that never moved. The nine fixtures these two children share live in
//! [`super::support`] for exactly that reason — more than one subject child reads them.
//!
//! THE DEFECT THIS CHILD EXISTS FOR, in one line: arm 6 is the only writer of
//! `cost_usd` and it is the LAST arm, so every settle on a fully-claimed chain — the
//! NORMAL path, where the claim's launch already took the link — returned at arm 3 and
//! discarded its figure. `cost_usd` stayed `NULL` for the life of a healthy chain,
//! `banked` was always `None`, and the ceiling compared each link's OWN spend: a
//! 20-step chain at $10 a link spent $200 under a $10 ceiling and never named it. A
//! ceiling that is evaluated but never accumulates is as inert as one that is never
//! evaluated.
//!
//! The four edges this child pins are the bank itself, the `None` that must never fold
//! (ADR 0082's phantom zero), two deltas ACCUMULATING, and the ceiling tripping on the
//! ACCUMULATED figure — the last being the only assertion in the tree that can tell
//! "the ceiling is evaluated" apart from "the ceiling is evaluated against the right
//! number", and the one that reddens if the bank is removed.

use crate::storage::db::ChainStop;

use super::support::*;

// ── the settled COST on the early-return arms (the ceiling's accumulation) ─────
//
// The ceiling is a read of the run's banked figure, so it can only ever see money
// some earlier arm BANKED. Arm 6 (`workflow_run_step_on`) is the only write that
// banks, and arms 1, 3, 4 and 5 all return ahead of it — so on a fully-claimed chain,
// the NORMAL path where the claim's launch already took the link, every settle
// returned at arm 3 and threw its delta away. `cost_usd` stayed `NULL` forever,
// `banked` was always `None`, and arm 2 compared each link's OWN spend against the
// ceiling: a 20-step chain at $10 a link spent $200 against a $10 ceiling and never
// tripped it. These tests own the fix and its four edges: banked-but-not-stepped,
// `None` never folds, two settles accumulate, and the accumulated figure is what
// trips.

/// **THE BUG PIN — the ceiling trips on ACCUMULATED spend.** Two links, $6 each, a
/// $10 ceiling. Neither link's own figure reaches $10, so under the defect this chain
/// runs to its step bound with a $10 ceiling configured and never once names the
/// ceiling; with the settle's delta banked, the second settle compares $6 banked + $6
/// and stops.
///
/// This is the only test in the file that can distinguish "the ceiling is evaluated"
/// from "the ceiling is evaluated against the right number", and it is the one that
/// fails if the bank is removed. Every other ceiling test here hands arm 2 a figure an
/// earlier `workflow_run_step` call banked by hand, which the defect survives because
/// it is the SETTLE path that loses the delta, not the step verb.
#[test]
fn the_ceiling_trips_on_the_chains_accumulated_spend_and_not_on_one_links_own() {
    let (_dir, db, space, task_id) = fixture("adv-accumulate");
    db.set_auto_guards(&space, Some(20), Some(10.0))
        .expect("a $10 ceiling, a step bound nobody here reaches");
    set_auto(&db, &space, "backlog", true);

    // Link 1 claims and is answered: the step verb opens the run with `cost_usd` NULL.
    linked(&db, "s-link1", &task_id, "backlog");
    db.set_session_ready("s-link1", Some(true), None)
        .expect("claim");
    assert!(advice(&db, "s-link1", None, None).advance);
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, None)),
        "the run opens UNBILLED — nothing has reported a figure yet"
    );

    // The launch succeeds, so link 1's settle returns at arm 3 — the normal path.
    linked(&db, "s-link2", &task_id, "research");
    let settle = advice(&db, "s-link1", None, Some(6.0));
    assert_eq!(settle.reason, "already_advanced");
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, Some(6.0))),
        "the $6 is banked and NO second step is bought"
    );

    // Link 2 claims and advances. $6 banked against a $10 ceiling is still under it,
    // so arm 2 must NOT stop this link — an over-eager bank would fail the chain shut.
    set_auto(&db, &space, "research", true);
    db.set_session_ready("s-link2", Some(true), None)
        .expect("claim");
    let second = advice(&db, "s-link2", None, None);
    assert!(
        second.advance,
        "reason was {:?} — $6 banked is under a $10 ceiling, so the chain continues",
        second.reason
    );
    assert_eq!(
        run_row(&db, &task_id),
        Some((2, Some(6.0))),
        "link 2 buys its step and inherits the banked figure untouched (`None` folds \
         nothing — ADR 0082)"
    );

    // Link 2's launch succeeds, and link 2 settles carrying its own $6. $6 + $6 is
    // over the ceiling, and ONLY the accumulation makes that visible.
    linked(&db, "s-link3", &task_id, "approved");
    let settled = advice(&db, "s-link2", None, Some(6.0));
    assert!(
        !settled.advance,
        "two $6 links against a $10 ceiling must stop the chain"
    );
    assert_eq!(
        settled.reason, "cost_ceiling",
        "`already_advanced` here means the ceiling never saw the first link's $6 — \
         the arm-3 bank was removed, and the ceiling is inert on the happy path again"
    );
    assert_eq!(settled.stop, Some(ChainStop::CostCeiling));
    assert_eq!(
        settled.ceiling_usd,
        Some(10.0),
        "the ceiling the caller may quote alongside the sentence"
    );
    assert!(
        settled.already_launched,
        "the dedupe READ rides the stop, so Task 4 does not close a run the next link \
         still needs — closing would reset the accumulated $6 the ceiling just read"
    );
    assert_eq!(
        run_row(&db, &task_id),
        Some((2, Some(6.0))),
        "and the ceiling arm still writes NOTHING: it is a read of money already spent, \
         and a stop arm that folded its own delta in would charge a link it refused"
    );
}

/// **`None` never folds, on the arm that now banks.** A settle with no figure leaves
/// `cost_usd` `NULL`, not `0.0`.
///
/// `COALESCE(cost_usd, 0.0) + 0.0` turns "no Session in this chain ever reported a
/// figure" into "this chain spent exactly nothing", and that permanently ARMS a ceiling
/// written to stay unarmed until money appears — a $0.00 ceiling would then trip a
/// chain that reported nothing, which is `AdvanceVerdict::ceiling_usd`'s documented
/// limitation reversed into a fail-SHUT. This is ADR 0082 verbatim, restated at
/// `decide`'s `cost_delta_usd` parameter and at `workflow_run_step_on`'s `None` arm;
/// this is the pin for the third write site that rule governs.
#[test]
fn a_settled_cost_of_none_leaves_the_runs_figure_null_and_never_arms_the_ceiling() {
    let (_dir, db, space, task_id) = fixture("adv-bank-none");
    db.set_auto_guards(&space, Some(20), Some(0.0)).expect(
        "a $0.00 ceiling: it trips on ANY banked figure, so it is the sharpest \
                 probe of a phantom zero",
    );
    set_auto(&db, &space, "backlog", true);
    linked(&db, "s-bank-none", &task_id, "backlog");
    db.set_session_ready("s-bank-none", Some(true), None)
        .expect("claim");
    assert!(advice(&db, "s-bank-none", None, None).advance);
    linked(&db, "s-launched", &task_id, "research");

    let a = advice(&db, "s-bank-none", None, None);
    assert_eq!(a.reason, "already_advanced");
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, None)),
        "`cost_usd` is STILL NULL — the `None` delta folded nothing at all"
    );
    assert!(
        a.advance || a.reason != "cost_ceiling",
        "a chain that reported NO figure must not trip a $0.00 ceiling"
    );

    // And a REAL figure on the next ask does exactly what the `None` one could not:
    // it arms the ceiling, on the first cent.
    let b = advice(&db, "s-bank-none", None, Some(0.01));
    assert_eq!(
        b.reason, "cost_ceiling",
        "the ceiling was unarmed, not armed-with-zero — the first real figure is what \
         armed it (`{:?}`)",
        b.reason
    );
}

/// **Two settles accumulate.** The ceiling's whole purpose is a chain's TOTAL spend,
/// so two links' deltas must add rather than the second overwriting the first.
///
/// `cost_usd = COALESCE(cost_usd, 0.0) + ?` is the statement `workflow_run_step_on`
/// uses for the same reason, and the bank reuses it deliberately: two spellings of a
/// running total is a total that can be computed two ways.
#[test]
fn two_settled_deltas_accumulate_on_the_open_run() {
    let (_dir, db, space, task_id) = fixture("adv-bank-accumulate");
    set_auto(&db, &space, "backlog", true);
    linked(&db, "s-first", &task_id, "backlog");
    db.set_session_ready("s-first", Some(true), None)
        .expect("claim");
    assert!(advice(&db, "s-first", None, None).advance);
    linked(&db, "s-second", &task_id, "research");

    advice(&db, "s-first", None, Some(1.25));
    assert_eq!(run_row(&db, &task_id), Some((1, Some(1.25))));

    // The next link claims, advances, and settles with its own delta.
    set_auto(&db, &space, "research", true);
    db.set_session_ready("s-second", Some(true), None)
        .expect("claim");
    assert!(advice(&db, "s-second", None, None).advance);
    linked(&db, "s-third", &task_id, "approved");
    let settled = advice(&db, "s-second", None, Some(2.5));
    assert_eq!(settled.reason, "already_advanced");

    let (steps, cost) = run_row(&db, &task_id).expect("the run is still open");
    assert_eq!(
        (steps, cost),
        (2, Some(3.75)),
        "1.25 + 2.5 = 3.75 banked across two settles, and `steps` is the two STEPS \
         the two links actually bought — the bank never touches the step counter, \
         which is the primary guard against exactly this kind of double-charge"
    );
}

/// **A non-auto column's settle banks too.** Arm 4 returns ahead of arm 6 carrying a
/// real delta, and a non-auto column is where a chain ENDS — so its last link's money
/// was the money the audit record never showed.
///
/// The chain stops here either way; what the bank changes is whether the closed run's
/// `cost_usd` is the truth. `cost_usd` is the audited fact — `workflow_run_step_on`
/// calls it that when it chooses which of two bounds to report — and a chain that
/// stopped in a human column while reporting `NULL` is a chain whose spend nobody can
/// reconstruct afterwards.
#[test]
fn a_settle_on_a_non_auto_column_banks_its_cost_without_spending_a_step() {
    let (_dir, db, space, task_id) = fixture("adv-bank-non-auto");
    // `backlog` stays NOT auto — the seed leaves every column off, and that is the case.
    claim(&db, "s-bank-nonauto", &task_id, "backlog");
    // A chain IS in flight: a previous link's step opened the run.
    db.workflow_run_step(&space, &task_id, None)
        .expect("open the run this settle's money belongs to");
    assert_eq!(run_row(&db, &task_id), Some((1, None)));

    let a = advice(&db, "s-bank-nonauto", None, Some(4.0));
    assert_eq!(a.reason, "not_automatic", "the policy answer is unchanged");
    assert!(a.stop.is_none());
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, Some(4.0))),
        "the $4 is banked on the run the chain left open, and `steps` did NOT move — \
         a non-auto column buys no launch, so it may not be charged for one"
    );
}

/// **A no-destination column's settle banks too.** Arm 5, same argument as arm 4: the
/// chain ends here, and the run's final figure should be its final figure.
#[test]
fn a_settle_with_no_next_stage_banks_its_cost_without_spending_a_step() {
    let (_dir, db, space, task_id) = fixture("adv-bank-no-next");
    set_auto(&db, &space, "backlog", true);
    set_edges(&db, &space, "backlog", &[], &[]);
    claim(&db, "s-bank-nonext", &task_id, "backlog");
    db.workflow_run_step(&space, &task_id, None)
        .expect("open the run this settle's money belongs to");

    let a = advice(&db, "s-bank-nonext", None, Some(3.0));
    assert_eq!(a.reason, "no_next_stage");
    assert_eq!(a.stop, Some(ChainStop::NoNextStage));
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, Some(3.0))),
        "banked, and still one step"
    );
}

/// **Arm 1 is EXCLUDED from the bank, deliberately.** A Session that never claimed is
/// not a participant in the chain by its own account, and its money must not be
/// charged against a ceiling it never joined.
///
/// Every other banked arm sits BEHIND the claim door: `unclaimed` is the only arm a
/// Session reaches without having said it was done. A person who starts their own
/// Session on a card that has a chain in flight would otherwise spend that chain's
/// budget with their own money, and the direction of that error is the one
/// `costDeltaOf` refuses on the frontend and `AdvanceVerdict::ceiling_usd` refuses in
/// Rust: a ceiling that fires on money the chain did not spend FAILS SHUT on a chain
/// that was within budget. Under-counting is the accepted direction here, and it is
/// documented as such rather than discovered.
///
/// Arm 1 also has the weakest claim on the money in the first place: whether an open
/// run exists at all is a fact about some OTHER Session's step, not about this one.
#[test]
fn a_settle_that_never_claimed_banks_nothing_and_says_so() {
    let (_dir, db, space, task_id) = fixture("adv-bank-unclaimed");
    set_auto(&db, &space, "backlog", true);
    linked(&db, "s-bystander", &task_id, "backlog");
    // A chain IS in flight on this card, opened by a link other than this Session's.
    db.workflow_run_step(&space, &task_id, None)
        .expect("open the chain's run");

    let a = advice(&db, "s-bystander", None, Some(9.0));
    assert_eq!(a.reason, "unclaimed");
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, None)),
        "`cost_usd` is untouched: this Session never claimed, so it is not a link of \
         this chain and its $9 is not this ceiling's money"
    );
}

/// **The bank never OPENS a run.** An `UPDATE` scoped to the open row, not the step
/// verb's upsert: a card that never chained must not gain a chain record because a
/// Session on it settled with a figure, and a run opened by a bank would hand the
/// FIRST real step an inherited figure instead of opening fresh.
///
/// This is the family's standing `Ok`-on-absence leniency (`workflow_run_close`'s
/// silent no-op on zero open runs, and its argument), applied to the one write that
/// could otherwise manufacture the bookkeeping it is supposed to be recording.
#[test]
fn banking_a_cost_never_opens_a_run_for_a_card_that_never_chained() {
    let (_dir, db, space, task_id) = fixture("adv-bank-no-run");
    // No step verb ever runs, so no run exists.
    set_auto(&db, &space, "backlog", true);
    set_edges(&db, &space, "backlog", &[], &[]);
    claim(&db, "s-no-run", &task_id, "backlog");

    let a = advice(&db, "s-no-run", None, Some(5.0));
    assert_eq!(a.reason, "no_next_stage");
    assert_eq!(
        run_row(&db, &task_id),
        None,
        "NO run was opened — the bank is an `UPDATE` on the open row and a no-op when \
         there is none, so a chain that never started still has no record and its \
         first real step still opens at `cost_usd` NULL"
    );

    // And the arm still answers correctly with nothing to bank onto.
    assert_eq!(a.stop, Some(ChainStop::NoNextStage));
    assert_eq!(a.task_id.as_deref(), Some(task_id.as_str()));
}

/// **IDEMPOTENCY, and where it actually comes from.** A re-ask on a link whose money
/// was already banked carries `None` and folds NOTHING, so the accumulated figure is
/// unchanged and the ceiling cannot be armed against a chain's own spend.
///
/// WHAT WAS DETERMINED about the delta, rather than assumed. `costDeltaOf` computes it
/// from a before-turn snapshot and the Session figure at settle, because
/// `sessions.cost_usd` is a RUNNING TOTAL — so the argument `decide` receives is a
/// PER-TURN delta and never a cumulative one (feeding a total into an additive column
/// would sum the totals and fire the ceiling early, which is that function's own stated
/// reason for existing). And a turn settles ONCE: `advanceWorkflowChainOnSettle` is
/// called once per settled turn, from one place. But `asking_twice_about_a_stop_arm_
/// spends_nothing_extra` already concedes this verb CAN be asked twice — a retry, a
/// re-render — and a second ask reads the SAME before-snapshot and the SAME unchanged
/// figure, so `after − before` is `0`, and `costDeltaOf` answers `null` for a flat total
/// precisely so that "a chain must not be able to arm its ceiling against itself by
/// arithmetic".
///
/// So the bank is additive and NOT idempotent at the SQL level — `COALESCE(cost, 0) + ?`
/// adds whatever it is handed, exactly as `workflow_run_step_on`'s cost arm does, and
/// that verb has never been idempotent either (`a_refused_launch_spends_a_second_step_
/// and_that_is_the_decision` pins a deliberate double-charge). What makes a double
/// delivery harmless is the `None` that rides it.
///
/// STATED HONESTLY, because AGENTS.md refuses a pin that passes on the broken thing:
/// THIS test does not own the `is_some()` guard and cannot. On a row whose figure is
/// already `Some(6.0)`, folding a mutant `0.0` computes `6.0 + 0.0 = 6.0` and every
/// assertion below still holds — measured, by replacing that guard with
/// `unwrap_or(0.0)` and watching only `a_settled_cost_of_none_leaves_the_runs_figure_
/// null_and_never_arms_the_ceiling` go red. That test is the guard's pin, and it has
/// teeth precisely because it probes a `NULL` column, where the mutant writes a `0.0`
/// that is observably not `NULL` and arms a $0.00 ceiling. What this test owns is the
/// narrower and still-real claim: the ACCUMULATED figure does not move when the same
/// link is asked twice.
#[test]
fn re_asking_a_link_that_was_already_banked_adds_nothing() {
    let (_dir, db, space, task_id) = fixture("adv-bank-reask");
    db.set_auto_guards(&space, Some(20), Some(10.0))
        .expect("a $10 ceiling, so a double-bank WOULD change the answer");
    set_auto(&db, &space, "backlog", true);
    linked(&db, "s-reask", &task_id, "backlog");
    db.set_session_ready("s-reask", Some(true), None)
        .expect("claim");
    assert!(advice(&db, "s-reask", None, None).advance);
    linked(&db, "s-launched", &task_id, "research");

    // The settle, once, with its real per-turn delta.
    assert_eq!(
        advice(&db, "s-reask", None, Some(6.0)).reason,
        "already_advanced"
    );
    assert_eq!(run_row(&db, &task_id), Some((1, Some(6.0))));

    // …and asked again the way a re-delivery asks it: the same turn, so the same
    // before/after pair, so `costDeltaOf` answers `null`.
    let again = advice(&db, "s-reask", None, None);
    assert_eq!(again.reason, "already_advanced");
    assert_eq!(
        run_row(&db, &task_id),
        Some((1, Some(6.0))),
        "STILL $6.00 — a second ask folded nothing. If this reads $12.00 the bank has \
         become non-idempotent against a re-render, and a $10 ceiling would then stop a \
         chain that spent $6"
    );
    assert!(
        again.reason != "cost_ceiling",
        "and the ceiling has not been armed by the re-ask itself"
    );
}
