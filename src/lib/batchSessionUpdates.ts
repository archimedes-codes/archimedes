import type { AcpSessionUpdate } from "./tauri";

export interface SessionUpdateBatchItem {
  sessionId: string;
  update: AcpSessionUpdate;
}

/**
 * Coalesce high-frequency `session-update` events into ONE store update per
 * animation frame.
 *
 * Why: a local agent at a high thinking level emits ~1000 chunks/sec. The
 * Rust driver forwards every notification as its own Tauri event, and each
 * event applied as its own zustand `setState` triggers its own React render
 * pass. ~1000 renders/sec saturates the webview main thread — the GPU sits
 * idle (it has no frames to composite) and the UI renders at ~1fps.
 *
 * Batching to one `setState` per `requestAnimationFrame` caps renders at the
 * display refresh rate (~60/sec) while keeping the transcript in step with
 * the stream (a frame's worth of chunks lands together, in order).
 *
 * `schedule` is injectable (the app passes `requestAnimationFrame`; tests
 * pass a manual queue) so the coalescing is verifiable without real frames.
 *
 * ## `onAdvice` — the batcher is also the auto-advance chain's CLAIM seam
 *
 * One optional argument, and it is here rather than in `store/sessions.ts` for a reason
 * that decides whether the feature works at all. The transcript reducer has TWO store
 * callers, the singular `applySessionUpdate` and the plural `applySessionUpdates`, and
 * the PLURAL is the live path: `App.tsx` builds this batcher over `applySessionUpdates`
 * and feeds every `session-update` through it, while the singular action's only
 * production caller is `addSystemLine`. A seam in the singular action would never see a
 * live `tool_call_update`, so the claim path would do nothing while every mocked test
 * stayed green — the "looks configured, does nothing" failure this feature exists to
 * remove. This callback is `App.tsx`'s, OUTSIDE every `set` updater (so the StrictMode
 * double-invoke objection that closed the in-updater option does not bind it) and the
 * batcher is already fire-and-forget.
 *
 * It runs per FRAME, AFTER the batch has been applied to the store, and it is handed the
 * whole batch. Ordering matters: applying the batch first is what makes the claim's own
 * transcript line appear above the Session the claim starts. Deciding which items mean
 * anything is NOT this module's job — the callback owns that, because `lib/` may not
 * reach up into `store/` (`layerBoundary.test.ts`) and `store/advanceAdvice.ts` owns what
 * an advance advice IS. The hot-path cost is one call per frame over a batch the module
 * has already built, and the callback's own first check is a string compare.
 *
 * ## A DROPPED BATCH IS TOLERATED, and the settle fallback is what makes that safe
 *
 * Two ways a frame never reaches `onAdvice`, both left unfixed ON PURPOSE:
 *
 *  1. **`apply` throws.** The callback is the statement after it, so a reducer that
 *     rejects on one batch skips `onAdvice` for that batch entirely — including any claim
 *     sitting in it.
 *  2. **A batch is pending when the page goes away.** There is no flush and no dispose:
 *     `App.tsx` unlistens on unmount, but a frame already scheduled and never run dies
 *     with the module closure holding it.
 *
 * Neither gets a flush, and the reason is that the claim is NOT the only path to the
 * launch. `store/workflowChain.advanceWorkflowChainOnSettle` runs on the SETTLE of the
 * turn that claimed, asks the same Rust decider the same question, and advances the same
 * link — Rust's `task_sessions` dedupe (`alreadyLaunched`) is what stops the pair from
 * launching it twice, which is why a consumed claim makes the settle answer
 * `already_advanced` and stand down. A dropped claim therefore costs LATENCY (the card
 * advances at the settle instead of mid-turn) and not the advance. That is D14's accepted
 * cost, stated here so the next reader sees the fallback rather than reaching for a
 * `flush()` that would add a second owner of a decision Rust already owns.
 */
export function createBatchedSessionUpdate(
  apply: (items: SessionUpdateBatchItem[]) => void,
  schedule: (fn: () => void) => void,
  onAdvice?: (items: SessionUpdateBatchItem[]) => void,
): (item: SessionUpdateBatchItem) => void {
  let pending: SessionUpdateBatchItem[] = [];
  let scheduled = false;
  return (item) => {
    pending.push(item);
    if (!scheduled) {
      scheduled = true;
      schedule(() => {
        scheduled = false;
        const batch = pending;
        pending = [];
        apply(batch);
        // After `apply`, and only when a callback was actually wired — every existing
        // caller passes two arguments and must keep paying exactly what it pays today.
        // NOTE the ordering consequence, documented in the header: if `apply` throws, this
        // line is skipped and the batch's claim with it. No `try` here on purpose — that
        // throw is the reducer's failure and the frame's uncaught error is how the app
        // reports every other reducer failure, and muting it to protect the claim would
        // trade a loud break for a silent one. The claim is not lost either way: the settle
        // fallback is the safety net, which is why there is no `flush()` either.
        onAdvice?.(batch);
      });
    }
  };
}
