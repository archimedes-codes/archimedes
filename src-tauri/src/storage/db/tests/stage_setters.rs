//! Tests for the **setter** half of `db/stages.rs`: the five `set_stage_*`
//! verbs that write one value onto a column that already exists —
//! `set_stage_skill`, `set_stage_next`, `set_stage_auto`,
//! `set_stage_prompt_prefix`, `set_stage_position` — each pinned on the write
//! itself, on the read-back through the SAME row mapper the board read uses, and
//! on the refusal that lands BEFORE the write (ADRs 0098 + 0099; the two
//! `position_*` columns come from the canvas-editor work).
//!
//! THE SPLIT, AND WHY IT IS HERE. `db/tests/stages.rs` reached 985 code lines
//! against ADR 0112's 1,000-line test gate with 24 tests, so one more test
//! anywhere in it reddened CI. It was split on the subject boundary the code
//! already had: THIS child owns the per-column VALUES (the five setters, their
//! NULL-vs-value discipline and their `MissingStage` refusals) and
//! [`super::stage_lifecycle`] owns the column's EXISTENCE and POSITION (the seed,
//! the migration that delivers the columns, and `create`/`rename`/`reorder`/
//! `delete`). Production stayed ONE file (`db/stages.rs`), and ADR 0113 names
//! that case in as many words — "Where production is **one** file, the test
//! children are named by subject and there is nothing to mirror file-for-file" —
//! with `commands/tasks/tests/` as the in-repo precedent (one production file,
//! four subject-named children).
//!
//! WHY THE SETTERS ARE A SUBJECT AND NOT JUST THE OTHER HALF OF A LINE COUNT:
//! every test here makes the SAME three-part claim about a column — the reply
//! carries what was written, a later `get_board`/`list_stages` agrees with it,
//! and a refusal writes NOTHING. That is why the NULL-vs-`""` and
//! NULL-vs-`[]` distinctions live together here (`set_stage_prompt_prefix` and
//! `set_stage_next` argue the same rule about two different types), and why the
//! two `position_*` tests sit with the setters rather than with the
//! `position_*` GATES, which are in [`super::stage_lifecycle`] beside the rest
//! of the `Db::open` schema cluster.
//!
//! WHY THIS CHILD CARRIES NO `expect("db mutex poisoned")` SITE (AGENTS.md's
//! poisoned-mutex rule). Nothing here reaches past `Db` at all: every assertion
//! goes through a `Db` verb or a `support` probe, and `support`'s probes own
//! their own `conn.lock()` and their own panic rationale. So there is no site to
//! justify — which is a fact about this file, not an exemption from the rule.
//! A test added here that reads `dflt_value` or `pragma_table_info` directly
//! WILL add such a site, and per AGENTS.md it must carry a one-line reason for
//! why the resource it guards is single and shared — `Db` holds ONE
//! `rusqlite::Connection`, so the panic spelling is the correct one and the
//! worked example to cite is the production `record_messages_batch`
//! (`docs/agents/census.md` keeps the instrument for the site count).

use crate::storage::db::*;

use super::support::*;

/// (ADR 0098) `set_stage_skill` sets the Skill and CLEARS it back to NULL.
#[test]
fn set_stage_skill_sets_and_clears_the_skill() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-skill-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("skill");
    db.get_board(&space).expect("seed");

    let set = db
        .set_stage_skill(&space, "approved", Some("review"))
        .expect("set");
    assert_eq!(set.on_enter_skill.as_deref(), Some("review"));

    let cleared = db
        .set_stage_skill(&space, "approved", None)
        .expect("clear to NULL");
    assert_eq!(
        cleared.on_enter_skill, None,
        "`None` clears the column rather than writing an empty string"
    );

    let err = db
        .set_stage_skill(&space, "ghost", Some("x"))
        .expect_err("a missing stage is refused BEFORE the write");
    assert!(
        matches!(err, BoardError::MissingStage { .. }),
        "got {err:?}"
    );
}

