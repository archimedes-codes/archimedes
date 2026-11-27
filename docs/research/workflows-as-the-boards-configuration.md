---
status: current
last-verified: 2026-11-23
verified-by: web research — 7 angles, 6 sources read as primary code/spec/licence text plus 3 local grounding passes, 2026-11-23; every local claim re-measured at HEAD f1102039 in the primary checkout
task: tsk_0ad5c061-9feb-4924-a2cb-2ff16a95c1c8
---

# Workflows as the board's configuration

**The settled question.** Can the Task board's Stage configuration become a workflow graph — where a
**Stage transition** is a trigger that runs a chain of **steps** (**Skill** launches, and steps that need
no LLM), editable in an n8n-style canvas behind a new **Workflows** door in the **Session list** — while
**Tasks**, **Stages**, and **Stage transitions** stay per-**Space** SQLite rows (ADR 0090 / ADR 0099) and
the seven model-facing verbs stay unchanged?

Owner's framing, verbatim: *"a transition is a TRIGGER that runs STEPS (launch a Skill, compact, notify,
call something), not just an allowed destination… It gets a new button above tasks in the sidebar
'Workflows'… the goal is that we can link skills to each other like in N8N style.. so skill A -> B -> C
etc.. can have steps that dont require a LLM"*; and *"kanban cols are just the skills linked to each other
in the workflow"*. Scope as agreed: the board's **behaviour** may change; **storage and verbs stay**.

This is evidence, not a design. Nothing here is approved and no plan is written by this document.

## Executive Summary

1. **The premise is already half-shipped, and ADR 0099 pre-named this exact change.** A **Stage** already
   carries `on_enter_skill` (the **Skill** a launch loads) and `next_slugs` (its outgoing edges). ADR 0099
   rejected a `stage_transitions` edge table *for now* and recorded that it "is the shape to reach for the
   moment an edge needs to carry anything." This proposal is that moment.
2. **Licensing settles the n8n question before architecture does.** n8n is not open source — Sustainable
   Use License — and its FAQ forbids this exact shape: *"Allow external end users to build or configure
   their own workflows through your product, whether via a custom UI, our API, MCP, or an AI agent acting
   on the user's behalf."* No vendoring, no embedding. The concepts and the JSON format are not claimed by
   the text either — but that is **silence, not permission**, and it is recorded as a gap below.
3. **The canvas is the cheapest part and the least supported by prior art.** `@xyflow/react` is MIT,
   React 19-ready, and needs zustand 5, which this app already has. Every product where a *non-developer*
   expresses "when a card moves to X, do Y" uses a **list builder**, not a canvas; the graph-shaped systems
   keep the graph in **code** and offer a read-only live diagram.
4. **The expensive part is the runtime, and four structural blockers stand between a step and a running
   Session.** The sharpest: *awaiting a launch deadlocks today*, by a mechanism documented in the source,
   and a step chain is nothing but awaited launches.
5. **One risk has no answer anywhere in this repo.** Every surveyed system caps runaway agent spend
   *outside* the graph (ACUs, credits, `cost_limit`, a pre-node budget check). This app tracks per-Session
   USD and enforces nothing. A chain multiplies an unbounded quantity.
6. **No framework surveyed schedules a `SKILL.md` as a workflow step.** Everywhere a **Skill** is a
   context-loading mechanism, not a schedulable node. There is no external playbook for what was asked.

---

## Findings

### F1. What n8n's semantics actually are, and where this model departs from them

n8n's workflow is a `nodes` array plus a `connections` object keyed by **source node _name_**, not id, with
three index levels (`packages/workflow/src/interfaces.ts`, `IConnection` / `NodeInputConnections` /
`IConnections` — <https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/interfaces.ts>):

```
connections[<SOURCE node NAME>]["main"][<source output INDEX>] = [{ node, type, index }] | null
```

- A real fixture, abridged, from
  `packages/cli/test/integration/commands/import-workflows/combined/combined.json`
  (`raw.githubusercontent.com/n8n-io/n8n/master/…`): node fields are `parameters`, `id`, `name`, `type`,
  `typeVersion`, `position`; the top-level minimum a fixture carries is `{name, nodes, connections, pinData}`.
- A **branch** is `outputs: [Main, Main]` + `outputNames: ['true','false']` (`IfV2.node.ts:29-30`), and the
  *array index* is what distinguishes them; an unwired output is `[]` or `null`. Verified against
  `packages/workflow/test/fixtures/WorkflowDataProxy/multiple_outputs_workflow.json`.
- **A wire carries no data and no condition.** `IConnection` has exactly three fields; conditions live in
  the *node's* `parameters.conditions`. Routing is the source node emitting on output index 0 or 1.
- A **trigger** is mechanically `group: ['trigger']` (`node-helpers.ts:1925`); activation refuses a workflow
  with none (`workflow-validation.service.ts:360`).
- **Cycles are legal.** <https://docs.n8n.io/build/flow-logic/loop>: "connect the output of one node to the
  input of a previous node. Add an IF node to check when to stop the loop." A fixture with a real back-edge:
  `packages/nodes-base/nodes/SplitInBatches/test/SplitInBatches.workflow_v2.json`. The structural validator
  (`workflow-structure-validation.ts`) has **no cycle issue code**, and `graph/graph-utils.ts` has no
  topological sort. Termination is the author's responsibility.
