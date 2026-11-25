import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TaskDescription, type TaskDescriptionProps } from "./TaskDescription";

/**
 * `TaskDescription` is props-only: no store read, no IPC. The draft is owned by the
 * dialog, so this harness holds it the same way and wires the props through.
 *
 * A link renders through the real `AgentMarkdown` → `OpenAnchor`, whose click calls
 * `externalOpen` from the barrel. That reaches `invoke`, which rejects in jsdom and is
 * swallowed; the link-click case only asserts that the BODY's click handler stayed out
 * of the way, so no `lib/tauri` mock is needed.
 */

interface HarnessProps {
  body: string | null;
  initialDraft?: string | null;
  onSave?: (body: string | null) => Promise<void>;
  onStartEdit?: () => void;
  onCancel?: () => void;
  error?: string | null;
  /** Mirror the dialog's failure path: the draft survives a resolved save. */
  keepDraftOnSave?: boolean;
}

function Harness({
  body,
  initialDraft = null,
  onSave = vi.fn(async () => {}),
  onStartEdit,
  onCancel,
  error = null,
  keepDraftOnSave = false,
}: HarnessProps) {
  const [draft, setDraft] = useState<string | null>(initialDraft);
  const props: TaskDescriptionProps = {
    body,
    draft,
    onDraftChange: setDraft,
    onStartEdit: () => {
      onStartEdit?.();
      setDraft(body ?? "");
    },
    onCancel: () => {
      onCancel?.();
      setDraft(null);
    },
    onSave: async (next) => {
      await onSave(next);
      if (!keepDraftOnSave) setDraft(null);
    },
    error,
  };
  return <TaskDescription {...props} />;
}

function startEditing() {
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
}

