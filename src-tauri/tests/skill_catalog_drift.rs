//! The skills-catalog anti-drift pin (ADR 0029 / 0036 / 0065), as a TWO-SIDED
//! desktop test.
//!
//! # Why this file exists (T5/S2)
//!
//! `the_prompt_catalog_and_the_list_skills_catalog_agree` lived in
//! `src-tauri/src/agent/tools/exec/tests/skills.rs` alongside the eleven
//! `list_skills`/`read_skill` tests it sits with. T5/S2 moved that file into
//! `crates/fulcrum-core`, and this ONE test could not come with it: it drives TWO
//! seams, and only one of them moved.
//!
//!   * Seam 2 (`list_skills` via `execute_tool`) is in the crate now.
//!   * Seam 1 (`build_main_prompt` / `PromptContext` from `harness/prompt.rs`) is
//!     NOT — `harness` is the tight internal cycle T5 moves LAST (S5).
//!
//! A crate unit test cannot name a desktop module: that edge is the package cycle
//! T5 exists to sever. So the test follows the rule Step D already states for the
//! other two-sided tests (`worker_e2e.rs`, `worker_smoke.rs`, `ipc.rs`, the four
//! `harness_*.rs`): **a test that spans the boundary lives on the side that can
//! see both halves**, which is the desktop. Its eleven siblings — which touch only
//! the crate's own seam — moved with their file.
//!
//! This is a RELOCATION, not a rewrite: the fixture, the six roots, the Shadowing
//! pair and every assertion are verbatim. The only edits are the paths the move
//! forces (`crate::` → `archimedes_lib::agent::`, and `crate::skills::` →
//! `archimedes_lib::skills::`, which the `agent/mod.rs` + `lib.rs` re-export
//! seams keep meaningful) and the scratch-dir prefix, explained at `temp_cwd`.
//!
//! # What would make this file wrong
//!
//! If S5 moves `harness` and someone folds this test back into the crate, the
//! crate gains a test that reaches a module it no longer owns — check that
//! `harness::prompt` is really in the crate BEFORE moving it back, and keep the
//! eleven siblings where they are either way.

use std::path::{Path, PathBuf};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use archimedes_lib::agent::harness::prompt::{build_main_prompt, PromptContext};
use archimedes_lib::agent::harness::provider::ToolSpec;
use archimedes_lib::agent::tools::{execute_tool, ToolCtx, ToolResult};
use archimedes_lib::skills::{discover_in_roots, SkillScope};
use archimedes_lib::test_support::ScratchDir;

/// A fresh temp dir as the sandbox `cwd`, OWNED (#96 task 08): removed when the
/// caller drops it. NOT `Clone` — `to_path_buf()` is the escape hatch.
///
/// The prefix is `skill-catalog-` and NOT the `exec-` the crate's own
/// `tests/support.rs` uses, and that is deliberate rather than cosmetic: the #96
/// census maps a prefix to the ONE file that mints it, and two files minting
/// `exec-` would send a reader hunting the wrong one. The relocated test gets its
/// own row in that table.
fn temp_cwd(tag: &str) -> ScratchDir {
    ScratchDir::in_env_temp("skill-catalog-", tag)
}

/// A skill root holding `<name>/SKILL.md`. Returns (GUARD, root path) — the
/// guard FIRST (#96 task 08): destructured locals drop in REVERSE declaration
/// order, so the `PathBuf` dies before the dir it names. The path travels as a
/// separate element because `ctx_with_roots` takes `&[PathBuf]`.
fn skill_root(tag: &str, name: &str, content: &str) -> (ScratchDir, PathBuf) {
    let root = temp_cwd(tag);
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), content).unwrap();
    let path = root.to_path_buf();
    (root, path)
}

