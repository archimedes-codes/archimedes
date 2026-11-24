//! The `parent_link` subject: the router is the one writer of
//! `sessions.parent_session_id`, and the guard is the whole design.

use std::path::PathBuf;
use std::sync::Arc;

use crate::agent::harness::DisplayRow;
use crate::agent::worker::client::WorkerInboundEvent;
use crate::agent::worker::protocol::StoreFrame;
use crate::agent::SessionManager;
use crate::storage::Db;
use crate::test_support::ScratchDir;

/// What [`harness`] hands back. Named because a 4-tuple return trips
/// `clippy::type_complexity` and this crate runs clippy at 0 warnings (the same
/// reason `router.rs`'s `Harness` alias exists).
type Harness = (ScratchDir, SessionManager, Arc<Db>, PathBuf);

/// A `SessionManager` over a real `Db` with EXACTLY the rows `rows` names
/// pre-recorded (`(session_id, is_subagent)`) — the shape `router.rs`'s
/// `manager_seeded` builds, rebuilt here because that fn is private to
/// `router.rs`'s inline test block (`router.rs:1870`; the block opens at `:1114`). No sink is wired: the
/// `Store` arm emits nothing and `sink.get()` is `None`, which is the router's
/// real behaviour with no sink rather than a special case.
///
/// The scratch dir is FIRST so a caller that destructures it into a `_dir`
/// binding declared first drops it LAST — the `Db`'s SQLite file lives INSIDE the
/// dir (the ordering rule `router.rs`'s `Harness` doc records; Linux cannot show
/// the failure, Windows can).
fn harness(tag: &str, rows: &[(&str, bool)]) -> Harness {
    let dir = ScratchDir::in_env_temp(tag, "persist");
    let path = dir.join("t.db");
    let db = Arc::new(Db::open(&path).expect("db should open"));
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    for (sid, is_subagent) in rows {
        db.record_session(&crate::agent::SessionInfo {
            session_id: sid.to_string(),
            cwd: dir.to_path_buf(),
            capabilities: serde_json::Value::Null,
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: *is_subagent,
        })
        .expect("seed row");
    }
    (dir, manager, db, path)
}

