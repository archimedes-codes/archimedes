//! Tests for `db/workflow_runs.rs`: the `workflow_runs` record an auto-advance
//! chain counts itself against (its table and partial index, the open / step /
//! close verbs, the NULL-cost accumulation rule, the per-Task scope and the
//! one-open-run-per-chain semantics), and the `AdvanceVerdict` bound judgement the
//! step verb answers with.
//!
//! This child is the mirror of `db/workflow_runs.rs`, and the line the split of the
//! old `workflows` child draws here is between the RECORD and the JUDGEMENT over it:
//! this file owns the row's lifecycle and the arithmetic that decides `advance`,
//! while the guard READ that feeds that decision — the key rule, the projection,
//! the NULL-is-not-zero read and the two fallback constants — is pinned beside its
//! own production sibling in [`super::auto_guards`].

use crate::storage::db::*;

use super::support::*;

// ── `workflow_runs`: the record a chain counts itself against ───────────────
/// (the new table) a fresh database gets `workflow_runs` whole from `SCHEMA`,
/// plus the PARTIAL index that makes "the open run for this Task" one lookup.
///
/// Three things are pinned and each is a decision:
///   - the projection's columns, so a later one added here is invisible to no one;
///   - the index's `WHERE finished_at IS NULL`, because a plain index on
///     `task_id` would be a second, larger copy of the PK's job while the partial
///     one is exactly the "at most one OPEN run per Task" lookup;
///   - the ABSENCE of a foreign key, for ADR 0090/0100's reason: closing a Space
///     tab runs `delete_space`, and a run record that cascaded away with the tab
///     would erase the money a person is trying to audit.
#[test]
fn a_fresh_database_has_the_workflow_runs_table_and_its_open_index() {
    let (_dir, db, _space) = seeded("runs-ddl");

    let ddl = raw_column(
        &db,
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'",
    )
    .into_iter()
    .next()
    .expect("the workflow_runs DDL is present on a fresh database");
    for column in [
        "id",
        "space_path",
        "task_id",
        "started_at",
        "finished_at",
        "steps",
        "cost_usd",
        "stop_reason",
    ] {
        assert!(
            ddl.contains(column),
            "the workflow_runs DDL must declare `{column}`; got {ddl}"
        );
    }
    assert!(
        ddl.contains("steps INTEGER NOT NULL DEFAULT 0"),
        "`steps` is NOT NULL with a 0 default, so the counter is an integer and \
         never a NULL to add to; got {ddl}"
    );
    assert!(
        !ddl.contains("REFERENCES"),
        "`workflow_runs` carries NO foreign key (ADR 0090/0100): a run record that \
         cascaded away when a Space tab closed would erase the spend a person is \
         auditing; got {ddl}"
    );

    let index = raw_column(
        &db,
        "SELECT sql FROM sqlite_master WHERE type = 'index' \
         AND name = 'idx_workflow_runs_open'",
    )
    .into_iter()
    .next()
    .expect("the partial index on the OPEN run is present");
    assert!(
        index.contains("task_id"),
        "the index is keyed on `task_id` — the run lookup is by Task; got {index}"
    );
    assert!(
        index.contains("WHERE finished_at IS NULL"),
        "and it is PARTIAL on the open arm, which is the only shape the runtime \
         reads; got {index}"
    );
    assert!(
        index.contains("UNIQUE"),
        "and it is UNIQUE — `workflow_run_step` reads ONE open row per Task and \
         `workflow_run_step` counts a chain against whatever that read finds, so a \
         second open row would count the chain against a stranger's steps and spend \
         (the bound failing OPEN). A plain index states this invariant and enforces \
         nothing; got {index}"
    );
}

/// (`workflow_run_step` opens the chain) the FIRST step of a chain INSERTS a run
/// with one step, a minted `wfr_` id, no cost and no end, and the open row the
/// test reads back through raw SQL is that same row.
#[test]
fn workflow_run_step_opens_a_run_with_one_step_and_no_cost() {
    let (_dir, db, space) = seeded("runs-open");
    let task = db
        .create_task(&space, "the chained card", None, None)
        .expect("create_task");

    // `.run` because the verb now answers a verdict: the row is one field of the
    // answer, not the whole answer. The assertions below are UNCHANGED — the row
    // this test pins is the row it always pinned, and the verdict's guard fields
    // are pinned by their own tests further down this file and, for the shipped
    // fallbacks, in the `super::auto_guards` child.
    let run = db
        .workflow_run_step(&space, &task.id, None)
        .expect("the first step opens a run")
        .run;

    assert!(
        run.id.starts_with("wfr_"),
        "the id follows the house mint (`tsk_…` in `create_task`); got {}",
        run.id
    );
    assert_eq!(run.space_path, space);
    assert_eq!(run.task_id, task.id);
    assert_eq!(run.steps, 1, "the first step is one step, not zero");
    assert_eq!(
        run.cost_usd, None,
        "no delta reported means no figure yet — NOT 0.0 (ADR 0082)"
    );
    assert_eq!(run.finished_at, None, "the run is OPEN");
    assert_eq!(run.stop_reason, None, "and has not stopped");
    assert!(run.started_at > 0, "and it carries its own start stamp");

    // Read back through raw SQL (`open_run_row`) rather than a `Db` verb: the
    // question is what the DATABASE holds for that card, and the verb that used to
    // answer it was deleted as dead IPC. The id is what ties the two views together,
    // and the counters are what a chain is actually counted on.
    let open = open_run_row(&db, &task.id).expect("the run just opened is the open run");
    assert_eq!(
        (open.0.as_str(), open.1, open.2),
        (run.id.as_str(), run.steps, run.cost_usd),
        "the stored row is the row the verdict returned"
    );
}

