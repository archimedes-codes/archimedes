//! Issue #180 D1 — the two **Task artifact** commands (spec §1/§2, ADR 0100).
//!
//! D1 ships the HUMAN surface only: `write_artifact` / `get_artifact` are Tauri
//! commands a frontend calls. Nothing here advertises a verb to a model — no
//! `trait TaskStore`, no `tool_specs()` entry, no `execute_tool` arm, no
//! `<artifacts>` launch block. Those are D2, and they will be built on these same
//! `Db` methods.
//!
//! The `#[tauri::command]` wrappers are one line over [`write_artifact_core`] /
//! [`get_artifact_core`] because `tauri::State` cannot be constructed in a unit
//! test (the `start_task_session_inner` / `provider_login_oidc_with` precedent),
//! so every assertion below runs the real body — validators, gate, `Db` write and
//! all — against a real database.

use std::path::Path;

use crate::agent::TasksError;
use crate::commands::tasks::{
    get_artifact_core, require_artifact_key, write_artifact_core, MAX_ARTIFACT_MARKDOWN_BYTES,
};
use crate::storage::{Artifact, Db};
use crate::test_support::ScratchDir;

/// Read every `task_artifacts` row through an INDEPENDENT connection, so "wrote
/// nothing" means the DATABASE has no row — not that a method returned an `Err`.
fn artifact_rows(db_path: &Path) -> Vec<(String, String, String)> {
    let conn = rusqlite::Connection::open(db_path).expect("an independent connection");
    let mut stmt = conn
        .prepare("SELECT task_id, key, markdown FROM task_artifacts ORDER BY rowid ASC")
        .expect("prepares");
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("queries");
    rows.collect::<Result<_, _>>().expect("maps")
}

/// A board with one card, and the scratch dir kept alive by the caller.
fn db_with_task(dir: &Path, tag: &str) -> (Db, String) {
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = format!("/board-space/{tag}");
    db.get_board(&space).expect("seed the stages");
    let task = db
        .create_task(&space, "the card", None, None)
        .expect("create_task");
    (db, task.id)
}

/// (the key grammar, spec §1 / ADR 0100) `[a-z0-9][a-z0-9-]{0,39}` — accepted and
/// refused, table-driven, with the boundary at 40 characters measured rather than
/// assumed.
///
/// The refused set is not arbitrary: `""` has no first character, `A` and `_` are
/// outside the Mention token alphabet, and `a<b` / `a"b` are the two characters
/// that make a key an INJECTION POINT in the `<task>` launch block — which is why
/// this rule is load-bearing and not cosmetic. `1hello` is deliberately ACCEPTED:
/// the grammar's first class is `[a-z0-9]`, digits included.
///
/// MUTATION (measured): widen the first-character class to `b'a'..=b'z' | b'0'..=
/// b'9' | b'-'` — `"-leading"` starts passing and the refusal loop reddens. Flip
/// the length comparison to `< 40` instead and the ACCEPTED `"k".repeat(40)` case
/// reddens, which is the other direction of the same boundary.
#[test]
fn require_artifact_key_validates_the_grammar() {
    for accepted in [
        "spec",
        "research",
        "a",
        "a-b",
        "0x",
        "1hello",
        "k".repeat(40).as_str(),
    ] {
        assert_eq!(
            require_artifact_key(accepted).as_deref(),
            Ok(accepted),
            "`{accepted}` is inside the grammar and must pass UNCHANGED (this rule \
             rejects, it never cleans)"
        );
    }

    for refused in [
        "",                      // no first character at all
        "A",                     // uppercase is outside the Mention alphabet
        "_",                     // underscore too
        "a b",                   // a space would break an attribute-embedded key
        "a/b",                   // a path separator
        "a<b",                   // THE injection point: closes a tag
        "a\"b",                  // and the other one: closes an attribute
        "-leading",              // a hyphen is not a legal FIRST character
        "k".repeat(41).as_str(), // 41 is one over the cap
    ] {
        let err = require_artifact_key(refused)
            .expect_err("`{refused}` is outside the grammar and must be refused");
        assert!(
            matches!(err, TasksError::BadArtifactKey(ref key) if key == refused),
            "the refusal names the offending key verbatim; got {err:?}"
        );
        assert_eq!(
            err.kind(),
            "bad_artifact_key",
            "the wire kind is a frozen string the frontend branches on (ADR 0063)"
        );
        let message = err.to_string();
        assert!(
            message.contains(refused) && message.contains("[a-z0-9][a-z0-9-]{0,39}"),
            "the sentence names BOTH the key and the grammar, so a caller \
             self-corrects without a second call; got {message}"
        );
    }
}

