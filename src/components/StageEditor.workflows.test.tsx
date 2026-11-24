import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import StageEditor from "./StageEditor";
import { useTasks } from "../store/tasks";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
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
  setStageAuto,
  setStagePromptPrefix,
  type AutoGuards,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";

/**
 * The workflow-graph controls in the Stage editor — the per-Column **Auto** switch
 * and **extra prompt** field (`stages/StageRow.tsx`) and the per-Space **auto-chain
 * guards** (`stages/AutoChainGuards.tsx`).
 *
 * WHY ITS OWN FILE, and why it mounts `StageEditor` rather than the two components.
 * `StageEditor.test.tsx` is the dialog's own suite and is not this task's file to
 * grow; more importantly, both subjects are only reachable THROUGH the dialog — the
 * guards are a footer sibling whose whole contract is "one `<div>`, as a sibling of
 * the scroller", and the row's controls only mean anything inside the `role="button"`
 * row they must not activate. Mounting the dialog pins both the control and its
 * placement. The store's behaviour behind them (revert-on-rejection, the whole-slice
 * rule) is pinned in `src/store/tasks.workflows.test.ts` and is NOT re-pinned here —
 * this file pins what a click and a keystroke ASK FOR, and what the field shows.
 *
 * THE BARREL MOCK, the two resets and the catalog-cache clears all follow
 * `StageEditor.test.tsx` for the reasons that file states: an un-mocked wrapper
 * reaches the real `invoke`, which rejects in jsdom, and the file then asserts on a
 * rejection instead of on the write; the catalog caches are MODULE-level, so the
 * first case to mount freezes whatever `listSkills` answered then.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    getBoardStrict: vi.fn(),
    // The four this file drives, under the WRAPPER names the store imports.
    setStageAuto: vi.fn(),
    setStagePromptPrefix: vi.fn(),
    getAutoGuards: vi.fn(),
    setAutoGuards: vi.fn(),
    // The four mention catalogs `useMentionCatalogs` mounts, plus the Skill catalog:
    // un-mocked they reach the real `invoke` and reject in jsdom.
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

/* All nine REQUIRED wire fields, defaulted to what an upgraded database holds: OFF
 * and prefix-free. `auto` is `NOT NULL DEFAULT 0` on the column, so a fixture that
 * omitted it would be a board the database cannot answer with; `promptPrefix: null`
 * is the ONLY "no extra prompt" state, and a case that means the OTHER one — the
 * empty string, a stored VALUE a person typed — passes it through `over`. */
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

const SEED: StageWithTasks[] = [
  { stage: stage("backlog", { sortOrder: 0 }), tasks: [card("t1", 1, "backlog")] },
  { stage: stage("doing", { sortOrder: 1 }), tasks: [card("t2", 2, "doing")] },
];

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function row(slug: string): HTMLElement {
  return within(dialog()).getByTestId(`stage-row-${slug}`);
}

/** The row's Auto switch. Addressed by its accessible name, which is the point: an
 *  unnamed switch in a row that already holds four controls is not findable by a
 *  person either. */
function autoSwitch(slug: string): HTMLElement {
  return within(row(slug)).getByRole("switch", {
    name: `Auto-advance cards launched in ${slug}`,
  });
}

/** The row's extra-prompt field. */
function prefixField(slug: string): HTMLElement {
  return within(row(slug)).getByRole("textbox", {
    name: `Extra prompt for ${slug}`,
  });
}

/** One guard field, read off the dialog (footer siblings, not row children). A TEXT
 *  field with `inputMode="decimal"`, not a spinbutton — see the `type="number"` note in
 *  `AutoChainGuards.tsx`: a number input sanitizes garbage to `""` and `""` is the
 *  clear, so the field is deliberately not one. */
function guardField(name: string): HTMLElement {
  return within(dialog()).getByRole("textbox", { name });
}

function guardsClearButton(): HTMLElement {
  return within(dialog()).getByRole("button", {
    name: "Clear the auto-chain guards",
  });
}

/** The dialog's own error line, scoped to the dialog (the board's `IpcErrorLine` can
 *  be live at the same time in the real app). */
function errorLine(): HTMLElement | null {
  return within(dialog()).queryByRole("alert");
}

/* NO jest-dom in this repo's vitest setup, so the DOM facts are read off the nodes —
 * the three helpers `StageEditor.test.tsx` spells for the same reason. */
