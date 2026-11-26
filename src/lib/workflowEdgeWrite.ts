import { nextStepSlugs } from "./workflowGraph";
import type { StageDto, StageWithTasks } from "./tauri";

/**
 * The write behind **an edge on the Workflows canvas**, as a pure function: given a
 * board and one proposed hop, what `next_slugs` should hold afterwards — or `null` for
 * "refuse, write nothing".
 *
 * ## WHY A MODULE AND NOT A HANDLER IN THE CANVAS
 *
 * Two surfaces make this write and the rule must have one owner:
 *
 *  - `NodeSettingsBody` in the settings panel — it owns the destination `Select`'s write
 *    (`addDestination` → `nextSlugsAfterConnect`) and its option set (`candidates` →
 *    `canConnectStages`), reachable by keyboard. The `Select` WIDGET itself is
 *    `NodeDestinations.tsx` and it holds no rule at all: it takes `onAdd`/`onWrite` as
 *    props, so naming it as this module's caller is the near-miss that points at the
 *    wrong file;
 *  - a drag from one node's source handle to another's target handle — the pointer's
 *    route to the same write.
 *
 * Both arms are pinned, not merely asserted: `NodeSettingsBody.test.tsx` reads that file's
 * source with comments stripped and requires the import plus both call sites, because a
 * re-spelled rule is invisible to `tsc`, `vite build` and every behaviour case — the picker
 * only offers what the rule accepts, so both spellings answer identically until they drift.
 *
 * `src/lib/workflowGraph.ts` exists because the READ of `next_slugs` was spelled three
 * times and drifted into a defect; this is the same extraction on the write side. The
 * canvas asks twice — `isValidConnection` while the pointer is down, this at the drop —
 * because a refusal that only happens at the end is a gesture that silently does
 * nothing, and the reason for it lives nowhere.
 *
 * ## The three answers `nextSlugs` holds, and the collapse this refuses (ADR 0099)
 *
 * `null` is UNCONFIGURED (unconstrained; the fallback is the column at `sortOrder + 1`)
 * and `[]` is CONFIGURED-AND-CLOSED (it leads nowhere). Appending to either yields the
 * one-item list `[target]`, and that is the coherence the rest of the app depends on:
 * `nextStepSlugs` answers the row's own list whenever it has one, so a column whose
 * first-ever destination was drawn by drag has exactly the destinations on the canvas —
 * the launch pill and the auto-chain follow the drawn edge and not the neighbour. There
 * is no arm here that writes `null`, and none that writes `[]`: a drag always names a
 * destination, so the result is always a non-empty list.
 *
 * ## What configuring a `null` column COSTS, stated where the write is made
 *
 * A drag out of a `null` column is not "adds a wire". It is a column changing contract,
 * and three things go with it that the payload does not show:
 *
 *  - **the fallback wire is removed.** `nextStepSlugs` stops answering `sortOrder + 1`,
 *    so the column that used to receive the cards by order now receives none. One drag
 *    deletes a step of a chain the person may never have drawn but was using;
 *  - **the chain is repointed.** `nextStepOf` takes `nextStepSlugs(…)[0]`, so the launch
 *    pill, the detail modal's buttons and the auto-advance runtime all begin sending
 *    cards to the newly named column instead;
 *  - **Strict workflow narrows, and not reversibly.** On a `board_strict = 1` Space
 *    `NULL` permits *any* outgoing move and `[target]` permits only `target`. Known-gaps
 *    §8 records that this cannot be undone from the UI, because `[]` (closed) is not
 *    `NULL` (unconfigured) and nothing writes `null` again.
 *
 * Two mitigations ship with this, and neither is decorative:
 *
 *  1. the inferred wire is DRAWN differently — `IMPLICIT_EDGE_CLASS` /
 *     `IMPLICIT_EDGE_STYLE` in `workflowGraphLayout.ts` dash it — so the wire a drag is
 *     about to remove is visibly one the graph inferred, not one somebody saved;
 *  2. the gesture that would change NOTHING VISIBLE is refused outright (next section).
 *     That is the case where the cost is entirely hidden, and it is the one the review
 *     measured: dragging the already-drawn fallback wire used to be accepted, write
 *     `[target]`, and leave the picture byte-identical.
 *
 * ## What is REFUSED rather than dropped
 *
 *  - a SELF-LOOP: `set_stage_next` refuses a column's own slug (`BoardError::SelfLoop`,
 *    `kind: "not_found"`), so drawing one paints an edge the server rejects one frame
 *    and reverts the next;
 *  - an endpoint the loaded slice cannot name (a ghost node) — the same command refuses
 *    an unknown slug, so the drag can only fail;
 *  - a destination the list ALREADY holds: the person asked for the edge that is already
 *    there, and two identical ids in one `edges` array make xyflow render one and warn;
 *  - **the fallback re-drawn**: an UNCONFIGURED source (`nextSlugs === null`) dropped onto
 *    the very column `nextStepSlugs` already answers for it. Nothing on screen would change
 *    and the write would flip the Strict contract above with no signal at all, so it is
 *    refused. Refusing loses nothing — the wire the gesture aims at is already drawn — and
 *    a person who wants to configure the column drops onto any OTHER column, which is a
 *    visible edit with a visible before-and-after.
 *
 * ADR 0099's `[]` is deliberately NOT refused — dragging out of a box that says *Leads
 * nowhere* is precisely how a person changes their mind about it.
 *
 * This lives under `lib/` because it is a pure derivation over the columns the caller
 * already holds; it imports `StageWithTasks` as a TYPE only, which is what keeps the
 * upward-edge rule in `src/lib/layerBoundary.test.ts` intact (a runtime import of
 * `store/tasks` from here would be the inverted edge that guard refuses).
 */

