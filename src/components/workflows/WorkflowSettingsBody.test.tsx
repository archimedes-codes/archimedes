import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { NodeSettingsPanel } from "./NodeSettingsPanel";
import { useTasks } from "../../store/tasks";
import { resetStores } from "../../test/resetStores";
import { clearSkillCatalogCache } from "../../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../../hooks/useMentionCatalogs";
import {
  createStage,
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
  type AutoGuards,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../../lib/tauri";

/**
 * The WORKFLOW mode of the settings panel — the per-Space subjects the panel shows
 * when nothing is selected: the Strict-workflow switch, the auto-chain guard pair, and
 * the add-a-column field.
 *
 * ## THESE ARE THE GUARD AND SWITCH CASES THE BOARD'S STAGE DIALOG CARRIED, RE-PINNED
 *
 * The components moved by `git mv` and were not rewritten, so the assertions below are
 * the ones that dialog's suite carried — same needles, same arguments, same
 * expectations — with the mount changed from the dialog to `NodeSettingsPanel` in
 * workflow mode. That is the transfer the ledger in the commit body tracks: a behaviour
 * that lived under the dialog had to live under the panel before the dialog went, and
 * it is why deleting the dialog cost no coverage.
 *
 * ## THE BARREL MOCK, THE TWO RESETS AND THE CATALOG CACHES
 *
 * Same reasons `NodeSettingsBody.test.tsx` states at length: an un-mocked wrapper
 * reaches the real `invoke`, rejects in jsdom, and lands its sentence in the store's
 * `error` cell that this file's own error-line assertions read. `resetStores()` cannot
 * reach a module `let` and `useTasks` has one; the catalog caches are module-level, so
 * the first case to mount freezes whatever `listSkills` answered then.
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
    createStage: vi.fn(),
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
});

const SEED: StageWithTasks[] = [
  { stage: stage("backlog", { sortOrder: 0 }), tasks: [card("t1", 1, "backlog")] },
  { stage: stage("doing", { sortOrder: 1 }), tasks: [card("t2", 2, "doing")] },
];

function panel(): HTMLElement {
  return screen.getByTestId("workflow-settings-panel");
}

/** The panel's own error line, scoped to the panel. */
function errorLine(): HTMLElement | null {
  return within(panel()).queryByRole("alert");
}

/** A guard field. A TEXT field with `inputMode="decimal"`, NOT a spinbutton — see the
 *  `type="number"` note in `AutoChainGuards.tsx`: a number input sanitizes garbage to
 *  `""` and `""` is the clear, so the field is deliberately not one. */
function guardField(name: string): HTMLElement {
  return within(panel()).getByRole("textbox", { name });
}

const guardsClearButton = (): HTMLElement =>
  within(panel()).getByRole("button", { name: "Clear the auto-chain guards" });

const strictSwitch = (): HTMLElement =>
  within(panel()).getByRole("switch", { name: "Strict workflow" });

/* NO jest-dom in this repo's vitest setup, so the DOM facts are read off the nodes —
 * the dialog's suite spelled, for the same reason. */
const valueOf = (el: HTMLElement): string => (el as HTMLInputElement).value;
const disabledOf = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled === true ||
  el.getAttribute("aria-disabled") === "true";
const checkedOf = (el: HTMLElement): { checked: boolean; disabled: boolean } => ({
  checked: el.getAttribute("aria-checked") === "true",
  disabled: (el as HTMLButtonElement).disabled === true,
});

/** Mount the panel in WORKFLOW mode (nothing selected). */
function renderWorkflow(seed: StageWithTasks[] = SEED): void {
  useTasks.setState({ boardsBySpace: { [SPACE]: seed } });
  render(<NodeSettingsPanel spacePath={SPACE} stageSlug={null} />);
}

const slice = (): StageWithTasks[] =>
  useTasks.getState().boardsBySpace[SPACE] ?? [];

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
    createStage,
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
  // The guard fields need a RESOLVED pair, not a bare `vi.fn()`: the component chains
  // `.then` on the store action and an `undefined` return would throw inside the mount
  // effect rather than leaving the fields inert. An unconfigured pair is the honest
  // default — it is what a Space that never opened this editor answers.
  vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: null, ceilingUsd: null });
  vi.mocked(setAutoGuards).mockResolvedValue(undefined);
  vi.mocked(setStageAuto).mockImplementation(async (_space, slug, auto) => ({
    ...stage(slug),
    auto,
  }));
  vi.mocked(setStagePromptPrefix).mockImplementation(
    async (_space, slug, promptPrefix) => ({ ...stage(slug), promptPrefix }),
  );
  vi.mocked(createStage).mockImplementation(async (_space, label) => ({
    ...stage(label.toLowerCase()),
    label,
    sortOrder: 3,
  }));
});

