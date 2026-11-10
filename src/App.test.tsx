import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import {
  createTask,
  editTask,
  externalOpen,
  getBoard,
  linkSession,
  listSessions,
  listSpaces,
  moveTask,
  reorderTasks,
  sendPrompt,
  sessionRecency,
  startTaskSession,
  listenInteractiveRequestClose,
  listenSessionTitled,
  listenSubagentClosed,
  listenSubagentSessionStarted,
  startSession,
} from "./lib/tauri";
import { useSessions } from "./store/sessions";
import { useSubagents } from "./store/subagents";
import { useInteractive } from "./store/interactive";
import { usePermissions } from "./store/permissions";
import { useSubagentSelection } from "./store/subagentSelection";
import { useTasks } from "./store/tasks";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
} from "./lib/newSpaceDialogState";

// Mock the Tauri IPC layer (the `importActual` pattern from
// `NewSpaceDialog.test.tsx`): the boot `useEffect` loads `listSessions` /
// `listSpaces` / `sessionRecency` (all resolving `[]` so the workspace renders
// its empty state), every `listen*` registration resolves a no-op unlisten (the
// App's listener `useEffect` awaits them in cleanup), and `listSkills` resolves
// `[]` (the `useSkillCatalog` hook in both `SpacesList` and `ChatStream`
// calls it on mount — the hook catches rejections, but the mock avoids
// noisy failures with a bare `vi.mock` factory).
//
// THE TRAP THIS FILE'S SHAPE SETS. Because the factory spreads `importActual`,
// a boot fetch NOT listed below resolves to the real wrapper, which rejects
// outside a webview — the boot `Promise.all` then rejects, its `.catch` swallows
// the reason, and every test in this file goes red looking unrelated. Add the
// mock in the same commit that adds the fetch.
vi.mock("./lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./lib/tauri");
  return {
    ...actual,
    listSessions: vi.fn().mockResolvedValue([]),
    listSpaces: vi.fn().mockResolvedValue([]),
    // The ADR 0075 recency fetch (which also carries the row's order number).
    // REQUIRED, not tidy: this factory spreads `importActual`, so an un-mocked
    // `sessionRecency` fires a real `invoke`, the boot `Promise.all` rejects,
    // and the `.catch` swallows the reason. Measured with this line removed:
    // 3 of the file's tests go red, and only ONE names recency — the other
    // two are Settings/start-failure cases that merely need a booted store, so
    // they fail with `activeSpacePath: null` and look nothing like the cause.
    // (Measured when the file held 41 cases; the count is a property of the test
    // list, not a constant — read it from `npx vitest list src/App.test.tsx`, not
    // from this comment or from grepping `it(`.)
    // (The "~40 reds" this comment used to claim was never measured; the file's
    // other boot mocks do not gate the whole suite.)
    sessionRecency: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    // `startSession`: required for the same reason as the catalog fetches below
    // — this factory spreads `importActual`, so the ⌘N chord's store command
    // (`startSessionInActiveSpace`) would reach the REAL `invoke`, which rejects
    // in jsdom. Un-mocked, a chord test here would still go green (the store
    // catches the rejection into `newSessionError`) while printing a failure no
    // one reads.
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: {},
      archived: false,
    }),
    // The three `useMentionCatalogs` fetches (`ChatStream`'s composer
    // catalogs). They MUST be mocked here: the factory spreads
    // `importActual`, so an un-mocked export still calls the REAL `invoke`,
    // which rejects in jsdom (`window.__TAURI_INTERNALS__` is undefined) and
    // the hook logs `"<name> failed:"` — 11 lines of stderr noise per test in
    // this file (green-but-noisy tests hide a real fetch failure). The empty
    // values are what the hook degrades to anyway, so the composer renders
    // exactly as it did before.
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    listMcpServersEffective: vi.fn().mockResolvedValue([]),
    listSpaceListing: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
    // The out-of-Space Directory completion rows (ADR 0035). Required, not
    // optional: `ChatStream` calls `useCompletionDir(null)` on EVERY mount (an
    // empty draft has no token, so the derived `dirPrefix` is `null` and the
    // cache misses), and this factory spreads `importActual` — an un-mocked
    // export would fire a REAL `invoke` in jsdom and log a
    // `listCompletionEntries failed:` line in every test here.
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
    // `SettingsPage`'s data deps: the settings document + the model catalog.
    getSettings: vi.fn().mockResolvedValue({
      theme: "dark",
      paneLayout: {},
      defaultTrustNewSpaces: false,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledTools: [],
      providers: [],
      mcpServers: {},
      font: { sizePx: 14, uiFamily: null, codeFamily: null },
      defaultThinkingLevels: {},
      agentOverrides: {},
      spinnerStyle: null,
      emptyStateAnimation: null,
      filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
      web: {
        braveApiKey: "",
        tavilyApiKey: "",
        perplexityApiKey: "",
        searxngUrl: "",
        defaultProvider: "auto",
        proxy: "",
      },
      mcpMentionsEnabled: false,
      sessionNamingEnabled: true,
      sessionNamingModel: null,
      sessionNamingReasoning: null,
      attentionAlertsEnabled: true,
      attentionAlertDelaySecs: 15,
    }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    listTools: vi.fn().mockResolvedValue([]),
    // Every `listen*` registration resolves a no-op unlisten.
    listenSessionUpdate: vi.fn().mockResolvedValue(() => {}),
    listenSessionClosed: vi.fn().mockResolvedValue(() => {}),
    // The stalled + titled pushes: un-mocked, either export would reach the
    // REAL `listen()` in jsdom (no `window.__TAURI_INTERNALS__`), so the
    // registration rejects instead of resolving its no-op unlisten.
    listenSessionStalled: vi.fn().mockResolvedValue(() => {}),
    listenSessionTitled: vi.fn().mockResolvedValue(() => {}),
    listenPermissionRequest: vi.fn().mockResolvedValue(() => {}),
    listenInteractiveRequest: vi.fn().mockResolvedValue(() => {}),
    listenInteractiveRequestClose: vi.fn().mockResolvedValue(() => {}),
    listenInteractiveEvent: vi.fn().mockResolvedValue(() => {}),
    listenSubagentSessionStarted: vi.fn().mockResolvedValue(() => {}),
    listenSubagentClosed: vi.fn().mockResolvedValue(() => {}),
    // The attention-alert commands (`useAttentionAlert`, mounted at the top of
    // `App`). Required for the same reason as the catalog fetches above: this
    // factory spreads `importActual`, so an un-mocked export would reach the
    // REAL `invoke`, which rejects in jsdom and the hook logs
    // `attention alert failed:` — stderr noise instead of a green-and-silent run.
    attentionArm: vi.fn().mockResolvedValue(undefined),
    attentionDisarm: vi.fn().mockResolvedValue(undefined),
    // The **External open** command (ADR 0051): `OpenAnchor`'s click handler
    // calls it, and the real one reaches `invoke` — mocked so the two
    // `SpaceCwdProvider` tests below can assert the cwd it is handed.
    externalOpen: vi.fn().mockResolvedValue(undefined),
    // THE TASK-BOARD COMMANDS. Required for the SAME reason every other entry here
    // is required: this factory spreads `importActual`, so an un-mocked export
    // resolves to the REAL wrapper, which calls `invoke`, which rejects in jsdom
    // (`window.__TAURI_INTERNALS__` is undefined). `TasksBoard` fetches its board on
    // MOUNT, so the moment a test clicks through to the `"board"` view an un-mocked
    // `getBoard` rejects inside the store's `load`.
    //
    // MOCKED UNDER THE WRAPPER NAMES, NOT THE RUST COMMAND NAMES. The store imports
    // `getBoard`/`moveTask`/… from this barrel; a `get_board` key here would stub a
    // name nothing imports and leave the real wrapper live — green, and pinning a
    // rejection. (AGENTS.md's trap in its exact shape.)
    //
    // The board loads on MOUNT rather than at boot, so these are NOT boot mocks and
    // the boot trio above stays the only thing the boot `Promise.all` needs: a Space
    // that never opens the board never pays for `get_board`, which WRITES (it seeds
    // the five default stages, ADR 0090).
    getBoard: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({
      id: "tsk_new",
      spacePath: "/tmp/ws",
      number: 1,
      title: "New task",
      body: null,
      specPath: null,
      stageSlug: "backlog",
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
    getTask: vi.fn().mockResolvedValue(null),
    editTask: vi.fn().mockResolvedValue({
      id: "tsk_new",
      spacePath: "/tmp/ws",
      number: 1,
      title: "New task",
      body: null,
      specPath: null,
      stageSlug: "backlog",
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
    moveTask: vi.fn().mockResolvedValue({ onEnter: "none", boostNote: null }),
    reorderTasks: vi.fn().mockResolvedValue(undefined),
    linkSession: vi.fn().mockResolvedValue(undefined),
    // `startTaskSession` + `sendPrompt`: THE NEW TASK MODAL'S TWO SEND PATHS (A5).
    // Required for the same reason every other entry in this factory is required
    // — it spreads `importActual`, so an un-mocked export resolves to the REAL
    // wrapper, which calls `invoke`, which rejects in jsdom. `App.test.tsx` renders
    // the board arm and the board owns the modal's render site, so a test that
    // clicks `New task` and sends reaches both. Un-mocked, the failure would not
    // read as a missing mock: `createTask` would land, `startTaskSession` would
    // reject, and the case would be asserting the modal's ERROR LINE — a
    // rejection — as if it were the behaviour under test. (AGENTS.md's trap.)
    startTaskSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: {},
      archived: false,
    }),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    // The modal footer's config write, and the composer's four catalogs — the
    // same reason as the catalog entries above (green-but-noisy is the failure
    // mode here, not red).
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    readClipboardImage: vi.fn().mockResolvedValue(null),
    readFileBytes: vi.fn().mockResolvedValue(null),
    loadHistory: vi
      .fn()
      .mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    // Window state hydration and subscription (`useWindowMaximized`)
    getWindowState: vi.fn().mockResolvedValue({
      isTiled: false,
      isMaximized: false,
      isFullscreen: false,
      native: false,
    }),
    listenWindowState: vi.fn().mockResolvedValue(() => {}),
  };
});

const mockIsMaximized = vi.fn().mockResolvedValue(false);
const mockIsFullscreen = vi.fn().mockResolvedValue(false);
const mockOnResized = vi.fn().mockResolvedValue(() => {});
const mockOnMoved = vi.fn().mockResolvedValue(() => {});
const mockOuterPosition = vi.fn().mockResolvedValue({ x: 100, y: 100 });
const mockOuterSize = vi.fn().mockResolvedValue({ width: 800, height: 600 });
const mockCurrentMonitor = vi.fn().mockResolvedValue(null);

