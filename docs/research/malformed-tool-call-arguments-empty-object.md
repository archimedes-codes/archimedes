---
status: current
last-verified: 2026-11-16
task: tsk_4b5f1526-cc5e-488b-a122-d099b21af1ee
verified-by: >-
  Five research angles, 2026-11-16, at desktop HEAD 74e38fa1 (v0.14.0) pinning
  fulcrum-harness = "0.3.2". (a) Engine source read at the PINNED crates.io copy
  ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fulcrum-harness-0.3.2/,
  diffed against the sibling dev checkout /home/daniel/Coding/Archimedes/fulcrum
  (git describe v0.3.2) and against the vendored 0.1.0 / 0.2.0 / 0.3.0 / 0.3.1 —
  the sibling's gate.rs, turn.rs, tool_specs.rs and responses.rs are
  byte-identical to the pinned copy, so every finding is true of both.
  (b) SQLite forensics by the parent (not a subagent — the dispatched leaf
  returned nothing) against a read-only snapshot ~/arch-research-empty-args/snap.db
  (+ snap.db-wal), a cp of the live ~/.local/share/archimedes/archimedes.db taken
  2026-11-16 10:22 local, 2,472,960,000 B, integrity_check ok, 357,601
  native_messages, 194,784 tool calls, spanning 2026-10-04 → 2026-11-16 09:22.
  That snapshot is a WORKING FILE outside the repo and unrecoverable if deleted —
  re-take it the same way to re-run the census. (c) Twelve upstream projects read
  at source level with commit-SHA permalinks (Appendix B) + vendor docs.
  Citations are BY CONTENT (function, struct, enum variant, test name) not by line
  number, per this repo's locate-by-content rule; the engine's files move between
  the desktop and the crate, and this report's own subject has already moved once.
issue: https://github.com/archimedes-codes/archimedes/issues/190
---

# Malformed tool-call arguments collapse to `{}` and dispatch

**The settled question (Phase 0):** after #190's `Length` gate closed the
*truncation* route through this chain, what does the **non-truncation** half
actually cost this deployment, and what is the honest fix shape? Read at the
**pinned `fulcrum-harness` 0.3.2** — the Task card and
`docs/research/silent-turn-settle-after-announcing-a-write.md` were both written
against 0.2.0, and the pin has moved three times since (`f539b86d` → 0.3.0,
`700714b2` → 0.3.1, `61ba91ee` → 0.3.2).

Scope note carried from the card: the Responses-wire gap is in scope, #193's
"which wire is live" question is in scope, and the repair-vs-fail constraint is
treated as **settled for truncation** (ADR 0108) but **open for
malformed-but-complete**.

---

## Executive Summary

**Four of the card's figures are wrong or incomplete, and one new finding
outranks the one the card was filed for.**

1. **The pathological population is 555, not 566 — and it is 99.6% three
   sessions, not 47% two.** The 11 `mcp` calls are **not pathological**: all 11
   returned `Wizards: Connected` / `Wizards: Disconnected` with
   `isError: false`, i.e. the *documented* status action — the `mcp` spec
   advertises `"Status:  mcp({}) …"` verbatim. Correcting them out, **553 of 555**
   core pathological calls (`bash` 292, `edit` 244, `write` 19) live in **3**
   subagent sessions; **555 of 555** are in 5 sessions total. The population rate
   excluding the three burst sessions is **0.001%** (2 of 194,784 tool calls), not
   the card's ~0.2%.

2. **The burst was not truncation, and the card's INFERRED label is now
   resolvable.** Burst session `arch_16fc4f3d…`'s 303 `{}` calls sit on assistant
   rows averaging **118 bytes** (min 116, max 262) whose `content` is empty. A
   118-byte row is not an output-cap truncation of anything. 303 distinct
   `call_…` ids, ~15.8 calls/min across 19.1 minutes, inter-call gaps collapsing
   from ~50 s to ~1.2 s. The model **sent empty arguments and re-sent the
   identical call after every refusal.**

3. **The expensive defect is that nothing stopped it.** `handle_turn`'s inner
   `loop { }` has **no iteration bound**, and `MaxTurnRequests` has **zero
   occurrences anywhere in the crate** — the desktop declares that enum variant
   and nothing constructs it. 303 refusals the model was structurally unable to
   act on, at roughly one per second, until the session stopped. Both burst
   sessions **end on** the refusal row (`bash: missing \`command\` parameter`,
   `edit: missing \`path\`, \`old_text\`, or \`new_text\` parameter`).

4. **The disposition persistence shipped but has never run in production.** Zero
   rows carry `$.disposition`; zero carry a truncate message-key. Reason found:
   the installed AppImage was built 2026-11-15 **13:28**, and the 0.3.1 pin that
   puts the disposition on the row landed **19:25** the same day. So the card's
   premise — *the DB cannot separate "gateway truncated the args" from "model sent
   empty args"* — **remains true**, and the change designed to fix it is proven by
   a test and by no row.

**And two facts that make the chain worse than the card states.** The Anthropic
wire's `tool_result` block carries **no `is_error` key at all** (`is_error` has
zero hits across `src/harness/provider/`), so the failure is unlabelled *and*
unmarked on that wire. And the collapsed call is **replayed to the model as its
own assistant message with `arguments: "{}"`** — `handle_turn` pushes
`tool_calls: Some(tool_calls.clone())` and each wire serialises the parsed
`Value` back out. **A call the model never made in that form enters the permanent
history the model re-reads every turn**, which is a plausible lock-in mechanism
for exactly the loop in (2).

