//! The `history.rs` unit tree — the repo's `mod tests;` + `tests/` directory
//! shape (AGENTS.md: NOT a `tests.rs` sibling), split BY SUBJECT the way
//! `commands/tasks.rs` + `commands/tasks/tests/` and `commands/files/` ship it:
//!
//!   * here, the five tests that pre-date the retention triggers — the
//!     `history_page` / `load_history_core` page contract, the `session_recency`
//!     wire shape, the `reorder_session_rows` slice write, and the `history_call`
//!     error-mapping arms, moved VERBATIM out of this file's inline
//!     `#[cfg(test)] mod tests { … }` block (the test NAMES are unchanged; only
//!     `use super::*` became explicit imports, because `super` here is
//!     `commands::history::tests`, not `commands::history`);
//!   * [`triggers`] — the archive / delete retention triggers, which landed here
//!     when `history.rs` measured over the 700-line production SEED.
//!
//! Moving the whole block rather than only the new tests is forced by the
//! language, not chosen for tidiness: a file gets ONE `mod tests`, so declaring
//! `mod tests;` to reach the directory ends the inline block's right to exist.

use std::sync::Arc;

use crate::agent::errors::HistoryError;
use crate::commands::history::{
    history_call, history_page, load_history_core, reorder_session_rows, session_recency_rows,
    HistoryPage,
};
use crate::storage::{Db, DbError};
use crate::types::SessionInfo;

#[test]
fn history_page_todos_first_page_and_subsequent_pages() {
    // #96 task 07: OWNED. Declared FIRST on purpose — locals drop in reverse
    // declaration order, so the guard goes last, after `path` and after the
    // `Db` whose SQLite file lives inside this dir. Linux tolerates the wrong
    // order (POSIX unlinks an open file); Windows does not, and `Drop`
    // swallows the error, so the position is enforced by reading.
    let dir = crate::test_support::ScratchDir::in_env_temp("history-todos-test-", "db");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");

    let s1 = SessionInfo {
        session_id: "sess-todos".to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    let s_empty = SessionInfo {
        session_id: "sess-empty".to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&s1).unwrap();
    db.record_session(&s_empty).unwrap();

    let todos_str = r#"[{"content":"task1","status":"pending"}]"#;
    db.record_session_todos("sess-todos", Some(todos_str))
        .unwrap();

    for i in 0..5 {
        db.record_message("sess-todos", "agent-text", Some(&format!("k{i}")), "{}")
            .unwrap();
    }

    // First page (before_id: None) on a session with todos returns todos: Some(...)
    let p1 = history_page(&db, "sess-todos", Some(2), None).expect("history_page should succeed");
    assert!(p1.todos.is_some(), "first page should have todos");
    assert_eq!(
        p1.todos.unwrap(),
        serde_json::json!([{"content":"task1","status":"pending"}])
    );

    // Subsequent page (before_id: Some(...)) on that same session returns todos: None
    let oldest_id = p1.rows[0].id;
    let p2 = history_page(&db, "sess-todos", Some(2), Some(oldest_id))
        .expect("history_page should succeed");
    assert_eq!(p2.todos, None, "subsequent page should have todos: None");

    // Session with no todos returns todos: None on the first page
    let p_empty =
        history_page(&db, "sess-empty", Some(2), None).expect("history_page should succeed");
    assert_eq!(
        p_empty.todos, None,
        "session with no todos returns todos: None"
    );
}

/// (ADR 0075) The WIRE KEYS of `SessionRecency` are pinned as literals:
/// `serde_json::to_value` on a row yields exactly `lastActiveAt`,
/// `sessionId` and `sortOrder`. The keys are the load-bearing half of this test — a
/// dropped `#[serde(rename_all = "camelCase")]` changes no field VALUE, so it
/// passes every value assertion on both sides of the wire and is invisible to
/// the hand-written TypeScript mirror; only a key literal sees it.
///
/// The list is ALPHABETICAL because `serde_json::to_value` emits a
/// `BTreeMap`-ordered object — that is why the names are sorted, not written
/// in declaration order.
///
/// The value half is asserted too, against the far-future stamp the fixture
/// writes by RAW SQL rather than `record_message`: both `Db::record_*` helpers
/// stamp `now_ms()`, so a `record_message` row could not be told apart from a
/// "recent" default (T01's trap, carried forward). And `sortOrder`'s value is
/// read after a `reorder_sessions`, so the row's number is NOT its record
/// position — a field wired to the wrong column index would answer the old
/// number (or the other row's) and be caught here.
#[test]
fn session_recency_rows_serializes_to_the_pinned_camel_case_keys() {
    // #96 task 07: OWNED, and declared FIRST on purpose — reverse drop order
    // puts the guard last, after `path`, after the raw `Connection` block
    // below, and after the `Db` whose SQLite file lives inside this dir.
    let dir = crate::test_support::ScratchDir::in_env_temp("history-recency-test-", "db");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");

    let titled = |id: &str| SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&titled("s_rec")).expect("record s_rec");
    db.record_session(&titled("s_plain"))
        .expect("record s_plain");
    // The message row goes in through a SECOND raw connection to the same
    // file — the `tests/storage.rs` idiom — because `Db::conn` is private
    // outside `storage::db`. It is still RAW SQL with an EXPLICIT
    // far-future `created_at`, never `record_message` (which stamps
    // `now_ms()` and would tie every row written in the same millisecond —
    // T01's trap), and the connection is closed before the `Db` reads, the
    // same ordering those tests use.
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open of the fixture db");
        conn.execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_rec', 'user', NULL, '{}', 9_999_999_999_999)",
            [],
        )
        .expect("fixture message row (explicit far-future created_at)");
    }

    // The order number must NOT be derivable from the record order, or a
    // field wired to the wrong column (or to the row's index in the `Vec`)
    // would pass the value half by accident. `s_rec` was recorded FIRST, so
    // this reorder moves it off its record position: 0 → 1.
    let moved: Vec<String> = ["s_plain", "s_rec"].iter().map(|s| s.to_string()).collect();
    db.reorder_sessions(&moved)
        .expect("reorder_sessions should succeed");

    let rows = session_recency_rows(&db).expect("session_recency_rows should succeed");
    let value = serde_json::to_value(&rows).expect("SessionRecency serializes");
    let items = value.as_array().expect("the payload is an array");
    assert_eq!(items.len(), 2, "one entry per non-subagent session");

    for item in items {
        let keys: Vec<String> = item
            .as_object()
            .expect("a serialized SessionRecency is an object")
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            keys,
            vec![
                "lastActiveAt".to_string(),
                "sessionId".to_string(),
                "sortOrder".to_string()
            ],
            "the wire keys are exactly `lastActiveAt`, `sessionId` and `sortOrder` \
             (the pinned camelCase form — a dropped `rename_all` changes no value)"
        );
    }

    // The value half: the fixture's explicit stamp, not a `now_ms()` number.
    let rec = items
        .iter()
        .find(|i| i["sessionId"] == serde_json::json!("s_rec"))
        .expect("s_rec is listed");
    assert_eq!(
        rec["lastActiveAt"],
        serde_json::json!(9_999_999_999_999_i64),
        "the number is the fixture's explicit stamp"
    );
    let plain = items
        .iter()
        .find(|i| i["sessionId"] == serde_json::json!("s_plain"))
        .expect("s_plain is listed");
    assert!(
        plain["lastActiveAt"].is_i64(),
        "a session with no messages still carries a NUMBER (the `COALESCE` \
         fallback), never null"
    );

    // The ORDER half, as a value: `s_rec` was recorded first (number 0) and
    // the reorder above moved it to 1, so a field wired to the wrong column
    // index — or left at a constant — answers the wrong integer here.
    assert_eq!(
        rec["sortOrder"],
        serde_json::json!(1_i64),
        "`s_rec` carries the number the reorder gave it, not its record position"
    );
    assert_eq!(
        plain["sortOrder"],
        serde_json::json!(0_i64),
        "`s_plain` carries the number the reorder gave it"
    );
}