/// What the column actually holds, read through an INDEPENDENT connection.
/// `SessionRow` is the crate's type and has no parent field, so no `Db` verb can
/// report it — which is the point: the tests assert what SQLite holds, not what
/// a desktop getter chooses to expose. The two sentinels are DISTINCT on
/// purpose: `"__NONE__"` is "a row exists and the column is NULL" and
/// `"__NO_ROW__"` is "no row at all". Collapsing them would let a test that
/// should prove *the write was skipped on an existing row* pass when the row was
/// never created.
fn parent_of(path: &std::path::Path, id: &str) -> String {
    let conn = rusqlite::Connection::open(path).expect("an independent connection");
    conn.query_row(
        "SELECT COALESCE(parent_session_id, '__NONE__') FROM sessions WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| "__NO_ROW__".to_string())
}

/// A child's `Store` frame — the shape the pump delivers: the OUTER delivery id
/// is the PARENT's, the frame's OWN `session_id` is the CHILD's.
fn display_frame(child_id: &str) -> WorkerInboundEvent {
    WorkerInboundEvent::Store(StoreFrame::Display {
        session_id: child_id.to_string(),
        rows: vec![DisplayRow {
            kind: "agent-text".to_string(),
            message_key: "m1".to_string(),
            payload_json: serde_json::json!({ "text": "hello" }),
            created_at: 1,
        }],
    })
}

/// A COLD child's first frame under the PARENT's delivery id creates the child's
/// row (inside the crate, `persist.rs:279` `ensure_session_row`) AND links it.
///
/// The combination is what needs the pin, and it is the router-level twin of
/// `router.rs`'s `a_childs_first_cost_frame_under_the_parents_delivery_id_creates_and_writes_the_childs_row`:
/// the crate proves the row-ensure by calling `apply` with the CHILD id, so the
/// delivery id is never involved there; the router's cost pins pre-record the
/// rows, so the row-ensure is never involved. Neither covers a row this frame
/// creates and a parent this frame is the only source of — and the retention
/// design's parts 3 and 4 can only ask "whose children are these" if THIS frame
/// answered it.
#[test]
fn a_childs_first_store_frame_under_the_parents_delivery_id_links_the_parent() {
    let (main_sid, sub_sid) = ("parent-link-1", "child-link-1");
    let (_dir, manager, db, path) = harness("parent-link-first", &[(main_sid, false)]);
    assert!(
        db.session(sub_sid).unwrap().is_none(),
        "precondition: the child has NO row"
    );

    manager.route_event(main_sid, true, display_frame(sub_sid));

    let row = db
        .session(sub_sid)
        .unwrap()
        .expect("the crate's ensure_session_row must have created the child's row");
    assert!(
        row.is_subagent,
        "and the row it created is the ephemeral CHILD row"
    );
    assert_eq!(
        parent_of(&path, sub_sid),
        main_sid,
        "the child's row carries the DELIVERY id as its parent — the one frame \
         that knows it is this one, and nothing else ever will"
    );
    assert_eq!(
        parent_of(&path, main_sid),
        "__NONE__",
        "the parent is a main session and has no parent of its own"
    );
}

/// THE GUARD. `pump.rs:98`'s `delivery_id` falls back to the CHILD's own id when
/// the `drives` lookup misses, and it misses only after the teardown REMOVED the
/// entry (`subagent_flow.rs:1907` reap, THEN `:1913-1914` `drives.remove`; the
/// entry is inserted once at `:965-980` and never re-inserted). So a frame CAN
/// arrive with `session_id == child_id`, and on that frame the delivery id names
/// nobody's parent. Skipping is safe: it leaves the honest "parent never known"
/// NULL, and it costs nothing that a later frame could have recovered, because
/// the drive is gone for good — later stragglers may still arrive behind this one
/// (the pump reads a broadcast ring, `pump.rs:51`), but the `drives` lookup misses
/// for every one of them, so none could resolve. Writing anyway would attribute a
/// child to itself, and a child that is its own parent is worse than a child with
/// no recorded parent — it is a link that reads as data.
#[test]
fn a_child_frame_delivered_under_its_own_id_links_no_parent_and_leaves_the_column_null() {
    let sub_sid = "child-link-race";
    let (_dir, manager, _db, path) = harness("parent-link-race", &[]);

    // The racy delivery: the OUTER id is the CHILD's own id.
    manager.route_event(sub_sid, true, display_frame(sub_sid));

    assert_eq!(
        parent_of(&path, sub_sid),
        "__NONE__",
        "the row exists (the frame created it) with the column NULL — the write \
         was SKIPPED, not merely ineffective. Asserting `__NONE__` and not \
         `__NO_ROW__` is what proves the guard ran on an existing row."
    );
}

/// Idempotence, pinned where it is cheap to lose: the router fires on EVERY
/// child frame, so the second, tenth and thousandth frame must leave the column
/// exactly as the first did — same value, one row, no duplicate.
#[test]
fn a_second_child_frame_leaves_the_link_alone() {
    let (main_sid, sub_sid) = ("parent-link-twice", "child-link-twice");
    let (_dir, manager, _db, path) = harness("parent-link-twice", &[(main_sid, false)]);

    let frame = || {
        WorkerInboundEvent::Store(StoreFrame::ContextUsage {
            session_id: sub_sid.to_string(),
            used: 10,
            window: 100,
        })
    };
    manager.route_event(main_sid, true, frame());
    manager.route_event(main_sid, true, frame());

    assert_eq!(parent_of(&path, sub_sid), main_sid, "still the same parent");
    let conn = rusqlite::Connection::open(&path).expect("an independent connection");
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id = ?1",
            rusqlite::params![sub_sid],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(
        rows, 1,
        "and the child still has ONE row — the write never inserts"
    );
}

/// A MAIN session never gains a parent, from either arm.
///
/// A FENCE, not a red witness — say so, because claiming a witness this test does
/// not have would be a false report. For a main frame the delivery id IS the
/// session's own id, so the Step 1 guard rejects it on its own and this stays
/// green with the `is_subagent` check deleted. What it fences is the day someone
/// links on a field other than the ids (a resume path, a `SubagentDispatch`
/// wire) and starts writing parents for mains: the `is_subagent` argument is the
/// semantic gate and the id comparison is only the safety net.
#[test]
fn a_main_session_never_gains_a_parent() {
    let main_sid = "main-link-none";
    let (_dir, manager, _db, path) = harness("parent-link-main", &[(main_sid, false)]);

    manager.route_event(
        main_sid,
        false,
        WorkerInboundEvent::Store(StoreFrame::ContextUsage {
            session_id: main_sid.to_string(),
            used: 1,
            window: 2,
        }),
    );

    assert_eq!(
        parent_of(&path, main_sid),
        "__NONE__",
        "a main session's row keeps `parent_session_id` NULL forever — the column \
         has exactly two levels, because `subagent` is stripped from a child's \
         tool specs, so a parent is always a main"
    );
}

/// An existing link is IMMUTABLE. The row already has a parent (seeded through an
/// independent connection, because `SessionInfo` cannot express one — the crate's
/// type has no such field), and a later frame under a DIFFERENT delivery id must
/// not move it. This is the `WHERE parent_session_id IS NULL` half of the design:
/// the guard handles `NULL`, this handles the case where something else already
/// answered the question.
#[test]
fn a_child_that_already_has_a_parent_keeps_it() {
    let other_parent = "parent-link-original";
    let sub_sid = "child-link-kept";
    let (_dir, manager, _db, path) = harness("parent-link-kept", &[]);

    {
        // The four NOT NULL columns of `sessions` plus `is_subagent` — the flag
        // that makes this the ephemeral CHILD row (`db/mod.rs:915-928`): every
        // other column has a DEFAULT or is NULLABLE, so this is the minimum
        // INSERT that produces a real child row.
        let conn = rusqlite::Connection::open(&path).expect("an independent connection");
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
             VALUES (?1, '/tmp', 1, '{}', 1)",
            rusqlite::params![sub_sid],
        )
        .expect("a pre-existing child row");
        conn.execute(
            "UPDATE sessions SET parent_session_id = ?2 WHERE id = ?1",
            rusqlite::params![sub_sid, other_parent],
        )
        .expect("a pre-existing parent");
    }

    manager.route_event(
        "parent-link-impostor",
        true,
        WorkerInboundEvent::Store(StoreFrame::ContextUsage {
            session_id: sub_sid.to_string(),
            used: 1,
            window: 2,
        }),
    );

    assert_eq!(
        parent_of(&path, sub_sid),
        other_parent,
        "the first answer wins — a later frame under another delivery id cannot \
         re-parent a child, and a NULL can never overwrite a known parent"
    );
}

