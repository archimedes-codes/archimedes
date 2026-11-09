//! The `tasks.rs` unit tree — the repo's `mod tests;` + `tests/` directory
//! shape (AGENTS.md: NOT a `tests.rs` sibling), split BY SUBJECT the way
//! `commands/files/tests/` is:
//!
//!   * [`board`] — A1's five board-command tests (title cleaning, the wire
//!     kinds, the `compact` boost target, the handoff sentence, the
//!     `reorder_tasks` refusals), moved verbatim from this file's inline block;
//!   * [`seed`] — A4's `start_task_session` tests (the link row, the real
//!     Worker-backed start, the `lib.rs` registration).

mod board;
mod seed;