/// (a bad key writes NOTHING) the refusal happens before any statement runs, so
/// the database is untouched — the `require_title` ordering rule, at the artifact
/// seam (spec §1: "a rejection writes nothing").
///
/// MUTATION: move the `require_artifact_key` call AFTER the `write_artifact`
/// execute — the row lands and the second assertion reddens.
#[test]
fn a_bad_key_writes_nothing() {
    let dir = ScratchDir::in_env_temp("cmd-artifact-badkey-", "scratch");
    let path = dir.join("t.db");
    let (db, task_id) = db_with_task(&dir, "bad-key");

    let err = write_artifact_core(&db, &task_id, "Bad Key", "markdown")
        .expect_err("a key outside the grammar is refused");
    assert!(
        matches!(err, TasksError::BadArtifactKey(_)),
        "and it is the grammar refusal, not something downstream; got {err:?}"
    );
    assert_eq!(
        artifact_rows(&path).len(),
        0,
        "a rejection writes NOTHING — the card is not written and then renamed, it \
         is never written"
    );
}

/// (the 256 KB cap, spec §1) over the cap is refused naming BOTH the limit and
/// the actual size, and exactly at the cap is ACCEPTED.
///
/// Refused, NEVER truncated: a spec that silently ends mid-sentence reads as a
/// complete spec, which is the confident-well-formed-lie shape this repo keeps
/// documenting. The boundary case is the half that a `>=`/`>` slip changes, so it
/// is asserted rather than assumed.
///
/// MUTATION: compare with `>=` instead of `>` — the exactly-at-the-cap write
/// reddens while the 257 KB case stays green.
#[test]
fn an_oversized_markdown_is_refused_naming_limit_and_size() {
    let dir = ScratchDir::in_env_temp("cmd-artifact-size-", "scratch");
    let path = dir.join("t.db");
    let (db, task_id) = db_with_task(&dir, "oversized");

    let oversized = "x".repeat(MAX_ARTIFACT_MARKDOWN_BYTES + 1);
    let err = write_artifact_core(&db, &task_id, "spec", &oversized)
        .expect_err("257 KB is over the cap and must be refused");
    assert_eq!(err.kind(), "artifact_too_large", "the frozen wire kind");
    let message = err.to_string();
    assert!(
        message.contains("262144") && message.contains("256"),
        "the sentence names the limit in BYTES and in the human 256 KB spelling; \
         got {message}"
    );
    assert!(
        message.contains(&(MAX_ARTIFACT_MARKDOWN_BYTES + 1).to_string()),
        "…AND the size it was actually handed, so the caller knows how far over \
         it is; got {message}"
    );
    assert_eq!(
        artifact_rows(&path).len(),
        0,
        "and nothing was written — no truncated artifact exists"
    );

    // The boundary: EXACTLY the cap is legal (`>`, not `>=`).
    let at_the_cap = "y".repeat(MAX_ARTIFACT_MARKDOWN_BYTES);
    let meta = write_artifact_core(&db, &task_id, "spec", &at_the_cap)
        .expect("a payload of EXACTLY 256 KB is accepted — the cap is a ceiling");
    assert_eq!(
        meta.bytes, MAX_ARTIFACT_MARKDOWN_BYTES,
        "and the meta reports the byte count it stored"
    );
    assert_eq!(
        meta.key, "spec",
        "the meta is identity + stamp + size, never the content"
    );
    assert_eq!(artifact_rows(&path).len(), 1, "the legal write landed");
}

