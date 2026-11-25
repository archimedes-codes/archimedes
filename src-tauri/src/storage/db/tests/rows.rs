//! Tests for `db/rows.rs`: the mapper drift guards. THE primary guard of the
//! three-piece row shape — the SELECT const, the positional mapper, and this test
//! spelling the column list a second time so a silent edit reddens.

use crate::storage::db::*;

use crate::storage::db::rows::{
    message_row_from, session_row_from, space_row_from, stage_row_from, task_row_from,
    MESSAGE_COLUMNS, MESSAGE_ROW_FIELDS, SESSION_COLUMNS, SESSION_ROW_FIELDS, SPACE_COLUMNS,
    SPACE_ROW_FIELDS, STAGE_COLUMNS, STAGE_ROW_FIELDS, TASK_COLUMNS, TASK_ROW_FIELDS,
};

use super::support::*;

// ─────────────────────────────────────────────────────────────────────────────
// The mapper drift guards (finding 12's PRIMARY guard).
//
// The hazard these exist for: a `SessionRow`/`MessageRow`/`SpaceRow` used to be
// built beside its own literal `SELECT` list, so a column added to (or moved
// in) the list without the positional ladder COMPILES and mis-maps at runtime.
// The const list + one mapper per type made the pair visible in one place;
// THESE tests are what make the pair checked.
//
// `column_count() == *_ROW_FIELDS` is asserted FIRST, before any value, so an
// APPENDED column reddens the very first assertion with a message that names
// the real problem (SELECT-vs-mapper arity) instead of failing later behind a
// chain of value mismatches. A reorder, a mid-insert or a removal breaks at
// least one of the value asserts that follow — every stored value is
// column-distinct for exactly that reason.
//
// HONEST SCOPE (see the plan's drift-proof): this test is the guard. The
// compile-time arity tie catches only a half-renumbered pair of literals, and
// the typed `get::<_, i64>` calls only turn a DDL TYPE change into a loud
// runtime conversion error. Neither sees the SELECT statement.
//
// These tests pass on their first run — no drift exists today (all three lists
// were verified byte-identical to their ladders before this change). They are
// standing guards: they go red the moment a drift is introduced.
// ─────────────────────────────────────────────────────────────────────────────

/// The PRIMARY guard for `SessionRow`: the SELECT the const builds and the
/// ladder in `session_row_from` agree in LENGTH (asserted first) and in ORDER
/// (asserted by the column-distinct values).
#[test]
fn session_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-session-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    // ONE self-identifying row: every stored value is its own column's name or
    // a distinct number. `archived` and `is_subagent` are deliberately
    // DIFFERENT (1 and 0) — two booleans both set to 1 could be swapped
    // without any value assert noticing, which would defeat the guard.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO sessions (id, cwd, created_at, title, capabilities_json,
                                   archived, context_usage_json, is_subagent, cost_usd)
             VALUES ('id', 'cwd', 2, 'title', 'cap', 1, 'ctx', 0, 9.5)",
            [],
        )
        .unwrap();
    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM sessions WHERE id = ?1",
            SESSION_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position): an appended
    // column is reported here rather than behind a chain of value mismatches.
    // HONEST LIMIT, verified by experiment: this assert alone CANNOT be the
    // guard. The statement is prepared from SESSION_COLUMNS itself, and the
    // arity tie below already forces SESSION_COLUMNS.len() ==
    // SESSION_ROW_FIELDS, so this comparison holds whenever the crate compiles.
    // The INDEPENDENT witness is the golden name list immediately after it.
    assert_eq!(
        stmt.column_count(),
        SESSION_ROW_FIELDS,
        "the SELECT built from SESSION_COLUMNS must have exactly SESSION_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         session_row_from is the drift this guard exists to catch"
    );
    // THE ACTUAL GUARD: the column list spelled a SECOND time, as a literal in
    // THIS test, derived from nothing in prod. Appending a column to
    // SESSION_COLUMNS (even together with a matching SESSION_ROW_FIELDS bump,
    // which is the one edit the arity tie cannot see) reddens THIS assert,
    // because nothing forces this literal to follow the prod const. Order is
    // pinned too, so a reorder fails here as well as in the value asserts.
    const EXPECTED_SESSION_COLUMNS: [&str; 10] = [
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
    assert_eq!(
        SESSION_COLUMNS.as_slice(),
        EXPECTED_SESSION_COLUMNS.as_slice(),
        "SESSION_COLUMNS drifted from the column list session_row_from maps: the \
         mapper reads these 10 columns in THIS order (field names in the same \
         order), so a column added to or moved in the const must be matched here \
         AND by a field in session_row_from"
    );
    // Map through the PRODUCTION mapper, on the production statement (the same
    // pairing a real read uses — `Db::session` calls `session_row_from` on this
    // exact SQL shape).
    let got = stmt
        .query_row(params!["id"], session_row_from)
        .expect("the self-identifying row maps");
    // The value asserts (in list order): a reorder / mid-insert / removal
    // breaks one of these.
    assert_eq!(got.id, "id");
    assert_eq!(got.cwd, "cwd");
    assert_eq!(got.created_at, 2);
    assert_eq!(got.title.as_deref(), Some("title"));
    assert_eq!(got.capabilities_json, "cap");
    assert!(got.archived, "column 5 (`archived`) maps to `archived`");
    assert_eq!(got.context_usage_json.as_deref(), Some("ctx"));
    assert!(
        !got.is_subagent,
        "column 7 (`is_subagent`) maps to `is_subagent` — it holds 0 while \
         `archived` holds 1, so a 5↔7 swap cannot pass both boolean asserts"
    );
    assert_eq!(got.cost_usd, Some(9.5));
}

