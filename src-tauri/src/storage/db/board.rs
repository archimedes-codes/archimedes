//! The **board read** subject of `db`: the board payload, the two list reads, the
//! card reorder, the Session↔Task link and the board-level Strict toggle, lifted
//! verbatim out of the unit that was `storage/db.rs` (ADR 0113).
//!
//! The task WRITE verbs are in [`super::tasks`]; the Stage verbs in
//! [`super::stages`]; the artifact projection this read carries in
//! [`super::artifacts`]. The split is by subject, not by table.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover.
// They moved here with the methods that hold them; the rule and the in-repo
// worked example (`record_messages_batch`) are documented on that method.

use rusqlite::params;

use super::rows::{
    stage_row_from, task_number_row_from, task_row_from, task_session_row_from, StageWithTasks,
    TaskCardView, STAGE_COLUMNS, TASK_COLUMNS, TASK_SESSION_COLUMNS,
};
use super::seams::space_key;
use super::stages::{missing_stage, seed_default_stages, stage_slug_exists};
use super::{BoardError, Db, DbError, StageRow, TaskNumberRow, TaskRow, TaskSessionRow};

impl Db {
    // ── The Task board (spec §2, ADR 0090) ──────────────────────────────
    //
    // Every method here takes the connection lock ONCE and holds it for its
    // whole read-write pair — the same discipline `reorder_spaces` just showed.
    // For `create_task` that is not style, it is the point: the per-Space
    // `MAX(number) + 1` is TWO statements, and ADR 0090's Consequences name the
    // interleave they must not straddle.

