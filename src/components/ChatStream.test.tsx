import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatStream from "./ChatStream";
import {
  sendPrompt,
  resumeSession,
  readFileBytes,
  cancelSession,
  listSkills,
  listMcpServersEffective,
  type StopReason,
} from "../lib/tauri";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSettings } from "../store/settings";
import {
  brailleLoaderVariants,
  generateFrames,
  getVariantGridSize,
} from "../lib/braille-loader";
import {
  MIN_INDICATOR_WIDTH_CLASS,
  MIN_INDICATOR_WIDTH_PX,
} from "./chat/WorkingIndicator";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
// `import * as chatAttachments` removed by tsc (TS6133): its only consumer was
// the `readAttachmentAsBase64` spy inside the Flush group, which moved to
// `src/hooks/usePromptQueueFlusher.test.tsx` with `flushHead` (issue #135 §2).
// `import { activeMentionToken, isOutsideSpaceQuery } from "../lib/skills"`
// removed by tsc (TS6133): both were read only by the out-of-Space Directory
// completion group, which moved with them to
// `src/components/ChatStreamDirectoryCompletion.test.tsx` (issue #135 §5).
// `import { listAgentDefinitionsForSpace, listSpaceListing, type ListingDto,
// type AgentDefinitionDto } from "../lib/tauri"` and
// `import { IPC_EVENTS } from "../lib/ipc/events"` removed by tsc (TS6133):
// all five were read only by the mention / file-completion picker cluster,
// which moved with them to
// `src/components/ChatStreamMentionPicker.test.tsx` (issue 1107, FE3).
// `import { type Mock } from "vitest"` and the two fixtures
// `PERSISTED_MCP_MESSAGE` / `seedMcpMentionsOff` went the same way for the
// same reason. `listMcpServersEffective`, `seedMcpMentionsOn`, `waitForCatalog`
// and `listSkills` STAY: the `[image #N]` staging marker group below still
// seeds the `#` catalog and waits on both catalogs through them.
import { resetStores } from "../test/resetStores";
import {
  MONO_ADVANCE_EM,
  SETTINGS_FIXTURE,
  seedLiveSession,
  seedStoredSession,
  seedArchivedSession,
  seedLiveSessionWithImages,
  seedMcpMentionsOn,
  pasteToComposer,
  dropOnComposer,
  flush,
  deferred,
  waitForCatalog,
} from "../test/chatStreamFixtures";

// The environment stubs `src/test/setup.tsx` does NOT provide.
//
// DELETED here by the rolling B4a migration (this file was touched by B2 for the
// `IPC_EVENTS.insertSkill` fold): the `matchMedia` `stubGlobal`, the four
// `Element.prototype` pointer-capture/`scrollIntoView` stubs. All five are
// byte-equivalent to what `setup.tsx`'s own `beforeAll` installs, and this file
// calls no `vi.unstubAllGlobals()`, so the shared stubs survive for the whole
// file (that call is the ONLY thing that strips a setup-file `stubGlobal` — see
// the guard list in `setup.tsx`).
//
// KEPT, and neither is redundancy:
//  - the object-URL pair: `setup.tsx` stubs no `URL` API, and staged
//    attachments need a deterministic `blob:` URL (Node's global `URL` reaches
//    jsdom but rejects web `Blob`s).
//  - the THREE `HTMLElement.prototype` stubs: `setup.tsx` puts `scrollIntoView`
//    on `Element.prototype` only, and two tests read
//    `HTMLElement.prototype.scrollIntoView` directly and inspect
//    `mock.contexts` to learn WHICH picker row scrolled. Without this own-property
//    override that read is `undefined` and the calls land on the inherited
//    `Element` stub — so this is a dependency, not a duplicate.
//    Those two readers were the picker-geometry group, which FE3 moved to
//    `src/components/ChatStreamMentionPicker.test.tsx` with the rest of the
//    mention cluster; the stubs stay HERE because the clone is the documented
//    shape of a `ChatStream*` test scaffold (both existing siblings carry it),
//    and because `setup.tsx` still puts `scrollIntoView` on `Element` only — so
//    a test added here that reads the own property would need them again.
beforeAll(() => {
  URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    startSession: vi.fn().mockResolvedValue({
      sessionId: "s2",
      cwd: "/home/u/proj",
      capabilities: {},
      archived: false,
    }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true, promptCapabilities: { image: true } },
      archived: false,
    }),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    readClipboardImage: vi.fn().mockResolvedValue(null),
    readFileBytes: vi.fn().mockResolvedValue(null),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    // The `/compact` Composer command (ADR 0044). MOCKED ON PURPOSE, and not
    // optional: this factory spreads `importActual`, so an un-mocked
    // `compactSession` would reach the REAL `invoke` and reject on jsdom's
    // missing `window.__TAURI_INTERNALS__` — a dispatch test would then "pass"
    // on the rejection landing in `send()`'s `catch` rather than on the
    // interception. `true` = "the frame was written" (the live answer).
    compactSession: vi.fn().mockResolvedValue(true),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    listSkills: vi.fn().mockResolvedValue([
      {
        name: "debug",
        description: "Debug a failure",
        path: "/s/.agents/skills/debug/SKILL.md",
        dir: "/s/.agents/skills/debug",
        scope: "space",
        body: "Step 1. Step 2.",
        shadowed: [],
      },
      {
        name: "beta",
        description: "Beta skill",
        path: "/s/.agents/skills/beta/SKILL.md",
        dir: "/s/.agents/skills/beta",
        scope: "space",
        body: "B body",
        shadowed: [],
      },
    ]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([
      {
        name: "scout",
        description: "Fast recon.",
        model: null,
        scope: "user",
      },
    ]),
    listMcpServersEffective: vi.fn().mockResolvedValue([
      {
        name: "postgres",
        kind: "stdio",
        summary: "npx -y x-mcp",
      },
    ]),
    // The `?` File-completion listing (ADR 0033). Mocked because EVERY
    // session-mounting test in this file calls it (the catalog hook fetches
    // unconditionally), and the `?` tests need to control the payload per
    // test — including a DEFERRED promise for the in-flight case. Empty by
    // default so the pre-existing `$`/`@`/`#` tests see no file rows.
    listSpaceListing: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    // The out-of-Space Directory completion rows (ADR 0035). Mocked for the
    // same reason as `listSpaceListing`, and it is NOT optional: the composer
    // calls `useCompletionDir(null)` on EVERY mount (an empty draft has no
    // token, so `dirPrefix` is `null` and the cache misses), so an un-mocked
    // export — this factory spreads `importActual` — would fire a REAL
    // `invoke` in jsdom, reject on the missing `window.__TAURI_INTERNALS__`
    // and log a `listCompletionEntries failed:` line in every
    // session-mounting test in this file.
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});

// The native file picker (the `+` button's `open` — the real module would
// `invoke` Tauri's dialog plugin, which doesn't exist in jsdom).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  // Restore real timers in case a previous test installed fake ones (the
  // mid-read tests below use `vi.useFakeTimers()` to settle the macrotask-
  // based `FileReader` deterministically) — a no-op for tests that don't.
  vi.useRealTimers();
  setSidePaneCollapsed(false);
  localStorage.clear();
  // The prompt queue is a module singleton too — drop every entry so a queue
  // left by the previous test cannot satisfy a "nothing was queued" assertion.
  // BEFORE `clearAllMocks` so the URL releases this cleanup performs are not
  // counted against the revocation assertions in the queue tests.
  for (const id of Object.keys(useQueuedPrompts.getState().bySession)) {
    useQueuedPrompts.getState().clearSession(id);
  }
  // `clearAllMocks` clears the call history (the `URL` stub implementations
  // from `beforeAll` survive — `mockClear` semantics, not `mockReset`).
  vi.clearAllMocks();
  // The skill catalog's module-level cache is shared across tests in this
  // file — clear it so each test starts with a COLD cache (a warm cache from
  // a previous test's `seedLiveSession` `cwd` key would make the fresh
  // `listSkills` mock moot: the hook would serve the cached value and never
  // re-fetch).
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  // Every store back to zustand's own captured initial state (the rolling
  // migration). This replaces a hand-written 11-key `useSessions` reset — the
  // store carries data fields that list never named, so `history`,
  // `contextUsage`, `stalled`, `newSessionError` and friends used to leak from
  // one test to the next — plus the per-id `dismiss*` calls (a whole-store
  // replace already covers them) and the settings reset (whose values ARE the
  // initial state). No count of the store's data fields is quoted here on
  // purpose: it goes stale the moment a field is added, and this comment would
  // then be a confident lie about the store it is explaining.
  //
  // The queued-prompt loop ABOVE still runs first and is NOT redundant: its
  // `clearSession` releases staged object URLs, a side effect a state replace
  // cannot perform.
  resetStores();
});


