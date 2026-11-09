import { useCallback, useState } from "react";
import type { DragEventHandler, DragEvent as ReactDragEvent } from "react";
import type { StageWithTasks } from "../lib/tauri";

/**
 * The CROSS-COLUMN card gesture — a card lifted out of one **Stage** and dropped
 * into another, which is the one drag that writes `stage_slug` and runs the
 * destination's `on_enter` (spec §3's drag table, mirrored by the harness's
 * `move_task`).
 *
 * WHY A SECOND HOOK, AND WHY THAT IS THE LOAD-BEARING DECISION.
 * `useDragReorder` already does drag, and "generalise it" is the obvious move. It
 * is wrong. That hook's `dragProps` returns EXACTLY six keys and is spread
 * VERBATIM onto a byte-compared `RowButton`, whose header pins attribute order as
 * part of its contract — a seventh key is an unknown DOM attribute on a row whose
 * serialisation is byte-compared. Its own `axis` doc says the same thing about
 * that hook's own argument ("AN ARGUMENT, NEVER A SPREAD KEY"). So the board's
 * gesture defines its OWN surface here, and `useDragCard.test.tsx` pins the key
 * set so a later "dedupe the drag hooks" sweep cannot merge them. WITHIN a column
 * the board still uses `useDragReorder` unchanged (`axis: "y"`), because within a
 * column position means only position (ADR 0075) and that hook already answers the
 * before/after question once, in one copy, for both existing lists.
 *
 * TWO SURFACES, NOT ONE, and the empty column is why.
 * A card-level `onDragOver`/`onDrop` can only fire over a CARD. The seeded default
 * board (`backlog`/`research`/`approved`/`doing`/`done`, ADR 0090) is FIVE columns
 * and usually zero cards, so a card-level-only target could never land a card in
 * an empty column — which is the most common drop on a fresh board, and it would
 * fail silently because the release would fall through to the window backstop.
 * Hence `columnProps`: the TARGET half (two handlers, no `draggable` — a draggable
 * column would start a drag whose payload is a stage slug). Both surfaces share
 * one resolution function, and the column's half stands down when the card's half
 * already prevented the event, so a drop over a card fires `onMove` ONCE rather
 * than twice on the way out through the bubble.
 *
 * THE POINTER DECIDES, NOT THE EVENT TARGET. Resolving through
 * `closest("[data-stage-slug]")` answers the column the CARD lives in, so a drop
 * would land where the card LIVES rather than where the POINTER is — the same
 * family of defect `useDragReorder` documents for reading the wrong axis, and the
 * same silent-no-op shape. So the hit test walks the column rects and asks which
 * one contains `clientX`/`clientY`.
 *
 * A COLUMN WITH NO LAYOUT IS NEVER A HIT, and that is a property of the comparison
 * rather than a special case: `clientX < rect.right` is STRICT, so a zero-area rect
 * (`left === right === 0`, which is jsdom's default and any subtree that was never
 * laid out) cannot contain a pointer. `useDragCard.test.tsx` pins the behaviour
 * with no `layOut` call at all, so a hook that ignored rects — the obvious shortcut
 * being `closest("[data-stage-slug]")` on the event target, which answers the
 * column the CARD lives in — reddens there instead of agreeing by accident.
 *
 * It renders nothing, mutates no class, and knows nothing about what a drop MEANS:
 * it calls `onMove(taskId, from, to)` and the board decides (which is
 * `useTasks.moveTask`, which is `moveTask` over IPC). Like `useDragReorder` it
 * never halts propagation — the window drop backstop listens on `window`, the
 * card's handler fires first during bubbling, and a release outside any target
 * still reaches the backstop, the only thing between a stray drop and the webview
 * NAVIGATING to it.
 */

/** THE card's spread surface: `draggable` + FOUR handlers. Five keys, deliberately
 *  NOT the sibling hook's six — see the header. `TaskCard` spreads this verbatim
 *  and it is not a byte-compared `RowButton`, so these keys reach the DOM as
 *  attributes and handlers and nothing else. */
export interface DragCardHandlers {
  draggable: true;
  onDragStart: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
  onDragEnd: DragEventHandler<HTMLDivElement>;
}

/** A column's spread surface: the TARGET half only. No `draggable` — a column that
 *  started a drag would carry a stage slug as its payload and the drop would try to
 *  move a column. */
export interface DropTargetHandlers {
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
}

export interface UseDragCard {
  /** Spread onto the draggable card. */
  dragProps: (taskId: string) => DragCardHandlers;
  /** Spread onto a column, so an EMPTY column can still receive a card. Takes no
   *  slug: the column's identity is the `data-stage-slug` attribute the same call
   *  site sets, and the hook reads THAT to resolve a target — a second spelling of
   *  the slug here would be a second owner of one fact, free to disagree. */
  columnProps: () => DropTargetHandlers;
  /** The card under drag, or `null`. */
  draggingTaskId: string | null;
  /** The column the pointer is over while dragging AND which differs from the
   *  dragged card's own column — i.e. the column a release would move the card
   *  into. `null` means "this release moves nothing", and the call site paints no
   *  affordance for it. */
  overStageSlug: string | null;
}

/** The attribute a board column carries so the hit test can find the columns.
 *  Named here because the board sets it and this hook reads it — one owner for the
 *  string, so a rename cannot leave the hook hunting for a marker nothing emits. */
export const STAGE_COLUMN_ATTRIBUTE = "data-stage-slug";

