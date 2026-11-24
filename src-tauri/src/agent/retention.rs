//! Background transcript retention: the one-time upgrade sweep and the idle-gated `VACUUM`.
//!
//! Both halves of the design (docs/research/database-size-unbounded-transcript-growth.md
//! §"Approved design (2026-11-22)", parts 5 and 6) are destructive and both are slow, so neither
//! may run where the window is trying to paint. `db/mod.rs:556-559` records that `Db::open`'s
//! gates are "the expensive writes … the reason an upgrade-first open used to stall the window",
//! and a 2 GB delete inside `open` would reintroduce exactly that stall. So the whole of it lives
//! in THIS loop, started from the boot seam, gated on idleness, and declined rather than panicked
//! when there is no runtime to hold it.
//!
//! THE IDLE GATE IS THREE CONDITIONS, NOT ONE — and that is a correction to part 6 of the design
//! of record, which states the gate as `SessionManager::session_count() == 0` and asserts that
//! this "means no session has a `live` slice, so no child can be running". The crate refutes that
//! sentence at `fulcrum-harness-0.6.0/src/worker/manager/mod.rs:369-372`. See [`Liveness`]. T4
//! (ADR 0118 — NOT 0117, which is a different decision about reply addressing) must record the
//! three conditions and mark part 6's one-condition claim superseded.

// ONLY this `use` at this step: `Arc` and the atomics arrive in Step 6, when the code that needs
// them does. An unused import is a `cargo clippy --all-targets` warning, and that is the CI gate.
use std::time::Duration;

use crate::agent::session::SessionManager;
use crate::agent::worker::manager::WorkerManager;

/// The three views of "is anything running", read once per tick.
///
/// `main_sessions` is `SessionManager::session_count()` — rows whose `live` slice is set, which is
/// a MAIN-session-only view. `attached_workers` and `in_flight_drives` are the `WorkerManager`'s
/// `workers` and `drives` maps, and they are the half that closes the hole: **a subagent Worker is
/// in neither `live` nor `workers`** (the crate's own doc on `test_drive_count`,
/// `worker/manager/mod.rs:369-372`, says so), so `session_count() == 0` says nothing at all about
/// a running child. That matters here because the sweep deletes `is_subagent = 1` rows, and because
/// ADR 0055's objection to a duration bound alone is a child deadlocked inside a tool — never
/// reaped, and it can outlive any age bound.
///
/// `Default` is IDLE (three zeros), which the tests use; `the_default_liveness_is_idle` below pins
/// that, because a struct whose default is "idle" is a footgun if a field is ever added and left
/// out of `is_idle`.
#[derive(Debug, Default)]
pub struct Liveness {
    pub main_sessions: usize,
    pub attached_workers: usize,
    pub in_flight_drives: usize,
}

impl Liveness {
    /// Read all three. The ONLY site naming the accessors.
    ///
    /// NAMING SMELL, DELIBERATE: these accessors are `test_`-prefixed and used in production.
    /// Their doc comments say they are NOT `#[cfg(test)]`-gated on purpose — the headless IPC test
    /// is an integration target, so the lib's `cfg(test)` is not compiled there and it asserts
    /// through them. The honest-sounding alternative, `WorkerManager::drive_count()`, is
    /// `pub(crate)` **in the crate** (`worker/manager/registry.rs:62`) and would need a fulcrum
    /// release to reach here. So the desktop reads the `test_*` pair and this comment is the price.
    pub async fn probe(session_manager: &SessionManager, worker_manager: &WorkerManager) -> Self {
        Liveness {
            main_sessions: session_manager.session_count().await,
            attached_workers: worker_manager.test_session_count(),
            in_flight_drives: worker_manager.test_drive_count(),
        }
    }

    /// Idle means ALL THREE are zero. Never any one of them alone.
    pub fn is_idle(&self) -> bool {
        self.main_sessions == 0 && self.attached_workers == 0 && self.in_flight_drives == 0
    }
}

