//! The advertised-surface half: the seven specs' NAMES, their parameter blocks, and
//! the two invariants that make the composed advertised set provable from this side.
//!
//! The crate owns the census that spans both halves
//! (`the_composed_advertised_set_is_exactly_the_twenty_six_names`); what these
//! assertions own is the desktop's contribution to it, which the crate cannot see.

use std::collections::HashSet;

use crate::agent::harness::tool_specs;
use crate::agent::host_tools::host_tool_specs;

/// The seven host verbs, in the order they sat in 0.7.0's `tool_specs()`.
///
/// Spelled as a literal ON PURPOSE. Deriving the expected set from
/// `host_tool_specs()` would make the assertion tautological — it could only fail by
/// the two sides agreeing on the same wrong thing. A drop here is what ADR 0102's
/// 26-name census catches crate-side, and this is the desktop-side half of that.
const HOST_TOOL_NAMES: [&str; 7] = [
    "list_board",
    "get_task",
    "create_task",
    "edit_task",
    "move_task",
    "get_artifact",
    "write_artifact",
];

#[test]
fn host_tool_specs_are_exactly_the_seven_board_and_artifact_verbs_in_order() {
    let names: Vec<String> = host_tool_specs().into_iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        HOST_TOOL_NAMES
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        "the desktop contributes EXACTLY these seven specs, in 0.7.0's order — a drop \
         here is a tool advertised to no one, an addition is a second host tool \
         beyond the seven ADR 0102 §5 allows, and a reorder moves the `<tools>` \
         section"
    );
}

#[test]
fn the_seven_host_specs_are_disjoint_from_the_engine_advertised_set() {
    // The disjointness half of ADR 0102 §2.2's census, from this side: if the crate
    // ever re-adds one of these seven to `tool_specs()`, the composed set advertises
    // it TWICE and the model sees one tool with two descriptions.
    let engine: HashSet<String> = tool_specs().into_iter().map(|s| s.name).collect();
    for name in HOST_TOOL_NAMES {
        assert!(
            !engine.contains(name),
            "`{name}` is in the engine's `tool_specs()` AND in the desktop's host \
             specs — the composed advertised set would carry it twice. F3 moved it \
             here; it must not be in both.",
        );
    }
    assert_eq!(
        engine.len(),
        19,
        "the engine advertises 19 built-ins since F3 (26 minus these seven) — a \
         different number means the crate's half of the 26-name surface moved again, \
         and this commit's claim that the MODEL sees the same 26 names needs \
         re-verifying"
    );
}

#[test]
fn the_composed_advertised_set_is_the_twenty_six_names_a_session_saw_before() {
    // The invariant ADR 0102 makes the whole refactor safe: SAME NAMES TO THE MODEL,
    // different owners underneath. Composed the way the engine composes it —
    // `builtins() ++ host_entries(env.host_tools)`.
    let mut names: Vec<String> = tool_specs().into_iter().map(|s| s.name).collect();
    names.extend(host_tool_specs().into_iter().map(|s| s.name));
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(
        sorted,
        [
            "ask",
            "bash",
            "codemode",
            "create_task",
            "edit",
            "edit_task",
            "fetch_content",
            "find",
            "get_artifact",
            "get_search_content",
            "get_task",
            "grep",
            "list_agents",
            "list_board",
            "list_skills",
            "ls",
            "manage_todo_list",
            "mcp",
            "move_task",
            "read",
            "read_skill",
            "subagent",
            "sudo_exec",
            "web_search",
            "write",
            "write_artifact",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>(),
        "the composed set must be EXACTLY the 26 names a Session was advertised at \
         0.7.0. This list was MEASURED off `fulcrum-harness` 0.7.0's `tool_specs()` \
         (26 names), not copied from the parent doc — which enumerates a \
         `dispatch_subagent` that is not a production spec there and omits `ls`, \
         which is. `sorted` is deduped, so a name in BOTH halves collapses and shows \
         up as a MISSING name rather than a duplicate — the count and the contents \
         together pin both."
    );
    assert_eq!(
        names.len(),
        26,
        "and 26 WITHOUT dedup — no name is in both halves"
    );
}

#[test]
fn no_host_tool_spec_names_read_or_subagent() {
    // 0.7.0 enforced this from inside the crate
    // (`no_task_tool_description_names_read_or_subagent`); that test is deleted with
    // the specs, so without this one the ban dies silently and the Windows-leg
    // substring assertion in `worker_e2e.rs` starts passing while proving nothing.
    // Over the WHOLE spec — name, description AND the parameters JSON.
    for spec in host_tool_specs() {
        let whole = format!(
            "{} {} {}",
            spec.name,
            spec.description,
            serde_json::to_string(&spec.parameters).expect("a spec's parameters serialize")
        );
        for banned in ["read", "subagent"] {
            assert!(
                !whole.contains(banned),
                "the `{}` spec contains the substring `{banned}`, which makes \
                 worker_e2e's `!tools_section.contains(\"{banned}\")` assertion pass \
                 while proving nothing — a silent CI weakening that only shows on the \
                 Windows leg. Whole spec: {whole}",
                spec.name,
            );
        }
    }
}

#[test]
fn every_host_tool_spec_advertises_the_keys_its_executor_reads() {
    // A spec that advertises a key the executor never reads (or omits one it
    // requires) is a tool whose documented interface and behaviour disagree. The key
    // sets below are the ones `exec.rs` actually calls `req_str`/`opt_str` on, and
    // the `required` arrays are what the model is told it must send.
    let cases: &[(&str, &[&str], &[&str])] = &[
        ("list_board", &["space_path"], &["space_path"]),
        ("get_task", &["task_id"], &["task_id"]),
        (
            "create_task",
            &["space_path", "title", "body", "stage_slug"],
            &["space_path", "title"],
        ),
        (
            "edit_task",
            &["task_id", "title", "body", "spec_path"],
            &["task_id"],
        ),
        (
            "move_task",
            &["space_path", "task_id", "to_stage"],
            &["space_path", "task_id", "to_stage"],
        ),
        ("get_artifact", &["task_id", "key"], &["task_id", "key"]),
        (
            "write_artifact",
            &["task_id", "key", "markdown"],
            &["task_id", "key", "markdown"],
        ),
    ];
    let specs = host_tool_specs();
    for (name, advertised, required) in cases {
        let spec = specs
            .iter()
            .find(|s| s.name == *name)
            .unwrap_or_else(|| panic!("no host spec named `{name}`"));
        let props = spec.parameters["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("`{name}` has no `properties` object"));
        let keys: HashSet<String> = props.keys().cloned().collect();
        let want: HashSet<String> = advertised.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            keys, want,
            "`{name}` advertises a different parameter set than its executor reads"
        );
        let req: Vec<String> = spec.parameters["required"]
            .as_array()
            .unwrap_or_else(|| panic!("`{name}` has no `required` array"))
            .iter()
            .map(|v| {
                v.as_str()
                    .expect("every `required` entry is a string")
                    .to_string()
            })
            .collect();
        assert_eq!(
            req,
            required.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            "`{name}`'s `required` list is what the model is told it must send — a \
             divergence from the executor's `req_str` calls is a tool that refuses \
             the calls its own documentation invites"
        );
    }
}

#[test]
fn every_host_tool_description_and_name_is_non_empty() {
    for spec in host_tool_specs() {
        assert!(
            !spec.name.is_empty() && !spec.description.is_empty(),
            "a spec with an empty name or description is an advertised tool the \
             model cannot use"
        );
        assert_eq!(
            spec.parameters["type"], "object",
            "`{}`'s parameters must be a JSON Schema object",
            spec.name
        );
    }
}
