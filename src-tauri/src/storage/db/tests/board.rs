//! Tests for `db/board.rs`: the board read and its projections (cards, linked
//! Sessions, the ADR 0082 cost figure, artifact keys), the link rows, the card
//! reorder, and the board-level Strict toggle (ADR 0099).
//!
//! The `move_task` half of the Strict workflow is tested in [`super::tasks`] —
//! that is the verb the gate guards. What lives here is the READ side and the
//! projection pins.

use crate::storage::db::*;

use crate::storage::db::rows::TASK_SESSION_COLUMNS;

use super::support::*;

// ── A1 — the Task board (spec §2, ADR 0090) ────────────────────────────────
//
// Three tables (`stages`, `tasks`, `task_sessions`), lazy stage seeding, and
// the per-Space `number` hand-out. The load-bearing assertions are the
// single-lock rendezvous in `create_task` and the ABSENCE of a foreign key on
// `space_path` — ADR 0090's whole reason for existing.
//
// The board's error type is `BoardError`, NOT `DbError`: `DbError` documents
// itself as STAYING THREE-VARIANT (it is the crate seam's type), and the board
// needs two absence cases the seam has no business carrying.

/// (lazy seeding) `get_board` on a Space with no stage rows inserts the FIVE
/// defaults in `sort_order` order, and a SECOND call seeds nothing.
#[test]
fn get_board_seeds_the_five_default_stages_once() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-stage-seed-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("fresh");

    let board = db.get_board(&space).expect("get_board seeds and reads");
    let columns: Vec<(&str, &str, i64, &str)> = board
        .iter()
        .map(|column| {
            (
                column.stage.slug.as_str(),
                column.stage.label.as_str(),
                column.stage.sort_order,
                column.stage.on_enter.as_str(),
            )
        })
        .collect();
    assert_eq!(
        columns,
        vec![
            ("backlog", "Backlog", 0, "none"),
            ("research", "Research", 1, "none"),
            ("approved", "Approved", 2, "none"),
            ("doing", "Doing", 3, "none"),
            ("done", "Done", 4, "none"),
        ],
        "the five defaults, in sort_order, label = slug capitalised, on_enter at \
         the DDL's DEFAULT 'none' (ADR 0107: the seeded `discuss` Stage is gone)"
    );
    let skills: Vec<(&str, Option<&str>)> = board
        .iter()
        .map(|column| {
            (
                column.stage.slug.as_str(),
                column.stage.on_enter_skill.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        skills,
        vec![
            ("backlog", None),
            ("research", Some("research")),
            ("approved", None),
            ("doing", None),
            ("done", None),
        ],
        "ADR 0098: exactly the one launch column carries a Skill, and the seed \
         spells it (not a second copy of `on_enter`)"
    );
    assert!(
        board.iter().all(|column| column.stage.next_slugs.is_none()),
        "the seed configures NO graph — NULL is unconfigured (ADR 0099)"
    );
    assert!(
        board.iter().all(|column| column.tasks.is_empty()),
        "a fresh Space has stages and no cards"
    );

    let again = db.get_board(&space).expect("second get_board");
    assert_eq!(
        again.len(),
        5,
        "a second board read must NOT re-seed — the seed is lazy AND idempotent"
    );
    assert_eq!(
        db.list_stages(&space).expect("list_stages").len(),
        5,
        "still exactly five stage rows after two reads"
    );
}

/// (the link row) `link_session` records `(task, session, stage)`; `None`
/// resolves to the task's CURRENT stage, and a second link is IGNORED — the
/// first link keeps the stage it was made with, because that is the stage a
/// later `compact` moves FROM (spec §5).
#[test]
fn link_session_records_the_task_and_stage_and_keeps_the_first() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-link-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("link");
    let task = db
        .create_task(&space, "linked", None, None)
        .expect("create");
    // A REAL session row: `task_sessions.session_id` carries
    // `REFERENCES sessions(id) ON DELETE CASCADE` and `Db::open` turns the
    // `foreign_keys` pragma on, so a dangling id is rejected at the statement.
    db.record_session(&title_session("sess-1"))
        .expect("record the linked session");

    db.link_session(&task.id, "sess-1", None)
        .expect("link with no stage resolves the task's current stage");
    let rows = db.task_sessions(&task.id).expect("task_sessions");
    assert_eq!(
        rows.iter()
            .map(|r| (r.session_id.as_str(), r.stage_slug.as_deref()))
            .collect::<Vec<_>>(),
        vec![("sess-1", Some("backlog"))],
        "the row exists with the task's current stage"
    );

    db.link_session(&task.id, "sess-1", Some("doing"))
        .expect("a re-link is INSERT OR IGNORE, never an error");
    let rows = db.task_sessions(&task.id).expect("task_sessions");
    assert_eq!(
        rows.iter()
            .map(|r| (r.session_id.as_str(), r.stage_slug.as_deref()))
            .collect::<Vec<_>>(),
        vec![("sess-1", Some("backlog"))],
        "INSERT OR IGNORE keeps the FIRST row"
    );

    let err = db
        .link_session("tsk_missing", "sess-1", None)
        .expect_err("linking a Task that does not exist is a rejection");
    assert!(
        matches!(err, BoardError::MissingTask(_)),
        "a missing Task is a not-found, not a silent INSERT; got {err:?}"
    );
}

