---
status: accepted
date: 2026-11-15
superseded-by:
---

# A `Length` stop is a terminal outcome, never retried, and its tool calls are never executed

The **Agent** streamed "OK, plans good — I'm going to write it now", the turn settled as a success,
and nothing ran. Issue #190. The mechanism was one unread field: all three wires map the
**Provider**'s output-cap stop to `FinishReason::Length`, and the turn loop read `acc.finish` at
exactly two sites, neither of which was `Length` — so a cut-off turn failed issue #64's emptiness
gate (whose first conjunct is `finish == Some(Stop)`) and fell through to the success triple
(`agent_end` / `turn_end` / `agent_settled`). The harness was not mis-detecting the truncation, it
was detecting it and then labelling the result a completed turn.

The fix could have been a retry. It is not. **A turn whose reply the Provider cut off at its output
cap is a terminal outcome**: it is not re-issued, its tool calls are not dispatched, and the
disposition reaches the **Client** as its own frame, so the turn settles as `StopReason::MaxTokens`
and renders as truncated instead of as "finished". Three parts of that are hard to reverse and
surprising without context, so each is recorded here with the alternative it rejects.

## It is not retried, against Anthropic's own documented remedy

Anthropic's `handling-stop-reasons` page gives a remedy for exactly this case — *"retry the request
with a higher `max_tokens` value to get the full tool use"* — and it is the obvious move: the call
was cut off, ask again with more room, get the whole call. **Rejected.** Re-issuing the assistant
turn re-runs a turn that may already have announced a tool call, and above all it can **duplicate a
non-idempotent side effect**: the first attempt's `git push`, `write`, or `bash` may have landed
before the cap bit, and the retry does not know that. The sentence most often quoted for this position
— *"Automatic continuation is a separate policy question because blindly replaying a partially completed
response can duplicate tool side effects"* — comes from openai/codex issue #38831, and that project did
choose terminal-and-non-retryable for a related reason (`ResponseIncomplete` is `RetryPolicy::Never`).
**Two corrections to how this paragraph originally cited that evidence are recorded in the 2026-11-15
amendment below, and they do not change this decision** — read them before quoting the sentence anywhere
else, because it is not a maintainer's words and the harness it describes is not ours.