/// (`write_artifact`, the wire-level gate) a `task_id` that does not exist is
/// refused as `not_found` and writes nothing.
///
/// This is the refusal ADR 0100 singles out: `task_artifacts.task_id` has NO
/// foreign key, so SQLite will not catch a dangling id and this layer has to.
/// `Db::write_artifact` refuses one too — BOTH refuse, deliberately.
///
/// MUTATION: delete the `get_task` gate in the core — the storage layer's own
/// gate still refuses, so this test stays green and the belt-and-suspenders claim
/// is what is being pinned; delete BOTH and the `not_found` kind reddens.
#[test]
fn write_artifact_refuses_a_missing_task_not_found() {
    let dir = ScratchDir::in_env_temp("cmd-artifact-notfound-", "scratch");
    let path = dir.join("t.db");
    let (db, _id) = db_with_task(&dir, "missing-task");

    let err = write_artifact_core(&db, "tsk_missing", "spec", "content")
        .expect_err("there is no FK to catch a dangling task_id, so this layer must");
    assert!(
        matches!(err, TasksError::NotFound(ref message) if message.contains("tsk_missing")),
        "`NotFound` naming the id; got {err:?}"
    );
    assert_eq!(
        err.kind(),
        "not_found",
        "the wire kind is the EXISTING `not_found` — `From<BoardError>` already maps \
         `MissingTask` there, so no new string was needed"
    );
    assert_eq!(
        artifact_rows(&path).len(),
        0,
        "and a refusal writes nothing"
    );
}

/// (the storage backstop keeps the SAME wire envelope) `BoardError::BadArtifactKey`
/// / `ArtifactTooLarge` map onto `TasksError::BadArtifactKey` / `ArtifactTooLarge`
/// so that the serialized envelope is **byte-identical** to the one the command's
/// own pre-flight produces for the same input.
///
/// WHY THIS IS A TEST AND NOT A CLAIM. Storage now enforces both rules as the
/// backstop for the `TaskStore` seam, and the command layer keeps its pre-flight
/// checks for the nicer message and the avoided round trip. That split is only safe
/// if the two routes are indistinguishable on the wire: AGENTS.md records that the
/// ADR 0063 envelope has several sites that must all agree, and `kind` is what
/// `store/tasks.ts` branches on while `message` is what `TasksBoard.tsx` renders
/// under `role="alert"`. A `Display` sentence edited in one family and not the
/// other would put two different messages on the screen for one mistake, and no
/// existing test compared the two families — each was pinned against itself.
///
/// THE ROUTES ACTUALLY DRIVEN are the two real doors, not hand-built variants: a
/// call through [`write_artifact_core`] (refused by the command's pre-flight, never
/// reaching storage) and a call straight to `Db::write_artifact` (the door the
/// `TaskStore` seam uses, which skips the pre-flight and is refused by the backstop).
/// Comparing the built `InvokeError` payloads with `==` — not merely the `kind` —
/// covers `kind`, the full `message` sentence, AND the `artifact_too_large`
/// `size`/`max` numbers in one assertion.
///
/// MUTATION: change the `{max} bytes (256 KB)` wording in ONE of the two `Display`
/// attributes and the size case reddens on `message` while `kind` stays green —
/// which is exactly the drift this test exists to catch.
#[test]
fn the_storage_artifact_refusals_keep_the_command_envelope_exactly() {
    let dir = ScratchDir::in_env_temp("cmd-artifact-envelope-", "scratch");
    let (db, task_id) = db_with_task(&dir, "same-envelope");

    // ── the key refusal, through BOTH doors ─────────────────────────────────
    for key in ["My Spec", "a<b", ""] {
        let via_command = write_artifact_core(&db, &task_id, key, "markdown")
            .expect_err("the command's pre-flight refuses `{key}`");
        let via_storage = TasksError::from(
            db.write_artifact(&task_id, key, "markdown")
                .expect_err("the storage backstop refuses `{key}` too"),
        );
        assert!(
            matches!(via_command, TasksError::BadArtifactKey(_)),
            "the command route is the grammar refusal, not something downstream; \
             got {via_command:?}"
        );
        assert_eq!(
            tauri::ipc::InvokeError::from(via_command).0,
            tauri::ipc::InvokeError::from(via_storage).0,
            "a key refused by storage must reach the wire EXACTLY as one refused by \
             the command — same kind, same sentence (ADR 0063)"
        );
    }

    // ── the size refusal, through BOTH doors ────────────────────────────────
    let oversized = "z".repeat(MAX_ARTIFACT_MARKDOWN_BYTES + 7);
    let size = oversized.len();
    let via_command = write_artifact_core(&db, &task_id, "spec", &oversized)
        .expect_err("the command's pre-flight refuses an oversized markdown");
    let via_storage = TasksError::from(
        db.write_artifact(&task_id, "spec", &oversized)
            .expect_err("the storage backstop refuses it too"),
    );
    let command_wire = tauri::ipc::InvokeError::from(via_command).0;
    let storage_wire = tauri::ipc::InvokeError::from(via_storage).0;
    assert_eq!(
        command_wire, storage_wire,
        "an oversized document refused by storage must carry the same `kind`, the \
         same sentence, and the same `size`/`max` numbers as one refused by the \
         command; command={command_wire} storage={storage_wire}"
    );
    assert_eq!(
        command_wire["kind"],
        serde_json::json!("artifact_too_large"),
        "and the kind is still the frozen string the frontend branches on"
    );
    assert_eq!(
        (command_wire["size"].as_u64(), command_wire["max"].as_u64()),
        (Some(size as u64), Some(MAX_ARTIFACT_MARKDOWN_BYTES as u64)),
        "the numbers survive the storage route too — a frontend that reads `size` \
         must not have to know which layer refused"
    );

    // Neither door wrote anything, on either refusal.
    assert_eq!(
        artifact_rows(&dir.join("t.db")).len(),
        0,
        "both doors refuse and both write NOTHING"
    );
}

