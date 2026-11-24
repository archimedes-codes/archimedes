//! Tests for `db/retention.rs`: the transcript-retention verbs over `messages` /
//! `native_messages` / `sessions`.
//!
//! Every test here opens a real file (never `:memory:`), because what these verbs
//! claim is about the STORED database: which rows survive, which pages the file
//! gives back, and what a close/reopen still reports. The child fixtures are local
//! to this file on purpose — `tests/support.rs`' admission rule counts CONSUMERS,
//! and these have one.

use std::time::Duration;

use fulcrum_harness::clock::now_ms;

use crate::storage::db::*;

use crate::types::SessionInfo;

use super::support::*;

/// The two constants carry the values the approved design fixed, and nothing else
/// in this file may change them.
///
/// They are `const` and not settings keys, deliberately: `Settings` is crate-owned
/// behind a version pin, so a new `settings.json` key would need a crate release to
/// exist at all — and the design's answer is that neither number is a preference.
#[test]
fn the_retention_constants_carry_their_approved_values() {
    assert_eq!(
        MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE,
        Duration::from_secs(24 * 3600),
        "the age bound is 24 hours — one day, so a sweep is a day behind the transcript"
    );
    assert_eq!(
        VACUUM_FREELIST_THRESHOLD_BYTES,
        256 * 1024 * 1024,
        "the VACUUM threshold is 256 MiB of free pages"
    );
}

// ── the age-bound sweep ──────────────────────────────────────────────────────

/// A Subagent session shape on the fixture cwd — the literal
/// `tests/sessions.rs`'s `session_on` spells, with the flag fixed to `true`
/// because every target of a prune is a Subagent session. Local to this file:
/// `tests/support.rs`' admission rule counts CONSUMERS and this has one.
fn subagent_on(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: true,
    }
}

/// Backdate a session's `created_at` to `created_at`, through a SECOND raw
/// connection on the same file, dropped in its own block before the `Db` reads
/// (the `commands/history.rs` idiom).
///
/// It has to be raw SQL because `record_session` stamps `now_ms()` and there is
/// no `Db` verb that writes an OLD session — so without this helper every
/// fixture row is indistinguishable from a "recent" one and the age bound cannot
/// be tested at all. It has to be the PATH and not the `Db` for the same reason
/// every raw fixture here passes the path: the second connection opens the file,
/// not the connection.
fn age(path: &std::path::Path, id: &str, created_at: i64) {
    {
        let conn = rusqlite::Connection::open(path).expect("raw open of the fixture db");
        conn.execute(
            "UPDATE sessions SET created_at = ?1 WHERE id = ?2",
            rusqlite::params![created_at, id],
        )
        .expect("backdate the fixture session");
    }
}

/// One aged child, five display rows and two native rows: the sweep keeps
/// exactly ONE display row — the newest `id` — whatever its `kind`, and drops
/// every native row.
///
/// **This is the plan's red witness for the age bound, and the only test in the
/// suite that catches it.** Binding the un-subtracted age to the selector
/// instead of `now_ms() − max_age` asks SQLite for `created_at < 86_400_000`,
/// i.e. "before 1970-01-02", which matches NOTHING: the verb compiles, passes
/// clippy, returns all-zero counts forever, and reclaims none of the 2,042 MB
/// this run exists to reclaim. This test goes red at `(0, 0, 0)` against the
/// `(1, 4, 2)` it demands — while "young children untouched", "the sessions row
/// survives", "idempotent" and "empty target set" all PASS VACUOUSLY, because an
/// empty target set is exactly what a no-op produces. Weaken this one and the
/// headline verb ships as a silent no-op with a green suite.
///
/// Mutation proof for the other half: add `AND kind = 'agent-text'` to the
/// `messages` `DELETE` and this test goes red too — that filter keeps NOTHING
/// for the 6% of children whose transcript ends on a `tool-call` or an
/// `agent-thought` row.
#[test]
fn prune_keeps_only_the_newest_display_row_whatever_its_kind() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-age-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&subagent_on("c1")).expect("record c1");
    // The closer is a `tool-call`, NOT agent text — the shape 6% of real
    // children end on, and the reason the survivor rule is `MAX(id)` and never a
    // `kind` filter.
    db.record_messages_batch(&[
        ("c1", "tool-call", Some("t1"), "{}"),
        // Two NULL-keyed rows of the SAME kind: `UNIQUE(session_id, kind,
        // message_key)` does not collapse them (SQLite treats NULLs as distinct
        // in a UNIQUE index), which is why "newest id" is what makes the
        // survivor unique rather than "one row per kind".
        ("c1", "agent-thought", None, "{}"),
        ("c1", "agent-thought", None, "{}"),
        ("c1", "agent-text", Some("m1"), "{}"),
        ("c1", "tool-call", Some("t2"), "{}"),
    ])
    .expect("buffer five display rows");
    db.replace_native_messages(
        "c1",
        &[
            (1, "user".to_string(), "{}".to_string()),
            (2, "assistant".to_string(), "{}".to_string()),
        ],
    )
    .expect("two native rows");
    age(&path, "c1", now_ms() - 48 * 3600 * 1000);

    let got = db
        .prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("the age-bound prune");
    assert_eq!(
        got,
        PrunedCounts {
            sessions_pruned: 1,
            display_rows_deleted: 4,
            native_rows_deleted: 2,
        },
        "one session touched, four of its five display rows gone, both native rows gone"
    );
    let kept = db.messages_for("c1").expect("messages_for");
    assert_eq!(kept.len(), 1, "exactly one display row survives");
    assert_eq!(
        kept[0].kind, "tool-call",
        "the survivor is the NEWEST row (`MAX(id)`), and its `kind` is irrelevant"
    );
    assert!(
        db.load_native_messages("c1")
            .expect("load_native_messages")
            .is_empty(),
        "the provider transcript is gone entirely"
    );
    assert!(
        db.session("c1").expect("session").is_some(),
        "the `sessions` ROW survives — it carries `cost_usd`"
    );
}