/** Can this board hold a hop from `source` to `target`? The answer is the same one the
 *  write below makes, so the connection line a drag paints and the payload the drop
 *  sends cannot disagree.
 *
 *  `outcome` is the NAME the new edge would carry, or `null`/absent for "it names
 *  nothing". It is a LABEL and not a permission: it never unlocks a self-loop or a
 *  ghost endpoint, because `set_stage_next` refuses those whatever the label says.
 *  What it does change is the duplicate rule — see `isDuplicateEdge`. */
export function canConnectStages(
  columns: readonly StageWithTasks[] | undefined,
  source: string,
  target: string,
  outcome: string | null = null,
): boolean {
  if (source === target) return false;
  const from = columns?.find((c) => c.stage.slug === source);
  const to = columns?.find((c) => c.stage.slug === target);
  if (from === undefined || to === undefined) return false;
  // THE NO-OP GESTURE, refused. When the source is UNCONFIGURED the canvas has already
  // drawn the `sortOrder + 1` wire to it — as an inferred edge (`IMPLICIT_EDGE_CLASS` in
  // `workflowGraphLayout.ts`) — so a drop on that same target changes nothing on screen
  // while the write below would store `[target]`. That is a narrowing with no signal: on a
  // `board_strict = 1` Space `NULL` permits any outgoing move and `[target]` permits only
  // `target` (ADR 0099), and known-gaps §8 records it is not reversible through the UI.
  // Refusing loses nothing, because the wire the gesture is aiming at is already drawn.
  //
  // `nextStepSlugs` is ASKED rather than the neighbour re-derived from `sortOrder`, so the
  // refusal tracks the one derivation the pill, the modal and the runtime use — and the
  // `[0]` is deliberate: that is the column `nextStepOf` sends a card to, i.e. the one
  // whose wire is on the canvas.
  //
  // A NAMED edge is exempt, and it is exempt for a reason rather than by accident: this
  // refusal rests entirely on "nothing on screen would change", and an edge that arrives
  // carrying a label DOES change the picture — it gains that label
  // (`workflowGraphLayout.ts` sets `Edge.label`). The other two reasons the no-op is
  // refused (it stores a list, it narrows Strict) are the price of configuring a column at
  // all, and a person naming an edge to their inferred neighbour is paying it on purpose.
  if (
    outcome === null &&
    from.stage.nextSlugs === null &&
    nextStepSlugs(columns, from.stage)[0] === target
  )
    return false;
  // `null` (no list yet) and `[]` (configured to stop) both read as "holds nothing", so
  // `?? []` is the join here — NOT the `?? fallback` that `nextStepSlugs` must avoid.
  // This side is asking "is it already in the list", and both empties answer yes-it-isn't
  // identically; only the READ can confuse the two.
  return !isDuplicateEdge(from.stage, target, outcome);
}

