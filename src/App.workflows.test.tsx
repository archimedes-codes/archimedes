import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import App from "./App";
import { getBoard, listSessions, listSpaces, sessionRecency } from "./lib/tauri";
import { useSessions } from "./store/sessions";
import { useTasks } from "./store/tasks";
import { resetStores } from "./test/resetStores";
import { setNewSpaceDialogOpen } from "./lib/newSpaceDialogState";
import { setAttentionFocusRequest } from "./lib/attentionFocusSignal";
import type { StageDto, StageWithTasks, TaskCardView } from "./lib/tauri";

/**
 * `App`'s **fourth view arm** — the `"workflows"` arm of the view ternary.
 *
 * ## WHY THIS FILE EXISTS RATHER THAN MORE CASES IN `App.test.tsx`
 *
 * `App.test.tsx` is BASELINED at its exact code-line count in
 * `scripts/file-size-baseline-test.txt` and the size ratchet refuses a baselined file
 * growing by even one code line. The case below cannot be expressed inside that budget,
 * so it lives beside the file it extends — the route `tasks.workflows.test.tsx` and
 * `StageEditor.workflows.test.tsx` took, and for the same stated reason. The claim it
 * pins is `App`'s ROUTING and not the canvas's rendering (which
 * `workflows/WorkflowsCanvas.test.tsx` owns), so it belongs at the `App` tree.
 *
 * ## THE DEFECT THIS CASE EXISTS FOR — the silent else
 *
 * `App`'s ternary falls through to the WORKSPACE. A view union widened without a fourth
 * arm is `tsc`-clean, leaves every pre-existing test green, and paints the chat column
 * and the Side pane where the canvas should be. The plan records this as measured, and
 * `App.test.tsx`'s board case is the template: the pin has to assert BOTH halves — the
 * canvas IS on screen and `ChatStream` is NOT — because "the canvas is missing" alone
 * would also be true of a case that never reached the view at all.
 *
 * ## THE BOOT MOCK IS THE TRAP IN THIS FILE'S SHAPE
 *
 * The factory spreads `importActual`, so a boot fetch NOT listed below resolves to the
 * real wrapper, which calls `invoke`, which rejects in jsdom; the boot `Promise.all`
 * then rejects, its `.catch` swallows the reason, and every case here goes red looking
 * unrelated. `App.test.tsx`'s header carries the full warning; the list below is that
 * file's list, narrowed to what this view touches, plus the Stage verbs (a node click
 * mounts the real `StageEditor`, whose footer reads the guard pair).
 */
vi.mock("./lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./lib/tauri");
  const ok = <T,>(value: T) => vi.fn().mockResolvedValue(value);
  return {
    ...actual,
    // The boot trio + the badge read. All four are required by the `importActual`
    // spread, not by this view's own rendering.
    listSessions: ok([]),
    listSpaces: ok([]),
    sessionRecency: ok([]),
    taskNumbers: ok([]),
    // The catalogs the permanent pane and the chat composer fetch on mount.
    listSkills: ok([]),
    listAgentDefinitionsForSpace: ok([]),
    listAgentDefinitionReports: ok([]),
    listMcpServersEffective: ok([]),
    listSpaceListing: ok({ entries: [], truncated: false }),
    listCompletionEntries: ok({ entries: [], truncated: false }),
    listModels: ok([]),
    listTools: ok([]),
    getSettings: ok({}),
    saveSettings: ok(undefined),
    startSession: ok({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: {},
      archived: false,
    }),
    loadHistory: ok({ rows: [], hasMore: false, todos: null }),
    // The canvas (and the board, which the round-trip case visits) read the board on
    // MOUNT, so `getBoard` must be mocked or the store's `load` rejects in jsdom.
    getBoard: ok([]),
    getBoardStrict: ok(false),
    setBoardStrict: ok(false),
    getAutoGuards: ok({ maxSteps: null, ceilingUsd: null }),
    setAutoGuards: ok({ maxSteps: null, ceilingUsd: null }),
    createStage: ok([]),
    renameStage: ok([]),
    setStageSkill: ok([]),
    setStageNext: ok([]),
    setStageAuto: ok([]),
    setStagePromptPrefix: ok([]),
    reorderStages: ok([]),
    deleteStage: ok([]),
    writeArtifact: ok([]),
    getArtifact: ok(null),
    createTask: ok({}),
    getTask: ok(null),
    editTask: ok({}),
    moveTask: ok({ onEnter: "none", boostNote: null }),
    reorderTasks: ok(undefined),
    linkSession: ok(undefined),
    startTaskSession: ok({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: {},
      archived: false,
    }),
    sendPrompt: ok("end_turn"),
    setSessionConfigOption: ok([]),
    readClipboardImage: ok(null),
    readFileBytes: ok(null),
    // Every `listen*` registration resolves a no-op unlisten, and the two attention
    // commands answer — un-mocked, either reaches a real `invoke` in jsdom.
    listenSessionUpdate: ok(() => {}),
    listenSessionClosed: ok(() => {}),
    listenSessionStalled: ok(() => {}),
    listenSessionTitled: ok(() => {}),
    listenPermissionRequest: ok(() => {}),
    listenInteractiveRequest: ok(() => {}),
    listenInteractiveRequestClose: ok(() => {}),
    listenInteractiveEvent: ok(() => {}),
    listenSubagentSessionStarted: ok(() => {}),
    listenSubagentClosed: ok(() => {}),
    listenAttentionAlertClicked: ok(() => {}),
    raiseAttentionWindow: ok(undefined),
    listenWindowState: ok(() => {}),
    attentionArm: ok(undefined),
    attentionDisarm: ok(undefined),
    externalOpen: ok(undefined),
    getWindowState: ok({
      isTiled: false,
      isMaximized: false,
      isFullscreen: false,
      native: false,
    }),
  };
});

