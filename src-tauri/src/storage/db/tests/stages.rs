//! Tests for `db/stages.rs`: the six Stage verbs (issue #179, spec §4/§4.1/§5),
//! the lazy five-stage seed and its per-Space isolation, and the three gated
//! #179 columns' migration (ADRs 0098 + 0099).

use crate::storage::db::*;

use crate::storage::db::stages::stage_slug_exists;

use super::support::*;

/// (the seed is per-Space) seeding one Space leaves another unseeded, so a
/// Space that never opens the board pays nothing (spec §2).
#[test]
fn seeding_one_space_leaves_another_space_unseeded() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-seed2-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let opened = board_space("opened");
    let never = board_space("never-opened");

    db.get_board(&opened).expect("seed the opened Space");
    assert_eq!(
        db.list_stages(&never).expect("list_stages").len(),
        0,
        "a Space whose board was never read has NO stage rows — the seed is lazy, \
         not a migration that writes for every existing Space"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// T1 (issue #179) — the configurable-Stage schema, its gated migration, the six
// Stage verbs, the Strict-workflow gate on `move_task`, and the `board_strict`
// read.
//
// Spec `docs/roadmap/task-board-stage-config.md` §3, §3.1, §4, §4.1, §4.2, §5;
// ADR 0098 (a Stage owns the launch Skill) and ADR 0099 (the transition graph,
// enforced only under a per-Space opt-in).
// ═════════════════════════════════════════════════════════════════════════════

/// (spec §3 + §3.1, the fresh path) a brand-new database gets all THREE new
/// columns from `SCHEMA` — no `ADD COLUMN` runs, because no gate's probe finds a
/// missing column — and seeds FIVE stages (ADR 0107 retired the seeded `discuss`).
#[test]
fn fresh_database_gets_the_three_new_columns_from_schema_and_seeds_five() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-fresh-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    for (table, column) in [
        ("stages", "on_enter_skill"),
        ("stages", "next_slugs"),
        ("spaces", "board_strict"),
    ] {
        assert!(
            has_column(&db, table, column),
            "a fresh database must get `{table}.{column}` from SCHEMA"
        );
    }

    let space = board_space("fresh-columns");
    let board = db.get_board(&space).expect("get_board seeds five");
    let shaped: Vec<(&str, i64, Option<&str>)> = board
        .iter()
        .map(|c| {
            (
                c.stage.slug.as_str(),
                c.stage.sort_order,
                c.stage.on_enter_skill.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        shaped,
        vec![
            ("backlog", 0, None),
            ("research", 1, Some("research")),
            ("approved", 2, None),
            ("doing", 3, None),
            ("done", 4, None),
        ],
        "five defaults in order, and only the one surviving launch column \
         carries a Skill (ADR 0098, as amended by ADR 0107)"
    );
    assert!(
        board.iter().all(|c| c.stage.next_slugs.is_none()),
        "`next_slugs` is NOT backfilled and the seed leaves it NULL — NULL means \
         unconfigured, not \"no edges\" (ADR 0099)"
    );
}

/// (ADR 0107 — the surviving half of spec §3.1) a pre-#179 database that has
/// the FIVE-column `stages` and no `on_enter_skill` gains the column and the ONE
/// launch Skill that still exists (`research`), and gains NO `discuss` row —
/// inventing a column for a retired Stage is no longer this gate's job, and a
/// Space that still carries a `discuss` column is user data the Stage editor
/// owns. A SECOND `Db::open` changes nothing.
///
/// This is the replacement pin for the three migration tests ADR 0107 deleted
/// with the `discuss` backfill: without it the surviving gate (the `ALTER` plus
/// the `research` UPDATE) would be untested on the migration path.
#[test]
fn the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-gate-", "scratch");
    let space = board_space("upgrade-me");
    let path = preexisting_db(
        &dir,
        SCHEMA_PRE_TASK_BOARD_CONFIG,
        &pre_task_board_rows(&space),
    );

    {
        let db = Db::open(&path).expect("the gate runs on open");

        // (a) `research` gained its launch Skill from the surviving UPDATE.
        assert_eq!(
            db.list_stages(&space)
                .expect("list_stages")
                .iter()
                .find(|s| s.slug == "research")
                .expect("the research row exists")
                .on_enter_skill
                .as_deref(),
            Some("research"),
            "the one launch Skill that still exists is backfilled (spec §3.1 \
             step 1, the step ADR 0107 kept)"
        );
        // (b) no `discuss` row was invented, and the five rows kept their indices.
        assert_eq!(
            stage_order(&db, &space),
            vec![
                ("backlog".to_string(), 0),
                ("research".to_string(), 1),
                ("approved".to_string(), 2),
                ("doing".to_string(), 3),
                ("done".to_string(), 4),
            ],
            "the gate inserts NO `discuss` row and shifts NO `sort_order` — the \
             pre-#179 board keeps the layout its owner has (ADR 0107)"
        );
        let has_discuss = {
            let guard = db.conn.lock().expect("db mutex poisoned");
            stage_slug_exists(&guard, &space, "discuss").expect("the probe reads")
        };
        assert!(
            !has_discuss,
            "no `discuss` column arrives on an upgraded Space — the retired Stage \
             must not be re-invented by a migration (ADR 0107)"
        );
        assert_eq!(
            db.list_stages(&space)
                .expect("list_stages")
                .iter()
                .filter(|s| s.on_enter_skill.is_some())
                .count(),
            1,
            "exactly ONE Stage carries a launch Skill after the gate — a surviving \
             `discuss` backfill would make this 2"
        );
        assert_eq!(
            raw_i64s(
                &db,
                &format!(
                    "SELECT COUNT(*) FROM stages WHERE space_path = '{space}' \
                     AND next_slugs IS NOT NULL"
                )
            )
            .first(),
            Some(&0),
            "`next_slugs` is still NOT backfilled (spec §3.1 step 4, ADR 0099)"
        );
        // The upgraded board is the five-column board the user sees.
        let board = db.get_board(&space).expect("get_board after the gate");
        assert_eq!(board.len(), 5, "five columns after one open");
    }

    // (c) Re-open the SAME file: the gate's probe now finds the column, so
    // nothing re-runs — no second row, no second shift, no re-backfill.
    let db = Db::open(&path).expect("a second open is a no-op");
    assert_eq!(
        stage_order(&db, &space),
        vec![
            ("backlog".to_string(), 0),
            ("research".to_string(), 1),
            ("approved".to_string(), 2),
            ("doing".to_string(), 3),
            ("done".to_string(), 4),
        ],
        "idempotent on re-open: neither a second `discuss` row nor a second shift"
    );
    assert_eq!(
        db.list_stages(&space)
            .expect("list_stages")
            .iter()
            .filter(|s| s.on_enter_skill.is_some())
            .count(),
        1,
        "the gate ran once, not twice"
    );
}

// ── The six Stage verbs (spec §4, §4.1, §5) ─────────────────────────────────

/// (spec §4 + §5) `create_stage` appends at the end, and refuses a slug
/// collision by NAMING the slugs that are taken rather than suffixing — a
/// silent `spike-2` is a slug nobody typed.
#[test]
fn create_stage_inserts_at_the_end_and_refuses_a_taken_slug_naming_the_valid_ones() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-create-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("create");
    db.get_board(&space).expect("seed the five");

    let made = db
        .create_stage(&space, "spike", "Spike!", Some("brainstorm"))
        .expect("create_stage");
    assert_eq!(made.slug, "spike");
    assert_eq!(
        made.label, "Spike!",
        "the LABEL is stored as the user typed it"
    );
    assert_eq!(made.sort_order, 5, "a new column joins at the END");
    assert_eq!(
        made.on_enter, "none",
        "the DDL default, not a second copy here"
    );
    assert_eq!(
        made.on_enter_skill.as_deref(),
        Some("brainstorm"),
        "ADR 0098: the Stage owns the launch Skill"
    );
    assert_eq!(made.next_slugs, None, "a new column starts unconfigured");

    let err = db
        .create_stage(&space, "research", "Research Again", None)
        .expect_err("a taken slug is refused, never suffixed");
    match err {
        BoardError::StageSlugTaken { slug, available } => {
            assert_eq!(slug, "research");
            assert!(
                available.contains("backlog") && available.contains("done"),
                "the refusal names the valid slugs (ADR 0090), got `{available}`"
            );
        }
        other => panic!("expected StageSlugTaken, got {other:?}"),
    }
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        6,
        "the refusal wrote nothing"
    );
}

