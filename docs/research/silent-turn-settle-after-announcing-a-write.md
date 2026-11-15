---
status: current
last-verified: 2026-11-14
task: tsk_c2b9389e-258f-4c1b-ba0a-c6f9af6eea06
verified-by: >-
  Six parallel research angles + parent forensics, 2026-11-14. (a) SQLite forensics against a
  READ-ONLY SNAPSHOT of this machine's real `archimedes.db` (2,333,728,768 B; 325,929 rows; 2,259
  sessions; 2026-10-04 → 2026-11-14) — the live DB was LOCKED by the running desktop, so every
  figure below comes from `sqlite3 "file:/home/daniel/arch-research-write-stall/snap.db?mode=ro"`
  (a `cp` of the live file, 2.33 GB, taken 15:12 local). That snapshot is a WORKING FILE, not a
  durable artifact: it is outside the repo and unrecoverable if deleted. It is STILL ON DISK and
  queryable as of 2026-11-14, and the figures below are pinned to it — read the Appendix preamble
  before re-taking it. (b) Engine source read at the sibling checkout
  `/home/daniel/Coding/Archimedes/fulcrum` (HEAD `7f21099` = tag `v0.2.0`), which IS the source of
  the pinned `fulcrum-harness = "0.2.0"` the desktop links — verified by md5-comparing
  `worker/client.rs`, `harness/loop.rs`, `harness/loop/turn.rs`, `harness/loop/emit.rs`,
  `debuglog.rs` against the registry copies at
  `~/.cargo/registry/src/*/fulcrum-harness-0.2.0/`: all five SAME. (c) Desktop source at
  `/home/daniel/Coding/Archimedes/archimedes`. (d) Both crash logs and both `supervisor.log` files
  in `~/.local/share/archimedes/`. (e) Nine upstream projects read at source level + vendor docs.
  Citations are BY CONTENT (function, event, struct, enum variant) not by line number, per this
  repo's locate-by-content rule; the engine's files move between the desktop and the crate.
issue: https://github.com/archimedes-codes/archimedes/issues/190
---


# The turn settles as success having dispatched nothing

**The settled question (from Phase 0):** root-cause the "the model says *I'm going to write it now*,
then nothing" symptom in our own harness, using the stored transcripts and logs as primary evidence,
and end in a defect report that `specify` can turn into a fix. The user's own characterisation of
when it happens — *"usually right after a long planning/reasoning turn — the 'I'll write it now'
message is the last thing"* — was treated as a discriminator to test, not as a premise.

---

## Executive Summary

**This is not one bug. It is one missing invariant, and there are three independent ways to violate
it.**

The invariant the turn loop never enforces: **a turn that settles as success must have either
dispatched a tool call or be a genuine final answer.** The harness has *no post-condition on a turn*.
`TurnAccumulator::finish` — the provider's own verdict on why it stopped — is read at exactly **two**
production sites in the whole engine, and neither is one of the two values that matter:

| Reader | Test | Consequence |
|---|---|---|
| `consume_stream` (`harness/loop/turn.rs`) | `acc.finish == Some(FinishReason::Error)` | fabricates a `Retryable` |
| `handle_turn` (`harness/loop.rs`) | `acc.finish == Some(FinishReason::Stop) && text.is_empty() && tool_calls.is_empty()` | the issue #64 empty-turn retry |

`FinishReason::Length` is **never** read by the turn loop. `FinishReason::ToolCalls` is never read
there either. The only place `Length` is handled anywhere is the **summariser**
(`harness/compact.rs`, which turns it into a `Retryable`) — the summariser understands truncation,
the turn does not. Everything that passes those two checks falls through to
`agent_end { will_retry: false }` → `turn_end` → `agent_settled`: **the success triple**. The symptom
is the harness labelling a broken turn a success.

**The three violators**, each VERIFIED in code and corroborated in this machine's DB:

- **A — the reasoning budget eats the output budget.** `max_tokens` is never sent by the turn loop;
  the thinking budget and the tool call share one cap; at the user's configured `xhigh` the Anthropic
  clamp leaves **1,024 tokens** for the visible text *and the entire `tool_use` block*. The provider
  cuts the reply before the call arrives → `Length` → unhandled → clean success. **Highest fit to the
  reported symptom.**
- **B — the model writes its tool call as literal `<invoke name=…>` text.** Issue #64's mechanism,
  which is guarded only on `Stop` **and** *fully* empty text — so a `Length` stop, or one visible
  character, escapes it. VERIFIED still occurring, including a persisted assistant row whose visible
  text **ends in a literal `</invoke></｜DSML｜tool_calls>` block**, both such rows being the last row
  of their session.
- **C — a truncated tool call is destroyed rather than failed.** Anthropic and chat-completions
  collapse the cut-off argument JSON to `{}` and dispatch it (→ a red card reading
  ``write: missing `path` or `content` parameter`` — a *misleading* reason); the **Responses** wire
  **drops the call entirely** (→ no card at all).

**And the reason it was undiagnosable:** the one field that would have named it — the finish reason —
is dropped at persist, collapsed again at the desktop's wire boundary, and there is **no `RpcEvent`
variant that means "this turn failed."** `StopReason::MaxTokens` exists, is rendered by the footer,
and is **asserted by a frontend test** — with **zero construction sites** in the crate. The wire was
built, the UI was built, nothing sends it.

**The evidence for "you could never have diagnosed this yourself" is four independent failures**
(§5), the sharpest being that `supervisor.log` is **99.95% verbatim conversation** and rotates at
5 MB ≈ **71 seconds of streaming** — the diagnostics are evicted by the conversation — and the
attention alert fires for this exact turn and says **"finished — waiting for you."**

---

## Findings

### 1. The signal exists and is thrown away — four times (all VERIFIED)

**1a. Dropped at persist, in a struct field list.** `ChatMessage` (`provider_types.rs`) carries
`role`, `content`, `tool_call_id`, `tool_calls` — **no field for the finish reason**. In `handle_turn`
the assistant row is constructed with `acc.finish` in scope on the preceding line and it is simply not
passed. `persist_transcript_message` then serialises that struct. DB proof, whole population:

