//! The native agent harness: the in-process `AgentLoop` session core —
//! drive the session lifecycle, the interactive channel, the subagent
//! manager.

pub mod boundary;
pub mod childproc;
pub mod codemode;
pub mod crashlog;
pub mod definition_permission;
pub mod errors;
pub mod harness;
pub mod interactive;
pub mod mcp;
mod normalize;
mod permission;
pub mod persist;
pub mod policy;
pub mod provider_auth;
mod session;
pub mod subagent;
pub mod tools;
pub mod web;
pub mod worker;

// ── T5/S1 re-export seam (ADR 0091, Step A.2) ────────────────────────────────
// The seven leaf modules moved to `crates/fulcrum-core`. Re-exporting the MODULE
// (not just its symbols) is what keeps every module-qualified consumer path —
// `crate::agent::fs_backend::canonicalize_lenient(..)`,
// `crate::agent::debuglog::log(..)`, `archimedes_lib::agent::events::RpcEvent` —
// compiling with ZERO edits outside `agent/`; the named `pub use`s below keep the
// bare-symbol imports (`use crate::agent::{EventSink, FsBackend, ..}`) working too.
pub use fulcrum_core::{debuglog, events, fs_backend, hostenv, ids, todo, types};

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
