import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SidePane from "./SidePane";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { useSessions } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { useModelCatalog } from "../store/modelCatalog";
import { useSettings } from "../store/settings";
import type { ModelDto } from "../lib/tauri";
import { loadHistory, setSessionConfigOption } from "../lib/tauri";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    // The pane's config block WRITES through this (the model picker's `onSet`):
    // un-mocked, the real export reaches `invoke` and rejects on jsdom's missing
    // `window.__TAURI_INTERNALS__`, so the write-path test would be pinning a
    // rejection instead of the call. Resolves to a fresh option list (what the
    // command returns) so `applyConfigOptions` has something to apply.
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    loadHistory: vi
      .fn()
      .mockResolvedValue({ rows: [], hasMore: false, todos: null }),
  };
});

beforeAll(() => {
  // jsdom has no pointer capture: stub it (the component guards the ELEMENT
  // with `?.`, not the method).
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
});

beforeEach(() => {
  localStorage.clear();
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  usePermissions.getState().dismissSessionPrompts("sub1");
  usePermissions.getState().dismissSessionPrompts("main1");
  useInteractive.getState().dismissSession("sub1");
  useInteractive.getState().dismissSession("main1");
  // A SECOND session (`main2`) and its own child (`sub2`): left seeded they
  // would change the board set the NEXT case derives. No case here seeds them
  // any more — the session-switch cases that did are gone with the auto-open
  // effect — but the dismissal stays: it costs nothing, and a case that ever
  // seeds a second session again cannot leak its board into the next.
  useInteractive.getState().dismissSession("main2");
  useInteractive.getState().dismissSession("sub2");
  // The WHOLE session slice, not just `messages`: the relocated config-block
  // cases (Model / Reasoning / Context, ported from `ChatStream.test.tsx`) seed
  // `sessions` / `historySessions` / `configOptions` / `contextUsage`, and the
  // pane reads all of them for that block. Left seeded, a config case would leak
  // a live session into the pane's own cases — which read the store for the
  // title, the boards AND (now) the config block.
  vi.mocked(setSessionConfigOption).mockClear();
  vi.mocked(loadHistory).mockClear();
  useSessions.setState({
    messages: {},
    activeSessionId: null,
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    spaces: [],
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
    contextUsage: {},
    compacting: {},
  });
  // The block now derives the Model picker's rows from the CATALOG store (issue
  // #154). This file's `beforeEach` did not reset it — the catalog store is NOT
  // in `src/test/resetStores.ts`'s `ALL_STORES` — so without this a case's seed
  // would leak into the NEXT case (a model row appearing in a picker that should
  // show none). Seed it EMPTY and LOADED: `loadedOk: true` means any plain
  // `loadModels()` path early-returns instead of reaching the (un-mocked here)
  // `listModels` IPC, so a no-op refresh cannot hide behind a freshly-reset store.
  useModelCatalog.setState({ models: [], loadStarted: true, loadedOk: true });
  // Same for the settings store: the block reads `settings.providers` for the
  // configured-provider filter, and this file never loaded settings. `null` =
  // "not loaded" (the picker then shows raw provider keys and filters nothing
  // configured, so an unseeded case renders NO catalog rows).
  useSettings.setState({ settings: null } as never);
});

/**
 * A catalog row (the `ModelDto` shape `list_models` returns) — the seed the
 * block's Model picker now reads its rows from. `provider` is the RAW provider
 * key (the display cue comes from `settings.providers`).
 */
function catalogModel(
  id: string,
  provider = "tama",
  selectable = true,
  supportsTools = true,
): ModelDto {
  return {
    id,
    provider,
    contextWindow: 128000,
    supportsThinking: false,
    thinkingLevels: [],
    supportsTools,
    selectable,
  };
}

/**
 * Seed a LIVE session (the shape `ChatStream.test.tsx`'s `seedLiveSession`
 * used — these config-block cases came from that file). `id` stays `s1` so the
 * ported fixtures could move verbatim.
 */
function seedLiveSession(): void {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [
      { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
    ],
    spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
    historySessions: [],
    messages: { s1: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
    contextUsage: {},
  });
}

/**
 * Seed a STORED (non-live) session: `sessions` is empty, the session lives in
 * `historySessions`, so the pane's block has no LIVE row for it. Since #154 that
 * changes NOTHING about the selectors — they are populated AND enabled (the
 * backend persists a stored session's change without a Worker); the only control
 * a stored session with no `configOptions` shows is the disabled Model stub, and
 * that is because it has no data, not because the session is stored.
 */
function seedStoredSession(capabilities: Record<string, unknown> = {}): void {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [],
    spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
    historySessions: [
      { sessionId: "s1", cwd: "/home/u/proj", capabilities, archived: false },
    ],
    messages: { s1: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
    contextUsage: {},
  });
}

