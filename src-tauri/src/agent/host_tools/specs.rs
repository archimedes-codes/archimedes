//! The EIGHT host `ToolSpec`s, as the DESKTOP advertises them.
//!
//! Seven of them were `fulcrum-harness` 0.7.0's `harness/tool_specs.rs` entries 20–26.
//! F3 deleted them from the crate (`tool_specs()` 26 → 19) and ADR 0102 §2.3 moves the
//! advertisement to a HOST tool: a spec crosses the boundary as DATA on
//! `StartEnv::host_tools` and the ENGINE composes `builtins() ++ host_entries`. So
//! this file is where the desktop's side of that advertised surface now lives, and
//! it is the first spec text this repo has ever owned. The eighth, `mark_done`, is the
//! first spec text this repo has ever WRITTEN — it has no 0.7.0 ancestor, and the
//! byte-identity rule below therefore does not reach it.
//!
//! # The seven texts are carried over VERBATIM, and that is a correctness rule
//!
//! ADR 0102's byte-identity rule is that the model sees ONE description per tool.
//! These strings are what 0.7.0 sent for the same seven names, so a Session that
//! existed before this commit reads the same instructions after it. Re-authoring one
//! is a prompt change wearing a refactor's clothes — it moves model behaviour
//! silently, and nothing in the Rust suite can see it. What pins the seven NAMES and
//! the shape of each `parameters` block is `super::tests::surface` — the in-crate
//! mirror of this module (`agent/tests/tool_surface.rs` does not exist and never did;
//! the citation this paragraph carried was false) — and the descriptions are pinned by
//! the rule in this paragraph and by review, not by a re-spelled literal (a second
//! copy of a string is a second owner of it).
//!
//! # HARD CONSTRAINT on every string below
//!
//! No substring `read`, no substring `subagent` — not in a description, not in a
//! parameter description, not even inside a word. Both render into the prompt's
//! `<tools>` section. The live enforcer is
//! `no_host_tool_spec_names_read_or_subagent` in `super::tests`, over the WHOLE spec
//! (name, description AND parameters) — `worker_e2e.rs` used to carry a substring
//! assertion over the whole rendered section and issue #180 F1 replaced it with an
//! ENUMERATED-NAMES assertion, because `read` and `subagent` are ENGINE tool NAMES and
//! a substring test over a section that advertises them can never be satisfied. So
//! this ban has exactly one owner in this repo and it is that in-crate test; the
//! substring form is preserved there precisely because a description carrying either
//! word makes any weaker check PASS WHILE PROVING NOTHING. Hence "fetch" / "load" /
//! "show" instead of "read". MEASURED, not inherited: `thread`, `already`, `spread`,
//! `reads` and bare `read` all contain the banned substring, and so does `ready` —
//! which is why the eighth spec below talks about a flag and a claim and never about
//! readiness. `threshold` does NOT contain it (`t-h-r-e-s`) and was never in fact
//! banned; the list this paragraph carried before `mark_done` was written included it
//! on nothing, and a ban that cannot be measured is a ban someone forgets.
//!
//! 0.7.0 enforced this from inside the crate
//! (`no_task_tool_description_names_read_or_subagent`). That test is deleted with
//! the crate's specs, so the ban would die silently — which is why the in-crate test
//! named above re-establishes it here.

use serde_json::json;

use crate::agent::harness::ToolSpec;

