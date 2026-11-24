import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  listenAttentionAlertClicked,
  raiseAttentionWindow,
} from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { raiseAttentionFocus } from "../lib/attentionFocusSignal";
import type { AppView } from "../lib/appView";

// `App`'s content-area view union, imported from `lib/appView.ts` — the ONE
// declaration. The hook takes the SETTER, so it must accept every value the setter
// can be handed, and widening the union without widening this signature is a compile
// error at the call site rather than a silent narrowing.
//
// This used to be a local `type AppView = …` restatement, justified by a claim that
// does not hold: "the union is restated rather than imported because the direction of
// the edge is the other way (`App` imports this hook), so a shared type would have to
// live in a third module that only these two read." `App.tsx` already imports THIS
// module, so an `import type` of a union that lives in a fourth adds no edge to
// `App`'s graph at all, and `verbatimModuleSyntax` compiles the type-only import to
// nothing — it cannot add a runtime edge to anyone's. The shared module is
// `lib/appView.ts`, and it holds nothing but the union, so `layerBoundary.test.ts` is
// satisfied by construction.
//
// WHAT THE HOOK DOES WITH ANY GIVEN VALUE is nothing beyond step 2, and that is
// correct: step 2 leaves whatever non-workspace view is up for the workspace, so a new
// arm needs no case here. A `switch` would be the shape that silently forgot.

/**
 * The APP-SCOPED attention-alert click listener (ADR 0038/0039's client half).
 * Mounted with `App` beside `useAttentionAlert()` — NOT with the workspace,
 * which every non-workspace view UNMOUNTS: an alert legitimately fires while
 * any of them is open, and a listener mounted inside the ternary would not exist
 * at the moment the click arrives.
 *
 * The five steps, IN ORDER (the spec's; do not re-order):
 *
 *   1. dead-token GUARD — membership across `sessions` / `historySessions` /
 *      `archivedSessions`. `openSession` provides NO guard of its own: it sets
 *      `activeSessionId` unconditionally and its `loadHistory` returns an EMPTY
 *      page for an unknown id, so without this a stale alert selects a phantom
 *      Session. A token may legitimately sit in TWO lists (a resumed archived
 *      Session stays in `archivedSessions` while live, ADR 0016), so the test is
 *      membership-in-ANY, never "exactly one list".
 *   2. `setView("workspace")` — the non-workspace arms unmount the workspace,
 *      so without this the click selects a Session and paints the Settings page.
 *      The FUNCTIONAL-updater form reads live state (this callback runs in a
 *      Tauri event handler, outside React, so a captured `view` would be a stale
 *      closure) and React's `Object.is` bailout makes the already-workspace case
 *      a no-op re-render.
 *   3. `openSession(token)` — the EXISTING store action: it sets
 *      `activeSessionId`, moves `activeSpacePath` to the owning Space (matched
 *      by `cwd` across live/stored/archived membership) and loads the transcript
 *      when absent. No new store action.
 *   4. `raiseAttentionWindow()` — best-effort, fire-and-forget; a rejection is
 *      ONE log line, because navigation (steps 1–3 + 5) is the guaranteed half
 *      and the raise is not (no activation token exists under Wayland — the spec
 *      records that as a gap, not a claim).
 *   5. `raiseAttentionFocus(token)` — the one-shot "scroll this transcript to
 *      the bottom" signal the gate renders behind (the gate card lives in
 *      Virtuoso's Footer, so the bottom IS the question). Raised LAST and
 *      through a module rather than React state because the callback runs
 *      OUTSIDE React: `setView` + `openSession` are synchronous, so the signal
 *      is pending before React has mounted the new Session's
 *      `TranscriptScroller` — and for a stored Session, while its transcript is
 *      still empty.
 *
 * `console.warn` is the ONE log function here, deliberately: `console.error` in
 * `useAttentionAlert.ts` narrates armed-COMMAND failures (`logFailure` —
 * `attention_arm` / `attention_disarm` rejections). Both lines below are
 * client-side BEST-EFFORT outcomes instead — a stale alert dropped by the guard,
 * and a window raise that refused — so `error` would cry red for states the app
 * handled correctly.
 *
 * The effect's cleanup repeats the big-listener effect's `unlistenPromises`
 * pattern exactly (the wrapper's `listen()` is async, so cleanup must await the
 * pending registration before unlistening): React StrictMode re-runs the effect
 * in dev, and a stale listener that never gets unregistered doubles every event.
 */
export function useAttentionAlertClick(
  setView: Dispatch<SetStateAction<AppView>>,
): void {
  useEffect(() => {
    const unlistenPromise = listenAttentionAlertClicked((payload) => {
      const token = payload.token;

      // 1. Guard the dead token. The direct `.some` over the three arrays is
      //    the exact membership test (`sessionFieldOf`'s `??` walk would also
      //    work here, since `cwd` is a required field, but it reads as a field
      //    lookup rather than as membership — this is membership).
      const state = useSessions.getState();
      const known =
        state.sessions.some((r) => r.sessionId === token) ||
        state.historySessions.some((r) => r.sessionId === token) ||
        state.archivedSessions.some((r) => r.sessionId === token);
      if (!known) {
        // One line, no store write, no raise, no signal. The token is the
        // already-resolved PARENT id (`attentionAlertText` computes
        // `ctx.parents[trigger.sessionId] ?? trigger.sessionId`), so a token
        // naming a Subagent entry would land here too — dropping it is the safe
        // direction, since a child's gate is answered in its PARENT's transcript
        // and a parent row that is gone is gone.
        console.warn(
          `attention-alert-clicked: no session matches token "${token}", ignoring`,
        );
        return;
      }

      // 2. Leave whatever non-workspace view is up (no-op when already there).
      //     Functional form, so it holds for an arm added later without a case here.
      setView((current) => (current === "workspace" ? current : "workspace"));

      // 3. Select the Session (and its Space) and load its transcript.
      useSessions.getState().openSession(token);

      // 4. Raise the window — best-effort, and swallowed into a log line so a
      //    refusal cannot undo the navigation that just happened.
      void raiseAttentionWindow().catch((e) =>
        console.warn("attention-alert-clicked: window raise failed", e),
      );

      // 5. Tell the transcript to focus itself once it is mounted.
      raiseAttentionFocus(token);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [setView]);
}