/// (`workflow_run_step` is the upsert) every later step adds ONE to the SAME
/// open run, and never a second row.
#[test]
fn workflow_run_step_increments_the_open_run_and_never_opens_a_second() {
    let (_dir, db, space) = seeded("runs-step");
    let task = db
        .create_task(&space, "three steps deep", None, None)
        .expect("create_task");

    let first = db
        .workflow_run_step(&space, &task.id, None)
        .expect("step 1")
        .run;
    let second = db
        .workflow_run_step(&space, &task.id, None)
        .expect("step 2")
        .run;
    let third = db
        .workflow_run_step(&space, &task.id, None)
        .expect("step 3")
        .run;

    assert_eq!(
        (second.steps, third.steps),
        (2, 3),
        "the returned row is the state AFTER the write, which is what the runtime \
         compares against the step bound"
    );
    assert_eq!(
        third.id, first.id,
        "one chain, one row — the second and third steps must not mint a new id"
    );
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM workflow_runs WHERE task_id = '{}'",
                task.id
            )
        ),
        1,
        "and the table holds exactly one row for the card"
    );
}

/// (the NULL-cost rule, the subtlest thing here) `NULL + x` in SQL is `NULL`, so
/// a naive accumulate would freeze the counter at NULL forever and the ceiling
/// would never trip.
///
/// The sequence is the one that catches it: a step that reports no figure, THEN a
/// step that reports one. The first non-`None` delta must SET the column; later
/// ones must ADD; and a later `None` must leave the stored figure alone rather
/// than erase it.
#[test]
fn workflow_run_step_keeps_cost_null_until_the_first_figure_and_adds_after() {
    let (_dir, db, space) = seeded("runs-cost");
    let task = db
        .create_task(&space, "a chain that reports late", None, None)
        .expect("create_task");

    // Every `.run` below: the verb answers a verdict now and the cost rule this
    // test pins lives on the row inside it. Nothing about the assertions changes —
    // the write arms are the same write arms.
    let opened = db
        .workflow_run_step(&space, &task.id, None)
        .expect("a step with no figure yet")
        .run;
    assert_eq!(opened.cost_usd, None, "opened with no figure");

    let after = db
        .workflow_run_step(&space, &task.id, Some(0.5))
        .expect("the first figure must SET, not add to NULL")
        .run;
    assert_eq!(
        after.cost_usd,
        Some(0.5),
        "a NULL column plus a reported figure is the figure — a SQL `cost_usd + \
         ?1` would answer NULL here and the ceiling would never trip"
    );

    let added = db
        .workflow_run_step(&space, &task.id, Some(0.25))
        .expect("a later figure ADDS")
        .run;
    let summed = added.cost_usd.expect("the running figure is stored");
    assert!(
        (summed - 0.75).abs() < 1e-12,
        "0.5 + 0.25 accumulates to 0.75, got {summed}"
    );

    let quiet = db
        .workflow_run_step(&space, &task.id, None)
        .expect("a step that reports nothing")
        .run;
    assert_eq!(
        quiet.cost_usd,
        Some(0.75),
        "a `None` delta never erases and never re-NULLs what is stored"
    );
    assert_eq!(quiet.steps, 4, "while the step counter still moved");
}

/// (`workflow_run_close`) the close stamps `finished_at` and the reason on the
/// OPEN run, and the open read stops answering for it.
#[test]
fn workflow_run_close_stamps_the_end_and_the_reason_on_the_open_run() {
    let (_dir, db, space) = seeded("runs-close");
    let task = db
        .create_task(&space, "one chain, closed", None, None)
        .expect("create_task");

    let opened = db
        .workflow_run_step(&space, &task.id, Some(0.1))
        .expect("open a run")
        .run;
    // An ARBITRARY, non-vocabulary value — on purpose, and it is NOT an example of
    // what the column should hold. This test pins that `workflow_run_close` stores
    // the caller's word VERBATIM, and the sharpest way to pin a pass-through is a
    // string that could not have been cleaned, validated or normalised into place by
    // accident. The real vocabulary is `ChainStop::as_str()` plus `"manual"`,
    // `"interrupted"` and a verbatim `StopReason`; the tests around this one use
    // those spellings so the fixtures teach the vocabulary rather than a fiction.
    db.workflow_run_close(&task.id, "a_string_no_producer_emits")
        .expect("close it");

    assert_eq!(
        open_run_row(&db, &task.id),
        None,
        "a closed run is not the open run — the next step opens a NEW one"
    );

    // The record survives the close: it is ENDED, not deleted, because a run a
    // person cannot read after it stopped is not an observable chain.
    let (finished, reason, steps, cost) = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT finished_at, stop_reason, steps, cost_usd FROM workflow_runs \
             WHERE task_id = ?1",
            rusqlite::params![task.id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                ))
            },
        )
        .expect(
            "the closed row is still there — a close ENDS a run, it does not \
                 delete the record",
        );
    assert!(
        finished.unwrap_or(0) >= opened.started_at,
        "the end stamp is a real clock value at or after the start, got \
         {finished:?} vs {}",
        opened.started_at
    );
    assert_eq!(
        reason.as_deref(),
        Some("a_string_no_producer_emits"),
        "the column holds the caller's word UNEDITED — no validation, no case \
         folding, no normalisation"
    );
    assert_eq!(steps, 1, "the close does not touch the counters");
    assert_eq!(cost, Some(0.1), "nor the figure");
}