/// (the per-column auto-advance flag) `set_stage_auto` writes the flag and reads
/// it back through the SAME mapper the board read uses, in both directions —
/// ON and back OFF. There is no "clear to NULL" here and that is deliberate: the
/// column is `NOT NULL DEFAULT 0`, so the flag has exactly two states and `false`
/// is the off state (unlike `on_enter_skill`, whose absence IS a state).
#[test]
fn set_stage_auto_turns_the_flag_on_and_off_and_the_board_read_agrees() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-auto-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("auto");
    db.get_board(&space).expect("seed");

    let on = db
        .set_stage_auto(&space, "doing", true)
        .expect("set auto = true");
    assert!(on.auto, "the reply carries the value it just wrote");
    assert_eq!(
        raw_i64s(
            &db,
            &format!("SELECT auto FROM stages WHERE space_path = '{space}' AND slug = 'doing'")
        ),
        vec![1],
        "at rest it is the INTEGER 1 — `auto` is a plain column, not JSON"
    );
    assert!(
        db.get_board(&space)
            .expect("get_board")
            .iter()
            .find(|c| c.stage.slug == "doing")
            .expect("the doing column")
            .stage
            .auto,
        "the board read reports the same flag the verb returned"
    );

    let off = db
        .set_stage_auto(&space, "doing", false)
        .expect("set auto = false");
    assert!(!off.auto, "and the flag is turnable back off");
    assert_eq!(
        raw_i64s(
            &db,
            &format!("SELECT auto FROM stages WHERE space_path = '{space}' AND slug = 'doing'")
        ),
        vec![0],
        "at rest it is the INTEGER 0"
    );

    // The flag is per-COLUMN: turning one on leaves its neighbours alone.
    db.set_stage_auto(&space, "done", true).expect("set done");
    assert!(
        !db.set_stage_auto(&space, "backlog", false)
            .expect("set backlog")
            .auto,
        "backlog stays off"
    );
    assert_eq!(
        raw_i64s(
            &db,
            &format!("SELECT COUNT(*) FROM stages WHERE space_path = '{space}' AND auto = 1")
        ),
        vec![1],
        "exactly ONE column carries the flag — a bulk write would make this 5"
    );

    let err = db
        .set_stage_auto(&space, "ghost", true)
        .expect_err("a missing stage is refused BEFORE the write");
    assert!(
        matches!(err, BoardError::MissingStage { .. }),
        "got {err:?}"
    );
}

/// (the per-column extra prompt) `set_stage_prompt_prefix` sets it and — the
/// half that matters — CLEARS it back to NULL. The parameter is an `Option` for
/// exactly this reason, following `set_stage_skill`; `set_stage_next` takes a
/// plain slice and so a configured graph can never be un-configured, which is a
/// recorded known gap this verb refuses to repeat.
#[test]
fn set_stage_prompt_prefix_sets_and_clears_the_prefix() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-prefix-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("prefix");
    db.get_board(&space).expect("seed");

    let set = db
        .set_stage_prompt_prefix(&space, "research", Some("Start by re-reading the card. "))
        .expect("set");
    assert_eq!(
        set.prompt_prefix.as_deref(),
        Some("Start by re-reading the card. "),
        "the reply carries the text it just wrote, verbatim — leading and trailing \
         whitespace included, this layer does not trim"
    );

    let cleared = db
        .set_stage_prompt_prefix(&space, "research", None)
        .expect("clear to NULL");
    assert_eq!(
        cleared.prompt_prefix, None,
        "`None` clears the column rather than writing an empty string — NULL is \
         the ONLY \"no extra prompt\" state"
    );
    let raw = raw_column(
        &db,
        &format!(
            "SELECT COALESCE(prompt_prefix,'NULL') FROM stages \
             WHERE space_path = '{space}' AND slug = 'research'"
        ),
    );
    assert_eq!(
        raw.first().map(|s| s.as_str()),
        Some("NULL"),
        "at rest it is NULL, not '' — otherwise a clear and a set-to-empty would \
         be indistinguishable states the launch path had to guess between"
    );

    // An empty string is a VALUE, not a clear: it round-trips as `Some("")`.
    let empty = db
        .set_stage_prompt_prefix(&space, "research", Some(""))
        .expect("an empty prefix is a legal write");
    assert_eq!(
        empty.prompt_prefix.as_deref(),
        Some(""),
        "`Some(\"\")` is stored, so `None` stays the only spelling of \"cleared\""
    );

    let err = db
        .set_stage_prompt_prefix(&space, "ghost", Some("x"))
        .expect_err("a missing stage is refused BEFORE the write");
    match err {
        BoardError::MissingStage { wanted, available } => {
            assert_eq!(wanted, "ghost");
            assert!(
                available.contains("research"),
                "the refusal names the valid slugs (ADR 0090), got `{available}`"
            );
        }
        other => panic!("expected MissingStage, got {other:?}"),
    }
    assert_eq!(
        db.list_stages(&space)
            .expect("list_stages")
            .iter()
            .find(|s| s.slug == "research")
            .expect("the research row")
            .prompt_prefix
            .as_deref(),
        Some(""),
        "the refusal on the ghost slug touched no other row"
    );
}