/// A young child, a main session and their rows are untouched, with the boundary
/// rows placed CLEAR of the bound on both sides.
///
/// The exact boundary is deliberately NOT asserted: the verb reads `now_ms()`
/// itself (wall-clock milliseconds), so a row seeded at exactly `now − 24h`
/// survives only if that read has not advanced — and it will have, by
/// milliseconds. A test that pinned it would go red with no defect behind it.
/// The 5-second offsets are far outside any plausible skew and far inside the
/// 24-hour bound, so both arms are stable.
#[test]
fn prune_leaves_young_children_main_sessions_and_their_rows_alone() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-age-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let day = 24 * 3600 * 1000;
    db.record_session(&subagent_on("old")).expect("record old");
    db.record_session(&subagent_on("young"))
        .expect("record young");
    db.record_session(&title_session("main"))
        .expect("record main");
    for id in ["old", "young", "main"] {
        db.record_messages_batch(&[
            (id, "agent-text", Some("k0"), "{}"),
            (id, "agent-text", Some("k1"), "{}"),
        ])
        .expect("two display rows each");
        db.replace_native_messages(id, &[(1, "user".to_string(), "{}".to_string())])
            .expect("one native row each");
    }
    // Off the bound on BOTH sides, by 5 seconds.
    age(&path, "old", now_ms() - day - 5_000);
    age(&path, "young", now_ms() - day + 5_000);

    let got = db
        .prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("the age-bound prune");
    assert_eq!(
        got.sessions_pruned, 1,
        "only the row that is unambiguously past the bound is a target"
    );
    for id in ["young", "main"] {
        assert_eq!(
            db.messages_for(id).expect("messages_for").len(),
            2,
            "`{id}` is not a target — its transcript is intact"
        );
        assert_eq!(
            db.load_native_messages(id).expect("native").len(),
            1,
            "`{id}` keeps its native transcript too"
        );
    }
}

/// A second pass finds nothing: the same call reports all-zero counts and the
/// survivor is still there.
#[test]
fn prune_is_idempotent_and_counts_nothing_twice() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-age-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&subagent_on("c1")).expect("record c1");
    db.record_messages_batch(&[
        ("c1", "agent-text", Some("k0"), "{}"),
        ("c1", "agent-text", Some("k1"), "{}"),
    ])
    .expect("two display rows");
    age(&path, "c1", now_ms() - 48 * 3600 * 1000);

    let first = db
        .prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("first pass");
    assert_eq!(first.display_rows_deleted, 1, "one of two rows goes");
    let second = db
        .prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("second pass");
    assert_eq!(
        second,
        PrunedCounts {
            sessions_pruned: 0,
            display_rows_deleted: 0,
            native_rows_deleted: 0,
        },
        "the second pass deletes nothing at all — a trimmed child is not re-counted"
    );
    assert_eq!(
        db.messages_for("c1").expect("messages_for").len(),
        1,
        "the survivor of the first pass is still the survivor"
    );
}

