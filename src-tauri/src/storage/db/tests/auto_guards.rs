//! Tests for `db/auto_guards.rs`: the two per-Space auto-chain guards (their
//! gated migration, their read/write pair and the NULL ≠ 0 discipline) and the
//! two shipped fallback constants that govern a Space whose owner never opened the
//! guard editor.
//!
//! The guards exist because an unattended chain of LLM Sessions is an unbounded
//! spend risk: nothing in this file acts on a guard, and that is the design — the
//! runtime that reads them is `advanceWorkflowChainOnSettle` in
//! `src/store/workflowChain.ts`, and it reaches them through the verdict
//! `workflow_run_step` answers rather than by reading these columns, so what is
//! pinned here is that the
//! numbers are STORABLE, CLEARABLE, and readable by the same key rule the rest of
//! `spaces` uses.
//!
//! WHY TWO VERDICT TESTS LIVE HERE. `workflow_run_step` answers an
//! `AdvanceVerdict`, and the two tests that moved over from the old `workflows`
//! child — [`an_unset_space_gets_the_shipped_fallback_bounds_on_the_verdict`] and
//! [`the_verdict_reads_the_guards_through_the_canonical_space_key`] — assert what
//! the GUARD READ hands back through that verdict, not how the bound is judged: the
//! first pins which fallback governs when both columns are NULL, the second pins
//! `auto_guards_on`'s `space_key` projection. They are guard-read tests wearing a
//! verdict-shaped return value, so they mirror the guard child. The bound JUDGEMENT
//! — `>=` on the post-increment counter, `>=` on the figure, and the both-bounds
//! precedence — stays with [`super::workflow_runs`].

use crate::storage::db::*;

use super::support::*;

/// The five `spaces` rows a cluster fixture needs, keyed RAW exactly the way the
/// board tests key their board rows (the migration never re-keys `spaces`).
fn space_row(space: &str) -> String {
    format!(
        "INSERT INTO spaces (path, created_at, last_opened_at, trusted, sort_order) \
         VALUES ('{space}', 1, 1, 0, 0);\n"
    )
}

// ── The two gated columns: the migration ─────────────────────────────────────
/// (the `auto_max_steps` gate) a pre-existing database whose `spaces` table
/// predates the step bound must open CLEANLY, and the pre-existing Space must
/// read the bound as `None` — NOT as `0`.
///
/// `None` is the load-bearing half and it is ADR 0082's argument (the `cost_usd`
/// column two gates over) applied to a spend guard: `NULL` means "not
/// configured", and the shipped `DEFAULT_AUTO_MAX_STEPS` governs. A
/// `DEFAULT 0` would migrate every existing Space into a CONFIGURED value that
/// means "no auto-chaining at all" — a limit nobody set, which is exactly the
/// phantom-`$0.00` shape one meaning-by-the-wrong-spelling produces. The gate
/// therefore carries NO `DEFAULT` and NO backfill, and `dflt_value` is pinned
/// directly, because the `None` assertion below would also pass under a
/// `DEFAULT 0` someone later "improves".
///
/// The fixture is `SCHEMA_WITHOUT_SPACES_AUTO_MAX_STEPS`, which omits EXACTLY
/// this one gated column, so every sibling gate stays silent.
#[test]
fn the_auto_max_steps_gate_arrives_null_on_a_preexisting_space() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-steps-gate-", "scratch");
    let space = board_space("steps-gate");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_SPACES_AUTO_MAX_STEPS,
        &space_row(&space),
    );

    {
        let db = Db::open(&path).expect("the auto_max_steps gate runs on open");
        let default_value: Option<String> = db
            .conn
            .lock()
            .expect("db mutex poisoned")
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('spaces') \
                 WHERE name = 'auto_max_steps'",
                [],
                |row| row.get(0),
            )
            .expect("pragma_table_info should read");
        assert_eq!(
            default_value, None,
            "`auto_max_steps` has NO column DEFAULT — 0 is a CONFIGURED value \
             ('no auto-chaining') and must not arrive by migration"
        );

        let guards = db.auto_guards(&space).expect("auto_guards");
        assert_eq!(
            guards.max_steps, None,
            "the migrated Space reads the step bound as unconfigured"
        );
        assert_eq!(
            guards.ceiling_usd, None,
            "and its ceiling was never configured either (the column was present, \
             the row never wrote it)"
        );
    }

    // A SECOND open of the already-migrated file is a clean no-op (the
    // `pragma_table_info` probe skips the `ALTER`) and nothing flipped.
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards").max_steps,
        None,
        "the gate ran once, not twice"
    );
}

