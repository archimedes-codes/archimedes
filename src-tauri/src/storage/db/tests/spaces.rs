//! Tests for `db/spaces.rs`: the `spaces` trust and ordering verbs (the settings
//! trust flag, the per-Space manual order of ADR 0075).

use crate::storage::db::*;

use super::support::*;

/// (settings trust) a NEW space row is born `trusted` per the flag
/// (the INSERT writes `trusted` from the flag). Asserted via
/// `list_spaces()` (NOT `space_trusted` — a canonicalize failure
/// fail-closes to `false` on a nonexistent path, a misleading red).
/// Real temp dirs for the paths (a nonexistent path canonicalize-
/// fails → `space_key` falls back to the raw string; the canonical
/// key is asserted here).
#[test]
fn upsert_space_insert_sets_trusted_from_the_flag() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-trusted-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).unwrap();
    let a = dir.join("a");
    std::fs::create_dir_all(&a).unwrap();
    let b = dir.join("b");
    std::fs::create_dir_all(&b).unwrap();
    db.upsert_space(a.to_str().unwrap(), true).unwrap();
    db.upsert_space(b.to_str().unwrap(), false).unwrap();
    let rows = db.list_spaces().unwrap();
    let a_canon = std::fs::canonicalize(&a).unwrap().display().to_string();
    let b_canon = std::fs::canonicalize(&b).unwrap().display().to_string();
    let row_a = rows.iter().find(|r| r.path == a_canon).unwrap();
    let row_b = rows.iter().find(|r| r.path == b_canon).unwrap();
    assert!(
        row_a.trusted,
        "the INSERT writes `trusted` from the flag (true)"
    );
    assert!(
        !row_b.trusted,
        "the INSERT writes `trusted` from the flag (false)"
    );
}

/// (settings trust) a re-upsert on an EXISTING row never touches the
/// trust flag (the CONFLICT branch only refreshes `last_opened_at`
/// — no retroactive trust): `false` → trust ON → re-upsert `false`
/// → the row is STILL trusted.
#[test]
fn upsert_space_conflict_leaves_the_existing_trust_untouched() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-trusted-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).unwrap();
    let c = dir.join("c");
    std::fs::create_dir_all(&c).unwrap();
    let c_canon = std::fs::canonicalize(&c).unwrap().display().to_string();
    db.upsert_space(&c_canon, false).unwrap();
    db.set_space_trusted(&c_canon, true).unwrap();
    db.upsert_space(&c_canon, false).unwrap();
    let rows = db.list_spaces().unwrap();
    let row = rows.iter().find(|r| r.path == c_canon).unwrap();
    assert!(row.trusted, "the CONFLICT branch never touches `trusted`");
}

/// Spaces order by `sort_order` with `path ASC` breaking ties. The fixture
/// gives the FIRST-listed row the LOWEST `last_opened_at`, so the old
/// recency statement would have returned the reverse-ish order; and the
/// second half ties two rows so the tie-break itself is pinned (and pinned
/// as stable across reads, not re-derived from recency).
#[test]
fn list_spaces_orders_by_sort_order_then_path() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacelist-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    // Upserted z, m, a: `sort_order` 0,1,2 while `path ASC` is a,m,z — the
    // two orders disagree, so the tie-break half below is not vacuous.
    let dirs = [dir.join("zzz"), dir.join("mmm"), dir.join("aaa")];
    for d in &dirs {
        std::fs::create_dir_all(d).unwrap();
    }
    let keys: Vec<String> = dirs
        .iter()
        .map(|d| {
            db.upsert_space(d.to_str().unwrap(), false)
                .expect("upsert_space should succeed");
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    // Recency says the opposite: the first-listed row is the STALEST.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for (key, opened) in [(&keys[0], 1_000_i64), (&keys[1], 3_000), (&keys[2], 2_000)] {
            conn.execute(
                "UPDATE spaces SET last_opened_at = ?2 WHERE path = ?1",
                params![key, opened],
            )
            .expect("last_opened_at write should succeed");
        }
    }

    let paths: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        paths, keys,
        "rows come back in `sort_order` order although the first is the least recently opened"
    );

    // Tie two rows on one number: they must come back `path ASC` (`a`
    // before `m`), NOT in the order their `last_opened_at` values imply.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for key in [&keys[1], &keys[2]] {
            conn.execute(
                "UPDATE spaces SET sort_order = 7 WHERE path = ?1",
                params![key],
            )
            .expect("tie the two rows on one number");
        }
    }
    let paths: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        paths,
        vec![keys[0].clone(), keys[2].clone(), keys[1].clone()],
        "a tied `sort_order` breaks on `path ASC` and never on recency"
    );
}