/// Neither a `sessions` row nor another session's transcript is ever collateral.
#[test]
fn prune_never_deletes_the_sessions_row_or_another_sessions_transcript() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-age-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&subagent_on("c1")).expect("record c1");
    db.record_session(&subagent_on("c2")).expect("record c2");
    db.record_session(&title_session("main"))
        .expect("record main");
    for id in ["c1", "c2", "main"] {
        db.record_messages_batch(&[
            (id, "agent-text", Some("k0"), "{}"),
            (id, "agent-text", Some("k1"), "{}"),
        ])
        .expect("two display rows each");
        db.replace_native_messages(id, &[(1, "user".to_string(), "{}".to_string())])
            .expect("one native row each");
    }
    age(&path, "c1", now_ms() - 48 * 3600 * 1000);
    age(&path, "c2", now_ms() - 48 * 3600 * 1000);

    db.prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("the age-bound prune");
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM sessions"),
        3,
        "all three `sessions` rows remain — a prune deletes transcripts, never rows"
    );
    assert_eq!(
        db.messages_for("main").expect("messages_for").len(),
        2,
        "the main session's transcript is untouched (it is not `is_subagent = 1`)"
    );
    assert_eq!(
        db.load_native_messages("main").expect("native").len(),
        1,
        "nor is its native transcript"
    );
}

/// An empty target set returns zeros on a path that opens NO transaction.
///
/// This is the no-WAL-churn arm: an archive click on a childless parent must not
/// touch the write-ahead log at all. The counts are what is asserted, not a
/// commit counter — that instrument is `batching`'s and lives in its own tree.
#[test]
fn prune_opens_no_transaction_for_an_empty_target_set() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-age-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("main"))
        .expect("record main");
    db.record_messages_batch(&[("main", "agent-text", Some("k0"), "{}")])
        .expect("one display row");

    let got = db
        .prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("an empty target set is not an error");
    assert_eq!(
        got,
        PrunedCounts {
            sessions_pruned: 0,
            display_rows_deleted: 0,
            native_rows_deleted: 0,
        },
        "no Subagent session, no work, no transaction"
    );
    assert_eq!(
        db.messages_for("main").expect("messages_for").len(),
        1,
        "and the main session's row is still there"
    );
}

// ── the per-parent sweep (the trigger's scope) ───────────────────────────────

/// Point a child's `parent_session_id` at a parent, through a SECOND raw
/// connection on the same file (the [`age`] idiom).
///
/// Deliberately NOT through the write-once link verb in `db/parent_link.rs`: that
/// verb has exactly two files naming it in the crate — its own sibling and its own
/// mirror test — and that is a pinned boundary, because this task ships the verb
/// WITHOUT a caller. A test forcing what the database holds is the existing `raw_*`
/// idiom here, and it keeps these tests independent of the link verb: a bug in
/// `parent_link.rs` cannot make a prune test pass or fail.
fn link(path: &std::path::Path, child_id: &str, parent_id: &str) {
    {
        let conn = rusqlite::Connection::open(path).expect("raw open of the fixture db");
        conn.execute(
            "UPDATE sessions SET parent_session_id = ?1 WHERE id = ?2",
            rusqlite::params![parent_id, child_id],
        )
        .expect("link the fixture child");
    }
}

/// One parent with rows, two of its children (one aged, one YOUNG), another
/// parent's child, an orphan with no parent, and an unrelated main session.
#[test]
fn prune_of_parent_reaches_only_that_parents_children() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-parent-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    for id in ["p1", "main2"] {
        db.record_session(&title_session(id)).expect("record main");
    }
    for id in ["c1", "c2", "c3", "orphan"] {
        db.record_session(&subagent_on(id)).expect("record child");
    }
    for id in ["p1", "main2", "c1", "c2", "c3", "orphan"] {
        db.record_messages_batch(&[
            (id, "agent-text", Some("k0"), "{}"),
            (id, "agent-text", Some("k1"), "{}"),
        ])
        .expect("two display rows each");
        db.replace_native_messages(id, &[(1, "user".to_string(), "{}".to_string())])
            .expect("one native row each");
    }
    link(&path, "c1", "p1");
    link(&path, "c2", "p1");
    link(&path, "c3", "p2");
    // `orphan` keeps its NULL parent on purpose — that is the ~50%.
    age(&path, "c1", now_ms() - 48 * 3600 * 1000);
    // `c2` is YOUNG: recorded a moment ago, and still a target.

    let got = db
        .prune_closed_subagent_transcripts_of_parent("p1")
        .expect("the per-parent prune");
    assert_eq!(
        (got.sessions_pruned, got.display_rows_deleted),
        (2, 2),
        "both of p1's children lose exactly one row each, and nothing else does"
    );
    for id in ["c1", "c2"] {
        assert_eq!(
            db.messages_for(id).expect("messages_for").len(),
            1,
            "`{id}` keeps exactly its newest row"
        );
        assert!(
            db.load_native_messages(id).expect("native").is_empty(),
            "`{id}` loses its whole native transcript"
        );
    }
    for id in ["p1", "main2", "c3", "orphan"] {
        assert_eq!(
            db.messages_for(id).expect("messages_for").len(),
            2,
            "`{id}` is not p1's child — its transcript is intact"
        );
        assert_eq!(
            db.load_native_messages(id).expect("native").len(),
            1,
            "`{id}` keeps its native transcript too"
        );
    }
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM sessions"),
        6,
        "no `sessions` row is deleted by a prune"
    );
}

