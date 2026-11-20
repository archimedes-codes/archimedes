---
status: current
last-verified: 2026-11-20
verified-by: mixed — engine + desktop source audit (2 repos, ~40 files), local SQLite measurement (445k rows, 2.83 GB), upstream primary-source audit (8 projects); 4 researcher dispatches + parent verification, all at HEAD b2d6ea95 (archimedes) / 3d7dfb6 (fulcrum)
task: tsk_e201c70f-80e3-4a52-8082-84d1993bf494
---

# Remove `MAX_MODEL_ROUNDS_PER_PROMPT` — deletion blast radius, real runaway risk, upstream prior art

## Executive Summary

**Settled question:** `MAX_MODEL_ROUNDS_PER_PROMPT` is being deleted — what does removal break, is
the unbounded-loop risk real without it, and what does upstream prior art say about shipping a turn
loop with no round ceiling? `MAX_IDENTICAL_REFUSAL_RUNS = 3` stays untouched (user-set scope, so this
report never proposes changing it — it only establishes what that guard still needs).

Deleting the round ceiling is a **small, safe change**: the desktop compiles unchanged, the wire
protocol does not move, and zero desktop test pins are round-exclusive. Two findings materially change
the task card's framing.

1. **The card's own cited justification is fabricated.** `fulcrum:src/harness/loop.rs:492-494` reads
   *"opencode 32, kiro 50, crush 64, cline 1000"* and admits the number "was taken from the upstream
   band." **Zero of those four numbers verify against current source.** crush has no round cap at all
   (and `charcoal-house/crush` is not a repo — it is `charmbracelet/crush`); cline's default is
   unbounded (no `maxApiRequestsPerUserInput`, no `1000`); opencode defines no default for `steps` and
   degrades to a text-only summary rather than erroring; kiro is closed source with no obtainable
   source. The 64 was copied from a band that does not exist.

2. **The card understates its own evidence.** It reported 8 cap events. Re-measured four times on
   2026-11-20: **8 → 11 → 13 → 14** (13 sessions). Three of those 14 are this session's own research
   subagents, killed mid-sentence by the guard under study. Five of the 14 are a *parent* session
   recording a child's cap as a tool failure. **All 14 landed on exactly 64 assistant rows** (the round
   ceiling, never the refusal guard), **all 14 stopped immediately after a `completed` tool call**, and
   failures ran 2.5–11.2 % with **2–7 distinct signatures each** — the opposite of an
   identical-refusal loop.

The one real risk is narrow and fixable: the surviving guard keys on **exact argument equality**, and
three projects that studied this independently found that a loop varying one argument walks straight
past it.

---

## Findings

### F1. What breaks if it is removed: almost nothing

#### Engine (`fulcrum`, crate `fulcrum-harness`, HEAD `3d7dfb6` / v0.5.0)

- **The constant is private** — `loop.rs:503` is `const MAX_MODEL_ROUNDS_PER_PROMPT: u32 = 64;` with no
  `pub`. Deleting a private item is **not a breaking change for the crate**, which is what decides the
  publish level (§F1-Sequencing).
- **`model_rounds` has zero readers outside the guard.** `grep -rn "model_rounds"` outside
  `loop.rs` / `loop/turn.rs` / `turn_lifecycle.rs` returned nothing: no diagnostics, no cost, no
  telemetry, no serialization. `TurnLoopState` is `pub(super)` and never crosses the crate boundary.
  The guard (`loop.rs:1561`), the increment (`:1609`), the init (`:1515`), and the field
  (`loop/turn.rs:125`) all go together.
- **A half-done deletion is a CI failure, not a silent regression.** `.github/workflows/ci.yml:75` is
  `cargo clippy --all-targets -- -D warnings` (with `--all-targets` deliberately, so test targets are
  linted too), and `cargo fmt --all -- --check` runs before it (`:66-67`). A dead `model_rounds` field
  reddens CI on all three OS legs.
- **`src/source_lints.rs` does NOT lint either constant.** Its only mention of either name is inside an
  `assert_eq!` failure message (`:623`). The lint at `:594` counts denial-marking `true`s in
  `run_tool_batch` and `dispatch_tool` forwards, reading `turn.rs` and `interactive/mod.rs` only — never
  `loop.rs`. **Deletion cannot break it or its tests.** Its purpose becomes *more* load-bearing: it is
  now the only thing between a new denial corridor and an unbounded turn.

#### Wire: no change

`RpcEvent::turn_capped` is emitted from **exactly one site** (`loop.rs:1572`) shared by both producers
through one `if … || …`. After deletion, `MAX_IDENTICAL_REFUSAL_RUNS` is its **sole** producer, so:

