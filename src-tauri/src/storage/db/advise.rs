//! **The single decider** — one function that answers, from a Session id alone,
//! whether that Session's card advances, where to, and what it costs.
//!
//! # Why the decision lives here and not in TypeScript
//!
//! At settle time the frontend **cannot** answer "did this Session claim?".
//! `beginTurn` withdraws the claimant before the turn that answers, the ready-mark
//! feed drops anything older than the last clear (so a `mark_done` that lands MID-turn
//! is not painted until the turn settles), there is no board slice at all in the
//! chain's primary case, and `ready` is not in `SESSION_COLUMNS` with
//! `SessionRow`/`SessionInfo` crates.io-pinned. Rust can answer it — `sessions.ready`
//! is its own column — and it can answer it while reading the **database** rather than
//! the board slice, which is what fixes the defect this feature exists to remove: the
//! chain read the slice, the slice is populated only while the board or the canvas is
//! mounted, and those two views are mutually exclusive with `ChatStream` — exactly the
//! case an unattended chain settles in. Measured against that: `workflow_runs` held
//! **0 rows** against 456 Sessions created in a week.
//!
//! # Why the answer is data and not a launch
//!
//! Rust cannot launch, and that is measured rather than stylistic: `grep -rn
//! "crate::agent" src-tauri/src/storage/` yields one hit, a comment — `storage` never
//! names `crate::agent`. The boost needs a `SessionManager` this layer cannot name, so
//! [`crate::storage::MoveOutcome::on_enter`] and
//! [`crate::storage::MoveToolOutcome::note`] both return a fact as **data** for the
//! same reason. This follows them one field further: the answer carries the
//! instruction, and the frontend acts on it.
//!
//! # ONE lock for the whole read→step→read
//!
//! Every read below takes `&Connection` from the guard this verb holds, and none of
//! them takes a lock of its own. [`Db::conn`] is a `StdMutex<Connection>` and **the
//! mutex is not reentrant** — ADR 0119 §2: *"the connection mutex is not reentrant, so
//! a verb that called the public one while holding the guard would deadlock rather
//! read"*. So `card_of_session`, `auto_guards`, `list_stages` and `get_board` are all
//! BANNED inside this function, and the failure they would produce is a **hung test
//! binary**, not an `Err` — which is why the rule is stated here instead of left to a
//! red. The one lock is not merely permitted, it is required: [`Db::workflow_run_step`]
//! argues that a second lock around its read-then-write "would be TOCTOU with a spend
//! counter on the other side of the race", and the same argument binds harder here,
//! where a LAUNCH sits on the other side of it.
//!
//! # THE ARM ORDER, and why it is load-bearing
//!
//! The ceiling is evaluated **read-only, before** the dedupe's early return, and the
//! **step increment stays behind** the dedupe. Put the dedupe first and the ceiling
//! becomes unreachable on the only path that carries a real cost figure — the
//! claim-then-settle path, where arm 3 returns early — which is the same never-trips
//! fail-open D18 was written to close, reintroduced by arm ordering instead of by a
//! `None`.
//!
//! In one sentence each: **the ceiling is a read of money already spent, so it is
//! always safe and always informative; the step is a write that buys the next launch,
//! so it must not be spent twice for one link.**
//!
//! The shape that makes that ordering implementable without contorting the arms is
//! **all reads first, then the early returns in the mandated order**. The dedupe needs
//! the destination and the destination needs the graph, so both are resolved as reads
//! before any arm returns; the ceiling still returns ahead of the dedupe, and the step
//! is still the last write before the answer. The order of the DECISIONS is:
//!
//! | # | Question | `advance: false` answer |
//! |---|---|---|
//! | 0 | Does this Session own a card? | `unlinked` |
//! | 1 | Was the claim made (`ready` is `Some(1)` — not `0`)? | `unclaimed` |
//! | 2 | **CEILING (read-only, writes nothing)** | `stop: cost_ceiling` |
//! | 3 | Has this link already launched? (D17, two scopes) | `already_advanced` |
//! | 4 | Is the launched column `auto`? | `not_automatic` |
//! | 5 | Does an edge resolve a destination at all? | `no_next_stage` |
//! | 6 | **STEP (the write)** past its bound? | `stop: max_steps` |
//! | 7 | Emit the destination, the card identity, `alreadyLaunched` | — |
//!
//! Arm 1's `Some(1)` **only** is its own decision: the turn-start write puts `0` on
//! every Session that has ever run a turn, so `0` is not evidence a claim was ever
//! made — it is evidence the opposite. Reading `!= 1` as "claimed" would make every
//! un-claimed settle move a card, which is D4's whole refusal.
//!
//! Arm 3's two scopes must not be collapsed. The lower bound is **Session**-scoped
//! (`MAX(rowid)` for the claimer, which is the row [`super::session_card`] resolved,
//! which is why that read returns it). The row it searches for is **card**-scoped,
//! because the launch a successful advance records links the *newly started* Session
//! and not the claimer. A one-scope reading makes this arm **dead**: since the
//! newest-link rule makes the claimer's own row the newest for that Session, a
//! Session-scoped search can never satisfy `rowid > own`.
//!
//! # What this function never does
//!
//! It never launches, never emits an event, never writes `sessions.ready`, and never
//! reads a `session_id` or a `task_id` out of the caller's `params` — the identity it
//! acts on arrives on the frame. It writes exactly one thing: the step, at arm 6.

