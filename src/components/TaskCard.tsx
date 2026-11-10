import { MutedCaption } from "./MutedCaption";
import { RowButton } from "./RowButton";
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
 * THE CARD IS A `RowButton` SINCE ISSUE #177, and that reverses this file's
 * original position, so the reasoning is recorded on BOTH sides. It used to say the
 * card was deliberately NOT a control: it is DRAGGED, not clicked, and it grew no
 * `onClick` of its own. What it also said — "Opening a Task as a whole is still a
 * later surface" — is the surface that arrived here. Once clicking a card is how
 * you read a card, a card whose area is not clickable reads as broken, so the
 * question was never whether to add the affordance but whether to add it to the CARD
 * or as a THIRD control beside the chip. The card won: a card that looks like a
 * card and must be hit in a 12px corner to open is worse than a card that is a row.
 *
 * `RowButton` and not a hand-rolled `role="button"` — it is the repo's ONE component
 * for this affordance (five surfaces already use it), and its header's constraint is
 * the thing this change has to respect rather than escape: EXACTLY ONE
 * `role="button"` per row, because `SpacesList.test.tsx` resolves rows through
 * `.closest('[role="button"]')` at eight sites. The sessions chip therefore stays a
 * plain `<button type="button">` with NO role, so it contributes zero selector
 * matches — `RowButton.test.tsx` proves that shape contributes nothing, and
 * `TaskCard.test.tsx` re-pins it for the card.
 *
 * TWO GESTURES, ONE ELEMENT, and the ORDER of the spreads is what makes it work.
 * `RowButton` emits `role` / `tabIndex` / its own `onClick` / `className` and then
 * spreads `...rest`, so `drag` goes through `rest` and its `draggable` plus four
 * `DragEventHandler`s land AFTER — nothing is overwritten, because the two surfaces
 * share no key (`onClick` vs `onDragOver`). A `drag` surface that ever grew an
 * `onClick` would silently win over the row's, which is the failure mode to look for
 * if cards stop opening.
 *
 * THE CHIP STOPS PROPAGATION NOW. Its old comment measured "there is nothing to
 * stop" against a card with no `onClick`; the card has one, so an unstopped chip
 * click opens the Session AND paints the detail modal over the transcript the user
 * just asked to see.
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
  /** Opens this card's **Task detail modal**. REQUIRED for the same reason
   *  `onOpenSession` is: the card is now a `RowButton`, so a card rendered without
   *  this prop is a keyboard-focusable row that does nothing when activated — the
   *  silent-green shape this file already argues against one prop above. */
  onOpenTask: (taskId: string) => void;
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
  onOpenTask,
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
  // The link is resolved ONCE, UP FRONT, and the chip below is gated on the resolved
  // value — not on a second, separately-spelled condition. That is the safety
  // property: `sessions[sessions.length - 1]` is `undefined` for an empty list and
  // the compiler does not say so (`tsconfig.json` sets no `noUncheckedIndexedAccess`,
  // verified), so an unguarded read hands back a value that was never resolved while
  // still typing as a link. Whatever JSX guard happens to sit below it is then doing
  // all the work by coincidence: move the guard, or reorder the rows, and the seeded
  // board (five columns of cards with no links, the common case) throws on render.
  // Resolving behind the non-emptiness check means the only way `newest` is a link is
  // that a link was actually read, and `newest !== undefined` at the chip decides
  // both "is there a chip" and "what does the click open" from that ONE value.
  //
  // The ternary form is DELIBERATE and not a missed simplification: this project's
  // `lib` is `["ES2020", "DOM"]` and an ES2020 target does not down-level
  // `Array.prototype.at`, so reaching for it here would put an ES2022 runtime member
  // in the shipped bundle for a cosmetic win — and the WebView this app ships into is
  // WebKitGTK on Linux, whose version varies by distro and which `docs/decisions/`
  // records no minimum for. `EmptyStateFilm.test.tsx` documents the same `lib` limit
  // and reaches for a `[length - 1]` index for the same reason. Do not "tidy" this
  // line into a call to `Array.prototype.at`: that re-adds an unverified runtime
  // dependency to buy nothing.
  const newest = sessions.length > 0 ? sessions[sessions.length - 1] : undefined;
  return (
    <RowButton
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
      // The row's own activation, spelled BEFORE `{...drag}` for readability only —
      // the two surfaces share no key, so order cannot change which handler wins.
      // `task.id` and not the card's title: the id is the key every command takes.
      onClick={() => onOpenTask(task.id)}
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
        // That is the card's ONLY drag state, because the card is what is being
        // carried; "you will land here" belongs to the column (see `data-over`
        // above), so the board never paints one target affordance twice.
        //
        // `cursor-pointer` is NEW and it is load-bearing rather than decorative: a
        // card that opens on click but wears the default arrow reads as text, and
        // the pointer is the only thing distinguishing "click me" from "drag me" on
        // a surface that does BOTH.
        "cursor-pointer",
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

          GATED on the resolved link (`newest !== undefined`) rather than on a fresh
          `sessions.length > 0` written here at the JSX: the non-emptiness check
          belongs to the RESOLUTION above, and repeating it at the render site would
          put two conditions where one value already decides both "is there a chip"
          and "what does the click open". The value the click reads IS the value that
          decided to render. The behaviour is unchanged: no links, no chip at all
          (pinned in the card's own test), no placeholder and no disabled affordance.

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
          // STOPPED, and that reverses the measurement this comment used to carry
          // ("NO `e.stopPropagation()`, because there is nothing to stop"). There IS
          // something to stop now: the card became a `RowButton`, so an unstopped
          // chip click bubbles into the row's `onClick` and opens the detail modal ON
          // TOP of the Session the click just asked to see. This is the one place in
          // the app where a nested control sits inside a `RowButton` that this file
          // owns, and it is the reason `RowButton`'s one-role-per-row rule and this
          // call live in the same file.
          onClick={(e) => {
            e.stopPropagation();
            onOpenSession(newest.sessionId);
          }}
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
    </RowButton>
  );
}
