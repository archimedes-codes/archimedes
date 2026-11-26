import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";

import TasksBoard from "./TasksBoard";
import { useTasks } from "../store/tasks";
import { useSessions } from "../store/sessions";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import {
  getBoard,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";

/**
 * THE BOARD RE-READS ITSELF WHEN A TURN SETTLES — gap §2 item 3 of
 * `docs/features/task-board-known-gaps.md` ("a card the model writes is invisible
 * until the board is remounted").
 *
 * ## The non-vacuity case is the first one, and it is the whole file
 *
 * `a card the model writes appears WITHOUT a remount` renders the board ONCE, writes
 * a second card into what the READ answers, settles a turn, and asserts the second
 * card appears. Nothing unmounts, nothing re-renders the board with a new key, no
 * Space change. Remove the settle trigger from `useTaskBoardAutoRefresh` and the
 * case goes red with ONE card on screen — that is the mutation the branch was
 * required to prove, and the reason this file exists separately from
 * `TasksBoard.test.tsx` (which is at 914 code lines against a 1,000 test gate and
 * whose subject is the board's anatomy, not its refresh scheduling).
 *
 * ## Why the trigger is a turn SETTLE and what that claim rests on
 *
 * There is no task/board Tauri event and this branch adds none. The candidates the
 * frontend already receives were checked against the Rust, read-only:
 *
 *  - `agent_settled` is the engine's settle frame, and the desktop deliberately does
 *    NOT forward it: `router.rs`'s `WorkerInboundEvent::Event` arm says
 *    "Internal bookkeeping ONLY (NOT the `TauriSink` — forwarding would
 *    DOUBLE-DELIVER every `session-update` the loop emits both as an `RpcEvent` and
 *    as a `session-update` `SinkFrame`)". So no renderer event carries a settle.
 *  - `session-closed` fires when the WORKER exits (a pause/close), not per turn, so
 *    it is too rare — a long-lived Session would never repaint the board.
 *  - `turnCompleted` → `inTurn[sessionId] = false` is the frontend's OWN settle, and
 *    it provably fires: `sendPrompt` resolves on `agent_settled` (the router's
 *    `resolve_turn`), and every dispatch path calls `turnCompleted` on the other side
 *    of that await (`useChatPromptDispatch`, `usePromptQueueFlusher`,
 *    `store/taskLaunch`). `handleSessionClosed` clears the same flag, so a close or a
 *    crash reads as a fall too — which is right, a dead Worker ended the turn.
 *
 * So the falling edge of `useSessions.inTurn` IS the settle signal that reaches the
 * renderer, and `store/taskLaunch`'s own comment names it: "`turnCompleted` is the
 * ONLY frontend path that clears `inTurn`".
 *
 * ## What the board must NOT do while it re-reads
 *
 * Not blank. `useTasks.refresh` never writes `loading` (its own doc and
 * `tasksRefresh.test.ts` hold that), and the cases below assert the loaded columns
 * stay on screen across the refresh rather than being replaced by the spinner — the
 * most likely way this feature ships visibly broken.
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
    createStage: vi.fn(),
    renameStage: vi.fn(),
    setStageSkill: vi.fn(),
    setStageNext: vi.fn(),
    reorderStages: vi.fn(),
    deleteStage: vi.fn(),
    setBoardStrict: vi.fn(),
    getBoardStrict: vi.fn().mockResolvedValue(false),
    writeArtifact: vi.fn(),
    getArtifact: vi.fn(),
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    setSessionConfigOption: vi.fn(),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    listMcpServersEffective: vi.fn().mockResolvedValue([]),
    listSpaceListing: vi
      .fn()
      .mockResolvedValue({ entries: [], truncated: false }),
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});

const SPACE = "/w/alpha";

const stage = (slug: string, sortOrder: number): StageDto => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
  auto: false,
  promptPrefix: null,
});

const task = (id: string, number: number): TaskRow => ({
  id,
  spacePath: SPACE,
  number,
  title: `Card ${number}`,
  body: null,
  specPath: null,
  stageSlug: "backlog",
  sortOrder: number - 1,
  createdAt: 1,
  updatedAt: 1,
});

const card = (id: string, number: number): TaskCardView => ({
  task: task(id, number),
  sessions: [],
  costUsd: null,
  artifactKeys: [],
  ready: false,
  readySessions: [],
});

/** One column. `titles` are the card NUMBERS the read answers with, so a case says
 *  "the board now answers with TWO cards" instead of rebuilding a wire shape. */
const boardWith = (...numbers: number[]): StageWithTasks[] => [
  {
    stage: stage("backlog", 0),
    tasks: numbers.map((n) => card(`t${n}`, n)),
  },
];

/** How many cards the rendered board shows. */
const renderedCards = () => screen.queryAllByTestId("task-card-slot").length;

const board = () => screen.getByTestId("tasks-board");

/** Open a turn on a Session and then settle it — the exact store sequence a real
 *  prompt run leaves behind (`beginTurn` on dispatch, `turnCompleted` on the other
 *  side of the `sendPrompt` await). */
const runAndSettleTurn = (sessionId: string) => {
  act(() => {
    useSessions.getState().beginTurn(sessionId);
  });
  act(() => {
    useSessions.getState().turnCompleted(sessionId, "end_turn");
  });
};

// REAL timers throughout. `waitFor` spins on the real clock, so faking it here turns
// every wait into a 20 s timeout; the debounce is 350 ms, so a `waitFor` with a 2 s
// ceiling covers it with room, and the "only one read" case asserts a COUNT after a
// real 1.2 s pause rather than a tick count.
const SETTLE_WAIT = { timeout: 2000 };
/** Longer than the debounce, so a burst has definitely fired and a non-refresh has
 *  definitely NOT been missed for want of time. */
const LONGER_THAN_DEBOUNCE_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  useSessions.setState({ activeSpacePath: SPACE });
  vi.mocked(getBoard).mockReset();
});

