//! The native agent harness: the in-process `AgentLoop` session core —
//! drive the session lifecycle, the interactive channel, the subagent
//! manager.

// T5/S2 moved `boundary`, `childproc`, `definition_permission`, `policy` and
// `tools` into `crates/fulcrum-core`; their `pub mod` declarations are GONE and
// the modules now arrive through the module-level `pub use fulcrum_core::{…}`
// below. `web` is the one EXCEPTION and keeps its declaration: `web/render.rs`
// stayed desktop (the Tauri webview), so `agent/web.rs` is a real desktop module
// that declares `render` and re-exports the six that moved.
pub mod codemode;
pub mod crashlog;
pub mod errors;
pub mod harness;
pub mod interactive;
pub mod mcp;
mod normalize;
mod permission;
pub mod persist;
pub mod provider_auth;
mod session;
pub mod subagent;
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
pub use fulcrum_core::{
    agents, boundary, childproc, debuglog, definition_permission, events, fs_backend, hostenv, ids,
    policy, skills, todo, tools, types,
};

pub use crate::types::SessionInfo;
pub use definition_permission::{
    Action, FrontmatterNote, PermissionBlock, Rule, Rules, ToolKey, UnsupportedReason,
};
pub use errors::{AgentsError, FilesError, McpError, SessionError, SettingsError, SpacesError};
pub use fulcrum_core::events::{EventSink, RpcEvent};
pub use fulcrum_core::fs_backend::{FsBackend, FsError};
pub use fulcrum_core::ids::{GateKey, RequestId, SessionId};
pub use fulcrum_core::todo::{TodoItem, TodoStatus, TodoStore};
pub use interactive::{
    interactive_key, CachedPassword, PendingInteractive, PendingSudo, RealSudoRunner, SudoRun,
    SudoRunner,
};
pub use normalize::{is_bookkeeping_message_id, normalize_capabilities};
pub use permission::{permission_key, PendingPermissions, PermissionOutcome};
pub use persist::TranscriptPersister;
pub use session::{
    user_message_payload, ClosedReason, EffectiveCatalog, ImagePayload, ProviderFactory,
    SessionManager, SessionManagerBuilder, StalledInfo, StopReason, MAX_IMAGE_BYTES,
};
pub use subagent::{
    AgentNameResolution, LaunchConfig, SubagentMetrics, SubagentOutcome, SubagentSessionManager,
};

pub use tools::{ContentBlock, ImageRef, ToolCtx, ToolResult};
