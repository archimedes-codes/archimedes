---
status: accepted
date: 2026-11-24
superseded-by:
---

# An auto-chain's bounds are judged in **Rust**, and a tripped bound closes the **run** and never reconfigures the **column**

A **Stage** column can now be flagged `auto`, which means *when the **Session** launched on entering
this column settles, move the card to the column this one points at and launch that column's
**Skill*** — Skill A → Skill B → Skill C, each link carrying the entered column's Skill and its own
extra prompt. That is an **unattended chain of LLM Sessions**, so it is an unbounded spend risk, and
the branch that shipped it had to settle nine questions a future contributor will otherwise reverse.
This file records the nine, because the roadmap and the plan that argued them are deleted on ship and
this is what survives them.

Nothing here cites a commit hash. `docs/agents/repo-gotchas.md` records why: the squash-merge
convention makes every per-issue commit on a branch unreachable the moment the branch is deleted, so
in durable prose the citation is the **PR number** or — better, because it cannot be orphaned at all —
the **file, the symbol and the test name**. All three of those survive a squash; the PR number for
this branch was not yet known when this file was written, so the citations below are to the tree.

## 1. A new **column** on a table an existing database already holds is `gate()` territory; a new **table** never is

`gate` is a transaction factory whose probe is
`SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2`, so it can fire exactly once because a
column stops being missing. It therefore has **no use** for a table: `SCHEMA` is one
`execute_batch` of `CREATE TABLE IF NOT EXISTS`, already idempotent on re-open. This branch moved the
gate count **13 → 15 → 17** and added a **table** with no gate, and both halves are pinned by
`the_three_task_tables_are_in_schema_and_have_no_gate_entry` — which lists the five board tables that
must appear in `SCHEMA` exactly once, asserts **no** `gate(&mut conn, "…")` names `tasks`,
`task_sessions`, `task_artifacts` or `workflow_runs`, and asserts the source-text count of
`gate(&mut conn, ` is **17**.

**The temptation this exists to block is the reverse edit.** A reader who sees `stages.auto` gated and
`workflow_runs` not will "restore symmetry" by adding a gate for the new table. That is not tidiness,
it is a lie in the migration list — the table has no pre-existing shape to repair — and it breaks the
sibling pin's fixtures, which is the second half of the same rule. The pin's own doc says the narrowing
is deliberate: `stages` and `spaces` are the two tables that pre-date the Stage-config work with an
older shape, so gating a new column onto each is *what the factory is for*, and "a ban on gating a
board table" would be banning the migration itself.

**`spaces.auto_max_steps` and `spaces.auto_ceiling_usd` carry no SQL `DEFAULT`, on purpose.** `NULL`
means *"this Space never configured a guard, so the shipped fallback governs"*; `0` means *"no
auto-chaining"* and `0.0` means *"no spend"*, and both are values a person may legitimately choose. A
`DEFAULT 0` would migrate every existing Space into a bound nobody set — ADR 0082's phantom-`$0.00`
argument, one table over and pointed at the thing the column exists to bound — and a `DEFAULT` large
enough to be harmless would be indistinguishable from a real setting, which is the other half of the
same collapse. Both `dflt_value`s are pinned to `NULL` **directly** by
`the_auto_max_steps_gate_arrives_null_on_a_preexisting_space` and
`the_auto_ceiling_usd_gate_arrives_null_on_a_preexisting_space`, because the `None` assertions alone
would pass under a `DEFAULT` someone later "improves". `stages.prompt_prefix` is the same argument one
field smaller: no `DEFAULT`, because `DEFAULT ''` would migrate every column to *"an empty extra
prompt"* — a second spelling of *"nothing"*, one the launch path would special-case forever.
`stages.auto` by contrast is `INTEGER NOT NULL DEFAULT 0`, and that asymmetry is a decision too: a
two-valued flag has no third state for a `NULL` to mean, and a flag that arrived **ON** would start
moving cards in a workflow whose owner never asked for it.

**ADR 0107 is not a migration ADR and is cited for one sentence only** — it is the deleted-**Skill**
ADR, and the sentence worth keeping from it is *"Every one-time migration in `storage/db.rs` is a
`gate()` on a MISSING COLUMN … A `DELETE FROM stages WHERE slug = 'discuss'` has no column to latch
on."* That is the mechanism this section generalises. The storage rulings themselves are ADR 0090
(`space_path`, no FK, lazy seeding) and ADR 0099 (the graph and its three states).

