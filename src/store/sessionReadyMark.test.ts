import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../test/resetStores";
import { useSessions } from "./sessions";
import { readyCardKey, useInteractive } from "./interactive";
import { loadHistory } from "../lib/tauri";
import type { SessionInfo } from "../lib/tauri";

/**
 * The **ready** mark's CROSS-STORE half — the fact that lives in `sessions.ts`
 * rather than in `interactive.ts`: `beginTurn` withdraws the mark, and a deleted
 * Session drops it.
 *
 * ## Why a new file and not more cases in `sessions.test.ts`
 *
 * `src/store/sessions.test.ts` is 5,543 code lines and is ledgered in
 * `scripts/file-size-baseline-test.txt`; the test-class gate is 1,000 and the
 * ratchet refuses any growth past the recorded figure, so nothing can be added
 * there. ADR 0113's mirror rule is the sanctioned answer — a new file per SUBJECT,
 * named for the subject rather than numbered — and the subject here is narrow and
 * nameable: what the sessions store does with the ready mark.
 *
 * ## What this file pins that `boardReadyMarks.test.ts` cannot
 *
 * That file owns the mark's ORIGIN — a board read feeding the slot, the per-Space
 * replace, the dismiss clear. What only THIS file can reach is the edge from
 * `sessions.ts`: `beginTurn` clears the mark, which is a `sessions.ts` action
 * writing into `useInteractive` across an edge the file already crosses three times
 * (`applyTodoUpdate` in `openSession` and `resumeSession`, `applyTodoClear` in
 * `deleteSession`). All of them go through the OTHER store's ACTION rather than
 * poking its map, and `clearReady` exists so this one does too.
 *
 * ## The two halves of the clear, and why BOTH exist
 *
 * The DURABLE clear is Rust's — `send_prompt_with_images` zeroes `sessions.ready` at
 * turn start — and the board read carries that. `beginTurn`'s clear is OPTIMISTIC and
 * is not made redundant by it: `useTaskBoardAutoRefresh` re-reads the board only on
 * `inTurn`'s FALLING edge, so nothing repaints during a turn, and `cardMarkOf` ranks
 * `ready` ABOVE `running`. Without the optimistic half a card wears a bell for the
 * whole of the turn that disproves it. The settle's read then CONFIRMS the clear
 * rather than undoing it, which `the mark does NOT come back when the turn settles`
 * is the pin for.
 *
 * ## What this file used to pin, and no longer can
 *
 * It used to carry a second describe, `the restart seed restores the ready mark`:
 * four cases proving a mark survived a restart by way of `history_page`'s `todos`
 * being re-fed through `applyTodoUpdate`, which re-ran the word detection. That
 * mechanism is gone — the board carries the mark and the history seed does not — so
 * those cases are deleted rather than inverted, with ONE exception kept and
 * retargeted: `a live board is NOT overwritten by a seed…` was always about the
 * seed's `!(sessionId in todos)` guard, which survives untouched, so it stays as the
 * todo-board pin it actually is.
 *
 * The third case there, `a session whose history is NEVER opened after a restart has
 * NO mark`, is DELETED and deliberately NOT inverted. It was a synchronous,
 * store-only assertion that `useInteractive.todos`/`.ready` were `undefined` — after
 * this change the mark comes from the BOARD store, so inverting it in place would
 * assert something false by construction. Its replacement is the positive proof in
 * `TasksBoardReady.test.tsx` (`the bell shows for a Session whose history is NEVER
 * read`), where a `getBoard` mock can carry `ready: true` and a glyph can be
 * asserted.
 */

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // The ONLY commands this file's paths reach. Mocked for the reason every mock
    // in a `sessions.ts` test factory exists: the factory spreads `importActual`,
    // so an un-mocked wrapper resolves to the REAL one, which calls `invoke` and
    // rejects outside a webview — AGENTS.md's boot-mock trap in its exact shape.
    loadHistory: vi
      .fn()
      .mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    // `deleteSession` (the `applyTodoClear` path) calls this.
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
});

const SPACE = "/w/alpha";

const info = (sessionId: string, cwd: string): SessionInfo => ({
  sessionId,
  cwd,
  capabilities: {},
  archived: false,
});

/** One board, one item. */
const board = (...todos: Array<{ content: string; status: string }>) => ({
  source: "native",
  todos,
});

const readyItem = { content: "ready", status: "completed" as const };

/** Put a mark on the slot the way the app does now — through the BOARD FEED, with a
 *  card that links `sessionId`. Not a `setState` of the map's shape: the feed is the
 *  only writer, so seeding through it pins the same path the mount read and the
 *  auto-refresh take, and a slot that stopped being written by that read reddens here. */
