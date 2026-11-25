import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { NodeSettingsPanel } from "./NodeSettingsPanel";
import { useTasks } from "../../store/tasks";
import {
  canConnectStages,
  nextSlugsAfterConnect,
} from "../../lib/workflowEdgeWrite";
import { resetStores } from "../../test/resetStores";
import { clearSkillCatalogCache } from "../../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../../hooks/useMentionCatalogs";
import {
  createStage,
  deleteStage,
  getArtifact,
  getAutoGuards,
  getBoard,
  getBoardStrict,
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSkills,
  listSpaceListing,
  moveTask,
  renameStage,
  reorderStages,
  reorderTasks,
  setAutoGuards,
  setBoardStrict,
  setStageAuto,
  setStageNext,
  setStagePromptPrefix,
  setStageSkill,
  writeArtifact,
  type SkillInfo,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../../lib/tauri";

/* THE SOURCE READER for the import-level pin in `the node panel's destinations`. The
 * computed specifier and the `await import` shape are `slabFloatSeparation.test.ts`'s —
 * this repo has no `@types/node`, so a bare `import { readFileSync } from "node:fs"` does
 * not typecheck, and a `new URL(…, import.meta.url)` reader throws "The URL must be of
 * scheme file" under the jsdom environment this file runs in. Paths are therefore relative
 * to the repo root, which is vitest's cwd, exactly as that file spells them. */
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/**
 * The node mode of the workflow settings panel — the eight per-column fields a
 * selected node owns: label, Skill, extra prompt, "continue when finished" (the
 * `auto` flag), destinations, order, and delete.
 *
 * ## WHY IT MOUNTS THE PANEL AND NOT THE BODY
 *
 * a stage row's controls only mean anything inside the surface that reads
 * the board slice they write through, and the dialog this body replaced made the same
 * call for the same reason: mount the shell, assert the control. `NodeSettingsBody` takes
 * its own `StageDto` as a prop and reads the slice for the OTHER columns' labels, so
 * mounting the panel is also the only way to pin that the field shows the row the
 * store painted after a write rather than the row the click asked for.
 *
 * ## THE BARREL MOCK IS MOCKED WITH THE WRAPPER NAMES
 *
 * The factory spreads `vi.importActual`, so a name this file does not list resolves to
 * the REAL wrapper, which calls `invoke`, rejects in jsdom, and lands its sentence in
 * the store's `error` cell that this file's own error-line assertions read — the
 * asserting-on-a-rejection trap the dialog's suite documented at length. The panel
 * drives the STORE's actions and the store drives the wrappers, so the cases below
 * read BOTH: which arguments reached the wire, and what the slice looks like after.
 * The store's own behaviour (revert-on-rejection, the whole-slice rule) is pinned in
 * `src/store/tasks.test.ts` and `tasks.workflows.test.ts` and is NOT re-pinned here.
 *
 * ## TWO RESETS and the two catalog caches
 *
 * `resetStores()` cannot reach a module `let` and `useTasks` has one, so the store's
 * own `reset()` runs beside it. The catalog caches are MODULE-level: the first case to
 * mount freezes whatever `listSkills` answered then, so a later case that installs a
 * non-empty catalog would be asserting on a warm cache.
 *
 * ## SCOPE DISCIPLINE
 *
 * Radix `Select` portals its list to `document.body`, so an OPENED list is read off
 * `screen` and never `within(panel())`; the panel's own nodes are read through
 * `within(panel())`, because the canvas behind it renders the same `role="alert"`.
 */
vi.mock("../../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    createTask: vi.fn(),
    getTask: vi.fn(),
    editTask: vi.fn(),
    moveTask: vi.fn(),
    reorderTasks: vi.fn(),
    linkSession: vi.fn(),
    createStage: vi.fn(),
    renameStage: vi.fn(),
    setStageSkill: vi.fn(),
    setStageNext: vi.fn(),
    reorderStages: vi.fn(),
    deleteStage: vi.fn(),
    setBoardStrict: vi.fn(),
    getBoardStrict: vi.fn(),
    writeArtifact: vi.fn(),
    getArtifact: vi.fn(),
    setStageAuto: vi.fn(),
    setStagePromptPrefix: vi.fn(),
    getAutoGuards: vi.fn(),
    setAutoGuards: vi.fn(),
    startTaskSession: vi.fn().mockResolvedValue({
      sessionId: "snap1",
      cwd: "/w/alpha",
      capabilities: {},
      archived: false,
    }),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
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

/* `stage()` mirrors the wire type exactly — `onEnterSkill` / `nextSlugs` / `auto` /
 * `promptPrefix` are all REQUIRED (the Rust side always emits them), so they default
 * rather than becoming optional, and the defaults sit BEFORE the spread so a case can
 * override either. `null` nextSlugs is UNCONFIGURED; `nextSlugs: []` is the OTHER
 * answer (configured, leading nowhere — ADR 0099). */
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
});

/** The seeded board: cards on the FIRST two columns and none on the third, so the
 *  delete flow has both shapes on screen. `backlog` carries ONE destination so the
 *  fan-out cases can add a second rather than invent a board. */
