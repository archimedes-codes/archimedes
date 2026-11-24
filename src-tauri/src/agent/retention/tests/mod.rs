use super::*;

use crate::agent::worker::client::{WorkerError, WorkerErrorKind, WorkerHandle};
use crate::agent::worker::manager::WorkerFactory;
// `SessionInfo` is NOT imported here: its first user is Step 7's `fn subagent(…) -> SessionInfo`, and
// an import nobody uses in THIS commit is an `unused_imports` warning under CI's `-D warnings`
// (Critical C3). Step 7 EDITS this line to `{ EventSink, SessionInfo, SessionManagerBuilder }` —
// an edit, not a new line, so Step 7 still adds no `use` STATEMENT.
use crate::agent::{EventSink, SessionInfo, SessionManagerBuilder};
use crate::storage::Db;
use fulcrum_harness::seams::FulcrumPersistence;
use std::path::{Path, PathBuf};

// NOTE for Step 7: `FulcrumPersistence` is what makes `deps.batched.record_message(..)` resolve, and
// `Db` / `Path` / `PathBuf` are what its fixtures name. They are imported ONCE here, at module scope
// of `retention/tests/mod.rs`. `SessionInfo` is the ONE exception — it is added to the braced line
// above at Step 7, when `subagent(…)` gives it a user.

/// Nothing in these tests ever attaches a Worker, so the sink discards and the factory REFUSES.
/// An `Err` from `spawn` is deliberate: a mis-wired test fails loudly here instead of quietly
/// launching a real `current_exe()` Worker. `WorkerError` has a `pub kind` and no constructor, so
/// the struct literal is the way.
struct DiscardingSink;
impl EventSink for DiscardingSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

struct NeverFactory;
impl WorkerFactory for NeverFactory {
    fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
        Err(WorkerError {
            kind: WorkerErrorKind::SpawnFailed,
        })
    }
}

/// The ONE database path, so a test that seeds through a raw connection and the `Db` the deps hold
/// cannot drift apart.
fn db_file(dir: &Path) -> PathBuf {
    dir.join("archimedes.db")
}

/// A real `Db` + a real (empty) `SessionManager`/`WorkerManager` pair + a real `BatchingPersistence`.
/// Both managers are EMPTY, which is what makes `Liveness::probe` report idle and the gate OPEN —
/// the tests that need a non-idle tick pass a non-idle `Liveness` to `retention_tick` directly
/// instead of conjuring a live Worker.
///
/// The batch interval is an HOUR, deliberately: `with_interval` is the documented seam for "tests
/// that must prove 'still buffered'" (`batching.rs:643-648`), and a 250 ms timer firing mid-tick
/// would flush the row Step 7's resurrection test is trying to leave in the buffer.
///
/// `tempfile::tempdir()` and NOT `ScratchDir` — `refresh.rs:848` does, and a `tempfile` name has no
/// dash, which the census's shape filter excludes, so no `scripts/check-temp-dir-census.sh`
/// attribution row is needed (`retention-` is not in that table and would print `UNATTRIBUTED`).
fn deps_for(dir: &Path) -> RetentionDeps {
    let db = Arc::new(Db::open(&db_file(dir)).expect("db opens"));
    let batched = Arc::new(BatchingPersistence::with_interval(
        db.clone(),
        Duration::from_secs(3600),
    ));
    let persister = Arc::new(crate::agent::TranscriptPersister::new(
        batched.clone() as Arc<dyn FulcrumPersistence>
    ));
    let sink: Arc<dyn EventSink> = Arc::new(DiscardingSink);
    let (session_manager, worker_manager) =
        SessionManagerBuilder::new(dir.to_path_buf(), db.clone(), sink, persister)
            // The SAME decorator the deps hold (as in `lib.rs:150`), so a flush point the router
            // reaches and the one the tick reaches are one object.
            .with_batched(batched.clone())
            .with_worker_factory(Arc::new(NeverFactory))
            .build();
    RetentionDeps::new(db, session_manager, worker_manager, batched)
}

