---
status: current
last-verified: 2026-11-15
task: tsk_206ed63f-04d5-47ff-8bb4-c9b9363d8899
verified-by: >-
  Six parallel research angles + parent re-verification, 2026-11-15. (a) Engine source at the sibling
  checkout `/home/daniel/Coding/Archimedes/fulcrum` (`50bed1d`, `git describe --tags` = `v0.3.0`),
  independently confirmed byte-identical to the published crate by
  `diff -rq src ~/.cargo/registry/src/index.crates.io-*/fulcrum-harness-0.3.0/src` (exit 0, no output).
  (b) LIVE gateway probes against the configured `wizards` LiteLLM route with the operator's own key,
  authorised for this run; ~1.05M output tokens, ~$0.041. Four of the load-bearing probe results were
  re-run by the parent agent independently. (c) A read-only snapshot of the real
  `archimedes.db` (2,367,160,320 B; 2,334 sessions) — see Gaps for why it is a TORN copy and what that
  costs. (d) Thirteen upstream agent harnesses read at source level with commit-SHA permalinks, plus
  Anthropic / OpenAI / LiteLLM official docs read 2026-11-15. (e) `openai/codex` at `b1573f1` and
  `anthropic-sdk-python` at `5139cf2`. Citations are BY CONTENT (function, struct, enum variant,
  test name, issue number) per this repo's locate-by-content rule, not by line number. One finding in
  this report's FIRST DRAFT was wrong and is corrected in place in §D: the truncation notice was reported
  as never persisted, and tracing `turn_truncated` through `EmitPipeline::run` shows it IS persisted as an
  `agent-text` row keyed `{stamp}:truncate:N`, which makes ADR 0108's Falsifier runnable today.
issue: https://github.com/archimedes-codes/archimedes/issues/190
supersedes: none
---

# The output cap is never sized — and the live cut is reasoning, not the tool call

**The settled question (Phase 0):** which layer should own the output-cap number for a tool-calling
turn — a derived engine policy, a measured gateway default, or a user-visible setting — and does
ADR 0108's no-retry rule still hold now that a truncated turn dispatches nothing?

This card was split out of #190 as the *prevention* half of a two-part fix: #190 made truncation
visible, this one was to reduce how often it happens. Its premise was that the Anthropic reasoning
clamp `max(32768, budget + 1024)` leaves ~1,024 tokens for the visible text and the whole `tool_use`
block at `xhigh`/`max` effort, and that the fix is to size the cap. **Six angles found that the
premise is real but latent on this deployment, that sizing the cap changes nothing here, and that the
failure actually occurring is one #190's gate cannot see.**

---

## Executive Summary

**1. The card's "1,024 tokens for the tool call" is not in force on this deployment.** That arithmetic
lives only in the Anthropic wire builder. The live route derives `openai-completions` —
`route_hint_of("Qwen/…")` is `"qwen"`, which is not in `CLAUDE_ROUTE_HINTS`, and
`derive_wire_for_route` therefore falls through to `WireApi::OpenAiCompletions` — and both OpenAI
builders **omit** the field when `max_tokens` is `None`. Probed directly: with no `max_tokens`, output
saturates at exactly **131,072** tokens. The effective cap on the live route is ~131k, not 1,024. The
Anthropic clamp is a genuine defect on a wire this deployment does not use.

**2. Sizing the cap is a no-op on the live route.** `/v1/model/info` advertises
`max_output_tokens: 131072` for the default model, and the gateway's implicit default is **also
exactly 131,072**. Sending the advertised number explicitly changes no behaviour. The card's proposed
direction cannot help this deployment.

**3. The live failure is a shape #190's gate cannot see.** At `xhigh` with no cap, the probe returned
`completion_tokens: 34954`, `reasoning_tokens: 34954`, **zero visible characters**, and
`finish_reason: "stop"`. Repeated at a larger prompt: 263,344 characters of reasoning, no visible
text, `finish_reason: "stop"`. `FinishReason::Length` never fires, so `turn_truncated` never emits and
the turn settles as an ordinary success. **This is issue #64's 33-byte row, reachable with no cap
configured at all.**

**4. The number we would need is already on the wire and deliberately thrown away.** The LiteLLM
discovery arm parses `model_info.max_output_tokens`, reduces it with `min` across deployments, then
spends it as a **context-window fallback** (`context_window: route.context_window.or(route.max_output_tokens)`)
and it dies inside that module. `catalog::Model` has no output-cap field. ADR 0047 already records the
gap in its Consequences: *"The 8 192 clamp stands in for a per-model maximum-output we do not model."*
Separately, `supported_endpoints` is **never parsed anywhere in the crate**
(`grep -rn supported_endpoints src/` → no output), so a route advertising both `/v1/responses` and
`/v1/messages` with `mode: null` is invisible to wire selection.

