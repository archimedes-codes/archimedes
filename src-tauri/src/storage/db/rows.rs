//! The **rows and view types** of `db`: every `SELECT` list const, every
//! positional mapper, the compile-time arity ties, the row structs and the view
//! structs, lifted verbatim out of the unit that was `storage/db.rs` (ADR 0113).
//!
//! This is the three-piece shape the whole unit is built on — the struct, the ONE
//! column list as a const array, the ONE positional mapper — plus the tie that
//! rejects a half-renumbered pair at compile time and the drift-guard TEST (in
//! `super::tests`) that is the actual guard. (Not a link, deliberately: that module is
//! `#[cfg(test)]`, so no `cargo doc` build can resolve a path to it.)
//!
//! `MessageRow` and `SessionRow` are NOT here: they live in
//! `fulcrum_harness::store_rows` (Step B-bis) and are re-exported by
//! [`super`] so every existing spelling resolves unchanged.
//!
//! ONE upward edge, so "everything is built on this" is not the whole picture:
//! `task_row_from` below calls [`super::stages::lenient_next_slugs`] to decode a Stage's
//! `next_slugs` JSON, and `stages.rs` imports this module for its row types — a
//! two-way edge. It is PRE-EXISTING (both calls lived in the single `db.rs` and were
//! merely made cross-file by the split), so it is named here rather than restructured
//! away: moving the decoder would put a row mapper's dependency in front of the row
//! types it depends on, which is the same knot tied from the other side.

use rusqlite::Row;
use serde::{Deserialize, Serialize};

use fulcrum_harness::store_rows::{MessageRow, SessionRow};

use super::stages::lenient_next_slugs;

/// The ONE `sessions` SELECT list every `SessionRow` read uses, as a const
/// array of column names.
///
/// It exists so the list and the mapper cannot be edited apart: the three
/// reads (`session`, both `list_sessions` arms) interpolate THIS list, and the
/// one mapper below reads it position-for-position. Before this const, each
/// read spelled its own copy of the 9 names and each built its own positional
/// `get` ladder — the F12 hazard: a list edited without its ladder compiles and
/// mis-maps at runtime.
///
/// The honest scope of what keeps them in sync: the per-row-type drift-guard
/// TEST (`session_row_from_maps_the_select_const_columns_in_order`, which
/// asserts `column_count() == SESSION_ROW_FIELDS` before any value) is the
/// guard. The const is what makes that test able to speak about the SELECT at
/// all; it is not itself a compile-time check of the SELECT text.
pub(super) const SESSION_COLUMNS: [&str; 10] = [
    "id",
    "cwd",
    "created_at",
    "title",
    "capabilities_json",
    "archived",
    "context_usage_json",
    "is_subagent",
    "cost_usd",
    "title_stage",
];

pub(super) const SESSION_ROW_FIELDS: usize = 10;
// Compile-time arity tie ONLY: the length of the const list must equal
// SESSION_ROW_FIELDS. It cannot see a column appended to both the const AND the
// field count in one edit, and it cannot see the SELECT statement at all — the
// per-row-type drift-guard TEST
// (`session_row_from_maps_the_select_const_columns_in_order`, in
// `storage/db/tests/`) is the guard. What this tie does buy: renumbering one
// literal without the other fails to compile, so a half-finished edit is
// rejected at once. It is kept for that fast rejection, not as the guard.
const _: [(); SESSION_COLUMNS.len()] = [(); SESSION_ROW_FIELDS];

/// Map one row of [`SESSION_COLUMNS`] onto a [`SessionRow`], index for index.
///
/// The ONE place a `SessionRow` is constructed (3 call sites: `session`, both
/// `list_sessions` arms). The `get::<_, i64>` calls on the two INTEGER-as-bool
/// columns are a RUNTIME conversion, not a compile-time check: a DDL type change
/// makes them fail loudly with `InvalidColumnType` instead of silently
/// mis-mapping, but they do not catch a column appended to the const (see the
/// drift-proof in the plan — the drift-guard TEST owns that class).
pub(super) fn session_row_from(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        cwd: row.get(1)?,
        created_at: row.get(2)?,
        title: row.get(3)?,
        capabilities_json: row.get(4)?,
        archived: row.get::<_, i64>(5)? != 0,
        context_usage_json: row.get(6)?,
        is_subagent: row.get::<_, i64>(7)? != 0,
        cost_usd: row.get(8)?,
        title_stage: row.get(9)?,
    })
}

