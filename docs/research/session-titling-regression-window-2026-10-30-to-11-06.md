---
status: current
last-verified: 2026-11-16
task: regression-window hunt — why session titling stopped working
method: local git only (no web), plus a read-only copy of the live DB at /tmp/probe.db
verified-by: >-
  Repo HEAD 74e38fa1. Pre-move desktop source via `git show 47432a38:...`; pinned
  crate source at ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/
  fulcrum-harness-0.{1.0,2.0,3.0,3.1,3.2}; live DB copied to /tmp/probe.db (2.4 GB).
issue: none (investigation)
supersedes: none
---

# Titling did not regress in the 10-30..11-06 window — it has never worked since the two-stage rewrite

**The headline finding reverses the premise of the hunt.** The 19 stage-2 sessions are not
survivors of a working feature that later broke. **All 19 predate the two-stage titling commit
itself**, and the only reason they read `title_stage = 2` is a one-time SQL backfill in the
migration that introduced the column. Stage 2 has a **0% success rate** — measured, not inferred —
in every session ever created with the code that can produce it.

Two independent lines of evidence, each sufficient on its own:

**(1) Timestamps.** `4998a98f` "feat: two-stage async session titling with wire isolation (#136)"
was authored `2026-10-30 16:13:59 +0100` (epoch ms `1793373239000`). Measured against
`/tmp/probe.db`:

```
total stage-2 sessions:                       19
  created at or before that commit:           19
  created after that commit:                   0
```

There is no window in which stage 2 was ever reachable and then broken. It was never reachable.

**(2) The migration that manufactured the "working" evidence.** `db.rs:1179-1189` — the
`title_stage` gate — ALTERs the column in with `DEFAULT 0` and then immediately runs:

```sql
UPDATE sessions SET title_stage = 2 WHERE title IS NOT NULL
```

So every session that had already been titled by the **old single-stage** namer (ADR 0037's
`WHERE title IS NULL`, which shipped 2026-10-12 in `7e06b1b9`) was relabelled "stage 2" by the
migration, regardless of how many interactions it had. Those 19 rows are ADR-0037 titles wearing a
stage-2 badge. The per-era split is the signature:

```
era                        n   stage1  stage2
BEFORE_136 (<= 10-30 16:13) 22     0      19
AFTER_136                   77     7       0
```

Not one stage-1 row exists before the commit, and not one stage-2 row after it. The two eras are
disjoint by construction, and the boundary is the commit, not the calendar window I was asked to
hunt in.

The real regression is therefore **inside `4998a98f` itself**, and it is the one behavioural change
that commit made to the request body. What follows ranks the candidates.

---

## Candidate 1 (PRIMARY) — `max_tokens: Some(100)` caps the title answer below the model's reasoning floor

**Verdict: explains BOTH stage-2-never-fires and stage-1-rarely-fires. This is the cause.**

Citations:

- `src-tauri/src/agent/session/naming.rs:713-719` — the decision, at HEAD:
  ```rust
  let reasoning_effort =
      resolve_naming_reasoning(&model, request.settings.session_naming_reasoning.as_deref());
  let max_tokens = if reasoning_effort.is_some() {
      None
  } else {
      Some(100)
  };
  ```
- `src-tauri/src/agent/session/naming.rs:796-812` — what happens when the cap binds: a
  `FinishReason::Length` answer is accepted **only** if it cleans to ≥2 words with no newline;
  otherwise `note_failure(...)` and return. A cut-off answer is a counted failure.
- `docs/decisions/0086-two-stage-async-session-titling-with-wire-isolation.md:20-24` — the decision
  itself, including the sibling rule at line 23: *"When reasoning effort is resolved, `max_tokens` is
  omitted (`None`) so reasoning tokens cannot starve title generation; otherwise it is bounded to
  `Some(100)`."*
- `git show 7e06b1b9:src-tauri/src/agent/session/naming.rs` (lines ~515-522) — the PRE-#136 value was
  `max_tokens: None`. `git log -S 'Some(100)'` confirms `4998a98f` is the only commit that ever
  introduced it.