/// (`Db::task_numbers`, the badge read) the Session→Task direction, app-wide:
/// ONE row per Session, the winner among several links is the most recent by
/// `rowid`, and a Session whose linked Task does not resolve produces NO row.
///
/// Five arms, one per assertion group:
///   (a) one link → one row, carrying the Task's `number` AND the `stage_slug`
///       the link was MADE with (the frozen lane, not the card's current one);
///   (b) a Session linked to TWO Tasks → ONE row, the higher-`rowid` link (D5 —
///       the badge has one slot and the tie-break lives in SQL, not the renderer);
///   (c) a Session with no link at all → absent;
///   (d) a link whose `task_id` names no `tasks` row → absent;
///   (e) **the D6 consequence**: a Session whose NEWEST link dangles but whose
///       OLDER link is live is **absent**, NOT the older Task's number.
///
/// (d) and (e) need a raw second `rusqlite::Connection` to the same file (the
/// `link_rows` precedent in `commands/tasks/tests/seed.rs`, and the same idiom
/// `commands/history.rs`'s recency test uses): `Db::link_session` resolves the
/// Task before it inserts and refuses a missing one, so that refusal is exactly
/// why the raw INSERT is the ONLY way to reach a dangling `task_id`. The column
/// carries no foreign key (ADR 0090), so SQLite will not reject it either — the
/// read is the only thing standing between such a row and a stale badge.
///
/// (e) is the arm a reasonable reader guesses wrong. The tempting "improvement"
/// is a fallback to the newest *resolving* link, which would make the badge lie
/// about a Session whose card is gone by showing a number it no longer wears.
/// This test is what stops that fallback being helpfully added back.
#[test]
fn task_numbers_returns_the_most_recent_link_per_session_and_nothing_for_a_gone_task() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-numbers-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let space = board_space("numbers");
    db.get_board(&space).expect("seed");
    let first = db
        .create_task(&space, "first card", None, None)
        .expect("create");
    let second = db
        .create_task(&space, "second card", None, None)
        .expect("create");

    // (a) one link, made with an EXPLICIT stage so the read-back proves the
    // frozen lane rather than the card's current `backlog`.
    record_linkable_session(&db, "sess-1", "/tmp/x", None);
    db.link_session(&first.id, "sess-1", Some("research"))
        .expect("link with an explicit stage");

    // (b) two links, second one LAST (rowid order is insert order here).
    record_linkable_session(&db, "sess-2", "/tmp/x", None);
    db.link_session(&first.id, "sess-2", Some("backlog"))
        .expect("first link");
    db.link_session(&second.id, "sess-2", Some("doing"))
        .expect("second link (the higher rowid)");

    // (c) a live Session with no link at all.
    record_linkable_session(&db, "sess-3", "/tmp/x", None);

    // (d) + (e): the Sessions first (the `session_id` FK IS live), then the
    // dangling link rows RAW — see this test's doc for why raw is the only door.
    record_linkable_session(&db, "sess-4", "/tmp/x", None);
    record_linkable_session(&db, "sess-5", "/tmp/x", None);
    // sess-5's OLDER link is LIVE (the lower rowid of its two).
    db.link_session(&first.id, "sess-5", Some("research"))
        .expect("sess-5's OLDER live link");
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open of the fixture db");
        // (d) sess-4's ONLY link dangles.
        conn.execute(
            "INSERT INTO task_sessions (task_id, session_id, stage_slug) \
             VALUES ('tsk_never_existed', 'sess-4', 'research')",
            [],
        )
        .expect("raw dangling link row");
        // (e) sess-5's NEWER link dangles — this INSERT is the higher rowid.
        conn.execute(
            "INSERT INTO task_sessions (task_id, session_id, stage_slug) \
             VALUES ('tsk_gone_away', 'sess-5', 'doing')",
            [],
        )
        .expect("raw NEWER dangling link for sess-5");
        drop(conn);
    }

    let rows = db.task_numbers().expect("task_numbers");

    // (a) + (b) together, in the read's own `ORDER BY session_id` order.
    assert_eq!(
        rows.iter()
            .map(|r| (
                r.session_id.as_str(),
                r.task_number,
                r.stage_slug.as_deref()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("sess-1", first.number, Some("research")),
            ("sess-2", second.number, Some("doing")),
        ],
        "(a) a single link reads back its Task's `number` AND the `stage_slug` the \
         link was MADE with (the frozen lane — a card dragged to `doing` later must \
         not rewrite it), and (b) a Session linked to TWO Tasks yields ONE row \
         holding the SECOND link's Task: `MAX(rowid)` decides in SQL (D5), never the \
         renderer; got {rows:?}"
    );
    assert_eq!(
        first.number, 1,
        "(a) the number on the row is the per-Space `tasks.number`, not the rowid \
         or the id — the label a person says out loud (ADR 0090)"
    );

    // (c) + (d) + (e): the three absences, asserted as the ABSENCE of the ids
    // rather than only as the length above, so each arm names itself.
    let ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
    assert!(
        !ids.contains(&"sess-3"),
        "(c) a Session with no link row is absent — the badge renders nothing, and \
         an invented `#0` would be a card that does not exist; got {ids:?}"
    );
    assert!(
        !ids.contains(&"sess-4"),
        "(d) a Session whose only link names a Task that does not resolve is ABSENT: \
         the read INNER JOINs `tasks`, so a dangling `task_id` — which SQLite will \
         not reject, `task_sessions.task_id` has no FK — produces absence rather \
         than a stale number; got {ids:?}"
    );
    assert!(
        !ids.contains(&"sess-5"),
        "(e) D6, the arm a reader guesses wrong: sess-5's NEWEST link dangles and \
         its OLDER link is live, and the answer is STILL no row at all — NOT the \
         older Task's number. The winner is chosen by `MAX(rowid)` BEFORE the join, \
         so an unresolvable winner kills the row; a 'helpful' fallback to the newest \
         resolving link would put a number on a Session that no longer wears it. \
         Got {ids:?}"
    );
}

/// (`task_sessions.session_id` DOES carry the FK) the one FK the board has:
/// deleting the Session removes the link row, deleting the Space does not.
#[test]
fn task_sessions_cascade_with_the_session_and_not_with_the_space() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-fk-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("fk");
    let task = db.create_task(&space, "fk me", None, None).expect("create");
    db.record_session(&title_session("sess-fk"))
        .expect("record the session the link points at");
    db.link_session(&task.id, "sess-fk", None).expect("link");
    assert_eq!(db.task_sessions(&task.id).expect("links").len(), 1);

    db.delete_session("sess-fk")
        .expect("delete_session (the FK's ON DELETE CASCADE target)");
    assert_eq!(
        db.task_sessions(&task.id).expect("links").len(),
        0,
        "`task_sessions.session_id` reuses the file's `REFERENCES sessions(id) \
         ON DELETE CASCADE` clause, so a deleted Session drops the link"
    );
    assert!(
        db.get_task(&task.id).expect("get_task").is_some(),
        "the Task itself is NOT a child of the Session — it is the card"
    );
}

