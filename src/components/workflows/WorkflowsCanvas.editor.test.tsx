import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import WorkflowsCanvas from "./WorkflowsCanvas";
import { layoutWorkflowGraph, storedPositionOf } from "./workflowGraphLayout";
import { useSessions } from "../../store/sessions";
import { useTasks } from "../../store/tasks";
import { resetStores } from "../../test/resetStores";
import { clearSkillCatalogCache } from "../../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../../hooks/useMentionCatalogs";
import {
  getAutoGuards,
  getBoard,
  getBoardStrict,
  setStageNext,
  setStagePosition,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
} from "../../lib/tauri";

/**
 * The Workflows canvas as an EDITOR: the two writes that live on the picture itself
 * (drag-to-connect, drag-to-position), the round trip that decides whether a drag is
 * worth shipping at all, and **Tidy up**. The picture's own affordances (the handles,
 * the tab stops, the delete key) are `WorkflowsCanvas.test.tsx`.
 *
 * ## WHY A SECOND FILE
 *
 * `WorkflowsCanvas.test.tsx` was at 491 code lines and this half is a different subject:
 * one file asks "does the graph show the right thing", the other asks "does a gesture on
 * the graph change the right thing, and does it stay changed". The split is also the
 * split the repo already uses for a file at its recorded figure —
 * `tasks.workflows.test.ts` and `App.workflows.test.tsx` both state the reason.
 *
 * ## THE GESTURES ARE REAL, AND THAT IS THE POINT OF THIS FILE
 *
 * The read-only era's test file recorded that a pointer-down on a handle could not be
 * driven in jsdom, and used it to justify asserting a class instead. That turned out to
 * be an artefact of `fireEvent`: jsdom 30 refuses a `view` init on `MouseEvent` AND
 * leaves `event.view` null, and both `d3-drag` (`nodrag(event.view)` →
 * `view.document`) and `XYHandle` crash or bail on a null view. Constructing the event
 * and defining `view` afterwards — `pointerEvent()` below — makes the whole pipeline run:
 * the drag moves the node, `onNodeDragStop` fires with the drop point, and a handle
 * connection reaches `onConnect` with a real `{source, target}`. So every gesture here
 * drives the library's own handlers and asserts on what the STORE was asked to write.
 *
 * Two more stubs the gesture needs, both file-local on the
 * `components/chat/EmptyStateFilm.test.tsx` precedent that this suite's sibling states
 * at length (`ResizeObserver`, `offsetWidth`/`offsetHeight`, `DOMMatrixReadOnly`):
 *  - `document.elementFromPoint` — jsdom does not implement it and `XYHandle` calls it
 *    unguarded on every pointer-move to find the handle under the cursor. The stub hands
 *    back whichever handle the case says the pointer is over, which is what lets a case
 *    choose its drop target instead of hoping geometry agrees.
 *  - a second `mousemove` before the one that lands: `nodeDragThreshold` defaults to 1
 *    and `d3-drag` will not start a gesture it has not seen move past it, so a
 *    single-move gesture is a click. `dragNode()` moves twice for that reason.
 *
 * ## A THIRD STUB, AND IT IS THE ONE THAT DECIDES WHAT THIS FILE CAN ASSERT
 *
 * `getBoundingClientRect` is stubbed to a NON-DEGENERATE rect for the whole file. jsdom
 * answers it with an all-zero rect at (0,0) for every element, which tells xyflow the
 * canvas is zero wide; `autoPanOnNodeDrag` (ON by default, `autoPanSpeed: 15`) then
 * decides the dragged node is forever outside the viewport and pans by 15px on BOTH axes
 * on every animation frame, without ever settling. A node's painted `transform` is
 * `positionAbsolute` composited with the viewport's pan, so the DOM read drifts by a
 * constant +15 per flush while the MODEL sits perfectly still. Measured: the model said
 * `{x:160,y:110}` at three successive steps while the DOM read 205,155 → 220,170 →
 * 235,185. That drift is what made the round-trip case look like a product defect; it is
 * a jsdom geometry artefact, and with an honest rect the paint equals the model and stays
 * equal. See the note inside `THE ROUND TRIP` for what that does and does not license
 * this file to assert at the DOM.
 *
 * ONE THING THAT IS NOT A jsdom LIMIT, because the previous agent was told it was: the
 * connection line DOES render here, and a drag DOES reach `isValidConnection`. It needed
 * the two stubs above plus one React flush — the line is store state, so reading the DOM
 * synchronously after a dispatched `mousemove` reads a DOM that has not been painted yet.
 * What genuinely does not exist is the class the old case looked for: xyflow 13 emits
 * `classnames('react-flow__connection', { valid })` and has no `invalid` arm at all, so
 * `.react-flow__connection.invalid` cannot match in a browser either.
 *
 * ## THE MOCKS ECHO, because a round trip needs an echo
 *
 * `setStagePosition` and `setStageNext` answer the STORED row, so the factories here
 * build that row out of the arguments they were handed, from the slice the case seeded.
 * That is what makes the anti-snap-back case below a round trip through the store rather
 * than a mock that returns `[]` and a paint that silently drops the fields.
 */

const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 240,
  bottom: 104,
  width: 240,
  height: 104,
  toJSON: () => ({}),
};

