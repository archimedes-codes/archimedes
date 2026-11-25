import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TaskDetailProperties, type TaskDetailPropertiesProps } from "./TaskDetailProperties";
import { absoluteTimeFromInstant, relativeTimeFromInstant } from "../../lib/sessionTime";
import { COPY_RESET_MS } from "../../hooks/useCopyButton";
import type { SessionStatus } from "../../hooks/useSessionStatus";
import type { StageWithTasks, TaskRow } from "../../lib/tauri";

/**
 * `TaskDetailProperties` is props-only. It imports the pure `moneyOf` and `cardMarkOf`
 * helpers but reads no store and calls no IPC, so there is no `vi.mock("../../lib/tauri")`.
 * The Stage `Select` is the real `ui/select`; jsdom's pointer and scroll stubs live in
 * `src/test/setup.tsx`.
 */

const SPACE = "/w/alpha";
const CREATED = 1_700_000_000_000;
const UPDATED = 1_700_000_600_000;

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "tsk_abc123",
    spacePath: SPACE,
    number: 3,
    title: "Wire up the modal",
    body: null,
    specPath: "/w/alpha/docs/spec.md",
    stageSlug: "backlog",
    sortOrder: 0,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  };
}

function column(slug: string, label = slug): StageWithTasks {
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
    tasks: [],
  };
}

const COLUMNS = [column("backlog", "Backlog"), column("doing", "In Progress")];

type Overrides = Partial<TaskDetailPropertiesProps>;

function renderProperties(overrides: Overrides = {}) {
  const props: TaskDetailPropertiesProps = {
    task: taskRow(),
    columns: COLUMNS,
    stageDisabled: false,
    status: null,
    ready: false,
    sessionCount: 0,
    costUsd: null,
    onMoveStage: vi.fn(async () => {}),
    onSaveSpecPath: vi.fn(async () => {}),
    onEditingChange: vi.fn(),
    moveError: null,
    moveNote: null,
    specError: null,
    ...overrides,
  };
  const view = render(
    <div>
      <TaskDetailProperties {...props} />
    </div>,
  );
  return { props, ...view };
}

/** The Properties root. */
function aside(): HTMLElement {
  return screen.getByTestId("task-properties");
}

/** The row for one property, by its `data-property` key. */
function row(key: string): HTMLElement | null {
  return aside().querySelector(`[data-property="${key}"]`);
}