// `App` renders `WindowControls`, which calls `getCurrentWindow()` from
// `@tauri-apps/api/window` on EVERY render (its own test file documents
// this and mocks the module); in jsdom `window.__TAURI_INTERNALS__` is
// undefined → `TypeError` during render → every case fails without it.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: mockIsMaximized,
    isFullscreen: mockIsFullscreen,
    onResized: mockOnResized,
    onMoved: mockOnMoved,
    outerPosition: mockOuterPosition,
    outerSize: mockOuterSize,
  }),
  currentMonitor: () => mockCurrentMonitor(),
}));

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
});

// The Open Space dialog's flag is MODULE-scoped, so it outlives every case in
// this file — and this file can now raise it (the root ⌘O chord). The reset must
// sit at FILE scope, not inside one `describe`: a leaked `true` makes EVERY later
// `render(<App/>)` mount a real Radix modal, which sets
// `document.body.style.pointerEvents = "none"` and `aria-hidden`s its siblings,
// so unrelated `getByRole` queries all over the file go red for a reason that
// has nothing to do with them.
beforeEach(() => {
  setNewSpaceDialogOpen(false);
});

describe("App (the Settings door + the settings view swap)", () => {
  // The window-state mocks are module-scoped: reset them between tests. (This
  // block used to also reset the two pane collapsed flags; both panes are
  // permanent now, so those modules are deleted.)
  beforeEach(() => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);
    mockOnResized.mockResolvedValue(() => {});
    mockOnMoved.mockResolvedValue(() => {});
    mockOuterPosition.mockResolvedValue({ x: 100, y: 100 });
    mockOuterSize.mockResolvedValue({ width: 800, height: 600 });
    mockCurrentMonitor.mockResolvedValue(null);
  });

  it("renders with rounded-xl corners when window is floating (not maximized)", async () => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);
    render(<App />);
    const root = document.querySelector('[data-testid="chrome-bar"]')!.parentElement!;
    expect(root.className).toContain("rounded-xl");
    expect(root.className).not.toContain("rounded-none");
  });

  it("renders with rounded-none (no rounded corners) when window is maximized", async () => {
    mockIsMaximized.mockResolvedValue(true);
    mockIsFullscreen.mockResolvedValue(false);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    const root = document.querySelector('[data-testid="chrome-bar"]')!.parentElement!;
    expect(root.className).toContain("rounded-none");
    expect(root.className).not.toContain("rounded-xl");
  });

  it("renders with rounded-none (no rounded corners) when window is snapped to a side", async () => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);
    mockCurrentMonitor.mockResolvedValue({
      scaleFactor: 1,
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1040 },
      },
    });
    mockOuterPosition.mockResolvedValue({ x: 0, y: 0 });
    mockOuterSize.mockResolvedValue({ width: 960, height: 1040 });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    const root = document.querySelector('[data-testid="chrome-bar"]')!.parentElement!;
    expect(root.className).toContain("rounded-none");
    expect(root.className).not.toContain("rounded-xl");
  });

  it("the header shows the app icon (app-icon-large) and NO 'Archimedes' text (the word was removed — icon only)", () => {
    render(<App />);
    // The top-left header-bar icon (the label is gone — icon only).
    const icon = screen.getByAltText("Archimedes");
    expect(icon.getAttribute("src")).toBe("/app-icon-large.png");
    expect(screen.queryByText("Archimedes")).toBeNull();
  });

  it("the chrome bar is the drag region (the whole bar — draggable + double-click to maximize; the inner buttons stay interactive)", () => {
    render(<App />);
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    // The attribute on the CONTAINER with the value "deep": Tauri's
    // drag-region script honors a BARE attribute only on the element a
    // mousedown lands on DIRECTLY (a click on a child of a bare-attribute
    // element does NOT drag — the bar's logo segment / tab spacer would
    // be dead zones). "deep" extends the region to the whole subtree: the
    // bar's empty areas drag the window (double-click maximizes) while the
    // inner buttons/tabs (interactive elements without the attribute) still
    // block it and stay clickable.
    expect(chrome.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("renders the Space tabs in the top chrome bar (browser-style — NOT in the center column)", () => {
    render(<App />);
    const tabs = screen.getByTestId("space-tabs");
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    // The tabs are a direct child of the chrome bar (the top row) — the
    // old position was the center column's top row (above the chat).
    expect(chrome.contains(tabs)).toBe(true);
    expect(tabs.parentElement).toBe(chrome);
    // …and the content row (the second child) does NOT contain them.
    const content = document.querySelector('[data-testid="content-row"]')!;
    expect(content.contains(tabs)).toBe(false);
  });

  it("the chrome bar holds NO pane toggle and NO app-control cluster (the Settings door lives in the Session list)", () => {
    render(<App />);
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    // The chrome bar carries the tabs and the window controls and NOTHING else.
    // Assert the ABSENCE of the pane toggles and of the retired app-control
    // cluster by their STABLE testids, not by label — a name-only query would
    // pass vacuously after a rename, which is the vacuity this file has been
    // bitten by twice. All three are retired outright (not relocated): the
    // toggles died with the panes' collapsed flags, the cluster with
    // `ChromeControls`, whose gear moved into the Session list's command strip.
    for (const testid of [
      "left-pane-toggle",
      "right-pane-toggle",
      "chrome-controls",
    ]) {
      expect(screen.queryByTestId(testid), testid).toBeNull();
    }
    // `WindowControls` has no testid of its own, so identify it by its
    // `[data-window-control]` container (the attention-alert exemption).
    const windowControls = chrome.querySelector("[data-window-control]")!;
    expect(windowControls).toBeTruthy();
    // The window controls are the bar's LAST child (nothing may crowd in right
    // of close/minimize — that corner belongs to the window manager). With the
    // gear gone they are also its only buttons.
    expect(windowControls.nextElementSibling).toBeNull();
    expect(
      chrome.querySelectorAll('[data-window-control] button').length,
    ).toBeGreaterThan(0);
    // The `bg-warning` pending dot died with the collapsible panes (it meant
    // "something needs you BEHIND the hidden pane"), and the gear this door
    // replaced was its last possible host. Asserted here because the relocation
    // is exactly the refactor that could have given the dot a new home.
    expect(document.querySelectorAll(".bg-warning")).toHaveLength(0);
    // The Settings door is NOT in the chrome bar any more: the Session list
    // renders inside the content row, so that is where the door sits now.
    const content = document.querySelector('[data-testid="content-row"]')!;
    const door = screen.getByRole("button", { name: "Settings" });
    expect(content.contains(door)).toBe(true);
    expect(chrome.contains(door)).toBe(false);
  });

  it("the Settings door is OUTSIDE the window controls' attention-alert exemption (ADR 0038)", () => {
    // `data-window-control` exempts a click from counting as user activity
    // (ADR 0038) — right for "run finishes → click Minimize → walk away", wrong
    // for opening Settings, which is a person coming back to work. The rule
    // lives in `useAttentionAlert.ts` (`if (el?.closest("[data-window-control]"))
    // return;`), and the door satisfies it structurally now that it sits in the
    // Session list rather than in the chrome bar beside the window controls.
    // Pinned anyway: an unasserted structural property is one refactor away
    // from silently regressing.
    render(<App />);
    const door = screen.getByRole("button", { name: "Settings" });
    expect(door.closest("[data-window-control]")).toBeNull();
    // …and it is inside the content row, i.e. nowhere near the exemption.
    expect(
      door.closest('[data-testid="content-row"]'),
    ).toBeTruthy();
  });

  it("the settings view renders NO tabs in the chrome bar (the logo segment spans full width) and keeps its door PRESSED", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByTestId("space-tabs")).toBeNull();
    // The door INTO this page is still on screen — and PRESSED. N1: the strip is
    // the view switcher, and the door that opens a view is the door that closes
    // it, so this door is also the page's way out (its own `Back` is retired).
    // (The chrome-bar cluster this case used to assert the absence of is
    // retired outright, so the absence half now lives in `the chrome bar holds NO
    // pane toggle and NO app-control cluster`.)
    const door = screen.getByRole("button", { name: "Settings" });
    expect(door.getAttribute("aria-pressed")).toBe("true");
    const logo = screen.getByAltText("Archimedes").parentElement!;
    // No inline width — the segment is `flex-1` (full width, the old
    // chrome-bar behavior), icon only (the word was removed).
    expect(logo.style.width).toBe("");
    expect(screen.queryByText("Archimedes")).toBeNull();
  });

  it("the tabs start 1px right of the sidebar's right edge (the center column's left edge — the chrome bar's left padding lives INSIDE the logo segment, not before it)", () => {
    render(<App />);
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    const tabs = screen.getByTestId("space-tabs");
    // The chrome bar has NO left padding (a `pl-*` here would offset the
    // logo segment — and the tabs after it — right of the sidebar's
    // 260px edge): the 12px icon margin lives INSIDE the logo segment.
    expect(chrome.className).not.toContain("pl-");
    expect(chrome.className).not.toContain("px-");
    const logo = screen.getByAltText("Archimedes").parentElement!;
    expect(logo.className).toContain("pl-3");
    // …and the tabs container has a 1px left offset (`pl-px` — the user's
    // "1px too far left" nudge: the first tab sits 1px right of the
    // segment's edge = the center column's left edge) and NO larger left
    // padding (a `pl-1`/`pl-2`/… would push it further right).
    expect(tabs.className).toContain("pl-px");
    expect(tabs.className).not.toContain("pl-1");
    expect(tabs.className).not.toContain("pl-2");
    expect(tabs.className).not.toContain("pl-3");
    expect(tabs.className).not.toContain("px-");
  });

  it("the_settings_door_swaps_to_the_settings_view", () => {
    render(<App />);
    // The workspace is visible (the `SpacesList`'s "Sessions" heading).
    expect(screen.getByText("Sessions")).toBeTruthy();
    // The Settings door (the Session list's command strip) opens the settings view.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // The settings view is visible (the `SettingsPage`'s section nav). It sits
    // BESIDE the `SpacesList`, which is hoisted out of the view ternary and so
    // renders here too (spec D2) — two nav columns on one page is the accepted
    // cost of a permanent Session list (spec D3).
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Providers")).toBeTruthy();
    // ...and the workspace is gone (it UNMOUNTS — the stores are the
    // source of truth and re-hydrate on remount, so the ZCode
    // `opacity-0` + `inert` pattern is not needed). What unmounts is now
    // exactly `ChatStream` / `SidePane` / `SubagentDetailHost`; the Session
    // list stays, which is what the two lines above now read.
    expect(screen.getByText("Sessions")).toBeTruthy();
  });

  it("both exits of the SETTINGS view return to the workspace (the door toggles off; a Session row leaves)", async () => {
    // THE PIN THIS CASE CARRIED AS `the_back_button_returns_to_the_workspace`:
    // you can get home. The page's `Back` button is retired (N1 — with the strip
    // as the view switcher, a view is left by clicking where you want to go), so
    // the pin now rides the two exits that replaced it. It is worth MORE than it
    // was: with no dedicated exit control, these two ARE the way out, and if both
    // failed this view would be a dead end.
    render(<App />);
    // Drain the boot trio BEFORE seeding: `setSpaces([])` runs after any seed and
    // would erase it (the same ordering reason the row case below spells out).
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      useSessions.setState({
        spaces: [
          { path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false },
        ],
        sessions: [
          {
            sessionId: "s-live",
            cwd: "/tmp/alpha",
            capabilities: {},
            archived: false,
            title: "Live session",
          },
        ],
        activeSessionId: "s-live",
        activeSpacePath: "/tmp/alpha",
      });
    });
    const settingsNav = () =>
      screen.queryByRole("navigation", { name: "Settings sections" });
    const settingsDoor = () =>
      screen.getByRole("button", { name: "Settings" });

    // EXIT ONE — the pressed door toggles its own view off.
    fireEvent.click(settingsDoor());
    expect(screen.getByText("General")).toBeTruthy();
    expect(settingsNav()).toBeTruthy();
    expect(settingsDoor().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(settingsDoor());
    expect(settingsNav()).toBeNull();
    expect(screen.getByText("Sessions")).toBeTruthy();

    // EXIT TWO — a Session row. This is the exit that catches the person who
    // never learns the door is a toggle: "show me this Session" necessarily
    // includes leaving the page covering the transcript.
    fireEvent.click(settingsDoor());
    expect(settingsNav()).toBeTruthy();
    fireEvent.click(screen.getByText("Live session"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(settingsNav()).toBeNull();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(settingsDoor().getAttribute("aria-pressed")).toBe("false");
  });

  // The two cases below seed the SESSIONS store, and it is a module singleton
  // this file never hands to `resetStores()` — so the seed has to be taken back
  // by hand, in a pair (the same shape the `App (a failed ⌘N …)` describe uses).
  // Without the `beforeEach` a seed from an EARLIER case in this describe would
  // put rows on screen inside a later one; without the `afterEach` a live
  // `activeSessionId` would decide inline-vs-overlay for the very next
  // describe's gate cases, which read the active session to pick a render site.
  const clearSeededSessions = () =>
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: null,
      spaces: [],
      messages: {},
    });
  beforeEach(clearSeededSessions);
  afterEach(clearSeededSessions);

  it("the Session list renders on the SETTINGS view (the hoisted pane, spec D2)", () => {
    render(<App />);
    expect(screen.getByText("Sessions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // BOTH navs are on screen at once — the Session list (hoisted out of the
    // view ternary, so it no longer unmounts here) and `SettingsPage`'s own
    // section nav (D3: it keeps its 268px `aside`; the two columns sitting side
    // by side is the accepted cost, not a bug).
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).toBeTruthy();
    // …and the page itself is what the door opened (the section buttons).
    expect(screen.getByText("General")).toBeTruthy();
  });

  it("the Settings and Tasks doors carry aria-pressed, and Skills and Agents do not", () => {
    // N2: the strip is the view switcher, so the two doors that NAME a view say
    // which one is showing. The two that raise a MODAL carry no `aria-pressed`
    // at all — a modal is not a location, and a pressed state on one would make
    // "where am I" ambiguous. Asserted for all four, so a future editor who adds
    // `aria-pressed` to a modal button reddens this rather than shipping the
    // ambiguity.
    render(<App />);
    const door = (name: string) => screen.getByRole("button", { name });
    const pressed = (name: string): string | null =>
      door(name).getAttribute("aria-pressed");

    // The workspace: neither view door is pressed, and neither modal button
    // carries the attribute.
    expect(pressed("Settings")).toBe("false");
    expect(pressed("Tasks")).toBe("false");
    expect(pressed("Skills")).toBeNull();
    expect(pressed("Agents")).toBeNull();

    // Settings up: exactly one door is pressed (N1 — one of the three is always
    // the pressed one, and the workspace is the state where neither is).
    fireEvent.click(door("Settings"));
    expect(pressed("Settings")).toBe("true");
    expect(pressed("Tasks")).toBe("false");
    expect(pressed("Skills")).toBeNull();
    expect(pressed("Agents")).toBeNull();

    // …and the Settings door toggles its own view off — one of the two exits this
    // view has (the other is a Session row). The page carries no exit control of
    // its own: its `Back` is retired as redundant, so these two are the whole way out.
    fireEvent.click(door("Settings"));
    expect(pressed("Settings")).toBe("false");

    // The board: the same rule with the other door.
    fireEvent.click(door("Tasks"));
    expect(pressed("Tasks")).toBe("true");
    expect(pressed("Settings")).toBe("false");
    expect(pressed("Skills")).toBeNull();
    expect(pressed("Agents")).toBeNull();
    fireEvent.click(door("Tasks"));
    expect(pressed("Tasks")).toBe("false");
  });

  it("the active Session row is not marked while a peer view is pressed", async () => {
    // N1: exactly one of {workspace, Settings, Tasks} is "where you are". While
    // a view door is pressed the pane is NOT the place you are, so no row may
    // wear the selection fill — nor the Archived section's rows, which reach the
    // same rule through a `null` `activeSessionId` rather than through the row's
    // own `active` (two sites, one rule, spelled once each).
    render(<App />);
    // Let the boot trio land FIRST (the same reason the case below gives):
    // `setSpaces([])` runs after any seed and rewrites `activeSpacePath`
    // unconditionally, so a seed placed before the drain is erased by the boot
    // effect rather than by anything this case does.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      useSessions.setState({
        spaces: [
          { path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false },
        ],
        sessions: [
          {
            sessionId: "s-live",
            cwd: "/tmp/alpha",
            capabilities: {},
            archived: false,
            title: "Live session",
          },
        ],
        archivedSessions: [
          {
            sessionId: "s-arch",
            cwd: "/tmp/alpha",
            capabilities: {},
            archived: true,
            title: "Archived session",
          },
        ],
        activeSessionId: "s-live",
        activeSpacePath: "/tmp/alpha",
      });
    });
    // The Archived section is collapsed by default, so its row needs the header.
    fireEvent.click(screen.getByText("Archived"));
    // Scope to the Session list: `SidePane`'s header prints the active Session's
    // title too, so a document-wide `getByText` finds two nodes for one row.
    const pane = screen.getByText("Sessions").closest("aside") as HTMLElement;
    const rowFor = (title: string): HTMLElement =>
      within(pane).getByText(title).closest('[role="button"]') as HTMLElement;
    const settingsDoor = () => screen.getByRole("button", { name: "Settings" });

    // In the workspace the active row wears the selection fill.
    expect(rowFor("Live session").className).toContain("bg-selected");
    fireEvent.click(settingsDoor());
    // The rows are still on screen (the pane is permanent) — they are just no
    // longer marked as the answer to "where am I".
    expect(rowFor("Live session").className).not.toContain("bg-selected");
    // The store is untouched by the dimming: only the RENDERED selection went
    // away, so toggling the door off brings it straight back.
    expect(useSessions.getState().activeSessionId).toBe("s-live");
    fireEvent.click(settingsDoor());
    expect(rowFor("Live session").className).toContain("bg-selected");

    // The **Archived** rows obey the same rule, through the OTHER site: the
    // section takes `activeSessionId` as a prop and is handed `null` while a peer
    // view is pressed, rather than having its own `active` gated.
    act(() => {
      useSessions.setState({ activeSessionId: "s-arch" });
    });
    expect(rowFor("Archived session").className).toContain("bg-selected");
    fireEvent.click(settingsDoor());
    expect(rowFor("Archived session").className).not.toContain("bg-selected");
    act(() => {
      useSessions.setState({ activeSessionId: "s-live" });
    });
  });

  it("a Session row clicked on the SETTINGS view switches the Session and returns to the workspace", async () => {
    render(<App />);
    // Let the boot trio land FIRST: `setSpaces([])` runs after any seed and
    // rewrites `activeSpacePath` unconditionally, so a seed placed before the
    // drain would be erased by the boot effect rather than by the click.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      useSessions.setState({
        spaces: [
          { path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false },
        ],
        // One LIVE Session (the active one) and one STORED one — the row the
        // case clicks is a stored row, which is the honest shape of "switch to
        // another Session" from a page that shows no transcript.
        sessions: [
          {
            sessionId: "s-live",
            cwd: "/tmp/alpha",
            capabilities: {},
            archived: false,
            title: "Live session",
          },
        ],
        historySessions: [
          {
            sessionId: "s-stored",
            cwd: "/tmp/alpha",
            capabilities: {},
            archived: false,
            title: "Stored session",
          },
        ],
        activeSessionId: "s-live",
        activeSpacePath: "/tmp/alpha",
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // The rows are on screen WITH Settings up (the point of the hoist).
    expect(screen.getByText("Stored session")).toBeTruthy();

    fireEvent.click(screen.getByText("Stored session"));
    await act(async () => {
      await Promise.resolve();
    });

    // The switch happened (a row click is a store action, not a navigation)…
    expect(useSessions.getState().activeSessionId).toBe("s-stored");
    // …and the workspace is back: N3 reverses spec D8. Once the pane IS the view
    // switcher, "show me this Session" necessarily includes leaving Settings —
    // the row is the second of the two exits every view has (N1).
    expect(
      screen.queryByRole("navigation", { name: "Settings sections" }),
    ).toBeNull();
    expect(screen.queryByText("General")).toBeNull();
    // The door is on screen again and no longer pressed — the view it named is
    // gone, so nothing is pressed but the workspace.
    expect(
      screen.getByRole("button", { name: "Settings" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("App (the child-gate overlay host mounted at the App root)", () => {
  // The overlay host is mounted at the `App` root — OUTSIDE the
  // `view === "settings"` ternary — so these guarantees (a child's gate is
  // answerable whatever the view and whatever the pane's width) belong to
  // `App`, not to `SidePane`.
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useInteractive.getState().dismissSession("sub1");
    useInteractive.getState().dismissSession("main1");
    usePermissions.getState().dismissSessionPrompts("sub1");
    usePermissions.getState().dismissSessionPrompts("main1");
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  it("a child's pending `ask` stays answerable while the SETTINGS view is open (the host is a sibling of the whole view ternary)", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    render(<App />);
    // The workspace unmounts in the settings view (`SidePane`,
    // `SubagentDetailHost`, `ChatStream` are all inside the ternary's
    // else-branch) — a host mounted in either of them would render NOTHING
    // here, and an unrendered gate strands the child INDEFINITELY (ADR 0055: a
    // child parked on a gate holds its `tool_call_id` open, so it is an Active
    // Subagent and `DEFAULT_SUBAGENT_DEAD_BOUND` never runs on it).
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
  });

  it("a pending child `ask` renders even though the gate host lives outside the Side pane", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    render(<App />);
    // This assertion moved here from `SidePane.test.tsx`, because the guarantee
    // is an `App`-root one: `SubagentModals` is mounted at the root, OUTSIDE the
    // Side pane's frame, so whatever the pane does to its own box — and it used
    // to be able to clip itself to a rail — never applies to the card.
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    // Exactly one render of the card (the one-site invariant — the pane is not
    // a second host that could light up alongside the overlay).
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
  });

  it("a pending child `password` modal renders even though the gate host lives outside the Side pane", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<App />);
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(screen.getAllByText("Sudo password required")).toHaveLength(1);
  });

  it("the gate panel stays in the DOM while a sudo modal is open (Radix hides it from assistive tech; the gate underneath stays pending)", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<App />);
    // ACCEPTED stacking (documented on `SubagentModals`): the sudo `Dialog` is
    // `z-50` and Radix calls `hideOthers` + `disableOutsidePointerEvents` while
    // it is open, so the `z-40` panel is hidden from assistive tech and
    // pointer-inert — `getByRole` (which respects `aria-hidden`) cannot see the
    // card while the modal is up. It is still MOUNTED, so the ask is neither
    // unrendered nor answered twice; it becomes answerable again the moment the
    // modal is settled. That is why the two host tests above seed ONE kind
    // each.
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Red" }),
      "the panel must be hidden while the modal is open, not unmounted",
    ).toBeNull();
    expect(screen.getByTestId("subagent-gate-overlay").textContent).toContain(
      "Which color?",
    );
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(2);
  });
});

