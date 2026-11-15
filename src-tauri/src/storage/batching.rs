//! The batching decorator on the persistence seam (issue #155, Task 3).
//!
//! # The problem this is the fix for
//!
//! `TranscriptPersister::apply` (`fulcrum-harness-0.2.0/src/persist.rs:117`)
//! writes PER FRAME, with no transaction and no coalescing: `StoreFrame::Display`
//! loops `for row in rows { … record_message(…) }`, and each `record_message` is
//! one statement in SQLite autocommit — one commit, one durability round-trip.
//! `Insert` and `ContextUsage` each commit once too. One desktop funnel reaches
//! it: `route_event` (`agent/session/router.rs`), whose `Store(frame)` arm calls
//! `persister.apply` — and `route_event` runs SYNCHRONOUSLY on a tokio worker
//! (the crate's pump calls `state.hooks.on_event(…)`), so SQLite's latency is
//! paid on an async worker while the window is trying to paint. At 14–17 ms per
//! commit against a ~60/sec coalesced frame rate, the writer is oversubscribed.
//!
//! # The shape
//!
//! A decorator over `Arc<Db>` implementing the same `FulcrumPersistence` surface
//! the persister already talks to. It buffers the writes whose stored value is a
//! SNAPSHOT and commits them in one transaction — Task 2's
//! [`Db::record_messages_batch`] — when a flush point fires or when the interval
//! expires. Reads pass straight through. `Replace` (the atomic compaction
//! rewrite) passes through and forces the pending batch out FIRST, so ordering
//! survives.
//!
//! # Why coalescing is legal here — and only for these writes
//!
//! * `record_message` upserts on `(session_id, kind, message_key)` and the crate
//!   writes the FULL accumulator as the payload (`normalize.rs:691-705`:
//!   `entry.push_str(text); payload = {text: entry}`). A later `Display` row for
//!   the same key is a complete snapshot, so LAST-WINS is the upsert's own
//!   semantics and dropping the intermediates loses nothing.
//!   THE SAME CLAIM HOLDS ON THE NO-RUNTIME WRITE-THROUGH PATH, and it holds for the
//!   same reason rather than a new one: that path calls `Db::record_message`, which is
//!   the same upsert with the same key and the same full-snapshot payload, so it is
//!   last-wins per key like everything else here. What the write-through path did NOT
//!   inherit was the ORDERING — writing immediately skips the queue, so an older
//!   buffered payload could still be committed after it — and that is what its
//!   pre-flush is for (see "Commit order must equal buffer order", and
//!   [`BatchingPersistence::buffer_or_write`]). Last-wins per key was never the
//!   problem on that path; commit order was.
//! * `ContextUsage`, `record_session_cost` and `record_session_todos` are
//!   snapshots by contract (ADR 0082: a `cost_update` frame carries the
//!   CUMULATIVE total, so the loop is the sole writer of its own key). Buffering
//!   them is safe precisely BECAUSE none of them is a delta — a summing store
//!   would have been corrupted by this in a single frame.
//! * `insert_native_message` also upserts on a real key, `(session_id, seq)`,
//!   and it is NOT batched — see its method doc: the plan's own safety analysis
//!   says `Insert` passes through, and a named durability test depends on it.
//! * First-seen order within a session is preserved (`messages_for` orders by
//!   `id`, and `id` is insert order), because `message_retracted` re-writes keys
//!   that already exist with `text: ""`: a retraction must move the payload, not
//!   move the row to the end of the transcript.
//!
//! # Commit order must equal buffer order — and which guard closes which hole
//!
//! The invariant: for one `(session_id, kind, message_key)`, the row that ends up on
//! disk is the LAST payload BUFFERED. `record_messages_batch` upserts with
//! `DO UPDATE SET payload_json = excluded.payload_json`, so LAST COMMIT WINS — which
//! makes the ordering of commits the whole story, and makes an inverted pair of
//! commits a silent corruption rather than a benign race. It is not benign on a
//! streaming accumulator key, where the payload IS the full text so far: the loser of
//! the race is a truncated assistant message, and if the inversion was caused by the
//! `agent_settled` flush point there may be no later frame to heal it.
//!
//! Two holes live in the timer path, and they are DIFFERENT holes closed by
//! DIFFERENT orderings. Conflating them is how this module got this wrong once:
//!
//! * **The orphaned-timer hole — a hole in the BOUND.** If the interval timer took
//!   the rows out of the map BEFORE releasing its timer slot, a row buffered in that
//!   window would find the slot occupied, decline to arm, and sit behind nothing until
//!   some later write or the quit. Closed by **releasing the slot before the take**.
//!   Pinned by
//!   `tests::a_row_buffered_between_the_slot_release_and_the_take_gets_its_own_timer_and_is_not_orphaned`.
//! * **The inversion hole — a hole in the ORDER.** Releasing the slot early is what
//!   ALLOWS a second drain of the same session to exist concurrently with this one,
//!   and once two drains of one session can be in flight, the one holding the OLDER
//!   payload can commit LAST and win. The slot-release ordering does nothing about
//!   this — it is not a weaker version of the same fix, it is an unrelated ordering
//!   that happens to be adjacent in the same function. Closed by the **drain gate**
//!   (per session) and the **drain barrier** (whole buffer), each held across the
//!   whole `take`→`write` window. Pinned by
//!   `tests::a_flush_cannot_commit_a_newer_payload_that_an_in_flight_timer_then_overwrites`
//!   and, for the write-through path,
//!   `tests::a_write_through_cannot_be_overwritten_by_an_older_row_the_timer_still_holds`.
//!
//! The gate is a per-session mutex in a map SEPARATE from `sessions`, and the barrier
//! is a reader/writer lock: per-session drains take the barrier SHARED (two sessions
//! share no upsert key, so they cannot invert each other and stay concurrent) and the
//! whole-buffer drain takes it EXCLUSIVELY, because `flush()` must be serialised
//! against every per-session drain — including one that starts halfway through it,
//! which is why a walk over "the gates that look busy" is not sufficient. The
//! [`drain_lock`] docs carry the lock-ordering rule and the sizing argument.
//!
//! What this does NOT do is turn a flush point into something that waits for the
//! interval. A gate is held only by a drain that has ALREADY passed its `take`, so
//! waiting on one costs one batched transaction and never the 250 ms; `abort()` on a
//! not-yet-fired timer still cancels it outright, because every flush point aborts
//! before acquiring the gate. `flush()` and `flush_session()` stay synchronous, and
//! the `sessions` map lock is still never held across SQLite I/O or an `.await` —
//! `take()` fills its batch and releases the map before the `Db` is touched, which is
//! the discipline this decorator exists to keep.
//!
//! # Errors MOVE TO THE FLUSH — a deliberate semantic change
//!
//! A buffered write returns `Ok(())` OPTIMISTICALLY; the error from the batch
//! surfaces at the flush, where it is logged. That genuinely changes when a
//! caller learns that persistence failed, and it is the price of the batching:
//! the alternative — writing through to keep the per-call error — is the
//! per-frame commit this module exists to remove. Every flush point logs what it
//! deferred, so a failure is loud at the point it becomes real rather than silent
//! forever. THREE exceptions, and they are not the same:
//!
//! 1. The no-runtime write-through path (see
//!    [`BatchingPersistence::buffer_or_write`]): with no flush to defer to, the
//!    error is returned immediately. This branch also FLUSHES the session's pending
//!    batch before it writes, because a write that lands NOW makes anything still
//!    buffered for that session older by construction — the same ordering argument
//!    `Insert` and `Replace` follow, and dropping it here would let a timer commit an
//!    older payload on top of a newer write-through.
//! 2. `insert_native_message` calls [`BatchingPersistence::flush_before_passthrough`]
//!    and DISCARDS its error: a caller of `Insert` can get `Ok(())` while that
//!    session's pending `Display` rows were dropped. Loud in the log, silent in the
//!    return value, and deliberate — `Insert` upserts one row of the provider
//!    transcript on its own key, and refusing it because a display flush failed would
//!    turn a deferred loss into a hard one on a path with no retry. A caller must not
//!    read an `Ok` here as "the batch landed too".
//! 3. `replace_native_messages` calls the SAME helper and PROPAGATES its error, so a
//!    compaction on a session whose pending batch cannot be written FAILS instead of
//!    proceeding. This is not the same disclosure as (2) and must not be documented as
//!    one case: `Replace` is the atomic rewrite that DELETES the session's transcript
//!    and re-inserts it, so the dropped rows are not merely deferred — they belonged to
//!    a transcript that ceases to exist in its old form, and nothing will re-emit them.
//!    Refusing costs a compaction the caller can retry; proceeding costs a transcript
//!    nobody can rebuild. Pinned by
//!    `tests::replace_refuses_its_atomic_rewrite_when_the_pre_flush_fails`, with the
//!    `Insert` half of the divergence pinned by
//!    `tests::the_two_pass_through_arms_diverge_on_a_failed_pre_flush_by_construction`
//!    (that half is not observable through any instrument this file has, and its test
//!    says precisely why).
//!
//! A failed batch is DROPPED, not re-queued — deliberately. SQLite refused these
//! rows (a FK on a session row that is never going to appear, a disk that is
//! full), so re-queuing would retry the identical failure every interval forever
//! while the buffer grew.
//!
//! That refusal is bounded to the session that caused it: the flush loop has ONE
//! ERROR BOUNDARY PER SESSION. `flush()` drains every session at once, and the
//! rows of a session whose write was refused are the only ones dropped — a
//! neighbour that happened to be in the same drained batch is still written, and
//! each refusal is logged with the session id that caused it. Without that
//! boundary one ghost session would silently take down every other session's
//! transcript in the same flush (rows already removed from the buffer by the
//! take, so never re-queued), which is a much larger loss than the one the
//! paragraph above licenses. Pinned by
//! `tests::a_failed_session_does_not_strand_the_sessions_it_was_batched_with`.
//!
//! # The bounded loss window: 250 ms
//!
//! A buffered row is on disk within [`DEFAULT_FLUSH_INTERVAL`] of arriving, or at
//! whichever flush point fires first. MEASURED, not assumed: a buffered row with
//! no flush point involved at all reaches the disk in **253.68 ms** on this
//! machine (`tests/ipc.rs::a_buffered_row_with_no_flush_point_lands_within_the_interval`
//! prints the number) — 250 ms of interval plus the scheduling latency of the
//! timer task, which is the honest shape of the bound. So the cost of this module is exactly: **a
//! crash discards at most one interval of buffered writes** — 250 ms of streamed
//! text, whose next frame re-derives the whole accumulator anyway (that is what
//! the payload IS). That number is the whole argument for the design, so it lives
//! in a named constant and in this paragraph, not in a call site. Read from the
//! other side, the same window is the honesty limit on "reads pass through": a
//! read issued from another thread inside 250 ms can miss rows this decorator is
//! holding.
//!
//! # Flush points — and why `Drop` is NOT one of them
//!
//! `Drop` on this type is a BACKSTOP, not the guarantee, and the distinction is
//! load-bearing. The decorator is coerced to `Arc<dyn FulcrumPersistence>` and
//! stored in `TranscriptPersister::db` (`persist.rs:85`), itself held as
//! `Arc<TranscriptPersister>` in `SessionManager::persister` — so the LAST `Arc`
//! must die for `Drop` to run, and on a real quit it does not: `tauri::App::run`
//! never returns and exits via `std::process::exit` (`tauri-2.12.2/src/app.rs:1364`;
//! tao implements exactly that), which runs NO destructors. A `Drop`-only
//! backstop would make a unit test with a local `Arc` pass while production threw
//! away the last flush interval on every quit — including a mid-stream quit,
//! which is precisely when the buffered rows are newest. That is data loss
//! wearing a green test.
//!
//! The REAL flush points, in priority order:
//!
//! 1. **`RunEvent::Exit`** (`lib.rs`) — before the Worker reap, on the same
//!    throwaway runtime, and again after it. This is the one that makes
//!    quit-durability true.
//! 2. **The router's turn boundary (`agent_settled`) and its `Exited` arm**
//!    (`agent/session/router.rs`) — the turn is over, or the session will never
//!    produce another frame.
//! 3. **After `apply_interactive_event`** — the SECOND persister entry point, so
//!    a `cost_update` / `todos_update` lands with its own frame instead of
//!    waiting behind a display batch.
//! 4. **Every write that goes to SQLite immediately while sharing a session with a
//!    pending batch** — `Replace`, `Insert`, and the no-runtime write-through branch
//!    of [`BatchingPersistence::buffer_or_write`] — the batch for that session goes
//!    first, so ordering survives. Ordering, not durability. The write-through branch
//!    is in this list only since the #155 review, and it is the reason its omission
//!    was a bug and not an asymmetry: a write that lands NOW makes everything still
//!    buffered for that session older by construction, so a branch that skips the
//!    queue has to drain it first, exactly like the other two.
//! 5. **The interval** — the bound, and the only point that fires on a stream
//!    that simply stops.
//! 6. `Drop` — best-effort only, for the non-exit last-owner cases. Never cite
//!    it as the guarantee.
//!
//! # Three honest limits on "display writes go through the decorator"
//!
//! This is a decorator on ONE seam instance, not an interception layer "between
//! any engine and any storage". Precisely:
//!
//! * `apply_interactive_event` (`persist.rs:206`) is a SECOND persister entry
//!   point, so the decorator is flushed from two call sites and not one.
//! * `send_prompt` writes the display user row straight through `self.driver.db`
//!   (`agent/session/mod.rs`, near `:1878`), bypassing the persister entirely.
//!   Unbuffered, therefore never a bug — but "ALL display writes go through the
//!   decorator" is FALSE.
//! * `SessionStore` (`agent/harness/store.rs`) writes `messages` /
//!   `native_messages` through its OWN `Arc<Db>`. On the shipped wire the
//!   Worker's `Store` is `IpcStore`, so the per-frame path does funnel through
//!   `apply` — but **a backend swap that keeps `Store` in-process gets no
//!   batching at all**, and nothing here would fail loudly when it happened.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{
    Arc, Mutex as StdMutex, MutexGuard, RwLock as StdRwLock, RwLockReadGuard as StdRwLockReadGuard,
    RwLockWriteGuard as StdRwLockWriteGuard, Weak,
};
use std::time::Duration;

