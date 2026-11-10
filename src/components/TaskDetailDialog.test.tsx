import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import TaskDetailDialog from "./TaskDetailDialog";
import { resetTaskLaunchInFlight } from "../store/taskLaunch";
import { useTasks } from "../store/tasks";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import {
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSkills,
  listSpaceListing,
  loadHistory,
  moveTask,
  sendPrompt,
  startTaskSession,
  type SessionInfo,
  type SkillInfo,
  type StageWithTasks,
  type TaskRow,
  type TaskSessionRow,
} from "../lib/tauri";

/**
 * `TaskDetailDialog` — the modal a card opens when it is clicked.
 *
 * THE CONTRACT: it shows the WHOLE card (the board's card is a two-line summary and
 * this is the thing it summarises), it lists the card's Sessions and lets each be
 * opened, and its two buttons launch a Session for the card — Discuss loads the
 * `discuss` skill, Research loads `research` AND moves the card to the Research
 * column. The button work itself is `store/taskLaunch`'s and is pinned there; what
 * THIS file owns is which mode each button means, what gets rendered, and that the
 * board is left when a Session opens.
 *
 * WHY THE BARREL IS MOCKED WITH THE WRAPPER NAMES: the factory spreads
 * `importActual`, so an un-mocked export resolves to the REAL wrapper, which calls
 * `invoke` and rejects in jsdom. AGENTS.md's boot-mock trap — and here it is the
 * catalog fetches that bite first, because the modal reads the skill catalog to
 * decide whether its buttons can work at all.
 */
const SPACE = "/w/alpha";

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    linkSession: vi.fn(),
    getTask: vi.fn(),
    editTask: vi.fn(),
    reorderTasks: vi.fn(),
    loadHistory: vi.fn(),
    listSkills: vi.fn(),
    listAgentDefinitionsForSpace: vi.fn(),
    listMcpServersEffective: vi.fn(),
    listSpaceListing: vi.fn(),
    listCompletionEntries: vi.fn(),
  };
});

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "tsk_1",
    spacePath: SPACE,
    number: 3,
    title: "Wire up the detail modal",
    body: "A card should open a modal with Discuss and Research.",
    specPath: "/w/alpha/docs/spec.md",
    stageSlug: "backlog",
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
    ...overrides,
  };
}

function link(sessionId: string, stageSlug: string | null = "backlog"): TaskSessionRow {
  return { taskId: "tsk_1", sessionId, stageSlug };
}

function skill(name: string): SkillInfo {
  return {
    name,
    description: `${name} skill`,
    path: `/s/${name}.md`,
    dir: "/s",
    scope: "user",
    body: `${name.toUpperCase()} BODY`,
    disableModelInvocation: false,
    shadowed: [],
  };
}

function column(slug: string, label = slug, tasks: TaskRow[] = []): StageWithTasks {
  return {
    stage: { spacePath: SPACE, slug, label, sortOrder: 0, onEnter: "none" },
    tasks: tasks.map((task) => ({ task, sessions: [], costUsd: null })),
  };
}

/** The board the cases launch against, with the card IN its column.
 *
 *  Not incidental: `useTasks.moveTask` refuses a drag whose card is not in the
 *  loaded board ("a stale gesture") and never reaches the command, so a fixture
 *  whose columns hold no cards would make every Research launch a silent no-op — and
 *  the orchestrator inherits that guard. The first draft of this file seeded empty
 *  columns and `moveTask` was never called, which read like an orchestrator bug. */
const BOARDS = [
  column("backlog", "Backlog", [taskRow()]),
  column("research", "Research"),
];

interface RenderArgs {
  task?: TaskRow;
  sessions?: TaskSessionRow[];
  costUsd?: number | null;
  spacePath?: string | null;
  /** Seeded into the STORE, which is where the modal reads the column label from —
   *  the same slice `store/taskLaunch` consults for the Research move. */
  boards?: readonly StageWithTasks[];
  onOpenSession?: (sessionId: string) => void;
  onLaunched?: () => void;
}

