//! Tests for the desktop's host tools (ADR 0113's Mirror rule — this tree mirrors
//! `agent/host_tools/`).
//!
//!   * [`surface`] — the eight specs: names, parameter blocks, the disjoint + 27-name
//!     census, and the `read`/`subagent` substring ban;
//!   * [`shape`] — THE SHAPE ASSERTION (`toStage` / `note` / `artifactKeys` on the
//!     decoded value), the pin the lossy-twin rule exists to justify;
//!   * [`mapping`] — every field's VALUE against the stored row, plus the two-state
//!     `FieldPatch` fold (carried over from `storage/db/tests/seams.rs`);
//!   * [`verbs`] — verb-by-verb behaviour, refusals, and the board-call deadline.
mod mapping;
mod shape;
mod surface;
mod verbs;
