//! The **artifact** subject of `db`: `task_artifacts`'s storage half (issue #180
//! D1, ADR 0100), lifted verbatim out of the unit that was `storage/db.rs`
//! (ADR 0113).
//!
//! The `Artifact` / `ArtifactMeta` shapes these verbs answer with live in
//! [`super::rows`]: they are storage's types, not the command layer's.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover.
// They moved here with the methods that hold them; the rule and the in-repo
// worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;

use fulcrum_harness::clock::now_ms;

use super::rows::{Artifact, ArtifactMeta};
use super::{BoardError, Db};

impl Db {
    // ── Task artifacts (issue #180, spec §1, ADR 0100) ───────────────────────
    //
    // D1 ships the STORAGE half only: no model-facing verb, no `trait TaskStore`,
    // no tool registration, no `<artifacts>` launch block. A human reaches these
    // through the two IPC commands in `commands/tasks.rs`, and the crate seam D2
    // builds later will be implemented on these exact methods — which is why the
    // shapes (`Artifact`, `ArtifactMeta`) live here rather than in the command
    // layer. Nothing in this region advertises anything to a model.

    /// THE ONE OWNER of the artifact key grammar and of the markdown byte cap.
    ///
    /// Both rules used to live in `commands/tasks.rs` and be enforced NOWHERE
    /// ELSE, which was true when the IPC command was the only door. D2 added a
    /// second door — `impl TaskStore for Db` below, which the `write_artifact`
    /// TOOL reaches through — and a rule with two doors belongs on the single
    /// path both doors pass through, not duplicated beside each one. That is why
    /// the constant and the predicate are HERE and `commands/tasks.rs` now imports
    /// them: the direction is command → storage, never the reverse.
    ///
    /// The `require_title` precedent argues this way TOO, and it no longer has to be
    /// argued around. `require_title` used to refuse a title that `clean_title`
    /// cleans to nothing HERE, in the command layer only, on the theory that the
    /// cleaning was a wire concern — what a person typed, and what the session namer
    /// would re-clean. That theory died the same way this one did: `tasks` gained a
    /// second door through the seam, `title` is `TEXT NOT NULL` with no `CHECK`, and
    /// a model could write a card with no label that a human could not. The title
    /// rule then MOVED to storage for exactly the reason stated here — a rule with
    /// two doors belongs on the single path both pass through — so it is now the
    /// closest precedent this file has, not a counter-example. Both rules are pure
    /// data validation on the row about to be written: a key either matches a grammar
    /// or it does not, a document either fits or it does not, and a title either
    /// cleans to something or it does not. That is what a storage layer may own.
    ///
    /// What stayed in the command layer is the one title rule that is genuinely a
    /// wire concern: `FieldPatch::Clear` on `title` is refused by `patch_title`,
    /// because the seam maps `None → Keep` and no wire value a model can send
    /// expresses a clear. That refusal has no second door to be unreachable through.
    ///
    /// The cap is load-bearing for a reason that a reader must not lose: the
    /// markdown crosses a JSONL pipe on the way to the Worker (the Worker has no
    /// `Db`; the Supervisor is the sole SQLite writer, ADR 0025), and F1's grounding
    /// measured that the crate's stdio JSONL readers carry NO line cap — the 1 MiB
    /// guard is the daemon socket, a different transport. So on the seam path an
    /// uncapped artifact is an UNCAPPED FRAME, and the alternative to refusing is
    /// truncating, which produces a spec that ends mid-sentence and reads as a
    /// complete spec. Modelled on `MAX_IMAGE_BYTES` in `agent/session/mod.rs`.
    pub const MAX_ARTIFACT_MARKDOWN_BYTES: usize = 256 * 1024;

    /// Does `raw` match the artifact key grammar `[a-z0-9][a-z0-9-]{0,39}`?
    ///
    /// A lowercase alphanumeric first character, then lowercase alphanumerics or
    /// hyphens, 1..=40 characters total. It mirrors the Mention token grammar
    /// `[a-z0-9-]` that `taskPrompt.ts` already relies on, which ADR 0100 chose
    /// deliberately so a key survives the launch block's tokenizer.
    ///
    /// A PREDICATE, not a validator: it refuses and never cleans, because a mangled
    /// key is a DIFFERENT key and silently renaming a document the caller asked for
    /// is the same class of lie as writing a title nobody typed. The `first()`
    /// clause refuses `""` on its own (an empty key has no first character to match
    /// `[a-z0-9]`), so there is no separate emptiness check to keep honest.
    ///
    /// Why the grammar is load-bearing and not cosmetic: a key is interpolated into
    /// the `<task>` launch block (ADR 0100). The honest state of that today is that
    /// `src/lib/taskPrompt.ts` runs every key through `escapeAttr`, so an ill-formed
    /// key is NOT an injection hole in the block as it stands — what it breaks is
    /// the INVARIANT the ADR states, and any future surface that interpolates a key
    /// without escaping inherits the bug from a row this grammar was supposed to
    /// make impossible.
    pub fn artifact_key_is_well_formed(raw: &str) -> bool {
        let shape_ok = match raw.as_bytes().first() {
            Some(b'a'..=b'z' | b'0'..=b'9') => raw
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            // No first character at all (the empty key), so the "first is [a-z0-9]"
            // clause cannot be satisfied.
            _ => false,
        };
        shape_ok && raw.len() <= 40
    }

