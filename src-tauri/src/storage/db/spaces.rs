//! The **space** subject of `db`: the `spaces` table's trust and ordering verbs,
//! lifted verbatim out of the unit that was `storage/db.rs` (ADR 0113).
//!
//! Every verb keys through [`super::seams::space_key`] — the ONE key form of a
//! `spaces` row (ADR 0010) — so a write and a read cannot disagree on what a
//! Space's canonical path is.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover.
// They moved here with the methods that hold them; the rule and the in-repo
// worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;

use fulcrum_harness::clock::now_ms;

use super::rows::{space_row_from, SPACE_COLUMNS};
use super::seams::space_key;
use super::{Db, DbError, SpaceRow};

impl Db {
    /// Insert or touch the bookkeeping row for a folder.
    ///
    /// Keyed by the canonical path (the single key form, ADR 0010) — the
    /// input is canonicalized here, falling back to the raw string when the
    /// folder no longer exists (a best-effort write; reads stay
    /// fail-closed). `created_at` is preserved on conflict; `last_opened_at`
    /// is always refreshed (an actual start/resume is a real "open"). No folder
    /// validation happens here — whether the folder exists is the caller's
    /// problem (the canonicalizing gate is in `start_session`/`space_for_path`).
    ///
    /// A NEW row joins the list at the BOTTOM (`MAX + 1`); the CONFLICT branch
    /// never renumbers, so a re-touch refreshes recency and leaves the row
    /// exactly where the user put it (ADR 0075 — only a drag moves a row).
    ///
    /// `default_trusted` is written ONLY on INSERT (a NEW row is born
    /// `trusted` per the flag — the settings' `default_trust_new_spaces`);
    /// the CONFLICT branch never touches `trusted` (an existing row's flag
    /// is never changed by a re-upsert — no retroactive trust).
    pub fn upsert_space(&self, path: &str, default_trusted: bool) -> Result<(), DbError> {
        let key = space_key(path).unwrap_or_else(|| path.to_string());
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO spaces (path, created_at, last_opened_at, trusted, sort_order) \
             VALUES (?1, ?2, ?2, ?3, COALESCE((SELECT MAX(sort_order) FROM spaces), -1) + 1)
                 ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at",
            params![key, now_ms(), default_trusted],
        )?;
        Ok(())
    }

    /// Set (or clear) a space's trust flag, keyed by the canonical path
    /// (raw fallback on canonicalize failure, as in `upsert_space`).
    ///
    /// Returns `true` when a row matched, `false` when nothing matched (a
    /// missing row is a no-op, not an error — but a diagnosable one, not a
    /// silent one).
    pub fn set_space_trusted(&self, path: &str, trusted: bool) -> Result<bool, DbError> {
        let key = space_key(path).unwrap_or_else(|| path.to_string());
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE spaces SET trusted = ?2 WHERE path = ?1",
            params![key, trusted],
        )?;
        Ok(n > 0)
    }

    /// All spaces, in the user's manual order (`sort_order`), `path` breaking
    /// ties. Nothing else moves a row.
    pub fn list_spaces(&self) -> Result<Vec<SpaceRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM spaces
             ORDER BY sort_order ASC, path ASC",
            SPACE_COLUMNS.join(", ")
        ))?;
        let rows = stmt
            .query_map([], space_row_from)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Look up one space row by exact stored path (`None` if absent).
    pub fn find_space(&self, path: &str) -> Result<Option<String>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT path FROM spaces WHERE path = ?1")?;
        let found = match stmt.query_row(params![path], |row| row.get::<_, String>(0)) {
            Ok(path) => Some(path),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        Ok(found)
    }

    /// The trust flag for the space at `cwd`, keyed by the canonical path
    /// (the single key form, ADR 0010). Fail-closed: a canonicalize failure
    /// or a missing row is `Ok(false)` — untrusted.
    pub fn space_trusted(&self, cwd: &std::path::Path) -> Result<bool, DbError> {
        // Fail-closed on canonicalize failure (unlike the write path's raw
        // fallback): a folder that can't be canonicalized is untrusted.
        let Some(key) = space_key(cwd) else {
            return Ok(false);
        };
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT trusted FROM spaces WHERE path = ?1")?;
        let found = stmt
            .query_map(params![key], |row| row.get::<_, i64>(0))?
            .next()
            .transpose()?;
        Ok(found.map(|t| t != 0).unwrap_or(false))
    }

    /// Delete the bookkeeping row only (conversations/messages are NOT touched).
    pub fn delete_space(&self, path: &str) -> Result<(), DbError> {
        self.conn
            .lock()
            .expect("db mutex poisoned")
            .execute("DELETE FROM spaces WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Rewrite the manual order of the given space paths in ONE transaction:
    /// the slice index becomes `sort_order` (ADR 0075 — only a drag calls this).
    ///
    /// Keyed by the stored path RAW, as `find_space`/`delete_space` do: the ids
    /// come from a `list_spaces()` result and are already the stored key, and
    /// re-canonicalizing would silently skip a row whose folder is gone and
    /// leave a PARTIAL renumber behind. An id that matches no row is a no-op.
    ///
    /// Unlike `reorder_sessions` this always renumbers the WHOLE table: the
    /// sidebar's tab strip passes every Space it shows, so a space reorder cannot
    /// leave numbers colliding with rows it never saw.
    pub fn reorder_spaces(&self, paths: &[String]) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        for (index, path) in paths.iter().enumerate() {
            tx.execute(
                "UPDATE spaces SET sort_order = ?2 WHERE path = ?1",
                params![path, index as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