describe("TaskDescription — resting", () => {
  it("shows the placeholder for a null body, and clicking it starts editing", () => {
    const onStartEdit = vi.fn();
    render(<Harness body={null} onStartEdit={onStartEdit} />);
    const placeholder = screen.getByTestId("task-body-empty");
    expect(placeholder.textContent).toBe("Add a description…");
    fireEvent.click(placeholder);
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it("treats an empty string body as no body — the same placeholder, no markdown region", () => {
    render(<Harness body="" />);
    expect(screen.getByTestId("task-body-empty").textContent).toBe(
      "Add a description…",
    );
    expect(screen.queryByTestId("task-body")).toBeNull();
  });

  it("renders a non-empty body as markdown inside task-body", () => {
    render(<Harness body="**bold** text" />);
    const body = screen.getByTestId("task-body");
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(screen.queryByTestId("task-body-empty")).toBeNull();
  });

  it("a click on the rendered body starts editing", () => {
    const onStartEdit = vi.fn();
    render(<Harness body="Some text" onStartEdit={onStartEdit} />);
    fireEvent.click(screen.getByTestId("task-body"));
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it("a click on a rendered link does NOT start editing, so the link stays a link", () => {
    const onStartEdit = vi.fn();
    render(<Harness body="[docs](https://x.test/a)" onStartEdit={onStartEdit} />);
    const anchor = screen.getByTestId("task-body").querySelector("a");
    expect(anchor).not.toBeNull();
    fireEvent.click(anchor!);
    expect(onStartEdit).not.toHaveBeenCalled();
  });

  it("the Edit button starts editing", () => {
    const onStartEdit = vi.fn();
    render(<Harness body="Text" onStartEdit={onStartEdit} />);
    startEditing();
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it("the Edit button is visible text, with no aria-label", () => {
    render(<Harness body="Text" />);
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-label")).toBeNull();
  });
});

describe("TaskDescription — editing", () => {
  it("shows a textarea holding the draft", () => {
    render(<Harness body="Original" />);
    startEditing();
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(area.value).toBe("Original");
    expect(area.tagName).toBe("TEXTAREA");
  });

  it("blurring the textarea neither closes the editor nor saves", () => {
    const onSave = vi.fn(async () => {});
    render(<Harness body="Original" onSave={onSave} />);
    startEditing();
    const area = screen.getByRole("textbox");
    fireEvent.change(area, { target: { value: "Changed" } });
    fireEvent.blur(area);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("Save calls onSave with the typed draft", async () => {
    const onSave = vi.fn(async () => {});
    render(<Harness body="Original" onSave={onSave} />);
    startEditing();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("New body"));
  });

  it("clearing the textarea to an empty string saves null", async () => {
    const onSave = vi.fn(async () => {});
    render(<Harness body="Original" onSave={onSave} />);
    startEditing();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("a whitespace-only draft saves null", async () => {
    const onSave = vi.fn(async () => {});
    render(<Harness body="Original" onSave={onSave} />);
    startEditing();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("an unchanged draft with Save calls onCancel and never onSave", () => {
    const onSave = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(<Harness body="Original" onSave={onSave} onCancel={onCancel} />);
    startEditing();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Enter saves", async () => {
    const onSave = vi.fn(async () => {});
    render(<Harness body="Original" onSave={onSave} />);
    startEditing();
    const area = screen.getByRole("textbox");
    fireEvent.change(area, { target: { value: "By key" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("By key"));
  });

  it("Meta+Enter saves", async () => {
    const onSave = vi.fn(async () => {});
    render(<Harness body="Original" onSave={onSave} />);
    startEditing();
    const area = screen.getByRole("textbox");
    fireEvent.change(area, { target: { value: "By meta" } });
    fireEvent.keyDown(area, { key: "Enter", metaKey: true });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("By meta"));
  });

  it("a plain Enter does not save — it is a newline in a markdown body", () => {
    const onSave = vi.fn(async () => {});
    render(<Harness body="Original" onSave={onSave} />);
    startEditing();
    const area = screen.getByRole("textbox");
    fireEvent.change(area, { target: { value: "Two\nlines" } });
    fireEvent.keyDown(area, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Escape calls onCancel", () => {
    const onCancel = vi.fn();
    render(<Harness body="Original" onCancel={onCancel} />);
    startEditing();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the Cancel button calls onCancel", () => {
    const onCancel = vi.fn();
    render(<Harness body="Original" onCancel={onCancel} />);
    startEditing();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the Cmd/Ctrl+Enter and Esc hint", () => {
    render(<Harness body="Original" />);
    startEditing();
    expect(screen.getByText("Cmd/Ctrl+Enter to save · Esc to cancel")).toBeTruthy();
  });

  it("an error renders as an alert under the editor", () => {
    render(<Harness body="Original" error="Could not save." />);
    startEditing();
    expect(screen.getByRole("alert").textContent).toBe("Could not save.");
  });

  it("disables Save and Cancel while a save is in flight, and un-wedges after a kept-open failure", async () => {
    let settle: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(
      <Harness
        body="Original"
        onSave={onSave}
        error={null}
        keepDraftOnSave
      />,
    );
    startEditing();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Pending" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // A failure keeps the editor open (the dialog keeps the draft and sets an error),
    // and the buttons must come back rather than wedge.
    settle();
    await vi.waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  // REGRESSION (Greptile P2, "Description stays disabled after saving"). React 19
  // StrictMode runs an effect's cleanup and then its setup AGAIN on mount. The unmount
  // guard used to set `mounted.current = false` in cleanup and never set it back to
  // `true` on setup, so after the StrictMode double-invoke every later save skipped
  // `setSaving(false)` and the editor stayed disabled. These cases run under StrictMode
  // and pin the two outcomes the review named: a failed save and a successful save.
  it("StrictMode: a FAILED save re-enables Save and Cancel for the still-open editor", async () => {
    // The `onSave` contract is "never rejects": a failure resolves with the editor still
    // open, and the dialog sets `error`. That is the path that wedged, so model it exactly.
    // Failure is signalled by resolving with the draft kept (`keepDraftOnSave`) and an error.
    let settle: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(
      <React.StrictMode>
        <Harness body="Original" onSave={onSave} error={null} keepDraftOnSave />
      </React.StrictMode>,
    );
    startEditing();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    settle();
    await vi.waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("StrictMode: a SUCCESSFUL save resting the editor leaves Edit usable on the next edit", async () => {
    const onSave = vi.fn(async () => {});
    render(
      <React.StrictMode>
        <Harness body="Original" onSave={onSave} />
      </React.StrictMode>,
    );
    startEditing();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // The success closed the editor. Reopening must show ENABLED controls, not the
    // disabled pair a stuck `saving` flag would leave behind.
    await vi.waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    startEditing();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("textbox") as HTMLTextAreaElement).disabled,
    ).toBe(false);
  });
});
