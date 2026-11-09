//! Crate-root shared types (ADR-agnostic value types that more than one
//! layer needs — `storage` and `agent` both use `SessionInfo`, so it lives
//! at the crate root rather than under either, which is what keeps
//! `storage` from importing `agent`).
//!
//! (T5/S4) `SessionInfo` and `ContextUsage` MOVED to `fulcrum_harness::store_rows`
//! and are re-exported here. They move because the crate's `FulcrumPersistence`
//! trait takes `&SessionInfo` (its `record_session` method) and `agent/persist.rs`
//! — which moves to the crate in S5 — both imports and CONSTRUCTS it, so a trait
//! in `fulcrum-harness` could not be declared over a type in `archimedes_lib`. This
//! file keeps the definition's public spelling: `crate::types::SessionInfo`,
//! `crate::agent::SessionInfo` (via `agent/mod.rs`) and
//! `archimedes_lib::types::SessionInfo` all still resolve, with zero edits at the
//! ~117 sites that name them. The struct bodies, their field docs and their serde
//! attributes moved verbatim, so nothing on the IPC wire changes.
//!
//! This module is otherwise empty, and that is the honest state: the two types
//! that lived here were the whole file. A future crate-root type that `storage`
//! and `agent` BOTH need joins it; one that only one of them needs does not.

pub use fulcrum_harness::store_rows::{ContextUsage, SessionInfo};
