import { create } from "zustand";
import {
  createTask as createTaskCommand,
  getBoard as getBoardCommand,
  linkSession as linkSessionCommand,
  moveTask as moveTaskCommand,
  reorderTasks as reorderTasksCommand,
  // T3's ten (issue #179 §8.1 + issue #180 D1) plus the FIVE the workflow graph and
  // the canvas add (`setStageAuto`, `setStagePromptPrefix`, `setStagePosition`,
  // `getAutoGuards`, `setAutoGuards`) —
  // fifteen, ALIASED every one: this store's
  // own actions carry the SAME names these wrappers have, so a bare import is not
  // a collision error but INFINITE RECURSION — the action calling itself instead
  // of the command. See the module header.
  createStage as createStageCommand,
  deleteStage as deleteStageCommand,
  getArtifact as getArtifactCommand,
  getAutoGuards as getAutoGuardsCommand,
  getBoardStrict as getBoardStrictCommand,
  renameStage as renameStageCommand,
  reorderStages as reorderStagesCommand,
  setAutoGuards as setAutoGuardsCommand,
  setBoardStrict as setBoardStrictCommand,
  setStageAuto as setStageAutoCommand,
  setStageNext as setStageNextCommand,
  setStagePosition as setStagePositionCommand,
  setStagePromptPrefix as setStagePromptPrefixCommand,
  setStageSkill as setStageSkillCommand,
  writeArtifact as writeArtifactCommand,
  type Artifact,
  type ArtifactMeta,
  type AutoGuards,
  type StageDto,
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
 * `void`-returning writes (`reorderStages`, `deleteStage`, `setBoardStrict`,
 * `setAutoGuards`) capture
 * their failure into `error` exactly as `moveTask` does; the TEN that ANSWER
 * something (`createStage`, `renameStage`, `setStageSkill`, `setStageNext`,
 * `setStageAuto`, `setStagePromptPrefix`, `setStagePosition`, `getAutoGuards`, and
 * both artifact actions) rethrow as well, because on a refusal there is no value to
 * hand back and the caller is holding text this store will never display. (The
 * figure this sentence carried was stale by one: it read "eight" beside a list of
 * nine. Re-count it from the list if you touch this paragraph — a count of a list
 * two lines long is the least excusable rot in the file.)
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
   *  `onEnter`. Optimistic, reverted on rejection.
   *
   *  Resolves with **the column the card is in when it settles** — the stage slug, or
   *  `null` for "there is no board here, so this action cannot say where anything is".
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
  moveTask: (
    spacePath: string,
    taskId: string,
    toStageSlug: string,
  ) => Promise<string | null>;
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
  reorderWithinStage: (
    spacePath: string,
    stageSlug: string,
    ids: string[],
  ) => void;
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
  ) => Promise<StageDto>;
  /** Rename a column's LABEL. The slug does not move (spec §5 — `tasks.stage_slug`
   *  points at it by string with no foreign key). */
  renameStage: (
    spacePath: string,
    slug: string,
    label: string,
  ) => Promise<StageDto>;
  /** Set or clear the Skill a Session started from this column loads (ADR 0098).
   *  `null` CLEARS it. A second field beside `onEnter`, never a merged one. */
  setStageSkill: (
    spacePath: string,
    slug: string,
    skill?: string | null,
  ) => Promise<StageDto>;
  /** Set one column's outgoing transitions (ADR 0099) in button-render order.
   *  `[]` means "configured, and nothing may follow this column" and is NOT the
   *  same answer as the `null` that means "unconfigured, therefore unconstrained". */
  setStageNext: (
    spacePath: string,
    slug: string,
    slugs: string[],
  ) => Promise<StageDto>;
  /** Turn one column's **auto-advance** flag on or off (the workflow graph): a card
   *  launched here advances itself when its Session settles.
   *
   *  The SAME paint shape as `setStageSkill` — one field on the row, whole-slice
   *  re-derivation, revert-into-`error`, rethrow (this answers the stored `StageDto`
   *  and on a refusal there is not one to hand back). Nothing else on the row moves:
   *  `auto` is a THIRD question beside `onEnter`'s and `onEnterSkill`'s, and a paint
   *  that touched more than it wrote would be a second owner of the other two. */
  setStageAuto: (
    spacePath: string,
    slug: string,
    auto: boolean,
  ) => Promise<StageDto>;
  /** Set or clear one column's **extra prompt**, prepended before its Skill launch.
   *  `null` CLEARS it and is the only spelling of cleared — `""` is a stored VALUE a
   *  person typed, so an action that normalized `null` to `""` would make a prefix
   *  un-clearable, which is the `setStageNext` defect this signature exists to avoid. */
  setStagePromptPrefix: (
    spacePath: string,
    slug: string,
    prefix: string | null,
  ) => Promise<StageDto>;
  /** Set or clear one column's **position on the Workflows canvas** — the
   *  hand-arranged layout a node drag produces.
   *
   *  BOTH coordinates or NEITHER, and that is the command's rule rather than a
   *  convenience of this one: a node is a BOX, so half a coordinate is a lie about
   *  where a box is. `null, null` is the clear (the node goes back to dagre) and
   *  `0, 0` is a node a person pinned to the origin — the action passes both through
   *  and collapses neither.
   *
   *  The SAME paint shape as `setStageAuto` immediately above, and it has to be: a
   *  drag paints the node at the pointer, awaits, then re-paints from the stored row
   *  or reverts. The revert is the whole point for this action more than any other —
   *  a node left painted where the database refused to put it is a node the user
   *  believes they moved, and the next board fetch would teleport it.
   *
   *  The paint writes BOTH fields from ONE patch object, never two successive
   *  `withStage` calls: two paints would put a half-positioned slice on screen for
   *  one frame, which is the state the command refuses to store. */
  setStagePosition: (
    spacePath: string,
    slug: string,
    x: number | null,
    y: number | null,
  ) => Promise<StageDto>;
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
  // The AUTO-CHAIN GUARD pair (the workflow graph's bound). Per-SPACE, so neither
  // belongs to the board slice and neither paints anything: like the Strict pair
  // immediately above, the two fields live on the `spaces` row and change no
  // column, so painting would make this store a second owner of one fact. They are
  // here because `getBoardStrict`/`setBoardStrict` are here, for the identical
  // reason — the Stage editor drives all four and one store owns the board's writes.
  // -------------------------------------------------------------------------

  /** Set or clear one Space's auto-chain guards (the step bound and the USD
   *  ceiling a chain of auto-advancing columns runs under).
   *
   *  ONE call for the PAIR, because the write is one statement on the Rust side and
   *  has no "keep what is there" arm: whatever this hands over is exactly what
   *  lands, so a caller that changed one field still has to name the other. That is
   *  why the editor reads the pair before it writes either.
   *
   *  `null` clears a guard to "not configured", which falls back to a SHIPPED
   *  DEFAULT and is NOT unlimited; `0` is a bound a person chose ("no
   *  auto-chaining"). This action passes both through verbatim and never
   *  normalizes one into the other. Captures its failure into `error` and does NOT
   *  rethrow — the `setBoardStrict` shape: nothing to hand back. */
  setAutoGuards: (
    spacePath: string,
    maxSteps: number | null,
    ceilingUsd: number | null,
  ) => Promise<void>;
  /** Read the guards back — the seed for the editor's two numeric fields.
   *
   *  Reports the STORED pair, `null` included: the runtime applies the fallback,
   *  this never substitutes it, which is what lets the editor tell "unset" from
   *  "set to the same number". Rejects loudly rather than answering an all-`null`
   *  pair, so the editor can tell "not configured" from "unread" — the
   *  `getBoardStrict` rule, and the same one a field showing a number the Space
   *  never chose would break. */
  getAutoGuards: (spacePath: string) => Promise<AutoGuards>;

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

