import { useEffect, useRef } from "react";
import { useSessions } from "../store/sessions";
import { useTasks } from "../store/tasks";

/**
 * Re-read the **Task board** when a **turn settles** — the repaint gap §2 item 3 of
 * `docs/features/task-board-known-gaps.md` records ("a card the model writes is
 * invisible until the board is remounted").
 *
 * ## Why this trigger, and not an event
 *
 * There is no task/board Tauri event, and this adds none — the desktop emits
 * `interactive-request`, `permission-request` and `window-state-changed` plus the
 * session/interactive/subagent frames, and a new one would be a Rust change on a
 * branch that is TypeScript-only by design. The candidates the frontend ALREADY
 * receives were checked against the Rust rather than assumed:
 *
 *  - **`agent_settled` is the engine's settle frame and the desktop deliberately does
 *    not forward it.** `router.rs`'s `WorkerInboundEvent::Event` arm states it:
 *    *"Internal bookkeeping ONLY (NOT the `TauriSink` — forwarding would
 *    DOUBLE-DELIVER every `session-update` the loop emits both as an `RpcEvent` and
 *    as a `session-update` `SinkFrame`)"*. So no renderer event carries a settle, and
 *    `AcpSessionUpdate` has no settle discriminant either.
 *  - **`session-closed` is too rare.** It fires when the WORKER exits (a pause, a
 *    close, a crash), not per turn — a long-lived Session would never repaint a board.
 *  - **`inTurn`'s falling edge is the renderer's OWN settle, and it provably fires.**
 *    `sendPrompt` resolves on `agent_settled` (the router's `resolve_turn`), and every
 *    dispatch path calls `turnCompleted` on the far side of that await —
 *    `useChatPromptDispatch`, `usePromptQueueFlusher`, `store/taskLaunch` — which
 *    writes `inTurn[sessionId] = false`. `store/taskLaunch`'s header names it:
 *    *"`turnCompleted` is the ONLY frontend path that clears `inTurn`"*.
 *    `handleSessionClosed` clears the same flag through the close contract's spread, so
 *    a close or a crash is a fall too — correct, since a dead Worker ended the turn and
 *    any card it wrote should show.
 *
 * So the flag is read rather than an event listened for, and that is also why the hook
 * watches the FLAG and not the `turnCompleted` action: the action is not the only
 * writer, and a hook bound to one writer would miss the closes.
 *
 * ## Why ONE edge over ALL sessions, and why the hook lives on the surface
 *
 * A board shows one Space's cards, and a card's links can point at any Session, so the
 * question "did any turn just end?" is about the whole `inTurn` map, not one Session —
 * unlike `useSessionIdleEdge`, which is deliberately visible-Session-only because a
 * **Flush** must expand Mentions against the ACTIVE Session's Space. This hook has no
 * such constraint: a board re-read is per-SPACE and takes no Session at all, so a
 * background Session's settle is exactly as relevant as the visible one's.
 *
 * It is mounted by the surfaces that SHOW a board (`TasksBoard`, `WorkflowsCanvas`) and
 * not by `App`. That is a cost decision with a real reason behind it: `get_board` is not
 * a pure read — it seeds the five default stages for a Space that has none (ADR 0090's
 * lazy seeding) — so a hook at `App` level would turn every prompt in the app into a
 * stage-seeding write. Mounted on the surface, an unmounted board fires nothing, and the
 * next mount reads fresh anyway.
 *
 * ## The debounce, and why it is per-Space
 *
 * A settling turn must not fire N board reads, and a batch is the NORMAL case rather
 * than the pathological one: the auto-advance chain (`store/workflowChain`) launches a
 * Session per Stage, and the queue flusher can settle several Sessions inside one beat.
 * The timer is keyed on the Space so a Space switch cannot leave a pending read aimed at
 * the Space the user just left — and the store's epoch would drop that read anyway,
 * which is the second net under the first.
 *
 * ## Why the SILENT read
 *
 * `refresh` and not `load`: rows are already on screen, and `load` writes `loading`.
 * Both consumers happen to gate on `columns === undefined && loading` today, so the loud
 * path would not blank the board THIS commit — but a background refresh that depends on
 * a render decision three files away is one skeleton away from flashing the board on
 * every turn. `refresh` never writes the flag; see its declaration in `store/tasks`.
 */

