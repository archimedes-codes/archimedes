//! The native agent harness: the in-process `AgentLoop` session core —
//! drive the session lifecycle, the interactive channel, the subagent
//! manager.

// T5/S2 moved `boundary`, `childproc`, `definition_permission`, `policy` and
// `tools` into `crates/fulcrum-core`; T5/S3 moved `interactive`, `codemode` and
// `mcp`. Their `pub mod` declarations are GONE and the modules now arrive
// through the module-level `pub use fulcrum_harness::{…}` below. `web` is the one
// EXCEPTION and keeps its declaration: `web/render.rs` stayed desktop (the Tauri
// webview), so `agent/web.rs` is a real desktop module that declares `render` and
// re-exports the moved ones its paths still address. (`provider_auth` is the SAME
// split shape, one step later: T7 moved SEVEN of its nine files to the crate's
// `provider_auth`
// (six in S7.1, `budget.rs` in S7.2) and its `mod.rs` is now a re-export shell
// that keeps only `refresh` — the `tauri` half — as a real desktop module, plus
// the desktop half of the `ProviderSource` seam (`budget_poller_for` /
// `SettingsProviderSource`) that lets `budget.rs` move without taking
// `load_settings` with it. `headers.rs` was the S3 exception — it moved early,
// as the crate's `provider_headers`. See `provider_auth/mod.rs`.)
pub mod crashlog;
pub mod errors;
pub mod harness;
pub mod provider_auth;
mod session;
pub mod web;
pub mod worker;

// ── T5/S1 + T5/S2 re-export seam (ADR 0091, Step A.2) ───────────────────────
// The leaf modules (S1) and the `{tools, web, boundary}` cluster + its
// co-residents (S2) moved to `crates/fulcrum-core`. Re-exporting the MODULE (not
// just its symbols) is what keeps every module-qualified consumer path —
// `crate::agent::tools::exec::access::rule_deny_text(..)`,
// `crate::skills::home_dir()` — compiling with ZERO edits outside `agent/`; the
// named `pub use`s below keep the bare-symbol imports working too.
//
// `skills` and `agents` are in this list so `src-tauri/src/lib.rs` can re-export
// them at the CRATE root (`crate::skills::…`, `archimedes_lib::agents::…`)
// without a `pub mod` of their own. `roots` is deliberately absent: it was
// `pub(crate)` on the desktop and its only two callers (`skills.rs`,
// `agents.rs`) moved with it, so it stays crate-internal on both sides.
//
// `web` is NOT here — see `web.rs`.
//
// T5/S3 adds `interactive` and `mcp` to this list (`codemode` arrived in the same
// sub-step but is no longer aliased here — see the crate-internal bullet below).
// The module-level line is the load-bearing half for S3 too — but the
// examples split by which package spells them now:
//
// * DESKTOP paths (the reason the aliases exist): `commands/mcp.rs` names
//   `crate::agent::mcp::config::*` and `commands/settings.rs` names
//   `crate::agent::mcp::{types,manager,oauth}::*`; `tests/harness_loop.rs` names
//   `archimedes_lib::agent::interactive::PendingInteractive`.
// * CRATE-internal paths (NOT desktop consumers — these files moved to the crate,
//   so they name their own package): `harness/loop/codemode.rs` is crate-owned
//   since T8 and spells `crate::codemode::engine::CODEMODE_MEMORY_LIMIT`
//   (`fulcrum/src/codemode/engine.rs`), and `harness/loop/tools.rs` spells
//   `crate::interactive::{sudo_run_flow, todo_apply}`.
//
// Every one of these is module-qualified, so a named-only block would leave each
// one dangling (the S1 measurement: 193 such paths, 36 errors from deleting this
// line).
//
// `launch_config` is deliberately NOT in this list. `LaunchConfig` reached the
// desktop through `subagent::LaunchConfig` and `agent::LaunchConfig` before S3,
// and both paths still resolve — `subagent.rs` re-exports the crate type and the
// named block below still names it. Adding a second public alias for one DTO
// would be a third spelling of one type for no consumer.
//
// T5/S5a adds `permission` (the module S2's scope named and S2's commit did not
// move) and `trust` — the latter NOT in this list, because it is a SPLIT that
// needs a real desktop module file: `harness/trust.rs` holds `SqliteTrustSource`
// (a `storage::Db` cannot cross) and re-exports the two crate halves, so
// `crate::agent::harness::trust::{TrustSource, StaticTrustSource,
// SqliteTrustSource}` all still resolve at their pre-S5a path. `permission` has
// no staying half at all, so the module alias alone is enough, and every desktop
// consumer keeps its `crate::agent::permission::…` path UNCHANGED.
// NO CONSUMER LIST HERE, ON PURPOSE. This comment used to name eight files; five
// of them were stale inside three sub-steps, because `worker/` and `harness/` have
// each moved since (T8/S8.1, S8.2). An enumeration of consumers is wrong by
// construction the next time anything moves — derive it instead:
//   grep -rl 'crate::agent::permission::' src-tauri/src --include='*.rs'
// T5/S5b adds the last three files of the T5 closure — `harness` (a real
// desktop module above, because `store.rs`/`trust.rs` stayed), plus
// `normalize`, `persist` and `subagent`, which have NO staying half and so need
// the module alias alone. `subagent` is the one whose named block below had to
// GROW: `bin/fake_worker.rs`, `commands/agents.rs` and the two-sided
// `worker_e2e` fixtures all reach `subagent::{AgentNameResolution,
// LaunchConfig, SubagentOutcome, SubagentCancel, SubagentSessionManager}` and
// `SubagentCancel`'s dispatch variant was renamed with its held type
// (`Worker` → `Dispatcher`, the E2 re-plumb).
pub use fulcrum_harness::{
    agents, boundary, childproc, debuglog, definition_permission, events, hostenv, ids,
    interactive, mcp, normalize, permission, persist, policy, skills, subagent, todo, tools, types,
};