/// The seven board / artifact verbs IN 0.7.0's `tool_specs()` order, then the eighth.
///
/// The ORDER is load-bearing for one thing only — it is the order the composed
/// advertised set puts them in, after the 19 engine specs. Keep the first seven stable
/// so a `<tools>` section diff between 0.7.0 and now is empty for those seven;
/// `mark_done` is NEW, so it appends and moves nothing.
pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "list_board".into(),
            description: "List the task board for a space — one row per card (titles, \
                          stage slugs, artifact key names only; never content)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "space_path": { "type": "string", "description": "The space whose board to list" }
                },
                "required": ["space_path"]
            }),
        },
        ToolSpec {
            name: "get_task".into(),
            description: "Fetch one task's full row by id.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "The task id" }
                },
                "required": ["task_id"]
            }),
        },
        ToolSpec {
            name: "create_task".into(),
            description: "Create a task on a space's board (a space starts on its first \
                          stage)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "space_path": { "type": "string", "description": "The space to create the task in" },
                    "title": { "type": "string", "description": "The task title" },
                    "body": { "type": "string", "description": "Optional task body (prose)" },
                    "stage_slug": { "type": "string", "description": "Optional starting stage (defaults to the space's first stage)" }
                },
                "required": ["space_path", "title"]
            }),
        },
        ToolSpec {
            name: "edit_task".into(),
            description: "Edit a task's title, body or spec path by id.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "The task id" },
                    "title": { "type": "string", "description": "Optional new title" },
                    "body": { "type": "string", "description": "Optional new body (prose)" },
                    "spec_path": { "type": "string", "description": "Optional new spec path" }
                },
                "required": ["task_id"]
            }),
        },
        ToolSpec {
            name: "move_task".into(),
            description: "Move a task to another stage.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "space_path": { "type": "string", "description": "The space the task lives in" },
                    "task_id": { "type": "string", "description": "The task id" },
                    "to_stage": { "type": "string", "description": "The destination stage slug" }
                },
                "required": ["space_path", "task_id", "to_stage"]
            }),
        },
        ToolSpec {
            name: "get_artifact".into(),
            description: "Fetch a task's named artifact as full markdown (the board row \
                          lists key names only)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "The task id" },
                    "key": { "type": "string", "description": "The artifact key" }
                },
                "required": ["task_id", "key"]
            }),
        },
        ToolSpec {
            name: "write_artifact".into(),
            description: "Write a named markdown artifact for a task (upserts; refused \
                          over 256 KiB)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "The task id" },
                    "key": { "type": "string", "description": "The artifact key" },
                    "markdown": { "type": "string", "description": "The full markdown to store" }
                },
                "required": ["task_id", "key", "markdown"]
            }),
        },
        // The eighth, and the first spec text this repo has ever WRITTEN. Its
        // vocabulary is deliberate: every word here is one the `read`/`subagent`
        // substring ban above permits, and the flag is called a FLAG and a CLAIM
        // throughout because the obvious noun for it (`…ready`) contains the banned
        // substring. No `parameters` beyond an empty object, because the subject is
        // the calling Session and arrives on the frame — see `exec::session::mark_done`.
        ToolSpec {
            name: "mark_done".into(),
            description: "Flag THIS Session as done and hand it to a person. Call it when \
                          the work on this Session is finished and a human should look at \
                          it. It is also the ONLY way a card moves FORWARD on the board: \
                          the answer names the column it advanced to, or says plainly why \
                          it stayed where it was. The flag itself clears at the start of \
                          your next turn. The one argument is optional and names which \
                          transition to take when this column has more than one; leave it \
                          out to take the first."
                .into(),
            // THE VOCABULARY IS THE DIFFICULT HALF, and every value below was measured
            // against the ban at the top of this file. `needs_review` and bare `review`
            // LOOK cleared in the plan that drafted this list and are not: `review`
            // contains the substring `read` (`r-e-v-i-e-w`), so it fails the same test
            // `ready` fails. `done`/`failed`/`error`/`success`/`blocked`/`partial`/
            // `finished`/`complete`/`handoff` are the survivors, and the sentence above
            // says "transition" rather than the obvious four-letter word for a board's
            // second column for the same reason. A model that sends a value NOT in this
            // list is not refused — the head edge fires and the answer says so — because
            // an unlabelled board is the ordinary case and an invented name must not
            // stall a chain.
            parameters: json!({
                "type": "object",
                "properties": {
                    "outcome": {
                        "type": "string",
                        "enum": ["done", "failed", "error", "success", "blocked",
                                 "partial", "finished", "complete", "handoff"],
                        "description": "Which transition to take out of this column, when \
                                        more than one is wired. Omit it to take the first."
                    }
                },
                "required": []
            }),
        },
    ]
}