/// The test `ToolCtx`. HERMETIC BY DESIGN: `boundary` is the single `cwd` and
/// `protected` is EMPTY — never derived from the `$HOME`-reading boundary
/// helpers, which would make these tests depend on whatever is in the
/// developer's `~/.agents` (the same trap `ToolCtx::skill_roots: Option<…>`
/// exists to avoid). `Sandboxed` for reads and writes: these are CONTAINMENT
/// tests. Verbatim from the crate's `tests/support.rs::ctx`, so the two fixtures
/// cannot drift in the one respect that matters — what the tool is confined by.
fn ctx(cwd: &Path) -> ToolCtx {
    ToolCtx {
        cwd: cwd.to_path_buf(),
        cancel: CancellationToken::new(),
        skill_roots: None,
        boundary: vec![cwd.to_path_buf()],
        file_policy: archimedes_lib::agent::policy::FilePolicy {
            reads: archimedes_lib::agent::policy::AccessPolicy::Sandboxed,
            writes: archimedes_lib::agent::policy::AccessPolicy::Sandboxed,
            shell: archimedes_lib::agent::policy::AccessPolicy::Allow,
            rules: Vec::new(),
        },
        protected: Vec::new(),
        // HERMETIC like `boundary`/`protected`: NO rules and NO home — an empty
        // list is `rule_for(&[], …) == None` and `home: None` makes a `~` rule
        // match nothing.
        rules: Vec::new(),
        home: None,
        web: Default::default(),
        render_requester: None,
        // No event sink: emitting is a silent no-op here.
        event_sink: None,
    }
}

/// The first text block's text (panics if the shape is wrong).
fn text_of(r: &ToolResult) -> &str {
    r.content
        .first()
        .and_then(|b| match b {
            archimedes_lib::agent::tools::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .expect("the result carries a text block")
}

/// The names the `<skills>` section ADVERTISES, in the prompt (the
/// `<name>` values, inside the section ONLY — the rest of the prompt must
/// not be scanned, or a skill name echoed in another section would count).
fn advertised_in_prompt(prompt: &str) -> std::collections::BTreeSet<String> {
    let section = prompt
        .split("<skills>\n")
        .nth(1)
        .and_then(|rest| rest.split("\n</skills>").next())
        .expect("the `<skills>` section is present (`read_skill` is advertised)");
    section
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("<name>")
                .and_then(|s| s.strip_suffix("</name>"))
                .map(str::to_string)
        })
        .collect()
}

/// The names the `list_skills` output ADVERTISES: one
/// `{name} ({scope}): {description}` line each (`none` → the empty set).
fn advertised_by_tool(text: &str) -> std::collections::BTreeSet<String> {
    if text == "none" {
        return std::collections::BTreeSet::new();
    }
    text.lines()
        .map(|line| {
            line.split_once(" (")
                .map(|(name, _)| name.to_string())
                .unwrap_or_else(|| panic!("unexpected `list_skills` line {line:?}"))
        })
        .collect()
}

/// A `ToolSpec` of the shape `prompt.rs`'s test helper builds (the
/// `parameters` schema is irrelevant here — only the NAME decides whether
/// the `<skills>` section is emitted at all).
fn spec(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.to_string(),
        description: format!("The {name} tool."),
        parameters: serde_json::Value::Null,
    }
}

