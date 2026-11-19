---
status: current
last-verified: 2026-11-16
verified-by: >
  5 + 4 researcher angles (local code read of the pinned `fulcrum-harness` crate, the desktop tree,
  the live `~/.local/share/archimedes/` log artifacts, and web research) plus first-hand
  re-measurement of every load-bearing number in this file by the synthesising agent.
  Code located by SYMBOL, line numbers given as secondary anchors and re-verified at the pinned
  `fulcrum-harness 0.3.2`. The pin moved 0.3.1 → 0.3.2 mid-session and the mechanism was
  re-confirmed at 0.3.2 (§1). Log artifacts: `supervisor.log` + `supervisor.log.old`,
  mtime 2026-10-12, byte-identical to the artifacts the predecessor card measured.
task: tsk_6c7cabd3-9e28-4ded-92e4-397ef6206455
---

# The diagnostic log's 75% is one row re-serialised 1,388 times — and only the log pays for it

**Settled question.** *Is the card's fix shape (gate frame bodies behind a second opt-in, then add
`eprintln!` at the silent drop sites) the right response to the 71-second log rotation — and is the
byte cost what the card says it is?*

**Answer, in one line.** The dominant cost is not token deltas but the **quadratic re-emission of one
accumulating display row** (`display-upsert`, 75.30% of log bytes), **the log is the only consumer
that pays it** (SQLite and the renderer already coalesce), and the fix is therefore **one file at the
log call site — not a protocol change and not a second opt-in for "frame bodies"**, which would buy
~28 minutes rather than the card's claimed 4.7 hours.

This is a **logging** problem wearing a protocol bug's clothes.

---

## Executive Summary

1. **The mechanism is real and fully traced.** Per streamed chunk, `EmitPipeline::run` emits the
   **delta** on the sink *and* a **full snapshot** of the accumulated row via `persist_display`.
   `compute_display_rows` builds that payload as `state.current.push_str(text)` then
   `json!({ "text": state.current })` — the whole row, every chunk. Measured: **one `message_key`
   re-emitted 1,388×, line size 213 B → 2,070 B, 2,691,601 bytes = 51.3% of an entire rotated log
   file, from one row.**

2. **The card names the wrong cost.** It says "99.95% verbatim conversation token deltas". The
   delta-carrying frames are **24.14%**; the full-snapshot re-emissions are **75.30%**. The log spends
   **3.1× more bytes on redundant snapshots than on the actual streamed deltas.** Gating "frame
   bodies" gates the wrong 24%.

3. **Only the log pays.** SQLite does **not** (the batching decorator coalesces by
   `(session_id, kind, message_key)`, last-wins, intermediates dropped before any write). The renderer
   does **not** (`StoreFrame::Display` reaches only `TranscriptPersister::apply` — a write path with no
   sink/emit; the webview receives the delta `sink-frame`, coalesced into rAF batches). So this is not
   a CPU-per-turn bug a user feels; it is a diagnostic-survivability and privacy bug.

4. **The card's headline reachability claim is refuted.** `eprintln!("harness: …")` from the Worker is
   **not** "unreachable by a user". It is piped to the Supervisor, whose `debuglog` **is** initialised.
   The card's causal chain has a broken middle link (§5). The real reachability failures are four
   others, each independently sufficient.

5. **The industry answer is unanimous and the predecessor doc already contained the refutation.**
   4/4 vendor-primary sources (Anthropic, OpenAI ×2, ACP) ship **deltas per chunk** and full objects
   only at stream end. `compute_display_rows`'s own docblock calls itself *"the ACP-era persistence,
   unchanged"* — **ACP moved whole-message upserts off the streaming path; this code kept them on it.**

6. **Four of the card's eight checkable claims do not survive measurement** (§8 scorecard), including
   the 4.7 h retention prediction, the "9 `eprintln!` sites" count (it is 12), and the "702 `attention:`
   lines in `.old`" witness — which is the exact substring-in-JSON-payload trap the card itself warns
   about two sentences earlier.

---

## Findings

### 1. The producer: one chunk, two frames — a delta and a full snapshot

`fulcrum-harness` `src/harness/loop/emit.rs`, `EmitPipeline::run` (`:47-61` at 0.3.1, `:53-58` at 0.3.2):

```rust
for u in &updates {
    self.sink.emit(
        "session-update",
        json!({ "sessionId": self.session_id, "update": u }),   // ← the DELTA
    );
    let rows = compute_display_rows(u, self.text_acc, self.tool_state, self.thought_state);
    let _ = self.store.persist_display(self.session_id, &rows); // ← the FULL SNAPSHOT
}
```

