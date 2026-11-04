//! The desktop half of the transcript STORE (ADR 0025 Task 6) — the SPLIT, not
//! the move (T5/S5b, the S5b RULING's BLOCKER 2).
//!
//! `Store` (the trait), `NoopStore`, `role_str` and the `DisplayRow` re-export
//! moved to `crates/fulcrum-core/src/harness/store.rs`, because the crate's own
//! `AgentLoop` / `compact.rs` / `loop/emit.rs` name them and a crate file cannot
//! name a desktop module. What stayed HERE is the one implementation that holds
//! a `storage::Db`:
//!
//!   * `rusqlite` is not in the crate's dependency graph — `DbError` wraps
//!     `rusqlite::Error` and therefore cannot move (Step B-bis), so nothing that
//!     touches a `Db` can cross the boundary;
//!   * reaching `crate::storage` from the crate would be the `fulcrum-core →
//!     archimedes_lib` edge that IS the package cycle T5 exists to sever.
//!
//! So the desktop implements the crate's trait, exactly as `web/render.rs`
//! implements the crate's `RenderRequester` (S2), as `harness/trust.rs`
//! implements `TrustSource` (S5a), and as `storage/db.rs` implements
//! `FulcrumPersistence` (S4). Desktop→crate is the allowed direction.
//!
//! # The error type is the one thing that changed
//!
//! All six trait methods now return the crate's `StoreError` rather than the
//! desktop's `DbError`, and the mapping happens HERE, per method, through the
//! `impl From<DbError> for StoreError` `storage/db.rs` defines
//! (`Sqlite(_) → Io`, `Io → Io`, `Json → Json`).
//!
//! ⚠️ That is a real, if narrow, behaviour change and it is stated in full on
//! the crate module's docs and in ADR 0091: a SQLite failure that reaches
//! `session/mod.rs`'s `.map_err(|e| SessionError::Io(e.to_string()))` now reads
//! `"io error: sqlite error: …"` where it read `"sqlite error: …"`. No test
//! pins the string, nothing branches on the variant, and the path is
//! corrupt/unreadable-database only.
//!
//! The INHERENT `impl SessionStore` below keeps `DbError` — it is desktop code
//! calling `Db` directly, and `store.rs`'s own `load_messages` constructs
//! `DbError::Json`, which is exactly the assumption S4's `StoreError` design
//! recorded. Only the TRAIT impl maps.
//!
//! # The pin
//!
//! `src-tauri/tests/fulcrum_seams.rs::the_store_impls_satisfy_the_crate_trait`
//! instantiates BOTH re-plumbed impls (`SessionStore` here and `IpcStore` in
//! `worker/store.rs`) against the crate trait — S4's rule that an impl nobody
//! instantiates proves nothing. Deleting either `impl Store for …` block reddens
//! it. Its value is honestly LOWER than S4's other pins: it proves the
//! re-plumbed impls still typecheck, not that the SQLite behaviour behind them
//! is unchanged. That rests on the four `SessionStore`-as-a-`Store` tests and
//! the two #96 dir-ownership pins below, which are the same tests that ran
//! before the split and which stayed with the code they test (they need a real
//! `Db`, so they could not have travelled).

use std::sync::Arc;

use fulcrum_core::StoreError;

use crate::agent::harness::provider::ChatMessage;
use crate::storage::{Db, DbError};

// The crate-side halves, re-exported so the desktop's pre-S5b spellings keep
// resolving: `harness/mod.rs`'s block names `{DisplayRow, NoopStore, Store}`,
// and `worker/store.rs` imports `{DisplayRow, Store}` from this path.
// `Store` (the trait) is re-exported from here, so `worker/core.rs` and
// `worker/store.rs` keep their `crate::agent::harness::store::Store` path.
// `role_str` is deliberately NOT re-exported here: its only two readers
// (`loop/emit.rs`, `compact.rs`) moved with the crate, so nothing on the desktop
// names it — the A.3 rule is that the STAYING desktop's names decide what gets
// raised, and it names none.
pub use fulcrum_core::harness::store::{DisplayRow, NoopStore, Store};

/// The native session store (the provider transcript on the shared `Db`).
///
/// The desktop's implementation of the crate's [`Store`] seam — the half the
/// crate cannot hold, because it holds a `Db`.
#[derive(Clone)]
pub struct SessionStore(Arc<Db>);