/// (ADR 0099) the edges round-trip: JSON at rest, `Vec<String>` back out.
#[test]
fn set_stage_next_persists_the_edges_and_round_trips_them() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-next-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("next");
    db.get_board(&space).expect("seed");

    let wanted = vec!["research".to_string(), "approved".to_string()];
    let set = db
        .set_stage_next(&space, "backlog", &wanted)
        .expect("set_stage_next");
    assert_eq!(
        set.next_slugs,
        Some(wanted.clone()),
        "button-render order is preserved, not sorted"
    );

    let raw = raw_column(
        &db,
        &format!("SELECT next_slugs FROM stages WHERE space_path = '{space}' AND slug = 'backlog'"),
    );
    assert_eq!(
        raw.first().map(|s| s.as_str()),
        Some(r#"["research","approved"]"#),
        "JSON-at-rest, following the `sessions.todos_json` precedent"
    );
    let read_back = db.get_board(&space).expect("get_board");
    assert_eq!(
        read_back[0].stage.next_slugs,
        Some(wanted),
        "and the board read parses it back"
    );
}

/// (spec §4) an unknown destination is a REJECTION naming the valid slugs, not a
/// silent drop — a dropped destination is a workflow that shrank.
#[test]
fn set_stage_next_refuses_an_unknown_slug_naming_the_valid_ones() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-next-404-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("next-404");
    db.get_board(&space).expect("seed");

    let wanted = vec!["done".to_string(), "sprint-review".to_string()];
    let err = db
        .set_stage_next(&space, "backlog", &wanted)
        .expect_err("an unknown destination is refused, not filtered");
    match err {
        BoardError::MissingStage { wanted, available } => {
            assert_eq!(wanted, "sprint-review");
            assert!(
                available.contains("research"),
                "the refusal names the valid slugs, got `{available}`"
            );
        }
        other => panic!("expected MissingStage, got {other:?}"),
    }
    assert_eq!(
        db.get_board(&space).expect("get_board")[0].stage.next_slugs,
        None,
        "the refusal wrote nothing at all — not even the valid half"
    );
}

/// (spec §4) a self-loop is a button that moves a card to the column it is
/// already in.
#[test]
fn set_stage_next_refuses_a_self_loop() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-loop-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("loop");
    db.get_board(&space).expect("seed");

    let err = db
        .set_stage_next(&space, "doing", &["doing".to_string()])
        .expect_err("a stage cannot lead to itself");
    assert!(
        matches!(&err, BoardError::SelfLoop { slug } if slug == "doing"),
        "got {err:?}"
    );
}

/// (ADR 0099's NULL-vs-empty distinction) `[]` is a CONFIGURED "no edges"
/// answer and must round-trip as `Some(vec![])`, while NULL stays the
/// unconfigured answer. Collapsing the two is the silent-green shape ADR 0099
/// rejects by name.
#[test]
fn set_stage_next_an_empty_slice_persists_explicit_no_edges() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-nedges-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("no-edges");
    db.get_board(&space).expect("seed");

    let set = db
        .set_stage_next(&space, "done", &[])
        .expect("[] is a legal configuration");
    assert_eq!(
        set.next_slugs,
        Some(vec![]),
        "explicit, and distinguishable"
    );

    let raw = raw_column(
        &db,
        &format!(
            "SELECT COALESCE(next_slugs,'NULL') FROM stages \
             WHERE space_path = '{space}' AND slug = 'done'"
        ),
    );
    assert_eq!(
        raw.first().map(|s| s.as_str()),
        Some("[]"),
        "at rest it is `[]`, NOT NULL — otherwise the two meanings collapse"
    );
}

// ── The five setter verbs (spec §4, §4.1, §5 — the same spec sections the
//    lifecycle child's banner cites, split by SUBJECT not by section) ─────────

// ── The hand-arranged canvas position (the two `position_*` columns) ────────

