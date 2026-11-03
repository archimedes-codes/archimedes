//! The desktop settings' VALUE types (T5/S2 §2c's SPLIT, completed in S4).
//!
//! ## Why these three and not `config.rs`
//!
//! The plan's §2c ruling is that `config.rs` SPLITS rather than moves: the value
//! DTOs come here and `load_settings` STAYS desktop, because `load_settings` IS
//! the T3 disk boundary — moving it would put the desktop's `settings.json`
//! loader inside the engine and silently undo T3. S2 executed that split for
//! `WebSettings` (now `crate::web::config`); S4 completes it for the three the
//! packaged `StartEnv` names: `StartEnv.providers` is a `Vec<ProviderConfig>`,
//! `StartEnv.agent_overrides` is a `HashMap<String, AgentOverrideFields>`, and
//! `ProviderConfig.oidc` is an `Option<OidcConfig>`, so all three are embedded in
//! a wire type the crate must own. Leaving any of them desktop would have made a
//! crate type name a desktop type — the package cycle, arriving through a field.
//!
//! Nothing here reads a file. The disk read stays in the desktop's
//! `config.rs::load_settings`, which imports these types back
//! (desktop→crate, the allowed direction) so `crate::config::ProviderConfig` and
//! the other existing spellings keep resolving with zero edits — the same
//! re-export shape S2 used for `WebSettings`.
//!
//! `OidcConfig` is the fourth of the plan's §2c list. It has no crate-side
//! consumer on its own, but it is a FIELD TYPE of `ProviderConfig`, so it cannot
//! be left behind; the same embedded-type logic that pulled `AgentOverrideFields`
//! in applies one level deeper.

use serde::{Deserialize, Serialize};

// ── `ProviderConfig` ────────────────────────────────────────────────────────────

/// A user-managed LLM provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// The provider's id: the slug of its name (the desktop's Settings page
    /// derives it from the name — a name commit re-identifies the provider,
    /// remapping the `default_model` / `default_thinking_levels` references
    /// old → new; a blank name keeps the current id).
    pub id: String,
    pub name: String,
    /// Normalized base URL (…/v1).
    pub base_url: String,
    /// Plaintext (empty = local gateway, no key).
    pub api_key: String,
    /// The wire API (ADR 0024): `"openai-completions"` (the default — a
    /// pre-feature file parses to it, no migration) / `"anthropic-messages"`
    /// / `"openai-responses"` / `"litellm"` (discovery via `GET /model/info`,
    /// wire = openai-completions — ADR 0026).
    #[serde(default = "default_provider_api")]
    pub api: String,
    /// The key-management page URL (set by the known-providers picker — the
    /// row's "Get key" link; `None` for a hand-typed provider).
    #[serde(default)]
    pub key_url: Option<String>,
    /// The provider's auth mode (issue #125): `"api_key"` (the default — a
    /// pre-feature file parses to it) | `"oauth"` | `"oidc"` | `"gcloud_adc"`.
    /// A STRING, not an enum, matching `api`'s permissive-boundary style;
    /// validate at use, not at parse. Additive: pre-feature files parse
    /// untouched via the serde default.
    #[serde(default = "default_provider_auth_mode")]
    pub auth_mode: String,
    /// Custom per-provider request headers (issue #129), written with
    /// environment templates: `$VAR` and `${VAR}` expand against the process
    /// environment SINGLE-PASS at resolve time (never recursively). Examples:
    /// `"CF-Access-Client-Id": "$CLOUDFLARE_SERVICE_TOKEN_ID"` — enterprise
    /// proxies (Cloudflare Access, …) authenticate this way. `None` = no
    /// custom headers. Additive: a pre-feature file parses to `None`.
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    /// Explicitly allow plain `http://` provider base URLs (the default of
    /// `false` refuses any non-loopback `http://` base with a descriptive
    /// error). Loopback (`127.0.0.0/8`, `::1`) is ALWAYS allowed (ADR 0057 —
    /// local dev servers are essential).
    #[serde(default)]
    pub allow_insecure_http: bool,
    /// ADC: read the Google Application Default Credentials file and exchange
    /// the refresh token natively (the `gcloud_adc` flow, issue #128). Also
    /// enabled by `auth_mode: "gcloud_adc"`, and overridable by the
    /// `LITELLM_GCLOUD_TOKEN_AUTH` env var — which the RESOLVE arm reads, never
    /// this module (an env read here would cache at parse time and make the
    /// toggle untestable; see the desktop's `provider_auth::gcloud_token_auth_enabled`).
    /// Additive: a pre-feature file parses to `false`, so no existing row
    /// starts reading the user's ADC file on upgrade.
    #[serde(default)]
    pub use_gcloud_token_auth: bool,
    /// Direct OIDC PKCE login against an external identity provider (the
    /// `oidc` flow, issue #127). The validated `id_token` becomes the Bearer
    /// token sent to the LiteLLM proxy.
    ///
    /// Additive: the field is `#[serde(default)]`, so a pre-feature provider
    /// parses to `None` and keeps its existing behaviour. A PRESENT but
    /// malformed block (missing/blank `issuer`/`clientId`, wrong types) FAILS
    /// the whole `Settings` document parse and lands in `load_settings`'s
    /// existing corrupt-file fallback (`Settings::default()` + the corrupt-file
    /// log) — the same whole-document behaviour as any other malformed field
    /// today. There is deliberately NO degrade-to-`None`-and-keep-parsing path:
    /// silently dropping a user's configured login is worse than the honest,
    /// pre-existing fallback.
    #[serde(default)]
    pub oidc: Option<OidcConfig>,
}