/// (spec §5) an empty derived slug is a refusal in storage too, so the write
// path cannot be reached with a column nobody can name.
#[test]
fn create_stage_refuses_an_empty_slug() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-empty-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("empty-slug");
    db.get_board(&space).expect("seed");

    for slug in ["", "   "] {
        let err = db
            .create_stage(&space, slug, "Whitespace", None)
            .expect_err("{slug:?} is not a slug");
        assert!(
            matches!(err, BoardError::EmptyStageSlug),
            "for {slug:?}, got {err:?}"
        );
    }
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "neither refusal wrote a row"
    );
}

/// (spec §5 — the slug is FROZEN) `rename_stage` writes the LABEL and nothing
/// else, because `tasks.stage_slug` points at the slug by string with no FK.
#[test]
fn rename_stage_writes_only_the_label_and_keeps_the_slug() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-rename-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("rename");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "pointed card", None, Some("research"))
        .expect("create_task");

    let renamed = db
        .rename_stage(&space, "research", "Spike")
        .expect("rename_stage");
    assert_eq!(renamed.slug, "research", "the KEY never moves");
    assert_eq!(renamed.label, "Spike");
    assert_eq!(
        renamed.sort_order, 1,
        "and neither does the position (index 1 on the five-stage seed — ADR 0107 \
         dropped the `discuss` row that used to push `research` to 2)"
    );
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("the card")
            .stage_slug,
        "research",
        "the card still points at the same slug — the rename did not orphan it"
    );

    let err = db
        .rename_stage(&space, "nope", "Ghost")
        .expect_err("a missing stage is refused");
    assert!(
        matches!(err, BoardError::MissingStage { .. }),
        "got {err:?}"
    );
}

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