/// THE anti-drift test (ADR 0029's "the tool's catalog cannot drift from
/// the prompt's catalog" + ADR 0036's "to the Agent a model-hidden Skill
/// is not in the catalog").
///
/// The two CATALOGS are produced by two SEPARATE seams — the prompt's
/// `format_skills_for_prompt` (`harness/prompt.rs`) and the tools'
/// `model_skills_for` → `exec_list_skills` (`fulcrum-core`'s
/// `tools/exec/skills.rs`) — which today share only the `model_visible`
/// PREDICATE. Every other ADR 0036 test checks ONE seam, so either seam growing
/// its own second filter (a scope test, a count cap, a re-filter of an
/// already-filtered list) would leave the OTHER advertising a skill the model was
/// never told about — or, worse, promise a skill that `read_skill` then refuses.
/// This gives BOTH seams the same discovery ROOTS (the prompt builder is handed
/// the discovered rows directly; the tools RE-DISCOVER from those same roots, so
/// the rows are equal by construction and not by sharing a `Vec`), and asserts
/// the two advertised name sets are EQUAL, so the drift is a test failure and not
/// a transcript surprise. The mixed visible/hidden × Space/User fixture is what
/// gives the equality its teeth: a per-seam scope filter, or a seam that stops
/// filtering on the flag, both break the set equality rather than passing
/// silently.
///
/// It also holds the **Shadowing** case (ADR 0065): a same-named Space+User pair
/// with different bytes, where the loser is model-VISIBLE. A shadow is a report
/// on the winner and must stay out of BOTH catalogs, so this fixture fails if
/// either seam ever advertises a shadowed loser — which is why extending THIS pin
/// beats writing a parallel one.
///
/// Since T5/S2 the two seams it compares live in DIFFERENT PACKAGES, which makes
/// this the strongest available form of the pin: a drift is now a failure ACROSS a
/// crate boundary, not a disagreement inside one file's tests.
#[tokio::test]
async fn the_prompt_catalog_and_the_list_skills_catalog_agree() {
    // The prompt builder walks UP from `cwd` for `AGENTS.md`s; an empty
    // `.git` here bounds that walk at this scratch dir (the `prompt.rs`
    // `scratch()` convention) so a stray `AGENTS.md` in `/tmp` cannot
    // inject a `<project_context>` section (which could mention a skill
    // name and pollute nothing here, but keeps the fixture honest).
    let cwd = temp_cwd("drift");
    std::fs::create_dir_all(cwd.join(".git")).unwrap();

    // One skill per root (`skill_root` makes exactly one), six roots:
    // visible + hidden, each at BOTH scopes, PLUS a same-named Space/User pair
    // whose bytes DIFFER — the **Shadowing** case (ADR 0065). Its name may
    // appear in NEITHER advertised set below: a shadowed loser stays
    // unaddressable, and the report rides on the winner as data the prompt
    // never interpolates. If a future change advertised `shadowed` (or listed
    // the loser), the `visible` set below stops matching and this fails.
    // The six roots are hoisted ABOVE the vec (#96 task 08) so their
    // `ScratchDir` guards are body locals: they outlive `discover_in_roots` and
    // `execute_tool` and drop at the body's end. An inline `skill_root(...)`
    // inside the `vec![]` would drop its guard at the end of that expression and
    // delete the skill before either catalog was built.
    let (_g1, r1) = skill_root(
        "visible-space",
        "alpha",
        "---\nname: alpha\ndescription: Does alpha.\n---\nA.\n",
    );
    let (_g2, r2) = skill_root(
        "visible-user",
        "beta",
        "---\nname: beta\ndescription: Does beta.\n---\nB.\n",
    );
    let (_g3, r3) = skill_root(
        "hidden-space",
        "omega",
        "---\nname: omega\ndescription: Does omega.\ndisable-model-invocation: true\n---\nO.\n",
    );
    let (_g4, r4) = skill_root(
        "hidden-user",
        "zeta",
        "---\nname: zeta\ndescription: Does zeta.\ndisable-model-invocation: true\n---\nZ.\n",
    );
    let (_g5, r5) = skill_root(
        "shadow-space",
        "gamma",
        "---\nname: gamma\ndescription: Does gamma (space).\ndisable-model-invocation: true\n---\nG.\n",
    );
    let (_g6, r6) = skill_root(
        "shadow-user",
        "gamma",
        "---\nname: gamma\ndescription: Does gamma (user).\n---\nG other.\n",
    );
    // The **Shadowing** pair: one name, two roots, DIFFERENT bytes, so the
    // second is a shadowed loser and not a Duplicate. Shaped deliberately:
    // the WINNER is model-HIDDEN and the LOSER is model-VISIBLE. The loser
    // carries an advertisable `description`, so it is the case a naive
    // "make the loser a row" implementation would advertise — and the
    // `visible` set below (UNCHANGED: `gamma` joins neither catalog) is what
    // reddens it, while the winner's own hiddenness keeps `gamma` out of
    // both catalogs legitimately (ADR 0036 + ADR 0065).
    let roots: Vec<(PathBuf, SkillScope)> = vec![
        (r1, SkillScope::Space),
        (r2, SkillScope::User),
        (r3, SkillScope::Space),
        (r4, SkillScope::User),
        (r5, SkillScope::Space),
        (r6, SkillScope::User),
    ];
    // The SAME rows for both seams: the prompt builder is handed the
    // discovered set directly, and the tool ctx takes the SAME roots (the
    // tools re-discover them through `skills_for` — `skill_roots` is the
    // pinned-root seam, never a pre-filtered list, which is exactly what
    // this test is guarding).
    let skills = discover_in_roots(&roots);
    // Five ROWS, not six: the shadowed loser is a report on the winner
    // (ADR 0065), never an entry of its own.
    assert_eq!(
        skills.len(),
        5,
        "the fixture must discover all five rows (the premise): the four \
         single-root skills plus ONE row for the shadowed pair"
    );

    // Seam 1: the prompt's `<skills>` section. `read_skill` is advertised so
    // the section is emitted at all (ADR 0017's skill-loading-tool guard).
    let tool_specs = vec![spec("read_skill"), spec("list_skills")];
    let prompt = build_main_prompt(&PromptContext {
        cwd: &cwd,
        // `Path::new("")` skips the global context file (the documented
        // convention: `build_main_prompt` treats an empty dir as "none").
        agent_dir: std::path::Path::new(""),
        tools: &tool_specs,
        skills: &skills,
    });
    let prompt_names = advertised_in_prompt(&prompt);

    // Seam 2: the `list_skills` output, from the SAME roots. Built from the
    // SAME `ctx` helper as `ctx_with_roots` — but pinned per-root instead of
    // all-`Space`, because the fixture needs BOTH scopes (a per-seam scope
    // filter is one of the drifts this test must catch).
    let ctx = ToolCtx {
        skill_roots: Some(roots.clone()),
        ..ctx(&cwd)
    };
    let r = execute_tool(&ctx, "list_skills", &json!({})).await;
    assert!(!r.is_error, "{}", text_of(&r));
    let tool_names = advertised_by_tool(text_of(&r));

    // THE anti-drift assertion.
    assert_eq!(
        prompt_names, tool_names,
        "the `<skills>` section and `list_skills` advertise DIFFERENT catalogs"
    );
    // And neither may name a model-hidden skill (ADR 0036): the equality
    // above alone would hold for two identically-WRONG catalogs.
    //
    // `gamma` is in NEITHER set on purpose (ADR 0065): its Space row is
    // model-hidden, and the model-VISIBLE user row that lost the name is a
    // shadowed REPORT, not an entry — so a shadow stays unaddressable. Adding
    // `gamma` here would mean the report leaked into a model-facing seam.
    let visible: std::collections::BTreeSet<String> = ["alpha".to_string(), "beta".to_string()]
        .into_iter()
        .collect();
    assert_eq!(
        prompt_names, visible,
        "the advertised catalog is not exactly the model-visible set"
    );
    // The fixture must really contain a SHADOW (not two unrelated skills):
    // otherwise the two assertions above would be pinning nothing about ADR
    // 0065. One row, carrying the loser.
    let gamma = skills
        .iter()
        .find(|s| s.name == "gamma")
        .unwrap_or_else(|| panic!("the shadowed pair must leave one row: {skills:?}"));
    assert_eq!(
        gamma.shadowed.len(),
        1,
        "the user row must be reported on the Space winner: {skills:?}"
    );

    // No cleanup loop: the six guards above own the six roots (#96 task 08), so
    // the removals this test used to run by hand are the guards' `Drop`.
}
