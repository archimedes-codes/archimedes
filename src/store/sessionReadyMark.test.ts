import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../test/resetStores";
import { useSessions } from "./sessions";
import { useInteractive } from "./interactive";
import { onSessionClosed } from "./sessionLifecycle";
import { loadHistory } from "../lib/tauri";
import type { SessionInfo } from "../lib/tauri";

/**
 * The **ready** marker's CROSS-STORE half — the two facts that live in
 * `sessions.ts` rather than in `interactive.ts`, and the restart boundary.
 *
 * ## Why a new file and not more cases in `sessions.test.ts`
 *
 * `src/store/sessions.test.ts` is 5,543 code lines and is ledgered in
 * `scripts/file-size-baseline-test.txt`; the test-class gate is 1,000 and the
 * ratchet refuses any growth past the recorded figure, so nothing can be added
 * there. ADR 0113's mirror rule is the sanctioned answer — a new file per
 * SUBJECT, named for the subject rather than numbered — and the subject here is
 * narrow and nameable: what the sessions store does with the ready mark.
 *
 * ## What this file pins that `interactive.test.ts` cannot
 *
 * `interactive.test.ts` owns the marker's PREDICATE (exact `ready` + `completed`,
 * the snapshot rule, the clear rule). What only THIS file can reach is the pair of
 * edges between the two stores:
 *
 *  1. `beginTurn` clears the mark — the owner's rule, "the next turn on that
 *     Session clears it". That is a `sessions.ts` action writing into
 *     `useInteractive`, which is an edge with an existing precedent two thirds of
 *     the way down the same file (`openSession` and `resumeSession` both call
 *     `useInteractive.getState().applyTodoUpdate` to seed a board), so this adds a
 *     second call across an edge the file already crosses rather than opening a
 *     new one.
 *  2. The restart seed sets it. `history_page` returns `db.session_todos(...)` on
 *     the FIRST page only (`before_id.is_none()`), `openSession` feeds that into
 *     `applyTodoUpdate`, and the detection at the funnel re-fires — so a mark
 *     survives a restart for any session whose history gets opened, with no new
 *     column and no migration.
 *
 * ## The boundary this file also pins, because it is the honest one
 *
 * A Session that is NEVER opened after a restart has no `todos` in the map, so it
 * has no mark. The mark rides the board; the board is not in memory until
 * something reads it. That is the accepted cost of the zero-migration design and
 * `docs/features/session-ready-marker.md` records it — a test that asserts the
 * boundary is what stops a later reader assuming the mark is durable.
 */

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // The ONLY command this file's paths reach. Mocked for the reason every mock
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

