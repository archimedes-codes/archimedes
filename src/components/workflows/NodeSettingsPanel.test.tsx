import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { NodeSettingsPanel } from "./NodeSettingsPanel";
import { useTasks } from "../../store/tasks";
import { resetStores } from "../../test/resetStores";
import { clearSkillCatalogCache } from "../../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../../hooks/useMentionCatalogs";
import {
  getAutoGuards,
  getBoard,
  getBoardStrict,
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSkills,
  listSpaceListing,
  setAutoGuards,
  setBoardStrict,
  setStageAuto,
  setStagePromptPrefix,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../../lib/tauri";

/**
 * The settings panel SHELL: which body mounts for which selection, what it renders
 * when it cannot resolve the selection, and the two things it must own and not own —
 * the store's error cell, and no state but a draft.
 *
 * ## WHY THIS FILE IS NOT A THIRD COPY OF THE FIELD TESTS
 *
 * The node body's fields are `NodeSettingsBody.test.tsx`, the per-Space subjects are
 * `WorkflowSettingsBody.test.tsx`, and the destination block is
 * `NodeDestinations.test.tsx`. This file pins only what is true of the SHELL: mode
 * selection, the unresolvable-slug arm, the Space-less mount, the accessible name, the
 * optional close control, the single error surface, and that the panel subscribes to the
 * same board slice the canvas paints (so a board write re-paints the panel rather than
 * leaving a stale form beside a live graph).
 *
 * ## THE BARREL MOCK, THE TWO RESETS AND THE CATALOG CACHES
 *
 * The reasons `NodeSettingsBody.test.tsx` states at length; the short form is that an
 * un-mocked wrapper reaches the real `invoke`, rejects in jsdom, and lands its sentence
 * in the store's `error` cell that the error-line case below reads.
 */
vi.mock("../../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    getBoardStrict: vi.fn(),
    setBoardStrict: vi.fn(),
    getAutoGuards: vi.fn(),
    setAutoGuards: vi.fn(),
    setStageAuto: vi.fn(),
    setStagePromptPrefix: vi.fn(),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    listMcpServersEffective: vi.fn().mockResolvedValue([]),
    listSpaceListing: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});

const SPACE = "/w/alpha";

const stage = (slug: string, over: Partial<StageDto> = {}): StageDto => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder: 0,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
  auto: false,
  promptPrefix: null,
  ...over,
});

const task = (id: string, number: number, stageSlug: string): TaskRow => ({
  id,
  spacePath: SPACE,
  number,
  title: `Card ${number}`,
  body: null,
  specPath: null,
  stageSlug,
  sortOrder: number - 1,
  createdAt: 1,
  updatedAt: 1,
});

const card = (id: string, number: number, stageSlug: string): TaskCardView => ({
  task: task(id, number, stageSlug),
  sessions: [],
  costUsd: null,
  artifactKeys: [],
  ready: false,
  readySessions: [],
});

const SEED: StageWithTasks[] = [
  { stage: stage("backlog", { sortOrder: 0, nextSlugs: ["doing"] }), tasks: [card("t1", 1, "backlog")] },
  { stage: stage("doing", { sortOrder: 1, onEnterSkill: "research" }), tasks: [] },
  { stage: stage("done", { sortOrder: 2 }), tasks: [] },
];

const panel = (): HTMLElement => screen.getByTestId("workflow-settings-panel");