**Adding a gated column forces every pre-existing fixture of that table to gain it, and that is the
point.** `each_cluster_schema_omits_exactly_one_gated_column` walks thirteen `SCHEMA_WITHOUT_*`
fixtures and asserts each omits **EXACTLY ONE** gated column out of the seventeen, so a fixture that
quietly loses a second one stops being a test of its own gate — its sibling gate fires inside it and
the test measures something nobody intended. The fixture set therefore grew in lockstep with the
gates, 9 → 11 → 13, and both new children hit the rule live: `stages`' two existing fixtures had to
gain **both** `auto` and `prompt_prefix` or each would have omitted two, and the first draft of
`legacy_spaces_without_auto_ceiling_usd` dropped `board_strict` alongside its own column and reddened
the isolation assert naming both — before any production code existed. If you add an 18th gate, the
count arm and the fixture array move together, in one commit.

## 2. The guard decision lives in **Rust**, inside the step verb, and crosses the wire as a **verdict**

`Db::workflow_run_step` returns `AdvanceVerdict { run, advance, stop, max_steps, ceiling_usd }`. It
used to return a `WorkflowRunRow` and left *"is this chain over budget?"* to its caller.

**Why not in TypeScript:** the two numbers the question needs are
`DEFAULT_AUTO_MAX_STEPS = 20` and `DEFAULT_AUTO_CEILING_USD = 10.0`, declared in
`src-tauri/src/storage/db/auto_guards.rs` and Rust-only **on purpose** — the TypeScript mirror names them
in prose rather than copying them, because a number copied into a mirror is a number one refactor from
drifting, and the drift is a chain that runs past a bound a person set. So the judgement is made
beside the constants it reads and crosses as a verdict the settle-handler obeys.
`store/workflowChain.ts` states its own side of the bargain: `verdict.advance` is the only field it
branches on and it never overrules it.

> **Where the split left these two halves, stated because this paragraph predates it.** The workflow
> subject was later split by subject into `db/auto_guards.rs` and `db/workflow_runs.rs`, so the
> constants are **declared** in `auto_guards.rs` and **compared** inside `Db::workflow_run_step` in
> `workflow_runs.rs`, one `use super::auto_guards::{…}` apart and re-exported from `db/mod.rs`. "Beside
> the constants it reads" therefore means *in the same Rust module, reached by one import* — it has
> never meant *the same file*, and the reason the sentence gives for it is untouched: there is still
> exactly **one** declaration of each number in the tree and no second copy on the TypeScript side,
> which is the drift this ruling exists to prevent. Verify that, not the file layout:
> `grep -rn 'pub const DEFAULT_AUTO_' src-tauri/src` reads **two** hits, both in `auto_guards.rs`.

**Why the two effective bounds ride on the verdict** — and this is the half a refactor drops first:
the caller cannot derive them, because it does not know the fallbacks. A verdict that said only *"no"*
would leave the handler unable to write a true sentence — *"this chain hit its 20-step bound"* rather
than *"this chain stopped"* — so it would be silent or lying. `max_steps` is `i64` and never `None`:
an unset Space is **bounded**, not unlimited.

**The temptation recorded here is the "simplification"**: restoring the verb's `WorkflowRunRow` return
and moving the comparison to the caller, because the caller is the thing that wants the answer. It is
wrong twice. First, it puts a policy constant on both sides of a wire. Second, the guard read is inside
the **same lock** the verb's read-write pair already holds, and a caller-side comparison cannot be —
it would measure the step against a bound that was not in force when the step was taken. That is the
same TOCTOU the verb argues about for its spend counter, and it is why `auto_guards` keeps its public
signature and delegates its read to a private `auto_guards_on(&Connection, …)`: the connection mutex is
**not reentrant**, so a verb that called the public one while holding the guard would deadlock rather
than read. Pinned by `the_verdict_reads_the_guards_through_the_canonical_space_key` (a raw-string read
would let a Space bounded to ONE step chain twenty while its editor showed "1") and by
`an_unset_space_gets_the_shipped_fallback_bounds_on_the_verdict` (a `COALESCE(max_steps, 0)` or
`unwrap_or(0)` switches auto-chaining off for every Space whose owner never opened the editor).

Two choices the contract left open, decided and pinned so a refactor cannot silently invert them: when
one step trips **both** bounds the verdict reports `cost_ceiling` (the audited fact beats the plan, and
it is the one implying a different fix), and the step that trips a bound is **written before** the
verdict refuses the next launch, so a run's `steps` is the chain's length and not its length minus one
(`the_step_that_trips_the_bound_is_written_before_the_verdict_refuses_the_next_one`).