let realGetBoundingClientRect: (() => DOMRect) | undefined;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 240,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 104,
  });
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
      constructor(_init?: string) {}
    },
  );
  class StubResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      setTimeout(() => {
        this.callback(
          [
            {
              contentRect: RECT as DOMRect,
              target,
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }, 0);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // HONEST GEOMETRY, and this one is load-bearing rather than cosmetic.
  //
  // jsdom answers `getBoundingClientRect()` with an all-zero rect at (0,0) for EVERY
  // element. xyflow reads that rect to decide whether the node being dragged has come
  // near the edge of the viewport, and with a 0×0 viewport at (0,0) any node position is
  // "outside" it, so `autoPanOnNodeDrag` (ON by default, `autoPanSpeed: 15`) pans by
  // 15px on every animation frame and never stops. The pan is the VIEWPORT's transform,
  // and the node's own DOM transform is `positionAbsolute` composited on top of it — so
  // a node's painted `translate()` drifts by +15px on both axes per flush for a reason
  // that has nothing to do with this component. Measured on this file before the stub:
  // the model said `{x:160,y:110}` at every step while the DOM read
  // 205,155 → 220,170 → 235,185 across three flushes.
  //
  // A rect that is merely NON-DEGENERATE (a real canvas, not a point) is what fixes it:
  // the node is then inside the viewport, the auto-pan settles after one step, and the
  // painted transform equals the model transform and STAYS equal. That is what makes the
  // round-trip assertion below able to compare a mid-drag paint with a post-re-derive
  // paint at all — see the note on `THE ROUND TRIP` for why the model assertion is still
  // the load-bearing one and the DOM one is the corroborating half.
  //
  // File-local, on the `EmptyStateFilm.test.tsx` precedent this file's header cites for
  // `ResizeObserver`/`offsetWidth`; restored in `afterAll` because, unlike the two
  // property defines above, this one replaces a method other suites may rely on.
  const CANVAS_RECT = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  };
  realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => CANVAS_RECT as DOMRect;
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (realGetBoundingClientRect !== undefined) {
    Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
    realGetBoundingClientRect = undefined;
  }
});

vi.mock("../../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn().mockResolvedValue([]),
    getBoardStrict: vi.fn().mockResolvedValue(false),
    setBoardStrict: vi.fn().mockResolvedValue(false),
    getAutoGuards: vi.fn().mockResolvedValue({ maxSteps: null, ceilingUsd: null }),
    setAutoGuards: vi.fn().mockResolvedValue({ maxSteps: null, ceilingUsd: null }),
    createStage: vi.fn().mockResolvedValue([]),
    renameStage: vi.fn().mockResolvedValue([]),
    setStageSkill: vi.fn().mockResolvedValue([]),
    // BOTH answer the stored row, built from the arguments — see the header. A stub
    // returning `[]` here would let the store paint an echo that says "no destinations"
    // and "no position", and the round-trip case would then be asserting on a fiction.
    setStageNext: vi.fn(),
    setStageAuto: vi.fn().mockResolvedValue([]),
    setStagePromptPrefix: vi.fn().mockResolvedValue([]),
    setStagePosition: vi.fn(),
    reorderStages: vi.fn().mockResolvedValue([]),
    deleteStage: vi.fn().mockResolvedValue([]),
    writeArtifact: vi.fn().mockResolvedValue([]),
    getArtifact: vi.fn().mockResolvedValue(null),
    createTask: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(null),
    editTask: vi.fn().mockResolvedValue({}),
    moveTask: vi.fn().mockResolvedValue({ onEnter: "none", boostNote: null }),
    reorderTasks: vi.fn().mockResolvedValue(undefined),
    linkSession: vi.fn().mockResolvedValue(undefined),
    startTaskSession: vi.fn().mockResolvedValue({
      sessionId: "snap1",
      cwd: "/w/alpha",
      capabilities: {},
      archived: false,
    }),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    listMcpServersEffective: vi.fn().mockResolvedValue([]),
    listSpaceListing: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    listCompletionEntries: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
  };
});

const SPACE = "/w/alpha";

const stage = (slug: string, over: Partial<StageDto> = {}): StageDto => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder: 0,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
  auto: false,
  promptPrefix: null,
  ...over,
});

