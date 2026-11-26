import type { StoreApi } from "zustand";
import {
  moveTask as moveTaskCommand,
  type StageWithTasks,
} from "../lib/tauri";
import { describeIpcError } from "../lib/ipcError";

/**
 * The **cross-column move** — the one verb that changes which column a card lives in.
 *
 * ## Why this lives beside the store and not inside it
 *
 * `src/store/tasks.ts` is baselined at 710 code lines in
 * `scripts/file-size-baseline.txt` and the ratchet refuses a baselined file gaining
 * even one. The move verb is 58 code lines of it, and the mark-done node signal needs
 * a SECOND arm on that verb — a move whose endpoints an auto-advance chain declared
 * rather than a board slice confirmed (D19). Two arms of one write, plus the wiring,
 * do not fit in the headroom, so the verb moved here rather than the ledger moving.
 * That is the shape `AGENTS.md` prescribes anyway: *the default move is to extract*,
 * and ADR 0113's mirror rule gives the new file its test sibling.
 *
 * ## The two arms, and why the second one exists
 *
 *  - `BOARD_REQUIRED` (the default, and every existing caller) refuses when no slice
 *    is loaded: a drag whose endpoints the store cannot see is a stale gesture, and
 *    `null` — "this action cannot say where the card is" — is the only true answer.
 *  - `NO_BOARD` is the arm an advice-driven launch passes. It exists because the
 *    whole feature runs where no board is mounted: `App`'s view ternary makes the
 *    board and `ChatStream` mutually exclusive, so the Session that claims is settled
 *    in a window that has never read a board. Refusing there is what left
 *    `workflow_runs` holding zero rows against 456 Sessions — the decision moved to
 *    Rust (which reads the database), and the ACT stayed slice-bound.
 *
 *  The slice-free arm **skips the optimistic paint and skips the revert**, and both
 *  skips are forced rather than chosen: the paint maps `columns` (there are none) and
 *  the revert re-reads `boardsBySpace[spacePath]` (still none), so a paint would store
 *  a key holding `undefined` and a revert would answer `null` — which
 *  `taskLaunch.launchTaskSession` turns into a throw and the chain into
 *  `launch_refused` **on a move that actually succeeded**. So this arm answers
 *  `toStageSlug` on success and `null` on rejection, and nothing else.
 *
 *  Skipping is also the cheaper half of the contract: an unloaded slice costs the
 *  PAINT and not the WRITE. `tasks.ts` already reasons exactly this way about the
 *  Stage writes ("the command is the truth either way"), and the same argument binds
 *  harder here because the caller is not a person watching for a repaint.
 */

/** The slice a move paints into, spelled without the store's actions.
 *
 *  `tasks.ts`'s `BoardState` EXTENDS this, so the two cannot drift: the verb writes
 *  exactly these three fields and no others, and the type is what says so. */
export interface BoardSlice {
  /** Space path → that Space's columns, each carrying its own cards (NESTED:
   *  `{ stage, tasks }` — the wire shape `get_board` returns). Absent = never
   *  loaded, which is NOT the same answer as "loaded and empty". */
  boardsBySpace: Record<string, StageWithTasks[]>;
  /** Space path → the last `moveTask` warning that has not been dismissed.
   *
   *  KEYED BY SPACE and stored SEPARATELY from the board because it is not a row
   *  and not a failure: `MoveTaskOutcome.boostNote` says the card moved into a
   *  `compact` column whose boost did not fire (spec §5's caveat 2 — a stored
   *  Session makes the compaction a silent no-op). Holding it here is what lets
   *  the board say so instead of rendering a successful-looking drag that quietly
   *  did half its job. */
  boostNotes: Record<string, string>;
  error: string | null;
}