/// The PRIMARY guard for `MessageRow` (6 columns) — same shape, same first
/// assert.
#[test]
fn message_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-message-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let conn = db.conn.lock().expect("db mutex poisoned");
    // The FK to `sessions` is live (the pragma `Db::open` sets), so the
    // transcript row needs its parent. The parent carries nothing the guard
    // reads — every asserted value lives on the message row.
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/tmp', 1, '{}')",
        [],
    )
    .unwrap();
    // One self-identifying message row: distinct value per column.
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at)
         VALUES (11, 's1', 'kind', 'key', 'payload', 12)",
        [],
    )
    .unwrap();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM messages WHERE id = ?1",
            MESSAGE_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position) — same honest
    // limit as the SessionRow guard: prepared from MESSAGE_COLUMNS and tied to
    // MESSAGE_ROW_FIELDS at compile time, this holds whenever the crate
    // compiles. The golden name list after it is the independent witness.
    assert_eq!(
        stmt.column_count(),
        MESSAGE_ROW_FIELDS,
        "the SELECT built from MESSAGE_COLUMNS must have exactly MESSAGE_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         message_row_from is the drift this guard exists to catch"
    );
    // THE ACTUAL GUARD: the list spelled a SECOND time, as a literal in THIS
    // test, derived from nothing in prod — so a coordinated append to
    // MESSAGE_COLUMNS + MESSAGE_ROW_FIELDS (the edit the arity tie cannot see)
    // reddens THIS assert. Order is pinned here as well as by the values below.
    const EXPECTED_MESSAGE_COLUMNS: [&str; 6] = [
        "id",
        "session_id",
        "kind",
        "message_key",
        "payload_json",
        "created_at",
    ];
    assert_eq!(
        MESSAGE_COLUMNS.as_slice(),
        EXPECTED_MESSAGE_COLUMNS.as_slice(),
        "MESSAGE_COLUMNS drifted from the column list message_row_from maps: the \
         mapper reads these 6 columns in THIS order (field names in the same \
         order), so a column added to or moved in the const must be matched here \
         AND by a field in message_row_from"
    );
    let got = stmt
        .query_row(params![11i64], message_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.id, 11);
    assert_eq!(got.session_id, "s1");
    assert_eq!(got.kind, "kind");
    assert_eq!(got.message_key.as_deref(), Some("key"));
    assert_eq!(got.payload_json, "payload");
    assert_eq!(got.created_at, 12);
}

