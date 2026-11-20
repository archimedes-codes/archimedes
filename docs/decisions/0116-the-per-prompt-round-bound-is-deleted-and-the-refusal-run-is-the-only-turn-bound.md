---
status: accepted
date: 2026-11-20
superseded-by:
---

# The per-prompt round bound is deleted, and the identical-refusal run is now the ONLY turn bound

`fulcrum-harness 0.5.1` deletes the engine's per-prompt **round bound** (the
64-model-rounds-per-prompt ceiling) — together with the per-prompt round counter that fed it and the
guard clause that read it.
`MAX_IDENTICAL_REFUSAL_RUNS = 3` is untouched and is now the **sole** producer of
`RpcEvent::turn_capped`.

This **amends the context of ADR 0108**, not its decision. 0108 is about a `Length` stop and never
governed the round bound, but its machinery and the issue #193 work built on it describe a turn loop
with two bounds, and every doc in this repo that promised a round ceiling was written against that
world. The decision here is bounded prose plus a pin: **no production logic, type, or test assertion
in the desktop moves.**

## The frame, the disposition and the `match` all survive — deliberately

It would be easy to read "the constant is gone" as "the feature is gone" and delete the plumbing.
That is wrong, and deleting it is a **behaviour** regression rather than a tidy-up:

- `RpcEvent::turn_capped` still fires — the refusal run emits it, unchanged;
- `TURN_CAPPED_DISPOSITION = "max_turn_requests"` and the `{stamp}:cap:N` row still fire, so
  `docs/features/provider-disposition-durability.md`'s shape (row kind, key, the `_ => Vec::new()`
  hazard in the engine's `normalize.rs`) is still correct;
- `TurnDisposition::Capped` and `StopReason::MaxTurnRequests` still fire;
- the desktop's exhaustive `match` in `resolve_turn` keeps its `Capped` arm.

Removing that arm would make a refusal-capped turn resolve as `end_turn` — composer unlocked, no
footer line, `attention.ts` announcing *"finished — waiting for you"* — which is exactly the silent
bug #193 exists to close, and it reddens
`main_session_turn_capped_resolves_the_turn_as_max_turn_requests` and
`src/lib/attention.test.ts`'s "never arms for a `max_turn_requests` stopReason" pin. All eight
desktop cap pins are byte-identical across this change; that is the proof the semantics did not move.

## What deletion costs, stated plainly

**A turn that keeps making *different, succeeding* tool calls is now bounded by nothing.** There was
never a wall-clock bound on a turn anywhere in the engine's `harness/loop.rs`, and deleting the round
count does not add one. The other candidate bounds do not cover the shape:

| Bound | What it catches | Why it does not cover this |
|---|---|---|
| `MAX_IDENTICAL_REFUSAL_RUNS = 3` | 3 consecutive **byte-identical** refused batches | any batch that differs in one argument; any *succeeding* call |
| `DEFAULT_MAX_ATTEMPTS = 5` (`retry.rs`) | transport retries **within one round** | rounds themselves — and it no longer has a round bound above it |
| provider `read_timeout` (5 min idle) | a stalled **stream** | a model that answers fast and wrong forever |
| `WALL_CLOCK` 300 s / `MCP_TIMEOUT` 60 s | a wedged `codemode` script | anything outside `codemode` |
| `subagent_dead_bound_secs` (1800 s) | a **silent** child | its own docblock rules this out: an Active Subagent producing frames, or holding an outstanding `tool_call_id`, has no timeout of any kind — **no value there can cut a working child** |
| user Stop | anything a human is watching | an unattended run |

And the mid-batch hole survives independently of this decision: `run_tool_batch`'s `join_all` is
awaited with no bound of its own, so a `subagent` batch whose children are looping costs unbounded
time *inside* a batch, where no per-round guard could have reached anyway. The measured cost of that
shape is on the record: a 1,484-round subagent turn running **18.2 hours**, and a 1,373-round turn at
**$37.61**. Both were already beyond 64 and therefore already unreachable-by-design under the old
bound; deleting the bound does not create the shape, it stops pretending the guard would have caught
the next one.

## Why the bound was deleted anyway: it governed the wrong population

Measured on this machine's DB (445k `native_messages` rows; the assistant-row count between the last
`role='user'` row and the cap row reproduces the engine's own counter — verified 14/14 on the cap
events):

| Population | n | p50 | p75 | p95 | max | >64 |
|---|---|---|---|---|---|---|
| **Subagent prompts (1 prompt = 1 turn)** | 2,493 | **47** | **93** | **180** | 1,484 | 933 (37.4 %) |
| All turns, whole DB | 2,885 | 42 | 87 | 173 | 1,484 | 987 (34.2 %) |

