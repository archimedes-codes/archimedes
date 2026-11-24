//! Tests for the workflow commands in [`crate::commands::tasks`]: the two
//! per-Space auto-guard commands, the two `workflow_runs` commands, and the
//! `lib.rs` registration of all four.
//!
//! The mirror rule this child exists under: `commands/tasks/tests/` splits BY
//! SUBJECT the way `storage/db/tests/` does, and the workflow guard + run record
//! are one subject (the wire half of the `db/auto_guards.rs` and
//! `db/workflow_runs.rs` siblings those two storage subjects were split into). The
//! ten-name pin in
//! [`super::stages`] is deliberately NOT widened to cover these four — it is named
//! for the Stage commands and stretching it would make its own name a lie.
//!
//! WHY THE RUN RECORD NOW HAS COMMANDS AND A FILE THAT ONCE PINNED ITS ABSENCE.
//! This child used to pin that `_step` / `_close` were
//! `Db` verbs and NOTHING MORE, on the argument that the auto-advance runtime
//! would reach them in-process through `Arc<Db>`. That argument failed on one
//! fact: the runtime is written in TypeScript, so it reaches the table over IPC
//! or not at all — and a step bound and a USD ceiling nothing can write are a
//! guard that cannot be enforced. The absence pin is therefore gone, replaced by
//! the registration pin below, and the tests after it pin the wire shape the
//! runtime is written against. The pair is TWO and not three because a third
//! command, `workflow_run_open`, was registered and then deleted as dead IPC — see
//! `the_workflow_run_commands_registered_in_the_invoke_handler_are_exactly_two`.

//! Module path spells `crate::commands::tasks::`, not `super::`: `super` here is
//! `tests`, not `tasks` (the [`super::stages`] note verbatim, because the same
//! trap is here).

use crate::commands::tasks::db_call;
use crate::storage::{AutoGuards, Db, DbError, DEFAULT_AUTO_CEILING_USD, DEFAULT_AUTO_MAX_STEPS};

/// (the file's registration claim) both auto-guard commands are in `lib.rs`'s
/// `generate_handler!` list. The same source-text read `seed.rs` and
/// [`super::stages`] use: a missing entry compiles clean, every Rust type-check is
/// happy, and the only symptom is a webview that cannot reach the command.
#[test]
fn the_two_auto_guard_commands_are_registered_in_the_invoke_handler() {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("src/lib.rs reads");
    for command in [
        "commands::tasks::get_auto_guards",
        "commands::tasks::set_auto_guards",
    ] {
        assert!(
            lib.contains(command),
            "`{command}` is missing from lib.rs's generate_handler! list — the \
             webview reaches commands through that list alone"
        );
    }
}

/// (the run record IS a command, now, on purpose) both `workflow_runs` commands
/// are in `lib.rs`'s `generate_handler!` list — and the deleted third is NOT.
///
/// This test REPLACES `the_workflow_run_verbs_are_not_commands_yet`, which pinned
/// the opposite claim for one commit. The claim it rested on — the auto-advance
/// runtime reaches the verbs in-process through `Arc<Db>` — turned out to be false:
/// the runtime is TypeScript, so the table is reachable over IPC or not at all, and
/// a bound nothing can write is a bound nothing can enforce. The same source-text
/// read [`super::stages`] and [`super::seed`] use: a missing entry compiles clean
/// and the only symptom is a runtime that cannot count its own chain.
///
/// The NEGATIVE half is the newer tooth. `workflow_run_open` was registered and then
/// deleted as dead IPC, and `scripts/check-commands.sh` could not see that it was
/// dead because the wrapper's own `invoke("workflow_run_open")` literal counted as
/// its consumer. Asserting the name is ABSENT here is what makes re-adding it a
/// decision: a registration with no consumer is exactly the rot that gate was written
/// to refuse, one layer above the layer it inspects.
#[test]
fn the_workflow_run_commands_registered_in_the_invoke_handler_are_exactly_two() {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("src/lib.rs reads");
    for command in [
        "commands::tasks::workflow_run_step",
        "commands::tasks::workflow_run_close",
    ] {
        assert!(
            lib.contains(command),
            "`{command}` is missing from lib.rs's generate_handler! list — the \
             auto-advance runtime is TypeScript and reaches the run record through \
             that list alone"
        );
    }
    assert!(
        !lib.contains("commands::tasks::workflow_run_open"),
        "`workflow_run_open` is back in the handler list. It was deleted as dead \
         IPC: the runtime asks no \"is this card mid-chain\" question, because \
         `workflow_run_step` IS the upsert. Re-registering it needs a consumer, not \
         a wrapper that wraps it."
    );
}

