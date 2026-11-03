//! Fulcrum core — the agent engine extracted from `archimedes`'s `src-tauri/src/agent/`.
//!
//! EMPTY in T4 on purpose (the workspace-skeleton task). T5-T8 move bodies here; as each
//! moves, `src-tauri/src/agent/mod.rs` re-exports it so the 20 outside-`agent/` files and
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
//!
//! Do NOT add a `pub use` here yet — no symbol exists to export until T5.