    /// The board for one Space: every stage, in `sort_order`, each carrying its
    /// own cards.
    ///
    /// LAZY SEEDING happens here (spec §2): a Space with no `stages` rows gets
    /// the five defaults on the first board read, so a Space that never opens
    /// the board pays nothing and no migration writes for every existing Space.
    /// The count-check and the five inserts share ONE lock with the board read
    /// that follows, so two first-reads of the same Space cannot both seed.
    pub fn get_board(&self, space_path: &str) -> Result<Vec<StageWithTasks>, BoardError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        seed_default_stages(&mut guard, space_path)?;
        let stages = {
            let mut stmt = guard.prepare(&format!(
                "SELECT {} FROM stages WHERE space_path = ?1 ORDER BY sort_order ASC, slug ASC",
                STAGE_COLUMNS.join(", ")
            ))?;
            let rows = stmt
                .query_map(params![space_path], stage_row_from)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let tasks = {
            let mut stmt = guard.prepare(&format!(
                "SELECT {} FROM tasks WHERE space_path = ?1 \
                 ORDER BY sort_order ASC, number ASC",
                TASK_COLUMNS.join(", ")
            ))?;
            let rows = stmt
                .query_map(params![space_path], task_row_from)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        // Each card's linked Sessions plus the TWO per-Session facts the card
        // renders (issue #174, plus `ready`). This JOIN is not a convenience —
        // it is the ONLY channel by which the board learns a SQLite fact held on
        // `sessions` for a Session the board has never opened, which is what makes
        // a readiness mark survive a restart. THREE deliberate choices:
        //
        //   - `task_id IN (SELECT id FROM tasks WHERE space_path = ?1)`, NOT a
        //     `cwd` filter. A linked Session is not STRUCTURALLY in the card's
        //     Space — `sessions` has no `space_path` column, the Space is derived
        //     from `cwd` — so filtering on `cwd` would silently drop a link whose
        //     Session was started somewhere else, and pull in another Space's
        //     links whose Session happens to run in this directory. The scoping
        //     question is "whose card is this", and only `task_id` answers it.
        //     `?1` is ONE parameter bound once for the whole statement.
        //   - `JOIN`, not `LEFT JOIN`. `foreign_keys` is ON and
        //     `task_sessions.session_id` is `ON DELETE CASCADE`, so a link to a
        //     missing Session cannot exist; and if one somehow did, an inner join
        //     drops it rather than inventing a cost-less phantom link. (That same
        //     cascade is what makes the two joins indistinguishable HERE — the
        //     falsifiable pin is
        //     `deleting_a_linked_session_drops_its_link_row_and_its_share_of_the_cost`.)
        //   - `ORDER BY ts.rowid ASC`, table-qualified (unqualified `rowid` in a
        //     two-table join is an SQLite "ambiguous column name"), matching the
        //     oldest-first order `Db::task_sessions` already publishes.
        //
        // Stays AFTER `seed_default_stages`: the seed WRITES and every statement
        // below READS, so reordering them would put a read above a write.
        // `is_subagent` needs no filter: `start_task_session` is the only writer
        // of links and never creates a subagent Session, so no linked Session is
        // one today — filtering for a case that cannot occur would be a lie about
        // the writer set.
        //
        // `s.ready` is the FIFTH term and it sits AFTER `s.cost_usd` on purpose:
        // the row closure below reads the cost at position 3 and `ready` at
        // position 4, and `the_board_link_statement_selects_the_columns_the_const_owns`
        // pins position 3 as the literal `s.cost_usd`. Putting `ready` earlier
        // would silently make it the card's cost figure.
        let links = {
            let mut stmt = guard.prepare(
                "SELECT ts.task_id, ts.session_id, ts.stage_slug, s.cost_usd, s.ready \
                 FROM task_sessions ts \
                 JOIN sessions s ON s.id = ts.session_id \
                 WHERE ts.task_id IN (SELECT id FROM tasks WHERE space_path = ?1) \
                 ORDER BY ts.rowid ASC",
            )?;
            let rows = stmt
                .query_map(params![space_path], |row| {
                    Ok((
                        task_session_row_from(row)?,
                        row.get::<_, Option<f64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        // Each card's artifact KEYS, names only — the split's whole point is that
        // the BOARD never carries a document (spec §1, ADR 0100). FOURTH statement
        // under the SAME lock, still AFTER `seed_default_stages`'s write, and
        // Space-scoped exactly the way the links read above is: the question is
        // "whose card is this", only `task_id` answers it, and `?1` is bound ONCE
        // for the whole statement. No JOIN — `task_artifacts` has no FK and needs
        // none to answer this, and the `IN (SELECT …)` is what keeps another
        // Space's keys out of this payload.
        let artifact_keys = {
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
        // Group per stage in one pass. A card whose `stage_slug` matches no
        // stage row is DROPPED from this payload rather than given an invented
        // column: the board renders columns, and a column that does not exist
        // cannot be rendered. (`move_task` refuses such a slug, so this is
        // reachable only if a stage row is deleted out from under a card.)
        Ok(stages
            .into_iter()
            .map(|stage| StageWithTasks {
                tasks: tasks
                    .iter()
                    .filter(|task| task.stage_slug == stage.slug)
                    .map(|task| {
                        // The links are already oldest-first from the statement,
                        // so a stable filter keeps that order — no second sort.
                        let mine: Vec<&(TaskSessionRow, Option<f64>, Option<i64>)> = links
                            .iter()
                            .filter(|(link, _, _)| link.task_id == task.id)
                            .collect();
                        // ADR 0082: `None` means "never reported", `Some(0.0)`
                        // means "a real zero". This fold IS SQL's SUM over
                        // nullable inputs — NULL iff every input is NULL — done
                        // here rather than in SQL because the rule must stay
                        // visible and pinned to the type that carries it.
                        let mut cost: Option<f64> = None;
                        for (_, reported, _) in mine.iter() {
                            if let Some(value) = reported {
                                cost = Some(cost.unwrap_or(0.0) + value);
                            }
                        }
                        // THE READINESS FOLD, in two steps that are ONE decision.
                        // `sessions.ready` is a tri-state COLUMN (NULL = never
                        // claimed, 0 = explicitly not, 1 = claimed) and the card
                        // answers a BINARY question, so `Some(1)` is the only truthy
                        // value and NULL and 0 both fold to `false`. ADR 0082's
                        // NULL/zero distinction does NOT carry over: it exists
                        // because `cost_usd` renders a FIGURE and must tell "never
                        // reported" from "a real zero"; a bell renders NOTHING when
                        // the answer is no, so collapsing the two is honest here.
                        //
                        // STEP 1 — the ATTRIBUTION, over the same `mine` in the same
                        // order (links are oldest-first from the statement and the
                        // `mine` filter is stable, so this is oldest-link-first).
                        // `ready` says a bell is owed; this says WHO owes it — the
                        // one hop the optimistic clears lack, since they are handed a
                        // Session id and must not withdraw a mark that another
                        // Session is still carrying.
                        let ready_sessions: Vec<String> = mine
                            .iter()
                            .filter(|(_, _, claimed)| *claimed == Some(1))
                            .map(|(link, _, _)| link.session_id.clone())
                            .collect();
                        // STEP 2 — the BELL, DERIVED from the list instead of folded
                        // alongside it, so `ready == !ready_sessions.is_empty()` is
                        // STRUCTURAL and not a discipline two parallel folds could
                        // drift out of. The "one claimer is enough" OR is the
                        // `is_empty`, and the card-with-no-links case is the empty
                        // list, so the empty OR is still `false`.
                        let ready = !ready_sessions.is_empty();
                        // Same trick as `mine` above: the artifact rows arrived
                        // `(task_id, key)` ordered by `rowid ASC`, so a stable
                        // filter keeps each card's keys oldest-write-first with no
                        // second sort and no second query.
                        let mine_keys: Vec<String> = artifact_keys
                            .iter()
                            .filter(|(owner, _)| owner == &task.id)
                            .map(|(_, key)| key.clone())
                            .collect();
                        TaskCardView {
                            task: task.clone(),
                            sessions: mine.into_iter().map(|(link, _, _)| link.clone()).collect(),
                            cost_usd: cost,
                            artifact_keys: mine_keys,
                            ready,
                            ready_sessions,
                        }
                    })
                    .collect(),
                stage,
            })
            .collect())
    }

    /// Every stage of one Space, in `sort_order`, WITHOUT seeding.
    ///
    /// The read `get_board` groups over, exposed for callers that must not cause
    /// a write — the laziness guard
    /// (`seeding_one_space_leaves_another_space_unseeded`) reads through here,
    /// because reading through `get_board` would seed and so answer its own
    /// question.
    pub fn list_stages(&self, space_path: &str) -> Result<Vec<StageRow>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM stages WHERE space_path = ?1 ORDER BY sort_order ASC, slug ASC",
            STAGE_COLUMNS.join(", ")
        ))?;
        let rows = stmt
            .query_map(params![space_path], stage_row_from)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every card of one Space, in `sort_order`. The flat sibling of `get_board`.
    pub fn list_tasks(&self, space_path: &str) -> Result<Vec<TaskRow>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM tasks WHERE space_path = ?1 ORDER BY sort_order ASC, number ASC",
            TASK_COLUMNS.join(", ")
        ))?;
        let rows = stmt
            .query_map(params![space_path], task_row_from)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Rewrite the manual order of the cards WITHIN ONE COLUMN of one Space.
    ///
    /// THE OTHER HALF OF SPEC §3'S TWO DRAG VERBS. The table there gives a card
    /// dragged BETWEEN columns to `move_task` (writes `stage_slug`, runs
    /// `on_enter`) and a card dragged WITHIN a column to a write of "`sort_order`
    /// only". "Mirrored by nothing" in that table's third column means no
    /// HARNESS tool mirrors it — ADR 0075's "position is not evidence", applied
    /// inside a column, so the model never needs to see it. It does NOT mean
    /// unpersisted: a position a person drags and loses on restart is a bug, and
    /// the asymmetry is about the TOOL surface, not the storage surface.
    ///
    /// The shape is `reorder_spaces`/`reorder_sessions`, unchanged: ONE
    /// `conn.lock()`, ONE `transaction()`, one `UPDATE` per row, and the slice
    /// index becomes the stored value densely from 0.
    ///
    /// Three deliberate differences from `reorder_spaces`, each pinned by
    /// `reorder_tasks_persists_the_new_within_stage_order_in_one_pass` or
    /// `reorder_tasks_refuses_a_foreign_id_and_writes_nothing`:
    ///
    /// - **An id this call may not name is an ERROR, not a no-op.**
    ///   `reorder_spaces` treats an unknown id as a no-op because a path matching
    ///   no row is the only thing a caller can hand back. Here `tasks.id` is a
    ///   GLOBAL key while `space_path`/`stage_slug` are the caller's namespace
    ///   (ADR 0090: no foreign key, by design), so a caller CAN hand back a card
    ///   that exists in another Space or another column. Writing it would move a
    ///   card the user is not looking at — possibly into a column it is not in —
    ///   so the `WHERE` clause scopes on all three columns and a row it fails to
    ///   match is `MissingTask`, naming the id. The rejection returns from inside
    ///   the transaction, so the whole call is atomic: the cards the caller DID
    ///   name keep their old positions rather than landing half-renumbered.
    /// - **`updated_at` is NOT touched**, because spec §3 says `sort_order`
    ///   ONLY. `edit_task` and `move_task` both stamp it; this does not. A card
    ///   whose position changed did not change — a "last edited" clock that a
    ///   reorder moves is a clock that lies.
    /// - **No renumbering across stages.** `sort_order` is PER-SPACE, not
    ///   per-stage — `create_task`'s bottom join is
    ///   `MAX(sort_order) … WHERE space_path = ?1`, so one column's cards do not
    ///   own a private 0..n number line. This call therefore writes positions
    ///   ONLY for the ids it is handed, and a card it never names keeps its
    ///   number even when that number now collides with a freshly written one.
    ///   That is `reorder_sessions`' documented steady state, not corruption:
    ///   every board read is `ORDER BY sort_order ASC, number ASC`, which is
    ///   total, so the order stays deterministic, and a column renders only its
    ///   own cards, so no surface ever shows two columns' rows side by side by
    ///   `sort_order` alone. Renumbering the untouched columns to keep the column
    ///   globally unique would move cards the user did not drag, in columns they
    ///   are not looking at.
    pub fn reorder_tasks(
        &self,
        space_path: &str,
        stage_slug: &str,
        task_ids: &[String],
    ) -> Result<(), BoardError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        // The STAGE is checked first, before any write: a slug that is not one of
        // this Space's columns is the more informative answer than "the first id
        // you named is not in it", and ADR 0090's Consequence requires the
        // rejection to name the valid slugs so the caller self-corrects.
        if !stage_slug_exists(&guard, space_path, stage_slug)? {
            return Err(missing_stage(&guard, space_path, stage_slug));
        }
        let tx = guard.transaction()?;
        for (index, task_id) in task_ids.iter().enumerate() {
            let touched = tx.execute(
                "UPDATE tasks SET sort_order = ?3 \
                 WHERE id = ?1 AND space_path = ?2 AND stage_slug = ?4",
                params![task_id, space_path, index as i64, stage_slug],
            )?;
            if touched == 0 {
                // Either no row with this id, or a row the scope rejected. The
                // message is the same for both and the id is the useful half of
                // it; the early return drops the transaction without committing,
                // which rolls the whole call back.
                return Err(BoardError::MissingTask(task_id.to_string()));
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Record that a Session owns a card, and which stage it was linked at.
    ///
    /// `INSERT OR IGNORE`: the FIRST link wins, because the stage it recorded is
    /// the stage a later `compact` moves FROM — overwriting it would silently
    /// re-point the handoff. A missing Task is `MissingTask` (a write the caller
    /// believes succeeded).
    ///
    /// `session_id` is NOT checked for existence here: the FK
    /// (`REFERENCES sessions(id) ON DELETE CASCADE`, live because `Db::open`
    /// turns the `foreign_keys` pragma on) rejects a dangling link loudly at the
    /// statement, and a `sessions` lookup first would be a second lock spent on
    /// a check SQLite already makes.
    pub fn link_session(
        &self,
        task_id: &str,
        session_id: &str,
        stage_slug: Option<&str>,
    ) -> Result<(), BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let current: Option<String> = match guard.query_row(
            "SELECT stage_slug FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(slug) => Some(slug),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        let Some(stage) = stage_slug.map(str::to_string).or(current) else {
            return Err(BoardError::MissingTask(task_id.to_string()));
        };
        guard.execute(
            "INSERT OR IGNORE INTO task_sessions (task_id, session_id, stage_slug) \
             VALUES (?1, ?2, ?3)",
            params![task_id, session_id, stage],
        )?;
        Ok(())
    }

    /// The Sessions linked to one card, oldest link first. The read behind
    /// "which Session does this card own", and the board's survival assertion.
    pub fn task_sessions(&self, task_id: &str) -> Result<Vec<TaskSessionRow>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM task_sessions WHERE task_id = ?1 ORDER BY rowid ASC",
            TASK_SESSION_COLUMNS.join(", ")
        ))?;
        let rows = stmt
            .query_map(params![task_id], task_session_row_from)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Which **Task** every **Session** wears — the badge read, app-wide.
    ///
    /// The other direction of `task_sessions` is what everything else in the file
    /// reads: `Db::task_sessions(task_id)` and `get_board`'s link statement both
    /// go task → sessions, so nothing here could answer "which card does THIS
    /// Session belong to" without a per-Space board fetch. This is that read.
    ///
    /// App-wide, NO `space_path` filter (spec D3), and that is the design rather
    /// than an oversight: the badge also renders on Settings → **Detached
    /// sessions**, whose Spaces have no tab and therefore no loaded board to read
    /// a number out of. One round trip at boot, one row per Session, so the
    /// frontend holds ONE map and never pays per Space tab.
    ///
    /// The SQL, and the four rules it carries:
    ///   - `WHERE ts2.session_id = ts.session_id` with `MAX(ts2.rowid)` picks the
    ///     NEWEST link (D5). It is the CORRELATED form this file already uses in
    ///     `LAST_ACTIVITY` (the parent's private const — de-bracketed, because a
    ///     link to a private item is its own rustdoc warning), and it stays that
    ///     form — there is no `GROUP BY` anywhere in this file and this is not where
    ///     one starts. `rowid` is SQLite's insert-order counter, so "newest" means
    ///     "linked last", which is
    ///     what a badge should follow when a Session has been handed between cards.
    ///   - The winner is chosen BEFORE the join, which is the whole of D6: a
    ///     Session whose NEWEST link names a Task that does not resolve gets NO
    ///     row, not its older link's number. A `LEFT JOIN` or a fallback-to-the-
    ///     newest-resolving-link would put a number on a Session that no longer
    ///     wears one. `task_sessions_cascade_with_the_session_and_not_with_the_space`
    ///     explains why a dangling `task_id` is even possible (no FK, by ADR 0090);
    ///     `task_numbers_returns_the_most_recent_link_per_session_and_nothing_for_a_gone_task`
    ///     pins this arm, both halves of it.
    ///   - `JOIN` (INNER), per D6, for the reason `get_board`'s link statement
    ///     gives for the same choice: an inner join DROPS a link it cannot resolve
    ///     rather than inventing a row for it.
    ///   - `ORDER BY ts.session_id` costs a temp b-tree and buys determinism:
    ///     without it the row order is whatever the planner reaches first, and every
    ///     assertion in this sibling's tests (`tests/board.rs`) would be a
    ///     set-comparison instead of an `assert_eq!` on a `Vec`.
    ///
    /// The projection is spelled INLINE, not interpolated from
    /// `TASK_NUMBER_COLUMNS`, for the reason documented on that const: every term
    /// is table-qualified by the join. The guard is the behavioural test named
    /// above, which asserts all three fields positionally.
    ///
    /// The `AS` on the outer alias is load-bearing for a test two files away.
    /// `the_board_link_statement_selects_the_columns_the_const_owns` (in
    /// `tests/board.rs`) reads THIS file's text and requires its anchor — the
    /// `FROM` clause spelling `task_sessions` followed by the BARE `ts` alias, which
    /// only `get_board`'s link statement above uses — to occur EXACTLY ONCE, because
    /// it slices the projection that sits immediately before the first match.
    /// Measured here: that anchor occurs once today; dropping `AS` from this
    /// statement's outer alias takes it to 2, and dropping it from the inner `ts2`
    /// alias too takes it to 3 (`ts2` starts with `ts`, so it matches the same
    /// literal). Either way a pin about the BOARD's link statement reddens with a
    /// message pointing nowhere near this read. `AS` is plain SQLite and costs
    /// nothing. (The same arithmetic is why this comment does not spell the anchor
    /// out verbatim: that test greps the whole FILE, doc comments included, so
    /// quoting its own anchor here would itself break the count.)
    ///
    /// PANICS ON A POISONED MUTEX, and this site is no exception to the file's own
    /// rule: this lock guards `Db`'s ONE shared `rusqlite::Connection`, so
    /// recovering would hand the next caller a connection of unknown state (see
    /// `record_messages_batch` for the full statement of AGENTS.md's poisoned-mutex
    /// rule — per-key state recovers, one shared resource does not).
    pub fn task_numbers(&self) -> Result<Vec<TaskNumberRow>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT ts.session_id, t.number, ts.stage_slug \
             FROM task_sessions AS ts \
             JOIN tasks AS t ON t.id = ts.task_id \
             WHERE ts.rowid = (SELECT MAX(ts2.rowid) FROM task_sessions AS ts2 \
                               WHERE ts2.session_id = ts.session_id) \
             ORDER BY ts.session_id",
        )?;
        let rows = stmt
            .query_map([], task_number_row_from)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The Strict-workflow toggle (ADR 0099), keyed by `space_key` exactly as
    /// `set_space_trusted` keys `trusted` — canonical with a raw fallback, so the
    /// toggle lands on the row the board's own reads look for.
    ///
    /// `Ok(n > 0)`: a missing `spaces` row is a SILENT NO-OP rather than an error,
    /// mirroring `set_space_trusted` — the toggle lives on the board, and the board
    /// is reachable for a Space with no `spaces` row (a Detached Space, and every
    /// board test in this file). Returns whether a row matched, so the caller can
    /// tell the two apart.
    ///
    /// NOT a board-table write despite living in the board family: it writes
    /// `spaces.board_strict`, hence `DbError` and not `BoardError` (the same split
    /// `set_space_trusted` draws).
    pub fn set_board_strict(&self, space_path: &str, strict: bool) -> Result<bool, DbError> {
        let key = space_key(space_path).unwrap_or_else(|| space_path.to_string());
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE spaces SET board_strict = ?2 WHERE path = ?1",
            params![key, strict],
        )?;
        Ok(n > 0)
    }

