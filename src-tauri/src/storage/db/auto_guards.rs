//! The **auto-chain guard** subject of `db`: the two per-Space bounds an
//! auto-advance chain is measured against, and the two fallbacks that govern a
//! Space whose owner never configured one.
//!
//! WHY THIS SUBJECT EXISTS AT ALL. The board's Stage configuration has become a
//! workflow graph, and a column flagged `auto` advances its own card when the
//! Session launched on it settles — an unattended chain of LLM Sessions, i.e. an
//! unbounded spend risk. THE RUNTIME THAT ACTS ON THESE GUARDS SHIPPED: it is
//! `advanceWorkflowChainOnSettle` in `src/store/workflowChain.ts`, and it does not
//! read them directly — it reads them through the verdict `Db::workflow_run_step`
//! answers, because the two fallbacks below are Rust-only on purpose. What this
//! sibling owns is the half that runtime cannot hold: a bound that can be SET and
//! CLEARED per Space. Guards you
//! cannot read are not guards.
//!
//! WHY ITS OWN FILE (ADR 0113): `storage/db/` splits by SUBJECT, not by table —
//! `board.rs` reads four tables, `stages.rs` owns one. This is a new subject, so it
//! gets a new sibling, and `tests/` grows the mirror child.
//!
//! WHY THE GUARD READ IS NOT IN [`super::rows`]: `rows` is the positional read
//! registry — every struct there has ONE `*_COLUMNS` const and ONE positional
//! `get` ladder, and the arity ties plus the drift-guard tests exist to keep that
//! pair from being edited apart. The guards are not read that way: `spaces` is
//! read here through a two-column projection spelled at its one call site (the
//! guards are two columns of a four-column-registry table that `SPACE_COLUMNS`
//! deliberately does not carry, exactly as `board_strict` is not). A struct in
//! `rows` without a `*_COLUMNS` const would be the registry's one exception, and
//! the drift guards would silently stop covering it. The `workflow_runs` row and
//! its projection live in [`super::workflow_runs`] for the same reason.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction can
// leave genuinely unusable — so these sites panic rather than recover. The rule and
// the in-repo worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::seams::space_key;
use super::{Db, DbError};

/// The two per-Space auto-chain guards, as stored.
///
/// Both fields are `Option` because both columns are nullable and both NULLs mean
/// the same thing: "this Space never configured a guard, so the shipped fallback
/// governs" ([`DEFAULT_AUTO_MAX_STEPS`] / [`DEFAULT_AUTO_CEILING_USD`], just below).
/// A `Some(0)` / `Some(0.0)` is a DIFFERENT answer — a person set the
/// bound, and the bound is "no auto-chaining" / "no spend" — so the two states are
/// never collapsed anywhere in this file. That is ADR 0082's `sessions.cost_usd`
/// discipline applied to the thing it is meant to bound.
///
/// A pair rather than two one-column verbs, because the two are one decision a
/// person makes in one editor step ("how far, and up to how much"), and a caller
/// that had to read them separately could read them at different moments and see a
/// pair that was never configured.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoGuards {
    /// The step bound: how many auto-advances ONE chain may take. `None` = not
    /// configured → [`DEFAULT_AUTO_MAX_STEPS`].
    pub max_steps: Option<i64>,
    /// The cost ceiling in USD: how much ONE chain may spend. `None` = not
    /// configured → [`DEFAULT_AUTO_CEILING_USD`].
    pub ceiling_usd: Option<f64>,
}