impl Store for SessionStore {
    // Each method delegates to the INHERENT one below (the explicit
    // `SessionStore::` path picks the inherent method — never the trait one,
    // which is what this impl is defining) and maps the desktop's `DbError` to
    // the crate's `StoreError` at the boundary. The `From` impl is the single
    // place the mapping lives, so a future need to distinguish a locked database
    // has one place to grow and does not get `rusqlite` into the crate.
    fn insert_message(
        &self,
        session_id: &str,
        seq: u64,
        role: &str,
        content_json: &str,
    ) -> Result<(), StoreError> {
        SessionStore::insert_message(self, session_id, seq, role, content_json)
            .map_err(StoreError::from)
    }

    fn load_messages(&self, session_id: &str) -> Result<Vec<ChatMessage>, StoreError> {
        SessionStore::load_messages(self, session_id).map_err(StoreError::from)
    }

    fn clear_messages(&self, session_id: &str) -> Result<(), StoreError> {
        SessionStore::clear_messages(self, session_id).map_err(StoreError::from)
    }

    fn replace_messages(
        &self,
        session_id: &str,
        rows: &[(u64, String, String)],
    ) -> Result<(), StoreError> {
        SessionStore::replace_messages(self, session_id, rows).map_err(StoreError::from)
    }

    /// The display write half (today's `persist_update`'s `db.record_message`
    /// loop, moved verbatim): tries EVERY row (a failed row never stops
    /// the rest — the `let _ =` semantics), reports the first error.
    ///
    /// The error stays a `DbError` INSIDE the loop and maps once at the `match`,
    /// so the per-row "keep trying" semantics are byte-identical to before.
    fn persist_display(&self, session_id: &str, rows: &[DisplayRow]) -> Result<(), StoreError> {
        let mut first_err: Option<DbError> = None;
        for row in rows {
            if let Err(e) = self.0.record_message(
                session_id,
                &row.kind,
                Some(&row.message_key),
                &row.payload_json.to_string(),
            ) {
                first_err.get_or_insert(e);
            }
        }
        first_err.map_or(Ok(()), |e| Err(StoreError::from(e)))
    }

    fn record_context_usage(
        &self,
        session_id: &str,
        used: u64,
        window: u64,
    ) -> Result<(), StoreError> {
        self.0
            .record_session_context_usage(session_id, used, window)
            .map_err(StoreError::from)
    }
}

impl SessionStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self(db)
    }

    /// The underlying `Db` (the display `record_message` persistence).
    pub fn db(&self) -> &Arc<Db> {
        &self.0
    }

    /// Insert or refresh one transcript message (idempotent — the same
    /// `(session_id, seq)` always collapses to one row). `seq` is a
    /// message index (it cannot realistically exceed `i64::MAX`).
    pub fn insert_message(
        &self,
        session_id: &str,
        seq: u64,
        role: &str,
        content_json: &str,
    ) -> Result<(), DbError> {
        self.0
            .insert_native_message(session_id, seq as i64, role, content_json)
    }

    /// The session's transcript in `seq` order (reconstruct the
    /// `messages` vec for resume). A malformed row is a `Json` error —
    /// a corrupt transcript must not silently load as an empty one.
    ///
    /// This is the site S4's `StoreError` design was measured against: it
    /// CONSTRUCTS `DbError::Json` and never matches `Sqlite`, which is what made
    /// collapsing the third variant admissible. It lands in the STAYING inherent
    /// impl, so it constructs the desktop's `DbError` — correct, and the S4
    /// assumption survives the split either way.
    pub fn load_messages(&self, session_id: &str) -> Result<Vec<ChatMessage>, DbError> {
        let rows = self.0.load_native_messages(session_id)?;
        rows.into_iter()
            .map(|row| serde_json::from_str(&row).map_err(DbError::Json))
            .collect()
    }

    /// Clear the session's transcript (`native_messages` ONLY — the
    /// display `messages` table is NOT touched).
    pub fn clear_messages(&self, session_id: &str) -> Result<(), DbError> {
        self.0.clear_native_messages(session_id)
    }

    /// Replace the session's transcript ATOMICALLY (the `run_compaction`
    /// rewrite: a single `Db` transaction — a crash mid-rewrite must
    /// never leave an empty / partial transcript). `seq` is a message
    /// index (it cannot realistically exceed `i64::MAX`).
    pub fn replace_messages(
        &self,
        session_id: &str,
        rows: &[(u64, String, String)],
    ) -> Result<(), DbError> {
        let rows: Vec<(i64, String, String)> = rows
            .iter()
            .map(|(seq, role, content_json)| (*seq as i64, role.clone(), content_json.clone()))
            .collect();
        self.0.replace_native_messages(session_id, &rows)
    }
}

#[cfg(test)]
mod tests {
    use super::{DisplayRow, SessionStore, Store};
    use crate::agent::harness::provider::ChatMessage;
    use crate::agent::SessionInfo;
    use crate::storage::{Db, DbError};
    use std::sync::Arc;