**Net:** the misleading red card is real and still unfixed, but at 0.001% it is
not the interesting half. The interesting half is that a degenerate
empty-argument loop is **unbounded**, that the malformed-ness is destroyed at the
parse site so we cannot tell the model or the user which of the two causes fired,
and that the Responses wire has a **second** silent-success path ADR 0108 does not
cover.

---

## Findings

### 1. The chain holds end to end at 0.3.2, and ADR 0108 does not cover it

`parse_arguments` (`src/harness/provider/openai.rs`) is **byte-identical across
all five vendored versions 0.1.0 → 0.3.2** — it has never changed. `tool_specs.rs`,
`loop/gate.rs` and `tools/exec/fs_tools.rs` are `diff -q` identical between 0.2.0
and 0.3.2. Every link the card names is verified:

| Link | Decision | Where |
|---|---|---|
| 1 | `parse_arguments`: empty/whitespace → `{}` silently; unparseable → `{}` + one `eprintln!("harness: malformed tool-call arguments — using {}: {e}")` | `provider/openai.rs`, fn `parse_arguments` |
| 2 | `ToolCall { id, name, arguments: Value }` — no field can carry "this was malformed" | `provider_types.rs`, struct `ToolCall` |
| 3 | `unknown_param_error` returns `None`: zero keys ⇒ `items.is_empty()` ⇒ early return | `tool_specs.rs`, fn `unknown_param_error` |
| 4 | `policy_verdict` returns `Some(Decision::Allow)` on a missing/non-string `path` | `loop/gate.rs`, fn `policy_verdict` |
| 5 | `_ => self.dispatch_tool(tc, turn)` | `loop/turn.rs`, fn `run_tool_batch` |
| 6 | executor refuses, `is_error: true` | `tools/exec/fs_tools.rs`, `exec_write` et al. |

Two precisions the card does not have:

- **`parse_arguments` does not only collapse to `{}`.** A *parseable* non-object
  payload (`"[]"`, `"\"text\""`) passes straight through as a `Value::Array` /
  `Value::String`, and `unknown_param_error`'s `tc.arguments.as_object()?` then
  silently returns `None` for it. A non-object argument body reaches the executor
  unexamined too.
- **The `eprintln` does not name the tool or the session** — it is one line of
  prose with a serde message and nothing else.