const SEED: StageWithTasks[] = [
  {
    stage: stage("backlog", { sortOrder: 0, nextSlugs: ["doing"] }),
    tasks: [card("t1", 1, "backlog")],
  },
  {
    stage: stage("doing", {
      sortOrder: 1,
      onEnter: "compact",
      onEnterSkill: "research",
    }),
    tasks: [card("t2", 2, "doing")],
  },
  { stage: stage("done", { sortOrder: 2 }), tasks: [] },
];

const skill = (name: string): SkillInfo => ({
  name,
  description: `the ${name} skill`,
  path: `/w/alpha/.agents/skills/${name}/SKILL.md`,
  dir: `/w/alpha/.agents/skills/${name}`,
  scope: "space",
  body: `${name.toUpperCase()} BODY`,
  disableModelInvocation: false,
  shadowed: [],
});

function panel(): HTMLElement {
  return screen.getByTestId("workflow-settings-panel");
}

/** The panel's own error line, scoped to the panel (the canvas behind it renders the
 *  store's `error` cell too, and both are live at once in the real app). */
function errorLine(): HTMLElement | null {
  return within(panel()).queryByRole("alert");
}

const field = (name: string): HTMLElement =>
  within(panel()).getByRole("textbox", { name });
const button = (name: string): HTMLElement =>
  within(panel()).getByRole("button", { name });
const switchOf = (name: string): HTMLElement =>
  within(panel()).getByRole("switch", { name });
const combo = (name: string): HTMLElement =>
  within(panel()).getByRole("combobox", { name });

/** Open a Radix `Select` and click one item (PORTALLED list → `screen`). */
async function pick(trigger: HTMLElement, option: string): Promise<void> {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/* NO jest-dom in this repo's vitest setup, so the DOM facts are read off the nodes —
 * the dialog's suite spelled, and which the panel's other files spell the same way. */
const valueOf = (el: HTMLElement): string => (el as HTMLInputElement).value;
const disabledOf = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled === true ||
  el.getAttribute("aria-disabled") === "true";
const checkedOf = (el: HTMLElement): { checked: boolean; disabled: boolean } => ({
  checked: el.getAttribute("aria-checked") === "true",
  disabled: (el as HTMLButtonElement).disabled === true,
});

/** Seed the store the way the canvas would and mount the panel in NODE mode. */
function renderNode(
  slug: string,
  seed: StageWithTasks[] = SEED,
  spacePath: string | null = SPACE,
): void {
  useTasks.setState({ boardsBySpace: { [SPACE]: seed } });
  render(<NodeSettingsPanel spacePath={spacePath} stageSlug={slug} />);
}

const slice = (): StageWithTasks[] =>
  useTasks.getState().boardsBySpace[SPACE] ?? [];
const stageOf = (slug: string): StageDto | undefined =>
  slice().find((c) => c.stage.slug === slug)?.stage;

/** `SEED`'s column with its cards kept and its fields re-spelled. */
function column(
  slug: string,
  over: Partial<StageDto>,
  tasks: TaskCardView[] = SEED.find((c) => c.stage.slug === slug)!.tasks,
): StageWithTasks {
  const base = SEED.find((c) => c.stage.slug === slug)!;
  return { stage: { ...base.stage, ...over }, tasks };
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  for (const fn of [
    getBoard,
    createStage,
    renameStage,
    setStageSkill,
    setStageNext,
    reorderStages,
    deleteStage,
    setBoardStrict,
    getBoardStrict,
    writeArtifact,
    getArtifact,
    moveTask,
    reorderTasks,
    listSkills,
    setStageAuto,
    setStagePromptPrefix,
    getAutoGuards,
    setAutoGuards,
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
  vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: null, ceilingUsd: null });
  vi.mocked(setAutoGuards).mockResolvedValue(undefined);
  vi.mocked(setStageAuto).mockImplementation(async (_space, slug, auto) => ({
    ...stage(slug),
    auto,
  }));
  vi.mocked(setStagePromptPrefix).mockImplementation(
    async (_space, slug, promptPrefix) => ({ ...stage(slug), promptPrefix }),
  );
  vi.mocked(setBoardStrict).mockResolvedValue(undefined);
  /* The Stage verbs answer the STORED row and the store merges that row back over its
   * optimistic guess, so these defaults ECHO their arguments the way the Rust side
   * does. A fixed `stage("backlog")` would be merged onto whichever column a case
   * edited, and every "the field shows the stored value" assertion below would then be
   * reading a fake row rather than the write. */
  vi.mocked(renameStage).mockImplementation(async (_space, slug, label) => ({
    ...stage(slug),
    label,
  }));
  vi.mocked(setStageSkill).mockImplementation(async (_space, slug, skillName) => ({
    ...stage(slug),
    onEnterSkill: skillName ?? null,
  }));
  vi.mocked(setStageNext).mockImplementation(async (_space, slug, slugs) => ({
    ...stage(slug),
    nextSlugs: slugs,
  }));
  vi.mocked(reorderStages).mockResolvedValue(undefined);
  vi.mocked(deleteStage).mockResolvedValue(undefined);
  vi.mocked(createStage).mockImplementation(async (_space, label) => ({
    ...stage(label.toLowerCase()),
    label,
    sortOrder: 3,
  }));
});