// `App` renders `WindowControls`, which calls `getCurrentWindow()` on every render; in
// jsdom `window.__TAURI_INTERNALS__` is undefined and the render throws without this.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    isFullscreen: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
    onMoved: vi.fn().mockResolvedValue(() => {}),
    outerPosition: { get: vi.fn().mockResolvedValue({ x: 0, y: 0 }) },
    outerSize: { get: vi.fn().mockResolvedValue({ width: 800, height: 600 }) },
  }),
  currentMonitor: vi.fn().mockResolvedValue(null),
}));

// The canvas's own environment stubs, file-local on the
// `components/chat/EmptyStateFilm.test.tsx` precedent — see
// `workflows/WorkflowsCanvas.test.tsx`'s header for what each one is for and what
// happens without it. `src/test/setup.tsx` deliberately installs none of them.
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

const SPACE = "/tmp/ws";

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

const column = (slug: string, sortOrder: number): StageWithTasks => ({
  stage: stage(slug, { sortOrder }),
  tasks: [] satisfies TaskCardView[],
});

/** Render, let the boot trio land, then give the app an ACTIVE Space.
 *
 *  The same seed `App.test.tsx`'s board helper spells out, and for the same reason:
 *  this file's boot mocks resolve `[]`, so a bare render leaves NO Space selected —
 *  and the Selected Space is what decides whether the canvas fetches at all.
 *
 *  The `getBoard` arm is armed BEFORE the render so the canvas's mount fetch finds a
 *  real column set; a `[]` reply would leave the canvas on its "no stages yet" line and
 *  the case below would then be asserting the empty state rather than the graph. */
async function bootedWithSelectedSpace(): Promise<void> {
  vi.mocked(getBoard).mockResolvedValue([
    column("backlog", 0),
    column("doing", 1),
  ]);
  render(<App />);
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    useSessions.setState({
      sessions: [
        {
          sessionId: "s1",
          cwd: SPACE,
          capabilities: {},
          archived: false,
        },
      ],
      spaces: [
        { path: SPACE, createdAt: 1, lastOpenedAt: 1, trusted: false },
      ],
      activeSessionId: "s1",
      activeSpacePath: SPACE,
    });
  });
}

/** Click the Workflows door and let the canvas become drawable.
 *
 *  The wait is not decoration and it is not the same wait as the boot one: the canvas
 *  mounts ONLY once the arm is selected, so its `get_board` fetch and — more
 *  importantly — xyflow's DEFERRED node measurement both happen after the click. A
 *  node xyflow has not measured is in the DOM but `visibility: hidden`, and an edge
 *  whose endpoints have no handle bounds is not in the DOM at all, so the node and edge
 *  assertions below sit behind this. */
async function openWorkflows(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  // `useTasks` and `useSessions` are module-global singletons, so a board left behind
  // by the case that opened it survives into the next — the documented flakiness source
  // `src/test/resetStores.ts` exists to end. The store's own `reset()` is the only thing
  // that reaches its module-scope load epoch.
  resetStores();
  useTasks.getState().reset();
  setNewSpaceDialogOpen(false);
  setAttentionFocusRequest(null);
  vi.mocked(listSessions).mockResolvedValue([]);
  vi.mocked(listSpaces).mockResolvedValue([]);
  vi.mocked(sessionRecency).mockResolvedValue([]);
  vi.mocked(getBoard).mockClear();
  vi.mocked(getBoard).mockResolvedValue([]);
});