use fulcrum_harness::seams::{FulcrumPersistence, StoreError};
use fulcrum_harness::store_rows::{MessageRow, SessionInfo, SessionRow};

use super::db::{Db, DbError};

/// The flush interval — the **bounded loss window** the module docs name: 250 ms.
///
/// Deliberately well under a second: this is the amount of streamed transcript a
/// crash or a quit discards, i.e. the thing the person at the window would notice
/// missing. It is also comfortably shorter than a turn, so every flush point that
/// matters (settle, exit, compaction, interactive write) fires long before the
/// timer does — the timer exists for the case no event covers (a stream that
/// stops mid-turn), not as the primary mechanism.
///
/// Why not longer: 250 ms already takes the writer from ~60 commits/sec to ~4,
/// which is the measured win. Past that the window keeps growing while the commit
/// count stops falling, because the event-driven flush points dominate.
pub const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_millis(250);

/// A buffered `messages` row, kept in first-seen order.
struct DisplaySlot {
    kind: String,
    message_key: Option<String>,
    payload_json: String,
}

/// Everything one session has buffered, keyed internally by the upsert key that
/// decides what "last wins" means for it.
///
/// The keys ARE the storage keys: `messages` is `(kind, message_key)`, and each
/// of the three `sessions` columns holds exactly one value per session — so one
/// slot each. Insertion order is kept for the row list, because `messages_for`
/// orders by `id` = insert order and a set-based buffer would let a retraction
/// jump its row to the end of the transcript.
#[derive(Default)]
struct Pending {
    display: Vec<DisplaySlot>,
    /// `sessions.context_usage_json`.
    context: Option<(u64, u64)>,
    /// `sessions.cost_usd` (a snapshot, never a sum).
    cost: Option<f64>,
    /// `sessions.todos_json`. `Some(None)` is a pending `todos_clear` — a VALUE,
    /// which must not collapse into "nothing pending".
    todos: Option<Option<String>>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.display.is_empty()
            && self.context.is_none()
            && self.cost.is_none()
            && self.todos.is_none()
    }
}