/// The OIDC identity-provider configuration (the `oidc` member on a provider
/// row, issue #127).
///
/// `issuer` and `client_id` are REQUIRED (no `#[serde(default)]`): a present
/// `oidc` block that omits them fails the document parse (see the field doc on
/// [`ProviderConfig::oidc`] for the whole-document rule). `scope` and
/// `redirect_ports` are `#[serde(default)]` (absent → `None` / the empty list,
/// and the flow then asks for `openid` alone on one ephemeral callback port).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcConfig {
    /// The IdP issuer — the base for
    /// `GET {issuer}/.well-known/openid-configuration`.
    pub issuer: String,
    /// The PRE-REGISTERED public client id (T6 does no dynamic registration):
    /// the `client_id` in the authorize request and the value the `aud`/`azp`
    /// claims are checked against.
    pub client_id: String,
    /// The requested scope. MUST include `openid`; the flow appends `openid`
    /// when absent. `None` → `openid` alone.
    #[serde(default)]
    pub scope: Option<String>,
    /// The sequential callback-port list (corporate IdPs pin redirect URIs to a
    /// fixed port allowlist, so the loopback server tries these in order).
    /// Empty/missing → ONE ephemeral port.
    #[serde(default)]
    pub redirect_ports: Vec<u16>,
}

fn default_provider_api() -> String {
    "openai-completions".to_string()
}

fn default_provider_auth_mode() -> String {
    "api_key".to_string()
}

// ── `AgentOverrideFields` ───────────────────────────────────────────────────────

/// (ADR 0066 / 0067) One agent's override — the VALUE of
/// `Settings::agent_overrides`.
///
/// **Field ABSENCE is the only meaning of "this override does not speak"**
/// (ADR 0067): an unset field is absent from the document
/// (`skip_serializing_if = "Option::is_none"`), never `null` — a `"model":
/// null` would be a third state for the resolver to reconcile, and the whole
/// point of the rule is that the UI's "clear this override" and the
/// resolver's "skip this layer" are literally the same fact. A `tools` list
/// that is EMPTY also speaks not (ADR 0067, enforced in
/// `launch::resolve_agent_launch`), so no override can zero out a child.
///
/// Derived `Default` is safe HERE and only because every field is an
/// `Option` (all-absent = "says nothing") — unlike `FontSettings`, whose
/// hand-written `Default` exists because a derived one would produce
/// `size_px: 0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentOverrideFields {
    /// The model ref (`"provider/id"`, or a hand-edited
    /// `"provider/id:<level>"` — the `:<level>` suffix is a thinking-level
    /// candidate handled downstream, exactly as in ADR 0023).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// A thinking level. Honoured only when the model that actually runs
    /// advertises it (`launch::resolve_agent_launch` demotes it otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// The tool allowlist. An EMPTY list is ABSENT (ADR 0067).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}
