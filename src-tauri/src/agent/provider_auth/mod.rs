//! Supervisor-side provider credentials: the `provider-auth.json` store, the
//! bearer-resolution dispatcher, and the background refresher. Deliberately
//! NOT under `agent/harness/provider/` (the wire clients — ADR 0024).
//!
//! The token's destination is `Model.api_key` (interface §1):
//! `EffectiveCatalog::resolve` is the single substitution site, so the Worker
//! never learns about OAuth/ADC/OIDC — it holds a pushed snapshot string.
//! Wiring `resolve_bearer` into `resolve` is T2/T4's seam; this module owns
//! the resolution, the store and the refresh lifecycle.
//!
//! # T7 — this file is a SPLIT-MODULE SHELL
//!
//! Seven of this directory's nine files moved to
//! `crates/fulcrum-core/src/provider_auth/` (`budget`, `store`, `key_helper`,
//! `gcloud`, `cli_sso`, `litellm_oauth`, `oidc`) along with the three free
//! functions that used to live in this file (`gcloud_token_auth_enabled`,
//! `resolve_bearer`, `resolve_bearer_at`). `headers.rs` had already moved in
//! T5/S3 as `provider_headers`. ONE file stayed desktop and this file declares
//! it:
//!
//! * [`refresh`] — the `tauri` half (`SupervisorRefresherDeps<R:
//!   tauri::Runtime>`, `tauri::AppHandle`, `session::SessionManager`);
//!
//! and this file holds the desktop half of the [`budget::ProviderSource`] seam
//! ([`SettingsProviderSource`] + [`budget_poller_for`]), because `load_settings`
//! — the `settings.json` read `BudgetPoller` used to make on every tick — IS the
//! disk boundary and stays here (ADR 0091: the crate gets the shape, the desktop
//! keeps the file).
//!
//! Everything else is a `pub use`. The names are re-exported BOTH as modules
//! and by name, because module-qualified spellings outnumber named ones (the S1
//! measurement, and the reason S1–S5b and S8.1–S8.4 kept this shape):
//! `session/mod.rs`, `lib.rs`, `commands/settings.rs` and the `provider_*`
//! integration targets all address `…::agent::provider_auth::store::…` /
//! `…::gcloud::TestAdcOverride` / `…::resolve_bearer_at`, and every one of them
//! compiles with ZERO edits.
//!
//! `refresh.rs` is the proof the shell works: its
//! `use super::{budget, litellm_oauth, oidc, store}` resolves THROUGH this
//! file's re-exports (`super::` of a submodule is this module, and a `pub use`
//! is a module path like any other), so it needed exactly ONE line changed —
//! the `BudgetPoller::new` → [`budget_poller_for`] call in its own `#[cfg(test)]`
//! cadence fixture. That is the constructor change the seam forces, not a path
//! problem. It is only sound because the dependency graph of the moved set is a
//! DAG with no edge to `refresh::` — `resolve_bearer_at` calls `gcloud`, `oidc`
//! and `store` only, and `refresh.rs` never calls `resolve_bearer_at`.
//!
//! `headers` is the S3 precedent one level down: it moved to the crate as
//! `provider_headers`, and the alias below keeps
//! `crate::agent::provider_auth::headers::{expand_map, validate_base_url}`
//! resolving for `session/mod.rs` and `tests/provider_headers.rs`. A
//! `pub use ... as headers` and NOT a `pub mod headers`: Rust resolves one
//! `mod` to one file on THIS package's disk, and that file is gone.

use std::path::PathBuf;
use std::sync::Arc;

// NOTE: the seam's two types are spelled `budget::BudgetPoller` /
// `budget::ProviderSource` below, NOT imported. `BudgetPoller` reaches this
// module's namespace through the named re-export block at the bottom of this file
// (it has been part of the surface this file exports since before the move), so a
// second `use` of that name would be E0252; `ProviderSource` is spelled
// module-qualified through the `budget` MODULE alias and is deliberately NOT named
// in that block, because no desktop consumer ever reaches it at the
// `provider_auth::ProviderSource` root — the trait is named here, in this impl,
// and nowhere else on the desktop.

// ── the one file that stayed desktop ────────────────────────────────────────
pub mod refresh;

// ── T7/S7.1 + S7.2: the seven files that moved, as MODULE aliases (six today) ─
// The exact list this file declared before the move, minus `refresh` (declared
// above), `headers` (aliased below) and `key_helper` (the crate owns it, but no
// desktop path names it at ANY spelling — `resolve_bearer_at` reaches it
// crate-internally — so the alias was pruned rather than kept as a spelling
// nothing uses). Module aliases first because they carry
// the traffic: `crate::agent::provider_auth::gcloud::TestAdcOverride`
// (`session/mod.rs`'s cfg(test) ADC fixture + `tests/provider_gcloud_adc.rs`)
// needs the MODULE, not just the named symbols.
pub use fulcrum_core::provider_auth::{budget, cli_sso, gcloud, litellm_oauth, oidc, store};

