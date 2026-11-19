---
status: current
last-verified: 2026-11-16
task: tsk_076eb5dd-4ed8-45e7-91ba-1747092deb7d
verified-by: >-
  Four parallel research angles + parent re-measurement of every load-bearing claim, 2026-11-15/16.
  (a) SQLite forensics against a READ-ONLY SNAPSHOT of this machine's real `archimedes.db`
  (`/home/daniel/silent-turn-escape/snap.db`, a `cp` taken 2026-11-15 23:18 local,
  2,429,169,664 B; 351,312 `native_messages`; 385,408 `messages`; 2,372 sessions — 96 main,
  2,276 subagent; range 2026-10-04 11:47 → 2026-11-15 23:14). The live DB is LOCKED by the running
  desktop, so every figure is `sqlite3 "file:/home/daniel/silent-turn-escape/snap.db?mode=ro"`.
  **That snapshot is a working file outside the repo and unrecoverable if deleted — re-take it the
  same way to re-run the census.** (b) Engine source at the sibling checkout
  `/home/daniel/Coding/Archimedes/fulcrum`, branch `feature/anthropic-output-ceiling`, HEAD `3c9d416`
  (`git describe` → `v0.3.1-6-g3c9d416`), cross-read against the published
  `~/.cargo/registry/src/*/fulcrum-harness-0.3.1/`. (c) Desktop source at
  `/home/daniel/Coding/Archimedes/archimedes`, `main` @ `700714b2`, pinning
  `fulcrum-harness = "0.3.1"` (`src-tauri/Cargo.toml`). (d) Eleven upstream agent codebases read at
  pinned SHAs (listed in Evidence) + vendor/gateway issue trackers. (e) The running AppImage binary
  at `/tmp/.mount_archim*/usr/bin/archimedes`. Citations are BY CONTENT (function, struct, enum
  variant, component, string literal) not by line number, per this repo's locate-by-content rule.
issue: https://github.com/archimedes-codes/archimedes/issues/190
supersedes-context: >-
  Does NOT supersede `docs/research/silent-turn-settle-after-announcing-a-write.md` (that report's
  root-cause work stands). This report closes out ONE deferred item from it — the one-character
  escape hatch under the #64 emptiness gate — and corrects four of THAT report's census figures
  (§2), which were measured against an older snapshot and against `LIKE` rather than key-level
  `json_extract`.
---

# The announced-intent escape hatch: no detector can work, and the instrument the card believes exists does not measure this

**The settled question (from Phase 0):** is the remaining escape hatch — a turn that announced an
intent to act, dispatched nothing, and settled clean because **one character** of visible text made
`acc.text.is_empty()` false — worth a detector + nudge, and if so which class of detector
(markup-literal / prose-intent / turn-shape)? Deep, four angles, decided on the real corpus.

**Answer, in one line: no.** Not because the shape is rare, but because **the shape contains its own
false-positive class** — a turn that streamed text, dispatched nothing, and stopped is *exactly* what a
correct turn looks like when the agent is asking a question in prose — and because the card's premise
that #190 made this "measurable first" is **false**: #190 instrumented the route it fixed, and the
deferred route is dark by construction.

---

## Executive Summary

**1. The escape hatch is instrumented by NOTHING, and cannot be measured retroactively.**
#190's gate fires on `acc.finish == Some(FinishReason::Length)` and **`return`s** before the emptiness
gate. The two routes are therefore **disjoint by construction** — there is no code path on which an
escape-hatch turn can reach `handle_truncated_turn`'s `eprintln`, `RpcEvent::turn_truncated`, the
`{stamp}:truncate:N` row, or the `disposition` key. What an escape-hatch turn leaves behind is: one
`agent-text` display row carrying the model's own words (identical in shape to a legitimate answer),
one assistant transcript row (identical to a legitimate final answer), and `StopReason::end_turn` —
**the same value a genuinely completed turn carries.** Nothing on disk, past or future, counts this shape.

**2. No detector can work as the card defines it, and the corpus says so directly.** The only notion
of "the agent is asking" anywhere in the system is `isInteractivePause` — the `ask`/`confirm`/`password`
**tool gate**. Using it dispatches a tool call, which by definition means the escape-hatch shape never
occurs. A prose question has **no representation at all**: no `StopReason::Asked`, no `MessageRow.kind`
for a question, no `AttentionSnapshot` field, and `ChatMessage` has four fields, none a disposition.
Measured on **main-session** terminal text-only assistant rows: **23 announce-like vs 47 question-like
(2 both)**. The legitimate case outnumbers the bug roughly 2:1.

**3. Four of the card's census figures are wrong** (§2), the most damaging being the 28-row
"intent-to-write" set: a broad intent regex over terminal text-only rows matches **535 rows**, of which
**506 are subagent sessions** and only **29 are main sessions — out of 75 main-session terminal
text-only rows that exist at all**. So the honest reading is not "28 suspicious rows in a big corpus",
it is **39% of main-session terminal rows end in an intent sentence**, and reading them shows the
dominant form is a benign **conditional offer** (`"…say the word and i'll write it"`). Angle 1 read all
28 candidates: **precision 5/28 = 18%**.