/// The PRIMARY guard for `SpaceRow` (4 columns) — same shape, same first
/// assert. `trusted` is the INTEGER-as-bool column, so this also pins that the
/// mapper reads it as `i64 != 0` (the same shape `session_row_from` uses for
/// its two booleans).
#[test]
fn space_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-space-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    // No `sessions` row here on purpose: `Db::open`'s phase-11 backfill turns
    // every session cwd into a space row, and this guard wants exactly ONE
    // space — the one it inserted.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO spaces (path, created_at, last_opened_at, trusted) \
             VALUES ('path', 3, 4, 1)",
            [],
        )
        .unwrap();
    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM spaces WHERE path = ?1",
            SPACE_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position) — same honest
    // limit as the other two guards; the golden name list after it is the
    // independent witness.
    assert_eq!(
        stmt.column_count(),
        SPACE_ROW_FIELDS,
        "the SELECT built from SPACE_COLUMNS must have exactly SPACE_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         space_row_from is the drift this guard exists to catch. `sort_order` is \
         deliberately NOT one of them: SpaceRow has 4 fields by decision (see \
         SPACE_COLUMNS), so a fifth column here must fail THIS assert, not the \
         struct"
    );
    // THE ACTUAL GUARD: the list spelled a SECOND time, as a literal in THIS
    // test, derived from nothing in prod. This is also the assert that catches
    // `sort_order` being added to SPACE_COLUMNS — the decision SPACE_COLUMNS'
    // doc records would otherwise be editable in silence.
    const EXPECTED_SPACE_COLUMNS: [&str; 4] = ["path", "created_at", "last_opened_at", "trusted"];
    assert_eq!(
        SPACE_COLUMNS.as_slice(),
        EXPECTED_SPACE_COLUMNS.as_slice(),
        "SPACE_COLUMNS drifted from the column list space_row_from maps: the mapper \
         reads these 4 columns in THIS order, and `sort_order` stays OUT of the \
         projection by decision (adding it would change the Vec<SpaceRow> wire \
         type commands/spaces.rs returns)"
    );
    let got = stmt
        .query_row(params!["path"], space_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.path, "path");
    assert_eq!(got.created_at, 3);
    assert_eq!(got.last_opened_at, 4);
    assert!(
        got.trusted,
        "column 3 (`trusted`) maps to `trusted` via i64 != 0"
    );
}

/// (the mapper drift guard, `space_row_from_…`'s sibling) the SELECT const and
/// the mapper cannot drift apart, and the golden column list is spelled a
/// second time here so a silent edit of `TASK_COLUMNS` reddens.
#[test]
fn task_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let space = board_space("mapper");
    let task = db
        .create_task(&space, "mapped", None, None)
        .expect("create");

    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM tasks WHERE id = ?1",
            TASK_COLUMNS.join(", ")
        ))
        .unwrap();
    assert_eq!(
        stmt.column_count(),
        TASK_ROW_FIELDS,
        "the SELECT built from TASK_COLUMNS must have exactly TASK_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         task_row_from is the drift this guard exists to catch"
    );
    const EXPECTED_TASK_COLUMNS: [&str; 10] = [
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
    assert_eq!(
        TASK_COLUMNS.as_slice(),
        EXPECTED_TASK_COLUMNS.as_slice(),
        "TASK_COLUMNS drifted from the column list task_row_from maps"
    );
    let got = stmt
        .query_row(params![task.id], task_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.id, task.id);
    assert_eq!(got.number, task.number);
    assert_eq!(got.title, "mapped");
    assert_eq!(
        got.body, None,
        "the nullable `body` maps through get::<_, Option<String>>, not a bare get"
    );
    assert_eq!(got.spec_path, None);
    assert_eq!(got.stage_slug, "backlog");
}

