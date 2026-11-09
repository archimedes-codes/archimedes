import { create } from "zustand";
import {
  createTask as createTaskCommand,
  getBoard as getBoardCommand,
  linkSession as linkSessionCommand,
  moveTask as moveTaskCommand,
  reorderTasks as reorderTasksCommand,
  type StageWithTasks,
  type TaskRow,
} from "../lib/tauri";
import { describeIpcError } from "../lib/ipcError";

/**
 * The per-Space **Task board** store (spec §2/§3, ADR 0090).
 *
 * ONE SPACE-KEYED MAP, not a Session-keyed field list. A board belongs to a
 * **Space** (`stages.space_path` / `tasks.space_path`), so `boardsBySpace` is
 * keyed by the Space path and sibling Spaces can never collide — the same reason
 * `sessions.ts` keys its per-Session maps by session id rather than holding a
 * "current" one. There is deliberately NO `SESSION_KEYED_FIELDS`-shaped list
 * here: that mechanism exists in `sessions.ts` to enumerate fields that follow
 * the *active Session*; a Space-keyed map needs no such enumeration because the
 * key IS the identity.
 *
 * THE `as …Command` ALIASES ARE LOAD-BEARING, not decoration. This store's own
 * actions are named `moveTask`, `createTask` and `linkSession` — the same names
 * the IPC wrappers carry. Importing them bare would collide with the key being
 * defined, and worse, calling the bare name inside `moveTask:` would be INFINITE
 * RECURSION rather than a command call. Every call site below therefore names the
 * alias. (`sessions.ts` follows the identical convention for the same reason.)
 *
 * `editTask` / `getTask` are deliberately ABSENT: no board action rewrites a
 * card's text. That is the New Task modal / a later edit surface (task A5), and a
 * store that owned a second write path the UI never drives is a second owner of
 * one fact.
 *
 * THE BARREL ONLY (ADR 0074). Every IPC name arrives through `../lib/tauri` — a
 * direct `lib/tauri/commands/tasks` import bypasses the `vi.mock("../lib/tauri")`
 * seam every test here stands on, and `tauriBoundary.test.ts` /
 * `tauriBarrel.test.ts` redden on it.
 *
 * WHY THE BOARD LOADS ON MOUNT AND NOT AT BOOT. `App.tsx`'s boot
 * `Promise.all([listSpaces, listSessions, sessionRecency])` is untouched: this
 * store is loaded by `TasksBoard`'s own `useEffect`. `get_board` is not a free
 * read — it WRITES, seeding the five default stages for a Space that has none
 * (ADR 0090's lazy seeding) — so fetching it for every Space at boot would create
 * columns in Spaces whose board was never opened, and cost every launch three
 * round trips for a surface most launches never visit.
 */

/** The board plus the two things a board render needs that are NOT board rows. */
interface BoardState {
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
  loading: boolean;
  error: string | null;

  /** Read one Space's board. Resolves either way — a rejection lands in `error`. */
  load: (spacePath: string) => Promise<void>;
  /** The cross-column drop: writes `stage_slug` and runs the destination's
   *  `onEnter`. Optimistic, reverted on rejection. */
  moveTask: (spacePath: string, taskId: string, toStageSlug: string) => Promise<void>;
  /** A new card. `stageSlug` omitted lands it in the Space's FIRST stage. */
  createTask: (
    spacePath: string,
    title: string,
    body?: string | null,
    stageSlug?: string | null,
  ) => Promise<TaskRow>;
  /** Record that a Session belongs to a card. Writes no board state. */
  linkSession: (
    taskId: string,
    sessionId: string,
    stageSlug?: string | null,
  ) => Promise<void>;
  /** The within-column drop: rewrites one column's order and persists it with ONE
   *  `reorderTasks` call.
   *
   *  `ids` is that column's WHOLE visible slice in its NEW order — the same
   *  whole-slice contract `reorderSpaces`/`reorderSessions` set, and the reason the
   *  gesture hands over a list rather than a moved id. It returns `void` rather than a
   *  promise because the optimistic slice is painted synchronously and the caller
   *  (a drag handler) has nothing to await: a rejection reverts the slice and lands in
   *  `error`, which is the only channel the UI can still show it through. */
  reorderWithinStage: (spacePath: string, stageSlug: string, ids: string[]) => void;
  /** Put one Space's `boostNote` away (the warning line's dismiss). */
  dismissBoostNote: (spacePath: string) => void;
  /** Replace this store's state wholesale — the store-owned half of isolation. */
  reset: () => void;
}

