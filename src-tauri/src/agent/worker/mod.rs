//! The Worker process (ADR 0025 Task 2): the desktop's own binary
//! re-entered with `--worker` — one session's `AgentLoop` over a
//! stdio JSONL protocol with the Supervisor.
//!
//! The Tauri runtime NEVER starts in a Worker (`main` checks the flag
//! before the Tauri init). The Worker: installs the crash-logging
//! panic hook (tag `"worker"`), builds the `WorkerCore`, emits
//! `hello` (the protocol version) then `Ready` (the binary version),
//! then observes three things concurrently — the `events_rx`
//! pump task (each `RpcEvent` → an `Outbound::Event` frame on stdout),
//! the crash-watch task (the loop `JoinHandle` — `Err` (a panic — the
//! hook already wrote the crash log) → a best-effort `WorkerError`
//! frame + `std::process::exit(1)`; a panic in a `tokio::spawn`'d task
//! is otherwise SWALLOWED by tokio, and without this watch a panicked
//! loop would leave the Worker running forever with a dead loop), and
//! the inbound frame stream (the `spawn_stdin_reader` THREAD reads the
//! lines → `decode_inbound` → `core.handle` → the outbound frames to
//! stdout). Exit 0 when the core is closed or stdin hits EOF.
//!
//! # T8 — this file is a PURE RE-EXPORT SHELL
//!
//! `protocol.rs`, `store.rs` and `sink.rs` moved to
//! `crates/fulcrum-core/src/worker/` in S8.1; `core.rs` and `dispatch.rs` (and
//! `run_worker_inner` itself) moved in S8.2; `client.rs` and the whole
//! `manager/` directory moved in S8.3; S8.4 added the crate's `run_worker`
//! entry. So **this file declares NO modules and DEFINES NOTHING at all** —
//! every `worker/` file is crate-owned, and everything here is a `pub use`. The
//! names are re-exported BOTH as modules and by name, because module-qualified
//! spellings outnumber named ones (the S1 measurement, and the reason S1–S5b
//! kept this shape): `session/mod.rs`, `lib.rs`, `commands/**`,
//! `bin/fake_worker.rs` and the 11 integration targets all address
//! `…::agent::worker::protocol::…` / `…::worker::client::WorkerHandle` /
//! `…::WorkerManager`, and every one of them compiles with ZERO edits.
//!
//! S8.2 left ONE definition here — a zero-argument `run_worker_inner()` wrapper
//! that supplied the crate's two injected desktop-only arguments. S8.4 deleted
//! it: `src-tauri/src/lib.rs::run_worker` is now the single desktop → crate
//! hand-off and passes
//! `fulcrum_core::worker::run_worker(crate::open::desktop_open_requester(), …)`
//! itself.
//!
//! That is why `open.rs::the_production_loop_caller_passes_the_desktop_opener`
//! reads `src-tauri/src/lib.rs` and not this file: after S8.4 the crate can
//! never name `crate::open` (it is `tauri`), so the "the desktop hands its real
//! opener to the crate" assertion lives at the ONE call site that makes the
//! crossing — desktop → crate is the legal direction, and `lib.rs` is now that
//! site's only home.

// The S8.1/S8.2/S8.3 re-export shell. Module aliases first (the spellings that carry
// the traffic), then the named surface — the exact list this file exported
// before the moves, so nothing downstream had to be touched.
pub use fulcrum_core::worker::{client, core, dispatch, manager, protocol, sink, store};
pub use fulcrum_core::worker::{
    decode_inbound, decode_outbound, default_build_loop, encode_inbound, encode_outbound,
    spawn_stdin_reader, stamp_outbound, ClosureHooks, Inbound, IpcDispatcher, IpcEventSink,
    IpcStore, LoopControl, LoopHandles, Outbound, ProtoError, SubagentCapture, WorkerCore,
    WorkerError, WorkerErrorKind, WorkerFactory, WorkerHandle, WorkerHooks, WorkerInboundEvent,
    WorkerManager, DEFAULT_SUBAGENT_DEAD_BOUND, PROTOCOL_VERSION,
};
// The five S4 wire DATA types this file used to re-export through `protocol`
// (which re-exports them from `fulcrum_core::worker_types`); the names must stay
// reachable at `crate::agent::worker::{…}` for `persist.rs` / `subagent.rs` /
// the integration tests.
pub use protocol::{StartEnv, StartMode, StoreFrame, SubagentDispatchWire};
