import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { CatalogSearchDialog } from "./CatalogSearchDialog";
import { IpcErrorLine } from "./IpcErrorLine";
import { MutedCaption } from "./MutedCaption";
import { RowButton } from "./RowButton";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import { cn } from "./lib/utils";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { useTasks } from "../store/tasks";
import type { StageRow } from "../lib/tauri";

/**
 * The **Stage editor** — the dialog the board header's `Configure` control opens
 * (issue #179 §8). The human surface for the `stages` row: a column's label, the
 * Skill a Session started from it loads (ADR 0098), the columns it may lead to
 * (ADR 0099), its place in the order, its deletion, and the Space's
 * Strict-workflow opt-in.
 *
 * ---------------------------------------------------------------------------
 * WHY A DIALOG AND NOT A SETTINGS SECTION, AND NOT INLINE ON THE COLUMN
 * ---------------------------------------------------------------------------
 *
 * ADR 0066 removed the Agents section precisely so one app-global config has ONE
 * surface; Stages are per-Space, which Settings has no model for, so a Settings
 * section would be a second owner of "where do you change a thing". And inline
 * editing on a column header is the hazard `TaskCard.tsx` records in the other
 * direction: the header is a flex row of spans INSIDE the drop-target `<div>` that
 * carries `useDragCard.columnProps()`, and `draggable` inherits to children — so a
 * label you click to rename sits inside a drag surface, which is how "the rename
 * started a drag" gets written. Everything here happens in a modal, on the
 * `CatalogSearchDialog` shell the Skills and Agents dialogs already use, one
 * `RowButton` per Stage.
 *
 * ---------------------------------------------------------------------------
 * EVERY WRITE GOES THROUGH `store/tasks`, NEVER THROUGH A COMMAND
 * ---------------------------------------------------------------------------
 *
 * The store owns the optimistic paint, the whole-slice re-derivation and the revert
 * into `error` (spec §8.1); this component owns only what the human sees. Two
 * consequences that are visible in the code below:
 *  - the editor reads the column set out of the SAME store slice the board paints,
 *    so an editor and a board that disagree about the columns is not reachable;
 *  - the error line is the store's `error` cell, not a local one — the board
 *    renders that same cell, and a second error surface would be two answers to
 *    "what went wrong".
 *
 * THE CATALOG IS NOT FETCHED HERE. `useMentionCatalogs` is module-cached per Space
 * and the board surface already mounted it, so this read SHARES that promise rather
 * than issuing a second `listSkills` (spec §8: "the same hook `TaskDetailDialog`
 * uses, not a second fetch"). `TaskDetailDialog.tsx` and `NewTaskDialog.tsx`
 * document the same reuse; a direct `listSkills` call here would be a second owner
 * of one fetch, and `StageEditor.test.tsx` pins the dedupe.
 *
 * ---------------------------------------------------------------------------
 * ONE `role="button"` PER ROW, AND WHO GETS THE CLICK
 * ---------------------------------------------------------------------------
 *
 * A row is ONE `RowButton` — the app's only hand-rolled `role="button"` row — and
 * every control nested in it is a native `<button>` or `<input>` with NO `role`
 * attribute spelled (a `<button>` needs none, and spelling one would give every row
 * a second `[role="button"]` node, which is what breaks the eight
 * `.closest('[role="button"]')` reads in `SpacesList.test.tsx`).
 *
 * Interaction routing, in one sentence and pinned by the two cases named
 * `one role per row, and who gets the click` in the test file: **the row's single
 * affordance is "focus this Stage's label field", so every nested control calls
 * `stopPropagation()` on its `onClick` (otherwise the click bubbles into the row and
 * steals focus out of the control the user just used), and the row's own `onKeyDown`
 * acts only when `event.target === event.currentTarget` (otherwise an Enter pressed
 * inside the label `Input` or a nested button bubbles into the row's Enter handler
 * and moves focus on top of the action that key just performed).** The
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
 */
