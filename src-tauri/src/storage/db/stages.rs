//! The **Stage** subject of `db`: the six Stage verbs, the seed and the slug
//! helpers, lifted verbatim out of the unit that was `storage/db.rs` (ADR 0113).
//!
//! The helpers here are the ones the board read and the task verbs also call, so
//! they are `pub(super)` — the split is a navigation change, not a visibility
//! widening beyond what sibling→sibling calls require.

// WHY THIS FILE PANICS ON A POISONED MUTEX (AGENTS.md's poisoned-mutex rule):
// every `.expect("db mutex poisoned")` below guards `Db`'s ONE shared
// `rusqlite::Connection` — a single, shared resource a panic mid-transaction
// can leave genuinely unusable — so these sites panic rather than recover.
// They moved here with the methods that hold them; the rule and the in-repo
// worked example (`record_messages_batch`) are documented on that method.

use rusqlite::{params, Connection};

use super::rows::{stage_row_from, StageRow, STAGE_COLUMNS};
use super::{BoardError, Db};

impl Db {
    // ── The configurable Stage (issue #179, spec §4/§4.1/§5, ADRs 0098 + 0099) ──
    //
    // Six Stage verbs plus the Strict-workflow pair. Every WRITE here refuses
    // BEFORE it writes and names what it refused (ADR 0090), and every one that
    // returns a `StageRow` reads it back through the SAME
    // [`stage_row_by_slug`]/`stage_row_from` path the board read uses — so a
    // command's reply can never disagree with what a later `get_board` shows.

