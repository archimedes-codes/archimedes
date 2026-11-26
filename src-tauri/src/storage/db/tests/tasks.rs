//! Tests for `db/tasks.rs`: the four task write verbs. The load-bearing ones are
//! ADR 0090's single-lock `create_task` rendezvous, the never-reused per-Space
//! `number`, the three-state `FieldPatch` edit, and the ADR 0099 Strict gate that
//! `move_task` enforces.

use crate::storage::db::*;

use super::support::*;

/// (ADR 0090) `number` is a per-Space, 1-based, never-reused label.
///
/// Three facts, one per assertion: the floor is `0` (the FIRST task in a Space
/// is `#1`, not `#0` — the DELIBERATE difference from this file's `sort_order`
/// `-1` join), the counter is per-Space, and a delete does NOT free a number
/// (reusing `#2` would silently re-point every historical mention of `T2`).
#[test]
fn create_task_numbers_are_per_space_and_1_based_and_never_reused() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-number-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = board_space("a");
    let b = board_space("b");

    let first = db.create_task(&a, "first", None, None).expect("create");
    assert_eq!(
        first.number, 1,
        "the FIRST task in a Space is `#1`: the `number` floor is 0 (ADR 0090), \
         NOT the `sort_order` idiom's -1"
    );
    let second = db.create_task(&a, "second", None, None).expect("create");
    assert_eq!(second.number, 2, "the second card is `#2`");

    let other = db.create_task(&b, "elsewhere", None, None).expect("create");
    assert_eq!(
        other.number, 1,
        "`number` is PER-Space — a second Space starts at `#1`"
    );

    // Never reused: with `#1, #2, #3` on the board, deleting the MIDDLE card
    // must not hand `#2` back to the next create — a fresh card is `#4`, and the
    // two survivors keep `#1` and `#3`. This is the half ADR 0090's "numbers are
    // never reused" that `MAX(number) + 1` can actually deliver, and A1 ships no
    // delete verb at all, so it is the whole reachable surface today. The
    // boundary (deleting the HIGHEST card does free its number) is documented on
    // `Db::create_task`, not asserted here — see the DEVIATION note.
    let third = db.create_task(&a, "third", None, None).expect("create");
    assert_eq!(third.number, 3);
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute("DELETE FROM tasks WHERE id = ?1", params![second.id])
        .unwrap();
    let fourth = db.create_task(&a, "fourth", None, None).expect("create");
    assert_eq!(
        fourth.number, 4,
        "a deleted card's number is not handed back — `#2` stays dead"
    );
    let survivors: Vec<i64> = db
        .list_tasks(&a)
        .expect("list_tasks")
        .iter()
        .map(|task| task.number)
        .collect();
    assert_eq!(
        survivors,
        vec![1, 3, 4],
        "the gap where `#2` was is VISIBLE, not renumbered away — re-pointing a          surviving card would be the same lie as reusing the number"
    );
}

/// (ADR 0090's rendezvous) `create_task` reads `MAX(number)` and inserts under
/// ONE `conn.lock()`, so N concurrent creates hand out N DISTINCT numbers.
///
/// This is the test the single lock is pinned by: with the read and the write
/// behind TWO separate locks, two threads can both read the same `MAX` and both
/// insert the same `number`. A `Barrier` makes the interleave likely rather
/// than theoretical — every thread is released on the same tick.
#[test]
fn create_task_reads_and_inserts_under_one_lock() {
    const N: usize = 12;
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-race-", "scratch");
    let db = std::sync::Arc::new(Db::open(&dir.join("t.db")).expect("db should open"));
    let space = board_space("race");
    let gate = std::sync::Barrier::new(N);

    let numbers: Vec<i64> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..N)
            .map(|i| {
                let db = db.clone();
                let space = space.clone();
                let gate = &gate;
                scope.spawn(move || {
                    gate.wait();
                    db.create_task(&space, &format!("racer {i}"), None, None)
                        .expect("create under contention")
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("thread").number)
            .collect()
    });

    let unique: std::collections::HashSet<i64> = numbers.iter().copied().collect();
    assert_eq!(
        unique.len(),
        N,
        "{N} concurrent creates must hand out {N} DISTINCT numbers; got {numbers:?}"
    );
    let mut sorted = numbers;
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        (1..=N as i64).collect::<Vec<i64>>(),
        "the numbers are exactly 1..={N} with no gap and no duplicate"
    );
}