/// The doc's first line claims 15 minutes; this pins the claim, so the prose cannot drift.
#[test]
fn the_tick_interval_is_named_and_bounded() {
    assert_eq!(RETENTION_TICK_INTERVAL, Duration::from_secs(15 * 60));
    assert!(
        !RETENTION_TICK_INTERVAL.is_zero(),
        "a zero tick is a busy spin"
    );
    assert!(
        RETENTION_TICK_INTERVAL <= Duration::from_secs(2 * 60 * 60),
        "a tick longer than 2 h means a VACUUM opportunity is missed for half a working day"
    );
}

/// The marker is a LATCH: 0 means "never swept", 1 means "swept". A marker of 0 would sweep on
/// every boot, which is the 2 GB delete the design refuses to repeat.
#[test]
fn the_schema_marker_is_the_first_version() {
    assert_eq!(RETENTION_SCHEMA_MARKER, 1_i64);
    assert_ne!(
        RETENTION_SCHEMA_MARKER, 0_i64,
        "a marker of 0 is the never-run value, not a version"
    );
}

#[test]
fn the_idle_gate_is_the_and_of_all_three_liveness_views() {
    // Every arm, because a gate that ORs instead of ANDs passes 7 of these 8.
    assert!(Liveness {
        main_sessions: 0,
        attached_workers: 0,
        in_flight_drives: 0
    }
    .is_idle());
    assert!(
        !Liveness {
            main_sessions: 1,
            attached_workers: 0,
            in_flight_drives: 0
        }
        .is_idle(),
        "a main session holding a `live` slice is not idle"
    );
    assert!(
        !Liveness {
            main_sessions: 0,
            attached_workers: 1,
            in_flight_drives: 0
        }
        .is_idle(),
        "an attached Worker is not idle"
    );
    assert!(
        !Liveness {
            main_sessions: 0,
            attached_workers: 0,
            in_flight_drives: 1
        }
        .is_idle(),
        "an in-flight subagent drive is not idle — THE case session_count() cannot see"
    );
    assert!(!Liveness {
        main_sessions: 1,
        attached_workers: 1,
        in_flight_drives: 1
    }
    .is_idle());
    assert!(!Liveness {
        main_sessions: 0,
        attached_workers: 3,
        in_flight_drives: 0
    }
    .is_idle());
    assert!(!Liveness {
        main_sessions: 0,
        attached_workers: 0,
        in_flight_drives: 3
    }
    .is_idle());
    assert!(!Liveness {
        main_sessions: 2,
        attached_workers: 0,
        in_flight_drives: 0
    }
    .is_idle());
}

#[test]
fn the_default_liveness_is_idle() {
    // Step 7's tick tests drive `Liveness::default()` as the idle case, so a future fourth field
    // that is non-zero by default (or missing from `is_idle`) reddens HERE, not silently.
    assert!(Liveness::default().is_idle());
}

#[test]
fn the_gate_reads_all_three_accessors_and_not_just_session_count() {
    // The correction this module exists to carry: the design's `session_count() == 0` alone would
    // pass while a Subagent ran. Pin the SOURCE of the probe, because building a live subagent to
    // prove it behaviourally would need a real Worker spawn.
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/agent/retention.rs"
    ))
    .expect("retention.rs readable");
    let probe = &src[src.find("pub async fn probe").expect("probe exists")..];
    let window = &probe[..probe.len().min(1200)];
    for accessor in [
        "session_count()",
        "test_session_count()",
        "test_drive_count()",
    ] {
        assert!(
            window.contains(accessor),
            "Liveness::probe must read `{accessor}` — a gate missing \
             one of the three is the correction this task exists to make"
        );
    }
}

