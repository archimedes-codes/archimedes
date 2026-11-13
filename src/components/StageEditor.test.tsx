import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import StageEditor from "./StageEditor";
import { useTasks } from "../store/tasks";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import {
  createStage,
  deleteStage,
  getArtifact,
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
  setBoardStrict,
  setStageNext,
  setStageSkill,
  writeArtifact,
  type SkillInfo,
  type StageRow,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";

/**
 * `StageEditor` — the dialog the board header's `Configure` control opens
 * (issue #179 §8). The human surface for the `stages` row: label, launch Skill,
 * destinations, order, delete, and the Space's Strict-workflow opt-in.
 *
 * WHY THE BARREL IS MOCKED WITH THE WRAPPER NAMES. The factory spreads
 * `vi.importActual`, so a name this file does not list resolves to the REAL
 * wrapper, which calls `invoke` and rejects in jsdom — the file would then be
 * asserting on a rejection instead of on the write (AGENTS.md's boot-mock trap).
 * The editor drives the STORE's actions and the store drives the wrappers, so the
 * assertions here read BOTH: which arguments reached the wire, and what the store
 * slice looks like afterwards. The store's own behaviour (revert-on-rejection, the
 * whole-slice rule) is pinned in `src/store/tasks.test.ts` and is NOT re-pinned
 * here — this file pins the dialog: what it renders, what a click asks for, and
 * the two rules the spec makes visible (the slug is frozen, the picker has no
 * escape hatch).
 *
 * TWO RESETS in `beforeEach`, both load-bearing (`resetStores()` cannot reach a
 * module-`let`, and `useTasks` has one). The catalog caches are cleared too, and
 * not for tidiness: `useSkillCatalog`'s cache is MODULE-level, so the first case
 * to mount the dialog freezes whatever `listSkills` answered then, and every later
 * case that installs a non-empty catalog would be asserting on a warm cache.
 *
 * SCOPE DISCIPLINE. Radix `Select` portals its list to `document.body`, so the
 * OPENED list is read off `screen` and never `within(dialog())`; the dialog's own
 * nodes (rows, inputs, the footer Switch, the error line) are read through
 * `within(dialog())`, because the board's `IpcErrorLine` carries the same
 * `role="alert"` and both can be live at once in the real app.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    createTask: vi.fn(),
    getTask: vi.fn(),
    editTask: vi.fn(),
    moveTask: vi.fn(),
    reorderTasks: vi.fn(),
    linkSession: vi.fn(),
    // T3's ten — the seven Stage verbs, the Strict pair, the artifact pair. The
    // editor calls the store's actions, which call these.
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
    // The four mention catalogs `useMentionCatalogs` mounts. Un-mocked they reach
    // the real `invoke` and reject in jsdom — the noisy-green case the header
    // above is about, and the reason the "no second fetch" pin below can be
    // counted at all.
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

/* `stage()` mirrors the wire type exactly — `onEnterSkill`/`nextSlugs` are
 * REQUIRED (the Rust side always emits both), so they default rather than becoming
 * optional, and the defaults sit BEFORE the spread so a case can override either.
 * `null` is UNCONFIGURED; `nextSlugs: []` is the OTHER answer (configured, leading
 * nowhere — ADR 0099) and a case that means it passes it explicitly. */
const stage = (slug: string, over: Partial<StageRow> = {}): StageRow => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder: 0,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
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

/** The seeded board: three columns in `sort_order`, cards on the FIRST and SECOND
 *  and none on the third — so the delete flow has both shapes on screen at once
 *  (`done` deletes immediately, `backlog` and `doing` need the picker). */
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

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/** The row for one Stage. Addressed by `data-testid` rather than by role: the row
 *  is the ONE `role="button"` in its subtree, but the controls nested in it are
 *  native `<button>`s, which share role `button` without the attribute — so a
 *  role query would match the row AND everything inside it. */
function row(slug: string): HTMLElement {
  return within(dialog()).getByTestId(`stage-row-${slug}`);
}

/** The row's label field. */
function labelField(slug: string): HTMLElement {
  return within(row(slug)).getByRole("textbox", { name: `Label for ${slug}` });
}

/** The row's Skill trigger. Radix gives a `SelectTrigger` role `combobox`. */
function skillTrigger(slug: string): HTMLElement {
  return within(row(slug)).getByRole("combobox", { name: `Skill for ${slug}` });
}

/** The row's destination trigger (the ADD half of the ordered list). */
function destinationTrigger(slug: string): HTMLElement {
  return within(row(slug)).getByRole("combobox", {
    name: `Add a destination for ${slug}`,
  });
}

/** Open a Radix `Select` and click one of its items. The list is PORTALLED to
 *  `document.body`, so the item is read off `screen`, never `within(dialog())`. */
async function pick(trigger: HTMLElement, option: string): Promise<void> {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** The footer's Strict-workflow Switch. */
function strictSwitch(): HTMLElement {
  return within(dialog()).getByRole("switch", { name: "Strict workflow" });
}

/** The dialog's own error line, scoped to the dialog (the board's
 *  `IpcErrorLine` can be live at the same time in the real app). */
function errorLine(): HTMLElement | null {
  return within(dialog()).queryByRole("alert");
}

/* NO jest-dom in this repo's vitest setup (AGENTS.md; `UpdateSection.test.tsx:361`
 * spells the same note), so the three DOM facts these cases read are read off the
 * nodes: an input's VALUE property, and the two ARIA states Radix's `Switch` and
 * this dialog's own inert controls publish. */
const valueOf = (el: HTMLElement): string => (el as HTMLInputElement).value;
/** A control's inertness. `Button`/native `<button disabled>` sets the PROPERTY;
 *  `RowButton` cannot (a `div` has no `disabled`), so it emits `aria-disabled` —
 *  both shapes mean "this click does nothing" and both are read here. */
const disabledOf = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled === true ||
  el.getAttribute("aria-disabled") === "true";
/** The `Switch`'s two states, as one read so a case can say "off, and usable"
 *  without spelling the accessors twice per assertion. Radix renders
 *  `<button role="switch" aria-checked={…} disabled={…}>` — the checked half is
 *  ARIA, the inert half is the PROPERTY (there is no `aria-disabled` to read). */
const checkedOf = (el: HTMLElement): { checked: boolean; disabled: boolean } => ({
  checked: el.getAttribute("aria-checked") === "true",
  disabled: (el as HTMLButtonElement).disabled === true,
});
/** A control in the dialog by its accessible name. */
const byName = (name: string): HTMLElement =>
  within(dialog()).getByRole("button", { name });

/** Seed the store the way the board would and mount the dialog. */
function renderEditor(
  spacePath: string | null = SPACE,
  seed: StageWithTasks[] = SEED,
): { onClose: () => void; unmount: () => void } {
  useTasks.setState({ boardsBySpace: { [SPACE]: seed } });
  const onClose = vi.fn();
  const view = render(<StageEditor spacePath={spacePath} onClose={onClose} />);
  return { onClose, unmount: view.unmount };
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
    listSkills,
  ]) {
    vi.mocked(fn).mockReset();
  }
  // Defaults for everything the dialog AWAITS a value from. A bare `vi.fn()`
  // resolves `undefined`, and an action that reads a field off it fails on
  // `undefined.field` instead of on the thing the case is checking.
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
  // The Stage verbs answer the STORED row and the store merges that row back over
  // its optimistic guess, so these defaults ECHO their arguments the way the Rust
  // side does. A fixed `stage("backlog")` here would be merged onto whichever column
  // a case edited — every "the store agrees with the editor" assertion below would
  // then be reading a fake row rather than the write.
  vi.mocked(renameStage).mockImplementation(async (_space, slug, label) => ({
    ...stage(slug),
    label,
  }));
  vi.mocked(setStageSkill).mockImplementation(async (_space, slug, skill) => ({
    ...stage(slug),
    onEnterSkill: skill ?? null,
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

/** The slice as the store holds it now — the dialog writes through the store, so
 *  this is what "the board agrees with the editor" is measured against. */
const slice = (): StageWithTasks[] => useTasks.getState().boardsBySpace[SPACE] ?? [];
const stageOf = (slug: string): StageRow | undefined =>
  slice().find((c) => c.stage.slug === slug)?.stage;

describe("StageEditor — the dialog's shape", () => {
  it("renders nothing without a Space (there is no board to configure)", () => {
    renderEditor(null);
    // The state this models is NO Space open at all — the board's `Configure`
    // control is disabled in that state (it is enabled for a Space with zero
    // Sessions ever since issue #185 made the board read the Selected Space), so
    // this is the second half of that rule rather than a live path — but a dialog
    // that mounted with no Space would be calling `get_board(null)` behind the
    // disabled button.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("titles the dialog and lists one row per Stage, in the board's order", async () => {
    renderEditor();
    expect(
      within(dialog()).getByRole("heading", { name: "Configure stages" }),
    ).toBeTruthy();
    expect(within(dialog()).getByTestId("stage-row-backlog")).toBeTruthy();
    expect(within(dialog()).getByTestId("stage-row-doing")).toBeTruthy();
    expect(within(dialog()).getByTestId("stage-row-done")).toBeTruthy();
    // The board's ORDER, not an alphabetical one: the column strip renders in
    // `sort_order` and an editor that listed them differently would be a second,
    // contradictory answer to "which column is next".
    const rows = [...dialog().querySelectorAll("[data-testid^='stage-row-']")].map(
      (el) => el.getAttribute("data-testid"),
    );
    expect(rows).toEqual(["stage-row-backlog", "stage-row-doing", "stage-row-done"]);
  });

  it("shows each row's slug as a read-only caption, beside an editable label", async () => {
    renderEditor();
    // The slug is FROZEN after `createStage` derives it (spec §5), so the editor
    // shows the mismatch instead of hiding it. `data-slot="input"` is how the
    // `Input` primitive marks its own `<input>`; the caption must NOT be one.
    expect(within(row("doing")).getAllByRole("textbox")).toHaveLength(1);
    expect(valueOf(labelField("doing"))).toBe("Doing");
    expect(row("doing").textContent).toContain("doing");
    expect(within(row("doing")).getByTestId("stage-slug-doing").textContent).toBe(
      "doing",
    );
  });

  it("renders the footer's Strict workflow Switch", async () => {
    renderEditor();
    expect(strictSwitch()).toBeTruthy();
  });

  it("filters the rows by label or slug, case-insensitively", async () => {
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Search stages…"), {
      target: { value: "DON" },
    });
    expect(within(dialog()).queryByTestId("stage-row-backlog")).toBeNull();
    expect(within(dialog()).queryByTestId("stage-row-doing")).toBeNull();
    // `DON` matches the LABEL "Done" and the slug `done` — the one needle that
    // proves both halves of the match are wired, not just the label.
    expect(within(dialog()).queryByTestId("stage-row-done")).toBeTruthy();
  });

  it("says so when nothing matches, and says something else when the Space has no Stages", async () => {
    const { unmount } = renderEditor(SPACE, []);
    expect(within(dialog()).getByText("This Space has no stages yet.")).toBeTruthy();
    // The shell REMOVES the scroller when it shows the empty line (its own doc says
    // an empty scroller beside the sentence would be a stray node and a second
    // `parentElement`), so the add-field is the only surviving proof the dialog is
    // still mounted for the empty case.
    expect(screen.getByRole("textbox", { name: "New stage label" })).toBeTruthy();
    unmount();

    renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Search stages…"), {
      target: { value: "zzz" },
    });
    expect(within(dialog()).getByText('No stages match "zzz".')).toBeTruthy();
  });

  it("closing the dialog asks the board to close it (the board owns the flag)", async () => {
    const { onClose } = renderEditor();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("StageEditor — renaming a Stage keeps its slug", () => {
  it("typing then committing calls renameStage with the Space, the slug and the new label", async () => {
    renderEditor();
    fireEvent.change(labelField("doing"), { target: { value: "In flight" } });
    fireEvent.blur(labelField("doing"));
    await waitFor(() =>
      expect(renameStage).toHaveBeenCalledWith(SPACE, "doing", "In flight"),
    );
    expect(stageOf("doing")?.label).toBe("In flight");
  });

  it("Enter commits the rename (a field you have to leave to apply is a field that lies)", async () => {
    renderEditor();
    fireEvent.change(labelField("done"), { target: { value: "Shipped" } });
    fireEvent.keyDown(labelField("done"), { key: "Enter" });
    await waitFor(() =>
      expect(renameStage).toHaveBeenCalledWith(SPACE, "done", "Shipped"),
    );
  });

  it("one keystroke is NOT one rename_stage call (a write per character is a write storm)", async () => {
    renderEditor();
    const field = labelField("done");
    fireEvent.change(field, { target: { value: "S" } });
    fireEvent.change(field, { target: { value: "Sh" } });
    fireEvent.change(field, { target: { value: "Shi" } });
    expect(renameStage).toHaveBeenCalledTimes(0);
    fireEvent.blur(field);
    await waitFor(() => expect(renameStage).toHaveBeenCalledTimes(1));
  });

  it("leaving the label unchanged writes nothing", async () => {
    renderEditor();
    fireEvent.change(labelField("done"), { target: { value: "Done" } });
    fireEvent.blur(labelField("done"));
    // The commit is gated on the value having CHANGED, not on the field having been
    // touched: focus-out happens on every click elsewhere in the dialog, so an
    // ungated commit would write the whole board's labels as the user worked.
    expect(renameStage).toHaveBeenCalledTimes(0);
  });

  it("the slug survives the rename, in the caption and in the store", async () => {
    vi.mocked(renameStage).mockResolvedValue(
      stage("doing", { sortOrder: 1, onEnter: "compact", label: "In flight" }),
    );
    renderEditor();
    fireEvent.change(labelField("doing"), { target: { value: "In flight" } });
    fireEvent.blur(labelField("doing"));
    await waitFor(() => expect(stageOf("doing")?.label).toBe("In flight"));
    // The row is still addressable by its OLD slug — the testid is the slug, so a
    // rename that moved the slug would fail here rather than silently re-key.
    expect(within(row("doing")).getByTestId("stage-slug-doing").textContent).toBe(
      "doing",
    );
    expect(slice().map((c) => c.stage.slug)).toEqual(["backlog", "doing", "done"]);
  });

  it("a refused rename puts the stored label back in the field and says why", async () => {
    vi.mocked(renameStage).mockRejectedValue({
      kind: "not_found",
      message: "no such stage: doing",
    });
    renderEditor();
    fireEvent.change(labelField("doing"), { target: { value: "In flight" } });
    fireEvent.blur(labelField("doing"));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("no such stage: doing"),
    );
    // The field shows the STORE's label, not the text that was refused: the store
    // reverted the slice and the caption follows it, so the editor never displays
    // a label the database does not have.
    await waitFor(() => expect(valueOf(labelField("doing"))).toBe("Doing"));
  });
});

describe("StageEditor — the Skill Select shares the board's one catalog fetch", () => {
  it("offers `none` plus every Skill the catalog holds", async () => {
    vi.mocked(listSkills).mockResolvedValue([skill("research"), skill("discuss")]);
    renderEditor();
    // The trigger shows the column's STORED Skill — the row's own answer to "what
    // does a Session started here load", before anyone opens the list.
    await waitFor(() =>
      expect(skillTrigger("doing").textContent).toContain("research"),
    );
    fireEvent.click(skillTrigger("backlog"));
    await screen.findByRole("option", { name: "none" });
    expect(screen.getByRole("option", { name: "research" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "discuss" })).toBeTruthy();
  });

  it("picking a Skill calls setStageSkill with its name", async () => {
    vi.mocked(listSkills).mockResolvedValue([skill("research")]);
    renderEditor();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    await pick(skillTrigger("backlog"), "research");
    await waitFor(() =>
      expect(setStageSkill).toHaveBeenCalledWith(SPACE, "backlog", "research"),
    );
    expect(stageOf("backlog")?.onEnterSkill).toBe("research");
  });

  it("picking `none` CLEARS the Skill (null, not the string \"none\")", async () => {
    vi.mocked(listSkills).mockResolvedValue([skill("research")]);
    renderEditor();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    // `doing` already carries `research`, so this is the clearing direction.
    await pick(skillTrigger("doing"), "none");
    await waitFor(() =>
      expect(setStageSkill).toHaveBeenCalledWith(SPACE, "doing", null),
    );
    expect(stageOf("doing")?.onEnterSkill).toBeNull();
  });

  it("the catalog is read through the shared hook: a second consumer fetches nothing", async () => {
    // The spec's "not a second fetch" requirement, pinned as the cache dedupe the
    // requirement depends on. `useMentionCatalogs` keys its caches per Space and
    // `useSkillCatalog` caches the PROMISE, so mounting the editor while the board
    // already mounted the same key must not issue another `listSkills`.
    renderEditor();
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(1));
    vi.mocked(listSkills).mockClear();
    // A SECOND mount of the same Space (what the board + editor pair is, from the
    // cache's point of view). A direct `listSkills(...)` call in `StageEditor`
    // instead of the shared hook would land here as a second call.
    // Re-render the SAME mount rather than mount a second dialog: Testing Library
    // tears the previous render down between `render()` calls, and a Radix Dialog
    // unmount also removes the portal that holds the first `role="dialog"` node —
    // so `getAllByRole` would count one dialog no matter how many mounts happened.
    // The cache question is about the FETCH, and the fetch count is what this reads.
    render(<StageEditor spacePath={SPACE} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(listSkills).toHaveBeenCalledTimes(0);
  });
});

describe("StageEditor — the destination list is the transition graph", () => {
  it("shows the configured destinations in order, labelled by their Stage", async () => {
    renderEditor();
    const chips = within(row("backlog")).getAllByTestId(/^destination-/);
    expect(chips.map((el) => el.textContent)).toContain("Doing");
  });

  it("says UNCONFIGURED for a Stage with no edges configured, and says something else for an empty list (ADR 0099)", async () => {
    renderEditor();
    // `done.nextSlugs === null` — unconstrained.
    expect(
      within(row("done")).getByTestId("destination-state").textContent,
    ).toContain("Unconfigured");
    const configuredEmpty = [
      SEED[0],
      SEED[1],
      stage2("done", { sortOrder: 2, nextSlugs: [] }),
    ];
    renderEditor(SPACE, configuredEmpty);
    // `nextSlugs: []` — configured, and NOTHING may follow. Collapsing the two
    // would tell the user their board is unconstrained when it is closed.
    expect(
      within(row("done")).getByTestId("destination-state").textContent,
    ).toContain("No destinations");
  });

  it("appends a destination picked from the other Stages only (a self-loop is refused server-side)", async () => {
    renderEditor();
    // ONE open, then the click: the list is already up from the assertion above, so
    // a second `pick()` here would click the trigger again and CLOSE it.
    fireEvent.click(destinationTrigger("backlog"));
    await screen.findByRole("option", { name: "Done" });
    // The Stage's OWN slug is not offered: `set_stage_next` rejects a self-loop
    // (spec §4), so offering it would be a button that always fails.
    expect(screen.queryByRole("option", { name: "Backlog" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    await waitFor(() =>
      expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", [
        "doing",
        "done",
      ]),
    );
    expect(stageOf("backlog")?.nextSlugs).toEqual(["doing", "done"]);
  });

  it("removing a destination writes the remaining list in its own order", async () => {
    renderEditor(SPACE, [
      stage2("backlog", { nextSlugs: ["doing", "done"] }),
      SEED[1],
      SEED[2],
    ]);
    fireEvent.click(
      within(row("backlog")).getByRole("button", {
        name: "Remove Doing from backlog",
      }),
    );
    await waitFor(() =>
      expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", ["done"]),
    );
  });

  it("reordering two destinations keeps the FIRST one the card's primary next step", async () => {
    renderEditor(SPACE, [
      stage2("backlog", { nextSlugs: ["doing", "done"] }),
      SEED[1],
      SEED[2],
    ]);
    fireEvent.click(
      within(row("backlog")).getByRole("button", {
        name: "Move Done earlier in backlog",
      }),
    );
    await waitFor(() =>
      expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", [
        "done",
        "doing",
      ]),
    );
  });
});

describe("StageEditor — reorder passes the WHOLE column order", () => {
  it("moving a column up sends every Stage's slug, not the pair that swapped", async () => {
    renderEditor();
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Move done up" }),
    );
    await waitFor(() => expect(reorderStages).toHaveBeenCalledTimes(1));
    // Requirement 1. `reorder_stages` follows `reorder_spaces` (renumber everything
    // the caller shows), so a two-slug patch would leave the untouched column
    // holding a stale `sort_order` that can collide with the renumbered ones.
    expect(reorderStages).toHaveBeenCalledWith(SPACE, [
      "backlog",
      "done",
      "doing",
    ]);
    expect(slice().map((c) => c.stage.slug)).toEqual([
      "backlog",
      "done",
      "doing",
    ]);
  });

  it("moving a column down sends the whole order too", async () => {
    renderEditor();
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Move backlog down" }),
    );
    await waitFor(() =>
      expect(reorderStages).toHaveBeenCalledWith(SPACE, [
        "doing",
        "backlog",
        "done",
      ]),
    );
  });

  it("the first column cannot move up and the last cannot move down", async () => {
    renderEditor();
    expect(disabledOf(byName("Move backlog up"))).toBe(true);
    expect(disabledOf(byName("Move done down"))).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Move backlog up" }));
    expect(reorderStages).toHaveBeenCalledTimes(0);
  });
});