/// The NO-AGE-BOUND pin: `c2` above, aged to `now_ms()`, IS pruned.
///
/// That is a licensed property, not an oversight, and it was checked against the
/// design before it was pinned here: §"Approved design (2026-11-22)" part 3 scopes
/// the archive trigger "per closed child" and states NO age bound, and the
/// design's own safety paragraph says the same outright — the age bound "closes the
/// resurrection hole for the sweep", i.e. it is claimed for THE SWEEP ONLY, and the
/// triggers' safety rests on closedness instead.
///
/// Read that licence for what it actually grants, though: the design assumes
/// whatever fires the trigger can tell a closed child from a running one. A `Db`
/// verb cannot — the `sessions` table records no liveness — which is exactly why
/// the command that calls this verb owns an `is_live` guard and skips the whole
/// thing for a live Session. The design licenses the SCOPE; the caller owns the
/// PREDICATE.
#[test]
fn prune_of_parent_applies_no_age_bound_at_all() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-parent-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("p1")).expect("record p1");
    db.record_session(&subagent_on("c1")).expect("record c1");
    db.record_messages_batch(&[
        ("c1", "agent-text", Some("k0"), "{}"),
        ("c1", "agent-text", Some("k1"), "{}"),
    ])
    .expect("two display rows");
    link(&path, "c1", "p1");
    // `c1` was recorded a moment ago and its `created_at` is left EXACTLY as
    // `record_session` stamped it: `now_ms()`.
    let got = db
        .prune_closed_subagent_transcripts_of_parent("p1")
        .expect("the per-parent prune");
    assert_eq!(
        (got.sessions_pruned, got.display_rows_deleted),
        (1, 1),
        "a child aged to `now_ms()` is pruned — this scope has no age bound"
    );
}

/// A parent id with no children, and a totally unknown id, both answer zeros.
#[test]
fn prune_of_unknown_parent_is_a_noop() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-parent-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("childless"))
        .expect("record childless");
    db.record_session(&subagent_on("c1")).expect("record c1");
    db.record_messages_batch(&[("c1", "agent-text", Some("k0"), "{}")])
        .expect("one display row");

    for parent in ["childless", "never-existed"] {
        let got = db
            .prune_closed_subagent_transcripts_of_parent(parent)
            .expect("an unknown parent is not an error");
        assert_eq!(
            got,
            PrunedCounts {
                sessions_pruned: 0,
                display_rows_deleted: 0,
                native_rows_deleted: 0,
            },
            "`{parent}` owns no child row, so nothing is a target"
        );
    }
    assert_eq!(
        db.messages_for("c1").expect("messages_for").len(),
        1,
        "and the unlinked child's row is untouched"
    );
}

/// A `NULL` parent never satisfies `parent_session_id = ?1`, so the ~50% already
/// orphaned children are safe under a trigger that names a real parent.
#[test]
fn prune_of_parent_never_matches_a_null_parent() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-parent-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("p1")).expect("record p1");
    db.record_session(&subagent_on("orphan"))
        .expect("record orphan");
    db.record_messages_batch(&[
        ("orphan", "agent-text", Some("k0"), "{}"),
        ("orphan", "agent-text", Some("k1"), "{}"),
    ])
    .expect("two display rows");
    db.replace_native_messages("orphan", &[(1, "user".to_string(), "{}".to_string())])
        .expect("one native row");
    assert_eq!(
        raw_scalar(
            &db,
            "SELECT COUNT(*) FROM sessions WHERE id = 'orphan' AND parent_session_id IS NULL"
        ),
        1,
        "the premise: the orphan's parent is NULL, not the empty string"
    );

    let got = db
        .prune_closed_subagent_transcripts_of_parent("p1")
        .expect("the per-parent prune");
    assert_eq!(
        got,
        PrunedCounts {
            sessions_pruned: 0,
            display_rows_deleted: 0,
            native_rows_deleted: 0,
        },
        "NULL never equals a parent id"
    );
    assert_eq!(
        db.messages_for("orphan").expect("messages_for").len(),
        2,
        "the orphan keeps its whole transcript"
    );
}