/** Which **(Space, slug)** pairs have a `set_stage_position` write in flight.
 *
 *  MODULE SCOPE for the same reason `loadEpoch` is: it is bookkeeping about in-flight work,
 *  not state a component renders, and `src/test/resetStores.ts` cannot reach a module `let`
 *  — so `reset()` clears it and both resets are load-bearing in the tests that pin it.
 *
 *  KEYED ON THE PAIR and not on the Space, because the thing being protected is one column's
 *  two coordinates and not the whole board. A Space-wide flag would have `load` discard or
 *  freeze rows it is entitled to refresh, which is the "a view that refuses to re-read shows
 *  whatever the last view left behind" failure `WorkflowsCanvas.tsx` argues about.
 *
 *  ## The hole this closes (F3)
 *
 *  `loadEpoch` answers "which FETCH is current" and says nothing about load-against-a-WRITE.
 *  Both `TasksBoard` and `WorkflowsCanvas` call `load` on mount and the canvas renders
 *  immediately when the slice is already populated, so: board → Workflows → drag before that
 *  mount read lands → the read answers with the PRE-DRAG rows and replaces the slice. The
 *  write succeeded; the paint shows a node that was never moved. That defeats
 *  `workflowGraphLayout.ts`'s claim that its stored-first ordering "IS the anti-snap-back
 *  rule" — the ordering is right and it is simply reading a row a late fetch overwrote.
 *
 *  ## Why a MERGE and not a suppressed or deferred `set`
 *
 *  Suppressing the response would throw away the cards, labels, skills and auto flags the
 *  same read carries — a wider loss than the one being prevented, and one the canvas header
 *  explicitly argues against. Re-issuing `load` once the write settles costs an extra
 *  `get_board` PER DRAG, and `get_board` is not a pure read (ADR 0090's lazy stage seeding),
 *  on top of the two per view-hop this file already pays deliberately. A merge costs neither:
 *  the fresh rows land and only the TWO FIELDS the in-flight write owns are kept, for exactly
 *  the columns it owns. See `useTasks.load does not undo a position write that is in flight`.
 *
 *  A per-Slug COUNT and not a per-Space counter or a plain set of slugs. A Space-wide flag
 *  would have `load` discard or freeze rows it is entitled to refresh, which is the "a view
 *  that refuses to re-read shows whatever the last view left behind" failure
 *  `WorkflowsCanvas.tsx` argues about; a set of slugs would release early when two writes
 *  land on the SAME slug (the first reply to settle would unprotect the one still in flight),
 *  and **Tidy up** makes exactly that shape of overlap likely. */