/// (the drag verb) `move_task` writes `stage_slug` + touches `updated_at` and
/// reports the DESTINATION stage's `on_enter`; an unknown slug is `MissingStage`
/// naming the slugs that DO exist (ADR 0090: the message names the valid ones so
/// the caller self-corrects without a discovery round trip).
#[test]
fn move_task_updates_stage_slug_and_reports_the_destination_on_enter() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-move-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("move");
    let task = db
        .create_task(&space, "drag me", None, None)
        .expect("create");
    assert_eq!(
        task.stage_slug, "backlog",
        "with no stage given, a card lands in the FIRST stage"
    );

    let outcome = db
        .move_task(&space, &task.id, "doing", MoveAuthor::Person)
        .expect("move to a seeded stage");
    assert_eq!(
        outcome.on_enter, "none",
        "the destination's on_enter rides back to the caller — the COMMAND layer \
         decides what compaction to run, the storage layer never calls it"
    );

    let read = db
        .get_task(&task.id)
        .expect("get_task")
        .expect("the row exists");
    assert_eq!(read.stage_slug, "doing", "the stage moved");
    assert_eq!(read.number, task.number, "move_task never touches `number`");
    assert!(
        read.updated_at >= read.created_at,
        "`updated_at` is touched (>= created_at; a same-ms write may tie)"
    );

    let err = db
        .move_task(&space, &task.id, "nope", MoveAuthor::Person)
        .expect_err("an unknown stage slug is a rejection, not a silent write");
    let BoardError::MissingStage { available, .. } = &err else {
        panic!("the unknown-stage arm must be MissingStage; got {err:?}");
    };
    assert!(
        available.contains("doing") && available.contains("backlog"),
        "the rejection names the valid slugs (ADR 0090); got {available}"
    );
}

/// (`on_enter` is data, read AFTER the write) a stage row carrying
/// `on_enter = 'compact'` reports it, so the command layer can run the boost.
#[test]
fn move_task_reports_a_compact_stage_so_the_command_can_boost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-compact-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("compact");
    db.get_board(&space).expect("seed");
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "UPDATE stages SET on_enter = 'compact' WHERE space_path = ?1 AND slug = 'doing'",
            params![space],
        )
        .unwrap();
    let task = db
        .create_task(&space, "boost me", None, None)
        .expect("create");

    let outcome = db
        .move_task(&space, &task.id, "doing", MoveAuthor::Person)
        .expect("move into the compact stage");
    assert_eq!(outcome.on_enter, "compact");
}

/// (`edit_task`) the `FieldPatch::Keep` patch writes ONLY the fields it is given, and
/// never the position or the label — `move_task` owns the stage, `number` is
/// never renumbered, and within-column position is a human concern (spec §3).
#[test]
fn edit_task_writes_only_the_fields_it_is_given() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("edit");
    let task = db
        .create_task(&space, "original", Some("body one"), None)
        .expect("create");

    let edited = db
        .edit_task(
            &task.id,
            FieldPatch::Set("renamed"),
            FieldPatch::Keep,
            FieldPatch::Set("docs/x.md"),
        )
        .expect("edit_task");
    assert_eq!(edited.title, "renamed", "the title is written");
    assert_eq!(
        edited.body.as_deref(),
        Some("body one"),
        "a kept body keeps the stored one (Keep, not an overwrite with NULL)"
    );
    assert_eq!(
        edited.spec_path.as_deref(),
        Some("docs/x.md"),
        "spec_path is written"
    );
    assert_eq!(
        edited.stage_slug, task.stage_slug,
        "edit_task NEVER touches the stage — that is move_task's job"
    );
    assert_eq!(
        edited.number, task.number,
        "edit_task never touches the number"
    );
    assert_eq!(
        edited.sort_order, task.sort_order,
        "edit_task never touches the position"
    );

    let err = db
        .edit_task(
            "tsk_missing",
            FieldPatch::Set("x"),
            FieldPatch::Keep,
            FieldPatch::Keep,
        )
        .expect_err("editing a Task that does not exist is a rejection");
    assert!(matches!(err, BoardError::MissingTask(_)), "got {err:?}");
}

/// (`edit_task`) `FieldPatch::Clear` writes NULL.
///
/// The whole reason the patch type exists. Under the old `Option<&str>` +
/// `COALESCE` statement `NULL` meant "leave it alone", so no value a caller
/// could send blanked a column — and a card could never stop naming a deleted
/// file (`finish` deletes `docs/roadmap/*` on ship, ADR 0100), leaving a
/// permanently dangling link.
#[test]
fn edit_task_can_clear_body_and_spec_path_to_null() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("clear");
    let task = db
        .create_task(&space, "kept title", Some("body one"), None)
        .expect("create");
    db.edit_task(
        &task.id,
        FieldPatch::Keep,
        FieldPatch::Keep,
        FieldPatch::Set("docs/gone.md"),
    )
    .expect("plant a spec_path");

    let cleared = db
        .edit_task(
            &task.id,
            FieldPatch::Keep,
            FieldPatch::Clear,
            FieldPatch::Clear,
        )
        .expect("edit_task");

    assert!(
        cleared.body.is_none(),
        "`Clear` writes NULL, not an empty string — body came back {:?}",
        cleared.body
    );
    assert!(
        cleared.spec_path.is_none(),
        "`Clear` writes NULL, not an empty string — spec_path came back {:?}",
        cleared.spec_path
    );
    assert_eq!(
        cleared.title, "kept title",
        "the same call leaves a `Keep` column exactly as it was"
    );
}