- `position: [x, y]` is **not** cosmetic. <https://docs.n8n.io/build/flow-logic/understand-execution-order>:
  v1 orders branches "based on their position on the canvas, from topmost to bottommost."
- Execution: all data between nodes is an array of `{json, binary}` items; nodes "usually run once for each
  item"; `Execute Once` opts out (`INode.executeOnce`, and the Code node's `runOnceForAllItems` /
  `runOnceForEachItem`).

**Where the proposal departs from n8n, and why it matters.** In n8n a node is a step and there are no
columns. The proposal makes the **columns the nodes** — Skill A → B → C *is* the board. That is closer to
"the board **is** the workflow" than to n8n, and it collapses two things n8n keeps apart: the state a person
reads (a **Stage**) and the unit of work (a node). The load-bearing consequence: in n8n one run visits a node
once, whereas a card re-enters a column every time it is dragged there, so a "step" here is a **column entry
event**, not a graph position. n8n has a noun for the difference — *"An execution is a single run of a
workflow"* (<https://docs.n8n.io/build/understand-workflows/understand-executions>) — and this design needs
its own.

**Two n8n mechanisms worth taking, because they answer open gaps here:**

- **Per-step run rows.** n8n is moving from a single `ExecutionData.data` blob holding
  `resultData.runData` keyed by node name to `packages/@n8n/engine/src/database/entities/workflow-step-execution.entity.ts`
  — `execution_id`, `node_id`, run index, indexed `status`, `outputs jsonb`, `output_sources`, `wait_till`,
  `stale_after`. LangGraph (super-step checkpoints + `checkpoint_writes`), CrewAI (`@persist`), Microsoft
  Agent Framework (`FileCheckpointStorage`, "local disk… single-machine workflows that need to survive
  process restarts") and Pydantic AI (`StepPersistence`) all converge on the same local shape. This repo's
  migration mechanism makes it cheap: a new table is one `CREATE TABLE IF NOT EXISTS` in `SCHEMA` and
  **zero** `gate()` calls (ADR 0100, and pinned by `the_three_task_tables_are_in_schema_and_have_no_gate_entry`).
- **Dirty nodes.** <https://docs.n8n.io/build/understand-workflows/understand-executions/understand-dirty-nodes>
  — editing, inserting, deleting or deactivating a node marks its downstream stale, with enumerated
  propagation rules (inside a loop, the loop's first node is dirtied too), and a dirty node "may also be the
  point where a partial execution starts from." That is retry-from-step, and it is a canvas feature.

### F2. Licensing — decisive, and it removes two of the three options

From <https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md> (Sustainable Use License v1.0):

> "You may use or modify the software only for your own internal business purposes or for non-commercial or
> personal use. You may distribute the software or provide it to others only if you do so free of charge for
> non-commercial purposes."

From <https://docs.n8n.io/n8n-community-license/community-license/license-faq>, the cannot-do list, verbatim:

> "Allow external end users to build or configure their own workflows through your product, whether via a
> custom UI, our API, MCP, or an AI agent acting on the user's behalf."
> "Fork n8n's code to launch your own automation product."

and the test, quoted twice on that page:

> "The SUL test is not about UI visibility — it is about who controls the workflow logic and whose commercial
> interests are being served."
> "The test is also medium-neutral: what matters is whether the end user determines the workflow logic, not
> the interface used (UI, n8n API, MCP, or an AI agent acting for the user). Triggering or executing
> pre-built workflows via API or webhooks is fine."

Mapping the four scenarios (a reading of quoted text, **not** legal advice):

| Scenario | Operative text | Reading |
|---|---|---|
| Copy UI/UX ideas, interaction patterns | Nothing in `LICENSE.md` or the FAQ addresses interaction or visual design; the grant/restrictions are about *"the software… including any portion of it"* | **Unaddressed.** Concepts are outside the licence's stated object — but the absence of a permission is not a permission. Recorded as a gap. |
| Copy or vendor its source | "only if you do so free of charge for non-commercial purposes" + FAQ "Fork n8n's code to launch your own automation product" | **Refused.** Vendoring into a distributed product is distribution. |
| Embed n8n as a dependency | The FAQ's own counter-example: "SaaS platform with embedded workflow builder… This is not allowed. The custom UI layer does not change the nature of the use." Plus "Shipping n8n to your customers as part of a paid product comes with extra conditions… once the customer has local access, it's hard to guarantee they can't build workflows." | **Refused for this shape.** The permitted side is n8n as a silent server-side layer "as long as only your backend communicates with n8n, and end users do not access n8n UI or configure n8n workflows." |
| Reimplement the concepts independently | "These terms do not imply any licenses other than those expressly granted"; nothing names the JSON format, `nodes`/`connections`, or trigger/step semantics | **Outside the licence's stated scope**, with the same caveat as row 1. The only residual hooks are the trademark sentence and the notice-preservation clause, which bind code you take, not ideas you do not. |

Notes that bear on the reading: the npm artefacts carry the same licence (`n8n-workflow` →
`"license": "SEE LICENSE IN LICENSE.md"`), so depending on the format library is not an escape; `.ee.` files
are a separate stricter licence (`LICENSE_EE.md`); n8n was Apache-2.0 + Commons Clause until 2022-03-17; and
`n8n-io/n8n-nodes-starter` is MIT. This project's own `package.json` says `"license": "MIT"` (verified) —
a fact about this output, not a shield.

**The clean path is the one n8n itself takes.** Its editor is built on `@vue-flow/core` 1.48.0 (MIT,
Copyright webkid GmbH) whose first-party React sibling is `@xyflow/react`. The graph library is MIT; the
product on top is not.

### F3. The editor — one real option, and the webview risk resolves in this repo's favour

Measured at `latest` on 2026-11-23 (npm registry, GitHub API, bundlephobia, shipped artefacts):

| Option | Licence | React 19 | Weight | Deciding facts |
|---|---|---|---|---|
| **`@xyflow/react` 13.0.2** | MIT | ✅ peer `>=18`; **requires zustand 5** | 261,611 min / **88,356 gzip** | 22.8 M weekly downloads, 39.1 k★, v13 shipped 2026-11-16 |
| `rete` 2.0.6 + `rete-react-plugin` 2.1.2 | MIT | peers list `^19` | ~10.7 k gzip + ~9.7 k | **`styled-components` is a required peer** in a Tailwind app; issue [#716](https://github.com/retejs/rete/issues/716) open since 2024-09-30, "crashes on Safari when a scrollable container is present"; 60 k weekly downloads |
| `@projectstorm/react-diagrams` 7.0.4 | MIT | ❌ | 49,855 gzip | React 19 PR [#1047](https://github.com/projectstorm/react-diagrams/pull/1047) **merged 2025-04-03 and never published**; `react: "^18.2.0"` is a direct **dependency**, not a peer → two-React hazard; 320 open issues, last release 2024-02-15 |
| `gojs` 4.0.5, `tldraw` 5.6.2 | paid / non-FOSS | — | — | excluded on licence |
| `@antv/x6`, `@logicflow/core`, `cytoscape`, `konva` | MIT / Apache-2.0 | — | 2–8.6 MB unpacked | heavier, less React-native |
| `@joint/core` 4.3.4 | **MPL-2.0** | — | 6.3 MB | file-level copyleft, a legal-review item |
| DIY SVG | — | — | — | **no headless substrate exists** — npm search for a headless node-graph primitive returns nothing; `@xyflow/system` 1.0.0 is "the xyflow core system that powers React Flow and Svelte Flow" and is built for *framework adapters*, and its API just took a major version |

Confirmed against this tree: `zustand ^5.0.15`, `react ^19.1.0`, `xyflow` absent from `pnpm-lock.yaml`. So
v13's zustand-5 requirement is a no-op — and v13 deliberately **renamed its store API** (`useStore`/`useStoreApi`
→ `useNodesStore`, `useReactFlowStoreApi`, etc.) "to prevent confusion with the original Zustand hook"
(<https://reactflow.dev/learn/troubleshooting/migrate-to-v13>), so an app already on zustand 5 has no
collision. The historical breakage was always the *dual-copy* case (xyflow issues #5095, #5229).

**The webview question, resolved.** v13 moved its entire stylesheet into `@layer xyflow`, uses `light-dark()`
11 times, and sets `color-scheme: light dark` on `.react-flow` — verified in the shipped `dist/style.css` and
`dist/xy-theme.css`, and absent from v12.9.2. That raised a Linux-webview risk, which was then closed by
reading shipped distro source trees: Debian 13 (trixie) and Ubuntu 24.04 noble-updates ship **WebKitGTK
2.52.6**, Debian 12 **2.50.6**, Fedora 43–45 **2.54.2**, Arch **2.54.3**; and `light-dark()` is parsed
**unconditionally** at 2.50.6 and 2.52.6 (`Source/WebCore/css/parser/CSSPropertyParserConsumer+Color.cpp`:
`case CSSValueLightDark: color = consumeLightDarkFunction(…)` — no feature flag). WebKitGTK's version *is*
the WebKit release (`OptionsGTK.cmake`: `SET_PROJECT_VERSION(2 52 6)`), so there is no crosswalk to guess.
`@layer` and `color-mix()` are present in every version listed. Sources: `sources.debian.org/api/src/webkit2gtk/`,
`packages.ubuntu.com/noble/libwebkit2gtk-4.1-0`, `packages.fedoraproject.org/pkgs/webkitgtk/`,
`archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/`, `webkitgtk.org/news.html`.

Two facts survive that answer:

- **The failure mode is not graceful, and this repo already knows the right guard.** A custom property
  holding an unsupported function is *not* guaranteed-invalid, so **the `var()` fallback never fires**; the
  substitution fails the property's grammar and the declaration becomes invalid-at-computed-value-time,
  landing on the property's **initial** value (MDN: <https://developer.mozilla.org/en/docs/Web/CSS/Guides/Syntax/Error_handling>
  and the `var()` reference — "the declaration is not ignored and the initial or inherited value of the
  property is used instead"). `@layer` changes none of this. This repo's existing precedent is the correct
  one: `docs/features/palettes.md:59` records the `@supports (color:color-mix(in lab, red, red))` guard Vite's
  lightningcss pass emits, with the warning "Grep the *source*, not `dist/`".
- **`color-scheme: light dark` collides with this app's class-based dark mode.** `src/styles/base.css:38`
  (`@custom-variant dark (&:where(.dark, .dark *))`) deliberately makes rendering "independent of the OS
  color scheme", and nothing in the repo sets the `color-scheme` property. v13 would make the canvas follow
  the OS while the app follows the class. Small, concrete, and a design decision rather than a blocker.

Other verified constraints: **Tauri's `dragDropEnabled` defaults to `true`** and its own config reference says
disabling it "is required to use HTML5 drag and drop on the frontend on Windows since we replace the drag
drop handler of WebView2" — node dragging is d3 mouse/touch and unaffected, so this bites the
**palette→canvas drag-to-add** pattern specifically. `@xyflow/react` needs an explicit height on its container
(`ResizeObserver`-measured). React Flow ships **no layout algorithm**; `@dagrejs/dagre` 3.1.3 (MIT, 15,868
gzip) is its own recommendation ("we highly recommend dagre"), while `elkjs` is **447,280 gzip** and dual-licensed
**EPL-2.0 OR GPL-3.0-or-later** — a different obligation class from MIT/ISC.

**Accessibility — and it is already a gap in the existing board.** WCAG 2.2 **SC 2.5.7 Dragging Movements**
(AA): "All functionality that uses a dragging movement for operation can be achieved by a single pointer
without dragging, unless dragging is essential…" (<https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html>),
and that Understanding doc is explicit that keyboard equivalence alone does not satisfy it unless the
alternative is also single-pointer-operable. `src/hooks/useDragCard.ts` is HTML5 DnD with **no `tabIndex`,
no `onKeyDown`, no keyboard move path** — so the board already fails this before any canvas exists. React
Flow does ship node-canvas a11y (`role="group"`, Enter/Space select, arrow-key movement,
`autoPanOnNodeFocus`, an `aria-live="assertive"` region) per
<https://reactflow.dev/learn/advanced-use/accessibility>, and third-party advice is to "provide a list view
fallback for the graph" — which this repo **already has**: `StageEditor` + `stages/StageDestinations.tsx`.

### F4. "A step that needs no LLM" — the universal split, and the four hard problems

| System | LLM step | Non-LLM step | Durable unit | Pause for a human |
|---|---|---|---|---|
| LangGraph | a node calling a model | **the same primitive** — "Nodes and edges are ordinary functions. They can call an LLM or run other code" ([graph-api](https://docs.langchain.com/oss/python/langgraph/graph-api)) | super-step checkpoint + per-task `checkpoint_writes` | `interrupt()` in the node, + `Command(resume=)` |
| Temporal | an Activity | **an Activity — indistinguishable** ("A Workflow Definition must be deterministic to support replay. To handle non-deterministic operations like API calls, LLM/AI invocations… put them in Activities") ([workflow-definition](https://docs.temporal.io/workflow-definition)) | Event History + **replay**, no snapshot | Signal / Update / Workflow Pause |
| Inngest | "a step… for example an LLM call or DB transaction" ([durable-execution](https://www.inngest.com/docs/durable-execution)) | same | per-step result checkpoint (4 MiB/step, 32 MiB/run) | `step.waitForEvent(…, {timeout})` |
| CrewAI Flows | a method calling a Crew | a method — **no marker distinguishes them** ([flows](https://docs.crewai.com/en/concepts/flows)) | `@persist` SQLite snapshots | `@human_feedback(emit=[…])` — an LLM maps free text to a routing label |
| MS Agent Framework | an executor | "This function builds a text-processing workflow **without requiring a model or credentials**" ([builder-and-execution](https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/builder-and-execution)) | super-step checkpoint incl. pending messages | `RequestPort` / `ctx.request_info()` |
| OpenAI Agents SDK | `Runner.run` | plain Python between them ("orchestrating via code makes tasks more deterministic and predictable, in terms of speed, cost and performance") ([multi_agent](https://openai.github.io/openai-agents-python/multi_agent/)) | **none built in** | `needs_approval` → serialize `RunState` |
| Pydantic AI | an agent run | a node's `run()` body ([multi-agent ladder](https://raw.githubusercontent.com/pydantic/pydantic-ai/main/docs/multi-agent-applications.md)) | engine journal **or** `StepPersistence` ("Durability is not storage") | deferred tool → run **ends** with `DeferredToolRequests` |

LangGraph's own guidance is the sharpest line available for this design: *"Deterministic work such as parsing,
retrieval, or a fixed tool chain does not need its own node unless you want that boundary. Ask whether the
step decides what happens next, or executes something already decided."*

**Idempotency.** LangGraph: a retry "re-runs the entire node function from the start. That gives at-least-once
semantics for node execution… It does not make external side effects happen exactly once", and "Side effects
during the node (payments, emails, external writes) are outside that boundary. Application code must make
those effects idempotent" ([fault-tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance));
on resume "The node restarts from the beginning of the node where the `interrupt` was called… so any code
before the `interrupt` runs again", hence "Side effects called before `interrupt` must be idempotent"
([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)). Inngest: producer- and
function-level dedup "do not remove that risk" for the external service, and "Do not use a new retry attempt
ID as the external idempotency key" ([idempotency](https://www.inngest.com/docs/durable-execution/guides-and-advanced/idempotency)).
n8n: a retried node "receives its saved input again and processes every item, including items it handled
before it failed", and "You can't retry an execution that succeeded, even if it didn't do what you expected"
([debug-executions](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions)).

**Loop bounds.** LangGraph `recursion_limit` → `GraphRecursionError`; OpenAI `max_turns` → `MaxTurnsExceeded`
(`max_turns=None` disables); Pydantic AI `UsageLimits(request_limit=50 default, total_tokens_limit, cost_limit,
tool_calls_limit)`; Temporal inverts it — Activity retries are **unlimited** by default (`maximum attempts = 0`);
SK Process Framework names non-termination as its headline pitfall. **This repo has no chain-level bound**:
ADR 0116 deleted the per-prompt-round bound, and `max_turns` is a per-turn concept.

**Cost.** Every system caps it *outside* the graph: Devin ACU limits (team default, per-group cap, per-user
override, "real hard stops, not soft warnings"); Linear Loops "consume AI credits"; n8n's positioning is
architectural ("Not every action needs an agent… Mix deterministic logic with judgment only where it earns
it"); LangGraph guidance is a `budget.check()` before each node call; Pydantic AI states the epistemic limit
in this app's own vocabulary — "Token and cost limits rely on provider-reported usage. When a completed
response omits usage… known token totals and cost remain lower bounds", i.e. an independently arrived-at
**Collapse**. This repo accumulates provider-reported per-Session USD (CONTEXT.md *Session cost*, *Cost
channel*) and enforces **nothing** — no budget, cap, or spend ceiling anywhere in `src-tauri/src/agent/`.

**Shared vs fresh context per step.** Default-shared: OpenAI handoffs — "When a handoff occurs, it's as
though the new agent takes over the conversation, and gets to see the entire previous conversation history",
with `input_filter` / `handoff_input_filter` / `nest_handoff_history` (opt-in beta, off by default) as the
escape hatches, and `remove_all_tools` shipped precisely because shared history bloats. Default-fresh:
Pydantic AI delegation — "Each delegation runs in its own run with its own message history, so a delegate
never sees the parent conversation"; Anthropic's sub-agent pattern, where each sub-agent "returns only a
condensed, distilled summary of its work (often 1,000-2,000 tokens)"
([effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
Configurable: LangGraph subgraph-as-node shares channels, subgraph-as-function with per-invocation persistence
isolates. **This repo has the answer specced and unbuilt: Handoff** — `task_handoffs(task_id, stage_slug,
summary)`, "Specced, NOT built in v1", and CONTEXT.md already calls it "the mechanism that actually addresses
the never-ending-session habit, because a **compaction** on its own makes a long Session cheaper, not
shorter". A step chain makes Handoff load-bearing rather than optional.

**The strongest empirical finding, and it argues for fewer LLM steps.** Berkeley's MASFT paper
([arXiv:2503.13657](https://arxiv.org/abs/2503.13657)) — 5 frameworks, 150+ traces, **14 failure modes in 3
categories**: specification/system design, **inter-agent misalignment**, and **task verification and
termination**, with ChatDev correctness "as low as 25%". Best-effort prompt and orchestration improvements
gave "+14% on ChatDev" and "do not resolve all failure cases… the improved performance remains insufficiently
low for real-world deployment." Their conclusion is organizational, not model-capability: "even organizations
of sophisticated individuals can fail catastrophically if the organization structure is flawed."

**And the gap that matters most here:** across Anthropic, LangChain and Pydantic AI a **Skill** is defined the
same way and is *not* a workflow node — "a directory that contains a `SKILL.md` file… the agent pre-loads the
name and description of every installed skill into its system prompt"
([Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills));
LangChain's Deep Agents "follow the Agent Skills specification". **No framework surveyed schedules a
`SKILL.md` as a step.** The nearest structural analogues are MS Agent Framework's declarative YAML `actions`
("variable management, control flow, agent and tool invocation, HTTP and MCP integration, human-in-the-loop")
and CrewAI's decorator chain.

### F5. Prior art — uncomfortable for the canvas, comfortable for the trigger

| System | Trigger | Do steps share context? | Human approval |
|---|---|---|---|
| **Vibe Kanban** (<https://vibekanban.com/docs>) | a card entering In Progress | **none between cards** — one git worktree and one branch per card, "multiple agents run physically isolated in parallel" | **the review column *is* the approval** — "the card enters In Review… you click in, see the diff, comment inline" |
| **Devin Dynamic Workflows** (<https://docs.devin.ai/work-with-devin/dynamic-workflows.md>) | a run, auto-approved by default | **structured output → next prompt** — "Each `agent()` call takes a JSON Schema and returns a dict shaped by it, which is how one stage's findings become the next stage's prompt" | two toggles — Auto-approve workflows, Auto-approve child sessions; enterprise-admin feature gate |
| **GitHub Copilot coding agent** | assigning a GitHub issue | n/a | the PR |
| **GitHub Agentic Workflows** (GA per GitHub changelog 2026-10-28) | GitHub Actions triggers (`on: push`) | the markdown body is the program | `safe-outputs:` — "at most one new pull request can be created, and the coding agent itself does not have 'write' permission"; "no hidden prompts or secret sauce" |
| **n8n AI Agent node** (<https://n8n.io/ai-agents>) | workflow trigger | **dataflow**; sub-node expressions resolve against the **first** item only; memory sub-nodes "do not persist between sessions" | opt-in, configuration-level ("actions that need a human") |
| **LangGraph + Studio** | `invoke`/`stream` | one shared state object with per-key reducers | `interrupt()`; Studio renders `response_schema` as typed fields |
| **GitHub Spec Kit** | a CLI/slash command, per feature | one constitution, rest repeated per feature | per-phase, command-driven — **not board-driven** |

**The editor finding.** Every product where a non-developer expresses "when a card moves to X, do Y" uses a
**list/form builder**: GitHub Projects ("Workflows in the project menu → pick → Edit → Save and turn on");
Linear triage rules (top-down, conflicts flagged); Jira automation (trigger→action list); CrewAI Studio
(Streamlit forms, "low-maintenance mode"). Zapier's Canvas is a *planning artifact that converts* to a linear
Zap. LangGraph — the most graph-shaped system here — keeps the graph in **code** and gives a *read-only* live
diagram. GitHub's agentic automation is **markdown in a repo**. Devin's is **Python**.

Linear's refusal is the most useful single fact: it gates **exactly one** field (priority, leaving Triage) and
"does not let you name another field or another boundary", because "A validator in front of every write… would
slow the paths that make Linear feel fast, in service of a policy only some teams want." And their line for
the LLM/non-LLM split: *"A Loop reasons; a rule evaluates."* (One secondary source, `lineguard.app`, a vendor
with an interest in the framing — flagged.)

**Observability mechanisms, named:** per-node I/O inspector (n8n — "Open any step to see the inputs and
outputs… Replay any run to find where it broke"); **dirty nodes** (n8n, F1); execution list with retry-from-saved-state
and "Retry with currently saved workflow" vs "with original workflow"; **checkpoints + Replay + Fork**
(LangGraph — `as_node` is how you *skip* nodes: "Set `as_node` to a later node to make the graph think that
node already ran"); per-super-step `stream.values` snapshots; linked trace spans (LangSmith, AgentOps);
Devin's phase panel + `register_workflow(meta)` declaring named phases + a `log()` primitive "visible while
the run is still executing" + "completed agents replay their recorded results instantly"; and the review
column as observability (Vibe Kanban — the unit is the diff). This repo's baseline is **Session-level only**:
`cost_update` frames, the Side pane's **Checklist**, the **Task badge**'s **frozen lane**, and per-card
`sessions`/`costUsd` chips — and `docs/features/task-board-known-gaps.md` §6 records that "Finished" **has no
representation at all** in the data model.

### F6. What this repo already provides — and the four blockers

**Ready to use (verified at `f1102039`).**

- The graph and its fields. `stages` DDL read verbatim from `src-tauri/src/storage/db/mod.rs:955`:
  `space_path, slug, label, sort_order, on_enter DEFAULT 'none', on_enter_skill, next_slugs`, PK
  `(space_path, slug)`, no FK on `space_path`. Six Stage verbs in `storage/db/stages.rs` (`create_stage:46`,
  `rename_stage:83`, `set_stage_skill:103`, `set_stage_next:135`, `reorder_stages:181`, `delete_stage:212`).
- The migration mechanism. **No `user_version`, no migrations table.** A new **table** is one
  `CREATE TABLE IF NOT EXISTS` in the single `SCHEMA` batch and **zero** `gate()` calls; a new **column** is one
  `gate(&mut conn, table, column, closure)` call probing `pragma_table_info` — measure them with
  `grep -c 'gate(&mut conn' src-tauri/src/storage/db/mod.rs` (12 at `f1102039`, where this line was
  written; 21 on 2026-11-27), all inside
  `Db::open`, pinned by a test that DERIVES them (`each_cluster_schema_omits_exactly_one_gated_column`,
  which replaced a hard-coded count literal). Data-only migrations have **no mechanism** (ADR 0107).
- Supervisor-side non-LLM capabilities already IPC-exposed: **19** `#[tauri::command]` in
  `commands/tasks.rs`; `write_artifact:1156` / `get_artifact:1186` (256 KiB cap, refused never truncated);
  `external_open` (`commands/open.rs:37`, IPC-only, no model tool — the cleanest precedent for a
  desktop-owned step); `attention_arm`/`attention_disarm` (`commands/attention.rs:98`/`:132`, IPC-only);
  the session lifecycle (`commands/sessions.rs`: `start_session:72`, `send_prompt:84`, `compact_session:237`).
- The launch path. `TasksBoard.tsx:218 nextStepOf` → `:244 launchStepFor` → `store/taskLaunch.ts:320
  launchTaskSession` → `:382 startAndSendLinked` → `startTaskSession` + `void sendLaunchMessage`; the token is
  minted at `src/lib/taskPrompt.ts:189 headOfMode` and expanded by `src/lib/skills.ts:634 expandMentions`.
- The one existing transition effect: `src-tauri/src/commands/tasks.rs:658`, `if outcome.on_enter == "compact"`
  — **exactly one hit in the whole tree**, re-measured. Storage deliberately does not run it
  (`storage/db/tasks.rs:296-306`: "Returning the value IS the seam").

**Blocker 1 — nothing can start a Session without a click.** `start_session` has exactly **two** Rust callers,
both `#[tauri::command]` (`commands/sessions.rs:79`, `commands/tasks.rs:1264`) — re-measured. `send_prompt`
has **zero** Rust callers outside the command layer (the one hit, `agent/session/mod.rs:2177`, is inside
`send_prompt_with_images` itself). `expandMentions` exists **only in TypeScript**, and
`src/lib/layerBoundary.test.ts` forbids a `src/lib/` module importing `src/store/`. There is **no scheduler**
of any kind — no cron, no queue, no timer beyond `attention.rs`, which fires an OS notification. A step that
"launches a Skill" is the app's first non-click initiator.

**Blocker 2 — awaiting a launch deadlocks today, and a chain is only awaits.** Documented verbatim at
`src/store/taskLaunch.ts:452-478`: `sendPrompt` resolves on `agent_settled`; the merged `research` Skill ends
its turn on an `ask` **gate**; `AskQuestionCard` renders only under `ChatStream`; and `App`'s view ternary
renders the board **instead of** `ChatStream` — "the turn waits on a gate that has no renderer, and the gate
cannot appear until the turn ends to let the view switch." Hence `void sendLaunchMessage(…)`. A **Workflows**
view is a fourth arm of that same ternary (`src/App.tsx:336`, verified:
`useState<"workspace" | "settings" | "board">`), so a chain inherits the bug shape unless gate rendering for
a non-`ChatStream` view is solved **first**. Note `SubagentModals sheetMounted={view === "workspace"}` is
deliberately `=== "workspace"`, and `:620-637` records that `view !== "settings"` reintroduces a real defect.

**Blocker 3 — the automation door is the door with no effects.** `docs/features/task-board-known-gaps.md` §2:
a model `move_task` "never fires a compaction and never runs a launch… **The two verbs disagree about what a
move means, and only the human's drag is the full verb.**" Also: a card a harness tool writes is **invisible
until the board remounts** (`store/tasks.ts`'s `load` has exactly one call site), and `list_board` does not
seed the stages `get_board` seeds. An unattended workflow runs through the *incomplete* verb.

**Blocker 4 — the clean seam is accepted but unbuilt.** `host_tools`: **0 hits** in `src-tauri/src`
(re-measured) and absent from the pinned `fulcrum-harness` 0.5.1. ADR 0102 is `status: accepted`;
`docs/roadmap/tool-separation.md` is `status: approved`, issue #183, undone (`done-when:` names `tool_specs()`
at 19 and one generic `HostToolCall`/`HostToolResponse` pair). Today a step needing a desktop capability
follows ADR 0092's shape: `impl TaskStore for Db` (`storage/db/seams.rs:190`, seven verbs) with the Worker's
`IpcTaskStore` parking on the answer.

**Standing constraints a design must respect.**

- **No cycle check on `next_slugs`.** Only a *self*-loop is refused (`BoardError::SelfLoop`, `stages.rs:147`);
  A→B→A is constructible today.
- **§8: a configured `next_slugs` can never be un-configured.** `set_stage_next` takes a plain slice, `[]`
  serialises to `"[]"`, and `NULL` is reachable once on insert and unreachable again. Under Strict, `NULL`
  means "goes anywhere" and `[]` means "nothing follows" — user-visible and unrecoverable except by
  delete-and-lose-the-cards. `set_stage_skill`'s `Option` is the in-file precedent for the fix.
- **`on_enter` has no writer at all.** `UPDATE stages SET on_enter = ` appears twice, both in tests; no command
  takes it, `StageEditor` has no affordance, and the DDL `DEFAULT 'none'` is the only writer — while
  `tasks/TaskColumn.tsx:119-125` renders the tooltip "Entering this stage runs: fresh" for a value that fires
  nothing. A step-runner would be the **first writer of that column**.
- **ADR 0107's shrinking Skill catalog is undetected by design** — "it adds no lint, no warning chip and no
  'unknown Skill' surface" — and a Stage whose Skill cannot resolve renders **nothing** where the launch pill
  was (`TaskCard.tsx:444`). `set_stage_skill` persists a name that never existed.
- **A child's board verb still misroutes** (ADR 0117); `f1102039` bounded it at
  `TASK_BOARD_CALL_TIMEOUT = 30 s` and added `diagnostics::record` on every non-answering path, but the
  misroute is live until the wire gains an origin field.
- **`subagent` is excluded from `codemode` scripts** (`EXCLUDED_FROM_SCRIPT`, 6 names) and a child cannot nest
  (`subagent_enabled: false`), so neither is reusable as a chain primitive.
- **§1: Task numbers ARE reusable** contrary to ADR 0090, latent only because there is **no task delete verb**
  ("if a task delete is ever added, this becomes live and must be resolved first").
- **Cheap, verified:** a "Workflows" door is 6 named edits — widen `App.tsx:336`; add an explicit arm to the
  ternary at `:570-575`; widen `SpacesList`'s `currentView` at `:197`; add the door with
  `aria-pressed` + `bg-selected` **and the toggle-off half** (`aria-pressed` goes on views and deliberately
  **not** on modals — "a modal is not a location", ADR 0095); wire it at `App.tsx:565-568`; and note
  `useAttentionAlertClick(setView)` also consumes `setView`.
- **Not cheap:** `src/store/tasks.test.ts` is at **1,066 code lines** and is ledgered — it may not grow by one
  code line (ADR 0112 ratchet) — and ADR 0113's **Mirror** rule means any new `db/<subject>.rs` must get a
  same-named `db/tests/<subject>.rs`. `bash scripts/check-file-size.sh` is currently green with no
  board-related lines except that one file.

**Re-measured against `AGENTS.md`, because it says to:** `/home` has **569 G free** and `target/` is **331 G**
— not the "~150 G against ~13 G free" the file records. The worktree-first instinct is affordable on this
machine today where the recorded figures said it was not. No worktree was created: creating one is
implementation, and this skill stops before it.

---

## Unresolved Contradictions

1. **Is a canvas the right UI?** *Pro:* the externalization argument — "Each node is a verb… each wire is a
   noun", "you're choreographing a data flow… That's not imperative programming"
   (<https://fuser.studio/blog/the-graph-will-set-you-free-why-every>), plus n8n's market success, plus the
   fact that this very repo's Stage graph is genuinely 2-D (branches, `next_slugs` is "a GRAPH and not an
   order" per ADR 0099). *Con:* the Deutsch Limit (~50 visual primitives,
   <https://en.wikipedia.org/wiki/Deutsch_limit>) — which a 5-column board is nowhere near, and a per-transition
   step graph may be — and the convergence of every non-developer automation product on a list. **Credibility
   assessment: the con side is stronger as evidence**, because it rests on what shipped products converged on
   rather than on theory, and because the pro side's own author concedes the objection and answers with a
   scope argument rather than a rebuttal.
2. **Are cycles a feature or a defect?** n8n: legal and documented as a loop mechanism, with no cycle check in
   its validator. LangGraph: `GraphRecursionError` exists precisely to "prevent infinite loops". SK Process
   Framework names non-termination as its headline pitfall. **Likely resolution: a bound, not a prohibition**
   — which depends on contradiction 3.
3. **What is a safe chain bound?** Angle 3 cites LangGraph's documented default `recursion_limit` as
   **10,000 / 10,007** super-steps; Angle 6 cites the API reference as **25**. Both are primary-adjacent and
   **I could not reconcile them.** The gap is three orders of magnitude, so it is not pedantry — it is the
   difference between "the bound is a formality" and "the bound is the product".

## Gaps

- **No framework schedules a `SKILL.md` as a step.** No external playbook exists for the actual ask; the
  nearest analogues are MS AF's declarative YAML `actions` and CrewAI's decorator chain.
- **n8n's licence is silent on UI similarity and on the workflow JSON format.** Silence, not permission. The
  FAQ routes hard cases to `license@n8n.io`. A trademark check on the word "n8n" in any UI copy was not done.
- **No primary source on screen-reader behaviour in Tauri's three webview engines** (WebView2 / WKWebView /
  WebKitGTK). Unknown, not refuted. What *is* measured here is that input diverges per platform: ADR
  0056/0057/0061 on key focus, and `docs/features/image-attachments.md` on WebKitGTK's empty `DataTransfer`.
- **Never-updated Ubuntu 24.04 (WebKitGTK 2.44.x)** had `light-dark()` behind a runtime gate
  (`if (!context.lightDarkEnabled) return std::nullopt;`) whose **default could not be resolved** — every path
  tried 404'd. Affects only un-updated installs.
- CrewAI's step-level failure/retry semantics unverified (`kickoff_for_each` semantics unknown;
  `reference.crewai.com` 404s). Microsoft Agent Framework's sub-workflow state-sharing asserted from an index
  table only. Temporal's Event History size cap / Continue-As-New thresholds unverified.
- **No precedent found anywhere for a "Workflows" door beside a "Tasks" door.** Closest: Zapier's separate
  left-menu Canvas, GitHub Projects' Workflows-in-the-project-menu — both separate surfaces, neither paired
  with a board in one sidebar.
- `@xyflow/react`'s exact release that introduced `@layer xyflow` + `light-dark()` unpinned (verified absent
  at 12.9.2, present at 13.0.2).
- **No measured study either way on node-canvas readability.** "Spaghetti edges" is widely asserted and thinly
  cited; the search for a practitioner post-mortem found none.

## Evidence and credibility

**Primary code/spec/licence text** (highest tier): n8n `LICENSE.md`, `LICENSE_EE.md`, `interfaces.ts`,
`workflow-structure-validation.ts`, `IfV2.node.ts`, `ManualTrigger.node.ts`, `execution-entity.ts`,
`workflow-step-execution.entity.ts`, plus workflow fixtures; Node-RED `LICENSE` + runtime `Node.js`;
Activepieces `LICENSE` + `flow-version.ts` (a **nested linked list**, `nextAction` / `children[]` /
`firstLoopAction` — not nodes-and-connections at all); Windmill `LICENSE` + `openflow.openapi.yaml`
(**no wires** — `modules` is a sequentially ordered array, Apache-2.0 per its own licence text); Automatisch
`LICENSE` + `step.js` (**relational rows**, ordering by `position`); shipped `@xyflow/react` 12.9.2 vs 13.0.2
CSS; WebKitGTK source trees from Debian/Ubuntu/Fedora/Arch; `docs.temporal.io`, `docs.langchain.com`,
`docs.n8n.io`, `learn.microsoft.com`, `raw.githubusercontent.com/pydantic/pydantic-ai`, `w3.org/WAI`, MDN.

**Local code, re-measured at `f1102039`:** the DDL, the `gate` factory and its 12 calls, the single
`on_enter ==` hit, `host_tools` = 0, `start_session` = 2 callers, `send_prompt` = 0 outside the command layer,
`App.tsx:336`'s view union, `SelfLoop`, `package.json`'s zustand 5 / React 19 / MIT, `pnpm-lock.yaml` xyflow
absence, `check-file-size.sh` green.

**Vendor marketing** (lowest tier, used only for what a product claims about itself): n8n's AI positioning
page, Devin's docs, Zapier's Canvas guide, `lineguard.app` (a Linear add-on vendor describing what Linear
*cannot* do — flagged at point of use).

**Not run:** `cargo test`, `cargo clippy`, `pnpm test`, `pnpm build`. This is a read-only research document;
every test name cited is from source text, not from a run.
