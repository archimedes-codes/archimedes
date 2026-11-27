import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOARD_REQUIRED,
  moveTaskVerb,
  NO_BOARD,
  type BoardSlice,
  type MoveTaskMode,
} from "./taskMove";
import { moveTask, type StageWithTasks, type TaskCardView, type TaskRow } from "../lib/tauri";
import type { StoreApi } from "zustand";

/**
 * `src/store/taskMove.ts` — the ONE owner of the cross-column move verb.
 *
 * ## Why this sibling exists (ADR 0113's mirror rule)
 *
 * The file's own header cites it and there was nothing behind it: the module shipped
 * without a test sibling, so its `NO_BOARD` arm — the arm an advice-driven launch uses,
 * and the arm the whole auto-advance chain depends on — was exercised only indirectly.
 * `workflowChain.test.ts`'s no-slice headline case reaches it through
 * `launchTaskSession`, and a chain of three collaborators between the assertion and the
 * arm means the case pins the SUCCESS half and nothing else.
 *
 * ## The hole this closes
 *
 * `taskLaunch.launchTaskSession` turns a `null` out of this verb into a THROW, and the
 * chain turns that throw into `launch_refused`. So the value this verb answers on a
 * REFUSED slice-free move is the difference between "the card stayed put, and the
 * transcript says so" and "the card stayed put, and the record claims it moved".
 * A regression returning `toStageSlug` on a refused move — the one-line mutation
 * `return toStageSlug;` moved outside the `try` — kept every existing test green. That
 * is the exact bug class D19 exists to close, and it is pinned here directly.
 *
 * ## Why the slice is hand-rolled rather than taken from `useTasks`
 *
 * `moveTaskVerb` takes its `set`/`get` as ARGUMENTS precisely so it can be driven without
 * the store that usually supplies them (`tasks.ts` forwards to it for exactly that
 * reason: the file is ratcheted at 710 code lines and the verb's second arm would not
 * fit beside it). Driving it directly means a red here names this file's subject and not
 * a wiring bug three layers up, and it makes the `undefined`-slice case trivially
 * expressible — the state the chain actually runs in.
 *
 * ## The barrel is mocked the documented way
 *
 * Spreading `vi.importActual`, because the subject IS the `move_task` wrapper: an
 * un-mocked one calls `invoke`, which rejects outside a webview, and every case would
 * pin a rejection instead of the arm under test.
 */
const SPACE = "/w/alpha";

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return { ...actual, moveTask: vi.fn() };
});

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "tsk_1",
    spacePath: SPACE,
    number: 3,
    title: "Wire the board",
    body: null,
    specPath: null,
    stageSlug: "backlog",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function card(task: TaskRow): TaskCardView {
  return { task, sessions: [], costUsd: null, artifactKeys: [], ready: false, readySessions: [] };
}

function column(slug: string, tasks: TaskRow[] = []): StageWithTasks {
  return {
    stage: {
      spacePath: SPACE,
      slug,
      label: slug,
      sortOrder: 0,
      onEnter: "none",
      onEnterSkill: null,
      nextSlugs: null,
      auto: false,
      promptPrefix: null,
    },
    tasks: tasks.map(card),
  };
}

/** A `BoardSlice` this verb can drive: the three fields it is allowed to write, and
 *  nothing else. `set` accepts both shapes zustand's `setState` takes (an object and a
 *  updater function) because the verb uses both. */
function makeSlice(initial: Partial<BoardSlice> = {}): {
  set: StoreApi<BoardSlice>["setState"];
  get: () => BoardSlice;
  slice: () => BoardSlice;
} {
  let state: BoardSlice = {
    boardsBySpace: {},
    boostNotes: {},
    error: null,
    ...initial,
  };
  return {
    set: (partial) => {
      state = {
        ...state,
        ...(typeof partial === "function" ? partial(state) : partial),
      };
    },
    get: () => state,
    slice: () => state,
  };
}

/** Move `taskRow()` from `backlog` to `implement` through the verb, directly. */
function move(
  store: { set: StoreApi<BoardSlice>["setState"]; get: () => BoardSlice },
  mode: MoveTaskMode,
  toStageSlug = "implement",
  taskId = "tsk_1",
): Promise<string | null> {
  return moveTaskVerb(store.set, store.get, SPACE, taskId, toStageSlug, mode);
}

/** The board the loaded-slice cases use: the card IS in `backlog`, which is not
 *  decoration — `moveTaskVerb` refuses a move whose source column does not hold the card
 *  (a stale gesture beats inventing a column) and returns without calling the command. */
function loadedBoard(): StageWithTasks[] {
  return [
    column("backlog", [taskRow()]),
    column("implement", []),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
});