    /// Write (UPSERT) one artifact of one card, returning identity + stamp + size
    /// and NEVER the markdown back.
    ///
    /// THE LOAD-BEARING REFUSAL. A `task_id` with no `tasks` row is
    /// `MissingTask`, checked under the SAME lock as the write and BEFORE it.
    /// This is not redundant belt-and-braces: `task_artifacts.task_id` carries NO
    /// foreign key (ADR 0100, for ADR 0090's reason — a Space tab close must not
    /// take a card's documents with it, and the only cascade an FK here could
    /// fire on IS that tab close), so SQLite will NOT catch a dangling Task id.
    /// `write_artifact_refuses_a_dangling_task_id_there_is_no_fk_to_catch_it`
    /// inserts such a row directly to prove the hole. A dangling artifact would
    /// be invisible forever — nothing lists it, nothing reads it, and it is a
    /// document nobody can reach — so the refusal belongs HERE, at the layer that
    /// knows the difference. `write_task_session_link`'s `get_task` gate in
    /// `commands/tasks.rs` is the same rule at the wire layer and BOTH refuse:
    /// the command refusal is what a caller sees, this one is what makes it
    /// impossible to bypass through any future caller that skips the command.
    ///
    /// What this method checks FIRST, before the lock and before any statement:
    /// the key grammar ([`Db::artifact_key_is_well_formed`]) and the byte cap
    /// ([`Db::MAX_ARTIFACT_MARKDOWN_BYTES`]), as `BadArtifactKey` /
    /// `ArtifactTooLarge`.
    ///
    /// THOSE TWO USED TO live in `commands/tasks.rs` alone, on the theory that they
    /// are wire rules and storage has no business owning them. That theory was true
    /// with one door and false with two: D2's `impl TaskStore for Db` (below) is a
    /// second door to this table, the `write_artifact` TOOL reaches the table
    /// through it, and it called neither rule — so a model could persist a key
    /// outside the grammar and a markdown over the cap that a human could not. A
    /// rule with two entry points belongs on the one path both pass through, and
    /// both of these are pure data checks on the row about to be written, not
    /// concerns about how it arrived. See
    /// [`Db::MAX_ARTIFACT_MARKDOWN_BYTES`] for why the cap in particular cannot be
    /// left to the caller's good intentions.
    ///
    /// The command layer KEEPS its own two pre-flight checks. Not for defence —
    /// this is the backstop — but because it answers `TasksError` and produces the
    /// nicer envelope (the `artifact_too_large` `size`/`max` keys, ADR 0063) without
    /// spending a DB round trip; `From<BoardError> for TasksError` maps these two
    /// arms field-for-field onto the same variants, so a person who never came
    /// through the command's pre-flight still reads the same sentence. That is the
    /// same belt-and-suspenders shape as the `MissingTask` gate one paragraph up,
    /// and for the same reason: the command refusal is what a caller sees, this one
    /// is what makes it impossible to bypass through any caller that skips the
    /// command.
    ///
    /// The UPSERT is what `PRIMARY KEY (task_id, key)` buys: `created_at` is NOT
    /// in the `DO UPDATE SET` list on purpose, so an overwrite rewrites the
    /// document and its stamp but not the artifact's age.
    pub fn write_artifact(
        &self,
        task_id: &str,
        key: &str,
        markdown: &str,
    ) -> Result<ArtifactMeta, BoardError> {
        // BOTH pure refusals run BEFORE the lock and before the existence check,
        // so a rejection touches no connection at all and the "a rejection writes
        // NOTHING" rule holds for every door, not just the command's.
        if !Self::artifact_key_is_well_formed(key) {
            return Err(BoardError::BadArtifactKey {
                key: key.to_string(),
            });
        }
        if markdown.len() > Self::MAX_ARTIFACT_MARKDOWN_BYTES {
            return Err(BoardError::ArtifactTooLarge {
                size: markdown.len(),
                max: Self::MAX_ARTIFACT_MARKDOWN_BYTES,
            });
        }
        let guard = self.conn.lock().expect("db mutex poisoned");
        // The existence check, one lock with the write below (the `create_task`
        // two-statements-one-guard rule: split them and a delete could slip
        // between, and there is no delete verb to blame when it does).
        let exists: Option<i64> = match guard.query_row(
            "SELECT 1 FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get::<_, i64>(0),
        ) {
            Ok(one) => Some(one),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        if exists.is_none() {
            return Err(BoardError::MissingTask(task_id.to_string()));
        }
        let now = now_ms();
        guard.execute(
            "INSERT INTO task_artifacts (task_id, key, markdown, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?4) \
             ON CONFLICT(task_id, key) DO UPDATE SET \
             markdown = excluded.markdown, updated_at = excluded.updated_at",
            params![task_id, key, markdown, now],
        )?;
        Ok(ArtifactMeta {
            key: key.to_string(),
            updated_at: now,
            bytes: markdown.len(),
        })
    }

    /// Read one whole artifact; `Ok(None)` when it is not there — asking for
    /// something that is not there is an answer, not an error (the `get_task`
    /// shape, carried over verbatim).
    ///
    /// BOTH absences answer `Ok(None)`: a key the card never wrote, and a Task
    /// that does not exist. The WRITE path refuses a missing Task because a write
    /// the caller believes succeeded is a lie; a READ path reporting "nothing
    /// here" is the truth either way, and the detail dialog asks this question
    /// routinely. That is why no new `BoardError` variant was needed.
    ///
    /// This is the ONE place artifact content crosses the wire, and it is a
    /// single-artifact read by `(task_id, key)` — never a list, never the board.
    pub fn get_artifact(&self, task_id: &str, key: &str) -> Result<Option<Artifact>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT task_id, key, markdown, created_at, updated_at FROM task_artifacts \
             WHERE task_id = ?1 AND key = ?2",
        )?;
        let found = match stmt.query_row(params![task_id, key], |row| {
            Ok(Artifact {
                task_id: row.get::<_, String>(0)?,
                key: row.get::<_, String>(1)?,
                markdown: row.get::<_, String>(2)?,
                created_at: row.get::<_, i64>(3)?,
                updated_at: row.get::<_, i64>(4)?,
            })
        }) {
            Ok(artifact) => Some(artifact),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        Ok(found)
    }