describe("App (a child gate renders at EXACTLY ONE site: inline vs overlay)", () => {
  // THE INVARIANT PIN. It lives here because only `App` mounts BOTH render
  // sites — `ChatStream` (inline, via `MessageList`) and `SubagentModals`
  // (the overlay) — so counting cards in `ChatStream.test.tsx`, which renders
  // `<ChatStream />` alone, could never see a duplicate. The render-site
  // partition splits the two sites on ONE key: is this gate's parent the ACTIVE
  // session. Exactly one site per gate, in every state — never two (divergent
  // typed-but-unsubmitted drafts, an Esc that closes only one) and never zero
  // (an unrendered gate strands the child INDEFINITELY — ADR 0055 makes a
  // gate-parked child an Active Subagent, so no clock bounds it).
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  /** Seed `sessionId` as the LIVE, ACTIVE session (so `ChatStream` renders a
   * transcript it could render a gate into). */
  const seedActiveSession = (sessionId: string) =>
    useSessions.setState({
      activeSessionId: sessionId,
      sessions: [
        { sessionId, cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      historySessions: [],
      archivedSessions: [],
      spaces: [{ path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      messages: { [sessionId]: [] },
      inTurn: {},
      stopReasons: {},
      closeReasons: {},
      configOptions: {},
    });
  const seedChildAsk = () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useInteractive.getState().dismissSession("sub1");
    usePermissions.getState().dismissSessionPrompts("sub1");
    // The sheet tests below open a sheet; a leaked selection would move
    // `SubagentModals`' panel for every later test in this file.
    useSubagentSelection.getState().select(null);
    useSessions.setState({
      activeSessionId: null,
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      messages: {},
    });
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  it("with the PARENT active: one card, INLINE in the transcript, and NONE in the overlay", () => {
    seedActiveSession("main1");
    seedChildAsk();
    render(<App />);
    // EXACTLY ONE answerable card in the whole document.
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    // …and it is the TRANSCRIPT's copy: `sub1`'s parent IS the active session,
    // so `MessageList` owns it and the overlay must stand down.
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    expect(scroll.textContent).toContain("Which color?");
    expect(scroll.textContent).toContain("↳ reviewer");
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
  });

  it("with a DIFFERENT session active: one card, in the OVERLAY, and NONE in the transcript", () => {
    seedActiveSession("other");
    seedChildAsk();
    render(<App />);
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    // `sub1`'s parent is not the active session — `ChatStream` structurally
    // cannot render it, so the overlay must, or the gate renders NOWHERE.
    expect(scroll.textContent).not.toContain("Which color?");
    const panel = screen.getByTestId("subagent-gate-overlay");
    expect(panel.textContent).toContain("Which color?");
  });

  it("navigating between the parent and another session MOVES the card without duplicating or dropping it", () => {
    seedActiveSession("main1");
    seedChildAsk();
    render(<App />);
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    // The gate stays pending across the navigation (no answer, no dismiss).
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
    act(() => {
      useSessions.getState().setActiveSession("other");
    });
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(
      document
        .querySelector('[data-testid="subagent-gate-overlay"]')!
        .textContent,
    ).toContain("Which color?");
    act(() => {
      useSessions.getState().setActiveSession("main1");
    });
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).toContain("Which color?");
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("opening Settings keeps the child sheet: the panel never dodges a sheet that is NOT mounted, and leaving Settings re-opens it", () => {
    // The sheet and the overlay are mounted in DIFFERENT places:
    // `SubagentDetailHost` is inside the `view === "settings"` ternary's
    // else-branch and UNMOUNTS with the workspace, while `SubagentModals` is a
    // sibling of the whole ternary and stays (that is what keeps its half of the
    // gates answerable). So during the Settings round-trip the SELECTION outlives
    // the sheet it names, and the panel's dodge must key on whether the sheet is
    // MOUNTED — which `App` knows and the overlay cannot see — not on the
    // selection alone. `App` therefore passes `sheetMounted` down. It must NOT
    // pay for that by clearing the selection: the selection is the SHEET's state
    // (which row's transcript the user opened, owned by
    // `store/subagentSelection` / `SubagentDetailHost`), and clearing it on the
    // way into Settings silently threw the sheet away, so leaving Settings left
    // the user with a closed sheet they had to re-open by hand.
    seedActiveSession("other");
    seedChildAsk();
    render(<App />);
    const panel = () => screen.getByTestId("subagent-gate-overlay");
    // The overlay owns this card (its parent is not the active session) and
    // starts in the viewport corner.
    expect(panel().className).toContain("right-0");
    // Open the child's sheet: the panel dodges to the sheet's left edge (from
    // the breakpoint up — see the geometry pins in `SubagentModals.test.tsx`).
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    expect(panel().className).toContain("min-[760px]:right-[480px]");
    // Open Settings: the workspace — sheet included — unmounts.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Close subagent transcript" }),
    ).toBeNull();
    // THE FIRST HALF OF THE PIN: no sheet MOUNTED, so no dodge — the panel is
    // back at the right edge, and does not float over the Settings page at the
    // sheet's offset (squeezed per the geometry pins).
    expect(panel().className).toContain("right-0");
    expect(panel().className).not.toContain("min-[760px]:right-[480px]");
    // THE SECOND HALF: the sheet's own state survived the round-trip. The
    // selection still names the child whose transcript was open, and the entry
    // is untouched (`SubagentDetailHost`'s semantics: closing is `select(null)`
    // alone, and nothing here closes the ENTRY).
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    expect(useSubagents.getState().entries["sub1"]).toBeTruthy();
    // The gate itself never moved: the overlay still holds it (the accepted
    // Settings hole is only for an ACTIVE parent — this parent is not active).
    expect(panel().textContent).toContain("Which color?");
    // Back to the workspace: the sheet the user had open is open again — with NO
    // further `select` call from the test, i.e. by `App`'s own doing. The exit is
    // the pressed Settings door toggling its own view off (the page's `Back` is
    // retired); which exit leaves Settings is not this case's subject, so the
    // door — the exit this page actually owns — is the one to click.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: /transcript/ }).textContent,
    ).toContain("reviewer");
    // And the panel dodges again, because a sheet is mounted again: the dodge is
    // `sheetMounted && the selection has an entry`, both halves live.
    expect(panel().className).toContain("min-[760px]:right-[480px]");
  });

  it("pins the SAME one-site rule for a Permission prompt (the second inline kind)", () => {
    // `MessageList` renders two kinds inline, so the invariant needs a pin on
    // both — a permission prompt that leaked into the overlay while also
    // rendering inline would be invisible to the `ask` tests above.
    seedActiveSession("main1");
    useSubagents.getState().addSession(childEntry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<App />);
    expect(screen.getAllByText("Bash (apt install ripgrep)")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).toContain("Bash (apt install ripgrep)");
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    act(() => {
      useSessions.getState().setActiveSession("other");
    });
    expect(screen.getAllByText("Bash (apt install ripgrep)")).toHaveLength(1);
    expect(
      document
        .querySelector('[data-testid="subagent-gate-overlay"]')!
        .textContent,
    ).toContain("Bash (apt install ripgrep)");
  });

  it("opening the gate-holding child's OWN sheet still renders the card EXACTLY ONCE (the sheet is not a third site)", () => {
    // THE THIRD-SITE PIN. There are exactly two gate hosts in the app — the
    // parent's transcript and the `SubagentModals` overlay — and a child's
    // transcript SHEET is neither (`SubagentDetailHost` renders
    // `SubagentTranscript`, which draws no prompt at all). The plausible
    // regression is a follow-up that "restores the prompt to the sheet" (or a
    // partial revert of the change that moved the gates out of
    // `SubagentTranscript`, when the sheet DID host a child's cards): the gate
    // would then render in the parent's transcript AND in the open sheet, which
    // breaks the one-site-per-gate rule — two live `AskQuestionCard`s of one
    // request, two divergent typed-but-unsubmitted drafts, and an answer that
    // can land twice. No test opened a child's sheet while that child held a
    // gate, so a mutation that added a third site here left the WHOLE suite
    // green.
    seedActiveSession("main1");
    seedChildAsk();
    render(<App />);
    // Baseline: the parent is active, so the single copy is INLINE.
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    // Open `sub1`'s sheet the way the UI does — a row click sets the selection.
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    const sheet = screen.getByRole("dialog", { name: /transcript/ });
    // The sheet really is open (its header mounted), so this test cannot pass
    // by accident on a sheet that never appeared.
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    // STILL exactly one answerable card in the whole document — the sheet adds
    // no second copy.
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    // …and it is NOT the sheet's: the sheet contains NONE of the question's
    // text (nor the attribution chip that labels the gate).
    expect(sheet.textContent).not.toContain("Which color?");
    expect(sheet.textContent).not.toContain("↳ reviewer");
    // The one copy stays where it was — the parent's transcript.
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).toContain("Which color?");
    // And the overlay still stands down for the active parent (three sites
    // would need the overlay to re-adopt it too).
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    // Nothing answered or dismissed the gate — it is pending exactly once.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("with a DIFFERENT session active AND the child's sheet open, the card is still the overlay's alone", () => {
    // The other half of the same boundary: the sheet is not a site whatever the
    // active session is. Here the OVERLAY owns the gate (`sub1`'s parent is not
    // active, so `ChatStream` structurally cannot draw it) while the sheet is
    // open — a sheet that rendered the prompt too would double it in exactly
    // the state where the overlay cannot be blamed for it.
    seedActiveSession("other");
    seedChildAsk();
    render(<App />);
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    const sheet = screen.getByRole("dialog", { name: /transcript/ });
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    expect(sheet.textContent).not.toContain("Which color?");
    expect(
      screen.getByTestId("subagent-gate-overlay").textContent,
    ).toContain("Which color?");
    // Closing the sheet neither drops nor duplicates the gate (never zero,
    // never two).
    fireEvent.click(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    );
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getByTestId("subagent-gate-overlay").textContent).toContain(
      "Which color?",
    );
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("pins the SAME one-site rule for a `confirm` (the sudo kind asserted only from the overlay's own file until now)", () => {
    // `SubagentModals.test.tsx` renders the overlay ALONE, so it can pin that
    // the overlay draws a child's `confirm` but structurally cannot see a
    // DUPLICATE. By this block's own argument — the invariant lives in `App`
    // because only `App` mounts both sites — the sudo kinds were therefore
    // unpinned. The mutation this guards is the one `MessageList`'s doc forbids
    // ("do not complete this by rendering them"): inlining a child's
    // `SudoConfirmModal` while the overlay keeps drawing it too.
    seedActiveSession("main1");
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<App />);
    // EXACTLY ONE sudo dialog while the child's parent is the ACTIVE session —
    // `ComposerModals` renders sudo dialogs for the active session's own ids
    // only, and a child id can never be active (`list_sessions` filters
    // `is_subagent = 0`), so the overlay is the only site.
    expect(screen.getAllByText("Run this command with sudo?")).toHaveLength(1);
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).not.toContain("Run this command with sudo?");
    // And STILL exactly one when a different session is active (the overlay owns
    // this kind either way — never twice, never nowhere).
    act(() => {
      useSessions.getState().setActiveSession("other");
    });
    expect(screen.getAllByText("Run this command with sudo?")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });
});

describe("App (the `session-titled` listener)", () => {
  // The store is module-scoped, and the boot fetch only fills the STORED
  // lists — so the live row this test seeds must be cleaned up or it leaks
  // into the next test in this file.
  const clearStore = () =>
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      activeSessionId: null,
      activeSpacePath: null,
      messages: {},
    });
  beforeEach(clearStore);
  afterEach(clearStore);

  it("writes a pushed title into the store the moment `session-titled` lands (no refetch)", () => {
    // A live session, pre-naming (`title: null` — the shape the backend
    // writes before the naming pass runs).
    useSessions.setState({
      sessions: [
        {
          sessionId: "s1",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: false,
          title: null,
        },
      ],
      activeSessionId: "s1",
    });
    render(<App />);
    // App registers the listener once on mount; the mock holds the callback
    // it handed `listen()`, i.e. exactly what the webview invokes per event.
    // The LAST registration is this render's (the file never clears mocks, so
    // earlier tests' renders pushed theirs first).
    const calls = vi.mocked(listenSessionTitled).mock.calls;
    const onTitled = calls[calls.length - 1][0];
    act(() => {
      onTitled({ sessionId: "s1", title: "Porting the session namer" });
    });
    // The LIVE row is what the sidebar and the side pane read, so the label
    // flips here — no `list_sessions` refetch is involved (that fetch ran
    // once at boot, before this title existed).
    expect(useSessions.getState().sessions[0].title).toBe(
      "Porting the session namer",
    );
  });
});