/// (the board read is ONE payload) `get_board` groups the cards under the stage
/// rows in stage order — empty columns included — so the frontend never joins.
#[test]
fn get_board_groups_tasks_under_their_stage_in_stage_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-group-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("group");
    db.get_board(&space).expect("seed");
    let one = db.create_task(&space, "one", None, None).expect("create");
    db.create_task(&space, "two", None, Some("done"))
        .expect("create");
    db.move_task(&space, &one.id, "done").expect("move");

    let board = db.get_board(&space).expect("get_board");
    let shaped: Vec<(&str, Vec<&str>)> = board
        .iter()
        .map(|c| {
            (
                c.stage.slug.as_str(),
                c.tasks.iter().map(|t| t.task.title.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        shaped,
        vec![
            ("backlog", vec![]),
            ("research", vec![]),
            ("approved", vec![]),
            ("doing", vec![]),
            ("done", vec!["one", "two"]),
        ],
        "every stage appears (empty columns too), in sort_order, each carrying its own cards"
    );
    assert_eq!(
        db.list_tasks(&space).expect("list_tasks").len(),
        2,
        "the flat read agrees with the grouped one"
    );
}

// ── issue #174: the board read carries each card's Sessions and its cost ───
//
// Eight pins for one new statement + one new wrapper type. The shape being
// pinned is `TaskCardView { task, sessions, costUsd }`, and the load-bearing
// half of it is ADR 0082's two meanings for `sessions.cost_usd`: `NULL` means
// "no model call ever reported a cost" (render NOTHING) and `0.0` means "a real
// zero" (render `$0.00`). Every cost test below exists to keep those two
// distinguishable through the fold — collapsing them at the board read would
// put a phantom `$0.00` on a card that has spent nothing measurable.

/// (issue #174, the happy path) A card with two linked Sessions carries BOTH
/// link rows and ONE summed figure.
///
/// The cost arrives as a single number, not as two: summing it in TypeScript
/// would put ADR 0082's NULL/zero rule in a second language with nothing tying
/// the two together. The links come back OLDEST FIRST because that is the order
/// `Db::task_sessions` already publishes, so the card's "newest" is `last()` and
/// the two readers of this table agree.
#[test]
fn get_board_returns_each_card_with_its_linked_sessions_and_the_total_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-cost-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("cost");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "worked", None, None)
        .expect("create");

    record_linkable_session(&db, "sess-old", "/tmp/proj", Some(1.50));
    record_linkable_session(&db, "sess-new", "/tmp/proj", Some(0.25));
    db.link_session(&card.id, "sess-old", None).expect("link");
    db.link_session(&card.id, "sess-new", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(cards.len(), 1, "one card on this board");
    let view = &cards[0];
    assert_eq!(view.task.id, card.id, "the card itself rides along intact");
    assert_eq!(
        view.sessions
            .iter()
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-old", "sess-new"],
        "both links, OLDEST FIRST — the same order `Db::task_sessions` publishes, \
         so the card's newest is `last()`"
    );
    assert_eq!(
        view.cost_usd,
        Some(1.75),
        "ONE summed figure, computed server-side"
    );
    assert_eq!(
        view.sessions
            .iter()
            .map(|link| link.task_id.as_str())
            .collect::<Vec<_>>(),
        vec![card.id.as_str(), card.id.as_str()],
        "the link rows carry their own `task_id` — the same `TaskSessionRow` the \
         single-card read returns, not a new shape"
    );
}

/// (issue #174, the case that must NOT become `Some(0.0)`) a card with no links
/// has no Sessions and NO cost.
///
/// `Some(0.0)` here would render `$0.00` on a card that never ran a Session —
/// the exact phantom ADR 0082 forbids, and invisible to every other test because
/// it is a well-formed number in the wrong slot.
#[test]
fn a_card_with_no_links_gets_no_sessions_and_a_null_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-nolink-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("no-link");
    db.get_board(&space).expect("seed");
    db.create_task(&space, "untouched", None, None)
        .expect("create");
    // A Session exists in the database; it is simply not linked to this card.
    record_linkable_session(&db, "sess-unlinked", "/tmp/proj", Some(9.99));

    let cards = board_cards(&db, &space);
    assert_eq!(cards.len(), 1);
    assert!(
        cards[0].sessions.is_empty(),
        "no links, no sessions; got {:?}",
        cards[0].sessions
    );
    assert_eq!(
        cards[0].cost_usd, None,
        "`None` — never `Some(0.0)`. A card that has never run a Session has no \
         figure, not a free one."
    );
}

/// (ADR 0082's whole point, at the board read) a Session that reported a genuine
/// zero contributes `Some(0.0)`, not `None`.
///
/// `record_session_cost` is a snapshot write, so `0.0` is a figure a model call
/// actually produced. The card must render `$0.00` for it, which requires the
/// fold to preserve the distinction rather than treat zero as nothing.
#[test]
fn a_real_zero_cost_is_some_zero_not_null() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-zero-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("zero");
    db.get_board(&space).expect("seed");
    let card = db.create_task(&space, "free", None, None).expect("create");

    record_linkable_session(&db, "sess-zero", "/tmp/proj", Some(0.0));
    db.link_session(&card.id, "sess-zero", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(cards[0].sessions.len(), 1, "the link is there");
    assert_eq!(
        cards[0].cost_usd,
        Some(0.0),
        "a reported zero SURVIVES the fold as `Some(0.0)` — the card renders \
         `$0.00`, and `None` here would silently render nothing"
    );
}

/// (the fold IS SQL's SUM over nullable inputs) NULL iff EVERY input is NULL.
///
/// Two Sessions that never reported a cost sum to `None`. An implementation that
/// seeded the accumulator with `Some(0.0)` — the shape a `SUM`-free loop falls
/// into — passes the two-figure tests above and fails HERE.
#[test]
fn all_unreported_costs_sum_to_null_not_zero() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-null-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("all-null");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "unmeasured", None, None)
        .expect("create");

    record_linkable_session(&db, "sess-a", "/tmp/proj", None);
    record_linkable_session(&db, "sess-b", "/tmp/proj", None);
    db.link_session(&card.id, "sess-a", None).expect("link");
    db.link_session(&card.id, "sess-b", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(
        cards[0].sessions.len(),
        2,
        "both links are present — the NULLs are about COST, not about the link"
    );
    assert_eq!(
        cards[0].cost_usd, None,
        "every input NULL, so the sum is NULL. `Some(0.0)` here is the phantom \
         `$0.00` ADR 0082 exists to prevent."
    );
}

