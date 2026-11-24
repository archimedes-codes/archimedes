//! The **`workflow_runs` record** subject of `db`: the row an auto-advance chain
//! counts its steps and its spend against, and the verdict a step answers with.
//!
//! WHY THIS SUBJECT EXISTS AT ALL. A column flagged `auto` advances its own card
//! when the Session launched on it settles — an unattended chain of LLM Sessions,
//! i.e. an unbounded spend risk. THE RUNTIME THAT ACTS ON IT SHIPPED: it is
//! `advanceWorkflowChainOnSettle` in `src/store/workflowChain.ts`, which drives one
//! hop per Session settle and obeys the verdict this file's step verb answers with.
//! What this sibling owns is the half that runtime cannot hold: a step/cost record
//! that makes a chain countable, and the bound judgement made beside it — because the
//! two fallback bounds are Rust-only on purpose and a TypeScript enforcement point
//! would have to copy them. A limit you cannot count against is a wish.
//!
//! WHY ITS OWN FILE (ADR 0113): `storage/db/` splits by SUBJECT, not by table —
//! `board.rs` reads four tables, `stages.rs` owns one. This is a new subject, so it
//! gets a new sibling, and `tests/` grows the mirror child. The two per-Space
//! guards the verdict is measured against are the other half of the workflow and
//! live in [`super::auto_guards`], beside the two fallback constants this file
//! reads.
//!
//! WHY THE ROW TYPE IS HERE AND NOT IN [`super::rows`]: `rows` is the positional
//! read registry — every struct there has ONE `*_COLUMNS` const and ONE positional
//! `get` ladder, and the arity ties plus the drift-guard tests exist to keep that
//! pair from being edited apart. `workflow_runs` has ONE projection and ONE mapper,
//! both below, used by its one read. A struct in `rows` without a
//! `*_COLUMNS` const would be the registry's one exception, and the drift guards
//! would silently stop covering it.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction can
// leave genuinely unusable — so these sites panic rather than recover. The rule and
// the in-repo worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use fulcrum_harness::clock::now_ms;

use super::auto_guards::{DEFAULT_AUTO_CEILING_USD, DEFAULT_AUTO_MAX_STEPS};
use super::seams::space_key;
use super::{Db, DbError};

/// One auto-advance chain's record: when it opened, when it stopped, how many
/// steps it took and what it cost.
///
/// The shape is the whole point of the table — a chain that leaves no row cannot
/// be bounded (the runtime has to count steps somewhere) and cannot be audited
/// afterwards. `finished_at` is the open/closed discriminator: `None` means the
/// chain is still running, and at most ONE row per Task may be in that state.
/// `cost_usd` keeps `NULL` = "no Session in this chain ever reported a figure"
/// distinct from `Some(0.0)` = "they reported a real zero" (ADR 0082 again), and
/// the ceiling test must not render the first as the second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunRow {
    /// The minted id (`wfr_…`), the primary key.
    pub id: String,
    /// The Space the card lives in — stored so a run is readable without joining
    /// through a `tasks` row that a `delete_space` could take with it (which is
    /// also why there is no foreign key).
    pub space_path: String,
    /// The card the chain advanced.
    pub task_id: String,
    /// Unix ms, stamped when the chain opened.
    pub started_at: i64,
    /// Unix ms, stamped when it stopped. `None` = OPEN.
    pub finished_at: Option<i64>,
    /// How many auto-advances this chain has taken. A plain counter, never NULL.
    pub steps: i64,
    /// The running figure. `None` until the first Session in the chain reports one.
    pub cost_usd: Option<f64>,
    /// Why the chain stopped, as its writer spells it. `None` while the run is open,
    /// and the reason a closed run stopped is never rewritten by a later close.
    ///
    /// THE SPELLINGS ARE CITED, NOT ENUMERATED, and that is deliberate: an
    /// enumeration retyped here is what let this doc name `"steps"` and `"ceiling"`,
    /// neither of which anything has ever written. The vocabulary is
    /// [`ChainStop::as_str`] (the four bound/edge spellings), the literal `"manual"`
    /// (a person's column took the card over), the literal `"interrupted"` (a chain a
    /// process restart orphaned, stamped by `Db::open` — the only `stop_reason` Rust
    /// writes), and a verbatim `StopReason` from the settle edge (`"cancelled"`, …).
    /// ADR 0119 §3 argues this is ONE vocabulary; `the_chain_stop_spellings_are_frozen`
    /// is the pin that owns it.
    pub stop_reason: Option<String>,
}

