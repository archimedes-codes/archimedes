//! The **crate seams** of `db`: `impl FulcrumPersistence for Db`,
//! `impl TaskStore for Db`, and the two small key/mapping helpers they run
//! through, lifted verbatim out of the unit that was `storage/db.rs` (ADR 0113).
//!
//! Both impls are delegation only — no SQL and no error policy is re-spelled
//! here — and they are the instantiation that makes the crate trait's SHAPE the
//! proof rather than the argument. `src-tauri/tests/fulcrum_seams.rs` records the
//! deletion that reddens each one.

use fulcrum_harness::clock::now_ms;
use fulcrum_harness::seams::{
    Artifact as CrateArtifact, ArtifactMeta as CrateArtifactMeta, BoardRow, FulcrumPersistence,
    MoveOutcome as CrateMoveOutcome, StoreError, TaskDetail, TaskRow as CrateTaskRow, TaskStore,
    TaskStoreError,
};

use crate::types::SessionInfo;

use super::rows::TaskRow;
use super::{Db, FieldPatch, MessageRow, SessionRow};

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

// ── The crate's Task-board seam (ADR 0092, issue #180 D2) ────────────────────
//
// The SYNC crate seam implemented SUPERVISOR-side, beside the persistence seam
// above and for the same reason: the Worker has no `Db` and cannot have one —
// ADR 0025 makes this process the sole SQLite writer, so a model's board verb has
// to be answered here and shipped back over the wire (`Outbound::TaskRequest` →
// `Inbound::TaskResponse`, routed in `agent/session/router.rs`).
//
// Every method delegates to the INHERENT `Db` method with the same qualified-call
// rule `FulcrumPersistence` uses — Rust prefers inherent methods, so
// `Db::method(self, …)` reaches the SQL and cannot recurse into the trait being
// defined — and every error crosses through the two `From` impls above
// (`DbError → TaskStoreError`, `BoardError → TaskStoreError`) rather than a
// per-method `map_err`, which is the same "one place owns the mapping" split the
// `StoreError` map documents.
//
// THE DTO MAPPING is the substance of this block, and four facts about it are
// worth stating because they are where a careless impl would go quietly wrong:
//
//   * `number` is `i64` on the desktop's `TaskRow` and `u32` on the crate's DTOs.
//     `number` is `MAX(number) + 1` per Space (ADR 0090), so it is positive and
//     small by construction; the `as u32` is a widening-free narrowing of a value
//     this file hands out itself. A Space with four billion cards would wrap, and
//     no board renders that — the cast is stated here rather than left to a reader
//     to invent a justification for.
//   * `artifact_keys` is REQUIRED on `BoardRow` and `TaskDetail` (never `Option`),
//     so it is filled from `artifact_keys` per row. That is one extra statement per
//     card on `list_board`; the aggregate `artifact_keys_for_space` exists for the
//     board's OWN read (`get_board`) and is not used here because the trait returns
//     rows already filtered by the caller's verb, and re-deriving that filter here
//     would be a second owner of "which cards belong to this Space".
//   * The crate's `TaskRow` (the write answer) carries NO `artifact_keys` field — a
//     write touched no artifact, so its answer says nothing about them. The desktop
//     `TaskRow` has no such field either, so `create_task` / `edit_task` map
//     field-for-field.
//   * `MoveOutcome` is where the two types genuinely differ: the crate's has
//     `to_stage` / `on_enter: Option` / `note: Option`, the desktop's has only
//     `on_enter: String`. `to_stage` is the caller's own argument (the desktop's
//     `move_task` refuses before it writes, so a successful move always lands where
//     it was told), `on_enter` becomes `Some` of the desktop's value, and `note` is
//     `None` because the desktop's `move_task` returns no note today — the boost
//     warning it would describe is computed in the COMMAND layer
//     (`commands/tasks.rs`'s `boost_note`), one layer above this seam and invisible
//     to it. Reporting it here would mean reaching past the storage layer for a
//     fact storage does not hold.
impl TaskStore for Db {
    fn list_board(&self, space_path: &str) -> Result<Vec<BoardRow>, TaskStoreError> {
        Db::list_tasks(self, space_path)?
            .into_iter()
            .map(|row| {
                let id = row.id.clone();
                Ok(BoardRow {
                    id: row.id,
                    space_path: row.space_path,
                    number: row.number as u32,
                    title: row.title,
                    body: row.body,
                    spec_path: row.spec_path,
                    stage_slug: row.stage_slug,
                    sort_order: row.sort_order,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    artifact_keys: Db::artifact_keys(self, &id)?,
                })
            })
            .collect()
    }

