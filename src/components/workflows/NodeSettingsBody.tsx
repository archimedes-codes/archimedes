import { useState } from "react";
import type { ReactElement } from "react";
import { ChevronDownIcon, ChevronUpIcon, Trash2Icon } from "lucide-react";

import { MutedCaption } from "../MutedCaption";
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
import {
  canConnectStages,
  edgeOutcomesOf,
  nextOutcomesAfterConnect,
  nextSlugsAfterConnect,
} from "../../lib/workflowEdgeWrite";
import { nextStepSlugs } from "../../lib/workflowGraph";
import type { SkillInfo, StageDto } from "../../lib/tauri";

import { NodeDestinations } from "./NodeDestinations";
import {
  PANEL_BUTTON,
  PANEL_ROW,
  PANEL_SECTION,
  PANEL_SELECT,
} from "./settingsStyles";

/**
 * One **node's** settings — the whole per-column form the settings panel shows when a
 * node is selected: its label, its card count, its slug caption, the Skill a Session
 * started here loads (ADR 0098), the extra prompt that goes before that Skill, whether
 * a card launched here advances itself when its Session settles, its destinations, its
 * place in the order, and its deletion.
 *
 * ---------------------------------------------------------------------------
 * IT IS `stages/StageRow.tsx` RE-HOMED, FIELD FOR FIELD
 * ---------------------------------------------------------------------------
 *
 * The row and this body answer the same eight questions of the same `StageDto`, and
 * every write is the same store action with the same arguments. What changed is the
 * SHAPE of the surface — a stack of labelled sections in a panel rather than a
 * `role="button"` row inside a dialog — and three consequences follow from that, each
 * pinned in `NodeSettingsBody.test.tsx`:
 *
 *  - **No `role="button"` and therefore no click routing to protect.** The dialog's row
 *    was the app's only hand-rolled `role="button"` row and every nested control had to
 *    `stopPropagation()` so a click on the Skill picker did not also run the row's one
 *    affordance ("focus the label field"). A panel section is a `<div>`: those five
 *    tests had no subject here, and they are genuinely obsolete rather than dropped —
 *    the row they pinned is going away with the dialog. Every `stopPropagation()` came
 *    out with it rather than staying as cargo cult — `NodeDestinations`' header carries
 *    the same removal on the destination block.
 *  - **The card count is a prop and the delete decision is not.** `cardCount` is the
 *    number the header prints, print-only. The arm that decides whether deleting needs
 *    a destination reads the SLICE at click time, because "I know nothing about this
 *    column" and "this column holds nothing" are different facts and must not share an
 *    arm — the first is inert, the second deletes. That is `StageRow`'s `requestDelete`
 *    rule carried across verbatim.
 *  - **The drafts live here and die here.** Two `useState`s, one per text field, each
 *    cleared after a commit (success, refusal or refusal-to-parse) so the field falls
 *    back to what the database holds. The shell adds a `key` on the slug, so selecting
 *    another node unmounts this body and a half-typed label cannot follow the selection
 *    to a different column.
 *
 * ---------------------------------------------------------------------------
 * THE WHOLE-SLICE READ IS DELIBERATE, AND IT IS THE ONE THING NOT COPIED ACROSS
 * ---------------------------------------------------------------------------
 *
 * `useTasks((s) => s.boardsBySpace[spacePath])` subscribes this body to a store slice.
 * `StageRow`'s header measured that trade at 8N + 5 selector calls per store write on
 * the five-column seed board and justified it for a row that could otherwise have taken
 * an eighth prop. Here the arithmetic is better and different: the SHELL already
 * subscribes to the same slice and already resolves the selected column out of it, so
 * this body adds exactly ONE more selector call, not eight, and it re-renders only when
 * the parent re-renders anyway (a republish re-renders the shell with it).
 *
 * What it buys is the one fact the shell does not pass: the LABELS of the other
 * columns, which the destination chips, the add-`Select`'s items and the delete picker
 * all print. The alternative was a `labelOf` prop threaded from the shell for a question
 * only this body's chips ask.
 *
 * ---------------------------------------------------------------------------
 * THE SLUG IS A CAPTION, NOT A FIELD
 * ---------------------------------------------------------------------------
 *
 * `createStage` derives the slug from the label in Rust and `renameStage` writes the
 * label ONLY, because `tasks.stage_slug` points at the slug by string with no foreign
 * key (spec §5). So the slug is quiet and read-only: the mismatch between "In flight"
 * and `doing` is information a person needs and a rename field would hide.
 */
