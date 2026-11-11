//! The `tasks.rs` unit tree — the repo's `mod tests;` + `tests/` directory
//! shape (AGENTS.md: NOT a `tests.rs` sibling), split BY SUBJECT the way
//! `commands/files/tests/` is:
//!
//!   * [`board`] — A1's five board-command tests (title cleaning, the wire
//!     kinds, the `compact` boost target, the handoff sentence, the
//!     `reorder_tasks` refusals), moved verbatim from this file's inline block;
//!   * [`seed`] — A4's `start_task_session` tests (the link row, the real
//!     Worker-backed start, the `lib.rs` registration);
//!   * [`stages`] — issue #179's Stage-command tests (the label→slug derivation,
//!     the three `delete_stage` refusals, the Strict refusal, the
//!     `get_board_strict` wire guarantee, and the "relocation never calls
//!     `move_task`" guard);
//!   * [`artifacts`] — issue #180 D1's artifact-command tests (the key grammar,
//!     the 256 KB cap, the missing-Task refusal, the `null` read, the `lib.rs`
//!     registration, and the "D1 advertises nothing to a model" boundary pin).

mod artifacts;
mod board;
mod seed;
mod stages;
