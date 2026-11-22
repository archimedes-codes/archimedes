//! Shared fixtures for the `db` mirror test tree (ADR 0113's one non-mirror
//! child). The rule this file obeys: an item lives here because MORE THAN ONE
//! subject child reads it; a fixture with a single caller belongs in that child.
//! THE RULE COUNTS CONSUMERS, NOT CALL SITES — that distinction is what settles
//! the only contested case below.
//!
//! Two families live here:
//!
//!   * the raw-SQL probes (`raw_column`, `raw_i64s`, `raw_scalar`, `sort_order_of`,
//!     `artifact_rows`, `wal_frame_count`) — a `Db` owns ONE private `Connection`,
//!     so a test that must read the file underneath it opens its own
//!     `rusqlite::Connection` through these;
//!   * the legacy-schema fixtures (`legacy_*` macros, the `SCHEMA_WITHOUT_*`
//!     consts, `preexisting_db`, `create_pre_sort_order_db`) that build a
//!     pre-migration database file WITHOUT opening `Db`, because `Db::open` is the
//!     code under test.
//!
//! Six fixtures the split's plan listed as shared turned out to have exactly ONE
//! calling child, so they live in that child instead of here: `session_on` in
//! `tests/sessions.rs`, `record_linkable_session` in `tests/board.rs`, `task_rows`
//! in `tests/tasks.rs`, and `has_column` / `stage_order` /
//! `pre_task_board_rows` / `SCHEMA_PRE_TASK_BOARD_CONFIG` in `tests/stages.rs`.
//!
//! THREE groups of single-reader items stay here anyway, for two different reasons,
//! and both reasons are the rule's own wording rather than an exception to it:
//!
//!   * SIX of the eight `SCHEMA_WITHOUT_*` consts (`…_ARCHIVED`, `…_CONTEXT_USAGE`,
//!     `…_COST_USD`, `…_STAGES_ON_ENTER_SKILL`, `…_STAGES_NEXT_SLUGS`,
//!     `…_SPACES_BOARD_STRICT`) are read ONLY by `tests/open.rs`, and they stay.
//!     That child consumes them as a COMPLETE SET —
//!     `each_cluster_schema_omits_exactly_one_gated_column` walks all eight by name
//!     and asserts each omits exactly one gated column, so the property lives in the
//!     SET and not in any one string. One consumer of a set is still the reason the
//!     set exists: the rule counts CONSUMERS, not call sites, and scattering the
//!     names into their individual children would split a pin that is only assertable
//!     over all of them. (The other two, `…_SPACE_SORT_ORDER` and
//!     `…_SESSION_SORT_ORDER`, have a genuine second reader — `tests/migrations.rs`
//!     — and need no defence.)
//!   * `wal_frame_count`, read only by `tests/messages.rs`. It stays `pub(super)`
//!     in this file because `storage/batching/tests/mod.rs` names it as the ORIGIN
//!     of the commit-counter instrument and keeps its OWN local copy on purpose (that
//!     module re-derives the page size from the SQLite file header rather than
//!     reaching through a `Db`), so the name is documentation of a shared instrument
//!     even though no second child in THIS tree imports it. Moving it into
//!     `tests/messages.rs` would break that cross-file citation for no gain.
//!   * `artifact_rows`, read only by `tests/artifacts.rs`, stays for the identical
//!     citation reason: `tests/tasks.rs` names it in two comments as the idiom its
//!     own `task_rows` copies, and `src-tauri/tests/fulcrum_seams.rs` spells a third
//!     local copy of the same independent-connection probe. It is the named origin of
//!     a three-file idiom, exactly as `wal_frame_count` is the named origin of one.
//!
//! `legacy_batch!` assembles a fixture from the per-table macros, and the
//! ISOLATION rule those fixtures obey is documented on
//! `each_cluster_schema_omits_exactly_one_gated_column` in [`super::open`], which
//! asserts it rather than commenting it.

use crate::storage::db::*;

use crate::types::SessionInfo;