/** Which column's box contains the pointer, or `null`.
 *
 *  A column with NO layout is never a hit, and that is a property of the
 *  comparison rather than a special case: every bound is strict on the far side
 *  (`clientX < rect.right`), so a zero-area rect — jsdom's default, and any
 *  subtree that was never laid out — cannot contain a pointer. `useDragCard.test.tsx`
 *  pins that behaviour with no `layOut` call at all, which is what reddens a hook
 *  that ignored rects entirely.
 *
 *  The LAST match wins, so overlapping boxes resolve in favour of whichever column
 *  is painted later in the board's order rather than whichever the walk happened to
 *  reach first. */
function columnUnderPointer(clientX: number, clientY: number): string | null {
  let found: string | null = null;
  for (const el of document.querySelectorAll<HTMLElement>(
    `[${STAGE_COLUMN_ATTRIBUTE}]`,
  )) {
    const rect = el.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      found = el.getAttribute(STAGE_COLUMN_ATTRIBUTE);
    }
  }
  return found;
}

export function useDragCard(args: {
  /** The board as the LAST RENDER saw it — the source for both "which column does
   *  this card live in" and "is this slug one the Space actually has". */
  stages: readonly StageWithTasks[];
  /** Called ONLY for a drop that changes column, with the column the card came
   *  from. A same-column release is `useDragReorder`'s gesture, not this one. */
  onMove: (taskId: string, fromStageSlug: string, toStageSlug: string) => void;
}): UseDragCard {
  const { stages, onMove } = args;
  // `useState`, not refs: the board RENDERS the drop affordance from
  // `overStageSlug`, so a ref would be invisible exactly where it is needed. The
  // handlers are rebuilt per render and close over THAT render's `stages` /
  // `onMove`, which is correct — a drag event is a discrete task and React flushes
  // state between two of them (measured in `useDragReorder.test.tsx`), so a drop
  // always reads the board as the last render showed it.
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [overStageSlug, setOverStageSlug] = useState<string | null>(null);

  /** The column a card lives in, per the board the last render showed. */
  const homeOf = useCallback(
    (taskId: string): string | null =>
      stages.find((column) => column.tasks.some((t) => t.id === taskId))?.stage
        .slug ?? null,
    [stages],
  );

  /** The column the pointer is over, but only if the board HAS that column.
   *  A slug the Space does not own is `null`: Rust refuses it, and a locally
   *  refused drop shows no affordance rather than promising a column that will
   *  reject. */
  const targetUnder = useCallback(
    (clientX: number, clientY: number): string | null => {
      const slug = columnUnderPointer(clientX, clientY);
      if (slug === null) return null;
      return stages.some((column) => column.stage.slug === slug) ? slug : null;
    },
    [stages],
  );

  /** The shared `dragover` answer: mark the column and accept the drop, but ONLY
   *  for a column that differs from the card's own. Same column → nothing
   *  prevented, which is what shows the browser's no-drop cursor and hands the
   *  release to the window backstop. */
  const handleDragOver = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      // The column's copy stands down when the card's copy already answered —
      // otherwise the same gesture would run twice on the way out through the
      // bubble, and the second `setOverStageSlug` would be a wasted render.
      if (e.defaultPrevented) return;
      if (draggingTaskId === null) return;
      const home = homeOf(draggingTaskId);
      const slug = targetUnder(e.clientX, e.clientY);
      if (slug === null || slug === home) return;
      e.preventDefault();
      if (overStageSlug !== slug) setOverStageSlug(slug);
    },
    [draggingTaskId, homeOf, overStageSlug, targetUnder],
  );

  /** The shared `drop` answer. Reads the pointer rather than `overStageSlug`, so a
   *  column that was never marked (a fast drag with no intervening `dragover`,
   *  which real browsers do produce) still lands. */
  const handleDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) return;
      const moved = draggingTaskId;
      // The three refusals, each clearing the gesture and NONE of them preventing
      // the event (an inert release belongs to the window backstop):
      //  - no drag in flight;
      //  - the card left the board mid-drag (`home === null`) — moving an id the
      //    current slice does not contain fires an IPC over a slice the UI never
      //    showed, the same guard `useDragReorder` carries;
      //  - the pointer is over the card's own column, or over nothing.
      if (moved === null) return;
      const home = homeOf(moved);
      const slug = targetUnder(e.clientX, e.clientY);
      if (home === null || slug === null || slug === home) {
        setDraggingTaskId(null);
        setOverStageSlug(null);
        return;
      }
      e.preventDefault();
      setDraggingTaskId(null);
      setOverStageSlug(null);
      onMove(moved, home, slug);
    },
    [draggingTaskId, homeOf, onMove, targetUnder],
  );

  const dragProps = useCallback(
    (taskId: string): DragCardHandlers => ({
      draggable: true,
      onDragStart: (e) => {
        // Firefox starts no drag unless the payload is written. jsdom has no
        // DataTransfer, hence the optional chain. `getData` is never read: the id
        // lives in state and this is a single-window app.
        e.dataTransfer?.setData("text/plain", taskId);
        setDraggingTaskId(taskId);
        // A previous gesture's mark must not survive into this one: the mark means
        // "a release HERE moves the card", and it would be answering about the
        // card that was being dragged a moment ago.
        setOverStageSlug(null);
      },
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      onDragEnd: () => {
        // Escape mid-drag fires `dragend` and NO `drop`, so this is the only thing
        // that can clear the gesture on that path. A lingering `draggingTaskId`
        // would make the next `dragover` believe a drag is on.
        setDraggingTaskId(null);
        setOverStageSlug(null);
      },
    }),
    [handleDragOver, handleDrop],
  );

  const columnProps = useCallback(
    (): DropTargetHandlers => ({
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    }),
    [handleDragOver, handleDrop],
  );

  return { dragProps, columnProps, draggingTaskId, overStageSlug };
}
