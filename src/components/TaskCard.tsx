// `Array.prototype.at` is ES2022 and this project's `lib` is `["ES2020", "DOM"]`
// (`tsconfig.json`; `EmptyStateFilm.test.tsx` documents the same limit and reaches
// for `[length - 1]` instead). The pragma pulls in the ONE lib file that declares
// `at` for this module rather than raising the project's `lib` — a global `lib` bump
// would retypes the whole app for one call, and every `lib.es2022.*` member would
// become available to code that ships against a WebView whose support this repo has
// never censused. The runtime has had `at` since Chromium 92 / Safari 15.4, both far
// below the Tauri WebView this app targets, so this is a TYPES gap and not a shim.
/// <reference lib="es2022.array" />
import { MutedCaption } from "./MutedCaption";
import { moneyOf } from "./SessionCostLine";
import type { DragCardHandlers } from "../hooks/useDragCard";
import type { TaskRow, TaskSessionRow } from "../lib/tauri";
import { relativeTimeFromInstant } from "../lib/sessionTime";
import { cn } from "./lib/utils";

/**
 * One **Task** card on the board.
 *
 * PRESENTATIONAL, and deliberately thin. It takes a card's `TaskRow` plus the two
 * board-only facts the wire carries beside it (`sessions`, `costUsd`), the drag
 * surface the board's `useDragCard` instance produced for it, and one callback —
 * and it renders. It subscribes to NO store: the board already holds the slice, and
 * a card that read the store for itself would be a second owner of "which board is
 * showing" — the same reason `SessionListRow` takes its `drag` and `dropEdge` as
 * props rather than calling `useDragReorder` at the row. Issue #174 added the
 * sessions chip and the card still holds that line: the chip's callback is
 * `TasksBoard` forwarding `useSessions.getState().openSession`, not a read here.
 *
 * NOT a `RowButton`, and that is a decision rather than an oversight. `RowButton`'s
 * own header states the constraint: exactly ONE `role="button"` per row is
 * load-bearing, because `SpacesList.test.tsx` resolves rows through
 * `.closest('[role="button"]')` at eight sites, and `RowButton.test.tsx` keeps the
 * count at zero elsewhere. A card is also not one of the five row affordances that
 * component owns, and the CARD ITSELF is still not a control — it is DRAGGED, not
 * clicked, and it grows no `onClick` of its own. What issue #174 added is one
 * nested control, the sessions chip, and the distinction is what keeps both facts
 * true: the card stays a plain `div` with no `role` and no `tabindex` (pinned in
 * its test), and the chip is a real `<button>` INSIDE it, which is exactly the
 * shape `RowButton.test.tsx` proves contributes ZERO `[role="button"]` matches.
 * Opening a Task as a whole is still a later surface.
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
  /** This card's linked Sessions, OLDEST FIRST — exactly what the board read
   *  publishes (`ORDER BY ts.rowid ASC`, the same order `Db::task_sessions`
   *  uses). REQUIRED and not optional for the reason `TaskCardView.sessions` is
   *  required in `types.ts`: an optional prop compiles against a caller that
   *  forgot it, and a card that forgot it renders a linked card with no chip —
   *  silent, green, and wrong. The card renders ONE fact from this list: its
   *  length, plus the newest entry when the chip is clicked. */
  sessions: TaskSessionRow[];
  /** The summed cost of those Sessions, computed in RUST. `null` means "no linked
   *  Session ever had a call report a cost" and renders NO figure; `0` means "a
   *  real zero" and renders `$0.00`. That is ADR 0082, and the card does not own
   *  the rule — `moneyOf` does, imported rather than copied, so this surface and
   *  the Session line cannot drift apart. */
  costUsd: number | null;
  /** Opens a Session. The board hands this down as
   *  `useSessions.getState().openSession`; the card deliberately does NOT read the
   *  sessions store itself — that would give a presentational component a second
   *  store and make every test that renders one mock the world.
   *
   *  REQUIRED, on the same argument that made `sessions` and `costUsd` required
   *  above and every field of `TaskCardView` required in `types.ts` — an optional
   *  prop is this repo's silent-green shape, and here it is the WORST variant of it:
   *  the chip is a real `<button type="button">`, so a card rendered without this
   *  prop paints a keyboard-focusable control that does nothing at all. Nothing
   *  fails, nothing warns, the tab order just grows. `sessions.length > 0` cannot
   *  save it either, because the caller that omitted the callback is usually the one
   *  that also passed links. Requiring it moves the decision to the call site, which
   *  is the only place that knows whether a Session can be opened from there. */
  onOpenSession: (sessionId: string) => void;
  /** This card's `useDragCard` spread (`dragProps(task.id)`), or nothing when the
   *  board cannot drag (no board loaded yet). Absent means NO gesture at all —
   *  `draggable` is not spelled without the handlers that would answer it. */
  drag?: DragCardHandlers;
  /** This card is the one under drag. */
  active?: boolean;
}