/// The ONE `messages` SELECT list every `MessageRow` read uses, as a const
/// array of column names — same reason and same honest scope as
/// [`SESSION_COLUMNS`] (the drift-guard TEST is the guard).
pub(super) const MESSAGE_COLUMNS: [&str; 6] = [
    "id",
    "session_id",
    "kind",
    "message_key",
    "payload_json",
    "created_at",
];

pub(super) const MESSAGE_ROW_FIELDS: usize = 6;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS above for the honest
// scope: it catches a half-renumbered edit, it cannot see the SELECT, and the
// drift-guard TEST (`message_row_from_maps_the_select_const_columns_in_order`)
// is the guard.
const _: [(); MESSAGE_COLUMNS.len()] = [(); MESSAGE_ROW_FIELDS];

/// Map one row of [`MESSAGE_COLUMNS`] onto a [`MessageRow`], index for index.
///
/// The ONE place a `MessageRow` is constructed (3 call sites: `messages_for`,
/// both `messages_page` arms). Every column here is a plain `row.get` — the
/// table holds no INTEGER-as-bool column, so there is nothing to type-annotate.
pub(super) fn message_row_from(row: &Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        kind: row.get(2)?,
        message_key: row.get(3)?,
        payload_json: row.get(4)?,
        created_at: row.get(5)?,
    })
}

/// A row from the `spaces` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRow {
    pub path: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub last_opened_at: i64,
    /// Trusted Space flag (untrusted by default; fail-closed reads).
    pub trusted: bool,
}

/// The ONE `spaces` SELECT list `list_spaces` uses, as a const array of column
/// names — same reason and same honest scope as [`SESSION_COLUMNS`].
///
/// `sort_order` is deliberately ABSENT: `SpaceRow` predates manual ordering and
/// `list_spaces` consumes that column only in its `ORDER BY`, never as a field.
/// Adding it here would change the wire type `Vec<SpaceRow>` that
/// `commands/spaces.rs` returns, so its absence is a decision, not an omission.
pub(super) const SPACE_COLUMNS: [&str; 4] = ["path", "created_at", "last_opened_at", "trusted"];

pub(super) const SPACE_ROW_FIELDS: usize = 4;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS above for the honest
// scope; the drift-guard TEST
// (`space_row_from_maps_the_select_const_columns_in_order`) is the guard.
const _: [(); SPACE_COLUMNS.len()] = [(); SPACE_ROW_FIELDS];

/// Map one row of [`SPACE_COLUMNS`] onto a [`SpaceRow`], index for index.
///
/// The ONE place a `SpaceRow` is constructed (1 call site: `list_spaces`).
/// `trusted` is the INTEGER-as-bool column, so its `get::<_, i64>` is a runtime
/// conversion (a loud `InvalidColumnType` on a DDL type change), not a
/// compile-time check — see the drift-proof in the plan.
pub(super) fn space_row_from(row: &Row<'_>) -> rusqlite::Result<SpaceRow> {
    Ok(SpaceRow {
        path: row.get(0)?,
        created_at: row.get(1)?,
        last_opened_at: row.get(2)?,
        trusted: row.get::<_, i64>(3)? != 0,
    })
}

// ── The Task board rows (spec §2, ADR 0090) ────────────────────────────────
//
// Same three-piece shape every row type in this file uses: the struct, the ONE
// SELECT list as a const array, and the ONE positional mapper — plus the
// compile-time arity tie and the drift-guard test that spells the column list a
// second time (`task_row_from_maps_the_select_const_columns_in_order`,
// `stage_row_from_…`). The const is not itself a check of the SELECT text; the
// test is what makes editing the list and the ladder apart impossible.

