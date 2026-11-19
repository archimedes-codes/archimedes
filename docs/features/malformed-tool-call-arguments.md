---
status: live
last-verified: 2026-11-18
verified-by: >-
  Folded from `docs/roadmap/malformed-tool-call-arguments-honest-failure.md` and its `-follow-ups.md`
  (both gitignored, neither ever committed — this file is their only durable copy) at the close of the
  run that shipped desktop PR #207 (`29beb578`, pin `fulcrum-harness 0.4.1`, `Cargo.lock` checksum
  `ba8eb8788f2ef0362006f9c4203bd5ea1d1b908e19a880bad554dd13797e3103`) and engine PRs #28/#30
  (`6bc2bd3`, `d994b71`, tag `v0.4.1`, published to crates.io).
  Every claim below was re-measured on the shipped trees, not copied from the plan: engine
  `cargo test` **1751 passed / 0 failed / 3 ignored** with `cargo clippy --all-targets -D warnings`
  at 0 warnings and the Windows cross-check clean; desktop `cargo test` **1042 / 0 / 3 ignored**
  across 40 targets, `pnpm test` **189 files / 4603 passed / 1 skipped**, `pnpm build` clean.
  Three review rounds plus a pre-publish review produced the findings; the reviewer's own numbers
  were twice found wrong and the implementers right, so nothing here rests on a review claim that
  was not re-derived.
---

# A malformed tool call tells the truth, and a stuck turn stops

**What this records.** Why a bad `arguments` payload was able to burn 303 provider calls blaming the
model for a parameter it never sent, what now closes each link, and the residuals that were accepted
rather than fixed. Card `tsk_4b5f1526`; desktop issue #193.

## 1. The chain, and which fix owns which link

`parse_arguments` collapsed **both** an empty payload — legitimate, a tool taking no arguments — and an
unparseable one into `{}`. Downstream that is indistinguishable from a call the model legitimately made
with no arguments, except for one `eprintln!` no user can read. So the param checker passed (`{}` has no
*extraneous* key), the policy gate returned `Allow` because there was no `path` to judge and therefore
**raised no prompt**, and the executor refused with ``read: missing `path` parameter`` — a sentence that
says *you omitted a required parameter*. The model re-sent the identical call. One subagent did that 303
times in 19 minutes and nothing bounded it.

| Link | Fix |
|---|---|
| The parser erased the defect | `ToolCall.defect: Option<ArgumentDefect>` (`{kind, message, raw}`) preserves the parse error and the raw text; one head arm in `unknown_param_error` names what actually happened |
| The turn loop was unbounded | `MAX_MODEL_ROUNDS_PER_PROMPT` + `MAX_IDENTICAL_REFUSAL_RUNS`; a capped turn settles as `turn_capped` → `StopReason::MaxTurnRequests` |
| A `function_call` vanished on the Responses wire | every terminal event now flushes its tool calls, and a `completed` without `status: "completed"` stops claiming success |
| Which OpenAI-shaped wire was live was undecidable afterwards | the chosen `WireApi` is logged at construction to `eprintln!` **and** the always-on `diagnostics` channel |

**Arguments are deliberately NOT repaired.** Upstream evidence is one-sided: llama_index #24102 repaired a
truncated `write_file` and wrote 866 of 2,120 bytes *reporting success*; claude-code #97311 repaired a
refusal-cut `tool_use` that then passed schema; cline's `jsonrepair` closes `{"commands":["cd build",`
into a plausible non-empty call. Five harnesses (pi, cline, LangChain, opencode, vercel) keep
`arguments: {}` and carry the discriminator in a separate optional field. None repairs `{}` itself, and
neither does this.

## 2. The loop bound counts a ROUND, not an HTTP request

This is the sentence most likely to be misread later. Worst case is
`MAX_MODEL_ROUNDS_PER_PROMPT × RetryPolicy.max_attempts` **plus** uncounted `compact_if_due` summary
calls, because `RetryPolicy::call_with_retry` can issue several provider calls inside one round. The
upstream band (opencode 32, kiro 50, crush 64, cline 1000) justifies the **magnitude only** — it was read
from other projects' code and **never measured against our traffic**, and the run bound of 3 is a starting
value for the same reason. The bound is **per-prompt**: a re-prompt restarts both counters, so the user
must intervene. Neither constant is configurable — not on `ModelOptions`. A bound can only fire at the top
of the **next** iteration; `run_tool_batch`'s `join_all` has no bound of its own, so there is no mid-batch
preemption.

## 3. The refusal guard is deliberately biased to MISS

A false positive here ends a user's prompt, which is worse than a loop that runs to the 64-round ceiling.
Three review rounds were spent removing false positives, and every exclusion is pinned individually:

- A **permission denial** and a **declined `sudo_exec` confirm** are user decisions, not re-send
  instructions. Both thread a structural `denied` flag.
- A sudo command that **RAN and FAILED** is not an argument rejection — `sudo_run_flow` returns
  `(ToolResult, bool, bool)`, the third half being "did the flow reach the run". This was the last one
  found, by the Greptile reviewer on the release PR: the flow defaults an omitted `reason` to `""` while
  the spec advertises it `required`, so a wrong sudo password — whose error explicitly invites a retry —
  was counted as a refusal and four identical calls ended the prompt mid-authentication.