use rusqlite::{params, Connection};

use super::rows::{stage_row_from, STAGE_COLUMNS};
use super::session_card::card_of_session_on;
use super::workflow_runs::ChainStop;
use super::{
    AdvanceAdvice, BoardError, Db, DbError, StageRow, DEFAULT_AUTO_CEILING_USD,
    DEFAULT_AUTO_MAX_STEPS,
};

/// Why an advance did not happen, as the `reason` field spells it.
///
/// OWNED HERE rather than left as free text at each arm, because these strings cross
/// the wire and Task 4 branches on them: `already_advanced` is a SILENT no-op (do not
/// close the run — closing hands the next link a fresh `steps = 1` run and turns a
/// 20-step bound into 20 steps per link) while every other refusal closes and speaks.
/// A spelling that drifts is a spend bound failing open, so the arms cannot invent.
///
/// `no_next_stage` covers two shapes and says the same true thing about both: no edge
/// out of the launched column (it is configured `[]`, or unconfigured with a `sort_order`
/// HOLE where the `sort_order + 1` neighbour used to be), and no launched column to
/// resolve an edge from at all (a link whose frozen slug a `delete_stage` removed). In
/// both, there is no column to advance to.
///
/// `advanced` vs `advanced_unnamed_edge` is the outcome-selection answer, and the
/// distinction is exactly ONE case wide: the first is "the edge you named fired, or you
/// named nothing and the head did", the second is "you named an edge this board does not
/// have, so the head fired INSTEAD". Both advance — an invented outcome must not stall a
/// chain, because an unlabelled board is the ordinary case — and the difference belongs
/// in `reason` because it is the only field that can carry it. A claim that named
/// nothing is NOT the second case: hedging every ordinary advance would train a reader
/// to ignore the hedge.
///
/// NONE of these spellings is in `ChainStop`'s vocabulary except where `stop` says so,
/// and that is deliberate: `max_steps`, `cost_ceiling` and `no_next_stage` ARE chain
/// stops and ride the shared enum; the Session-shaped refusals are not, and inventing a
/// variant for each would be an enum change plus a migration to spell what a string
/// already says.
const REASON_UNLINKED: &str = "unlinked";
const REASON_UNCLAIMED: &str = "unclaimed";
const REASON_ALREADY_ADVANCED: &str = "already_advanced";
const REASON_NOT_AUTOMATIC: &str = "not_automatic";
const REASON_NO_NEXT_STAGE: &str = "no_next_stage";
const REASON_MAX_STEPS: &str = "max_steps";
const REASON_COST_CEILING: &str = "cost_ceiling";
const REASON_ADVANCED: &str = "advanced";
const REASON_ADVANCED_UNNAMED_EDGE: &str = "advanced_unnamed_edge";