```sql
-- 0 rows carry a provider disposition, in either table
select
 (select count(*) from native_messages where json_extract(content_json,'$.finish_reason') is not null),
 (select count(*) from native_messages where json_extract(content_json,'$.stop_reason')  is not null),
 (select count(*) from messages        where json_extract(payload_json,'$.finish_reason') is not null);
-- 0|0|0
```

> **Instrument trap:** a naive `content_json LIKE '%finish_reason%'` returns **669** hits. All of them
> are grep output *inside `tool` results* — a `bash` result quoting `pub enum FinishReason`. **Key-level
> `json_extract` is the only sound test.** This is the same "a grep count includes prose that names the
> pattern" hazard `AGENTS.md` records for `#[cfg(unix)]`.

**1b. Collapsed again at the desktop's wire boundary.** `agent/session/router.rs`'s `resolve_turn`
ends with `if cancelled { StopReason::Cancelled } else { StopReason::EndTurn }`. A 4-way provider
signal is reduced to a boolean. `StopReason::` construction sites across the whole crate (production,
tests excluded): `Refusal` ×1, `Cancelled` ×4, `EndTurn` ×2 — **`MaxTokens` ×0, `MaxTurnRequests` ×0.**

**1c. The receiving end is already built, already tested, and dead.** `StopReason::MaxTokens` is
declared in `agent/session/mod.rs`; `chat/TranscriptFooter.tsx` renders `Turn ended: {stopReason}`;
and `TranscriptFooter.test.tsx` **asserts the string `"Turn ended: max_tokens"`**. So wiring
`FinishReason::Length → StopReason::MaxTokens` is a two-line change at both ends that converts the
invisible case into a visible one, and the test that proves it already exists. **Corrected at ship — the
sentence that followed this one was wrong.** It claimed `transcriptFooterIsEmpty` "must learn not to
suppress this one". Its actual predicate is
`(props.inTurn || !props.stopReason || props.stopReason === "end_turn")`, which suppresses `end_turn` and
NOTHING ELSE: `max_tokens` already rendered, and the whole TS chain
`send_prompt` → `turnCompleted` → `stopReasons` → `ChatStream` → `MessageList` → `TranscriptFooter` was
built and tested before this work existed. **No TypeScript change was needed** — the desktop's entire half
was one Rust construction site. (ADR 0108's 2026-11-15 amendment carries the measurement.)

**1d. There is no frame that expresses failure.** `settle_error` and `settle_cancelled` are
**byte-identical in the frames they emit** (`close_announced_tool_calls` + `turn_abandoned` +
`turn_end { message: Null }` + `agent_settled`). `normalize` has **no arm** for `turn_end`, `agent_end`
or `agent_settled` — all three fall into the catch-all `_ => Vec::new()`, and `compute_display_rows`
likewise. **`settle_error` therefore emits no error frame at all.** The `RpcEvent` enum has no
`turn_error` / `agent_error` variant. The only "something went wrong" frames are:

- `auto_retry_end { success: false }` → `normalize` renders it via `system_chunk` as the prose line
  **"Retry failed"**, which reaches the renderer as an ordinary `agent_message_chunk` and so renders
  through `MessageBubble`/`AgentMarkdown` **in the same band as a real answer**. Its `final_error`
  payload — the actual provider sentence — is read by **0 sites** in `src/`.
- `compaction_end { error_message }` → a collapsed `tool_call_update` at `status: "failed"` whose
  actionable sentence lives in a hover **tooltip** (`failureText` reads `details.error` first) and
  whose body is one click away with **no auto-open**.

The only two *unmissable* error surfaces in the desktop — `IpcErrorLine` (`role="alert"`, from an
invoke rejection) and `SessionStalledBanner` (`role="alert"`, from `session-stalled`) — are **both
unreachable from `settle_error`**.

---

### 2. Root cause A — the reasoning budget consumes the tool call (highest fit)

**VERIFIED chain:**

1. `model_request()` (`harness/loop.rs`) builds `ModelOptions { max_tokens: None, … }`. **Nothing** in
   the engine sets it to `Some` except the summariser's own call (`compact.rs`, from
   `compactor.summary_output_cap()`).
2. `anthropic.rs` documents `ANTHROPIC_DEFAULT_MAX_TOKENS: u32 = 32768` and applies it on `None`;
   `openai.rs` and `responses.rs` both **omit the field entirely** when `None`, leaving it at whatever
   the LiteLLM gateway defaults to.
3. Anthropic's reasoning clamp is `max_tokens = max(32768, budget + 1024)` (`anthropic.rs`, in the
   request-body builder, with the comment *"The API requires `max_tokens > budget_tokens` — clamp UP
   over the caller's value"*). The mapping and the resulting arithmetic:

| `reasoning_effort` | `budget_tokens` | sent `max_tokens` | **room left for text + the whole `tool_use` block** |
|---|---|---|---|
| `low` | 4,096 | 32,768 (default wins) | 28,672 |
| `medium` | 10,000 | 32,768 | 22,768 |
| `high` | 20,000 | 32,768 | 12,768 |
| **`xhigh`** | 40,000 | **41,024 (clamp wins)** | **1,024** |
| `max` | 128,000 | 129,024 | 1,024 |
| none / unknown | `{"type":"adaptive"}`, no budget | 32,768 | 32,768 |

Arithmetic cross-checked against the wire's own test (`anthropic_request_body_max_tokens_default_and_clamp`:
`req(None, Some("max"))["max_tokens"] == 129024`, `req(Some(64), Some("low")) == 5120`,
`req(None, None) == ANTHROPIC_DEFAULT_MAX_TOKENS`).

The clamp is a **floor to satisfy an API constraint, not headroom for a tool call** — there is no term
anywhere that reserves space proportional to the tool schemas. **Raising effort from `low` to `high`
reduces the room for the call by 15,904 tokens; at `xhigh`/`max` that room is pinned at ~1,024.** A
`write` carrying a file body cannot fit in 1,024 tokens. So raising reasoning effort to get *better*
tool-calling produces the opposite.