/// (spec §4 — the `reorder_spaces` contract, not `reorder_tasks`'s) the whole
/// slice renumbers, index becomes `sort_order`, dense from 0, in one call.
#[test]
fn reorder_stages_persists_the_new_column_order_in_one_pass() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-order-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("order");
    db.get_board(&space).expect("seed");

    let slugs = ["done", "doing", "approved", "research", "backlog"]
        .map(str::to_string)
        .to_vec();
    db.reorder_stages(&space, &slugs).expect("reorder_stages");

    assert_eq!(
        stage_order(&db, &space),
        slugs
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as i64))
            .collect::<Vec<_>>(),
        "the caller's order IS the stored order, dense from 0"
    );
    let board = db.get_board(&space).expect("get_board");
    assert_eq!(
        board
            .iter()
            .map(|c| c.stage.slug.as_str())
            .collect::<Vec<_>>(),
        vec!["done", "doing", "approved", "research", "backlog"],
        "and the board renders that order"
    );
}

/// (spec §4) an unknown slug is a SILENT no-op — the `reorder_spaces` contract.
/// The board's editor passes every Stage it shows, so a row it never mentioned
/// keeps its place rather than failing the whole drag.
#[test]
fn reorder_stages_is_a_silent_no_op_on_an_unknown_slug() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-order2-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("order-ghost");
    db.get_board(&space).expect("seed");

    let slugs = vec![
        "done".to_string(),
        "ghost".to_string(),
        "backlog".to_string(),
    ];
    db.reorder_stages(&space, &slugs)
        .expect("an unknown slug is a no-op, not an error");

    let after = stage_order(&db, &space);
    let named =
        |slug: &str| -> Option<i64> { after.iter().find(|(s, _)| s == slug).map(|(_, o)| *o) };
    assert_eq!(named("done"), Some(0), "the named rows renumber…");
    assert_eq!(named("backlog"), Some(2), "…in the caller's order…");
    assert_eq!(named("ghost"), None, "…and the ghost wrote no row at all");
    for (slug, untouched) in [("research", 1), ("approved", 2), ("doing", 3)] {
        assert_eq!(
            named(slug),
            Some(untouched),
            "a row the caller never named keeps the position it had — the \
             `reorder_spaces` contract, not `reorder_tasks`'s refusal"
        );
    }
}