impl Db {
    /// Decide what this Session's `mark_done` claim does to its card.
    ///
    /// The input is the **Session id and nothing else** (D16), because that is all
    /// `mark_done` holds: no Space, no card, no launching column, no cost figure. Both
    /// callers — the claim and the settle fallback — ask this one question of this one
    /// function, so they cannot disagree about the answer.
    ///
    /// `outcome` is the model's optional edge name. `None` takes the head of the
    /// column's edge list, exactly as the chain does today; `Some(x)` takes the first
    /// edge whose `next_outcomes` entry is `x`, falling back to the head (and saying so
    /// in `reason`) when nothing matches.
    ///
    /// `cost_delta_usd` is the caller's cost figure, and it is the ONLY reason the
    /// ceiling can trip at all: `None` means the fold adds nothing, so the comparison
    /// runs against whatever `cost_usd` earlier settles banked on the open run. That is
    /// NOT a no-op — a claim at link 3 with $12 banked against a $10 ceiling trips
    /// BEFORE that link launches. There is no `?? 0` anywhere on this path, and that is
    /// ADR 0082: `COALESCE(cost_usd, 0.0) + 0` turns "unbilled" into "billed zero" and
    /// permanently arms a ceiling that was written to stay unarmed until money appears.
    ///
    /// Returns `BoardError` and not `DbError`, as decided: every helper this calls
    /// already answers `BoardError`, its `Display` is already the model-facing sentence
    /// factory, and `DbError` stays three-variant because it is the crate seam's type
    /// (that type's own header argues the case at length). The one `DbError` this
    /// function can meet — the step verb's — converts once, below.
    pub fn workflow_advance_advice(
        &self,
        session_id: &str,
        outcome: Option<&str>,
        cost_delta_usd: Option<f64>,
    ) -> Result<AdvanceAdvice, BoardError> {
        // ONE lock, held to the end of the read→step→read. See the module header for
        // why it is one and why nothing inside may take another.
        let guard = self.conn.lock().expect("db mutex poisoned");
        decide(&guard, session_id, outcome, cost_delta_usd)
    }
}