/// (one NULL does not poison the sum) `NULL + 2.00` is `Some(2.00)`.
///
/// SQL's `SUM` skips NULLs, and so must this fold: a Session that has never
/// reported must not erase the figure one of its siblings did report.
#[test]
fn one_reported_and_one_unreported_cost_yields_the_reported_figure() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-mixed-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("mixed");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "half measured", None, None)
        .expect("create");

    // Linked in the order that puts the NULL FIRST, so an implementation that
    // stopped at the first NULL would show up as `None` rather than limping past.
    record_linkable_session(&db, "sess-null", "/tmp/proj", None);
    record_linkable_session(&db, "sess-two", "/tmp/proj", Some(2.0));
    db.link_session(&card.id, "sess-null", None).expect("link");
    db.link_session(&card.id, "sess-two", None).expect("link");

    let cards = board_cards(&db, &space);
    assert_eq!(cards[0].sessions.len(), 2);
    assert_eq!(
        cards[0].cost_usd,
        Some(2.0),
        "the reported figure survives; the unreported Session contributes nothing"
    );
}

/// (issue #174, the scoping rule) the link read is restricted to THIS Space's
/// cards by `task_id IN (SELECT id FROM tasks WHERE space_path = ?1)` — never by
/// the Session's `cwd`.
///
/// Both directions are pinned, because a `cwd` filter fails in BOTH of them:
///   - a linked Session whose `cwd` is NOT the card's Space must still appear
///     (`sessions` has no `space_path`; the Space is derived from `cwd`, and a
///     Session can be started from anywhere) — a `cwd` filter would DROP it;
///   - another Space's card, linked to a Session whose `cwd` IS this Space's
///     path, must contribute NOTHING here — a `cwd` filter would PULL it in.
///     The second card lives in another Space and its link is simply not in
///     this payload.
#[test]
fn get_board_does_not_include_another_spaces_links() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-scope-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("scoped");
    let other = board_space("scoped-other");
    db.get_board(&space).expect("seed");
    db.get_board(&other).expect("seed the other board");

    let mine = db.create_task(&space, "mine", None, None).expect("create");
    let theirs = db
        .create_task(&other, "theirs", None, None)
        .expect("create in another space");

    // MY card's Session runs somewhere ELSE (the default `/tmp/proj` cwd, which
    // is not this Space's path) — a `cwd` filter would drop this link.
    record_linkable_session(&db, "sess-mine-elsewhere", "/tmp/proj", Some(1.00));
    // THEIR card's Session runs IN MY Space — a `cwd` filter would pull this one in.
    record_linkable_session(&db, "sess-theirs-in-my-space", &space, Some(5.00));

    db.link_session(&mine.id, "sess-mine-elsewhere", None)
        .expect("link my card to a session with another cwd");
    db.link_session(&theirs.id, "sess-theirs-in-my-space", None)
        .expect("link the other card to a session inside my Space's directory");

    let cards = board_cards(&db, &space);
    assert_eq!(
        cards.iter().map(|c| c.sessions.len()).sum::<usize>(),
        1,
        "exactly ONE link row on this board — the other Space's card contributes \
         nothing even though its Session's `cwd` IS this Space's path"
    );
    assert_eq!(
        cards[0]
            .sessions
            .iter()
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-mine-elsewhere"],
        "and my own link survives although its Session's `cwd` is not this Space \
         — the restriction is by task_id, never by cwd"
    );
    assert_eq!(
        cards[0].cost_usd,
        Some(1.00),
        "the other Space's $5.00 Session is not folded into my card's figure"
    );

    // The far side reads its own link, and nothing of mine.
    let elsewhere = board_cards(&db, &other);
    assert_eq!(
        elsewhere
            .iter()
            .flat_map(|c| c.sessions.iter())
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-theirs-in-my-space"],
        "the other board sees its own link and none of mine"
    );
}

/// (issue #174, the falsifiable JOIN check) deleting a linked Session drops its
/// link row AND its share of the card's figure.
///
/// This is the test that replaces a `JOIN`-vs-`LEFT JOIN` mutation check: with
/// `foreign_keys` ON and `ON DELETE CASCADE`, a link to a missing Session cannot
/// exist, so no row distinguishes the two joins at this read. What CAN break is
/// the cascade not reaching the board — a stale link would leave a phantom count
/// and a figure that keeps charging for a deleted Session. Same delete path
/// `task_sessions_cascade_with_the_session_and_not_with_the_space` uses.
#[test]
fn deleting_a_linked_session_drops_its_link_row_and_its_share_of_the_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-board-cascade-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("cascade");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "two sessions", None, None)
        .expect("create");

    record_linkable_session(&db, "sess-keep", "/tmp/proj", Some(1.00));
    record_linkable_session(&db, "sess-drop", "/tmp/proj", Some(2.00));
    db.link_session(&card.id, "sess-keep", None).expect("link");
    db.link_session(&card.id, "sess-drop", None).expect("link");

    let before = board_cards(&db, &space);
    assert_eq!(before[0].sessions.len(), 2, "both links, to start with");
    assert_eq!(before[0].cost_usd, Some(3.00), "and the summed figure");

    db.delete_session("sess-drop")
        .expect("delete_session (the FK's ON DELETE CASCADE target)");

    let after = board_cards(&db, &space);
    assert_eq!(
        after[0]
            .sessions
            .iter()
            .map(|link| link.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-keep"],
        "the cascade reaches the board read: the deleted Session's link is gone"
    );
    assert_eq!(
        after[0].cost_usd,
        Some(1.00),
        "and its $2.00 left the figure with it — a card that still charged for a \
         deleted Session would be a phantom cost"
    );
}

