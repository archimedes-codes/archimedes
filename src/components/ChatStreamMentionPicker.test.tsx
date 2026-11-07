/**
 * `ChatStream` — the mention / file-completion picker cluster (FE3, issue 1107).
 *
 * These 62 tests were MOVED VERBATIM out of `src/components/ChatStream.test.tsx`:
 * the seven banner groups that sat at the tail of its `describe("ChatStream")`
 * block — the `$`/`#`/`@` picker, the Task 6 and Task 5 composer-mentions
 * groups, the review follow-ups, the `#` MCP toggle, the `?` File completion
 * group (with its three-case `it.each` render-cap pin) and the picker geometry
 * group. `it` titles and assertion bodies are byte-identical to the residual's;
 * nothing was added, removed or improved.
 *
 * WHY they left as ONE block: they are ONE subject — the trigger picker and the
 * `expandMentions` send-path it feeds (ADR 0031/0033). The finding this split
 * answers is a `describe` that spanned eighteen subjects, not a file that was
 * long; carving a single coherent subject into seven files would move tests
 * away from the one seam they all exercise for no navigational gain.
 *
 * WHAT STAYED in `ChatStream.test.tsx`: the ten residual subject groups, now
 * each under its own subject-named `describe` (the block that held them no
 * longer exists), and the four attachment/queue integration groups.
 *
 * WHY the `vi.mock` factories are INLINE here and not delegated to
 * `src/test/chatStreamFixtures.ts`: that module imports `useSessions` /
 * `useSettings`, whose stores import `../lib/tauri`, so it HAS a transitive path
 * into the mocked barrel, and a factory body may reference only bindings from a
 * module free of that path — a delegation fails as 0 tests run with
 * `Cannot access '__vi_import_N__' before initialization` (measured; the probe
 * matrix in `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`,
 * and pinned by `src/test/chatStreamFixtures.test.ts`). Both factories below
 * therefore touch nothing but `vi` and their own `vi.importActual` result, and
 * the fixtures import stays AFTER the `ChatStream` import. This file is
 * therefore the new mocker the mock-seam pin in `src/lib/tauriBarrel.test.ts`
 * counts (45 -> 46 mockers, 44 -> 45 spreaders); dissolving the residual
 * `describe` into subject describes costs no mocks at all, so this file is the
 * ONLY new mocker this split adds.
 */