/// (`get_artifact`) `null` for a missing artifact AND for a missing Task, and the
/// whole document for a real one.
///
/// The READ path never refuses where the WRITE path does: asking for something
/// that is not there is an answer, not an error (the `getTask` shape, spec §2).
///
/// MUTATION: gate `get_artifact_core` on `get_task` and return `Err` for a
/// missing Task — the first assertion reddens.
#[test]
fn get_artifact_answers_null_for_a_missing_artifact_and_a_missing_task() {
    let dir = ScratchDir::in_env_temp("cmd-artifact-get-", "scratch");
    let (db, task_id) = db_with_task(&dir, "get-artifact");

    assert_eq!(
        get_artifact_core(&db, "tsk_missing", "spec").expect("a read never errors"),
        None,
        "a missing TASK is `None`, not an error"
    );
    assert_eq!(
        get_artifact_core(&db, &task_id, "no-such-key").expect("a read never errors"),
        None,
        "and a missing ARTIFACT answers the same way"
    );

    write_artifact_core(&db, &task_id, "spec", "# Finding\n\nthe content").expect("write");
    let found = get_artifact_core(&db, &task_id, "spec")
        .expect("read")
        .expect("the artifact is there");
    assert_eq!(
        found,
        Artifact {
            task_id: task_id.clone(),
            key: "spec".to_string(),
            markdown: "# Finding\n\nthe content".to_string(),
            created_at: found.created_at,
            updated_at: found.updated_at,
        },
        "the single-artifact read is the ONE place content crosses the wire, and it \
         carries all five fields"
    );
    assert!(
        found.created_at > 0 && found.updated_at >= found.created_at,
        "both stamps are real clock values, not zero placeholders"
    );
}

/// (the D1 boundary, pinned from the source text) the two artifact commands are
/// registered in `lib.rs`'s `generate_handler!` list.
///
/// An unregistered command is a `command write_artifact not found` in the running
/// app and NOTHING in the Rust suite can see it — `tests/ipc.rs` declares its own
/// handler list — hence the source-text pin (the `start_task_session_is_registered
/// _in_the_invoke_handler` and `tests/provider_oidc.rs` precedent).
#[test]
fn artifacts_commands_are_registered_in_the_invoke_handler() {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("src/lib.rs reads");
    for verb in [
        "commands::tasks::write_artifact,",
        "commands::tasks::get_artifact,",
    ] {
        assert!(
            lib.contains(verb),
            "`{verb}` is missing from lib.rs's generate_handler! list — the wrapper \
             would reject at runtime with `command not found`"
        );
    }
}