/** How long to hold a board re-read after the last settle, in ms.
 *
 *  Long enough to swallow a batch (the auto-advance chain and the prompt-queue flusher
 *  both settle several Sessions inside a few frames), short enough that a card the model
 *  wrote feels like it arrived rather than appeared on the next visit — which is the
 *  whole point of the gap. Deliberately NOT a "refresh interval": there is no polling
 *  here, one timer per burst and then silence. */
const BOARD_AUTO_REFRESH_DEBOUNCE_MS = 350;

/** A board surface re-reads its Space's board after each burst of settled turns. */
export function useTaskBoardAutoRefresh(spacePath: string | null): void {
  // ONE subscription to the map the settle writes, through a selector that returns a
  // PRIMITIVE: "is any Session in a turn". A selector returning a fresh object or array
  // would re-render forever (the rule `useActiveSpaceCwd.ts` and `lib/sessionLookup.ts`
  // record), and the only fact this hook needs is whether the count moved off zero.
  //
  // THE EDGE IS THE FALL OF THE WHOLE MAP, and the reason a count is the right shape:
  // a fall from 2 to 1 (one of two concurrent turns settling, the other still running)
  // does NOT fire, and that is deliberate. The board is re-read once the last turn
  // clears, which is when the burst of tool writes is over — and the debounce would
  // collapse a 2→1→0 into one read anyway, so the count and a per-session edge set cost
  // the same and answer the same question with less bookkeeping.
  const anyInTurn = useSessions((s) => {
    for (const sessionId in s.inTurn) {
      if (s.inTurn[sessionId]) return true;
    }
    return false;
  });

  // The previous render's value. A REF and not state — this is edge detection, and a
  // second render for the sake of remembering is a re-render that buys nothing.
  const wasInTurn = useRef(anyInTurn);

  // The Space the pending timer is aimed at, so a Space switch can cancel it. A ref
  // because a change here must not re-run the effect below (the effect's subject is
  // `anyInTurn` and `spacePath`, and a timer id in the dep array would reschedule the
  // debounce on every unrelated re-render).
  const timer = useRef<{
    id: ReturnType<typeof setTimeout>;
    space: string;
  } | null>(null);

  useEffect(() => {
    const was = wasInTurn.current;
    wasInTurn.current = anyInTurn;
    // ONLY the fall. A rise is a turn STARTING: nothing has been written yet, and a
    // read on the rise would fire on every prompt the user sends before the model has
    // had a chance to call a tool. A level (no turn anywhere) is not an edge either.
    if (!was || anyInTurn) return;

    const space = spacePath;
    // No Space selected, no board, no read. A background Session's settle must not
    // fire a `get_board` for a Space nobody has chosen.
    if (space === null) return;

    if (timer.current !== null) clearTimeout(timer.current.id);
    const id = setTimeout(() => {
      timer.current = null;
      // Read through `getState()` rather than a subscribed action: zustand keeps an
      // action's identity for the store's life, so subscribing here would re-render the
      // board on every store write for a function the timer could resolve itself.
      void useTasks.getState().refresh(space);
    }, BOARD_AUTO_REFRESH_DEBOUNCE_MS);
    timer.current = { id, space };
  }, [anyInTurn, spacePath]);

  // The Space changed: a read still pending for the PREVIOUS Space is aimed at a board
  // the user is no longer looking at. The store's epoch would drop its answer anyway,
  // and the mount read of the new Space is already in flight — so cancelling is the
  // cheap half, not the load-bearing one.
  useEffect(() => {
    const pending = timer.current;
    if (pending !== null && pending.space !== spacePath) {
      clearTimeout(pending.id);
      timer.current = null;
    }
  }, [spacePath]);

  // Unmount: no read for a surface nobody is looking at. This is the line that keeps
  // the feature from becoming background polling — an app whose board is closed fires
  // ZERO board reads, however many turns settle.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current.id);
      timer.current = null;
    },
    [],
  );
}