/// The step bound an UNCONFIGURED Space gets: **20 auto-advances per chain**.
///
/// Twenty ADVANCES, counting the way [`AutoGuards::max_steps`] does: a chain under
/// this fallback may take twenty steps and the twenty-first is the one refused.
///
/// This is the FALLBACK the runtime applies when a Space's `auto_max_steps`
/// column is `NULL` — it is NOT a value any verb stores, and `auto_guards` never
/// substitutes it (the read reports the stored state, `None` included, so the
/// editor can tell "unset" from "set to 20"). It is a DELIBERATE SHIPPED DEFAULT,
/// not an "unlimited" sentinel: a Space whose owner never opened the guard editor
/// is still BOUNDED. That is the whole reason the fallback lives in code rather
/// than as a SQL `DEFAULT` — the column's `NULL` has to stay meaningful (see both
/// gates in `Db::open`), and a fallback constant is the one place the answer to
/// "then what is the limit?" can live without flattening the two states.
///
/// Why 20 and not more: a chain is one LLM Session per step, so the bound is a
/// wall-clock and spend bound at once, and 20 is well past any workflow a person
/// would design deliberately (the shipped board has five columns) while staying
/// small enough that a runaway loop stops inside one sitting rather than one
/// overnight. Why not less: a real multi-column workflow with a compaction per hop
/// reaches single digits quickly, and a bound that trips on legitimate work trains
/// people to switch auto-chaining off entirely.
pub const DEFAULT_AUTO_MAX_STEPS: i64 = 20;

/// The cost ceiling an UNCONFIGURED Space gets: **$10.00 per chain**.
///
/// The same fallback relationship to `spaces.auto_ceiling_usd` as
/// [`DEFAULT_AUTO_MAX_STEPS`] has to `auto_max_steps` — applied when the column is
/// `NULL`, never stored, never substituted by a read — and the same "a deliberate
/// shipped default, not unlimited" rule: an unset Space still has a ceiling.
///
/// Why $10 and not more: it is the number that makes the worst case of an
/// unattended loop a rounding error next to the cost of the manual work it
/// replaces, and the step fallback above is already the tighter of the two bounds
/// for ordinary models — the ceiling exists to catch the expensive case (a long
/// context, a frontier model) where 20 steps is NOT the binding constraint. Why
/// not less: a legitimate multi-hop chain that compacts on every hop can spend a
/// real dollar or two, and a ceiling that trips mid-chain wastes the whole chain's
/// spend while producing nothing.
pub const DEFAULT_AUTO_CEILING_USD: f64 = 10.0;

impl Db {
    // ── The two per-Space guards ───────────────────────────────────────────
    //
    // A READ/WRITE PAIR over two gated columns on `spaces`, in the shape
    // `set_board_strict`/`board_strict` set two files over. Both verbs key through
    // [`space_key`] and both take the connection lock ONCE.