// ── `vacuum_if_freelist_over` ────────────────────────────────────────────────

/// Seed `n` display rows for one session, distinct keys, in ONE batch.
///
/// The VACUUM tests below need a REAL freelist, and only volume creates one:
/// SQLite returns a page to the freelist only when it becomes entirely empty,
/// which a handful of rows in a fresh database never achieves — every row of a
/// three-row transcript shares a page. Measured on this machine's SQLite, with
/// this repo's 4,096-byte pages and the real `messages` schema: three rows and
/// then all-but-one deleted frees ZERO pages at every payload size tried — that
/// much reproduces everywhere. WHERE the first page starts being freed is NOT a
/// constant: it moves with the payload (it arrived near 150 rows at a 2-byte
/// payload and near 20 at a 200-byte one), so no floor is stated as a law here
/// and nothing downstream may depend on one. So these fixtures seed 1,000, well
/// past wherever that floor sits, and assert only `> 0` / `== 0` — the exact
/// page count above it is a function of how many pages the payload filled, so
/// it is payload-dependent (it measured 19 free pages at a 2-byte payload and 70
/// at 200 bytes for the same 1,000 rows) and NOTHING here pins a number.
fn seed_rows(db: &Db, session_id: &str, n: usize) {
    let rows: Vec<(&str, &str, Option<String>, &str)> = (0..n)
        .map(|i| (session_id, "agent-text", Some(format!("k{i}")), "{}"))
        .collect();
    let borrowed: Vec<(&str, &str, Option<&str>, &str)> = rows
        .iter()
        .map(|(s, k, key, p)| (*s, *k, key.as_deref(), *p))
        .collect();
    db.record_messages_batch(&borrowed)
        .expect("seed the display rows");
}

/// A threshold far above what the database is holding declines, and the free
/// pages stay where they were.
#[test]
fn vacuum_is_declined_below_the_threshold_and_the_freelist_survives() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-vacuum-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&subagent_on("c1")).expect("record c1");
    seed_rows(&db, "c1", 1_000);
    age(&path, "c1", now_ms() - 48 * 3600 * 1000);
    db.prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("the prune that frees the pages");
    let before = raw_scalar(&db, "PRAGMA freelist_count");
    assert!(before > 0, "the premise: the seed freed at least one page");

    assert!(
        !db.vacuum_if_freelist_over(1 << 40)
            .expect("declined, not errored"),
        "a 1 TiB threshold is above any freelist, so no VACUUM runs"
    );
    assert_eq!(
        raw_scalar(&db, "PRAGMA freelist_count"),
        before,
        "and the free pages are still there — a declined VACUUM rewrites nothing"
    );
}

/// Above the threshold the VACUUM runs, reports that it ran, and drains the
/// freelist to zero.
#[test]
fn vacuum_runs_above_the_threshold_and_drains_the_freelist() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-vacuum-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&subagent_on("c1")).expect("record c1");
    seed_rows(&db, "c1", 1_000);
    age(&path, "c1", now_ms() - 48 * 3600 * 1000);
    db.prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("the prune that frees the pages");

    // BOTH premises, as asserts and not as prose. The first is the one the
    // previous fixture of this shape got wrong; the second is what the verb
    // ACTUALLY compares, so it is the one whose silence mattered — a database
    // with a zero freelist answers `0 <= 0` and declines, and a test that asked
    // for `true` there would have been "repaired" by loosening the assert.
    assert!(
        raw_scalar(&db, "PRAGMA freelist_count") > 0,
        "the premise: the seed freed at least one page"
    );
    assert!(
        raw_scalar(&db, "PRAGMA freelist_count") * raw_scalar(&db, "PRAGMA page_size") > 0,
        "the premise the verb reads: freelist_count × page_size is above zero"
    );

    assert!(
        db.vacuum_if_freelist_over(0).expect("the verb under test"),
        "threshold 0 on a database holding free pages runs the VACUUM"
    );
    assert_eq!(
        raw_scalar(&db, "PRAGMA freelist_count"),
        0,
        "and the freelist is drained — the pages went back to the file"
    );
}