describe("App (the `subagent-closed` listener)", () => {
  // Both stores are module-scoped, so anything seeded here leaks into the next
  // test in this file unless both sides clear it.
  const clearStore = () => {
    useInteractive.getState().dismissSession("sub1");
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      activeSessionId: null,
      activeSpacePath: null,
      messages: {},
    });
  };
  beforeEach(clearStore);
  afterEach(clearStore);

  it("frees a closed child's todo board, and NOTHING ELSE in `useInteractive`", () => {
    // A child's board AND a child's pending gate, both keyed to the CHILD id
    // (the router re-emits a Subagent's frames verbatim, so the todo frame
    // carries the child's id — ADR 0041).
    useInteractive.getState().applyTodoUpdate("sub1", {
      source: "native",
      todos: [{ content: "child task", status: "in_progress" }],
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    render(<App />);
    // The LAST registration is this render's (the file never clears mocks).
    const calls = vi.mocked(listenSubagentClosed).mock.calls;
    const onClosed = calls[calls.length - 1][0];
    act(() => {
      onClosed({ sessionId: "sub1", status: "completed" });
    });
    // The board is gone. This is the ONLY frame that ever names the end of a
    // CHILD session (`session-closed` never carries a child id and
    // `src-tauri/` emits no `todos_clear` frame), so without this the child's
    // slice sat in the store for the life of the window.
    expect(useInteractive.getState().todos["sub1"]).toBeUndefined();
    // NARROW on purpose: `applyTodoClear`, NOT `dismissSession` — the latter
    // would also wipe the child's pending gates, and that IS the state ADR
    // 0040's amendment records (paraphrased here, not quoted): a closed child
    // keeps its gate card on screen until its entry is evicted.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });
});

/**
 * (issue #47) The `subagent-session-started` listener's wiring.
 *
 * This is the one thing no component test can see: `SubagentDelegatingCard` and
 * `SubagentDetailHost` are both tested against a store they seed themselves, so
 * a handler that dropped `nameResolution` on the way in would leave every one of
 * them green while the marker never appeared in the app.
 */
describe("App (the `subagent-session-started` listener)", () => {
  const clearStore = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useSubagentSelection.getState().select(null);
  };
  beforeEach(clearStore);
  afterEach(clearStore);

  it("carries the payload's `nameResolution` into the store entry", () => {
    render(<App />);
    // The LAST registration is this render's (the file never clears mocks).
    const calls = vi.mocked(listenSubagentSessionStarted).mock.calls;
    const onStarted = calls[calls.length - 1][0];
    act(() => {
      onStarted({
        sessionId: "sub1",
        parentSessionId: "main1",
        agentName: "reviewr",
        task: "t",
        // The issue's exact case: a typo in a correctly-spelled key.
        nameResolution: "unmatched",
      });
    });
    expect(useSubagents.getState().entries["sub1"].nameResolution).toBe(
      "unmatched",
    );
    expect(useSubagents.getState().entries["sub1"].agentName).toBe("reviewr");
  });

  it("OMITS the `nameResolution` key entirely for a payload from an older backend", () => {
    // The invariant `store/subagents.ts` documents and `subagents.test.ts`
    // pins — "an older backend OMITS it" — was only ever tested against a
    // fixture that went straight into `addSession`. The real wire path runs
    // through THIS handler, and an unconditional `nameResolution: p.nameResolution`
    // turns an absent wire field into a PRESENT-BUT-`undefined` key, which is
    // exactly the shape the store test says must not occur (an `undefined`-valued
    // key reads differently from an absent one in an `in` / spread-based
    // assertion — the same reason `makeSubagentEntry` deletes its own
    // explicitly-`undefined` optionals). So this asserts KEY ABSENCE, not that
    // the value merely reads `undefined`.
    render(<App />);
    const calls = vi.mocked(listenSubagentSessionStarted).mock.calls;
    const onStarted = calls[calls.length - 1][0];
    act(() => {
      onStarted({
        sessionId: "sub1",
        parentSessionId: "main1",
        agentName: "reviewr",
        task: "t",
        // An older backend: the field is not on the wire at all.
      });
    });
    const entry = useSubagents.getState().entries["sub1"];
    expect("nameResolution" in entry).toBe(false);
    // The rest of the entry is untouched by the omission.
    expect(entry.agentName).toBe("reviewr");
    expect(entry.status).toBe("running");
  });
});

describe("App (the `interactive-request-close` listener)", () => {
  const clearStores = () => {
    useInteractive.getState().dismissSession("sub1");
    usePermissions.getState().dismissSessionPrompts("sub1");
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  it("ONE close event clears the gate from BOTH stores", () => {
    // The gates live in TWO different Client stores: an `ask` / sudo sub-prompt
    // in `useInteractive.requests`, a **Permission** prompt in
    // `usePermissions.prompts`. The Rust side emits ONE event name for both
    // (`interactive-request-close`), and pre-fix this listener consulted only
    // `useInteractive` — so a Permission card could never be closed by ANY
    // emitter. That was already a hole on the MAIN-session path:
    // `cleanup_pending_modals` emits this very event for tracked Permission
    // modals, and nothing acted on those either.
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "native",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    usePermissions.getState().addPrompt("sub1", "p1", {
      toolCall: { title: "Bash (apt install ripgrep)" },
      options: [{ optionId: "allow", name: "Allow" }],
    });
    render(<App />);
    const calls = vi.mocked(listenInteractiveRequestClose).mock.calls;
    const onClose = calls[calls.length - 1][0];
    act(() => {
      onClose({ sessionId: "sub1", requestId: "p1" });
    });
    expect(usePermissions.getState().prompts["sub1"]).toHaveLength(0);
    // The kind the event did NOT name survives — the removal is per requestId,
    // so calling both filters is an idempotent no-op, not a wipe.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
    act(() => {
      onClose({ sessionId: "sub1", requestId: "r1" });
    });
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(0);
  });
});

describe("App (the accepted settings-view hole for an inline gate)", () => {
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useInteractive.getState().dismissSession("sub1");
    useSessions.setState({
      activeSessionId: null,
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      messages: {},
    });
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  it("KNOWN HOLE (accepted, documented): with the Settings view open AND the parent active, the inline gate has no transcript to render into", () => {
    // PIN OF A LIMITATION, NOT AN ENDORSEMENT. `ChatStream` lives inside the
    // `view === "settings"` ternary's else-branch, and the overlay stands down
    // for an ACTIVE parent's `ask`/permission — so opening Settings while the
    // parent is active leaves that gate unrendered. This is the SAME structural
    // hole a MAIN session's own `ask` has already had since before this feature
    // (`SubagentModals`' doc records it as pre-existing and out of scope);
    // this feature only extends its reach to an active parent's child gates and
    // no further. The fix is one of two moves, both out of scope here: move
    // `ChatStream` out of the ternary, or let the overlay host the active
    // parent's cards while the workspace is unmounted. A follow-up must pick
    // one; until then this test fails LOUDLY if the hole is closed by accident
    // (so the comment above has to be deleted with it) and passes while it
    // stands.
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        { sessionId: "main1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      spaces: [{ path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      messages: { main1: [] },
    });
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    render(<App />);
    // The workspace renders it first (the parent is active)…
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    // …and the settings view is where the gate falls through both sites.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.queryByText("Which color?")).toBeNull();
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    // The gate is still PENDING (nothing answered it), and nothing in the Rust
    // side closes it either. Since ADR 0055 NOTHING times it out either: the
    // child parked on this gate holds its `tool_call_id` open, so it is an
    // **Active Subagent** and the drive's `DEFAULT_SUBAGENT_DEAD_BOUND`
    // (`src-tauri/src/agent/worker/manager.rs`) does not run at all while a
    // tool call is outstanding. The user leaving Settings is what makes the
    // card reachable again; at teardown the child's own
    // `interactive-request-close` does.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
    // Back to the workspace and the card is answerable again (no leak, no dup).
    // The exit is the pressed Settings door toggling its own view off — the page's
    // `Back` is retired, and the door is the exit this view owns.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
  });
});

describe("App (the SpaceCwdProvider that gives a transcript anchor its Space)", () => {
  // The provider's PLACEMENT is the design decision here (ADR 0051): it mounts
  // in `App`, OUTSIDE `ChatStream`, because the surfaces that External-open a
  // relative path are not all inside the chat — the subagent transcript sheet is
  // a SIBLING of the workspace view (`SubagentDetailHost`), and the gate overlay
  // is a sibling of the whole view ternary. Only `App` mounts the transcript AND
  // the sheet, so only a test in THIS file can see a provider that was moved back
  // down into `ChatStream`: the sheet's anchors would then resolve NO cwd, and
  // `external_open` refuses a relative path without one — a dead click that stays
  // green in every other file.
  // (What these two cases do NOT pin is the outermost wrap — nothing renders an
  // anchor inside `SubagentModals` yet, so the overlay half rests on the comment
  // in `App` until a consumer appears there.)
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useSubagentSelection.getState().select(null);
    useSessions.setState({
      activeSessionId: null,
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      messages: {},
    });
    vi.mocked(externalOpen).mockClear();
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  /** A live ACTIVE parent, and a child with one line of transcript each — both
   * carrying a RELATIVE link, which is the only shape that needs the cwd. */
  const seedTranscripts = () =>
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: false,
        },
      ],
      historySessions: [],
      archivedSessions: [],
      spaces: [
        { path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false },
      ],
      messages: {
        main1: [
          {
            kind: "agent-text",
            messageId: "m1",
            text: "[main.rs](src/main.rs)",
            at: 1,
          },
        ],
        sub1: [
          {
            kind: "agent-text",
            messageId: "m2",
            text: "[notes](docs/notes.md)",
            at: 1,
          },
        ],
      },
    });

  it("a transcript anchor's click External-opens with the ACTIVE Session's cwd, and navigates nothing", () => {
    seedTranscripts();
    render(<App />);
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    const a = scroll.querySelector("a")!;
    expect(a.textContent).toBe("main.rs");
    // `false` = the click was CANCELLED, i.e. the webview was never asked to
    // navigate — the bug the user reported (a link in a reply replaced the app).
    expect(fireEvent.click(a)).toBe(false);
    expect(vi.mocked(externalOpen).mock.calls).toEqual([
      ["src/main.rs", "/tmp/alpha"],
    ]);
  });

  it("an anchor in the subagent transcript SHEET gets the parent's cwd too (the provider is outside the view ternary)", () => {
    // The child's Worker runs with `cwd = parent_cwd`, so the active **Space** is
    // the right base for its transcript — but that only reaches the sheet because
    // the provider is mounted in `App` around BOTH branches of the ternary. Move
    // it into `ChatStream` and this is the first test to go red.
    seedTranscripts();
    useSubagents.getState().addSession(childEntry);
    render(<App />);
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    const sheet = screen.getByRole("dialog", { name: /transcript/ });
    const a = sheet.querySelector("a")!;
    expect(a.textContent).toBe("notes");
    expect(fireEvent.click(a)).toBe(false);
    expect(vi.mocked(externalOpen).mock.calls).toEqual([
      ["docs/notes.md", "/tmp/alpha"],
    ]);
  });
});