function renderDialog(args: RenderArgs = {}) {
  // The board goes into the STORE and not into a prop. A modal that printed a label
  // from a prop while the orchestrator read the store would be two answers to one
  // question, so the fixture has to seed the same place production does.
  useTasks.setState({
    boardsBySpace: { [SPACE]: [...(args.boards ?? BOARDS)] },
  });
  const onOpenSession = args.onOpenSession ?? vi.fn();
  const onLaunched = args.onLaunched ?? vi.fn();
  const onClose = vi.fn();
  const view = render(
    <TaskDetailDialog
      task={args.task ?? taskRow()}
      sessions={args.sessions ?? []}
      costUsd={args.costUsd ?? null}
      spacePath={args.spacePath === undefined ? SPACE : args.spacePath}
      onClose={onClose}
      onOpenSession={onOpenSession}
      onLaunched={onLaunched}
    />,
  );
  return { onOpenSession, onLaunched, onClose, unmount: view.unmount };
}

/** The header's description sentence — where the stage, count and money live. */
function descriptionText(): string {
  return within(dialog()).getByText(/Stage/).textContent ?? "";
}

/** The modal's `DialogContent` element. */
function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  resetTaskLaunchInFlight();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  vi.clearAllMocks();
  vi.mocked(listSkills).mockResolvedValue([skill("discuss"), skill("research")]);
  vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([]);
  vi.mocked(listMcpServersEffective).mockResolvedValue([]);
  vi.mocked(listSpaceListing).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(listCompletionEntries).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(loadHistory).mockResolvedValue({ rows: [], hasMore: false, todos: null });
  vi.mocked(startTaskSession).mockResolvedValue({
    sessionId: "sess_new",
    cwd: SPACE,
    capabilities: {},
    archived: false,
  });
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
});

describe("TaskDetailDialog — what the card cannot show", () => {
  it("shows the number, the full title and the full body", () => {
    // The board's card clamps the title to two lines and the body to two more. The
    // modal exists to show what was clamped, so the BODY is not clamped here — an
    // earlier pass that reused the card's `line-clamp-2` would put the same clip in
    // the surface that removed it.
    renderDialog();
    expect(within(dialog()).getByText("T3")).toBeTruthy();
    expect(within(dialog()).getByText("Wire up the detail modal")).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "A card should open a modal with Discuss and Research.",
      ),
    ).toBeTruthy();
  });

  it("names the column the card is in by LABEL and not by slug", () => {
    // `stageSlug` is what the wire carries and what a person never says. The board
    // renders the LABEL in its header, and a modal that printed `backlog` while the
    // column above it said `Backlog` would be two answers to one question.
    renderDialog({
      boards: [column("backlog", "Backlog"), column("doing", "In Progress")],
      task: taskRow({ stageSlug: "doing" }),
    });
    expect(within(dialog()).getByText("In Progress")).toBeTruthy();
    expect(within(dialog()).queryByText("doing")).toBeNull();
  });

  it("falls back to the slug when the board has no column by that name", () => {
    // The board slice can be stale (a column deleted in another window). Printing
    // NOTHING would read as "this card has no column", which is a different claim
    // from "we could not name it" — the slug is the honest fallback.
    renderDialog({ task: taskRow({ stageSlug: "archived-later" }) });
    expect(within(dialog()).getByText("archived-later")).toBeTruthy();
  });

  it("shows the spec path when the card has one, and nothing when it has none", () => {
    // The card deliberately hides the path (an absolute path on every card is
    // noise); the detail surface is where it belongs.
    const { unmount } = renderDialog();
    expect(within(dialog()).getByText("/w/alpha/docs/spec.md")).toBeTruthy();
    unmount();
    renderDialog({ task: taskRow({ specPath: null }) });
    expect(within(dialog()).queryByText("spec")).toBeNull();
  });

  it("prints the summed cost, and prints NOTHING for a cost never reported", () => {
    // ADR 0082, and the rule is `moneyOf`'s rather than re-spelled here: `null` is
    // "no linked Session ever reported a cost" and `0` is "a real zero". A `0` that
    // rendered nothing would hide money that exists; a `null` that rendered `$0.00`
    // would invent a figure nobody measured.
    const { unmount } = renderDialog({ costUsd: 2.5, sessions: [link("sess_a")] });
    expect(descriptionText()).toContain("$2.50");
    unmount();
    renderDialog({ costUsd: 0, sessions: [link("sess_a")] });
    expect(descriptionText()).toContain("$0.00");
    unmount();
    renderDialog({ costUsd: null });
    expect(descriptionText()).not.toContain("$");
  });
});