/// (`edit_task`) the three-state proof: NOT sending a field and sending an
/// explicit clear are DIFFERENT answers.
///
/// This test could not exist before `FieldPatch` — with `Option<&str>` +
/// `COALESCE` there was only one state to observe, which is precisely the
/// defect. It is the plan's falsifier: if it passes without `FieldPatch`, the
/// third state was reachable some other way and this work is unnecessary.
///
/// The `Keep` call also pins the unconditional `updated_at` stamp: an
/// all-`Keep` patch writes no column but still moves the clock, exactly as the
/// `COALESCE` statement did. The timestamp is PLANTED old rather than trusted,
/// for the reason `delete_stage_relocates_cards…` gives — a same-ms write would
/// otherwise turn this assert green by accident.
#[test]
fn an_omitted_field_and_a_cleared_field_are_different_answers() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("threestate");
    let task = db
        .create_task(&space, "a title", Some("a body"), None)
        .expect("create");
    db.edit_task(
        &task.id,
        FieldPatch::Keep,
        FieldPatch::Keep,
        FieldPatch::Set("docs/spec.md"),
    )
    .expect("plant a spec_path");

    // ── `Keep`: the stored value survives untouched ──────────────────────────
    const PLANTED: i64 = 1000;
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
            params![PLANTED, task.id],
        )
        .expect("plant the old timestamp");

    let kept = db
        .edit_task(
            &task.id,
            FieldPatch::Keep,
            FieldPatch::Keep,
            FieldPatch::Keep,
        )
        .expect("an all-Keep patch is a legal call");
    assert_eq!(kept.title, "a title", "`Keep` leaves `title` alone");
    assert_eq!(
        kept.body.as_deref(),
        Some("a body"),
        "`Keep` leaves `body` alone"
    );
    assert_eq!(
        kept.spec_path.as_deref(),
        Some("docs/spec.md"),
        "`Keep` leaves `spec_path` alone — this is the state the old `None` meant"
    );
    assert!(
        kept.updated_at > PLANTED,
        "`updated_at` is stamped UNCONDITIONALLY as before: {} must be later than \
         the planted {}",
        kept.updated_at,
        PLANTED
    );

    // ── `Clear`: the SAME verb, the SAME column, a different answer ──────────
    let cleared = db
        .edit_task(
            &task.id,
            FieldPatch::Keep,
            FieldPatch::Keep,
            FieldPatch::Clear,
        )
        .expect("edit_task");
    assert_eq!(
        cleared.title, kept.title,
        "the field the call kept is still untouched"
    );
    assert_eq!(
        cleared.body, kept.body,
        "the field the call kept is still untouched"
    );
    assert!(
        cleared.spec_path.is_none(),
        "`Clear` nulls the very column `Keep` preserved — two states, not one: {:?}",
        cleared.spec_path
    );
}

/// (`edit_task`) the `touched == 0` instrument does not misfire on a no-op
/// clear.
///
/// `edit_task` is the ONLY board write that refuses AFTER the write — every
/// other one (`move_task`'s stage gate, `create_task`'s number) checks first and
/// writes nothing when it refuses. That asymmetry is affordable only because
/// `touched == 0` means exactly one thing here: no row matched `WHERE id`. So it
/// must stay true when an UPDATE re-sets a column to the value it already holds,
/// which is what clearing an already-NULL column is. SQLite reports rowcount 1
/// for such a statement; this pins it against THIS crate's bundled rusqlite
/// rather than against a Python binding's reading of it.
///
/// A misfire would be a nasty one: the card exists, and the command layer is
/// told it is gone.
#[test]
fn edit_task_clearing_an_already_null_column_is_not_reported_as_a_missing_task() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("nullclear");
    // `create_task` stores `body` = NULL and `spec_path` = NULL, so BOTH clear
    // targets start already-NULL — no planting needed.
    let task = db
        .create_task(&space, "nothing to clear", None, None)
        .expect("create");
    assert!(task.body.is_none() && task.spec_path.is_none());

    let cleared = db
        .edit_task(
            &task.id,
            FieldPatch::Keep,
            FieldPatch::Clear,
            FieldPatch::Clear,
        )
        .expect("clearing an already-NULL column is NOT a missing Task");

    assert!(
        cleared.body.is_none() && cleared.spec_path.is_none(),
        "and the answer is the row as stored"
    );
    assert_eq!(
        db.get_task(&task.id)
            .expect("get_task")
            .expect("the card is still there")
            .id,
        task.id,
        "the card was never gone — `touched` counted the UPDATE, not a change"
    );
}

