---
status: current
last-verified: 2026-11-26
verified-by: >-
  Web + local research — 5 angles (3 web on specstream.ai incl. its published OpenAPI 3.1.0 and three
  live keyless probes; 2 local-code, read at crate `fulcrum-harness` 0.8.0 and desktop HEAD `69165143`),
  2026-11-26. NO authenticated SpecStream call was made — no key exists in this environment. The
  load-bearing local claims were re-verified by the parent agent after the angles returned: zero
  `details.provider` readers in `src/`, zero `was_auto_resolved` readers in either package, zero `href`
  in `WebSearchSection.tsx`, the `pub use fulcrum_harness::web::{cache, config, net, providers, tools}`
  re-export at `src-tauri/src/agent/web.rs:76`, `HOST_CALL_TIMEOUT = 30 s`, `POLICIED_TOOLS` = 7 names,
  and crates.io returning `NoSuchKey` for a `specstream` Rust crate.
task: tsk_8196079b-ce7f-4afe-b595-38ff92706b04
issue: https://github.com/archimedes-codes/archimedes/issues/223
---

# SpecStream integration, and the desktop-owned Search provider

Research question: *Can SpecStream be added to Archimedes as a Search provider (and what of its Extract
and Deep Search products), should the desktop own that code rather than the `fulcrum` engine crate, and
what is missing on the UI side of Search providers?*

Depth: standard (five angles — Search/Extract API fit, Deep Search's quote→approve→poll flow against our
runtime, vendor risk, registration breadth + the UI inventory, and a from-scratch re-test of the
"should the desktop own this" conclusion).

Two constraints bound every claim. **No SpecStream API key exists here, so no angle made an
authenticated call** — every API statement rests on the vendor's docs, its published OpenAPI, or a live
*keyless* probe, and is labelled as such. And per `AGENTS.md` the engine is a sibling checkout the
desktop does not build from, so all crate facts are read from the **compiled** crate at
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fulcrum-harness-0.8.0/`, not from
`/home/daniel/Coding/Archimedes/fulcrum` (verified at `0.8.0`, not ahead, clean tree).

---

## Executive summary

1. **The user's instinct that Search belongs to the desktop is right, and the prior report that said
   otherwise is now false.** Its stated blocker was *"Measured: zero hits for `host_tools|HostToolCall`
   anywhere in `fulcrum/src`"*. That was true at crate 0.5.1 / `07ccb4f3`. ADR 0102 shipped since
   (`adec7dbe`, `d4b4995b`). **CONCLUSION FLIPPED.**
2. **A new Search provider can be a desktop Host tool today with ZERO crate changes** — ~6 files, one
   repo, no `cargo publish`, no pin bump. The prior report's recommended seam (`ToolCtx.search_providers`
   + `AgentLoop::set_search_providers`) is **superseded**: it costs one irreversible crate release to buy a
   transport `StartEnv.host_tools` already ships for free.
3. **The strongest form of the flip is not that the blocker is gone — it is that the crate's network
   hygiene is already re-exported to the desktop.** `src-tauri/src/agent/web.rs:76` hands the desktop
   `net::safe_fetch`, `providers::types` and `providers::common`, so a desktop-owned provider inherits the
   SSRF guard, the DNS-rebind pinning and the `x-api-key` redirect strip without the crate running it.
4. **The UI complaint is substantively right but not in the form stated.** Keenable's Settings row is
   complete (row, masked key, Test button, `(not configured)` guard, the app's only privacy disclosure,
   env layering, 3 frontend + 2 Rust tests). What is missing is missing for **all six** providers, and it
   is exactly what the model-`Provider` row already has: a key-acquisition link, a spend readout, and any
   statement of **which engine answered**.
5. **SpecStream's Search maps onto `SearchProvider` better than any provider we ship** — `sources[]`
   *requires* `url`/`title`/`snippet`. Its **Deep Search does not fit at all**: four independent blockers,
   each needing new engine surface.
6. **The vendor, not the API, is the risk.** Key safety is materially better than Keenable's. The company
   is ~7 weeks old with €10 share capital, no funding found, a status page with `history: []`, and **zero
   independent quality evidence** — both independent leaderboards omit it entirely.

---

## Findings

### F1. Architecture — the desktop can own a Search provider today, and the arithmetic says it should

**What `host_tools` is.** A general mechanism, not board-verbs-only. A `ToolSpec` literal in
`src-tauri/src/agent/host_tools/specs.rs:60` reaches the model through one line —
`src-tauri/src/agent/session/mod.rs:1791` `env.with_host_tools(host_tool_specs())` — which its own docblock
names as *the one* production `StartEnv` construction, covering fresh **and** resume; children inherit it at
`src/worker/manager/subagent_flow.rs:945`. The engine composes `builtins() ++ host_entries_attached(…)` at
`worker/core.rs:414-424` and installs it with `set_tool_registry` (`harness/loop.rs:1201`). The frame pair
`HostToolCall`/`HostToolResponse` (`worker/protocol.rs:383-388`) **carries no tool vocabulary at all**, the
router's arm never inspects the tool name (`session/router.rs:319-330`), and desktop dispatch is a
name-keyed `match` whose fall-through refuses loudly (`host_tools/exec/mod.rs:121-140`). Eight verbs ride
it today, and `mark_done` is the proof of generality: a **non-board** subject with no 0.7.0 ancestor.

**ADR 0102's own classification rule favours the desktop here.** `docs/decisions/0102-…:19-25`: a tool is a
Host tool when *"its substance acts on host-owned state"*; it stays an Engine tool when the engine already
confines it — the seven file/shell verbs, because the executor must not re-decide differently from the
`ToolCtx` its Gate judged. A Search provider touches the user's API key and proxy setting and **nothing**
file- or boundary-confined. `web/mod.rs:3-5` says it outright: *"Egress is NOT policy-gated (ADR 0056):
outbound web requests are network calls, not file system operations."*

**Measured cost, same feature, both ways** (both from real commits, not estimates):

| | Keenable — provider in the crate (`140a342a` + crate `477d3d4`) | `mark_done` — desktop Host tool (`d4b4995b`) |
|---|---|---|
| Commits / repos | 2 / **2** | 1 / **1** |
| Crate files | 10 (+510) | **0** |
| Desktop/frontend files | 24 (+1649) | desktop-only |
| `cargo publish` | 1 — MINOR, *"the `WebSettings` field is BREAKING for source"* | **0** |
| `Cargo.toml` + `Cargo.lock` bump | yes | **no** |

A Search provider as a Host tool touches ~6 files: `host_tools/specs.rs` (+1 spec), `exec/mod.rs` (+1
`match` arm), a new `exec/search.rs`, `tests/surface.rs` (four lists), `tests/verbs.rs`, and
`commands/settings.rs:905` (+1 name — the test's own comment says *"Every new host verb goes here"*).
`router.rs`, `session/mod.rs`, `list_tools` and the frontend select need **no change**: `list_tools` already
chains `host_tool_specs()` (`settings.rs:158`), so a host verb reaches the Settings permission checkbox
list and the `enabled_tools` filter for free.

The prior report's seam, by contrast: `ToolCtx` (`tools/types.rs:144-229`) has **no `#[non_exhaustive]`**, so
a new `pub` field breaks **13 full struct literals** (10 crate + 3 desktop), which the crate's own ruling
applied at release `477d3d4` makes a **minor** bump — plus a source for the field (a new `StartEnv` field or
a `ConfigUpdate` arm), plus `set_search_providers`, plus its census tests, **then** the desktop-side
implementation you owed anyway. ~15+ files, 2 repos, 1 crate release — and it still leaves the provider
running in the Worker, which has no `Db`, no `AppHandle` and no `load_settings`.

