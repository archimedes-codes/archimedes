//! issue #179's Stage-command tests — the WIRE half of the eight Stage verbs
//! (the six of #179 plus the two workflow columns) and the Strict-workflow pair.
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

use crate::commands::tasks::{board_call, db_call, require_position_pair, stage_slug_from_label};
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
    db.get_board(space).expect("seed the five");

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
    db.get_board(space).expect("seed the five");

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
    db.set_stage_next(space, "backlog", &["done".to_string()], &[None])
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
    for slug in ["backlog", "research", "approved", "doing", "done"] {
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
    db.set_stage_next(space, "backlog", &["research".to_string()], &[None])
        .expect("backlog → research only");
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
        message.contains("research"),
        "and so is the destination the graph DOES allow, got `{message}`"
    );

    // A self-loop refusal, same family, same kind.
    let err = board_call(Ok::<_, String>(db.set_stage_next(
        space,
        "doing",
        &["doing".to_string()],
        &[None],
    )))
    .expect_err("a stage cannot lead to itself");
    assert_eq!(err.kind(), "not_found");
    assert!(err.to_string().contains("doing"), "got `{err}`");
}

/// (the edge-label arity refusal, the wire half) `BoardError::EdgeOutcomeCount`
/// rides `NotFound` with the other Stage refusals and its sentence names BOTH
/// counts, because the caller's question is "which of my two lists is the wrong
/// length" and one number cannot answer that. The `kind` is NOT new — nothing
/// branches on a distinct one here, and `store/tasks.ts` reverts on ANY rejection.
#[test]
fn an_outcome_count_mismatch_refuses_as_not_found_naming_both_counts() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-outcome-arity-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-outcome-arity";
    db.get_board(space).expect("seed the five");

    let err = board_call(Ok::<_, String>(db.set_stage_next(
        space,
        "backlog",
        &["research".to_string(), "approved".to_string()],
        &[Some("ok".to_string())],
    )))
    .expect_err("two edges and one label is refused, not padded");
    assert_eq!(
        err.kind(),
        "not_found",
        "the arity refusal rides the Stage refusals' kind — nothing branches on \
         a distinct one"
    );
    let message = err.to_string();
    assert!(
        message.contains("backlog")
            && message.contains("2 edge")
            && message.contains("1 edge label"),
        "the sentence names the slug and BOTH counts, got `{message}`"
    );
    assert_eq!(
        db.get_board(space).expect("get_board")[0].stage.next_slugs,
        None,
        "and the refusal wrote nothing — the two columns can never be seen disagreeing"
    );
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
    let db_source = include_str!("../../../storage/db/stages.rs");
    let delete_body = {
        let start = db_source
            .find("pub fn delete_stage(")
            .expect("delete_stage is defined in db/stages.rs");
        let rest = &db_source[start..];
        // The body ends at the first line that is exactly `    }` — the close of
        // the method. It used to end at the NEXT method's doc line, which worked
        // only because `set_board_strict` happened to follow `delete_stage` in the
        // single `db.rs`; the ADR 0113 split made `delete_stage` the LAST method in
        // its own `impl Db` block, so the next thing is the `impl`'s own brace.
        // The method's own indentation is therefore the delimiter, and it is
        // subject-independent: no future reordering can move it.
        let end = rest
            .find("\n    }")
            .expect("the method's closing brace delimits the body");
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

/// (the file's registration claim) all ELEVEN Stage commands are in
/// `lib.rs`'s `generate_handler!` list, inside the board block. `seed.rs` pins
/// this shape for `start_task_session`, [`super::workflows`] pins it for the two
/// auto-guard commands AND the three `workflow_runs` commands, and the claim
/// `commands/tasks.rs`'s header makes ("TWENTY-SIX commands", measured against the
/// `#[tauri::command]` count) is
/// only true if every name is actually wired — a missing entry is a command the
/// webview cannot reach and no Rust test would notice. This pin stays at the Stage
/// names on purpose: it is named for the Stage commands, and widening it to cover
/// unrelated verbs would make its own name a lie. `set_stage_position` joins the
/// list because it edits the `stages` row like the ten before it; the canvas that
/// drags a node is its caller.
#[test]
fn the_eleven_stage_commands_are_registered_in_the_invoke_handler() {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("src/lib.rs reads");
    for command in [
        "commands::tasks::create_stage",
        "commands::tasks::rename_stage",
        "commands::tasks::set_stage_skill",
        "commands::tasks::set_stage_next",
        "commands::tasks::set_stage_auto",
        "commands::tasks::set_stage_prompt_prefix",
        "commands::tasks::set_stage_position",
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
/// (the wire shape `src/lib/tauri/types.ts` mirrors) the workflow and canvas
/// fields `StageRow` carries serialise with camelCase keys, inside all ELEVEN.
///
/// `StageRow` was serialised by NO test at all before this one, and the two fields
/// the workflow-graph work added are the ones the board renders and the chain
/// consults: `auto` is the flag `advanceWorkflowChainOnSettle` reads before it moves
/// a card, and `promptPrefix` is prepended to the launch prompt. Drop
/// `#[serde(rename_all = "camelCase")]` from the struct and both arrive as
/// `auto` / `prompt_prefix` — `auto` survives by luck (one word, no case to fold)
/// while `promptPrefix` becomes `undefined`, so a column's extra prompt silently
/// stops reaching the Session it configures. `StageDto` in types.ts is the mirror
/// this pins.
///
/// The two canvas coordinates join the same pin for the same reason and one of
/// their own: `positionX`/`positionY` are the pair the canvas reads BEFORE it runs
/// dagre, so a key that arrives as `position_x` is read as `undefined` and the
/// node silently snaps back to the computed layout — a drag that visibly fails to
/// persist, which is the exact defect this feature exists to fix.
///
/// The whole object is asserted, following the row pin above: a `contains`-style
/// check would pass while the sibling keys carried the wrong spelling.
#[test]
fn the_stage_row_serialises_with_the_camel_case_keys_the_ts_mirror_declares() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-stage-shape-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-stage/shape";
    db.upsert_space(space, false).expect("upsert_space");
    db.create_stage(space, "doing", "Doing", None)
        .expect("create_stage");
    // Configure BOTH workflow fields, so neither can hide behind a `null`: the
    // point of the test is the KEY SPELLING of the two, and an unset field would
    // let a dropped `rename_all` slip past a check that only looked at values.
    db.set_stage_auto(space, "doing", true)
        .expect("set_stage_auto");
    db.set_stage_prompt_prefix(space, "doing", Some("carry the spec forward"))
        .expect("set_stage_prompt_prefix");
    // And BOTH coordinates, on the asymmetric pair `-40.5`/`0.0`: a swapped ladder
    // or a key that arrives snake_cased cannot survive an asymmetric value, and
    // `0.0` proves a stored zero serialises as `0` rather than dropping out.
    db.set_stage_position(space, "doing", Some((-40.5, 0.0)))
        .expect("set_stage_position");

    let row = db
        .list_stages(space)
        .expect("list_stages")
        .into_iter()
        .find(|stage| stage.slug == "doing")
        .expect("the column exists");
    let value = serde_json::to_value(&row).expect("the stage row serialises");
    let object = value.as_object().expect("as an object");

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "auto",
            "label",
            "nextOutcomes",
            "nextSlugs",
            "onEnter",
            "onEnterSkill",
            "positionX",
            "positionY",
            "promptPrefix",
            "slug",
            "sortOrder",
            "spacePath",
        ],
        "EXACTLY the twelve camelCase keys the mirror declares — `auto` and \
         `promptPrefix` are the two the workflow-graph work added, `positionX` and \
         `positionY` the two the canvas adds, `nextOutcomes` the edge label the \
         completion signal adds, and a dropped `rename_all` would deliver \
         `prompt_prefix` / `position_x`, both of which the reader sees as \
         `undefined` and drops"
    );
    assert_eq!(
        object.len(),
        12,
        "exactly the twelve — a thirteenth is a field nothing reads"
    );
    // `nextOutcomes` on an unlabelled column serialises as JSON `null` and NOT as
    // an absent key: there is no `skip_serializing_if` on the field, so the reader
    // can tell "the backend predates the column" (absent — only reachable through a
    // build skew) from "this column's edges carry no labels" (`null`).
    assert_eq!(
        object["nextOutcomes"],
        serde_json::Value::Null,
        "an unlabelled column delivers `null`, and the key is PRESENT — the wire \
         never has to guess between an absent field and an unlabelled graph"
    );
    assert_eq!(
        object["auto"],
        serde_json::json!(true),
        "`auto` is a JSON boolean, so the chain's `from.auto` test is a real \
         branch and not a truthy string"
    );
    assert_eq!(
        object["promptPrefix"],
        serde_json::json!("carry the spec forward"),
        "and the prompt arrives under the camelCase key the launch path reads"
    );
    assert_eq!(
        object["positionX"],
        serde_json::json!(-40.5),
        "`positionX` is a JSON number under the camelCase key the canvas reads"
    );
    assert_eq!(
        object["positionY"],
        serde_json::json!(0.0),
        "and a stored `0.0` arrives as `0` — it is a coordinate a person placed, \
         not an absent value, so it must NOT serialise as `null` or drop out"
    );

    // The `null` arms of the two nullable workflow-adjacent fields are PRESENT and
    // NULL (the row pin's reasoning, same reason): a column with no Skill and an
    // UNCONFIGURED graph must arrive as `null`, not as an absent key, or the board
    // cannot tell "configured, leads nowhere" (`[]`) from "never configured"
    // (`null`) — the distinction `nextStepOf` branches on.
    let bare = db
        .create_stage(space, "backlog", "Backlog", None)
        .expect("a second column, nothing configured");
    let bare = serde_json::to_value(&bare).expect("serialises");
    let bare = bare.as_object().expect("as an object");
    assert!(
        bare.contains_key("onEnterSkill") && bare["onEnterSkill"].is_null(),
        "`null` onEnterSkill is present-and-null, got {:?}",
        bare.keys().collect::<Vec<_>>()
    );
    assert!(
        bare.contains_key("nextSlugs") && bare["nextSlugs"].is_null(),
        "`null` nextSlugs is present-and-null — UNCONFIGURED, and the board needs \
         the key to exist to tell it from `[]`"
    );
    assert!(
        bare.contains_key("promptPrefix") && bare["promptPrefix"].is_null(),
        "`null` promptPrefix is present-and-null (NO extra prompt)"
    );
    assert_eq!(
        bare["auto"],
        serde_json::json!(false),
        "and a fresh column defaults to NOT auto-advancing — the compatibility \
         rule: adding the capability must not make an existing board move anything"
    );
    // The pair's `null` arms, and these two are the UPGRADE case: every column in
    // every pre-canvas database arrives here, and the canvas branches on exactly
    // this pair to decide "run dagre for this node". An absent key and a `null`
    // read the same in JS, but the mirror declares them REQUIRED (`number | null`,
    // not `number?`), so the key must be there — the same argument
    // `nextSlugs`'s arm above makes about `[]` versus `null`.
    assert!(
        bare.contains_key("positionX") && bare["positionX"].is_null(),
        "`null` positionX is present-and-null — NEVER hand-arranged, so dagre \
         lays this node out; got {:?}",
        bare.keys().collect::<Vec<_>>()
    );
    assert!(
        bare.contains_key("positionY") && bare["positionY"].is_null(),
        "and `null` positionY arrives present-and-null beside it — a half-pair on \
         the wire would mean a node at a known X and an unknown Y, which is the \
         state `require_position_pair` refuses and no row may hold"
    );
}