/** Is the proposed edge one this column ALREADY holds?
 *
 *  It used to be `nextSlugs.includes(target)`, and the destination alone was the whole
 *  question because two edges to one column could not mean two different things. `D6`
 *  changed that: `advise.rs` picks "the first edge whose LABEL is the outcome the claim
 *  named", so `["done","done"]` labelled `["failed","success"]` is a review column that
 *  routes two ways, and it is legal data — `set_stage_next` validates each element names
 *  a real column and is not the column itself, and it never checks the list for repeats.
 *  Refusing the pair here would make that whole capability unreachable from both surfaces.
 *
 *  What stays refused is the case that is still a duplicate: the same destination with
 *  the same name, or two unnamed edges to one destination. Two edges whose `edgeIdOf`
 *  value collides is exactly what makes xyflow render one and warn, and a name that is
 *  already taken can never fire — `advise.rs` finds the FIRST match, so the second edge
 *  would look routed and never route. A control that can only produce a dead edge is the
 *  dead-control shape this repo refuses, which is why the refusal moved from the
 *  destination to the pair rather than going away. */
const isDuplicateEdge = (
  from: StageDto,
  target: string,
  outcome: string | null,
): boolean =>
  edgeOutcomesOf(from).some(
    (label, index) =>
      from.nextSlugs?.[index] === target &&
      (outcome === null ? label === null : label === outcome),
  );

/** The nine edge names `mark_done` offers a model, in picker order.
 *
 *  **This list is a MIRROR and it is allowed to drift, so read where it comes from before
 *  changing it:** `src-tauri/src/agent/host_tools/specs.rs`, the `mark_done` `ToolSpec`'s
 *  `parameters.properties.outcome.enum`. Nothing pins the two together on purpose —
 *  `src/lib/ipc/events.test.ts` records at length why a `readFileSync("src-tauri/…")`
 *  source-text grep from a frontend test is a landmine with no detection value, and this
 *  is a frontend file.
 *
 *  Drift here is HARMLESS BY CONSTRUCTION, which is what makes mirroring acceptable:
 *  these are SUGGESTIONS in a picker, not a validator. `next_outcomes` has no `CHECK` and
 *  `set_stage_next` does not validate a label against any list, so a name outside this
 *  array still writes and still routes; and a model that sends a name no edge carries is
 *  not refused either — `advise.rs` falls back to the head and says so, because an
 *  unlabelled board is the ordinary case and an invented name must not stall a chain. So
 *  the worst a stale mirror does is omit a suggestion, never refuse a valid one.
 *
 *  `ready` and `review` are NOT here and both absences are measured, not taste: the
 *  host-tool name ban forbids any name containing `read`, and `review` contains it
 *  (`r-e-v-i-e-w`). `specs.rs` carries the same note for the same reason. */
export const EDGE_OUTCOME_SUGGESTIONS = [
  "done",
  "failed",
  "error",
  "success",
  "blocked",
  "partial",
  "finished",
  "complete",
  "handoff",
] as const;

