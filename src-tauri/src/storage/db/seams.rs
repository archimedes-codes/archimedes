//! The **crate seams** of `db`: the one `impl` of a crate trait this type carries,
//! plus the one key helper its sibling subjects run through, lifted verbatim out of
//! the unit that was `storage/db.rs` (ADR 0113).
//!
//! The impl is delegation only — no SQL and no error policy is re-spelled here — and
//! it is the instantiation that makes the crate trait's SHAPE the proof rather than
//! the argument. `src-tauri/tests/fulcrum_seams.rs` records the deletion that reddens
//! it.
//!
//! # There used to be a second impl here, and what its deletion moved
//!
//! `impl TaskStore for Db` (ADR 0092, issue #180 D2) lived in this file until
//! ADR 0102 / issue #183 F3 deleted the trait from the crate — the crate no longer
//! knows Tasks exist. Its 110 code lines did not vanish, they MOVED, and where each
//! half landed is worth naming because the pieces have different owners now:
//!
//!   * **the seven verbs' bodies** → `agent/host_tools/exec.rs`, which runs the
//!     INHERENT `Db` methods and maps to the wire DTOs explicitly;
//!   * **the DTO mapping** (the `number: i64 → u32` narrowing, the `artifact_keys`
//!     enrichment, the three-field move outcome) → also `exec.rs`, per-verb, because
//!     that is the shape the lossy-twin rule needs spelled at the call site;
//!   * **the DTOs themselves** → `storage::db::rows` as `BoardRow` / `TaskDetail` /
//!     `MoveToolOutcome`, the desktop's own wire vocabulary;
//!   * **the error family** (`NotFound` / `Invalid` / `Io`, and the `BoardError` →
//!     model-facing-sentence map) → [`super::HostToolError`] with its two `From` impls
//!     still in `super`, where they already were;
//!   * **`desktop_row_to_crate_row`** → DELETED, not moved. It existed to cross a
//!     type boundary that no longer exists: the two write verbs now answer with the
//!     storage `TaskRow` directly, which is field-for-field what they always sent.
//!
//! [`space_key`] is NOT part of that move and survives untouched — it was never a
//! trait item, it just happened to live here. Six subjects outside this file call it.

use fulcrum_harness::clock::now_ms;
use fulcrum_harness::seams::{FulcrumPersistence, StoreError};

use crate::types::SessionInfo;

use super::{Db, MessageRow, SessionRow};

// ── T5/S4 — the crate's persistence seam, implemented (plan Steps B + B-bis) ──
//
// THE INSTANTIATION THAT IS S4'S GATE. The S4 ruling is explicit that a
// surface-comparison test which never builds this impl is void, so this block —
// not any test — is the proof that the trait's SHAPE is right: every method below
// must type-check against the INHERENT method it delegates to, with the real
// argument and return types. `src-tauri/tests/fulcrum_seams.rs` then makes that
// proof observable and records the deletion that reddens it.
//
// Every body is one delegation plus the `DbError → StoreError` map. No SQL and no
// error-handling policy is re-implemented here — the transaction boundaries, the
// `QueryReturnedNoRows` arms and the deliberate silent no-ops all stay in the
// inherent methods above — which is what makes the seam behaviour-identical by
// construction rather than by argument.
//
// Method resolution: the trait signatures are deliberately IDENTICAL to the
// inherent ones, and Rust prefers inherent methods, so the qualified calls below
// reach the SQLite code and cannot recurse into the trait. They are written
// `Db::method(self, …)` rather than `self.method(…)` so that stays true even if a
// future edit renames a trait method and shadows nothing.
impl FulcrumPersistence for Db {
    fn insert_native_message(
        &self,
        session_id: &str,
        seq: i64,
        role: &str,
        content_json: &str,
    ) -> Result<(), StoreError> {
        Db::insert_native_message(self, session_id, seq, role, content_json)?;
        Ok(())
    }

    fn replace_native_messages(
        &self,
        session_id: &str,
        rows: &[(i64, String, String)],
    ) -> Result<(), StoreError> {
        Db::replace_native_messages(self, session_id, rows)?;
        Ok(())
    }

    fn record_session_context_usage(
        &self,
        session_id: &str,
        used: u64,
        window: u64,
    ) -> Result<(), StoreError> {
        Db::record_session_context_usage(self, session_id, used, window)?;
        Ok(())
    }

    fn record_session_cost(&self, session_id: &str, total: f64) -> Result<(), StoreError> {
        Db::record_session_cost(self, session_id, total)?;
        Ok(())
    }

    fn record_session_todos(
        &self,
        session_id: &str,
        todos: Option<&str>,
    ) -> Result<(), StoreError> {
        Db::record_session_todos(self, session_id, todos)?;
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Option<SessionRow>, StoreError> {
        Ok(Db::session(self, session_id)?)
    }

    fn load_native_messages(&self, session_id: &str) -> Result<Vec<String>, StoreError> {
        Ok(Db::load_native_messages(self, session_id)?)
    }

    fn messages_for(&self, session_id: &str) -> Result<Vec<MessageRow>, StoreError> {
        Ok(Db::messages_for(self, session_id)?)
    }

    fn session_cost(&self, session_id: &str) -> Result<Option<f64>, StoreError> {
        Ok(Db::session_cost(self, session_id)?)
    }

    fn session_todos(&self, session_id: &str) -> Result<Option<String>, StoreError> {
        Ok(Db::session_todos(self, session_id)?)
    }

    fn record_session(&self, info: &SessionInfo) -> Result<(), StoreError> {
        Db::record_session(self, info)?;
        Ok(())
    }

    fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionRow>, StoreError> {
        Ok(Db::list_sessions(self, include_archived)?)
    }

    fn set_space_trusted(&self, path: &str, trusted: bool) -> Result<bool, StoreError> {
        Ok(Db::set_space_trusted(self, path, trusted)?)
    }

    fn upsert_space(&self, path: &str, default_trusted: bool) -> Result<(), StoreError> {
        Db::upsert_space(self, path, default_trusted)?;
        Ok(())
    }

    fn record_message(
        &self,
        session_id: &str,
        kind: &str,
        message_key: Option<&str>,
        payload_json: &str,
    ) -> Result<(), StoreError> {
        Db::record_message(self, session_id, kind, message_key, payload_json)?;
        Ok(())
    }

    /// The clock, delegating to the ONE definition (see the `now_ms` import
    /// above). The trait method exists so a crate caller holding
    /// `Arc<dyn FulcrumPersistence>` reaches the shared clock instead of minting
    /// its own; a `Db` carries no time of its own to read.
    fn now_ms(&self) -> i64 {
        now_ms()
    }
}

/// The single key form of a `spaces` row (ADR 0010): the canonical path.
/// `None` when the path can't be canonicalized (the folder is missing, or
/// the filesystem changed) — the write path falls back to the raw string
/// (best-effort), the read path fails closed.
pub(super) fn space_key(path: impl AsRef<std::path::Path>) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|c| c.display().to_string())
}