describe("ChatStream — empty state, session lifecycle and thinking blocks", () => {
  it("renders the empty state when there is no active session", () => {
    render(<ChatStream />);
    expect(
      screen.getByText(
        "No active session — open a Space from the tabs above",
      ),
    ).toBeTruthy();
  });

  it("survives the no-session → active-session transition (all hooks are called unconditionally, before the early return)", () => {
    // Render the early-return path first (no active session → the hook
    // count is N), then seed a live session and re-render (full frame →
    // the hook count must STILL be N). Any hook called only on the
    // full-frame path (after the `!activeSessionId` early return) would
    // throw "Rendered more hooks than during the previous render" here
    // (the white-page crash) — e.g. `usePendingSubagentRequests`.
    render(<ChatStream />);
    expect(
      screen.getByText(
        "No active session — open a Space from the tabs above",
      ),
    ).toBeTruthy();
    act(() => {
      seedLiveSession();
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("renders the fresh-session hint for an empty transcript", () => {
    seedLiveSession();
    render(<ChatStream />);
    expect(screen.getByText("Send a prompt to start")).toBeTruthy();
  });

  it("renders the working indicator (BrailleLoader) when inTurn with no interactive state", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    // The `BrailleLoader` renders `role="status"`.
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders thinking block in transcript", async () => {
    seedLiveSession();
    const sessionId = "s1";
    useSessions.getState().addUserMessage(sessionId, "hi");
    useSessions.getState().applySessionUpdate(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" }, messageId: "m1" });
    useSessions.getState().beginTurn(sessionId);
    
    render(<ChatStream />);
    // Verify the "Thinking" label (scoped to the transcript's gradient text —
    // the thinking STUB that used to sit in the composer and show the same
    // "Thinking" placeholder is now the side pane's config block, and the pane
    // is not part of this render; the scope stays so the two can never collide
    // again if the pane is ever mounted under `ChatStream`).
    expect(screen.getByText("Thinking", { selector: ".animated-gradient-text" })).toBeTruthy();
    
    // Complete the turn
    act(() => {
      useSessions.getState().turnCompleted(sessionId, "end_turn");
    });
    
    // Verify "Thought" label (assert ONLY "Thought")
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("renders done thinking block in history (not streaming)", () => {
    seedLiveSession();
    const sessionId = "s1";
    useSessions.getState().addUserMessage(sessionId, "hi");
    useSessions.getState().applySessionUpdate(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "done thought" }, messageId: "m1" });
    // Not in turn
    
    render(<ChatStream />);
    // Should show "Thought" (it never streamed)
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("renders the working indicator from the interactive agentState alone (no inTurn)", async () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useInteractive.getState().applyState("s1", { state: "working" });
    render(<ChatStream />);
    await flush();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders 'Waiting for your input…' when the interactive agentState is blocked", async () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useInteractive.getState().applyState("s1", { state: "blocked" });
    render(<ChatStream />);
    await flush();
    expect(screen.getByText("Waiting for your input…")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ChatStream — the working indicator in the composer bottom row", () => {
  // --- The working indicator lives IN the composer's bottom row ------------
  //
  // It used to be a full-width bar parked ABOVE the composer box, pulled down
  // onto it with `-mb-2` so the two read as one surface. It is now a single
  // item IN that surface: the bottom row's left end, on the same line as the
  // `+` and Send buttons. So the two properties that bar needed — the `-mb-2`
  // hug, and being a row of its own between the transcript and the composer —
  // are gone, and what replaces them is that the indicator shares a line with
  // the actions and cannot push them off.

  it("renders the working indicator in the composer's bottom row, on the buttons' line", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    // EXACTLY ONE indicator. The move relocates the row; it does not leave the
    // old bar above the composer standing there too (a `querySelector` would
    // happily read whichever copy came first and never notice the twin).
    const indicators = container.querySelectorAll(
      '[data-testid="working-indicator"]',
    );
    expect(indicators).toHaveLength(1);
    const indicator = indicators[0];
    // INSIDE the composer box (it used to sit outside it, above).
    const island = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    expect(island.contains(indicator)).toBe(true);
    // SAME LINE as `+` and Send: the indicator and the button wrapper are
    // SIBLINGS of one flex row, and the indicator is the row's first item
    // (the buttons stay right-aligned via the wrapper's `ml-auto`).
    const attach = island.querySelector('[aria-label="Attach files"]')!;
    const buttonWrapper = attach.parentElement!;
    expect(indicator!.parentElement!.className).toContain("items-center");
    expect(indicator!.parentElement).toBe(buttonWrapper.parentElement);
    expect(indicator!.nextElementSibling).toBe(buttonWrapper);
    // It is NOT inside the button wrapper: that wrapper is `ml-auto` and holds
    // the actions only — putting the quip in there would right-align it too.
    expect(buttonWrapper.contains(indicator)).toBe(false);
    // The bar's own chrome is gone with the bar: no bottom-border separator, no
    // dim filler line after the quip, and no `-mb-2` hug (there is no gap left
    // to close — it is already inside the box).
    expect(indicator?.className).not.toContain("border-b");
    expect(indicator?.className).not.toContain("-mb-2");
    expect(indicator?.querySelector(".bg-foreground-subtlest")).toBeNull();
    // Still OUTSIDE the transcript's scroll region, so a long transcript cannot
    // scroll the working line away.
    expect(indicator?.closest(".overflow-y-auto")).toBeNull();
  });

  it("puts the 'Waiting for your input…' line in the same row", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useInteractive.getState().applyState("s1", { state: "blocked" });
    const { container } = render(<ChatStream />);
    const island = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    );
    expect(indicator?.textContent).toContain("Waiting for your input…");
    expect(island.contains(indicator)).toBe(true);
    expect(indicator!.closest(".overflow-y-auto")).toBeNull();
  });

  it("truncates the quip instead of pushing `+` and Send off the row", () => {
    // The row is a fixed-height flex line, and a quip can be ~60 characters
    // (see `lib/spin-quips.ts`). In a flex row an unshrinkable text child
    // GROWS the line and squeezes the buttons, so the text must be the thing
    // that gives: `min-w-0` + `truncate` on the text ITSELF (a flex child's
    // automatic minimum is its content width, which is what makes `truncate` a
    // no-op without it), and `shrink-0` on the button wrapper so a long quip
    // cannot squeeze two 24–28px hit targets.
    //
    // The `min-w-0` sits on the `<p>` and NOT on the indicator box, and that is
    // the fix: on the box it let the whole indicator shrink to nothing, which
    // is how the `shrink-0` spinner ended up painting over `+` (see the next
    // two cases). WHAT THIS TEST CAN AND CANNOT SAY is the same limit every
    // layout assertion here has — jsdom has no layout engine — so these are the
    // class contract, not a measured layout.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    const text = indicator.querySelector("p") as HTMLElement;
    expect(text.className).toContain("truncate");
    // The item that shrinks is the TEXT, not the box that also holds the
    // spinner — so the shrink permission lives on the `<p>`.
    expect(text.className).toContain("min-w-0");
    expect(indicator.className).not.toContain("min-w-0");
    // `shrink-0` is on the wrapper, not on the buttons: flex would otherwise
    // squeeze BOTH buttons to fit the quip.
    const attach = container.querySelector(
      '[aria-label="Attach files"]',
    ) as HTMLElement;
    expect(attach.parentElement!.className).toContain("shrink-0");
    expect(attach.parentElement!.className).toContain("ml-auto");
  });

  it("floors the indicator's width at the widest spinner (the spinner cannot overlap `+`)", () => {
    // The narrow-row defect: the box used to carry a bare `min-w-0`, so under
    // enough pressure it shrank toward zero while its `shrink-0` spinner kept
    // its intrinsic ~50px and painted OVER the `+` button — with the quip fully
    // truncated and no way to stop it. The crossover is reachable at the app's
    // DEFAULT 800px window with the side pane open, so the box now has a floor
    // instead of a zero minimum.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    expect(indicator.className).toContain(MIN_INDICATOR_WIDTH_CLASS);
    // The class is spelled as a LITERAL rather than interpolated from the px
    // number, because Tailwind scans source text and would never emit a class
    // built at runtime. So the pair needs pinning: the spacing step (14) times
    // the 0.25rem base must equal the px the arithmetic below is checked against.
    expect(MIN_INDICATOR_WIDTH_CLASS).toBe(
      `min-w-${MIN_INDICATOR_WIDTH_PX / 4}`,
    );
    // The floor must clear the WIDEST spinner the settings can pick, not just
    // the current one: the grid is at most 6 cells at the fixed `fontSize={14}`
    // in a 0.6em monospace advance, so ~50px — and 56px is above every variant.
    const widest = Math.max(
      ...brailleLoaderVariants.map(
        (v) => getVariantGridSize(v)[0] * 14 * MONO_ADVANCE_EM,
      ),
    );
    expect(MIN_INDICATOR_WIDTH_PX).toBeGreaterThanOrEqual(widest);
  });

  it("wraps the composer's bottom row so the floor cannot push Send off the edge", () => {
    // The floor only helps if the row may break: a `flex-1` item with a
    // `min-w` floor in a NON-wrapping row simply overflows the other end and
    // pushes Send out of the island. So the fallback is floor + wrap together,
    // and a regression on either half re-creates an overlap.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    const row = indicator.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    // And the indicator keeps `flex-1` — the wrap only happens once the floor
    // binds, so on a normal-width row the indicator still absorbs the slack and
    // the buttons stay right-aligned on the SAME line.
    expect(indicator.className).toContain("flex-1");
  });

  it("does NOT wrap inside the indicator (the quip truncates beside the spinner, it does not drop under it)", () => {
    // The regression the first attempt at the fix shipped with: `flex-wrap` on
    // BOTH the row and the indicator box. A wrapping flex container breaks on a
    // flex item's HYPOTHETICAL main size, and the `<p>` has no flex-basis, so it
    // measures its CONTENT — ~420px for a 60-character quip, which never fits
    // beside the spinner. So the quip would break onto a second line and the
    // `truncate` would never run at all: a taller island whose height jumps as
    // the quips rotate, and no ellipsis anywhere. Worse than the overlap it
    // replaced. Wrapping is the ROW's job; inside the box the text only shrinks.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    expect(indicator.className).not.toContain("flex-wrap");
    // The text still carries both halves of truncation, since nothing else can
    // make it give now that the box will neither wrap nor clip.
    const text = indicator.querySelector("p") as HTMLElement;
    expect(text.className).toContain("min-w-0");
    expect(text.className).toContain("truncate");
  });

  it("keeps the quip at full foreground ink (the composer fill is lighter than the chat plane)", () => {
    // The indicator's BACKGROUND moved with it: `--color-chat` (#232323) became
    // `--color-input` (#2b2b2b), and `foreground-subtle` on the new fill
    // measures 4.46:1 against the 4.76:1 it had on the old one — under WCAG's
    // 4.5:1 floor, on the line the user reads while the agent works. The token
    // is therefore load-bearing, not taste: a drift back to `-subtle` would be
    // invisible to every other test here.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const text = container.querySelector(
      '[data-testid="working-indicator"] p',
    ) as HTMLElement;
    expect(text.className).toContain("text-foreground");
    expect(text.className).not.toMatch(/text-foreground-subtle/);
  });

  it("runs the configured spinner style (the settings store's spinnerStyle)", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    useSettings.getState().setSettings({
      ...SETTINGS_FIXTURE,
      spinnerStyle: "pendulum",
      emptyStateAnimation: null,
    });
    const { container } = render(<ChatStream />);
    const span = container.querySelector(
      '[data-testid="working-indicator"] span[aria-hidden="true"]',
    );
    // The initial frame of the configured variant (the `BrailleLoader`
    // renders `frames[0]` before its interval ticks).
    const [w, h] = getVariantGridSize("pendulum");
    expect(span?.textContent).toBe(generateFrames("pendulum", w, h).frames[0]);
  });

  it("falls back to the typing spinner when no spinnerStyle is set", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const span = container.querySelector(
      '[data-testid="working-indicator"] span[aria-hidden="true"]',
    );
    const [w, h] = getVariantGridSize("typing");
    expect(span?.textContent).toBe(generateFrames("typing", w, h).frames[0]);
  });

  it("hides the working indicator when idle (no inTurn, no agentState)", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    const { container } = render(<ChatStream />);
    expect(
      container.querySelector('[data-testid="working-indicator"]'),
    ).toBeNull();
  });
});

describe("ChatStream — the compaction indicator (ADR 0045)", () => {
  // --- The compaction indicator (ADR 0045): an IDLE compaction has no turn,
  // so neither `inTurn` nor `agentState` says "working" — the row's render
  // gate itself had to widen for `compacting`. ---

  it("shows the Compacting row at IDLE while a compaction runs (the widened gate)", () => {
    seedLiveSession();
    useSessions.setState({ compacting: { s1: "manual" } });
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    );
    // The gate: nothing else would render the row here (no turn, idle agent).
    expect(indicator).toBeTruthy();
    // The LABEL. Read off the `<p>` rather than `getByText("Compacting")`:
    // the loader's `sr-only` label is a second match, and its `aria-hidden`
    // frame span contributes braille glyphs to `textContent`.
    expect(
      container.querySelector('[data-testid="working-indicator"] p')
        ?.textContent,
    ).toBe("Compacting");
  });

  it("labels every reason 'Compacting' (one label is the product decision)", () => {
    for (const reason of ["manual", "threshold", "overflow"] as const) {
      seedLiveSession();
      useSessions.setState({ compacting: { s1: reason } });
      const { container, unmount } = render(<ChatStream />);
      expect(
        container.querySelector('[data-testid="working-indicator"] p')
          ?.textContent,
      ).toBe("Compacting");
      unmount();
    }
  });

  it("overrides the user's spinner style with the pulse variant while compacting", () => {
    seedLiveSession();
    useSettings.getState().setSettings({
      ...SETTINGS_FIXTURE,
      spinnerStyle: "pendulum",
      emptyStateAnimation: null,
    });
    // BOTH a turn in flight AND a compaction: the pulse still wins (the
    // compaction branch sits above the spinner+quip branch).
    useSessions.getState().beginTurn("s1");
    useSessions.setState({ compacting: { s1: "threshold" } });
    const { container } = render(<ChatStream />);
    const span = container.querySelector(
      '[data-testid="working-indicator"] span[aria-hidden="true"]',
    );
    // The `pendulum` setting is IGNORED here: a compaction is a different
    // kind of wait, so this is a variant override, not the user's style.
    const [w, h] = getVariantGridSize("pulse");
    expect(span?.textContent).toBe(generateFrames("pulse", w, h).frames[0]);
  });

  it("does not render the rotating quip while compacting (one line, not two)", () => {
    seedLiveSession();
    useSessions.setState({ compacting: { s1: "manual" } });
    const { container } = render(<ChatStream />);
    expect(
      container.querySelectorAll('[data-testid="working-indicator"] p'),
    ).toHaveLength(1);
  });

  it("prefers the 'Waiting for your input…' line over Compacting when blocked AND compacting", () => {
    seedLiveSession();
    useSessions.setState({ compacting: { s1: "manual" } });
    useInteractive.getState().applyState("s1", { state: "blocked" });
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    )!;
    // `blocked` needs an answer NOW — it outranks the spinner.
    expect(indicator.textContent).toContain("Waiting for your input…");
    expect(indicator.querySelector("p")?.textContent).toBe(
      "Waiting for your input…",
    );
  });

  it("clears the Compacting row when a coalescing batch carries both frames (a Skipped compaction)", async () => {
    seedLiveSession();
    const { container } = render(<ChatStream />);
    await act(async () => {
      // The two frames of a `Skipped` compaction in ONE rAF batch: last-wins
      // leaves it cleared, so no row (deliberate — a stuck row would lock the
      // composer on a session that already finished).
      useSessions.getState().applySessionUpdates([
        { sessionId: "s1", update: { sessionUpdate: "compaction_update", active: true, reason: "threshold" } },
        { sessionId: "s1", update: { sessionUpdate: "compaction_update", active: false, reason: "threshold" } },
      ]);
    });
    expect(
      container.querySelector('[data-testid="working-indicator"]'),
    ).toBeNull();
  });

  it("disables the send button and no-ops Enter while compacting (the harness is one-turn-at-a-time)", () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Idle → enabled (sanity: the compaction has not started yet).
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    act(() => {
      useSessions.setState({ compacting: { s1: "manual" } });
    });
    // The send is dead for the whole compaction (a prompt now would be
    // REJECTED by `send_prompt`), while the draft survives for when it ends.
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("Esc while compacting cancels the session (the Esc listener attaches at idle too)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // No turn in flight — the effect's gate had to widen for `compacting`,
    // or the listener would never be attached and Esc would do nothing.
    act(() => {
      useSessions.setState({ compacting: { s1: "overflow" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).toHaveBeenCalledWith("s1");
  });

  it("Esc while ANOTHER session compacts does NOT cancel the active one", async () => {
    seedLiveSession();
    render(<ChatStream />);
    act(() => {
      useSessions.setState({ compacting: { other: "manual" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("renders a FileSummaryCard with the turn's diff totals", () => {
    seedLiveSession();
    useSessions.setState({
      messages: {
        s1: [
          { kind: "user", text: "edit the files", at: 1 },
          // a.ts: +2 −1
          { kind: "diff", path: "src/a.ts", patch: "+x1\n+x2\n-y1", at: 2 },
          // b.ts: +0 −3
          { kind: "diff", path: "src/b.ts", patch: "-z1\n-z2\n-z3", at: 3 },
        ],
      },
    });
    render(<ChatStream />);
    // Totals: +2 −4.
    expect(screen.getByText("2 files changed")).toBeTruthy();
    expect(screen.getByText("−4")).toBeTruthy();
  });

  it("counts a re-emitted diff once (last patch wins)", async () => {
    seedLiveSession();
    useSessions.setState({
      messages: {
        s1: [
          { kind: "user", text: "edit", at: 1 },
          // The store re-emits the standalone `diff` on every
          // `tool_call_update` carrying content: the same file twice.
          { kind: "diff", path: "src/a.ts", patch: "+x\n-y", at: 2 }, // +1 −1
          {
            kind: "diff",
            path: "src/a.ts",
            patch: "+x1\n+x2\n-y1\n-y2\n-y3",
            at: 3,
          }, // +2 −3
        ],
      },
    });
    render(<ChatStream />);
    await flush();
    // The LATEST patch wins: +2 −3 (header total = the single file's
    // stats, so each appears twice: header + row); the superseded
    // +1 −1 is not counted.
    expect(screen.getByText("1 file changed")).toBeTruthy();
    expect(screen.getAllByText("−3")).toHaveLength(2);
    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.queryByText("−1")).toBeNull();
  });

  it("renders the composer as a borderless ISLAND wearing the content surface", () => {
    // Two decisions, both pinned as negatives because both are one-keyboard
    // away from being silently reverted.
    //
    // NO BORDER: the frame used to be `border border-input-border`, i.e.
    // Dracula's Comment `#6272a4` — a slate VIOLET that reads as a purple
    // outline around the chat (`focus-within:border-input-border-focused` put
    // Functional Purple `#815cd6` on it while typing). The token is SHARED with
    // `input.tsx`/`select.tsx`/`ModelPicker`, which KEEP their borders, so this
    // is a per-site decision and only a class assertion can tell the two apart.
    //
    // SAME FILL AS THE TRANSCRIPT: the island is `bg-chat`, the same
    // token the transcript column and the side pane wear. That is only legible
    // because it is a SIBLING of the `main` with chrome between them — see the
    // next test. As a child it would have been invisible at 1.00.
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const shell = container.querySelector('[data-testid="composer-island"]');
    expect(shell).toBeTruthy();
    expect(shell!.className).toContain("bg-composer");
    expect(shell!.className).not.toContain("border-input-border");
    expect(shell!.className).not.toMatch(/(^|\s)border(\s|$)/);
  });

  it("keeps the composer a SIBLING of the transcript, not its child", () => {
    // THE LOAD-BEARING STRUCTURE of the island layout. Chrome frames each
    // island, so the gap between them IS the separation: siblings of the same
    // fill read as two surfaces, a nested one reads as one. If the composer is
    // ever moved back inside the `main`, `bg-chat` on both collapses
    // to a single invisible plane (CR 1.00) — and with the border gone there is
    // nothing left to show the boundary.
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const main = container.querySelector("main")!;
    const island = container.querySelector('[data-testid="composer-island"]')!;
    expect(main.contains(island)).toBe(false);
    // Same visual family as the transcript and the side pane: same radius, same
    // 4px margin, and `shrink-0` so the island never absorbs the column's
    // height shortfall (the `main` is `flex-1`/basis-0 and cannot shrink).
    expect(island.className).toContain("rounded-xl");
    expect(island.className).toContain("shrink-0");
    expect(main.className).toContain("rounded-xl");
  });

  it("the root main carries min-h-0 (a vertical flex item must be allowed to shrink — the transcript scrolls internally, not the window)", () => {
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const main = container.querySelector("main");
    expect(main).toBeTruthy();
    // The `main` is a `flex-1` item of the center column (a `flex-col`):
    // without `min-h-0` the item's `min-height: auto` keeps it at the
    // transcript's height — it overflows the window (the composer is
    // pushed off-screen) and the inner `overflow-y-auto` div never scrolls.
    expect(main!.className).toContain("min-h-0");
  });

  it("shows the SINGLE placeholder 'Ask for follow-up changes' for a fresh live session (no history — the state if/else is gone)", () => {
    seedLiveSession();
    render(<ChatStream />);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
  });

  it("shows the ZCode placeholder 'Ask for follow-up changes' for a live session WITH history", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hello");
    render(<ChatStream />);
    expect(
      screen.getByPlaceholderText("Ask for follow-up changes"),
    ).toBeTruthy();
  });

  it("renders the composer textarea at full width (w-full — a width:auto <textarea> falls back to its intrinsic cols width, ~177px)", () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.className).toContain("w-full");
  });

  it("renders the ZCode-style send button (icon-md: size-7 rounded-lg — not the old circular size-8 rounded-full)", () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton.className).toContain("rounded-lg");
    expect(sendButton.className).not.toContain("rounded-full");
  });

  it("keeps the SINGLE placeholder for a live working session (the 'Agent is working…' if/else is gone — the working indicator carries the state)", () => {
    seedLiveSession();
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
  });

  it("shows the SAME placeholder for a stored resumable session (no pause concept shown)", () => {
    seedStoredSession({ loadSession: true });
    render(<ChatStream />);
    // The stored session looks normal: the SAME single placeholder (the
    // auto-resume on send is silent — the pause/resume concept is not
    // shown).
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("Resume this session to send"),
    ).toBeNull();
  });

  it("shows the normal follow-up placeholder for a stored resumable session with messages", () => {
    seedStoredSession({ loadSession: true });
    useSessions.getState().addUserMessage("s1", "hi");
    render(<ChatStream />);
    // Identical to a live session with messages — no "Resume" wording.
    expect(
      screen.getByPlaceholderText("Ask for follow-up changes"),
    ).toBeTruthy();
  });

  it("shows the SAME placeholder for a history-only (closed) session (the 'This session is closed' if/else is gone)", () => {
    seedStoredSession();
    render(<ChatStream />);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
  });
});

describe("ChatStream — auto-resume of a RESUMABLE stored session", () => {
  // --- Auto-resume: a RESUMABLE stored session gets an enabled composer that
  // auto-resumes on send; a NON-RESUMABLE stored session stays fully disabled. ---

  it("enables the composer for a resumable stored session (no live session)", () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox");
    // The textarea is NOT disabled (it used to be — stored sessions were read-only).
    expect(textarea.hasAttribute("disabled")).toBe(false);
    const sendButton = screen.getByRole("button", { name: "Send" });
    // Empty draft → still disabled…
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    // …and enabled once there's a draft.
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the SEND disabled for a non-resumable stored session (a dead session can't receive a prompt — the harness rejects it)", () => {
    seedStoredSession(); // capabilities {} — no `loadSession`
    render(<ChatStream />);
    // The textarea stays editable (you can DRAFT — it just can't be SENT:
    // a non-resumable session has no agent process to deliver to, and the
    // harness's `send_prompt` rejects a prompt for an unknown session).
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("send in a resumable stored session auto-resumes it, then sends", async () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "resume and send" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The stored session was resumed FIRST (the store action delegates to the
    // Tauri `resume_session` command, mocked above)…
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith(
        "s1",
        "/home/u/proj",
      ),
    );
    // …then the prompt was sent (2-arg, text-only).
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "resume and send"),
    );
  });

  it("a failed resume aborts the send", async () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    vi.mocked(resumeSession).mockRejectedValueOnce(new Error("nope"));
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The resume failure surfaces its own error line…
    await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());
    // …and the send was aborted (no prompt was sent to the stored session).
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
  });
});