const valueOf = (el: HTMLElement): string => (el as HTMLInputElement).value;
const disabledOf = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled === true ||
  el.getAttribute("aria-disabled") === "true";
const checkedOf = (el: HTMLElement): { checked: boolean; disabled: boolean } => ({
  checked: el.getAttribute("aria-checked") === "true",
  disabled: (el as HTMLButtonElement).disabled === true,
});

/** Seed the store the way the board would and mount the dialog. */
function renderEditor(seed: StageWithTasks[] = SEED): void {
  useTasks.setState({ boardsBySpace: { [SPACE]: seed } });
  render(<StageEditor spacePath={SPACE} onClose={vi.fn()} />);
}

const slice = (): StageWithTasks[] =>
  useTasks.getState().boardsBySpace[SPACE] ?? [];
const stageOf = (slug: string): StageDto | undefined =>
  slice().find((c) => c.stage.slug === slug)?.stage;

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  for (const fn of [
    getBoard,
    getBoardStrict,
    setStageAuto,
    setStagePromptPrefix,
    getAutoGuards,
    setAutoGuards,
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
  // ECHO the arguments back, as the Rust side does: the store merges the answered row
  // over its optimistic guess, so a fixed row here would land on whichever column a
  // case edited and every "the field shows the stored value" assertion below would be
  // reading a fake row rather than the write.
  vi.mocked(setStageAuto).mockImplementation(async (_space, slug, auto) => ({
    ...stage(slug),
    auto,
  }));
  vi.mocked(setStagePromptPrefix).mockImplementation(
    async (_space, slug, promptPrefix) => ({ ...stage(slug), promptPrefix }),
  );
  vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: null, ceilingUsd: null });
  vi.mocked(setAutoGuards).mockResolvedValue(undefined);
});

describe("the Stage row's Auto switch", () => {
  it("shows the column's stored flag and is never inert (there is no unread state)", () => {
    // `auto` rides on the `StageDto` the row already holds, so unlike the Strict
    // Switch there is no read to seed and nothing to be inert about. A `disabled`
    // here would be a control that is dead for a reason that does not exist.
    renderEditor([
      { stage: stage("on", { slug: "on", auto: true }), tasks: [] },
      { stage: stage("off", { slug: "off", auto: false }), tasks: [] },
    ]);
    expect(checkedOf(autoSwitch("on"))).toEqual({ checked: true, disabled: false });
    expect(checkedOf(autoSwitch("off"))).toEqual({ checked: false, disabled: false });
  });

  it("clicking it writes the flag through the store", async () => {
    renderEditor();
    fireEvent.click(autoSwitch("doing"));
    await waitFor(() => expect(setStageAuto).toHaveBeenCalledWith(SPACE, "doing", true));
    await waitFor(() => expect(checkedOf(autoSwitch("doing")).checked).toBe(true));
  });

  it("clicking it does NOT run the row's own affordance (the row has exactly one)", () => {
    // The row's single affordance is "focus this Stage's label field", so every nested
    // control stops its own click — otherwise the click bubbles into the row and steals
    // focus out of the control the person just used (the routing rule
    // `StageEditor.test.tsx` pins as `one role per row, and who gets the click`).
    // Asserted on the LABEL, because `fireEvent.click` does not move focus in jsdom:
    // what a leaked click does is focus the label, so that is the fact to read. Dropping
    // any `onClick={stop}` in this row reddens this case and the Auto one beside it.
    renderEditor();
    fireEvent.click(prefixField("doing"));
    expect(document.activeElement).not.toBe(
      within(row("doing")).getByRole("textbox", { name: "Label for doing" }),
    );
    fireEvent.click(autoSwitch("doing"));
    expect(document.activeElement).not.toBe(
      within(row("doing")).getByRole("textbox", { name: "Label for doing" }),
    );
  });

  it("goes back to OFF when the write is refused (the store reverted the slice)", async () => {
    // The failure this row exists to avoid: a switch claiming a card will advance
    // itself when the runtime reads a stored flag that never changed. The row renders
    // the SLICE, and the store put the slice back.
    vi.mocked(setStageAuto).mockRejectedValue({
      kind: "not_found",
      message: "no such stage: doing",
    });
    renderEditor();
    fireEvent.click(autoSwitch("doing"));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("no such stage: doing"),
    );
    expect(checkedOf(autoSwitch("doing")).checked).toBe(false);
  });
});