/** The Stage trigger. */
function stageTrigger(): HTMLElement {
  return screen.getByRole("combobox", { name: "Stage" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskDetailProperties — Stage", () => {
  it("shows the column LABEL in the trigger, not the slug", () => {
    renderProperties({ task: taskRow({ stageSlug: "doing" }) });
    expect(stageTrigger().textContent).toContain("In Progress");
    expect(stageTrigger().textContent).not.toContain("doing");
  });

  it("shows the SLUG in the trigger when no column matches it", () => {
    renderProperties({ task: taskRow({ stageSlug: "archived-later" }) });
    expect(stageTrigger().textContent).toContain("archived-later");
  });

  it("shows the slug when the columns are undefined, and does not throw", () => {
    renderProperties({ columns: undefined, task: taskRow({ stageSlug: "backlog" }) });
    expect(stageTrigger().textContent).toContain("backlog");
  });

  it("choosing another column calls onMoveStage with its slug", async () => {
    const { props } = renderProperties();
    fireEvent.click(stageTrigger());
    const option = await screen.findByRole("option", { name: "In Progress" });
    fireEvent.click(option);
    await waitFor(() => expect(props.onMoveStage).toHaveBeenCalledWith("doing"));
    expect(props.onMoveStage).toHaveBeenCalledTimes(1);
  });

  it("choosing the CURRENT column does not call onMoveStage", async () => {
    const { props } = renderProperties();
    fireEvent.click(stageTrigger());
    const option = await screen.findByRole("option", { name: "Backlog" });
    fireEvent.click(option);
    // A tick lets any (wrong) async call land before we assert its absence.
    await new Promise((r) => setTimeout(r, 0));
    expect(props.onMoveStage).not.toHaveBeenCalled();
  });

  it("stageDisabled disables the trigger", () => {
    renderProperties({ stageDisabled: true });
    expect((stageTrigger() as HTMLButtonElement).disabled).toBe(true);
  });

  it("a moveError renders as an alert under the Stage control", () => {
    renderProperties({ moveError: "Strict workflow refused the move." });
    expect(screen.getByRole("alert").textContent).toBe(
      "Strict workflow refused the move.",
    );
  });

  it("a moveNote renders as a role=status line with its testid", () => {
    renderProperties({ moveNote: "No live session to compact." });
    const note = screen.getByTestId("move-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toBe("No live session to compact.");
  });
});

describe("TaskDetailProperties — Status (one mark, chosen by cardMarkOf)", () => {
  it("is omitted entirely when there is no mark", () => {
    renderProperties({ status: null, ready: false });
    expect(row("status")).toBeNull();
  });

  it("a waiting session shows the status mark and 'Waiting for you'", () => {
    renderProperties({ status: "waiting", ready: false });
    const r = row("status")!;
    expect(r.textContent).toContain("Waiting for you");
    expect(r.querySelector('[data-testid="property-status-mark"]')).not.toBeNull();
    expect(r.querySelector('[data-testid="property-ready-glyph"]')).toBeNull();
  });

  it("a running session shows the status mark and 'Running'", () => {
    renderProperties({ status: "running", ready: false });
    const r = row("status")!;
    expect(r.textContent).toContain("Running");
    expect(r.querySelector('[data-testid="property-status-mark"]')).not.toBeNull();
    expect(r.querySelector('[data-testid="property-ready-glyph"]')).toBeNull();
  });

  it("a ready claim with no live status shows the BellRing glyph in text-warning, and not text-success", () => {
    renderProperties({ status: null, ready: true });
    const r = row("status")!;
    expect(r.textContent).toContain("Ready");
    const glyph = r.querySelector('[data-testid="property-ready-glyph"]');
    expect(glyph).not.toBeNull();
    const cls = glyph!.getAttribute("class") ?? "";
    expect(cls).toContain("text-warning");
    expect(cls).not.toContain("text-success");
    expect(r.querySelector('[data-testid="property-status-mark"]')).toBeNull();
  });

  it("PRECEDENCE: running + ready shows ONLY Ready", () => {
    renderProperties({ status: "running", ready: true });
    const r = row("status")!;
    expect(r.textContent).toContain("Ready");
    expect(r.textContent).not.toContain("Running");
    expect(r.querySelector('[data-testid="property-status-mark"]')).toBeNull();
    expect(r.querySelector('[data-testid="property-ready-glyph"]')).not.toBeNull();
  });

  it("PRECEDENCE: waiting + ready shows ONLY Waiting for you", () => {
    renderProperties({ status: "waiting", ready: true });
    const r = row("status")!;
    expect(r.textContent).toContain("Waiting for you");
    expect(r.textContent).not.toContain("Ready");
    expect(r.querySelector('[data-testid="property-ready-glyph"]')).toBeNull();
  });

  it.each<SessionStatus>(["live", "stored"])(
    "a %s session with ready=false omits the Status row",
    (status) => {
      renderProperties({ status, ready: false });
      expect(row("status")).toBeNull();
    },
  );
});

describe("TaskDetailProperties — Activity", () => {
  it("prints the singular session count and the cost", () => {
    renderProperties({ sessionCount: 1, costUsd: 0.5 });
    expect(row("activity")!.textContent).toContain("1 session");
    expect(row("activity")!.textContent).toContain("$0.50");
  });

  it("prints the plural session count", () => {
    renderProperties({ sessionCount: 2, costUsd: null });
    expect(row("activity")!.textContent).toContain("2 sessions");
  });

  it("prints '0 sessions · $0.00' for a real zero cost", () => {
    renderProperties({ sessionCount: 0, costUsd: 0 });
    expect(row("activity")!.textContent).toContain("0 sessions");
    expect(row("activity")!.textContent).toContain("$0.00");
  });

  it("a null cost prints no dollar figure", () => {
    renderProperties({ sessionCount: 1, costUsd: null });
    expect(row("activity")!.textContent).not.toContain("$");
  });
});

describe("TaskDetailProperties — spec path", () => {
  it("shows the placeholder when the spec path is null", () => {
    renderProperties({ task: taskRow({ specPath: null }) });
    expect(screen.getByTestId("spec-path-value").textContent).toContain(
      "Add spec path…",
    );
  });

  it("shows the path when set", () => {
    renderProperties({ task: taskRow({ specPath: "/a/spec.md" }) });
    expect(screen.getByTestId("spec-path-value").textContent).toBe("/a/spec.md");
  });

  it("clicking the value opens an input holding the path and reports editing", () => {
    const { props } = renderProperties({ task: taskRow({ specPath: "/a/spec.md" }) });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("/a/spec.md");
    expect(props.onEditingChange).toHaveBeenLastCalledWith(true);
  });

  it("Enter saves the trimmed path and closes the editor", async () => {
    const { props } = renderProperties({ task: taskRow({ specPath: "/old.md" }) });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  /a/b  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(props.onSaveSpecPath).toHaveBeenCalledWith("/a/b"));
    await waitFor(() => expect(props.onEditingChange).toHaveBeenLastCalledWith(false));
  });

  it("clearing the input saves null", async () => {
    const { props } = renderProperties({ task: taskRow({ specPath: "/old.md" }) });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(props.onSaveSpecPath).toHaveBeenCalledWith(null));
  });

  it("an unchanged path closes without calling onSaveSpecPath", () => {
    const { props } = renderProperties({ task: taskRow({ specPath: "/same.md" }) });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(props.onSaveSpecPath).not.toHaveBeenCalled();
    expect(props.onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it("Escape cancels without saving", () => {
    const { props } = renderProperties({ task: taskRow({ specPath: "/a.md" }) });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "/discarded.md" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(props.onSaveSpecPath).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(props.onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it("a rejected save keeps the editor open with the draft", async () => {
    const onSaveSpecPath = vi.fn(async () => {
      throw new Error("bad path");
    });
    renderProperties({
      task: taskRow({ specPath: "/a.md" }),
      onSaveSpecPath,
    });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "/bad.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveSpecPath).toHaveBeenCalledWith("/bad.md"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByDisplayValue("/bad.md")).toBeTruthy();
  });

  it("specError renders as an alert", () => {
    renderProperties({ specError: "Could not save the path." });
    expect(screen.getByRole("alert").textContent).toBe("Could not save the path.");
  });

  // REGRESSION (Greptile P2, "Pending saves discard newer typing"), the SpecPathRow half.
  // The same race as the header: the spec input stayed editable while the save was in
  // flight. It must be disabled while pending and re-enable with the draft on rejection.
  it("disables the spec input while the save is pending, so newer typing cannot be discarded", async () => {
    let settle: () => void = () => {};
    const onSaveSpecPath = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    renderProperties({ task: taskRow({ specPath: "/old.md" }), onSaveSpecPath });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/new.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveSpecPath).toHaveBeenCalledWith("/new.md"));
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    settle();
  });

  it("re-enables the spec input with the draft intact when the pending save rejects", async () => {
    let reject: (err: Error) => void = () => {};
    const onSaveSpecPath = vi.fn(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
        }),
    );
    renderProperties({ task: taskRow({ specPath: "/old.md" }), onSaveSpecPath });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/bad.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveSpecPath).toHaveBeenCalledWith("/bad.md"));
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    reject(new Error("bad path"));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false),
    );
    expect(screen.getByDisplayValue("/bad.md")).toBeTruthy();
  });

  // REGRESSION (Greptile P2, "Failed saves lose keyboard focus"), the SpecPathRow half.
  // A rejected save must hand focus back to the still-open input, so Escape still cancels.
  //
  // jsdom does not drop focus when a focused input is disabled, but a browser does. The drop
  // is simulated by blurring the input inside `onSaveSpecPath`, which runs during commit
  // BEFORE the disabling render. The restore runs in a passive effect after the re-enable,
  // so the assertion waits for focus rather than reading it synchronously.
  it("a rejected spec save returns keyboard focus to the input, so Escape still cancels", async () => {
    let reject: (err: Error) => void = () => {};
    let inputRef: HTMLInputElement | null = null;
    const onSaveSpecPath = vi.fn(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
          inputRef?.blur();
        }),
    );
    renderProperties({ task: taskRow({ specPath: "/old.md" }), onSaveSpecPath });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    inputRef = input;
    fireEvent.change(input, { target: { value: "/bad.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveSpecPath).toHaveBeenCalledWith("/bad.md"));
    await waitFor(() => expect(input.disabled).toBe(true));
    expect(document.activeElement).not.toBe(input);
    await act(async () => {
      reject(new Error("bad path"));
    });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.disabled).toBe(false);
  });

  // REGRESSION (Greptile P2, "Failed saves interrupt another edit"), the SpecPathRow half.
  // A rejected save must not pull focus away from a control the user moved to while the save
  // was pending. The user tabs into another field; the rejection must leave focus there.
  it("a rejected spec save does NOT steal focus from another control the user moved to", async () => {
    let reject: (err: Error) => void = () => {};
    let inputRef: HTMLInputElement | null = null;
    const onSaveSpecPath = vi.fn(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
          inputRef?.blur();
        }),
    );
    renderProperties({ task: taskRow({ specPath: "/old.md" }), onSaveSpecPath });
    fireEvent.click(screen.getByTestId("spec-path-value"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    inputRef = input;
    fireEvent.change(input, { target: { value: "/bad.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveSpecPath).toHaveBeenCalledWith("/bad.md"));
    await waitFor(() => expect(input.disabled).toBe(true));
    // Another control the user moved to while the save is pending. Rendered as a plain button
    // so the test does not depend on the Stage select's own focus handling.
    const other = document.createElement("button");
    document.body.appendChild(other);
    act(() => {
      other.focus();
    });
    expect(document.activeElement).toBe(other);
    await act(async () => {
      reject(new Error("bad path"));
    });
    // The rejection's `act` has flushed the re-enable AND its passive restore effect, so the
    // guard has already run by here. No timer is needed: the focus is read deterministically.
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

describe("TaskDetailProperties — Updated, Created and the id", () => {
  it("Updated and Created print relative times with absolute tooltips", () => {
    renderProperties();
    const updated = row("updated")!.querySelector("span[title]")!;
    expect(updated.textContent).toBe(relativeTimeFromInstant(UPDATED));
    expect(updated.getAttribute("title")).toBe(absoluteTimeFromInstant(UPDATED));
    const created = row("created")!.querySelector("span[title]")!;
    expect(created.textContent).toBe(relativeTimeFromInstant(CREATED));
    expect(created.getAttribute("title")).toBe(absoluteTimeFromInstant(CREATED));
  });

  it("the id row shows the task id with the id as its tooltip", () => {
    renderProperties({ task: taskRow({ id: "tsk_abc123" }) });
    const id = screen.getByTestId("task-id-value");
    expect(id.textContent).toBe("tsk_abc123");
    expect(id.getAttribute("title")).toBe("tsk_abc123");
  });

  it("the Copy control writes the id to the clipboard and flips to Copied, then resets", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      renderProperties({ task: taskRow({ id: "tsk_copy" }) });
      const copy = screen.getByTitle("Copy task ID");
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(writeText).toHaveBeenCalledWith("tsk_copy");
      expect(copy.textContent).toContain("Copied");
      await act(async () => {
        vi.advanceTimersByTime(COPY_RESET_MS + 1);
      });
      expect(copy.textContent).not.toContain("Copied");
      expect(copy.textContent).toContain("Copy task ID");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("TaskDetailProperties — layout", () => {
  it("the root has no scroller and carries the md-width and md-border column tokens", () => {
    renderProperties();
    const root = aside();
    expect(root.className).not.toContain("overflow-");
    expect(root.className).toContain("md:w-64");
    expect(root.className).toContain("md:border-l");
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("break-words");
  });
});
