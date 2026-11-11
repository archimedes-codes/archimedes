//! issue #179's Stage-command tests — the WIRE half of the six Stage verbs and
//! the Strict-workflow pair.
//!
//! The storage half (`storage::db::tests`) pins what the database refuses and
//! what it writes. This file pins the one thing only this layer can get wrong:
//! that a refusal ARRIVES at the frontend as a `kind` it branches on and a
//! sentence it renders. `board.rs` sets the shape — `board_call` over an
//! `Ok::<_, …>(db.<call>)` (the join already succeeded, so the only layer left is
//! the storage one) and then `err.kind()` — because `tauri::State` cannot be
//! built in a unit test, exactly the reason `start_task_session_inner` exists.
//!
//! Module path spells `crate::commands::tasks::`, not `super::`: `super` here is
//! `tests`, not `tasks`.

use crate::commands::tasks::{board_call, db_call, stage_slug_from_label};
use crate::storage::{Db, DbError};

/// (spec §5) the label→slug derivation: lowercase, runs of anything outside
/// `[a-z0-9-]` collapse to ONE `-`, and a label with no slug characters derives
/// `""` — which `create_stage` refuses rather than writing a column nobody can
/// name.
#[test]
fn stage_slug_from_label_derives_a_lowercase_dashed_slug() {
    assert_eq!(stage_slug_from_label("Deep Dives!"), "deep-dives");
    assert_eq!(
        stage_slug_from_label("  Ready   To Ship  "),
        "ready-to-ship"
    );
    assert_eq!(stage_slug_from_label("Sprint 12"), "sprint-12");
    assert_eq!(
        stage_slug_from_label("Review — Blocked"),
        "review-blocked",
        "an em dash is not a slug character, and the space either side of it \
         collapses INTO the same run rather than making two dashes"
    );
    assert_eq!(
        stage_slug_from_label("already-a-slug"),
        "already-a-slug",
        "a hyphen survives, and a slug stays itself when the editor re-derives it"
    );
    assert_eq!(
        stage_slug_from_label("!!"),
        "",
        "a label with no slug characters derives the empty slug"
    );
    assert_eq!(stage_slug_from_label(""), "");
    assert_eq!(stage_slug_from_label("   "), "");
    assert_eq!(
        stage_slug_from_label("DISCUSS"),
        "discuss",
        "the label is LOWERCASED first and only then non-slug characters collapse \
         (spec §5's order) — an uppercase letter is a letter, not a separator, so \
         the word survives its capitalisation instead of losing its first letter"
    );
    assert_eq!(
        stage_slug_from_label("Backlog"),
        "backlog",
        "which is what makes a re-derived slug collide with the seeded one, so \
         `create_stage` refuses it rather than inventing `b-backlog`"
    );
}

/// (ADR 0090's rule, carried onto the new refusals) a Stage refusal reaches the
/// wire as `not_found` carrying the composed sentence — the frontend renders it
/// through `IpcErrorLine` and a model self-corrects from it, so both need the
/// valid slugs IN the message rather than in a second round trip.
#[test]
fn create_stage_refusals_reach_the_wire_naming_what_was_refused() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-stage-create-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-stage/create";
    db.get_board(space).expect("seed the six");

    let err = board_call(Ok::<_, String>(db.create_stage(
        space,
        "research",
        "Research Two",
        None,
    )))
    .expect_err("a taken slug is refused, never suffixed");
    assert_eq!(
        err.kind(),
        "not_found",
        "the wire kind the board branches on"
    );
    let message = err.to_string();
    assert!(
        message.contains("research"),
        "the message names the colliding slug, got `{message}`"
    );
    assert!(
        message.contains("backlog") && message.contains("done"),
        "and the slugs that ARE valid, got `{message}`"
    );
    assert!(
        !message.contains("research-2"),
        "the refusal must not offer a suffixed slug nobody typed, got `{message}`"
    );

    let empty = board_call(Ok::<_, String>(db.create_stage(
        space,
        "   ",
        "Ghost Column",
        None,
    )))
    .expect_err("an empty slug is refused");
    assert_eq!(empty.kind(), "not_found");
    assert!(empty.to_string().contains("empty slug"), "got `{empty}`");
}