/// (the `auto_ceiling_usd` gate) the same claim for the cost ceiling: a
/// pre-existing Space reads `None`, and the column carries no `DEFAULT`.
///
/// `0.0` here would be worse than `0` next door: it reads as "this Space's
/// ceiling is zero dollars", i.e. auto-chaining is financially off, for every
/// Space in every existing database — the compatibility story `board_strict`'s
/// `0` tells is the opposite of what a `0.0` default would say here.
#[test]
fn the_auto_ceiling_usd_gate_arrives_null_on_a_preexisting_space() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-ceiling-gate-", "scratch");
    let space = board_space("ceiling-gate");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_SPACES_AUTO_CEILING_USD,
        &space_row(&space),
    );

    {
        let db = Db::open(&path).expect("the auto_ceiling_usd gate runs on open");
        let default_value: Option<String> = db
            .conn
            .lock()
            .expect("db mutex poisoned")
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('spaces') \
                 WHERE name = 'auto_ceiling_usd'",
                [],
                |row| row.get(0),
            )
            .expect("pragma_table_info should read");
        assert_eq!(
            default_value, None,
            "`auto_ceiling_usd` has NO column DEFAULT — 0.0 is a CONFIGURED \
             ceiling ('no spend') and must not arrive by migration"
        );

        assert_eq!(
            db.auto_guards(&space).expect("auto_guards").ceiling_usd,
            None,
            "the migrated Space reads the ceiling as unconfigured"
        );
    }

    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards").ceiling_usd,
        None,
        "the gate ran once, not twice"
    );
}

// ── The guards: the read/write pair ─────────────────────────────────────────
/// (the read) `auto_guards` reports BOTH columns, and a Space with no `spaces`
/// row — or a row that never configured either guard — answers `None` twice.
///
/// Two `None`s is the ordinary state, not an error: the board's own tests never
/// upsert a `spaces` row, and an unconfigured Space is governed by the shipped
/// fallback constants rather than being unbounded.
#[test]
fn auto_guards_reads_both_columns_and_a_missing_row_is_two_nones() {
    let (_dir, db, space) = seeded("guards-fresh");

    // A fresh Space: both columns exist (SCHEMA) and both hold NULL.
    db.upsert_space(&space, false).expect("upsert_space");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards"),
        AutoGuards {
            max_steps: None,
            ceiling_usd: None,
        },
        "a row that configured nothing reads as two `None`s — the fallback \
         constants' trigger, not a zero"
    );

    // A Space with no row at all: the same answer, and `Ok`.
    assert_eq!(
        db.auto_guards(&board_space("guards-no-row"))
            .expect("a missing row is Ok, not an error"),
        AutoGuards {
            max_steps: None,
            ceiling_usd: None,
        },
        "mirrors `board_strict`: absence is an answer, not a failure"
    );
}