describe("the Stage row's extra-prompt field", () => {
  it("shows the stored prefix, and the empty field for a column that has none", () => {
    renderEditor([
      { stage: stage("a", { slug: "a", promptPrefix: "Continue the chain." }), tasks: [] },
      { stage: stage("b", { slug: "b", promptPrefix: null }), tasks: [] },
    ]);
    expect(valueOf(prefixField("a"))).toBe("Continue the chain.");
    expect(valueOf(prefixField("b"))).toBe("");
  });

  it("commits on Enter", async () => {
    renderEditor();
    const field = prefixField("doing");
    fireEvent.change(field, { target: { value: "Run the checks first." } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(setStagePromptPrefix).toHaveBeenCalledWith(
        SPACE,
        "doing",
        "Run the checks first.",
      ),
    );
  });

  it("commits on blur (a field you have to LEAVE to apply is a field that lies)", () => {
    renderEditor();
    const field = prefixField("doing");
    fireEvent.change(field, { target: { value: "Draft it from the spec." } });
    fireEvent.blur(field);
    expect(setStagePromptPrefix).toHaveBeenCalledWith(
      SPACE,
      "doing",
      "Draft it from the spec.",
    );
  });

  it("Enter in the prompt field does NOT leak into the row's Enter handler", () => {
    // `RowButton` activates on Enter from its OWN handler and keydown BUBBLES from
    // every child, so an Enter pressed in this field would fire the field's commit AND
    // move focus into the label — on top of the action the key just performed. This is
    // the keydown half of the routing rule; the click half is the case above, and
    // dropping `stop(event)` from the field's `onKeyDown` reddens THIS one.
    renderEditor();
    const field = prefixField("doing");
    field.focus();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(document.activeElement).toBe(field);
    expect(document.activeElement).not.toBe(
      within(row("doing")).getByRole("textbox", { name: "Label for doing" }),
    );
  });

  it("sends `null` when the field is cleared, NOT the empty string", async () => {
    // THE clear. `""` is a stored VALUE a person typed and NULL is the only "no extra
    // prompt" state, so a UI that wrote `""` would make a prefix typed by mistake
    // permanent — the `set_stage_next` defect, one column over. The store-side half of
    // this is pinned in `tasks.workflows.test.ts`; this is the half that says which
    // value the FIELD puts on the wire.
    renderEditor([
      { stage: stage("doing", { promptPrefix: "Stale instruction." }), tasks: [] },
    ]);
    const field = prefixField("doing");
    expect(valueOf(field)).toBe("Stale instruction.");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(setStagePromptPrefix).toHaveBeenCalledWith(SPACE, "doing", null),
    );
    expect(stageOf("doing")?.promptPrefix).toBeNull();
  });

  it("writes nothing when the field was never touched (blur fires on every click away)", () => {
    // The commit runs on every blur, and a blur happens on every click elsewhere in
    // the dialog — so an ungated commit would rewrite every column's prefix as the
    // user worked. The same gate `commitLabel` carries.
    renderEditor();
    fireEvent.blur(prefixField("doing"));
    fireEvent.blur(prefixField("backlog"));
    expect(setStagePromptPrefix).toHaveBeenCalledTimes(0);
  });

  it("keeps a stored empty-string prefix distinguishable from a clear on screen", () => {
    // `""` is a stored VALUE the database can hold and `null` is the clear, and the
    // read tells them apart (`""` round-trips as `""`). The field renders both as
    // empty — they contribute the same text to a launch — so this pins the half that
    // is NOT a UI choice: the store still holds the distinction after a mount, and a
    // `?? ""` in the read or the paint would erase it before anyone could see it.
    renderEditor([
      { stage: stage("empty", { slug: "empty", promptPrefix: "" }), tasks: [] },
      { stage: stage("cleared", { slug: "cleared", promptPrefix: null }), tasks: [] },
    ]);
    expect(valueOf(prefixField("empty"))).toBe("");
    expect(stageOf("empty")?.promptPrefix).toBe("");
    expect(stageOf("cleared")?.promptPrefix).toBeNull();
  });

  it("stays silent when a stored empty prefix is blurred untouched", () => {
    // The one consequence of "empty field = clear" that is worth a case: a column whose
    // stored prefix is `""` shows an empty field, and blurring it must NOT fire a write
    // (there is nothing to change and the blur gate is what says so). What DOES happen,
    // in the case below this one, is that editing it away and back to empty clears it to
    // `null` — the launcher's own answer either way, since it prepends `""` and NULL
    // identically. Pinned here so the behaviour is a decision and not an accident.
    renderEditor([
      { stage: stage("doing", { promptPrefix: "" }), tasks: [] },
    ]);
    const field = prefixField("doing");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(setStagePromptPrefix).toHaveBeenCalledTimes(0);
  });

  it("commits an empty field over a stored `\"\"` as the `null` clear", async () => {
    // The consequence of "empty field = clear", stated as what it DOES: typing a
    // character and deleting it again on a column whose stored prefix is `""` sends
    // `null`. `""` is unreachable FROM this dialog on purpose — the only way to store
    // one is to write it from outside — and the clear is the state the launcher treats
    // identically, so the dialog converges on the one spelling it can send.
    renderEditor([
      { stage: stage("doing", { promptPrefix: "" }), tasks: [] },
    ]);
    const field = prefixField("doing");
    fireEvent.change(field, { target: { value: "x" } });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(setStagePromptPrefix).toHaveBeenCalledWith(SPACE, "doing", null),
    );
  });

  it("writes nothing when the text is unchanged from the stored prefix", () => {
    renderEditor([
      { stage: stage("doing", { promptPrefix: "Same." }), tasks: [] },
    ]);
    const field = prefixField("doing");
    fireEvent.change(field, { target: { value: "Same." } });
    fireEvent.blur(field);
    expect(setStagePromptPrefix).toHaveBeenCalledTimes(0);
  });

  it("falls back to the stored prefix when the write is refused", async () => {
    vi.mocked(setStagePromptPrefix).mockRejectedValue({
      kind: "other",
      message: "could not write the stage row",
    });
    renderEditor();
    const field = prefixField("doing");
    fireEvent.change(field, { target: { value: "typo" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("could not write the stage row"),
    );
    // The draft is cleared on commit, so the field re-shows what the database holds —
    // "what is on screen is what the database holds", the rule a refused rename follows.
    expect(valueOf(prefixField("doing"))).toBe("");
    expect(stageOf("doing")?.promptPrefix).toBeNull();
  });
});

describe("the Space-level auto-chain guards", () => {
  it("reads the pair on mount and seeds the two fields with it", async () => {
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderEditor();
    await waitFor(() => expect(getAutoGuards).toHaveBeenCalledWith(SPACE));
    await waitFor(() => expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"));
    expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5");
  });

  it("shows EMPTY fields for an unconfigured Space, and names the fallback in the caption", async () => {
    // The fields do NOT show the shipped defaults: the read reports the stored pair
    // and never substitutes, and displaying `20`/`10.0` would make an inherited bound
    // look like one the person chose. The caption carries the fallback instead, cited
    // by constant NAME so this file cannot drift from the value the runtime applies.
    renderEditor();
    await waitFor(() => expect(getAutoGuards).toHaveBeenCalledWith(SPACE));
    expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("");
    expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("");
    const caption = within(dialog()).getByText(/DEFAULT_AUTO_MAX_STEPS/);
    expect(caption.textContent).toContain("DEFAULT_AUTO_CEILING_USD");
    // And the ceiling's blind spot is stated, not omitted: `cost_usd` NULL means
    // "never reported", not "free" (ADR 0082), so a chain of NULL costs looks free.
    expect(caption.textContent).toMatch(/never report one looks free/i);
  });

  it("is inert while the pair is unread, and does not write from that state", async () => {
    // An empty field over a Space that HAS a bound reads as "unset", and the two are
    // different answers — so the fields are inert until the read lands, exactly as the
    // Strict Switch is inert until its flag is known.
    let release: (v: AutoGuards) => void = () => {};
    vi.mocked(getAutoGuards).mockReturnValue(
      new Promise<AutoGuards>((resolve) => {
        release = resolve;
      }),
    );
    renderEditor();
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
    renderEditor();
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
    renderEditor();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), { target: { value: "9" } });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() =>
      expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 9, 2.5),
    );
  });

  it("commits a typed ceiling, keeping the step bound it did not touch", async () => {
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderEditor();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain USD ceiling"))).toBe("2.5"),
    );
    fireEvent.change(guardField("Auto-chain USD ceiling"), { target: { value: "4" } });
    fireEvent.blur(guardField("Auto-chain USD ceiling"));
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 5, 4));
  });

  it("commits on Enter as well as on blur", async () => {
    renderEditor();
    await waitFor(() =>
      expect(disabledOf(guardField("Auto-chain maximum steps"))).toBe(false),
    );
    const field = guardField("Auto-chain maximum steps");
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 3, null));
  });

  it("clearing a field sends `null` for that guard and keeps the other", async () => {
    // THE clear, per guard. `null` = not configured → the shipped fallback, which is
    // NOT unlimited and NOT `0`. The other guard travels unchanged, because the write
    // is one statement over both columns.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderEditor();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), { target: { value: "" } });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, null, 2.5));
  });

  it("the Clear button sends `null` for BOTH — which is not `0` for both", async () => {
    // The third arm, and the one most likely to be "simplified" into the second:
    // `0`/`0.0` means "no auto-chaining, no spend" (a bound a person chose), while
    // `null`/`null` means "back to the shipped defaults". Both are reachable here, and
    // they must not share a code path.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderEditor();
    await waitFor(() => expect(disabledOf(guardsClearButton())).toBe(false));
    fireEvent.click(guardsClearButton());
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, null, null));
  });

  it("a typed `0` writes `0`, not the clear", async () => {
    // The other half of the same distinction, seen from the field: `0` is a decision
    // and has to survive the parse. `Number("")` is `0`, which is why the empty test
    // comes FIRST in the parse — this case is what would go red if it did not.
    renderEditor();
    await waitFor(() =>
      expect(disabledOf(guardField("Auto-chain maximum steps"))).toBe(false),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), { target: { value: "0" } });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() => expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 0, null));
  });

  it("unparseable text writes NOTHING and the field falls back to the stored value", async () => {
    // The reason the field is NOT `type="number"`: a number input sanitizes `"abc"` to
    // `""` before any handler runs, and `""` here is the CLEAR — a stray keystroke
    // would drop the Space's spend bound silently. As a text field the raw text reaches
    // the parse, the parse refuses it, and NOTHING is written.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderEditor();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    const field = guardField("Auto-chain maximum steps");
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.blur(field);
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
    expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5");
  });

  it("a negative bound is refused rather than written", async () => {
    // `Db::set_auto_guards` stores whatever it is handed and names sanity as the
    // EDITOR's question, so a `-5` would land a bound no chain can satisfy — the
    // runtime reads that as "stop immediately", i.e. the off switch reached by typing a
    // minus sign. The ceiling's `NULL` ≠ `0.0` argument runs the same way: a value that
    // means something the person did not intend is worse than refusing the keystroke.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 5, ceilingUsd: 2.5 });
    renderEditor();
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
    // `setAutoGuards` captures its failure into `error` and does NOT rethrow (the
    // `setBoardStrict` shape), so without a re-read the field would keep the number
    // the person typed over a Space that never stored it.
    vi.mocked(getAutoGuards)
      .mockResolvedValueOnce({ maxSteps: 5, ceilingUsd: 2.5 })
      .mockResolvedValueOnce({ maxSteps: 5, ceilingUsd: 2.5 });
    vi.mocked(setAutoGuards).mockRejectedValue({
      kind: "command",
      message: "could not write the Space row",
    });
    renderEditor();
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    fireEvent.change(guardField("Auto-chain maximum steps"), { target: { value: "99" } });
    fireEvent.blur(guardField("Auto-chain maximum steps"));
    await waitFor(() =>
      expect(errorLine()?.textContent).toContain("could not write the Space row"),
    );
    await waitFor(() =>
      expect(valueOf(guardField("Auto-chain maximum steps"))).toBe("5"),
    );
    expect(getAutoGuards).toHaveBeenCalledTimes(2);
  });

  it("an unchanged pair writes nothing (blur fires on every click elsewhere)", () => {
    renderEditor();
    const field = guardField("Auto-chain USD ceiling");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(setAutoGuards).toHaveBeenCalledTimes(0);
  });
});
