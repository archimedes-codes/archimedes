//! The **transcript retention** subject of `db`: the verbs that bound what a
//! closed Subagent session's transcripts can cost, over `messages`,
//! `native_messages` and `sessions`, plus the two bounds themselves and the
//! one-time-upgrade marker read/write.
//!
//! # Deciding "closed" is the CALLER's job — a verb here cannot
//!
//! A Subagent session is closed when its Worker process has exited: terminal and
//! irreversible, because a Subagent session is ephemeral and has no Resume (ADR
//! 0025). Nothing in the `sessions` table records that. Liveness lives in memory,
//! in `agent`'s own session state, set at one site and cleared in the router's
//! teardown. So neither prune verb below can answer the question, and each
//! approximates it with something weaker:
//!
//!   * [`Db::prune_closed_subagent_transcripts`] approximates it with AGE —
//!     `sessions.created_at`, a stable lower bound on "closed for at least this
//!     long";
//!   * [`Db::prune_closed_subagent_transcripts_of_parent`] approximates it with
//!     NOTHING AT ALL. It prunes every child the given parent owns, running or
//!     not.
//!
//! A caller that assumes otherwise will prune a mid-turn child: flush its
//! in-flight rows, delete all but the newest, and then watch the still-running
//! child re-INSERT the rest at LARGER rowids at the end of a transcript that is
//! `ORDER BY id` on the way back out. That is a correctness defect, not a size
//! one. The archive command guards it with the caller's own liveness answer; see
//! `commands/history.rs`'s `set_session_archived_core`.
//!
//! The bounds themselves are the approved design's
//! (`docs/research/database-size-unbounded-transcript-growth.md`, §"Approved
//! design (2026-11-22)"), and the sibling rule that put these verbs here is ADR
//! 0113 — one sibling per subject, named for the subject. This file is NOT a lift
//! out of the old `db.rs`: it owns a subject that did not exist when that unit was
//! split, which is why it says what it holds rather than where it came from.
//!
//! What is NOT touched, ever, by any verb here: the `sessions` ROW. It costs
//! 0.6 MB for 2,643 rows and it carries `cost_usd`, so a pruned child keeps its
//! row and its price and loses only its transcripts — the same "ONLY this table"
//! discipline `clear_native_messages` states about itself.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource that a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover. These
// sites were WRITTEN here; they did not move from anywhere. The rule, and the
// in-repo worked example of a lock that opens a transaction and therefore must
// not be recovered (`record_messages_batch`), are documented on that method.

use std::time::Duration;

use fulcrum_harness::clock::now_ms;
use rusqlite::params;

use super::{Db, DbError};

/// What one prune pass did, in rows and in sessions.
///
/// `#[derive(Debug, Clone, Copy, PartialEq, Eq)]` and NO `Serialize`: this never
/// crosses IPC and `types.ts` has no mirror, so deriving a wire shape here would
/// imply a frontend that nothing owns. It derives `Default` because both prune
/// verbs answer "nothing to do" with an all-zero value on the path that opens no
/// transaction at all — an archive click on a childless parent must not touch the
/// WAL, and the zero it returns is the same zero every empty-target arm returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PrunedCounts {
    /// Targets that LOST at least one row — not targets that were selected. A
    /// child already trimmed to its newest row is not "touched" by this pass, and
    /// counting it would inflate the figure a user reads as "how many transcripts
    /// did this affect".
    pub sessions_pruned: u64,
    /// `messages` rows deleted, across every target.
    pub display_rows_deleted: u64,
    /// `native_messages` rows deleted, across every target.
    pub native_rows_deleted: u64,
}

/// How old a Subagent session must be before the age-bound sweep will trim its
/// transcript: **24 hours**.
///
/// Why not smaller: the age bound exists to close the resurrection hole for the
/// sweep — a row still sitting in the in-memory batch buffer (whose flush
/// interval is 250 ms) must never be old enough to be a target, and anything in a
/// 250 ms buffer is not a day old. It is also the only bound that can tell a
/// closed child from a long-running one by `created_at` alone, which is the only
/// liveness proxy the `sessions` table offers. Why not larger: the measured
/// database this design answers holds 2,042 MB of unreachable transcript, and a
/// longer bound defers all of it. Not a settings key — see the module header's
/// note on `Settings` being crate-owned behind a version pin.
pub const MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE: Duration = Duration::from_secs(24 * 3600);