/// A database that has never freed a page declines a threshold of `0`.
///
/// This is the premise Step 5b's VACUUM-survival test has to respect: `0 <= 0`,
/// so the comparison declines and `false` is the honest answer. A test that
/// asked a clean database to run a VACUUM would fail here for a reason that has
/// nothing to do with what it is about, and the tempting "repair" — loosening
/// the assert to accept anything — would destroy the pin.
#[test]
fn vacuum_on_a_clean_database_reports_false() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-vacuum-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&subagent_on("c1")).expect("record c1");
    // A few rows and NO deletes: nothing has been freed, so nothing can be
    // reclaimed.
    seed_rows(&db, "c1", 3);
    assert_eq!(
        raw_scalar(&db, "PRAGMA freelist_count"),
        0,
        "the premise: three rows and no deletes free ZERO pages"
    );

    assert!(
        !db.vacuum_if_freelist_over(0)
            .expect("declined, not errored"),
        "threshold 0 on a zero freelist is `0 <= 0` and declines"
    );
}

// ── the one-time-upgrade marker (`PRAGMA user_version`) ──────────────────────

/// The marker round-trips through the file header and survives a close/reopen.
///
/// The reopen half is what makes it a latch rather than a cache: the value lives
/// in the database FILE, so a fresh `Db` over the same path reads the same number
/// and the caller's "already swept?" question survives a restart.
#[test]
fn the_retention_schema_version_round_trips_through_the_file_header() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-marker-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    assert_eq!(
        db.retention_schema_version()
            .expect("read a never-set marker"),
        0,
        "`user_version` is 0 on a database that has never been marked"
    );
    db.set_retention_schema_version(1)
        .expect("write the marker");
    assert_eq!(
        db.retention_schema_version().expect("read back"),
        1,
        "the write lands"
    );

    drop(db);
    let db = Db::open(&path).expect("reopen the same file");
    assert_eq!(
        db.retention_schema_version().expect("read after reopen"),
        1,
        "and it survived the close — the value lives in the file header"
    );
}

/// The marker survives a VACUUM, through this task's own verb AND through a
/// connection this task never touched.
///
/// WHY THIS TEST EXISTS AT ALL: `user_version` lives in the database file header,
/// and this same task ships `VACUUM` — a whole-file rewrite. If the marker did not
/// survive it, the agent layer's ONE-TIME upgrade sweep would re-run its 2 GB
/// delete on every VACUUM, forever, turning a one-time migration into a recurring
/// one. Measured on this machine's SQLite before writing this: set the version,
/// delete rows, VACUUM, read back — unchanged, freelist drained to 0.
#[test]
fn the_retention_schema_version_survives_a_vacuum() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-marker-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.set_retention_schema_version(1)
        .expect("write the marker");

    // Seed a REAL freelist before asking for a VACUUM: 1,000 rows and then the
    // age-bound prune. NOT "a child with a few rows" — three rows free ZERO
    // pages, and `vacuum_if_freelist_over(0)` on a zero freelist DECLINES
    // (`0 <= 0`), which would fail this test at step 3 for a reason that has
    // nothing to do with the marker.
    db.record_session(&subagent_on("c1")).expect("record c1");
    seed_rows(&db, "c1", 1_000);
    age(&path, "c1", now_ms() - 48 * 3600 * 1000);
    db.prune_closed_subagent_transcripts(Duration::from_secs(24 * 3600))
        .expect("the prune that frees the pages");
    // The premise is PART of the test: if a future change stops this seed from
    // freeing pages, it fails HERE and not at the VACUUM assert.
    assert!(
        raw_scalar(&db, "PRAGMA freelist_count") > 0,
        "the premise: the seed freed at least one page"
    );

    assert!(
        db.vacuum_if_freelist_over(0).expect("the verb under test"),
        "the VACUUM ran — pinned end-to-end through this task's own verb, not a \
         hand-written `execute_batch`"
    );
    assert_eq!(
        raw_scalar(&db, "PRAGMA freelist_count"),
        0,
        "and it actually rewrote the file"
    );
    assert_eq!(
        db.retention_schema_version().expect("read the marker"),
        1,
        "arm (a): the marker survived the VACUUM this task ships"
    );

    // Arm (b): a VACUUM this task did NOT trigger, on a second raw connection, so
    // the pin holds for any writer that rewrites the file — a backup tool, a
    // user's own `VACUUM`, anything.
    //
    // The raw connection sets a `busy_timeout` FIRST, because a raw
    // `Connection::open` runs none of `Db::open`'s pragmas and so inherits no
    // `busy_timeout` at all; belt-and-suspenders here, since this test's `Db` is
    // idle at this point, and a timeout cannot rescue a genuine writer-vs-writer
    // deadlock anyway. The alternative — issuing this VACUUM through `Db`'s own
    // connection — would make arm (b) identical to arm (a) and stop testing
    // anything.
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open of the fixture db");
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .expect("busy timeout set");
        conn.execute_batch("VACUUM").expect("the foreign VACUUM");
    }
    assert_eq!(
        db.retention_schema_version()
            .expect("read the marker again"),
        1,
        "arm (b): and it survived a VACUUM this file has no code for"
    );
}