const positionWritesInFlight = new Map<string, Map<string, number>>();

/** Run `body` with `(spacePath, slug)` marked as having a position write outstanding. */
const withPositionWriteInFlight = async <T>(
  spacePath: string,
  slug: string,
  body: () => Promise<T>,
): Promise<T> => {
  const slugs =
    positionWritesInFlight.get(spacePath) ?? new Map<string, number>();
  positionWritesInFlight.set(spacePath, slugs);
  slugs.set(slug, (slugs.get(slug) ?? 0) + 1);
  try {
    return await body();
  } finally {
    const left = (slugs.get(slug) ?? 1) - 1;
    if (left > 0) slugs.set(slug, left);
    else {
      slugs.delete(slug);
      if (slugs.size === 0) positionWritesInFlight.delete(spacePath);
    }
  }
};

/** The slugs of this Space with a position write outstanding, or `null` for none. */
const inFlightPositionsOf = (spacePath: string): ReadonlySet<string> | null => {
  const slugs = positionWritesInFlight.get(spacePath);
  return slugs === undefined || slugs.size === 0 ? null : new Set(slugs.keys());
};

/** Keep the in-flight position pair(s) of `fresh` from the slice `load` is about to replace.
 *  Everything else in `fresh` — every other field, every other column — is the newer answer
 *  and is taken verbatim. A column with a write in flight that the fresh read does NOT hold
 *  (deleted in another window) is left as the read reports it: inventing a row back would be
 *  the store disagreeing with the database about the column set, which is not its call. */
