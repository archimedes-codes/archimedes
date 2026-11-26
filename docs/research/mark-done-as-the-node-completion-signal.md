---
status: current
last-verified: 2026-11-26
verified-by: "5 researcher angles (3 local code reads, 2 web) + direct reads of this tree at `feature/mark-done-host-verb` HEAD `3f40f7a1` + one read-only query pass over the live database at `~/.local/share/archimedes/archimedes.db` (514 MB, newest Session row `1795689660601`). Web: n8n official docs (docs.n8n.io), LangChain/LangGraph, OpenAI Agents SDK, Temporal, AWS Step Functions, GitHub Actions, CrewAI, Slack; 2 arXiv papers. Local claims are `repo:path:line`; DB claims name their SQL. Rust and TypeScript were READ, not executed — no test was run for this report."
task: tsk_d9ef65b5-0df4-4e65-b048-46ed101aa582
---

# `mark_done` as the node-completion signal

## Executive Summary

**The settled question:** what must be true for `mark_done` to be the completion signal at a
node, with a column's `auto` flag as the policy for what that signal does — advance and launch
the next link, or stop and summon a person — when the canvas is the program?

Seven findings reframe the card rather than answer it:

1. **The two mechanisms do not merely fail to interact — there is no seam between them.**
   `grep -n "ready\|mark_done" src/store/workflowChain.ts` returns **zero hits**. The chain's
   entire trigger is `settle.reason === "end_turn"` AND the launched column's `auto`
   (`src/store/workflowChain.ts:343`, `:379`).
2. **The automation has never fired in anger.** The live database holds **0 rows in
   `workflow_runs`** — against 41 stages, 2 of them `auto`, 104 cards, and 456 Sessions created
   in the last seven days. This corroborates finding 3 from the tree rather than contradicting it.
3. **Today's chain already silently no-ops in its own primary case.** With no board and no
   canvas mounted — which is exactly what an unattended chain looks like — the board slice is
   empty, `stageOf` answers `undefined`, and the chain returns **silently**, writing neither a
   close nor a transcript line (`workflowChain.ts:366-379`). Any trigger placed on the settle
   edge inherits this. **It is the prerequisite, not a detail.**
4. **`mark_done` fires at a moment the settle cannot reach.** The verb executes *mid-turn* — the
   tool result must return before `turn_end`/`agent_settled` on the same pipe — so a
   claim-driven trigger **survives the `ask`-gate deadlock** that stalls a settle-driven one
   forever. This is an argument for the claim that the card does not make.
5. **The decision is computable in Rust at the moment of the claim.** Everything it needs is
   already in Rust's hands; what Rust cannot do is *launch*. That forces a split — decide in
   Rust, hand the frontend an instruction — and it is the split that escapes findings 3 and 4.
6. **The two owner answers recorded below are in tension with each other**, and the tension is
   the first thing the design must resolve.
7. **"n8n-style" is doing two incompatible jobs in the ask.** n8n is the *wrong* reference for
   the completion signal and the *right* one for the graph.

---

## Decisions recorded from this session

These are the owner's calls, recorded as decisions and not re-litigated.

**D1 — The trigger is "claim OR settle, whichever fires first."** The settle edge is not removed
and not gated away; `mark_done` becomes an additional, earlier path.

**D2 — The model's `move_task` must check the ready flag first and error if it is missing.** In
the owner's words: *"the only way that a session would settle in an auto col, would be if someone
manually did it.. it cannot automatically move there, the only other way would be if it called
move_task, which should check for the mark_done flag first, if thats missing THEN error
move_task."* The intent is that an un-claimed settle is not a hole in the automation — the
model's alternative route out of a column is closed unless it has claimed.

**D3 — The trust inversion is deliberate.** `mark_done` is a model-authored claim and the owner
has chosen to act on it. Recorded as the decision. §5 states what the surveyed industry does
with a claim it chooses to trust, so the choice is made with the evidence in hand.

### Where D1 and D2 disagree

