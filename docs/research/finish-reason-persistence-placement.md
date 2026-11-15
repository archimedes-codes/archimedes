---
status: current
last-verified: 2026-11-15
task: tsk_89f485e0-b56d-4d68-a12e-1531f1cad0ea
verified-by: >-
  Five parallel research angles + parent verification, 2026-11-15. (a) Engine source read at the
  sibling checkout `/home/daniel/Coding/Archimedes/fulcrum` @ `50bed1d`, `Cargo.toml version = "0.3.0"`
  — the source of the `fulcrum-harness = "0.3.0"` the desktop pins. (b) Desktop source at
  `/home/daniel/Coding/Archimedes/archimedes` @ `222804a3` (v0.14.0, `main`). (c) SQLite forensics
  against the READ-ONLY SNAPSHOT `file:/home/daniel/arch-research-write-stall/snap.db?mode=ro`
  (2,333,728,768 B; 325,929 `native_messages` rows; 357,348 `messages` rows; 2,259 sessions; newest
  row 2026-11-14T14:12:35). That snapshot is a WORKING FILE outside the repo, unrecoverable if
  deleted, and it PREDATES the #190 ship (`f539b86d`, 2026-11-15) by ~22 h — see Gaps. (d) Nine
  upstream projects read at source level + vendor docs + the OpenTelemetry GenAI spec. (e) Parent
  re-verification of every load-bearing figure: the struct-literal census, the footer persistence
  claim, the `mcp({})` correction, the display-row persistence route. Citations are BY CONTENT
  (function, event, struct, enum variant) not by line number, per this repo's locate-by-content rule.
issue: https://github.com/archimedes-codes/archimedes/issues/190
mirror: https://github.com/archimedes-codes/archimedes/issues/190#issuecomment-6895493131
decision: >-
  Placement C — the turn-level disposition rides `RpcEvent::turn_truncated` into the DISPLAY row
  (`messages.payload_json`) now; the `ChatMessage.finish_reason` field is deferred to a separate card
  and is NOT part of this decision.
---

# Where the provider's disposition belongs — and why the card's cheap shape is the expensive one

**The settled question (from Phase 0):** is one optional `finish_reason` on `ChatMessage` the right
place for the provider's disposition — does it stay off the provider request body, what does it cost,
and does persisting it actually make the truncated-turn rate measurable? Plus the alternative placement
(the display row), measured rather than assumed.

**The chosen answer (Phase 4): Placement C.** The disposition lands on the **display row** now — it is
cheap, durable, and reaches the only reader that has one. The `ChatMessage` field is deferred to its own
card, to be taken up only if forensics over the provider transcript demand it. The reasoning is below;
the short form is that the card's proposed field is *safe* and *semantically right* and **reaches
nothing**, while the cheap shape it names is 97 struct literals and a semver minor, not one field.

---

## Executive Summary

Five things changed the shape of this card, and three of them contradict the card's own text.

1. **The card's headline claim is already corrected in `main`, and its §1b is stale.** "Answerable
   retroactively over the data already on disk" is false — every added field is absent on all 683,277
   existing rows and `None` is indistinguishable from "stopped cleanly" on exactly that population.
   `main` carries commit `b384291b`, whose entire message is that correction. §1b's `resolve_turn` is
   now 3-way (`Cancelled > MaxTokens > EndTurn`) with a live `StopReason::MaxTokens` construction site.
2. **The hazard that made this deferred is closed, for a stronger reason than the card gives** — but it
   is closed by *three functions*, not by a type or a test, and no existing test would catch a leak.
3. **The blast radius is 97 `ChatMessage { … }` literals and a semver-breaking crate bump**, not one
   field. 8 are production. `PROTOCOL_VERSION` stays `1`.
4. **The card's field cannot make the footer durable, because the UI never reads `native_messages`.**
   Verified from both ends. "Turn ended: max_tokens" does not survive an app restart today, and the
   `ChatMessage` field would not change that.
5. **A partial instrument already shipped with #190** and is not in the card: the truncation notice is
   already persisted as a uniquely-keyed display row. That is the foundation Placement C builds on.

---

## Findings

### 1. The card, checked against the branch it was written from

| Card claim | Verdict |
|---|---|
| `ChatMessage` carries no field for the finish reason | **CONFIRMED.** Four fields: `role`, `content`, `tool_call_id`, `tool_calls` (`provider_types.rs`, `pub struct ChatMessage`). |
| `resolve_turn` reduces the 4-way signal to `if cancelled { Cancelled } else { EndTurn }` | **STALE.** Since 0.3.0 it resolves `Cancelled > MaxTokens > EndTurn` off a per-session `truncated` flag set by `router.rs`'s `turn_truncated` arm. `StopReason::MaxTokens` now has a live construction site; the card's "`MaxTokens` ×0" was true pre-#190. |
| No row carries a provider disposition | **CONFIRMED** — re-run, see §7. |
| The instrument trap (`LIKE` → 669 false hits) | **CONFIRMED and WORSE.** See §7 — the trap also fires in the *other* direction. |
| "No migration" | **CONFIRMED.** The schema pins *columns*; `content_json` is one opaque `TEXT`. `schema-sha.txt` and the daemon's `verify_shapes` compare DDL only — a JSON key is not schema drift in either repo's instrument. |
| "old rows deserialize as `None`" | **CONFIRMED**, empirically — 325,929/325,929 rows lack the key and every one deserializes today. |
| "one `#[serde(default, …)]` field" | **The `default` is redundant.** Serde's `missing_field` gives `Option<T>` a `None` for free; the two existing fields on this very struct carry `skip_serializing_if` **without** `default` and deserialize from old rows today. Harmless, but the justification should not claim it is required. |
| "~25 B × assistant rows ≈ 3.6 MB = 0.15%" | **Right in magnitude, wrong in unit.** See §6. |
| "the field must not leak into a provider request body … verify on all three builders" | **VERIFIED CLOSED, and the verification is the weakest part of the plan.** See §2. |
| "makes the question answerable **retroactively** over the data already on disk" | **FALSE — and already corrected on `main` by `b384291b`, independently of this session.** See §8. |