/// The DRIFT PIN for the board's card payload (issue #174).
///
/// `types.ts`'s `TaskCardView` is a HAND-WRITTEN mirror — no Rust↔TS shape pin
/// exists in this repo — so the FOUR key lists below (`FROZEN_CARD_KEYS`,
/// `FROZEN_TASK_KEYS`, `FROZEN_LINK_KEYS`) are spelled a second time in
/// `src/store/tasks.test.ts` as `the task card view wire keys are frozen (mirror
/// of the Rust pin)`, byte-identical. A rename on either side reddens one of the
/// two. Modelled on `closed_reason_spellings_are_frozen`.
#[test]
fn the_task_card_view_wire_keys_are_frozen() {
    // The TS mirror is `src/lib/tauri/types.ts`'s
    // `export interface TaskCardView { task: TaskRow; sessions: TaskSessionRow[];
    // costUsd: number | null; artifactKeys: string[]; }` — these FOUR keys, in
    // this order, no more. `artifactKeys` joined in #180 and is REQUIRED, never
    // optional: an optional field compiles against every fixture and renders
    // nothing when real data arrives.
    const FROZEN_CARD_KEYS: [&str; 4] = ["task", "sessions", "costUsd", "artifactKeys"];
    // The TS mirror of these TEN is `export interface TaskRow` in the same file.
    const FROZEN_TASK_KEYS: [&str; 10] = [
        "id",
        "spacePath",
        "number",
        "title",
        "body",
        "specPath",
        "stageSlug",
        "sortOrder",
        "createdAt",
        "updatedAt",
    ];
    // The TS mirror of these THREE is `export interface TaskSessionRow` in the
    // SAME file (`src/lib/tauri/types.ts`), spelled byte-identically by its
    // mirror test `the task card view wire keys are frozen (mirror of the Rust
    // pin)` in `src/store/tasks.test.ts`. This is the list the chip reads
    // (`sessions[].sessionId`), so it is frozen alongside the other two.
    const FROZEN_LINK_KEYS: [&str; 3] = ["taskId", "sessionId", "stageSlug"];

    let view = TaskCardView {
        task: TaskRow {
            id: "tsk_frozen".to_string(),
            space_path: "/board-space/frozen".to_string(),
            number: 1,
            title: "frozen".to_string(),
            body: None,
            spec_path: None,
            stage_slug: "backlog".to_string(),
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        },
        sessions: vec![TaskSessionRow {
            task_id: "tsk_frozen".to_string(),
            session_id: "sess-frozen".to_string(),
            stage_slug: None,
        }],
        cost_usd: Some(1.75),
        artifact_keys: vec!["spec".to_string()],
    };
    let value = serde_json::to_value(&view).expect("TaskCardView serializes");

    let mut card_keys: Vec<&str> = value
        .as_object()
        .expect("a struct serializes to a map")
        .keys()
        .map(String::as_str)
        .collect();
    card_keys.sort_unstable();
    let mut expected_card_keys = FROZEN_CARD_KEYS;
    expected_card_keys.sort_unstable();
    assert_eq!(
        card_keys, expected_card_keys,
        "the card payload is exactly `{{task, sessions, costUsd, artifactKeys}}` — \
         `#[serde(flatten)]` is deliberately NOT used, so the nested `task` key is \
         part of the wire shape, and `artifactKeys` is REQUIRED (never \
         `skip_serializing_if`), so a card with no artifacts sends `[]`"
    );

    let task = value.get("task").expect("the nested task key");
    let mut task_keys: Vec<&str> = task
        .as_object()
        .expect("task is a map")
        .keys()
        .map(String::as_str)
        .collect();
    task_keys.sort_unstable();
    let mut expected_task_keys = FROZEN_TASK_KEYS;
    expected_task_keys.sort_unstable();
    assert_eq!(
        task_keys, expected_task_keys,
        "`task` is the UNCHANGED 10-field `TaskRow` in camelCase — the wrapper adds \
         nothing to it, which is what keeps get_task/create_task/edit_task honest"
    );

    // The THIRD list: the nested link the chip actually reads. `sessions[0]` is
    // the only place `sessionId` reaches the card at all, so without this the
    // `session_id` ↔ `sessionId` seam sat unfrozen on a path the UI depends on —
    // a rename would redden nothing here and silently blank every chip.
    let link = &value["sessions"][0];
    let mut link_keys: Vec<&str> = link
        .as_object()
        .expect("a link is a map")
        .keys()
        .map(String::as_str)
        .collect();
    link_keys.sort_unstable();
    let mut expected_link_keys = FROZEN_LINK_KEYS;
    expected_link_keys.sort_unstable();
    assert_eq!(
        link_keys, expected_link_keys,
        "`sessions[]` is exactly `{{taskId, sessionId, stageSlug}}` — `sessionId` is \
         what the card's chip opens, so this key is load-bearing, not decoration"
    );

    assert_eq!(
        value.get("costUsd").and_then(serde_json::Value::as_f64),
        Some(1.75),
        "`cost_usd` rides the wire as `costUsd` (rename_all = camelCase)"
    );
    // The `None` half of ADR 0082 has to survive the wire too: the key must be
    // PRESENT and `null`, not absent. A `skip_serializing_if` would delete it and
    // the TS mirror's `number | null` would be a lie the frontend could not tell.
    let unmeasured = TaskCardView {
        task: view.task,
        sessions: vec![],
        cost_usd: None,
        artifact_keys: vec![],
    };
    let absent = serde_json::to_value(&unmeasured).expect("the null-cost card serializes");
    assert!(
        absent.get("costUsd").is_some(),
        "`costUsd` must be PRESENT when there is no figure — a `skip_serializing_if` \
         would make the key vanish and the TS mirror's `number | null` would be a lie"
    );
    assert!(
        absent.get("costUsd").expect("the key is there").is_null(),
        "…and it is JSON `null`, which is what `moneyOf(null)` renders as nothing"
    );
    // `artifactKeys` obeys the same rule as `costUsd`: PRESENT when there is
    // nothing to show. `Vec<String>` has no `None`, so an empty list is the whole
    // story — but a `skip_serializing_if = "Vec::is_empty"` would make the key
    // vanish and the TS mirror's required `artifactKeys: string[]` would be a lie
    // the frontend could not distinguish from a stale payload.
    assert_eq!(
        absent
            .get("artifactKeys")
            .and_then(serde_json::Value::as_array),
        Some(&Vec::<serde_json::Value>::new()),
        "`artifactKeys` must be PRESENT and `[]` on a card with no artifacts — a \
         required wire key, not an optional one"
    );
}