export interface StageEditorProps {
  /** The **Space** whose board is being configured. `null` renders nothing — the
   *  board's `Configure` control is disabled in that state, and a dialog mounted
   *  without a Space would be a form whose every write has no target. */
  spacePath: string | null;
  /** Close the dialog. The BOARD owns the open flag (mirrors `NewTaskDialog`), so
   *  the editor never clears a flag it does not hold. */
  onClose: () => void;
}

/** The row shell: Skills' geometry, once. `flex-col` because a Stage row is a
 *  stack of fields, not a name-and-caption line. */
const STAGE_ROW = "group flex min-w-0 flex-col gap-1 rounded-lg px-2.5 py-1.5";
/** A row's control cluster: a quiet row of small affordances under the fields. */
const CONTROL_ROW = "flex min-w-0 flex-wrap items-center gap-1";
/** The one affordance shape a row nests: `Button variant="ghost"` at the smallest
 *  icon size, so a row of them stays quieter than the fields they act on. */
const ROW_BUTTON =
  "shrink-0 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground";
/** The nested `Select`s are the narrow variant so a row of three fits the dialog. */
const ROW_SELECT = "h-6 w-36";

/** The `Select` sentinel for "no Skill". NOT the empty string: Radix refuses an
 *  `SelectItem` with `value=""`, and `"none"` cannot collide with a Skill name
 *  because a Skill's directory name is never the literal word `none`. */
const NO_SKILL = "none";

/** A row's label draft, keyed by slug. Local on purpose: the store holds the
 *  STORED label (what the board paints) and this holds what is being typed, so the
 *  column header never flickers with half-typed text. Cleared after a commit —
 *  success or refusal — so the field falls back to what the store actually has. */
type Drafts = Record<string, string>;