const markReady = (sessionId: string, taskId = `task-for-${sessionId}`) => {
  useInteractive.getState().applyReadyMarks(SPACE, [
    { taskId, ready: true, sessionIds: [sessionId] },
  ]);
  return taskId;
};

/** Is this card marked? */
const isMarked = (taskId: string): boolean =>
  readyCardKey(SPACE, taskId) in useInteractive.getState().ready;

/** Let the `openSession` history fetch (a floating promise) settle. The precedent
 *  is `sessions.test.ts`'s own `await new Promise((r) => setTimeout(r, 0))` at its
 *  two `openSession` todos cases — the fetch is not awaited by the action, so the
 *  microtask turn is what the test has to yield. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // BOTH halves of isolation. `resetStores()` reaches every store in
  // `ALL_STORES` (which includes `useInteractive`, so the ready slot goes back to
  // `{}` with it); `resetModuleFlags` is not needed here because no path below
  // touches the Open-Space dialog flag.
  resetStores();
  vi.mocked(loadHistory).mockClear();
  vi.mocked(loadHistory).mockResolvedValue({
    rows: [],
    hasMore: false,
    todos: null,
  });
});

describe("beginTurn clears the ready mark", () => {
  it("a mark on a card a Session lights is gone the moment that Session begins a turn", () => {
    // The owner's rule, verbatim: "the next turn on that session clears it". Run
    // as a REAL store sequence rather than by calling the two actions in
    // isolation, because the fact under test is the EDGE: `beginTurn` is a
    // `sessions.ts` action and the mark lives in `useInteractive`.
    const taskId = markReady("s1");
    expect(isMarked(taskId)).toBe(true);

    useSessions.getState().beginTurn("s1");

    expect(isMarked(taskId)).toBe(false);
    // And the turn flag itself still does its own job — the clear is an ADDITION
    // to `beginTurn`, not a replacement of what it already wrote.
    expect(useSessions.getState().inTurn["s1"]).toBe(true);
  });

  it("clearing the mark leaves every OTHER session's card standing", () => {
    // The spread-copy rule the todo maps already follow: one session's turn must
    // not withdraw another session's claim.
    const a = markReady("s1", "t1");
    const b = markReady("s2", "t2");
    useSessions.getState().beginTurn("s1");
    expect(isMarked(a)).toBe(false);
    expect(isMarked(b)).toBe(true);
  });

  it("a turn on a Session that lights no card changes nothing at all", () => {
    // The no-op arm, pinned as an IDENTITY and not as "the key is absent":
    // `clearReady` returns the same state object when no entry names the id, so an
    // ordinary `beginTurn` does not hand every reader of the slot a fresh object to
    // re-render for. `beginTurn` itself always writes `inTurn`, so the SESSIONS
    // store does change — the claim is about `useInteractive`.
    markReady("s1", "t1");
    const before = useInteractive.getState();
    useSessions.getState().beginTurn("never-marked");
    expect(useInteractive.getState()).toBe(before);
  });

  it("the mark does NOT come back when the turn settles", () => {
    // THE DERIVATION THIS DESIGN REFUSES, pinned so it cannot be re-introduced.
    // A `ready && !inTurn` derivation would clear the mark for the duration of a
    // turn and then RESTORE it when the turn settled — the opposite of the rule.
    // The mark is an explicit slot written by the board feed and cleared by
    // `beginTurn`, so `turnCompleted` has nothing to restore.
    const taskId = markReady("s1");
    useSessions.getState().beginTurn("s1");
    useSessions.getState().turnCompleted("s1", "end_turn");
    expect(useSessions.getState().inTurn["s1"]).toBe(false);
    expect(isMarked(taskId)).toBe(false);
  });

  it("a later board read that reports the column set again marks the card again", () => {
    // The clear is not a fuse. The model marks done, the user sends another prompt,
    // the model finishes and marks done AGAIN — the second claim is a real second
    // claim, and it arrives as an ordinary board read carrying `ready: true`.
    const taskId = markReady("s1");
    useSessions.getState().beginTurn("s1");
    expect(isMarked(taskId)).toBe(false);

    useInteractive.getState().applyReadyMarks(SPACE, [
      { taskId, ready: true, sessionIds: ["s1"] },
    ]);
    expect(isMarked(taskId)).toBe(true);
  });

  it("a close clears it, and it does NOT come back from the carried todo board", () => {
    // `sessionLifecycle.onSessionClosed` dismisses the interactive slice and then
    // re-applies the board it read BEFORE the dismiss (the carry that keeps a
    // still-rendered Session's checklist on screen). Under the word that re-apply
    // re-detected the marker and put the mark back. It cannot any more, and that is
    // the correct answer: a todo snapshot has nothing to say about a column. The
    // claim survives in `sessions.ready` and the bell returns with the next board
    // read that reports it.
    const taskId = markReady("s1");
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));

    useInteractive.getState().dismissSession("s1");
    expect(isMarked(taskId)).toBe(false);

    // The carry `onSessionClosed` performs, spelled directly: the board comes back,
    // the bell does not.
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    expect(isMarked(taskId)).toBe(false);
    expect(useInteractive.getState().todos["s1"]).toHaveLength(1);
  });
});

describe("a history seed feeds the TODO BOARD and nothing else", () => {
  it("opening a stored session seeds its checklist, and sets NO ready mark", async () => {
    // THE MECHANISM, kept because it never belonged to the mark. `history_page`
    // returns `db.session_todos(...)` on the first page only and `openSession`
    // hands it to `applyTodoUpdate` — that is the CHECKLIST's restart path and it is
    // untouched. What changed is that a `completed` item reading `ready` in that
    // array now means nothing at all: the mark comes from the board read, so the
    // bell for a Session nobody opened is `get_board`'s job
    // (`TasksBoardReady.test.tsx`), not the transcript seed's.
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows: [],
      hasMore: false,
      todos: [
        { content: "write the reducer", status: "completed" },
        { content: "ready", status: "completed" },
      ],
    });
    useSessions.setState({
      activeSessionId: null,
      historySessions: [info("s-restart", "/x")],
    });

    useSessions.getState().openSession("s-restart");
    await flush();

    expect(useInteractive.getState().todos["s-restart"]).toHaveLength(2);
    expect(useInteractive.getState().ready).toEqual({});
  });

  it("a live board is NOT overwritten by a seed that carries different items", async () => {
    // The seed's own guard (`!(sessionId in todos)`) means a live board wins. Pinned
    // because the guard is what keeps a reopened Session's in-flight checklist from
    // being replaced by whatever was last persisted, and it is a `todos` rule with
    // no bearing on readiness at all.
    const live = [{ content: "ready", status: "completed" as const }];
    useInteractive.setState({ todos: { "s-live": live } });
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows: [],
      hasMore: false,
      todos: [{ content: "stale plan", status: "pending" }],
    });
    useSessions.setState({
      activeSessionId: null,
      historySessions: [info("s-live", "/x")],
    });

    useSessions.getState().openSession("s-live");
    await flush();

    expect(useInteractive.getState().todos["s-live"]).toBe(live);
  });
});

describe("deleteSession drops the todo board and leaves the mark to the read", () => {
  it("a deleted Session holds no board, and its card's mark waits for the next read", async () => {
    // THE BEHAVIOUR THAT CHANGED, pinned rather than hidden. `deleteSession` reached
    // the mark through `applyTodoClear`, and that arm retired with the word — so the
    // slot now has exactly THREE writers (the board feed, `beginTurn`,
    // `dismissSession`) and a delete is not one of them.
    //
    // The staleness is bounded and it resolves correctly: `task_sessions.session_id`
    // is `ON DELETE CASCADE`, so deleting a Session deletes its link rows, and the
    // next `get_board` answers that card with a SHORTER link list and the `ready` OR
    // recomputed over what is left. The bell is therefore stale until that read, and
    // the read is the thing that knows the truth. Adding a fourth writer here would
    // mean a DELETE asserting a fact about a column it does not touch — a card with
    // another linked Session can still be ready after this one is deleted.
    const taskId = markReady("s1");
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    useSessions.setState({ sessions: [info("s1", "/x")] });

    await useSessions.getState().deleteSession("s1");

    expect(useInteractive.getState().todos["s1"]).toBeUndefined();
    expect(useSessions.getState().sessions).toEqual([]);
    // And the mark is STILL there — deliberately, because nothing in a Session delete
    // knows whether the card's OTHER links still hold the claim.
    expect(isMarked(taskId)).toBe(true);
  });

  it("a deleted Session that is DISMISSED on the way out loses the mark", () => {
    // The path that DOES clear it, shown next to the one that does not, so the rule
    // is legible: `dismissSession` is a writer because a Worker going away is the
    // event the optimistic clear is defined over. A live Session being deleted goes
    // through `onSessionClosed` → `dismissSession` first in the ordinary case, so the
    // bell does come down — it is the delete of an ALREADY-closed Session that leaves
    // the next read to settle it.
    const taskId = markReady("s1");
    useInteractive.getState().dismissSession("s1");
    expect(isMarked(taskId)).toBe(false);
  });
});