describe("StageEditor — delete, and the picker that has no escape hatch", () => {
  it("an EMPTY Stage deletes immediately — no picker for zero cards", async () => {
    renderEditor();
    fireEvent.click(
      within(row("done")).getByRole("button", { name: "Delete done" }),
    );
    await waitFor(() =>
      expect(deleteStage).toHaveBeenCalledWith(SPACE, "done", undefined),
    );
    expect(screen.queryByRole("combobox", { name: /Move the cards/ })).toBeNull();
  });

  it("a Stage WITH cards opens a destination picker and writes nothing yet", async () => {
    renderEditor();
    fireEvent.click(
      within(row("backlog")).getByRole("button", { name: "Delete backlog" }),
    );
    await screen.findByRole("combobox", {
      name: "Move the cards in backlog to",
    });
    expect(deleteStage).toHaveBeenCalledTimes(0);
  });

  it("the picker offers ONLY the Space's other Stages and no way to skip it", async () => {
    renderEditor();
    fireEvent.click(
      within(row("backlog")).getByRole("button", { name: "Delete backlog" }),
    );
    const trigger = await screen.findByRole("combobox", {
      name: "Move the cards in backlog to",
    });
    fireEvent.click(trigger);
    await screen.findByRole("option", { name: "Doing" });
    expect(screen.getByRole("option", { name: "Done" })).toBeTruthy();
    // The doomed column is not a destination for its own cards.
    expect(screen.queryByRole("option", { name: "Backlog" })).toBeNull();
    // And there is no "delete anyway" escape (spec §8): the ONLY way a Stage with
    // cards is deleted is through a destination, because a card whose
    // `stage_slug` names no row is invisible to `get_board` — it survives, keeps
    // costing money through its Session, and can never be clicked again.
    expect(
      screen.queryByRole("button", { name: /delete anyway|discard|anyway/i }),
    ).toBeNull();
    expect(screen.queryByText(/delete anyway/i)).toBeNull();
  });

  it("choosing a destination deletes with it, and NEVER moves the cards one by one", async () => {
    renderEditor();
    fireEvent.click(
      within(row("backlog")).getByRole("button", { name: "Delete backlog" }),
    );
    await pick(
      await screen.findByRole("combobox", {
        name: "Move the cards in backlog to",
      }),
      "Done",
    );
    await waitFor(() =>
      expect(deleteStage).toHaveBeenCalledWith(SPACE, "backlog", "done"),
    );
    // THE five-compactions bug, pinned at the surface that could still cause it.
    // `move_task` runs the destination's `on_enter`, so relocating the cards with
    // per-card calls would fire a compaction per card as a side effect of deleting
    // a column. The relocation is ONE bulk UPDATE inside `delete_stage`.
    expect(moveTask).toHaveBeenCalledTimes(0);
  });

  it("cancelling the picker deletes nothing", async () => {
    renderEditor();
    fireEvent.click(
      within(row("backlog")).getByRole("button", { name: "Delete backlog" }),
    );
    await screen.findByRole("combobox", {
      name: "Move the cards in backlog to",
    });
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Cancel deleting backlog" }),
    );
    expect(deleteStage).toHaveBeenCalledTimes(0);
    expect(
      within(dialog()).queryByRole("combobox", {
        name: "Move the cards in backlog to",
      }),
    ).toBeNull();
  });

  it("a refused delete leaves the row on screen and says why", async () => {
    vi.mocked(deleteStage).mockRejectedValue({
      kind: "not_found",
      message: "stage doing is still a destination",
    });
    renderEditor();
    fireEvent.click(
      within(row("done")).getByRole("button", { name: "Delete done" }),
    );
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain(
        "stage doing is still a destination",
      ),
    );
    expect(within(dialog()).queryByTestId("stage-row-done")).toBeTruthy();
  });
});

