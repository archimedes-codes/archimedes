import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import TaskDetailDialog from "./TaskDetailDialog";
import { resetTaskLaunchInFlight } from "../store/taskLaunch";
import { useTasks } from "../store/tasks";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import {
  editTask,
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSkills,
  listSpaceListing,
  loadHistory,
  moveTask,
  type StageWithTasks,
  type TaskRow,
} from "../lib/tauri";

/**
 * The dialog's EDIT behaviour, end to end through the REAL store actions.
 *
 * This file mocks the barrel the documented way: it spreads `vi.importActual` and replaces
 * only the wrappers the dialog drives. The `useTasks` store is NOT mocked. `editTask` and
 * `moveTask` write the board slice and the boost note, and the harness re-derives the
 * dialog's `task` prop from that slice, the way `TasksBoard`'s `detailCard` does. So a visible
 * change in these tests is the store's doing and not a stub's.
 */
const SPACE = "/w/alpha";

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    moveTask: vi.fn(),
    editTask: vi.fn(),
    getArtifact: vi.fn(),
    externalOpen: vi.fn(),
    reorderTasks: vi.fn(),
    loadHistory: vi.fn(),
    listSkills: vi.fn(),
    listAgentDefinitionsForSpace: vi.fn(),
    listMcpServersEffective: vi.fn(),
    listSpaceListing: vi.fn(),
    listCompletionEntries: vi.fn(),
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    linkSession: vi.fn(),
    getTask: vi.fn(),
    createTask: vi.fn(),
  };
});

const TASK_ID = "tsk_1";

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK_ID,
    spacePath: SPACE,
    number: 3,
    title: "Wire up the modal",
    body: "A card should open a modal.",
    specPath: "/w/alpha/docs/spec.md",
    stageSlug: "backlog",
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
    ...overrides,
  };
}

function column(slug: string, label = slug, tasks: TaskRow[] = []): StageWithTasks {
  return {
    stage: {
      spacePath: SPACE,
      slug,
      label,
      sortOrder: 0,
      onEnter: "none",
      onEnterSkill: null,
      nextSlugs: null,
      auto: false,
      promptPrefix: null,
    },
    tasks: tasks.map((task) => ({
      task,
      sessions: [],
      costUsd: null,
      artifactKeys: [],
    })),
  };
}

function seedBoard(task: TaskRow, extraColumns: StageWithTasks[] = []) {
  const columns = [
    column("backlog", "Backlog", [task]),
    ...extraColumns,
  ];
  useTasks.setState({ boardsBySpace: { [SPACE]: columns } });
}

/**
 * The store-backed harness. It re-derives the dialog's props from the board slice on every
 * render, the same way `TasksBoard` re-derives `detailCard`, so an `editTask` or `moveTask`
 * that rewrites the slice reaches the dialog.
 */
function Harness({
  artifactKeys = [],
  spacePath = SPACE,
  onClose,
}: {
  artifactKeys?: string[];
  spacePath?: string | null;
  onClose: () => void;
}) {
  const card = useTasks((s) =>
    (s.boardsBySpace[SPACE] ?? [])
      .flatMap((c) => c.tasks)
      .find((t) => t.task.id === TASK_ID),
  );
  if (card === undefined) return null;
  return (
    <TaskDetailDialog
      task={card.task}
      sessions={card.sessions}
      costUsd={card.costUsd}
      artifactKeys={artifactKeys}
      spacePath={spacePath}
      ready={false}
      onClose={onClose}
      onOpenSession={vi.fn()}
      onLaunched={vi.fn()}
    />
  );
}

function renderHarness(args: { artifactKeys?: string[]; spacePath?: string | null } = {}) {
  const onClose = vi.fn();
  render(<Harness {...args} onClose={onClose} />);
  return { onClose };
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/** The resting title button, by its visible title hint. */
function titleButton(): HTMLElement {
  return screen.getByTitle("Click to edit title");
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  resetTaskLaunchInFlight();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  vi.clearAllMocks();
  vi.mocked(listSkills).mockResolvedValue([]);
  vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([]);
  vi.mocked(listMcpServersEffective).mockResolvedValue([]);
  vi.mocked(listSpaceListing).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(listCompletionEntries).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(loadHistory).mockResolvedValue({ rows: [], hasMore: false, todos: null });
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });

  vi.mocked(editTask).mockImplementation(async (id, title, body, specPath) =>
    taskRow({
      id,
      title: title ?? "Wire up the modal",
      body: body === undefined ? "A card should open a modal." : body,
      specPath: specPath === undefined ? "/w/alpha/docs/spec.md" : specPath,
    }),
  );
  seedBoard(taskRow());
});