- `normalize.rs:724-732` (the `turn_capped` arm) matches the *event*, never the reason — unchanged.
- `cap_id()` (`normalize.rs:158-162`) is producer-agnostic — unchanged.
- `TURN_CAPPED_DISPOSITION = "max_turn_requests"` (`normalize.rs:223`) stays. Its docblock's claim
  *"emitted from exactly ONE path (the turn-bound settle) … A second emitter must introduce its OWN
  value"* is **strengthened**, not broken.
- `PROTOCOL_VERSION` stays 1. `events.rs:79-91`'s older-peer argument (a stale peer drops the frame and
  settles unlabelled) is untouched.

`events.rs:73-76`'s doc comment must lose one clause:

> `/// (the turn-loop bound) The turn was stopped by the AGENT's own turn limit`
> `/// — the round ceiling (\`MAX_MODEL_ROUNDS_PER_PROMPT\`) or a run of identical`
> `/// refused tool batches (\`MAX_IDENTICAL_REFUSAL_RUNS\`) — before it finished.`

The `MAX_MODEL_ROUNDS_PER_PROMPT` parenthetical and the coordinating "or" go false; "the AGENT's own
turn limit", `MAX_IDENTICAL_REFUSAL_RUNS`, "before it finished", and the whole ordering sentence survive.

#### Desktop (`archimedes`): no production change at all

The desktop **never names the constant in code**. All four hits are comments:
`src-tauri/src/agent/session/router.rs:1079`, `src-tauri/src/agent/session/mod.rs:311-312`,
`src/lib/transcript/reducer.ts:162`. `src-tauri/tests/` returned nothing for
`max_turn_requests|MaxTurnRequests|turn_capped|MAX_MODEL_ROUNDS`. **`cargo check` compiles unchanged
against the new engine** — the coupling is exclusively to the wire (`RpcEvent` re-exported at
`src-tauri/src/agent/mod.rs:102`) and to the `TurnDisposition`/`StopReason` enums the desktop owns
itself (`mod.rs:126-138`).

**The exhaustive match is confirmed and unaffected** — `router.rs:535-540`:

```rust
let reason = match (cancelled, stashed) {
    (true, _) => StopReason::Cancelled,
    (false, Some(TurnDisposition::Truncated)) => StopReason::MaxTokens,
    (false, Some(TurnDisposition::Capped)) => StopReason::MaxTurnRequests,
    (false, None) => StopReason::EndTurn,
};
```

Exhaustive over `(bool, Option<TurnDisposition>)` with no `_` on the `Option`; its documented purpose
(`router.rs:495-502`) is to make a *new* disposition an `E0004`. Deleting a producer adds and removes no
variant, so no arm goes dead and the refactor does not need to move. Deleting
`TurnDisposition::Capped` outright would be a **behaviour regression** (every doubled-identical-refusal
cap would silently settle `end_turn`) and would redden `router.rs:1086` + `attention.test.ts:185`.

**User-visible surface, unchanged:** a capped turn renders the raw wire token —
`TranscriptFooter.tsx:107-110` prints `Turn ended: {stopReason}`, so the literal string
`Turn ended: max_turn_requests`. There is **no i18n or friendly-label layer** anywhere near `StopReason`
(`dispositionFromRows`, `reducer.ts:208-209`, is an *identity* mapping for this value), and
`attention.ts:205`'s `=== "end_turn"` whitelist means a capped turn gets **no OS alert** — the honest
silence. Unchanged by this deletion, and unchanged *because* the disposition still arrives.

#### Test pins — 18, classified by producer

**Engine:**

