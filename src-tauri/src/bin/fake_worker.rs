//! The `fake_worker` test fixture (ADR 0025 Task 3 — the
//! `fake_mcp_stdio` pattern): a tiny binary that speaks the Worker
//! protocol via the shared `protocol` types — `ready` on start, a
//! canned event + store-frame + `SinkFrame` stream on `start` +
//! `prompt`, a permission round-trip, `close` → exit 0, and a
//! `__crash__` prompt → exit 137.
//!
//! # S8b.1: this file is a 3-LINE SHIM
//!
//! The BODY moved VERBATIM into the crate lib at
//! `crates/fulcrum-core/src/fixtures/worker.rs`
//! (`fulcrum_core::fixtures::worker::worker_main`), because the crate must be
//! self-sufficient for its own fixtures — after T8b the crate is a different
//! repository and a fixture owned HERE would not exist there. 66 of the crate's
//! tests spawn these two fixtures, and at `eb8ac18b` all 66 failed `ENOENT` in a
//! standalone copy of the crate.
//!
//! # WHY THE DESKTOP KEEPS A BIN NAMED `fake_worker` FOREVER
//!
//! `env!("CARGO_BIN_EXE_<name>")` is **package-local**: a test in a dependent
//! package cannot read a dependency's bin variable (verified — a compile-time
//! `environment variable … not defined`). SEVEN desktop integration tests
//! resolve this fixture through `env!("CARGO_BIN_EXE_fake_worker")`:
//! `tests/{worker_stderr,harness_dispatch_native,harness_loop_subagents_db,harness_subagent_dispatch,harness_subagent_worker,ipc,session_native}.rs`.
//! So the desktop must own a bin of that EXACT name — including after T8b, when
//! the crate is a path dependency in another repo. The crate's own bin is
//! therefore named `fake_worker_core` (a distinct name: two members with the
//! same bin name collide on one output file in the shared `target/debug/`,
//! cargo only warns, and the last writer silently wins — cargo#6313).
//!
//! # Wire behaviour — UNCHANGED, and it must stay that way
//!
//! Every frame this fixture writes is defined by the shared body, so the wire
//! is byte-identical to the pre-S8b.1 binary: `hello` + `ready` BEFORE `start`
//! (both unstamped), then on `prompt` the canned `RpcEvent` + store-frame +
//! `SinkFrame` stream, `close` → exit 0, `__crash__` → exit 137,
//! `__permission__` → the round-trip, and the `__sudo__` / `__slow__` /
//! `__subagent*__` / `__long_stream__` / `__in_tool__` /
//! `__stream_then_{silence,crash}__` / `__crash_burst__` / `__cancel__` /
//! `__stderr__` / `__interactive__` scenarios — all documented in full at the
//! body, `crates/fulcrum-core/src/fixtures/worker.rs`, which carries the
//! scenario-by-scenario contract this shim used to document.
//!
//! The `worker_e2e` flake family (`subagent_dispatch_end_to_end_real_workers`
//! and siblings) spawns THIS binary. The move changed no byte of its output and
//! no ordering in it — see the status file's S8b.1 entry.

fn main() {
    fulcrum_core::fixtures::worker::worker_main();
}