    /// Add a column to one Space's board.
    ///
    /// The slug arrives PRE-DERIVED from the command layer (spec §5 makes the
    /// label→slug mangling a WIRE rule, the `require_title` precedent — storage
    /// has no business importing the agent layer to munge text), but the rules are
    /// enforced HERE too because this is the last writer: an empty slug is refused,
    /// and a `(space_path, slug)` collision is refused rather than suffixed (a
    /// silent `spike-2` is a slug nobody typed).
    ///
    /// A new column joins at the BOTTOM (`MAX + 1`), the same `+1` join
    /// `upsert_space` uses — a new thing a person created goes where they can see
    /// it last, and never renumbers anything they already arranged.
    ///
    /// Does NOT seed. `create_stage` is reachable only from the board's editor,
    /// which is reading a board (`get_board`, which seeds) at the time; matching
    /// `list_stages`'s deliberate no-seed contract, a Stage verb never writes
    /// columns for a Space nobody has opened.
    pub fn create_stage(
        &self,
        space_path: &str,
        slug: &str,
        label: &str,
        skill: Option<&str>,
    ) -> Result<StageRow, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        if slug.trim().is_empty() {
            return Err(BoardError::EmptyStageSlug);
        }
        if stage_slug_exists(&guard, space_path, slug)? {
            return Err(BoardError::StageSlugTaken {
                slug: slug.to_string(),
                available: available_slugs(&guard, space_path)?,
            });
        }
        let next: i64 = guard.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM stages WHERE space_path = ?1",
            params![space_path],
            |row| row.get(0),
        )?;
        guard.execute(
            "INSERT INTO stages (space_path, slug, label, sort_order, on_enter_skill) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![space_path, slug, label, next, skill],
        )?;
        stage_row_by_slug(&guard, space_path, slug)
    }

    /// Rename a column's LABEL. The slug is FROZEN (spec §5): `stages` is keyed
    /// `(space_path, slug)` and `tasks.stage_slug` references that key by STRING
    /// with no foreign key, so writing the slug would orphan every card in the
    /// column exactly the way deleting it would — and a card's
    /// `<task stage="…">` block and `move_task`'s error both report the slug, so a
    /// renamed Stage keeps reporting its original one. That is why the editor shows
    /// the slug instead of hiding it.
    pub fn rename_stage(
        &self,
        space_path: &str,
        slug: &str,
        label: &str,
    ) -> Result<StageRow, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        if !stage_slug_exists(&guard, space_path, slug)? {
            return Err(missing_stage(&guard, space_path, slug));
        }
        guard.execute(
            "UPDATE stages SET label = ?3 WHERE space_path = ?1 AND slug = ?2",
            params![space_path, slug, label],
        )?;
        stage_row_by_slug(&guard, space_path, slug)
    }

    /// Set or clear the Skill a Session started from this column loads
    /// (`None` → NULL, ADR 0098). Orthogonal to `on_enter`, which is untouched:
    /// a column can compact AND carry a Skill.
    pub fn set_stage_skill(
        &self,
        space_path: &str,
        slug: &str,
        skill: Option<&str>,
    ) -> Result<StageRow, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        // Refuse before the write: an `UPDATE` matching zero rows is a silent 0,
        // and "which slug did I mistype" is the question the caller is asking.
        if !stage_slug_exists(&guard, space_path, slug)? {
            return Err(missing_stage(&guard, space_path, slug));
        }
        guard.execute(
            "UPDATE stages SET on_enter_skill = ?3 WHERE space_path = ?1 AND slug = ?2",
            params![space_path, slug, skill],
        )?;
        stage_row_by_slug(&guard, space_path, slug)
    }

    /// Set one column's outgoing transitions (ADR 0099), JSON-at-rest after the
    /// `sessions.todos_json` precedent.
    ///
    /// Every element is validated against THIS Space's own stages and an unknown
    /// one is a REJECTION naming the valid slugs — a silently dropped destination
    /// is a workflow that shrank, which is the failure mode ADR 0099 refuses twice.
    /// A slug equal to `slug` is refused too (a self-loop is a button that moves a
    /// card to the column it is already in).
    ///
    /// `[]` is a legal, meaningful configuration: it round-trips as
    /// `Some(vec![])`, NOT as NULL, because NULL means "unconfigured,
    /// unconstrained" and an explicit empty graph means "nothing may follow this
    /// column". Collapsing the two is the silent-green shape ADR 0099 rejects.
    pub fn set_stage_next(
        &self,
        space_path: &str,
        slug: &str,
        slugs: &[String],
    ) -> Result<StageRow, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        if !stage_slug_exists(&guard, space_path, slug)? {
            return Err(missing_stage(&guard, space_path, slug));
        }
        for wanted in slugs {
            if wanted == slug {
                return Err(BoardError::SelfLoop {
                    slug: slug.to_string(),
                });
            }
            if !stage_slug_exists(&guard, space_path, wanted)? {
                return Err(missing_stage(&guard, space_path, wanted));
            }
        }
        // Serialising a `&[String]` to JSON cannot fail: serde_json's failure modes
        // are a NaN/inf float, a map key that is not a string, or a `Serialize` impl
        // that errors, and none of the three is reachable from a list of `String`s.
        // `expect` states that rather than inventing an error arm `BoardError` has no
        // business carrying — and the worst case is a panic inside `spawn_blocking`,
        // which the command layer already flattens to `TasksError::Other`.
        let encoded = serde_json::to_string(slugs)
            .expect("a list of strings always serialises to a JSON array");
        guard.execute(
            "UPDATE stages SET next_slugs = ?3 WHERE space_path = ?1 AND slug = ?2",
            params![space_path, slug, encoded],
        )?;
        stage_row_by_slug(&guard, space_path, slug)
    }

    /// Rewrite the manual order of one Space's columns in ONE transaction.
    ///
    /// The FOURTH instance of this verb — `reorder_spaces`, `reorder_sessions`,
    /// `reorder_tasks`, and this — and it deliberately follows `reorder_spaces`,
    /// NOT `reorder_tasks`: the WHOLE slice the caller passes becomes the order,
    /// the index becomes `sort_order`, the numbers are dense from 0, and an id that
    /// matches no row is a SILENT NO-OP. `reorder_tasks` refuses an id outside its
    /// scope because a card id is global and a caller can hand back one from another
    /// column; a Stage slug cannot be "from another Space" in the same way, and the
    /// board's editor passes every Stage it shows, so refusing here would fail a
    /// legitimate drag over a row that raced it.
    pub fn reorder_stages(&self, space_path: &str, slugs: &[String]) -> Result<(), BoardError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        for (index, slug) in slugs.iter().enumerate() {
            tx.execute(
                "UPDATE stages SET sort_order = ?3 WHERE space_path = ?1 AND slug = ?2",
                params![space_path, slug, index as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a column: THREE refusals, then one relocation and one `DELETE`.
    ///
    /// 1. **It holds cards and the caller named nowhere to put them.** A Task whose
    ///    `stage_slug` names no row is invisible to `get_board` (which groups by
    ///    Stage) yet keeps costing money through its Sessions — so the cards would
    ///    survive the delete unreachable. `tasks.stage_slug` is `NOT NULL` with NO
    ///    foreign key (ADR 0090, by design), so SQLite will not catch it; the
    ///    refusal names the count and the slugs they could go to. Supply
    ///    `relocate_to` and the refusal becomes the relocation below — which is the
    ///    whole point of the parameter, and why the count check reads it first.
    /// 2. **Another column's graph points here.** Deleting it would silently shrink
    ///    someone's workflow — the alternative (filter dangling slugs at read time)
    ///    is rejected in ADR 0099 precisely because the shrink is invisible.
    /// 3. **It is the last column.** `create_task`'s "no explicit stage lands in the
    ///    first stage" fallback and `get_board`'s payload both assume ≥ 1 row.
    ///
    /// The relocation, when a destination is supplied, is ONE bulk `UPDATE` and
    /// never a `move_task` call — see the comment at the statement.
    pub fn delete_stage(
        &self,
        space_path: &str,
        slug: &str,
        relocate_to: Option<&str>,
    ) -> Result<(), BoardError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        if !stage_slug_exists(&guard, space_path, slug)? {
            return Err(missing_stage(&guard, space_path, slug));
        }
        // A destination must be a column of THIS Space — checked FIRST among the
        // writes' preconditions, so a refused delete neither deletes nor
        // relocates anything. It also comes before the cards refusal on purpose: a
        // caller who supplied a destination clearly intends to relocate the cards,
        // so "that destination is not one of this Space's columns" is the answer
        // they need, not "you have cards in here".
        if let Some(destination) = relocate_to {
            if !stage_slug_exists(&guard, space_path, destination)? {
                return Err(missing_stage(&guard, space_path, destination));
            }
        }
        // Refusal 1, before any other work: the count is the evidence. Supplied a
        // destination, the caller has said where the cards go and the relocation
        // below is exactly the answer; supplied none, the cards would be stranded,
        // so this is where the refusal lives.
        let cards: i64 = guard.query_row(
            "SELECT COUNT(*) FROM tasks WHERE space_path = ?1 AND stage_slug = ?2",
            params![space_path, slug],
            |row| row.get(0),
        )?;
        if cards > 0 && relocate_to.is_none() {
            return Err(BoardError::StageNotEmpty {
                slug: slug.to_string(),
                count: cards,
                available: available_slugs(&guard, space_path)?,
            });
        }
        // Refusal 2. The candidates come back as raw JSON and the match happens in
        // Rust through the SAME lenient parser the reader uses, rather than via
        // `json_each`: a cell SQLite cannot parse would error inside the SQL, and a
        // cell this file reads as "unconfigured" must not be able to BLOCK a delete
        // — it cannot be pointing anywhere, because nothing reads it as an edge.
        let referrers: Vec<String> = {
            let mut stmt = guard.prepare(
                "SELECT slug, next_slugs FROM stages \
                 WHERE space_path = ?1 AND slug != ?2 AND next_slugs IS NOT NULL",
            )?;
            let rows = stmt
                .query_map(params![space_path, slug], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .filter(|(_, raw)| {
                    lenient_next_slugs(raw.clone())
                        .is_some_and(|edges| edges.iter().any(|e| e == slug))
                })
                .map(|(pointing, _)| pointing)
                .collect()
        };
        if !referrers.is_empty() {
            return Err(BoardError::StageReferenced {
                slug: slug.to_string(),
                referrers: referrers.join(", "),
            });
        }
        // Refusal 3.
        let columns: i64 = guard.query_row(
            "SELECT COUNT(*) FROM stages WHERE space_path = ?1",
            params![space_path],
            |row| row.get(0),
        )?;
        if columns <= 1 {
            return Err(BoardError::LastStage {
                slug: slug.to_string(),
            });
        }

        let tx = guard.transaction()?;
        if let Some(destination) = relocate_to {
            // MUST NOT become a `move_task` call per card. `move_task` reads the
            // destination's `on_enter` and the COMMAND layer fires its boost, so
            // "empty this column first" would attempt one compaction per card as a
            // side effect of bookkeeping (spec §4.1, ADR 0099's Consequence). It
            // reads like good deduplication; it is the five-compactions bug.
            //
            // `updated_at` is deliberately UNTOUCHED for the reason `reorder_tasks`
            // gives: a relocation a delete forced is not an edit, and recency that
            // a person did not cause should not reorder their card list.
            tx.execute(
                "UPDATE tasks SET stage_slug = ?3 WHERE space_path = ?1 AND stage_slug = ?2",
                params![space_path, slug, destination],
            )?;
        }
        tx.execute(
            "DELETE FROM stages WHERE space_path = ?1 AND slug = ?2",
            params![space_path, slug],
        )?;
        tx.commit()?;
        Ok(())
    }
}

/// Parse a `next_slugs` cell, never failing: a value that is NULL, malformed, or
/// simply not a JSON array reads as "unconfigured" (`None`).
///
/// The board must never blank because ONE cell holds something a foreign writer
/// left behind (spec §3), and a `StageRow` mapper cannot return anything but a
/// row-reading error. The strictness lives in the WRITER — `set_stage_next`
/// validates every slug and serialises with `serde_json` — so the reader only
/// has to survive data older or foreigner than itself. Note `None` is
/// "unconfigured, unconstrained" (ADR 0099), so this fallback is the SAFE
/// reading: a corrupt cell loosens nothing the user configured correctly.
pub(super) fn lenient_next_slugs(raw: Option<String>) -> Option<Vec<String>> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
}

/// The ONE place a single `stages` row is read back after a write, through the
/// same [`STAGE_COLUMNS`] list and [`stage_row_from`] mapper the board read uses.
///
/// A Stage command returns the row it just wrote so the frontend can update that
/// column without a second round trip — which is only honest if the reply is built
/// by the same mapper the next `get_board` will use. A missing row is
/// `missing_stage` (with the valid slugs), not `Ok(None)`: every caller refused a
/// missing slug before writing, so reaching here means the row went away under us.
fn stage_row_by_slug(
    conn: &Connection,
    space_path: &str,
    slug: &str,
) -> Result<StageRow, BoardError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM stages WHERE space_path = ?1 AND slug = ?2",
        STAGE_COLUMNS.join(", ")
    ))?;
    match stmt.query_row(params![space_path, slug], stage_row_from) {
        Ok(row) => Ok(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(missing_stage(conn, space_path, slug)),
        Err(e) => Err(e.into()),
    }
}