### 2. The leak hazard: closed by two independent facts, and untested

All three message functions are **field-by-field whitelists** that construct a fresh `Value` and name
only four fields:

| Builder | Mechanism | Leaks? |
|---|---|---|
| `request_body` (`harness/provider/openai.rs`) | `let mut obj = serde_json::Map::new();` → `insert` exactly `role` / `content` / `tool_call_id` / `tool_calls` → `Value::Object(obj)` | **No** |
| `anthropic_messages` (`harness/provider/anthropic.rs`) | `json!` literals per role; tool rows → `tool_result`, calls → `tool_use`; final `out.push(json!({ "role": role, "content": content }))` | **No** |
| `responses_input` (`harness/provider/responses.rs`) | Fewer fields than the input type — a tool row becomes `function_call_output` with **no `role` at all** | **No** |

Two supporting facts make it structural rather than incidental:

- **`ModelRequest` is not `Serialize`** (`#[derive(Debug, Clone)]`). "Serialize the request wholesale" is
  not an available operation in this codebase.
- The three builders are the **only** completion POSTs (`grep -rn "\.json(&" src/harness/provider/` →
  `anthropic_request_body`, `responses_request_body`, and `b.json(body)` for OpenAI), `Provider` has
  exactly one method, and `grep -rn "serde_json::to_value" src/` has **no** hit on a `ChatMessage`,
  `Vec<ChatMessage>`, or `ModelRequest`. `WireToolCall` is a dedicated 3-field borrowed view — the repo
  already models "a wire shape is not the storage shape" as its own type.

**Every other route, traced.** `compact::summarize` clones real transcript messages (field included) into
the summariser's `ModelRequest` — still through the same builders, still dropped. The titling call
(`agent/session/naming.rs`) builds **one fresh literal** and consumes loaded messages only through pure
readers (`first_exchange_text`, `count_user_interactions`, `multi_turn_exchange_text`) — no loaded message
is ever placed in a request. `harness/loop/codemode.rs` never constructs a `ModelRequest`. The desktop has
**zero** `.json(&…)` calls in production — every completion goes through the crate's `Provider`.
`fulcrum/src/db/mod.rs` (the daemon member) mentions `ChatMessage` in prose only and stores `content_json`
opaquely.

**The resume route — the hazard made real, then closed.** This is the route the card's "built fresh per
wire" phrase is papering over, so it was traced end to end:

1. `persist_transcript_message` → `serde_json::to_string(&m)` → `Store::insert_message`;
2. `SessionStore::load_messages` → `Db::load_native_messages` → `SELECT content_json … ORDER BY seq` →
   `serde_json::from_str` — **this is where the value comes back**;
3. `agent/session/mod.rs`'s resume arm → `StartEnv::from_parts(…, transcript, …)`;
4. `worker/core.rs`'s `(StartMode::Resume, _)` arm → `loop_.load_transcript(messages)`;
5. `load_transcript` assigns `self.messages = messages` **verbatim, no filtering**;
6. `model_request` → `messages: self.messages.clone()` → `provider.complete(&req)` → the builder.

So a resumed row **does** reach a request-body builder carrying `Some("length")`, and each builder drops
it. The round-trip is faithful in the database and does not exist on the wire.

**⚠ The residual risk is not the builders — it is that a leak would be silent.** Zero key-set equality
exists on any wire message in either repo (`grep "as_object()"` over `src/harness/provider/*.rs` → 0
hits; over `src-tauri/tests/*.rs` → only `skills.rs`, unrelated). The pattern *does* exist in-repo —
`seams.rs`'s `keys_of_names` pins `MoveOutcome` to "exactly its three contract fields" — it was simply
never applied to a wire message. Every `request_body_*` / `anthropic_request_body_*` /
`responses_request_body_*` test asserts **presence**, not exclusivity. The closest thing to a catch-all is
`!body.to_string().contains("cache_control")`, which hunts one literal and would sail past this one.
**The card's "verify on all three builders" is a one-time verification with no pin behind it**; a plan that
does the verification without adding a key-set assertion leaves the next wholesale-serialize refactor free
to reopen it.

**And the failure is neither hypothetical nor distant.** In-repo, `send_model_request`'s docblock already
carries a defensive retry because *"a few strict proxies reject the unknown field with a 400, which would
otherwise be a `Fatal` on EVERY model call"*; the issue #122 guard documents that LiteLLM's
`_sanitize_empty_text_content` *"rewrites it … and SAVES that back into history"*, i.e. a leaked field
could become self-perpetuating history authored by our own shape. ADR 0054 states the governing rule: *"a
wire that forwards `messages` verbatim is a bug."* Externally, this exact bug class is documented in three
harnesses:

- `NousResearch/hermes-agent#48523` — **the closest match to our shape**: a SQLite-rehydrated
  `finish_reason` reaching `messages[]`, `400 Extra inputs are not permitted, field:
  'messages[1].timestamp'`. Its companion `#47868` records the reason it survives to production: the
  identical payload 400s on one model and 200s on two others.
- `xberg-io/liter-llm#292` — the same mistake **in Rust**, on a dual-use struct: *"The same struct is also
  used for request history, though, so multi-turn conversations re-send the response-only field on input."*
