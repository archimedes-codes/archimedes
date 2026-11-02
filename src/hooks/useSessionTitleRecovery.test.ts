import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SessionInfo } from "../lib/tauri";
import { listSessions } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useSessionTitleRecovery } from "./useSessionTitleRecovery";

/**
 * Title recovery (#143) — the pull that backstops the push.
 *
 * A live Session's generated title reaches the UI through exactly ONE route:
 * the `session-titled` push, which rides a droppable frame. One lost frame and
 * the label is stranded until the app restarts. This hook is the recovery:
 * focusing the window re-reads `list_sessions` and hands the rows to
 * `mergeRefreshedSessionRows`, which carries a non-empty title onto the live
 * row.
 *
 * So every assertion here is about the DOM-event CONTRACT, not about the merge
 * (that has its own suite in `../store/sessions.test.ts`):
 *
 * - which events refresh (`window` focus, a revealing `visibilitychange`),
 * - which do NOT (a hiding `visibilitychange` — nothing is being looked at, and
 *   an app run that spends its life in one window must issue zero IPC),
 * - that the read is `listSessions(true)` and NOTHING else (`sessionRecency`
 *   and `listSpaces` are boot-only; re-running `setSpaces` would move the
 *   selected tab),
 * - that both listeners leave when the hook does,
 * - and that a refresh cannot LOSE a label it did not win (R1) — the cases that
 *   run the REAL merge rather than a spy.
 */

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return { ...actual, listSessions: vi.fn().mockResolvedValue([]) };
});

const mockedListSessions = vi.mocked(listSessions);

/** The five `SessionInfo` wire fields, as in the store's suite. `title` is
 * `string | null | undefined` on the wire (`lib/tauri/types.ts`), so the helper
 * accepts all three shapes. */
const info = (sessionId: string, title?: string | null): SessionInfo => ({
  sessionId,
  cwd: "/x",
  capabilities: {},
  archived: false,
  ...(title === undefined ? {} : { title }),
});

/**
 * `document.hidden` is a getter jsdom reports as `false`; the revealing/hiding
 * half of the contract needs to drive it, so replace the accessor (the same
 * stub `EmptyStateFilm.test.tsx` installs).
 */
let documentHidden = false;

/** The merge action as the module first saw it.
 *
 * A `vi.spyOn(useSessions.getState(), …)` would NOT work here: zustand's `set`
 * builds a NEW state object, so a spy taken off a snapshot vanishes from the
 * first write onwards. `setState` is the supported way to replace an action.
 */
const realMerge = useSessions.getState().mergeRefreshedSessionRows;

/** Replace the store's merge action with a spy (`afterEach` puts the real one
 * back, so a spy installed by one case cannot answer for the next). */
function spyOnMerge() {
  const spy = vi.fn();
  useSessions.setState({ mergeRefreshedSessionRows: spy });
  return spy;
}

/** Drain the hook's `await listSessions(...)` chain (a macrotask flush, the
 * convention the repo's async store tests use — not a `waitFor` retry loop). */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  documentHidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => documentHidden,
  });
  mockedListSessions.mockReset();
  mockedListSessions.mockResolvedValue([]);
  useSessions.setState({
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    contextUsage: {},
    configOptions: {},
  });
});

afterEach(() => {
  useSessions.setState({ mergeRefreshedSessionRows: realMerge });
});