/// (`workflow_run_close` on nothing) zero open runs is a silent `Ok(())` — the
/// `record_session_cost` shape: a chain that never opened a run, and a chain that
/// was already closed, are both ordinary.
#[test]
fn workflow_run_close_on_no_open_run_is_a_silent_no_op() {
    let (_dir, db, space) = seeded("runs-close-noop");
    let task = db
        .create_task(&space, "never chained", None, None)
        .expect("create_task");

    db.workflow_run_close(&task.id, "manual")
        .expect("closing a Task with no run at all is Ok");
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM workflow_runs WHERE task_id = '{}'",
                task.id
            )
        ),
        0,
        "and it inserted nothing"
    );

    // And a SECOND close of a closed run: still `Ok`, and the first close's
    // reason survives — the `WHERE finished_at IS NULL` arm is what makes a
    // repeated close a no-op rather than a rewrite of why the chain stopped.
    db.workflow_run_step(&space, &task.id, None)
        .expect("open one");
    db.workflow_run_close(&task.id, "cost_ceiling")
        .expect("close it once");
    db.workflow_run_close(&task.id, "manual")
        .expect("closing twice is Ok");
    assert_eq!(
        raw_column(
            &db,
            &format!(
                "SELECT stop_reason FROM workflow_runs WHERE task_id = '{}'",
                task.id
            )
        )
        .first()
        .map(String::as_str),
        Some("cost_ceiling"),
        "the first reason is the record"
    );
}

/// (run semantics: one OPEN run per Task, chains are sequential) after a close,
/// the next step opens a NEW run and counts from one again — so a card that
/// auto-advances twice in a day is TWO bounded runs, not one unbounded one.
#[test]
fn a_new_chain_after_a_close_opens_a_second_run_counting_from_one() {
    let (_dir, db, space) = seeded("runs-second");
    let task = db
        .create_task(&space, "two chains", None, None)
        .expect("create_task");

    db.workflow_run_step(&space, &task.id, Some(1.0))
        .expect("chain 1 opens");
    db.workflow_run_step(&space, &task.id, Some(1.0))
        .expect("chain 1 steps");
    db.workflow_run_close(&task.id, "max_steps")
        .expect("chain 1 closes at its bound");

    let second = db
        .workflow_run_step(&space, &task.id, Some(0.25))
        .expect("chain 2 opens")
        .run;
    assert_eq!(
        second.steps, 1,
        "the new chain counts from one — the bound is per chain, not per card"
    );
    assert_eq!(
        second.cost_usd,
        Some(0.25),
        "and its figure starts from its own first delta, not the previous run's"
    );
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM workflow_runs WHERE task_id = '{}'",
                task.id
            )
        ),
        2,
        "both runs are recorded, which is what makes a chain observable"
    );
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM workflow_runs \
                 WHERE task_id = '{}' AND finished_at IS NULL",
                task.id
            )
        ),
        1,
        "and AT MOST ONE is open — the invariant the partial index encodes"
    );
}

/// (runs are per Task) a step on one card neither opens nor advances another
/// card's run — the same scoping question `get_board`'s link statement asks.
#[test]
fn a_run_is_scoped_to_its_task_and_never_another_cards() {
    let (_dir, db, space) = seeded("runs-scope");
    let one = db
        .create_task(&space, "first card", None, None)
        .expect("create_task");
    let two = db
        .create_task(&space, "second card", None, None)
        .expect("create_task");

    db.workflow_run_step(&space, &one.id, Some(0.5))
        .expect("card one steps");

    assert_eq!(open_run_row(&db, &two.id), None, "card two has no open run");
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM workflow_runs WHERE task_id = '{}'",
                two.id
            )
        ),
        0,
        "and no row at all"
    );

    // Closing card one leaves card two untouched, and vice versa.
    db.workflow_run_close(&one.id, "cost_ceiling")
        .expect("close one");
    db.workflow_run_close(&two.id, "cost_ceiling")
        .expect("closing the card with nothing open is Ok");
    assert_eq!(
        raw_scalar(
            &db,
            "SELECT COUNT(*) FROM workflow_runs WHERE finished_at IS NULL"
        ),
        0,
        "nothing is left open"
    );
}

// ── The verdict: what the step verb ANSWERS with ─────────────────────────────
//
// `workflow_run_step` used to answer a row and leave the bound question to its
// caller. The caller is TypeScript and the two numbers the question needs
// (`DEFAULT_AUTO_MAX_STEPS`, `DEFAULT_AUTO_CEILING_USD`) are Rust-only on purpose
// — deliberately not copied into the TypeScript mirror for exactly the reason this
// section exists: a policy number duplicated across the wire is a policy number
// that drifts. So the decision is made HERE, beside the constants it reads, and
// the caller is handed the verdict plus the EFFECTIVE bounds it was computed
// from, so it can say "this chain hit its 20-step bound" without re-deriving 20.
/// (the bound decides, and the effective bound rides along) a configured step
/// bound stops the chain, and the verdict names the bound it stopped it AT.
///
/// `maxSteps` on the verdict is not a convenience: the caller cannot compute it,
/// because it does not know the fallback. A verdict that said only "no" would
/// leave the settle-handler unable to write the sentence that tells a person WHY
/// their chain stopped.
///
/// THE ARITHMETIC IS `max_steps` ADVANCES, so the third step of a chain bounded to
/// 2 is the one refused. `AutoGuards::max_steps` and `ChainStop::MaxSteps` both
/// promise "how many auto-advances ONE chain may take", and `advance` is read
/// AFTER the step is recorded as the permission to launch the NEXT Session — so a
/// bound read as `>=` against the post-increment counter would authorise
/// `max_steps − 1` moves and a bound of 1 would move nothing at all while the
/// transcript said it had reached its 1-step bound. The third assertion below is
/// the tooth: a `>=` regression stops the chain one launch early and reddens here.
#[test]
fn the_verdict_stops_the_chain_at_the_configured_step_bound_and_reports_it() {
    let (_dir, db, space) = seeded("verdict-steps");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_auto_guards(&space, Some(2), None)
        .expect("a two-step bound");
    let task = db
        .create_task(&space, "a card on a two-step chain", None, None)
        .expect("create_task");

    let first = db
        .workflow_run_step(&space, &task.id, None)
        .expect("the first step");
    assert!(
        first.advance,
        "one step into a two-step chain, the chain may continue"
    );
    assert_eq!(first.stop, None, "and nothing stopped it");
    assert_eq!(
        first.max_steps, 2,
        "the verdict names the bound it applied — the configured one, not the fallback"
    );
    assert_eq!(first.run.steps, 1, "and carries the row AFTER the write");

    let second = db
        .workflow_run_step(&space, &task.id, None)
        .expect("the second step");
    assert!(
        second.advance,
        "the bound is HOW MANY AUTO-ADVANCES the chain may take, so a bound of 2 \
         permits a SECOND launch (`advance` here is the permission to make it). A \
         bound compared `>=` against this post-increment counter would refuse here \
         and deliver ONE advance from a bound of 2."
    );
    assert_eq!(second.stop, None, "and the second step stopped nothing");
    assert_eq!(second.run.steps, 2, "the row is the state after the write");

    let third = db
        .workflow_run_step(&space, &task.id, None)
        .expect("the third step");
    assert_eq!(
        (third.advance, third.stop),
        (false, Some(ChainStop::MaxSteps)),
        "the step that takes `steps` PAST the bound is the step that ends the \
         chain: a bound of 2 permits two advances and refuses the third launch"
    );
    assert_eq!(
        third.max_steps, 2,
        "and the bound it cites is the one the Space configured"
    );
    assert_eq!(
        third.run.steps, 3,
        "the refused step is recorded too (the tripping step is written before the \
         verdict refuses — see the test after this one)"
    );
}