/// The verbs carry an `i64` and interpret NOTHING.
///
/// The `<` latch, the marker's meaning, and the "a later marker is never re-swept
/// by an older build" rule all belong to the agent layer that owns the marker
/// constant. Pinning that this layer neither clamps nor validates is what keeps
/// that boundary honest: a `7` goes in and a `7` comes out.
#[test]
fn the_retention_schema_version_accepts_a_value_above_the_marker() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-retention-marker-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.set_retention_schema_version(7).expect("write 7");
    assert_eq!(
        db.retention_schema_version().expect("read 7"),
        7,
        "no clamp, no validation, no interpretation — this layer carries an i64"
    );
}

// ── the boundary pins ────────────────────────────────────────────────────────

/// Match one of the allowed path SUFFIXES on EITHER separator.
///
/// `path.display()` on Windows renders a MIXED-separator string — CI's failing
/// message read
/// `D:\a\archimedes\archimedes\src-tauri/src/storage\db\retention.rs`, forward
/// slashes because `CARGO_MANIFEST_DIR` arrives with them and native ones because
/// `read_dir` appends them — so a `/`-delimited `ends_with` CANNOT match there and
/// the walk fires on a file that is legitimately IN the allowed set. Normalising
/// first is this repo's own idiom for exactly this (`is_test_target`,
/// `src-tauri/tests/childproc_census.rs`).
fn suffix_allowed(shown: &str, allowed: &[&str]) -> bool {
    let norm = shown.replace('\\', "/");
    allowed.iter().any(|a| norm.ends_with(a))
}

/// The allow-list must match on both separators, or the walk below accuses a file
/// that is IN the set. Linux cannot reproduce the failure, so this pin reproduces
/// the SHAPE instead of relying on a Windows runner: the string below is verbatim
/// from the CI message that went red on `windows-latest` for the first run of this
/// file. The last assert is the mutation guard — it pins that the NAIVE predicate
/// (a bare `ends_with` on the un-normalised path) is what fails, so the fix cannot
/// silently regress to it and stay green.
#[test]
fn the_allowed_path_suffixes_match_a_windows_rendered_path() {
    let allowed = [
        "src/storage/db/retention.rs",
        "src/storage/db/tests/retention.rs",
    ];
    let windows = r"D:\a\archimedes\archimedes\src-tauri/src/storage\db\retention.rs";
    let windows_tests = r"D:\a\archimedes\archimedes\src-tauri/src\storage\db\tests\retention.rs";
    let unix = "/home/runner/archimedes/src-tauri/src/storage/db/retention.rs";

    assert!(
        suffix_allowed(windows, &allowed),
        "the production verbs' file must be allowed on a Windows-rendered path: {windows}"
    );
    assert!(
        suffix_allowed(windows_tests, &allowed),
        "this file must be allowed on a Windows-rendered path: {windows_tests}"
    );
    assert!(
        suffix_allowed(unix, &allowed),
        "the same suffix must still match a POSIX path: {unix}"
    );

    // Non-vacuity: normalising must not turn the allow-list into a rubber stamp.
    // An escaped file stays refused on both separators.
    assert!(
        !suffix_allowed(
            r"D:\a\archimedes\archimedes\src-tauri/src\storage\db\mod.rs",
            &allowed
        ),
        "a `db/mod.rs` that names the pragma must still be refused"
    );
    assert!(
        !suffix_allowed(
            "/home/runner/archimedes/src-tauri/src/storage/db/open.rs",
            &allowed
        ),
        "a POSIX sibling that names the pragma must still be refused"
    );

    // The predicate this helper replaces, pinned as the broken half.
    assert!(
        !windows.ends_with(allowed[0]),
        "if this ever passes, `path.display()` no longer renders backslashes and \
         the helper's normalisation is dead code — delete it rather than keep both"
    );
}

