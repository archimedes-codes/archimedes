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
  /**
   * The class STRING via the ATTRIBUTE, not `el.className` — the property is an
   * `SVGAnimatedString` for SVG elements (`MutedCaption.test.tsx` carries the same
   * note, and this helper is copied from there).
   */
  function classOf(el: Element): string {
    return el.getAttribute("class") ?? "";
  }

  /** Whole class TOKENS, so a substring of a longer utility cannot satisfy a
   *  `toContain` the way it would on the raw class string. */
  const classTokens = (el: Element): string[] => classOf(el).split(/\s+/);

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
    // The border is what carries the card in zai-light, where the recessed and the
    // raised tokens are both `#ffffff`.
    expect(tokens).toContain("border-border");
    // And the class survives `cn()`'s merge — the lifted-ink comment below the
    // string in source is a comment, not a second background, so exactly ONE
    // background token is on the node.
    expect(tokens.filter((token) => /^bg-/.test(token))).toEqual(["bg-card"]);
    expect(classOf(screen.getByTestId("task-card"))).toBeTruthy();
  });
});