/// (the step that ends the chain is STILL a step) the verdict refuses the next
/// launch and the record keeps the step that tripped the bound anyway.
///
/// This is the difference between a run that reports its own length and one that
/// under-reports it: a chain stopped at a bound of 1 whose row says `steps = 0`
/// tells the next reader the chain never happened, and the spend recorded beside it
/// is the spend of a chain that did not happen. The write
/// happens first and the guard is read AFTER it, deliberately — the verb records
/// what occurred and then answers whether it may occur again.
///
/// The bound is 1 because that is the shape where the ordering is cheapest to lose:
/// under the documented arithmetic a bound of 1 permits EXACTLY ONE advance, so the
/// tripping step is the SECOND one and a `>=` regression would refuse the first step
/// instead — recording 1 where this pins 2, and refusing a chain that had spent
/// nothing.
#[test]
fn the_step_that_trips_the_bound_is_written_before_the_verdict_refuses_the_next_one() {
    let (_dir, db, space) = seeded("verdict-write");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_auto_guards(&space, Some(1), None)
        .expect("a one-step bound");
    let task = db
        .create_task(&space, "a card whose chain stops at one", None, None)
        .expect("create_task");

    let granted = db
        .workflow_run_step(&space, &task.id, Some(0.4))
        .expect("the one advance the bound permits");
    assert!(
        granted.advance,
        "a bound of 1 means ONE auto-advance is allowed, so the first step must \
         not be the one refused"
    );

    let tripped = db
        .workflow_run_step(&space, &task.id, Some(0.25))
        .expect("the step that trips the bound");
    assert!(
        !tripped.advance,
        "the step that takes `steps` past a bound of 1 is the one that refuses the \
         next launch"
    );
    assert_eq!(tripped.stop, Some(ChainStop::MaxSteps));

    // And the DATABASE holds the step. Asserted through raw SQL (`open_run_row`)
    // and not only through the verdict, because the verdict is a return value this
    // verb chose and the row is what an afterwards reader has.
    let (open_id, steps, cost) = open_run_row(&db, &task.id).expect(
        "the chain is still OPEN — a bound refuses the next launch, it does \
         not close the record",
    );
    assert_eq!(
        steps, 2,
        "the tripping step is recorded — the row reports its own length, not its \
         length minus one"
    );
    assert!(
        cost.is_some_and(|figure| (figure - 0.65).abs() < 1e-12),
        "with its figure (0.4 + 0.25), got {cost:?}"
    );
    assert_eq!(
        open_id, tripped.run.id,
        "and it is the row the verdict carries"
    );
}

/// (`NULL` ≠ `0`, at the gate) a bound of ZERO is a decision and stops the chain
/// on its FIRST step; the same Space with the guard CLEARED runs to the fallback.
///
/// The pair is the whole reason the fallback is a Rust constant and not a SQL
/// `DEFAULT`: `COALESCE(auto_max_steps, 0)` inside the guard read would make the
/// second half of this test stop on step one, i.e. "unset" and "switched off"
/// become the same answer, and every Space in the app silently loses its chain.
#[test]
fn a_configured_zero_bound_stops_the_first_step_where_an_unset_one_does_not() {
    let (_dir, db, zero) = seeded("verdict-zero");
    db.upsert_space(&zero, false).expect("upsert_space");
    db.set_auto_guards(&zero, Some(0), Some(5.0))
        .expect("a bound of zero is a setting, not a clear");
    let stopped = db
        .create_task(&zero, "a card in a Space with chaining off", None, None)
        .expect("create_task");

    let verdict = db
        .workflow_run_step(&zero, &stopped.id, None)
        .expect("the step still lands");
    assert!(
        !verdict.advance,
        "`max_steps = 0` means no auto-chaining, so the first step is refused"
    );
    assert_eq!(verdict.stop, Some(ChainStop::MaxSteps));
    assert_eq!(
        verdict.max_steps, 0,
        "and the verdict cites ZERO, not the fallback — a caller that rendered the \
         fallback here would tell the person their 20-step bound stopped them when \
         they had set zero"
    );
    assert_eq!(
        verdict.run.steps, 1,
        "the refused step is still recorded (the record is what happened, not what \
         was allowed)"
    );

    // The SAME Space with the guard CLEARED (`None`, i.e. NULL) is bounded by the
    // fallback and continues.
    db.set_auto_guards(&zero, None, Some(5.0))
        .expect("clear the bound, keep the ceiling");
    let other = db
        .create_task(
            &zero,
            "a card in the same Space after the clear",
            None,
            None,
        )
        .expect("create_task");
    let cleared = db
        .workflow_run_step(&zero, &other.id, None)
        .expect("the step after the clear");
    assert!(cleared.advance, "a CLEARED bound is not a zero bound");
    assert_eq!(cleared.max_steps, DEFAULT_AUTO_MAX_STEPS);
}

