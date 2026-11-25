/**
 * THE SHARED SURFACE OF THE WORKFLOW SETTINGS PANEL — the class strings more than
 * one part of the panel is drawn from.
 *
 * THE BAR, STATED AS IT IS ACTUALLY APPLIED. The rule this file is supposed to obey
 * is the one `spaces/sessionRowStyles.ts` states in its own header: **a const with
 * consumers in more than one FILE has to have ONE owner, or the consumers drift** —
 * and its mirror, a const with exactly one consumer stays in that consumer. This
 * repo has no linter or formatter (AGENTS.md: `tsc` + `vite build` + `vitest` are
 * the whole gate), so a copy-pasted half-step-quieter colour is invisible to every
 * check that runs; that is why the bar exists at all.
 *
 * MEASURED, AND ONE OF THESE FOUR CONSTS DOES NOT CLEAR THE BAR IT SITS IN. Re-run
 * `grep -rln '\bPANEL_<NAME>\b' src/` per const and compare the FILE count, not the
 * site count — the rule counts consumer files:
 *
 *  - `PANEL_SELECT` clears it: 2 FILES (`NodeSettingsBody.tsx` and
 *    `NodeDestinations.tsx`), several sites between them — the Skill trigger, the
 *    delete picker's destination trigger and the add-destination trigger. It is the
 *    same geometry the dialog's `ROW_SELECT` carried, deliberately: the panel takes
 *    those fields over from the dialog, and a field that changes width in the
 *    transfer is a restyle nobody asked for.
 *  - `PANEL_ROW`, `PANEL_BUTTON` and `PANEL_SECTION` do **not** clear it. Each has
 *    several sites and exactly ONE consumer file, `NodeSettingsBody.tsx`.
 *
 * So three of the four consts here are where the bar says they should not be, and
 * the honest statement is that they are **placed for a reason the bar does not
 * cover**, not that they satisfy it. That reason: they are the other three pieces of
 * the SAME control cluster as `PANEL_SELECT` — a labelled group, the row inside it,
 * the small affordance on that row, the narrow `Select` in it. Splitting the cluster
 * so three consts move into `NodeSettingsBody.tsx` and one stays here would leave a
 * reader comparing a component's local consts against an imported one to style four
 * adjacent elements of one control, which is the drift this file exists to prevent,
 * arriving by way of a rule-following move. The alternative reading — that the bar is
 * the whole rule and a four-const cluster is not a reason — would move all four into
 * `NodeSettingsBody.tsx` and delete this file; `NodeDestinations` would then import
 * `PANEL_SELECT` from a sibling body component, which is its own coupling. Neither
 * is obviously better, so the placement stands and the deviation is named here
 * instead of being argued away.
 *
 * WHAT THAT MEANS FOR A READER, concretely: if you extract a second body component
 * and it needs one of these three, the const is already in the right place and no
 * move is owed. If instead `NodeSettingsBody.tsx` is the only reader for the last
 * time, moving that const back into it is the correct move and this file shrinks —
 * `PANEL_SELECT` is the only one of the four with a second file to justify it today.
 *
 * TWO THINGS THAT DELIBERATELY DO NOT LIVE HERE, each because it has exactly one
 * consumer file and the bar's mirror half sends it to that consumer:
 *
 *  - `PANEL_TITLE`, `PANEL_FRAME` and `PANEL_SCROLLER` are in
 *    `NodeSettingsPanel.tsx`, the only file that reads them;
 *  - `GUARD_ROW` and its four siblings (`GUARD_GROUP`, `GUARD_LABEL`,
 *    `GUARD_FIELD`, `GUARD_BUTTON`) are in `AutoChainGuards.tsx`, which carries them
 *    at the site. That file is the in-repo example of the pattern this paragraph
 *    applies: five consts, one consumer, kept at the consumer.
 *
 * Every string here is a **static** string, which is also what keeps the panel inside
 * the `cn()` convention `lib/classNameConvention.test.ts` scans for: a
 * `className={PANEL_ROW}` site classifies as `reference`, and a template literal built
 * from these would be an offender the guard would rightly redden.
 *
 * A CORRECTION THIS HEADER OWES THE READER. It used to name
 * `stages/stageStyles.ts` as the file the bar came from, and cited that file four
 * separate times — for the bar, for its own measured three, for the same position it
 * "states for its own two", and for the `STAGE_ROW` exclusion. **No such file exists
 * in this checkout** (`find src -name '*Styles*'` answers `sessionRowStyles.ts` and
 * this file). The real precedent, and the one now cited above, is
 * `spaces/sessionRowStyles.ts`; `STAGE_ROW` was never verifiable and the exclusion
 * argument stands on `AutoChainGuards.tsx`, which is a file that does exist.
 */

/** One labelled group of fields inside a body: the label line and the control, with
 *  the group's own gap. `min-w-0` because the panel is a flex column whose width is
 *  the axis that shrinks.
 *
 *  ONE CONSUMER FILE (`NodeSettingsBody.tsx`) — see the header's second bullet. */
export const PANEL_SECTION = "flex min-w-0 flex-col gap-1.5";
/** A control cluster inside a body: a quiet row of small affordances. The panel's
 *  take on the dialog's `CONTROL_ROW`, widened by nothing.
 *
 *  ONE CONSUMER FILE (`NodeSettingsBody.tsx`) — see the header's second bullet. */
export const PANEL_ROW = "flex min-w-0 flex-wrap items-center gap-2";
/** The small affordance shape a body nests: `Button variant="ghost"` at the smallest
 *  icon size, so a row of them stays quieter than the fields they act on.
 *
 *  ONE CONSUMER FILE (`NodeSettingsBody.tsx`) — see the header's second bullet. */
export const PANEL_BUTTON =
  "shrink-0 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground";
/** The nested `Select`s are the narrow variant so the Skill picker and the two
 *  destination pickers fit the panel's width.
 *
 *  THE HEIGHT IS NO LONGER FORCED. `h-6` came from the dialog these fields were
 *  transferred FROM, which was 40-60px WIDER than this pane and could afford a quiet
 *  short control. In a 288px pane an `h-6` field reads as cramped against its own
 *  label; the app's own form scale is `h-7` (`ui/input` and `ui/select`'s
 *  `defaultVariants`), so the height is left to the component default and only the
 *  WIDTH is pinned here. Same reasoning for `PANEL_BUTTON` and `GUARD_FIELD`.
 *
 *  TWO CONSUMER FILES (`NodeSettingsBody.tsx`, `NodeDestinations.tsx`) — the only
 *  const here that clears the two-file bar on measurement. */
export const PANEL_SELECT = "w-36 min-w-0";