/// (a guard against a FUTURE edit, not a feature) none of the retention verbs is
/// called from `Db::open`, and neither the marker constant nor a stray
/// `user_version` lives anywhere in `storage/`.
///
/// This repo pins a boundary in source text because a prose promise in a comment is
/// what the next refactor walks through. Both halves are real hazards with names:
///
///   * `db/mod.rs` records that its gates are "the expensive writes … the reason an
///     upgrade-first open used to stall the window". A 2 GB delete or a whole-file
///     `VACUUM` added to that path reintroduces the stall on every boot, and it
///     would compile and pass every behavioural test while doing it.
///   * The marker CONSTANT belongs to the agent layer. If a value were minted here
///     too, two constants could disagree about what "already swept" means, and the
///     one-time sweep would run twice or never.
///
/// The `storage/` half is a recursive WALK rather than a hand-maintained per-file
/// list, because the claim is "nowhere in `storage/`" and a list goes stale the
/// moment a sibling is added. Two notes that make the walk correct rather than
/// merely strict:
///
///   1. The `user_version` ALLOWED set has TWO members, both produced by this task:
///      the production verbs' file, and THIS test file — which must name the pragma
///      in order to pin it, and whose own `survives_a_vacuum` doc line names it by
///      design. A set with only the production file reddens this test on its first
///      run (`"…/db/tests/retention.rs".ends_with("db/retention.rs")` is `false`,
///      the `tests/` segment sits between), and the failure would point an
///      implementer at deleting a correct doc line. A test that pins a pragma must
///      be able to name it.
///   2. BOTH needles are built by `concat!`, because the walk reads THIS file: a
///      plain literal for either would be found in the very source that is
///      asserting, and the marker arm would fire on its own pin. `concat!` compiles
///      to the identical `&'static str` while the source text holds no contiguous
///      copy. The marker needle applies to EVERY file including this one — skipping
///      `db/tests/` wholesale would exempt the whole test tree from the marker pin
///      (a marker minted inside a test is still a second marker) and would make the
///      claim "nowhere in `storage/`" false.
///
/// If this comes back RED, read WHICH file the message names: a file outside the
/// two allowed ones is a real violation, so fix the code. `db/tests/retention.rs`
/// means one of the two needles lost its `concat!` split — fix the pin's needle,
/// never the doc line.
#[test]
fn nothing_in_db_open_prunes_vacuums_or_touches_the_marker_and_no_constant_lives_in_storage() {
    let open_source = include_str!("../mod.rs");
    // None of the five verbs may be CALLED from `Db::open`. The loop names the
    // VERBS and not the word `retention`, because `db/mod.rs` legitimately contains
    // `mod retention;` and the `pub use retention::{…}` line.
    for forbidden in [
        "prune_closed_subagent_transcripts",
        "vacuum_if_freelist_over",
        "retention_schema_version",
        "set_retention_schema_version",
    ] {
        assert_eq!(
            open_source.matches(forbidden).count(),
            0,
            "`Db::open` must never call `{forbidden}` — a prune or a VACUUM on the \
             boot path is the upgrade-open stall this file's own gate comments exist \
             to prevent"
        );
    }

    // The MARKER CONSTANT is the agent layer's, and `user_version` belongs to
    // exactly one PRODUCTION file — plus this test file, which names both strings
    // in order to pin them.
    let storage = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/storage"));
    // Split so that THIS file's own source never contains either as a contiguous
    // literal — the walk below reads this very file.
    let marker_needle = concat!("RETENTION_SCHEMA", "_MARKER");
    let pragma_needle = concat!("user_", "version");
    // The ALLOWED set for the PRAGMA needle only, as path SUFFIXES. The marker
    // needle has no allowed set: it must appear nowhere.
    let allowed = [
        "src/storage/db/retention.rs", // the two marker verbs (production)
        "src/storage/db/tests/retention.rs", // this file: the marker test's doc line + this pin
    ];
    let mut stack = vec![storage.to_path_buf()];
    let mut walked = 0usize;
    while let Some(dir) = stack.pop() {
        for entry in
            std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        {
            let path = entry
                .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
                .path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            walked += 1;
            let content = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
            let shown = path.display().to_string();
            assert!(
                !content.contains(marker_needle),
                "the marker constant is the agent layer's, and it was found in {shown}"
            );
            if content.contains(pragma_needle) {
                assert!(
                    suffix_allowed(&shown, &allowed),
                    "`user_version` escaped its two files: {shown}"
                );
            }
        }
    }
    // Non-vacuity: the walk must have actually read the tree, or both asserts
    // above would be a green that proves nothing.
    assert!(
        walked > 20,
        "the walk read {walked} files under {} — it must cover the whole \
         `storage/` tree for the two asserts above to mean anything",
        storage.display()
    );
}