describe("App (the Workflows view)", () => {
  it("the Workflows door paints the CANVAS and not the chat column (the explicit arm, not the else)", async () => {
    await bootedWithSelectedSpace();
    // The workspace is up first: the permanent pane, and `ChatStream`'s composer.
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.queryByTestId("workflows-canvas")).toBeNull();
    expect(screen.getByTestId("composer-island")).toBeTruthy();

    await openWorkflows();

    // THE PIN THE WIDENING EXISTS FOR. A widened union with NO fourth arm renders the
    // workspace for `"workflows"` too — the ternary's else-branch IS the workspace — so
    // the canvas would be absent, the composer still present, `tsc` clean, and every
    // pre-existing test in the repo green. BOTH halves are asserted because the canvas
    // being absent is also what a click that never changed the view looks like.
    expect(screen.getByTestId("workflows-canvas")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Workflows", level: 1 }),
    ).toBeTruthy();
    expect(screen.queryByTestId("composer-island")).toBeNull();

    // And it is the GRAPH, not an empty frame: the two columns the Space's board
    // reports are on the canvas, joined by the fallback edge.
    expect(screen.getByTestId("workflow-node-backlog")).toBeTruthy();
    expect(screen.getByTestId("workflow-node-doing")).toBeTruthy();
    expect(
      document.querySelector('[data-testid="rf__edge-backlog->doing"]'),
    ).toBeTruthy();
  });

  it("the Workflows canvas loads its own board, for the Selected Space", async () => {
    // `App` hands the view NO Space prop (issue #185's argument, spelled at the board's
    // render site): the view reads the Selected Space and fetches for it. This is the
    // wiring an only-canvas-side test cannot see — the board it fetches for is decided
    // by what `App`'s store holds at the moment the arm mounts.
    await bootedWithSelectedSpace();
    // Not fetched on boot — the arm mounts on the click, and the fetch is that arm's
    // mount effect. Asserting it BEFORE the click would be asserting the canvas is
    // mounted always, which is the thing the fourth arm is NOT.
    expect(getBoard).not.toHaveBeenCalled();
    await openWorkflows();
    expect(getBoard).toHaveBeenCalledTimes(1);
    expect(getBoard).toHaveBeenCalledWith(SPACE);
  });

  it("the three view doors carry aria-pressed, and the Skills / Agents modal buttons still do not", async () => {
    // N2 with a third door: the doors that NAME a view say which one is showing; the
    // two that raise a MODAL carry no `aria-pressed` at all, because a modal is not a
    // location. Asserted for all five so a future editor who adds the attribute to a
    // modal button reddens this rather than shipping the ambiguity.
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    const pressed = (name: string): string | null =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");

    // The workspace: no view door is pressed, and neither modal button carries it.
    expect(pressed("Settings")).toBe("false");
    expect(pressed("Tasks")).toBe("false");
    expect(pressed("Workflows")).toBe("false");
    expect(pressed("Skills")).toBeNull();
    expect(pressed("Agents")).toBeNull();

    // Workflows up: exactly one door is pressed, and its peers stay unpressed.
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(pressed("Workflows")).toBe("true");
    expect(pressed("Tasks")).toBe("false");
    expect(pressed("Settings")).toBe("false");

    // The pressed door toggles its own view off — one of the two exits every view has.
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(pressed("Workflows")).toBe("false");
    expect(screen.queryByTestId("workflows-canvas")).toBeNull();
    // (No composer assertion here: this case renders BARE, and `ChatStream`'s composer
    // island needs an ACTIVE Session, which the canvas case above seeds and this one
    // deliberately does not — a door-state case that needed a session would fail for a
    // reason that has nothing to do with the doors.)

    // Settings up: the Workflows door is NOT pressed for a peer's view.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(pressed("Settings")).toBe("true");
    expect(pressed("Workflows")).toBe("false");
  });

  it("a door opened from a PEER view goes to that view, not back to the workspace", async () => {
    // The doors are peers: from the board, the Workflows door opens the canvas. A
    // guard written on `currentView === "workspace"` instead of on the door's OWN view
    // would send the user to the chat instead, which is a one-click detour nobody asked
    // for — and it is green on every door test that only ever starts from the workspace.
    await bootedWithSelectedSpace();
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("tasks-board")).toBeTruthy();

    await openWorkflows();
    expect(screen.getByTestId("workflows-canvas")).toBeTruthy();
    expect(screen.queryByTestId("tasks-board")).toBeNull();
    // Still not the workspace — the chat column stayed away through both hops. (The
    // seeded Session is active, so the composer WOULD be on screen had the guard
    // misfired and sent this click to the workspace.)
    expect(screen.queryByTestId("composer-island")).toBeNull();
  });

  it("the permanent Session list survives the switch, so the canvas is escapable", async () => {
    // ADR 0094 hoisted the pane above the ternary, so it is on screen WHILE the canvas
    // is up and it owns both exits (its own pressed door, or any Session row). The
    // canvas carries no exit control of its own, exactly as the board carries none — so
    // this is the pin that says the view is not a dead end.
    await bootedWithSelectedSpace();
    await openWorkflows();
    expect(screen.getByTestId("workflows-canvas")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();

    // EXIT ONE — the pressed door.
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(screen.queryByTestId("workflows-canvas")).toBeNull();
    expect(screen.getByText("Sessions")).toBeTruthy();

    // EXIT TWO is a Session row, and it is pinned where the row is seeded with a title
    // the test can name — `App.test.tsx`'s "both exits of the BOARD view" case drives
    // exactly this gesture against the same wrapper. Re-seeding a titled row here would
    // duplicate that case's whole fixture to prove the SAME wrapper is handed to this
    // arm, which `App.tsx` shows in one line: the pane gets one
    // `onReturnToWorkspace`, not one per door.
  });
});