#[test]
fn the_upgrade_sweep_is_due_only_below_the_marker() {
    // The latch is a plain `<` against RETENTION_SCHEMA_MARKER. Four arms, because `>=`, `==` and
    // `!=` each pass three of these four.
    assert!(
        upgrade_sweep_is_due(0),
        "0 is SQLite's never-set value: never swept"
    );
    assert!(
        !upgrade_sweep_is_due(RETENTION_SCHEMA_MARKER),
        "the marker means: already done"
    );
    assert!(
        !upgrade_sweep_is_due(7),
        "a LATER marker is never re-swept by an older build"
    );
    assert!(
        upgrade_sweep_is_due(-1),
        "a corrupt negative header value re-runs the sweep — the \
         latch compares, it does not validate, and a re-run is idempotent: time, not correctness"
    );
}

/// The latch, end to end, against a real file — and the compile-time pin that T1's marker verbs are
/// still named what the design fixed. T3 owns `RETENTION_SCHEMA_MARKER` and the `<`; T1 owns the
/// read and the write. `user_version` lives in the database file HEADER, so a read-back through a
/// second verb is the whole durability claim (T1's Step 5b additionally proves it across a reopen
/// and across a `VACUUM`).
#[test]
fn the_latch_reads_zero_then_the_marker_and_the_decision_follows() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let db = crate::storage::Db::open(&dir.path().join("archimedes.db")).expect("db opens");
    assert_eq!(
        db.retention_schema_version()
            .expect("a fresh file has a header"),
        0
    );
    assert!(
        upgrade_sweep_is_due(read_of(&db)),
        "a never-swept file owes the sweep"
    );

    db.set_retention_schema_version(RETENTION_SCHEMA_MARKER)
        .expect("the stamp lands");
    assert_eq!(
        read_of(&db),
        RETENTION_SCHEMA_MARKER,
        "the write verb writes what the read verb reads"
    );
    assert!(
        !upgrade_sweep_is_due(read_of(&db)),
        "a stamped file owes nothing — this is what stops \
         the 2 GB sweep running on every boot"
    );
}

/// One place the `Result` is unwrapped, so the latch tests read as assertions and not plumbing.
fn read_of(db: &crate::storage::Db) -> i64 {
    db.retention_schema_version()
        .expect("the marker reads back")
}

/// The `setup`-hook condition, pinned in isolation (the same measurement
/// `refresh.rs:1118-1134` makes): a plain `#[test]` thread has NO current runtime, so a
/// `try_current`-only factory would DECLINE here and the loop would never run in production.
#[test]
fn the_production_runtime_fallback_spawns_where_try_current_declines() {
    assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "the premise: a plain test thread has no current runtime"
    );
    let handle = tauri::async_runtime::handle().inner().clone();
    let ran = Arc::new(AtomicUsize::new(0));
    let flag = ran.clone();
    let task = handle.spawn(async move {
        tokio::time::sleep(Duration::from_millis(5)).await;
        // QUALIFIED, not imported: `Ordering` has no production user until Step 7, so the parent
        // cannot import it yet (C3) and `use super::*;` therefore cannot bring it down.
        flag.store(1, Ordering::SeqCst);
    });
    tauri::async_runtime::block_on(task).expect("the spawned task ran");
    assert_eq!(
        ran.load(Ordering::SeqCst),
        1,
        "Tauri's singleton runtime executes the task, where a bare probe would decline"
    );
}

/// The `attention::arm` guard, pinned: no runtime ⇒ `None` (a DECLINE), never the `tokio::spawn`
/// panic. `tokio::spawn` with no reactor PANICS, and a sync caller must be turned down, not crash
/// the app. A plain `#[test]` is exactly the `setup`-hook condition.
#[test]
fn start_declines_without_a_runtime_instead_of_panicking() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        spawn_retention_loop_on_current(&deps_for(dir.path()))
    }));
    assert!(
        matches!(&outcome, Ok(None)),
        "no runtime ⇒ None (declined), never a panic: {:?}",
        outcome.as_ref().map(Option::is_some)
    );
}