pub use crate::types::SessionInfo;
pub use definition_permission::{Action, FrontmatterNote, PermissionBlock, Rules, ToolKey};
pub use errors::{
    AgentsError, FilesError, McpError, SessionError, SettingsError, SpacesError, TasksError,
};
pub use fulcrum_harness::events::{EventSink, RpcEvent};
pub use fulcrum_harness::fs_backend::{FsBackend, FsError};
pub use fulcrum_harness::normalize::normalize_capabilities;
pub use fulcrum_harness::persist::TranscriptPersister;
pub use fulcrum_harness::subagent::{
    AgentNameResolution, LaunchConfig, SubagentCancel, SubagentFailureReason, SubagentMetrics,
    SubagentOutcome, SubagentSessionManager,
};
pub use fulcrum_harness::todo::TodoStore;
pub use interactive::PendingInteractive;
pub use permission::{permission_key, PendingPermissions, PermissionOutcome};
pub use session::{
    user_message_payload, ClosedReason, EffectiveCatalog, ImagePayload, ProviderFactory,
    SessionManager, SessionManagerBuilder, StalledInfo, StopReason, MAX_IMAGE_BYTES,
};
// The second hop of the ONE symbol `commands/tasks.rs` needs (first hop:
// `pub(crate) use naming::clean_title;` in `session/mod.rs`). Both hops are
// `pub(crate) use` of ONE name, matching the one-symbol-per-line idiom above —
// `mod session` itself stays private, so the whole title machinery does not
// become reachable from `commands/`. `commands/attention.rs` carries a private
// copy of `cap_chars` for exactly the reason this chain did not exist yet; a
// third caller of THAT should hoist one shared helper.
pub(crate) use session::clean_title;

pub use tools::{ContentBlock, ImageRef, ToolCtx, ToolResult};
