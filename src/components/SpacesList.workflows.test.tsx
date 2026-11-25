import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import SpacesList from "./SpacesList";
import { resetModuleFlags, resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearAgentCatalogCache } from "../hooks/useAgentCatalog";

/**
 * The **Workflows** door — the third VIEW door in the sidebar's command row.
 *
 * A NEW FILE rather than cases appended to `SpacesList.test.tsx`, for the reason
 * that file itself documents at its own top: `SpacesList.test.tsx` is BASELINED
 * at its exact code-line count in `scripts/file-size-baseline-test.txt` and the
 * size ratchet refuses a baselined file growing by even one code line. The door's
 * own behaviour cannot be expressed inside that budget, so it lives beside the
 * file it extends — the same route `SpacesList.agents.test.tsx` and the
 * `*.workflows.test.tsx` siblings take. The one thing that could not move is the
 * existing top-row ORDER assertion (a baselined file may be EDITED, only not
 * grown), and it was rewritten in place there.
 *
 * THE BARREL MOCK is here for the same reason it is in the sibling file: this pane
 * fetches the settings document and both catalogs on mount, the factory spreads
 * `importActual`, so an un-mocked export reaches the real `invoke`, which rejects
 * in jsdom — green-but-noisy, and the shape that hides a real failure.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  const { makeSettings } = await import("../test/fixtures/settings");
  return {
    ...actual,
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: { loadSession: false },
      archived: false,
    }),
    listSkills: vi.fn().mockResolvedValue([]),
    // The Agents modal's catalog + write path, mounted by the pane on mount.
    listAgentDefinitionReports: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    listTools: vi.fn().mockResolvedValue([]),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    reorderSessions: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    setSessionArchived: vi.fn().mockResolvedValue(true),
    setSpaceTrusted: vi.fn().mockResolvedValue(undefined),
    deleteSpace: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  // `useSessions` is module-global and this file seeds it, so a leak would decide
  // the next case's Space/Session selection (the documented flakiness source —
  // `src/test/resetStores.ts`'s header).
  resetStores();
  resetModuleFlags();
  clearSkillCatalogCache();
  clearAgentCatalogCache();
});

describe("the Workflows door", () => {
  it("sits in the top row, ABOVE the Tasks door", () => {
    // The owner's placement was "a new button above tasks in the sidebar", and
    // ABOVE is the assertion — not merely "present". jsdom has no layout, so
    // within one container document order IS visual order, and reading the row's
    // buttons in order is what `SpacesList.test.tsx`'s own top-row pin does.
    render(<SpacesList />);
    const row = screen.getByRole("button", { name: "Tasks" }).parentElement!;
    expect(
      [...row.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? ""),
    ).toEqual(["Workflows", "Tasks"]);
    // And the two are genuinely one box — a door appended to the command band
    // BELOW the list would satisfy "present" while being nowhere near Tasks.
    expect(
      row.contains(screen.getByRole("button", { name: "Workflows" })),
    ).toBe(true);
    // It is ABOVE, by document order, asserted as a position rather than inferred
    // from the array above (which would also pass if the two were the ONLY two in
    // the wrong order — `toEqual` catches that, but this names the fact).
    expect(
      screen
        .getByRole("button", { name: "Workflows" })
        .compareDocumentPosition(screen.getByRole("button", { name: "Tasks" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("carries aria-pressed only while the Workflows view is up", () => {
    // The same rule the Settings and Tasks doors carry: `aria-pressed` says
    // "this view is showing", so it is FALSE on the workspace and TRUE only on
    // its own view — and never on a peer's view.
    const { rerender } = render(<SpacesList currentView="workspace" />);
    const door = () => screen.getByRole("button", { name: "Workflows" });
    expect(door().getAttribute("aria-pressed")).toBe("false");
    expect(door().className).not.toContain("bg-selected");

    rerender(<SpacesList currentView="workflows" />);
    expect(door().getAttribute("aria-pressed")).toBe("true");
    expect(door().className).toContain("bg-selected");

    // A PEER's view leaves it unpressed — the pressed state is per-door, not
    // "some non-workspace view is up".
    rerender(<SpacesList currentView="board" />);
    expect(door().getAttribute("aria-pressed")).toBe("false");
    expect(door().className).not.toContain("bg-selected");

    rerender(<SpacesList currentView="settings" />);
    expect(door().getAttribute("aria-pressed")).toBe("false");
    expect(door().className).not.toContain("bg-selected");
  });

  it("clicking the pressed door returns to the workspace, and does not re-open itself", () => {
    // THE TOGGLE-OFF HALF. A door toggles off ONLY when it is itself pressed, so
    // the guard is on `currentView === "workflows"` and not on
    // `currentView === "workspace"`.
    const onOpenWorkflows = vi.fn();
    const onReturnToWorkspace = vi.fn();
    render(
      <SpacesList
        currentView="workflows"
        onOpenWorkflows={onOpenWorkflows}
        onReturnToWorkspace={onReturnToWorkspace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(onReturnToWorkspace).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflows).not.toHaveBeenCalled();
  });

  it("clicking the Workflows door from a PEER view opens Workflows, not the workspace", () => {
    // The other half of the same rule, and the half that makes the doors peers:
    // from the board, the Workflows door goes to Workflows. A
    // `currentView === "workflows" ? … : onReturnToWorkspace()` shape (the wrong
    // guard) would land the user back in the chat instead.
    const onOpenWorkflows = vi.fn();
    const onReturnToWorkspace = vi.fn();
    const { rerender } = render(
      <SpacesList
        currentView="board"
        onOpenWorkflows={onOpenWorkflows}
        onReturnToWorkspace={onReturnToWorkspace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(onOpenWorkflows).toHaveBeenCalledTimes(1);
    expect(onReturnToWorkspace).not.toHaveBeenCalled();

    // And from the workspace the SAME open half fires — the door is not a
    // workspace-only control.
    onOpenWorkflows.mockClear();
    rerender(
      <SpacesList
        currentView="workspace"
        onOpenWorkflows={onOpenWorkflows}
        onReturnToWorkspace={onReturnToWorkspace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(onOpenWorkflows).toHaveBeenCalledTimes(1);
    expect(onReturnToWorkspace).not.toHaveBeenCalled();
  });

  it("renders without an onOpenWorkflows prop and clicking it does not throw", () => {
    // The prop is OPTIONAL because the overwhelming majority of this pane's render
    // sites are bare `<SpacesList />`; a required prop would break every one of
    // them for a callback only `App` can answer. Absent means INERT, not a
    // `TypeError` on `undefined()`.
    render(<SpacesList />);
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Workflows" })),
    ).not.toThrow();
  });

  it("wears the same recipe as the Tasks door (a COMMAND row, not a section header)", () => {
    // The two rules the Tasks door's comment states, pinned for the new door: it
    // is a command button with the shared recipe and a `size-4` glyph, and it owns
    // no chevron, no count and no list. The class comparison is against the door
    // it joins, so a restyling of one and not the other reddens.
    render(<SpacesList />);
    const workflows = screen.getByRole("button", { name: "Workflows" });
    const tasks = screen.getByRole("button", { name: "Tasks" });
    expect(workflows.className).toBe(tasks.className);
    expect(workflows.querySelector("svg")?.getAttribute("class")).toContain("size-4");
    // A COMMAND row: no disclosure state, and nothing that reads as a group label.
    expect(workflows.getAttribute("aria-expanded")).toBeNull();
  });
});