describe("ChatStream — Task 5 resume affordances are gone (ADR 0016)", () => {
  // --- Task 5 (ADR 0016): the manual Resume affordances are GONE — the
  // banner is purely informational and the first send auto-resumes. ---

  it("a resumable stored session renders NO banner and no Resume button (it looks normal)", () => {
    seedStoredSession({ loadSession: true });
    render(<ChatStream />);
    // The pause concept is not shown: no stored/resume banner, no
    // history-only banner, no Resume button — the first send auto-resumes
    // silently.
    expect(
      screen.queryByText(
        "This session is stored. Sending a message resumes it.",
      ),
    ).toBeNull();
    expect(screen.queryByText(/History only/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("an archived-only session renders no banner and an enabled composer, and first send resumes", async () => {
    seedArchivedSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    // The `historySession` selector searches BOTH stored lists, so an
    // archived-only session gets an enabled composer (not "This session
    // is closed") and NO banner (the pause concept is not shown).
    expect(
      screen.queryByText(
        "This session is stored. Sending a message resumes it.",
      ),
    ).toBeNull();
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("disabled")).toBe(false);
    fireEvent.change(textarea, {
      target: { value: "resume the archived one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The first send auto-resumes the archived session…
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith(
        "s9",
        "/home/u/arch",
      ),
    );
    // …and the message landed in `messages[s9]`.
    await waitFor(() =>
      expect(useSessions.getState().messages["s9"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "user",
            text: "resume the archived one",
          }),
        ]),
      ),
    );
  });

  it("paste stages a thumbnail in a resumable stored session (capability read from the stored session)", () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    const intercepted = pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    // The paste WAS intercepted — the capability came from the STORED
    // session's `capabilities` (a live-only read would fail closed).
    expect(intercepted).toBe(false);
    expect(screen.getByAltText("s.png")).toBeTruthy();
  });

  it("disables the send button while inTurn and when the draft is empty", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Empty draft → disabled.
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    // Non-empty draft, idle → enabled.
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    // inTurn (working) → send disabled again (the textarea stays EDITABLE
    // — you can draft while the agent works; Enter no-ops via `send()`'
    // `composerLocked` guard, the draft is kept for when the turn ends).
    await act(async () => {
      useSessions.getState().beginTurn("s1");
    });
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
  });

  it("calls sendPrompt when Enter is pressed with a draft", () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).toHaveBeenCalledWith("s1", "hello");
  });

  it("sending in one session does not block sending in another session (concurrent sessions)", async () => {
    let resolveS1!: (reason: StopReason) => void;
    vi.mocked(sendPrompt).mockImplementation((sessionId: string) => {
      if (sessionId === "s1") {
        return new Promise<StopReason>((resolve) => {
          resolveS1 = resolve;
        });
      }
      return Promise.resolve("end_turn");
    });

    try {
      useSessions.setState({
        activeSessionId: "s1",
        sessions: [
          { sessionId: "s1", cwd: "/home/u/proj1", capabilities: {}, archived: false },
          { sessionId: "s2", cwd: "/home/u/proj2", capabilities: {}, archived: false },
        ],
        spaces: [
          { path: "/home/u/proj1", createdAt: 1, lastOpenedAt: 1, trusted: false },
          { path: "/home/u/proj2", createdAt: 2, lastOpenedAt: 2, trusted: false },
        ],
        historySessions: [],
        messages: { s1: [], s2: [] },
        inTurn: {},
        stopReasons: {},
        closeReasons: {},
        configOptions: {},
        compacting: {},
      });

      render(<ChatStream />);

      // Send in s1
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "hello from s1" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(sendPrompt).toHaveBeenCalledWith("s1", "hello from s1");
      expect(useSessions.getState().inTurn.s1).toBe(true);

      // Switch to s2 while s1 is still in flight (working)
      await act(async () => {
        useSessions.setState({ activeSessionId: "s2" });
      });

      // In s2, user types and presses Enter
      const textareaS2 = screen.getByRole("textbox");
      fireEvent.change(textareaS2, { target: { value: "hello from s2" } });
      fireEvent.keyDown(textareaS2, { key: "Enter" });

      // s2 must NOT be blocked by s1's in-flight turn!
      await waitFor(() => {
        expect(sendPrompt).toHaveBeenCalledWith("s2", "hello from s2");
      });

      // Clean up pending s1 turn
      await act(async () => {
        resolveS1("end_turn");
      });
    } finally {
      vi.mocked(sendPrompt).mockReset();
      vi.mocked(sendPrompt).mockResolvedValue("end_turn");
    }
  });
});

