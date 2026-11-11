import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAttentionFocusRequest,
  raiseAttentionFocus,
  setAttentionFocusRequest,
  subscribeAttentionFocus,
} from "./attentionFocusSignal";

// The pending request is MODULE-SCOPED (no store, no React): a request left
// raised by one case is still pending for the next one — and for every later
// test FILE that mounts the transcript, which would consume it with one extra
// scroll-to-bottom. Start each case from the drained side. Same rule (and the
// same reason) as `newSpaceDialogState.test.ts`.
beforeEach(() => {
  setAttentionFocusRequest(null);
});

describe("attentionFocusSignal", () => {
  it("starts drained on a FRESH module (no seeding: a focus jump on launch names no click)", async () => {
    // `vi.resetModules()` + a dynamic import is the only honest way to read the
    // DEFAULT: the value is module state, so the instance this file's static
    // `import` bound to has already been written by the `beforeEach` above. The
    // re-import is a SEPARATE instance (its own pending value, its own nonce
    // counter, its own listeners); the static one is untouched.
    vi.resetModules();
    const fresh = await import("./attentionFocusSignal");
    expect(fresh.getAttentionFocusRequest()).toBeNull();
    // Nothing at import time reached for storage to seed it — this module has
    // NO storage key at all (a click is not a preference).
    expect(localStorage.length).toBe(0);

    // The FRESH instance is also where the nonce starts at 1: the static
    // instance's counter is shared by every case in this file, so an absolute
    // nonce value means nothing there (the cases below assert RELATIVE nonces
    // on it, which is the property that actually matters).
    const notify = vi.fn();
    const unsubscribe = fresh.subscribeAttentionFocus(notify);
    fresh.raiseAttentionFocus("s1");
    expect(fresh.getAttentionFocusRequest()).toEqual({
      sessionId: "s1",
      nonce: 1,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    // A REPEAT click on the SAME Session must re-fire: a fresh nonce, and a
    // fresh notification. Re-using the session id as the identity is the bug
    // this module exists to avoid — the second click would be an echo.
    fresh.raiseAttentionFocus("s1");
    expect(fresh.getAttentionFocusRequest()).toEqual({
      sessionId: "s1",
      nonce: 2,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("persists nothing: no storage key exists, so a reload cannot re-play the focus jump", () => {
    raiseAttentionFocus("s1");
    expect(localStorage.length).toBe(0);
    localStorage.clear();
    expect(getAttentionFocusRequest()?.sessionId).toBe("s1");
  });

  it("raiseAttentionFocus() writes the pending request and notifies once", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeAttentionFocus(notify);
    const first = getAttentionFocusRequest()?.nonce;

    raiseAttentionFocus("s1");

    const raised = getAttentionFocusRequest();
    expect(raised?.sessionId).toBe("s1");
    expect(typeof raised?.nonce).toBe("number");
    // A fresh nonce per raise (the counter is monotonic), so this raise is not
    // the value that was pending before it.
    expect(raised?.nonce).not.toBe(first);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("setAttentionFocusRequest(null) drains the pending value and notifies once", () => {
    raiseAttentionFocus("s1");
    const notify = vi.fn();
    const unsubscribe = subscribeAttentionFocus(notify);

    setAttentionFocusRequest(null);

    expect(getAttentionFocusRequest()).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    // Draining twice is the same-value echo: the consumer's drain must not
    // notify a second subscriber into a second scroll.
    setAttentionFocusRequest(null);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does NOT notify when the same nonce is written again (the same-value echo)", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeAttentionFocus(notify);
    const req = { sessionId: "s1", nonce: 42 };
    setAttentionFocusRequest(req);
    // A different OBJECT carrying the SAME nonce is the same request (identity
    // is the nonce, not the reference) — `useSyncExternalStore` re-reads the
    // snapshot and must not see a new value from an echo.
    setAttentionFocusRequest({ sessionId: "s1", nonce: 42 });
    expect(notify).toHaveBeenCalledTimes(1);
    // A new nonce IS a new request (the repeat click).
    setAttentionFocusRequest({ sessionId: "s1", nonce: 43 });
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("stops notifying after the returned unsubscribe runs", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeAttentionFocus(notify);
    raiseAttentionFocus("s1");
    expect(notify).toHaveBeenCalledTimes(1);
    setAttentionFocusRequest(null);
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    raiseAttentionFocus("s1");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(getAttentionFocusRequest()?.sessionId).toBe("s1");
  });
});