describe("App (the ⌘O chord reaches the dialog from the SETTINGS view)", () => {
  // The chord and the dialog are BOTH mounted at `App` root now, and the view
  // that proves it is Settings: `SpacesList` — which used to own the listener and
  // used to be the dialog's only render site — used to be unmounted there (it
  // lived in the `view === "settings"` ternary's else-branch). So this is the
  // case that cannot be satisfied by leaving either half in the workspace: move
  // the listener back into `SpacesList` and the keystroke reaches nothing; move
  // the render back into `SpacesList` and the flag flips while no dialog exists.
  //
  // SINCE THE HOIST (spec D2) the pane mounts on Settings too, so the original
  // asymmetry is gone and this case no longer DISCRIMINATES between a root mount
  // and a pane mount — it is now a straight regression test that both chords work
  // from that page. Kept for that, and not deleted with the reasoning, because
  // the chords going missing on Settings is the failure it still catches.
  //
  // The boot effect is the harness trap here: `App` calls `listSpaces()` and
  // feeds the result to `setSpaces`, which rewrites `activeSpacePath`
  // UNCONDITIONALLY (`sessions.ts` — `owner ? owner.path : rows[0]?.path ?? null`).
  // The mocked `listSpaces` resolves `[]`, so `activeSpacePath` lands on `null`
  // one macrotask after mount, whatever a `setState` seed said before `render`.
  // That is exactly the state wanted here — no Space selected is the honest
  // Settings-page state, and it is what makes `⌘N` route to the dialog too — so
  // the case leans on the landing instead of fighting it.
  it("⌘O with the Settings view open opens the dialog", async () => {
    render(<App />);
    // Let the boot effect land (`listSessions` / `listSpaces` resolve, `setSpaces`
    // rewrites `activeSpacePath`) before pressing anything.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Sessions")).toBeTruthy();
    // Open Settings the way the door test does.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    // The Session list is STILL here (spec D2 hoisted it out of the ternary) —
    // it is no longer proof of a root-mounted chord, it is proof the pane
    // survives the view switch. The chord's own work is the ⌘O below.
    expect(screen.getByText("Sessions")).toBeTruthy();
    // ⌘O targeted at `document.body` (nothing in Settings holds focus).
    expect(fireEvent.keyDown(document.body, { key: "o", ctrlKey: true })).toBe(
      false,
    );
    // The shared flag flipped AND the dialog is actually on screen — the flag
    // alone would pass with no render site, which is the bug.
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(screen.getByText("New space")).toBeTruthy();
    // Closing it through the dialog's own Cancel goes back through the flag, so
    // the root render site is not a one-way door.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getNewSpaceDialogOpen()).toBe(false);
    expect(screen.queryByText("New space")).toBeNull();
  });

  it("⌘N with the Settings view open routes to the dialog too (no Space selected)", async () => {
    // The chord calls the store command, and the store command owns the no-Space
    // routing — so the chord needs no view of its own to fall back on. With the
    // boot `listSpaces` resolving `[]` there is no Space, and `⌘N` must open the
    // dialog rather than do nothing.
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(fireEvent.keyDown(document.body, { key: "n", metaKey: true })).toBe(
      false,
    );
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(screen.getByText("New space")).toBeTruthy();
  });
});

