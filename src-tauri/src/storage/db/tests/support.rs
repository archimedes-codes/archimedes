//! Shared fixtures for the `db` mirror test tree (ADR 0113's one non-mirror
//! child). The rule this file obeys: an item lives here because MORE THAN ONE
//! subject child reads it; a fixture with a single caller belongs in that child.
//! THE RULE COUNTS CONSUMERS, NOT CALL SITES — that distinction is what settles
//! the only contested case below.
//!
//! Three families live here:
//!
//!   * the raw-SQL probes (`raw_column`, `raw_i64s`, `raw_scalar`, `sort_order_of`,
//!     `artifact_rows`, `wal_frame_count`) — a `Db` owns ONE private `Connection`,
//!     so a test that must read the file underneath it opens its own
//!     `rusqlite::Connection` through these;
//!   * the legacy-schema fixtures (`legacy_*` macros, the `SCHEMA_WITHOUT_*`
//!     consts, `preexisting_db`, `create_pre_sort_order_db`) that build a
//!     pre-migration database file WITHOUT opening `Db`, because `Db::open` is the
//!     code under test;
//!   * the open-a-database fixture `seeded`, which the two workflow children share
//!     (`auto_guards` and `workflow_runs` are 19 call sites between them) — so it
//!     obeys this file's own rule and is here for having TWO consumer children, not
//!     for the number of call sites.
//!
//! Six fixtures the split's plan listed as shared turned out to have exactly ONE
//! calling child, so they live in that child instead of here: `session_on` in
//! `tests/sessions.rs`, `record_linkable_session` in `tests/board.rs`, `task_rows`
//! in `tests/tasks.rs`, and `has_column` / `stage_order` /
//! `pre_task_board_rows` / `SCHEMA_PRE_TASK_BOARD_CONFIG` in
//! `tests/stage_lifecycle.rs` (that child was `tests/stages.rs` until the subject
//! split named in `tests/mod.rs`'s header).
//!
//! THREE groups of single-reader items stay here anyway, for two different reasons,
//! and both reasons are the rule's own wording rather than an exception to it:
//!
//!   * NINE of the seventeen `SCHEMA_WITHOUT_*` consts (`…_ARCHIVED`,
//!     `…_CONTEXT_USAGE`, `…_COST_USD`, `…_PARENT_SESSION_ID`,
//!     `…_STAGES_ON_ENTER_SKILL`,
//!     `…_STAGES_NEXT_SLUGS`, `…_SPACES_BOARD_STRICT`,
//!     `…_STAGES_POSITION_X`, `…_STAGES_POSITION_Y`) are read ONLY by
//!     `tests/open.rs`, and they stay.
//!     That child consumes them as a COMPLETE SET —
//!     `each_cluster_schema_omits_exactly_one_gated_column` walks all seventeen by name
//!     and asserts each omits exactly one gated column, so the property lives in the
//!     SET and not in any one string. One consumer of a set is still the reason the
//!     set exists: the rule counts CONSUMERS, not call sites, and scattering the
//!     names into their individual children would split a pin that is only assertable
//!     over all of them. (The other EIGHT have a genuine second reader and need no
//!     defence: `…_SPACE_SORT_ORDER` and `…_SESSION_SORT_ORDER` are read by
//!     `tests/migrations.rs`, `…_STAGES_AUTO` and `…_STAGES_PROMPT_PREFIX` by
//!     `tests/stage_lifecycle.rs`, `…_SPACES_AUTO_MAX_STEPS` and
//!     `…_SPACES_AUTO_CEILING_USD` by `tests/auto_guards.rs`,
//!     `…_IS_SUBAGENT` by `tests/migrations.rs`, and
//!     `…_READY` — the newest, added with its gate's own pin — by
//!     `tests/migrations.rs`.)
//!
//! The census above is RE-DERIVED, not inherited, by the commit that added the two
//! position fixtures: `grep -rl 'SCHEMA_WITHOUT_<NAME>\b' src-tauri/src/ | grep -v
//! support.rs` per const, which is the only instrument that answers the question
//! the rule asks (CONSUMERS, and a prose census rots the moment a fixture gains a
//! second reader). Re-run it before editing the list — this paragraph's own figures
//! are a measurement of one commit, and the file's rule is that the set, not the
//! count, is the thing that lives here.
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
// SILENT: the test observes its own gate, not twenty gates at once. Two of the
// five fixtures were NOT isolated before this consolidation (the `archived` one
// also omitted `trusted`, both `sort_order`s, `context_usage_json`,
// `is_subagent`, `todos_json` and `cost_usd`, and carried `agent_id` — so it
// also ran the pre-rip-out purge and both seeds; the `context_usage` one was
// similar). Making them isolated is the point of the change; the gate under
// test is unchanged in every case, and each gate keeps its own dedicated test.
//
// That is also why `create_pre_sort_order_db` must NEVER serve a cluster fixture:
// its schema omits BOTH `sort_order` columns at once, so handing it to (say) the
// `archived` test would run the two sort-order SEEDS inside a test that is about
// `archived` — the isolation collapse the plan forbids. It stays in use for the
// pre-0075 fixtures that genuinely want BOTH columns absent (call it with
// `grep -rn 'create_pre_sort_order_db' src-tauri/src/ | grep -v support.rs` — three
// callers at the commit this line was last checked; no count is quoted below it
// because this one has rotted before).
// ─────────────────────────────────────────────────────────────────────────────

