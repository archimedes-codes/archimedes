import { basenameOfPath } from "../../lib/paths";

/**
 * THE SHARED SURFACE OF THE SIDEBAR'S SESSION ROWS — the two class strings the
 * hover actions are drawn from, and the one Space-name rule the rows label with.
 *
 * This file exists because all THREE of these values have more than one owner
 * and no single row component:
 *
 *  - `ROW_HOVER_ACTION` + `SESSION_ROW_ACTION_ROW` — used by `SessionRow` and
 *    `ArchivedSessionRow`, twice each (Stop, Archive / Unarchive, Delete);
 *  - `spaceNameFor` — used by `SpacesList` (the delete-confirm's title) AND by
 *    `ArchivedSessionRow` (the `titleFor` fallback label).
 *
 * A const with two consumers in two files has to have ONE owner, or the two
 * drift. `basenameOfPath` is imported here for exactly one reason — it is the
 * only thing `spaceNameFor` needs — so it travels with it rather than being
 * re-imported at each row.
 *
 * The doc block on `ROW_HOVER_ACTION` below is the argument for why those two
 * strings cannot be "tidied" into one, or negated differently, or routed through
 * a `<Button>` recipe. It came across with the consts it documents; read it
 * before changing either string.
 */

/**
 * THE HOVER-REVEALED SESSION-ROW ACTIONS — Stop / Archive on a live or stored
 * row, Unarchive / Delete on an archived one. Four affordances, one box, drawn
 * by three different components (`SessionRow` and `ArchivedRow`), so the recipe
 * lives here once.
 *
 * `ROW_HOVER_ACTION` is the negation wall (groups the row does NOT spell, and
 * which `Button`'s base or the `icon-sm` size would otherwise change);
 * `SESSION_ROW_ACTION_ROW` is the row's own class list VERBATIM and comes LAST,
 * so it wins every group it spells. Both go to `cn()` at all four sites.
 *
 * What the wall undoes:
 *  - `border-0` — the base's `border` is a 1px ring; on a `size-6` box that is
 *    a 26px hit target where 24px was measured and pinned by the row's
 *    alignment, and it shifts the glyph 1px.
 *  - `transition-none` — the base fades hover colour over 150 ms. These appear
 *    on row hover ALREADY (`group-hover:flex`); layering a second fade on the
 *    fill would change what a hovering pointer sees.
 *  - `shrink` — the base's `shrink-0` is `flex-shrink: 0`. These four are flex
 *    ITEMS of the row (`RowButton` is a `flex` box), so the base would stop a
 *    long title from squeezing them the way it always could. `shrink` is
 *    `flex-shrink: 1` — the value they had.
 *
 * What the row itself wins by being LAST, and why that matters here:
 *  - `hover:bg-surface-hover` over the ghost arm's `hover:bg-hover` (different
 *    colours in default-dark and Dracula — 5% vs 10%);
 *  - `hidden` + `group-hover:flex` over the base's `inline-flex` — the
 *    hover-reveal mechanism is the whole design of this affordance and it has
 *    to survive;
 *  - `items-center`, `justify-center`, `rounded-md`, `size-6`.
 *
 * Inert additions, with the reason:
 *  - `text-foreground` and `hover:text-foreground` (the ghost arm) — the row
 *    spells NO colour and inherits one anyway: `App.tsx:360`'s root is
 *    `bg-frame text-foreground`, and nothing between it and this button sets a
 *    colour, so the arm's ink IS the inherited ink. Same computed colour;
 *  - `bg-clip-padding` — `padding-box` is CSS's initial `background-clip`, so
 *    declaring it changes nothing;
 *  - `outline-none` — `base.css:53-57` forces `outline: none !important` on
 *    every `:focus`/`:focus-visible` anyway, in every browser and again under
 *    `forced-colors`;
 *  - `disabled:*` / `aria-invalid:*` / `aria-expanded:*` — none of the four is
 *    ever disabled, and nothing sets `aria-invalid` or `aria-expanded` on it
 *    (the VIEW doors in this pane's command surfaces do — Settings, Tasks and
 *     Workflows; these do not. The list is not exhaustive-by-name by design: a
 *     fourth door joins it without a visit to this file, and what the sentence
 *     claims is the KIND split, not a census);
 *  - `text-ui-base/relaxed` — 14px/1.625 declared where the button previously
 *    inherited the UA's 16px (this app never sets a root `font-size`; it sizes
 *    text only through `--ui-font-size` and the `text-ui-*` utilities, and
 *    neither this button nor the `RowButton` it sits in spells one). Inert
 *    because there is no text: the only child is an `<svg class="size-4">`, and
 *    `size-4` is `calc(var(--spacing) * 4)` — rem, not em — inside a fixed
 *    `size-6` box. `whitespace-nowrap` and `select-none` have no text to act
 *    on either;
 *  - `[&_svg]:pointer-events-none` — the click handler is on the button, so the
 *    event is handled whether it lands on the button or is retargeted to it;
 *  - `[&_svg]:shrink-0` — the glyph is a fixed `size-4`;
 *  - `[&_svg:not([class*='size-'])]:size-3` — every icon here is created with
 *    an explicit `size-4` (`SquareIcon`, `ArchiveIcon`, `ArchiveXIcon`,
 *    `Trash2Icon`), so the `:not([class*=size-])` guard excludes all of them.
 *    This is the C2 chrome-bar trap, and it does not bite here;
 *  - `has-data-[icon=inline-*]:pr/pl` — no child carries `data-icon`
 *    (lucide-react v1.47's `createLucideIcon` sets no such attribute);
 *  - `group/button` — nothing in the tree reads that group.
 *
 * NOT `RowButton`, and this is the C4 rule, not an oversight: these are real
 * `<button>`s. A second `role="button"` inside the row would resolve every
 * `.closest('[role="button"]')` read in `SpacesList.test.tsx` to the action
 * instead of the row, and `ToolCallCard.test.tsx`'s nesting pin keeps the
 * `button`-in-`button` count at zero — `Button` renders a `<button>`, which is
 * what the row's `div[role=button]` already expects as a child.
 */
export const ROW_HOVER_ACTION = "border-0 transition-none shrink";
export const SESSION_ROW_ACTION_ROW =
  "hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover";

/** The **Space** a Session belongs to, as a folder NAME — the label `titleFor`
 *  falls back to when a Session has neither a generated title nor a loaded
 *  transcript. Two owners (the pane's delete-confirm title, and the archived
 *  row), so one definition. `basenameOfPath`'s only consumer in this cluster. */
export function spaceNameFor(cwd: string, spaces: { path: string }[]): string {
  const match = spaces.find((s) => s.path === cwd);
  return match ? basenameOfPath(match.path) : basenameOfPath(cwd);
}
