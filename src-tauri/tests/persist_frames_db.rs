//! The `TranscriptPersister`'s SQLite half (T5/S5b relocation).
//!
//! These eight tests moved VERBATIM out of `crates/fulcrum-core/src/persist.rs`'s
//! `#[cfg(test)] mod tests` — the file that moved to the crate in S5b. They
//! RELOCATED rather than re-pointed because every one of them asserts a property
//! of the DATABASE, not of the seam:
//!
//!   * the `(session_id, seq)` collapse on `native_messages` and the
//!     `(session_id, kind, message_key)` UPSERT on `messages` are UNIQUE
//!     constraints — the crate's `MemoryStore` double reproduces the first as a
//!     `retain` and deliberately does NOT implement the second, because a double
//!     that mimics a constraint proves nothing about the constraint;
//!   * `ensure_session_row` exists to satisfy the FK from `native_messages` to
//!     `sessions` — a double has no FK, so the test's whole premise needs one;
//!   * `session` / `list_sessions` / `session_cost` / `session_todos` are
//!     `Db` reads, and the `sessions.context_usage_json` and `todos_json`
//!     columns are disk state.
//!
//! `TranscriptPersister` itself lives in the crate and now holds an
//! `Arc<dyn FulcrumPersistence>`; `Db` implements that trait (S4's seam), so the
//! persister under test here is the SAME code the crate ships, driven through the
//! SAME impl production wires. What this file adds over a crate-side test is
//! exactly the four things `MemoryStore` refuses to pretend to have — see the
//! section header in `crates/fulcrum-core/src/test_support.rs`.
//!
//! Precedent for the shape: `tests/permission_gate_db.rs` and
//! `tests/skill_catalog_drift.rs` (S2/S5a relocations — a `Db` fixture cannot
//! cross a package boundary, so the test goes where the `Db` is).

use std::path::PathBuf;
use std::sync::Arc;

use archimedes_lib::agent::harness::DisplayRow;
use archimedes_lib::agent::worker::protocol::StoreFrame;
use archimedes_lib::agent::SessionInfo;
use archimedes_lib::agent::TranscriptPersister;
use archimedes_lib::storage::Db;
use serde_json::{json, Value};

/// A temp-dir `Db` + a `sessions` row (the `native_messages` FK
/// source), OWNED (#96 task 08). Guard FIRST: destructured locals drop in
/// reverse, so the `Db` — whose SQLite file lives INSIDE `dir` — closes
/// before `dir` is removed. Windows needs that; Linux cannot show it
/// (POSIX unlinks under an open handle and `ScratchDir::Drop` swallows the
/// failure), so this is enforced by reading. Matches the two `temp_db`
/// siblings tasks 03/06 converted.
///
/// HONEST SIZING: all five callers already ran `remove_dir_all(&dir)` on the
/// green path, so this file's census delta is 0 BEFORE and 0 AFTER. The win
/// is the panic path — five dirs that survive a failed assertion today.
fn temp_db() -> (archimedes_lib::test_support::ScratchDir, Arc<Db>) {
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("persist-test-", "db");
    let db = Arc::new(Db::open(&dir.join("t.db")).unwrap());
    (dir, db)
}

/// `apply` (Insert) → a `native_messages` row (idempotent — a
/// replayed frame collapses to one row).
#[test]
fn apply_insert_is_idempotent() {
    let (_dir, db) = temp_db();
    let p = TranscriptPersister::new(db.clone());
    p.set_cwd("s1", "/tmp/space");
    let frame = StoreFrame::Insert {
        session_id: "s1".to_string(),
        seq: 0,
        role: "system".to_string(),
        content_json: r#"{"role":"system"}"#.to_string(),
    };
    p.apply(false, &frame);
    p.apply(false, &frame); // replay — must not duplicate.
    let rows = db.load_native_messages("s1").unwrap();
    assert_eq!(rows.len(), 1, "a replayed insert collapses to one row");
}

/// `apply` (Display) → a `messages` row (idempotent upsert).
#[test]
fn apply_display_is_idempotent() {
    let (_dir, db) = temp_db();
    let p = TranscriptPersister::new(db.clone());
    p.set_cwd("s1", "/tmp/space");
    let frame = StoreFrame::Display {
        session_id: "s1".to_string(),
        rows: vec![DisplayRow {
            kind: "agent-text".to_string(),
            message_key: "m1".to_string(),
            payload_json: serde_json::json!({ "text": "hi" }),
            created_at: 1,
        }],
    };
    p.apply(false, &frame);
    p.apply(false, &frame); // replay.
    let rows = db.messages_for("s1").unwrap();
    assert_eq!(
        rows.len(),
        1,
        "a replayed display upsert collapses to one row"
    );
}