| Class | Tests |
|---|---|
| **ROUND** (must go / be re-pointed) | `a_turn_that_hits_the_round_ceiling_settles_as_capped` (`turn_lifecycle.rs:3918`), `a_repeated_batch_of_failing_well_formed_calls_is_never_a_refusal_run` (`:3794`, asserts `calls == MAX_MODEL_ROUNDS_PER_PROMPT` at `:3823`), `a_mixed_batch_resets_the_identical_refusal_run` (`:3850`, BOTH) |
| **ROUND-armed, invariant survives** | `a_cancel_beats_the_turn_bound` (`:4003`) — arms via `fire_on: MAX_MODEL_ROUNDS_PER_PROMPT` at `:4071`, asserts no `turn_capped` at `:4117`. **The only pin of "a Stop wins over the bound" — re-point it, do not lose it.** |
| **REFUSAL** (survive) | `a_run_of_identical_refused_batches_stops_the_turn_as_capped` (`:2959`), `a_run_of_identical_empty_argument_batches_stops_the_turn_as_capped` (`:3076`), `a_call_using_an_advertised_alias_is_never_a_refusal_run` (`:3160`), `a_sudo_exec_confirm_refusal_is_never_a_refusal_run` (`:3340`), `a_confirmed_sudo_exec_that_fails_is_never_a_refusal_run` (`:3528`), `a_permission_denial_is_never_a_refusal_run` (`policy_gate.rs:2854`) |
| **PLUMBING** (survive unchanged) | `a_capped_turn_closes_nothing_and_carries_the_prior_results` (`tool_row_settle.rs:1314`), `a_capped_turn_emits_one_line_on_its_own_message_id` (`normalize.rs:1681`), `a_second_cap_gets_its_own_line_id` (`:1707`), `two_incarnations_mint_disjoint_ids_for_the_same_counter` (`:1726`), `a_capped_row_carries_the_max_turn_requests_disposition` (`:2557`), `a_capped_child_that_announced_a_tool_is_not_completed_empty` (`subagent_flow.rs:2695`), `a_capped_child_keeps_its_partial_text_and_never_its_notice` (`:2773`), `the_truncation_arm_outranks_the_cap_arm` (`:2834`), `the_cap_arm_leaves_the_other_two_dispositions_alone` (`:2851`) |

**Desktop — all 8 are PLUMBING, zero edits required.** Every one drives `RpcEvent::turn_capped`
synthetically (`router.rs:1102`, `:1266`, `:1328`; `tests/mod.rs:3527`) or feeds a hand-built row with
`disposition: "max_turn_requests"` (`reducer.test.ts:513-521`, `sessions.test.ts:7298-7307`). None
constructs a round counter or names `64`:
`main_session_turn_capped_resolves_the_turn_as_max_turn_requests` (`router.rs:1086`),
`cancel_requested_wins_over_a_cap` (`:1250`), `a_forced_resolve_retires_a_stranded_cap` (`:1311`),
`a_fresh_send_prompt_clears_a_stale_cap` (`tests/mod.rs:3512`), `reads a capped turn's disposition
(identity mapping, no translation)` (`reducer.test.ts:512`), `openSession seeds stopReasons from a
CAPPED notice…` (`sessions.test.ts:7310`), `resumeSession seeds…` (`:7331`), `never arms for a
max_turn_requests stopReason…` (`attention.test.ts:185`).

**Three engine pins HANG rather than fail if the const goes without touching them** — the exact failure
`tests/support.rs:170-184` was written to prevent. Budgets in `ScriptedProvider` that run to 64 rounds
become unbounded loops.

#### Orphaned prose in the surviving guard's own docblock

`MAX_IDENTICAL_REFUSAL_RUNS`' docblock (`loop.rs:505-722`) leans on the ceiling in seven places. Each
becomes false or meaningless:

- `:506` *"(the second producer of `RpcEvent::turn_capped`)"* → **false**, there is no first.
- `:514-518` *"owns this counter and `model_rounds` beside it … BOTH counters reset"* → half false.
- `:557-558` *"the burst ran to the 64-round ceiling: 64 rounds of a doomed call instead of 3"* → false.
- `:599-600` *"the same shape reaches the 64-round ceiling, because nothing refused it any more"* → false.
- `:662-664` *"a stuck run that escapes these ends on the 64-round ceiling, which is a worse turn; a
  false positive ends the user's prompt, which is a worse bug"* → **false and the most consequential**:
  this is the sentence arguing the guard's deliberate under-count bias is *safe*. With the ceiling gone,
  an escape is not "a worse turn", it is an unbounded one. **This sentence must be rewritten, not
  deleted, and its replacement is the honest statement of the new risk.**
- `:676` *"The residual for that shape is the 64-round ceiling"* → false.
- `:703` *"Like the round ceiling, 3 is a STARTING value"* → antecedent gone.
- `:722` *"The bound is on the number of ROUNDS"* → not true of the refusal run.

Guard comment `loop.rs:1543-1560`: `:1544` ("The round ceiling and the identical-refusal run") and
`:1553` ("**Both** guards") go false. `:1545-1552` (Stop-wins) and `:1554-1560` (the unbounded
`run_tool_batch` `join_all`) survive verbatim and matter **more** after deletion. The `eprintln!` at
`:1563-1566` loses `rounds={}`. `docs/features/abandoned-tool-rows.md:163,188` and the prose census at
`loop.rs:558,600,663,676,703,1544,1607,1896` / `turn.rs:216,352,471` / `tests/support.rs:198` should
move in the same commit.

#### Docs needing rewrite: 4 files, ~7 sentences