`src/normalize.rs`, `compute_display_rows`, the `agent_thought_chunk` arm (`:730-732` at 0.3.2):

```rust
state.current.push_str(text);
let row_key = format!("{}#{}", state.open_key.as_ref().unwrap(), state.next);
let payload = json!({ "text": state.current });   // ← the WHOLE accumulated text
```

The `agent_message_chunk` arm does the same via `entry.push_str(text)` (`:764`).
`src/worker/store.rs`, `IpcStore::persist_display` (`:103-108`) frames it verbatim — `rows:
rows.to_vec()`, no coalescing, no diffing:

```rust
fn persist_display(&self, session_id: &str, rows: &[DisplayRow]) -> Result<(), StoreError> {
    let _ = self.outbound.send(Outbound::DisplayUpsert {
        session_id: session_id.to_string(),
        rows: rows.to_vec(),
    });
```

**Which kind of quadratic.** Not row-count growth — **row-size growth**. One `agent-thought` row whose
`text` accumulates, re-serialised per chunk. Measured over `supervisor.log.old`: 2,320 `display-upsert`
lines cover only **23 distinct `message_key`s**, and the top key alone accounts for 1,388 of them.

```
m18#18 re-emitted 1388 times; total bytes 2,691,601 = 51.3% of the whole .old file
first 5 line sizes: [213, 216, 235, 238, 256]
last  5 line sizes: [2070, 2070, 2070, 2070, 2070]
```

The flat 2,070 tail is the `MAX_LINE_BYTES` cap (2,048 + the `…` marker + envelope), so **the row long
ago blew past the truncation limit and the log has been writing 2 KB of mid-JSON garbage per chunk
ever since.** 76.5% of `display-upsert` lines are truncated; 19.2% of all inbound frame lines are.

**Verified at the current pin.** The desktop moved `fulcrum-harness` 0.3.1 → 0.3.2 mid-session
(`Cargo.lock:1665-1666`). `state.current.push_str` / `payload = json!({ "text": state.current })` /
`rows: rows.to_vec()` are all present and unchanged at 0.3.2, as are both frame-log sites
(`worker/client.rs:445`, `:626`).

### 2. The blast radius: the log is the ONLY consumer that pays

| Consumer | Pays the quadratic? | Evidence |
|---|---|---|
| **`supervisor.log`** | **YES — 75.30% of bytes** | `worker/client.rs:445` logs every inbound frame verbatim |
| **SQLite `messages`** | **NO** | `storage/batching.rs` doc `:26-36`: *"A later `Display` row for the same key is a complete snapshot, so LAST-WINS is the upsert's own semantics and **dropping the intermediates loses nothing**"* |
| **Renderer / IPC** | **NO** | `StoreFrame::Display` is handled only by `TranscriptPersister::apply` (`persist.rs:169`) — a write path, no `sink.emit`, no Tauri `emit`. The webview gets the delta `sink-frame`, coalesced into rAF batches (`src/store/sessions.ts:2678`, and `sessions.test.ts:2334` names the ~1000 events/sec rate explicitly) |

The `ON CONFLICT` upsert (`storage/db.rs:1511-1527`, `record_message`) collapses
`(session_id, kind, message_key)` to one row, and the batching decorator means the intermediates never
reach the DB at all. **Both real consumers already solved this; the log is the one consumer that
records every intermediate.**

**Consequence for prioritisation.** A protocol-level delta-frame fix would save Worker serialisation
CPU and IPC bytes, but **no user-visible symptom is attributable to it today**. The log-site fix is
cheaper, single-file, and addresses the actual reported harm.

### 3. The corrected byte accounting

Both files, 7,813,687 bytes total, byte-exact, `LC_ALL=C` (the em-space separator requires it —
a UTF-8 locale mis-splits the prefix and silently under-counts by 62 KB):

| Category | Bytes | % | Lines |
|---|---|---|---|
| inbound frame (`←`) | 7,800,639 | **99.833%** | 11,917 |
| outbound frame (`→`) | 9,245 | 0.118% | 19 |
| `attention:` (anchored) | 2,768 | 0.035% | 37 |
| worker lifecycle | 1,020 | 0.013% | 13 |
| `worker-stderr:` | **0** | 0% | **0** |
| blank | 15 | — | 15 |

By inbound frame type:

| Frame type | Bytes | % of inbound | Lines | Avg |
|---|---|---|---|---|
| **`display-upsert`** (full snapshot) | **5,873,649** | **75.30%** | 3,719 | **1,579 B** |
| `sink-frame` (the delta) | 955,781 | 12.25% | 3,758 | 254 B |
| `event` | 927,529 | 11.89% | 4,356 | 212 B |
| `transcript-insert` | 28,840 | 0.37% | 35 | 824 B |
| `interactive-request` | 9,579 | 0.12% | 6 | 1,596 B |
| `context-usage` | 4,981 | 0.06% | 39 | 127 B |
| `ready` | 280 | 0.00% | 4 | 70 B |

**Delta-carrying frames = 24.14%. Full-snapshot frames = 75.30%. Ratio 3.1 : 1.**

### 4. The corrected retention math — and the units error in the card

The card's 4.7 h cannot be reproduced by its own stated remedy, and the reason is a **units mix**:
diagnostic bytes accrue per **wall-clock** hour, frame bytes per **active-streaming** second, and the
two differ by the **duty cycle**, measured at **1.6%** (148 distinct active seconds inside a 2.65 h
span). Dividing the diagnostic remainder by active seconds instead of wall clock inflates it ~64×.

Measured duty cycle and inputs: 148 active-seconds, 80.5 inbound frame lines/active-s, 655 B average
frame line, non-frame remainder 25.7 B/active-s but only **0.40 B/wall-clock-s**.

| Treatment | Continuous streaming | Wall clock |
|---|---|---|
| **Today** | **1.7 min** | ~107 h |
| `display-upsert` → ~100 B summary | 5.6 min | ~361 h |
| `display-upsert` lines dropped | 6.7 min | ~430 h |
| + delta bodies → 38 B envelope | **39.8 min** | ~2,568 h |
| Diagnostics only (frames off entirely) | — | **~152 days** |
| *Card's claim for "gate frame bodies"* | *—* | *~4.7 h ✗* |

**The decision-relevant column is the first one.** A user who reproduces during a 3-minute turn and
opens the log immediately has **1.7 minutes** of retention and loses the diagnostic. Gating
`display-upsert` alone clears a typical turn; gating delta bodies too clears a whole long turn. Frames
off entirely makes the 5 MB cap stop binding at all.

The card's literal remedy — keep a 38 B envelope per frame — measures **27.8 min of streaming**, not
4.7 h. A stub is the problem: at 80.5 frame lines/active-s, *any* non-trivial per-line cost precludes
hours of retention.

### 5. REFUTED: "worker stderr is written and unreachable by a user"

The card's chain is *9 `eprintln!` sites → the Worker never calls `init_from_env` → unreachable*. The
middle link is true and the conclusion does not follow, because **those lines never touch the Worker's
`debuglog` at all.** The real chain:

```
ARCHIMEDES_DEBUG=1 in the SUPERVISOR's launch env
  → lib.rs:545 debuglog::init_from_env()      ← the only production call; it is the Supervisor
  → Worker eprintln!("harness: …") → ITS OWN STDERR
  → WorkerHandle::spawn pipes stderr (client.rs:333)
  → spawn_pipe_reader (client.rs:373-375) → log_truncated("worker-stderr:", …)
  → supervisor.log                            ← written by the SUPERVISOR, whose ENABLED is true
```

`hostenv.rs:222-233` documents exactly this and says the *opposite* of what the card inferred — it
names the Worker's stderr as **the** log channel and the Supervisor's `log_truncated` as its forwarder.
Its point is that `debuglog::log` would be a no-op *in the Worker's own process*, not that the line is
unreachable to a user.