/// The decider, on a connection the caller holds.
///
/// Split out from [`Db::workflow_advance_advice`] so the D21 rule is checkable by
/// reading ONE function with no lock statement in it: every call below takes `&conn`,
/// and the absence of a `self.` call in this body is the whole proof.
fn decide(
    conn: &Connection,
    session_id: &str,
    outcome: Option<&str>,
    cost_delta_usd: Option<f64>,
) -> Result<AdvanceAdvice, BoardError> {
    // ── arm 0: the card ───────────────────────────────────────────────────────
    //
    // The newest link wins, on the same rule `Db::task_numbers()` runs, so the badge a
    // person sees and the chain this decides for can never name different cards.
    let Some(card) = card_of_session_on(conn, session_id)? else {
        // No card, so no Space, so no bound to measure against. Every number in this
        // answer is `None` rather than the shipped fallback, because reporting "20
        // steps" here would be reporting a bound for a Space that was never resolved —
        // the move `Db::workflow_run_step` refuses for the same shape.
        return Ok(AdvanceAdvice {
            advance: false,
            stop: None,
            destination: None,
            reason: REASON_UNLINKED.to_string(),
            max_steps: None,
            ceiling_usd: None,
            task_id: None,
            space_path: None,
            already_launched: false,
        });
    };
    let task_id = card.task_id.clone();
    let space_path = card.space_path.clone();

    // ── the reads every later arm needs, all before any early return ──────────
    //
    // Hoisted, not interleaved: the ceiling has to be able to answer ahead of the
    // dedupe (D20) and the dedupe needs the destination, so a strictly arm-by-arm
    // reading cannot produce both. Hoisting the READS is what keeps the ORDER of the
    // DECISIONS exactly as the table in the module header states it while the writes
    // stay where they belong — one, at arm 6.

    // The Space's columns, in board order, in ONE read. This is the destination-stage
    // read the plan offers two ways to do; it is done INLINE here with `STAGE_COLUMNS`
    // + `stage_row_from` rather than by widening `stages`' private `stage_row_by_slug`,
    // because one pass over the Space's dozen-odd rows supplies BOTH the launched
    // column and the `sort_order + 1` fallback's neighbour map, which a by-slug read
    // would need a second statement for.
    let stages = space_stages(conn, &space_path)?;
    let launched = card
        .launched_slug
        .as_deref()
        .and_then(|slug| stages.iter().find(|s| s.slug == slug));

    // The edge, and whether the caller's `outcome` named it.
    // `edge_fell_back` is true ONLY when the caller named an edge and this board has
    // no edge labelled with it — the one case that earns the hedge in `reason`.
    let (edge_slug, edge_fell_back) = match launched {
        Some(from) => match pick_edge(from, &stages, outcome) {
            Some((slug, fell_back)) => (Some(slug), fell_back),
            None => (None, false),
        },
        None => (None, false),
    };
    let destination = edge_slug
        .as_deref()
        .and_then(|slug| stages.iter().find(|s| s.slug == slug));

    // Arm 3's dedupe READ — and both scopes, spelled separately.
    //
    // `own_link_rowid` is the MAX(rowid) for THIS Session (arm 0 resolved it, which is
    // why the read carries it); the search is over the CARD, because the launch this
    // detects links a DIFFERENT Session.
    let already_launched = match (destination, launched) {
        (Some(dest), _) => launched_link_ahead(conn, &task_id, &dest.slug, card.own_link_rowid)?,
        // Nothing to advance to, so nothing can have advanced.
        (None, _) => false,
    };

    // The two bounds, read for the numbers the answer must carry. A missing `spaces`
    // row answers `None`/`None` and takes the shipped fallbacks, so an unset Space is
    // BOUNDED and not unlimited.
    let guards = Db::auto_guards_on(conn, &space_path).map_err(advice_error)?;
    let max_steps = guards.max_steps.unwrap_or(DEFAULT_AUTO_MAX_STEPS);
    let ceiling_usd = guards.ceiling_usd.or(Some(DEFAULT_AUTO_CEILING_USD));

    // ── arm 1: was the claim made? (D4) ───────────────────────────────────────
    //
    // `Some(1)` ONLY. `0` is what the turn-start write puts on every Session that has
    // ever run a turn, and `None` is what every Session that was never marked holds;
    // neither is evidence anybody claimed anything.
    if !claimed(conn, session_id)? {
        return Ok(AdvanceAdvice {
            advance: false,
            stop: None,
            destination: None,
            reason: REASON_UNCLAIMED.to_string(),
            max_steps: Some(max_steps),
            ceiling_usd,
            task_id: Some(task_id),
            space_path: Some(space_path),
            already_launched,
        });
    }

    // ── arm 2: THE CEILING — read-only, before the dedupe (D18 + D20) ─────────
    //
    // WRITES NOTHING. Does not touch `steps`. It must sit here, ahead of arm 3's early
    // return, because on the claim-then-settle path arm 3 returns early and after Task 4
    // replaces `workflowRunStep` this is the only ceiling evaluation left in the tree.
    //
    // The comparison is `workflow_run_step`'s own, mirrored so the two agree: fold the
    // caller's delta over the banked figure the way BOTH of that verb's write arms do
    // (`Some` delta → `COALESCE(cost, 0.0) + delta`, which is also exactly what the
    // INSERT arm stores; `None` delta → the banked figure untouched, and a `None` never
    // trips), then `>=`.
    let banked = open_run_cost(conn, &task_id)?;
    let spend = match cost_delta_usd {
        Some(delta) => Some(banked.unwrap_or(0.0) + delta),
        None => banked,
    };
    if ceiling_usd.is_some_and(|ceiling| spend.is_some_and(|spent| spent >= ceiling)) {
        return Ok(AdvanceAdvice {
            advance: false,
            stop: Some(ChainStop::CostCeiling),
            destination: None,
            reason: REASON_COST_CEILING.to_string(),
            max_steps: Some(max_steps),
            ceiling_usd,
            task_id: Some(task_id),
            space_path: Some(space_path),
            already_launched,
        });
    }

    // ── arm 3: already advanced? (D17) ────────────────────────────────────────
    //
    // A `task_sessions` question and not a `workflow_runs` one — that table has no
    // per-step record and no column naming a slug — and not keyed on `steps`, which
    // would kill the fallback in the exact case it exists for.
    if already_launched {
        return Ok(AdvanceAdvice {
            advance: false,
            // NOT a chain stop: nothing stopped, this link was already taken. And the
            // run must stay OPEN, which is what `already_launched: true` tells Task 4
            // to arrange.
            stop: None,
            destination: None,
            reason: REASON_ALREADY_ADVANCED.to_string(),
            max_steps: Some(max_steps),
            ceiling_usd,
            task_id: Some(task_id),
            space_path: Some(space_path),
            already_launched,
        });
    }

    // ── arm 4: is the launched column `auto`? ─────────────────────────────────
    //
    // `stages.auto` FROM THE DATABASE and not from a slice — that substitution is the
    // point of the whole design. This is the non-auto half of the done-when: the card
    // stays where it is and the amber bell stays lit for a person.
    let Some(from) = launched else {
        return Ok(not_automatic(&task_id, &space_path, max_steps, ceiling_usd));
    };
    if !from.auto {
        return Ok(not_automatic(&task_id, &space_path, max_steps, ceiling_usd));
    }

    // ── arm 5: is there a destination at all? ─────────────────────────────────
    //
    // Three shapes reach this and all three answer the same true sentence: the column
    // is configured `[]`; it is unconfigured and a deleted column left a HOLE at
    // `sort_order + 1`; or the link's frozen slug names a column that is gone.
    let Some(dest) = destination else {
        return Ok(AdvanceAdvice {
            advance: false,
            stop: Some(ChainStop::NoNextStage),
            destination: None,
            reason: REASON_NO_NEXT_STAGE.to_string(),
            max_steps: Some(max_steps),
            ceiling_usd,
            task_id: Some(task_id.clone()),
            space_path: Some(space_path.clone()),
            already_launched,
        });
    };

    // ── arm 6: THE STEP — the write, behind the dedupe ────────────────────────
    //
    // `_on`, always. `Db::workflow_run_step` takes `self.conn.lock()` itself, so
    // calling it from here is a self-deadlock on a non-reentrant mutex and HANGS
    // rather than failing. And the arithmetic is NOT re-implemented here: a second copy
    // of the `steps + 1` upsert and the `>=`/`>` comparisons beside the first is two
    // spend counters that a later edit can edit apart.
    //
    // On the claim path this IS counted, and it is what actually stops an unbilled
    // chain (the ceiling cannot see one). On the settle path it is counted only because
    // the dedupe did not fire — so a link whose launch was REFUSED (no `link_session`
    // row, so no dedupe hit) spends a second step for that link. That is intended: a
    // refused launch earns a retry, and `max_steps` still bounds it.
    let verdict = match Db::workflow_run_step_on(conn, &space_path, &task_id, cost_delta_usd) {
        Ok(verdict) => verdict,
        // The one `DbError` this function can meet, converted ONCE. `Sqlite` rides
        // `BoardError::Sqlite` verbatim. The other two arms have no `BoardError`
        // equivalent — `BoardError` is a five-plus-refusal enum with no I/O carrier,
        // and `DbError` stays three-variant so no `From<DbError>` may be added to it —
        // so `ToSqlConversionFailure` is used as the carrier, which is the one
        // `rusqlite::Error` variant that holds an arbitrary boxed error. What survives
        // is what matters: both `From` impls downstream preserve `Display`, so the
        // sentence the model or the person reads is `DbError`'s own.
        Err(e) => {
            return Err(match e {
                DbError::Sqlite(e) => BoardError::Sqlite(e),
                other => {
                    BoardError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(other)))
                }
            })
        }
    };

    // The ceiling was already evaluated at arm 2 against the SAME folded figure this
    // write produces, so a ceiling in the verdict here cannot be new information and is
    // deliberately not re-reported — that would be double-counting one comparison.
    if verdict.stop == Some(ChainStop::MaxSteps) {
        return Ok(AdvanceAdvice {
            advance: false,
            stop: Some(ChainStop::MaxSteps),
            destination: None,
            reason: REASON_MAX_STEPS.to_string(),
            // The EFFECTIVE numbers the verdict was measured against, from the verdict
            // rather than re-derived — `AdvanceVerdict`'s own rule, inherited.
            max_steps: Some(verdict.max_steps),
            ceiling_usd: verdict.ceiling_usd,
            task_id: Some(task_id),
            space_path: Some(space_path),
            already_launched,
        });
    }

    // ── arm 7: the instruction ────────────────────────────────────────────────
    //
    // The destination rides WHOLE so the frontend needs no board slice: `slug`, `label`,
    // `onEnterSkill` and `promptPrefix` all come from this one row, which is ADR 0098's
    // rule that the three cannot disagree about which column was meant. The card
    // identity rides too, because `launchTaskSession(spacePath, task, toStageSlug, …)`
    // needs both and the claim path holds only a `sessionId`.
    Ok(AdvanceAdvice {
        advance: true,
        stop: None,
        destination: Some(dest.clone()),
        reason: if edge_fell_back {
            REASON_ADVANCED_UNNAMED_EDGE.to_string()
        } else {
            REASON_ADVANCED.to_string()
        },
        max_steps: Some(verdict.max_steps),
        ceiling_usd: verdict.ceiling_usd,
        task_id: Some(task_id),
        space_path: Some(space_path),
        already_launched,
    })
}

