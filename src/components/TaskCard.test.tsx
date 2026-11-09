import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TaskCard from "./TaskCard";
import type { DragCardHandlers } from "../hooks/useDragCard";
import type { TaskRow } from "../lib/tauri";

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so a
// bare `import "node:fs"` does not typecheck. The idiom `classNameConvention.test.ts`
// and `tauriBoundary.test.ts` use, borrowed here for the one assertion below that
// can only be made against SOURCE.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/** Strip JS comments before scanning, matching the helper
 *  `classNameConvention.test.ts` / `mutedCaption.test.ts` use. A name that appears
 *  only in a doc-comment is PROSE, not a consumer. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/**
 * `TaskCard` — one board card.
 *
 * The pin that matters here is NOT "renders a title". It is that the card spreads
 * `useDragCard`'s FIVE-key surface and does NOT reach for `useDragReorder`'s
 * six-key `DragReorderHandlers`, because that surface is pinned at six keys for a
 * byte-compared `RowButton` and the two are not interchangeable. So the drag test
 * below counts the attributes the card emits rather than trusting the prop type —
 * a component that quietly imported the wrong hook would still typecheck if someone
 * widened a type, and the DOM is what the contract is about.
 *
 * It is also NOT a `RowButton`, and the tests pin that: a `role="button"` here
 * would collide with `RowButton`'s one-role-per-row rule (`SpacesList.test.tsx`
 * reaches rows through `.closest('[role="button"]')` at eight sites), and a card is
 * not one of the five row affordances that component owns.
 */

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "tsk_1",
  spacePath: "/w/alpha",
  number: 3,
  title: "Ship the board",
  body: null,
  specPath: null,
  stageSlug: "doing",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/**
 * The class STRING via the ATTRIBUTE, not `el.className` — the property is an
 * `SVGAnimatedString` for SVG elements (`MutedCaption.test.tsx` carries the same
 * note, and this helper is copied from there). It moved from inside the ladder
 * `describe` to module scope because the ANATOMY cases below read classes too, and
 * a helper two `describe` blocks away from one of its readers is a trap.
 */
function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

/** Whole class TOKENS, so a substring of a longer utility cannot satisfy a
 *  `toContain` the way it would on the raw class string. */
const classTokens = (el: Element): string[] => classOf(el).split(/\s+/);

/** A spread surface that records which handler ran, so the spread can be asserted
 *  as BEHAVIOUR and not only as an attribute list. */
const dragSurface = (): DragCardHandlers => ({
  draggable: true,
  onDragStart: vi.fn(),
  onDragOver: vi.fn(),
  onDrop: vi.fn(),
  onDragEnd: vi.fn(),
});

describe("TaskCard — what it renders", () => {
  it("shows the per-Space number label and the title", () => {
    render(<TaskCard task={task()} />);
    // `T3`, spelled as the label a person says out loud. `number` is per-Space and
    // `id` is the global key (ADR 0090) — the card shows the LABEL, and the id
    // belongs to the drag payload and every other command, never to the human.
    expect(screen.getByText("T3")).toBeTruthy();
    expect(screen.getByText("Ship the board")).toBeTruthy();
    expect(screen.queryByText("tsk_1")).toBeNull();
  });

  it("renders a card with a body and one without (body is nullable on the wire)", () => {
    const { unmount } = render(<TaskCard task={task({ body: "the details" })} />);
    expect(screen.getByText("the details")).toBeTruthy();
    unmount();
    render(<TaskCard task={task({ body: null })} />);
    expect(screen.getByText("Ship the board")).toBeTruthy();
  });

  it("a card title wraps instead of clipping", () => {
    // The title is the card's subject, and a card that clips it to one line hides
    // the only sentence on it. `truncate` is `overflow:hidden; white-space:nowrap`
    // — it is a CLIP, so a two-line title lost its second half with no affordance.
    // `line-clamp-2` bounds the height the same way (a card strip cannot grow
    // without limit) but WRAPS to get there, and `leading-snug` is the reference's
    // title rhythm.
    //
    // Class tokens and not a rendered height: jsdom performs no layout, so the
    // honest instrument here is the utility the merge actually emitted.
    render(<TaskCard task={task()} />);
    const tokens = classTokens(screen.getByText("Ship the board"));
    expect(tokens).toContain("line-clamp-2");
    expect(tokens).toContain("font-medium");
    expect(tokens).toContain("leading-snug");
    expect(tokens).not.toContain("truncate");
  });

  it("a card with a spec shows the spec chip, and one without shows none", () => {
    // Net-new coverage: `specPath` is stored, crosses IPC and is read by the boost
    // prompt, but NOTHING rendered it — so no existing pin protected it and a
    // dropped field would have been silent. The chip is CONDITIONAL on the data
    // existing rather than a placeholder for its absence, and the query pins the
    // LABEL and not a `data-testid`: the string is the thing that can drift.
    const { unmount } = render(
      <TaskCard task={task({ specPath: "/tmp/spec.md" })} />,
    );
    const chip = screen.getByText("spec");
    const tokens = classTokens(chip);
    expect(tokens).toContain("rounded-full");
    expect(tokens).toContain("bg-chat");
    // The path itself is not the chip's text — it is a pointer, not a title, and
    // rendering it would put an absolute filesystem path on every card.
    expect(chip.textContent).toBe("spec");
    unmount();
    render(<TaskCard task={task({ specPath: null })} />);
    expect(screen.queryByText("spec")).toBeNull();
  });

  it("carries the task id as the drag payload handle", () => {
    // The board's drag handlers are keyed by id, so the DOM has to expose which
    // card a node is — otherwise a drop cannot say which card moved.
    render(<TaskCard task={task()} />);
    expect(screen.getByTestId("task-card").getAttribute("data-task-id")).toBe(
      "tsk_1",
    );
  });
});