/// (the title rule, AT STORAGE) every title that `clean_title` cleans to nothing
/// is refused by `Db::create_task` itself, and a refusal writes NO ROW.
///
/// THE RULE'S HOME MOVED. This used to be a command-layer-only refusal, which was
/// safe with one door and false with two: `impl TaskStore for Db` delegates
/// straight to this method, `tasks.title` is `TEXT NOT NULL` with no `CHECK`, and
/// so `TaskCall::CreateTask` could write a card labelled `""` that a human could
/// not. `TaskCard.tsx` renders `{task.title}` with no fallback anywhere in `src/`,
/// so the consequence of a row like that is a card showing a number, a timestamp
/// and no sentence.
///
/// The five inputs are the whole reachable set, and the last two are the trap:
/// `trim().is_empty()` is `false` for `"\"\""` and `"''"` — they are non-empty
/// until the quote layer strips, and only then clean to nothing. `commands/tasks/
/// tests/board.rs` names those two "the reachable ones"; a predicate written from
/// `is_empty` alone would let both through and write a card labelled with a bare
/// quote pair.
///
/// "Writes NOTHING" is asserted against the DATABASE through an independent
/// connection, not against what this method chose to return — the `artifact_rows`
/// idiom in this file. A method that refused and still inserted would pass a
/// return-value assertion.
///
/// MUTATION: delete the `clean_title` call in `Db::create_task` and every
/// `expect_err` here reddens with `Ok(row)`; leave a `trim().is_empty()` predicate
/// in its place and only the two quote cases redden, which is exactly the partial
/// fix this list exists to refuse.
#[test]
fn db_create_task_refuses_every_title_that_cleans_to_nothing_and_writes_no_row() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-refuse-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let space = board_space("refuse");

    for raw in ["", "   ", "\n\t \n", "\"\"", "''"] {
        let err = db
            .create_task(&space, raw, Some("a body"), None)
            .expect_err(
                "`{raw:?}` cleans to nothing, so storage must refuse it — \
                         the model's door reaches this method directly and there is \
                         no CHECK on tasks.title to catch it",
            );
        assert!(
            matches!(err, BoardError::EmptyTitle),
            "for {raw:?}: the refusal is `EmptyTitle`, not a downstream sqlite error; \
             got {err:?}"
        );
    }

    assert_eq!(
        task_rows(&path).len(),
        0,
        "a rejection writes NOTHING — five refused creates, zero rows; got {:?}",
        task_rows(&path)
    );
}

/// (the title rule, AT STORAGE) the CLEANED title is what lands in the column, on
/// the storage door — including the uncapped case.
///
/// Three facts, one per assertion: whitespace runs collapse and the ends trim, ONE
/// matching quote layer strips, and a long title survives WHOLE. The third is the
/// property the command layer used to pin (`a_long_task_title_is_kept_whole_and_
/// never_cut_at_the_session_namer_cap`); it is re-pointed here because the cleaner
/// now runs HERE, so a test that asked the command about it would be asking the
/// layer that no longer decides. `max_chars: None` is a decision about the CALL
/// SITE and storage is the call site that matters.
#[test]
fn db_create_task_stores_the_cleaned_title() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-clean-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("clean");

    let padded = db
        .create_task(&space, "  Foo   Bar  ", None, None)
        .expect("a padded title is a legal title");
    assert_eq!(
        padded.title, "Foo Bar",
        "whitespace runs collapse and the ends trim — the shared chain, now run by \
         the layer that stores the answer"
    );

    let quoted = db
        .create_task(&space, "\"thing\"", None, None)
        .expect("a quoted title is a legal title");
    assert_eq!(
        quoted.title, "thing",
        "one layer of matching quotes strips, so the card is not labelled with a \
         quote pair the model wrapped its answer in"
    );

    // 132 chars, the real card ADR 0101 records. The session namer's 80-char cut
    // is pi parity on a title a MODEL invented; a card's title is the user's own
    // sentence and `tasks.title` has nowhere to put an overflow, so a cut here
    // would destroy text with no way back.
    let long = "What is the default action for notifications, i want to be able to click a notification and have it open the session that raised it";
    assert!(
        long.chars().count() > 80,
        "the fixture must exceed the session namer's 80-char cap or this proves nothing"
    );
    let uncapped = db
        .create_task(&space, long, None, None)
        .expect("a long title is a legal title");
    assert_eq!(
        uncapped.title, long,
        "the user's sentence is stored whole — Task titles are NOT capped"
    );
    assert_eq!(uncapped.title.chars().count(), long.chars().count());
}

