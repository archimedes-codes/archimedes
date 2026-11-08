import { useState } from "react";
import { fuzzyMatch } from "../lib/fuzzy";
import { CatalogSearchDialog } from "./CatalogSearchDialog";
import { RowButton } from "./RowButton";

/**
 * One model row (the caller flattens its data source — the composer's
 * grouped config options or the settings' model catalog). `value` is the
 * value to select (a `""` value is a "no value" row, e.g. "System
 * default"); `name` is the primary display text; `provider` is the
 * secondary cue (the skills dialog's "global" cue pattern); `disabled`
 * rows are shown but not selectable (the stale-override pattern).
 */
export interface ModelPickerItem {
  value: string;
  name: string;
  provider?: string;
  disabled?: boolean;
  /**
   * Shown muted after the provider cue; the caller's explanation for a
   * `disabled` row (or a caveat on an enabled one).
   */
  note?: string;
}

/**
 * A model's provider as the picker row's muted-grey inline cue: the
 * provider's configured `name` (its display name — `tama` → `Tama`); the
 * raw key when the provider is not configured (a model can reference a
 * key absent from the configured list).
 */
function providerDisplayName(
  providers: { id: string; name: string }[],
  key: string,
): string {
  return providers.find((p) => p.id === key)?.name ?? key;
}

/**
 * The two fields of a catalog entry the selectability notice reads, plus the
 * identity fields the row needs. Structural, so `ModelDto` satisfies it and a
 * test's stub can carry only what a row is supposed to render.
 */
export type ModelSelectabilitySource = {
  id: string;
  provider: string;
  selectable?: boolean;
  supportsTools?: boolean;
};

/**
 * The picker row's selectability notice for one catalog entry — THE one
 * derivation of the `disabled` + `note` pair, shared by every surface that lists
 * the live catalog (the session's model option via `SessionConfigBlock`, the
 * Agents modal's per-agent subagent picker via `modelItemsFromModelDtos`).
 *
 * `disabled: m.selectable === false`, NEVER `!m.selectable`: the two differ only
 * when the field is ABSENT, and the absent-field failure mode would be a fully
 * disabled picker. Same "absent is not a claim" rule the engine's reduction
 * adopted when `supports_function_calling` became a tri-state (ADR 0026's
 * 2026-11-08 amendment).
 *
 * The NOTE names WHICH half of the engine's `is_selectable()` failed
 * (`supports_tools` AND a parseable, supported `api`), because the two halves
 * have two different fixes: "no tool support advertised" is the provider's
 * metadata, "unsupported wire" is its API mode. `selectable` alone could only
 * ever offer one sentence.
 *
 * The parameter is the two FIELDS, not `ModelDto`: the gate is about what the
 * wire omits, so the signature has to admit an entry that omits them.
 */
export function modelSelectabilityNotice(model: {
  selectable?: boolean;
  supportsTools?: boolean;
}): Pick<ModelPickerItem, "disabled" | "note"> {
  return {
    disabled: model.selectable === false,
    note:
      model.selectable !== false
        ? undefined
        : model.supportsTools === false
          ? "no tool support advertised"
          : "unsupported wire",
  };
}

/**
 * The picker items for a TYPED model catalog (`ModelDto[]` — the `list_models`
 * payload the live store holds), as opposed to `modelItemsFromCatalog`'s flat
 * `string[]` of composed keys.
 *
 * Same display derivation (name the BARE id, cue the provider's display name,
 * value the full `provider/id` key) PLUS the selectability notice
 * `modelSelectabilityNotice` — which is exactly what the string-shaped function
 * cannot carry, since a key carries no metadata. That loss was issue #9's
 * subagent half: the Agents modal fed `ModelDto[]` through the string mapper and
 * so offered an UNSELECTABLE model as fully usable for a subagent, while the
 * session picker greyed the same row out.
 *
 * `models` is expected PRE-FILTERED by the caller when it wants that (the
 * session picker filters to the configured providers — see
 * `selectModelsByProvider`); this function decorates what it is handed.
 */
export function modelItemsFromModelDtos(
  models: readonly ModelSelectabilitySource[],
  providers: { id: string; name: string }[],
): ModelPickerItem[] {
  return models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    name: model.id,
    provider: providerDisplayName(providers, model.provider),
    ...modelSelectabilityNotice(model),
  }));
}

/**
 * The picker items for a model catalog (the Rust
 * `synthesize_catalog_config_options` shape — flat `{ value: "provider/id" }`
 * entries): the row NAME is the BARE model id (the provider PREFIX is
 * dropped — the provider is already printed as the cue, so keeping the
 * prefix showed it twice: `wizards/Qwen/Qwen3.8-27B (Wizards)`), and the
 * provider cue is the provider's display name (its configured `name` —
 * the raw key when unconfigured). Splitting follows `ModelKey::parse`: the
 * provider id never contains `/`, the MODEL id may, so the FIRST `/` is
 * the boundary. A value without a `/` keeps its name and gets no cue.
 *
 * The VALUE always keeps the full composed key — this is a DISPLAY-only
 * derivation (`settings.defaultModel`, `agentOverrides` and
 * `set_config_option` all still carry `provider/id`).
 */
