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