/// (the pair arrives together, or not at all) the wire's half-set refusal, at the
/// one door where a half-pair is expressible.
///
/// JSON has no tuple type, so the command takes two `Option<f64>`s and four
/// combinations arrive; two of them are positions and two are lies. `Some(x),
/// None` is a node at a known X and an unknown Y — the renderer would have to
/// invent a Y, which is the invented-state move this repo refuses at every
/// nullable column's missing SQL `DEFAULT`. `(None, None)` is honest and is the
/// clear.
///
/// `require_position_pair` is a pure function, so the refusal is pinned directly
/// rather than through `board_call`: `tauri::State` cannot be built in a unit test
/// (the header's reason), and unlike the delegations this check has no storage
/// call to stand behind — it runs BEFORE the hop, so there is no `BoardError` in
/// its path at all.
#[test]
fn a_half_set_stage_position_is_refused_at_the_wire_naming_both_values() {
    // The two honest combinations.
    assert_eq!(
        require_position_pair(Some(1.5), Some(-2.0)),
        Ok(Some((1.5, -2.0)))
    );
    assert_eq!(require_position_pair(None, None), Ok(None));

    for (x, y) in [(Some(1.5), None), (None, Some(-2.0))] {
        let err =
            require_position_pair(x, y).expect_err("a half-set pair is refused — a node is a BOX");
        let message = err.to_string();
        assert!(
            message.contains("BOTH") && message.contains("NEITHER"),
            "the sentence states the rule it refused, got `{message}`"
        );
        // BOTH halves are echoed AS THEY ARRIVED, `None` included: the caller is a
        // canvas mid-drag, and the whole point of the refusal is that it does not
        // know which half it lost — a message that printed only the present value
        // would leave it guessing (the `require_artifact_key` rule: rejects, never
        // cleans, because the caller is the only party that can fix it).
        assert!(
            message.contains(&format!("x={x:?}")) && message.contains(&format!("y={y:?}")),
            "the refusal names BOTH coordinates as they arrived, got `{message}`"
        );
        assert_eq!(
            err.kind(),
            "other",
            "the pair's refusal rides `other`: nothing branches on a wire `kind` \
             it does not already handle, and `agent/errors.rs` is baselined at \
             exactly its code-line count — a new kind costs a ledger diff this \
             change has no business making. `store/tasks.ts` reverts on ANY kind."
        );
    }
}