## 3. A tripped bound closes the **run**; it never flips `stages.auto` off

`stages.auto` is the configuration for **every card in that Space**. One card hitting its 20-step bound
must not silently reconfigure everyone's board, with no UI hint that the column had stopped being
automatic. `workflow_runs.stop_reason` carries *why*, and `addSystemLine` — the house answer for a
thing the user must see that has no other surface — puts that sentence in the transcript that just
ended. Configuration stays as configured — `store/workflowChain.ts`'s own header section is titled
**"What a tripped bound does NOT do"** and says it in those words. The written plan for this branch had
the bound flip the flag off instead, and the divergence was checked against the tree rather than the plan
and recorded as such; the plan is deleted on ship, which is why the ruling is here.

**`ChainStop` is ONE vocabulary, shared by the verdict and the `stop_reason` column**, so a person
reading a closed chain's reason can match it to the bound that produced it, and
`the_chain_stop_spellings_are_frozen` pins all four spellings. Two of its four variants —
`no_next_stage` and `launch_refused` — have **no producer in Rust at all**, and that is deliberate
rather than dead code: the Db cannot see the board slice, so it cannot know a column had no next
column, and it cannot know whether the launch the handler attempted was refused. Those two are emitted
only by the TypeScript settle-handler, which passes them to `workflow_run_close`. An enum variant no
producer emits is the half of a vocabulary owned by the other side of the wire; a reader who "cleans
it up" into a TS-only union creates two lists spelling one event, which is exactly what the shared
enum exists to prevent. `#[serde(rename_all = "snake_case")]` makes the wire form and `as_str()` one
spelling rather than two that happen to agree.

**One correction a reader needs before trusting the column.** `stop_reason` is **wider** than
`ChainStop`. The chain also writes a plain `StopReason` verbatim (`"cancelled"`, `"max_tokens"`,
`"max_turn_requests"`, `"refusal"`) when a turn that ends is not a finish, and `"manual"` when the card
moved into a column that is not `auto` — because a run left OPEN would hand this chain's step count and
running cost to the NEXT chain the card ever starts, and a person who set a 20-step bound would silently
get a shorter one. The four `ChainStop` spellings are the **bound** vocabulary; the column is the
**narrative** field, and nothing constrains it to the enum.

**The complete vocabulary is therefore three sources, and `ChainStop::as_str()` is the only place any of
it is spelled out — cite that symbol, do not retype the list.** The four bound words come from
`ChainStop::as_str()`; `"manual"` is the settle-handler's own word for *"a person's column took over"*;
and everything else the column holds is a `StopReason` variant name verbatim, as `WorkflowSettle.reason`
arrives it. Prose elsewhere in this repo that retyped the list instead of citing the symbol drifted
exactly as one would expect: four sites documented the column as taking `"steps"`, `"ceiling"`,
`"manual"`, …, and **no producer anywhere emits `"steps"` or `"ceiling"`** — each is one letter-group
from a real spelling (`max_steps`, `cost_ceiling`) and neither appears in `as_str()`, in the settle
handler, or in `the_chain_stop_spellings_are_frozen`. Those four sites are code comments and are
corrected separately; they are named here so that a reader who finds one again knows which side is
wrong. **This is the failure mode §3's "ONE vocabulary" ruling exists to prevent, reproduced in a
doc comment**: a second list spelling one event, discovered only by grepping for a producer.

## 4. A `NULL` cost can never trip the USD ceiling, and that limitation is **pinned rather than fixed**

`NULL + x` is `NULL` in SQL. So `workflow_run_step`'s update arm spells
`cost_usd = COALESCE(cost_usd, 0.0) + ?` and its insert arm spells the delta **verbatim** — a `None`
delta does not mention the column at all. A plain `cost_usd = cost_usd + ?` would freeze the counter at
`NULL` forever the moment a chain's first step reported no figure, and a chain that opened unbilled
would open a phantom `0.0` instead of the honest `NULL`.

**And the consequence is that the ceiling cannot see such a chain.** The comparison runs against
`run.cost_usd`, `NULL >= ceiling` is never true, so **an unbilled chain looks free** — under a `$0.00`
ceiling, which is the sharpest form and exactly what the pin configures.
`a_chain_that_never_reports_a_cost_cannot_trip_the_ceiling` asserts the chain does **not** stop, four
steps, and that `ceiling_usd` on the verdict still reports the ceiling so the caller can say
*"unbounded by this guard"* instead of implying it is safe. The same test then reports a real `0.0` on
the fifth step and asserts it **does** trip, because a reported zero is a figure and a zero ceiling
means "no spend" — which is what makes the pin non-vacuous.