describe("the node panel's label field — commit on blur/Enter, never per keystroke", () => {
  it("typing then committing calls renameStage with the Space, the slug and the new label", async () => {
    renderNode("doing");
    fireEvent.change(field("Label for doing"), { target: { value: "In flight" } });
    fireEvent.blur(field("Label for doing"));
    await waitFor(() =>
      expect(renameStage).toHaveBeenCalledWith(SPACE, "doing", "In flight"),
    );
    expect(stageOf("doing")?.label).toBe("In flight");
  });

  it("Enter commits the rename (a field you have to leave to apply is a field that lies)", async () => {
    renderNode("done");
    fireEvent.change(field("Label for done"), { target: { value: "Shipped" } });
    fireEvent.keyDown(field("Label for done"), { key: "Enter" });
    await waitFor(() =>
      expect(renameStage).toHaveBeenCalledWith(SPACE, "done", "Shipped"),
    );
  });

  it("one keystroke is NOT one rename_stage call (a write per character is a write storm)", async () => {
    renderNode("done");
    const input = field("Label for done");
    fireEvent.change(input, { target: { value: "S" } });
    fireEvent.change(input, { target: { value: "Sh" } });
    fireEvent.change(input, { target: { value: "Shi" } });
    expect(renameStage).toHaveBeenCalledTimes(0);
    fireEvent.blur(input);
    await waitFor(() => expect(renameStage).toHaveBeenCalledTimes(1));
  });

  it("leaving the label unchanged writes nothing", async () => {
    // THE GATE IS `committed === stage.label`, and this case used to be unable to reach it.
    // It typed `"Done"` into a field that already READ `"Done"`, and a controlled `Input`
    // whose draft is `null` renders the stored value — so React saw no change, fired no
    // `onChange`, left the draft `null`, and the commit returned on the FIRST clause
    // (`committed === null`). Deleting the `|| committed === stage.label` half kept 45/45
    // green, measured. THE DELETED STAGE DIALOG HAD THE IDENTICAL DEFECT in its copy of this
    // case, which is why nobody noticed the shape being carried across.
    //
    // So the draft must really exist: edit, then edit BACK, then blur. The draft is now
    // `"Done"` and the stored label is `"Done"`, the two clauses of the gate disagree about
    // what to do, and only the second one stops the write. `toHaveBeenCalledTimes(0)` now
    // reddens if either clause is deleted.
    renderNode("done");
    const input = field("Label for done");
    fireEvent.change(input, { target: { value: "DoneX" } });
    fireEvent.change(input, { target: { value: "Done" } });
    // The draft is live — the field is showing the typed text and not the stored one, so
    // this is a real edit-and-revert and not the no-op keystroke the old case pretended.
    expect(valueOf(input)).toBe("Done");
    fireEvent.blur(input);
    // The commit is gated on the value having CHANGED, not on the field having been
    // touched: a blur fires on every click elsewhere in the app.
    expect(renameStage).toHaveBeenCalledTimes(0);
    // And a REAL edit from the same field still writes, so the refusal above is a verdict
    // and not a field that has stopped committing altogether.
    fireEvent.change(input, { target: { value: "Shipped" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(renameStage).toHaveBeenCalledWith(SPACE, "done", "Shipped"),
    );
  });

  it("the slug is a read-only caption beside the editable label", () => {
    renderNode("doing");
    // `data-slot="input"` is how the `Input` primitive marks its own `<input>`; the
    // caption must NOT be one, and the slug is frozen after `createStage` derives it.
    expect(within(panel()).getByTestId("stage-slug-doing").textContent).toBe("doing");
    expect(
      within(panel())
        .getAllByRole("textbox")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Label for doing", "Extra prompt for doing"]);
  });

  it("the slug survives the rename, in the caption and in the store", async () => {
    renderNode("doing");
    fireEvent.change(field("Label for doing"), { target: { value: "In flight" } });
    fireEvent.blur(field("Label for doing"));
    await waitFor(() => expect(stageOf("doing")?.label).toBe("In flight"));
    expect(within(panel()).getByTestId("stage-slug-doing").textContent).toBe("doing");
    expect(slice().map((c) => c.stage.slug)).toEqual(["backlog", "doing", "done"]);
  });

  it("selecting another node discards the uncommitted draft (the field re-shows the stored label)", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    const view = render(
      <NodeSettingsPanel spacePath={SPACE} stageSlug="doing" />,
    );
    fireEvent.change(field("Label for doing"), { target: { value: "In flight" } });
    expect(valueOf(field("Label for doing"))).toBe("In flight");
    view.rerender(<NodeSettingsPanel spacePath={SPACE} stageSlug="backlog" />);
    fireEvent.change(field("Label for backlog"), { target: { value: "Icebox" } });
    view.rerender(<NodeSettingsPanel spacePath={SPACE} stageSlug="doing" />);
    // The draft is GONE: it lived with the body for that node. The rule comes from the
    // dialog this panel replaced, which pinned it when a filter moved a row away; the
    // panel's version of "the row went away" is a different node being selected.
    await waitFor(() => expect(valueOf(field("Label for doing"))).toBe("Doing"));
    expect(renameStage).not.toHaveBeenCalled();
  });

  it("a refused rename puts the stored label back in the field and says why", async () => {
    vi.mocked(renameStage).mockRejectedValue({
      kind: "not_found",
      message: "no such stage: doing",
    });
    renderNode("doing");
    fireEvent.change(field("Label for doing"), { target: { value: "In flight" } });
    fireEvent.blur(field("Label for doing"));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("no such stage: doing"),
    );
    await waitFor(() => expect(valueOf(field("Label for doing"))).toBe("Doing"));
  });
});

describe("the node panel's Skill Select", () => {
  it("shows the stored Skill, and offers `none` plus every Skill the catalog holds", async () => {
    vi.mocked(listSkills).mockResolvedValue([skill("research"), skill("discuss")]);
    // ONE node's controls are on screen at a time — the panel replaced a dialog that
    // listed every column — so the trigger's own value and the option list are read
    // from the column that HAS a Skill, and the empty column is what the case below
    // (`picking a Skill`) drives instead.
    renderNode("doing");
    await waitFor(() =>
      expect(combo("Skill for doing").textContent).toContain("research"),
    );
    fireEvent.click(combo("Skill for doing"));
    await screen.findByRole("option", { name: "none" });
    expect(screen.getByRole("option", { name: "research" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "discuss" })).toBeTruthy();
  });

  it("picking a Skill calls setStageSkill with its name", async () => {
    vi.mocked(listSkills).mockResolvedValue([skill("research")]);
    renderNode("backlog");
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    await pick(combo("Skill for backlog"), "research");
    await waitFor(() =>
      expect(setStageSkill).toHaveBeenCalledWith(SPACE, "backlog", "research"),
    );
    expect(stageOf("backlog")?.onEnterSkill).toBe("research");
  });

  it("picking `none` CLEARS the Skill (null, not the string \"none\")", async () => {
    vi.mocked(listSkills).mockResolvedValue([skill("research")]);
    renderNode("doing");
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    await pick(combo("Skill for doing"), "none");
    await waitFor(() =>
      expect(setStageSkill).toHaveBeenCalledWith(SPACE, "doing", null),
    );
    expect(stageOf("doing")?.onEnterSkill).toBeNull();
  });

  it("names a stored Skill the catalog no longer holds, instead of an empty trigger", async () => {
    // A renamed Skill directory would otherwise render an EMPTY trigger, which reads
    // as "nothing configured" — the `PermissionsSection` precedent for the same trap.
    vi.mocked(listSkills).mockResolvedValue([]);
    renderNode("doing", [
      column("backlog", { nextSlugs: null }),
      column("doing", { onEnterSkill: "vanished" }),
      SEED[2]!,
    ]);
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(combo("Skill for doing").textContent).toContain("vanished");
  });

  it("reads the catalog through the shared hook: a second consumer fetches nothing", async () => {
    // The spec's "not a second fetch", pinned as the cache dedupe it depends on.
    renderNode("doing");
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(1));
    vi.mocked(listSkills).mockClear();
    render(<NodeSettingsPanel spacePath={SPACE} stageSlug="backlog" />);
    await waitFor(() => expect(screen.getAllByTestId("workflow-settings-panel").length).toBe(2));
    // A direct `listSkills` call inside the panel instead of the shared hook would
    // land here as a second call.
    expect(listSkills).toHaveBeenCalledTimes(0);
  });
});

