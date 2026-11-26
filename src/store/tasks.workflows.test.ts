import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTasks } from "./tasks";
import {
  getAutoGuards,
  getBoard,
  setAutoGuards,
  setStageAuto,
  setStagePromptPrefix,
  type AutoGuards,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";
import { resetStores } from "../test/resetStores";

/**
 * `src/store/tasks.ts` — the FOUR workflow-graph actions, and the two `StageDto`
 * fields they ride on.
 *
 * WHY ITS OWN FILE rather than more cases in `src/store/tasks.test.ts`: that file is
 * BASELINED at its exact code-line count in `scripts/file-size-baseline-test.txt`
 * (1066), and the size ratchet refuses a baselined file growing by even one code
 * line. The ratchet's own rule is that a rise needs a `--update` diff someone
 * justifies, and a new subject's worth of tests is exactly the growth that
 * `--update` exists to record — so the honest route is a sibling file, not a dodge.
 * What it shares with the file it sits beside is the shape, not the bytes.
 *
 * THE BARREL MOCK IS THE WHOLE POINT OF THE SHAPE (the note in `tasks.test.ts`
 * states the rule this file obeys). It mocks the barrel by path and SPREADS
 * `vi.importActual`, overriding the CAMELCASE WRAPPER NAMES, because those are what
 * the store imports. Mocking the snake_case Rust command names would leave the real
 * wrapper live, and the real wrapper calls `invoke`, which rejects in jsdom — the
 * file would then pin a rejection instead of the write.
 *
 * TWO RESETS in `beforeEach`, both load-bearing: `resetStores()` (whose `ALL_STORES`
 * holds `useTasks`) restores the STATE half, and `useTasks.getState().reset()` is the
 * only thing that reaches this store's module-`let` (`loadEpoch`), which
 * `resetStores.ts` documents it cannot touch. Dropping either hands the next case a
 * dirty board, and the suite's green depends on file order.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    // The four this file drives. A name the store awaits that this factory does not
    // list resolves to the REAL wrapper, which calls `invoke` and rejects in jsdom —
    // the noisy-green case the header above is about.
    setStageAuto: vi.fn(),
    setStagePromptPrefix: vi.fn(),
    getAutoGuards: vi.fn(),
    setAutoGuards: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures (local, as in `tasks.test.ts` — `src/test/fixtures/` is not this
// task's file to extend).
// ---------------------------------------------------------------------------

const SPACE = "/w/alpha";

/* All NINE wire fields are defaulted, because all nine are REQUIRED on `StageDto`:
 * the Rust side emits `auto` on every row (`NOT NULL DEFAULT 0`) and answers
 * `promptPrefix` whether or not anyone configured it. The defaults are what every
 * pre-workflow column holds — OFF and NULL — so a case that says nothing about the
 * two is describing the board as it shipped before this feature. Defaults sit BEFORE
 * the spread so `over` wins, and `promptPrefix: ""` is reachable through `over`
 * because `""` is a stored VALUE a person typed, not a clear (ADR 0082's neighbour). */
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

/** A three-column board, all OFF and prefix-free — the state an upgraded database is
 *  in the moment the two gates land and before anyone opens the editor. */
const board = (): StageWithTasks[] => [
  { stage: stage("backlog", { sortOrder: 0 }), tasks: [card("t1", 1, "backlog")] },
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

/** The two guards as an unconfigured Space answers them. */
const UNSET: AutoGuards = { maxSteps: null, ceilingUsd: null };

beforeEach(async () => {
  resetStores();
  useTasks.getState().reset();
  for (const fn of [
    getBoard,
    setStageAuto,
    setStagePromptPrefix,
    getAutoGuards,
    setAutoGuards,
  ]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(getBoard).mockResolvedValue(board());
  // The two Stage writes answer the STORED row and the store merges that row back
  // over its optimistic guess, so these defaults ECHO their arguments the way the
  // Rust side does. A fixed row here would be merged onto whichever column a case
  // edited, and every "the slice agrees with the write" assertion below would be
  // reading a fake row rather than the command's answer.
  vi.mocked(setStageAuto).mockImplementation(async (_space, slug, auto) => ({
    ...stage(slug),
    auto,
  }));
  vi.mocked(setStagePromptPrefix).mockImplementation(
    async (_space, slug, promptPrefix) => ({
      ...stage(slug),
      promptPrefix,
    }),
  );
  // A Space that never opened the guard editor. A case wanting a configured pair
  // installs its own — an all-`null` default is the honest seed, not a convenience.
  vi.mocked(getAutoGuards).mockResolvedValue(UNSET);
  vi.mocked(setAutoGuards).mockResolvedValue(undefined);
  await useTasks.getState().load(SPACE);
});

/** One column's `stage`, read out of the slice the store holds. */
const stageOf = (slug: string): StageDto | undefined =>
  (useTasks.getState().boardsBySpace[SPACE] ?? []).find(
    (c) => c.stage.slug === slug,
  )?.stage;

describe("the two workflow fields survive a board read (the wire mirror is real)", () => {
  it("carries `auto` and `promptPrefix` from the read onto the column", async () => {
    // THE MIRROR CASE, and it is about the WIRE rather than about a widget: a board
    // read whose rows say "this column auto-advances, and it prepends this text" has
    // to arrive saying so. `auto` is REQUIRED on the type precisely because
    // `stages.auto` is `NOT NULL DEFAULT 0` — a fixture that could omit it would
    // compile against a board the database cannot answer with, which is the
    // silent-green shape the frozen-key pins in `tasks.test.ts` exist to refuse.
    vi.mocked(getBoard).mockResolvedValue([
      {
        stage: stage("doing", { auto: true, promptPrefix: "Continue the chain." }),
        tasks: [],
      },
    ]);
    await useTasks.getState().load(SPACE);
    expect(stageOf("doing")).toMatchObject({
      auto: true,
      promptPrefix: "Continue the chain.",
    });
  });

  it("keeps `promptPrefix: null` distinct from `\"\"` across the read", async () => {
    // NULL is the ONLY "no extra prompt" state and `""` is a stored VALUE, so the
    // store must not fold them together on the way in — a `?? ""` here would make an
    // unconfigured column indistinguishable from one someone cleared by typing a
    // space, and the editor could no longer show the difference.
    vi.mocked(getBoard).mockResolvedValue([
      { stage: stage("a", { promptPrefix: null }), tasks: [] },
      { stage: stage("b", { promptPrefix: "" }), tasks: [] },
    ]);
    await useTasks.getState().load(SPACE);
    expect(stageOf("a")?.promptPrefix).toBeNull();
    expect(stageOf("b")?.promptPrefix).toBe("");
  });

  it("seeds every seeded column OFF and prefix-free (the compatibility story)", () => {
    // `auto`'s DDL default is OFF, and that is the whole compatibility argument:
    // adding the capability must not make an existing board advance anything. If a
    // fixture or a reader ever turned these to `true`, this is the case that says so.
    expect(
      (useTasks.getState().boardsBySpace[SPACE] ?? []).map((c) => [
        c.stage.auto,
        c.stage.promptPrefix,
      ]),
    ).toEqual([
      [false, null],
      [false, null],
      [false, null],
    ]);
  });
});

describe("useTasks.setStageAuto", () => {
  it("paints the flag on the column it names and nowhere else", async () => {
    await expect(useTasks.getState().setStageAuto(SPACE, "doing", true)).resolves
      .toBeTruthy();
    expect(setStageAuto).toHaveBeenCalledWith(SPACE, "doing", true);
    expect(stageOf("doing")?.auto).toBe(true);
    // The other two columns are the SAME OBJECTS the load published — a Stage write
    // patches one column and republishes the slice, it does not rebuild every row.
    expect(stageOf("backlog")?.auto).toBe(false);
    expect(stageOf("done")?.auto).toBe(false);
  });

  it("paints the flag BEFORE the command resolves (the optimistic half)", async () => {
    // The paint and the await are separable, and this is the case that separates
    // them: a store that awaited first would show a Switch that lagged every click by
    // a round trip, and would pass every other case in this file.
    let release: (row: StageDto) => void = () => {};
    vi.mocked(setStageAuto).mockReturnValue(
      new Promise<StageDto>((resolve) => {
        release = resolve;
      }),
    );
    const inflight = useTasks.getState().setStageAuto(SPACE, "backlog", true);
    expect(stageOf("backlog")?.auto).toBe(true);
    expect(useTasks.getState().error).toBeNull();
    release(stage("backlog", { auto: true }));
    await inflight;
    expect(stageOf("backlog")?.auto).toBe(true);
  });

  it("puts the slice back EXACTLY as it was and says why, on rejection", async () => {
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(setStageAuto).mockRejectedValue({
      kind: "not_found",
      message: "no such stage: nope",
    });
    // Rethrown: this action answers the stored `StageDto` and a refusal has not one
    // to hand back (the `renameStage`/`setStageSkill` rule).
    await expect(
      useTasks.getState().setStageAuto(SPACE, "nope", true),
    ).rejects.toBeTruthy();
    // `toBe`, not `toEqual`: the revert restores the captured slice rather than a
    // re-derived lookalike, because `get_board` seeds stage rows on read and a
    // refetch would be a WIDER mutation than the one being undone.
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(useTasks.getState().error).toBe("no such stage: nope");
  });

  it("writes an unloaded Space anyway and paints nothing", async () => {
    // The Stage-write rule `tasks.test.ts` pins for `renameStage` and does NOT re-pin
    // here: the command is the truth either way, so an absent slice costs the PAINT
    // and not the WRITE, and refusing would make the Switch silently dead for one
    // frame. One case here keeps the rule true for the new verb.
    useTasks.getState().reset();
    vi.mocked(setStageAuto).mockResolvedValue(stage("backlog", { auto: true }));
    const row = await useTasks.getState().setStageAuto(SPACE, "backlog", true);
    expect(setStageAuto).toHaveBeenCalledWith(SPACE, "backlog", true);
    expect(row.auto).toBe(true);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBeUndefined();
    expect(useTasks.getState().error).toBeNull();
  });
});

describe("useTasks.setStagePromptPrefix", () => {
  it("paints the prefix on the column it names", async () => {
    await useTasks.getState().setStagePromptPrefix(SPACE, "doing", "Run the checks first.");
    expect(setStagePromptPrefix).toHaveBeenCalledWith(
      SPACE,
      "doing",
      "Run the checks first.",
    );
    expect(stageOf("doing")?.promptPrefix).toBe("Run the checks first.");
    expect(stageOf("backlog")?.promptPrefix).toBeNull();
  });

  it("paints the EMPTY string as the value it is, not as a clear", async () => {
    // The one place the two states could be collapsed inside the store. `""` is what
    // a person typed and the database will hold `""`, so the paint has to show `""` —
    // painting `null` would be the slice claiming a clear the write did not perform.
    await useTasks.getState().setStagePromptPrefix(SPACE, "doing", "");
    expect(setStagePromptPrefix).toHaveBeenCalledWith(SPACE, "doing", "");
    expect(stageOf("doing")?.promptPrefix).toBe("");
  });

  it("sends `null` on a clear and leaves the stored state NULL", async () => {
    // `null` is the ONLY spelling of "no extra prompt", and this is the call the
    // editor's cleared field makes. Normalizing it to `""` anywhere in the action
    // would make a prefix typed by mistake PERMANENT — the exact defect
    // `set_stage_next`'s plain slice is on the record for.
    vi.mocked(setStagePromptPrefix).mockResolvedValue(
      stage("doing", { promptPrefix: null }),
    );
    await useTasks.getState().setStagePromptPrefix(SPACE, "doing", null);
    expect(setStagePromptPrefix).toHaveBeenCalledWith(SPACE, "doing", null);
    expect(stageOf("doing")?.promptPrefix).toBeNull();
  });

  it("reverts the prefix and says why, on rejection", async () => {
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(setStagePromptPrefix).mockRejectedValue({
      kind: "other",
      message: "could not write the stage row",
    });
    await expect(
      useTasks.getState().setStagePromptPrefix(SPACE, "doing", "typo"),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(stageOf("doing")?.promptPrefix).toBeNull();
    expect(useTasks.getState().error).toBe("could not write the stage row");
  });
});

describe("useTasks.getAutoGuards / useTasks.setAutoGuards (per-Space, not per-column)", () => {
  it("reads the stored pair back UNCHANGED, `null`s included", async () => {
    // No fallback substituted on the way through: the runtime applies the shipped
    // defaults, the read reports the STORED state, and that separation is what lets
    // the editor tell "unset" from "set to 20". A store that filled in `20` here
    // would make an inherited bound look like a chosen one.
    vi.mocked(getAutoGuards).mockResolvedValue({ maxSteps: 3, ceilingUsd: null });
    await expect(useTasks.getState().getAutoGuards(SPACE)).resolves.toEqual({
      maxSteps: 3,
      ceilingUsd: null,
    });
    expect(getAutoGuards).toHaveBeenCalledWith(SPACE);
  });

  it("writes the pair verbatim, keeping `null` distinct from `0`", async () => {
    // The three-way distinction the whole guard rests on, at the one seam the UI
    // writes through: `0` is a bound a person chose, `null` is a clear to the shipped
    // fallback. A `?? 0` or a `|| null` in the action turns one into the other.
    await useTasks.getState().setAutoGuards(SPACE, 0, null);
    expect(setAutoGuards).toHaveBeenCalledWith(SPACE, 0, null);
    await useTasks.getState().setAutoGuards(SPACE, null, 0);
    expect(setAutoGuards).toHaveBeenCalledWith(SPACE, null, 0);
    await useTasks.getState().setAutoGuards(SPACE, null, null);
    expect(setAutoGuards).toHaveBeenCalledWith(SPACE, null, null);
    expect(useTasks.getState().error).toBeNull();
  });

  it("captures a failed write into `error` and does NOT rethrow", async () => {
    // The `setBoardStrict` shape, deliberately: this action answers `void`, so on a
    // refusal there is nothing to hand back and the `error` line is the whole report.
    // The component that owns the field re-reads afterwards rather than catching.
    vi.mocked(setAutoGuards).mockRejectedValue({
      kind: "command",
      message: "could not write the Space row",
    });
    await expect(
      useTasks.getState().setAutoGuards(SPACE, 5, 1.5),
    ).resolves.toBeUndefined();
    expect(useTasks.getState().error).toBe("could not write the Space row");
  });

  it("writes no board slice at all — the guards are not per-column", async () => {
    // The slice is the SAME reference before and after. The guards live on the
    // `spaces` row and change no column, so a paint here would make this store a
    // second owner of one fact — and would re-render every Stage row for a write that
    // says nothing about any column.
    const before = useTasks.getState().boardsBySpace[SPACE];
    await useTasks.getState().setAutoGuards(SPACE, 7, 2.5);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(before);
  });

  it("rethrows a failed read rather than answering an all-`null` pair", async () => {
    // An all-`null` pair is a FACT ("nothing configured, so the shipped bound
    // governs"), and a swallowed failure that returned it would print two empty
    // fields over a Space that HAS a ceiling — the field-claiming-a-value-the-Space-
    // refused failure, one control over from the Strict Switch's own version of it.
    vi.mocked(getAutoGuards).mockRejectedValue({
      kind: "command",
      message: "auto_guards read failed",
    });
    await expect(useTasks.getState().getAutoGuards(SPACE)).rejects.toBeTruthy();
    expect(useTasks.getState().error).toBe("auto_guards read failed");
  });
});
