import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TaskDetailHeader } from "./TaskDetailHeader";
import { Dialog, DialogContent } from "../ui/dialog";

/**
 * `TaskDetailHeader` is props-only: it makes no store read and no IPC call, so this
 * file has NO `vi.mock("../../lib/tauri")`. It needs a Radix `Dialog` only because its
 * title is a `DialogTitle` (which throws outside a dialog context).
 */

function renderHeader(
  overrides: Partial<{
    title: string;
    onSaveTitle: (title: string) => Promise<void>;
    onEditingChange: (editing: boolean) => void;
    error: string | null;
  }> = {},
) {
  const onSaveTitle = overrides.onSaveTitle ?? vi.fn(async () => {});
  const onEditingChange = overrides.onEditingChange ?? vi.fn();
  const view = render(
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <TaskDetailHeader
          number={3}
          title={overrides.title ?? "Wire up the modal"}
          onSaveTitle={onSaveTitle}
          onEditingChange={onEditingChange}
          error={overrides.error ?? null}
        />
      </DialogContent>
    </Dialog>,
  );
  return { onSaveTitle, onEditingChange, ...view };
}

/** The resting title button. */
function titleButton(): HTMLButtonElement {
  return screen.getByTitle("Click to edit title") as HTMLButtonElement;
}

/** Open the title editor and return its input. */
function openEditor(): HTMLInputElement {
  fireEvent.click(titleButton());
  return screen.getByRole("textbox") as HTMLInputElement;
}

describe("TaskDetailHeader", () => {
  it("shows the card number as its own text node, and the title", () => {
    renderHeader({ title: "Wire up the modal" });
    const heading = screen.getByRole("heading");
    expect(screen.getByText("T3").textContent).toBe("T3");
    expect(heading.textContent).toContain("T3");
    expect(titleButton().textContent).toBe("Wire up the modal");
  });

  it("opens an input holding the title when the title is clicked", () => {
    const { onEditingChange } = renderHeader({ title: "Old title" });
    const input = openEditor();
    expect(input.value).toBe("Old title");
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
  });

  it("Enter with a changed title saves the TRIMMED title once and closes the editor", async () => {
    const onSaveTitle = vi.fn(async () => {});
    const { onEditingChange } = renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onEditingChange).toHaveBeenLastCalledWith(false));
    expect(onSaveTitle).toHaveBeenCalledTimes(1);
    expect(onSaveTitle).toHaveBeenCalledWith("New title");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Enter with an UNCHANGED title closes without calling onSaveTitle", () => {
    const onSaveTitle = vi.fn(async () => {});
    const { onEditingChange } = renderHeader({ title: "Same", onSaveTitle });
    const input = openEditor();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSaveTitle).not.toHaveBeenCalled();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a whitespace-only title closes the editor, never calls onSaveTitle, and keeps the title", () => {
    const onSaveTitle = vi.fn(async () => {});
    const { onEditingChange } = renderHeader({ title: "Keep me", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "    " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSaveTitle).not.toHaveBeenCalled();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    expect(titleButton().textContent).toBe("Keep me");
  });

  it("blur commits a changed title, the same way Enter does", async () => {
    const onSaveTitle = vi.fn(async () => {});
    renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSaveTitle).toHaveBeenCalledWith("Blurred"));
    expect(onSaveTitle).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels: no save, the input is gone, and a following blur does not save either", () => {
    const onSaveTitle = vi.fn(async () => {});
    const { onEditingChange } = renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // The unmount of the input is what a blur would race against; the blur that
    // follows an Escape must find `cancelledRef` set and do nothing.
    fireEvent.blur(input);
    expect(onSaveTitle).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(titleButton().textContent).toBe("Old");
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it("Enter followed by blur saves exactly once", async () => {
    const onSaveTitle = vi.fn(async () => {});
    renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Once" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await waitFor(() => expect(onSaveTitle).toHaveBeenCalled());
    expect(onSaveTitle).toHaveBeenCalledTimes(1);
  });

  it("a rejected save keeps the editor open with the draft and shows the error", async () => {
    const onSaveTitle = vi.fn(async () => {
      throw new Error("empty_title");
    });
    const { onEditingChange, rerender } = renderHeader({
      title: "Old",
      onSaveTitle,
    });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Doomed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveTitle).toHaveBeenCalledWith("Doomed"));
    // The editor STAYS open: the draft is still in the input, and the editor was
    // never reported closed.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByDisplayValue("Doomed")).toBeTruthy();
    expect(onEditingChange).not.toHaveBeenLastCalledWith(false);
    // The caller shows the error; the header renders it under the title.
    rerender(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <TaskDetailHeader
            number={3}
            title="Old"
            onSaveTitle={onSaveTitle}
            onEditingChange={onEditingChange}
            error="Title cannot be empty."
          />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Title cannot be empty.");
  });

  it("Enter then blur does not double-call when the save is in flight", async () => {
    let resolve: () => void = () => {};
    const onSaveTitle = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Pending" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    resolve();
    await waitFor(() => expect(onSaveTitle).toHaveBeenCalled());
    expect(onSaveTitle).toHaveBeenCalledTimes(1);
  });

  it("reports editing=false when it unmounts while the editor is open", () => {
    const onEditingChange = vi.fn();
    const { unmount } = renderHeader({ onEditingChange });
    openEditor();
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  // REGRESSION (Greptile P2, "Pending saves discard newer typing"). The input stayed
  // editable while `onSaveTitle` was in flight, so typing after Enter was lost when the
  // old save resolved and closed the editor. The input must be DISABLED while the save is
  // pending, and re-enable with the draft intact when the save rejects.
  it("disables the input while the save is pending, so newer typing cannot be discarded", async () => {
    let settle: () => void = () => {};
    const onSaveTitle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Pending" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveTitle).toHaveBeenCalledWith("Pending"));
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    settle();
  });

  it("re-enables the input with the draft intact when the pending save rejects", async () => {
    let reject: (err: Error) => void = () => {};
    const onSaveTitle = vi.fn(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
        }),
    );
    renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Doomed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveTitle).toHaveBeenCalledWith("Doomed"));
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    reject(new Error("empty_title"));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false),
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Doomed");
  });

  // REGRESSION (Greptile P2, "Failed saves lose keyboard focus"). Disabling the input during
  // the save removes focus from it, and re-enabling it on a rejected save does NOT restore
  // focus. So the user had to click back in, and Escape then reached the dialog instead of
  // the editor. A failed save must hand focus back to the still-open input.
  it("a rejected save returns keyboard focus to the input, so Escape still cancels the editor", async () => {
    // jsdom does NOT drop focus when an input is disabled (verified: `activeElement` stays on
    // the input), but a browser DOES. So simulate the browser: while the save is pending,
    // move focus off the input, as disabling it does in a real browser. The fix must
    // restore focus after the failed save, or this assertion fails.
    let reject: (err: Error) => void = () => {};
    const onSaveTitle = vi.fn(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
        }),
    );
    renderHeader({ title: "Old", onSaveTitle });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Doomed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaveTitle).toHaveBeenCalledWith("Doomed"));
    // The browser drops focus when the input is disabled. jsdom does not (and `blur()` is a
    // no-op on a disabled element), so move focus to a neutral element explicitly: that is
    // the state a real browser leaves the user in. The fix must hand focus back.
    const neutral = document.createElement("button");
    document.body.appendChild(neutral);
    neutral.focus();
    expect(document.activeElement).toBe(neutral);
    reject(new Error("empty_title"));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false),
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    neutral.remove();
  });
});