describe("TaskDetailDialog — inline editing", () => {
  it("title: click, type, Enter calls editTask positionally and updates the heading", async () => {
    renderHarness();
    fireEvent.click(titleButton());
    const input = within(dialog()).getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(TASK_ID, "New title", undefined, undefined),
    );
    expect(vi.mocked(editTask).mock.calls[0]).toHaveLength(4);
    await waitFor(() =>
      expect(within(dialog()).getByTitle("Click to edit title").textContent).toBe(
        "New title",
      ),
    );
  });

  it("an unchanged title does not call editTask", () => {
    renderHarness();
    fireEvent.click(titleButton());
    fireEvent.keyDown(within(dialog()).getByRole("textbox"), { key: "Enter" });
    expect(editTask).not.toHaveBeenCalled();
  });

  it("a whitespace-only title does not clear the title and does not call editTask", () => {
    renderHarness();
    fireEvent.click(titleButton());
    const input = within(dialog()).getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(editTask).not.toHaveBeenCalled();
    expect(titleButton().textContent).toBe("Wire up the modal");
  });

  it("Escape in the title input cancels WITHOUT calling onClose; a following Escape closes", async () => {
    const { onClose } = renderHarness();
    fireEvent.click(titleButton());
    const input = within(dialog()).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(editTask).not.toHaveBeenCalled();
    // The editor is gone and the modal is still open: a second Escape, with no editor, closes.
    expect(within(dialog()).queryByRole("textbox")).toBeNull();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("a rejected editTask keeps the title input open and shows a role=alert", async () => {
    vi.mocked(editTask).mockRejectedValue(new Error("empty_title"));
    renderHarness();
    fireEvent.click(titleButton());
    const input = within(dialog()).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Doomed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(within(dialog()).getByRole("alert").textContent).toContain("empty_title"),
    );
    expect(within(dialog()).getByDisplayValue("Doomed")).toBeTruthy();
  });

  it("description: clicking the placeholder opens the editor and blur keeps it open", () => {
    seedBoard(taskRow({ body: null }));
    renderHarness();
    fireEvent.click(within(dialog()).getByTestId("task-body-empty"));
    const area = within(dialog()).getByRole("textbox");
    fireEvent.blur(area);
    expect(within(dialog()).getByRole("textbox")).toBeTruthy();
    expect(editTask).not.toHaveBeenCalled();
  });

  it("description: Save calls editTask with the body, and the body updates on the card", async () => {
    renderHarness();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
    const area = within(dialog()).getByRole("textbox");
    fireEvent.change(area, { target: { value: "Rewritten body" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(TASK_ID, undefined, "Rewritten body", undefined),
    );
    await waitFor(() =>
      expect(within(dialog()).getByTestId("task-body").textContent).toContain(
        "Rewritten body",
      ),
    );
  });

  it("description: emptying the text saves a null body (a clear)", async () => {
    renderHarness();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(dialog()).getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(TASK_ID, undefined, null, undefined),
    );
  });

  it("description: Escape cancels without calling onClose or editTask", () => {
    const { onClose } = renderHarness();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
    const area = within(dialog()).getByRole("textbox");
    fireEvent.change(area, { target: { value: "Scrapped" } });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(editTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog()).queryByRole("textbox")).toBeNull();
  });

  it("description: Ctrl+Enter saves", async () => {
    renderHarness();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
    const area = within(dialog()).getByRole("textbox");
    fireEvent.change(area, { target: { value: "By key" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(TASK_ID, undefined, "By key", undefined),
    );
  });

  it("the description draft SURVIVES a tab switch: type, go to an artifact tab, return to Overview", async () => {
    renderHarness({ artifactKeys: ["design"] });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Half-written draft" },
    });
    fireEvent.click(
      within(dialog()).getByTestId("detail-tabs").querySelector('[data-tab-key="design"]')!,
    );
    fireEvent.click(
      within(dialog()).getByTestId("detail-tabs").querySelector('[data-tab-key="overview"]')!,
    );
    expect(
      (within(dialog()).getByRole("textbox") as HTMLTextAreaElement).value,
    ).toBe("Half-written draft");
  });

  it("on an artifact tab with a pending draft, Escape CLOSES: the draft is not mounted there", () => {
    // `bodyEditorMounted` is false on an artifact tab, so an unsaved draft held in memory
    // must not block Escape from closing the modal.
    const { onClose } = renderHarness({ artifactKeys: ["design"] });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Held in memory" },
    });
    fireEvent.click(
      within(dialog()).getByTestId("detail-tabs").querySelector('[data-tab-key="design"]')!,
    );
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape with a blurred Description draft cancels it, then a second Escape closes", async () => {
    // THE MANDATORY CASE. The Description editor has no `onBlur`, so a click elsewhere leaves
    // its draft open with the textarea unfocused, and the Escape keydown never reaches the
    // textarea. The dialog's own `onEscapeKeyDown` must cancel it directly. A textarea-only
    // handler cannot satisfy this, which is why the guard lives on the dialog.
    const { onClose } = renderHarness();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
    const area = within(dialog()).getByRole("textbox");
    fireEvent.change(area, { target: { value: "Blurred draft" } });
    // Focus leaves the textarea. The draft is deliberately NOT cancelled by blur.
    fireEvent.blur(area);
    expect(within(dialog()).getByRole("textbox")).toBeTruthy();

    // The first Escape reaches the dialog, not the textarea.
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(within(dialog()).queryByRole("textbox")).toBeNull();
    // The resting Description is back: the original body, and no save happened.
    expect(within(dialog()).getByTestId("task-body").textContent).toContain(
      "A card should open a modal.",
    );
    expect(editTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // A second Escape, with no editor open, closes the modal exactly once.
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("spec path: clicking the value, typing and Enter calls editTask with the path", async () => {
    renderHarness();
    fireEvent.click(within(dialog()).getByTestId("spec-path-value"));
    const input = within(dialog()).getByRole("textbox");
    fireEvent.change(input, { target: { value: "/w/alpha/new.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(TASK_ID, undefined, undefined, "/w/alpha/new.md"),
    );
  });

  it("spec path: clearing the field saves null", async () => {
    renderHarness();
    fireEvent.click(within(dialog()).getByTestId("spec-path-value"));
    const input = within(dialog()).getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(TASK_ID, undefined, undefined, null),
    );
  });

  it("spec path: Escape cancels without calling onClose", () => {
    const { onClose } = renderHarness();
    fireEvent.click(within(dialog()).getByTestId("spec-path-value"));
    const input = within(dialog()).getByRole("textbox");
    fireEvent.change(input, { target: { value: "/discarded.md" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(editTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("TaskDetailDialog — Stage switching", () => {
  it("picking another Stage calls moveTask with the Space, the id and the slug, and the control re-derives", async () => {
    seedBoard(taskRow(), [column("doing", "In Progress")]);
    renderHarness();
    fireEvent.click(within(dialog()).getByRole("combobox", { name: "Stage" }));
    fireEvent.click(await screen.findByRole("option", { name: "In Progress" }));
    await waitFor(() => expect(moveTask).toHaveBeenCalledWith(SPACE, TASK_ID, "doing"));
    await waitFor(() =>
      expect(
        within(dialog()).getByRole("combobox", { name: "Stage" }).textContent,
      ).toContain("In Progress"),
    );
  });

  it("a refused move reverts the Stage to the original label and shows a role=alert sentence", async () => {
    // The store reverts the optimistic slice and writes `error`; `moveTask` then answers the
    // card's REAL column, which is not the one asked for. The dialog shows the store's sentence.
    seedBoard(taskRow(), [column("doing", "In Progress")]);
    vi.mocked(moveTask).mockRejectedValue(new Error("Strict workflow refused this move."));
    renderHarness();
    fireEvent.click(within(dialog()).getByRole("combobox", { name: "Stage" }));
    fireEvent.click(await screen.findByRole("option", { name: "In Progress" }));
    await waitFor(() =>
      expect(within(dialog()).getByRole("alert").textContent).toContain(
        "Strict workflow refused this move.",
      ),
    );
    expect(
      within(dialog()).getByRole("combobox", { name: "Stage" }).textContent,
    ).toContain("Backlog");
  });

  it("a boostNote renders as a role=status line in the Properties column", async () => {
    seedBoard(taskRow(), [column("doing", "In Progress")]);
    vi.mocked(moveTask).mockResolvedValue({ onEnter: "compact", boostNote: "No live session" });
    renderHarness();
    fireEvent.click(within(dialog()).getByRole("combobox", { name: "Stage" }));
    fireEvent.click(await screen.findByRole("option", { name: "In Progress" }));
    await waitFor(() =>
      expect(within(dialog()).getByTestId("move-note").textContent).toBe("No live session"),
    );
    expect(within(dialog()).getByTestId("move-note").getAttribute("role")).toBe("status");
  });

  it("with no Space the Stage control is disabled", () => {
    renderHarness({ spacePath: null });
    const combobox = within(dialog()).getByRole("combobox", { name: "Stage" });
    expect((combobox as HTMLButtonElement).disabled).toBe(true);
  });
});