/// (the write, and the reason both parameters are `Option`) each guard is
/// settable AND clearable, independently of the other.
///
/// This is the gap `set_stage_next` records as an accepted defect — it takes a
/// plain slice, so `[]` and `NULL` are unrecoverable from each other and a
/// configured value can never be un-configured. A guard a person set by mistake
/// has to be removable, so `None` writes NULL, and clearing one leaves the other
/// exactly where it was.
#[test]
fn set_auto_guards_round_trips_both_guards_and_clears_each_one_independently() {
    let (_dir, db, space) = seeded("guards-write");
    db.upsert_space(&space, false).expect("upsert_space");

    db.set_auto_guards(&space, Some(7), Some(2.5))
        .expect("set both guards");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards"),
        AutoGuards {
            max_steps: Some(7),
            ceiling_usd: Some(2.5),
        },
        "both figures round-trip"
    );

    // Clear the STEP bound only. The ceiling must survive — a caller that
    // clears one guard must not silently un-configure its neighbour.
    db.set_auto_guards(&space, None, Some(2.5))
        .expect("clear the step bound");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards"),
        AutoGuards {
            max_steps: None,
            ceiling_usd: Some(2.5),
        },
        "the step bound is CLEARABLE and the ceiling is untouched"
    );

    // Clear the CEILING only, back to two `None`s.
    db.set_auto_guards(&space, None, None)
        .expect("clear the ceiling");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards"),
        AutoGuards {
            max_steps: None,
            ceiling_usd: None,
        },
        "and so is the ceiling — both directions, both columns"
    );

    // The stored spelling of "cleared" is NULL, not 0 — read through the raw
    // connection, because a `Db` verb that collapsed NULL into 0 would answer
    // this test's `None` from its own mapper and never show the column.
    assert_eq!(
        raw_column(
            &db,
            &format!(
                "SELECT COALESCE(CAST(auto_max_steps AS TEXT), '<NULL>') \
                 FROM spaces WHERE path = '{space}'"
            )
        )
        .first()
        .map(String::as_str),
        Some("<NULL>"),
        "a cleared guard is stored as NULL"
    );
}

/// (`0` and `0.0` are CONFIGURED values) a zero bound and a zero ceiling store
/// and read back as `Some`, and are never collapsed into the unconfigured `None`.
///
/// This is the whole reason the columns have no SQL `DEFAULT`: `0` means "no
/// auto-chaining" and `0.0` means "no spend", and both are things a person may
/// legitimately configure. If the read collapsed them into `None`, the fallback
/// constants would silently re-arm a Space whose owner switched auto-chaining off.
#[test]
fn zero_is_a_configured_guard_and_never_the_same_as_null() {
    let (_dir, db, space) = seeded("guards-zero");
    db.upsert_space(&space, false).expect("upsert_space");

    db.set_auto_guards(&space, Some(0), Some(0.0))
        .expect("a zero bound and a zero ceiling are legal settings");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards"),
        AutoGuards {
            max_steps: Some(0),
            ceiling_usd: Some(0.0),
        },
        "`Some(0)` / `Some(0.0)` are NOT `None` — the two states stay distinct"
    );
    assert_eq!(
        raw_i64s(
            &db,
            &format!("SELECT auto_max_steps FROM spaces WHERE path = '{space}'")
        )
        .first(),
        Some(&0),
        "and the column holds a real 0, not a NULL"
    );

    // A negative bound is stored verbatim. Whether it is SANE is the editor's
    // question and tomorrow's runtime's; storage refusing a number the wire does
    // not forbid would be storage inventing a rule (the `prompt_prefix` argument).
    db.set_auto_guards(&space, Some(-1), None)
        .expect("storage does not adjudicate the number");
    assert_eq!(
        db.auto_guards(&space).expect("auto_guards").max_steps,
        Some(-1)
    );
}

/// (a Space with no row) the write is a silent `Ok(())` no-op and creates
/// nothing — `set_board_strict`'s and `set_space_trusted`'s shape, so a guard set
/// against a folder that has no bookkeeping row cannot fabricate one.
#[test]
fn set_auto_guards_on_a_space_with_no_row_is_a_silent_no_op() {
    let (_dir, db, nowhere) = seeded("guards-no-row-write");

    db.set_auto_guards(&nowhere, Some(3), Some(1.0))
        .expect("a missing row is a no-op, not an error");
    assert_eq!(
        raw_scalar(
            &db,
            &format!("SELECT COUNT(*) FROM spaces WHERE path = '{nowhere}'")
        ),
        0,
        "and it inserted nothing"
    );
    assert_eq!(
        db.auto_guards(&nowhere).expect("auto_guards").max_steps,
        None,
        "the read still answers the fallback's trigger"
    );
}