import { beforeEach, describe, expect, it, vi, beforeAll, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatStream from "./ChatStream";
import {
  sendPrompt,
  listSkills,
  listMcpServersEffective,
  listAgentDefinitionsForSpace,
  listSpaceListing,
  type ListingDto,
  type AgentDefinitionDto,
} from "../lib/tauri";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { useSessions } from "../store/sessions";
import { IPC_EVENTS } from "../lib/ipc/events";
import {
  PERSISTED_MCP_MESSAGE,
  seedLiveSession,
  seedMcpMentionsOn,
  seedMcpMentionsOff,
  flush,
  waitForCatalog,
} from "../test/chatStreamFixtures";
import { resetStores } from "../test/resetStores";

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
//    on `Element.prototype` only, and two tests below read
//    `HTMLElement.prototype.scrollIntoView` directly and inspect
//    `mock.contexts` to learn WHICH picker row scrolled. Without this own-property
//    override that read is `undefined` and the calls land on the inherited
//    `Element` stub — so this is a dependency, not a duplicate.
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

describe("ChatStream — the mention/file-completion pickers (ADR 0031/0033)", () => {
  // --- Mentions: the `$`/`#`/`@`-trigger picker + the send-path expansion.
  // One picker, filtered to the active prefix's catalog; rows carry a prefix
  // badge. The send-path expansion assertions below are the `expandMentions`
  // regressions (all three catalogs).

  it("typing $ opens the mention picker with the skill rows ($ badge)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // A bare `$` (empty token remainder) opens the picker with the FULL list.
    // The catalog arrives via an ASYNC effect (the `listSkills` mock), so the
    // picker only renders once the fetch resolves — `findByText` awaits both
    // the fetch and the render.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$" } });
    await screen.findByText("debug");
    // One row per skill, each with a `$` prefix badge (the generalization's
    // only visual delta vs the old skill picker).
    const picker = screen.getByTestId("mention-picker");
    expect(picker.querySelectorAll("button")).toHaveLength(2);
    // The prefix badge is the `text-ui-xs` span (the only such span per row).
    const firstBadge = picker.querySelector(".text-ui-xs")!;
    expect(firstBadge.textContent).toBe("$");
  });

  it("typing # opens the picker with the MCP rows (# badge)", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    // `#` → the ACTIVE prefix's catalog is the effective MCP servers (the
    // `listMcpServersEffective` mock). `findByText` awaits the async fetch.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
    const row = await screen.findByText("postgres");
    // The `#` badge is on the row (the `@`/`$` glyphs must not mix in).
    expect(row.closest("button")!.querySelector(".text-ui-xs")!.textContent).toBe("#");
    // The skill catalog is NOT listed under `#` (no mixing).
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("typing @ opens the picker with the agent rows (@ badge)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // `@` → the ACTIVE prefix's catalog is the agent definitions (the
    // `listAgentDefinitionsForSpace` mock). `findByText` awaits the async fetch.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });
    const row = await screen.findByText("scout");
    // The `@` badge is on the row (the `#`/`$` glyphs must not mix in).
    expect(row.closest("button")!.querySelector(".text-ui-xs")!.textContent).toBe("@");
    // Neither the MCP server nor a skill mixes in under `@`.
    expect(screen.queryByText("postgres")).toBeNull();
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("a mixed draft lists only the prefix of the token at the caret", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // The caret is at the END of what is typed (where a user's caret sits
    // after typing). Caret on the `$a` token → the picker is on the `$`
    // prefix: the skill row `beta` matches the `a` substring, and NO `#`/
    // `@` row mixes in (a `$`/`#`/`@` never mixes in one open list).
    fireEvent.change(textarea, { target: { value: "$a" } });
    expect(await screen.findByText("beta")).toBeTruthy();
    expect(screen.queryByText("postgres")).toBeNull();
    expect(screen.queryByText("scout")).toBeNull();
    // The user keeps typing to the `#pos` token: the picker flips to the `#`
    // prefix (the `postgres` server matches `pos`) and the `$` row drops out.
    fireEvent.change(textarea, { target: { value: "$a #pos" } });
    expect(await screen.findByText("postgres")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("the picker filters as the token is typed", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // `$de` → the single `debug` skill matches (the catalog is still loading
    // here — `findByText` awaits it).
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$de" } });
    await screen.findByText("debug");
    // `$zzz` → no name contains `zzz` → the picker is not visible. The catalog
    // is already warm at this point, so no await is needed for the change.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$zzz" } });
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("enter selects the highlighted skill and inserts the token", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // catalog ready, picker open
    // The caret is at the END of the text (where a user's caret is after
    // typing — jsdom's `selectionStart` is 0 by default).
    textarea.setSelectionRange(3, 3);
    // Enter selects the highlighted row (`debug`) and inserts `$debug `.
    fireEvent.keyDown(textarea, { key: "Enter" });
    // The draft is local `useState` in `ChatStream` (NOT in any store) — read
    // it back from the TEXTAREA's `value` on the next render.
    expect(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    ).toBe("$debug ");
    // The picker is closed after selection.
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("escape closes the picker without inserting", async () => {
    seedLiveSession();
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$de" } });
    await screen.findByText("debug"); // catalog ready, picker open
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    // The picker is gone…
    expect(screen.queryByText("debug")).toBeNull();
    // …and the draft is UNCHANGED (no insertion).
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("$de");
  });

  it("send expands the mention before addUserMessage and sendPrompt", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // Ensure the catalog is loaded (the expansion depends on it) — the picker
    // is NOT open here (the trailing space closes it), so `findByText` can't
    // be the wait signal.
    await waitForCatalog(listSkills);
    // The trailing space ends the active token → the picker is NOT open and
    // Enter is NOT intercepted by the picker's `selectMention` branch. `rawText`
    // = `draft.trim()` = `fix $debug`.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "fix $debug " },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    // The expanded text (the exact pi-format block, Task 3).
    const expanded =
      'fix $debug\n\n<skill name="debug" location="/s/.agents/skills/debug/SKILL.md">' +
      "\nReferences are relative to /s/.agents/skills/debug." +
      "\n\nStep 1. Step 2.\n</skill>";
    // `addUserMessage` got the EXPANDED text (the live bubble = the agent
    // input — the REFINEMENT invariant).
    const msgs = useSessions.getState().messages["s1"];
    const userMsg = msgs?.find((m) => m.kind === "user");
    expect(userMsg).toBeTruthy();
    if (userMsg?.kind === "user") {
      expect(userMsg.text.startsWith("fix $debug")).toBe(true);
      expect(userMsg.text).toContain(
        '<skill name="debug" location="/s/.agents/skills/debug/SKILL.md">',
      );
      expect(userMsg.text).toContain(
        "References are relative to /s/.agents/skills/debug.",
      );
      expect(userMsg.text).toContain("Step 1. Step 2.");
      expect(userMsg.text).toBe(expanded);
    }
    // `sendPrompt` got the SAME expanded text (the 2-arg form — no images).
    expect(sendPrompt).toHaveBeenCalledWith("s1", expanded);
  });

  it("an unmatched token is sent verbatim", async () => {
    seedLiveSession();
    render(<ChatStream />);
    await waitForCatalog(listSkills);
    // `$nope` matches no skill → `expandMentions` finds no match and
    // returns the text UNCHANGED. The trailing space closes the picker.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi $nope " },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    // `rawText` is `hi $nope` and nothing was expanded.
    expect(sendPrompt).toHaveBeenCalledWith("s1", "hi $nope");
  });

  // --- Task 6 (composer-mentions): `send()` expands via the THREE-catalog
  // `expandMentions` (the `@` agent / `#` MCP soft blocks alongside the
  // hard `$` skill block). ---

  it("send expands an @ agent mention into the soft agent block",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "ping @scout " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      // The EXACT agent-block literal (Task 3) — the `—` is an EM DASH.
      const expanded =
        "ping @scout\n\n" +
        '<agent name="scout">' +
        "\nscout \u2014 Fast recon." +
        '\nThe user has explicitly named the agent definition "scout" for this' +
        '\nrequest. Dispatch a subagent with agentName "scout" to handle it' +
        "\n(the definition's frontmatter defines its model, tools, and system" +
        "\nprompt; your explicit tool params layer over the definition)." +
        "\n</agent>";
      // The live bubble and the agent input carry the SAME text (the
      // `mergeDedupeKey` invariant).
      const userMsg = useSessions
        .getState()
        .messages["s1"]?.find((m) => m.kind === "user");
      expect(userMsg?.kind === "user" ? userMsg.text : null).toBe(expanded);
      expect(sendPrompt).toHaveBeenCalledWith("s1", expanded);
      // End-to-end (the `done-when`): the LIVE bubble the send just appended
      // renders the soft-hint chip, not the raw block text.
      expect(screen.getByText("named by the user")).toBeTruthy();
      expect(screen.queryByText(/Dispatch a subagent with agentName/)).toBeNull();
    });

  it("send expands a # MCP mention into the soft mcp block",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      const expanded =
        "query #postgres\n\n" +
        '<mcp name="postgres">' +
        '\nThe user has explicitly named the MCP server "postgres" for this' +
        '\nrequest. Connect to it via the mcp tool (mcp({ connect: "postgres" }))' +
        "\nand use its tools. (Server summary: npx -y x-mcp.)" +
        "\n</mcp>";
      expect(sendPrompt).toHaveBeenCalledWith("s1", expanded);
    });

  it("send expands a mixed $ / @ / # draft into blocks in first-mention order",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "x $debug @scout #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      expect(sent.startsWith("x $debug @scout #postgres")).toBe(true);
      // One block per kind, appended in TEXT order (first-mention order).
      const skill = sent.indexOf('<skill name="debug"');
      const agent = sent.indexOf('<agent name="scout">');
      const mcp = sent.indexOf('<mcp name="postgres">');
      expect(skill).toBeGreaterThan(-1);
      expect(agent).toBeGreaterThan(skill);
      expect(mcp).toBeGreaterThan(agent);
    });

  it("an unmatched # token passes through byte-identically into the sent text",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      // `#nope` matches no MCP server → NO block and the token is NOT
      // stripped (the `mergeDedupeKey` byte-identity invariant).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "hi #nope " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "hi #nope");
    });

  it("an unmatched @ token passes through byte-identically into the sent text",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "hi @nope " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "hi @nope");
    });

  it("arrow_down_moves_the_highlight_and_enter_selects_the_second_row", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$" } });
    await screen.findByText("debug"); // catalog ready, picker open (2 rows)
    const debugRow = screen.getByRole("button", { name: /debug/ });
    const betaRow = screen.getByRole("button", { name: /beta/ });
    // `debug` (index 0) is highlighted by default.
    expect(debugRow.className).toContain("bg-surface-hover");
    expect(betaRow.className).not.toContain("bg-surface-hover");
    // The caret is at the END of the text (where a user's caret is after
    // typing the `$` — jsdom's `selectionStart` is 0 by default).
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    // The highlight moved to the `beta` row.
    expect(debugRow.className).not.toContain("bg-surface-hover");
    expect(betaRow.className).toContain("bg-surface-hover");
    // Enter selects the HIGHLIGHTED row (`beta`).
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("$beta ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("arrow_up_wraps_around_to_the_last_row", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$" } });
    await screen.findByText("debug"); // catalog ready, picker open (2 rows)
    const debugRow = screen.getByRole("button", { name: /debug/ });
    const betaRow = screen.getByRole("button", { name: /beta/ });
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "ArrowUp" }); // wraps to the LAST row (index 1)
    expect(betaRow.className).toContain("bg-surface-hover");
    expect(debugRow.className).not.toContain("bg-surface-hover");
    fireEvent.keyDown(textarea, { key: "ArrowUp" }); // back to index 0
    expect(debugRow.className).toContain("bg-surface-hover");
    // Enter selects the FIRST row.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("$debug ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("tab_accepts_the_highlighted_candidate", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$" } });
    await screen.findByText("debug"); // catalog ready, picker open
    textarea.setSelectionRange(1, 1);
    // Tab accepts the highlighted candidate (ZCode parity: `KEY_TAB_COMMAND`
    // → `selectOption(selectedIndex)` — the same handler Enter uses).
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("$debug ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("tab_with_the_picker_closed_falls_through", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello " } });
    // No `$` → the picker never opens.
    expect(screen.queryByText("debug")).toBeNull();
    // Tab is NOT intercepted (no `preventDefault` — `fireEvent` returns
    // `false` when the default was prevented) and the value is untouched.
    const notPrevented = fireEvent.keyDown(textarea, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(textarea.value).toBe("hello ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("enter_after_the_caret_leaves_the_token_closes_the_picker_instead_of_sending_or_swallowing", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // `$debug` matches the `debug` skill → the picker is open, the token
    // active at the caret.
    fireEvent.change(textarea, { target: { value: "$debug" } });
    await screen.findByText("debug"); // picker open
    // Move the caret AWAY from the token WITHOUT `onChange` (a mouse click
    // or Home does this — no keystroke fires `change`): the picker is now
    // STALE (it would still `selectMention` the highlighted `debug` on Enter
    // if the keydown didn't re-evaluate the token at the caret).
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "Enter" });
    // The stale picker must NOT swallow Enter: the picker closes AND the
    // message SENDS the draft as-typed (the send path expands the `$debug`
    // mention — the picker did not re-select or rewrite it: the verbatim
    // token stays in the text, the block is APPENDED by `send()`).
    // (The picker's CLOSED state is asserted via the picker's testid — the
    // skill's NAME now also renders in the sent message's collapsed skill
    // card header, so a text query is no longer a picker-only signal.)
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    expect(textarea.value).toBe("");
    const sent =
      "$debug\n\n" +
      '<skill name="debug" location="/s/.agents/skills/debug/SKILL.md">' +
      "\nReferences are relative to /s/.agents/skills/debug." +
      "\n\nStep 1. Step 2.\n</skill>";
    expect(sendPrompt).toHaveBeenCalledWith("s1", sent);
  });

  it("shift_enter_inserts_a_newline_with_the_picker_open", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // picker open
    textarea.setSelectionRange(3, 3);
    // Shift+Enter must NOT be intercepted (no `preventDefault` — the
    // browser default inserts a newline; jsdom doesn't run it, so the
    // value only changes if the handler itself changes it).
    const notPrevented = fireEvent.keyDown(textarea, {
      key: "Enter",
      shiftKey: true,
    });
    expect(notPrevented).toBe(true);
    // NOT a skill selection (the draft is unchanged — not `$debug `) and
    // NOT swallowed.
    expect(textarea.value).toBe("$de");
    // Model the browser default (the newline lands): the token ends at the
    // newline → the picker closes on `onChange`.
    fireEvent.change(textarea, { target: { value: "$de\n" } });
    expect(textarea.value).toBe("$de\n");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("shift_tab_falls_through_with_the_picker_open", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // picker open, token active
    textarea.setSelectionRange(3, 3);
    // Shift+Tab must NOT be intercepted (a11y: it moves focus BACKWARD —
    // the browser default; intercepting it would be a keyboard trap). No
    // `preventDefault` (`fireEvent` returns `false` when the default was
    // prevented) and the draft is unchanged.
    const notPrevented = fireEvent.keyDown(textarea, {
      key: "Tab",
      shiftKey: true,
    });
    expect(notPrevented).toBe(true);
    expect(textarea.value).toBe("$de");
    // The picker is still open (no selection happened).
    expect(screen.getByTestId("mention-picker")).toBeTruthy();
  });

  it("the_insert_event_closes_the_picker", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // The picker is open with a token active at the caret (the v1.1 flow:
    // the user typed `$x`, then clicks a SkillsDialog row).
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // picker open
    textarea.focus();
    textarea.setSelectionRange(3, 3); // caret at the end of the token
    // The `act` wrap is REQUIRED (the file's insert-event test convention):
    // a raw `dispatchEvent` does not flush React's state updates.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$beta " }),
      );
    });
    // The stale picker is CLOSED (no lingering popup until the next
    // keydown) …
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    // …and the inserted text was spliced at the caret.
    expect(textarea.value).toBe("$de$beta ");
  });

  it("the left-pane insert event appends at the caret", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // An existing draft, caret at the end (the focus + selection the event
    // reads from the ref/DOM).
    fireEvent.change(textarea, { target: { value: "hello " } });
    textarea.focus();
    textarea.setSelectionRange(6, 6);
    // The `act` wrap is REQUIRED: a raw `dispatchEvent` does not flush React's
    // state updates (the listener's `setDraft` would be invisible to a
    // synchronous assertion — the file's `fireEvent.paste` comment documents
    // this convention). No catalog dependency: the insert event is independent
    // of `listSkills`.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$debug " }),
      );
    });
    expect(textarea.value).toBe("hello $debug ");
  });

  // --- Task 5 (composer-mentions): the picker generalizes to `#` / `@`. ---

  it("enter selects an MCP row and inserts the #-token", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "#" } });
    await screen.findByText("postgres"); // catalog ready, picker open
    textarea.setSelectionRange(1, 1);
    // Enter selects the highlighted row and inserts `#postgres ` (LOWER-cased —
    // the inserted token must stay expandable).
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("#postgres ");
    expect(screen.queryByText("postgres")).toBeNull();
  });

  it("tab selects an agent row and inserts the @-token", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@" } });
    await screen.findByText("scout"); // catalog ready, picker open
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("@scout ");
    expect(screen.queryByText("scout")).toBeNull();
  });

  it("an unknown # token leaves the picker closed and the draft untouched", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // `#nosauch` matches no server in the catalog → no rows → the picker is
    // gated off (the token is untouched — no error, no stripping).
    fireEvent.change(textarea, { target: { value: "#nosauch" } });
    await waitFor(() => expect(vi.mocked(listMcpServersEffective)).toHaveBeenCalled());
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    expect(textarea.value).toBe("#nosauch");
  });

  // --- Review follow-ups (F3/F4/F6): the lowercase-insertion policy, the
  // `filtered` memo's catalog deps, and the picker row affordances. ---

  it("a picker selection inserts the LOWER-cased token even for an uppercase catalog name",
    async () => {
      // The case policy: tokens are lowercase-only, so a picker-selected row
      // must insert `<prefix><name.toLowerCase()> ` or the inserted token
      // could never expand on send (the regex is lowercase-only). The
      // catalog name stays VERBATIM only inside the expanded BLOCK.
      vi.mocked(listAgentDefinitionsForSpace).mockResolvedValueOnce([
        { name: "Scout", description: "Fast recon.", model: null, scope: "user" },
      ]);
      seedLiveSession();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "@" } });
      // The ROW shows the catalog name verbatim (`Scout`) …
      const row = await screen.findByText("Scout");
      expect(row.closest("button")).toBeTruthy();
      textarea.setSelectionRange(1, 1);
      // … but the INSERTED token is lowercased.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
    });

  it("a picker opened while the agents catalog is still loading shows the rows when the fetch resolves (no further keystroke)",
    async () => {
      // The `filtered` `useMemo` deps are `[skills, agents, mcpServers,
      // picker]`. Drop `agents` (or `mcpServers`) and the memo keeps the
      // EMPTY array it computed while the fetch was in flight — the picker
      // stays empty until the NEXT keystroke re-runs the memo.
      let resolveAgents: (rows: AgentDefinitionDto[]) => void = () => {};
      vi.mocked(listAgentDefinitionsForSpace).mockImplementationOnce(
        () => new Promise<AgentDefinitionDto[]>((r) => (resolveAgents = r)),
      );
      seedLiveSession();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // Open the picker on the `@` prefix while the agents fetch PENDING.
      fireEvent.change(textarea, { target: { value: "@" } });
      await waitFor(() =>
        expect(vi.mocked(listAgentDefinitionsForSpace)).toHaveBeenCalled(),
      );
      // Nothing to show yet (the fetch has not resolved).
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      // The fetch resolves — and NO further keystroke happens.
      await act(async () => {
        resolveAgents([
          {
            name: "scout",
            description: "Fast recon.",
            model: null,
            scope: "user",
          },
        ]);
        await Promise.resolve();
      });
      const row = screen.getByText("scout");
      expect(row.closest("button")!.querySelector(".text-ui-xs")!.textContent).toBe(
        "@",
      );
      // And the late row is SELECTABLE (the memo recomputed the rows, not
      // just the render): Enter inserts it.
      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
    });

  it("a mouse click on a # row inserts the token (mousedown, not click)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "#" } });
      const row = (await screen.findByText("postgres")).closest("button")!;
      textarea.focus();
      textarea.setSelectionRange(1, 1);
      // The row handles `onMouseDown` with `preventDefault` (so the textarea
      // never loses focus to the button) — a `click` would NOT select.
      const notPrevented = fireEvent.mouseDown(row);
      expect(notPrevented).toBe(false);
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "#postgres ",
      );
      // The picker closed after the mouse selection.
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("a # row's description (the MCP summary) renders as a title tooltip",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
      const row = (await screen.findByText("postgres")).closest("button")!;
      // The `#` catalog has no `description` field — the row's tooltip is the
      // server's one-line `summary`. Queried as the SECONDARY line, not as
      // "the first `[title]` in the row": the PRIMARY line carries a `title` too
      // (the full label of a truncated path), so the old proxy would have found
      // the name span and passed for the wrong reason.
      const desc = row.querySelector(".text-ui-sm")!;
      expect(desc.getAttribute("title")).toBe("npx -y x-mcp");
      expect(desc.textContent).toBe("npx -y x-mcp");
    });

  it("a mouse click on an @ row inserts the token (mousedown, not click)",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "@" } });
      const row = (await screen.findByText("scout")).closest("button")!;
      textarea.focus();
      textarea.setSelectionRange(1, 1);
      // The `@` (agents) twin of the `#` test above: the row handles
      // `onMouseDown` with `preventDefault` (so the textarea never loses focus
      // to the button) — a `click` would NOT select.
      const notPrevented = fireEvent.mouseDown(row);
      expect(notPrevented).toBe(false);
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
      // The picker closed after the mouse selection.
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("an @ row's TOOLTIP is its PRIMARY label (the name), never its secondary line",
    async () => {
      // The label span's `title` is what hover shows for a CLIPPED row, so it
      // must be the text the row renders FIRST. On a `?` row primary == the full
      // path (pinned in the long-path test); on a two-line row here they differ,
      // and that is the case that decides what `title` means: if it fell back to
      // `description`, the tooltip would duplicate the second line the row ALREADY
      // shows, and the primary text — the one that can be clipped — would have no
      // tooltip at all.
      seedLiveSession();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });
      const row = (await screen.findByText("scout")).closest("button")!;
      const label = row.querySelector(".text-ui-base")!;
      // The elision pair, on a row that renders TWO lines: the Mention rows carry
      // paths too (an agent file's `display`), and the same flex/overflow
      // reasoning applies to them, not only to `?` rows.
      expect(label.className).toContain("min-w-0");
      expect(label.className).toContain("truncate");
      expect(label.getAttribute("title")).toBe("scout");
      expect(label.getAttribute("title")).not.toBe("Fast recon.");
      // And the secondary line keeps its OWN tooltip (it truncates too), so the
      // two lines are independently readable on hover.
      const desc = row.querySelector(".text-ui-sm")!;
      expect(desc.getAttribute("title")).toBe("Fast recon.");
    });

  it("an @ row's description (the agent description) renders as a title tooltip",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });
      const row = (await screen.findByText("scout")).closest("button")!;
      // The `@` catalog DOES have a `description` field — the row's tooltip is
      // the agent definition's description verbatim. See the `#` test above for
      // why this is the SECONDARY line and not "the first `[title]`".
      const desc = row.querySelector(".text-ui-sm")!;
      expect(desc.getAttribute("title")).toBe("Fast recon.");
      expect(desc.textContent).toBe("Fast recon.");
    });

  // ---------------------------------------------------------------------
  // The `#` MCP-mention toggle (ADR 0031's follow-up). `#` is the ONE prefix
  // that collides with pasted developer text (`#include`, `#123`, `#hashtag`
  // all satisfy the token grammar), so the trigger is opt-in. The gate is
  // expressed as an EMPTY MCP catalog: the picker and the expansion are
  // already catalog-gated, so no new code path exists. The DISPLAY side
  // (`splitMentionBlocks`) is deliberately NOT gated — a message persisted
  // while the trigger was on keeps rendering its chip.
  // ---------------------------------------------------------------------

  it("the # trigger is OFF by default: typing # opens no picker", async () => {
    seedLiveSession();
    seedMcpMentionsOff();
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
    // The MCP fetch HAS run (the fetch is NOT gated — gating it would make a
    // live toggle require a remount), but no rows are fed to the picker.
    await waitFor(() =>
      expect(vi.mocked(listMcpServersEffective)).toHaveBeenCalled(),
    );
    await flush();
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    expect(screen.queryByText("postgres")).toBeNull();
  });

  it("with the # trigger OFF, a matching # token is sent BYTE-IDENTICAL (no expansion)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      // `postgres` IS in the catalog — the OFF state must still leave the text
      // untouched (the empty-catalog gate hits `expandMentions`, which then
      // finds no match and returns the text verbatim: invariant 1).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "query #postgres");
      const userMsg = useSessions
        .getState()
        .messages["s1"]?.find((m) => m.kind === "user");
      expect(userMsg?.kind === "user" ? userMsg.text : null).toBe(
        "query #postgres",
      );
      // And the bubble renders no chip (the text carried no block).
      expect(screen.queryByText("named by the user")).toBeNull();
    });

  it("with the # trigger OFF, Enter with a bare # draft SENDS it (no swallowed keys)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "#123" } });
      await flush();
      // No picker → the keyboard branches (all gated on `filtered.length > 0`)
      // are inert, so Enter is a plain send. `#123` is exactly the pasted-issue
      // number that must reach the agent untouched.
      textarea.setSelectionRange(4, 4);
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "#123");
    });

  it("with the # trigger OFF, the $ and @ triggers still pick and expand (only # is gated)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // The pickers: `@` still opens (the `@` catalog is untouched).
      fireEvent.change(textarea, { target: { value: "@" } });
      expect(await screen.findByText("scout")).toBeTruthy();
      // And a MIXED draft expands `$` + `@` but NOT `#` — one block per
      // ENABLED kind, in first-mention order, with the `#` token left verbatim
      // in the user's text.
      fireEvent.change(textarea, {
        target: { value: "x $debug @scout #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      expect(sent.startsWith("x $debug @scout #postgres")).toBe(true);
      expect(sent).toContain('<skill name="debug"');
      expect(sent).toContain('<agent name="scout">');
      expect(sent).not.toContain('<mcp name="postgres">');
    });

  it("the # trigger is gated while the settings are still loading (the fail-safe default)",
    async () => {
      // No settings seeded at all (`settings === null`) — the composer must
      // behave as OFF, never as ON (`settings?.mcpMentionsEnabled ?? false`).
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "query #postgres");
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("flipping the setting while the # picker is open feeds the rows without a remount",
    async () => {
      // The `filtered` memo's deps include the flag: the picker is open on `#`
      // (no rows, so nothing renders), and flipping the store to ON makes the
      // row appear with NO further keystroke and NO remount.
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
      await waitFor(() =>
        expect(vi.mocked(listMcpServersEffective)).toHaveBeenCalled(),
      );
      await flush();
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      await act(async () => {
        seedMcpMentionsOn();
      });
      expect((await screen.findByText("postgres")).closest("button")).toBeTruthy();
    });

  it("a persisted <mcp> block still renders its chip with the # trigger OFF (display is not gated)",
    () => {
      // The gate is on the TRIGGER, not the display: a message sent while the
      // toggle was ON keeps rendering its soft-hint chip after the toggle goes
      // OFF (the record is unchanged, and `mergeDedupeKey` must stay stable).
      seedLiveSession();
      seedMcpMentionsOff();
      useSessions
        .getState()
        .addUserMessage("s1", PERSISTED_MCP_MESSAGE);
      render(<ChatStream />);
      expect(screen.getByText("named by the user")).toBeTruthy();
      expect(screen.getByText("postgres")).toBeTruthy();
      // The user's own text renders without the block prose.
      expect(screen.queryByText(/Connect to it via the mcp tool/)).toBeNull();
    });
  // ---------------------------------------------------------------------
  // `?` File completion (ADR 0033) — the FOURTH picker prefix, and the ONLY
  // one that is NOT a Mention: selecting a row inserts a PATH (the trigger is
  // CONSUMED, the case is PRESERVED) and the send path expands NOTHING. The
  // block below pins the rows, the insertion policy, the render cap, the note,
  // and the two degradations (in-flight listing / no-match note).
  //
  // BEFORE these tests exist, `filtered` has no `?` branch, so a `?` token
  // falls through to the SKILLS catalog — which is exactly the transient state
  // these tests are written to catch.
  // ---------------------------------------------------------------------

  // The picker's row `<button>` whose PRIMARY line is `name` — the
  // `text-ui-base` span. A `?` row's button holds TWO spans on the primary
  // line (the `text-ui-xs` prefix badge and the name), so "the row has one
  // span" is never the right assertion; single-liness is pinned by the
  // ABSENCE of the description node (see the single-line test below).
  async function findFileRow(name: string): Promise<HTMLButtonElement> {
    const matches = await screen.findAllByText(name);
    const primary = matches.find((el) => el.classList.contains("text-ui-base"));
    return primary!.closest("button") as HTMLButtonElement;
  }

  it("typing ?RE opens the picker with the file rows and a ? badge", async () => {
    seedLiveSession();
    vi.mocked(listSpaceListing).mockResolvedValue({
      entries: ["README.md", "docs/plan.md"],
      truncated: false,
    });
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "?RE" } });
    const row = await findFileRow("README.md");
    // The `?` badge (the picker renders `row.prefix`, so `?` needs no new
    // markup) …
    expect(row.querySelector(".text-ui-xs")!.textContent).toBe("?");
    // … and NO skill row mixes in (the fall-through bug: `?` listed skills).
    expect(screen.queryByText("debug")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("a path-shaped ? query matches by subsequence, not substring", async () => {
    seedLiveSession();
    vi.mocked(listSpaceListing).mockResolvedValue({
      entries: ["src/components/Formula.tsx", "README.md"],
      truncated: false,
    });
    render(<ChatStream />);
    // `src/comp/Form` is NOT a substring of `src/components/Formula.tsx` — a
    // path query is path-SHAPED, which is why the `?` branch filters with
    // `fuzzyMatch` (a subsequence match) instead of `includes`.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "?src/comp/Form" },
    });
    expect(await findFileRow("src/components/Formula.tsx")).toBeTruthy();
    // `README.md` matches nothing in that query, so it is not listed.
    expect(screen.queryAllByText("README.md")).toEqual([]);
  });

  it("enter on a file row inserts the path with the ? CONSUMED and the CASE INTACT",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // The ADR's own example: the query is case-INSENSITIVE, the INSERTED path
      // carries the real name.
      fireEvent.change(textarea, { target: { value: "?REA" } });
      expect(await findFileRow("README.md")).toBeTruthy();
      textarea.setSelectionRange(4, 4);
      fireEvent.keyDown(textarea, { key: "Enter" });
      // NOT `?README.md ` (the trigger is consumed) and NOT `readme.md `
      // (the insertion is VERBATIM — no lowercasing rule applies to a path, so
      // the Mention lowercase-only rule does NOT apply to `?`. The path is
      // then ordinary draft text and obeys the mention grammar like
      // hand-typed text — ADR 0033).
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("README.md ");
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("tab on a file row inserts the path (trigger consumed, case intact)",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["src/README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?src/READ" } });
      expect(await findFileRow("src/README.md")).toBeTruthy();
      textarea.setSelectionRange(9, 9);
      fireEvent.keyDown(textarea, { key: "Tab" });
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("src/README.md ");
    });

  it("a mousedown on a file row inserts the path (trigger consumed, case intact)",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?REA" } });
      const row = await findFileRow("README.md");
      textarea.focus();
      textarea.setSelectionRange(4, 4);
      // `onMouseDown` (with `preventDefault`) is the row's handler — a `click`
      // would NOT select (the same affordance as the Mention rows).
      const notPrevented = fireEvent.mouseDown(row);
      expect(notPrevented).toBe(false);
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("README.md ");
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("a file row is a single line: no basename second line, no tooltip, full path still shown",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["src/nested/README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?src/nested/READ" },
      });
      const row = await findFileRow("src/nested/README.md");
      // The PRIMARY line is the full Space-RELATIVE path — what gets INSERTED
      // for a **Listing** row, so it must never be shortened to the basename
      // (`selectMention` inserts `row.name`). An OUT-OF-SPACE row shows its
      // abbreviated `label` here instead while still inserting `name` — pinned by
      // the ADR 0035 describe below, not by this test.
      expect(row.querySelector(".text-ui-base")!.textContent).toBe(
        "src/nested/README.md",
      );
      // And there is NO secondary line. The basename used to be repeated there
      // — the tail of the path already shown above it — which made every `?`
      // row two lines tall (≈49px) for ZERO information. `ComposerMentions`
      // renders the second line only when `description !== ""`, so the
      // description node — and with it the DESCRIPTION's tooltip — is absent.
      // Asserted ON THE LINE, not as "`[title]` is absent": the primary line has
      // carried its own full-label `title` since the truncation work, so the old
      // proxy was simply false, and it would have failed to catch a description
      // that grew back while some other span had a tooltip.
      expect(row.querySelector(".text-ui-sm")).toBeNull();
      expect(row.querySelectorAll("[title]")).toHaveLength(1);
      // Pinned against the wrong "fix" (dropping `name` instead of
      // `description`): the row still has its prefix badge and its name span.
      expect(row.querySelector(".text-ui-xs")!.textContent).toBe("?");
    });

  it("a truncated listing shows the cap note, which is NOT a selectable row, and Enter still sends",
    async () => {
      seedLiveSession();
      // Truncated AND nothing matches: the note is exactly what explains the
      // EMPTY picker (the container gate widened to `open && (rows || note)`).
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: true,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?zzzz" } });
      const picker = await screen.findByTestId("mention-picker");
      const note = picker.querySelector(
        "[data-testid='mention-picker-note']",
      )!;
      // NO number in the string: the DTO carries only `truncated`, so naming
      // the Rust `MAX_PICKER_ENTRIES` here would let the UI lie the moment the
      // Rust cap moves (ADR 0033's note is qualitative on purpose).
      // And NO "keep typing" advice: the walk is deterministic
      // (`sort_by_file_name`), so a truncated listing holds the alphabetically
      // FIRST 5,000 entries and a truncated-away file is unreachable by
      // narrowing — advising it would be a lie.
      expect(note.textContent).toBe(
        "Listing capped — some files may be missing",
      );
      // The note is NEVER a row: it is not in the button set `activeIndex`,
      // the arrow-wrap and Enter operate over.
      expect(picker.querySelectorAll("button")).toHaveLength(0);
      expect(note.tagName).not.toBe("BUTTON");
      // And Enter still SENDS — the keydown intercept is gated on
      // `filtered.length > 0`, which the note does not touch.
      textarea.setSelectionRange(6, 6);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "?zzzz");
    });

  it("a query matching more rows than the render cap trims the list and says so",
    async () => {
      seedLiveSession();
      // 150 matching entries against the 10-row render cap (`MAX_PICKER_ROWS`):
      // `fuzzyMatch` is a loose subsequence and the listing is the whole Space,
      // so an unbounded picker would re-render thousands of buttons per
      // keystroke — and 10 single-line rows is ≈308px, a normal dropdown.
      const entries = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);
      vi.mocked(listSpaceListing).mockResolvedValue({ entries, truncated: false });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?file" } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() => expect(picker.querySelectorAll("button")).toHaveLength(10));
      const note = picker.querySelector(
        "[data-testid='mention-picker-note']",
      )!;
      expect(note.textContent).toContain("Too many matches");
      // The wrap stays consistent with the RENDERED list (the cap is applied
      // INSIDE `filtered`, so `activeIndex`, the `% filtered.length` wrap and
      // the DOM agree): ArrowUp from index 0 wraps to the LAST rendered row.
      textarea.setSelectionRange(5, 5);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      const buttons = Array.from(picker.querySelectorAll("button"));
      expect(buttons[9]!.className).toContain("bg-surface-hover");
      expect(buttons[0]!.className).not.toContain("bg-surface-hover");
      // And the wrapped row is selectable (no crash on the capped tail).
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("file9.ts ");
    });

  it("a normal ? picker with matching rows and a whole listing renders NO note",
    async () => {
      seedLiveSession();
      // The `undefined` arm: nothing is capped and nothing is truncated, so
      // the picker must stay silent (a note here would be noise on the
      // everyday path).
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md", "docs/plan.md"],
        truncated: false,
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?READ" },
      });
      const picker = await screen.findByTestId("mention-picker");
      expect(picker.querySelectorAll("button")).toHaveLength(1);
      expect(
        screen.queryByTestId("mention-picker-note"),
      ).toBeNull();
    });

  it("a truncated listing with matching rows shows the note ALONGSIDE the rows, and the note is not a row",
    async () => {
      seedLiveSession();
      // The other half of the widened gate: the note is NOT only an
      // empty-picker explanation — it rides along whenever the listing is
      // capped, rows or not. Below the render cap (5 matches < 10), so the
      // wording is the walk-cap one.
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["a1.ts", "a2.ts", "a3.ts", "a4.ts", "a5.ts"],
        truncated: true,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // ≥1 path char after the trigger (a bare `?` opens nothing, ADR 0033).
      fireEvent.change(textarea, { target: { value: "?a" } });
      const picker = await screen.findByTestId("mention-picker");
      const note = screen.getByTestId("mention-picker-note");
      // The walk-cap arm states the LIMITATION — no "keep typing" advice (a
      // truncated-away file cannot be reached by narrowing).
      expect(note.textContent).toBe(
        "Listing capped — some files may be missing",
      );
      expect(note.textContent).not.toContain("keep typing");
      // The rows are all still there (the note never replaces them) …
      const buttons = Array.from(picker.querySelectorAll("button"));
      expect(buttons).toHaveLength(5);
      // … and the note is outside the button set `activeIndex` / the
      // arrow-wrap / Enter operate over.
      expect(buttons).not.toContain(note);
      expect(note.tagName).not.toBe("BUTTON");
      expect(picker.contains(note)).toBe(true);
      // Arrow navigation still lands on a row, never on the note. The caret is
      // at the END of the token (the keydown re-evaluates it: a caret INSIDE
      // `?a` at index 1 leaves an empty remainder, which is not a `?` token).
      textarea.setSelectionRange(2, 2);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(
        Array.from(picker.querySelectorAll("button"))[4]!.className,
      ).toContain("bg-surface-hover");
    });

  it("a truncated listing AND more matches than the render cap: the too-many-matches wording wins",
    async () => {
      seedLiveSession();
      // Precedence pin: both conditions hold, and the actionable one (keep
      // typing) is what renders — the walk-cap note is shadowed.
      const entries = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);
      vi.mocked(listSpaceListing).mockResolvedValue({ entries, truncated: true });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?file" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(10),
      );
      const note = screen.getByTestId("mention-picker-note");
      expect(note.textContent).toBe(
        "Too many matches — keep typing to narrow the list",
      );
      expect(note.textContent).not.toContain("capped");
    });

  it.each([
    { prefix: "$" as const, kind: "skills" as const },
    { prefix: "@" as const, kind: "agents" as const },
    { prefix: "#" as const, kind: "mcp" as const },
  ])(
    "the $prefix picker is UNCAPPED and note-free with more matches than the render cap ($kind catalog)",
    async ({ prefix, kind }) => {
      seedLiveSession();
      // The render cap belongs to `?` ALONE (its loose SUBSEQUENCE filter can
      // match nearly a whole 5,000-entry listing). The three Mentions keep the
      // shipped status quo: their filter is a name SUBSTRING, and ADR 0033
      // promises those pickers are unchanged — a silent 10-row cap there
      // would make row 11 unreachable with no explanation.
      // `…Once` (not `…Value`): `beforeEach` only `clearAll`s the mocks, so a
      // PERSISTENT override would leak this catalog into later tests.
      if (prefix === "#") seedMcpMentionsOn();
      const many = Array.from({ length: 150 }, (_, i) => `${kind}${i}`);
      if (kind === "skills") {
        vi.mocked(listSkills).mockResolvedValueOnce(
          many.map((name) => ({
            name,
            description: `d ${name}`,
            path: `/s/${name}/SKILL.md`,
            dir: `/s/${name}`,
            scope: "space",
            body: "B",
            disableModelInvocation: false,
            shadowed: [],
          })),
        );
      } else if (kind === "agents") {
        vi.mocked(listAgentDefinitionsForSpace).mockResolvedValueOnce(
          many.map((name) => ({
            name,
            description: `d ${name}`,
            model: null,
            scope: "user",
          })),
        );
      } else {
        vi.mocked(listMcpServersEffective).mockResolvedValueOnce(
          many.map((name) => ({ name, kind: "stdio", summary: `s ${name}` })),
        );
      }
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: prefix } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        // ALL 150 matches render — nothing is silently dropped.
        expect(picker.querySelectorAll("button")).toHaveLength(150),
      );
      expect(screen.queryByTestId("mention-picker-note")).toBeNull();
      // And the last row is reachable: the arrow-wrap counts the rendered
      // rows, so ArrowUp from index 0 lands on row 150 (index 149).
      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      const buttons = Array.from(picker.querySelectorAll("button"));
      expect(buttons[149]!.className).toContain("bg-surface-hover");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe(`${prefix}${many[149]} `);
    },
  );

  it("while the file listing is in flight, ? opens NO picker and Enter SENDS",
    async () => {
      seedLiveSession();
      // A skill whose name matches the query SUBSTRING: while the `?` branch is
      // missing this renders a skills picker (and Enter INSERTS instead of
      // sending) — the degradation this test pins is "no rows at all".
      vi.mocked(listSkills).mockResolvedValueOnce([
        {
          name: "debug",
          description: "Debug a failure",
          path: "/s/debug/SKILL.md",
          dir: "/s/debug",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
      ]);
      // A DEFERRED listing: the in-flight state ADR 0033 calls out (an empty
      // `filtered` means no picker and inert keyboard branches, so Enter sends
      // — the same degradation ADR 0032 relies on).
      let resolveFiles: (v: ListingDto) => void = () => {};
      vi.mocked(listSpaceListing).mockImplementation(
        () => new Promise<ListingDto>((r) => (resolveFiles = r)),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      await waitFor(() => expect(vi.mocked(listSpaceListing)).toHaveBeenCalled());
      await waitFor(() => expect(vi.mocked(listSkills)).toHaveBeenCalled());
      fireEvent.change(textarea, { target: { value: "hi ?de" } });
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      textarea.setSelectionRange(7, 7);
      fireEvent.keyDown(textarea, { key: "Enter" });
      // Sent, and BYTE-IDENTICAL: no block appended, nothing stripped.
      expect(sendPrompt).toHaveBeenCalledWith("s1", "hi ?de");
      // The late listing lands with NO further keystroke (the `files` dep on
      // the `filtered` memo), and it must not resurrect a picker for a token
      // that no longer exists in the (now-empty) draft.
      await act(async () => {
        resolveFiles({ entries: ["README.md"], truncated: false });
        await Promise.resolve();
      });
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      expect(screen.queryAllByText("README.md")).toEqual([]);
    });

  it("a Space switch serves no file rows until the new Space listing resolves",
    async () => {
      // Two live sessions in DIFFERENT Spaces (the catalog is keyed by the
      // Space path, so switching sessions is a catalog KEY change).
      useSessions.setState({
        activeSessionId: "s1",
        sessions: [
          { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
          { sessionId: "s2", cwd: "/home/u/other", capabilities: {}, archived: false },
        ],
        spaces: [
          { path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false },
          { path: "/home/u/other", createdAt: 1, lastOpenedAt: 1, trusted: false },
        ],
        historySessions: [],
        messages: { s1: [], s2: [] },
        inTurn: {},
        stopReasons: {},
        closeReasons: {},
        configOptions: {},
      });
      let resolveOther: (v: ListingDto) => void = () => {};
      vi.mocked(listSpaceListing).mockImplementation((p) =>
        p === "/home/u/proj"
          ? Promise.resolve({ entries: ["README.md"], truncated: false })
          : new Promise<ListingDto>((r) => (resolveOther = r)),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?README" } });
      expect(await findFileRow("README.md")).toBeTruthy();
      // Switch the Space WHILE the picker is open: the old Space's rows must
      // NOT be offered against the new one (a stale row would insert a path the
      // new Space does not have).
      await act(async () => {
        useSessions.setState({ activeSessionId: "s2" });
      });
      await flush();
      expect(screen.queryAllByText("README.md")).toEqual([]);
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      // The new listing resolves; the picker is still closed (the draft never
      // changed, so no `onChange` re-ran), and a fresh query offers ONLY the
      // new Space's file.
      await act(async () => {
        resolveOther({ entries: ["OTHER.md"], truncated: false });
        await Promise.resolve();
      });
      fireEvent.change(textarea, { target: { value: "?OTHER" } });
      expect(await findFileRow("OTHER.md")).toBeTruthy();
      expect(screen.queryAllByText("README.md")).toEqual([]);
    });

  it("a ? path in the draft is sent BYTE-IDENTICAL (never expanded, never stripped)",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      // `README.md` IS in the listing — the send path must still leave the text
      // untouched (`expandMentions` never sees `?`; the trailing space also
      // closes the token, so Enter is not an insertion).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "read ?README.md " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "read ?README.md");
      const userMsg = useSessions
        .getState()
        .messages["s1"]?.find((m) => m.kind === "user");
      expect(userMsg?.kind === "user" ? userMsg.text : null).toBe(
        "read ?README.md",
      );
      // And no Mention chip was rendered for it (no block was appended).
      expect(screen.queryByText("named by the user")).toBeNull();
    });

  it("??, a?.b and a bare ? open NO picker and all three drafts SEND verbatim",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      await waitForCatalog(listSkills);
      const drafts = ["?? README.md", "a?.b", "?"];
      for (const [i, d] of drafts.entries()) {
        fireEvent.change(textarea, { target: { value: d } });
        await flush();
        // None is a `?` token (`??` and a bare `?` need ≥1 path char; `a?.b`
        // fails the `(^|\s)` boundary) — so no picker and Enter stays a SEND.
        expect(screen.queryByTestId("mention-picker")).toBeNull();
        textarea.setSelectionRange(d.length, d.length);
        fireEvent.keyDown(textarea, { key: "Enter" });
        await waitFor(() =>
          expect(sendPrompt).toHaveBeenNthCalledWith(i + 1, "s1", d),
        );
        // Unlock the composer for the next iteration (the mocked send resolves
        // in a microtask; `turnCompleted` clears `inTurn`).
        await waitFor(() =>
          expect(useSessions.getState().inTurn["s1"]).toBe(false),
        );
      }
    });

  it("the $ and @ pickers still list and insert their lowercase mention tokens",
    async () => {
      // The regression pin: `?` SHARES the picker but not the semantics — the
      // Mention prefixes keep the substring filter AND the lowercase insertion.
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md", "debug-notes.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // `$` → the skills catalog only (the file `debug-notes.md` must NOT mix
      // into a `$` list, even though it matches the query as a substring).
      fireEvent.change(textarea, { target: { value: "$de" } });
      expect(await screen.findByText("debug")).toBeTruthy();
      expect(screen.queryByText("debug-notes.md")).toBeNull();
      textarea.setSelectionRange(3, 3);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "$debug ",
      );
      // `@` → the agents catalog, and the inserted token is still LOWER-cased.
      fireEvent.change(textarea, { target: { value: "@" } });
      const scout = await screen.findByText("scout");
      expect(
        scout.closest("button")!.querySelector(".text-ui-xs")!.textContent,
      ).toBe("@");
      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
    });

  // ---------------------------------------------------------------------
  // Picker GEOMETRY: the box clamps its own height and scrolls, and the
  // highlighted row is scrolled into view as the arrows move it. This is what
  // bounds the UNCAPPED Mention lists (`$`/`@`/`#` are deliberately not
  // row-capped — a sliced row is an unreachable row), so the promise "the
  // picker never dominates the window" is geometry, not a row count.
  //
  // What jsdom CAN and cannot check: it has NO layout engine, so row heights
  // and scroll offsets are unmeasurable here (hence the clamp is a deliberate
  // ESTIMATE in the component, and these tests assert the CLASSES and the
  // SCROLL CALL, never a pixel height).
  // ---------------------------------------------------------------------

  it("the picker clamps its height to the UI font size and scrolls instead of filling the window",
    async () => {
      seedLiveSession();
      // Enough rows that the list is taller than the clamp: `?` is capped at
      // 10 rows, and the clamp is sized to ≈10 rows, so 10 rows plus the note
      // line is already more than the box can show.
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: Array.from({ length: 10 }, (_, i) => `file${i}.ts`),
        truncated: true,
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?file" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(10),
      );
      // It must SCROLL: without `overflow-y-auto` a `max-height` just clips.
      expect(picker.classList.contains("overflow-y-auto")).toBe(true);
      // And the clamp must track the UI font size, which is a USER setting
      // applied as an inline px value on `<html>` (`src/lib/settings.ts`) — a
      // fixed `rem` clamp like `max-h-64` would show FEWER rows for a user who
      // raised the font size, i.e. it punishes exactly the user who needs the
      // room. So the class is a `calc()` over `var(--ui-font-size)`.
      const clamp = Array.from(picker.classList).find((c) =>
        c.startsWith("max-h-["),
      );
      expect(clamp).toBeDefined();
      expect(clamp).toContain("var(--ui-font-size)");
    });

  it("arrow-keying the picker scrolls the highlighted row into view",
    async () => {
      seedLiveSession();
      // The UNCAPPED side: the `$` catalog is not row-limited, so this is the
      // list the clamp actually protects. 40 rows is far more than the box can
      // show, and every one of them stays keyboard-reachable.
      const many = Array.from({ length: 40 }, (_, i) => `skill${i}`);
      vi.mocked(listSkills).mockResolvedValueOnce(
        many.map((name) => ({
          name,
          description: `d ${name}`,
          path: `/s/${name}/SKILL.md`,
          dir: `/s/${name}`,
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        })),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "$" } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(40),
      );
      // Which ROW was scrolled is the whole question, and the tool for it is
      // the file's OWN `beforeAll` stub (`HTMLElement.prototype.scrollIntoView =
      // vi.fn()`, there for Radix) read through `mock.contexts` — the RECEIVER
      // of each call. Two alternatives were tried and are wrong here: a bare
      // "was `scrollIntoView` called" assertion could be satisfied by an
      // unrelated widget, and a per-row `vi.spyOn` cannot answer WHICH row —
      // `scrollIntoView` is INHERITED, so 40 spies chain through the same stub
      // and each records the one call.
      const scrollStub = HTMLElement.prototype.scrollIntoView as Mock;
      /** Every element ever asked to scroll, in call order. */
      const scrolled = (): Element[] =>
        scrollStub.mock.contexts as unknown as Element[];
      const buttons = Array.from(
        picker.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      // Settle the in-flight catalogs BEFORE measuring, and wait until the log
      // goes quiet. The agents / MCP / file fetches land independently of the
      // skills one, and every resolution re-derives `filtered` — which
      // legitimately re-runs the effect for whatever row is active AT THAT
      // MOMENT (still row 0, before any arrow key). That is noise for a test
      // about what an ARROW KEY does, so the window starts after the quiet
      // point; there is then no `await` between a keypress and its assertion,
      // so nothing can interleave.
      let quietAt = -1;
      while (quietAt !== scrolled().length) {
        quietAt = scrolled().length;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      let mark = scrolled().length;

      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });

      // The row that is NOW highlighted (index 0 → 1) is the one scrolled into
      // view — focus-follows, so a keyboard user arrowing down a long list
      // never loses the selection off the top or bottom of the box. ONE scroll,
      // on the moved-to row, with `block: "nearest"` (what keeps an
      // already-visible row from jumping).
      const down = scrolled().slice(mark);
      expect(down).toEqual([buttons[1]]);
      expect(scrollStub.mock.calls[mark]![0]).toEqual({ block: "nearest" });
      expect(buttons[1]!.className).toContain("bg-surface-hover");

      // The row-above case, which is the one a ref-on-the-active-row can get
      // WRONG: ArrowUp moves the highlight BACK to a row that was mounted the
      // whole time, so a stale ref would scroll nothing (or the wrong row).
      mark = scrolled().length;
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(scrolled().slice(mark)).toEqual([buttons[0]]);
      expect(scrollStub.mock.calls[mark]![0]).toEqual({ block: "nearest" });

      // And the WRAP: ArrowUp from index 0 lands on the LAST row — the one
      // furthest outside the visible box, so this is the scroll that matters
      // most.
      mark = scrolled().length;
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(scrolled().slice(mark)).toEqual([buttons[39]]);
      expect(buttons[39]!.className).toContain("bg-surface-hover");
      // Still every row rendered: the clamp is GEOMETRY, never a slice of
      // `filtered` — nothing here may make a row unreachable.
      expect(picker.querySelectorAll("button")).toHaveLength(40);
    });

  it("typing narrows the list under an UNCHANGED index and the newly-active row is the one scrolled",
    async () => {
      // The pin for `filtered` being in the scroll effect's dep array (see
      // `ComposerMentions`' DEPS note). `filtered` is NOT there for the arrow
      // keys — the test above covers those — it is there for TYPING: `onChange`
      // resets `picker.index` to 0, so a keystroke that narrows the list leaves
      // `activeIndex` the SAME NUMBER (0) while `filtered[0]` becomes a
      // DIFFERENT row. Deps `[activeIndex]` alone therefore never re-run, and
      // the row the user is now on is never made visible — a silent
      // keyboard/a11y failure with no other test to catch it (mutation-verified:
      // dropping `filtered` from the array keeps every other test in this file
      // green).
      seedLiveSession();
      vi.mocked(listSkills).mockResolvedValueOnce([
        {
          name: "ab-alpha",
          description: "d a",
          path: "/s/ab-alpha/SKILL.md",
          dir: "/s/ab-alpha",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
        {
          name: "ab-beta",
          description: "d b",
          path: "/s/ab-beta/SKILL.md",
          dir: "/s/ab-beta",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
        {
          name: "ac-gamma",
          description: "d g",
          path: "/s/ac-gamma/SKILL.md",
          dir: "/s/ac-gamma",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
      ]);
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "$ab" } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(2),
      );
      // The same receiver-reading technique as the arrow test above: the file's
      // own `beforeAll` stub, read through `mock.contexts`, because
      // `scrollIntoView` is INHERITED and a per-row `vi.spyOn` records the same
      // single call for every row.
      const scrollStub = HTMLElement.prototype.scrollIntoView as Mock;
      const scrolled = (): Element[] =>
        scrollStub.mock.contexts as unknown as Element[];
      // Quiet point: the agents / MCP / file catalogs resolve independently of
      // skills and each resolution re-runs the effect for the row active AT
      // THAT MOMENT. Wait the log stops growing, then leave no `await` between
      // the keystroke and the assertion.
      let quietAt = -1;
      while (quietAt !== scrolled().length) {
        quietAt = scrolled().length;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      const before = Array.from(
        picker.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      // Precondition: index 0 is active and it is `ab-alpha`.
      expect(before[0]!.className).toContain("bg-surface-hover");
      const mark = scrolled().length;

      // The keystroke: one more character. `filtered` narrows to ONE row
      // (`ab-beta` — `ab-alpha` no longer matches) while `activeIndex` stays 0,
      // so the highlighted row is now a row that was NOT highlighted before.
      textarea.setSelectionRange(8, 8);
      fireEvent.change(textarea, { target: { value: "$ab-beta" } });

      const after = Array.from(
        picker.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      expect(after).toHaveLength(1);
      expect(after[0]!.textContent).toContain("ab-beta");
      // `activeIndex` is UNCHANGED (still the first row), so this assertion
      // holds for the buggy and correct code alike — it is here to pin the
      // precondition, not to do the detecting.
      expect(after[0]!.className).toContain("bg-surface-hover");
      // THE pin: exactly one new scroll, and its receiver is the row that is
      // active NOW (`ab-beta`), not the row that was active before the
      // keystroke (`ab-alpha`, now gone from the list). Without `filtered` in
      // the deps this slice is EMPTY — the effect never re-runs — so the test
      // is red, not vacuously green.
      expect(scrolled().slice(mark)).toEqual([after[0]]);
      expect(scrollStub.mock.calls[mark]![0]).toEqual({ block: "nearest" });
      expect(scrolled().slice(mark)).not.toContain(before[0]!);
    });
});