describe("the workflow panel's Strict workflow switch", () => {
  it("is DISABLED while the read is in flight, and shows the value once it lands", async () => {
    // A Switch painted `off` is a CLAIM about the Space and the Space has not answered
    // yet. Disabled is the only state that is not a guess, and it is why the panel reads
    // the flag instead of defaulting it — the value must be the one `moveTask` enforces.
    let release: (v: boolean) => void = () => {};
    vi.mocked(getBoardStrict).mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    renderWorkflow();
    expect(checkedOf(strictSwitch()).disabled).toBe(true);
    release(true);
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(true));
    expect(checkedOf(strictSwitch()).disabled).toBe(false);
  });

  it("answers off for a Space that never opted in, and is usable", async () => {
    renderWorkflow();
    await waitFor(() => expect(getBoardStrict).toHaveBeenCalledWith(SPACE));
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    expect(checkedOf(strictSwitch()).disabled).toBe(false);
  });

  it("toggling writes the flag through the store", async () => {
    renderWorkflow();
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    fireEvent.click(strictSwitch());
    await waitFor(() =>
      expect(setBoardStrict).toHaveBeenCalledWith(SPACE, true),
    );
  });

  it("re-reads the flag after the write, so the Switch never shows a value the Space refused", async () => {
    // `setBoardStrict` captures its failure into `error` and does NOT rethrow (the
    // `moveTask` shape), so without the re-read a refused toggle would leave the Switch
    // claiming Strict over a board whose drags are all accepted.
    vi.mocked(getBoardStrict)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    vi.mocked(setBoardStrict).mockRejectedValue({
      kind: "command",
      message: "could not write the Space row",
    });
    renderWorkflow();
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    fireEvent.click(strictSwitch());
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("could not write the Space row"),
    );
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    expect(getBoardStrict).toHaveBeenCalledTimes(2);
  });

  it("a FAILED read leaves the Switch disabled rather than defaulting it to off", async () => {
    vi.mocked(getBoardStrict).mockRejectedValue({
      kind: "command",
      message: "board_strict read failed",
    });
    renderWorkflow();
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("board_strict read failed"),
    );
    // `false` here would be a fact the panel invented: an off Switch over a Space that
    // IS strict means the person believes drags are bound when they are not.
    expect(checkedOf(strictSwitch()).disabled).toBe(true);
    expect(setBoardStrict).toHaveBeenCalledTimes(0);
  });

  it("explains what the flag does, in both positions", async () => {
    renderWorkflow();
    await waitFor(() => expect(checkedOf(strictSwitch()).checked).toBe(false));
    expect(panel().textContent).toContain("Any column can receive a card");
  });
});