#[tokio::test]
async fn the_loop_stops_by_joining_not_by_being_aborted() {
    // `stop()` JOINS, so a loop that slept through the cancel TIMES OUT here instead of passing
    // (the `refresh.rs:1084 cancel_breaks_the_loop` shape).
    let dir = tempfile::tempdir().expect("a temp dir");
    let Some(handle) = spawn_retention_loop_on_current(&deps_for(dir.path())) else {
        panic!("a runtime holds the loop");
    };
    let exited = tokio::time::timeout(Duration::from_secs(5), handle.stop()).await;
    assert!(
        exited.is_ok(),
        "the loop's task exited on its own after the cancel"
    );
}

/// A closed Subagent session row, `is_subagent = true`. `record_session` upserts, so calling this
/// once per id is the whole seed. `cwd` is never read by the sweep; the temp dir keeps it real.
fn subagent(id: &str, dir: &Path) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: dir.to_path_buf(),
        capabilities: serde_json::json!({ "model": "fake/m1" }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        is_subagent: true,
        cost_usd: None,
    }
}

/// Move a session's `created_at` back `ms` milliseconds, through a SECOND RAW `rusqlite::Connection`
/// on the SAME file — the `commands/history.rs:333-340` idiom, and the same helper `shape` T1's
/// Step 3 fixture uses.
///
/// This is REQUIRED, not stylistic: `Db::record_session` stamps `now_ms()` (`db/sessions.rs:46`) and
/// NO `Db` verb writes `created_at`, and `Db::conn` is private (`db/mod.rs:540-542`) — so without a
/// raw connection there is NO reachable way to make a child OLD, and every sweep test here would
/// silently exercise an EMPTY target set and pass while proving nothing.
///
/// The raw connection is DROPPED IN ITS OWN BLOCK before any `Db` read (T1's note, and the ordering
/// `tests/storage.rs:263` uses): two live connections on one WAL file is a lock conversation nobody
/// needs to have inside a unit test.
fn age(db_path: &Path, id: &str, ms: i64) {
    let cutoff = fulcrum_harness::clock::now_ms() - ms;
    {
        let conn = rusqlite::Connection::open(db_path).expect("raw open of the fixture db");
        conn.execute(
            "UPDATE sessions SET created_at = ?1 WHERE id = ?2",
            rusqlite::params![cutoff, id],
        )
        .expect("age the fixture child");
    }
}

/// One aged child with 3 committed display rows + 2 native rows, plus `extra` further children that
/// stay young. Returns nothing; read the db.
fn seed_aged_child(db: &Db, db_path: &Path, dir: &Path, id: &str) {
    db.record_session(&subagent(id, dir))
        .expect("child recorded");
    // DISTINCT non-null message_keys: `UNIQUE(session_id, kind, message_key)` treats NULLs as
    // DISTINCT, so NULL keys would let the row count drift with upsert behaviour and the assertions
    // below would stop being arithmetic.
    db.record_message(id, "agent-text", Some("m1"), "{}")
        .expect("row m1");
    db.record_message(id, "agent-thought", Some("m2"), "{}")
        .expect("row m2");
    db.record_message(id, "tool-call", Some("m3"), "{}")
        .expect("row m3");
    db.insert_native_message(id, 1, "user", "{}")
        .expect("native 1");
    db.insert_native_message(id, 2, "assistant", "{}")
        .expect("native 2");
    age(db_path, id, 25 * 3600 * 1000); // strictly older than the 24 h bound (the bound is `<`)
}

