//! The `BatchingPersistence` decorator's tests (issue #155, Task 3).
//!
//! The premise every commit-counting test here rests on is that a `Db` opened
//! over a real file runs in WAL, so a commit appends frames to the `-wal`
//! sidecar and the sidecar's length is a COMMIT COUNTER. Task 2 established that
//! instrument (`storage::db::tests::wal_frame_count`) and recorded why the two
//! `PRAGMA`-level candidates are NOT commit counters (`data_version` moved by 1
//! for 12 autocommits; `total_changes` does not step back on a rollback). This
//! module re-derives the counter locally instead of reaching into `db.rs`'s
//! private `conn`: the page size comes from the SQLite FILE header (offset 16, a
//! big-endian u16), which is the number the WAL arithmetic is actually computed
//! against — reading it from the file is the stronger instrument, not a workaround.
//!
//! WHY a commit counter and not a call counter: the acceptance criterion is "N
//! `Display` frames produce ONE commit". Counting how often the decorator's own
//! method was called measures the decorator's bookkeeping and stays GREEN against
//! an implementation that writes every row it is handed — the hollow version of
//! exactly the check it is meant to be. Frames in the `-wal` file are what the
//! disk did. The non-vacuity proof is on
//! [`a_stream_of_display_frames_costs_one_commit_and_not_n`]: mutate
//! `write_batch`'s display arm into the per-row autocommit loop it replaces and
//! that test goes red.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fulcrum_harness::seams::FulcrumPersistence;

use crate::storage::{BatchingPersistence, Db, DEFAULT_FLUSH_INTERVAL};
use crate::types::SessionInfo;

/// Let a spawned timer task actually run under a PAUSED clock.
///
/// TWO things this is for, both measured rather than assumed, and `attention.rs`
/// does both for the same reasons (`attention.rs:229-233` is this helper, and its
/// tests call it after `arm` and again after every `advance`):
///
/// * **After arming, BEFORE the first `advance`.** A `tokio::time::sleep` is only
///   registered with the (paused) clock when its task is first polled, and a
///   freshly spawned task has not been polled yet. Advancing first therefore
///   advances past a deadline that did not exist during the advance, and the
///   timer fires one full interval LATE — measured: `advance(199)` with no
///   preceding settle left the task unfired even at `advance(201)`.
/// * **After each `advance`.** Waking the sleeping task is not running it: the
///   task then needs several polls to get through its lock, its take and its
///   SQLite write, and one `yield_now` is not enough.
///
/// Without both, a green assertion here would be a scheduling coincidence rather
/// than a result.
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

/// A temp-dir `Db` (guard FIRST: fields drop in declaration order, so the `Db` —
/// whose file lives INSIDE the dir — closes before the dir is removed. Linux
/// unlinks happily under an open handle; Windows refuses, so the ordering is
/// enforced by reading).
fn temp_db(tag: &str) -> (crate::test_support::ScratchDir, Arc<Db>) {
    let dir = crate::test_support::ScratchDir::in_env_temp(tag, "batching");
    let db = Arc::new(Db::open(&dir.join("t.db")).expect("the db opens"));
    (dir, db)
}