**The mechanism, and why it is deployed-config-specific.** The cap is applied *only* when
`reasoning_effort` resolves to `None`. And `resolve_naming_reasoning`
(`naming.rs:412-431`) returns `None` when either the setting is unset/blank **or** the model
advertises no thinking levels. The live settings file
(`~/.config/archimedes/settings.json`) has:

```
sessionNamingEnabled = true
sessionNamingModel   = null          <- no override; uses the session's own model
sessionNamingReasoning = null        <- resolves to None
defaultModel         = "wizards/Qwen/Qwen3.8-Flash-Next"
```

So on this deployment **every title request takes the `Some(100)` branch**. That is the worst
possible branch for this route, and the repo's own research already measured why
(`docs/research/max-tokens-is-never-sized-and-the-live-cut-is-reasoning-not-the-tool-call.md`,
§B "The live gateway"): the `wizards` LiteLLM route, model `Qwen/Qwen3.8-Flash-Next`, advertises
`default_reasoning_effort: "xhigh"`. Two of its probes are decisive:

- `xhigh` + `max_tokens: 2048` → `completion_tokens: 2048`, `reasoning_tokens: 2048`,
  **0 visible characters**
- cap unset → saturates at 131,072

At a reasoning effort of `xhigh` — which this route applies **by default when no effort is
requested** — a 100-token cap cannot reach visible text at all. The request spends its whole budget
on reasoning and returns `finish_reason: "length"` with nothing usable, which `naming.rs:806-812`
counts as a failure.

Pre-#136 (`max_tokens: None`) the same request got the full 131k and returned a title. That is the
86.4% → 9.1% collapse:

```
era           n   titled  pct    stage2
BEFORE_136   22     19    86.4    19
AFTER_136    77      7     9.1     0
```

**Why stage 2 fails strictly harder than stage 1** — the pattern the data shows, and the reason it
is not merely "fewer successes". Two compounding reasons:

1. **Stage 2's prompt is far longer.** `MULTI_TURN_EXCHANGE` collects up to 5 interactions with
   `MULTI_TURN_TOTAL_CAP = 2500` chars (`naming.rs:134-137`), against stage 1's
   `EXCERPT_CAP = 500` per side (`naming.rs:43`). A much longer prompt, at a fixed 100-token answer
   cap, is strictly more likely to be all-reasoning-no-answer. Stage 1 sometimes squeaks under the
   cap on a short greeting; stage 2 essentially never does. That is exactly "stage 1 survives
   partially, stage 2 never fires."
2. **Stage 2 must win twice.** A stage-2 title requires stage 1 to have succeeded first
   (`naming.rs:610-619`: stage 2 is gated on `row.title_stage == 1`). With a per-attempt success
   rate near zero, a *chained* two-in-a-row success is the square of that. Observed: 7 sessions
   cleared stage 1; **0** of them cleared stage 2.

**The failure budget does not explain the 63 stuck-at-stage-0 rows, and that matters.** Guard 4
(`naming.rs:587-591`) declines at `fails >= MAX_FAILURES` (3, `naming.rs:48`). But `note_failure`
(`naming.rs:890-899`) only increments when the session's `naming` slice **still exists**, and it is
`naming.rs:894-896`'s `get_mut(...).and_then(|row| row.naming.as_mut())` — a missing entry is
never re-created. The prompt-time and close-time nudges of ADR 0088 (`mod.rs:2018`, `mod.rs:2953`)
mean the pass is re-consulted far more than 3 times per session. So the budget, not the cap alone,
is what freezes a session at stage 0 *permanently*: three failures anywhere in its life and guard 4
declines forever. Both mechanisms are needed to explain the data; the cap supplies the failures, the
budget makes them terminal.

**The length correlation is consistent and points the same way.** First-user-message length vs.
titling, post-#136:

```
first msg     n   titled   pct
<80          12      3    25.0
80-199        3      1    33.3
200-599      14      1     7.1
600+         41      2     4.9
```

