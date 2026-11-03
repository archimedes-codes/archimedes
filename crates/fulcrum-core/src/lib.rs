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