**This test looks like it documents a bug. It must not be "corrected".** Reading `NULL` as `0.0` would
be worse in the direction that matters: it would make a chain that reported nothing look like a chain
that spent nothing, i.e. a guard that **fails open**. The honest alternative was already ruled at the
layer above — ADR 0082 decided that an unknown price renders as nothing and never `$0.00`, and its own
`a_null_cost_and_a_real_zero_are_different` is the precedent this inherits — so the step bound is what
actually stops an unbilled chain, `ceiling_usd` is the field that lets the caller say so, and the
editor's caption says it out loud rather than advertising a guard stronger than it is.

**Be careful with the sentence this decision is often given.** *"a ceiling built on `cost_usd` must
distinguish NULL/0.0, or it will treat an unbilled chain as free"* is quoted in
`AdvanceVerdict::ceiling_usd` as **verbatim from the plan**, and the plan is deleted on ship. It is
**not a quotation from ADR 0082** and must not be attributed to it — grep 0082 for it and you will find
nothing. What 0082 actually rules is `NULL` ≠ `0.0` at the parser, the store, the renderer and the
stored column; the ceiling consequence is this branch's application of that rule, and it is stated here
in its own words.

## 5. The hook is the **settle point inside `sendLaunchMessage`**, not a global settled-watcher — and the chain never `await`s the next launch

`store/taskLaunch.ts`'s `sendLaunchMessage` `await`s `sendPrompt`, gets the settle **reason** back, and
its arguments already carry the Space, the card and the **column that was launched**. That is the settle
edge and it is exact. Two reasons, both measured:

- **A watcher reading the board slice silently no-ops.** At the base of this branch,
  `store/tasks.ts`'s `load` had **exactly one** production call site — `TasksBoard`'s mount effect — so
  the slice exists only while the board is mounted, and an unattended chain is precisely the case where
  it is not. A slice-reading settled-watcher would look configured and do nothing, which is the worst
  failure mode an automation can have. (`WorkflowsCanvas` is now a second `load` site, which is why the
  claim is dated rather than permanent, and the canvas had to load its own store for the same reason.)
- **The identity is already standing at that call site.** `launchedSlug` is `destination.slug` — the
  column launched — and not the card's stored stage, which a launch moves before the settle fires. A
  watcher would have to reconstruct that; the caller is holding it.

**And the chain must never `await` the next launch.** `sendPrompt` resolves on `agent_settled`; the
merged `research` Skill ends a turn on an `ask` gate; `AskQuestionCard` renders only under
`ChatStream` (via `MessageList` / `chat/TranscriptFooter`); and `App`'s view ternary renders the
board or the canvas **instead of** `ChatStream`. So the turn waits on a gate that has no renderer, and
the gate cannot appear until the turn ends to let the view switch. That is a **deadlock, not latency**.
Both halves are `void`: the caller `void`s the chain, and the chain `void`s the next launch.

**The suite cannot catch this, which is why there is now a test that can.** Every `sendPrompt` mock in
this repo resolves immediately, so a suite built on resolving mocks cannot tell `void` from `await` —
the pre-existing pins for "leaves the board view" passed while the feature did not. So `launch` is an
**argument** of `WorkflowSettle` rather than a direct import (which also removes a store↔store runtime
cycle, leaving only a type edge `verbatimModuleSyntax` compiles to nothing), and
`returns while the next launch has not resolved` in `src/store/workflowChain.test.ts` hands the runtime
a promise that never resolves and asserts the settle returned anyway. It reddens by **timing out**
against the 20 s `testTimeout` in `vite.config.ts` — the only case in the suite that distinguishes
`void` from `await`. Do not convert it to a resolved mock to make it faster.

## 6. A move is a move: the chain drives the **full `moveTask` verb**, not a bypass

The plan said to call `Db::move_task` directly, to skip the destination's `on_enter` boost. Wrong, and
wrong for a reason that is easy to miss: **`on_enter` has no production writer at all.**
`grep -rn "UPDATE stages SET on_enter = " src-tauri/src` returns two statements and both are inside
`storage/db/tests/`, and the DDL's `DEFAULT 'none'` is the only writer in the shipped app — so there
was **no boost to skip**, and taking the bypass would have bought nothing while adding a third meaning
of "a move" to a repo that already files the disagreement as a known gap: `docs/features/task-board-known-gaps.md`
§2 item 1 records that a model's `move_task` never fires a compaction and never runs a launch, while a
human's drag does both, and that "the two verbs disagree about what a move means". A third verb would
deepen the gap it cites.

