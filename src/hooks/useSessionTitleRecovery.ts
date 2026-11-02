import { useEffect } from "react";
import { listSessions } from "../lib/tauri";
import { useSessions } from "../store/sessions";

/**
 * Title recovery (#143) — the pull that backstops the push.
 *
 * The problem: for a LIVE Session the `session-titled` push is the generated
 * title's ONLY route to the UI. `listSessions` runs once at boot (`App.tsx`),
 * and the push rides a `broadcast` channel whose `Lagged` arm drops frames — so
 * one missed frame strands the label until the app restarts. That is the
 * user-visible half of #143 ("updates late, or never, and a restart fixes it").
 *
 * The fix: re-read the stored rows when the user looks at the window again, and
 * hand them to `mergeRefreshedSessionRows`, which since #143 carries a
 * non-empty `title` onto every list holding the id — live included — while
 * touching NOTHING about membership. Level-triggered from the DOM rather than
 * edge-triggered off one droppable frame: a lost push now costs one focus.
 *
 * Why these two events, and not the Tauri ones:
 *
 * - `window` `focus` + `document` `visibilitychange` are the repo's established
 *   idiom for "the user came back" (`EmptyStateFilm` registers exactly these to
 *   park its animation). Focus covers alt-tabbing back; visibility covers
 *   switching to another tab in the same webview.
 * - `listenWindowState` is NOT usable: its payload carries only
 *   `isTiled`/`isMaximized`/`isFullscreen`, so regaining focus with unchanged
 *   geometry emits nothing — i.e. it cannot see the event this hook exists for.
 *
 * What this hook must NOT do:
 *
 * - Call anything but `listSessions`. `sessionRecency()` and `listSpaces()` are
 *   boot-only: `App.test.tsx` pins `sessionRecency` to exactly one call, and
 *   re-running `setSpaces` re-seeds `committedTrusted` and can move the selected
 *   tab.
 * - Re-run `setHistorySessions`. That action re-SPLITS the lists by the archived
 *   flag and its own comment forbids running it mid-run (it would drop the
 *   sticky live+archived pair). Hence the MERGE, not the boot setter.
 * - Throttle, poll, or debounce. Focus-driven is the requirement; a timer would
 *   be IPC the user never asked for.
 *
 * The one hazard a refresh introduces is losing a label it did not win: a
 * `list_sessions` row legitimately answers `title: NULL` for a Session this
 * store already labels. That is defended in the merge (non-empty titles only),
 * and pinned from here by `useSessionTitleRecovery.test.ts`.
 */

/**
 * One read at a time. Module scope rather than a `useRef` because the guard is
 * about the IPC, not about a render: `App` mounts this hook once, but a
 * dev-mode StrictMode double-mount (or any future second mount) must still not
 * issue two overlapping reads. Reset in a `finally` so a rejection cannot stick
 * it for the rest of the app run.
 */
let inFlight = false;

export function useSessionTitleRecovery(): void {
  useEffect(() => {
    const refresh = (): void => {
      if (inFlight) return;
      inFlight = true;
      listSessions(true)
        .then((rows) => useSessions.getState().mergeRefreshedSessionRows(rows))
        .catch((err) =>
          // A failed recovery is invisible: the label simply stays as it was.
          // Log it (a silent catch would hide a broken IPC from a supporter's
          // console) and never let it reject unhandled.
          console.error("session title recovery failed:", err),
        )
        .finally(() => {
          inFlight = false;
        });
    };

    const onFocus = (): void => refresh();
    const onVisibilityChange = (): void => {
      // Only a REVEAL refreshes. A document going hidden is nobody looking at
      // this window, and an app run that lives in one window would otherwise
      // pay an IPC on every tab switch away.
      if (document.hidden) return;
      refresh();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
