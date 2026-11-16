---
status: accepted
date: 2026-11-16
---

# The first prompt titles the session from its own text, without waiting for the turn to close

An amendment to ADR 0088, which it does **not** supersede: the level-triggered
nudge at `send_prompt`, the one at `close_session`, the `agent_end` hook, the
two-stage `title_stage` ladder and ADR 0086's `{id}-title` wire isolation all
still stand. What changes is the **excerpt source for stage 0**, which is what
makes a trigger at send time possible at all.

## The problem

Every pre-existing stage-1 trigger needs the turn to be **over**:

- `agent_end` is the turn's last frame;
- the `send_prompt` nudge reads `native_messages`, which the Worker populates
  asynchronously from store frames, so the message being sent *right now* is not
  in it yet — its own comment says so: *"this prompt's own user row is invisible
  to the nudge whichever side of the write it sits on"*;
- the `close_session` nudge needs the session to be closed.

So a session whose **first** turn has not ended cannot be titled by any of them.
That is not an edge case. Measured on a live deployment: an implement-mode first
turn ran **74 minutes** — `title_stage = 0`, `is_subagent = 0`, naming enabled,
one user row, 130 transcript rows, `agent_end` never once delivered, the last row
an assistant row with a pending `subagent` tool call. The user looked at an
untitled row for the entire session.

Note what the evidence rules **out**, because it narrows the fix: the excerpt
function was never the obstacle. `first_exchange_text` requires only the **user**
line ("the user line is the only mandatory side"), so the transcript that session
eventually built would have titled fine. The failure is purely that no trigger
fired while it mattered: `agent_end` never arrived, the `send_prompt` nudge ran
once at the top of turn 1 when `native_messages` was still empty
(`interactions == 0`), and `close_session` had not run. One prompt, one nudge,
and that nudge had nothing to read.

## The decision

`SessionManager::maybe_name_session_from_prompt(session_id, text)` is called from
`send_prompt_with_images` on **every** prompt. It runs the same guard ladder as
`maybe_name_session` — master switch, `Db`, the row, `is_subagent`,
`title_stage`, the failure budget, the `in_flight` claim, ADR 0086's conditional
write — with exactly one difference: in the stage-0-with-zero-interactions arm,
the excerpt comes from the `text` argument instead of the transcript.

Guard 6 was extracted into `stage_and_excerpt(title_stage, messages,
interactions, seed_user_text)` so both triggers share one ladder and cannot drift.
The seeded text is consulted in **one arm only**, and it *substitutes* for a
transcript that has not landed — it never overrides one that has. Once the real
exchange is persisted, `first_exchange_text` (user line **and** assistant reply)
is strictly better evidence than the prompt alone, and a trigger fired from a
later message must not downgrade it. `tests` pins that with a transcript-seeded
session asserting the prompt text is **absent** from the request.

`user_only_excerpt` mirrors `first_exchange_text` on the two properties that make
an excerpt comparable: the `"User: "` label and the `EXCERPT_CAP` bound. A blank
or whitespace-only message yields `None`, so it spends no request and no slot of
the 3-failure budget.

## Why over-calling is safe

ADR 0088's argument applies unchanged and is the reason this needed no new state:
`maybe_name_session` *declines at every guard while consuming nothing* — no
failure counted, no `in_flight` set — its `in_flight` claim is taken under the
write lock, and ADR 0086's `WHERE title_stage = ?` catches the write race. So a
second prompt on an already-titled session declines at the row (`title_stage = 1`
is not stage 0), a prompt that races its own title declines at the claim, and
subagents decline at `is_subagent` without any special-casing at the call site.
Calling it on every prompt rather than only the first is therefore free, and it
is what makes the trigger recoverable rather than latching on a single moment.

## Considered Options

- **Title at `agent_settled` instead (rejected).** Still needs the turn to end —
  it is the *settle* signal, which is why the resolver waits on it. It moves the
  goalposts from the turn's last frame to its second-to-last and does nothing for
  a turn that never ends, which is the case that motivated this.
- **Have the Supervisor write the user row into `native_messages` before the
  nudge, then call the existing nudge (rejected).** It would work, and it is the
  tempting one-liner. It writes the same user message twice into the transcript
  the Worker also owns — the Supervisor owns the `messages` *display* table and
  the Worker owns `native_messages`, a split ADR 0088's rejected-options list
  calls deliberate ("per-line atomicity and no ordering between them"). Faking
  the Worker's store frame from the Supervisor to feed one hook corrupts the
  transcript for compaction and resume, not just for naming.
- **Wait for the first assistant row (rejected).** That is what `agent_end`
  already effectively requires, and it is precisely what fails: a first turn
  dispatching subagents produces assistant rows with empty text and pending tool
  calls for the whole hour.
- **A timer, or title from the session's cwd (rejected).** A timer re-adds the
  staleness window ADR 0088 removed its own focus-poll option for. A cwd-derived
  title is not what the user typed, and the whole value here is that the title
  comes from the message they wrote themselves.

## Consequences

- **A session is titled before its first reply exists.** A title derived from one
  user message can be worse than one derived from an exchange — "I like poop"
  titles trivially, a terse "fix it" titles badly. This is a deliberate trade of
  title *quality* for title *presence*: an approximate title the user recognises
  beats an exact title that arrives an hour late or never. If quality proves poor
  the fix is prompt-side, exactly as ADR 0088 predicted for truncated first turns.
- **Every title request now has a second, earlier chance to fire**, so a session
  that used to spend its 3-failure budget on stage-2 attempts can now spend it
  earlier. The budget is per-session and the failure is logged always-on since
  #200, so an early exhaustion is visible in `diagnostics.log` rather than silent.
- **`stage_and_excerpt` is now the single place the stage ladder lives.** A new
  stage, or a changed interaction threshold, is one function — not two call sites
  that can drift. Adding a third trigger means adding a `seed` variant here, not
  copying the ladder.
- **The lib-test harness's canned provider is load-bearing for this trigger, not
  just for the nudges.** `build_worker_manager_with_title_provider` installs
  `CannedTitleProvider` for the whole helper, so `a_fresh_send_prompt_clears_a_stale_truncation`
  cannot reach the network from the new call. A test that drives
  `SessionManager::send_prompt` with the **production** provider factory and a
  persisted user row will now issue a real HTTP request; `session_naming_enabled`
  defaults to true, so such a fixture must disable naming (the `tests/session_native.rs`
  and `tests/ipc.rs` precedent) or install the canned provider.