So the chain goes through `launchTaskSession`, whose move **is** the human's drag: `useTasks.moveTask`
with the optimistic paint, the whole-slice re-derivation and the revert-into-`error`, and the
`spaces.board_strict` gate that sits inside `Db::move_task` — a chain must not be able to walk a card
through an edge a person dragging the same card would be refused. It also refuses two different ways
(throws for a Skill the catalog lacks, answers `{ sessionId: null }` when its in-flight guard trips) and
`finishLink` handles both, because the guard trip is a **return**, not a throw: a `try`/`catch` alone
would call a refusal a success.

## 7. The canvas is **read-only**, the **Stage editor** dialog is the sole owner of the Stage fields, and the two next-step functions stay **two**

The plan specified a side panel editing label / Skill / extra prompt / Auto / destinations / order —
**six fields, and the sentence this section used to carry ("all eight already existed in `StageEditor`")
was wrong twice over: the plan's list holds six, not eight, and two of the six did not exist before this
branch.** The honest arithmetic, field by field: of the six the plan named, **four already existed** —
label, Skill, destinations and order — and **`auto` and the extra prompt are this branch's own two
additions to that same dialog, which is why they landed there and not on the canvas.** (A fifth thing
already existed that the plan's list omits: the row's delete affordance. It is a verb on the row, not a
field the panel was proposed to edit, so it does not change the count above.) Everything a row does
lives in `stages/StageRow` and `stages/StageDestinations`, and it is those two files the count is read
from. The measurement, stated so it survives the squash rather than asking a later reader to re-run it
against a `main` that will have moved past it: at the base of this branch `StageRow.tsx` carried **seven**
`aria-label`s (label, Skill, move up, move down, the destinations `Select`, and the delete/cancel-delete
pair) and the string `auto` did not occur in the file at all; at this tip it carries **nine**, and the two
additions are exactly `Auto-advance cards launched in …` and `Extra prompt for …`. The symbol-level
evidence outlives the command: `stages.auto` and `stages.prompt_prefix` are this branch's two `gate()`
calls (§1), and `set_stage_auto` / `set_stage_prompt_prefix` are two of the seven commands it registers.
A reader counting controls rather than fields gets a third number and should not reconcile it: the
dialog's **footer** holds `stages/AddStageField`, `stages/StrictWorkflowToggle` and — new here —
`stages/AutoChainGuards`, and all three are per-**Space** subjects, not fields of a **Stage**.
**The ruling is unaffected by the arithmetic** — one owner per field is the whole reason, and it holds
at six fields exactly as it would at eight.

One owner per fact won: `WorkflowsCanvas` mounts that same dialog from its
own flag on a node click and adds no form, and `nodesConnectable={false}` (with `deleteKeyCode={null}`
and `edgesFocusable={false}`) makes the read-only decision mechanical rather than a convention. A second
editor would be a second owner of every one of those fields, and a drag-to-connect would be a third
write path for edges the destination editor already owns — plus a keyboard route for a drag, which this
repo does not have. What the canvas owns instead is what a kanban structurally cannot show: which columns are
automatic, where the edges actually go, and **where a chain dead-ends** — on a board, a column with no
destination looks exactly like a column with one.

**`nextStepSlugs` and `nextStepOf` are deliberately two functions**, and the disagreement between them
is **preserved, not unified**. `lib/workflowGraph.ts` is the extraction `TasksBoard.tsx`'s own comment
named ("if a third surface grows the same need, that helper is the extraction to make"); the chain is
that third surface. It hoists the **derivation** and not the **verdicts**:

- `nextStepSlugs` **reports** an edge naming a slug the loaded columns cannot resolve. That is the
  detail modal's rule — `TaskDetailDialog` **keeps** such an edge, labels it with the raw slug ("we
  could not name it" is a different claim from "it has no column"), and the click lands on
  `store/taskLaunch`'s skipped-column NOTE, the only surface that explains a stale read. Dropping the
  edge would delete a working button and strand that note with no path to a user.
- `nextStepOf` **yields nothing** for the same edge. That is the launch pill's rule (`TasksBoard`, and
  the chain): a pill has no note to fall back on, so it would be a control whose click moves nothing
  while the sentence explaining why sits on a different surface.