| File | Line | Sentence | Fix |
|---|---|---|---|
| `docs/features/malformed-tool-call-arguments.md` | 38 | §1 table: "`MAX_MODEL_ROUNDS_PER_PROMPT` + `MAX_IDENTICAL_REFUSAL_RUNS`" | drop the first |
| ″ | 49-58 | **§2 in full** — "The loop bound counts a ROUND, not an HTTP request", the `× RetryPolicy.max_attempts` arithmetic, the upstream-band justification | **void**; shrink to the run-bound semantics |
| ″ | 63 | "worse than a loop that runs to the 64-round ceiling" | comparator gone; the cost argument survives, the scale reference does not |
| ″ | **79** | **"Wrong-type required values (`bash {"command": 42}`) and empty alias values fall to the round ceiling."** | **highest-value correction in the repo** — those now fall to *no bound at all* (the refusal guard deliberately excludes them, `:65-79`). This line currently tells a reader a backstop exists. |
| `docs/features/honest-turn-outcome-surfaces-known-gaps.md` | 135 | gap 4: "`max_turn_requests` has zero Rust construction sites" | **already false before this change** (`router.rs:1076-1077` records its first construction site). Rewrite: no *round* construction site; the refusal producer is live, so the `attention.ts:205` whitelist is load-bearing, not free |
| `docs/features/provider-disposition-durability.md` | 55-56 | "the engine's own `MAX_MODEL_ROUNDS_PER_PROMPT` or `MAX_IDENTICAL_REFUSAL_RUNS` bound" | drop the first |
| `docs/decisions/0049-…:55`, `CONTEXT.md:97`, `docs/decisions/0108`, `docs/research/pi-rpc-replaces-acp.md:88` | — | producer-agnostic ("an agent's own turn limit"; the disposition vocabulary) | **no change** |

`docs/decisions/0108` is the ADR every comment in this area cites; an **amendment** recording "one of the
two producers of `Capped` was deleted; the disposition and the frame were not" is in keeping with the
repo's habit (`0049:55-59` explicitly scolds itself for drifting without one). This meets the ADR bar:
hard to reverse in the sense that a removed guard is re-added by inertia, surprising without context
("why is there no round cap?"), and a real trade-off.

#### Sequencing

The desktop's caret pin is `fulcrum-harness = "0.5.0"` (`src-tauri/Cargo.toml:124`,
`Cargo.lock:1665-1668`), i.e. `>=0.5.0, <0.6.0`.

1. **Engine PR** deletes the const, the guard clause, the `model_rounds` field/increment/init, the
   three ROUND pins, and the orphaned prose; keeps `MAX_IDENTICAL_REFUSAL_RUNS`, `turn_capped`, and
   `TURN_CAPPED_DISPOSITION`; re-points `a_cancel_beats_the_turn_bound` onto the refusal guard.
2. **Publish to crates.io.** Because the constant is **private**, this can be a **0.5.x patch** — the
   desktop's caret then resolves **without touching the manifest**, and `Cargo.lock` + checksum is the
   pin. A `0.6.0` minor would force an edit to `Cargo.toml:124`.
3. **Desktop commit**: `cargo update -p fulcrum-harness` **plus** the comment fixes (`router.rs:1079`,
   `mod.rs:311`) and the doc corrections **in the same commit** — the repo's established rule for pin
   bumps, stated twice (`mod.rs:298-299`, `malformed-tool-call-arguments.md:119-120`).
4. **No path or git pin is available by policy** (`Cargo.toml:117-119` rejects `{ path }`, `:78-93`
   rejects `{ git, rev }`); local dev against the sibling goes through the gitignored
   `[patch.crates-io]` in `.cargo/config.toml` (`:119-123`).
5. **CI is not `--locked`** (`Cargo.toml:96-99`), so a bare re-resolve can adopt a newer patch with no
   desktop commit. That is the only way the desktop silently takes the new engine — and per F1 it would
   compile and pass anyway.
6. `scripts/check-versions.sh` **does not check this pin** (its surface is `package.json`, the package
   version, and `tauri.conf.json`). Nothing in CI will tell you the engine pin moved.

---

### F2. Is the unbounded-loop risk real? Yes for one shape — and it is not the shape the cap catches

#### What still stops a turn after deletion

