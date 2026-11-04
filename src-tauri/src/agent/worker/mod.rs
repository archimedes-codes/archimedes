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
//! # T8 — this file is a RE-EXPORT SHELL plus ONE wrapper
//!
//! `protocol.rs`, `store.rs` and `sink.rs` moved to
//! `crates/fulcrum-core/src/worker/` in S8.1; `core.rs` and `dispatch.rs` (and
//! `run_worker_inner` itself) moved in S8.2. They are re-exported here BOTH as
//! modules and by name, because module-qualified spellings outnumber named ones
//! (the S1 measurement, and the reason S1–S5b kept this shape): `client.rs`,
//! `manager/**` (still desktop until S8.3), `session/mod.rs`,
//! `bin/fake_worker.rs` and 11 integration targets all address
//! `…::agent::worker::protocol::…` / `…::WorkerCore` / `…::IpcDispatcher`, and
//! every one of them compiles with ZERO edits.
//!
//! The ONE thing defined here is the `run_worker_inner()` wrapper. It is not
//! leftover — it is the boundary. The crate's `run_worker_inner` takes the two
//! desktop-only behaviours as parameters (the browser opener and the crash
//! hook), and this wrapper is the desktop-side call site that supplies them, so
//! `src-tauri/src/lib.rs::run_worker` keeps calling
//! `agent::worker::run_worker_inner()` UNCHANGED through S8.2. The deliberate
//! two-commit split: the seam's SIGNATURE lands in S8.2, the desktop's call site
//! flips in S8.4 (which deletes this wrapper and calls the crate's parameterised
//! entry from `lib.rs::run_worker`), so a mid-flight regression is bisectable.
//!
//! `open.rs::the_production_loop_caller_passes_the_desktop_opener` reads THIS
//! file for exactly that reason: after S8.2 the crate can no longer name
//! `crate::open` (it is `tauri`), so the "the desktop hands its real opener to
//! the crate" assertion lives here — desktop → crate is the legal direction.

// The S8.1/S8.2 re-export shell. Module aliases first (the spellings that carry
// the traffic), then the named surface — the exact list this file exported
// before the moves, so nothing downstream had to be touched.
pub use fulcrum_core::worker::{core, dispatch, protocol, sink, store};
pub use fulcrum_core::worker::{
    decode_inbound, decode_outbound, default_build_loop, encode_inbound, encode_outbound,
    spawn_stdin_reader, stamp_outbound, Inbound, IpcDispatcher, IpcEventSink, IpcStore,
    LoopControl, LoopHandles, Outbound, ProtoError, WorkerCore, PROTOCOL_VERSION,
};
// The five S4 wire DATA types this file used to re-export through `protocol`
// (which re-exports them from `fulcrum_core::worker_types`); the names must stay
// reachable at `crate::agent::worker::{…}` for `persist.rs` / `subagent.rs` /
// the integration tests.
pub use protocol::{StartEnv, StartMode, StoreFrame, SubagentDispatchWire};

pub mod client;
pub mod manager;

pub use client::{WorkerError, WorkerErrorKind, WorkerHandle, WorkerInboundEvent};
pub use manager::{
    ClosureHooks, SubagentCapture, WorkerFactory, WorkerHooks, WorkerManager,
    DEFAULT_SUBAGENT_DEAD_BOUND,
};

/// The Worker main — the desktop's zero-argument spelling of the crate's
/// parameterised `run_worker_inner` (S8.2's seam; deleted by S8.4 when
/// `lib.rs::run_worker` passes the two arguments itself).
///
/// The two arguments are the whole point of this function's existence, and each
/// is a desktop thing the crate may not name:
///
///   * `crate::open::desktop_open_requester()` — the tauri-backed browser
///     opener. `open.rs` is `tauri` (`tauri::Url`, `tauri_plugin_opener`) so it
///     cannot move into `fulcrum-core`; the loop it eventually reaches takes an
///     `Arc<dyn OpenRequester>` (S5a's SEAM 2) and `default_build_loop` takes it
///     from here (S8.2). Passing anything else here still COMPILES — that is
///     precisely the failure
///     `open.rs::the_production_loop_caller_passes_the_desktop_opener` pins, and
///     the reason that pin reads this file rather than the crate.
///   * the crash hook — `agent/crashlog.rs` stays desktop (the crate needs none
///     of it), so the desktop passes the install closure. The tag (`"worker"`)
///     and the `base.join("archimedes")` layout are unchanged; the directory is
///     still resolved INSIDE the crate at install time and handed to the hook,
///     so the hook resolves nothing during the panic.
pub async fn run_worker_inner() {
    fulcrum_core::worker::run_worker_inner(
        crate::open::desktop_open_requester(),
        Some(std::sync::Arc::new(|dir: std::path::PathBuf| {
            crate::agent::crashlog::install_panic_hook("worker", dir)
        })),
    )
    .await;
}