/// A NEW space row joins the list at the BOTTOM (`MAX + 1`), not at the
/// top and not by name. Asserted through raw SQL because `list_spaces`
/// still sorts by recency until the `ORDER BY` swap.
///
/// The dir names are chosen so that INSERTION order is NOT `path ASC`
/// order — otherwise the `path ASC` tie-break would satisfy the assertion
/// on its own and the test would pass vacuously.
#[test]
fn upsert_space_new_row_joins_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacebottom-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = dir.join("zzz-first-inserted");
    let b = dir.join("mmm-second-inserted");
    let c = dir.join("aaa-third-inserted");
    for d in [&a, &b, &c] {
        std::fs::create_dir_all(d).unwrap();
    }
    db.upsert_space(a.to_str().unwrap(), false)
        .expect("upsert a");
    db.upsert_space(b.to_str().unwrap(), false)
        .expect("upsert b");
    db.upsert_space(c.to_str().unwrap(), false)
        .expect("upsert c");

    let keys: Vec<String> = [a, b, c]
        .iter()
        .map(|d| std::fs::canonicalize(d).unwrap().display().to_string())
        .collect();
    let order = raw_column(
        &db,
        "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC",
    );
    assert_eq!(
        order, keys,
        "rows come back in INSERTION order, i.e. each new row joined at the bottom"
    );
    assert_eq!(
        raw_i64s(&db, "SELECT sort_order FROM spaces ORDER BY sort_order ASC"),
        vec![0, 1, 2],
        "the numbers grow from the bottom, one per row"
    );
}

/// A RE-TOUCH never renumbers: the `ON CONFLICT … DO UPDATE` branch
/// refreshes `last_opened_at` and must not touch `sort_order`. This is the
/// feature (a click must not move the tab) and simultaneously the resume
/// hazard (a re-touch used to be what moved a row to the top).
///
/// The dir names make INSERTION order contradict `path ASC`, so the
/// assertion cannot be satisfied by the tie-break on rows that all still
/// carry `DEFAULT 0`.
#[test]
fn upsert_space_retouch_does_not_renumber() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spaceretouch-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = dir.join("zzz-first-and-retouched");
    let b = dir.join("aaa-second");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let key_a = std::fs::canonicalize(&a).unwrap().display().to_string();
    let key_b = std::fs::canonicalize(&b).unwrap().display().to_string();

    db.upsert_space(a.to_str().unwrap(), false)
        .expect("upsert a");
    db.upsert_space(b.to_str().unwrap(), false)
        .expect("upsert b");
    db.upsert_space(a.to_str().unwrap(), false)
        .expect("re-touch a");

    assert_eq!(
        sort_order_of(&db, "spaces", "path", &key_a),
        0,
        "a re-touched row keeps the number it joined at"
    );
    assert_eq!(
        raw_column(
            &db,
            "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC"
        ),
        vec![key_a, key_b],
        "the re-touched row did not move"
    );
}

/// (hazard H4) The phase-11 space-backfill INSERT carries the same
/// bottom-join expression. On this upgrade path — stored sessions, an
/// EMPTY `spaces` table — the seed numbers nothing, so an unpatched
/// `DEFAULT 0` would tie every backfilled row and hand the user an
/// alphabetical list on the very boot the spec promises is unchanged.
///
/// Asserted ORDER-AGNOSTICALLY on purpose: the backfill reads
/// `SELECT DISTINCT cwd FROM sessions`, which has no defined order, so the
/// test pins distinctness only and never encodes that nondeterminism.
#[test]
fn backfilled_space_rows_join_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacebackfill-test-", "scratch");
    let path = dir.join("t.db");
    let cwd_a = dir.join("cwd_a");
    let cwd_b = dir.join("cwd_b");
    // The cwds MUST exist for the backfill's canonicalization.
    std::fs::create_dir_all(&cwd_a).unwrap();
    std::fs::create_dir_all(&cwd_b).unwrap();
    create_pre_sort_order_db(&path);
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    for (id, cwd) in [("s_a", &cwd_a), ("s_b", &cwd_b)] {
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
             VALUES (?1, ?2, 1, '{}', 0)",
            params![id, cwd.display().to_string()],
        )
        .expect("fixture session row");
    }
    drop(conn);

    let db = Db::open(&path).expect("the backfill must number its rows");
    let total = raw_scalar(&db, "SELECT COUNT(*) FROM spaces");
    let distinct = raw_scalar(&db, "SELECT COUNT(DISTINCT sort_order) FROM spaces");
    let at_zero = raw_scalar(&db, "SELECT COUNT(*) FROM spaces WHERE sort_order = 0");
    assert_eq!(total, 2, "the backfill created one row per existing cwd");
    assert_eq!(
        distinct, 2,
        "the backfilled rows carry DISTINCT numbers — the seed numbered nothing here, \
         so an unpatched INSERT leaves every row on DEFAULT 0"
    );
    assert_eq!(
        at_zero, 1,
        "exactly one row sits at 0 — not every backfilled row tied there"
    );
}