describe("SidePane (the status panel)", () => {
  it("renders NO TODO section when there are no todos (the config block is always there)", () => {
    const { container } = render(<SidePane />);
    // The todo section is data-gated (the ZCode `canRender*` treatment): an
    // empty board is no section at all — no "No todos yet" placeholder.
    expect(screen.queryByText("Todos")).toBeNull();
    // What the frame DOES hold, always: the config block; its Model line and
    // context bar are not data-gated, so with no active session it renders the
    // Model stub DISABLED and an empty 0% track — the same treatment a closed
    // session gets (the pane cannot know a config it does not have, but a model
    // selector is meaningful for any session). The REASONING line is the
    // exception: it renders only when the session's options carry a
    // `thought_level` select, so with no session there is NO thinking control
    // of any role and no `○` off-level glyph. The pane's frame is therefore
    // never empty text-wise; only its TODO content is.
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block).toBeTruthy();
    expect((screen.getByRole("button", { name: "Model" }) as HTMLButtonElement).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Thinking" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
    const bar = block.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(block.querySelector('[data-testid="context-usage"]')).toBeNull();
    // And nothing else: the frame's text is exactly the block's ONE stub label
    // (no todo copy hiding behind them). Read on `container` rather than on the
    // block, so a stray label elsewhere in the frame would show up here — the
    // pane holds no control of its own (the pane toggles are retired) and with
    // no session there are no boards, so the todo section contributes no text
    // either. The `○` off-level glyph is ABSENT by construction now: the
    // thinking stub is never manufactured, so this string is the proof the
    // Reasoning line is gone as a DOM node and not merely empty.
    expect(container.textContent).toBe("Model");
  });

  it("shows the session title (the first user message, truncated to 80 chars) at the top of the pane", () => {
    // The old chat header's title moved here (the header is gone): the
    // first `user` message, truncated to ~80 chars (the SAME derivation
    // the sidebar rows use).
    const long = "x".repeat(120);
    useSessions.setState({
      activeSessionId: "main1",
      messages: {
        main1: [{ kind: "user", text: long, at: Date.now() }],
      },
    });
    render(<SidePane />);
    const title = screen.getByText(long.slice(0, 80));
    expect(title).toBeTruthy();
    // The title sits ABOVE the Todos section (the pane's top section).
    const todos = screen.queryByText("Todos");
    expect(todos).toBeNull(); // no todos — but the title still renders
    // (the title is NOT data-gated on todos).
  });

  it("falls back to the Space's base name when the session has no user message yet", () => {
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: false,
        },
      ],
      messages: {},
    });
    render(<SidePane />);
    // No `user` message → the title is the active session's cwd's base
    // name (a session whose cwd is no known Space still shows its
    // folder's base name).
    expect(screen.getByText("MyProject")).toBeTruthy();
  });

  it("shows the GENERATED title in place of the message truncation (a titled session is labelled by its title)", () => {
    // The naming pass writes a real title; the pane must show IT, not the
    // first prompt's first 80 chars. The message is deliberately longer
    // and completely different, so the assertion cannot pass by accident.
    const longPrompt =
      "Please implement the session naming port across the store, the sidebar and the header, with tests for every case";
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: false,
          title: "Porting the session namer",
        },
      ],
      messages: {
        main1: [{ kind: "user", text: longPrompt, at: Date.now() }],
      },
    });
    render(<SidePane />);
    expect(screen.getByText("Porting the session namer")).toBeTruthy();
    expect(screen.queryByText(longPrompt.slice(0, 80))).toBeNull();
  });

  it("reads the stored title from the ARCHIVED membership (the title lookup walks all three session lists)", () => {
    // A session opened from the Archived section has no `sessions` entry;
    // its title is read off `archivedSessions` exactly as its `cwd` is.
    useSessions.setState({
      activeSessionId: "arch1",
      sessions: [],
      historySessions: [],
      archivedSessions: [
        {
          sessionId: "arch1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: true,
          title: "A titled archived session",
        },
      ],
      messages: {
        arch1: [{ kind: "user", text: "Archive the logs", at: Date.now() }],
      },
    });
    render(<SidePane />);
    expect(screen.getByText("A titled archived session")).toBeTruthy();
    expect(screen.queryByText("Archive the logs")).toBeNull();
  });

  it("still truncates the first user message when the session's title is explicitly null", () => {
    // `title: null` is the shape the backend writes before the naming pass
    // (and when naming is off) — the OLD derivation must survive it
    // untouched, or every untitled session loses its label.
    const prompt = "Refactor the parser so the grammar is table-driven";
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: false,
          title: null,
        },
      ],
      messages: { main1: [{ kind: "user", text: prompt, at: Date.now() }] },
    });
    render(<SidePane />);
    expect(screen.getByText(prompt)).toBeTruthy();
  });

  it("renders the Todos section (label + N/M + progress) when there are open todos", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "completed" },
      ],
    });
    const { container } = render(<SidePane />);
    // The section label + the open-count derivation (1 of 2 open).
    expect(screen.getByText("Todos")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).not.toBeNull();
  });

  it("hides the Todos section when all todos are completed", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
      ],
    });
    render(<SidePane />);
    expect(screen.queryByText("Todos")).toBeNull();
    expect(screen.queryByText("1/2")).toBeNull();
  });

  // -- The pane holds NO collapse control. The pane toggles are retired (the chrome
  // -- bar now holds the tabs and the window controls and nothing else, pinned by
  // -- `App.test.tsx`'s `the chrome bar holds NO pane toggle and NO app-control
  // -- cluster`). What used to be asserted here — the toggle's corner, its inset
  // -- from the 4px resize handle, the frame's sliver width while collapsed —
  // -- goes with the collapse. The pane's own controls are exactly the resize
  // -- handle. --

  it("the frame renders at the dragged width and holds no collapse control", () => {
    // ORDER-INDEPENDENCE NOTE: `320px` is `DEFAULT_WIDTH`, and this assertion is
    // stable ONLY because the `beforeEach` keeps calling `localStorage.clear()`
    // — `initialWidth()` reads `WIDTH_KEY` ("side-pane-width"), which the drag
    // cases above write. Drop that clear and this case starts depending on file
    // order.
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe("320px");
    // The retired toggle stays retired: absent by its old STABLE hook (its label
    // flipped with a state that no longer exists, so the hook is the query), and
    // absent from the whole document, not merely this frame.
    expect(container.querySelector('[data-testid="right-pane-toggle"]')).toBeNull();
    expect(screen.queryByTestId("right-pane-toggle")).toBeNull();
    // Every label this pane's toggle ever carried, so a rename cannot quietly
    // re-add the control here and leave the hook query vacuous.
    for (const label of ["Collapse side pane", "Expand side pane"]) {
      expect(screen.queryByRole("button", { name: label }), label).toBeNull();
    }
    // And the pane's ONE control is the drag handle, rendered unconditionally.
    expect(container.querySelector(".cursor-col-resize")).toBeTruthy();
  });

  it("flushes the drag width to localStorage on mouseup only (not on every mousemove)", () => {
    const { container } = render(<SidePane />);
    const handle = container.querySelector(".cursor-col-resize") as HTMLElement;
    const line = handle.querySelector("div") as HTMLElement;
    // `pointerdown` (the event carrying `pointerId` — `mousedown` does not
    // in the DOM) starts the drag and captures the pointer.
    fireEvent.pointerDown(handle);
    // Dragging: the line is visible (the class ends with `opacity-100`;
    // the non-drag class ends with `hover:opacity-100` — anchor at the end).
    expect(line.className).toMatch(/ opacity-100$/);
    fireEvent.mouseMove(window, { clientX: 300 });
    // The live width updates (320 - 300 clamped to the 240 min) but
    // localStorage is NOT written mid-drag.
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe("240px");
    expect(localStorage.getItem("side-pane-width")).toBeNull();
    // The release (captured: delivered to the handle even outside the
    // webview) flushes the width ONCE and ends the drag.
    fireEvent.pointerUp(handle);
    expect(localStorage.getItem("side-pane-width")).toBe("240");
    expect(line.className).not.toMatch(/ opacity-100$/);
  });

  it("still ends the drag and flushes the width when releasePointerCapture throws", () => {
    const { container } = render(<SidePane />);
    const handle = container.querySelector(".cursor-col-resize") as HTMLElement;
    const line = handle.querySelector("div") as HTMLElement;
    // An expired `pointerId` / non-compliant webview: `releasePointerCapture`
    // throws — the drag must still end (the width must still flush; `dragging`
    // must NOT stick on).
    const release = vi
      .spyOn(handle, "releasePointerCapture")
      .mockImplementation(() => {
        throw new Error("InvalidPointerId");
      });
    try {
      fireEvent.pointerDown(handle);
      expect(line.className).toMatch(/ opacity-100$/);
      fireEvent.mouseMove(window, { clientX: 300 });
      fireEvent.pointerUp(handle);
      expect(line.className).not.toMatch(/ opacity-100$/);
      expect(localStorage.getItem("side-pane-width")).toBe("240");
    } finally {
      release.mockRestore();
    }
  });

  it("ends the drag on window blur (a release outside the webview)", () => {
    const { container } = render(<SidePane />);
    const handle = container.querySelector(".cursor-col-resize") as HTMLElement;
    const line = handle.querySelector("div") as HTMLElement;
    fireEvent.pointerDown(handle);
    expect(line.className).toMatch(/ opacity-100$/);
    fireEvent.mouseMove(window, { clientX: 300 });
    // The pointer is lost (released outside the webview): `blur` must end
    // the drag (it does NOT leave `dragging` stuck on).
    fireEvent.blur(window);
    expect(line.className).not.toMatch(/ opacity-100$/);
    expect(localStorage.getItem("side-pane-width")).toBe("240");
  });

  // ===========================================================================
  // THE CONFIG BLOCK (Model / Reasoning / Context) — the Model / Reasoning /
  // Context lines that left the composer's bottom row and now sit pinned at the
  // bottom of this pane. Reasoning is the one the block GATES: it renders only
  // when the model has levels (see `SessionConfigBlock`).
  //
  // These cases were ported from `ChatStream.test.tsx` when the surface moved;
  // only the render target and the container they query changed. Read them as
  // the block's contract, not as history: the composer no longer hosts ANY of
  // these controls (pinned by the "composer no longer hosts" cases there).
  //
  // The behaviour the move had to preserve, all of it previously living in
  // `ChatStream`'s derivations and now in `src/lib/sessionConfig.ts`:
  //   - the four-way fallback for BOTH config options and context usage (the
  //     live map → `sessions` → `historySessions` → `archivedSessions`),
  //   - the selectors are ENABLED for a stored session (the backend persists the
  //     change without a Worker, #154) and disabled only while a set request is
  //     in flight; the `null`-option Model stub stays disabled (no data, no
  //     persist path),
  //   - the Model picker's rows come from the live `useModelCatalog` store
  //     filtered to the configured providers, NOT from the session's snapshot,
  //   - the traffic-light ramp (success < 50, caution < 70, warning < 90,
  //     destructive from 90).
  // ===========================================================================

  it("renders the config block for a closed (history-only) session (the Model stub + the empty track — there is no `isLive` gate on rendering)", () => {
    seedStoredSession();
    const { container } = render(<SidePane />);
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block).toBeTruthy();
    // The context bar renders (an empty 0% track — the session's context is
    // dropped on close and re-emits on resume; the label waits for data).
    const bar = block.querySelector(
      '[data-testid="context-usage-bar"]',
    ) as HTMLElement;
    expect(bar).toBeTruthy();
    const progress = bar.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(progress.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.querySelector('[data-testid="context-usage"]')).toBeNull();
    // The model select renders as a DISABLED stub (the config options are
    // dropped on close — no data to show; the identity stays). Thinking has no
    // stub at all: with nothing to select there is no line (see
    // `SessionConfigBlock`), so a closed session shows the Model line and the
    // empty track only.
    const model = block.querySelector('[aria-label="Model"]') as HTMLElement;
    expect(model).toBeTruthy();
    expect(model.hasAttribute("disabled")).toBe(true);
    expect(block.querySelector('[aria-label="Thinking"]')).toBeNull();
  });

  it("a live session WITH a model + thinking config option renders BOTH selects IN THE PANE (the composer carries neither)", async () => {
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [
              { value: "acme/alpha", name: "acme/Alpha" },
              { value: "acme/beta", name: "acme/Beta" },
            ],
          },
          {
            id: "thought_level",
            name: "Thinking",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
            ],
          },
        ],
      },
    });
    const { container } = render(<SidePane />);
    // The pane's block carries the model/thought controls (it used to be the
    // composer's toolbar — left of the send button).
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block.querySelector('[aria-label="Model"]')).toBeTruthy();
    expect(block.querySelector('[aria-label="Thinking"]')).toBeTruthy();
    // The model trigger shows the BARE id + the provider suffix (the
    // composed `provider/id` key is the VALUE, not the display text).
    expect(screen.getByText(/alpha/)).toBeTruthy();
    expect(screen.getByText("Medium")).toBeTruthy();
  });

  it("stacks the three lines ONE PER LINE in the order Model → Reasoning → Context (they are no longer a side-by-side cluster)", () => {
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [{ value: "acme/alpha", name: "acme/Alpha" }],
          },
          {
            id: "thought_level",
            name: "Thinking",
            type: "select",
            currentValue: "medium",
            options: [{ value: "medium", name: "Medium" }],
          },
        ],
      },
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<SidePane />);
    // The old composer premise was ONE tight cluster: both triggers inside one
    // wrapper whose `gap-1` was tighter than the `gap-2` separating the cluster
    // from Send. That premise died with the move — the pane is 240–480px wide
    // and stacks, so the contract is now ORDER and ONE CONTROL PER LINE.
    const lines = Array.from(
      container.querySelectorAll('[data-testid="session-config-controls"] > div'),
    ) as HTMLElement[];
    expect(lines).toHaveLength(3);
    // One control per line (a line holding two is the old cluster back again),
    // in the stated order.
    expect(lines[0]!.querySelector('[aria-label="Model"]')).toBeTruthy();
    expect(lines[0]!.querySelector('[aria-label="Thinking"]')).toBeNull();
    expect(lines[1]!.querySelector('[aria-label="Thinking"]')).toBeTruthy();
    expect(lines[1]!.querySelector('[aria-label="Model"]')).toBeNull();
    expect(lines[2]!.getAttribute("data-testid")).toBe("context-usage-bar");
    // And each line is FULL WIDTH (`w-full` on the trigger, `flex-1` on the
    // bar's track) rather than hugging its text.
    expect(
      (lines[0]!.querySelector('[aria-label="Model"]') as HTMLElement).className,
    ).toContain("w-full");
    expect(
      (lines[1]!.querySelector('[aria-label="Thinking"]') as HTMLElement).className,
    ).toContain("w-full");
    // The vertical stack (`flex-col`) is what makes them lines rather than a row.
    const group = container.querySelector(
      '[data-testid="session-config-controls"]',
    ) as HTMLElement;
    expect(group.className).toContain("flex-col");
  });

  // --- The context bar (the dynamic percentage — a progress bar with the
  // reference UI's `🧠 [====bar====] 61%` look). ---

  it("renders a dynamic context bar in the pane when the usage is known", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<SidePane />);
    // 53760 / 128000 = 42% — inside the pane's block (NOT the composer).
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    const group = block.querySelector(
      '[data-testid="context-usage-bar"]',
    ) as HTMLElement | null;
    expect(group).toBeTruthy();
    const bar = group!.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement | null;
    expect(bar).toBeTruthy();
    expect(bar!.getAttribute("aria-valuemin")).toBe("0");
    expect(bar!.getAttribute("aria-valuemax")).toBe("100");
    expect(bar!.getAttribute("aria-valuenow")).toBe("42");
    // The fill's width follows the percentage, and 42% (< 50%) is the
    // green band (the label follows the fill's color).
    const fill = bar!.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("42%");
    expect(fill.className).toContain("bg-success");
    expect(fill.className).not.toContain("bg-caution");
    // The label sits at the bar's right edge (the reference UI's `61%`).
    const labelEl = group!.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(labelEl.textContent).toBe("42%");
    expect(labelEl.className).toContain("text-success");
    // The brain icon cues the bar (the reference UI's `🧠` placement).
    expect(group!.querySelector('[data-testid="context-bar-icon"]')).toBeTruthy();
  });

  it("the Context line rides the pane's own plane — no well, no box", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<SidePane />);
    // The bar briefly lived in a `bg-input` WELL (it read as a sunken slot
    // inside the pane and the user asked for it gone — see the component
    // note). What must survive: the track's own token class on the fill, and
    // NO surface class on the row. Pinned as class assertions because jsdom
    // runs no layout; the contrast ratios live in the CSS gates, which now
    // grade against `--color-inspector` — the surface these pixels land on.
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    const row = block.querySelector(
      '[data-testid="context-usage-bar"]',
    ) as HTMLElement;
    expect(row.className).not.toContain("bg-");
    const bar = row.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.className).toContain("bg-context-track");
  });

  // The token counts are HOVER-ONLY on the number (the bar row is dense —
  // `53,760 / 128,000 tokens` inline would push the model selector off the
  // row, and the native `title` tooltip is unstyled and ~1s slow).
  it("the context number reveals the token counts on hover, not inline", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    render(<SidePane />);
    const label = screen.getByTestId("context-usage");
    // The inline text stays the bare percentage.
    expect(label.textContent).toBe("42%");
    // No native tooltip (the styled Radix one replaces it).
    expect(label.getAttribute("title")).toBeNull();
    // CLOSED until hover — the counts are not in the DOM at rest.
    expect(document.body.textContent).not.toContain("53,760");
    // Radix `TooltipTrigger` opens on pointer/focus (see the
    // `ToolCallCard` failure-tooltip test — `mouseEnter` does not fire it
    // in this Radix version; `focus` does; `TooltipProvider`'s
    // `delayDuration = 0` mounts the portal synchronously).
    fireEvent.focus(label);
    expect(document.body.textContent).toContain("53,760 / 128,000 tokens");
  });

  // The counts are keyboard-accessible: the tooltip trigger is a focusable
  // control (a Tab stop) whose accessible name carries the token counts,
  // and the progressbar exposes them as its text alternative — so nothing
  // about the context is hover-only.
  it("the context counts are reachable by keyboard, not hover alone", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    render(<SidePane />);
    const label = screen.getByTestId("context-usage");
    // A real control in the tab order (a bare `<span>` was not).
    expect(label.tagName).toBe("BUTTON");
    expect(label.getAttribute("tabindex")).not.toBe("-1");
    // The accessible name carries the counts (a screen reader hears them
    // without opening the tooltip).
    expect(label.getAttribute("aria-label")).toBe(
      "Context used: 53,760 of 128,000 tokens (42%)",
    );
    // The progressbar's text alternative carries them too.
    const bar = screen
      .getByTestId("context-usage-bar")
      .querySelector('[role="progressbar"][aria-label="Context used"]') as HTMLElement;
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "53,760 of 128,000 tokens (42%)",
    );
    // And focus (keyboard) opens the tooltip, as hover does.
    fireEvent.focus(label);
    expect(document.body.textContent).toContain("53,760 / 128,000 tokens");
  });

  it("a caution-band context percentage (50–69%) renders the fill in caution", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 78080, window: 128000 } },
    });
    render(<SidePane />);
    const group = screen.getByTestId("context-usage-bar");
    const bar = group.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("61");
    // 61% is the caution band (50–69%): caution (NOT green, NOT warning),
    // and the label follows the fill's color.
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-caution");
    expect(fill.className).not.toContain("bg-success");
    expect(fill.className).not.toContain("bg-warning");
    const label = group.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(label.textContent).toBe("61%");
    expect(label.className).toContain("text-caution");
  });

  it("a mid context percentage (70–89%) escalates the fill to the warning color", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 96000, window: 128000 } },
    });
    render(<SidePane />);
    const group = screen.getByTestId("context-usage-bar");
    const bar = group.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
    // 75% is the warning band (70–89%): warning (NOT caution, NOT red),
    // and the label follows the fill's color.
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-warning");
    expect(fill.className).not.toContain("bg-caution");
    expect(fill.className).not.toContain("bg-destructive");
    const label = group.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(label.textContent).toBe("75%");
    expect(label.className).toContain("text-warning");
  });

  it("a high context percentage (>= 90%) escalates the fill to the destructive color", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 115200, window: 128000 } },
    });
    render(<SidePane />);
    const group = screen.getByTestId("context-usage-bar");
    const bar = group.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("90");
    // 90% is the red band (90–100%): the destructive red (the label
    // follows the fill's color).
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-destructive");
    expect(fill.className).not.toContain("bg-warning");
    const label = group.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(label.textContent).toBe("90%");
    expect(label.className).toContain("text-destructive");
  });

  it("renders an empty context bar (no label) when the usage is unknown", () => {
    seedLiveSession();
    useSessions.setState({ contextUsage: {} });
    render(<SidePane />);
    // The bar renders from the start (layout stability — the fill appears
    // as the session grows) but the label waits for the first frame.
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("0%");
    expect(bar.querySelector('[data-testid="context-usage"]')).toBeNull();
  });

  it("renders the context bar for a stored session as an empty 0% track (the context is dropped on close and re-emits on resume)", () => {
    seedStoredSession();
    render(<SidePane />);
    // The bar is ALWAYS rendered (there is no `isLive` gate on rendering): a
    // stored session's context is dropped on close — the track is the empty 0%
    // fill (the label waits for the resume to re-emit the usage).
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(screen.queryByTestId("context-usage")).toBeNull();
  });

  it("renders the block POPULATED for a stored session (config options + context usage from the session row — the selectors are ENABLED)", () => {
    // The Model picker's rows now come from the CATALOG store filtered to the
    // configured providers (#154), so this case seeds both: the row for `m1` and
    // the provider it belongs to (display name deliberately LOWERCASE `tama`, so
    // the trigger reads `m1 · tama` — the same string the assertion below pins).
    useModelCatalog.setState({
      models: [catalogModel("m1")],
      loadStarted: true,
      loadedOk: true,
    });
    useSettings.setState({
      settings: { providers: [{ id: "tama", name: "tama" }] },
    } as never);
    // The `list_sessions` shape: the row carries `configOptions` (the
    // stored `model` / `thinkingLevel` synthesized) + `contextUsage` (the
    // last known usage — persisted on every `context_usage_update` frame).
    useSessions.setState({
      activeSessionId: "s1",
      sessions: [],
      spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/home/u/proj",
          capabilities: { loadSession: true },
          archived: false,
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "tama/m1",
              options: [{ value: "tama/m1", name: "m1" }],
            },
            {
              id: "thought_level",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "High" }],
            },
          ],
          contextUsage: { used: 53760, window: 128000 },
        },
      ],
      messages: { s1: [] },
      inTurn: {},
      stopReasons: {},
      closeReasons: {},
      configOptions: {},
      contextUsage: {},
    });
    render(<SidePane />);
    // The context bar is FILLED from the row's usage (53760 / 128000 ≈
    // 42% — the green band).
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByTestId("context-usage").textContent).toBe("42%");
    // The model selector is POPULATED with the stored model's name and it is
    // ENABLED: a stored session has no agent process, but the backend persists
    // the change and returns the re-synthesized options without a Worker, so the
    // selector is no longer read-only (issue #154 flipped the old
    // `disabled={!isLive}` gate away).
    const model = screen.getByRole("button", { name: "Model" });
    expect(model.hasAttribute("disabled")).toBe(false);
    expect(model.textContent).toContain("m1 · tama");
    // The thinking selector is POPULATED with the stored level + enabled too.
    const thinking = screen.getByRole("combobox");
    expect(thinking.hasAttribute("disabled")).toBe(false);
    expect(thinking.textContent).toContain("High");
  });

  it("a stored session's live config options win over the row's (the store's map is fresher — the last frame before the close)", () => {
    // The store's map has a FRESHER value (the session was live in this
    // app session, closed, and the store kept its last known config — the
    // `handleSessionClosed` no longer drops it); the row's value is the
    // DB's (persisted on the same frame — same value, but the store's
    // map is the primary source).
    seedStoredSession();
    // The picker's rows come from the CATALOG (#154): seed the `m2` row (the
    // value the store's map carries) + its provider, or the trigger would fall
    // back to the raw composed value with no provider cue.
    useModelCatalog.setState({
      models: [catalogModel("m2")],
      loadStarted: true,
      loadedOk: true,
    });
    useSettings.setState({
      settings: { providers: [{ id: "tama", name: "tama" }] },
    } as never);
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "tama/m2",
            options: [{ value: "tama/m2", name: "m2" }],
          },
        ],
      },
      contextUsage: { s1: { used: 100000, window: 128000 } },
    });
    render(<SidePane />);
    const model = screen.getByRole("button", { name: "Model" });
    expect(model.textContent).toContain("m2 · tama");
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("78"); // 100000/128000 ≈ 78%
  });

  it("choosing a model item invokes setSessionConfigOption (the pane owns the write path now)", async () => {
    seedLiveSession();
    // The picker's rows come from the CATALOG now (#154), so the row the test
    // clicks (`beta`) must exist THERE: the option's own snapshot no longer feeds
    // the dialog when the pane passes `items`. Provider `acme` is configured so
    // the cue resolves; the SENT value stays the composed key `acme/beta`.
    useModelCatalog.setState({
      models: [catalogModel("alpha", "acme"), catalogModel("beta", "acme")],
      loadStarted: true,
      loadedOk: true,
    });
    useSettings.setState({
      settings: { providers: [{ id: "acme", name: "acme" }] },
    } as never);
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [
              { value: "acme/alpha", name: "acme/Alpha" },
              { value: "acme/beta", name: "acme/Beta" },
            ],
          },
        ],
      },
    });
    render(<SidePane />);
    // The model picker is a DIALOG (the trigger is a button — the catalog
    // is too long for a Radix dropdown).
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    // The row name is the BARE id; the sent value is the full composed key.
    fireEvent.click(screen.getByText("beta"));
    // The handler is async (`await setSessionConfigOption`, then
    // `applyConfigOptions`), so the call lands a microtask after the click.
    await waitFor(() =>
      expect(setSessionConfigOption).toHaveBeenCalledWith("s1", "model", "acme/beta"),
    );
  });

  it("a STORED session's model selection round-trips through setSessionConfigOption and updates the trigger (#154: the selectors are ENABLED and the write reaches the backend)", async () => {
    // The whole point of the always-enabled change: a session with no Worker
    // running still persists the change, and the command's response (the
    // re-synthesized options) replaces the store's map — so the trigger visibly
    // moves to the new model WITHOUT a resume.
    seedStoredSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "tama/old",
            options: [{ value: "tama/old", name: "old" }],
          },
        ],
      },
    });
    // The picker's rows (and therefore what the trigger can resolve to a display
    // name) come from the CATALOG, not from the option's snapshot (#154). Seed
    // both models so the click sends a value DIFFERENT from the current one —
    // closer to the live write-path case's semantics.
    useModelCatalog.setState({
      models: [catalogModel("old"), catalogModel("m1")],
      loadStarted: true,
      loadedOk: true,
    });
    useSettings.setState({
      settings: { providers: [{ id: "tama", name: "tama" }] },
    } as never);
    render(<SidePane />);
    const model = screen.getByRole("button", { name: "Model" });
    // THE (b) FLIP: a stored session's selector is enabled.
    expect(model.hasAttribute("disabled")).toBe(false);
    fireEvent.click(model);
    // RESOLVE the mock with the new options BEFORE the click: `useAsyncAction`
    // invokes `onSet` synchronously on the click, so a `mockResolvedValueOnce`
    // installed afterwards would be consumed by the file's default
    // `mockResolvedValue([])` and the trigger would never move.
    vi.mocked(setSessionConfigOption).mockResolvedValueOnce([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "tama/m1",
        options: [{ value: "tama/m1", name: "m1" }],
      },
    ]);
    fireEvent.click(screen.getByText("m1"));
    // The call SHAPE is the contract with the backend sibling task: the session
    // id, the config id, and the COMPOSED `provider/id` value.
    await waitFor(() =>
      expect(setSessionConfigOption).toHaveBeenCalledWith("s1", "model", "tama/m1"),
    );
    // The response went through `applyConfigOptions`, so the trigger now shows
    // the NEW current model (with the provider cue).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Model" }).textContent,
      ).toContain("m1 · tama"),
    );
  });

  it("seeding useModelCatalog changes an ALREADY-OPEN session's picker options without creating a session (#154: the options come from the live catalog)", () => {
    // The defect this closes: the picker used to read the session's snapshotted
    // `configOptions`, which the harness bakes at start / resume / set — so a
    // provider added or refreshed in Settings could never reach a session that
    // was already open. The rows now come from the store, and plain zustand
    // propagates the change to the OPEN dialog (the precedent is
    // `SubagentDelegatingCard.test.tsx`, which proves the same re-render).
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "tama/m1",
            options: [{ value: "tama/m1", name: "m1" }],
          },
        ],
      },
    });
    useModelCatalog.setState({
      models: [catalogModel("m1")],
      loadStarted: true,
      loadedOk: true,
    });
    useSettings.setState({
      settings: { providers: [{ id: "tama", name: "tama" }] },
    } as never);
    render(<SidePane />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    // Scoped to the dialog: the trigger's own text is `m1 · tama`, so a bare
    // `getByText("m1")` would match the trigger AND the row.
    const dialog = within(
      document.querySelector("[data-slot=dialog-content]") as HTMLElement,
    );
    expect(dialog.getByText("m1")).toBeTruthy();
    expect(dialog.queryByText("new-m2")).toBeNull();

    // Settings adds / refreshes a provider → the store catalog gains a row.
    act(() => {
      useModelCatalog.setState({
        models: [catalogModel("m1"), catalogModel("new-m2")],
      });
    });

    // The SAME already-open dialog shows the new row — no re-render from scratch,
    // no second session, and the trigger keeps its current model.
    expect(dialog.getByText("new-m2")).toBeTruthy();
    expect(dialog.getByText("m1")).toBeTruthy();
    expect(useSessions.getState().sessions).toHaveLength(1);
  });

  it("an UNSELECTABLE catalog model still appears in the picker, DISABLED, with the reason (issue #9: the live catalog is unfiltered, so the row must say the harness cannot speak it)", async () => {
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "tama/m1",
            options: [{ value: "tama/m1", name: "m1" }],
          },
        ],
      },
    });
    useModelCatalog.setState({
      models: [
        catalogModel("m1"),
        // The engine's `is_selectable()` is false and no tools are advertised.
        catalogModel("dead", "tama", false, false),
      ],
      loadStarted: true,
      loadedOk: true,
    });
    useSettings.setState({
      settings: { providers: [{ id: "tama", name: "tama" }] },
    } as never);
    render(<SidePane />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = within(
      document.querySelector("[data-slot=dialog-content]") as HTMLElement,
    );
    // STILL VISIBLE (the row is the only place the user learns the model
    // exists but cannot be used) — and it says why.
    const row = dialog
      .getByText(/^dead/)
      .closest("[role=button]") as HTMLElement;
    expect(row.textContent).toContain("no tool support advertised");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    // Clicking it must NOT reach the backend (the session would fail).
    fireEvent.click(row);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it("a SELECTABLE catalog model still selects from the picker (issue #9: the guard is per-row, not a blanket disable)", async () => {
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "tama/m1",
            options: [{ value: "tama/m1", name: "m1" }],
          },
        ],
      },
    });
    useModelCatalog.setState({
      models: [
        catalogModel("dead", "tama", false, false),
        catalogModel("m2"),
      ],
      loadStarted: true,
      loadedOk: true,
    });
    useSettings.setState({
      settings: { providers: [{ id: "tama", name: "tama" }] },
    } as never);
    render(<SidePane />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = within(
      document.querySelector("[data-slot=dialog-content]") as HTMLElement,
    );
    const row = dialog.getByText("m2").closest("[role=button]") as HTMLElement;
    // The guard is PER ROW: the dead sibling in the SAME dialog is disabled…
    const dead = dialog
      .getByText(/^dead/)
      .closest("[role=button]") as HTMLElement;
    expect(dead.getAttribute("aria-disabled")).toBe("true");
    // …and this row is NOT (proof the guard did not become a blanket disable).
    expect(row.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(row);
    await waitFor(() =>
      expect(setSessionConfigOption).toHaveBeenCalledWith("s1", "model", "tama/m2"),
    );
  });

  it("a live session WITHOUT configOptions renders neither selector (the Model stub and the empty track are the whole block)", () => {
    seedLiveSession();
    render(<SidePane />);
    // A live session with no `configOptions` is the STUB case for MODEL only:
    // the block renders the disabled Model stub, the empty track and no real
    // control. The thinking line is gated away (an unknown config carries no
    // `thought_level` select, so there is nothing to render). (Moved here with
    // the controls — in the composer this assertion had gone vacuous, since
    // nothing in the composer can be a combobox any more.)
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Thinking" })).toBeNull();
    expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
  });

  it("a live session whose model advertises NO thinking levels renders NO Reasoning line (two lines: Model, then Context)", () => {
    seedLiveSession();
    useSessions.setState({
      // Exactly the frame the Rust harness emits for a model with no thinking
      // levels: `synthesize_catalog_config_options` OMITS `thought_level` from
      // the config list rather than sending an empty select, so the option
      // lookup is empty and the frontend must not manufacture a control.
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [{ value: "acme/alpha", name: "acme/Alpha" }],
          },
        ],
      },
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<SidePane />);
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    const lines = Array.from(
      container.querySelectorAll('[data-testid="session-config-controls"] > div'),
    ) as HTMLElement[];
    // The ORDER contract survives the missing line: a hidden Reasoning line
    // leaves Model first and the bar last — it never leaves a gap, and it never
    // promotes the bar into the middle.
    expect(lines).toHaveLength(2);
    expect(lines[0]!.querySelector('[aria-label="Model"]')).toBeTruthy();
    expect(lines[0]!.querySelector('[aria-label="Thinking"]')).toBeNull();
    expect(block.querySelector('[aria-label="Thinking"]')).toBeNull();
    expect(lines[1]!.getAttribute("data-testid")).toBe("context-usage-bar");
  });

  it("a STORED session with configOptions still renders no SELECTOR control (it is populated but read-only)", () => {
    seedStoredSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [{ value: "acme/alpha", name: "acme/Alpha" }],
          },
        ],
      },
    });
    render(<SidePane />);
    // What this case pins is the control's ROLE, not its enabled state: the
    // model option is a DIALOG trigger (a `button` — the catalog is too long for
    // a Radix dropdown), never a Radix `combobox`, so `queryByRole("combobox")`
    // stays null for a stored session exactly as for a live one. (The title's
    // "read-only" parenthetical predates #154 — a stored session's selectors are
    // ENABLED now; the enabled flip is pinned by the POPULATED case above and
    // the round-trip case below. The role distinction is what survives it.)
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  });

  // --- The block's PINNING inside the pane (the three geometry traps). ---

  it("pins the config block with shrink-0 (the pane's scroller is `flex-1`, so the block must not absorb the height shortfall)", () => {
    const { container } = render(<SidePane />);
    // The frame is a `flex-col` whose content div is `flex-1` (basis 0). A new
    // sibling with the default `flex-basis: auto` would be the ONLY item that
    // can shrink, so a long todo board would squash the block instead of
    // scrolling — the exact failure the composer island documents for itself.
    // Classes are all jsdom can grade, so that is what is asserted.
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block.className).toContain("shrink-0");
    expect(block.className).not.toMatch(/\bflex-1\b/);
  });

  it("keeps ordinary bottom padding (nothing overlays the block's corner any more)", () => {
    // This padding used to be `pb-10`, because a pane collapse toggle sat
    // `absolute bottom-2 left-2 z-10` on top of the Context line. That
    // toggle is retired (the chrome bar holds the tabs and the window controls
    // and nothing else), so the block keeps the pane's own inset. Asserted as a SMALL
    // value on purpose:
    // a `>= 32` test would have survived the change silently, and a regression
    // back to a big reservation would pass a bare "has padding" test.
    const { container } = render(<SidePane />);
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    const pb = block.className.match(/(^|\s)pb-(\[[0-9.]+rem\]|[0-9]+)/);
    expect(pb, "the block carries no bottom padding at all").toBeTruthy();
    const raw = pb![2]!;
    const px = raw.startsWith("[")
      ? Number(raw.replace(/[\[\]rem]/g, "")) * 16
      : Number(raw) * 4;
    expect(px, `pb of ${px}px reserves room for an overlay that is gone`).toBeLessThanOrEqual(16);
    // And the pane renders no such overlay: no absolutely-positioned button is
    // left inside the frame to reserve anything for.
    const frame = container.firstChild as HTMLElement;
    for (const btn of frame.querySelectorAll("button")) {
      expect((btn as HTMLElement).className, "a button still floats in the frame").not.toMatch(/\babsolute\b/);
    }
  });

  it("mounts the config block AFTER the scroll area (so a growing todo board cannot push it away or scroll it out of sight)", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    const { container } = render(<SidePane />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    // A SIBLING after the scroller — not a child of it. Inside the scroller the
    // block would scroll away with the board and drift with its length.
    expect(scroller.contains(block)).toBe(false);
    expect(block.previousElementSibling).toBe(scroller);
    // Both are direct children of the frame.
    expect(block.parentElement).toBe(scroller.parentElement);
  });

  // --- The session's cost line (issue #87) ---
  //
  // Both cases reset `cost` THEMSELVES, as their first statement, and seed under
  // `main1`. The reset is the load-bearing half: the file-level `beforeEach`
  // happens to dismiss `main1` (and NOT `s1`, the id `seedLiveSession` uses), so
  // relying on that cleanup would make these cases correct only while nobody
  // reorders or re-scopes it. Seeding under `main1` is the second line of defence.

  it("shows the session's cost line UNDER the session title and ABOVE the todo board (#87)", () => {
    useInteractive.setState({ cost: {} });
    useSessions.setState({
      activeSessionId: "main1",
      messages: { main1: [{ kind: "user", text: "the prompt", at: 1 }] },
    });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    // A figure the provider reported (0.15 sits above the sub-cliff band, so the
    // two-decimal form is what the line prints).
    useInteractive.getState().applyCost("main1", { costUsd: 0.15 });
    const { container } = render(<SidePane />);

    const cost = container.querySelector(
      '[data-testid="session-cost"]',
    ) as HTMLElement;
    expect(cost).toBeTruthy();
    expect(cost.textContent).toBe("$0.15");

    // DOM ORDER among the scroll column's children: title → cost → todos.
    const column = cost.parentElement as HTMLElement;
    const children = Array.from(column.children);
    const title = screen.getByText("the prompt");
    const todos = screen.getByText("Todos");
    const titleIndex = children.findIndex((el) => el.contains(title));
    const costIndex = children.indexOf(cost);
    const todosIndex = children.findIndex((el) => el.contains(todos));
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(costIndex).toBeGreaterThanOrEqual(0);
    expect(todosIndex).toBeGreaterThanOrEqual(0);
    expect(titleIndex).toBeLessThan(costIndex);
    expect(costIndex).toBeLessThan(todosIndex);
    // And the line is a direct child of the column, not nested inside the todo
    // section (a line that rode inside the board would vanish with the board's
    // data gate — the figure is not gated on todos).
    expect(costIndex).toBe(titleIndex + 1);
  });

  it("renders NO cost element when the session has no figure (no $0.00, no extra gap-child) (#87)", () => {
    useInteractive.setState({ cost: {} });
    useSessions.setState({
      activeSessionId: "main1",
      messages: { main1: [{ kind: "user", text: "the prompt", at: 1 }] },
    });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    // Frames that carried NO figure — the ordinary live case (T08's probe P6:
    // absence is per-call). This must NOT become a `$0.00` row.
    useInteractive.getState().applyCost("main1", { costUsd: null });
    const { container } = render(<SidePane />);

    expect(container.querySelector('[data-testid="session-cost"]')).toBeNull();
    // No dollar text anywhere in the pane (the config block carries none), so a
    // phantom `$0.00` cannot hide behind a wrapper.
    expect(screen.queryByText(/\$/)).toBeNull();
    // And the scroll column gained NO child: with a title and a todo board it
    // holds exactly the two it always held. This is the issue-#86 class of bug —
    // an empty child that still eats a `gap-4` slot.
    const column = container.querySelector(".overflow-y-auto > div") as HTMLElement;
    expect(column.children).toHaveLength(2);
  });
});
