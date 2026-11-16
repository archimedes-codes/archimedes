---
status: accepted
date: 2026-11-16
superseded-by:
---

# A title request sends no `max_tokens`

The **Supervisor** asked the Provider for a session's title and got nothing back: the turn settled
`Length` with an empty answer, the title request counted itself a failure, the budget hit 3, and the
session was untitled for the rest of the run. The cause was one number: the titling request carried
`max_tokens: Some(100)`, which the Provider's route spent entirely on reasoning tokens before a single
visible character came back. The fix is to send no cap at all — a bounded `max_tokens` on a route that
thinks is not a budget, it is a starve.

## Why the cap is not bounded lower

A bounded `max_tokens` on a thinking route does not bound cost — it bounds the *visible* output the
thinking has to fit inside. The probe in the grounding measured a route at `xhigh` + `max_tokens: 2048`
returning `reasoning_tokens: 2048` and 0 visible characters: the budget was consumed by reasoning before
the first word of the title. The only way a cap prevents a runaway is if it exceeds the route's thinking
spend, which is itself unbounded — so a cap that is high enough to let the title through is no cap at
all, and a cap that is low enough to bound cost guarantees the title never arrives. There is no value
that does both, so the field is simply not sent (pre-#136 behaviour).

The safety net that a cap was doing a poor job of is already in place and is kept: the request carries
`temperature: 0.0`, `tools: []`, and the 30s `NAME_REQUEST_TIMEOUT`, and the pass accepts only an answer
that survives `clean_title` (`TITLE_MAX_CHARS`) and the `FinishReason::Length` word-count gate. A route
that runs away now runs up against the timeout, not a token budget — which is what a title request needs,
because the thing being bounded is *time*, not *output*.

## The three wires, and what "no cap" means on each

`max_tokens: None` is not "the same as 100" on any of them, and the difference is the point:

- **openai-completions / openai-responses** — the field is omitted entirely. No cap reaches the wire,
  which is the pre-#136 shape and the shape a title request wants.
- **anthropic-messages** — the adapter's own ceiling (`ANTHROPIC_OUTPUT_CEILING_TOKENS`, 64 000) is
  sent, because that wire requires `max_tokens` to be present. The caller's `None` is what makes the
  ceiling the ceiling rather than a sum, and the thinking budget is clamped *down* to fit beneath it.

This is why the fix is a desktop-side one-line change and not a crate change: the adapters already
implement `None` correctly on all three wires, and the crate's `anthropic_request_body_max_tokens_is_a_
ceiling_not_a_budget_sum` pins the anthropic arm of it.

## The title delivery path is unchanged

The fix is to the request, not to the delivery: the two-stage lifecycle (`title_stage` 0→1→2), the
`agent_end` trigger, the `close_session` last-chance nudge, and the `session-titled` push to the
frontend all behave exactly as before. A session that could not be titled for lack of a cap now gets
titled; a session whose model is unconfigured still skips without consuming the budget; a route that
truly cannot produce a title still fails and still counts.

## What this does not decide

The naming pass's failure diagnostics remain gated behind `ARCHIMEDES_DEBUG=1`, and `debuglog` lives in
the pinned engine crate (`fulcrum-harness-0.3.2`), not in this repo — so "make a naming failure visible
without the env var" is a separate decision that has to be made against the crate, not against this
checkout. The same is true of the app-quit path: `RunEvent::Exit` reaps Workers and never reaches
`close_session`, so a session closed by quitting the app gets no last-chance title nudge. Both are
recorded here as *known gaps this decision does not close*, not as accepted defects.
