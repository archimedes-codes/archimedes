import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import WorkflowsCanvas from "./WorkflowsCanvas";
import { NODE_HEIGHT, NODE_WIDTH } from "./workflowGraphLayout";
import { useSessions } from "../../store/sessions";
import { useTasks } from "../../store/tasks";
import { resetStores } from "../../test/resetStores";
import { clearSkillCatalogCache } from "../../hooks/useSkillCatalog";
import { getAutoGuards, getBoard, getBoardStrict } from "../../lib/tauri";
import type { StageDto, StageWithTasks, TaskCardView } from "../../lib/tauri";

/**
 * The **Workflows** canvas — the graph view `App`'s `"workflows"` arm renders.
 *
 * THE BARREL MOCK OVERRIDES THE WRAPPER NAMES (`getBoard`, not `get_board`) — the
 * store imports the wrappers, so mocking the Rust command names would leave the real
 * wrapper live and rejecting in jsdom. The Stage-verb set is mocked because a node
 * click mounts the real `StageEditor`, which drives them through the store; an
 * un-mocked one reaches a real `invoke` and lands its sentence in the store's `error`
 * cell that this file's own assertions read.
 *
 * TWO RESETS in `beforeEach`, both load-bearing, copied from `TasksBoard.test.tsx`:
 * `resetStores()` (the store half of isolation — `useTasks` is in `ALL_STORES`) plus
 * the store's own `reset()`, the only thing that reaches the module-scope load epoch.
 *
 * ## THE FILE-LOCAL OBSERVER STUBS — and why they live here
 *
 * `src/test/setup.tsx` installs `matchMedia` / the scroll APIs / the pointer-capture
 * trio and deliberately NOT `ResizeObserver` or `IntersectionObserver`; the only stub
 * in the repo is file-local in `components/chat/EmptyStateFilm.test.tsx`, and this
 * follows that precedent rather than widening the shared setup.
 *
 * A `<ReactFlow>` render NEEDS them, measured rather than assumed:
 *  - `ResizeObserver` is constructed unguarded by `useResizeHandler`, so a render
 *    without it throws `ResizeObserver is not defined` out of a passive effect and
 *    every case in the file dies.
 *  - `offsetWidth` / `offsetHeight` are what `getDimensions` reads, and jsdom reports
 *    0. A node with no measured dimensions stays `visibility: hidden` and never gets
 *    handle bounds, and an edge with no handle bounds renders NOTHING — so the edge
 *    assertions below would be asserting on an empty `<div class="react-flow__edges">`.
 *  - `DOMMatrixReadOnly` is read when recomputing the node internals (the viewport's
 *    zoom), and jsdom does not ship it.
 *  - The callback fires on a `setTimeout`, because xyflow only reveals a node once its
 *    dimensions arrive from a LATER tick; calling back synchronously from `observe()`
 *    leaves every node hidden and every edge unrendered, which was measured here.
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
});

afterAll(() => {
  vi.unstubAllGlobals();
});

vi.mock("../../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn().mockResolvedValue([]),
    // The Stage editor's mount read. Un-mocked it rejects in jsdom and writes its
    // message into the store's `error` cell, which this file's error-line assertions
    // read — the noisy-green case the barrel mock exists to prevent.
    getBoardStrict: vi.fn().mockResolvedValue(false),
    setBoardStrict: vi.fn().mockResolvedValue(false),
    getAutoGuards: vi.fn().mockResolvedValue({ maxSteps: null, ceilingUsd: null }),
    setAutoGuards: vi.fn().mockResolvedValue({ maxSteps: null, ceilingUsd: null }),
    createStage: vi.fn().mockResolvedValue([]),
    renameStage: vi.fn().mockResolvedValue([]),
    setStageSkill: vi.fn().mockResolvedValue([]),
    setStageNext: vi.fn().mockResolvedValue([]),
    setStageAuto: vi.fn().mockResolvedValue([]),
    setStagePromptPrefix: vi.fn().mockResolvedValue([]),
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
    listSpaceListing: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
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

/** Seed the Selected Space, the loaded slice, AND the read that would refill it.
 *
 *  The canvas reads `activeSpacePath` (the SELECTED Space, not a Session's folder) and
 *  `boardsBySpace[path]`, so both halves are needed — the same reason
 *  `App.test.tsx`'s board helper seeds both.
 *
 *  The `getBoard` arm is the third half, and it is not ceremony: this view LOADS on
 *  mount (that is the behaviour the loading cases below pin), so a slice seeded alone
 *  is REPLACED by the mount fetch a tick later — measured, every node case failed on
 *  "This Space has no stages yet" until the mock was aligned with the seed. Seeding the
 *  read to answer the SAME columns makes the mount fetch a no-op for these cases and
 *  leaves the assertions about the graph, not about a race. */
