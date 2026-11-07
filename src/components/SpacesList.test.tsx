import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import {
  cancelSession,
  closeSession,
  deleteSession,
  listSkills,
  reorderSessions,
  setSessionArchived,
  startSession,
  type AgentDefinitionReportDto,
  type AppSettings,
} from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import {
  getLeftPaneCollapsed,
  LEFT_PANE_RAIL,
  setLeftPaneCollapsed,
} from "../lib/leftPaneState";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
} from "../lib/newSpaceDialogState";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearAgentCatalogCache } from "../hooks/useAgentCatalog";
import {
  makeMessage,
  makeSessionRow,
  makeSettings,
  makeSpaceRow,
} from "../test/fixtures";
import { resetModuleFlags, resetStores } from "../test/resetStores";
import SpacesList from "./SpacesList";
import { SessionListRow } from "./SessionListRow";

/**
 * The settings document the STORE is seeded with (see the `beforeEach` below).
 *
 * The shared `makeSettings()` fixture (Task B4a), with the ONE field this file
 * overrides: `defaultModel` is `"stale/model"` here because the read-modify-write
 * test that used to sit below — now `picking_a_model_saves_agentOverrides_through_a_read_modify_write`
 * in `SpacesList.agents.test.tsx` — makes the RE-READ return a different value,
 * which is what proves the save composes from the fresh document and not from this
 * copy. The override stays here because the STORE seed is this file's too, and the
 * two files declare the same fixture on purpose: `vi.mock` is per-file, so the seed
 * has to exist wherever a test reads it.
 *
 * TYPED as `AppSettings` through the fixture, which is the point of it: the
 * `getSettings` mock factory's literal used to be an untyped hand-copy of all 22
 * required fields, and a field added to the real type would miss every copy at
 * once. `makeSettings` is `AppSettings`-typed, so it is now a compile error in
 * the one file that has to change.
 */
const SETTINGS_FIXTURE: AppSettings = makeSettings({
  defaultModel: "stale/model",
});

/** One `list_agent_definition_reports` row (the Agents modal's data). */
function agentRow(overrides: Partial<AgentDefinitionReportDto> = {}): AgentDefinitionReportDto {
  return {
    name: "scout",
    description: "Fast recon",
    scope: "user",
    path: "/u/.agents/agents/scout.md",
    file: { model: null, thinking: null, tools: null, permission: null },
    override: { model: null, thinking: null, tools: null, permission: null },
    effective: { model: null, thinking: null, tools: null, permission: null },
    source: { model: "parent", thinking: "parent", tools: "parent", permission: "parent" },
    shadowed: [],
    // issue #101: the two new REQUIRED wire fields at Rust's empty value. This
    // builder is called from INSIDE the hoisted `vi.mock("../lib/tauri")`
    // factory below — a hoisted `function` declaration, so the factory can reach
    // it (unlike the object-literal `row()` in `useAgentCatalog.test.ts`, whose
    // inline twin had to be edited separately).
    filePermission: null,
    frontmatterNotes: [],
    ...overrides,
  };
}

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  // The shared settings fixture, reached through a DYNAMIC import inside the
  // factory — the route `src/test/fixtures/settings.ts` documents and
  // `src/test/fixtures.test.ts` proves: `vi.hoisted()` is per-file and does NOT
  // make a module importable from a hoisted `vi.mock` factory, but every factory
  // here is already `async`, so `await import()` runs at factory time, after the
  // module graph exists. This replaces a 30-line untyped hand-copy of all 22
  // required `AppSettings` fields whose only guard was a comment.
  const { makeSettings } = await import("../test/fixtures/settings");
  return {
    ...actual,
    // `AppSettings` document: the fresh-install defaults (`defaultModel: null`
    // included — the store's copy of the document differs by that field alone,
    // which is why the `beforeEach` re-arm restates it).
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: { loadSession: false },
      archived: false,
    }),
    respondPermission: vi.fn(),
    respondInteractiveRequest: vi.fn(),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    setSpaceTrusted: vi.fn().mockResolvedValue(undefined),
    deleteSpace: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([
      {
        name: "alpha",
        description: "Alpha skill",
        path: "/p/.agents/skills/alpha/SKILL.md",
        dir: "/p/.agents/skills/alpha",
        scope: "space",
        body: "B",
        shadowed: [],
      },
    ]),
    setSessionArchived: vi.fn().mockResolvedValue(true),
    // The sidebar drag's ONE write (ADR 0075). The store's `reorderSessions`
    // action calls through this same module, and this file's mock replaces the
    // module — so without this arm the store's drag write would call a `vi.fn()`
    // returning `undefined`, and `reorderChain.sessions.then(…)` would throw
    // (`undefined` has no `.then`) inside the store's link.
    reorderSessions: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    // The row's Stop button: cancel a turn, or close the Session.
    closeSession: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    // The Agents modal's three catalog sources + its write path.
    listAgentDefinitionReports: vi.fn().mockResolvedValue([agentRow()]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: "Qwen3.8",
        provider: "tama",
        contextWindow: 200_000,
        supportsThinking: true,
        thinkingLevels: ["high", "medium", "low"],
      },
    ]),
    listTools: vi.fn().mockResolvedValue(["grep", "read_file"]),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedStartSession = vi.mocked(startSession);
const mockedListSkills = vi.mocked(listSkills);
const mockedDeleteSession = vi.mocked(deleteSession);

/**
 * The MOUNT PROBE for the render-site pin (see
 * `the dialog is mounted OUTSIDE the panes content region`).
 *
 * Why a probe and not an ancestor walk on the dialog node: `DialogContent` portals
 * itself to `document.body` — Radix's `Dialog.Content` renders an internal `Portal`
 * for a modal dialog, NOT the `DialogPortal` the app's `ui/dialog` merely re-exports
 * (stubbing that wrapper is INERT; `Dialog.Content` portals regardless, which is how
 * this test was first written and found vacuous). So in any real mount the dialog
 * node is a child of `document.body` whether the component was mounted inside the
 * `visibility: hidden` content region or beside it — `contains()` and any
 * `painted()`-style ancestor walk pass EVEN WITH THE BUG PRESENT.
 *
 * The wrapper below renders an ordinary (unportalled) node next to the real dialog.
 * Its position in the DOM is EXACTLY where `SpacesList` mounted the component, so it
 * reports the one fact the collapse depends on. Real `AgentsDialog` is still
 * rendered, so every other test in this file runs against the real modal; the probe
 * is a sibling `div` with no role, so it cannot disturb a `getByRole` query.
 */
let probeOn = false;

/**
 * A RENDER-TIME RECORD of the `rolledBackWrites` value the mount handed the dialog,
 * consecutive duplicates collapsed (the shape `traceAgentOverrides` uses).
 *
 * Why the renders and not the DOM: this counter is the FACT the modal's stored-pin
 * suppression is stamped against (see `AgentsDialog`'s `edits`), and a test whose
 * rows carry all-`null` `override` columns has no column disagreement for the cue to
 * name — the cue is then unobservable in the DOM, while the spurious increment that
 * would have armed it is still a lie the mount told. The counter is that cue's
 * upstream, and it is readable on every render.
 *
 * Recorded in the mock wrapper below (the seam the mount probe already uses), because
 * the prop belongs to the dialog and the mount is its only writer. Pushed at render
 * time, so a value that appeared for one render and was overwritten next render is
 * still in the record. Readers reset it first — this is module scope, shared across
 * every test in the file.
 */
let rollsSeen: (number | undefined)[] = [];

vi.mock("./AgentsDialog", async () => {
  const actual = await vi.importActual<typeof import("./AgentsDialog")>(
    "./AgentsDialog",
  );
  const Real = actual.default;
  return {
    default: (props: Parameters<typeof Real>[0]) => {
      // Both reads happen at RENDER time (the factory is hoisted above this file's
      // `let`s, so the factory BODY could not touch them at all — only this closure
      // body, which runs per render, can).
      if (rollsSeen[rollsSeen.length - 1] !== props.rolledBackWrites) {
        rollsSeen.push(props.rolledBackWrites);
      }
      return React.createElement(
        React.Fragment,
        null,
        // Read at RENDER time (the factory is hoisted above this file's `let`).
        probeOn
          ? React.createElement("div", {
              "data-testid": "agents-mount-probe",
            })
          : null,
        React.createElement(Real, props),
      );
    },
  };
});

/**
 * Whether a node is PAINTED — i.e. neither it nor any ancestor carries
 * `visibility: hidden` (Tailwind's `invisible`). jsdom resolves no CSS, so
 * "does this text bleed into the 40px sliver?" is read off the class list the
 * component renders, which is exactly what the collapse controls.
 */
function painted(node: HTMLElement): boolean {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    if (el.classList.contains("invisible")) return false;
  }
  return true;
}

/**
 * Fixture: two spaces. `alpha` holds a live session `s1` (in-turn, with a
 * loaded transcript) + a stored session `h1` (loaded transcript, ~1h old);
 * `beta` holds a stored session `h2` that was NOT opened this boot (no
 * loaded messages → no relative time).
 */