/// (spec §4.1's three refusals) each one names its OWN evidence: the card count,
/// the Stage that points here, the last column's slug. A refusal that names
/// nothing is a dialog the user cannot act on.
#[test]
fn delete_stage_refusals_reach_the_wire_naming_what_was_refused() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-stage-del-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-stage/delete";
    db.get_board(space).expect("seed the six");

    // Refusal 1: the count.
    db.create_task(space, "one", None, Some("doing"))
        .expect("create");
    db.create_task(space, "two", None, Some("doing"))
        .expect("create");
    let err = board_call(Ok::<_, String>(db.delete_stage(space, "doing", None)))
        .expect_err("a Stage with cards is not deletable");
    assert_eq!(err.kind(), "not_found");
    let message = err.to_string();
    assert!(
        message.contains("2"),
        "the refusal counts the cards it is refusing, got `{message}`"
    );
    assert!(
        message.contains("done"),
        "and names where they could go, got `{message}`"
    );

    // Refusal 2: the pointing Stage.
    db.set_stage_next(space, "backlog", &["done".to_string()])
        .expect("backlog → done");
    let err = board_call(Ok::<_, String>(db.delete_stage(space, "done", None)))
        .expect_err("a referenced Stage is not deletable");
    assert_eq!(err.kind(), "not_found");
    let message = err.to_string();
    assert!(
        message.contains("backlog"),
        "the refusal names the Stage whose graph leads here, got `{message}`"
    );

    // Refusal 3: the last column.
    let solo = "/cmd-stage/solo";
    db.get_board(solo).expect("seed a second board");
    db.create_stage(solo, "only", "Only", None)
        .expect("create_stage");
    for slug in [
        "backlog", "discuss", "research", "approved", "doing", "done",
    ] {
        db.delete_stage(solo, slug, Some("only"))
            .expect("empty the seeded columns into `only`");
    }
    let err = board_call(Ok::<_, String>(db.delete_stage(solo, "only", None)))
        .expect_err("the last column is not deletable");
    assert_eq!(err.kind(), "not_found");
    assert!(
        err.to_string().contains("only"),
        "and it names the column it refused to delete, got `{err}`"
    );
}

/// (spec §4.2) a Strict refusal reaches the wire naming the legal destinations —
/// the sentence the card snaps back with. `store/tasks.ts` already reverts an
/// optimistic drag on rejection, so this message is the entire UI the feature
/// needs, and it is why every #179 refusal rides `not_found` rather than a new
/// kind nothing branches on.
#[test]
fn strict_move_refusals_reach_the_wire_naming_the_legal_destinations() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-stage-strict-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-stage/strict";
    db.upsert_space(space, false).expect("upsert_space");
    db.set_board_strict(space, true).expect("strict ON");
    db.get_board(space).expect("seed");
    db.set_stage_next(space, "backlog", &["discuss".to_string()])
        .expect("backlog → discuss only");
    let card = db
        .create_task(space, "governed", None, None)
        .expect("create_task");

    let err = board_call(Ok::<_, String>(db.move_task(space, &card.id, "done")))
        .expect_err("done is not an edge of backlog");
    assert_eq!(err.kind(), "not_found", "the kind the board reverts on");
    let message = err.to_string();
    assert!(
        message.contains("backlog") && message.contains("done"),
        "both stages are named, got `{message}`"
    );
    assert!(
        message.contains("discuss"),
        "and so is the destination the graph DOES allow, got `{message}`"
    );

    // A self-loop refusal, same family, same kind.
    let err = board_call(Ok::<_, String>(db.set_stage_next(
        space,
        "doing",
        &["doing".to_string()],
    )))
    .expect_err("a stage cannot lead to itself");
    assert_eq!(err.kind(), "not_found");
    assert!(err.to_string().contains("doing"), "got `{err}`");
}

/// (Decision 6, the wire guarantee T3's Switch seed relies on) `get_board_strict`
/// carries the storage `Result<bool, DbError>` across the `spawn_blocking` shape
/// untouched — `1` → `true`, `0` → `false`, and NO `spaces` row → `false`.
///
/// It goes through `db_call` and not `board_call`, because the storage call
/// answers `DbError`; the third case below is the one the Switch must not get
/// wrong, and it is asserted through the SAME helper the command body uses rather
/// than by reading the body and agreeing.
#[test]
fn get_board_strict_returns_the_primitive_bool_across_the_spawn_blocking_shape() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-stage-strict-read-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    let on = "/cmd-stage-strict/on";
    db.upsert_space(on, false).expect("upsert_space");
    db.set_board_strict(on, true).expect("strict ON");
    assert!(
        db_call(Ok::<_, String>(db.board_strict(on))).expect("read 1"),
        "`board_strict = 1` arrives as the primitive `true`"
    );

    let off = "/cmd-stage-strict/off";
    db.upsert_space(off, false).expect("upsert_space");
    db.set_board_strict(off, false).expect("strict OFF");
    assert!(
        !db_call(Ok::<_, String>(db.board_strict(off))).expect("read 0"),
        "`board_strict = 0` arrives as `false`"
    );

    // The case the whole read exists for: a Space with NO `spaces` row. The
    // board's own tests (`board_space`) never upsert one, so this is the ordinary
    // state, and it must read `false` — the identical answer `move_task`'s gate
    // computes, so the Switch can never light over a board that accepts drags.
    assert!(
        !db_call(Ok::<_, String>(db.board_strict("/cmd-stage-strict/no-row")))
            .expect("a missing row is Ok(false), not an error"),
        "a Space with no `spaces` row reads false"
    );

    // And a real failure maps to `other`, NOT to `not_found`: absence is a
    // `false` in this family, so anything that reaches the wire as an error is
    // the database (or the join) — never "the row is not there". Both of
    // `db_call`'s two layers are exercised, the same two the helper documents.
    let storage_failed = db_call(Ok::<_, String>(Err::<bool, _>(DbError::Io(
        std::io::Error::other("disk on fire"),
    ))));
    let err = storage_failed.expect_err("a DbError is still an error at the wire");
    assert_eq!(err.kind(), "other");
    assert!(err.to_string().contains("disk on fire"), "got `{err}`");

    let join_failed = db_call::<bool, DbError>(Err(DbError::Io(std::io::Error::other(
        "worker thread gone",
    ))));
    let err = join_failed.expect_err("a failed join is an error too");
    assert_eq!(
        err.kind(),
        "other",
        "the join layer maps to the same kind `board_call` gives it"
    );
    assert!(
        err.to_string().contains("worker thread gone"),
        "and keeps the sentence, got `{err}`"
    );
}

