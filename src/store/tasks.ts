import { create } from "zustand";
import {
  createTask as createTaskCommand,
  getBoard as getBoardCommand,
  linkSession as linkSessionCommand,
  moveTask as moveTaskCommand,
  reorderTasks as reorderTasksCommand,
  // T3's ten (issue #179 §8.1 + issue #180 D1). ALIASED, every one: this store's
  // own actions carry the SAME names these wrappers have, so a bare import is not
  // a collision error but INFINITE RECURSION — the action calling itself instead
  // of the command. See the module header.
  createStage as createStageCommand,
  deleteStage as deleteStageCommand,
  getArtifact as getArtifactCommand,
  getBoardStrict as getBoardStrictCommand,
  renameStage as renameStageCommand,
  reorderStages as reorderStagesCommand,
  setBoardStrict as setBoardStrictCommand,
  setStageNext as setStageNextCommand,
  setStageSkill as setStageSkillCommand,
  writeArtifact as writeArtifactCommand,
  type Artifact,
  type ArtifactMeta,
  type StageRow,
  type StageWithTasks,
  type TaskCardView,
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
 * THE STAGE WRITES AND THE ARTIFACT PAIR (issue #179 §8.1 + issue #180 D1) joined
 * the same file on the same rules, and one rule needed a decision: spec §8.1 asks
 * every Stage write to re-derive the WHOLE `boardsBySpace[spacePath]` slice (a
 * Stage write changes the column SET, so a partial patch risks a column list that
 * disagrees with the cards under it) and to paint → await → revert into `error`.
 * `moveTask`'s other habit — refuse when no board is loaded — is NOT carried over,
 * and the reason is that `moveTask` refuses because it cannot compute its own
 * endpoints, while a Stage write can: the command is the truth either way, so an
 * unloaded slice costs you the PAINT and not the WRITE. A guard that returned early
 * would make the editor's rename silently do nothing during the one frame the board
 * has not fetched, which is a fetch problem wearing a permission mask. The
 * `void`-returning writes (`reorderStages`, `deleteStage`, `setBoardStrict`) capture
 * their failure into `error` exactly as `moveTask` does; the six that ANSWER
 * something (`createStage`, `renameStage`, `setStageSkill`, `setStageNext`, and both
 * artifact actions) rethrow as well, because on a refusal there is no value to hand
 * back and the caller is holding text this store will never display.
 *
 * ONE module `let` still lives here (`loadEpoch`), and no Stage write added a
 * second: the Stage actions do not race each other the way a Space-tab switch
 * races two `get_board` calls — each captures its own `previous` and awaits its own
 * command, so there is no "which write is still current" question to answer. If one
 * is ever added, `reset()` must clear it: `src/test/resetStores.ts` cannot reach a
 * module `let`, which is why every store test in this repo runs BOTH resets.
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

  // -------------------------------------------------------------------------
  // The STAGE writes (issue #179 §8.1). Seven verbs, and each one re-derives the
  // WHOLE `boardsBySpace[spacePath]` slice rather than patching one entry: a Stage
  // write changes the COLUMN SET (add / delete / reorder), so a partial patch can
  // leave a column list that disagrees with the cards under it. All of them follow
  // `moveTask`'s paint → await → revert-into-`error` shape, and none of them
  // refetches — `get_board` seeds stage rows on read, so a refetch would be a
  // WIDER mutation than the one being undone.
  // -------------------------------------------------------------------------

  /** Add a column. `skill` is the ADR 0098 launch Skill; omit it for a column that
   *  launches nothing.
   *
   *  The ONE Stage write that paints NOTHING until the command resolves, and the
   *  reason is the slug: Rust derives it from the label and REFUSES a collision
   *  rather than suffixing (spec §5), so a client-side guess would be a second
   *  owner of the slug rule — and a column whose slug the database never agreed
   *  to is a column no card can point at. A refusal lands in `error` AND rethrows,
   *  because the editor must keep the label the user typed. */
  createStage: (
    spacePath: string,
    label: string,
    skill?: string | null,
  ) => Promise<StageRow>;
  /** Rename a column's LABEL. The slug does not move (spec §5 — `tasks.stage_slug`
   *  points at it by string with no foreign key). */
  renameStage: (spacePath: string, slug: string, label: string) => Promise<StageRow>;
  /** Set or clear the Skill a Session started from this column loads (ADR 0098).
   *  `null` CLEARS it. A second field beside `onEnter`, never a merged one. */
  setStageSkill: (
    spacePath: string,
    slug: string,
    skill?: string | null,
  ) => Promise<StageRow>;
  /** Set one column's outgoing transitions (ADR 0099) in button-render order.
   *  `[]` means "configured, and nothing may follow this column" and is NOT the
   *  same answer as the `null` that means "unconfigured, therefore unconstrained". */
  setStageNext: (spacePath: string, slug: string, slugs: string[]) => Promise<StageRow>;
  /** Rewrite the board's column order in one pass.
   *
   *  `slugs` is the board's WHOLE visible slice in its new order — the
   *  `reorder_spaces` contract (index becomes `sort_order`, dense from 0, an
   *  unknown slug a silent no-op), NOT `reorderTasks`' refuse-unknown one. The
   *  caller passes every column it shows; this action sends that list verbatim. */
  reorderStages: (spacePath: string, slugs: string[]) => Promise<void>;
  /** Delete a column, optionally relocating its cards first.
   *
   *  `relocateTo` is the destination the editor's picker chose. The relocation is
   *  ONE bulk UPDATE inside the command's own transaction and this action NEVER
   *  calls `moveTask` per card: `move_task` runs the destination's `on_enter`, so
   *  N calls would attempt N compactions as a side effect of bookkeeping (spec
   *  §4.1). A column another column points at, a column that still holds cards
   *  without a destination, and a Space's LAST column all refuse — and the paint
   *  goes back exactly as it came. */
  deleteStage: (
    spacePath: string,
    slug: string,
    relocateTo?: string | null,
  ) => Promise<void>;
  /** The Strict-workflow opt-in (ADR 0099): does this Space's graph BIND its drags?
   *
   *  A passthrough write with NO board paint — the flag lives on the `spaces` row
   *  and changes no column, so painting anything here would be a second owner of
   *  one fact. It is also the ONE Stage action that does not need a loaded board:
   *  there is no slice for it to re-derive, so refusing it while the board had not
   *  fetched would make the editor's Switch dead for a reason that has nothing to
   *  do with the flag. */
  setBoardStrict: (spacePath: string, strict: boolean) => Promise<void>;
  /** Read the Strict flag back — the seed for the editor's Switch.
   *
   *  This is the SAME value `moveTask` enforces (both key the `spaces` row through
   *  the identical normalization), which is why the Switch is seeded from here and
   *  not from a local default or a cached `SpaceRow`: a Switch showing Strict ON
   *  over a board whose drags are all accepted is the failure that split prevents.
   *  Rejects loudly rather than answering `false`, so the editor can tell "off"
   *  from "unread". */
  getBoardStrict: (spacePath: string) => Promise<boolean>;

  // -------------------------------------------------------------------------
  // The ARTIFACT pair (issue #180 D1). Both are passthroughs, and the reason is
  // the wire shape: the board carries `TaskCardView.artifactKeys` ALONE, so a
  // document never enters this store at all. The optimistic pattern applies to
  // board-render state, and neither of these is any.
  // -------------------------------------------------------------------------

  /** Write (UPSERT) one Task's artifact. Resolves the `{ key, updatedAt, bytes }`
   *  meta and never the markdown; a refusal lands in `error` AND rethrows so the
   *  editor keeps the draft the user was writing. */
  writeArtifact: (
    taskId: string,
    key: string,
    markdown: string,
  ) => Promise<ArtifactMeta>;
  /** Read one Task artifact. `null` is an ANSWER (no such artifact, or no such
   *  Task — the `getTask` shape) and is not turned into an error sentence. */
  getArtifact: (taskId: string, key: string) => Promise<Artifact | null>;

  /** Replace this store's state wholesale — the store-owned half of isolation. */
  reset: () => void;
}

/** Whose `load` owns the store right now. Module scope, deliberately: it is
 *  bookkeeping about IN-FLIGHT work, not state a component renders, and
 *  `src/test/resetStores.ts` documents that it cannot reach a module `let` — so
 *  `reset()` below clears it, which is why BOTH resets are load-bearing in every
 *  new store test. */
let loadEpoch = 0;

/** Publish one Space's re-derived column set, leaving every OTHER Space's slice
 *  standing. The spread of the whole `boardsBySpace` record (and not a mutation of
 *  the nested key) is what makes the update visible to a zustand selector, which
 *  compares the slice by identity — the same reason `moveTask` spells it this way.
 *
 * It exists because all SIX paints in this file would otherwise be the same four
 * lines six times, and one of the six (the delete) already has enough going on. */
const paint = (
  set: (fn: (state: BoardState) => Partial<BoardState>) => void,
  spacePath: string,
  next: StageWithTasks[],
): void =>
  set((state) => ({ boardsBySpace: { ...state.boardsBySpace, [spacePath]: next } }));

/** Replace ONE column's `stage` fields, leaving the cards and every other column
 *  alone. A column the slug does not name is returned UNCHANGED (same object), so
 *  a test can tell a patched slice from a rebuilt one, and a slug that no longer
 *  exists — a board reloaded mid-edit — costs nothing rather than inventing a
 *  column the Space does not have.
 *
 *  THE SLUG CANNOT MOVE, and that is enforced HERE rather than trusted to the wire:
 *  every call site below passes either a field patch or the `StageRow` the command
 *  answered, and a row whose `slug` differs from the column being patched would
 *  re-key the column — orphaning every card under it, because `tasks.stage_slug`
 *  points at the old string with no foreign key (spec §5). `slug` is pinned back
 *  from the column that was found, so the frozen-slug rule holds even against a
 *  response that disagrees. */
const withStage = (
  columns: StageWithTasks[],
  slug: string,
  patch: Partial<StageRow>,
): StageWithTasks[] =>
  columns.map((c) =>
    c.stage.slug === slug
      ? { ...c, stage: { ...c.stage, ...patch, slug: c.stage.slug } }
      : c,
  );

/** Rebuild the slice in the caller's slug order — the optimistic half of
 *  `reorderStages`. Two deliberate leniencies, both inherited from
 *  `reorderWithinStage`: a slug the slice does not hold is SKIPPED (it cannot be
 *  rendered, so inserting it would put `undefined` in the column strip), and a
 *  column the list never named stays at the END (Rust leaves its `sort_order`
 *  alone, so painting it away would blank a live column on a stale list). */
const orderBySlugs = (
  columns: StageWithTasks[],
  slugs: readonly string[],
): StageWithTasks[] => {
  const bySlug = new Map(columns.map((c) => [c.stage.slug, c]));
  const ordered = slugs
    .map((slug) => bySlug.get(slug))
    .filter((c): c is StageWithTasks => c !== undefined);
  const seen = new Set(ordered.map((c) => c.stage.slug));
  return [
    ...ordered,
    ...columns.filter((c) => !seen.has(c.stage.slug)),
  ];
};

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
    // A board element is a `TaskCardView` (issue #174): the card's own fields live
    // under `.task`, so every read of a card here reaches through it. The WRAPPER is
    // carried along untouched by the spread below, which is what keeps the optimistic
    // slice's `sessions`/`costUsd` standing instead of quietly dropping them — and
    // that sentence is now PINNED, not prose: `carries the card's sessions and cost
    // across the drop (the chip survives a drag)` in this file's test moves a card
    // with TWO links and a non-null cost. Every other `moveTask` case moves a card
    // built with `sessions: []`/`costUsd: null`, which a mutation dropping both would
    // have satisfied.
    const from = columns.find((c) => c.tasks.some((t) => t.task.id === taskId));
    const to = columns.find((c) => c.stage.slug === toStageSlug);
    // A drag whose endpoints are not both in the loaded board is a STALE gesture
    // (the board reloaded mid-drag). Refusing beats inventing a column.
    if (!from || !to || from.stage.slug === toStageSlug) return;

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
      // The command answers a plain `TaskRow` (`create_task` was never widened —
      // see `TaskCardView`), so the board's element is BUILT here rather than
      // spliced in raw. An empty `sessions` and a `null` cost are the truth for a
      // card that exists a moment: it has no links and no Session has reported a
      // cost. Written out rather than left undefined, because `costUsd: undefined`
      // is not this type (`number | null`) and ADR 0082's "never reported" is
      // `null`, not absence.
      //
      // `artifactKeys: []` is the same kind of truth (issue #180): a card that just
      // came into the world has no artifacts. It is a REQUIRED field, so this
      // literal must carry it — and an empty list is the honest value, not a
      // placeholder: nothing has been written against a card that is one tick old.
      const card: TaskCardView = {
        task: row,
        sessions: [],
        costUsd: null,
        artifactKeys: [],
      };
      const next =
        at === -1
          ? columns
          : columns.map((c, i) => (i === at ? { ...c, tasks: [...c.tasks, card] } : c));
      set((state) => ({
        boardsBySpace: { ...state.boardsBySpace, [spacePath]: next },
      }));
    }
    return row;
  },

  linkSession: async (taskId, sessionId, stageSlug) => {
    // No board write, and that is a scheduling decision rather than a shape one: a
    // link is a row in `task_sessions`, not a change to a card's stage or order, and
    // the board CAN now render it (issue #174 — `TaskCardView.sessions`) but only
    // from what the last `get_board` returned. So the chip on a card reflects the
    // LAST BOARD LOAD, and a link written after that load appears on the next
    // `load`. Optimistically inventing the link here would duplicate state the
    // command already owns for a surface no component drives yet: zero call sites
    // call `linkSession` today (links are written by the harness's
    // `start_task_session`), so an optimistic write would be a path with no caller.
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
    const byId = new Map(column.tasks.map((t) => [t.task.id, t]));
    // Rebuild the column from the dragged slice. An id the column does not hold is
    // SKIPPED (it cannot be rendered, so inserting it would put `undefined` in the
    // strip) and a card the slice never named keeps its place at the END (the same
    // new-row rule `reorderSpaces` follows, so a card created mid-drag survives the
    // write instead of vanishing with it).
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((t): t is TaskCardView => t !== undefined);
    const seen = new Set(ordered.map((t) => t.task.id));
    const nextColumn = {
      ...column,
      tasks: [...ordered, ...column.tasks.filter((t) => !seen.has(t.task.id))],
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

  // -------------------------------------------------------------------------
  // The STAGE writes (issue #179 §8.1). Every one of them re-derives the WHOLE
  // slice through `paint`, and every one of them restores the captured `previous`
  // on rejection rather than refetching — see the interface block above for the
  // two rules, and `moveTask` for the pattern they came from.
  // -------------------------------------------------------------------------

  createStage: async (spacePath, label, skill) => {
    // NO optimistic paint, and the slug is the whole reason (see the interface
    // block): Rust derives it from the label and refuses a collision instead of
    // suffixing, so there is nothing honest to paint before the answer arrives.
    // The error is written AND the rejection rethrown — the editor holds the label
    // the user typed and has to decide whether to keep it on screen.
    try {
      const row = await createStageCommand(spacePath, label, skill);
      const columns = get().boardsBySpace[spacePath];
      if (columns) {
        // Place the new column where its stored `sort_order` puts it rather than
        // always last: `get_board` returns columns in `sort_order`, so a paint that
        // ignored the number would show the column in one place and reload it into
        // another. T1 assigns the next `sort_order` for a fresh column, which lands
        // it last anyway — the placement rule is what makes that true rather than
        // assumed.
        const at = columns.findIndex((c) => c.stage.sortOrder > row.sortOrder);
        const next = [...columns];
        next.splice(at === -1 ? next.length : at, 0, { stage: row, tasks: [] });
        paint(set, spacePath, next);
      }
      return row;
    } catch (err) {
      set({ error: describeIpcError(err) });
      console.error(`Failed to create stage ${label} in ${spacePath}:`, err);
      throw err;
    }
  },

  renameStage: async (spacePath, slug, label) => {
    const previous = get().boardsBySpace[spacePath];
    // The guess is the label ALONE — every other field of the row (skill, edges,
    // `onEnter`) is whatever the last load said, because this verb writes nothing
    // else. An unloaded Space still gets the WRITE: there is no slice to paint, so
    // refusing would silently drop a rename the command would have applied.
    if (previous) paint(set, spacePath, withStage(previous, slug, { label }));
    try {
      const row = await renameStageCommand(spacePath, slug, label);
      if (previous) {
        // Merge the STORED row back over the guess, so a trimmed or normalised
        // label shows what the database kept rather than what was typed.
        paint(set, spacePath, withStage(get().boardsBySpace[spacePath]!, slug, row));
      }
      return row;
    } catch (err) {
      if (previous) paint(set, spacePath, previous);
      set({ error: describeIpcError(err) });
      console.error(`Failed to rename stage ${slug}:`, err);
      // Rethrown, and the reason is the return type: this action answers the
      // stored `StageRow`, and on a refusal there ISN'T one — handing back the
      // guessed row would be the confident lie `reorderTasks`' doc warns about in
      // the other direction. The three `void` Stage writes (`reorderStages`,
      // `deleteStage`, `setBoardStrict`) do NOT rethrow, matching `moveTask`: they
      // have nothing to hand back and the reverted slice is the whole report.
      throw err;
    }
  },

  setStageSkill: async (spacePath, slug, skill) => {
    const previous = get().boardsBySpace[spacePath];
    // `onEnter` is NOT touched here and that is ADR 0098's point: the Skill is a
    // SECOND column beside it, so a column can compact AND load a Skill. Merging
    // the two would print the Skill where the board advertises `compact`.
    if (previous)
      paint(set, spacePath, withStage(previous, slug, { onEnterSkill: skill ?? null }));
    try {
      const row = await setStageSkillCommand(spacePath, slug, skill ?? null);
      if (previous)
        paint(
          set,
          spacePath,
          withStage(get().boardsBySpace[spacePath]!, slug, row),
        );
      return row;
    } catch (err) {
      if (previous) paint(set, spacePath, previous);
      set({ error: describeIpcError(err) });
      console.error(`Failed to set the skill of stage ${slug}:`, err);
      throw err; // see `renameStage`'s note for why this arm rethrows
    }
  },

  setStageNext: async (spacePath, slug, slugs) => {
    const previous = get().boardsBySpace[spacePath];
    // The list goes in verbatim — order is the render order AND the card's primary
    // next step (spec §7.1), so sorting or deduplicating it here is a different
    // workflow painted as the one the user asked for. `[]` stays `[]`: configured,
    // leading nowhere, which is NOT the `null` that means unconstrained.
    if (previous)
      paint(set, spacePath, withStage(previous, slug, { nextSlugs: slugs }));
    try {
      const row = await setStageNextCommand(spacePath, slug, slugs);
      if (previous)
        paint(
          set,
          spacePath,
          withStage(get().boardsBySpace[spacePath]!, slug, row),
        );
      return row;
    } catch (err) {
      // An unknown slug or a self-loop REFUSES rather than dropping the entry
      // (spec §4) — a silently-shrunk workflow is the failure that rule exists to
      // prevent, and the revert is what stops the editor showing the shrunk one.
      if (previous) paint(set, spacePath, previous);
      set({ error: describeIpcError(err) });
      console.error(`Failed to set the destinations of stage ${slug}:`, err);
      throw err;
    }
  },

  reorderStages: async (spacePath, slugs) => {
    const previous = get().boardsBySpace[spacePath];
    if (previous) paint(set, spacePath, orderBySlugs(previous, slugs));
    try {
      // `slugs` verbatim, never `previous.map(c => c.stage.slug)`: this is the
      // `reorder_spaces` contract (renumber everything the caller shows, an unknown
      // slug a silent no-op), and the caller owns the order it asked for.
      await reorderStagesCommand(spacePath, slugs);
    } catch (err) {
      if (previous) paint(set, spacePath, previous);
      set({ error: describeIpcError(err) });
      console.error(`Failed to reorder the stages of ${spacePath}:`, err);
    }
  },

  deleteStage: async (spacePath, slug, relocateTo) => {
    const previous = get().boardsBySpace[spacePath];
    if (previous) {
      // THE FIVE-COMPACTIONS RULE, and this paint is why it is a paint. The cards
      // in the deleted column move to the destination HERE, in the client's own
      // copy of the slice — they do NOT go through `moveTask`. `move_task` reads
      // the destination's `on_enter` and fires its boost, so relocating five cards
      // with five calls would attempt FIVE COMPACTIONS as a side effect of deleting
      // a column (spec §4.1, which asks for the same asymmetry on the Rust side:
      // ONE bulk `UPDATE … SET stage_slug` inside the delete's transaction). The
      // pin is `NEVER calls moveTask for the cards the deleted column held` in this
      // file's tests.
      const doomed = previous.find((c) => c.stage.slug === slug);
      const rest = previous.filter((c) => c.stage.slug !== slug);
      const next =
        doomed === undefined || relocateTo === undefined || relocateTo === null
          ? rest
          : rest.map((c) =>
              c.stage.slug === relocateTo
                ? {
                    ...c,
                    tasks: [
                      ...c.tasks,
                      // `stageSlug` travels with the card, exactly as `moveTask`'s
                      // optimistic slice does it: a card still naming the column it
                      // left makes the NEXT drag read a stage the card is not in.
                      ...doomed.tasks.map((card) => ({
                        ...card,
                        task: { ...card.task, stageSlug: relocateTo },
                      })),
                    ],
                  }
                : c,
            );
      paint(set, spacePath, next);
    }
    try {
      await deleteStageCommand(spacePath, slug, relocateTo);
    } catch (err) {
      if (previous) paint(set, spacePath, previous);
      set({ error: describeIpcError(err) });
      console.error(`Failed to delete stage ${slug}:`, err);
    }
  },

  setBoardStrict: async (spacePath, strict) => {
    // No slice read, no paint, no guard on a loaded board — see the interface
    // block. The flag lives on the `spaces` row and binds DRAGS (`move_task` checks
    // it), so the board shows the consequence of it on the next refused drop rather
    // than on this call.
    try {
      await setBoardStrictCommand(spacePath, strict);
    } catch (err) {
      set({ error: describeIpcError(err) });
      console.error(`Failed to set the strict workflow of ${spacePath}:`, err);
    }
  },

  getBoardStrict: async (spacePath) => {
    try {
      return await getBoardStrictCommand(spacePath);
    } catch (err) {
      // Captured for the error line AND rethrown: `false` is a FACT about the
      // Space and a swallowed failure would hand the editor that fact as its
      // default, which is the Switch-showing-Strict-over-a-lenient-board failure
      // this read exists to prevent.
      set({ error: describeIpcError(err) });
      console.error(`Failed to read the strict workflow of ${spacePath}:`, err);
      throw err;
    }
  },

  // -------------------------------------------------------------------------
  // The ARTIFACT pair (issue #180 D1). Both are passthroughs — the board carries
  // `artifactKeys` alone, so no artifact state lives in this store and there is
  // nothing to paint, revert or re-derive. The `error` cell is written for the
  // line the surface renders, and the rejection is RETHROWN because both callers
  // are `await`ed by a component that has to keep its draft (write) or tell "empty"
  // from "failed" (read).
  // -------------------------------------------------------------------------

  writeArtifact: async (taskId, key, markdown) => {
    try {
      return await writeArtifactCommand(taskId, key, markdown);
    } catch (err) {
      set({ error: describeIpcError(err) });
      console.error(`Failed to write artifact ${key} on ${taskId}:`, err);
      throw err;
    }
  },

  getArtifact: async (taskId, key) => {
    try {
      // `null` passes straight through — the `getTask` shape, where "not there" is
      // an answer and not a failure. Turning it into an `error` sentence would make
      // "this card has no spec" unreadable as distinct from a broken read.
      return await getArtifactCommand(taskId, key);
    } catch (err) {
      set({ error: describeIpcError(err) });
      console.error(`Failed to read artifact ${key} on ${taskId}:`, err);
      throw err;
    }
  },

  reset: () => {
    // The module counter moves too, so a `load` still in flight when a test resets
    // cannot land afterwards and repopulate a store the NEXT case believes is
    // clean. `setState(…, true)` is the no-merge rule `resetStores.ts` states: a
    // partial reset would leave the rest of the dirty slice standing.
    loadEpoch += 1;
    set(useTasks.getInitialState(), true);
  },
}));