**64 sits below the p75 of the population it governed**, and that population is the subagent fan-out
the product is built around. A third of all turns — and 37 % of subagent prompts — crossed it on the
way to a delivered answer.

**14 firings in two days, zero runaways caught.** All 14 landed on exactly 64 assistant rows (the
round bound, never the refusal guard — `MAX_IDENTICAL_REFUSAL_RUNS` has never fired on this machine),
all 14 stopped immediately **after a `completed` tool call**, and each carried 2–7 *distinct* failure
signatures at a 2.5–11.2 % failure rate — the opposite of an identical-refusal loop. The actual
failures were a search-provider outage (`[brave] HTTP 402`, `[duckduckgo] HTTP 202`), one schema
validation error and one `Disk quota exceeded`. Total spend across all 13 sessions: **$3.23** (median
session $0.15). Three of the 14 were this investigation's own research subagents, killed at 64 rounds
by the guard under study.

So the bound's observed effect on this deployment was to end productive research loops, and its
observed effect on runaway risk was nil.

## The number's own justification did not survive verification

`fulcrum:src/harness/loop.rs` justified 64 with *"opencode 32, kiro 50, crush 64, cline 1000"* and
admitted the value was "taken from the upstream band". **Zero of those four numbers verify against
current source** (full audit: `docs/research/round-ceiling-deletion.md` §F3):

- **opencode** — `steps` has **no default in its schema**, and exceeding it strips tools and asks for
  a text summary rather than erroring; the "32" was not found;