describe("TaskCard — the drag surface it spreads", () => {
  it("emits draggable=true when it is handed a drag surface", () => {
    render(<TaskCard task={task()} drag={dragSurface()} />);
    expect(screen.getByTestId("task-card").getAttribute("draggable")).toBe("true");
  });

  it("wires ALL FOUR of the cross-column handlers it was handed", () => {
    // Behaviour, not attributes: React attaches event handlers as props and emits
    // NO `on*` attribute, so an attribute count here would read zero for every
    // handler and certify nothing. Firing each event is the instrument that can
    // actually see the spread.
    const drag = dragSurface();
    render(<TaskCard task={task()} drag={drag} />);
    const el = screen.getByTestId("task-card");
    fireEvent.dragStart(el, { dataTransfer: { setData: vi.fn() } });
    fireEvent.dragEnd(el);
    fireEvent.dragOver(el);
    fireEvent.drop(el);
    expect(drag.onDragStart).toHaveBeenCalledTimes(1);
    expect(drag.onDragEnd).toHaveBeenCalledTimes(1);
    expect(drag.onDragOver).toHaveBeenCalledTimes(1);
    expect(drag.onDrop).toHaveBeenCalledTimes(1);
  });

  it("reaches for useDragCard and NOT for the six-key reorder surface", () => {
    // THE PIN, and the reason it is a source assertion. `useDragReorder`'s
    // `dragProps` is pinned at exactly six keys because `RowButton` spreads it
    // VERBATIM onto a byte-compared row; `useDragCard`'s is five. The two prop
    // types look interchangeable to `tsc` the moment anyone widens one, and the
    // DOM cannot tell them apart either — so this repo's other instrument, a source
    // scan (`tauriBoundary.test.ts`, `classNameConvention.test.ts`), is the honest
    // one. A "unify the drag hooks" sweep that points the card at the reorder hook
    // reddens HERE, in the file that owns the claim.
    // COMMENT-STRIPPED, and that is load-bearing rather than tidy: this file's own
    // doc-comment NAMES `useDragReorder` to explain why the card does not use it.
    // A raw read would convict the explanation — the same prose-as-consumer trap
    // `mutedCaption.test.ts` and `themeTokens.test.ts` both record being bitten by.
    const src = stripJsComments(readFileSync("src/components/TaskCard.tsx", "utf8"));
    expect(src).toContain("useDragCard");
    expect(src).not.toContain("useDragReorder");
    expect(src).not.toContain("DragReorderHandlers");
    // And the type it spreads is the five-key one.
    expect(src).toContain("DragCardHandlers");
    // Vacuity guard: a stripper that consumed EVERYTHING would satisfy the three
    // `not.toContain` lines trivially, so the positive read above is paired with a
    // count that only holds if real code survived the strip.
    expect(src).toContain("export default function TaskCard");
  });

  it("with no drag prop, the card is not draggable at all", () => {
    // TWO COMPETING ANSWERS: a card that defaulted to `draggable` with no handlers
    // would start a native drag that NOTHING resolves — the browser shows a drag
    // ghost, every drop is refused, and no code path runs. Absent handlers mean an
    // absent gesture.
    render(<TaskCard task={task()} />);
    const el = screen.getByTestId("task-card");
    expect(el.getAttribute("draggable")).toBeNull();
  });

  it("marks the card being dragged", () => {
    render(<TaskCard task={task()} drag={dragSurface()} active />);
    expect(screen.getByTestId("task-card").getAttribute("data-dragging")).toBe("true");
  });

  it("does not mark a card it is merely rendering", () => {
    render(<TaskCard task={task()} />);
    expect(screen.getByTestId("task-card").hasAttribute("data-dragging")).toBe(false);
  });

  it("owns NO drop-target state — the column carries it, so a target is painted once", () => {
    // TWO COMPETING ANSWERS for "where does this land": the column the pointer is
    // over, or the card nearest it. The COLUMN wins (it is what `useDragCard`'s
    // hit test resolves, and an empty column has no card to mark), so a card-level
    // `data-over` would be a second answer — and on a two-card column, three borders
    // for one target.
    render(<TaskCard task={task()} drag={dragSurface()} active />);
    expect(screen.getByTestId("task-card").hasAttribute("data-over")).toBe(false);
  });
});

