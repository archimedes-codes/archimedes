---
status: accepted
date: 2026-11-11
superseded-by:
---

# The Tool registry is the engine's sole dispatch authority, host tools arrive as data, and the crate forgets Tasks exist

The **Task board**'s seven verbs were already half-client (ADR 0092: `impl TaskStore for
storage::Db` runs Supervisor-side because the **Worker** has no `Db`), yet the crate still
owned their advertisement — so the desktop could not add a tool without publishing a
crate release. We decided the swappable end of the architecture is the **engine**, not the
**Client**: Archimedes Desktop may one day run a harness that is not fulcrum, so the
**Client** owns the tool surface and any engine must accept a registry handed to it. The
engine therefore dispatches every non-loop-internal call through one **Tool registry**, and
a **Host tool**'s spec travels to it as data (`StartEnv.host_tools`) rather than being
compiled into it.

**The classification rule is data ownership, not capability.** A tool is a **Host tool**
when its substance acts on host-owned state — the board is the **Client**'s SQLite, so the
board's verbs are the **Client**'s. A tool whose substance the engine already confines
stays an **Engine tool**: `bash`/`read`/`write`/`edit`/`find`/`grep`/`ls` judge against one
frozen `PermissionContext` bundle (`to_tool_ctx` builds exactly one `ToolCtx` so *"the
executor cannot re-decide differently from its gate"*), and splitting one tool's spec, gate
and executor across the wire breaks that invariant. A Gate re-prompting what an executor
already allowed is the #92 / ADR 0081 escape class.

**The registry is the sole authority for everything it can be, and the bound is censused
rather than asserted.** Seven tools stay loop arms permanently, because their executor is
`&mut AgentLoop` and no host could implement one: `codemode`'s bridge needs the live loop,
`subagent` needs the parent's catalog and cost fold, `ask` needs the pending-gate map. So
the enforced claim is *registry set ⊎ loop-internal set = advertised set, disjoint* — the
generalisation of `every_advertised_tool_reaches_an_executor`, which exists to catch the
one failure this shape hides: a tool **advertised and unreachable**.

**`fulcrum-harness` deletes its whole Task subsystem** rather than leaving it unused:
`task_tools.rs` (1,191 lines), `worker/task_store.rs` (567), `TaskStore`/`TaskCaller`/
`TaskCall`/`TaskStoreError` + the five board DTOs, `ToolCtx.task_store` (the field that
forced 0.2.0), and the `TaskRequest`/`TaskResponse` frame pair — replaced by one generic
`HostToolCall`/`HostToolResponse` pair that carries no tool vocabulary at all.
`tool_specs()` drops 26 → 19. The safety claim is that **the model is still advertised the
same 26 names**: a 26-name invariance census is written before anything is deleted and
stays green across all three commits, and it names the engine/host split in its failure
message because a bare count cannot say which half vanished.

## Considered options

- **Keep E.6 cancelled.** ADR 0092 rejected the executor-trait inversion *as a no-op*,
  measured on the grounds that `execute_tool` and both its call sites are in one crate, so
  a trait adds a `dyn` call and plumbing to a direct call. That reasoning is sound for the
  premise it weighed — the package cycle was gone. Engine optionality is a different
  premise it never weighed, and it is not satisfiable without the inversion: an engine that
  hard-codes its own tool names cannot be handed a surface. Re-opened deliberately; the
  virtual call per dispatch is accepted against a body doing file I/O, a process spawn, or
  a network round trip.
- **Registry as an appendix** (the hard-coded `match` stays first, the registry answers only
  unknown names). Smallest diff, zero risk to the 19 — but nothing in production would
  populate it, so only synthetic tests would exercise it. That is the weak-pin shape
  `seams.rs` documents at length (*"a trait with no caller has no runtime behaviour to
  test"*) and the mutation `AGENTS.md` names: a registry that `return`s `Vec::new()`
  compiles clean and silently reaches nothing.
- **Host entries shadow built-ins by name** (a host could supply its own `bash`). Rejected:
  it puts the **Boundary** judgement on the host side for the one tool family whose entire
  safety story is the frozen `ToolCtx`.
- **Leave the task path in place but unused.** A dead ~2,000-line subsystem in a published
  crate is exactly the residue `docs/features/improvement-boundary-residue-closeout.md`
  exists to clean up.
- **An MCP server for host tools** — rejected for the measured reason in ADR 0092 (MCP
  config is app-global/project-level while a **Task board** is per-**Space**), and it stays
  invisible to the **Permission prompt**, `enabled_tools`, and `list_tools`.

## Consequences

- **`PROTOCOL_VERSION` stays 1.** Removing two wire variants is not a skew risk on the
  **Worker** path: the **Worker** is a self-exec of the *same* binary, so Supervisor and
  Worker are always one build. The daemon's UDS surface is a separate protocol and the
  desktop is not a daemon client yet (T12 `todo`), so nothing in the field straddles it.
- **The `fulcrum` daemon must answer the generic frame, not shrug.** It refuses
  `task-request` loudly today; an unknown or unhosted tool must stay a
  `ToolResult::fail`, never a silent park — the daemon path is where a missing answer
  becomes hang-until-turn-cancel.
- **Deleting `trait TaskStore` deletes the thing that forced the full answer shape.** Six of
  the seven verbs have an INHERENT `Db` method of the same name with a thinner shape (the
  inherent `MoveTaskOutcome` has `on_enter` alone — no `toStage`, no `note`). With the trait
  gone, `db.move_task(…)` binds to the inherent twin and ships a green build whose every
  move is broken. The DTOs move **Client**-side and the mapping is explicit, asserted on
  shape.
- **`ScriptAccess` replaces `EXCLUDED_FROM_SCRIPT`'s name list**, and this is load-bearing:
  ADR 0092 chose `execute_tool` arms *specifically so codemode could reach the task verbs*.
  Without the field on the entry, moving the specs out of the crate silently deletes a
  shipped property (one `roadmap` script creating N **Tasks**) and every existing test stays
  green. The `mcp action: "auth"` argument-level exclusion stays a special case — no
  name-level field can express it.
- **`dispatch_nested` must resolve through the registry.** The codemode bridge calls
  `execute_tool` directly, which is the reason the task verbs were `execute_tool` arms.
  Left alone, host tools are advertised to scripts and dead to them, and the disjoint census
  does not catch it because that test drives `dispatch_tool`, not the bridge.
- **`d2_ships_the_artifacts_block_and_the_verbs_that_answer_it_together` reddens by design**
  — its own comment says it was written to redden on exactly this change. Its *negative*
  half (`agent/harness/mod.rs` must not mention `write_artifact`, *"a second owner of the
  advertised tool list"*) has a premise this decision reverses: it asserted the crate owns
  the list. It is inverted to assert the **Client** is the sole owner. Leaving it would be
  the worst outcome available — a green test arguing against the design it now guards.
- **`edit_task` gained a third patch state on the desktop side only, and the published seam stays
  two-state on purpose.** The inherent `Db::edit_task` now takes a three-state `FieldPatch`
  (`Keep` / `Set` / `Clear`) over one fixed-arity `CASE` UPDATE, so a desktop caller can finally null
  `body` or `spec_path` — the old `COALESCE` statement made `NULL` mean "leave it alone" and left no value
  that could blank a column. `impl TaskStore for Db` maps its `Option<&str>` with `None` → `Keep`, so
  **`TaskStore::edit_task` / `TaskCall::EditTask` stay two-state and the model's `edit_task` still cannot
  clear a field.** That is a deferral, not a half-done widening: this decision deletes both types wholesale,
  so widening them would freeze the precise shape this decision removes, and it would cost a hand-run
  `cargo publish -p fulcrum-harness` plus a desktop pin bump to buy a wire shape with a scheduled funeral.
  **#183 is where the third state becomes reachable from the tool** — once the desktop owns `edit_task`'s
  spec *and* executor behind a vocabulary-free `HostToolCall`, the clear is a one-repo change for both
  callers. Falsifier: **if #183 is abandoned, the harness-side clear becomes real work again** — the seam
  widening, the publish and the pin bump are then owed rather than deferred, not waived. `impl TaskStore
  for Db`'s body comment carries the same pointer, and
  `docs/research/edit-task-cannot-clear-a-field.md` is the finding behind all of it.

## Amendment (2026-11-25) — as shipped: the D1/D2 boundary, `narrow`, and ONE WRONG TYPE NAME

Appended by issue #183's final desktop commit (D2). Nothing above is rewritten. Three things this
ADR predicted or mis-stated are recorded here because the migration table that carried them lived in
`docs/roadmap/tool-separation.md`, which is gitignored and **unrecoverable after a ship** — no
checkout, no stash, no dangling blob.

**CORRECTION — the Consequence naming `MoveTaskOutcome` names the WRONG TYPE, and the error is
load-bearing.** The bullet above says "the inherent `MoveTaskOutcome` has `on_enter` alone — no
`toStage`, no `note`". There are **THREE** move shapes in this tree, not two, and that sentence names
the middle one by the wrong name:

| type | owner | fields | derives |
|---|---|---|---|
| `storage::db::MoveOutcome` (`storage/db/rows.rs`) | storage — the actual return of the inherent `Db::move_task` | `on_enter: String` — **one** field | `Debug, Clone, PartialEq, Eq, Serialize, Deserialize` |
| `commands::tasks::MoveTaskOutcome` (`commands/tasks.rs`) | the IPC command layer | `on_enter: String`, `boost_note: Option<String>` — **two** | `Debug, Clone, Serialize` only (wire-out, no `Deserialize`, no `PartialEq`) |
| the crate's `seams::MoveOutcome` (deleted by F3) | the engine | `to_stage`, `on_enter: Option`, `note: Option` | `Debug, Clone, PartialEq, Serialize, Deserialize` |

A plan that imports `MoveTaskOutcome` believing it is storage's return **does not compile**; a plan
that believes storage's answer already carries a note **double-reports the boost**, because the boost
note is computed one layer UP (`commands/tasks.rs`'s `boost_note`), and storage cannot name
`SessionManager` (ADR 0092). The desktop's wire DTO is a fourth name again, `MoveToolOutcome` in
`agent/host_tools/`, and `to_stage` is **synthesised from the caller's own argument** while `note` is
hard-coded `None`.

**CORRECTION — the D1/D2 boundary as drawn does not compile, so D1 carried more than the plan
assigned it.** The plan put the crate-pin bump in D1 and "the read sites and the pins" in D2, but
`impl TaskStore for Db`, both `From … for TaskStoreError` impls, the crate `seams::{…}` imports, the
three `ToolCtx { task_store: None }` literals and `fulcrum_seams.rs`'s whole Pin-4 block all stop
compiling AT THE PIN BUMP, and the `d2_ships_…` pin's second needle was literally
`"impl TaskStore for Db"` — so D1 would have shipped RED. Same atomicity argument this ADR already
makes for the router arm, simply never applied to the desktop's own copy of the seam. D1 therefore
took the desktop-side deletion and the needle rewrite; D2 took the two read sites, the pin's negative
half, and the docs.

**CORRECTION — `narrow` is a THIRD `tool_specs()` read site and it was NOT fixed; the consequence is
accepted upstream.** §2.3 names two read sites (`advertised_tool_specs` and `list_tools`). There is a
third, `harness/launch.rs`'s `narrow` closure, which filters a definition's `tools:` frontmatter
against `tool_specs()`. Since the seven verbs left that table, a `tools:` list naming ONLY host verbs
narrows to nothing and ADR 0067's emptied-means-ABSENT rule hands the child the PARENT's set. The
engine records this as an accepted decision with three reasons in its own `launch.rs`; **fulcrum is
frozen for this run**, so the desktop's `worker_e2e` pin was re-pointed at the inherited-parent leg
while still asserting the child's enabled set is exactly `["write_artifact"]`. What is lost is a
narrowing the frontmatter intended, and `docs/features/permissions-model.md` §(f.2) carries the
consequence. **A future run that wants host-tool narrowing must feed `narrow` the composed set.**

**CONFIRMED as designed — the two things this ADR made a hard requirement.** `Outbound::HostToolCall`
shipped WITH the origin `session_id` field (the plan's §2.5 code block omits it; without it
`task_reply_target` has nothing to consume and ADR 0117's 255m55s `get_artifact` hang returns as a
`HostToolCall` hang), and children DO inherit `host_tools` (`subagent_flow.rs`, read off the parent's
live envelope, pinned by the engine's own inheritance tests). `PROTOCOL_VERSION` stayed **1**: the
Worker is a self-exec of the same binary, so Supervisor and Worker are always one build.

**CLOSED by D2 — the second §2.3 read site.** `commands/settings.rs::list_tools` now returns the
composed set (the engine's 19 ++ this repo's 7) and stays STATELESS, so a host tool appears in
Settings and can be disabled through `enabled_tools`. Its pin is
`list_tools_lists_the_engine_tools_and_the_host_tools_together`, and the pin that used to argue a
desktop-side registration would be "a second owner of the advertised tool list" is now INVERTED to
assert the Client is the SOLE owner — scanned at `agent/host_tools/`, the file that actually holds the
registration, because scanning the old file would have left a green test arguing against this design.
