import type { ReactElement, ReactNode } from "react";

/**
 * The island geometry: a flanking surface that floats ABOVE the chrome plane.
 *
 * VERBATIM `SidePane.tsx:210` except the fill (`bg-chat` for `bg-inspector`),
 * and the duplication is deliberate. No test pins this recipe to the Side pane
 * (`SidePane.test.tsx` asserts the resize-handle family and the pane's content,
 * never its root classes), so sharing the string would buy nothing and would
 * make a shell whose purpose is being mirrorable to the LEFT depend on the pane
 * that lives on the RIGHT for its class list. No `min-h-0`: like the Side pane,
 * this is a flex ROW child with a fixed width, so the axis that needs the
 * `min-height: 0` override is not the one that constrains it.
 */
const ISLAND =
  "relative m-1 flex shrink-0 flex-col overflow-hidden rounded-xl bg-chat";

/**
 * The **Menu panel** shell — the flanking **island** that switches between the
 * sections WITHIN one view (CONTEXT.md; ADR 0097).
 *
 * WHY A COMPONENT AND NOT A CLASS CONSTANT. `chromeButton.ts` is this repo's
 * argument for the constant form, and for its case it is right: one geometry,
 * one kind of element, and a consumer contract that is about NOT spreading the
 * grammar further. This is the opposite shape. An island is a BOX with a child
 * contract — the caller supplies a scroller that fills it
 * (`flex-1 overflow-y-auto`) and the two must agree about the flex chain or the
 * content cannot scroll. A constant hands out a string and leaves every site to
 * remember the element, the `style` pairing and the scroller nesting; three
 * copies of that is how a Settings nav and the Side pane drift apart. The
 * component owns the geometry and the nesting, and the caller brings the width.
 *
 * `bg-chat`, DELIBERATELY NOT `bg-inspector`. The two are the same value in
 * every palette (`--color-inspector: var(--color-chat)` in all four blocks), so
 * this is not a colour decision, it is a naming one: "inspector" names the
 * right-hand **Side pane**, and that is a lie inside a component whose entire
 * purpose is being the same geometry mirrored to the left. The chrome token is
 * the other way this shell could be wrong — ADR 0097 puts it on the CHROME plane
 * (the titlebar and the Session list) and everything that happens on an island
 * above it. Settings' nav used to sit on the chrome colour at a contrast of
 * 1.00 to the Session list beside it, which is why the view read as the
 * background showing through rather than as a surface.
 *
 * NO LANDMARK, AND NO ACCESSIBLE-NAME PROP. The accessible name belongs to the
 * `nav` element the caller puts INSIDE the shell. Two `navigation` landmarks
 * sharing one accessible name make `getByRole("navigation", { name: … })` throw
 * "found multiple elements" — not a hypothetical here, but the exact failure
 * that would redden the three `App.test.tsx` sites querying `"Settings
 * sections"`. A plain `div` is also the honest element: the shell is a layout
 * box, and the thing that switches sections is the list inside it.
 *
 * OWNS NO WIDTH PERSISTENCE. It takes a number and paints it. The Side pane's
 * `localStorage` key `side-pane-width`, its 240–480px clamp and its drag handle
 * are that pane's concern, not a property of "a flanking island"; Settings' nav
 * persisted nothing before this shell existed and gains nothing from it.
 */
export function MenuPanel({
  width,
  children,
}: {
  /** The caller's width in px. The shell has no default and no clamp — the
   *  number is a property of the view, not of the island. */
  width: number;
  children: ReactNode;
}): ReactElement {
  return (
    <div style={{ width }} className={ISLAND}>
      {children}
    </div>
  );
}