/// A row from the `stages` table — one board column.
///
/// Keyed `(space_path, slug)`: a slug is unique WITHIN a Space, so two Spaces
/// can both have a `doing` column with different `on_enter` settings.
///
/// NOT `Eq`, and that is load-bearing rather than careless, exactly as
/// [`StageWithTasks`] documents for itself: the two canvas coordinates are
/// `f64`, and `f64` is not `Eq` (no reflexive equality over `NaN`). Nothing keys
/// a `StageRow` in a `HashSet`/`BTreeMap` (verified: zero hits for
/// `HashSet<StageRow>`/`HashMap<StageRow…`/`BTreeSet<StageRow`), and `PartialEq`
/// is all `assert_eq!` needs — the same derive set `TaskCardView` and
/// `StageWithTasks` already carry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRow {
    pub space_path: String,
    pub slug: String,
    pub label: String,
    pub sort_order: i64,
    /// `'none' | 'compact' | 'fresh'` (spec §5). A free-form string rather than
    /// an enum on purpose: the value is DATA a user can change per Space, and
    /// the DDL's default is what a seeded stage carries.
    pub on_enter: String,
    /// ADR 0098: the Skill a Session started from this column loads
    /// (`NULL` = no Skill). A second column rather than a widened `on_enter`,
    /// because `on_enter`'s value is rendered RAW as the column-header chip — a
    /// composite `'fresh:discuss'` would print as a label — and the two are
    /// orthogonal (a Stage can be `compact` AND carry a Skill).
    pub on_enter_skill: Option<String>,
    /// ADR 0099: the outgoing transition-graph edges as this column's LEGAL
    /// destinations, in button-render order, JSON-at-rest (`NULL` =
    /// UNCONFIGURED, which means unconstrained — deliberately NOT "no edges").
    /// Leniently parsed: any value that is not a JSON array reads as `None`,
    /// never as an error (spec §3).
    pub next_slugs: Option<Vec<String>>,
    /// The per-column auto-advance flag (the workflow-graph work): ON means a
    /// card LAUNCHED on this column advances itself when its Session settles,
    /// rather than waiting for a person to drag it.
    ///
    /// A `bool` over the DDL's `INTEGER NOT NULL DEFAULT 0`, following the
    /// `spaces.board_strict` precedent — a two-valued flag with no third state to
    /// protect, so there is nothing for a `NULL` to mean and `NOT NULL` is what
    /// says so. The default is OFF, and that is the compatibility story: adding
    /// the capability must not make an existing board advance anything.
    pub auto: bool,
    /// Extra prompt text prepended BEFORE this column's Skill launch (the
    /// workflow-graph work) — the per-column half of "what this column says when
    /// it starts a Session", beside `on_enter_skill`'s "which Skill it loads".
    ///
    /// `NULL` means NO extra prompt, and it is the ONLY spelling of that: the
    /// column carries no `DEFAULT`, so an upgraded database gains NULL rather than
    /// a second, equivalent empty-string state. `Some("")` is therefore a stored
    /// VALUE a person typed, not a clear — clearing is `None`
    /// (`Db::set_stage_prompt_prefix`, whose parameter is an `Option` for exactly
    /// that reason). Stored RAW: nothing here trims, templates or interprets it.
    pub prompt_prefix: Option<String>,
    /// The X of this column's node on the Workflows canvas, in canvas
    /// coordinates — the hand-arranged half of the layout (the canvas's
    /// n8n-style "drag it where you want it and it stays").
    ///
    /// `None` means NEVER HAND-ARRANGED and it is the ONLY spelling of that: the
    /// canvas runs dagre for the node. `Some(0.0)` is a DIFFERENT answer — a
    /// person pinned it to the origin — and the two are never collapsed anywhere,
    /// which is why neither column has a SQL `DEFAULT` (both gates in `Db::open`,
    /// both `dflt_value`s pinned). A `DEFAULT 0` would migrate every existing
    /// board to "hand-placed at (0, 0)" and stack every node on top of every
    /// other one.
    ///
    /// ALWAYS READ AS A PAIR with [`Self::position_y`]. A node is a BOX, so half a
    /// coordinate is a lie about where a box is; the state has no spelling at the
    /// write (`Db::set_stage_position` takes one `Option<(f64, f64)>`) and is
    /// refused at the wire (`require_position_pair`). A half-set row is therefore
    /// only reachable through a writer that bypassed both, and a reader finding
    /// one has permission to treat the node as unpositioned — nothing here
    /// promises to repair what it cannot have produced.
    pub position_x: Option<f64>,
    /// The Y of this column's node on the Workflows canvas — see
    /// [`Self::position_x`] for the pair's semantics, which are identical.
    pub position_y: Option<f64>,
}