/// (the D2 boundary, pinned from the source text) the `<artifacts>` block and the
/// verbs that answer it exist TOGETHER, or neither does.
///
/// This test is D1's `d1_ships_no_model_facing_artifact_verb`, INVERTED rather than
/// deleted, and the reason to keep it under a new name is that the hazard it guards
/// did not go away when D2 landed — it changed shape.
///
/// D1's version guarded a WINDOW: D1 ships artifacts a human can use while no model
/// verb exists, so an `<artifacts>` line in `taskBlock` at that moment would tell
/// every Session "there is a spec, go read it" with no verb to read it with, which
/// invites the model to `read` the very `docs/roadmap/` file `finish` deletes on ship
/// (spec, "Why `<artifacts>` waits for D2"). D2 closes that window, so the old
/// assertion's subject no longer exists — it was written to redden on exactly this
/// change (its own MUTATION note named the `<artifacts>` line).
///
/// What IS still true, and now worth pinning harder, is the PAIRING. The launch block
/// and the answering seam are one feature: the block alone is the D1 bug (a promise
/// with no verb), and the seam alone is a wire nobody tells the model about. So the
/// three D2 pieces are asserted as a unit — `taskBlock`'s `<artifacts>` line, the
/// `impl TaskStore for Db`, and the `TaskRequest` router arm. The third is the one
/// that makes this more than a checklist: the pin bump and that arm are ONE COMMIT by
/// D2's atomicity rule, because `route_event` matches `WorkerInboundEvent`
/// exhaustively with no `_` arm, so the block, the impl and the arm are the three
/// faces of a change that cannot be half-shipped.
///
/// The files scanned are the three a partial D2 would have to leave inconsistent,
/// plus `agent/harness/mod.rs`, which D1 scanned for a model-facing surface and which
/// still must not grow one: the task tools are registered in the published
/// `fulcrum-harness` crate (F1's step), and a second desktop-side registration would
/// be a second owner of the tool list.
///
/// MUTATIONS: delete the `<artifacts>` line from `taskBlock` → the first assertion
/// reddens. Delete `impl TaskStore for Db` → the second. Delete the router arm (or
/// leave the crate pinned at 0.1.x, where the variant does not exist) → the third.
#[test]
fn d2_ships_the_artifacts_block_and_the_verbs_that_answer_it_together() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let required = [
        (
            format!("{manifest}/../src/lib/taskPrompt.ts"),
            "<artifacts>",
            "the launch block tells a Session which artifact keys its card has",
        ),
        (
            format!("{manifest}/src/storage/db.rs"),
            "impl TaskStore for Db",
            "the desktop implements the crate's board seam on the `Db`",
        ),
        (
            format!("{manifest}/src/agent/session/router.rs"),
            "WorkerInboundEvent::TaskRequest",
            "the Supervisor answers the Worker's task-request frame",
        ),
    ];
    for (path, needle, why) in required {
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("`{path}` reads (the pin's premise): {e}"));
        // STRIP COMMENTS FIRST, and this is the load-bearing line of the whole test.
        // Every one of these three needles ALSO appears in a doc comment — mine, and
        // this test's own prose — so scanning raw source makes the pin pass on
        // commentary after the code is deleted. `toolDetailsRegistry.test.ts` records
        // being bitten by exactly this ("a doc-comment that MENTIONS `details.error`
        // is prose about the wire, not a read of it"), and the mutation that proves it
        // here: rename the tag `taskBlock` EMITS to `<artifactList>` and leave the two
        // `<artifacts>` mentions in its doc comment, and an un-stripped scan stays
        // green. It reddens under this one.
        let code = strip_comments(&source);
        assert!(
            code.contains(needle),
            "`{path}` must CONTAIN `{needle}` in its code (comments stripped) in D2 — \
             {why}. One of the three without the others is a half-shipped feature: the \
             block alone is D1's bug (a promise with no verb behind it), the seam alone \
             is a wire no Session is ever told about"
        );
    }

    // The desktop side still owns NO tool registration. The seven task tools are
    // `tool_specs()` entries in the published crate, and `agent/harness/mod.rs` is
    // where this repo assembles its own tool surface — a task verb appearing there
    // would be a second, desktop-side registration of a list the crate already owns.
    let harness = format!("{manifest}/src/agent/harness/mod.rs");
    let source = std::fs::read_to_string(&harness)
        .unwrap_or_else(|e| panic!("`{harness}` reads (the pin's premise): {e}"));
    let code = strip_comments(&source);
    for needle in ["TaskStore", "write_artifact", "get_artifact"] {
        assert!(
            !code.contains(needle),
            "`{harness}` must not mention `{needle}` in its code — the task tools are \
             registered in the `fulcrum-harness` crate (F1), and a desktop-side \
             registration would be a second owner of the advertised tool list"
        );
    }
}