// ─────────────────────────────────────────────────────────────────────────────
// The pre-existing-database fixture for the migration-gate cluster.
//
// The five pre-existing-database gate tests each used to open a raw
// `Connection`, hand-write a schema with ONE column missing, seed rows and drop
// the conn —
// five copies of the same skeleton. `preexisting_db` owns that skeleton; the
// `SCHEMA_WITHOUT_*` constants below are its only schema argument.
//
// ISOLATION IS THE LOAD-BEARING PROPERTY OF THESE STRINGS. Each is the full
// 5-table `CREATE` batch (sessions + stages + spaces + messages +
// native_messages) with EXACTLY ONE gate's column absent and every OTHER
// gated column present, so `Db::open`'s other gates find their column and stay
// SILENT: the test observes its own gate, not twelve gates at once. Two of the
// five fixtures were NOT isolated before this consolidation (the `archived` one
// also omitted `trusted`, both `sort_order`s, `context_usage_json`,
// `is_subagent`, `todos_json` and `cost_usd`, and carried `agent_id` — so it
// also ran the pre-rip-out purge and both seeds; the `context_usage` one was
// similar). Making them isolated is the point of the change; the gate under
// test is unchanged in every case, and each gate keeps its own dedicated test.
//
// That is also why `create_pre_sort_order_db` must NEVER serve these five: its
// schema omits BOTH `sort_order` columns at once, so handing it to (say) the
// `archived` test would run the two sort-order SEEDS inside a test that is about
// `archived` — the isolation collapse the plan forbids. It stays in use for the
// five pre-0075 fixtures that genuinely want both columns absent.
// ─────────────────────────────────────────────────────────────────────────────