**This deployment is configured at the worst point on that table.** `~/.config/archimedes/settings.json`:
`defaultThinkingLevel = "xhigh"`, and `defaultThinkingLevels` pins `xhigh` for
`wizards/Qwen/Qwen3.8-Flash-Next` — which is `defaultModel`.

**Vendor docs make this documented behaviour, not a defect in the provider:**

- Anthropic, *Thinking: steering and cost* — *"`max_tokens` is a hard cap on total output for the
  request, **thinking and response text combined**… A `max_tokens` sized for a response with no
  thinking is often too small once Claude starts thinking on hard requests. **At `high` effort and
  above, Claude might think extensively and is more likely to exhaust the budget.**"*
- Anthropic, *Thinking troubleshooting*, section *"The response stops with `stop_reason: "max_tokens"`"*
  — *"thinking tokens count toward `max_tokens`, so a long thinking pass can consume the budget before
  the text response completes."*
- OpenAI, *Reasoning* guide — `max_output_tokens` limits tokens *"including reasoning tokens, visible
  output tokens, and non-visible formatting tokens"*, and an `incomplete` / `max_output_tokens` stop
  *"might occur **before any visible output tokens are produced**, meaning you could incur costs for
  input and reasoning tokens without receiving a visible response."* Recommends reserving ≥25,000.

**Forensic corroboration in this machine's DB.** Issue #64's fix is commit `b3d8f5c` (2026-10-20
09:34, *"a 'stop' with no text and no tool call is retried, not persisted (#66)"*). Exactly **3** empty
assistant rows exist after that epoch, all three session-terminal — and for each, the reasoning volume
streamed in the two minutes before:

| session | seq | when | reasoning chars in the prior 2 min |
|---|---|---|---|
| `arch_0aa5fb89…` | 144 | 2026-10-20 09:59 | 1,780 |
| `arch_185ef550…` | 267 | 2026-10-23 06:16 | **212,742** |
| `arch_0b102ef2…` | 206 | 2026-11-12 08:32 | 5,694 |

The 212,742-character case is the reported shape exactly: an enormous reasoning pass, then a turn that
settled having produced nothing the model can remember. Across the wider set, **6 of 9** empty rows are
pre-fix and **3** post-fix (0.03% → 0.002% of assistant rows) — the #64 fix measurably worked, and
measurably did not close the class.

---

### 3. Root cause B — the tool call written as text, still alive

Issue #64's guard requires **`finish == Stop` AND empty text AND no tool calls**. Two escape hatches
exist, and both leave the turn looking like a clean answer:

- `finish == Length` (root cause A) — the guard is not eligible at all.
- **One character of visible text** — `acc.text.is_empty()` is false, so the guard is not eligible.

The mechanism #64 describes — the model emitting its call as literal `<invoke name="…">` **into the
reasoning channel**, so the API answers `content: ""` / `tool_calls: null` and the stream reads as a
clean stop — **is still happening in both channels.** VERIFIED in this DB:

- `agent-thought` rows containing a literal
  `<invoke name="bash">\n<parameter name="command">cd … && git push --dry-run …</parameter>\n</invoke>`
  — in session `arch_789c677f…` at `1792334525725`, **11 ms before** that session's empty assistant row
  at `seq 209` (`1792334525736`). The call is fully recoverable from the display table.
- **A persisted assistant row whose visible text ends in a literal `</invoke></｜DSML｜tool_calls>`
  block.** Census: 2 assistant rows have tool-call markup in the text channel with `tool_calls` absent;
  **2 of 2 are the last row of their session** (2026-10-27, 2026-11-02). Marker dialects present:
  `<invoke name=` ×6, `<parameter name=` ×1, `｜DSML｜tool_calls` ×1 — the last is a **DeepSeek-flavoured**
  dialect, i.e. this is not one model's quirk.
- **28** final assistant rows that end in an intent-to-write sentence are **4,000–65,000 characters**
  long (bucket census of terminal text-only rows: 751 at 1–4k, 974 at 4–16k, 265 at 16–65k, 3 above
  65k; median length of a session's final assistant row is **2,406** vs **82** mid-session — a 29×
  ratio). **The long final message is emphatically the reported shape.**

> **A correction to the record, and it is load-bearing.** Two engine comments —
> `handle_empty_turn`'s docblock and the comment above the empty-turn gate in `handle_turn` — assert
> the reasoning text *"is streamed to the UI but is NEVER persisted"* and that the `eprintln` is *"the
> only trace this turn ever leaves behind."* **Both are false.** 126,713 `agent-thought` display rows
> hold the accumulated reasoning, and **12 contain a literal `<invoke` block**. `thinking_delta` →
> `agent_thought_chunk` (`normalize`) → `compute_display_rows` → `messages.kind='agent-thought'`. The
> trace the code says does not exist has been sitting in the `messages` table the whole time. This is
> not pedantry: a comment claiming there is nothing to look at is what stops the next reader looking.

---

### 4. Root cause C — a truncated tool call is destroyed, not failed (wire-dependent)

`parse_arguments` (`harness/provider/openai.rs`) is the **single** argument parser shared by all three
wires (imported by `anthropic.rs` and `responses.rs`). Both of its branches collapse to an empty
object: an empty fragment returns `{}` silently; an unparseable fragment returns `{}` with one
`eprintln!("harness: malformed tool-call arguments — using {}: …")`. So **a cut-off call is
indistinguishable downstream from a call the model legitimately sent with no arguments**, except for
one stderr line.

| Wire | A `tool_use`/`function_call` cut off by the length stop | What the user sees |
|---|---|---|
| **Anthropic Messages** | `flush_tool_calls` runs on **every** `stop_reason` including `max_tokens`, and its only drop condition is `acc.name == None` — but `name` arrives at `content_block_start`, *before* any `input_json_delta`. So the call is **not** dropped; its truncated JSON → `{}` | Red **Failed** card: ``write: missing `path` or `content` parameter`` — a *misleading* reason |
| **OpenAI chat-completions** | identical (`flush` on any `finish_reason` incl. `"length"`) | identical |
| **OpenAI Responses** | `terminated = true` is set **before** `Done(Length)` in the `response.incomplete` arm, and that flag gates out the stream-end `flush_tool_calls`. The `incomplete` arm has no flush of its own → **the call vanishes** | **Nothing. Not even a card.** |

