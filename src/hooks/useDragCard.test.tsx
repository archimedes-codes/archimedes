import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDragCard } from "./useDragCard";
import { useWindowDropBackstop } from "./useWindowDropBackstop";
import type { StageRow, StageWithTasks, TaskCardView } from "../lib/tauri";

/**
 * `useDragCard` — the CROSS-COLUMN gesture, and the reason it is a separate hook.
 *
 * `useDragReorder`'s `dragProps` returns exactly six keys and is spread VERBATIM
 * onto a byte-compared `RowButton` (its own first test pins that, and
 * `useDragReorder.ts`'s `axis` doc says so in-file). A seventh key there is an
 * unknown DOM attribute on a row whose serialisation is byte-compared. So the
 * board's cross-column gesture gets its OWN surface, and the first test below is
 * the fence that keeps the two surfaces from being merged by the next "dedupe the
 * drag hooks" sweep.
 *
 * `.tsx` because the contract IS DOM: real elements carry the handlers and carry
 * the rects, exactly like `useDragReorder.test.tsx`.
 *
 * THE SAME THREE jsdom FACTS that file documents, each re-verified here rather
 * than trusted:
 *  1. `DragEvent` and `DataTransfer` are `undefined` in this jsdom, so every drag
 *     event is a hand-built cancelable `Event`;
 *  2. `fireEvent.dragOver(el, { clientX, clientY })` does NOT deliver the
 *     coordinates — a plain `Event` swallows the unknown init members, so they are
 *     assigned AFTER construction. Without that, this hook's whole answer (which
 *     column is under the pointer) is driven by `undefined`;
 *  3. `getBoundingClientRect()` is all zeros, so every column "contains" the
 *     origin. Hence `layOut` below: without it, cross-column-vs-same-column is not
 *     merely untested, it agrees by accident — which is why the hook treats a
 *     zero-area rect as ABSENCE OF LAYOUT rather than as a hit.
 */

/** jsdom has no `DataTransfer` — the hook calls exactly `setData`, so exactly one
 *  member is stubbed. `getData` stays absent: a hook that read it would be
 *  inviting a cross-window drop this single-window app cannot serve. */
const stubDataTransfer = () => ({ setData: vi.fn() });

/** A `dragover` that REALLY carries a pointer position (jsdom fact 2). The return
 *  value is `false` iff a handler called `preventDefault` — which is how "this
 *  column accepted the drop" is asserted. `cancelable: true` is what makes that
 *  mean anything. */