**4. The direct user-side evidence is ~2 sessions in 41 days, not a rate.** Reading what a human
actually typed after an announce-like terminal row in a main session: the stall signature is `write`
(session `4a2c010a`, model wrote "then write", dispatched nothing) and `ok` (`ad08852d`, *"Writing the
spec + plan."*, 44-second stall). `continue` and `yeah` also appear but are ambiguous — a user typing
`continue` after a legitimate 2,900-character plan is indistinguishable. **A floor of 2. The
false-positive class is ~47.**

**5. Nobody in the industry has ever built this detector.** Eleven codebases at pinned SHAs, all
negative. The strongest evidence is a **maintainer refusal written into code** (cline
`sdk/packages/agents/src/agent-runtime.ts`): *"An unknown finish without tool activity is continued
once from the partial history; **it is never inferred from whether the response contains visible
text.**"* The one project that ever read text (Kilo #5377) matched a **format**, not an intent, and
**deleted it** in its 7.5 rewrite. OpenHands built a stall detector for this exact symptom and
deliberately counts consecutive agent messages **without reading them**. Anthropic's own shipped answer
is a **system-prompt guard**, and claude-code #83713 reports it **ignored**.

**6. The card's "bounded at 2–3" support is a category error.** opencode's `LIMIT 3` and cline's
`MAX_TOKENS_RECOVERY_LIMIT = 3` are both **exclusively on `finish_reason == length`** — a
provider-supplied enum. Neither bounds a text detector, because neither has one. They are evidence that
*continuation* is safe to cap; they are **not** evidence that a *detector* is cheap.

**7. A fuse already exists, and it is the wrong shape.** `DEFAULT_MAX_ATTEMPTS = 5`,
`RetryPolicy::new()` in production. `attempt` is mutated only by `+= 1` and `.max(1)` and is **never
reset at a turn boundary** — so it is a budget of **four retries for the lifetime of the Worker**,
shared with the transport-error ladder. A nudge riding it is bounded for free, silently stops working
after four unrelated retries, and **burns the fuse a real 429 needs**.

**8. What a wrong nudge costs is concrete and bad** (§6): a permanently-billed call on the visible cost
line; **the user's reply visibly blanked** and replaced with "Discarded an incomplete reply"; a retry
line that **welds** onto the shared system bubble — **103 of 104 such rows already carry ≥2 welded
one-liners**; a re-run `compact_if_due` that can spend a whole summary call and rewrite the transcript;
and a new messageId family that **leaks into a subagent's parent-facing tool result** unless
`is_bookkeeping_message_id` learns the word in the same commit, with no test catching its absence.

**9. The recommended answer is not a classifier — it is a contract.** Five independent upstream
projects converge on making completion/asking explicit rather than inferring it from prose. That is the
smaller, better-precedented change, and it is the only one that makes the shape detectable *at all*.

---

## Findings

### 1. The escape hatch is dark — the card's "measurable first" premise is false (VERIFIED)

The gate order in the engine's `handle_turn` (`src/harness/loop.rs`) is the whole finding:

```rust
if acc.finish == Some(FinishReason::Length) {
    match self.handle_truncated_turn(…).await {
        turn::TurnFlow::Continue => continue,
        turn::TurnFlow::Return  => return,   // ← RETURNS. The gate below never sees Length.
    }
}
// … long comment …
if acc.text.is_empty() && acc.tool_calls.is_empty() {
    match self.handle_empty_turn(…) …        // ← #64: EMPTY text only
}
if let Some(attempt) = self.retry.note_success() { … auto_retry_end { success: true } }
// … message_end → push → persist → agent_end{will_retry:false} → turn_end → agent_settled
```

Every candidate trace, enumerated against the escape-hatch shape (clean `stop`, text non-empty, zero
tool calls):

| Candidate instrument | Fires? | Why |
|---|---|---|
| `handle_truncated_turn`'s `eprintln!("harness: turn truncated…")` | **No** | gated on `Length`, which returns above |
| `RpcEvent::turn_truncated` | **No** | same gate |
| `{stamp}:truncate:N` display row + `disposition: "length"` | **No** | same gate |
| `handle_empty_turn`'s `eprintln!("harness: empty model turn…")` | **No** | `acc.text.is_empty()` is false by construction |
| `auto_retry_start` / `auto_retry_end` | **No** | nothing retried; `note_success` returns `None` |
| `settle_error` / `settle_cancelled` / `settle_truncated` | **No** | it reaches the success triple instead |
| **Any** `eprintln` on this path | **No** | none exists between the gate and the settle |
| `StopReason` | `"end_turn"` | **identical to a genuinely completed turn** |
| Display row / transcript row | the model's own words | **identical to a legitimate final answer** |

**So #190 did exactly what a fix should do and exactly what the card did not notice: it instrumented the
route it closed, and the deferred route has no instrument.** The card's sentence — *"The #190 work added
the `eprintln` + the `{stamp}:truncate:N` notice precisely so this becomes measurable first"* — is true
of `Length` and false of the escape hatch. This is not an omission to patch by adding a log line: see §2
for why counting the shape would count mostly-legitimate turns.

**Deployment note (VERIFIED, with one caveat).** The running AppImage does contain `turn_truncated` and
`Response was truncated before completion`, so the engine half of #190 is deployed. It does **not**
contain the string `"disposition"` — the #197 durable half is not in the running binary. In the snapshot,
the post-instrument window holds **0** rows with `json_extract(payload_json,'$.text') = 'Response was
truncated before completion'`, **0** rows with `message_key like '%:truncate:%'`, and **0** rows carrying
a `disposition` key — corroborated by **0** `auto_retry_*` one-liners and **0** argument-bearing tool
calls with `{}` arguments since the build. Three independent proxies agree. **But the window is ~9.4
hours / 2,744 assistant rows** (not the "13.5 h" a naive timestamp diff suggests), which is evidence of
*low rate*, not absence — and none of these proxies can see the escape hatch at all.

> **Instrument trap, re-confirmed twice in both directions.** `payload_json LIKE '%Response was truncated
> before completion%'` returns **255** rows and **all 255 are conversation content** — research text
> quoting that very string. The sound read is key-level: `json_extract(payload_json,'$.text') = '…'`, or
> better, the **message-key shape** (`[0-9a-f]{6}:truncate:N`), which model prose can never forge because
> it reads the id, not the body. The prior report measured the same trap with `LIKE '%finish_reason%'`
> (669 phantom hits). This is `AGENTS.md`'s "a grep count includes prose that names the pattern" hazard in
> SQL form.

### 2. Four card figures corrected (all re-measured; instruments in the Appendix)

| Card / prior-report claim | Measured on the 2026-11-15 snapshot | What happened |
|---|---|---|
| "126,713 `agent-thought` rows … **12 contain a literal `<invoke` block**" | **136,158** rows; **44** raw `<invoke name=` hits; **~1–2 genuinely the model's own call** | 42 of 44 are research sessions *quoting* the pattern — engine test fixtures (`ProviderEvent::ThinkingDelta("<invoke name=\"read\">…")`) and the #190 research doc's own text. One of the two genuine ones is an **empty** `<invoke name="bash"></invoke>`. **The "the intended call is recoverable from the display table" premise does not hold at the claimed scale.** |
| The `arch_789c677f…` case, 11 ms before an empty assistant row | **Genuine — and dated 2026-10-18 16:42:05, i.e. BEFORE the #64 fix** (`b3d8f5c`, 2026-10-20 09:34) | It is a pre-fix occurrence. It is real evidence for #64; it is not evidence the mechanism is still alive post-fix. |
| "28 final assistant rows end in an intent-to-write sentence and are 4,000–65,000 chars" | A broad intent regex matches **535** terminal text-only rows: **506 subagent, 29 main**. Main-session terminal text-only rows total **75**. Lengths of the readable main-session hits: **1,083 / 2,029 / 2,864** chars | The "28" is unreproducible as stated, and the framing hides the denominator. **39% of main-session terminal rows end in an intent sentence**, and they read: *"…say the word when the pr merges and i'll run the merge check, delete the plan family, and close out the card"*, *"…a one-paragraph doc follow-up would close it — say the word and i'll write it"*, *"…say the word when you want the run closed and i'll run `finish`"*. **These are correct turns.** |
| "median terminal assistant row 2,406 chars vs **82** mid-session — a **29×** ratio" | **median 4,738 terminal vs 2,086 mid-session = 2.3×** (avg 8,545 vs 2,074) | The 82 used *all* mid-session assistant rows as the denominator, including the ~108k tool-call rows whose text channel is empty. On comparable text-only rows the ratio is 2.3×, which separates *final reports* from *intermediate narration* — **not** *stalled* from *asked a question*. |

Also corrected: the visible-channel markup class is **5** rows, not 2 (all five session-terminal, all
post-#64) — but reading them, the 2026-11-14/15 ones are research sessions quoting the marker, and the
two genuine ones (`arch_c9882c73` 2026-10-27, `arch_c0d7dadb` 2026-11-02) are **model reasoning about
its own tool call**, not a call emitted into the visible channel. `arch_c9882c73` literally reads
`The block:` followed by `<invoke name="bash">...</invoke>` with literal `...` — the model *narrating*
that it is about to emit, in a 215 KB turn. **So even the highest-precision detector class has a
quoting problem in this corpus.**

### 3. The shape contains its own false-positive class — the load-bearing finding (VERIFIED + measured)

The desktop's entire vocabulary for "the agent is waiting on a human" is one predicate
(`src/store/interactive.ts`):

```ts
export const isInteractivePause = (method: InteractiveRequestData["method"]): boolean =>
  method === "ask" || method === "confirm" || method === "password";
```

That is a **tool call**. If the agent asks with the `ask` tool, the turn does not settle — `waitingIds`
is populated, status is `waiting`, the alert says *"needs your answer"*, an `AskQuestionCard` renders —
and **the escape-hatch shape cannot occur, because a tool call was dispatched.** If the agent asks in
prose, which is what the escape hatch *is*, the harness has **no representation of it whatsoever**.
There is nothing in between.

Measured over main-session terminal text-only assistant rows (248 rows with any text and no call;
**75** of them session-terminal):

| Tail shape | Rows |
|---|---:|
| Announce-like (`i'll ` / `i will ` / `i'm going to` / `let me `) | **23** |
| Question-like (`want me to` / `shall i` / `would you like` / `should i` / `do you want`) | **47** |
| Explicit `?` in the tail | 76 |
| **Both** | **2** |

And what a human types next is the only thing that separates them — which is observable **after** the
settle, i.e. after any nudge would have to have fired. Of the 23 announce-like rows: 8 ended the session,
10 got a user reply within 120 s. Of the 47 question-like rows: 8 ended the session, 20 got a reply
within 120 s. **Both classes behave the same way from the outside.**

Reading the replies that follow announce-like terminal rows (all ~70 of them) is the most useful thing
in this report. The genuine stall signature:

- `write` — session `4a2c010a`: the model wrote *"then write"*, dispatched nothing, the user typed the
  single word `write`. **Unambiguous.**
- `ok` — session `ad08852d`: *"Writing the spec + plan."*, a 44-second stall, the user typed `ok`.
  **Unambiguous.**

Everything else in that list is a new task or a tangent: *"is there any delivery spots available tomorrow
around lunch?"*, *"what was in the last order"*, *"lets remove greptile"*, *"i want it to be able to
write, but specifically only markdow…"*, *"hmm.. refresh.. check again it should be in Wizards"*, and
**`$finish` / `$check-pr` skill invocations** — i.e. the user correctly responding to a completed turn.
`continue` and `yeah` appear too and are genuinely ambiguous: a user typing `continue` after a legitimate
2,900-character closing report is indistinguishable from one prodding a stalled agent.

**Verdict, stated as loudly as the evidence allows: no detector can work on the escape-hatch shape as
defined, because the definition contains the legitimate case.** The distinction the card wants is not a
property of the turn; it is a property of *what the user does next*. A classifier whose positive class
is ~23 and whose negative class is ~47 legitimate questions is not a detector with a false-positive
problem — it is a nudge that fires mostly on turns where the agent was correctly asking permission.

### 4. Upstream: nobody has built it, one team refuses it in a code comment (VERIFIED at source)

| Project | Detects announced-intent-no-dispatch? | Signal | Fuse | At the bound |
|---|---|---|---|---|
| **sst/opencode** `aa2960f` | **No** (negative-searched) | `finish == "length"` only | SQL `LIMIT 3`, `recent.every(finish === "length")` | visible `StepFailedError{type:"output-limit"}` |
| **cline** `72b3d71` | **No — and explicitly refuses** | `finishReason == "max-tokens"` | `MAX_TOKENS_RECOVERY_LIMIT = 3`, reset on any tool call | throws `MAX_TOKENS_INCOMPLETE_TURN_MESSAGE` |
| **OpenHands SDK** `5e49dad` | **No** — closest analogue: a **monologue detector** | N consecutive agent messages, **zero text inspection** | monologue 3 / action-error 3 / alternating 6 | `STUCK` status, halts |
| **Kilo Code** `94dd902` | **Detector existed, deleted in the 7.5 rewrite** | text regex `/^\[Tool Use: .+\]/i` — a **syntax leak**, not an intent | count ≥2, mistake limit 3 | `mistake_limit_reached` ask |
| **charmbracelet/crush** `0f9de6a` | **No** | tool-call signature hash repeats | window 10, repeats 5 | loop detected |
| **aaif-goose** `2365bc5` | **No** (opt-in `/goal`, `/grind`) | user-set objective | `max_turns` 1000 | halts |
| **openai/codex** `a394ff9` | **No** | `None` tool call ⇒ turn ends | — | ends silently |
| **Aider** `5dc9490` | **No** | reflection loop (lint/test) | `max_reflections = 3` | *"Only 3 reflections allowed, stopping."* |
| **earendil-works/pi** `e83fcd3` | **No** | `output_item.done` absence | — | errors on unfinished tool call |
| **vercel/ai** `8ba3940` | **No** — has the bug open | `finishReason == null` | — | emits truncated call as complete (#24103) |
| **continuedev/continue**, **Roo Code** (archived 2026-05-15), Cursor/Amp/Zed | **No** / closed | — | — | — |
| **anthropics/claude-code** | **Closed source — unverifiable**; a *system-prompt* guard exists and was reported ignored | — | — | — |

**The refusal, verbatim** (cline `sdk/packages/agents/src/agent-runtime.ts`): *"An unknown finish without
tool activity is continued once from the partial history; **it is never inferred from whether the response
contains visible text.**"* A second, in the same file: *"An unknown terminal reason, **independent of
text/reasoning content**, permits exactly one continuation."* A maintainer team named this inference and
rejected it in a comment.

**The negative-result searches, recorded explicitly** (so the absence is falsifiable): a regex for
`(text|content|message)…(indicates|suggests|implies|means|announces)…(tool|function|call)` → 0 real hits
across all 10 readable repos; a code-level regex over `\b(I will|I'll|let me|going to)\b` → **0 in all
10**; `looks like (a|an) (tool|function)` on model output → 0. `gh search code "did not use a tool"`
across GitHub → 2 hits, neither an agent detector.

**The one measured attempt anywhere** is claude-code **#83713** (*"Opus 5 ends turn on 'doing it now'
narration without emitting tool calls (system-prompt guard ignored)"*, closed stale 2026-09-06). The
reporter established `stop_reason: "end_turn"` (ruling out truncation), no `tool_use` block (so no hook
or permission gate intervened), and that Anthropic's shipped remedy is a **prompt guard**: *"before ending
the turn, if the last paragraph is a promise about work not yet done, do that work now with tool calls"* —
which the model ignored. The reporter then built our detector and measured it: narrowed to *"turn-final,
text-only message whose **last line is an unconditional action-in-progress announcement**, followed by a
real user message"* it found **0 phantom instances across 639 turns** on Opus 4.8 / Fable 5 / Sonnet 5,
and **2 in 23** on Opus 5. So:

- it **confirms** the card's instinct — the reporter had to narrow to *last line* + *unconditional*
  precisely because the broad form fires on *"conditional offers ('if you approve, I'll write…'), a
  legitimate shape"*;
- it **refutes** an absolute version of "false-positive machine" — a carefully shaped detector reached 0
  FP;
- and it sets the honest denominator: **2 true positives in 23 candidates**, which the reporter himself
  calls suggestive rather than conclusive. Our own corpus says 2 true positives against ~47 negatives.

Corroborating reports of the identical symptom, **none fixed**: claude-code #25265 (*"Claude STATED it was
writing the plan… NEVER called the Write tool"*), #22508 (*"States 'Let me launch all 16 agents in
parallel' / Only emits 1 Task call… clear intent-execution mismatch"*), #27281 (the card's lead, dup of
#25265), #4462 (open 16 months, subagents reporting file creation that never persisted); opencode **#55378**
(open — reasoning-only turn, `finish_reason: stop`, settled silently — the closest upstream analogue to
our case, and it is still open).

**Two ways to avoid the detector entirely are already shipping upstream**, and this is the actionable
part: **cline** `completionPolicy.completionGuard` + `lifecycle.completesRun` — runs when the model
returns no tool calls, injects a system-level nudge, and has a **regression test for exactly our case**
(`"I am done"`, `finish: "stop"`, no tool call → nudge → tool call). **opencode**'s `/goal` judge
(`goal/judge.txt`: *"The assistant claiming the goal is met is not evidence"*) with a stall detector of
`sameReason(...) || !usedTools(...)`, `MAX_STALLS = 3`. **Both make completion a contract instead of
inferring it from prose.**

### 5. The card's secondary support is a category error (VERIFIED)

*"Every upstream project that added continuation bounded it at 2–3 (opencode 3, cline 3). Any
implementation here must carry that fuse."* Numerically correct, substantively misleading. Both bounds
sit **exclusively on the `length` path**, where the signal is a provider enum. Neither project bounds a
text detector because neither has one. And opencode's bound is a *belt-and-braces* window guard sitting
behind a detector whose own incident report (#18108, P5) says *"Detection requires exact JSON.stringify
match of inputs. **Truncation produces varying incomplete JSON each attempt so doom loop is never
detected.**"* — the fuse is the **response to** that incident, not prior art for a text heuristic.

### 6. Engine mechanics: a fuse exists, the injection path does not, and the costs are concrete (VERIFIED)

**Reusable with no new code:** `retry_abandoned_attempt` (the whole abandon → backoff → retract →
`Continue` choreography, shared by the mid-stream `Retryable` route and the #64 route); `RetryPolicy`
with its existing bound; `compactor.turn_abandoned`; the `auto_retry_*` frames; `message_retracted` →
display-row blanking + "Discarded an incomplete reply"; `settle_error` for the exhausted arm; and
`RpcEvent` deserialises **permissively** (unknown `type`s are debug-logged, never an error), so a new
variant is additive and safe.

**The fuse — and why it is the wrong shape.** `DEFAULT_MAX_ATTEMPTS: u64 = 5`, `RetryPolicy::new()` at
`worker/core.rs:350` (the only non-test production construction). `attempt` is mutated in exactly three
places: `+= 1` in `next_retry_delay`, and `.max(1)` in `note_success` and in `call_with_retry`. **There
is no reset at any turn boundary** — `self.retry` is touched at three sites in `loop.rs` (move out, move
back, `note_success`) and `begin_turn` does not touch it. So the budget is **four retries for the
lifetime of the Worker**, shared with the transport-error ladder, and a nudge would consume it. The
crate's own `retry.rs` docblock says *"The attempt budget is shared per TURN"*, which reads as a per-turn
*reset* that does not happen; `docs/features/abandoned-tool-rows.md` states the operative fact correctly
(*"`attempt` is per-turn-but-never-reset-to-zero"*). **That docblock is a live trap and worth
correcting regardless of what is decided here.**

**No injection path exists — exhaustive.** Every push into `self.messages` is: the user prompt
(`begin_turn`), assistant text (`handle_truncated_turn`, the clean-stop path), a `Tool`-role result
(`run_tool_batch`), the once-per-session `prepend_system`, or the compaction summary (which *replaces*
the vec). Nothing pushes a mid-turn message the model did not produce and the user did not type. And a
synthetic `System` message would not land where it was pushed: `ModelRequest::system_text()` folds every
`ChatRole::System` into one leading block and **all three wires then filter `System` out of the message
list**, so it is hoisted to the front of the prompt, far from the turn it meant to steer. It must be
`ChatRole::User` — which then merges with adjacent user rows on Anthropic's `anthropic_messages` path.

**A bare retry is a doom loop by construction.** `retry_abandoned_attempt` re-sends a **byte-identical**
request — `model_request` is a pure function of `self.messages` + enabled tools + `self.thinking_level`,
and nothing varies between attempts. Nothing new is introduced, so the same "I'm going to write it now"
is likely to come back. That is precisely cline #9920's mechanism (*"Each subsequent retry also gets
truncated, causing the same error in a loop"*) — and it means the nudge *must* inject content, which is
the machinery that does not exist.

**The bill for a false positive:**
- **A permanently-billed call on the visible cost line.** `emit_cost_update` runs on every attempt's
  `Usage` event and adds to `cost_acc`; `turn_abandoned` pulls the *context token* count back but the
  money is never refunded (correctly — the provider charged it).
- **The user's reply visibly blanked.** `message_retracted` overwrites the display row's `payload_json`
  with `{"text": ""}` and a `{stamp}:retract:N` line reads *"Discarded an incomplete reply"*. The text
  appeared and is erased — on a turn where the model was legitimately asking a question.
- **Welded system one-liners.** `auto_retry_start`/`auto_retry_end` use the **shared** `{stamp}:system`
  key, and `compute_display_rows` appends same-id chunks with no separator. **Measured: 103 of 104
  `:system` rows carry ≥2 welded markers.** Real content:
  `"Retrying (attempt 2/5…)Retry succeededRetrying (attempt 3/5…)Retrying (attempt 4/5…)Retrying (attempt 5/5…)Retry failed"`.
  A nudge adds to this noise.
- **A spurious compaction.** `Continue` re-enters the loop top, so `compact_if_due` runs again; near the
  window a nudge can trigger a full summary call + transcript rewrite for pressure that does not exist.
  `a_truncation_that_streamed_nothing_does_not_compact_the_next_turn` exists to pin that hazard.
- **Subagent corruption.** A nudge must not reuse `{stamp}:system` (welding), so it needs a new id
  family — and `is_bookkeeping_message_id` is a **hardcoded word set** (`system` / `retract` /
  `truncate`). `SubagentCapture::observe_sink_frame` skips a delta only if that predicate matches, and
  `captured_text()` returns the **last** message id's text. A nudge with a new word becomes the **entire
  parent-visible output** of a stalled child. No existing test catches the omission.
- **The titling pass** reads assistant transcript rows as the model's words
  (`count_user_interactions` / `first_exchange_text`), so a persisted nudge is summarised into session
  titles.

**What a nudge does NOT cost:** it does not duplicate a side effect. The engine is collect-then-execute —
`run_tool_batch` is called from one site, below both gates, and `consume_stream`'s `ToolCall` arm only
pushes to a `Vec` and emits display frames. So `acc.tool_calls.is_empty()` ⟹ nothing executed, and ADR
0108's hazard is genuinely not inherited. **But with a caveat worth carrying:** each wire's
`flush_tool_calls` **silently drops** any index that arrived without a `name` (`let Some(name) = acc.name
else { continue }`, no log line). A turn can stream `toolcall_delta` frames and flush to zero calls —
genuinely "cut off mid-call", exactly the shape a text heuristic would nudge and re-nudge. **Logging that
drop is worthwhile independently of any nudge decision.**

### 7. The user-visible surfaces cannot carry an honest outcome today (VERIFIED)

- **The alert already lies, before any nudge exists.** `attentionCandidates` raises a `settled` alert on
  the `inTurn: true → false` edge, gated only by `stalled !== true` and `stopReasons !== "cancelled"`.
  `attentionAlertText` composes **`"<label> finished — waiting for you"`**. `max_tokens` — the value #190
  made reachable — is **not excluded and not tested** (`grep max_tokens src/lib/attention.ts` → 0 hits).
  So a *truncated* turn already alerts "finished". No field in `AttentionSnapshot`
  (`candidateOrder`, `settledWatch`, `inTurn`, `stopReasons`, `waitingIds`, `stalled`) can distinguish
  "finished" from "announced and did nothing".
- **The footer cannot surface it without a new `StopReason`.** `transcriptFooterIsEmpty` suppresses
  `end_turn` — the escape hatch's exact value — and the only reason line is `Turn ended: {stopReason}`,
  a machine token, not English. (`StopReason::MaxTokens` now has **one** live construction site, in
  `resolve_turn`; `MaxTurnRequests` still has **zero**.)
- **"Retry failed" is typographically identical to model prose.** It rides `agent_message_chunk` →
  `agent-text` → `MessageBubble`'s `AgentText`, whose band is `bg-composer` — **the composer's own fill**,
  i.e. the colour that means "the agent's text". `MessageRow.kind` carries no authorship marker. And
  `auto_retry_end`'s `final_error` payload — the one field carrying the real reason — is read by **0
  sites in `src/`** and discarded by `normalize`'s `{ success, .. }` destructuring before a frame is even
  built, so it is write-only in **both** repos.
- **Stale tool cards.** Hydration is fixed (`mapPersistedStatus` downgrades every unresolved status to
  `failed` on reload, shipped in PR #191); the **live** path is not — `finalizeSessionMessages` is wired
  only to `handleSessionClosed`, which a crash never emits, and the shimmer is driven by
  `status === "pending"`. A nudge firing while a card is open would leave a permanently shimmering card
  beside a "finished — waiting for you" alert: the machine saying "still working" and "done" in the same
  breath. *(The composite is INFERRED from two independently verified mechanisms; no nudge exists to
  observe.)*

### 8. The gateway hazard is real, and worse than the card stated (VERIFIED)

The card's requirement — *detect the turn shape, not only `finish_reason`, because a gateway can rewrite
truncation into a success value* — is **correct**, and the record is busier than the two issues it cites:

| Source | Finding | Status |
|---|---|---|
| vLLM #53269 | the card's citation | **Closed as duplicate of #47903** |
| vLLM **#47903** | the real finish_reason divergence | **STILL OPEN** (2026-10-23) |
| vLLM #46303 | the fix, now `tool_calls_utils.py` — *"a `length` cut stays visible"* | merged 2026-09-23; **three further attempts (#47963, #53270, #58286) closed unmerged** |
| llama.cpp #30773 | `/v1/responses` reports a truncated call as `completed` | **OPEN.** Confirmed at master `fc504f91`: 7 hardcoded `{"status","completed"}`, the string `incomplete` appears **zero times** in `server-task.cpp`, while `stop_type_to_str()` *does* have `case STOP_TYPE_LIMIT` — **the server knows and the serializer throws it away.** Second defect: `response.function_call_arguments.done` is never emitted **even for complete calls** |
| **sglang #50131** | truncated/malformed tool args **silently rewritten to `{}`** | OPEN 2026-11-12 |
| **LiteLLM #32686** | Bedrock stream ending without `messageStop` → **fabricated `finish_reason`**, truncated calls delivered as success | closed **withdrawn, not fixed** |
| **vercel/ai #24103** | `toolCallTracker.flush()` runs **before** the `finishReason == null` check | OPEN 2026-10-27 |
| **pi #8501** | OpenRouter streamed truncated `write` args **then returned `finish_reason: "tool_calls"`** | closed; fix was **client-side rejection**, not server-side truth |

pi #8501 is the decisive one: a provider returning `tool_calls` for a truncated call, in 2026, after all
the vLLM work. **The hazard is live.**

**But the card's proposed response is not achievable in this engine.** The honest inventory of what the
turn loop can observe *without* `finish_reason`: `TurnAccumulator` is exactly
`{ text, thinking, tool_calls, usage, finish }`; `Usage` is exactly `{ input_tokens, output_tokens }`;
`ProviderEvent` has no `Incomplete`, no `StopSequence`, no `Done { reason, details }`. **The cap is not
knowable**: `model_request` sends `max_tokens: None`, `Model` has no output-cap field (the discovery
layer's `max_output_tokens` is never reduced into it), and the ceiling lives in a **private** const inside
the Anthropic wire builder. So `output_tokens` vs `max_tokens` is **structurally unavailable**;
`finish == None` is nearly unreachable (all three wires synthesise `Done(Error)`, which
`consume_stream`'s fabrication guard turns into a `Retryable` **before** any gate runs); `thinking` length
is deliberately excluded from the #64 gate because non-empty reasoning *is* the failure shape.
**A "turn shape" detector is therefore a length heuristic, not a detector** — which is the same wall §3
hit from the other direction.

### 9. A free, retroactive instrument exists — and it already found the symptom (VERIFIED)

The engine writes two independent records of every turn: `messages` (display) **per frame**, including
text from attempts later retracted, and `native_messages` (transcript) **only when the turn was accepted**
(`persist_transcript_message` on the accept/truncate paths; `retry_abandoned_attempt` writes none). Their
disagreement is a latent instrument nobody designed:

```sql
-- model-text display rows (key <6hex>:mN) with no byte-identical assistant transcript row, same session
-- → 3,117 orphans of 48,882 model-text display rows, all-time
```

**Three orphans post-build, and all three read exactly like the report:**
*"Angle 2's child stalled on a board tool it had no business calling. I'll ground that angle inline —
it's a handful of gr…"* → turn ends; *"Grounding complete (angle 2 inline — the child had called
`get_task` and hung…"*; *"Grounded. Two things the grounding settled that I can't decide for you…"*.

**Cost: zero bytes, zero code, zero privacy, retroactive to the beginning of the DB.** Its limit is the
thing that decides this card: the orphan set is a **superset** — it catches the escape hatch *and*
retracted retries *and* cancelled turns *and* `mergeDedupeKey` duplication artefacts. It is a **sampling
funnel, not a rate**, and it still cannot separate the hatch from the legitimate question. It is, however,
exactly the instrument the card wished it had: anyone who wants to decide this should **read those three
turns** before writing code.

### 10. Three stale premises on the card — verify before acting (VERIFIED)

1. Engine HEAD is **`3c9d416`** (`v0.3.1-6-g3c9d416`, branch `feature/anthropic-output-ceiling`), not
   `50bed1d`. The gates are byte-identical between them and in the published 0.3.1, so the analysis holds.
2. The desktop is on **`main` @ `700714b2`** pinning **`fulcrum-harness = "0.3.1"`**, not 0.3.0. The branch
   the card names (`stack/silent-turn-settle`) does not exist locally, and
   `docs/roadmap/silent-turn-settle.md` is **no longer in the tree** — the six facts it held were folded in
   `bacae0fb`, so anything still citing that path is dead.
3. **The Anthropic output-ceiling fix `070f542` is UNRELEASED** (`git tag --contains 070f542` is empty;
   `v0.3.1` peels to `8741b09`). Both published 0.3.0 and 0.3.1 carry the **old** arithmetic: at `xhigh`
   (budget 40,000) the pinned crate still sends `max_tokens = 41,024`. `docs/roadmap/anthropic-output-ceiling.md`
   is open in the tree, so this work is in flight. **Consequence: any measurement of nudge value taken
   against the pinned crate partly measures a `max_tokens`-sizing artefact.** Do not decide this card's
   fate before the ceiling ships and the numbers move.

---

## Evidence

**Local, primary.** `/home/daniel/silent-turn-escape/snap.db` (read-only `cp` of the live 2.43 GB
`~/.local/share/archimedes/archimedes.db`, taken 2026-11-15 23:18; **a working file outside the repo, not
durable**). Engine `/home/daniel/Coding/Archimedes/fulcrum` @ `3c9d416` + the published
`fulcrum-harness-0.3.1`. Desktop `/home/daniel/Coding/Archimedes/archimedes` @ `700714b2`. Running binary
`/tmp/.mount_archim*/usr/bin/archimedes`. **Upstream SHAs read at source:** opencode `aa2960fa` ·
cline `72b3d714` · codex `a394ff9c` · aider `5dc9490b` · goose `2365bc5e` · crush `0f9de6aa` ·
continue `5522c6f4` · openhands-sdk `5e49ddac` · kilo `94dd9028` (+ PR #5377 merge `f895b75f`) ·
vercel/ai `8ba3940d` · pi `e83fcd31` · vllm `e22287df` · llama.cpp `fc504f91`.

**Credibility order used:** engine/desktop source (the system under investigation) > upstream source at a
pinned SHA > vendor docs > maintainer-authored issue text > third-party issue reports. Closed-source
claims (claude-code) are marked **unverifiable**, never "negative".

**Claim grades:** **VERIFIED** = read in source or measured by a command in the Appendix. **INFERRED** =
reasoned from verified facts, labelled as such.

---

## Unresolved contradictions

1. **Rare-but-real vs unmeasurable.** claude-code #83713 reached 0 FP over 639 turns with a *narrow* shape
   (last line, unconditional) and still caught 2/23 — so the signal is extractable. Our corpus says 2 true
   positives against ~47 negatives. Both stand: **a detector is possible; the base rate here is ~2 sessions
   per 41 days.** The disagreement is about economics, not feasibility.
2. **The running binary's provenance.** It lacks the `disposition` string, consistent with a pre-#197
   build, and one researcher read it as self-reporting `0.16.2` while this repo is `0.14.0` — which is
   impossible for a build of this tree, so the AppImage may come from a different checkout. The `disposition`
   absence is VERIFIED; the version attribution is not.
3. **`retry.rs`'s own docblock vs its own behaviour.** *"The attempt budget is shared per TURN"* reads as a
   per-turn reset; no reset exists. `docs/features/abandoned-tool-rows.md` has it right. One of the two is
   wrong and the wrong one is the one a future reader will find first.

---

## Gaps

1. **The 2 unambiguous cases cannot be attributed to a route.** Whether `4a2c010a` / `ad08852d` went the
   `Length` route or the clean-`stop` route is **undecidable** — no `finish_reason` is persisted anywhere.
   That inability is itself the finding, and it is the strongest argument for the sibling card's scope
   (persist the disposition), which this report *de-prioritises for this question* (§8: both sides of this
   boundary carry `"stop"`) while it remains valuable for every other truncation question.
2. **Model/gateway attribution is unchanged and unsound.** 96 main / 2,276 subagent sessions;
   `capabilities_json` carries the model for main sessions only and is the literal `null` for subagents;
   there is no parent-session column. Any cross-model rate claim from this DB is invalid.
3. **The tail regexes are a floor and a direction, not a classifier.** Word-boundary failures alone moved
   one count from 16 to 320 (`I'll` matching `still`). Treat 23 / 47 / 75 as magnitudes.
4. **claude-code is closed source** — "no detector there" is unverifiable. #83713's evidence (a prompt
   guard, ignored) is a stronger argument against the detector than silence would be.
5. **Zed's agent path 404'd** and was not read. TensorRT-LLM / TGI / Ollama returned zero *reports* for
   truncation-vs-finish_reason — absence of reports, not absence of bug.
6. **Whether a declared-disposition contract is honoured by models in practice** is unresearched here. The
   contract-based alternative (§4's cline `completionGuard` / opencode goal judge) is the recommended
   direction and Anthropic's prompt guard is *reported ignored* in one instance, which is exactly the risk
   that direction inherits. This is the gap a follow-up should close before `specify` fixes a design.

---

## What the evidence supports (not a decision — `specify` owns that)

Ranked by cost-to-coverage, and **the detector is last**:

1. **Do not build the announced-intent detector.** The shape contains its own false-positive class
   (23 vs 47), the base rate is ~2 sessions/41 days, eleven codebases have never built it, one maintainer
   team refuses it in a comment, and the one measured attempt had to narrow to *"last line + unconditional"*
   to reach 0 FP. **This closes the card's stated scope.**
2. **Make completion/asking a contract, not a classifier.** The only upstream-precedented way to make the
   shape detectable *at all*. Two shapes: require the `ask` tool for questions (cheap in code, expensive in
   behaviour — it forbids the natural *"want me to?"* a user answers with one keystroke), **or** give the
   turn a declared `done` / `needs-input` disposition (a `StopReason` variant + a `payload_json` key, and a
   prompt contract the model must honour — the real cost, and a product decision). Close Gap 6 first.
3. **Fix the lying surfaces — independently valuable, no detector required.** The alert says *"finished —
   waiting for you"* for a `max_tokens` turn today; `attention.ts` has no `max_tokens` test. The footer
   renders `end_turn` as silence. `auto_retry_end.final_error` is write-only in both repos.
4. **Fix the welded system bubble — independently valuable.** **103 of 104** `:system` rows hold ≥2 welded
   one-liners (`"Retrying (attempt 2/5…)Retry succeededRetrying (attempt 3/5…)…Retry failed"`). This is a
   present, visible defect, and every future harness one-liner (including any nudge) inherits it.
5. **Log the nameless-tool-call drop** in all three wires' `flush_tool_calls` — silent today, unlike
   `parse_arguments` which does log. It is the one case where "no call accumulated" ≠ "no call attempted",
   so it matters to any future shape logic and to #193.
6. **Use the free orphan census as a sampling funnel**, not a rate: 3,117 all-time, 3 post-build, all three
   the reported shape. Read them before writing code.
7. **Correct `retry.rs`'s "shared per TURN" docblock** — it asserts a per-turn reset that does not exist,
   and `docs/features/abandoned-tool-rows.md` already states the truth.
8. **Re-measure after `070f542` ships.** The pinned crate still sends `max_tokens = 41,024` at `xhigh`; until
   the ceiling releases, any count of this shape is partly a sizing artefact.

---

## Appendix — re-runnable instruments

```bash
DB=/home/daniel/silent-turn-escape/snap.db   # a cp of ~/.local/share/archimedes/archimedes.db
Q() { sqlite3 "file:$DB?mode=ro" "$1"; }      # NEVER open the live DB read-write; the desktop locks it
```

| # | Question | Instrument | Measured |
|---|---|---|---|
| 1 | The escape hatch leaves no notice | `Q "select count(*) from messages where json_extract(payload_json,'\$.text')='Response was truncated before completion'"` ; `… where message_key like '%:truncate:%'` ; `… where json_extract(payload_json,'\$.disposition') is not null` | `0`, `0`, `0` (vs **255** under `LIKE` — all conversation content) |
| 2 | The `LIKE` trap, both directions | `Q "select count(*) from messages where payload_json like '%Response was truncated before completion%'"` | `255`, **0** genuine |
| 3 | `agent-thought` `<invoke>` hits, key-level | `Q "select count(*) from messages where kind='agent-thought' and json_extract(payload_json,'\$.text') like '%<invoke name=%'"` → 44; then classify by whether the text names `ProviderEvent`/`to_string()`/`test` | 44 raw → **~1–2 genuine**; 136,158 `agent-thought` rows total |
| 4 | The card's cited case predates #64 | `Q "select created_at from messages where kind='agent-thought' and session_id like 'arch_789c677f%' and json_extract(payload_json,'\$.text') like '%<invoke name=%'"` | `1792334525725` = 2026-10-18 16:42; #64 fix `b3d8f5c` = 2026-10-20 09:34 (`1792481640000`) |
| 5 | Visible-channel markup rows (the D1 class) | `Q "select count(*) from native_messages where role='assistant' and coalesce(json_type(content_json,'\$.tool_calls'),'null')='null' and (json_extract(content_json,'\$.content') like '%<invoke name=%' or … '%<parameter name=%' or … '%｜DSML｜tool_calls%')"` | **5**, all session-terminal, all post-#64; reading them = model reasoning *about* a call, or research quoting |
| 6 | The intent-regex denominator | terminal text-only assistant rows, `lower(substr(txt,-200))` against `like '%i%ll %' or '%i will %' or '%going to %' or '%let me %'`, split by `sessions.is_subagent` | **535** total = **506 subagent + 29 main**; main-session terminal text-only rows total **75** |
| 7 | Announce vs question | same rows, main sessions only, 160-char tail vs the two phrase sets | 248 rows → **23 announce / 47 question / 76 with `?` / 2 both** |
| 8 | What the user types next | for each announce-like main-session row, the next `role='user'` row's text | ~70 replies: `write`, `ok`, `continue`, `yeah` + new tasks/tangents + `$finish` skill calls |
| 9 | The 2.3× length ratio (not 29×) | `median(len)` over text-only assistant rows split by "is this the session's last row" | terminal **4,738** vs mid **2,086** |
| 10 | Welded system one-liners | count `:system` rows whose text holds ≥2 of `Retrying (attempt` / `Retry failed` / `Retry succeeded` / `Compacting context` / `Compaction finished` / `Compaction failed` | **103 of 104** |
| 11 | The free orphan census | model-text display rows (`message_key glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]:m*'`) with no byte-identical assistant transcript row in the same session | **3,117** of **48,882**; 3 post-build |
| 12 | The fuse is never reset | `grep -n "attempt" src/harness/retry.rs \| grep -E '=\|\.max\|\+= '` → only `+= 1` and two `.max(1)`; `grep -rn "\.retry = " src/harness/loop.rs` → 3 sites, none a reset; `RetryPolicy::new()` production sites: `worker/core.rs:350` | 4 retries per **Worker lifetime** |
| 13 | No synthetic-message path exists | enumerate every `self.messages.push`/`insert` in the crate: `begin_turn`, `handle_truncated_turn`, `run_tool_batch`, `prepend_system` (once per session), `run_compaction` (replaces the vec) | 5 sites, none mid-turn synthetic |
| 14 | `finish_reason` is still never persisted | `Q "select count(*) from native_messages where json_extract(content_json,'\$.finish_reason') is not null"` | **0** of 155,714 assistant rows |
| 15 | The pinned crate predates the ceiling fix | `cd …/fulcrum && git tag --contains 070f542` | **empty**; `git describe` → `v0.3.1-6-g3c9d416` |
