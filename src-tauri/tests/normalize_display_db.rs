//! The display-row pipeline's SQLite half (T5/S5b relocation).
//!
//! Three tests moved VERBATIM out of `crates/fulcrum-core/src/normalize.rs`'s two
//! `#[cfg(test)]` modules, together with the `temp_db` fixture they share. They
//! RELOCATED rather than re-pointed at the crate's `MemoryStore` double because
//! every one of them asserts what the DOUBLE DELIBERATELY REFUSES TO PROVIDE —
//! the `UNIQUE(session_id, kind, message_key)` UPSERT collapse:
//!
//!   * `two_incarnations_of_one_session_never_share_a_display_row` counts SIX
//!     coexisting rows in one table and looks each up by `(kind, message_key)`;
//!   * `a_compaction_pair_persists_one_card_per_compaction_with_its_summary`
//!     asserts the announce/settle pair UPSERTs into ONE row per compaction
//!     (the welded single-row defect it exists to stop IS the UPSERT behaviour);
//!   * `compute_display_rows_matches_the_legacy_persist_update_writes` ends by
//!     re-sending the same rows and asserting the table still holds four — the
//!     idempotency of the constraint, not of the code.
//!
//! `MemoryStore` records EVERY `persist_display` call and collapses nothing, on
//! purpose (see the section header in
//! `crates/fulcrum-core/src/test_support.rs`): a double that mimics a UNIQUE
//! constraint proves nothing about the constraint. The ~20 tests in the same two
//! modules that assert only WHICH rows the pipeline produced stayed in the crate
//! and run against the double; these three assert what the DATABASE did with
//! them, so they live where the database is.
//!
//! `normalize`, `compute_display_rows` and `ThoughtState` are the CRATE's code,
//! reached through `archimedes_lib::agent::normalize` — the widening that made
//! this possible is the documented Step A.3 change in that module. Precedent for
//! the shape: `tests/permission_gate_db.rs` (S5a), `tests/skill_catalog_drift.rs`
//! (S2), `tests/persist_frames_db.rs` (the S5b sibling of this file).

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use archimedes_lib::agent::harness::{SessionStore, Store};
use archimedes_lib::agent::normalize::{compute_display_rows, normalize, ThoughtState, TurnState};
use archimedes_lib::agent::RpcEvent;
use archimedes_lib::storage::Db;
use serde_json::{json, Value};