- A required key satisfied through an **advertised alias** (`get_search_content`'s `responseId`) is not
  missing. Recognition depends on the advertised description literally beginning `Alias for ` — there is
  no structural link between a property and its alias, only wording. Rewording one is an over-count,
  caught by `a_call_using_an_advertised_alias_is_never_a_refusal_run`, **not** by the census test.
- `ls {}` advertises `path` as required, defaults it to the cwd, and **succeeds** — excluded by the
  `is_error` half. The `ls` spec/executor contradiction is still unfixed and is its own card.
- Wrong-type required values (`bash {"command": 42}`) and empty alias values fall to the round ceiling.

`src/source_lints.rs::every_denial_marking_site_in_the_batch_is_accounted` pins the count of
denial-marking and run-marking sites, because a `bool` is not un-forgettable and a non-exhaustive enum
would not have closed the gap either. It earned its place by catching a **compiling** hoist that silently
dropped the flag during development.

## 4. `defect` reaches disk and daemon socket clients — never a provider request

The provider half is pinned: all three wire builders are hand-built whitelists, each asserted by an
exact-key-set test whose fixture carries a **defect-PRESENT** call, so they prove absence rather than
"never set". But `persist_transcript_message` serialises the whole `ChatMessage` into `content_json`,
`IpcStore::insert_message` forwards it verbatim, and the daemon's `store_frame` re-broadcasts it to every
socket client. That is legitimate — a resume needs it — but docblocks originally claimed "disk-only" and
were corrected.

`defect.raw` is capped at `MAX_DEFECT_RAW_BYTES = 2048` **at the parse site**, with the truncation note
counted *inside* the cap so the bounds compose. An earlier cut produced `cap + note` (2081 bytes) which
`quoted_defect_raw` then re-cut, slicing the field's own note in half and appending a fresh one naming the
*capped* length — an 8 MB payload reported as "2081 bytes total". Verified with an 8 MB payload that the
note names the true length at every layer.

Historical rows still load: serde's `MissingFieldDeserializer` answers `deserialize_option` with
`visit_none()`, so a missing `Option` needs no `#[serde(default)]`. Pinned by
`a_pre_change_row_with_no_defect_key_still_deserializes`, which uses a hand-written `concat!` literal
because a `json!` fixture would silently track the struct.

## 5. Two vocabularies, and where the capped turn is read

`turn_capped` is emitted by the engine and read **only** by the desktop. `resolve_turn` decides via an
exhaustive `match` on `(bool, Option<TurnDisposition>)` — it was an `if/else if/else` chain, the one site
that maps a disposition to a `StopReason`, and the chain silently dropped a new disposition as `end_turn`.
Cancellation still wins. **Both** clears are required (`resolve_turn_forced` and the `send_prompt`
turn-start clear) or #190's stranded-stale-disposition bug returns for the new variant.

⚠ **The exhaustive match does not make a wire change safe on its own.** It catches a new
`TurnDisposition` variant. It does **not** catch a new incoming frame: `route_event`'s stash arm ends in
`_ => None`, so a fifth `RpcEvent` that forgets that arm stashes nothing, `resolve_turn` sees `None`,
resolves `end_turn`, and the `E0004` never fires — the compiler sits downstream of the omission. ADR 0108
records the general form; the pin-bump-plus-arm-in-one-commit rule is what closes it in practice.

`attention.ts` gates on `stopReasons[id] === "end_turn"` — a **whitelist**, so every current and future
non-success variant fails closed with no new store field. The flip had **no red witness** (all 17
`stopReasons` seeds route through the `fallen()` fixture, which already seeds `end_turn`), so its two new
pins were written first and confirmed red under the old predicate. Measured: reverting the whitelist
reddens exactly 2 tests and leaves 68 green.

The cap notice persists as an `agent-text` row on its **own** key `{stamp}:cap:N` (engine `cap_id()`), not
`{stamp}:truncate:N` — the shared `{stamp}:system` key APPENDS, so each notice mints a unique id. See
`docs/features/provider-disposition-durability.md`.

## 6. Accepted residuals, documented rather than fixed

- **`reduced_base_url` refuses by default.** `//sk-proj-abc123.example/v1` keeps the host (pinned by
  `the_anchored_domain_residual_is_the_documented_one`). No character rule separates a dotted domain from a
  JWT, so the extractor accepts a dotted domain only behind `//`. All four real credential shapes stay
  refused even anchored. Control characters other than `\n`/`\r` survive into the line but cannot forge
  one; the `Url` success arm percent-encodes everything.
- **Behaviour change from that fix:** `gw.example:443/v1`, bare `localhost`, `10.0.0.5` and
  `unknown://host/path` now render `<unparseable>`. Nothing in either repo asserted on the old output and
  no *working* deployment loses legibility (`10.0.0.5:8080/v1` still renders in full).
- **`Done(Error)` on a statusless `completed` buys a retry ladder.** It routes to `retry_abandoned_attempt`
  — up to the shared budget, retracting the partial reply — which is close to what ADR 0108 *rejects* for a
  cut-off response. Safe here because nothing dispatches on this path, so no side effect can duplicate; the
  cost is that a backend consistently omitting `status` burns the ladder every turn. `Fatal` was rejected
  because a transient proxy hiccup would then hard-fail instead of retrying.
- **Two nameless drops are still unlogged:** `flush_tool_calls`'s drop, and the `output_item.done` drop on
  the `terminated` gate (the *discard* logs; the accumulator drop does not). Logging nameless drops is
  `docs/roadmap/honest-turn-outcome-surfaces.md` Task 3's job.

## 7. UNVERIFIED — claimed nowhere, listed here

- **No captured payload anywhere shows a backend sending `response.completed` without
  `status: "completed"`.** That arm, and the post-terminal accumulation gates, are defensive. Per the
  Responses spec `completed` is final and every `output_item.done` precedes it, so **no spec-conformant
  stream is affected**.
- Whether the "2–3 consecutive" upstream band transfers to our traffic.
- The top-level JSON-**string** passthrough (`parse_arguments("\"abc\"")` → `Value::String` →
  `as_object()?` → `None`) is untested and silently uncheckable by `unknown_param_error`. If a real payload
  shows it, it needs its own defect arm.
- Whether any historical `native_messages` row holds a non-object `arguments`.
- Whether `ARCHIMEDES_DEBUG` is present in a packaged AppImage's environment when launched from a desktop
  shell — the README says an icon launch may not inherit a terminal export, so the wire log may be
  unreadable to exactly the users who need it.

## 8. Open follow-ups

1. **An unidentified rare flake in the engine suite.** Observed once in ~110 full-lib runs at engine
   `fb812cb`, no log captured; 60 idle + 25 under-load + 40 targeted re-runs came back clean. The profile
   matches `harness::provider::transport::tests::a_slow_stream_completes_but_a_silent_stream_errors`, which
   this repo's own flake registry already documents (50 ms dribble against a 200 ms `read_timeout`, a 150 ms
   margin, "needs an owner — not a drive-by fix"). **Re-run before investigating.** The instrument that
   works is a loop that deletes the log of every green run so a failure's log survives to be read:

   ```bash
   BIN=$(ls -t target/debug/deps/fulcrum_harness-* | grep -v '\.d$' | head -1)
   for i in $(seq 1 200); do
     $BIN --test-threads=4 > /tmp/flk/run-$i.log 2>&1 || { echo $i >> /tmp/flk/failures.txt; break; }
     rm -f /tmp/flk/run-$i.log
   done
   ```
