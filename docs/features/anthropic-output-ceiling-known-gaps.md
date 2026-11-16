---
status: live
last-verified: 2026-11-16
verified-by: >-
  Re-measured against the shipped code, not copied from the plan whose durable half this is. Engine `main` IS the
  published crate: `git describe --tags` → `v0.3.2` (the `fulcrum#26` squash, on the engine's `origin/main`);
  `diff -rq /home/daniel/Coding/Archimedes/fulcrum/src
  ~/.cargo/registry/src/index.crates.io-*/fulcrum-harness-0.3.2/src` → **exit 0, no output**. Desktop:
  `grep -n '^fulcrum-harness' src-tauri/Cargo.toml` → `0.3.2`; root `Cargo.lock` → `version = "0.3.2"`,
  `checksum = "c7b609f0ce0b4a6a3d9a4ffa1f0f9f1b20c5ba2e9d898632d16b0bc386b5e685"`; pin commit `61ba91ee` is on
  `origin/main` and its `git show --stat` names `Cargo.lock`, `src-tauri/Cargo.toml`, ADR 0024 and **nothing under
  `src-tauri/src`** — the desktop-neutrality proof §4 leans on. `cargo test -p fulcrum-harness --lib --
  harness::provider::anthropic` → **51 / 0**; `-- provider_switch` → **5 / 0**; `cargo test --workspace` →
  **1678 / 0 / 3 ignored**; the `turn_lifecycle` matrix → **35 / 0**. Three mutation plants run and reverted (§5),
  after which that repo's `git status --porcelain` was empty and `cargo fmt --all -- --check` was clean in both
  trees. No live Anthropic credential: `env | grep -c ANTHROPIC` → **0**; `settings.json` holds one provider,
  `wizards`, `api: "litellm"`.
---

# Anthropic output ceiling — what shipped, what it does not fix, what the tests cannot see

The durable facts of the Anthropic output-ceiling work, folded out of `docs/roadmap/anthropic-output-ceiling.md`
(gitignored, deleted on ship) before that plan died. Design and rationale: ADR 0024's 2026-11-16 amendment. What
lives here is the shipped shape, plus the gaps and blind spots that amendment does not hold.

## 1. What shipped

The old clamp **raised** `max_tokens` to sit above the thinking budget (`max_tokens.max(budget + 1024)`), so the cap
rode the budget instead of bounding it: `xhigh` sent **41,024** against a 40,000 budget, leaving 1,024 tokens for
the visible reply *and* the whole `tool_use` block; `max` sent **129,024**, which Anthropic answers with a **400**
(over-cap is a rejection, never a silent clamp). `fulcrum-harness` 0.3.2 (`fulcrum#26`, pin `#198`) inverts it —
`max_tokens` is the ceiling, `clamp_thinking_budget` moves the **budget** down beneath it — requested
**unconditionally** on this wire, deliberately *not* gated on `is_claude_model` (prompt caching is its only other
job), because a family-prefix gate would silently disable it for the alias-prefixed ids LiteLLM routing leaves
behind (#196). The level table is untouched (`low` 4096 / `medium` 10000 / `high` 20000 / `xhigh` 40000 / `max`
128000, unrecognised → `{"type":"adaptive"}` with no budget); only the wire moved.

| private constant (`harness/provider/anthropic.rs`) | value | role |
|---|---|---|
| `ANTHROPIC_OUTPUT_CEILING_TOKENS` | **64,000** | the ceiling on `max_tokens`, sent whenever the caller sends no cap |
| `MIN_ANSWER_TOKENS` | **16,384** | the answer's floor (visible text **plus** the `tool_use` block); room = **47,616** |
| `MIN_THINKING_BUDGET_TOKENS` | **1,024** | Anthropic's own legal minimum, a **DROP THRESHOLD — not a floor**; never raises a budget |

Room 47,616 > `xhigh`'s 40,000, so `low`/`medium`/`high`/`xhigh` keep their budgets token-for-token and only `max`
shrinks — the one level whose old request was illegal anyway. A caller cap is **honoured, not raised**: `Some(64)` +
`low` → **4160**, where the old clamp forced 5120; that arm moves *down*, so "bigger cap, strictly more room" is
false here.

## 2. The live route is unaffected — this is not a live-behaviour change

`route_hint_of("Qwen/…")` is `"qwen"` (first-`/` split, lowercased), `const CLAUDE_ROUTE_HINTS: [&str; 3] =
["anthropic", "bedrock", "vertex_ai"]` (`harness/catalog.rs`) does not contain it, so `derive_wire_for_route` falls
through to `WireApi::OpenAiCompletions` — and the Messages rung would also need the `messages_available` latch,
which this gateway fails with a 405 on `GET /v1/messages`. Both OpenAI builders still **omit** the field on `None`
(`openai.rs`'s `if let Some(m)`, `responses.rs`'s `max_output_tokens` twin), so the live cap is the gateway's
implicit one, measured at **131,072** and reached exactly. The old clamp was a real defect on a wire this deployment
does not use: correcting it is neither a live change nor a no-op.

## 3. The failure this does NOT address

Reasoning saturating the budget and the wire then reporting an honest **`stop`** with zero visible text — measured
live at `xhigh` as `completion_tokens: 34954` / `reasoning_tokens: 34954`, no visible characters,
`finish_reason: "stop"`. `FinishReason::Length` never fires, so #190's gate never sees it and `turn_truncated`
never emits; **no cap sizing touches it**, and it is reachable with no cap configured at all. #190 is the parent
and **stays open** — this pin moved one prerequisite, it does not close it. ADR 0108's amendment carries the same
measurement and calls it "a different defect, and … where the remaining user pain is".

## 4. Gaps deliberately left open

- **ADR 0108's causal aside is now false and its amendment is OWED.** Its Consequences name as "the actual cause at
  this deployment's configured level" that "the Anthropic clamp leaves ~1,024 tokens for the visible reply *and* the
  whole `tool_use` block at `xhigh`". That described the **old** clamp; at `xhigh` the budget is now untouched at
  40,000 and the answer's floor is 16,384, so it matches no shipped arithmetic. **Its decision is unaffected** — a
  length stop stays terminal and never retried, because this sizes the cap once at request-build time and neither
  adds nor removes a retry (`"exactly ONE model call — no re-issue, no bigger max_tokens"` in
  `loop/tests/turn_lifecycle.rs`, green untouched). Not amended here: another session holds uncommitted work in that
  file; ADR 0024 records the same PENDING follow-up.
- **Three `status: current` research docs describe the old clamp as current**, one via a test name that no longer
  exists. `docs/research/silent-turn-settle-after-announcing-a-write.md` (tracked) states
  `max_tokens = max(32768, budget + 1024)` as the live shape, tabulates `xhigh` → 41,024 / `max` → 129,024, and
  cites `anthropic_request_body_max_tokens_default_and_clamp` twice — **a dangling content pointer**, as it is now
  `anthropic_request_body_max_tokens_is_a_ceiling_not_a_budget_sum`. `…/max-tokens-is-never-sized-…` (the design
  source) and `…/silent-turn-escape-hatch-announced-intent.md` (which asserts "the pinned crate still sends
  `max_tokens = 41,024`" — false on 0.3.2) are the same class, and the latter also says "`docs/roadmap/anthropic-
  output-ceiling.md` is open in the tree", a path this ship deletes. The fix is a **`status: superseded` flip** (or
  an amendment) in each, not a rewrite; the last two are other sessions' untracked files.
- **The desktop's titling module doc under-describes its own behaviour.** `agent/session/naming.rs`'s module
  docblock advertises "bounded `max_tokens: 100`", but `naming.rs` sends `max_tokens: None` whenever a naming
  reasoning level resolves, and `None` now resolves to the **64,000 ceiling on a title request** — where the old
  formula gave 32,768 at `low`/`medium`/`high`, 41,024 at `xhigh`, 129,024 at `max`, so the ask **rises** at four of
  the five levels and drops only at `max`. With no level configured (today's setting) titling still sends
  `Some(100)` → 100, byte-identical. Judged safe: Anthropic excludes `max_tokens` from OTPM and bills on actuals, so
  the ask reserves nothing. Deliberately unfixed because editing desktop source would void the pin's
  zero-source-change proof — itself the desktop-neutrality evidence.
- **`MIN_ANSWER_TOKENS`'s justification is a measurement that exists nowhere in either repo.** The 62% / 65%
  tokenizer figures are carried, labelled REPORTED and not reproducible, in the constant's own doc comment in the
  engine — with ADR 0024's amendment, their only surviving copies. The load-bearing argument is the floor's
  **affordability** (47,616 > `xhigh`'s 40,000), not the percentages; re-measure it and `MIN_ANSWER_TOKENS` is the
  number to re-open, not the design shape.

## 5. What the test suite provably cannot catch

- **The legality sweep never constrains the budget's value.**
  `the_wire_never_asks_for_more_than_the_ceiling_and_always_outranks_its_budget` (16 caps × 9 budgets = 144, plus
  16 × 7 levels = 112) asserts only `max_tokens ≤ ceiling` and `max_tokens > budget_tokens`, so an over-shrink stays
  legal at every input: `min(b, MIN_ANSWER_TOKENS)` and `min(b, room − 1)` each left the sweep **green** while
  reddening exactly `the_clamp_shrinks_and_only_drops_when_no_legal_budget_fits`,
  `anthropic_request_body_thinking_map` and `anthropic_request_body_max_tokens_is_a_ceiling_not_a_budget_sum`
  (48 / 3, both times). A clamp raising small budgets to 1,024 is legal at all 256 inputs by enumeration — and
  unobservable in any outcome today, since every budget it can see is already ≥ 1,024. The literal value pins are
  the guard, as the sweep's own docblock says.
- **The drop arm is unreachable and deliberately unasserted.** `room` derives from two `const`s, so the ceiling is
  not a parameter; the arm fires only below a ceiling of 16,384 + 1,024 = **17,408**, and no cap or level reaches it.
  It has a docblock, not a test — do not fake liveness. (The budget-less `adaptive` mode sharing its code path is
  the part with a real witness.)
- **`Some(cap) × Some(budget)` has no production caller.** The loop sends `max_tokens: None`, the summariser sends a
  cap with `reasoning_effort: None`, titling drops its cap when a level is set. That arm is **test-only**: a bug
  there is latent, not live.
- **`c.max(1)` is guarded only by `Some(0)`, an input no caller produces.** Deleting it reddened **one** test, the
  sweep, and nothing else (50 / 1): legality-pinned, not value-pinned.
- **The ceiling is proven against wiremock only** — no live Anthropic credential exists here. The one test that
  reaches a real `POST …/messages` body is the engine's `a_loop_turn_on_the_anthropic_wire_sends_the_output_ceiling`
  (`loop/tests/provider_switch.rs`), which asserts `max_tokens` is **present** before asserting its value — without
  that first half a request routed to an OpenAI builder would omit the field and pass every value assertion
  vacuously. The desktop's own `tests/provider_headers.rs` mounts `/v1/messages` matching method + path + one header
  and asserts nothing about the body, so the desktop suite cannot see a body change at all. If a real Anthropic
  credential is ever configured, the check to run is one `xhigh` tool-calling turn confirming `max_tokens: 64000`
  on the wire and no 400 at `max`.

## 6. Track 2 — per-model ceilings (the change that makes the dead code live)

`catalog::Model` has **no output-cap field** (it carries eleven: `id`, `provider`, `base_url`, `api_key`,
`context_window`, `cost_per_mtok_in`, `cost_per_mtok_out`, `supports_tools`, `supports_thinking`, `thinking_levels`,
`api` — the plan that sized this said "ten" and miscounted) and `DiscoveredMeta` has none either. The LiteLLM
discovery arm **spends** the advertised value as a context-window fallback — `aart_to_meta`'s
`context_window: route.context_window.or(route.max_output_tokens)` — and drops it, and the desktop's
`refresh_live_models` copies only `context_window` / `supports_thinking` / `thinking_levels`. When the ceiling
becomes per-model, parameterise it and the **drop arm becomes reachable and assertable in the same commit** (any
model under a 17,408 ceiling reaches it). Open neighbours: **#195** (`thinking.type.enabled` → `adaptive` +
`output_config.effort`, which drops the budget out of the ceiling arithmetic entirely — they compose cleanly, but
#195 must not treat these constants as its gate), **#196** (the caching gate's family-prefix test misses LiteLLM
aliases; §1's un-gated ceiling is one of its witnesses), **#193** (which OpenAI-shaped wire is live —
`supported_endpoints` is parsed nowhere, `mode` is `null`), and an ADR owed **when** track 2 lands, recording who
owns the output-cap number and why it is not the user. One trap on that path: `provider_overflow.rs` is the
**context**-overflow classifier and carries no output-cap fragment — adding one there would misfile a request-shape
error as an input overflow and could trigger compaction for it. Making the ceiling the clamp's upper bound (what
0.3.2 did) is what makes an over-cap 400 unreachable, and that is the fix.

## 7. Process: a citation to a hash not yet on `origin/main` is orphaned by the squash

One research doc cites a **pre-squash per-issue engine hash** as "the output-ceiling fix … UNRELEASED" and builds a
follow-up on it ("re-measure after it ships"). That object resolves only on a stale local
`origin/feature/anthropic-output-ceiling` ref — the work landed as the `fulcrum#26` squash — so
`git merge-base --is-ancestor <that hash> origin/main` **fails even in the engine repo** where the object exists, and
in a normal clone it resolves nowhere. This doc does not repeat it; the doc's own text is the handle. The rule is
**writer-side**: cite a PR number (`fulcrum#26`, `#198`), a published version (`fulcrum-harness 0.3.2`), or code by
content, never a hash not yet on `origin/main`. Per-file cleanup cannot keep up — the squash orphans a citation at
merge, not at write.