export function NodeSettingsBody({
  stage,
  cardCount,
  spacePath,
  skills,
}: {
  /** The selected column, as the board slice holds it. Every field the form shows comes
   *  off this row, so the panel and the canvas beside it cannot disagree. */
  stage: StageDto;
  /** How many cards the column holds — the number the form PRINTS. Print-only: the
   *  delete decision reads the slice at click time instead. See `requestDelete`. */
  cardCount: number;
  /** The Space the seven verbs below address. `string`, not `string | null` — the
   *  shell's early return makes a Spaceless mount unreachable. */
  spacePath: string;
  /** The Space's Skill catalog, from the shell's ONE `useMentionCatalogs` mount. */
  skills: SkillInfo[];
}): ReactElement {
  const renameStage = useTasks((s) => s.renameStage);
  const setStageSkill = useTasks((s) => s.setStageSkill);
  const setStageNext = useTasks((s) => s.setStageNext);
  const setStageAuto = useTasks((s) => s.setStageAuto);
  const setStagePromptPrefix = useTasks((s) => s.setStagePromptPrefix);
  const reorderStages = useTasks((s) => s.reorderStages);
  const deleteStage = useTasks((s) => s.deleteStage);
  // The column set, for the OTHER columns' labels — see the header. The same reference
  // the shell renders from, so the two cannot disagree about a name.
  const columns = useTasks((s) => s.boardsBySpace[spacePath]);

  // The ordered slug list, for the whole-slice reorder. Built here rather than passed
  // in: this body holds the column set already and both reads are one `map` off it.
  const slugs = (columns ?? []).map((c) => c.stage.slug);
  const position = slugs.indexOf(stage.slug);
  const total = slugs.length;

  /** The label being typed, or `null` when the field shows the STORED label. Local on
   *  purpose: the store holds what the board paints and this holds what is being typed,
   *  so the canvas node never flickers with half-typed text. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The extra prompt being typed, or `null` when the field shows the STORED prefix. A
   *  SECOND `useState` rather than one Record, on the same argument `draft` makes. */
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  /** The name picked for the NEXT added edge, mirrored out of `NodeDestinations` for ONE
   *  reason: `candidates` below has to be computed WITH it. `canConnectStages` refuses an
   *  unnamed edge onto a destination the column already holds and ALLOWS a named one, so
   *  the option set is a function of the name — a panel that computed it with
   *  `outcome = null` would never offer a second edge to one destination, and D6's
   *  two-way routing would be unreachable from the one surface built to configure it.
   *
   *  A MIRROR and not an owner: `NodeDestinations` holds the draft and passes the name to
   *  `onAdd` itself, so the payload can never disagree with what its trigger shows. This
   *  is the same one-directional shape the panel's text drafts use ("the drafts live here
   *  and die here"), with the reporting added because a second file needs to see it. */
  const [pendingOutcome, setPendingOutcome] = useState<string | null>(null);
  /** Is THIS node waiting on a delete destination? The dialog held this in its parent
   *  because the invariant was dialog-wide (one open question at a time, across N
   *  rows). Here there is exactly one node on screen, so the flag has one possible
   *  owner already and a prop would be a second one. */
  const [pendingDelete, setPendingDelete] = useState(false);
  const commitLabel = async (): Promise<void> => {
    const committed = draft;
    setDraft(null);
    // NO draft, or a draft identical to the stored label → nothing to write. The commit
    // fires on EVERY blur and a blur happens on every click elsewhere in the app, so an
    // ungated commit would rewrite the board's labels as the person worked. This is the
    // gate the panel's suite pins as `one keystroke is NOT one rename_stage call
    // (a write per character is a write storm)`.
    if (committed === null || committed === stage.label) return;
    try {
      await renameStage(spacePath, stage.slug, committed);
    } catch {
      // The store reverted the slice and wrote the sentence into `error`, which the
      // shell renders; the draft is already cleared, so the field falls back to the
      // label the database actually holds.
    }
  };

  const commitPrefix = async (): Promise<void> => {
    const committed = prefixDraft;
    setPrefixDraft(null);
    // NO draft → nothing was touched, so nothing is written (the commit fires on every
    // blur, exactly as the label's does).
    if (committed === null) return;
    // An EMPTY field is the CLEAR, and the clear sends `null` — the only spelling of "no
    // extra prompt" the database holds, and the same rule the Skill `Select`'s `none`
    // item follows. `""` is NOT sent: the column stores it as a VALUE a person typed,
    // and a UI that wrote it would create a second state indistinguishable from the
    // first and un-clearable (the `set_stage_next` defect, one column over). The one
    // consequence is stated rather than hidden: a column whose stored prefix IS `""`
    // (reachable only from outside this panel) reads as empty here, and committing the
    // empty field clears it to NULL — which is the launcher's own answer anyway, since
    // it prepends `""` and NULL identically.
    const next = committed === "" ? null : committed;
    if (next === stage.promptPrefix) return;
    try {
      await setStagePromptPrefix(spacePath, stage.slug, next);
    } catch {
      // Reverted; the store's line explains it and the draft is already cleared.
    }
  };

  /** Flip this column's auto-advance flag, which the panel labels **Continue when
   *  finished** (the owner's words for it).
   *
   *  NO local state and no re-read, and that is the difference from
   *  `StrictWorkflowToggle` rather than an omission of it. That component holds its flag
   *  in a `useState` because Strict is NOT on any row the board read returns — it lives
   *  on the `spaces` row — so it must seed itself from `getBoardStrict` and re-read after
   *  the write. Its rule, "paint from the READ, never from the click", therefore means
   *  "the rendered value is never the click". The SAME rule holds here through a
   *  different OWNER: `auto` rides on the `StageDto` this body already renders, the STORE
   *  owns the optimistic paint and the revert, and the body re-renders from the slice —
   *  so what is on screen is the slice's value and never the click's. A local `useState`
   *  here would be a second owner of one fact and would keep showing ON after the revert. */
  const toggleAuto = async (next: boolean): Promise<void> => {
    try {
      await setStageAuto(spacePath, stage.slug, next);
    } catch {
      // Reverted; the store's line explains it. The card a person is looking at did not
      // move, because the runtime reads the STORED flag and it did not change.
    }
  };

  const addDestination = async (
    destination: string,
    outcome: string | null,
  ): Promise<void> => {
    // THE SAME RULE THE CANVAS DRAG USES. This used to re-spell it inline
    // (`const current = stage.nextSlugs ?? []; if (current.includes(destination)) return;`)
    // and `lib/workflowEdgeWrite.ts` was extracted precisely so that re-spelling could not
    // happen: the module exists because the READ of `next_slugs` was spelled three times
    // and drifted into a defect. Two spellings agreed by luck, and the drift ADR 0120 is
    // about is a rule change reaching the drag and not the panel.
    //
    // What the shared rule adds over the inline version, beyond the dedupe this already
    // had: it refuses a self-loop as a VERDICT rather than only by the `candidates` filter
    // omitting the column, and it checks that BOTH endpoints exist in the loaded slice.
    // `null → [destination]` (configuring the column) and appending to `[]` are unchanged,
    // which is what `writes the one-item list…` pins on both surfaces.
    const next = nextSlugsAfterConnect(
      columns,
      stage.slug,
      destination,
      outcome,
    );
    // THE LABEL LIST, from the same owner and the same predicate — and this is the line
    // that stops a data-loss bug. `setStageNext`'s 4th argument is optional and defaults
    // to `slugs.map(() => null)`, so a 3-arg call here would clear every name the person
    // had already put on this column's edges while they were ADDING a destination. The
    // append answers the stored names plus the new one; see `nextOutcomesAfterConnect`.
    const nextOutcomes = nextOutcomesAfterConnect(
      columns,
      stage.slug,
      destination,
      outcome,
    );
    // `null` is a refusal, and the panel's `Select` offers only real, non-self,
    // not-yet-stored slugs — so today it is unreachable from this control. Writing nothing
    // is still the right answer for it: the alternative is a `set_stage_next` call the
    // server refuses and an error line for a gesture the picker should not have offered.
    // BOTH lists are checked because the write refuses a length mismatch (`EdgeOutcomeCount`);
    // the two derivations share one predicate, so one answers `null` exactly when the other
    // does, and there is no reachable state that writes a destination without its slot.
    if (next === null || nextOutcomes === null) return;
    try {
      await setStageNext(spacePath, stage.slug, next, nextOutcomes);
    } catch {
      // Reverted; the store's line explains it (an unknown slug or a self-loop REFUSES
      // rather than dropping the entry — spec §4).
    }
  };

  const writeDestinations = async (
    next: string[],
    outcomes: (string | null)[],
  ): Promise<void> => {
    try {
      // BOTH columns, ONE call, always the same length — `set_stage_next` refuses a
      // mismatch with `EdgeOutcomeCount` before it writes, because a shifted label is a
      // card that advances on the wrong claim. `NodeDestinations` owns the positional
      // arithmetic (it is the file that knows which chip was touched); this file owns the
      // verb, which is the split its header has always drawn.
      await setStageNext(spacePath, stage.slug, next, outcomes);
    } catch {
      // Reverted; see `addDestination`.
    }
  };

  /** The whole-slice reorder: swap the two slugs LOCALLY and hand the command EVERY
   *  column, not the pair that moved. `reorderStages` follows the `reorder_spaces`
   *  contract (index becomes `sort_order`, dense from 0), so a two-slug patch would
   *  leave the untouched columns holding a stale `sort_order` that can collide with the
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
    // relocate. A column WITH cards can only be deleted through a destination: a card
    // whose `stage_slug` names no row is invisible to `get_board`, keeps costing money
    // through its Session, and can never be clicked again (spec §4.1), so there is no
    // "delete anyway" escape to offer.
    //
    // THE DISCRIMINATOR, at click time and from the slice: a column ABSENT from the
    // slice is not a column with NO CARDS, so the two do not share an arm. The number
    // printed in the header is `cardCount`; the number that decides is read here.
    const column = columns?.find((c) => c.stage.slug === stage.slug);
    if (column === undefined) return;
    if (column.tasks.length === 0) {
      void deleteStage(spacePath, stage.slug);
      return;
    }
    setPendingDelete(true);
  };

  const confirmDelete = async (relocateTo: string): Promise<void> => {
    setPendingDelete(false);
    // ONE call. The relocation is a bulk UPDATE inside `delete_stage`'s own transaction;
    // `moveTask` per card would run the destination's `on_enter` once per card — five
    // cards, five compactions, all as a side effect of deleting a column (spec §4.1).
    await deleteStage(spacePath, stage.slug, relocateTo);
  };

  const destinations = stage.nextSlugs;
  // The edge names, positional to `destinations`, padded by the ONE owner of the
  // positional read so the panel, the canvas and `advise.rs` cannot disagree about which
  // edge a name sits on. NOT `stage.nextOutcomes ?? []` — that would read "no cell yet"
  // as "a cell of zero labels", and on a positional column a wrong length is a name on
  // the wrong edge.
  const outcomes = edgeOutcomesOf(stage);
  // The columns this node could point at, decided by the ONE rule rather than by a filter
  // this file invents. `canConnectStages` is the predicate the canvas hands
  // `isValidConnection`, so the panel's picker and the canvas's connection line now refuse
  // the SAME set for the SAME reason — which is the whole point of the extraction.
  //
  // This replaces the hand-written `c.stage.slug !== stage.slug` filter, and it is a
  // CONSEQUENCE of routing `addDestination` through `nextSlugsAfterConnect` rather than a
  // separate idea: once the write refuses a target, leaving that target in the picker is a
  // control that can only fail, and the option the rule now refuses is no longer just the
  // self-loop. What the predicate removes here is:
  //  - the column itself (`BoardError::SelfLoop`) — the filter's original and only job;
  //  - a destination the list ALREADY holds — previously offered, and picking it was the
  //    silent no-op the inline `current.includes` guard swallowed;
  //  - for an UNCONFIGURED column, its own `sortOrder + 1` fallback — the no-op gesture
  //    `canConnectStages` now refuses, whose wire is already drawn as the dashed one.
  //
  // The `impliedSlug` caption beside it says which column that last one is, so the option
  // disappearing from the picker has an explanation on screen rather than being a missing
  // row nobody can account for.
  const candidates = (columns ?? [])
    .filter((c) =>
      canConnectStages(columns, stage.slug, c.stage.slug, pendingOutcome),
    )
    .map((c) => ({ slug: c.stage.slug, label: c.stage.label }));
  // The relocation targets for the DELETE picker, and they are NOT the list above. Moving
  // cards is a `tasks.stage_slug` UPDATE inside `delete_stage`'s transaction; it has
  // nothing to do with `next_slugs`, so a column that is already a destination, or the
  // fallback column, or any other column at all, is a legal place to send cards. Reusing
  // the edge-filtered list here would hide valid targets behind a rule that does not apply
  // to the verb — which is exactly how a shared helper turns into a bug.
  const relocateCandidates = (columns ?? [])
    .filter((c) => c.stage.slug !== stage.slug)
    .map((c) => ({ slug: c.stage.slug, label: c.stage.label }));
  // The column the ORDER implies, asked of the ONE derivation so this caption and the
  // canvas's dashed wire cannot disagree. `nextStepSlugs` answers the row's OWN list for a
  // configured column, so the head it returns there is a stored destination and not a
  // fallback — `NodeDestinations` renders the caption only for `destinations === null`,
  // which is the one state where the value it is handed really is inferred.
  const impliedSlug = nextStepSlugs(columns, stage)[0] ?? null;
  const labelOf = (slug: string): string =>
    columns?.find((c) => c.stage.slug === slug)?.stage.label ??
    // An edge the slice cannot resolve still gets its slug: dropping it here would shrink
    // the workflow on screen, which is the failure `set_stage_next` refuses to write.
    slug;
  // Whether the FIRST destination names a column the slice holds. `NodeDestinations`
  // needs this for the fan-out sentence and cannot infer it from `labelOf` (a column
  // whose label equals its slug would be called stale) — see `fanOutSentence`.
  const headResolvable =
    destinations === null || destinations.length === 0
      ? true
      : columns?.some((c) => c.stage.slug === destinations[0]) ?? false;

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid={`stage-settings-${stage.slug}`}
    >
      <div className={PANEL_SECTION}>
        <span className="shrink-0 text-ui-sm text-foreground-subtle">Label</span>
        <Input
          aria-label={`Label for ${stage.slug}`}
          className="min-w-0 flex-1"
          value={draft ?? stage.label}
          onChange={(event) => setDraft(event.target.value)}
          // Enter commits the rename (a field you have to LEAVE to apply is a field that
          // lies about what is saved), and the event stops here so nothing upstream sees
          // a keypress that belongs to this field.
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitLabel();
          }}
          onBlur={() => void commitLabel()}
        />
      </div>

      {/* The slug, read-only, and the card count. Frozen after `createStage` derives it,
          so the caption exists to make the label↔slug mismatch VISIBLE (spec §5); the
          count is what tells a person whether deleting will ask them a question. */}
      <div className={PANEL_ROW}>
        <MutedCaption data-testid={`stage-slug-${stage.slug}`}>
          {stage.slug}
        </MutedCaption>
        <span className="shrink-0 rounded-md bg-panel px-2 py-0.5 font-mono text-ui-sm text-foreground-subtlest">
          {cardCount} {cardCount === 1 ? "card" : "cards"}
        </span>
      </div>

      <div className={PANEL_SECTION}>
        <span className="shrink-0 text-ui-sm text-foreground-subtle">Skill</span>
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
            className={cn(PANEL_SELECT, "w-full")}
          >
            <SelectValue>
              {/* A stored Skill the catalog no longer holds (a renamed directory) would
                  render an EMPTY trigger, which reads as "nothing configured". Name what
                  is saved instead — the `PermissionsSection` precedent for the trap. */}
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
      </div>

      <div className={PANEL_SECTION}>
        <span className="shrink-0 text-ui-sm text-foreground-subtle">
          Extra prompt
        </span>
        <Input
          aria-label={`Extra prompt for ${stage.slug}`}
          className="min-w-0 flex-1"
          placeholder="Extra prompt before the Skill launch"
          // The stored prefix when no draft is being typed — the same `draft ?? stored`
          // shape the label field uses, so the canvas node and this field can never
          // disagree about what is saved.
          value={prefixDraft ?? stage.promptPrefix ?? ""}
          onChange={(event) => setPrefixDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitPrefix();
          }}
          onBlur={() => void commitPrefix()}
        />
      </div>

      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 text-ui-sm text-foreground-subtle">
          Continue when finished
        </span>
        <Switch
          checked={stage.auto}
          // NOT `disabled={… === null}`: the Strict Switch needs that arm because its
          // flag has an unread state, and `auto` has none — the column is
          // `NOT NULL DEFAULT 0`, so `stage.auto` IS the seeded value. A `disabled` here
          // would be a control that is inert for a reason that does not exist.
          aria-label="Continue when finished"
          title={`A card launched in ${stage.slug} advances itself when its Session settles`}
          className="shrink-0"
          onCheckedChange={(checked) => void toggleAuto(checked)}
        />
      </div>

      <div className={PANEL_SECTION}>
        <span className="shrink-0 text-ui-sm text-foreground-subtle">
          Destinations
        </span>
        <div className={PANEL_ROW}>
          <NodeDestinations
            stageSlug={stage.slug}
            destinations={destinations}
            outcomes={outcomes}
            candidates={candidates}
            onPendingOutcomeChange={setPendingOutcome}
            labelOf={labelOf}
            headResolvable={headResolvable}
            impliedSlug={impliedSlug}
            // BOTH arguments forwarded. A `(next) => …` lambda here compiles fine and
            // silently drops the positional name list on the floor, which paints a graph
            // whose edges all read unnamed while the person was naming one of them — the
            // same clearing defect `nextOutcomesAfterConnect` exists to prevent, arriving
            // one layer up instead of at the write.
            onWrite={(next, nextOutcomes) =>
              void writeDestinations(next, nextOutcomes)
            }
            onAdd={(slug, outcome) => void addDestination(slug, outcome)}
          />
        </div>
      </div>

      <div className={PANEL_ROW}>
        {/* The column's place in the order — a SEPARATE question from the destinations
            above (ADR 0099 splits "where does this render" from "what may a Task go to
            next"), so it is a separate control. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${stage.slug} up`}
          title={`Move ${stage.slug} up`}
          className={PANEL_BUTTON}
          // `aria-disabled` and not `disabled`: an inert arrow that still occupies its
          // slot beats one that appears and disappears as the list moves.
          aria-disabled={position <= 0 || undefined}
          onClick={() => {
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
          className={PANEL_BUTTON}
          aria-disabled={position >= total - 1 || undefined}
          onClick={() => {
            if (position >= total - 1) return;
            void moveStage(1);
          }}
        >
          <ChevronDownIcon className="size-4" />
        </Button>

        {pendingDelete ? (
          // THE DESTINATION PICKER. It replaces the delete control, so the only way to
          // proceed is to name a destination — there is no "delete anyway" control
          // anywhere in this branch (spec §8).
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
              {cardCount} {cardCount === 1 ? "card" : "cards"} here — move them to
            </span>
            <Select onValueChange={(next) => void confirmDelete(next)}>
              <SelectTrigger
                aria-label={`Move the cards in ${stage.slug} to`}
                className={PANEL_SELECT}
              >
                <SelectValue placeholder="Choose a column" />
              </SelectTrigger>
              <SelectContent>
                {/* NOT `candidates` — that list is filtered by the EDGE rule and this is
                    the RELOCATION picker. See `relocateCandidates` for why the two differ. */}
                {relocateCandidates.map((c) => (
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
              className={PANEL_BUTTON}
              onClick={() => setPendingDelete(false)}
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
            className={cn(PANEL_BUTTON, "ml-auto")}
            onClick={() => requestDelete()}
          >
            <Trash2Icon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The `Select` sentinel for "no Skill". NOT the empty string: Radix refuses a
 *  `SelectItem` with `value=""`, and `"none"` cannot collide with a Skill name because a
 *  Skill's directory name is never the literal word `none`. */
const NO_SKILL = "none";