/// The `auto` refusal: the card stays and the bell stays lit.
fn not_automatic(
    task_id: &str,
    space_path: &str,
    max_steps: i64,
    ceiling_usd: Option<f64>,
) -> AdvanceAdvice {
    AdvanceAdvice {
        advance: false,
        stop: None,
        destination: None,
        reason: REASON_NOT_AUTOMATIC.to_string(),
        max_steps: Some(max_steps),
        ceiling_usd,
        task_id: Some(task_id.to_string()),
        space_path: Some(space_path.to_string()),
        already_launched: false,
    }
}

/// Every column of one Space, in board order, through the SAME [`STAGE_COLUMNS`] list
/// and mapper the board read uses.
///
/// Board order (`sort_order ASC, slug ASC`) is what `get_board` and `list_stages` use,
/// and it is what makes the `sort_order + 1` fallback's neighbour lookup agree with
/// `nextStepSlugs`' `filter(c => c.sortOrder === from.sortOrder + 1)` — which filters
/// EVERY column at that order, so a duplicated `sort_order` contributes every one of
/// its rows here too.
///
/// Reads the table as it IS. Unlike `get_board` it does not seed: this verb is a
/// decision, not a board open, and seeding from a claim would give a Space nobody
/// opened a graph it never asked for. A Space with no rows resolves no destination,
/// which is the honest answer and arm 5's.
fn space_stages(conn: &Connection, space_path: &str) -> Result<Vec<StageRow>, BoardError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM stages WHERE space_path = ?1 ORDER BY sort_order ASC, slug ASC",
        STAGE_COLUMNS.join(", ")
    ))?;
    let rows = stmt
        .query_map(params![space_path], stage_row_from)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Which column this claim points at, and whether the head fired IN PLACE OF a named