/// (the pair arrives together, or not at all) `set_stage_position` takes the pair
/// as ONE `Option<(f64, f64)>`, so a half-positioned node is UNREPRESENTABLE at
/// this layer — there is no argument list that spells "X known, Y unknown".
///
/// That is the chosen half of "refuse it at the write", and it is stronger than a
/// runtime refusal: the state has no spelling. A node is a BOX, and half a
/// coordinate is a lie about where a box is — `(120, ?)` forces the renderer to
/// invent the missing number, which is the invented-state move
/// `stages.prompt_prefix`'s missing `DEFAULT` and `spaces.auto_max_steps`'s
/// missing `DEFAULT` each refuse. `None` IS honest: "not hand-arranged", so dagre
/// lays the node out. Storage therefore holds three states (both set, both NULL)
/// and the fourth and fifth do not exist as values.
///
/// The half-set IS expressible on the WIRE (JSON has no tuple type), so the
/// refusal that catches a caller's mistake lives in `commands/tasks.rs`'s
/// `require_position_pair`, which is the wire's pre-flight — the
/// `require_artifact_key` / `patch_field` precedent. It is pinned there, and this
/// pin's job is the storage half: a second door (a future model-facing verb, a
/// migration) cannot reach this table with a half-pair even by accident.
///
/// WHY NOT A `BoardError::HalfStagePosition` variant, which is the shape the
/// other Stage refusals use: `agent/errors.rs` is baselined at exactly its
/// current code-line count in `scripts/file-size-baseline.txt`, the ratchet
/// refuses `measured > baseline` by ONE line, and a new variant needs TWO lines
/// there (the variant, and its arm in the exhaustive `From<BoardError>` match).
/// The pair's type-level encoding costs nothing and loses nothing, so the
/// variant was not bought.
#[test]
fn set_stage_position_refuses_a_slug_that_is_not_here_and_writes_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-pos-404-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("pos-404");
    db.get_board(&space).expect("seed");

    let err = db
        .set_stage_position(&space, "ghost", Some((1.0, 2.0)))
        .expect_err("a missing slug is refused BEFORE the write");
    match err {
        BoardError::MissingStage { wanted, available } => {
            assert_eq!(wanted, "ghost");
            assert!(
                available.contains("doing"),
                "the refusal names the slugs that ARE here — the `set_stage_skill` \
                 and `set_stage_auto` shape, because a zero-row UPDATE is a silent 0 \
                 and \"which slug did I mistype\" is the caller's real question"
            );
        }
        other => panic!("expected MissingStage, got {other:?}"),
    }
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM stages WHERE space_path = '{space}' \
                 AND position_x IS NOT NULL"
            )
        ),
        0,
        "a refused write positioned NOTHING"
    );
}

/// (hand-arranged, and back to dagre) a pair round-trips through the reply AND
/// the board read, `(0, 0)` is a real position and not an absent one, and
/// `None` clears back to NULL at rest.
#[test]
fn set_stage_position_round_trips_and_clears_back_to_null() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-pos-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("pos");
    db.get_board(&space).expect("seed");

    let set = db
        .set_stage_position(&space, "doing", Some((-40.5, 0.0)))
        .expect("set");
    assert_eq!(set.position_x, Some(-40.5), "the reply carries the X");
    assert_eq!(
        set.position_y,
        Some(0.0),
        "`0.0` is a stored coordinate, not an absent one — the two are distinct \
         states and neither is the other's default"
    );
    let board = db.get_board(&space).expect("get_board");
    let doing = board
        .iter()
        .find(|c| c.stage.slug == "doing")
        .expect("the column");
    assert_eq!(
        (doing.stage.position_x, doing.stage.position_y),
        (Some(-40.5), Some(0.0)),
        "the reply agrees with what a later board read shows, because both go \
         through the same STAGE_COLUMNS list and mapper"
    );
    assert!(
        board
            .iter()
            .filter(|c| c.stage.slug != "doing")
            .all(|c| c.stage.position_x.is_none() && c.stage.position_y.is_none()),
        "one node's drag does not position the other four"
    );

    let cleared = db
        .set_stage_position(&space, "doing", None)
        .expect("clear the pair to NULL");
    assert_eq!(
        (cleared.position_x, cleared.position_y),
        (None, None),
        "`None` is hand-arranged NO MORE — dagre owns the node again"
    );
    assert_eq!(
        raw_scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM stages WHERE space_path = '{space}' \
                 AND slug = 'doing' AND position_x IS NULL AND position_y IS NULL"
            )
        ),
        1,
        "at rest it is NULL and not 0 — 0 is a coordinate a person placed"
    );
}