| Bound | Location | What it catches | What it does not |
|---|---|---|---|
| `MAX_IDENTICAL_REFUSAL_RUNS = 3` | `loop.rs:722` | 3 consecutive **byte-identical** refused batches → ~4 provider calls | any batch that differs in one argument; any *succeeding* call |
| `DEFAULT_MAX_ATTEMPTS = 5` | `retry.rs:64` | transport retries **within one round** | rounds themselves |
| `WALL_CLOCK` 300 s / `MCP_TIMEOUT` 60 s | `codemode.rs:83,90` | a wedged `codemode` script | anything outside `codemode` |
| provider `read_timeout` (5 min idle) | `provider/transport.rs:45,67` | a stalled **stream** | a model that answers fast and wrong forever |
| `subagent_dead_bound_secs` 1800 s | `config_types.rs:435` | **unexplained silence** | *"an Active Subagent (producing frames, or holding an outstanding `tool_call_id`) has no timeout of any kind, so no value here can cut a working child"* (`:425-433`) |
| user Stop | `loop.rs:1525` | anything a human is watching | an unattended run |

**Bottom line, stated plainly: a model that loops making *different, succeeding* tool calls forever is
stopped by nothing after deletion.** There is **no wall-clock bound on a turn anywhere** in
`harness/loop.rs`. And the placement limitation at `loop.rs:1554-1560` survives — `run_tool_batch`'s
`join_all` is awaited with no bound of its own, so a `subagent` batch whose children are looping costs
unbounded time mid-batch, and the dead bound explicitly will not cut a producing child.

#### But the measured distribution says that shape is the product working

Method: one `native_messages` row with `role='assistant'` = one round; a `role='user'` row = a turn
boundary. **The delimiter was validated against ground truth: for all 14 cap events, the assistant-row
count between the last user row and the cap row is exactly 64 — 14 of 14.** The row-space count
reproduces the engine's own counter. Parent re-derived this independently and reproduced it exactly
(n=2,885, max 1,484, p99 260, p95 173, p50 42, >64 = 987 / 34.2 %).

| Population | n | p50 | p75 | p95 | p99 | max | >64 |
|---|---|---|---|---|---|---|---|
| **Subagent prompts (1 prompt = 1 turn)** | 2,493 | **47** | **93** | **180** | 268 | 1,484 | **933 (37.4 %)** |
| All turns, whole DB | 2,885 | 42 | 87 | 173 | 260 | 1,484 | 987 (34.2 %) |
| Main-session turns that ever passed 64 | **57** | — | — | — | — | — | in 45 days |

**64 sits below the p75 of the population it governs, and that population is the subagent fan-out the
product is built around.** Continuity check: of the 1,007 >64-round turns, 175 were continuous and 137
had a ≥5-minute gap inside them; median subagent >64-turn duration 23.1 min at 5.1 rounds/min. These are
research loops (web_search + fetch_content + bash), not machine-gun loops. Post-cap-era censoring: since
the `0.4.1` pin (`29beb578`, 2026-11-18 21:10), **0 non-capped turns reached 64** and all 14 turns
landing on exactly 64 are in capped sessions; today's 69 non-capped turns max out at 50.

#### The 14 cap events: progress, not runaways

| Cap (UTC) | Session | Type | Tool calls | Failed | Rate | Distinct signatures | Last result |
|---|---|---|---|---|---|---|---|
| 07:35 | `arch_9704ed0b` | sub | 95 | 7 | 7.4 % | 7 | completed |
| 07:35 | `arch_674e77db` | sub | 89 | 10 | 11.2 % | 6 | completed |
| 07:37 | `arch_d7e2c9ae` | sub | 120 | 10 | 8.3 % | 3 | completed |
| 08:03 | `arch_77245889` | main | 70 | 3 | 4.3 % | 3 | completed |
| 08:22 | `arch_739df20d` | main | 95 | 7 | 7.4 % | 7 | completed |
| 08:28 | `arch_cb2aab08` | main | 96 | 4 | 4.2 % | 2 | completed |
| 08:49 | `arch_6b5e6306` | sub | 85 | 4 | 4.7 % | 4 | completed |
| 08:54 | `arch_77245889` | main | 69 | 3 | 4.3 % | 3 | completed |
| 09:22 | `arch_eea5f0c2` | sub | 118 | 3 | 2.5 % | 3 | completed |
| 09:24 | `arch_15aaccaf` | sub | 119 | 5 | 4.2 % | 5 | completed |
| 09:28 | `arch_fbcd5b2a` | sub | 89 | 5 | 5.6 % | 5 | completed |
| 09:33 | `arch_cd42c9d7` | main | 73 | 6 | 8.2 % | 6 | completed |
| 09:34 | `arch_29ad876f` | sub | 107 | 3 | 2.8 % | 3 | completed |
| 09:38 | `arch_9d4d92a0` | main | 89 | 3 | 3.4 % | 2 | completed |

