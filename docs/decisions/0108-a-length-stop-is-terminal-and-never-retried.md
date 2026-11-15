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
before the cap bit, and the retry does not know that. The maintainer who faced the same question in
openai/codex (#38831) put the reason plainly: *"Automatic continuation is a separate policy question
because blindly replaying a partially completed response can duplicate tool side effects."* That
project chose terminal-and-non-retryable for the same reason (`ResponseIncomplete` is
`RetryPolicy::Never`).

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