/// One session's buffer plus its one armed timer.
#[derive(Default)]
struct SessionPending {
    pending: Pending,
    /// The armed timer: its token, plus the task holding it. `None` = nothing
    /// armed, the ONLY state in which a new write may arm one.
    timer: Option<(u64, tokio::task::JoinHandle<()>)>,
}

/// The shared state. `Arc`-cloned (as a `Weak`) into every timer task, so no lock
/// is ever held across SQLite or an `await`, and no task keeps this alive.
struct Inner {
    db: Arc<Db>,
    interval: Duration,
    /// The monotonic timer-token source, so a task releases the slot only if it
    /// still owns it.
    next_token: AtomicU64,
    /// `session_id → its buffer`.
    ///
    /// AGENTS.md's poisoned-mutex discriminator says RECOVER here, and it is the
    /// right call: this is a map of INDEPENDENT per-session rows, so one poisoned
    /// entry must not wedge every other session's persistence — the same rule the
    /// session registry's 25 production sites follow
    /// (`unwrap_or_else(|p| p.into_inner())`). It is deliberately NOT `db.rs`'s
    /// `.expect("db mutex poisoned")`, which is correct only there, because `Db`
    /// holds one shared connection.
    sessions: StdMutex<HashMap<String, SessionPending>>,
    /// Per-session DRAIN gates — a map SEPARATE from `sessions`, deliberately.
    ///
    /// It has to be separate: `take()` REMOVES a session's `SessionPending` from
    /// `sessions`, and a gate must outlive that removal. The window the gate exists
    /// to close is exactly "a drain holding rows that are no longer in the map", so
    /// a gate stored inside `SessionPending` would be taken away with the rows and
    /// there would be nothing left for a second drain to contend with.
    ///
    /// Values are `Weak` and dead entries are pruned on every lookup, so this map
    /// cannot grow with the number of sessions the app has ever opened: an entry
    /// survives only while a drain holds it, or briefly between two drains of the
    /// same session where it is one idle empty mutex.
    ///
    /// A gate IS held across SQLite I/O, and that is the point — it is never held
    /// across an `.await`, and the `sessions` lock is never held while acquiring
    /// one. See the lock order above [`drain_lock`].
    drains: StdMutex<HashMap<String, Weak<StdMutex<()>>>>,
    /// A READER/WRITER barrier around every drain, and the second of the two
    /// guards. Per-session drains take it SHARED (they cannot invert each other:
    /// two different sessions share no upsert key, so they stay concurrent); the
    /// whole-buffer drain takes it EXCLUSIVELY, because `flush()` has to be
    /// serialised against EVERY per-session drain, including one that starts
    /// halfway through it.
    ///
    /// That "including one that starts later" is why a snapshot of the live gates
    /// is not enough and this is: a timer can create its gate and take its rows
    /// AFTER the whole-buffer flush has enumerated what to wait for, and then
    /// commit its (older) payload after the flush committed the newer one. An
    /// exclusive guard cannot be overtaken — a drain that has not entered yet
    /// waits at the door, which is the property the ordering needs.
    ///
    /// Held across SQLite I/O, never across an `.await`, never while holding the
    /// `sessions` map. It is `std` and not `tokio::sync` deliberately: `flush()`
    /// and `flush_session()` are synchronous by contract (the exit path calls them
    /// from a `RunEvent` handler and the router from a sync hook), so an async lock
    /// here would be a lie about the API.
    ///
    /// THE RESIDUAL WINDOW, stated rather than papered over: a `std` writer can be
    /// overtaken by a continuous stream of readers, so `flush()` could in principle
    /// wait longer than one batched transaction. It cannot wait long in practice —
    /// every reader holds the barrier for one transaction (single-digit ms) and the
    /// readers are interval flushes at ~4/sec per session plus a handful of flush
    /// points per turn — but the bound is a scheduling argument and not a guarantee,
    /// and `flush()` is the exit path, where "eventually" is good enough and naming
    /// the difference is the honest thing to do.
    drain_barrier: StdRwLock<()>,
    /// TEST-ONLY: the drain seam (see [`DrainStage`]). `None` in every test that
    /// does not install one, and compiled out of the release build entirely.
    #[cfg(test)]
    drain_hook: StdMutex<Option<DrainHook>>,
}

/// The one lock-ordering rule of this module, stated once:
///
/// ```text
/// drain barrier  →  per-session gate  →  sessions map  →  (release)  →  Db conn
/// ```
///
/// Always in that order, and no path ever takes two per-session gates — so there
/// is no cycle to deadlock on. The two things this rule prevents, by name:
///
/// * taking a gate or the barrier while holding the `sessions` map, which would
///   deadlock a flush against a timer (the timer holds a gate and wants the map;
///   the flush holds the map and wants the gate); and
/// * waiting on the `Db` `conn` mutex while holding the `sessions` map, which is
///   the very jank this decorator exists to remove — `take()` fills its batch and
///   releases the map before SQLite is touched.
///
/// The gate is looked up (and dead entries pruned) under the `drains` lock, which
/// is RELEASED before this returns: a caller never waits on the map while it waits
/// for another drain.
fn drain_lock(inner: &Arc<Inner>, session_id: &str) -> Arc<StdMutex<()>> {
    let mut drains = inner.drains.lock().unwrap_or_else(|p| p.into_inner());
    // Prune under the same lock as the lookup, so two drains can never disagree
    // about which mutex a session's gate is.
    drains.retain(|_, weak| weak.strong_count() > 0);
    let gate = drains
        .get(session_id)
        .and_then(Weak::upgrade)
        .unwrap_or_else(|| Arc::new(StdMutex::new(())));
    drains.insert(session_id.to_string(), Arc::downgrade(&gate));
    gate
}