/// `apply` (ContextUsage) → the `sessions.context_usage_json` write.
#[test]
fn apply_context_usage_writes_the_session_row() {
    let (_dir, db) = temp_db();
    let p = TranscriptPersister::new(db.clone());
    p.set_cwd("s1", "/tmp/space");
    let frame = StoreFrame::ContextUsage {
        session_id: "s1".to_string(),
        used: 53_760,
        window: 128_000,
    };
    p.apply(false, &frame);
    let row = db.session("s1").unwrap().unwrap();
    let usage: serde_json::Value = serde_json::from_str(&row.context_usage_json.unwrap()).unwrap();
    assert_eq!(usage["used"], 53_760);
    assert_eq!(usage["window"], 128_000);
}

/// `ensure_session_row` (subagent) → a HIDDEN `sessions` row
/// (`is_subagent = 1` — absent from `list_sessions`) + the
/// `native_messages` FK holds (the insert succeeds).
#[test]
fn ensure_session_row_creates_a_hidden_subagent_row() {
    let (_dir, db) = temp_db();
    let p = TranscriptPersister::new(db.clone());
    p.set_cwd("sub-1", "/tmp/space");
    let frame = StoreFrame::Insert {
        session_id: "sub-1".to_string(),
        seq: 0,
        role: "system".to_string(),
        content_json: r#"{"role":"system"}"#.to_string(),
    };
    p.apply(true, &frame);
    // The `sessions` row exists (the FK held).
    let row = db
        .session("sub-1")
        .unwrap()
        .expect("the subagent row exists");
    assert!(row.is_subagent, "the subagent row is flagged");
    // It is HIDDEN from `list_sessions`.
    let all = db.list_sessions(true).unwrap();
    assert!(
        all.iter().all(|r| r.id != "sub-1"),
        "the subagent row is hidden from list_sessions"
    );
    // Its transcript is loadable.
    assert_eq!(db.load_native_messages("sub-1").unwrap().len(), 1);
}

/// Trap 1's pin: a `cost_update` for a session with **no `sessions` row
/// and no prior `StoreFrame`** must STILL persist.
///
/// `record_session_cost` is a bare `UPDATE … WHERE id = ?1`, and an
/// `UPDATE` that matches no row is `Ok(())` with nothing written
/// (`record_session_cost_on_a_missing_row_is_a_silent_no_op` in `db.rs`).
/// `apply_interactive_event` therefore has to `ensure_session_row` BEFORE
/// the write — which is the whole reason it takes `is_subagent`: a
/// subagent's row is created lazily by the persister, and its FIRST priced
/// call can easily arrive before any of its `StoreFrame`s. Without the
/// ensure, that first frame is silently discarded and the child's stored
/// total starts out short of one call.
#[test]
fn a_cost_frame_for_a_session_with_no_row_yet_still_persists() {
    let (_dir, db) = temp_db();
    let p = TranscriptPersister::new(db.clone());
    // The `cwd_map` entry `ensure_session_row` reads (the `StoreFrame`
    // carries no `cwd`) — the same setup
    // `ensure_session_row_creates_a_hidden_subagent_row` uses.
    p.set_cwd("sub-cold", "/tmp/space");
    // NO `record_session`, NO `apply(StoreFrame)`: the row does not exist.
    assert!(db.session("sub-cold").unwrap().is_none());

    // A CHILD's own frame (`is_subagent: true`), so `source: "main"` — the
    // label every `AgentLoop` emits, including a child's. `"subagent"` is no
    // longer producible anywhere: it was the deleted parent-keyed roll-up's
    // label, and this frame is keyed to the CHILD, not the parent.
    p.apply_interactive_event(
        "sub-cold",
        true,
        &serde_json::json!({
            "sessionId": "sub-cold",
            "seq": 0,
            "event": "cost_update",
            "payload": { "costUsd": 0.0000341, "source": "main" },
        }),
    );

    // The row exists, flagged as the ephemeral subagent row…
    let row = db
        .session("sub-cold")
        .unwrap()
        .expect("the cost arm must ensure the row before writing (Trap 1)");
    assert!(row.is_subagent, "the flag must reach the created row");
    // …and the figure landed in it rather than vanishing.
    assert_eq!(db.session_cost("sub-cold").unwrap(), Some(0.0000341));
}