/// Why an auto-chain stopped.
///
/// THE VOCABULARY IS SHARED with `workflow_run_close`'s `stop_reason` column: a
/// run's narrative and the verdict that produced it are spelled from ONE list, so
/// a person reading a closed chain's reason can match it to the bound that
/// produced it. That sharing is also why two of these four variants have no
/// producer in this file at all — see the variant docs.
///
/// WHY THE ENUM EXISTS WHEN `workflow_run_step` emits two of its four arms. The
/// Db cannot see the frontend's board slice, so it cannot know a column had no
/// next column (`NoNextStage`); and it cannot know whether the launch the
/// settle-handler attempted was refused (`LaunchRefused`). Both are computed on
/// the TypeScript side and passed to `workflow_run_close` as its `stop_reason`,
/// which is why they live HERE rather than in a TS-only union: the column and the
/// verdict must not be spelled from two lists. An enum variant no producer emits
/// is not dead code in this shape — it is the half of a vocabulary owned by the
/// other side of the wire. `the_chain_stop_spellings_are_frozen` pins all four
/// spellings for exactly that reason.
///
/// SERDE AND `as_str()` AGREE EXACTLY, deliberately. `#[serde(rename_all =
/// "snake_case")]` (the `ClosedReason` / `StopReason` precedent in
/// `agent/session/mod.rs`) turns each unit variant into the same string `as_str()`
/// returns, so the wire form and the column form cannot drift by spelling. That is
/// a stronger promise than the one `ClosedReason` makes, where `as_str()` says
/// `agent-exited` and serde would say `agent_exited` — a divergence that file
/// records as latent because nothing deserialises it. Here the value crosses the
/// wire AND lands in a column, so the two spellings are one spelling by
/// construction, and `the_verdict_serialises_with_the_camel_case_keys_the_ts_mirror_declares`
/// pins the wire form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainStop {
    /// The column the card settled in has no next column, so there is nowhere to
    /// advance TO. **Emitted by the TypeScript settle-handler, never by
    /// [`Db::workflow_run_step`]** — the board slice lives on that side.
    NoNextStage,
    /// The chain has taken as many auto-advances as its bound allows. Emitted by
    /// [`Db::workflow_run_step`] when the post-increment `steps` has PASSED the
    /// effective `max_steps` — a bound of N permits N advances and refuses on the
    /// N+1st step, which is the arithmetic [`AutoGuards::max_steps`] promises.
    MaxSteps,
    /// The chain has spent as much as its ceiling allows. Emitted by
    /// [`Db::workflow_run_step`] when `run.cost_usd` reaches the effective
    /// ceiling — and see [`AdvanceVerdict::ceiling_usd`] for the case where the
    /// comparison cannot be made at all.
    CostCeiling,
    /// The next Session could not be launched (no Skill, a refused start, a dead
    /// worker). **Emitted by the TypeScript settle-handler, never by
    /// [`Db::workflow_run_step`]** — the launch happens on that side.
    LaunchRefused,
}

impl ChainStop {
    /// The string form: what `workflow_run_close`'s `stop_reason` column stores,
    /// and what the TS union names. Identical to the serde spelling by
    /// construction (the header above says why that matters here and where it
    /// does not).
    pub fn as_str(self) -> &'static str {
        match self {
            ChainStop::NoNextStage => "no_next_stage",
            ChainStop::MaxSteps => "max_steps",
            ChainStop::CostCeiling => "cost_ceiling",
            ChainStop::LaunchRefused => "launch_refused",
        }
    }
}