/// A temp-dir `Db` with a recorded `sessions` row (the `messages` rows FK to
/// `sessions`) — the fixture BOTH of this module's test suites need (one
/// `session_id`, one table, the display rows written through `SessionStore`).
///
/// The `TempDir` GUARD travels back with the `Db` and the caller keeps it
/// alive for the whole test (`let (db, _dir) = temp_db();` — the `mcp` tool
/// tests' `(T, tempfile::TempDir)` pattern). It used to be a hand-rolled
/// `temp_dir()/harness-display-test-<uuid>` that NOTHING ever removed, so every
/// run of either suite left two directories behind; `TempDir` deletes its dir on
/// drop, which only happens if a binding still holds it when the test ends.
fn temp_db() -> (Arc<Db>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("a temp dir");
    let db = Arc::new(Db::open(&dir.path().join("t.db")).expect("db should open"));
    db.record_session(&archimedes_lib::agent::SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session");
    (db, dir)
}

fn ev(v: serde_json::Value) -> RpcEvent {
    serde_json::from_value(v).expect("event should parse")
}

/// One frame's whole downstream pipeline: `compute_display_rows` + the
/// write half (`SessionStore::persist_display` → `db.record_message`) —
/// what the loop's driver does per frame (ADR 0025's split).
fn persist_frames(
    store: &SessionStore,
    session_id: &str,
    frames: Vec<Value>,
    text_acc: &StdMutex<HashMap<String, String>>,
    tool_state: &StdMutex<HashMap<String, Value>>,
    thought_state: &StdMutex<ThoughtState>,
) {
    for frame in frames {
        let rows = compute_display_rows(&frame, text_acc, tool_state, thought_state);
        store
            .persist_display(session_id, &rows)
            .expect("display rows persist");
    }
}

/// (ADR 0049) TWO Worker lives for ONE session — the Resume case, and the
/// defect this exists to stop. A Resume spawns a new Worker with a new
/// `AgentLoop`, so `TurnState`'s counters restart at 0 and the resumed
/// session's first reply is the `m1` its first Worker already used. The
/// display store UPSERTs on `UNIQUE(session_id, kind, message_key)` and has
/// no DELETE, so an unstamped second `m1` silently overwrote the first
/// incarnation's rows, and ADR 0048's Retraction — which erases BY
/// `messageId` — could erase history that is not its own.
///
/// The claim, in words: for ONE `session_id` and ONE `Db`, every id the
/// harness mints is namespaced by its incarnation stamp, so the same
/// counter value in two incarnations is two display rows. A Retraction in
/// incarnation B erases B's OWN text and thought rows and leaves
/// incarnation A's text, thought AND system rows untouched — and nothing
/// unstamped (`m1`, `m1#1`, `system`) is ever written.
///
/// This is the seam where two Worker lives meet: two `TurnState`s with
/// different stamps, two FRESH accumulator sets (a new Worker has new ones),
/// one session id, one database.
#[test]
fn two_incarnations_of_one_session_never_share_a_display_row() {
    let (db, _dir) = temp_db();
    let store = SessionStore::new(db.clone());

    // ── incarnation A: the first Worker ────────────────────────────────
    let mut st_a = TurnState::stamped("aaaaaa");
    let a_text = StdMutex::new(HashMap::new());
    let a_tools = StdMutex::new(HashMap::new());
    let a_thoughts = StdMutex::new(ThoughtState::default());
    let events_a = [
        // Opens `aaaaaa:m1` (the counter's FIRST value).
        ev(json!({
            "type": "message_start",
            "message": { "role": "assistant", "content": [] },
        })),
        ev(json!({
            "type": "message_update",
            "usage": null,
            "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "history" },
        })),
        ev(json!({
            "type": "message_update",
            "usage": null,
            "assistantMessageEvent": { "type": "thinking_delta", "contentIndex": 0, "delta": "think" },
        })),
        // The retry one-liner — the id family with NO counter to seed
        // (`system`), which a counter-seeding design would have left
        // unstamped and therefore shared.
        ev(json!({
            "type": "auto_retry_start",
            "attempt": 1,
            "maxAttempts": 3,
            "delayMs": 100,
            "errorMessage": "boom",
        })),
    ];
    for e in &events_a {
        persist_frames(
            &store,
            "s1",
            normalize(e, &mut st_a),
            &a_text,
            &a_tools,
            &a_thoughts,
        );
    }

    // ── incarnation B: the resumed Worker ──────────────────────────────
    // A SECOND, FRESH set of accumulators (what a new process has), the
    // SAME session id, the SAME database.
    let mut st_b = TurnState::stamped("bbbbbb");
    let b_text = StdMutex::new(HashMap::new());
    let b_tools = StdMutex::new(HashMap::new());
    let b_thoughts = StdMutex::new(ThoughtState::default());
    let events_b = [
        // The SAME counter value A used — the collision is the point.
        ev(json!({
            "type": "message_start",
            "message": { "role": "assistant", "content": [] },
        })),
        ev(json!({
            "type": "message_update",
            "usage": null,
            "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "parti" },
        })),
        // REQUIRED: the retraction arm erases only the segments recorded in
        // `ThoughtState.segments`, so without a thought there is no
        // `bbbbbb:m1#1` row to assert.
        ev(json!({
            "type": "message_update",
            "usage": null,
            "assistantMessageEvent": { "type": "thinking_delta", "contentIndex": 0, "delta": "partthink" },
        })),
        ev(json!({ "type": "message_retracted" })),
    ];
    for e in &events_b {
        persist_frames(
            &store,
            "s1",
            normalize(e, &mut st_b),
            &b_text,
            &b_tools,
            &b_thoughts,
        );
    }

    // ── what the one table actually holds ─────────────────────────────
    let rows: Vec<(String, String, String)> = db
        .messages_for("s1")
        .unwrap()
        .into_iter()
        .map(|m| (m.kind, m.message_key.unwrap_or_default(), m.payload_json))
        .collect();
    let row = |kind: &str, key: &str| -> (String, String, String) {
        rows.iter()
            .find(|(k, m, _)| k == kind && m == key)
            .cloned()
            .unwrap_or_else(|| panic!("no ({kind}, {key}) display row; the table is {rows:?}"))
    };

    // A's rows survived B's arrival entirely.
    assert!(
        row("agent-text", "aaaaaa:m1").2.contains("history")
            && row("agent-thought", "aaaaaa:m1#1").2.contains("think"),
        "incarnation A's text and thought rows are intact, the table is {rows:?}"
    );
    assert!(
        row("agent-text", "aaaaaa:system").2.contains("Retrying"),
        "the shared one-liner key is stamped too (it has no counter to \
         seed, so it is the family a counter-only design would leave \
         shared), the table is {rows:?}"
    );

    // B erased its OWN rows — and nothing else.
    assert_eq!(
        row("agent-text", "bbbbbb:m1").2,
        r#"{"text":""}"#,
        "B's Retraction emptied B's own text row"
    );
    assert_eq!(
        row("agent-thought", "bbbbbb:m1#1").2,
        r#"{"text":""}"#,
        "B's Retraction emptied B's own thought row"
    );
    // The discard line is a display row too — asserted so nobody later
    // "cleans it up".
    assert!(
        row("agent-text", "bbbbbb:retract:1")
            .2
            .contains("Discarded"),
        "the discard line is persisted under B's own stamp, the table is {rows:?}"
    );

    // Nothing unstamped was ever written.
    for unstamped in ["m1", "m1#1", "system"] {
        assert!(
            !rows.iter().any(|(_, k, _)| k == unstamped),
            "an unstamped id reached the display store: {unstamped}"
        );
    }

    // The two first-assistant-message rows COEXIST as TWO rows: both
    // incarnations counted to `m1` for one `session_id`, so the stamp is
    // the only thing keeping them apart.
    //
    // The EXACT TOTAL is the proof. Drop the stamp and `m1` / `m1#1`
    // collapse into ONE row each, leaving FOUR rows (`m1`, `m1#1`,
    // `system`, `retract:1`) where these SIX live side by side. Order of
    // failure when the stamp is dropped: the
    // `row("agent-text", "aaaaaa:m1")` LOOKUP above is the FIRST thing to
    // fail (`row` panics on an absent key), this count is the second.
    //
    // And deliberately NO `assert_ne!(A's payload, B's payload)` beside
    // it: rows are keyed by `(kind, message_key)`, so two rows carrying
    // `aaaaaa:m1` and `bbbbbb:m1` CANNOT be one overwritten row — the
    // count already states that claim — and these two payloads differ
    // only incidentally (A streamed `history`; B streamed `parti` and then
    // erased itself), so the assertion could not fire for the overwrite it
    // advertises. What each life's payload has to BE is asserted per key
    // ABOVE (`aaaaaa:m1` holds A's text, `bbbbbb:m1` is emptied by B's own
    // Retraction), which is the assertion that can actually fail.
    assert_eq!(
        rows.len(),
        6,
        "A's `m1` + `m1#1` + `system` PLUS B's `m1` + `m1#1` + `retract:1` \
         — six coexisting rows, two Worker lives that never touched each \
         other's keys; the table is {rows:?}"
    );
}

/// (issue #90 item 2) The DURABLE half: what a reload reads back. A frame
/// the reducer renders but `compute_display_rows` never persists would show
/// the summary live and lose it on reopen, so this drives the whole
/// downstream pipeline (`normalize` → `compute_display_rows` →
/// `persist_display`) and reads the `messages` table.
///
/// The second compaction is the point of the test: the announce/settle pair
/// must write a SECOND row, not UPSERT over the first. The one-liners this
/// replaced shared `{stamp}:system` and appended, so a real database held
/// every compaction of a session in one welded bubble.
#[test]
fn a_compaction_pair_persists_one_card_per_compaction_with_its_summary() {
    let (db, _dir) = temp_db();
    let store = SessionStore::new(db.clone());
    let mut st = TurnState::stamped("t");
    let text = StdMutex::new(HashMap::new());
    let tools = StdMutex::new(HashMap::new());
    let thoughts = StdMutex::new(ThoughtState::default());

    for e in [
        ev(json!({ "type": "compaction_start", "reason": "threshold" })),
        ev(json!({
            "type": "compaction_end",
            "reason": "threshold",
            "result": { "summary": "first summary text" },
            "aborted": false,
            "willRetry": false,
        })),
        ev(json!({ "type": "compaction_start", "reason": "overflow" })),
        ev(json!({
            "type": "compaction_end",
            "reason": "overflow",
            "result": { "summary": "second summary text" },
            "aborted": false,
            "willRetry": true,
        })),
    ] {
        persist_frames(
            &store,
            "s1",
            normalize(&e, &mut st),
            &text,
            &tools,
            &thoughts,
        );
    }

    let rows: Vec<(String, String, String)> = db
        .messages_for("s1")
        .unwrap()
        .into_iter()
        .map(|m| (m.kind, m.message_key.unwrap_or_default(), m.payload_json))
        .collect();
    let cards: Vec<&(String, String, String)> =
        rows.iter().filter(|(k, _, _)| k == "tool-call").collect();
    assert_eq!(
        cards.len(),
        2,
        "one row PER compaction (the welded single-row defect), got {rows:?}"
    );
    assert_eq!(cards[0].1, "t:compact:1");
    assert_eq!(cards[1].1, "t:compact:2");
    // The settle MERGED into the announced row (same key), and the summary
    // is the payload `rowToMessages` reads back into `rawOutput`.
    assert!(
        cards[0].2.contains("first summary text") && cards[0].2.contains("\"completed\""),
        "the first card holds its summary and settled status, got {}",
        cards[0].2
    );
    assert!(
        cards[1].2.contains("second summary text") && cards[1].2.contains("\"overflow\""),
        "the second card holds its OWN summary and its own trigger, got {}",
        cards[1].2
    );
    // And no welded system bubble exists at all.
    assert!(
        !rows
            .iter()
            .any(|(k, key, _)| k == "agent-text" && key.ends_with(":system")),
        "a compaction writes no system one-liner row, got {rows:?}"
    );
}

/// (issue #190 / ADR 0108, the DURABILITY half) A Truncated turn's
/// `agent-text` row carries the provider's `disposition` in the QUERYABLE
/// form — `json_extract(payload_json, '$.disposition') = 'length'` — so a
/// client can re-seed `stopReasons` after a restart and the census can count
/// truncated turns with a KEY-level SQL predicate.
///
/// The seam is the whole pipeline, not any one function: a real
/// `RpcEvent::turn_truncated` decoded off the wire shape (`ev`), through
/// `normalize` (which mints `{stamp}:truncate:N`), through
/// `compute_display_rows` (which builds the payload), through
/// `SessionStore::persist_display` → `db.record_message`, and read back from
/// the `messages` TABLE. Every earlier assertion in this file stops at the
/// frame or the in-memory `DisplayRow`; the claim here is about what the
/// database row says, because that is the only thing that survives a restart.
///
/// # This test is RED against `fulcrum-harness` 0.3.0 BY DESIGN
///
/// 0.3.0's `agent_message_chunk` arm builds `json!({ "text": entry })` — the
/// frame `normalize` emits for `turn_truncated` is `unique_system_chunk`,
/// which carries ONLY `content.text` + `messageId`, so no disposition key
/// exists anywhere downstream and the `json_extract` reads SQL `NULL`. The
/// engine publishes the key in 0.3.1 and this file's pin is bumped in the
/// same PR; a pin that passed on 0.3.0 would pin nothing (AGENTS.md: "a pin
/// that passes on the broken thing is worse than no pin", applied in reverse).
///
/// # Why `json_extract` and never `LIKE`
///
/// This repo's own research rules `payload_json LIKE '%disposition%'`
/// unsound as an instrument in both directions: it FALSE-POSITIVES on
/// transcript text that merely quotes the word `disposition` (a real reply
/// can contain it), and FALSE-NEGATIVES on any other spelling or placement.
/// `json_extract` asks SQLite's JSON parser about ONE KEY, which is exactly
/// the predicate the design's census uses and the only assertion that can
/// distinguish "the key is there" from "the word is in the blob".
///
/// The `$.text` assertion is the other half of the claim: the prose the
/// render path shows must SURVIVE the change that adds the key — the
/// disposition is ADDED to the payload, not substituted for the text.
#[test]
fn a_truncated_turn_persists_its_provider_disposition_where_a_client_can_read_it() {
    let (db, dir) = temp_db();
    let store = SessionStore::new(db.clone());
    let mut st = TurnState::stamped("t");
    let text = StdMutex::new(HashMap::new());
    let tools = StdMutex::new(HashMap::new());
    let thoughts = StdMutex::new(ThoughtState::default());

    // The real event off the wire — `ev` is the actual
    // `serde_json::from_value` decode path, so an RpcEvent variant that
    // stopped decoding would fail HERE rather than silently no-op below.
    persist_frames(
        &store,
        "s1",
        normalize(&ev(json!({ "type": "turn_truncated" })), &mut st),
        &text,
        &tools,
        &thoughts,
    );

    // ── what the `messages` table holds (the `Db` accessor, as every other
    // test in this file reads rows back) ─────────────────────────────────
    let rows: Vec<(String, String, String)> = db
        .messages_for("s1")
        .unwrap()
        .into_iter()
        .map(|m| (m.kind, m.message_key.unwrap_or_default(), m.payload_json))
        .collect();
    let row = rows
        .iter()
        .find(|(_, key, _)| key.ends_with("truncate:0"))
        .unwrap_or_else(|| {
            panic!("no `truncate:0` display row was persisted; the table is {rows:?}")
        });

    // (1) The row is an `agent-text` row — the kind the reader hydrates into
    // a transcript bubble, and the first half of the UNIQUE key.
    assert_eq!(
        row.0, "agent-text",
        "the truncation notice persists as an `agent-text` row (the kind a \
         client reads back as a transcript bubble), the table is {rows:?}"
    );
    // (2) Stamped and counter-seeded: `{stamp}:truncate:0`, the first notice
    // of this incarnation (ADR 0049 — an unstamped key would collide across
    // Worker lives).
    assert_eq!(
        row.1, "t:truncate:0",
        "the notice is keyed `{{stamp}}:truncate:0` (stamped, so a Resume's \
         own first notice cannot overwrite it)"
    );
    // (4) The human prose is still there — the render path is unaffected by
    // the key this test pins.
    let payload: Value = serde_json::from_str(&row.2).expect("payload_json is JSON");
    assert_eq!(
        payload["text"], "Response was truncated before completion",
        "the notice's prose survives into the persisted payload (the render \
         path reads `$.text`), got {}",
        row.2
    );

    // (3) THE QUERYABLE FORM — the instrument the census uses. An
    // INDEPENDENT connection to the same file (the
    // `fulcrum_seams.rs::artifact_rows` / `storage.rs` precedent) because the
    // claim is "a client can run this SQL", and `Db` deliberately exposes no
    // raw query path. `temp_db` builds the file at `t.db` inside the `TempDir`
    // guard, which this test keeps alive.
    let db_path = dir.path().join("t.db");
    let conn = rusqlite::Connection::open(&db_path).expect("an independent connection");
    let (sql_text, sql_disposition): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT json_extract(payload_json, '$.text'),
                    json_extract(payload_json, '$.disposition')
             FROM messages
             WHERE session_id = ?1 AND kind = 'agent-text'
               AND message_key = 't:truncate:0'",
            rusqlite::params!["s1"],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("the truncate:0 agent-text row is queryable by (kind, message_key)");

    // The same instrument proves the prose is a real JSON key — and that the
    // `NULL` below is about the DISPOSITION and not about a missing row or a
    // payload the JSON parser cannot read.
    assert_eq!(
        sql_text.as_deref(),
        Some("Response was truncated before completion"),
        "`json_extract(payload_json, '$.text')` reads the prose back (this \
         also proves the row exists and parses as JSON, so a NULL \
         disposition below means the KEY is absent, not the row)"
    );
    // THE PIN. Absent on `fulcrum-harness` 0.3.0 (reads SQL `NULL` → `None`);
    // `'length'` on the 0.3.1 pin bump.
    assert_eq!(
        sql_disposition.as_deref(),
        Some("length"),
        "`json_extract(payload_json, '$.disposition')` must read 'length' on \
         the persisted truncation notice — this is the machine-queryable form \
         the truncated-turn census and the post-restart `stopReasons` re-seed \
         both depend on (RED by design on fulcrum-harness 0.3.0)"
    );
}

/// The `persist_update` split (ADR 0025) GOLDEN test:
/// `compute_display_rows` on a canned normalized update + canned
/// accumulators yields the same `Vec<DisplayRow>` the old
/// `persist_update` wrote (the normalize + accumulator logic moved
/// verbatim — `SqliteStore::persist_display` applies the rows via
/// `db.record_message`, so the `messages` rows are identical).
#[test]
fn compute_display_rows_matches_the_legacy_persist_update_writes() {
    let (db, _dir) = temp_db();
    let store = SessionStore::new(db.clone());
    let text_acc = StdMutex::new(HashMap::new());
    let tool_state = StdMutex::new(HashMap::new());
    let thought_state = StdMutex::new(ThoughtState::default());

    // The canned normalized update sequence (the FULL
    // `session-update` frames the `normalize` emits):
    let updates = [
        // The assistant message m1: two chunks (the accumulator grows).
        json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": { "text": "Hel" } }),
        json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": { "text": "lo" } }),
        // A thought segment for m1 (one chunk).
        json!({ "sessionUpdate": "agent_thought_chunk", "messageId": "m1", "content": { "text": "think" } }),
        // A tool-call announcement + update (the `merge_json` shallow-merge).
        json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "run" }),
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": { "type": "completed" } }),
        // A second assistant message m2 (segments the thought stream).
        json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m2", "content": { "text": "x" } }),
        // An unknown kind (NO row — the `_` arm).
        json!({ "sessionUpdate": "usage_update" }),
    ];
    let mut all_rows = Vec::new();
    for u in &updates {
        let rows = compute_display_rows(u, &text_acc, &tool_state, &thought_state);
        if !rows.is_empty() {
            assert_eq!(rows.len(), 1, "at most one row per update");
        }
        all_rows.extend(rows);
    }
    // 6 rows (the 7th update — the unknown kind — yields none).
    assert_eq!(all_rows.len(), 6);
    // The per-row golden (what the old `persist_update` wrote):
    let (r0, r1, r2, r3, r4, r5) = (
        &all_rows[0],
        &all_rows[1],
        &all_rows[2],
        &all_rows[3],
        &all_rows[4],
        &all_rows[5],
    );
    assert_eq!(
        (r0.kind.as_str(), r0.message_key.as_str()),
        ("agent-text", "m1")
    );
    assert_eq!(r0.payload_json, json!({ "text": "Hel" }), "the first chunk");
    assert_eq!(
        r1.payload_json,
        json!({ "text": "Hello" }),
        "the accumulator grew"
    );
    assert_eq!(
        (r2.kind.as_str(), r2.message_key.as_str()),
        ("agent-thought", "m1#1"),
        "the thought segment key"
    );
    assert_eq!(r2.payload_json, json!({ "text": "think" }));
    assert_eq!(
        (r3.kind.as_str(), r3.message_key.as_str()),
        ("tool-call", "t1")
    );
    assert_eq!(r3.payload_json["title"], "run", "the announcement row");
    assert_eq!(
        r4.payload_json["title"], "run",
        "the merged row keeps the title"
    );
    assert_eq!(
        r4.payload_json["status"]["type"], "completed",
        "the merge added the status"
    );
    assert_eq!(
        (r5.kind.as_str(), r5.message_key.as_str()),
        ("agent-text", "m2")
    );
    assert_eq!(r5.payload_json, json!({ "text": "x" }));
    // `created_at` is the current time (the write half's `now_ms`).
    assert!(r0.created_at > 0);

    // The WRITE half (`SqliteStore::persist_display` via
    // `db.record_message`): the rows land as `messages` rows — the
    // FINAL golden values (the last row per key wins, the upsert
    // idempotency — the old `persist_update`'s semantics,
    // unchanged).
    store.persist_display("s1", &all_rows).unwrap();
    let db_rows = db.messages_for("s1").unwrap();
    assert_eq!(db_rows.len(), 4, "four distinct rows landed");
    let text = db_rows
        .iter()
        .find(|r| r.kind == "agent-text" && r.message_key.as_deref() == Some("m1"))
        .unwrap();
    assert_eq!(
        text.payload_json, r#"{"text":"Hello"}"#,
        "the m1 row holds the GROWN accumulator (the last upsert wins)"
    );
    let thought = db_rows.iter().find(|r| r.kind == "agent-thought").unwrap();
    assert_eq!(thought.message_key.as_deref(), Some("m1#1"));
    assert_eq!(thought.payload_json, r#"{"text":"think"}"#);
    let tool = db_rows
        .iter()
        .find(|r| r.kind == "tool-call" && r.message_key.as_deref() == Some("t1"))
        .unwrap();
    let tool: serde_json::Value = serde_json::from_str(&tool.payload_json).unwrap();
    assert_eq!(tool["title"], "run");
    assert_eq!(tool["status"]["type"], "completed");
    // A re-send of the SAME rows is an idempotent upsert (no
    // duplicates — the old `persist_update`'s semantics).
    store.persist_display("s1", &all_rows).unwrap();
    let db_rows = db.messages_for("s1").unwrap();
    assert_eq!(db_rows.len(), 4, "the upsert never duplicates");
}