/** Whether a move is allowed to proceed with no board slice loaded.
 *
 *  A mode and not a boolean, because the name is the documentation at the call site
 *  and a bare `true` in `moveTask(SPACE, id, slug, true)` says nothing about which of
 *  the two contracts the caller means.
 *
 *  The arm keys on the MODE and not on `columns === undefined` on purpose: a person's
 *  drag that races a board unload must still refuse (painting nothing and writing
 *  something is the worst of both), and only a caller that declared "there is no
 *  board here, and I do not need one" gets the slice-free contract. When a slice
 *  happens to BE loaded, this mode takes the full verb — the paint is free and a
 *  person watching the board should see the card move. */
export type MoveTaskMode = "board-required" | "no-board";

/** Every existing caller's mode, spelled as the default so no call site changes. */
export const BOARD_REQUIRED: MoveTaskMode = "board-required";
/** The advice-driven launch's mode: a missing slice is not a refusal. */
export const NO_BOARD: MoveTaskMode = "no-board";

/** The cross-column drop: writes `stage_slug` and runs the destination's `onEnter`.
 *  Optimistic, reverted on rejection.
 *
 *  Resolves with **the column the card is in when it settles** — the stage slug, or
 *  `null` for "there is no board here, so this action cannot say where anything is"
 *  (`BOARD_REQUIRED`), or "the write was refused and there was no board to read the
 *  card's real column out of" (`NO_BOARD`).
 *
 *  It NEVER rejects (a drop handler must not throw out of a drop), and the
 *  swallow-and-revert is exactly what a drag handler needs, so the paint a person sees
 *  is unchanged either way.
 *
 *  THE RETURN IS THE FACT THE SWALLOW USED TO LOSE, and a second surface now depends
 *  on it: `store/taskLaunch.launchTaskSession` compares this against the column it
 *  meant to move into, because a backend refusal (`StrictMoveRefused` under
 *  `board_strict`, or a card that is not in this Space) reverts the paint and lands in
 *  `error` — which renders only if a board or a canvas happens to be mounted, and an
 *  unattended auto-advance chain has neither. Without the return value a refused move
 *  read as a successful launch, and the Session that started carried a `<task stage>`
 *  naming a column the card is not in. THE REPO LESSON: a swallow that a second surface
 *  depends on must RETURN the fact it swallowed; an `error` field is not a channel when
 *  the surface that reads it may not exist. */