/// (the mapper drift guard for `stages`) the same shape as the task one.
#[test]
fn stage_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let space = board_space("stage-mapper");
    db.get_board(&space).expect("seed");

    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM stages WHERE space_path = ?1 AND slug = ?2",
            STAGE_COLUMNS.join(", ")
        ))
        .unwrap();
    assert_eq!(
        stmt.column_count(),
        STAGE_ROW_FIELDS,
        "the SELECT built from STAGE_COLUMNS must have exactly STAGE_ROW_FIELDS columns"
    );
    const EXPECTED_STAGE_COLUMNS: [&str; 11] = [
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
    assert_eq!(
        STAGE_COLUMNS.as_slice(),
        EXPECTED_STAGE_COLUMNS.as_slice(),
        "STAGE_COLUMNS drifted from the column list stage_row_from maps"
    );
    let got = stmt
        .query_row(params![space, "doing"], stage_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.slug, "doing");
    assert_eq!(got.label, "Doing");
    assert_eq!(
        got.sort_order, 3,
        "`doing` sits at index 3 on the five-stage seed (ADR 0107 dropped the \
         seeded `discuss` row that used to push it down one)"
    );
    assert_eq!(got.on_enter, "none");
    assert_eq!(
        got.on_enter_skill, None,
        "`doing` launches nothing — and the mapper must read index 5, not skip it"
    );
    assert_eq!(
        got.next_slugs, None,
        "index 6 maps to the lenient JSON read, NULL on a seeded row"
    );
    let research = stmt
        .query_row(params![space, "research"], stage_row_from)
        .expect("the research row maps too");
    assert_eq!(
        research.on_enter_skill.as_deref(),
        Some("research"),
        "the two new fields map for a row that actually CARRIES a value — a mapper \
         that read index 5 as `None` for every row would pass the NULL case above"
    );
    // The two workflow columns, index 7 and 8. Both are asserted on a SEEDED row,
    // where they hold the DDL's answers: `auto` is the `NOT NULL DEFAULT 0` and
    // `prompt_prefix` is NULL. A mapper that swapped the two indices cannot
    // survive this: index 7 read as `Option<String>` on an INTEGER cell is a
    // type error rusqlite reports, and index 8 read as `i64` on a NULL cell is
    // the same.
    assert!(
        !got.auto,
        "index 7 maps to the `auto` flag, and a seeded column is OFF — a fresh \
         board must not auto-advance anything"
    );
    assert_eq!(
        got.prompt_prefix, None,
        "index 8 maps to `prompt_prefix`, NULL on a seeded row — NULL is \
         \"no extra prompt\", not the empty string"
    );
    assert!(
        !research.auto,
        "the launch column starts OFF too — the flag is per-column user data, \
         never derived from the column carrying a Skill"
    );
    assert_eq!(research.prompt_prefix, None, "and no column ships a prefix");
}

/// (the mapper drift guard for the two canvas coordinates) indices 9 and 10 map
/// to `position_x` and `position_y`, on a row that ACTUALLY CARRIES both.
///
/// The sibling guard above can only assert the seeded row, where both are NULL —
/// and a mapper that read index 9 as `None` for every row, or swapped the two,
/// passes a NULL-only assertion. So this test WRITES a pair with distinct values
/// and reads it back through `stage_row_from` on a fresh statement. The swap case
/// is the one worth naming: `(-40.5, 0.0)` is deliberately asymmetric, so
/// swapped indices produce a wrong answer rather than an identical one.
#[test]
fn stage_row_from_maps_the_two_position_columns_on_a_row_that_carries_them() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-pos-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let space = board_space("pos-mapper");
    db.get_board(&space).expect("seed");
    db.set_stage_position(&space, "doing", Some((-40.5, 0.0)))
        .expect("hand-arrange one column");

    let mapped = {
        let conn = db.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM stages WHERE space_path = ?1 AND slug = ?2",
                STAGE_COLUMNS.join(", ")
            ))
            .unwrap();
        stmt.query_row(params![space, "doing"], stage_row_from)
            .expect("the row maps")
    };

    assert_eq!(
        mapped.position_x,
        Some(-40.5),
        "index 9 is `position_x` — a swapped ladder would put the Y here"
    );
    assert_eq!(
        mapped.position_y,
        Some(0.0),
        "index 10 is `position_y`, and `0.0` survives as a STORED coordinate \
         rather than collapsing into `None` — the two are different answers"
    );
    assert_eq!(
        mapped.slug, "doing",
        "and the appended rungs did not shift the rungs before them"
    );
}