/// The `spaces` table as a post-trust, post-sort_order database has it — the
/// half every cluster fixture uses EXCEPT the one whose gate owns this table.
/// (A macro rather than a `const`, because [`legacy_batch!`] concatenates
/// literals.)
macro_rules! legacy_spaces_with_sort_order {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `spaces` table WITHOUT `sort_order` (`trusted` and `board_strict`
/// present, so the trust and strict-workflow gates stay quiet) — only the space
/// sort-order gate can fire on it. `board_strict` MUST be here: a fixture that
/// dropped it too would omit TWO gated columns and run two gates.
macro_rules! legacy_spaces_without_sort_order {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `spaces` table WITHOUT `board_strict` (`trusted` and `sort_order`
/// present) — only the strict-workflow gate can fire on it.
macro_rules! legacy_spaces_without_board_strict {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `sessions` table with EVERY gated column present — the spelling every
/// fixture that is not about a `sessions` gate uses, so those gates stay quiet.
macro_rules! legacy_sessions_complete {
    () => {
        "
CREATE TABLE sessions (
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
"
    };
}

/// The `stages` table as a post-#179 database has it — BOTH new columns present,
/// so neither `stages` gate fires. EVERY cluster fixture carries this spelling
/// except the two whose gate owns this table: `Db::open` probes `stages` too
/// now, so a fixture with NO `stages` table at all would count as omitting both
/// columns and break the isolation assert on all eight fixtures at once.
macro_rules! legacy_stages_complete {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    on_enter_skill TEXT,
    next_slugs TEXT,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `on_enter_skill` (`next_slugs` present) — only the
/// Stage-Skill gate can fire on it.
macro_rules! legacy_stages_without_on_enter_skill {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    next_slugs TEXT,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `next_slugs` (`on_enter_skill` present) — only the
/// transition-graph gate can fire on it.
macro_rules! legacy_stages_without_next_slugs {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    on_enter_skill TEXT,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table as pre-#179 code wrote it — NEITHER new column. For the
/// migration tests ONLY (a cluster fixture must never use it: it omits two
/// gated columns at once, which is the isolation collapse the cluster pin
/// forbids).
macro_rules! legacy_stages_pre_task_board_config {
    () => {
        "
CREATE TABLE stages (
    space_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    on_enter TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `messages` + `native_messages` half of every fixture here — no gate in
/// this cluster touches either table. `native_messages` carries its
/// `ON DELETE CASCADE` FK, so `Db::open`'s FK-rewrite batch stays quiet on every
/// fixture below; a fixture that omitted the FK would be testing that rewrite,
/// not its own gate.
macro_rules! legacy_tail {
    () => {
        "
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message_key TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, kind, message_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE native_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq)
);
"
    };
}

/// Assemble one legacy fixture batch: the `sessions` DDL the caller spells as a
/// literal, the `spaces` spelling the caller picks, and the two tables NO gate in
/// this cluster touches.
///
/// A macro rather than a function or `const` concatenation because `&str`
/// concatenation is not a const operation and `concat!` needs LITERALS — hence
/// the `sessions` DDL arriving as a literal argument, and the two `spaces`
/// spellings plus the tail living here once each so no fixture can invent its own.
///
/// `stages` defaults to [`legacy_stages_complete!`]: `Db::open` probes `stages`
/// for two gated columns now, so a fixture that omitted the table entirely would
/// count as omitting BOTH and run two gates — the isolation collapse the cluster
/// pin below exists to catch. A fixture whose gate owns `stages` (or `spaces`)
/// picks that arm instead.
macro_rules! legacy_batch {
    ($sessions:expr, spaces_with_sort_order) => {
        concat!(
            $sessions,
            legacy_stages_complete!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    ($sessions:expr, spaces_without_sort_order) => {
        concat!(
            $sessions,
            legacy_stages_complete!(),
            legacy_spaces_without_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, stages_without_on_enter_skill) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_on_enter_skill!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, stages_without_next_slugs) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_next_slugs!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, spaces_without_board_strict) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_complete!(),
            legacy_spaces_without_board_strict!(),
            legacy_tail!()
        )
    };
}

/// The full 5-table batch with ONLY `sessions.archived` missing. Every other
/// gated column is present, so the sibling gates are no-ops on this fixture.
/// `agent_id` is absent too: the pre-rip-out purge is a DIFFERENT gate with its
/// own test (`opening_a_pre_rip_out_database_migrates_it`), and a fixture that
/// carried the column would run that purge as a side effect.
pub(super) const SCHEMA_WITHOUT_ARCHIVED: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `sessions.context_usage_json` missing.
pub(super) const SCHEMA_WITHOUT_CONTEXT_USAGE: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `sessions.cost_usd` missing — the isolation
/// the `dflt_value` pin depends on.
pub(super) const SCHEMA_WITHOUT_COST_USD: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `spaces.sort_order` missing (`sessions` is
/// complete, so the SESSION seed cannot fire — that is the isolation this
/// constant exists to provide).
pub(super) const SCHEMA_WITHOUT_SPACE_SORT_ORDER: &str = legacy_batch!(
    "
CREATE TABLE sessions (
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
",
    spaces_without_sort_order
);

/// The full 5-table batch with ONLY `sessions.sort_order` missing (`spaces` is
/// complete, so the SPACE seed cannot fire).
pub(super) const SCHEMA_WITHOUT_SESSION_SORT_ORDER: &str = legacy_batch!(
    "
CREATE TABLE sessions (
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
    title_stage INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `stages.on_enter_skill` missing (`sessions`
/// and `spaces` are complete, so no sibling gate fires — and the gate this
/// fixture isolates now backfills only the `research` Skill; the migration claim
/// lives in `the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row`).
pub(super) const SCHEMA_WITHOUT_STAGES_ON_ENTER_SKILL: &str =
    legacy_batch!(complete_sessions, stages_without_on_enter_skill);

/// The full 5-table batch with ONLY `stages.next_slugs` missing — the plain
/// single-ALTER gate (deliberately NO data step, ADR 0099: NULL = unconfigured).
pub(super) const SCHEMA_WITHOUT_STAGES_NEXT_SLUGS: &str =
    legacy_batch!(complete_sessions, stages_without_next_slugs);

/// The full 5-table batch with ONLY `spaces.board_strict` missing — the plain
/// single-ALTER gate for the Strict-workflow opt-in.
pub(super) const SCHEMA_WITHOUT_SPACES_BOARD_STRICT: &str =
    legacy_batch!(complete_sessions, spaces_without_board_strict);

/// A minimal recorded-session shape for the title tests (the title
/// itself is never part of the literal — nothing writes it through
/// `record_session`, only through `set_session_title`).
pub(super) fn title_session(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": id,
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    }
}

/// The pre-`sort_order` schema: the current `SCHEMA` with the
/// `sort_order` column absent from BOTH `sessions` and `spaces` — i.e.
/// exactly what a database written before the manual-order columns looks
/// like. `native_messages` keeps its FK so the phase-10 FK migration
/// stays quiet and the fixture exercises only the seed under test.
pub(super) fn create_pre_sort_order_db(path: &Path) {
    let conn = Connection::open(path).expect("raw open of the fixture db");
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            context_usage_json TEXT,
            is_subagent INTEGER NOT NULL DEFAULT 0,
            todos_json TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            message_key TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, kind, message_key)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        CREATE TABLE spaces (
            path TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            trusted INTEGER NOT NULL DEFAULT 0
        );",
    )
    .expect("fixture schema should build");
    drop(conn);
}

/// Create a legacy database file WITHOUT opening `Db` — raw SQLite only.
///
/// `Db::open` is the code under test here (its gates are what these tests
/// observe), so the fixture must be the raw file: this factory never opens a
/// `Db`, and the conn is dropped before returning so `Db::open` gets the file
/// to itself.
///
/// `legacy_schema` is the full 5-table `CREATE` batch with the ONE gated column
/// under test missing and every OTHER gated column present (see the
/// `SCHEMA_WITHOUT_*` constants — get this wrong and a sibling gate runs inside
/// the test); `rows` seeds the pre-existing data.
pub(super) fn preexisting_db(dir: &Path, legacy_schema: &str, rows: &str) -> std::path::PathBuf {
    let path = dir.join("t.db");
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    conn.execute_batch(&format!(
        "{legacy_schema}{rows}",
        legacy_schema = legacy_schema,
        rows = rows
    ))
    .expect("fixture schema");
    drop(conn);
    path
}

/// Reads a single TEXT column through the raw connection (the row structs
/// never select `sort_order`, so the seed assertions go straight to SQL).
pub(super) fn raw_column(db: &Db, sql: &str) -> Vec<String> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let rows = guard
        .prepare(sql)
        .expect("prepare should succeed")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query should succeed")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should read");
    rows
}

/// The same for an INTEGER column (the `sort_order` values themselves).
pub(super) fn raw_i64s(db: &Db, sql: &str) -> Vec<i64> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let rows = guard
        .prepare(sql)
        .expect("prepare should succeed")
        .query_map([], |row| row.get::<_, i64>(0))
        .expect("query should succeed")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should read");
    rows
}

/// One row's `sort_order`, keyed by a TEXT primary key (a path or an id).
pub(super) fn sort_order_of(db: &Db, table: &str, key_column: &str, key: &str) -> i64 {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            &format!(
                "SELECT sort_order FROM {table} WHERE {key_column} = ?1",
                table = table,
                key_column = key_column
            ),
            params![key],
            |row| row.get(0),
        )
        .expect("sort_order should read")
}

/// The one scalar of an INTEGER column (a `COUNT(*)`-shaped assertion).
pub(super) fn raw_scalar(db: &Db, sql: &str) -> i64 {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(sql, [], |row| row.get(0))
        .expect("scalar query should succeed")
}

/// A Space path for the board tests. The tables carry NO foreign key on
/// `space_path` (ADR 0090), so these tests need no `spaces` row at all — which
/// is itself part of what they pin.
pub(super) fn board_space(tag: &str) -> String {
    format!("/board-space/{tag}")
}

/// The board's cards as ONE flat list in column order — the shape the tests
/// below read, so each one says "the card" rather than re-spelling the find.
pub(super) fn board_cards(db: &Db, space: &str) -> Vec<TaskCardView> {
    db.get_board(space)
        .expect("get_board")
        .into_iter()
        .flat_map(|column| column.tasks)
        .collect()
}

/// Every `task_artifacts` row, read through an INDEPENDENT connection to the
/// same file (the `link_rows` precedent in `commands/tasks/tests/seed.rs`): the
/// assertions below ask what the DATABASE holds, not what a `Db` method chose to
/// report about it, so a method that wrote nothing and returned a plausible meta
/// still reddens.
pub(super) fn artifact_rows(db_path: &std::path::Path) -> Vec<(String, String, String, i64, i64)> {
    let conn = rusqlite::Connection::open(db_path).expect("an independent connection");
    let mut stmt = conn
        .prepare(
            "SELECT task_id, key, markdown, created_at, updated_at FROM task_artifacts \
             ORDER BY rowid ASC",
        )
        .expect("prepares");
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .expect("queries");
    rows.collect::<Result<_, _>>().expect("maps")
}

/// The WAL file as a COMMIT COUNTER: the number of frames it holds.
///
/// The layout is fixed by the format — a 32-byte header, then one frame per
/// dirty page, each frame a 24-byte header plus one page. A commit appends its
/// dirty-page frames and marks the LAST one a commit frame, so **N separate
/// commits must append at least N frames**, while one transaction appending the
/// same rows writes one frame per dirty page and a single commit frame. That
/// asymmetry is what makes this a real commit counter.
///
/// WHY not `PRAGMA data_version` (the obvious candidate): measured here, it is
/// a "has this database changed since I last looked" counter, NOT a commit
/// counter — 12 autocommits moved a second connection's `data_version` by **1**,
/// exactly the same as one 12-row transaction, because the observer only
/// refreshes when it next reads. It cannot tell the two apart, so a test written
/// against it PASSES against a per-row autocommit loop — vacuous. And
/// `Connection::total_changes` cannot either: measured, it does not step back on
/// a rollback, so it counts rows a transaction threw away.
///
/// WHY not `sqlite3_commit_hook`: it is the ideal instrument, but rusqlite puts
/// it behind the `hooks` feature and this crate does not enable it (`cargo tree
/// -p rusqlite` → `bundled,modern_sqlite`), so it is not compiled in.
///
/// `page_size` is read from the connection rather than hardcoded, so the
/// arithmetic survives a page-size change.
pub(super) fn wal_frame_count(db: &Db, wal: &std::path::Path) -> u64 {
    let page_size: u64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("the page_size readback");
    match std::fs::metadata(wal) {
        // A WAL shorter than one frame holds no frames (it was created by the
        // open and nothing has been committed into it yet).
        Ok(meta) if meta.len() > 32 => (meta.len() - 32) / (24 + page_size),
        _ => 0,
    }
}
