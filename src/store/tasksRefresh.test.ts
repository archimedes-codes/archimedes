import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTasks } from "./tasks";
import {
  getBoard,
  setStagePosition,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";
import { resetStores } from "../test/resetStores";

/**
 * `useTasks.refresh` — the SILENT board re-read, and the reason a background
 * refresh cannot blank the board.
 *
 * ## The gap this serves
 *
 * `docs/features/task-board-known-gaps.md` §2 item 3: a card the model writes
 * through `create_task` / `write_artifact` over the seam reaches no surface until
 * the board remounts, because `load` had exactly two call sites (both mount /
 * Space-change effects) and nothing subscribes to a task tool's result. The data is
 * reachable; the repaint is not.
 *
 * ## Why a SECOND action and not a flag on `load`
 *
 * `load` is the mount read and it is allowed to be LOUD — nothing is on screen yet,
 * so `loading: true` → the spinner is the right answer. `refresh` is the opposite
 * situation: rows ARE on screen. So it must not
 *
 *  - **write `loading`.** Both consumers of that flag today gate on
 *    `columns === undefined && loading` (`TasksBoard.tsx`, `WorkflowsCanvas.tsx`),
 *    so a loaded board cannot currently be blanked by it — verified, not assumed.
 *    That is a reason the loud path happens to be safe TODAY, not a reason it is
 *    correct: the first skeleton or dimming overlay gated on `loading` ALONE turns
 *    every background refresh into a board that flashes. A refresh that promises
 *    nothing about `loading` cannot be broken by a render change three files away,
 *    and that promise is pinned below by SAMPLING the flag mid-flight.
 *  - **clear `error` on the way in.** `load` does `set({ loading: true, error: null })`,
 *    and clearing a stale line is right for a fresh read. For a background re-read it
 *    is a flicker of a message the user was still reading.
 *  - **write `error` on failure.** A failed background refresh leaves GOOD rows on
 *    screen. Replacing "here is your board" with "the board failed to load" because
 *    one opportunistic re-read tripped is a worse answer than silence, and it is the
 *    one the user can act on least — they did not ask for this read. Logged, and the
 *    board keeps its rows and its previous error state.
 *
 * ## What it does NOT disturb
 *
 * Both guards `load` already has, unchanged:
 *  - `loadEpoch` — ONE counter shared by BOTH actions, so a mount read and a
 *    background refresh cannot both paint;
 *  - the in-flight position merge — a debounced background refresh must not fight a
 *    `set_stage_position` write still in the air, so `refresh` runs the SAME
 *    `keepInFlightPositions` merge. Pinned below rather than asserted in prose,
 *    because "it uses the same helper" is the sentence that stops being true the day
 *    someone splits the two actions apart.
 */

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // The WRAPPER names, not the snake_case commands — the store imports the
    // wrappers, and the real ones call `invoke`, which rejects in jsdom.
    getBoard: vi.fn(),
    setStagePosition: vi.fn(),
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
});

/** One column, one card — the board as it looks BEFORE the model writes. */
const BEFORE: StageWithTasks[] = [
  { stage: stage("backlog"), tasks: [card("t1", 1, "backlog")] },
];

/** The same board AFTER the model called `create_task`: the card a human cannot see
 *  until something re-reads. */
const AFTER: StageWithTasks[] = [
  {
    stage: stage("backlog"),
    tasks: [card("t1", 1, "backlog"), card("t2", 2, "backlog")],
  },
];

/** How many cards the slice holds for one column — the read every case below makes,
 *  spelled once so a case is about the COUNT and not about the shape. */
const cardCount = (slug = "backlog"): number =>
  useTasks.getState().boardsBySpace[SPACE]?.find((c) => c.stage.slug === slug)
    ?.tasks.length ?? -1;

const stageOf = (slug: string): StageDto | undefined =>
  useTasks.getState().boardsBySpace[SPACE]?.find((c) => c.stage.slug === slug)
    ?.stage;