function seed(): void {
  const now = Date.now();
  // THE ISOLATION HALF, now the shared helper's job: every store back to the
  // state zustand captured at creation, BEFORE this fixture writes its keys.
  // This file used to hand-list the keys it happened to remember —
  // `archivedSessions: []`, `closeReasons: {}`, `stopReasons: {}`, plus a whole
  // `setState` on each of the permissions and interactive stores — and
  // `useSessions` has more data fields than that list named, so whatever it
  // omitted leaked from one test to the next. `resetStores()` installs the WHOLE
  // captured state (with `replace = true`, so nothing shallow-merges over it),
  // which includes the archived list the comment below used to guard by hand.
  // What stays below is therefore the FIXTURE, not the hygiene.
  resetStores();
  // Seed via `setState` directly — NOT `getState().setSpaces(…)` (that
  // triggers boot auto-selection + `openSession` → `loadHistory` IPC).
  useSessions.setState({
    spaces: [
      makeSpaceRow({ path: "/tmp/alpha", createdAt: now, lastOpenedAt: now }),
      makeSpaceRow({
        path: "/tmp/beta",
        createdAt: now,
        lastOpenedAt: now,
        trusted: true,
      }),
    ],
    sessions: [makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" })],
    historySessions: [
      makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha" }),
      makeSessionRow({ sessionId: "h2", cwd: "/tmp/beta" }),
    ],
    activeSessionId: "s1",
    // The selected space (the top tabs' state): `alpha` — the active
    // session's space (the sidebar lists THIS space's sessions).
    activeSpacePath: "/tmp/alpha",
    messages: {
      s1: [makeMessage("user", { text: "Fix the login bug", at: now - 10_000 })],
      h1: [
        makeMessage("user", {
          text: "Refactor the parser",
          at: now - 3_600_000,
        }),
      ],
    },
    inTurn: { s1: true },
  });
}

beforeEach(() => {
  seed();
  vi.clearAllMocks();
  // `clearAllMocks` clears CALL RECORDS and nothing else: an UNCONSUMED `…Once`
  // arm survives it and fires in the NEXT test (measured — a `mockRejectedValueOnce`
  // left over from a test whose assertion threw before consuming it rejects the
  // next test's `saveSettings`), and so does a bare `mockResolvedValue` override.
  // The mocks this file re-arms are therefore reset and handed their factory
  // default again, so "which test ran before me" cannot decide what my IPC layer
  // answers.
  //
  // (`listSkills` is deliberately NOT in this list, and the reason is mechanical
  // rather than about any one test: `mockReset()` strips a mock's implementation, so
  // the bare reset leaves `listSkills()` returning `undefined`, and
  // `useSkillCatalog.ts:66` calls `listSkills(spacePath).catch(…)` on EVERY mount —
  // adding this line as-is measured 67 of this file's 69 tests failing on
  // "Cannot read properties of undefined (reading 'catch')". It would need its
  // factory default restated to belong here — which is ALSO the fix for the
  // override the empty-skills test leaves behind (see its comment: declaration
  // order is what keeps that `mockResolvedValue([])` from leaking further).)
  // (The three re-arms that used to sit here — `saveSettings`, `getSettings` and
  // `listAgentDefinitionReports` — left with the Agents-modal cluster when it moved
  // to `SpacesList.agents.test.tsx`: no test in THIS file arms those three any more,
  // so the arm belongs to the file that can leave one behind.)
  vi.mocked(setSessionArchived).mockReset().mockResolvedValue(true);
  mockedDeleteSession.mockReset().mockResolvedValue(undefined);
  // Stop's two commands, re-armed for the SAME reason as the two lines above:
  // `clearAllMocks` clears the CALL RECORD only and never an armed implementation,
  // so a `mockRejectedValueOnce` left unconsumed (a Stop test that pins the
  // rejection reaching the row's logger and asserts before draining it) would be
  // handed to the NEXT test's click. None is armed today, which is exactly the
  // claim the neighbours make too: restating the factory default here changes no
  // behaviour, it only makes the default unconditional. `mockReset` alone would
  // not do — it strips the implementation, leaving the mock answering
  // `undefined`, which is not the `Promise` these wrappers return.
  vi.mocked(closeSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(cancelSession).mockReset().mockResolvedValue(undefined);
});
// Seed the SETTINGS STORE. `SpacesList.tsx` did not read `useSettings` before the
// Agents modal mounted (only `main.tsx`'s boot path ever populated it), and this
// file never seeded it — so with the mount's `settings &&` guard the dialog would
// render in NO test here, and every failure would read as "the Agents button is
// broken" when the real cause is an empty store. The same seeding pattern
// `ChatStream.test.tsx` uses. Reset to `null` first: the store is module-scoped,
// so a test that writes settings must not leak them into the next one.
// (Since D2 the read travels through `useAgentOverridesWrites`, which selects
// `settings` off this same store — so the seeding below is still exactly what the
// gate reads, and `holds the Agents dialog back while there is no settings
// document` is the pin that keeps it honest.)
beforeEach(() => {
  useSettings.setState({ settings: null, loaded: false });
  useSettings.getState().setSettings(SETTINGS_FIXTURE);
});
// The hook's module-level catalog cache is shared across tests in a
// file: clear it so each test refetches (without this, test 1's warm
// cache — keyed by the `seed()` fixture's `cwd` — makes a later test's
// fresh `listSkills` mock moot).
beforeEach(clearSkillCatalogCache);
// …and the same for the Agent catalog's module-level cache (the Agents modal
// fetches through `useAgentCatalog`, keyed by the `seed()` fixture's Space).
beforeEach(clearAgentCatalogCache);
// The two module-scoped pane/dialog flags this file can raise, back to their
// value at import — the shared helper (Task B4a) instead of two hand-written
// `beforeEach` blocks. `resetModuleFlags()` restores the left pane, the side
// pane and the Open-Space flag; the side pane is a no-op here (this component
// never reads it) and the other two are exactly what these blocks reset. The
// dialog flag is the one that bites: a leaked `true` auto-mounts a real Radix
// modal in every later `render(<SpacesList/>)`, which sets
// `document.body.style.pointerEvents = "none"` and `aria-hidden`s its siblings —
// so unrelated `getByRole` queries further down this file throw for a reason
// that has nothing to do with them.
beforeEach(resetModuleFlags);
// DELETED here, and now owned by `src/test/setup.tsx`: this file's hand-written
// `Element.prototype.scrollIntoView = vi.fn()` (jsdom has no layout, so Radix's
// `Select` throws on the focus-first-option scroll). The setup file installs the
// same plain prototype assignment for every file, and this one is NOT among the
// four `vi.unstubAllGlobals()` files the deletion checklist excludes.
// The mount probe above is a module-level switch: a test that asks for it must
// not leak it into the tests after it.
beforeEach(() => {
  probeOn = false;
});
// FILE-SCOPE spy restore. Several tests below install a `console.error` spy to
// swallow (or observe) a failure log and restore it on the last line — with no
// `try/finally`. An assertion that throws mid-test therefore never reaches that
// restore, and a SILENCED `console.error` walks into every later test in the
// file: exactly the leak that makes the first red hard to read, because the
// tests after it stop printing the errors they were supposed to print. Restoring
// here costs the tests nothing and holds whatever the throw skipped.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpacesList", () => {
  it("holds ONE New Session + and NO Open Space row and NO chord chips", () => {
    // THE REMOVAL PIN. The pane used to hold FOUR labelled command buttons
    // (Open Space, New Session, Skills, Agents) with a `<Kbd>` chord chip on the
    // first two. `Open Space` and `New Session` are GONE: the command is now one
    // `+` icon button in the `Sessions` header (`aria-label="New Session"`, so the
    // accessible name is the bare label — hence the exact-name query, not a regex),
    // and `Open Space` has no sidebar surface at all any more (the chrome bar's `+`
    // and ⌘O are its doors). `Skills` and `Agents` stay as labelled rows and are
    // pinned by their own blocks below — this case pins what was REMOVED, and grep
    // confirms no other assertion anywhere checked that `Open Space` is absent, so
    // without the `queryByRole` line below the row could come back green.
    render(<SpacesList />);
    expect(screen.getByRole("button", { name: "New Session" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Space" })).toBeNull();
    // The two `<Kbd>` chips died with the rows: ⌘N now lives only in the `+`'s
    // `title` (pinned below) and ⌘O only in the chrome bar's tooltip.
    expect(screen.queryByText("⌘N")).toBeNull();
    expect(screen.queryByText("⌘O")).toBeNull();
    expect(screen.getByText("Sessions")).toBeTruthy();
    // `Skills` and `Agents` are the TWO labelled rows that survive (each pinned in
    // detail by its own describe block below; named here so this case reads as the
    // whole post-change shape: two labelled rows + one header `+`).
    expect(screen.getByRole("button", { name: "Skills" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agents" })).toBeTruthy();
    // …and the `Sessions` header row holds exactly ONE control — the `+`. This is
    // the "one +" half of the change; a second icon in that row (a re-added menu
    // trigger, say) is what this count catches.
    expect(screen.getByText("Sessions").parentElement!.querySelectorAll("button")).toHaveLength(1);
  });

  it("raises the New Space dialog from the Sessions header + when no space is selected", () => {
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    // The no-Space routing is the STORE command's now (`startSessionInActiveSpace`
    // → `openNewSpaceDialog`), so the `+` just delegates. Same flag assertion
    // as above — the dialog itself is rendered at `App` root.
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("raises the flag but renders NO dialog of its own (the render site is `App` root)", () => {
    // The one-dialog rule, pinned from this side: this pane can still RAISE the
    // flag (its `New Session` `+` falls through to the dialog via the store when no
    // Space is open), so if it also mounted a dialog the app would paint two (and
    // `App.test.tsx` would see a doubled title). Put the flag-gated dialog render
    // back in `SpacesList.tsx` and this goes red.
    setNewSpaceDialogOpen(true);
    render(<SpacesList />);
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(screen.queryByText("New space")).toBeNull();
  });

  it("starts a new session in the SELECTED space (not the active session's space)", async () => {
    // The active session's cwd (`/tmp/gamma`) matches NO space in the
    // fixture — but the SELECTED space is `/tmp/beta` (the tabs' state
    // is independent of the active session): the button must start in
    // the selected space, not the orphan's cwd (and not the dialog).
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s-orphan", cwd: "/tmp/gamma" }),
      ],
      activeSessionId: "s-orphan",
      activeSpacePath: "/tmp/beta",
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    await waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/beta"),
    );
  });


  it("renders the stored row's stored ring and its relative time, and NO spinner", () => {
    render(<SpacesList />);
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[role="status"]')).toBeNull();
    // A STORED session wears the dim ring — the idle cue the collapsed rail has
    // always had and the expanded list used to omit entirely (an empty slot
    // unless the session was in a turn).
    expect(row!.querySelector('[data-dot="stored"]')).toBeTruthy();
    // Last message ~1h ago → `1h`.
    expect(row!.textContent).toContain("1h");
  });

  it("renders an empty time slot (no time text) for a session with no loaded messages", () => {
    // A stored session in the ACTIVE space (`/tmp/alpha`) that was not
    // opened this boot: no loaded messages → the title falls back to
    // the space's base name (`alpha`) and the time slot is empty. The slot now
    // means NEITHER evidence survives — no transcript AND no `sessionRecency`
    // stamp (this fixture seeds no map entry, so the row still renders empty);
    // a stamped row prints its stamp, which is the pin added in the archive
    // describe below.
    useSessions.setState({
      historySessions: [
        makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha" }),
        makeSessionRow({ sessionId: "h3", cwd: "/tmp/alpha" }),
      ],
    });
    render(<SpacesList />);
    const alphas = screen.getAllByText("alpha");
    // `h3`'s row (the third `alpha` — `s1`'s + `h1`'s rows have loaded
    // messages, `h3`'s does not → its title is the base name). It is also
    // LAST: no loaded transcript is no evidence, and the stored group puts
    // evidence-free below a session it can prove was used an hour ago.
    const row = alphas[alphas.length - 1].closest('[role="button"]');
    expect(row).not.toBeNull();
    // Title only — no time text.
    expect(row!.textContent).toBe("alpha");
  });

  it("marks a pending-permission row with the ? and KEEPS its relative time", () => {
    usePermissions.setState({
      prompts: {
        s1: [{ requestId: "r1", toolTitle: "Run a tool", options: [] }],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Fix the login bug")
      .closest('[role="button"]');
    // The `?` replaces the green "Waiting" PILL: the pill and the rail's dot
    // were one fact in two shapes, and the pill's cost was the time — while a
    // session waited you could not see how long ago it had been active.
    expect(screen.queryByText("Waiting")).toBeNull();
    expect(row!.querySelector('[data-dot="waiting"]')).toBeTruthy();
    expect(row!.querySelector('[role="status"]')).toBeNull();
    expect(row!.textContent).toContain("now");
  });

  it("marks a pending interactive ask/confirm/password row with the ? too", () => {
    useInteractive.setState({
      requests: {
        h1: [
          {
            requestId: "br1",
            method: "password",
            source: "main",
            params: { command: "sudo apt install foo", reason: "test" },
          },
        ],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    // `password` included: a pending sudo password had no cue anywhere else.
    expect(row!.querySelector('[data-dot="waiting"]')).toBeTruthy();
    expect(row!.textContent).toContain("1h");
  });

  it("opens a session on row click (the store's activeSessionId + the selection styling)", () => {
    render(<SpacesList />);
    expect(useSessions.getState().activeSessionId).toBe("s1");
    fireEvent.click(screen.getByText("Refactor the parser"));
    expect(useSessions.getState().activeSessionId).toBe("h1");
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    expect(row!.className).toContain("bg-selected");
  });

  it("shows the IDLE mark in the EXPANDED list too (the cue the collapsed rail has always had)", () => {
    // The bug this pins: the open row's leading slot was empty unless the
    // session was in a turn, while the collapsed rail drew a dot for every
    // session — so EXPANDING the sidebar deleted the idle mark the user could
    // see when it was collapsed.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" }),
      ],
      activeSessionId: "s1",
      inTurn: {},
      messages: {
        s1: [makeMessage("user", { text: "Fix the login bug", at: Date.now() - 10_000 })],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Fix the login bug")
      .closest('[role="button"]');
    // Live and NOT in a turn → the filled live ring, and no spinner.
    expect(row!.querySelector('[data-dot="live"]')).toBeTruthy();
    expect(row!.querySelector('[role="status"]')).toBeNull();
  });

  it("renders its rows in the store's ONE sessionIds sequence, so a STORED row above a LIVE one in the manual order renders FIRST", () => {
    // THE manual order reaching the DOM. The store's ONE sequence (`sessionIds`)
    // answers `[h_stored, s_live]` for these numbers; the deleted display sort
    // answers `[s_live, h_stored]`, because the live block was rendered first
    // regardless of any number. This is the store-level case that
    // `sessions.test.ts`'s "groups a space with a live session and a stored
    // session" pins, shown in the DOM.
    //
    // The seed is overridden COMPLETELY — a row the seed leaves behind silently
    // joins the list and can satisfy an order assertion by accident. Both rows
    // carry a generated `title` so the labels are queryable with no transcript
    // (the trick "labels a titled STORED row by its title…" uses).
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s_live", cwd: "/tmp/alpha", title: "Live row" }),
      ],
      historySessions: [
        makeSessionRow({ sessionId: "h_stored", cwd: "/tmp/alpha", title: "Stored row" }),
      ],
      messages: {},
      activeSpacePath: "/tmp/alpha",
      // The STORED row holds the SMALLER number, i.e. the HIGHER row — the one
      // arrangement the old live-block-first render could never produce.
      sessionOrder: { h_stored: 2, s_live: 5 },
    });
    render(<SpacesList />);
    const storedRow = screen.getByText("Stored row");
    const liveRow = screen.getByText("Live row");
    expect(
      storedRow.compareDocumentPosition(liveRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a Session started after the boot fetch at the BOTTOM of the list (the new-row rule, not the live block)", () => {
    // The rule ADR 0075 chose: a NEW row joins at the BOTTOM. The order map only
    // knows what the boot fetch returned, so `s-new` has NO entry and
    // `sortByManualOrder` sinks it — while the deleted live block put a fresh
    // row FIRST (this replaces the deleted "keeps a brand-new live session … at
    // the TOP of the live group", which asserted the opposite).
    //
    // The seed's live `s1` is DROPPED, not kept: it would join the list and could
    // satisfy the assertion by accident. `h1`'s seed entry stays (its seed
    // transcript is what labels the row "Refactor the parser"); `h2` lives in
    // `/tmp/beta` and renders nowhere here.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s-new", cwd: "/tmp/alpha", title: "Just created" }),
      ],
      // The empty array is what `addSession` gives a fresh session.
      messages: { ...useSessions.getState().messages, "s-new": [] },
      sessionOrder: { h1: 0 },
    });
    render(<SpacesList />);
    const storedRow = screen.getByText("Refactor the parser");
    const freshRow = screen.getByText("Just created");
    expect(
      storedRow.compareDocumentPosition(freshRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("updates a row's relative time while its POSITION stays frozen", () => {
    // The user-visible promise this whole branch exists for: a row's LABEL stays
    // live (its own per-row `messages` subscription) while its SLOT never moves.
    // Red at HEAD for exactly the reason it exists to forbid: after the append,
    // the deleted display sort floated the newly-active row to the top of the
    // stored group, so the SECOND position comparison failed.
    const now = Date.now();
    useSessions.setState({
      sessions: [],
      historySessions: [
        makeSessionRow({ sessionId: "h_first", cwd: "/tmp/alpha", title: "Row A" }),
        makeSessionRow({ sessionId: "h_second", cwd: "/tmp/alpha", title: "Row B" }),
      ],
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { h_first: 0, h_second: 1 },
      messages: {
        h_first: [makeMessage("user", { text: "Row A asked", at: now - 10_000 })],
        h_second: [makeMessage("user", { text: "Row B asked", at: now - 3_600_000 })],
      },
    });
    render(<SpacesList />);
    const rowOf = (text: string): HTMLElement =>
      screen.getByText(text).closest('[role="button"]') as HTMLElement;
    const a = screen.getByText("Row A");
    const b = screen.getByText("Row B");
    expect(
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(rowOf("Row B")).getByText("1h")).toBeTruthy();

    // A future stamp → `now - at` is negative → the `< 60_000` bucket → "now".
    // Deterministic label change with no fake timers, and the position must not
    // move an inch.
    act(() => {
      useSessions.setState({
        messages: {
          ...useSessions.getState().messages,
          h_second: [
            makeMessage("user", {
              text: "Row B answered",
              at: Date.now() + 9_000_000_000,
            }),
          ],
        },
      });
    });
    expect(
      screen.getByText("Row A").compareDocumentPosition(screen.getByText("Row B")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(rowOf("Row B")).getByText("now")).toBeTruthy();
  });

  it("truncates a long title on a single line (the fade mask is the sole cue)", () => {
    // A 120-char first user message → `titleFor` slices it to 80 chars; the
    // title span must carry the truncation classes so it overflows under the
    // fade instead of wrapping.
    useSessions.setState({
      messages: {
        s1: [makeMessage("user", { text: "x".repeat(120), at: Date.now() - 10_000 })],
      },
    });
    render(<SpacesList />);
    const title = screen.getByText("x".repeat(80));
    expect(title.className).toContain("overflow-hidden");
    expect(title.className).toContain("whitespace-nowrap");
    expect(title.className).toContain("min-w-0");
  });

  it("ignores nothing on its own: ⌘N on an <input> is the chord's business now, and a dialog is inert", () => {
    // The chord left this component, so this file cannot test the guard — but it
    // keeps the two facts that used to be entangled with it, and separates them:
    // (1) the OLD input half is INVERTED. A text-field target no longer suppresses
    // the chord; whether the chord fires is `useAppShortcuts.test.ts`'s case, and
    // what belongs HERE is that this pane mounts no listener at all, so dispatching
    // a chord against an input inside it starts nothing on its own.
    // (2) the `role="dialog"` half survives as a statement about THIS pane: raising
    // the flag while a keypress happens inside a dialog does not stack a second
    // dialog, because the flag has one owner.
    render(<SpacesList />);
    const input = document.createElement("input");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    // Appended to `document.body` OUTSIDE RTL's render tree — RTL cleanup
    // does not touch manually appended nodes, so remove them explicitly.
    document.body.append(input, dialog);
    try {
      fireEvent.keyDown(input, { key: "n", ctrlKey: true });
      // No listener in this pane any more: nothing this component owns reacts.
      expect(mockedStartSession).not.toHaveBeenCalled();
      expect(getNewSpaceDialogOpen()).toBe(false);
      // A `[role="dialog"]` keypress raises nothing either — and the guard that
      // makes the chord inert there is pinned in `useAppShortcuts.test.ts`.
      fireEvent.keyDown(dialog, { key: "o", metaKey: true });
      expect(getNewSpaceDialogOpen()).toBe(false);
    } finally {
      input.remove();
      dialog.remove();
    }
  });

  // The two chord tests that used to live here — `⌘N / Ctrl+N trigger the New
  // Session handler (a bare key does not)` and `⌘O opens the Open Space dialog` —
  // MOVED to `../hooks/useAppShortcuts.test.ts`. They dispatched on `window`, which
  // was only reachable because this component subscribed on `window`; no listener
  // remains here, so keeping them would mean they pass vacuously. Their coverage
  // moved with them (plus the `contenteditable="false"` case, the textarea cases,
  // the auto-repeat case and the dialog/alertdialog guard cases).

});

describe("SpacesList — the Skills button and empty-state modal", () => {
  it("the_skills_button_sits_in_the_button_row", async () => {
    render(<SpacesList />);
    // The first of the command row's TWO surviving labelled buttons (the skill
    // LIST no longer renders in the pane — the button opens a modal; and the
    // `New Session` / `Open Space` rows that used to lead this block are gone).
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    // The one-fetch property (single consumer): one `listSkills` call.
    expect(mockedListSkills).toHaveBeenCalledTimes(1);
  });

  it("the_skills_modal_shows_the_empty_state_when_there_are_no_skills", async () => {
    // `clearAllMocks` PRESERVES the factory's 1-skill implementation, so
    // override it here. Declared LAST so the override cannot leak into
    // the other test (the `beforeEach` cache-clear makes each test
    // refetch; because implementations are preserved, this test's
    // `mockResolvedValue([])` would leak to any test declared after it —
    // declaration order is what keeps the two independent).
    vi.mocked(listSkills).mockResolvedValue([]);
    render(<SpacesList />);
    // Open the modal from the button.
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    await screen.findByText("No skills found.");
  });
});


describe("SpacesList (archive, ADR 0016)", () => {
  /** Seed an archived (flag-on) stored session in the `alpha` space.
   * `messages` (when given) makes the row's title message-derived. */
  function seedArchived(
    id: string = "a1",
    opts: { live?: boolean; messages?: { text: string; at: number } } = {},
  ): void {
    const row = makeSessionRow({
      sessionId: id,
      cwd: "/tmp/alpha",
      archived: true,
    });
    useSessions.setState({
      sessions: opts.live ? [row] : [],
      archivedSessions: [row],
      activeSessionId: id,
      ...(opts.messages
        ? { messages: { [id]: [makeMessage("user", opts.messages)] } }
        : {}),
    });
  }

  /**
   * Scope a query to ONE row. A row is itself `role="button"` and its inner
   * buttons carry `aria-label`s beginning with the action verb, so a whole-
   * document `getByRole("button", { name: "Stop …" })` is not the problem — but
   * a LOOSE regex (`/Stop/`) would match the row too, and worse: in a render
   * where `s1` is live and `h1` is stored, an unscoped query cannot tell which
   * row's button it found. The `.closest('[role="button"]')` step is this file's
   * own row-locating pattern (see the mark tests above).
   *
   * TYPED as the bound-query object `within` returns rather than as the row
   * element, so callers write `rowOf(… ).getByRole(…)` directly. (Annotating it
   * `HTMLElement` — the element `within` was handed — does not compile: `tsc`
   * then rejects every `.getByRole` call, and `build` is the type gate here.)
   */
  const rowOf = (text: string): ReturnType<typeof within> =>
    within(screen.getByText(text).closest('[role="button"]') as HTMLElement);

  it("a stored row offers an Archive hover action that archives it", async () => {
    render(<SpacesList />);
    // `h1`'s title is "Refactor the parser" (its first user message).
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Refactor the parser" }),
    );
    // The store action moved the entry (the backend call resolved via
    // the mock) — `historySessions` lost it, `archivedSessions` gained it.
    await waitFor(() => {
      const { archivedSessions, historySessions } = useSessions.getState();
      expect(
        archivedSessions.some((s) => s.sessionId === "h1"),
      ).toBe(true);
      expect(
        historySessions.some((s) => s.sessionId === "h1"),
      ).toBe(false);
    });
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("h1", true);
  });

  it("a live in-turn row offers Stop and Archive, and Stop cancels the turn", async () => {
    // The fixture's live `s1` is IN A TURN (`inTurn: { s1: true }`), so Stop
    // must CANCEL the turn — the Worker is kept, the row stays live.
    render(<SpacesList />);
    const stop = rowOf("Fix the login bug").getByRole("button", {
      name: "Stop Fix the login bug",
    });
    // The tooltip promises the turn-level meaning, and it reads the SAME field
    // the store branches on — a row whose hover said "Stop this session" while
    // cancelling a turn would be a promise the click breaks. (No `toHaveAttribute`
    // here: this repo's vitest setup carries no jest-dom.)
    expect(stop.getAttribute("title")).toBe("Stop this turn");
    fireEvent.click(stop);
    await waitFor(() => expect(cancelSession).toHaveBeenCalledWith("s1"));
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("a live idle row's Stop closes the Session", async () => {
    // Same button, different turn state: with nothing in flight there is no
    // turn to cancel, so Stop reaps the Worker (`closeSession`). The branch is
    // read at CLICK time inside `stopSession`, which is why the `setState` below
    // needs no re-render of the row to take effect.
    render(<SpacesList />);
    act(() => useSessions.setState({ inTurn: {} }));
    const stop = rowOf("Fix the login bug").getByRole("button", {
      name: "Stop Fix the login bug",
    });
    // …and the tooltip follows the turn state down to the session-level wording.
    expect(stop.getAttribute("title")).toBe("Stop this session");
    fireEvent.click(stop);
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("s1"));
    expect(cancelSession).not.toHaveBeenCalled();
  });

  it("Archive on a live row sets the flag then closes the Session", async () => {
    // The ORDER is the design, not a detail: the flag commits and the row moves
    // BEFORE the close, so when `session-closed` lands the store's sticky guard
    // files the row under `archivedSessions` instead of flickering it through
    // the Space group. Close-first would race that async event.
    render(<SpacesList />);
    fireEvent.click(
      rowOf("Fix the login bug").getByRole("button", {
        name: "Archive Fix the login bug",
      }),
    );
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("s1"));
    expect(setSessionArchived).toHaveBeenCalledWith("s1", true);
    const flagCall = vi
      .mocked(setSessionArchived)
      .mock.calls.findIndex(([id]) => id === "s1");
    const closeCall = vi
      .mocked(closeSession)
      .mock.calls.findIndex(([id]) => id === "s1");
    expect(flagCall).toBeGreaterThanOrEqual(0);
    expect(closeCall).toBeGreaterThanOrEqual(0);
    expect(
      vi.mocked(setSessionArchived).mock.invocationCallOrder[flagCall]!,
    ).toBeLessThan(
      vi.mocked(closeSession).mock.invocationCallOrder[closeCall]!,
    );
    // …and the row landed where Archive puts it.
    await waitFor(() => {
      const { archivedSessions } = useSessions.getState();
      expect(archivedSessions.some((s) => s.sessionId === "s1")).toBe(true);
    });
  });

  it("a stored row offers no Stop button", () => {
    // Stop is a LIVE-row action: a stored Session has no Worker to stop, so
    // `stopSession` would no-op and the button would be a lie. Scoping to the
    // row is what makes this assertion mean anything — `s1` is live in the same
    // render and DOES have a Stop, so a document-wide query finds one either
    // way.
    render(<SpacesList />);
    const row = rowOf("Refactor the parser");
    expect(row.queryByRole("button", { name: /^Stop / })).toBeNull();
    expect(
      row.getByRole("button", { name: "Archive Refactor the parser" }),
    ).toBeTruthy();
  });

  it("a live row offers Stop and Archive, and still no Pause (the pause concept is gone)", () => {
    // The INVERTED assertion of the test this replaces. Live rows used to render
    // the time with no swap at all — Pause was deleted and nothing took its
    // place, so a running Session could not be stopped or put away without
    // opening it. It now swaps like every other row does; the pause concept
    // stays gone, which is the half of the old test still worth pinning.
    render(<SpacesList />);
    const row = rowOf("Fix the login bug");
    expect(row.queryByRole("button", { name: /Pause/ })).toBeNull();
    expect(
      row.getByRole("button", { name: "Stop Fix the login bug" }),
    ).toBeTruthy();
    expect(
      row.getByRole("button", { name: "Archive Fix the login bug" }),
    ).toBeTruthy();
    // The time is still what the row shows at rest (the buttons are hover-only —
    // and jsdom applies no CSS, so "present in the DOM" is not proof of that;
    // what this pins is that the swap keeps the time node in the row).
    expect(row.getByText("now")).toBeTruthy();
  });

  it("Stop and Archive swallow the row's own click-to-open", () => {
    // Both buttons sit INSIDE the row, and the row's click is "open this
    // Session". Without `stopPropagation` a click on Stop would also open the
    // Session it just stopped (and Archive would open the row it just filed
    // away) — the sidebar would fight the command the user just gave.
    //
    // The probe is `activeSessionId`, which ONLY the row's own `onOpen`
    // (`openSession`) writes, and it is deliberately parked on `h2` — a id
    // neither button belongs to. Left at the seed's `s1`, a leaked click on `s1`'s
    // Stop would re-select `s1` and the assertion would pass for the wrong
    // reason.
    useSessions.setState({ activeSessionId: "h2" });
    render(<SpacesList />);
    fireEvent.click(
      rowOf("Refactor the parser").getByRole("button", {
        name: "Archive Refactor the parser",
      }),
    );
    expect(useSessions.getState().activeSessionId).toBe("h2");
    fireEvent.click(
      rowOf("Fix the login bug").getByRole("button", {
        name: "Stop Fix the login bug",
      }),
    );
    expect(useSessions.getState().activeSessionId).toBe("h2");
  });

  it("the Archived section is collapsed by default and lists archived sessions", () => {
    seedArchived("a1", {
      messages: { text: "Archive the logs", at: Date.now() - 3_600_000 },
    });
    render(<SpacesList />);
    // The header renders (with the count badge) even when collapsed…
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    // …and the row is NOT rendered while collapsed. (The prefix match is
    // retained from when the title carried a `· alpha` suffix span; the span is
    // gone now that the section is Space-scoped, but the assertion still reads.)
    expect(screen.queryByText(/^Archive the logs/)).toBeNull();
    // Expanding the section (clicking the header) reveals the row.
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByText(/^Archive the logs/)).toBeTruthy();
  });

  /** One archived row of ANOTHER Space (`/tmp/beta`), appended to whatever the
   * store already holds. A generated `title` so the row's text is queryable
   * without seeding a transcript for it.
   *
   * APPENDS (it reads the store's current `archivedSessions` and adds to it), so
   * it is order-sensitive relative to `seed()`: call it AFTER the seed (or after
   * any other archived seeding) whose rows you mean to keep alongside, and note
   * that `seed()` — called from the file's `beforeEach` — resets
   * `archivedSessions` to `[]`, so nothing survives from an earlier test. */
  function seedArchivedElsewhere(
    id: string,
    title: string,
    cwd: string = "/tmp/beta",
  ): void {
    useSessions.setState((s) => ({
      archivedSessions: [
        ...s.archivedSessions,
        makeSessionRow({ sessionId: id, cwd, archived: true, title }),
      ],
    }));
  }

  it("lists ONLY the active Space's archived rows (another Space's row renders nowhere)", () => {
    // The section is Space-scoped (ADR 0016, amended 2026-10-21): `beta` has an
    // open tab but is NOT the selected Space, so its archived row renders in no
    // group of this sidebar at all (a row of a Space with NO tab is in the same
    // boat — it is **Detached** and lives in Settings → Detached sessions, and
    // there is deliberately NO fallback listing here).
    seedArchived("a1", {
      messages: { text: "Archive the logs", at: Date.now() - 3_600_000 },
    });
    seedArchivedElsewhere("b1", "Beta archived work");
    // A GENUINELY Detached row: `/tmp/detached` matches NO entry in the file's
    // `spaces` fixture (seed() opens `/tmp/alpha` and `/tmp/beta` only), so this
    // is the case the component's doc comment calls out — no tab, therefore no
    // fallback listing anywhere in the sidebar.
    seedArchivedElsewhere("d1", "Detached archived work", "/tmp/detached");
    // `activeSpacePath` is `/tmp/alpha` (the file's `seed()` fixture).
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The active Space's row is there…
    expect(screen.getByText(/^Archive the logs/)).toBeTruthy();
    // …and the other Space's row is absent from the WHOLE document, not merely
    // from the section (it must not be re-filed into a Space group either).
    expect(screen.queryByText("Beta archived work")).toBeNull();
    // …and so is the Detached row: with no Space of its own it is listed ONLY in
    // Settings → Detached sessions.
    expect(screen.queryByText("Detached archived work")).toBeNull();
  });

  it("the header count counts the active Space's rows only", () => {
    // One `alpha` row + two `beta` rows: the badge reads 1, not 3 — the count is
    // the SAME predicate the rows are filtered by, so the header cannot advertise
    // rows the expanded section will not show.
    //
    // The `alpha` row carries a message so its label is queryable (an untitled,
    // transcript-less row falls back to the SPACE name, which other rows render
    // too and which would make the row-count assertion below ambiguous).
    seedArchived("a1", {
      messages: { text: "Trimming the archived logs", at: Date.now() - 3_600_000 },
    });
    seedArchivedElsewhere("b1", "Beta archived work one");
    seedArchivedElsewhere("b2", "Beta archived work two");
    render(<SpacesList />);
    // Scoped to the header row (`rowOf`): a bare `getByText("1")` would match a
    // count anywhere else in the pane.
    expect(rowOf("Archived").getByText("1")).toBeTruthy();
    expect(rowOf("Archived").queryByText("3")).toBeNull();
    // THE JOINT PROPERTY, in ONE render: the badge's `1` is the number of rows
    // the expanded section actually shows. Both derive from the same `visible`
    // array today, so nothing here fails on the current code — this pins the
    // refactor that SPLITS the two (a count computed before the filter, or a row
    // list filtered differently from the badge) and would otherwise show a
    // header advertising rows that never appear.
    fireEvent.click(screen.getByText("Archived"));
    // Exactly ONE rendered row for the active Space (length, not mere presence —
    // a duplicated row would break the equality with the badge)…
    expect(screen.getAllByText(/^Trimming the archived logs/)).toHaveLength(1);
    // …and NEITHER of the two `beta` rows the badge refused to count is rendered.
    expect(screen.queryByText("Beta archived work one")).toBeNull();
    expect(screen.queryByText("Beta archived work two")).toBeNull();
  });

  it("lists the Archived rows in RECENCY order when the store's input order (the Manual order) disagrees", () => {
    // THE LIVE DEFECT ADR 0075 predicted. The section rendered
    // `archived.filter(…)` in INPUT order and inherited recency for free, because
    // `list_sessions` used to sort by the last-activity expression. T01 swapped
    // that `ORDER BY` to the Manual order, so the same filter has been presenting
    // a manual arrangement under a heading that means recency — and passing every
    // archived test in this file, because not one of them asserted the ORDER.
    //
    // TWO COMPETING ANSWERS: input order (what the component does today, and what
    // the Manual order now means) answers "first" then "last"; the store's
    // `archivedInSpace` explicit recency sort answers "last" then "first".
    // Flipping the two `sessionRecency` values flips the expectation, so this
    // cannot pass by accident.
    //
    // `sessions`/`historySessions` are emptied so nothing else competes for the
    // DOM positions; both rows carry a generated `title`, so no transcript is
    // needed for the labels to be queryable.
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [
        makeSessionRow({
          sessionId: "a_first",
          cwd: "/tmp/alpha",
          archived: true,
          title: "Archived first in the manual order",
        }),
        makeSessionRow({
          sessionId: "a_second",
          cwd: "/tmp/alpha",
          archived: true,
          title: "Archived last in the manual order",
        }),
      ],
      // `a_second` is the RECENT one (a far-future stamp, never arithmetic that
      // can tie) while the input order puts it SECOND.
      sessionRecency: { a_first: 1_000, a_second: 9_000_000_000_000 },
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    const firstInManual = screen.getByText("Archived first in the manual order");
    const lastInManual = screen.getByText("Archived last in the manual order");
    expect(
      lastInManual.compareDocumentPosition(firstInManual) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // …and the BADGE still counts the array the rows came from (the joint
    // property "the header count counts the active Space's rows only" pins for
    // the cross-Space case; this closes the SORT half of it). Scoped to the
    // header row — a bare `getByText("2")` would match a count anywhere in the
    // pane.
    expect(rowOf("Archived").getByText("2")).toBeTruthy();
  });

  it("prints the boot recency label when a stored row has no transcript but the map has a stamp (the Archived-symptom closed)", () => {
    // FINDING 11'S SYMPTOM, IN THE DOM. `recencyOf` — the number `sortByRecency`
    // orders the Archived list by and the Landing pick decides by — fell back to
    // the boot `sessionRecency` stamp for a session with no loaded transcript,
    // while `relativeTimeFor` rendered an EMPTY slot for the same row. The list
    // was ordered by a number its own row refused to print. `relativeTimeFor`
    // now delegates to `recencyOf`, so the stamp prints.
    //
    // `h2` is seed()'s ONE transcript-less stored row (`messages` holds only
    // `s1` and `h1`, and `h2` carries no stored `title`), and it lives in
    // `/tmp/beta` — so the selected Space moves there and the row renders under
    // its base name "beta". Nothing else is invented: the row, its Space and the
    // reset all come from seed()'s fixture (`resetStores()` runs inside it).
    useSessions.setState({
      activeSpacePath: "/tmp/beta",
      sessionRecency: { h2: Date.now() - 5 * 60_000 },
    });
    render(<SpacesList />);
    // The stamp buckets to exactly `5m` against the wall clock the component uses.
    expect(rowOf("beta").getByText("5m")).toBeTruthy();
  });

  it("renders the empty state with NO Space selected, even though archived rows exist", () => {
    // `cwd === activeSpacePath` matches nothing when no Space is selected, which
    // is honest: those rows are Detached (CONTEXT.md) and live in Settings →
    // Detached sessions. The section still renders (header + empty state) rather
    // than silently disappearing.
    seedArchived("a1", {
      messages: { text: "Archive the logs", at: Date.now() - 3_600_000 },
    });
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByText("No archived sessions.")).toBeTruthy();
    expect(screen.queryByText(/^Archive the logs/)).toBeNull();
  });

  it("unarchive moves the row back", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() => {
      const { archivedSessions, historySessions } = useSessions.getState();
      expect(
        archivedSessions.some((s) => s.sessionId === "a1"),
      ).toBe(false);
      expect(
        historySessions.some((s) => s.sessionId === "a1"),
      ).toBe(true);
    });
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("a1", false);
  });

  it("delete from the Archived section confirms and removes", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The destructive action opens the confirm dialog.
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(screen.getByText("Delete session?")).toBeTruthy();
    // Cancel: the row remains, the dialog closes.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete session?")).toBeNull();
    expect(
      useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
    ).toBe(true);
    // Delete: the row vanishes from the store and the dialog closes.
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
      ).toBe(false),
    );
    expect(screen.queryByText("Delete session?")).toBeNull();
    expect(mockedDeleteSession).toHaveBeenCalledWith("a1");
  });

  it("a live session that is also archived is view-filtered out of the Archived section", () => {
    seedArchived("a1", { live: true, messages: { text: "Both lists", at: Date.now() - 10_000 } });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The row renders exactly ONCE — as the live row in its Space group
    // (the sticky live id is view-filtered out of the Archived section).
    // Prefix match retained from when the row's title carried a `· alpha`
    // suffix span (that span is gone — the section is Space-scoped now); the
    // count is what this test pins.
    expect(screen.getAllByText(/^Both lists/)).toHaveLength(1);
  });

  it("New Session with an archived session active starts a conversation in that space (not the New Space dialog)", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    // The `activeView` predicate matches via `archivedSessionIds` → the
    // hook starts a native session in that space.
    await waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha"),
    );
    // The negative pin, on the FLAG: "it did not fall back to the dialog" is the
    // claim, and `queryByText("New space")` could no longer express it — this pane
    // renders no dialog, so a text query there would pass for every input.
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("an archived-only active session still resolves its space for the skill catalog", async () => {
    seedArchived();
    render(<SpacesList />);
    // The `useSkillCatalog` input path (`activeSession ? undefined :
    // activeHistory ?? archivedSessions.find(…)`): the active session's
    // Space path, NOT `null` (which would silently degrade the catalog
    // to user-level skills). `listSkills` is called with the fetch key.
    await waitFor(() =>
      expect(mockedListSkills).toHaveBeenCalledWith("/tmp/alpha"),
    );
  });

  it("logs a console error when Archive fails (the row is NOT moved)", async () => {
    vi.mocked(setSessionArchived).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Refactor the parser" }),
    );
    // The rejection is logged (no unhandled rejection in the webview)...
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to archive session:",
        expect.anything(),
      ),
    );
    // ...and the move did NOT land: the row is still a stored session.
    const { archivedSessions, historySessions } = useSessions.getState();
    expect(archivedSessions.some((s) => s.sessionId === "h1")).toBe(false);
    expect(historySessions.some((s) => s.sessionId === "h1")).toBe(true);
  });

  it("logs a console error when Unarchive fails (the row is NOT moved)", async () => {
    seedArchived();
    vi.mocked(setSessionArchived).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to unarchive session:",
        expect.anything(),
      ),
    );
    // The row is still archived (the mirror move did NOT land).
    const { archivedSessions, historySessions } = useSessions.getState();
    expect(archivedSessions.some((s) => s.sessionId === "a1")).toBe(true);
    expect(historySessions.some((s) => s.sessionId === "a1")).toBe(false);
  });

  it("closes the delete dialog and logs a console error when Delete fails (the row remains)", async () => {
    seedArchived();
    mockedDeleteSession.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // The dialog closes even on failure (a stuck-open dialog is worse
    // than a logged failure) — the close is deferred into the `.catch`,
    // so wait for it.
    await waitFor(() =>
      expect(screen.queryByText("Delete session?")).toBeNull(),
    );
    // ...and the rejection is logged (no unhandled rejection).
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to delete session:",
        expect.anything(),
      ),
    );
    // The row remains: the store's delete only lands after the command
    // resolves.
    expect(
      useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
    ).toBe(true);
  });

  // -- The `+` in the `Sessions` header (it replaced the `...` menu that used to
  // -- sit there, right-aligned next to the word `Sessions`) --

  it("the `+` in the Sessions header starts a session in the ACTIVE space", async () => {
    const { startSession } = await import("../lib/tauri");
    // The seed's active space is `/tmp/alpha`.
    render(<SpacesList />);
    // The `+` sits in the `Sessions` header row (right of the label) — scoping the
    // query to the header is what distinguishes it from the rail's `+` in a
    // collapsed render, and it also pins the PLACEMENT, not just the name.
    const header = screen.getByText("Sessions").parentElement!;
    const plus = header.querySelector('[aria-label="New Session"]');
    expect(plus).toBeTruthy();
    // A plain `click` now: this is a `<Button>`, not a Radix menu trigger, so
    // there is no `pointerDown`-to-open / `Enter`-to-select dance left to perform.
    fireEvent.click(plus!);
    await waitFor(() =>
      expect(vi.mocked(startSession)).toHaveBeenCalledWith("/tmp/alpha"),
    );
  });

  it("shows the last new-session failure as the + button's title", () => {
    // The `title` arm this change MOVES: the deleted `···` trigger carried
    // `newSessionError ?? undefined`, so a dead control said why. The `+` inherits
    // that, and nothing else in this file read a `title` off it before (the only
    // other `getAttribute("title")` here is the Stop button), so without this case
    // the error arm is unguarded.
    useSessions.setState({ newSessionError: "boom" });
    render(<SpacesList />);
    expect(
      screen.getByRole("button", { name: "New Session" }).getAttribute("title"),
    ).toBe("boom");
  });

  it("falls back to the ⌘N hint in the + button's title when nothing failed", () => {
    // The OTHER arm — and the only place the ⌘N chord is written down now that the
    // `<Kbd>` chip is gone with the labelled row. Drop the `??` fallback in the
    // component and this is what goes red.
    useSessions.setState({ newSessionError: null });
    render(<SpacesList />);
    expect(
      screen.getByRole("button", { name: "New Session" }).getAttribute("title"),
    ).toBe("New Session  ⌘N");
  });

  // -- The pane holds NO controls at all: the collapse toggle and the Settings
  // -- gear both live in the chrome bar's `ChromeControls`, beside the window
  // -- controls (`App.tsx`, pinned by `App.test.tsx`'s `the chrome bar carries
  // -- the app controls`). What follows asserts the ABSENCE from this pane in
  // -- both states — the shape the move leaves behind. --

  for (const state of ["expanded", "collapsed"] as const) {
    it(`holds NO collapse toggle and NO gear while ${state} (both moved to the chrome bar)`, () => {
      act(() => {
        setLeftPaneCollapsed(state === "collapsed");
      });
      const { container } = render(<SpacesList />);
      // Every label the toggle has ever carried, plus the gear's, so a rename
      // cannot quietly re-add one of these two controls here and leave this
      // test vacuous. The pane's OWN commands (the `New Session` `+`, `Skills`,
      // `Agents`) are NOT in this list — they legitimately survive the
      // collapse as rail icons, which is what the rail's own tests assert.
      for (const label of [
        "Collapse session list",
        "Expand session list",
        "Collapse sidebar",
        "Expand sidebar",
        "Settings",
      ]) {
        expect(screen.queryByRole("button", { name: label }), label).toBeNull();
      }
      // The STABLE hook, not the label: the label flips with the state, so a
      // name-only query could pass on one side of the collapse by accident.
      expect(container.querySelector('[data-testid="left-pane-toggle"]')).toBeNull();
      // The footer ROW is gone, not merely emptied. The pane's last child is
      // now the clipped content region (expanded) or the collapsed rail — both
      // of which DO hold buttons, so the check is which surface ends the pane,
      // not whether it holds any. A footer control strip would come last.
      const last = (container.firstChild as HTMLElement).lastElementChild!;
      const isContentRegion = last.contains(screen.getByText("Sessions"));
      const isRail = last.getAttribute("data-testid") === "session-rail";
      expect(
        isContentRegion || isRail,
        `the pane ends with a ${last.tagName}, not the content region or the rail`,
      ).toBe(true);
    });
  }

  it("takes its collapse from the shared flag with no control of its own", () => {
    // The pane is now a pure READER of `leftPaneState` — the writer sits in the
    // chrome bar — so collapsing from outside still resizes it. This is the
    // contract between `ChromeControls` (writer) and this pane (reader).
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe("260px");
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(getLeftPaneCollapsed()).toBe(true);
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(frame.style.width).toBe("260px");
  });

  it("collapses to the sliver (the content stays mounted, clipped, not unmounted)", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    // The content (the `Sessions` label) is clipped (width 0 +
    // `overflow: hidden`) — NOT unmounted (the list's local state
    // survives a collapse; the `fixed` dialogs escape the clipping).
    expect(screen.getByText("Sessions")).toBeTruthy();
    // Expanding via the shared flag restores the full frame.
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(frame.style.width).toBe("260px");
  });

  it("carries NO bg-warning FILL in either state, even with a pending request (the dot rides the chrome-bar toggle now)", () => {
    // The pane's own toggle used to wear a `bg-warning` dot while collapsed.
    // That button now lives in `ChromeControls`, so the pane keeps only the
    // ROW's cue — the `?` in `text-warning`, in both sidebar states. Asserted
    // in both states, because the collapsed rail is exactly where a leftover
    // dot would have been.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" }),
      ],
      activeSessionId: "s1",
    });
    usePermissions.setState({
      prompts: {
        s1: [{ requestId: "r1", toolTitle: "bash", options: [] }],
      },
    });
    for (const collapsedNow of [false, true]) {
      act(() => {
        setLeftPaneCollapsed(collapsedNow);
      });
      const { container: c } = render(<SpacesList />);
      expect(c.querySelector(".bg-warning"), `collapsed=${collapsedNow}`).toBeNull();
      // …and the row DOES carry its own cue, so the assertion above cannot be
      // satisfied by a pane that shows nothing at all.
      expect(c.querySelector('[data-dot="waiting"]'), `collapsed=${collapsedNow}`).toBeTruthy();
    }
  });

  it("collapses to the sliver: the session marks show, and NO text bleeds in", () => {
    // The two defects the rail replaces, both from one cause: the collapse is
    // width + `overflow: hidden` with the content kept MOUNTED, so the list
    // painted INTO the 40px sliver — the action buttons wrapped to one word per
    // line ("O / Sp / Se / Sk"), the `Sessions` header became "Sess", and the
    // scroller grew a scrollbar in a 40px column.
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    // The rail: the ACTIVE space's sessions, one mark each (the fixture's
    // `alpha` = live `s1` in-turn + stored `h1`).
    const rail = screen.getByTestId("session-rail");
    expect(screen.getAllByTestId("session-row")).toHaveLength(2);
    // Running first (the list's own order: live, then stored) — the SPINNER,
    // the glyph the open row uses for the same fact. Queried by test id rather
    // than `[role="status"]`: the rail's marks are decoration under one
    // summarising `role="img"`, so the spinner's own role is silenced here.
    const marks = screen.getAllByTestId("session-mark");
    expect(marks[0]!.tagName).toBe("svg");
    expect(marks[0]!.getAttribute("class")).toContain("animate-spin");
    expect(rail.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Sessions 2, 1 running" })).toBeTruthy();
    // Nothing that carries text is painted in the sliver: `visibility: hidden`
    // takes the content AND ITS SCROLLBAR out of the paint while leaving it
    // mounted (`hidden` would unlayout it, and clipping alone is what produced
    // the wrapped text and the stray scrollbar).
    // (`Open Space` used to be in this list and left with its labelled row. The
    // `if (node)` guard below meant the stale entry could never fail — it is prose
    // hygiene, not a fix.)
    for (const label of ["New Session", "Skills", "Agents", "Sessions", "Archived"]) {
      const node = screen.queryByText(label);
      if (node) {
        expect(painted(node), `${label} bleeds into the sliver`).toBe(false);
      }
    }
    // …and the rail is NOT hidden — the assertion that makes the loop above
    // mean something rather than passing on a blanket `invisible` root.
    expect(painted(rail)).toBe(true);
    // Content stays MOUNTED (not unmounted): the row's title node is still in
    // the tree, just not painted.
    expect(screen.getByText("Fix the login bug")).toBeTruthy();
    // Expanding restores the list and drops the rail.
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(painted(screen.getByText("Sessions"))).toBe(true);
    expect(screen.queryByTestId("session-rail")).toBeNull();
  });

  it("keeps the rail's marks POSITIONALLY equal to the rows, because both come from the store's ONE sequence", () => {
    // The rail's whole meaning is "the Nth mark is the Nth row". That equality
    // is now STRUCTURAL — the rows and the rail read the same array
    // (`activeView.sessionIds`) — and this test is the pin that keeps it that way
    // if someone re-derives one of the two and lets them drift.
    //
    // The fixture is what makes it non-vacuous, so the numbers are stated:
    // `sessionOrder: { s2: 0, s1: 1, h1: 2 }` says the live row `s2` is the FIRST
    // row while `s1` is the row with the most recent message. The store's
    // sequence therefore answers rows two/one/three → marks
    // running/waiting/stored; the deleted display sort answers one/two/three
    // (`s1`'s message is newer, so it led the live group) → marks
    // waiting/running/stored. Seed the "obvious" ascending
    // `{ s1: 0, s2: 1, h1: 2 }` instead and BOTH rules answer identically, so the
    // test would pass while certifying nothing.
    const now = Date.now();
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" }),
        makeSessionRow({ sessionId: "s2", cwd: "/tmp/alpha" }),
      ],
      activeSpacePath: "/tmp/alpha",
      activeSessionId: "s2",
      // `s1` is the most recently ACTIVE live session and the one WAITING; `s2`
      // is the one in a turn. The marks therefore differ BY POSITION between the
      // two orders — a rail that sorted itself differently shows `waiting` first.
      inTurn: { s2: true },
      messages: {
        s1: [makeMessage("user", { text: "Row one", at: now - 5_000 })],
        s2: [makeMessage("user", { text: "Row two", at: now - 90_000 })],
        h1: [makeMessage("user", { text: "Row three", at: now - 3_600_000 })],
      },
      sessionOrder: { s2: 0, s1: 1, h1: 2 },
    });
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    const { unmount } = render(<SpacesList />);
    const one = screen.getByText("Row one");
    const two = screen.getByText("Row two");
    const three = screen.getByText("Row three");
    // The MAP's order (two, one, three) — NOT the activity order (one would lead).
    expect(
      two.compareDocumentPosition(one) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      one.compareDocumentPosition(three) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();

    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    const marks = [
      ...screen.getByTestId("session-rail-marks").querySelectorAll(
        "[data-testid='session-mark']",
      ),
    ];
    // Same COUNT as the rows, and per position the SAME GLYPH the row above it
    // wears: spinner, `?`, stored. A rail that ordered itself a second way would
    // lead with the `?`.
    expect(marks.map((m) => m.getAttribute("data-dot") ?? "running")).toEqual([
      "running",
      "waiting",
      "stored",
    ]);
  });

  it("shows the marks ONLY while collapsed (the open list is the readout)", () => {
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail")).toBeNull();
  });

  it("marks a session WAITING in the rail with the app's attention cue", () => {
    // The cue that matters most behind a collapsed pane: a session blocked on
    // the user. The `?` in the attention ink (see `SessionStatusMark`), and it
    // outranks the spinner (a blocked session is not working — see
    // `useSessionStatus`).
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    const dot = screen.getByTestId("session-rail").querySelector('[data-dot="waiting"]');
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute("class")).toContain("text-warning");
    expect(screen.getByRole("img", { name: "Sessions 2, 1 waiting" })).toBeTruthy();
  });

  // -- The rail's action strip: the pane's commands survive the collapse --

  it("offers the pane's three commands as icons while collapsed (not Settings)", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    // The list's own buttons survive the collapse as icons. `Settings` is
    // deliberately NOT among them: the gear lives in the chrome bar in both
    // states, so the rail used to carry a second copy and that tail strip is
    // gone (see `SessionRail`'s doc).
    //
    // THREE, not four: `Open Space` left the pane with its labelled row, so the
    // rail lost its twin. `Agents` is on the rail because the labelled button
    // sits inside the region the collapse hides — dropping a command here would
    // give it a vanishing door, which is the exact defect the `railActions`
    // comment exists to prevent. Narrowing the count and this name together is
    // intentional, not a broken pin.
    for (const label of ["New Session", "Skills", "Agents"]) {
      expect(
        within(screen.getByTestId("session-rail-actions")).getByRole("button", {
          name: label,
        }),
        label,
      ).toBeTruthy();
    }
    expect(
      within(screen.getByTestId("session-rail-actions")).getAllByRole("button"),
    ).toHaveLength(3);
    // And nothing here reaches for Settings, in either strip or anywhere else.
    expect(container.querySelector('[data-testid="session-rail-tail-actions"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("wires each rail icon to the SAME handler the labelled control uses", () => {
    // Split from the presence test on purpose: `Skills` and `Agents` open
    // MODALS, and a modal `aria-hidden`s the rest of the app — so a second
    // query against the rail after one opens fails for the correct reason
    // (testing-library honours it) and would read as a broken rail.
    // (`Settings` used to be asserted here too, through an `onOpenSettings`
    // prop — the gear is the chrome bar's now, and the pane has no such prop.)
    // `getByTitle` matches EXACTLY, not as a substring, so the header `+`'s
    // `title="New Session  ⌘N"` does NOT collide here: this still resolves to the
    // rail's icon alone, which is the point of the assertion.
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByTitle("New Session"));
    expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha");
    // The Skills modal renders, and it renders even though the pane's content
    // region is `invisible` — the dialogs sit OUTSIDE that region on purpose
    // (`visibility: hidden` inherits into `fixed` descendants).
    fireEvent.click(screen.getByTitle("Skills"));
    expect(screen.getByPlaceholderText("Search skills…")).toBeTruthy();
  });

  it("the Sessions header + gets the no-Space dialog fallback", () => {
    // The no-Space fallback must fire from a SIDEBAR surface, and this is the only
    // test that pins that. It used to be pinned through the `…` menu's item, which
    // had called the (now deleted) hook DIRECTLY and so had NO fallback at all — a
    // control that looked alive and did nothing. The header `+` goes through
    // `startSessionInActiveSpace`, so the store raises the dialog; a component that
    // started calling `startSession` directly (or swallowed the null case) is what
    // this would catch.
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    // Asserted on the FLAG: this pane raises it and `App` root renders the dialog,
    // so a text query here could not express the claim (see the case above).
    expect(getNewSpaceDialogOpen()).toBe(true);
    // …and it did NOT try to start a Session in a Space that does not exist.
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("holds NO Settings door at all — the pane owns none in either state", () => {
    // The reverse of the old guarantee. This pane used to be Settings' only
    // door, which is why collapsing it needed a replacement gear in the rail;
    // the chrome bar now holds the single gear for both states, so this
    // component must render none — and must not accept an `onOpenSettings`
    // prop to be wired to. The single-door assertion lives in `App.test.tsx`.
    render(<SpacesList />);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("renders NO action strip while open (the labelled buttons are the controls)", () => {
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail-actions")).toBeNull();
  });

  it("keeps the commands available with NO sessions (an empty rail is not an inert rail)", () => {
    // The rail used to render only when the list had rows; the commands are
    // exactly what a user with an empty/fresh space needs (and `New Session`
    // routes to the Open Space dialog when no space is selected).
    useSessions.setState({ activeSpacePath: "/tmp/nonexistent" });
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail-marks")).toBeNull();
    expect(
      within(screen.getByTestId("session-rail-actions")).getByRole("button", {
        name: "New Session",
      }),
    ).toBeTruthy();
  });

  it("the left rail is WIDE ENOUGH for its own controls (the sliver is a guarantee, not a vibe)", () => {
    // A collapsed pane keeps a sliver of width so the rail's marks and its
    // three command icons stay visible. jsdom never clips, so NO DOM assertion
    // here can notice a rail that shrank below the icons — the commands would
    // silently vanish while every test stayed green. Hence arithmetic:
    //   24px icon button (`size-6`) + 8px clear of each edge.
    // (It used to be justified as the room for the pane's OWN collapse toggle;
    // that button is in the chrome bar now, and the rail's icons still need it.)
    expect(LEFT_PANE_RAIL).toBeGreaterThanOrEqual(24 + 8 + 8);
  });
});

describe("SpacesList (the generated session title)", () => {
  /** Seed ONE archived session with a generated title and NO transcript —
   * the title is then the row's only label source (the message derivation
   * has nothing to fall back to but the space name). */
  function seedArchivedTitled(title: string): void {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [
        makeSessionRow({ sessionId: "a1", cwd: "/tmp/alpha", archived: true, title }),
      ],
      messages: {},
    });
  }

  it("labels a titled STORED row by its title, and an untitled row by its first message", () => {
    // `h1` gets a generated title; `s1` carries the backend's pre-naming
    // `title: null`, which must keep the OLD message-derived label.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha", title: null }),
      ],
      historySessions: [
        makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha", title: "Rewriting the parser" }),
        makeSessionRow({ sessionId: "h2", cwd: "/tmp/beta" }),
      ],
    });
    render(<SpacesList />);
    // The titled row shows the title INSTEAD of its first message.
    expect(screen.getByText("Rewriting the parser")).toBeTruthy();
    expect(screen.queryByText("Refactor the parser")).toBeNull();
    // …and the untitled row is labelled exactly as before.
    expect(screen.getByText("Fix the login bug")).toBeTruthy();
  });

  it("labels a titled LIVE row by its title (the row reads `sessions`, not only the stored lists)", () => {
    // The live case is the one the `session-titled` push feeds: the row's
    // `SessionInfo` is the entry in `sessions`, which the push rewrites.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha", title: "Porting the session namer" }),
      ],
    });
    render(<SpacesList />);
    expect(screen.getByText("Porting the session namer")).toBeTruthy();
    expect(screen.queryByText("Fix the login bug")).toBeNull();
  });

  it("shows the titled archived row as the bare title (the Space cue is gone — the section is Space-scoped)", () => {
    // The `· {spaceName}` suffix existed only because the section used to be a
    // cross-space flat list, where which Space a row belonged to was the one
    // thing the row could not omit. Scoped to the active Space, a row can never
    // belong to another Space, so the suffix is dead weight and the title span
    // holds the title ALONE.
    //
    // EXACT match (not the old `/^Archiving the log rotation/` prefix regex):
    // the prefix form existed only because the suffix was a SECOND nested span.
    // A prefix regex would let a re-added suffix throw on a multi-node match
    // instead of failing the assertion below.
    seedArchivedTitled("Archiving the log rotation");
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    const title = screen.getByText("Archiving the log rotation");
    expect(title.textContent).toBe("Archiving the log rotation");
    expect(title.textContent).not.toContain("·");
  });

  it("names the delete-confirmation dialog by the generated title", () => {
    // The dialog's title is the SAME derivation as the row's, so the user
    // confirms the row they just clicked.
    seedArchivedTitled("Rotating the archived logs");
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Rotating the archived logs" }),
    );
    // Scoped to the dialog: the ROW renders the same title text, and
    // `getByText` would otherwise match both and throw on ambiguity.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete session?")).toBeTruthy();
    expect(within(dialog).getByText("Rotating the archived logs")).toBeTruthy();
  });
});

