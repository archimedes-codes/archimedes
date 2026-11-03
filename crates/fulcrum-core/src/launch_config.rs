//! `LaunchConfig` — the per-dispatch launch DTO, moved to the crate in T5/S3.
//!
//! # Why this type is here and its manager is not
//!
//! `LaunchConfig` lives with `SubagentSessionManager` in `subagent.rs`, which
//! cannot move until T5/S5: `subagent.rs:28` imports
//! `crate::agent::worker::manager::WorkerManager`, the E2 behaviour edge (edge
//! list, plan §2). But `interactive/mod.rs` — which DOES move in S3 — imports
//! `LaunchConfig` from it. That is the one genuine ordering constraint in S3, and
//! the plan's S3 text missed it (the status file's S3 RULING records the fix).
//!
//! The resolution is the E.1 wire-type pattern rather than a seam: the type is
//! PURE DATA, so it moves on its own and the desktop `subagent.rs` re-exports it
//! (`pub use fulcrum_core::launch_config::LaunchConfig;`), which keeps every
//! pre-existing `subagent::LaunchConfig` path compiling with zero edits. A trait
//! would be the wrong shape — there is no behaviour here to invert, only a
//! struct whose home module is not yet movable.
//!
//! # Why it is genuinely movable
//!
//! Six `Option` fields and no logic. Every field is `Option`, so the wire frame
//! that embeds it stays backward-compatible (`launch/tests/mod.rs`'s
//! `an_old_frame_without_the_new_fields_still_decodes` pins that, and it stays
//! where it is — it drives `resolve_agent_launch`, which moves in S5). The only
//! non-`std` reference is `definition_permission::PermissionBlock`, which moved
//! in S2, so nothing in here names a module the crate does not already own.
//!
//! The `Serialize`/`Deserialize` derives are load-bearing, not decoration: this
//! type crosses the Supervisor↔Worker wire inside `SubagentDispatchWire.launch`
//! (`worker/protocol.rs`, which stays desktop through T8 — desktop→crate is the
//! allowed direction).

use serde::{Deserialize, Serialize};

/// Per-dispatch pi configuration for a subagent session (moved verbatim
/// from `launch_wrapper.rs` — the wrapper script is deleted in this task;
/// the flags are now passed directly to the `pi` spawn).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LaunchConfig {
    /// The agent file body (named agents); `None` for config-less dispatch.
    pub system_prompt: Option<String>,
    /// Resolved model (`"provider/id"` or `"provider/id:<thinking>"`); `None` =
    /// pi default. (The quotes are rustdoc, not prose: bare `<thinking>` in a doc
    /// comment is parsed as an unclosed HTML tag — the same text was silent in
    /// `subagent.rs` only because that file is not a `cargo doc -p fulcrum-core`
    /// target. T5/S3 A.6.)
    pub model: Option<String>,
    /// The thinking level from the OVERRIDE layer or the explicit tool-call
    /// param — NEVER the frontmatter's own value, and never the model key's
    /// `:<level>` suffix.
    ///
    /// This field is the TOP rung of the dispatch's thinking chain
    /// (`subagent_flow.rs`: this > the model key's suffix >
    /// `frontmatter_thinking`), so whatever lands in it outranks the suffix.
    /// ADR 0066 put the `agentOverrides` thinking level here — the only layer
    /// below the explicit param allowed to — and `resolve_agent_launch` writes
    /// it only when the model that just resolved advertises the level, so a
    /// demoted override never reaches a child (nor gets reported as effective,
    /// ADR 0068). The frontmatter's `thinking` stays in
    /// `frontmatter_thinking`, the LAST rung.
    pub thinking: Option<String>,
    /// The frontmatter's `thinking` (the dispatch resolves the thinking in
    /// the doc-correct order: explicit > model-key `:<level>` suffix >
    /// this — the frontmatter's `thinking` is the LAST rung). `None` for
    /// a config-less dispatch.
    pub frontmatter_thinking: Option<String>,
    /// Tool allowlist (named agents with `tools`); `None` → `--exclude-tools subagent`.
    pub tools: Option<Vec<String>>,
    /// Frontmatter `permission` (issue #101's ruleset) as the definition
    /// DECLARES it — a NARROWING layer only: the gate's strict-of-two merge
    /// consumes it (task05b), so it can make a call MORE restricted than the
    /// user's `filePolicy` would, never less. `None` → the file does not
    /// speak about permissions (no narrowing). Crosses the wire inside
    /// `SubagentDispatchWire.launch`; a config-less dispatch stays `None`.
    ///
    /// BOXED, and the box is load-bearing: an inline `Option<PermissionBlock>`
    /// puts `LaunchConfig` at 144 bytes, which pushes the two wire enums that
    /// carry it (`Outbound::SubagentDispatch` / `WorkerInboundEvent::
    /// SubagentDispatch`, both in worker-owned files) over clippy's
    /// `large_enum_variant` threshold — CI's `-D warnings` would fail on files
    /// this task may not edit. `Box` is TRANSPARENT to serde, so the wire JSON
    /// is byte-identical to the unboxed field the plan specifies; only Rust's
    /// in-memory shape differs (task05b reads it through `Option::as_deref()`).
    pub permission: Option<Box<crate::definition_permission::PermissionBlock>>,
}