beforeEach(() => {
  // BOTH resets, both load-bearing: `resetStores()` cannot reach `loadEpoch` or
  // `positionWritesInFlight` (module `let`s) and `useTasks.getState().reset()` is the
  // only thing that clears those. Omit either and a case inherits a dirty board or a
  // stale epoch.
  resetStores();
  useTasks.getState().reset();
  vi.mocked(getBoard).mockReset();
  vi.mocked(setStagePosition).mockReset();
});

describe("useTasks.refresh", () => {
  it("replaces the slice with what the read answers (the card the model wrote lands)", async () => {
    // The whole point, asserted on the DATA. The repaint AT THE SURFACE is pinned in
    // `TasksBoardAutoRefresh.test.tsx`, which is the file that can mount a board.
    vi.mocked(getBoard)
      .mockResolvedValueOnce(BEFORE)
      .mockResolvedValueOnce(AFTER);
    await useTasks.getState().load(SPACE);
    expect(cardCount()).toBe(1);

    await useTasks.getState().refresh(SPACE);

    expect(cardCount()).toBe(2);
  });

  it("does NOT touch `loading` at any point — sampled while the read is in flight", async () => {
    // THE FLASH PIN, and the one that stops this feature shipping visibly broken.
    // Sampling DURING the in-flight window is the whole test: a `loading: true` that
    // is written and then cleared before the await resolves is invisible to an
    // assertion made only afterwards, and that transient is exactly what would blank
    // a board the moment anything renders a spinner on the flag alone.
    vi.mocked(getBoard)
      .mockResolvedValueOnce(BEFORE)
      .mockResolvedValueOnce(AFTER);
    await useTasks.getState().load(SPACE);
    expect(useTasks.getState().loading).toBe(false);

    const inflight = useTasks.getState().refresh(SPACE);
    const during = useTasks.getState().loading;
    await inflight;

    expect(during).toBe(false);
    expect(useTasks.getState().loading).toBe(false);
  });

  it("does NOT clear `error` on the way in", async () => {
    // `load` clears it (a fresh read earns a fresh verdict); a background re-read has
    // no such right over a message the user is still reading.
    useTasks.setState({ error: "the board did not load" });
    vi.mocked(getBoard).mockResolvedValueOnce(AFTER);

    const inflight = useTasks.getState().refresh(SPACE);
    const during = useTasks.getState().error;
    await inflight;

    expect(during).toBe("the board did not load");
    expect(useTasks.getState().error).toBe("the board did not load");
  });

  it("a FAILED refresh keeps the rows, keeps `loading` false, and writes no error", async () => {
    // The quiet-failure contract, all three halves. A board with good rows on screen
    // is not re-labelled a failure because an opportunistic read tripped — and it is
    // certainly not blanked.
    vi.mocked(getBoard).mockResolvedValueOnce(BEFORE);
    await useTasks.getState().load(SPACE);
    vi.mocked(getBoard).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await useTasks.getState().refresh(SPACE);

    expect(cardCount()).toBe(1);
    expect(useTasks.getState().loading).toBe(false);
    expect(useTasks.getState().error).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("a FAILED refresh leaves an EXISTING error line standing", async () => {
    // The other half of "writes no error": silence must not become a silent CLEAR
    // either, or a background failure would erase the reason the board looks wrong.
    vi.mocked(getBoard).mockResolvedValueOnce(BEFORE);
    await useTasks.getState().load(SPACE);
    useTasks.setState({ error: "an earlier write was refused" });
    vi.mocked(getBoard).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await useTasks.getState().refresh(SPACE);

    expect(useTasks.getState().error).toBe("an earlier write was refused");
    consoleError.mockRestore();
  });

  it("an out-of-order refresh is DROPPED (the epoch is SHARED with `load`)", async () => {
    // `loadEpoch` is one counter for both actions, and this is the pin that proves it.
    // Two refreshes are dispatched; the SLOWER one resolves LAST. Without a shared
    // epoch the stale reply repaints the slice — the same Space-tab-switch bug the
    // counter was written for, arriving through a new door.
    // Defaulted rather than `null`-initialised: TypeScript cannot see the assignment
    // that happens inside the promise executor, so a `null` start narrows the variable
    // to `never` at the call site below.
    let releaseSlow: (v: StageWithTasks[]) => void = () => {};
    vi.mocked(getBoard)
      .mockResolvedValueOnce(BEFORE)
      .mockImplementationOnce(
        () =>
          new Promise<StageWithTasks[]>((resolve) => {
            releaseSlow = resolve;
          }),
      )
      .mockResolvedValueOnce(AFTER);

    await useTasks.getState().load(SPACE);
    const slow = useTasks.getState().refresh(SPACE);
    await useTasks.getState().refresh(SPACE);
    expect(cardCount()).toBe(2);

    // The STALE read answers late.
    releaseSlow(BEFORE);
    await slow;

    expect(cardCount(), "a superseded refresh must not repaint the slice").toBe(
      2,
    );
  });

  it("a refresh does NOT undo a position write that is in flight", async () => {
    // The F3 merge, pinned for `refresh` and not only for `load`. The read answers
    // with the PRE-DRAG coordinates while `set_stage_position` is still in the air:
    // the two coordinates the write owns survive, and everything else the read
    // carries still lands. A DEBOUNCED background refresh makes this shape LIKELY
    // rather than exotic — it fires a beat after the drag that started it.
    let release: (row: StageDto) => void = () => {};
    vi.mocked(setStagePosition).mockReturnValueOnce(
      new Promise<StageDto>((resolve) => {
        release = resolve;
      }),
    );
    vi.mocked(getBoard).mockResolvedValueOnce(
      BEFORE.map((c) => ({
        ...c,
        stage: { ...c.stage, positionX: 1, positionY: 2 },
      })),
    );
    await useTasks.getState().load(SPACE);

    // The drag goes in flight, its optimistic paint lands on the slice.
    const inflight = useTasks
      .getState()
      .setStagePosition(SPACE, "backlog", 10, 20);
    expect(stageOf("backlog")).toMatchObject({ positionX: 10, positionY: 20 });

    // The background refresh answers with the PRE-DRAG pair, plus a label change to
    // prove the rest of the response still arrives (a merge, not a discard).
    vi.mocked(getBoard).mockResolvedValueOnce(
      BEFORE.map((c) => ({
        ...c,
        stage: { ...c.stage, positionX: 1, positionY: 2, label: "Inbox" },
      })),
    );
    await useTasks.getState().refresh(SPACE);

    expect(stageOf("backlog")).toMatchObject({ positionX: 10, positionY: 20 });
    expect(stageOf("backlog")?.label).toBe("Inbox");

    release({ ...stage("backlog"), positionX: 10, positionY: 20 });
    await inflight;
    expect(stageOf("backlog")).toMatchObject({ positionX: 10, positionY: 20 });
  });

  it("a refresh for a Space with NO slice still fills it (it is a read, not a patch)", async () => {
    // `refresh` is not "patch what is already there" — it is the same read with a
    // quieter failure mode. A Space whose slice was dropped gets rows back.
    vi.mocked(getBoard).mockResolvedValueOnce(AFTER);

    await useTasks.getState().refresh(SPACE);

    expect(cardCount()).toBe(2);
    expect(useTasks.getState().loading).toBe(false);
  });

  it("calls the SAME command `load` calls, with the Space verbatim", async () => {
    // The seam-level pin: one read, one argument, no second command invented for the
    // background path. A second command would be a second Rust verb, and this branch
    // is TypeScript-only by design.
    vi.mocked(getBoard).mockResolvedValueOnce(AFTER);
    await useTasks.getState().refresh(SPACE);
    expect(getBoard).toHaveBeenCalledTimes(1);
    expect(getBoard).toHaveBeenCalledWith(SPACE);
  });
});