- `run-llama/llama_index#14701` — Groq: *"property 'status' is unsupported"* after a response message was
  persisted into chat history and replayed.

### 3. Blast radius: 97 literals and a semver minor

Verified by the parent (a naive grep says 72 + 40; it counts prose, `-> ChatMessage {` signatures, the
struct declaration, and a doc comment — and `target/package/fulcrum-harness-0.3.0/` doubles every count):

| Site class | Count | Instrument | Needs an edit? |
|---|---:|---|---|
| Engine `ChatMessage { … }` literals | **65** (7 prod / 58 test) | grep − struct decl − fn sigs − comment lines − the 1 pattern | **Yes — all, `E0063`** |
| Desktop literals | **32** (1 prod / 31 test) | same | **Yes** |
| **Total** | **97** (8 prod / 89 test) | | |
| Rest patterns (`..Default::default()`) | **0** | body scan | — |
| `Default` impl/derive on `ChatMessage` | **0** | derive line reads `Debug, Clone, PartialEq, Serialize, Deserialize` | adding it is **recommended against** |
| Exhaustive destructures | **0** | the one pattern (`compact.rs`'s `if let Some(ChatMessage {`) already has `..` | **No** |
| `PROTOCOL_VERSION` | stays **1** | its own doc: *"an ADDITIVE frame (a new `type`, a new **optional field**) does NOT bump it"*, pinned by `the_task_frames_are_additive_so_the_protocol_version_stays_one` | **No** |
| DB migration / `schema-sha.txt` | **0** | opaque `TEXT`; the pins compare DDL | **No** |
| Desktop crate pin | **1** | `src-tauri/Cargo.toml` | **Yes → 0.4.0** |

Production sites, located by content: `loop/turn.rs` ×3 (the user push, the **truncated-assistant push**,
the tool push), `loop.rs` ×2 (`prepend_system`, the clean assistant push), `compact.rs` ×2 (`summary_msg`,
the summariser's `system`), and desktop `naming.rs` ×1 (the titling message). The truncated-assistant push
is the one that actually wants the field.

**Do not add `#[derive(Default)]` to make the edit cheaper.** `ChatRole` would default to `System` and
`MessageContent` to `Text("")` — plausible-looking *wrong* answers that let a fixture silently drop its
role. The repo's own rule (`config_types.rs`, `AgentOverrideFields`) is that a derived `Default` is safe
"HERE and only because every field is an `Option`". The 97-site edit is the honest cost, and the compiler
enumerates every site for free.

**The bump is forced, not chosen.** `ChatMessage` is re-exported
(`agent/harness/mod.rs` → `pub use fulcrum_harness::harness::{ChatMessage, …}`) and the desktop is a
*constructor* of it (32 sites), so a new `pub` field on a published crate's public struct is
semver-breaking. `src-tauri/Cargo.toml`'s own comment records the precedent: the 0.2.0 → 0.3.0 bump
happened because `ToolCtx::task_store` was *"a BREAKING field on a public struct, which is why this is a
minor bump and not a patch."* So: engine 0.4.0, publish, desktop pin bump, two-repo lockstep.

**Three tests break loudly** (they compare a harness-produced message against a whole-struct literal):
`text_response_emits_normalized_events_and_persists_transcript` and
`load_messages_reconstructs_the_transcript_for_resume` (desktop `tests/harness_loop.rs`), and
`the_store_trait_speaks_the_crate_chat_message` (engine `harness/store.rs`). **Three go silently
vacuous** (`insert_and_load_round_trip`, `insert_is_idempotent_on_conflict`,
`tool_transcript_round_trip_preserves_tool_calls_and_ids`) — they round-trip through a bare `from_str`, so
both sides decode `None` and stay green having stopped testing their claim.

**A machine-local trap:** `.cargo/config.toml` is **absent** in this desktop checkout (only
`config.toml.example`), so the desktop resolves `fulcrum-harness` from **crates.io** and an engine-side
edit is invisible until you copy the example — and that example warns a stale
`[patch."https://github.com/…"]` table **exits 0 while building the published crate**. Any plan assuming
"edit the engine, the desktop picks it up" is wrong as configured.

### 4. Placement: `native_messages` has no reader in the UI

Verified from both ends.

| | `native_messages.content_json` | `messages.payload_json` |
|---|---|---|
| What it is | The provider transcript, one row per `ChatMessage` | The render transcript, one row per `DisplayRow` |
| Key | `(session_id, seq)` — positional | `(session_id, kind, message_key)` — semantic, **incarnation-stamped** |
| Payload shape | A **fixed 4-field type** | **Seven untyped keys**, shape varies by `kind` |
| Writer | `persist_transcript_message` → `Db::insert_native_message` | `EmitPipeline::run` → `normalize` → `compute_display_rows` → `persist_display` → `Db::record_message(s)` |
| Reader | **Resume only** → `StartEnv.transcript` → `load_transcript` → **the model** | **The UI only** → `load_history` → `rowToMessages` → `MessageList` |
| Rendered? | **Never** — no IPC command reaches the table (`grep` over `commands/` finds it only in a doc comment) | **Always** — the sole render source on `openSession` and the `resumeSession` reload |
| Cost to add a field | **97 literals + engine 0.4.0 + pin bump** | **Zero** struct literals — a key in a `Value` |

The engine cannot even read it back: `IpcStore::load_messages` is a hard error — *"worker store is
write-only — resume is rehydrated via the start envelope"* — and the daemon's `Db::messages_for` has zero
production callers.

**Consequence the card does not state: putting the field on `ChatMessage` does not make the footer
durable.** And the footer is not durable today — verified four ways: `stopReasons` has exactly one writer
(`turnCompleted`, `sessions.ts`), **no `zustand/middleware` `persist` anywhere in `src/store/`**, it is a
member of the `SESSION_KEYED_FIELDS` reset list (which pins it as *cleared*, never *restored*), and neither
`openSession` nor `resumeSession` touches it. After a restart the map is `{}`, `TranscriptFooter`'s
predicate `(inTurn || !stopReason || stopReason === "end_turn")` short-circuits on `!stopReason`, and the
line renders nothing for every session, truncated or not.

**On the display row, the disposition lands naturally and survives.** `normalize`'s `turn_truncated` arm
emits `unique_system_chunk(&st.truncate_id(), …)` → an `agent_message_chunk` on `{stamp}:truncate:N` →
`compute_display_rows` → `persist_display`. `truncate_id()` reads-then-advances a per-`TurnState` counter
and the ADR 0049 stamp distinguishes incarnations, so the key is unique per notice and never re-emitted;
`ON CONFLICT(session_id, kind, message_key) DO UPDATE` therefore cannot clobber it. Two caveats for a
plan: the only thing that *does* overwrite a display row is a deliberate `message_retracted` (empty-text
overwrite, no DELETE in the store), and **a `NULL` `message_key` never collapses in SQLite** — the 328
`user` rows (all `NULL` keys, `count(distinct message_key) = 0`) prove it — so a disposition must not ride
a `NULL` key.

### 5. Two technical corrections to the proposed spelling

**(a) `skip_serializing_if = "Option::is_none"` is correct and load-bearing. `skip_serializing` is wrong
and would silently kill the feature.** One research angle recommended the unconditional
`#[serde(default, skip_serializing)]`, citing `config_types.rs`'s `subagent_models`. That citation is real
but the direction is inverted: `subagent_models` is skipped *because it must never be written* — the
comment says the unconditional form *"is what makes the dead key disappear from the file on the next save,
permanently."* Our value must be **written into `content_json`** — that is the entire point — and merely
never reach the HTTP body, which the builders already guarantee. `skip_serializing_if` is what keeps
`"finish_reason":null` off all 325,929 rows; without it, the byte-exact `content_json` pins in
`worker/client.rs`'s `clamp_placeholder_row` tests go red and every row grows.

**(b) `Option<String>`, not `Option<FinishReason>` — for a reason stronger than size.** The serde output is
byte-identical either way (`#[serde(rename_all = "snake_case")]` ⇒ `"length"`, not `{"Length":…}`), so the
usual objection does not apply. The real one: there is **no `#[serde(other)]` anywhere** in either repo
(the only textual hit is a comment *arguing against* it), so a typed field makes a 5th variant a **one-way
door on durable user history** — an old build reading a future `"refusal"` row hard-fails
`decode_inbound` and **resume breaks**. And `map_finish_reason` already **discards the provider's raw
word** today (unknown → `FinishReason::Stop` + `eprintln!`; pinned by `finish_reason_mapping` asserting
`content_filter → Stop`), with `anthropic.rs` doing the same for an unknown `stop_reason`. An
`Option<String>` fed from the **raw wire string** would be the only place that truth survives — a
capability gain, not just a safety choice. Near-unanimous external precedent for keeping the raw word:
pi `rawStopReason`, opencode `rawFinish`, vercel AI SDK `rawFinishReason` (paired with a `unified` enum),
rig `FinishReason::Other(String)` *"carried verbatim in the provider's own wire spelling"*.

### 6. Cost, measured — and the card picked the most flattering denominator

Population on the snapshot: `tool` 176,227 · **`assistant` 145,004** · `user` 2,402 · `system` 2,296 =
325,929. Assistant `content_json`: mean 1,012 B, total 146.8 MB, max 226 KB. **142,792 of the 145,004
assistant rows carry `tool_calls`** — the `FinishReason::ToolCalls` proxy — so 98.5% of assistant rows are
the case where the disposition is already implied by the row's own shape.

Exact literal costs (serde compact): `,"finish_reason":"stop"` 23 B · `:"tool_calls"` 29 B · `:"length"`
25 B · `:"error"` 24 B.

| Variant | Rows written | Logical | **Physical** | % of file | % of table | % of assistant payload |
|---|---:|---:|---:|---:|---:|---:|
| **A — every assistant row** (weighted 28.908 B) | 145,004 | 4.19 MB | **4.50 MB** | **0.193%** | **0.611%** | **2.86%** |
| **B — only non-`Stop`/non-`ToolCalls`** | ≤2,212 | 55 KB | **125 KB** | **0.0054%** | 0.017% | 0.085% |
| *card's* `25 B × 145,004` | 145,004 | 3.63 MB | — | 0.155% | — | — |

Three corrections to the card's arithmetic: **25 B is only right for the value `length`** (unconditional
writing pays the weighted 28.908 B); it ignores **overflow-page alignment** (+70 pages measured by
replaying SQLite's overflow algorithm — `page_size 4096`, 17.7% of rows already exceed a page); and
**0.15% is the most flattering of three plausible denominators**. `page_count` 569,758 × 4096 = exactly the
file; `freelist_count` 17,375 = **67.9 MB free** with `auto_vacuum = 0`, so both variants are absorbed
today and nothing ever returns. The honest unit is the growth rate: the measured 3,528 assistant rows/day
make variant A **≈37 MB/yr** and variant B **≈0.5 MB/yr**, against ~1.3 GB/yr of organic assistant-JSON
growth.

The `dbstat` footprint also puts the two stores in proportion: `messages` 1.45 GB, `native_messages` 736 MB.
The companion size doc (`docs/research/database-size-unbounded-transcript-growth.md`, untracked) argues the
display table is *"where the bytes already are and the model never reads it"*, and that per-row bytes on a
type cloned per turn are what bite — which is an argument for the display row on both grounds.

### 7. The census, re-run — and the instrument trap fires both ways

Sound instrument (key-level), both tables:

```sql
select
 (select count(*) from native_messages where json_extract(content_json,'$.finish_reason') is not null),
 (select count(*) from native_messages where json_extract(content_json,'$.stop_reason')  is not null),
 (select count(*) from messages        where json_extract(payload_json,'$.finish_reason') is not null),
 (select count(*) from messages        where json_extract(payload_json,'$.stopReason')    is not null);
-- 0|0|0|0
```

`json_tree` over both tables for `key = 'finish_reason'` returns **0 rows at any depth**. The complete
top-level key set of `native_messages` is `role` · `content` · `tool_call_id` · `tool_calls` — nothing
else exists. Eight key-level probes across `messages`, `native_messages` and `sessions.capabilities_json`
all return 0; `sessions` has no disposition column (12 columns, verified by `pragma table_info`);
`messages.kind` has no fifth value.

The trap, re-measured:

| Instrument | Hits | Truth |
|---|---:|---|
| `content_json LIKE '%finish_reason%'` | **669** | **0** — 554 `tool` / 96 `assistant` / 10 `system` / 9 `user`, all source code and prose this repo's agent read and wrote |
| `payload_json LIKE '%finish_reason%'` (`messages`) | **842** | **0** |
| `LIKE '%"finish_reason":"length"%'` | 0 | 0 — **correct by luck only** |
| `LIKE '%truncated%'` on `messages` | 147,112 | 143,188 real keys — **+3,924 wrong (2.7%)** |
| `LIKE '%native_messages%'` on `native_messages` | 3,686 | **0** — 100% wrong |

So `LIKE` fails in **both** directions, and the quoted form passes only because no row happens to quote the
exact serialized form. The rule: **`json_extract` for a top-level key, `json_tree` for any depth, `LIKE`
never.** A second live instance while measuring: `LIKE '%missing%parameter%'` returned 1,777 rows where
the sound `IN (…)` on the four exact executor refusals returns **592**; and a `GLOB '*: missing *'`
returned 799 because a `read` result's text begins with a doc header the `*` prefix spans.

### 8. Measurability — what the field buys, and what it does not

**Prospectively:** a clean, complete, attributable instrument — truncated turns countable by wire, model
and thinking level, and (with a usage object, a separate change) costable.

**Retroactively: nothing about existing rows.** Every added field is absent on all 325,929 + 357,348
existing rows, and *correctly* so. This is not a quibble — the card's sentence pointed a maintainer at
2.33 GB of transcripts for an answer that data cannot give. `main`'s `b384291b` says the same thing in its
own commit message: *"Rows written before the field exists never stored a finish reason, so there is
nothing to read back."*

**What IS answerable today, with no new field — the proxy census.** Re-run by the parent against the
snapshot. The ADR 0108 signature (`tool_calls[].arguments = {}` on an argument-bearing tool):

| tool | calls | verdict |
|---|---:|---|
| `list_skills` | 326 | legitimate — takes no arguments |
| `bash` | 292 | pathological |
| `edit` | 244 | pathological |
| `list_agents` | 32 | legitimate |
| `write` | 19 | pathological |
| `mcp` | 11 | **legitimate — correction below** |

**Correction to ADR 0108: the pathological count is 555, not 566.** The 11 `mcp` calls are a documented
`status` probe (`mcp_tool` treats an argument object naming no `tool`/`search`/`describe`/`connect`/
`server`/`action` as `status`); their paired results read `Wizards: Connected` ×4 and `Wizards:
Disconnected` ×7 and all 11 settled `completed`. The ADR's conclusion is unaffected; its figure is.

All 555 pathological calls have a paired `tool` row, and every refusal text is one of exactly three
executor strings (`bash: missing \`command\` parameter` 294, `edit: missing …` 272, `write: missing …` 24);
all 555 display rows settled `failed`. Corroboration is total.

**The rate — and it is a floor.** 555 / 145,004 assistant rows = **0.38%**; 555 / 176,716 tool calls =
0.31%; **16 of 2,203 sessions** carry at least one. But **96.3% of hits come from two degenerate subagent
sessions** (303 and 242 *consecutive* empty-argument calls — a gateway loop or mis-advertised schemas, not
random truncation). Excluding them: **21 hits in 131,848 assistant rows = 0.016%**, with a two-day spike
(2026-10-29 at 5.07%, 10-30 at 2.23%) over a 0.02–0.11% baseline. Three reasons this is a **lower bound**:
a `length` cut **mid-sentence** leaves an assistant row with text and no trace at all; the **Responses**
wire drops the cut-off call entirely, so that route is blind by construction; and all 90 sessions that
record a thinking level record `xhigh`, so "xhigh is worse" is **unfalsifiable on this database**.

One instrument that looks like a signal and is not: 86,346 display turns carry a thought with no
`agent-text` on the same `m{N}` base. That is **not** a 68% truncation rate — 101,551 of 142,792
tool-calling assistant rows (71%) legitimately have empty text, because `MessageContent` is a single enum.
Anyone reading that number as truncation overstates by ~2 orders of magnitude.

### 9. A partial instrument already shipped with #190, and its one blind spot

`normalize`'s `turn_truncated` arm already routes through `compute_display_rows` → `persist_display`, so
**from the #190 ship forward there is already a durable, uniquely-keyed, queryable row per truncated
turn** (`kind='agent-text'`, `message_key='{stamp}:truncate:N'`, `payload_json.text = "Response was
truncated before completion"`). The snapshot shows 0 such rows, which is **expected** — it predates the
ship by ~22 h — not evidence of absence. Placement C extends this rather than inventing a second channel.

Its two limits: the row's payload is prose, so the reason is not attributable to wire/model/level; and
`is_bookkeeping_message_id` answers true for the `truncate` field, which excludes the notice from a
subagent's captured text (`subagent_flow.rs`, pinned by a `worker/manager/tests` test) — so **a truncated
subagent turn is invisible to its parent either way.** That is a separate defect worth its own card.

### 10. External precedent — placement and vocabulary

- **OpenAI puts `finish_reason` on `choices[]`, never on `message`.** `ChatCompletionRequestAssistantMessage`
  has `content, refusal, role, name, audio, tool_calls, function_call` and no `additionalProperties`
  constraint; `Choice` carries `finish_reason`. Its own conversation-state guide replays
  `completion.choices[0].message` — dropping the reason by construction. **There is no OpenAI-documented
  precedent for an assistant message carrying a stop reason on the way back in.**
- **The Responses wire is the exception**: `status` / `incomplete_details.reason` are on the stored
  response *and* per-item `OutputMessage.status` is legal input. That asymmetry is live —
  `openai/codex#56850` is a truncated `function_call` replayed on every later turn, 400-ing a thread for
  7 hours.
- **Anthropic is the sharpest case** because its response message and request message are the same object
  minus the envelope. Its input type is `{role, content}` only (`assistant_message_param.py`), and it is
  strict-schema — `Extra inputs are not permitted` is documented for a dozen fields. **Its own docs
  demonstrate the correct move: send `response.content`, not `response`.** Gap, stated honestly: no
  documented instance of `stop_reason` specifically being rejected on input. Do not treat that as refuted.
- **Harnesses split on placement.** Turn/response-level: codex (`TurnComplete`/`TurnAborted` events;
  provider `incomplete` is an *error variant*, `ResponseIncompleteError`, not a message field), vercel AI
  SDK (`StepResult.finishReason` + `rawFinishReason`; `AssistantModelMessage` has no such field).
  On-message-and-never-copied: opencode (`finish` + `rawFinish` in a JSON column, projected out by
  `to-llm-message.ts`), pi (`stopReason` + `rawStopReason`, and its Responses path **hardcodes**
  `status: "completed"` on replay rather than echoing the stored one), rig (`AssistantMessage.stop`),
  LangChain (`response_metadata.finish_reason`, projected out by an explicit per-role allowlist). The one
  project that put it *inside* the replayed object — Claude Code, `message.stop_reason` — reports it is
  written as `null` on every line (`anthropics/claude-code#27361`).
- **The Rust idiom, if the `ChatMessage` card is ever taken up:** `skip_serializing_if` + a field-by-field
  builder is what fulcrum already is; the accepted alternative is a dedicated projection stage
  (rig's `ReplayTarget::states_finish_reason()`, vercel's `convertToModelMessages`, LangChain's
  `_convert_message_to_dict`). `#[serde(flatten)] extras` is a *toleration* sink that round-trips by
  construction — the wrong tool for "persist but never emit".
- **The vocabulary already exists and is cross-vendor:** OpenTelemetry GenAI's
  **`gen_ai.response.finish_reasons`** (`string[]`, Recommended on the inference span, Development
  stability), enum `{stop, length, content_filter, tool_call, compaction, error}`, with spec guidance to
  emit `error` when a stream ends before a terminal event and an explicit note that an `incomplete`
  response maps to the truncation member — i.e. it **endorses our `incomplete_details.reason → Length`
  fold**. Two of its six values have no home in a 4-variant enum, and its spellings disagree with the AI
  SDK's. **It has also deprecated the per-message location** (`OutputMessage.finish_reason`: *"report
  finish reasons in `gen_ai.response.finish_reasons` instead"*) — a data point for turn-level placement,
  against the message-level placement most harnesses chose.
- **No published truncation-rate metric exists.** `gen-ai-metrics.md` contains zero occurrences of
  `finish`/`length`/truncat*; LiteLLM's documented `StandardLoggingPayload` has no `finish_reason` field
  (only the raw `response` object or the OTel span).

---

## Evidence

**Verified at HEAD** — engine `fulcrum` @ `50bed1d` (`v0.3.0`, confirmed the tag points at HEAD); desktop
`archimedes` @ `222804a3` (v0.14.0, `Cargo.lock` pin `fulcrum-harness 0.3.0`, checksum
`fc49c39a…`). One angle read the desktop on `main` while `origin/stack/silent-turn-settle` differed only in
version strings for the files in question, so those findings hold on both.

**Parent-verified independently** (not taken from a subagent): the 97-literal census and its 8/89 split;
`loop.rs`'s first `#[cfg(test)]` is a `use` statement and not the test boundary (a naive boundary heuristic
mislabels its 2 production literals as test); zero `zustand/middleware` in `src/store/`; the four
`stopReasons` sites; `EmitPipeline::run` persisting every normalized frame; `is_bookkeeping_message_id`
including `truncate`; the `mcp({})` status-probe correction (paired results read `Wizards: Connected`/
`Disconnected`); the 0 `truncate:` rows and 28 `Retry failed` rows in the snapshot; `config_types.rs`'s
`subagent_models` rationale (which is the *opposite* direction from what one angle concluded).

**Credibility.** Official SDK source and vendor docs (OpenAI OpenAPI, Anthropic SDK, OpenTelemetry spec) =
high. Project source read at pinned SHAs (codex `ee344ca9`, opencode `d432a06b`, pi `61110626`, vercel/ai
`8ba3940d`, rig `8c1a2e19`, liter-llm `35c536f4`, hermes-agent `ce4de3cd`, langchain `ea17e48f`) = high.
GitHub issues = medium (reports, not specs). Claude Code's JSONL format = **medium-low, reverse-engineered;
Anthropic does not document it**. `stdapi-ai#301`'s "OpenAI ignores unknown keys" = **low, a third-party
conformance probe, the only positive claim of its kind found**.

**Test baselines** (`cargo test --offline -- --list`, both `target/` warm, `df -h` checked first — a cold
build was the reckless option and was avoided): engine **1675** across 9 targets (1481 lib), desktop
**1023** (719 lib + 304 across 34 integration files). Use total-across-targets, not lib-only. **`--list`
proves discovery, not green** — no baseline *run* was captured.

---

## Unresolved contradictions

1. **Where the disposition belongs, in principle.** The engine-side field is semantically correct (it is
   the provider's verdict, it rides the resume path, and it survives compaction *only because* it is on
   `ChatMessage` — `run_compaction` rewrites the transcript from the in-memory `Vec<ChatMessage>`). The
   display row is cheap and reaches the only reader. The user resolved this as **C — both, deliberately,
   display row first**; that is a decision, not a resolution by evidence, and the evidence still supports
   both for different reasons.
2. **Whether 0.19% matters.** Variant A is affordable against a 67.9 MB freelist; the size doc's argument
   is that per-row bytes on a per-turn-cloned type are what bite and that the display table is where the
   bytes already are. Both are true of different stores.
3. **Message-level vs turn-level placement.** Every harness surveyed that keeps it on the message keeps it
   on a *typed* message the projection stage rebuilds; OpenTelemetry deprecates the per-message location.
   Our display row is turn-adjacent (`{stamp}:truncate:N` beside `{stamp}:m{N}`), which happens to satisfy
   both. Not a contradiction for Placement C; it is one for the deferred `ChatMessage` card.

---

## Gaps

1. **The snapshot predates the #190 ship by ~22 h.** Every `truncate:` / `MaxTokens` zero is **uninformative**.
   No post-fix DB exists yet, so the **forward rate is unmeasured** — this is the single most valuable
   missing number and re-measuring it is a cheap follow-up.
2. **Per-turn cost is unmeasurable.** `sessions.cost_usd` is a session cumulative; `context_usage_json` is
   `{used, window}` (input-side). ADR 0108's Falsifier's cost half needs a usage object — a strictly
   separate change.
3. **`xhigh` is the only recorded thinking level** (90 sessions, no contrast class), so any claim that
   reasoning effort drives truncation is unfalsifiable on this data.
4. **No official statement** that unknown in-message keys are ignored on the Chat Completions wire — one
   third-party conformance probe, low credibility. And no documented instance of Anthropic rejecting a
   replayed `stop_reason` specifically.
5. **The two degenerate subagent sessions cannot be attributed** — the schema has no `parent_session_id`,
   so the DB cannot distinguish "the gateway truncated 303 argument lists in a row" from "the child's tool
   schemas were mis-advertised".
6. **`role` column ≠ `$.role` on 50 rows (0.015%)**, concentrated in 4 sessions, alternating pairwise — a
   pre-existing anomaly that makes the denormalized `role` column untrustworthy as a census filter. Use
   `json_extract(content_json,'$.role')`. Immaterial to the totals above (25 rows / 400 B).
7. **No baseline `cargo test` run** (only `--list`), and no `pnpm test` run at all this session.
8. **The subagent blind spot** (§9) is documented, not investigated — a truncated child is hidden from its
   parent by `is_bookkeeping_message_id`, and whether that is right is an open question.

---

## What the evidence supports as the fix (not a decision — `specify` owns that)

Placement C, in cost order:

1. **Put the disposition on the display row.** `turn_truncated` already produces a persisted
   `{stamp}:truncate:N` row; give it a machine-readable disposition (a key on the row's payload, or a
   sibling row) so a reloaded Session can render the footer. Zero struct literals, no version bump, no
   wire change, ~30 B per truncated turn. **Do not ride a `NULL` `message_key`** (§4).
2. **Make the footer durable across restart** — the reader half. `stopReasons` is ephemeral by design and
   is in the reset list; hydration must come from the row, not the store.
3. **Add the key-set assertion** on all three builders (`keys_of`-style, mirroring `seams.rs`), so the
   leak-safety that today rests on three functions is pinned. This is cheap and it is the thing the card's
   "verify on all three builders" should have left behind.
4. **Match `gen_ai.response.finish_reasons`** for the vocabulary if a value is written (`stop`, `length`,
   `content_filter`, `tool_call`, `compaction`, `error`) — do not invent one.
5. **Correct ADR 0108's figure to 555** and note the `mcp({})` status probe.
6. **Defer the `ChatMessage` field** to its own card, carrying: `Option<String>` fed from the **raw wire
   string** (not the folded enum), `skip_serializing_if` **not** `skip_serializing`, no `Default` derive,
   97 literals, engine 0.4.0 + pin bump + two-repo lockstep, the `.cargo/config.toml` trap, the 3 loud +
   3 silent test breaks, and variant B (non-`Stop`/non-`ToolCalls` only, 125 KB not 4.5 MB).
7. **Separate cards, found here:** the subagent truncation blind spot; the `role`-column anomaly; the
   `serde_json::to_string(&m).unwrap_or_default()` hazard that would write a corrupt row rather than
   error if a non-serializable field ever reaches `ChatMessage`.

---

## Appendix — re-runnable instruments

```bash
# Struct-literal census (a naive `grep -c 'ChatMessage {'` over-counts by prose, fn sigs,
# the struct declaration, and the vendored target/package/ copy):
cd /home/daniel/Coding/Archimedes/fulcrum && \
  grep -rn "ChatMessage {" --include=*.rs src \
    | grep -v "pub struct ChatMessage {" | grep -vE "\) -> ChatMessage \{" \
    | grep -vE ":[0-9]+:\s*(///|//|!)" | grep -v "if let Some(ChatMessage {" | wc -l      # -> 65
cd /home/daniel/Coding/Archimedes/archimedes && \
  grep -rn "ChatMessage {" --include=*.rs src-tauri/src src-tauri/tests \
    | grep -vE "\) -> ChatMessage \{" | wc -l                                            # -> 32

# Production/test split: find the file's REAL test boundary. `loop.rs`'s first `#[cfg(test)]`
# is a `use` statement, not the module — the module is `#[cfg(test)] mod tests;`.
grep -n '#\[cfg(test)\]' src/harness/loop.rs        # -> 54 (use), 1706, 1733+1734 (mod tests)

# Disposition census (NEVER LIKE — see §7):
sqlite3 "file:/home/daniel/arch-research-write-stall/snap.db?mode=ro" "
select
 (select count(*) from native_messages where json_extract(content_json,'\$.finish_reason') is not null),
 (select count(*) from native_messages where json_extract(content_json,'\$.stop_reason')  is not null),
 (select count(*) from messages        where json_extract(payload_json,'\$.finish_reason') is not null);"
# -> 0|0|0

# ADR 0108's signature (555 pathological, NOT 566 — exclude mcp):
sqlite3 "file:/home/daniel/arch-research-write-stall/snap.db?mode=ro" "
select json_extract(tc.value,'\$.name') tool, count(*)
from native_messages n, json_each(json_extract(n.content_json,'\$.tool_calls')) tc
where n.role='assistant' and json_extract(tc.value,'\$.arguments')='{}'
group by 1 order by 2 desc;"

# The partial instrument that already shipped (0 today = the snapshot predates the ship):
sqlite3 "file:/home/daniel/arch-research-write-stall/snap.db?mode=ro" \
  "select count(*) from messages where kind='agent-text' and message_key like '%:truncate:%';"

# Footer durability, by reading:
grep -rn "zustand/middleware\|persist(" src/store/*.ts     # -> nothing
grep -n "stopReasons" src/store/sessions.ts                # -> 4 sites, one writer

# Cost denominators:
sqlite3 "file:/home/daniel/arch-research-write-stall/snap.db?mode=ro" "
select role, count(*), sum(length(content_json)), avg(length(content_json))
from native_messages group by role;
pragma page_count; pragma freelist_count; pragma auto_vacuum;"

# Test baselines (warm target/ only — check df -h first, a cold build is not affordable here):
cd /home/daniel/Coding/Archimedes/fulcrum   && cargo test --offline -- --list | wc -l   # 1675
cd /home/daniel/Coding/Archimedes/archimedes && cargo test --offline -- --list | wc -l  # 1023
```

---

## Amendment (2026-11-15) — shipped as Placement C, and three of this report's own claims moved

Folded in by the implementing run (desktop `3a6ff501`, engine `8741b09` / tag `v0.3.1`, crate
`fulcrum-harness 0.3.1` checksum `e2b5816b…`). The **decision stands unchanged** — Placement C, display row
now, `ChatMessage.finish_reason` deferred — and §1–§10 are left as written so the reasoning stays traceable.
Three things this report asserted are no longer true, and one is **this report's own error**:

1. **§4's "`stopReasons` has exactly one writer (`turnCompleted`)" is now FALSE — there are three.**
   `openSession` and `resumeSession` seed it from the persisted row
   (`grep -n 'stopReasons:' src/store/sessions.ts` → three writers). The claim was correct when measured and
   is precisely what the ship removed; the footer now survives a restart. Re-verified: the
   `SESSION_KEYED_FIELDS` pin is untouched at **11** — hydration reuses the existing map rather than adding a
   field, which is what Decision 3 of the plan required.

2. **§4's "the footer is not durable today" is superseded, and §8's forward-looking rate is now measurable.**
   The disposition lands as `json_extract(payload_json,'$.disposition') = 'length'` on the
   `{stamp}:truncate:N` row. §7's census instrument gains a fourth probe, and it returns non-zero **only for
   turns after this ship** — §8's "retroactively: nothing" still holds for every existing row.

3. **§"What the evidence supports" item 5's figure was corrected by the sibling card**: the pathological
   count is **555**, not 566 (the 11 `mcp` calls are a documented `status` probe). Recorded here so a reader
   of this report does not re-propagate 566.

**And one claim the PLAN made that this report's own method refutes.** The plan's Known limits said *"no
automated test drives a real `turn_truncated` through `normalize` → `compute_display_rows` → a real `Db`"*,
making a hand-run `sqlite3` query the only end-to-end proof. `src-tauri/tests/normalize_display_db.rs`
already shipped `temp_db()` + `persist_frames()` doing exactly that. The proof is now a test —
`a_truncated_turn_persists_its_provider_disposition_where_a_client_can_read_it`, which was run **RED against
the `0.3.0` pin** (`left: None / right: Some("length")`, with `kind` / `message_key` / `$.text` on that same
row all passing, so the key and not the row was what 0.3.0 lacked) and **GREEN against `0.3.1`**, unchanged
in between. This is §2's own lesson — *a pin that passes on the broken thing is worse than no pin* — applied
to the pin itself, and it is the reason the plan's manual step was replaced rather than supplemented.

**Durable home for the shipped shape, its limits, and the deferred card's cost:**
`docs/features/provider-disposition-durability.md`. This report stays as the evidence trail.