/// (the command signatures are the Db signatures, not an improvement on them)
/// `tauri::State` cannot be built in a unit test, so the two commands' own
/// parameter lists are pinned from source text — the [`super::stages`]
/// structure-pin idiom — because every one of these spellings is a fact the
/// TypeScript runtime is written against and none of them is checked by a compiler on
/// either side of the wire.
///
/// The claims, and why each is load-bearing rather than cosmetic:
///   - `cost_delta_usd` is `Option<f64>`. A step that reports no figure must
///     write NOTHING to `cost_usd`; a plain `f64` would make the runtime send
///     `0.0` for "unknown", which is ADR 0082's phantom-zero and would let a chain
///     that never reported a cost look like a free one.
///   - `workflow_run_close` takes `stop_reason: String` and answers `()`, and takes
///     NO `space_path`. The reason is the record's only narrative field and the
///     runtime has nothing to read back after closing; the verb scopes the update on
///     the card alone, so a Space argument would be one the write cannot use.
///   - The third command this pin used to read, `workflow_run_open`, is gone — a
///     registered command whose only consumer was the TS wrapper that wrapped it.
///     `the_workflow_run_commands_registered_in_the_invoke_handler_are_exactly_two`
///     pins the count so a re-add is a decision and not a slip.
#[test]
fn the_run_commands_signatures_match_the_db_verbs_they_delegate_to() {
    let source = include_str!("../../tasks.rs");
    // One command's whole block: from its `pub async fn` to the line that closes
    // it. The delimiter is the function's OWN top-level `}` and not the next
    // `#[tauri::command]`, because the next command's DOC COMMENT sits between the
    // two and mentions `space_path` — a doc comment is prose about a neighbour, and
    // reading it as part of this signature is exactly how a structure pin starts
    // convicting the wrong verb.
    let block = |name: &str| -> String {
        let start = source
            .find(&format!("pub async fn {name}("))
            .unwrap_or_else(|| panic!("`{name}` is defined in commands/tasks.rs"));
        let rest = &source[start..];
        let end = rest
            .find("\n}\n")
            .expect("the function's own closing brace delimits the block");
        rest[..end].to_string()
    };

    let step = block("workflow_run_step");
    for spelling in ["space_path: String", "task_id: String"] {
        assert!(
            step.contains(spelling),
            "`workflow_run_step` takes `{spelling}` (the INSERT arm needs \
             `space_path`), got `{step}`"
        );
    }
    assert!(
        step.contains("cost_delta_usd: Option<f64>"),
        "`cost_delta_usd` is optional so a step that reports no figure leaves \
         `cost_usd` NULL instead of writing a phantom 0.0 (ADR 0082), got `{step}`"
    );

    let close = block("workflow_run_close");
    assert!(
        close.contains("task_id: String") && close.contains("stop_reason: String"),
        "`workflow_run_close` takes the card and the reason, got `{close}`"
    );
    assert!(
        !close.contains("space_path"),
        "and no `space_path` — `Db::workflow_run_close(&self, task_id: &str, \
         stop_reason: &str)` scopes on the card, got `{close}`"
    );

    // The delegation, one per command — the claim the signatures alone cannot make.
    // Without these two assertions a body that reached the WRONG verb would compile,
    // pass every test above, and hand the runtime a chain counter that never moves.
    assert!(
        step.contains("db.workflow_run_step(&space_path, &task_id, cost_delta_usd)"),
        "`workflow_run_step` hands over all three arguments in the verb's order"
    );
    assert!(
        close.contains("db.workflow_run_close(&task_id, &stop_reason)"),
        "`workflow_run_close` hands over the card and the reason"
    );
    for (name, body) in [("workflow_run_step", &step), ("workflow_run_close", &close)] {
        let others: Vec<&str> = ["workflow_run_step", "workflow_run_close"]
            .into_iter()
            .filter(|verb| *verb != name && body.contains(&format!("db.{verb}(")))
            .collect();
        assert!(
            others.is_empty(),
            "`{name}` also reaches {others:?} — one command, one verb; a second \
             call would double-count a step or close a chain twice"
        );
    }

    // And both ride `db_call`, not `board_call`: `workflow_runs` answers
    // `DbError`, and `board_call` is typed to `BoardError` — the same reason the
    // four `spaces`-table commands beside them give for the same choice.
    for (name, body) in [("workflow_run_step", &step), ("workflow_run_close", &close)] {
        assert!(
            body.contains("db_call("),
            "`{name}` goes through `db_call` — its storage verb answers `DbError`"
        );
        assert!(
            !body.contains("board_call("),
            "`{name}` cannot go through `board_call`, which is typed to `BoardError`"
        );
    }

    // The return types, on the same reasoning: `AdvanceVerdict` (the caller's next
    // question is whether THIS step crossed the bound, and the two bounds it is
    // measured against are Rust-only, so the answer has to be a decision and not a
    // row), and `()` for the close.
    let returns = |name: &str| -> String {
        let body = block(name);
        let open_paren = body.find(") -> ").expect("a command returns something");
        let tail = &body[open_paren..];
        let end = tail.find('{').expect("the body opens the return type");
        tail[..end].trim().to_string()
    };
    assert_eq!(
        returns("workflow_run_step"),
        ") -> Result<AdvanceVerdict, TasksError>",
        "the step answers with a VERDICT, not a row: `advance` is the guard's \
         decision and `maxSteps` / `ceilingUsd` are the EFFECTIVE bounds it was \
         computed from, which the TypeScript caller cannot derive because the \
         fallback constants are Rust-side on purpose (a copy across the wire is a \
         copy that drifts — the reason this return type is not `WorkflowRunRow`)"
    );
    assert_eq!(
        returns("workflow_run_close"),
        ") -> Result<(), TasksError>",
        "the close has nothing to report — a chain with nothing to close is an \
         ordinary `Ok(())`"
    );
    // And the verdict's own name is imported from `storage` rather than re-declared
    // here: a command layer that owned a second `AdvanceVerdict` would be a second
    // owner of the guard's vocabulary, which is the failure this whole type exists
    // to prevent. `ChainStop` rides for the same reason — the wire carries it.
    assert!(
        source.contains("AdvanceVerdict") && source.contains("use crate::storage::{"),
        "`AdvanceVerdict` must be named by re-export from `crate::storage`, not \
         declared beside the command"
    );
    let storage_import = source
        .split_once("use crate::storage::{")
        .expect("the storage import block")
        .1
        .split_once("};")
        .expect("it closes")
        .0;
    assert!(
        storage_import.contains("AdvanceVerdict"),
        "`AdvanceVerdict` is imported from `crate::storage` (the storage layer owns \
         the verdict), got `{storage_import}`"
    );
}