/// (THE NON-IDEMPOTENCY PIN) a title is cleaned ONCE, not twice.
///
/// This is the test that pins the hazard the whole design turns on, and it is the
/// reason the command layer had to STOP cleaning.
///
/// `clean_title` is not idempotent, measured: the trim runs before the quote strip
/// because that is pi's chain order (`replace(/\s+/g," ").trim().replace(quoteRe)`),
/// so `"  \" Foo \"  "` cleans to `" Foo "` ONCE and `"Foo"` TWICE — the second
/// pass sees a stripped ` Foo ` whose ends it can trim, which the first pass could
/// not reach because the quotes were in the way. A quote pair that wraps inner
/// spaces therefore keeps those spaces, exactly as pi does.
///
/// So the clean may happen at exactly one layer. With both layers cleaning, a
/// human's quote-padded title silently changes and NOTHING catches it: no test
/// compares the two, and the stored value is plausible either way. `" Foo "` is the
/// answer that proves one cleaner ran; `"Foo"` is the answer that proves the
/// command layer is still cleaning on the way down.
///
/// MUTATION: not from the command side. This drives `Db::create_task` on a raw
/// handle and cannot see `commands::tasks::create_task`, so it pins the STORAGE
/// half only: one clean, `" Foo "` in the row.
///
/// The command layer's not-cleaning IS pinned — on the EDIT door, not this one.
/// `require_title` returns `Result<(), TasksError>`, so no value survives for a
/// caller to re-clean, and `patch_title`'s raw `Option<&str>` is pinned raw by
/// `commands/tasks/tests/board.rs`'s `Some("  Porting   the board  ")`.
///
/// The CREATE door is UNPINNED, and that is a disclosed gap, not a covered
/// property: no test drives `commands::tasks::create_task` end-to-end and reads
/// the stored title back, so a clean re-added there stores `"Foo"` and the whole
/// suite — this test included — stays green.
#[test]
fn a_title_is_cleaned_once_not_twice() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-once-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("once");

    let task = db
        .create_task(&space, "  \" Foo \"  ", None, None)
        .expect("a quote-padded title is a legal title");

    assert_eq!(
        task.title, " Foo ",
        "ONE clean: the trim runs before the quote strip (pi's chain order), so the \
         inner spaces survive the strip. A stored `\"Foo\"` here means TWO cleans ran \
         and the human's title was silently rewritten — got {:?}",
        task.title
    );
    assert_eq!(
        task_rows(&dir.join("t.db"))
            .into_iter()
            .map(|(_id, title, _body)| title)
            .collect::<Vec<_>>(),
        vec![" Foo ".to_string()],
        "and the DATABASE holds the once-cleaned value, not what a method reported"
    );
}

/// (the title rule, on the EDIT verb) `FieldPatch::Set` of a title that cleans to
/// nothing is refused and the STORED title is untouched.
///
/// The defect was on TWO verbs, not one: `TaskCall::EditTask { title:
/// Some("") }` is a fully expressible `FieldPatch::Set("")`, and `edit_task`'s
/// fixed-arity `CASE` writes `''` into the column with no complaint from SQLite —
/// so the model's door could blank a card's label on a card that already had a
/// good one. That is worse than the create case: it destroys a title a person typed.
///
/// The refusal must happen BEFORE the `UPDATE`, so "the stored title is unchanged"
/// is the assertion that distinguishes refuse-before-write from write-then-check.
/// `edit_task` is otherwise the ONE board write that checks after the statement (the
/// `touched == 0` rule), and that stays true — it just cannot be reached by a title
/// this layer refuses.
///
/// MUTATION: move the clean below the `conn.lock()` and after the `execute` and the
/// `expect_err` still passes while the second assertion reddens — which is why both
/// are here.
#[test]
fn db_edit_task_refuses_a_title_that_cleans_to_nothing_and_leaves_the_stored_title() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-edit-refuse-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("edit-refuse");
    let task = db
        .create_task(&space, "a title worth keeping", Some("a body"), None)
        .expect("create");

    for raw in ["", "   ", "\n\t \n", "\"\"", "''"] {
        let err = db
            .edit_task(
                &task.id,
                FieldPatch::Set(raw),
                FieldPatch::Keep,
                FieldPatch::Keep,
            )
            .expect_err(
                "`{raw:?}` cleans to nothing, so the edit door must refuse it \
                         too — the CASE statement would otherwise write it",
            );
        assert!(
            matches!(err, BoardError::EmptyTitle),
            "for {raw:?}: got {err:?}"
        );
    }

    let stored = db
        .get_task(&task.id)
        .expect("get_task")
        .expect("the card is still there");
    assert_eq!(
        stored.title, "a title worth keeping",
        "five refused edits and the label is exactly what it was — refused BEFORE \
         the statement, not written and then complained about"
    );
    assert_eq!(
        stored.body.as_deref(),
        Some("a body"),
        "and a refused title writes no other column either"
    );
}

/// (the edit verb, the other two states) a `Set` title is stored CLEANED and a
/// `Keep` title writes nothing.
///
/// `Keep` matters as much as `Set`: omitting the field must not be the same act as
/// blanking it, so a `Keep` never reaches the cleaner at all. The stored value after
/// the `Keep` is the proof — if a `Keep` were routed through `clean_title` the
/// title would come back `"a b"`-shaped rather than the string the create stored.
#[test]
fn db_edit_task_stores_the_cleaned_title_and_keep_writes_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("edit-clean");
    let task = db
        .create_task(&space, "original", Some("body one"), None)
        .expect("create");

    let edited = db
        .edit_task(
            &task.id,
            FieldPatch::Set("  a   b  "),
            FieldPatch::Keep,
            FieldPatch::Keep,
        )
        .expect("edit_task");
    assert_eq!(
        edited.title, "a b",
        "a Set title is stored cleaned, by the same call the create door makes"
    );

    let kept = db
        .edit_task(
            &task.id,
            FieldPatch::Keep,
            FieldPatch::Keep,
            FieldPatch::Keep,
        )
        .expect("an all-Keep patch is legal");
    assert_eq!(
        kept.title, "a b",
        "`Keep` leaves the stored value exactly as it is — it does not re-clean it"
    );
}

