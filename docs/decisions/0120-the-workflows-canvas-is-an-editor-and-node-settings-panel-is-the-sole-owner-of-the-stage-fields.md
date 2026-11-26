---
status: accepted
date: 2026-11-25
superseded-by:
---

# The **Workflows canvas** is an **editor**, `NodeSettingsPanel` is the **sole owner** of the **Stage** fields, and a hand-arranged **position** persists

ADR 0119 §7 ruled the opposite: *"The canvas is **read-only**, the **Stage editor** dialog is the
sole owner of the Stage fields, and the two next-step functions stay **two**."* That ruling is
**reversed here** on its first two clauses and **kept** on its third. This file supersedes 0119 §7
**partially**, and the partiality is the load-bearing fact about it — see §1 and §7.

Nothing here cites a commit hash. `docs/agents/repo-gotchas.md` records why: the squash-merge
convention makes every per-issue commit on a branch unreachable the moment the branch is deleted, so
durable prose cites the **PR number** or — better, because it cannot be orphaned at all — the
**file, the symbol and the test name**. The PR number for this branch was not known when this file was
written, so every citation below is to the tree. **No instruction here asks a reader to inspect this
branch's own diff through `main`**, because the squash-merge is exactly what makes such a view empty.

## 1. The reversal: the reasoning was sound, the premise died

Write this down first, because the tempting error is to record the reversal as though 0119 got it
wrong. It did not.

**0119 §7's argument, restated at full strength.** One owner per fact. The dialog owned every field a
**Stage** row carried; a panel beside the canvas editing the same fields would be a *second* owner of
each, with two draft states, two error paths and two answers to "what does this column do". A
drag-to-connect would be a *third* write path for edges the destination editor already owned, and a
drag has no keyboard route in this repo, so it would add an affordance some people cannot reach at
all. And a stored position "would be a per-Space fact with no column to live in, and a second answer
to 'what is this workflow' that the editor cannot edit" — that clause and its quotation are
**sourced from `workflowGraphLayout.ts`'s header, not from 0119 §7**, which is where this paragraph
first pointed them. Measured: `grep -c 'no column to live in' docs/decisions/0119-*.md` answers **1**,
and the single hit is the supersession note ADR 0120's own commit added to 0119 — which quotes the
same sentence and calls it "the position argument below", while §7's body contains no position
argument to be below. 0119 §7's actual position clause is the one about a drag's missing keyboard
route, quoted verbatim below; the position-with-no-column argument was always the layout module's, and
it is the layout module that is cited for it further down. Every one of those sentences was true when it
was written, and each was *evidenced* — §7 carries a field-by-field count of which of the plan's six
fields already existed and which two that branch added, precisely so the "second owner" claim could be
checked rather than believed.

**What changed is the premise, not the logic.** Three things moved, and they took the argument one
clause at a time:

- the **Stage-list editor dialog is deleted** (§3), so there is no longer a *first* owner for a panel
  to duplicate — the panel is the **only** owner, and "a second owner of every one of those fields"
  describes a surface that no longer exists;
- `stages` gained `position_x` / `position_y` (§4), so the "no column to live in" half of the position
  argument is simply **false** now;
- and the destination write gained a `Select` and a keyboard (`NodeDestinations`), which is the answer
  §7 said it needed before a drag was admissible — "a drag-to-connect would be a third write path …
  plus a keyboard route for a drag, which this repo does not have" was an objection to a drag with no
  keyboard equivalent, and the equivalent now exists.

`src/components/workflows/workflowGraphLayout.ts`'s header states the strongest version of this and
this ADR defers to its wording rather than re-arguing it in different words: *"**The first half of that
sentence is now false and the second half was never much of an argument.** … What made the old decision
wrong was not the reasoning, it was that the surface became an editor: a canvas you can drag but cannot
persist a drag to is worse than one you cannot drag at all, because the drag promises something the next
render takes back."`

**The general rule to carry forward, which is the reason this ADR exists at all:** a read-only surface
is defensible while a *different* surface owns the fields it displays. When that other surface is
deleted, the read-only surface becomes a picture of a thing nobody can edit, and the objection that
made read-only correct ("a second owner") has dissolved — there is no first owner left. **Before
reversing a read-only ruling, check which of its premises is still true.** Two of 0119 §7's three
clauses fell to a deleted dialog and two new columns. Its third clause — that `nextStepSlugs` and
`nextStepOf` stay two functions with a preserved disagreement — fell to *nothing*, and stands
unchanged (§7). A reversal that swept that clause away would have been the mistake this ADR's whole
structure is here to avoid.