/// (ADR 0075) `reorder_session_rows` writes the slice in the GIVEN order:
/// the ids arrive as `["s_c", "s_a", "s_b"]` and `list_sessions` reads that
/// back verbatim, so the command layer cannot sort, dedupe, or reorder a
/// drag. Also proves the `Vec<String> → &[String]` deref the `#[tauri::command]`
/// wrapper needs.
#[test]
fn reorder_session_rows_writes_the_slice_in_given_order() {
    // #96 task 07: OWNED, declared FIRST so the guard drops LAST — after the
    // `Db` whose SQLite file lives inside this dir (reverse declaration
    // order; the Linux/Windows asymmetry is documented on the first test).
    let dir = crate::test_support::ScratchDir::in_env_temp("history-reorder-test-", "db");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    let titled = |id: &str| SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    for id in ["s_a", "s_b", "s_c"] {
        db.record_session(&titled(id))
            .expect("record_session should succeed");
    }

    let ids = vec!["s_c".to_string(), "s_a".to_string(), "s_b".to_string()];
    reorder_session_rows(&db, &ids).expect("reorder_session_rows should succeed");

    let listed: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        listed,
        vec!["s_c".to_string(), "s_a".to_string(), "s_b".to_string()],
        "the given slice order IS the stored order"
    );
}

