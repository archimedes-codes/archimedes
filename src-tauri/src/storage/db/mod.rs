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
//!
//! # The unit is split by subject (ADR 0113)
//!
//! This parent holds what every subject shares and what the pins read: the three
//! error types and their `From` maps, the `Db` struct, [`Db::open`] **whole**
//! (its twenty `gate` calls ARE the migration surface, and
//! `the_three_task_tables_are_in_schema_and_have_no_gate_entry` counts them from
//! this file's text), `gate`, `set_journal_pragmas`, `LAST_ACTIVITY` and `SCHEMA`.
//! Every subject lives in the sibling that names it — [`sessions`], [`messages`],
//! [`spaces`], [`board`], [`tasks`], [`stages`], [`artifacts`], [`seams`],
//! [`rows`], [`migrations`], [`auto_guards`], [`workflow_runs`] — and `tests/`
//! mirrors those siblings one for one.
//!
//! A sibling reads the parent's private `SCHEMA` / `gate` / `LAST_ACTIVITY` by
//! full path (a child module may, with no widening). Nothing a sibling declares is
//! widened past `pub(super)` **except** the [`auto_guards`] sibling's two auto-chain
//! fallback constants, which are `pub` and re-exported below for the reason stated
//! there — they are a shipped spend bound the auto-advance runtime must name by
//! path, and the retention subject's two bounds are the in-repo precedent for a
//! policy constant travelling exactly this route. The three things `pub(super)` IS
//! used for are enumerated at the `mod` list below.

use std::path::Path;
use std::sync::Mutex as StdMutex;

use rusqlite::{params, Connection, Transaction};

// T5/S4 (plan Step B-bis): the ROW TYPES moved to `fulcrum-core`, because the
// crate's `FulcrumPersistence` trait returns them and a crate cannot name a type
// that lives in `archimedes_lib`. They are pure serde data (8 and 6 `pub` fields,
// zero `rusqlite` references) — the SQL stayed here with `SESSION_COLUMNS` /
// `MESSAGE_COLUMNS` and the row mappers. Re-imported (desktop→crate, the allowed
// direction) so `crate::storage::SessionRow` and every other existing spelling
// resolves unchanged.
pub use fulcrum_harness::store_rows::{MessageRow, SessionRow};

use fulcrum_harness::seams::StoreError;
// (T5/S4, Step B-bis) The clock moved to `fulcrum_harness::clock` — this file's
// private copy and `agent/normalize.rs`'s `pub(crate)` copy were byte-identical
// duplicates, and the trait's `now_ms` would have been a third. Importing the
// one definition (rather than a one-line wrapper) leaves NO second body to drift:
// the timestamps this file writes and the `DisplayRow.created_at` the crate
// stamps are the same clock by construction.
use fulcrum_harness::clock::now_ms;

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

/// The error a board/artifact HOST TOOL answers with (ADR 0102 / issue #183 D1).
///
/// This type is what `fulcrum_harness::seams::TaskStoreError` used to be for. F3
/// deleted the crate's knowledge of Tasks — that error family included — and the
/// frame carrying an answer now holds a bare `Result<ToolResult, String>`, because a
/// crate with no idea what a host tool is has no business naming a host tool's
/// failure kind. So the KINDS move here with the mapping, and the wire carries the
/// sentence: the crate turns this type's `Display` into the failed tool result the
/// model reads verbatim.
///
/// The three kinds are kept rather than collapsed into one `String`, for two
/// reasons. First, `agent/host_tools/exec/mod.rs::spawn_host_call` is generic over the error
/// its closure returns and needs ONE type to fold both `BoardError` (the six inherent
/// verbs) and `DbError` (the board read's artifact-key enrichment) into. Second, the
/// distinction is what the tests assert on and what a reader needs: "the card is not
/// there", "the argument is not admissible" and "the database failed" are three
/// different facts, and a model reacts to the first two differently.
///
/// `Sqlite` gets no variant of its own for the same reason `StoreError` has none — no
/// `rusqlite` crosses into the crate — and none is needed: the `Sqlite → Io` map
/// below preserves the `sqlite error: ` prefix through `Display`, so WHICH layer
/// failed survives inside the sentence.
///
/// Lives in `storage` and NOT in `agent`, because it is built at the storage boundary,
/// beside the two `From` impls that are its whole substance — and `storage` never
/// names `crate::agent` (measured: zero occurrences), so a type the storage error
/// family owns cannot move up without inverting that edge.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum HostToolError {
    /// The call named a card (or a Space, or a Stage) that is not there.
    #[error("{message}")]
    NotFound { message: String },
    /// The call was well-formed and still not admissible: a key outside the artifact
    /// grammar, a markdown over the size cap, a title that cleans to nothing, a slug
    /// no column answers to.
    #[error("{message}")]
    Invalid { message: String },
    /// The storage layer itself failed — including a board call still running at the
    /// deadline, and a blocking task that died mid-call.
    #[error("{message}")]
    Io { message: String },
}

/// The `DbError → HostToolError` map the host-tool executors run through.
///
/// Lossy like the `StoreError` map beside it, and licensed by the same measurement:
/// `DbError` stays three-variant and DESKTOP-only (`Sqlite` is never constructible
/// crate-side), so this path only ever sees the three arms its own error type can
/// express.
///
/// `Sqlite → Io` with the sentence preserved through `Display` (the
/// `io error: sqlite error: …` degradation the map above documents — the model
/// reads this `message` as its tool result, so WHICH layer failed has to survive);
/// `Io → Io`; `Json → Invalid`, because a JSON failure is a malformed row
/// rather than an I/O failure, and folding it into `Io` would tell a model to retry a
/// write that will fail identically every time.
impl From<DbError> for HostToolError {
    fn from(e: DbError) -> Self {
        match e {
            DbError::Sqlite(inner) => HostToolError::Io {
                message: format!("sqlite error: {inner}"),
            },
            DbError::Io(e) => HostToolError::Io {
                message: e.to_string(),
            },
            DbError::Json(e) => HostToolError::Invalid {
                message: e.to_string(),
            },
        }
    }
}