describe("StageEditor — the Strict workflow Switch", () => {
  it("is DISABLED while the read is in flight, and shows the value once it lands", async () => {
    // THE in-flight answer, and it is a decision rather than an accident: a Switch
    // painted `off` is a CLAIM about the Space, and the Space has not answered yet.
    // Disabled is the only state that is not a guess, and it is why the editor reads
    // the flag instead of defaulting it — the value must be the one `moveTask`
    // enforces, or the Switch and the drag disagree.
    let release: (v: boolean) => void = () => {};
    vi.mocked(getBoardStrict).mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    renderEditor();
    expect(checkedOf(strictSwitch()).disabled).toBe(true);
    release(true);
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(true));
    expect(checkedOf(strictSwitch()).disabled).toBe(false);
  });

  it("answers off for a Space that never opted in, and is usable", async () => {
    vi.mocked(getBoardStrict).mockResolvedValue(false);
    renderEditor();
    await waitFor(() => expect(getBoardStrict).toHaveBeenCalledWith(SPACE));
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    expect(checkedOf(strictSwitch()).disabled).toBe(false);
  });

  it("toggling writes the flag through the store", async () => {
    vi.mocked(getBoardStrict).mockResolvedValue(false);
    renderEditor();
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    fireEvent.click(strictSwitch());
    await waitFor(() => expect(setBoardStrict).toHaveBeenCalledWith(SPACE, true));
  });

  it("re-reads the flag after the write, so the Switch never shows a value the Space refused", async () => {
    // The Switch's value comes from `getBoardStrict` on BOTH sides of the write.
    // The store's `setBoardStrict` captures its failure into `error` and does not
    // rethrow (the `moveTask` shape), so without this re-read a refused toggle
    // would leave the Switch claiming Strict over a board whose drags are all
    // accepted — the exact disagreement `getBoardStrict`'s own doc says it exists
    // to prevent.
    vi.mocked(getBoardStrict)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    vi.mocked(setBoardStrict).mockRejectedValue({
      kind: "command",
      message: "could not write the Space row",
    });
    renderEditor();
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    fireEvent.click(strictSwitch());
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("could not write the Space row"),
    );
    await waitFor(() =>
      expect(checkedOf(strictSwitch()).checked).toBe(false),
    );
    expect(getBoardStrict).toHaveBeenCalledTimes(2);
  });

  it("a FAILED read leaves the Switch disabled rather than defaulting it to off", async () => {
    vi.mocked(getBoardStrict).mockRejectedValue({
      kind: "command",
      message: "board_strict read failed",
    });
    renderEditor();
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("board_strict read failed"),
    );
    // `false` here would be a fact the editor invented: an off Switch over a Space
    // that IS strict means the user believes drags are bound when they are not.
    expect(checkedOf(strictSwitch()).disabled).toBe(true);
    expect(setBoardStrict).toHaveBeenCalledTimes(0);
  });
});