/// (issue #174, the drift pin) `get_board`'s link statement and
/// [`TASK_SESSION_COLUMNS`] select the SAME names in the SAME order.
///
/// Both reads hand their rows to the SAME positional mapper
/// [`task_session_row_from`] (position 0 → `task_id`, 1 → `session_id`, 2 →
/// `stage_slug`), but only `Db::task_sessions` builds its SQL FROM the const
/// (`TASK_SESSION_COLUMNS.join(", ")`); `get_board` spells its projection by
/// hand because it joins `sessions` and so must qualify every column with the
/// `ts.` alias — and the const's unqualified names are exactly what a
/// two-table join cannot reuse. That is why the const is interpolated where it
/// can be and pinned here where it cannot: the alternative (a `ts.`-prefixed
/// second projection built from the const) would be a second list to keep
/// honest, and it would bury a SQL literal this file documents in detail.
///
/// Source-text lint, not a DB assertion: a mutation that renames or reorders a
/// name in ONE of the two lists is invisible to every behavioural test until a
/// user's board silently reads `session_id` into `task_id`. Same technique the
/// schema guards above use (`include_str!` + `matches(…).count()`, and
/// `tests/provider_oidc.rs` lints `src/lib.rs` the same way).
///
/// Compared UNSORTED on purpose — unlike the wire-key pins above, where JSON
/// object key order is not observable on the wire, here order IS the contract,
/// because the mapper reads columns by POSITION.
#[test]
fn the_board_link_statement_selects_the_columns_the_const_owns() {
    // Re-pointed at `db/board.rs` by the ADR 0113 split: the statement this reads
    // is inside `get_board`, and `get_board` is what `board.rs` holds. The
    // single-anchor assertion below is what proves the re-point is right — exactly
    // one `task_sessions ts` read exists in the whole unit and it is here, so the
    // pin cannot silently grade the other `task_sessions` statement.
    let source = include_str!("../board.rs");

    // ONE anchor, or `rfind` below would read an arbitrary statement and the
    // pin would grade the wrong SQL.
    const ANCHOR: &str = "FROM task_sessions ts";
    assert_eq!(
        source.matches(ANCHOR).count(),
        1,
        "this pin reads the projection that sits immediately before `{ANCHOR}`; a \
         second `task_sessions ts` read would silently point it at the wrong statement"
    );
    let head = &source[..source.find(ANCHOR).expect("the board's link statement")];
    let projection = &head[head
        .rfind("SELECT ")
        .expect("a SELECT ahead of the board's link statement")
        + "SELECT ".len()..];

    // The statement is a multi-line literal with `\` continuations; flatten it
    // so each selected term is one trimmed token.
    let flattened = projection.replace(['\\', '\n'], " ");
    let terms: Vec<&str> = flattened
        .split(',')
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .collect();

    assert!(
        terms.len() > TASK_SESSION_COLUMNS.len(),
        "the board's link projection must carry the const's {} columns PLUS the \
         joined cost column — it selected only {terms:?}",
        TASK_SESSION_COLUMNS.len()
    );

    // Drop the `ts.` alias: the const names columns UNQUALIFIED, the join must
    // not. Stripping the alias is what makes the two lists comparable at all.
    let selected: Vec<&str> = terms
        .iter()
        .map(|term| term.strip_prefix("ts.").unwrap_or(term))
        .collect();
    assert_eq!(
        &selected[..TASK_SESSION_COLUMNS.len()],
        &TASK_SESSION_COLUMNS[..],
        "`get_board` and `task_sessions` feed the SAME positional mapper, so they \
         must select the SAME names in the SAME order — the const holds \
         {TASK_SESSION_COLUMNS:?}, the board's link statement holds {selected:?} \
         (a rename or a reorder on either side mis-assigns every card's links)"
    );
    for term in &selected[..TASK_SESSION_COLUMNS.len()] {
        assert!(
            !term.contains('.'),
            "every mapped column must come from `task_sessions` itself — a \
             table-qualified name (`{term}`) in the first three means the mapper is \
             reading the JOINED `sessions` table"
        );
    }
    // Position 3 is not incidental: `get_board`'s row closure reads exactly
    // `row.get::<_, Option<f64>>(3)` as the cost. Columns AFTER it are free to
    // grow; a column at THIS index would silently become the card's figure.
    assert_eq!(
        selected[TASK_SESSION_COLUMNS.len()],
        "s.cost_usd",
        "position {} is what `get_board` reads as the card's cost — the mapper owns \
         0..{}, so the cost must sit at {}",
        TASK_SESSION_COLUMNS.len(),
        TASK_SESSION_COLUMNS.len(),
        TASK_SESSION_COLUMNS.len()
    );
}

/// (spec §3, the within-column drag verb) A drag INSIDE a column writes
/// `sort_order`, and it is the ONLY thing it writes.
///
/// Spec §3's table says a within-column drag writes "`sort_order` only", and
/// "Mirrored by nothing" names the absence of a HARNESS tool (ADR 0075 —
/// position is not evidence, so no tool needs to see it), NOT the absence of a
/// write. A1 shipped no verb that could perform that write at all, which made
/// the spec's own row unimplementable; `Db::reorder_tasks` is that verb,
/// patterned on `reorder_spaces`/`reorder_sessions`: the slice index becomes the
/// stored value, in ONE lock and ONE transaction.
///
/// Three things are pinned, one per assertion group:
///   - the permuted order is what reads back, densely from 0, through the board
///     read the UI actually renders from (`get_board`);
///   - `stage_slug` and `number` are UNTOUCHED — this is a position write, not a
///     move (that is `move_task`) and not a renumber (never, ADR 0090);
///   - another column's cards keep their numbers. `sort_order` is PER-SPACE, not
///     per-stage (see `create_task`'s `MAX(sort_order) … WHERE space_path = ?1`),
///     so a per-column reorder must not renumber across stages — the same
///     tolerated-collision state `reorder_sessions` documents.
#[test]
fn reorder_tasks_persists_the_new_within_stage_order_in_one_pass() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-reorder-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("reorder");
    db.get_board(&space).expect("seed the five stages");

    // Three cards in `backlog` (the first stage, so `stage_slug: None` lands
    // them there) and two in `done`. The `done` pair is the control group: it
    // sits at positions 3 and 4 because the bottom-join is per-Space, so an
    // implementation that renumbered the whole Space would move them and this
    // test would see it.
    let one = db.create_task(&space, "one", None, None).expect("create");
    let two = db.create_task(&space, "two", None, None).expect("create");
    let three = db.create_task(&space, "three", None, None).expect("create");
    assert_eq!(
        vec![one.sort_order, two.sort_order, three.sort_order],
        vec![0, 1, 2],
        "the three cards start in the order they were created"
    );
    let outside = db
        .create_task(&space, "outside-a", None, Some("done"))
        .expect("create in another stage");
    let outside_too = db
        .create_task(&space, "outside-b", None, Some("done"))
        .expect("create in another stage");

    // The dragged order: `[three, one, two]`.
    let dragged = vec![three.id.clone(), one.id.clone(), two.id.clone()];
    db.reorder_tasks(&space, "backlog", &dragged)
        .expect("reorder_tasks should succeed");

    let backlog = db
        .get_board(&space)
        .expect("get_board")
        .into_iter()
        .find(|column| column.stage.slug == "backlog")
        .expect("the seeded backlog column");
    let seen: Vec<(&str, i64)> = backlog
        .tasks
        .iter()
        .map(|task| (task.task.title.as_str(), task.task.sort_order))
        .collect();
    assert_eq!(
        seen,
        vec![("three", 0), ("one", 1), ("two", 2)],
        "the board reads back in the dragged order with the new positions, densely from 0"
    );

    // The write is POSITIONAL ONLY. Each dragged row is re-read by its GLOBAL id
    // rather than filtered out of `list_tasks`: the filtered form is VACUOUS — it
    // would select on `stage_slug` and then assert on `stage_slug`, so it would
    // pass even if the UPDATE had rewritten the column.
    for task in [&one, &two, &three] {
        let stored = db
            .get_task(&task.id)
            .expect("get_task")
            .expect("the dragged card is still there");
        assert_eq!(
            stored.stage_slug, "backlog",
            "a within-column reorder never changes `stage_slug` (that is `move_task`)"
        );
        assert_eq!(stored.number, task.number, "and never renumbers");
        assert_eq!(
            stored.updated_at, task.updated_at,
            "spec §3 writes `sort_order` ONLY — `updated_at` is a last-edited clock \
             and a reorder that moves it makes the clock lie (weak if the create ran \
             in the same millisecond, but it can never fail spuriously)"
        );
    }
    let numbers: Vec<i64> = db
        .list_tasks(&space)
        .expect("list_tasks")
        .iter()
        .filter(|task| task.stage_slug == "backlog")
        .map(|task| task.number)
        .collect();
    assert_eq!(
        numbers,
        vec![3, 1, 2],
        "`number` is a label that is NEVER renumbered (ADR 0090): read in the NEW \
         position order the labels come back 3,1,2 — visibly out of order, and that \
         is the correct outcome. A reorder that renumbered the labels would silently \
         re-point every historical mention of `T1`."
    );

    // The control group: `sort_order` is per-Space, so the numbers this call
    // never named stay exactly where they were.
    assert_eq!(
        sort_order_of(&db, "tasks", "id", &outside.id),
        outside.sort_order,
        "a card in ANOTHER STAGE keeps its own position — this verb writes only the ids it was handed"
    );
    assert_eq!(
        sort_order_of(&db, "tasks", "id", &outside_too.id),
        outside_too.sort_order,
        "and so does its neighbour"
    );
}