The counter-argument deserves its honest statement, because it is not weak. The double-fire worry
assumes the first attempt's call executed; on our route it does not (see the next section), so a
retry above temperature 0 might well sample a shorter, complete call and simply succeed — and the
user gets their file instead of a red line. That is a real gain, and it is bought against a tail
where the tool that already ran is not ours but the model's, or where a gateway truncates again and
again (opencode #18108: *"truncation produces varying incomplete JSON each attempt so doom loop is
never detected"*; opencode #17471: *"Increasing maxOutputTokens only postpones the same failure"*).
We take the conservative branch: **the user re-prompts, and a re-prompt is a decision they make
knowing the turn was cut off; a duplicated write is not.**

## Its tool calls are never executed, because the card they produce blames the wrong party

Truncated argument JSON does not arrive as an error. It arrives as `{}`, through a chain of
individually-defensible links (`docs/research/silent-turn-settle-after-announcing-a-write.md` §4,
all measured on this machine's DB):

1. `parse_arguments` (`provider/openai.rs`, the ONE argument parser all three wires share) returns an
   empty object for an empty fragment, and an empty object with one `eprintln!` for an unparseable
   one — so a cut-off call is indistinguishable downstream from a call the model legitimately sent
   with no arguments;
2. `unknown_param_error` (`tool_specs.rs`) **passes** it — that checker inspects only *extraneous*
   top-level keys, `{}` has none, and its own docblock says `required` is deliberately irrelevant;
3. the **Permission prompt** never fires: `policy_verdict` for a write-direction tool reads
   `arguments.get("path")` and, finding nothing, answers `Allow` — there is no **Boundary** to judge
   against an absent path;
4. the executor refuses: ``write: missing `path` or `content` parameter``, `is_error: true`.

So the user gets a red tool-call card whose stated reason is a missing parameter the output cap
never let the model send. **566 such calls are measured in this machine's DB** (`edit` 244, `bash`
292, `write` 19, `mcp` 11 — the other 358 `{}` calls belong to tools that take no arguments and are
legitimate). Every one of them settled with a result, which means all 566 executed and were rejected.
A wrong reason is not a cosmetic defect: it teaches the model that its arguments were malformed and
the user that the agent is unreliable, and it sends the next turn hunting for a bug that is not there.

The industry answer on this half is settled, and it is worth having it on the record rather than
re-derived: `vercel/ai` gates execution with `isToolExecutionAllowedFinishReason(f) => f === 'stop'
|| f === 'tool-calls'`; pi fails every tool call in a `length`-stopped message with error results and
executes none (PR #6285, `failToolCallsFromTruncatedMessage`); opencode's `pendingCalls()` returns
`[]` on `length`; openai/codex traces `partial_output` items, truncates them, and never dispatches
them. And Anthropic's own SDK **Tool Runner** states the rule for the wire in question — `max_tokens`
maps to a terminal step, *"the turn is the final message and its tool_use blocks must not be
executed"*, behind a `checkNever()` exhaustiveness guard. Our calls now close through
`close_announced_tool_calls` instead, so no display row is left spinning at `in_progress`.

## The disposition rides a new `RpcEvent::turn_truncated`, not the dead `turn_end.message`

`turn_end` already carries a `message` field, so the obvious zero-cost transport was to put the
disposition in it. It is not zero-cost, because the field is dead: `message` is `Value::Null` at all
**three** settle sites (`settle_cancelled`, `settle_error`, and the success path in `loop.rs`), and
nothing on the receiving side reads it. An untyped `Value` that no code reads is invisible in review —
a reviewer cannot see a payload that has no consumer, and the next person to touch `turn_end` has no
signal that the field carries meaning. So the disposition is a **named unit variant**, emitted
**before** `turn_end`, so a peer can stash it before the settle resolves the turn.

`PROTOCOL_VERSION` stays **1** deliberately. `turn_truncated` is additive: a peer that predates it
fails that ONE line to deserialize, logs `worker client: bad outbound line`, and continues — the turn
still settles on the frames it does know, because the read task's decode arm is `eprintln!` +
`continue` and never aborts the pipe. And the **Worker** is a self-exec of the *same* binary, so
Supervisor and Worker are always one build anyway (ADR 0102 records the same reasoning for the frame
pair IT deleted). Bumping the version for an additive variant would make every peer declare
incompatibility with a frame whose only effect on it is to be skipped.

## Considered options

- **Retry with a higher `max_tokens`** (Anthropic's documented remedy) — rejected above on the
  duplicate-side-effect ground, with the counter-argument stated in full.
- **Auto-continue with a bounded fuse** — what opencode does (inject a synthetic user message, cap it
  at 3 consecutive `length` turns) and what cline does (cap 3). Genuinely better UX for the pure-text
  truncation, which is the common case at this deployment's `xhigh` thinking level, where the thinking
  budget and the visible reply share one `max_tokens`. Rejected for the same reason as the retry, plus
  one more: a fuse is only safe once we can tell "the reply was cut off mid-sentence" from "the reply
  was cut off mid-tool-call", and we cannot, from the row level. The Falsifier below is what would
  reopen this.
- **Execute the call and let the executor reject it** — the shipped behaviour before this decision,
  and the reason the user saw ``missing `path` or `content` parameter``.
- **Repair the truncated JSON and run it** — rejected outright. pi's maintainer note is the finding:
  a best-effort salvage parser yields calls whose arguments *"parse and validate but are silently
  incomplete"*, and cline #14909 documents `jsonrepair` closing `{"commands":["cd build",` into a
  plausible complete command — *"A validator can't help here: the repaired call is well-formed and
  non-empty."* A repaired call is a call we invented.
- **Ride `turn_end.message`** — rejected above: a dead `Value` is not a contract.

## Consequences

- **The desktop's `matches!(e, RpcEvent::turn_truncated)` arm and the crates.io pin bump must land in
  ONE commit.** `fulcrum-harness` is a crates.io dependency, not a workspace member, so against the
  pinned `0.2.0` that arm is a **compile error**, not a warning. The pin bump (`0.2.0` → `0.3.0`) and
  the arm are one change, exactly the precedent `2814d561` (PR #180) set when `impl TaskStore for Db`
  and the pin that carries the `ToolCtx` field had to move together. A two-commit version of this
  leaves `main` unbuildable at one of the two commits.
- **A truncated Subagent settles `Failed` to its parent, not `Completed { output: "" }`.** Before
  this decision a truncated child's empty output was exempt; once dispatch is suppressed the
  exemption is a lie — the child did not finish, and "completed with no output" is the exact
  indistinguishability issue #190 exists to remove.
- **The turn's text IS persisted; with no text nothing is.** The announced "I'm going to write it
  now" is real content and the user keeps it. The 33-byte empty assistant row that issue #64 was
  written about disappears on this route too, because a `Length` stop no longer reaches the shape that
  produced it.
- **Nothing here raises the cap or sizes it against the thinking budget.** That is the actual cause at
  this deployment's configured level (the Anthropic clamp leaves ~1,024 tokens for the visible reply
  *and* the whole `tool_use` block at `xhigh`) and it is deliberately not this decision: the research
  report's own counter-evidence says sizing is necessary but not sufficient. Making a truncation
  rarer is orthogonal to making it honest when it happens.
- **Falsifier.** This decision is a bet that stranding is cheaper than double-firing, and it was made
  without field data. If the data later says otherwise, continuation with a bounded fuse (opencode's
  3, cline's 3) becomes real work again rather than a deferred idea. The measurement: `normalize` now
  mints one `{stamp}:truncate:N` notice row per truncated turn, so the strand side is countable from
  the transcripts already on disk — **the rate at which a `truncate:` notice is the last assistant
  row of its Session with no further user prompt**, against the pre-decision baseline of the same
  shape. The double-fire side has NO artifact (a duplicated write leaves a card that succeeded), so it
  needs a hand audit of truncated turns whose following turn repeats a side effect. If the first
  number is materially above the second, terminal-and-never-retry is costing users more than it is
  protecting them, and the fuse is owed. Until someone publishes both halves of that comparison, this
  stands.

## Amendment (2026-11-15) — the three seams this plan held that the decision text did not, and one claim that was wrong

Folded out of the deleted plan (`docs/roadmap/silent-turn-settle.md`, gitignored, the only copy) at ship.
Four facts lived only there. All four are re-runnable as written.

**`Cancelled` > `MaxTokens` > `EndTurn` in `resolve_turn`.** A user who pressed Stop on a turn whose
reply was *also* cut off cancelled it — the more specific fact about what happened. The precedence is the
`if cancelled / else if was_truncated` order in `router.rs::resolve_turn` and is pinned by
`cancel_requested_wins_over_truncated` (its assertion reads "Stop beats a truncation"); the code comments that cited this as "Decision 6" cited the plan, which is now gone, so this paragraph
is its home. Both guards are dropped BEFORE the `pending_turn` lock — never hold two of these at once.

**A new `RpcEvent` variant does not redden the desktop by itself — only *naming* it does.** `route_event`
matches `WorkerInboundEvent` exhaustively with no `_` arm, but it touches `RpcEvent` only through
`matches!`. So the additive-variant pattern is safe to *emit* from a newer crate and invisible to the
desktop until an arm names it — which is also why the pin bump and that arm must be one commit (the
Consequences bullet above): the reverse order is a compile error, not a warning. This was a correction,
not a restatement — a grounding report had claimed the exhaustive match would break on any new variant.

**The desktop needed NO TypeScript change, and the research report said otherwise.**
`transcriptFooterIsEmpty`'s predicate is `(props.inTurn || !props.stopReason || props.stopReason === "end_turn")`,
so it suppresses `end_turn` and **nothing else** — `max_tokens` already rendered. The whole chain
`send_prompt` → `turnCompleted` → `stopReasons` → `ChatStream` → `MessageList` → `TranscriptFooter` was
built and tested before this work existed (`TranscriptFooter.test.tsx`, `MessageList.test.tsx` and
`MessageList.emptyFilm.test.tsx` all assert `"Turn ended: max_tokens"`). The research report's §1c and its
fix list both said the footer "must learn not to suppress this one"; that is false, and its two
occurrences are corrected in place. The desktop's entire half was one Rust construction site. **A
grounding report's claim is a hypothesis — re-measure the predicate before acting on it.**

**The notice rides a UNIQUE `{stamp}:truncate:N` id, and `truncate` is now the third bookkeeping word.**
`compute_display_rows` appends same-`messageId` `agent_message_chunk`s with no separator, so a second line
on the shared `{stamp}:system` key **welds** into one bubble (ADR 0048's mechanism). The notice therefore
mints through a new `TurnState::truncate_seq` counter mirroring `retract_seq`, and its id must be
recognised by `is_bookkeeping_message_id` or the harness's own sentence is handed to a PARENT model as its
child's answer. Accepted consequence, stated because it is a trade-off and not an oversight: a parent does
not read the line in a child's captured text — it sees the child's own card. Copy is **"Response was
truncated before completion"** — deliberately neutral (pi #7540's lesson), because a normalised `length`
can also mean context overflow or a provider-mislabeled cut, so the line must not claim it was the
configured limit. ADR 0049's word-set enumeration is amended alongside.

**Two more that lived only in the plan.** (a) The **per-call** refinement of the never-executes rule —
run the calls that arrived *complete* in a `length`-stopped turn, on cline's argument that *"a closed JSON
object cannot be the prefix of a longer one, so a call that arrived complete is what the model meant"* —
is **rejected**, not overlooked. It is the one genuinely strong counter-argument to the blanket gate above,
and it loses on cost, not on merit: `close_announced_tool_calls` already gives the model a precise per-call
error either way, so the refinement buys no additional signal for the extra state. If a future measurement
shows complete calls being stranded in a `length` turn often enough to matter, reopen it here. (b) The
protocol-version pin `the_task_frames_are_additive_so_the_protocol_version_stays_one` **must not be
"corrected"** when a new `RpcEvent` variant lands. It is the assertion that `PROTOCOL_VERSION` stays 1
across additive frames, and the crate has already shipped new variants without bumping
(`task-request` / `task-response`) — so a run that adds a variant and finds that test green has found the
expected state, not a test that failed to notice its new frame.

## Amendment (2026-11-15) — the codex evidence does not support this decision's stated reason, and the Falsifier is live

Folded out of `docs/research/max-tokens-is-never-sized-and-the-live-cut-is-reasoning-not-the-tool-call.md`
(task `tsk_206ed63f-04d5-47ff-8bb4-c9b9363d8899`). **This amendment corrects the evidence, not the
decision.** Terminal-and-never-retry still stands, and the reasons it stands are now the cost argument and
the doom-loop argument rather than the duplicate-side-effect argument. Three facts, each re-runnable.

**1. The quoted sentence is not a maintainer's, and it is not codex's policy reasoning.** openai/codex
#38831 is authored by `starriet9` with `author_association: NONE` — a reporter, not the project. The
sentence is a line in that reporter's issue body. It appears **nowhere in codex's source**: a `git grep
"blindly replaying"` over a full clone at `b1573f1` returns nothing, and the only `blindly` in any `.rs`
file is in a different sentence in a different crate. (That grep is the research angle's, at that SHA, and
the clone is gone — re-run it against a fresh clone, not against this machine. `gh` code search needs
authentication and was unavailable here, so this half is single-source. The **authorship** half is
independently re-runnable unauthenticated:
`gh api repos/openai/codex/issues/38831 --jq '{author:.user.login,assoc:.author_association}'` →
`starriet9` / `NONE`.) The
*classification* is real and shipped — `ResponseIncomplete` is in the `RetryPolicy::Never` arm of codex's
error enum — so the decision's external corroboration survives; only its most-quoted sentence was
misattributed. An earlier draft of this ADR credited *"the maintainer who faced the same question"*.

**2. Codex's reason is valid for codex and void on our route, because the two harnesses are opposite
shapes.** Codex **stream-and-executes**: each `output_item.done` yields a tool future that is
`tokio::spawn`ed immediately unless `defer_tool_dispatch` is set, and that flag is set only for a
synchronous post-hook mode. So in codex's default path a call that completed mid-stream has already run by
the time `response.incomplete` arrives, and replaying the response really can fire twice.

**Ours is collect-then-execute**, and this is now verified rather than asserted: `run_tool_batch` has
exactly one call site in the loop, it sits **below** the `Length` gate, and `consume_stream`'s `ToolCall`
arm does three things only — push to `acc.tool_calls`, emit a display `toolcall_end`, emit
`tool_execution_start`. No executor, permission gate, subagent spawn or MCP call is reachable from it, and
there is no eager/deferred mode. The `finish_reason` is always the last event on all three wires, after the
tool-call flush. **So on our route a `Length` turn cannot have executed anything, and the
duplicate-non-idempotent-side-effect argument in the section above does not apply to it.**

Anthropic's SDK Tool Runner does not close the gap either: its `max_tokens → "stop"` docstring (*"its
tool_use blocks must not be executed"*) constrains **execution** in a runner that is itself
collect-then-execute by default, and Anthropic's documented remedy for `max_tokens` is to re-issue with a
higher cap — an action outside the runner.

**Why the decision still stands.** The mechanical argument for retrying is now stronger than this ADR
admitted, and the mechanics exist: `retry_abandoned_attempt` already serves both the mid-stream-error route
and the issue #64 empty-turn route as *"a `Retryable` condition detected AFTER the stream"*, bounded by the
shared per-turn `RetryPolicy`, with `message_retracted` + `turn_abandoned` + `Continue` all reachable
in-loop — ADR 0045's overflow recovery is the same reduction. The only missing piece is a transcript undo,
and the need for one is created solely by `handle_truncated_turn`'s own `messages.push`, which sits *after*
the point a retry decision would be taken; **placement, not capability**. What keeps the decision is
economics and the tail, both of which the amendment leaves intact: a retry is a second provider charge on
exactly the most expensive turns (at `xhigh` the re-paid tokens are almost entirely thinking the user never
sees, and the Anthropic wire cache-marks only system and tool blocks, so the conversation prefix re-bills
at full rate), and a length-keyed retry fires **only on the honest subset** — vLLM #53269 and llama.cpp
#30773 both report a truncated call as a success value, and an unrecognised string falls to
`map_finish_reason`'s catch-all, a silent clean stop. **Reopen the retry question here only if the
Falsifier below comes back against terminality — not because the codex argument fell away.**

**3. The Falsifier is runnable today, and the research report's first draft said it was not.** The strand
half of the measurement needs `{stamp}:truncate:N` rows to be persisted, and they are: `turn_truncated`
goes through `EmitPipeline::run`, which sends **every** `RpcEvent` through `normalize` →
`compute_display_rows` → `Store::persist_display`; the notice is an ordinary `agent_message_chunk`, so it
becomes `DisplayRow { kind: "agent-text", message_key: "{stamp}:truncate:N" }` and lands via the desktop's
`INSERT … ON CONFLICT(session_id, kind, message_key)`. Count it with
`SELECT … FROM messages WHERE kind = 'agent-text' AND message_key LIKE '%:truncate:%'`.
What is **not** persisted is the `StopReason::MaxTokens` disposition (an in-memory
`Arc<StdMutex<bool>>` on `LiveWorkerSession`) and the provider's finish reason and token counts — so the
strand side is countable and the *cost* side is not.

**The consequence to carry forward:** the notice only exists for the honest-`length` subset. A turn whose
reasoning saturates the budget and whose wire then reports an honest **`stop`** with zero visible text
mints **no notice at all** — verified live against this deployment's own gateway at `xhigh` (`reasoning_tokens`
equal to `completion_tokens`, no visible characters, `finish_reason: "stop"`). That shape is invisible to
this decision's gate, invisible to the Falsifier's query, and unaffected by any cap sizing. It is not a
counter-example to terminality; it is a different defect, and it is where the remaining user pain is.

## Amendment (2026-11-20) — one of the two producers of `Capped` is gone (ADR 0116)

One of the two producers of `TurnDisposition::Capped` / `RpcEvent::turn_capped` — the engine's
per-prompt ceiling on model rounds — was deleted in `fulcrum-harness` 0.5.1 (ADR 0116). **This ADR's
decision is unchanged**, and so are the frame, the disposition and every mapping recorded above: a
`Length` stop is still terminal and never retried, and `Capped` still resolves as
`StopReason::MaxTurnRequests`. What moved is the context this decision's machinery was described
against: the identical-refusal run (`MAX_IDENTICAL_REFUSAL_RUNS = 3`) is now the **sole** producer of
`turn_capped`, so the turn loop this prose and the issue #193 work describe has one bound, not two.
See ADR 0116.