describe("useSessionTitleRecovery (a live Session's title recovers on focus, #143)", () => {
  it("a window focus reads the stored rows and hands them to the merge", async () => {
    const rows = [info("live-1", "Porting the session namer")];
    mockedListSessions.mockResolvedValueOnce(rows);
    const merge = spyOnMerge();

    renderHook(() => useSessionTitleRecovery());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    // The merge runs in the read's `.then`, i.e. one microtask after the event.
    await settle();

    expect(mockedListSessions).toHaveBeenCalledWith(true);
    expect(merge.mock.calls).toEqual([[rows]]);
  });

  it("mount alone fetches nothing (this is a recovery path, not a boot fetch)", () => {
    const merge = spyOnMerge();
    renderHook(() => useSessionTitleRecovery());
    expect(mockedListSessions).not.toHaveBeenCalled();
    expect(merge.mock.calls).toEqual([]);
  });

  it("a visibilitychange that REVEALS the document refreshes", async () => {
    const rows = [info("live-1", "Back from another tab")];
    mockedListSessions.mockResolvedValueOnce(rows);
    const merge = spyOnMerge();

    renderHook(() => useSessionTitleRecovery());
    act(() => {
      documentHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    expect(mockedListSessions).toHaveBeenCalledWith(true);
    expect(merge.mock.calls).toEqual([[rows]]);
  });

  it("a visibilitychange that HIDES the document refreshes nothing", () => {
    const merge = spyOnMerge();
    renderHook(() => useSessionTitleRecovery());
    act(() => {
      documentHidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mockedListSessions).not.toHaveBeenCalled();
    expect(merge.mock.calls).toEqual([]);
  });

  it("an overlapping refresh is skipped while one is in flight, and the guard releases after it", async () => {
    // Two focus events before the first read settles (alt-tab jitter, or a
    // focus racing the matching visibilitychange) must cost ONE IPC, not two —
    // and the second must not be QUEUED either: the in-flight read's rows are
    // no older than one taken a tick later.
    let release: ((rows: SessionInfo[]) => void) | undefined;
    mockedListSessions.mockImplementationOnce(
      () => new Promise<SessionInfo[]>((r) => (release = r)),
    );
    const merge = spyOnMerge();

    renderHook(() => useSessionTitleRecovery());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
      documentHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mockedListSessions).toHaveBeenCalledTimes(1);

    // The guard releases WITH the read (a `finally`, not on success only), so a
    // later focus still recovers.
    await settle();
    release?.([]);
    await settle();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mockedListSessions).toHaveBeenCalledTimes(2);
    expect(merge.mock.calls).toEqual([[[]]]);
  });

  it("a rejected refresh touches the store and still releases the guard", async () => {
    // A failed recovery is invisible to the user (the label simply stays as it
    // was) — but it must not leave the guard stuck, which would strand every
    // later focus for the rest of the app run.
    const err = console.error;
    console.error = vi.fn();
    mockedListSessions.mockRejectedValueOnce(new Error("ipc down"));
    const merge = spyOnMerge();

    renderHook(() => useSessionTitleRecovery());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(merge.mock.calls).toEqual([]);

    mockedListSessions.mockResolvedValueOnce([]);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mockedListSessions).toHaveBeenCalledTimes(2);
    console.error = err;
  });

  it("unmount removes BOTH listeners (a stale listener would double every focus)", () => {
    const merge = spyOnMerge();
    const { unmount } = renderHook(() => useSessionTitleRecovery());
    unmount();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      documentHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mockedListSessions).not.toHaveBeenCalled();
    expect(merge.mock.calls).toEqual([]);
  });

  it("a refresh whose rows carry no title cannot erase a live title the store has (R1)", async () => {
    // THE regression this hook would otherwise introduce: a `list_sessions`
    // answer that arrives WITHOUT the label the store already holds — either an
    // absent field or the explicit `NULL` the wire legitimately carries. The
    // merge's non-empty-only rule is the whole defence, so these cases run the
    // REAL merge rather than a spy.
    useSessions.setState({ sessions: [info("live-1", "Keep me")] });
    mockedListSessions.mockResolvedValue([info("live-1")]);

    renderHook(() => useSessionTitleRecovery());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(useSessions.getState().sessions[0].title).toBe("Keep me");

    mockedListSessions.mockResolvedValue([info("live-1", null)]);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(useSessions.getState().sessions[0].title).toBe("Keep me");

    mockedListSessions.mockResolvedValue([info("live-1", "")]);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(useSessions.getState().sessions[0].title).toBe("Keep me");
  });

  it("a refresh resolving [] cannot erase a live title either (R1, empty answer)", async () => {
    useSessions.setState({ sessions: [info("live-1", "Keep me")] });
    mockedListSessions.mockResolvedValue([]);

    renderHook(() => useSessionTitleRecovery());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    const st = useSessions.getState();
    expect(st.sessions.map((s) => s.sessionId)).toEqual(["live-1"]);
    expect(st.sessions[0].title).toBe("Keep me");
  });

  it("a refresh carrying a title lands it on the LIVE row (the point of the hook)", async () => {
    useSessions.setState({ sessions: [info("live-1")] });
    mockedListSessions.mockResolvedValue([
      info("live-1", "Recovered on focus"),
    ]);

    renderHook(() => useSessionTitleRecovery());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(useSessions.getState().sessions[0].title).toBe("Recovered on focus");
  });
});