Longer first message → less likely to be titled. That is the signature of a fixed answer cap being
starved by a growing prompt, not of a guard that reads interaction counts (which is orthogonal to
message length).

### What this candidate does NOT need in order to be true

It needs no code change after `4998a98f`. That is the point: the regression window's *start* is
`4998a98f`, and the likely-appearing commits (`efd3d10b`, `b798ed88`, `eb8ac18b`) are all **after**
the breakage. They are chronologically downstream and cannot be the cause of a 10-31 failure.

Note also the single session created `2026-10-31 18:03` (`arch_96e612b8`, 2 user rows, 543 total,
`title_stage = 0`). It postdates `4998a98f` by ~26 h and predates *every* 11-02 commit
(`b798ed88` 11-02 00:04, `efd3d10b` 11-02 07:29) by a full day. Untitled. That single row
independently rules out the entire 11-02 set as necessary causes.

---

## Candidate 2 (secondary, real but not load-bearing) — reasoning-effort *cancels* the cap, so an override would have helped and does not exist

**Verdict: explains the shape of the escape hatch that is missing, not the outage.**

`naming.rs:715-719` sets `max_tokens: None` whenever `reasoning_effort.is_some()`. The ADR's stated
intent (`0086:23`) is that reasoning tokens "cannot starve title generation". But per Candidate 1,
the deployed route is `xhigh`-by-default, and `sessionNamingReasoning` is `null`. So the one
configuration that would disable the cap — setting `sessionNamingReasoning` to a level the model
advertises — is unset, and setting it would *also* leave reasoning at whatever that level costs. The
guard is inverted relative to the deployment: `Some(100)` is chosen precisely when the route will
spend its budget on reasoning anyway, because "no configured effort" is read as "no reasoning",
which is false for a route with a non-null `default_reasoning_effort`. Worth flagging as the
*reason the bug is invisible*: the code's own model of the world says this branch is cheap.

---

## Candidate 3 (contributing, independent of title generation) — `title_stage` counts *post-compaction* transcript rows, so long sessions can never reach interaction 5

**Verdict: aggravates stage-2-never-fires on long sessions; cannot be the primary cause.**

Citations:

- `naming.rs:607` — `let interactions = count_user_interactions(&messages);`
- `naming.rs:144-147` and `:392` — `count_user_interactions` and `multi_turn_exchange_text` both
  `continue` past `is_compaction_summary(m)`.
- `count_user_interactions` counts `ChatRole::User` rows only where `message_text(...).trim()` is
  non-empty (`naming.rs:158`).
- Compaction rewrites `native_messages` wholesale (`SessionStore::replace_messages` →
  `Db::replace_native_messages`, `storage/db.rs:1899+`), so rows counted today may not be the rows
  counted yesterday.

ADR 0037 already recorded the hazard ("A compaction can summarise the first exchange away"). The
new exposure #136 added is that stage 2's *trigger* is now a count over that mutable table. A
session whose early user turns have been summarized away can sit at stage 1 with 5+ real prompts and
never satisfy `interactions >= 5`.

Measured: **2 sessions sit at stage 1 with >=5 user rows and never re-titled** — exactly this
shape. That is a real second cause of stage-2-never-fires, but it is bounded (2 rows, not 7) and it
cannot explain the 63 stage-0 rows at all. Ranked below Candidate 1 for that reason.

---

## Candidate 4 (noise) — the close-time and prompt-time nudges can title from a partial transcript

**Verdict: not a cause of the outage; a caveat on interpreting stage-1 successes.**

ADR 0088 added `maybe_name_session` at `mod.rs:2018` (top of `send_prompt_with_images`) and
`mod.rs:2953` (`close_session`, before `detach`). These are *additional* triggers and strictly
increase the chance of a title, so they cannot explain a loss. They do mean a stage-1 title may be
generated from the user line alone, which slightly muddies any attempt to correlate title quality
with turn completeness — but no title-quality anomaly is present in the data (stage-1 and stage-2
titles are near-identical in shape: avg 31.0 vs 32.3 chars, 4.6 words each).

