//! The desktop's HOST TOOLS — the eight board / artifact / Session verbs (ADR 0102 /
//! issue #183 D1, plus `mark_done`).
//!
//! # What a host tool is, and why these eight are the ones
//!
//! ADR 0102's rule: a tool whose substance acts on HOST state is a host tool; a tool
//! whose substance the engine already confines (`bash` on the Space's files under the
//! Boundary) stays engine-side. The board is the desktop's SQLite and the Supervisor
//! is the sole SQLite writer (ADR 0025), so all seven board/artifact verbs are host
//! tools by that rule — they are the first tenants because their substance was
//! already here. `mark_done` is the eighth and the first whose SUBJECT IS THE CALLING
//! SESSION rather than a card, which is why [`run`] carries the frame's origin
//! identity and the seven board verbs ignore it.
//!
//! # The ownership move this module is
//!
//! Before ADR 0102 F3 the crate owned the advertised surface: `tool_specs()` carried
//! all 26 names, `tools/exec/task_tools.rs` carried the seven executors, and the
//! desktop contributed ZERO specs. F3 of that ADR deletes both (`tool_specs()` is now
//! 19) and the specs arrive as DATA instead:
//!
//! ```text
//! agent/host_tools/specs.rs ──▶ StartEnv::host_tools ──▶ the ENGINE composes
//!                                                        builtins() ++ host_entries
//!                                                             │
//!                          the model calls one                ▼
//! router.rs's HostToolCall arm ◀── Outbound::HostToolCall ── the Worker's HostTool
//!        │                                                    executor parks
//!        └── host_tools::exec::run ──▶ Inbound::HostToolResponse
//! ```
//!
//! The desktop never injects a Rust object into a Worker — the Worker is a second
//! process of the SAME binary — so no desktop type crosses the boundary and ADR
//! 0091's "the desktop drives; the crate never pulls" holds verbatim.
//!
//! # The model's surface: the same 26 names, plus one
//!
//! The 26 names a Session was advertised at 0.7.0 are the SAME 26 and their owners
//! moved underneath; that invariance is what makes "the crate forgets Tasks exist" a
//! safe claim, and `tests/worker_e2e.rs` re-verifies it against the real rendered
//! `<tools>` section. `mark_done` is the one ADDITION — a name no 0.7.0 Session ever
//! saw, appended after the seven, so the composed set is 27.
//!
//! # Two things this module does NOT do
//!
//!   * **It does not decide a host tool's ENABLED-ness.**
//!     `commands/settings.rs::list_tools` composes this module's eight specs onto the
//!     crate's 19, so a host tool appears in the Settings checkbox list and can be
//!     disabled through `enabled_tools` — ADR 0102 §2.3's second read site, closed by
//!     D2. What is still NOT this module's business is the FILTER itself: `narrow`
//!     (the engine's agent-definition frontmatter path) still tests membership against
//!     `tool_specs()` alone, so a `tools:` list naming only host verbs cannot narrow a
//!     child. That is a crate-side limitation, accepted in the engine's `launch.rs`,
//!     and `docs/features/permissions-model.md` §(f.2) is its record.
//!   * **It does not widen script reach.** The entries carry the
//!     `ScriptAccess::Allowed` the crate gave the seven, so a codemode script's nested
//!     `tools.create_task(…)` still resolves — through the engine's registry, which is
//!     where the composed set lives. `mark_done` is advertised to the model and gated
//!     like every other host verb; it is reachable from a script no more widely than
//!     `create_task` is, and its subject is still the frame's Session, not a script's
//!     argument.

mod exec;
mod specs;

#[cfg(test)]
mod tests;

/// The eight host `ToolSpec`s — the desktop's half of the advertised tool surface.
///
/// This is what rides `StartEnv::host_tools` on every Session's envelope, and the
/// engine composes it onto its own 19 built-ins.
///
/// `pub` rather than `pub(crate)` for ONE reason outside the crate: an integration
/// test that drives a real Worker has to build the SAME envelope production builds,
/// and `tests/worker_e2e.rs`'s board cases cannot compose an advertised set they have
/// no name for. A fixture that hand-spelled the specs would be a SECOND owner of
/// the advertised surface — the exact thing `commands/tasks/tests/artifacts.rs`'s
/// negative pin was written to forbid — so it reaches this one function instead. Its
/// in-crate consumers are `session/mod.rs` (the envelope hop) and
/// `commands/settings.rs` (D2, the Settings list).
pub fn host_tool_specs() -> Vec<crate::agent::harness::ToolSpec> {
    specs::specs()
}

/// Run one host-tool call against the Supervisor's `Db`, answering in the sentence
/// the frame's error half carries. The body of `router.rs`'s `HostToolCall` arm.
///
/// Takes the frame's origin session id and the child flag for the reason `exec`'s own
/// doc gives: a host verb whose subject is the caller takes it from the frame, never
/// from `params`.
pub(crate) use exec::run;