/// (the key-agreement pin) `auto_guards` and `set_auto_guards` agree on ONE key
/// rule — `space_key` with the raw fallback — exactly as `set_board_strict` and
/// `board_strict` do.
///
/// The setup makes the two spellings differ ON PURPOSE: the `spaces` row is keyed
/// CANONICAL (what `upsert_space` stores) and the guards are written and read
/// through a raw `..` spelling of the SAME folder. A verb that keyed on the raw
/// string would write nothing and read `None`, so the editor would show a bound
/// the runtime never sees — the same disagreement the Strict Switch pin exists to
/// prevent, one column over.
#[test]
fn the_auto_guard_read_and_the_writer_agree_on_a_non_canonical_path() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-guards-key-", "scratch");
    let folder = dir.join("guard folder");
    std::fs::create_dir_all(&folder).expect("the folder exists so canonicalize works");
    let canonical = std::fs::canonicalize(&folder)
        .expect("canonicalize")
        .display()
        .to_string();
    let raw = folder.join("..").join("guard folder").display().to_string();

    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.upsert_space(&canonical, false)
        .expect("the row is keyed CANONICAL");

    db.set_auto_guards(&raw, Some(4), Some(0.75))
        .expect("the write arrives with the RAW spelling");
    assert_eq!(
        db.auto_guards(&canonical).expect("read canonical"),
        AutoGuards {
            max_steps: Some(4),
            ceiling_usd: Some(0.75),
        },
        "canonical sees what the raw write stored"
    );
    assert_eq!(
        db.auto_guards(&raw).expect("read raw"),
        AutoGuards {
            max_steps: Some(4),
            ceiling_usd: Some(0.75),
        },
        "and so does the raw spelling — the read mirrors the write's keying"
    );
}

/// (the fallback constants) an UNSET Space is still BOUNDED: both shipped
/// defaults carry the values the design fixed, and both are finite and positive.
///
/// The shape follows `tests/retention.rs`'s
/// `the_retention_constants_carry_their_approved_values` for the same reason: a
/// policy number is pinned to its LITERAL, so an edit to either is a red test
/// rather than a silent re-tuning of a spend bound.
///
/// The failure this pins is the one a later "just make the default unlimited" edit
/// would cause: a `0` bound (or a non-finite ceiling) turns every Space that never
/// opened the guard editor into one that either cannot chain at all or chains
/// without a ceiling — the exact unbounded-spend risk the guards were added before
/// the runtime for. Neither constant is an "unlimited" sentinel.
#[test]
fn the_fallback_constants_carry_their_approved_values() {
    assert_eq!(
        DEFAULT_AUTO_MAX_STEPS, 20,
        "the step fallback is 20 auto-advances per chain — a real bound, so a \
         Space that never opened the guard editor is still bounded (0 would mean \
         an unset Space cannot chain at all, and no finite value means unlimited)"
    );
    assert_eq!(
        DEFAULT_AUTO_CEILING_USD, 10.0,
        "the cost fallback is $10.00 per chain, and it is FINITE — an unset Space \
         has a ceiling"
    );
    assert!(
        DEFAULT_AUTO_CEILING_USD.is_finite(),
        "stated separately because `is_finite` is the property and the literal \
         above is what makes it checkable: an `f64::INFINITY` here would satisfy \
         every other guard in this file"
    );
}

// ── The two guard reads that arrive through a verdict ────────────────────────
//
// The two tests below stay with the guards, for the reason the module header gives:
// each asserts what the guard READ returns (which fallback governs a NULL pair;
// whether the read normalised the Space path) and only happens to be observable
// through `workflow_run_step`'s verdict. The bound JUDGEMENT those two numbers feed
// is pinned in the `super::workflow_runs` child.