describe("TaskDetailDialog — the sessions list", () => {
  it("lists one row per linked session and opens the one clicked", () => {
    // The card carries only a COUNT (a chip saying "2 sessions" is the right amount
    // of information on a card). Listing them is what the card cannot do and what
    // this modal exists for.
    const { onOpenSession } = renderDialog({
      sessions: [link("sess_old"), link("sess_new")],
    });
    const rows = within(dialog()).getAllByTestId("task-session-row");
    expect(rows).toHaveLength(2);
    // Read the identity off the row BEFORE clicking it, then assert the callback got
    // THAT id. A test that only asserted "onOpenSession was called with sess_new"
    // would pass for a row wired to a different entry than the one it rendered.
    expect(rows[1]!.getAttribute("data-session-id")).toBe("sess_new");
    fireEvent.click(rows[1]!);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("sess_new");
  });

  it("renders no sessions section at all when the card has none", () => {
    // No placeholder: "0 sessions" is a fact the header already states, and an empty
    // section header over an empty list is the shape that makes a surface look
    // broken rather than young.
    renderDialog({ sessions: [] });
    expect(within(dialog()).queryAllByTestId("task-session-row")).toHaveLength(0);
    // No section HEADER for an empty list either — the header line above already
    // states the count, so a second "0 sessions" line under it is the placeholder
    // this case exists to refuse.
    expect(within(dialog()).queryByText(/Sessions on this task/)).toBeNull();
  });

  it("says which session a card's chip would open, and opens the NEWEST", () => {
    // The card's chip opens `sessions[sessions.length - 1]` because the query is
    // oldest-first. If the modal's list ORDER disagreed with the card's, the two
    // surfaces would disagree about "this card's session" — so the ORDER is pinned
    // here and not left to the caller having sorted correctly.
    const { onOpenSession } = renderDialog({
      sessions: [link("sess_old"), link("sess_new")],
    });
    const rows = within(dialog()).getAllByTestId("task-session-row");
    // Read the ORDER off the attribute each row carries, since the ids are session
    // ids and not text a query can name.
    expect(rows.map((r) => r.getAttribute("data-session-id"))).toEqual([
      "sess_old",
      "sess_new",
    ]);
    // The newest is LAST, and the modal opens whichever row was clicked — it does
    // not re-pick.
    fireEvent.click(rows[1]!);
    expect(onOpenSession).toHaveBeenCalledWith("sess_new");
  });
});