/// The ONE `stages` SELECT list every read uses, as a const array of column
/// names — same reason and same honest scope as [`SESSION_COLUMNS`].
///
/// This is an EXPLICIT column list and there is no `SELECT *` anywhere in
/// production: the invariant ADR 0119's rollback story rests on, because a
/// rolled-back build whose extra columns are simply un-named keeps working, while
/// a `SELECT *` would change a positional mapper's index ladder on the next
/// migration and read the wrong column into the wrong field.
///
/// The two #179 columns and the two workflow columns go at the END, not in the
/// middle: [`stage_row_from`] reads by POSITION, so appending keeps every
/// existing index stable and a reorder cannot silently swap two fields' meanings.
/// The two canvas coordinates append the same way, for the same reason.
pub(super) const STAGE_COLUMNS: [&str; 11] = [
    "space_path",
    "slug",
    "label",
    "sort_order",
    "on_enter",
    "on_enter_skill",
    "next_slugs",
    "auto",
    "prompt_prefix",
    "position_x",
    "position_y",
];

pub(super) const STAGE_ROW_FIELDS: usize = 11;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS for the honest scope;
// the drift-guard TEST is the guard.
const _: [(); STAGE_COLUMNS.len()] = [(); STAGE_ROW_FIELDS];

/// Map one row of [`STAGE_COLUMNS`] onto a [`StageRow`], index for index.
pub(super) fn stage_row_from(row: &Row<'_>) -> rusqlite::Result<StageRow> {
    Ok(StageRow {
        space_path: row.get(0)?,
        slug: row.get(1)?,
        label: row.get(2)?,
        sort_order: row.get(3)?,
        on_enter: row.get(4)?,
        on_enter_skill: row.get::<_, Option<String>>(5)?,
        next_slugs: lenient_next_slugs(row.get::<_, Option<String>>(6)?),
        // The flag is a plain INTEGER, NOT JSON — no lenient parser here, and a
        // `!= 0` rather than `== 1` so a foreign writer that stores `2` reads as
        // ON rather than silently as OFF.
        auto: row.get::<_, i64>(7)? != 0,
        prompt_prefix: row.get::<_, Option<String>>(8)?,
        // The two canvas coordinates, `REAL` and both nullable. Read as plain
        // `Option<f64>` — no lenient parser (that is `next_slugs`'s JSON problem,
        // not a numeric one) and no `0.0` fallback: a NULL must arrive as `None`,
        // because `None` is "dagre lays this node out" and `Some(0.0)` is "a
        // person put it at the origin". A DDL type change is a loud
        // `InvalidColumnType` here, exactly as every other rung of this ladder is.
        position_x: row.get::<_, Option<f64>>(9)?,
        position_y: row.get::<_, Option<f64>>(10)?,
    })
}

/// A row from the `tasks` table — one board card.
///
/// `id` (`tsk_<uuid>`) is the key and resolves GLOBALLY; `number` is the label
/// a person says out loud ("move T3 to doing") and is per-Space, which is why
/// addressing a card by its bare number needs the Space (ADR 0090's last
/// Consequence). They are never interchangeable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: String,
    pub space_path: String,
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    /// The spec document this card cites. A Task is NOT a `docs/roadmap/*.md`
    /// (ADR 0090 — that directory is gitignored and its plans are deleted on
    /// ship), so the link is a nullable path and nothing cascades from it.
    pub spec_path: Option<String>,
    pub stage_slug: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The ONE `tasks` SELECT list every read uses — see [`SESSION_COLUMNS`].
pub(super) const TASK_COLUMNS: [&str; 10] = [
    "id",
    "space_path",
    "number",
    "title",
    "body",
    "spec_path",
    "stage_slug",
    "sort_order",
    "created_at",
    "updated_at",
];

pub(super) const TASK_ROW_FIELDS: usize = 10;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS for the honest scope.
const _: [(); TASK_COLUMNS.len()] = [(); TASK_ROW_FIELDS];