const keepInFlightPositions = (
  columns: StageWithTasks[],
  fresh: StageWithTasks[],
  slugs: ReadonlySet<string>,
): StageWithTasks[] => {
  const bySlug = new Map(columns.map((c) => [c.stage.slug, c]));
  return fresh.map((row) => {
    if (!slugs.has(row.stage.slug)) return row;
    const held = bySlug.get(row.stage.slug);
    if (held === undefined) return row;
    return {
      ...row,
      stage: {
        ...row.stage,
        positionX: held.stage.positionX ?? null,
        positionY: held.stage.positionY ?? null,
      },
    };
  });
};

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
  set((state) => ({
    boardsBySpace: { ...state.boardsBySpace, [spacePath]: next },
  }));

/** Replace ONE column's `stage` fields, leaving the cards and every other column
 *  alone. A column the slug does not name is returned UNCHANGED (same object), so
 *  a test can tell a patched slice from a rebuilt one, and a slug that no longer
 *  exists — a board reloaded mid-edit — costs nothing rather than inventing a
 *  column the Space does not have.
 *
 *  THE SLUG CANNOT MOVE, and that is enforced HERE rather than trusted to the wire:
 *  every call site below passes either a field patch or the `StageDto` the command
 *  answered, and a row whose `slug` differs from the column being patched would
 *  re-key the column — orphaning every card under it, because `tasks.stage_slug`
 *  points at the old string with no foreign key (spec §5). `slug` is pinned back
 *  from the column that was found, so the frozen-slug rule holds even against a
 *  response that disagrees. */