/// Take the drain barrier SHARED: this is a per-session drain, and another session
/// draining at the same time cannot invert it (two sessions share no upsert key).
///
/// Poison recovery, per AGENTS.md's discriminator: the barrier guards an ORDERING
/// and no data of its own, so a panic elsewhere must not wedge persistence for
/// every session forever.
fn drain_shared(inner: &Arc<Inner>) -> StdRwLockReadGuard<'_, ()> {
    inner
        .drain_barrier
        .read()
        .unwrap_or_else(|p| p.into_inner())
}

/// Take the drain barrier EXCLUSIVELY: this is a whole-buffer drain, which has to
/// be serialised against EVERY per-session drain — including one that starts after
/// it does, which is the case a snapshot of the live gates cannot cover.
fn drain_exclusive(inner: &Arc<Inner>) -> StdRwLockWriteGuard<'_, ()> {
    inner
        .drain_barrier
        .write()
        .unwrap_or_else(|p| p.into_inner())
}

/// Take a session's per-session gate, recovering a poisoned one.
///
/// Poison here means a panic happened mid-commit in some other drain. A gate
/// orders ONE SESSION's commits and guards no state of its own, so AGENTS.md's
/// poisoned-mutex discriminator says recover — unlike `db.rs`'s `conn` mutex,
/// which panics because it guards ONE shared connection that a panic can leave
/// mid-transaction.
fn hold_drain(gate: &StdMutex<()>) -> MutexGuard<'_, ()> {
    gate.lock().unwrap_or_else(|p| p.into_inner())
}

/// Drain ONE session and commit it, holding that session's gate across the whole
/// `take`→`write` window. This is the guard that makes commit order equal buffer
/// order, and it is the ONLY way a session may leave the buffer.
///
/// WHY THE WINDOW HAS TO BE CLOSED AT ALL: `take()` removes the rows from the map,
/// so between the take and the commit a drain holds a payload that exists nowhere
/// the next writer can see. A second drain of the same session was free to take the
/// NEWER payload and commit it FIRST, and because `record_messages_batch` upserts
/// with `DO UPDATE SET payload_json = excluded.payload_json`, LAST COMMIT WINS — the
/// older payload, committed second, silently replaced the newer one on disk. The
/// window is not theoretical: it is exactly how long the drain waits on the `Db`
/// `conn` mutex, which under SQLite contention is milliseconds and can be a whole
/// pre-emption.
///
/// WHY THE `take` IS INSIDE THE GATE AND NOT BEFORE IT: with the take outside, two
/// drains could each end up holding a payload for the same key and the gate would
/// only decide who wrote LAST — still an inversion, just a narrower one. With the
/// take inside, whoever arrives second takes whatever is newest AT ITS OWN TAKE
/// (possibly nothing, because the first drain took it), so the value that lands
/// last is always the value that was buffered last.
///
/// WHY A GATE AND NOT `join()`-ing THE ARMED `JoinHandle`: joining a timer that has
/// NOT fired yet would make every flush point wait out the full 250 ms interval on
/// the router's hot path, for a commit that was never in flight. A gate is held only
/// by a drain that has ALREADY passed its `take`, so waiting on one is bounded by a
/// single batched transaction — single-digit milliseconds — and never by the
/// interval. That is also how you know a task you waited on had already taken:
/// holding the gate is the only state in which there is a gate to wait for.
/// `abort()` on a not-yet-fired timer still cancels it outright and costs nothing,
/// because every flush point aborts BEFORE getting here.
fn drain_one(inner: &Arc<Inner>, session_id: &str, reason: DrainReason) -> Result<usize, DbError> {
    // The barrier FIRST (the documented order), then this session's gate. Shared,
    // because a drain of a DIFFERENT session cannot invert this one.
    let _shared = drain_shared(inner);
    let gate = drain_lock(inner, session_id);
    #[cfg(test)]
    {
        // A non-blocking PROBE, so the seam can tell a drain that QUEUED behind an
        // in-flight one from one that found the gate free. It serialises nothing —
        // the guard below does — and the temporary is dropped at the end of the
        // statement, so the gate is not held across the log call. Matched on
        // `WouldBlock` specifically rather than any `Err`, because a POISONED gate is
        // also an `Err` and is not this drain waiting on another one.
        let queued = matches!(gate.try_lock(), Err(std::sync::TryLockError::WouldBlock));
        if queued {
            note_drain(inner, session_id, DrainStage::Queued, reason);
        }
    }
    let _draining = hold_drain(&gate);
    let drained = take(inner, Some(session_id));
    if drained.is_empty() {
        return Ok(0);
    }
    #[cfg(test)]
    note_drain(inner, session_id, DrainStage::Taken, reason);
    let written = write(inner, &drained, reason);
    #[cfg(test)]
    note_drain(inner, session_id, DrainStage::Committed, reason);
    written
}

/// Drain EVERY buffered session, holding the barrier EXCLUSIVELY across the whole
/// `take`→`write` window.
///
/// The whole-buffer flush has the same inversion as the per-session one and cannot
/// fix it by taking everything at once: taking `P2` while a timer still holds `P1`
/// in hand only guarantees the timer commits `P1` LAST. So it must exclude every
/// per-session drain for its whole duration — one already in flight, AND one that
/// would start halfway through. That second case is why this is an exclusive lock
/// and not a walk over the gates that look busy: a timer can create its gate and
/// take its rows after such a walk, and commit its older payload behind this batch.
///
/// Holding the barrier exclusively also means no per-session gate is needed here —
/// by the time this holds it, no per-session drain is in flight and none can enter.
fn drain_all(inner: &Arc<Inner>, reason: DrainReason) -> Result<usize, DbError> {
    let _exclusive = drain_exclusive(inner);
    let drained = take(inner, None);
    if drained.is_empty() {
        return Ok(0);
    }
    #[cfg(test)]
    for (sid, _) in &drained {
        note_drain(inner, sid, DrainStage::Taken, reason);
    }
    let written = write(inner, &drained, reason);
    #[cfg(test)]
    for (sid, _) in &drained {
        note_drain(inner, sid, DrainStage::Committed, reason);
    }
    written
}

/// WHICH drain is committing, so the deferred-error log line says where the flush
/// came from. A caller gets one `Result` for a whole batch and cannot know this,
/// and the module docs' rule is that a lost batch must stay LOUD — which needs the
/// line to name its own origin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DrainReason {
    /// The interval timer's own drain.
    IntervalTimer,
    /// `flush_session` — a per-session flush point (and the pass-through flush).
    FlushSession,
    /// `flush` — the whole-buffer flush (the exit path).
    FlushAll,
    /// The `Drop` backstop.
    Drop,
}

impl DrainReason {
    /// The phrase the deferred-error log line names this drain by.
    fn label(self) -> &'static str {
        match self {
            DrainReason::IntervalTimer => "interval",
            DrainReason::FlushSession => "per-session flush",
            DrainReason::FlushAll => "whole-buffer flush",
            DrainReason::Drop => "drop, best-effort",
        }
    }
}

/// TEST-ONLY: how far a drain of one session has got, reported to the seam hook
/// installed by [`BatchingPersistence::set_drain_hook`].
///
/// These are the points a drain can be observed at, and they are exactly the points
/// the ordering argument turns on: the slot release (which is what keeps a later
/// row from being orphaned), the take and the commit (the two ends of the window a
/// competing drain used to slip through), and the queueing of a drain that found
/// its session already mid-drain (which is what closes that window).
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrainStage {
    /// The interval timer released its timer slot; it has NOT taken the rows yet.
    ReleasedSlot,
    /// The rows are out of the buffer and NOT yet committed. This is the window the
    /// inversion lives in.
    Taken,
    /// A drain found its session already mid-drain and is about to wait for it. The
    /// seam's proof that commits were SERIALISED and not merely lucky.
    Queued,
    /// The drained rows have been handed to SQLite (successfully or not).
    Committed,
}