/// (spec §4.1's asymmetry — the five-compactions guard at the COMMAND layer)
/// `delete_stage` never calls `move_task`, and therefore can never fire a boost.
///
/// The storage test
/// `delete_stage_relocates_cards_with_one_update_without_touching_updated_at_or_on_enter`
/// pins the behaviour (the card moved, `updated_at` unmoved, no link created).
/// Reading code and agreeing is not a falsifier, so this pins the STRUCTURE two
/// ways, both of which a mutation breaks:
///
///   1. the source-text claim — `delete_stage`'s body contains no `move_task`
///      call, so a reviewer who "deduplicates" the relocation into `move_task`
///      reddens this before a user ever sees five compactions from one click;
///   2. the type claim — the command returns `()`. There is no `MoveOutcome` to
///      return, so the boost path is not merely unreached, it is unrepresentable
///      on this verb's signature.
#[test]
fn the_relocation_does_not_call_move_task() {
    let source = include_str!("../../tasks.rs");
    let body = {
        let start = source
            .find("pub async fn delete_stage(")
            .expect("delete_stage is defined in this file");
        let rest = &source[start..];
        // The body ends at the next top-level `#[tauri::command]` (or the A4
        // banner that closes the Stage block).
        let end = rest
            .find("#[tauri::command]")
            .or_else(|| rest.find("// ── A4"))
            .expect("the command block is delimited");
        &rest[..end]
    };
    assert!(
        !body.contains("db.move_task("),
        "`delete_stage` must NEVER call `move_task`: that verb reads the \
         destination's `on_enter` and this layer fires its boost, so a relocation \
         of N cards would attempt N compactions as bookkeeping (spec §4.1)"
    );
    assert!(
        !body.contains("compact_linked_session"),
        "and it must never reach the boost helper either — the same bug by a \
         different route"
    );
    assert!(
        body.contains("Result<(), TasksError>"),
        "the command returns `()`, so a `MoveOutcome` (and with it the boost \
         note) cannot be produced by this verb at all"
    );
    // The relocation lives in storage, where the bypass of the Strict gate costs
    // nothing — the reason the gate is in `Db::move_task` and not here.
    let db_source = include_str!("../../../storage/db.rs");
    let delete_body = {
        let start = db_source
            .find("pub fn delete_stage(")
            .expect("delete_stage is defined in db.rs");
        let rest = &db_source[start..];
        let end = rest
            .find("\n    /// The Strict-workflow toggle")
            .expect("the next method delimits the body");
        &rest[..end]
    };
    assert!(
        !delete_body.contains("self.move_task(") && !delete_body.contains("move_task("),
        "the storage relocation must be the bulk UPDATE, not a per-card `move_task`"
    );
    assert!(
        delete_body.contains("UPDATE tasks SET stage_slug"),
        "the relocation is exactly ONE bulk UPDATE (spec §4.1)"
    );
}

/// (the file's registration claim) all eight #179 commands are in
/// `lib.rs`'s `generate_handler!` list, inside the board block. `seed.rs` pins
/// this shape for `start_task_session` with the same source-text read, and the
/// claim this file's header makes ("SIXTEEN commands") is only true if every name
/// is actually wired — a missing entry is a command the webview cannot reach and
/// no Rust test would notice.
#[test]
fn the_eight_stage_commands_are_registered_in_the_invoke_handler() {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("src/lib.rs reads");
    for command in [
        "commands::tasks::create_stage",
        "commands::tasks::rename_stage",
        "commands::tasks::set_stage_skill",
        "commands::tasks::set_stage_next",
        "commands::tasks::reorder_stages",
        "commands::tasks::delete_stage",
        "commands::tasks::set_board_strict",
        "commands::tasks::get_board_strict",
    ] {
        assert!(
            lib.contains(command),
            "`{command}` is missing from lib.rs's generate_handler! list — the \
             webview reaches commands through that list alone"
        );
    }
}