/// The answer [`Db::workflow_run_step`] gives: the row after the write, and
/// whether the chain may take another step.
///
/// WHY THE VERDICT IS COMPUTED IN RATHER THAN LEFT TO THE CALLER. The two bounds
/// it is measured against are `spaces.auto_max_steps` /
/// `spaces.auto_ceiling_usd` and the two fallbacks that apply when those columns
/// are `NULL` — and the fallbacks ([`DEFAULT_AUTO_MAX_STEPS`],
/// [`DEFAULT_AUTO_CEILING_USD`]) are Rust-only ON PURPOSE. Duplicating them into
/// the TypeScript mirror would put one policy in two places with a wire between
/// them, and the plan's original shape (enforce in TS) is what this verdict
/// corrects. So the decision is made beside the constants it reads, and the
/// caller — a settle-handler that cannot name either fallback — is handed the
/// verdict AND the effective values it was computed from.
///
/// `max_steps` and `ceiling_usd` are therefore NOT redundant with `advance`: they
/// are what lets the caller write a true sentence ("this chain hit its 20-step
/// bound", "the ceiling is $10 but unbilled sessions look free") without
/// re-deriving numbers it does not hold. Dropping them would leave the caller
/// either silent or lying.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceVerdict {
    /// The run as it is AFTER this step — the same row this verb used to be its
    /// whole return value, unchanged in meaning (the `create_task` read-back
    /// reason: what the caller gets IS what is stored).
    pub run: WorkflowRunRow,
    /// May the chain take another step? `false` means the settle-handler must
    /// close the run and stop, not that anything failed.
    pub advance: bool,
    /// Why not, when `advance` is `false`; `None` when it is `true`.
    ///
    /// `workflow_run_step` only ever produces [`ChainStop::MaxSteps`] or
    /// [`ChainStop::CostCeiling`] — the other two variants describe facts this
    /// layer cannot see (the enum's header gives which, and why they are here
    /// anyway).
    pub stop: Option<ChainStop>,
    /// The EFFECTIVE step bound this verdict was measured against: the Space's
    /// `auto_max_steps`, or [`DEFAULT_AUTO_MAX_STEPS`] when that column is `NULL`.
    /// Never `None` — an unset Space is BOUNDED, not unlimited, and a verdict that
    /// reported `None` here would tell the caller this chain has no step limit.
    pub max_steps: i64,
    /// The EFFECTIVE ceiling this verdict was measured against: the Space's
    /// `auto_ceiling_usd`, or [`DEFAULT_AUTO_CEILING_USD`] when that column is
    /// `NULL`. `Option` because "no ceiling configured" is a sentence the caller
    /// may legitimately need to say — but under the shipped fallback it is `None`
    /// for no Space that exists today.
    ///
    /// THE LIMITATION THIS FIELD EXISTS TO ANNOUNCE, stated rather than glossed
    /// (ADR 0082's caveat, verbatim from the plan: *"a ceiling built on `cost_usd`
    /// must distinguish NULL/0.0, or it will treat an unbilled chain as free"*):
    /// the comparison runs against `run.cost_usd`, and that column is `NULL` until
    /// a Session in the chain reports a figure. A `NULL` figure **cannot** trip any
    /// ceiling, including a $0.00 one — that is a real limitation, not a bug, and
    /// `a_chain_that_never_reports_a_cost_cannot_trip_the_ceiling` pins it. The
    /// alternative (reading `NULL` as `0.0`) is worse in the direction that matters:
    /// it would let a chain that reported nothing look like a chain that spent
    /// nothing, i.e. a guard that fails open. So the step bound is what actually
    /// stops an unbilled chain, and this field is what lets the caller say so
    /// instead of implying the ceiling did the work.
    pub ceiling_usd: Option<f64>,
}

/// The ONE `workflow_runs` projection its one read uses, and the ONE mapper for it.
///
/// Spelled here rather than in [`super::rows`] for the reason the module header
/// gives: this table has no `*_COLUMNS` registry entry to be the drift-guard's
/// subject. What it does have is the property the registry exists to protect —
/// a projection and a positional `get` ladder that must not be edited apart — so
/// both live in this file, ONE each, and the read interpolates the const
/// instead of re-spelling the names.
const WORKFLOW_RUN_COLUMNS: &str =
    "id, space_path, task_id, started_at, finished_at, steps, cost_usd, stop_reason";

/// Map one row of [`WORKFLOW_RUN_COLUMNS`], index for index.
fn workflow_run_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRunRow> {
    Ok(WorkflowRunRow {
        id: row.get(0)?,
        space_path: row.get(1)?,
        task_id: row.get(2)?,
        started_at: row.get(3)?,
        finished_at: row.get(4)?,
        steps: row.get(5)?,
        cost_usd: row.get(6)?,
        stop_reason: row.get(7)?,
    })
}