/// (the ceiling decides) a chain whose stored figure has REACHED the configured
/// ceiling stops, one below it continues, and the verdict carries the ceiling
/// either way.
///
/// `>=` and not `>`: a ceiling of $10 is a statement that $10 is the most this
/// chain may spend, and a chain sitting at $10.00 has no room for another Session.
/// The bound is a ceiling, not a floor.
#[test]
fn the_verdict_stops_the_chain_when_the_figure_reaches_the_configured_ceiling() {
    let (_dir, db, space) = seeded("verdict-ceiling");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_auto_guards(&space, Some(50), Some(1.0))
        .expect("a ceiling of $1 with a step bound far enough away not to interfere");

    // UNDER the ceiling: continues.
    let under = db
        .create_task(&space, "a cheap card", None, None)
        .expect("create_task");
    let verdict = db
        .workflow_run_step(&space, &under.id, Some(0.5))
        .expect("a step that reports half the ceiling");
    assert!(
        verdict.advance,
        "$0.50 of a $1.00 ceiling leaves room for another Session"
    );
    assert_eq!(
        verdict.ceiling_usd,
        Some(1.0),
        "and the verdict carries the configured ceiling so the caller can name it"
    );

    // AT the ceiling: stops. This is the `>=` half, and `>` would let one more
    // Session through on a chain that has already spent its stated maximum.
    let at = db
        .create_task(&space, "a card that exactly spends it", None, None)
        .expect("create_task");
    let verdict = db
        .workflow_run_step(&space, &at.id, Some(1.0))
        .expect("a step that spends the whole ceiling");
    assert_eq!(
        (verdict.advance, verdict.stop),
        (false, Some(ChainStop::CostCeiling)),
        "a figure EQUAL to the ceiling trips it — the ceiling is a maximum, not a \
         threshold to exceed"
    );
    assert_eq!(verdict.ceiling_usd, Some(1.0));
    assert_eq!(verdict.run.cost_usd, Some(1.0));

    // OVER it: also stops (the figure accumulates, so a chain can arrive from below).
    let over = db
        .create_task(&space, "a card that overshoots", None, None)
        .expect("create_task");
    db.workflow_run_step(&space, &over.id, Some(0.6))
        .expect("first half");
    let verdict = db
        .workflow_run_step(&space, &over.id, Some(0.6))
        .expect("the second half");
    assert!(
        !verdict.advance,
        "$1.20 against a $1.00 ceiling is over, whatever the spelling of the sum"
    );
    assert_eq!(verdict.stop, Some(ChainStop::CostCeiling));
}

/// (the ADR 0082 limitation, PINNED rather than discovered) a chain whose
/// Sessions never report a figure CANNOT trip the ceiling, and the verdict still
/// reports the ceiling so the caller can say so out loud.
///
/// This is a REAL limitation and this test exists to keep it honest: the ceiling
/// is compared against `workflow_runs.cost_usd`, and that column is `NULL` until a
/// Session reports a figure. Treating `NULL` as `0.0` in the comparison — the
/// tempting "simplification" — would make a `$0.00` ceiling trip a chain that
/// reported nothing while a `$0.00` ceiling is ALSO what a person means when they
/// say "no spend at all", so the two states would collapse in the one direction
/// that fails open. The honest form is the one shipped: `NULL` never trips, the
/// step bound is what stops such a chain, and the verdict hands the caller the
/// ceiling so the sentence it writes says "the ceiling is $X, and a chain that
/// never reported a cost cannot be seen by it".
#[test]
fn a_chain_that_never_reports_a_cost_cannot_trip_the_ceiling() {
    let (_dir, db, space) = seeded("verdict-null-cost");
    db.upsert_space(&space, false).expect("upsert_space");
    // A CEILING OF ZERO — the sharpest form. A person who sets $0 means "no spend",
    // and a `NULL`-cost chain is the one that would be stopped by comparing the
    // missing figure against `0.0`.
    db.set_auto_guards(&space, Some(5), Some(0.0))
        .expect("a ceiling of zero");
    let task = db
        .create_task(&space, "a chain that reports nothing", None, None)
        .expect("create_task");

    for step in 1..=4 {
        let verdict = db
            .workflow_run_step(&space, &task.id, None)
            .unwrap_or_else(|err| panic!("step {step} must land: {err}"));
        assert!(
            verdict.advance,
            "step {step}: a `NULL` figure never trips a ceiling, not even $0.00 — \
             `NULL` is 'nothing was reported', not 'it was free'"
        );
        assert_eq!(
            verdict.stop, None,
            "and the verdict never cites `cost_ceiling` for a chain with no figure"
        );
        assert!(
            verdict.run.cost_usd.is_none(),
            "the figure is still NULL after {step} silent steps (ADR 0082)"
        );
        assert_eq!(
            verdict.ceiling_usd,
            Some(0.0),
            "while the verdict still reports the ceiling the Space set, so the \
             caller can say the chain is unbounded BY THIS GUARD rather than \
             implying it is safe"
        );
    }

    // The moment a figure IS reported, the same ceiling sees it. `NULL` is not
    // treated as `0.0`, but a REPORTED `0.0` is a real zero and trips a zero
    // ceiling — which is exactly what "no spend" is supposed to mean.
    let reported = db
        .workflow_run_step(&space, &task.id, Some(0.0))
        .expect("a step that reports a real zero");
    assert_eq!(
        reported.stop,
        Some(ChainStop::CostCeiling),
        "a REPORTED $0.00 against a $0.00 ceiling trips it — the two states the \
         ceiling reads are `NULL` (invisible) and `Some(x)` (compared), and only \
         the second is a figure"
    );
    assert_eq!(
        reported.max_steps, 5,
        "and the step bound is still what stops a chain that reports nothing"
    );
}