/// Insert the five default stages when this Space has none.
///
/// Idempotence is NOT the property being claimed here — being called under the
/// CALLER's lock is. Every caller already holds `self.conn.lock()` and passes
/// the guard down, because a seed that took a lock of its own would put a second
/// lock between `create_task`'s `MAX(number)` read and its `INSERT`, which is
/// precisely the interleave ADR 0090 forbids.
///
/// Called from `get_board` (spec §2's lazy seed) AND from `create_task`: a card
/// cannot live in a Space with no columns, and `create_task` is reachable
/// without the board ever having been opened (a Task-creating command makes the
/// card and its Session together). The laziness the spec asks for is laziness
/// per SPACE — a Space nobody touches still gets no rows — and
/// `seeding_one_space_leaves_another_space_unseeded` pins that.
pub(super) fn seed_default_stages(
    conn: &mut Connection,
    space_path: &str,
) -> Result<(), BoardError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM stages WHERE space_path = ?1",
        params![space_path],
        |row| row.get(0),
    )?;
    if count > 0 {
        return Ok(());
    }
    // The five defaults, spec §2 + §3.1. `label` is the slug capitalised and
    // `sort_order` is the index; `on_enter` is left OUT of the column list so
    // the DDL's `DEFAULT 'none'` stays the single source of that value instead
    // of a second copy of it spelled here. `on_enter_skill` IS spelled here,
    // because a fresh Space must launch the same button an upgraded one
    // gets from the migration (ADR 0098, as amended by ADR 0107 — one launch
    // Skill survives, not two) — and `next_slugs` is deliberately
    // absent, so a seeded graph stays NULL = unconfigured (ADR 0099).
    for (index, (slug, label, skill)) in DEFAULT_STAGES.iter().enumerate() {
        conn.execute(
            "INSERT INTO stages (space_path, slug, label, sort_order, on_enter_skill) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![space_path, slug, label, index as i64, skill],
        )?;
    }
    Ok(())
}

