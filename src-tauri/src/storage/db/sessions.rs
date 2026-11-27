//! The **session** subject of `db`: the `sessions` table's write verbs and its
//! reads (record/update/archive/title/order/recency/delete), lifted verbatim out
//! of the unit that was `storage/db.rs` when it was split by subject (ADR 0113).
//!
//! The `SessionRow` type and its `SESSION_COLUMNS` / `session_row_from` pair live
//! in [`super::rows`] — every read here interpolates that const and maps through
//! that mapper, which is what keeps the SELECT and the positional ladder one pair.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover.
// They moved here with the methods that hold them; the rule and the in-repo
// worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;

use fulcrum_harness::clock::now_ms;

use crate::types::SessionInfo;

use super::rows::{session_row_from, SESSION_COLUMNS};
use super::{Db, DbError, SessionRecency, SessionRow, LAST_ACTIVITY};

impl Db {
    /// Record (or refresh) a session.
    ///
    /// Upserts by session id: `created_at` and `title` are preserved on a
    /// re-record (e.g. a resume), while cwd / capabilities are refreshed.
    ///
    /// A NEW row joins the list at the BOTTOM (`MAX + 1`); the CONFLICT branch
    /// never renumbers — a resume re-runs `record_session`, and a row the user
    /// has positioned must not move when its session is resumed (ADR 0075).
    pub fn record_session(&self, info: &SessionInfo) -> Result<(), DbError> {
        let capabilities = serde_json::to_string(&info.capabilities)?;
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO sessions (id, cwd, created_at, title, capabilities_json, is_subagent, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT MAX(sort_order) FROM sessions), -1) + 1)
             ON CONFLICT(id) DO UPDATE SET
               cwd = excluded.cwd,
               capabilities_json = excluded.capabilities_json,
               is_subagent = excluded.is_subagent",
            params![
                info.session_id.to_string(),
                info.cwd.display().to_string(),
                now_ms(),
                Option::<String>::None,
                capabilities,
                info.is_subagent,
            ],
        )?;
        Ok(())
    }

    /// Update a session's persisted capabilities JSON envelope (e.g. after a mid-session model switch).
    ///
    /// Updates only `capabilities_json` for the given session id; `title`, `sort_order`,
    /// `cost_usd`, and `archived` remain untouched. A missing row is a no-op; returns `Ok(())`.
    pub fn update_session_capabilities(
        &self,
        id: &str,
        capabilities_json: &str,
    ) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET capabilities_json = ?2 WHERE id = ?1",
            params![id, capabilities_json],
        )?;
        Ok(())
    }

    /// Persist the session's last known context usage (the
    /// `context_usage_update` frame's values — the provider's
    /// `input_tokens` vs the model's window). Called on EVERY frame, so a
    /// CLOSED session's context survives: the frontend's store drops the
    /// entry on close, but the row keeps the last known value for the
    /// stored session's context bar. A SEPARATE statement — the
    /// `record_session` upsert's `DO UPDATE` never touches
    /// `context_usage_json`, so a re-record on resume can't clobber the
    /// persisted usage. A missing row is a no-op (the session is recorded
    /// before its first frame can land).
    pub fn record_session_context_usage(
        &self,
        id: &str,
        used: u64,
        window: u64,
    ) -> Result<(), DbError> {
        let payload = serde_json::to_string(&serde_json::json!({
            "used": used,
            "window": window,
        }))?;
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET context_usage_json = ?2 WHERE id = ?1",
            params![id.to_string(), payload],
        )?;
        Ok(())
    }

    /// Update a session's persisted todos JSON (ADR 0073).
    ///
    /// A missing session row is a no-op; returns `Ok(())`.
    pub fn record_session_todos(&self, id: &str, todos_json: Option<&str>) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET todos_json = ?2 WHERE id = ?1",
            params![id, todos_json],
        )?;
        Ok(())
    }

    /// Read a session's persisted todos JSON (`None` when missing or NULL).
    pub fn session_todos(&self, id: &str) -> Result<Option<String>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT todos_json FROM sessions WHERE id = ?1")?;
        let found = match stmt.query_row(params![id], |row| row.get::<_, Option<String>>(0)) {
            Ok(val) => val,
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        Ok(found)
    }

    /// Store the session's cost TOTAL in USD (issue #105; the snapshot contract
    /// is Fulcrum T2's amendment of ADR 0082's limit 7).
    ///
    /// A SNAPSHOT WRITE, and therefore IDEMPOTENT: `total` is the session's
    /// CUMULATIVE figure as the emitter computed it, and this overwrites the
    /// column with it. Re-delivering the same `cost_update` frame writes the
    /// same number and changes nothing — no dedupe, no identity, no
    /// read-modify-write. The superseded contract here was an INCREMENT
    /// (`stored.unwrap_or(0.0) + delta`), which doubled on a replay; ADR 0082
    /// recorded that doubling as **limit 7** — accepted, bounded, and pinned by
    /// `a_replayed_cost_frame_doubles_the_stored_figure`, whose own docblock and
    /// `persist.rs`'s module doc both said it "must be DELETED — not adjusted"
    /// if idempotency was ever added. T2 added idempotency by moving the total
    /// to the WIRE (every `cost_update` frame now carries the running total, so
    /// the frame that has no identity no longer needs one), so that pin is
    /// deleted in this same commit and `a_replayed_cost_frame_overwrites_to_the_same_figure`
    /// replaces it.
    ///
    /// Consequence of the move: the accumulator lives on the emitter
    /// (`AgentLoop::cost_acc`, seeded from this very column on `Resume` via
    /// `StartEnv.cost_usd`) and in the child capture (`subagent_flow.rs`, whose
    /// figure rides the outcome to the PARENT's loop and is folded into that
    /// loop's `cost_acc`). The emitter set is deliberately ONE PER STORE KEY:
    /// the third producer this column used to have — a parent-keyed roll-up
    /// frame written by the Supervisor — was deleted, because two writers on one
    /// snapshot key make the last frame win and the parent's accumulator had
    /// never seen the child, so the child's money was erased. See
    /// `AgentLoop::fold_child_cost`.
    ///
    /// A `None` column becomes a figure on the first write; a stored `0.0` came
    /// from a call that reported a genuine zero (D5 / ADR 0082). The two are
    /// still different values in the column — a snapshot never collapses
    /// absence into zero, because a frame that does not exist never reaches
    /// here at all.
    ///
    /// One statement, one lock. There is deliberately NO `SELECT` before the
    /// `UPDATE`: a snapshot needs nothing read, and the read-modify-write this
    /// replaced existed only to compute a sum.
    ///
    /// A missing session row is a silent no-op returning `Ok(())` (the same
    /// shape `record_session_todos` has, pinned there by
    /// `record_session_todos_roundtrips_and_clears` and here by
    /// `record_session_cost_on_a_missing_row_is_a_silent_no_op`). That silence
    /// is the reason the CALLER must ensure the row first — see Trap 1: a
    /// subagent's first `cost_update` can arrive before any `StoreFrame` has
    /// created its row, so `apply_interactive_event` calls `ensure_session_row`
    /// before reaching here. Do not "fix" this into an error.
    pub fn record_session_cost(&self, id: &str, total: f64) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET cost_usd = ?2 WHERE id = ?1",
            params![id, total],
        )?;
        // A missing row matches zero rows and `execute` reports `Ok(0)`, which
        // this discards — the silent no-op Trap 1 requires (see the doc above).
        Ok(())
    }

    /// Read a session's persisted running cost (`None` when no figure is
    /// stored).
    ///
    /// `None` covers TWO cases that are indistinguishable here — "no such row"
    /// and "a row that has never had a cost frame" — and callers do not need to
    /// tell them apart: both render nothing. A `Some(0.0)` is different from
    /// both: a call reported a genuine zero (D5 / ADR 0082).
    pub fn session_cost(&self, id: &str) -> Result<Option<f64>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT cost_usd FROM sessions WHERE id = ?1")?;
        let found = match stmt.query_row(params![id], |row| row.get::<_, Option<f64>>(0)) {
            Ok(val) => val,
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        Ok(found)
    }

    /// One stored session by id (`None` when absent) — the resume path
    /// reads the stored `capabilities_json` (the `loadSession` flag is the
    /// pre-check for a native resume).
    pub fn session(&self, id: &str) -> Result<Option<SessionRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM sessions WHERE id = ?1",
            SESSION_COLUMNS.join(", ")
        ))?;
        // The no-row case is matched EXPLICITLY (like `session_todos`) rather
        // than via `query_map(..).next().transpose()`: once the mapper can
        // error, a `query_map` chain makes "row present but failed to map"
        // INDISTINGUISHABLE from "no such row". `QueryReturnedNoRows` is the
        // only spelling of absence; any other error propagates.
        match stmt.query_row(params![id], session_row_from) {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// All stored sessions, in the user's manual order (`sort_order`), `id`
    /// descending breaking ties.
    ///
    /// Position is NOT evidence of recency: nothing but a drag (or the one-time
    /// upgrade seed) moves a row, so a session that was used a second ago sits
    /// exactly where its number says (ADR 0075,
    /// `docs/decisions/0075-list-position-is-not-evidence.md`). Recency is a
    /// FIELD, not a position — `LAST_ACTIVITY` is the single copy of that
    /// expression: the seed reads with it, and the row struct will `SELECT` it as
    /// `last_active_at`, so the number a row prints and the number any recency
    /// decision reads cannot drift.
    ///
    /// The subquery behind that expression rides `idx_messages_session` (the
    /// `(session_id, id)` index covers the lookup), and `list_sessions` runs once
    /// per boot and once per archive/delete, not per token — a desktop-sized
    /// history is not a performance question here.
    ///
    /// `include_archived = false` (the default) excludes archived rows — the
    /// sidebar's Space groups render stored sessions only; the boot fetches
    /// with `true` and splits client-side by the flag (ADR 0016). BOTH arms
    /// order identically, for the same reason they filter identically: one
    /// shared `ORDER BY`, so the Archived section cannot drift.
    pub fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        // BOTH arms interpolate the SAME const list (they used to spell it
        // twice) and share ONE mapper, so the projected columns cannot differ
        // between the archived and un-archived read. The WHERE/ORDER arms stay
        // exactly as spelled today.
        let sql = if include_archived {
            format!(
                "SELECT {} FROM sessions
                 WHERE is_subagent = 0
                 ORDER BY sort_order ASC, id DESC",
                SESSION_COLUMNS.join(", ")
            )
        } else {
            format!(
                "SELECT {} FROM sessions
                 WHERE archived = 0 AND is_subagent = 0
                 ORDER BY sort_order ASC, id DESC",
                SESSION_COLUMNS.join(", ")
            )
        };
        let mut stmt = guard.prepare(&sql)?;
        let rows = stmt
            .query_map([], session_row_from)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every non-subagent session's recency, as an explicit FIELD (ADR 0075 —
    /// position is not evidence, so anything that wants recency has to ask for it).
    ///
    /// The SQL is the SAME `LAST_ACTIVITY` const the upgrade seed
    /// (`seed_session_sort_order`) reads with, interpolated here with `format!`
    /// the way that seed builds its statement — so the number a row prints and
    /// the number a recency decision reads cannot drift: one copy of the
    /// expression exists, and it is that const.
    ///
    /// The filter is `is_subagent = 0` with NO `archived` filter, matching
    /// `list_sessions(true)` exactly. That equality is the contract: the recency
    /// map's key set equals the boot session list's key set, so a consumer can
    /// never meet a session with no recency entry, nor a recency entry with no
    /// session.
    ///
    /// `ORDER BY id` is arbitrary but STABLE: consumers key by id, so the order
    /// is not a contract — it is pinned only so the returned `Vec` is
    /// deterministic (a `Vec` with no `ORDER BY` is a nondeterministic fixture).
    /// `id` is the primary key, so the sort is free.
    ///
    /// The row's own order column travels with the stamp (see
    /// `SessionRecency::sort_order`), so ONE frontend sequence can span live and
    /// stored rows off this ONE read. No constant wraps that column name: it is
    /// a plain column, not a shared expression, and inventing one would imply a
    /// drift risk that does not exist.
    pub fn session_recency(&self) -> Result<Vec<SessionRecency>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT id, {LAST_ACTIVITY}, sort_order FROM sessions WHERE is_subagent = 0 ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SessionRecency {
                    session_id: row.get(0)?,
                    last_active_at: row.get(1)?,
                    sort_order: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Set (or clear) a session's archived flag (ADR 0016): the transcript
    /// is NOT touched — only the flag on the `sessions` row.
    ///
    /// Returns `true` when a row matched, `false` when nothing matched (a
    /// missing row is a no-op, not an error — mirroring `set_space_trusted`).
    ///
    /// TWO things this verb does not do, and a reader of the flag needs both:
    ///
    ///   * it does not touch a CHILD's transcript. Archiving a Session trims the
    ///     display transcript (to its newest row) and the whole native transcript
    ///     of each Subagent session it owns; that is the CALLER's step, through
    ///     the per-parent verb in [`super::retention`] — see
    ///     `commands/history.rs`'s `set_session_archived_core`;
    ///   * it has NO liveness condition. This is an id-only `UPDATE`, which is
    ///     exactly right for the flag and completely useless as a guard: nothing
    ///     in the `sessions` table records whether a Session is running, so
    ///     deciding "closed" belongs to the caller, and the caller can see it
    ///     while this layer cannot.
    pub fn set_session_archived(&self, id: &str, archived: bool) -> Result<bool, DbError> {
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET archived = ?2 WHERE id = ?1",
            params![id, archived],
        )?;
        Ok(n > 0)
    }

    /// Set, answer, or CLEAR a Session's readiness claim, and the EDGE NAME that
    /// claim chose — the ONE write verb for `sessions.ready` and
    /// `sessions.advance_outcome`, the two columns a `mark_done` claim lives in.
    ///
    /// ONE STATEMENT FOR BOTH COLUMNS, and that is the shape rather than a tidiness
    /// preference. The two are ONE fact — "this Session claims it is done, and this is
    /// the transition it claims" — and two statements would let a crash, or a
    /// concurrent turn-start clear, land between them and leave a claim naming an edge
    /// it never named, or an edge name on a claim that was withdrawn. `set_stage_next`
    /// writes `next_slugs` and `next_outcomes` the same way for the same reason:
    /// paired data in two statements is paired data that can disagree, permanently.
    /// The caller passes both because the caller is the one door that holds both.
    ///
    /// THREE states for the flag, which is why the parameter is `Option<bool>` and the
    /// bind is `Option<i64>` (`None` → `NULL`), and why a `bool` would have been wrong:
    /// `Some(true)` writes `1` ("this Session is done, come look"), `Some(false)`
    /// writes `0` ("it was checked and it is NOT ready"), and `None` writes `NULL`
    /// ("this row's column has NEVER been written"). Collapsing `NULL` into `0`
    /// would put a verdict on every Session nobody re-checked, which is ADR 0082's
    /// phantom-`$0.00` discipline with a flag in place of a cost; the gate's
    /// `the_ready_gate_arrives_null_for_every_pre_existing_session` pin and the
    /// column's missing `DEFAULT` are what keep the third state real.
    ///
    /// `outcome` has NO three-state discipline of its own and takes the flag's: it is
    /// written on the SAME row as the flag and by the SAME statement, so `NULL` means
    /// "this claim named no edge" — the ordinary case on an unlabelled board, resolving
    /// to the head edge — and it is never read except beside a `ready` that says a claim
    /// exists. A turn-start clear therefore passes `None` and wipes a previous turn's
    /// name along with its `0`: a name is this turn's answer, and a second turn that
    /// marks done without naming an edge must take the head edge and not inherit one.
    ///
    /// WHAT A TURN START WRITES, because the obvious story about `NULL` is false. A
    /// new turn does NOT reset a claim to `NULL` — `send_prompt_with_images` writes
    /// `Some(false)`, a `0`, and it does so UNCONDITIONALLY on every turn start. So
    /// `0` is the dominant value for any Session that has ever run a turn, a
    /// claim-then-worked Session and a never-claimed one land on the SAME `0`, and
    /// `0` is therefore NOT evidence that a claim was ever made — this write
    /// destroys that distinction rather than preserving it. Nothing consumes the
    /// difference anyway: the board read, this column's only reader, folds the
    /// tri-state to a `bool` with `Some(1)` as its sole truthy value, so `NULL` and
    /// `0` are the same `false` to every consumer. `None` stays reachable at this
    /// layer (a hand-written row can hold it and this verb will write it); no
    /// production caller does.
    ///
    /// Returns `true` when a row matched, `false` when nothing matched (a missing
    /// row is a no-op, not an error — mirroring `set_session_archived`).
    ///
    /// THREE things this verb does not do, and a caller of the flag needs all three:
    ///
    ///   * it does not refresh anything. It writes two columns on one row; pushing
    ///     the new state to a client, re-listing, or recomputing a badge is the
    ///     CALLER's step, exactly as `set_session_archived` leaves the transcript
    ///     trim to `commands/history.rs`;
    ///   * it emits NO event. There is no notification on the other side of this
    ///     write — a caller that wants the UI to see the change has to send it;
    ///   * it has NO liveness condition. This is an id-only `UPDATE`, which is
    ///     exactly right for a flag and completely useless as a guard: nothing in
    ///     the `sessions` table records whether a Session is running, so deciding
    ///     whether a Session is live — and therefore whether it MAY claim
    ///     readiness — belongs to the caller, which can see it while this layer
    ///     cannot.
    pub fn set_session_ready(
        &self,
        id: &str,
        ready: Option<bool>,
        outcome: Option<&str>,
    ) -> Result<bool, DbError> {
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET ready = ?2, advance_outcome = ?3 WHERE id = ?1",
            params![
                id,
                ready.map(|is_ready| if is_ready { 1_i64 } else { 0 }),
                outcome
            ],
        )?;
        Ok(n > 0)
    }

    /// Rewrite the manual order of the given session ids in ONE transaction:
    /// the slice index becomes `sort_order` (ADR 0075 — only a drag calls this).
    ///
    /// Keyed by the stored id RAW, as `session`/`set_session_archived` are: the
    /// ids come from a `list_sessions()` result and are already the stored key.
    /// An id that matches no row is a no-op.
    ///
    /// The slice is the sidebar's VISIBLE list of ONE Space, but the numbering is
    /// GLOBAL, so this renumbers hidden `is_subagent = 1` rows too whenever the
    /// caller hands one back (hazard H1: a hidden row consumes a number) and
    /// leaves every other Space's rows on their old numbers — which therefore
    /// COLLIDE with the freshly written ones. That is the intended steady state,
    /// not corruption: `ORDER BY sort_order ASC, id DESC` is total, so reads stay
    /// deterministic, and display is per-Space, so no surface ever renders two
    /// Spaces' rows side by side by `sort_order` alone. Renumbering the untouched
    /// rows to keep the column globally unique would move rows the user did not
    /// drag, in Spaces they are not looking at.
    pub fn reorder_sessions(&self, ids: &[String]) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
                params![id, index as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Set a session's title and transition its `title_stage` atomically, conditional
    /// on its current stage matching `from_stage`.
    ///
    /// Returns `true` when a row was updated, `false` when the row is missing or
    /// currently at a different stage.
    pub fn set_session_title_stage(
        &self,
        id: &str,
        title: &str,
        from_stage: i64,
        to_stage: i64,
    ) -> Result<bool, DbError> {
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET title = ?2, title_stage = ?4 WHERE id = ?1 AND title_stage = ?3",
            params![id, title, from_stage, to_stage],
        )?;
        Ok(n > 0)
    }

    /// Set a session's initial title (transitioning from stage 0 to stage 1).
    ///
    /// Conditional on `title_stage == 0`: returns `true` when updated, or `false`
    /// if the session is already at a later stage or missing. Delegates to
    /// `set_session_title_stage(id, title, 0, 1)` for backwards compatibility.
    pub fn set_session_title(&self, id: &str, title: &str) -> Result<bool, DbError> {
        self.set_session_title_stage(id, title, 0, 1)
    }

    /// Delete a session; its `messages` AND `native_messages` rows are
    /// removed (both tables are `ON DELETE CASCADE`; the explicit
    /// `native_messages` `DELETE` is belt-and-suspenders — it also
    /// covers a pre-migration database that never gained the FK).
    ///
    /// What the CASCADE does NOT reach is the reason a caller must do more than
    /// call this: `parent_session_id` carries no foreign key by decision, so a
    /// Subagent CHILD's row survives its parent — and the cascade destroys the
    /// parent's rows, i.e. the rows that named those children, while their own
    /// transcripts stay exactly as large as they were. In the measured database
    /// 1,325 of 2,643 children are already orphaned that way. Trimming them is
    /// the CALLER's step, through the per-parent verb in [`super::retention`],
    /// and it runs BEFORE this call — see `commands/history.rs`'s
    /// `delete_session_core`.
    pub fn delete_session(&self, session_id: &str) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        tx.execute(
            "DELETE FROM native_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
        tx.commit()?;
        Ok(())
    }
}
