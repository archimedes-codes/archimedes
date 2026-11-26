import { BellRingIcon, MessageSquareIcon } from "lucide-react";
import { MutedCaption } from "./MutedCaption";
import { RowButton } from "./RowButton";
import { moneyOf } from "./SessionCostLine";
import { SessionStatusMark } from "./SessionStatusMark";
import type { DragCardHandlers } from "../hooks/useDragCard";
import type { SessionStatus } from "../hooks/useSessionStatus";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import type { TaskRow, TaskSessionRow } from "../lib/tauri";
import { absoluteTimeFromInstant, relativeTimeFromInstant } from "../lib/sessionTime";
import { cardMarkOf } from "../lib/sessionStatusRollup";
import { cn } from "./lib/utils";

/** The mark's box in px — the same box `SessionStatusMark` is given on this card
 *  (`size={14}`). A card wears ONE mark chosen by `cardMarkOf`, so the two glyphs it
 *  can wear occupy ONE slot: if they differed in size, a card whose Session settled
 *  mid-glance would visibly jitter in the spot the eye is already on. */
const READY_GLYPH_SIZE_PX = 14;

/** The `ready` glyph's `stroke-width` attribute for that box.
 *
 *  Lucide draws on a 24-unit viewBox at `stroke-width: 2`, so sizing an icon by
 *  width scales the stroke with it and a 14px box renders ~1.17px — a hairline, on
 *  the one mark that has no text beside it to fall back on. The compensation is the
 *  same arithmetic `SessionStatusMark`'s `questionStrokeWidth` applies to its `?`,
 *  with the same rendered weight (1.25 device px), so whichever of the two marks is
 *  painted carries one stroke weight — the same one-slot argument as the size.
 *
 *  It is spelled HERE rather than imported because `questionStrokeWidth` and its
 *  constant are module-PRIVATE to that component, and exporting them would widen a
 *  file this change deliberately does not touch. The two are therefore a deliberate
 *  pair: if the mark's weight changes, change both, and the comment in each names
 *  the other. */
const READY_GLYPH_STROKE_WIDTH = (1.25 * 24) / READY_GLYPH_SIZE_PX;

/** Artifact/spec chips shown on a card before the rest collapse into `+N`. */
const MAX_VISIBLE_CHIPS = 2;

/** The ONE chip recipe for the name chips and the `+N` overflow chip. `rounded-md`
 *  on purpose: the `T{n}` badge is the card's only `rounded-full` pill
 *  (`slabFloatSeparation.test.ts` censuses that literal at ONE). `bg-background` +
 *  `text-foreground-subtle` is the same measured page-step recipe the pills used,
 *  so contrast is unchanged. */
const CHIP_CLASS =
  "rounded-md bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle";