The canvas reads `nextStepSlugs` and draws a **ghost node** for the unresolvable slug, because an edge
to a node id that does not exist renders nothing at all and a stale destination would be invisible
rather than merely unclickable. Both components' suites pass **unchanged** across the extraction — that
is the proof the behaviour did not move, and it is also the proof the two verdicts survived it. Hoisting
a derivation is not the same as merging two verdicts, and the disagreement predates the file.

## 8. The **fourth view arm** must be spelled out, and `sheetMounted` stays `=== "workspace"`

`App`'s content area is a ternary whose **else-branch is the workspace**. Widen the `AppView` union
without adding an arm and `"workflows"` renders the chat column and the Side pane: a green build, a
passing smoke test, and no new view. `App.workflows.test.tsx`'s first case pins **both halves** — the
canvas IS on screen (with its nodes and its fallback edge) **and** `ChatStream`'s `composer-island` is
NOT — because asserting only "my surface is absent" is equally true of a click that never changed the
view, which is how a routing pin goes vacuous while still reading green. One half alone is the
decoration this repo refuses; the `"board"` arm was spelled out for the identical reason and carries
the same two-half shape.

The workspace stays the implicit `else` rather than becoming an explicit fifth arm, and that is the
other half of this decision: naming it would make the union exhaustive-checkable, and it would cost the
one property that makes the trap survivable — with an explicit workspace arm, an unknown value renders
**nothing**, so a widened union becomes a blank window instead of a familiar-looking screen that a test
can catch. The pins are per-arm and they are the mechanism; the type is not.

`sheetMounted={view === "workspace"}` **stays an equality**, not `view !== "settings"`. The plan said
the latter and it is wrong for the board and wrong for the canvas alike: `SubagentDetailHost` is the
sheet's only render site and it lives in the else-branch, so any non-workspace arm unmounts the sheet,
and a "not Settings" spelling would report a sheet that is not painted — the gate overlay would slide
480px left and cap its width for a phantom sheet, reintroducing on a new view the exact defect the prop
was introduced to stop. `App.test.tsx`'s "the gate panel does NOT dodge a sheet the board view
unmounted" case is the pin, and the equality form needs **no edit** when a fifth view arrives, which is
the property worth keeping.

## 9. `@xyflow/react` and `@dagrejs/dagre` are in `dependencies`, `shiki` is a misclassification this branch did **not** copy, and **n8n was never an option**

Both canvas packages **runtime-import** into the shipped bundle (`<ReactFlow>` renders, `dagre` assigns
the ranks), so `dependencies` is where they belong; both are **MIT** (`@xyflow/react` 13.0.3,
`@dagrejs/dagre` 3.1.3, verified from each installed `package.json`). `package.json`'s `//deps` key says
this and names the trap in the same breath: **`shiki` sits in `devDependencies` while
`AgentMarkdown.tsx` and `CodemodeCard.tsx` runtime-import it**, which is a pre-existing
misclassification and explicitly **not** the precedent to copy. It is filed as a known gap in
`docs/features/task-board-known-gaps.md` §9 and **deliberately not fixed here** — moving a runtime
dependency between the two sections is a packaging change with its own blast radius, and doing it inside
a feature branch confuses two theses.

**The licensing answer that settled the original question, recorded because the question will come
back:** the inspiration was an n8n-style canvas, and **n8n's code is unusable here**. n8n is not MIT —
it is the **Sustainable Use License v1.0** (`LICENSE.md` in `n8n-io/n8n`), whose Limitations clause
permits use "only for your own internal business purposes or for non-commercial or personal use", and
whose own License FAQ (`docs.n8n.io` → Community license → License FAQ, read 2026-11-24) lists under
*What you cannot do*: **"Allow external end users to build or configure their own workflows through your
product, whether via a custom UI, our API, MCP, or an AI agent acting on the user's behalf."** This
product is a desktop app whose users configure their own per-Space workflow graph. That is the forbidden
shape, and the FAQ's "SaaS platform with embedded workflow builder" example rules it explicitly: *"The
custom UI layer does not change the nature of the use … The SUL test is not about UI visibility — it is
about who controls the workflow logic."* So **the concepts and the shape were borrowed and no code
was**, and `pnpm-lock.yaml` carries no n8n package. The only place the tree names n8n is
`workflowGraphLayout.ts`, and only as a description of the layout job dagre does.

## Considered options