/// edge.
///
/// The returned tuple's second flag is `fell_back`, and it is `true` on exactly ONE
/// path: the caller named an outcome and this board has no edge labelled with it. Naming nothing and taking the head is the
/// ordinary case — every seeded board is one — and reporting it as a fallback would put
/// a hedge in the sentence of every claim the feature exists to serve.
///
/// `None` is "no destination", and the three shapes that produce it are arm 5's.
/// Infallible: it reads only the rows the caller already fetched.
/// `StageRow::next_slugs` is ALREADY the lenient decode — `stage_row_from` runs
/// [`super::stages::lenient_next_slugs`] at index 6 — so a cell a foreign writer left
/// unparseable has arrived here as `None` = "unconfigured", which is exactly the reading
/// the fallback wants and the same one the frontend gets, since such a cell crosses the
/// wire as absent. This function therefore never re-parses a raw cell.
///
/// `forward_reachable` is imported for the reason stated at the bottom of this
/// function's doc block: the edge this picks is the same graph the forward gate
/// refuses a model's `move_task` over, and both must read it the same way.
fn pick_edge(
    from: &StageRow,
    stages: &[StageRow],
    outcome: Option<&str>,
) -> Option<(String, bool)> {
    // The edge list, with the D15 fallback standing in for an UNCONFIGURED column.
    //
    // `[]` is a value and not a gap — a column configured to lead nowhere contributes
    // nothing and the fallback does NOT fire over it. That is `nextStepSlugs`'s `??`
    // and not `||`, and ADR 0099's whole argument that `[]` and `NULL` are different
    // states. The fallback is `sort_order + 1`, and NOTHING when a deleted column left
    // a hole there — the same hole TypeScript has, which is why the two sides still
    // answer one card identically. Widening this to `> sort_order` would "fix" the hole
    // and silently diverge from `nextStepSlugs`; the hole is pinned, not fixed.
    let edges: Vec<String> = match from.next_slugs.as_ref() {
        Some(edges) => edges.clone(),
        None => stages
            .iter()
            .filter(|s| s.sort_order == from.sort_order + 1)
            .map(|s| s.slug.clone())
            .collect(),
    };
    if edges.is_empty() {
        return None;
    }

    // The three cases, and the `fell_back` flag each one carries.
    //
    //   - NO outcome named → the head, `fell_back: false`. This is every seeded board
    //     and every claim that does not use the parameter; hedging it would put a
    //     qualifier in the sentence of the ordinary case.
    //   - An outcome named, and an edge labelled with it → that edge, `false`.
    //   - An outcome named, and NOTHING labelled with it → the head, `true`. This is
    //     the only case the reason's hedge is for, and it falls back rather than
    //     refusing because an unlabelled board is the ordinary case and a model that
    //     invents an edge name must not be able to stall a chain.
    let head = || edges.first().cloned();
    let Some(wanted) = outcome else {
        return head().map(|slug| (slug, false));
    };

    // The first edge whose LABEL is the caller's outcome. A short `next_outcomes` cell
    // means "the edges past its end are unlabelled" — the reading `StageRow`'s own doc
    // states — so `.get(i).and_then(|o| o.as_ref())` is the whole rule, no padding.
    let labelled = from.next_outcomes.as_ref().and_then(|labels| {
        edges.iter().enumerate().find_map(|(index, slug)| {
            labels
                .get(index)
                .and_then(|label| label.as_ref())
                .filter(|label| *label == wanted)
                .map(|_| slug.clone())
        })
    });

    labelled
        .map(|slug| (slug, false))
        .or_else(|| head().map(|slug| (slug, true)))
}

