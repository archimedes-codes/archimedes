//! The Worker engine: the stdio JSONL protocol + the Worker-side Ipc
//! store / sink / dispatcher + the Supervisor-side client + manager.
//!
//! Moved from `src-tauri/src/agent/worker/` in T8 (S8.1–S8.4); the desktop
//! keeps a re-export shell at `src-tauri/src/agent/worker/mod.rs`, so every
//! `archimedes_lib::agent::worker::…` spelling — the 11 two-sided integration
//! targets, `bin/fake_worker.rs`, `session/mod.rs`, and the files still desktop
//! (`client.rs`, `core.rs`, `dispatch.rs`, `manager/**`, until their own
//! sub-steps) — resolves with zero edits.
//!
//! S8.1 moved the LEAF of the dependency closure: the wire vocabulary
//! (`protocol`), and the two Worker-side trait implementations (`store`,
//! `sink`). Everything else in the desktop's `worker/` depends on these three
//! and nothing in the crate yet needs anything they do not already reach. The
//! module list grows `core`/`dispatch` in S8.2 and `client`/`manager` in S8.3;
//! `run_worker_inner` arrives with the shim in S8.2/S8.4.

pub mod protocol;
pub mod sink;
pub mod store;

pub use protocol::{
    decode_inbound, decode_outbound, encode_inbound, encode_outbound, stamp_outbound, Inbound,
    Outbound, ProtoError, PROTOCOL_VERSION,
};
pub use sink::IpcEventSink;
pub use store::IpcStore;