- The card's "4–8 % of 100–200 calls" is **directionally right, mis-scaled**: 2.5–11.2 % over 69–120 calls.
- **14/14 stopped immediately after a `completed` tool call.** 2–7 distinct failure signatures each.
- Actual failures: `[brave] error: HTTP 402` ×7, `[duckduckgo] error: HTTP 202` ×4 (a **search-provider
  outage**), `Validation failed: Item 1: missing or invalid 'content'`, `sed: couldn't write … Disk quota
  exceeded`, and **`subagent failed: the subagent's turn was stopped by the agent's own turn limit` in 5
  of 14** — a parent recording a child's cap as its own tool failure.
- **`MAX_IDENTICAL_REFUSAL_RUNS` has never fired here.** All 14 land on exactly 64 assistant rows.
- **Cost: $3.23 across all 13 sessions** (whole-session; median session $0.15). The card's $1.70 was an
  earlier snapshot of the same growing set.
- **Three of these are this report's own researchers.** The count moved 8 → 11 → 13 → 14 while the work
  was in progress; two dispatches died at 64 rounds and had to be re-cut narrower. The guard under study
  was the binding constraint on studying the guard.

#### The runaways that would matter — and what would actually stop them

The 15 burstiest sessions (rows/minute) are **not** the danger: 13 of 15 ended on an assistant message
with no tool calls — a clean delivered answer — **zero were capped**, all ≤ $1.28. Peak 262 rows/min was
a 53-minute research session for **$0.02**. Rate is not the signal.

The expensive tail is:

| Rounds | Session | Cost | Duration |
|---|---|---|---|
| 1,484 | `arch_4c2d2192` (sub) | $11.49 | **18.2 h** |
| 1,373 | `arch_e5495241` (sub) | **$37.61** | — |
| 1,331 | `arch_b45a4747` (sub) | $10.36 | — |
| 1,123 | `arch_b24c6c7a` (sub) | $9.47 | — |

Sessions containing a >64-round turn hold **$213.62 of the DB's $292.33 total spend (73.1 %)** — an
attribution, not a per-turn measurement, since per-turn cost is not persisted. The four 2026-10-30 turns
alone are ≈ **$61.6 in one afternoon**. **The cost lever here is a budget, not a round count.**

#### The card's motivating incident, corrected

`arch_16fc4f3d` (2026-10-29, $0.83, 367 tool rows, 21.7 min) is the 303-call `{}`-argument burst.

- **The card's claim that it "had already stopped on its own" is WRONG.** Its last `native_messages` row
  is `seq=725, role=tool`: `bash: missing 'command' parameter` — it died **mid-loop** when the worker
  dropped. The doc says the same: *"Both sessions end on the refusal row."*
- **But that shape is `MAX_IDENTICAL_REFUSAL_RUNS`' exact target** — 303 refusals of the same call. It
  would have stopped at 4 rounds for ~$0.01. The round ceiling is the backstop that has never once been
  the *right* stop.
- The quote the card leans on exists at `docs/research/malformed-tool-call-arguments-empty-object.md:428-433`
  (soft-wrapped after "Zero", so a single-line `grep -F` of the whole sentence misses it). The card's
  conclusion is right — the window 2026-10-31→11-16 predates the cap (`6bc2bd3`, 2026-11-18 17:21) — but
  its reason conflates two fixes: the doc measures rows **after the #190 fix (2026-11-15)**, not after the
  cap. The doc disclaims it in its own words: *"this proves the burst ended, **not** that the fix ended
  it."* Card and doc agree.

---

### F3. Upstream prior art: the cited band is fiction, and the two closest peers ship no cap

| Project | Real mechanism | Default | When it trips | Shape-specific guard |
|---|---|---|---|---|
| **openai/codex** (closest peer, Rust) | **No round cap.** `RolloutBudgetConfig { limit_budget, limit_tokens, reminder_at_* }` (`codex-rs/core/src/config/mod.rs:1422`) | **none** — `Option`, opt-in feature, requires `limit_tokens`/`limit_budget` | hard `CodexErr::SessionBudgetExceeded` + `stop_new_work()`; **mandatory reminders** | none found |
| **Aider** | **No round cap** — `while message:` bounded only by `max_reflections` | `max_reflections = 3` (`base_coder.py:100`), hardcoded | clean stop + `tool_warning("Only 3 reflections allowed, stopping.")` | none |
| **gemini-cli** | **Two bounds**: `maxSessionTurns` (`config.ts:654`) and hardcoded `MAX_TURNS = 100` (`client.ts:86`, clamps down only) | `maxSessionTurns ?? -1` = **unlimited** | clean `GeminiEventType.MaxSessionTurns` event, no error | **best in class**: `LoopDetectionService` — key `name:JSON(args)`, cycles k=**1..5** ×`TOOL_CALL_LOOP_THRESHOLD=5`, + an LLM judge after 30 turns |
| **Claude Agent SDK** | `maxTurns` (`sdk.d.ts:2067`), `maxBudgetUsd`, `output_config.task_budget` | **opt-in, no documented default** | `subtype: 'error_max_turns'` structured result | none in public types |
| **opencode** (`anomalyco/opencode`; `sst/opencode` 301-redirects) | `steps` — "max agentic iterations before forcing text-only"; `maxSteps` **deprecated** | **no default in the schema** | **strips tools, asks for a text summary**; new user input resets | not verified |
| **cline** | `maxIterations`, `while (maxIterations === undefined \|\| iteration < maxIterations)` | **unbounded, test-pinned "unset = unlimited"** | PR #12398 (unmerged) → clean `failed` | `maxConsecutiveMistakes=3` (errors only) + `loopDetection` soft 3 / hard 5 (identical only) |
| **crush** (`charmbracelet/crush`) | **No round cap** — `grep maxSteps internal/agent/agent.go` → no match | unbounded | n/a | `loop_detection.go`: hash of name+input+**output**, window 10 / 5 repeats |
| **kiro** (AWS) | — | — | — | **UNVERIFIABLE — closed source, no primary source found** |

