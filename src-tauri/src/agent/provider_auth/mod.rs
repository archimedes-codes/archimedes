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
//! # T7/S7.1 — this file is a SPLIT-MODULE SHELL
//!
//! Six of this directory's nine files moved to
//! `crates/fulcrum-core/src/provider_auth/` (`store`, `key_helper`, `gcloud`,
//! `cli_sso`, `litellm_oauth`, `oidc`) along with the three free functions that
//! used to live in this file (`gcloud_token_auth_enabled`, `resolve_bearer`,
//! `resolve_bearer_at`). THREE files stayed desktop, and this file declares the
//! two of them that are real desktop modules:
//!
//! * [`refresh`] — the `tauri` half (`SupervisorRefresherDeps<R:
//!   tauri::Runtime>`, `tauri::AppHandle`, `session::SessionManager`);
//! * [`budget`] — still desktop at this commit: it reads `load_settings`, and
//!   the `ProviderSource` seam that lets it move is S7.2's, not S7.1's.
//!
//! Everything else is a `pub use`. The names are re-exported BOTH as modules
//! and by name, because module-qualified spellings outnumber named ones (the S1
//! measurement, and the reason S1–S5b and S8.1–S8.4 kept this shape):
//! `session/mod.rs`, `lib.rs`, `commands/settings.rs` and the `provider_*`
//! integration targets all address `…::agent::provider_auth::store::…` /
//! `…::gcloud::TestAdcOverride` / `…::resolve_bearer_at`, and every one of them
//! compiles with ZERO edits.
//!
//! The two staying files are the proof the shell works: `refresh.rs`'s
//! `use super::{budget, litellm_oauth, oidc, store}` and `budget.rs`'s
//! `use super::{resolve_bearer_at, store};` both resolve THROUGH this file's
//! re-exports (`super::` of a submodule is this module, and a `pub use` is a
//! module path like any other), so neither needed a single line changed. That
//! is only sound because the dependency graph of the moved set is a DAG with no
//! edge to `refresh::` — `resolve_bearer_at` calls `gcloud`, `oidc` and `store`
//! only, and `refresh.rs` never calls `resolve_bearer_at`.
//!
//! `headers` is the S3 precedent one level down: it moved to the crate as
//! `provider_headers`, and the alias below keeps
//! `crate::agent::provider_auth::headers::{expand_map, validate_base_url}`
//! resolving for `session/mod.rs` and `tests/provider_headers.rs`. A
//! `pub use ... as headers` and NOT a `pub mod headers`: Rust resolves one
//! `mod` to one file on THIS package's disk, and that file is gone.

// ── the two files that stayed desktop ───────────────────────────────────────
pub mod budget;
pub mod refresh;

// ── T7/S7.1: the six files that moved, as MODULE aliases ────────────────────
// The exact list this file declared before the move, minus `budget`/`refresh`
// (declared above) and `headers` (aliased below). Module aliases first because
// they carry the traffic: `crate::agent::provider_auth::gcloud::TestAdcOverride`
// (`session/mod.rs`'s cfg(test) ADC fixture + `tests/provider_gcloud_adc.rs`)
// needs the MODULE, not just the named symbols.
pub use fulcrum_core::provider_auth::{cli_sso, gcloud, key_helper, litellm_oauth, oidc, store};

// ── T5/S3: `headers.rs` MOVED to `crates/fulcrum-core/src/provider_headers.rs`.
// It is the ONLY part of this directory S3 needed (`expand_map`, one call site
// at `harness/provider/mod.rs:106`), so the crate-side module is named for the
// one file that moved, not for this directory. That changed with T7/S7.1 — the
// crate now owns six of them under `provider_auth` — but the ALIAS stays,
// because `session/mod.rs` (two `validate_base_url` calls) and
// `tests/provider_headers.rs` still address `provider_auth::headers::…`.
pub use fulcrum_core::provider_headers as headers;

// ── the named surface, exactly as this file exported it before the move ─────
// `budget` and `refresh` resolve to the DESKTOP modules declared above; the
// rest resolve through `fulcrum_core::provider_auth` via the aliases. The three
// free functions that used to be DEFINED here are re-exported from the crate —
// `resolve_bearer_at` is named by `commands/settings.rs`, `tests/*.rs` and
// `budget.rs`'s `use super::{…}`.
pub use budget::{
    classify_status, poll_all, poll_key_info, poll_team_info, poll_user_info, run_budget_tick,
    should_probe, BudgetEndpoint, BudgetFacts, BudgetPoller, DenialMemory, KeyBudget, PollStatus,
    TeamBudget, UserBudget, BUDGET_POLL_INTERVAL_MILLIS,
};
// The three functions this file USED TO DEFINE, now crate-owned.
pub use fulcrum_core::provider_auth::{
    gcloud_token_auth_enabled, resolve_bearer, resolve_bearer_at,
};
// From here down, the named block VERBATIM as it landed before the move — the
// module aliases above resolve each of these to the crate's file, so the
// spelling of every consumer stays byte-identical.
pub use gcloud::{adc_file_path, describe_error, parse_adc, token as gcloud_token, AdcCredential};
pub use headers::{expand_map, validate_base_url};
pub use key_helper::run as run_key_helper;
pub use oidc::{authenticate_oidc, credential_from_session, OidcSession};
// T5's login surface (issue #126): the PKCE DCR orchestrator + the legacy CLI
// SSO device flow. `ProviderLoginStep`/`TeamDto` are declared in
// `litellm_oauth` (the flow that PRODUCES them) and re-exported by
// `commands::settings` as its wire surface — ONE type, never a mirror struct.
pub use litellm_oauth::{login as litellm_oauth_login, ProviderLoginStep, TeamDto};
pub use refresh::{
    noop_refresher_factory, production_refresher_factory, refresh, SupervisorRefresher,
    SupervisorRefresherDeps,
};
pub use store::{
    auth_file_path, is_expiring_soon, load, now_epoch_millis, remove_credential, save,
    store_credential, OAuthCredential, OidcCredential, ProviderAuthStore, ProviderCredential,
    REFRESH_LEAD_MILLIS,
};