/**
 * T06 — the sidebar's rows are DRAGGABLE (ADR 0075, spec §Drag mechanics).
 *
 * `useDragReorder` (T05) owns the gesture and the store's `reorderSessions`
 * (T05) owns the write; what THIS block pins is the WIRING between them and the
 * rows: the hook's six spread keys reaching the row element through
 * `RowButton`'s `...rest`, the pointer's half deciding above-or-below in the
 * RENDERED list, the drop edge drawn on the target row and nowhere else, and the
 * hover actions refusing to start a drag.
 *
 * TWO jsdom FACTS every drag here is built on, both inherited verbatim from
 * `useDragReorder.test.tsx` — reach for the obvious idiom instead and these
 * tests pass VACUOUSLY:
 *  1. `fireEvent.dragOver(el, { clientY })` does NOT deliver `clientY` (a plain
 *     `Event` swallows the unknown init member and it arrives `undefined`), so
 *     `dragOver` below hand-builds the event and assigns the property.
 *  2. `getBoundingClientRect()` is all zeros in jsdom, so the midpoint is `0`
 *     and EVERY pointer answers "after" — hence `layOut`, which makes the half a
 *     fact the test chooses rather than one the environment decides.
 *  3. AND THE RECT MUST BE NON-DEGENERATE ON THE AXIS THIS LIST IS NOT ON. The
 *     tab strip shipped as a silent no-op with every drag test in this repo green,
 *     because nothing here or in `SpaceTabs.test.tsx` ever delivered a `clientX`:
 *     an omitted one compares `undefined < midpoint` → `false` → "after", the same
 *     answer a zero-width rect gives. So `layOut` now gives every row a real x
 *     range AS WELL as a real y range, and `dragOver` demands both coordinates —
 *     with the X always answering the OPPOSITE edge from the Y, so a hook on the
 *     wrong axis reddens this block rather than agreeing by accident. The sidebar
 *     itself is unchanged (default `axis: "y"`); see
 *     "the SIDEBAR stays on the Y axis" below, which is the version of the axis
 *     test this file can construct — `SpacesList` renders no tab strip, so the
 *     horizontal-strip case lives in `SpaceTabs.test.tsx`.
 */