/// The five default stages, in order: `(slug, label, on_enter_skill)`.
///
/// `approved` stays in the seed — deleting a column is the editor's job, not the
/// seed's (spec §3.1). `on_enter` stays out of the tuple so the DDL's
/// `DEFAULT 'none'` remains the single source of that value.
const DEFAULT_STAGES: [(&str, &str, Option<&str>); 5] = [
    ("backlog", "Backlog", None),
    ("research", "Research", Some("research")),
    ("approved", "Approved", None),
    ("doing", "Doing", None),
    ("done", "Done", None),
];

/// Does this Space have a stage with this slug?
pub(super) fn stage_slug_exists(
    conn: &Connection,
    space_path: &str,
    slug: &str,
) -> Result<bool, BoardError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM stages WHERE space_path = ?1 AND slug = ?2",
        params![space_path, slug],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

/// This Space's stage slugs, comma-joined in `sort_order` — the list ADR 0090
/// requires an invalid-slug rejection to carry, so the caller (a model, most
/// often) self-corrects without a schema-discovery round trip.
pub(super) fn available_slugs(conn: &Connection, space_path: &str) -> Result<String, BoardError> {
    let mut stmt = conn.prepare(
        "SELECT slug FROM stages WHERE space_path = ?1 ORDER BY sort_order ASC, slug ASC",
    )?;
    let slugs = stmt
        .query_map(params![space_path], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(slugs.join(", "))
}

/// The `MissingStage` for a slug this Space does not have, carrying the slugs it
/// does have.
pub(super) fn missing_stage(conn: &Connection, space_path: &str, wanted: &str) -> BoardError {
    BoardError::MissingStage {
        wanted: wanted.to_string(),
        available: available_slugs(conn, space_path).unwrap_or_default(),
    }
}
