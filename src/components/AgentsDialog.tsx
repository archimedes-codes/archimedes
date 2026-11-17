import { useState } from "react";
import { TrashIcon } from "lucide-react";
import type {
  AgentDefinitionReportDto,
  AgentOverride,
  AgentOverrides,
  AppSettings,
  ModelDto,
} from "../lib/tauri";
import { foldAscii, orphanedOverrides, withOverride } from "../lib/agentOverrides";
import { CatalogSearchDialog } from "./CatalogSearchDialog";
import { MutedCaption } from "./MutedCaption";
import { Button } from "./ui/button";
import { AgentRow } from "./agents/AgentRow";
import { editedKey, NO_KEYS } from "./agents/agentLabels";

/**
 * The **Agents** modal (ADR 0066 / ADR 0068) — the ONE Agent surface, opened
 * from the **Session list**'s labelled **Agents** control (beside **Skills**).
 *
 * One row per **Agent definition** the ACTIVE **Space** can see (project-level
 * rows AND the global ones — `list_agent_definition_reports(cwd)` discovers with that `cwd`),
 * each carrying the three fields an **Agent override** can set, with the value
 * AND the layer that supplied it (`override` / `file` / `Inherits parent`). The
 * effective values and their layers come from Rust — the same resolver a real
 * dispatch runs (ADR 0068) — so this component derives nothing about resolution;
 * it renders the rows it is handed.
 *
 * PROP-DRIVEN like `SkillsDialog`: the fetch lives in `useAgentCatalog` at the
 * mount (which is also where the settings document is read and written), so the
 * dialog needs no IPC and its tests need no mock.
 *
 * What the two "which layer" columns read, and why:
 * - the **file** and **runs** columns are `row.file` / `row.effective` /
 *   `row.source` verbatim — Rust's answer, at the time of the last fetch;
 * - the **override** column and every control read `settings.agentOverrides`,
 *   i.e. the live document. A write lands in the store immediately, so the
 *   controls never misrepresent the saved state; the resolver's columns lag until
 *   the catalog refetches (a Space switch, or the next pane mount after a save —
 *   `SpacesList` evicts the catalog on a successful write), which is why they are
 *   labelled `runs` — "what the last fetch saw the dispatch launch with" — and
 *   never restated as a promise about the edit you just made.
 *
 * The fetch-time `row.override` column is NOT bound to the controls — but it is
 * READ, for the one case where it and the store-side lookup disagree (see
 * `storedPinDiff`). Two selectors over one map can pick different entries, and a
 * row that silently shows one pin while the dispatch resolves the other is the
 * exact misrepresentation the rest of this component is written against.
 */

interface AgentsDialogProps {
  rows: AgentDefinitionReportDto[];
  /**
   * True while NO **Space** is open. This changes the COPY only — the override
   * map is GLOBAL, so nothing is disabled: with no Space the rows are the
   * user-level set, exactly what the deleted Settings section offered. (In the
   * old per-Space plan this flag disabled every control, because there was no
   * layer to write to without a Space. There is always one now.)
   *
   * It gates ONE thing that is not copy: the orphan block. The rows it lists come
   * from a catalog discovery that was only allowed to read the user roots, so an
   * entry can be "undiscovered" here and live in every project that defines that
   * name — which is why no remove button is offered in that state. See `orphans`.
   */
  noSpaceOpen: boolean;
  settings: AppSettings | null;
  models: ModelDto[];
  tools: string[];
  /**
   * How many of THIS mount's writes have FAILED and rolled the store back to the
   * file's map — TRANSIENTLY, once the mount's write queue holds a link whose
   * composed map still carries the failed field: that link re-applies it when it
   * completes (see `writeAgentOverrides`). The mount owns the save, and a rollback
   * takes back the one thing the `edited` set was built on — the explanation that a
   * difference against the fetch
   * column is a save the backend already has. A write that never landed explains
   * nothing, so the suppression is dropped when this moves (see `edited`).
   *
   * Optional because the dialog is prop-driven and its own tests have no writes; the
   * mount always passes it.
   */
  rolledBackWrites?: number;
  onPatch: (next: AgentOverrides) => void;
  onClose: () => void;
}