/// (`workflow_run_step` is the upsert over the wire) the first call opens a run
/// at ONE step and the second increments the SAME row.
///
/// The pair is what makes the step bound countable at all, and the assertions are
/// the two the runtime depends on: the counter it compares against the bound is
/// the one in the row it gets back, and one chain is one row (`steps` reaching 3
/// across two rows would read as 2 against the bound).
#[test]
fn workflow_run_step_opens_a_run_and_then_increments_the_same_row() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-runs-step-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-runs/step";
    db.upsert_space(space, false).expect("upsert_space");
    let task = db
        .create_task(space, "the chained card", None, None)
        .expect("create_task");

    // Both get `.run`: the verb answers an `AdvanceVerdict` now and the row is one
    // field of it. Every assertion below is the one this test already made — the
    // write behaviour is unchanged by the verdict, and the guard fields the verdict
    // adds are pinned by their own tests in the two storage subjects the split left
    // behind: `storage/db/tests/auto_guards.rs` owns the guard READ (which fallback
    // governs an unset Space) and `storage/db/tests/workflow_runs.rs` owns the bound
    // JUDGEMENT the effective figures come out of.
    let first = db_call(Ok::<_, String>(db.workflow_run_step(space, &task.id, None)))
        .expect("the first step opens a run")
        .run;
    assert_eq!(first.steps, 1, "the first step is ONE step, not zero");
    assert_eq!(first.task_id, task.id);
    assert_eq!(first.space_path, space);
    assert_eq!(
        first.cost_usd, None,
        "a step that reported no figure leaves the column NULL, not 0.0 (ADR 0082)"
    );
    assert_eq!(first.finished_at, None, "and the run it opened is OPEN");

    let second = db_call(Ok::<_, String>(db.workflow_run_step(
        space,
        &task.id,
        Some(0.25),
    )))
    .expect("the second step lands on the open run")
    .run;
    assert_eq!(second.steps, 2, "the second step increments");
    assert_eq!(second.id, first.id, "and never mints a second row");
    assert_eq!(
        second.cost_usd,
        Some(0.25),
        "the first figure SETS the column (`NULL + x` would have kept it NULL and \
         made the ceiling read as free)"
    );

    // And the open row in the DATABASE is the row the step wrote, so a runtime that
    // re-reads instead of trusting its own arithmetic gets the same figure. Read
    // through an independent connection (the `closed_run` idiom below) because the
    // read verb that used to answer this was deleted as dead IPC.
    let open = open_run(&dir.join("t.db"), &task.id).expect("the chain is open");
    assert_eq!(
        (open.0.as_str(), open.1, open.2),
        (second.id.as_str(), second.steps, second.cost_usd),
        "the stored row is the state after the write"
    );
}

