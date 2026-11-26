//! The advertised-surface half: the eight specs' NAMES, their parameter blocks, and
//! the two invariants that make the composed advertised set provable from this side.
//!
//! The crate owns the census that spans both halves
//! (`the_composed_advertised_set_is_exactly_the_twenty_six_names`); what these
//! assertions own is the desktop's contribution to it, which the crate cannot see.

use std::collections::HashSet;

use crate::agent::harness::tool_specs;
use crate::agent::host_tools::host_tool_specs;

/// The eight host verbs: the seven that sat in 0.7.0's `tool_specs()`, then
/// `mark_done` — the one this repo wrote and the one no 0.7.0 Session ever saw.
///
/// Spelled as a literal ON PURPOSE. Deriving the expected set from
/// `host_tool_specs()` would make the assertion tautological — it could only fail by
/// the two sides agreeing on the same wrong thing. A drop here is what ADR 0102's
/// 26-name census catches crate-side, and this is the desktop-side half of that.
const HOST_TOOL_NAMES: [&str; 8] = [
    "list_board",
    "get_task",
    "create_task",
    "edit_task",
    "move_task",
    "get_artifact",
    "write_artifact",
    "mark_done",
];

#[test]
fn host_tool_specs_are_exactly_the_eight_host_verbs_in_order() {
    let names: Vec<String> = host_tool_specs().into_iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        HOST_TOOL_NAMES
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        "the desktop contributes EXACTLY these eight specs — the seven of ADR 0102 \
         in 0.7.0's order and `mark_done` appended — because a drop here is a tool \
         advertised to no one, an addition is a second host tool beyond the eight this \
         repo has grounds for, and a REORDER of the first seven moves the `<tools>` \
         section a 0.7.0 Session was advertised"
    );
}

#[test]
fn the_eight_host_specs_are_disjoint_from_the_engine_advertised_set() {
    // The disjointness half of ADR 0102 §2.2's census, from this side: if the crate
    // ever re-adds one of these to `tool_specs()`, the composed set advertises it
    // TWICE and the model sees one tool with two descriptions.
    let engine: HashSet<String> = tool_specs().into_iter().map(|s| s.name).collect();
    for name in HOST_TOOL_NAMES {
        assert!(
            !engine.contains(name),
            "`{name}` is in the engine's `tool_specs()` AND in the desktop's host \
             specs — the composed advertised set would carry it twice. F3 moved the \
             seven here and `mark_done` was never the crate's; neither may be in both.",
        );
    }
    assert_eq!(
        engine.len(),
        19,
        "the engine advertises 19 built-ins since F3 (26 minus the seven board verbs) \
         — a different number means the crate's half of the surface moved again, and \
         this commit's claim that the MODEL sees the same 26 names it saw at 0.7.0 \
         needs re-verifying"
    );
}

#[test]
fn the_composed_advertised_set_is_the_twenty_six_names_plus_mark_done() {
    // The invariant ADR 0102 makes the whole refactor safe: SAME NAMES TO THE MODEL,
    // different owners underneath — COMPOSED the way the engine composes it,
    // `builtins() ++ host_entries(env.host_tools)`. `mark_done` is then the single
    // DELIBERATE addition to that set, which is why it sits at the end of this list
    // rather than being folded into the 26: a list that quietly grew by one would
    // make this assertion unable to tell "the seven owners moved" from "the surface
    // changed", and that distinction is the whole claim ADR 0102 is making.
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
            "mark_done",
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
         0.7.0 PLUS `mark_done`. Those 26 were MEASURED off `fulcrum-harness` 0.7.0's \
         `tool_specs()` (26 names), not copied from the parent doc — which enumerates \
         a `dispatch_subagent` that is not a production spec there and omits `ls`, \
         which is. `sorted` is deduped, so a name in BOTH halves collapses and shows \
         up as a MISSING name rather than a duplicate — the count and the contents \
         together pin both."
    );
    assert_eq!(
        names.len(),
        27,
        "and 27 WITHOUT dedup — 26 unchanged names plus `mark_done`, and no name in \
         both halves"
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
    // sets below are the ones `exec/board.rs` actually calls `req_str`/`opt_str` on,
    // and the `required` arrays are what the model is told it must send.
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
        // The one verb with NO keys at all, and the row that keeps it that way: its
        // subject is the frame's origin id, so a parameter here would be a session id
        // the model chose. `exec/session.rs` calls neither `req_str` nor `opt_str` —
        // it reads no `params` whatsoever — and an advertised key with no reader is
        // exactly what this table exists to catch.
        ("mark_done", &[] as &[&str], &[] as &[&str]),
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