function seedBoardSlice(columns: StageWithTasks[]): void {
  vi.mocked(getBoard).mockResolvedValue(columns);
  act(() => {
    useSessions.setState({ activeSpacePath: SPACE });
    useTasks.setState({ boardsBySpace: { [SPACE]: columns }, loading: false });
  });
}

/** Let the deferred `ResizeObserver` callbacks land.
 *
 *  xyflow reveals a node only once its dimensions arrive from a later tick, and an
 *  edge renders only once BOTH endpoints have handle bounds — so the node and edge
 *  assertions all sit behind this. Without it the nodes are present in the DOM but
 *  `visibility: hidden` and the edges are absent entirely. */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  vi.mocked(getBoard).mockClear();
  vi.mocked(getBoard).mockResolvedValue([]);
  vi.mocked(getBoardStrict).mockResolvedValue(false);
  vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: null, ceilingUsd: null });
});

describe("WorkflowsCanvas — the nodes", () => {
  it("draws one node per column, labelled from the row", async () => {
    seedBoardSlice([column("backlog"), column("todo"), column("doing", {}, 2)]);
    render(<WorkflowsCanvas />);
    await settled();
    for (const slug of ["backlog", "todo", "doing"]) {
      expect(screen.getByTestId(`workflow-node-${slug}`), slug).toBeTruthy();
    }
    expect(screen.getByText("Backlog")).toBeTruthy();
    expect(screen.getByText("Todo")).toBeTruthy();
    // The card count rides the node, so a column with two cards says two.
    expect(screen.getByTestId("workflow-node-doing").textContent).toContain("2");
  });

  it("marks an auto column, shows its Skill, and marks its extra prompt", async () => {
    seedBoardSlice([
      column("doing", {
        auto: true,
        onEnterSkill: "specify",
        promptPrefix: "Read the card first.",
      }),
    ]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByTestId("workflow-node-auto-doing").textContent).toContain("Auto");
    expect(screen.getByTestId("workflow-node-skill-doing").textContent).toContain(
      "specify",
    );
    expect(screen.getByTestId("workflow-node-prompt-doing")).toBeTruthy();
  });

  it("marks NOTHING for the plain reading — an absent Skill is not a badge", async () => {
    // The counterpart to the case above, and the half that keeps the badges signal
    // rather than noise: a board that predates the feature has no Skill, no auto and
    // no extra prompt on any column.
    seedBoardSlice([column("doing")]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.queryByTestId("workflow-node-auto-doing")).toBeNull();
    expect(screen.queryByTestId("workflow-node-skill-doing")).toBeNull();
    expect(screen.queryByTestId("workflow-node-prompt-doing")).toBeNull();
  });

  it("marks a column with no outgoing edge as a dead end, and not one with an edge", async () => {
    // The thing a person cannot see on a kanban, and the reason the canvas exists: an
    // auto chain that stops here stops invisibly.
    // `todo` is at `sortOrder 1`, so `backlog`'s UNCONFIGURED fallback has somewhere to
    // land and `backlog` is NOT a dead end; `todo` is configured to stop and IS one.
    // (With `doing` here instead the pair would be two dead ends, because there is no
    // column at `sortOrder 1` for the fallback to find — which is a different case, and
    // the layout file already pins it.)
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByTestId("workflow-node-dead-end-todo")).toBeTruthy();
    expect(screen.queryByTestId("workflow-node-dead-end-backlog")).toBeNull();
  });
});