**`ARCHIMEDES_DEBUG` is not scrubbed either** (this was the angle's stated highest-risk hypothesis).
`hostenv::scrub` iterates a hardcoded `TAINTED_VARS` const (`hostenv.rs:68-90`, 21 AppImage path
variables) and `grep -c ARCHIMEDES src/hostenv.rs` → **0**. The doc at `:289-291` states that walking
the const "keeps an inherited name that is not on the tainted list entirely untouched". The var
reaches the Worker unchanged on every platform.

**The four real reachability failures**, each independently sufficient to lose a report:

1. **The README never says the switch captures Worker diagnostics.** `README.md:414-436` documents
   `ARCHIMEDES_DEBUG=1` correctly but `grep -n "worker-stderr\|stderr\|diagnostic" README.md` → **no
   matches**. A user learns the log holds "Worker lifecycle … the raw Worker IPC lines" and never learns
   it also holds the harness's own failure lines.
2. **No in-app affordance of any kind**, and on macOS **nothing in the repo** makes the var settable
   for a GUI launch (`grep -rn launchctl` across both repos → 0; no `LSEnvironment`, no `.desktop`
   file). Linux has `~/.config/environment.d/archimedes.conf` (`README.md:311-338`) but it is documented
   for a *different* variable and **not cross-referenced from the Diagnostics section**.
3. **Rotation evicts it** — this card's subject.
4. **A single non-UTF-8 byte permanently kills the drain.** `spawn_pipe_reader`'s error arm is
   `Err(_) => break` (`client.rs:263`) and tokio's `read_line` errors on invalid UTF-8 — so one bad byte
   silences that Worker's stderr **for the rest of its life**, with no diagnostic of its own.

### 6. The drop sites: the card is right that they are silent, wrong about the set

Verified silent (no `eprintln!`, no `debuglog::log`, no event frame, no tool-error result):

| Site | File / symbol | Drop |
|---|---|---|
| nameless acc | `anthropic.rs` `flush_tool_calls` `:536-538` | `let Some(name) = acc.name else { continue }` |
| nameless acc | `openai.rs` `flush_tool_calls` `:614-616` | identical body |
| nameless acc | `responses.rs` `flush_tool_calls` `:447-449` | identical body |
| **nameless `done` item** | `responses.rs` `output_item.done` `:264-271` | **`if let Some(name) = name` with no `else`** — parse-time, before flush is reached, and leaves `acc.done = false` |
| missing index | `anthropic.rs:356`, `openai.rs:526`, `responses.rs:161-165/228-232` | fragment dropped (Responses defaults a missing `output_index` to **0**, so two calls collide) |
| same-index clobber | `anthropic.rs:368`, `responses.rs:179` | `insert` not `entry().or_default()` — OpenAI alone merges |
| **flush skipped entirely** | `anthropic.rs:470`, `openai.rs:441`, `responses.rs:500` | error/terminal arms set `exhausted`/`terminated` and the outer guard returns before the flush — **discards complete, dispatchable calls** |
| unparseable SSE line | `anthropic.rs:290`, `openai.rs:348`, `responses.rs:127` | `let Ok(v) = … else { return }` |
| **settle with nothing dispatched** | `loop.rs:1476` `if tool_calls.is_empty()` | the success triple, no diagnostic |

Five corrections to how the card frames these:

1. **`parse_arguments` is only half a precedent.** It logs the *malformed non-empty* case
   (`openai.rs:654`) but the **empty/whitespace** buffer returns `{}` **silently** (`:648-650`) — and an
   empty buffer is exactly what a cut-off or nameless call leaves behind.
2. **The nameless drop is not one site per parser** — `responses.rs:264-271` fires at parse time, so a
   diagnostic placed only in `flush_tool_calls` would not fire on the most common Responses lifetime.
3. **The named sites are not the sites that lose the most.** The flush-skip (`:470`/`:441`/`:500`)
   discards *complete* calls; on Responses it covers `completed`/`incomplete`/`failed`/`error`, not just
   the `incomplete` case the predecessor doc records.
4. **"Silent" ≠ "unlogged" on the settle side, and the card conflates them.** `turn.rs:337` and
   `loop.rs:1336` **already log** and are *still* user-invisible: `settle_error` is byte-identical to
   `settle_cancelled`, `turn_end` carries no reason field, and the desktop maps any un-flagged settle to
   `StopReason::EndTurn` (`router.rs:501-507`), which `TranscriptFooter.tsx:27,107` suppresses.
   **`RpcEvent` has no variant meaning "this turn failed"** (`events.rs:55-235`) — the engine cannot
   express a failed turn on the wire. Adding `eprintln!`s cannot fix those two paths.
5. **The settle site cannot answer the question it would be asked.** `TurnAccumulator` has five fields
   and **no tool-call-delta counter** (`emit.rs:427-434`), and `consume_stream`'s `ToolCallDelta` arm
   keeps nothing (`turn.rs:223-232`). At `loop.rs:1476` the loop **cannot distinguish "the provider never
   called a tool" from "a tool call was streamed and the parser dropped it"** — the one distinction the
   diagnostic exists to make. Everything else it would want (finish reason, text/thinking length, usage,
   `turn_tool_results`, retry attempt, `self.model.id`/`.api`) *is* in scope and unused.

**Count correction:** the sites are **12, not 9**. Three open a multi-line literal so `harness:` is not
on the `eprintln!` line (`emit.rs:334`, `turn.rs:386`, `turn.rs:438`). `grep 'eprintln!("harness'` → 9;
`grep '"harness: '` → 12; `grep -c 'eprintln!(' src/harness` → 12. The 9 matches no shipped tag
(v0.1.0/0.2.0 = 11, v0.3.0/0.3.1 = 12).

### 7. Industry convergence: 4/4 vendor-primary, and the refutation is in our own docblock

| System | Per-chunk shape | Full object |
|---|---|---|
| **Anthropic Messages** | `content_block_delta` → `{"delta":{"type":"text_delta","text":"ello frien"}}` | `content_block_stop` carries **no text at all**; the full `Message` is **never transmitted** — accumulation is client-side (`stream.get_final_message()`) |
| **OpenAI Chat Completions** | `choices[].delta` — "a chat completion delta generated by streamed model responses" | `message` never appears in chunks |
| **OpenAI Responses** | `response.output_text.delta` → "the text delta that was added" | full object only at `output_text.done` / `response.completed` |
| **ACP** | `agent_message_chunk` — *"Chunks append their single `content` item to the current content of the message with the matching `messageId`"* | whole-message updates explicitly reserved for replace/replay |

**The rationale quote (single-source, but it is the spec owner):** ACP v2 RFD — *"Chunks are a natural
fit for streaming model output, but they are awkward for session replay, accepted user-message
acknowledgments, and cases where the Agent already has the whole message available."* And: *"Why does
content replace instead of append? Appending is already represented by chunks."*

**The irony is load-bearing.** `compute_display_rows`'s own docblock reads *"the FROZEN JSON shapes the
normalizer emits — the PURE row-computation half of the **ACP-era persistence** … The persistence
semantics are the **ACP-era ones, unchanged**"*. **ACP moved whole-message upserts off the streaming
path and scoped them to replay/correction. This code kept them on the streaming path, per token.**
`DisplayUpsert` is precisely the shape ACP reserves for "the Agent already has the whole message" — used
here on every chunk of a live stream.

**Producer-side coalescing converges on 50 ms.** Vercel AI SDK documents `throttle: 50` in every example
("By default, the UI is re-rendered on every chunk that arrives. This can overload the rendering");
`cloudflare/agents` adopted the same number independently with a measured effect — *"coalesces those
updates every 50ms, which removes about 78% of renders on a fast stream and matches the value the AI
SDK documents. The first chunk of a stream is never delayed."* rAF coalescing is the ~16.7 ms frame
budget. **Note these are render-side, not wire-side** — the wire stays per-chunk in all of them.

**MCP is the outlier** — no partial-content primitive at all; "streaming" there means progress
notifications.

### 8. Card claim scorecard

| # | Card claim | Verdict |
|---|---|---|
| 1 | 7,813,687 total bytes; 5,243,384 B over 71 active seconds; 72.1 KiB/streaming-second; ~71 s of streaming | **REPRODUCED exactly** (and `.old` = 5,242,880 cap **+ 504 B**, matching the `>=` at `debuglog.rs:87`) |
| 2 | "99.95% … verbatim conversation **token deltas**" | **DIVERGED on definition and on mechanism.** 99.833% is *inbound frames*; but deltas are **24.14%** and full-snapshot re-emissions are **75.30%** |
| 3 | "the `attention:` timeline is fully present, **702 lines in `.old`**" | **REFUTED — and it is the card's own trap.** Anchored `^[0-9]+ attention:` in `.old` = **0**; all 37 are in `supervisor.log`. The 702 are the *word* inside JSON payloads — the identical mistake the card warns about for `harness:` two sentences earlier |
| 4 | "the 5 MB cap holds ≈ 71 seconds" | **REPRODUCED** for `.old` (73.2 s span, 71,064 B/s). Note `supervisor.log` is **not** streaming (9,463.7 s span, 269 B/s) — the 71 s is a peak-burst figure |
| 5 | "gate frame bodies ⇒ **~4.7 hours**" | **REFUTED.** Measured **27.8 min** of streaming for the literal remedy; 4.7 h is a units mix (§4) |
| 6 | "worker stderr IS captured **and IS unreachable**" | **REFUTED** — reachable via the Supervisor's drain (§5) |
| 7 | "all **9** `eprintln!("harness: …")` sites" | **REFUTED — 12** (grep artifact) |
| 8 | "the Worker never calls `init_from_env`" | **VERIFIED** (`lib.rs:545` is the only production call) — but the card's inference from it is what fails |
| 9 | "the nameless-tool-call drop … is silent today, unlike `parse_arguments`, which does log" | **PARTLY** — silent: yes. The contrast overstates: `parse_arguments` is silent on the empty buffer, and the flush-skip sites lose more |
| 10 | "the settle-with-nothing-dispatched site" (singular) | **PARTLY** — `loop.rs:1476` is silent and is the shape that matters; the *fully-empty* half already logs and retries (`loop.rs:1446` → `turn.rs:386`) |
| 11 | "must be `eprintln!`, never `debuglog::log`" | **VERIFIED and correctly reasoned** — `turn.rs:435-437` and `hostenv.rs:222-228` both state it |
| 12 | "this is also the privacy liability the README already flags" | **PARTLY** — the README's description is accurate but *overweights* outbound `→` frames (0.12%) and undersells the inbound reasoning stream (99.27%); and it states the log exists **only if you opted in** |

### 9. Privacy: what is actually in the bodies

Sampling found **zero** credential-shaped strings (`sk-`, `Bearer`, JWT `eyJ`, private-key headers,
`password=`, `ghp_`, `AKIA`, `xoxb-`). Present: assistant **reasoning text** (`agent_thought_chunk`,
2,220 lines), tool I/O, **3,957 filesystem paths**, **7,596 session ids**, verbatim model prose.

So the privacy argument is about **conversation and reasoning content**, not secrets — which is exactly
what OTel's GenAI semconv treats as the sensitive class: *"Model instructions, user messages, and model
outputs are **considered sensitive** … instrumentations **SHOULD NOT capture them by default, but SHOULD
provide an option for users to opt in**"*, with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` defaulting
to `NO_CONTENT` and **failing closed on an unrecognised value**. Claude Code's docs go further and name
the exposure plainly: *"Transcripts and history are not encrypted at rest. OS file permissions are the
only protection."*

**One mitigation the card omits:** the log is *not* redundant with the DB. Both sessions named in the
log (`arch_308ca2d1…`, `arch_f61f0dcc…`) have **0 rows** in `sessions` and `messages` while the 2.4 GB
`archimedes.db` holds 2,371 sessions spanning Oct 4 → Nov 15. So the log is currently the only record of
those turns — which argues for *summarising* the snapshots, not for treating the transcript as disposable.

### 10. Mechanism constraints any fix inherits (from the `debuglog` census)

- **One env var, one boolean, no levels.** `debuglog.rs` reads `ARCHIMEDES_DEBUG` at `:43` with
  `.is_ok_and(\|v\| v == "1")` (exact string — `"true"`/`"TRUE"`/`"2"` all disable). No `Level`, no
  category, no per-call-site filter (`grep 'Level\|severity\|category\|filter'` → 0 hits). No `log` /
  `tracing` / `env_logger` dependency, and **no `[features]` table** in the crate at all.
- **The gate is statement one of `log`** (`:61`), so anything gated must be gated at the emit site.
- **The two frame sites are the only way a `←`/`→` byte enters the log** (`client.rs:445`, `:626`) and
  they are already `log_truncated(prefix, body)` — a shape that separates prefix from body.
  **`log_truncated` has exactly 3 callers, all in `client.rs`, and 0 in the desktop**, so its blast
  radius is one file.
- **`init` is unguarded and re-callable** (no `Once`/`OnceLock`), so "read once at startup" is a
  **convention, not an enforced invariant** — a runtime toggle is mechanically available today.
- **Writes are immediate and unsynced**: `stat` + `open` + `write` + `close` per line, no `BufWriter`,
  no `fsync`. Rotation is a **check-then-rename per write** (`>=`, rename result discarded).
- **Two processes must not share the file.** `O_APPEND` is used, but `writeln!(f, "{ts} {line}")` with
  arguments compiles to **several `write(2)` calls** (the static-string fast path does not apply), so a
  line can be **spliced mid-write**, and both processes racing the rotation would clobber one `.old`
  generation. Relevant if a fix ever makes the Worker write logs directly.
- **The one-switch contract is defended as a decision twice.** ADR 0063: *"the diagnostic surface stays
  **one** switch (`ARCHIMEDES_DEBUG`) … **The accepted cost, named:** a person reporting a bug must set
  `ARCHIMEDES_DEBUG=1` **before** reproducing it … **If the switch proves too costly in practice, reopen
  this bullet rather than re-deriving it.**"* ADR 0088 repeats it, and two call sites carry "no second
  flag to drift" (`commands/tasks.rs:1254`, `commands/sessions.rs:57`). **A second env var must engage
  with that, not ignore it** — and this finding may not need one at all, since the fix is per-frame-type
  at one call site, not a new user-facing tier.
- **Test surface that constrains a change:** `src-tauri/tests/worker_stderr.rs` pins the
  `"worker-stderr: fake worker: a diagnostic on stderr"` marker byte-for-byte and would stay green as
  long as stderr keeps flowing. `attention_trace.rs:277` asserts `lines().count() == 9` and
  `refresh.rs:1051-1063` asserts a count of 1 — both use a **private temp dir via `init`**, so they
  never see frames and a frame-gating change cannot perturb them. `crashlog.rs:757-778` asserts
  `supervisor.log` + `.old` survive the crash-log prune. **No test covers the `←`/`→` sites at all**, and
  none asserts the line format or the `>=` rotation boundary.

---

## Unresolved contradictions

1. **99.95% vs 99.274%.** A sibling measurement file written this session
   (`docs/research/log-byte-accounting-retention-verify.md`, untracked) reports 99.274% by counting only
   `display-upsert` + `sink-frame` + `event` as "frames" and excluding `transcript-insert` /
   `context-usage` / `interactive-request` / `ready`. **Both are arithmetically correct about different
   sets**; this report uses **99.833% inbound frames** and then decomposes by type, which is the
   decision-relevant cut. The two files agree on every absolute byte figure.
2. **Retention: 3.77 h vs 39.8 min.** The same sibling file reports 3.77 h for "frame lines deleted
   entirely" by dividing the diagnostic remainder by **active-seconds**; this report's 39.8 min (delta
   bodies also gated) and ~152 days (frames off) divide it by **wall clock**. The 64× gap is the duty
   cycle, and which is right depends on the question: *can I catch this during the turn* → active-seconds;
   *how far back does the log reach* → wall clock. **Both are reported; neither is a correction of the
   other.** This report leads with active-seconds because the card's harm statement is about catching a
   reproduction.