    /// Read the Strict-workflow flag back (ADR 0099).
    ///
    /// The WRITE alone would leave the flag unwritable-to-the-eye: the editor's
    /// `Strict workflow` Switch has to be SEEDED from the stored value, and a board
    /// header's Strict marker needs the same read. So this is the read twin of
    /// `set_board_strict`, and the two MUST keep one key rule — `space_key` with the
    /// raw fallback, "no row" meaning `false` — because a Switch that reads one way
    /// and a `move_task` gate that reads another is the exact disagreement this pair
    /// exists to prevent: a Strict label on a board that accepts any drag. The
    /// enforcement in `move_task` uses the same normalization, and
    /// `the_board_strict_read_and_the_move_gate_agree_on_a_non_canonical_path` pins
    /// the agreement on a path whose raw spelling differs from its canonical one.
    ///
    /// A `bool`, not a row type, and `DbError` rather than `BoardError`: the flag is
    /// per-Space data on `spaces`, and the row may legitimately be absent.
    pub fn board_strict(&self, space_path: &str) -> Result<bool, DbError> {
        let key = space_key(space_path).unwrap_or_else(|| space_path.to_string());
        let guard = self.conn.lock().expect("db mutex poisoned");
        // `unwrap_or(0)` folds "no such row" and "the row holds NULL" into the same
        // answer the DDL's DEFAULT gives, which is exactly what `move_task` computes
        // for the same Space.
        let flag: i64 = guard
            .query_row(
                "SELECT board_strict FROM spaces WHERE path = ?1",
                params![key],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(flag == 1)
    }
}
