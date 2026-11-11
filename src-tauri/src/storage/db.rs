//! SQLite persistence for session history and message transcripts.
//!
//! The database lives at `app.path().app_data_dir()/archimedes.db`. The
//! client owns history: every session is recorded when it is established
//! (or resumed), and every message is upserted as it streams in, so a
//! restart restores the full conversation with no duplicate rows.
//!
//! Upsert semantics: `messages` is keyed by `(session_id, kind,
//! message_key)`. Agent text is stored once per message (one row per
//! `messageId`, holding the accumulated text — not one row per chunk);
//! tool calls are stored once per tool call id (the latest merged state).

use std::path::Path;
use std::sync::Mutex as StdMutex;

use rusqlite::{params, Connection, Row, Transaction};
use serde::{Deserialize, Serialize};

// T5/S4 (plan Step B-bis): the ROW TYPES moved to `fulcrum-core`, because the
// crate's `FulcrumPersistence` trait returns them and a crate cannot name a type
// that lives in `archimedes_lib`. They are pure serde data (8 and 6 `pub` fields,
// zero `rusqlite` references) — the SQL stayed here with `SESSION_COLUMNS` /
// `MESSAGE_COLUMNS` and the row mappers. Re-imported (desktop→crate, the allowed
// direction) so `crate::storage::SessionRow` and every other existing spelling
// resolves unchanged.
pub use fulcrum_harness::store_rows::{MessageRow, SessionRow};

use fulcrum_harness::seams::{
    Artifact as CrateArtifact, ArtifactMeta as CrateArtifactMeta, BoardRow, FulcrumPersistence,
    MoveOutcome as CrateMoveOutcome, StoreError, TaskDetail, TaskRow as CrateTaskRow, TaskStore,
    TaskStoreError,
};
// (T5/S4, Step B-bis) The clock moved to `fulcrum_harness::clock` — this file's
// private copy and `agent/normalize.rs`'s `pub(crate)` copy were byte-identical
// duplicates, and the trait's `now_ms` would have been a third. Importing the
// one definition (rather than a one-line wrapper) leaves NO second body to drift:
// the timestamps this file writes and the `DisplayRow.created_at` the crate
// stamps are the same clock by construction.
use fulcrum_harness::clock::now_ms;

use crate::types::SessionInfo;

/// Errors surfaced by the persistence layer.
///
/// Stays desktop, and STAYS THREE-VARIANT: `Sqlite(#[from] rusqlite::Error)` is
/// why `DbError` could not move to the crate at all (Step B-bis), and the desktop
/// keeps needing the variant — `agent/errors.rs:171` matches on it to build the
/// IPC error envelope. The crate sees only the two variants its own errors can
/// be; see the `impl From<DbError> for StoreError` below and
/// `fulcrum_harness::StoreError`'s docs for the measurement that makes collapsing
/// the third admissible.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// The `DbError → StoreError` map the seam runs through (Step B-bis):
/// `Sqlite(_) → Io`, `Io → Io`, `Json → Json`.
///
/// The mapping is a LOSS, so it is licensed only by the measurement recorded on
/// `StoreError`: no code inside the crate ever matches `Sqlite` — the crate-side
/// sites CONSTRUCT `Json` (`harness/store.rs:220`) or `Io` (`worker/store.rs:62`,
/// which stays desktop through T8 anyway), and the single `match` on
/// `DbError::Sqlite` is `agent/errors.rs:171`, which is desktop-only and keeps the
/// full `DbError`. A SQLite failure that reaches the engine surfaces as
/// `"io error: sqlite error: …"`; today the only crate-side consumer of a
/// persistence error is `TranscriptPersister`, which `eprintln!`s it and
/// continues, so nothing branches on the distinction.
///
/// Kept as a `From` impl rather than inlined per method so a future need to tell
/// a locked database from a missing disk has ONE place to add a `Sqlite` variant —
/// and does not get `rusqlite` into the crate by accident.
impl From<DbError> for StoreError {
    fn from(e: DbError) -> Self {
        match e {
            // Stringified through `DbError`'s OWN `Display`, not the bare
            // `rusqlite::Error`, so the sentence keeps its `sqlite error: `
            // prefix and degrades to "io error: sqlite error: …" rather than
            // silently dropping which layer failed. `io::Error::other` is the
            // constructor for "an error that is not an OS errno" and preserves
            // the wrapped value's `Display`.
            DbError::Sqlite(inner) => {
                StoreError::Io(std::io::Error::other(format!("sqlite error: {inner}")))
            }
            DbError::Io(e) => StoreError::Io(e),
            DbError::Json(e) => StoreError::Json(e),
        }
    }
}

/// The `DbError → TaskStoreError` map the D2 TaskStore seam runs through
/// (issue #180; the crate trait is `fulcrum_harness::seams::TaskStore`).
///
/// Lossy like the `StoreError` map beside it, and licensed by the same
/// measurement: `DbError` stays three-variant and DESKTOP-only (`Sqlite` is never
/// constructible crate-side), so the crate seam only ever sees the three arms its
/// own error type can express. `TaskStoreError` has no `Sqlite` arm for the same
/// reason `StoreError` has none — no `rusqlite` crosses into the crate — and it
/// must be serde-serializable because its value rides the wire inside
/// `Inbound::TaskResponse`, which is why it is a separate type and not `StoreError`
/// reused.
///
/// `Sqlite → Io` with the sentence preserved through `Display` (the
/// `io error: sqlite error: …` degradation the map above documents — the model
/// reads this `message` as its tool result, so WHICH layer failed has to survive);
/// `Io → Io`; `Json → Invalid`, because a JSON failure is a malformed row rather
/// than an I/O failure, and folding it into `Io` would tell a model to retry a
/// write that will fail identically every time.
impl From<DbError> for TaskStoreError {
    fn from(e: DbError) -> Self {
        match e {
            DbError::Sqlite(inner) => TaskStoreError::Io {
                message: format!("sqlite error: {inner}"),
            },
            DbError::Io(e) => TaskStoreError::Io {
                message: e.to_string(),
            },
            DbError::Json(e) => TaskStoreError::Invalid {
                message: e.to_string(),
            },
        }
    }
}

