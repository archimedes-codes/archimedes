/**
 * The Attention-alert click's "focus this transcript" request — a tiny shared
 * module (no store, no React) whose whole job is that the request needs to
 * survive a subtree that is not mounted yet.
 *
 * WHY A MODULE AND NOT A `useState`: the raiser and the consumer live in
 * different subtrees and only one of them is guaranteed to exist at the moment
 * the click lands. The raiser is the APP-SCOPED click listener
 * (`hooks/useAttentionAlertClick`, mounted with `App` — the workspace unmounts
 * in the Settings/Board views, so a listener mounted there would not exist
 * exactly when an alert is clicked). The consumer is `MessageList`'s
 * `TranscriptScroller`, which for a stored Session is not mounted at all when
 * the raise happens: the listener runs in a Tauri event callback OUTSIDE React,
 * so it writes the store and raises this signal BEFORE React has rendered the
 * new Session's transcript. A `useState` in either half is invisible to the
 * other. Same shape of problem, same answer, as `newSpaceDialogState.ts`.
 *
 * The value is a PENDING ONE-SHOT (not a boolean flag): the consumer drains it
 * (`setAttentionFocusRequest(null)`) when it has acted, so a request cannot
 * re-fire on an unrelated later render.
 *
 * `nonce` is the identity, NOT the session id: a repeat click on an alert for
 * the SAME Session must re-fire the scroll-to-bottom, and a value compared by
 * session id would read as "already pending for that Session" — the echo rule
 * below would swallow the second click.
 *
 * NOTHING IS PERSISTED: no `STORAGE_KEY`, no `localStorage`, no seeding at
 * import. A focus jump restored on launch would scroll a transcript the user
 * never asked about.
 *
 * ⚠ THE VALUE IS MODULE-SCOPED: it outlives every component and every test
 * case. Any test file that can raise it must clear it again in a FILE-LEVEL
 * `beforeEach` — a leaked pending request makes every later `render()` in that
 * file consume it (one extra scroll/focus), and `ChatStream` re-renders on
 * every raise, so the leak is visible in tests that never touched this module.
 * The files that can raise it: `App.test.tsx`,
 * `components/chat/MessageList.scroll.test.tsx`, this file, and
 * `hooks/useAttentionAlertClick.test.ts`.
 */

export interface AttentionFocusRequest {
  sessionId: string;
  /** Monotonic int, minted by `raiseAttentionFocus`; a repeat click on the
   *  SAME Session must re-fire, so identity is the nonce, not the sessionId. */
  nonce: number;
}

let pending: AttentionFocusRequest | null = null;

/** Minted per raise, never reset — see the `nonce` field's contract. */
let nonceCounter = 0;

const listeners = new Set<() => void>();

export function getAttentionFocusRequest(): AttentionFocusRequest | null {
  return pending;
}

/**
 * Write the pending value. The echo rule is the precedent's, with the nonce as
 * the comparison: a request already pending with the SAME nonce is the same
 * request, so writing it again (even as a fresh object — a snapshot reader
 * re-reading a re-created value must not see a change) notifies nobody. A
 * different nonce, or a drain to `null`, notifies.
 */
export function setAttentionFocusRequest(
  req: AttentionFocusRequest | null,
): void {
  if (pending?.nonce === req?.nonce) return; // same-value echo: no notify
  pending = req;
  for (const fn of [...listeners]) fn();
}

/**
 * The one-shot raiser the App listener calls. A fresh nonce ALWAYS differs from
 * the pending one, so a repeat click on the same Session re-notifies — the
 * requirement the `nonce` field exists to satisfy.
 */
export function raiseAttentionFocus(sessionId: string): void {
  setAttentionFocusRequest({ sessionId, nonce: ++nonceCounter });
}

export function subscribeAttentionFocus(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
