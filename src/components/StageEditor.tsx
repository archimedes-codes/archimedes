import { useState } from "react";
import type { ReactElement } from "react";
import { CatalogSearchDialog } from "./CatalogSearchDialog";
import { IpcErrorLine } from "./IpcErrorLine";
import { AddStageField } from "./stages/AddStageField";
import { StageRow } from "./stages/StageRow";
import { StrictWorkflowToggle } from "./stages/StrictWorkflowToggle";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { useTasks } from "../store/tasks";
import type { StageDto } from "../lib/tauri";

/**
 * The **Stage editor** — the dialog the board header's `Configure` control opens
 * (issue #179 §8). What is left here once the rows are components is the SHELL and
 * the two pieces of state the shell owns: the filter `query`, and which row (if
 * any) is asking its delete question. Everything a row does — its label, Skill,
 * destinations, order, deletion — lives in `stages/StageRow.tsx` and
 * `stages/StageDestinations.tsx`, and the footer's two subjects live in
 * `stages/AddStageField.tsx` and `stages/StrictWorkflowToggle.tsx`.
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
 * of one fetch, and `StageEditor.test.tsx` pins the dedupe. The hook is mounted
 * HERE rather than per row because it is one fetch for the dialog, and the rows take
 * `skills` as a prop — the same reason `AgentsDialog` resolves its catalogs once and
 * passes them down.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE STILL COMPUTES, AND WHY ONLY ONCE
 * ---------------------------------------------------------------------------
 *
 * `derived` is one `Map` built from `columns` before the return, and it hoists
 * exactly ONE of the two scans a row used to run. It is worth separating the two,
 * because the header would otherwise claim a hoist that half-happened:
 *
 *  - THE COUNT IS HOISTED. `cardCount` is the per-column `tasks.length`, and before
 *    this it was a `columns?.find()` inside a `renderRow` callback that runs per row
 *    per render — N finds for N rows, each finding the column the pass was already
 *    standing on. That is now one `map` for the whole dialog.
 *  - THE CANDIDATE SCAN IS NOT. Building the list of other columns a Stage can point
 *    at used to be a `filter().map()` in the same callback, and it is still one per
 *    row per render — it moved to `stages/StageRow.tsx` NARROWED, not verbatim: the
 *    `filter` is unchanged, `main`'s `map` yielded the whole `StageDto` where this one
 *    yields the `{ slug, label }` pair its controls print, and `main`'s inline label
 *    `find` is now the `labelOf` resolver, a separate scan `StageDestinations` reads.
 *    `candidates` feeds two `Select`s, this row's delete picker and the add-destination
 *    one. `derived` cannot carry the scan: it is `{ cardCount, slugs }`, which cannot
 *    answer "what is `doing` called" — labels there make the shell own a foreign fact.
 *
 * `slugs` is one array PER RENDER handed to every row (the same reference in every
 * `derived` entry, and a fresh one on the next render — see the note on `slugs` in
 * `stages/StageRow.tsx`) — the rows never mutate it (each builds its own copy to
 * swap in), so sharing it is free and it is what lets a row satisfy `reorderStages`'
 * whole-slice contract.
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

export default function StageEditor({
  spacePath,
  onClose,
}: StageEditorProps): ReactElement | null {
  const columns = useTasks((s) =>
    spacePath ? s.boardsBySpace[spacePath] : undefined,
  );
  const error = useTasks((s) => s.error);
  const { skills } = useMentionCatalogs(spacePath);

  const [query, setQuery] = useState("");
  /** The Stage whose delete is waiting on a destination, or `null`. The parent holds
   *  this rather than each row holding its own flag, because the invariant is
   *  DIALOG-wide: one open question at a time. A row asks (`onAskDelete`) and a row
   *  answers (`onDismissDelete`); neither can make another row's picker close. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // No Space, no dialog at all — and this sits AFTER every hook above, which is
  // the only legal place for it. (The board disables `Configure` in this state, so
  // this is the second half of that rule rather than a live path: a mounted editor
  // with no target would be a form whose every write goes nowhere.)
  if (spacePath === null) return null;

  const slugs = (columns ?? []).map((c) => c.stage.slug);
  // ONE pass over the columns for the two facts every row needs. It hoists the
  // COUNT, not the candidate scan — see the header. `slugs` is the SAME array
  // reference in every entry, and a new array on the next render.
  const derived = new Map(
    (columns ?? []).map((c) => [
      c.stage.slug,
      { cardCount: c.tasks.length, slugs },
    ]),
  );

  const needle = query.trim().toLowerCase();
  const rows = (columns ?? []).filter(
    (c) =>
      needle === "" ||
      c.stage.label.toLowerCase().includes(needle) ||
      c.stage.slug.toLowerCase().includes(needle),
  );

  return (
    <CatalogSearchDialog<StageDto>
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
      renderRow={(stage) => (
        <StageRow
          stage={stage}
          spacePath={spacePath}
          derived={derived.get(stage.slug) ?? { cardCount: 0, slugs }}
          skills={skills}
          pendingDelete={pendingDelete === stage.slug}
          onAskDelete={() => setPendingDelete(stage.slug)}
          onDismissDelete={() => setPendingDelete(null)}
        />
      )}
    >
      {/* Everything below the rows is SIBLING content the shell inserts after the
          scroller: the error line, the add-a-Stage field, and the Space-level
          Strict-workflow Switch. The last two are components, and that is a DOM
          fact, not a style preference — a component boundary adds no element, so
          each still renders exactly ONE `<div>` as a sibling of the scroller. A
          shared footer `<div>` around them would be the extra level
          `CatalogSearchDialog`'s header says the `parentElement` pins forbid. */}
      <IpcErrorLine error={error} />

      <AddStageField spacePath={spacePath} />

      <StrictWorkflowToggle spacePath={spacePath} />
    </CatalogSearchDialog>
  );
}