/// (`get_task`) a missing id is `Ok(None)` — the `find_space` shape: a read of
/// a card that was deleted is an answer, not an error.
#[test]
fn get_task_on_a_missing_id_is_ok_none() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-get-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    assert_eq!(
        db.get_task("tsk_nope").expect("get_task"),
        None,
        "a missing row is Ok(None)"
    );
}

/// (cards join at the BOTTOM) `sort_order` keeps this file's `-1` idiom — the
/// deliberate sibling of `number`'s `0` floor: a position index is zero-based,
/// a user-visible label is one-based.
#[test]
fn create_task_sort_order_is_zero_based_where_number_is_one_based() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-task-order-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("orders");
    let first = db.create_task(&space, "first", None, None).expect("create");
    let second = db
        .create_task(&space, "second", None, None)
        .expect("create");
    assert_eq!(
        (first.sort_order, first.number),
        (0, 1),
        "the FIRST card is position 0 with label #1 — the two idioms differ ON PURPOSE"
    );
    assert_eq!(
        (second.sort_order, second.number),
        (1, 2),
        "both climb together, from their own floors"
    );
}

/// (ADR 0099's default) with no `spaces` row the board behaves EXACTLY as it did
/// before this feature: a non-edge drag is accepted. This is the assertion that
/// an upgrade changes nothing for the Spaces the board tests model.
#[test]
fn move_task_with_no_spaces_row_is_not_strict() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-norow-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-absent");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["done".to_string()], &[None])
        .expect("backlog → done only");
    let card = db
        .create_task(&space, "free card", None, None)
        .expect("create_task");

    let outcome = db
        .move_task(&space, &card.id, "approved", MoveAuthor::Person)
        .expect("no spaces row → flag 0 → the check is skipped entirely");
    assert_eq!(outcome.on_enter, "none");
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "approved"
    );
}

/// (ADR 0099's whole reason for being opt-in) `board_strict = 0` is the DEFAULT,
/// so upgrading cannot change how an existing board answers a drag.
#[test]
fn move_task_with_board_strict_zero_accepts_a_non_edge_move() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-off-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-off");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, false).expect("explicitly off");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["done".to_string()], &[None])
        .expect("backlog → done only");
    let card = db
        .create_task(&space, "unconstrained", None, None)
        .expect("create_task");

    db.move_task(&space, &card.id, "approved", MoveAuthor::Person)
        .expect("flag 0 skips the check entirely");
}

/// (spec §4.2) under `board_strict = 1`, a drag that is not an edge of the FROM
/// Stage's graph is refused BEFORE the write, and the sentence names the legal
/// destinations — the frontend's optimistic revert needs nothing more.
#[test]
fn move_task_with_board_strict_one_refuses_a_non_edge_move_naming_the_legal_destinations() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-on-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-on");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, true).expect("strict ON");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["done".to_string()], &[None])
        .expect("backlog → done, and nothing else");
    let card = db
        .create_task(&space, "governed card", None, None)
        .expect("create_task");

    let err = db
        .move_task(&space, &card.id, "approved", MoveAuthor::Person)
        .expect_err("approved is not an edge of backlog");
    match err {
        BoardError::StrictMoveRefused { from, to, allowed } => {
            assert_eq!(from, "backlog", "the FROM stage is named");
            assert_eq!(to, "approved");
            assert_eq!(allowed, "done", "and so are the legal destinations");
        }
        other => panic!("expected StrictMoveRefused, got {other:?}"),
    }
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "backlog",
        "a refused move writes NOTHING"
    );

    // The legal edge, same configuration.
    db.move_task(&space, &card.id, "done", MoveAuthor::Person)
        .expect("the configured edge is accepted");
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "done"
    );
}

/// (spec §4.2 + ADR 0099's NULL rule) `NULL` means UNCONFIGURED, not forbidden.
/// Under Strict, a Stage with no graph still accepts anything — otherwise every
/// existing board that opts in would refuse every drag.
#[test]
fn move_task_with_board_strict_one_and_null_next_slugs_accepts_any_move() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-null-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-null");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, true).expect("strict ON");
    db.get_board(&space)
        .expect("seed — every next_slugs is NULL");
    let card = db
        .create_task(&space, "unconfigured board", None, None)
        .expect("create_task");

    db.move_task(&space, &card.id, "done", MoveAuthor::Person)
        .expect("NULL next_slugs passes unconditionally");
    db.move_task(&space, &card.id, "research", MoveAuthor::Person)
        .expect("and it passes in both directions — position is not adjacency");
}