/// Map one row of [`TASK_COLUMNS`] onto a [`TaskRow`], index for index.
///
/// The ONE place a `TaskRow` is constructed. `body`/`spec_path` are nullable
/// columns, so their `get::<_, Option<String>>` is a runtime conversion, not a
/// compile-time check — the drift-guard test is what catches a reordered list.
pub(super) fn task_row_from(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: row.get(0)?,
        space_path: row.get(1)?,
        number: row.get(2)?,
        title: row.get(3)?,
        body: row.get::<_, Option<String>>(4)?,
        spec_path: row.get::<_, Option<String>>(5)?,
        stage_slug: row.get(6)?,
        sort_order: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// A row from the `task_sessions` table: which Session a card owns, and which
/// stage it was in when the link was made (so a later drag into a `compact`
/// stage knows which stage to compact FROM — spec §5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSessionRow {
    pub task_id: String,
    pub session_id: String,
    pub stage_slug: Option<String>,
}

/// The `task_sessions` column list, in the order [`task_session_row_from`] reads
/// it by POSITION. `Db::task_sessions` interpolates it; `get_board`'s link
/// statement cannot (it joins `sessions`, so it must qualify these same names
/// with `ts.`) and is pinned against it instead by
/// `the_board_link_statement_selects_the_columns_the_const_owns` — NOT the only
/// `task_sessions` projection in the file, so a rename or a reorder here must be
/// mirrored there or that pin reddens.
pub(super) const TASK_SESSION_COLUMNS: [&str; 3] = ["task_id", "session_id", "stage_slug"];

const TASK_SESSION_ROW_FIELDS: usize = 3;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS for the honest scope.
const _: [(); TASK_SESSION_COLUMNS.len()] = [(); TASK_SESSION_ROW_FIELDS];

/// Map one row of [`TASK_SESSION_COLUMNS`] onto a [`TaskSessionRow`].
pub(super) fn task_session_row_from(row: &Row<'_>) -> rusqlite::Result<TaskSessionRow> {
    Ok(TaskSessionRow {
        task_id: row.get(0)?,
        session_id: row.get(1)?,
        stage_slug: row.get::<_, Option<String>>(2)?,
    })
}

/// Which **Task** one **Session** wears: the per-Space `tasks.number` of the most
/// recently LINKED Task that still resolves, plus the **Stage** it was in when that
/// link was made. ONE row per Session at most — the badge has one slot, and the
/// tie-break is `MAX(rowid)` in SQL, never in the renderer (which would give the
/// rule two owners).
///
/// NO row at all when the Session has no link, or when its linked Task is gone:
/// the read INNER JOINs `tasks`, so a dangling `task_sessions.task_id` (which
/// SQLite will not reject — that table has no FK on `task_id`) produces absence
/// rather than a stale number. A **Task has no production delete verb**, so today
/// that arm is unreachable; it is here so the read is honest if one lands.
///
/// All-scalar, so it derives `Eq` like every other all-scalar row in this region
/// (only the two that carry an `f64` stop at `PartialEq`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNumberRow {
    pub session_id: String,
    pub task_number: i64,
    /// The FROZEN lane — `task_sessions.stage_slug`, the **Stage** the card was in
    /// when this Session was linked, NOT where the card sits now. Nullable because
    /// the column is nullable. It is already correct by construction:
    /// `launchTaskSession` moves the card BEFORE starting the Session (its rule 1,
    /// "Move before start") and passes `stage_slug: None` so RUST resolves it, so a
    /// backlog → research launch records `research`. A card dragged to Done later
    /// does NOT change this value, and that is the point — it answers "where was
    /// this Session's work started", which is the only question a Session can answer
    /// about a card it does not own.
    pub stage_slug: Option<String>,
}

/// The three projection terms of `Db::task_numbers`, in the order
/// [`task_number_row_from`] reads them by POSITION.
///
/// This is the ONE row type in the region whose SELECT list is NOT interpolated
/// from this const, and the reason is the same one that makes
/// `TASK_SESSION_COLUMNS` a const TWO statements cannot diverge on while this
/// statement spells itself: the names here are table-QUALIFIED (`ts.`, `t.`)
/// because the read joins `tasks`, and a `join(", ")` of unqualified column names
/// cannot produce them. `TASK_SESSION_COLUMNS` serves two statements; there is
/// ONE statement here, so the list is spelled inline in the SQL and this const
/// carries the compile-time arity tie. THE GUARD IS THE TEST —
/// `task_numbers_returns_the_most_recent_link_per_session_and_nothing_for_a_gone_task`
/// asserts all three values positionally (`session_id`, then `number`, then the
/// link's own `stage_slug`), so a projection edited apart from this ladder
/// mis-assigns a field and reddens there. Same honest scope as every other arity
/// tie in this file: the const cannot see the SQL text.
const TASK_NUMBER_COLUMNS: [&str; 3] = ["ts.session_id", "t.number", "ts.stage_slug"];