const card = (id: string, stageSlug: string): TaskCardView => ({
  task: {
    id,
    spacePath: SPACE,
    number: 1,
    title: `Card ${id}`,
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

const column = (
  slug: string,
  over: Partial<StageDto> = {},
  taskCount = 0,
): StageWithTasks => ({
  stage: stage(slug, {
    sortOrder: ["backlog", "todo", "doing", "done"].indexOf(slug),
    ...over,
  }),
  tasks: Array.from({ length: taskCount }, (_, i) => card(`${slug}-${i}`, slug)),
});

/** What the case seeded, so the two echoing mocks can answer with a real row. */
let seeded: StageWithTasks[] = [];

/** Seed the Selected Space, the loaded slice, AND the read that would refill it — the
 *  three halves `WorkflowsCanvas.test.tsx` explains (the mount fetch replaces a slice
 *  seeded alone). Installs the two echoing command mocks against THIS slice. */
function seedBoardSlice(columns: StageWithTasks[]): void {
  seeded = columns;
  vi.mocked(getBoard).mockResolvedValue(columns);
  vi.mocked(setStagePosition).mockImplementation(async (_space, slug, x, y) => {
    const found = seeded.find((c) => c.stage.slug === slug);
    if (found === undefined) {
      // The server refuses a slug the Space does not hold, naming the ones it does.
      throw { kind: "not_found", message: `no stage ${slug}` };
    }
    return { ...found.stage, positionX: x, positionY: y };
  });
  vi.mocked(setStageNext).mockImplementation(async (_space, slug, slugs) => {
    const found = seeded.find((c) => c.stage.slug === slug);
    if (found === undefined) {
      throw { kind: "not_found", message: `no stage ${slug}` };
    }
    return { ...found.stage, nextSlugs: slugs };
  });
  act(() => {
    useSessions.setState({ activeSpacePath: SPACE });
    useTasks.setState({ boardsBySpace: { [SPACE]: columns }, loading: false });
  });
}

/** Let the deferred `ResizeObserver` callbacks and any pending write land. */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A `MouseEvent` whose `view` is the window. jsdom 30 rejects `view` in the init and
 *  leaves the getter null; `d3-drag` and `XYHandle` both read `event.view`, so a gesture
 *  built any other way dies inside the library. Defining it after construction is the
 *  only spelling that works, and it is what makes every gesture in this file real. */
function pointerEvent(type: string, init: MouseEventInit): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "view", { value: window });
  return event;
}

function dispatch(target: EventTarget, type: string, init: MouseEventInit): void {
  target.dispatchEvent(pointerEvent(type, init));
}

/** Drag a node from its own box to `to`, in flow coordinates.
 *
 *  Dispatched on `document.body` rather than through `fireEvent`, so the SAME event
 *  reaches the `window` listeners `d3-drag` installs and the `document` listeners
 *  `XYHandle` installs. The intermediate move is not decoration — see the header's
 *  `nodeDragThreshold` note. */
async function dragNode(from: Element, to: { x: number; y: number }): Promise<void> {
  await act(async () => {
    dispatch(from, "mousedown", { button: 0, buttons: 1, clientX: 10, clientY: 10 });
    dispatch(document.body, "mousemove", { buttons: 1, clientX: 40, clientY: 40 });
    dispatch(document.body, "mousemove", { buttons: 1, clientX: to.x, clientY: to.y });
    dispatch(document.body, "mouseup", { clientX: to.x, clientY: to.y });
  });
}

/** Drag from one node's SOURCE handle onto `onto`. `elementFromPoint` is what
 *  `XYHandle` uses to decide the drop target, so the case names it here. */
async function dragHandle(
  from: Element,
  onto: Element,
  to: { x: number; y: number },
): Promise<void> {
  const previous = document.elementFromPoint;
  document.elementFromPoint = () => onto;
  try {
    await act(async () => {
      dispatch(from, "mousedown", { button: 0, buttons: 1, clientX: 240, clientY: 52 });
      dispatch(document, "mousemove", { buttons: 1, clientX: 300, clientY: 52 });
      dispatch(document, "mousemove", { buttons: 1, clientX: to.x, clientY: to.y });
      dispatch(document, "mouseup", { clientX: to.x, clientY: to.y });
    });
  } finally {
    document.elementFromPoint = previous;
  }
}

const handleOf = (
  container: ParentNode,
  slug: string,
  type: "source" | "target",
): HTMLElement =>
  container.querySelector<HTMLElement>(
    `.react-flow__handle[data-nodeid="${slug}"].${type}`,
  )!;

const transformOf = (container: ParentNode, slug: string): string =>
  container.querySelector<HTMLElement>(`[data-testid="rf__node-${slug}"]`)!.style
    .transform;

/** The position dagre gives this column set, so a case can name the place a snap-back
 *  would land on instead of only asserting "it did not move". */
const dagrePositionOf = (columns: StageWithTasks[], slug: string): string => {
  const node = layoutWorkflowGraph(columns).nodes.find((n) => n.id === slug)!;
  return `translate(${node.position.x}px,${node.position.y}px)`;
};

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  vi.mocked(getBoard).mockClear();
  vi.mocked(getBoard).mockResolvedValue([]);
  vi.mocked(getBoardStrict).mockResolvedValue(false);
  vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: null, ceilingUsd: null });
});

