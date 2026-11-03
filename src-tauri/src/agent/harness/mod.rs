//! The native agent harness (native-agent-harness Phase 2): the in-process
//! Rust replacement for the pi agent process — a `Provider` (the model
//! client, Task 4) + the `AgentLoop` (Task 6: the model → tool →
//! retry/compaction loop, the native `ToolRegistry`, the SQLite
//! `SessionStore`, the `Compactor`, the `RetryPolicy`) + the model
//! catalog (Task 5). Grows across Tasks 5–7; the pieces land one per
//! task.

pub(crate) mod ask;
pub mod catalog;
pub mod compact;
pub mod dispatch;
pub(crate) mod launch;
pub mod r#loop;
pub mod prompt;
pub mod provider;
pub mod retry;
pub mod store;
pub mod tool_specs;
pub mod trust;

// ── T5/S4 — three harness leaves moved to `fulcrum-core` (module-level re-export) ──
//
// These three `mod` declarations are GONE and the modules now arrive as aliases.
// Why they moved at all: Step E.4 moves `resolve_composed_model` into the crate to
// sever edge E4, and a package boundary checks SIGNATURES, not bodies — its
// `(catalog: &ModelCatalog, key: &str) -> Option<Model>` pulled `Model`/
// `ModelCatalog` across, and those reach for `ModelKey` (their `From` impl) and
// `WireApi` (the `selectable` predicate), so both had to come too. `catalog` keeps
// its declaration because it is a SPLIT: the data types moved, the network
// discovery did not (it calls this crate's provider transport).
//
// The ALIASES are load-bearing, not tidiness. `provider/mod.rs` and `catalog.rs`
// use the same trick one level down (`pub use fulcrum_core::provider_types as
// types`), which is why the five provider modules that stayed desktop needed
// ZERO edits: `super::types::ChatMessage` and `super::overflow::…` still resolve,
// to the crate. Here, `pub use fulcrum_core::{model_key, wire}` keeps
// `crate::agent::harness::model_key::ModelKey` (`session/naming.rs:30`) and
// `crate::agent::harness::WireApi` (the STAYING `config.rs:24`, which the plan
// names as a required re-export target) compiling untouched.
pub use fulcrum_core::{model_key, wire};

pub use catalog::{
    discover_models, merge_catalog, CompactionConfig, DiscoveredMeta, Model, ModelCatalog,
    ProviderDiscovery, DEFAULT_CONTEXT_WINDOW,
};
pub use compact::{split_for_compaction, Compactor};
pub use dispatch::{InProcessDispatcher, MockDispatcher, SubagentDispatcher};
pub use model_key::{ModelKey, ModelRef};
pub use prompt::{
    build_child_system_message, build_main_prompt, load_project_context, PromptContext,
};
pub use provider::{
    build_provider, AnthropicProvider, ChatMessage, ChatRole, FinishReason, MessageContent,
    ModelOptions, ModelRequest, OpenAiCompatibleProvider, OpenAiResponsesProvider, Provider,
    ProviderError, ProviderEvent, ToolCall, ToolCallDelta, ToolSpec, Usage,
};
pub use r#loop::{AgentLoop, ControlCmd, Prompt, PromptTurn, SudoDeps};
pub use retry::RetryPolicy;
pub use store::{DisplayRow, NoopStore, SessionStore, Store};
pub(crate) use tool_specs::tool_specs;
pub use trust::{SqliteTrustSource, StaticTrustSource, TrustSource};
pub use wire::WireApi;