/// (an unset Space is BOUNDED, and the verdict says by how much) both effective
/// bounds on the verdict are the shipped fallbacks, asserted against the
/// CONSTANTS and not their literals.
///
/// The literals would pass under a re-tuned policy the mirror no longer describes;
/// the constants are the thing the runtime actually applies. The shape follows
/// `the_retention_constants_carry_their_approved_values` for the same reason.
#[test]
fn an_unset_space_gets_the_shipped_fallback_bounds_on_the_verdict() {
    let (_dir, db, space) = seeded("verdict-fallback");
    // A `spaces` row that configured NOTHING (both columns NULL) — the ordinary
    // state for every Space whose owner never opened the guard editor.
    db.upsert_space(&space, false).expect("upsert_space");
    let task = db
        .create_task(&space, "a card in an unconfigured Space", None, None)
        .expect("create_task");

    let verdict = db
        .workflow_run_step(&space, &task.id, None)
        .expect("the first step");
    assert_eq!(
        verdict.max_steps, DEFAULT_AUTO_MAX_STEPS,
        "an unconfigured Space is BOUNDED by the shipped step fallback"
    );
    assert_eq!(
        verdict.ceiling_usd,
        Some(DEFAULT_AUTO_CEILING_USD),
        "and by the shipped ceiling — `None` here would tell the caller this chain \
         has no spend limit at all, which is the opposite of what ships"
    );
    assert!(
        verdict.advance,
        "one step into a 20-step chain it continues (the bound is not unlimited, it \
         is just far away)"
    );

    // A Space with NO `spaces` row at all is the same answer, because the read
    // answers absence as two `None`s and the fallbacks govern: the rowless Space
    // is the one most likely to be left unattended, so it is the least safe one to
    // treat as unbounded.
    let nowhere = board_space("verdict-no-row");
    let orphan = db
        .create_task(&nowhere, "a card in a Space with no row", None, None)
        .expect("create_task");
    let verdict = db
        .workflow_run_step(&nowhere, &orphan.id, None)
        .expect("a missing `spaces` row does not fail the step");
    assert_eq!(verdict.max_steps, DEFAULT_AUTO_MAX_STEPS);
    assert_eq!(verdict.ceiling_usd, Some(DEFAULT_AUTO_CEILING_USD));
}

/// (the key-agreement pin, at the gate) the guard read inside the step verb keys
/// `spaces` through `space_key`, so a chain launched with a non-canonical Space
/// path is still governed by the bound the editor set.
///
/// The setup makes the two spellings differ ON PURPOSE, exactly as
/// `the_auto_guard_read_and_the_writer_agree_on_a_non_canonical_path` does: the
/// `spaces` row is keyed CANONICAL (what `upsert_space` stores) and the step is
/// called with a raw `..` spelling of the same folder. A guard read that keyed on
/// the raw string would find no row, fall back to 20, and let a Space bounded to
/// ONE step chain twenty — while its editor shows "1". That is `move_task`'s
/// measured consequence (`tasks.rs`'s comment on the same rule) wearing a spend
/// bound instead of a drag refusal.
#[test]
fn the_verdict_reads_the_guards_through_the_canonical_space_key() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-verdict-key-", "scratch");
    let folder = dir.join("chain folder");
    std::fs::create_dir_all(&folder).expect("the folder exists so canonicalize works");
    let canonical = std::fs::canonicalize(&folder)
        .expect("canonicalize")
        .display()
        .to_string();
    let raw = folder.join("..").join("chain folder").display().to_string();

    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.upsert_space(&canonical, false)
        .expect("the row is keyed CANONICAL");
    db.set_auto_guards(&canonical, Some(1), Some(9.0))
        .expect("a one-step bound, written CANONICAL");

    let task = db
        .create_task(
            &raw,
            "a card whose Space is spelled through a .. hop",
            None,
            None,
        )
        .expect("create_task");

    let verdict = db
        .workflow_run_step(&raw, &task.id, None)
        .expect("the step lands on the RAW spelling");
    assert_eq!(
        verdict.max_steps, 1,
        "the guard read normalized, so the bound the editor set is the bound the \
         chain met (a raw-string read would report the 20-step fallback)"
    );
    assert_eq!(
        verdict.ceiling_usd,
        Some(9.0),
        "and the ceiling came from the same row"
    );
    assert!(
        verdict.advance,
        "the normalized bound is ONE advance, and a bound of 1 permits exactly one \
         — the refusal is the NEXT step's answer, pinned just below"
    );

    // The bound the raw spelling reached is the one that STOPS the chain too, so
    // the second step (the one past a bound of 1) is refused. Asserted here and
    // not only above: a raw-string guard read would report the 20-step fallback
    // and this step would be granted.
    let tripped = db
        .workflow_run_step(&raw, &task.id, None)
        .expect("the step past the bound lands too");
    assert!(
        !tripped.advance,
        "so the chain stops at one advance, exactly as it does for the canonical \
         spelling"
    );
    assert_eq!(tripped.stop, Some(ChainStop::MaxSteps));
}