describe("TaskDetailDialog — the two buttons", () => {
  it("has exactly Discuss and Research and no third action", () => {
    // Backlog belongs to the CREATE modal only: this card already exists and already
    // lives in a column, so a third button that filed it into Backlog would be a
    // move wearing a create's clothes.
    renderDialog();
    expect(screen.getByRole("button", { name: "Discuss" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Research" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Backlog" })).toBeNull();
  });

  it("Discuss starts a session with the discuss skill and leaves no move", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    expect(moveTask).not.toHaveBeenCalled();
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain('<skill name="discuss"');
    expect(sent).toContain("<task ");
    expect(sent.indexOf("<skill")).toBeLessThan(sent.indexOf("<task "));
  });

  it("Research moves the card to the research column AND loads the research skill", async () => {
    // The transition is the difference between the two buttons, and it is the whole
    // of issue #177 §4: a research Session belongs under Research.
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Research" }));
    await waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "research");
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain('<skill name="research"');
  });

  it("leaves the board view once a session is open", async () => {
    // THE PROP THAT MAKES THE FEATURE VISIBLE. The launch selects the new Session in
    // the store, but the board view COVERS the chat — so without `onLaunched` the
    // click starts a real Session and the user sees nothing happen at all. That is
    // the same defect the card's sessions chip had, and it is pinned here rather
    // than left to be re-discovered.
    const { onLaunched } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
  });

  it("closes itself after launching", async () => {
    // The modal has no reason to survive its own action, and leaving it up over the
    // transcript it just opened is the same occlusion in a second layer.
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("does NOT close or leave the board when the launch fails", async () => {
    // A failed launch that closed the dialog would lose the card the user was
    // reading, and the error line it wanted to show would be gone with it.
    vi.mocked(startTaskSession).mockRejectedValue(
      new Error("no provider configured"),
    );
    const { onClose, onLaunched } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "no provider configured",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("disables both buttons while a launch is in flight", async () => {
    // A double click would otherwise be two launches; `store/taskLaunch` guards it,
    // but a button that visibly answers twice is a lie about the outcome.
    const slots: { resolve?: (v: SessionInfo) => void } = {};
    vi.mocked(startTaskSession).mockReturnValue(
      new Promise<SessionInfo>((resolve) => {
        slots.resolve = resolve;
      }),
    );
    renderDialog();
    const discuss = await screen.findByRole("button", { name: "Discuss" });
    fireEvent.click(discuss);
    // `.disabled` and not `aria-disabled`: this repo's vitest setup carries no
    // jest-dom, and `Button` renders a real `<button>`, so the property is the
    // thing that exists (the same idiom `TasksBoard.test.tsx` uses for New task).
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      (screen.getByRole("button", { name: "Research" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    slots.resolve?.({
      sessionId: "s",
      cwd: SPACE,
      capabilities: {},
      archived: false,
    });
  });

  it("shows the skipped-column note when the Space has no research column", async () => {
    // A WARNING and not a failure: the Session started, the card did not move. The
    // board is what tells us the column is missing, and this is the only surface that
    // can say so — `store/taskLaunch` returns the note and nothing else renders it.
    const { onLaunched, onClose } = renderDialog({
      boards: [column("backlog", "Backlog", [taskRow()]), column("doing", "Doing")],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Research" }));
    await waitFor(() =>
      expect(within(dialog()).getByRole("status").textContent).toContain("research"),
    );
    expect(moveTask).not.toHaveBeenCalled();
    // THE NOTE WINS OVER THE NAVIGATION. The Session did start, but the thing the
    // user clicked for — the card moving — did not, and a note about a CARD belongs
    // on the surface showing the card. Navigating away would bury the only sentence
    // that explains it.
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables each button whose skill the catalog does not have", async () => {
    // THE RACE THIS PREVENTS, found while wiring the board: the catalog is an async
    // fetch, so a button enabled from the first paint is clickable BEFORE the catalog
    // lands — and the first click then fails with "This Space has no `discuss` skill",
    // a sentence that is false two frames later. Gating each button on the skill it
    // actually needs removes the race instead of narrowing it, because the same
    // condition decides both the enabled state and the orchestrator's refusal.
    vi.mocked(listSkills).mockResolvedValue([skill("research")]);
    renderDialog();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Research" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("is disabled on the FIRST paint, before the catalog has landed", async () => {
    // The catalog starts EMPTY (`useCatalogRow`'s empty constant), so the first frame
    // cannot know whether either skill exists. A button enabled there is the race
    // above; a button disabled there costs the user one frame.
    vi.mocked(listSkills).mockReturnValue(new Promise(() => {})); // never resolves
    renderDialog();
    expect(
      (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("refuses both buttons when the Space has no such skill, and says which", async () => {
    // `expandMentions` leaves an unmatched token VERBATIM, so a missing skill would
    // otherwise send a literal `$discuss`. The modal surfaces the refusal rather
    // than starting a Session that quietly does nothing.
    vi.mocked(listSkills).mockResolvedValue([skill("other")]);
    renderDialog();
    // BOTH are disabled, so nothing can be clicked and no error line is needed — the
    // disabled state IS the message, and it appears without a click being wasted.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(
      (screen.getByRole("button", { name: "Research" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(startTaskSession).not.toHaveBeenCalled();
  });

  it("disables the buttons with no Space, rather than opening a session nowhere", async () => {
    // `startTaskSession(null, …)` is not a thing. The board already disables New Task
    // for the same reason, and the same reasoning reaches here.
    renderDialog({ spacePath: null });
    const discuss = await screen.findByRole("button", { name: "Discuss" });
    expect((discuss as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(discuss);
    await new Promise((r) => setTimeout(r, 0));
    expect(startTaskSession).not.toHaveBeenCalled();
  });
});

describe("TaskDetailDialog — closing", () => {
  it("closes on Escape via the dialog's own dismiss", async () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("names itself with the card's number, so two modals are never ambiguous", () => {
    // `T3` is what a person says out loud (ADR 0090: the number is the label, the
    // `tsk_` id is the key). A title of "Task" would make every modal identical.
    renderDialog({ task: taskRow({ number: 7 }) });
    expect(within(dialog()).getByRole("heading").textContent).toContain("T7");
  });
});