describe("the node panel's Continue-when-finished switch (the auto flag)", () => {
  it("shows the column's stored flag and is never inert (there is no unread state)", () => {
    renderNode("on", [
      { stage: stage("on", { slug: "on", auto: true }), tasks: [] },
      { stage: stage("off", { slug: "off", auto: false }), tasks: [] },
    ]);
    expect(checkedOf(switchOf("Continue when finished"))).toEqual({
      checked: true,
      disabled: false,
    });
  });

  it("clicking it writes the flag through the store", async () => {
    renderNode("doing");
    fireEvent.click(switchOf("Continue when finished"));
    await waitFor(() =>
      expect(setStageAuto).toHaveBeenCalledWith(SPACE, "doing", true),
    );
    await waitFor(() =>
      expect(checkedOf(switchOf("Continue when finished")).checked).toBe(true),
    );
  });

  it("goes back to OFF when the write is refused (the store reverted the slice)", async () => {
    vi.mocked(setStageAuto).mockRejectedValue({
      kind: "not_found",
      message: "no such stage: doing",
    });
    renderNode("doing");
    fireEvent.click(switchOf("Continue when finished"));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("no such stage: doing"),
    );
    expect(checkedOf(switchOf("Continue when finished")).checked).toBe(false);
  });

  it("is labelled in the owner's words, not the column's internal name", () => {
    renderNode("doing");
    // The field is `stages.auto`; the label the owner asked for is "Continue when
    // finished". A switch named `auto` on a panel that also has destinations is a
    // switch nobody can tell apart from "advance automatically" in general.
    expect(switchOf("Continue when finished")).toBeTruthy();
    expect(
      within(panel()).queryByRole("switch", {
        name: /Auto-advance cards launched in doing/,
      }),
    ).toBeNull();
  });
});