describe("WorkflowsCanvas — the edges", () => {
  it("draws an edge for every hop the graph reports", async () => {
    seedBoardSlice([
      column("backlog", { nextSlugs: ["doing"] }),
      column("todo", { nextSlugs: ["done"] }),
      column("doing", { nextSlugs: ["done"] }),
      column("done", { nextSlugs: [] }),
    ]);
    render(<WorkflowsCanvas />);
    await settled();
    const drawn = [
      ...document.querySelectorAll(".react-flow__edge"),
    ].map((el) => el.getAttribute("data-id"));
    expect(drawn.sort()).toEqual([
      "backlog->doing",
      "doing->done",
      "todo->done",
    ]);
  });

  it("draws the sortOrder + 1 edge when nextSlugs is null", async () => {
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(
      document.querySelector('[data-testid="rf__edge-backlog->todo"]'),
    ).toBeTruthy();
  });

  it("draws NO edge when nextSlugs is [], which is never the null case", async () => {
    // ADR 0099, on the canvas rather than in the pure module. The two fixtures differ
    // ONLY in `null` versus `[]`; read with `||` instead of `??` they draw the same
    // picture and the canvas shows a chain the person deleted.
    seedBoardSlice([column("backlog", { nextSlugs: [] }), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    // And the column says so, which is the visible half of the same fact.
    expect(screen.getByTestId("workflow-node-dead-end-backlog")).toBeTruthy();
  });

  it("keeps an edge to a column the read cannot name, and shows it as missing", async () => {
    // `nextStepSlugs` REPORTS an unresolvable slug (its header argues why). An edge to
    // a node id that does not exist renders nothing at all in xyflow, so dropping it
    // here would make the broken edge invisible.
    seedBoardSlice([column("doing", { nextSlugs: ["archived"] })]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByTestId("workflow-node-missing-archived")).toBeTruthy();
    expect(document.querySelector('[data-testid="rf__edge-doing->archived"]')).toBeTruthy();
  });
});

describe("WorkflowsCanvas — it loads its own store", () => {
  it("calls load for the Selected Space when the slice is empty", async () => {
    // THE PIN FOR THE ONE-CALL-SITE PROBLEM. `store/tasks.ts`'s `load` had exactly one
    // production call site (`TasksBoard`) before this view, so a canvas that only read
    // the slice would draw an empty graph on a Space whose board was never mounted —
    // the door works, the click works, and the picture is blank.
    act(() => {
      useSessions.setState({ activeSpacePath: SPACE });
    });
    render(<WorkflowsCanvas />);
    await settled();
    expect(getBoard).toHaveBeenCalledTimes(1);
    expect(getBoard).toHaveBeenCalledWith(SPACE);
  });

  it("draws the columns the load brings back", async () => {
    vi.mocked(getBoard).mockResolvedValue([column("backlog"), column("todo")]);
    act(() => {
      useSessions.setState({ activeSpacePath: SPACE });
    });
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByTestId("workflow-node-backlog")).toBeTruthy();
    expect(screen.getByTestId("workflow-node-todo")).toBeTruthy();
  });

  it("does NOT fetch when no Space is selected, and says so", async () => {
    // `createTask(null, …)` is not a thing and `get_board` needs a Space; the board
    // disables its controls in this state, and the canvas has no button to disable, so
    // it names the state instead of painting a blank rectangle.
    render(<WorkflowsCanvas />);
    await settled();
    expect(getBoard).not.toHaveBeenCalled();
    expect(screen.getByText(/No Space is open/)).toBeTruthy();
  });

  it("says the Space has no stages when the loaded slice is empty", async () => {
    seedBoardSlice([]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByText(/no stages yet/)).toBeTruthy();
    // And it did NOT draw a node for nothing.
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("distinguishes never-loaded from empty, so a failed fetch is not called empty", async () => {
    // `columns === undefined` after a rejection — the same three-way split
    // `TasksBoard` spells out, and the same one the canvas must not collapse.
    // A REJECTED read, not a hand-seeded `error` cell: the mount fetch runs, and a
    // resolving one would paint `[]` over the seeded `undefined` and turn this into the
    // empty case it is meant to distinguish itself from. The store writes whatever
    // `describeIpcError` makes of the rejection into `error`, so the assertion is about
    // WHICH sentence appears, not about the string that was injected.
    vi.mocked(getBoard).mockRejectedValue({
      kind: "db",
      message: "get_board failed",
    });
    act(() => {
      useSessions.setState({ activeSpacePath: SPACE });
    });
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByText(/has not loaded yet/)).toBeTruthy();
    expect(screen.queryByText(/no stages yet/)).toBeNull();
    // The error is the store's cell, rendered once.
    expect(screen.getByRole("alert").textContent).toContain("get_board failed");
  });
});

describe("WorkflowsCanvas — a node opens the existing editor", () => {
  it("clicking a node mounts StageEditor, and its Close returns to the canvas", async () => {
    // THE READ-ONLY DECISION, pinned. The canvas ships no panel and no second form; a
    // node click reaches the SAME dialog the board's `Configure` door reaches, so the
    // eight Stage fields keep one owner.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("workflow-node-backlog"));

    // The real dialog, with the real rows — not a canvas-local stand-in.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("stage-row-backlog")).toBeTruthy();
    expect(screen.getByTestId("stage-row-todo")).toBeTruthy();
    // And the canvas is still mounted behind it (the dialog is a portal, not a swap).
    expect(screen.getByTestId("workflows-canvas")).toBeTruthy();

    // Scoped with `within`: the canvas's own node text ("Done" is a column label too)
    // would otherwise collide with the dialog's controls, and a `getByRole` that throws
    // on multiple matches is a weaker pin than one that names its container.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("workflow-node-backlog")).toBeTruthy();
  });

  it("exposes each node as a native button carrying the column's whole state", async () => {
    // There is no keyboard route to a DRAG anywhere in this repo and this view adds
    // none — but the verb that matters (open the editor) must not need a pointer. The
    // node's body is a NATIVE `<button>`, so Enter and Space activate it through the
    // platform's own button semantics; the `ChecklistPanel` precedent (a non-native
    // control hand-spelling Enter + Space + `preventDefault`) is deliberately NOT
    // copied, because re-implementing a native button is how the guarantee rots.
    //
    // The pin is therefore the ROLE and the NAME, not a simulated keypress: jsdom
    // does not turn a key event into a click, so a `fireEvent.keyDown` here would be
    // asserting that jsdom implements button activation — a claim about jsdom, and one
    // it would fail. What IS testable, and what an assistive technology actually reads,
    // is that the control exists and says everything the picture says.
    seedBoardSlice([
      column("backlog", { auto: true, onEnterSkill: "specify", promptPrefix: "Read it." }, 3),
    ]);
    render(<WorkflowsCanvas />);
    await settled();
    const name = screen
      .getByRole("button", { name: /^Column Backlog/ })
      .getAttribute("aria-label")!;
    // Every fact the badges carry is in the name, in the order a person reads them —
    // otherwise the canvas is a picture with no text equivalent.
    expect(name).toContain("Auto-advance on");
    expect(name).toContain("Skill specify");
    expect(name).toContain("extra prompt");
    expect(name).toContain("3 cards");
    expect(name).toContain("Leads nowhere");
    // And the destinations, for a column that HAS one (the counts are swallowed by an
    // `aria-label`, which is why the sibling span in `ChecklistPanel` exists — here the
    // destinations are in the name instead).
    seedBoardSlice([column("backlog", { nextSlugs: ["doing"] }), column("doing")]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(
      screen
        .getAllByRole("button", { name: /^Column Backlog/ })
        .some((b) => b.getAttribute("aria-label")?.includes("Leads to Doing.")),
    ).toBe(true);
  });
});

describe("WorkflowsCanvas — the node box IS the box the layout was built on", () => {
  it("pins the node body to NODE_WIDTH × NODE_HEIGHT in its own inline style", async () => {
    // THE INVARIANT `workflowGraphLayout.ts` claims and did not have. dagre is told every
    // node occupies `NODE_WIDTH` × `NODE_HEIGHT`, and its rank separation is measured
    // between THOSE boxes — so a node that renders wider than 240 overlaps the next rank
    // and nothing in a browser-less test would notice. The layout file's own
    // `>= NODE_WIDTH` assertions CANNOT catch that: they compare two positions the same
    // constant produced, so they pin the constant and not the render.
    //
    // This one reads the element. It is not self-referential the way those are: the
    // assertion is about what the DOM carries, so restyling the box to `w-full` alone,
    // or changing `NODE_WIDTH` without carrying the box with it, reddens it.
    //
    // INLINE style and not `getComputedStyle`: jsdom implements no layout and no cascade
    // for stylesheet rules, so a computed width here reads `auto` whether or not a
    // Tailwind class exists. The inline declaration is the thing that survives that, and
    // it is the thing the node body must carry — xyflow's node wrapper is
    // `position: absolute` with no width of its own, so a `w-full` child resolves
    // against a shrink-to-fit parent and the label's `truncate` never engages.
    seedBoardSlice([
      column("backlog", { label: "A Stage Label Long Enough To Outgrow 240px" }),
      column("todo", { nextSlugs: [] }),
    ]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    // The STAGE node, on its body (the `<button>` the box classes are on).
    const body = container.querySelector<HTMLElement>(
      '[data-testid="workflow-node-backlog"] button',
    );
    expect(body, "the stage node's box").toBeTruthy();
    expect(body!.style.width, "the box must be NODE_WIDTH wide, not max-content").toBe(
      `${NODE_WIDTH}px`,
    );
    expect(body!.style.height).toBe(`${NODE_HEIGHT}px`);
    // The GHOST node too — it is fed to dagre with the same box, so it must hold the
    // same width or a stale destination's node overlaps the rank beside it.
    seedBoardSlice([column("doing", { nextSlugs: ["archived"] })]);
    const second = render(<WorkflowsCanvas />);
    await settled();
    const ghost = second.container.querySelector<HTMLElement>(
      '[data-testid="workflow-node-missing-archived"]',
    );
    expect(ghost, "the ghost node's box").toBeTruthy();
    expect(ghost!.style.width).toBe(`${NODE_WIDTH}px`);
    expect(ghost!.style.height).toBe(`${NODE_HEIGHT}px`);
  });
});

describe("WorkflowsCanvas — it is read-only", () => {
  it("gives its handles no connection affordance at all", async () => {
    // THE PIN THAT USED TO BE VACUOUS. This case asserted `.react-flow__connectionline`
    // was absent — but that element is rendered only while `connection.inProgress &&
    // nodesConnectable`, so it is missing from EVERY static render and the assertion
    // passed with `nodesConnectable={false}` deleted outright. That assertion is gone.
    //
    // What is actually checked first is the handle's OWN className, because each class is
    // one of `<Handle>`'s three connectability props rendered literally. Reading the
    // installed bundle: `connectable` is `isConnectable`; `connectablestart` IS
    // `isConnectableStart` — the same value that gates the pointer-down; `connectableend`
    // IS `isConnectableEnd`; and `connectionindicator` is
    // `isConnectable && (inProgress || clickConnecting ? isConnectableEnd :
    // isConnectableStart)`, which in a render with no connection in flight reduces to
    // `isConnectable && isConnectableStart`. All three props default to `true`
    // independently, and `nodesConnectable` reaches a custom node as the `isConnectable`
    // PROP and stops there; a node component that does not forward it ships handles
    // carrying all four classes on a canvas whose header calls its handles "anchor points
    // for the picture, not controls". Those classes are not cosmetic: the sheet that
    // `index.css` imports sets `.react-flow__handle { pointer-events: none }` and then
    // `.react-flow__handle.connectionindicator { pointer-events: all; cursor: crosshair }`
    // — so the unforwarded prop is what turns an anchor into a hit target. Measured on the
    // installed @xyflow/react@13.0.3: unforwarded, all four handles carry all four classes
    // WITH `nodesConnectable={false}` set on the canvas.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    const handles = [...container.querySelectorAll(".react-flow__handle")];
    // Two columns, two handles each. An assertion over an empty NodeList would pass on a
    // canvas that rendered nothing at all, so the population is pinned first.
    expect(handles).toHaveLength(4);
    for (const handle of handles) {
      const classes = handle.classList;
      expect(classes.contains("connectable"), handle.className).toBe(false);
      expect(classes.contains("connectablestart"), handle.className).toBe(false);
      expect(classes.contains("connectableend"), handle.className).toBe(false);
      expect(classes.contains("connectionindicator"), handle.className).toBe(false);
    }
    // Deliberately NOT asserted: a pointer-down on a handle "starting no connection".
    // Measured — with `nodesConnectable={false}` DELETED, a `fireEvent.mouseDown` on all
    // four handles still leaves `.react-flow__connectionline` absent, because
    // `XYHandle.onPointerDown` needs real pointer geometry and jsdom has none. Asserting
    // it would install a second assertion that cannot fail, which is the defect this case
    // exists to remove. The class names above are the honest pin: each one is one of the
    // three props rendered literally, and the same mutation reddens them.
    //
    // The attribution stays (MIT asks for it) — a licence decision is not this
    // component's to make. (The case used to ALSO assert the connection line was absent
    // with no gesture behind it; that half is deleted — see the header above.)
    expect(container.querySelector(".react-flow__attribution")).toBeTruthy();
  });

  it("makes a node exactly ONE tab stop", async () => {
    // `edgesFocusable={false}` was set and `nodesFocusable` was not, and xyflow's own
    // default is `true` — so every node wrapper rendered `tabIndex={0}`. A node that is a
    // wrapper in the tab order AND a `<button>` inside it costs TWO tab stops, and the
    // first one's Enter does not open the editor: xyflow routes the wrapper's keys to
    // *select*, so the key the header promises ("a native `<button>`, which activates on
    // Enter and Space") lands on a `role="group"` div that only highlights. One stop per
    // node, and it is the button's.
    seedBoardSlice([column("backlog"), column("todo"), column("doing", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    const wrappers = [...container.querySelectorAll(".react-flow__node")];
    expect(wrappers).toHaveLength(3);
    for (const wrapper of wrappers) {
      // The attribute is ABSENT and not `-1`. `-1` would leave the wrapper's own key
      // handler in place, which is the half that misroutes Enter; `nodesFocusable={false}`
      // is what drops both.
      expect(wrapper.getAttribute("tabindex"), wrapper.className).toBeNull();
    }
    // One stop each, not zero: everything tabbable in the canvas is a node's `<button>`,
    // plus the attribution link xyflow renders. Three columns therefore means FOUR —
    // before the fix it was seven (three wrappers, three buttons, one link).
    const tabbable = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="workflows-canvas"] button, ' +
          '[data-testid="workflows-canvas"] a[href], ' +
          '[data-testid="workflows-canvas"] [tabindex]:not([tabindex="-1"])',
      ),
    ];
    expect(tabbable.map((el) => el.tagName)).toEqual([
      "BUTTON",
      "BUTTON",
      "BUTTON",
      "A",
    ]);
  });

  it("offers no delete key", async () => {
    // The half of the old case that CAN fail: `deleteKeyCode={null}` is what stops a
    // keyboard Delete on a SELECTED node from removing a column — a write the canvas
    // cannot perform (the dialog owns the columns). xyflow's own default is `Backspace`
    // and the key listener it installs is live in jsdom, so the two arms differ.
    //
    // The node has to be SELECTED first, or this passes for the wrong reason: the key
    // only ever acts on selected nodes. A click selects it and also opens the dialog
    // (one gesture, one handler), so the dialog is closed again before the keys land —
    // and the selection stays, because it lives in xyflow's store and not in the dialog.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(document, { key: "Backspace", code: "Backspace" });
    fireEvent.keyDown(document, { key: "Delete", code: "Delete" });
    await settled();
    // The column is still drawn: nothing was removed.
    expect(screen.getByTestId("workflow-node-backlog")).toBeTruthy();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
  });
});

