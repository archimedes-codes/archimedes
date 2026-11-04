//! The native agent harness: the in-process `AgentLoop` session core —
//! drive the session lifecycle, the interactive channel, the subagent
//! manager.

// T5/S2 moved `boundary`, `childproc`, `definition_permission`, `policy` and
// `tools` into `crates/fulcrum-core`; T5/S3 moved `interactive`, `codemode` and
// `mcp`. Their `pub mod` declarations are GONE and the modules now arrive
// through the module-level `pub use fulcrum_core::{…}` below. `web` is the one
// EXCEPTION and keeps its declaration: `web/render.rs` stayed desktop (the Tauri
// webview), so `agent/web.rs` is a real desktop module that declares `render` and
// re-exports the six that moved. (`provider_auth` is the S3 case of the same
// rule in reverse — it STAYED, except `headers.rs`; see `provider_auth/mod.rs`.)
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
// `crate::agent::fs_backend::canonicalize_lenient(..)`,
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
// T5/S3 adds `codemode`, `interactive`, `mcp` (the one-way dependents on S2's
// cluster). The module-level line is the load-bearing half for S3 too:
// `harness/loop/codemode.rs` names `crate::agent::codemode::engine::
// CODEMODE_MEMORY_LIMIT`, `harness/loop/tools.rs` names
// `crate::agent::interactive::{sudo_run_flow, todo_apply}`, `commands/mcp.rs`
// names `crate::agent::mcp::config::*` and `commands/settings.rs` names
// `crate::agent::mcp::{types,manager,oauth}::*` — all module-qualified, so a
// named-only block would leave every one dangling (the S1 measurement: 193 such
// paths, 36 errors from deleting this line).
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
// no staying half at all, so the module alias alone is enough: the eight
// desktop consumers (`worker/client.rs`, `worker/protocol.rs`, `worker/core.rs`,
// `worker/manager/tests/mod.rs`, `session/mod.rs`, `harness/loop.rs`,
// `harness/loop/gate.rs`, `harness/loop/tests/policy_gate.rs`) keep their
// `crate::agent::permission::…` paths UNCHANGED.
// T5/S5b adds the last three files of the T5 closure — `harness` (a real
// desktop module above, because `store.rs`/`trust.rs` stayed), plus
// `normalize`, `persist` and `subagent`, which have NO staying half and so need
// the module alias alone. `subagent` is the one whose named block below had to
// GROW: `bin/fake_worker.rs`, `commands/agents.rs` and the two-sided
// `worker_e2e` fixtures all reach `subagent::{AgentNameResolution,
// LaunchConfig, SubagentOutcome, SubagentCancel, SubagentSessionManager}` and
// `SubagentCancel`'s dispatch variant was renamed with its held type
// (`Worker` → `Dispatcher`, the E2 re-plumb).
pub use fulcrum_core::{
    agents, boundary, childproc, codemode, debuglog, definition_permission, events, fs_backend,
    hostenv, ids, interactive, mcp, normalize, permission, persist, policy, skills, subagent, todo,
    tools, types,
};

pub use crate::types::SessionInfo;
pub use definition_permission::{
    Action, FrontmatterNote, PermissionBlock, Rule, Rules, ToolKey, UnsupportedReason,
};
pub use errors::{AgentsError, FilesError, McpError, SessionError, SettingsError, SpacesError};
pub use fulcrum_core::events::{EventSink, RpcEvent};
pub use fulcrum_core::fs_backend::{FsBackend, FsError};
pub use fulcrum_core::ids::{GateKey, RequestId, SessionId};
pub use fulcrum_core::normalize::{is_bookkeeping_message_id, normalize_capabilities};
pub use fulcrum_core::persist::TranscriptPersister;
pub use fulcrum_core::subagent::{
    AgentNameResolution, LaunchConfig, SubagentCancel, SubagentFailureReason, SubagentMetrics,
    SubagentOutcome, SubagentSessionManager,
};
pub use fulcrum_core::todo::{TodoItem, TodoStatus, TodoStore};
pub use interactive::{
    interactive_key, CachedPassword, PendingInteractive, PendingSudo, RealSudoRunner, SudoRun,
    SudoRunner,
};
pub use permission::{permission_key, PendingPermissions, PermissionOutcome};
pub use session::{
    user_message_payload, ClosedReason, EffectiveCatalog, ImagePayload, ProviderFactory,
    SessionManager, SessionManagerBuilder, StalledInfo, StopReason, MAX_IMAGE_BYTES,
};

pub use tools::{ContentBlock, ImageRef, ToolCtx, ToolResult};