/// How often the loop wakes (15 minutes).
///
/// Why not smaller: every wake takes the single `Mutex<Connection>` (through `Db`'s verbs, and for
/// a `VACUUM`, for its whole multi-second duration) and the thing the wake is protecting against —
/// a file a few hundred MB larger than it needs to be — moves at the speed of a person archiving
/// Sessions. Why not bigger: past an hour or two the reclaim effectively never happens on a desktop
/// that is opened, used and closed within a working day. 15 minutes is the budget poller's 15 s
/// cadence scaled to an operation a thousand times heavier. Deliberately NOT a `settings.json` key:
/// `Settings` is crate-owned behind a `fulcrum-harness` version pin, so a new key costs a fulcrum
/// release, not a desktop commit.
pub const RETENTION_TICK_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// The `PRAGMA user_version` value that means "the age-bound sweep has run on this file" (1).
///
/// The archive and delete triggers are forward-only: they cannot reach the 2,042 MB backlog that
/// predates this version, so upgrading needs a one-time sweep and the sweep needs a latch.
/// `user_version` is the latch — verified unused in this tree (`grep -rn user_version src-tauri/src
/// src-tauri/tests` exits 1), so this needs no meta table and no schema change. It lives in the
/// database file header, so its durability is ordinary commit durability under WAL, and T1's Step
/// 5b measures that `VACUUM` preserves it. 1 and not 0 because 0 is SQLite's never-set value, and a
/// sweep is idempotent by construction, so re-running one after a crash costs time, not
/// correctness. T3 owns this CONSTANT; T1 owns the two verbs that read and write it.
pub const RETENTION_SCHEMA_MARKER: i64 = 1;

/// Is the one-time upgrade sweep still owed? A plain `<` on the latch value, which is
/// `PRAGMA user_version` as read by `Db::retention_schema_version` (T1's verb).
pub fn upgrade_sweep_is_due(marker: i64) -> bool {
    marker < RETENTION_SCHEMA_MARKER
}

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

// `AtomicUsize` ONLY. `Ordering` is NOT imported here: at this commit nothing in production names
// it — `retention_tick`'s `fetch_add(1, Ordering::SeqCst)` is Step 7's — and an import with no user
// in THIS commit is an `unused_imports` warning, which is in rustc's DEFAULT set and therefore red
// under CI's `cargo clippy --all-targets -- -D warnings` (`.github/workflows/ci.yml:125`). Step 7
// edits this line to `{ AtomicUsize, Ordering }`. Same rule as Step 2's `use std::time::Duration;`.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::agent::debuglog;
use crate::storage::{
    BatchingPersistence, Db, MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE, VACUUM_FREELIST_THRESHOLD_BYTES,
};

/// Everything the loop needs, cloned at the boot seam.
///
/// `app_handle` is deliberately absent: this loop never emits to the webview and must NEVER call
/// `run_on_main_thread` (see `lib.rs:609-611` — a plugin's `on_window_ready` goes through it and
/// executes INLINE). The ages and thresholds are fields rather than uses of the constants so a test
/// can shorten them — `BatchingPersistence::with_interval` and `budget_poller_for(…, interval_millis)`
/// are the two precedents for "a `pub const` default plus an injectable argument".
///
/// `db` is the ONLY route to SQLite from here, and it is enough: the sweep, the `VACUUM`, AND the
/// `PRAGMA user_version` latch are all inherent `pub fn`s on this `Db` (T1's verbs), so the loop
/// needs no marker adapter and no second `Arc<Db>`.
pub struct RetentionDeps {
    pub db: Arc<Db>,
    pub session_manager: Arc<SessionManager>,
    pub worker_manager: Arc<WorkerManager>,
    pub batched: Arc<BatchingPersistence>,
    pub max_age: Duration,
    pub freelist_threshold_bytes: u64,
    pub tick_interval: Duration,
    /// T3's OWN observability seam, chosen by T3 so that ONE test can see the loop wake: the tick
    /// increments this before it does anything else, and Step 8's cadence test reads it.
    ///
    /// WHY THIS EXISTS, STATED HONESTLY: it is not a workaround for a missing `Db` verb — the verbs
    /// exist (`Db::retention_schema_version`). It exists because `tokio::time::pause()` pauses the
    /// CLOCK, not the blocking pool, so the only cadence assertion that cannot flake is one on a
    /// counter bumped synchronously at the top of the tick, before the `spawn_blocking` hop. Rev 1
    /// got this observation for free by counting a stub marker's reads; with the stub gone (they were
    /// dead abstraction) this 1-field counter is the replacement, and it is 1 field, not a trait.
    /// Production increments it and never reads it; one `SeqCst` atomic per 15 minutes is free (the
    /// tests read it with `Ordering::SeqCst` too, so there is exactly one ordering in the file —
    /// rev 2's prose called this "relaxed" while every block uses `SeqCst`; the prose was wrong), and
    /// keeping it OUT of `#[cfg(test)]` means `RetentionDeps::new` and `clone_deps` have one shape in
    /// both builds, which is the cheaper price than a cfg-gated field threaded through both.
    pub tick_count: Arc<AtomicUsize>,
}

