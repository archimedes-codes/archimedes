import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { createElement, useState } from "react";
import {
  listenAttentionAlertClicked,
  raiseAttentionWindow,
} from "../lib/tauri";
import { useSessions } from "../store/sessions";
import {
  getAttentionFocusRequest,
  setAttentionFocusRequest,
  subscribeAttentionFocus,
} from "../lib/attentionFocusSignal";
import { useAttentionAlertClick } from "./useAttentionAlertClick";

/**
 * The APP-SCOPED Attention-alert click listener, tested through the hook that
 * owns it (the `useAppShortcuts.test.ts` host pattern: the hook needs a mounted
 * component for its effect to attach). The host owns a `view` state because the
 * hook's ONE argument is `App`'s `setView` — `view` is `useState` in `App`, not
 * store state, so nothing outside a component can supply a real setter. The
 * committed value is published through `data-view`, which is what the view
 * assertions read.
 *
 * Every case drives the callback the hook handed to the registration mock —
 * that closure IS what the webview invokes per `attention-alert-clicked` event.
 *
 * MOCKS THE BARREL BY PATH, which is what moves
 * `src/lib/tauriBarrel.test.ts`'s mocker census (that file counts them; the
 * orchestrator moves the number — this file may not edit it).
 */

// The `importActual` seam (AGENTS.md): this factory spreads the real barrel, so
// any export NOT listed here resolves to the REAL wrapper, which reaches
// `invoke`/`listen` and rejects in jsdom (`window.__TAURI_INTERNALS__` is
// undefined). `listenAttentionAlertClicked` (the hook's registration) and
// `raiseAttentionWindow` (its best-effort raise) are the two this hook touches.
// `loadHistory` is here for the reason `App.test.tsx` mocks it: step 3 calls the
// REAL `openSession`, whose transcript fetch would otherwise hit the real
// `invoke` and print a `failed to load history` line per case — green-but-noisy
// tests hide a real fetch failure.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    listenAttentionAlertClicked: vi.fn().mockResolvedValue(() => {}),
    raiseAttentionWindow: vi.fn().mockResolvedValue(undefined),
    loadHistory: vi
      .fn()
      .mockResolvedValue({ rows: [], hasMore: false, todos: null }),
  };
});

type View = "workspace" | "settings" | "board";

/** The host: owns the `view` state whose setter the hook is handed, and paints
 *  the committed value so a case can assert the view switch. */