/// How much free space a database must be sitting on before
/// [`Db::vacuum_if_freelist_over`] will rewrite it: **256 MiB** of free pages
/// (`freelist_count × page_size`).
///
/// Why a threshold at all: `VACUUM` is a whole-file rewrite. It needs roughly
/// twice the file in free disk, and it holds `Db`'s ONE connection mutex for its
/// whole duration, blocking every other `Db` verb including the batching flush —
/// on the measured database that is a multi-second stall by construction, which
/// is why the caller only ever runs it on an idle gate and why this number is
/// generous. The reclaim it buys is the whole of the design's headline: 2,042 of
/// 2,825 MB. ADR **0118** owns the "no data, no knob" answer for why this is a
/// constant and not a preference; this file states the cost, not a measurement
/// that would justify tuning it.
pub const VACUUM_FREELIST_THRESHOLD_BYTES: u64 = 256 * 1024 * 1024;

/// Which closed Subagent sessions one prune pass targets. The two entry points
/// below differ ONLY in this — the delete SQL exists once, on purpose, because
/// "both triggers call the same verb" means exactly that.
enum Scope<'a> {
    /// `is_subagent = 1 AND created_at < ?1` — the age-bound sweep.
    ///
    /// The payload is a CUTOFF TIMESTAMP, not an age. `sessions.created_at` is
    /// stamped by `now_ms()` (an epoch timestamp), so the value bound to the
    /// selector must be one too: `now_ms() − max_age`. Binding the age itself
    /// compares a DURATION against a TIMELINE — `created_at < 86_400_000` is
    /// "before 1970-01-02", which matches nothing, so the verb would return
    /// all-zero counts and delete nothing, forever, without an error.
    OlderThan(i64),
    /// `is_subagent = 1 AND parent_session_id = ?1` — one parent's children.
    OfParent(&'a str),
}

impl Db {
    /// Trim the transcripts of every CLOSED Subagent session older than
    /// `max_age`, app-wide.
    ///
    /// `max_age` is an AGE and the selector needs a cutoff, so the two
    /// statements below are one unit and neither is optional: convert the age to
    /// milliseconds, then subtract it from the clock. `i64::try_from` rather than
    /// `as i64` because `as_millis()` returns `u128` and an absurd duration would
    /// WRAP through a negative — and a negative bound matches nothing either, so
    /// the wrap would silently disable the sweep. `unwrap_or(i64::MAX)` keeps such
    /// a value at the SATURATING end instead, and saturation means "prune
    /// NOTHING" (`now_ms() − i64::MAX` is negative, and no row has ever had a
    /// `created_at` below zero) — the conservative direction: an absurd age
    /// declines to delete rather than deleting the database. That arm is
    /// unreachable for the bound this run ships; it is a safety property of the
    /// shape.
    ///
    /// "Closed" here is APPROXIMATED BY AGE and nothing more, because the
    /// `sessions` table records no liveness — see the module header.
    pub fn prune_closed_subagent_transcripts(
        &self,
        max_age: Duration,
    ) -> Result<PrunedCounts, DbError> {
        let age_ms = i64::try_from(max_age.as_millis()).unwrap_or(i64::MAX);
        let cutoff = now_ms().saturating_sub(age_ms);
        self.prune_closed_subagent_transcripts_scoped(Scope::OlderThan(cutoff))
    }

    /// Trim the transcripts of every Subagent session the given parent owns.
    ///
    /// This is the scope BOTH triggers call — archive and delete. It exists
    /// because the age-bound verb above scopes APP-WIDE and says nothing about
    /// parenthood: calling it from an archive trigger would trim every aged child
    /// in the database because one unrelated parent was archived, which is the
    /// over-delete that made the `cwd` proxy unusable in the design's own
    /// analysis. `parent_session_id` is the column that makes "this parent's
    /// children" expressible at all.
    ///
    /// NO AGE BOUND, and the design licenses that: §"Approved design
    /// (2026-11-22)" part 3 scopes the archive trigger "per closed child" with no
    /// age bound, and its safety paragraph claims the age bound for THE SWEEP ONLY
    /// ("the age bound closes the resurrection hole for the sweep") — the triggers'
    /// safety rests on closedness, not on age, because anything still in the
    /// in-memory batch buffer is at most `DEFAULT_FLUSH_INTERVAL` old.
    ///
    /// And NO LIVENESS CHECK either, which is the part a caller must not
    /// misread: this verb prunes whatever the parent owns, running or not, because
    /// the `sessions` table records no liveness and a `Db` verb cannot see the
    /// `WorkerManager`. The design's licence is for the SCOPE; the PREDICATE is
    /// the caller's, and the archive command answers it with `is_live` before
    /// calling this at all. See the module header.
    ///
    /// A `NULL` parent never satisfies `parent_session_id = ?1`, so the children
    /// whose parent is already gone — roughly half of them, and the very population
    /// the column's missing `DEFAULT` exists to describe — are untouched by a
    /// trigger. The age-bound sweep reaches those later.
    pub fn prune_closed_subagent_transcripts_of_parent(
        &self,
        parent_id: &str,
    ) -> Result<PrunedCounts, DbError> {
        self.prune_closed_subagent_transcripts_scoped(Scope::OfParent(parent_id))
    }