/// (`workflow_run_close` ends the chain) it stamps `finished_at` + `stop_reason`,
/// and the open read afterwards answers `None`.
///
/// The `None` after the close is the point: it is what lets the NEXT auto-advance
/// open a fresh BOUNDED run instead of continuing a chain that already spent its
/// allowance. The two columns the close owns are read back through an INDEPENDENT
/// connection (the `artifact_rows` idiom in [`super::artifacts`]) rather than
/// through a `Db` verb, because this layer's read surface is deliberately
/// open-only — there is no "read the last closed run" verb to accidentally assert
/// against, and a closed row is what an observability surface would need.
#[test]
fn workflow_run_close_stamps_the_end_and_the_next_open_reads_none() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-runs-close-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-runs/close";
    db.upsert_space(space, false).expect("upsert_space");
    let task = db
        .create_task(space, "a chain that stopped", None, None)
        .expect("create_task");

    let opened = db_call(Ok::<_, String>(db.workflow_run_step(
        space,
        &task.id,
        Some(1.5),
    )))
    .expect("open the chain")
    .run;
    assert_eq!(opened.finished_at, None, "the step opened it");

    db_call(Ok::<_, String>(
        db.workflow_run_close(&task.id, "max_steps"),
    ))
    .expect("the close is `Ok(())`");

    assert_eq!(
        open_run(&dir.join("t.db"), &task.id),
        None,
        "a closed chain is NOT an open one — this is what makes the next chain \
         a new bounded run rather than a continuation"
    );

    let (finished_at, stop_reason) = closed_run(&dir.join("t.db"), &task.id);
    assert!(
        finished_at.unwrap_or_default() > 0,
        "`finished_at` gets the clock (got {finished_at:?})"
    );
    assert_eq!(
        stop_reason.as_deref(),
        Some("max_steps"),
        "and `stop_reason` gets the caller's word verbatim"
    );

    // A SECOND close is a silent `Ok(())` that rewrites NOTHING — the `WHERE
    // finished_at IS NULL` arm is what protects the record's only narrative field,
    // so a settle-handler that fires twice cannot turn "the chain hit its step
    // bound" into "manual".
    db_call(Ok::<_, String>(db.workflow_run_close(&task.id, "manual")))
        .expect("a close with nothing open is `Ok(())`");
    let (again, reason_again) = closed_run(&dir.join("t.db"), &task.id);
    assert_eq!(again, finished_at, "the end stamp did not move");
    assert_eq!(
        reason_again.as_deref(),
        Some("max_steps"),
        "and the reason a chain ACTUALLY stopped is never rewritten by a later close"
    );

    // And closing a card that never opened a run at all is the same silent `Ok`.
    let stranger = db
        .create_task(space, "a card that never chained", None, None)
        .expect("create_task");
    db_call(Ok::<_, String>(
        db.workflow_run_close(&stranger.id, "manual"),
    ))
    .expect("zero open runs is a no-op, not a failure");
}

/// One closed `workflow_runs` row for `task_id`, read on its own connection.
/// Panics if the table holds no row for the card — the close must not have
/// deleted anything.
fn closed_run(db_path: &std::path::Path, task_id: &str) -> (Option<i64>, Option<String>) {
    let conn = rusqlite::Connection::open(db_path).expect("an independent connection");
    conn.query_row(
        "SELECT finished_at, stop_reason FROM workflow_runs WHERE task_id = ?1",
        rusqlite::params![task_id],
        |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    )
    .expect("the closed row is still there — a close stamps, it never deletes")
}