describe("App (a failed ⌘N says why on the SETTINGS page)", () => {
  // The other half of "the chord is app-wide" (the describe above covers the
  // success path). `startSessionInActiveSpace` records a rejection in
  // `newSessionError`, and the only thing that used to read it was the sidebar's
  // `New Session` `+` button `title` — a `title` nobody can read while the page
  // covers the pane. Since the hoist (spec D2) the pane mounts on Settings too,
  // so that tooltip is reachable again; the banner stays the load-bearing answer
  // either way, because a `title` needs a hover and a pointer aimed at one small
  // button, and a chord has no button at all. A chord that works everywhere must
  // not be able to fail everywhere silently — nothing happens and nothing says
  // so. `NewSessionErrorBanner` is mounted at `App` root for the same reason the
  // chord is, so this asserts the REASON is on screen from that view.
  //
  // A Space IS selected here (unlike the chord tests above, which lean on the
  // empty boot state): with no Space the chord routes to the dialog and cannot
  // fail, and the failure is what this pins.
  //
  // The reset covers every field these two cases leave behind, and it sits in
  // this `describe` because the banner is what it tests: `useSessions` is a
  // module singleton, so a `newSessionError` (or a one-row `spaces` list) left
  // here would put a warning strip on screen inside the NEXT file's renders too.
  // Same reason the pane flags and the dialog flag are reset at file scope above.
  const clearStores = () =>
    useSessions.setState({
      newSessionError: null,
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: null,
      spaces: [],
      messages: {},
    });
  beforeEach(clearStores);
  afterEach(clearStores);

  it("a rejected start from the Settings page names the command's message on screen", async () => {
    // One Space row at boot, so `setSpaces` lands `activeSpacePath` on it and
    // the chord takes the START path rather than the dialog path.
    vi.mocked(listSpaces).mockResolvedValueOnce([
      { path: "/tmp/alpha", createdAt: 0, lastOpenedAt: 1, trusted: false },
    ]);
    // `Once`, so the factory's resolved value stands for every other test in
    // this file (there is no file-scope `clearAllMocks` here).
    vi.mocked(startSession).mockRejectedValueOnce("no such folder");
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // The Session list is still mounted here (spec D2 hoisted it out of the
    // ternary) — so this page now has TWO surfaces that can speak the failure:
    // the sidebar `+`'s `title` and the root banner. The assertion below is the
    // banner, and it is the one that stays true whatever the pane does.
    expect(screen.getByText("Sessions")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    // The store recorded it (the mechanism), and — the assertion that used to
    // fail — the user can READ it while the Settings page is up.
    expect(useSessions.getState().newSessionError).toBe("no such folder");
    // `getByTestId` rather than `getByRole("alert")`: the workspace's own
    // surfaces can carry live regions too, and this asserts WHICH node speaks.
    const banner = screen.getByTestId("new-session-error");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("no such folder");
    // No dialog opened: a Space was selected, so this was a start, not a routing
    // to the Open Space dialog.
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("the same failure is visible back in the WORKSPACE too (one surface, both views)", async () => {
    vi.mocked(listSpaces).mockResolvedValueOnce([
      { path: "/tmp/alpha", createdAt: 0, lastOpenedAt: 1, trusted: false },
    ]);
    vi.mocked(startSession).mockRejectedValueOnce("the harness could not start");
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("new-session-error").textContent).toContain(
      "the harness could not start",
    );
  });
});

describe("App (the ADR 0075 recency fetch at boot)", () => {
  // This file resets by hand-written key lists (nine of them, none importing
  // `src/test/resetStores.ts`) — the exact leak that module exists to end. This
  // describe follows the local pattern rather than starting the 9-describe
  // refactor, but its key list NAMES BOTH new maps: a map seeded by one boot
  // test otherwise survives into a later test in this file.
  const clearStore = () =>
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      activeSessionId: null,
      activeSpacePath: null,
      messages: {},
      sessionRecency: {},
      sessionOrder: {},
    });
  beforeEach(clearStore);
  afterEach(clearStore);

  it("boot fetches sessionRecency alongside listSessions and listSpaces and fills both maps before setSpaces runs", async () => {
    vi.mocked(sessionRecency).mockResolvedValueOnce([
      { sessionId: "h1", lastActiveAt: 9_000_000_000_000, sortOrder: 7 },
    ]);
    // The ORDER half of the contract, watched rather than assumed: `setSpaces`
    // runs `autoSelectActive`, which since ADR 0075 decides the Landing Session
    // from the recency map, so the map has to be filled FIRST. A `set` reports
    // no order, so the store's own notification stream is the witness: every
    // snapshot is captured with both the maps and the spaces, and the first
    // snapshot that has Spaces must ALREADY have the recency entry.
    const snapshots: Array<{
      recency: Record<string, number>;
      spaceCount: number;
    }> = [];
    const unsubscribe = useSessions.subscribe((s) => {
      snapshots.push({ recency: s.sessionRecency, spaceCount: s.spaces.length });
    });
    vi.mocked(listSpaces).mockResolvedValueOnce([
      { path: "/tmp/alpha", createdAt: 0, lastOpenedAt: 1, trusted: false },
    ]);
    render(<App />);
    // Drain the boot effect the way this file already does.
    await act(async () => {
      await Promise.resolve();
    });
    unsubscribe();
    // EXACTLY once: the ORDER map rides this same payload, so a second IPC
    // round-trip for the numbers the recency rows already carry is a regression
    // against the reason the field was put on the payload at all.
    expect(sessionRecency).toHaveBeenCalledTimes(1);
    expect(useSessions.getState().sessionRecency).toEqual({
      h1: 9_000_000_000_000,
    });
    expect(useSessions.getState().sessionOrder).toEqual({ h1: 7 });
    // The ORDER assertion: the first snapshot in which Spaces have landed must
    // ALREADY carry the recency entry. Swap the two `set` calls in `App.tsx` and
    // this is the line that goes red — `setSpaces` would have run
    // `autoSelectActive` over an empty map.
    const withSpaces = snapshots.find((s) => s.spaceCount > 0);
    expect(withSpaces?.recency).toEqual({ h1: 9_000_000_000_000 });
    // The "BEFORE `setSpaces`" half of this test's name is not assertable from
    // here — `set` does not report an order, and the consequence (boot landing
    // on the recency-decided Session) belongs to the store's own boot test in
    // `sessions.test.ts`, which drives `setSpaces` directly. What THIS file can
    // pin is that the fetch happens, once, and that both maps are filled by the
    // single payload.
  });
});