describe("TaskCard — what it is NOT", () => {
  it("is not a RowButton: no role=button, no tabindex", () => {
    // `RowButton`'s header states the constraint: exactly ONE `role="button"` per
    // row is load-bearing, because `SpacesList.test.tsx` resolves rows through
    // `.closest('[role="button"]')` at eight sites. A card that adopted it would be
    // a sixth hand-rolled affordance and would not even be a control — a card is
    // dragged, not clicked, in v1.
    render(<TaskCard task={task()} drag={dragSurface()} />);
    const el = screen.getByTestId("task-card");
    expect(el.getAttribute("role")).toBeNull();
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.tagName).toBe("DIV");
  });
});

describe("TaskCard — the surface ladder (ADR 0097: raise)", () => {
  it("a card raises", () => {
    // The raise half of the pair — the recess half lives in
    // `TasksBoard.test.tsx` ("a column recesses"). A card sits ON a column, so it
    // goes UP a rung (`bg-card`) while the column goes down (`bg-panel`): the two
    // used to share one translucent token, which made a card the same colour as
    // the column it sat in, with the separation carried entirely by the border.
    // Pinning ONE of the two would let a sweep that returns both to that shared
    // token pass half the pair, so both files carry one half.
    //
    // Token strings and not computed colours: jsdom resolves no cascade, so
    // `getComputedStyle` answers `""` here and would certify a broken card.
    render(<TaskCard task={task()} />);
    const tokens = classTokens(screen.getByTestId("task-card"));
    expect(tokens).toContain("bg-card");
    expect(tokens).not.toContain("bg-surface");
    // The seam is what carries the card in zai-light, where the recessed and the
    // raised tokens are both `#ffffff` — and the seam is the SEAM token now, not
    // the generic border (see the matching case in `TasksBoard.test.tsx`). The
    // four quiet palettes keep `--color-card-border` aliasing `--color-border`
    // (10% alpha) exactly so that sentence stays true; only Dracula retunes it.
    expect(tokens).toContain("border-card-border");
    expect(tokens).not.toContain("border-border");
    // And the class survives `cn()`'s merge — the lifted-ink comment below the
    // string in source is a comment, not a second background, so exactly ONE
    // background token is on the node.
    expect(tokens.filter((token) => /^bg-/.test(token))).toEqual(["bg-card"]);
    expect(classOf(screen.getByTestId("task-card"))).toBeTruthy();
  });

  it("the seam is the card-border token, not the generic border", () => {
    // Dracula is the only palette whose `--color-border` is OPAQUE (`#6272a4`,
    // 3.68 against the column fill it rests on) while its elevation ladder steps
    // 1.22 / 1.47 — so a card outline drawn in that token out-shone the two fills
    // it was meant to sit between. The palette already declares a seam token for
    // this job (`--color-card-border`, retuned in `.theme-dracula` alone), so the
    // card consumes THAT and the generic border is GONE rather than merely joined:
    // two border-colour utilities on one node is a tie CSS resolves by stylesheet
    // order, so a half-migrated card would still paint the loud ink on Dracula.
    //
    // Both halves are asserted because the migration is a SWAP: a pin that only
    // checked for the new token would pass on a card carrying both.
    render(<TaskCard task={task()} />);
    const tokens = classTokens(screen.getByTestId("task-card"));
    expect(tokens).toContain("border-card-border");
    expect(tokens).not.toContain("border-border");
  });
});