    /// Rewrite the database file if it is sitting on more than `threshold_bytes`
    /// of free space, and report whether a VACUUM actually ran.
    ///
    /// Returns `false` — WITHOUT rewriting anything — when
    /// `freelist_count × page_size` is at or below the threshold, and `true` only
    /// after a `VACUUM` has completed. The comparison is `<=`, so a threshold of
    /// `0` on a database that has never freed a page answers `false`: `0 <= 0`.
    /// `freelist_count × page_size` is the reclaimable-bytes figure, and it is the
    /// only one worth having, because a prune that deletes rows does not return
    /// their pages to the operating system by itself.
    ///
    /// AUTOCOMMIT ONLY, and that is not a style choice: `VACUUM` cannot run inside
    /// a transaction (measured on this machine — `cannot VACUUM from within a
    /// transaction`), so this verb may NOT go through `gate` or
    /// `unchecked_transaction`, both of which open one. It takes the lock WITHOUT
    /// `mut` for the same reason — `transaction()` needs `&mut` and this path must
    /// not be able to ask for one.
    ///
    /// `pragma_query_value` for the two reads and `execute_batch` for the write,
    /// because `execute` on a row-returning PRAGMA is an `ExecuteReturnedResults`
    /// `Err` while `VACUUM` returns no rows. `PRAGMA incremental_vacuum` is NOT an
    /// option here: `auto_vacuum` is `0` and `Db::open` never sets it, so
    /// incremental vacuum is a measured no-op and a full `VACUUM` is the only
    /// reclaim this file can perform.
    ///
    /// THE COST, stated because it is user-visible: `VACUUM` is a whole-file
    /// rewrite needing roughly twice the file in free disk, and it holds this ONE
    /// connection mutex for its whole duration, blocking every other `Db` verb
    /// including the batching flush. `busy_timeout` covers OTHER connections, not
    /// this serialisation. Nothing here schedules it and nothing here decides when
    /// it is safe to hold the app still — that is the caller's idle gate.
    pub fn vacuum_if_freelist_over(&self, threshold_bytes: u64) -> Result<bool, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned"); // NOT mut: no transaction() here
        let freelist: u64 = guard.pragma_query_value(None, "freelist_count", |r| r.get(0))?;
        let page_size: u64 = guard.pragma_query_value(None, "page_size", |r| r.get(0))?;
        if freelist.saturating_mul(page_size) <= threshold_bytes {
            return Ok(false);
        }
        guard.execute_batch("VACUUM")?;
        Ok(true)
    }

    /// Read the retention schema version — the one-time-upgrade marker.
    ///
    /// `PRAGMA user_version` is an INTEGER in the database FILE header, which is
    /// what makes it usable as a latch: it survives close/reopen and it survives a
    /// `VACUUM` (both pinned in this file's tests, the second one because this
    /// same file ships the rewrite that could have lost it).
    ///
    /// Autocommit, no transaction, and never called from `Db::open` — the gates
    /// there are already "the expensive writes … the reason an upgrade-first open
    /// used to stall the window", and a sweep must not join them.
    ///
    /// `pragma_query_value` and not `execute`, because reading a PRAGMA returns a
    /// row and `execute` on a row-returning PRAGMA is an `ExecuteReturnedResults`
    /// `Err` — the same split that forces `execute_batch` for `VACUUM` above.
    ///
    /// This layer interprets NOTHING: it carries an `i64` and returns it. The
    /// consumer is the agent layer's retention marker constant, in prose and not
    /// by name — the value that means "already swept" is THAT constant's, not this
    /// file's, and minting it here would create a second marker with nothing
    /// forcing the two to agree.
    pub fn retention_schema_version(&self) -> Result<i64, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned"); // NOT mut: no transaction here
        Ok(guard.pragma_query_value(None, "user_version", |r| r.get(0))?)
    }

    /// Write the retention schema version.
    ///
    /// `pragma_update` builds `PRAGMA name = value` and runs it through
    /// `execute_batch`, which is why it tolerates a row-returning PRAGMA — the
    /// house idiom for every pragma this crate writes (the journal pragmas and
    /// `foreign_keys` in `db/mod.rs` use it).
    ///
    /// NO read-back inside the write, deliberately: `set_journal_pragmas` reads
    /// `journal_mode` back because that pragma REFUSES SILENTLY on some filesystems
    /// and a `?` would never see the refusal. `user_version` is an in-header
    /// integer write with no such refusal, and the caller's own latch test reads
    /// back through [`Self::retention_schema_version`] — a second read path here
    /// would be a second way to learn one fact.
    ///
    /// Autocommit, no transaction, never called from `Db::open`, and no
    /// validation: the marker's MEANING is the agent layer's decision.
    pub fn set_retention_schema_version(&self, version: i64) -> Result<(), DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.pragma_update(None, "user_version", version)?;
        Ok(())
    }

    /// The shared body of both prune verbs: select the targets, then delete.    ///
    /// ONE transaction for the whole pass (the `delete_session` /
    /// `replace_native_messages` shape — `transaction()`, N `execute`s, one
    /// `commit()`), so a pass is all-or-nothing: a failure part-way cannot leave
    /// half a database trimmed, which is what makes the age-bound sweep safe to
    /// re-run and the triggers safe to fire twice on the same parent.
    ///
    /// The empty target set returns BEFORE the transaction is opened. An archive
    /// click on a childless parent is the ordinary case, and it must not touch
    /// the WAL.
    ///
    /// PANICS ON A POISONED MUTEX, and that is the correct call here rather than
    /// the recover `batching.rs`'s per-session map does: this lock guards `Db`'s
    /// ONE shared `rusqlite::Connection`, so a panic mid-transaction can leave
    /// that single connection unusable, and recovering would hand the next caller
    /// a connection of unknown state (an open transaction, or a rolled-back pass
    /// it believes landed). NO COUNT IS QUOTED HERE, deliberately — a count in a
    /// comment rots while the rule it illustrates does not.
    fn prune_closed_subagent_transcripts_scoped(
        &self,
        scope: Scope<'_>,
    ) -> Result<PrunedCounts, DbError> {
        // Select first, on a read that needs no transaction. `sessions` has only
        // its PK autoindex, so either arm is a `SCAN sessions` — which is what
        // `list_sessions` and `session_recency` already pay, and an index here
        // would be a second `SCHEMA` change on a 2.8 GB file for a sweep that
        // runs on a user act.
        let targets: Vec<String> = {
            let guard = self.conn.lock().expect("db mutex poisoned");
            let ids_for =
                |sql: &str, bound: &[&dyn rusqlite::ToSql]| -> Result<Vec<String>, DbError> {
                    let mut stmt = guard.prepare(sql)?;
                    let rows = stmt
                        .query_map(bound, |row| row.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(rows)
                };
            match scope {
                // `is_subagent = 1 AND created_at < ?1`
                Scope::OlderThan(cutoff) => ids_for(
                    "SELECT id FROM sessions WHERE is_subagent = 1 AND created_at < ?1",
                    params![cutoff],
                )?,
                // `is_subagent = 1 AND parent_session_id = ?1`
                Scope::OfParent(parent_id) => ids_for(
                    "SELECT id FROM sessions WHERE is_subagent = 1 AND parent_session_id = ?1",
                    params![parent_id],
                )?,
            }
        };
        if targets.is_empty() {
            return Ok(PrunedCounts::default());
        }

        let mut counts = PrunedCounts::default();
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        for id in &targets {
            // The explicit `native_messages` delete is belt-and-suspenders, not a
            // cascade substitute: the FK cannot fire here (deleting CHILD rows
            // never fires a cascade, and the parent row survives), but it covers
            // "a pre-migration database that never gained the FK" — the same
            // justification `delete_session` gives for its own explicit delete.
            // NO `PRAGMA foreign_keys` line: it is already ON per connection, and
            // SQLite SILENTLY IGNORES a `foreign_keys` change made inside a
            // transaction, which is the worst possible shape of this.
            let native = tx.execute(
                "DELETE FROM native_messages WHERE session_id = ?1",
                params![id],
            )?;
            // Every display row EXCEPT the newest, by `id` and regardless of
            // `kind`. `MAX(id)` and never `MAX(created_at)`, because
            // `record_messages_batch` stamps `created_at` ONCE per batch —
            // transcript order is `id`, never that column — and no `kind` filter,
            // because 6% of children end on a `tool-call` or an `agent-thought`
            // and a `kind = 'agent-text'` filter keeps NOTHING for those. `?1` is
            // reused by both clauses of the one statement, so `params![id]`
            // supplies it once.
            let display = tx.execute(
                "DELETE FROM messages WHERE session_id = ?1 \
                 AND id <> (SELECT MAX(id) FROM messages WHERE session_id = ?1)",
                params![id],
            )?;
            // "Lost at least one row", NOT "was selected": a child already
            // trimmed to its newest row is not a session this pass touched, and
            // counting it would inflate the number a user reads.
            if native > 0 || display > 0 {
                counts.sessions_pruned += 1;
            }
            counts.display_rows_deleted += display as u64;
            counts.native_rows_deleted += native as u64;
        }
        tx.commit()?;
        Ok(counts)
    }
}
