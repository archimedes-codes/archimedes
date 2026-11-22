//! The **message** subject of `db`: the `messages` transcript verbs and the
//! `native_messages` display-transcript verbs, lifted verbatim out of the unit
//! that was `storage/db.rs` (ADR 0113).
//!
//! The batched write (`record_messages_batch`) is AGENTS.md's cited in-repo
//! example of a correct panic-on-poison site; it moved with its rationale intact.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover.
// They moved here with the methods that hold them; the rule and the in-repo
// worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;

use fulcrum_harness::clock::now_ms;

use super::rows::{message_row_from, MESSAGE_COLUMNS};
use super::{Db, DbError, MessageRow};

impl Db {
    /// Insert or update a message.
    ///
    /// `INSERT ... ON CONFLICT(session_id, kind, message_key) DO UPDATE` —
    /// the same `(session_id, kind, message_key)` triple always collapses to
    /// one row, so re-sent or replayed updates never duplicate.
    pub fn record_message(
        &self,
        session_id: &str,
        kind: &str,
        message_key: Option<&str>,
        payload_json: &str,
    ) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, kind, message_key) DO UPDATE SET
               payload_json = excluded.payload_json,
               created_at = excluded.created_at",
            params![session_id, kind, message_key, payload_json, now_ms()],
        )?;
        Ok(())
    }

    /// Insert or update MANY messages in ONE transaction — one commit for the
    /// whole batch (#155).
    ///
    /// The batch path exists because `record_message` takes the mutex and runs
    /// one statement in autocommit, so it commits per call. A caller that
    /// buffers streamed frames and then flushes them by calling
    /// `record_message` per key therefore pays one commit per key — which under
    /// the old rollback-journal default was 14–17 ms of `fdatasync` per frame,
    /// and even under WAL is a durability round-trip per frame. One transaction
    /// makes the whole flush a single commit.
    ///
    /// Same statement and same upsert semantics as [`Self::record_message`]
    /// (a repeated `(session_id, kind, message_key)` collapses to one row
    /// holding the LAST payload — the accumulated-text case in the module
    /// docs), and the same one-transaction-many-rows shape as
    /// [`Self::replace_native_messages`]: one `transaction()`, one `execute`
    /// per row, one `commit()`. A failure on any row rolls the whole batch
    /// back, so a flush is all-or-nothing — never a half-written transcript.
    ///
    /// `created_at` is stamped ONCE for the batch: the frames were flushed
    /// together, and transcript order is `id` (`messages_for` orders by it),
    /// never this column — so a per-row clock read would buy nothing but a
    /// syscall per row.
    ///
    /// `record_message` stays public and unchanged: `SessionStore`
    /// (`agent/harness/store.rs`) is built on it and is not this task's scope.
    ///
    /// PANICS ON A POISONED MUTEX, and that is the correct call here rather than
    /// the recover that `batching.rs`'s per-session map does: this lock guards
    /// `Db`'s ONE shared `rusqlite::Connection`, so a panic mid-transaction can
    /// leave that single connection unusable, and recovering would hand the next
    /// caller a connection of unknown state (an open transaction, or a rolled-back
    /// batch it believes landed). AGENTS.md's poisoned-mutex rule — recover when
    /// the lock guards independent per-key state, panic when it guards one shared
    /// resource — and this is the file's own sites, now arguing for itself instead
    /// of merely asserting. NO COUNT IS QUOTED HERE, deliberately: an earlier
    /// revision of this sentence named how many sites there were, named the wrong
    /// number, and had to be corrected in the very next commit. A count in a comment
    /// rots while the rule it illustrates does not.
    pub fn record_messages_batch(
        &self,
        rows: &[(&str, &str, Option<&str>, &str)],
    ) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        let now = now_ms();
        for (session_id, kind, message_key, payload_json) in rows {
            tx.execute(
                "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(session_id, kind, message_key) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   created_at = excluded.created_at",
                params![session_id, kind, message_key, payload_json, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// A session's messages in insertion order (the transcript order).
    pub fn messages_for(&self, session_id: &str) -> Result<Vec<MessageRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM messages
             WHERE session_id = ?1
             ORDER BY id",
            MESSAGE_COLUMNS.join(", ")
        ))?;
        let rows = stmt
            .query_map(params![session_id], message_row_from)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// A page of a session's messages, newest-first by id up to `limit`
    /// rows, returned in ascending transcript order, with `has_more`
    /// indicating whether older messages exist (ADR 0073).
    ///
    /// When `limit` is `None`, all messages (prior to `before_id`, if specified)
    /// are returned in insertion order and `has_more` is `false`.
    pub fn messages_page(
        &self,
        session_id: &str,
        before_id: Option<i64>,
        limit: Option<u32>,
    ) -> Result<(Vec<MessageRow>, bool), DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        if let Some(n) = limit {
            let limit_probe = (n as i64) + 1;
            let mut stmt = guard.prepare(&format!(
                "SELECT {} FROM messages
                 WHERE session_id = ?1 AND id < COALESCE(?2, 9223372036854775807)
                 ORDER BY id DESC
                 LIMIT ?3",
                MESSAGE_COLUMNS.join(", ")
            ))?;
            let mut rows = stmt
                .query_map(
                    params![session_id, before_id, limit_probe],
                    message_row_from,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            let has_more = rows.len() > n as usize;
            if has_more {
                rows.truncate(n as usize);
            }
            rows.reverse();
            Ok((rows, has_more))
        } else {
            let mut stmt = guard.prepare(&format!(
                "SELECT {} FROM messages
                 WHERE session_id = ?1 AND id < COALESCE(?2, 9223372036854775807)
                 ORDER BY id",
                MESSAGE_COLUMNS.join(", ")
            ))?;
            let rows = stmt
                .query_map(params![session_id, before_id], message_row_from)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((rows, false))
        }
    }

    /// Insert or refresh one native transcript message (the native
    /// `AgentLoop`'s provider transcript — native-agent-harness Task 6).
    ///
    /// `INSERT ... ON CONFLICT(session_id, seq) DO UPDATE` — the same
    /// `(session_id, seq)` always collapses to one row (idempotent). The
    /// `role` column is a DENORMALIZED index for cheap queries; the
    /// content is the serialized full `ChatMessage` (`content_json` —
    /// role + content + `tool_calls` + `tool_call_id` round-trip).
    pub fn insert_native_message(
        &self,
        session_id: &str,
        seq: i64,
        role: &str,
        content_json: &str,
    ) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO native_messages (session_id, seq, role, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, seq) DO UPDATE SET
               content_json = excluded.content_json,
               created_at = excluded.created_at",
            params![session_id, seq, role, content_json, now_ms()],
        )?;
        Ok(())
    }

    /// A session's native transcript in `seq` order (the provider
    /// transcript — the `content_json` rows; the `role` column is a
    /// denormalized index and is NOT read here). A malformed row is a
    /// `Json` error (a corrupt transcript must not silently load as an
    /// empty one).
    pub fn load_native_messages(&self, session_id: &str) -> Result<Vec<String>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT content_json FROM native_messages WHERE session_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt
            .query_map(params![session_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Delete a session's native transcript (`native_messages` ONLY —
    /// the display `messages` table is NOT touched: the native resume
    /// path must NOT clear before `load_messages`).
    pub fn clear_native_messages(&self, session_id: &str) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "DELETE FROM native_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// Replace a session's native transcript ATOMICALLY: delete all its
    /// rows, then insert the new ones — in a SINGLE transaction (the
    /// `run_compaction` rewrite: a crash mid-rewrite must never leave an
    /// empty / partial transcript). The same `(session_id, seq)` upsert
    /// semantics as [`insert_native_message`] apply to each row.
    pub fn replace_native_messages(
        &self,
        session_id: &str,
        rows: &[(i64, String, String)],
    ) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        tx.execute(
            "DELETE FROM native_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        for (seq, role, content_json) in rows {
            tx.execute(
                "INSERT INTO native_messages (session_id, seq, role, content_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(session_id, seq) DO UPDATE SET
                   content_json = excluded.content_json,
                   created_at = excluded.created_at",
                params![session_id, *seq, *role, *content_json, now_ms()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