/// The `spaces` table as a post-trust, post-sort_order, post-workflow-guards
/// database has it — the half every cluster fixture uses EXCEPT the one whose
/// gate owns this table. (A macro rather than a `const`, because
/// [`legacy_batch!`] concatenates literals.)
///
/// BOTH auto-guard columns are here, and that is not decoration: `Db::open` now
/// probes `spaces` for FIVE gated columns (`trusted`, `sort_order`,
/// `board_strict`, `auto_max_steps`, `auto_ceiling_usd`), so a fixture that
/// carried neither guard would count as omitting TWO and run two gates — the
/// isolation collapse [`super::open`]'s pin exists to catch. Every `spaces`
/// spelling in this file therefore carries all five except the one its own gate
/// owns. (The count was FOUR here when the two guards were the newest pair and
/// `board_strict` had not yet been counted; re-derive it from the `GATED` array in
/// `tests/open.rs` rather than trusting this sentence.)
macro_rules! legacy_spaces_with_sort_order {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0,
    auto_max_steps INTEGER,
    auto_ceiling_usd REAL
);
"
    };
}

/// The `spaces` table WITHOUT `sort_order` (`trusted`, `board_strict` and BOTH
/// auto-guard columns present, so those gates stay quiet) — only the space
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
    board_strict INTEGER NOT NULL DEFAULT 0,
    auto_max_steps INTEGER,
    auto_ceiling_usd REAL
);
"
    };
}

/// The `spaces` table WITHOUT `board_strict` (`trusted`, `sort_order` and BOTH
/// auto-guard columns present) — only the strict-workflow gate can fire on it.
macro_rules! legacy_spaces_without_board_strict {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    auto_max_steps INTEGER,
    auto_ceiling_usd REAL
);
"
    };
}

/// The `spaces` table WITHOUT `auto_max_steps` (every OTHER `spaces` column
/// present, including the ceiling) — only the step-bound gate can fire on it.
///
/// Neither auto-guard column carries a `DEFAULT`, so this spelling and the
/// complete one differ by a COLUMN and nothing else; the gate under test is the
/// only thing `Db::open` can find missing.
macro_rules! legacy_spaces_without_auto_max_steps {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0,
    auto_ceiling_usd REAL
);
"
    };
}

/// The `spaces` table WITHOUT `auto_ceiling_usd` (every OTHER `spaces` column
/// present, including the step bound) — only the cost-ceiling gate can fire on
/// it.
macro_rules! legacy_spaces_without_auto_ceiling_usd {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    board_strict INTEGER NOT NULL DEFAULT 0,
    auto_max_steps INTEGER
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    ready INTEGER
);
"
    };
}