/// Has a link to this card at this destination been written SINCE the claimer's own?
///
/// `rowid` is SQLite's insert-order counter, so "greater than" is "written later", and
/// the bound is the claimer's own row: a link written before the claim cannot be the
/// launch this claim caused.
///
/// `stage_slug` is compared to the DESTINATION and not to the card's current column,
/// because `task_sessions.stage_slug` is the FROZEN lane — where a Session was launched,
/// not where the card sits now. `launchTaskSession` moves the card and THEN links the
/// new Session at the destination, so a successful advance is exactly a row at
/// `stage_slug = destination` with a newer `rowid`.
fn launched_link_ahead(
    conn: &Connection,
    task_id: &str,
    destination: &str,
    own_link_rowid: i64,
) -> Result<bool, BoardError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_sessions \
         WHERE task_id = ?1 AND stage_slug = ?2 AND rowid > ?3",
        params![task_id, destination, own_link_rowid],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

/// Was the claim made? `sessions.ready` is `Some(1)` and nothing else.
///
/// Three meanings live in that one nullable column and the absence of a `DEFAULT` is
/// what keeps them three (the column's own DDL comment states it): `NULL` = never
/// claimed, `0` = checked and not claiming, `1` = claimed. Only the third is a claim.
///
/// `QueryReturnedNoRows` — a Session id with no row — is `false` and not an error: the
/// advice is asked about a Session, and "there is no such Session, so nobody claimed"
/// is the answer to the question that was asked. `mark_done`'s own answer is the place
/// that reports a row it failed to write.
fn claimed(conn: &Connection, session_id: &str) -> Result<bool, BoardError> {
    let ready: Option<i64> = match conn.query_row(
        "SELECT ready FROM sessions WHERE id = ?1",
        params![session_id],
        |row| row.get::<_, Option<i64>>(0),
    ) {
        Ok(ready) => ready,
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(e.into()),
    };
    Ok(ready == Some(1))
}