describe("App (title recovery mounted at the app root, #143)", () => {
  const clearStore = () =>
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      activeSessionId: null,
      activeSpacePath: null,
      messages: {},
      sessionRecency: {},
      sessionOrder: {},
    });
  beforeEach(clearStore);
  afterEach(clearStore);

  it("a window focus re-reads listSessions and NOTHING else (the boot trio is untouched)", async () => {
    // Mounts the REAL `App`, so this is the only place that pins the hook is
    // actually mounted — the hook's own suite proves what it does, not that
    // anything runs it. Counts are taken AFTER boot, because boot already
    // `listSessions`es once: the assertion is "focus adds exactly one read",
    // and it is the ONLY thing that distinguishes "recovery mounted" from
    // "recovery mounted and re-running the boot trio".
    useSessions.setState({
      sessions: [
        { sessionId: "s1", cwd: "/x", capabilities: {}, archived: false },
      ],
    });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    const bootReads = vi.mocked(listSessions).mock.calls.length;
    const bootRecency = vi.mocked(sessionRecency).mock.calls.length;
    const bootSpaces = vi.mocked(listSpaces).mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // Exactly one extra read, and it carries the archived-inclusive flag.
    const reads = vi.mocked(listSessions).mock.calls;
    expect(reads.length).toBe(bootReads + 1);
    expect(reads[reads.length - 1]?.[0]).toBe(true);
    // The boot trio's OTHER two calls stay put: `sessionRecency` is pinned to
    // one call by the test above, and re-running `setSpaces` would re-seed
    // `committedTrusted` and could move the selected tab.
    expect(vi.mocked(sessionRecency).mock.calls.length).toBe(bootRecency);
    expect(vi.mocked(listSpaces).mock.calls.length).toBe(bootSpaces);
  });
});