function renderPanel(
  props: { spacePath?: string | null; stageSlug?: string | null; onClose?: () => void } = {},
  seed: StageWithTasks[] = SEED,
) {
  useTasks.setState({
    boardsBySpace: { [SPACE]: seed },
  });
  return render(
    <NodeSettingsPanel
      spacePath={props.spacePath === undefined ? SPACE : props.spacePath}
      stageSlug={props.stageSlug ?? null}
      onClose={props.onClose}
    />,
  );
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  for (const fn of [
    getBoard,
    getBoardStrict,
    setBoardStrict,
    getAutoGuards,
    setAutoGuards,
    setStageAuto,
    setStagePromptPrefix,
    listSkills,
  ]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(listSkills).mockResolvedValue([]);
  vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([]);
  vi.mocked(listMcpServersEffective).mockResolvedValue([]);
  vi.mocked(listSpaceListing).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(listCompletionEntries).mockResolvedValue({
    entries: [],
    truncated: false,
  });
  vi.mocked(getBoardStrict).mockResolvedValue(false);
  vi.mocked(setBoardStrict).mockResolvedValue(undefined);
  vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: null, ceilingUsd: null });
  vi.mocked(setAutoGuards).mockResolvedValue(undefined);
  vi.mocked(setStageAuto).mockImplementation(async (_space, slug, auto) => ({
    ...stage(slug),
    auto,
  }));
  vi.mocked(setStagePromptPrefix).mockImplementation(
    async (_space, slug, promptPrefix) => ({ ...stage(slug), promptPrefix }),
  );
});

describe("the panel picks its mode from the selection", () => {
  it("a selected node mounts the node body and not the per-Space subjects", () => {
    renderPanel({ stageSlug: "doing" });
    expect(within(panel()).getByTestId("stage-settings-doing")).toBeTruthy();
    expect(within(panel()).queryByTestId("workflow-settings-body")).toBeNull();
    // The per-Space reads must NOT fire in node mode either — a Strict read and a
    // guards read on every node click would be two IPC round trips for a form that
    // cannot show them.
    expect(getBoardStrict).toHaveBeenCalledTimes(0);
    expect(getAutoGuards).toHaveBeenCalledTimes(0);
  });

  it("nothing selected mounts the workflow body and not the node fields", async () => {
    renderPanel({ stageSlug: null });
    expect(within(panel()).getByTestId("workflow-settings-body")).toBeTruthy();
    expect(within(panel()).queryByTestId(/^stage-settings-/)).toBeNull();
    // And the per-Space subjects DO read: they are the whole content of this mode.
    await waitFor(() => expect(getBoardStrict).toHaveBeenCalledWith(SPACE));
    await waitFor(() => expect(getAutoGuards).toHaveBeenCalledWith(SPACE));
  });

  it("an absent stageSlug prop is workflow mode too (the prop is optional)", () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<NodeSettingsPanel spacePath={SPACE} />);
    expect(within(panel()).getByTestId("workflow-settings-body")).toBeTruthy();
  });

  it("names the mode it is in, because the two modes have different subjects", () => {
    const { unmount } = render(
      <NodeSettingsPanel spacePath={SPACE} stageSlug={null} />,
    );
    expect(
      screen.getByRole("complementary", { name: "Workflow settings" }),
    ).toBeTruthy();
    unmount();
    render(<NodeSettingsPanel spacePath={SPACE} stageSlug="doing" />);
    expect(
      screen.getByRole("complementary", { name: "Settings for doing" }),
    ).toBeTruthy();
  });

  it("the header names the selected column and shows its slug read-only", () => {
    renderPanel({ stageSlug: "doing" });
    expect(panel().textContent).toContain("Doing");
    expect(within(panel()).getByTestId("stage-slug-doing").textContent).toBe("doing");
  });

  it("re-paints when the board slice moves under it (one owner of the column set)", async () => {
    // The panel reads the SAME slice the canvas paints, so a write from anywhere —
    // another window's refresh, the board next door — re-paints this form. A panel with
    // its own copy of the columns would be a second owner and would show a stale label
    // beside a live node.
    renderPanel({ stageSlug: "doing" });
    useTasks.setState({
      boardsBySpace: {
        [SPACE]: SEED.map((c) =>
          c.stage.slug === "doing"
            ? { ...c, stage: { ...c.stage, label: "In flight" } }
            : c,
        ),
      },
    });
    await waitFor(() =>
      expect(
        (within(panel()).getByRole("textbox", {
          name: "Label for doing",
        }) as HTMLInputElement).value,
      ).toBe("In flight"),
    );
  });
});