/// TEST-ONLY: the seam hook's type. The `&str` is the session id being drained.
#[cfg(test)]
type DrainHook = Arc<dyn Fn(&str, DrainStage, DrainReason) + Send + Sync + 'static>;

/// Report one drain stage to the installed seam hook, if any.
///
/// The hook is CLONED out of the mutex and called AFTER the mutex is released. That
/// is not tidiness: the hook PARKS (it blocks its caller until the test lets it go),
/// so calling it while holding the hook's own lock would wedge every other drain
/// that reports a stage, not just the one being observed.
#[cfg(test)]
fn note_drain(inner: &Inner, session_id: &str, stage: DrainStage, reason: DrainReason) {
    let hook = inner
        .drain_hook
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(hook) = hook {
        hook(session_id, stage, reason);
    }
}

/// The batching decorator on [`FulcrumPersistence`]. See the module docs for the
/// whole argument: what may be coalesced and why, where it flushes, what the
/// interval costs, and the three places the "all display writes" claim is false.
pub struct BatchingPersistence {
    inner: Arc<Inner>,
}

impl BatchingPersistence {
    /// Wrap `db`, flushing on [`DEFAULT_FLUSH_INTERVAL`] (250 ms) and at every
    /// flush point the module docs list.
    pub fn new(db: Arc<Db>) -> Self {
        Self::with_interval(db, DEFAULT_FLUSH_INTERVAL)
    }