impl RetentionDeps {
    /// The production values: the design's 24 h age bound and 256 MB freelist threshold.
    pub fn new(
        db: Arc<Db>,
        session_manager: Arc<SessionManager>,
        worker_manager: Arc<WorkerManager>,
        batched: Arc<BatchingPersistence>,
    ) -> Self {
        RetentionDeps {
            db,
            session_manager,
            worker_manager,
            batched,
            max_age: MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE,
            freelist_threshold_bytes: VACUUM_FREELIST_THRESHOLD_BYTES,
            tick_interval: RETENTION_TICK_INTERVAL,
            tick_count: Arc::new(AtomicUsize::new(0)),
        }
    }
}

/// The loop's handle, kept REACHABLE so a test (or the app's exit path) can stop it. `Drop` is the
/// census backstop (cancel + abort) — ADR 0078 — which is why a value that is merely dropped can
/// never outlive its scope. Prefer [`Self::stop`]: it proves the task exited rather than was killed.
pub struct RetentionLoop {
    // `Option` so BOTH `stop` (which takes `self` by value) and the `Drop` backstop can take them:
    // a type that implements `Drop` cannot have its fields moved out.
    cancel: Option<CancellationToken>,
    handle: Option<JoinHandle<()>>,
}

impl RetentionLoop {
    /// Stop the loop and AWAIT its exit.
    pub async fn stop(mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

impl Drop for RetentionLoop {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

/// Spawn the loop on a given handle — the seam both the production factory and the tests use.
fn spawn_loop_on(handle: tokio::runtime::Handle, deps: RetentionDeps) -> Option<RetentionLoop> {
    let cancel = CancellationToken::new();
    let task = handle.spawn(run_loop(deps, cancel.clone()));
    Some(RetentionLoop {
        cancel: Some(cancel),
        handle: Some(task),
    })
}

/// The test-facing spawn: the current-runtime probe (which DECLINES on a bare thread) in front of
/// [`spawn_loop_on`].
///
/// `#[cfg(test)]`, and that attribute is load-bearing rather than tidy: NOTHING in production calls
/// this — the boot seam reaches [`spawn_loop_on`] through [`production_retention_factory`] — so as a
/// plain private `fn` it is `dead_code` in the non-test build, which is rustc's DEFAULT lint set and
/// therefore red under CI's `cargo clippy --all-targets -- -D warnings`. `refresh.rs:445`/`:455` gate
/// `spawn_loop` / `spawn_loop_with` for exactly this reason and leave `spawn_loop_on` (`:472`)
/// un-gated for exactly the opposite reason. The attribute goes AFTER the doc comment, as it does
/// there, so the doc still renders.
#[cfg(test)]
fn spawn_retention_loop_on_current(deps: &RetentionDeps) -> Option<RetentionLoop> {
    // The loop OWNS its deps, so this takes a reference and clones.
    //
    // Unqualified from Step 7 on. At Step 6 this call was written fully qualified, because its
    // module-level `use` had no user in the NON-test build at that commit (this function is
    // `#[cfg(test)]`) and would have fired `unused_imports` under CI's `-D warnings`.
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        debuglog::log("retention: no tokio runtime; skipping");
        return None;
    };
    spawn_loop_on(handle, clone_deps(deps))
}

/// The production factory: the loop on the app's own runtime.
///
/// THE RUNTIME QUESTION, copied from `provider_auth::refresh::production_refresher_factory`
/// (`refresh.rs:405-438`, which records the measurement): the `setup` hook is NOT executed inside a
/// tokio context — Tauri calls it from the event loop's `Ready` handler
/// (`tauri-2.12.2/src/app.rs:1442-1444`) — so a bare `Handle::try_current()` probe would DECLINE in
/// production and the retention loop would never run. So production asks `tauri::async_runtime` for
/// the singleton runtime Tauri itself runs commands on, and only falls back to the current handle
/// when there is one. Because `spawn_blocking` is the GLOBAL singleton accessor, the tick's `VACUUM`
/// runs on Tauri's runtime whichever handle spawned the loop — which is the design's intent.
pub fn production_retention_factory(deps: &RetentionDeps) -> Option<RetentionLoop> {
    let handle = tokio::runtime::Handle::try_current()
        .unwrap_or_else(|_| tauri::async_runtime::handle().inner().clone());
    spawn_loop_on(handle, clone_deps(deps))
}

fn clone_deps(deps: &RetentionDeps) -> RetentionDeps {
    RetentionDeps {
        db: deps.db.clone(),
        session_manager: deps.session_manager.clone(),
        worker_manager: deps.worker_manager.clone(),
        batched: deps.batched.clone(),
        max_age: deps.max_age,
        freelist_threshold_bytes: deps.freelist_threshold_bytes,
        tick_interval: deps.tick_interval,
        // CLONE THE Arc, not the counter: every holder must observe the same ticks, or the cadence
        // test counts its own private zero forever.
        tick_count: deps.tick_count.clone(),
    }
}

/// The loop body: sleep (cancellably) → tick → repeat.
///
/// **WHY THIS IS HERE AND NOT IN STEP 8 — per-commit compilability (Critical C3b).** Step 6's
/// `spawn_loop_on` above calls `run_loop(deps, cancel.clone())`, so `run_loop` MUST exist at this
/// commit or the crate does not build at all: measured at the pinned toolchain, calling a function
/// defined only in a later step is `error[E0425]: cannot find function `run_loop` in this scope`,
/// which is a hard failure, not a lint. Rev 4 placed this fence in Step 8 and its Step 8 RED bullet
/// even says "FAILS (`run_loop` undefined)" — the plan contradicted itself and Step 6 could not
/// compile. The function therefore arrives HERE, with the two tick lines withheld; Step 8 adds those
/// two lines and nothing else, which is exactly what its cadence test needs to go RED.
///
/// SLEEP FIRST, and that is a decision, not an oversight. The upgrade sweep's gate is OPEN the
/// instant the app starts (no session has a `live` slice yet, nothing is attached, nothing is
/// driving), so a tick at t=0 would delete ~2 GB and then VACUUM in the same tick — on the ONE
/// `Mutex<Connection>` that the boot-time history reads and the first `record_session` need, while
/// the window is trying to paint. That is the stall `db/mod.rs:556-559` exists to prevent, merely
/// moved off the main thread. Waiting one interval defers the reclaim by 15 minutes and defers it
/// further for anyone who opens a Session immediately, which is the whole point of the gate — and
/// it costs nothing, because the marker is stamped only on SUCCESS, so every boot retries.
///
/// Every sleep is a `select!` against the cancel, so a stop is immediate rather than bounded by the
/// remaining sleep. Nothing inside ever `?`s or unwraps: a failed tick logs and the loop continues.
async fn run_loop(deps: RetentionDeps, cancel: CancellationToken) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(deps.tick_interval) => {}
            _ = cancel.cancelled() => break,
        }
        if cancel.is_cancelled() {
            break;
        }
        let liveness = Liveness::probe(&deps.session_manager, &deps.worker_manager).await;
        retention_tick(&deps, &liveness).await;
    }
}