/// A `sessions` row — the `messages` FK source. Most tests need one; the
/// deferred-error test deliberately omits it, because the constraint violation
/// is what makes the deferred error observable.
fn seed_session(db: &Db, id: &str) {
    db.record_session(&SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::Value::Null,
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("the sessions row is recorded");
}

/// An interval long enough that no timer can fire mid-test: where a test
/// measures frames or asserts "still buffered", an interval that expired during
/// the run would change the numbers for a reason unrelated to what is measured.
/// The interval's OWN behaviour is pinned separately, by
/// [`the_interval_flushes_within_the_named_window`], under a paused clock.
const LONG: Duration = Duration::from_secs(600);

/// The page size from the SQLite file header (offset 16, big-endian u16; the
/// legacy value `1` means 65536). See the module docs for why this is read from
/// the file rather than through the connection.
fn sqlite_page_size(db_path: &Path) -> u64 {
    let head = {
        let mut file = std::fs::File::open(db_path).expect("the db file opens");
        let mut buf = [0u8; 20];
        std::io::Read::read_exact(&mut file, &mut buf).expect("the header is readable");
        buf
    };
    assert_eq!(
        &head[0..16],
        b"SQLite format 3\0",
        "the premise: this really is a SQLite database file"
    );
    let raw = u16::from_be_bytes([head[16], head[17]]) as u64;
    if raw == 1 {
        65536
    } else {
        raw
    }
}

/// The WAL file as a COMMIT COUNTER (Task 2's instrument, re-derived here): a
/// 32-byte header, then one frame per dirty page, each frame a 24-byte header
/// plus one page. N separate commits append AT LEAST N frames (one commit frame
/// each); one transaction appending the same rows writes one frame per dirty
/// page plus a single commit frame — so a delta below N is proof it was not N
/// commits.
fn wal_frame_count(wal: &Path, page_size: u64) -> u64 {
    match std::fs::metadata(wal) {
        Ok(meta) if meta.len() > 32 => (meta.len() - 32) / (24 + page_size),
        _ => 0,
    }
}

// ── (a) One write per key, carrying the LAST payload ─────────────────────────

/// (a) N `record_message` calls for ONE key land as ONE row holding the LAST
/// payload — the coalescing the whole task rests on.
///
/// Legal because the crate writes the FULL accumulator as the payload
/// (`normalize.rs`: `entry.push_str(text); payload = {text: entry}`), so a later
/// `Display` row for the same key is a complete snapshot and the intermediates
/// are worth nothing. Last-wins is the upsert's own rule
/// (`ON CONFLICT(session_id, kind, message_key) DO UPDATE SET payload_json =
/// excluded.payload_json`) — the decorator inherits it, it does not invent it.
#[tokio::test]
async fn n_buffered_rows_for_one_key_collapse_to_one_row_with_the_last_payload() {
    let (_dir, db) = temp_db("batching-collapse-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    for i in 0..12 {
        p.record_message(
            "s1",
            "agent-text",
            Some("k1"),
            &format!("{{\"text\":\"{i}\"}}"),
        )
        .expect("a buffered write reports Ok optimistically");
    }
    assert_eq!(
        p.flush().expect("the flush succeeds"),
        1,
        "twelve calls coalesced to one row"
    );

    let rows = db.messages_for("s1").expect("the display rows load");
    assert_eq!(
        rows.len(),
        1,
        "one key, one row — the intermediates are dropped, not appended"
    );
    assert_eq!(
        rows[0].payload_json, "{\"text\":\"11\"}",
        "the LAST payload wins (the accumulator's final snapshot)"
    );
}

/// (a, THE REAL INSTRUMENT) A stream of N `Display` rows for one session costs
/// FEWER WAL frames than N commits would — i.e. the flush is not N commits.
///
/// THE MUTATION PROOF (non-vacuity): replace the display arm of
/// `BatchingPersistence::write_batch` with the per-row loop it replaces
/// (`for row in rows { Db::record_message(self, ..) }`) and THIS test goes red.
/// N autocommits append at least N frames — measured by Task 2 at 3×N, because
/// each autocommit re-writes the leaf page plus its own commit frame — while one
/// `record_messages_batch` appends one frame per dirty page plus ONE commit
/// frame. A test that counted decorator method calls would stay green against
/// that mutation; this one cannot, because it reads the disk.
///
/// The row round-trip is asserted in the same test, so a mutation that writes
/// NOTHING cannot pass by producing zero frames.
#[tokio::test]
async fn a_stream_of_display_frames_costs_one_commit_and_not_n() {
    let (dir, db) = temp_db("batching-commits-");
    let wal = dir.join("t.db-wal");
    let page_size = sqlite_page_size(&dir.join("t.db"));
    seed_session(&db, "s1");
    // The premise, pinned: WAL is on, or there is no `-wal` to count and the
    // test would pass on a missing file for the wrong reason.
    assert!(
        wal.exists(),
        "the premise: the database is in WAL, so commits land as frames in {:?}",
        wal.display()
    );

    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    const N: usize = 12;
    let before = wal_frame_count(&wal, page_size);
    for i in 0..N {
        p.record_message(
            "s1",
            "agent-text",
            Some(&format!("k{i}")),
            &format!("{{\"text\":\"frame {i}\"}}"),
        )
        .expect("a buffered write reports Ok");
    }
    let written = p.flush().expect("the flush commits");
    let after = wal_frame_count(&wal, page_size);

    assert_eq!(written, N, "the flush reports the rows it wrote");
    assert!(
        after > before,
        "the flush actually committed (frames {before} -> {after})"
    );
    // MEASURED, both directions: the batch appends 3 frames (its dirty pages +
    // ONE commit frame); the per-row autocommit mutation appends 36 for the same
    // 12 rows (3×N — each autocommit re-writes the leaf page plus its own commit
    // frame), and the test goes RED on that mutation. 36 >= 12 trips this bound.
    assert!(
        after - before < N as u64,
        "N={N} buffered rows must not cost N commits: N separate commits append at \
         least N frames (one commit frame each), and this flush appended {} \
         (before={before}, after={after})",
        after - before
    );
    let rows = db.messages_for("s1").expect("the display rows load");
    assert_eq!(
        rows.len(),
        N,
        "every row of the batch round-trips (so a write-nothing mutation cannot \
         pass by producing zero frames)"
    );
}

// ── (b) A flush before a read makes the row visible ──────────────────────────

/// (b) `flush()` is the synchronisation point: nothing on disk before it,
/// everything after. Every real flush point calls it, so this is also the unit
/// pin on "the exit path can reach the disk".
#[tokio::test]
async fn a_flush_before_a_read_makes_the_buffered_row_visible() {
    let (_dir, db) = temp_db("batching-flush-read-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    p.record_message("s1", "agent-text", Some("k1"), r#"{"text":"now"}"#)
        .expect("buffered");
    assert!(
        db.messages_for("s1").expect("the read works").is_empty(),
        "the row is BUFFERED — nothing reached the database yet"
    );

    assert_eq!(
        p.flush().expect("the flush succeeds"),
        1,
        "the flush reports the one row it wrote"
    );
    let rows = db.messages_for("s1").expect("the display rows load");
    assert_eq!(rows.len(), 1, "the flush made the row visible");
    assert_eq!(rows[0].payload_json, r#"{"text":"now"}"#);
}

// ── (c) The pass-through writes force the pending batch out first ────────────

/// (c) `Replace` is the atomic compaction rewrite and passes through UNBATCHED,
/// so it must be PRECEDED by the pending batch: a compaction that rewrote the
/// transcript while display rows for the same session sat in the buffer would
/// land first and the buffer would then overwrite rows the rewrite had just
/// retired. The decorator flushes first — and this test reads the database with
/// NO explicit `flush()`, so it fails if that ordering flush is removed.
#[tokio::test]
async fn a_replace_forces_the_pending_batch_out_before_it_writes() {
    let (_dir, db) = temp_db("batching-replace-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    p.record_message(
        "s1",
        "agent-text",
        Some("k1"),
        r#"{"text":"before compaction"}"#,
    )
    .expect("buffered");
    p.replace_native_messages(
        "s1",
        &[(0, "user".to_string(), r#"{"role":"user"}"#.to_string())],
    )
    .expect("the rewrite succeeds");

    let rows = db
        .messages_for("s1")
        .expect("the display rows load with NO explicit flush");
    assert_eq!(
        rows.len(),
        1,
        "the pending display batch was flushed BY the `Replace`, in order"
    );
    assert_eq!(rows[0].payload_json, r#"{"text":"before compaction"}"#);
    assert_eq!(
        db.load_native_messages("s1").expect("the transcript loads"),
        vec![r#"{"role":"user"}"#.to_string()],
        "and the rewrite itself landed"
    );
}

/// (c, the sibling) `Insert` is the other pass-through frame — the provider
/// transcript keyed `(session_id, seq)`. Same ordering argument, same pin.
#[tokio::test]
async fn a_pass_through_insert_forces_the_pending_batch_out_first() {
    let (_dir, db) = temp_db("batching-insert-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    p.record_message("s1", "agent-text", Some("k1"), r#"{"text":"display"}"#)
        .expect("buffered");
    p.insert_native_message("s1", 3, "assistant", r#"{"role":"assistant"}"#)
        .expect("the insert succeeds");

    assert_eq!(
        db.messages_for("s1").expect("the display rows load").len(),
        1,
        "the pending display batch was flushed BY the pass-through `Insert`"
    );
}

// ── (d) Reads pass through unbuffered ────────────────────────────────────────

/// (d) A read reaches the `Db` immediately — and a read is deliberately NOT a
/// flush point. Both halves are pinned, because the second is what makes the
/// first cheap: `TranscriptPersister::ensure_session_row` calls `session()` on
/// EVERY store frame, so a read that flushed would commit per frame and undo the
/// entire task.
#[tokio::test]
async fn reads_pass_straight_through_and_are_not_a_flush_point() {
    let (_dir, db) = temp_db("batching-reads-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    // A write through the RAW `Db` is visible through the decorator at once (the
    // decorator keeps no read-side cache of its own).
    db.record_message("s1", "agent-text", Some("direct"), r#"{"text":"direct"}"#)
        .expect("the direct write");
    assert_eq!(
        p.messages_for("s1").expect("the read passes through").len(),
        1,
        "a write that never touched the decorator is still read"
    );

    // A write through the decorator stays invisible until a flush — and reading
    // does not flush.
    p.record_message(
        "s1",
        "agent-text",
        Some("buffered"),
        r#"{"text":"buffered"}"#,
    )
    .expect("buffered");
    assert_eq!(
        p.messages_for("s1").expect("the read passes through").len(),
        1,
        "a READ IS NOT A FLUSH POINT: `ensure_session_row` reads once per frame, \
         so a read that flushed would commit once per frame"
    );

    // Every other read is the same pass-through.
    assert!(
        p.session("s1").expect("session passes through").is_some(),
        "the row read passes through"
    );
    assert_eq!(
        p.session_cost("s1").expect("session_cost passes through"),
        None,
        "the cost read passes through"
    );
    assert_eq!(
        p.session_todos("s1").expect("session_todos passes through"),
        None,
        "the todos read passes through"
    );
    assert!(
        p.load_native_messages("s1")
            .expect("load_native_messages passes through")
            .is_empty(),
        "the transcript read passes through"
    );
    assert_eq!(
        p.list_sessions(false)
            .expect("list_sessions passes through")
            .len(),
        1,
        "the list read passes through"
    );
    assert!(p.now_ms() > 0, "the clock passes through");
}

/// (d, the `sessions` columns) The three snapshot writes coalesce the same way:
/// last write wins per column, one statement each, nothing on disk until a flush.
///
/// `flush()` counts what it WROTE, not what it was called with — three
/// statements here against seven calls. That is the coalescing, stated as the
/// number the caller can check.
#[tokio::test]
async fn the_sessions_column_writes_coalesce_to_their_last_value() {
    let (_dir, db) = temp_db("batching-sessions-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    for cost in [0.25, 0.5, 0.75] {
        p.record_session_cost("s1", cost).expect("buffered");
    }
    for used in [100u64, 200] {
        p.record_session_context_usage("s1", used, 4096)
            .expect("buffered");
    }
    p.record_session_todos("s1", Some(r#"[{"content":"a","status":"pending"}]"#))
        .expect("buffered");
    p.record_session_todos("s1", None).expect("buffered");

    assert_eq!(
        db.session_cost("s1").expect("the cost read"),
        None,
        "nothing is on disk before the flush"
    );

    let written = p.flush().expect("the flush succeeds");
    assert_eq!(
        written, 3,
        "three columns dirty out of seven calls — the flush reports the 3 writes \
         it issued, not the 7 calls that buffered them"
    );

    assert_eq!(
        db.session_cost("s1").expect("the cost read"),
        Some(0.75),
        "the LAST cost wins (a snapshot overwrite, never a sum — ADR 0082: a \
         summed store is the failure this column's whole design exists to avoid)"
    );
    assert_eq!(
        db.session_todos("s1").expect("the todos read"),
        None,
        "the `todos_clear` (None) was the LAST write for that key, and `None` \
         must survive as `None` rather than collapsing to an empty list"
    );
    let row = db
        .session("s1")
        .expect("the session read")
        .expect("the row exists");
    assert_eq!(
        row.context_usage_json.expect("the usage is stored"),
        serde_json::json!({"used": 200, "window": 4096}).to_string(),
        "the LAST usage wins"
    );
}

// ── (e) `Drop` — the LOCAL case only ─────────────────────────────────────────

/// (e) `Drop` flushes — **AND THIS PROVES THE LOCAL CASE ONLY, NOT EXIT.**
///
/// A test's `Arc` dies at the end of the test, so this assertion is easy to
/// satisfy and easy to misread as the durability guarantee. It is not one. The
/// decorator is coerced to `Arc<dyn FulcrumPersistence>` and stored inside
/// `TranscriptPersister`, itself held by `SessionManager` — so the LAST `Arc` has
/// to die for `Drop` to run, and on a real quit it does not: `tauri::App::run`
/// never returns and exits through `std::process::exit`, which runs NO
/// destructors. A `Drop`-only backstop would leave the newest buffered rows —
/// exactly the ones a mid-stream quit loses — in a buffer nobody drains. The
/// guarantee lives in `RunEvent::Exit` instead (`lib.rs`), and THAT is pinned by
/// `tests/ipc.rs::the_exit_run_event_flushes_the_buffered_rows`, which drives
/// tauri's own mock event loop to the `Exit` event.
///
/// What this test legitimately pins is that `Drop` works as a BACKSTOP for every
/// other last-owner case (a test's `Arc`, a replaced `SessionManager`) — and that
/// it is best-effort: it cannot report an error to anyone, so a failing flush
/// there logs and moves on.
#[test]
fn drop_flushes_the_buffered_rows_local_owner_case_only_never_a_process_exit() {
    let (_dir, db) = temp_db("batching-drop-");
    seed_session(&db, "s1");
    // A runtime of its own, so the timer CAN be armed and the write really is
    // buffered rather than written through (`with_no_runtime…` covers the other
    // half).
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    rt.block_on(async {
        let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));
        p.record_message("s1", "agent-text", Some("k1"), r#"{"text":"on drop"}"#)
            .expect("buffered");
        assert!(
            db.messages_for("s1").expect("the read").is_empty(),
            "the premise: still buffered"
        );
        drop(p);
        let rows = db.messages_for("s1").expect("the read");
        assert_eq!(
            rows.len(),
            1,
            "the last `Arc` dying flushed the batch — the LOCAL case; see the doc \
             for why this is not the exit guarantee"
        );
        assert_eq!(rows[0].payload_json, r#"{"text":"on drop"}"#);
    });
}

/// (e, the shape production installs) The decorator is used as
/// `Arc<dyn FulcrumPersistence>` — the coercion `TranscriptPersister::new`
/// performs. Pinned because the whole flush-point design depends on the concrete
/// type staying reachable BESIDE the trait object (the trait has no `flush`, so a
/// decorator reachable only as `dyn FulcrumPersistence` could never be flushed).
#[test]
fn the_decorator_coerces_to_the_persistence_trait_object() {
    let (_dir, db) = temp_db("batching-coerce-");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));
    let as_seam: Arc<dyn FulcrumPersistence> = p.clone();
    assert!(
        as_seam.now_ms() > 0,
        "the trait object works as the seam (this is what `TranscriptPersister` holds)"
    );
    assert!(
        p.flush().expect("the concrete type still flushes") == 0,
        "and the concrete handle reaches `flush` — the reason the flush points \
         hold the concrete `Arc`, not just the trait object"
    );
}

// ── (f) The exit path ────────────────────────────────────────────────────────

/// (f) `flush()` — what `RunEvent::Exit` calls — reaches EVERY session's pending
/// rows, not just the last one written. The exit arm cannot know which sessions
/// hold rows, so the whole-buffer flush is the operation it needs, and this is
/// the unit-testable half of the exit guarantee.
///
/// THE HALF THIS TEST CANNOT PIN, SAID PLAINLY: that `lib.rs`'s `app.run`
/// callback is what tauri hands `RunEvent::Exit` to, and that the process then
/// dies without running destructors. `App::run` never returns and ends in
/// `std::process::exit`, so no unit test can drive the real `run()`. That half is
/// pinned in `tests/ipc.rs::the_exit_run_event_flushes_the_buffered_rows`, which
/// builds a mock app over `setup_dirs_with_factory` (so it gets the PRODUCTION
/// decorator), runs it with the PRODUCTION `run_event_callback`, and closes the
/// window so tauri's mock event loop delivers `RunEvent::Exit` — then asserts the
/// buffered row is on disk after the loop returns.
#[tokio::test]
async fn flush_reaches_every_session_holding_rows_not_just_the_last() {
    let (_dir, db) = temp_db("batching-flush-all-");
    for sid in ["s1", "s2", "s3"] {
        seed_session(&db, sid);
    }
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));
    for sid in ["s1", "s2", "s3"] {
        p.record_message(sid, "agent-text", Some("k"), r#"{"text":"pending"}"#)
            .expect("buffered");
    }
    assert_eq!(
        p.flush().expect("the flush succeeds"),
        3,
        "one flush covers all three sessions"
    );
    for sid in ["s1", "s2", "s3"] {
        assert_eq!(
            db.messages_for(sid).expect("the read").len(),
            1,
            "{sid}'s row reached the disk"
        );
    }
}

/// (f, the per-session half) `flush_session` drains ONE session and leaves the
/// others buffered — the operation the router's per-session flush points use, so
/// a close does not commit every other live session's partial accumulator.
#[tokio::test]
async fn flush_session_drains_one_session_and_leaves_the_others_buffered() {
    let (_dir, db) = temp_db("batching-flush-one-");
    for sid in ["s1", "s2"] {
        seed_session(&db, sid);
    }
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));
    for sid in ["s1", "s2"] {
        p.record_message(sid, "agent-text", Some("k"), r#"{"text":"pending"}"#)
            .expect("buffered");
    }
    assert_eq!(
        p.flush_session("s1").expect("the flush succeeds"),
        1,
        "one session, one row"
    );
    assert_eq!(db.messages_for("s1").expect("the read").len(), 1);
    assert_eq!(
        db.messages_for("s2").expect("the read").len(),
        0,
        "the other session is STILL buffered (a per-session flush point must not \
         reach into its neighbour's partial accumulator)"
    );
}

// ── The interval, i.e. the bounded loss window ───────────────────────────────

/// The interval IS the bounded loss window, so the bound is asserted and not
/// assumed: a buffered row with no further activity reaches the disk within it,
/// with no explicit flush point involved.
///
/// `tokio::time::pause()` + `advance` is the instrument `attention.rs`'s
/// countdown tests use, so nothing sleeps. The pre-expiry assertion is what makes
/// the post-expiry one mean anything: without it, an implementation that flushed
/// on every write would pass.
#[tokio::test]
async fn the_interval_flushes_within_the_named_window() {
    let (_dir, db) = temp_db("batching-interval-");
    seed_session(&db, "s1");
    tokio::time::pause();
    let p = Arc::new(BatchingPersistence::with_interval(
        db.clone(),
        Duration::from_millis(200),
    ));

    p.record_message("s1", "agent-text", Some("k1"), r#"{"text":"timed"}"#)
        .expect("buffered");
    assert!(db.messages_for("s1").expect("the read").is_empty());
    // Let the timer task run far enough to REGISTER its sleep with the paused
    // clock (see `settle`'s first bullet) — without this the deadline is missed
    // and the test fails for a reason that has nothing to do with the bound.
    settle().await;

    tokio::time::advance(Duration::from_millis(199)).await;
    settle().await;
    assert!(
        db.messages_for("s1").expect("the read").is_empty(),
        "the window has not expired — flushing early would make the assertion \
         below vacuous"
    );

    tokio::time::advance(Duration::from_millis(2)).await;
    settle().await;
    assert_eq!(
        db.messages_for("s1").expect("the read").len(),
        1,
        "the interval alone must bound the window"
    );
}

/// A busy session must not starve a quiet one: the timer is armed by the FIRST
/// buffered row for a session and is NOT re-armed by later rows, so a row never
/// waits longer than one interval however fast its key is being written. (A
/// per-event re-arm — the shape that is right for `attention.rs`'s one-shot alert
/// — would be a debounce here, and a debounce has no bound: a streaming
/// transcript would never flush and the loss window would be the whole turn.)
#[tokio::test]
async fn a_stream_of_writes_does_not_push_the_flush_window_out() {
    let (_dir, db) = temp_db("batching-no-starve-");
    seed_session(&db, "s1");
    tokio::time::pause();
    let p = Arc::new(BatchingPersistence::with_interval(
        db.clone(),
        Duration::from_millis(200),
    ));

    // One write every 50 ms for 400 ms: past the interval twice over.
    for i in 0..8u64 {
        p.record_message(
            "s1",
            "agent-text",
            Some(&format!("k{i}")),
            &format!("{{\"text\":\"{i}\"}}"),
        )
        .expect("buffered");
        // Settle FIRST so this write's timer (armed by the first write, or by
        // this one if the previous flush released the slot) registers its sleep
        // before the clock moves — see `settle`.
        settle().await;
        tokio::time::advance(Duration::from_millis(50)).await;
        settle().await;
    }

    let rows = db.messages_for("s1").expect("the read");
    assert!(
        !rows.is_empty(),
        "a debounce that re-armed on every write would still be holding all 8 rows"
    );
}

/// The default interval is the number the doc comment names as the loss window,
/// and it is bounded and non-zero: zero would commit per flush anyway (defeating
/// the task) and a wide-open one would make the doc comment's number a lie.
#[test]
fn the_default_interval_is_named_and_bounded() {
    assert!(
        !DEFAULT_FLUSH_INTERVAL.is_zero(),
        "a zero interval means no batching"
    );
    assert!(
        DEFAULT_FLUSH_INTERVAL <= Duration::from_millis(1_000),
        "the loss window must stay under a second — it is the amount of transcript \
         a crash discards, and it is what the person at the window sees vanish"
    );
}

// ── No runtime: never buffer what nothing will flush ─────────────────────────

/// A plain `#[test]` thread has NO tokio runtime, so the timer cannot be armed
/// (`Handle::try_current` refuses — the same guard `attention.rs::arm` carries and
/// for the same reason: `tokio::spawn` with no reactor PANICS). With no timer
/// there is nothing to bound the window, so the write goes THROUGH rather than
/// sitting in a buffer nothing will drain. Correctness beats batching: a
/// buffered row no timer will ever commit is lost data with extra steps.
#[test]
fn with_no_runtime_to_hold_the_timer_the_write_goes_straight_through() {
    let (_dir, db) = temp_db("batching-no-runtime-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::new(db.clone()));
    p.record_message("s1", "agent-text", Some("k1"), r#"{"text":"through"}"#)
        .expect("the write succeeds");
    let rows = db
        .messages_for("s1")
        .expect("the read works with no runtime on this thread");
    assert_eq!(
        rows.len(),
        1,
        "no runtime → no timer → nothing may be left buffered"
    );
    // And the error path is IMMEDIATE here (there is no deferred flush to wait
    // for), which is the honest asymmetry the type's doc comment states.
    let err = p
        .record_message("ghost", "agent-text", Some("k"), "{}")
        .expect_err("no runtime → written now → the FK violation is reported now");
    assert!(err.to_string().to_lowercase().contains("constraint"));
}

// ── Errors move to the flush ─────────────────────────────────────────────────

/// The deliberate semantic change, pinned: a batched write reports `Ok(())`
/// optimistically and the error surfaces at the FLUSH. The FK makes this
/// observable without a mock — a `messages` row for a session with no `sessions`
/// row is a constraint violation, and it happens at the flush, not at the call.
#[tokio::test]
async fn a_batched_error_surfaces_at_the_flush_and_not_at_the_write() {
    let (_dir, db) = temp_db("batching-error-");
    // NO `seed_session`: the FK is the instrument.
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    p.record_message("ghost", "agent-text", Some("k1"), r#"{"text":"orphan"}"#)
        .expect("the write reports Ok — the error has not happened yet");

    let err = p
        .flush()
        .expect_err("the deferred FK violation surfaces HERE, at the flush");
    let text = err.to_string().to_lowercase();
    assert!(
        text.contains("constraint") || text.contains("foreign key"),
        "and it says what failed, got {err}"
    );
    assert!(
        db.messages_for("ghost").expect("the read").is_empty(),
        "and nothing was written"
    );
}

/// A failed flush must not wedge the decorator. A buffer cleared on failure
/// would silently drop the rows the failed transaction rolled back; a buffer
/// left poisoned would panic every later write. Neither: the failed batch is put
/// back so a later flush can succeed once the cause is gone, and unrelated
/// sessions keep working.
#[tokio::test]
async fn a_failed_flush_leaves_the_decorator_usable() {
    let (_dir, db) = temp_db("batching-recover-");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    p.record_message("ghost", "agent-text", Some("k1"), r#"{"text":"orphan"}"#)
        .expect("buffered");
    p.flush().expect_err("the FK violation");

    seed_session(&db, "s1");
    p.record_message("s1", "agent-text", Some("k1"), r#"{"text":"fine"}"#)
        .expect("buffered");
    p.flush().expect("the next flush works");
    assert_eq!(
        db.messages_for("s1").expect("the read").len(),
        1,
        "the healthy session still writes after a failed flush"
    );
}

/// A failed session must not strand the sessions it happened to be batched
/// WITH. `flush()` drains EVERY session and then writes them one at a time, and
/// `take()` hands back the drained batch in `HashMap` order — so one session's
/// failure used to `?` out of the loop and abandon every session still queued
/// behind it. Those rows were already removed from the buffer by `take()`, so
/// they were not "deferred", they were GONE: silently, and never re-queued.
///
/// The module docs license dropping the batch that SQLite REFUSED (re-queuing it
/// would retry the identical failure forever); they never licensed dropping the
/// innocent co-batched ones. The fix is a per-session error boundary — log it,
/// keep going — and this is what pins it.
///
/// WHY A LOOP AND NOT ONE ROUND: the order `take()` yields is a `HashMap`
/// iteration order, which no test controls. A single round is RED only when the
/// ghost happens to drain BEFORE the healthy sessions; drain it last and the
/// same buggy `?` passes the test for a reason that has nothing to do with the
/// behaviour under test. Each round therefore builds a FRESH decorator (a fresh
/// `RandomState`, so a fresh permutation) over fresh ids, and every round must
/// land all three healthy rows — with 3 healthy sessions per round, one round
/// hides the defect a quarter of the time, eight rounds one in 65 536.
#[tokio::test]
async fn a_failed_session_does_not_strand_the_sessions_it_was_batched_with() {
    const ROUNDS: usize = 8;
    let (_dir, db) = temp_db("batching-neighbour-");
    // The healthy sessions get their FK source; the ghost deliberately does not,
    // because the constraint violation is the instrument (the file's own idiom,
    // see [`a_batched_error_surfaces_at_the_flush_and_not_at_the_write`]).
    for round in 0..ROUNDS {
        for sid in ["s1", "s2", "s3"] {
            seed_session(&db, sid);
        }
        let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));
        let ghost = format!("ghost-{round}");

        // The ghost FIRST here, so the buffer's own insertion order is not what
        // is being varied — only `take()`'s iteration order is.
        p.record_message(&ghost, "agent-text", Some("k"), r#"{"text":"orphan"}"#)
            .expect("buffered");
        for sid in ["s1", "s2", "s3"] {
            p.record_message(
                sid,
                "agent-text",
                Some(&format!("k-{round}")),
                r#"{"text":"fine"}"#,
            )
            .expect("buffered");
        }

        // The deferred error must STILL be reported — the per-session boundary
        // makes neighbours land, it does not hide the failure (`flush()`'s
        // callers log it, and
        // [`a_batched_error_surfaces_at_the_flush_and_not_at_the_write`] pins
        // that an error still surfaces at all).
        p.flush()
            .expect_err("the ghost's FK violation still surfaces at the flush");

        for sid in ["s1", "s2", "s3"] {
            assert_eq!(
                db.messages_for(sid).expect("the read").len(),
                round + 1,
                "round {round}: {sid} was batched with a failing session and must \
                 still have landed — a stranded row is removed from the buffer by \
                 `take()` and never written again"
            );
        }
    }
}

// ── The pass-through half of the surface ─────────────────────────────────────

/// The writes that are NOT batched still reach the `Db` unchanged and
/// immediately — `record_session` above all, because
/// `TranscriptPersister::ensure_session_row` writes the row and the NEXT frame
/// reads it back to decide whether it exists. A decorator that buffered
/// `record_session` would create the row twice per session, and one that
/// swallowed it would break the `native_messages` FK.
#[tokio::test]
async fn the_unbatched_writes_reach_the_db_immediately() {
    let (_dir, db) = temp_db("batching-passthrough-");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    p.record_session(&SessionInfo {
        session_id: "s-new".to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::Value::Null,
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: true,
    })
    .expect("record_session passes through");
    assert!(
        db.session("s-new").expect("the read").is_some(),
        "`record_session` is immediate — `ensure_session_row` reads it on the \
         very next frame"
    );

    p.upsert_space("/tmp/space", true).expect("upsert_space");
    assert!(
        p.set_space_trusted("/tmp/space", false)
            .expect("set_space_trusted"),
        "a row matched"
    );
    assert!(
        !db.space_trusted(std::path::Path::new("/tmp/space"))
            .expect("the trust read"),
        "and the write landed"
    );
}

/// `record_session` must NOT be a flush point either — it runs once per frame on
/// the `ensure_session_row` path for a session whose rows are exactly what is
/// being batched, so flushing there would commit per frame.
#[tokio::test]
async fn record_session_does_not_flush_the_batch_it_is_sitting_on() {
    let (_dir, db) = temp_db("batching-ensure-row-");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));
    p.record_message("s1", "agent-text", Some("k1"), r#"{"text":"buffered"}"#)
        .expect("buffered");
    p.record_session(&SessionInfo {
        session_id: "other".to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::Value::Null,
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session");
    assert!(
        db.messages_for("s1").expect("the read").is_empty(),
        "`record_session` left the batch buffered"
    );
}

/// The first-seen order within a session survives coalescing: a retracted row
/// (`message_retracted` emits `text: ""` for keys already written) must not jump
/// the queue, because `messages_for` orders by `id` and the `id` is the insert
/// order. Last-wins on the PAYLOAD, first-wins on the POSITION.
#[tokio::test]
async fn coalescing_keeps_first_seen_order_and_last_wins_payload() {
    let (_dir, db) = temp_db("batching-order-");
    seed_session(&db, "s1");
    let p = Arc::new(BatchingPersistence::with_interval(db.clone(), LONG));

    p.record_message("s1", "agent-text", Some("a"), r#"{"text":"A1"}"#)
        .expect("buffered");
    p.record_message("s1", "agent-text", Some("b"), r#"{"text":"B1"}"#)
        .expect("buffered");
    // `a` again — a retraction-shaped re-write of an existing key.
    p.record_message("s1", "agent-text", Some("a"), r#"{"text":""}"#)
        .expect("buffered");
    p.flush().expect("the flush");

    let rows = db.messages_for("s1").expect("the display rows load");
    let keys: Vec<Option<String>> = rows.iter().map(|r| r.message_key.clone()).collect();
    assert_eq!(
        keys,
        vec![Some("a".to_string()), Some("b".to_string())],
        "`a` keeps its FIRST-SEEN position (a retraction must not move a row to \
         the end of the transcript)"
    );
    assert_eq!(
        rows[0].payload_json, r#"{"text":""}"#,
        "with the LAST payload"
    );
}