    /// One card's artifact KEYS, oldest write first (the `Db::task_sessions`
    /// order). Keys ONLY, never content: a payload carrying the markdown would
    /// make the spec §1 split a lie, which is what
    /// `the_board_payload_carries_keys_only_never_the_markdown` exists to catch.
    ///
    /// A card with no artifacts is an empty `Vec` — never an error, never a
    /// `None`. Returning `Option` here would let "no artifacts" and "could not
    /// tell" look identical to the caller.
    pub fn artifact_keys(&self, task_id: &str) -> Result<Vec<String>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard
            .prepare("SELECT key FROM task_artifacts WHERE task_id = ?1 ORDER BY rowid ASC")?;
        let rows = stmt
            .query_map(params![task_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every `(task_id, keys)` pair for one Space, in ONE statement — the board
    /// read's aggregate, so a card never issues a query per row.
    ///
    /// Space-scoped by `task_id IN (SELECT id FROM tasks WHERE space_path = ?1)`,
    /// copying the #174 links read's reasoning because it is the same question:
    /// the scoping question is "whose card is this", and only `task_id` answers
    /// it. A `cwd`-shaped filter would be wrong twice over — `tasks` rows are
    /// keyed by the raw `space_path` string, so a filter through the filesystem
    /// would drop a **Detached task** and pull in a neighbour's keys — and `?1`
    /// is ONE parameter, bound once for the whole statement.
    ///
    /// Keys only, by SHAPE: the return type is `(String, Vec<String>)` and has
    /// nowhere to put a document. Ordering is `task_id ASC, rowid ASC`, so
    /// grouping consecutive rows in Rust preserves the per-card oldest-write-first
    /// order without a second sort. An empty Space is `vec![]`.
    pub fn artifact_keys_for_space(
        &self,
        space_path: &str,
    ) -> Result<Vec<(String, Vec<String>)>, BoardError> {
        let rows = {
            let guard = self.conn.lock().expect("db mutex poisoned");
            let mut stmt = guard.prepare(
                "SELECT task_id, key FROM task_artifacts \
                 WHERE task_id IN (SELECT id FROM tasks WHERE space_path = ?1) \
                 ORDER BY task_id ASC, rowid ASC",
            )?;
            let rows = stmt
                .query_map(params![space_path], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        // Group in Rust, on rows that arrive sorted by `task_id`, so a
        // push-and-group (no HashMap, no second sort) is enough. Done after the
        // guard is released: this is pure memory work and the lock is the board's
        // single writer (ADR 0090), so it stays held only as long as SQL runs.
        let mut grouped: Vec<(String, Vec<String>)> = Vec::new();
        for (task_id, key) in rows {
            match grouped.last_mut() {
                Some((previous, keys)) if *previous == task_id => keys.push(key),
                _ => grouped.push((task_id, vec![key])),
            }
        }
        Ok(grouped)
    }
}
