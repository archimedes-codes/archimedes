/**
 * THE SHARED SURFACE OF THE STAGE ROWS — the three class strings a Stage row's
 * control clusters are drawn from.
 *
 * The bar is `spaces/sessionRowStyles.ts`'s own, and it is a bar rather than a
 * tidiness preference: **a const with more than one consumer and no single
 * component that owns all of them has to have ONE owner, or the consumers
 * drift.** A tenth site is a copy-paste away from a half-step-quieter colour or a
 * different height, and this repo has no linter or formatter to notice (see
 * `AGENTS.md`: `tsc` + `vite build` + `vitest` are the whole gate), so the drift
 * would be invisible to every check that runs.
 *
 * WHICH OF THESE THREE CLEAR THE BAR, measured rather than assumed — the same
 * honesty `sessionRowStyles.ts` brings to its own three:
 *
 *  - `ROW_SELECT` clears it outright: 3 sites in 2 FILES — the Skill trigger and
 *    the delete-picker's destination trigger (both in `StageRow`) and the
 *    add-destination trigger (`stages/StageDestinations`). This is the const this
 *    file exists for.
 *  - `CONTROL_ROW` (2 sites) and `ROW_BUTTON` (4 sites) have MULTIPLE consumers,
 *    but all of them are inside `StageRow.tsx` — they do NOT clear the two-file
 *    bar today. They are here because they are the other two pieces of the same
 *    control cluster (the row's control line, and the affordance drawn on it) and
 *    because `StageDestinations` is the first cut of that cluster out of the row;
 *    the next one moves them with it. A reviewer applying the bar strictly should
 *    read this note rather than assume a missed move — and should move them back
 *    into `StageRow.tsx` if the cluster turns out to stay there.
 *
 * `STAGE_ROW` deliberately does NOT live here: it has exactly one consumer, in
 * `StageRow.tsx`, and it stays there. That is the same bar applied in the other
 * direction — this file is not where a const goes because it is a const.
 *
 * The doc comment on each const is the argument for why the string is spelled
 * that way. They came across with the consts they document; read them before
 * changing a string.
 */

/** A row's control cluster: a quiet row of small affordances under the fields. */
export const CONTROL_ROW = "flex min-w-0 flex-wrap items-center gap-1";
/** The one affordance shape a row nests: `Button variant="ghost"` at the smallest
 *  icon size, so a row of them stays quieter than the fields they act on. */
export const ROW_BUTTON =
  "shrink-0 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground";
/** The nested `Select`s are the narrow variant so a row of three fits the dialog. */
export const ROW_SELECT = "h-6 w-36";