#[tokio::test]
async fn an_idle_tick_sweeps_once_and_stamps_the_marker() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let deps = deps_for(dir.path());
    let db = deps.db.clone();
    seed_aged_child(&db, &db_file(dir.path()), dir.path(), "c_old");
    assert_eq!(
        db.retention_schema_version().expect("latch reads"),
        0,
        "the owes-the-sweep case"
    );

    let outcome = retention_tick(&deps, &Liveness::default()).await;

    assert!(
        outcome.swept,
        "an idle tick with the latch below the marker sweeps"
    );
    assert_eq!(
        outcome.sessions_pruned, 1,
        "one closed child older than the bound"
    );
    // The arithmetic of T1's rule, stated once so every number below is checkable: 3 display rows
    // seeded, `MAX(id)` keeps the newest, so 2 are deleted and 1 survives; both native rows go.
    assert_eq!(
        outcome.display_rows_deleted, 2,
        "3 seeded rows, newest survives (T1's MAX(id) rule)"
    );
    assert_eq!(
        outcome.native_rows_deleted, 2,
        "the whole native transcript goes"
    );
    assert!(
        !outcome.vacuumed,
        "a fresh file's freelist is nowhere near 256 MB"
    );
    assert_eq!(
        deps.tick_count.load(Ordering::SeqCst),
        1,
        "the tick counted itself once"
    );
    assert_eq!(
        db.retention_schema_version().expect("latch reads"),
        RETENTION_SCHEMA_MARKER,
        "a SUCCESSFUL sweep stamps the latch — this is what makes it one-time"
    );
    assert_eq!(
        db.messages_for("c_old").expect("read").len(),
        1,
        "exactly the newest row survives"
    );
    assert!(
        db.load_native_messages("c_old").expect("read").is_empty(),
        "no native row survives"
    );
}

#[tokio::test]
async fn a_second_idle_tick_does_not_sweep_again() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let deps = deps_for(dir.path());
    let db = deps.db.clone();
    seed_aged_child(&db, &db_file(dir.path()), dir.path(), "c_old");

    let first = retention_tick(&deps, &Liveness::default()).await;
    let second = retention_tick(&deps, &Liveness::default()).await;

    assert!(first.swept, "the first tick does the work");
    assert!(
        !second.swept,
        "the second tick reads the latch and does NOTHING — this is the \
         2 GB delete the design refuses to repeat"
    );
    assert_eq!(second.sessions_pruned, 0);
    assert_eq!(second.display_rows_deleted, 0);
    assert_eq!(
        deps.tick_count.load(Ordering::SeqCst),
        2,
        "the loop still ticked; it just had nothing to do"
    );
    assert_eq!(
        db.retention_schema_version().expect("latch reads"),
        RETENTION_SCHEMA_MARKER,
        "the stamp is not written twice, so it cannot be re-written wrong"
    );
}

#[tokio::test]
async fn a_busy_tick_deletes_nothing_and_stamps_nothing() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let deps = deps_for(dir.path());
    let db = deps.db.clone();
    seed_aged_child(&db, &db_file(dir.path()), dir.path(), "c_old");

    // THE case `session_count()` cannot see: an in-flight subagent drive.
    let busy = Liveness {
        main_sessions: 0,
        attached_workers: 0,
        in_flight_drives: 1,
    };
    let outcome = retention_tick(&deps, &busy).await;

    assert!(outcome.declined_busy, "a non-idle tick declines");
    assert!(!outcome.swept);
    assert_eq!(outcome.sessions_pruned, 0);
    assert_eq!(
        db.retention_schema_version().expect("latch reads"),
        0,
        "THE LATCH IS NOT STAMPED when the sweep was skipped — stamping it would declare a \
         2 GB backlog handled and never reclaim it"
    );
    assert_eq!(
        db.messages_for("c_old").expect("read").len(),
        3,
        "nothing was deleted"
    );
    assert_eq!(
        db.load_native_messages("c_old").expect("read").len(),
        2,
        "nothing was deleted"
    );
    assert_eq!(
        deps.tick_count.load(Ordering::SeqCst),
        1,
        "the tick ran and counted; declining is a tick"
    );
}