describe("ChatStream — empty transcript with a pending request", () => {
  // --- Empty transcript + pending request (the request cards must NOT be
  // swallowed by the "Send a prompt to start" branch). ---

  it("renders a pending permission prompt on an empty transcript (no fresh-session hint)", () => {
    seedLiveSession();
    usePermissions.getState().addPrompt("s1", "req1", {
      toolCall: { title: "bash" },
      options: [{ optionId: "allow_once", name: "Allow once" }],
    });
    render(<ChatStream />);
    expect(screen.getByText("bash")).toBeTruthy();
    expect(screen.getByText("Allow once")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("renders a stacked interactive ask on an empty transcript (no fresh-session hint)", () => {
    seedLiveSession();
    // No `toolCallId` → the card is NOT queued (it renders immediately,
    // unanchored).
    useInteractive.getState().addRequest("s1", {
      requestId: "req-ask",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
    });
    render(<ChatStream />);
    expect(screen.getByText("Which approach?")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("renders a pending sudo password request on an empty transcript (no fresh-session hint)", () => {
    seedLiveSession();
    // No `toolCallId` (absent for `password`) → the modal renders
    // immediately (unanchored).
    useInteractive.getState().addRequest("s1", {
      requestId: "req-pw",
      method: "password",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<ChatStream />);
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("renders 'Waiting for your input…' on an empty transcript when the interactive agentState is blocked", async () => {
    seedLiveSession();
    useInteractive.getState().applyState("s1", { state: "blocked" });
    render(<ChatStream />);
    await flush();
    expect(screen.getByText("Waiting for your input…")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });
});

describe("ChatStream — composer mismatch states (one workingOrInTurn predicate)", () => {
  // --- Composer mismatch states (ONE predicate: `workingOrInTurn`). ---

  it("disables the send button and no-ops send() when the interactive agentState is working (no inTurn)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Idle → enabled (sanity).
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    // The interactive agentState says working (the `state` push races `turnCompleted`, or
    // the state latches after a turn) → the send is dead: button disabled,
    // the textarea stays editable (the draft is kept; Enter no-ops).
    await act(async () => {
      useInteractive.getState().applyState("s1", { state: "working" });
    });
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    // The placeholder is the single idle copy (the `working` mismatch does
    // not leave a stale copy behind — the working indicator carries the
    // state).
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("disables the send button and no-ops Enter while the interactive agentState is blocked (mid-turn awaiting a request response)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Idle → enabled (sanity: `blocked` has NOT been pushed yet).
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    // `inTurn` is true (a `blocked` agent is mid-turn — it is awaiting a
    // request response, so `inTurn` alone used to lock the composer) +
    // the interactive agentState says blocked → the send is dead for the whole
    // wait: button disabled (the textarea stays editable — the draft is
    // kept; Enter no-ops, no double-send, no clobbered turn bookkeeping).
    await act(async () => {
      useSessions.getState().beginTurn("s1");
      useInteractive.getState().applyState("s1", { state: "blocked" });
    });
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps the composer LOCKED when the interactive agentState is idle but the store is inTurn", () => {
    seedLiveSession();
    useSessions.getState().beginTurn("s1");
    useInteractive.getState().applyState("s1", { state: "idle" });
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    // A stale `idle` from the previous turn must not unlock the composer
    // while a turn is in flight (`inTurn` is the ground truth — the store
    // does not reset `agentState` on `turnCompleted`, a store follow-up):
    // the send is disabled and Enter no-ops (the textarea stays editable
    // — the draft is kept). The working indicator shows (the turn IS in
    // flight).
    const textarea = screen.getByRole("textbox");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeTruthy();
  });

  it("prefers the 'Waiting for your input…' line over the braille loader when blocked AND inTurn", () => {
    seedLiveSession();
    useSessions.getState().beginTurn("s1");
    useInteractive.getState().applyState("s1", { state: "blocked" });
    render(<ChatStream />);
    // `blocked` + `inTurn` → `workingOrInTurn` is true, but the blocked
    // line takes precedence: the waiting line renders and the braille
    // loader (role="status") does NOT (both would render otherwise).
    expect(screen.getByText("Waiting for your input…")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  // The composer's bottom row carries the working indicator and the two action
  // buttons — and NOT the three config lines (context bar, model, reasoning),
  // which left for the side pane's `SessionConfigBlock`. These pins keep them
  // out: a re-landed bar or trigger would put ~600 mounted model `SelectItem`s
  // back into the subtree that re-renders on every keystroke (`draft` is the
  // composer's state), which is the perf coupling the move exists to kill. The
  // assertion reads the WHOLE island, so it covers the working indicator's slot
  // too — giving the row a new item must not become a doorway for them.
  it("the composer island hosts NO config line (they are the side pane's now)", () => {
    // A FULL session: usage known AND both config options present — the state
    // in which a re-landed bar/trigger would definitely render. Anything the
    // composer still renders for these is a regression; the pane is asserted
    // separately (`SidePane.test.tsx`).
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
    const { container } = render(<ChatStream />);
    const composer = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    expect(composer).toBeTruthy();
    // Neither the context bar nor its track / label / icon.
    expect(
      composer.querySelector('[data-testid="context-usage-bar"]'),
    ).toBeNull();
    // Neither config trigger — the model trigger is a dialog BUTTON and the
    // thinking trigger a `combobox`, so check both roles and the raw labels.
    expect(composer.querySelector('[aria-label="Model"]')).toBeNull();
    expect(composer.querySelector('[aria-label="Thinking"]')).toBeNull();
    expect(
      composer.querySelector('[data-testid="session-config-controls"]'),
    ).toBeNull();
    // And nothing in the composer's subtree is a progressbar any more.
    expect(composer.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("keeps BOTH action buttons in the composer's bottom row, right-aligned together", () => {
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const composer = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    const attach = composer.querySelector(
      '[aria-label="Attach files"]',
    ) as HTMLElement;
    const send = composer.querySelector('[aria-label="Send"]') as HTMLElement;
    expect(attach).toBeTruthy();
    expect(send).toBeTruthy();
    // Both ride ONE `ml-auto` wrapper — that is what right-aligns them as a
    // pair. Splitting them (or dropping `ml-auto`) un-aligns the pair, which is
    // the layout the config lines' departure left behind and the reason the
    // wrapper still exists.
    expect(send.parentElement).toBe(attach.parentElement);
    expect(send.parentElement!.className).toContain("ml-auto");
    // They are the WRAPPER's only two children, Send last. (The wrapper, not
    // the row: the row's other item is the working indicator, and it is a
    // SIBLING of this wrapper — see the placement test above. Nothing may crowd
    // in beside the two actions, and Send stays the right-most thing in the
    // composer.)
    expect(send.parentElement!.childElementCount).toBe(2);
    expect(send.parentElement!.lastElementChild).toBe(send);
  });
});

describe("ChatStream — the + attach button (the native file picker)", () => {
  // --- The `+` attach button (the native file picker) ---

  it("renders an enabled `+` (Attach files) button for a live image-capable session", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    const button = screen.getByRole("button", { name: "Attach files" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("the `+` button is disabled when the agent does not advertise image support (fail-closed)", () => {
    seedLiveSession(); // capabilities: {} — no `promptCapabilities.image`
    render(<ChatStream />);
    const button = screen.getByRole("button", { name: "Attach files" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("the `+` button STAYS enabled while a turn is in flight (staging is allowed; only Send locks)", () => {
    seedLiveSessionWithImages();
    useSessions.setState({ inTurn: { s1: true } });
    render(<ChatStream />);
    const button = screen.getByRole("button", { name: "Attach files" });
    // Mid-turn staging is allowed — the turn is not a capability check. The
    // `+` shares the paste/drop rule; only Send (which DISPATCHES) locks.
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("clicking `+` opens the file picker and stages the picked image", async () => {
    seedLiveSessionWithImages();
    vi.mocked(openFilePicker).mockResolvedValueOnce([
      "/home/u/pics/shot.png",
    ]);
    vi.mocked(readFileBytes).mockResolvedValueOnce([
      0x89, 0x50, 0x4e, 0x47, 1, 2, 3,
    ]);
    render(<ChatStream />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    // The picker opens (the dialog's image filter — the backend re-validates
    // the extension, the frontend re-validates the MIME on staging).
    expect(vi.mocked(openFilePicker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openFilePicker).mock.calls[0][0]).toMatchObject({
      multiple: true,
    });
    // The picked file is staged as an attachment (the thumbnail appears —
    // the bytes were read via `read_file_bytes` and the MIME inferred from
    // the extension).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove image attachment" }),
      ).toBeTruthy(),
    );
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledWith(
      "/home/u/pics/shot.png",
    );
  });

  it("a cancelled picker (null) stages nothing", async () => {
    seedLiveSessionWithImages();
    vi.mocked(openFilePicker).mockResolvedValueOnce(null);
    render(<ChatStream />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(vi.mocked(openFilePicker)).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Remove image attachment" })).toBeNull();
    expect(vi.mocked(readFileBytes)).not.toHaveBeenCalled();
  });

  it("a picker selection of a non-image path is skipped (the read returns null)", async () => {
    seedLiveSessionWithImages();
    vi.mocked(openFilePicker).mockResolvedValueOnce([
      "/home/u/pics/notes.txt",
    ]);
    vi.mocked(readFileBytes).mockResolvedValueOnce(null);
    render(<ChatStream />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(vi.mocked(readFileBytes)).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Remove image attachment" })).toBeNull();
  });

  it("does NOT leak Reasoning state across sessions (per-session key)", () => {
    useSessions.setState({
      activeSessionId: "s1",
      sessions: [
        { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
        { sessionId: "s2", cwd: "/home/u/proj", capabilities: {}, archived: false },
      ],
      spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      historySessions: [],
      messages: {
        s1: [
          { kind: "user", text: "hi1", at: 1 },
          { kind: "agent-thought", messageId: "m1", text: "thought-one", at: 2 },
        ],
        s2: [
          { kind: "user", text: "hi2", at: 1 },
          { kind: "agent-thought", messageId: "m2", text: "thought-two", at: 2 },
        ],
      },
      inTurn: {},
      stopReasons: {},
      closeReasons: {},
      configOptions: {},
    });
    render(<ChatStream />);
    // s1's thinking block is collapsed by default…
    expect(screen.queryByText("thought-one")).toBeNull();
    // …and expands on click.
    fireEvent.click(screen.getByTestId("reasoning-trigger"));
    expect(screen.getByText("thought-one")).toBeTruthy();
    // Switching sessions must NOT reuse the same Reasoning instance at
    // the same index: s2's block starts collapsed (no inherited
    // expanded state or duration) and s1's content is gone.
    act(() => {
      useSessions.setState({ activeSessionId: "s2" });
    });
    expect(screen.queryByText("thought-two")).toBeNull();
    expect(screen.queryByText("thought-one")).toBeNull();
  });

  it("window-level drop backstop prevents navigation (drop outside the composer)", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    // The window `drop` listener (registered in `useEffect`, present after
    // `render`'s `act` flush) swallows file drops OUTSIDE the composer — the
    // webview's default for a file drop would otherwise NAVIGATE to the file
    // (replacing the app; the reason `dragDropEnabled: false` + this
    // backstop exist). `fireEvent` returns `!defaultPrevented` → `false`
    // when the listener's `preventDefault` marked the event.
    const intercepted = fireEvent.drop(window, {
      dataTransfer: {
        files: [
          new File([new Uint8Array([1])], "w.png", { type: "image/png" }),
        ],
      },
    });
    expect(intercepted).toBe(false);
    // The event targeted `window` (the top of the tree — it does NOT bubble
    // down through the composer), so the composer's `onDrop` (`handleDrop`)
    // never fired: the drop was swallowed, NOT staged.
    expect(screen.queryByAltText("w.png")).toBeNull();
    // `dragover` variant: a file drag anywhere on the page must make the
    // page a valid drop target (otherwise the browser shows the "no-drop"
    // cursor and the drop would navigate).
    expect(fireEvent.dragOver(window, { dataTransfer: {} })).toBe(false);
  });

  it("shows the single placeholder for an image-capable fresh session (the capability if/else is gone)", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    expect(
      screen.getByPlaceholderText("Ask for follow-up changes"),
    ).toBeTruthy();
  });

  it("switching sessions clears staged attachments", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    expect(screen.getByAltText("s.png")).toBeTruthy();
    // The `act` wrap is required — the session-change effect's `setAttachments`
    // only reliably flushes inside `act`.
    await act(async () => {
      useSessions.setState({
        activeSessionId: "s2",
        sessions: [
          {
            sessionId: "s2",
            cwd: "/home/u/proj",
            capabilities: {},
            archived: false,
          },
        ],
      });
    });
    expect(screen.queryByAltText("s.png")).toBeNull();
    // The session-change effect released the staged attachment (NOT just
    // cleared the strip) — the object URL was revoked. `toHaveBeenCalledWith`
    // (NOT `toHaveBeenCalledTimes`): `beforeEach`'s `vi.clearAllMocks()`
    // clears the call history per test, but a `some`-style assertion stays
    // robust if that ever changes.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
  });
});

describe("ChatStream — send wiring: images ride along with the prompt (Task 5)", () => {
  // --- Send wiring: images ride along with the prompt (Task 5). ---

  it("send delivers images with the prompt", async () => {
    seedLiveSessionWithImages();
    const { container } = render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // `send()` is ASYNC (it awaits the FileReader read before `sendPrompt`) —
    // wait on the outcome, never assert synchronously.
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "look at this", [
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]),
    );
    // The store's last user message carries the images.
    const msgs = useSessions.getState().messages.s1;
    const last = msgs[msgs.length - 1];
    expect(last).toMatchObject({ kind: "user", text: "look at this" });
    if (last?.kind === "user") {
      expect(last.images).toEqual([
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]);
    } else {
      expect(last).toBeNull();
    }
    // The composer thumbnail is GONE after success (released + cleared —
    // scoped to the composer: the transcript now renders the image too).
    const composer = container.querySelector('[data-testid="composer-island"]')!;
    const remaining = screen.getAllByAltText("s.png");
    expect(remaining.some((el) => composer.contains(el))).toBe(false);
    // …while the transcript renders it (the `data:` URL, read-only).
    expect(remaining).toHaveLength(1);
    expect(remaining[0].getAttribute("src")).toBe(
      "data:image/png;base64,AQID",
    );
  });

  it("staged thumbnails leave the composer AT SEND, not when the send resolves", async () => {
    seedLiveSessionWithImages();
    const { container } = render(<ChatStream />);
    // `sendPrompt` stays PENDING for the whole window under test: every
    // assertion below runs while the turn is still in flight, so a clear that
    // only happens after the promise resolves CANNOT be what satisfies them.
    // This is the test that pins the bug (the thumbnails used to sit in the
    // composer for the entire turn, even though the base64 copies had already
    // been handed to the user message).
    const inflight = deferred<StopReason>();
    vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The wait proves `send()` got PAST `addUserMessage`/`beginTurn` and is now
    // sitting inside `sendPrompt` — exactly the window the bug leaves a stale
    // copy on screen.
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    const composer = container.querySelector('[data-testid="composer-island"]')!;
    // Exactly ONE copy of the image is on screen: the transcript's `data:`
    // render. The composer holds none. (Wrapped in `waitFor` because the
    // composer-clearing `setAttachments` lands outside `act`; it can never
    // become true later in this test, so the wait cannot false-green.)
    await waitFor(() => {
      const copies = screen.getAllByAltText("s.png");
      expect(copies).toHaveLength(1);
      expect(copies[0].getAttribute("src")).toBe("data:image/png;base64,AQID");
      expect(copies.some((el) => composer.contains(el))).toBe(false);
    });
    // NOT released while the turn runs — a failed send has to be able to put
    // the thumbnail back, and a revoked object URL renders nothing.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-s.png");
    // Settling the turn releases it for good (and nothing reappears).
    await act(async () => {
      inflight.resolve("end_turn");
    });
    await flush();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
    expect(
      screen.getAllByAltText("s.png").some((el) => composer.contains(el)),
    ).toBe(false);
  });

  it("switching sessions while a send is in flight releases the LEFT session's held attachment", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    const inflight = deferred<StopReason>();
    vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    // Switch away mid-turn. The release point inside the session-change
    // effect only knows the session being ENTERED (`s2`), so the cleanup must
    // read the held list under the id of the session being LEFT (`s1`) —
    // otherwise the entry is dropped later by the failure path's `delete`
    // without ever being released (a permanent leak).
    await act(async () => {
      useSessions.setState({
        activeSessionId: "s2",
        sessions: [
          {
            sessionId: "s1",
            cwd: "/home/u/proj",
            capabilities: { promptCapabilities: { image: true } },
            archived: false,
          },
          {
            sessionId: "s2",
            cwd: "/home/u/proj",
            capabilities: {},
            archived: false,
          },
        ],
      });
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
    await act(async () => {
      inflight.resolve("end_turn");
    });
  });

  it("a non-Error rejection shows the message, not [object Object]", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    // Tauri IPC errors arrive as plain objects, not `Error` instances.
    vi.mocked(sendPrompt).mockRejectedValueOnce({
      kind: "error",
      message: "proto",
    });
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("proto")).toBeTruthy());
  });

  it("an image-only send is blocked when the capability regresses mid-session (a marker is not prose)",
    async () => {
      // `hasImages` exists for exactly one case a session switch cannot produce:
      // a same-session capability regression. With the draft now reading
      // `[image #1]` instead of `""`, the "image-only send is blocked" rule
      // needs to see a marker-only draft as no prose — otherwise the sentence
      // "here is [image #1]" ships to an agent that receives NO image.
      seedLiveSessionWithImages();
      render(<ChatStream />);
      pasteToComposer([
        new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
      ]);
      await act(async () => {
        useSessions.setState({
          sessions: [
            { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
          ],
        });
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await flush();
      expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
    });

  it("image-only send is allowed", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    // No text typed — the send button is enabled for an image-only send.
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(sendButton);
    // The text is now `"[image #1]"`, NOT `""` — and that is the intended
    // semantics of this task: a bare screenshot paste now TELLS the model which
    // image it is (the marker names the Nth image of this prompt, which is the
    // only reading the wire supports), instead of sending an empty prompt with an
    // anonymous image attached.
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #1]", [
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]),
    );
  });

  it("empty composer with no attachments: send stays disabled", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("double-send is guarded by sendingRef", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    expect(screen.getByAltText("s.png")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi" },
    });
    const sendButton = screen.getByRole("button", { name: "Send" });
    // Two synchronous clicks BEFORE the first send's FileReader `await`
    // resolves: `beginTurn` (which would lock the composer) runs only AFTER
    // the read, so the composer is still unlocked for the second click —
    // the race the `sendingRef` guard exists for. Without it, both `send()`
    // calls would reach `sendPrompt`.
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);
    // Exactly ONE send, even though the composer was not locked during the
    // first send's FileReader await. Assert the count only AFTER both send
    // continuations have run: a `toHaveBeenCalledTimes(1)` inside `waitFor`
    // would pass the moment it first observed one call — a false-green window
    // if the `sendingRef` guard were removed, since the second send's
    // continuation lands a few ms after the first while `waitFor` samples
    // every 50 ms.
    await waitFor(() => expect(vi.mocked(sendPrompt)).toHaveBeenCalled());
    await flush();
    expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1);
  });

  it("send is fail-closed without the capability", async () => {
    seedLiveSession(); // capabilities {}
    render(<ChatStream />);
    // Task 4: NOT staged (the helper returns `true` — default paste).
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // A 2-arg call with NO images argument, even though a `File` was on the
    // clipboard (the `imageCapable` guard in `send()`).
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "text"),
    );
  });
});

describe("ChatStream — mid-read races (the composer is not locked until beginTurn)", () => {
  // --- Mid-read races: the composer is NOT locked until `beginTurn` (which
  // runs only AFTER the FileReader `await`), so the session can switch and
  // thumbnails can be removed DURING the read. `send()` must reconcile
  // against the LIVE state after the `await`, not the stale closure. ---

  it("send is aborted if the session switches during the read", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi" },
    });
    // Fake timers BEFORE the send: the read is macrotask-based in jsdom, so
    // faking the timer and advancing it settles the read deterministically
    // (a bare `waitFor` on a negative predicate would pass on the first poll
    // — false green — because the read hasn't settled yet).
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the read settles) switch sessions — the same
    // `act` pattern as `switching sessions clears staged attachments`.
    await act(async () => {
      useSessions.setState({
        activeSessionId: "s2",
        sessions: [
          {
            sessionId: "s2",
            cwd: "/home/u/proj",
            capabilities: {},
            archived: false,
          },
        ],
      });
    });
    // Let the pending FileReader read settle (the continuation then runs and
    // sees the live `activeSessionIdRef` changed → aborts).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // `send()` aborted: it never reached `sendPrompt` (no send to the stale
    // `s1`).
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
    // The draft is PRESERVED (the abort `return` runs before `setDraft("")`):
    // the textarea (now `s2`'s) still holds "hi".
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hi");
    // NO user message was added to either session's transcript.
    const msgs = useSessions.getState().messages;
    expect((msgs.s1 ?? []).some((m) => m.kind === "user")).toBe(false);
    expect((msgs.s2 ?? []).some((m) => m.kind === "user")).toBe(false);
  });

  it("an image removed during the read is not sent", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the FileReader resolves) remove the thumbnail —
    // the composer isn't locked until `beginTurn`, so the removal happens
    // during the read.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove image attachment" }),
    );
    // `send()` is ASYNC (it awaits the FileReader read before `sendPrompt`) —
    // wait on the outcome (a 2-arg `sendPrompt` call, images filtered out),
    // never assert synchronously.
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "text"),
    );
  });

  it("an image-only send with the image removed during the read sends nothing", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    // No text typed — an image-only send.
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the read settles) remove the thumbnail.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove image attachment" }),
    );
    // Let the pending FileReader read settle (the continuation then runs and
    // sees every image removed + no text → nothing left to send).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // `send()` aborted (nothing meaningful left to send): `sendPrompt` was
    // NEVER called. (A bare `waitFor` on the negative would be false green —
    // the fake-timer advance guarantees the read has settled first.)
    // WHICH guard catches this: removing the thumbnail also removes its
    // `[image #1]` marker (`removeAttachment` → `renumberImageMarkers`), so the
    // draft is empty by the time the read lands and the STALE-DRAFT GUARD
    // (`draftRef.current.trim() !== rawText`) aborts the send — it fires before
    // the images-empty block below, which no longer sees an empty text to
    // reject. Don't read the images-empty path as the only thing protecting an
    // image-only send: with markers in play the draft guard is the first line.
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
  });

  it("a draft edited during the read is not sent and is not wiped", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "original" },
    });
    // Fake timers BEFORE the send: the read is macrotask-based in jsdom, so
    // faking the timer and advancing it settles the read deterministically
    // (a bare `waitFor` on a negative predicate would pass on the first poll
    // — false green — because the read hasn't settled yet).
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the read settles) edit the draft — the composer
    // isn't locked until `beginTurn`, so the edit happens during the read.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "original + more" },
    });
    // Let the pending FileReader read settle (the continuation then runs and
    // sees the live draft differs from the stale captured `text` → aborts).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // `send()` aborted (the draft changed during the read): `sendPrompt` was
    // NEVER called — neither the stale text nor the new one was sent.
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
    // The NEW draft is PRESERVED (the abort `return` runs before
    // `setDraft("")`): the textarea still holds the edited text.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "original + more",
    );
    // NO user message was added to the transcript.
    const msgs = useSessions.getState().messages;
    expect((msgs.s1 ?? []).some((m) => m.kind === "user")).toBe(false);
  });

  it("Esc while a turn is in flight calls cancelSession for the active session", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // A turn is in flight (the composer is locked, `inTurn` true). The
    // re-render must settle BEFORE the keypress (the listener is registered
    // in an effect that runs on the re-render).
    useSessions.getState().beginTurn("s1");
    await act(async () => {});
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).toHaveBeenCalledWith("s1");
  });

  it("Esc with no turn in flight does NOT call cancelSession", async () => {
    seedLiveSession();
    render(<ChatStream />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("Esc while a turn is in flight of ANOTHER session does NOT call cancelSession", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // The turn is in flight for a DIFFERENT session (not the active one):
    // the listener is gated on the ACTIVE session's `inTurn`, so it is
    // not active and nothing is cancelled.
    useSessions.getState().beginTurn("other");
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("Esc on a focused agent question card dismisses the card WITHOUT cancelling the turn", async () => {
    seedLiveSession();
    // A pending agent question (no `toolCallId` → not queued; unanchored →
    // the card takes focus on mount, so its root div is the focusable
    // element an Esc keypress lands on).
    useInteractive.getState().addRequest("s1", {
      requestId: "req-ask",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
    });
    // A turn is in flight (the window Esc listener is active) — the Esc
    // meant for the card must NOT also cancel the turn.
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    // The listener is registered in an effect — settle the re-render
    // before the keypress.
    await act(async () => {});
    // The card root is the focusable element (`tabIndex={-1}`).
    const card = screen.getByText("Which approach?").closest(
      "[tabindex='-1']",
    );
    expect(card).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(card!, { key: "Escape" });
    });
    // The card's own Esc handler dismissed the request (cancelled)…
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
    // …and the window listener did NOT fire (no `session/cancel`).
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("Esc on the sudo password modal's input dismisses the modal WITHOUT cancelling the turn", async () => {
    seedLiveSession();
    useInteractive.getState().addRequest("s1", {
      requestId: "req-pw",
      method: "password",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    // A turn is in flight (the window Esc listener is active).
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    await act(async () => {});
    const input = screen.getByRole("textbox", { name: "Password" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    // The modal's Esc handler dismissed the request (cancelled)…
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
    // …and the window listener did NOT fire (no `session/cancel`).
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("a resumed session whose FRESH agent lacks image capability sends text-only without the staged image (no stale capability)", async () => {
    // The STORED session's SAVED capabilities advertise images (an older
    // agent) — so the paste is staged and the send button is enabled.
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    // The FRESH agent (the resume result) does NOT advertise images.
    vi.mocked(resumeSession).mockResolvedValueOnce({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true },
      archived: false,
    });
    render(<ChatStream />);
    pasteToComposer(
      [new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" })],
    );
    expect(screen.getByAltText("s.png")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith("s1", "/home/u/proj"),
    );
    // Fail-closed: the fresh agent can't take images → 2-arg send, the
    // image is NOT attached (and not sent a second time).
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "look at this"),
    );
    expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1);
  });

  it("an image-only send on a resumed session whose FRESH agent lacks image capability is blocked (fail-closed)", async () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    vi.mocked(resumeSession).mockResolvedValueOnce({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true },
      archived: false,
    });
    render(<ChatStream />);
    pasteToComposer(
      [new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" })],
    );
    // No text — an image-only send (enabled by the SAVED capability).
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith("s1", "/home/u/proj"),
    );
    // Blocked: no prompt is sent (an empty prompt + unsent images is
    // meaningless — the same fail-closed posture as `!imageCapable`). With the
    // `[image #1]` marker now IN the draft this also pins that the guard sees a
    // marker-only draft as "no prose" (`draftIsMarkerOnly`) — otherwise the
    // marker alone would carry the prompt through to an agent that receives no
    // image at all.
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
  });
});

// ── The `[image #N]` staging marker ───────────────────────────────────────
//
// Every path that stages an image leaves a marker in the draft, and the marker
// travels to the model as part of the prompt (so a prompt can name a specific
// attachment). `N` counts the attachments of THAT message, never the session —
// the harness pushes the text block first and then the images in send order, so
// "the Nth image of this prompt" is the only reading a model can resolve.
//
// `stageFiles` is the single funnel for all four staging paths (paste-with-file-
// items, the WebKitGTK empty-paste clipboard fallback, drag-and-drop, and the `+`
// picker). The marker surface for those four paths moved to
// `src/hooks/useChatAttachments.test.tsx` with `stageFiles` (issue #135 §1);
// what is under test HERE is the marker's other half — the draft text that
// `send()` puts on the wire, and the `#`-collision mask that protects it.
describe("ChatStream — the [image #N] staging marker", () => {
  // The staging/marker/renumber surface itself (the four staging paths, the
  // caret rule, the batch numbering, the remove-and-renumber) moved to
  // `src/hooks/useChatAttachments.test.tsx` with `stageFiles` and
  // `removeAttachment` (issue #135 §1). What stays here is the half that needs
  // the real `send()`: the renumber → SEND linkage below, and the `#`-collision
  // / mask feed-forward pins after it — both of which expand the draft on the
  // wire, which the hook never does.

  it("the renumbered draft is what gets sent", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }),
    ]);
    pasteToComposer([
      new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" }),
    ]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove image attachment" })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #1]", [
        { name: "b.png", mimeType: "image/png", sizeBytes: 3, data: "BAUG" },
      ]),
    );
  });

  // ── The `#` collision (the task's one real risk) ─────────────────────────
  //
  // `MCP_MENTION_RE` is `/(^|\s)#([a-z0-9]+(?:-[a-z0-9]+)*)/g`, so `[image #3]`
  // IS a mention token (`3` is in the class, the `#` has its space). It survives
  // today only because no catalog entry is named `3` — and the Rust picker
  // predicate `is_mentionable_name` ACCEPTS digits (its own tests use `"0"` as
  // a positive case). So a server literally named `3` would make `expandMentions`
  // append an `<mcp name="3">` block to a prompt the user never asked for. The
  // mask in `send()` makes that structurally impossible.

  it("a marker never expands into an <mcp> block even when the catalog has a server of that number",
    async () => {
      seedLiveSessionWithImages();
      seedMcpMentionsOn();
      // THE collision case: a server literally named `3`.
      vi.mocked(listMcpServersEffective).mockResolvedValueOnce([
        { name: "3", kind: "stdio", summary: "a server named with a digit" },
      ]);
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      pasteToComposer(
        ["a", "b", "c"].map(
          (n) =>
            new File([new Uint8Array([1])], `${n}.png`, { type: "image/png" }),
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      // Byte-exact: the markers round-trip through the mask verbatim and NO
      // block is appended.
      expect(sent).toBe("[image #1] [image #2] [image #3]");
      expect(sent).not.toContain("<mcp");
    });

  it("the mask does NOT disable a real # mention sharing the draft with a marker",
    async () => {
      seedLiveSessionWithImages();
      seedMcpMentionsOn();
      // The MCP catalog is seeded LOCALLY, on purpose: a later describe — now in
      // `src/components/ChatStreamDirectoryCompletion.test.tsx`, where that block
      // moved (issue #135 §5) — seeds the MCP catalog with a persistent
      // `mockResolvedValue` (an implementation, which `clearAllMocks` does not
      // undo), so a test that relied on the default `postgres` row would pass
      // when run alone and fail in file order. The summary matches the
      // `postgres` block text asserted below.
      vi.mocked(listMcpServersEffective).mockResolvedValueOnce([
        { name: "postgres", kind: "stdio", summary: "npx -y x-mcp" },
      ]);
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      pasteToComposer([
        new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
      ]);
      // The user types around the marker (a `fireEvent.change` is exactly the
      // keystroke that does — the draft is plain text).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres [image #1]" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      expect(sent).toContain('<mcp name="postgres">');
      // And the marker survived the round trip, in place, unharmed.
      expect(sent.startsWith("query #postgres [image #1]")).toBe(true);
    });

  it("markers-only with no colliding catalog is sent BYTE-IDENTICAL", async () => {
    seedLiveSessionWithImages();
    seedMcpMentionsOn(); // the default catalog is `postgres` — no digit name
    render(<ChatStream />);
    await waitForCatalog(listSkills);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #1]", [
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]),
    );
  });

  // ── The mask sentinel is PASTABLE ────────────────────────────────────────
  //
  // `\uE000` is a Private Use Area codepoint: no keyboard produces it, but a
  // PASTE can carry any codepoint, and a log / data dump / mojibake'd file is
  // full of them. So the sentinel is not un-obtainable, and the un-mask is not
  // automatically a bijection. The two tests below are the two ways that
  // bites: an unpaired sentinel must not become the literal word "undefined",
  // and a draft holding both a marker and a stray sentinel must degrade to
  // sending the user's text UNEXPANDED rather than to corrupting it.

  it("a pasted mask sentinel in a marker-free prompt is sent BYTE-UNCHANGED",
    async () => {
      seedLiveSession(); // no attachments, so NO markers can exist to mask
      render(<ChatStream />);
      // A log line that happens to carry a PUA codepoint (the realistic shape:
      // data pasted in from elsewhere, not something the user typed).
      const pasted = "decode this: \uE000 and report";
      fireEvent.change(screen.getByRole("textbox"), { target: { value: pasted } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      // Byte-for-byte the user's text. An unbounded un-mask replacer returns
      // `undefined` for an unpaired sentinel and JS stringifies the result, so
      // the model would read "decode this: undefined and report".
      expect(sent).toBe(pasted);
      expect(sent).not.toContain("undefined");
    });

  it("a marker AND a pasted mask sentinel send UNEXPANDED (no block, no rewrite)",
    async () => {
      seedLiveSessionWithImages();
      seedMcpMentionsOn();
      // The catalog entry that makes skipping the expansion worthwhile: a
      // server literally named `3`, so a `#3` token in prose WOULD expand.
      vi.mocked(listMcpServersEffective).mockResolvedValueOnce([
        { name: "3", kind: "stdio", summary: "a server named with a digit" },
      ]);
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      pasteToComposer([
        new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
      ]);
      const draft = `look [image #1] at #3 and \uE000 tail`;
      fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      // The pathological draft (a marker to mask AND a stray sentinel to
      // restore) sends the user's own text UNEXPANDED: no `<mcp>` block for the
      // `#3` token that pass loses, because corrupting the prompt is worse than
      // one send without mention expansion.
      expect(sent).not.toContain("<mcp");
      expect(sent).toContain("[image #1]");
      // And the pasted sentinel survives as the byte it was, not as "undefined".
      expect(sent).toBe(draft);
    });
});