/// The `stages` table as a post-#179, post-workflow-columns, post-canvas database
/// has it — ALL SIX gated columns present, so no `stages` gate fires. EVERY
/// cluster fixture carries this spelling except the six whose gate owns this
/// table: `Db::open` probes `stages` too now, so a fixture with NO `stages` table
/// at all would count as omitting all six columns and break the isolation assert
/// on every fixture at once.
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
    auto INTEGER NOT NULL DEFAULT 0,
    prompt_prefix TEXT,
    position_x REAL,
    position_y REAL,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `position_x` (`position_y` and every OTHER `stages`
/// column present) — only the hand-arranged X gate can fire on it.
///
/// A real upgraded database can never hold this shape — the two columns arrive in
/// the same release, so a live file has both or neither — and that is exactly why
/// the fixture is honest rather than a fiction: the isolation rule is about which
/// GATE `Db::open` can find missing, and a fixture carrying both columns exercises
/// NEITHER gate while a fixture carrying neither exercises BOTH. Omitting one is
/// the only way to make this test observe its own gate. The pair's
/// arrive-together-and-never-half rule is a WRITE rule, owned by
/// `Db::set_stage_position`, and it is pinned there.
macro_rules! legacy_stages_without_position_x {
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
    auto INTEGER NOT NULL DEFAULT 0,
    prompt_prefix TEXT,
    position_y REAL,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `position_y` (`position_x` and every OTHER `stages`
/// column present) — only the hand-arranged Y gate can fire on it. The mirror of
/// [`legacy_stages_without_position_x!`], including its reason for existing.
macro_rules! legacy_stages_without_position_y {
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
    auto INTEGER NOT NULL DEFAULT 0,
    prompt_prefix TEXT,
    position_x REAL,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `auto` (every OTHER `stages` column present,
/// including BOTH position columns) — only the auto-advance-flag gate can fire on
/// it.
macro_rules! legacy_stages_without_auto {
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
    prompt_prefix TEXT,
    position_x REAL,
    position_y REAL,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `prompt_prefix` (every OTHER `stages` column
/// present) — only the prompt-prefix gate can fire on it.
macro_rules! legacy_stages_without_prompt_prefix {
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
    auto INTEGER NOT NULL DEFAULT 0,
    position_x REAL,
    position_y REAL,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `on_enter_skill` (`next_slugs` and BOTH workflow
/// columns present) — only the Stage-Skill gate can fire on it.
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
    auto INTEGER NOT NULL DEFAULT 0,
    prompt_prefix TEXT,
    position_x REAL,
    position_y REAL,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table WITHOUT `next_slugs` (`on_enter_skill` and BOTH workflow
/// columns present) — only the transition-graph gate can fire on it.
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
    auto INTEGER NOT NULL DEFAULT 0,
    prompt_prefix TEXT,
    position_x REAL,
    position_y REAL,
    PRIMARY KEY (space_path, slug)
);
"
    };
}

/// The `stages` table as pre-#179 code wrote it — NONE of the six gated columns.
/// For the migration tests ONLY (a cluster fixture must never use it: it omits SIX
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
/// for SIX gated columns now (`on_enter_skill`, `next_slugs`, `auto`,
/// `prompt_prefix`, `position_x`, `position_y`), so a fixture that omitted the
/// table entirely would count as omitting ALL SIX and run six gates — the
/// isolation collapse the cluster pin below exists to catch. A fixture whose gate
/// owns `stages` (or `spaces`) picks that arm instead.
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
    (complete_sessions, stages_without_auto) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_auto!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, stages_without_prompt_prefix) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_prompt_prefix!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, stages_without_position_x) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_position_x!(),
            legacy_spaces_with_sort_order!(),
            legacy_tail!()
        )
    };
    (complete_sessions, stages_without_position_y) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_without_position_y!(),
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
    (complete_sessions, spaces_without_auto_max_steps) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_complete!(),
            legacy_spaces_without_auto_max_steps!(),
            legacy_tail!()
        )
    };
    (complete_sessions, spaces_without_auto_ceiling_usd) => {
        concat!(
            legacy_sessions_complete!(),
            legacy_stages_complete!(),
            legacy_spaces_without_auto_ceiling_usd!(),
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    ready INTEGER
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    ready INTEGER
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `sessions.is_subagent` missing.
///
/// Arrived with the `is_subagent` gate's first dedicated pin
/// (`the_is_subagent_gate_arrives_zero_for_every_pre_existing_session` in
/// [`super::migrations`]). Measured before it was written: no test anywhere
/// asserted anything about this gate's OUTCOME — the column was merely absent
/// from several other fixtures' `CREATE TABLE sessions`, so the `ALTER` ran as an
/// unasserted side effect of someone else's test. That is the hole
/// `each_cluster_schema_omits_exactly_one_gated_column`'s header now records per
/// column, and this fixture is the one of the four it names that was genuinely
/// uncovered.
///
/// `DEFAULT 0` is the load-bearing half and it is ADR 0025 §6's "no data
/// migration": a pre-existing row IS a main session, so the flag arrives `false`
/// and no row is rewritten. A column that arrived `1` would hide every existing
/// session from `list_sessions`'s `is_subagent = 0` filter on the next launch —
/// the whole session list vanishing because a person upgraded.
pub(super) const SCHEMA_WITHOUT_IS_SUBAGENT: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    context_usage_json TEXT,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    ready INTEGER
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    ready INTEGER
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `sessions.parent_session_id` missing — the
/// isolation the `dflt_value` pin depends on (a pre-existing row has NO known
/// parent, so the column must arrive DEFAULT-less; see the gate in `db/mod.rs`).
pub(super) const SCHEMA_WITHOUT_PARENT_SESSION_ID: &str = legacy_batch!(
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    -- `ready` IS here: this fixture's ONE omission is `parent_session_id`, and a
    -- fixture that dropped `ready` too would run two gates inside a test about the
    -- parent link (the isolation collapse the cluster pin catches).
    ready INTEGER
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    ready INTEGER
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    ready INTEGER
);
",
    spaces_with_sort_order
);

/// The full 5-table batch with ONLY `sessions.ready` missing — the isolation the
/// `dflt_value` pin depends on (a pre-existing row NEVER CLAIMED to be done, so the
/// column must arrive DEFAULT-less; see the `ready` gate in `db/mod.rs`).
///
/// The backfill's own source column, `todos_json`, IS present: the gate's data step
/// reads it, and a fixture without it would exercise a column the gate never
/// touches rather than the marker conversion the gate performs.
pub(super) const SCHEMA_WITHOUT_READY: &str = legacy_batch!(
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
    title_stage INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT
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

/// The full 5-table batch with ONLY `stages.auto` missing — the plain
/// single-ALTER gate for the per-column auto-advance flag. The `DEFAULT 0` rides
/// the `ALTER` itself, so an existing column arrives OFF: upgrading cannot make a
/// board advance a card on its own that never did before.
pub(super) const SCHEMA_WITHOUT_STAGES_AUTO: &str =
    legacy_batch!(complete_sessions, stages_without_auto);

/// The full 5-table batch with ONLY `stages.prompt_prefix` missing — the plain
/// single-ALTER gate for the per-column extra prompt. NO `DEFAULT` and NO
/// backfill: NULL means "no extra prompt", and there is no honest string to
/// invent for a column that never existed.
pub(super) const SCHEMA_WITHOUT_STAGES_PROMPT_PREFIX: &str =
    legacy_batch!(complete_sessions, stages_without_prompt_prefix);

/// The full 5-table batch with ONLY `stages.position_x` missing — the plain
/// single-ALTER gate for the hand-arranged X. NO `DEFAULT` and NO backfill: NULL
/// means "never hand-positioned, the canvas lays this node out", and a
/// `DEFAULT 0` would migrate every existing column to "hand-placed at the origin"
/// — every node in every existing database stacked at (0, 0) on the first canvas
/// open (the same NULL ≠ 0 collapse `spaces.auto_max_steps` and
/// `sessions.cost_usd` each document).
pub(super) const SCHEMA_WITHOUT_STAGES_POSITION_X: &str =
    legacy_batch!(complete_sessions, stages_without_position_x);

/// The full 5-table batch with ONLY `stages.position_y` missing — the mirror gate
/// for the hand-arranged Y, and the same no-`DEFAULT` argument: `NULL` is
/// "not hand-placed", `0.0` is "hand-placed, and the answer is the top edge".
pub(super) const SCHEMA_WITHOUT_STAGES_POSITION_Y: &str =
    legacy_batch!(complete_sessions, stages_without_position_y);

/// The full 5-table batch with ONLY `spaces.board_strict` missing — the plain
/// single-ALTER gate for the Strict-workflow opt-in.
pub(super) const SCHEMA_WITHOUT_SPACES_BOARD_STRICT: &str =
    legacy_batch!(complete_sessions, spaces_without_board_strict);

/// The full 5-table batch with ONLY `spaces.auto_max_steps` missing — the plain
/// single-ALTER gate for the per-Space auto-chain STEP bound. NO `DEFAULT` and NO
/// backfill: NULL means "not configured, the shipped default governs", and a
/// `DEFAULT 0` would migrate every existing Space to "auto-chaining is switched
/// off" — a configured value nobody configured (ADR 0082's NULL ≠ 0 discipline).
pub(super) const SCHEMA_WITHOUT_SPACES_AUTO_MAX_STEPS: &str =
    legacy_batch!(complete_sessions, spaces_without_auto_max_steps);

/// The full 5-table batch with ONLY `spaces.auto_ceiling_usd` missing — the plain
/// single-ALTER gate for the per-Space auto-chain COST ceiling. Same no-`DEFAULT`
/// argument as its sibling above: `NULL` is "not configured", `0.0` is
/// "configured, and the answer is no spend".
pub(super) const SCHEMA_WITHOUT_SPACES_AUTO_CEILING_USD: &str =
    legacy_batch!(complete_sessions, spaces_without_auto_ceiling_usd);

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

/// A fresh `Db` in its own scratch dir, with ONE Space path seeded — the fixture
/// the workflow children open with, measured at 22 of their 31 tests spelling the
/// same three lines (`ScratchDir::in_env_temp` + `Db::open(&dir.join("t.db"))` +
/// `board_space`) and 12 of those adding an `upsert_space`.
///
/// THE RETURNED `ScratchDir` IS THE FIRST FIELD ON PURPOSE. It has a `Drop` that
/// removes the directory, so a fixture that returned only the `Db` would leak the
/// dir and trip `scripts/check-temp-dir-census.sh` — the lock on #96. A caller
/// binds it as `_dir` when nothing in the test reads a path from it, and the binding
/// still lives to the end of the test body, so the cleanup still happens.
///
/// `tag` does DOUBLE DUTY, and that is the de-duplication: it becomes BOTH the
/// scratch prefix (`db-{tag}-`) and the [`board_space`] path, which is what removes
/// the second line. It is therefore the value that already appears in the assertions
/// that interpolate the Space path into raw SQL, so a test that moves through this
/// helper asserts about the same path it always did.
///
/// `upsert_space` is deliberately NOT folded in even though 14 of those tests call
/// it: the OTHER half of the workflow tests pin the no-`spaces`-row answer, and a
/// fixture that always inserted a row would make the rowless case something a test
/// had to opt OUT of — the one shape that turns a pin into a silent no-op. So the
/// 14 write the one line themselves and it stays visible in the test that depends
/// on it.
pub(super) fn seeded(tag: &str) -> (crate::test_support::ScratchDir, Db, String) {
    let dir = crate::test_support::ScratchDir::in_env_temp(&format!("db-{tag}-"), "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space(tag);
    (dir, db, space)
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

/// The OPEN `workflow_runs` row for one Task, read through raw SQL.
///
/// WHY THIS EXISTS IN THE TEST TREE AT ALL. `Db::workflow_run_open` used to be
/// this question, and it was deleted as dead IPC: the auto-advance runtime asks no
/// "is this card mid-chain" question, because `workflow_run_step` IS the upsert —
/// opening a chain when none is open is what the step verb does. The tests still
/// need to ask it, because "is the row open?" is exactly what several of them pin
/// (a close closes, a step opens, a scoped step does not touch a neighbour). So the
/// question is asked here, through the same raw-SQL route the other read-back
/// helpers in this file use (`raw_column`, `raw_scalar`, `artifact_rows`): the
/// assertions ask what the DATABASE holds, and a helper that reads the projection
/// positionally keeps the shape the deleted verb read.
///
/// Returns `(id, steps, cost_usd)` for the open row, or `None` when the Task has
/// none. `finished_at IS NULL` is the whole predicate — the same one the UNIQUE
/// partial index `idx_workflow_runs_open` enforces, so more than one match would be
/// the schema failing and not this helper papering over it.
///
/// `QueryReturnedNoRows` is matched EXPLICITLY and any other error PANICS rather
/// than becoming `None` — the deleted verb's own reasoning, kept: several callers
/// below assert `open_run_row(..).is_none()` to mean "the close closed it", and a
/// helper that turned a broken projection into `None` would answer that assertion
/// `true` for the wrong reason.
pub(super) fn open_run_row(db: &Db, task_id: &str) -> Option<(String, i64, Option<f64>)> {
    match db.conn.lock().expect("db mutex poisoned").query_row(
        "SELECT id, steps, cost_usd FROM workflow_runs \
         WHERE task_id = ?1 AND finished_at IS NULL",
        rusqlite::params![task_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<f64>>(2)?,
            ))
        },
    ) {
        Ok(row) => Some(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => panic!("reading the open run for `{task_id}`: {e}"),
    }
}
