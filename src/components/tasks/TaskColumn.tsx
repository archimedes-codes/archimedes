import { useMemo } from "react";
import TaskCard, { type TaskCardProps } from "../TaskCard";
import { EmptyListLine } from "../EmptyListLine";
import { cn } from "../lib/utils";
import { useDragReorder } from "../../hooks/useDragReorder";
import {
  STAGE_COLUMN_ATTRIBUTE,
  type DragCardHandlers,
  type DropTargetHandlers,
} from "../../hooks/useDragCard";
import type { StageWithTasks, TaskCardView, TaskRow } from "../../lib/tauri";

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
export function TaskColumn({
  column,
  over,
  draggingTaskId,
  cardDrag,
  columnDrop,
  onOpenSession,
  onOpenTask,
  sessionStatusFor,
  launchStepFor,
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
  /** Opens a Session — the board's one read of `useSessions.getState().openSession`,
   *  forwarded to every card's chip (issue #174). It is threaded through here and
   *  not read again because the board owns the store reads and this column is
   *  already a pure function of what it was handed. */
  onOpenSession: (sessionId: string) => void;
  /** Opens this card's detail modal — the board's `detailTaskId` setter. */
  onOpenTask: (taskId: string) => void;
  /** This card's live session status (the mark), or `null` for "nothing to report".
   *
   *  A FACTORY taking the CARD rather than a pre-computed value, for the identical
   *  reason `launchStepFor` below spells itself that way: the column renders N cards
   *  and each card's answer comes from ITS OWN linked Sessions. The board makes the
   *  single `useSessionStatuses` call over the union of every visible card's ids and
   *  folds each card through the shared precedence; this column forwards, exactly as
   *  it forwards `onOpenSession`, so no store read and no derivation appears here. */
  sessionStatusFor: (card: TaskCardView) => TaskCardProps["sessionStatus"];
  /** Builds this card's primary-next-step pill (issue #179 §7.1), or `undefined` for
   *  "this Stage leads nowhere".
   *
   *  A FACTORY taking `(column, task)` rather than a pre-computed value, because the
   *  column renders N cards and each pill's `onLaunch` must close over ITS OWN card —
   *  a single pre-built prop would point every card's pill at one row. The board owns
   *  the derivation and the catalog gate; this column forwards, exactly as it forwards
   *  `onOpenSession`, so no store read appears here. */
  launchStepFor: (
    column: StageWithTasks,
    task: TaskRow,
  ) => TaskCardProps["launchStep"];
  onReorder: (ids: string[]) => void;
}) {
  const ids = useMemo(
    () => column.tasks.map((t) => t.task.id),
    [column.tasks],
  );
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
        "flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-card-border bg-panel p-2",
        // The drop-target band. `border-brand` is the SAME ink the two existing drag
        // call sites use for "you will land here" (`SessionListRow`'s `border-brand`
        // edge, `SpaceTabs`' `border-brand`), so one gesture keeps one visual language.
        over && "border-brand bg-selected",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-1">
        {/* `board.stage.label` — the NESTED read. A column built from the flat shape
            (`column.label`) renders an EMPTY header here with no type error, which is
            the failure mode `TasksBoard.test.tsx` pins by name. */}
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
          {column.stage.label}
        </span>
        {/* The count is a COUNT and not a caption, so it gets a fill — and the
            fill must differ from BOTH surfaces it can sit against (the column's
            `bg-panel` and the card's `bg-card`) in EVERY palette, which is the
            check `slabFloatSeparation.test.ts` now runs per palette. `bg-chat`
            passed that in Dracula (1.22 / 1.21) and is 1.00 — invisible — against
            `bg-card` in default-dark by construction, so the pill takes the page step:
            `bg-background` measures 1.10/1.34, 1.11/1.28, 1.06/1.06. */}
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle">
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
        // `flex flex-col gap-2` and NOTHING else. `flex-1` + `overflow-y-auto` are
        // deliberately GONE: they are what forced a column to fill its height and
        // scroll INTERNALLY, which is the behaviour this change removes — the column
        // now hugs its content and the BOARD scrolls (the scroller's
        // `overflow-y-auto`). `min-h-0` goes with them: it existed only to let that
        // inner scroller shrink. Pinned as classes in
        // `TasksBoard.test.tsx` ("the columns hug their content") because jsdom
        // performs no layout and a height cannot be asserted here.
        <div className="flex flex-col gap-2">
          {/* A board element is a `TaskCardView` (issue #174): the row the card
              renders sits under `.task`, so every id here reaches through it, and
              the wrapper's `sessions` / `costUsd` go to the card as the chip's two
              facts. This block used to be spelled as a `//` line comment, which is
              NOT a comment slot in JSX — jsdom printed the prose as the column's
              first child (it shows up in the DOM dump of any failing case in
              `TasksBoard.test.tsx`) and `tsc` could not see it. A brace-wrapped
              block comment is the only spelling that stays out of the render. */}
          {column.tasks.map((card) => {
            const edge = reorder.overId === card.task.id ? reorder.overEdge : null;
            return (
              // The SLOT carries the within-column surface and the drop-edge class;
              // the CARD inside it carries the cross-column surface and `draggable`.
              // Two spreads on one node would leave the second
              // `onDragOver`/`onDrop` winning in silence — see the header.
              <div
                key={card.task.id}
                data-testid="task-card-slot"
                data-edge={edge ?? undefined}
                {...reorder.dragProps(card.task.id)}
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
                  task={card.task}
                  sessions={card.sessions}
                  costUsd={card.costUsd}
                  artifactKeys={card.artifactKeys}
                  onOpenSession={onOpenSession}
                  onOpenTask={onOpenTask}
                  // The board's ONE status read, read back for THIS card's links.
                  sessionStatus={sessionStatusFor(card)}
                  launchStep={launchStepFor(column, card.task)}
                  drag={cardDrag(card.task.id)}
                  active={draggingTaskId === card.task.id}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