/** This column's edge labels, POSITIONAL to `nextSlugs`, padded to its length.
 *
 *  The ONE owner of the positional read, spelled once for the same reason the rest of
 *  this module exists: `advise.rs` reads a short cell as "the edges past its end are
 *  unlabelled", `StageDto.nextOutcomes`'s docblock says the same, and a frontend that
 *  padded differently would paint a label on the wrong edge — which is a card advancing
 *  on the wrong claim, the exact failure `EdgeOutcomeCount` refuses at rest.
 *
 *  Three inputs, three answers, and none of them is `[]` by accident:
 *   - `nextSlugs: null` → `[]`. An unconfigured column's only wire is the inferred
 *     `sortOrder + 1` neighbour, which holds NO INDEX in `next_slugs`, so there is no
 *     position a label could sit at.
 *   - `nextOutcomes` null/absent/short → one `null` per edge past the end. `null` is the
 *     only spelling of "this edge names nothing"; `undefined` is not a JSON value and
 *     `""` would be a label that renders as nothing.
 *   - a longer cell than the slug list → TRUNCATED to it. The write refuses that shape,
 *     so it is only reachable from a stale read, and an extra label has no edge to paint.
 *
 *  `?? []` here is the join of two empties, the same legitimate use this module's
 *  `canConnectStages` makes. It is NOT the `?? []` the panel's negative pin bans: that
 *  one collapses `nextSlugs: null` (unconfigured) into "no destinations", which is a
 *  different fact. This function never reads `nextSlugs` as a list of destinations — it
 *  reads it for its LENGTH, and `null` has already returned `[]` above. */
export function edgeOutcomesOf(
  stage: StageDto,
): (string | null)[] {
  const slugs = stage.nextSlugs;
  if (slugs === null) return [];
  const stored = stage.nextOutcomes ?? [];
  return slugs.map((_, index) => stored[index] ?? null);
}

/** The whole positional label list to write for a hop from `source` to `target`, or
 *  `null` for "refuse — write nothing".
 *
 *  THE PRESERVE RULE, and it is the reason this function exists rather than a
 *  convenience. `setStageNext`'s 4th argument is optional and defaults to
 *  `slugs.map(() => null)`, so omitting it does not mean "leave the labels alone", it
 *  means "this write labels nothing" — every existing name on the column goes away. Both
 *  surfaces below append one edge, so both must send the stored labels plus the new one
 *  or a person adding a second destination silently un-names the first. That is data loss
 *  dressed as an add, and it is why the label list is derived HERE, beside the slug list,
 *  instead of at the two call sites.
 *
 *  There is no arm that writes `null` and none that writes a short list, for the same
 *  reason `nextSlugsAfterConnect` has none: `set_stage_next` refuses
 *  `outcomes.length !== slugs.length` with `EdgeOutcomeCount` before it writes anything. */
export function nextOutcomesAfterConnect(
  columns: readonly StageWithTasks[] | undefined,
  source: string,
  target: string,
  outcome: string | null = null,
): (string | null)[] | null {
  if (!canConnectStages(columns, source, target, outcome)) return null;
  const from = columns!.find((c) => c.stage.slug === source)!;
  return [...edgeOutcomesOf(from.stage), outcome];
}


/** The whole ordered list to write for a hop from `source` to `target`, or `null` for
 *  "refuse — write nothing".
 *
 *  Whole-list and not one edge because that is the shape `set_stage_next` takes: the
 *  destinations are an ordered list and `[0]` is the live edge, so an append is "keep
 *  every destination I already chose, in the order I chose them, and add this one
 *  last".
 *
 *  `outcome` exists so the VERDICT matches the label write beside it — it does not go
 *  into the list, because `next_slugs` holds destinations and never names. */
export function nextSlugsAfterConnect(
  columns: readonly StageWithTasks[] | undefined,
  source: string,
  target: string,
  outcome: string | null = null,
): string[] | null {
  // The SAME predicate with the SAME arguments as `nextOutcomesAfterConnect`, which is
  // what makes "one owner" true rather than aspirational: the two derivations ask one
  // question, so there is no reachable state where the slug list is accepted and the
  // label list refused (a state that would write a destination with no slot for its
  // name, i.e. the `EdgeOutcomeCount` refusal and an error line for an offered gesture).
  if (!canConnectStages(columns, source, target, outcome)) return null;
  const from = columns!.find((c) => c.stage.slug === source)!;
  return [...(from.stage.nextSlugs ?? []), target];
}