2. **`docs/features/abandoned-tool-rows.md` citation rot.** Five passes each re-derived its line numbers
   and each left their successors stale; the fifth deleted 72 of them in favour of `fn`/arm names. **§5 and
   §9 remain not re-read** (the doc says so and names two already-false cites); **§6's numbers are correct
   by luck, not by reading.** Related and outside that doc: `src/harness/loop/tests/context_usage.rs`'s
   docblock still cites `turn.rs:93`, `turn.rs:714` and `loop.rs:1473` (twice — once inside a test assertion
   message), all now pointing at comments. One sweep across every `file:line` citation in the crate, not a
   per-visit fix. **The durable rule: a line-number citation into a hot file is worth exactly one commit —
   name the function.**
3. **ADR 0108:164 is now stale**: it says `route_event` "touches `RpcEvent` only through `matches!`", and
   the new stash arm is a `match`. It sits in that file's committed region while the file is dirty with
   another card's uncommitted amendment, so it was deliberately not touched here.
4. **Sequencing, if `honest-turn-outcome-surfaces` is still live:** its Decision 4 owns the same
   `attention.ts` predicate this work flipped. Verified not-yet-landed at the time, so the flip happened
   here; if that plan lands second, its Task 2 is a no-op.
5. **Carried from the research, unchanged:** `ls`'s spec contradicts its executor; the `space_cwd` vs
   process-CWD divergence inside `policy_verdict` (read, never exercised); the `end_turn`-on-IPC-failure
   dishonesty in `useChatPromptDispatch` / `usePromptQueueFlusher` / `taskLaunch` (a whitelist cannot see
   it, because the value *is* `end_turn`); `call_resp_<uuid>_<n>` — 489 rows, no producer in current
   source, evidence of a former id-mangling path and not of the Responses wire; model attribution for the
   burst sessions is impossible (`capabilities_json` is `null` for every subagent row, no parent-session
   column).

## 9. Two process lessons this run produced

- **`cargo check --all-targets` under-reports `E0063`, and reading one run's output as complete is a trap.**
  It named 9 sites; the true count was 15. Cargo aborts after the first failing targets and never compiles
  the other two files. Enumerate by editing, not by reading one check's output.
- **A plan's stated count is a hint, and the compiler is the authority — but so is the gate list.** The
  first desktop commit passed every gate named in its own message and still reddened CI on
  `scripts/check-file-size.sh`, the one gate the message did not mention. List the repo's actual gates, not
  the ones the plan happened to name.
