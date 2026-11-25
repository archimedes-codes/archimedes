import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { TaskArtifactTabPane } from "./TaskArtifactTabPane";
import { absoluteTimeFromInstant, relativeTimeFromInstant } from "../../lib/sessionTime";
import type { Artifact } from "../../lib/tauri";

/**
 * `TaskArtifactTabPane` is props-only: it renders the document it is handed and makes
 * no read of its own, so there is no `vi.mock("../../lib/tauri")` here.
 */

const UPDATED = 1_700_000_600_000;

function artifact(markdown: string): Artifact {
  return {
    taskId: "tsk_1",
    key: "design",
    markdown,
    createdAt: 1_700_000_000_000,
    updatedAt: UPDATED,
  };
}

describe("TaskArtifactTabPane", () => {
  it("shows the artifact key as its label", () => {
    render(
      <TaskArtifactTabPane
        artifactKey="design"
        artifact={null}
        artifactError={null}
      />,
    );
    expect(screen.getByTestId("artifact-key-label").textContent).toBe("design");
  });

  it("renders the document as markdown inside artifact-body", () => {
    render(
      <TaskArtifactTabPane
        artifactKey="design"
        artifact={artifact("# The plan\n\n- do it")}
        artifactError={null}
      />,
    );
    const body = screen.getByTestId("artifact-body");
    expect(body.querySelector("h1")?.textContent).toBe("The plan");
    expect(body.querySelectorAll("li")).toHaveLength(1);
  });

  it("shows 'updated <relative>' with the absolute instant as its tooltip", () => {
    render(
      <TaskArtifactTabPane
        artifactKey="design"
        artifact={artifact("# x")}
        artifactError={null}
      />,
    );
    const updated = screen.getByTestId("artifact-updated");
    expect(updated.textContent).toBe(
      `updated ${relativeTimeFromInstant(UPDATED)}`,
    );
    expect(updated.getAttribute("title")).toBe(absoluteTimeFromInstant(UPDATED));
  });

  it("a null artifact renders the key only: no document, no timestamp, no alert", () => {
    render(
      <TaskArtifactTabPane
        artifactKey="design"
        artifact={null}
        artifactError={null}
      />,
    );
    expect(screen.getByTestId("artifact-key-label").textContent).toBe("design");
    expect(screen.queryByTestId("artifact-body")).toBeNull();
    expect(screen.queryByTestId("artifact-updated")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an artifactError renders as an alert in this pane", () => {
    render(
      <TaskArtifactTabPane
        artifactKey="design"
        artifact={null}
        artifactError="ipc failed"
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("ipc failed");
  });

  it("has NO scroller of its own: nothing in the pane carries overflow-y-auto", () => {
    const { container } = render(
      <TaskArtifactTabPane
        artifactKey="design"
        artifact={artifact("# x")}
        artifactError={null}
      />,
    );
    expect(container.querySelector(".overflow-y-auto")).toBeNull();
    const root = screen.getByTestId("artifact-pane");
    expect(root.className).not.toContain("overflow-");
  });
});