/// (the vocabulary the record and the verdict share) every `ChainStop` spelling,
/// frozen.
///
/// The same drift pin `closed_reason_spellings_are_frozen` is for
/// `ClosedReason::as_str`: the strings are what `workflow_run_close`'s
/// `stop_reason` column stores and what the TS union names, and neither side is
/// checked by a compiler. A re-spelling here would split one vocabulary in two —
/// the verdict says `max_steps` and the run record says `steps` — and a person
/// reading a closed chain's reason could no longer match it to the bound that
/// produced it.
#[test]
fn the_chain_stop_spellings_are_frozen() {
    let frozen: &[(&str, ChainStop)] = &[
        ("no_next_stage", ChainStop::NoNextStage),
        ("max_steps", ChainStop::MaxSteps),
        ("cost_ceiling", ChainStop::CostCeiling),
        ("launch_refused", ChainStop::LaunchRefused),
    ];
    for (expected, stop) in frozen {
        assert_eq!(stop.as_str(), *expected, "frozen spelling for {stop:?}");
    }
}

/// (two bounds, one step) when a single step reaches BOTH the step bound and the
/// ceiling, the verdict reports the CEILING.
///
/// The choice is stated rather than left to evaluation order, because a caller
/// writing one sentence can only tell a person one reason and the two reasons
/// imply different fixes: "raise your step bound" versus "you spent the money you
/// said was enough". Cost is the audited fact and the shipped ceiling is described
/// as the guard for the expensive case, so the money answer is the useful one.
/// Without a test, this is a `if`/`else if` order that a refactor silently inverts.
///
/// Both bounds genuinely trip on the SECOND step, and the first step asserts that
/// neither trips on its own — otherwise this would pin an `if`/`else if` order
/// against a step where only one arm was ever true, which is vacuous.
#[test]
fn the_verdict_reports_the_ceiling_when_both_bounds_trip_on_one_step() {
    let (_dir, db, space) = seeded("verdict-both");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_auto_guards(&space, Some(1), Some(1.0))
        .expect("a one-advance bound and a $1 ceiling");
    let task = db
        .create_task(&space, "a card that runs out of both", None, None)
        .expect("create_task");

    let first = db
        .workflow_run_step(&space, &task.id, Some(0.5))
        .expect("the advance both bounds still permit");
    assert!(
        first.advance,
        "`steps = 1` has not passed a bound of 1 and $0.50 has not reached a $1.00 \
         ceiling, so this step is not the one either guard speaks about"
    );

    let verdict = db
        .workflow_run_step(&space, &task.id, Some(0.5))
        .expect("the step that trips both");
    assert!(!verdict.advance);
    assert_eq!(
        verdict.stop,
        Some(ChainStop::CostCeiling),
        "`steps = 2` passed the bound of 1 AND `cost_usd = 1.0` reached the \
         ceiling, and the ceiling is the reason the verdict tells"
    );
    // Both effective bounds still ride the verdict, so the caller can say both.
    assert_eq!(verdict.max_steps, 1);
    assert_eq!(verdict.ceiling_usd, Some(1.0));
}

// ── A chain interrupted by a process restart ────────────────────────────────
//
// A run is OPENED by `workflow_run_step` and CLOSED by the TypeScript settle
// handler, so the close lives in the JS runtime. A reload, a quit or a crash
// mid-chain therefore leaves `finished_at` NULL with nothing left in the process
// that could ever stamp it, and `workflow_run_step` UPSERTs onto an OPEN run — so
// the NEXT chain this card starts inherits the dead one's `steps` and `cost_usd`
// and a person who set a 20-step / $10 bound silently gets a shorter, partly
// spent one. `advanceWorkflowChainOnSettle`'s own comment and ADR 0119 §3 name
// exactly this hazard for the paths the runtime DOES reach; this is the one it
// cannot. `Db::open` closes what it finds open, and these two tests pin both
// halves: the stale run is closed, and a run that is already closed is left alone.
/// (`Db::open` closes what a restart orphaned) a run left OPEN by a process that
/// died mid-chain is closed at the next open, with its step count and figure
/// intact and a reason that says the chain was interrupted rather than bounded.
///
/// Asserted through an INDEPENDENT connection to the same file (the `artifact_rows`
/// idiom) rather than through a `Db` method, because the question is what the
/// DATABASE holds after a re-open, not what a verb chose to report about it.
#[test]
fn a_run_left_open_by_a_restart_is_closed_when_the_database_reopens() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-run-orphan-", "scratch");
    let path = dir.join("t.db");

    let space = board_space("run-orphan");
    let task_id = {
        let db = Db::open(&path).expect("db should open");
        db.upsert_space(&space, false).expect("upsert_space");
        let task = db
            .create_task(&space, "a card mid-chain when the window died", None, None)
            .expect("create_task");
        db.workflow_run_step(&space, &task.id, Some(0.4))
            .expect("the chain opens");
        // `db` is DROPPED here — the process ends with the run OPEN, which is the
        // whole state under test. Nothing closes it; that is the defect.
        task.id
    };

    let db = Db::open(&path).expect("re-open runs the sweep");

    let (finished_at, stop_reason, steps, cost) = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT finished_at, stop_reason, steps, cost_usd FROM workflow_runs \
             WHERE task_id = ?1",
            rusqlite::params![task_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                ))
            },
        )
        .expect("the run survives — it is CLOSED, not deleted");

    assert!(
        finished_at.is_some(),
        "`finished_at` is stamped at the re-open — nothing in a fresh process can \
         legitimately be mid-chain, and an open row here would be inherited by the \
         card's next chain (its `steps` and its spend counted against a bound the \
         person already spent part of)"
    );
    assert_eq!(
        stop_reason.as_deref(),
        Some("interrupted"),
        "and the reason says the chain was INTERRUPTED, not that a bound stopped it"
    );
    assert_eq!(
        steps, 1,
        "the sweep closes the run, it does not rewrite its record"
    );
    assert_eq!(cost, Some(0.4), "nor its figure");

    // And the next chain starts CLEAN: one step, its own figure — the whole point.
    let next = db
        .workflow_run_step(&space, &task_id, Some(0.1))
        .expect("the next chain opens")
        .run;
    assert_eq!(
        next.steps, 1,
        "the new chain counts from one rather than inheriting the dead chain's steps"
    );
    assert_eq!(
        next.cost_usd,
        Some(0.1),
        "and spends from its own first figure"
    );
}