/// A `costUsd` that is not a number writes NOTHING — the same discipline
/// the child's capture already holds (`a_child_that_reported_no_cost_reports_no_cost`:
/// *"a non-number `costUsd` must not become money"*). A string, a `null`,
/// an object, and an absent key are four spellings of "no figure", and the
/// column must stay `NULL` for all four: `NULL` renders nothing, whereas a
/// `0.0` coerced out of `"0.5"` would render a phantom `$0.00` (D5 / ADR
/// 0082) — and would additionally corrupt the accumulator, since a stored
/// figure is a SUM of deltas.
///
/// (Named `cost_usd` rather than the plan's `costUsd`: `non_snake_case` is
/// a warn-by-way lint and this crate runs clippy at 0 warnings with no
/// `allow(non_snake_case)` anywhere.)
#[test]
fn a_non_numeric_cost_usd_writes_nothing() {
    // The four spellings of "no figure", each as the frame's INNER
    // `payload` object. The fourth has no `costUsd` key at all — passing
    // `Value::Null` as a map VALUE would serialise an explicit `null` and
    // so only re-test the second case.
    let cases: [(&str, Value); 4] = [
        ("a string", json!({ "costUsd": "0.5", "source": "main" })),
        ("a null", json!({ "costUsd": null, "source": "main" })),
        ("an object", json!({ "costUsd": { "amount": 0.5 } })),
        ("an absent key", json!({ "source": "main" })),
    ];
    for (label, inner) in cases {
        let (_dir, db) = temp_db();
        let p = TranscriptPersister::new(db.clone());
        p.set_cwd("s1", "/tmp/space");
        p.apply_interactive_event(
            "s1",
            false,
            &serde_json::json!({
                "sessionId": "s1",
                "seq": 0,
                "event": "cost_update",
                "payload": inner,
            }),
        );
        assert_eq!(
            db.session_cost("s1").unwrap(),
            None,
            "a non-number `costUsd` ({label}: {inner}) must not become money"
        );
    }
}

/// A REAL zero is a figure: it must reach the row (turning `NULL` into
/// `Some(0.0)`, which the renderer prints as `$0.00`). Deliberately NOT
/// filtered by a `!= 0.0` guard — that guard is what this repo's own ADR
/// 0082 lesson forbids.
#[test]
fn a_real_zero_cost_still_reaches_the_row() {
    let (_dir, db) = temp_db();
    let p = TranscriptPersister::new(db.clone());
    p.set_cwd("s1", "/tmp/space");
    p.apply_interactive_event(
        "s1",
        false,
        &serde_json::json!({
            "sessionId": "s1",
            "seq": 0,
            "event": "cost_update",
            "payload": { "costUsd": 0.0, "source": "main" },
        }),
    );
    assert_eq!(
        db.session_cost("s1").unwrap(),
        Some(0.0),
        "a real zero is a figure, not an absence"
    );
}

#[test]
fn apply_interactive_event_updates_and_clears_todos() {
    let (_dir, db) = temp_db();
    let p = TranscriptPersister::new(db.clone());
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: PathBuf::from("/tmp"),
        capabilities: Value::Null,
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    // (a) update todos
    let update_payload = serde_json::json!({
        "sessionId": "s1",
        "seq": 0,
        "event": "todos_update",
        "payload": {
            "source": "native",
            "todos": [
                { "content": "t1", "status": "pending" }
            ]
        }
    });
    p.apply_interactive_event("s1", false, &update_payload);
    let stored = db
        .session_todos("s1")
        .unwrap()
        .expect("todos should be stored");
    assert!(stored.contains("t1"));

    // (b) call with second update -> replaced
    let update2_payload = serde_json::json!({
        "sessionId": "s1",
        "seq": 1,
        "event": "todos_update",
        "payload": {
            "source": "native",
            "todos": [
                { "content": "t2", "status": "completed" }
            ]
        }
    });
    p.apply_interactive_event("s1", false, &update2_payload);
    let stored2 = db
        .session_todos("s1")
        .unwrap()
        .expect("todos should be stored");
    assert!(stored2.contains("t2"));
    assert!(!stored2.contains("t1"));

    // (c) call with event: "todos_clear" -> sets None
    let clear_payload = serde_json::json!({
        "sessionId": "s1",
        "seq": 2,
        "event": "todos_clear",
        "payload": {}
    });
    p.apply_interactive_event("s1", false, &clear_payload);
    assert_eq!(db.session_todos("s1").unwrap(), None);

    // (d) call with unrelated event (e.g. state) or bad payload -> does not crash or touch todos_json
    let unrelated = serde_json::json!({
        "sessionId": "s1",
        "event": "state",
        "payload": { "foo": "bar" }
    });
    p.apply_interactive_event("s1", false, &unrelated);
    assert_eq!(db.session_todos("s1").unwrap(), None);

    // Reset with t1, then test bad payload
    p.apply_interactive_event("s1", false, &update_payload);
    assert!(db.session_todos("s1").unwrap().is_some());

    let bad_payload = serde_json::json!({
        "sessionId": "s1",
        "event": "todos_update",
        "payload": { "todos": "not-an-array" }
    });
    p.apply_interactive_event("s1", false, &bad_payload);
    // todos_json was not overwritten with invalid payload
    assert!(db.session_todos("s1").unwrap().unwrap().contains("t1"));
}