/** Let the `openSession` history fetch (a floating promise) settle. The precedent
 *  is `sessions.test.ts`'s own `await new Promise((r) => setTimeout(r, 0))` at its
 *  two `openSession` todos cases — the fetch is not awaited by the action, so the
 *  microtask turn is what the test has to yield. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // BOTH halves of isolation. `resetStores()` reaches every store in
  // `ALL_STORES` (which includes `useInteractive`, so the new `ready` map goes
  // back to `{}` with it); `resetModuleFlags` is not needed here because no path
  // below touches the Open-Space dialog flag.
  resetStores();
  vi.mocked(loadHistory).mockClear();
  vi.mocked(loadHistory).mockResolvedValue({
    rows: [],
    hasMore: false,
    todos: null,
  });
});

describe("beginTurn clears the ready mark", () => {
  it("a mark set on a Session is gone the moment that Session begins a turn", () => {
    // The owner's rule, verbatim: "the next turn on that session clears it". Run
    // as a REAL store sequence rather than by calling the two actions in
    // isolation, because the fact under test is the EDGE: `beginTurn` is a
    // `sessions.ts` action and the mark lives in `useInteractive`.
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    expect(useInteractive.getState().ready["s1"]).toBe(true);

    useSessions.getState().beginTurn("s1");

    expect(useInteractive.getState().ready["s1"]).toBeUndefined();
    // And the turn flag itself still does its own job — the clear is an ADDITION
    // to `beginTurn`, not a replacement of what it already wrote.
    expect(useSessions.getState().inTurn["s1"]).toBe(true);
  });

  it("clearing the mark leaves every OTHER session's mark standing", () => {
    // The spread-copy rule the todo maps already follow: one session's turn must
    // not withdraw another session's claim.
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    useInteractive.getState().applyTodoUpdate("s2", board(readyItem));
    useSessions.getState().beginTurn("s1");
    expect(useInteractive.getState().ready["s1"]).toBeUndefined();
    expect(useInteractive.getState().ready["s2"]).toBe(true);
  });

  it("a turn on a Session that never marked ready changes nothing at all", () => {
    // The no-op arm, pinned as an IDENTITY and not as "the key is absent":
    // `clearReady` returns the same state object when the id is not in the map, so
    // an ordinary `beginTurn` does not hand every reader of `ready` a fresh object
    // to re-render for. `beginTurn` itself always writes `inTurn`, so the
    // SESSIONS store does change — the claim is about `useInteractive`.
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    const before = useInteractive.getState();
    useSessions.getState().beginTurn("never-marked");
    expect(useInteractive.getState()).toBe(before);
  });

  it("the mark does NOT come back when the turn settles", () => {
    // THE DERIVATION THIS DESIGN REFUSES, pinned so it cannot be re-introduced.
    // A `ready && !inTurn` derivation would clear the mark for the duration of a
    // turn and then RESTORE it when the turn settled — the opposite of the rule.
    // The mark is an explicit slot written by the marker and cleared by
    // `beginTurn`, so `turnCompleted` has nothing to restore.
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    useSessions.getState().beginTurn("s1");
    useSessions.getState().turnCompleted("s1", "end_turn");
    expect(useSessions.getState().inTurn["s1"]).toBe(false);
    expect(useInteractive.getState().ready["s1"]).toBeUndefined();
  });

  it("a later board that re-asserts the marker sets the mark again", () => {
    // The clear is not a fuse. The model marks ready, the user sends another
    // prompt, the model finishes and marks ready AGAIN — the second claim is a
    // real second claim, and it arrives as an ordinary `todos_update`.
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    useSessions.getState().beginTurn("s1");
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    expect(useInteractive.getState().ready["s1"]).toBe(true);
  });

  it("a close clears it too, and a re-apply of the carried board restores it", () => {
    // `sessionLifecycle.onSessionClosed` dismisses the interactive slice and then
    // re-applies the board it read BEFORE the dismiss (the carry that keeps a
    // still-rendered Session's checklist on screen). Both halves are the funnel,
    // so both halves are the marker: the dismiss drops the mark and the re-apply
    // re-reads it. The net answer is the correct one — the board still on screen
    // still says `ready`.
    useSessions.setState({ sessions: [info("s1", "/x")] });
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    expect(useInteractive.getState().ready["s1"]).toBe(true);

    onSessionClosed("s1", "user");

    expect(useInteractive.getState().ready["s1"]).toBe(true);
    // And the same close for a board WITHOUT the marker leaves nothing set, so the
    // restore above is the marker's own doing and not a leaked key.
    useInteractive
      .getState()
      .applyTodoUpdate("s2", board({ content: "go", status: "pending" }));
    onSessionClosed("s2", "user");
    expect(useInteractive.getState().ready["s2"]).toBeUndefined();
  });
});

describe("the restart seed restores the ready mark", () => {
  it("opening a stored session whose history carries a `ready` item marks it", async () => {
    // THE RESTART PATH, end to end through the real action. `history_page`
    // (Rust: `commands/history.rs`) returns `db.session_todos(...)` on the first
    // page only; `openSession` hands that array to `applyTodoUpdate`; the
    // detection at the funnel re-fires. No new column, no migration, no IPC
    // command — the mark rides the board that was ALWAYS coming back.
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
    expect(useInteractive.getState().ready["s-restart"]).toBe(true);
  });

  it("opening a stored session whose history has NO marker leaves it unmarked", async () => {
    // The negative, so the case above cannot pass on a stale key or on a predicate
    // that ignores the status half.
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows: [],
      hasMore: false,
      todos: [{ content: "ready", status: "pending" }],
    });
    useSessions.setState({
      activeSessionId: null,
      historySessions: [info("s-restart", "/x")],
    });

    useSessions.getState().openSession("s-restart");
    await flush();

    expect(useInteractive.getState().todos["s-restart"]).toHaveLength(1);
    expect(useInteractive.getState().ready["s-restart"]).toBeUndefined();
  });

  it("a session whose history is NEVER opened after a restart has NO mark", () => {
    // THE BOUNDARY, pinned. The mark rides `todos`, and `todos` is empty until
    // something reads the board — so a restart restores the mark for every Session
    // the user opens and for NO Session they do not. This is the accepted cost of
    // the zero-migration design (the alternative is a persisted column, an IPC
    // field and a migration, which the owner declined: "live only, fine"). Stated
    // in `interactive.ts`'s `ready` doc and in
    // `docs/features/session-ready-marker.md`; this case is what stops a reader
    // assuming the mark survives a restart on its own.
    useSessions.setState({
      activeSessionId: null,
      historySessions: [info("s-never-opened", "/x")],
    });
    expect(useInteractive.getState().todos["s-never-opened"]).toBeUndefined();
    expect(useInteractive.getState().ready["s-never-opened"]).toBeUndefined();
  });

  it("a live board is NOT overwritten by a seed that carries a different marker state", async () => {
    // The seed's own guard (`!(sessionId in todos)`) means a live board wins, and
    // the mark follows the board it was kept — a seed never rewrites the mark
    // under a board it was refused. Pinned because the guard and the mark are two
    // halves of one decision made at one call.
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
    // Unmarked, because the live board was set directly and the marker was never
    // read for it — the funnel is the ONLY writer of the mark, and the seed that
    // would have written it was (correctly) refused.
    expect(useInteractive.getState().ready["s-live"]).toBeUndefined();
  });
});

describe("deleteSession drops the ready mark", () => {
  it("a deleted Session holds no mark and no board", async () => {
    // `deleteSession` has no `onSessionClosed` to fan out through, so it calls
    // `applyTodoClear` directly — and the clear now drops the mark with the board.
    // Without that the id would sit in `ready` for the life of the window under a
    // Session that no longer has a row.
    useInteractive.getState().applyTodoUpdate("s1", board(readyItem));
    useSessions.setState({ sessions: [info("s1", "/x")] });

    await useSessions.getState().deleteSession("s1");

    expect(useInteractive.getState().todos["s1"]).toBeUndefined();
    expect(useInteractive.getState().ready["s1"]).toBeUndefined();
  });
});