describe("WorkflowsCanvas — drag to connect", () => {
  it("writes the one-item list for a column whose nextSlugs is null", async () => {
    // THE `null → [a]` PROOF, at the payload, on the canvas. `null` is UNCONFIGURED and
    // the fallback is the column at `sortOrder + 1` — `todo`, in this fixture — so the
    // drag lands on `doing`, a column the fallback is NOT. Drawing an edge out of an
    // unconfigured column configures it, and what it is configured to is exactly the one
    // edge on the canvas — the same list the panel's add-destination writes, because both
    // call `lib/workflowEdgeWrite`. A payload of `["doing"]` is therefore the coherent
    // answer; a payload that wrote the fallback in beside it (`["todo", "doing"]`, say)
    // would be the canvas inventing a destination nobody drew.
    //
    // WHAT THE WRITE ALSO DOES, because the payload is the least of it: the `backlog →
    // todo` wire the canvas was drawing as INFERRED is gone, `nextStepOf` now sends cards
    // to `doing`, and under Strict workflow the column goes from "any column may follow"
    // to "only `doing`" — not reversible through the UI (known-gaps §8). That is the
    // feature; `workflowEdgeWrite.ts`'s header and ADR 0120 carry the disclosure, and
    // `IMPLICIT_EDGE_CLASS` is what makes the wire being removed visible beforehand.
    seedBoardSlice([
      column("backlog"),
      column("todo", { nextSlugs: [] }),
      column("doing", { nextSlugs: [] }),
    ]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    await dragHandle(
      handleOf(container, "backlog", "source"),
      handleOf(container, "doing", "target"),
      { x: 500, y: 200 },
    );
    await settled();

    expect(setStageNext).toHaveBeenCalledTimes(1);
    expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", ["doing"]);
    // And the edge the store now reports is on the canvas: the write landed in the
    // picture through the slice, not through a local array.
    expect(
      document.querySelector('[data-testid="rf__edge-backlog->doing"]'),
    ).toBeTruthy();
  });

  it("refuses the drag that would only re-draw the inferred fallback wire", async () => {
    // THE CANVAS HALF of the no-op refusal. `backlog.nextSlugs` is `null`, so the picture
    // already carries a dashed `backlog → todo` wire; dropping onto `todo` would write
    // `["todo"]` with NO visible change and a Strict-mode narrowing behind it (ADR 0099;
    // known-gaps §8: not undoable from the UI). So the line reads refused while the
    // pointer is down and the handler writes nothing — the same gesture, the same answer
    // the panel gives, from the one owner in `lib/workflowEdgeWrite`.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    // The wire the refusal protects really is on screen before the gesture — otherwise
    // this case would be refusing a drag onto nothing.
    expect(
      document.querySelector('[data-testid="rf__edge-backlog->todo"]'),
    ).toBeTruthy();

    await dragHandle(
      handleOf(container, "backlog", "source"),
      handleOf(container, "todo", "target"),
      { x: 500, y: 52 },
    );
    await settled();

    expect(setStageNext).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    // And the inferred wire is still the inferred wire — nothing was re-styled or
    // re-labelled behind the person's back.
    const edge = document.querySelector(".react-flow__edge[data-id='backlog->todo']")!;
    expect(edge.classList.contains("workflow-edge-implicit")).toBe(true);
  });

  it("appends to an existing list without stealing its head", async () => {
    // `[0]` is the edge the auto-chain follows, so an append that became a prepend would
    // silently repoint the chain at the column the person just added as a SECOND choice.
    seedBoardSlice([
      column("backlog", { nextSlugs: ["todo"] }),
      column("todo", { nextSlugs: [] }),
      column("doing", { nextSlugs: [] }),
    ]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    await dragHandle(
      handleOf(container, "backlog", "source"),
      handleOf(container, "doing", "target"),
      { x: 500, y: 200 },
    );
    await settled();

    expect(setStageNext).toHaveBeenCalledTimes(1);
    expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", ["todo", "doing"]);
  });

  it("writes nothing for a self-loop, and the line it is down reads as refused", async () => {
    // `set_stage_next` refuses a column's own slug (`BoardError::SelfLoop`), so painting
    // the edge would be showing a chain for one frame and reverting it the next. The
    // refusal is ALSO handed to `isValidConnection`, so the line the person is dragging
    // says "no" WHILE IT IS STILL DOWN instead of silently disappearing — a gesture that
    // ends in nothing with no signal is a broken control.
    //
    // TWO THINGS THE PREVIOUS VERSION OF THIS CASE GOT WRONG, both measured:
    //
    //  1. It read the line SYNCHRONOUSLY after the move. The line is React state
    //     (`connectionStore` → `ConnectionLine`), so it does not exist in the DOM until
    //     React has flushed. Measured: `line=false` synchronously, `line=true` after one
    //     `setTimeout(0)` inside the `act`. The case therefore asserted on an element that
    //     had not been created yet, and it ALSO left `XYHandle.onPointerMove` to crash on
    //     `doc.elementFromPoint` — jsdom does not implement it — which is the unhandled
    //     error this file's header says it stubs. So the failure was never "jsdom cannot
    //     do gestures"; it was "this case did not flush, and did not stub".
    //  2. It looked for a class xyflow does not emit. `@xyflow/react@13.0.3` builds the
    //     connection class as `classnames('react-flow__connection', { valid: isValid })`
    //     — see `ConnectionLine`/`qi` in `dist/index.js`, where the second argument is
    //     `classnames(isValid)`. There is NO `invalid` arm anywhere in the shipped bundle.
    //     The refusal is signalled by the ABSENCE of `valid`, not the presence of
    //     `invalid`, so `.react-flow__connection.invalid` could not have matched in a real
    //     browser either. THIS IS WHY THE CASE COULD ONLY EVER HAVE BEEN FALSE.
    //
    // So the assertion is on the spelling xyflow actually paints, and it is kept at the
    // DOM rather than moved to `canConnectStages` because the DOM half is the INTEGRATION
    // worth pinning here: `workflowEdgeWrite.test.ts` already proves
    // `canConnectStages(…, "backlog", "backlog") === false` as a pure rule, and what only
    // this case can prove is that the CANVAS hands that rule to `isValidConnection`.
    //
    // 3. AND A THIRD THING, measured when the frontend review re-ran the mutation this
    //    case's commit body claimed. That body asserted *"dropping the canvas's
    //    `isValidConnection` prop reddens it"*. **It did not.** With the prop removed, all
    //    11 cases in this file stayed green. The reason is the `isValidHandle`
    //    short-circuit spelled on the `selfTarget` line below: this case pointed
    //    `elementFromPoint` at the node's own SOURCE handle, the strict connection mode
    //    rejects a source handle as the END of a source-initiated drag, and
    //    `isValidConnection` is never called — so xyflow's default `() => true` could not
    //    be caught by a gesture that never reached it. Pointing at the node's own TARGET
    //    handle is the fix, and it is what makes the prop-removal mutation redden THIS
    //    case again (measured: `expected 'react-flow__connection valid' not to contain
    //    'valid'`). It reddens on `if (source === target) return false` in
    //    `canConnectStages` too, which the review had measured as canvas-invisible.
    //
    // What the prop-removal mutation ALSO reddens, and did before this fix, is the two
    // POSITIVE cases (`writes the one-item list…`, `appends to an existing list…`): a
    // `() => false` predicate blocks the drop. So the prop was never wholly unexercised —
    // it was exercised only on the accept path, and this case only ever looked at the
    // refuse path. That is the precise shape of the gap, and it is why the sentence in the
    // commit body was wrong rather than merely optimistic.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const source = handleOf(container, "backlog", "source");
    // The drop target is the SAME NODE'S TARGET HANDLE, and that is the whole fix for
    // this case's vacuity. `isValidHandle` (@xyflow/system) computes
    // `connectable && connectableEnd && <connectionMode arm> && isValidConnection(...)`,
    // and the default `connectionMode` is `"strict"`, whose arm for a drag started on a
    // SOURCE handle is `handleType === "target"`. Pointing at the source handle the drag
    // left (`document.elementFromPoint = () => source`) therefore fails that arm and
    // SHORT-CIRCUITS before the predicate is called — which is why this case stayed green
    // with `isValidConnection` deleted from `<ReactFlow>`. Landing on the node's own
    // target handle passes the arm, reaches `isValidConnection` with
    // `{source: "backlog", target: "backlog"}`, and is also the gesture a person drawing
    // a self-loop actually performs.
    const selfTarget = handleOf(container, "backlog", "target");
    const lineClass = async (): Promise<string | null> => {
      // One flush, so the element React is about to paint is actually there to read.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return document
        .querySelector(".react-flow__connection")
        ?.getAttribute("class") ?? null;
    };

    let refusedWhileDown: string | null = null;
    const previous = document.elementFromPoint;
    // The pointer is over the node's OWN TARGET handle: same column at both ends, which
    // is what a self-loop is, and a handle type the strict connection mode will accept.
    document.elementFromPoint = () => selfTarget;
    try {
      await act(async () => {
        dispatch(source, "mousedown", { button: 0, buttons: 1, clientX: 240, clientY: 52 });
        dispatch(document, "mousemove", { buttons: 1, clientX: 300, clientY: 52 });
      });
      // Read the line BEFORE the release: after it the connection state is cancelled and
      // the element is gone, so this is the only moment the verdict is observable.
      refusedWhileDown = await lineClass();
      await act(async () => {
        dispatch(document, "mouseup", { clientX: 300, clientY: 52 });
      });
    } finally {
      document.elementFromPoint = previous;
    }
    await settled();

    // The line IS down (so this is not the vacuous pass where no gesture happened at
    // all), and it does not read as a valid connection.
    expect(refusedWhileDown, "a line is painted while the pointer is down").not.toBeNull();
    expect(refusedWhileDown, "the line does not read valid over its own node").not.toContain(
      "valid",
    );
    expect(setStageNext).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the same line as VALID over another column, so the refusal above is a verdict", async () => {
    // The positive arm of the case above, and the reason it is not a tautology. xyflow
    // signals an accepted connection by ADDING `valid`; if that class never appeared in
    // jsdom at all then "does not contain valid" would pass on a broken canvas too. This
    // drives the identical gesture onto a real other column and requires the class.
    //
    // `doing` and not `todo`, and that is load-bearing rather than tidy: `backlog` is
    // unconfigured here, so `todo` is its `sortOrder + 1` fallback and the drop onto it is
    // the refused no-op (see the case that names it). `doing` is a genuine new destination,
    // so the line reads valid — which is also what makes this arm the positive control for
    // the no-op refusal and not only for the self-loop one.
    seedBoardSlice([
      column("backlog"),
      column("todo", { nextSlugs: [] }),
      column("doing", { nextSlugs: [] }),
    ]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const source = handleOf(container, "backlog", "source");
    const target = handleOf(container, "doing", "target");
    const previous = document.elementFromPoint;
    document.elementFromPoint = () => target;
    let lineClassWhileDown: string | null = null;
    try {
      await act(async () => {
        dispatch(source, "mousedown", { button: 0, buttons: 1, clientX: 240, clientY: 52 });
        dispatch(document, "mousemove", { buttons: 1, clientX: 300, clientY: 52 });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      lineClassWhileDown =
        document.querySelector(".react-flow__connection")?.getAttribute("class") ?? null;
      await act(async () => {
        dispatch(document, "mouseup", { clientX: 300, clientY: 52 });
      });
    } finally {
      document.elementFromPoint = previous;
    }
    await settled();

    expect(lineClassWhileDown).toContain("valid");
  });

  it("writes nothing for a drag onto a ghost node, whose slug the server refuses", async () => {
    // A ghost is an edge whose target column the read cannot name. `set_stage_next`
    // refuses an unknown slug, so this drag can only fail — and `isValidConnection`
    // refuses it for the same reason it refuses a self-loop.
    seedBoardSlice([column("doing", { nextSlugs: ["archived"] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByTestId("workflow-node-missing-archived")).toBeTruthy();

    await dragHandle(
      handleOf(container, "doing", "source"),
      handleOf(container, "archived", "target"),
      { x: 500, y: 52 },
    );
    await settled();

    expect(setStageNext).not.toHaveBeenCalled();
  });

  it("writes nothing when the destination is already there", async () => {
    // The person asked for the edge that is already drawn. A second identical id in one
    // `edges` array makes xyflow render one and warn, and the write would be a no-op the
    // error line could not explain.
    seedBoardSlice([column("backlog", { nextSlugs: ["todo"] }), column("todo")]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    await dragHandle(
      handleOf(container, "backlog", "source"),
      handleOf(container, "todo", "target"),
      { x: 500, y: 52 },
    );
    await settled();

    expect(setStageNext).not.toHaveBeenCalled();
  });
});

describe("WorkflowsCanvas — drag to position, and the position round trip", () => {
  it("THE ROUND TRIP: the node is STILL where it was dropped once the store answers", async () => {
    // THE MOST IMPORTANT CASE IN THIS TASK, and the one that most easily passes
    // vacuously. The sequence a person performs is:
    //
    //   1. drag the box and let go;
    //   2. the canvas asks the store to remember the drop point (`setStagePosition`);
    //   3. the command answers the stored row, the store paints it onto the slice;
    //   4. the slice re-publishes → the layout effect RE-DERIVES the graph → xyflow is
    //      handed a fresh node array built from THAT row.
    //
    // Step 4 is where a snap-back lives. If the layout answers dagre again, the box
    // teleports back to the rank it came from one tick after the person placed it, which
    // is worse than a canvas that cannot be dragged. So the case drives all four steps
    // against the REAL store and the echoing command mock, and asserts the transform is
    // byte-identical after step 4 — and it pins the intermediate facts so it cannot pass
    // by nothing having happened:
    //
    //   - the drop MOVED the box (`moved` below), and the drop point is NOT dagre's;
    //   - `setStagePosition` was called with the drop point;
    //   - the SLICE carries the pair (so the re-derivation had the number to read back —
    //     without this, "still there" could be xyflow's own local state and the layout
    //     would never have been asked);
    //   - and the transform is unchanged.
    //
    // MUTATION, measured: drop the stored-pair branch in `workflowGraphLayout.ts`'s
    // `positionOf` (return `computed.get(slug)` alone). Then step 4 hands xyflow dagre's
    // box and the final assertion fails with the dagre transform — which is exactly the
    // teleport the case is named for. Two other mutations redden it too: a layout that
    // reads `positionX || dagreX` (fails the `0` arm of the pair rule, pinned in
    // `workflowGraphLayout.test.ts`), and a canvas that reads the selection out of
    // xyflow's store instead of the slice (fails nothing here, and nothing anywhere —
    // which is why the SLICE assertion above is in this case rather than left out).
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const before = transformOf(container, "backlog");
    await dragNode(container.querySelector<HTMLElement>('[data-testid="rf__node-backlog"]')!, {
      x: 200,
      y: 150,
    });

    // (2) the write, with the drop point and both coordinates of one pair.
    expect(setStagePosition).toHaveBeenCalledTimes(1);
    const [writeSpace, writeSlug, writeX, writeY] = vi.mocked(setStagePosition).mock
      .calls[0]!;
    expect(writeSpace).toBe(SPACE);
    expect(writeSlug).toBe("backlog");
    expect(Number.isFinite(writeX)).toBe(true);
    expect(Number.isFinite(writeY)).toBe(true);

    const dropped = transformOf(container, "backlog");
    // The drag really moved the box, and it is not standing on dagre's answer — so the
    // "still there" assertion below cannot be satisfied by a gesture that did nothing.
    expect(dropped).not.toBe(before);
    expect(dropped).not.toBe(dagrePositionOf([column("backlog"), column("todo", { nextSlugs: [] })], "backlog"));

    // (3) the store echoed the pair onto the slice — the re-derivation has a number to
    // read, and it is the one the pointer chose.
    const row = useTasks
      .getState()
      .boardsBySpace[SPACE]!.find((c) => c.stage.slug === "backlog")!.stage;
    expect(row.positionX).toBe(writeX);
    expect(row.positionY).toBe(writeY);

    // (4) re-derive, and the box does not move.
    await settled();

    // THE ANTI-SNAP-BACK ITSELF, in the two layers that can carry it.
    //
    // (a) THE MODEL. The layout re-derived from the slice the store now holds answers the
    //     pair that was written, verbatim. This is the load-bearing assertion: it is what
    //     `positionOf`'s stored-first ordering exists to guarantee, and it is what the
    //     "drop the stored-pair branch" mutation reddens. `workflowGraphLayout.test.ts`
    //     proves the same rule for a hand-built fixture; what only THIS case can prove is
    //     the integration — that the number the POINTER chose, carried through the real
    //     store's optimistic paint and the command's echo, is the number the layout reads
    //     back. Delete either half and this still passes; that is the point of it.
    const reDerived = layoutWorkflowGraph(
      useTasks.getState().boardsBySpace[SPACE]!,
    ).nodes.find((n) => n.id === "backlog")!.position;
    expect(reDerived).toEqual({ x: writeX, y: writeY });

    // (b) THE PAINT. And here the honest answer about what jsdom can express:
    //
    // A node's DOM `transform` is NOT the model position. It is `positionAbsolute`
    // composited with the VIEWPORT's pan/zoom, and xyflow pans the viewport by itself
    // during a drag (`autoPanOnNodeDrag`, `autoPanSpeed: 15`). In bare jsdom every
    // `getBoundingClientRect()` is a 0×0 rect at (0,0), so the viewport is "0 wide" and
    // every node is "outside" it — the auto-pan therefore runs forever, +15px on both
    // axes per animation frame, and the painted transform drifts while the model sits
    // still. Measured before this file stubbed a real rect: the model said
    // `{x:160,y:110}` at all three steps while the DOM read 205,155 → 220,170 → 235,185.
    // THAT was the "+15 on both axes" that made this case look like a product defect. It
    // is not one: it is xyflow panning a zero-sized viewport, and it is why the previous
    // version of this case compared a mid-drag paint against a post-re-derive paint and
    // found a constant offset.
    //
    // With a non-degenerate rect (the `beforeAll` above) the auto-pan settles after one
    // step and the painted transform equals the model transform and STAYS equal, so the
    // comparison below is meaningful. It is written to pin the VALUE rather than to
    // compare two DOM reads against each other: `translate(writeX, writeY)` is the number
    // the pointer chose, so a canvas that held its own position, or a layout that fell
    // back to dagre, produces a different string. `toBe(dropped)` is kept alongside it
    // because it is the literal claim of the case's name — the box is where it was left.
    const final = transformOf(container, "backlog");
    expect(final).toBe(dropped);
    expect(final).toBe(`translate(${writeX}px,${writeY}px)`);
    // And it is still NOT dagre's box, spelled from the graph rather than remembered.
    expect(final).not.toBe(
      dagrePositionOf([column("backlog"), column("todo", { nextSlugs: [] })], "backlog"),
    );
  });

  it("puts the box back and says why, when the write is refused", async () => {
    // The other half of the round trip. The store reverts the paint and writes the
    // sentence into `error`; if the layout were the one holding a local position, the box
    // would stay at the drop point over a Space that refused to store it — a node the
    // person believes they moved until the next fetch teleports it.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    vi.mocked(setStagePosition).mockRejectedValueOnce({
      kind: "db",
      message: "set_stage_position failed",
    });
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const before = transformOf(container, "backlog");
    await dragNode(container.querySelector<HTMLElement>('[data-testid="rf__node-backlog"]')!, {
      x: 200,
      y: 150,
    });
    await settled();

    // The MODEL first: the store reverted the paint, so the row holds no pair again and
    // the layout re-derives to dagre. This is the assertion that says the canvas is not
    // holding a position of its own — a canvas with local position state would keep the
    // drop point here and only this assertion would notice.
    //
    // ASKED WITH THE LAYOUT'S OWN PAIR RULE, not as `toBeNull()`. The store's revert
    // paints the slice it captured BEFORE the write, and this fixture's factory never set
    // the two fields at all, so they read `undefined` here where a real `StageDto` would
    // read `null`. Asserting `null` would pin that fixture artefact rather than the
    // behaviour, and `storedPositionOf` is exactly the function that treats both spellings
    // as "nobody ever moved it" — the same rule the canvas's Tidy up reads.
    const slice = useTasks.getState().boardsBySpace[SPACE]!;
    expect(storedPositionOf(slice.find((c) => c.stage.slug === "backlog")!.stage)).toBeNull();
    expect(
      layoutWorkflowGraph(slice).nodes.find((n) => n.id === "backlog")!.position,
    ).toEqual({ x: 0, y: 0 });

    // And the paint agrees. Valid only because this file gives xyflow a non-degenerate
    // `getBoundingClientRect` — see the note in `beforeAll` and the longer one in the
    // round-trip case; without it the auto-pan drift makes this comparison meaningless.
    expect(transformOf(container, "backlog")).toBe(before);
    // The panel is the error surface for this view, and it is mounted — so the refusal
    // has somewhere to be said.
    expect(
      within(screen.getByTestId("workflow-settings-panel")).getByRole("alert")
        .textContent,
    ).toContain("set_stage_position failed");
  });

  it("draws the ghost node NOT draggable, since its position is a slug the server refuses", async () => {
    // A ghost is not a column: `set_stage_position` refuses it, so a draggable ghost is a
    // guaranteed failure and a guaranteed snap-back. The flag is off at the source
    // (`workflowGraphLayout.ts`), and this is the render half — xyflow puts
    // `react-flow__node-draggable` on the wrapper for a node it will let be dragged.
    seedBoardSlice([column("doing", { nextSlugs: ["archived"] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const ghost = container.querySelector<HTMLElement>("[data-testid='rf__node-archived']")!;
    const real = container.querySelector<HTMLElement>("[data-testid='rf__node-doing']")!;
    expect(ghost.classList.contains("draggable")).toBe(false);
    expect(real.classList.contains("draggable")).toBe(true);
  });
});

describe("WorkflowsCanvas — Tidy up", () => {
  it("clears every positioned column and lets dagre re-rank the graph", async () => {
    // Without this, a hand-arranged board can never be un-arranged: every node's stored
    // pair outranks dagre forever, and the only way back is a database edit. ONE clear
    // per positioned column, `null` in both coordinates — the pair's only spelling of
    // "nobody ever moved it", and the reason there is no bulk verb here.
    const arranged = [
      column("backlog", { positionX: 1200, positionY: 900 }),
      column("todo", { nextSlugs: [], positionX: -400, positionY: -300 }),
      // Never arranged, so NOT cleared — a clear of a node that has no pair would be a
      // write that changes nothing and a row of pointless round trips.
      column("doing", { nextSlugs: [] }),
    ];
    // THE REFERENCE IS THE GRAPH WITH THE PAIRS GONE. The previous version of this line
    // asked for `dagrePositionOf(arranged, …)` — the SAME `arranged` array it had just
    // seeded, stored pairs and all. `layoutWorkflowGraph` honours a stored pair, so that
    // call answers `{1200, 900}`, and the case demanded the painted box equal the very
    // position the control exists to erase. It failed with
    // `expected 'translate(0px,0px)' to be 'translate(1200px,900px)'`, i.e. the PRODUCT
    // WAS RIGHT AND THE EXPECTATION WAS THE BUG. This fixture is the same three columns
    // with no pair on any of them, which is the state after a successful Tidy up, and it
    // is spelled out here rather than read back off the store so the reference stays
    // independent of the thing under test.
    const unarranged = [
      column("backlog"),
      column("todo", { nextSlugs: [] }),
      column("doing", { nextSlugs: [] }),
    ];
    seedBoardSlice(arranged);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const before = transformOf(container, "backlog");
    expect(before).toBe("translate(1200px,900px)");

    fireEvent.click(screen.getByRole("button", { name: "Tidy up" }));
    await settled();

    expect(setStagePosition).toHaveBeenCalledTimes(2);
    expect(setStagePosition).toHaveBeenCalledWith(SPACE, "backlog", null, null);
    expect(setStagePosition).toHaveBeenCalledWith(SPACE, "todo", null, null);
    // The node that had no pair was left alone.
    expect(setStagePosition).not.toHaveBeenCalledWith(SPACE, "doing", null, null);

    // Every pair is off the slice, so the layout has nothing left to honour. Asked with
    // `storedPositionOf` for the reason the case above gives: the two cleared rows come
    // back `null` from the echoing command, and the one row that was never written is
    // `undefined` in this fixture — both read as unpositioned, and that is the claim.
    const slice = useTasks.getState().boardsBySpace[SPACE]!;
    for (const slug of ["backlog", "todo", "doing"]) {
      expect(storedPositionOf(slice.find((c) => c.stage.slug === slug)!.stage)).toBeNull();
    }

    // And dagre has the graph again — `backlog` is back at the box the ranker chose,
    // which is the point of the control rather than a side effect of it. Pinned at the
    // model AND at the paint: the model because that is where "dagre re-ranked" is
    // actually decided, the paint because it is what the person sees.
    expect(transformOf(container, "backlog")).not.toBe(before);
    expect(
      layoutWorkflowGraph(slice).nodes.find((n) => n.id === "backlog")!.position,
    ).toEqual(layoutWorkflowGraph(unarranged).nodes.find((n) => n.id === "backlog")!.position);
    expect(transformOf(container, "backlog")).toBe(
      dagrePositionOf(unarranged, "backlog"),
    );
    // dagre's own answer is not the origin by accident — the second column is elsewhere,
    // so a layout that returned `{0,0}` for everything would not satisfy the line above.
    expect(dagrePositionOf(unarranged, "todo")).not.toBe(
      dagrePositionOf(unarranged, "backlog"),
    );
  });

  it("is inert, and writes nothing, when nobody has arranged anything", async () => {
    // The state every board starts in. `aria-disabled` and not a missing button, so the
    // header does not reflow on the first drag and the reason is announced; the guard in
    // the handler is what actually decides, and that is what this asserts.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    render(<WorkflowsCanvas />);
    await settled();

    const tidy = screen.getByRole("button", { name: "Tidy up" });
    expect(tidy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(tidy);
    await settled();
    expect(setStagePosition).not.toHaveBeenCalled();
  });
});
