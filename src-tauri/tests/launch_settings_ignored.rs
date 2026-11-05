//! `resolve_launch`'s DISK half (T5/S5b relocation).
//!
//! One test, moved out of `crates/fulcrum-core/src/harness/launch/tests/mod.rs`.
//! It is the non-vacuity pin for Fulcrum T3's central claim — the Worker no
//! longer reads the settings file — and it could not stay in the crate for a
//! reason worth stating precisely:
//!
//! Its premise is a real `settings.json` on disk that DISAGREES with the packaged
//! map. Inside the crate there is nothing to disagree WITH (`load_settings` is
//! desktop-only by Ruling 1: the type moved, the disk did not), and
//! `boundary_pins::no_code_reads_the_desktop_settings_file` forbids the filename
//! in crate code — a fixture that wrote the real file under its real name would
//! make that boundary unverifiable by inspection. So the crate-side fixture now
//! speaks in a fixture-local document name, and THIS file does the thing that
//! actually needs the desktop: it writes the real file with the real name.
//!
//! # The pin got stronger on the way out, not weaker
//!
//! The crate-side version asserted only `resolve_launch(...) == fake/m3`. This one
//! asserts BOTH halves of the disagreement in the same test:
//!
//!   1. `load_settings(&dir)` — the real loader on the real file — DOES read
//!      `fake/m2` out of it, so the file is live and parsed and would have won
//!      under the old code; AND
//!   2. `resolve_launch(...)` returns `fake/m3`, the packaged value.
//!
//! Half (1) is the vacuity guard the old test carried as an `is_file()` check on
//! the path; checking it through the loader instead of through `is_file()` means
//! the file being READABLE AND PARSEABLE is part of the premise, not just its
//! existence. Re-insert a `config_dir` read into `resolve_launch` and half (2)
//! reddens with `fake/m2`.
//!
//! Precedent for the shape: `tests/permission_gate_db.rs` (S5a),
//! `tests/skill_catalog_drift.rs` (S2).

use std::collections::HashMap;

use archimedes_lib::agent::harness::launch::resolve_launch;
use archimedes_lib::agent::harness::{Model, ModelCatalog};
use archimedes_lib::agent::subagent::LaunchConfig;
use archimedes_lib::config::{load_settings, AgentOverrideFields};
use archimedes_lib::test_support::ScratchDir;

/// `HOME` restore guard (scope-exit `Drop` — the restore happens even when an
/// assertion panics mid-test, so a failure here cannot leave `HOME` pointing at a
/// scratch dir that `ScratchDir` is about to delete; the crate fixture's own
/// `RestoreHome`, restated because it is `#[cfg(test)]` inside the crate).
struct RestoreHome(Option<std::ffi::OsString>);
impl Drop for RestoreHome {
    fn drop(&mut self) {
        match self.0.take() {
            // SAFETY: the `ENV_LOCK` guard is still held at drop time (this guard
            // is declared after it and outlives it in reverse); no other thread
            // mutates `HOME` concurrently.
            Some(v) => unsafe { std::env::set_var("HOME", v) },
            // SAFETY: as above.
            None => unsafe { std::env::remove_var("HOME") },
        }
    }
}

fn fake_model(id: &str) -> Model {
    Model {
        id: id.to_string(),
        provider: "fake".to_string(),
        base_url: "http://fake".to_string(),
        api_key: "k".to_string(),
        context_window: 128000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: false,
        thinking_levels: Vec::new(),
        api: Some("openai-completions".to_string()),
    }
}

/// (Fulcrum T3) THE non-vacuity pin for "the Worker no longer reads the file": a
/// REAL `settings.json` that DISAGREES with the packaged map is IGNORED.
///
/// Every sibling test would stay green if the disk read were re-added, because
/// each writes a file and a packaged map that say the SAME thing (or nothing).
/// This one says OPPOSITE things, and now proves both sides of it.
#[test]
fn resolve_launch_ignores_a_settings_file_holding_a_different_override() {
    let config_dir = ScratchDir::in_env_temp(
        "harness-resolve-launch-settings-",
        "disagrees-with-packaged",
    );
    std::fs::write(
        config_dir.join("settings.json"),
        r#"{ "agentOverrides": { "scout": { "model": "fake/m2" } } }"#,
    )
    .unwrap();

    // (1) THE FILE IS LIVE: the real desktop loader reads `fake/m2` out of it.
    //     Without this half the pin could pass on an unreadable file.
    let from_disk = load_settings(&config_dir);
    assert_eq!(
        from_disk
            .agent_overrides
            .get("scout")
            .and_then(|e| e.model.as_deref()),
        Some("fake/m2"),
        "the fixture's premise: the REAL loader DOES read the file — so a \
         `resolve_launch` that read it would return `fake/m2`"
    );

    // (2) THE PACKAGED MAP IS THE AUTHORITY.
    let packaged = HashMap::from([(
        "scout".to_string(),
        AgentOverrideFields {
            model: Some("fake/m3".to_string()),
            thinking: None,
            tools: None,
        },
    )]);
    let catalog = ModelCatalog {
        models: vec![fake_model("m1"), fake_model("m2"), fake_model("m3")],
        default_model: None,
        compaction: Default::default(),
    };
    let space = ScratchDir::in_env_temp("harness-launch-test-", "disk-ignored");
    // The `scout` DEFINITION must be discoverable, or `resolve_launch` takes its
    // MISS arm and returns the launch VERBATIM — which would make the assert
    // below pass for the wrong reason (a `None` model from a miss, not a packaged
    // win). The crate-side fixture did this through `write_override_world`; the
    // `HOME` dance is the crate test-support's, so it is spelled out here.
    let home = ScratchDir::in_env_temp("harness-resolve-launch-home-", "disagrees-with-packaged");
    std::fs::create_dir_all(home.join(".agents/agents")).unwrap();
    std::fs::write(
        home.join(".agents/agents/scout.md"),
        "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m1\ntools: [bash]\n---\n",
    )
    .unwrap();
    // `test_support::env_lock()` is `pub(crate)`; the STATIC it locks is `pub`,
    // so an integration target locks the same mutex directly (poison-tolerant,
    // the same rule the helper documents).
    let _lock = std::sync::Mutex::lock(&archimedes_lib::test_support::ENV_LOCK)
        .unwrap_or_else(|p| p.into_inner());
    let original_home = std::env::var_os("HOME");
    // SAFETY: the `ENV_LOCK` guard is held for the whole set→assert→restore span;
    // no other thread mutates `HOME` concurrently.
    let _restore = RestoreHome(original_home.clone());
    unsafe { std::env::set_var("HOME", home.path()) };
    let (resolved, resolution) = resolve_launch(
        &LaunchConfig::default(),
        "scout",
        &catalog,
        Some(&packaged),
        &space,
    );
    assert_eq!(
        resolution,
        archimedes_lib::agent::subagent::AgentNameResolution::Matched,
        "the definition was found — so the model below came from a RESOLVE, \
         not from the miss arm returning the launch verbatim"
    );
    assert_eq!(
        resolved.model,
        Some("fake/m3".to_string()),
        "the PACKAGED map is the authority; a `settings.json` on disk is dead \
         weight to `resolve_launch` now (the file says fake/m2 — reading it is \
         the disk dependency T3 removes)"
    );
    // The `_restore` guard does the restore (including on a panic path); the
    // `home` guard is named so it outlives the assertions that read through it.
    let _ = home;
}