// ── the desktop half of the `ProviderSource` seam (T7/S7.2, ADR 0091) ───────

/// The desktop's [`budget::ProviderSource`]: it reads the settings document and hands
/// over its provider rows. THIS is the file owner — the crate's `BudgetPoller`
/// asks "which providers exist?", never "parse my settings file".
///
/// It returns `settings.providers` UNFILTERED on purpose: the `api == "litellm"`
/// filter belongs to the poller (the crate owns the "only LiteLLM rows are
/// polled" rule, because the three poll hops are LiteLLM management routes).
struct SettingsProviderSource {
    config_dir: PathBuf,
}

impl budget::ProviderSource for SettingsProviderSource {
    fn providers(&self) -> Vec<crate::config::ProviderConfig> {
        crate::config::load_settings(&self.config_dir).providers
    }
}

/// Build a [`BudgetPoller`] over the real settings file (the desktop's answer to
/// "here is where settings live").
///
/// The seam's other half is the crate's
/// [`BudgetPoller::new_with_source`](fulcrum_core::provider_auth::budget::BudgetPoller::new_with_source),
/// which takes an `Arc<dyn ProviderSource>` — a shape no desktop call site wants
/// to spell, because every desktop call site has a settings DIRECTORY. This
/// helper is where the directory becomes a source, so `load_settings` is named
/// in exactly ONE place on the desktop side of the boundary.
pub fn budget_poller_for(
    config_dir: PathBuf,
    auth_file: PathBuf,
    interval_millis: u64,
) -> BudgetPoller {
    BudgetPoller::new_with_source(
        Arc::new(SettingsProviderSource { config_dir }),
        auth_file,
        interval_millis,
    )
}

// ── T5/S3: `headers.rs` MOVED to `crates/fulcrum-core/src/provider_headers.rs`.
// It is the ONLY part of this directory S3 needed (`expand_map`, one call site
// at `harness/provider/mod.rs:106`), so the crate-side module is named for the
// one file that moved, not for this directory. That changed with T7/S7.1 — the
// crate now owns six of them under `provider_auth` — but the ALIAS stays,
// because `session/mod.rs` (two `validate_base_url` calls) and
// `tests/provider_headers.rs` still address `provider_auth::headers::…`.
pub use fulcrum_core::provider_headers as headers;

// ── the named surface, as this file exported it before the move, minus the
// names no desktop path ever spelled ──────────────────────────────────────────
// Everything here resolves through `fulcrum_core::provider_auth` via the module
// aliases above — `budget` included since S7.2, `refresh` the one desktop
// module. The three free functions that used to be DEFINED here are re-exported
// from the crate — `resolve_bearer_at` is named by `commands/settings.rs`,
// `tests/*.rs` and the crate's own `budget.rs` (`use super::{…}`).
// `ProviderSource` is NOT in this block: the trait is crate-owned, the desktop's
// ONLY impl is the one in this file, and it spells the trait
// `budget::ProviderSource` through the module alias. A named root re-export of it
// had zero consumers, so it was pruned — the `budget` MODULE alias is what keeps
// the name reachable, and it stays.
pub use budget::{
    classify_status, poll_all, poll_key_info, poll_user_info, run_budget_tick, BudgetEndpoint,
    BudgetFacts, BudgetPoller, DenialMemory, KeyBudget, PollStatus, TeamBudget,
    BUDGET_POLL_INTERVAL_MILLIS,
};
// The three functions this file USED TO DEFINE, now crate-owned.
pub use fulcrum_core::provider_auth::{
    gcloud_token_auth_enabled, resolve_bearer, resolve_bearer_at,
};
// From here down, the named block VERBATIM as it landed before the move — the
// module aliases above resolve each of these to the crate's file, so the
// spelling of every consumer stays byte-identical.
pub use gcloud::{describe_error, parse_adc, AdcCredential};
pub use headers::{expand_map, validate_base_url};
pub use oidc::{authenticate_oidc, credential_from_session, OidcSession};
// T5's login surface (issue #126): the PKCE DCR orchestrator + the legacy CLI
// SSO device flow. `ProviderLoginStep`/`TeamDto` are declared in
// `litellm_oauth` (the flow that PRODUCES them) and re-exported by
// `commands::settings` as its wire surface — ONE type, never a mirror struct.
// The flow's entry (`litellm_oauth::login`) is reached through the module alias
// by `commands/settings.rs`, never by a named re-export from this root.
pub use litellm_oauth::{ProviderLoginStep, TeamDto};
pub use refresh::{
    production_refresher_factory, refresh, SupervisorRefresher, SupervisorRefresherDeps,
};
pub use store::{
    auth_file_path, is_expiring_soon, load, now_epoch_millis, store_credential, OAuthCredential,
    OidcCredential, ProviderAuthStore, ProviderCredential, REFRESH_LEAD_MILLIS,
};
