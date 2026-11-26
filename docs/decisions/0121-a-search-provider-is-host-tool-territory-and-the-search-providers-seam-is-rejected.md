---
status: accepted
date: 2026-11-26
superseded-by:
---

# A Search provider is Host-tool territory; the `ToolCtx.search_providers` seam is rejected, and `all_providers()` stays the only failover ladder

Adding Search provider #6 (Keenable) cost **two repos, two commits, ten crate files, one irreversible
`cargo publish`, and a pin bump** (`140a342a` + crate `477d3d4`, which had to be a MINOR because
`WebSettings` is a plain `pub struct` whose new field breaks every full struct literal). A desktop **Host
tool** shipping the same class of capability cost **one commit, one repo, zero crate files** (`d4b4995b`,
`mark_done`). `docs/research/keenable-as-a-search-provider.md` §F4 had recommended the opposite route —
add `ToolCtx.search_providers` + `AgentLoop::set_search_providers` so future providers become desktop-only —
and its stated blocker was a measurement: *"Measured: zero hits for `host_tools|HostToolCall` anywhere in
`fulcrum/src`."* That measurement is false at crate `fulcrum-harness` 0.8.0. ADR 0102 shipped (`adec7dbe`),
then `mark_done` (`d4b4995b`), and the mechanism the seam was invented to replace now exists.

**We decided: a Search provider is a Host tool.** Its substance acts on host-owned state — the user's API
key and proxy setting — and on nothing the engine confines, so ADR 0102's own discriminator puts it on the
Client side: *"A tool whose substance the engine already confines stays an **Engine tool**"*, and
`web/mod.rs:3-5` states the corollary outright — *"Egress is NOT policy-gated (ADR 0056): outbound web
requests are network calls, not file system operations."* The frozen-`ToolCtx` invariant that keeps `bash`
engine-side has **nothing to protect** on a URL fetch. The desktop can also do this without the crate's
cooperation because `src-tauri/src/agent/web.rs:76` already re-exports the crate's network layer
(`pub use fulcrum_harness::web::{cache, config, net, providers, tools}`), so a Supervisor-side provider
inherits `net::safe_fetch`'s SSRF guard, its DNS-rebind-safe `resolve_to_addrs` pinning
(`web/net.rs:195-259`), and `strip_cross_origin_headers`' `x-api-key` removal (`net.rs:123`) — the crate no
longer exclusively holds the network hygiene, only the dispatch site, and `StartEnv.host_tools` reaches past
it. **We explicitly reject the `ToolCtx.search_providers` seam**: `ToolCtx` (`tools/types.rs:144-229`) has no
`#[non_exhaustive]`, so its new field breaks **13 full struct literals** (10 crate + 3 desktop) and is a
MINOR bump by the crate's own ruling — one irreversible release spent buying a transport that already ships.
The ~44-site / 23-file registration checklist that a crate-resident provider owes (`docs/research/`
§F3, incl. `clear_web_env` at `web/config.rs:147-157` which has **no pin anywhere** and fails "green on CI,
wrong on a developer's machine") is the cost this decision avoids paying per provider.

**Accepted costs, stated so nobody rediscovers them as a bug.** A Host tool cannot BE `web_search` —
`host_entries` (`tools/exec/registry.rs:513-520`) drops any spec whose name `tool_specs()` already carries
and logs it via `refused_host_tool_names`, so a host provider is an **additional** verb with a new name. It
cannot supply `get_search_content` continuity, because `global_cache()` (`web/cache.rs:158-161`) is a
`static OnceLock` in the **Worker** and the Supervisor cannot write it, so it emits no `responseId` the
engine's `get_search_content` resolves and the `[N chars truncated — get_search_content with response_id …]`
handoff is unreachable for it. And it cannot be the `defaultProvider` or enter failover, because
`AVAILABILITY_ORDER` / `SEARCH_PROVIDERS` are crate constants and `WebConfig::from_web_settings`
(`web/config.rs:88-93`) filters any unlisted `defaultProvider` down to `"auto"`. **If** those three are ever
required, the cheapest crate change is **not** the rejected seam — it is widening `all_providers()` to read a
declarative row from the `StartEnv.web` that is already on the wire, the ADR 0014 model-provider pattern: no
new `ToolCtx` field, no literal breakage, no `AgentLoop` API change.

**Considered options.** (1) *The injection seam* — rejected above; strictly dominated on both cost and
outcome. (2) *Extract `web/providers/` out of the crate* — rejected: it is a **breaking public-API removal**
that decouples nothing that was coupled (the subtree is a strict leaf and nothing outside `web/` names
`web::providers`, re-verified at 0.8.0), strips free `web_search` from the `fulcrum serve` daemon, and still
blocks the next provider on a publish — friction relocated, not removed. (3) *Keep providers in the crate and
reduce the site count* — viable and honest, but it leaves every future provider gated on a hand-run
`cargo publish`, which `fulcrum/AGENTS.md` notes is irreversible (*"that name is burned permanently"*), and
the arithmetic above shows the release buys nothing the Host-tool path does not already provide.

**Consequences.** Search providers now live in **two homes** — the six shipped ones in the crate, the next
ones in `src-tauri/src/agent/host_tools/` — which is surprising without this document and is the reason it
exists. `CONTEXT.md`'s **Host tool** entry's claim that the board verb is *"the first and so far only
tenant"* stops being true on the first shipping provider and must be amended then. Two pre-existing
limitations become load-bearing rather than academic: a definition's `permission:` block naming a Host tool
is parsed, retained as `ToolKey::Unrecognized`, announced, and **never enforced** (`definition_verdict` is
reachable only from inside `policy_verdict`, which already returned `None` for a non-`POLICIED_TOOLS` name),
so `specstream_search: deny` frontmatter is a **silent no-op**; and `narrow` cannot filter Host verbs at all
(`harness/launch.rs:280-291` filters a definition's `tools:` against the 19 engine specs). The working
control is `enabled_tools` (`dispatch.rs:196-201`), which does reach Settings via `list_tools`
(`commands/settings.rs:158`). Finally, this decision does NOT make the metered-provider failover gap
(`docs/features/keenable-search-known-gaps.md` §2) fixable by moving code — that gap needs a per-provider
"this one is paid" attribute on the `SearchProvider` trait, which is a crate change regardless of where a
NEW provider lives, and its §2 text asserting *"the fix is a crate release, so it is out of this repo's
reach"* remains true for the six shipped providers.
