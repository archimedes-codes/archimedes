//! A deterministic MCP stdio test double (no LLM, no sleeps) for the
//! `StdioClient` tests.
//!
//! # S8b.1: this file is a 3-LINE SHIM
//!
//! The BODY moved VERBATIM into the crate lib at
//! `crates/fulcrum-core/src/fixtures/mcp_stdio.rs`
//! (`fulcrum_core::fixtures::mcp_stdio::mcp_stdio_main`) so ONE body backs both
//! this bin and the crate's `fake_mcp_stdio_core` bin. The crate needs its own
//! because after T8b it is a different repository and 12 of its tests spawn
//! this double through `target_debug_dir()` — see `crate::fixtures` there for
//! the measured constraint list.
//!
//! # Why this bin stays, and why its NAME stays
//!
//! Unlike `fake_worker`, this fixture has NO desktop `CARGO_BIN_EXE` consumer —
//! its only desktop consumer is one `#[cfg(test)]` in-lib test at
//! `src-tauri/src/commands/settings.rs`, which builds the path
//! `CARGO_MANIFEST_DIR.parent()/target/debug/fake_mcp_stdio` (the WORKSPACE
//! ROOT's shared `target/`, which both members write to). That test keeps
//! passing because the DESKTOP still builds a bin under this exact name — the
//! crate's copy is `fake_mcp_stdio_core`, a DIFFERENT file, so the two never
//! collide on the shared `target/debug/` (same bin name = one shared output
//! file, a warning and a silent last-writer-wins, cargo#6313).
//!
//! # Wire behaviour — UNCHANGED
//!
//! One JSON-RPC 2.0 object per line: `initialize` → the server capabilities;
//! `notifications/initialized` → nothing; `tools/list` → the canned three
//! tools; `tools/call` → `echo` / `hang` (no response — the timeout test) /
//! `err` (a JSON-RPC error), plus the always-dispatchable `hold` / `release`
//! pair; the `--tools=<csv>` and `--name=<label>` seams. Every one of those
//! bytes is defined by the shared body, which carries the full contract —
//! including the key-order rule that keeps an unlabelled server byte-identical
//! to the historical double.

fn main() {
    fulcrum_core::fixtures::mcp_stdio::mcp_stdio_main();
}