---

## RULED OUT — with the evidence that ruled each one out

### R1. `agent_end` is no longer emitted on the turn-exit paths (the crate move / #190 truncation work)

**Ruled out. `agent_end` emission is unchanged across every version, and across the move.**

- Pre-move desktop `47432a38:src-tauri/src/agent/harness/loop.rs:1059` and HEAD's pinned crate
  `fulcrum-harness-0.3.2/src/harness/loop.rs:1477` are the **same single emit site**, inside the
  same `if tool_calls.is_empty()` tail, emitting the same SUCCESS triple (`agent_end` /
  `turn_end` / `agent_settled`, `loop.rs:1388`).
- I checked every published version actually present in the local registry:
  ```
  fulcrum-harness-0.1.0: 1 emit site
  fulcrum-harness-0.2.0: 1 emit site
  fulcrum-harness-0.3.0: 1 emit site
  fulcrum-harness-0.3.1: 1 emit site
  fulcrum-harness-0.3.2: 1 emit site
  ```
  No version added or removed an `agent_end` site. `#190`'s `f539b86d` pins 0.3.0, which introduces
  `handle_truncated_turn` → `settle_truncated` → `settle_error` — and `settle_error`
  (`loop.rs` `turn.rs:853-861`, pre-move `turn.rs:602-609`) emits `turn_end` + `agent_settled` but
  **never `agent_end`, in either revision**. So the truncation work did not *remove* an
  `agent_end`; it was never emitted on failure paths by design (ADR 0088 explicitly rejects adding
  it: *"Emit `agent_end` from `settle_cancelled` / `settle_error` — rejected"*).
- **The catalogue of exits that never emitted `agent_end` is identical pre- and post-move:**
  cancelled (`settle_cancelled`), errored (`settle_error`), truncated (`settle_truncated`),
  empty-turn retry (`handle_empty_turn`), mid-stream error. All five are `turn_end`/`agent_settled`
  only. This is a *pre-existing* property, not a regression, and ADR 0088's nudges exist precisely
  to cover it.
- The move itself (`eb8ac18b`) is a pure relocation for this purpose: I diffed
  `eb8ac18b^:src-tauri/src/agent/harness/loop.rs` against
  `fulcrum-harness-0.1.0/src/harness/loop.rs` and the 516 changed lines are import-path rewrites
  (`crate::agent::X` → `crate::X`) plus doc-comment churn. No `agent_end`-affecting logic.

### R2. The router's `agent_end` arm was re-targeted / the `!is_subagent` guard now rejects main-session frames

**Ruled out. The arm is byte-identical to its pre-window form, and the delivery path is unchanged.**

- `src-tauri/src/agent/session/router.rs:210-212` at HEAD:
  ```rust
  if !is_subagent && matches!(e, RpcEvent::agent_end { .. }) {
      self.maybe_name_session(session_id);
  }
  ```
  `git show 47432a38:src-tauri/src/agent/session/router.rs:117-119` is the same three lines with
  the same guard. Nothing in the window touched it.
- The delivery side that could mis-set `is_subagent` is the pump's `delivery_id` computation. I
  diffed the pre-move `47432a38:src-tauri/src/agent/worker/manager/pump.rs` against
  `fulcrum-harness-0.3.2/src/worker/manager/pump.rs` and the `delivery_id` / `on_event` /
  `is_subagent` structure is **identical** (`state.hooks.on_event(&delivery_id, is_subagent,
  evt.clone())`). For a main session `is_subagent` is `false` and `delivery_id == session_id`, so the
  arm's guard passes and `maybe_name_session` receives the right id.
- Independent confirmation from the data: 7 sessions *did* reach stage 1 after the window. If the
  router arm were dead, those would be 0. The trigger path is alive; the *model call* is what fails.

### R3. #144 LiteLLM changed `Model.api_key` so `name_session`'s `is_empty()` guard now skips

**Ruled out by measurement and by code shape.**