/// The OPEN `workflow_runs` row for one Task, read through an INDEPENDENT
/// connection — `closed_run`'s twin, and the same reason for it.
///
/// `Db::workflow_run_open` used to answer this at this layer and was deleted as
/// dead IPC (nothing in the runtime asks "is this card mid-chain": `workflow_run_step`
/// is the upsert, so a chain opens by stepping). The tests still need the question,
/// because "did the close actually close it" is exactly what the wire family has to
/// get right, and reading it from the file rather than from a verb is what makes the
/// assertion about the DATABASE instead of about a method's return value.
///
/// `None` means no open row. Any OTHER sqlite failure panics rather than becoming
/// `None`, so an assertion written `open_run(..).is_none()` cannot pass for the wrong
/// reason.
fn open_run(db_path: &std::path::Path, task_id: &str) -> Option<(String, i64, Option<f64>)> {
    let conn = rusqlite::Connection::open(db_path).expect("an independent connection");
    match conn.query_row(
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

/// (the wire shape `src/lib/tauri/types.ts` mirrors) the row serialises with
/// camelCase keys, all EIGHT present, and `None` fields serialise as JSON `null`
/// rather than vanishing.
///
/// This is the mirror `WorkflowRunRow` in `types.ts` is written against, and the
/// reason it is worth pinning in Rust rather than trusting the TS interface: a
/// TS interface is a claim about the wire that the compiler cannot check, and a
/// renamed field on either side is `undefined` in the runtime's arithmetic —
/// `undefined > ceilingUsd` is `false`, so a silently-missing `costUsd` reads as
/// "under the ceiling" and the guard fails open.
///
/// The three `null` arms are the ones with meaning attached (ADR 0082):
/// `finishedAt: null` is OPEN, `stopReason: null` is "has not stopped", and
/// `costUsd: null` is "no Session in this chain ever reported a figure" — which is
/// NOT `0.0`, and a serialisation that dropped the key instead of writing `null`
/// would make the two indistinguishable on the wire.
#[test]
fn the_run_row_serialises_with_the_camel_case_keys_the_ts_mirror_declares() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-runs-shape-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-runs/shape";
    db.upsert_space(space, false).expect("upsert_space");
    let task = db
        .create_task(space, "the card whose row crosses the wire", None, None)
        .expect("create_task");

    // `.run`: the verb answers a verdict now, and THIS test's subject is the row
    // inside it — the eight-key mirror `WorkflowRunRow` in types.ts declares is
    // unchanged by the verdict, and stays pinned here. The verdict's OWN wire shape
    // is pinned by
    // `the_verdict_serialises_with_the_camel_case_keys_the_ts_mirror_declares`,
    // immediately below.
    let opened = db_call(Ok::<_, String>(db.workflow_run_step(space, &task.id, None)))
        .expect("open a run with NO cost reported")
        .run;
    let value = serde_json::to_value(&opened).expect("the row serialises");
    let object = value.as_object().expect("as an object");

    for key in [
        "id",
        "spacePath",
        "taskId",
        "startedAt",
        "finishedAt",
        "steps",
        "costUsd",
        "stopReason",
    ] {
        assert!(
            object.contains_key(key),
            "`{key}` is missing from the serialised row — types.ts declares it, \
             got the keys {other:?}",
            other = object.keys().collect::<Vec<_>>(),
        );
    }
    assert_eq!(
        object.len(),
        8,
        "exactly the eight the mirror declares — a ninth is a field nothing reads"
    );

    assert!(
        object["costUsd"].is_null(),
        "a chain with no figure serialises `null` and not `0.0` and not an absent \
         key (ADR 0082) — got `{}`",
        object["costUsd"]
    );
    assert!(object["finishedAt"].is_null(), "an OPEN run");
    assert!(object["stopReason"].is_null(), "has no stop reason");
    assert_eq!(object["steps"], serde_json::json!(1), "a plain counter");
    assert_eq!(object["taskId"], serde_json::json!(task.id));
    assert_eq!(object["spacePath"], serde_json::json!(space));

    // And once a figure lands, the SAME key carries a number — the two states the
    // ceiling test has to tell apart, both under one key name.
    let costed = db_call(Ok::<_, String>(db.workflow_run_step(
        space,
        &task.id,
        Some(0.5),
    )))
    .expect("the second step reports a figure")
    .run;
    assert_eq!(
        serde_json::to_value(&costed).expect("serialises")["costUsd"],
        serde_json::json!(0.5),
        "`Some(x)` arrives as a number, so `null` cannot be mistaken for it"
    );
}

/// (the wire shape the auto-advance runtime is written against) the VERDICT
/// serialises with camelCase keys, all FIVE present, and `stop` arriving as the
/// snake_case vocabulary rather than the Rust variant name.
///
/// This is the mirror `AdvanceVerdict` in `src/lib/tauri/types.ts` is written
/// against, and it is pinned for the same reason its sibling above pins the row: a
/// TS interface is a claim about the wire no compiler checks. Two shapes matter
/// here and only one of them is a key name.
///
///   - `stop: null` must be PRESENT as `null`, not absent. The runtime branches on
///     it to decide whether to advance, and `undefined` and `null` both happen to
///     be falsy in JavaScript — so an absent key would pass today's code and leave
///     a later `stop === null` comparison (or a `switch`) silently wrong. The
///     `costUsd` argument from the sibling test above, one field over.
///   - `stop` must be `"max_steps"` and not `"MaxSteps"`. The same string is what
///     `workflow_run_close`'s `stop_reason` column stores, so a serde spelling that
///     drifted from `as_str()` would put two vocabularies in one feature — the
///     verdict's reason and the record's reason no longer matching — and the TS
///     union would be a lie on one side or the other. `#[serde(rename_all =
///     "snake_case")]` is what makes them agree, and this is the pin that notices
///     if it is dropped.
///   - `maxSteps` is a NUMBER and never `null`, even for a Space that configured
///     nothing: the fallback has already been applied by the time the verdict is
///     built, and a `null` here would tell the caller it could not tell how long a
///     chain may run.
#[test]
fn the_verdict_serialises_with_the_camel_case_keys_the_ts_mirror_declares() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-verdict-shape-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-verdict/shape";
    db.upsert_space(space, false).expect("upsert_space");
    db.set_auto_guards(space, Some(1), Some(100.0))
        .expect("a one-step bound, so the verdict carries a stop");
    let task = db
        .create_task(space, "the verdict that crosses the wire", None, None)
        .expect("create_task");
    // The bound is 1, so the FIRST advance is permitted and the SECOND trips
    // (`max_steps` counts advances, not refusals) — hence the step-then-step here
    // rather than a single step. What this test pins is the SHAPE of a stopped
    // verdict, and a stopped verdict is what the tripping step answers with.
    db_call(Ok::<_, String>(db.workflow_run_step(space, &task.id, None)))
        .expect("the advance the bound permits");

    let verdict = db_call(Ok::<_, String>(db.workflow_run_step(space, &task.id, None)))
        .expect("the step that trips the bound answers a verdict");
    let value = serde_json::to_value(&verdict).expect("the verdict serialises");
    let object = value.as_object().expect("as an object");

    for key in ["run", "advance", "stop", "maxSteps", "ceilingUsd"] {
        assert!(
            object.contains_key(key),
            "`{key}` is missing from the serialised verdict — types.ts declares it, \
             got the keys {keys:?}",
            keys = object.keys().collect::<Vec<_>>(),
        );
    }
    assert_eq!(
        object.len(),
        5,
        "exactly the five the mirror declares — a sixth is a field nothing reads \
         and a fifth that vanished is a lie about the guard"
    );

    assert_eq!(object["advance"], serde_json::json!(false));
    assert_eq!(
        object["stop"],
        serde_json::json!("max_steps"),
        "the wire spelling is `as_str()`'s, shared with `stop_reason` — not the \
         Rust variant name `MaxSteps`"
    );
    assert_eq!(
        object["maxSteps"],
        serde_json::json!(1),
        "a NUMBER, and the effective one (the configured bound, not a `null` \
         standing in for a fallback the caller cannot name)"
    );
    assert_eq!(object["ceilingUsd"], serde_json::json!(100.0));

    // The nested row keeps its own camelCase shape — the verdict wraps it, it does
    // not re-spell it (`serde(rename_all = "camelCase")` on `AdvanceVerdict` renames
    // THIS struct's keys, and `run`'s own eight are renamed by the row).
    let run = object["run"]
        .as_object()
        .expect("the row rides as an object");
    assert_eq!(
        run.len(),
        8,
        "and the row inside it is still the eight-key row the mirror above pins"
    );
    assert_eq!(run["taskId"], serde_json::json!(task.id));

    // The `advance: true` arm: `stop` is `null` and PRESENT.
    let other = db
        .create_task(space, "a card in a Space with room left", None, None)
        .expect("create_task");
    db.set_auto_guards(space, Some(20), Some(100.0))
        .expect("room to advance");
    let open = db_call(Ok::<_, String>(
        db.workflow_run_step(space, &other.id, None),
    ))
    .expect("a step that may be followed");
    let open = serde_json::to_value(&open).expect("serialises");
    assert_eq!(open["advance"], serde_json::json!(true));
    assert!(
        open["stop"].is_null(),
        "`None` serialises as `null` and not as an absent key — the runtime's \
         branch reads this key"
    );
    assert_eq!(
        open["maxSteps"],
        serde_json::json!(20),
        "and the effective bound is still reported on the arm that advances, so a \
         sentence like \"20 steps left\" is available before the chain ends"
    );
}

