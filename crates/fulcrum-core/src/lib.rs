//! Fulcrum core — the agent engine extracted from `archimedes`'s `src-tauri/src/agent/`.
//!
//! T5 moves bodies here in ordered, gate-green sub-steps; as each moves,
//! `src-tauri/src/agent/mod.rs` re-exports it so the 20 outside-`agent/` files and
//! 23 integration tests keep compiling unchanged:
//!
//! ```text
//! pub use fulcrum_core::<symbol>;
//! ```
//!
//! (A fenced `text` block, not an indented one: rustdoc compiles an indented block in a
//! doc comment as a doctest, and `<symbol>` is a placeholder, not Rust — the literal
//! shape this file was drafted with failed `cargo test` with
//! `error: expected identifier, found <`.)

// ── T5/S1 — the pure leaf modules (ADR 0091, `docs/roadmap/` T5 plan Step A) ──
// Moved by `git mv` with every `mod`/`#[cfg(test)]` block verbatim; the desktop
// reaches them through the re-export seam in `src-tauri/src/agent/mod.rs`.
pub mod debuglog;
pub mod events;
pub mod fs_backend;
pub mod hostenv;
pub mod ids;
// `#[cfg(test)]` for the reason in the module's own docs: `fulcrum-core` has no
// `tests/` directory yet (T5/Step D keeps every integration test in the desktop),
// so an ungated copy would be `dead_code` in the plain lib build — which the
// gate's `clippy --all-targets -- -D warnings` rejects.
#[cfg(test)]
pub mod test_support;
pub mod todo;
pub mod types;

// ── T5/S2 — the `{tools, web, boundary}` cluster + its co-residents ──────────
// `git mv`'d with every `mod`/`#[cfg(test)]` block verbatim. The cluster is ONE
// unit because `tools ↔ web` and `tools ↔ boundary` are genuine 2-cycles (no
// member compiles alone); `skills`/`agents`/`roots` ride with it because
// `boundary.rs` imports both `skills::{user_roots,space_roots}` and
// `agents::{user_roots,space_roots}`, `tools/types.rs` names `skills::SkillScope`,
// and both of those reach `roots::space_roots_in` — an S2 without them does not
// compile (the status file's MAJOR finding #2).
//
// `web/` is the SPLIT directory: the crate owns `cache`, `config`, `extract`,
// `net`, `providers`, `tools` and NOT `render` (the Tauri webview stays
// desktop). See `src-tauri/src/agent/web.rs` for the desktop half and why the
// two cannot be one module tree.
pub mod agents;
pub mod boundary;
pub mod childproc;
pub mod definition_permission;
pub mod policy;
// `pub(crate)`, NOT `pub`: `roots` is the shared walk-up helper behind
// `skills::space_roots`/`agents::space_roots` and NOTHING outside the crate names
// it (measured: `crate::roots::space_roots_in` appears only in `skills.rs:241`
// and `agents.rs:254`, both of which moved here). The desktop declared it
// `pub(crate) mod roots` too, so this preserves the original surface rather than
// widening it across the package boundary.
pub(crate) mod roots;
pub mod skills;
pub mod tools;
pub mod web;

// ── T5/S3 — the one-way dependents: `interactive`, `codemode`, `mcp` ────────
// `git mv`'d with every `mod`/`#[cfg(test)]` block verbatim. These three depend
// on S2's cluster one-way (`mcp→tools` 1, `interactive→tools` 4) and nothing in
// the crate depends on them for this step except the desktop `harness` (moves
// S5) and the desktop `worker` (stays through T8).
//
// `provider_auth` is NOT here. The status file's S3 RULING measured the crate's
// need at exactly ONE item — `provider_auth::headers::expand_map`, one call site
// at `harness/provider/mod.rs:106` — and ZERO consumers for every other
// submodule, so only `headers.rs` moved (as `provider_headers`, below). Two
// seams the plan specified for the rest of that directory are CANCELLED with it:
// the E5 refresh trait (`refresh.rs` stays, so `refresh.rs:31 → session` never
// crosses) and the `ProviderSource` seam for `budget.rs` (same reason — its
// `settings.json` read stays in the desktop, untouched).
pub mod codemode;
pub mod interactive;
pub mod mcp;
/// The one file that moved out of the desktop's `provider_auth/` directory.
/// Named for what it IS — one file of that directory, not the directory — so the
/// crate never looks like it owns `provider_auth`. The desktop's
/// `agent/provider_auth/mod.rs` re-exports it AS `headers`, which is what keeps
/// `crate::agent::provider_auth::headers::{expand_map, validate_base_url}`
/// resolving at its current path for the consumers outside that directory
/// (`session/mod.rs`, `commands/settings.rs`, `tests/provider_headers.rs`).
pub mod provider_headers;

/// `LaunchConfig` — the per-dispatch launch DTO, which moved ahead of the module
/// it lives beside (`subagent.rs`, S5) because `interactive` (S3) imports it.
/// Pure data; the E.1 wire-type pattern rather than a seam. See the module docs.
pub mod launch_config;
