---
status: retired
last-verified: 2026-11-22
verified-by: web + local research — 4 angles (2 web, 2 local-code), 2026-11-22; API claims from Keenable docs + its published OpenAPI 3.0.3 + live keyless probes, NO authenticated call was made
task: tsk_d740a5e2-5bc7-4af5-a893-1f9be4f3be8e
---

# Keenable as a first-class Search provider in Archimedes

> ## What changed since this reading (2026-11-24)
>
> **This report is a dated reading, kept as dated evidence — the text below is untouched.** It is
> stamped `status: retired` rather than `current`, because its central recommendation was not taken
> and several of its locally-verified facts have since moved. A plan author who trusts the headline
> claim below will cost the next feature wrongly.
>
> *Vocabulary note:* `status: superseded` was asked for and **is not a value any file in this repo
> uses** — `grep -rn '^status: superseded' docs/` → zero hits. The `docs/research/` vocabulary is
> `current` (23), `retired` (1, `pi-rpc-replaces-acp.md`), `accepted` (1), so `retired` is the chosen
> least-wrong fit: that precedent is also a research report kept on disk after the thing it studied was
> replaced. Worth recording, though, that the word is the repo's *stated* intention — the only other
> mention of it anywhere is `docs/features/anthropic-output-ceiling-known-gaps.md:85`, which prescribes
> exactly this treatment for a stale reading: "The fix is a **`status: superseded` flip** (or an
> amendment) in each, not a rewrite." If that flip is ever swept through, this file should take it.
>
> **What actually shipped.** Keenable shipped **as the provider itself**, not as a seam — the crate-side
> registration-site edits this report enumerated (§F2) were made as it predicted, and landed across crate
> `fulcrum-harness` **0.7.0** plus the desktop. Desktop `src-tauri/Cargo.toml:130` now pins
> `fulcrum-harness = "0.7.0"`.
>
> **The seam recommendation (§F4, "Recommended answer" #3) was deliberately NOT taken.**
> `grep -rn search_providers` over the 0.7.0 source returns **zero hits**: there is no
> `ToolCtx.search_providers` and no `AgentLoop::set_search_providers`. The refutation, already in the
> implementation plan's Decisions, is that the shape cannot pay for itself here: `Settings` and
> `WebSettings` are **crate types** (desktop `src-tauri/src/config.rs:42` re-exports
> `fulcrum_harness::web::config::WebSettings` rather than defining its own), so a desktop-supplied
> provider has no settings field it could be *named* in; and the `AgentLoop` is built inside the
> self-exec `--worker` **child** process (`src-tauri/src/agent/worker/mod.rs`), which receives a
> serialised `StartEnv`/`config-update` envelope over stdio — so nothing there could hold a
> desktop-constructed `Arc<dyn SearchProvider>` in the first place. An injected list would have to be
> *named* on the wire and *constructed* in the child, which is the same crate release either way.
> **Therefore the report's headline claim — "after that single additive release, every subsequent
> provider is a desktop-only change" — is false at this HEAD: provider #7 still needs a crate release.**
>
> **Six stale values, corrected against `~/.cargo/registry/src/*/fulcrum-harness-0.7.0/`:**
>
> | Where below | As written (0.5.1) | Now (0.7.0) |
> |---|---|---|
> | §"Hardcoded counts and lists (compile or test failures)" | `SEARCH_PROVIDERS: [&str; 5]` | `[&str; 6]` — `web/config.rs:19`, `"keenable"` fifth |
> | same section, the `registry.rs:270` bullet | `assert_eq!(providers.len(), 5)` | `providers.len(), 6` — now `web/providers/registry.rs:279` |
> | §F6 item 2 ("Two policy decisions the plan must make") | `AVAILABILITY_ORDER` is five names | six — `web/providers/registry.rs:16`, `["brave","tavily","perplexity","searxng","keenable","duckduckgo"]`, Keenable at **index 4** |
> | §"The release gate" | `Cargo.toml:125` pins `fulcrum-harness = "0.5.0"` | `src-tauri/Cargo.toml:130` pins `"0.7.0"` |
> | Exec summary #3 and §F3 (the `net.rs:117-121` finding) | strip list is `authorization`, `cookie`, `x-subscription-token` | now **also strips `x-api-key`** — `web/net.rs:120-123`; the leak this report flagged is closed |
> | the `**Verified locally.**` stamps on those rows | measured at crate 0.5.1 / desktop `07ccb4f3` | the stamps no longer hold; the corrected values in this table supersede them |
>
> **And one claim that must not be read as failover-neutral.** §F6 item 2 ("Two policy decisions the
> plan must make") argues for position 5 partly because it keeps failover "keyed-before-keyless so a
> Keenable `429`/`402` degrades to DDG rather than to another **paid** provider". That argument is
> sound about Keenable's
> **own** forward edge — Keenable sits immediately before `duckduckgo`, so a Keenable failure does fall
> through to the keyless rung. What it does not establish, and what the sentence implies, is that the
> position is **failover-neutral for everyone else**. It is not: the auto-failover loop takes
> `AVAILABILITY_ORDER[current_idx + 1..]` and picks the first `is_available` provider
> (`web/providers/registry.rs:162-172`), and Keenable now sits directly **after** `brave`, `tavily`,
> `perplexity` and `searxng`. For a user holding brave + keenable, an ordinary brave `429` now fails
> over **into** Keenable — a metered, per-credit paid API — where before it dropped straight to free
> DuckDuckGo. Recorded as an accepted gap in
> `docs/features/keenable-search-known-gaps.md` §2; see that item for the full account, including the
> fact that failover fires only on the `auto` path. (That item first landed in
> `docs/features/honest-turn-outcome-surfaces-known-gaps.md` §5 item 9, before a Search-provider
> known-gaps file existed; it moved on 2026-11-24 and that file no longer carries it.)
>
> **Durable home for the shipped state.** This report is the dated reading, not the record. The accepted
> defects and deliberately-unbuilt scope of the shipped Search-provider work — the card-URL expiry, the
> unpinned `SelectItem` list, the plaintext key store, the privacy disclosure, `credits_remaining`,
> device login and the keyless tier — are in `docs/features/keenable-search-known-gaps.md`. Read that
> file for what is open; read this one for what was known on 2026-11-22 and what was decided against it.

---

Research question: *Can Keenable be added as a first-class Search provider in Archimedes (a Rust
provider plus a Settings row), where should that code live, and is the vendor worth depending on?*

Depth: standard (three planned angles — API surface, pricing/credits/limits, fit against the existing
five — plus a fourth added mid-run when the user asserted the Search providers could come out of
`fulcrum-harness`).

Two constraints bound every claim below. `KEENABLE_API_KEY` was **not set**, so **no angle called the
authenticated API** — every API statement rests on docs, the OpenAPI document, or a live *keyless*
probe. And per `AGENTS.md` the engine is a sibling checkout the desktop does not build from, so the
local findings are measured at `/home/daniel/Coding/Archimedes/fulcrum` HEAD `20e6060` (crate
`fulcrum-harness` **0.5.1**, resolved from crates.io) against desktop HEAD `07ccb4f3`.

---

## Executive summary

1. **Keenable fits the existing `SearchProvider` abstraction with zero changes to the trait.** It is a
   structural near-clone of `providers/tavily.rs` — keyed JSON POST, `results[]`, ISO date — so the
   provider itself is ~150 LOC plus a fixture, and **no new dependency** is required.
2. **The cost is not the abstraction, it is ~55 registration sites across three surfaces and a
   two-repo release.** Two hardcoded id lists and one count live in the crate, one hardcoded error
   string lives in the desktop, and four *untyped* frontend mocks will drift silently.
3. **A real key-leak hole was found locally and must be fixed as part of this work.**
   `fulcrum/src/web/net.rs:117-121` strips `authorization`, `cookie`, `x-subscription-token` on a
   cross-origin redirect — and **not `x-api-key`**. Keenable's documented auth header is `X-API-Key`.
4. **The user's instinct that the providers "could honestly come out of fulcrum" is half right, and the
   right half does not pay.** `web/providers/` is genuinely a strict leaf, but the crate's boundary is
   *directional* and *need-based*, not coupling-based; extracting the providers is a breaking API
   removal that still leaves the eleventh provider blocked on a publish.
5. **Recommendation: make the one crate release be the seam, not the provider** — a
   `search_providers` handle on `ToolCtx` plus `AgentLoop::set_search_providers`, mirroring the
   already-justified `set_render_requester` / `set_task_store` pattern. After that single additive
   release, every subsequent provider is a desktop-only change over `settings.json`.
6. **The vendor is technically excellent and commercially risky.** Top-of-field independent quality and
   the best latency in its benchmark class, pricing that suits bring-your-own-key perfectly — and two
   serious problems: queries are logged with **no fixed retention** under a **perpetual, irrevocable**
   model-training license, and API keys are **entirely unscoped with no spend cap**.
7. **Do not adopt Keenable's fetch.** `/v1/fetch` duplicates `extract` + `cache` + the desktop webview
   renderer, and there is no `FetchProvider` trait to hang it on.

---

## Findings

### F1. Capability mapping — every knob and field has a home

`SearchProvider` (`fulcrum/src/web/providers/types.rs:38`) requires `id`, `name`, `is_available`,
`search`. `SearchOpts` carries four knobs; `SearchResultItem` carries four fields.

| `SearchOpts` field | Keenable param | Supported | Evidence |
|---|---|---|---|
| `num_results` | `max_results` (int, 1–50, default 10) | ✅ | OpenAPI `SearchRequest`; use the tavily pattern `resolve_num_results` + `truncate_results` (`tavily.rs:100,146`) |
| `recency_filter` | `published_after`/`published_before`/`acquired_after`/`acquired_before`, accepting relative deltas (`30min`, `2h`, `7d`, `1mo`, `1y`) | ⚠️ translate | Map `day→1d`, `week→7d`, `month→30d`, `year→1y`, else omit — the same shape as `tavily.rs:113-124`, which silently drops unrecognised values |
| `domain_filter` | `site` (**single host**) + `exclude_domains` (array, ≤1000); **no include-array** | ⚠️ ignore | `domain_filter` appears in **zero** provider files; the registry enforces it itself post-merge (`registry.rs:210-212` → `matches_domain_filter`, `:100-113`) |
| `proxy` | n/a (transport) | ✅ | every provider does `proxy: opts.proxy.clone().or_else(\|\| config.proxy.clone())` (`tavily.rs:135`, `brave.rs:132`, `perplexity.rs:142`) |
| `provider` | n/a | ✅ | consumed by `resolve_provider_from` (`registry.rs:45`) before the provider is called |

**Fidelity ranking on `recency_filter`, measured across the five existing providers:** brave passes the
value **verbatim** (`brave.rs:115-117`); tavily maps four words; **perplexity, searxng and duckduckgo
ignore it entirely**. Keenable would be the second most faithful. One semantic caveat the docs state
plainly: setting a publish-date window **silently drops pages with no known publish date**, which
brave and tavily do not do.

| `SearchResultItem` field | Keenable field | Verdict |
|---|---|---|
| `title` | `results[].title` (required) | ✅ direct (a bare PDF gets a synthesised `host/path` title) |
| `url` | `results[].url` (required) | ✅ direct; may be a `cards.keenable.ai` card URL **valid one day only** |
| `snippet` | `results[].snippet` (optional) | ✅ name-for-name, **but it is markdown** and defaults to "often several thousand characters" — see F6 |
| `published_date` | `results[].published_at` (optional, ISO 8601 UTC) | ✅ **best of the six** — brave's `age` is free-form prose, perplexity and duckduckgo hardcode `None` |

**Auth: the custom-header pattern is already established.** `brave.rs:120-125` sends
`X-Subscription-Token`; `perplexity.rs:130-135` sends `Authorization: Bearer`; `tavily.rs:107` puts the
key in the JSON body. Keenable's `X-API-Key` is a third spelling of the same three lines.

**`is_available`:** Keenable behaves like brave/tavily/perplexity — `config.keenable_api_key.is_some()`.
That is the option that fits as-is; see F7 for what does not.

**`SearchProvider` needs no change. `SearchOpts`, `SearchResultItem`, `FetchOpts` and the registry need
no change.**

### F2. The real cost is registration breadth, and four of the sites fail silently

A complete file:line checklist was produced (crate 23 sites, desktop 12, frontend 20). The sites that
break something, or worse, break nothing:

**Hardcoded counts and lists (compile or test failures):**

- `fulcrum/src/web/config.rs:19` — `pub const SEARCH_PROVIDERS: [&str; 5]`. **The only literal count**;
  `.contains()` (`config.rs:82`, `commands/settings.rs:232`), `.join()` (`:235`) and the
  `for provider in SEARCH_PROVIDERS` loop (`config.rs:244`) all adapt themselves.
- `fulcrum/src/web/providers/registry.rs:270` — `assert_eq!(providers.len(), 5)`. **Verified locally.**
- `fulcrum/src/web/providers/registry.rs:274` — the id `vec![...]`, in `all_providers()` order. **Verified.**
- `archimedes/src-tauri/src/commands/settings.rs:1111` — asserts the string
  `"Valid providers: brave, tavily, perplexity, searxng, duckduckgo"`. **Verified locally.** (The format
  string that produces it, `agent/errors.rs:567`, is generic and needs no edit.)
- `src/components/settings/WebSearchSection.tsx:317` — the closed-select array
  `["auto","brave","tavily","perplexity","searxng","duckduckgo"]`. This is `closedSelectValue`'s allowed
  set, so an unlisted `defaultProvider` **snaps silently to `"auto"`** — a runtime defect, not a build failure.

**Silent test pollution:** `fulcrum/src/web/config.rs:136-145` `clear_web_env()` must gain
`remove_env("KEENABLE_API_KEY")`, or a developer's exported key decides `settings_fill_the_config` and
`blank_settings_count_as_unset` — a flake that only appears on one machine.

**Silent frontend drift:** `src/test/fixtures/settings.ts` exists precisely to make a new `WebSettings`
field a compile error, and it does — in **8** typed `AppSettings` literals. But **4 mock literals are
untyped** and invisible to `tsc`, because they sit inside `vi.fn().mockResolvedValue({...})` /
`vi.mocked(getSettings).mockResolvedValue({...})`: `PermissionsSection.test.tsx:112`,
`SettingsPage.test.tsx:132`, `lib/settings.test.ts:167`, `App.test.tsx:133`. This is the exact class
`AGENTS.md` warns about for `App.test.tsx` ("hand-writes `useSessions.setState({...})` key lists per
test… when you add a store field, grep that file").

**Struct-literal breakage across the package boundary:** `WebSettings` carries no `#[non_exhaustive]`,
and full literals spelling every field with no `..Default::default()` exist on **both** sides —
`fulcrum/src/worker/protocol.rs:636` and `archimedes/src-tauri/src/config.rs:1426,1633`. So *any* new
per-provider config field is a **breaking** change for consumers, and the crate has recorded its own
ruling on that: release commit `3d7dfb6` bumped **minor** for the `TurnState` field because "adding a
field to such a struct breaks every consumer that builds it with a full struct literal, which is a
breaking change — under `0.x` semver that is a MINOR bump, not a patch." `#[serde(default)]`
(`web/config.rs:32`) preserves **wire** compatibility only, not source compatibility — and it does mean
an old `settings.json` parses `keenableApiKey` to `""` with no migration.

**The release gate:** `archimedes/src-tauri/Cargo.toml:125` pins `fulcrum-harness = "0.5.0"` (resolving
to 0.5.1 from crates.io, `Cargo.lock:1665-1668`). **Every crate-side line is inert until merge → tag →
`cargo publish` → desktop pin bump.** `AGENTS.md`'s "the engine is a SIBLING checkout, and the desktop
does not build from it" was re-confirmed: `.cargo/config.toml` is absent (only `.example`), and
`cargo tree -i fulcrum-harness` prints no path suffix.

### F3. 🔴 A key-leak hole: `net.rs` does not know the header name

`fulcrum/src/web/net.rs:117-121`, read at HEAD:

```rust
fn strip_cross_origin_headers(headers: &mut HeaderMap) {
    headers.remove("authorization");
    headers.remove("cookie");
    headers.remove("x-subscription-token");
}
```

`safe_fetch` follows up to five redirects **manually** and re-sends `current_headers`
(`net.rs:288`), stripping only those three names. Keenable authenticates with `X-API-Key`. A redirect
off `api.keenable.ai` to a cross-origin host would therefore **forward the user's API key to that
host**. Brave escapes only because its header name happens to be in the list.

This is the only edit outside `providers/` that is a **correctness** requirement rather than a
registration, and it should ship **with** the provider, not after it: add
`headers.remove("x-api-key");` and extend the witness at `net.rs:~430-465`
(`test_safe_fetch_redirect_and_cross_origin_header_stripping`). It is worth fixing regardless of
whether Keenable ships, because it is a latent hole for any future provider that authenticates by
custom header.

### F4. Architecture — the providers are a leaf, and extracting them still does not help

Measured at `fulcrum` HEAD `20e6060`:

- **`web/providers/` is a strict leaf.** `grep -rn 'crate::' src/web/providers/ | grep -v 'crate::web::'`
  is **empty** (re-run and confirmed by the parent, not only by the subagent). Its entire outward
  footprint is `web::config::WebConfig`, `web::net::{safe_fetch, FetchOpts}`, and its own siblings.
- **Nothing outside `web/` names `web::providers`** — zero hits repo-wide.
- `web/` as a whole has exactly **four** production edges to the rest of the crate, all the same shape:
  `crate::tools::exec::{ToolCtx, ContentBlock, ToolResult}` (`web/tools.rs:5`, `web/extract/mod.rs:1`,
  `web/extract/github.rs:2`, `web/extract/youtube.rs:9`). It touches no harness, worker, or permission
  machinery in production.

**So on a pure coupling map the user is right: it is the most extractable subtree in the crate.** But
the crate's boundary is not drawn around coupling:

- **It is directional.** `fulcrum/AGENTS.md:20-29` — "No code path from here to a desktop module."
  Desktop→crate is the *allowed* direction and the point of the crate; every existing seam runs
  crate-declares / other-side-implements (ADR 0091:41, "The desktop drives; the crate never pulls").
  Pushing `providers/` out is not a seam, it is an API removal.
- **It is need-based.** ADR **0091** `docs/decisions/0091-…-the-desktop-owning-the-disk.md:14-16`:
  "**a module moves only if the crate needs it**; a thing the crate needs but cannot hold becomes a
  seam; a thing that holds a desktop type splits in two." The crate needs the web tools —
  `tools/exec.rs:55-57` dispatches `web_search`/`fetch_content`/`get_search_content`, and
  `fulcrum/README.md:410` lists `web/` as engine content. Providers violate neither rule where they stand.
- **The criterion the code cites is not where the criterion lives.**
  `archimedes/src-tauri/src/agent/web.rs:9` and `fulcrum/src/web/mod.rs:9` both attribute "the crate
  compiling without `tauri`" to "the master roadmap" — `docs/roadmap/fulcrum-harness.md`, which is
  **gitignored** (`.gitignore:36`). The durable, executable home is the test:
  `fulcrum/src/boundary_pins.rs:248-254` `no_code_names_the_desktop_ui_framework`.

**And the decisive point: extraction does not achieve the stated goal.** After moving the providers to
a third package, adding the *eleventh* provider still means editing that package and publishing it. The
friction is relocated, not removed — while costing a **breaking public-API removal** (≥ minor on the
precedent above), an irreversible hand-run `cargo publish` (`fulcrum/AGENTS.md:369-370`: "that name is
burned permanently — crates.io supports neither rename nor delete"), 55 provider tests plus three
`web/tools.rs:517,574,1011` failover tests that construct provider structs directly, and free
`web_search` in the `fulcrum serve` daemon (which today has zero `web::` references of its own and
inherits it).

**The friction is one line.** `registry.rs:28 all_providers()`, called at `web/tools.rs:59` — verified
locally: `exec_web_search_with_providers(ctx, params, &all_providers())`. The injectable variants are
**already `pub` and already take slices** (`resolve_provider_from` `registry.rs:45`,
`execute_search_with_providers` `:123`, `exec_web_search_with_providers` `web/tools.rs:62`) but have **no
production caller willing to hand them a non-default list** — precisely the "weak pin / trait with no
caller" shape `fulcrum/src/seams.rs:15-22` warns about. `ToolCtx` (`tools/types.rs:221-241`) carries
`web`, `render_requester`, `event_sink`, `task_store` — **no providers** (verified locally).

**Why "desktop only" is not available for the thing that matters.** The Settings *Test* button is
achievable today with zero crate edits — `SearchProvider` is `pub`, `execute_search_with_providers` is
`pub`, and `commands/settings.rs:261-277` already builds its own `SearchOpts`. The **model-facing
`web_search` tool is not**: dispatch is `tools/exec.rs:55 → exec_web_search → all_providers()`, the loop
is built inside the crate (`worker/core.rs:282`), the desktop's only entry is
`fulcrum_harness::worker::run_worker(...)` (`src-tauri/src/lib.rs:318-325`), `grep 'AgentLoop::new'
archimedes/src-tauri/src` is empty, and the Worker is a **separate process** — so anything the desktop
supplies must cross as data, and `StartEnv` has no such field.

**The sanctioned mechanism exists on paper and is not built.** ADR **0102**
(`docs/decisions/0102-…-host-tools-arrive-as-data.md`, accepted 2026-11-11) states the user's own
complaint at `:10-17` — "the desktop could not add a tool without publishing a crate release" — and
prescribes `StartEnv.host_tools: Vec<ToolSpec>` plus a generic `HostToolCall`/`HostToolResponse` pair.
Measured: **zero** hits for `host_tools|HostToolCall` anywhere in `fulcrum/src`. `tool_specs` still
advertises **26** tools (ADR 0102 says 26 → 19) and `exec/task_tools.rs` still exists at 1,191 lines.
Its own spec also keeps `web_search, fetch_content, get_search_content` on the **engine** side of the
invariance census (`docs/roadmap/tool-separation.md:220`).

**Recommendation.** Make the one crate release be **the seam, not the provider**: a
`search_providers` handle on `ToolCtx` (beside `web` / `render_requester` / `task_store`) plus
`AgentLoop::set_search_providers`, defaulted to `all_providers()` at `web/tools.rs:59`. This shape is
**already justified in-repo** — `set_render_requester` (`harness/loop.rs:1158`) and `set_task_store`
(`:1176`), whose docblock explicitly argues for "a setter called AFTER `AgentLoop::new`, not a 25th
constructor argument" (`worker/core.rs:379-380`). One additive release, after which every future
provider — including a generic custom-REST one — is a **desktop-only change over `settings.json`**, the
way ADR 0014 solved model providers and ADR 0019 solved MCP servers. It pre-lays ADR 0102 instead of
fighting it.

**Nothing forbids the desktop owning providers.** Every test in `boundary_pins.rs` (9) and
`source_lints.rs` (10) asserts an absence *in the crate*, pointing crate→desktop; `lint_scan.rs` holds
no rules; `boundary.rs` is the file-access Boundary, unrelated despite the name; the desktop's
`scripts/*.sh` hold no crate-boundary path scans. The obstacle is purely the one hardcoded list.

| Option | Verdict |
|---|---|
| **edit the crate — add the injection seam** | ✅ **Recommended.** One additive release, then desktop-only forever. Cheapest path to the actual goal. |
| **desktop-side extension point, now** | ⚠️ Half-available: the Settings test button can do it today; the model-facing tool cannot. |
| **move providers out of the crate** | ❌ Most expensive, least effective. Breaking API removal; decouples nothing that was coupled; strips search from the daemon; still blocks provider #11. |
| **"impossible on the desktop side"** | ❌ as a blanket claim (the Settings path works today); ✅ for the model-facing tool **at HEAD `07ccb4f3` / crate 0.5.1**, and only until the seam exists. |

### F5. The vendor: economics and quality are strong, privacy and key scoping are not

**Technical surface is better documented than typical for a service this young.** A machine-readable
**OpenAPI 3.0.3** document is published at `https://docs.keenable.ai/api-reference/openapi.json`
(`info.version: "1.0.0"`), and a **122-code error catalogue across 7 types** at
`docs.keenable.ai/errors.md`, each with status, retryability and a fix. The error envelope is flat
(`error`, `type`, `code`, `retryable`, `retry_after_seconds`, `limit{scope,window,max,resets_at}`,
`fix`, `docs_url`, `request_id`) and the docs are explicit: branch on `code` and `retryable`, **never**
on message text — a live-captured 401 body is already longer than the documented one, which proves the
point. **An official Rust SDK is on crates.io** — verified independently against the sparse index
(`https://index.crates.io/ke/en/keenable`): `keenable` **0.1.0, 0.2.0**, neither yanked. The npm, PyPI,
Go and Homebrew packages the vendor brief claims all exist too. *Recommendation notwithstanding: hand-
roll the call in the tavily/brave idiom rather than add a two-version-old dependency to a pinned
workspace.*

**Pricing suits bring-your-own-key exactly.** 1 credit = **$0.004**; search and fetch cost the same;
**100,000 requests/month free with no card required**; rate limits are **per organization** (10 RPS,
25 RPS after $1,000 of top-ups in 90 days), so each of your users brings their own org and their own
10 RPS rather than pooling into yours. Failed calls are never billed and every successful keyed
response self-reports `usage.credits` / `credits_remaining`. **One free-tier trap:** signing up with a
disposable mail domain (Proton and Tuta are named explicitly) starts at **1,000/month, not 100,000** —
and a privacy-minded desktop audience disproportionately uses exactly those domains.

**Quality is independently top-tier, with two honest caveats.** The **Artificial Analysis Search Index**
(third party, 14 providers, same answer model and harness, data 2026-11-19) scores Keenable-pro **83 —
tied first with Parallel** — at **best-in-class latency** (15.9 s/task vs Exa 36.0 s, Perplexity 30.2 s,
Brave 21.7 s). Caveats: (a) Keenable's "#1 on the AA Search Index" marketing is **a tie presented as a
win**, and AA's own FAQ names Parallel as the leader; (b) on cost-efficiency Keenable is mid-pack —
**$31.87 per 1,000 tasks** vs Parallel-fast's **$4.63**, because models search against it more often.
Keenable's own **NEEDLE** benchmark is vendor-run and self-discloses that its judge has had no
human-agreement audit; it is not independent evidence.

**Problem 1 — privacy, and it is the one users will not expect.** On the **default** data policy, keyed
and keyless alike, Keenable logs the search query, the fetched URL, **any fetch `prompt`**, the results,
IP, user agent and key/org ids. **No fixed retention period exists** — the docs say so twice. The ToS
User Content clause grants a license to use that content for its AI models that is "**perpetual, and
irrevocable**", reinforced by a Usage Data clause permitting "train, finetune". Zero-data-retention
**exists but is contract-only — "the console has no switch for it"** — and it degrades function (`fetch`
with a `prompt` returns `400 zdr_prompt_unsupported`; that error is also a documented way to *probe*
whether a key is under ZDR). An agent's search queries routinely contain private project details, so
**"their own key" must not be presented as "their own privacy."** Their own instruction is "don't send
secrets or personal data in a query, a URL or a prompt."

**Problem 2 — keys are entirely unscoped.** No read-only scope, no per-endpoint restriction, **no
per-key spend cap**, no TTL, no IP/origin allowlist; the only per-key attribute is a free-text label.
Keys are individually revocable (`403 credentials_forbidden` after revoke) but never expire. Combined
with Stripe auto top-up defaulting to a **$1,000/month** cap on accounts that can hold a card, the blast
radius of a leaked desktop key is not "someone searches". **Therefore: store the key in the OS keychain,
not in the plaintext `settings.json` where the other five keys currently live** — and note Keenable's
**device login (RFC 8628, `POST /v1/auth/agent/code` → poll `/v1/auth/agent/token`)** is their sanctioned
answer to "a tool that can't show a sign-in page" and is strictly better than a paste field as the
*primary* flow, with paste as fallback.

**ToS verdict (keenable.ai/terms, last revised 2026-10-03): permitted for the BYO-key desktop pattern,
not a clean all-clear.** The user, not Archimedes, is Keenable's customer, so the "non-sublicensable /
not for resale" grant is never exercised; **no clause requires the key to stay server-side**; **no
attribution is required**; and storing a key in a config file is not prohibited (the ToS instead makes
confidentiality entirely the account holder's liability). Three caveats: (i) "solely for your internal
business purposes" admits a hostile reading for a commercial client, and the whole position rests on the
BYO-key separation — **if search is ever bundled under one key of ours, that position collapses**, so
make BYO-key architectural, not cosmetic; (ii) the Trademark clause bars their logo/wordmark in our UI
(naming the provider in text is fine); (iii) a clause forbids providing third parties "the results of
any benchmark tests of the Service", which would constrain a provider-comparison feature. **Get written
confirmation before GA.**

**Maturity is the real risk.** The service is **~3 months public** (out of stealth 2026-08-25, $26M seed
led by Accel; founders ex-Yandex head of search and ex-Amazon scientist) and **Keenable 1.0 shipped
2026-11-12 — ten days before this report**. The status page's 90-day all-green window is exactly as old
as the service, so a zero-incident record there is **consistent with youth, not evidence of
reliability**. The ToS permits suspension or discontinuation "with or without notice" with liability
disclaimed, and **no SLA or uptime commitment exists anywhere**. No independent outage reports were
found — which, at three months and a 12-point launch thread, is absence of evidence.

**Net: adoptable behind a provider abstraction; not adoptable as a sole, hard-wired dependency.**

### F6. Two policy decisions the plan must make, not the research

1. **`snippet_max_length` is mandatory.** Keenable returns markdown, query-selected, defaulting to
   "often several thousand characters" and accepting 180–10,000. `web/tools.rs:150-160` formats the
   model-facing summary as `[title](url)\n{snippet}` with **no per-item cap** and caches the whole thing
   (`:163-171`), so uncapped snippets × up to 20 results ≈ **200 KB into one tool result**. There is no
   `SearchOpts` slot for it — pick a constant in the provider.
2. **`AVAILABILITY_ORDER` position.** `registry.rs:15` is `["brave","tavily","perplexity","searxng","duckduckgo"]`.
   Because `is_available` gates on key presence, inserting Keenable changes the default provider **only
   for users who paste a Keenable key**. **Position 5** (before `duckduckgo`) is recommended: additive,
   it fires only when configured *and* none of the four above is, and it upgrades the *fallback rung*
   from DDG scraping (which has a bot-challenge escape hatch, `duckduckgo.rs:357+`) to a real index,
   while keeping failover keyed-before-keyless so a Keenable `429`/`402` degrades to DDG rather than to
   another **paid** provider. **Position 6** (after `duckduckgo`) is strictly opt-in —
   `duckduckgo.is_available()` is unconditionally `true` (`duckduckgo.rs:306`), so the auto loop can
   never reach past it — which is the zero-change way to reproduce the TS sibling's `OPT_IN_PROVIDERS`
   semantics. `test_search_provider` passes `provider: Some(id)` explicitly (`settings.rs:261-264`), so
   the Settings Test button works at either position. **Position 2 would silently switch engines for
   existing brave+keenable users — do not.**

Also: `clean_snippet` (`common.rs:29-52`) would **flatten Keenable's markdown** (its
`collapse_whitespace` eats the newlines that make tables and lists legible) while stripping nothing, so
Keenable should deviate deliberately from the shared-helper expectation.

### F7. Two things that do NOT fit, and one that must not be adopted

**Keyless availability is unrepresentable.** Keenable works without a key (`/v1/search/public` +
`X-Keenable-Title`, 1,000 req/h/IP) and that is its headline offer. `is_available` is a **bool**, not a
keyed/free-eligible enum. The sibling TypeScript implementation hit exactly this and had to break its
own abstraction: `pi-archimedes/packages/web/src/providers/keenable.ts:19` sets
`isAvailable: () => true`, which forced a **second** provider list `OPT_IN_PROVIDERS`
(`registry.ts:22-25`) plus a test asserting it "is never picked by the auto chain". **The Rust registry
has no second list** — `AVAILABILITY_ORDER` is the only selection mechanism (`registry.rs:73-79`, and
again in the failover loop `:150-172`). Fitting as-is therefore means **giving up the free tier**, the
feature Keenable markets. Position 6 gets the same *behaviour* as the TS sibling with **no** abstraction
change; getting the free *tier* would need a real change.

**Keenable's extras the abstraction caps:** `mode` (`pro`|`realtime` — a cost/latency choice the user
cannot make), `acquired_at` (index date), `usage.credits_remaining` (the thing users of a metered API
actually want surfaced — `tools.rs:183-188` emits a fixed `json!` with no room), `warning`, include-domain
*lists*, and the `acquired_*`/`published_before` windows. Keenable is strictly more capable than
`SearchOpts` here.

**Do not adopt `/v1/fetch` / `fetch_page_content`.** It duplicates Archimedes almost entirely:
`extract::extract` (`extract/mod.rs:24`, six extractors incl. github/youtube/pdf and a scoring article
extractor) vs Keenable's markdown extraction; `tools.rs:235-241` `max_chars`/`truncated` vs Keenable's
`max_chars`/`truncated`/`total_chars`; `ResponseCache` + `responseId` + `get_search_content` paging
(`cache.rs:60-158`) vs Keenable's `max_age_hours`; and — the part Keenable has no answer to —
`looks_blocked` (`extract/mod.rs:117`: 403/429/503 or <80 words) escalating to the **desktop Tauri
webview renderer** (`src-tauri/src/agent/web/render.rs:64`). Adopting it would also **bypass `net.rs`'s
SSRF policy**, since the fetch happens on Keenable's servers — silently changing ADR 0056/0057 semantics.
And there is **no `FetchProvider` trait at all** (`web/` has zero fetch pluggability), so it is not a
sixth implementation of anything — it is a brand-new abstraction plus the whole of F2 again. Keenable's
long `snippet` already covers the search-then-fetch case, which is what Keenable's own
`guides/search-then-fetch.md` recommends.

### F8. The test convention a new provider must follow

Fixtures live in `fulcrum/src/web/fixtures/*.json`, loaded by **relative**
`include_str!("../fixtures/<id>.json")` from `providers/`. Every provider fixture is the same 2-result
`rust` query — item 1 with a date, item 2 with an absent/empty date — so the `Option<String>` +
`.filter(!is_empty)` path is exercised by construction. The house shape (`tavily.rs:155-253` is the
closest analogue) is six tests: `is_available` flips on the key; wiremock success that asserts the
**request** as well as the response (including the `X-API-Key` header witness); wiremock error asserting
the exact string `"[keenable] error: HTTP 401"`; parse-the-fixture-field-by-field; empty/missing
results; malformed JSON asserting the error mentions `[keenable]`. Conventions: `base_url: Option<String>`
+ `new()` + `with_base_url()` + `impl Default` (the test seam), a free `pub fn parse_keenable(&str)` so
parsing is testable without a server, `format_provider_error`/`check_http_status`/`validate_query`/
`resolve_num_results`/`truncate_results` from `common.rs`, and **always `safe_fetch`, never a raw
`reqwest::Client`** (the sole exception is `duckduckgo.rs:110-125`, which must hand its client to the
`ddgs` crate). `wiremock = "0.6"` is already a dev-dep (`fulcrum/Cargo.toml:285`); **no new dependency
is needed**.

---

## Evidence

**Credibility, highest first.**

- **Local source, read at HEAD and re-verified by the parent agent** for every load-bearing claim:
  `net.rs:117-121`; `registry.rs:270,274`; `config.rs:19`; `commands/settings.rs:1111`;
  `web/tools.rs:59`; `ToolCtx` fields `tools/types.rs:218-241`; the empty `crate::` grep over
  `web/providers/`; `fulcrum-harness = "0.5.0"` at `Cargo.toml:125` → 0.5.1 from registry at
  `Cargo.lock:1665-1668`; zero `host_tools|HostToolCall` hits; ADR 0091 and ADR 0102 read in full.
- **crates.io sparse index** (`https://index.crates.io/ke/en/keenable`) — the one externally-sourced
  claim checked by a second instrument after the vendor-API route returned an error body with exit 0.
- **Vendor docs as markdown** (`docs.keenable.ai/*.md`) + the vendor's own **OpenAPI 3.0.3** +
  **live unauthenticated probes** of `/v1/search/public`, `/mcp`, `/.well-known/*`. Official sources,
  but self-interested on capability and error behaviour.
- **Artificial Analysis Search Index** (2026-11-19) — the only genuinely independent quality
  measurement found; third party, fixed answer model and harness across 14 providers.
- **TechCrunch** (2026-08-25) for funding/stealth; **status.keenable.ai** for uptime; **keenable.ai/terms**
  (2026-10-03) quoted verbatim; **npm/PyPI/crates.io/Go proxy/Homebrew** for package existence.
- **Hacker News** (49435555, 12 points; SELECT thread 60 points) — thin, and staff-dominated. No Reddit
  threads or verified third-party reviews were found; review-site pages found are SEO shells.

**Fact / inference / speculation.** Everything in F1–F4 and F8 is *read from source*. F5's numbers are
*quoted from cited sources*. Two labelled **inferences**: (a) that the seam-first option is cheaper than
extraction — an arithmetic argument over the measured registration and release costs, not a measurement;
(b) that the user's "providers could come out" instinct is a *product* intuition the crate's recorded
criteria do not express. **Speculation, flagged as such:** whether Keenable honours ZDR in practice, and
whether their ToS position survives a hostile reading, are unknowable from documents and rest on the
recommendation to get written confirmation.

---

## Unresolved contradictions

| # | Contradiction | Resolution |
|---|---|---|
| C1 | OpenAPI marks `results[].description` **required**, but the prose says *"Always an empty string; read `snippet`."* | Prose + live capture win: `description` is present and always `""`. **A port copying `brave.rs`'s `description` read returns empty snippets for every result.** Read `snippet`. |
| C2 | The OpenAPI `ApiError` schema carries only 4 fields and declares 401/402/429/5xx with **no content at all**, yet live captures return full JSON with `code`, `type`, `fix`, `retryable`, `limit` | **Do not codegen error structs from the OpenAPI file.** Hand-write from `errors.md` + the live captures. |
| C3 | HTTP status is the usual retry signal, but here a 5xx can be final (`select_timeout`) and a 4xx retryable (`domain_record_missing`) | Branch on the `retryable` field; the docs say status-based retry logic is "explicitly wrong here". Falls out for us — the crate's `check_http_status` produces a string error either way. |
| C4 | `usage.credits_remaining` is documented in prose and present in live responses but **absent from the OpenAPI `Usage` schema** | Treat as optional. It is the field a metered-API user most wants surfaced — and F6/`tools.rs` currently has no room for it. |
| C5 | Keenable works keyless and markets it; `is_available` is a bool | Unresolved by design. Position 6 buys the *behaviour* for free; the free *tier* needs a real abstraction change. **A product decision, not a research gap.** |
| C6 | `boundary_pins.rs:190-201` asserts "135 `.rs` files live under `src/`"; measured **155** | Doc defect only — the vacuity floor is `> 40`, unaffected. Report, don't touch, unless already in scope. Consistent with `AGENTS.md`'s "plans carry stale baselines within hours". |

---

## Gaps

1. **No authenticated call was made.** The keyed response shape, `credits_remaining` behaviour, and the
   real 402/5xx bodies rest on docs and keyless probes. Keenable publishes **no literal example body for
   402 or 5xx** at all — field lists only.
2. **Console-only, unverified:** remaining balance and reset date, the maximum number of keys per org,
   and any SELECT rate limit.
3. **Whether `/mcp` ever emits SSE** (responses observed were plain JSON; no SSE framing seen), and
   whether `/mcp-oauth` performs dynamic client registration in practice — both undocumented. The
   OAuth issuer is a **raw Supabase host** (`caqmfcgrdovyjdhfnwzw.supabase.co/auth/v1`), not a
   Keenable-branded issuer.
4. **The keyed MCP tool inventory could not be enumerated live** — four Monitors tools appear only with a
   key; their schemas are docs-sourced, and they use **camelCase** where REST uses snake_case.
5. **No independent reliability corpus exists** for a service three months old. One third-party quality
   benchmark, a 12-point launch thread, zero verified reviews.
6. **Keenable's index coverage for non-English and for code-specific queries was not measured.** For a
   coding agent, the relevant comparison is against Brave and DuckDuckGo on *repo-shaped* queries, and no
   benchmark in the AA index measures that.
7. **Two documentation defects found while measuring, reported not touched:**
   `archimedes/src-tauri/src/agent/web.rs:59-60` says "`render.rs` imports nothing from the crate", but
   `render.rs:107,250,322` call `crate::agent::web::net::*`, which resolves **into the crate** through the
   re-export at `web.rs:76` — true of the crate *path*, misleading as read. And C6's stale file count.

---

## Recommended answer

1. **Add Keenable as a provider — yes**, keyed-only, `AVAILABILITY_ORDER` **position 5**, `snippet`
   capped by a chosen `snippet_max_length` constant, `domain_filter` ignored as all five siblings
   ignore it, **search only, never `/v1/fetch`**.
2. **Fix `net.rs:117-121` to strip `x-api-key` in the same change**, with its witness test.
3. **Make the crate release be the seam, not the provider** — `ToolCtx.search_providers` +
   `AgentLoop::set_search_providers` defaulted to `all_providers()` — so the *next* provider is a
   desktop-only change. Do **not** extract the providers from the crate.
4. **Store the key in the OS keychain and offer device login as the primary flow**, because the keys are
   unscoped, non-expiring and can sit above a $1,000/month auto-top-up.
5. **Disclose the logging/training policy in the Settings row**, and keep BYO-key structurally enforced.
   Get written ToS confirmation before GA.
6. **Surface `credits_remaining`** if the seam allows it — it is the one Keenable extra users of a
   metered API need.