describe("ChatStream — the failed-send attachment restore", () => {
  /** The composer's current draft text. */
  function composerValue(): string {
    return (screen.getByRole("textbox") as HTMLTextAreaElement).value;
  }

  /** The composer strip's thumbnail file names, LEFT TO RIGHT — i.e. the
   * attachment ORDER the `[image #N]` markers count against. */
  function composerThumbs(): string[] {
    const composer = document.querySelector('[data-testid="composer-island"]')!;
    return Array.from(composer.querySelectorAll("img")).map(
      (el) => el.getAttribute("alt") ?? "",
    );
  }

  const png = (name: string, byte: number): File =>
    new File([new Uint8Array([byte, byte + 1, byte + 2])], name, {
      type: "image/png",
    });

  it("a failed send renumbers the draft when it re-prepends the held attachments",
    async () => {
      // The marker numbers are POSITIONAL (they count THIS message's
      // attachments in list order), and the restore merges the held list IN
      // FRONT of whatever was staged during the turn. So staging A, sending
      // (A leaves the list), then pasting B mid-turn numbers B `#1` — and a
      // restore that puts A back in front without moving the draft's numbers
      // leaves `[image #1]` naming A while the user means B: the next prompt
      // names the wrong picture, which is exactly what the marker contract
      // exists to prevent.
      seedLiveSessionWithImages();
      const inflight = deferred<StopReason>();
      vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
      render(<ChatStream />);
      pasteToComposer([png("a.png", 1)]);
      expect(composerValue()).toBe("[image #1]");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      // Wait until the send is genuinely IN FLIGHT: only then has the draft
      // been cleared and A moved to the held map (pasting earlier would edit
      // the draft mid-read, and `send()`'s stale-draft guard would abort the
      // send before `sendPrompt` — a different test entirely).
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      await flush();
      pasteToComposer([png("b.png", 4)]);
      // B is numbered against the list as it stands NOW (empty — A is held),
      // so it is `#1`. This is the premise of the bug, not a bug itself.
      expect(composerValue()).toBe("[image #1]");
      await act(async () => {
        inflight.reject(new Error("boom"));
      });
      await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
      // Both pictures are back, A first (the restore prepends).
      expect(composerThumbs()).toEqual(["a.png", "b.png"]);
      // …so B — still the picture the draft names — is position 2.
      expect(composerValue()).toBe("[image #2]");
      // And the contract end to end: the NEXT send ships the pictures in list
      // order with the marker naming the right one.
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #2]", [
        { name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
        { name: "b.png", mimeType: "image/png", sizeBytes: 3, data: "BAUG" },
      ]);
    });

  // `"a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the
  // overflow"` moved to `src/hooks/useChatAttachments.test.tsx` with the restore
  // itself (issue #135 §1) — it asserts the cap, the overflow release and the
  // shifted marker, all of which are now the hook's boundary. What stays here is
  // the end-to-end above: its SECOND send needs the real `sendText` +
  // `readAttachmentAsBase64`, which the hook test's relay cannot reproduce.
});