export async function moveTaskVerb(
  set: StoreApi<BoardSlice>["setState"],
  get: () => BoardSlice,
  spacePath: string,
  taskId: string,
  toStageSlug: string,
  mode: MoveTaskMode = BOARD_REQUIRED,
): Promise<string | null> {
  const columns = get().boardsBySpace[spacePath];
  if (columns === undefined) {
    if (mode === NO_BOARD) return moveWithoutBoard(spacePath, taskId, toStageSlug);
    // `null` is "this action cannot say where the card is", and it is the only answer
    // that is true here — there is no slice to read the position out of.
    set({ error: "No board loaded for this Space." });
    return null;
  }
  // A board element is a `TaskCardView` (issue #174): the card's own fields live
  // under `.task`, so every read of a card here reaches through it. The WRAPPER is
  // carried along untouched by the spread below, which is what keeps the optimistic
  // slice's `sessions`/`costUsd` standing instead of quietly dropping them — and
  // that sentence is now PINNED, not prose: `carries the card's sessions and cost
  // across the drop (the chip survives a drag)` in `tasks.test.ts` moves a card
  // with TWO links and a non-null cost. Every other `moveTask` case moves a card
  // built with `sessions: []`/`costUsd: null`, which a mutation dropping both would
  // have satisfied.
  const from = columns.find((c) => c.tasks.some((t) => t.task.id === taskId));
  const to = columns.find((c) => c.stage.slug === toStageSlug);
  // A drag whose endpoints are not both in the loaded board is a STALE gesture
  // (the board reloaded mid-drag). Refusing beats inventing a column.
  //
  // The refused arms still ANSWER, and with the card's real column rather than the one
  // that was asked for: a caller that meant to move it must be able to see that it did
  // not. `null` only when the source column cannot be found at all — no slice position
  // is knowable then, and an invented one is worse.
  if (!from || !to || from.stage.slug === toStageSlug) {
    return from ? from.stage.slug : null;
  }

  // THE OPTIMISTIC SLICE, and the value the revert restores. The card moves to
  // the END of the destination column: within-column position is the OTHER verb
  // (`reorderTasks`), so a cross-column drop appends and leaves ordering alone.
  const moved = from.tasks.find((t) => t.task.id === taskId)!;
  const previous = columns;
  const next: StageWithTasks[] = columns.map((c) => {
    if (c.stage.slug === from.stage.slug) {
      return { ...c, tasks: c.tasks.filter((t) => t.task.id !== taskId) };
    }
    if (c.stage.slug === toStageSlug) {
      // `stageSlug` travels with the card. Leaving it pointing at the column it
      // left would make the NEXT drag read a stage the card is no longer in.
      return {
        ...c,
        tasks: [
          ...c.tasks,
          { ...moved, task: { ...moved.task, stageSlug: toStageSlug } },
        ],
      };
    }
    return c;
  });
  set((state) => ({
    boardsBySpace: { ...state.boardsBySpace, [spacePath]: next },
    // A fresh move clears the previous warning: it described a DIFFERENT drop,
    // and leaving it up would attribute an old note to a new drag.
    boostNotes: (() => {
      if (!(spacePath in state.boostNotes)) return state.boostNotes;
      const rest = { ...state.boostNotes };
      delete rest[spacePath];
      return rest;
    })(),
  }));

  try {
    const outcome = await moveTaskCommand(spacePath, taskId, toStageSlug);
    // `boostNote` is a WARNING, not a failure — the card moved. Rendering it is
    // spec §5's caveat 2 made visible: a `compact` column with no live Session
    // compacts NOTHING, and a drag that looked perfect while quietly skipping
    // its side effect is this repo's documented silent-green shape.
    if (outcome.boostNote) {
      set((state) => ({
        boostNotes: { ...state.boostNotes, [spacePath]: outcome.boostNote! },
      }));
    }
    return toStageSlug;
  } catch (err) {
    // Restore the slice this action replaced — do NOT refetch. `get_board` seeds
    // stage rows on read, so a refetch is a WIDER mutation than the one being
    // undone, and the rejected command wrote nothing (one transaction).
    set((state) => ({
      boardsBySpace: { ...state.boardsBySpace, [spacePath]: previous },
      error: describeIpcError(err),
    }));
    console.error(`Failed to move task ${taskId} to ${toStageSlug}:`, err);
    // THE SWALLOWED REFUSAL, RETURNED. The paint is back to `previous`, so the honest
    // answer is the column the card is in AFTER the revert — read from the restored
    // slice rather than asserted from `from.stage.slug`, so the answer and the state a
    // caller can observe cannot diverge.
    const reverted = get().boardsBySpace[spacePath];
    const landedIn = reverted?.find((c) => c.tasks.some((t) => t.task.id === taskId));
    return landedIn?.stage.slug ?? null;
  }
}

/** The slice-free arm (D19): one write, no paint, no revert, and no claim about
 *  where the card is beyond the one the caller asked for.
 *
 *  `boostNote` is DISCARDED here and that is a real cost, stated: a chain that moves a
 *  card into a `compact` column whose boost did not fire gets no amber note, because
 *  the note's only surface is a board that by definition is not mounted. The card
 *  still moved and the Session still starts, which is the half the chain is for.
 *
 *  `error` is NOT written on rejection either, for the same reason — and it is the
 *  honest half: the caller reads the `null` and records the refusal in the transcript
 *  of the Session that caused it, which is the one surface guaranteed to be on screen.
 *  Writing the store's `error` would put the sentence where nobody is looking and
 *  imply a second, unowned report of the same failure. */
async function moveWithoutBoard(
  spacePath: string,
  taskId: string,
  toStageSlug: string,
): Promise<string | null> {
  try {
    await moveTaskCommand(spacePath, taskId, toStageSlug);
    return toStageSlug;
  } catch (err) {
    console.error(`Failed to move task ${taskId} to ${toStageSlug}:`, err);
    return null;
  }
}