    /// Wrap `db` with an explicit interval. The seam for the tests that must pin
    /// the window, and for the tests that must prove "still buffered" — nothing
    /// in production passes it.
    pub fn with_interval(db: Arc<Db>, interval: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                interval,
                next_token: AtomicU64::new(1),
                sessions: StdMutex::new(HashMap::new()),
                drains: StdMutex::new(HashMap::new()),
                drain_barrier: StdRwLock::new(()),
                #[cfg(test)]
                drain_hook: StdMutex::new(None),
            }),
        }
    }

    /// TEST-ONLY: install a seam hook told, synchronously, how far each drain of a
    /// session has got.
    ///
    /// This exists because the invariant this module claims — "for one
    /// `(session_id, kind, message_key)`, commit order equals buffer order" — is a
    /// claim about an INTERLEAVING, and an interleaving cannot be pinned by racing
    /// two threads and hoping: `HashMap` iteration order and OS scheduling would
    /// make such a test pass by luck and fail by luck. The hook lets a test PARK a
    /// drain at a named stage, run the competing drain around it, and release it, so
    /// the interleaving the docs argue about is the interleaving the test runs.
    ///
    /// One hook at a time. It runs ON THE DRAIN'S OWN THREAD and may BLOCK that
    /// drain, which is the point — but it must not call back into the decorator, or
    /// it would be testing the hook rather than the decorator.
    #[cfg(test)]
    pub(crate) fn set_drain_hook(
        &self,
        hook: impl Fn(&str, DrainStage, DrainReason) + Send + Sync + 'static,
    ) {
        *self
            .inner
            .drain_hook
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(hook));
    }

    /// The interval this decorator arms its timers with — the loss window a
    /// caller is actually running with (the doc comment's number, readable).
    pub fn interval(&self) -> Duration {
        self.inner.interval
    }

    /// Commit EVERY buffered row of EVERY session. Returns the number of row
    /// writes ISSUED, which is not the number of calls that buffered them — the
    /// difference IS the coalescing.
    ///
    /// This is what `RunEvent::Exit` calls: at quit the decorator cannot know
    /// which sessions hold rows, and "everything the app was told is on disk" is
    /// the contract a quit needs.
    pub fn flush(&self) -> Result<usize, DbError> {
        self.abort_all_timers();
        drain_all(&self.inner, DrainReason::FlushAll)
    }

    /// Commit ONE session's buffered rows, leaving every other session's batch
    /// alone. The per-session flush points use this: a compaction on one session
    /// must not reach into another live session's half-written accumulator.
    ///
    /// A session with nothing pending is a no-op returning `Ok(0)`.
    pub fn flush_session(&self, session_id: &str) -> Result<usize, DbError> {
        let timer = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(session_id)
            .and_then(|s| s.timer.take().map(|(_, task)| task));
        if let Some(task) = timer {
            task.abort();
        }
        drain_one(&self.inner, session_id, DrainReason::FlushSession)
    }

    /// Flush one session before a pass-through write, and REPORT whether it landed.
    ///
    /// A failed pre-flush is always LOGGED — a lost batch stays loud, which is the
    /// discipline that makes "errors move to the flush" survivable — and then the
    /// two callers diverge deliberately:
    ///
    /// * `Insert` DISCARDS the error. It upserts one row of the provider
    ///   transcript on its own key; the deferred batch it just failed to write is a
    ///   different table's problem, and refusing a single transcript row because a
    ///   display flush failed would turn a deferred loss into a hard one on a path
    ///   the crate cannot retry.
    /// * `Replace` PROPAGATES it, and that is the decision this function exists to
    ///   make visible. `Replace` is the compaction rewrite: one atomic transaction
    ///   that DELETES the session's transcript and re-inserts it. If the pending
    ///   batch could not be written first, the rewrite would go ahead on a session
    ///   whose display rows are already gone — and a rewrite is the one operation
    ///   that makes that permanent. A deferred row can still land later; a row whose
    ///   transcript has just been replaced cannot, because nothing will ever re-emit
    ///   a payload for a message that no longer exists in its old form. Refusing the
    ///   rewrite costs a compaction the caller can retry; performing it costs a
    ///   transcript nobody can rebuild. So: log it AND fail the write.
    fn flush_before_passthrough(&self, session_id: &str, where_: &str) -> Result<(), DbError> {
        if let Err(e) = self.flush_session(session_id) {
            fulcrum_harness::debuglog::log(&format!(
                "batching flush (before a pass-through write, {where_}, session \
                 {session_id}): deferred write failed: {e}"
            ));
            return Err(e);
        }
        Ok(())
    }

    /// Abort every armed timer. Called before a flush that takes the whole
    /// buffer: those tasks would wake to find nothing, and `Drop` in particular
    /// must not leave tasks pointed at an `Arc<Inner>` nobody else holds.
    fn abort_all_timers(&self) {
        let armed: Vec<tokio::task::JoinHandle<()>> = {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            sessions
                .values_mut()
                .filter_map(|s| s.timer.take().map(|(_, task)| task))
                .collect()
        };
        for task in armed {
            task.abort();
        }
    }

    /// Buffer one row — or write it through when nothing could be trusted to
    /// flush it later.
    ///
    /// `Err` here means exactly one thing: the write went to SQLite immediately
    /// and SQLite refused it. A BUFFERED write cannot report an error at this
    /// point by construction; its error, if any, surfaces at the flush (module
    /// docs: "Errors move to the flush").
    ///
    /// The write-through branch is the branch that keeps this module honest. A
    /// timer needs a tokio runtime (`Handle::try_current` — the same guard, for
    /// the same reason, as `attention.rs`'s `arm`, whose own no-runtime test
    /// records that a plain `#[test]` thread has none). With no runtime there is
    /// no timer, and with no timer a buffered row has NO bound on how long it
    /// sits — "buffered forever" is lost data with extra steps. So: **no runtime,
    /// no buffering.**
    ///
    /// THE WRITE-THROUGH BRANCH FLUSHES THIS SESSION'S BATCH FIRST, for the same
    /// reason `Insert` and `Replace` do, and it is the same invariant: this write
    /// goes to SQLite NOW, so anything still buffered for this session is by
    /// definition older and must land first. Without the pre-flush, a row buffered
    /// on a thread WITH a runtime could be committed by that session's timer AFTER
    /// this write-through landed, and last-commit-wins would leave the older
    /// payload on disk. `flush_before_passthrough` is synchronous and cheap — one
    /// batched transaction, and it aborts this session's armed timer instead of
    /// waiting for it, so it costs the interval nothing. Flushing from here is
    /// possible precisely because nothing below awaits: `flush_session` is `std`
    /// all the way down, and `JoinHandle::abort` is a `remote_abort` that needs no
    /// runtime on the calling thread.
    ///
    /// The pre-flush's own error is LOGGED and not returned, exactly as it is for
    /// `Insert`; see [`BatchingPersistence::flush_before_passthrough`] for why, and
    /// for why `Replace` refuses it instead.
    ///
    /// THE RESIDUAL WINDOW, precisely. What is closed is the finding's case: a
    /// payload buffered BEFORE this call began can no longer be committed after it,
    /// because the pre-flush drains it (and queues behind a drain that already took
    /// it) before `through()` runs. What is NOT closed, and cannot be by anything
    /// here, is a payload buffered CONCURRENTLY with this call on another thread —
    /// two writers that never saw each other's data, on a decorator that keeps no
    /// sequence number, so there is no buffer order between them to preserve and
    /// SQLite's own serialisation decides. That is the same window every pair of
    /// concurrent writers on this seam has always had, and it is not the inversion
    /// this fix is for: the inversion needs an OLDER value to be in the buffer, and
    /// after the pre-flush there is nothing older left in it.
    fn buffer_or_write(
        &self,
        session_id: &str,
        add: impl FnOnce(&mut Pending),
        through: impl FnOnce() -> Result<(), DbError>,
    ) -> Result<(), DbError> {
        if !self.arm_timer(session_id) {
            // Logged and discarded, exactly as `Insert` does: the rows this failed
            // to write are OLDER than the write about to land, they have already
            // been taken out of the buffer, and refusing a row the caller can retry
            // would trade a deferred loss for a hard one.
            let _ = self.flush_before_passthrough(session_id, "write-through");
            return through();
        }
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        add(&mut sessions.entry(session_id.to_string()).or_default().pending);
        Ok(())
    }

    /// Arm this session's timer if — and only if — no timer is armed for it.
    /// Returns `false` only when there is no runtime to hold one, which is the
    /// caller's signal to write through instead of buffering.
    ///
    /// THE RE-ARM POLICY IS DELIBERATELY NOT `attention.rs`'S. `AttentionTimer::arm`
    /// (`attention.rs:119-200`) takes the slot from whatever countdown is stored
    /// there and `abort()`s it, which is right for a ONE-SHOT alert whose
    /// countdown should restart on each event. Copied here it would be a DEBOUNCE
    /// WITH NO BOUND: a streaming transcript re-arms every frame, so the timer
    /// never expires and the loss window silently becomes the whole turn. So the
    /// timer is armed by the FIRST buffered row for a session and then left
    /// alone; the task releases the slot itself when it fires, and a later write
    /// arms a fresh one. What IS borrowed from `attention.rs` is the MECHANICS at
    /// `:167-193` — spawn first, then take the lock for the swap alone, so a
    /// `std` guard is never held across a spawn.
    fn arm_timer(&self, session_id: &str) -> bool {
        // Probed BEFORE the lock, as `attention.rs` does: a declined arm must not
        // disturb anything already armed.
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return false;
        };

        // Already armed? One lock pass, and the answer is final: two threads
        // buffering the same session concurrently must not both decide to arm
        // (the loser's task would be a duplicate commit, not merely waste).
        let token = self.inner.next_token.fetch_add(1, Ordering::Relaxed);
        {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if sessions
                .entry(session_id.to_string())
                .or_default()
                .timer
                .is_some()
            {
                return true;
            }
        }

        // Spawned OUTSIDE the lock. The task holds a `Weak`, never the decorator:
        // a task holding the value whose map holds the task is a cycle, and the
        // `Drop` backstop would then never run even in the local cases it covers.
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let sid = session_id.to_string();
        let task = handle.spawn(async move {
            let Some(interval) = weak.upgrade().map(|inner| inner.interval) else {
                return; // the decorator is gone; nobody left to flush for.
            };
            tokio::time::sleep(interval).await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            // Release the slot BEFORE taking the rows, so a row arriving between
            // the two can arm its own timer. In the other order a row could land
            // after the take and before the release, find the slot still
            // occupied, decline to arm — and then sit there with nothing armed
            // behind it until some later write or the quit. That is a hole in the
            // BOUND, and the bound is the only thing this timer is for.
            //
            // It is NOT what keeps the commit order honest — that is the drain
            // gate `drain_one` takes below, and the two orderings close different
            // holes. Releasing early means a row buffered in this window can arm
            // its own timer; the gate means that row's drain and this one's cannot
            // commit in the wrong order. Dropping either one reopens one hole while
            // leaving the other closed, which is exactly how a fix here could look
            // complete and not be.
            {
                let mut sessions = inner.sessions.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(entry) = sessions.get_mut(&sid) {
                    if entry
                        .timer
                        .as_ref()
                        .is_some_and(|(armed, _)| *armed == token)
                    {
                        entry.timer = None;
                    }
                }
            }
            #[cfg(test)]
            note_drain(
                &inner,
                &sid,
                DrainStage::ReleasedSlot,
                DrainReason::IntervalTimer,
            );
            // The gate is taken AFTER the release and BEFORE the take, in that
            // order: taking it before the release would let a row buffered while
            // this task held the gate find the slot still occupied and be orphaned.
            if let Err(e) = drain_one(&inner, &sid, DrainReason::IntervalTimer) {
                // The deferred error becomes real HERE, and this is the one place
                // it can be reported at all: no caller waits on a timer. Loud on
                // purpose — a silently dropped transcript is the failure mode
                // this design is one step away from.
                fulcrum_harness::debuglog::log(&format!(
                    "batching flush (interval, session {sid}): deferred write failed: {e}"
                ));
            }
        });

        // Install, or discard. If a flush point took the slot while the task was
        // being built, that owner keeps its own arm and this task is an orphan.
        let orphan = {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let entry = sessions.entry(session_id.to_string()).or_default();
            if entry.timer.is_some() {
                Some(task)
            } else {
                entry.timer = Some((token, task));
                None
            }
        };
        if let Some(orphan) = orphan {
            // A flush took the slot (or a racing writer won the claim) — their
            // timer does the commit, and this one would write the same rows.
            orphan.abort();
        }
        true
    }
}