**Verdict on our four numbers:** opencode 32 → **not found, premise corrected** (no default, soft
degrade, and the AI-SDK default is `stepCountIs(1)`, not 20). cline 1000 → **corrected: no such default;
effective default is unbounded** (the real PR #12398 proposes **100**, and is unmerged). crush 64 →
**corrected: crush has no round cap**; also our repo coordinate is wrong — `charcoal-house/crush` 404s.
kiro 50 → **unverifiable; delete it from the docblock rather than re-citing it.**

**Warn-before-stop is a shipped alternative, in three independent implementations:**

1. **codex** — `reminder_at_remaining_tokens` + `reminder_at_context_start` (default `true`); a config
   **error** is raised if the reminder thresholds are empty while the budget is enabled, i.e. reminders
   are **mandatory**. Delivery is model-visible and re-armed after history insertion.
2. **Claude SDK** — `output_config.task_budget`: *"the model is made aware of its remaining token budget
   so it can pace tool use and wrap up before the limit."*
3. **gemini-cli `_recoverFromLoop`** (`client.ts:1374-1408`) — on the **first** detection it injects
   *"System: Potential loop detected… take a step back and confirm you're making forward progress"* and
   recurses with `boundedTurns - 1`; the **second** detection stops. The warning consumes a round, so
   recovery cannot loop forever.

**The finding that bears on the surviving guard.** Three projects independently documented that
exact-signature repeat detection is defeated by one varied argument: crush's `edit` with varying
`old_string` ([crush#2856](https://github.com/charmbracelet/crush/issues/2856) — *"a paid API quota was
exhausted in a single session"*), cline's `printf _{{request_number}}` which ran **870 provider requests**
before a kill ([cline#11542](https://github.com/cline/cline/issues/11542)), and crush's Notion query
variants. crush's proposed fix is to count **per tool NAME, ignoring input variation**, at a *lower*
threshold (3 errors vs 5 for signature matches). Our `batch_signature`
(`fulcrum:src/harness/loop/turn.rs:181-186`) formats `format!("{}\u{0}{}", tc.name, tc.arguments)` —
**exact argument equality. It has that identical blind spot.** Out of scope for this change by the user's
decision; recorded because it is the guard's fitness for purpose once the backstop is gone.

No credible upstream report was found of a cap killing *legitimate* long work (E1 came back empty) —
our own database is, on this evidence, the strongest false-positive record in existence.

---

## Unresolved Contradictions

1. **crush#2856 / cline#11542 vs our DB.** Upstream projects report real unbounded runaways burning paid
   quota; our DB shows the cap firing 14 times on zero runaways. Both hold — the cap fires on the wrong
   shape, not on nothing. "Delete it" and "the risk is real" are not in conflict; they are answers to
   different questions.
2. **The 09:28 event** contains 3 identical `ask: no usable questions were provided` refusals — the only
   refusal-guard candidate in the set — but its turn still shows 64 assistant rows. Both counters can be
   satisfied simultaneously and the DB records only the resulting `cap:N` key. **Which counter tripped is
   unresolvable from persisted data**: the `eprintln!` at `loop.rs:1564` goes to **stderr** and
   `diagnostics.log` has **zero** occurrences. The direct per-event proof exists nowhere.
3. **Whether the Claude Code *CLI* applies an internal default `maxTurns`** the SDK does not expose:
   unverifiable, closed source.

## Gaps

1. **No wall-clock bound exists on a turn, anywhere.** The 1,484-round turn ran **18.2 hours**.
   `subagent_dead_bound_secs` explicitly cannot cut a producing child. If deletion worries anyone, this
   is the honest hole — not rounds.
2. **Per-turn cost is not separable** from `sessions.cost_usd`; the $213.62 figure is an attribution.
3. **opencode's own loop shape** (its own `while` vs the AI SDK's `maxSteps`) rests on one secondary
   forum post — unverified.
4. **Aider's `num_malformed_responses`** (`base_coder.py:98`, incremented `:2306`) — counter seen, bound
   and consumer not confirmed; deliberately not cited as a number.
5. **The 34 post-cap-era turns above 64** may be a stale-worker artifact (all sit in sessions created
   11-18/11-19; the 281-round turn starts before the 11-19 19:55 build). Process-vs-commit identity was
   not verified.
6. **codex's turn-loop body under `codex-rs/core/src/agent/`** was not exhaustively scanned; "no round
   cap" there rests on negative greps of `codex.rs` + `config/mod.rs`. High confidence, not proven.
7. **`write_artifact`/board**: none — this report is attached to the card (see front-matter `task:`).

## Evidence

**Primary, local (re-measured 2026-11-20 at HEAD `b2d6ea95` / fulcrum `3d7dfb6`):**
`fulcrum:src/harness/loop.rs:475-503,505-722,1506-1615,1896`; `loop/turn.rs:112,125,174-204,352,471,578`;
`loop/tests/{turn_lifecycle,param_rejection,policy_gate,tool_row_settle,support}.rs`;
`src/events.rs:73-92,266`; `src/normalize.rs:158-170,223,715-732,1674-1740,2557`;
`src/source_lints.rs:594,623`; `src/harness/retry.rs:64`; `src/harness/loop/codemode.rs:83-96`;
`src/harness/provider/transport.rs:45,67`; `src/config_types.rs:255-258,425-436`;
`src/worker/manager/mod.rs:152-234`; `.github/workflows/ci.yml:66-75`;
`archimedes:src-tauri/Cargo.toml:32-124`, `Cargo.lock:1665-1668`;
`src-tauri/src/agent/session/{router.rs:130-185,491-600,1070-1130,1240-1370,mod.rs:110-145,283-345,2025-2100,tests/mod.rs:3495-3560}`;
`src-tauri/src/agent/mod.rs:102`; `src/lib/transcript/reducer.ts:145-215`; `src/lib/tauri/types.ts:374-380`;
`src/lib/attention.ts:70-100,185-215,470-490`; `src/components/chat/TranscriptFooter.tsx:17,107-110`;
`scripts/check-versions.sh`; `docs/features/{malformed-tool-call-arguments,honest-turn-outcome-surfaces-known-gaps,provider-disposition-durability,abandoned-tool-rows}.md`;
`docs/decisions/{0049,0092,0108}-*`; `CONTEXT.md:97`.

**Primary, database:** `/home/daniel/.local/share/archimedes/archimedes.db` (2.83 GB, 445k `messages`,
402k `native_messages`, 2,643 sessions), opened read-only. Cap events keyed on
`messages.message_key like '%:cap:%'` (minted only by `normalize.rs`'s `cap_id()`). Round histogram over
`native_messages` split on `role='user'`, validated 14/14 against the engine's own counter.

**Primary, upstream:** `charmbracelet/crush` `internal/agent/agent.go` + `go.mod`;
`cline/cline` `apps/cli/src/runtime/defaults.ts`; [cline#11542](https://github.com/cline/cline/issues/11542);
[cline PR#12398](https://github.com/cline/cline/pull/12398);
[crush#2856](https://github.com/charmbracelet/crush/issues/2856);
[opencode config schema](https://opencode.ai/config.json);
[opencode agents docs](https://opencode.ai/docs/agents);
[ai-sdk loop-control](https://ai-sdk.dev/v5/docs/agents/loop-control);
`openai/codex` `codex-rs/core/src/{config/mod.rs,rollout_budget.rs,model_request.rs,protocol.rs}`;
Claude Agent SDK `sdk.d.ts:2067,2074-2077,6256-6263` + `types.py:1790,2509`;
`google-gemini/gemini-cli` `{config.ts:654,1258; core/src/core/client.ts:86,665-672,958,1004,1374-1408;
core/src/core/loopDetectionService.ts:29-30,77-79,175-176,229,317-340}`;
`aider/coders/base_coder.py:98-101,871,932,939-941,1449-1472,1563-1606`.
Branch-relative permalinks — line numbers may drift; no commit SHAs were pinned.

**Secondary:** one forum post on opencode's loop shape (flagged, not relied on).
**Unverifiable:** kiro's 50; the Claude Code CLI's internal `maxTurns` default.