const dragOver = (el: Element, clientX: number, clientY: number) => {
  const ev = new Event("dragover", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.assign(ev, { clientX, clientY });
  return fireEvent(el, ev);
};

/** A hand-built `drop`, returned rather than fired so a test can read
 *  `defaultPrevented` after the fact. */
const buildDrop = (clientX: number, clientY: number) => {
  const ev = new Event("drop", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.assign(ev, { clientX, clientY });
  return ev;
};

/** jsdom has no layout: the default rect is all zeros, so a pointer-based hit test
 *  would answer "the first column" for EVERY pointer. Give each column a real box
 *  so WHICH column is under a coordinate is a fact the TEST chooses. */
const layOut = (el: HTMLElement, left: number, width = 200) => {
  el.getBoundingClientRect = () =>
    ({
      left,
      right: left + width,
      width,
      top: 0,
      bottom: 400,
      height: 400,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
};

// ---------------------------------------------------------------------------
// Board fixtures — the NESTED wire shape (`{ stage, tasks }`), never a flat row.
// ---------------------------------------------------------------------------

const stage = (slug: string): StageRow => ({
  spacePath: "/w/alpha",
  slug,
  label: slug,
  sortOrder: 0,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
});

/** One board CARD (issue #174): the wire element is a `TaskCardView` — the row
 *  under `.task` plus its `sessions`/`costUsd`. This hook only ever reads
 *  `.task.id`, so the wrapper is empty here on purpose; a card built as a bare
 *  `TaskRow` no longer typechecks against `StageWithTasks.tasks`. */
const card = (id: string, stageSlug: string): TaskCardView => ({
  task: {
    id,
    spacePath: "/w/alpha",
    number: Number(id.replace(/\D/g, "")),
    title: id,
    body: null,
    specPath: null,
    stageSlug,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  },
  sessions: [],
  costUsd: null,
  artifactKeys: [],
});

/** Three columns, the third EMPTY — because the seeded default board is mostly
 *  empty columns (`backlog`/`research`/`approved`/`doing`/`done` with no cards),
 *  so "can a card land in a column that has nothing in it" is the common case,
 *  not an edge. */
const STAGES: StageWithTasks[] = [
  { stage: stage("backlog"), tasks: [card("t1", "backlog"), card("t2", "backlog")] },
  { stage: stage("doing"), tasks: [card("t3", "doing")] },
  { stage: stage("done"), tasks: [] },
];

/** The probe: one marked column per stage, each holding its cards wearing the
 *  hook's card surface verbatim and the column's own drop surface, plus a readout
 *  of the gesture state so the tests assert what a RENDER would see. */
function Probe(props: {
  stages?: readonly StageWithTasks[];
  onMove: (taskId: string, fromStageSlug: string, toStageSlug: string) => void;
  /** Mounted alongside in one case, because "the card wins the drop without
   *  `stopPropagation`" is only a claim if the window backstop is listening too. */
  withBackstop?: boolean;
}) {
  const stages = props.stages ?? STAGES;
  const hook = useDragCard({ stages, onMove: props.onMove });
  captured = hook;
  if (props.withBackstop) useWindowDropBackstop();
  return (
    <div data-testid="board">
      <div data-testid="gesture">
        {JSON.stringify({
          draggingTaskId: hook.draggingTaskId,
          overStageSlug: hook.overStageSlug,
        })}
      </div>
      {stages.map((column) => (
        <div
          key={column.stage.slug}
          data-stage-slug={column.stage.slug}
          {...hook.columnProps()}
        >
          {column.tasks.map((t) => (
            <div
              key={t.task.id}
              data-testid={`card-${t.task.id}`}
              {...hook.dragProps(t.task.id)}
            >
              {t.task.id}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The hook's return value as the last render produced it — the only way to ask
 *  `dragProps` for its own key set. The probe is the sole writer. */
let captured: ReturnType<typeof useDragCard> | null = null;

const gesture = () =>
  JSON.parse(screen.getByTestId("gesture").textContent ?? "{}");
const cardEl = (id: string) => screen.getByTestId(`card-${id}`);
const columnEl = (slug: string) =>
  screen.getByTestId("board").querySelector(`[data-stage-slug="${slug}"]`)!;

/** `backlog` spans x 0..200, `doing` 200..400, `done` 400..600. */
const layoutColumns = () => {
  layOut(columnEl("backlog") as HTMLElement, 0);
  layOut(columnEl("doing") as HTMLElement, 200);
  layOut(columnEl("done") as HTMLElement, 400);
};

beforeEach(() => {
  captured = null;
});

describe("useDragCard — the surface (kept separate from the six-key reorder pin)", () => {
  it("dragProps returns exactly draggable + its four handlers and NO axis key", () => {
    render(<Probe onMove={vi.fn()} />);
    // TWO COMPETING ANSWERS: this surface is FIVE keys. A sixth — an `axis`, a
    // `className`, an `onDragLeave` copied over from the sibling hook — is a second
    // answer, and the reason it matters is the OTHER hook: `useDragReorder`'s
    // `dragProps` is pinned at exactly six keys because `RowButton` spreads it onto
    // a byte-compared row. Merging the two surfaces to "just share the drag hook"
    // would break that file, so this assertion is the fence, not bookkeeping.
    expect(Object.keys(captured!.dragProps("t1")).sort()).toEqual([
      "draggable",
      "onDragEnd",
      "onDragOver",
      "onDragStart",
      "onDrop",
    ]);
    expect(captured!.dragProps("t1").draggable).toBe(true);
    // Named separately because "no axis" is the SPECIFIC temptation: the sibling
    // hook takes an `axis` ARGUMENT, and a reader who conflated the two would pass
    // it through into the spread — which is the exact defect that hook's own doc
    // warns about ("AN ARGUMENT, NEVER A SPREAD KEY").
    expect(captured!.dragProps("t1")).not.toHaveProperty("axis");
  });

  it("columnProps returns exactly the two drop handlers — a column is never draggable", () => {
    render(<Probe onMove={vi.fn()} />);
    // A column that carried `draggable` would start a drag whose payload is a STAGE
    // SLUG, and the drop would then try to `moveTask` a column. So the column
    // surface is the TARGET half only.
    expect(Object.keys(captured!.columnProps()).sort()).toEqual([
      "onDragOver",
      "onDrop",
    ]);
  });

  it("exposes the gesture as draggingTaskId + overStageSlug alongside the two spreads", () => {
    render(<Probe onMove={vi.fn()} />);
    expect(Object.keys(captured!).sort()).toEqual([
      "columnProps",
      "dragProps",
      "draggingTaskId",
      "overStageSlug",
    ]);
  });
});

describe("useDragCard — the gesture", () => {
  it("onDragStart seeds the native drag with setData and reports the card being dragged", () => {
    render(<Probe onMove={vi.fn()} />);
    const stub = stubDataTransfer();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stub });
    expect(gesture()).toEqual({ draggingTaskId: "t1", overStageSlug: null });
    // THE Firefox PIN (inherited from `useDragReorder`'s own note): a hook that
    // skips `setData` is GREEN in jsdom and starts no drag in a real Firefox
    // webview. This call assertion is the only place that requirement can live.
    expect(stub.setData).toHaveBeenCalledWith("text/plain", "t1");
  });

  it("dragging over ANOTHER column marks that column and preventDefaults (it becomes the drop target)", () => {
    render(<Probe onMove={vi.fn()} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    // x 300 is inside `doing` (200..400). `false` === prevented === accepts drops.
    expect(dragOver(cardEl("t3"), 300, 10)).toBe(false);
    expect(gesture()).toEqual({ draggingTaskId: "t1", overStageSlug: "doing" });
  });

  it("an EMPTY column is still a drop target (the seeded board is mostly empty columns)", () => {
    // The card-level handler can only fire over a card, and a column with no cards
    // has nothing to fire on — so a card could never be dropped into `done`, which
    // is the single most common drop on a fresh board. This is why the hook exposes
    // a column-level target surface as well as the card's.
    render(<Probe onMove={vi.fn()} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    expect(dragOver(columnEl("done"), 450, 10)).toBe(false);
    expect(gesture()).toEqual({ draggingTaskId: "t1", overStageSlug: "done" });
  });

  it("dragging over the card's OWN column is not a target: no mark and no preventDefault", () => {
    // The release belongs to the window backstop, which is the only thing between a
    // stray drop and the webview NAVIGATING to it — the same reasoning
    // `useDragReorder` gives for leaving a self-drop un-prevented.
    render(<Probe onMove={vi.fn()} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    expect(dragOver(cardEl("t2"), 100, 10)).toBe(true);
    expect(gesture()).toEqual({ draggingTaskId: "t1", overStageSlug: null });
  });

  it("resolves the column from the POINTER, not from the card the event fired on", () => {
    // The reason the hook reads a rect at all. `closest("[data-stage-slug]")` on the
    // event target answers the CARD's column, so a drop would land where the card
    // LIVES rather than where the POINTER is — and with a card that overflows its
    // column, or a column that scrolled, those are different places. Here `t2` (a
    // `backlog` card) receives the event, but the pointer sits at x 300, inside
    // `doing`.
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    dragOver(cardEl("t2"), 300, 10);
    expect(gesture().overStageSlug).toBe("doing");
  });

  it("a degenerate column rect is not a hit (jsdom fact 3, asserted not assumed)", () => {
    // All-zero rects would otherwise "contain" the origin and every pointer would
    // resolve to whichever column the walk reached first — reporting a cross-column
    // move for a drag that never left its column. So zero area is ABSENCE OF LAYOUT,
    // and the conservative answer is "no target".
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    // NOTE: no `layOut` — every rect is the jsdom default.
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    expect(dragOver(cardEl("t3"), 300, 10)).toBe(true);
    expect(gesture().overStageSlug).toBeNull();
    fireEvent(cardEl("t3"), buildDrop(300, 10));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("a column the board does not have is never a target (a stale node cannot invent a stage)", () => {
    // A column node still in the DOM whose slug is no longer in `stages` (the board
    // reloaded mid-drag). `moveTask` with a slug the Space does not own is refused
    // by Rust — better to refuse locally and show nothing than to mark a column the
    // user cannot drop into.
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    layoutColumns();
    const stale = document.createElement("div");
    stale.setAttribute("data-stage-slug", "archived");
    stale.setAttribute("data-testid", "stale-column");
    screen.getByTestId("board").appendChild(stale);
    layOut(stale, 600);
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    expect(dragOver(cardEl("t3"), 650, 10)).toBe(true);
    expect(gesture().overStageSlug).toBeNull();
  });
});

describe("useDragCard — the drop", () => {
  it("drop on another column calls onMove(taskId, from, to) once and clears the gesture", () => {
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    dragOver(cardEl("t3"), 300, 10);
    fireEvent(cardEl("t3"), buildDrop(300, 10));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("t1", "backlog", "doing");
    expect(gesture()).toEqual({ draggingTaskId: null, overStageSlug: null });
  });

  it("drop on an EMPTY column's own surface calls onMove too", () => {
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    dragOver(columnEl("done"), 450, 10);
    fireEvent(columnEl("done"), buildDrop(450, 10));
    expect(onMove).toHaveBeenCalledWith("t1", "backlog", "done");
  });

  it("the drop is prevented, so the window backstop does not also swallow it", () => {
    // Mounted WITH the backstop, because "the card wins" is only a claim if both
    // listeners exist. `stopPropagation` is used nowhere: the card's handler fires
    // first during bubbling and `preventDefault` is what marks the drop handled.
    const onMove = vi.fn();
    render(<Probe onMove={onMove} withBackstop />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    dragOver(cardEl("t3"), 300, 10);
    const drop = buildDrop(300, 10);
    fireEvent(cardEl("t3"), drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onMove).toHaveBeenCalledWith("t1", "backlog", "doing");
  });

  it("drop on the SAME column is a no-op: onMove never runs and the release is not prevented", () => {
    // Within-column ordering is `useDragReorder`'s gesture and `reorderTasks`'
    // write. TWO COMPETING ANSWERS: a hook treating a same-column drop as a move
    // would call `moveTask`, run the destination's `onEnter` (compacting a Session
    // for a drag that changed no stage) and stamp `updated_at` on a card nobody
    // moved.
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    dragOver(cardEl("t2"), 100, 10);
    const drop = buildDrop(100, 10);
    fireEvent(cardEl("t2"), drop);
    expect(onMove).not.toHaveBeenCalled();
    expect(drop.defaultPrevented).toBe(false);
    expect(gesture()).toEqual({ draggingTaskId: null, overStageSlug: null });
  });

  it("a drop with no drag in flight is inert", () => {
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    layoutColumns();
    const drop = buildDrop(300, 10);
    fireEvent(cardEl("t3"), drop);
    expect(onMove).not.toHaveBeenCalled();
    expect(drop.defaultPrevented).toBe(false);
  });

  it("a card that LEFT the board mid-drag cannot be dropped (a stale slice names no move)", () => {
    // The column closed, or the board reloaded without it, while the pointer was
    // down. `useDragReorder` carries the same guard for the same reason: moving an
    // id the current slice does not contain fires an IPC over a slice the UI never
    // showed.
    const onMove = vi.fn();
    const { rerender } = render(<Probe onMove={onMove} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    dragOver(cardEl("t3"), 300, 10);
    // The board re-renders WITHOUT `t1`.
    rerender(
      <Probe
        onMove={onMove}
        stages={[
          { stage: stage("backlog"), tasks: [card("t2", "backlog")] },
          { stage: stage("doing"), tasks: [card("t3", "doing")] },
          { stage: stage("done"), tasks: [] },
        ]}
      />,
    );
    layoutColumns();
    fireEvent(cardEl("t3"), buildDrop(300, 10));
    expect(onMove).not.toHaveBeenCalled();
    expect(gesture()).toEqual({ draggingTaskId: null, overStageSlug: null });
  });
});

describe("useDragCard — the escape path", () => {
  it("onDragEnd clears the gesture (Escape fires dragend and NO drop)", () => {
    const onMove = vi.fn();
    render(<Probe onMove={onMove} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    dragOver(cardEl("t3"), 300, 10);
    expect(gesture().overStageSlug).toBe("doing");
    fireEvent.dragEnd(cardEl("t1"));
    expect(gesture()).toEqual({ draggingTaskId: null, overStageSlug: null });
    // And the abandoned gesture cannot be completed by a later drop.
    fireEvent(cardEl("t3"), buildDrop(300, 10));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("dragging a second card replaces the first (two drags are never live at once)", () => {
    render(<Probe onMove={vi.fn()} />);
    layoutColumns();
    fireEvent.dragStart(cardEl("t1"), { dataTransfer: stubDataTransfer() });
    fireEvent.dragStart(cardEl("t3"), { dataTransfer: stubDataTransfer() });
    expect(gesture().draggingTaskId).toBe("t3");
    // `t3` lives in `doing`, so a pointer inside `doing` is a SAME-column pointer
    // for the new drag — the earlier `t1`/`backlog` answer must be gone, not
    // remembered.
    dragOver(cardEl("t3"), 300, 10);
    expect(gesture().overStageSlug).toBeNull();
  });
});