// ── Staging attachments WHILE a turn is in flight ───────────────────────────
//
// Clipboard paste has NEVER checked `composerLocked`: mid-turn it stages. Drag
// -and-drop and the `+` picker both refused, so the three routes disagreed —
// and the queue makes the disagreement a defect: a user who pastes a screenshot
// mid-turn and then queues a text prompt leaves the image stranded in the
// composer while the words travel. Un-gating the two paths makes every route
// stage, which is what makes "attachments queue with the text" TRUE.
//
// `imageCapable` is NOT part of this change: it stays the fail-closed
// CAPABILITY gate on all three paths, and `composerEnabled` stays on the picker
// (a session that cannot be sent to must not accumulate images). Send stays
// disabled — Enter reaches `send()`, which enqueues.
describe("ChatStream — staging attachments is allowed while a turn is in flight", () => {
  /** The composer strip's thumbnail file names (an EMPTY strip is the point). */
  function composerThumbs(): string[] {
    const composer = document.querySelector('[data-testid="composer-island"]')!;
    return Array.from(composer.querySelectorAll("img")).map(
      (el) => el.getAttribute("alt") ?? "",
    );
  }

  function queue(sessionId = "s1") {
    return useQueuedPrompts.getState().bySession[sessionId] ?? [];
  }

  const png = (name: string, byte: number): File =>
    new File([new Uint8Array([byte, byte + 1, byte + 2])], name, {
      type: "image/png",
    });

  /** Lock the composer the way a real turn does (`inTurn`, the store's ground
   * truth) — NOT a disabled textarea, which stays editable on purpose. */
  async function lockWithTurn(): Promise<void> {
    await act(async () => {
      useSessions.getState().beginTurn("s1");
    });
  }

  it("a drop STAGES while the composer is locked (the turn is not a capability check)",
    async () => {
      seedLiveSessionWithImages();
      render(<ChatStream />);
      await lockWithTurn();
      // The lock really is engaged — the store's ground truth, and the reason
      // `handleDrop` used to swallow this drop.
      expect(useSessions.getState().inTurn["s1"]).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).hasAttribute(
          "disabled",
        ),
      ).toBe(true);
      dropOnComposer([png("d.png", 1)]);
      expect(screen.queryByAltText("d.png")).toBeTruthy();
    });

  it("the `+` picker STAGES while the composer is locked (dialog opens, thumbnail appears)",
    async () => {
      seedLiveSessionWithImages();
      render(<ChatStream />);
      await lockWithTurn();
      vi.mocked(openFilePicker).mockResolvedValueOnce(["/home/u/pics/shot.png"]);
      vi.mocked(readFileBytes).mockResolvedValueOnce([
        0x89, 0x50, 0x4e, 0x47, 1, 2, 3,
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
      // The dialog opened — the button is NOT disabled mid-turn.
      expect(vi.mocked(openFilePicker)).toHaveBeenCalledTimes(1);
      // And the picked image reached the strip through the SAME `stageFiles`
      // funnel as the paste / drop.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Remove image attachment" }),
        ).toBeTruthy(),
      );
      expect(screen.getByAltText("shot.png")).toBeTruthy();
      // Send is STILL disabled mid-turn: staging is allowed, dispatching is not.
      expect(
        (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).hasAttribute(
          "disabled",
        ),
      ).toBe(true);
    });

  it("an image dropped mid-turn queues WITH the next prompt instead of stranding",
    async () => {
      seedLiveSessionWithImages();
      render(<ChatStream />);
      await lockWithTurn();
      // Mid-turn staging (the drop, the route this task un-gates).
      dropOnComposer([png("d.png", 1)]);
      expect(composerThumbs()).toEqual(["d.png"]);
      // Plain prose (no marker) — the attachment travels with the entry
      // regardless of whether the draft names it.
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "check the screenshot" },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      // Not dispatched — the lock still holds the wire.
      expect(sendPrompt).not.toHaveBeenCalled();
      const entry = queue()[0];
      expect(entry).toBeTruthy();
      expect(entry!.text).toBe("check the screenshot");
      // THE POINT OF THE TASK: the image went with the words.
      expect(entry!.attachments.map((a) => a.filename)).toEqual(["d.png"]);
      expect(entry!.attachments[0]!.objectUrl).toBe("blob:mock-d.png");
      // The object URL MOVED (never revoked-and-recreated — revoking here would
      // kill both the queue row's preview and the later send's file).
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-d.png");
      // The composer's strip is EMPTY — nothing stranded behind.
      expect(composerThumbs()).toEqual([]);
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("");
    });

  it("`!imageCapable` still blocks the drop and the `+` picker mid-turn (fail-closed)",
    async () => {
      seedLiveSession(); // capabilities: {} — NOT image-capable
      render(<ChatStream />);
      await lockWithTurn();
      dropOnComposer([png("d.png", 1)]);
      expect(screen.queryByAltText("d.png")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
      await flush();
      // The capability gate — not the turn — is what refuses: the dialog never
      // opened and nothing was staged.
      expect(vi.mocked(openFilePicker)).not.toHaveBeenCalled();
      expect(composerThumbs()).toEqual([]);
    });
});