    fn get_task(&self, task_id: &str) -> Result<Option<TaskDetail>, TaskStoreError> {
        // The desktop's read already answers `Ok(None)` for an absent card, which is
        // the crate's contract too ("asking for what is not there is an answer").
        Db::get_task(self, task_id)?
            .map(|row| {
                let id = row.id.clone();
                Ok(TaskDetail {
                    id: row.id,
                    space_path: row.space_path,
                    number: row.number as u32,
                    title: row.title,
                    body: row.body,
                    spec_path: row.spec_path,
                    stage_slug: row.stage_slug,
                    sort_order: row.sort_order,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    artifact_keys: Db::artifact_keys(self, &id)?,
                })
            })
            .transpose()
    }

    fn create_task(
        &self,
        space_path: &str,
        title: &str,
        body: Option<&str>,
        stage_slug: Option<&str>,
    ) -> Result<CrateTaskRow, TaskStoreError> {
        let row = Db::create_task(self, space_path, title, body, stage_slug)?;
        Ok(desktop_row_to_crate_row(row))
    }

    fn edit_task(
        &self,
        task_id: &str,
        title: Option<&str>,
        body: Option<&str>,
        spec_path: Option<&str>,
    ) -> Result<CrateTaskRow, TaskStoreError> {
        // The published seam is TWO-state: `Option<&str>` with `None` = leave that field
        // alone, and the published crate's `TaskCall` is that shape — this crate consumes
        // it as a registry pin — so there is no value the model can send that reaches
        // `FieldPatch::Clear`. A model's `edit_task` therefore still clears nothing.
        // Deliberate and deferred: ADR 0102 / issue #183 move this verb desktop-side over
        // a vocabulary-free `HostToolCall`, which makes the third state reachable from the
        // tool too. See docs/research/edit-task-cannot-clear-a-field.md.
        let row = Db::edit_task(
            self,
            task_id,
            title.map_or(FieldPatch::Keep, FieldPatch::Set),
            body.map_or(FieldPatch::Keep, FieldPatch::Set),
            spec_path.map_or(FieldPatch::Keep, FieldPatch::Set),
        )?;
        Ok(desktop_row_to_crate_row(row))
    }

    fn move_task(
        &self,
        space_path: &str,
        task_id: &str,
        to_stage: &str,
    ) -> Result<CrateMoveOutcome, TaskStoreError> {
        let out = Db::move_task(self, space_path, task_id, to_stage)?;
        Ok(CrateMoveOutcome {
            to_stage: to_stage.to_string(),
            on_enter: Some(out.on_enter),
            note: None,
        })
    }

    fn get_artifact(
        &self,
        task_id: &str,
        key: &str,
    ) -> Result<Option<CrateArtifact>, TaskStoreError> {
        // Field-for-field: T4's `Artifact` was shaped to the crate's DTO on purpose
        // (the five names are identical), so this maps nothing and renames nothing.
        Ok(
            Db::get_artifact(self, task_id, key)?.map(|a| CrateArtifact {
                task_id: a.task_id,
                key: a.key,
                markdown: a.markdown,
                created_at: a.created_at,
                updated_at: a.updated_at,
            }),
        )
    }

    fn write_artifact(
        &self,
        task_id: &str,
        key: &str,
        markdown: &str,
    ) -> Result<CrateArtifactMeta, TaskStoreError> {
        let meta = Db::write_artifact(self, task_id, key, markdown)?;
        Ok(CrateArtifactMeta {
            key: meta.key,
            updated_at: meta.updated_at,
            bytes: meta.bytes,
        })
    }
}

/// The desktop's `TaskRow` → the crate's write-answer `TaskRow`.
///
/// The ONE place that mapping is spelled, shared by `create_task` and
/// `edit_task` — the two verbs whose answer is the row WITHOUT artifact keys.
/// A helper rather than an inline literal twice, so a field added to either
/// struct breaks ONE site and the break names the mapping.
fn desktop_row_to_crate_row(row: TaskRow) -> CrateTaskRow {
    CrateTaskRow {
        id: row.id,
        space_path: row.space_path,
        number: row.number as u32,
        title: row.title,
        body: row.body,
        spec_path: row.spec_path,
        stage_slug: row.stage_slug,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
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