describe("the workflow panel's auto-chain guards", () => {
  it("reads the pair on mount and seeds the two fields with it", async () => {
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() => expect(getAutoGuards).toHaveBeenCalledWith(SPACE));
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5");
  });

  it("shows EMPTY fields for an unconfigured Space, and names the fallback in the caption", async () => {
    // The fields do NOT show the shipped defaults: the read reports the stored pair and
    // never substitutes, and displaying `20`/`10.0` would make an inherited bound look
    // like one the person chose. The caption carries the fallback instead, cited BY
    // CONSTANT NAME so this file cannot drift from the value the runtime applies.
    renderWorkflow();
    await waitFor(() => expect(getAutoGuards).toHaveBeenCalledWith(SPACE));
    expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("");
    expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("");
    const caption = within(panel()).getByText(/DEFAULT_AUTO_MAX_STEPS/);
    expect(caption.textContent).toContain("DEFAULT_AUTO_CEILING_USD");
    // And the ceiling's blind spot is stated, not omitted: `cost_usd` NULL means "never
    // reported", not "free" (ADR 0082), so a chain of NULL costs looks free.
    expect(caption.textContent).toMatch(/never report one looks free/i);
  });

  it("is inert while the pair is unread, and does not write from that state", async () => {
    let release: (v: AutoGuards) => void = () => {};
    vi.mocked(getAutoGuards).mockReturnValue(
      new Promise<AutoGuards>((resolve) => {
        release = resolve;
      }),
    );
    renderWorkflow();
    expect(disabledOf(guardField("Auto-chain maximum steps"))).toBe(true);
    expect(disabledOf(guardsClearButton())).toBe(true);
    release({ maxSteps: 2, ceilingUsd: null });
    await waitFor(() =>
      expect(disabledOf(guardField("Auto-chain maximum steps"))).toBe(false),
    );
    expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("2");
  });

  it("a FAILED read leaves the fields inert rather than showing blanks as a fact", async () => {
    vi.mocked(getAutoGuards).mockRejectedValue({
      kind: "command",
      message: "auto_guards read failed",
    });
    renderWorkflow();
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("auto_guards read failed"),
    );
    expect(disabledOf(guardField("Auto-chain maximum steps"))).toBe(true);
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
  });

  it("commits a typed step bound, sending the PAIR", async () => {
    // One call for both fields, because the storage statement writes both columns and
    // has no "keep what is there" arm — so the untouched ceiling travels with the
    // edited steps rather than being cleared by omission.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), {
      target: { value: "9" },
    });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 9, 2.5));
  });

  it("commits a typed ceiling, keeping the step bound it did not touch", async () => {
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5"),
    );
    fireEvent.change(guardField("Auto-chain USD ceiling"), {
      target: { value: "4" },
    });
    fireEvent.blur(guardField("Auto-chain USD ceiling"));
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 5, 4));
  });

  it("commits on Enter as well as on blur", async () => {
    renderWorkflow();
    await waitFor(() =>
      expect(disabledOf(guardField("Auto-chain maximum steps"))).toBe(false),
    );
    const field = guardField("Auto-chain maximum steps");
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 3, null));
  });

  it("clearing a field sends `null` for that guard and keeps the other", async () => {
    // THE clear, per guard. `null` = not configured → the shipped fallback, which is NOT
    // unlimited and NOT `0`. The other guard travels unchanged.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), {
      target: { value: "" },
    });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, null, 2.5));
  });

  it("the Clear button sends `null` for BOTH — which is not `0` for both", async () => {
    // The third arm, and the one most likely to be "simplified" into the second:
    // `0`/`0.0` means "no auto-chaining, no spend" (a bound a person chose), while
    // `null`/`null` means "back to the shipped defaults".
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() => expect(disabledOf(guardsClearButton())).toBe(false));
    fireEvent.click(guardsClearButton());
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, null, null));
  });

  it("a typed `0` writes `0`, not the clear", async () => {
    // The other half of the same distinction, seen from the field: `0` is a decision and
    // has to survive the parse. `Number("")` is `0`, which is why the empty test comes
    // FIRST in the parse — this case is what would go red if it did not.
    renderWorkflow();
    await waitFor(() =>
      expect(disabledOf(guardField("Auto-chain maximum steps"))).toBe(false),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), {
      target: { value: "0" },
    });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 0, null));
  });

  it("unparseable text writes NOTHING and the field falls back to the stored value", async () => {
    // The reason the field is NOT `type="number"`: a number input sanitizes `"abc"` to
    // `""` before any handler runs, and `""` here is the CLEAR — a stray keystroke would
    // drop the Space's spend bound silently. As a text field the raw text reaches the
    // parse, the parse refuses it, and NOTHING is written.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    const field = guardField("Auto-chain maximum steps");
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.blur(field);
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
    expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5");
  });

  it("refuses `1e999`, which parses to Infinity and would serialize as null", async () => {
    // THE `Number.isFinite` CLAUSE, previously unpinned: dropping it left 23/23 green,
    // measured. `Number("1e999")` is `Infinity` — a perfectly good `number` to `Number()`,
    // and `Infinity >= 0` is true — so without the finiteness test the field ACCEPTS the
    // text and hands `Infinity` to `setAutoGuards`. That value cannot be serialized:
    // `JSON.stringify({ ceilingUsd: Infinity })` yields `{"ceilingUsd":null}`, so a person
    // typing `1e999` into the USD ceiling **silently clears the Space's spend bound**.
    //
    // That is precisely the failure this file's header says the text-field choice exists to
    // prevent — "a stray keystroke into clearing the Space's spend bound, silently — the one
    // confusion of `null` and garbage this whole component exists to refuse" — arriving
    // through the parse instead of through `type="number"`. A bound typed as "more than any
    // number" must read as garbage and write nothing, not as `null` and read as "unset".
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5"),
    );
    const ceiling = guardField("Auto-chain USD ceiling");
    fireEvent.change(ceiling, { target: { value: "1e999" } });
    fireEvent.blur(ceiling);
    // Nothing written — and specifically nothing written as a CLEAR.
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
    expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5");

    // The step field takes the same refusal (one parse, two fields), and `1e999` there would
    // clear `maxSteps` exactly as it clears the ceiling above.
    const steps = guardField("Auto-chain maximum steps");
    fireEvent.change(steps, { target: { value: "1e999" } });
    fireEvent.blur(steps);
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
    expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5");
  });

  it("a negative bound is refused rather than written", async () => {
    // `Db::set_auto_guards` stores whatever it is handed and names sanity as the
    // EDITOR's question, so a `-5` would land a bound no chain can satisfy — the runtime
    // reads that as "stop immediately", i.e. the off switch reached by typing a minus.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5"),
    );
    const field = guardField("Auto-chain USD ceiling");
    fireEvent.change(field, { target: { value: "-1" } });
    fireEvent.blur(field);
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
    expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5");
  });

  it("re-reads the pair after a write, so the fields never show a value the Space refused", async () => {
    vi.mocked(getAutoGuards)
      .mockResolvedValueOnce({ maxSteps: 5, ceilingUsd: 2.5 })
      .mockResolvedValueOnce({ maxSteps: 5, ceilingUsd: 2.5 });
    vi.mocked(setAutoGuards).mockRejectedValue({
      kind: "command",
      message: "could not write the Space row",
    });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), {
      target: { value: "99" },
    });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("could not write the Space row"),
    );
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    expect(getAutoGuards).toHaveBeenCalledTimes(2);
  });

  it("an unchanged pair writes nothing (blur fires on every click elsewhere)", async () => {
    // THE EQUALITY GATE, previously unreachable. This case used to be synchronous and did
    // not await `getAutoGuards`, so `commit` ran while `guards` was still `null` and exited
    // on the `guards === null` early return BEFORE the comparison. Deleting the whole
    // `next.maxSteps === guards.maxSteps && next.ceilingUsd === guards.ceilingUsd` block
    // left 23/23 green, measured — the pin was guarding a line the test never reached.
    //
    // Two things are therefore fixed here: the read is awaited, and the text is
    // edit-then-revert rather than a typed `""`. A typed `""` against a LOADED pair is not an
    // unchanged pair at all — it is the clear of one field, and it correctly writes. The
    // unchanged pair is a draft that parses back to the stored value.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderWorkflow();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5"),
    );
    const ceiling = guardField("Auto-chain USD ceiling");
    fireEvent.change(ceiling, { target: { value: "2.75" } });
    fireEvent.change(ceiling, { target: { value: "2.5" } });
    fireEvent.blur(ceiling);
    // Give any (wrongly) issued write the tick it needs to land before the count is read —
    // an un-awaited `await setAutoGuards(…)` would otherwise be invisible to `toHaveBeenCalledTimes`.
    await act(async () => {
      await Promise.resolve();
    });
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
    // And a CHANGED pair from the same field still writes, so the refusal above is the
    // equality gate deciding and not a control that has stopped working.
    fireEvent.change(ceiling, { target: { value: "2.75" } });
    fireEvent.blur(ceiling);
    await waitFor(() =>
      expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 5, 2.75),
    );
  });
});