/// (the sweep does not touch what is closed) a run a settle handler closed
/// normally keeps its own `finished_at` and its own reason across a re-open.
///
/// Without this half the sweep would be an unconditional `UPDATE ... WHERE 1 = 1`
/// as far as the tests were concerned, and the audit trail — the record's only
/// narrative field — would be rewritten on every launch.
#[test]
fn a_run_that_was_closed_normally_survives_a_reopen_untouched() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-run-closed-", "scratch");
    let path = dir.join("t.db");

    let space = board_space("run-closed");
    let (task_id, finished_before, steps_before) = {
        let db = Db::open(&path).expect("db should open");
        db.upsert_space(&space, false).expect("upsert_space");
        let task = db
            .create_task(&space, "a chain that ended properly", None, None)
            .expect("create_task");
        db.workflow_run_step(&space, &task.id, Some(0.4))
            .expect("open");
        db.workflow_run_close(&task.id, "max_steps")
            .expect("the settle handler closed it");
        let (finished, steps) = db
            .conn
            .lock()
            .expect("db mutex poisoned")
            .query_row(
                "SELECT finished_at, steps FROM workflow_runs WHERE task_id = ?1",
                rusqlite::params![task.id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("the closed row");
        (task.id, finished, steps)
    };

    let db = Db::open(&path).expect("re-open runs the sweep");
    let (finished_after, reason_after, steps_after) = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT finished_at, stop_reason, steps FROM workflow_runs WHERE task_id = ?1",
            rusqlite::params![task_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .expect("the closed row is still there");

    assert_eq!(
        (finished_after, reason_after.as_deref(), steps_after),
        (finished_before, Some("max_steps"), steps_before),
        "the sweep scopes on `finished_at IS NULL`, so a run that recorded its own \
         ending keeps its stamp, its reason and its counters"
    );
}

// ── The one-open-run invariant is ENFORCED, not merely intended ─────────────
/// (`idx_workflow_runs_open` is UNIQUE) a second OPEN run for one Task is
/// REJECTED by the database.
///
/// `WorkflowRunRow`'s doc leans on "at most ONE open row per Task", and
/// `workflow_run_step`'s `SELECT id … WHERE finished_at IS
/// NULL` reads whichever row SQLite reaches first. Under a PLAIN index nothing
/// enforced that, so a writer that opened a second row would have the chain counted
/// against a stranger's `steps` and spend — the bound failing OPEN, which is the
/// direction a spend guard must never fail in. This inserts the second row through
/// raw SQL precisely because the step verb will not do it: the point is that the SCHEMA
/// refuses it, not that the Rust happens not to.
#[test]
fn a_second_open_run_for_one_task_is_rejected_by_the_schema() {
    let (_dir, db, space) = seeded("runs-one-open");
    let task = db
        .create_task(&space, "a card with one chain", None, None)
        .expect("create_task");
    db.workflow_run_step(&space, &task.id, None)
        .expect("the chain opens");

    let error = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO workflow_runs (id, space_path, task_id, started_at, steps) \
             VALUES ('wfr_impostor', ?1, ?2, 1, 0)",
            rusqlite::params![space, task.id],
        )
        .expect_err(
            "a SECOND open row for one Task must be refused by the unique partial \
             index — under a plain index this INSERT succeeds and the next chain \
             counts itself against whichever row SQLite reaches first",
        );
    assert!(
        error.to_string().contains("UNIQUE constraint failed"),
        "and it must be refused BY THE INDEX, got `{error}`"
    );

    // A CLOSED second row for the same Task is still legal — the index is PARTIAL,
    // and two sequential chains are the ordinary case this table is built for
    // (`a_new_chain_after_a_close_opens_a_second_run_counting_from_one`).
    db.workflow_run_close(&task.id, "max_steps")
        .expect("close the first chain");
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO workflow_runs \
             (id, space_path, task_id, started_at, steps, finished_at) \
             VALUES ('wfr_second_chain', ?1, ?2, 2, 1, 3)",
            rusqlite::params![space, task.id],
        )
        .expect("a second CLOSED run for the same Task is history, not a conflict");
}