## 2. A **node is a column**, and **Skill is a property** of it

The owner's framing for the whole feature was *"kanban cols are just the skills linked to each other in
the workflow"*, which reads as though the node should *be* the **Skill**. It is not. The ruling is that
**the node is the column** (`Stage` row, keyed `(space_path, slug)`) and the **Skill is one of its
properties** — `stages.on_enter_skill`, exactly the field ADR 0098 made the sole authority for a launch
Skill and ADR 0107 left as the one launch Skill rather than two.

- **Rejected: node = Skill.** It would make the graph a graph of Skills with columns derived from them,
  and it breaks on the first Skill that appears twice. A Skill is not keyed to a Space and carries no
  `sort_order`, no `on_enter`, no `next_slugs` and no card set; the column carries all five. It would
  also strand `tasks.stage_slug`, which names a **Stage** slug and not a Skill — the card's whole
  location would need a Skill→column map, i.e. the constant map ADR 0098 deleted.
- **Rejected: a Skill in several columns** (one Skill node fanning out to several columns). This is the
  shape the "cols are just linked skills" phrasing actually points at, and it is the one that cannot be
  built on this schema without inventing a new noun: fanning one Skill node out to N columns makes the
  Skill the owner of N sets of destinations, and *which* column a card is in stops being a fact anyone
  holds. `tasks.stage_slug` is one string (§9a of the known-gaps file names the same constraint).
- **Kept: the column is the node, and everything the node shows is that row's own state.** `layout`'s
  own header says it plainly — *"Every field is the column's OWN state"* — and
  `carries the column's real state on the node: Skill, auto, extra prompt, cards` pins it.

The consequence a future contributor needs: **the canvas is a view of `stages`, not a new model.** It
introduces no table, no wire entity and no second graph. The edges are `next_slugs` and nothing else
(§6).

## 3. The **Stage-list editor dialog is deleted**, not kept as an advanced view

The obvious conservative move was to keep the dialog as an "advanced" view and add the panel beside it.
Ruled against, and deliberately so: keeping it **re-creates the exact defect 0119 §7 was written to
prevent**. That ruling's entire reason was one owner per field; shipping a panel *and* the dialog is
two owners of eight fields, with two drafts, two error lines and two places to learn from. The panel is
`NodeSettingsPanel` (the shell) over `NodeSettingsBody` (the eight per-column fields, with destinations
in `NodeDestinations`) and `WorkflowSettingsBody` (the two per-Space subjects plus the add-a-column
field), and it is the **sole owner**.

`NodeSettingsBody`'s header records what the re-home did and did not do: it is the old
`stages/StageRow.tsx` **re-homed field for field** — *"The row and this body answer the same eight
questions of the same `StageDto`, and every write is the same store action with the same arguments"* —
and what changed is the **shape** of the surface. The arithmetic evidence that this is a move rather than
a redesign: the retired row and the new body each carry **nine** `aria-label`s
(`grep -c 'aria-label=' src/components/workflows/NodeSettingsBody.tsx` reads **9** at this tip; it read
**9** on `src/components/stages/StageRow.tsx` at the base of the re-home, before that file was deleted
with the dialog, so re-run the second half against history rather than the working tree). Nine, not eight,
because the delete and cancel-delete affordances are a pair of controls on one field — which is exactly
the distinction 0119 §7 warned a control-counter and a field-counter would disagree over.

Two consequences that are *decisions* and not cleanup:

- **`role="button"` and its five click-routing tests are genuinely obsolete, and were dropped rather
  than ported.** The dialog's row was the app's only hand-rolled `role="button"` row and every nested
  control had to `stopPropagation()` so a click on the Skill picker did not also run the row's single
  affordance. A panel section is a `<div>`; those cases have no subject here. Every
  `stopPropagation()` came out with it rather than staying as cargo cult.
- **The uncommitted-draft rule survives, with a different trigger.** The dialog held a panel-level
  `Record<slug, draft>` that outlived the row it described, so a half-typed label survived the row being
  filtered away and back — the behaviour `StageEditor.test.tsx`'s
  `filtering a row away discards its uncommitted draft` pinned and then retired. The panel holds **no**
  panel-level record: the draft lives inside the body that owns the field, and the panel's equivalent of
  "the row went away" is a different node being selected, which unmounts that body. Same rule, new
  mechanism.