/// What one tick did. `Debug` so the log line and the tests can both read it.
#[derive(Debug, Default, PartialEq)]
pub struct TickOutcome {
    pub swept: bool,
    pub sessions_pruned: u64,
    pub display_rows_deleted: u64,
    pub native_rows_deleted: u64,
    pub vacuumed: bool,
    pub declined_busy: bool,
}

/// One tick: maybe the one-time sweep, then maybe a `VACUUM`.
///
/// The order is load-bearing. Flush FIRST (the buffer is in-memory only and a row buffered for a
/// session this tick deletes would commit 250 ms AFTER the DELETE and resurrect its transcript,
/// permanently, because the latch is stamped on success). Sweep SECOND. Then RE-PROBE and VACUUM
/// LAST, because the sweep itself is a long write and a session may have started during it.
///
/// The gate is a correction to the design, which said `session_count() == 0` alone — see
/// [`Liveness`]. A non-idle tick does NOT stamp the latch: the sweep was not done, and stamping it
/// would declare a 2 GB backlog handled and never reclaim it.
pub async fn retention_tick(deps: &RetentionDeps, liveness: &Liveness) -> TickOutcome {
    // FIRST, before the gate and before any `.await`: this is what Step 8's cadence test counts, and
    // it must be a synchronous bump because `tokio::time::pause()` pauses the clock and NOT the
    // blocking pool.
    deps.tick_count.fetch_add(1, Ordering::SeqCst);

    let mut outcome = TickOutcome::default();
    if !liveness.is_idle() {
        outcome.declined_busy = true;
        return outcome;
    }

    // 1. Drain the buffer. A Db verb CANNOT do this (`Db::conn` is private, ADR 0113 forbids
    //    widening it), so it is here or nowhere. `flush()` drains the WHOLE buffer and NOT
    //    `flush_session(id)`: the buffer is keyed by session id and a subagent's rows sit under the
    //    CHILD's id, while the sweep's target set is every closed child in the database — there is
    //    no single id to pass. `flush_session` is what the archive/delete triggers use, because a
    //    trigger does hold one parent id; that is T1's file, not this one.
    if let Err(e) = deps.batched.flush() {
        debuglog::log(&format!(
            "retention: pre-sweep flush FAILED, skipping this tick: {e}"
        ));
        return outcome;
    }

    // 2. The one-time upgrade sweep, once per database file. The latch is T1's verb; the DECISION is
    //    ours (`upgrade_sweep_is_due`) and so is the constant.
    if upgrade_sweep_is_due(read_marker(deps)) {
        let pruned = match deps.db.prune_closed_subagent_transcripts(deps.max_age) {
            Ok(counts) => counts,
            Err(e) => {
                // No stamp: a failed sweep stays owed.
                debuglog::log(&format!("retention: upgrade sweep FAILED, stays owed: {e}"));
                return outcome;
            }
        };
        outcome.swept = true;
        outcome.sessions_pruned = pruned.sessions_pruned;
        outcome.display_rows_deleted = pruned.display_rows_deleted;
        outcome.native_rows_deleted = pruned.native_rows_deleted;
        debuglog::log(&format!(
            "retention: upgrade sweep pruned {} closed subagent session(s), {} display rows, {} native rows",
            pruned.sessions_pruned, pruned.display_rows_deleted, pruned.native_rows_deleted,
        ));
        if let Err(e) = deps
            .db
            .set_retention_schema_version(RETENTION_SCHEMA_MARKER)
        {
            debuglog::log(&format!(
                "retention: marker write FAILED (the sweep re-runs next boot): {e}"
            ));
            return outcome;
        }
    }

    // 3. VACUUM — re-probe IMMEDIATELY first (the sweep above was a long write and a session may
    //    have started), then off the async worker. `Db` holds ONE `Connection` behind a `Mutex`, so
    //    this blocks EVERY other DB verb in the process for its whole multi-second duration: the
    //    250 ms interval flush, the naming write, `record_session`, every history command.
    //    Re-probing MITIGATES that; it does NOT cure it. A session started between this probe and the
    //    VACUUM stalls until the VACUUM finishes. That cost is the accepted consequence recorded in
    //    the design doc, and it is why the VACUUM is threshold-gated and not unconditional.
    let recheck = Liveness::probe(&deps.session_manager, &deps.worker_manager).await;
    if !recheck.is_idle() {
        outcome.declined_busy = true;
        return outcome;
    }
    let db = deps.db.clone();
    let threshold = deps.freelist_threshold_bytes;
    match tauri::async_runtime::spawn_blocking(move || {
        // Autocommit, ALWAYS. Measured: `cannot VACUUM from within a transaction`. The verb owns the
        // statement; nothing here may open a transaction around it.
        db.vacuum_if_freelist_over(threshold)
    })
    .await
    {
        Ok(Ok(true)) => {
            outcome.vacuumed = true;
            debuglog::log("retention: VACUUM completed (the Db mutex was held for its duration)");
        }
        Ok(Ok(false)) => {} // below threshold — the common tick, and it says nothing
        Ok(Err(e)) => debuglog::log(&format!("retention: VACUUM check failed: {e}")),
        Err(join) => debuglog::log(&format!("retention: VACUUM task did not finish: {join}")),
    }
    outcome
}

/// Read the latch, logging a refusal rather than guessing. An unreadable latch is treated as
/// "already done" — the safe direction, because the alternative re-runs a 2 GB delete on a database
/// it cannot read. ONE argument (rev 1 called this with two and the block did not compile).
fn read_marker(deps: &RetentionDeps) -> i64 {
    deps.db.retention_schema_version().unwrap_or_else(|e| {
        debuglog::log(&format!(
            "retention: marker read FAILED, treating as current: {e}"
        ));
        RETENTION_SCHEMA_MARKER
    })
}

#[cfg(test)]
mod tests;