/// `reorder_spaces` writes the given slice as `sort_order`, in one call:
/// the slice INDEX becomes the value, so the list comes back exactly as
/// handed and the numbers are the dense `0..n` the caller implied.
#[test]
fn reorder_spaces_writes_the_given_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reordersp-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let keys = ["aaa", "mmm", "zzz"].map(|n| {
        let d = dir.join(n);
        std::fs::create_dir_all(&d).unwrap();
        d
    });
    for d in &keys {
        db.upsert_space(d.to_str().unwrap(), false)
            .expect("upsert_space should succeed");
    }
    // The canonical keys — exactly the strings `list_spaces()` returns, which
    // is where the frontend's ids come from.
    let paths: Vec<String> = keys
        .iter()
        .map(|d| std::fs::canonicalize(d).unwrap().display().to_string())
        .collect();
    let (a, b, c) = (paths[0].clone(), paths[1].clone(), paths[2].clone());
    // The dragged order the plan names: `[c, a, b]`.
    let wanted = vec![c.clone(), a.clone(), b.clone()];

    db.reorder_spaces(&wanted)
        .expect("reorder_spaces should succeed");

    let listed: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        listed, wanted,
        "the list comes back in the order the caller passed"
    );
    assert_eq!(
        raw_i64s(&db, "SELECT sort_order FROM spaces ORDER BY sort_order ASC"),
        vec![0, 1, 2],
        "the slice index became the value, densely from 0"
    );
    assert_eq!(sort_order_of(&db, "spaces", "path", &c), 0);
    assert_eq!(sort_order_of(&db, "spaces", "path", &a), 1);
    assert_eq!(sort_order_of(&db, "spaces", "path", &b), 2);
}

/// A reorder is PERSISTED work, not a view: it survives a close + re-open,
/// i.e. the one-time seed gate stays closed and does not clobber the order.
#[test]
fn reorder_spaces_survives_a_reopen() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reopentest-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let keys: Vec<String> = ["aaa", "mmm", "zzz"]
        .iter()
        .map(|n| {
            let d = dir.join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    for k in &keys {
        db.upsert_space(k, false)
            .expect("upsert_space should succeed");
    }
    let wanted = vec![keys[2].clone(), keys[0].clone(), keys[1].clone()];
    db.reorder_spaces(&wanted)
        .expect("reorder_spaces should succeed");
    drop(db);

    let db = Db::open(&path).expect("re-open must succeed");
    let listed: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        listed, wanted,
        "the reorder survives the re-open — the seed gate did not fire and did not renumber"
    );
}

/// An id the caller never heard of is a NO-OP, not an error, and it still
/// occupies its slot: the slice index is the value, so the two known rows
/// land at 1 and 2. This pins the documented semantics rather than leaving
/// them undefined.
#[test]
fn reorder_spaces_with_an_unknown_path_is_not_an_error() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reordernope-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let keys: Vec<String> = ["aaa", "mmm"]
        .iter()
        .map(|n| {
            let d = dir.join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    for k in &keys {
        db.upsert_space(k, false)
            .expect("upsert_space should succeed");
    }

    let unknown = format!("/nope-{}", uuid::Uuid::new_v4());
    let slice = vec![unknown, keys[0].clone(), keys[1].clone()];
    assert!(
        db.reorder_spaces(&slice).is_ok(),
        "an id matching no row updates nothing and is not an error"
    );
    assert_eq!(
        sort_order_of(&db, "spaces", "path", &keys[0]),
        1,
        "the unknown id occupied slot 0, so the first known row is at 1"
    );
    assert_eq!(
        sort_order_of(&db, "spaces", "path", &keys[1]),
        2,
        "and the second known row at 2"
    );
}

/// (ADR 0090, the load-bearing one) closing a Space tab runs `delete_space`;
/// the board must SURVIVE it. There is deliberately NO foreign key on
/// `space_path`, so nothing cascades.
#[test]
fn delete_space_leaves_the_board_rows_in_place() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-orphan-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("tab-closing");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed the stages");
    let task = db
        .create_task(&space, "survive me", None, None)
        .expect("create");
    db.record_session(&title_session("sess-keep"))
        .expect("record the linked session — the FK on session_id is live");
    db.link_session(&task.id, "sess-keep", None).expect("link");

    db.delete_space(&space).expect("delete_space (a tab close)");
    assert!(db.find_space(&space).expect("find_space").is_none());

    let board = db
        .get_board(&space)
        .expect("the board survives the tab close");
    assert_eq!(board.len(), 5, "the five stage rows are still there");
    assert_eq!(
        board
            .iter()
            .flat_map(|c| c.tasks.iter())
            .map(|t| t.task.id.as_str())
            .collect::<Vec<_>>(),
        vec![task.id.as_str()],
        "the card is still there — ADR 0090: a board that cascaded away on a tab \
         close loses a whole workflow to a click that deletes nothing else"
    );
    assert_eq!(
        db.task_sessions(&task.id)
            .expect("task_sessions")
            .iter()
            .map(|r| r.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-keep"],
        "and so is the Session link"
    );
}