describe("the workflow panel's add-a-column field", () => {
  it("a new label appends a column through the store", async () => {
    renderWorkflow();
    fireEvent.change(within(panel()).getByRole("textbox", { name: "New column label" }), {
      target: { value: "Spike" },
    });
    fireEvent.click(
      within(panel()).getByRole("button", { name: "Add column" }),
    );
    await waitFor(() =>
      expect(createStage).toHaveBeenCalledWith(SPACE, "Spike", undefined),
    );
    expect(slice().map((c) => c.stage.slug)).toContain("spike");
  });

  it("an empty label offers no write (a column nobody named is a column nobody can rename)", () => {
    renderWorkflow();
    const add = within(panel()).getByRole("button", { name: "Add column" });
    expect(disabledOf(add)).toBe(true);
    fireEvent.click(add);
    expect(createStage).toHaveBeenCalledTimes(0);
  });

  it("a colliding label is REFUSED and not suffixed, and the draft survives", async () => {
    // T1 refuses a collision rather than inventing `spike-2` — a slug nobody typed. The
    // panel's half of that rule is to surface the refusal and add nothing.
    vi.mocked(createStage).mockRejectedValue({
      kind: "not_found",
      message: "stage backlog is taken by Backlog",
    });
    renderWorkflow();
    const field = within(panel()).getByRole("textbox", { name: "New column label" });
    fireEvent.change(field, { target: { value: "Backlog" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Add column" }));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("stage backlog is taken"),
    );
    expect(slice()).toHaveLength(2);
    // The draft survives the refusal — the person typed a label and the app should not
    // have thrown it away because the SLUG was taken.
    expect(
      valueOf(within(panel()).getByRole("textbox", { name: "New column label" })),
    ).toBe("Backlog");
  });
});