/// (ADR 0099's explicit consequence) an explicit `[]` under Strict is NOT the
/// same as NULL: it is a configured graph with no edges, so every move out of
/// that Stage is refused and the sentence says so instead of listing nothing.
#[test]
fn move_task_with_board_strict_one_and_an_empty_graph_refuses_everything() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-strict-empty-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("strict-empty");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, true).expect("strict ON");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &[], &[])
        .expect("an explicit no-edge graph");
    let card = db
        .create_task(&space, "boxed in", None, None)
        .expect("create_task");

    let err = db
        .move_task(&space, &card.id, "done", MoveAuthor::Person)
        .expect_err("a configured graph with no edges allows nothing");
    match err {
        BoardError::StrictMoveRefused { allowed, .. } => {
            assert!(
                !allowed.is_empty(),
                "the sentence must say WHY there are no destinations, got \
                 `{allowed}` — an empty list reads like a bug"
            );
        }
        other => panic!("expected StrictMoveRefused, got {other:?}"),
    }
}

/// (D7 + D15, the acceptance case) on a SEEDED, UNCONFIGURED Space a model's
/// `backlog → done` is refused, and the same call from a person moves the card.
///
/// THE MOST IMPORTANT TEST IN THE FILE, because it is the one the whole gate was
/// written for and the one an inert implementation passes silently. `get_board`
/// seeds five columns with `next_slugs` NULL — the state of every Space the app
/// itself ever creates — so without the `sort_order + 1` fallback the reachability
/// walk sees an empty edge set, refuses nothing, and every assertion here that
/// expects a refusal goes red. It is also the ONLY place the two doors are compared
/// on IDENTICAL arguments, which is what makes `MoveAuthor` the whole difference:
/// same Space, same card, same destination, and the author is the only input that
/// changes.
///
/// The refusal is checked against the DATABASE and not only against the return
/// value: a gate that raised the error AFTER the `UPDATE` would answer correctly and
/// still move the card, which is the refuse-before-write rule every other check in
/// `move_task` follows.
#[test]
fn a_model_cannot_move_a_card_forward_on_a_seeded_board_and_a_person_can() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-forward-default-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("forward-default");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space)
        .expect("seed — every next_slugs is NULL, exactly as a fresh install has it");
    let card = db
        .create_task(&space, "the default board", None, None)
        .expect("create_task");

    let err = db
        .move_task(&space, &card.id, "done", MoveAuthor::Model)
        .expect_err("`done` is reachable from `backlog` through the fallback chain");
    match err {
        BoardError::ForwardMoveRefused { task_id, from, to } => {
            assert_eq!(task_id, card.id, "the refusal names the card it refused");
            assert_eq!(from, "backlog", "and the origin");
            assert_eq!(to, "done", "and the destination");
        }
        other => panic!("expected ForwardMoveRefused, got {other:?}"),
    }
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "backlog",
        "a refused forward move writes NOTHING"
    );

    // The person's door, SAME arguments. D11: the gate is on the door, not on the
    // destination, and a human drag is never its subject.
    db.move_task(&space, &card.id, "done", MoveAuthor::Person)
        .expect("a person moves the same card to the same column");
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "done",
        "and it lands where they dragged it"
    );
}

/// (D10) a model's BACKWARD move is allowed and inert.
///
/// The forward gate answers a graph question and a backward edge is not forward, so
/// the door stays open. `on_enter` still rides back — "inert" means the GATE is
/// inert, not that the verb stops reporting, and the command layer's boost is
/// unchanged for a model's backward drag.
#[test]
fn a_model_moves_a_card_backward_and_the_forward_gate_says_nothing() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-forward-back-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("forward-back");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "already downstream", None, Some("doing"))
        .expect("create_task");

    let outcome = db
        .move_task(&space, &card.id, "backlog", MoveAuthor::Model)
        .expect("backward is not forward — the fallback chain is directional");
    assert_eq!(outcome.on_enter, "none", "the verb still reports on_enter");
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "backlog",
        "and the move happened"
    );
}

/// (`from == to`) a model's move to the column the card is ALREADY in is not
/// forward, so it is allowed and the existing behaviour stands.
#[test]
fn a_model_moving_a_card_to_its_own_column_is_not_a_forward_move() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-forward-self-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("forward-self");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "stays put", None, None)
        .expect("create_task");

    db.move_task(&space, &card.id, "backlog", MoveAuthor::Model)
        .expect("a round trip through the graph is not a forward move");
}

/// (D8's skip-hole case, an acceptance criterion) on a Space configured so the
/// graph dead-ends before `done`, a model's `backlog → done` is ALLOWED.
///
/// The mirror of the default-board refusal above, and the one that proves the gate
/// is a graph test and not a `sort_order` comparison in disguise: the destination is
/// four columns to the RIGHT and it is allowed, because no path leads there. Every
/// row is configured here because the fallback is per row — a NULL tail would
/// contribute its order neighbour and make `done` reachable after all.
/// [`super::edges`] owns the walk-level pin; this one owns the VERB's answer.
#[test]
fn a_model_moves_a_card_to_an_unreachable_column_on_a_configured_board() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-forward-skip-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("forward-skip");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["research".to_string()], &[None])
        .expect("backlog → research");
    db.set_stage_next(&space, "research", &["approved".to_string()], &[None])
        .expect("research → approved");
    db.set_stage_next(&space, "approved", &["doing".to_string()], &[None])
        .expect("approved → doing");
    db.set_stage_next(&space, "doing", &[], &[])
        .expect("doing leads nowhere, so nothing reaches `done`");
    let card = db
        .create_task(&space, "the long skip", None, None)
        .expect("create_task");

    db.move_task(&space, &card.id, "done", MoveAuthor::Model)
        .expect("`done` is unreachable, so the move is not forward (D8)");
    assert_eq!(
        db.get_task(&card.id)
            .expect("get_task")
            .expect("card")
            .stage_slug,
        "done",
        "and it landed"
    );
}