/**
 * One **Task** card on the board.
 *
 * PRESENTATIONAL, and deliberately thin. It takes a card's `TaskRow` plus the
 * board-only facts that ride beside it on the wire (`sessions`, `costUsd`,
 * `artifactKeys`) plus the one fact the board DERIVES for it (`sessionStatus`, the
 * live mark), the drag surface the board's `useDragCard` instance produced for it,
 * and two callbacks — and it renders. It subscribes to NO store: the board already
 * holds the slice, and a card that read the store for itself would be a second
 * owner of "which board is
 * showing" — the same reason `SessionListRow` takes its `drag` and `dropEdge` as
 * props rather than calling `useDragReorder` at the row. Issue #174 added the
 * sessions chip and the card still holds that line: the chip's callback is
 * `TasksBoard` forwarding `useSessions.getState().openSession`, not a read here.
 *
 * THE CARD IS A `RowButton` SINCE PR #178, and that reverses this file's
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
 * `.closest('[role="button"]')` at eight sites. The sessions link therefore stays a
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
  /** The artifact KEYS on this card (issue #180, spec §3) — T4's
   *  `TaskCardView.artifactKeys`, threaded by the board.
   *
   *  REQUIRED, and for the identical reason `sessions` and `costUsd` above are: an
   *  optional prop compiles against every fixture in the repo and then renders
   *  NOTHING when real data arrives — a card with artifacts and no chips is silent,
   *  green and wrong. The board always holds the field (it is REQUIRED on
   *  `TaskCardView`, because `Vec<String>` has no `None`), so a caller that omits it
   *  is a caller that forgot, and that is a type error rather than a runtime case.
   *
   *  It is NOT read off `task`: `TaskRow` has no such field by design (ADR 0100 —
   *  the keys ride the `TaskCardView` WRAPPER so `get_task` / `create_task` /
   *  `edit_task` keep returning an honest 10-field row). The prop IS the value.
   *
   *  NAMES ONLY, never the markdown. The board read runs for every card on every
   *  mount, so a document on that payload would put every Task's every artifact on
   *  the wire to render a label; the detail dialog fetches content on request. */
  artifactKeys: string[];
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
  /** This card's **live session state**, folded out of its linked Sessions by the
   *  board: `waiting` (a linked Session is parked on a human), `running` (one is in
   *  a turn), or `null` for "nothing to report".
   *
   *  REQUIRED, and the reason is the same argument this file already makes three
   *  times over — with one refinement worth stating, because it is what separates
   *  this prop from `launchStep` below.
   *
   *  The board's answer is `sessionStatusRollupOf(...)`, whose return type is
   *  `SessionStatus | null`. `null` is a real production value and it is spelled
   *  `null`, not left absent: it means "I looked, and no linked Session is waiting
   *  or working". `undefined` is therefore NOT a value a correct board produces — it
   *  is only ever a caller that forgot the prop. And what a forgotten one of those
   *  paints here is the worst version of this repo's silent-green shape: a card
   *  whose Session is blocked on a permission for the last forty minutes, rendered
   *  exactly like a card whose Session finished an hour ago. The one fact on this
   *  card that changes while nobody is looking is the one fact a caller must not be
   *  allowed to omit.
   *
   *  It is NOT read off `task`, and NOT derived here. `TaskRow` has no such field
   *  (ADR 0100), the inputs (`inTurn`, `prompts`, `requests`, `subagents.entries`)
   *  live in four stores the BOARD already subscribes to, and the precedence is
   *  `lib/sessionStatusRollup`'s — shared with the tab strip so a `?` cannot mean
   *  one thing on a tab and another on a card two hundred pixels below it. The card
   *  takes the value and paints the glyph. That is the whole contract, and
   *  `TaskCard.test.tsx` pins the file against importing a store. */
  sessionStatus: SessionStatus | null;
  /** This card's Session has **marked itself ready** — a linked Session's todo
   *  board carries a `completed` item whose content is `ready`.
   *
   *  REQUIRED, on this file's standing argument, with a sharper edge than the rest:
   *  `TasksBoard` computes this for every card from the interactive store's `ready` map, and the
   *  value it produces is a `boolean` — never `undefined`. A caller that omitted the
   *  prop would paint a card the model has finished working on exactly like a card
   *  nobody has touched, and nothing would fail. `undefined` is not a state the
   *  board produces; it is only ever a caller that forgot.
   *
   *  It stays a SEPARATE prop from `sessionStatus`, and the two feed ONE glyph.
   *  They are separate inputs because they are different KINDS of fact:
   *  `SessionStatus` answers what a Session is DOING RIGHT NOW, derived by
   *  `sessionStatusOf` from four stores, while `ready` answers "the model says the
   *  work is finished" and is AUTHORED by the model as a todo item. Collapsing them
   *  into one prop would mean adding a fifth value to `SessionStatus` — dragging in
   *  `sessionStatusOf`, `useSessionStatus`, `SpaceTabs`, `TaskDetailDialog`, the
   *  rollup's precedence and `TasksBoard.test.tsx`'s dot census — for no gain.
   *
   *  THIS PROP USED TO DOCUMENT THE OPPOSITE DESIGN, and that comment was wrong. It
   *  argued the mark was "ADDITIVE and takes no precedence slot" because "both are
   *  true and the pair is more actionable than either half". The pair was built, and
   *  the owner looked at a real board: a green check beside an amber `?` reads
   *  "finished, but blocked", and the two marks disagreed about whether anyone was
   *  needed. The fact a card reports is single — what it needs from the person
   *  looking — so `cardMarkOf` now resolves the two inputs to ONE mark and the
   *  contradictory state is UNREPRESENTABLE rather than discouraged. `SessionStatus`
   *  and `sessionStatusRollupOf` are still untouched; the wider precedence lives
   *  beside them, not inside them.
   *
   *  The card does NOT derive it, does not read a store for it, and does not know
   *  what a todo item is. The mark is `TaskCardView.ready`, fed into
   *  `store/interactive.ts`'s slot by the board read (see `applyReadyMarks`); this
   *  component paints a boolean.
   */
  ready: boolean;
  /** This card's `useDragCard` spread (`dragProps(task.id)`), or nothing when the
   *  board cannot drag (no board loaded yet). Absent means NO gesture at all —
   *  `draggable` is not spelled without the handlers that would answer it. */
  drag?: DragCardHandlers;
  /** This card is the one under drag. */
  active?: boolean;
  /** The card's PRIMARY NEXT STEP (issue #179 §7.1) — the one launch affordance a
   *  card carries, derived by the BOARD and not here.
   *
   *  OPTIONAL, and unlike every other prop on this component that is a decision
   *  rather than an oversight. `sessions` / `costUsd` / the two callbacks are REQUIRED
   *  because an omitted one of those paints a control wired to nothing — this repo's
   *  silent-green shape. A card with no next step is not that: a LAST Stage has no
   *  outgoing edge, and `next_slugs: []` is "configured, leads nowhere". `undefined`
   *  is a value a correct production board produces for a real column, and the pill is
   *  then simply not painted (pinned by two cases in this file's own test).
   *
   *  The card stays PRESENTATIONAL with this prop: it reads three fields off a
   *  destination it was handed and calls a callback it was handed. The derivation
   *  (`next_slugs`, else the Stage at `sortOrder + 1`), the catalog read, and the
   *  route through `store/taskLaunch` all belong to `TasksBoard`, for the same reason
   *  the sessions chip's callback does — a card that read a store would be a second
   *  owner of "which board is showing". */
  launchStep?: {
    destination: TaskLaunchDestination;
    /** The destination's Skill is in the Space's catalog. `true` for a destination
     *  with NO Skill, which is never gated and so never waits. The board computes
     *  this; the card cannot, because it holds no catalog. */
    launchReady: boolean;
    /** Opens a Session on this card via
     *  `launchTaskSession(spacePath, task, destination.slug, catalogs)`. */
    onLaunch: (destination: TaskLaunchDestination) => void;
  };
}