**5. The token-level instrument does not exist, but the truncation counter does.** No usage object, no
`finish_reason`, and no `stop_reason` exists in the database — verified by key-level `json_extract`, all
zero — and #190's `StopReason::MaxTokens` disposition is an `Arc<StdMutex<bool>>` in process memory,
never persisted. **But the truncation *notice* is a persisted row**: `turn_truncated` →
`normalize`'s `unique_system_chunk` → `compute_display_rows`' `agent_message_chunk` arm →
`DisplayRow { kind: "agent-text", message_key: "{stamp}:truncate:N" }` → `persist_display` → the
desktop's `INSERT … ON CONFLICT(session_id, kind, message_key)`. So the count is queryable by
`message_key`, and **ADR 0108's own Falsifier is runnable today** — the report's first read of this said
"unwritable by design" and was wrong (see §D and the correction there). Separately, all 90 sessions that
record a thinking level record `xhigh`, so the card's ranking of `xhigh`/`max` above the other levels has
no contrast class in our data, and `max` never appears at all.

**6. ADR 0108's stated premise does not hold on our route, and its key citation is misattributed.**
The engine is collect-then-execute: `run_tool_batch` has one call site, below the Length gate, and
`consume_stream` only accumulates. No tool can have executed when `Length` is detected, so the
duplicate-side-effect argument is void **here**. It is valid for codex, which dispatches on
`output_item.done` mid-stream. And the sentence ADR 0108 credits to *"the maintainer who faced the same
question in openai/codex (#38831)"* is written by `starriet9`, `author_association: NONE` — a reporter,
not a maintainer (verified via `gh api`); the string `"blindly replaying"` appears nowhere in codex's
source.

**7. The card's counter-evidence is misattributed too.** opencode #17471's *"Increasing
maxOutputTokens only postpones the same failure"* is a third-party commenter's line under a heading of
their own, not the reporter's and not a maintainer's; the maintainer closed the issue as a duplicate
without mentioning caps. The **same thread** contains the opposite result twice. The discriminator is
output **shape**: raising the cap helps when the answer or the tool JSON is long relative to the cap,
and does nothing when reasoning alone saturates it (`output: 0`).

**8. The field is unanimous on ownership, and it is not the user.** Ten of thirteen projects send a
cap; the ones that get it right read the provider's own advertised model metadata. codex is the
disfavoured holdout and pays for it with two open issues and a seven-hour stuck thread. **Nobody — zero
of eleven — reserves space proportional to the tool schemas**, so the reserve the card implies is not a
thing the field knows how to compute, and our own measurements say why (a `write` body reaches ~27k
tokens). Four projects independently converged on the rule the Anthropic clamp inverts: put a **floor
under the answer**, never `budget + 1024`.

---

## Findings

### A. What the harness can actually see when it builds the request

All engine citations are `fulcrum` at `50bed1d` / `v0.3.0`, confirmed byte-identical to the
crates.io `fulcrum-harness-0.3.0` the desktop compiles.

`AgentLoop` holds `pub model: Model`, and `catalog::Model` is ten fields in full: `id`, `provider`,
`base_url`, `api_key`, `context_window`, `cost_per_mtok_in`, `cost_per_mtok_out`, `supports_tools`,
`supports_thinking`, `thinking_levels`, `api`. **There is no output-cap field and no capabilities bag.**

The advertised tool specs are already materialised one statement away in `model_request()` (the same
value `advertised_specs()` returns), so measuring their serialised size there is mechanical. But
`tool_specs()` is a plain `vec![…]` — **no cache** (0 hits for `OnceLock` / `LazyLock` / `lazy_static` /
`thread_local` in `tool_specs.rs`) — and it is already called 1–4× per turn (`model_request`, once per
tool batch, and per `searchTools` / `describe_tool` on the codemode path).

**The thinking budget is not reachable from the loop.** `anthropic_thinking()` is private with exactly
one call site and is not re-exported; `ANTHROPIC_DEFAULT_MAX_TOKENS` is `pub` but named nowhere outside
`anthropic.rs`. On the OpenAI wires there is no numeric budget **anywhere in the engine** —
`openai.rs` sends `body["reasoning_effort"]` and `responses.rs` sends `body["reasoning"]["effort"]`, both
as verbatim strings, and `responses.rs`'s own comment says the effort *"is passed through VERBATIM"*.
So a loop-side `max_tokens` could not add the Anthropic budget, and on the live wire there is no
numeric OpenAI budget to add.

**Plumbing cost of making it non-`None` is small, with one hole.** Only **two** `ModelOptions` sites are
production (`model_request` and the summariser's call); the other ~28 are test fixtures. All three wire
builders already accept `Some` — no builder needs to change. The tests that assert the field's absence
(`request_body_omits_none_options_and_empty_tools`, `responses_request_body_omits_none_options`)
construct their own `None` and stay green. `source_lints.rs`, `boundary_pins.rs`, `lint_scan.rs` and
`childproc.rs` all have **0** references to `max_tokens`, so no pin fires.

> **The hole:** no existing test pins the loop's own `max_tokens`. Every loop test provider takes `_req`
> (`ScriptedProvider`, `FailingProvider`, `OverflowingProvider`, the cancel providers), and the one
> recording provider, `SessionRecordingProvider`, records only `req.session_id`. **A sized value would
> ship untested.** The crate's only request-recording mock is test-local to `compact.rs`.

> **The trap, recorded in-tree:** `source_lints.rs` notes that `harness/loop.rs` carries an
> item-position `#[cfg(test)]` on a `use` statement near the top of the file, so a naive
> "production region" scan stops before the loop and never sees `model_request`. Anything verifying the
> loop's value must scan the whole file with comments dropped, as the two existing `loop.rs` lints do.

**Overflow is unaffected.** `provider_overflow.rs` never sees a request (0 references to `max_tokens`);
its two callers classify error *text*, and both loop arms key off the `ContextOverflow` tier plus a
one-shot `overflow_recovered` latch. A bigger cap makes `Length` rarer and changes nothing else.

**But a "max_tokens too large" rejection has no classifier.** The fragment table has no wording for an
output-cap rejection, so an unclassified 4xx lands in `Fatal` (and an `invalid_request_error` maps
straight to `ProviderError::Fatal`) — meaning an over-large cap would **settle the turn as a fatal
error and never trigger compaction**.

**If the cap rode `Model` instead** (a new field), the break surface is far larger: 16 `Model {` literal
sites in the crate, 27 in the desktop (two of them production), and `Model` crosses the wire inside the
`start` envelope with **no serde attributes at all** — `worker_smoke.rs` documents that a camelCase
`model` block fails to decode and the Worker drops the line permissively, so the test sees zero frames.
The desktop's live-refresh path also copies only three fields today, so a new field would not reach an
already-running session.

### B. The live gateway

Target: the configured `wizards` route, a LiteLLM proxy (`system_fingerprint: radiance-2.0.0`), model
`Qwen/Qwen3.8-Flash-Next`. Key read from `~/.config/archimedes/settings.json`, never echoed. Total
spend ≈ $0.041.

| Probe | Result |
|---|---|
| `POST /v1/responses` | **200** — real `status:"incomplete"` with `incomplete_details.reason:"max_output_tokens"`, the exact shape `responses.rs` consumes |
| `GET /v1/messages` | **405** → the engine's GET probe records MISS |
| `POST /v1/messages` | **200** (parent re-verified) — the route speaks Messages for POST; the engine probes a method it does not serve |
| Cap when unset | **131,072**, reached exactly; `max_tokens` of 131072 / 200000 / 262144 all return 200 — **silently clamped, the limit is never reported** |
| `/model/info` | `max_output_tokens: 131072`, `max_tokens: 131072`, `max_input_tokens: 262144`, **`mode: null`**, `supported_endpoints: ["/v1/messages","/v1/responses"]`, `default_reasoning_effort: "xhigh"`, levels `none…xhigh` (no `max`) |
| `xhigh` + `max_tokens: 2048` | `completion_tokens: 2048`, `reasoning_tokens: 2048`, **0 visible characters** |
| Truncated tool call, **streaming** | `finish_reason:"length"` (honest) **but** `tool_calls[0].function.arguments` = 9,469 chars of **unparseable JSON**, cut mid-string |
| Truncated tool call, **non-streaming** | No `tool_calls` at all; degrades to raw `<tool_call>` **XML inside `content`** |

Two consequences for #193 (which wire is live). It resolves to **both are live and the engine's choice
is chat-completions**, because `derive_wire_for_route` keys on `mode == "responses"` alone and this
route's `mode` is `null` while its capability rides the unparsed `supported_endpoints`. There is a
**second independent gate**: even if `supported_endpoints` were parsed, the Messages rung also requires
every deployment's `route_hint` to be in `CLAUDE_ROUTE_HINTS` (`anthropic`, `bedrock`, `vertex_ai`), and
`route_hint_of("Qwen/Qwen3.8-Flash-Next")` is `"qwen"`. So Messages is unreachable for this model
regardless of the first gap.

The streaming result is new information: our engine always streams (`stream: true`), so it receives a
structurally-present `tool_calls` array with broken JSON **alongside** an honest `length`. #190's gate
handles that correctly — the call is closed as abandoned, never dispatched. The non-streaming shape
(XML in `content`) never reaches us.

### C. Measured sizes — what the cap must actually cover

Read-only snapshot, 2.37 GB, ~97% row coverage (see Gaps). Token figures are bytes ÷ 3.7, **±20%, and
lower bounds**.

| Object | p50 | p95 | p99 | max |
|---|---|---|---|---|
| `write.content` (file body) | 6,329 B ≈ 1,704 tok | 53,677 B ≈ 14,507 | 70,353 B ≈ 19,014 | 101,298 B ≈ 27,377 |
| `edit` whole args | 986 B | 5,424 | 10,238 | 48,293 |
| **One response: visible text + all tool args** | **351 B ≈ 95 tok** | 2,645 | 9,590 | **234,631 B ≈ 63,414** |

Three things this settles.

**The card understates the `write` problem:** 61% of `write` calls carry a body that alone exceeds a
1,024-token budget (901 of 1,477 at 4.0 B/tok). A 1,024-token reserve cannot host even a median `write`.

**But the cap's real adversary is prose, not `write`.** Text-only responses are ~10× larger than
tool-call responses (p50 4,492 B vs 434 B), and the single largest response measured — 234,631 B,
≈63,000 tokens — carried **zero** tool calls.

**And at `xhigh`, reasoning is 92.1% of output volume** (21,945,180 B of `agent-thought` vs 1,893,331 B
of `agent-text` across the 90 `xhigh` sessions); 70% of all assistant responses carry no visible content
at all. So both facts hold at once: reasoning dominates the cap, yet a `write`'s p99 body (≈19k tokens)
is far larger than the p99 of an entire non-reasoning response (≈2.6k). A reserve sized on the median
response would be wrong by two orders of magnitude for the `write` tail — which is precisely why nobody
in the field reserves for tools.

Sanity anchor, re-checked and it moved: **971** empty-argument calls (the prior report measured 924).
By tool: `list_skills` 355, `bash` 293, `edit` 244, `list_agents` 48, **`write` 20**, `mcp` 11. Note
`list_skills`' 355 are its *entire* population (it takes no arguments) — only the **20 `write` calls
with `{}` args** are genuinely pathological.

### D. Output tokens are unmeasurable; the truncation counter is queryable

Per-turn output tokens are **not persisted anywhere**. The only token-shaped columns in the whole schema
are `sessions.context_usage_json` (which holds only `{used, window}` — input pressure, never output) and
`sessions.cost_usd`. Top-level keys in the wire store are exactly four: `role`, `content`,
`tool_call_id`, `tool_calls`. Key-level probes for `finish_reason`, `stop_reason` and `usage` return 0 in
both tables. `messages.kind` has exactly four values — `tool-call`, `agent-thought`, `agent-text`, `user`
— so there is **no truncation-specific kind**.

**Correction, and it matters: an earlier draft of this report said the truncation count was "unwritable
by design". That is false**, and it was false because the claim was reasoned from the disposition's
in-memory stash instead of traced through the emit pipeline. The notice **is** persisted:

- `handle_truncated_turn` emits `RpcEvent::turn_truncated`;
- `EmitPipeline::run` (`harness/loop/emit.rs`) sends **every** `RpcEvent` through
  `normalize` → `compute_display_rows` → `Store::persist_display` — it is the single shared pipeline and
  has no per-variant bypass;
- `normalize`'s `turn_truncated` arm returns a `unique_system_chunk` on `{stamp}:truncate:N`, which is an
  ordinary `agent_message_chunk`;
- `compute_display_rows`' `agent_message_chunk` arm returns
  `DisplayRow { kind: "agent-text", message_key: "{stamp}:truncate:N", … }`;
- the desktop's `INSERT … ON CONFLICT(session_id, kind, message_key) DO UPDATE` writes it.

So **the truncation count is queryable by `message_key`** — `SELECT … FROM messages WHERE kind='agent-text'
AND message_key LIKE '%:truncate:%'` — and **ADR 0108's Falsifier is runnable today**, which is the whole
point of that section. What is *not* persisted is the `StopReason::MaxTokens` disposition itself (a
`truncated: Arc<StdMutex<bool>>` on `LiveWorkerSession`, mapped in `resolve_turn`, delivered live, never
written) and the provider's finish reason. The snapshot in hand showed 0 matching rows, but it was taken
~1h40m after the #190 ship commit (`2c164287`, 2026-11-15 09:53) and its newest ~3% of rows were
unreadable, so **0 is not evidence of absence here** — and the copy has since been lost to the tmpfs.

The real instrument gap is therefore narrower and sharper than the first draft claimed: **we can count
truncations, but we cannot see how many output tokens any turn was given or consumed**, so no cap change
can be evaluated against real usage. That is the gap persisting the finish reason and the usage object
would close.

Thinking level: **all 90 sessions that record one record `xhigh`**; the other 2,244 are subagents, which
inherit and do not store it. There is no `low`/`medium`/`high` population anywhere, and `max` does not
appear. **Any claim that `xhigh` is worse than `high` is unfalsifiable on this database.**

### E. Does ADR 0108's premise survive? No — and the retry is cheaper to build than expected

**The premise is void on our route.** The engine is collect-then-execute. `run_tool_batch` is called
from exactly one place, below both the Length gate and the emptiness gate, and `consume_stream`'s
`ToolCall` arm does three things: push to `acc.tool_calls`, emit a display `toolcall_end`, emit
`tool_execution_start`. No executor, gate, permission check, subagent spawn or MCP call is reachable
from it, and there is no eager/deferred mode (2 hits for `eager` in `src/harness/`, both prose in tool
descriptions). The `finish_reason` is always the last event on all three wires, after the tool flush.

**codex's argument does not transfer, because codex is the opposite shape.** It dispatches per
`output_item.done` as the stream arrives — `handle_output_item_done` returns a `tool_future` that is
`tokio::spawn`ed immediately unless `defer_tool_dispatch` is set, and `defer_tool_dispatch` is set only
for a synchronous post-hook mode. So in codex's default path a completed call has already run when
`response.incomplete` arrives. Its `RetryPolicy::Never` classification is real and shipped; its *reason*
is about a harness that is not ours.

**The Anthropic SDK's docstring constrains execution, not retrying.** `_determine_next_step_from_stop_reason`
maps `max_tokens → "stop"` with the docstring *"terminal; the turn is the final message and its tool_use
blocks must not be executed"* — in a runner that is itself collect-then-execute by default. Anthropic's
documented remedy for `max_tokens` is to re-issue with a higher cap, an action outside the runner. (The
SDK's opt-in `run_tools_eagerly` mode runs calls mid-stream and has to defer them after `max_tokens`
precisely because *"the input of the last call can be cut off"* — the rule is about execution ordering.)

**The retry mechanics already exist in-loop.** `retry_abandoned_attempt` is used by both the mid-stream
error route **and** the #64 empty-turn route, documented as *"A `Retryable` condition like any other,
merely detected AFTER the stream instead of during it, so the recovery is the mid-stream one — the same
shared budget, the same retraction, the same `Continue`."* That is exactly a Length retry's shape. The
four statements it needs — `close_announced_tool_calls`, `message_retracted`, `turn_abandoned`,
`TurnFlow::Continue` — are all reachable from inside the loop today, bounded by the shared per-turn
`RetryPolicy` (default 5 attempts, and its docblock guarantees *"a turn can never make more than
`max_attempts` model calls"*). ADR 0045's overflow recovery is the same reduction.

**What does not exist is any transcript undo**: 0 hits for `messages.pop` / `truncate` / `remove` /
`retain` in the crate, and no delete in the `Store` trait (`replace_messages` is a whole-transcript
rewrite whose only caller is compaction). The need for one is created *solely* by
`handle_truncated_turn`'s own `self.messages.push`, which sits **after** the point where a retry decision
would be taken. **Placement, not capability, is the whole issue.**

Two corrections to the shipped-fix model this card carried:

- The truncated calls are closed as abandoned with **frames only — the model never sees that sentence.**
  `close_announced_tool_calls` emits `tool_execution_end` and pushes no `role: Tool` message and appends
  nothing to `turn_tool_results`, pinned by `a_truncated_turns_tool_calls_are_closed_as_abandoned_and_never_dispatched`.
  The model reads only the persisted assistant row, which carries text and `tool_calls: None`.
- A length-keyed retry **fires only on the honest subset**. Both upstream reports are verified accurate
  today: vLLM #53269 (closed — streaming reported `tool_calls` where non-streaming reported `length`)
  and llama.cpp #30773 (open — `/v1/responses` hardcodes `"status": "completed"` and never emits
  `response.incomplete`). An unrecognised string falls to `map_finish_reason`'s catch-all, which logs and
  returns `FinishReason::Stop` — a silent clean stop.

**Cost.** `emit_cost_update` adds to `cost_acc` and emits a running total, so a retry is a second
provider charge — **doubling the money on exactly the most expensive turns**, since at `xhigh` the
re-paid ~40k tokens are almost entirely thinking the user never sees. The Anthropic wire marks
`cache_control` on system and tool blocks only (zero on conversation messages), so the conversation
prefix re-bills at full rate. The Anchor is replace-not-add, so the context bar does not inflate — but
there is no refund either. A retry that then succeeds would emit **no** truncation line at all, leaving
a clean-looking turn at double cost unless a new frame records it.

### F. Vendor constraints — "just send a big number" is illegal

Anthropic lists `max_tokens` as **required**, hard-caps synchronous output at **128,000** on every
current model (64,000 on the 4.5 generation), and an over-cap value is a **400, never a silent clamp**:
`max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for …`.

**So the existing clamp at `max` effort (128000 + 1024 = 129024) is already an illegal request.** Two
independent 400s are reachable today:

- **Way A**, on every thinking level: `thinking: {"type":"enabled"}` is rejected outright on Claude 4.7
  and later — *"Use `thinking.type.adaptive` and `output_config.effort` to control thinking behavior."*
  Neither branch of `anthropic_thinking()` (enabled, or the `_ => adaptive` fallback for an unrecognised
  level) is safe across the current fleet; the function is written against a model generation that no
  longer exists.
- **Way B**, the arithmetic: `budget + 1024` over the model ceiling at `max`.

Reachability from this desktop is real, not theoretical: the LiteLLM discovery arm synthesises thinking
levels from `supports_max_reasoning_effort`, the LiteLLM cost map sets that `true` for several current
Claude rows, and `derive_wire_for_route` returns `AnthropicMessages` for an all-Claude-adapter route.
The picker builds its options from `thinking_levels` verbatim and caps nothing.

Under **adaptive** thinking the clamp has no referent at all — *"You don't set a thinking token budget…
`max_tokens` is a hard cap on total output for the request, thinking and response text combined."* And
the documented constraint is strict-`<`, so `budget + 1` satisfies it; `+1024` is not wrong arithmetic,
it just pushes past the ceiling at the top of the range.

**Cost of a large cap differs per wire:**

- **Anthropic: free.** *"The `max_tokens` parameter does not factor into OTPM rate limit calculations,
  so there is no rate limit downside to setting a higher `max_tokens` value."*
- **OpenAI chat-completions: not free.** *"Your rate limit is calculated as the maximum of `max_tokens`
  and the estimated number of tokens based on the character count of your request."*
- **LiteLLM with budget reservation: not free.** *"When `max_tokens` or `max_completion_tokens` is
  present, LiteLLM uses that value in the estimate"* — so a big explicit cap reserves budget pre-call
  and can get the request rejected up front. The proxy also hard-caps generation for tenants whose
  smallest TPM limit is under 4096 by injecting a quarter of it.

`max_tokens` is absent from both providers' cache-invalidation tables (inference by omission, medium
confidence), but **`budget_tokens` and `effort` are not** — *"changing `budget_tokens` between requests
invalidates cache breakpoints… the budget value is rendered into the prompt."* The budget is fixed per
level, so the risk is a user toggling levels mid-conversation, which is a normal affordance here.

Two further wire-name findings: `openai.rs` writes the **deprecated** `max_tokens` on
`/v1/chat/completions`, which community reports through 2026-11-11 say 400s on o-series and current
`gpt-5*`/`gpt-6*` (`Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead`) — while
OpenAI's own reference says only "deprecated… not compatible with o-series" and its help centre calls
`max_completion_tokens` *"an alias of `max_tokens`"*. And reasoning tokens are counted against the cap
on every OpenAI surface: *"The `max_output_tokens` and `max_completion_tokens` parameters limit **all**
tokens generated by the model, including non-visible tokens."*

### G. What the field converges on

Thirteen harnesses read at source with commit-SHA permalinks.

| project | sends cap | how it handles the thinking budget | retries on length |
|---|---|---|---|
| opencode (`anomalyco`, was `sst`) | yes | **clamps the budget to half the cap** | yes — 3 consecutive |
| openai/codex | **no** (`ResponsesApiRequest` has no such field) | n/a | **no — terminal by policy** |
| vercel/ai | yes, per-provider table | **adds** `maxTokens + thinkingBudget`, then MIN vs model max | no — gates tool execution instead |
| cline | yes (synthesised) | **adds +1024 as a floor**, then MIN | not established |
| claude-code / agent-sdk | yes (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`) | must keep `budget < max_tokens`; shipped a bug getting this wrong | yes, bounded (2.1.281 fixed an *unbounded* fuse) |
| block/goose | Anthropic yes, OpenAI no | **clamps budget to `max_tokens − 1024`** | no — reports `StopReason::MaxTokens` |
| gemini-cli | **no** on the chat turn | pass-through | yes — bounded 4 |
| aider | **no** | opaque | **yes, unbounded** (prefill loop) |
| continuedev/continue | yes | **NONE — independent** (`budget 2048` against `max_tokens 2048`) | not found |
| Roo-Code (archived) | yes | clamps budget to 80% of cap | not found |
| Kilo | yes | none, pass-through | maps to `length`, unrecovered |
| pi (`earendil-works`) | yes | **add → MIN → clamp budget** | yes — one compact-and-retry |
| vscode Copilot chat | yes for Copilot, deleted for BYOK | separate min/max thinking budget fields | not established |

Five near-unanimous conclusions:

1. **Do not omit the cap.** Eight of the ten that send one derive it from **provider-advertised model
   metadata**, not a client constant (opencode and goose from `models.dev`'s `limit.output`, cline and pi
   from catalog fields, vscode from a server-supplied value). The holdouts with hardcoded tables pay for
   it — vercel/ai defaults to 4,096 for any model it does not recognise, which is the exact bug goose's
   source comment describes when it *removed* its own 4096 default.
2. **If the budget shares the cap, put a floor under the answer.** Four independent implementations
   landed on the same 1,024 (goose `MIN_ANSWER_TOKENS`, pi, cline's `GATEWAY_OUTPUT_RESERVE_TOKENS`, and
   claude-code's `budget < max_tokens` invariant); opencode chose half the cap, Roo 80%. **None clamps
   the budget and leaves the answer whatever remains** — which is exactly what `max(32768, budget + 1024)`
   does at `xhigh`.
3. **Nobody reserves against tool schema size.** Zero hits across eleven clones for any
   schema-reserve identifier. The strongest things that exist are a percentage of the *window* (opencode
   1%, codex 5%) and a fixed thinking-headroom constant. **Our reserving nothing is not unusual; our
   reserving nothing *while also* maxing the thinking budget is the unusual pair.**
4. **Truncation must be classified, not repaired-and-run.** pi's docblock names our exact hazard:
   *"Streamed tool-call arguments are finalized with a best-effort JSON salvage parser, so a truncated
   message can yield tool calls whose arguments parse and validate but are silently incomplete. None of
   them are safe to execute."* That is a direct argument against our `parse_arguments → {}` →
   `unknown_param_error` passes → policy `Allow` chain.
5. **Every auto-continuation ended up bounded, and small**: 3 (opencode), 4 (gemini-cli), 1 (pi).
   claude-code 2.1.281 is the field's scar tissue — it shipped an *unbounded* one.

**On the specific question that decides our design** — reading the provider's advertised
`max_output_tokens` — opencode, goose, cline, pi and vscode all do it. codex does not, because its
`ModelInfo` has no such field, and that omission is the subject of two open issues and caused a
seven-hour stuck thread (*"Codex sends no `max_output_tokens` … so the provider default decided where the
cut happened"*). Our engine discarding the advertised value puts it in the disfavoured company.

### H. The counter-evidence, read at source rather than summarised

**opencode #17471** is titled *"[FEATURE]: Auto-continue when model hits output token limit"*, opened
2026-03-14, **closed as a duplicate of #18108** on 2026-10-01. The quoted sentence is a third-party
commenter's, under their own heading *"Why raising the limit is not enough"*. The maintainer's entire
closing comment names nothing about caps. And **the same thread contains the opposite result twice** —
*"Raising the output cap reduced the failures"* — plus the strongest pro-claim data, which is a
measurement: raising 8192 → 16384 → 32768 produced deaths at **8,191 / 16,383 / 31,999 reasoning tokens
respectively, each with zero output**, while healthy steps in the same runs used 30–730 reasoning tokens.

**#53989 is opencode's**, titled *"server: turn silently ends when model response is truncated at max
tokens"*, closed as a duplicate of #50949. Verbatim: *"after adding … `body.max_tokens = 65536` (which
worked and hot-reloaded without restart), the model consumed the entire 65536-token budget on reasoning
(`tokens: {input: 8275, output: 0, reasoning: 65536}`) and the turn again ended silently with
`finish: "length"`."* Its diagnostic complaint is word-for-word ours: *"`outcome: "succeeded"` … users
see the agent stop with no error, and logs show nothing."* The bot's census lists seven duplicates, and
notes the open fix *"currently only handles steps with no text, no reasoning and no tool call at all, so
your reasoning-only case is worth mentioning"* — i.e. upstream has the same blind spot we do.

**Six places where raising the cap demonstrably helped:** goose's source comment removing its 4096
default (*"sending the historic 4096 default truncates non-trivial responses; omitting the field lets the
server use its own max"*); goose's own user-facing error text telling users to raise it; Roo #6936 →
PR #7673 (Moonshot truncating to 1024 regardless); codex #36180's measured before/after table
(`max_tokens: 8192` ignored, `max_output_tokens: 8192` works); the #53989 reporter's own workaround; and
the #17471 comment above.

**The discriminator, which is what to take from this:** raising the cap fixes the class where the answer
or the tool JSON is long relative to the cap, and does nothing where reasoning alone saturates it. **This
deployment, at `xhigh` with a 131k implicit default, sits in the second class.**

---

## Evidence and credibility

**Tier 1 — official source and code.** The engine at `v0.3.0`, md5/diff-verified against the published
crate; the thirteen upstream harnesses at named commits; `openai/codex` `b1573f1`;
`anthropic-sdk-python` `5139cf2`; LiteLLM `main` (`transformation.py`, `token_counter.py`,
`constants.py`, `model_prices_and_context_window.json` read directly); Anthropic and OpenAI official
docs, all read 2026-11-15.

**Tier 1 — direct measurement.** The gateway probes are the strongest evidence in this report, because
they are this deployment's actual behaviour and were re-run independently by the parent agent:
`POST /v1/messages` → 200, `GET /v1/messages` → 405, `POST /v1/responses` → 200 with a real
`incomplete_details`, and `/model/info` returning `max_output_tokens: 131072` with `mode: null` and
`supported_endpoints` populated. Also verified by the parent: `grep -rn supported_endpoints src/` prints
nothing, `derive_wire_for_route` tests `mode.as_deref() == Some("responses")` and nothing else, and
`gh api repos/openai/codex/issues/38831` returns `author_association: NONE`, `author: starriet9`.

**Tier 2 — the database.** A snapshot of the real production DB, with a known defect (below). Every
figure carries its SQL in the working notes; key-level `json_extract` was used for all key-existence
claims after the prior report recorded that a bare `LIKE '%finish_reason%'` returns hundreds of false
hits from grep output quoted inside tool results.

**Tier 3 — community, labelled as such throughout.** The verbatim Anthropic 400 text, the
`Unsupported parameter: 'max_tokens'` string, and the measured 128000/128001 boundary all come from
issue reports, not vendor prose. They are cited because they are *observed*, and where vendor docs
contradict them the contradiction is presented rather than resolved.

---

## Unresolved contradictions

| Topic | Side A | Side B |
|---|---|---|
| LiteLLM's default when `max_tokens` is omitted | Provider docs: *"litellm passes `max_tokens=4096`"* | Source on `main`: `model_info.max_output_tokens` → cost map → `DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS = 128000` |
| Does OpenAI reject `max_tokens`? | API reference: "deprecated… not compatible with o-series models" — a compatibility note, no 400 stated | Help centre calls `max_completion_tokens` *"an alias of `max_tokens`"*; community reports a hard 400 consistently through 2026-11-11 |
| Does raising the cap fix truncation? | opencode #53989 and #17471: reasoning saturates the budget, so no | goose removed its default and documented why; Roo #6936→#7673; codex #36180's measured table; two reports in #17471 itself |

The third is reconcilable and the reconciliation is the finding: **the discriminator is output shape,
not cap size.** The first two are not resolvable from available sources and are left open.

---

## Gaps

1. **A clean database snapshot is unobtainable while the desktop runs.** The app holds a write lock —
   `.backup` and `VACUUM INTO` both fail with *"database is locked"* — and the prescribed `cp` yields a
   copy that fails `PRAGMA integrity_check` with a torn tail (newest ~3% of rows unreadable). **Every
   percentile in §C and §D is a lower bound.** A clean read needs the app quit, or a backup call issued
   from inside its own process. A second trap: `/tmp` is a 16 G tmpfs with ~3 G free and one copy
   silently truncated to 1.65 GB — stage large copies on `/home`.
2. **Token↔character conversion is ±20% and uncalibrated** — no tokenizer is installed. Tool arguments
   are JSON (~3.0 B/tok) and prose is ~4.5, so a single ratio is wrong at both ends.
3. **Whether a bounded retry would actually succeed** is unknown. Nothing in either repo measures it,
   and ADR 0108's own Falsifier concedes the decision was made without field data. **But its strand side
   is now known to be countable** — the `{stamp}:truncate:N` rows are persisted (§D) — so that half of
   the comparison can be run today rather than deferred.
4. **claude-code's numeric default is unrecoverable** from the minified bundle. The env var
   `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is provably real; the 32,000 → 128,000 figures are secondary. The
   *invariant* (`budget_tokens < max_tokens`, and claude-code having shipped a violation) is from source.
5. **Whether the reasoning-saturates-with-`stop` shape is the user's original reported symptom** is
   strongly suggested by the probe and by the 212,742-character case in the prior report, and it stays
   unconfirmable for a specific reason: that shape produces **no notice at all**. It settles as an honest
   `stop`, so the persisted `{stamp}:truncate:N` row that makes truncation countable is never minted. The
   rows we *can* count are the honest-`length` subset; the `stop`-with-nothing-to-show subset leaves only
   an empty assistant row. Closing this needs the finish reason and usage object persisted.
6. **`sourcegraph/amp` and `Cursor` could not be read.** The former's repo 404s and its npm package is a
   stub with no code; the latter publishes no cap number.
7. **Whether any user actually hits tool-call truncation** (as opposed to pure-text truncation) is
   pre-fix data only. The 566 pathological `{}`-argument calls are pre-#190 population; a post-fix query
   is now possible against the truncate-notice rows, but the snapshot that would answer it was lost to
   the tmpfs and must be re-taken (with the app quit, per gap 1).

---

## The layering answer

Ranked, and this is a recommendation — the decision is the reader's.

1. **The engine owns the number, and it should read the provider's advertised value rather than invent
   one.** Every project that gets this right does exactly this; a user cannot know their model's ceiling
   or their reasoning budget's token cost. The cheapest real change is **stop discarding
   `max_output_tokens`** — one field on `catalog::Model`, one line at the LiteLLM reduction that currently
   spends it as a window fallback, and widening the desktop's live-refresh path, which copies three
   fields today.
2. **Fix the Anthropic clamp's legality first, independently of sizing.** Cap at the advertised ceiling
   with a floor under the answer, not `budget + 1024`. That alone takes `xhigh` from 1,024 tokens of room
   to roughly 88,000, and takes `max` out of 400 territory. It is engine-only, one repo.
3. **A user-visible setting is the wrong owner.** Its correct value is unknowable to the user, and on a
   LiteLLM gateway with budget reservation a too-large value has a documented throughput cost — so it is
   a footgun, not a knob. If one ever ships, it is an override layered on the derived value, never the
   source of it.
4. **A prerequisite for evaluating any of it: persist the finish reason and the usage object.** #190
   deferred both as diagnostic-only. They are not only diagnostic — truncation *events* are already
   countable (§D), but without the output-token count no cap change can be measured against real usage,
   and #193's wire question stays open.
5. **The live problem is a different card.** Reasoning saturating the budget and returning an honest
   `stop` with zero visible text is invisible to #190's Length gate, is reachable with no cap configured,
   is exactly what this deployment's configuration produces, and **no cap sizing touches it**.