/// (the scoping rule) An id the caller had no right to name is refused, loudly,
/// and NOTHING is written.
///
/// `tasks.id` is a GLOBAL key and `space_path` is not part of it, so a caller
/// can hand back a card from another stage or another Space. `reorder_spaces`
/// treats an unknown id as a no-op because a path matches no row at all; here an
/// id that EXISTS but is not in this `(space, stage)` slice is a different thing
/// — writing it would move a card the user is not looking at, possibly into a
/// column it is not in. `BoardError::MissingTask` names it (the same absence
/// variant `edit_task` uses: a WRITE the caller believes succeeded, not a read
/// that came back empty), and the atomicity half is the point — the rejection
/// happens inside the transaction, so the cards the caller DID name keep their
/// old positions rather than landing half-renumbered.
#[test]
fn reorder_tasks_refuses_a_foreign_id_and_writes_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-reord-nope-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("foreign");
    let other = board_space("other-space");
    db.get_board(&space).expect("seed");

    let one = db.create_task(&space, "one", None, None).expect("create");
    let two = db.create_task(&space, "two", None, None).expect("create");
    let three = db.create_task(&space, "three", None, None).expect("create");
    let in_done = db
        .create_task(&space, "in-done", None, Some("done"))
        .expect("create in another stage");
    let elsewhere = db
        .create_task(&other, "elsewhere", None, None)
        .expect("create in another space");

    // A card from another STAGE of the SAME Space, handed over AFTER two valid
    // ids. The two valid ids are deliberately at indices whose values DIFFER
    // from their stored positions (three was 2, one was 0; the slice would write
    // 0 and 1) — otherwise the "nothing was written" assertion below would pass
    // even with no rollback at all, which is exactly the vacuous pin this repo
    // keeps documenting.
    let err = db
        .reorder_tasks(
            &space,
            "backlog",
            &[one.id.clone(), three.id.clone(), in_done.id.clone()],
        )
        .expect_err("a card that is not in `backlog` must not be repositioned by this call");
    assert!(
        matches!(&err, BoardError::MissingTask(id) if id.as_str() == in_done.id.as_str()),
        "the error must be MissingTask NAMING the offending id, got {err:?}"
    );
    assert_eq!(
        (
            sort_order_of(&db, "tasks", "id", &one.id),
            sort_order_of(&db, "tasks", "id", &three.id),
            sort_order_of(&db, "tasks", "id", &in_done.id),
        ),
        (one.sort_order, three.sort_order, in_done.sort_order),
        "the rejection is ATOMIC — the two VALID ids in the same slice keep their OLD \
         positions rather than landing half-renumbered (the transaction rolled back)"
    );

    // A card from another SPACE (the ADR 0090 no-FK shape makes this reachable:
    // ids are global, `space_path` is just a column).
    let err = db
        .reorder_tasks(&space, "backlog", &[two.id.clone(), elsewhere.id.clone()])
        .expect_err("a card from another Space must not be repositioned by this call");
    assert!(
        matches!(&err, BoardError::MissingTask(id) if id.as_str() == elsewhere.id.as_str()),
        "the error must name the foreign id, got {err:?}"
    );
    assert_eq!(
        sort_order_of(&db, "tasks", "id", &elsewhere.id),
        elsewhere.sort_order,
        "the other Space's card is untouched"
    );

    // An id with no row at all is the same rejection, not a silent no-op: every
    // id this verb is handed is one the caller believes it just dragged.
    let ghost = format!("tsk_{}", uuid::Uuid::new_v4());
    let err = db
        .reorder_tasks(&space, "backlog", std::slice::from_ref(&ghost))
        .expect_err("an id matching no row is refused here");
    assert!(
        matches!(&err, BoardError::MissingTask(id) if id.as_str() == ghost.as_str()),
        "got {err:?}"
    );

    // A STAGE that does not exist in this Space is refused with the stage error
    // (ADR 0090's rule: name the valid slugs so the caller self-corrects).
    let err = db
        .reorder_tasks(&space, "nonsense", std::slice::from_ref(&one.id))
        .expect_err("a stage that is not one of this Space's columns is refused");
    assert!(
        matches!(&err, BoardError::MissingStage { wanted, .. } if wanted == "nonsense"),
        "got {err:?}"
    );

    // And the happy path still works AFTER the rejections (no poisoned state).
    db.reorder_tasks(&space, "backlog", &[two.id.clone(), one.id.clone()])
        .expect("a valid reorder still succeeds after the refusals");
    assert_eq!(
        (
            sort_order_of(&db, "tasks", "id", &two.id),
            sort_order_of(&db, "tasks", "id", &one.id),
        ),
        (0, 1),
        "the valid reorder landed"
    );
}