describe("StageEditor — adding a Stage", () => {
  it("a new label appends a column through the store", async () => {
    renderEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "New stage label" }), {
      target: { value: "Spike" },
    });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add stage" }));
    await waitFor(() => expect(createStage).toHaveBeenCalledWith(SPACE, "Spike", undefined));
    expect(slice().map((c) => c.stage.slug)).toContain("spike");
  });

  it("an empty label offers no write (a column nobody named is a column nobody can rename)", async () => {
    renderEditor();
    expect(disabledOf(byName("Add stage"))).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add stage" }));
    expect(createStage).toHaveBeenCalledTimes(0);
  });

  it("a colliding label is REFUSED and not suffixed, and the row count is unchanged", async () => {
    // T1 refuses a collision rather than inventing `spike-2` — a slug nobody typed.
    // The editor's half of that rule is to surface the refusal and add nothing.
    vi.mocked(createStage).mockRejectedValue({
      kind: "not_found",
      message: "stage backlog is taken by Backlog",
    });
    renderEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "New stage label" }), {
      target: { value: "Backlog" },
    });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add stage" }));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("stage backlog is taken"),
    );
    expect(dialog().querySelectorAll("[data-testid^='stage-row-']")).toHaveLength(3);
    // The draft survives the refusal — the user typed a label and the app should
    // not have thrown it away because the SLUG was taken.
    expect(valueOf(screen.getByRole("textbox", { name: "New stage label" }))).toBe(
      "Backlog",
    );
  });
});