export default function TaskCard({
  task,
  sessions,
  costUsd,
  artifactKeys,
  sessionStatus,
  ready,
  onOpenSession,
  onOpenTask,
  drag,
  active,
  launchStep,
}: TaskCardProps) {
  // The chip's money, resolved through the ONE rule (ADR 0082). `null` is
  // "never reported" and prints NOTHING; `0` is "a real zero" and prints
  // `$0.00`. Gating on this value rather than on `costUsd` is the whole
  // difference: `costUsd && …` is false for `0` and would hide a reported zero,
  // and coalescing `null` to `0` before formatting invents a figure for a cost
  // nobody ever measured — which is why `moneyOf` is imported and the arithmetic
  // is never spelled at this site.
  const money = moneyOf(costUsd);
  // THE MARK, resolved by the ONE precedence rather than spelled here. Imported
  // for the identical reason `moneyOf` is: a card that re-derived the rule would be
  // a second owner of "which of these three facts wins", and the board already
  // folds the same inputs for the tab strip through `sessionStatusRollup`. The card
  // stays presentational — it reads two props it was handed and calls a pure
  // function; `TaskCard.test.tsx` pins the file against importing a store.
  //
  // Both props stay REQUIRED and separate (rather than one pre-resolved prop) so a
  // caller cannot silently drop one half, and so the precedence lives in ONE
  // pure place that its own suite pins. The card receives facts; `cardMarkOf`
  // decides.
  const mark = cardMarkOf({ sessionStatus, ready });
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
  const newest =
    sessions.length > 0 ? sessions[sessions.length - 1] : undefined;
  // One combined, ordered label list for the chip row: the artifact KEYS first, then
  // `spec` appended only when the card has a real spec pointer (non-null AND
  // non-empty — `""` is a cleared field, not a pointer) and a real artifact named
  // `spec` has not already put that word in the list (no duplicate chip).
  const labels = [...artifactKeys];
  if (
    task.specPath !== null &&
    task.specPath !== "" &&
    !artifactKeys.includes("spec")
  ) {
    labels.push("spec");
  }
  // How many names the `+N` chip stands for. Clamped so it can never go negative;
  // it is only RENDERED inside the `labels.length > MAX_VISIBLE_CHIPS` guard below.
  const hiddenLabels = Math.max(0, labels.length - MAX_VISIBLE_CHIPS);
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
      {/* FOUR ROWS: header / title / artifact chips (optional) / footer (optional).
          No body preview on a board card — the detail modal is where the body is read. */}
      <div className="flex items-center justify-between gap-2">
        {/* The number and the LIVE MARK, grouped so `justify-between` keeps the
            timestamp right-aligned with TWO facts on the left instead of spreading
            three children across the row. The group is a wrapper and not a sibling
            because `T{n}` and the mark are one sentence — "T3, and it is blocked on
            you" — and the pill stays its OWN text node either way (both board test
            files resolve a card through `getByText("T3")`, which reads text content
            and not a parent). */}
        <div className="flex min-w-0 items-center gap-1.5">
          {/* The number is a PILL now, and its fill is the PAGE step: it has to
              differ from BOTH surfaces it can land on — the column's `bg-panel` and
              this card's `bg-card` — in EVERY palette. `bg-chat` looked fine in
              Dracula (1.22 / 1.21) and is EXACTLY the card in default-dark: its
              `color-mix` base is `--color-background-win-alt` `#2b2b2b`, which IS
              `--color-card` there, so 0.6·base + 0.4·card = the card. 1.00. Measured
              per palette in `slabFloatSeparation.test.ts`; `bg-background` is
              1.10/1.34 Dracula, 1.11/1.28 default-dark, 1.06/1.06 default-light. It stays its
              OWN text node — `T3` is the label a person says out loud and both board
              test files resolve a card through `getByText("T3")`. */}
          <span className="shrink-0 rounded-full bg-background px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            T{task.number}
          </span>
          {/* THE MARK — the card's one non-static fact, ONE glyph, and a GLYPH.

              WHY ONE MARK AND NOT TWO. This card used to wear a session mark AND a
              `ready` mark at once, and the pair read wrong in a way no test could
              see: a green check beside an amber `?` says "finished, but blocked",
              and the two marks disagreed about whether anyone was needed. The
              underlying fact is single — "the model declared the work done, or it is
              stuck on you" — so the card now paints ONE glyph and the contradictory
              state is UNREPRESENTABLE rather than merely discouraged. The precedence
              is `cardMarkOf`'s (waiting > ready > running), imported rather than
              spelled here exactly as `moneyOf` is: the card does not own the rule,
              and one surface cannot drift from the other.

              WHY `ready` IS AMBER AND NOT GREEN. It was a check inside a circle in
              `text-success`, and that was a mistake this repo should have caught:
              `SubagentStatusIcon`'s `completed` case draws `CheckCircle2` in
              `text-success` and `ChecklistPanel`'s done indicator is a check circle
              in `text-success` too, so the app spends real ink teaching that
              green-tick means DONE. `ready` means the OPPOSITE — a person is needed
              NOW, to review. It belongs to the attention family, which is
              `text-warning`, the ink this very row already uses for the `?` and
              `SubagentStatusIcon` already uses for running. So colour now says
              "you are needed" and SHAPE says why: a bell for a hand-off, a question
              mark for a blockage. Since only one mark ever renders, sharing the hue
              across the family is coherent rather than ambiguous — and it is the
              same argument `SessionStatusMark` makes for its own `?`, that amber on
              an OUTLINE is the app's attention signal.

              WHY A BELL. It has to be unmistakably not a tick, and it has to read as
              "this is waiting for you" rather than "this is running" (a spinner owns
              that) or "this is blocked on a question" (the `?` owns that). `BellRing`
              is the app's only unused attention glyph — `grep` finds no other
              consumer — so it is not borrowing meaning from anywhere else.

              WHY A GLYPH AND NOT A WORD. `WorkflowNodes.tsx` records `text-warning`
              as 12px TEXT as a live defect — 2.12 Everforest light, 2.16 Rosé Pine
              light, 2.31 Catppuccin light — and a faint WORD is worse:
              `text-foreground-subtlest` on `bg-card` is 2.36 default-light / 2.18
              default-dark and NO palette gate can see it. The rule is hue on
              border/fill and readable ink on WORDS; this is a mark, and at 14px
              stroked it is WCAG non-text UI (the 3:1 class
              `fileIconContrast.test.ts` grades), not 12px text (the 4.5 class).
              `text-warning` measures 3.00 on a `bg-card` white card.

              WHY THE GUARD NAMES THREE VALUES (`null`, `live`, `stored`) when the
              rollup can only answer `waiting` / `running` / `null`: the surface owns
              its own rule. "A card never wears a ring" is a claim about THIS
              component, and `TaskCard.test.tsx` passes `live` and `stored` on purpose
              — a narrower prop type would make that uncompilable and therefore
              untestable. `cardMarkOf` refuses them too and is pinned at its own home;
              both guards are deliberate.

              DECORATION, not a name: `aria-hidden` + `role="presentation"`. The card
              is a `RowButton` and a `div[role="button"]`'s accessible name is
              computed RECURSIVELY from its subtree, so an announced mark would rename
              the card between two frames ("Ship the board" -> "Ship the board Ready").
              A board holds N marks at once, which is a further argument for restraint.
              The detail dialog is where a state is READ; the card is where it is
              glanced at. And it is NOT a control, so zero `[role="button"]` matches —
              the rule the `spec` and artifact chips follow, and the reason
              `SpacesList.test.tsx` can resolve rows through `.closest('[role="button"]')`
              at eight sites. Opening a Session already has its affordance: the chip. */}
          {mark === "ready" ? (
            <BellRingIcon
              data-testid="task-card-ready"
              aria-hidden
              role="presentation"
              // The stroke compensation `SessionStatusMark` documents for its own
              // `?`: lucide draws on a 24-unit viewBox at `stroke-width: 2`, so a
              // 14px box renders ~1.17px and the mark goes hairline exactly where
              // there is no text beside it to fall back on. Same arithmetic, same
              // constant, so both marks this row can wear carry one weight.
              strokeWidth={READY_GLYPH_STROKE_WIDTH}
              style={{ width: READY_GLYPH_SIZE_PX, height: READY_GLYPH_SIZE_PX }}
              className="shrink-0 text-warning"
            />
          ) : mark !== null ? (
            <SessionStatusMark
              status={mark}
              size={READY_GLYPH_SIZE_PX}
              testId="task-card-status"
              announce={false}
              className="shrink-0"
            />
          ) : null}
        </div>
        {/* The same buckets the Session list prints, from a different instant —
            `task.updatedAt` is Unix ms (`now_ms()` in `db.rs`), so it goes through
            the ONE bucket rule rather than a copy of it. Its own element, never
            concatenated into the title: a merged `textContent` would silently break
            the board's `within(column).getByText(...)` scoping.

            Rendered through `MutedCaption` rather than by spelling the quiet-caption
            pair here, because `mutedCaption.test.ts` censuses that pair to ONE file
            and a card's timestamp IS that caption. `cn()` emits exactly the classes
            the anatomy calls for (`text-ui-xs text-foreground-subtlest shrink-0`).
            The `title` is the ABSOLUTE timestamp, so hovering the relative bucket
            shows the exact instant behind it. */}
        <MutedCaption
          className="shrink-0"
          title={absoluteTimeFromInstant(task.updatedAt)}
        >
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
      {/* ROW 3 — spec / artifact chips. ONE row, only when there is a name to show.
          At most MAX_VISIBLE_CHIPS names; the rest collapse into a `+N` chip whose
          `title` lists EVERY name so hover reveals them. They are SPANS (labels, not
          controls): zero `[role="button"]` matches, and a click on one bubbles to the
          row, which opens the detail modal. The path itself never renders. */}
      {labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {labels.slice(0, MAX_VISIBLE_CHIPS).map((label) => (
            <span key={label} className={CHIP_CLASS}>
              {label}
            </span>
          ))}
          {labels.length > MAX_VISIBLE_CHIPS && (
            <span className={CHIP_CLASS} title={labels.join(", ")}>
              {`+${hiddenLabels}`}
            </span>
          )}
        </div>
      )}
      {/* ROW 4 — footer: the card's two controls, only when at least one will paint
          (no empty bordered strip). The sessions link is resolved through `newest`
          (guard-then-index above), so "is there a link" and "what does the click open"
          read ONE value. */}
      {(newest !== undefined ||
        (launchStep !== undefined && launchStep.launchReady)) && (
        <div className="flex items-center justify-between gap-2 border-t border-card-border pt-2">
          {newest !== undefined && (
            <button
              type="button"
              // STOPPED: the card is a RowButton, so an unstopped click would also
              // open the detail modal on top of the Session just asked for. No `role`
              // — a `<button>` needs none, and a second `[role="button"]` would break
              // RowButton's one-per-row rule.
              onClick={(e) => {
                e.stopPropagation();
                onOpenSession(newest.sessionId);
              }}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 -ml-1.5 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <MessageSquareIcon aria-hidden size={12} className="shrink-0" />
              {/* DIRECT text nodes of the <button> (never a wrapper span): the board
                  test resolves this control with getByText + tagName === "BUTTON".
                  `money` is null for "never reported" -> segment ABSENT (ADR 0082,
                  owned by `moneyOf`). */}
              {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
              {money !== null && ` · ${money}`}
            </button>
          )}
          {launchStep !== undefined && launchStep.launchReady && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                launchStep.onLaunch(launchStep.destination);
              }}
              className={cn(
                // `ml-auto`: with `justify-between` a LONE footer child would sit at
                // the start; the next step must stay right-aligned when the card
                // has no sessions (the common case on a fresh board).
                "ml-auto cursor-pointer rounded-md border border-border bg-surface px-2 py-0.5 text-ui-xs font-medium text-foreground hover:bg-surface-hover",
              )}
            >
              {launchStep.destination.label} →
            </button>
          )}
        </div>
      )}
    </RowButton>
  );
}