- Setting `~/.config/archimedes/settings.json` has one provider (`wizards`, `api: "litellm"`,
  `authMode: "api_key"`) with a 25-character `apiKey` present. It is not empty.
- `b798ed88`'s change to this path is an *addition* of a resolver, not a replacement of the
  fallback: `session/mod.rs:483-491` calls `resolve_bearer` and on `None` falls back to
  `provider.api_key.clone()`. The pre-#144 line (`git show b798ed88^:.../session/mod.rs:408`) was
  `api_key: provider.api_key.clone()` — i.e. #144 only ever substitutes *more* keys into
  `Model.api_key`, never fewer. An `oauth`/`headers`-only provider could in principle end up with
  an empty static key, but this provider is `api_key`-mode.
- Decisive on chronology: the api_key guard existed unchanged at `7e06b1b9` (86.4% success) and at
  HEAD; #144 landed 11-02. A guard that was present during the working era cannot be the regression.
- Also worth noting: if this guard *were* firing, `naming.rs:705-711` logs a distinct line
  ("no configured auth for model …") and **consumes nothing** — no failure counted — so the session
  would stay retryable forever rather than freeze at `fails == 3`. The data shows sessions frozen
  at stage 0 across many prompts, which is the *budget* signature, not the *skip* signature.

### R4. `native_messages` is written too late, so guard 6 reads an empty transcript at `agent_end`

**Ruled out as a cause, though the general hazard is real and pre-documented.**

- The timing hazard is genuine and old: ADR 0037's consequences record it ("The assistant side of
  the excerpt may not be durable yet when the hook reads it") and ADR 0088 rejected merging the
  queues. But the measured data distinguishes "never written" from "written too late": 66 of the 73
  stage-0 sessions have ≥1 user row *eventually*, so the rows do land.
- More decisively, ADR 0088's two nudges (`mod.rs:2018`, `mod.rs:2953`) mean the pass is re-run on
  the *next prompt* and at close, long after any store-frame lag. A late write would cost one
  attempt, not the session. The observed freezing is permanent, which requires the failure budget,
  not a lag.