/** Whose `load` owns the store right now. Module scope, deliberately: it is
 *  bookkeeping about IN-FLIGHT work, not state a component renders, and
 *  `src/test/resetStores.ts` documents that it cannot reach a module `let` — so
 *  `reset()` below clears it, which is why BOTH resets are load-bearing in every
 *  new store test. */
let loadEpoch = 0;

export const useTasks = create<BoardState>((set, get) => ({
  boardsBySpace: {},
  boostNotes: {},
  loading: false,
  error: null,

  load: async (spacePath) => {
    // The epoch is the whole answer to "which fetch is still current". Switching
    // Space tabs fast fires two `get_board` calls and the SLOWER one can resolve
    // last; without this guard it would repaint the new tab's columns with the old
    // tab's board. Same shape as the `reorderEpoch` counters in `sessions.ts`.
    loadEpoch += 1;
    const epoch = loadEpoch;
    set({ loading: true, error: null });
    try {
      const columns = await getBoardCommand(spacePath);
      if (epoch !== loadEpoch) return; // a newer load owns the store
      set((state) => ({
        boardsBySpace: { ...state.boardsBySpace, [spacePath]: columns },
        loading: false,
      }));
    } catch (err) {
      // Captured, never rethrown (the `sessions.ts` command-failure pattern): the
      // board renders this sentence, and an action that throws out of a mount
      // `useEffect` produces an unhandled rejection instead of an error line.
      const message = describeIpcError(err);
      if (epoch === loadEpoch) set({ loading: false });
      set({ error: message });
      console.error(`Failed to load the task board for ${spacePath}:`, err);
    }
  },

  moveTask: async (spacePath, taskId, toStageSlug) => {
    const columns = get().boardsBySpace[spacePath];
    if (!columns) {
      set({ error: "No board loaded for this Space." });
      return;
    }
    const from = columns.find((c) => c.tasks.some((t) => t.id === taskId));
    const to = columns.find((c) => c.stage.slug === toStageSlug);
    // A drag whose endpoints are not both in the loaded board is a STALE gesture
    // (the board reloaded mid-drag). Refusing beats inventing a column.
    if (!from || !to || from.stage.slug === toStageSlug) return;

    // THE OPTIMISTIC SLICE, and the value the revert restores. The card moves to
    // the END of the destination column: within-column position is the OTHER verb
    // (`reorderTasks`), so a cross-column drop appends and leaves ordering alone.
    const moved = from.tasks.find((t) => t.id === taskId)!;
    const previous = columns;
    const next: StageWithTasks[] = columns.map((c) => {
      if (c.stage.slug === from.stage.slug) {
        return { ...c, tasks: c.tasks.filter((t) => t.id !== taskId) };
      }
      if (c.stage.slug === toStageSlug) {
        // `stageSlug` travels with the card. Leaving it pointing at the column it
        // left would make the NEXT drag read a stage the card is no longer in.
        return { ...c, tasks: [...c.tasks, { ...moved, stageSlug: toStageSlug }] };
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
    } catch (err) {
      // Restore the slice this action replaced — do NOT refetch. `get_board` seeds
      // stage rows on read, so a refetch is a WIDER mutation than the one being
      // undone, and the rejected command wrote nothing (one transaction).
      set((state) => ({
        boardsBySpace: { ...state.boardsBySpace, [spacePath]: previous },
        error: describeIpcError(err),
      }));
      console.error(`Failed to move task ${taskId} to ${toStageSlug}:`, err);
    }
  },

  createTask: async (spacePath, title, body, stageSlug) => {
    const row = await createTaskCommand(spacePath, title, body, stageSlug);
    // Land the card in the board the human is looking at, so a created Task is
    // visible without a reload. A Space whose board is NOT loaded (the modal is a
    // later task) is left alone — there is no column set here to append into.
    const columns = get().boardsBySpace[spacePath];
    if (columns) {
      const at = columns.findIndex((c) => c.stage.slug === row.stageSlug);
      const next =
        at === -1
          ? columns
          : columns.map((c, i) => (i === at ? { ...c, tasks: [...c.tasks, row] } : c));
      set((state) => ({
        boardsBySpace: { ...state.boardsBySpace, [spacePath]: next },
      }));
    }
    return row;
  },

  linkSession: async (taskId, sessionId, stageSlug) => {
    // No board write: a link is a row in `task_sessions`, not a change to a card's
    // stage or order. The board cannot render it, so reflecting it here would be a
    // second owner of a fact the command already holds.
    await linkSessionCommand(taskId, sessionId, stageSlug);
  },

  reorderWithinStage: (spacePath, stageSlug, ids) => {
    if (ids.length === 0) return;
    const columns = get().boardsBySpace[spacePath];
    const column = columns?.find((c) => c.stage.slug === stageSlug);
    if (!columns || !column) return;
    // The order the drag replaced — the exact value the revert restores, captured
    // BEFORE the optimistic publish destroys it.
    const previous = columns;
    const byId = new Map(column.tasks.map((t) => [t.id, t]));
    // Rebuild the column from the dragged slice. An id the column does not hold is
    // SKIPPED (it cannot be rendered, so inserting it would put `undefined` in the
    // strip) and a card the slice never named keeps its place at the END (the same
    // new-row rule `reorderSpaces` follows, so a card created mid-drag survives the
    // write instead of vanishing with it).
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((t): t is TaskRow => t !== undefined);
    const seen = new Set(ordered.map((t) => t.id));
    const nextColumn = {
      ...column,
      tasks: [...ordered, ...column.tasks.filter((t) => !seen.has(t.id))],
    };
    const next = columns.map((c) => (c.stage.slug === stageSlug ? nextColumn : c));
    set((state) => ({
      boardsBySpace: { ...state.boardsBySpace, [spacePath]: next },
    }));
    // ONE call for the whole slice — the third instance of the repo's
    // `reorder_spaces`/`reorder_sessions` idiom. Per-card `editTask` is not a
    // fallback but a bug: it stamps `updated_at` unconditionally (so a reorder
    // moves the last-edited clock on cards nobody edited) and N calls can
    // half-succeed, leaving a column renumbered against a card that never moved.
    // `sort_order` is PER-SPACE, not per-stage, hence `ids` is one column's slice
    // and nothing else — the verb does not renumber across stages.
    void reorderTasksCommand(spacePath, stageSlug, ids).catch((err) => {
      // Restore, do NOT refetch: `reorder_tasks` is one transaction that writes
      // NOTHING on refusal, so the pre-drag slice IS the committed state.
      console.error(`Failed to reorder ${stageSlug}:`, err);
      set((state) => ({
        boardsBySpace: { ...state.boardsBySpace, [spacePath]: previous },
        error: describeIpcError(err),
      }));
    });
  },

  dismissBoostNote: (spacePath) =>
    set((state) => {
      if (!(spacePath in state.boostNotes)) return state;
      const boostNotes = { ...state.boostNotes };
      delete boostNotes[spacePath];
      return { boostNotes };
    }),

  reset: () => {
    // The module counter moves too, so a `load` still in flight when a test resets
    // cannot land afterwards and repopulate a store the NEXT case believes is
    // clean. `setState(…, true)` is the no-merge rule `resetStores.ts` states: a
    // partial reset would leave the rest of the dirty slice standing.
    loadEpoch += 1;
    set(useTasks.getInitialState(), true);
  },
}));