describe("StageEditor — one role per row, and who gets the click", () => {
  it("the row carries the ONLY [role=\"button\"] in its subtree", async () => {
    renderEditor();
    const doing = row("doing");
    // `RowButton` is the ONE hand-rolled `role="button"` node; the controls nested
    // in it are native `<button>`s, which need no role spelled and contribute zero
    // `[role="button"]` matches. Spelling one here would give every row two roles
    // and break every `.closest('[role="button"]')` read in the suite.
    expect(doing.getAttribute("role")).toBe("button");
    // …and NOTHING below it carries the attribute (`querySelectorAll` walks
    // DESCENDANTS only, so 0 here is the passing number: the row is the one match).
    expect(doing.querySelectorAll('[role="button"]')).toHaveLength(0);
    // Across the whole dialog that is exactly ONE per row — three rows, three roles.
    expect(
      dialog().querySelectorAll('[role="button"]').length,
    ).toBe(3);
    // And there ARE nested controls — the pin is about the ROLE, not the count of
    // buttons (label input aside, this row carries a Skill trigger, reorder arrows
    // and a delete).
    expect(doing.querySelectorAll("button").length).toBeGreaterThan(2);
  });

  it("the row's own click and Enter focus its label field (the affordance the stops protect)", async () => {
    // The positive half, without which the two cases below pass for a row that has
    // no affordance at all.
    renderEditor();
    fireEvent.click(within(dialog()).getByTestId("stage-row-doing"));
    expect(document.activeElement).toBe(labelField("doing"));
    labelField("doing").blur();
    fireEvent.keyDown(within(dialog()).getByTestId("stage-row-backlog"), {
      key: "Enter",
    });
    expect(document.activeElement).toBe(labelField("backlog"));
  });

  it("clicking a nested control does NOT run the row's own action", async () => {
    // The row's single affordance is "focus this Stage's label field" (Enter on a
    // focused row is the keyboard route to it). Every nested control stops its
    // click, so clicking the Skill trigger does not also steal focus into the label
    // field — the sessions-chip precedent in `TaskCard.tsx` is the same rule.
    renderEditor();
    fireEvent.click(within(row("done")).getByRole("button", { name: "Move done up" }));
    expect(document.activeElement).not.toBe(labelField("done"));
  });

  it("Enter inside a nested control does NOT leak into the row's Enter handler", async () => {
    // `RowButton` activates on Enter from its OWN key handler, and keydown BUBBLES
    // from every child — so an Enter pressed while a nested button is focused fires
    // that button AND the row, and the row's action moves focus into the label field
    // on top of whatever the button just did. (jsdom does not synthesise a `click`
    // from Enter on a `<button>`, so this asserts the LEAK and not the button's own
    // action — that is what every click case above pins.)
    renderEditor();
    const deleteButton = within(row("done")).getByRole("button", {
      name: "Delete done",
    });
    deleteButton.focus();
    fireEvent.keyDown(deleteButton, { key: "Enter" });
    expect(document.activeElement).toBe(deleteButton);
  });
});

/** `stage()` for a row that must keep its cards — the SEED's columns carry the
 *  cards the delete-picker cases need, and a case that re-spells a Stage's edges
 *  must not have to re-spell its cards too. */
function stage2(slug: string, over: Partial<StageRow> = {}): StageWithTasks {
  const base = SEED.find((c) => c.stage.slug === slug)!;
  return { ...base, stage: { ...base.stage, ...over } };
}