**The decisive detail.** `src-tauri/src/agent/web.rs:76`:
`pub use fulcrum_harness::web::{cache, config, net, providers, tools};`. A desktop-owned provider can call
`crate::agent::web::net::safe_fetch(url, &FetchOpts { method, headers, body, proxy }, &cancel)` and inherit,
unchanged, the SSRF IP guard, the DNS-rebind-safe `resolve_to_addrs` pinning (`net.rs:195-259`), the 5 MB /
15 s / 10 s bounds, and `strip_cross_origin_headers` — which **now includes `x-api-key`** (the hole the
Keenable report's §F3 flagged was closed in 0.7.0, `net.rs:123`). The crate no longer exclusively holds the
network hygiene; only the dispatch site, and `host_tools` reaches past it.

**Where the host-tool route genuinely cannot go** — three narrow costs, not an impossibility:

| Cost | Why |
|---|---|
| It cannot BE `web_search` | `host_entries` (`registry.rs:513-520`) **drops** any spec whose name `tool_specs()` already carries and logs it via `refused_host_tool_names`. A host provider is an **additional** verb with a new name. |
| No `get_search_content` continuity | `global_cache()` (`web/cache.rs:158-161`) is a `static OnceLock` — **process-local, in the Worker**. A Supervisor-side host tool cannot write it, so it cannot emit a `responseId` the engine's `get_search_content` resolves, and the `[N chars truncated — get_search_content with response_id …]` handoff is unreachable for it. |
| Not in the failover ladder or the `defaultProvider` select | `AVAILABILITY_ORDER` / `SEARCH_PROVIDERS` are crate consts, and `WebConfig::from_web_settings` (`web/config.rs:88-93`) filters any `defaultProvider` outside `SEARCH_PROVIDERS` down to `"auto"`. |

If those three matter, **the cheapest crate change is not the old seam** — it is widening `all_providers()`
to read a declarative row from the already-packaged `StartEnv.web`, the ADR 0014 model-provider pattern: no
new `ToolCtx` field, no literal breakage, no `AgentLoop` API change.

**Nothing forbids this, and an unknown tool name passes the gate.** The crate's `boundary_pins.rs` (9 tests)
and `source_lints.rs` (10) assert absences pointing crate→desktop; `grep -n "providers\|web::" src/boundary_pins.rs`
is two comments. Desktop `scripts/*.sh` hold zero provider/host_tools/tool_specs path scans. `POLICIED_TOOLS`
is 7 names (`harness/loop/gate.rs:19-27`), `policy_verdict` returns `None` for anything else, and the
fall-through **dispatches** — fail-open by design, and `web_search` is ungated today, so a host provider is
at parity, not looser.

⚠️ **One pre-existing consequence worth naming:** a definition's `permission:` block naming a host tool is
parsed, retained as `ToolKey::Unrecognized`, announced — and **never enforced**, because `definition_verdict`
is reached only from inside `policy_verdict`, which already returned `None`. A `specstream_search: deny`
frontmatter row would be a **silent no-op** today for all eight board verbs too. The working control is
`enabled_tools` (`dispatch.rs:196-201`), which does work and does reach Settings. Separately, `narrow`
cannot filter host verbs at all (`harness/launch.rs:280-291` filters against the 19 engine specs).

### F2. The Search UI inventory — the user's premise is half wrong and the right half is the load-bearing half

**Wrong in the literal form.** Keenable's Settings UI is not missing. `WebSearchSection.tsx:306-315` is a
full `KeyedProviderRow` (masked key + eye toggle `:99-122`, Test button `:89-98`, result badge `:80-88`),
`:350-351` is its `SelectItem` with a `(not configured)` guard, `:309` carries the app's **only** privacy
disclosure, and commit `140a342a` shipped `KEENABLE_API_KEY` env layering with `clear_web_env` coverage,
two dedicated Rust tests and three frontend cases — plus `src-tauri/tests/search_provider_vocabulary.rs`,
written in the same change specifically to stop the vocabulary drifting across the crate/frontend boundary.

**Right in the form that matters.** Six capabilities the app already treats as table stakes for *any*
provider you put an API key into exist for **zero** Search providers:

| Missing | The in-repo precedent that already exists |
|---|---|
| **Key-acquisition / docs / pricing link.** `grep -c "href\|https://" WebSearchSection.tsx` → **0** (re-verified). It is the only settings section with no link of any kind. | Model row renders "Get key" from `provider.keyUrl` (`ProviderSection.tsx:211-227`, an ADR 0051 External open) |
| **Spend / credits / balance.** `credits_remaining` appears nowhere in `src/`, `src-tauri/src`, `src-tauri/tests`, or the crate. Keenable's `usage` object is **discarded at parse** (`keenable.rs:32-35` is `results` only). | Model row has a live Spend/max-budget line, fetched page-level and refreshable (`ProviderAuthSection.tsx:298-304`, `:572-576`) |
| **The transcript never names the engine.** `details.provider` is produced (`web/tools.rs:185`), crosses the wire (`normalize.rs:549-559`), and is read by **nobody** (re-verified: the only `.provider` hit in `toolOutput.ts` is the model catalog lookup at `:296`). Our own registry files it as `"provenance, dumped"` (`toolDetailsRegistry.test.ts:662`). | `ModelPicker.tsx:86-88` / `SessionConfigSelect.tsx:274-277` name the model's provider in the trigger |
| **Auto-failover is structurally invisible.** `was_auto_resolved` is set on the auto walk and read **only inside `registry.rs`**; it is not a field of `SearchOutcome` (`:31-34`), so it cannot reach `details`, the frame, or any component. Zero readers in either package (re-verified). | Model row shows a persistent derived status (`N models` / `unreachable`, `ProviderSection.tsx:160-167`) |
| **No persistent status.** The Test badge is local `useState` (`:56`) — destroyed on remount. A user cannot tell, after closing Settings, whether their key works. | Model row derives its status from the catalog and can re-derive it on demand (`:151-159`) |
| **No machine-readable "metered" attribute, no enable/disable, no ordering.** `SearchProvider` exposes `id()`, `name()`, `is_available() -> bool` — a `bool` cannot say "available, but paid". | Model providers are added, renamed, re-configured and removed from the UI (`ProviderSection.tsx:357-409`) |

**These are not independent, and that is the actual finding.** `docs/features/keenable-search-known-gaps.md`
§2 records the concrete defect: for a user holding brave + keenable on `auto`, an ordinary brave `429` fails
over **into** a metered per-credit API. It is invisible **precisely because of** rows 2, 3 and 4 above — the
user sees `Searched <query>` and a link list, and nothing distinguishes "free" from "this cost money" or
"your chosen engine answered" from "you were silently rerouted". Keenable is the first Search provider where
that invisibility has a price attached. **SpecStream would be the second, and its metering is per-call by
design.**

**The complete surface inventory** (so nobody re-derives it): the Settings nav button
(`SettingsPage.tsx:631-636`), the section header, four `KeyedProviderRow` instances + `SearxngRow` +
`DuckDuckGoRow`, the `Default provider` closed select (`:319-358`), the `Proxy` row, the transcript tool row
(`toolOutput.ts:73-74` verb, `:524` label, `:563` icon), the expanded card body (`ToolCallCard.tsx:126-145`),
the failure tooltip (`toolOutput.ts:646-668` → `ToolCallCardHeader.tsx:208-249`), and the
`get_search_content` row. **Nothing outside `WebSearchSection.tsx` mentions Search providers at all** — the
only other hits are `types.ts:1291-1298` field names and a fixture. So every gap above has no secondary
surface where a user could discover it.

The row list is also **hand-written per provider, not data-driven** — three bespoke components
(`KeyedProviderRow` `:36-127`, `SearxngRow` `:129-191`, `DuckDuckGoRow` `:193-242`) whose badge block is
**byte-identical** across all three. A model provider is `settings.providers.map(…)`; a Search provider is a
compile-time constant.

### F3. Registration breadth for a 7th provider — ~44 sites, and the dangerous one has no pin anywhere

Re-measured at crate 0.8.0 + desktop HEAD, by **byte-diffing the published 0.7.0 and 0.8.0 trees in the
local registry** rather than reading release notes. **Zero registration sites are new since 0.7.0**:
`web/config.rs`, all of `web/providers/`, `net.rs` and `cache.rs` are byte-identical, and `web/tools.rs`
changed only four lines inside `#[cfg(test)]`. The 0.8.0 release note is true — `web_search` moved from a
match arm to a table entry (`tools/exec/registry.rs:564`) — but that entry names the **tool**, not a
provider, so it is not a registration site.

~44 discrete sites across 23 files (12 frontend, 5 desktop-Rust, 6 crate incl. 2 new files), split:

| Class | n | The ones that matter |
|---|---|---|
| **compile error** | 14 | 6 full `WebSettings`/`WebConfig` literals — **all inside `#[cfg(test)]`**, so **`cargo build` stays green and only `cargo test` breaks**; 13 TS typed literals |
| **test failure** | 12 | `registry.rs:279` len assert · `search_provider_vocabulary.rs` (4 directions + order) · `WebSearchSection.test.tsx:218/:228` · the provider-list literal at `commands/settings.rs:1169` · two size ratchets |
| **silent drift** | **7** | `clear_web_env` (`config.rs:147-157`) · `AVAILABILITY_ORDER` (pinned **only** from the desktop's test binary, not in the crate) · the config-update round-trip (`protocol.rs:1274`) · two enumerating key/default lists that can only lose coverage · a stale "7 `String` fields" comment in a file that bills itself as a type-identity pin · **the three untyped `vi.mock`-factory literals** |

**The single most dangerous site is `clear_web_env`.** It has no pin anywhere, and its failure mode is
"green on CI, wrong on a developer's machine".

**`WebSettings` source compatibility, answered precisely:** no `#[non_exhaustive]`; container-level
`#[serde(default)]` (`config.rs:39`), so **wire** compatibility is preserved and an old `settings.json`
parses the new key to `""` with no migration. Rust **source** compatibility breaks for full literals — six
of them, four crate / two desktop, every one inside `#[cfg(test)]`.

**The three untyped mock literals — the class the repo already knows by name:** `App.test.tsx:118-148`,
`PermissionsSection.test.tsx:86-121`, `SettingsPage.test.tsx:104-141`. Each is a `vi.fn().mockResolvedValue({…})`
inside a hoisted `vi.mock` factory, and `vi.fn()`'s default type parameter collapses `mockResolvedValue` to
`any`. `src/test/fixtures/settings.ts:6-16` records the hazard verbatim: *"`App.test.tsx`'s copy had silently
lost the `palette` key … A new field on the real type therefore misses every copy at once, and nothing
notices."* Verified what happened last time: `140a342a` **hand-added** `keenableApiKey: ""` to all three. Had
the author skipped them, nothing in `tsc`, vitest or CI would have failed.

**All of §F3 is moot for a desktop Host tool** — which is the point of §F1. It is the cost of the *crate*
route, quoted so the choice is made with the arithmetic in view.

### F4. SpecStream Search fits `SearchProvider` better than anything we ship

`GET /v1/web-search` (and a `POST` twin with identical parameters, whose purpose is that the query never
enters a URL or a log). Auth is `Authorization: Bearer` — **not** `X-API-Key`. Response is
`{"data": {…}}`, schema `WebSearchPage`, and **`WebSearchSource` requires `['url','title','snippet']`** —
independent of whether an answer exists. So the mapping is 1:1 with `SearchResultItem`, `published` →
`publishedDate`, and unlike Perplexity (`perplexity.rs:56-81`, which fabricates titles and a synthetic
answer row) **nothing needs inventing**. `compact=true` returns exactly "title, url, any dates, one
best-matching snippet per source" — a SERP-shaped payload from an answer-shaped API. `speed=fast` is the
cheaper no-answer tier.

| `SearchOpts` | SpecStream | Verdict |
|---|---|---|
| `num_results` | `num` (1–100) | Direct, with clamping. Our tool advertises 1–20, well inside. Never send 0 — `resolve_num_results` returns 5 for 0 and SpecStream rejects 0. |
| `recency_filter` | **No parameter** — only `after:`/`before:` **inside `q`** | Needs translation, and translation mutates the user's query, which SpecStream **echoes back** in `data.query`. `relaxed[]` reports when an operator could not be applied — a signal neither Keenable nor Tavily offers. |
| `domain_filter` | **No parameter** — only `site:`/`-site:` inside `q` | **Recommend the existing post-filter** (`registry.rs:217-220` → `matches_domain_filter`) and no query surgery: server-side `site:` cleanly supports one host, and a multi-domain `Vec` has no documented composition. |
| `proxy` | n/a (transport) | Already provider-agnostic via `FetchOpts.proxy`. SpecStream's nearest notion is a per-key `eu_egress_only` flag — account-level, not per-call, so not mappable. |

🔴 **The trap.** `security: [{apiKey: []}, {}]` — the operation is declared **anonymously callable**, and a
live keyless probe returns **`402` with an x402 crypto-payment request** (`"PAYMENT-SIGNATURE header is
required"`, USDC on `eip155:8453/42161/137`), plus a `www-authenticate: Payment … method="stripe"` header
and a `__Host-specstream_device` cookie. The docs instead promise `401 missing_api_key`. `check_http_status`
would report `[specstream] error: HTTP 402` and an unconfigured user would see a **billing error**.
`is_available()` must gate this absolutely, and the device cookie is undesirable in a desktop HTTP jar.

Also worth surfacing as a **decision, not a finding**: SpecStream ships **drop-in Tavily/Brave/Exa/
Google-CSE-shaped routes** (`POST /tavily/search`, and `GET /tavily` self-describes as
`"replaces": "https://api.tavily.com"`) at **$0.001/search**. That is a *migration path* for users of
providers we already model, which is a different product decision from adding a seventh provider — and it
is cheaper.

Error model is good: a **closed 33-value `ErrorCode` enum**, `details.field`/`details.reason`, `503` +
`Retry-After` as the only sanctioned retry and explicitly **free**, and `Idempotency-Key` support — though
its semantics are **asymmetric** (search refuses a replay with `409`; extract **replays** it free within 7
days with `Idempotent-Replayed: true`). No numeric rate limit is published for Free or pay-as-you-go.

### F5. Extract has nowhere to hang; Deep Search does not fit

**Verified: there is no `FetchProvider` trait.** `web/` declares exactly two traits — `RenderRequester`
(`web/mod.rs:42`) and `SearchProvider` (`providers/types.rs:38`). `extract::extract` (`extract/mod.rs:28-96`)
is a free async function with a **hardcoded sequential `if` chain** (raw → github → youtube → pdf → article
fallback); the `extractor` field is a provenance tag, not a plugin handle.

SpecStream Extract is genuinely interesting: `POST /v1/extract`, **20 URLs shared across `urls` and `pages`**
(not 20 each), one call ≤20 MB, `markdown|text|html`, PDF/Word/Excel/**EPUB**/image, a per-page `status`
string enum, `read_from: live|site|archive|html`, and a documented escalation ladder (live → as-a-browser →
a real browser → the site's feed → the newest web-archive capture). That ladder is **the same job**
`looks_blocked` (`extract/mod.rs:100-102`, 403/429/503 or <80 words) + `RenderRequester` + the desktop
webview do today, and it would additionally cover documents we cannot read at all beyond PDF.

Two honest costs. **SSRF moves server-side**, so `net.rs`'s blocklist stops applying to those fetches;
SpecStream refuses non-public URLs (`invalid_url`), which *probably* covers cloud metadata but is now *their*
policy, and **loopback URLs — which ADR 0057 deliberately allows — must be refused client-side before they
are ever sent**. And `ExtractedDoc.status` is a `u16` while SpecStream's `status` is a string enum whose
numeric `status_code` needs `include: ["response"]` and is null for non-error pages; `status_code.unwrap_or(200)`
would make `looks_blocked`'s status arm dead for this extractor.

**Deep Search (`parse → quote → authorize → poll`) is not representable as one tool that owns a find.**
Four **independent** blockers, each needing new engine surface:

1. **No spend gate reachable from a tool.** The engine *can* block mid-turn on a human, twice, with no
   deadline by design (`harness/ask.rs:31-97` `ask_flow`, `permission.rs:218` `native_permission_gate`) —
   but both take `&PendingInteractive`/`&PendingPermissions`, which live on `AgentLoop`/`WorkerCore`, and
   **`ToolCtx` carries no pending-gate handle**. `tools/exec/registry.rs:23-28` declares that permanent
   ("`ask` needs the pending-gate map"). The permission gate is also the wrong shape even where reachable:
   its option list is a fixed triple and its only payload is a path string. And it would not fire anyway —
   egress is ungated per ADR 0056. **There is no spend gate to hook; one would have to be invented.**
2. **`HOST_CALL_TIMEOUT = 30 s`** (`host_tools/exec/mod.rs:256`), and the router arm is documented
   **no-modal, no-UI** by rule (`router.rs:328-333`). `ask`'s 300 s cap was deliberately *removed* for
   exactly the reason a human wait needs none.
3. **No durable job/row store.** 10,000 rows × up to 24 cells with per-cell `provenance` is comfortably
   ≫ the `ResponseCache`'s **50 items / 8 MB, process-global `OnceLock`, no persistence**. The DB has no
   generic jobs/rows table, and `write_artifact` caps at 256 KiB.
4. **No 4-hour bound anywhere in the child machinery** — `DEFAULT_SUBAGENT_DEAD_BOUND` is **30 minutes**,
   against a documented worst case of four hours.

**The shape that IS expressible today**: 5–6 short Host verbs (`parse`, `quote`, `authorize`, `find_rows`,
`cancel`), each well inside 30 s, **with the model driving the loop and SpecStream as its own durable store**
— which is exactly what SpecStream's own MCP server exposes (`docs/mcp.md`: quote → *ask your person to
approve the maximum* → authorize → read rows as they arrive). Its real cost is not the engine: **six
advertised tool names, five extra model round trips per find, and a spend approval that is a prompt
convention rather than an enforced gate.** That last clause must never be presented to a user as a spend
guarantee.

Two primitives that already fit and should be reused rather than reinvented:

- **`ToolCtx::emit_tool_execution_update`** (`tools/types.rs:123`/`:228` → `tool_execution_update` →
  `tool_call_update.rawOutput`, which `reducer.ts:356` **replaces wholesale** per frame, already rendered by
  `CodemodeCard`). This matches SpecStream's *"each poll returns the current set… replace your list"* contract
  **exactly**. Codemode is its only producer today; SpecStream would be its second tenant. Caveat: this
  broadcast is **droppable** (`pump.rs:62-79`, the `Lagged` arm discards frames) — progress is best-effort
  by construction.
- **The handle + paged reader pattern** — `responseId` + `get_search_content(offset, limit ≤ 20 000)` +
  `truncation_note`, which maps onto SpecStream's `find_id` + `cursor` + `limit ≤ 100`.

Three SpecStream-side requirements with no host-side answer today: a **stable `idempotency_key` across
retries** (a model re-generates strings; SpecStream's own GitHub Action derives it from the *run*, i.e. the
host); a **host-minted `confirm_max_cents`** (a model choosing a dollar figure in cents is a real-money typo
hazard, and SpecStream says *"it never fills this in for you"*); and **money must not enter the model's
context** — `dispatch.rs:230-245` is the precedent, the subagent's cost is a return value folded into
`cost_acc` and never rendered into the parent's prompt.

### F6. The vendor: strong key controls, weak everything else

**What is better than our current paid provider (Keenable)** — and this matters because the desktop BYO-key
pattern is exactly where key controls pay:

| | SpecStream | Keenable (carried from the prior report) |
|---|---|---|
| Scopes | **9** (OpenAPI enum; the docs table omits `keys:manage`) | none — entirely unscoped |
| Spend cap | `spend_cap_cents`, **lifetime**, 0–1e8 | none |
| Expiry | `expires_in_days` 1–36,500 (**default `null`**) | never |
| Zero retention | **self-serve, per-key**, `PATCH`-able — **but defaults to `false`** | contract-only, *"the console has no switch"* |
| Auto top-up | **contractually ruled out**: *"We do not automatically top up your account or create overage debt"* | Stripe auto top-up, $1,000/month default |
| Worst case for a leaked key | **bounded by stored balance** — no card is charged | an open-ended card bill |
| IP / origin allowlist | **none** (verified absence across the 24,911-line OpenAPI) | none |

**ToS verdict for the BYO-key desktop pattern: permitted, and the vendor documents the pattern itself.**
Their privacy policy describes third-party products holding the user's key — *"that product sends us the
requests you make there with the key or sign-in you connected"* — and their browser extension is the
desktop-local-key shape: *"Your SpecStream key stays in the extension's storage on your device and goes only
to specstream.ai."* No resale/sublicence clause, no attribution requirement, no benchmark-publication
restriction. **The position depends entirely on the key remaining the user's own** — if we ever provision or
bundle keys we become the account holder serving third parties and it collapses. Two inherited terms worth
surfacing to users: results may not be used *"as a factor in deciding a person's eligibility for credit,
insurance, employment, housing…"*, and Deep Search output carries an **EU AI Act Art. 50** disclosure
obligation.

**The no-training promise is weaker than the marketing.** *"no model is trained on your requests, lists or
results"* appears on `/about` and in `llms.txt`. The word "train" appears **nowhere** in the Terms or the
DPA; in the privacy policy it appears once, about *subprocessors*. The nearest contractual hook is the DPA's
"only on your documented instructions". For a 7-week-old entity, a marketing line is thin cover for queries
containing private project details.

**Maturity is where the risk concentrates.** SpecStream SAS, SIREN 131125841, RCS Narbonne, **incorporated
06/10/2026** — ~7 weeks old — **share capital €10.00**. No funding found (a Crunchbase profile with no round;
that is absence, not "bootstrapped"). First changelog entry 30 Sep 2026. Status page returns `"history": []`
and `"uptime_percent": null` — and an independent reviewer could not find the status page at all three weeks
ago. No SLA (*"We do not promise uninterrupted access"*), no SOC 2/ISO, no bug bounty. HN: **2 hits total**,
the launch post at **1 point, 0 comments, self-submitted**.

**Independent quality evidence: none. A clean negative.** Every score on `/benchmarks.md` is vendor-run
(their runs, their configs, their graders, compared against each competitor's *best published* score). The
independent boards do not list SpecStream: `openbenchmarks.com` (14 providers, 3 boards) → **0 mentions**;
`scrapingbench.com` (10 providers) → **0 mentions**. 🚩 And their headline — *"scrapingbench 40/40… No other
provider on the board finishes more than 38"* — **conflicts with the live board**, whose top score is
Context.dev at 38/40 with no SpecStream row. Cannot be resolved; recorded because it is the kind of claim a
product page would otherwise be trusted for.

**Pricing is clear and consistent at the per-call level**: Search **$5/1k** (≤10 results), **$1/1k** fast;
Extract **$0.80/1k pages**; Deep Search rows **5¢ / 15¢ / $1**. Free = **$10 once, no card, 30-day expiry**.
Failed calls are largely not billed and this is well-specified (`503` → *"Nothing is charged"*; a
`status: ok` page alone is charged; *"a find with no match costs nothing"*). Every response self-reports
`price_usd`, and `X-Balance-Cents` / `GET /v1/capacity/balance` exist — **a good fit for a desktop cost
meter**, and directly relevant to gap 2 in §F2.

---

## Unresolved contradictions

| # | Conflict | Resolution |
|---|---|---|
| C1 | Docs: no key → `401 missing_api_key`. **Live probe: `402` + an x402 crypto payment request.** | Live capture wins. `is_available()` must gate absolutely; a keyless call is a billing error, not an auth error. |
| C2 | `docs/api.md`: *"Poll `GET /v1/finds/{id}/events`"*; OpenAPI: `text/event-stream` with `Last-Event-ID`. | It is SSE, not polling. No documented reconnect semantics, event retention, or what `after=0` replays. |
| C3 | Docs list **8** scopes; the OpenAPI `KeyCreateRequest.scopes` enum has **9** (`keys:manage` omitted from the table). | OpenAPI wins. `keys:manage` must be excluded from any desktop-minted key. |
| C4 | `pricing.md`: USD Starter $49 / Growth $199 / Scale $499. `terms.md`: EUR Pro €19 / Scale €99 / Team €499. Both dated 12 Nov 2026. | Unresolvable; the ToS is binding and appears stale. **Never display SpecStream *plan* prices in our UI** — per-call rates agree everywhere. |
| C5 | *"each poll returns the current set… replace your list"* vs OpenAPI's incremental `SseRow` + `SseRowPatch`. | Reconciled as keyed-by-`entity_id`, last-writer-wins, whole-row replace, `locked: true` = final. **Inferred, not stated.** |
| C6 | `/security.md`: *"The same periods are in the data processing agreement and the privacy policy."* | The privacy policy's retention table has **no** zero-retention row and never uses the term. The parity claim is not borne out. |
| C7 | `docs/api.md` says a key needs `specs:write`/`finds:write`/`finds:spend` "to approve"; `/v1/web-search` declares only `security: apiKey` with **no scope requirement**. | **Unresolved and the highest-value unknown** — see Gap 1. A nominally read-only key can very likely still burn balance on searches. |

---

## Gaps

1. **No authenticated call was made — no key exists.** Every response shape is doc/OpenAPI-sourced. The
   single highest-value unknown is C7: **whether a search-capable key lacking `finds:spend` can still spend
   balance.** If it can, "read-only key" is not a real control and the key-minting guidance in the
   recommendation is cosmetic. Only a live call with a scoped key settles it.
2. **`spend_cap_cents: 0` semantics undocumented** — default is `0`, and no page says whether that means
   "no cap" or "no spending". The default account monthly ceiling (`monthly_limit_cents`) exists but its
   value is published nowhere. Free-tier rate limits are unpublished (only Starter 1,000 / Growth 2,000 /
   Scale 5,000 calls-per-minute appear).
3. **`SseProgress.phase` is a bare `type: string`**, not an enum, in both docs and schema. A progress UI can
   echo `message` but can never enumerate or translate phases.
4. **`docs/finds.md` and `docs/deep-search.md` do not exist** (404). The async contract has no dedicated page
   and is reconstructed from `docs/api.md` prose + `Sse*` schemas. No *typical* runtime is published — only
   the four-hour worst case, which is nothing to size a tool's patience against.
5. **`GET /v1/capacity/requests/{request_key}` — the documented "recover instead of double-buying" endpoint —
   is untyped in the OpenAPI** (`data: {additionalProperties: true}`). The recovery path an agent needs most
   when a `202` is ambiguous has no specified shape.
6. **No Rust SDK** (verified: crates.io sparse index returns `NoSuchKey`). Python/TS exist since 12 Oct 2026.
7. **Subprocessors named only by category**, full list email-on-request — the AI-services chain cannot be
   assessed. Trustpilot unreachable behind a bot check; G2 content unrenderable.
8. **Incident history is structurally unavailable**, not merely empty. Re-check in ≥3 months.
9. **Wordmark/logo usage is unlicensed** — the ToS carries only a bare reservation of rights, and absence of
   a trademark policy is not permission. Naming the provider in text as a factual label is fine.
10. Whether `passages=true` (RAG) bills above the base search rate is undocumented.

---

## Recommended answer

1. **Own Search providers on the desktop as Host tools.** Zero crate releases, ~6 files, one repo, and the
   crate's `safe_fetch` is already re-exported for exactly this. **Do not build `ToolCtx.search_providers`** —
   it is superseded, and it is a minor-bump source break for 13 literals to buy a transport that exists.
   Accept and state the three costs: not the name `web_search`, no `get_search_content` continuity, not in
   the `defaultProvider` select or the failover ladder. If those matter later, the cheap crate change is a
   **declarative provider row on `StartEnv.web` read by `all_providers()`** (the ADR 0014 pattern), not the seam.
2. **Ship SpecStream as a Search provider behind that mechanism, keyless-gated hard.** `compact=true`, read
   `sources[]`, `published` → `publishedDate`, `domain_filter` left to the existing post-filter,
   `recency_filter` translated only if the query-echo behaviour is acceptable, `is_available()` gating on key
   presence absolutely.
3. **Fix the Search UI gaps as their own track, and do not scope them to SpecStream.** The three that matter
   are (a) a `keyUrl`-equivalent per Search provider, (b) a spend/balance readout, and (c) **naming the
   engine in the transcript** — `details.provider` already crosses the wire and is discarded, so (c) is a
   frontend change to a field that already arrives. (c) is also the precondition for the Keenable §2 failover
   gap being visible at all.
4. **Do not ship Deep Search in the same move.** If it is wanted, take the 5–6-verb model-driven shape, and
   label the spend approval as advisory in both code and UI, because nothing enforces it. Treat the money
   fields as host-computed integers that never enter the model's context.
5. **Do not adopt SpecStream Extract** until there is a real `FetchProvider` seam *and* a client-side
   loopback/private-URL refusal that runs before the URL leaves the device. Its escalation ladder is a good
   long-term replacement for `looks_blocked` + webview, not a v1.
6. **Mint desktop keys with `zero_retention: true` on by default** (it defaults to `false`), a non-null
   `expires_in_days`, a non-zero `spend_cap_cents`, and **no `keys:manage` / `projects:manage`** — and verify
   Gap 1 empirically before presenting any of that to a user as a control. Disclose that queries leave the
   device; never show SpecStream's plan prices.