export default function StageEditor({
  spacePath,
  onClose,
}: StageEditorProps): ReactElement | null {
  const columns = useTasks((s) =>
    spacePath ? s.boardsBySpace[spacePath] : undefined,
  );
  const error = useTasks((s) => s.error);
  const createStage = useTasks((s) => s.createStage);
  const renameStage = useTasks((s) => s.renameStage);
  const setStageSkill = useTasks((s) => s.setStageSkill);
  const setStageNext = useTasks((s) => s.setStageNext);
  const reorderStages = useTasks((s) => s.reorderStages);
  const deleteStage = useTasks((s) => s.deleteStage);
  const setBoardStrict = useTasks((s) => s.setBoardStrict);
  const getBoardStrict = useTasks((s) => s.getBoardStrict);
  const { skills } = useMentionCatalogs(spacePath);

  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [newLabel, setNewLabel] = useState("");
  /** The Stage whose delete is waiting on a destination, or `null`. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** `null` = NOT KNOWN (the read is in flight, or it failed). See `readStrict`. */
  const [strict, setStrict] = useState<boolean | null>(null);

  const labelRefs = useRef(new Map<string, HTMLInputElement>());

  /** Read the Strict flag. `null` on failure, deliberately: `false` is a FACT about
   *  the Space and a swallowed read must not hand the Switch that fact as its
   *  default, because the whole point of reading the flag (rather than defaulting
   *  it) is that the Switch must show the SAME value `moveTask` enforces. A Switch
   *  claiming Strict over a board whose drags are all accepted is the failure
   *  `getBoardStrict`'s own doc says it exists to prevent — so an unread flag
   *  renders the Switch DISABLED, which is the one state that is not a guess. */
  const readStrict = useCallback((): void => {
    if (spacePath === null) return;
    void getBoardStrict(spacePath).then(
      (value) => setStrict(value),
      // The store already wrote the sentence into `error`; the `null` keeps the
      // Switch inert. No second console line and no throw out of a mount effect.
      () => setStrict(null),
    );
  }, [spacePath, getBoardStrict]);

  useEffect(() => {
    if (spacePath === null) return;
    setStrict(null);
    readStrict();
  }, [spacePath, readStrict]);

  const toggleStrict = async (next: boolean): Promise<void> => {
    if (spacePath === null) return;
    // Paint from the READ, never from the click: the click is a request and the
    // write can be refused, and this Switch is the one control in this dialog that
    // claims something about what a DRAG will do.
    setStrict(next);
    await setBoardStrict(spacePath, next);
    // Re-read rather than trust the paint: the store's `setBoardStrict` captures
    // its failure into `error` and does not rethrow (the `moveTask` shape), so
    // without this the Switch would keep showing a value the Space refused.
    readStrict();
  };

  const commitLabel = async (stage: StageRow): Promise<void> => {
    if (spacePath === null) return;
    const draft = drafts[stage.slug];
    setDrafts((rest) => {
      if (!(stage.slug in rest)) return rest;
      const next = { ...rest };
      delete next[stage.slug];
      return next;
    });
    // NO draft, or a draft identical to the stored label → nothing to write. The
    // commit fires on every blur, and a blur happens on every click elsewhere in
    // the dialog, so an ungated commit would rewrite the whole board's labels as the
    // user worked.
    if (draft === undefined || draft === stage.label) return;
    try {
      await renameStage(spacePath, stage.slug, draft);
    } catch {
      // The store reverted the slice and wrote the sentence into `error`, which this
      // dialog renders; the draft is already cleared, so the field falls back to the
      // label the database actually holds.
    }
  };

  const addDestination = async (
    stage: StageRow,
    destination: string,
  ): Promise<void> => {
    if (spacePath === null) return;
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

  const setDestinations = async (
    stage: StageRow,
    next: string[],
  ): Promise<void> => {
    if (spacePath === null) return;
    try {
      await setStageNext(spacePath, stage.slug, next);
    } catch {
      // Reverted; see `addDestination`.
    }
  };

  /** The whole-slice reorder (spec §4's `reorder_spaces` contract): swap the two
   *  slugs LOCALLY and hand the command EVERY column, not the pair that moved. */
  const moveStage = async (slug: string, delta: -1 | 1): Promise<void> => {
    if (spacePath === null || columns === undefined) return;
    const slugs = columns.map((c) => c.stage.slug);
    const at = slugs.indexOf(slug);
    const to = at + delta;
    if (at === -1 || to < 0 || to >= slugs.length) return;
    const next = [...slugs];
    [next[at], next[to]] = [next[to]!, next[at]!];
    await reorderStages(spacePath, next);
  };

  const requestDelete = (stage: StageRow): void => {
    if (spacePath === null) return;
    // An EMPTY column needs no destination and no question — there is nothing to
    // relocate. A column WITH cards can only be deleted through a destination: a
    // card whose `stage_slug` names no row is invisible to `get_board`, keeps
    // costing money through its Session, and can never be clicked again (spec §4.1),
    // so there is no "delete anyway" escape to offer.
    const column = columns?.find((c) => c.stage.slug === stage.slug);
    if (column === undefined) return;
    if (column.tasks.length === 0) {
      void deleteStage(spacePath, stage.slug);
      return;
    }
    setPendingDelete(stage.slug);
  };

  const confirmDelete = async (slug: string, relocateTo: string): Promise<void> => {
    if (spacePath === null) return;
    setPendingDelete(null);
    // ONE call. The relocation is a bulk UPDATE inside `delete_stage`'s own
    // transaction; `moveTask` per card would run the destination's `on_enter` once
    // per card — five cards, five compactions, all as a side effect of deleting a
    // column (spec §4.1).
    await deleteStage(spacePath, slug, relocateTo);
  };

  const addStage = async (): Promise<void> => {
    if (spacePath === null) return;
    const label = newLabel.trim();
    if (label === "") return;
    try {
      await createStage(spacePath, label);
      // Cleared only on success: a refused collision (T1 refuses rather than
      // inventing `spike-2`) is a refusal of the SLUG, and the label the user typed
      // is still what they want to name their column.
      setNewLabel("");
    } catch {
      // The draft stands; the store's line explains the collision.
    }
  };

  // No Space, no dialog at all — and this sits AFTER every hook above, which is
  // the only legal place for it. (The board disables `Configure` in this state, so
  // this is the second half of that rule rather than a live path: a mounted editor
  // with no target would be a form whose every write goes nowhere.)
  if (spacePath === null) return null;

  const needle = query.trim().toLowerCase();
  const rows = (columns ?? []).filter(
    (c) =>
      needle === "" ||
      c.stage.label.toLowerCase().includes(needle) ||
      c.stage.slug.toLowerCase().includes(needle),
  );

  return (
    <CatalogSearchDialog<StageRow>
      open={spacePath !== null}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      title="Configure stages"
      searchPlaceholder="Search stages…"
      query={query}
      onQueryChange={setQuery}
      rows={rows.map((c) => c.stage)}
      keyOf={(stage) => stage.slug}
      // THREE states, and the shell treats a non-null message as "replace the rows"
      // — so the matched case must be `null` or the board's columns would never
      // render. Never-loaded and loaded-but-empty get the same sentence because the
      // board's `Configure` control cannot be reached without a loaded board.
      emptyMessage={
        (columns ?? []).length === 0
          ? "This Space has no stages yet."
          : rows.length === 0
            ? `No stages match "${query}".`
            : null
      }
      rowGapClassName="gap-0.5"
      renderRow={(stage) => {
        const column = columns?.find((c) => c.stage.slug === stage.slug);
        const cardCount = column?.tasks.length ?? 0;
        const destinations = stage.nextSlugs ?? [];
        // The columns this Stage could point at: everything EXCEPT itself. A
        // self-loop is refused by `set_stage_next` (spec §4 — it would be a button
        // that moves a card to the column it is already in), so offering it would be
        // a control that can only fail.
        const candidates = (columns ?? [])
          .filter((c) => c.stage.slug !== stage.slug)
          .map((c) => c.stage);
        const order = columns ?? [];
        const position = order.findIndex((c) => c.stage.slug === stage.slug);
        const focusLabel = (): void => labelRefs.current.get(stage.slug)?.focus();
        const stop = (event: MouseEvent | KeyboardEvent): void =>
          event.stopPropagation();

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
                ref={(node) => {
                  // The map is the row's own focus route. Assigned with the slug as
                  // the key and cleared on unmount (React calls the callback with
                  // `null`), so a deleted Stage cannot leave a detached node here.
                  const map = labelRefs.current;
                  if (node === null) map.delete(stage.slug);
                  else map.set(stage.slug, node);
                }}
                aria-label={`Label for ${stage.slug}`}
                className="min-w-0 flex-1"
                value={drafts[stage.slug] ?? stage.label}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [stage.slug]: event.target.value,
                  }))
                }
                onClick={stop}
                // Enter commits the rename (a field you have to LEAVE to apply is a
                // field that lies about what is saved), and the event stops here so
                // the row's Enter handler stays out of it.
                onKeyDown={(event) => {
                  stop(event);
                  if (event.key === "Enter") void commitLabel(stage);
                }}
                onBlur={() => void commitLabel(stage)}
              />
              {/* The count, so a rename is not the only thing a row can tell you:
                  how many cards this column holds is what decides whether deleting
                  it will ask a question. */}
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
                  if (spacePath === null) return;
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

              {/* The destinations, in the order the card's pill and the detail
                  dialog render them. The FIRST entry is the card's primary next step
                  (spec §7.1), which is why these are ordered chips and not a set. */}
              {stage.nextSlugs === null || destinations.length === 0 ? (
                <MutedCaption data-testid="destination-state">
                  {stage.nextSlugs === null
                    ? "Unconfigured — any column may follow"
                    : "No destinations — nothing may follow"}
                </MutedCaption>
              ) : (
                destinations.map((slug, index) => {
                  const label =
                    columns?.find((c) => c.stage.slug === slug)?.stage.label ??
                    // An edge the slice cannot resolve still gets its slug: dropping
                    // it here would shrink the workflow on screen, which is the
                    // failure `set_stage_next` refuses to write in the first place.
                    slug;
                  return (
                    <span
                      data-testid={`destination-${slug}`}
                      key={slug}
                      className="flex min-w-0 shrink-0 items-center gap-0.5 rounded-md bg-panel py-0.5 pr-0.5 pl-2 text-ui-sm text-foreground-subtle"
                    >
                      <span className="min-w-0 truncate">{label}</span>
                      <button
                        type="button"
                        aria-label={`Move ${label} earlier in ${stage.slug}`}
                        title={`Move ${label} earlier in ${stage.slug}`}
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded text-foreground-subtlest",
                          // The FIRST chip has nothing earlier to move to; an inert
                          // affordance is honest, a missing one is a moving layout.
                          index === 0
                            ? "opacity-40"
                            : "hover:bg-surface-hover hover:text-foreground",
                        )}
                        disabled={index === 0}
                        onKeyDown={stop}
                        onClick={(event) => {
                          stop(event);
                          if (index === 0) return;
                          const next = [...destinations];
                          const [moved] = next.splice(index, 1);
                          next.splice(index - 1, 0, moved!);
                          void setDestinations(stage, next);
                        }}
                      >
                        <ChevronUpIcon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${label} from ${stage.slug}`}
                        title={`Remove ${label} from ${stage.slug}`}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
                        onKeyDown={stop}
                        onClick={(event) => {
                          stop(event);
                          void setDestinations(
                            stage,
                            destinations.filter((s) => s !== slug),
                          );
                        }}
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </span>
                  );
                })
              )}

              <Select
                // Uncontrolled and keyed on the current list, so the trigger reads
                // "Add a destination" again after each append instead of showing the
                // destination that was just added (a second pick would then be a
                // no-op the user reads as a broken control).
                key={`add-${stage.slug}-${destinations.join(",")}`}
                onValueChange={(next) => void addDestination(stage, next)}
              >
                <SelectTrigger
                  aria-label={`Add a destination for ${stage.slug}`}
                  className={ROW_SELECT}
                  variant="ghost"
                  onClick={stop}
                  onKeyDown={stop}
                >
                  <SelectValue placeholder="Add a destination" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.slug} value={c.slug}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                  void moveStage(stage.slug, -1);
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
                aria-disabled={position >= order.length - 1 || undefined}
                onKeyDown={stop}
                onClick={(event) => {
                  stop(event);
                  if (position >= order.length - 1) return;
                  void moveStage(stage.slug, 1);
                }}
              >
                <ChevronDownIcon className="size-4" />
              </Button>

              {pendingDelete === stage.slug ? (
                // THE DESTINATION PICKER. It replaces the row's own delete control,
                // so the only way to proceed is to name a destination — there is no
                // "delete anyway" control anywhere in this branch (spec §8).
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
                    {cardCount} {cardCount === 1 ? "card" : "cards"} here — move them
                    to
                  </span>
                  <Select onValueChange={(next) => void confirmDelete(stage.slug, next)}>
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
                      setPendingDelete(null);
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
                    requestDelete(stage);
                  }}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              )}
            </div>
          </RowButton>
        );
      }}
    >
      {/* Everything below the rows is SIBLING content the shell inserts after the
          scroller: the error line, the add-a-Stage field, and the Space-level
          Strict-workflow Switch. */}
      <IpcErrorLine error={error} />

      <div className="flex min-w-0 items-center gap-2 border-t border-card-border pt-2">
        <Input
          aria-label="New stage label"
          className="min-w-0 flex-1"
          placeholder="New stage label"
          value={newLabel}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addStage();
          }}
        />
        {/* A column whose name is empty is a column nobody can rename by sight, so
            the affordance is inert until there is a name — `aria-disabled` because
            `Button` is a real `<button>` and the disabled PROPERTY would also be
            read here; the guard in `addStage` is the one that actually decides. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Add stage"
          className="shrink-0 gap-1"
          aria-disabled={newLabel.trim() === "" || undefined}
          onClick={() => void addStage()}
        >
          <PlusIcon className="size-3.5" />
          <span>Add stage</span>
        </Button>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-2 border-t border-card-border pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <Switch
            checked={strict ?? false}
            // Inert while the flag is unread — see `readStrict`. Radix puts the
            // inert half on the `disabled` PROPERTY (there is no `aria-disabled`).
            disabled={strict === null}
            aria-label="Strict workflow"
            onCheckedChange={(checked) => void toggleStrict(checked)}
          />
          <span className="min-w-0 text-ui-sm text-foreground-subtle">
            Strict workflow
          </span>
        </div>
        <MutedCaption>
          {strict
            ? "Only the columns a Stage points at can receive a card"
            : "Any column can receive a card"}
        </MutedCaption>
      </div>
    </CatalogSearchDialog>
  );
}