// ── The step verb's Space is the CARD's, not the caller's ──────────────────
//
// `workflow_run_step` used to key the guard read by the CALLER-SUPPLIED
// `space_path` and to store that same string verbatim. Nothing checked it against
// the card, so a wrong path answered a verdict measured against another Space's
// budget (or the shipped fallbacks), and the audit column and the bound could
// disagree about which Space a run belonged to — a future `WHERE space_path = ?`
// audit would miss rows. The verb now reads the card's own `tasks.space_path`
// under the same lock and canonicalises it the way the guard read does.
/// (a wrong `space_path` cannot buy a bigger budget) the guard read is measured
/// against the CARD's Space, so a caller that names a DIFFERENT Space is refused
/// rather than answered with that other Space's bound.
///
/// The setup makes the two Spaces differ in the direction that matters: the card's
/// own Space is bounded to ONE advance and the stranger is bounded to fifty, so a
/// verb that trusted the argument would let a one-step chain run to fifty — the
/// bound failing open, on a single mis-spelled argument.
#[test]
fn a_step_naming_a_space_other_than_the_cards_is_refused() {
    let (_dir, db, home) = seeded("runs-space-home");
    let stranger = board_space("runs-space-stranger");
    db.upsert_space(&home, false).expect("upsert_space");
    db.upsert_space(&stranger, false).expect("upsert_space");
    db.set_auto_guards(&home, Some(1), Some(9.0))
        .expect("the card's own Space: one advance");
    db.set_auto_guards(&stranger, Some(50), Some(99.0))
        .expect("the stranger: fifty advances");
    let task = db
        .create_task(
            &home,
            "a card whose caller lies about its Space",
            None,
            None,
        )
        .expect("create_task");

    let err = db
        .workflow_run_step(&stranger, &task.id, None)
        .expect_err("a `space_path` that is not the card's must be refused");
    assert!(
        err.to_string().contains("space_path"),
        "and the error must name the argument it refused, got `{err}`"
    );
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM workflow_runs WHERE task_id = '{}'",
                task.id
            )
        ),
        0,
        "and NOTHING is written — a refused step must not spend a step"
    );

    // The honest spelling still works, and is governed by the HOME bound.
    let verdict = db
        .workflow_run_step(&home, &task.id, None)
        .expect("the card's real Space is accepted");
    assert_eq!(
        verdict.max_steps, 1,
        "the bound is the one the CARD's Space configured"
    );
    assert_eq!(
        verdict.run.space_path, home,
        "and the row is the card's Space"
    );
}

/// (the audit column lands canonical) the stored `space_path` is canonicalised the
/// same way the guard read canonicalises, so the column and the bound the verdict
/// cites cannot disagree about which Space the run belongs to.
///
/// `create_task` stores the path it is handed VERBATIM, so a card can legitimately
/// carry a `..` spelling. A run stored under that raw spelling while its bound was
/// looked up through the canonical key is a row a `WHERE space_path = ?` audit
/// cannot find. This asserts the row lands canonical AND that the same folder
/// spelled two ways is not treated as a mismatch.
#[test]
fn a_step_stores_the_canonical_space_path_even_when_the_card_carries_a_raw_one() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-run-canonical-", "scratch");
    let folder = dir.join("chain folder");
    std::fs::create_dir_all(&folder).expect("the folder exists so canonicalize works");
    let canonical = std::fs::canonicalize(&folder)
        .expect("canonicalize")
        .display()
        .to_string();
    let raw = folder.join("..").join("chain folder").display().to_string();
    assert_ne!(
        raw, canonical,
        "the two spellings must differ for this to bite"
    );

    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.upsert_space(&canonical, false).expect("upsert_space");
    let task = db
        .create_task(
            &raw,
            "a card whose Space is spelled through a .. hop",
            None,
            None,
        )
        .expect("create_task");
    assert_eq!(task.space_path, raw, "the CARD carries the raw spelling");

    let run = db
        .workflow_run_step(&raw, &task.id, None)
        .expect("the raw spelling is not a mismatch — it canonicalises to the card's own")
        .run;
    assert_eq!(
        run.space_path, canonical,
        "the run is stored CANONICAL, so it agrees with the key the guard read used"
    );
    assert_eq!(
        raw_column(
            &db,
            &format!(
                "SELECT space_path FROM workflow_runs WHERE id = '{}'",
                run.id
            )
        )
        .first()
        .map(String::as_str),
        Some(canonical.as_str()),
        "and that is what the DATABASE holds, not just what the verdict reported"
    );

    // The canonical spelling of the same folder is the SAME Space, not a mismatch.
    db.workflow_run_step(&canonical, &task.id, None)
        .expect("the canonical spelling of the card's own folder is accepted");
}

/// (no card, no Space, no verdict) a `task_id` that names no card is refused.
///
/// This is the ONE place the `workflow_runs` family stops being lenient, and the
/// line is drawn deliberately: the family's `Ok`-on-absence shape covers the
/// ABSENCE OF BOOKKEEPING (no run to close, no open run to read), and every one of
/// those absences still answers a question that was answerable. Here there is no
/// card, so there is no Space, so there is no bound to measure against — the verb
/// would have to fall back to the shipped constants and report a verdict as though
/// the Space had chosen them. That is the lie this item exists to remove, and the
/// step it would record would be charged to a Space nobody configured.
#[test]
fn a_step_for_a_task_that_does_not_exist_is_refused() {
    let (_dir, db, space) = seeded("runs-no-card");
    db.upsert_space(&space, false).expect("upsert_space");

    let err = db
        .workflow_run_step(&space, "tsk_never_minted", None)
        .expect_err("a card that does not exist has no Space to be bounded by");
    assert!(
        err.to_string().contains("tsk_never_minted"),
        "and the error names the id it could not resolve, got `{err}`"
    );
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM workflow_runs"),
        0,
        "and no run is opened for a card that does not exist"
    );
}