The Responses behaviour is pinned by that wire's own tests — `responses_sse_incomplete_max_output_tokens`
and `responses_sse_cost_rides_the_incomplete_terminal` both assert the event list is exactly
`[Usage, Done(Length)]`, no `ToolCall`, no `ToolCallDelta`. **There is no test for `incomplete` + a
partially-streamed `function_call`** — the case in question.

**The `{}` path is a chain of individually-defensible links that compose into a silent failure**
(each VERIFIED):

1. truncated argument JSON → `{}` (`parse_arguments`);
2. `unknown_param_error` (`harness/tool_specs.rs`) **passes** — it inspects only *extraneous* keys,
   `{}` has none, and its own docblock says `required` is deliberately irrelevant;
3. the policy gate returns **`Allow`** — `policy_verdict` for a `Write`-direction tool does
   `arguments.get("path").and_then(str).else → Some(Decision::Allow)`, so with no `path` there is
   nothing to judge and **no prompt is raised**;
4. the executor refuses: ``write: missing `path` or `content` parameter``, `is_error: true`.

**The model** receives that sentence as a `role: "tool"` message and *may* retry. **The user** sees a
card flip to `Failed` with that sentence as its output — **no mention of truncation, `max_tokens`, or
a cut-off stream anywhere.**

**VERIFIED in this DB** — 924 tool-call entries carry `{}` arguments; **566 are pathological**
(argument-bearing tools: `edit` 244, `bash` 292, `write` 19, `mcp` 11) and 358 are legitimate
(`list_skills` 326, `list_agents` 32 — those take no arguments). **All 924 settled with a result**, so
these executed and were rejected, not abandoned. And it is **bursty, not systemic**: a flat 0.0–0.6%
daily baseline with a two-day spike (2026-10-29: 4.3%; 2026-10-30: 1.9%) driven by **two subagent
sessions contributing 265 of 566 (47%)** — 303 and 242 empty-argument calls respectively. Excluding
those two sessions the population rate is ~0.2%. A burst of 303 consecutive `{}` calls reads as a
degenerate provider/gateway loop, not random truncation (INFERRED — the DB cannot separate "gateway
truncated the args" from "model sent empty args").

**Which wire is actually live here** — tool-call id dialects across all 176,716 calls:

| dialect | count | attribution |
|---|---|---|
| `call_…` | 164,581 | OpenAI-shaped (`call_` is produced by the **upstream backend** and copied verbatim by **both** OpenAI readers) |
| `chatcmpl-tool-…` | 12,045 | LiteLLM chat-completions |
| `toolu_…` | **0** | Anthropic — **this deployment never uses the Messages wire** |
| `fc_…` | **0** | Responses-API-native ids |

So the Anthropic arithmetic in §2 is **latent** for this deployment, and both live dialects are
OpenAI-shaped. **`call_` cannot be attributed to a reader** — see Gaps: this is the one open question
that changes root cause C's severity.

---

### 5. Why this could never have been diagnosed from a user's artifacts (four independent failures)

**5a. Worker stderr IS captured — and unreachable.** The premise "worker stderr is discarded" is
**out of date**: since `6e88058` (2026-10-11) `WorkerHandle::spawn` pipes stderr and a dedicated
`spawn_pipe_reader` drain forwards every line as `debuglog::log_truncated("worker-stderr:", …)`; the
docblock names *"the harness's `eprintln!`s"* as the motivation and `src-tauri/tests/worker_stderr.rs`
pins it. But `debuglog::log` returns at its **first statement** unless `ARCHIMEDES_DEBUG=1` was set
**before launch** (read once at startup; the README says setting it while running does nothing), and
the Worker process never calls `init_from_env` by design. So the honest status of all **9**
`eprintln!("harness: …")` sites is: **the line exists, is written, and is unreachable by a user.**

**5b. The log covers 0.3% of the history and rotates in 71 seconds.** Measured on the two files in
`~/.local/share/archimedes/`:

| phrase | `supervisor.log` | `supervisor.log.old` |
|---|---|---|
| `harness:` / `worker-stderr:` / `empty model turn` / `malformed tool-call` / `mid-stream model error` / `model call failed` / `unknown finish_reason` | **0** | **0** |

(The 10 lines matching a bare `grep -F harness` are inside JSON *payloads* — model output text
containing the word. Not log lines.) The two files span **2026-10-12 14:28 → 17:07** — **2.6 hours of
a 41-day, 2,259-session history**. Byte accounting: 7,809,884 of 7,813,687 bytes are frame lines
(**99.95%**) — verbatim conversation token deltas; `supervisor.log.old` moved 5,243,384 B over 71
distinct active seconds = **72.1 KiB per streaming second**, so the 5 MB rotation cap holds ≈ **71
seconds of a streaming turn**. A user who reproduces at 10:00 and opens the log at 10:02 has lost it,
and lost it to token deltas, not to diagnostics. **The diagnostics are evicted by the conversation** —
which is also the same content the README flags as a privacy liability. The instrument is demonstrably
live (the `attention:` timeline is fully present, 702 lines in `.old`); only the coverage is missing.

**5c. No frame expresses failure** (§1d).

**5d. The alert fires and lies.** `attentionCandidates` (`src/lib/attention.ts`) raises a `settled`
trigger on the `inTurn: true → false` edge, gated only by `stalled !== true` and
`stopReasons !== "cancelled"`. A turn that settled clean having dispatched nothing satisfies all three,
so the alert arms and delivers — and `attentionAlertText` composes the body
**`"<label> finished — waiting for you"`**. Nothing in `AttentionSnapshot` (`candidateOrder`,
`settledWatch`, `inTurn`, `stopReasons`, `waitingIds`, `stalled`) can distinguish "finished" from
"announced and did nothing", because the only field that could never reaches it.

---

### 6. The industry answer is settled on half the question

**"A length-truncated turn never executes tools" is near-universal.** Read at source:

| Project | Behaviour |
|---|---|
| **Anthropic SDK Tool Runner** (py + ts) | `_STOP_REASON_STEPS` / `BetaToolRunner` map `max_tokens → "stop"`, whose docstring reads *"terminal; the turn is the final message and its tool_use blocks **must not be executed**"* — with a `checkNever()` exhaustiveness guard |
| **vercel/ai** | `isToolExecutionAllowedFinishReason(f) => f === 'stop' \|\| f === 'tool-calls'` — the cleanest one-line rule in the ecosystem |
| **earendil-works/pi** | `stopReason === "length"` → fail **every** tool call in the message with error results, execute none, continue the loop (PR #6285) |
| **anomalyco/opencode** (≡ `sst/opencode`, a 301) | `pendingCalls()` returns `[]` on `length`; then injects a synthetic user message and continues, **bounded at 3 consecutive `length` turns** |
| **openai/codex** | `ResponseIncomplete` is **`RetryPolicy::Never`**; `partial_output` items are traced then `truncate`d — **never dispatched** |
| **Aider** | raises `FinishReasonLength` mid-stream; prefills with its own partial to continue, else a token-budget report + a synthetic history note |
| **cline** | skips any call whose args were repaired/failed/empty on a max-tokens finish; complete calls in the same turn still run |
| **goose** | surfaces an open/parse-failing block as a **failed tool request** with `truncation_error_message` + `output_token_limit_reached` — but PR #10831's behaviour **silently regressed on the Bedrock path** (#11838) |
| **continuedev/continue**, **Roo Code** | **negative result / unverifiable** — no `finish_reason === "length"` handling found in `continue`; Roo is archived 2026-05-15, only downstream allegations |

**Where implementations diverge is *what instead*, and every project that added auto-continuation
added a bounded fuse.** The double-execution hazard is why codex chose terminal-and-non-retryable —
maintainer quote (openai/codex #38831): *"**Automatic continuation is a separate policy question
because blindly replaying a partially completed response can duplicate tool side effects.**"*

**Our symptom is reported verbatim elsewhere**, which is the strongest external evidence that the
mechanism is real and generic:

- opencode **#53989** — *"turn silently ends… `finish: "length"`… the session goes idle with
  `outcome: "succeeded"` while the agent is mid-task… With always-reasoning models, the entire
  generation budget can be consumed by reasoning tokens alone (`output: 0`)."* Reproduced 5×/2
  sessions, **including after raising the cap to 65536** (`output: 0, reasoning: 65536`).
- opencode **#40146** / **#52490** — *"no text and no tool call, and `finish: "length"`. The task
  completed with status `ok` and empty output. **From the caller's side that is indistinguishable from
  a subagent that had nothing to say.**"*
- claude-code **#27281** — *"Agent stuck in infinite loop — repeated 'let me write the document'
  without executing."*
- pi **#10799** — *"Output-limit stop settles silently… The user comes back to half a document and no
  way to know it happened."*
- goose **#11838** — *"ACP `session/prompt` reports `end_turn` for the truncated turn… a tool call cut
  off mid-arguments is dropped silently… so the agent sees a turn with no tool request and **finishes
  as if the model was done**."* This is our bug, verbatim, in another codebase.
- opencode **#18108** — *"truncation produces varying incomplete JSON each attempt so doom loop is
  never detected."*

**Two findings that matter specifically for a LiteLLM-fronted setup:** **vLLM #53269** (greedy
decoding, `temperature=0`, fixed seed: the **streaming** path reported `tool_calls` — a *success* value
— where non-streaming reported `length`, root-caused to `if tools_streamed[i] and not
tool_choice_function_name: finish_reason_ = "tool_calls"`) and **llama.cpp #30773** (`/v1/responses`
*"reports a truncated tool call as **completed** and never emits `function_call_arguments.done`"*;
`incomplete` appears nowhere in the server). **A gateway can rewrite the truncation signal into a
success value** — an argument for detecting the *turn shape* rather than trusting `finish_reason` alone.

**On repair-and-run:** the best-written sources reject executing a repaired call. pi's maintainer note
is the key insight — *"Streamed tool-call arguments are finalized with a best-effort salvage parser, so
a truncated message can yield tool calls whose arguments **parse and validate but are silently
incomplete**"* — and cline's PR #14909 documents `jsonrepair` closing `{"commands":["cd build",` into a
plausible `{"commands":["cd build"]}`: *"A validator can't help here: the repaired call is well-formed
and non-empty."* Anthropic's own docs offer two distinct remedies and **never endorse executing a
repaired truncation**: `handling-stop-reasons` → *"retry the request with a higher `max_tokens` value"*;
*fine-grained tool streaming* → return `tool_result` with `is_error: true` and `{"INVALID_JSON": …}`.

**Anthropic also prescribes the user-facing half we lack** (`handling-stop-reasons`, *"Handle truncated
responses gracefully"*): *"append a notice so the reader knows the output is incomplete."*

---

### 7. Adjacent defects found (real, separate, each deserves its own card)

**7a. A `write` that was announced, never dispatched, and never reported — and the model asserted
success.** Session `arch_a2f7a58c-ecc8-4fdd-bbce-da13d9e301e1`, 2026-11-06 19:42:33,
`cwd = …/Archimedes/archimedes`:

- a `write` display row at `status: 'in_progress'`, **never settled**, carrying the **full 19,798-byte**
  markdown in `rawInput.content` — so the arguments were **complete**, i.e. **not** the truncation path;
- **no `tool`-role row in `native_messages` for that call id at all**;
- the model's **next** assistant turn asserting *"Plan written to
  `docs/roadmap/ui-and-console-fixes-task04-windows-console-doc-corrections.md`"* — and **that file does
  not exist on disk**.

The discriminator is structural and reusable: a `tool_call` **display** row is written from
`tool_execution_start` (in `consume_stream`), while the `tool`-role **transcript** row is written only
if `run_tool_batch` actually ran the call. **Display row without transcript row = announced and never
dispatched.** Population: of 184,993 `tool-call` display rows, **1,067 are still `in_progress`, and
1,041 of those have no matching tool result across 355 sessions** (3 `write`, 28 `edit`; the rest
`bash`/`manage_todo_list`). *Arguably a worse defect than the reported one, and separately reproducible.*

**7b. An open tool card on a **stalled** session shimmers forever.** The only thing that leaves
`in_progress` is `tool_execution_end`; `finalizeSessionMessages` (which downgrades `pending` → `failed`)
is wired **only** to `handleSessionClosed`, and a crash path explicitly emits no `session-closed`. So
after a Worker death every open card keeps its `animated-gradient-text` shimmer indefinitely. That is
literally "I said I'd write it and nothing happened."

**7c. A Worker whose loop task returns `Ok(())` produces no `Exited` at all** — the crash-watch's `Ok`
arm is a no-op, so `unexpected_exit` never fires: **spinner locked, composer locked, no banner,
indefinitely.** No test drives this arm.

**7d. The pump's `Lagged` arm silently drops frames** off the 256-slot broadcast ring (`log`, then
`continue`). Already documented as a residual in `fulcrum/docs/features/abandoned-tool-rows.md` §5 and
in `docs/roadmap/compaction-recovery-hardening-follow-ups.md` §2 — **cite it, do not re-file it.** Note
the ring is a **count** bound, not a size bound: a large result uses the same one slot as a small one.

**7e. The Stalled banner names no reason.** `handle_crash(session_id, code, pid)` ends with
`let _ = code;`, `StalledInfo` is `{ at, crash_log }`, and the `Exited` router arm discards the code too.
Separately, `WorkerError` is routed to **nothing UI-facing** ("bookkeeping. Nothing UI-facing to do
here"), so a `worker_panic` frame is dead on arrival and the user depends entirely on the exit-code path.

**7f. Neither crash log is a tool panic.** `crash-…-worker-2074284.log` is
`failed printing to stderr: Broken pipe` inside `config::load_settings` during **loop construction** —
before any tool can exist. `crash-…-supervisor-227501.log` is `Failed to setup app: … sqlite error:
database is locked` — a Supervisor that died in setup takes its transcripts with it, which is a
plausible contributor to the broader symptom class.

**7g. `edit` has no uniqueness check** — it does a first-occurrence `replacen(…, 1)` and reports
`Edited <path>`, so a non-unique `old_text` silently understates the edit. Pinned by a test that
*characterises* the hazard (`edit_ignores_a_misspelled_replace_all_and_understates_the_write`: *"the
executor reports SUCCESS"*). A silent **wrong** result, not a silent **no** result — out of scope here.

**7h. A stale doc to correct:** `fulcrum/docs/features/abandoned-tool-rows.md` §6 says *"no desktop tag
contains the cure"*. **False as of desktop `v0.13.0`**, which pins `fulcrum-harness = "0.2.0"`; verified
`git merge-base --is-ancestor <the close_announced_tool_calls commit> v0.2.0` → true.

---

## Evidence

**Local, primary (highest credibility — this is the system under investigation):**

- `/home/daniel/arch-research-write-stall/snap.db` — read-only `cp` of the live 2.33 GB
  `~/.local/share/archimedes/archimedes.db`. **A working file outside the repo; not durable** — but
  present and queryable, dated and hashed in the Appendix preamble. Every figure here is reproducible
  with `sqlite3 "file:…/snap.db?mode=ro"` and the queries in the Appendix.
- Engine `/home/daniel/Coding/Archimedes/fulcrum` @ `7f21099` (= tag `v0.2.0`), md5-verified identical
  to the vendored `fulcrum-harness-0.2.0` for all five files the argument turns on.
- Desktop `/home/daniel/Coding/Archimedes/archimedes` @ `60033785`-era working tree.
- `~/.config/archimedes/settings.json` (`defaultModel`, `defaultThinkingLevel`, `defaultThinkingLevels`).
- `~/.local/share/archimedes/{supervisor.log,supervisor.log.old,crash-*.log}`.

**Upstream (credibility order: vendor docs > project source > maintainer-authored issue/PR text >
third-party issue):**

- Anthropic: `platform.claude.com/docs/en/build-with-claude/handling-stop-reasons` (the
  **"Incomplete tool use blocks"** accordion + *"append a notice so the reader knows"*);
  `…/streaming`; `…/fine-grained-tool-streaming`; `…/thinking-steering-and-cost`;
  `…/thinking-troubleshooting`.
- OpenAI: `developers.openai.com/api/docs/guides/reasoning`; `…/api/reference/resources/responses/methods/create`
  (`incomplete_details.reason` enum; `FunctionCall.status` ∈ `in_progress|completed|incomplete`).
  **Negative result:** the function-calling guide contains **zero** occurrences of `truncat`,
  `incomplete`, `max_output_tokens`, or `finish_reason`.
- Source reads at HEAD: `openai/codex` @ `b1573f1`, `anthropics/anthropic-sdk-python` @ `5139cf2`,
  `anthropics/anthropic-sdk-typescript` @ `5907830`, `anomalyco/opencode`, `Aider-AI/aider`,
  `earendil-works/pi` @ `8636e21`, `vercel/ai`, `openai/openai-python`, `continuedev/continue`,
  `aaif-goose/goose`.
- Issues/PRs: opencode #53989 #18108 #40146 #52490 #17471 · claude-code #27281 #73372 #78460 ·
  pi #6285 #10799 #7540 · cline #14909 #14872 #14892 #14378 #9920 · goose #10831 #11838 ·
  openai/codex #38831 · vercel/ai #21353 · vLLM #53269 · llama.cpp #30773 ·
  CLIProxyAPI #5836 · google/adk-python #7558 · openclaw #148257 #156342 #45049 ·
  strands-agents #5740 #3675 · HarperFast/harper #3039 · Umbraco.AI #422 · rust-genai #340 · mezmo/rig #19.
- Academic: Cemri et al., *"Why Do Multi-Agent LLM Systems Fail?"*, arXiv:2503.13657 — `FM-3.1
  Premature termination`.

**Claim grades used below:** **VERIFIED** = read in source, measured by a command in the Appendix, or
produced by the named CTE in the referenced angle report (the four figures that rest on an angle
report's CTE rather than a command printed here are the 212,742-char reasoning volume, the 6-of-9
pre-fix / 3 post-fix split, the 29× median-length ratio, and the 72.1 KiB/s + 99.95% log figures).
**INFERRED** = reasoned from multiple verified facts, stated as such.

---

## Unresolved contradictions

1. **"Worker stderr is discarded" vs "Worker stderr is captured."** Both researchers were half right,
   and the disagreement is not about code. It **is** piped and drained into `debuglog` (VERIFIED,
   byte-identical in the vendored crate), and it **is** unreachable (VERIFIED, `ARCHIMEDES_DEBUG` is
   off by default, read once at startup, and the Worker never initialises the logger). *"The log line
   exists"* and *"a user can reach it"* are separated by a startup flag, a 71-second rotation, and a
   knowledge requirement — three independent failures, only one of which is about code.
2. **The engine's docblocks say the reasoning is never persisted; the DB holds 126,713 rows of it.**
   Measured reality wins; the comment is now an active hazard (§3).
3. **"Issue #64 is fixed" vs 3 post-fix empty assistant rows.** Both true — #64 closed the `Stop` route
   only. `Length` reproduces the identical 33-byte row **and removes** the `eprintln` #64 called
   mandatory, so the post-fix case is *strictly worse* to diagnose than the pre-fix one. I cannot tell
   which route those 3 rows took — **and that inability is itself the finding.**
4. **`max_tokens` omission helps vs hurts.** Omitting it lets a generous gateway default apply (which
   may be why this is intermittent), while the Anthropic path applies a fixed 32,768 that the thinking
   budget then dominates. There is no configuration a user can pick that raises the non-thinking share
   above the default. Which effect dominates on `llm.wizards.town` is unmeasured.

---

## Gaps

1. **Which OpenAI-shaped wire is live — undecidable from the DB, and it changes root cause C's
   severity.** `call_` ids are produced by the **upstream backend** and copied verbatim by **both**
   OpenAI readers, so they cannot attribute traffic to `responses.rs` vs `openai.rs`. This is the
   difference between *"a misleading red card"* and *"the model's tool call silently vanishes with no
   card at all."* Resolvable in one `curl` against the gateway, or one log line naming the chosen
   `WireApi`.
2. **The true rate of the reported symptom is structurally unmeasurable.** It leaves a row only if the
   retry budget was spent **and** a failure rendered. Neither happens. **The absence of evidence is the
   defect** — and the fix that removes this gap (persisting the finish reason) is also the cheapest one.
3. **Model/gateway attribution covers 4% of sessions.** `sessions.capabilities_json` carries the model
   for `is_subagent = 0` only — **80 of 80** interactive sessions have it, **0 of 2,179** subagent
   sessions do (their value is the literal string `null`), and there is **no parent-session column**.
   So the "126 of 128 re-prompts → `Qwen3.8-Flash-Next`" concentration is an artifact of every
   interactive session using that model, **not** evidence it is 63× worse. Any cross-model rate
   comparison from this DB is unsound.
4. **No log covers any incident window.** `ARCHIMEDES_DEBUG` was unset for essentially all of the
   41-day history, so no file was created for those sessions at all.
5. **No canonical name for this failure mode.** The nearest formal term is MAST's `FM-3.1 Premature
   termination`, which is about agent *intent*, not provider truncation. Practitioner vocabulary is
   "silent truncation", "silent stop", "false completion". **Do not claim a standard term exists.**
6. **Whether the DB snapshot's `messages` table can be joined to transcript turns.** It has no turn id,
   so §3's "sessions ending on an intent" counts approximate a turn by interleaving with `tool-call`
   ids. 23 sessions end their visible stream on a write-intent after the last tool call; that figure is
   per-session, not per-turn.
7. **Claude Code's internal handling is issue-tier only** — closed source, no source read possible.

---

## What the evidence supports as fixes (not a decision — `specify` owns that)

Ranked by cost-to-coverage. Items 1 and 2 are near-free and **both ends already exist**.

1. **Stop accepting a `Length` turn as a clean stop** in `handle_turn`, and map
   `FinishReason::Length → StopReason::MaxTokens`. Two lines at each end; the footer test already
   asserts the string. Converts the highest-fit invisible case into a visible one. **SHIPPED** as
   issue #190 / PR #194 / ADR 0108 — and one clause of this item was wrong: it also said
   `transcriptFooterIsEmpty` "must stop suppressing it", but that predicate suppresses `end_turn` only,
   so `max_tokens` already rendered and **no TypeScript change was needed** (§1c carries the measurement).
2. **Persist the finish reason** — one `#[serde(default, skip_serializing_if = "Option::is_none")]
   finish_reason: Option<String>` on `ChatMessage`, riding `content_json`. **No migration**, ~25 B ×
   assistant rows ≈ **3.6 MB = 0.15%** of the 2.33 GB, and old rows deserialize as `None`. Makes the
   question answerable **for incidents from here on, from the row itself** — it recovers nothing for
   the rows already on disk, which never stored the field. ⚠ `ChatMessage` is also the
   transcript type — the request bodies are built fresh per wire, so verify on **all three** builders
   that the field cannot leak into a provider request.
3. **Send `max_tokens` deliberately** instead of omitting it, sized against the thinking budget — the
   current Anthropic clamp leaves 1,024 tokens for the tool call at `xhigh`. Note the counter-evidence:
   opencode #17471 *"Increasing maxOutputTokens only postpones the same failure"*, and #53989 reproduced
   with the cap at 65,536. So sizing is **necessary, not sufficient**.
4. **Generalise #64's guard off `Stop`-only and off "fully empty"** — a turn that announced intent and
   dispatched nothing is not a success. **Bound it**: every upstream project caps this at 2–3 retries
   (opencode 3, cline 3), and cline #9920 documents what an unbounded nudge loop looks like (*"Each
   subsequent retry also gets truncated, causing the same error in a loop"*). Detect the **turn shape**,
   not only `finish_reason`, because vLLM/llama.cpp show a gateway can rewrite the reason to a success
   value.
5. **Log the silent drops** — the nameless-tool-call drop in each of the three parsers'
   `flush_tool_calls` (currently silent, unlike `parse_arguments`, which does log), and the
   settle-with-nothing-dispatched site. Must be `eprintln!`, **not** `debuglog::log` (a silent no-op in
   the Worker).
6. **Stop logging the conversation by default** — 99.95% of the log is token deltas. Gating frame
   bodies behind a second opt-in takes retention from **71 seconds to ~4.7 hours** at the same 5 MB cap
   and removes the privacy hazard. **Every log-based fix is downstream of this one**: a diagnostic that
   rotates in 71 seconds is not a diagnostic.
7. **A user-visible notice** — Anthropic prescribes it; pi #7540 supplies the copy lesson (*"Response
   was truncated before completion"* rather than claiming every `length` was the configured limit, since
   normalised `length` can also mean context overflow or a provider-mislabeled cut).
8. **Separate cards for §7a–§7e.** 7a in particular is independently reproducible and arguably worse
   than the reported symptom.

---

## Appendix — re-runnable instruments

**The snapshot exists and is queryable.** `/home/daniel/arch-research-write-stall/snap.db` —
2,333,728,768 B, mtime **2026-11-14 15:12:40 +0100**, sha256
`90dcae62725146978ee58f5e24a83a6fbb68aacfa68edf0f546d940724212316`; whoever holds *a* snapshot of
that path can confirm it is *the* one against that hash. **The expected outputs below are pinned to
the 2026-11-14 15:12 snapshot, not to the live DB.** A re-taken `cp` of the live file is a different,
larger, drifted population: re-taking re-runs the *queries*, it does not recover the *numbers* — 566,
924, 126,713 and the 212,742-character case will all differ. And some outputs below are no longer
reproducible from the live file at all, because the post-fix binary persists truncated text and mints
`{stamp}:truncate:N` notice rows: #1's `0|0` ("no provider disposition persisted") and #14's
"`StopReason::MaxTokens` never constructed" describe a **pre-fix** world the live system has moved
past.

All DB queries against the read-only snapshot:

```bash
DB=/home/daniel/arch-research-write-stall/snap.db      # a cp of ~/.local/share/archimedes/archimedes.db
Q() { sqlite3 "file:$DB?mode=ro" "$1"; }
```

| # | Question | Instrument |
|---|---|---|
| 1 | No provider disposition is persisted | `Q "select (select count(*) from native_messages where json_extract(content_json,'\$.finish_reason') is not null), (select count(*) from messages where json_extract(payload_json,'\$.stop_reason') is not null);"` → `0\|0` |
| 2 | Assistant rows by shape | `Q "select case when json_type(content_json,'\$.tool_calls')='array' then 'calls' else 'nocalls' end, case when trim(coalesce(json_extract(content_json,'\$.content'),''))='' then 'empty' else 'text' end, count(*) from native_messages where role='assistant' group by 1,2;"` → `calls/text 41237`, `calls/empty 101555`, `nocalls/text 2203`, `nocalls/empty 9` |
| 3 | Empty rows are session-terminal | the `lastrow` CTE in §2 of the Angle-1 report → `LAST_ROW \| <none> \| 9` |
| 4 | `{}` arguments, pathological vs legitimate | the `json_each(…,'$.tool_calls')` + `json_extract(…,'$.arguments')='{}'` query → `566 \| 358 \| 924` |
| 5 | Tool-call id dialects (wire attribution) | `Q "with ids as (select json_extract(j.value,'\$.id') id from native_messages nm, json_each(nm.content_json,'\$.tool_calls') j where nm.role='assistant') select sum(id like 'call_%'), sum(id like 'toolu_%'), sum(id like 'fc_%'), sum(id like 'chatcmpl-tool-%'), count(*) from ids;"` → `164581\|0\|0\|12045\|176716` |
| 6 | Tool call written as TEXT, in the text channel | `Q "select count(*) from native_messages where role='assistant' and coalesce(json_type(content_json,'\$.tool_calls'),'null')='null' and (content_json like '%<invoke name=%' or content_json like '%｜DSML｜tool_calls%');"` → `2`, both session-terminal |
| 7 | Reasoning persists despite the docblock | `Q "select count(*) from messages where kind='agent-thought';"` → `126713`; `… and payload_json like '%<invoke name=%'` → `12` |
| 8 | Announced, never dispatched | `Q "select json_extract(payload_json,'\$.title'), count(*) from messages where kind='tool-call' and json_extract(payload_json,'\$.status')='in_progress' group by 1 order by 2 desc;"` → 1,067 total; `write` 3, `edit` 28 |
| 9 | Terminal-row length buckets | the `lr` CTE + a `case` bucket over `length(json_extract(…,'$.content'))` → 751 at 1–4k, 974 at 4–16k, 265 at 16–65k, 3 >65k |
| 10 | `FinishReason::Length` is unread by the turn loop | `cd /home/daniel/Coding/Archimedes/fulcrum && grep -rn "FinishReason::Length" src/harness/loop.rs src/harness/loop/ \| grep -v /tests/` → **no output** |
| 11 | `acc.finish` has two production readers | `grep -rn "acc\.finish\|\.finish ==" src/harness/ --include=*.rs \| grep -v /tests/` → 3 lines (1 write, 2 reads) |
| 12 | `max_tokens` is never sent by the turn loop | `grep -rn "max_tokens: Some" src/ --include=*.rs \| grep -v tests \| grep -v provider/` → **only** `compact.rs` (the summariser) |
| 13 | Anthropic clamp arithmetic | run the engine's own `anthropic_request_body_max_tokens_default_and_clamp` test |
| 14 | `StopReason::MaxTokens` is never constructed | `cd …/archimedes && grep -rn "StopReason::MaxTokens" src-tauri/src/ src/` → **no output**, while `src/components/chat/TranscriptFooter.test.tsx` asserts `"Turn ended: max_tokens"` |
| 15 | The log holds no harness trace | `grep -c -E "harness: \|worker-stderr: \|empty model turn \|malformed tool-call" ~/.local/share/archimedes/supervisor.log*` → `0` in both |
| 16 | The log rotates in ~71 s of streaming | `wc -c` + `wc -l` on both files, and the distinct active-second count from the leading ms timestamps → 72.1 KiB per streaming second against a 5 MB cap |