- **cline** — `maxIterations` unset is **unbounded**, test-pinned as such; there is no `1000` default
  (the real PR #12398 proposes 100 and is unmerged);
- **crush** — **no round cap at all** (`grep maxSteps internal/agent/agent.go` → no match), and the
  repo coordinate we cited, `charcoal-house/crush`, does not exist (it is `charmbracelet/crush`);
- **kiro** — closed source, **unverifiable**, no primary source found.

**That band must not be re-cited anywhere**, including as a magnitude-only justification. The two
closest peers ship no cap and the third ships a soft degrade, which is the prior art this deletion is
actually consistent with.

## Considered options

- **Keep 64 and raise it** (to, say, the p95 of the subagent population) — rejected: it re-enacts the
  same failure at a higher constant, the number would again be unmeasured against our traffic, and a
  bound whose job is "stop the runaway" cannot be sized from the distribution of *productive* turns
  without becoming a tax on them.
- **Keep the bound, make it configurable on `ModelOptions`** — rejected: configurability does not fix
  a mis-sized default, and it makes the absence of a wall-clock bound look like a covered risk.
- **Keep the bound as a backstop for the classes the refusal guard misses** — this was the load-bearing
  claim, and it is the one the docs must stop making. It is false twice over: the guard keys on exact
  argument equality, so a loop varying one argument walks past it (crush#2856 exhausted a paid quota
  that way; cline#11542 ran **870** provider requests before a kill), and the round bound caught a
  varying loop only by attrition at 64, which is below the p75 of normal work. The class it supposedly
  backstopped — wrong-type required values (`bash {"command": 42}`), empty alias values — is now
  **unbounded**, and the docs say so instead of promising a ceiling.
- **Delete the bound and the `turn_capped` plumbing together** — rejected above: the refusal run still
  produces the frame, and dropping the arm reintroduces #193's silent `end_turn`.

## Consequences

- **The pin bump and the doc/comment corrections land in ONE commit**, per the rule 0108's Consequences
  records (`docs/features/malformed-tool-call-arguments.md` §5 states it for the desktop: *"the
  pin-bump-plus-arm-in-one-commit rule is what closes it in practice"*). Here nothing fails to compile
  — the desktop never names the deleted constant in code, only in two doc comments — so the rule binds
  prose: a tree where `Cargo.lock` says 0.5.1 and the docs still promise a ceiling is the same
  half-landed state, just without a compiler to tell you.
- **The requirement string stays `fulcrum-harness = "0.5.0"`.** 0.5.1 satisfies the caret and
  `Cargo.lock` is the pin; the manifest's pin comment now carries one line noting that 0.5.1 is the
  release that removes the per-prompt round bound. `cargo check` compiles **unchanged** against 0.5.1 —
  that is the expected result, not a sign the update did nothing.
- **The lockfile moved further than the pin, and the move is a repair, not drift.** Of the 34 changed
  lines in `Cargo.lock`, 2 are the pin (version + checksum); the other 15 dependency EDGES drop
  `windows-sys` from `0.61.2` to `0.59.0` / `0.60.2` / `0.45.0` (`socket2`, `muda`, `tray-icon`,
  `window-vibrancy`, `uds_windows`, `rustls-platform-verifier`, `anstyle-query`, `anstyle-wincon`,
  `dirs-sys`, `errno`, `tempfile`, `quinn-udp`, `rustix`, `winapi-util`, `os_pipe`). **Six of those
  fifteen edges were illegal as pinned**: the parent lock held `windows-sys 0.61.2` under dependents
  whose published requirement excludes it — `muda 0.20.0`, `tray-icon 0.25.1` and `window-vibrancy
  0.8.1` want `>=0.60, <=0.61`, `quinn-udp 0.5.15` `>=0.52, <=0.61`, `winapi-util 0.1.11`
  `>=0.48.0, <=0.61`, `os_pipe 1.2.3` `>=0.28, <=0.61` — and `<=0.61` is `<=0.61.0` in cargo's semver,
  which `0.61.2` does not satisfy. The re-resolve around the new engine version **corrected those six
  to versions every dependent accepts**; the other nine edges moved and were legal either way
  (`anstyle-query 1.1.5` / `anstyle-wincon 3.0.11` want `>=0.60.2, <0.62`; `dirs-sys 0.5.0` `>=0.59.0`;
  `errno 0.3.14`, `rustix 1.1.4` and `tempfile 3.27.0` `>=0.52, <0.62`; `rustls-platform-verifier
  0.7.1` `>=0.52.0, <0.62.0`; `socket2 0.6.5` and `uds_windows 1.2.1` `>=0.60, <0.62`). Stated plainly:
  **the parent lock carried six edges that did not satisfy their dependents' requirements**, and that
  is what makes this churn a repair rather than drift. `windows-sys 0.61.2` is not yanked, no other
  package *version* changed anywhere in the lock, and **why those six had been left pinned is not
  established here**. The engine caused the move indirectly by forcing a re-unification of the
  desktop's graph, not by changing its own byte-identical 22-dependency list (its lock holds all of
  these at `0.61.2` at both 0.5.0 and 0.5.1), and it is not reproducible away: `cargo update -p
  fulcrum-harness --precise 0.5.1` reproduces these exact 34 lines while an unrelated `cargo update -p
  once_cell` yields zero — the churn is specific to re-resolving around the engine and no narrower
  command minimises it. Blast radius is **Windows-only** (`windows-sys` is a `cfg(windows)`
  dependency), so the Linux CI legs and the green local suite are unaffected, and re-resolving does not
  avoid it.
- **`attention.ts`'s `stopReasons[id] === "end_turn"` whitelist is now load-bearing, not free.**
  `docs/features/honest-turn-outcome-surfaces-known-gaps.md` gap 4 claimed `max_turn_requests` had
  zero Rust construction sites and therefore failed closed *for free*; that was already false (the
  router has one) and is now the only thing standing between a refusal-capped turn and a "finished"
  announcement. Corrected in the same commit.
- **Sweep gate.** The constant's name is grepped out of `src/`, `src-tauri/`, `docs/features/` and
  `docs/decisions/` — quote it in a doc as a concatenation (`'MAX_MODEL_ROUNDS_''PER_PROMPT'`) if you
  must, because this ADR sits inside that last path and a literal here reddens the gate itself. The
  phrase grep (`round ceiling|64-round|64 rounds`, case-insensitive) covers `src/`, `src-tauri/` and
  `docs/features/`. Both are **zero**. Deliberately scoped: `docs/research/**` and `docs/roadmap/**` keep the words as
  the evidence record, and a future reader must not "fix" those to satisfy a gate.
- **The unbounded shape is now the engine's problem, and it is a real one.** If it is ever addressed,
  the honest lever is a wall-clock bound that *can* cut a producing child (which
  `subagent_dead_bound_secs` explicitly is not), or crush's proposed per-tool-**name** repeat counting
  at a lower threshold, which ignores input variation. Neither is this decision, and this ADR does not
  license "the round bound was redundant" as a general claim — it was redundant *for runaways* and
  load-bearing *for research turns*, which is why it is the cheaper half to lose.
- **Falsifier.** The refusal run is now the only guard, and it has **never fired on this machine**. If
  the first `cap:` notices observed after this pin are again all 2–7-signature productive turns rather
  than byte-identical refusals, the guard is mis-scoped too and this deletion removed the last thing
  that bounded it. Count with
  `SELECT session_id, created_at FROM messages WHERE kind = 'agent-text' AND message_key LIKE '%:cap:%'`
  and read the failure signatures of the surrounding rows, against the table above.