3. **Whether a second env var is legitimate at all.** ADR 0063 defends one switch as a decision *and*
   names its reopen path. The industry standard (OTel, Codex, Claude Code, opencode) is a
   level/category filter, not a second boolean. Unresolved, and it is a design call — **but this finding
   may sidestep it**: summarising one frame type at one call site is not a new user-facing tier.

## Gaps

1. **The web angle on producer-side coalescing partially failed** — one of two re-dispatched angles
   returned `settled with no output` (the known `worker_e2e`-class flake, this time on the subagent
   harness) and the other was cancelled; the surviving angle covers deltas and the 50 ms convergence.
   **Not settled:** whether `zed`/`opencode`/`codex` supervisor↔worker transports ship full rows or
   deltas *internally* (the vendor API evidence is strong; the internal-IPC evidence is not).
2. **Claude Code's exact debug rotation (10,485,760 B, one `.1.txt`)** rests on one user reading a
   minified bundle (issue #109118). **Do not cite as fact.**
3. **Whether `display-upsert` is fully reconstructable from the `sink-frame`s already in the log.**
   The reducer is deterministic over the deltas and both are in the same file, so a summary should lose
   only the row `kind`/`message_key`/segment structure — but `message_key` is `"{messageId}#{segment}"`
   and `segment` is derived from `thought_state.open_key` clearing, which the delta stream *does*
   express. **Believed safe, not proven.** A fix should verify before shipping.
4. **The two log-bearing sessions' absence from the DB is unexplained.** 0 rows in `sessions` and
   `messages` while 30 other same-day sessions exist. Not investigated — if it is a persistence bug it is
   a separate card.
5. **The 72.1 KiB/s figure is a peak burst** from one 73-second window in one file; `supervisor.log`
   streams at 32.6 KiB/s. No distribution was measured, so retention figures carry an unquantified
   variance.
6. **Log artifacts are 35 days old** (mtime 2026-10-12) and byte-identical to what the card measured —
   so nothing here reflects any logging change since, and the artifacts are a single machine's sample.
7. **`useDeferredValue`/`useTransition` as a streaming-text coalescing idiom: no authoritative source
   found.** Absence of evidence, not disproof — do not cite it.

---

## What the evidence supports as fixes (not a decision — `specify` owns that)

**Ordered by cost-to-benefit, all four are independent:**

1. **Stop logging the full snapshot.** At the inbound site (`client.rs:445`), summarise
   `display-upsert` (type + session + row count + row keys + byte length) while every other frame type
   stays verbatim. **One file, no protocol change, no new user-facing tier, 75.30% of the bytes gone, no
   test breaks** (nothing in either repo parses a `display-upsert` log body). Add the missing test — the
   `←`/`→` sites have none.

   **CORRECTION to this report's earlier draft, verified in grounding:** an earlier version of this
   bullet claimed the frame "is already decoded nearby, so no second parse is required". **That is
   false.** At `fulcrum@960c281` (`v0.3.2`) the order at the inbound site is **log first, decode
   second**: `debuglog::log_truncated("←", &l)` is `client.rs:445` and `decode_outbound(&l)` is `:446`.
   So a summary built from the typed `Outbound` requires **moving the log call below the decode** — and
   that move has a trap: today a *malformed* line is still logged verbatim, because the `Err` arm at
   `:448` `continue`s. Move the log without also logging inside that `Err` arm and **the malformed line —
   the single most diagnostic line in the stream — is logged nowhere.** Second constraint:
   `route_outbound(frame)` (`:465`) takes `frame` **by value** (`fn route_outbound(frame: Outbound)`,
   `:943`), so any summary taken from `&frame` must precede it.
2. **Then decide about delta bodies** (`sink-frame`/`event`, 24.14%) — that is where a second opt-in
   would live, and it is the step that must engage ADR 0063's reopen clause. Gating both reaches ~40 min
   of continuous streaming.
3. **Log the silent drops** — but fix the *set* first (§6): the flush-skip sites lose more than the
   nameless ones, `responses.rs` needs a parse-time arm as well as a flush arm, and the settle site needs
   a **delta counter** before it can answer the question it is being asked. `eprintln!` is correct.
4. **Make the diagnostics reachable** — README: say the switch captures `worker-stderr:` and
   cross-reference `environment.d`; add a macOS route; consider an in-app affordance (every GUI exemplar
   in the corpus has a runtime toggle). Also fix `Err(_) => break` killing the stderr drain on one bad
   byte.

**Deliberately NOT supported by this evidence:** a protocol-level delta frame. It is the industry shape
and the ACP-correct one, but **the log is the only consumer that pays today** — so it buys CPU and IPC
bytes no user symptom is attached to, at the cost of a crate release plus consumer edits.

## Appendix — re-runnable instruments

All at `fulcrum-harness 0.3.2`; every `export LC_ALL=C` is load-bearing (the em-space separator).

```bash
# Byte census by prefix (run in ~/.local/share/archimedes/)
export LC_ALL=C
cat supervisor.log supervisor.log.old | awk '{
  if ($0 ~ /^[0-9]+ ←/) p="inbound-frame"; else if ($0 ~ /^[0-9]+ →/) p="outbound-frame"
  else if ($0 ~ /^[0-9]+ worker-stderr:/) p="worker-stderr"; else if ($0 ~ /^[0-9]+ attention:/) p="attention"
  else if ($0 ~ /^[0-9]+ worker/) p="lifecycle"; else p="other"
  b[p]+=length($0)+1; n[p]++ } END { T=0; for(k in b) T+=b[k]
  for(k in b) printf "%-16s %9d B %6.3f%% %6d lines\n", k, b[k], 100*b[k]/T, n[k] }'

# Inbound bytes by frame type  → display-upsert 75.30%
python3 -c "
import re,collections
b=collections.Counter(); n=collections.Counter()
for f in ('supervisor.log.old','supervisor.log'):
    for line in open(f,encoding='utf-8',errors='replace'):
        m=re.match(r'^\d+ ← \{\"type\":\"([a-z-]+)\"',line)
        if m: b[m.group(1)]+=len(line.encode()); n[m.group(1)]+=1
T=sum(b.values())
[print(f'{k:18s}{v:9d} {100*v/T:6.2f}% {n[k]:6d}') for k,v in b.most_common()]"

# THE headline instrument — one row's quadratic re-emission (expect 1388 / ~2.69 MB / 51.3%)
python3 -c "
import re,collections
keys=collections.Counter(); sz=collections.Counter()
for line in open('supervisor.log.old',encoding='utf-8',errors='replace'):
    if '\"type\":\"display-upsert\"' not in line: continue
    for k in re.findall(r'\"message_key\":\"([^\"]+)\"',line):
        keys[k]+=1; sz[k]+=len(line.encode())
k,c=keys.most_common(1)[0]
print(f'{k} re-emitted {c}x = {sz[k]:,} B = {100*sz[k]/5243384:.1f}% of the file')"

# eprintln count — the 9 is a grep artifact (expect 9 / 12 / 12)
cd ../fulcrum && grep -rc 'eprintln!("harness' src/harness | awk -F: '{s+=$2} END{print s}'
grep -rn '"harness: ' src --include='*.rs' | wc -l

# The card's own trap, demonstrated: anchored vs substring (expect 0 / 702)
cd ~/.local/share/archimedes && grep -cE '^[0-9]+ attention:' supervisor.log.old; grep -c 'attention:' supervisor.log.old
```