export default function TaskCard({
  task,
  sessions,
  costUsd,
  onOpenSession,
  drag,
  active,
}: TaskCardProps) {
  // The chip's money, resolved through the ONE rule (ADR 0082). `null` is
  // "never reported" and prints NOTHING; `0` is "a real zero" and prints
  // `$0.00`. Gating on this value rather than on `costUsd` is the whole
  // difference: `costUsd && …` is false for `0` and would hide a reported zero,
  // and coalescing `null` to `0` before formatting invents a figure for a cost
  // nobody ever measured — which is why `moneyOf` is imported and the arithmetic
  // is never spelled at this site.
  const money = moneyOf(costUsd);
  // NEWEST is LAST, because the query is oldest-first. This is the same choice
  // `pick_compact_target` makes (`.last()`), so the card that opens a Session and
  // the board that compacts one never point at two different Sessions.
  //
  // `.at(-1)` and NOT `sessions[sessions.length - 1]`: the index form is `undefined`
  // for an empty list and the compiler does not say so — `tsconfig.json` sets no
  // `noUncheckedIndexedAccess` (verified), so the type lied. It was safe only while
  // the JSX guard beneath it held, which is a coincidence and not a contract: move
  // the guard, or reorder the rows, and the seeded board (five columns of cards with
  // no links, the common case) throws on render. `.at(-1)` returns `undefined` as
  // part of its type, so the render gate below can be put on the LINK ITSELF — one
  // condition decides both "is there a chip" and "what does the click open", where
  // the old shape had two conditions that merely happened to agree.
  const newest = sessions.at(-1);
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
      {/* The Sessions chip (issue #174): one clickable mark saying how many
          Sessions this card owns and what they cost in total — NOT a session list.
          The card is small, it is already a drag surface, and a per-session row is
          a different design (the issue records that as out of scope).

          A real `<button type="button">` and not a `<span>` with a click handler:
          it activates from the keyboard and it names itself to a screen reader. It
          carries NO `role`, so the card's own `role` stays absent (the card is
          dragged and not clicked, and `RowButton`'s one-`role="button"`-per-row
          rule is pinned above) — a `<button>` needs no role spelled, and spelling
          one would put a SECOND `[role="button"]` node in the tree the sidebar
          resolves rows through.

          GATED on the resolved link (`newest !== undefined`) and not on
          `sessions.length > 0`. Same answer — a link exists exactly when the newest
          one resolves — but ONE condition instead of two that merely happen to
          agree, and the value the click reads is the value that decided to render.
          The behaviour is unchanged: no links, no chip at all (pinned in the card's
          own test), no placeholder and no disabled affordance.

          NO `e.stopPropagation()`, and that is a measurement rather than an
          oversight: there is nothing to stop. This component has no other
          `onClick`; `useDragCard`'s five keys and `useDragReorder`'s six are all
          `DragEventHandler`s with no click or mouse handler; the board's two
          `onClick`s are the header's New-Task and the boost note's Dismiss, neither
          an ancestor of a card; and the only window-level mouse listeners in the
          app are `SidePane`'s pane resize. A handler that stops nothing is dead
          code that reads as load-bearing.

          `self-start` because the card is a `flex-col`: without it the button is
          stretched to the card's width and reads as a full-width action rather than
          the quiet mark it is. The fill is the page step (`bg-background`) for the
          same reason as the `T{n}` pill above — it has to differ from BOTH surfaces
          it can sit on (`bg-panel` column, `bg-card` card) in EVERY palette, and
          `bg-chat` is exactly `bg-card` in zai-dark. The ink-only hover is the
          `FileChip` idiom: an affordance that says "clickable" without gaining a
          second fill. */}
      {newest !== undefined && (
        <button
          type="button"
          onClick={() => onOpenSession(newest.sessionId)}
          className={cn(
            // The fill and geometry are the card's own pill recipe (see the `T{n}`
            // pill above). `self-start` is the chip's own addition: the card is a
            // `flex-col`, so without it the button stretches to the card's width and
            // reads as a full-width action instead of a quiet mark.
            //
            // The INK changes on hover and nothing else — no hover FILL, because a
            // second pill-shaped patch on a card that is itself the raised surface is
            // the "second button on the card" Dracula visual pass warns about, and no
            // `transition-*`, the same call `FileChip` records for its chip.
            "self-start cursor-pointer rounded-full bg-background px-2 py-0.5 text-ui-xs text-foreground-subtle hover:text-foreground",
          )}
        >
          {/* The count is the fact and the money is a segment of it, so they are ONE
              label and not two controls. `money` is `null` for "never reported" and
              the segment is then ABSENT rather than empty — ADR 0082's rule, owned by
              `moneyOf` and imported, never re-spelled here. */}
          {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          {money !== null && ` · ${money}`}
        </button>
      )}
      {task.body && (
        <span className="line-clamp-2 text-ui-sm text-foreground-subtlest">
          {task.body}
        </span>
      )}
    </div>
  );
}
