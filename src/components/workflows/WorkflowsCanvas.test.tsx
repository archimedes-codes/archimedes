import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import WorkflowsCanvas from "./WorkflowsCanvas";
import { NODE_HEIGHT, NODE_WIDTH } from "./workflowGraphLayout";
import { useSessions } from "../../store/sessions";
import { useTasks } from "../../store/tasks";
import { resetStores } from "../../test/resetStores";
import { clearSkillCatalogCache } from "../../hooks/useSkillCatalog";
import { getAutoGuards, getBoard, getBoardStrict } from "../../lib/tauri";
import type { StageDto, StageWithTasks, TaskCardView } from "../../lib/tauri";

/**
 * The **Workflows** canvas — the graph view `App`'s `"workflows"` arm renders — as a
 * PICTURE: the nodes, the edges, the store it loads, the box a node must be.
 *
 * The EDITOR half (drag-to-connect, drag-to-position, the anti-snap-back round trip,
 * Tidy up) is `WorkflowsCanvas.editor.test.tsx`, split rather than stacked here for the
 * reason that file states. What stays here is what a static render can answer, plus the
 * two things a click on a node does.
 *
 * THE BARREL MOCK OVERRIDES THE WRAPPER NAMES (`getBoard`, not `get_board`) — the
 * store imports the wrappers, so mocking the Rust command names would leave the real
 * wrapper live and rejecting in jsdom. The Stage-verb set is mocked because every write
 * this view can make goes through `store/tasks` into one of them; an un-mocked one
 * reaches a real `invoke` and lands its sentence in the store's `error` cell that this
 * file's own assertions read.
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
  ready: false,
  readySessions: [],
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
 *  "This Space has no columns yet" until the mock was aligned with the seed. Seeding the
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

  it("draws the INFERRED edge dashed and the STORED edge solid, so the two are tellable", async () => {
    // THE RENDER HALF of the implicit-edge marker, and the reason the layout's own case is
    // not enough. `workflowGraphLayout.test.ts` proves the layout SETS `strokeDasharray`
    // and the class; only a render proves xyflow puts them on the element a person looks
    // at — the same division of labour as the node-box pin below, which exists because a
    // constant a stylesheet ignores is not an invariant.
    //
    // WHY IT MATTERS: the fallback wire and a saved wire used to be pixel-identical, and
    // they are two different Strict-mode contracts (ADR 0099: `NULL` permits any outgoing
    // move, `["x"]` permits only `x`; known-gaps §8: not reversible through the UI). The
    // cheapest defence is that a person can SEE which wires the graph inferred.
    seedBoardSlice([
      column("backlog", { nextSlugs: ["doing"] }),
      column("doing", { nextSlugs: null }),
      column("done", { nextSlugs: null }),
    ]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const read = (id: string): { dashed: string | null; grouped: boolean } => {
      const group = container.querySelector<SVGGraphicsElement>(
        `.react-flow__edge[data-id="${id}"]`,
      );
      expect(group, `the ${id} edge is drawn`).toBeTruthy();
      const path = group!.querySelector<SVGGraphicsElement>(".react-flow__edge-path")!;
      expect(path, `the ${id} edge paints a path`).toBeTruthy();
      return {
        // The inline style xyflow forwards to the path, read off the element.
        dashed: path.style.strokeDasharray || null,
        // And the class, on the wrapper AND on the path (xyflow puts `edge.className` on
        // both) — that pair is the hook `index.css` can theme without touching this file.
        grouped: group!.classList.contains("workflow-edge-implicit"),
      };
    };

    // `doing -> done` is the fallback (`doing.nextSlugs` is `null`): dashed and marked.
    expect(read("doing->done")).toEqual({
      dashed: "6 4",
      grouped: true,
    });
    // `backlog -> doing` is stored: solid and unmarked. Without this arm the case would be
    // satisfied by a canvas that dashed EVERY edge, which is the same blindness renamed.
    expect(read("backlog->doing")).toEqual({ dashed: null, grouped: false });
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

  it("says the Space has no columns when the loaded slice is empty", async () => {
    seedBoardSlice([]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.getByText(/no columns yet/)).toBeTruthy();
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
    expect(screen.queryByText(/no columns yet/)).toBeNull();
    // The error is the store's cell, rendered once.
    expect(screen.getByRole("alert").textContent).toContain("get_board failed");
  });
});

describe("WorkflowsCanvas — selection is the panel's subject", () => {
  it("starts in WORKFLOW mode, with no dialog and no node selected", async () => {
    // The panel beside the graph is the sole owner of the eight Stage fields; the
    // stage dialog this view used to mount on a node click is gone, so nothing
    // here may raise a dialog at all. Workflow mode is the resting state — the per-Space
    // settings, reached by the absence of a selection.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    expect(screen.queryByRole("dialog")).toBeNull();
    const panel = screen.getByTestId("workflow-settings-panel");
    expect(panel.getAttribute("aria-label")).toBe("Workflow settings");
    expect(within(panel).getByTestId("workflow-settings-body")).toBeTruthy();
    // No Close control in workflow mode: there is no selection to clear, and a button
    // that clears an already-empty selection is the dead control this repo refuses.
    expect(
      within(panel).queryByRole("button", { name: "Close settings" }),
    ).toBeNull();
  });

  it("clicking a node selects it and puts THAT column in the panel", async () => {
    // xyflow's selection and nothing else: the click lands on the node wrapper, which
    // marks the node selected and reports it through `onSelectionChange`, and the canvas
    // copies the slug into the panel's `stageSlug`. The canvas has no click handler of
    // its own to compete with that.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();

    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();

    const panel = screen.getByTestId("workflow-settings-panel");
    expect(panel.getAttribute("aria-label")).toBe("Settings for backlog");
    // The node body, mounted on the slug — the same fields the board's `Configure`
    // door navigates here to reach, and the only owner of them anywhere.
    expect(within(panel).getByTestId("stage-settings-backlog")).toBeTruthy();
    // And the Close control appears, because now it has a subject.
    expect(
      within(panel).getByRole("button", { name: "Close settings" }),
    ).toBeTruthy();
    // The canvas is still mounted beside it — the panel is a sibling, not a swap.
    expect(screen.getByTestId("workflow-node-backlog")).toBeTruthy();
  });

  it("Escape inside the viewport clears the selection (the keyboard's route back)", async () => {
    // THE GAP THIS CLOSES. Reaching node mode was already possible by keyboard — a Tab
    // lands on a node's `<button>` and Enter selects it — but leaving was a
    // pointer-only gesture, because the pane click that deselects is a mouse event and
    // the xyflow wrapper that owns Escape is not in the tab order (`nodesFocusable` is
    // off, on purpose). The panel's Close control was the one route and it is a control
    // you have to find; Escape is the gesture a keyboard user reaches for first.
    //
    // Escape clears the selection through the SAME `clearSelection` the Close control
    // calls — one owner of the gesture's effect, spelled on xyflow's own `selected`
    // flag. It does NOT touch the database: deselecting is a view change, and the write
    // that persists a column is the panel's, not the canvas's.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();
    expect(
      within(screen.getByTestId("workflow-settings-panel")).getByTestId(
        "stage-settings-backlog",
      ),
    ).toBeTruthy();

    // Fired on the NODE, because that is where the focus actually is: Tab reaches the
    // node's `<button>` and Enter selects it, so Escape has to work from there. It
    // bubbles to the viewport div, which owns the handler.
    fireEvent.keyDown(screen.getByTestId("workflow-node-backlog"), {
      key: "Escape",
    });
    await settled();

    // Workflow mode, by BOTH halves — the node body is gone and the per-Space body is
    // back. Asserting only the first would also be true of a canvas that unmounted.
    expect(
      within(screen.getByTestId("workflow-settings-panel")).queryByTestId(
        "stage-settings-backlog",
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId("workflow-settings-panel")).getByTestId(
        "workflow-settings-body",
      ),
    ).toBeTruthy();
    // The Close control is gone with it, because in workflow mode it has no subject —
    // the dead-control rule the header states, unchanged by this route.
    expect(
      within(screen.getByTestId("workflow-settings-panel")).queryByRole("button", {
        name: "Close settings",
      }),
    ).toBeNull();
  });

  it("Escape returns focus to the node that opened the panel", async () => {
    // THE FOCUS HALF of the keyboard route. Escape without this is a route that drops
    // the person on the floor: the panel unmounts and the element that held focus with
    // it, so `document.activeElement` falls back to `<body>` and the NEXT Tab starts at
    // the top of the document — the keyboard user loses their place in the graph at the
    // exact moment they asked to get back to the graph. Returning focus to the node's
    // own `<button>` is what makes Escape a ROUND TRIP: Tab to a node, Enter opens,
    // Escape lands back on that same node, and the next Tab continues from there.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();

    // The node's `<button>` and not the `workflow-node-*` div: the div is the SUBJECT
    // the test id names, the button is the thing in the tab order (`nodesFocusable` is
    // off, so the wrapper is not a stop). Re-focusing anything else would put focus on
    // an element that cannot be reached by Tab, which is the same as not restoring it.
    const nodeButton = screen
      .getByTestId("workflow-node-backlog")
      .querySelector("button");
    expect(nodeButton).toBeTruthy();

    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();
    expect(
      within(screen.getByTestId("workflow-settings-panel")).getByTestId(
        "stage-settings-backlog",
      ),
    ).toBeTruthy();

    // Focus is on the node — but on a DIFFERENT node than the one that owns the panel.
    // A person can Tab from the open panel back into the graph and land elsewhere, and
    // the gesture's subject is still `backlog`. Focusing a third element would also do,
    // but this is the state that makes the assertion non-vacuous WITHOUT smuggling in a
    // claim about `<body>`: the restore names the column that opened the panel, so it
    // cannot pass by leaving focus where it happened to be.
    act(() => {
      screen.getByTestId("workflow-node-todo").querySelector("button")!.focus();
    });
    expect(document.activeElement).not.toBe(nodeButton);

    fireEvent.keyDown(screen.getByTestId("workflow-node-todo"), {
      key: "Escape",
    });
    await settled();

    // The panel is gone (so this cannot pass because focus never moved), and focus is
    // back on the node that opened it.
    expect(
      within(screen.getByTestId("workflow-settings-panel")).queryByTestId(
        "stage-settings-backlog",
      ),
    ).toBeNull();
    expect(document.activeElement).toBe(nodeButton);
  });

  it("the panel's Close returns focus to the node too (one gesture, one destination)", async () => {
    // THE OTHER ROUTE, pinned separately on purpose. `Close` and Escape call the SAME
    // `clearSelection`, so a fix bolted to the Escape handler alone would leave the
    // pointer route dropping focus into `<body>` — and the pointer user who then presses
    // Tab is a keyboard user for that keystroke. Pinning both arms is what stops the fix
    // from being half of a gesture.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();

    const nodeButton = screen
      .getByTestId("workflow-node-backlog")
      .querySelector("button");
    const panel = screen.getByTestId("workflow-settings-panel");
    const close = within(panel).getByRole("button", { name: "Close settings" });

    // Focus sits INSIDE the panel — the panel's own control, which is about to unmount.
    // Without the restore, this is the case where focus does not merely fail to move, it
    // is destroyed.
    act(() => {
      close.focus();
    });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    await settled();

    expect(
      within(screen.getByTestId("workflow-settings-panel")).queryByTestId(
        "stage-settings-backlog",
      ),
    ).toBeNull();
    expect(document.activeElement).toBe(nodeButton);
  });

  it("Escape in a PANEL field does not clear the selection (the handler is scoped)", async () => {
    // The scoping is the load-bearing half. The viewport div owns the listener and the
    // panel is its SIBLING, so a key pressed in a panel field never reaches it — which
    // is what keeps Escape meaning what it means in the fields that already answer it
    // (the Skill `Select`'s popup, and every other Escape handler in the app). A
    // document-level listener would have closed the panel from inside a rename, which
    // is a discarded draft and a lost place in the form.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();

    const panel = screen.getByTestId("workflow-settings-panel");
    fireEvent.keyDown(within(panel).getByRole("textbox", { name: "Label for backlog" }), {
      key: "Escape",
    });
    await settled();

    // Still node mode. Escape inside the form changes nothing about the selection.
    expect(within(panel).getByTestId("stage-settings-backlog")).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: "Close settings" }),
    ).toBeTruthy();
  });

  it("Escape in workflow mode changes nothing (no selection, no-op, no crash)", async () => {
    // The resting state has no selection to clear, so the gesture must be a no-op
    // rather than a re-render that reads as a glitch or a throw. The viewport div is
    // focusable-adjacent (it holds the nodes), so a stray Escape lands here.
    seedBoardSlice([column("backlog"), column("todo")]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    const viewport = screen.getByTestId("workflows-canvas-viewport");

    expect(() => {
      fireEvent.keyDown(viewport, { key: "Escape" });
    }).not.toThrow();
    await settled();

    expect(
      within(screen.getByTestId("workflow-settings-panel")).getByTestId(
        "workflow-settings-body",
      ),
    ).toBeTruthy();
    // And the graph itself is untouched — Escape deselects, it does not delete. That is
    // the same reason `deleteKeyCode` is null: the canvas owns no destructive verb.
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
  });

  it("the panel's Close clears the selection and returns to workflow mode", async () => {
    // The one gesture Close can perform, and the keyboard user's only route back to the
    // per-Space settings from a node.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();
    const panel = screen.getByTestId("workflow-settings-panel");
    expect(within(panel).getByTestId("stage-settings-backlog")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Close settings" }));
    await settled();

    expect(
      screen.getByTestId("workflow-settings-panel").getAttribute("aria-label"),
    ).toBe("Workflow settings");
    expect(within(screen.getByTestId("workflow-settings-panel")).getByTestId("workflow-settings-body")).toBeTruthy();
  });

  it("selecting a GHOST node names the slug it cannot resolve instead of changing subject", async () => {
    // The panel's third arm, reached for real: a ghost's id is a slug the slice cannot
    // answer, and falling back to workflow mode there is how "I clicked the node and got
    // the Space's settings" happens.
    seedBoardSlice([column("doing", { nextSlugs: ["archived"] })]);
    render(<WorkflowsCanvas />);
    await settled();

    fireEvent.click(screen.getByTestId("workflow-node-missing-archived"));
    await settled();

    const panel = screen.getByTestId("workflow-settings-panel");
    expect(within(panel).getByTestId("selection-unresolved")).toBeTruthy();
    expect(within(panel).queryByTestId("workflow-settings-body")).toBeNull();
  });

  it("keeps the selection alive across a board write, so a keystroke is not a deselect", async () => {
    // The re-derivation effect rebuilds the node array on every slice change. Rebuilt
    // WITHOUT carrying `selected`, the write a panel field makes would deselect the node
    // the person is typing about and swap the panel to the Space's settings underneath
    // them — a form that closes itself on the first commit.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();
    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();
    expect(
      screen.getByTestId("workflow-settings-panel").getAttribute("aria-label"),
    ).toBe("Settings for backlog");

    // A write of the kind the panel makes: the store paints a new slice, the layout
    // re-derives, the effect hands xyflow a fresh array.
    act(() => {
      useTasks.setState((state) => ({
        boardsBySpace: {
          ...state.boardsBySpace,
          [SPACE]: state.boardsBySpace[SPACE]!.map((c) =>
            c.stage.slug === "backlog"
              ? { ...c, stage: { ...c.stage, label: "In progress" } }
              : c,
          ),
        },
      }));
    });
    await settled();

    expect(
      screen.getByTestId("workflow-settings-panel").getAttribute("aria-label"),
    ).toBe("Settings for backlog");
    // And the panel shows the RENAME, so it is the same live selection and not a stale one.
    expect(screen.getByTestId("workflow-node-backlog").textContent).toContain(
      "In progress",
    );
  });

  it("exposes each node as a native button carrying the column's whole state", async () => {
    // The verb that matters (select a node, which is how its settings are reached) must
    // not need a pointer. The node's body is a NATIVE `<button>`, so Enter and Space
    // activate it through the platform's own button semantics and the click bubbles to
    // xyflow's wrapper, which selects; the `ChecklistPanel` precedent (a non-native
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

describe("WorkflowsCanvas — the picture's own affordances", () => {
  it("makes every handle a LIVE connection control", async () => {
    // THE MIRROR OF THE PIN THIS CASE USED TO BE. When the canvas was read-only this
    // asserted the four connectability classes were ABSENT; drag-to-connect is now a
    // feature, so it asserts they are PRESENT — and it is the same instrument, which is
    // what makes it worth keeping rather than deleting. Each class is one of `<Handle>`'s
    // three props rendered literally: `connectable` is `isConnectable`, `connectablestart`
    // IS `isConnectableStart` (the value that gates the pointer-down), `connectableend` IS
    // `isConnectableEnd`, and `connectionindicator` reduces, with no connection in
    // flight, to `isConnectable && isConnectableStart`. All three default to `true`
    // independently, so a node component that ignores the prop would keep this case green
    // while a canvas with `nodesConnectable` OFF also kept it green — the failure
    // `WorkflowNodes.tsx` documents. What pins it here is that the canvas flag is on AND
    // the classes are read: turn `nodesConnectable` off without forwarding, or forward
    // only one of the three, and the strings below stop matching. They are not cosmetic
    // either: the sheet `index.css` imports gives `.react-flow__handle`
    // `pointer-events: none` and `.react-flow__handle.connectionindicator`
    // `pointer-events: all; cursor: crosshair`, so these classes ARE the hit target.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    const handles = [...container.querySelectorAll(".react-flow__handle")];
    // Two columns, two handles each. An assertion over an empty NodeList would pass on a
    // canvas that rendered nothing at all, so the population is pinned first.
    expect(handles).toHaveLength(4);
    for (const handle of handles) {
      const classes = handle.classList;
      expect(classes.contains("connectable"), handle.className).toBe(true);
      expect(classes.contains("connectablestart"), handle.className).toBe(true);
      expect(classes.contains("connectableend"), handle.className).toBe(true);
      expect(classes.contains("connectionindicator"), handle.className).toBe(true);
    }
    // The GHOST node's target handle is connectable too, and that is deliberate: the
    // canvas refuses a connection to it via `isValidConnection` (pinned in
    // `WorkflowsCanvas.editor.test.tsx`) rather than by hiding the affordance, because a
    // handle that is invisible gives no signal about why the drop did nothing.
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(4);
    // The attribution stays (MIT asks for it) — a licence decision is not this
    // component's to make.
    expect(container.querySelector(".react-flow__attribution")).toBeTruthy();
  });

  it("makes a node exactly ONE tab stop", async () => {
    // `edgesFocusable={false}` was set and `nodesFocusable` was not, and xyflow's own
    // default is `true` — so every node wrapper rendered `tabIndex={0}`. A node that is a
    // wrapper in the tab order AND a `<button>` inside it costs TWO tab stops, and both
    // do the same thing: xyflow routes the wrapper's keys to *select*, which is what the
    // button's click already did. One stop per node, and it is the button's — which is
    // also the stop that opens the node's settings, because selecting IS opening here.
    //
    // SCOPED TO THE VIEWPORT and not to the whole island, and that is not a dodge: the
    // claim under test is "a NODE costs one stop", so the query is about nodes. (The
    // settings panel used to sit inside the canvas island and the comment said so; it is
    // a sibling island now, which only strengthens the scoping.) What the viewport DOES
    // hold besides the nodes is the canvas's own chrome — **Tidy up** and the attribution
    // link — and both are counted below rather than filtered out, so the list is the
    // viewport's whole tab order and not a curated subset of it.
    seedBoardSlice([column("backlog"), column("todo"), column("doing", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    const wrappers = [...container.querySelectorAll(".react-flow__node")];
    expect(wrappers).toHaveLength(3);
    for (const wrapper of wrappers) {
      // The attribute is ABSENT and not `-1`. `-1` would leave the wrapper's own key
      // handler in place — the half that would let arrow keys nudge a node without ever
      // calling `onNodeDragStop`, i.e. a move that cannot persist. `nodesFocusable={false}`
      // is what drops both the stop and that handler.
      expect(wrapper.getAttribute("tabindex"), wrapper.className).toBeNull();
    }
    const viewport = container.querySelector<HTMLElement>(
      "[data-testid=\"workflows-canvas-viewport\"]",
    )!;
    const tabbable = [
      ...viewport.querySelectorAll<HTMLElement>(
        "button, a[href], [tabindex]:not([tabindex=\"-1\"])",
      ),
    ];
    // One stop per node, not zero: everything tabbable inside the picture is a node's
    // `<button>`, plus the two pieces of canvas chrome — Tidy up (a control, so it owes
    // a stop) and the attribution link xyflow renders. Three columns therefore means
    // FIVE — before the one-stop fix it was eight (three wrappers, three buttons, one
    // control, one link).
    expect(tabbable.map((el) => el.tagName)).toEqual([
      "BUTTON",
      "BUTTON",
      "BUTTON",
      "BUTTON",
      "A",
    ]);
    expect(tabbable[3].getAttribute("aria-label")).toBe("Tidy up");
  });

  it("offers no delete key", async () => {
    // The half of the old case that CAN fail: `deleteKeyCode={null}` is what stops a
    // keyboard Delete on a SELECTED node from removing a column — a write with a
    // card-relocation step the picture cannot show, which the panel's own picker owns.
    // xyflow's own default is `Backspace` and the key listener it installs is live in
    // jsdom, so the two arms differ.
    //
    // The node has to be SELECTED first, or this passes for the wrong reason: the key
    // only ever acts on selected nodes. A click selects it and nothing else (no dialog to
    // close on the way), which is the cheaper fixture the panel made possible.
    seedBoardSlice([column("backlog"), column("todo", { nextSlugs: [] })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();
    fireEvent.click(screen.getByTestId("workflow-node-backlog"));
    await settled();
    expect(
      screen.getByTestId("workflow-settings-panel").getAttribute("aria-label"),
    ).toBe("Settings for backlog");

    fireEvent.keyDown(document, { key: "Backspace", code: "Backspace" });
    fireEvent.keyDown(document, { key: "Delete", code: "Delete" });
    await settled();
    // The column is still drawn: nothing was removed.
    expect(screen.getByTestId("workflow-node-backlog")).toBeTruthy();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
  });
});

describe("WorkflowsCanvas — two sibling islands, one themed plane (ADR 0097)", () => {
  it("renders the canvas and the panel as SIBLINGS, each wearing the island recipe", async () => {
    // DOM, not a class-name grep: the defect ADR 0097 names is a pane NESTED inside an
    // island, and a nested element carries the same classes as a sibling one. So the
    // assertion is the PARENT — `contains` in both directions is what says the panel is
    // not inside the canvas box, and the shared parent is what says they are siblings.
    seedBoardSlice([column("backlog"), column("todo")]);
    render(<WorkflowsCanvas />);
    await settled();

    const canvas = screen.getByTestId("workflows-canvas");
    const panel = screen.getByTestId("workflow-settings-panel");

    // Two islands, neither inside the other, one shared parent (the content row).
    expect(canvas.contains(panel)).toBe(false);
    expect(panel.contains(canvas)).toBe(false);
    expect(panel.parentElement).toBe(canvas.parentElement);
    expect(canvas.parentElement).not.toBeNull();
    expect(canvas.parentElement!.children).toHaveLength(2);

    // BOTH wear ADR 0097's recipe. `m-1` is the 4px frame gap and `rounded-xl` the
    // island's corner; without one of them the surface is flat next to its neighbour.
    for (const island of [canvas, panel]) {
      expect(island.classList.contains("m-1"), island.className).toBe(true);
      expect(island.classList.contains("rounded-xl"), island.className).toBe(true);
      expect(island.classList.contains("overflow-hidden"), island.className).toBe(true);
    }

    // The canvas keeps the transcript plane and the panel the right-hand pane's own
    // token. SAME COLOUR today in all 14 palette readings — measured: every Palette
    // declares `--color-inspector` either as `var(--color-chat)` or as a literal equal
    // to its own `--color-chat` (Dracula and catppuccin spell the literal) — so this is
    // not a colour change. It is the token that names what the surface IS, and it is the
    // one a palette separates first when it ever gives the two panes different values.
    expect(canvas.classList.contains("bg-chat")).toBe(true);
    expect(panel.classList.contains("bg-inspector")).toBe(true);
    // The divider went with the nesting: a line between two surfaces that no longer
    // touch describes a seam that no longer exists.
    expect(panel.className).not.toMatch(/border-l/);
  });

  it("paints the graph plane and its chrome from palette tokens, not xyflow's defaults", async () => {
    // xyflow's sheet ships in `@layer xyflow`, which the compiled stylesheet emits AFTER
    // `@layer utilities`, so a class of the app's own loses to it at equal specificity.
    // What does NOT lose is the custom property its own rules read
    // (`var(--xy-*, var(--xy-*-default))`), so the theme is written as those properties.
    // jsdom cannot resolve a stylesheet, so this asserts the properties the wrapper sets
    // and that every one of them is a palette `var()` — the hex-free claim is the one
    // that keeps the graph following the palette.
    seedBoardSlice([column("backlog"), column("todo")]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    const themed = container.querySelector<HTMLElement>(
      "[data-testid=\"workflows-canvas-viewport\"] > .react-flow",
    )!;
    expect(themed, "<ReactFlow> renders no wrapper to theme").toBeTruthy();

    const set = [...themed.classList].filter((c) => c.startsWith("[--xy-"));
    // The surfaces the graph paints: the plane, the stored wire, the selected wire, the
    // wire being dragged, the handle pair and the attribution's plate. Asserted BY NAME,
    // so a dropped utility is a red and not a shorter list nobody compared.
    expect(set.map((c) => c.match(/^\[--xy-[a-z-]+/)?.[0]).sort()).toEqual([
      "[--xy-attribution-background-color",
      "[--xy-background-color",
      "[--xy-connectionline-stroke",
      "[--xy-edge-stroke",
      "[--xy-edge-stroke-selected",
      "[--xy-handle-background-color",
      "[--xy-handle-border-color",
    ]);
    for (const utility of set) {
      expect(utility, `${utility} is not palette-relative`).toContain("var(--color-");
    }
    // THE GRAPH PLANE IS THE ISLAND'S OWN PLANE. Asserted BY NAME because the two
    // alternatives are both real, both were tried, and both must be refused: xyflow's own
    // near-black default (the original defect), and `--color-panel`, which looks like the
    // right recessed rung and is WRONG — it is byte-identical to `--color-frame` in 6 of
    // the 13 readings (Dracula, both Ayu, both Kanagawa, Catppuccin dark), and ADR 0097
    // reserves `bg-frame` for CHROME. A `panel` plane makes the view read as background
    // instead of surface AND dissolves the gutter between the island and the Session list,
    // because both become the same fill. A node's separation is carried by its
    // `border-card-border` instead, which is what ADR 0096 prescribes for a collapsed step.
    expect(themed.classList).toContain(
      "[--xy-background-color:var(--color-chat)]",
    );
    // The INFERRED wire must stay a different mark from a stored one ON THE THAMED
    // PLANE: the wrapper paints every wire at `trace-strong` and the implicit class
    // re-declares the property at the weaker `trace` on the marked edge, so the two are
    // two greys rather than one. Renaming `IMPLICIT_EDGE_CLASS` without this breaks it.
    expect(themed.classList).toContain(
      "[--xy-edge-stroke:var(--color-workflow-trace-strong)]",
    );
    expect(themed.classList).toContain(
      "[&_.workflow-edge-implicit]:[--xy-edge-stroke:var(--color-workflow-trace)]",
    );
    // The attribution stays (MIT asks for the credit) and its LINK is themed, because
    // xyflow hardcodes `#999` for it and that rule compiles after the app's utilities —
    // hence the `!` on the utility, which is asserted here so the theme cannot quietly
    // become a no-op.
    expect(container.querySelector(".react-flow__attribution a")).toBeTruthy();
    expect(themed.className).toMatch(
      /\[&_\.react-flow\\_\\_attribution_a\]:text-foreground-subtlest!/,
    );
    // And no theme value is a raw hex: the whole point is that the graph follows the
    // palette the person picked.
    expect(
      [...themed.classList].filter((c) => c.startsWith("[--xy-")).filter((c) => /#[0-9a-f]/i.test(c)),
    ).toEqual([]);
  });

  it("floats Tidy up on the canvas and carries no header at all", async () => {
    // The header's only payload was this button, and the sidebar door already names the
    // view. The button now sits IN the viewport, bottom-left, where the picture's other
    // controls live.
    seedBoardSlice([column("backlog", { positionX: 10, positionY: 20 })]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // The canvas island itself carries no bar at all. Scoped, because the settings panel
    // has its OWN `<header>` (the subject line) and that one is not going anywhere.
    expect(
      screen.getByTestId("workflows-canvas").querySelector("header"),
    ).toBeNull();

    const tidy = screen.getByRole("button", { name: "Tidy up" });
    // Inside the canvas island AND inside the xyflow surface — a floating control is
    // positioned by the picture it controls, not by a bar above it.
    expect(screen.getByTestId("workflows-canvas").contains(tidy)).toBe(true);
    const panelHost = tidy.closest(".react-flow__panel");
    expect(panelHost, "Tidy up is not a canvas control (no xyflow panel)").toBeTruthy();
    expect(panelHost!.classList.contains("bottom")).toBe(true);
    expect(panelHost!.classList.contains("left")).toBe(true);
    // And OUTSIDE `.react-flow__viewport`, the TRANSFORM surface. This is the load-bearing
    // half of "floating": a control inside the viewport inherits the pan/zoom transform
    // and drifts off its corner on the first scroll — the same reason the settings panel
    // is never mounted in there.
    expect(tidy.closest(".react-flow__viewport")).toBeNull();
    // The surface + edge + subtle-foreground-with-hover recipe of a canvas control.
    expect(tidy.classList.contains("bg-chat")).toBe(true);
    expect(tidy.classList.contains("border-card-border")).toBe(true);
    expect(tidy.className).toMatch(/hover:bg-surface-hover/);
    // The icon leads and the label is the accessible name, so the button stays one node.
    expect(container.querySelector("[aria-label=\"Tidy up\"] svg")).toBeTruthy();
  });

  it("still shows the store's error line when no Space is mounted to show it", async () => {
    // The panel owns the error cell wherever it is mounted, and it is NOT mounted here.
    // Losing this line turns a failed write into a silent nothing — the failure both
    // files' headers have argued about since they were written, and the one thing the
    // header's removal could have dropped with it.
    act(() => {
      useTasks.setState({ error: "get_board failed" });
    });
    render(<WorkflowsCanvas />);
    await settled();

    expect(screen.queryByTestId("workflow-settings-panel")).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("get_board failed");
    // And it is inside the island that survives a Spaceless render, not orphaned.
    expect(screen.getByTestId("workflows-canvas").contains(alert)).toBe(true);
  });

  it("draws a node as a CARD separated by its seam, with legible ink", async () => {
    // A node sits on the island plane, where `bg-card` is only a 1.21 step in Dracula and
    // exactly 1.00 in Catppuccin light and Everforest dark. ADR 0096 says a collapsed step
    // is not fixed in the palette — the fix is the border that is already there. So the
    // separation is the SEAM, and the plane stays the island's own.
    //
    // Three tokens, one finding each, and none of them visible to a palette gate —
    // `paletteCompleteness.test.ts` grades `--color-card` in the `raised` surface set for
    // four DARK readings and one light one, and the default palette names both faint text
    // tokens `textUngradeable`, so the app's faintest ink on its lightest plane is exactly
    // the pair no existing assertion reads. Pinned here as CLASS LITERALS because the
    // failure mode is a silent revert to the louder/darker default, not a crash.
    seedBoardSlice([
      column("doing", { auto: true, onEnterSkill: "specify" }, 2),
      column("done", { nextSlugs: [] }),
    ]);
    const { container } = render(<WorkflowsCanvas />);
    await settled();

    // The test id is on the node's WRAPPER on purpose (its comment: it names the subject,
    // not the widget), and the `<button>` is the element that wears the card's classes.
    const node = screen.getByTestId("workflow-node-doing");
    const box = within(node).getByRole("button");
    // THE SEAM IS THE CARD TOKEN. `border-border` is the app-wide divider (inputs,
    // popovers, tabs) and ADR 0096's issue-#173 amendment reserves `card-border` for a
    // card's resting seam precisely so a card does not wear the loud rule: on Dracula the
    // two measure 2.51 and 1.34 against this surface, and in three light readings the loud
    // one OUTLINES at 3.5–4.2 over a fill step near 1.1 — outline dominating elevation.
    expect(box.className).toContain("border-card-border");
    expect(box.className).not.toMatch(/(^|\s)border-border(\s|$)/);
    expect(box.className).toContain("bg-card");

    // A BADGE IS A TINTED STATE, so the hue goes on the border and the wash and the WORDS
    // keep readable ink — the split `SessionStalledBanner` ships (`border-warning
    // bg-warning/10` over normal text) and `docs/css-theme-tokens.md` states. `text-warning`
    // as 12px text is the worst token in five of six light readings (2.12 Everforest light)
    // and is the live defect the board's own card T20 records.
    const auto = screen.getByTestId("workflow-node-auto-doing");
    expect(auto.className).toContain("bg-warning/10");
    expect(auto.className).toContain("text-foreground");
    expect(auto.className).not.toMatch(/(^|\s)text-warning(\s|$)/);

    // The count is a QUANTITY, not de-emphasised prose, so it is not the faintest ink in
    // the app: `subtlest` on `card` is 2.38 default-light / 2.18 default-dark.
    const count = within(node).getByText("2");
    expect(count.className).toContain("text-foreground-subtle");
    expect(count.className).not.toContain("text-foreground-subtlest");

    // And the plane behind it is the ISLAND, not the chrome colour. Restated here because
    // this is the pairing a future "improve the contrast" change will be tempted to flip to
    // `--color-panel`, which is the same token as `--color-frame` in half the palettes.
    const plane = container.querySelector<HTMLElement>(
      "[data-testid=\"workflows-canvas-viewport\"] > .react-flow",
    )!;
    expect(plane.classList).toContain("[--xy-background-color:var(--color-chat)]");
    expect(plane.className).not.toContain("--color-panel");
  });
});