D1 keeps the settle as a trigger. D2's premise is that an un-claimed settle should *not* be able
to move a card. Under a literal "claim OR settle", **an un-claimed settle advances anyway** —
which is the behaviour the owner rejected when it was offered as an option.

**Reading that makes them consistent (inference, must be confirmed):** the settle path advances
only when the Session's ready flag is set at settle time. Then the claim fires first and moves,
the later settle is deduplicated, and an un-claimed settle does not move — D2's intent survives,
and "whichever fires first" still holds for every claimed case. **This is recorded as an
inference about intent, not as a resolved answer.**

### Two premises in D2 the tree contradicts

**Premise: "it cannot automatically move there" — true of the live config, false of the schema.**
Every edge in the live Space is `backlog → research(auto) → approved(non-auto) → doing(auto) →
done(non-auto)`, so in *this* configuration an `auto` column is only ever entered by a human
drag or pill click. But `A(auto) → B(auto)` is legal, is unrefused by any write path, and is
**pinned as a supported shape** by `src/store/workflowChain.test.ts:353`
(`leaves the run OPEN when the next column is automatic too`), whose comment states the reason:
the run must stay open so the step bound covers the whole chain, not each link separately. The
general property is the opposite of the premise; the live config is one point in the space.

**Premise: gating `move_task` on the flag is a small, local check.** It is not, for two reasons.

- **`move_task` does not receive the frame identity today.** `exec/mod.rs:115-134` threads
  `origin` and `is_subagent` into **`mark_done` alone**; the seven board verbs are dispatched as
  `board::move_task(db, params)` with no identity at all. A ready-flag gate needs the caller's
  Session id for the first time in a board verb. That is a deliberate design line, not an
  oversight: `exec/session.rs:24-33` argues the board verbs "never look at the frame's identity"
  and ADR 0117 rules a delivery id is never a subject. **The distinction a design must draw
  explicitly** is *frame id as authoriser* versus *frame id as subject* — the ban is on the
  second, and a reader who misses that will reject the gate as an ADR 0117 violation.