/// The open run's banked figure, for the ceiling's read-only comparison.
///
/// `None` covers both "no open run" and "`cost_usd` is NULL", and both mean the same
/// thing to a ceiling: no figure, nothing to compare, never trips. That is the
/// limitation [`crate::storage::AdvanceVerdict::ceiling_usd`] exists to announce,
/// inherited whole — the step bound is what stops an unbilled chain.
fn open_run_cost(conn: &Connection, task_id: &str) -> Result<Option<f64>, BoardError> {
    let cost: Option<Option<f64>> = match conn.query_row(
        "SELECT cost_usd FROM workflow_runs WHERE task_id = ?1 AND finished_at IS NULL",
        params![task_id],
        |row| row.get::<_, Option<f64>>(0),
    ) {
        Ok(cost) => Some(cost),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(e.into()),
    };
    Ok(cost.flatten())
}

/// The one conversion out of the guard-read family. `auto_guards_on` answers `DbError`
/// (it reads `spaces`, which is not a board table) and is not this file's to re-shape.
fn advice_error(e: DbError) -> BoardError {
    match e {
        DbError::Sqlite(e) => BoardError::Sqlite(e),
        other => BoardError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(other))),
    }
}

// # Why this does NOT call [`super::edges::forward_reachable`]
//
// The forward gate and this decider read the SAME two columns with the SAME fallback,
// and they ask DIFFERENT questions. The gate asks "is the destination reachable from
// here?" and refuses a model's `move_task` when it is. This asks "which column does the
// head edge — or the edge the caller named — point at?", and by construction the answer
// is one edge away, so it is always reachable and a reachability test would be a walk
// whose answer is known before it starts.
//
// What they must share is the FALLBACK RULE, not a call, and `pick_edge` states that
// obligation where it implements it: `[]` is a value and not a gap, `NULL` contributes
// the `sort_order + 1` neighbour, and a HOLE there resolves nothing — matching
// `forward_reachable` and `nextStepSlugs` exactly. A change to one is a change to all
// three, or the two doors disagree about the same card in production.