/// The other arm that can create a child's row. `persist.rs`'s
/// `apply_interactive_event` calls `ensure_session_row` itself, and its own
/// comment records that *"its first priced call can arrive before any of its
/// `StoreFrame`s"* — so a `Store`-arm-only write leaves that child's row created
/// and unlinked. This is `router.rs`'s
/// `a_childs_first_cost_frame_under_the_parents_delivery_id_creates_and_writes_the_childs_row`
/// with the link added: the frame is the pump's real shape (delivered under the
/// PARENT's id, `sessionId` = the CHILD), and the money still has to land on the
/// child's row, so both halves are asserted here.
#[test]
fn a_childs_first_cost_frame_under_the_parents_delivery_id_links_the_parent() {
    let (main_sid, sub_sid) = ("parent-link-cost", "child-link-cost");
    let (_dir, manager, db, path) = harness("parent-link-cost", &[(main_sid, false)]);
    assert!(
        db.session(sub_sid).unwrap().is_none(),
        "precondition: no child row"
    );

    manager.route_event(
        main_sid,
        true,
        WorkerInboundEvent::SinkFrame {
            event: "interactive-event".to_string(),
            payload: serde_json::json!({
                "sessionId": sub_sid,
                "seq": 0,
                "event": "cost_update",
                "payload": { "costUsd": 0.00002411, "source": "main" },
            }),
        },
    );

    assert_eq!(
        db.session_cost(sub_sid).unwrap(),
        Some(0.00002411),
        "unchanged: the child's money still lands on the CHILD's row"
    );
    assert_eq!(
        parent_of(&path, sub_sid),
        main_sid,
        "and the row THIS frame created is linked — the `Store` arm never saw it"
    );
    assert_eq!(
        parent_of(&path, main_sid),
        "__NONE__",
        "the delivery id is the parent's own: nothing is written to its row"
    );
}
