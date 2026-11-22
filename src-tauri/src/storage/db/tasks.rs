//! The **task write** subject of `db`: `get_task`, `create_task`, `edit_task`,
//! `move_task`, lifted verbatim out of the unit that was `storage/db.rs`
//! (ADR 0113).
//!
//! `create_task` is ADR 0090's rendezvous: the `MAX(number)` read and the `INSERT`
//! are two statements under ONE `conn.lock()`. `move_task` is where the Strict
//! workflow gate lives (ADR 0099) — the reason `delete_stage`'s relocation is a
//! bulk UPDATE and never a per-card `move_task`.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover.
// They moved here with the methods that hold them; the rule and the in-repo
// worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;

use fulcrum_harness::clock::now_ms;

use super::rows::{task_row_from, TaskRow, TASK_COLUMNS};
use super::seams::space_key;
use super::stages::{
    available_slugs, lenient_next_slugs, missing_stage, seed_default_stages, stage_slug_exists,
};
use super::{BoardError, Db, FieldPatch, MoveOutcome};

impl Db {
    /// One card by its GLOBAL key (`tsk_<uuid>`); `Ok(None)` when absent — the
    /// `find_space` shape: a read of a deleted card is an answer, not an error.
    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRow>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM tasks WHERE id = ?1",
            TASK_COLUMNS.join(", ")
        ))?;
        let found = match stmt.query_row(params![task_id], task_row_from) {
            Ok(row) => Some(row),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        Ok(found)
    }

    /// Create a card, handing out the next per-Space `number`.
    ///
    /// THE LOAD-BEARING LOCK. The `MAX(number)` read and the `INSERT` are two
    /// statements and they run under ONE `conn.lock()` — ADR 0090's rendezvous.
    /// SQLite serialises the writes themselves, so the hazard the single guard
    /// closes is not a torn write but the two-statement interleave where two
    /// creates in the same tick both read the same `MAX` and both insert `#4`.
    /// `create_task_reads_and_inserts_under_one_lock` releases N threads off a
    /// `Barrier` and asserts N distinct numbers; with two locks it fails.
    ///
    /// - `stage_slug: None` → the Space's FIRST stage (by `sort_order`), which
    ///   is why this method seeds too (see `seed_default_stages`).
    /// - `number`: `COALESCE((SELECT MAX(number) …), 0) + 1` — floors at `0`, so
    ///   the first card is `#1`.
    /// - `sort_order`: `COALESCE((SELECT MAX(sort_order) …), -1) + 1` — this
    ///   file's bottom-join idiom, floors at `-1`, so the first card is position
    ///   `0`. THE TWO FLOORS DIFFER ON PURPOSE; see the numbering note below.
    ///
    /// THE TITLE RULE LIVES HERE, and it now holds on BOTH doors. `title` is run
    /// through [`crate::text::clean_title`] and a title that cleans to nothing is
    /// `EmptyTitle` — the SAME refusal the command layer's pre-flight makes, mapped
    /// variant-to-variant so both doors answer with one sentence. It used to live in
    /// `commands/tasks.rs` alone, which was safe while the IPC command was the only
    /// door; the crate seam's `TaskStore::create_task` (impl'd in `db/seams.rs`, which
    /// the split moved out of this file) is the second, it delegates straight
    /// here, and `tasks.title` is `TEXT NOT NULL` with no `CHECK` — so a model could
    /// write a card with no label that a human could not, and `TaskCard.tsx` renders
    /// `{task.title}` with no fallback. A rule with two doors belongs on the single
    /// path both pass through.
    ///
    /// What is stored is the CLEANED title, and it is cleaned exactly ONCE — here.
    /// Callers pass the raw string; see [`crate::text::clean_title`] for why a second
    /// clean is not a no-op (the trim runs before the quote strip, so cleaning twice
    /// quietly rewrites a person's title).
    pub fn create_task(
        &self,
        space_path: &str,
        title: &str,
        body: Option<&str>,
        stage_slug: Option<&str>,
    ) -> Result<TaskRow, BoardError> {
        // BEFORE the lock, exactly as `write_artifact`'s two pure refusals are: a
        // rejection touches no connection at all, so the "a rejection writes
        // NOTHING" rule holds for every door and not just the command's.
        let title = crate::text::clean_title(title, None).ok_or(BoardError::EmptyTitle)?;
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        // Seed inside the SAME guard as the read and the insert: a card cannot
        // be created in a Space with no columns, and the seed must not take a
        // second lock that the number read could interleave with.
        seed_default_stages(&mut guard, space_path)?;

        // NUMBERING NOTE — read this before "correcting" the `0` below.
        //
        // `number` is a USER-VISIBLE LABEL: it is what a person says out loud
        // ("move T3 to doing"), and a card labelled `#0` reads as a bug. So this
        // bottom join floors at `0` and the first card of a Space is `#1`.
        //
        // That is a DELIBERATE deviation from the `sort_order` bottom-join idiom the
        // rest of `db` uses — `COALESCE((SELECT MAX(sort_order) …), -1) + 1`, spelled
        // in `spaces.rs`'s `upsert_space`, `sessions.rs`'s `record_session` and the
        // space backfill inside `Db::open` in `db/mod.rs` (the split moved all three
        // out of this file; this file's own `sort_order` join below keeps the same
        // idiom). That idiom floors
        // at `-1` so the first row lands at position `0`. `sort_order` is a
        // zero-based POSITION INDEX — the `-1` is precisely what makes "join at
        // the bottom" mean 0 — and the statement below keeps that idiom
        // untouched. One is a label, one is an index; they are not the same
        // quantity and a reviewer must not unify them. ADR 0090 records the
        // decision and
        // `create_task_sort_order_is_zero_based_where_number_is_one_based` pins it.
        let number: i64 = guard.query_row(
            "SELECT COALESCE((SELECT MAX(number) FROM tasks WHERE space_path = ?1), 0) + 1",
            params![space_path],
            |row| row.get(0),
        )?;
        let sort_order: i64 = guard.query_row(
            "SELECT COALESCE((SELECT MAX(sort_order) FROM tasks WHERE space_path = ?1), -1) + 1",
            params![space_path],
            |row| row.get(0),
        )?;
        let stage = match stage_slug {
            Some(slug) => {
                // An explicit slug is VALIDATED, not trusted: a card in a column
                // that does not exist is invisible on the board, and an
                // invisible card is the silent-green shape this repo keeps
                // documenting. The rejection names the valid slugs (ADR 0090).
                if !stage_slug_exists(&guard, space_path, slug)? {
                    return Err(missing_stage(&guard, space_path, slug));
                }
                slug.to_string()
            }
            None => guard
                .query_row(
                    "SELECT slug FROM stages WHERE space_path = ?1 \
                     ORDER BY sort_order ASC, slug ASC LIMIT 1",
                    params![space_path],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                // UNREACHABLE in practice — `seed_default_stages` just ensured
                // five rows exist. Surfaced as an error rather than unwrapped so
                // the "no card without a column" invariant stays total, without
                // widening `DbError` (which the crate seam forbids) to carry a
                // kanban-shaped case. `available_slugs` cannot realistically fail
                // here either, and its failure would only empty the message, so
                // `unwrap_or_default` is the honest degradation, not a swallowed
                // error: the `wanted`/`available` pair is diagnostic text.
                .ok_or_else(|| BoardError::MissingStage {
                    wanted: String::new(),
                    available: available_slugs(&guard, space_path).unwrap_or_default(),
                })?,
        };
        let id = format!("tsk_{}", uuid::Uuid::new_v4());
        let now = now_ms();
        guard.execute(
            "INSERT INTO tasks (id, space_path, number, title, body, spec_path, stage_slug, \
             sort_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?8)",
            params![id, space_path, number, &title, body, stage, sort_order, now],
        )?;
        drop(guard);
        // Re-read rather than rebuild the struct from the arguments: the row
        // that comes back IS the row that is stored, so a DDL default can never
        // drift from what the caller sees. `get_task` takes its own lock — this
        // one is dropped first, so nothing is held across the call.
        self.get_task(&id)?.ok_or_else(|| {
            BoardError::MissingTask(format!("the row just inserted ({id}) vanished"))
        })
    }

    /// Patch a card's TEXT fields.
    ///
    /// Each field is a [`FieldPatch`]: [`FieldPatch::Keep`] leaves the stored value
    /// exactly as it is, [`FieldPatch::Set`] writes the given value, and
    /// [`FieldPatch::Clear`] writes NULL. The three states are the reason this verb
    /// does not take `Option<&str>` — under the old `COALESCE` statement `NULL` meant
    /// "leave it alone", so a card could never stop naming a spec file that `finish`
    /// deleted on ship (ADR 0100).
    ///
    /// `updated_at` is stamped unconditionally, as before: an all-`Keep` patch writes
    /// no column and still moves the clock. That is the old statement's behaviour
    /// carried over, not a regression — and it is why the `touched == 0` check below
    /// can only ever mean "no row matched `WHERE id`".
    ///
    /// THE TITLE RULE: the CLEAN and the EMPTY-REFUSAL are decided HERE, on the
    /// single path both doors pass through. A [`FieldPatch::Set`] title is run
    /// through [`crate::text::clean_title`] and one that cleans to nothing is
    /// `EmptyTitle`, refused BEFORE the statement; `Keep` and `Clear` are untouched
    /// (a `Keep` must never re-clean what is stored, and `Clear` is refused upstream).
    /// This mirrors [`Db::create_task`], and the two together are why the rule cannot
    /// be bypassed: `TaskCall::EditTask { title: Some("") }` was a fully expressible
    /// `FieldPatch::Set("")` and the `CASE` below writes `''` without complaint, so
    /// the model's door could blank a label a person had typed.
    ///
    /// The `Clear` refusal stays in the COMMAND layer, and that split is not an
    /// inconsistency. `tasks.title` is `NOT NULL`, so a card without a label is not
    /// a thing — but the seam maps `None → Keep` and this crate consumes the published
    /// `TaskCall` as a registry pin, so NO wire value a model can send expresses a
    /// `Clear` on title. That one refusal is genuinely about the WIRE — it refuses a
    /// state only the IPC body can reach, so `patch_title` is the layer that can see
    /// it. A `Clear` that slipped past would still surface SQLite's constraint as
    /// [`BoardError::Sqlite`]: defence-in-depth, not a hole to paper over here.
    ///
    /// Deliberately cannot touch `stage_slug` (that is `move_task`, which also
    /// runs the destination's `on_enter`), `number` (a label that is never
    /// renumbered), or `sort_order` (that is [`Db::reorder_tasks`] — spec §3's
    /// second drag verb, and a whole-slice write rather than a per-row patch, so
    /// a reorder stays atomic). The exclusion is about THIS verb's shape, not
    /// about position being unpersisted: within a column no HARNESS tool mirrors
    /// position (ADR 0075 — position is not evidence), but the human's drag is
    /// written and survives a restart.
    ///
    /// A missing row is `MissingTask`, not a silent `Ok`: this is a WRITE the
    /// caller believes succeeded.
    pub fn edit_task(
        &self,
        task_id: &str,
        title: FieldPatch<'_>,
        body: FieldPatch<'_>,
        spec_path: FieldPatch<'_>,
    ) -> Result<TaskRow, BoardError> {
        // THE TITLE CLEAN — before the lock, before the statement, exactly as
        // `create_task` and `write_artifact` do it, so a refused patch touches no
        // connection and the stored title is provably untouched.
        //
        // A `Set` only: `Keep` must not re-clean what is stored (that would rewrite
        // a title on an unrelated patch) and `Clear` is refused upstream. The cleaned
        // `String` is OWNED BY THIS FUNCTION so the `FieldPatch` below can borrow it
        // into `params!` — the bind needs a borrow that outlives the `execute`.
        let cleaned_title: Option<String> = match &title {
            FieldPatch::Set(raw) => {
                Some(crate::text::clean_title(raw, None).ok_or(BoardError::EmptyTitle)?)
            }
            _ => None,
        };
        // Rebuilt rather than mutated in place, and with no `unreachable!()` /
        // `expect()` anywhere: this runs inside `spawn_blocking`, where a panic is
        // the `JoinError` the router reports as `Io` — the exact failure the
        // `From<BoardError> for TaskStoreError` docblock refuses to introduce. A
        // non-`Set` patch therefore maps to the state it arrived as, by a match the
        // compiler checks and no runtime path can misreport.
        let title = match cleaned_title.as_deref() {
            Some(cleaned) => FieldPatch::Set(cleaned),
            None => match title {
                FieldPatch::Clear => FieldPatch::Clear,
                _ => FieldPatch::Keep,
            },
        };
        let guard = self.conn.lock().expect("db mutex poisoned");
        let touched = guard.execute(
            "UPDATE tasks SET \
               title     = CASE WHEN ?2 = 0 THEN title     WHEN ?2 = 1 THEN ?3  ELSE NULL END, \
               body      = CASE WHEN ?4 = 0 THEN body      WHEN ?4 = 1 THEN ?5  ELSE NULL END, \
               spec_path = CASE WHEN ?6 = 0 THEN spec_path WHEN ?6 = 1 THEN ?7  ELSE NULL END, \
               updated_at = ?8 \
             WHERE id = ?1",
            params![
                task_id,
                title.mode(),
                title.value(),
                body.mode(),
                body.value(),
                spec_path.mode(),
                spec_path.value(),
                now_ms(),
            ],
        )?;
        drop(guard);
        // The ONLY board write that refuses AFTER the write, and the reason is the
        // shape of the statement above: one fixed-arity UPDATE whose `CASE` arms
        // cannot fail, so `touched == 0` has exactly one reading — no row matched
        // `WHERE id`. Every other board write (`move_task`'s stage gate,
        // `create_task`'s number) checks first and writes nothing when it refuses;
        // this one is allowed to check after because nothing it can bind makes the
        // write itself fail.
        //
        // Which is also why an all-`Keep` patch, and a `Clear` on a column that is
        // already NULL, must NOT land here: SQLite counts an UPDATE that re-sets a
        // column to the value it already holds, so rowcount stays 1. Pinned by
        // `edit_task_clearing_an_already_null_column_is_not_reported_as_a_missing_task`.
        if touched == 0 {
            return Err(BoardError::MissingTask(task_id.to_string()));
        }
        self.get_task(task_id)?
            .ok_or_else(|| BoardError::MissingTask(task_id.to_string()))
    }

    /// Move a card to another column and report that column's `on_enter`.
    ///
    /// Reads `on_enter` AFTER the write, under the same lock — one read of the
    /// destination row, taken against the state the write landed in.
    ///
    /// The storage layer does NOT run the boost. `on_enter = 'compact'` needs
    /// `compact_session`, which needs the `SessionManager` — a command-layer
    /// object. Returning the value IS the seam (spec §5).
    ///
    /// Under `spaces.board_strict = 1` it ALSO refuses a move that is not an edge
    /// of the FROM stage's `next_slugs`, before writing (ADR 0099, spec §4.2).
    /// That check lives HERE rather than in the command layer for one structural
    /// reason: `delete_stage`'s bulk relocation must bypass it, `delete_stage` is a
    /// storage method, and a gate in the command layer would be out of its reach —
    /// the bypass is only free when the gate sits where the write is.
    pub fn move_task(
        &self,
        space_path: &str,
        task_id: &str,
        to_stage: &str,
    ) -> Result<MoveOutcome, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let exists: i64 = guard.query_row(
            "SELECT COUNT(*) FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(BoardError::MissingTask(task_id.to_string()));
        }
        if !stage_slug_exists(&guard, space_path, to_stage)? {
            return Err(missing_stage(&guard, space_path, to_stage));
        }
        // ADR 0099: the Strict-workflow gate, checked BEFORE the write so a
        // refused move writes nothing (the same refuse-before-write rule the
        // `stage_slug_exists` check above follows, under the same lock).
        //
        // Flag 0 — or no `spaces` row at all — means the check does not happen,
        // which is the entire compatibility story: an upgrade cannot change how an
        // existing board answers a drag.
        //
        // THE KEY IS `space_key(path)`, NOT the raw string, and that is not
        // cosmetic. `set_board_strict` (and `upsert_space`/`set_space_trusted`)
        // key `spaces` by the CANONICAL path with a raw fallback; `Db::board_strict`
        // reads with the same normalization. Read the flag by the raw string here
        // and the two disagree for any caller whose raw path is not its canonical
        // form (a symlink, a `..`, a trailing `/.`): the editor's Strict Switch
        // would show ON while drags are accepted, which is a workflow that binds
        // nothing while claiming to bind everything. Pinned by
        // `the_board_strict_read_and_the_move_gate_agree_on_a_non_canonical_path`.
        let strict_key = space_key(space_path).unwrap_or_else(|| space_path.to_string());
        let strict: i64 = guard
            .query_row(
                "SELECT board_strict FROM spaces WHERE path = ?1",
                params![strict_key],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if strict == 1 {
            // The FROM stage, read under THIS lock. The command layer also reads
            // it (to feed the `compact` boost's handoff sentence) and that read is
            // a separate, earlier lock — fine for the same reason `create_task`'s
            // numbering invariant is unaffected by a read beside it: this one
            // decides a WRITE, so it must be inside it.
            let from_stage: String = guard.query_row(
                "SELECT stage_slug FROM tasks WHERE id = ?1",
                params![task_id],
                |row| row.get(0),
            )?;
            let allowed: Option<String> = guard.query_row(
                "SELECT next_slugs FROM stages WHERE space_path = ?1 AND slug = ?2",
                params![space_path, from_stage],
                |row| row.get(0),
            )?;
            // NULL passes unconditionally: unconfigured is NOT forbidden
            // (ADR 0099 — the opposite reading would make every existing board
            // that opts in refuse every drag). A cell that is not a JSON array
            // leniently reads as NULL and therefore also passes.
            if let Some(json) = allowed {
                let edges: Vec<String> = lenient_next_slugs(Some(json)).unwrap_or_default();
                if !edges.iter().any(|edge| edge == to_stage) {
                    return Err(BoardError::StrictMoveRefused {
                        from: from_stage,
                        to: to_stage.to_string(),
                        // An explicit `[]` is a configured graph with no edges, so
                        // the sentence must say that rather than print nothing —
                        // an empty list reads like a bug, not like an answer.
                        allowed: if edges.is_empty() {
                            "(no outgoing transitions)".to_string()
                        } else {
                            edges.join(", ")
                        },
                    });
                }
            }
        }
        let touched = guard.execute(
            "UPDATE tasks SET stage_slug = ?3, updated_at = ?4 WHERE id = ?1 AND space_path = ?2",
            params![task_id, space_path, to_stage, now_ms()],
        )?;
        // The card exists but lives in ANOTHER Space: `id` is global and
        // `space_path` is not a key, so this is a caller that addressed a card
        // in the wrong namespace. The `UPDATE` matched 0 rows, and reporting
        // that as a stage that does not exist in THIS Space is the honest
        // sentence — a silent `Ok` here would show the user a card that never
        // moved.
        if touched == 0 {
            return Err(missing_stage(&guard, space_path, to_stage));
        }
        let on_enter: String = guard.query_row(
            "SELECT on_enter FROM stages WHERE space_path = ?1 AND slug = ?2",
            params![space_path, to_stage],
            |row| row.get(0),
        )?;
        Ok(MoveOutcome { on_enter })
    }
}
