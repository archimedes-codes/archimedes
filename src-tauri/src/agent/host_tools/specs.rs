//! The SEVEN board / artifact `ToolSpec`s, as the DESKTOP advertises them.
//!
//! These were `fulcrum-harness` 0.7.0's `harness/tool_specs.rs` entries 20–26. F3
//! deleted them from the crate (`tool_specs()` 26 → 19) and ADR 0102 §2.3 moves the
//! advertisement to a HOST tool: a spec crosses the boundary as DATA on
//! `StartEnv::host_tools` and the ENGINE composes `builtins() ++ host_entries`. So
//! this file is where the desktop's side of that advertised surface now lives, and
//! it is the first spec text this repo has ever owned.
//!
//! # The texts are carried over VERBATIM, and that is a correctness rule
//!
//! ADR 0102's byte-identity rule is that the model sees ONE description per tool.
//! These strings are what 0.7.0 sent for the same seven names, so a Session that
//! existed before this commit reads the same instructions after it. Re-authoring one
//! is a prompt change wearing a refactor's clothes — it moves model behaviour
//! silently, and nothing in the Rust suite can see it. `agent/tests/tool_surface.rs`
//! pins the seven names and the shape of each `parameters` block; the descriptions
//! are pinned by the rule in this paragraph and by review, not by a re-spelled
//! literal (a second copy of a string is a second owner of it).
//!
//! # HARD CONSTRAINT on every string below
//!
//! No substring `read`, no substring `subagent` — not in a description, not in a
//! parameter description, not even inside a word. Both render into the prompt's
//! `<tools>` section, and `src-tauri/tests/worker_e2e.rs` asserts
//! `!tools_section.contains("read") && !tools_section.contains("subagent")` as a
//! SUBSTRING test over the WHOLE rendered section. A description carrying either
//! word makes that assertion PASS WHILE PROVING NOTHING — a silent CI weakening,
//! not a failure, and it only shows on the Windows leg. Hence "fetch" / "load" /
//! "show" instead of "read", and no `thread` / `already` / `spread` / `reads` /
//! `threshold` either (all contain `read`).
//!
//! 0.7.0 enforced this from inside the crate
//! (`no_task_tool_description_names_read_or_subagent`). That test is deleted with
//! the crate's specs, so the ban would die silently — which is why
//! `no_host_tool_spec_names_read_or_subagent` in `super::tests` re-establishes it
//! here, over the WHOLE spec (name, description AND parameters), not just the
//! description.

use serde_json::json;

use crate::agent::harness::ToolSpec;

/// The seven board / artifact verbs, in the order they sat in 0.7.0's `tool_specs()`.
///
/// The ORDER is load-bearing for one thing only — it is the order the composed
/// advertised set puts them in, after the 19 engine specs. Keep it stable so a
/// `<tools>` section diff between 0.7.0 and now is empty for these seven.
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
    ]
}