**The dialog is deleted, and that deletion is what makes this ADR's §3 true rather than aspirational.**
Its former children did
not die with it — `AddStageField`, `AutoChainGuards` and `StrictWorkflowToggle` moved from
`components/stages/` to `components/workflows/`, because their subject is the whole **Space**'s
configuration and that subject now lives beside the canvas rather than inside a dialog.
`WorkflowSettingsBody` mounts them in the panel's workflow mode.

## 4. A hand-arranged **position** persists, and **Tidy up** is the escape hatch back to dagre

`stages.position_x` / `stages.position_y` — both nullable `REAL`, both added through `gate()` like every
other column on an existing table (ADR 0119 §1's rule), so the gate count this branch moved is
re-measured in Consequences. Written by `Db::set_stage_position`, one command (`set_stage_position` is
the only `#[tauri::command]` this change adds to `commands/tasks.rs`).

The rule, in the order `workflowGraphLayout.ts` applies it, stated once here because four files would
otherwise each carry a third of it:

- a node whose `positionX` **and** `positionY` are both non-`null` is drawn at that pair **exactly**;
- **a half pair is treated as unpositioned.** `set_stage_position` takes `Option<(f64, f64)>` — both
  coordinates or neither — and refuses a half pair at the wire, pinned by
  `a_half_set_stage_position_is_refused_at_the_wire_naming_both_values`; `StageDto.positionX` tells a
  reader who finds half a pair on an existing row to treat the node as unpositioned. A node at a stored
  X and a computed Y is the state the write refuses to *store*, so it must not be the state the canvas
  *paints* either (`treats a HALF pair as unpositioned, which is the reading the wire type allows`);
- **`0` is a coordinate somebody placed and `null` is the only "nobody ever moved it."** The check is
  `!== null`, never truthiness — `positionX || dagreX` would silently free every node pinned to the left
  or top edge (`reads \`0\` as a placed coordinate and not as absence`, and
  `sends \`0, 0\` as a real position and never folds it into a clear`);
- **if any node lacks a stored pair, dagre runs over the whole graph** and the stored nodes are
  overridden afterwards, which is what keeps a half-arranged board readable — never-arranged columns
  land at sane depths *relative to* the arranged ones instead of at the origin under them. When every
  node has a pair, dagre is skipped (`returns the stored positions for every node when every node has
  one`). That last branch is the one a test cannot see directly — "skip dagre" and "run dagre then
  override" return the same array — so its pin is behavioural, against a fixture arranged *against* the
  ranker, and not a spy on dagre;
- **the ghost node stays on dagre and is `draggable: false`.** It has no row and so no `position_x`; a
  draggable ghost would be a drag that always fails, always reverts, and always lands its sentence in
  the error line, because `set_stage_position` refuses a slug the Space does not hold
  (`set_stage_position_refuses_a_slug_that_is_not_here_and_writes_nothing`).

**`Tidy up` is not a convenience, it is what makes the previous bullet set survivable.** Without a way
back to dagre a hand-arranged graph can never be *un*-arranged, and the only route out is a database
edit. It issues one clear per positioned column (`null, null` is that pair's only spelling of "nobody
ever moved it"), so there is **no bulk verb** — a single command that cleared the board would be new IPC
for a nicety, and on a five-to-ten column board the visible cascade is not a problem. It is
`aria-disabled` and inert when nothing is arranged (`is inert, and writes nothing, when nobody has
arranged anything`), and it clears **exactly** the set `storedPositionOf` answers non-`null` for —
`WorkflowsCanvas.tsx` imports that predicate from the layout rather than re-spelling it, because a
second answer to "is this node positioned" is how Tidy up ends up clearing the wrong set.

## 5. Settings open in a **right-hand side panel**, not a modal and not inline

Ruled for a panel beside the graph:

- **not a modal**, because the whole point of the surface is that the picture and the fields are read
  *together* — you arrange a column while watching where its edges go. A modal covering the graph to
  edit a node in it destroys the thing that makes the canvas worth having, and the graph's most useful
  claim (a column that dead-ends looks unlike a column that does not) is exactly what you need on screen
  while deciding destinations;
- **not inline on the node**, because a drag surface that hosts a text input is a known defect this repo
  has already refused twice: the caret and the drag handler both answer the same `mousedown`, and the
  drag wins. `WorkflowNodes.tsx`'s header cites `TaskCard.tsx` for the hazard and `TasksBoard` for the
  ruling. **This is now load-bearing in the opposite direction from before:** the node is draggable, so
  hosting a field on it would be the defect itself, not merely a bad idea. The node hosts exactly one
  interactive element, a `<button>`, and a button is not that hazard.

The panel has **two modes and three arms**, and the third arm is not "nothing selected": a node's slug →
that node's settings; nothing selected → the **Space**'s own settings (clicking empty canvas is *for*
this, and xyflow's `resetSelectedElements` does it — the canvas adds no competing handler); a **ghost**
node's id is a slug the slice cannot name, and the panel **says so** rather than silently changing
subject (`selection-unresolved`). Selection is xyflow's, read one way: the canvas holds a copy of what
`onSelectionChange` reports and never hands it back to decide what is highlighted — two owners of "what
is selected" is how a panel and a picture disagree about the same click. The re-derivation effect
**preserves** the selection when it rebuilds the node array, and that is load-bearing: a panel write
repaints the slice, which re-runs the layout, which hands xyflow a fresh array; rebuilt without the flag,
the person's keystroke would deselect the node they were typing about and swap the panel to the Space's
settings under them.

Two named costs, stated rather than papered over:

- **The keyboard gap — CLOSED by `onViewportKeyDown`, and kept here as a closed
  cost rather than deleted.** This bullet used to read *"Nothing can take a
  keyboard user from node mode back to workflow mode, because pane-click is a
  pointer gesture and the wrapper that owns Escape is not in the tab order."*
  Escape now ships: `WorkflowsCanvas.tsx`'s `onViewportKeyDown` sits on the
  viewport `<div>` — deliberately NOT on `document`, because the panel is that
  div's sibling and a document-level listener would close the panel from inside a
  half-typed rename — and calls the same `clearSelection` the Close control calls.
  Pinned by `WorkflowsCanvas.test.tsx`'s *"Escape inside the viewport clears the
  selection (the keyboard's route back)"*. It cannot reuse xyflow's own Escape
  handling, because that means re-enabling the focused wrapper whose arrow keys
  move a node without ever calling `onNodeDragStop`. The **second** half of the
  bullet stands unchanged and was never part of the gap: the Close control is
  still passed only while a node is selected, because in workflow mode it would
  clear an already-empty selection and a dead control is the shape this repo
  refuses. What remains genuinely open is the **position** verb, recorded as
  `docs/features/task-board-known-gaps.md` §10c.
- **The store's `error` cell has exactly one renderer in this view** (`NodeSettingsPanel`), the same one
  the canvas and the board read. Every refused write in either body leans on that line to explain
  itself; a field that reverts with no sentence beside it is a field that looks broken. A second error
  surface would be two answers to "what went wrong".

## 6. Fan-out is **drawn** and **NOT executed in parallel** — the honest limitation

This is the decision most likely to be misread as a feature that was built. **It was not built.** A
column with three destinations runs **one** chain.

**Why not, concretely.** `tasks.stage_slug` is a single `TEXT NOT NULL` column — a card is in exactly
one column and cannot be in two. And `workflow_runs` carries
`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_open ON workflow_runs(task_id) WHERE
finished_at IS NULL`, so **one open run per card** is enforced at the INSERT, not documented as an
intention. The partial unique index is load-bearing for the spend bound — a second open row would count
a chain against a stranger's `steps` and spend, i.e. the bound failing open — so it is not a constraint
to relax casually. Two destinations therefore cannot be two parallel Sessions on one card, and the
second edge would be a claim about money that the schema cannot keep.

**What ships instead.** `nextStepOf` follows `nextStepSlugs(columns, stage)[0]` and nothing else — the
same single answer the card's launch pill and the detail modal's buttons take. On a column whose edges
carry no name, the rest of the list is drawn as an edge and **not followed**. And the panel **says so out
loud**, because a canvas that draws three lines from a box implies three things happen and the honest
statement is that one does: `NodeDestinations` renders one element, `destination-fanout`, and
`fanOutSentence` names the followed head and the unfollowed tail by label —
`Follows <head> only. <others> are not followed. A card lives in exactly one column, so this is not
several parallel runs — the other edges only say what a drag may land on while Strict workflow is on.`
The head's own slug being unresolvable gets its own clause ("no column this read can resolve carries
that slug, so the chain follows nothing here"), because "follows a ghost" is a third answer and not the
same as "follows nothing". Pinned by the cases in `NodeDestinations.test.tsx`'s
`the destination list — the fan-out truth`.

**AMENDED by `stages.next_outcomes` (D6/D13) — the tail clause above is now conditional, and this ADR
said it was false until it was corrected here.** An edge can now carry a NAME, positionally
(`next_outcomes[i]` names the edge at `next_slugs[i]`, `null` meaning that edge names nothing), and
`mark_done` takes an optional outcome: `advise.rs` answers a claim with **the first edge whose label the
claim named**, falling back to the head only when no edge matches. So a named non-head edge **is**
followed — on a claim that names it — and "`<others>` are not followed" is true only of a column whose
edges are all unnamed. That is the ordinary case and every board that predates the column:
`next_outcomes` has no SQL `DEFAULT` and is never backfilled, so `fanOutSentence` prints the sentence
above verbatim for an unnamed set and a different one once any edge carries a name.

What did NOT move, and is the reason this is an amendment and not a retraction: **exactly one edge fires
per claim.** A name selects a door, it does not open two — `tasks.stage_slug` is still one value and
`idx_workflow_runs_open` still allows one open run per card, so §6's schema argument and the rejection of
parallel execution below both stand untouched. The panel's named-edge sentence therefore keeps the
anti-fork clause in its own words (`exactly one edge fires per claim`) rather than dropping it.
`NodeDestinations` also prints at ONE destination now, when that single edge is named, because the true
thing to say there is that the name changes nothing: with one edge, a claim that names it and a claim
that names nothing both take it. Both sentences are pinned in `NodeDestinations.test.tsx`'s
`the destination list — the fan-out truth` and `naming an edge (D6/D13)`.

**The gap this leaves, and what closing it would take.** True fork/join needs one of two things neither
of which exists here, and neither of which is a UI change:

1. **A card-fork model.** `tasks.stage_slug` becomes a membership relation (a `task_stages` join table),
   a card sits in N columns at once, and every surface that reads "the column this card is in" — the
   launch pill, the board's column grouping, `move_task`, the **Task badge**'s frozen lane — has to
   decide what N means. This is the shape that actually delivers parallel work.
2. **A join node** — an explicit edge-merging node whose semantics are "wait for all incoming". This is
   smaller than (1) in the graph model and larger in the runtime: it needs a notion of a *pending*
   arrival per card, which `tasks` and `workflow_runs` both lack, and it needs the run record to stop
   being one-open-row-per-card, which is the unique index above.

Either way the auto-chain's bounds change meaning: `spaces.auto_max_steps` and `auto_ceiling_usd` are
per **chain**, and a chain that forks is N chains. A ceiling that reads "10 steps" against a fork with
three live branches is not the bound a person set. **Filed as a gap** in
`docs/features/task-board-known-gaps.md` §10; do not re-derive it, and do not let a screenshot of a
three-line fan-out persuade anyone that parallelism shipped.

## 7. What 0119 §7 keeps, and what it loses — the supersession is **partial**

**KEPT, unchanged, and do not re-open it:** the third clause. `nextStepSlugs` and `nextStepOf` stay
**two** functions and the disagreement between them stays **preserved, not unified** — `nextStepSlugs`
*reports* an edge naming a slug the loaded columns cannot resolve (the detail modal keeps such an edge,
labels it with the raw slug, and its click lands on the skipped-column NOTE — the only surface that
explains a stale read), while `nextStepOf` *yields nothing* for the same edge (a pill has no note to
fall back on, so it would be a control whose click moves nothing). Nothing in this change touches either
verdict; the canvas still reads `nextStepSlugs` and draws the ghost node. If a future contributor reads
this ADR as "0119 §7 was wrong", that is the reading to refuse.

**KEPT, and strengthened rather than reversed:** the *principle* — one owner per fact. §3 is that
principle applied, not abandoned. Deleting the dialog is how the ruling is honoured.

**LOST:** that the canvas is read-only; that the dialog is the sole owner; and the position argument's
"no column to live in" half.

**The house mechanism, and why the front matter is empty.** This repo distinguishes a **full**
supersession — fill `superseded-by:` — from a **partial** one, where the original's front matter stays
empty and the scope is stated inline. `docs/decisions/0030-*.md` states the rule for a narrowing: *"No
`superseded-by` — a narrowing that keeps the original's decisions intact"*, and 0033 and 0033's peers
carry partial notes in their Consequences while their `superseded-by:` stays empty. **0107 is the
precedent this file copies directly**, because it is the same case: it opens *"**Supersedes ADR 0098
PARTIALLY.**"* and then names, one by one, what falls and what stands. Note that **0098's own front
matter is nonetheless filled** with `superseded-by: 0107-…`, which is the one ambiguity in the house
pattern: two readings are available and the tree contains an instance of each.

**This file therefore does both, and says which half is authoritative.** 0119's front matter is filled
with `superseded-by: 0120-…` so that a tool reading only front matter does not read §7 as live policy,
and 0119 §7 carries a partial-scope note in place naming exactly what survives — so a reader arriving
through front matter is pointed back at the surviving clause instead of at a tombstone. **The scope is
governed by the inline note, not by the front-matter line.** Filling the line while §7's third clause
stands is the 0098 precedent; the alternative reading (0030's) would leave the line empty, and a reader
who prefers it loses nothing that this file's §7 does not already state.

## Considered options

- **Keep 0119 §7 and edit it into agreement (rejected).** ADR numbers are append-only and immutable
  here — 0022 records the rule and 0057 applies it (*"It is pushed; filling `superseded-by:` and opening
  this record is the format's mechanism. Its body is history, including the refutation it got right."*).
  Rewriting §7 would also destroy the thing most worth keeping: a *measured* argument whose premises are
  now false, which is the evidence base for the rule in §1.
- **Keep the dialog as an advanced view alongside the panel (rejected).** Two owners of eight fields —
  the precise defect 0119 §7 exists to prevent. See §3.
- **Node = Skill, or one Skill feeding several columns (rejected).** Both in §2; both break on
  `tasks.stage_slug` being one string and on `stages` being the only keyed thing.
- **A modal, or fields inline on the node (rejected).** §5. A modal covers the graph you are arranging;
  a field on a draggable node is the caret-vs-drag defect this repo has refused twice.
- **Re-store positions in the front end (e.g. xyflow's own node array) instead of the database
  (rejected).** That is the drag that promises something the next render takes back — §1's own phrase —
  and it makes the arrangement a per-window fact when the workflow itself is a per-Space row.
- **A bulk "clear all positions" command (rejected).** New IPC for a nicety; one clear per positioned
  column reuses the verb that exists and re-derives per reply.
- **Execute fan-out in parallel (rejected).** The schema forbids it: `tasks.stage_slug` is one value and
  `idx_workflow_runs_open` allows one open run per card. Drawing it without saying it is not followed is
  the dishonest option this ADR's §6 exists to refuse. `next_outcomes` does not change this: an edge name
  routes one claim to one edge, and §6's amendment says which sentence the panel prints for each case.
- **Say "parallel branches, execution later" in the UI copy (rejected).** 0116 is the cautionary precedent
  in this repo for a claim sized by the wrong distribution and justified by an upstream band nobody
  verified; the same failure mode in copy is a sentence that reads as shipped. The panel states the
  limitation instead.

## Consequences

- **Two surfaces write edges now — and only ONE of them owns the rule.** `lib/workflowEdgeWrite.ts` is
  the write side of the extraction `lib/workflowGraph.ts` was the read side of, and the canvas's drag
  calls it: `isValidConnection` while the pointer is down (`canConnectStages`) and the handler at the
  drop (`nextSlugsAfterConnect`), so a self-loop reads as refused *while the line is still down*
  instead of failing after the drop. Refused, not dropped: a self-loop (`BoardError::SelfLoop`), an
  endpoint the slice cannot name, and a destination the list already holds. `nodesConnectable` is real
  only because both node components forward `isConnectable` into all three of a `<Handle>`'s
  connectability props; a `Handle` that does not forward it is a handle that cannot connect.

  **This bullet claimed the panel re-spelled the rule, and that is now FALSE — the fix landed.**
  It is kept here, amended rather than deleted, because the correction is the evidence for why this
  ADR's subject matters. Measured on the tree as it now stands: `grep -rln workflowEdgeWrite src/ |
  grep -v '\.test\.'` answers **two** files — `WorkflowsCanvas.tsx` and `NodeSettingsBody.tsx` — and
  `NodeSettingsBody.tsx`'s `addDestination` calls `nextSlugsAfterConnect(columns, stage.slug,
  destination)` while its `candidates` filter calls `canConnectStages`. So the one-owner sentence this
  bullet carried before the correction is TRUE again, and it is restored below.

  **What the two spellings did NOT agree on, which is why the duplication mattered.** The old inline
  `addDestination` (`const current = stage.nextSlugs ?? []; if (current.includes(destination)) return;`)
  refused a duplicate and appended, and it refused a self-loop only by *omission* — the `candidates`
  filter dropped `stage.slug` from the list the `Select` offers, so the control could not express one.
  `canConnectStages` refuses the self-loop as a *verdict*, and additionally checks that BOTH endpoints
  exist in the loaded columns. Storage refused both anyway, so the behaviour a user saw was the same;
  the defect was the drift — a rule change reaching the drag and not the panel.

  **The one-owner sentence, restored, with its pin.** `lib/workflowEdgeWrite.ts` owns the rule and BOTH
  surfaces call it: the canvas's drag (`isValidConnection` → `canConnectStages` while the pointer is
  down, `onConnect` → `nextSlugsAfterConnect` at the drop) and the panel's destination `Select`
  (`NodeSettingsBody`'s `addDestination` → `nextSlugsAfterConnect`, its `candidates` → `canConnectStages`).
  Name the file precisely: the `Select` WIDGET is `NodeDestinations.tsx`, which takes `onAdd`/`onWrite`
  as props and imports no rule at all; the rule call is one level up in `NodeSettingsBody.tsx`, which
  holds the loaded slice. A header that credits the widget is close enough to read and wrong enough to
  send a reader to the wrong file.

  This claim is pinned, which is what the previous version of this bullet asked for by name: an
  assertion that the panel imports `workflowEdgeWrite` is what makes it non-vacuous, since nothing in
  `tsc`, `vite build` or `vitest` can see a re-spelled rule. The pin is
  `NodeSettingsBody.test.tsx`'s *"imports the edge rule rather than re-spelling it (the module's reason
  for existing)"* — it reads the source, strips comments first (on `tauriBoundary.test.ts`'s
  needle-counts-prose trap: this file's own prose quotes the old spelling), and requires the import plus
  both call sites. That guard is not decoration: a mutation reverting `addDestination` to the inline
  spelling leaves every BEHAVIOUR case green, because the picker only offers what the rule accepts.
  **If the pin is ever deleted, this sentence goes stale on the same day it does.**
- **Neither write touches xyflow's own arrays.** The store echoes, `graph` re-derives, the effect hands
  xyflow the answer — one direction, always. This is what makes the optimistic paint and the persisted
  position the same fact rather than two.
- **No cycle guard on an edge, and that is now reachable by drag.** `nextSlugsAfterConnect` refuses
  self-loops, unknown endpoints and duplicates; it does **not** refuse `A → B → A`. Before this change
  the only writer was the destination `Select`; a drag makes a cycle easier to draw by accident. The
  auto-chain cannot run away from it — the bounds are judged in Rust inside `workflow_run_step` (ADR
  0119 §2) and a tripped bound closes the run (§3 there) — so the consequence is a chain that spends up
  to its bound and stops, not an infinite loop. **`grep -rn -i 'cycle' src/lib/workflowEdgeWrite.ts
  src/store/workflowChain.ts src/lib/workflowGraph.ts` returns no cycle-prevention code and no test
  naming one**, which is the honest state and is filed in known-gaps §10. Do not "fix" this by adding a
  refusal without deciding whether a deliberate loop-back workflow is legal; that is a decision, not a
  bugfix.
- **`nodesFocusable` stays off, and one thing is genuinely lost by it.** Each node has exactly one tab
  stop, its own `<button>`, and Enter on a focused node opens its settings — the stop does something
  real. What the wrapper's keys would have added, arrow-key nudging, is not "lost": it is *not the
  persisting verb*. Arrow keys move a node without ever calling `onNodeDragStop`, so they move it for
  the view and not for the database. **Dragging is the verb that persists**, and a keyboard-only user can
  reach every field, every destination and every refusal — but cannot persist an arrangement. That is a
  real gap and is filed, not glossed.
- **The gate count is 19, not 17.** `grep -c "gate(&mut conn, " src-tauri/src/storage/db/mod.rs` reads
  **19** at this tip and **17** at `main`; this change adds exactly the `stages.position_x` and
  `stages.position_y` pair. ADR 0119 §1's 13 → 17 series is **correct for its own branch** and is not
  amended here — a dated figure is evidence, not a contradiction. 0119's Consequences carry the
  revert-safety argument for the four columns that branch added; **the same argument covers these two**
  and was not written down for them, so it is here: both arrive through `gate()`'s
  `pragma_table_info` probe, nothing drops them, `STAGE_COLUMNS` is an **explicit** list (now
  `[&str; 11]`, `STAGE_ROW_FIELDS: 11`, tied at compile time and drift-guarded by
  `stage_row_from_maps_the_select_const_columns_in_order` and its siblings), and there is no positional
  read or write anywhere — `grep 'SELECT \*' src-tauri/src` returns **2** hits and **both are prose** in
  `storage/db/rows.rs`, the comment that states the rule (the one place the needle appears; ADR 0119's
  "zero hits at all" was true of its own tree and of the production SQL, and this is the same
  needle-counts-prose trap the command-count bullet above names). So a build that predates these two
  columns opens a database that carries them, present and inert, with no positional read for a third
  column to break.
- **The command count is 26, and the grep needle matters.**
  `grep -c '#\[tauri::command\]' src-tauri/src/commands/tasks.rs` reads **26** here and **25** at `main`;
  `set_stage_position` is the only command this change adds. Use the **bracketed** needle: the bare
  `grep -c 'tauri::command'` reads **27** here, because this file's own header now spells the counting
  command in prose. That is the trap `tauriBoundary.test.ts` records — a doc-comment that reproduces a
  grep needle makes the grep count prose — and it is why the figures in this ADR are quoted with their
  exact needles. The known-gaps file's header carries the older unbracketed figures (19 at `main`, 26
  after ADR 0119's branch); both were true of their own tree and of the needle used.
- **The canvas is now the board's configuration surface.** Nothing moved into the **Task board**: the
  board still shows columns and cards, and the settings panel is on the canvas view only. The board's
  `Configure` door is the dialog's former home and the dialog is gone, so what the door opens is
  whichever surface the rewiring assigns it — **that rewiring is deliberately not settled in this ADR**,
  because it is a wiring question about one button and this ADR's subject is who owns the fields (answer:
  `NodeSettingsPanel`, and after the deletion there is no candidate for a second owner). A reader who
  wants to edit a column should find exactly ONE door that works; if they find two, that is the leftover
  of the transition and worth reporting, not a design.
- **`docs/features/task-board-known-gaps.md` gains §10** for the fan-out limit, the cycle gap, and the
  keyboard-only-position gap; §9a and §9c are **not** closed by this change and are amended only where
  this change makes a sentence there read falsely.
- **Reverting this change is safe, in the same four ways 0119's Consequences argue, and the same one way
  it is not.** Safe: the two columns arrive through `gate()` and nothing drops them; the read and write
  are explicit-column; `set_stage_position` is one command whose `generate_handler!` entry can be removed
  with its TypeScript callers in the same revert; and a database whose `position_x` is set is simply a
  database whose positions a reverted build ignores — **the arrangement is preserved so a re-land resumes
  where the person left it**, which is the correct rollback semantic rather than a silent one. Not safe,
  and unchanged: `workflow_runs` still has no deleter (known-gaps §9c), and this change neither fixes nor
  worsens it — `grep 'DELETE FROM workflow_runs'` over `src-tauri/src` reads **zero** hits.
- **What would refute this decision.** Two things, and both are observable rather than arguable. If a
  second owner of the per-column fields reappears — the dialog re-added, or any new surface writing the
  eight fields through its own state — then 0119 §7's objection is *live again* and this ADR is wrong on
  its own terms, because §3's whole case was that the panel is the only owner. The check is a grep and not
  an opinion: `grep -rln 'setStageAuto' src/components --include=*.tsx | grep -v test` should name
  `workflows/NodeSettingsBody.tsx` (the owner) and `workflows/NodeSettingsPanel.tsx` (the shell, which
  holds the action only to hand it down) and NOTHING outside the panel — and the same shape holds for
  `setStagePosition`, whose only non-test component is `workflows/WorkflowsCanvas.tsx`, because that write
  belongs to the picture and not to the form. And if hand-arranged
  positions drift so far from the graph that the picture is unreadable and Tidy up becomes the control
  people reach for out of despair rather than choice, then 0119's "second answer to what this workflow
  is" objection has been *earned* rather than answered, and the right response is to narrow persistence,
  not to defend it.