**Ordering, and why ADR 0108 cannot help.** `run_tool_batch` runs
`unknown_param_error` over the batch *before* the gate — a deliberate rule ("a
call that will not run must never raise a permission prompt", `loop/turn.rs`) —
but that pre-pass is unknown-**key** detection, not required-**key** validation,
so `{}` produces no rejection and reaches the gate on the normal path. And
`handle_turn` (`loop.rs`) tests `acc.finish == Some(FinishReason::Length)` first
and returns, so dispatch is reachable **only when `finish != Length`**. A
complete-but-malformed payload arrives with `Done(FinishReason::ToolCalls)` (or,
on a mislabelling gateway, `Done(Stop)`) and dispatches. ADR 0108 says so itself:
*"The gate is therefore per-turn, and the per-call refinement … buys nothing"*,
and its amendment records the per-call refinement as **rejected, not overlooked**.

**A third route to the same place:** `map_finish_reason`'s catch-all maps any
unrecognised `finish_reason` string to `FinishReason::Stop` with one `eprintln!`.
A gateway sending `"max_tokens"` on the OpenAI wire therefore bypasses the Length
gate entirely and dispatches. This is the mechanism upstream reports
(vLLM #53269, llama.cpp #30773) and it means the Length gate is keyed on a field a
translated gateway can rewrite.

### 2. `required` is advertisement only — and one spec contradicts its own executor

There is **no JSON-Schema validator in the crate**: the dependency list holds no
`jsonschema`, `schemars`, `validator` or `garde`. The only runtime reads of
`"required"` are 22 spec literals sent to the model and one test
(`the_model_facing_web_prose_names_the_key_the_advertised_schema_requires`) that
asserts *prose* agrees with the array. All three wires forward
`t.parameters` verbatim, so **the model is told a shape the harness never
enforces**. `unknown_param_error`'s own docblock states the policy: *"`required` is
irrelevant — only `properties` defines legality"*.

The consequence worth recording: **`ls` advertises `"required": ["path"]` while
its executor defaults `path` to `"."`**, and an existing executor test asserts
that `ls({})` lists the cwd and succeeds. The advertised schema and the executor
disagree, and a test pins the disagreement. Any fix that trusted `required` would
break a working, tested call.

### 3. What `{}` does to every tool: 22 refuse, 4 act

Registry is `tool_specs()` (26 entries). Full table:

| Tool | Advertised `required` | `{}` outcome | `is_error` |
|---|---|---|---|
| `bash` | `command` | ``bash: missing `command` parameter`` | true |
| `codemode` | `code` | ``codemode: the `code` parameter must be a string of JavaScript`` | true |
| `read` | `path` | ``read: missing `path` parameter`` | true |
| `write` | `path, content` | ``write: missing `path` or `content` parameter`` | true |
| `edit` | `path, old_text, new_text` | ``edit: missing `path`, `old_text`, or `new_text` parameter`` | true |
| `find` | `pattern` | ``find: missing `pattern` parameter`` | true |
| `grep` | `pattern` | ``grep: missing `pattern` parameter`` | true |
| **`ls`** | `path` (advertised) | **defaults to `"."` — lists the session cwd** | **false** |
| **`list_skills`** | none | returns the skill catalog | false |
| **`list_agents`** | none | returns the agent catalog / `"none"` | false |
| **`mcp`** | none | `status_lines()` — the **documented** status action | false |
| `read_skill` | `name` | ``read_skill: missing `name` parameter`` | true |
| `ask` | `questions` | a long corrective sentence naming the shape | true |
| `sudo_exec` | `command, reason` | refuses **before** any elevation prompt | true |
| `manage_todo_list` | `operation` | `Error: todoList is required for write operation.` | true |
| `subagent` | `task` | ``invalid params: `task` is required`` — no child spawned | true |
| `web_search` | (none) | `web_search requires 'query' or 'queries'` | true |
| `fetch_content` | `url` | ``fetch_content: missing `url` parameter`` | true |
| `get_search_content` | `response_id` | ``get_search_content: missing `response_id` parameter`` | true |
| `list_board` / `get_task` / `create_task` / `edit_task` / `move_task` / `get_artifact` / `write_artifact` | various | ``missing or invalid `…` string`` (or `no task store: …` if the store is absent) | true |

**No tool performs a mutating action on `{}`.** Four do read-only work. `ls` is
the sharpest: a truncated or malformed `ls` **succeeds with the wrong listing and
a green card** — the red-card symptom this card is named after does not even fire.
Zero `ls`/`find`/`grep` `{}` calls exist in the DB, so this is unobserved in
practice, not benign by design. `mcp({})` "acts" only because status is its
documented no-argument meaning — which is precisely why the 11 measured `mcp`
calls must not be counted as defects, and why a truncated `mcp` call is
indistinguishable from a deliberate status check.

### 4. The permission gate's fail-open: real, deliberate, unpinned, and with a sharper edge than documented

`gate.rs`'s `policy_verdict` early-returns `Some(Decision::Allow)` when `path` is
absent **or present-but-not-a-string** (`{"path": 123}`, `null`, `["a"]` all take
the same arm). The docblock states the intent: *"a malformed call is not a policy
event"*. Only **7 of 26** tools are policed at all (`POLICIED_TOOLS`: `bash`,
`read`, `find`, `grep`, `ls`, `write`, `edit`), and the gate inspects exactly **one
argument name** — `path`. `bash` never reads an argument; the Shell arm hardcodes
`beyond = true`.

**The edge the docblock does not mention:** this early return is the **only exit
from `policy_verdict` that never calls `stricter_of_two`**. Everything downstream
is bypassed — the `beyond` computation, the write-rule/guard consult,
`decision_for`, and `definition_verdict`. So a pathless `write` is `Allow` even
under `writes: "sandboxed"`, and a definition-level `write: deny` cannot reach it
either — while `gate.rs`'s own comment claims a definition's verdict *"can never
… be bypassed"*. Different route, same class.

**It produces no action today**, because every write/execute executor refuses a
pathless call (`write` is strictest — it requires `path` **and** `content` in one
tuple match). So the honest severity is *a missing prompt with no consequence*.
But: **no test pins it** (`policy_gate.rs` has no absence/no-path/missing-path
test at all), and `param_rejection.rs`'s
`a_rejected_call_never_reaches_the_permission_gate` docblock shows the codebase
already knows the hazard and routes its fixture around it — *"the old code really
would have prompted (a typo'd `path` would make `policy_verdict` answer `Allow`
for the missing-path reason and this test would pass vacuously)"*.

**The truncated-path case is not a bypass.** There is **no truncation primitive
anywhere in the harness on tool arguments** (the only truncation in the transport
is `log_truncated`'s 2 KB cap on the *debuglog line*, never the decoded frame). A
shortened path is just a shorter string, judged identically to any string of that
spelling, through the same resolver the executor uses. A truncated path that
resolves outside the Boundary still raises the ordinary `Ask` prompt; one that
resolves inside lands an in-Boundary write exactly as silently as any legitimate
in-Boundary write. Wrong, but not an escape.

**One divergence worth its own look** (found while answering this): inside
`policy_verdict` the *beyond* test uses `FsBackend::resolve` (root-anchored,
`roots[0].join(path)`) while the rule lookup and `is_guard_path` use
`canonicalize_lenient(Path::new(raw))`, which canonicalizes against the **process
CWD**. For a relative path where the Worker's CWD differs from `space_cwd`, the
verdict and the rule match are computed over two different resolutions of one
string. Invisible for absolute paths and when the two agree.

**Audit surface: the skipped prompt is invisible as such.** `permission-request`
is emitted only from `gate_tool`, which a silent `Allow` never reaches; permission
frames are never persisted (`src/persist.rs`, `src/store_rows.rs` hold no
`permission` key at all); and the gate contains no `eprintln!`. ADR 0030 concedes
the class already: *"`Don't ask me` is silent and unlogged"*. What a post-hoc
reader *can* see is a `tool_call` row with `rawInput: {}` and the refusal as its
output — from which "no prompt was raised" is **inferable** and never stated.

### 5. Upstream: fail-honestly is near-universal, and the discriminator is a field

| Cohort | Projects, read at source |
|---|---|
| **Fail, never repair** | Anthropic docs; Anthropic SDKs (py + ts, both raise `Unable to parse tool parameter JSON from model…`); OpenAI platform spec + `openai-agents-python`; **vercel/ai**; **opencode** (*"reject malformed local arguments without repairing them"*); **openai/codex** (issue #19765: *"Avoid automatic JSON 'repair' … silent repair of truncated arguments could mutate intent"*); LangChain; **pi's final-arguments path** |
| **Repair and execute** | **cline** (`jsonrepair`, guarded only for unterminated strings), **LlamaIndex** (`parse_partial_json`), **smolagents** (passes the raw string through) |

Anthropic's prescribed payload, verified on the fine-grained-tool-streaming page:
`{"type":"tool_result","tool_use_id":"…","is_error":true,"content":"{\"INVALID_JSON\": \"<the unparseable input>\"}"}`
— with *"you cannot run the tool"*. Note their **own SDKs do not implement their
own recommendation**: both raise and synthesise no `tool_result` (confirmed by
source, and independently by an upstream report that the Tool Runner does not
auto-implement the wrapper).

**The repair cohort's victim list is the decisive evidence for "fail honestly":**

| Report | What ran | Result |
|---|---|---|
| llama_index #24102 (open, deterministic repro) | `write_file` args cut at line 17 of 40, repaired, `invalid_tool_calls` empty | **wrote 866 of 2,120 bytes**, "No exception, no warning; the agent reports success" |
| claude-code #97311 (open) | refusal-cut `tool_use`, JSON closed at the cut, **passes schema** | file truncated on disk with *"has been updated successfully"* |
| crewAI #8195 (open) | `{"query": "XYZ` → `{"query": "XYZ"}` | tool answered about the **wrong entity** |
| pi #10897 (closed, fixed) | `partial-json` closed a truncated string | fabricated `clipId: "clip-fl"` — **passed a downstream existence check** as a plausible-but-wrong id; 18 identical retries over 13 min |
| cline #14827 (open) | `run_commands` as `{"commands":[]}` / `{"commands":[":\""]}` | 7 identical calls → loop detector aborted the run |

**The opposite risk is quantified too, and it lands on our exact bug.** pi #9561:
failing per-call on a degenerate 14,408-call message cost **739,133 input tokens
(~$1) in one turn** and rolled the session over. claude-code #63604/#64235:
*"the identical re-prompt reproduces the identical failure"*, ~30 minutes blocked.
pi #9643: 29 turn-kills over 9 days, *"recovery requires an out-of-band human
nudge"*. Warp #15798: the *error path itself* poisons the conversation — a
malformed `tool_use.input` kept as a JSON **string** in history makes every later
request 400, so the corrective result can never reach the model. **Every one of
these is our 303-call burst with a different cause.** Fail-honestly without a
retry bound and a batch cap trades a misleading card for a cost blowout.

**The convention, and it settles the design question.** Five harnesses carry a
first-class discriminator: pi `ToolCall.argumentsError?: string`; cline
`invalidToolCalls[]` with a reason enum `missing_name | missing_arguments |
invalid_arguments` plus `rawInputText`/`parseError`; LangChain
`AIMessage.invalid_tool_calls`; opencode a distinct `tool-input-error` event
carrying `raw`; vercel `invalid: true` + an error whose `cause` distinguishes
`JSONParseError` from `TypeValidationError`. **All five keep `arguments: {}` and
carry the discriminator in a separate optional field — nobody changes `{}`
itself.** pi's shipped copy is the template and it is exactly the two-sentence
shape this card wants:

```
Invalid arguments for tool "edit": <parse error>

Received arguments:
<raw text>
```

— kept textually distinct from its *schema* sentence (`Validation failed for tool
"read": - paths: must be array …`), and distinct again from its truncation sentence
(`Tool call "write" was not executed: the response hit the output token limit, so
its arguments may be truncated. Re-issue the tool call with complete arguments.`).

**A separate failure class with its own hard requirement:** arguments arriving as
a **JSON-encoded string** instead of an object. The API rejects the *history*, not
the call. vercel fixed it (`part.invalid && typeof part.input !== 'object' ? {} :
part.input` when building the response message); opencode ships the same idea as a
comment (*"Providers require an object input, so it is empty"*); Warp has not.
This is relevant to us because `parse_arguments` passes a top-level JSON string
through unchanged (§1).

### 6. The Responses wire: still broken, mitigation covers one quarter, and a second silent-success path is new

`terminated` in `responses.rs` has **four writes and one read**. The read is the
stream-end `if !this.terminated` guarding the **only** call to `flush_tool_calls`.
`response.incomplete` sets `terminated = true` and pushes `Done(finish)` with **no
flush of its own** — the 0.2.0 claim survives verbatim at 0.3.2, and the parser
file differs from 0.2.0 only inside `mod tests`.

**Only one of the four writes is a length stop.** `response.completed` →
`Done(Stop)`; `response.incomplete` → `Done(Length)` *only* when
`incomplete_details.reason == "max_output_tokens"`, else `Done(Error)`;
`response.failed` → `Done(Error)`; `error` → `Error(…)` or `Done(Error)`. So ADR
0108's gate mitigates a quarter of the drop, and even there only partially: the
user now sees *"Response was truncated before completion"* instead of a silent
success, but the call is still invisible — no card, and none of the
`discarded — the model call that asked for this tool was abandoned before it ran`
sentence the other two wires' cards get.

**The sub-question "does a dropped call leave an orphan row open?" is vacuous on
this wire, and the reason is worth keeping:** `output_item.added` emits only a
`ToolCallDelta`; `normalize`'s `toolcall_start` arm requires a non-empty
`toolName` and `toolcall_delta` for an unannounced id returns nothing; and
`RpcEvent::toolcall_start` has **zero construction sites** in the crate. On the
Responses wire a card is announced only from a complete `ToolCall`, so a dropped
call never opened a row and `close_announced_tool_calls` is a no-op over it.

**New bad case, not in the card, not in #193.** `response.completed` sets
`terminated = true` **unconditionally** but pushes `Done(Stop)` only when
`response.status == "completed"`. A `response.completed` with an absent or
different `status` therefore (a) skips the flush — the mid-stream `function_call`
vanishes, (b) pushes **no `Done`**, so `acc.finish` stays `None`, (c) bypasses both
the Length gate and the fabrication guard (which requires `finish == Some(Error)`),
and (d) falls through the emptiness gate into `note_success` and the success
triple. **A silent success with a vanished call and no truncation notice — the
pre-#190 symptom through a different door.** No test covers it: every
`response.completed` fixture in the file carries `"status":"completed"`.

**Test gap unchanged:** of the 19 tests in `responses.rs`, only two emit a
`function_call` `output_item.added` (`responses_sse_function_call_full_lifecycle`,
`responses_sse_function_call_done_item_authoritative`) and **both** also emit the
authoritative `output_item.done`. The two `incomplete` tests
(`responses_sse_incomplete_max_output_tokens`,
`responses_sse_cost_rides_the_incomplete_terminal`) carry **no `function_call` at
all** and assert exactly `[Usage, Done(Length)]`. A programmatic scan for "a test
with both a `function_call` item and a terminal event" returns **zero**.

### 7. Is the Responses wire live here? Not for anything this config drives — and it is one model-select away

Three surfaces can select it: the per-provider **API** `<Select>` in Settings
(`API_VALUES` includes `openai-responses`), four `KNOWN_PROVIDERS` templates that
seed `api: OpenAiResponses` (`openai`, `xai`, `opencode-go-responses`,
`opencode-zen-responses`), and **automatic derivation** — when `provider.api ==
"litellm"`, `session/mod.rs` prefers `meta.api` (the discovered
`derived_wire`), and `derive_wire_for_route` returns `OpenAiResponses` when the
route's deployment `mode == "responses"`.

Evidence it is not currently selected: the config holds **one** provider,
`api: "litellm"`, `baseUrl https://llm.wizards.town/v1`; `openai-responses` appears
nowhere in `settings.json`; and a read-only `GET /v1/model/info` (39 routes) shows
`mode` = 32 `chat`, 2 `null`, **5 `responses`** — none of which is a model this
config names (`defaultModel`, the three `agentOverrides`, and the
`defaultThinkingLevels` keys all resolve to `null`/`chat`). No code path
constructs the Responses provider from anything but `Model.api`: no host branch,
no provider-auth branch, no subagent default.

**What would falsify it, all one user action away:** selecting any of the five
`mode:"responses"` routes (`opencode_go/gpt-5.6-luna`, `gpt-6-luna`, `grok-4.7`,
`muse-spark-1.2/1.3-contributor`) flips the wire with **no config edit**; so would
the gateway adding `mode:"responses"` to a route already in use, since the
derivation reads a live `/model/info`.

**#193's one-line ask is still unimplemented and still the right ask.**
`WireApi::parse(m.api.as_deref().unwrap_or("openai-completions")).unwrap_or_default()`
has **two silent defaults** — `api: None` and an unparseable string both land on
completions — and `provider/mod.rs` contains **zero** `eprintln`/`debuglog` calls.
The chosen wire is never logged and never persisted: `sessions.capabilities_json`
carries `model`/`thinkingLevel`/`native`/`promptCapabilities`/`loadSession` and
**not** `api`. DB dialects re-measured: `call_` 181,710 · `chatcmpl-tool-` 12,045 ·
`call_resp_<uuid>_<n>` 489 · `fc_` **0** · `toolu_` **0**. The absence of `fc_`
proves nothing, because this wire copies `item.id` verbatim and never mints one.

**New dialect worth a card of its own:** `call_resp_<uuid>_<n>` — 489 rows, 8
sessions, **all `is_subagent = 1`**, 2026-10-24 → 2026-11-11 — has **no producer
anywhere** in either crate or the desktop tree. It is evidence of a former
id-mangling path, not of the Responses wire, and it is now dead code or a deleted
path nobody has reconciled.

### 8. Forensics: the residual, and what the burst actually was

Re-run on the 2026-11-16 snapshot. **`.finish_reason` / `.stop_reason` are still
key-level absent from every row in both tables** (`0|0|0|0`) — the instrument trap
from the earlier report recurs: a loose `LIKE '%"length"%'` returns 1,934 rows and
**all of them are conversation text quoting the source**, including this very
session's subagent reports.

**`{}`-argument tool calls, current DB:**

| Tool | Count | Verdict |
|---|---|---|
| `list_skills` | 357 | legitimate — takes no arguments |
| `bash` | 292 | pathological |
| `edit` | 244 | pathological |
| `list_agents` | 41 | legitimate |
| `write` | 19 | pathological |
| `mcp` | 11 | **legitimate** — all 11 returned a status line, `isError: false` |

**Pathological by date** (the #190 fix epoch is 2026-11-15): everything is on
2026-10-14 → 2026-10-30, with **312 + 243 of 555 on 2026-10-29/30**. Zero
pathological calls on any of the 15 days from 2026-10-31 through 2026-11-16,
**including the 15,000 assistant rows after the fix**. So the residual is zero in
both senses — but the measurement window is dominated by a two-day incident, so
this proves the burst ended, **not** that the fix ended it.

**Per session, all-time:**

| Session | subagent | `{}` core | Window | Rate |
|---|---|---|---|---|
| `arch_16fc4f3d…` | yes | 303 | 19.1 min | 15.8/min |
| `arch_3d1d62ca…` | yes | 242 | 20.2 min | 12.0/min |
| `arch_3749fa51…` | yes | 8 | 4.1 min | 1.9/min |
| `arch_80d73953…` | yes | 1 | single | — |
| `arch_aaa1bdf5…` | yes | 1 | single | — |

All five are subagents, all three bursts share `cwd
/home/daniel/Coding/AI/archimedes-desktop`, and all three fall in the same
two-day window — consistent with one run driving two sibling worktrees. Their
`capabilities_json` is the literal `null` (subagent sessions carry no model), so
**model attribution for the burst is impossible from this DB** — the same gap the
earlier report's Gap 3 records.

**The shape, which is what separates this from truncation:**

- Burst 1 made **292 of its 332 `bash` calls** and burst 2 **233 of its 238
  `edit` calls** with `{}` arguments.
- Each `{}` call sits on its own assistant row: **303 distinct ids, 303 distinct
  seconds**, gaps collapsing from ~44 s to ~1.2 s — a tightening loop, not noise.
- Those rows average **118 bytes** (min 116, max 262) with empty `content`. A
  118-byte row is not a truncated `edit` carrying an `old_text`/`new_text` pair.
- **Both sessions end on the refusal row** — the last `native_messages` row is a
  `tool` row reading ``bash: missing `command` parameter`` /
  ``edit: missing `path`, `old_text`, or `new_text` parameter``.
- The results are unambiguous: 292 `failed` rows for `bash: missing \`command\``,
  233 for the `edit` sentence. The model received that sentence ~300 times and
  re-sent the same call each time.

**And the loop has no bound.** `handle_turn`'s inner `loop { }` has one exit
condition set (cancellation, and the `TurnFlow::Return` arms); `MaxTurnRequests`
appears **nowhere** in the crate; there is no consecutive-identical-error or
repeated-refusal detector. Every upstream project that hit this capped it —
opencode at 3 consecutive `length` turns, cline at 3, pi #9561's lesson was a
**batch cap** on the per-call failures. Our 303 is what the unbounded shape costs.

### 9. Stale claims in our own docs (found, reported, not silently edited)

`docs/research/silent-turn-settle-after-announcing-a-write.md` states its engine
read "IS the source of the pinned `fulcrum-harness = "0.2.0"` the desktop links"
and repeats "as of desktop `v0.13.0`, which pins `fulcrum-harness = "0.2.0"`". The
desktop is **0.14.0** pinning **0.3.2**; the pin has moved three times since that
sentence. Its §4 claim that the crate holds **9** `eprintln!("harness: …")` sites
is also under-counted — a single-line grep gives 9, a multiline-aware scan gives
**11 at 0.2.0 and 12 at 0.3.2**, and the site the doc's own fix introduced is the
one it misses. **Every mechanism claim in §4 was re-verified at 0.3.2 and holds**;
only the citations rotted. Nothing here was edited into those docs — that is
`specify`'s call.

---

## Evidence

**Primary (pinned source).**
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fulcrum-harness-0.3.2/`.
Cross-checked against `/home/daniel/Coding/Archimedes/fulcrum` (dev HEAD,
`git describe` → `v0.3.2`): `gate.rs`, `loop/turn.rs`, `tool_specs.rs`,
`provider/responses.rs` **byte-identical**, so every finding is true of both.
Version-to-version: `parse_arguments` identical 0.1.0→0.3.2; `tool_specs.rs`,
`gate.rs`, `fs_tools.rs` identical 0.2.0→0.3.2; `responses.rs` differs 0.2.0→0.3.2
only inside `mod tests`; `loop/turn.rs` differs only by the
`handle_truncated_turn`/`settle_truncated` pair and comment site-counts.
*Credibility: the source the product compiles — highest tier.*

**Primary (DB).** `~/arch-research-empty-args/snap.db` (+ `-wal`), instruments in
Appendix A. *Credibility: this machine's real history; one machine, one gateway.*

**Secondary (upstream).** Twelve projects at source level, permalinks in Appendix
B; vendor docs for Anthropic (fine-grained tool streaming, stop reasons, thinking
troubleshooting) and OpenAI (the function-calling schema sentence and the Help
Center article). *Credibility: official source > vendor docs > issue-tier reports.
Claude Code is closed-source and cited issue-tier only, as flagged.*

**Reasonable inferences, labelled.** (i) That the burst was the model emitting
empty arguments rather than a gateway truncating them — supported by the 118-byte
rows, the distinct ids, the per-second cadence and the fact that the refusal was
delivered and ignored; **not proven**, because no per-cause discriminator exists
in the data. (ii) That replaying `arguments: "{}"` into history contributes to the
loop's persistence — mechanistically plausible, untested. (iii) That the 0.3.1
disposition pin has not run because the AppImage predates it by ~6 hours — strong
circumstantial evidence (build mtime vs commit time), no direct observation of the
running binary's version.

---

## Unresolved contradictions

1. **"566 pathological" (the card, ADR 0108, and `settle_truncated`'s own
   docblock) vs 555 measured.** The 11 `mcp` calls are the whole difference, and
   they are the documented status action. The number 566 is quoted as evidence in
   **three** durable places — the card, the ADR, and a doc comment in the crate —
   and all three inherit it from the same census.
2. **"The two bursts are truncation-shaped" vs rows too small to truncate.** The
   card's own INFERRED hedge was right to be there; the row-size measurement now
   argues against truncation outright. No source can settle it per-call, which is
   the argument for the discriminator, not against it.
3. **"Worker stderr is captured" vs "unreachable"** — unchanged from the earlier
   report and still both-true. The malformed-arguments `eprintln` is written and
   unreadable: `debuglog::log` returns at its first statement unless
   `ARCHIMEDES_DEBUG` was set before launch, and the Worker never calls
   `init_from_env` by design.
4. **`ls`'s spec says `path` is required; its executor defaults it; a test pins the
   default.** Two artifacts in the same crate disagree about one tool's contract,
   and both are green.
5. **Anthropic prescribes `INVALID_JSON`; Anthropic's own SDKs and Tool Runner do
   not implement it.** The recommendation is documentation, not behaviour.
6. **"The disposition now persists" (commit `700714b2`, a feature doc, and an
   end-to-end test) vs 0 rows carrying one.** Both true: the test drives a real
   `turn_truncated` through `normalize` → `compute_display_rows` → `persist_display`
   → a real `Db`, and the *installed binary* predates the pin by six hours. A
   green test and a feature doc are not evidence about the deployed artifact.

---

## Gaps

1. **Cause separation is still impossible retroactively**, and now the reason is
   known: zero dispositions were ever persisted. The fix is unexercised in
   production, so the card's central "INFERRED, not proven" survives this run.
2. **The ex-burst sample is 2 calls in 194,784.** Too small to characterise the
   non-burst population at all, let alone split it by cause. The only fleet figure
   found anywhere is pi **#9897**: 26 of 8,014 tool calls with dropped/malformed
   args, **21 of 26 from a chat-completions→Responses bridge and 0 in 3,571 native
   Responses calls** — pointed, because our gateway *is* a bridge, but it is one
   project's count, not ours.
3. **Whether any real backend sends `response.completed` without
   `status: "completed"`** — unmeasured, and it decides whether §6's new
   silent-success path is live or dead code.
4. **No upstream evidence that the model-facing wording changes outcomes.** Nobody
   has ablated "your JSON was invalid, here is the parse error" against "missing
   required parameter `path`". The fix direction is principled and consistent
   across twelve projects; its *effect* is unmeasured.
5. **Model attribution for the three burst sessions is impossible** —
   `capabilities_json` is `null` for all subagent rows and there is no
   parent-session column.
6. **`call_resp_<uuid>_<n>` has no producer in current source** (489 rows, 8
   subagent sessions, dead by 2026-11-11). Could not be dated to a build.
7. **Whether a truncated `ls` silently listing the cwd is reachable in a real
   session** — verified at executor level and pinned by an executor test, never
   driven through the loop. Zero such rows in the DB.
8. **The `space_cwd` vs process-CWD divergence in `policy_verdict`** (§4) was read,
   not exercised. Whether the Worker's CWD ever differs from `space_cwd` in
   practice was not established.

---

## What the evidence supports as fixes (not a decision — `specify` owns that)

Ranked by cost-to-coverage, and **these are four independent tracks**, which is
why `specify` may want to split them rather than write one plan.

1. **Bound the turn loop.** Nothing else measured costs what 303 unbounded
   refusals cost. Cap consecutive identical tool errors, or total turns per
   prompt, and construct `StopReason::MaxTurnRequests` — the variant already
   exists, is rendered, and has zero construction sites. Every upstream project
   caps this at 2–3. ⚠ Pair it with a **batch cap**: pi #9561 shows one error
   result *per call* on a degenerate message is itself a cost incident.
2. **Preserve the malformed-ness and name it.** `parse_arguments` → a
   two-value return, and a `#[serde(default, skip_serializing_if)]` optional
   defect field on `ToolCall` (the field is **mandatory** — `ToolCall` is embedded
   in `ChatMessage.tool_calls`, whose whole JSON is the transcript row, so a
   non-defaulted field fails every old row to load). Then one arm at the head of
   `unknown_param_error` gets the honest sentence for free at all three call
   sites. Copy pi's shape, and keep it textually distinct from the schema sentence.
   **Do not repair** — §5's victim table is the argument. ⚠ This is a public,
   serialized, persisted type, so it ships with a crate version bump the desktop
   pins, which ADR 0108 records as a one-commit constraint.
3. **Close the Responses gaps**: flush on `response.incomplete`; decide what
   `response.completed` with a non-`"completed"` status means (§6's silent success,
   which no test covers); add the missing test for `incomplete` + a partially
   streamed `function_call`.
4. **Log the chosen `WireApi` at provider construction** (#193's ask, still the
   cheapest permanent answer in this report). One `eprintln!` — **not**
   `debuglog::log`, which is a silent no-op in the Worker. Making the wire
   discoverable also converts gaps 2 and 3 from unanswerable to a `grep`.
5. **Two smaller, independently reproducible defects the census surfaced:** `ls`'s
   spec contradicting its executor (and the test pinning it), and the
   `space_cwd`/process-CWD divergence inside `policy_verdict`.
6. **Fix the stale pin/counts in the two existing docs** (§9) while this topic is
   still open, rather than leaving a third doc to inherit them.

---

## Appendix A — re-runnable instruments

```bash
DB=$HOME/arch-research-empty-args/snap.db      # cp of ~/.local/share/archimedes/archimedes.db, 2026-11-16 10:22
Q(){ sqlite3 "file:$DB?mode=ro" "$1"; }        # the live DB is LOCKED by the running desktop
```

| # | Question | Instrument | Result |
|---|---|---|---|
| 1 | Still no provider disposition persisted | `Q "select (select count(*) from native_messages where json_extract(content_json,'$.finish_reason') is not null), (select count(*) from native_messages where json_extract(content_json,'$.stop_reason') is not null), (select count(*) from messages where json_extract(payload_json,'$.finish_reason') is not null), (select count(*) from messages where json_extract(payload_json,'$.stop_reason') is not null);"` | `0\|0\|0\|0` |
| 2 | `{}` arguments by tool | `Q "with calls as (select json_extract(j.value,'$.name') tool, json_extract(j.value,'$.arguments') args from native_messages nm, json_each(nm.content_json,'$.tool_calls') j where nm.role='assistant') select tool, count(*) from calls where args='{}' group by 1 order by 2 desc;"` | `list_skills 357 · bash 292 · edit 244 · list_agents 41 · write 19 · mcp 11` |
| 3 | Pathological by date | same CTE, `where args='{}' and tool in ('bash','edit','write')`, `group by date(created_at/1000,'unixepoch')` | all in 2026-10-14→10-30; **0 after 10-31** |
| 4 | Per-session, with window | same, `group by session_id` + `sessions.is_subagent` | 303 / 242 / 8 / 1 / 1, all subagents |
| 5 | The burst rows are too small to be truncations | `Q "with r as (select length(nm.content_json) len from native_messages nm, json_each(nm.content_json,'$.tool_calls') j where nm.session_id='arch_16fc4f3d-…' and nm.role='assistant' and json_extract(j.value,'$.arguments')='{}') select count(*), min(len), max(len), avg(len) from r;"` | `303\|116\|262\|117.76` |
| 6 | One call per second, distinct ids | `count(distinct created_at)`, `count(distinct id)` over the burst | `303\|303\|303` |
| 7 | What the `{}` calls returned | join `messages` on `json_extract(payload_json,'$.toolCallId') = call id`, group by `rawOutput` | 292 × `bash: missing \`command\` parameter` `failed`; 233 × the `edit` sentence `failed` |
| 8 | Both bursts end on the refusal | `select role, substr(content_json,1,120) … where (session_id,seq) in (select session_id, max(seq) … group by 1)` | both `tool` rows carrying the refusal |
| 9 | The `mcp({})` calls are the status action | join as #7 for `tool='mcp'` | `Wizards: Connected/Disconnected`, `isError:false`, `completed` ×11 |
| 10 | The disposition has never been written | `Q "select count(*) from messages where json_extract(payload_json,'$.disposition') is not null;"` and `… where message_key like '%truncate%';` | `0` and `0` |
| 11 | …and the loose grep is conversation | `Q "select kind, count(*) from messages where payload_json like '%\"length\"%' group by 1;"` | 1,934 rows, all text — the instrument trap again |
| 12 | Wire dialects | `with ids as (…) select sum(id like 'call_resp_%'), sum(id like 'call_%'), sum(id like 'toolu_%'), sum(id like 'fc_%'), sum(id like 'chatcmpl-tool-%'), count(*)` | `489\|181710\|0\|0\|12045\|194784` |
| 13 | Ex-burst residual rate | `round(100.0*sum(tool in ('bash','edit','write') and args='{}' and sid not in (3 burst ids))/(select count(*) … ),4)` | **0.001%** (2 of 194,784) |
| 14 | `MaxTurnRequests` is never constructed | `cd …/fulcrum-harness-0.3.2 && grep -rn "MaxTurnRequests" src/` | **no output** |
| 15 | `parse_arguments` has never changed | `for v in 0.1.0 0.2.0 0.3.0 0.3.1 0.3.2; do md5sum ~/.cargo/registry/src/*/fulcrum-harness-$v/src/harness/provider/openai.rs; done` | identical function body in all five |
| 16 | No schema validator dependency | `grep -E 'jsonschema\|schemars\|validator\|garde' ~/.cargo/registry/src/*/fulcrum-harness-0.3.2/Cargo.toml` | **no output** |
| 17 | `terminated` has one read | `grep -n "terminated" …/provider/responses.rs` | writes 280/292/309/338, read **500** |
| 18 | No Responses test for the case in question | scan all 19 tests for a fixture holding both a `function_call` item and a terminal event | **zero** |

## Appendix B — upstream revisions read at source

| Repo | SHA |
|---|---|
| earendil-works/pi | `22fc026b872b4a7df22ffa94e8fa00b873128054` |
| cline/cline | `72b3d7140553a733242126e51a7c2e87efe75c64` |
| vercel/ai | `8ba3940d3dd1f3cd3c4365bbaec505c6ef0eb1e3` |
| anomalyco/opencode (ex-`sst/opencode`, a 301) | `f4107529f62fce84bd89fb9576714916b1d8a229` |
| openai/codex | `75fc67e8f4284a669eebd90ab6bc9ef7697e876e` |
| openai/openai-openapi | `f437d0eccb8ca02f47be33ccc243b849b5bb0b74` |
| openai/openai-agents-python | `64fbde5d02b42ae5f9db668eb0184cdb3fc9d775` |
| langchain-ai/langchain | `5838640178981fdd4ddcfbb03577cff4a2b5b750` |
| anthropics/anthropic-sdk-python | `5139cf2e7d07aa618a6c30b7e0c712f10ccb5ad9` |
| anthropics/anthropic-sdk-typescript | `590783078cd961a0df698d9fddc0275c65ff3afd` |
| anthropics/skills | `9d630808e4add0a7146de4af9384155d5dee350a` |
| modelcontextprotocol/modelcontextprotocol | `ac00313ff7f5e9f47b0e0d1ebdf9c0ad6411380b` |
| huggingface/smolagents | `e1249d373d58db6abc73882ee394f6bb3854c89f` |
| run-llama/llama_index | `99d7433f6f71888951379ccca9294e272442c832` |

Issue-tier only (closed source or reports without a public fix): Claude Code
#63604 / #64235 / #64176 / #63875 / #97311 / #5219 / #6695 / #83823; llama.cpp
#30773; vLLM #53269; crewAI #8195; Warp #15798; pi #6284 / #6285 / #9561 / #9643
/ #9897 / #10897; cline #14909 (closed unmerged) / #15089 (merged) / #14827 /
#13001; codex #19765; llama_index #24102; anthropics/anthropic-sdk-typescript
#1222 (closed unmerged).

**Related durable docs:**
`docs/research/silent-turn-settle-after-announcing-a-write.md` (this report extends
its §4; that report is **not** superseded — its mechanism findings were
re-verified at 0.3.2, only its pin citation and two counts are stale),
`docs/decisions/0108-*.md` (Decision 2 / Amendment 2 are the truncation half this
report's subject is explicitly *not*), `docs/decisions/0030-file-access-policy.md`
(the Boundary truth table has **no row for "no resolvable path"** — §4's fail-open
is a code-level decision the ADR does not record),
`docs/features/provider-disposition-durability.md` (accurate about the code, silent
about gap 10 in Appendix A never having run).