describe("the board re-reads itself when a turn settles", () => {
  it("a card the model writes appears WITHOUT a remount", async () => {
    // THE NON-VACUITY PROOF. One render, one mount, no key change, no Space change.
    // The model's `create_task` lands in the database; the only thing that can put it
    // on screen is a re-read, and the only thing that triggers one is the settle.
    //
    // Delete the trigger from `useTaskBoardAutoRefresh` and this reddens holding ONE
    // card, which is the gap the doc records.
    vi.mocked(getBoard)
      .mockResolvedValueOnce(boardWith(1))
      .mockResolvedValueOnce(boardWith(1, 2));

    render(<TasksBoard />);
    await waitFor(() => expect(renderedCards()).toBe(1), SETTLE_WAIT);
    expect(getBoard).toHaveBeenCalledTimes(1);

    runAndSettleTurn("sess_model");

    await waitFor(() => expect(renderedCards()).toBe(2), SETTLE_WAIT);
    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("the board does NOT blank while it re-reads (no spinner, columns stay)", async () => {
    // THE FLASH CHECK, and the reason the refresh is a SILENT read rather than a
    // second `load`. Asserted on what is ON SCREEN across the debounce window: the
    // one card the user was looking at never leaves, and `Loading the task board…`
    // never appears.
    vi.mocked(getBoard)
      .mockResolvedValueOnce(boardWith(1))
      .mockResolvedValueOnce(boardWith(1, 2));

    render(<TasksBoard />);
    await waitFor(() => expect(renderedCards()).toBe(1), SETTLE_WAIT);

    // MID-WINDOW, before the debounce has elapsed: the board is still the board and
    // no spinner has appeared. This is the frame a `loading`-writing refresh would
    // have blanked.
    runAndSettleTurn("sess_model");
    expect(screen.queryByText("Loading the task board…")).toBeNull();
    expect(renderedCards()).toBe(1);

    await waitFor(() => expect(renderedCards()).toBe(2), SETTLE_WAIT);
    expect(screen.queryByText("Loading the task board…")).toBeNull();
    expect(useTasks.getState().loading).toBe(false);
    await waitFor(() => expect(renderedCards()).toBe(2));
    // And the original card was never replaced by a placeholder on the way there.
    expect(within(board()).getAllByTestId("task-card")).toHaveLength(2);
  });

  it("N settles in one beat cause ONE read (the debounce)", async () => {
    // The brief's requirement, stated as a count: a settling turn must not fire N
    // board reads. Three Sessions settle before the debounce elapses; the model
    // would otherwise pay three `get_board` calls for one batch of writes — and
    // `get_board` is not a pure read (ADR 0090's lazy stage seeding).
    vi.mocked(getBoard).mockResolvedValue(boardWith(1));
    render(<TasksBoard />);
    await waitFor(() => expect(renderedCards()).toBe(1), SETTLE_WAIT);
    expect(getBoard).toHaveBeenCalledTimes(1);

    runAndSettleTurn("s1");
    runAndSettleTurn("s2");
    runAndSettleTurn("s3");

    // Past the debounce with room to spare: the burst is over and it fired ONCE.
    await act(async () => {
      await sleep(LONGER_THAN_DEBOUNCE_MS);
    });

    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("a turn START does not refresh — only the fall does", async () => {
    // The other half of "turn settle". A rise is a turn beginning: nothing has been
    // written yet, and refreshing on it would fire a read on every prompt the user
    // sends, before the model has had a chance to call a tool.
    vi.mocked(getBoard).mockResolvedValue(boardWith(1));
    render(<TasksBoard />);
    await waitFor(() => expect(renderedCards()).toBe(1), SETTLE_WAIT);

    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    await act(async () => {
      await sleep(LONGER_THAN_DEBOUNCE_MS);
    });

    expect(getBoard).toHaveBeenCalledTimes(1);
  });

  it("a settle with NO Space open reads nothing at all", async () => {
    // `refresh(null)` is not a thing and a Space with no selection has no board. The
    // guard is what keeps a background Session's settle from firing a read for a
    // Space nobody has selected.
    vi.mocked(getBoard).mockResolvedValue(boardWith(1));
    render(<TasksBoard />);
    await waitFor(() => expect(renderedCards()).toBe(1), SETTLE_WAIT);

    act(() => {
      useSessions.setState({ activeSpacePath: null });
    });
    runAndSettleTurn("s1");
    await act(async () => {
      await sleep(LONGER_THAN_DEBOUNCE_MS);
    });

    // Exactly the mount read. (The Space-change effect cannot re-fire either, because
    // a null Space returns before `load`.)
    expect(getBoard).toHaveBeenCalledTimes(1);
  });

  it("a close counts as a settle (a dead Worker ended the turn too)", async () => {
    // `handleSessionClosed` clears `inTurn` through the same contract spread, so a
    // close is a fall. That is the right answer — a crashed or closed turn is over,
    // and any card it managed to write should show — and it is the reason the trigger
    // reads the FLAG and not `turnCompleted` itself.
    vi.mocked(getBoard)
      .mockResolvedValueOnce(boardWith(1))
      .mockResolvedValueOnce(boardWith(1, 2));
    useSessions.setState({ sessions: [{ ...row("s1", SPACE) }] });
    render(<TasksBoard />);
    await waitFor(() => expect(renderedCards()).toBe(1), SETTLE_WAIT);

    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    act(() => {
      useSessions.getState().handleSessionClosed("s1", "user", undefined);
    });

    await waitFor(() => expect(renderedCards()).toBe(2), SETTLE_WAIT);
  });

  it("an UNMOUNTED board never reads (no read for a surface nobody is looking at)", async () => {
    // The cost decision, pinned. The hook is mounted by the board and the canvas, not
    // by `App`, so a settle while the board is closed fires NO read — the next mount
    // reads fresh anyway, and a Space's stages are only ever seeded by a read someone
    // asked for. This is also what keeps the feature from turning every prompt in the
    // app into a `get_board` call.
    vi.mocked(getBoard).mockResolvedValue(boardWith(1));
    const { unmount } = render(<TasksBoard />);
    await waitFor(() => expect(renderedCards()).toBe(1), SETTLE_WAIT);
    unmount();

    runAndSettleTurn("s1");
    await act(async () => {
      await sleep(LONGER_THAN_DEBOUNCE_MS);
    });

    expect(getBoard).toHaveBeenCalledTimes(1);
  });
});

/** A minimal live-session row — the store's `handleSessionClosed` moves it from
 *  `sessions` to `historySessions` and clears `inTurn` on the way. */
const row = (sessionId: string, cwd: string) => ({
  sessionId,
  cwd,
  capabilities: {},
  archived: false,
});