impl Db {
    // ── `workflow_runs`: the record a chain counts itself against ──────────
    //
    // TWO verbs, and the read/write pair in the middle is the reason the subject
    // needs a transaction-shaped discipline: `workflow_run_step` reads the open run
    // and then writes it, and per this repo's locking rule (the `db/board.rs`
    // header; `create_task`'s `MAX(number) + 1` is the worked example) ONE lock is
    // taken for the whole pair. Two locks would let a second auto-advance interleave
    // between the read and the write and lose a step, and a lost step in a bounded
    // chain is the bound failing open.
    //
    // THERE WERE THREE. `workflow_run_open` — "the OPEN run for one Task, if it has
    // one" — was deleted, together with its command and its TS wrapper, because
    // nothing in the shipped runtime ever asked the question: `workflow_run_step` IS
    // the upsert, so a chain that needs opening is opened by stepping and a chain
    // that needs closing is closed by the settle handler, and neither branches on a
    // read first. A read with no reader is the same dead IPC its command was, one
    // layer down, and it stayed green only because the tests were its only caller.
    // The question they still ask is asked from raw SQL in
    // `db/tests/support.rs::open_run_row`, so the assertions read the DATABASE.

    /// Record one auto-advance, opening a chain if none is open, and ANSWER WITH A
    /// VERDICT: the row after the write, plus whether the chain may take another
    /// step. THE UPSERT.
    ///
    /// An open run for `task_id` → `steps + 1` and the delta folded into
    /// `cost_usd`. No open run → INSERT a new one with a minted id and `steps = 1`,
    /// so a card that chains again after a close starts a fresh BOUNDED run rather
    /// than continuing a spent one. The row as it is AFTER the write rides in
    /// [`AdvanceVerdict::run`], because the caller's next question is "did that step
    /// cross the bound", which is a question about the new value.
    ///
    /// THE COST RULE, which is the subtlest thing about this verb: `NULL + x` is
    /// `NULL` in SQL, so a plain `cost_usd = cost_usd + ?1` would freeze the column
    /// at NULL forever the moment a chain's FIRST step reported no figure — and a
    /// ceiling compared against NULL never trips, which is an unbounded spend path
    /// hiding behind a counter that looks like it is working. So the arms are:
    ///   - `None` delta → `cost_usd` is not mentioned at all: a step that reports
    ///     nothing neither sets nor erases the stored figure;
    ///   - `Some(x)` delta → `cost_usd = COALESCE(cost_usd, 0.0) + x`, which SETS
    ///     the column on the first figure (`NULL` → `0.0 + x` = `x`) and ADDS to
    ///     every later one. One statement covers both halves of the rule, and the
    ///     `INSERT` arm writes the delta verbatim so a chain that opens with no
    ///     figure still opens with `NULL` and not a phantom `0.0` (ADR 0082).
    ///
    /// THE SPACE IS THE CARD'S, NOT THE CALLER'S. `space_path` is a wire argument
    /// this verb CANNOT believe, and it does not: the first statement under the lock
    /// reads the card's own `tasks.space_path` and (a) refuses a caller whose path
    /// canonicalises to a different folder and (b) stores and guards against the
    /// CANONICAL form of the card's path, never the string it was handed. Both halves
    /// close a real hole. A trusted argument let one mis-spelled path buy another
    /// Space's budget — a card in a one-step Space chaining fifty, the bound failing
    /// OPEN — and an argument stored verbatim put a spelling in the audit column that
    /// the guard read's `space_key` lookup had already resolved differently, so the
    /// two disagreed about which Space the run belonged to and a `WHERE space_path = ?`
    /// audit missed rows. A `task_id` that names no card is refused too: no card, no
    /// Space, no bound to measure against, and falling back to the shipped constants
    /// would report a verdict as though the Space had chosen them. These are the only
    /// refusals in the `workflow_runs` family and the line is deliberate — the rest of
    /// the family's leniency covers the absence of BOOKKEEPING, which still answers an
    /// answerable question. `a_step_naming_a_space_other_than_the_cards_is_refused`,
    /// `a_step_stores_the_canonical_space_path_even_when_the_card_carries_a_raw_one`
    /// and `a_step_for_a_task_that_does_not_exist_is_refused` pin the three.
    ///
    /// ONE lock for the whole card-read-then-read-write-GUARD-read, held to the end. The
    /// first read decides INSERT-vs-UPDATE, so a second lock there would be TOCTOU
    /// with a spend counter on the other side of the race: two interleaved steps
    /// could both see "no open run" and open two, or both see `steps = 4` and write
    /// `5` twice. THE GUARD READ IS INSIDE THE SAME LOCK FOR THE SAME KIND OF
    /// REASON, and it is the reason this verb answers a verdict instead of a row:
    /// a bound read on a second lock would be a bound read outside the moment the
    /// step it governs happened, so a Space whose guard was edited mid-step would
    /// have the step measured against a value that was not in force when the step
    /// was taken. It reads `spaces` through [`Db::auto_guards_on`] — the one
    /// projection, the one no-row answer, and the one `space_key` rule the writer
    /// uses (see that method for why the keying is load-bearing rather than
    /// tidiness).
    ///
    /// THE GUARD RULES, and why each is spelled the way it is:
    ///   - `NULL` ≠ `0`. A `NULL` column means NOT CONFIGURED and takes the shipped
    ///     fallback; a configured `0` means zero and is honoured as zero, so
    ///     `max_steps = 0` refuses the FIRST step. Collapsing the two (`COALESCE`
    ///     the column to `0` in SQL, say) would make every Space that never opened
    ///     the guard editor lose its chain — the ADR 0082 discipline, applied to the
    ///     thing it exists to bound.
    ///   - The step comparison is `>` on the POST-INCREMENT counter, read back
    ///     below, and `max_steps` then means exactly what [`AutoGuards::max_steps`]
    ///     promises: **how many auto-advances ONE chain may take**. A bound of 2
    ///     permits TWO advances, so the step that takes `steps` to 3 is the one that
    ///     answers `advance: false` and no fourth launch follows. `advance` is the
    ///     permission to launch the NEXT Session and the caller reads it AFTER this
    ///     step is already recorded, so a `>=` here would authorise
    ///     `max_steps − 1` moves — a bound of 1 would move nothing at all while the
    ///     transcript said the chain had "reached this Space's 1-step bound".
    ///     `the_verdict_stops_the_chain_at_the_configured_step_bound_and_reports_it`
    ///     pins the arithmetic. The step that OPENS a run (`steps = 1`) counts: an
    ///     uncounted opening step would make every chain one launch longer than its
    ///     bound says.
    ///   - The ceiling comparison is `>=` on `run.cost_usd`, and `None` NEVER trips
    ///     it. That is a real limitation, documented on
    ///     [`AdvanceVerdict::ceiling_usd`], and the verdict carries the ceiling so
    ///     the caller can say it out loud rather than imply the guard did work it
    ///     cannot do.
    ///   - When BOTH bounds are reached on the same step, the CEILING is what the
    ///     verdict reports. Cost is the audited fact and steps is a plan, and the
    ///     shipped ceiling is described above as the guard for the expensive case —
    ///     so the more informative of the two truths is the one about money.
    ///     `the_verdict_reports_the_ceiling_when_both_bounds_trip_on_one_step` pins
    ///     the choice.
    ///
    /// THE WRITE IS NOT CONDITIONAL ON THE VERDICT. A step that trips the bound is
    /// recorded before the verdict refuses the next launch, so a run's `steps` is
    /// the length of the chain and not the length minus one — a record that
    /// under-reported its own final step would also under-report the spend beside
    /// it. `the_step_that_trips_the_bound_is_written_before_the_verdict_refuses_the_next_one`
    /// pins that ordering.
    pub fn workflow_run_step(
        &self,
        space_path: &str,
        task_id: &str,
        cost_delta_usd: Option<f64>,
    ) -> Result<AdvanceVerdict, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        // THE CARD'S SPACE, read under the SAME lock, before anything is written.
        //
        // WHY THE VERB DOES NOT TRUST ITS OWN ARGUMENT. `space_path` still arrives
        // from the wire (dropping it is the cleaner shape, but the caller is
        // TypeScript and outside the file set this change is allowed to touch — see
        // the method doc), and a caller-supplied path is a caller-supplied path:
        // nothing below could tell a true one from a spurious one. Two failures came
        // from that, and they are the two this block removes. (1) The guard read keys
        // `spaces` by this value, so naming a different Space answered a verdict
        // measured against THAT Space's budget — a card in a one-step Space chaining
        // fifty because the caller named a stranger, i.e. the bound failing OPEN on a
        // single mis-spelled argument. (2) The INSERT stored the value verbatim while
        // `auto_guards_on` looked the bound up through `space_key(…)`, so the audit
        // column and the bound disagreed about which Space the run belonged to and a
        // future `WHERE space_path = ?` audit missed rows. Now the card is the
        // authority for both, and the argument is checked against it rather than
        // believed.
        //
        // The comparison canonicalises BOTH sides through the one `space_key` rule
        // the guard read uses (raw fallback included), because `create_task` stores
        // the path it was handed VERBATIM: a card can legitimately carry a `..`
        // spelling of the folder its Space row is keyed canonical under, and that is
        // the SAME Space, not a mismatch.
        //
        // Refusal is `DbError::Io(io::Error::other(…))` — the EXISTING error type,
        // deliberately. `DbError` has three variants and all three are `#[from]`
        // conversions from a library failure; a fourth would be the first
        // hand-constructed one, and `From<DbError> for StoreError` / `TaskStoreError`
        // both map `Io → Io` already, so the wire sentence survives intact. A
        // mismatch is not a database failure and it is not absence — it is an
        // argument that lied, and `io::Error::other` is the repo's constructor for
        // "a refusal that is not an OS errno" (see that `From` impl's own comment).
        let card_space: Option<String> = match guard.query_row(
            "SELECT space_path FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(path) => Some(path),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        let card_space = card_space.ok_or_else(|| {
            // A card that does not exist has NO Space, so there is no bound to
            // measure against. The family's `Ok`-on-absence leniency covers the
            // absence of BOOKKEEPING (no run to close, no open run to read) and each
            // of those still answers an answerable question; here the verb would have
            // to fall back to the shipped constants and report a verdict as though the
            // Space had chosen them, then charge the step to a Space nobody
            // configured. `a_step_for_a_task_that_does_not_exist_is_refused` pins it.
            DbError::Io(std::io::Error::other(format!(
                "workflow_run_step: no Task `{task_id}`, so no Space to bound the chain"
            )))
        })?;
        let card_key = space_key(&card_space).unwrap_or_else(|| card_space.clone());
        if space_key(space_path).unwrap_or_else(|| space_path.to_string()) != card_key {
            return Err(DbError::Io(std::io::Error::other(format!(
                "workflow_run_step: `space_path` {space_path:?} is not the Space of \
                 Task `{task_id}` (which is {card_space:?}) — the guard would be read \
                 against the wrong Space's budget"
            ))));
        }
        // THE CANONICAL SPELLING is what both the guard read and the INSERT use, so
        // the audit column agrees with the key the bound was looked up under. The
        // guard read canonicalises again internally and `space_key` is idempotent on
        // an already-canonical path, so the two cannot diverge by spelling. Shadowing
        // the parameter here rather than at each use site is deliberate: there is then
        // no statement left in this verb that can reach the raw argument.
        let space_path: &str = card_key.as_str();

        // The read half, under the SAME lock the write below takes. It reads the
        // OPEN run's ID and nothing else: the arithmetic both write arms do is
        // SQLite's (`steps + 1`, `COALESCE(cost_usd, 0.0) + ?`), so reading the
        // counters here would put a second copy of the rule in Rust, one that a
        // later edit could edit apart from the SQL. (No `transaction()` is spelled,
        // and that follows `create_task` rather than `reorder_tasks`: ONE statement
        // writes, and `create_task`'s read-`MAX(number)`-then-`INSERT` pair is the
        // worked example of the rule this obeys — the ONE lock is what makes the
        // pair atomic.)
        let open: Option<String> = match guard.query_row(
            "SELECT id FROM workflow_runs WHERE task_id = ?1 AND finished_at IS NULL",
            params![task_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(id) => Some(id),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };

        let id = match open {
            Some(open_id) => {
                // Two arms, and the `None` arm does NOT mention `cost_usd` — see
                // the rule above. `steps + 1` is computed by SQLite, not from the
                // value this verb read, so the counter cannot be written stale even
                // if a future caller hands the same lock to something else.
                match cost_delta_usd {
                    Some(delta) => guard.execute(
                        "UPDATE workflow_runs \
                         SET steps = steps + 1, cost_usd = COALESCE(cost_usd, 0.0) + ?2 \
                         WHERE id = ?1",
                        params![open_id, delta],
                    )?,
                    None => guard.execute(
                        "UPDATE workflow_runs SET steps = steps + 1 WHERE id = ?1",
                        params![open_id],
                    )?,
                };
                open_id
            }
            None => {
                // The house id mint (`tsk_…` in `create_task`, `wfr_…` here).
                let id = format!("wfr_{}", uuid::Uuid::new_v4());
                guard.execute(
                    "INSERT INTO workflow_runs \
                     (id, space_path, task_id, started_at, steps, cost_usd) \
                     VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                    params![id, space_path, task_id, now_ms(), cost_delta_usd],
                )?;
                id
            }
        };

        // Read the row back rather than rebuild it from the arguments (the
        // `create_task` / `stage_row_by_slug` reason): what the caller gets IS what
        // is stored, so a DDL default or a SQLite-side increment can never drift
        // from what the runtime compares its bound against. Still the SAME lock.
        let mut stmt = guard.prepare(&format!(
            "SELECT {WORKFLOW_RUN_COLUMNS} FROM workflow_runs WHERE id = ?1"
        ))?;
        let run = stmt.query_row(params![id], workflow_run_from)?;

        // THE GUARD READ — same lock, AFTER the write, on the row that was just
        // written. Two reasons it sits here rather than before the write: the
        // comparisons are against the POST-INCREMENT values, which do not exist
        // until the read-back above runs, and a guard read before the write would
        // measure a step that had not happened yet against a bound that might be
        // edited before it did.
        let guards = Self::auto_guards_on(&guard, space_path)?;
        // `NULL` → the shipped fallback. NOT `unwrap_or(0)`: zero is a value a
        // person types, and reading an unset Space as zero would switch
        // auto-chaining off for every Space that never opened the editor.
        let max_steps = guards.max_steps.unwrap_or(DEFAULT_AUTO_MAX_STEPS);
        let ceiling_usd = guards.ceiling_usd.or(Some(DEFAULT_AUTO_CEILING_USD));

        // The CEILING is examined FIRST, so when both bounds trip on one step the
        // verdict reports `cost_ceiling`. The step bound is examined second and is
        // the one that ALWAYS applies, including to a chain the ceiling cannot see
        // (a `NULL` figure) — which is why the order costs nothing in coverage and
        // buys the more informative of the two truths. `ChainStop`'s variant order
        // is the vocabulary's, not the precedence's.
        let stop = if ceiling_usd.is_some_and(|ceiling| {
            // `run.cost_usd` is `Option` and `None` NEVER trips: see
            // `AdvanceVerdict::ceiling_usd` for why treating an unbilled chain as
            // a free one is the wrong way round, and what stops it anyway.
            run.cost_usd.is_some_and(|cost| cost >= ceiling)
        }) {
            Some(ChainStop::CostCeiling)
        } else if run.steps > max_steps {
            Some(ChainStop::MaxSteps)
        } else {
            None
        };

        Ok(AdvanceVerdict {
            advance: stop.is_none(),
            stop,
            run,
            max_steps,
            ceiling_usd,
        })
    }

    /// Close one Task's open run, recording WHY the chain stopped.
    ///
    /// `finished_at` gets the clock and `stop_reason` gets the caller's word, on the
    /// OPEN row only — the `WHERE finished_at IS NULL` arm is what makes a repeated
    /// close a no-op instead of a rewrite of the reason a chain actually stopped,
    /// which is the record's only narrative field.
    ///
    /// Zero open runs is a SILENT `Ok(())`: a chain that never opened a run (a card
    /// that never auto-advanced) and a chain already closed are both ordinary, and
    /// the caller is a settle-handler that must not fail a Session because the
    /// bookkeeping had nothing to do. That is [`Db::record_session_cost`]'s shape
    /// and its argument, including the trap that comes with the silence: it is the
    /// CALLER's job to have opened the run it means to close. Do not "fix" this into
    /// an error.
    ///
    /// One statement, one lock — no read precedes the write, because an `UPDATE`
    /// that scopes on `finished_at IS NULL` needs nothing read first (the same
    /// reason `record_session_cost` spells no `SELECT`).
    pub fn workflow_run_close(&self, task_id: &str, stop_reason: &str) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE workflow_runs SET finished_at = ?2, stop_reason = ?3 \
             WHERE task_id = ?1 AND finished_at IS NULL",
            params![task_id, now_ms(), stop_reason],
        )?;
        // Zero rows matched is the silent no-op the doc above argues for.
        Ok(())
    }
}