/// (#155 Task 4) The BEHAVIOUR PIN for `load_history_core`: the page it
/// answers is the page `history_page` answers for the same seeded database
/// — same rows, same order, same `has_more`, same `todos` — even though the
/// read now happens on a `spawn_blocking` worker thread instead of inline on
/// the async worker. Moving the call must change WHERE the query runs and
/// nothing else.
///
/// Asserted through `load_history_core` and NOT through `load_history`
/// because `tauri::State` has no public constructor, so the command wrapper
/// is unreachable from a unit test (`commands/settings.rs`,
/// `commands/agents.rs` and `commands/tasks.rs` each record that wall). The
/// core takes the `Arc<Db>` the wrapper hands it — the
/// `save_settings_and_push` / `write_artifact_core` shape — so this IS the
/// code the wire runs, minus the `State` unwrap.
///
/// `#[tokio::test]` per `commands/open.rs` / `commands/files`: the core is
/// `async`, and `spawn_blocking` needs a runtime to await its join on.
#[tokio::test]
async fn load_history_core_answers_the_page_history_page_does() {
    // ScratchDir declared FIRST so it drops LAST — the drop-order rule the
    // three tests above document (Linux tolerates the wrong order, Windows
    // does not).
    let dir = crate::test_support::ScratchDir::in_env_temp("history-core-page-test-", "db");
    let db = Arc::new(Db::open(&dir.join("t.db")).expect("db should open"));

    db.record_session(&SessionInfo {
        session_id: "sess-core".to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");
    db.record_session_todos(
        "sess-core",
        Some(r#"[{"content":"task1","status":"pending"}]"#),
    )
    .expect("record_session_todos should succeed");
    // Five rows, distinct `message_key`s (the UNIQUE constraint is
    // (session_id, kind, message_key), so five inserts really are five rows).
    for i in 0..5 {
        db.record_message("sess-core", "agent-text", Some(&format!("k{i}")), "{}")
            .expect("record_message should succeed");
    }

    // The OLD answer, straight from the sync fn the command used to call
    // inline. `HistoryPage` derives no `PartialEq`, so the comparison runs
    // on the wire form — `Serialize` is what the webview actually receives,
    // which makes it the stronger of the two available comparisons.
    let sync = history_page(&db, "sess-core", Some(2), None).expect("history_page should work");

    let core = load_history_core(db.clone(), "sess-core".to_string(), Some(2), None)
        .await
        .expect("load_history_core should succeed");

    assert_eq!(
        serde_json::to_value(&core).expect("HistoryPage serializes"),
        serde_json::to_value(&sync).expect("HistoryPage serializes"),
        "the page the async core answers is identical to the page the sync fn answers"
    );

    // The legible half, so a failure names the field rather than two blobs:
    // the newest TWO of five, ascending, with rows still behind the cursor,
    // and the FIRST page carrying the todos.
    assert_eq!(core.rows.len(), 2, "`limit: Some(2)` bounds the page");
    assert!(core.has_more, "three rows are still behind the cursor");
    assert!(
        core.rows[0].id < core.rows[1].id,
        "the page is in INSERTION order (ADR 0073), newest-last"
    );
    assert_eq!(
        core.rows
            .iter()
            .map(|r| r.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["agent-text", "agent-text"],
        "the seeded kinds come back untouched"
    );
    assert_eq!(
        core.todos,
        Some(serde_json::json!([{"content":"task1","status":"pending"}])),
        "the first page carries the stored todos"
    );

    // The cursor arm, through the same core: an older page keeps the rows
    // and drops the todos (the `before_id.is_none()` gate inside
    // `history_page` must survive the move).
    let oldest = core.rows[0].id;
    let sync2 =
        history_page(&db, "sess-core", Some(2), Some(oldest)).expect("history_page should work");
    let page2 = load_history_core(db.clone(), "sess-core".to_string(), Some(2), Some(oldest))
        .await
        .expect("the paged call should succeed");
    assert_eq!(
        serde_json::to_value(&page2).expect("HistoryPage serializes"),
        serde_json::to_value(&sync2).expect("HistoryPage serializes"),
        "the paged page is identical too"
    );
    assert_eq!(page2.todos, None, "a paged page never re-sends the todos");
    assert_eq!(page2.rows.len(), 2);

    // The `limit: None` arm (the frontend sends `null` — see
    // `src/lib/tauri/commands/sessions.ts`): every row up to the cursor,
    // `has_more` false because nothing was dropped.
    let unbounded = load_history_core(db.clone(), "sess-core".to_string(), None, None)
        .await
        .expect("the unbounded call should succeed");
    assert_eq!(unbounded.rows.len(), 5, "no limit → every row");
    assert!(
        !unbounded.has_more,
        "nothing was truncated, so nothing is behind"
    );
    assert!(unbounded.todos.is_some(), "still the first page");
}

/// (#155 Task 4) The JOIN arm of the crossing: a dead `spawn_blocking`
/// closure arrives as a `HistoryError`, never a panic — and a `DbError` that
/// the closure answered with keeps its OWN kind on the way out (the
/// discrimination ADR 0063 and Finding 20 exist to protect).
///
/// Asserted through `history_call`, the SAME helper `load_history_core`
/// runs, because the arm cannot be reached THROUGH the core: the closure is
/// pure against an `Arc<Db>` and owned arguments, so the only thing that can
/// kill it is a poisoned mutex — and `Db::conn` is private, which is exactly
/// why `commands/spaces.rs` calls the `JoinError` arm "stated, not implied".
/// `commands/tasks.rs` solved the identical wall by making its flattener
/// generic over the join-error type and feeding both arms from a test
/// (`board.rs`, `stages.rs`); this copies that, with `String` naming the join
/// slot for the same stated reason — `spawn_blocking` hands back a
/// `tauri::Error` this file's dialect does not name.
#[test]
fn history_call_maps_a_dead_closure_to_a_history_error_and_keeps_the_db_kinds() {
    // The join arm: `Err(_)` in the OUTER result. Before this task the arm
    // did not exist (there was no crossing); a panic inside the read used to
    // be impossible because the read ran inline, and now it is possible — so
    // what it must produce is a rejected command, not a lost IPC reply.
    let err = history_call::<HistoryPage, String>(Err("task 3 has panicked".to_string()))
        .expect_err("a dead blocking closure is an error, not a panic");
    assert_eq!(
        err.kind(),
        "io",
        "the family has no catch-all arm, so the join lands on `io` — the arm \
         `commands/files/mod.rs` maps its own JoinError to for the same reason"
    );
    let sentence = err.to_string();
    assert!(
        sentence.contains("task 3 has panicked"),
        "the sentence is the join's own, got `{sentence}`"
    );
    // The envelope the webview receives (ADR 0063), read through
    // `InvokeError`'s public `.0`.
    let envelope = tauri::ipc::InvokeError::from(err).0;
    assert_eq!(envelope["kind"], serde_json::json!("io"));
    assert_eq!(
        envelope["message"],
        serde_json::json!(sentence),
        "the envelope carries the same sentence `Display` gave"
    );

    // The `Ok(Err(_))` arm: a storage failure keeps its identity, so
    // "SQLite refused" and "the disk failed" stay two different answers.
    // The inner `Err` (the OUTER `Ok` stands in for the join succeeding —
    // the same two-layer shape `commands/tasks/tests/board.rs` feeds
    // `board_call`).
    assert_eq!(
        history_call::<HistoryPage, String>(Ok(Err(DbError::Io(std::io::Error::other(
            "disk on fire",
        )))))
        .expect_err("a DbError is still an error at the wire"),
        HistoryError::from(DbError::Io(std::io::Error::other("disk on fire"))),
        "`DbError::Io` maps to `HistoryError::Io`, not to the join's arm"
    );
    let json_err = serde_json::from_str::<serde_json::Value>("not json").unwrap_err();
    assert_eq!(
        history_call::<HistoryPage, String>(Ok(Err(DbError::Json(json_err))))
            .expect_err("a JSON payload failure is an error too")
            .kind(),
        "json",
        "`DbError::Json` keeps the `json` kind"
    );

    // A REAL `Sqlite` failure, produced the way this file's other test
    // produces real rows — a second raw connection to the same file, because
    // `Db::conn` is private. Dropping `messages` out from under the `Db`
    // makes `messages_page`'s own `prepare` refuse, so the arm is fed by
    // SQLite and not by a hand-built error.
    let dir = crate::test_support::ScratchDir::in_env_temp("history-core-join-test-", "db");
    let path = dir.join("t.db");
    let db = Arc::new(Db::open(&path).expect("db should open"));
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open of the fixture db");
        conn.execute("DROP TABLE messages", [])
            .expect("drop the table the read selects from");
    }
    let raw = history_page(&db, "sess-any", Some(2), None);
    assert!(
        matches!(raw, Err(DbError::Sqlite(_))),
        "the premise: dropping the table makes the storage call itself refuse"
    );
    let err = history_call::<HistoryPage, String>(Ok(raw))
        .expect_err("a refused statement must reach the wire as an error");
    assert_eq!(err.kind(), "sqlite", "the sqlite arm survives the crossing");

    // And the happy shape the helper also owns: `Ok(Ok(_))` passes straight
    // through, unmapped.
    assert!(
        history_call::<HistoryPage, String>(Ok(Ok(HistoryPage {
            rows: vec![],
            has_more: false,
            todos: None,
        })))
        .expect("a good page is a good page")
        .rows
        .is_empty(),
        "`Ok(Ok(_))` is returned untouched"
    );
}

mod triggers;