- **It cannot distinguish automation from obedience.** Three installed Skills instruct
  `move_task` (`move-task`, `research`, `update-task-with-findings`), and the `move-task` Skill's
  whole purpose is moving a card on a human's explicit instruction. A model that was told *"move
  it to Approved"* must now also claim done first. Note the consequence for separation of
  duties: the gate makes the claimer and the mover **the same party**, which is the opposite of
  the one guardrail the survey found actually shipped (§5, GitHub's *Prevent self-review*). The
  surviving guards are then only that a model move is **inert** — per the `move-task` Skill and
  the code, a model `move_task` fires no `on_enter` and launches nothing — and the Rust-side
  budget, which a model `move_task` does not pass through at all.

**The half of D2 that is clean:** gate the *model's* verb only. Human drags and pill clicks stay
ungated, because `ready` is a per-Session claim and a person owes no claim to anyone. That split
is implementable and coherent; the two objections above are about the model-side arm.

---

## Findings

### 1. The two mechanisms never touch, and the timing gap is wider than the card states

`advanceWorkflowChainOnSettle` has **exactly one production call site**, `src/store/taskLaunch.ts:631`,
inside the `void`ed `sendLaunchMessage`, after `await sendPrompt(...)` at `:606`. The cost
snapshot is taken at `:604`; `turnCompleted` writes `inTurn=false` at `:607`; the chain is
dispatched at `:631` as a `void`.

`mark_done` executes **inside** the turn. `spawn_host_call` (`exec/session.rs:94-96`) →
`Db::set_session_ready` → `UPDATE sessions SET ready = ?2 WHERE id = ?1`
(`storage/db/sessions.rs:378-384`), which **emits no event** — its own comment says so at
`sessions.rs:370-373`. The frontend's only readers of `get_board` are two `load` call sites
(`TasksBoard.tsx:320`, `WorkflowsCanvas.tsx:341`) and one `refresh`
(`useTaskBoardAutoRefresh.ts:135`, debounced 350 ms off `inTurn`'s falling edge, mounted by
those same two surfaces). **The board is therefore not re-read between the claim and the
settle**, and the chain reads the board slice synchronously *as it stood before the turn*.

`send_prompt_with_images` resolves through a `oneshot` (`agent/session/mod.rs:2111`, `:2291-2294`);
a dropped sender yields `Ok(Cancelled)`, never an error, so **the awaited reason always arrives
unless the caller is dropped**. A crash forces `Cancelled` (`router.rs:591`), which the whitelist
rejects.

### 2. Where the decision can be made — the finding that changes the shape

At the instant of the claim, **Rust already holds everything the decision needs**:

| needed | where it already is |
|---|---|
| which Session claimed | the frame's `origin` (`exec/session.rs:82`) |
| which card | `task_sessions` (`mod.rs:1279-1284`) |
| which column the card was in when launched | `task_sessions.stage_slug`, a **persisted** column, documented as the frozen lane (`rows.rs:432-441`) |
| is that column `auto`, where does it point | `stages` (`next_slugs`, `auto`) |
| is the chain over budget | `workflow_run_step`, in the same SQLite file |

What Rust **cannot** do is launch a Session: `launchTaskSession` is a store operation (move →
start → send), and ADR 0119 §6 rules the chain drives the full `moveTask` verb with no bypass. So
the honest architecture is a **split — decide in Rust, hand the frontend an ordered "launch this
column" instruction** — and that split is precisely what escapes the unloaded-slice no-op
(finding 3) and the `ask`-gate stall (finding 4).

The card's own provenance note about there being "deliberately no watcher" is correct and is
**not** contradicted by this: a watcher polls a slice, and the slice is the thing that is absent.
A decision made at the claim in Rust reads the database, not the slice.

### 3. What is destroyed on the way out: the identity of the claimer

The board fold collapses N per-Session values into one card-level `bool`:

```rust
let ready = mine.iter().any(|(_, _, claimed)| *claimed == Some(1));   // storage/db/board.rs:184
```

`TaskCardView.ready` is a `bool`, never `Option<bool>`, and `SessionRow`/`SessionInfo` are
crates.io-pinned with `ready` absent from `SESSION_COLUMNS` — so there is **no channel by which
the frontend learns which Session claimed**. This matters far more once the claim drives a move,
because the measured prevalence is not marginal: **31 of 104 cards hold more than one linked
Session** (101 links total). A per-card `OR` over multi-Session cards is the common case, not the
edge case. A claim-driven move must be keyed on the *claiming* Session, and today that identity
exists only inside Rust at the moment of the write.

### 4. The live system, measured read-only

| measurement | value |
|---|---|
| stages / `auto=1` | 41 / 2 (`research`, `doing`) — the card's figure is **correct** |
| Spaces / `board_strict=1` | 9 / **0** |
| cards / cards sitting in an `auto` column | 104 / 5 |
| `task_sessions` links / cards with >1 link | 101 / **31** |
| `sessions.ready` = 1 / = 0 / NULL | **1** / 1 / 3018 |
| **`workflow_runs` rows** | **0** |
| Sessions created in the last 7 days | 456 |

`workflow_runs = 0` is the headline: in a database with 456 Sessions created this week, the
auto-advance chain has **never recorded a single step**. That is consistent with finding 3 being
the normal outcome rather than a corner case, and it means **no existing behaviour is load-bearing
in production here** — the design is unconstrained by usage, which is unusually good news. It is
also the reason the done-when's "stated, pinned behaviour" clause is affordable: there is no
incumbent behaviour to preserve.

`board_strict = 0` on all nine Spaces means the Strict edge gate never fires in practice today,
so D2's `move_task` gate would be the **only** thing the model's move path ever refuses.

### 5. Trusting a model-authored completion claim — what the industry actually does

**Nobody ships a model-asserted completion signal that gates a transition.** LangGraph's agent
loop and OpenAI's final-output rule are model-*derived* from the absence of tool calls, not
model-*claimed*: "the rule for whether the LLM output is considered as a 'final output' is that it
produces text output with the desired type, and there are no tool calls" ([Running agents](https://openai.github.io/openai-agents-python/running_agents/),
official); `create_agent` "repeats until no more `tool_calls` are present" ([create_agent](https://reference.langchain.com/python/langchain/agents/factory/create_agent),
official). `Command(goto=...)` is **routing plus a state update, not a completion assertion**
([use-graph-api](https://docs.langchain.com/oss/python/langgraph/use-graph-api), official). The
closest thing to a claim-then-transition is Slack's `workflows.stepCompleted`, and it is
**deprecated** ([api.slack.com](https://api.slack.com/methods/workflows.stepCompleted/test), official).

Papers say self-report is the weak link: intrinsic self-correction does not reliably help and
often degrades accuracy ([arXiv:2310.01798](https://arxiv.org/abs/2310.01798)); self-verification
is the binding constraint ([arXiv:2412.02674](https://arxiv.org/html/2412.02674v2)); METR defines
task success **externally**, never from agent self-report ([metr.org/time-horizons](https://metr.org/time-horizons)).

What the industry does with a claim it chooses to trust, and the three properties worth copying:

- **Keep the bound independent of the claim.** Here the bounds are already Rust-side constants the
  claim cannot influence — `DEFAULT_AUTO_MAX_STEPS = 20`, `DEFAULT_AUTO_CEILING_USD = 10.0`
  (`storage/db/auto_guards.rs:90`, `:107`), judged in Rust, and ADR 0119 §3 already forbids a
  tripped bound from mutating configuration. **So D1 and D3 do not weaken the guard at all**: the
  claim chooses *whether* to step, the verdict decides *whether it may*. The card frames these as
  one question; they are two, and separating them dissolves the conflict.
- **Keep the mover distinct from the claimer.** GitHub Actions is the only surveyed system with
  identity-bound approvers and a *Prevent self-review* option
  ([Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
  official). The non-auto case already implements this shape: the model claims, a *different*
  party moves. **D2's model-side gate reverses it**, and that reversal is the price of D2, stated
  plainly in §"Two premises".
- **Gate the claim per-call if you must gate it at all.** OpenAI's tool guardrails run "on every
  guarded function-tool invocation" — the only place in that SDK a completion claim can be
  checked per call ([Guardrails](https://openai.github.io/openai-agents-python/guardrails/), official).

**And the "summon a human" half is already built and never reused.** No surveyed system ships
"tripped bound → human-review state"; the nearest precedent is LangGraph's `RemainingSteps`
routing to a fallback node, which is *exactly* this repo's existing `stopChain` + amber bell,
built for the budget case and never pointed at the claim case. That is the cheapest available
reuse in this whole design space.

Finally, `mark_done` **is disableable** through `enabled_tools` (`host_tools/mod.rs:49`, pinned by
`list_tools_advertises_mark_done_to_settings`). A person can turn the trigger off. That is a real
safety valve and it is already there.

### 6. The case where the signal never arrives

| Default | Who does it | Evidence |
|---|---|---|
| **Silently stop, report success** | n8n | Zero output items ⇒ the branch stops, the execution is still `success`; *"You can't retry an execution that succeeded, even if it didn't do what you expected"* ([View all executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions.md)). A `waiting` run is never pruned and never treated as stuck ([manage-execution-data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data.md)). **Failure is the only thing that pages a human.** |
| **Advance anyway** | this repo today; CrewAI `max_iter` | CrewAI removes the tools and demands a final answer ([Flows](https://docs.crewai.com/en/concepts/flows)) |
| **Timeout → fail, or route to an explicit fallback** | Step Functions, Temporal, GitHub Actions | `States.Timeout`/`HeartbeatTimeout` + `Catch` → fallback state ([state-task](https://docs.aws.amazon.com/step-functions/latest/dg/state-task.html)); Start-to-Close timeout ([detecting-activity-failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures)); approval timer 1–43,200 min, then the job **fails** |

**No orchestrator has a dead-letter for a missing completion signal, and none stalls forever with
nobody told except LangGraph's `interrupt()`** — which "saves the graph state… and waits
indefinitely", with no timeout, no escalation, and no resumer authentication
([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), official). **No
framework authenticates the resumer** except GitHub Actions.

D2 answers this case by *closing the alternative route* rather than by adding a timeout, which is
a shape none of the surveyed systems use and which is coherent only under the consistent reading
of D1/D2 in §"Where D1 and D2 disagree".

### 7. The graph: what is expressible today, and where the wall is

**Where n8n puts its policy — and it is not on the edge.** Edges are inert
`(source, outputIndex) → (target, inputIndex)` tuples
([connect-nodes](https://docs.n8n.io/build/understand-workflows/workflow-components/connect-nodes-together.md));
the routing decision lives on the **node's numbered output** (`If`, `Switch` with a Fallback
Output), and the error policy lives on the **node** too (`On Error: Stop | Continue | Continue
using error output`, with a dedicated error port, [work-with-nodes](https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes.md)).
So the n8n answer to "does `auto` stay binary" is: the *node* declares its outputs and the edge is
just a wire. **Fan-in is not default** — an ordinary node with two incoming edges runs per
arriving batch; waiting-for-all is a separate node, Merge ([Merge](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.merge.md)).

**Expressible with today's schema: outcome-routed single successor.** `set_stage_next` already
serialises an ordered list with no length cap and no dedupe (`storage/db/stages.rs:136-169`); the
layout iterates the whole list and **tests a real 2-way fan-out**
(`workflowGraphLayout.test.ts:119-145`); one card in one column with one open run still holds. Two
things are missing: an **outcome value on the claim** (`mark_done` advertises
`{"properties":{},"required":[]}` — no arguments at all), and **edges with a name** (the xyflow
`Edge` is `{id, source, target}` plus a dash; dagre's `setDefaultEdgeLabel(() => ({}))` at
`workflowGraphLayout.ts:259` exists *only* so `setEdge` doesn't throw).

**Not expressible: fan-out and join.** Two schema facts enforce it — `tasks.stage_slug` is one
`TEXT NOT NULL`, and `idx_workflow_runs_open` is a partial **UNIQUE** index the docs call "not a
constraint to relax casually". ADR 0120 §6 is blunt: *"This is the decision most likely to be
misread as a feature that was built. It was not built."* A fork needs either a card-membership
table or a join node with pending-arrival state; neither exists. **And the bounds silently change
meaning if it ever forks** — `auto_max_steps`/`auto_ceiling_usd` are per *chain*, and a forked
chain is N chains.

**ADR 0099 pre-authorises the migration.** It rejected a `stage_transitions` edge table because
*"nothing in the design needs per-edge data"* and named it *"the shape to reach for the moment an
edge needs to carry anything."* Outcome-labelled edges are that moment. Nothing since has built it.

**Cycles are legal and unguarded.** Only a self-loop is refused (`BoardError::SelfLoop`,
`stages.rs:147-151`). A graph that is a program can loop forever, and the only thing between that
and a runaway is the 20-step bound.

### 8. The three smaller open questions, answered by the tree

- **Move vs clear race.** A move touches `ready` in **no way at any layer** — `grep "ready"` over
  `storage/db/tasks.rs`, `commands/tasks.rs`, `host_tools/exec/board.rs` is empty, and
  `set_session_ready` has exactly two callers: the turn-start clear and `mark_done`. A card **can**
  be dragged mid-turn (no `inTurn` read anywhere in the move path). So the race is real but
  currently vacuous, and becomes live the moment a move is claim-triggered.
- **Is the bell visible on an auto column?** Not on today's read path, and arguably it should not
  be: the bell means "a person is needed", and on an auto column nobody is. The measured
  `ready=1` count of **1 row in 3020** says the mark has almost never been observable anyway.
- **Child Sessions.** The parent's turn stays open across the entire child run and settles
  *strictly after* it (`dispatch.rs` in the pinned crate returns the child's output as the
  parent's `ToolResult`), so a link whose work ran in a Subagent still advances on the parent's
  settle and the child's refusal is coherent. **But** `parent_session_id` is NULL for roughly half
  the children in a live database (`storage/db/parent_link.rs:11-14`), so "walk up to the parent"
  is not a reliable fallback for anything.

---

## Unresolved Contradictions

1. **n8n is the wrong reference for the trigger and the right one for the graph.** Its completion
   signal is engine-derived from *data presence* — precisely the model D1/D3 reject. Its graph
   semantics (node-owned outputs, inert edges, opt-in joins, durable authenticated waits) are the
   right target. "n8n-style" must be resolved to one of the two before design.
2. **D1 and D2 are in tension** (§"Where D1 and D2 disagree"). Under a literal reading, D1
   re-admits the exact behaviour D2 exists to prevent. The consistent reading is offered as an
   inference and **must be confirmed with the owner**.
3. **D2's gate collapses claimer and mover into one party**, inverting the only separation-of-duties
   guardrail the survey found shipped. Recorded as the cost of a deliberate choice, not as an
   objection.
4. **ADR 0098's front-matter says `superseded-by: 0107`** while ADR 0119 §1 and ADR 0120 §7 both
   still treat `on_enter_skill` as live. ADR 0120 itself flags this as "the one ambiguity in the
   house pattern". Unresolved on disk; it touches this work because `on_enter_skill` is what the
   next link launches.
5. **Gate counts in the docs disagree with the tree.** ADR 0119 §1 says 17 gates, the research doc
   `workflows-as-the-boards-configuration.md` says 12; the tree has **20** (`GATED` in
   `storage/db/tests/open.rs:1027-1048`). Neither doc was updated when `ready`, `position_x` and
   `position_y` landed.

## Gaps

- **Whether a claim-driven move double-fires with the settle.** Under D1 both paths derive their
  destination from `launchedSlug`, not from the card's current stage, so after a claim-move the
  settle arm re-derives the *same* edge; `resolveStage` then returns `{slug: null}` and skips the
  move — but **`startTaskSession` is still called**, so the hazard is a **second Session launched
  on one card** and **`workflowRunStep` counting two steps for one link**, which halves the
  effective step budget. Deduplication is therefore mandatory, not defensive. Where to hang it:
  `idx_workflow_runs_open` already guarantees one open run per card. **Not verified by a test** —
  read from `workflowChain.ts:361-469` plus `taskLaunch.ts:386-406`.
- **Whether the pinned `fulcrum-harness` crate tolerates a new `SessionRow` field** was not tested,
  so "put `ready` on the per-session channel" is unpriced. If it does not, the claiming Session's
  identity must be carried on a desktop-owned channel instead.
- **No test exercises a 3-entry `next_slugs` end-to-end.** The "three edges draw" claim is read
  from the loop at `workflowGraphLayout.ts:305`; only 2-way fan-out is pinned.
- **`advance: false ⇒ stop.is_some()`** is asserted by a TypeScript comment
  (`workflowChain.ts:424-425`); `workflow_run_step` was not audited to prove it.
- **n8n's runtime source was unreachable** through the proxy; its engine-internal claims rest on
  official docs plus exported workflow JSON, not on `WorkflowExecute.ts`.
- **Whether the `unknown` stop reason is reachable through the wire** — unproven, same cause.
- **The `board_strict = 0` measurement is of one machine's database**, not of the product's users.
  It describes what today's owner has configured, not what a shipped default must protect.

## Routing note for the design phase

The owner answered "I don't know" to the graph-shape question. The evidence gives a clean split:
**outcome-routed single successor is expressible today; fork and join are blocked by two named
schema facts plus ADR 0120 §6.** The design must either take the first and record the second as
explicitly out of scope, or accept the edge-table migration ADR 0099 pre-authorises as the vessel
for both.

The three things the design cannot avoid: the unloaded-slice no-op (finding 3), the
claim/settle double-fire (§Gaps), and the D1↔D2 tension.
