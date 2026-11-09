import type { DragCardHandlers } from "../hooks/useDragCard";
import type { TaskRow } from "../lib/tauri";
import { cn } from "./lib/utils";

/**
 * One **Task** card on the board.
 *
 * PRESENTATIONAL, and deliberately thin. It takes a `TaskRow` and the drag surface
 * the board's `useDragCard` instance produced for it, and it renders. It subscribes
 * to NO store: the board already holds the slice, and a card that read the store
 * for itself would be a second owner of "which board is showing" — the same reason
 * `SessionListRow` takes its `drag` and `dropEdge` as props rather than calling
 * `useDragReorder` at the row.
 *
 * NOT a `RowButton`, and that is a decision rather than an oversight. `RowButton`'s
 * own header states the constraint: exactly ONE `role="button"` per row is
 * load-bearing, because `SpacesList.test.tsx` resolves rows through
 * `.closest('[role="button"]')` at eight sites, and `RowButton.test.tsx` keeps the
 * count at zero elsewhere. A card is also not one of the five row affordances that
 * component owns, and in v1 it is not a control at all — it is DRAGGED, not
 * clicked. Opening a Task is a later surface.
 *
 * THE DRAG SURFACE IT SPREADS IS `useDragCard`'s FIVE-KEY one, not
 * `useDragReorder`'s six-key `DragReorderHandlers`. That distinction is the whole
 * reason two hooks exist — the reorder surface is pinned at six keys because
 * `RowButton` spreads it VERBATIM onto a byte-compared row — and because the two
 * prop types are structurally similar enough that a widened type would let the
 * wrong one through, `TaskCard.test.tsx` pins the choice against this file's source
 * as well as against behaviour.
 *
 * `T{n}` is the label a person says out loud ("move T3 to doing"); `number` is
 * per-Space. The card renders that label and NOT the `tsk_<uuid>` id — the id is
 * the key every command takes and it belongs in the drag payload, which is why it
 * rides as a `data-` attribute instead of as visible text (ADR 0090: the number and
 * the id are never interchangeable).
 */
export interface TaskCardProps {
  task: TaskRow;
  /** This card's `useDragCard` spread (`dragProps(task.id)`), or nothing when the
   *  board cannot drag (no board loaded yet). Absent means NO gesture at all —
   *  `draggable` is not spelled without the handlers that would answer it. */
  drag?: DragCardHandlers;
  /** This card is the one under drag. */
  active?: boolean;
}

export default function TaskCard({ task, drag, active }: TaskCardProps) {
  return (
    <div
      data-testid="task-card"
      data-task-id={task.id}
      // The gesture state is DATA and not only a class, for the same reason
      // `SessionStatusMark` is queried by `data-dot`: a test that asserts on the
      // STATE cannot pass because a different utility happened to survive
      // tailwind-merge. `active` is `false` rather than `undefined` while no drag is
      // on, so the attribute is absent (not `"false"`) unless the card really is the
      // one being dragged.
      //
      // There is deliberately NO "this is the drop target" attribute here. The
      // COLUMN owns that affordance (`TasksBoard` marks `data-over` on the column),
      // and a second copy on every card inside the targeted column would paint N
      // borders for one target — two answers to one question.
      data-dragging={active ? "true" : undefined}
      // The drag surface goes LAST so its `draggable` (and only that) is what the
      // DOM shows; nothing else in `drag` is an attribute. Spreading it verbatim is
      // the point — the hook owns the handler set and this component does not get to
      // reorder it.
      {...drag}
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border bg-surface px-2.5 py-2",
        // A dragged card reads as LIFTED — its ink drops while it is in the air.
        // That is the card's ONLY state, because the card is what is being carried;
        // "you will land here" belongs to the column (see `data-over` above), so the
        // board never paints one target affordance twice.
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          T{task.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-base">{task.title}</span>
      </div>
      {task.body && (
        <span className="line-clamp-2 text-ui-sm text-foreground-subtlest">
          {task.body}
        </span>
      )}
    </div>
  );
}
