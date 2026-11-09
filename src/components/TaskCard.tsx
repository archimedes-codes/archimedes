import { MutedCaption } from "./MutedCaption";
import type { DragCardHandlers } from "../hooks/useDragCard";
import type { TaskRow } from "../lib/tauri";
import { relativeTimeFromInstant } from "../lib/sessionTime";
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
        // ADR 0097's RAISED rung: a card sits ON a column, so it goes up a step
        // while the column goes down one — the two used to share a single
        // translucent token, which made a card the same colour as the surface it
        // rested on with the separation carried entirely by the border.
        "flex flex-col gap-2 rounded-lg border border-card-border bg-card px-3 py-2.5",
        // A dragged card reads as LIFTED — its ink drops while it is in the air.
        // That is the card's ONLY state, because the card is what is being carried;
        // "you will land here" belongs to the column (see `data-over` above), so the
        // board never paints one target affordance twice.
      )}
    >
      {/* THREE ROWS: meta / title / chips-and-body. The reference board's anatomy,
          with our ladder and our tokens rather than its. */}
      <div className="flex items-center justify-between gap-2">
        {/* The number is a PILL now, and its fill is the PAGE step: it has to
            differ from BOTH surfaces it can land on — the column's `bg-panel` and
            this card's `bg-card` — in EVERY palette. `bg-chat` looked fine in
            Dracula (1.22 / 1.21) and is EXACTLY the card in zai-dark: its
            `color-mix` base is `--color-background-win-alt` `#2b2b2b`, which IS
            `--color-card` there, so 0.6·base + 0.4·card = the card. 1.00. Measured
            per palette in `slabFloatSeparation.test.ts`; `bg-background` is
            1.10/1.34 Dracula, 1.11/1.28 zai-dark, 1.06/1.06 zai-light. It stays its
            OWN text node — `T3` is the label a person says out loud and both board
            test files resolve a card through `getByText("T3")`. */}
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle">
          T{task.number}
        </span>
        {/* The same buckets the Session list prints, from a different instant —
            `task.updatedAt` is Unix ms (`now_ms()` in `db.rs`), so it goes through
            the ONE bucket rule rather than a copy of it. Its own element, never
            concatenated into the title: a merged `textContent` would silently break
            the board's `within(column).getByText(...)` scoping.

            Rendered through `MutedCaption` rather than by spelling the quiet-caption
            pair here, because `mutedCaption.test.ts` censuses that pair to ONE file
            and a card's timestamp IS that caption. `cn()` emits exactly the classes
            the anatomy calls for (`text-ui-xs text-foreground-subtlest shrink-0`). */}
        <MutedCaption className="shrink-0">
          {relativeTimeFromInstant(task.updatedAt)}
        </MutedCaption>
      </div>
      {/* WRAPS, and that is the fix: `truncate` was `overflow:hidden` +
          `white-space:nowrap`, so a two-line title lost its second half with no
          affordance on the one sentence a card exists to show. `line-clamp-2` still
          bounds the height a card strip can grow to, but it wraps to get there. */}
      <span className="line-clamp-2 font-medium leading-snug text-ui-base">
        {task.title}
      </span>
      {/* The chips row, and it renders ONLY when there is a chip to render — no
          placeholder for an absent field. `specPath` is stored and crosses IPC and
          nothing rendered it at all, so this is the field's first consumer; the path
          itself stays off the card (an absolute filesystem path on every card is not
          information, it is noise) and the chip says what it is. */}
      {task.specPath !== null && (
        <span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-ui-xs text-foreground-subtle">
          spec
        </span>
      )}
      {task.body && (
        <span className="line-clamp-2 text-ui-sm text-foreground-subtlest">
          {task.body}
        </span>
      )}
    </div>
  );
}