const TASK_NUMBER_ROW_FIELDS: usize = 3;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS for the honest scope.
const _: [(); TASK_NUMBER_COLUMNS.len()] = [(); TASK_NUMBER_ROW_FIELDS];

/// Map one row of [`TASK_NUMBER_COLUMNS`] onto a [`TaskNumberRow`], index for
/// index.
///
/// `stage_slug` is a nullable column, so its `get::<_, Option<String>>` is a
/// runtime conversion and not a compile-time check — the drift-guard test is what
/// catches a projection edited apart from this ladder.
pub(super) fn task_number_row_from(row: &Row<'_>) -> rusqlite::Result<TaskNumberRow> {
    Ok(TaskNumberRow {
        session_id: row.get(0)?,
        task_number: row.get(1)?,
        stage_slug: row.get::<_, Option<String>>(2)?,
    })
}

/// The board read payload: one stage plus its cards.
///
/// ONE payload, not two lists the frontend joins — the board renders columns,
/// so a column with no cards has to arrive as an empty `tasks`, not as an
/// absent key.
///
/// NOT `Eq`, and that is load-bearing rather than careless: `tasks` holds
/// [`TaskCardView`], which carries an `f64`, and `f64` is not `Eq` (no reflexive
/// equality over `NaN`). Nothing keys either type in a `HashSet`/`BTreeMap`
/// (verified: zero hits for `HashSet<StageWithTasks>`/`HashMap<StageWithTasks…`/
/// `BTreeSet<StageWithTasks`), and `PartialEq` is all `assert_eq!` needs — the
/// same derive set `fulcrum_harness`'s `DisplayRow` (re-exported by
/// `agent/harness/mod.rs`) already carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageWithTasks {
    pub stage: StageRow,
    pub tasks: Vec<TaskCardView>,
}

/// One board card plus what the board read knows about its Sessions (issue #174).
///
/// A WRAPPER, deliberately not a field on [`TaskRow`]: `get_task`, `create_task`
/// and `edit_task` all return a plain `TaskRow`, and if `TaskRow` grew a
/// `sessions` field those three would have to either join on every single-row
/// read or return an empty `sessions` for a card that HAS links — a confident,
/// well-formed lie on the wire that no test would see. Decoration lives only on
/// the board payload, so the single-row commands keep telling the truth.
///
/// `#[serde(flatten)]` is deliberately NOT used on `task`: keeping the nested
/// `task` key makes the two shapes distinguishable in the JSON, and the repo has
/// no `serde(flatten)` precedent to follow. The four wire keys
/// (`task`/`sessions`/`costUsd`/`artifactKeys`) are frozen by
/// `the_task_card_view_wire_keys_are_frozen`, whose TS mirror lives in
/// `src/lib/tauri/types.ts`.
///
/// ADR 0082's two meanings for `sessions.cost_usd` survive the trip in
/// `cost_usd`: `None` means "no linked Session ever reported a cost" (the chip
/// renders NOTHING), `Some(0.0)` means "a real zero" (it renders `$0.00`). A card
/// with no links gets `sessions: []` and `cost_usd: None` — never `Some(0.0)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCardView {
    /// The card — the UNCHANGED 10-field [`TaskRow`].
    pub task: TaskRow,
    /// Linked Sessions, OLDEST FIRST (what `Db::task_sessions` publishes).
    pub sessions: Vec<TaskSessionRow>,
    /// Summed cost; ADR 0082: `None` = never reported, `Some(0.0)` = a real zero.
    pub cost_usd: Option<f64>,
    /// The artifact KEYS alone — names only, never the markdown. The board read
    /// never carries a document (spec §1): the detail dialog fetches content with
    /// the `get_artifact` command when a key is selected. REQUIRED, never
    /// optional, for the reason `sessions` is: an optional field compiles against
    /// every fixture in the repo and then renders nothing when real data arrives.
    /// A card with no artifacts has `artifact_keys: []`.
    pub artifact_keys: Vec<String>,
}