// ── The Strict workflow (ADR 0099) — the write, the read, and the gate ──────

/// (ADR 0099) the toggle persists both ways and reads back through
/// `Db::board_strict`; a Space with NO `spaces` row reads `false`, which is the
/// same answer `move_task`'s gate computes — the Switch and the gate cannot
/// disagree about a Space that has no row.
#[test]
fn set_board_strict_persists_1_and_0_and_reads_back() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-write-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-toggle");
    db.upsert_space(&space, false).expect("upsert_space");

    assert!(
        db.set_board_strict(&space, true).expect("set_board_strict"),
        "a matching row reports that it was touched"
    );
    assert!(
        db.board_strict(&space).expect("board_strict"),
        "the read sees what the write stored"
    );
    assert!(db
        .set_board_strict(&space, false)
        .expect("clear_board_strict"));
    assert!(
        !db.board_strict(&space).expect("board_strict"),
        "the flag is a toggle, not a ratchet"
    );
    assert_eq!(
        raw_i64s(
            &db,
            &format!("SELECT board_strict FROM spaces WHERE path = '{space}'")
        )
        .first(),
        Some(&0),
        "1 and 0 are the two stored values"
    );

    // A Space with no row at all: a silent no-op WRITE, and `false` READ.
    let nowhere = board_space("strict-no-row");
    assert!(
        !db.set_board_strict(&nowhere, true).expect("no-op write"),
        "mirrors `set_space_trusted`: a missing row is a diagnosable no-op"
    );
    assert!(
        !db.board_strict(&nowhere).expect("board_strict"),
        "and the read answers false, not an error"
    );
}

/// (spec §3's leniency claim) a `next_slugs` cell that is not a JSON array is
/// "unconfigured" — it must NEVER blank the board or surface a parse error. The
/// strictness lives in the writer; the reader only has to survive data older or
/// foreigner than itself.
#[test]
fn next_slugs_that_is_not_a_json_array_reads_as_unconfigured() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-next-bad-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("bad-json");
    db.get_board(&space).expect("seed");

    for junk in ["not json", r#"{"a":1}"#, "42", r#"[1,2]"#] {
        db.conn
            .lock()
            .expect("db mutex poisoned")
            .execute(
                "UPDATE stages SET next_slugs = ?2 WHERE space_path = ?1 AND slug = 'backlog'",
                params![space, junk],
            )
            .expect("plant the foreign value");
        let board = db
            .get_board(&space)
            .expect("a bad cell must never blank the board");
        assert_eq!(board.len(), 5, "the whole board still arrives for {junk:?}");
        assert_eq!(
            board[0].stage.next_slugs, None,
            "`{junk:?}` reads as unconfigured, never as an error"
        );
    }
}

/// (Decision 6, the key-agreement pin) `Db::board_strict` reads back EXACTLY
/// what `set_board_strict` wrote, and both go through the SAME `space_key`
/// normalization the `move_task` gate uses. The interesting failure this pins is
/// the one the vet called out: a Strict Switch lit while drags are accepted.
///
/// The setup makes the two spellings differ ON PURPOSE: the `spaces` row is
/// keyed CANONICAL (what `upsert_space` stores) and the board rows are keyed by
/// the RAW spelling the caller happens to hold. A gate that read `spaces` by the
/// raw string would find no row, compute flag 0, and ACCEPT the illegal drag
/// while `board_strict(raw)` reports Strict ON — the Switch and the enforcement
/// disagreeing about the same Space.
#[test]
fn the_board_strict_read_and_the_move_gate_agree_on_a_non_canonical_path() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-key-", "scratch");
    let folder = dir.join("space folder");
    std::fs::create_dir_all(&folder).expect("the folder exists so canonicalize works");
    let canonical = std::fs::canonicalize(&folder)
        .expect("canonicalize")
        .display()
        .to_string();
    // The SAME folder, spelled through a `..` hop — a caller's raw string that
    // is not its own canonical form (a symlink or a `..` is exactly this).
    let raw = folder.join("..").join("space folder").display().to_string();

    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.upsert_space(&canonical, false)
        .expect("the row is keyed CANONICAL");
    db.set_board_strict(&raw, true)
        .expect("the toggle arrives with the RAW spelling");

    // The read normalizes, so both spellings answer the same thing.
    assert!(
        db.board_strict(&canonical).expect("read canonical"),
        "canonical sees the flag"
    );
    assert!(
        db.board_strict(&raw).expect("read raw"),
        "and so does the raw spelling — the read mirrors `set_space_trusted`'s \
         keying, it does not re-derive it differently"
    );

    // The enforcement agrees: the board rows are keyed RAW (that is what the
    // caller addressed), so the gate must still find the CANONICAL `spaces` row.
    db.get_board(&raw).expect("seed the raw-keyed board");
    db.set_stage_next(&raw, "backlog", &["done".to_string()])
        .expect("backlog → done only");
    let card = db
        .create_task(&raw, "governed through a symlink", None, None)
        .expect("create_task");

    let err = db
        .move_task(&raw, &card.id, "approved")
        .expect_err("the Switch is ON, so the gate must be ON too");
    assert!(
        matches!(err, BoardError::StrictMoveRefused { .. }),
        "the enforcement read the flag through `space_key`, got {err:?}"
    );
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "backlog",
        "and nothing was written"
    );
}

/// Record a Session (the FK on `task_sessions.session_id` requires the row to
/// exist before a link) and, when `cost` is `Some`, write its cost figure.
/// `None` leaves the column at NULL — "never reported", NOT zero.
fn record_linkable_session(db: &Db, id: &str, cwd: &str, cost: Option<f64>) {
    let mut info = title_session(id);
    info.cwd = std::path::PathBuf::from(cwd);
    db.record_session(&info)
        .expect("record_session (the link's FK target)");
    if let Some(total) = cost {
        db.record_session_cost(id, total)
            .expect("record_session_cost (a snapshot write)");
    }
}