function Host({ initialView = "workspace" }: { initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  useAttentionAlertClick(setView);
  return createElement("div", { "data-testid": "host", "data-view": view });
}

function renderHost(initialView?: View) {
  return render(
    createElement(Host, initialView ? { initialView } : null),
  );
}

/** The view the host committed. */
function viewOf(): string | null {
  return document
    .querySelector('[data-testid="host"]')!
    .getAttribute("data-view");
}

/** The last callback the hook registered (the mock's call list is cleared per
 *  case, so this is the live mount's registration). */
function clickCallback(): (payload: { token: string }) => void {
  const calls = vi.mocked(listenAttentionAlertClicked).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

const liveRow = {
  sessionId: "s-live",
  cwd: "/tmp/alpha",
  capabilities: {},
  archived: false,
  title: "Live session",
};
const storedRow = {
  sessionId: "s-stored",
  cwd: "/tmp/beta",
  capabilities: {},
  archived: false,
  title: "Stored session",
};
const archivedRow = {
  sessionId: "s-archived",
  cwd: "/tmp/gamma",
  capabilities: {},
  archived: true,
  title: "Archived session",
};

beforeEach(() => {
  // The focus signal is MODULE-scoped: it outlives every case in this file (see
  // the warning in `lib/attentionFocusSignal.ts`). A leaked pending request
  // makes a later case's "the signal is null" assertion fail for the wrong
  // reason — and the reverse assertion pass for the wrong reason too.
  setAttentionFocusRequest(null);
  vi.mocked(listenAttentionAlertClicked).mockClear();
  vi.mocked(listenAttentionAlertClicked).mockResolvedValue(() => {});
  vi.mocked(raiseAttentionWindow).mockClear();
  vi.mocked(raiseAttentionWindow).mockResolvedValue(undefined);
  // The store is module-scoped too: anything seeded here leaks into the next
  // case in this file unless it is reset.
  useSessions.setState({
    spaces: [
      { path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false },
      { path: "/tmp/beta", createdAt: 2, lastOpenedAt: 2, trusted: false },
      { path: "/tmp/gamma", createdAt: 3, lastOpenedAt: 3, trusted: false },
    ],
    sessions: [liveRow],
    historySessions: [storedRow],
    archivedSessions: [archivedRow],
    activeSessionId: "s-live",
    activeSpacePath: "/tmp/alpha",
    messages: {},
  });
});

describe("useAttentionAlertClick (the app-scoped attention-alert click listener)", () => {
  it("registers once per mount and awaits the pending registration on unmount (the StrictMode double-mount shape)", async () => {
    const unlisten = vi.fn();
    vi.mocked(listenAttentionAlertClicked).mockResolvedValue(unlisten);
    const { unmount } = renderHost();
    expect(listenAttentionAlertClicked).toHaveBeenCalledTimes(1);

    // `listen()` is async, so the cleanup must await the pending registration
    // before unlistening: React StrictMode re-runs the effect in dev, and a
    // stale listener that never gets unregistered doubles every event. This
    // case pins the cleanup's SHAPE (await-then-unlisten, swallowing a
    // rejection); the idempotency of the double CONSUMPTION is pinned in
    // `MessageList.scroll.test.tsx`'s same-nonce case.
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("a live token opens that Session, leaves the workspace view alone, raises the window and raises the signal", async () => {
    renderHost();

    act(() => {
      clickCallback()({ token: "s-live" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(useSessions.getState().activeSessionId).toBe("s-live");
    expect(viewOf()).toBe("workspace");
    expect(raiseAttentionWindow).toHaveBeenCalledTimes(1);
    expect(getAttentionFocusRequest()).toEqual({
      sessionId: "s-live",
      nonce: expect.any(Number),
    });
  });

  it("a STORED token (historySessions) moves activeSessionId AND activeSpacePath to the owning Space", async () => {
    renderHost();

    act(() => {
      clickCallback()({ token: "s-stored" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(useSessions.getState().activeSessionId).toBe("s-stored");
    // The store's `openSession` matched the owner by `cwd` across STORED
    // membership — the Space tab follows the Session.
    expect(useSessions.getState().activeSpacePath).toBe("/tmp/beta");
    expect(getAttentionFocusRequest()?.sessionId).toBe("s-stored");
    expect(raiseAttentionWindow).toHaveBeenCalledTimes(1);
  });

  it("an ARCHIVED token (archivedSessions) passes the guard — membership in ANY of the three lists", async () => {
    renderHost();

    act(() => {
      clickCallback()({ token: "s-archived" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Membership-any is load-bearing, never "exactly one list": a RESUMED
    // archived Session sits in `sessions` AND `archivedSessions` at once
    // (ADR 0016), and an archived-only row lives in `archivedSessions` alone.
    expect(useSessions.getState().activeSessionId).toBe("s-archived");
    expect(useSessions.getState().activeSpacePath).toBe("/tmp/gamma");
    expect(getAttentionFocusRequest()?.sessionId).toBe("s-archived");
  });

  it("a DEAD token logs one line and writes NOTHING (no store write, no raise, no signal)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderHost();

      act(() => {
        clickCallback()({ token: "ghost" });
      });
      await act(async () => {
        await Promise.resolve();
      });

      // `openSession` provides NO guard of its own — it sets `activeSessionId`
      // unconditionally and its `loadHistory` returns an EMPTY page for an
      // unknown id — so this trio is what proves the guard blocked it: the
      // selection never moved, the Space never moved, and nothing was queued
      // for the transcript to consume.
      expect(useSessions.getState().activeSessionId).toBe("s-live");
      expect(useSessions.getState().activeSpacePath).toBe("/tmp/alpha");
      expect(getAttentionFocusRequest()).toBeNull();
      expect(raiseAttentionWindow).not.toHaveBeenCalled();
      expect(viewOf()).toBe("workspace");
      // ONE line, and it is a `warn`, deliberately: `console.error` in
      // `hooks/useAttentionAlert.ts` narrates armed-COMMAND failures
      // (`logFailure`); a dropped stale alert and a best-effort raise refusal
      // are client-side outcomes, not a failed command.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("no session matches");
      expect(warn.mock.calls[0][0]).toContain("ghost");
    } finally {
      warn.mockRestore();
    }
  });

  it('a valid token while the view is "settings" switches back to the workspace', async () => {
    // The unmount trap's regression pin at the hook level: the Settings and
    // Board arms of `App`'s view ternary UNMOUNT the workspace, so without
    // step 2 the click would select a Session and paint the Settings page.
    renderHost("settings");
    expect(viewOf()).toBe("settings");

    act(() => {
      clickCallback()({ token: "s-stored" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(viewOf()).toBe("workspace");
    expect(useSessions.getState().activeSessionId).toBe("s-stored");
  });

  it("the order is openSession → raise → signal (the raise lands on the already-selected Session)", async () => {
    // The spec's order, in its strictest form: what the STORE says at the
    // instant the raise runs. The signal module is real here (not a mock), so
    // the focus half is recorded through its own subscription — the notify is
    // synchronous, so the entry lands in the array at the raise's instant.
    const order: string[] = [];
    const unsubscribe = subscribeAttentionFocus(() => {
      order.push(`focus:${getAttentionFocusRequest()?.sessionId ?? "drained"}`);
    });
    vi.mocked(raiseAttentionWindow).mockImplementation(async () => {
      // An `async` body runs synchronously up to its first `await`, so this
      // reads the store at the moment the listener called the raise.
      order.push(`raise:${useSessions.getState().activeSessionId}`);
    });
    try {
      renderHost();

      act(() => {
        clickCallback()({ token: "s-stored" });
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(order).toEqual(["raise:s-stored", "focus:s-stored"]);
    } finally {
      unsubscribe();
    }
  });

  it("a repeat click on the SAME Session re-raises the signal with a fresh nonce", async () => {
    renderHost();
    const onClick = clickCallback();

    act(() => {
      onClick({ token: "s-live" });
    });
    const first = getAttentionFocusRequest();
    expect(first?.sessionId).toBe("s-live");

    act(() => {
      onClick({ token: "s-live" });
    });
    const second = getAttentionFocusRequest();

    // Identity is the nonce, not the session id — the transcript's consumer
    // re-scrolls on the second click because the pending value changed.
    expect(second?.sessionId).toBe("s-live");
    expect(second?.nonce).not.toBe(first?.nonce);
  });

  it("a refused raise is a log line only — the navigation (the guaranteed half) still happens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(raiseAttentionWindow).mockRejectedValueOnce(
        new Error("raise refused"),
      );
      renderHost();

      act(() => {
        clickCallback()({ token: "s-stored" });
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(useSessions.getState().activeSessionId).toBe("s-stored");
      expect(getAttentionFocusRequest()?.sessionId).toBe("s-stored");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("window raise failed");
    } finally {
      warn.mockRestore();
    }
  });
});