describe("the node panel's extra-prompt field", () => {
  it("shows the stored prefix, and the empty field for a column that has none", () => {
    renderNode("a", [{ stage: stage("a", { slug: "a", promptPrefix: "Continue the chain." }), tasks: [] }]);
    expect(valueOf(field("Extra prompt for a"))).toBe("Continue the chain.");
  });

  it("commits on Enter", async () => {
    renderNode("doing");
    const input = field("Extra prompt for doing");
    fireEvent.change(input, { target: { value: "Run the checks first." } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(setStagePromptPrefix).toHaveBeenCalledWith(
        SPACE,
        "doing",
        "Run the checks first.",
      ),
    );
  });

  it("commits on blur (a field you have to LEAVE to apply is a field that lies)", () => {
    renderNode("doing");
    const input = field("Extra prompt for doing");
    fireEvent.change(input, { target: { value: "Draft it from the spec." } });
    fireEvent.blur(input);
    expect(setStagePromptPrefix).toHaveBeenCalledWith(
      SPACE,
      "doing",
      "Draft it from the spec.",
    );
  });

  it("sends `null` when the field is cleared, NOT the empty string", async () => {
    // `""` is a stored VALUE a person typed and NULL is the only "no extra prompt"
    // state, so writing `""` would make a prefix typed by mistake un-clearable.
    renderNode("doing", [SEED[0]!, column("doing", { promptPrefix: "Stale instruction." }), SEED[2]!]);
    const input = field("Extra prompt for doing");
    expect(valueOf(input)).toBe("Stale instruction.");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(setStagePromptPrefix).toHaveBeenCalledWith(SPACE, "doing", null),
    );
    expect(stageOf("doing")?.promptPrefix).toBeNull();
  });

  it("writes nothing when the field was never touched (blur fires on every click away)", () => {
    renderNode("doing");
    fireEvent.blur(field("Extra prompt for doing"));
    expect(setStagePromptPrefix).toHaveBeenCalledTimes(0);
  });

  it("keeps a stored empty-string prefix distinguishable from a clear in the store", () => {
    // The field renders both as empty — they contribute the same text to a launch —
    // so what is pinned here is the half that is NOT a UI choice: the slice still
    // holds the distinction after a mount, and a `?? ""` in the paint would erase it.
    renderNode("empty", [
      { stage: stage("empty", { slug: "empty", promptPrefix: "" }), tasks: [] },
      { stage: stage("cleared", { slug: "cleared", promptPrefix: null }), tasks: [] },
    ]);
    expect(valueOf(field("Extra prompt for empty"))).toBe("");
    expect(stageOf("empty")?.promptPrefix).toBe("");
    expect(stageOf("cleared")?.promptPrefix).toBeNull();
  });

  it("stays silent when a stored empty prefix is blurred untouched", () => {
    renderNode("doing", [SEED[0]!, column("doing", { promptPrefix: "" }), SEED[2]!]);
    const input = field("Extra prompt for doing");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(setStagePromptPrefix).toHaveBeenCalledTimes(0);
  });

  it("commits an empty field over a stored `\"\"` as the `null` clear", async () => {
    renderNode("doing", [column("doing", { promptPrefix: "" })]);
    const input = field("Extra prompt for doing");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(setStagePromptPrefix).toHaveBeenCalledWith(SPACE, "doing", null),
    );
  });

  it("writes nothing when the text is unchanged from the stored prefix", async () => {
    // THE GATE IS `next === stage.promptPrefix`, and like the label's it was unreachable:
    // typing the stored value into a controlled field that already shows it fires no
    // `onChange`, the draft stays `null`, and the commit exits on `committed === null`
    // before the gate. Deleting `if (next === stage.promptPrefix) return;` left 45/45 green,
    // measured — the same defect the label case above has, and the same one the deleted stage
    // dialog carried in its own copy of both.
    //
    // Edit-then-revert makes the draft real, so the gate is the clause that decides. The
    // trailing real edit is what stops the case passing on a field that has stopped writing.
    renderNode("doing", [SEED[0]!, column("doing", { promptPrefix: "Same." }), SEED[2]!]);
    const input = field("Extra prompt for doing");
    fireEvent.change(input, { target: { value: "Same.X" } });
    fireEvent.change(input, { target: { value: "Same." } });
    expect(valueOf(input)).toBe("Same.");
    fireEvent.blur(input);
    expect(setStagePromptPrefix).toHaveBeenCalledTimes(0);
    // A genuine edit from the same field still commits.
    fireEvent.change(input, { target: { value: "Same. Read it first." } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(setStagePromptPrefix).toHaveBeenCalledWith(
        SPACE,
        "doing",
        "Same. Read it first.",
      ),
    );
  });

  it("falls back to the stored prefix when the write is refused", async () => {
    vi.mocked(setStagePromptPrefix).mockRejectedValue({
      kind: "other",
      message: "could not write the stage row",
    });
    renderNode("doing");
    const input = field("Extra prompt for doing");
    fireEvent.change(input, { target: { value: "typo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("could not write the stage row"),
    );
    expect(valueOf(field("Extra prompt for doing"))).toBe("");
    expect(stageOf("doing")?.promptPrefix).toBeNull();
  });
});

describe("the node panel's destinations", () => {
  it("shows the configured destinations in order, labelled by their column", () => {
    renderNode("backlog");
    expect(
      within(panel())
        .getAllByTestId(/^destination-(?!state|fanout)/)
        .map((el) => el.textContent),
    ).toEqual(["Doing"]);
  });

  it("says UNCONFIGURED for a column whose edges were never configured", () => {
    renderNode("done");
    expect(within(panel()).getByTestId("destination-state").textContent).toContain(
      "Unconfigured",
    );
  });

  it("says NOTHING MAY FOLLOW for [], which is never the null sentence", () => {
    // ADR 0099's third state, on the panel: `[]` is a person's decision to close the
    // column, and printing the UNCONFIGURED sentence here would claim a board that is
    // closed is open.
    renderNode("done", [SEED[0]!, SEED[1]!, column("done", { nextSlugs: [] })]);
    const state =
      within(panel()).getByTestId("destination-state").textContent ?? "";
    expect(state).toContain("No destinations");
    expect(state).not.toContain("Unconfigured");
  });

  it("appends a destination picked from the OTHER columns only (a self-loop is refused server-side)", async () => {
    renderNode("backlog");
    fireEvent.click(combo("Add a destination for backlog"));
    await screen.findByRole("option", { name: "Done" });
    // The column's OWN slug is not offered: `set_stage_next` rejects a self-loop
    // (spec §4), so offering it would be a control that can only fail.
    expect(screen.queryByRole("option", { name: "Backlog" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    await waitFor(() =>
      expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", ["doing", "done"]),
    );
    expect(stageOf("backlog")?.nextSlugs).toEqual(["doing", "done"]);
  });

  it("refuses the SAME picks the canvas drag refuses, because both call one rule", async () => {
    // THE F5 PIN, and the reason `workflowEdgeWrite.ts`'s stated reason for existing is
    // true rather than aspirational. `addDestination` used to re-spell the rule inline
    // (`const current = stage.nextSlugs ?? []; if (current.includes(destination)) return;`),
    // so the panel and the drag agreed only by luck and a rule change would have reached
    // the drag and not the panel — the drift the module was extracted to prevent.
    //
    // `doing` is the fixture that shows the drift, not `backlog` (which is configured, so
    // the two spellings coincide there). `doing.nextSlugs` is `null` and `done` is at
    // `sortOrder + 1`, so:
    //  - `done` is the fallback whose wire the canvas already draws DASHED, and picking it
    //    would write `["done"]` with nothing visible changing — the no-op the shared rule
    //    refuses, so the picker must not OFFER it either (an option that silently does
    //    nothing is the dead control this repo refuses);
    //  - `backlog` is a genuine new destination, and the payload is the one-item list
    //    `nextSlugsAfterConnect` produces — the same list the drag writes for the same hop,
    //    which is the assertion that makes "one owner" more than a comment.
    renderNode("doing");
    // The slice BEFORE the write — the one both surfaces are asked about. Captured up
    // front because the store repaints on the write, and the same call afterwards is a
    // duplicate refusal rather than this verdict.
    const preWrite = useTasks.getState().boardsBySpace[SPACE]!;
    const caption =
      within(panel()).getByTestId("destination-state").textContent ?? "";
    // The refused option is EXPLAINED rather than merely absent.
    expect(caption).toContain("Done");
    expect(caption).toContain("implied by the order");

    fireEvent.click(combo("Add a destination for doing"));
    await screen.findByRole("option", { name: "Backlog" });
    // THE ASSERTION THAT ACTUALLY CARRIES THIS CASE, and it is the OPTION SET rather than
    // the payload. Once the picker offers only what the rule accepts, every reachable pick
    // produces the same list under either spelling, so a payload assertion cannot see the
    // difference — measured: reverting `addDestination` to the inline
    // `[...(stage.nextSlugs ?? []), destination]` leaves every payload assertion here
    // green. What the shared rule uniquely controls is which options exist, so that is
    // what is compared against the predicate, computed here independently of the component.
    const accepted = (useTasks.getState().boardsBySpace[SPACE] ?? [])
      .filter((c) => canConnectStages(useTasks.getState().boardsBySpace[SPACE], "doing", c.stage.slug))
      .map((c) => c.stage.slug)
      .sort();
    expect(
      screen
        .getAllByRole("option")
        .map((el) => el.textContent ?? "")
        .filter((t) => ["Backlog", "Doing", "Done"].includes(t))
        .map((t) => t.toLowerCase())
        .sort(),
    ).toEqual(accepted);
    // Spelled out for the reader, since `accepted` is computed and would otherwise be a
    // tautology wearing a variable: `doing` is the self-loop, `done` is the refused
    // fallback, so only `backlog` may be offered.
    expect(accepted).toEqual(["backlog"]);
    expect(screen.queryByRole("option", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Doing" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Backlog" }));
    await waitFor(() =>
      expect(setStageNext).toHaveBeenCalledWith(SPACE, "doing", ["backlog"]),
    );
    // And the pure rule answers the same for the same hop — the shared owner, stated as a
    // fact and not as prose. Read from the slice as it was BEFORE the write, because after
    // it the same call is a duplicate refusal (`["backlog"]` already holds `backlog`),
    // which would be a different verdict and not this one.
    // `WorkflowsCanvas.editor.test.tsx` drives the drag side of the same pair.
    expect(nextSlugsAfterConnect(preWrite, "doing", "backlog")).toEqual(["backlog"]);
  });

  it("imports the edge rule rather than re-spelling it (the module's reason for existing)", () => {
    // THE IMPORT-LEVEL PIN ADR 0120 §Consequences asks for by name: *"an assertion that
    // `NodeDestinations`/`NodeSettingsBody` imports `workflowEdgeWrite` is what makes it
    // non-vacuous, since nothing in `tsc`, `vite build` or `vitest` can see a re-spelled
    // rule."*
    //
    // WHY A SOURCE READ AND NOT ONLY A BEHAVIOUR CASE. The case above compares the OPTION
    // SET against the predicate and does catch the naive `slug !== stage.slug` filter — but
    // it cannot catch `addDestination` alone reverting to `[...(stage.nextSlugs ?? []),
    // destination]`, because the picker only offers what the rule accepts, so every
    // reachable payload is identical under either spelling. Measured: that mutation leaves
    // all 46 cases green. That is not a weakness of the case, it is the nature of a
    // duplicated rule that currently agrees — the drift is a FUTURE rule change reaching one
    // surface and not the other, and only the import edge is evidence against that.
    const source = readFileSync(
      "src/components/workflows/NodeSettingsBody.tsx",
      "utf8",
    );
    // COMMENTS ARE STRIPPED FIRST, on `slabFloatSeparation.test.ts`'s argument: this very
    // case's comment quotes the OLD spelling, and a guard whose prose can satisfy it is the
    // trap `tauriBoundary.test.ts` records.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      /from\s+"\.\.\/\.\.\/lib\/workflowEdgeWrite"/.test(code),
      "NodeSettingsBody must import the shared edge rule",
    ).toBe(true);
    // And the two rule-owning calls it is supposed to make — `nextSlugsAfterConnect` for
    // the write, `canConnectStages` for the option set. Naming both is what stops this
    // passing on a file that imports the module for one of the two and re-spells the other.
    expect(code).toContain("nextSlugsAfterConnect(");
    expect(code).toContain("canConnectStages(");
    // The rule must NOT be re-spelled beside the import. `?? []` is the shape the inline
    // version was built out of; `nextSlugs ?? []` is the one place it would reappear.
    expect(code).not.toMatch(/nextSlugs\s*\?\?\s*\[\]/);
  });

  it("removing a destination writes the remaining list in its own order", async () => {
    renderNode("backlog", [
      column("backlog", { nextSlugs: ["doing", "done"] }),
      SEED[1]!,
      SEED[2]!,
    ]);
    fireEvent.click(button("Remove Doing from backlog"));
    await waitFor(() =>
      expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", ["done"]),
    );
  });

  it("reordering two destinations keeps the FIRST one the card's primary next step", async () => {
    renderNode("backlog", [
      column("backlog", { nextSlugs: ["doing", "done"] }),
      SEED[1]!,
      SEED[2]!,
    ]);
    fireEvent.click(button("Move Done earlier in backlog"));
    await waitFor(() =>
      expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", ["done", "doing"]),
    );
  });

  it("says plainly which edge the chain follows when there is more than one", () => {
    // The fan-out truth: `nextStepOf` (`src/lib/workflowGraph.ts`) follows
    // `nextStepSlugs(...)[0]` ONLY, and a card lives in one column. Two chips are not
    // two parallel runs and the panel must not imply they are.
    renderNode("backlog", [
      column("backlog", { nextSlugs: ["doing", "done"] }),
      SEED[1]!,
      SEED[2]!,
    ]);
    const fanout = within(panel()).getByTestId("destination-fanout");
    expect(fanout.textContent).toContain("Follows Doing only");
    expect(fanout.textContent).toMatch(/Done is not followed/);
  });

  it("does not call an unresolvable head edge a live one", () => {
    // The head names a column the slice does not hold, so `nextStepOf` yields NOTHING
    // and the panel says the chain follows nothing rather than naming a live hop.
    renderNode("backlog", [
      column("backlog", { nextSlugs: ["ghost", "done"] }),
      SEED[1]!,
      SEED[2]!,
    ]);
    expect(
      within(panel()).getByTestId("destination-fanout").textContent,
    ).toMatch(/follows nothing here/);
  });
});

describe("the node panel's place in the order — the WHOLE column order is sent", () => {
  it("moving a column up sends every Stage's slug, not the pair that swapped", async () => {
    renderNode("done");
    fireEvent.click(button("Move done up"));
    await waitFor(() => expect(reorderStages).toHaveBeenCalledTimes(1));
    expect(reorderStages).toHaveBeenCalledWith(SPACE, ["backlog", "done", "doing"]);
    expect(slice().map((c) => c.stage.slug)).toEqual(["backlog", "done", "doing"]);
  });

  it("moving a column down sends the whole order too", async () => {
    renderNode("backlog");
    fireEvent.click(button("Move backlog down"));
    await waitFor(() =>
      expect(reorderStages).toHaveBeenCalledWith(SPACE, [
        "doing",
        "backlog",
        "done",
      ]),
    );
  });

  it("the first column cannot move up and the last cannot move down", () => {
    renderNode("backlog");
    expect(disabledOf(button("Move backlog up"))).toBe(true);
    fireEvent.click(button("Move backlog up"));
    expect(reorderStages).toHaveBeenCalledTimes(0);
  });

  it("the last column cannot move down", () => {
    renderNode("done");
    expect(disabledOf(button("Move done down"))).toBe(true);
  });
});

describe("the node panel's delete, and the picker that has no escape hatch", () => {
  /* The count that DECIDES the delete arm is read from the slice at click time, not
   * from the number printed in the header — `StageRow`'s rule, inherited verbatim:
   * "I know nothing about this column" and "this column holds nothing" are different
   * facts and must not share an arm. The absent-column half of that (a slug the slice
   * cannot answer at all) is pinned in `NodeSettingsPanel.test.tsx`, where the shell
   * renders no controls for it. */

  it("an EMPTY column deletes immediately — no picker for zero cards", async () => {
    renderNode("done");
    fireEvent.click(button("Delete done"));
    await waitFor(() =>
      expect(deleteStage).toHaveBeenCalledWith(SPACE, "done", undefined),
    );
    expect(screen.queryByRole("combobox", { name: /Move the cards/ })).toBeNull();
  });

  it("a column WITH cards opens a destination picker and writes nothing yet", async () => {
    renderNode("backlog");
    fireEvent.click(button("Delete backlog"));
    await screen.findByRole("combobox", { name: "Move the cards in backlog to" });
    expect(deleteStage).toHaveBeenCalledTimes(0);
  });

  it("the picker offers ONLY the Space's other columns and no way to skip it", async () => {
    renderNode("backlog");
    fireEvent.click(button("Delete backlog"));
    const trigger = await screen.findByRole("combobox", {
      name: "Move the cards in backlog to",
    });
    fireEvent.click(trigger);
    await screen.findByRole("option", { name: "Doing" });
    expect(screen.getByRole("option", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Backlog" })).toBeNull();
    // No "delete anyway" escape (spec §8): a card whose `stage_slug` names no row is
    // invisible to `get_board`, keeps costing money, and can never be clicked again.
    expect(
      screen.queryByRole("button", { name: /delete anyway|discard|anyway/i }),
    ).toBeNull();
    expect(screen.queryByText(/delete anyway/i)).toBeNull();
  });

  it("choosing a destination deletes with it, and NEVER moves the cards one by one", async () => {
    renderNode("backlog");
    fireEvent.click(button("Delete backlog"));
    await pick(
      await screen.findByRole("combobox", {
        name: "Move the cards in backlog to",
      }),
      "Done",
    );
    await waitFor(() =>
      expect(deleteStage).toHaveBeenCalledWith(SPACE, "backlog", "done"),
    );
    // THE five-compactions bug, pinned at the surface that could still cause it:
    // `move_task` runs the destination's `on_enter`, so per-card relocation would
    // fire a compaction per card as a side effect of deleting a column.
    expect(moveTask).toHaveBeenCalledTimes(0);
  });

  it("cancelling the picker deletes nothing", async () => {
    renderNode("backlog");
    fireEvent.click(button("Delete backlog"));
    await screen.findByRole("combobox", { name: "Move the cards in backlog to" });
    fireEvent.click(button("Cancel deleting backlog"));
    expect(deleteStage).toHaveBeenCalledTimes(0);
    expect(
      within(panel()).queryByRole("combobox", {
        name: "Move the cards in backlog to",
      }),
    ).toBeNull();
  });

  it("a refused delete leaves the node on screen and says why", async () => {
    vi.mocked(deleteStage).mockRejectedValue({
      kind: "not_found",
      message: "stage doing is still a destination",
    });
    renderNode("done");
    fireEvent.click(button("Delete done"));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain(
        "stage doing is still a destination",
      ),
    );
    expect(within(panel()).getByTestId("stage-slug-done")).toBeTruthy();
  });
});