#[tokio::test]
async fn the_main_session_and_attached_worker_arms_also_block_the_sweep() {
    // The other two non-zero arms, same assertions, fresh db per arm: a gate that only checks
    // `in_flight_drives` passes the test above and fails these.
    for busy in [
        Liveness {
            main_sessions: 1,
            attached_workers: 0,
            in_flight_drives: 0,
        },
        Liveness {
            main_sessions: 0,
            attached_workers: 1,
            in_flight_drives: 0,
        },
    ] {
        let dir = tempfile::tempdir().expect("a temp dir");
        let deps = deps_for(dir.path());
        let db = deps.db.clone();
        seed_aged_child(&db, &db_file(dir.path()), dir.path(), "c_old");

        let outcome = retention_tick(&deps, &busy).await;

        assert!(outcome.declined_busy, "{busy:?} must hold the sweep back");
        assert_eq!(outcome.sessions_pruned, 0);
        assert_eq!(
            db.retention_schema_version().expect("latch reads"),
            0,
            "no stamp on a skipped sweep"
        );
        assert_eq!(db.messages_for("c_old").expect("read").len(), 3);
    }
}

/// THE RESURRECTION GUARD (correction 7). A row still in the in-memory buffer when the sweep deletes
/// its child commits AFTER the DELETE, and the child ends up with a transcript the sweep never saw:
/// the sweep reports it pruned, the latch is stamped, and the row survives FOREVER because nothing
/// will ever target that child again. Pin the ORDER by its arithmetic, not by a comment.
///
/// WHAT THIS PIN DOES AND DOES NOT COVER (measured, not assumed): it discriminates flush-FIRST from
/// flush-LAST — swapping the two reddens on `display_rows_deleted` (2 for 3) and on the survivor's
/// key. It does NOT discriminate `flush()` from `flush_session(child_id)`, because this fixture has
/// exactly ONE child, so draining that one child is the same set as draining the buffer. Substituting
/// `flush_session("c_old")` for `flush()` here was measured to leave all 15 tests GREEN. The whole
/// buffer is still the correct verb (the sweep's target set is EVERY closed child, and there is no
/// single id to pass); making that substitution detectable needs a SECOND aged child holding a
/// buffered row, which is the test to add if that ever has to be proven.
#[tokio::test]
async fn the_sweep_flushes_the_buffer_before_it_deletes() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let deps = deps_for(dir.path()); // a 1 h batch interval — nothing flushes on its own here
    let db = deps.db.clone();
    seed_aged_child(&db, &db_file(dir.path()), dir.path(), "c_old"); // 3 committed rows
    assert_eq!(db.messages_for("c_old").expect("read").len(), 3);

    // A FOURTH row, buffered and NOT committed. `with_interval` is the documented seam that keeps it
    // in the buffer (`batching.rs:643-648`). A distinct key, so it cannot coalesce into m1.
    deps.batched
        .record_message("c_old", "agent-text", Some("m4"), "{}")
        .expect("the row is buffered");
    assert_eq!(
        db.messages_for("c_old").expect("read").len(),
        3,
        "still 3 on disk — the fourth row is in memory, which is the whole hazard"
    );

    let outcome = retention_tick(&deps, &Liveness::default()).await;

    // FLUSH-FIRST (correct): the buffer lands m4 → 4 rows → MAX(id) keeps m4, 3 deleted, 1 survivor.
    // FLUSH-LAST (the bug): 3 rows → 2 deleted, then m4 commits → 2 rows on disk and a NEWEST row
    // the sweep never counted. Both numbers below discriminate between those two orders.
    assert_eq!(
        outcome.display_rows_deleted, 3,
        "3 means the buffer was flushed BEFORE the delete; 2 means it was deleted first and \
         the buffered row resurrected the child's transcript behind the sweep's back"
    );
    assert_eq!(outcome.sessions_pruned, 1);
    let rows = db.messages_for("c_old").expect("read");
    assert_eq!(
        rows.len(),
        1,
        "exactly one row survives — a second one IS the resurrection"
    );
    assert_eq!(
        rows[0].message_key.as_deref(),
        Some("m4"),
        "and it is the row that was in the buffer, which is only possible if the flush came first"
    );
    assert_eq!(
        db.retention_schema_version().expect("latch reads"),
        RETENTION_SCHEMA_MARKER
    );
}

