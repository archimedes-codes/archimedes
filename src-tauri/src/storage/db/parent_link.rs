//! The **parent link** subject of `db`: the ONE verb in the crate that writes
//! `sessions.parent_session_id`.
//!
//! It has no caller in this task, and that is the design rather than unfinished
//! work. The caller is the agent layer's own `parent_link` sibling, which reaches
//! this as a method on the `Arc<Db>` it already holds — and a file that says so
//! out loud cannot be "finished off" by someone adding a call here, where there
//! is no frame, no delivery id and no child to link. The column itself is
//! `DEFAULT`-less and carries NO foreign key (see the gate in
//! [`super`]`::open`), so a `NULL` is a valid shipped state and a `parent_id`
//! pointing at a row that no longer exists is a storable one: roughly half the
//! Subagent children in a live database already have no parent row, because
//! deleting a parent destroys the rows naming its children while the children
//! survive. That is why the link is a column and not a constraint.
//!
//! Sibling placement is ADR 0113's rule — one sibling per subject, named for the
//! subject — and this subject is deliberately not folded into [`super::sessions`]:
//! the verb's test child is a mirror of this file, and `db/tests/sessions.rs` has
//! no room left in it.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// the `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource, so a panic while the lock
// is held leaves the next caller a connection of unknown state and there is
// nothing per-key to recover into. These sites were WRITTEN here; they did not
// move from anywhere. The rule and the in-repo worked example
// (`record_messages_batch`, which additionally opens a transaction) are
// documented on that method.

use rusqlite::params;

use super::{Db, DbError};

impl Db {
    /// Record a child session's parent, ONCE.
    ///
    /// Returns `true` when the row's `parent_session_id` was NULL and is now
    /// `parent_id`; `false` when nothing changed — either the row already names a
    /// parent, or `child_id` matches no row at all.
    ///
    /// WRITE-ONCE, and the mechanism is SQL-side rather than a read-then-write
    /// (which would be a race): the `UPDATE` carries `AND parent_session_id IS
    /// NULL`, so once the column holds a value that predicate matches nothing
    /// forever. A second call is therefore a no-op whether it repeats the first
    /// parent or names a different one — the first value is immortal, and a
    /// re-parent is not this verb's to grant. A `NULL` can never overwrite a known
    /// parent, which is the direction that matters: the link is a fact learned at
    /// most once per child, and a later caller that knows less (or knows
    /// something different) must not be able to rewrite it.
    ///
    /// `false` for an unknown id is the STEADY STATE, not a failure. The child's
    /// `sessions` row is created by the pinned crate's `ensure_session_row` when
    /// its first frame persists, so "the row is not there yet" is normal on this
    /// path; the verb answers `false` and the caller moves on, exactly as
    /// [`Self::set_session_archived`] answers `false` for an id that matches no
    /// row. Nothing here creates a row: this verb links, it never invents.
    ///
    /// Autocommit — one statement, no transaction. The lock it holds is the same
    /// single shared `rusqlite::Connection` every other site in this module tree
    /// contends for, so the panic-on-poison rule applies for the shared-resource
    /// reason; the transaction-specific half of that argument lives on the verb
    /// that opens a transaction (`record_messages_batch`). NO SITE COUNT IS
    /// QUOTED, deliberately — the rule is the sentence, and a count in a comment
    /// rots while the rule it illustrates does not.
    pub fn set_session_parent_if_unset(
        &self,
        child_id: &str,
        parent_id: &str,
    ) -> Result<bool, DbError> {
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET parent_session_id = ?2 \
             WHERE id = ?1 AND parent_session_id IS NULL",
            params![child_id, parent_id],
        )?;
        Ok(n > 0)
    }
}
