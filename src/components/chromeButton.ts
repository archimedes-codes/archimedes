/**
 * THE CHROME-BAR BUTTON GRAMMAR — a class CONSTANT, deliberately not a component
 * (Finding 6a).
 *
 * HISTORY, AND WHY THE NAME OUTLIVED ITS SECOND CONSUMER. This grammar was
 * extracted because TWO clusters of small icon buttons sat at the right end of
 * the frameless window's top bar and shared one geometry: the **window
 * controls** (`WindowControls`: Minimize / Maximize / Close), and the
 * now-RETIRED **Chrome controls** — `ChromeControls`, the Settings gear, whose
 * glossary entry carries that name. They faced the same cursor in the same row,
 * so their box, radius, ink and colour transition were one fact, and that fact
 * was spelled THREE times: the retired `ChromeControls`'s local `BTN`, and two
 * literals in `WindowControls`.
 *
 * ADR 0095 deleted that first cluster — its Settings door moved into the
 * **Session list**'s command strip — so `ChromeControls` is retired and gone, and
 * `WindowControls` is now the constant's ONLY consumer. Say that plainly rather
 * than inheriting the two-cluster story: a single consumer of a shared string is
 * a weak reason for a
 * module, and the honest reasons for keeping it anyway are (a) it is still the
 * ONE place the chrome-bar geometry is spelled, which is what Finding 6a asked
 * for and what the source gate below enforces, (b) `chromeButton.test.ts` pins
 * these strings byte-identical to the literals the buttons carried before the
 * extraction, so renaming or inlining them loses a characterisation pin, and (c)
 * the name still means something — this is the CHROME BAR's grammar, and the
 * consumer contract at the bottom of this comment is about NOT spreading it to
 * buttons that are not in that bar. If a future reader decides one consumer does
 * not justify a module, moving these two strings back into `WindowControls` is
 * correct and cheap; deleting the test's byte-identical pins is not.
 *
 * WHY A CONSTANT AND NOT A `<ChromeButton>` COMPONENT — the reason the original
 * design rejected a component still holds for the surviving cluster, so it is
 * kept as the record it was:
 *  - ADR 0038 puts the attention-alert exemption (`data-window-control`) on the
 *    `WindowControls` container ONLY, and the old chrome controls sat OUTSIDE it
 *    on purpose — a component that "was the chrome button" would invite a caller
 *    to put the exemption on the button, which changes when the alert fires;
 *  - CONTEXT.md's (retired) **Chrome controls** entry existed precisely to keep
 *    the two clusters distinct in the vocabulary (`_Avoid_: window controls`),
 *    and the distinction is still asserted today: `App.test.tsx` pins that the
 *    Settings door in the Session list resolves OUTSIDE `[data-window-control]`;
 *  - the old chrome controls carried an `absolute` pending dot, so they needed
 *    `relative` and the window controls had to stay out of it.
 * A component would have had to model all three differences as props/children to
 * be usable, at which point it is a wrapper around a class string with extra
 * steps. The duplication Finding 6a names is the STRING, so the string is what
 * moved.
 *
 * WHY `relative` IS NOT HERE. It belonged to the caller that owned an
 * absolutely-positioned child (the `bg-warning` pending dot in the retired
 * chrome controls). `WindowControls` never had it, and a shared constant must not
 * add a positioning context to a button that did not have one — `WindowControls`
 * and its test pin the absence. Nothing renders `cn("relative", CHROME_BUTTON)`
 * any more — the retired component that did was `ChromeControls`.
 *
 * WHY THE TWO ARMS ARE TWO CONSTANTS AND NOT A BOOLEAN. `CHROME_BUTTON_CLOSE`
 * SWAPS the hover pair (`hover:bg-destructive/20 hover:text-destructive` for
 * `hover:bg-hover hover:text-foreground`) rather than adding to it — a Close
 * that also filled `bg-hover` would flash grey before red. `chromeButton.test.ts`
 * pins that geometry-vs-hover split; a `destructive?: boolean` prop would put it
 * in markup for no benefit, and C7 needs a plain `className` value.
 *
 * CONSUMER CONTRACT — read this before "deduplicating" another button onto it:
 * this is the CHROME BAR's grammar (`h-7 w-7`, `bg-hover`, `transition-colors`).
 * The tab strip's ✕ and `+` (`SpaceTabs.tsx`) are a DIFFERENT cluster with
 * `size-5`/`size-8`, `bg-surface-hover`, `rounded`/`rounded-md` and NO
 * `transition-colors`, and they stay that way on purpose. The same
 * `chromeButton.test.ts` guard reddens an import of this module there. Nor does
 * the Session list's command strip take it: those are labelled rows (`h-8 w-full`,
 * `PANE_COMMAND_ROW`), and the same source gate reddens a pane button wearing the
 * chrome geometry.
 *
 * C7 consumes these constants as the `className` on
 * `<Button variant="ghost" className={CHROME_BUTTON}>` — that is why they are
 * strings and stay strings.
 */

/**
 * The shared chrome-bar button: a 28px square, centred glyph, subtle ink that
 * lifts to full ink on a `bg-hover` fill, colour-transitioned.
 *
 * Byte-identical to the string `WindowControls`' Minimize and Maximize carried,
 * and to the retired `ChromeControls`'s `BTN` minus `relative` (see above).
 */
export const CHROME_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground";

/** The Close control: `CHROME_BUTTON` with the hover pair swapped for destructive. */
export const CHROME_BUTTON_CLOSE =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-destructive/20 hover:text-destructive";