/// (`[]` refuses nothing) a model's move OUT of a column configured to lead nowhere
/// is allowed — an empty graph reaches nothing, so nothing is forward.
#[test]
fn a_model_moves_a_card_out_of_a_column_with_an_explicitly_empty_graph() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-forward-empty-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("forward-empty");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &[], &[])
        .expect("an explicit no-edge graph");
    let card = db
        .create_task(&space, "boxed in on the graph", None, None)
        .expect("create_task");

    db.move_task(&space, &card.id, "done", MoveAuthor::Model)
        .expect(
            "`[]` is configured and closed, so nothing is reachable and nothing \
                 is forward — this is NOT the Strict gate, which reads the same `[]` \
                 and refuses everything",
        );
}

/// (a `NULL` origin on the LAST column refuses nothing) a model's move out of `done`
/// is allowed: the fallback has no `sort_order + 1` neighbour to offer.
#[test]
fn a_model_moves_a_card_out_of_the_last_column_of_a_null_board() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-forward-last-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("forward-last");
    db.upsert_space(&space, false).expect("upsert_space");
    db.get_board(&space).expect("seed");
    let card = db
        .create_task(&space, "at the end", None, Some("done"))
        .expect("create_task");

    db.move_task(&space, &card.id, "backlog", MoveAuthor::Model)
        .expect("`done` points nowhere, so nothing leaving it is forward");
}

/// (TWO GATES, TWO ANSWERS — pinned side by side, exactly as D15 requires) on a
/// `NULL` origin with `board_strict = 1`, the Strict gate still PASSES and the
/// forward gate still REFUSES.
///
/// These are different questions and the pair is the pin that keeps them from being
/// collapsed into one helper: Strict asks "is this a DECLARED edge" and a `NULL` row
/// is unconstrained (ADR 0099 — the opposite reading makes every board that opts in
/// refuse every drag), while the forward gate asks "is this REACHABLE" and a `NULL`
/// row still has the shape the column order implies. A reader who "deduplicates" one
/// into the other reddens HERE, on the one configuration where the two disagree.
#[test]
fn strict_and_forward_are_two_gates_and_answer_a_null_board_differently() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-forward-two-gates-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("forward-two-gates");
    db.upsert_space(&space, false).expect("upsert_space");
    db.set_board_strict(&space, true).expect("strict ON");
    db.get_board(&space)
        .expect("seed — every next_slugs is NULL");
    let card = db
        .create_task(&space, "both gates see this", None, None)
        .expect("create_task");

    // Gate 1 passes: NULL is unconstrained under Strict, so nothing here is
    // `StrictMoveRefused` — which is what the `match` below refuses to be.
    let err = db
        .move_task(&space, &card.id, "done", MoveAuthor::Model)
        .expect_err("but the forward gate fires on the fallback chain anyway");
    match err {
        BoardError::ForwardMoveRefused { from, to, .. } => {
            assert_eq!((from.as_str(), to.as_str()), ("backlog", "done"));
        }
        other => panic!(
            "Strict must PASS a NULL origin (ADR 0099) and the forward gate must \
             refuse it (D15) — anything else means the two gates were collapsed. \
             Got {other:?}"
        ),
    }

    // And the person's door on the SAME board with Strict still ON: neither gate
    // binds a human here, so the move goes through.
    db.move_task(&space, &card.id, "done", MoveAuthor::Person)
        .expect("Strict is the only gate a person meets, and NULL passes it");
}

/// Every `tasks` row, read through an INDEPENDENT connection to the same file
/// (the `artifact_rows` idiom in [`super::support`], applied to the card table):
/// the
/// title-rule tests below assert that a refusal wrote NO row and that an accepted
/// row carries the CLEANED text, and both are facts about the DATABASE — not about
/// what a `Db` method chose to report. A `create_task` that inserted and then
/// returned an `Err` would pass every return-value assertion in the file.
fn task_rows(db_path: &std::path::Path) -> Vec<(String, String, Option<String>)> {
    let conn = rusqlite::Connection::open(db_path).expect("an independent connection");
    let mut stmt = conn
        .prepare("SELECT id, title, body FROM tasks ORDER BY rowid ASC")
        .expect("prepares");
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("queries");
    rows.collect::<Result<_, _>>().expect("maps")
}