export default function AgentsDialog({
  rows,
  noSpaceOpen,
  settings,
  models,
  tools,
  rolledBackWrites = 0,
  onPatch,
  onClose,
}: AgentsDialogProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // Case-insensitive NAME substring (the `SkillsDialog` policy, stated there as
  // name-only for v1). The SAME needle filters the shadow report below, so the
  // report can never contradict the list above it.
  const filtered =
    needle === ""
      ? rows
      : rows.filter((r) => r.name.toLowerCase().includes(needle));

  // The union of the `thinkingLevels` arrays across the catalog, deduped in
  // FIRST-SEEN order (a `Set` preserves insertion order, so no `.sort()`) —
  // `SettingsPage`'s `thinkingLevelUnion` memo COPIED, not imported: a page
  // module is not a component's library, and the two surfaces have no reason to
  // re-render in step.
  const levelSet = new Set<string>();
  for (const model of models) {
    for (const level of model.thinkingLevels) levelSet.add(level);
  }
  const thinkingLevelUnion = [...levelSet];

  // (ADR 0023) The stored entries matching no discovered definition — ADR 0023's
  // orphans, and the remove button on them is that ADR's ONLY cleanup path.
  //
  // The helper's comment puts the "have the definitions loaded?" gate on the
  // CALLER, and from the dialog's seat `rows === []` is genuinely ambiguous: the
  // hook serves `[]` while a fetch is in flight, on a failed fetch, AND when a
  // folder really has no definitions. Gating on a non-empty list takes the safe
  // side of that ambiguity — a stale override is then momentarily invisible
  // rather than flashed as stale with a LIVE remove button. It is the same gate
  // the deleted section had (`agentDefs !== null`), expressed in the only signal
  // this prop list carries.
  //
  // THE SECOND GATE, `noSpaceOpen`, is the same argument one level up and it is
  // the stronger one. With no Space open the rows are the USER-level set, so a key
  // for a definition some PROJECT defines reads as "undiscovered" here while being
  // perfectly live in every project that defines it. The modal has no signal that
  // distinguishes "stale everywhere" from "defined in a project I was not allowed to
  // read" — `noSpaceOpen` IS that signal, and the honest consequence is to render no
  // orphan block at all rather than one whose trash button is armed against data the
  // modal cannot prove stale (a reworded-but-still-clickable button would still be
  // the ADR's only cleanup path firing on live data).
  //
  // The trade-off, stated so it cannot be mistaken for a loss: while NO Space is
  // open, a GENUINELY user-level orphan gets no cleanup row here either. It is not
  // orphaned away — the map is global, and a name no root contributes stays
  // undiscovered in EVERY Space's catalog, so the same key surfaces (with its remove
  // button) as soon as any Space is open. ADR 0023's cleanup duty is therefore
  // reachable FROM ANY STATE IN WHICH A SPACE IS OPEN, just not from the one state in
  // which the modal can only see half the roots; what the no-Space state loses is
  // only the stale claim it cannot support.
  const orphans =
    settings === null || rows.length === 0 || noSpaceOpen
      ? []
      : orphanedOverrides(settings.agentOverrides, rows);

  /** One write, always through the shared editor: `withOverride` owns the
   * case-fold-twin drop and the delete-the-empty-entry rule, which are the two
   * things a hand-assembled spread in this component would get wrong.
   *
   * The `edited` bookkeeping exists for the stored-pin cue and nowhere else: a
   * field the user has written in this mount has an EXPLAINED difference between
   * the store map and the fetch-time `row.override` column, so the cue must not
   * claim the backend is reading something stale that the backend was just told.
   *
   * The set is stamped with the `rolledBackWrites` value it was recorded against,
   * and a stamp that no longer matches is treated as EMPTY — DERIVED STATE (a plain
   * read of state + prop during render), not the state-adjustment pattern: no
   * `setState`, no effect, no extra render is involved. A failed save rolls the
   * store back to the FILE's map — TRANSIENTLY, once the mount's queue holds a link
   * whose composed map still carries the failed field (see `writeAgentOverrides`) —
   * which takes back the explanation the suppression
   * rests on: the difference is unexplained again, and the row has to say it.
   *
   * The whole set goes, not just the failed field's key, because that is the fact
   * the mount actually has — the save is per-MAP, so a failure names no field. The
   * collateral is a cue that comes back for an earlier edit of the same mount that
   * DID land; that one is a nuisance rather than a lie, since the line reports what
   * the last fetch saw and the fetch really does predate the landed write. (The
   * narrower version needs the failure to carry the fields it rolled back, which the
   * map-shaped write API has no way to say.) */
  const [edits, setEdits] = useState<{ rolls: number; keys: Set<string> }>(
    () => ({ rolls: 0, keys: new Set() }),
  );
  const edited: ReadonlySet<string> =
    edits.rolls === rolledBackWrites ? edits.keys : NO_KEYS;
  const patch = (name: string, field: keyof AgentOverride, value: string | string[] | undefined) => {
    if (settings === null) return;
    const key = editedKey(name, field);
    // FUNCTIONAL on purpose: two patches inside one React batch (a click that
    // triggers a write and a sibling write, or a fast double-pick) each get the
    // SAME render-time `edited`, so the object form made the second `setEdits`
    // overwrite the first and LOSE the first key — the suppression then went quiet
    // for a field the user had demonstrably edited. `prev` is the queue's truth.
    // (The stamp reads the `rolledBackWrites` PROP, which an updater cannot reach
    // through `prev`; that half stays render-time, which is correct — a rollback
    // arriving mid-batch belongs to the next render's derivation.)
    setEdits((prev) => ({
      rolls: rolledBackWrites,
      keys: new Set(prev.rolls === rolledBackWrites ? prev.keys : NO_KEYS).add(
        key,
      ),
    }));
    onPatch(withOverride(settings.agentOverrides, name, field, value));
  };

  /** Remove one orphan's entry (ADR 0023's cleanup path). Deleting the KEY, not
   * emptying the entry — `{ ghost: {} }` is an entry that claims to be an
   * override while saying nothing (ADR 0067). */
  const removeOrphan = (name: string) => {
    if (settings === null) return;
    const next: AgentOverrides = { ...settings.agentOverrides };
    delete next[name];
    onPatch(next);
  };

  /**
   * The rows' two reads of the settings document, resolved HERE rather than
   * inside `renderRow` below.
   *
   * Not a style choice: `renderRow` is a callback, and the `settings === null`
   * arm of the ladder beneath it does not narrow a variable captured by one, so
   * the document reads would not typecheck from inside the row. Resolving them
   * up here keeps the guard exactly where it was — the loading arm renders
   * whenever the document is absent, so the row never renders without it — and
   * keeps the fold-lookup's FIRST-match rule verbatim, inline in the map above.
   */
  const views =
    settings === null
      ? []
      : filtered.map((row) => ({
          row,
          // The stored entry, looked up through the ASCII fold: the
          // backend resolves the map's keys case-insensitively, so a
          // hand-edited `"Scout"` for `scout` IS this agent's override
          // — an exact-case lookup would show the "Inherits"
          // placeholder and misrepresent the saved state (the rule the
          // deleted `SubagentSection` was reviewed for). FIRST match,
          // mirroring the backend's `.find`.
          stored: Object.entries(settings.agentOverrides).find(
            ([key]) => foldAscii(key) === foldAscii(row.name),
          )?.[1],
        }));
  // Reachable only while `settings` is `null`, and the loading arm renders in
  // that state, so this `[]` is markup the row never sees — it exists to keep
  // the row's `providers` prop typed, not to be a fallback anyone should rely on.
  const providers = settings?.providers ?? [];

  return (
    <CatalogSearchDialog<(typeof views)[number]>
      open
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      title="Agents"
      searchPlaceholder="Search agents…"
      query={query}
      onQueryChange={setQuery}
      rows={views}
      keyOf={(view) => view.row.path}
      // The scroller's gap is `gap-2` here and `gap-0.5` in the other two: an
      // Agent row is a bordered card with three field lines, not a two-line
      // label, so it needs the wider inter-row air.
      rowGapClassName="gap-2"
      emptyMessage={
        settings === null
          ? // The mount guards on `settings` too; this arm only exists so the
            // dialog can never read `settings.agentOverrides` off `null`.
            "Loading…"
          : rows.length === 0
            ? "No Agent definitions found."
            : filtered.length === 0
              ? `No agents match "${query}".`
              : null
      }
      beforeSearch={
        noSpaceOpen ? (
          // The copy, not a disabled control: the override map is global, so
          // there IS always a correct thing to write. This line only says
          // which definitions the list can see.
          //
          // Rendered ONCE above the rows rather than on every row (the plan's
          // wording is "every row carries the copy"): the sentence is a fact
          // about the LIST — which roots discovery was allowed to read — not
          // about a definition, and repeating it N times would bury the rows
          // under N identical lines for no added truth. Flagged in the task
          // report rather than silently reworded.
          //
          // `beforeSearch`, NOT `children`: this line renders ABOVE the search
          // field. The shell's trailing slot would have moved it below the
          // input, and no test in the repo reads that order.
          <p className="text-ui-sm text-foreground-subtlest">
            No Space open — showing your global Agent definitions
          </p>
        ) : null
      }
      renderRow={(view) => (
        <AgentRow
          row={view.row}
          needle={needle}
          stored={view.stored}
          models={models}
          providers={providers}
          thinkingLevelUnion={thinkingLevelUnion}
          tools={tools}
          edited={edited}
          onPatch={patch}
        />
      )}
    >
      {/* Orphaned overrides — muted rows with a remove button, the shape the
          deleted Settings section used (ADR 0023's only cleanup path). The
          `noSpaceOpen` case renders NOTHING here: see `orphans` above — with no
          Space the list is user-level only, so an override for a project-only
          definition would be labelled stale and armed with this ADR's only
          cleanup button, and the modal has no signal to tell that apart from a
          genuinely dead key. */}
      {orphans.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5 border-t border-border pt-2">
          {orphans.map((name) => (
            <div
              key={name}
              className="flex min-w-0 items-center gap-2 text-ui-sm"
            >
              <span className="min-w-0 flex-1 truncate text-foreground-subtle">
                {name}
              </span>
              <MutedCaption>No longer discovered (stale override)</MutedCaption>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${name} override`}
                onClick={() => removeOrphan(name)}
              >
                <TrashIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </CatalogSearchDialog>
  );
}