/// (the fallback, on the wire) an unconfigured Space's verdict reports the SHIPPED
/// bounds as numbers, across `db_call` and not just at the verb.
///
/// The command layer is where a `None` could silently become a `0` (an
/// `unwrap_or_default` in a future refactor is one keystroke), and `0` on this wire
/// means "no auto-chaining" — so the number the person never set would arrive as
/// the setting they never made, and the settle-handler would report "your chain hit
/// its 0-step bound" for a Space whose editor says 20. Asserted against the
/// constants, not their literals, for the reason the sibling file gives.
#[test]
fn an_unset_spaces_verdict_carries_the_fallback_bounds_as_numbers_over_the_wire() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-verdict-fallback-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-verdict/unset";
    db.upsert_space(space, false)
        .expect("a row that configured NOTHING");
    let task = db
        .create_task(space, "a card in an unconfigured Space", None, None)
        .expect("create_task");

    let verdict = db_call(Ok::<_, String>(db.workflow_run_step(space, &task.id, None)))
        .expect("the step answers");
    let value = serde_json::to_value(&verdict).expect("serialises");

    assert!(verdict.advance, "one step into a bounded chain continues");
    assert_eq!(value["maxSteps"], serde_json::json!(DEFAULT_AUTO_MAX_STEPS));
    assert_eq!(
        value["ceilingUsd"],
        serde_json::json!(DEFAULT_AUTO_CEILING_USD),
        "the ceiling arrives as a NUMBER and not `null` — `null` on this field \
         means \"no ceiling configured\", which is not what an unset Space means"
    );
    assert!(value["stop"].is_null());
}
/// (the wire guarantee the guard editor's seed relies on) `get_auto_guards` carries
/// the storage `Result<AutoGuards, DbError>` across the `spawn_blocking` shape
/// untouched, and the three states the editor must tell apart stay three.
///
/// Goes through [`db_call`] and not `board_call`, because the storage call answers
/// `DbError` — the `set_board_strict` / `get_board_strict` family, one layer of
/// flattening and no `From<DbError> for TasksError`.
///
/// The three states are the point of the test: `None` (not configured → the shipped
/// fallback governs), `Some(0)` / `Some(0.0)` (configured, and the answer is "no
/// chaining" / "no spend"), and a Space with NO `spaces` row (which must read as the
/// FIRST, not as an error and not as zero). An editor that rendered a `None` as a `0`
/// would show every Space in the app as having auto-chaining switched off.
#[test]
fn get_auto_guards_carries_the_pair_across_the_spawn_blocking_shape() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-guards-read-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    // Configured on both.
    let set = "/cmd-guards/set";
    db.upsert_space(set, false).expect("upsert_space");
    db.set_auto_guards(set, Some(7), Some(2.5))
        .expect("set_auto_guards");
    assert_eq!(
        db_call(Ok::<_, String>(db.auto_guards(set))).expect("read the pair"),
        AutoGuards {
            max_steps: Some(7),
            ceiling_usd: Some(2.5),
        },
        "both figures cross the wire intact"
    );

    // Configured to ZERO — a real answer, not the fallback.
    let zero = "/cmd-guards/zero";
    db.upsert_space(zero, false).expect("upsert_space");
    db.set_auto_guards(zero, Some(0), Some(0.0))
        .expect("a zero bound is a setting");
    assert_eq!(
        db_call(Ok::<_, String>(db.auto_guards(zero))).expect("read the zeros"),
        AutoGuards {
            max_steps: Some(0),
            ceiling_usd: Some(0.0),
        },
        "`Some(0)` does not arrive as `None` and not as a missing field"
    );

    // Unconfigured, and a Space with no row: the SAME two-`None` answer, and both
    // `Ok`. This is the case the editor must not render as "off".
    let unset = "/cmd-guards/unset";
    db.upsert_space(unset, false).expect("upsert_space");
    assert_eq!(
        db_call(Ok::<_, String>(db.auto_guards(unset))).expect("read the unset row"),
        AutoGuards {
            max_steps: None,
            ceiling_usd: None,
        },
        "a row that configured nothing reads two `None`s"
    );
    assert_eq!(
        db_call(Ok::<_, String>(db.auto_guards("/cmd-guards/no-row")))
            .expect("a missing row is Ok, not an error"),
        AutoGuards {
            max_steps: None,
            ceiling_usd: None,
        },
        "and so does a Space with no row at all"
    );

    // And a real failure maps to `other`, NOT to `not_found`: absence is a pair of
    // `None`s in this family, so anything reaching the wire as an error is the
    // database (or the join). Both of `db_call`'s two layers are exercised, the same
    // two the helper documents.
    let storage_failed = db_call(Ok::<_, String>(Err::<AutoGuards, _>(DbError::Io(
        std::io::Error::other("disk on fire"),
    ))));
    let err = storage_failed.expect_err("a DbError is still an error at the wire");
    assert_eq!(err.kind(), "other");
    assert!(err.to_string().contains("disk on fire"), "got `{err}`");
}