const withStage = (
  columns: StageWithTasks[],
  slug: string,
  patch: Partial<StageDto>,
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
  return [...ordered, ...columns.filter((c) => !seen.has(c.stage.slug))];
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
      set((state) => {
        // F3: a position write for THIS Space that is still in flight owns its column's two
        // coordinates, and this read must not paint over them. See `positionWritesInFlight`
        // for why the fix is a merge and not a suppressed `set`.
        const inFlight = inFlightPositionsOf(spacePath);
        const held = state.boardsBySpace[spacePath];
        const next =
          inFlight === null || held === undefined
            ? columns
            : keepInFlightPositions(held, columns, inFlight);
        return {
          boardsBySpace: { ...state.boardsBySpace, [spacePath]: next },
          loading: false,
        };
      });
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
    // across the drop (the chip survives a drag)` in this file's test moves a card
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
      const landedIn = reverted?.find((c) =>
        c.tasks.some((t) => t.task.id === taskId),
      );
      return landedIn?.stage.slug ?? null;
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
          : columns.map((c, i) =>
              i === at ? { ...c, tasks: [...c.tasks, card] } : c,
            );
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
    const next = columns.map((c) =>
      c.stage.slug === stageSlug ? nextColumn : c,
    );
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
        paint(
          set,
          spacePath,
          withStage(get().boardsBySpace[spacePath]!, slug, row),
        );
      }
      return row;
    } catch (err) {
      if (previous) paint(set, spacePath, previous);
      set({ error: describeIpcError(err) });
      console.error(`Failed to rename stage ${slug}:`, err);
      // Rethrown, and the reason is the return type: this action answers the
      // stored `StageDto`, and on a refusal there ISN'T one — handing back the
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
      paint(
        set,
        spacePath,
        withStage(previous, slug, { onEnterSkill: skill ?? null }),
      );
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

  setStageAuto: async (spacePath, slug, auto) => {
    const previous = get().boardsBySpace[spacePath];
    // The flag alone. `auto` rides on the `StageDto` the row already holds, so the
    // paint has a stored value to start from and no separate read to wait for —
    // unlike the Strict Switch, which is seeded from `getBoardStrict` because the
    // flag is NOT on any row the board read returns.
    if (previous) paint(set, spacePath, withStage(previous, slug, { auto }));
    try {
      const row = await setStageAutoCommand(spacePath, slug, auto);
      if (previous)
        paint(
          set,
          spacePath,
          withStage(get().boardsBySpace[spacePath]!, slug, row),
        );
      return row;
    } catch (err) {
      // The card a person is looking at does NOT move on this failure — the runtime
      // that advances it reads the stored flag, and the stored flag did not change.
      // Leaving the row painted ON over a Space that refused would be the
      // Switch-showing-Strict-over-a-lenient-board failure one control over.
      if (previous) paint(set, spacePath, previous);
      set({ error: describeIpcError(err) });
      console.error(`Failed to set the auto flag of stage ${slug}:`, err);
      throw err; // see `renameStage`'s note for why this arm rethrows
    }
  },

  setStagePromptPrefix: async (spacePath, slug, prefix) => {
    const previous = get().boardsBySpace[spacePath];
    // `prefix` verbatim, INCLUDING `""`: an empty string is a stored VALUE and the
    // paint has to show the value the database will hold, not the `null` the row
    // held before. Normalizing `""` to `null` here would paint a clear the write did
    // not perform — and normalizing `null` to `""` would make the field un-clearable.
    if (previous)
      paint(
        set,
        spacePath,
        withStage(previous, slug, { promptPrefix: prefix }),
      );
    try {
      const row = await setStagePromptPrefixCommand(spacePath, slug, prefix);
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
      console.error(`Failed to set the prompt prefix of stage ${slug}:`, err);
      throw err;
    }
  },

  setStagePosition: async (spacePath, slug, x, y) =>
    // F3: the whole action is bracketed by the in-flight marker — BEFORE the optimistic paint
    // and until the reply lands — so a `load` that resolves anywhere in that window merges
    // this column's pair instead of painting the pre-drag row over it. Bracketing only the
    // command call would leave the gap between the paint and the call open, which is the
    // window a mount-time `get_board` actually lands in. See `positionWritesInFlight`.
    withPositionWriteInFlight(spacePath, slug, async () => {
      const previous = get().boardsBySpace[spacePath];
      // A HALF pair is not painted, because there is nothing honest to paint: a node
      // at a known X and an unknown Y is the state the command refuses to STORE, and
      // putting it on screen for one frame would show the user a node at a place the
      // database will never hold. The command still runs and still refuses, so the
      // refusal lands in `error` and rethrows like every other Stage write — the
      // store does not invent a second verdict, it just declines to paint a lie.
      const paired = (x === null) === (y === null);
      // ONE patch, BOTH fields, so no frame ever holds half a position. `null` is
      // written as `null` and `0` as `0`: the two are distinct stored states and
      // normalizing either would silently move or silently free a node.
      if (previous && paired)
        paint(
          set,
          spacePath,
          withStage(previous, slug, { positionX: x, positionY: y }),
        );
      try {
        const row = await setStagePositionCommand(spacePath, slug, x, y);
        if (previous)
          paint(
            set,
            spacePath,
            withStage(get().boardsBySpace[spacePath]!, slug, row),
          );
        return row;
      } catch (err) {
        // THE COLUMN THIS WRITE OWNS goes back, and NOTHING ELSE does.
        //
        // This arm used to read `paint(set, spacePath, previous)` — the whole slice captured at
        // action entry — and its comment claimed *"The node goes back exactly where it was."*
        // That sentence was false, and false in the worst direction: with two drags in flight,
        // the second one's paint is inside the first one's `previous`, so a rejected drag A
        // repaints a SUCCEEDED drag B back to its pre-drag position while the database holds
        // B's new pair. The picture then contradicts the store, and the next `get_board`
        // contradicts the picture. `Tidy up` is the sharpest trigger, because it fires N
        // writes per click and one mid-list failure re-paints every later success as still
        // hand-arranged (known-gaps §10d).
        //
        // So the revert is `withStage(…, slug, the row this column had)`. Reverting only the
        // owned column is not a weaker guarantee either: this action's paint touched exactly
        // one column's two coordinates, so exactly those two fields are what it can undo.
        //
        // The revert matters MORE here than on any sibling action: the paint follows a
        // POINTER, so a node left at the drop point over a Space that refused the write is a
        // node the user believes they moved until the next fetch teleports it back.
        if (previous && paired) {
          const owned = previous.find((c) => c.stage.slug === slug);
          // A slug the captured slice cannot name was never painted by this action, so there
          // is nothing to undo — the ghost case, where the whole-slice version used to
          // "revert" by re-publishing an array nobody had changed.
          if (owned !== undefined) {
            // BOTH COORDINATES, spelled out, and `undefined` normalised to `null`. Handing
            // `withStage` the captured `StageDto` wholesale would NOT work: `withStage`
            // spreads the patch, and a row read from a database that predates the two columns
            // — or from a test factory that omits them — has the keys ABSENT rather than
            // `null`, so the spread leaves the painted numbers in place and the revert silently
            // does nothing. Measured: the canvas's `puts the box back and says why…` case
            // failed with `expected { x: 160, y: 110 } to be null` for exactly that reason.
            // `null` is the wire's only "never arranged", and `storedPositionOf` reads it and
            // `undefined` identically, so this is the same fact spelled in the form the undo
            // can carry.
            paint(
              set,
              spacePath,
              withStage(get().boardsBySpace[spacePath] ?? previous, slug, {
                positionX: owned.stage.positionX ?? null,
                positionY: owned.stage.positionY ?? null,
              }),
            );
          }
        }
        set({ error: describeIpcError(err) });
        console.error(`Failed to set the position of stage ${slug}:`, err);
        throw err; // see `renameStage`'s note for why this arm rethrows
      }
    }),

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

  setAutoGuards: async (spacePath, maxSteps, ceilingUsd) => {
    // No slice read, no paint, no guard on a loaded board — the guards live on the
    // `spaces` row and change no column, exactly as `setBoardStrict` above, and for
    // the same stated reason. Both values pass through VERBATIM: `null` is a clear
    // and `0` is a bound, and a `?? 0` or a `|| null` anywhere in this action would
    // turn one into the other on the one field whose whole meaning is the
    // difference (ADR 0082's `NULL` ≠ `0.0`).
    try {
      await setAutoGuardsCommand(spacePath, maxSteps, ceilingUsd);
    } catch (err) {
      set({ error: describeIpcError(err) });
      console.error(
        `Failed to set the auto-chain guards of ${spacePath}:`,
        err,
      );
    }
  },

  getAutoGuards: async (spacePath) => {
    try {
      // The stored pair, `null`s included — no fallback is substituted here. The
      // editor renders the fallback as a CAPTION ("unset falls back to
      // DEFAULT_AUTO_MAX_STEPS"), which is the only way a person can tell a bound
      // they chose from one they inherited.
      return await getAutoGuardsCommand(spacePath);
    } catch (err) {
      // Captured AND rethrown, the `getBoardStrict` rule: an all-`null` pair is a
      // FACT about the Space ("nothing configured, so the shipped bound governs")
      // and a swallowed failure would hand the editor that fact as its default,
      // printing a field that claims "unset" over a Space with a real ceiling.
      set({ error: describeIpcError(err) });
      console.error(
        `Failed to read the auto-chain guards of ${spacePath}:`,
        err,
      );
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
    positionWritesInFlight.clear();
    loadEpoch += 1;
    set(useTasks.getInitialState(), true);
  },
}));