describe("the panel's third arm: a selection the board cannot answer", () => {
  it("says which slug it could not resolve instead of falling back to workflow mode", () => {
    // The canvas reaches this for real: a column deleted in another window, or a ghost
    // node whose id names no column. Silently showing the Space's settings would be the
    // panel changing subject on a stale selection.
    renderPanel({ stageSlug: "ghost" });
    expect(
      within(panel()).getByTestId("selection-unresolved").textContent,
    ).toContain("ghost");
    expect(within(panel()).queryByTestId("workflow-settings-body")).toBeNull();
    expect(within(panel()).queryByTestId(/^stage-settings-/)).toBeNull();
  });

  it("offers no control that could write to the column it cannot see", () => {
    renderPanel({ stageSlug: "ghost" });
    expect(within(panel()).queryByRole("textbox")).toBeNull();
    expect(within(panel()).queryByRole("switch")).toBeNull();
    expect(within(panel()).queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("an unloaded board is the same arm and not an empty one", () => {
    // `boardsBySpace[path]` is `undefined` before the fetch lands. A panel that treated
    // that as "no such column" would be right by accident, but one that treated it as
    // "workflow mode" would be wrong — and the canvas's own header makes never-loaded ≠
    // empty the same point.
    render(<NodeSettingsPanel spacePath={SPACE} stageSlug="doing" />);
    expect(within(panel()).getByTestId("selection-unresolved")).toBeTruthy();
  });
});

describe("the panel's mounts and surfaces", () => {
  it("renders nothing without a Space (every write it can make has no target)", () => {
    render(<NodeSettingsPanel spacePath={null} stageSlug={null} />);
    expect(screen.queryByTestId("workflow-settings-panel")).toBeNull();
    expect(getBoardStrict).toHaveBeenCalledTimes(0);
  });

  it("renders the store's error cell once, and only when there is one", async () => {
    // The panel is the ONE error surface for its own subtree, and it is the store's
    // cell — the same one the canvas and the board render. A second surface would be
    // two answers to "what went wrong", and every refused write here reverts a field and
    // relies on this line to say why.
    renderPanel({ stageSlug: null });
    expect(within(panel()).queryByRole("alert")).toBeNull();
    useTasks.setState({ error: "stage doing is still a destination" });
    await waitFor(() =>
      expect(within(panel()).getByRole("alert").textContent).toContain(
        "stage doing is still a destination",
      ),
    );
    expect(within(panel()).getAllByRole("alert")).toHaveLength(1);
  });

  it("renders a Close control only when the caller can act on one", () => {
    const { unmount } = renderPanel({ stageSlug: "doing" });
    // Deselecting by clicking empty canvas is the primary route, so a close button that
    // did nothing would be a control whose click is inert.
    expect(
      within(panel()).queryByRole("button", { name: "Close settings" }),
    ).toBeNull();
    unmount();

    const onClose = vi.fn();
    renderPanel({ stageSlug: "doing", onClose });
    fireEvent.click(
      within(panel()).getByRole("button", { name: "Close settings" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's geometry and its own frame (className through cn)", () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(
      <NodeSettingsPanel
        spacePath={SPACE}
        stageSlug={null}
        className="w-96 border border-card-border"
      />,
    );
    const classes = panel().className;
    expect(classes).toContain("w-96");
    expect(classes).toContain("border-card-border");
    // The frame's own tokens survive a caller's override — `cn` merges, it does not
    // replace the element.
    expect(classes).toContain("rounded-xl");
    // `bg-inspector`, the right-hand pane's own token (ADR 0097's island parity with
    // `SidePane`). It was `bg-chat` while this component was a pane nested inside the
    // canvas island; as a sibling island it names what it IS.
    expect(classes).toContain("bg-inspector");
    expect(classes).not.toContain("bg-chat");
    // And the island gap is the component's own, not something a caller supplies.
    expect(classes).toContain("m-1");
  });

  it("insets its content off the island's edge, like every other pane", () => {
    // The FRAME was right and the CONTENT was flush. `SidePane` — the reference ADR 0097
    // points at — wraps its content in `p-3`; this panel shipped with `pb-1` on the header
    // and `pr-1` on the scroller, so the title, the Strict switch and the `Add column`
    // field all sat against the island's rounded corner. Pinned per-band because the
    // frame assertion above cannot see this: an island can be a perfect island and still
    // paint its children flush into its own corners.
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<NodeSettingsPanel spacePath={SPACE} stageSlug={null} />);

    const root = panel();
    const header = within(root).getByText("Workflow").closest("header")!;
    expect(header.className).toContain("px-3");
    // And off the TOP edge — the title was the flushpest thing of all, sitting level with
    // the island's own rounded corner.
    expect(header.className).toContain("pt-3");

    // The scroller carries the padding, so a row scrolled to the end still clears the
    // bottom corner rather than sliding under the rounded edge.
    const scroller = root.lastElementChild!;
    expect(scroller.className).toContain("p-3");
    expect(scroller.className).not.toContain("pr-1");

  });

  it("renders every field at the app's form scale (h-7), not the dialog's", () => {
    // The cramped look was not a spacing taste problem: every control here was sized for
    // the WIDE MODAL DIALOG these fields were transferred out of, and a 288px pane made
    // that geometry read as cramped. `ui/input` and `ui/select` both default to `h-7`, so
    // the invariant is that no field overrides its own height — an `h-6` on one text
    // field beside an `h-7` on the next is the exact shape that shipped and that nothing
    // objected to, because no test read these classes before.
    // SEED's `doing` carries a Skill, so the mount holds a label Input, a Skill Select
    // and an extra-prompt Input — three fields, two of them text.
    renderPanel({ stageSlug: "doing" });
    const root = panel();

    const fields = [...root.querySelectorAll("input"), ...root.querySelectorAll("[role=combobox]")];
    expect(fields.length).toBeGreaterThanOrEqual(3);
    for (const field of fields) {
      const cls = typeof field.className === "string" ? field.className : "";
      // REQUIRES the component default rather than forbidding an override, because the
      // default IS `h-7` and cva puts it in the class list — asserting "no h-N" would
      // reject a correct field. What this catches is a field carrying `h-6`/`h-5`, which
      // tailwind-merge resolves INSTEAD of the default, so the first match wins.
      const heights = cls.match(/(^|\s)h-\d\b/g) ?? [];
      expect(
        heights,
        `${field.getAttribute("aria-label") ?? field.tagName} has no form-scale height: ${cls}`,
      ).toEqual([" h-7"]);
    }
  });

  it("insets its error cell too — the one band outside the scroller", () => {
    // Separate case because the cell only EXISTS when `error` is non-null, and setting
    // it while another panel is mounted fires an unwrapped store update.
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED }, error: "set_stage_next failed" });
    render(<NodeSettingsPanel spacePath={SPACE} stageSlug={null} />);
    expect(within(panel()).getByRole("alert").className).toContain("px-3");
  });

  it("holds no state of its own but a draft, so a remount shows the stored row", () => {
    // The panel is a reader of the slice and a caller of the actions. Nothing survives
    // an unmount, which is what lets the canvas mount and unmount it on a selection
    // change without a "what did the last selection leave behind" question — and it is
    // the shell-level half of the rule `NodeSettingsBody.test.tsx` pins from the other
    // side (selecting another node discards the first node's draft).
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    const view = render(
      <NodeSettingsPanel spacePath={SPACE} stageSlug="doing" />,
    );
    fireEvent.change(
      within(panel()).getByRole("textbox", { name: "Label for doing" }),
      { target: { value: "Half typed" } },
    );
    view.unmount();
    render(<NodeSettingsPanel spacePath={SPACE} stageSlug="doing" />);
    expect(
      (within(panel()).getByRole("textbox", {
        name: "Label for doing",
      }) as HTMLInputElement).value,
    ).toBe("Doing");
  });
});