/// (the write's wire shape) `set_auto_guards` returns `()` and writes exactly the
/// pair it is handed, `None` included — so the editor's Clear button is expressible
/// through the command and not only through the verb.
///
/// The `None` case is the one worth a test at this layer: a command that took plain
/// `i64` / `f64` could set a guard and never clear one, which is the
/// `set_stage_next` defect wearing a wire shape.
#[test]
fn set_auto_guards_writes_the_pair_it_is_handed_including_a_clear() {
    let dir = crate::test_support::ScratchDir::in_env_temp("cmd-guards-write-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = "/cmd-guards/write";
    db.upsert_space(space, false).expect("upsert_space");

    db_call(Ok::<_, String>(db.set_auto_guards(
        space,
        Some(3),
        Some(1.25),
    )))
    .expect("the write is `Ok(())`");
    assert_eq!(
        db_call(Ok::<_, String>(db.auto_guards(space))).expect("read back"),
        AutoGuards {
            max_steps: Some(3),
            ceiling_usd: Some(1.25),
        },
        "what was handed is what landed"
    );

    db_call(Ok::<_, String>(db.set_auto_guards(space, None, Some(1.25))))
        .expect("a clear is `Ok(())` too");
    assert_eq!(
        db_call(Ok::<_, String>(db.auto_guards(space))).expect("read back"),
        AutoGuards {
            max_steps: None,
            ceiling_usd: Some(1.25),
        },
        "the cleared guard is NULL and its neighbour survives"
    );
}

/// (the wire shape `src/lib/tauri/types.ts` mirrors) `AutoGuards` serialises with
/// camelCase keys, exactly TWO of them, and both `null` arms present-and-null.
///
/// WHY THIS PIN EXISTS WHEN THE TWO BESIDE IT DO. `AutoGuards` is the type the guard
/// editor's seed is written against: `getAutoGuards` answers it and the editor paints
/// its two inputs from `maxSteps` / `ceilingUsd`. Drop
/// `#[serde(rename_all = "camelCase")]` from the struct and the wire carries
/// `max_steps` / `ceiling_usd`, the editor's seed reads `undefined ?? null`, every
/// Space in the app looks UNCONFIGURED, and the shipped fallbacks govern a Space whose
/// owner set a bound — the inherited-bound-that-looks-chosen collapse
/// `AutoChainGuards`' header exists to prevent. Nothing in the Rust suite or the TS
/// suite notices: the Rust tests compare the struct, the TS tests mock the payload.
/// This is the pin that reddens.
///
/// Asserted against the WHOLE serialised object (equality, `len()`, and the `null`
/// arms explicitly) and not with `contains`, following
/// `the_run_row_serialises_with_the_camel_case_keys_the_ts_mirror_declares` for the
/// reason it gives: a key-name check that tolerates extra keys cannot see a field
/// that arrived under the wrong spelling alongside the one that did not.
#[test]
fn the_guards_serialise_with_the_camel_case_keys_the_ts_mirror_declares() {
    // Configured on BOTH: every key carries a value, so a snake_case slip shows up
    // as a missing camelCase key rather than hiding behind a `null`.
    let configured = AutoGuards {
        max_steps: Some(7),
        ceiling_usd: Some(2.5),
    };
    let value = serde_json::to_value(&configured).expect("the guards serialise");
    let object = value.as_object().expect("as an object");

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["ceilingUsd", "maxSteps"],
        "EXACTLY the two camelCase keys types.ts declares — a snake_case key is \
         what a dropped `rename_all` produces, and the editor's seed would then read \
         `undefined` for both and paint every Space as unconfigured"
    );
    assert_eq!(
        object.len(),
        2,
        "exactly the two the mirror declares — a third is a field nothing reads"
    );
    assert_eq!(
        value,
        serde_json::json!({ "maxSteps": 7, "ceilingUsd": 2.5 }),
        "the whole object, values included — not a per-key `contains` that would \
         pass while a key carried the wrong thing"
    );

    // Both UNSET: the two `null` arms are PRESENT and NULL. This is the half the
    // editor's three states depend on — `null` is "not configured, the shipped
    // fallback governs", and a key that VANISHED instead of arriving `null` is
    // indistinguishable from the field never having existed.
    let unset = AutoGuards {
        max_steps: None,
        ceiling_usd: None,
    };
    let unset = serde_json::to_value(&unset).expect("serialises");
    let unset = unset.as_object().expect("as an object");
    assert!(
        unset.contains_key("maxSteps") && unset["maxSteps"].is_null(),
        "`None` max_steps serialises as a PRESENT `null` and not an absent key, \
         got the keys {keys:?}",
        keys = unset.keys().collect::<Vec<_>>()
    );
    assert!(
        unset.contains_key("ceilingUsd") && unset["ceilingUsd"].is_null(),
        "`None` ceiling_usd likewise, got the keys {keys:?}",
        keys = unset.keys().collect::<Vec<_>>()
    );
    assert_eq!(unset.len(), 2, "and still exactly two keys");

    // `Some(0)` is NOT `None` on the wire either — the ADR 0082 pair, on the wire.
    let zeroed = serde_json::to_value(AutoGuards {
        max_steps: Some(0),
        ceiling_usd: Some(0.0),
    })
    .expect("serialises");
    assert_eq!(
        zeroed,
        serde_json::json!({ "maxSteps": 0, "ceilingUsd": 0.0 }),
        "a configured ZERO arrives as a number, so the editor cannot render \
         \"chaining is off\" as \"never configured\""
    );
}
