import type { StageDto, StageWithTasks } from "./tauri";
import type { TaskLaunchDestination } from "./taskPrompt";

/**
 * The ONE derivation of "where does a card in this column go next".
 *
 * ## Why this exists as a module and not as two components' local functions
 *
 * `TasksBoard.tsx` (`nextStepOf`, the card's launch pill) and `TaskDetailDialog.tsx`
 * (`edges`, the modal's buttons) each spelled this derivation themselves, and
 * `TasksBoard.tsx` said so in its own comment rather than hiding it: "Deliberately
 * the same derivation `TaskDetailDialog` runs, spelled twice rather than hoisted into
 * `lib/` … **If a third surface grows the same need, that helper is the extraction to
 * make.**"
 *
 * The auto-advance runtime (`store/workflowChain.ts`) is that third surface: a column
 * with `auto: true` moves its card to *the column this one points at*, which is the
 * same question the pill and the modal buttons already answer. So the extraction
 * happened, both components now import it, and their local copies are deleted. This
 * file is what pins the semantics; the two components' own suites are what prove the
 * extraction did not change what they render.
 *
 * ## The shape of the signature, and why the columns are an argument
 *
 * Both call sites already held the columns locally — the board reads
 * `useTasks((s) => s.boardsBySpace[spacePath])` and so does the modal — so the helper
 * takes them. That is also forced, not merely convenient: `src/lib/layerBoundary.test.ts`
 * forbids a module under `lib/` runtime-importing a module under `store/`, so a helper
 * that reached for the slice itself would be an inverted layer edge, and the "pure"
 * module would own store state. `readonly StageWithTasks[] | undefined` is exactly
 * what both already had in hand.
 *
 * ## The three answers `next_slugs` holds, and the collapse to avoid (ADR 0099)
 *
 *  - `["a", "b"]` — configured. The row's OWN order decides, and the FIRST entry is
 *    the primary (spec §7.1). Not re-sorted: the author of the row made that choice.
 *  - `null` — UNCONFIGURED, i.e. unconstrained. Falls back to the column at
 *    `sortOrder + 1`, which is what keeps a launch control alive on every board that
 *    predates the graph (the migration backfills, but a Space never read has no rows
 *    to backfill from).
 *  - `[]` — configured, and it **leads nowhere**. A person's decision, and it yields
 *    NOTHING.
 *
 * `null` and `[]` are therefore different facts, and the operator that keeps them
 * apart is `??` and not `||`: an empty array is truthy, so `nextSlugs ?? fallback`
 * leaves it alone while `nextSlugs || fallback` reads "stop here" as "no opinion" and
 * manufactures the edge that was deleted. On a launch pill that is a button that
 * should not exist; under the auto-advance runtime it is a card that moves on its own
 * with no path to the column it moved into. Pinned case-by-case in
 * `workflowGraph.test.ts`.
 *
 * ## The two functions, because the two surfaces disagree on an UNRESOLVABLE edge
 *
 * An edge naming a slug the columns do not hold (a column deleted in another window,
 * or a slice that has not refreshed) is not one answer:
 *
 *  - [`nextStepSlugs`] reports the slug. The detail modal KEEPS such an edge and
 *    labels it with the slug — "we could not name it" is a different claim from "it
 *    has no column" — and the click that follows lands on `store/taskLaunch`'s
 *    skipped-column NOTE, which is the surface that explains the stale read. Dropping
 *    the edge would delete a working button on a stale read and leave that note with
 *    no path to a user at all.
 *  - [`nextStepOf`] yields nothing. A pill has no note to fall back on, so it would be
 *    a control whose click moves nothing while the sentence explaining why sits on a
 *    different surface entirely.
 *
 * That disagreement is the two components' own, and it predates this file. Hoisting
 * the derivation is not the same as unifying the verdicts, so both are kept and each
 * is documented here rather than being silently merged into whichever is easier to
 * spell.
 */

/** Every column the graph says a card in `from` may move to, in the row's order.
 *
 *  Slugs and nothing else — resolution is the caller's business, and the two
 *  callers resolve differently (see the header). An empty array means the SAME thing
 *  here as on the wire: either this column is configured to lead nowhere, or it is
 *  unconfigured and there is no column at `sortOrder + 1`. Both are "no next step";
 *  what this function will NOT do is invent one.
 *
 *  `columns` is `undefined` for "the board was never loaded", which is not "no
 *  columns" and does not make the fallback safe — it yields nothing. */
export function nextStepSlugs(
  columns: readonly StageWithTasks[] | undefined,
  from: StageDto,
): string[] {
  // `??` and not `||` — see the header. `[]` is a value, not a gap.
  return (
    from.nextSlugs ??
    (columns ?? [])
      .filter((c) => c.stage.sortOrder === from.sortOrder + 1)
      .map((c) => c.stage.slug)
  );
}

/** The column at the head of [`nextStepSlugs`], as the destination a launch takes.
 *
 *  `undefined` is "no next step": no edge, an edge configured away by `[]`, or an
 *  edge whose row the loaded columns cannot resolve. Every field of the result comes
 *  from the SAME row, which is what ADR 0098 is for — the Skill the Session loads,
 *  the label the instruction sentence names, and the column's extra prompt cannot
 *  disagree about which column was meant.
 *
 *  `launches` is deliberately absent: it is `SAVE_ONLY`'s field (the New Task modal's
 *  save-only button) and no column the graph points at is ever that, so a destination
 *  resolved from a row has nothing to say about it. */
export function nextStepOf(
  columns: readonly StageWithTasks[] | undefined,
  from: StageDto,
): TaskLaunchDestination | undefined {
  const slug = nextStepSlugs(columns, from)[0];
  if (slug === undefined) return undefined;
  const stage = columns?.find((c) => c.stage.slug === slug)?.stage;
  return stage === undefined
    ? undefined
    : {
        slug: stage.slug,
        label: stage.label,
        onEnterSkill: stage.onEnterSkill,
        promptPrefix: stage.promptPrefix,
      };
}