/// Why a Task-board write was refused.
///
/// A SEPARATE error type from [`DbError`], and not an accident of taste:
/// `DbError` documents itself as STAYING THREE-VARIANT because it is the crate
/// persistence seam's type (`impl From<DbError> for StoreError` above), and the
/// board needs two absence cases the seam has no business carrying — a card
/// that is not there, and a stage slug that is not one of this Space's columns.
/// Widening `DbError` would push both across the seam into `StoreError`, where
/// the engine would have to be told about kanban rows.
///
/// Stays a plain enum with no serde derive: the wire route is
/// `TasksError` in `agent/errors.rs` (ADR 0063 — the WIRE owns the envelope, and
/// `agent/errors.rs` is where every IPC family lives). This type is the
/// storage→command boundary, one step below the wire.
#[derive(Debug, thiserror::Error)]
pub enum BoardError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// No `tasks` row with this id. Absence is a rejection here (a WRITE was
    /// asked for), where the READ path (`get_task`) answers `Ok(None)` — the
    /// `find_space`/`set_space_trusted` split in this file, carried over.
    #[error("no task with id {0}")]
    MissingTask(String),

    /// No `stages` row for this `(space_path, slug)`. Carries the slugs that DO
    /// exist: ADR 0090's first Consequence is that a bad slug must come back
    /// naming the valid ones, so a caller (a model, especially) self-corrects
    /// without a schema-discovery round trip — `stages` cannot be a JSON-Schema
    /// enum because `tool_specs()` returns a static `Vec`.
    #[error("no stage {wanted} in this space (valid stages: {available})")]
    MissingStage {
        wanted: String,
        /// Comma-joined, in `sort_order`. A string rather than a `Vec` so the
        /// `Display` sentence is the whole answer.
        available: String,
    },

    /// `delete_stage` refuses while the Stage holds cards. A Task whose
    /// `stage_slug` names no row is INVISIBLE to `get_board` — which groups by
    /// Stage — yet keeps costing money through its Sessions, so the cards would
    /// survive a delete unreachable rather than die with it. That is ADR 0090's
    /// no-foreign-key consequence, and it is why SQLite cannot catch this for us.
    /// The sentence names the count AND the slugs they could move to, so the
    /// caller has the whole answer in one round trip.
    #[error(
        "stage {slug} has {count} card(s) — delete or move them first (valid stages: {available})"
    )]
    StageNotEmpty {
        slug: String,
        count: i64,
        available: String,
    },

    /// `delete_stage` refuses while another Stage's `next_slugs` names this one
    /// (ADR 0099's Consequence). The alternative — drop the dangling slug at read
    /// time — is rejected there by name: a silently-shrunk workflow is the
    /// failure this repo keeps documenting. The sentence names the pointing
    /// Stages, so the user knows which graph to edit rather than guessing.
    #[error(
        "stage {slug} cannot be deleted — another stage's transitions lead here ({referrers})"
    )]
    StageReferenced { slug: String, referrers: String },

    /// `delete_stage` refuses the last column. `create_task`'s "no explicit stage
    /// lands in the first stage" fallback and `get_board`'s payload shape both
    /// assume at least one row exists, so a board with zero columns is a board
    /// that cannot accept a card.
    #[error("stage {slug} is this space's last column and cannot be deleted")]
    LastStage { slug: String },

    /// `create_stage` refuses a slug collision rather than suffixing it. A silent
    /// `spike-2` is a slug nobody typed, and a slug is the thing a card's
    /// `<task stage="…">` block and `move_task`'s error both report (spec §5), so
    /// inventing one is inventing a name the user never chose.
    #[error("a stage with slug {slug} already exists in this space (valid slugs: {available})")]
    StageSlugTaken { slug: String, available: String },

    /// `create_stage` refuses a label that derives no slug at all (spec §5). The
    /// command layer refuses this earlier with a friendlier sentence; the storage
    /// layer refuses it too, because it is the last writer and cannot trust its
    /// caller to have mangled the text first.
    #[error("cannot create a stage with an empty slug")]
    EmptyStageSlug,

    /// ADR 0099's Strict-workflow gate: the move is not an edge of the FROM
    /// Stage's `next_slugs`. Only reachable when `spaces.board_strict = 1`. The
    /// sentence names the legal destinations, which is the whole UI this needs —
    /// `store/tasks.ts` already reverts an optimistic drag on rejection and
    /// renders this message.
    #[error("cannot move to {to} from {from} — allowed: {allowed}")]
    StrictMoveRefused {
        from: String,
        to: String,
        allowed: String,
    },

    /// `set_stage_next` refuses a slug equal to its own origin. A self-loop is a
    /// button that moves a card to the column it is already in — a control that
    /// appears to do something and does nothing.
    #[error("stage {slug} cannot lead to itself")]
    SelfLoop { slug: String },

    /// `write_artifact` refuses a key outside `[a-z0-9][a-z0-9-]{0,39}`.
    ///
    /// The payload is the offending key VERBATIM (never cleaned), because a
    /// caller that invented the key is the only party that can fix it and it must
    /// see exactly what it sent. The sentence below is byte-identical to
    /// `TasksError::BadArtifactKey`'s in `agent/errors.rs`, and that is a
    /// requirement rather than tidiness: the command layer maps this arm onto that
    /// variant FIELD-FOR-FIELD, so a person who breaks the rule gets one sentence
    /// whichever layer caught it (ADR 0063 — the message is what the user reads).
    ///
    /// The grammar's `{0,39}` is escaped `{{0,39}}` for the same reason
    /// `TasksError`'s is: unescaped, the `Display` derive reads it as a format
    /// argument and prints a width instead of the rule.
    #[error("artifact key `{key}` is not [a-z0-9][a-z0-9-]{{0,39}}")]
    BadArtifactKey { key: String },

    /// `write_artifact` refuses a markdown over [`MAX_ARTIFACT_MARKDOWN_BYTES`].
    ///
    /// Refused, NEVER truncated. Both numbers ride the variant (and the command
    /// layer re-emits them as `size`/`max` envelope keys, ADR 0063) so a caller
    /// learns how far over it went without parsing prose. The sentence matches
    /// `TasksError::ArtifactTooLarge`'s byte-for-byte, for the same reason as
    /// [`BoardError::BadArtifactKey`]'s does.
    #[error("artifact is {size} bytes, which exceeds the {max} bytes (256 KB) limit")]
    ArtifactTooLarge { size: usize, max: usize },
}