describe("SpacesList (dragging the session rows, ADR 0075)", () => {
  const ROW_TITLES = ["Row 1", "Row 2", "Row 3", "Row 4", "Row 5"];
  const ROW_IDS = ["r1", "r2", "r3", "r4", "r5"];

  /** Five STORED rows in the active Space, in the Manual order `r1…r5`. All
   *  five carry a generated `title` so the label never depends on a transcript
   *  (`messages: {}` — a leftover seed row would silently join the list and
   *  could satisfy an order assertion by accident). */
  function seedFiveRows(): void {
    useSessions.setState({
      sessions: [],
      historySessions: ROW_IDS.map((id, i) =>
        makeSessionRow({ sessionId: id, cwd: "/tmp/alpha", title: `Row ${i + 1}` }),
      ),
      archivedSessions: [],
      messages: {},
      inTurn: {},
      activeSessionId: null,
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { r1: 0, r2: 1, r3: 2, r4: 3, r5: 4 },
    });
  }

  /** jsdom has no layout: override the rect so the pointer's half is chosen
   *  here. (Same helper, same reason, as `useDragReorder.test.tsx`'s `layOut`.)
   *
   *  BOTH AXES NON-DEGENERATE, and that is the fixture fix this block needed: a
   *  row spans x 0..200 AND y `top`..`top`+40, so its two midpoints (100 and
   *  `top`+20) are different numbers. The pointers below always state BOTH, and
   *  the X always answers the OPPOSITE edge from the Y — so a hook reading the
   *  wrong axis reddens this block instead of agreeing by accident. (The tab
   *  strip shipped broken with every test green because nothing here or there
   *  ever delivered a `clientX`: `undefined < 100` is `false`, i.e. "after", the
   *  same answer a zero-width rect gives.) */
  const layOut = (el: HTMLElement, top: number, height = 40) => {
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + height,
        height,
        width: 200,
        left: 0,
        right: 200,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  /** `fireEvent.dragOver(el, { clientY })` does NOT deliver `clientY` (measured
   *  `undefined`) — nor `clientX` — so both are assigned. The return value is
   *  `false` iff a handler called `preventDefault`, i.e. "this row accepted the
   *  drop".
   *
   *  BOTH COORDINATES ARE MANDATORY: every call below passes an x that answers
   *  the opposite edge from the y, which is what keeps this VERTICAL list honest
   *  about the axis it is on. See `layOut`. */
  const dragOver = (el: Element, clientY: number, clientX: number) => {
    const ev = new Event("dragover", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.assign(ev, { clientY, clientX });
    return fireEvent(el, ev);
  };

  const buildDrop = () =>
    new Event("drop", { bubbles: true, cancelable: true, composed: true });

  /** A row's `role="button"` element, by its title. */
  const rowEl = (title: string): HTMLElement =>
    screen.getByText(title).closest('[role="button"]') as HTMLElement;

  /** The five rows' RENDER order, derived from the DOM rather than from the
   *  store — the whole point is to assert what the user is shown. `before`
   *  counts how many siblings precede a row, so the sort is a real positional
   *  read rather than a comparator that happens to be consistent. */
  const renderedOrder = (): string[] => {
    const nodes = ROW_TITLES.map((t) => screen.getByText(t));
    return nodes
      .map((node, i) => ({
        id: ROW_IDS[i]!,
        before: nodes.filter(
          (other) =>
            other !== node &&
            (other.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0,
        ).length,
      }))
      .sort((a, b) => a.before - b.before)
      .map((x) => x.id);
  };

  /** Press-and-hold on `dragTitle`, hover `overTitle` at `clientY`, release.
   *  Returns the `drop` event so a test can read `defaultPrevented`.
   *  `clientX` is supplied by the caller (see the note on `dragOver`) and always
   *  contradicts `clientY`, so the array each test asserts can only come from the
   *  Y answer. */
  function drag(
    dragTitle: string,
    overTitle: string,
    clientY: number,
    clientX: number,
  ): Event {
    const from = rowEl(dragTitle);
    const to = rowEl(overTitle);
    layOut(from, 0);
    layOut(to, 100); // y 100..140 (midpoint 120), x 0..200 (midpoint 100)
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, clientY, clientX);
    const ev = buildDrop();
    fireEvent(to, ev);
    return ev;
  }

  beforeEach(() => {
    seedFiveRows();
    // The file's documented hygiene: `clearAllMocks` clears call records but
    // NEVER an armed implementation, so a `mockRejectedValueOnce` left
    // unconsumed by a failed assertion would be handed to the next test's drag.
    vi.mocked(reorderSessions)
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("every session row is draggable, and the ONLY rows that are are the session rows", () => {
    // THE WIRING PIN. `dragProps(id)` reaches the DOM through `RowButton`'s
    // `...rest` — the intended route, which is why `RowButton.tsx` needs no
    // change. TWO COMPETING ANSWERS: `draggable="true"` on all five rows (the
    // spread landed) vs the attribute absent (the prop was dropped at the call
    // site or by the row, and NO drag is possible in the app while every other
    // test in this block still passes, because they drive the handlers).
    render(<SpacesList />);
    for (const title of ROW_TITLES) {
      expect(rowEl(title).getAttribute("draggable")).toBe("true");
    }
    // And the drag prop is not sprayed over the pane: the Archived section
    // HEADER is a `RowButton` too, and it is not a row — it keeps following
    // recency (spec §Archived section), so nothing here may be dragged.
    expect(rowEl("Archived").hasAttribute("draggable")).toBe(false);
  });

  it("dragging row 5 onto row 2's TOP half reorders the rendered rows to 1,5,2,3,4", async () => {
    // Spec §5 test #13, in the DOM. TWO COMPETING ANSWERS: "before" means
    // DIRECTLY ABOVE the target → [r1,r5,r2,r3,r4]; an off-by-one reading
    // "before" as one slot earlier answers [r5,r1,r2,r3,r4], i.e. the row lands
    // above Row 1 while the indicator was promising Row 2. A display sort is a
    // THIRD answer, and the one this branch exists to delete.
    render(<SpacesList />);
    expect(renderedOrder()).toEqual(ROW_IDS);
    drag("Row 5", "Row 2", 110, 150); // 110 < midpoint 120 → top half (x 150 would say AFTER)
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
    // The write is the WHOLE visible slice, not the moved id (the Rust side
    // writes each index as the row's stored number, so a partial list is a
    // half-moved list). `waitFor` because the store LINKS its command behind the
    // previous reorder's promise, so the IPC call lands a microtask after the
    // optimistic write the DOM above already reflects.
    await waitFor(() => expect(reorderSessions).toHaveBeenCalledTimes(1));
    expect(reorderSessions).toHaveBeenCalledWith(["r1", "r5", "r2", "r3", "r4"]);
  });

  it("dragging row 5 onto row 2's BOTTOM half reorders to 1,2,5,3,4 — the other answer", async () => {
    // The same gesture with the pointer 20px lower. Without BOTH halves
    // asserted, a call site that ignores `overEdge` (or a hook that always
    // inserts after) passes the top-half test by accident.
    render(<SpacesList />);
    drag("Row 5", "Row 2", 130, 50); // 130 > midpoint 120 → bottom half (x 50 would say BEFORE)
    expect(renderedOrder()).toEqual(["r1", "r2", "r5", "r3", "r4"]);
    await waitFor(() =>
      expect(reorderSessions).toHaveBeenCalledWith(["r1", "r2", "r5", "r3", "r4"]),
    );
  });

  it("the drop edge shows on the TARGET row only, on the edge the pointer is nearest", () => {
    // The indicator is a class on the real row (spec §Indicator) — this asserts
    // it lands on the row under the pointer and on NO other row. TWO COMPETING
    // ANSWERS at the call site: `dropEdge={overId === id ? overEdge : null}` (the
    // hook's edge, gated on the hook's target) vs `dropEdge={overEdge}` — which
    // paints the edge on EVERY row and would read as the whole list lifting.
    render(<SpacesList />);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 110, 150);
    expect(to.className).toContain("border-t-2");
    expect(to.className).not.toContain("border-b-2");
    for (const title of ["Row 1", "Row 3", "Row 4", "Row 5"]) {
      const el = rowEl(title);
      expect(el.className, title).not.toContain("border-t-2");
      expect(el.className, title).not.toContain("border-b-2");
    }
    // The pointer crossing to the bottom half flips the edge, and the top edge
    // goes away — an indicator that only ever paints one edge is the bug the
    // hook's `overEdge` exists to prevent.
    dragOver(to, 130, 50);
    expect(to.className).toContain("border-b-2");
    expect(to.className).not.toContain("border-t-2");
  });

  it("no edge is painted before the gesture and none after it ends", () => {
    // A lingering indicator reads as "drop here" on a list that is no longer
    // being dragged at, so the class must ride the gesture's lifetime exactly.
    // THE POSITIVE CONTROL is the middle assertion: without proving the edge
    // APPEARS mid-gesture, this whole test is a statement about a class that
    // nothing in the tree can ever paint — the "certifying the absence of the
    // mechanism" shape this branch has been bitten by twice.
    render(<SpacesList />);
    const edge = (el: HTMLElement) =>
      el.className.includes("border-t-2") || el.className.includes("border-b-2");
    for (const title of ROW_TITLES) expect(edge(rowEl(title))).toBe(false);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 130, 50);
    expect(edge(to)).toBe(true);
    // Release (which clears the gesture) — no edge survives it.
    fireEvent(to, buildDrop());
    for (const title of ROW_TITLES) expect(edge(rowEl(title))).toBe(false);
  });

  it("the SIDEBAR stays on the Y axis: a pointer whose X says the opposite edge still moves the row up", () => {
    // THE OTHER HALF OF THE AXIS BUG'S TEST-BLINDNESS, and the reason this block
    // had to change its fixtures. `SpacesList` renders no tab strip, so a
    // horizontal-strip drag cannot be constructed HERE (that one lives in
    // `SpaceTabs.test.tsx`); what this file can and must pin is the direction the
    // fix could have gone wrong: a hook that GUESSED the axis from the rect's
    // proportions would flip this list onto X, because a sidebar row is 200px wide
    // and 40px tall.
    // TWO COMPETING ANSWERS: [r1,r5,r2,r3,r4] — the pointer's Y (110, above the
    // row's midpoint 120) answers "before" and the sidebar behaves exactly as it
    // did before the `axis` option existed — vs [r1,r2,r5,r3,r4], which is what a
    // hook reading this pointer's X (150, right of the midpoint 100) would do, and
    // also what the old Y rule would answer if a future edit swapped the axes.
    // The row's edges are asserted as TOP/BOTTOM too: the sidebar's indicator must
    // not become the tab strip's left/right pair.
    render(<SpacesList />);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100); // y 100..140 (midpoint 120), x 0..200 (midpoint 100)
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 110, 150);
    expect(to.className).toContain("border-t-2");
    expect(to.className).not.toContain("border-l-2");
    expect(to.className).not.toContain("border-r-2");
    fireEvent(to, buildDrop());
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
  });

  it("dragging a row onto itself is a no-op: no reorder, no IPC, no indicator, no move", () => {
    // TWO COMPETING ANSWERS: a call site that lets a row target itself fires an
    // IPC with an unchanged slice (a pointless write that still bumps every
    // row's stored number) and paints an edge on the row the user is holding.
    // The hook refuses the target — and this pins that the refusal reaches the
    // RENDERED list, not just the hook's own state.
    render(<SpacesList />);
    const self = rowEl("Row 3");
    // THE POSITIVE CONTROL, and the reason it sits here rather than only in the
    // test above: with no drag mounted at all, every assertion below passes on
    // an inert row — `dragOver` returns `true` because NOTHING handled it. This
    // one line is what makes the rest of the test falsifiable.
    expect(self.getAttribute("draggable")).toBe("true");
    layOut(self, 100);
    fireEvent.dragStart(self, { dataTransfer: { setData: vi.fn() } });
    // `true` === nothing prevented === the browser's no-drop cursor, and the
    // window backstop is what swallows the release (spec hazard 2).
    expect(dragOver(self, 130, 50)).toBe(true);
    expect(self.className).not.toContain("border-b-2");
    fireEvent(self, buildDrop());
    expect(reorderSessions).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual(ROW_IDS);
  });

  it("a row's drop wins without stopping propagation, and a release outside any row is left to the backstop", async () => {
    // Spec hazard 2 at the CALL SITE. `useWindowDropBackstop` listens on
    // `window` and the row's handler fires first during bubbling, so the row
    // wins the drop on its own — but only if it does not take propagation away
    // on the way out, because the backstop is the one thing standing between a
    // stray drop and the webview NAVIGATING to it. (The backstop's own swallow
    // is pinned in `useDragReorder.test.tsx`, which mounts it alongside its
    // probe; `SpacesList.test.tsx` renders the pane alone, so what is provable
    // HERE is the row's half.)
    //
    // TWO COMPETING ANSWERS to "did the row claim the event?": a row that calls
    // `stopPropagation` reorders correctly AND leaves the backstop deaf (the
    // reorder tests stay green, the app navigates away on a stray drop); the
    // correct row prevents and propagates.
    render(<SpacesList />);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    // THE POSITIVE CONTROL: the row has to have CLAIMED the gesture for the
    // release below to mean anything. Without this line the assertions pass on a
    // list with no drag wiring at all — the vacuity this branch has been bitten
    // by four times. (`preventDefault` on `dragover` is what makes `dragOver`
    // return `false`.)
    expect(dragOver(to, 110, 150)).toBe(false);

    // Half one — released ON the row: prevented, reordered, and NOT stopped.
    const onRow = buildDrop();
    const stopped = vi.spyOn(onRow, "stopPropagation");
    fireEvent(to, onRow);
    expect(onRow.defaultPrevented).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(reorderSessions).toHaveBeenCalledTimes(1));

    // Half two — released OUTSIDE every row: the row never claims it, so the
    // event arrives at `window` un-prevented and un-stopped for the backstop to
    // swallow, and no list moves.
    vi.mocked(reorderSessions).mockClear();
    const stray = buildDrop();
    const strayStopped = vi.spyOn(stray, "stopPropagation");
    fireEvent(document.body, stray);
    expect(stray.defaultPrevented).toBe(false);
    expect(strayStopped).toHaveBeenCalledTimes(0);
    expect(reorderSessions).not.toHaveBeenCalled();
  });

  it("a drop on a row writes the store's order map, so the row HOLDS its slot through a re-derivation", () => {
    // The hazard T03 handed T05 and T06: `sessionOrder` is a BOOT SNAPSHOT, so a
    // drag that wrote only the derived array would snap back the moment the view
    // re-derived. Forcing a re-derivation is the only way to tell the two writes
    // apart — TWO COMPETING ANSWERS: writing the map (the row holds) vs writing
    // the array alone (the row returns to `r1…r5`).
    render(<SpacesList />);
    drag("Row 5", "Row 2", 110, 150);
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
    // Force a re-derivation: a NEW stored row in ANOTHER Space changes a `views`
    // dependency (so `spaceViewFor` re-runs for every Space and `sessionIds` is
    // rebuilt from the order map) while rendering no row here — the only way to
    // tell a map write from an array-only write apart.
    act(() => {
      useSessions.setState({
        historySessions: [
          ...useSessions.getState().historySessions,
          makeSessionRow({ sessionId: "beta-1", cwd: "/tmp/beta", title: "Other space" }),
        ],
      });
    });
    expect(screen.queryByText("Other space")).toBeNull();
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
    expect(useSessions.getState().sessionOrder.r5).toBe(1);
  });

  it("the hover actions carry draggable={false}, so a press on a destructive control starts no drag", () => {
    // Spec §Handle. The row is `draggable=true` and these buttons are its
    // CHILDREN, so an inherited/absent value makes a press on Delete begin a
    // drag of the row instead of acting. TWO COMPETING ANSWERS: `"false"` (the
    // opt-out landed) vs `null` (absent → the browser lets the parent drag).
    useSessions.setState({
      sessions: [makeSessionRow({ sessionId: "r1", cwd: "/tmp/alpha", title: "Row 1" })],
      historySessions: [
        makeSessionRow({ sessionId: "r2", cwd: "/tmp/alpha", title: "Row 2" }),
      ],
      sessionOrder: { r1: 0, r2: 1 },
    });
    render(<SpacesList />);
    const live = rowEl("Row 1");
    const stored = rowEl("Row 2");
    expect(live.getAttribute("draggable")).toBe("true");
    // Stop + Archive on the live row, Archive on the stored one.
    const actions = [
      within(live).getByRole("button", { name: "Stop Row 1" }),
      within(live).getByRole("button", { name: "Archive Row 1" }),
      within(stored).getByRole("button", { name: "Archive Row 2" }),
    ];
    for (const action of actions) {
      expect(action.getAttribute("draggable"), action.getAttribute("aria-label") ?? "").toBe(
        "false",
      );
    }
  });

  it("the Archived rows' Unarchive and Delete carry draggable={false} too", () => {
    // The spec names all FOUR hover actions. The archived rows are not
    // draggable themselves (that section keeps following recency), so a
    // `draggable={false}` here is not inherited from a draggable parent — it is
    // the same explicit opt-out, and the Delete confirm dialog is the one thing
    // in the sidebar that must never be reachable only by accident.
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [
        makeSessionRow({
          sessionId: "a1",
          cwd: "/tmp/alpha",
          archived: true,
          title: "Archived row",
        }),
      ],
      messages: {},
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    const row = rowEl("Archived row");
    // The row is NOT draggable (recency, not Manual order)…
    expect(row.hasAttribute("draggable")).toBe(false);
    // …and its two controls say so explicitly.
    for (const name of ["Unarchive Archived row", "Delete Archived row"]) {
      expect(within(row).getByRole("button", { name }).getAttribute("draggable")).toBe(
        "false",
      );
    }
  });

  it("the collapsed rail's marks stay POSITIONALLY equal to the rows after a drag", () => {
    // The rail's contract is "the Nth mark is the Nth row", and it now has to
    // survive a user-initiated reorder. The fixture gives the three rows three
    // DIFFERENT glyphs, so a mark sequence is a readable order. TWO COMPETING
    // ANSWERS after dragging `Row three` above `Row two`: the rail reads the
    // same array the rows do → [stored, running, waiting]; a rail that kept the
    // old live-then-stored construction (or a pre-drag snapshot) answers
    // [running, waiting, stored].
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha", title: "Row one" }),
        makeSessionRow({ sessionId: "s2", cwd: "/tmp/alpha", title: "Row two" }),
      ],
      historySessions: [
        makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha", title: "Row three" }),
      ],
      messages: {},
      inTurn: { s2: true },
      activeSessionId: "s2",
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { s2: 0, s1: 1, h1: 2 },
    });
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    render(<SpacesList />);
    // Rows two, one, three → drag the STORED row (three) above the running one.
    const from = rowEl("Row three");
    const to = rowEl("Row two");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 110, 150);
    fireEvent(to, buildDrop());
    const rows = screen.getByText("Row three");
    expect(
      rows.compareDocumentPosition(screen.getByText("Row two")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    // The rows stay MOUNTED while collapsed (clipped, not unmounted), so both
    // orders are readable from this one render — no re-render to re-derive them.
    const marks = [
      ...screen.getByTestId("session-rail-marks").querySelectorAll(
        "[data-testid='session-mark']",
      ),
    ];
    expect(marks.map((m) => m.getAttribute("data-dot") ?? "running")).toEqual([
      "stored",
      "running",
      "waiting",
    ]);
  });

  it("a dragged row's relative time keeps updating while its new slot holds", () => {

    // The user-visible promise of ADR 0075, tested AFTER a drag rather than on a
    // pristine list: the row's LABEL is its own per-row subscription and the
    // row's SLOT is the Manual order, and the two must stay independent in both
    // directions. TWO COMPETING ANSWERS: the label updates and the slot holds
    // (correct) vs the newly-active row floating back to the top (the deleted
    // display sort) or the label freezing (a slot-owned label).
    const now = Date.now();
    useSessions.setState({
      sessions: [],
      historySessions: [
        makeSessionRow({ sessionId: "r1", cwd: "/tmp/alpha", title: "Row 1" }),
        makeSessionRow({ sessionId: "r2", cwd: "/tmp/alpha", title: "Row 2" }),
      ],
      archivedSessions: [],
      messages: {
        r1: [makeMessage("user", { text: "first", at: now - 10_000 })],
        r2: [makeMessage("user", { text: "second", at: now - 3_600_000 })],
      },
      inTurn: {},
      activeSessionId: null,
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { r1: 0, r2: 1 },
    });
    render(<SpacesList />);
    expect(within(rowEl("Row 2")).getByText("1h")).toBeTruthy();
    // Drag `Row 2` ABOVE `Row 1` — it now holds slot 0.
    const from = rowEl("Row 2");
    const to = rowEl("Row 1");
    layOut(from, 100);
    layOut(to, 0);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 10, 150); // top half → before (x 150 would say AFTER)
    fireEvent(to, buildDrop());
    expect(
      screen.getByText("Row 2").compareDocumentPosition(screen.getByText("Row 1")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A future stamp → `now - at` is negative → the `< 60_000` bucket → "now":
    // a deterministic label change with no fake timers.
    act(() => {
      useSessions.setState({
        messages: {
          ...useSessions.getState().messages,
          r2: [makeMessage("user", { text: "second", at: Date.now() + 9_000_000_000 })],
        },
      });
    });
    expect(within(rowEl("Row 2")).getByText("now")).toBeTruthy();
    expect(
      screen.getByText("Row 2").compareDocumentPosition(screen.getByText("Row 1")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a sidebar row and a standalone SessionListRow wear the SAME drag surface", () => {
    // The row component is shared (the sidebar's rows and the Archived section
    // are one component, drawn twice), so the drag surface must be identical
    // wherever it is worn — a row that gains an extra attribute at ONE call site
    // is the drift the shared-component extraction exists to prevent, and
    // `RowButton`'s header pins attribute ORDER for the same reason.
    //
    // TWO COMPETING ANSWERS for "what does the drag contribute to the element?":
    // exactly the one attribute `draggable` (the hook's other five keys are
    // handlers, which emit nothing) vs a spread that also lands `data-*` /
    // `aria-*` / a second `class`. The set difference below is what catches the
    // second answer at either site.
    const { unmount } = render(<SpacesList />);
    const sidebarRow = rowEl("Row 2");
    const sidebarAttrs = [...sidebarRow.attributes]
      .map((a) => a.name)
      .sort()
      .join(",");
    // Unmount the PANE before rendering the standalone rows: RTL cleans up
    // between TESTS, not between two `render()` calls in one test, so a second
    // mount would leave a second sidebar in the tree and `rowEl` would throw on
    // a multiple match — the failure at least announces itself.
    unmount();

    // The same row, standalone, wearing a hook-shaped spread and one edge.
    const handlers = {
      draggable: true as const,
      onDragStart: () => {},
      onDragEnd: () => {},
      onDragOver: () => {},
      onDragLeave: () => {},
      onDrop: () => {},
    };
    render(
      <div>
        <SessionListRow title="plain" onOpen={() => {}} drag={handlers} />
        <SessionListRow
          title="target"
          onOpen={() => {}}
          drag={handlers}
          dropEdge="before"
        />
      </div>,
    );
    const plainRow = rowEl("plain");
    const targetRow = rowEl("target");
    // Same attribute NAMES as the sidebar's row (same base props: a stored row
    // carries no leading mark either, so the two shells are the same shape).
    expect([...plainRow.attributes].map((a) => a.name).sort().join(",")).toBe(
      sidebarAttrs,
    );
    // And the indicator contributes ONE class token pair to the row's own class,
    // in the same position relative to the base string, at both sites.
    const base = plainRow.className.split(/\s+/);
    const withEdge = targetRow.className.split(/\s+/);
    expect(withEdge.slice(0, base.length)).toEqual(base);
    expect(withEdge.slice(base.length)).toEqual(["border-t-2", "border-brand"]);
  });
});