/// (the command's signature IS the `Db` verb's, not an improvement on it) every
/// spelling in the new command's parameter list is a fact the canvas is written
/// against and none is checked by a compiler on either side of the wire — the
/// [`super::workflows`] structure-pin idiom, for the same reason and with the same
/// delimiter (`the run_commands' signatures…`'s note: the block ends at the
/// function's OWN `}`, because a neighbour's doc comment is prose about a
/// different verb).
#[test]
fn set_stage_position_command_signature_matches_the_db_verb_it_delegates_to() {
    let source = include_str!("../../tasks.rs");
    let start = source
        .find("pub async fn set_stage_position(")
        .expect("`set_stage_position` is defined in commands/tasks.rs");
    let rest = &source[start..];
    let end = rest
        .find("\n}\n")
        .expect("the function's own closing brace delimits the block");
    let block = &rest[..end];

    for spelling in [
        "space_path: String",
        "slug: String",
        "x: Option<f64>",
        "y: Option<f64>",
        "Result<StageRow, TasksError>",
    ] {
        assert!(
            block.contains(spelling),
            "the command must take `{spelling}` — the canvas passes camelCase \
             `x`/`y` and Tauri folds them to these, so a rename is a runtime \
             failure on one side and a green compile on both"
        );
    }
    // The pair is refused BEFORE the spawn, and the order is load-bearing: a
    // half-pair must not spend a worker thread or open a connection.
    let refusal = block
        .find("require_position_pair")
        .expect("the pre-flight runs in the command body");
    let hop = block
        .find("spawn_blocking")
        .expect("the delegation is a spawn_blocking");
    assert!(
        refusal < hop,
        "`require_position_pair` must run BEFORE the hop, the `write_artifact` \
         and `create_task` pre-flight rule"
    );
}