export function modelItemsFromCatalog(
  values: string[],
  providers: { id: string; name: string }[],
): ModelPickerItem[] {
  return values.map((value) => {
    const slash = value.indexOf("/");
    const providerKey = slash > 0 ? value.slice(0, slash) : "";
    return {
      value,
      name: providerKey === "" ? value : value.slice(slash + 1),
      provider:
        providerKey === ""
          ? undefined
          : providerDisplayName(providers, providerKey),
    };
  });
}

/**
 * The Model picker modal (the skills-dialog pattern): a searchable list
 * of models, ALPHABETICAL (case-insensitive) with a FUZZY search (the
 * `fuzzyMatch` subsequence — `qwen` matches `Qwen3.8`; the query matches
 * the name OR the provider). Clicking a row selects its value and closes
 * the dialog.
 *
 * PROP-DRIVEN: the caller owns the data (the composer's config option /
 * the settings' `listModels` catalog) and the `onSelect` side effect
 * (the `set_config_option` call / the settings save).
 */
export default function ModelPickerDialog({
  open,
  onOpenChange,
  title = "Models",
  items,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  items: ModelPickerItem[];
  onSelect: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // The fuzzy filter: the query is a subsequence of the name, the provider,
  // OR the full `provider/id` VALUE (`oa` finds `openai`'s models;
  // `wizards/q` finds `wizards/Qwen3.8` — the row text is now the BARE id,
  // so only the value carries the joined shape a user may type).
  const matches = (item: ModelPickerItem): boolean =>
    fuzzyMatch(needle, item.name) ||
    fuzzyMatch(needle, item.value) ||
    (item.provider !== undefined && fuzzyMatch(needle, item.provider));
  // Alphabetical (case-insensitive) — the caller's order is ignored.
  const filtered = (
    needle === "" ? items : items.filter(matches)
  ).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const select = (item: ModelPickerItem) => {
    // The guard is now TWO deep: `RowButton` refuses a click/Enter on a
    // `disabled` row, and this is the same check the site spelled before the
    // affordance was extracted. Kept deliberately — `select` is the function
    // that OWNS the side effect (`onSelect` + close), so it must not depend on
    // its only caller having filtered. Deleting either half is safe today and
    // a trap the day a second caller appears.
    if (item.disabled) return;
    onSelect(item.value);
    onOpenChange(false);
  };

  return (
    <CatalogSearchDialog<ModelPickerItem>
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      searchPlaceholder="Search models…"
      query={query}
      onQueryChange={setQuery}
      rows={filtered}
      keyOf={(model) => model.value}
      emptyMessage={
        items.length === 0
          ? "No models found."
          : filtered.length === 0
            ? `No models match "${query}".`
            : null
      }
      renderRow={(model) => (
        // LEFT AS A TEMPLATE LITERAL on purpose (Task C8) — a measured
        // same-group conflict, so this is one of the sites the `cn()`
        // convention deliberately does not reach. The row's base spells
        // `cursor-pointer` and the disabled arm spells
        // `cursor-not-allowed`: ONE tailwind-merge cursor group, so `cn`
        // would DROP `cursor-pointer` and a disabled row would render the
        // not-allowed cursor. Today's concatenation keeps both and lets
        // CSS source order decide, and the compiled stylesheet emits
        // `.cursor-pointer` AFTER `.cursor-not-allowed` — so a disabled
        // row shows a POINTER cursor right now. That is probably not what
        // was intended, but it is what the user sees, and changing it is
        // a behaviour change no test owns: nothing in
        // `ModelPickerDialog.test.tsx` reads a cursor class (the disabled
        // case pins `aria-disabled` and the suppressed click). Converting
        // this site belongs with a decision about which cursor a disabled
        // row should show.
        //
        // Task C4 moved the AFFORDANCE (`role="button"` + `tabIndex` + the
        // Enter handler + the disabled pair) into `RowButton`, and this
        // string survives untouched BECAUSE `RowButton` passes `className`
        // through verbatim rather than merging it — `RowButton.test.tsx`
        // pins that both cursor tokens reach the DOM.
        <RowButton
          disabled={model.disabled}
          onClick={() => select(model)}
          className={`group flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1 hover:bg-surface-hover ${
            model.disabled
              ? "cursor-not-allowed opacity-50"
              : ""
          }`}
        >
          <div className="flex items-center gap-2">
            {/* `min-w-0` lets the span shrink below its content
                width so `truncate` clips it (without it the
                min-width:auto floor would push the row past the
                dialog's right edge). The provider (when known)
                is INLINE, after the name, in muted grey — the
                `Qwen3.8-27B (Tama)` shape. */}
            <span className="min-w-0 flex-1 truncate text-ui-base">
              {model.name}
              {model.provider !== undefined && (
                <span className="text-foreground-subtlest">
                  {" (" + model.provider + ")"}
                </span>
              )}
              {model.note !== undefined && (
                <span className="text-foreground-subtlest">
                  {" (" + model.note + ")"}
                </span>
              )}
            </span>
          </div>
        </RowButton>
      )}
    />
  );
}