/// The stripper, pinned directly — because the test above is only as honest as this
/// function, and a stripper that silently deleted everything would make the pin pass
/// vacuously in the OTHER direction (a required word survives only if real code is
/// scanned).
///
/// The three cases are the three shapes the scanned files actually contain: a `///`
/// doc line, a `/** … */` JSDoc block (`taskPrompt.ts`), and a code line that must
/// SURVIVE. The last one is the vacuity guard.
#[test]
fn the_comment_stripper_removes_prose_and_keeps_code() {
    let source = "/// a doc line mentioning `TaskStore`\n//! a module doc\n\
                  /** a JSDoc block with `impl TaskStore for Db` in it */\n\
                  impl TaskStore for Db {\n    // a trailing note\n    fn f() {}\n}\n";
    let stripped = strip_comments(source);
    assert!(
        !stripped.contains("doc line mentioning"),
        "a doc comment's prose is stripped — got {stripped}"
    );
    assert!(
        !stripped.contains("JSDoc block"),
        "a block comment's prose is stripped — got {stripped}"
    );
    assert!(
        stripped.contains("impl TaskStore for Db {"),
        "the CODE line survives — this is the vacuity guard: a stripper that deleted \
         everything would make the pin green on nothing. Got {stripped}"
    );
    assert!(
        stripped.contains("fn f()"),
        "code below a comment still survives — got {stripped}"
    );
    // The `docs/roadmap/*.md` shape that broke a block-first implementation: the `/*`
    // lives in a `///` line, so the line pass must remove it before the block pass.
    let tricky = "/// cites `docs/roadmap/*.md` for the rule\nreal_code();\n";
    assert_eq!(
        strip_comments(tricky).trim(),
        "real_code();",
        "a `/*` inside a doc comment must not swallow the file"
    );
}

/// Strip comments so a source-text pin reads CODE and not commentary.
///
/// LINE comments go first and that order is load-bearing, not stylistic: `db.rs`
/// documents a path as `docs/roadmap/*.md` inside a `///` comment, and `/*` there
/// would open a block that never closes — so a block-first stripper deletes the rest
/// of the file and the pin fails for a reason that has nothing to do with the code.
/// Dropping the `///` line first makes that `/*` vanish with it. The block pass then
/// handles the real `/** … */` JSDoc of `taskPrompt.ts`, which is the only scanned
/// file with block comments left in it once its `//` lines are gone.
///
/// Crude where crudeness is safe: neither pass parses string literals, so a `//`
/// inside a string literal truncates that line (`router.rs:991`'s
/// `"https://example.com"` test fixture is the one instance in the scanned files, and
/// it names no needle). The direction of that error is what makes it acceptable — a
/// dropped span can only REMOVE text, so for the required-word scan it can only cause
/// a false RED: loud, names the file, one line to fix. For the forbidden-word scan it
/// is a potential false GREEN, so `agent/harness/mod.rs` was checked by hand and
/// carries no `//` or `/*` inside a string literal at all.
fn strip_comments(source: &str) -> String {
    let lineless = source
        .lines()
        // A whole-line `//`, which is what `///` and `//!` are.
        .filter(|line| !line.trim_start().starts_with("//"))
        // …and a trailing `//` span.
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut code = String::with_capacity(lineless.len());
    let mut rest = lineless.as_str();
    while let Some(start) = rest.find("/*") {
        code.push_str(&rest[..start]);
        rest = match rest[start + 2..].find("*/") {
            // Skip the whole block, `*/` included.
            Some(end) => &rest[start + 4 + end..],
            None => "",
        };
    }
    code.push_str(rest);
    code
}
