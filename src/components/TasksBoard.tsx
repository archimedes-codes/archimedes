import { useEffect, useMemo, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import NewTaskDialog from "./NewTaskDialog";
import TaskCard from "./TaskCard";
import { EmptyListLine } from "./EmptyListLine";
import { IpcErrorLine } from "./IpcErrorLine";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { cn } from "./lib/utils";
import { useDragReorder } from "../hooks/useDragReorder";
import {
  STAGE_COLUMN_ATTRIBUTE,
  useDragCard,
  type DragCardHandlers,
  type DropTargetHandlers,
} from "../hooks/useDragCard";
import { useTasks } from "../store/tasks";
import type { StageWithTasks } from "../lib/tauri";

/**
 * The **Task board** — the surface `App`'s `"board"` view renders in place of the
 * chat column and the `SidePane`.
 *
 * IT LOADS ITS STORE ON MOUNT, NOT AT BOOT, and that is the load-bearing scheduling
 * decision. `App`'s boot `Promise.all([listSpaces, listSessions, sessionRecency])`
 * is untouched, so `App.test.tsx` gains no BOOT mock (whose absence is the
 * documented trap: that file's `vi.mock` factory spreads `importActual`, so an
 * un-mocked boot fetch rejects in jsdom and reddens tests that merely need a booted
 * store). The deeper reason is on the wire: `get_board` WRITES — it seeds the five
 * default stages for a Space that has none (ADR 0090's lazy seeding) — so fetching
 * it at boot would create columns in every Space on every launch, which is exactly
 * what the lazy-seeding decision refused to pay.
 *
 * TWO DRAGS, TWO HOOKS, ONE ELEMENT EACH — and the nesting is the whole design.
 * Spec §3 gives a card two verbs: a drop in ANOTHER column writes `stage_slug` and
 * runs that column's `on_enter` (`moveTask`); a drop in the SAME column writes
 * `sort_order` and nothing else (`reorderTasks`). Two hooks own those and neither is
 * generalised into the other (`useDragCard`'s header says why: the reorder hook's
 * spread surface is pinned at six keys for a byte-compared `RowButton`). Two
 * `dragProps` cannot be spread onto ONE element — the second `onDragOver`/`onDrop`
 * would silently win — so the board nests them:
 *
 *   column → `useDragCard.columnProps()`    (target half; catches an EMPTY column)
 *   slot   → `useDragReorder.dragProps()`   (within-column: the row IS the target)
 *   card   → `useDragCard.dragProps()`      (the draggable surface)
 *
 * Events bubble through all three and each answers a DIFFERENT question: the card's
 * asks "is this pointer over a column other than mine", the slot's asks "which edge
 * of which sibling am I over". A same-column drop is refused by the cross-column
 * hook and accepted by the reorder hook; a cross-column drop is refused by the
 * reorder hook (`!ids.includes` — the pointer is over no card of this column) and
 * accepted by the cross-column one. The two verbs are therefore mutually exclusive
 * BY CONSTRUCTION, not by a tie-break one of them has to remember.
 *
 * THE CARD IS A CHILD OF THE SLOT AND NOT THE SAME NODE, and that is a DOM rule
 * rather than a style choice: `draggable` inherits. A card inside a `draggable` slot
 * would make every child of a card a drag handle for BOTH surfaces at once. One
 * draggable node per gesture, one element.
 *
 * THIS BOARD HAS NO EXIT CONTROL, and that is deliberate rather than an omission.
 * ADR 0094 hoisted `SpacesList` above `App`'s view ternary, so the pane that holds
 * the `Tasks` door is on screen WHILE the board is up; with the strip acting as
 * the view switcher (N1) the pressed `Tasks` door toggles this view off and any
 * **Session** row leaves it too. Two exits per view, both owned by the pane — a
 * board-level `Back` would be a third way out that only this surface offered, and
 * it invited a reader to re-add a control the design retired.
 */
export interface TasksBoardProps {
  /** The active **Space**'s folder — the SAME derivation `SidePane` and the
   *  mention-picker catalogs use (`useActiveSpaceCwd`). `null` when no Session is
   *  active: the board renders its header and an empty line rather than calling
   *  `get_board(null)`. */
  activeSpacePath: string | null;
}

export default function TasksBoard({
  activeSpacePath,
}: TasksBoardProps) {
  const columns = useTasks((s) =>
    activeSpacePath ? s.boardsBySpace[activeSpacePath] : undefined,
  );
  const loading = useTasks((s) => s.loading);
  const error = useTasks((s) => s.error);
  const boostNote = useTasks((s) =>
    activeSpacePath ? s.boostNotes[activeSpacePath] : undefined,
  );
  const load = useTasks((s) => s.load);
  const moveCard = useTasks((s) => s.moveTask);
  const reorderInStage = useTasks((s) => s.reorderWithinStage);
  const dismissBoostNote = useTasks((s) => s.dismissBoostNote);
  // The New Task modal's open flag, in THIS component's state. It lives here
  // because this is where the board's columns already are — the modal needs the
  // first stage to file a Task under, and mounting it at `App` level would mean
  // a module-flag file plus a second read of this store for the same data. The
  // flag does not survive leaving the board, which is correct: the modal is the
  // board's affordance, and a Task already created survives because the store
  // and the sessions list own it, not this flag.
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  // The board reads its own store, on mount and whenever the Space changes. The
  // action captures its own failure into `error`, so nothing throws out of here.
  useEffect(() => {
    if (activeSpacePath === null) return;
    void load(activeSpacePath);
  }, [activeSpacePath, load]);

  // A STABLE array identity across renders that did not change the board. Both drag
  // hooks take the board as an argument and their handlers close over it, so a fresh
  // `?? []` every render would rebuild every handler every render — the same reason
  // `SpacesList` hoists `NO_SESSION_IDS` to module scope.
  const stages: readonly StageWithTasks[] = useMemo(() => columns ?? [], [columns]);

  /** The cross-column gesture, ONE instance for the whole board: it has to see every
   *  column to answer "is the pointer over a different one", so one instance per
   *  column would be N copies of one question. */
  const crossColumn = useDragCard({
    stages,
    onMove: (taskId, _fromStageSlug, toStageSlug) => {
      if (activeSpacePath === null) return;
      // `_from` is deliberately unread: Rust re-reads the row and runs the
      // DESTINATION's `on_enter`, and the client's view of the source can be stale
      // after an optimistic write. Forwarding it would give the drag a second,
      // client-side answer to a question the write already settles.
      void moveCard(activeSpacePath, taskId, toStageSlug);
    },
  });

  // Read once, then passed down: the column needs both, and reading them through the
  // hook's return object at each of N columns would be N property reads of one
  // render's answer.
  const { dragProps, columnProps, draggingTaskId, overStageSlug } = crossColumn;
  const columnDrop = columnProps();

  return (
    <section
      // ADR 0097: the frame plane is CHROME and every view surface is an ISLAND
      // above it. This root used to wear the chrome colour itself — the same one
      // the Session list is painted — so the board sat at contrast 1.00 against
      // the pane beside it and read as the background showing through rather than
      // as a surface. It now floats on the island recipe the Side pane and both
      // Settings halves wear: `m-1` (the 4px frame gap), `rounded-xl`, and the
      // transcript's own plane. `overflow-hidden` clips the island's corners, and
      // per the flexbox spec it also drops a flex item's automatic minimum size to
      // zero — which is why NO `min-height` utility is needed here on top of the
      // `min-w-0` that IS load-bearing: the parent (`content-row`) is a flex ROW,
      // so width is the main axis and without it a long row of `w-60` columns
      // would push this section wide instead of handing the overflow to the
      // scroller below.
      className="relative m-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-chat"
      data-testid="tasks-board"
      aria-label="Task board"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        {/* An `h1` because this surface replaces the whole content row while it is
            up, and a screen reader needs the surface named the way Settings' page is
            named. */}
        <h1 className="flex-1 text-ui-base font-medium">Tasks</h1>
        {/* The creation affordance. It sits in the header rather than inside a
            column because a new Task is not a property of any one column — the
            modal files it in the FIRST stage, which is a board-level fact.
            Disabled with no active Space: `createTask(null, …)` is not a thing,
            and a dead button that opens a modal which cannot send is worse than
            one that says nothing is open. */}
        <Button
          type="button"
          variant="ghost"
          size="default"
          aria-label="New task"
          className="h-8 shrink-0 gap-2 rounded-lg px-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          disabled={activeSpacePath === null}
          onClick={() => setNewTaskOpen(true)}
        >
          <PlusIcon className="size-4" />
          <span>New task</span>
        </Button>
      </header>

      {/* The two things a board render needs that are NOT board rows, and both are
          warnings rather than failures:
            - `boostNote`: the card MOVED and the destination's `on_enter` boost did
              not fire (spec §5's caveat 2 — a stored Session makes a `compact`
              compaction a silent no-op). Rendering it is the difference between a
              drag that is honest and one that is silently half-done.
            - `error`: the inline IPC-error line, which carries `role="alert"` so the
              failure is announced and not merely painted red.
          Both sit in the header band, ABOVE the columns: a note about a card that has
          already moved must not be attached to the column it moved into, where it
          would read as a property of the column. */}
      {boostNote && (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2"
          data-testid="boost-note"
          // `role="status"`, NOT `role="alert"`: this is not a failed action — the
          // card moved. `IpcErrorLine`'s header records that the `alert` region is
          // reserved for the things the user must react to; using it here would
          // announce a successful drag as a failure.
          role="status"
        >
          <span className="min-w-0 flex-1 text-ui-sm text-warning">{boostNote}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() =>
              activeSpacePath !== null && dismissBoostNote(activeSpacePath)
            }
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      )}
      <IpcErrorLine error={error} className="shrink-0 px-3 pb-2" />

      {activeSpacePath === null ? (
        <EmptyListLine>
          No Space is open, so there is no Task board to show.
        </EmptyListLine>
      ) : columns === undefined && loading ? (
        // `Spinner` IS the `role="status"` node (it sets it itself), so this wrapper
        // adds no second live region — a wrapper with its own `role="status"` would
        // make `getByRole("status")` throw on multiple matches.
        <div className="flex items-center gap-2 p-3">
          <Spinner className="size-4 text-foreground-subtlest" />
          <span className="text-ui-sm text-foreground-subtlest">
            Loading the task board…
          </span>
        </div>
      ) : columns === undefined ? (
        // Loaded-but-empty is NOT the same state as never-loaded, and after a failure
        // `columns` is still `undefined` — so this line is what a user sees under the
        // error, and it must not claim the board is empty when the FETCH failed.
        <EmptyListLine>The board has not loaded yet.</EmptyListLine>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto">
          {stages.length === 0 ? (
            <EmptyListLine>This Space has no stages yet.</EmptyListLine>
          ) : (
            stages.map((column) => (
              <TaskColumn
                key={column.stage.slug}
                column={column}
                over={overStageSlug === column.stage.slug}
                draggingTaskId={draggingTaskId}
                cardDrag={dragProps}
                columnDrop={columnDrop}
                onReorder={(ids) =>
                  reorderInStage(activeSpacePath, column.stage.slug, ids)
                }
              />
            ))
          )}
        </div>
      )}

      {/* The New Task modal (spec §3). Rendered from THIS component's flag, as a
          child of the board's `section`: `DialogContent` portals to `body`, so
          nesting it here costs nothing in layout and keeps the data it needs (the
          columns, the active Space) right where it is read. It is mounted only
          while open — a closed modal that keeps a `MessageList` and a composer
          alive would be a second idle chat surface behind the board. */}
      {newTaskOpen && (
        <NewTaskDialog
          spacePath={activeSpacePath}
          boards={stages}
          onClose={() => setNewTaskOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * One column: its header, and the card strip that carries the within-column surface.
 *
 * A SEPARATE COMPONENT because `useDragReorder` is a hook and a hook cannot be
 * called inside `.map()` — the per-column instance needs a per-column component.
 * That is also what keeps the reorder hook's `ids` slice honest: it is exactly THIS
 * column's card ids in THIS column's order, which is the slice `reorderTasks` writes
 * (`sort_order` is per-Space, so a slice spanning two columns would renumber a card
 * the user never dragged).
 */
function TaskColumn({
  column,
  over,
  draggingTaskId,
  cardDrag,
  columnDrop,
  onReorder,
}: {
  column: StageWithTasks;
  /** The pointer is over THIS column with a card from another column in hand. */
  over: boolean;
  /** The card the board is currently carrying, or `null`. */
  draggingTaskId: string | null;
  /** The board-wide cross-column card surface (`dragProps(id)`). */
  cardDrag: (taskId: string) => DragCardHandlers;
  /** The board-wide cross-column column surface (the target half). */
  columnDrop: DropTargetHandlers;
  onReorder: (ids: string[]) => void;
}) {
  const ids = useMemo(() => column.tasks.map((t) => t.id), [column.tasks]);
  // The within-column gesture, reused UNCHANGED with the default `axis: "y"` — a
  // vertical strip, so the pointer's half of the target row is read off Y. Nothing
  // here computes an index: the hook already answers before-or-after for the
  // sidebar's rows and the tab strip, and a second copy of that arithmetic in the
  // board is the drift it exists to prevent.
  const reorder = useDragReorder({ ids, onReorder });

  return (
    <div
      // The marker `useDragCard`'s hit test reads to resolve which column a pointer
      // is over. The shared constant is spread rather than re-spelled as a literal so
      // the string has ONE owner — a rename in the hook cannot leave it hunting for a
      // marker nothing emits. It sits on the COLUMN and not the strip because the
      // strip is what scrolls: a rect covering only the visible part would refuse a
      // drop near a column's edge.
      {...{ [STAGE_COLUMN_ATTRIBUTE]: column.stage.slug }}
      {...columnDrop}
      data-testid={`task-column-${column.stage.slug}`}
      data-over={over ? "true" : undefined}
      // `cn()` and NOT a ternary over two class lists: `classNameConvention.test.ts`
      // gates every ternary-shaped `className` through a pinned allowlist, and here
      // `cn()` is also simply the right tool — `bg-selected` must win the background
      // group against the resting `bg-panel`, which a merge does and a concatenation
      // leaves to CSS order.
      className={cn(
        "flex w-60 shrink-0 flex-col gap-1.5 rounded-lg border border-border bg-panel p-1.5",
        // The drop-target band. `border-brand` is the SAME ink the two existing drag
        // call sites use for "you will land here" (`SessionListRow`'s `border-brand`
        // edge, `SpaceTabs`' `border-brand`), so one gesture keeps one visual language.
        over && "border-brand bg-selected",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-1">
        {/* `board.stage.label` — the NESTED read. A column built from the flat shape
            (`column.label`) renders an EMPTY header here with no type error, which is
            the failure mode `TasksBoard.test.tsx` pins by name. */}
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
          {column.stage.label}
        </span>
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {column.tasks.length}
        </span>
        {/* The column's `on_enter` is what makes a kanban column more than a label, so
            it is visible rather than buried. */}
        {column.stage.onEnter !== "none" && (
          <span
            className="shrink-0 text-ui-sm text-foreground-subtlest"
            title={`Entering this stage runs: ${column.stage.onEnter}`}
          >
            {column.stage.onEnter}
          </span>
        )}
      </div>

      {column.tasks.length === 0 ? (
        // An EMPTY column still renders its header and this line, and it is still a
        // drop target (the column surface above). The seeded default board is five
        // columns and usually zero cards, so "empty column" is the common case.
        <EmptyListLine>No tasks.</EmptyListLine>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {column.tasks.map((task) => {
            const edge = reorder.overId === task.id ? reorder.overEdge : null;
            return (
              // The SLOT carries the within-column surface and the drop-edge class;
              // the CARD inside it carries the cross-column surface and `draggable`.
              // Two spreads on one node would leave the second
              // `onDragOver`/`onDrop` winning in silence — see the header.
              <div
                key={task.id}
                data-testid="task-card-slot"
                data-edge={edge ?? undefined}
                {...reorder.dragProps(task.id)}
                className={cn(
                  // `border-2` is reserved for the drop edge (the
                  // `SessionListRow`/`SpaceTabs` idiom), so the slot carries no border
                  // at rest and the edge cannot be swallowed by a merge.
                  "rounded-lg",
                  edge === "before" && "border-t-2 border-brand",
                  edge === "after" && "border-b-2 border-brand",
                )}
              >
                <TaskCard
                  task={task}
                  drag={cardDrag(task.id)}
                  active={draggingTaskId === task.id}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