/// The `BoardError → TaskStoreError` map the D2 TaskStore seam runs through
/// (issue #180).
///
/// Four arms carry the refusals a board VERB can reach through the crate trait,
/// and the fifth is the honest catch-all for the variants the seam cannot produce
/// — see below.
///
/// - `MissingTask` → `NotFound`: a WRITE against a card that is not there. This is
///   the variant `write_artifact`'s dangling-id gate raises, and the crate's
///   `TaskStoreError::NotFound` exists for exactly that question.
/// - `MissingStage` → `Invalid`: a bad slug is a malformed ARGUMENT, not an
///   absence — the destination column may well exist in another Space. The
///   sentence keeps `available`, because ADR 0090's first Consequence is that a bad
///   slug must name the valid ones so a model self-corrects without a
///   discovery round trip, and that sentence is what the model reads.
/// - `StrictMoveRefused` → `Invalid`, likewise: the call was well-formed and the
///   Space's own workflow gate refused it. `allowed` rides for the same reason.
/// - `Sqlite` → `Io`, with the same sentence preservation as the `DbError` map
///   above.
///
/// The catch-all exists because `move_task` is not the only verb-shaped method on
/// this type and the match has to be exhaustive over an enum the command layer
/// grows. `StageNotEmpty`, `StageReferenced`, `LastStage`, `StageSlugTaken`,
/// `EmptyStageSlug` and `SelfLoop` are all STAGE-management refusals, and the crate
/// trait has no stage verb at all — no path through `TaskStore` reaches them.
/// Folding them into `Invalid` rather than panicking is deliberate: a future verb
/// that starts raising one gets a correct-if-generic sentence, where a `unreachable!`
/// would panic inside a `spawn_blocking` and turn a storage refusal into the
/// `JoinError` the router reports as `Io`.
///
/// `BadArtifactKey` and `ArtifactTooLarge` sit in the SAME arm but for the opposite
/// reason: they ARE reachable, because `write_artifact` is a `TaskStore` verb and
/// storage now enforces both rules for every door to `task_artifacts`. The crate's
/// `Invalid` doc names exactly those two failures, so the mapping is the one F1
/// anticipated rather than a coincidence.
impl From<BoardError> for TaskStoreError {
    fn from(e: BoardError) -> Self {
        // `Display` IS the sentence the model reads, so it is rendered ONCE from
        // the variant that arrived and then dispatched on — never re-spelled per
        // arm, which is how a `#[error(...)]` edit and a mapping table drift apart.
        // (`Sqlite` needs no `format!` here for the same reason: the variant's own
        // `Display` already carries the `sqlite error: ` prefix.)
        let sentence = e.to_string();
        match e {
            BoardError::MissingTask(_) => TaskStoreError::NotFound { message: sentence },
            BoardError::Sqlite(_) => TaskStoreError::Io { message: sentence },
            // The two artifact refusals are MALFORMED ARGUMENTS, not absences, and
            // the crate's own `TaskStoreError::Invalid` doc names them ("a key
            // outside the artifact grammar, a markdown over the size cap") — this
            // arm is why that sentence is now true on the desktop side too. The
            // grammar and the numbers ride in `Display`, which is what the model
            // reads as the tool result.
            BoardError::BadArtifactKey { .. }
            | BoardError::ArtifactTooLarge { .. }
            | BoardError::MissingStage { .. }
            | BoardError::StrictMoveRefused { .. }
            | BoardError::StageNotEmpty { .. }
            | BoardError::StageReferenced { .. }
            | BoardError::LastStage { .. }
            | BoardError::StageSlugTaken { .. }
            | BoardError::EmptyStageSlug
            | BoardError::SelfLoop { .. } => TaskStoreError::Invalid { message: sentence },
        }
    }
}

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
const SESSION_COLUMNS: [&str; 10] = [
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

const SESSION_ROW_FIELDS: usize = 10;
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
fn session_row_from(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
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
const MESSAGE_COLUMNS: [&str; 6] = [
    "id",
    "session_id",
    "kind",
    "message_key",
    "payload_json",
    "created_at",
];

const MESSAGE_ROW_FIELDS: usize = 6;
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
fn message_row_from(row: &Row<'_>) -> rusqlite::Result<MessageRow> {
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
const SPACE_COLUMNS: [&str; 4] = ["path", "created_at", "last_opened_at", "trusted"];

const SPACE_ROW_FIELDS: usize = 4;
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
fn space_row_from(row: &Row<'_>) -> rusqlite::Result<SpaceRow> {
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
}

/// The ONE `stages` SELECT list every read uses, as a const array of column
/// names — same reason and same honest scope as [`SESSION_COLUMNS`].
///
/// The two #179 columns go at the END, not in the middle: [`stage_row_from`]
/// reads by POSITION, so appending keeps every existing index stable and a
/// reorder cannot silently swap two fields' meanings.
const STAGE_COLUMNS: [&str; 7] = [
    "space_path",
    "slug",
    "label",
    "sort_order",
    "on_enter",
    "on_enter_skill",
    "next_slugs",
];

const STAGE_ROW_FIELDS: usize = 7;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS for the honest scope;
// the drift-guard TEST is the guard.
const _: [(); STAGE_COLUMNS.len()] = [(); STAGE_ROW_FIELDS];

/// Map one row of [`STAGE_COLUMNS`] onto a [`StageRow`], index for index.
fn stage_row_from(row: &Row<'_>) -> rusqlite::Result<StageRow> {
    Ok(StageRow {
        space_path: row.get(0)?,
        slug: row.get(1)?,
        label: row.get(2)?,
        sort_order: row.get(3)?,
        on_enter: row.get(4)?,
        on_enter_skill: row.get::<_, Option<String>>(5)?,
        next_slugs: lenient_next_slugs(row.get::<_, Option<String>>(6)?),
    })
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
fn lenient_next_slugs(raw: Option<String>) -> Option<Vec<String>> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
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
const TASK_COLUMNS: [&str; 10] = [
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

const TASK_ROW_FIELDS: usize = 10;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS for the honest scope.
const _: [(); TASK_COLUMNS.len()] = [(); TASK_ROW_FIELDS];

/// Map one row of [`TASK_COLUMNS`] onto a [`TaskRow`], index for index.
///
/// The ONE place a `TaskRow` is constructed. `body`/`spec_path` are nullable
/// columns, so their `get::<_, Option<String>>` is a runtime conversion, not a
/// compile-time check — the drift-guard test is what catches a reordered list.
fn task_row_from(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
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
const TASK_SESSION_COLUMNS: [&str; 3] = ["task_id", "session_id", "stage_slug"];

const TASK_SESSION_ROW_FIELDS: usize = 3;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS for the honest scope.
const _: [(); TASK_SESSION_COLUMNS.len()] = [(); TASK_SESSION_ROW_FIELDS];

/// Map one row of [`TASK_SESSION_COLUMNS`] onto a [`TaskSessionRow`].
fn task_session_row_from(row: &Row<'_>) -> rusqlite::Result<TaskSessionRow> {
    Ok(TaskSessionRow {
        task_id: row.get(0)?,
        session_id: row.get(1)?,
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
/// and cannot carry one, so the grammar is validated in the command layer (the
/// `require_title` split) rather than closed here.
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

/// Run `add` inside ONE transaction iff `table.column` is absent (probed via
/// `pragma_table_info`).
///
/// `gate` is a TRANSACTION FACTORY: it opens the `unchecked_transaction`,
/// passes it to `add`, and commits ONLY after `add` returns Ok — so an ALTER
/// paired with a data step (backfill/seed) is atomic, and a crash
/// mid-backfill leaves the ALTER NOT committed, so the next open re-probes
/// and re-runs the whole gate. It is NOT a wrap-the-call helper: the
/// transaction is opened HERE (before the closure runs) and committed HERE
/// (only after it returns Ok), which is what makes the ALTER+backfill pair one
/// atomic unit. A single-statement gate just does its one ALTER inside the
/// same tx (a single DDL is atomic in SQLite anyway).
///
/// The crash-state this changes: before the factory existed, the gates that
/// paired an ALTER with a data step committed the ALTER and rolled back only
/// the data step on a mid-gate crash, so the next open re-ran the seed against
/// an already-migrated column — which for `sort_order` could DUPLICATE the
/// ADR 0075 numbers. Under the factory a crash rolls the ALTER back too, the
/// `pragma_table_info` probe still finds the column missing, and the WHOLE gate
/// runs cleanly on the next open.
///
/// Table and column are compile-time literals at every call site; they are
/// bound as parameters to the probe (both spellings are safe here).
fn gate(
    conn: &mut Connection,
    table: &str,
    column: &str,
    add: impl FnOnce(&mut Transaction<'_>) -> Result<(), DbError>,
) -> Result<(), DbError> {
    let has: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |row| row.get(0),
    )?;
    if has == 0 {
        let mut tx = conn.unchecked_transaction()?;
        // Closures that only read/execute may pass `&*tx` onward where a
        // `&Connection` is wanted (a `Transaction` derefs to one).
        add(&mut tx)?;
        tx.commit()?;
    }
    Ok(())
}

/// The app's SQLite database.
///
/// The connection is wrapped in a `std::sync::Mutex` (a raw
/// `rusqlite::Connection` is `!Sync`), and the `Db` itself is shared via
/// `Arc` between Tauri commands and driver tasks.
pub struct Db {
    conn: StdMutex<Connection>,
}

impl Db {
    /// Open (creating if needed) the database at `path`, migrating the
    /// schema. Parent directories are created as needed.
    pub fn open(path: &Path) -> Result<Self, DbError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        // Enforce the ON DELETE CASCADE on messages.
        conn.pragma_update(None, "foreign_keys", true)?;
        // One-way migration for pre-rip-out databases (the desktop is
        // native-only now): drop the `sessions.agent_id` column. The
        // `messages` table STAYS (the native display transcript) — but ALL
        // external `sessions` rows (`agent_id <> 'archimedes'`: the built-in
        // `pi` + any user-configured external entries) are deleted first;
        // their `messages` rows cascade via the FK (the `foreign_keys`
        // pragma above is live). Gated on a `PRAGMA table_info` probe — a
        // fresh or already-migrated database skips it, so the migration is
        // idempotent by construction. ONE transaction (SQLite DDL is
        // transactional — a crash mid-batch cannot leave a half-migrated
        // schema behind; the `DELETE` + `ALTER` are atomic together).
        let has_agent_id: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'agent_id'",
            [],
            |row| row.get(0),
        )?;
        if has_agent_id > 0 {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "DELETE FROM sessions WHERE agent_id <> 'archimedes';
                ALTER TABLE sessions DROP COLUMN agent_id;",
            )?;
            tx.commit()?;
        }
        // (finding 5) A legacy crash state: a crash under the pre-fix
        // autocommit code between `DROP TABLE native_messages` and the
        // `RENAME` leaves `native_messages` GONE with the rows living in
        // `native_messages_migrated`. Recover it BEFORE the SCHEMA (which
        // would otherwise `CREATE TABLE IF NOT EXISTS native_messages` — an
        // empty table — and the FK migration's batch would `DROP TABLE IF
        // EXISTS native_messages_migrated`, losing the rows). The migrated
        // table was created WITH the FK, so the rename alone restores the FK
        // (the FK migration below is then a no-op). Pre-fix the re-run hit
        // `INSERT … SELECT … FROM native_messages` → "no such table" →
        // rollback → `Db::open` errored forever, bricking startup.
        let native_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
             AND name = 'native_messages'",
            [],
            |row| row.get(0),
        )?;
        let migrated_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
             AND name = 'native_messages_migrated'",
            [],
            |row| row.get(0),
        )?;
        if native_exists == 0 && migrated_exists > 0 {
            conn.execute(
                "ALTER TABLE native_messages_migrated RENAME TO native_messages",
                [],
            )?;
        }
        conn.execute_batch(SCHEMA)?;
        // One-time migration for pre-existing databases: add `trusted`
        // (fresh databases already have it from SCHEMA). Gated on a schema
        // pre-check — the ALTER runs only when the column is absent, so a
        // re-open never issues it and no error string is matched (the
        // backfill below, by contrast, is idempotent via DO NOTHING).
        gate(&mut conn, "spaces", "trusted", |tx| {
            tx.execute(
                "ALTER TABLE spaces ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `archived` to
        // `sessions` (fresh databases already have it from SCHEMA). The same
        // pragma-gated pattern as the `trusted` migration above — the ALTER
        // runs only when the column is absent, so a re-open never issues it.
        gate(&mut conn, "sessions", "archived", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add
        // `context_usage_json` to `sessions` (fresh databases already have
        // it from SCHEMA). The same pragma-gated pattern as the `archived`
        // migration above — the ALTER runs only when the column is absent,
        // so a re-open never issues it. `NULL` (no default): a pre-existing
        // row has NO known usage (the bar shows nothing) — a default value
        // would fabricate one.
        gate(&mut conn, "sessions", "context_usage_json", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN context_usage_json TEXT",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `is_subagent`
        // to `sessions` (fresh databases already have it from SCHEMA). The
        // same pragma-gated pattern as the `archived` / `context_usage_json`
        // migrations above. `DEFAULT 0` (existing rows are main sessions —
        // ADR 0025 §6: no data migration).
        gate(&mut conn, "sessions", "is_subagent", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `todos_json`
        // to `sessions` (fresh databases already have it from SCHEMA) and
        // backfill each non-subagent session's newest checklist write
        // (`manage_todo_list` OR `manage_checklist` — see
        // `backfill_session_todos` for why the match is dual, ADR 0093)
        // (ADR 0073). The ALTER and the backfill run in ONE transaction, so a
        // crash rolls both back and retries on next open.
        gate(&mut conn, "sessions", "todos_json", |tx| {
            tx.execute("ALTER TABLE sessions ADD COLUMN todos_json TEXT", [])?;
            // The backfill helper takes `&Connection`; deref coercion reaches it
            // from the `&mut Transaction`, so the data step runs on the SAME
            // transaction as the ALTER above.
            backfill_session_todos(tx)?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `cost_usd` to
        // `sessions` (fresh databases already have it from SCHEMA). The same
        // pragma-gated pattern as the `todos_json` migration above.
        //
        // NO `DEFAULT` and NO backfill, and that is the load-bearing part of
        // this gate (issue #105, D5 / ADR 0082): `NULL` means "no model call
        // ever reported a cost" and renders NOTHING, while `0.0` means "a call
        // reported a real zero" and renders `$0.00`. A `DEFAULT 0` would
        // migrate every pre-existing row into the second meaning — a figure
        // the provider never reported — which is exactly the phantom-`$0.00`
        // defect this column exists to avoid. The `todos_json` precedent has a
        // backfill because todo data existed elsewhere; cost data never existed
        // anywhere, so `NULL` is the only honest value for an old row. That
        // no-default rule is asserted by the migration test
        // `cost_usd_column_migration_on_a_preexisting_db`, which reads
        // `pragma_table_info('sessions').dflt_value` and requires NULL — a
        // `DEFAULT 0` added here fails that pin.
        gate(&mut conn, "sessions", "cost_usd", |tx| {
            // No transaction wrapper is spelled at this call site: the single
            // ALTER runs inside the factory's tx (atomically, identically — a
            // lone DDL is atomic in SQLite anyway), so the gate states ONE
            // statement and ONE transaction policy like every other gate.
            tx.execute("ALTER TABLE sessions ADD COLUMN cost_usd REAL", [])?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `sort_order` to
        // `spaces` (fresh databases already have it from SCHEMA) and seed it
        // with the order the user was already looking at. The ALTER and the
        // seed run in ONE transaction, so a crash rolls both back and retries
        // on the next open — which is what makes the seed one-time rather than
        // merely idempotent.
        //
        // TWO independent gates, one per table, because each gate probes and
        // repairs its own table through `pragma_table_info`: a crash between
        // the two commits leaves one table seeded and the other un-migrated,
        // and that mixed state is SELF-HEALING — the next open re-probes both
        // tables and runs whichever gate is still missing, independently. It
        // also matches this file's one-column-per-gate style.
        gate(&mut conn, "spaces", "sort_order", |tx| {
            tx.execute(
                "ALTER TABLE spaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            seed_space_sort_order(tx)?;
            Ok(())
        })?;
        // The matching gate for `sessions` (see the `spaces` gate above for
        // why the two are separate transactions). This gate — like the space
        // one — runs BEFORE the phase-11 space backfill below, so a database
        // that already has `sessions` rows but no `spaces` rows reaches the
        // backfill with the session numbering already settled.
        gate(&mut conn, "sessions", "sort_order", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            seed_session_sort_order(tx)?;
            Ok(())
        })?;
        // `title_stage` (ADR: two-stage async titling) is the same shape as the
        // gates above — an ALTER PAIRED with a data step — so it runs through the
        // same factory: a crash rolls the ALTER back with the backfill, and the
        // next open re-runs the whole gate instead of seeding stage 2 twice.
        gate(&mut conn, "sessions", "title_stage", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN title_stage INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            // Existing titled sessions are migrated to stage 2 so they are preserved
            // and not overwritten by an unexpected stage-2 re-title.
            tx.execute(
                "UPDATE sessions SET title_stage = 2 WHERE title IS NOT NULL",
                [],
            )?;
            Ok(())
        })?;
        // ADR 0098 + ADR 0099 (issue #179): three additive columns on the TWO
        // tables a pre-#179 database already holds. A fresh database gets all
        // three from `SCHEMA` and every gate below stays silent — there is no
        // code path in which a fresh open runs one of these ALTERs.
        //
        // `on_enter_skill` carries the whole #179 backfill, because the column
        // and the data are one atomic unit: spec §3.1's two Skill UPDATEs and the
        // `discuss` INSERT all write columns this ALTER creates. Splitting them
        // across gates would let a crash commit the column without the rows, and
        // a board with no `discuss` column is exactly the silent-green shape
        // ADR 0098's Consequence warns about (both shipped launch buttons gone,
        // no error, a plausible-looking board).
        gate(&mut conn, "stages", "on_enter_skill", |tx| {
            tx.execute("ALTER TABLE stages ADD COLUMN on_enter_skill TEXT", [])?;
            // spec §3.1 steps 1–2: the two launch Skills. `IS NULL` keeps the
            // statement a backfill rather than an overwrite, and it is what makes
            // the whole gate safe to re-run after a crash.
            tx.execute(
                "UPDATE stages SET on_enter_skill = 'research' \
                 WHERE slug = 'research' AND on_enter_skill IS NULL",
                [],
            )?;
            tx.execute(
                "UPDATE stages SET on_enter_skill = 'discuss' \
                 WHERE slug = 'discuss' AND on_enter_skill IS NULL",
                [],
            )?;
            // spec §3.1 step 3: give every Space that has a `research` column and
            // no `discuss` column a `discuss` column immediately BEFORE `research`.
            // The `NOT IN` pre-check is the idempotence (the PRIMARY KEY is
            // `(space_path, slug)`, so re-running without it would fail the INSERT
            // and brick `Db::open`) AND the respect-a-rename rule: a Space whose
            // owner renamed `research` to `spike` has no `research` row, so the
            // migration gives it nothing rather than inventing a column beside a
            // workflow the owner already changed.
            // The `let … ; found` shape is the borrow checker, not tidiness: the
            // `MappedRows` temporary borrows `stmt`, so a block-ending expression
            // would drop `stmt` first.
            let mut probe = tx.prepare(
                "SELECT DISTINCT space_path FROM stages \
                 WHERE slug = 'research' \
                   AND space_path NOT IN \
                   (SELECT space_path FROM stages WHERE slug = 'discuss')",
            )?;
            let spaces_without_discuss = probe
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            for space in spaces_without_discuss {
                let research_sort: i64 = tx.query_row(
                    "SELECT sort_order FROM stages WHERE space_path = ?1 AND slug = 'research'",
                    params![space],
                    |r| r.get(0),
                )?;
                // The shift runs BEFORE the insert: `sort_order` carries NO UNIQUE
                // constraint, so an insert-then-shift would leave `discuss` and
                // `research` sharing an index and the board's ordering would be
                // decided by the `slug` tiebreak instead of the user's layout.
                tx.execute(
                    "UPDATE stages SET sort_order = sort_order + 1 \
                     WHERE space_path = ?1 AND sort_order >= ?2",
                    params![space, research_sort],
                )?;
                tx.execute(
                    "INSERT INTO stages (space_path, slug, label, sort_order, on_enter_skill) \
                     VALUES (?1, 'discuss', 'Discuss', ?2, 'discuss')",
                    params![space, research_sort],
                )?;
            }
            Ok(())
        })?;
        // ADR 0099's column, deliberately NOT backfilled: NULL means
        // "unconfigured", and the renderer's fallback (the Stage at
        // `sort_order + 1`) reproduces today's single-forward-button behaviour
        // until a person configures a graph. Backfilling it would have given every
        // existing board a graph it never asked for — and under Strict, one that
        // refuses drags.
        gate(&mut conn, "stages", "next_slugs", |tx| {
            tx.execute("ALTER TABLE stages ADD COLUMN next_slugs TEXT", [])?;
            Ok(())
        })?;
        // The Strict-workflow opt-in (ADR 0099). Rides the `spaces` row;
        // `SpaceRow` does NOT gain a field — `board_strict` is read and written by
        // SQL only, so the `Vec<SpaceRow>` wire type is untouched. The `0` default
        // is the whole compatibility story: upgrading cannot change how an
        // existing board answers a drag.
        gate(&mut conn, "spaces", "board_strict", |tx| {
            tx.execute(
                "ALTER TABLE spaces ADD COLUMN board_strict INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: give
        // `native_messages` its `ON DELETE CASCADE` foreign key (a
        // pre-existing table cannot GAIN an FK in place — recreate it,
        // preserving the rows). Gated on a pragma pre-check, like the
        // `trusted` migration above. (Orphan rows — a transcript for a
        // session that is no longer stored — are dropped: they could
        // never cascade, and the FK would reject them.)
        let native_fk: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('native_messages') \
             WHERE \"table\" = 'sessions'",
            [],
            |row| row.get(0),
        )?;
        if native_fk == 0 {
            // ONE transaction (SQLite DDL is transactional — atomic: a
            // crash mid-batch cannot leave a half-migrated schema
            // behind; pre-fix each statement autocommitted, and a crash
            // left `native_messages_migrated` behind (and/or
            // `native_messages` dropped), so the next open re-ran the
            // batch, hit `CREATE TABLE … already exists`, and `Db::open`
            // errored forever — bricking startup). The `DROP TABLE IF
            // EXISTS` first makes the re-run crash-idempotent too (a
            // stale `native_messages_migrated` from a pre-transactional
            // crash is dropped before the `CREATE`).
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS native_messages_migrated;
                CREATE TABLE native_messages_migrated (
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(session_id, seq)
                );
                INSERT INTO native_messages_migrated (session_id, seq, role, content_json, created_at)
                    SELECT nm.session_id, nm.seq, nm.role, nm.content_json, nm.created_at
                    FROM native_messages nm
                    WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = nm.session_id);
                DROP TABLE native_messages;
                ALTER TABLE native_messages_migrated RENAME TO native_messages;",
            )?;
            tx.commit()?;
        }
        // One-time backfill for pre-existing databases: give a space row to every
        // distinct stored session cwd (canonicalized). A vanished folder is skipped
        // silently — its sessions stay stored, just without a space.
        // DO NOTHING on conflict: the backfill must NOT refresh `last_opened_at`
        // or `created_at` on every open — an open is not an "open" the user did,
        // and those timestamps stay the bookkeeping values the row was born with.
        // (Recency is no longer the sort key at all — `list_spaces` reads
        // `sort_order` — so this rule protects the stored timestamps, not a list
        // order.)
        //
        // The INSERT joins at the BOTTOM (`MAX + 1`): on this upgrade path the
        // seed may have numbered nothing, and a row left on `DEFAULT 0` would tie
        // with every other backfilled row and hand the user an alphabetical list.
        // ADR 0075's Consequences own the full reason.
        //
        // Key regime: rows are keyed by CANONICAL path — every upsert source
        // canonicalizes (`upsert_space` is fed `info.cwd`, canonicalized at
        // `start_session`/`resume_session`; the backfill above canonicalizes too),
        // so this migration intentionally does NOT re-key pre-existing non-canonical
        // rows. A hypothetical legacy non-canonical row is fail-closed: the
        // canonical lookup never matches it, so it can only cause MORE prompts,
        // never fewer.
        let cwds: Vec<String> = {
            let mut stmt = conn.prepare("SELECT DISTINCT cwd FROM sessions")?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for cwd in cwds {
            if let Ok(c) = std::fs::canonicalize(&cwd) {
                let p = c.display().to_string();
                let now = now_ms();
                conn.execute(
                    "INSERT INTO spaces (path, created_at, last_opened_at, sort_order) \
                     VALUES (?1, ?2, ?2, COALESCE((SELECT MAX(sort_order) FROM spaces), -1) + 1)
                     ON CONFLICT(path) DO NOTHING",
                    params![p, now],
                )?;
            }
        }
        Ok(Self {
            conn: StdMutex::new(conn),
        })
    }

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
    pub fn set_session_archived(&self, id: &str, archived: bool) -> Result<bool, DbError> {
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET archived = ?2 WHERE id = ?1",
            params![id, archived],
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

    /// Delete a session; its `messages` AND `native_messages` rows are
    /// removed (both tables are `ON DELETE CASCADE`; the explicit
    /// `native_messages` `DELETE` is belt-and-suspenders — it also
    /// covers a pre-migration database that never gained the FK).
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
    /// the six defaults on the first board read, so a Space that never opens
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
        // Each card's linked Sessions plus the one figure the chip renders
        // (issue #174). THREE deliberate choices:
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
        let links = {
            let mut stmt = guard.prepare(
                "SELECT ts.task_id, ts.session_id, ts.stage_slug, s.cost_usd \
                 FROM task_sessions ts \
                 JOIN sessions s ON s.id = ts.session_id \
                 WHERE ts.task_id IN (SELECT id FROM tasks WHERE space_path = ?1) \
                 ORDER BY ts.rowid ASC",
            )?;
            let rows = stmt
                .query_map(params![space_path], |row| {
                    Ok((task_session_row_from(row)?, row.get::<_, Option<f64>>(3)?))
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
                        let mine: Vec<&(TaskSessionRow, Option<f64>)> = links
                            .iter()
                            .filter(|(link, _)| link.task_id == task.id)
                            .collect();
                        // ADR 0082: `None` means "never reported", `Some(0.0)`
                        // means "a real zero". This fold IS SQL's SUM over
                        // nullable inputs — NULL iff every input is NULL — done
                        // here rather than in SQL because the rule must stay
                        // visible and pinned to the type that carries it.
                        let mut cost: Option<f64> = None;
                        for (_, reported) in mine.iter() {
                            if let Some(value) = reported {
                                cost = Some(cost.unwrap_or(0.0) + value);
                            }
                        }
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
                            sessions: mine.into_iter().map(|(link, _)| link.clone()).collect(),
                            cost_usd: cost,
                            artifact_keys: mine_keys,
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
    pub fn create_task(
        &self,
        space_path: &str,
        title: &str,
        body: Option<&str>,
        stage_slug: Option<&str>,
    ) -> Result<TaskRow, BoardError> {
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
        // That is a DELIBERATE deviation from this file's own `sort_order` idiom
        // (`COALESCE((SELECT MAX(sort_order) …), -1) + 1` — see `upsert_space`,
        // `record_session`, and the space backfill in `Db::open`), which floors
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
            params![id, space_path, number, title, body, stage, sort_order, now],
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

    /// Patch a card's TEXT fields. `None` keeps the stored value (COALESCE).
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
        title: Option<&str>,
        body: Option<&str>,
        spec_path: Option<&str>,
    ) -> Result<TaskRow, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let touched = guard.execute(
            "UPDATE tasks SET \
               title = COALESCE(?2, title), \
               body = COALESCE(?3, body), \
               spec_path = COALESCE(?4, spec_path), \
               updated_at = ?5 \
             WHERE id = ?1",
            params![task_id, title, body, spec_path, now_ms()],
        )?;
        drop(guard);
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
    /// The `require_title` precedent does NOT argue the other way. `require_title`
    /// refuses a title that `clean_title` cleans to nothing, and the cleaning is
    /// genuinely a wire concern — it is what a person typed and what the session
    /// namer will re-clean. Neither rule here cleans anything: a key either matches
    /// a grammar or it does not, and a document either fits or it does not. Both are
    /// pure data validation on the row about to be written, which is exactly what a
    /// storage layer may own.
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

/// Insert the six default stages when this Space has none.
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
fn seed_default_stages(conn: &mut Connection, space_path: &str) -> Result<(), BoardError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM stages WHERE space_path = ?1",
        params![space_path],
        |row| row.get(0),
    )?;
    if count > 0 {
        return Ok(());
    }
    // The six defaults, spec §2 + §3.1. `label` is the slug capitalised and
    // `sort_order` is the index; `on_enter` is left OUT of the column list so
    // the DDL's `DEFAULT 'none'` stays the single source of that value instead
    // of a second copy of it spelled here. `on_enter_skill` IS spelled here,
    // because a fresh Space must launch the same two buttons an upgraded one
    // gets from the migration (ADR 0098) — and `next_slugs` is deliberately
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

/// The six default stages, in order: `(slug, label, on_enter_skill)`.
///
/// `discuss` sits BEFORE `research` (discuss it, then research it) and `approved`
/// stays in the seed — deleting a column is the editor's job, not the seed's
/// (spec §3.1). `on_enter` stays out of the tuple so the DDL's `DEFAULT 'none'`
/// remains the single source of that value.
const DEFAULT_STAGES: [(&str, &str, Option<&str>); 6] = [
    ("backlog", "Backlog", None),
    ("discuss", "Discuss", Some("discuss")),
    ("research", "Research", Some("research")),
    ("approved", "Approved", None),
    ("doing", "Doing", None),
    ("done", "Done", None),
];

/// Does this Space have a stage with this slug?
fn stage_slug_exists(conn: &Connection, space_path: &str, slug: &str) -> Result<bool, BoardError> {
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
fn available_slugs(conn: &Connection, space_path: &str) -> Result<String, BoardError> {
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
fn missing_stage(conn: &Connection, space_path: &str, wanted: &str) -> BoardError {
    BoardError::MissingStage {
        wanted: wanted.to_string(),
        available: available_slugs(conn, space_path).unwrap_or_default(),
    }
}

// ── T5/S4 — the crate's persistence seam, implemented (plan Steps B + B-bis) ──
//
// THE INSTANTIATION THAT IS S4'S GATE. The S4 ruling is explicit that a
// surface-comparison test which never builds this impl is void, so this block —
// not any test — is the proof that the trait's SHAPE is right: every method below
// must type-check against the INHERENT method it delegates to, with the real
// argument and return types. `src-tauri/tests/fulcrum_seams.rs` then makes that
// proof observable and records the deletion that reddens it.
//
// Every body is one delegation plus the `DbError → StoreError` map. No SQL and no
// error-handling policy is re-implemented here — the transaction boundaries, the
// `QueryReturnedNoRows` arms and the deliberate silent no-ops all stay in the
// inherent methods above — which is what makes the seam behaviour-identical by
// construction rather than by argument.
//
// Method resolution: the trait signatures are deliberately IDENTICAL to the
// inherent ones, and Rust prefers inherent methods, so the qualified calls below
// reach the SQLite code and cannot recurse into the trait. They are written
// `Db::method(self, …)` rather than `self.method(…)` so that stays true even if a
// future edit renames a trait method and shadows nothing.
impl FulcrumPersistence for Db {
    fn insert_native_message(
        &self,
        session_id: &str,
        seq: i64,
        role: &str,
        content_json: &str,
    ) -> Result<(), StoreError> {
        Db::insert_native_message(self, session_id, seq, role, content_json)?;
        Ok(())
    }

    fn replace_native_messages(
        &self,
        session_id: &str,
        rows: &[(i64, String, String)],
    ) -> Result<(), StoreError> {
        Db::replace_native_messages(self, session_id, rows)?;
        Ok(())
    }

    fn record_session_context_usage(
        &self,
        session_id: &str,
        used: u64,
        window: u64,
    ) -> Result<(), StoreError> {
        Db::record_session_context_usage(self, session_id, used, window)?;
        Ok(())
    }

    fn record_session_cost(&self, session_id: &str, total: f64) -> Result<(), StoreError> {
        Db::record_session_cost(self, session_id, total)?;
        Ok(())
    }

    fn record_session_todos(
        &self,
        session_id: &str,
        todos: Option<&str>,
    ) -> Result<(), StoreError> {
        Db::record_session_todos(self, session_id, todos)?;
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Option<SessionRow>, StoreError> {
        Ok(Db::session(self, session_id)?)
    }

    fn load_native_messages(&self, session_id: &str) -> Result<Vec<String>, StoreError> {
        Ok(Db::load_native_messages(self, session_id)?)
    }

    fn messages_for(&self, session_id: &str) -> Result<Vec<MessageRow>, StoreError> {
        Ok(Db::messages_for(self, session_id)?)
    }

    fn session_cost(&self, session_id: &str) -> Result<Option<f64>, StoreError> {
        Ok(Db::session_cost(self, session_id)?)
    }

    fn session_todos(&self, session_id: &str) -> Result<Option<String>, StoreError> {
        Ok(Db::session_todos(self, session_id)?)
    }

    fn record_session(&self, info: &SessionInfo) -> Result<(), StoreError> {
        Db::record_session(self, info)?;
        Ok(())
    }

    fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionRow>, StoreError> {
        Ok(Db::list_sessions(self, include_archived)?)
    }

    fn set_space_trusted(&self, path: &str, trusted: bool) -> Result<bool, StoreError> {
        Ok(Db::set_space_trusted(self, path, trusted)?)
    }

    fn upsert_space(&self, path: &str, default_trusted: bool) -> Result<(), StoreError> {
        Db::upsert_space(self, path, default_trusted)?;
        Ok(())
    }

    fn record_message(
        &self,
        session_id: &str,
        kind: &str,
        message_key: Option<&str>,
        payload_json: &str,
    ) -> Result<(), StoreError> {
        Db::record_message(self, session_id, kind, message_key, payload_json)?;
        Ok(())
    }

    /// The clock, delegating to the ONE definition (see the `now_ms` import
    /// above). The trait method exists so a crate caller holding
    /// `Arc<dyn FulcrumPersistence>` reaches the shared clock instead of minting
    /// its own; a `Db` carries no time of its own to read.
    fn now_ms(&self) -> i64 {
        now_ms()
    }
}

// ── The crate's Task-board seam (ADR 0092, issue #180 D2) ────────────────────
//
// The SYNC crate seam implemented SUPERVISOR-side, beside the persistence seam
// above and for the same reason: the Worker has no `Db` and cannot have one —
// ADR 0025 makes this process the sole SQLite writer, so a model's board verb has
// to be answered here and shipped back over the wire (`Outbound::TaskRequest` →
// `Inbound::TaskResponse`, routed in `agent/session/router.rs`).
//
// Every method delegates to the INHERENT `Db` method with the same qualified-call
// rule `FulcrumPersistence` uses — Rust prefers inherent methods, so
// `Db::method(self, …)` reaches the SQL and cannot recurse into the trait being
// defined — and every error crosses through the two `From` impls above
// (`DbError → TaskStoreError`, `BoardError → TaskStoreError`) rather than a
// per-method `map_err`, which is the same "one place owns the mapping" split the
// `StoreError` map documents.
//
// THE DTO MAPPING is the substance of this block, and four facts about it are
// worth stating because they are where a careless impl would go quietly wrong:
//
//   * `number` is `i64` on the desktop's `TaskRow` and `u32` on the crate's DTOs.
//     `number` is `MAX(number) + 1` per Space (ADR 0090), so it is positive and
//     small by construction; the `as u32` is a widening-free narrowing of a value
//     this file hands out itself. A Space with four billion cards would wrap, and
//     no board renders that — the cast is stated here rather than left to a reader
//     to invent a justification for.
//   * `artifact_keys` is REQUIRED on `BoardRow` and `TaskDetail` (never `Option`),
//     so it is filled from `artifact_keys` per row. That is one extra statement per
//     card on `list_board`; the aggregate `artifact_keys_for_space` exists for the
//     board's OWN read (`get_board`) and is not used here because the trait returns
//     rows already filtered by the caller's verb, and re-deriving that filter here
//     would be a second owner of "which cards belong to this Space".
//   * The crate's `TaskRow` (the write answer) carries NO `artifact_keys` field — a
//     write touched no artifact, so its answer says nothing about them. The desktop
//     `TaskRow` has no such field either, so `create_task` / `edit_task` map
//     field-for-field.
//   * `MoveOutcome` is where the two types genuinely differ: the crate's has
//     `to_stage` / `on_enter: Option` / `note: Option`, the desktop's has only
//     `on_enter: String`. `to_stage` is the caller's own argument (the desktop's
//     `move_task` refuses before it writes, so a successful move always lands where
//     it was told), `on_enter` becomes `Some` of the desktop's value, and `note` is
//     `None` because the desktop's `move_task` returns no note today — the boost
//     warning it would describe is computed in the COMMAND layer
//     (`commands/tasks.rs`'s `boost_note`), one layer above this seam and invisible
//     to it. Reporting it here would mean reaching past the storage layer for a
//     fact storage does not hold.
impl TaskStore for Db {
    fn list_board(&self, space_path: &str) -> Result<Vec<BoardRow>, TaskStoreError> {
        Db::list_tasks(self, space_path)?
            .into_iter()
            .map(|row| {
                let id = row.id.clone();
                Ok(BoardRow {
                    id: row.id,
                    space_path: row.space_path,
                    number: row.number as u32,
                    title: row.title,
                    body: row.body,
                    spec_path: row.spec_path,
                    stage_slug: row.stage_slug,
                    sort_order: row.sort_order,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    artifact_keys: Db::artifact_keys(self, &id)?,
                })
            })
            .collect()
    }

    fn get_task(&self, task_id: &str) -> Result<Option<TaskDetail>, TaskStoreError> {
        // The desktop's read already answers `Ok(None)` for an absent card, which is
        // the crate's contract too ("asking for what is not there is an answer").
        Db::get_task(self, task_id)?
            .map(|row| {
                let id = row.id.clone();
                Ok(TaskDetail {
                    id: row.id,
                    space_path: row.space_path,
                    number: row.number as u32,
                    title: row.title,
                    body: row.body,
                    spec_path: row.spec_path,
                    stage_slug: row.stage_slug,
                    sort_order: row.sort_order,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    artifact_keys: Db::artifact_keys(self, &id)?,
                })
            })
            .transpose()
    }

    fn create_task(
        &self,
        space_path: &str,
        title: &str,
        body: Option<&str>,
        stage_slug: Option<&str>,
    ) -> Result<CrateTaskRow, TaskStoreError> {
        let row = Db::create_task(self, space_path, title, body, stage_slug)?;
        Ok(desktop_row_to_crate_row(row))
    }

    fn edit_task(
        &self,
        task_id: &str,
        title: Option<&str>,
        body: Option<&str>,
        spec_path: Option<&str>,
    ) -> Result<CrateTaskRow, TaskStoreError> {
        let row = Db::edit_task(self, task_id, title, body, spec_path)?;
        Ok(desktop_row_to_crate_row(row))
    }

    fn move_task(
        &self,
        space_path: &str,
        task_id: &str,
        to_stage: &str,
    ) -> Result<CrateMoveOutcome, TaskStoreError> {
        let out = Db::move_task(self, space_path, task_id, to_stage)?;
        Ok(CrateMoveOutcome {
            to_stage: to_stage.to_string(),
            on_enter: Some(out.on_enter),
            note: None,
        })
    }

    fn get_artifact(
        &self,
        task_id: &str,
        key: &str,
    ) -> Result<Option<CrateArtifact>, TaskStoreError> {
        // Field-for-field: T4's `Artifact` was shaped to the crate's DTO on purpose
        // (the five names are identical), so this maps nothing and renames nothing.
        Ok(
            Db::get_artifact(self, task_id, key)?.map(|a| CrateArtifact {
                task_id: a.task_id,
                key: a.key,
                markdown: a.markdown,
                created_at: a.created_at,
                updated_at: a.updated_at,
            }),
        )
    }

    fn write_artifact(
        &self,
        task_id: &str,
        key: &str,
        markdown: &str,
    ) -> Result<CrateArtifactMeta, TaskStoreError> {
        let meta = Db::write_artifact(self, task_id, key, markdown)?;
        Ok(CrateArtifactMeta {
            key: meta.key,
            updated_at: meta.updated_at,
            bytes: meta.bytes,
        })
    }
}

/// The desktop's `TaskRow` → the crate's write-answer `TaskRow`.
///
/// The ONE place that mapping is spelled, shared by `create_task` and
/// `edit_task` — the two verbs whose answer is the row WITHOUT artifact keys.
/// A helper rather than an inline literal twice, so a field added to either
/// struct breaks ONE site and the break names the mapping.
fn desktop_row_to_crate_row(row: TaskRow) -> CrateTaskRow {
    CrateTaskRow {
        id: row.id,
        space_path: row.space_path,
        number: row.number as u32,
        title: row.title,
        body: row.body,
        spec_path: row.spec_path,
        stage_slug: row.stage_slug,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// The single key form of a `spaces` row (ADR 0010): the canonical path.
/// `None` when the path can't be canonicalized (the folder is missing, or
/// the filesystem changed) — the write path falls back to the raw string
/// (best-effort), the read path fails closed.
fn space_key(path: impl AsRef<std::path::Path>) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|c| c.display().to_string())
}

/// One-time backfill of `sessions.todos_json` from the newest non-read
/// checklist write in `messages` (ADR 0073).
///
/// THE MATCH IS DUAL AND STAYS THAT WAY: `manage_todo_list` OR
/// `manage_checklist`. fulcrum#20 renames the tool, and the rows this reads are
/// ALREADY WRITTEN in users' databases and are never rewritten — so a predicate
/// naming one spelling silently backfills nothing for every row written under the
/// other. ADR 0093 freezes the old name for exactly this reason; the widen adds a
/// second literal and renames NOTHING (neither the tool, nor `todos_update` /
/// `todos_clear`, nor the `todos_json` column). The release ORDER is the load-
/// bearing part: this must ship BEFORE the tag bump that carries the rename, or
/// existing installs upgrade to an empty Checklist with a green suite.
fn backfill_session_todos(conn: &Connection) -> Result<(), DbError> {
    let mut session_stmt = conn.prepare("SELECT id FROM sessions WHERE is_subagent = 0")?;
    let session_ids = session_stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(session_stmt);

    for session_id in session_ids {
        let matching_todos = {
            let mut msg_stmt = conn.prepare(
                "SELECT payload_json FROM messages \
                 WHERE session_id = ?1 AND kind = 'tool-call' \
                 AND (payload_json LIKE '%manage_todo_list%' OR payload_json LIKE '%manage_checklist%') \
                 ORDER BY id DESC",
            )?;
            let rows = msg_stmt.query_map(params![session_id], |row| row.get::<_, String>(0))?;
            let mut matched = None;

            for payload_res in rows {
                let payload_str = payload_res?;
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&payload_str) else {
                    continue;
                };
                // DUAL MATCH, permanently (fulcrum#20 / ADR 0093): the tool is
                // being renamed `manage_todo_list` → `manage_checklist`, and rows
                // under BOTH spellings exist in the wild and are never rewritten.
                // Dropping the old literal here would make every pre-rename
                // install backfill nothing — an empty Checklist, a green suite, no
                // error. This widening must RELEASE BEFORE the tag bump that
                // carries the rename, and it stays forever after.
                if !matches!(
                    val.get("title").and_then(serde_json::Value::as_str),
                    Some("manage_todo_list") | Some("manage_checklist")
                ) {
                    continue;
                }
                let Some(raw_input) = val.get("rawInput") else {
                    continue;
                };
                if raw_input
                    .get("operation")
                    .and_then(serde_json::Value::as_str)
                    == Some("read")
                {
                    continue;
                }
                let Some(todo_list) = raw_input
                    .get("todoList")
                    .and_then(serde_json::Value::as_array)
                else {
                    continue;
                };

                let mut filtered = Vec::new();
                for item in todo_list {
                    let Some(content) = item.get("content").and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(status) = item.get("status").and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    // Drop items with empty content or status (slightly stricter than the old frontend filter).
                    if content.is_empty() || status.is_empty() {
                        continue;
                    }
                    let mut clean_item = serde_json::Map::new();
                    clean_item.insert(
                        "content".into(),
                        serde_json::Value::String(content.to_string()),
                    );
                    clean_item.insert(
                        "status".into(),
                        serde_json::Value::String(status.to_string()),
                    );
                    if let Some(desc) = item.get("description").and_then(serde_json::Value::as_str)
                    {
                        clean_item.insert(
                            "description".into(),
                            serde_json::Value::String(desc.to_string()),
                        );
                    }
                    filtered.push(serde_json::Value::Object(clean_item));
                }

                if !filtered.is_empty() {
                    matched = Some(serde_json::to_string(&filtered)?);
                    break;
                }
            }
            matched
        };

        if let Some(serialized) = matching_todos {
            conn.execute(
                "UPDATE sessions SET todos_json = ?2 WHERE id = ?1",
                params![session_id, serialized],
            )?;
        }
    }
    Ok(())
}

/// One-time seed of `spaces.sort_order` on a pre-existing database (ADR 0075).
///
/// The read order is the OLD display order (`last_opened_at DESC, path ASC`)
/// and is HARDCODED on purpose: at seed time every row still carries
/// `DEFAULT 0`, so ordering by `sort_order` would be a pure tie and would pick
/// an order nobody ever saw — the upgrade must reproduce the list the user was
/// already looking at (ADR 0075's Consequences own the full reason).
fn seed_space_sort_order(conn: &Connection) -> Result<(), DbError> {
    let mut stmt =
        conn.prepare("SELECT path FROM spaces ORDER BY last_opened_at DESC, path ASC")?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    // Close the read cursor before the writes start (the `backfill_session_todos`
    // hygiene — a live Statement is not a compile or SQLite requirement).
    drop(stmt);

    for (index, path) in paths.iter().enumerate() {
        conn.execute(
            "UPDATE spaces SET sort_order = ?2 WHERE path = ?1",
            params![path, index as i64],
        )?;
    }
    Ok(())
}

/// One-time seed of `sessions.sort_order` on a pre-existing database (ADR 0075).
///
/// The read order is the OLD display order (last activity, then `id DESC`) and
/// is HARDCODED on purpose for the same reason as `seed_space_sort_order`: at
/// seed time the column is all `DEFAULT 0`, so it cannot be its own seed order.
///
/// NO `WHERE` — every row is numbered, hidden `is_subagent = 1` rows included
/// (hazard H1): the bottom-join `MAX + 1` is global, so a hidden row already
/// consumes a number, and seeding only the visible rows would duplicate values
/// and tie them with the visible row at 0.
fn seed_session_sort_order(conn: &Connection) -> Result<(), DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id FROM sessions ORDER BY {LAST_ACTIVITY} DESC, id DESC"
    ))?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt); // close the read cursor before the writes (hygiene, as above)

    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    Ok(())
}

/// A session's last activity in unix milliseconds: the newest timestamp in its
/// transcript, falling back to the row's own `created_at` when the transcript
/// is empty (`COALESCE` on the SUBQUERY — `MAX()` over no rows is `NULL`, which
/// SQLite sorts LAST in a `DESC` list, burying the newest thing on the list).
///
/// This is the single copy of the expression. It is the order the pre-manual
/// `list_sessions` used, it is the order `seed_session_sort_order` reads with,
/// and it is what the frontend prints as a session's `last_active_at` — so the
/// number a row shows and the number a recency decision reads cannot drift.
const LAST_ACTIVITY: &str = "COALESCE((SELECT MAX(m.created_at) FROM messages m \
                             WHERE m.session_id = sessions.id), sessions.created_at)";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message_key TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, kind, message_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS native_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq)
);
CREATE TABLE IF NOT EXISTS spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    on_enter_skill TEXT,
    next_slugs TEXT,
    PRIMARY KEY (space_path, slug)
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    space_path TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    spec_path TEXT,
    stage_slug TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_sessions (
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    stage_slug TEXT,
    PRIMARY KEY (task_id, session_id)
);
CREATE TABLE IF NOT EXISTS task_artifacts (
    task_id TEXT NOT NULL,
    key TEXT NOT NULL,
    markdown TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, key)
);
"#;

// ── The Task board tables (spec §2, ADR 0090) — notes on the batch above ───
//
// FOUR tables. They ride the idempotent `CREATE TABLE IF NOT EXISTS` batch and
// get NO migration entry of their own: `gate` above is a transaction factory for
// adding a COLUMN to an EXISTING table (it probes `pragma_table_info`), so a new
// TABLE needs no gate because the batch is already idempotent on re-open.
// `the_three_task_tables_are_in_schema_and_have_no_gate_entry` pins both halves
// (the name kept its #176 number when `task_artifacts` joined the batch in #180;
// the list is what is authoritative).
//
// The #179 Stage-config work DID add three gated COLUMNS — `stages.on_enter_skill`,
// `stages.next_slugs` and `spaces.board_strict` — and those are gates, because
// `stages` and `spaces` are tables a pre-#179 database already holds in an older
// shape. That is the distinction the pin draws: a new column on an existing table
// is gate territory, a new table never is.
//
// NO foreign key on `space_path`, on either board table (ADR 0090). Closing a
// Space tab runs `delete_space` (`DELETE FROM spaces WHERE path = ?1`), so a
// board that cascaded away with the tab would lose a person's whole workflow to
// a click that deletes nothing else; `sessions.cwd` carries no FK for exactly
// this reason. The consequence is accepted and named: a Task whose Space has no
// open tab is a **Detached task**, unreachable from the board until the folder
// is re-opened. `task_sessions.session_id` DOES carry the cascade clause the
// `messages`/`native_messages` tables already use — a deleted Session really
// should drop its link row, and the Task card survives it.
//
// `task_artifacts` carries NO foreign key either, and the asymmetry with
// `task_sessions` is the point (ADR 0100). A Session is a row that can actually
// be deleted, so its link row must cascade; a **Task has no delete verb at all**
// (`DELETE FROM tasks` has exactly one site in the tree and it is a test), so an
// FK here could only ever fire on a `delete_space` — which is precisely the
// cascade ADR 0090 forbids, one level down: an artifact dying because a tab
// closed. The cost of the choice is that SQLite will NOT reject a dangling
// `task_id`, so `write_artifact` refuses a missing Task itself (see that method).
//
// `on_enter` is `'none' | 'compact' | 'fresh'` (spec §5). It is a COLUMN rather
// than a constant so both boost strategies can be tried and compared without
// reopening the schema; nothing in v1 writes anything but the default.

#[cfg(test)]
mod tests;