describe("App (the Task board view)", () => {
  // The third arm of the `view` union. These cases live in THIS file because the
  // claim is about `App`'s routing, not about the board's rendering (which
  // `TasksBoard.test.tsx` owns): that a `"board"` value paints the BOARD rather than
  // falling into the workspace else-branch, and that the two surfaces `App` keeps as
  // siblings of the whole ternary survive the switch.
  //
  // `useTasks` is module-global and this file never booted a board before A3, so it
  // is reset here by hand — the same reason `SidePane.test.tsx` and
  // `SettingsPage.test.tsx` hand-reset the one store `ALL_STORES` deliberately
  // excludes. `resetStores()` now covers `useTasks`, but this file calls no
  // `resetStores()` at all (it hand-writes per-test `setState` key lists), so an
  // un-reset board would survive from the case that opened it into the next.
  beforeEach(() => {
    useTasks.getState().reset();
    vi.mocked(getBoard).mockClear();
    vi.mocked(getBoard).mockResolvedValue([]);
  });

  /** Render, let the boot trio land, then give the app an ACTIVE Session.
   *
   *  WHY THE SEED IS NEEDED rather than reading as ceremony: `App` hands
   *  `TasksBoard` the SAME `spaceCwd` the `SpaceCwdProvider` uses, and that is
   *  `useActiveSpaceCwd()` — the ACTIVE SESSION's `cwd`, `null` with no active
   *  Session. This file's boot mocks resolve `[]` for Spaces and Sessions, so a bare
   *  render leaves `spaceCwd` `null`, and `TasksBoard` correctly refuses to call
   *  `get_board(null)`. Every case below that asserts a board FETCH therefore needs a
   *  live Session; the cases that do not assert a fetch use the bare render and are
   *  pinning the no-Space arm. */
  async function bootedWithActiveSession(): Promise<void> {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      useSessions.setState({
        sessions: [
          {
            sessionId: "s1",
            cwd: "/tmp/ws",
            capabilities: {},
            archived: false,
          },
        ],
        activeSessionId: "s1",
        activeSpacePath: "/tmp/ws",
      });
    });
  }

  it("the sidebar's Tasks door swaps the content area to the board (the explicit arm, not the else)", async () => {
    await bootedWithActiveSession();
    // The workspace is up first: the sidebar and the chat column.
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.queryByTestId("tasks-board")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));

    // THE PIN THE WIDENING EXISTS FOR. A widened union with NO explicit arm renders
    // the workspace for `"board"` too — the ternary's else-branch is the workspace —
    // so `tasks-board` would be absent and `Sessions` still present, with `tsc`
    // clean and every pre-existing test green.
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks", level: 1 })).toBeTruthy();
    // The chat column and the Side pane are GONE (spec §3) — the Session list
    // stays, it is permanent now (spec D2 hoisted it above the ternary, so the
    // `Sessions` heading asserted at the top of this case is still on screen).
    // …and the board loaded its own store on MOUNT, for the ACTIVE Space — the same
    // folder the `SpaceCwdProvider` was handed, so board and transcript cannot
    // disagree about which Space is showing.
    expect(getBoard).toHaveBeenCalledTimes(1);
    expect(getBoard).toHaveBeenCalledWith("/tmp/ws");
  });

  it("the Session list renders on the BOARD view (the hoisted pane, spec D2)", async () => {
    // The board is reached the way every case in this describe reaches it: the
    // sidebar's own `Tasks` door. That click still exists because the pane is
    // mounted on every view — and the pane is STILL on screen once the board is
    // up, which is the half this case pins (spec §3 lets the board replace the
    // chat column and the Side pane, not the Session list).
    await bootedWithActiveSession();
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
  });

  it("both exits of the BOARD view return to the workspace, and the sidebar never left", async () => {
    // THE PIN THIS CASE CARRIED AS `the board's Back returns to the workspace…`:
    // the board is escapable and the pane survives the round-trip. The board's
    // own `Back` is retired (N1), so the pin now rides the pressed `Tasks` door
    // and a Session row — the two exits every view has.
    await bootedWithActiveSession();
    // A Space row on top of the helper's active Session: `bootedWithActiveSession`
    // seeds the Session `TasksBoard` needs for its fetch but no **Space**, and
    // `SpacesList` renders rows from `activeView` — the Space matching
    // `activeSpacePath`. With no Space the pane shows its empty line and exit two
    // would have nothing to click (it would fail on `getByText`, not on routing).
    act(() => {
      useSessions.setState({
        spaces: [
          { path: "/tmp/ws", createdAt: 1, lastOpenedAt: 1, trusted: false },
        ],
        sessions: [
          {
            sessionId: "s1",
            cwd: "/tmp/ws",
            capabilities: {},
            archived: false,
            title: "Board session",
          },
        ],
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("tasks-board")).toBeTruthy();

    // EXIT ONE — the pressed door toggles the board off.
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    // …and not merely "the board vanished". The wording here used to lean on the
    // sidebar being RE-mounted and reading the SAME stores it was unmounted from;
    // since the hoist (spec D2) the pane never unmounted, so what this asserts is
    // the weaker-and-stronger fact: the Session list is on screen before the
    // board, during it, and after it, with no re-mount and therefore no state
    // copied and none stranded.
    expect(screen.queryByTestId("tasks-board")).toBeNull();
    expect(screen.getByText("Sessions")).toBeTruthy();

    // EXIT TWO — a Session row leaves the board too (the same wrapper the Settings
    // view takes; the board owns no exit control of its own). This is the exit a
    // reader would otherwise think is missing: the board replaces the chat column,
    // so the only surface left to click is the permanent pane.
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    fireEvent.click(screen.getByText("Board session"));
    expect(screen.queryByTestId("tasks-board")).toBeNull();
    expect(screen.getByText("Sessions")).toBeTruthy();

    // Two board reads for TWO mounts, not one per render in between: returning to
    // the workspace unmounts the board and re-opening it re-reads, and nothing
    // re-fetched on the way OUT.
    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("a card click opens the detail modal, and its chip leaves the board", async () => {
    // THE WIRING PROOF AT THE TOP. `TasksBoard.test.tsx` pins that the board calls
    // `onReturnToWorkspace`; this proves `App` actually HANDS it the view switch. A
    // board-side test cannot see that: an optional prop nobody passes is green in
    // every test file except this one, and the shipped behaviour is a click that does
    // nothing visible — which is precisely the defect issue #177 found in #174's chip.
    await bootedWithActiveSession();
    vi.mocked(getBoard).mockResolvedValue([
      {
        stage: {
          spacePath: "/tmp/ws",
          slug: "backlog",
          label: "Backlog",
          sortOrder: 0,
          onEnter: "none",
        },
        tasks: [
          {
            task: {
              id: "tsk_x",
              spacePath: "/tmp/ws",
              number: 4,
              title: "Open me",
              body: null,
              specPath: null,
              stageSlug: "backlog",
              sortOrder: 0,
              createdAt: 1,
              updatedAt: 1,
            },
            sessions: [
              { taskId: "tsk_x", sessionId: "s1", stageSlug: "backlog" },
            ],
            costUsd: 0.25,
          },
        ],
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    // Await the board's own mount fetch: `TasksBoard` loads on mount rather than at
    // boot, so the first frame after the door click is the spinner and there is no
    // card to click yet.
    await waitFor(() => expect(screen.getByText("Open me")).toBeTruthy());

    fireEvent.click(screen.getByText("Open me"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The dialog is a SIBLING of the board inside this arm, not a portal outside
    // `App`: closing it must return to the board and not to the workspace.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("tasks-board")).toBeTruthy();

    // The chip: open the Session AND leave the board, in one click.
    fireEvent.click(screen.getByText("1 session · $0.25"));
    await waitFor(() => expect(screen.queryByTestId("tasks-board")).toBeNull());
    expect(screen.getByText("Sessions")).toBeTruthy();
  });

  it("the board's New task modal creates the Task and its Session through the real App tree", async () => {
    // The ONE case that proves the two boot mocks above are load-bearing rather
    // than decorative: it walks `App` → the `"board"` arm → `TasksBoard`'s
    // affordance → `NewTaskDialog`'s composer → send. With `startTaskSession`
    // un-mocked this case does not fail loudly — `createTask` resolves, the
    // start rejects against the real `invoke`, and the assertion below would be
    // reading the modal's error line. That is AGENTS.md's trap in its exact
    // shape, which is why the mock and this case land in the same commit.
    // A board WITH columns. The file's default `getBoard` resolves `[]`, and the
    // modal correctly refuses to file a Task when the board has no first stage —
    // so leaving the default here would assert the refusal path, not the send.
    vi.mocked(getBoard).mockResolvedValue([
      {
        stage: {
          spacePath: "/tmp/ws",
          slug: "backlog",
          label: "Backlog",
          sortOrder: 0,
          onEnter: "none",
        },
        tasks: [],
      },
    ]);
    await bootedWithActiveSession();
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    const island = await screen.findByTestId("composer-island");
    const textarea = island.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Fix the parser" } });
    fireEvent.click(within(island).getByRole("button", { name: "Send" }));

    // `waitFor` rather than a counted number of microtask drains: the send chain
    // here is createTask → startTaskSession → addSession → expand → sendPrompt, so
    // the tick count is an implementation detail of the chain and a hardcoded
    // count would break on an unrelated refactor instead of on a real regression.
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    // Task first, then the Session linked to it — the order ADR 0090's missing FK
    // forces, across the REAL component tree rather than a direct mount.
    expect(createTask).toHaveBeenCalledWith(
      "/tmp/ws",
      "Fix the parser",
      undefined,
      "backlog",
    );
    expect(startTaskSession).toHaveBeenCalledWith("/tmp/ws", "tsk_new", "backlog");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    // The started Session is a sidebar row (spec §3: closing the modal leaves a
    // card AND a row) — `addSession` upserted it, and the row list is what the
    // sidebar renders when the board closes.
    expect(useSessions.getState().sessions.map((s) => s.sessionId)).toContain(
      "new1",
    );
  });

  it("a child's pending `ask` stays answerable over the BOARD view (the overlay is a sibling of the ternary)", async () => {
    // The overlay's CARD half renders for a child whose parent is not the active
    // session, and the host is a SIBLING of the whole ternary — so it survives the
    // board unmounting the workspace, exactly as it survives Settings. This is the
    // case that would strand a child if the board arm had moved the host inside
    // itself.
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    await bootedWithActiveSession();
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    // The gate is reachable and its control is PRESENT over the board — the same
    // claim the Settings-view sibling case makes, and the claim that breaks if the
    // host is ever moved inside the board arm (or into the else-branch it replaced).
    // Not asserted through a real answer: submitting goes
    // `AskQuestionCard` → `respondInteractiveRequest`, an IPC this file does not
    // mock, so a click here would be pinning a jsdom rejection.
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    // The request is still in the store: the view switch neither answered it nor
    // silently dropped it.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);

    useSubagents.getState().dismiss("sub1");
    useInteractive.getState().dismissSession("sub1");
  });

  it("the gate panel does NOT dodge a sheet the board view unmounted (sheetMounted is view === workspace)", async () => {
    // THE GEOMETRY PIN, and the reason `sheetMounted` stays `view === "workspace"`.
    // `SubagentDetailHost` — the sheet's ONLY render site — lives in the ternary's
    // else-branch, so the board arm unmounts it just as Settings does. The prop's
    // meaning is therefore "the SHEET is mounted", and for `"board"` that is FALSE.
    //
    // Writing `view !== "settings"` (the plan's item 3) would report `true` here
    // while no sheet is painted, and `SubagentModals` would slide its panel 480px
    // left and cap its width for a sheet that does not exist — the exact phantom
    // dodge the prop was introduced to stop, reintroduced on a new view. So the
    // widening changes NOTHING here, and this test is the measurement that says so.
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    // A selection that HAS an entry: the one state where the dodge can fire at all,
    // so the prop is the only thing left deciding.
    useSubagentSelection.getState().select("sub1");
    await bootedWithActiveSession();
    const overlay = () => screen.getByTestId("subagent-gate-overlay");
    const dodgeTokens = (el: HTMLElement) =>
      [...el.classList].filter(
        (c) => /right-\[/.test(c) || c.includes("calc(100vw-"),
      );

    // The workspace: the sheet IS mounted, so the panel dodges it.
    expect(dodgeTokens(overlay())).not.toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    // The board: the sheet is GONE, so the dodge must go with it.
    expect(dodgeTokens(overlay())).toEqual([]);
    expect([...overlay().classList]).toContain("right-0");
    // And the gate is still on screen — the view change moved the PANEL, not the
    // card, so no child is stranded by the board arm.
    expect(screen.getByText("Which color?")).toBeTruthy();

    useSubagentSelection.getState().select(null);
    useSubagents.getState().dismiss("sub1");
    useInteractive.getState().dismissSession("sub1");
  });

  it("the board view keeps the chrome bar's tabs and window controls (only Settings drops them)", async () => {
    // Ternary #1 is deliberately UNCHANGED by the widening: `"board"` falls into the
    // non-settings branch and keeps the tab strip, which is the desired behaviour
    // (the tabs are the Space switcher, and the board is per-Space).
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("chrome-bar")).toBeTruthy();
    // The tabs are still on screen next to the board — the bar holds the tabs and
    // the window controls and nothing else, so leaving the tabs up is how you
    // board-hop. What this assertion now pins is the OTHER half: the board view
    // still has a Settings DOOR, in the Session list's command strip (the chrome
    // bar has held no app control since `ChromeControls` was retired). A board
    // with no way back to Settings would be a dead end, so the door being present
    // on every view is worth pinning.
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
  });

  it("the Open Space dialog still opens while the board is up (still a sibling of the ternary)", async () => {
    // `NewSpaceDialog` must NOT be moved into the workspace arm as part of adding a
    // third arm — the same raiseable-but-invisible defect its comment records. ⌘O is
    // mounted at `App` root, so it has to reach the dialog from the board too.
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(fireEvent.keyDown(document.body, { key: "o", ctrlKey: true })).toBe(false);
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(screen.getByText("New space")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("the board renders for a Space with no stages without calling any write command", async () => {
    // `getBoard` resolves `[]` (the mock's default): the board shows its empty line
    // and writes NOTHING. `createTask`/`editTask`/`moveTask`/`reorderTasks`/
    // `linkSession` are mocked for the cases above; naming them here is what makes
    // "opening a board has no write side effect beyond the lazy stage seed" a checked
    // claim rather than an assumed one.
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    expect(createTask).not.toHaveBeenCalled();
    expect(editTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(reorderTasks).not.toHaveBeenCalled();
    expect(linkSession).not.toHaveBeenCalled();
  });
});