    /// Read one Space's auto-chain guards.
    ///
    /// Keyed by `space_key` with the raw fallback — the exact rule
    /// [`Db::set_board_strict`] and [`Db::board_strict`] use, and for the exact
    /// reason they give: the read and the writer must agree on ONE key rule or the
    /// two disagree about the same Space, and here the disagreement is a bound the
    /// editor shows and the runtime never sees (a Space configured to stop at 5
    /// steps chaining 20 because the write landed on the raw spelling of the folder
    /// and the read looked up the canonical one). `upsert_space` stores the
    /// CANONICAL path, so canonical-with-raw-fallback is the only rule that reaches
    /// the row.
    ///
    /// A missing `spaces` row answers BOTH fields `None` and `Ok` — the
    /// `board_strict` shape, where absence is an answer rather than a failure. It
    /// is the ordinary state (a board is reachable for a Space with no bookkeeping
    /// row), and `None` is the fallback constants' trigger, so an absent row is
    /// BOUNDED, not unbounded.
    ///
    /// Takes the lock and hands it to [`Db::auto_guards_on`], which holds the read
    /// itself — the split exists so `workflow_run_step` can make the SAME read
    /// inside the lock it already holds rather than re-locking (the connection
    /// mutex is not reentrant, so a verb that called this one while holding the
    /// guard would deadlock rather than read, and a second lock would read a bound
    /// that was not in force during the step it governs).
    pub fn auto_guards(&self, space_path: &str) -> Result<AutoGuards, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        Self::auto_guards_on(&guard, space_path)
    }

    /// The guard projection, read on a connection the caller already holds. The
    /// read half of [`Db::auto_guards`]'s contract, spelled on `&Connection` so a
    /// verb that is mid-lock can use it: the key rule, the projection and the
    /// no-row answer are ONE thing, and two spellings of them is how the editor's
    /// bound and the enforced bound become different numbers.
    ///
    /// Visibility is the widened-but-not-`pub` one, and taking `&Connection`
    /// rather than `&self` ON PURPOSE — a public `&self` form would re-enter the
    /// mutex (see above), and a public form in general would offer a second way to
    /// read guards to a caller that should be calling [`Db::auto_guards`]. That
    /// middle visibility is the ADR 0113 sibling rule, not a widening for its own
    /// sake: a sibling may not read a sibling's private item, and
    /// [`Db::workflow_run_step`] holds the one lock this read has to ride, so it is
    /// the only caller outside this file.
    pub(super) fn auto_guards_on(
        guard: &rusqlite::Connection,
        space_path: &str,
    ) -> Result<AutoGuards, DbError> {
        let key = space_key(space_path).unwrap_or_else(|| space_path.to_string());
        // `QueryReturnedNoRows` is matched EXPLICITLY (the `session_cost`
        // precedent) rather than folded into a `query_map(..).next()`: once the
        // mapper can error, a chain makes "row present but unreadable"
        // indistinguishable from "no such row", and here those two differ — one is
        // `None`/`None`, the other is a bug worth hearing about.
        let row = guard.query_row(
            "SELECT auto_max_steps, auto_ceiling_usd FROM spaces WHERE path = ?1",
            params![key],
            |row| {
                Ok(AutoGuards {
                    max_steps: row.get::<_, Option<i64>>(0)?,
                    ceiling_usd: row.get::<_, Option<f64>>(1)?,
                })
            },
        );
        match row {
            Ok(guards) => Ok(guards),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(AutoGuards {
                max_steps: None,
                ceiling_usd: None,
            }),
            Err(e) => Err(e.into()),
        }
    }

    /// Set or clear one Space's auto-chain guards.
    ///
    /// `Option` on BOTH parameters, so each guard is settable AND clearable, and
    /// `None` writes NULL. That is the deliberate difference from
    /// [`Db::set_stage_next`], whose plain slice is a recorded accepted defect: a
    /// configured value can never be un-configured through it, because `[]` and
    /// `NULL` are unrecoverable from each other once written. A spend bound a person
    /// set by mistake has to be removable, so this verb does not repeat that.
    ///
    /// The two columns are written together from one statement, which is what makes
    /// "clear one, keep the other" expressible at all: the caller passes the pair it
    /// wants stored, and whatever it passes is exactly what lands. There is no
    /// `COALESCE`-style "keep what is there" arm — under this signature `None` means
    /// WRITE NULL, never "leave it alone" (that conflation is what `edit_task`'s
    /// [`super::FieldPatch`] exists to break; here the caller holds the whole pair,
    /// so it does not need a third state).
    ///
    /// A missing `spaces` row is a SILENT `Ok(())` no-op: the guards live on the
    /// board, the board is reachable for a Space with no row (a Detached Space, and
    /// every board test in the tree), and a write that cannot land on a row that does
    /// not exist must not fabricate one — a folder with no bookkeeping row would
    /// otherwise gain one from a settings edit. The silence is [`Db::record_session_cost`]'s
    /// shape and its documented trap (the CALLER must ensure the row); the keying is
    /// [`Db::set_board_strict`]'s, and the one thing taken from that verb is the
    /// DISCARD of the matched-row count, which it returns and this drops because the
    /// command's signature is `→ ()` and the read answers the only follow-up question
    /// ("what does this Space hold now?") for both the row-having and the rowless case.
    ///
    /// NO validation of the values, deliberately: a negative bound stores and reads
    /// back verbatim, because whether a number is SANE is the editor's question and
    /// the runtime's, not storage's (the `set_stage_prompt_prefix` argument —
    /// refusing a value the wire does not forbid is storage inventing a rule).
    pub fn set_auto_guards(
        &self,
        space_path: &str,
        max_steps: Option<i64>,
        ceiling_usd: Option<f64>,
    ) -> Result<(), DbError> {
        let key = space_key(space_path).unwrap_or_else(|| space_path.to_string());
        // One statement, one lock. Both columns move together so a caller that
        // clears one cannot lose the other by omission of a statement.
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE spaces SET auto_max_steps = ?2, auto_ceiling_usd = ?3 WHERE path = ?1",
            params![key, max_steps, ceiling_usd],
        )?;
        // A missing row matches zero rows and `execute` reports `Ok(0)`, which this
        // discards — the silent no-op the doc above argues for.
        Ok(())
    }
}