// ── The empty-state film and the prompt queue, in the same pane ──────────────
//
// The film was written before the queue existed. `EmptyStateFilm`'s layer is an
// `absolute inset-0` box on the transcript's scroll container, and the queue
// stack sits BELOW that container as a sibling island — so the two are meant to
// be independent. That independence is exactly the kind of thing a merge
// silently breaks (moving the stack inside `<main>`, or keying the film on
// something the queue changes, would both collide), so it is pinned here rather
// than left to reading the layout.
describe("ChatStream — the empty-state film beside a non-empty prompt queue", () => {
  it("keeps the empty-state cue and the queue rows both rendered and separate", () => {
    seedLiveSession();
    render(<ChatStream />);
    // A `failed` entry is the state where BOTH are legitimately on screen: the
    // session is IDLE (so the film's three-term condition holds and the
    // transcript is still empty), yet `takeHead` skips the failed entry, so
    // nothing sends and the row stays visible. An ordinary queued entry cannot
    // probe this — the idle edge Flushes it, which adds a user row and takes the
    // transcript out of the empty branch.
    act(() => {
      useQueuedPrompts.getState().enqueue("s1", {
        id: "q-film",
        text: "queued while the film plays",
        attachments: [],
        state: "queued",
      });
    });
    act(() => {
      const [entry] = useQueuedPrompts.getState().bySession["s1"];
      useQueuedPrompts.getState().requeueHead("s1", { ...entry, failed: true });
    });
    const cue = screen.getByText("Send a prompt to start");
    const rows = screen.getByTestId("queue-rows");
    expect(rows.textContent).toContain("queued while the film plays");
    // STRUCTURAL separation: the film belongs to the transcript island, the
    // stack is outside it. If the stack ever moves inside `<main>`, the film's
    // `absolute inset-0` layer would cover it.
    const main = document.querySelector("main")!;
    expect(main.contains(cue)).toBe(true);
    expect(main.contains(rows)).toBe(false);
    expect(main.nextElementSibling).toBe(rows);
    // The film's own layer is bounded by the transcript island: the scroll
    // container it renders into is `relative`, so the canvas variant's
    // `absolute inset-0` (pinned in `EmptyStateFilm.test.tsx`) resolves against
    // THAT box — inside `<main>` — and can never overlay a row in the stack.
    // Under jsdom there is no WebGL, so what is on screen here is the film's
    // FALLBACK text line; its parent is the scroll container itself.
    const scroll = screen.getByTestId("transcript-scroll");
    expect(scroll.className).toContain("relative");
    expect(main.contains(scroll)).toBe(true);
    expect(scroll.contains(cue)).toBe(true);
    expect(scroll.contains(rows)).toBe(false);
    expect(cue.closest('[data-testid="queue-rows"]')).toBeNull();
  });

  it("does not render the film while a turn is in flight (the queue's own state)", () => {
    seedLiveSession();
    render(<ChatStream />);
    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    act(() => {
      useQueuedPrompts.getState().enqueue("s1", {
        id: "q-film-busy",
        text: "queued",
        attachments: [],
        state: "queued",
      });
    });
    // The three-term empty-branch condition is UNCHANGED by the film work, and
    // a busy session fails it — so no film, and no fight with the queue.
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
    expect(screen.getByTestId("queue-rows")).toBeTruthy();
  });
});