    /// A temp-dir `Db` with a recorded `sessions` row (the `native_messages`
    /// / `messages` rows FK to `sessions`).
    fn temp_db() -> (crate::test_support::ScratchDir, Arc<Db>) {
        let dir = crate::test_support::ScratchDir::in_env_temp("harness-store-test-", "db");
        let db = Arc::new(Db::open(&dir.join("t.db")).expect("db should open"));
        db.record_session(&SessionInfo {
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
        (dir, db)
    }

    /// `SessionStore` as a `Store`: `insert_message` / `load_messages`
    /// round-trip against a temp-dir `Db` (the idempotent upsert — the
    /// same `(session_id, seq)` collapses to one row).
    #[test]
    fn session_store_insert_load_round_trip() {
        let (_dir, db) = temp_db();
        let store = SessionStore::new(db.clone());
        let msg = ChatMessage {
            role: crate::agent::harness::provider::ChatRole::User,
            content: crate::agent::harness::provider::MessageContent::Text("hello".to_string()),
            tool_call_id: None,
            tool_calls: None,
        };
        let content_json = serde_json::to_string(&msg).unwrap();
        store
            .insert_message("s1", 0, "user", &content_json)
            .unwrap();
        // An idempotent re-insert (the same seq) collapses to one row.
        store
            .insert_message("s1", 0, "user", &content_json)
            .unwrap();
        let loaded = store.load_messages("s1").unwrap();
        assert_eq!(loaded.len(), 1, "the upsert is idempotent (one row)");
        assert_eq!(loaded[0], msg, "the content round-trips verbatim");
    }

    /// `persist_display` — a `Vec<DisplayRow>` lands as `messages` rows via
    /// `db.record_message` (the upsert idempotency: a re-send with an
    /// updated payload refreshes the SAME row, never duplicates).
    #[test]
    fn session_store_persist_display_upserts_rows() {
        let (_dir, db) = temp_db();
        let store = SessionStore::new(db.clone());
        store
            .persist_display(
                "s1",
                &[
                    DisplayRow {
                        kind: "agent-text".to_string(),
                        message_key: "m1".to_string(),
                        payload_json: serde_json::json!({ "text": "Hel" }),
                        created_at: 1,
                    },
                    DisplayRow {
                        kind: "tool-call".to_string(),
                        message_key: "t1".to_string(),
                        payload_json: serde_json::json!({}),
                        created_at: 2,
                    },
                ],
            )
            .unwrap();
        let rows = db.messages_for("s1").unwrap();
        assert_eq!(rows.len(), 2, "two rows landed");
        let text = rows.iter().find(|r| r.kind == "agent-text").unwrap();
        assert_eq!(text.message_key.as_deref(), Some("m1"));
        assert_eq!(text.payload_json, r#"{"text":"Hel"}"#);
        // The accumulator grows: a re-send with the updated payload
        // refreshes the SAME row (the upsert idempotency).
        store
            .persist_display(
                "s1",
                &[
                    DisplayRow {
                        kind: "agent-text".to_string(),
                        message_key: "m1".to_string(),
                        payload_json: serde_json::json!({ "text": "Hello" }),
                        created_at: 3,
                    },
                    DisplayRow {
                        kind: "tool-call".to_string(),
                        message_key: "t1".to_string(),
                        payload_json: serde_json::json!({ "title": "run", "status": "done" }),
                        created_at: 4,
                    },
                ],
            )
            .unwrap();
        let rows = db.messages_for("s1").unwrap();
        assert_eq!(rows.len(), 2, "the upsert never duplicates");
        let text = rows.iter().find(|r| r.kind == "agent-text").unwrap();
        assert_eq!(
            text.payload_json, r#"{"text":"Hello"}"#,
            "the payload was refreshed"
        );
    }

    /// `record_context_usage` — lands in `sessions.context_usage_json`
    /// (the `Db::record_session_context_usage` semantics — a missing
    /// `sessions` row is a no-op, not an error).
    #[test]
    fn session_store_record_context_usage_lands_in_the_sessions_row() {
        let (_dir, db) = temp_db();
        let store = SessionStore::new(db.clone());
        store.record_context_usage("s1", 53_760, 128_000).unwrap();
        let row = db.session("s1").unwrap().unwrap();
        let usage: serde_json::Value =
            serde_json::from_str(&row.context_usage_json.unwrap()).expect("the usage is JSON");
        assert_eq!(usage["used"], 53_760);
        assert_eq!(usage["window"], 128_000);
        // A missing `sessions` row is a no-op (the `UPDATE` matches nothing).
        assert!(store.record_context_usage("missing-session", 1, 10).is_ok());
    }

    /// The trait boundary, and the ONE thing this split changes. A `DbError`
    /// that reaches the crate becomes a `StoreError`, and a SQLite failure
    /// arrives as `Io` with its own sentence preserved inside — so the string
    /// the user eventually sees gains an `io error: ` prefix. That is the
    /// pre-accepted deviation, and this test is what stops it from being a
    /// rumour: it pins the mapping, including the lossy `Sqlite → Io` arm.
    #[test]
    fn a_sqlite_error_maps_to_store_error_io_and_keeps_its_sentence() {
        use fulcrum_core::StoreError;

        // The real way to get a SQLite error out of `SessionStore`: a
        // transcript row whose `content_json` is not a `ChatMessage` is the
        // `Json` arm, so drive the `Sqlite` arm the way `Db` does — a
        // `load_native_messages` on a `Db` whose schema is not there.
        let dir = crate::test_support::ScratchDir::in_env_temp("harness-store-map-", "db");
        let bare = Arc::new(Db::open(&dir.join("bare.db")).expect("db should open"));
        // `SessionStore::load_messages` on a session with no `sessions` row
        // succeeds empty (the SELECT is valid), so force the failure at the
        // `Db` layer directly and map it.
        let missing = bare.session("nope").expect("a valid schema reads None");
        assert!(missing.is_none(), "the read itself works");

        // The `rusqlite::Error` fixture is the one `errors.rs`'s own mapping
        // test already uses, so no `ffi` reach is needed for a Display-only pin.
        let sqlite = DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows);
        let before = sqlite.to_string();
        let mapped = StoreError::from(sqlite);
        let after = mapped.to_string();
        assert!(
            matches!(mapped, StoreError::Io(_)),
            "`Sqlite` collapses to `Io` — got {mapped:?}"
        );
        assert_eq!(
            before, "sqlite error: Query returned no rows",
            "the desktop's own spelling, unchanged (this is the half no test could see \
             before: what the string WAS). The sentence is rusqlite's own `Display` for \
             `QueryReturnedNoRows`, spelled as it prints — `errors.rs:963` uses the same \
             variant but only pins the `sqlite error: ` prefix, so it never had to spell \
             the rest out."
        );
        assert_eq!(
            after, "io error: sqlite error: Query returned no rows",
            "the documented deviation, in full: the `io error: ` prefix is what changed, \
             and the `sqlite error: ` sentence survives inside it"
        );

        // The `Json` arm is lossless (both sides spell it the same).
        let json = DbError::Json(
            serde_json::from_str::<i32>("not a number").expect_err("a parse failure"),
        );
        let mapped = StoreError::from(json);
        assert!(
            matches!(mapped, StoreError::Json(_)),
            "`Json` stays `Json` — got {mapped:?}"
        );
    }

    /// #96: `temp_db`'s dir must be OWNED. The green path already removed it
    /// (the `remove_dir_all` this replaces), so the GREEN half of this
    /// assertion proves nothing on its own — what it pins is that ownership
    /// survives a PANIC, which is the only path that leaked here.
    #[test]
    fn temp_db_removes_its_dir_when_its_owner_is_dropped() {
        let (dir, db) = temp_db();
        let captured = dir.to_path_buf();
        assert!(captured.is_dir(), "temp_db created the dir");
        drop((db, dir));
        assert!(
            !captured.exists(),
            "the dir goes with its owner — {captured:?}"
        );
    }

    /// The panic path, which is what this conversion actually buys: an
    /// assertion that FAILS while the fixture's dir is still owned must not
    /// leave the dir behind. The guard is moved INTO the panicking scope —
    /// that is the value the unwind drops (the `test_support` / `mcp/oauth.rs`
    /// precedent). What this does NOT pin is #96's headline case, a test that
    /// fails with its guard as a plain local so the HARNESS's own unwind would
    /// have to remove the dir; Rust makes no portable guarantee there and
    /// status doc D10 assigns that case to task 09's census.
    #[test]
    fn a_panicking_assertion_still_removes_the_temp_db_dir() {
        let captured = {
            let (dir, db) = temp_db();
            let path = dir.to_path_buf();
            assert!(path.is_dir(), "temp_db created the dir");
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let (_dir, _db) = (dir, db);
                assert_eq!(1, 2, "an assertion fails while the fixture owns its dir");
            }));
            assert!(r.is_err(), "the assertion failed as arranged");
            path
        };
        assert!(
            !captured.exists(),
            "the unwind ran the removal — {captured:?} is gone"
        );
    }
}