describe("moveTaskVerb — the slice-free arm (NO_BOARD, D19)", () => {
  it("answers the destination slug when the write lands", async () => {
    // The arm the chain runs on: no `boardsBySpace` entry exists at all, because
    // `App`'s view ternary makes the board and `ChatStream` mutually exclusive, so the
    // Session that claims has never read a board. Refusing there is what left
    // `workflow_runs` holding zero rows against 456 Sessions.
    const store = makeSlice();
    await expect(move(store, NO_BOARD)).resolves.toBe("implement");
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement");
  });

  it("answers `null` when the write is REFUSED — and not the slug it was asked for", async () => {
    // THE PIN THIS FILE EXISTS FOR. `Db::move_task` refuses a `board_strict` board whose
    // edge does not exist, and `launchTaskSession` compares this answer against the slug
    // it aimed at: `landed !== slug` is a throw and the chain's `launch_refused`. Return
    // `toStageSlug` from the `catch` instead and a refused move reports success, the card
    // never moves, and the Session that starts carries a `<task stage>` naming a column
    // the card is not in — with every existing test still green.
    vi.mocked(moveTask).mockRejectedValue({
      kind: "strict_move_refused",
      message: "backlog does not lead to implement",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = makeSlice();
      await expect(move(store, NO_BOARD)).resolves.toBeNull();
      expect(moveTask).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("paints nothing and writes no `error`, on either outcome", async () => {
    // Both skips are FORCED, not chosen: the paint maps `columns` (there are none, so it
    // would store a key holding `undefined`) and the revert re-reads
    // `boardsBySpace[spacePath]` (still none), which answers `null` and turns a move that
    // SUCCEEDED into a `launch_refused`. `error` stays untouched for the same reason the
    // transcript gets the sentence instead: the store's `error` renders only where a board
    // or a canvas is mounted, and writing it would imply a second, unowned report of a
    // failure the caller already received as a `null`.
    const accepted = makeSlice();
    await move(accepted, NO_BOARD);
    expect(accepted.slice()).toEqual({ boardsBySpace: {}, boostNotes: {}, error: null });

    vi.mocked(moveTask).mockRejectedValue({ kind: "command", message: "move refused" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const refused = makeSlice();
      await move(refused, NO_BOARD);
      // Not even a `boardsBySpace` KEY for the Space — an entry holding `undefined` is a
      // different answer from "never loaded", and the whole slice contract reads absence.
      expect(refused.slice()).toEqual({ boardsBySpace: {}, boostNotes: {}, error: null });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("discards a `boostNote` rather than failing the move", async () => {
    // A real cost, stated in the header and pinned here so it stays a decision: the
    // note's only surface is a board that by definition is not mounted. The card moved
    // and the answer is still the destination — a discarded warning must not read as a
    // refusal, or a `compact` column would close every chain that enters it.
    vi.mocked(moveTask).mockResolvedValue({
      onEnter: "compact",
      boostNote: "no live Session to compact",
    });
    const store = makeSlice();
    await expect(move(store, NO_BOARD)).resolves.toBe("implement");
    expect(store.slice().boostNotes).toEqual({});
  });

  it("takes the FULL verb when a slice happens to be loaded", async () => {
    // `NO_BOARD` is a claim about what the caller HOLDS, not a demand to skip work: a
    // slice that exists paints for free, and a person watching that board should see the
    // card move. The mode keys on itself and not on `columns === undefined`, which is
    // what keeps a person's drag that races an unload refusing instead.
    const store = makeSlice({ boardsBySpace: { [SPACE]: loadedBoard() } });
    await expect(move(store, NO_BOARD)).resolves.toBe("implement");
    const columns = store.slice().boardsBySpace[SPACE]!;
    expect(columns.find((c) => c.stage.slug === "implement")?.tasks.map((t) => t.task.id)).toContain(
      "tsk_1",
    );
  });
});

describe("moveTaskVerb — the board-required arm (every existing caller)", () => {
  it("refuses with `null` and a sentence when no slice is loaded", async () => {
    // The default, and unchanged: a drag whose endpoints the store cannot see is a stale
    // gesture. The command is never reached — refusing is the whole answer.
    const store = makeSlice();
    await expect(move(store, BOARD_REQUIRED)).resolves.toBeNull();
    expect(moveTask).not.toHaveBeenCalled();
    expect(store.slice().error).toContain("No board loaded");
  });

  it("answers the card's REAL column when the backend refuses, and reverts the paint", async () => {
    // The swallowed refusal, RETURNED — the fact the swallow used to lose, and the reason
    // the chain can tell a move from a refusal at all. The answer comes from the RESTORED
    // slice rather than from `from.stage.slug`, so the return value and the state a caller
    // can observe cannot diverge.
    vi.mocked(moveTask).mockRejectedValue({ kind: "command", message: "strict refusal" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = makeSlice({ boardsBySpace: { [SPACE]: loadedBoard() } });
      await expect(move(store, BOARD_REQUIRED)).resolves.toBe("backlog");
      const columns = store.slice().boardsBySpace[SPACE]!;
      expect(columns.find((c) => c.stage.slug === "implement")?.tasks).toHaveLength(0);
      expect(columns.find((c) => c.stage.slug === "backlog")?.tasks.map((t) => t.task.id)).toContain(
        "tsk_1",
      );
      expect(store.slice().error).toContain("strict refusal");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("answers the card's real column for a stale gesture, without calling the command", async () => {
    // The endpoints are checked before anything is written, and the ANSWER is still the
    // card's column rather than the one that was asked for: a caller that meant to move it
    // must be able to see that it did not.
    const store = makeSlice({ boardsBySpace: { [SPACE]: loadedBoard() } });
    await expect(move(store, BOARD_REQUIRED, "ghost")).resolves.toBe("backlog");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("answers the current column for a same-column drop, without calling the command", async () => {
    // The loaded slice has always had this guard — and it is the guard the slice-free arm
    // was missing (F5). `resolveStage` is where that case is now caught for BOTH arms,
    // because only the caller holds the `TaskRow`; this pin is the verb's own half.
    const store = makeSlice({ boardsBySpace: { [SPACE]: loadedBoard() } });
    await expect(move(store, BOARD_REQUIRED, "backlog")).resolves.toBe("backlog");
    expect(moveTask).not.toHaveBeenCalled();
  });
});