/// (spec §4.1, refusal one) deleting a Stage that holds cards would make them
/// INVISIBLE to `get_board` while they keep costing money — the no-FK
/// consequence ADR 0090 names. The error carries the count AND the alternatives.
#[test]
fn delete_stage_refuses_a_stage_that_holds_cards_and_names_the_count_and_the_slugs() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-cards-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-cards");
    db.get_board(&space).expect("seed");
    db.create_task(&space, "one", None, Some("doing"))
        .expect("create");
    db.create_task(&space, "two", None, Some("doing"))
        .expect("create");

    let err = db
        .delete_stage(&space, "doing", None)
        .expect_err("a Stage with cards is not deletable");
    match err {
        BoardError::StageNotEmpty {
            slug,
            count,
            available,
        } => {
            assert_eq!(slug, "doing");
            assert_eq!(count, 2, "the refusal counts what it is refusing");
            assert!(
                available.contains("done"),
                "and names where they could go, got `{available}`"
            );
        }
        other => panic!("expected StageNotEmpty, got {other:?}"),
    }
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "the refusal deleted nothing"
    );
}

/// (spec §4.1, refusal two, ADR 0099's Consequence) deleting a Stage another
/// Stage's graph points at would silently SHRINK a workflow. Filtering dangling
/// slugs at read time is the rejected alternative; this refusal is the chosen one.
#[test]
fn delete_stage_refuses_a_stage_another_stage_s_next_slugs_names_it() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-ref-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-referenced");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["doing".to_string()])
        .expect("backlog → doing");

    let err = db
        .delete_stage(&space, "doing", None)
        .expect_err("a referenced Stage is not deletable");
    match err {
        BoardError::StageReferenced { slug, referrers } => {
            assert_eq!(slug, "doing");
            assert_eq!(
                referrers, "backlog",
                "the refusal names the Stage that points here, so the user knows \
                 which graph to edit"
            );
        }
        other => panic!("expected StageReferenced, got {other:?}"),
    }

    // A Stage whose graph merely does not mention the target is not a referrer,
    // and a NULL graph never is (unconfigured must not block a delete).
    db.set_stage_next(&space, "backlog", &["done".to_string()])
        .expect("re-point the edge away");
    db.delete_stage(&space, "doing", None)
        .expect("with the edge gone, the delete goes through");
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        4,
        "one row deleted"
    );
}

/// (spec §4.1, refusal three) `create_task`'s first-column fallback and
/// `get_board`'s shape both assume at least one row.
#[test]
fn delete_stage_refuses_the_last_stage() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-last-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-last");
    db.get_board(&space).expect("seed");
    let only = db
        .create_stage(&space, "solo", "Solo", None)
        .expect("create_stage");
    // Empty the seeded five, leaving exactly one row.
    for slug in ["backlog", "research", "approved", "doing", "done"] {
        db.delete_stage(&space, slug, Some("solo"))
            .expect("clear the seeded columns into solo");
    }
    assert_eq!(db.list_stages(&space).expect("list_stages").len(), 1);

    let err = db
        .delete_stage(&space, "solo", None)
        .expect_err("the last column is not deletable");
    assert!(
        matches!(&err, BoardError::LastStage { slug } if slug == "solo"),
        "got {err:?}"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        1,
        "and the refusal left the one row that keeps the board a board — the \
         card-creating fallback still has somewhere to land"
    );
    assert_eq!(only.slug, "solo");
}

