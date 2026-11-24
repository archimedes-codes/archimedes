import { useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";
import { ChevronDownIcon, ChevronUpIcon, Trash2Icon } from "lucide-react";
import { MutedCaption } from "../MutedCaption";
import { RowButton } from "../RowButton";
import { StageDestinations } from "./StageDestinations";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { useTasks } from "../../store/tasks";
import type { SkillInfo, StageDto } from "../../lib/tauri";
import { CONTROL_ROW, ROW_BUTTON, ROW_SELECT } from "./stageStyles";

/**
 * One **Stage row** — the whole editing form for one column of the board: its
 * label, its card count, its slug caption, the Skill a Session started from it
 * loads (ADR 0098), the extra prompt that goes before that Skill, whether a card
 * launched here advances itself when its Session settles, its destinations
 * (`StageDestinations`), its place in the order, and its deletion.
 *
 * ---------------------------------------------------------------------------
 * IT READS THE STORE DIRECTLY — BUT THE `SessionRow` CITATION IS SPLIT,
 * BECAUSE THE ROW BREAKS IT IN ONE PLACE
 * ---------------------------------------------------------------------------
 *
 * The seven verbs its own controls call — `renameStage`, `setStageSkill`,
 * `setStageNext`, `setStageAuto`, `setStagePromptPrefix`, `reorderStages`,
 * `deleteStage` — come off `useTasks` here rather
 * than through props, exactly as `spaces/SessionRow.tsx` reads `useSessions` for
 * its own Stop / Archive. A prop per verb would be seven more props for seven calls
 * whose trigger is in this file, and the parent holds none of the state they touch:
 * `store/tasks` owns the optimistic paint, the whole-slice re-derivation and the
 * revert into `error` (spec §8.1), which the dialog renders.
 *
 * THE WHOLE-SLICE READ IS THE ONE THING `SessionRow` WOULD NOT DO, and this file
 * should not cite it for that. `useTasks((s) => s.boardsBySpace[spacePath])`
 * subscribes the ROW to a store slice, and `SessionRow` deliberately refuses that
 * shape: it takes `recencyMap` and `badgeMap` as props, and its own prop docs say
 * so in those words — the pane holds the ONE subscription "so this row adds NO
 * subscription of its own". This row adds one.
 *
 * It does so for ONE thing `derived` deliberately does not carry: the LABELS of the
 * other columns. `derived` is `{ cardCount, slugs }` — the count the row prints and
 * the whole ordered slug list the reorder needs — and neither can answer "what is
 * `doing` called", which the destination chips, the add-`Select`'s items and the
 * delete picker all print. The only alternative was ANOTHER prop carrying the other
 * columns' labels up from the shell — an EIGHTH prop, where this row takes seven
 * today — and it would be a row→parent→row round trip for data the parent already
 * holds, computed per row for a question only this row's chips ask.
 *
 * THE COST, measured rather than assumed (the way `stageStyles.ts` states its own
 * exception). `main`'s one-file shell held 10 `useTasks(` CALLS for the whole
 * dialog, whatever the row count. At HEAD the same surface splits them: 2 in
 * `StageEditor.tsx`, 1 in `stages/AddStageField.tsx`, 2 in
 * `stages/StrictWorkflowToggle.tsx` — 5, fixed — plus the 8 CALLS in this file, one
 * set per RENDERED row. So the whole surface costs 8N + 5, and the N worth quoting
 * is the PRODUCT's seed board: `DEFAULT_STAGES` in `src-tauri/src/storage/db.rs` is
 * `[(&str, &str, Option<&str>); 5]` — backlog, research, approved, doing, done —
 * and `store/tasks.ts` describes itself as "seeding the five default stages". Five
 * columns take the surface from 10 subscriptions to 8(5) + 5 = **45**, and a
 * 10-column board to 85. That is +35 selector INVOCATIONS per store write on the
 * seed board, and it is worth being exact about what that does and does not buy:
 *  - ZERO extra renders — but NOT because the store holds the reference still. It
 *    does not: `load`, `moveTask`, `createTask` and `reorderWithinStage` in
 *    `store/tasks.ts` each publish a FRESH `boardsBySpace[spacePath]` array, and so
 *    does every other write, through `paint()` — the spread
 *    `boardsBySpace: { ...state.boardsBySpace, [spacePath]: … }` appears 7 times in
 *    that file, six inside those four actions (`moveTask` and `reorderWithinStage`
 *    twice each, optimistic paint and revert; `load` and `createTask` once each) and
 *    the seventh being `paint()` itself. The reason the row still costs no
 *    render is one level up: the parent `StageEditor` subscribes to the SAME slice
 *    (its own `columns` selector, the first line of its body), so any republish
 *    re-renders the parent and re-renders every row with it — the row's own
 *    subscription can therefore never be the thing that causes a render. The seven
 *    action selectors return refs the store builds once in `create` and never `set`s
 *    again (no `set` in that file names an action), so they add no render either; and
 *    this row is not `memo`-ised, so nothing about it could skip the parent's
 *    re-render even if the reference were held.
 *  - +35 selector CALLS per store write on the seed board, which is one function
 *    call per subscription per write and nothing else. On a dialog this size that is
 *    the cheaper side of the trade; a row that rendered a list of thousands would not
 *    get to say so.
 *
 * (The counts above are CALL SITES, and the bare token is not how to count them —
 * this header names it in prose elsewhere too. The eight are, in order, the seven
 * action selectors (`renameStage`, `setStageSkill`, `setStageNext`, `setStageAuto`,
 * `setStagePromptPrefix`, `reorderStages`, `deleteStage`) back to back at the top of
 * the component body, then the column slice two lines below them. The workflow-graph
 * work added the two middle ones and therefore moved every figure in this section:
 * the per-row count 6 → 8, the seed-board total 35 → 45, the per-write delta +25 →
 * +35. All three re-measured against the tree, none inherited.)
 *
 * ---------------------------------------------------------------------------
 * ONE `role="button"`, AND WHO GETS THE CLICK
 * ---------------------------------------------------------------------------
 *
 * A row is ONE `RowButton` — the app's only hand-rolled `role="button"` row — and
 * every control nested in it is a native `<button>` or `<input>` with NO `role`
 * attribute spelled (a `<button>` needs none, and spelling one would give every row
 * a second `[role="button"]` node, which is what breaks the eight
 * `.closest('[role="button"]')` reads in `SpacesList.test.tsx`).
 *
 * Interaction routing, in one sentence and pinned by the two cases named
 * `one role per row, and who gets the click` in `StageEditor.test.tsx`: **the row's
 * single affordance is "focus this Stage's label field", so every nested control
 * calls `stopPropagation()` on its `onClick` (otherwise the click bubbles into the
 * row and steals focus out of the control the user just used), and the row's own
 * `onKeyDown` acts only when `event.target === event.currentTarget` (otherwise an
 * Enter pressed inside the label `Input` or a nested button bubbles into the row's
 * Enter handler and moves focus on top of the action that key just performed).** The
 * sessions-chip precedent in `TaskCard.tsx` established the click half; the keydown
 * half is new here because this row nests a full form, which no chip-row in the app
 * does.
 *
 * ---------------------------------------------------------------------------
 * THE SLUG IS A CAPTION, NOT A FIELD
 * ---------------------------------------------------------------------------
 *
 * `createStage` derives the slug from the label in Rust and `renameStage` writes the
 * label ONLY, because `tasks.stage_slug` points at the slug by string with no
 * foreign key (spec §5). So the slug is shown quiet and read-only: the mismatch
 * between "In flight" and `doing` is information the user needs and a rename field
 * would hide.
 *
 * ---------------------------------------------------------------------------
 * THE LABEL DRAFT IS ROW-LOCAL, AND THAT IS A DECISION WITH A COST
 * ---------------------------------------------------------------------------
 *
 * `draft` is a `useState` on the row, where the field that edits it is. The dialog
 * used to hold one `Record<string, string>` for all rows, keyed by slug — and that
 * Record outlived a filtered-out row, so a half-typed label survived filtering the
 * row away and back. It does not survive now: unmount discards it and the field
 * re-shows the stored label. `StageEditor.test.tsx`'s
 * `filtering a row away discards its uncommitted draft` pins the new behaviour,
 * because the alternative was threading the parent's Record down as a prop and an
 * `onChange` to match — two more props and the split placement this extraction
 * exists to remove. The rule it now shares with a REFUSED rename is the one the
 * field already followed there: what is on screen is what the database holds.
 */
export function StageRow({
  stage,
  spacePath,
  derived,
  skills,
  pendingDelete,
  onAskDelete,
  onDismissDelete,
}: {
  stage: StageDto;
  /** The Space the five verbs this row calls address. `string`, not `string | null`
   *  — `StageEditor`'s early return makes a Spaceless mount unreachable, so the
   *  guards these callbacks each carried are now the type's job. */
  spacePath: string;
  /** What the parent already computed from the WHOLE column set, so this row does no
   *  per-row scan for it. See the header for what is deliberately NOT in here. */
  derived: {
    /** How many cards this column holds — the number the row PRINTS. Print-only:
     *  the delete decision reads the slice at click time instead, because a column
     *  absent from the slice must not read as an empty one. See `requestDelete`. */
    cardCount: number;
    /** EVERY column's slug, in board order: ONE array PER RENDER, shared by every
     *  row. Load-bearing — see `moveStage`. */
    slugs: string[];
  };
  /** The Space's Skill catalog, from the dialog's ONE `useMentionCatalogs` mount. */
  skills: SkillInfo[];
  /** Is THIS row the one waiting on a delete destination? A boolean and not a slug
   *  because the parent holds the single-pending-row invariant — one dialog, one
   *  open question at a time — and this row only ever needs to know whether the
   *  question is its own. */
  pendingDelete: boolean;
  /** Ask the parent to make this row the pending one. */
  onAskDelete: () => void;
  /** Tell the parent no row is pending any more. */
  onDismissDelete: () => void;
}): ReactElement {
  const renameStage = useTasks((s) => s.renameStage);
  const setStageSkill = useTasks((s) => s.setStageSkill);
  const setStageNext = useTasks((s) => s.setStageNext);
  const setStageAuto = useTasks((s) => s.setStageAuto);
  const setStagePromptPrefix = useTasks((s) => s.setStagePromptPrefix);
  const reorderStages = useTasks((s) => s.reorderStages);
  const deleteStage = useTasks((s) => s.deleteStage);
  // The column set, for the OTHER columns' labels — see the header. The same
  // reference the parent renders from, so the two cannot disagree about a name.
  const columns = useTasks((s) => s.boardsBySpace[spacePath]);

  const { cardCount, slugs } = derived;
  // `position` and `total` are derived HERE rather than passed in: the row holds the
  // ordered slug list already, and both are one read off it.
  const position = slugs.indexOf(stage.slug);
  const total = slugs.length;

  /** The label being typed, or `null` when the field shows the STORED label. Local
   *  on purpose: the store holds the STORED label (what the board paints) and this
   *  holds what is being typed, so the column header never flickers with half-typed
   *  text. Cleared after a commit — success or refusal — so the field falls back to
   *  what the store actually has. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The extra prompt being typed, or `null` when the field shows the STORED prefix.
   *  A SECOND `useState` beside `draft` rather than one Record, on the same argument
   *  `draft`'s note makes: unmount discards it, so a half-typed prefix cannot survive
   *  filtering the row away and back. */
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  /** The row's own focus route. It was a `Map<string, HTMLInputElement>` in the
   *  parent, existing ONLY so the parent could focus an `Input` a row renders; the
   *  row's `onClick` is right here, so one local ref replaces the map, its setter
   *  callback and its unmount cleanup. */
  const labelRef = useRef<HTMLInputElement>(null);

  const commitLabel = async (): Promise<void> => {
    const committed = draft;
    setDraft(null);
    // NO draft, or a draft identical to the stored label → nothing to write. The
    // commit fires on every blur, and a blur happens on every click elsewhere in
    // the dialog, so an ungated commit would rewrite the whole board's labels as the
    // user worked.
    if (committed === null || committed === stage.label) return;
    try {
      await renameStage(spacePath, stage.slug, committed);
    } catch {
      // The store reverted the slice and wrote the sentence into `error`, which this
      // dialog renders; the draft is already cleared, so the field falls back to the
      // label the database actually holds.
    }
  };

  const commitPrefix = async (): Promise<void> => {
    const committed = prefixDraft;
    setPrefixDraft(null);
    // NO draft → nothing was touched, so nothing is written (the commit fires on
    // every blur, exactly as the label's does).
    if (committed === null) return;
    // An EMPTY field is the CLEAR, and the clear sends `null` — the only spelling of
    // "no extra prompt" the database holds, and the same rule `onEnterSkill`'s `none`
    // item follows, so a clear is spelled ONE way for both nullable text fields on
    // this row. `""` is NOT sent: the column stores it as a VALUE a person typed, and
    // a UI that wrote it would create a second state indistinguishable from the first
    // and un-clearable — the argument `set_stage_next` records as its known gap. The
    // one consequence is stated rather than hidden: a column whose stored prefix IS
    // `""` (reachable only from outside this dialog) reads as empty here, and
    // committing the empty field clears it to NULL — which is the launcher's own
    // answer anyway, since it prepends `""` and NULL identically.
    const next = committed === "" ? null : committed;
    if (next === stage.promptPrefix) return;
    try {
      await setStagePromptPrefix(spacePath, stage.slug, next);
    } catch {
      // The store reverted the slice and wrote the sentence into `error`, which this
      // dialog renders; the draft is already cleared, so the field falls back to the
      // prefix the database actually holds.
    }
  };

  /** Flip this column's auto-advance flag.
   *
   *  NO local state and no re-read, and that is the difference from
   *  `stages/StrictWorkflowToggle.tsx` rather than an omission of it. That component
   *  holds `strict` in a `useState` because the flag is NOT on any row the board read
   *  returns — it lives on the `spaces` row — so it must seed itself from
   *  `getBoardStrict`, and re-read after the write because `setBoardStrict` answers
   *  `void` and captures its failure into `error` without rethrowing. Its rule, "paint
   *  from the READ, never from the click", therefore means "the rendered value is
   *  never the click". The SAME rule holds here through a different OWNER: `auto`
   *  rides on the `StageDto` this row already renders, the STORE owns the optimistic
   *  paint and the revert, and the row re-renders from the slice — so what is on
   *  screen is the slice's value and never the click's, and the stored `StageDto` the
   *  command answers is merged back over it by the store. A local `useState` here would
   *  be a second owner of one fact, and it would keep showing ON after the revert. */
  const toggleAuto = async (next: boolean): Promise<void> => {
    try {
      await setStageAuto(spacePath, stage.slug, next);
    } catch {
      // Reverted; the store's line explains it. The card a person is looking at did
      // not move, because the runtime reads the STORED flag and it did not change.
    }
  };

  const addDestination = async (destination: string): Promise<void> => {
    // `null` (unconfigured) becomes the LIST the user is starting, because choosing
    // a destination IS configuring the column. The `[]` case is left alone — an
    // empty list is "configured, and nothing follows this column" (ADR 0099), which
    // appending to is exactly what the user asked for.
    const current = stage.nextSlugs ?? [];
    if (current.includes(destination)) return;
    try {
      await setStageNext(spacePath, stage.slug, [...current, destination]);
    } catch {
      // Reverted; the store's line explains it (an unknown slug or a self-loop
      // REFUSES rather than dropping the entry — spec §4).
    }
  };

  const writeDestinations = async (next: string[]): Promise<void> => {
    try {
      await setStageNext(spacePath, stage.slug, next);
    } catch {
      // Reverted; see `addDestination`.
    }
  };

  /** The whole-slice reorder (spec §4's `reorder_spaces` contract): swap the two
   *  slugs LOCALLY and hand the command EVERY column, not the pair that moved.
   *
   *  This is why `slugs` is a prop and `position` is not: the row cannot build the
   *  array from its own position and a count, and a two-slug patch would leave the
   *  untouched columns holding a stale `sort_order` that can collide with the
   *  renumbered ones. */
  const moveStage = async (delta: -1 | 1): Promise<void> => {
    const at = position;
    const to = at + delta;
    if (at === -1 || to < 0 || to >= total) return;
    const next = [...slugs];
    [next[at], next[to]] = [next[to]!, next[at]!];
    await reorderStages(spacePath, next);
  };

  const requestDelete = (): void => {
    // An EMPTY column needs no destination and no question — there is nothing to
    // relocate. A column WITH cards can only be deleted through a destination: a
    // card whose `stage_slug` names no row is invisible to `get_board`, keeps
    // costing money through its Session, and can never be clicked again (spec §4.1),
    // so there is no "delete anyway" escape to offer.
    //
    // THE DISCRIMINATOR, at click time and from the slice: a column ABSENT from the
    // slice is not a column with NO CARDS. "I know nothing about this column" and
    // "this column holds nothing" are different facts, and they must not share an
    // arm — the first is inert on `main` and the second deletes. So the count that
    // decides is read here, and `derived.cardCount` stays what it always was: the
    // number printed two lines above. This `find` costs nothing per render — it runs
    // on a click, and the slice it reads is the subscription this row already holds.
    const column = columns?.find((c) => c.stage.slug === stage.slug);
    if (column === undefined) return;
    if (column.tasks.length === 0) {
      void deleteStage(spacePath, stage.slug);
      return;
    }
    onAskDelete();
  };

  const confirmDelete = async (relocateTo: string): Promise<void> => {
    onDismissDelete();
    // ONE call. The relocation is a bulk UPDATE inside `delete_stage`'s own
    // transaction; `moveTask` per card would run the destination's `on_enter` once
    // per card — five cards, five compactions, all as a side effect of deleting a
    // column (spec §4.1).
    await deleteStage(spacePath, stage.slug, relocateTo);
  };

  const destinations = stage.nextSlugs;
  // The columns this Stage could point at: everything EXCEPT itself. A self-loop is
  // refused by `set_stage_next` (spec §4 — it would be a button that moves a card to
  // the column it is already in), so offering it would be a control that can fail.
  const candidates = (columns ?? [])
    .filter((c) => c.stage.slug !== stage.slug)
    .map((c) => ({ slug: c.stage.slug, label: c.stage.label }));
  const labelOf = (slug: string): string =>
    columns?.find((c) => c.stage.slug === slug)?.stage.label ??
    // An edge the slice cannot resolve still gets its slug: dropping it here would
    // shrink the workflow on screen, which is the failure `set_stage_next` refuses to
    // write in the first place.
    slug;
  const focusLabel = (): void => labelRef.current?.focus();
  const stop = (event: MouseEvent | KeyboardEvent): void => event.stopPropagation();

  return (
    <RowButton
      data-testid={`stage-row-${stage.slug}`}
      className={cn(STAGE_ROW, "cursor-pointer hover:bg-surface-hover")}
      onClick={() => focusLabel()}
      // NO `onKeyDown` here, and that is a type fact before a design one:
      // `RowButtonProps` OMITS `onKeyDown`, because the row's Enter activation
      // is `RowButton`'s own and it calls the SAME `onClick` this line sets.
      // So the Enter route to this affordance comes free, and the leak an Enter
      // pressed inside a nested control would cause is closed at the CHILD end
      // — every nested control below stops its own `onKeyDown` (`stop`), which
      // keeps the row's Enter handler from firing on a keypress that belongs to
      // the control. `preventDefault` is not used anywhere in this row, so
      // stopping propagation cannot cost a control its own activation.
    >
      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={labelRef}
          aria-label={`Label for ${stage.slug}`}
          className="min-w-0 flex-1"
          value={draft ?? stage.label}
          onChange={(event) => setDraft(event.target.value)}
          onClick={stop}
          // Enter commits the rename (a field you have to LEAVE to apply is a
          // field that lies about what is saved), and the event stops here so
          // the row's Enter handler stays out of it.
          onKeyDown={(event) => {
            stop(event);
            if (event.key === "Enter") void commitLabel();
          }}
          onBlur={() => void commitLabel()}
        />
        {/* The count, so a rename is not the only thing a row can tell you: how many
            cards this column holds is what tells you whether deleting it will ask a
            question. Printed here; the delete arm reads the slice itself. */}
        <span className="shrink-0 rounded-md bg-panel px-2 py-0.5 font-mono text-ui-sm text-foreground-subtlest">
          {cardCount}
        </span>
      </div>

      {/* The slug, read-only. Frozen after `createStage` derives it, so the
          caption exists to make the label↔slug mismatch VISIBLE rather than
          to be edited away (spec §5). */}
      <MutedCaption data-testid={`stage-slug-${stage.slug}`}>
        {stage.slug}
      </MutedCaption>

      <div className={CONTROL_ROW}>
        <Select
          value={stage.onEnterSkill ?? NO_SKILL}
          onValueChange={(next) => {
            void setStageSkill(
              spacePath,
              stage.slug,
              next === NO_SKILL ? null : next,
            ).catch(() => {
              // Reverted; the store's line says which Skill was refused.
            });
          }}
        >
          <SelectTrigger
            aria-label={`Skill for ${stage.slug}`}
            className={ROW_SELECT}
            onClick={stop}
            // Radix opens on keydown as well as click, so both stop here:
            // otherwise choosing a Skill with the keyboard also runs the row.
            onKeyDown={stop}
          >
            <SelectValue>
              {/* A stored Skill the catalog no longer holds (a renamed
                  directory) would render an EMPTY trigger, which reads as
                  "nothing configured". Name what is saved instead — the
                  `PermissionsSection` precedent for the same trap. */}
              {stage.onEnterSkill ?? "none"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SKILL}>none</SelectItem>
            {skills.map((s) => (
              <SelectItem key={s.path} value={s.name}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <StageDestinations
          stageSlug={stage.slug}
          destinations={destinations}
          candidates={candidates}
          labelOf={labelOf}
          onWrite={(next) => void writeDestinations(next)}
          onAdd={(slug) => void addDestination(slug)}
        />
      </div>

      {/* The two halves of "what this column says and does when it starts a Session",
          on their own line because neither is a choice the Skill `Select` above
          constrains: which Skill it loads, what text goes BEFORE that Skill, and
          whether the card then advances itself. All three are per-column DATA on the
          same row (ADR 0098 rules the first, the workflow-graph work the other two),
          and the line they sit on is OUTSIDE the drag surface's label field — see the
          `draggable` note below, which is what the two `stop` handlers on the `Input`
          are guarding. */}
      <div className={CONTROL_ROW}>
        <Switch
          checked={stage.auto}
          // NOT `disabled={… === null}`: `StrictWorkflowToggle` needs that arm
          // because its flag has an unread state, and `auto` has none — the column is
          // `NOT NULL DEFAULT 0`, so `stage.auto` IS the seeded value and is never
          // unknown. A `disabled` here would be a control that is inert for a reason
          // that does not exist.
          aria-label={`Auto-advance cards launched in ${stage.slug}`}
          title={`Auto-advance cards launched in ${stage.slug}`}
          className="shrink-0"
          // Both handlers, like every nested control in this row: the click must not
          // bubble into the row's own "focus the label" affordance, and a
          // keyboard-activated Switch must not run the row's Enter handler on top of
          // its own activation.
          onClick={stop}
          onKeyDown={stop}
          onCheckedChange={(checked) => void toggleAuto(checked)}
        />
        <Input
          aria-label={`Extra prompt for ${stage.slug}`}
          className="h-6 min-w-0 flex-1 text-ui-sm"
          placeholder="Extra prompt before the Skill launch"
          // The stored prefix when no draft is being typed — the same
          // `draft ?? stored` shape the label field uses, so the column and this
          // field can never disagree about what is saved.
          value={prefixDraft ?? stage.promptPrefix ?? ""}
          onChange={(event) => setPrefixDraft(event.target.value)}
          // THREE props copied from the label `Input` verbatim, and the middle one is
          // load-bearing in a way that is easy to "simplify" away: `draggable`
          // INHERITS to children, so a `<input>` inside this row is inside a drag
          // surface — the exact defect `StageEditor`'s header cites as the reason
          // Stage editing is a modal at all, and the reason a field on the column
          // header would start a drag on the first click. `onClick={stop}` keeps the
          // click in the field, `stop(e)` keeps an Enter from reaching the row, and
          // `onBlur` is what commits the text a person left without pressing Enter.
          onClick={stop}
          onKeyDown={(event) => {
            stop(event);
            if (event.key === "Enter") void commitPrefix();
          }}
          onBlur={() => void commitPrefix()}
        />
      </div>

      <div className={CONTROL_ROW}>
        {/* The column's place in the order — a SEPARATE question from the
            destinations above (ADR 0099 splits "where does this render" from
            "what may a Task go to next"), so it is a separate control. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${stage.slug} up`}
          title={`Move ${stage.slug} up`}
          className={ROW_BUTTON}
          // `aria-disabled` and not `disabled`: the row is what the pointer
          // lands on, and an inert arrow that still occupies its slot beats one
          // that appears and disappears as the list moves.
          aria-disabled={position <= 0 || undefined}
          onKeyDown={stop}
          onClick={(event) => {
            stop(event);
            if (position <= 0) return;
            void moveStage(-1);
          }}
        >
          <ChevronUpIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${stage.slug} down`}
          title={`Move ${stage.slug} down`}
          className={ROW_BUTTON}
          aria-disabled={position >= total - 1 || undefined}
          onKeyDown={stop}
          onClick={(event) => {
            stop(event);
            if (position >= total - 1) return;
            void moveStage(1);
          }}
        >
          <ChevronDownIcon className="size-4" />
        </Button>

        {pendingDelete ? (
          // THE DESTINATION PICKER. It replaces the row's own delete control,
          // so the only way to proceed is to name a destination — there is no
          // "delete anyway" control anywhere in this branch (spec §8).
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
              {cardCount} {cardCount === 1 ? "card" : "cards"} here — move them
              to
            </span>
            <Select onValueChange={(next) => void confirmDelete(next)}>
              <SelectTrigger
                aria-label={`Move the cards in ${stage.slug} to`}
                className={ROW_SELECT}
                onClick={stop}
                onKeyDown={stop}
              >
                <SelectValue placeholder="Choose a column" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Cancel deleting ${stage.slug}`}
              className={ROW_BUTTON}
              onKeyDown={stop}
              onClick={(event) => {
                stop(event);
                onDismissDelete();
              }}
            >
              <span>Cancel</span>
            </Button>
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${stage.slug}`}
            title={`Delete ${stage.slug}`}
            className={ROW_BUTTON}
            onKeyDown={stop}
            onClick={(event) => {
              stop(event);
              requestDelete();
            }}
          >
            <Trash2Icon className="size-4" />
          </Button>
        )}
      </div>
    </RowButton>
  );
}

/** The row shell: Skills' geometry, once. `flex-col` because a Stage row is a
 *  stack of fields, not a name-and-caption line. ONE consumer — this file — so it
 *  lives here and not in `stageStyles.ts`. */
const STAGE_ROW = "group flex min-w-0 flex-col gap-1 rounded-lg px-2.5 py-1.5";

/** The `Select` sentinel for "no Skill". NOT the empty string: Radix refuses an
 *  `SelectItem` with `value=""`, and `"none"` cannot collide with a Skill name
 *  because a Skill's directory name is never the literal word `none`. */
const NO_SKILL = "none";