/// One field of a patch: leave it, write this value, or clear it to NULL.
///
/// The third state is the point. `Db::edit_task` used to take `Option<&str>` and
/// `COALESCE` the result, which made `NULL` mean "do not change it" and left no value
/// that could blank a column — so a card could never stop naming a deleted file
/// (`finish` deletes `docs/roadmap/*` on ship, ADR 0100).
pub enum FieldPatch<'a> {
    /// Do not touch the column.
    Keep,
    /// Write this value.
    Set(&'a str),
    /// Write NULL.
    Clear,
}

impl<'a> FieldPatch<'a> {
    /// Which of the three states this is, as the SQL `CASE` discriminant:
    /// `0 = Keep`, `1 = Set`, `2 = Clear`.
    ///
    /// PRIVATE on purpose: the command layer builds the enum and never learns the
    /// encoding. The statement is fixed-arity (one `execute!`, no built SQL string)
    /// precisely so a patch cannot become an injection surface, and that only holds
    /// while the mode is a bound parameter rather than a formatted one.
    fn mode(&self) -> i64 {
        match self {
            FieldPatch::Keep => 0,
            FieldPatch::Set(_) => 1,
            FieldPatch::Clear => 2,
        }
    }

    /// The value to bind, or `""` when the mode will not read it.
    ///
    /// `""` is not a meaningful answer for `Keep`/`Clear` — the `CASE` picks the
    /// column or `NULL` and never looks at this slot — so no caller can mistake it
    /// for "write the empty string". That is `FieldPatch::Set("")`'s job.
    fn value(&self) -> &'a str {
        match self {
            FieldPatch::Set(s) => s,
            FieldPatch::Keep | FieldPatch::Clear => "",
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
    /// `find_space`/`set_space_trusted` split in `spaces.rs` (the sibling the split
    /// moved those two verbs to), carried over.
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

    /// `write_artifact` refuses a markdown over [`Db::MAX_ARTIFACT_MARKDOWN_BYTES`].
    ///
    /// Refused, NEVER truncated. Both numbers ride the variant (and the command
    /// layer re-emits them as `size`/`max` envelope keys, ADR 0063) so a caller
    /// learns how far over it went without parsing prose. The sentence matches
    /// `TasksError::ArtifactTooLarge`'s byte-for-byte, for the same reason as
    /// [`BoardError::BadArtifactKey`]'s does.
    #[error("artifact is {size} bytes, which exceeds the {max} bytes (256 KB) limit")]
    ArtifactTooLarge { size: usize, max: usize },

    /// `create_task` / `edit_task` refuse a title that [`crate::text::clean_title`]
    /// cleans to nothing (`""`, `"   "`, `"\n"`, and — the ones a naive
    /// `trim().is_empty()` lets through — the bare quote pairs `"\"\""` and `"''"`).
    ///
    /// No payload, in the same style as [`BoardError::EmptyStageSlug`]: there is no
    /// number to report and no name to echo back, because the offending value is
    /// nothing. The sentence below is byte-identical to `TasksError::EmptyTitle`'s
    /// in `agent/errors.rs`, and that is a requirement rather than tidiness — the
    /// same argument [`BoardError::BadArtifactKey`]'s docblock makes: the command
    /// layer maps this arm onto that variant FIELD-FOR-FIELD, so a person who breaks
    /// the rule gets ONE sentence whichever door caught it (ADR 0063 — the message is
    /// what the user reads).
    #[error("task title is empty after trimming")]
    EmptyTitle,
}

/// The `BoardError → HostToolError` map the host-tool executors run through
/// (issue #180, re-pointed at the desktop's own error type by ADR 0102 / #183 D1).
///
/// THIS IS THE MODEL-FACING SENTENCE FACTORY. Every board refusal a model can reach
/// through a host tool passes through here exactly once, and `BoardError`'s `Display`
/// is the sentence it reads — so a `#[error(...)]` edit and this table cannot drift,
/// and `docs/features/task-board-known-gaps.md` §2 cites the wording this produces.
///
/// Four arms carry the refusals a board VERB can reach through a host tool, and the
/// rest is the honest catch-all for the variants no verb can produce — see below.
///
/// - `MissingTask` → `NotFound`: a WRITE against a card that is not there. This is
///   the variant `write_artifact`'s dangling-id gate raises, and `NotFound` exists
///   for exactly that question.
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
/// `EmptyStageSlug` and `SelfLoop` are all STAGE-management refusals, and there is no
/// stage HOST tool at all — the seven verbs are board and artifact, never stage.
/// Folding them into `Invalid` rather than panicking is deliberate: a future verb
/// that starts raising one gets a correct-if-generic sentence, where a `unreachable!`
/// would panic inside a `spawn_blocking` and turn a storage refusal into the
/// `JoinError` the router reports as `Io`.
///
/// `BadArtifactKey` and `ArtifactTooLarge` sit in the SAME arm but for the opposite
/// reason: they ARE reachable, because `write_artifact` is a host tool and storage
/// enforces both rules for every door to `task_artifacts`. `Invalid`'s own doc names
/// exactly those two failures, so the mapping is the one the variant was written for.
///
/// `EmptyTitle` belongs with THAT paragraph, not with the stage refusals above it.
/// It is REACHABLE — `create_task` and `edit_task` are both host tools, and both
/// refuse a title that cleans to nothing before they touch a connection. `Invalid`'s
/// definition is "the call was well-formed and still not admissible", and a title is
/// exactly that: the arguments parsed, the card id is fine, and the label is not a
/// label. Documenting this arm under the stage paragraph would leave a docblock
/// arguing against the code beside it.
impl From<BoardError> for HostToolError {
    fn from(e: BoardError) -> Self {
        // `Display` IS the sentence the model reads, so it is rendered ONCE from
        // the variant that arrived and then dispatched on — never re-spelled per
        // arm, which is how a `#[error(...)]` edit and a mapping table drift apart.
        // (`Sqlite` needs no `format!` here for the same reason: the variant's own
        // `Display` already carries the `sqlite error: ` prefix.)
        let sentence = e.to_string();
        match e {
            BoardError::MissingTask(_) => HostToolError::NotFound { message: sentence },
            BoardError::Sqlite(_) => HostToolError::Io { message: sentence },
            // The two artifact refusals are MALFORMED ARGUMENTS, not absences, and
            // `Invalid`'s own doc names them (a key outside the artifact grammar, a
            // markdown over the size cap) — this arm is what makes that sentence
            // true. The grammar and the numbers ride in `Display`, which is what the
            // model reads as the tool result. `EmptyTitle` rides here too, and NOT
            // for the reason the stage refusals below do: it is REACHABLE, because
            // `create_task` and `edit_task` are host tools. A title that cleans to
            // nothing is a well-formed call whose argument is not admissible, which
            // is `Invalid`'s own definition.
            BoardError::BadArtifactKey { .. }
            | BoardError::ArtifactTooLarge { .. }
            | BoardError::EmptyTitle
            | BoardError::MissingStage { .. }
            | BoardError::StrictMoveRefused { .. }
            | BoardError::StageNotEmpty { .. }
            | BoardError::StageReferenced { .. }
            | BoardError::LastStage { .. }
            | BoardError::StageSlugTaken { .. }
            | BoardError::EmptyStageSlug
            | BoardError::SelfLoop { .. } => HostToolError::Invalid { message: sentence },
        }
    }
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

/// (#155) The durability pragmas `Db::open` runs, factored out of `Db::open`
/// so the DEGRADE branch is unit-testable.
///
/// Returns `None` when the connection ended up in WAL, or the REASON it did
/// not — and it NEVER returns `Err`. A database that refuses WAL (a network
/// mount without shared-memory support; an in-memory database) is a database
/// the user still has to be able to open, so the whole function degrades to a
/// log line rather than bricking startup.
///
/// WHY the readback instead of `pragma_update_and_check`'s `?`: `journal_mode`
/// **refuses silently** on some filesystems — `pragma_update` returns `Ok` and
/// the mode stays `delete`. That silent refusal is the entire risk here, and a
/// `?` cannot see it. So the mode is read back and compared case-insensitively
/// (SQLite spells it lowercase; a readback that is merely differently cased is
/// not a refusal). The `:memory:` case reproduces the refusal exactly, which is
/// what makes the branch testable in this repo — a criterion like "a
/// filesystem that refuses WAL still starts the app" is unverifiable here.
///
/// WHY the three pragmas, in one place:
/// - `journal_mode = WAL` — the measured fix. Rollback journal + `FULL` costs
///   3 `fdatasync`s per commit (14–17 ms measured at 400–700 MB); WAL+`FULL` is
///   1.1–1.6 ms and WAL+`NORMAL` ~0.12 ms. Database SIZE is not the issue.
/// - `synchronous = NORMAL` — safe under WAL: SQLite's own guidance is that
///   `NORMAL` costs at most a transaction's worth of work after an OS crash,
///   never a corrupt database, because WAL commits are append-only into the
///   `-wal` file.
/// - `busy_timeout = 5000` — WAL is the first mode where a reader can meet a
///   writer at all, and without a timeout that meeting is an immediate
///   `SQLITE_BUSY` error. Every connection this app opens goes through
///   `Db::open`, so the timeout reaches all of them; a `SQLITE_BUSY` anywhere
///   after this means it did NOT reach that connection, which is a bug and not
///   a flake.
///
/// Deliberately NOT here: `wal_autocheckpoint`. The 81 ms
/// `wal_checkpoint(TRUNCATE)` observed at 703 MB is a cost WAL *introduces*, and
/// tuning the autocheckpoint blind against it would trade one stall for another
/// with no measurement to say which is cheaper. Follow-up, not part of #155.
fn set_journal_pragmas(conn: &mut Connection) -> Option<String> {
    // `pragma_update` builds `PRAGMA name = value` and runs it through
    // `execute_batch`, which tolerates a row-returning pragma — so `journal_mode`
    // (which SELECTs its result) is settable this way with the existing idiom.
    // Each one is `if let Err`, not `?`: a hard failure on one pragma must not
    // skip the others, and must not fail the open.
    let mut failures: Vec<String> = Vec::new();
    let mut note = |name: &str, result: rusqlite::Result<()>| {
        if let Err(e) = result {
            failures.push(format!("`PRAGMA {name}` failed: {e}"));
        }
    };
    note(
        "journal_mode",
        conn.pragma_update(None, "journal_mode", "WAL"),
    );
    note(
        "synchronous",
        conn.pragma_update(None, "synchronous", "NORMAL"),
    );
    note(
        "busy_timeout",
        conn.pragma_update(None, "busy_timeout", 5_000_i64),
    );
    // The readback is the authority, not the calls above.
    let degraded = match conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0)) {
        Ok(mode) if mode.eq_ignore_ascii_case("wal") => None,
        Ok(mode) => Some(format!(
            "`PRAGMA journal_mode = WAL` was refused — the database reports \
             `{mode}`, so writes stay on the rollback journal (slower commits)"
        )),
        Err(e) => Some(format!(
            "the `PRAGMA journal_mode` readback failed: {e} — the journal mode \
             is unknown, so writes may still be on the rollback journal"
        )),
    };
    if failures.is_empty() {
        return degraded;
    }
    let detail = failures.join("; ");
    Some(match degraded {
        Some(reason) => format!("{reason}; {detail}"),
        None => detail,
    })
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
        // (#155) WAL + `synchronous = NORMAL` + `busy_timeout`, with the reason
        // for a degrade logged instead of the open failed. The WHYs — including
        // why the journal mode is READ BACK rather than trusted from the call —
        // are on the function. It must stay before every migration below: the
        // drop-migration and the gates are the expensive writes, and they are
        // the reason an upgrade-first open used to stall the window.
        if let Some(reason) = set_journal_pragmas(&mut conn) {
            fulcrum_harness::debuglog::log(&format!("db journal degrade: {reason}"));
        }
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
        // A chain interrupted by a process restart: close every run still open.
        //
        // WHY THIS EXISTS. A `workflow_runs` row is OPENED by `Db::workflow_run_step`
        // and CLOSED by the TypeScript settle handler (`advanceWorkflowChainOnSettle`
        // → `workflowRunClose`), so the close lives in the JS runtime. A window
        // reload, a quit or a crash mid-chain leaves `finished_at` NULL and there is
        // nothing left in the process that can ever stamp it — the settle edge for a
        // turn that already ended does not fire again. And `workflow_run_step`
        // UPSERTs onto the OPEN run, so the NEXT chain that card ever starts
        // inherits the dead chain's `steps` and `cost_usd`: a person who configured
        // a 20-step / $10 bound silently gets a shorter, partly-spent one. That is
        // the exact hazard `advanceWorkflowChainOnSettle`'s comment and ADR 0119 §3
        // describe for the paths the runtime DOES reach; this is the one it cannot
        // reach, and the sweep has to be on the Rust side because the runtime that
        // would perform it is the thing that just died.
        //
        // WHY IT IS SOUND TO CLOSE UNCONDITIONALLY: nothing can legitimately be
        // mid-chain across a process launch. The only writer of a step is a settle
        // handler in the JS runtime, and that runtime has just started — it holds no
        // in-flight chain to be counting against. So every `finished_at IS NULL` row
        // this statement sees is by definition an orphan.
        //
        // One statement, once per open, beside the one-time migrations below. It
        // must sit AFTER `execute_batch(SCHEMA)` above, because that batch is what
        // creates the table — before it, an older database has no `workflow_runs` to
        // update and the open fails. Unlike the `gate` calls it needs no schema
        // pre-check for exactly that reason.
        //
        // `'interrupted'` is a NEW `stop_reason` spelling and the ONLY one this file
        // writes. It joins the vocabulary `ChainStop::as_str()` freezes
        // (`db/workflow_runs.rs`) — see that enum for the rest — and like
        // `no_next_stage` / `launch_refused` it has no Rust-side producer in the
        // verdict: **it is emitted by Rust, not TypeScript**, and it is deliberately
        // NOT a `ChainStop` variant, because it is not a bound and a verdict must
        // never claim one. `a_run_left_open_by_a_restart_is_closed_when_the_database_reopens`
        // pins the spelling, and its companion pins that a CLOSED run is untouched —
        // the `WHERE finished_at IS NULL` arm is what keeps this a repair of orphans
        // rather than a rewrite of the record's only narrative field on every launch.
        conn.execute(
            "UPDATE workflow_runs SET finished_at = ?1, stop_reason = 'interrupted' \
             WHERE finished_at IS NULL",
            params![now_ms()],
        )?;
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
        // `on_enter_skill` carries the whole surviving #179 backfill, because the
        // column and the data are one atomic unit: the Skill UPDATE below writes a
        // column this ALTER creates, so the two share one gate — a crash rolls the
        // ALTER back with the backfill, and the next open re-runs the whole gate
        // instead of leaving the column unpopulated.
        //
        // This gate adds the column and backfills the ONE launch Skill that still
        // exists (`research`). The `discuss` backfill and the `discuss`
        // column-insert that used to live here went out with the retired Stage
        // (ADR 0107): the `discuss` Skill no longer exists, so the row the old
        // gate invented was a column whose launch button nothing could resolve. A
        // Space that still carries a `discuss` column is therefore USER DATA the
        // Stage editor owns — deleting a column is the editor's job, not a
        // migration's — and this gate deliberately leaves it alone rather than
        // filling what it used to call a hole.
        gate(&mut conn, "stages", "on_enter_skill", |tx| {
            tx.execute("ALTER TABLE stages ADD COLUMN on_enter_skill TEXT", [])?;
            // spec §3.1 step 1: the one surviving launch Skill. `IS NULL` keeps the
            // statement a backfill rather than an overwrite, and it is what makes
            // the whole gate safe to re-run after a crash.
            tx.execute(
                "UPDATE stages SET on_enter_skill = 'research' \
                 WHERE slug = 'research' AND on_enter_skill IS NULL",
                [],
            )?;
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
        // The per-column auto-advance flag (the workflow-graph work). A new
        // COLUMN on `stages` — a table a pre-existing database already holds —
        // so it is gate territory (AGENTS.md): an existing user database must
        // GAIN the column, not fail to open over a `no such column` the first
        // `SELECT STAGE_COLUMNS` runs against it.
        //
        // The `0` default is the whole compatibility story, and it is the same
        // argument `spaces.board_strict` above makes about Strict: a flag that
        // arrived ON would start advancing cards on their own in a workflow
        // whose owner never asked for that, so an upgrade would change behaviour
        // nobody upgraded for. OFF is not a convenience default, it is the
        // statement that this release adds a capability and does not use it.
        //
        // NOT a `DEFAULT`-less column like `parent_session_id`: `auto` has no
        // third state to protect. It is a two-valued flag whose off state is a
        // real answer, so the DDL spells that answer rather than leaving NULL to
        // be folded into it by every reader.
        gate(&mut conn, "stages", "auto", |tx| {
            tx.execute(
                "ALTER TABLE stages ADD COLUMN auto INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // The per-column extra prompt, prepended before the Skill launch. Same
        // gate argument as `auto` one line above: a new column on an EXISTING
        // table, so an existing database has to grow it.
        //
        // NO `DEFAULT` and NO backfill, deliberately, and it is the
        // `parent_session_id` / `cost_usd` argument rather than the `auto` one:
        // `NULL` here means "this column adds no prompt", which is the truth for
        // every column in every existing database. A `DEFAULT ''` would migrate
        // them all to "an empty extra prompt" — a SECOND state that means the
        // same thing by a different spelling, and one the launch path would have
        // to special-case forever. One absent state, spelled NULL.
        gate(&mut conn, "stages", "prompt_prefix", |tx| {
            tx.execute("ALTER TABLE stages ADD COLUMN prompt_prefix TEXT", [])?;
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
        // One-time migration for pre-existing databases: add
        // `parent_session_id` to `sessions` (fresh databases already have it from
        // `SCHEMA`). The same pragma-gated pattern as the `cost_usd` migration
        // above, and it inherits that gate's argument wholesale.
        //
        // NO `DEFAULT` and NO backfill, and that is the load-bearing part of this
        // gate: `NULL` means "this child's parent was never known", which is the
        // truth for roughly HALF the Subagent children in a live database — 1,325
        // of 2,643 in the measured database already have no parent row at all,
        // because deleting a parent destroys the rows naming its children while the
        // children survive. A `DEFAULT ''` would migrate every one of them into
        // "my parent is the session whose id is the empty string" — a parent
        // fabricated out of nothing, which is the phantom-`$0.00` defect one column
        // over (issue #105, D5 / ADR 0082) wearing a different hat. There is
        // nothing honest to backfill either: the parent-child link was never stored
        // anywhere before this column existed. That no-default rule is asserted by
        // `parent_session_id_column_migration_on_a_preexisting_db`, which reads
        // `pragma_table_info('sessions').dflt_value` and requires NULL — a `DEFAULT`
        // added here fails that pin.
        //
        // NO FOREIGN KEY, deliberately, and the test pins the forbidden spelling
        // absent. An `ON DELETE CASCADE` FK would delete
        // the CHILD `sessions` rows, which the design forbids — the row survives
        // because it carries `cost_usd` and costs 0.6 MB for 2,643 rows, and its
        // transcript is what the retention verbs trim, not the row. A
        // non-cascading FK would REFUSE the ~50% whose parent is already gone, i.e.
        // it would refuse the future writes too. A dangling `parent_session_id` is
        // therefore a storable, expected state. The precedent is `sessions.cwd`,
        // which carries no FK to `spaces` for the identical reason (see the board
        // tables' comment below: a board that cascaded away with the tab would lose
        // a person's whole workflow to a click that deletes nothing else).
        // `task_sessions.session_id` is the COUNTER-example — that link DOES carry
        // `ON DELETE CASCADE`, because a Session has a delete verb and a Task does
        // not.
        gate(&mut conn, "sessions", "parent_session_id", |tx| {
            // No transaction wrapper is spelled at this call site: the single
            // ALTER runs inside the factory's tx, exactly as `cost_usd` above does.
            tx.execute("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT", [])?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `ready` to `sessions`
        // (fresh databases already have it from `SCHEMA`) and convert the rows that
        // ALREADY carry the readiness claim. The ALTER and the backfill run in ONE
        // transaction, so a crash rolls both back and retries on the next open — the
        // `todos_json` gate's shape, and for the same reason: this column's data step
        // writes a column this ALTER creates, so the two cannot be separated.
        //
        // NO `DEFAULT`, and that is the load-bearing part of this gate. It is the
        // `cost_usd` argument (issue #105, D5 / ADR 0082) one column over: `NULL`
        // means "this Session never claimed to be done" and renders NOTHING, while
        // `0` means "it was re-checked and it is not ready" and renders an answer.
        // A `DEFAULT 0` would migrate a person's whole history into the second
        // meaning — a verdict about work nobody re-checked — and the readiness column
        // would stop being a fact the moment it arrived. That no-default rule is
        // asserted by `the_ready_gate_arrives_null_for_every_pre_existing_session`,
        // which reads `pragma_table_info('sessions').dflt_value` and requires NULL, so
        // a `DEFAULT` added here fails a pin rather than passing the `NULL` asserts.
        //
        // The backfill is the ONLY data step, and it is narrow on purpose: it marks
        // `1` exactly the rows whose stored checklist holds a COMPLETED item whose
        // content is the word `ready` — the claim the frontend used to scrape out of
        // `todos_json` — and writes NOTHING to any other row, because absent is
        // already `NULL` and `NULL` is the honest answer for them.
        gate(&mut conn, "sessions", "ready", |tx| {
            tx.execute("ALTER TABLE sessions ADD COLUMN ready INTEGER", [])?;
            // The backfill helper takes `&Connection`; deref coercion reaches it
            // from the `&mut Transaction`, so the data step runs on the SAME
            // transaction as the ALTER above.
            backfill_session_ready(tx)?;
            Ok(())
        })?;
        // The two per-Space auto-chain GUARDS (the workflow-graph work). Rides the
        // `spaces` row exactly as `board_strict` two gates up does — a new COLUMN on
        // a table an existing user database already holds, which is gate territory
        // (AGENTS.md), and `SpaceRow` gains NO field, so the `Vec<SpaceRow>` wire
        // type is untouched and the guards are read and written by SQL alone.
        //
        // NO `DEFAULT` and NO backfill on either, and that is the load-bearing part
        // of both gates. It is ADR 0082's `cost_usd` argument one table over, with
        // the stakes turned up because what is being defaulted is a SPEND limit:
        // NULL means "this Space never configured a guard", which the runtime reads
        // as "the shipped fallback governs", while `0` means "no auto-chaining" and
        // `0.0` means "no spend" — both CONFIGURED values a person may legitimately
        // choose. A `DEFAULT 0` would migrate every existing Space into a limit
        // nobody set, exactly as `DEFAULT 0` on `cost_usd` migrated every row into a
        // `$0.00` the provider never reported. And a `DEFAULT` large enough to be
        // harmless would be indistinguishable from a real setting, which is the other
        // half of the same collapse. `NULL` is the only honest value for a column
        // that never existed. Both `dflt_value`s are pinned to NULL by
        // `the_auto_max_steps_gate_arrives_null_on_a_preexisting_space` and
        // `the_auto_ceiling_usd_gate_arrives_null_on_a_preexisting_space`, so a
        // `DEFAULT` added here fails a pin rather than passing the `None` asserts.
        //
        // NO CHECK constraint either: a negative bound is storable and the read
        // returns it verbatim, because whether the number is SANE is the editor's
        // question, not storage's (the `prompt_prefix` / `set_stage_prompt_prefix`
        // argument — refusing a value the wire does not forbid is storage inventing
        // a rule).
        gate(&mut conn, "spaces", "auto_max_steps", |tx| {
            tx.execute("ALTER TABLE spaces ADD COLUMN auto_max_steps INTEGER", [])?;
            Ok(())
        })?;
        gate(&mut conn, "spaces", "auto_ceiling_usd", |tx| {
            tx.execute("ALTER TABLE spaces ADD COLUMN auto_ceiling_usd REAL", [])?;
            Ok(())
        })?;
        // The two hand-arranged canvas coordinates (the Workflows canvas's
        // n8n-style "drag it where you want it and it stays"). TWO gates because
        // `gate` probes ONE column, and one gate naming two columns cannot answer
        // "is this one absent". They are the LAST two probes, which is the order
        // `each_cluster_schema_omits_exactly_one_gated_column`'s `GATED` list
        // spells — that pin walks the list in probe order against the fixtures.
        //
        // NO `DEFAULT` and NO backfill on either, and that is the whole upgrade
        // story: `NULL` means "this column was NEVER hand-arranged, so the canvas
        // lays the node out with dagre", which is the truth for every row in every
        // existing database. A `DEFAULT 0` would migrate all of them into
        // "hand-placed at the origin" — a CONFIGURED position nobody configured —
        // and the first canvas open after an upgrade would stack every node in the
        // user's workflow at (0, 0) while bypassing dagre for all of them. That is
        // ADR 0082's phantom-`$0.00` collapse one table over, wearing a coordinate
        // instead of a cost, and it is the same argument `spaces.auto_max_steps`
        // two gates up makes about a spend bound: `0` is an answer, `NULL` is the
        // absence of one. Both `dflt_value`s are pinned to NULL by
        // `both_position_gates_arrive_null_on_a_preexisting_board`, so a `DEFAULT`
        // added here fails a pin rather than passing the `None` asserts.
        //
        // NO CHECK constraint and NO range rule: whether a coordinate is SANE is
        // the canvas's question, not storage's (the `prompt_prefix` /
        // `set_stage_prompt_prefix` argument — refusing a value the wire does not
        // forbid is storage inventing a rule). Negative coordinates are real: a
        // node dragged left of the dagre origin has one, and the canvas pans.
        //
        // The pair's "both or neither" rule is NOT enforced here and cannot be:
        // SQLite cannot express a two-column constraint in an `ADD COLUMN`, and
        // `gate` is a per-column probe. It is enforced by making the state
        // unrepresentable one layer up — `Db::set_stage_position` takes ONE
        // `Option<(f64, f64)>`, so there is no argument list that spells a
        // half-pair — and by `require_position_pair` at the wire, which is the
        // only door where a half-pair can arrive at all.
        gate(&mut conn, "stages", "position_x", |tx| {
            tx.execute("ALTER TABLE stages ADD COLUMN position_x REAL", [])?;
            Ok(())
        })?;
        gate(&mut conn, "stages", "position_y", |tx| {
            tx.execute("ALTER TABLE stages ADD COLUMN position_y REAL", [])?;
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    -- NO `DEFAULT` and NO foreign key, and both are decisions: NULL means "the
    -- parent was never known", which is honest for the children whose parent row
    -- is already gone. See the `parent_session_id` gate in `Db::open` and
    -- `parent_session_id_column_migration_on_a_preexisting_db`.
    parent_session_id TEXT,
    -- THREE meanings live in this one nullable column and the absence of a
    -- `DEFAULT` is what keeps them three: NULL = "this Session NEVER CLAIMED to be
    -- done" (never marked, or the claim was cleared at the start of a new turn),
    -- 0 = "it was checked and it is NOT ready" (an explicit answer), 1 = "it claimed
    -- readiness; come look". A `DEFAULT 0` would migrate every pre-existing row into
    -- the second meaning — an answer about work nobody re-checked — which is exactly
    -- the phantom-`$0.00` collapse `cost_usd`'s gate documents and pins, so this
    -- column arrives DEFAULT-less and the gate below backfills only the rows that
    -- genuinely carry the old stored marker.
    ready INTEGER
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
    board_strict INTEGER NOT NULL DEFAULT 0,
    -- The two per-Space auto-chain GUARDS. NO `DEFAULT` on either, and that is
    -- the same discipline `sessions.cost_usd` carries (issue #105, D5 / ADR 0082):
    -- NULL means "not configured", so the shipped fallback constants govern,
    -- while `0` / `0.0` are CONFIGURED values a person chose — "no auto-chaining"
    -- and "no spend" respectively. A `DEFAULT 0` would migrate every existing
    -- Space into a limit nobody set. See both gates in `Db::open`.
    auto_max_steps INTEGER,
    auto_ceiling_usd REAL
);
CREATE TABLE IF NOT EXISTS stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    on_enter_skill TEXT,
    next_slugs TEXT,
    auto INTEGER NOT NULL DEFAULT 0,
    prompt_prefix TEXT,
    position_x REAL,
    position_y REAL,
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
-- (D11) `Db::task_numbers` correlates a `MAX(rowid)` subquery per link row on
-- `task_sessions.session_id`; without this index that subquery is a full scan for
-- EVERY row (measured: 53.8 ms → 1.1 ms at 1000 Sessions × 3 links). The table's
-- PRIMARY KEY is `(task_id, session_id)`, whose LEADING column is `task_id`, so
-- SQLite cannot use it for a `session_id` lookup — hence a second, single-column
-- index.
--
-- It sits HERE, directly after its own table, and that is not cosmetic: `SCHEMA`
-- runs as ONE `execute_batch`, so a statement cannot reference a table a LATER
-- statement in the same batch creates. The plan asked for it beside
-- `idx_messages_session`, which is legal for `messages` (its table precedes it)
-- and illegal here; putting it there fails every `Db::open` with
-- `no such table: main.task_sessions`. `idx_messages_session`'s own position —
-- immediately after the table it indexes — is the convention this follows.
--
-- An INDEX rides the same idempotent batch as the tables and gets NO `gate`
-- entry, exactly as a new TABLE does: `gate` is a factory for adding a COLUMN to
-- a table an older database already holds, and `IF NOT EXISTS` already covers
-- re-open. It moves neither count the schema pins read.
CREATE INDEX IF NOT EXISTS idx_task_sessions_session ON task_sessions(session_id);
CREATE TABLE IF NOT EXISTS task_artifacts (
    task_id TEXT NOT NULL,
    key TEXT NOT NULL,
    markdown TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, key)
);
-- The record ONE auto-advance chain leaves behind: the thing the step bound and
-- the cost ceiling are counted against, and the reason the guards can ship before
-- the runtime that reads them (an unattended chain of LLM Sessions is an
-- unbounded spend risk, and you cannot bound what you cannot count).
--
-- Run semantics: AT MOST ONE OPEN run per Task (`finished_at IS NULL`). A run
-- OPENS on the first auto-advance of a chain and CLOSES when the chain stops, so
-- a card that auto-advances twice in a day is TWO bounded runs, not one
-- unbounded one — the bound is per chain.
--
-- `finished_at` is the open/closed discriminator and `NULL` here is the ONLY
-- spelling of "still running" — there is no default to collapse it into.
-- `cost_usd` keeps ADR 0082's discipline for the same reason its sibling on
-- `sessions` does: NULL is "no Session in this chain ever reported a figure",
-- 0.0 is "they reported a real zero", and the ceiling must not trip on the first
-- one rendered as the second. `steps` is the exception: it is a counter that
-- starts at 0 and is incremented, never a figure that may be unknown.
--
-- NO foreign key, on either `space_path` or `task_id`, and for the ADR 0090/0100
-- reason the two board tables state above: closing a Space tab runs `delete_space`,
-- and a run record that cascaded away with the tab would erase the money a person
-- is trying to audit. A Task has no delete verb at all, so a `task_id` FK could
-- only ever fire on that same tab close.
CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    space_path TEXT NOT NULL,
    task_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    steps INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    stop_reason TEXT
);
-- The lookup the runtime makes on every auto-advance is "does this Task already
-- have a run open?", and this PARTIAL index is exactly that question: it covers
-- only the `finished_at IS NULL` rows, so it stays one entry per OPEN chain while
-- the closed history grows underneath it. A plain index on `task_id` would be a
-- second, larger copy of what the primary key's own lookups already do.
--
-- UNIQUE, and that is the load-bearing word. `WorkflowRunRow`'s doc states "at most
-- ONE open row per Task" and
-- `workflow_run_step`'s `SELECT id … WHERE finished_at IS NULL` reads whichever row
-- SQLite reaches first — so a second open row would count a chain against a
-- stranger's `steps` and spend, i.e. THE SPEND BOUND FAILING OPEN. A plain index
-- documents that shape and enforces nothing; this one refuses it at the INSERT,
-- which is the only place the invariant can be enforced without a second round trip
-- inside the step verb. `a_second_open_run_for_one_task_is_rejected_by_the_schema`
-- pins the refusal.
--
-- WHY NOW AND NOT LATER: `CREATE UNIQUE INDEX IF NOT EXISTS` against an existing
-- index of the SAME NAME that is NOT unique is a SILENT NO-OP — SQLite sees the
-- name, skips the statement, and the old non-unique index stays in place forever.
-- So editing the word `UNIQUE` into this line after release would look shipped and
-- be nothing; it would later cost a `DROP INDEX`-and-recreate migration on every
-- existing database. This is the only cheap moment to say it.
--
-- It sits HERE, directly after its own table, for the reason
-- `idx_task_sessions_session`'s comment above gives verbatim: `SCHEMA` runs as
-- ONE `execute_batch`, so a statement cannot reference a table a LATER statement
-- creates. And like that one, an INDEX gets NO `gate` entry — `gate` adds a COLUMN
-- to a table an older database already holds, and `IF NOT EXISTS` already covers
-- a re-open.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_open
    ON workflow_runs(task_id) WHERE finished_at IS NULL;
"#;

// ── The Task board tables (spec §2, ADR 0090) — notes on the batch above ───
//
// FIVE tables ride this batch: `stages`, `tasks`, `task_sessions`,
// `task_artifacts` and `workflow_runs`. They ride the idempotent
// `CREATE TABLE IF NOT EXISTS` batch and
// get NO migration entry of their own: `gate` above is a transaction factory for
// adding a COLUMN to an EXISTING table (it probes `pragma_table_info`), so a new
// TABLE needs no gate because the batch is already idempotent on re-open.
// `the_three_task_tables_are_in_schema_and_have_no_gate_entry` pins both halves
// (the name kept its #176 number when `task_artifacts` joined the batch in #180 and
// when `workflow_runs` joined with the auto-chain work;
// the list is what is authoritative).
//
// The #179 Stage-config work DID add three gated COLUMNS — `stages.on_enter_skill`,
// `stages.next_slugs` and `spaces.board_strict` — and those are gates, because
// `stages` and `spaces` are tables a pre-#179 database already holds in an older
// shape. The workflow-graph work added FOUR MORE for the identical reason — `auto`
// and `prompt_prefix` to `stages`, `auto_max_steps` and `auto_ceiling_usd` to
// `spaces` — because both tables are ones an existing user database already holds
// in the older shape, and a missing column is a `no such column` at the first
// `SELECT` rather than a table the batch can create. The counts in those two
// sentences are history, not
// the current surface — `the_three_task_tables_are_in_schema_and_have_no_gate_entry`
// pins what the tree measures today. That is the distinction the pin draws: a new
// column on an existing table is gate territory, a new table never is — which is
// why `workflow_runs`, the FIFTH table in this batch, rides `SCHEMA` with no gate
// and no entry in that pin's forbidden list by the same rule the four that joined
// it follow.
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

// ── The split (ADR 0113) ─────────────────────────────────────────────────────
//
// ONE sibling per subject, named for the subject. The parent above keeps what is
// genuinely shared (the error types, `Db`, `open`, `gate`, the pragmas,
// `LAST_ACTIVITY`, `SCHEMA`) and nothing else. A sibling may read those by full
// path WITHOUT widening, because Rust privacy is "the defining module and its
// descendants" and every sibling is a descendant of this one. What a sibling
// declares `pub` is ONLY what a re-export below names, and every one of those
// re-exports is the retention/`rows` precedent doing its job: a `pub` item in a
// private module is unreachable outside `storage/` without the line, and each
// entry states who needs it. Nothing is declared `pub(crate)` at all. The 29
// `pub(super)` items the children do carry fall into THREE
// categories, and naming all three is the point — the sentence this block replaced
// claimed the first category was the only one:
//
//   * SIBLING→SIBLING, the majority (20): `rows`' column consts and row mappers,
//     read by every subject that runs a `SELECT`, plus `stages`' five helpers,
//     `seams`' `space_key`, and `auto_guards`' guard projection — which
//     `workflow_runs` reads while it holds the one lock that read has to ride.
//   * PARENT→CHILD (4): the four `migrations` data steps, imported by `mod.rs` just
//     below and called from inside `open`'s `gate` closures. `pub(super)` is what the
//     PARENT needs here, not a sibling reaching sideways — so none of them can be a
//     plain `fn`, and `pub(super)` is the honest spelling of a child's API its parent
//     uses.
//   * TEST-ONLY (5): `SESSION_` / `MESSAGE_` / `SPACE_` / `STAGE_` / `TASK_ROW_FIELDS`
//     in `rows`, imported by nothing in `src/` except `db/tests/rows.rs`. They are the
//     arity side of the drift guards, so their only consumer is the test tree.

mod artifacts;
mod auto_guards;
mod board;
mod messages;
mod migrations;
mod parent_link;
mod retention;
mod rows;
mod seams;
mod sessions;
mod spaces;
mod stages;
mod tasks;
mod workflow_runs;

// `Db::open`'s gates run these four data steps inside their own transactions.
use migrations::{
    backfill_session_ready, backfill_session_todos, seed_session_sort_order, seed_space_sort_order,
};

// The 11 row/view types the split moved to [`rows`]. `storage/mod.rs`'s
// `pub use db::{…}` list names them, so this re-export is the whole integration
// fix. EXPLICIT names, not `pub use rows::*`: a glob re-export would widen every
// private mapper and const in `rows` to the crate's public surface, and an unused
// shim of any one of them is an `unused_imports` error under `-D warnings`.
// `MessageRow` / `SessionRow` are NOT here — they stay behind the
// `pub use fulcrum_harness::store_rows::{…}` above, which is where they live.
pub use rows::{
    Artifact, ArtifactMeta, BoardRow, MoveOutcome, MoveToolOutcome, SessionRecency, SpaceRow,
    StageRow, StageWithTasks, TaskCardView, TaskDetail, TaskNumberRow, TaskRow, TaskSessionRow,
};

// The workflow subject's PUBLIC surface: the run record and the VERDICT a step
// answers with (`AdvanceVerdict` + the `ChainStop` vocabulary it carries), from
// `workflow_runs`, and the two guards from `auto_guards`. Same widening the `rows`
// re-export above performs for a private sibling's items — `mod db;` is private in
// `storage/mod.rs`, so `crate::storage::db::…` is not a path outside `storage/`, and
// the command layer's `get_auto_guards` return type has to be nameable.
// `WorkflowRunRow` rides with it because the auto-advance runtime reads it back from
// `workflow_run_step` and nothing in `storage/` should have to reach into a private
// sibling to name what a `Db` verb returns — and `AdvanceVerdict` now rides for the
// stronger reason: it IS what `workflow_run_step` returns, and the guard decision the
// runtime obeys is inside it.
pub use auto_guards::AutoGuards;
pub use workflow_runs::{AdvanceVerdict, ChainStop, WorkflowRunRow};

// `PrunedCounts` and the two bounds are the retention subject's PUBLIC surface, and
// they need this line to be nameable at all: `mod db;` is private in
// `storage/mod.rs`, so `crate::storage::db::…` is not a path outside `storage/`,
// and `storage/mod.rs` re-exports the three names below. This is the same widening
// the `rows` re-export above performs for a private sibling's items. `Db`'s verbs
// need no line here — they are inherent methods on the already-re-exported `Db`.
pub use retention::{
    PrunedCounts, MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE, VACUUM_FREELIST_THRESHOLD_BYTES,
};

// The two auto-chain fallback constants, re-exported because the TEST tree reads
// them by path. `pub use` for the SAME mechanical reason the retention bounds above
// carry one: `mod db;` is private in `storage/mod.rs`, so a `pub` item in a private
// sibling is not nameable outside `storage/` without this line, and
// `storage/mod.rs` re-exports them.
//
// WHO ACTUALLY CONSUMES THEM, measured rather than assumed: `db/tests/auto_guards.rs`
// and `commands/tasks/tests/workflows.rs`, which assert the EFFECTIVE bounds on a
// verdict against the CONSTANTS and not against the literals 20 and 10.0 — the reason
// `the_fallback_constants_carry_their_approved_values` gives for preferring the
// constant over the literal (a literal passes under a re-tuned policy the mirror no
// longer describes). NO PRODUCTION CODE OUTSIDE `storage/db/` names them, and that is
// deliberate: the auto-advance runtime is TypeScript and ADR 0119 §2 keeps the two
// fallbacks Rust-only precisely so a policy number is not duplicated across the wire.
// The earlier sentence here claimed the runtime "must name them by path"; it does
// not, and it must not.
pub use auto_guards::{DEFAULT_AUTO_CEILING_USD, DEFAULT_AUTO_MAX_STEPS};

#[cfg(test)]
mod tests;