/// (spec §4.1's asymmetry, the five-compactions bug guard) the relocation is ONE
/// `UPDATE tasks SET stage_slug …`, NOT N `move_task` calls: `move_task` reads
/// the destination's `on_enter` and the command layer fires its boost, so
/// "empty this column first" would attempt N compactions as bookkeeping.
/// Observables: every card moved, `updated_at` UNTOUCHED (a relocation a delete
/// forced is not an edit), and the destination's `on_enter = 'compact'` fired
/// nothing — no Session, no link, no `MoveOutcome`.
#[test]
fn delete_stage_relocates_cards_with_one_update_without_touching_updated_at_or_on_enter() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-move-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-relocate");
    db.get_board(&space).expect("seed");
    let first = db
        .create_task(&space, "one", None, Some("doing"))
        .expect("create");
    let second = db
        .create_task(&space, "two", None, Some("doing"))
        .expect("create");
    // The destination asks for a compaction. If the relocation ran `move_task`,
    // this is where two boosts would be owed.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "UPDATE stages SET on_enter = 'compact' WHERE space_path = ?1 AND slug = 'done'",
            params![space],
        )
        .expect("make the destination a compact stage");
    // Plant a DISTINCTLY old `updated_at` rather than trusting the one
    // `create_task` stamped: a relocation landing in the same millisecond would
    // otherwise leave the "untouched" assert green by accident, and an
    // accidentally-green guard is how this assertion stops being a guard.
    const PLANTED: i64 = 1000;
    for id in [&first.id, &second.id] {
        db.conn
            .lock()
            .expect("db mutex poisoned")
            .execute(
                "UPDATE tasks SET updated_at = 1000 WHERE id = ?1",
                params![id],
            )
            .expect("plant the old timestamp");
    }

    db.delete_stage(&space, "doing", Some("done"))
        .expect("delete with a destination relocates");

    for id in [&first.id, &second.id] {
        let card = db.get_task(id).expect("get_task").expect("the card");
        assert_eq!(card.stage_slug, "done", "the card moved out");
    }
    let moved_updated: Vec<i64> = raw_i64s(
        &db,
        &format!("SELECT updated_at FROM tasks WHERE space_path = '{space}' ORDER BY number ASC"),
    );
    assert_eq!(
        moved_updated,
        vec![PLANTED, PLANTED],
        "`updated_at` is UNTOUCHED — the same reason `reorder_tasks` gives: a \
         relocation a delete forced is not an edit, and the planted timestamp \
         survived the relocation"
    );
    assert_eq!(
        db.task_sessions(&first.id).expect("links").len(),
        0,
        "the relocation created no Session and no link: the destination's \
         `compact` was never acted on"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        4,
        "and the emptied column is gone"
    );
}

/// (spec §4.1) a destination that is not one of THIS Space's columns is refused
/// by name — the same `missing_stage` sentence `move_task` composes.
#[test]
fn delete_stage_refuses_a_relocate_destination_that_is_not_a_stage_of_this_space() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-del-404-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("del-ghost-dest");
    db.get_board(&space).expect("seed");
    db.create_task(&space, "stays put", None, Some("doing"))
        .expect("create");

    let err = db
        .delete_stage(&space, "doing", Some("sprint-review"))
        .expect_err("the destination must be one of this Space's stages");
    assert!(
        matches!(&err, BoardError::MissingStage { wanted, .. } if wanted == "sprint-review"),
        "got {err:?}"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "a refused delete deleted the column AND stranded the card in no way at all"
    );
    assert_eq!(
        db.list_tasks(&space).expect("list_tasks")[0].stage_slug,
        "doing",
        "the card is still where it was"
    );
}

/// Does this live database have `table.column`? (The fresh-database half of the
/// schema claim goes straight to `pragma_table_info`, because the point is that
/// the COLUMN exists without any `ALTER` having run.)
fn has_column(db: &Db, table: &str, column: &str) -> bool {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let has: i64 = guard
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            params![table, column],
            |row| row.get(0),
        )
        .expect("pragma_table_info should read");
    has > 0
}

/// `(slug, sort_order)` for one Space's stages, in `sort_order`.
fn stage_order(db: &Db, space: &str) -> Vec<(String, i64)> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = guard
        .prepare(
            "SELECT slug, sort_order FROM stages WHERE space_path = ?1 \
             ORDER BY sort_order ASC, slug ASC",
        )
        .expect("prepare");
    stmt.query_map(params![space], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })
    .expect("query")
    .collect::<Result<Vec<_>, _>>()
    .expect("rows")
}

/// The five Stage rows a pre-#179 install holds for one Space, plus that
/// Space's `spaces` row (keyed RAW — the migration never re-keys `spaces`).
fn pre_task_board_rows(space: &str) -> String {
    format!(
        "INSERT INTO spaces (path, created_at, last_opened_at, trusted, sort_order) \
         VALUES ('{space}', 1, 1, 0, 0);\n\
         INSERT INTO stages (space_path, slug, label, sort_order) VALUES \
           ('{space}','backlog','Backlog',0),\
           ('{space}','research','Research',1),\
           ('{space}','approved','Approved',2),\
           ('{space}','doing','Doing',3),\
           ('{space}','done','Done',4);\n"
    )
}