/// Duplicated on purpose (`batching/tests/mod.rs:53`, `attention.rs:229`, `tests/attention_trace.rs:45`
/// all carry their own copy): see the doc for why both halves matter.
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

/// The cadence, on a paused clock — THE test that proves the loop ever wakes. The pre-advance
/// assertion is what makes the post-advance one mean anything: a loop that ticked on every poll
/// would pass without it. Counted through `RetentionDeps::tick_count`, which the tick bumps
/// SYNCHRONOUSLY at its top — see the ordering constraint below.
#[tokio::test(start_paused = true)]
async fn the_loop_wakes_one_tick_interval_after_the_previous_wake() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let mut deps = deps_for(dir.path());
    deps.tick_interval = Duration::from_millis(200);
    // CLONE THE Arc and hold it separately: the loop owns `deps`, so a count read through a second
    // handle is the only way to see it from out here.
    let ticks = deps.tick_count.clone();

    let Some(handle) = spawn_retention_loop_on_current(&deps) else {
        panic!("a runtime holds the loop");
    };
    // Register the sleep BEFORE the first advance, or the timer fires one interval late.
    settle().await;

    tokio::time::advance(Duration::from_millis(199)).await;
    settle().await;
    assert_eq!(
        ticks.load(Ordering::SeqCst),
        0,
        "a wake before the interval would make the assertion below vacuous"
    );

    tokio::time::advance(Duration::from_millis(2)).await;
    settle().await;
    assert_eq!(
        ticks.load(Ordering::SeqCst),
        1,
        "one interval must produce exactly one tick"
    );

    handle.stop().await;
}

/// The first wake is one interval AFTER boot, not at t=0 — see `run_loop`'s doc. A t=0 tick would
/// delete ~2 GB and VACUUM while the window paints, on the mutex the boot history reads use.
#[tokio::test(start_paused = true)]
async fn the_loop_does_not_tick_at_boot() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let mut deps = deps_for(dir.path());
    deps.tick_interval = Duration::from_millis(200);
    let ticks = deps.tick_count.clone();

    let Some(handle) = spawn_retention_loop_on_current(&deps) else {
        panic!("a runtime holds the loop");
    };
    // Polled enough to have reached its FIRST await (the sleep) — and still nothing has run.
    settle().await;
    assert_eq!(
        ticks.load(Ordering::SeqCst),
        0,
        "a tick at t=0 means the sweep runs while the window paints and while boot-time \
         history reads are in flight, on the one Mutex they all share"
    );

    handle.stop().await;
}

/// THE TEST-DISCIPLINE PIN. A retention loop that fired under `cargo test` would DELETE ROWS out
/// from under other tests. The mechanism is the entry-point split, so pin the split in the source
/// that carries it: the test-facing entry passes `None`, the production entry passes `Some(..)`.
#[test]
fn no_retention_loop_starts_from_a_test_facing_entry_point() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("lib.rs readable");
    let test_entry = &src[src
        .find("pub fn setup_dirs_with_factory<")
        .expect("test entry exists")..];
    let test_body = &test_entry[..test_entry
        .find("pub fn setup_dirs_with_factory_refresher")
        .expect("prod entry follows")];
    assert!(
        test_body.contains("init_dir_deps(app, config_dir, app_data_dir, worker_factory, None"),
        "the test-facing entry must pass None for the refresher factory"
    );
    assert!(
        test_body.contains(", None, None)"),
        "the test-facing entry must ALSO pass None for the retention factory — a loop here \
         deletes rows out from under other tests"
    );

    let prod_entry = &src[src
        .find("pub fn setup_dirs_with_factory_refresher<")
        .expect("prod entry exists")..];
    let prod_body = &prod_entry[..prod_entry
        .find("fn init_dir_deps")
        .expect("the shared core follows")];
    assert!(
        prod_body.contains("production_retention_factory"),
        "the production entry must actually start the retention loop, or the backlog is never reclaimed"
    );
}