- **Judge the bounds in TypeScript** (the plan's shape) — rejected: the fallback constants are
  Rust-only on purpose, and a policy number duplicated across a wire is one refactor from a chain that
  runs past a bound a person set.
- **Return the row and let the caller compare** — rejected with the same argument, plus the lock: a
  caller-side comparison cannot be inside the verb's read-write pair and so measures a stale bound.
- **Flip `stages.auto` off when a bound trips** (the plan) — rejected: one card would reconfigure every
  card in the Space, silently, and the column would stop looking automatic with no signal.
- **Treat a `NULL` cost as `0.0` so the ceiling "works"** — rejected: it converts "we cannot see this
  chain" into "this chain spent nothing", i.e. a guard that fails open while reading as a guard that
  works. The pinned limitation is the honest state; the pinned `ceiling_usd` is what makes it sayable.
- **A global settled-watcher on the sessions store** — rejected: the board slice it would read is
  populated only while the board is mounted, so it no-ops exactly when the automation matters.
- **`Db::move_task` directly, to skip the `on_enter` boost** — rejected: the boost has no production
  writer to skip, and a third meaning of "move" deepens a gap the repo already files.
- **A canvas side panel editing the Stage fields the plan listed** (the plan) — rejected: every field
  in that list would then have two owners, and `StageEditor` already owned four of the six before this
  branch added the other two (§7 has the measured count, the two additions, and the arithmetic the
  sentence this bullet replaces got wrong).
- **One next-step function, picking the modal's verdict or the pill's** — rejected: either choice
  deletes a working affordance or adds a control whose click does nothing, and the disagreement is the
  two surfaces' own.
- **`view !== "settings"` for `sheetMounted`** (the plan) — rejected, measured: it dodges a sheet that
  is not painted.
- **Vendor or fork an n8n-style engine** — not available under the Sustainable Use License, above.

## Consequences

- **`docs/features/task-board-known-gaps.md` is amended, not trimmed.** §8 (`next_slugs` can never be
  un-configured) is **still open** — `Db::set_stage_next` still takes a plain `&[String]` — but the
  **fix shape is now in the repo three times over**: `Db::set_stage_prompt_prefix` and both parameters
  of `Db::set_auto_guards` take `Option` precisely so they are clearable, following
  `Db::set_stage_skill`. §3's "`on_enter` has no writer" fact is **still true and is now load-bearing**
  for §6 of this ADR rather than merely harmless. Three new gaps are filed as §9: the **`ask`-gate
  stall**, the **`shiki` devDependency misclassification**, and the **`workflow_runs` row with no
  reaper** (§9c) — the third is a consequence of the paragraph above, not of the revert.
- **The `ask`-gate stall is now load-bearing, and it is not fixed here.** A chain whose Skill ends its
  turn on an unanswered `ask` gate **stalls forever**: `sendPrompt` never resolves, so the settle edge
  never fires and the next link never launches, while the card sits in a column that says it is
  automatic. The defect is pre-existing — `App`'s view ternary has always given the gate no renderer
  outside `ChatStream`, and a human-launched `research` Session has always had it — but before this
  branch nothing *depended* on the settle in order to continue, so it was a stuck transcript rather than
  a broken automation. Fixing it means rendering the gate across views, which is a separate feature.
- **A chain that settles where the board was never mounted does not advance, and says nothing.** The
  runtime reads the column out of the board slice; an unloaded slice answers "not automatic", which is
  the conservative answer (a column it cannot read is a column nobody told it anything about, and
  inventing one is a card that moves on its own). It stays silent for the same reason: a sentence about
  a graph this window never read would be a claim about rows it did not read. Reaching the case
  properly means fetching the board on the settle path, which is a decision about **who owns the board
  slice** and does not belong in a settle handler.
- **`workflow_runs` has no store action, by decision.** A run record belongs to no column, no component
  reads it, and it moves per step rather than per person; a store action would put a per-step counter in
  the slice that renders a board and make that slice a second owner of a fact the database owns. The
  runtime calls the wrappers directly. The earlier pin that the run verbs were *not* commands was
  deleted rather than left as a stale comment, because a table nothing can write is a guard nothing can
  enforce.
- **`costDeltaUsd` is a delta and must stay one.** `costUsdOf` answers a running **total** and
  `workflow_run_step` **adds**, so a total handed to it sums the totals and fires the ceiling early.
  `sendLaunchMessage` snapshots the figure before the turn — it is the only place standing at the front
  of one — and `costDeltaOf` subtracts, floors at 0, and returns `null` (never `0`) when nothing was
  reported, so an unbilled chain cannot trip its ceiling from this side either.
- **The gate count and the fixture array move together, in one commit**, and so do the counts inside
  `the_three_task_tables_are_in_schema_and_have_no_gate_entry`'s own doc. This branch moved the gate
  count 13 → 17 and the `SCHEMA_WITHOUT_*` fixtures 9 → 13; an 18th gate that updates only one of the
  three reddens a pin, which is the intended outcome, not a pin to widen.
- **Reverting this branch is safe, and none of that safety was written down until now.** Four things
  make it so, each verified against the tree rather than assumed: the four gated columns
  (`stages.auto`, `stages.prompt_prefix`, `spaces.auto_max_steps`, `spaces.auto_ceiling_usd`) arrive
  through `gate()`, which probes `pragma_table_info` and `ALTER`s. **Nothing drops any of these four
  columns** — the one `ALTER TABLE … DROP COLUMN` in the tree is the one-time
  `sessions.agent_id` migration, which is gated on `pragma_table_info('sessions')`, targets a column
  this branch never touched, and cannot run against any of the four — so a reverted build opens a
  database that still carries them, present and inert. That is
  only survivable because the load-bearing half holds too: `STAGE_COLUMNS` and `SPACE_COLUMNS` are
  **explicit** column lists, `grep 'SELECT \*'` over `src-tauri/src` reads **zero** hits at all, and
  every production `INSERT INTO` names its columns — including the `workflow_runs` insert, whose list
  is line-continued and therefore invisible to a naive one-line grep. Note what makes the guard pair
  safe, since it is **not** `SPACE_COLUMNS`: that const is `["path", "created_at",
  "last_opened_at", "trusted"]` and carries neither guard column, because the guards are read by
  their own two-name `SELECT auto_max_steps, auto_ceiling_usd` inside `Db::auto_guards_on`
  (`db/auto_guards.rs`) and written by a two-name `UPDATE`. Both are explicit, so the rule holds for
  them by the same argument rather than the one this bullet first made. There is consequently **no
  positional read and no positional write for a fifth column to break**, which is this repo's own
  drift-guard discipline (`stage_row_from_maps_the_select_const_columns_in_order` and its siblings per
  row type) paying for itself on a path nobody wrote a test for. `workflow_runs` survives as an orphan
  table, and reverting `lib.rs`'s `generate_handler!` entries removes the **seven** commands this
  branch registered (`set_stage_auto`, `set_stage_prompt_prefix`, the `get_auto_guards` /
  `set_auto_guards` pair, and the three run-record verbs) together with their TypeScript callers, in the
  same revert, so no caller is left invoking nothing. And a database whose
  `stages.auto` is `1`: nothing reads the column after the revert, so **cards simply stop
  auto-advancing** — which is the correct rollback semantic, not a silent one; the configuration is
  preserved so a re-land resumes where the person left it.
- **The one rollback hazard is the same hazard §9 files, and it is not solved by reverting.** After a
  revert the `workflow_runs` rows are orphaned *and there is still no deleter* — see
  `docs/features/task-board-known-gaps.md` §9c. `delete_space` is `DELETE FROM spaces WHERE path = ?1`
  and nothing else, and no `gate()` or migration drops a table, so those rows outlive both the code
  that wrote them and the code that could have removed them, and **no future version can collect them
  either** without a retention verb nobody has written. Reverting therefore costs a table that cannot
  shrink, and re-landing costs it again. **The boot-time sweep is not the deleter this needs and must
  not be read as one:** it stamps `finished_at` and `stop_reason` on open rows and never removes one,
  so `grep 'DELETE FROM workflow_runs'` over `src-tauri/src` still reads **zero** hits with the sweep in
  the tree. It repairs a run's *state*; §9c is about a row's *existence*.
- **The fallbacks are a shipped default, not an unlimited sentinel, and they are not a measurement.**
  20 steps and $10.00 are argued in `db/auto_guards.rs` (the doc comment on each constant, which
  names the shipped board's five columns) from `DEFAULT_STAGES` — which lives in `db/stages.rs` —
  and from what a legitimate multi-hop chain costs; they are **not** derived from
  observed traffic on this deployment. ADR 0116 is the cautionary precedent for a bound sized from the
  wrong distribution and justified by an upstream band nobody verified — do not re-justify these two
  numbers that way, and if they are ever re-sized, size them from `workflow_runs` rows, which is the
  table this branch added so that a chain is finally countable.