- The batching decorator (`storage/batching.rs`, `18d56a44` 11-15) is **chronologically excluded**
  and also structurally innocent: `insert_native_message` is explicitly *not* batched
  (`batching.rs:47-49`: "`insert_native_message` also upserts on a real key, `(session_id, seq)`,
  and it is NOT batched … `Insert` passes through"). The transcript table naming reads is written by
  the pass-through path.
- The regression predates batching by two weeks (10-31 vs 11-15).

### R5. The `naming`-slice teardown (`on_session_exited_expected`) strands `in_flight` or wipes `fails`

**Ruled out. The teardown is correct and is the *intended* semantics; it also cannot manufacture the observed state.**

- `router.rs:627-638` clears `naming` on a stalled row and `remove_session` otherwise; both are
  documented and pinned. The relevant fail-safe is that `InFlightClaim::drop`
  (`naming.rs:929-946`) and `note_failure`/`note_success` all use `get_mut(...).and_then(naming)`
  so a late completion after teardown is a **no-op** — it neither resurrects state nor clears a
  budget. That is fail-closed in the right direction.
- Mechanistically it cannot produce the pattern: the teardown runs at session *end*, whereas the
  sessions in question never titled at *any* point during their life.
- The commit that introduced this shape (`47432a38`, 10-31) is worth noting: it is the same day as
  the break, but it is a *pre-existing-merge refactor*. I traced it specifically — the wire shape of
  `claim_naming` / `naming_state` is behaviour-identical to the old standalone `naming` map
  (`git diff 4998a98f 47432a38 -- .../naming.rs`), except that "no entry" now also covers "row whose
  slice was cleared". That is a narrowing of when a budget can be *cleared*, which would make
  failures *stick longer* — consistent with, but not the cause of, the outage.

### R6. The `{id}-title` wire isolation broke the request

**Ruled out, with one un-verifiable residual noted in Gaps.**

- `transport.rs:158-179` (`fulcrum-harness-0.3.2`, moved verbatim from
  `4998a98f:.../transport.rs`) only alters `x-request-id` to `{sid}-{uuid}` when the id ends with
  `-title`, and passes `x-litellm-session-id` through unchanged. Both headers are *additional
  tracking metadata*; neither participates in auth or routing, so a title request is
  indistinguishable from a normal one apart from its correlation ids.
- The `session_id` change itself (`Some(format!("{session_id}-title"))`) is inert on the
  completions wire: the `session_id` field is consumed only by `litellm_headers`, not by the body
  builder (`openai.rs:968-996` builds `max_tokens` / `reasoning_effort` from `options` only).
- Chronology is the strongest argument: it is in the same commit as the primary cause, and the
  data's failure shape (all-reasoning truncation) is explained fully by Candidate 1 without it.

### R7. `clean_title`'s signature change / the Length-acceptance rule

**Ruled out as a *primary* cause, but it is the amplifier of Candidate 1.**

`clean_title(raw, Some(TITLE_MAX_CHARS))` (changed later, in `efd3d10b`-era work) is a pure
refactor for the session namer; the `Length` acceptance rule itself arrived *with* `Some(100)` in
`4998a98f` (see the `git diff 7e06b1b9 4998a98f` hunk that adds the `is_valid` block). It does not
create the failures — it declines to salvage a truncated answer that pre-#136 would have been
`FinishReason::Length` on a `None`-capped (i.e. never-truncated) request. So: correct behaviour,
applied to a request that should not have been capped.

### R8. Settings disabled naming

**Ruled out.** `~/.config/archimedes/settings.json` has `sessionNamingEnabled: true`, and
`config.rs` defaults it to true (`default_true`) so absence could not disable it either. The live
file is consistent with the code's expectation.

---

## Answering the framing question directly

> "why stage 2 stopped COMPLETELY while stage 1 survived partially"

Stage 2 did not *stop*; it never *started*. The 19 "stage 2" rows are ADR-0037 single-stage titles
relabelled by `db.rs:1185-1188`'s `UPDATE sessions SET title_stage = 2 WHERE title IS NOT NULL`.
Stage 1 "survives partially" (7 of 77 post-#136) because its 500-char prompt occasionally fits under
the 100-token cap when the model's reasoning run is short; stage 2's 2500-char prompt essentially
never does, and it additionally has to succeed *twice in a row* on a feature whose per-attempt
success rate is ~9%.

The 10-30..11-06 window does contain the answer, but only its first day: **`4998a98f`, 2026-10-30
16:13:59**. Everything the hunt brief listed from 11-02 onward (`efd3d10b`, `b798ed88`, `f630fd11`,
`4cf6b3c2`, `eb8ac18b`, `820baf6b`, the #190 truncation work, the #155 batching) is chronologically
downstream of a breakage that was already total, and the `2026-10-31 18:03` session — untitled, with
two user rows — closed the case independently.

---

## Gaps

1. **No in-app log evidence.** `debuglog::log` is a no-op unless `ARCHIMEDES_DEBUG=1`
   (`fulcrum-harness-0.3.2/src/debuglog.rs`), initialised from env at `lib.rs:545`. No
   `supervisor.log` past `2026-10-12` exists in `~/.local/share/archimedes/` (the two files there are
   `2026-10-12` and older). So I could not observe an actual
   `session-name: the title answer was truncated (Length)…` line. The Candidate-1 mechanism is
   inferred from code + the repo's own measured gateway probes
   (`docs/research/max-tokens-is-never-sized-…`, §B), not from this app's run logs. **Re-running with
   `ARCHIMEDES_DEBUG=1` for one untitled session would convert this from strong inference to direct
   observation** — that is the single cheapest confirmation available.
2. **The `fails` counter is in-memory only.** `NamingState` lives in `SessionState`
   (`mod.rs:730-746`) and is never persisted, so `title_stage = 0` cannot distinguish "never
   attempted" from "budget spent and frozen". My budget→freeze claim rests on the guard arithmetic
   plus the nudge count, not on a persisted counter.
3. **`title_stage = 1` is ambiguous evidence.** Because the migration backfilled
   `WHERE title IS NOT NULL`, and because the pre-#136 namer could also write a title, a stage-1 row
   proves *some* post-#136 stage-1 write succeeded — but I could not determine per-row whether the
   write came from `agent_end`, from the prompt nudge, or from close.
4. **The `xhigh`-by-default claim is imported, not re-measured.** I did not re-probe the gateway (the
   brief said local-only, and the repo's research already spent the authorised budget). The
   `default_reasoning_effort: "xhigh"` figure is quoted from
   `docs/research/max-tokens-is-never-sized-…:§B`, which cites a live probe. If that figure is wrong,
   Candidate 1's mechanism weakens — though the length correlation and the pre/post-136 rate collapse
   would still need another explanation.
5. **`/tmp/probe.db` is a file copy made while the app was live**, so the WAL was not checkpointed
   into it. Counts may be slightly stale versus the user's live numbers (I measured 2419 total
   sessions, 99 main). All the era-boundary and stage-split figures reproduce the brief's numbers
   closely enough that the conclusions are unaffected, but exact per-day counts may differ by a row.
6. **I did not examine** whether the Anthropic *wire* (rather than completions) is reachable for this
   route — `derive_wire_for_route` keys on `mode == "responses"` and this route's `mode` is `null`
   per the research doc, so completions is live. If a future config moves the route to Messages, the
   Anthropic builder has its own `max_tokens` clamp (`anthropic.rs:935-1004`,
   `anthropic_output_budget`) and the arithmetic would change.

---

## Sources

Repo files:

- `src-tauri/src/agent/session/naming.rs:43,48,134-137,412-431,498,585-591,607,610-619,705-711,713-719,796-812,890-905,929-946`
- `src-tauri/src/agent/session/router.rs:204-212,570-650`
- `src-tauri/src/agent/session/mod.rs:483-491,730-746,2018,2953`
- `src-tauri/src/storage/db.rs:1175-1189,1745-1762,1844-1876`
- `src-tauri/src/storage/batching.rs:47-49`
- `src-tauri/src/config.rs` (`session_naming_enabled`, `default_true`)
- `src-tauri/src/lib.rs:545`
- `docs/decisions/0037-supervisor-side-session-naming.md`
- `docs/decisions/0086-two-stage-async-session-titling-with-wire-isolation.md:20-24`
- `docs/decisions/0088-session-titling-is-level-triggered-from-undroppable-supervisor-calls.md`
- `docs/research/max-tokens-is-never-sized-and-the-live-cut-is-reasoning-not-the-tool-call.md` §B

Git revisions examined:

- `7e06b1b9` (2026-10-12, ADR-0037 single-stage namer — the last known-good)
- `4998a98f` (2026-10-30 16:13:59, two-stage + `max_tokens: Some(100)`) ← **the boundary**
- `47432a38` (2026-10-31), `efd3d10b` / `b798ed88` / `f630fd11` / `4cf6b3c2` (2026-11-02)
- `eb8ac18b` (2026-11-05), `820baf6b` (2026-11-05)
- `18d56a44` (2026-11-15, batching), `f539b86d` / `700714b2` / `61ba91ee` (#190 pins 0.3.0/0.3.1/0.3.2)

Pinned crate (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`):

- `fulcrum-harness-0.3.2/src/harness/loop.rs:1388,1477`
- `fulcrum-harness-0.3.2/src/harness/loop/turn.rs:430-460,840-861`
- `fulcrum-harness-0.3.2/src/harness/provider/openai.rs:968-996`
- `fulcrum-harness-0.3.2/src/harness/provider/transport.rs:158-179`
- `fulcrum-harness-0.3.2/src/worker/manager/pump.rs` (`delivery_id`, `on_event`)
- `fulcrum-harness-0.1.0` … `-0.3.2` `src/harness/loop.rs` (agent_end site census)

Data: `/tmp/probe.db` (copy of `~/.local/share/archimedes/archimedes.db`), and
`~/.config/archimedes/settings.json`.