/// One named **Task artifact** (issue #180, spec §1, ADR 0100): a markdown
/// document owned by a Task, stored as a row of `task_artifacts`.
///
/// The content lives IN the database because the alternative dies on ship —
/// `docs/roadmap/` is gitignored, its untracked files are unrecoverable, and the
/// `finish` skill deletes the plan family when the work succeeds. It is NOT a
/// JSON column on `tasks`: `sessions.todos_json` is the in-repo precedent and it
/// is write-mostly, which is exactly what a document that must be read back
/// cannot be, and a column here would put the blob on `TaskRow` — the shape the
/// [`TaskCardView`] wrapper exists to prevent.
///
/// `key` is a free-form slug, NOT an enum: `tool_specs()` returns a static `Vec`
/// and cannot carry one. But the grammar is enforced HERE, by
/// [`super::Db::write_artifact`]
/// — see "THE ONE OWNER" below it — for every door to `task_artifacts`, not in the
/// command layer. The command's `require_artifact_key` pre-flight still runs and
/// still answers first; it is not the guard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    /// The owning card — one half of the composite primary key.
    pub task_id: String,
    /// The other half: `PRIMARY KEY (task_id, key)` means one row per key, ever.
    pub key: String,
    /// The document. This struct is the ONLY place artifact content crosses the
    /// wire, and it is a single-artifact read — never the board payload.
    pub markdown: String,
    /// Set by the FIRST write and never touched again (see `write_artifact`).
    pub created_at: i64,
    /// Set by every write.
    pub updated_at: i64,
}

/// What `write_artifact` answers with: identity, the fresh stamp, and the size.
///
/// It deliberately does NOT echo the `markdown` back. The caller just sent it, so
/// returning it doubles a frame that can be 256 KB for no information, and a
/// write path that hands back documents is how a board payload eventually
/// acquires one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMeta {
    /// The key that was written (the grammar was validated before this ran).
    pub key: String,
    /// The stamp the row now carries — the caller learns WHEN it landed without
    /// a second read.
    pub updated_at: i64,
    /// The UTF-8 BYTE length stored, so a caller near the 256 KB cap can see how
    /// close it is. `markdown.len()`, not a character count.
    pub bytes: usize,
}

/// What a `move_task` reports: the destination stage's `on_enter`.
///
/// Lives HERE rather than in `commands/tasks.rs` (which the plan sketched it in)
/// because `Db::move_task` is what reads `on_enter` inside its own lock — and
/// storage cannot name a type that lives in the command layer. The command
/// returns this same struct, so there is ONE wire shape, not two.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    /// The DESTINATION stage's `'none' | 'compact' | 'fresh'`, read AFTER the
    /// write. The storage layer never acts on it: running a compaction needs
    /// the `SessionManager`, which lives in the command layer.
    pub on_enter: String,
}

/// One session's recency, as a FIELD rather than a position (ADR 0075).
///
/// `list_sessions` stopped sorting by recency, so recency has to be asked for
/// by name. This is the ONLY thing that crosses the wire for that question —
/// deliberately NOT a `SessionInfo` field: `SessionInfo` is built by dozens of
/// struct literals and is the struct ADR 0064 protects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecency {
    pub session_id: String,
    /// Unix milliseconds. Never absent: `LAST_ACTIVITY`'s `COALESCE` falls back
    /// to the row's own `created_at` when the transcript is empty.
    pub last_active_at: i64,
    /// The row's position in the user's MANUAL ORDER (bigger number = lower
    /// row), echoed straight from the row's own order column.
    ///
    /// It rides THIS payload rather than a payload of its own because ONE
    /// sequence has to span live and stored rows, and the frontend cannot
    /// interleave what it cannot see: a **Session** RESUMED this boot is live,
    /// yet the slot it renders in is the one the database holds for it. A
    /// second boot round-trip for the same rows is the alternative, and the
    /// boot `Promise.all` already pays for this one.
    ///
    /// Nothing in the frontend reads the NAME — the store reduces it into an
    /// order map (`setSessionRecency` → `sessionOrder`) and only
    /// `mergeSessionOrder` consumes that. It is position and nothing else, so
    /// it is never evidence (ADR 0075).
    pub sort_order: i64,
}