/// Take buffered rows out of the map — under the lock, and NOTHING else happens
/// under it: no SQLite, no `await`. Taking before writing is what keeps a 14 ms
/// commit from moving the jank out of SQLite and into this mutex, which would be
/// the opposite of the task.
///
/// `None` takes every session; `Some(sid)` takes one.
fn take(inner: &Arc<Inner>, session_id: Option<&str>) -> Vec<(String, Pending)> {
    let mut sessions = inner.sessions.lock().unwrap_or_else(|p| p.into_inner());
    match session_id {
        Some(sid) => sessions
            .remove(sid)
            .filter(|entry| !entry.pending.is_empty())
            .map(|entry| vec![(sid.to_string(), entry.pending)])
            .unwrap_or_default(),
        None => std::mem::take(&mut *sessions)
            .into_iter()
            .filter(|(_, entry)| !entry.pending.is_empty())
            .map(|(sid, entry)| (sid, entry.pending))
            .collect(),
    }
}

/// Write a drained batch. Returns the number of row writes issued.
///
/// HONEST SIZING of "one commit", because the phrase is easy to over-read: the
/// `messages` rows — the ~60/sec flood, and the entire reason this module exists
/// — go through ONE `record_messages_batch` transaction. The three `sessions`
/// columns are individual `UPDATE`s in autocommit, because `Db` exposes no batch
/// API for that table and adding one is `db.rs`'s business, not this file's.
/// Those land at a few per TURN, not a few per second, so they are not the
/// pressure being relieved — and this comment says so rather than claiming one
/// commit for a batch that is not literally one commit.
///
/// ONE ERROR BOUNDARY PER SESSION, and it is not a nicety. `flush()` drains
/// EVERY session and this loop then writes them one at a time, so a `?` here
/// abandoned every session still queued behind the one that failed — rows that
/// `take()` had ALREADY removed from the buffer, so they were not deferred, they
/// were lost, and never re-queued. The module docs license dropping the batch
/// SQLite refused; they never licensed dropping the innocent co-batched ones.
/// So: log it, keep going, and report the FIRST failure at the end so the
/// "errors move to the flush" contract still holds for whoever calls.
///
/// The log line here and the one the caller writes are complementary, not a
/// duplicate: this one names WHICH session was refused (the caller cannot know —
/// it gets one `Result` for the whole batch), the caller's names WHERE the flush
/// was invoked from.
fn write(
    inner: &Arc<Inner>,
    drained: &[(String, Pending)],
    reason: DrainReason,
) -> Result<usize, DbError> {
    let mut writes = 0usize;
    let mut first_error: Option<DbError> = None;
    for (session_id, pending) in drained {
        match write_session(inner, session_id, pending) {
            Ok(issued) => writes += issued,
            Err(e) => {
                fulcrum_harness::debuglog::log(&format!(
                    "batching flush ({}): session {session_id} was refused and its \
                     buffered rows are dropped: {e}",
                    reason.label()
                ));
                // Keep the FIRST failure — with several refused sessions it is
                // as good a representative as any, and the per-session line
                // above already names each one.
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(writes),
    }
}

/// Write ONE session's drained rows. The unit the boundary above is drawn at:
/// within a session a failure still stops at the failure (the display batch is
/// one all-or-nothing transaction, and a session that cannot write its
/// transcript is not served by trying its `sessions` columns next).
fn write_session(
    inner: &Arc<Inner>,
    session_id: &str,
    pending: &Pending,
) -> Result<usize, DbError> {
    let mut writes = 0usize;
    if !pending.display.is_empty() {
        let rows: Vec<(&str, &str, Option<&str>, &str)> = pending
            .display
            .iter()
            .map(|slot| {
                (
                    session_id,
                    slot.kind.as_str(),
                    slot.message_key.as_deref(),
                    slot.payload_json.as_str(),
                )
            })
            .collect();
        Db::record_messages_batch(&inner.db, &rows)?;
        writes += rows.len();
    }
    if let Some((used, window)) = pending.context {
        Db::record_session_context_usage(&inner.db, session_id, used, window)?;
        writes += 1;
    }
    if let Some(cost) = pending.cost {
        Db::record_session_cost(&inner.db, session_id, cost)?;
        writes += 1;
    }
    // `todos` is `Option<Option<String>>`: the OUTER `None` is "nothing
    // pending" (write nothing), the INNER `None` is a `todos_clear` (write
    // SQL `NULL`). Collapsing the two would silently lose a clear.
    if let Some(todos) = pending.todos.as_ref().map(|value| value.as_deref()) {
        Db::record_session_todos(&inner.db, session_id, todos)?;
        writes += 1;
    }
    Ok(writes)
}

impl Drop for BatchingPersistence {
    /// The BEST-EFFORT backstop. This is NOT the quit guarantee: `tauri::App::run`
    /// exits through `std::process::exit`, which runs no destructors, so on a real
    /// quit this never runs and `RunEvent::Exit` is what saves the buffer.
    ///
    /// It covers the last-owner cases that are not a process exit (a test's local
    /// `Arc`, a replaced `SessionManager`), and it cannot report a failure to
    /// anyone — which is itself part of why it is not a guarantee.
    fn drop(&mut self) {
        // A poisoned map at `Drop` time: nothing is left to protect, and a panic
        // inside a destructor aborts the process. Leave it. Probed HERE rather
        // than left to `take()`'s recover, so the intent stays "do not touch a
        // poisoned buffer on the way out" and not "recover it one last time".
        let armed: Vec<tokio::task::JoinHandle<()>> = {
            let Ok(mut sessions) = self.inner.sessions.lock() else {
                return;
            };
            sessions
                .values_mut()
                .filter_map(|s| s.timer.take().map(|(_, task)| task))
                .collect()
        };
        for task in armed {
            task.abort();
        }
        // Through `drain_all` and not a raw `take`+`write`: the same ordering rule
        // applies on the way out as everywhere else, and a drain still in flight
        // when the last `Arc` dies must not be able to commit behind this one.
        if let Err(e) = drain_all(&self.inner, DrainReason::Drop) {
            fulcrum_harness::debuglog::log(&format!(
                "batching flush (drop, best-effort): deferred write failed: {e}"
            ));
        }
    }
}

impl FulcrumPersistence for BatchingPersistence {
    // ── The batched writes ───────────────────────────────────────────────────

    /// Buffered — the `Display` arm's write, and the one this module exists for.
    fn record_message(
        &self,
        session_id: &str,
        kind: &str,
        message_key: Option<&str>,
        payload_json: &str,
    ) -> Result<(), StoreError> {
        self.buffer_or_write(
            session_id,
            |pending| {
                // The owned copies are built HERE and not before the call. Both
                // closures are `FnOnce` and the pass-through branch needs `&str`
                // only, so converting up front made the no-runtime write-through
                // path pay three allocations it immediately discarded — and that
                // path is the one taken whenever there is no runtime to hold a
                // timer, which is every plain test thread and any caller off the
                // async runtime.
                match pending
                    .display
                    .iter_mut()
                    .find(|slot| slot.kind == kind && slot.message_key.as_deref() == message_key)
                {
                    // Last-wins on the PAYLOAD, FIRST-SEEN on the POSITION (the
                    // `message_retracted` case in the module docs).
                    Some(slot) => slot.payload_json = payload_json.to_string(),
                    None => pending.display.push(DisplaySlot {
                        kind: kind.to_string(),
                        message_key: message_key.map(str::to_string),
                        payload_json: payload_json.to_string(),
                    }),
                }
            },
            || Db::record_message(&self.inner.db, session_id, kind, message_key, payload_json),
        )
        .map_err(StoreError::from)
    }

    /// Passes through, AFTER the pending batch for that session — the ordering
    /// flush.
    ///
    /// DEVIATION FROM THE PLAN, and the plan contradicts itself here so one
    /// reading had to win. "What to implement" lists `insert_native_message`
    /// among the five writes to buffer, but the plan's own safety analysis says
    /// "`Insert` and `Replace` pass through unbatched and unordered". The named
    /// test settles it: `tests/ipc.rs::a_subagent_transcript_persists_as_a_hidden_ephemeral_row`
    /// reads `load_native_messages(child_id)` immediately after the crate emits
    /// `subagent-closed`, and NOTHING between the child's last frame and that
    /// emission is a flush point the desktop controls — `finish_subagent` emits
    /// `subagent-closed` on the sink directly (`subagent_flow.rs:1591`), and the
    /// child's `Exited` (the router's other candidate) arrives only AFTER the
    /// teardown's graceful close.
    ///
    /// MEASURED, not argued: buffering this write (a temporary mutation of this
    /// arm) reddens that test at `tests/ipc.rs:925` — "the child's transcript
    /// rows are persisted (the `native_messages` FK held)". The plan forbids
    /// weakening it, so pass-through is the only reading that survives it.
    ///
    /// Pass-through is also the honest cost-benefit call: an `Insert` frame is
    /// one per transcript message (a handful per turn), not the ~60/sec
    /// `Display` flood the batching exists to absorb, so buffering it buys
    /// almost nothing and costs a named durability guarantee.
    fn insert_native_message(
        &self,
        session_id: &str,
        seq: i64,
        role: &str,
        content_json: &str,
    ) -> Result<(), StoreError> {
        // The pre-flush error is LOGGED and discarded here, on purpose: `Insert`
        // upserts one row of the provider transcript on its own key, and refusing it
        // because a display flush failed would turn a deferred loss into a hard one
        // on a path the crate cannot retry. `Replace` below does the opposite, and
        // `flush_before_passthrough` says why the two diverge.
        let _ = self.flush_before_passthrough(session_id, "insert");
        Db::insert_native_message(&self.inner.db, session_id, seq, role, content_json)?;
        Ok(())
    }

    /// Buffered (a snapshot of `sessions.context_usage_json`).
    fn record_session_context_usage(
        &self,
        session_id: &str,
        used: u64,
        window: u64,
    ) -> Result<(), StoreError> {
        self.buffer_or_write(
            session_id,
            |pending| pending.context = Some((used, window)),
            || Db::record_session_context_usage(&self.inner.db, session_id, used, window),
        )
        .map_err(StoreError::from)
    }

    /// Buffered — a SNAPSHOT overwrite, never a sum, so coalescing cannot
    /// manufacture money (ADR 0082).
    fn record_session_cost(&self, session_id: &str, total: f64) -> Result<(), StoreError> {
        self.buffer_or_write(
            session_id,
            |pending| pending.cost = Some(total),
            || Db::record_session_cost(&self.inner.db, session_id, total),
        )
        .map_err(StoreError::from)
    }

    /// Buffered. `None` is a `todos_clear` and is a VALUE, held as `Some(None)` so
    /// a clear cannot be lost by coalescing.
    fn record_session_todos(
        &self,
        session_id: &str,
        todos: Option<&str>,
    ) -> Result<(), StoreError> {
        let todos = todos.map(str::to_string);
        self.buffer_or_write(
            session_id,
            |pending| pending.todos = Some(todos.clone()),
            || Db::record_session_todos(&self.inner.db, session_id, todos.as_deref()),
        )
        .map_err(StoreError::from)
    }

    // ── The pass-through writes ──────────────────────────────────────────────

    /// Passes through IMMEDIATELY — and is deliberately NOT a flush point.
    ///
    /// `TranscriptPersister::ensure_session_row` writes this row and reads it back
    /// on the NEXT frame to decide whether the session exists, so buffering it
    /// would create the row twice per session. It is not a flush point for the
    /// reason reads are not: it runs once per frame, so flushing here would commit
    /// once per frame and this module would have moved the jank instead of
    /// removing it.
    fn record_session(&self, info: &SessionInfo) -> Result<(), StoreError> {
        Db::record_session(&self.inner.db, info)?;
        Ok(())
    }

    /// Passes through, AFTER the pending batch for that session — the ordering
    /// flush, and the load-bearing one. `Replace` is the compaction rewrite: one
    /// atomic transaction that DELETES the session's transcript and re-inserts it,
    /// so a batch still sitting behind it would, on its next flush, re-write rows
    /// the rewrite had just retired.
    ///
    /// THE ONE PASS-THROUGH ARM THAT FAILS WHEN ITS PRE-FLUSH FAILS. A deferred
    /// display row can still land later; a row whose transcript has just been
    /// replaced cannot, because nothing will re-emit a payload for a message that no
    /// longer exists in its old form. So a refused pre-flush refuses the rewrite —
    /// the caller can compact again, and the transcript is still intact to compact.
    fn replace_native_messages(
        &self,
        session_id: &str,
        rows: &[(i64, String, String)],
    ) -> Result<(), StoreError> {
        self.flush_before_passthrough(session_id, "replace")?;
        Db::replace_native_messages(&self.inner.db, session_id, rows)?;
        Ok(())
    }

    /// Passes through (a Space row is not a per-frame write, and no session
    /// buffer can contain one).
    fn set_space_trusted(&self, path: &str, trusted: bool) -> Result<bool, StoreError> {
        Ok(Db::set_space_trusted(&self.inner.db, path, trusted)?)
    }

    /// Passes through (same reasoning as `set_space_trusted`).
    fn upsert_space(&self, path: &str, default_trusted: bool) -> Result<(), StoreError> {
        Db::upsert_space(&self.inner.db, path, default_trusted)?;
        Ok(())
    }

    // ── The reads: straight through, and NOT flush points ────────────────────
    //
    // None of these flush. `ensure_session_row` calls `session()` on EVERY store
    // frame, so a read that flushed would commit per frame. What that costs is the
    // loss window seen from the other side, and it is stated where it can bite: a
    // read from another thread inside 250 ms can miss rows this decorator holds.

    fn session(&self, session_id: &str) -> Result<Option<SessionRow>, StoreError> {
        Ok(Db::session(&self.inner.db, session_id)?)
    }

    fn load_native_messages(&self, session_id: &str) -> Result<Vec<String>, StoreError> {
        Ok(Db::load_native_messages(&self.inner.db, session_id)?)
    }

    fn messages_for(&self, session_id: &str) -> Result<Vec<MessageRow>, StoreError> {
        Ok(Db::messages_for(&self.inner.db, session_id)?)
    }

    fn session_cost(&self, session_id: &str) -> Result<Option<f64>, StoreError> {
        Ok(Db::session_cost(&self.inner.db, session_id)?)
    }

    fn session_todos(&self, session_id: &str) -> Result<Option<String>, StoreError> {
        Ok(Db::session_todos(&self.inner.db, session_id)?)
    }

    fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionRow>, StoreError> {
        Ok(Db::list_sessions(&self.inner.db, include_archived)?)
    }

    /// The clock, delegated to the wrapped `Db`'s own trait impl — which is
    /// itself the crate's one `clock::now_ms`. A decorator that read the clock for
    /// itself would be the third private copy the crate's `clock` module exists to
    /// prevent.
    fn now_ms(&self) -> i64 {
        FulcrumPersistence::now_ms(&*self.inner.db)
    }
}

#[cfg(test)]
mod tests;
