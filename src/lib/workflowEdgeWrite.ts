import { nextStepSlugs } from "./workflowGraph";
import type { StageWithTasks } from "./tauri";

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
 *  sends cannot disagree. */
export function canConnectStages(
  columns: readonly StageWithTasks[] | undefined,
  source: string,
  target: string,
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
  if (
    from.stage.nextSlugs === null &&
    nextStepSlugs(columns, from.stage)[0] === target
  )
    return false;
  // `null` (no list yet) and `[]` (configured to stop) both read as "holds nothing", so
  // `?? []` is the join here — NOT the `?? fallback` that `nextStepSlugs` must avoid.
  // This side is asking "is it already in the list", and both empties answer yes-it-isn't
  // identically; only the READ can confuse the two.
  return !(from.stage.nextSlugs ?? []).includes(target);
}

/** The whole ordered list to write for a hop from `source` to `target`, or `null` for
 *  "refuse — write nothing".
 *
 *  Whole-list and not one edge because that is the shape `set_stage_next` takes: the
 *  destinations are an ordered list and `[0]` is the live edge, so an append is "keep
 *  every destination I already chose, in the order I chose them, and add this one
 *  last". */
export function nextSlugsAfterConnect(
  columns: readonly StageWithTasks[] | undefined,
  source: string,
  target: string,
): string[] | null {
  if (!canConnectStages(columns, source, target)) return null;
  const from = columns!.find((c) => c.stage.slug === source)!;
  return [...(from.stage.nextSlugs ?? []), target];
}
