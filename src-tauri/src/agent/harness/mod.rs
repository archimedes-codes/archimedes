//! The native agent harness (native-agent-harness Phase 2): the in-process
//! Rust replacement for the pi agent process — a `Provider` (the model
//! client, Task 4) + the `AgentLoop` (Task 6: the model → tool →
//! retry/compaction loop, the native `ToolRegistry`, the SQLite
//! `SessionStore`, the `Compactor`, the `RetryPolicy`) + the model
//! catalog (Task 5). Grows across Tasks 5–7; the pieces land one per
//! task.
//!
//! # T5/S5b — this directory is now an ALIAS with two staying files
//!
//! The whole `harness` module moved to `crates/fulcrum-core/src/harness/`
//! (`fulcrum_core::harness`). Two files stayed HERE, and both for the same
//! reason — they hold a `storage::Db`, and the crate has no `rusqlite` in its
//! graph (Step B-bis: `DbError` wraps `rusqlite::Error`, so nothing that touches
//! a `Db` can cross the boundary):
//!
//!   * [`store`] — `SessionStore`, the desktop's implementation of the crate's
//!     `Store` trait (the trait + `NoopStore` + `role_str` moved, with their
//!     error type re-typed to the crate's `StoreError`);
//!   * [`trust`] — `SqliteTrustSource`, the desktop's implementation of the
//!     crate's `TrustSource` trait (S5a's split).
//!
//! Both re-export the crate halves they belong to, so every pre-S5b spelling
//! (`crate::agent::harness::store::SessionStore`,
//! `crate::agent::harness::trust::SqliteTrustSource`, and the trait names)
//! resolves UNCHANGED. That is the same shape `agent/web.rs` landed for
//! `web/render.rs` in S2: one `mod` path, two packages underneath, and the
//! crate's own view of `harness` complete and desktop-free — nothing in the
//! crate can name `harness::store::SessionStore`, because
//! `crates/fulcrum-core/src/harness/mod.rs` declares neither file.
//!
//! The module-level `pub use` line below is the load-bearing half (the S1
//! measurement: 193 module-qualified consumer paths, 36 errors from deleting one
//! such line). `commands/agents.rs` names `harness::launch::{override_layer,
//! resolve_agent_launch, OverrideSource, OverrideLayer}`,
//! `worker/manager/subagent_flow.rs` named `harness::r#loop::tool_specs` until
//! T8/S8.3 moved it into the crate (where it spells `crate::harness::…`), and
//! `commands/settings.rs` names `harness::{tool_specs, Model}` — all
//! module-qualified.

pub mod store;
pub mod trust;

// The modules that moved. MODULE-level aliases, not just named symbols:
// `crate::agent::harness::launch::…` and `crate::agent::harness::r#loop::…` are
// named by files outside `agent/`, and a named-only block leaves every one of
// them dangling.
pub use fulcrum_core::harness::{
    ask, catalog, compact, dispatch, launch, prompt, provider, r#loop, retry, tool_specs,
};

// The two S4-era aliases, now pointing at the crate's own `harness` (they were
// `pub use fulcrum_core::{model_key, wire}` — the same aliases, one level up).
// `crate::agent::harness::model_key::ModelKey` (`session/naming.rs:30`) and
// `crate::agent::harness::WireApi` (the STAYING `config.rs`) both resolve here.
pub use fulcrum_core::harness::{model_key, wire};

pub use fulcrum_core::harness::{
    build_child_system_message, build_main_prompt, build_provider, discover_models,
    load_project_context, merge_catalog, split_for_compaction, AgentLoop, AnthropicProvider,
    CompactionConfig, Compactor, ControlCmd, DiscoveredMeta, InProcessDispatcher, MockDispatcher,
    Model, ModelCatalog, ModelKey, ModelOptions, ModelRef, ModelRequest, OpenAiCompatibleProvider,
    OpenAiResponsesProvider, Prompt, PromptContext, PromptTurn, Provider, ProviderDiscovery,
    ProviderError, ProviderEvent, RetryPolicy, SubagentDispatcher, SudoDeps, ToolCall,
    ToolCallDelta, ToolSpec, Usage, DEFAULT_CONTEXT_WINDOW,
};
// `tool_specs` is NOT named in this block on purpose: the MODULE alias above already
// brings BOTH namespaces (the module `harness::tool_specs` and the function
// `tool_specs()` the crate's own block re-exports), and naming it a second time
// under the same spelling is E0252. `commands/settings.rs`'s `use …::harness::{tool_specs, Model}` then
// `tool_specs()` resolves through the alias, exactly as it did pre-move.
pub use fulcrum_core::harness::{ChatMessage, ChatRole, FinishReason, MessageContent, WireApi};
// The store SPLIT: the trait + the two crate-side implementations come from the
// crate, `SessionStore` is the desktop half declared above.
pub use crate::agent::harness::store::SessionStore;
pub use fulcrum_core::harness::store::{DisplayRow, NoopStore, Store};
pub use fulcrum_core::trust::{StaticTrustSource, TrustSource};
pub use trust::SqliteTrustSource;
