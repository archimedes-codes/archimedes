import type {
  AgentDefinitionReportDto,
  AgentOverride,
  ModelDto,
} from "../../lib/tauri";
import ModelPicker from "../ModelPicker";
import { MutedCaption } from "../MutedCaption";
import { modelItemsFromModelDtos } from "../ModelPickerDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { LayerTag } from "./LayerTag";
import { sourceLabel, storedPinDiff, toolsInheritLabel } from "./agentLabels";
import { PermissionReport } from "./PermissionReport";
import { ShadowReport } from "./ShadowReport";

/**
 * One definition's row: identity + description, then one line per overridable
 * field (its value, the layer that supplied it, and the control), then the
 * shadowing report.
 *
 * NOT a `role="button"` row: unlike `SkillsDialog`'s rows, clicking an Agent row
 * would have nothing honest to do — the definition is addressed by name from the
 * model's `subagent` call, not from this modal.
 */
export function AgentRow({
  row,
  needle,
  stored,
  models,
  providers,
  thinkingLevelUnion,
  tools,
  edited,
  onPatch,
}: {
  row: AgentDefinitionReportDto;
  /** The dialog's search needle — the shadow report is filtered by the SAME
   *  needle the rows use, so it can never contradict the list above it. */
  needle: string;
  /** This definition's stored entry, resolved through the ASCII fold. */
  stored: AgentOverride | undefined;
  models: ModelDto[];
  providers: { id: string; name: string }[];
  thinkingLevelUnion: string[];
  tools: string[];
  /** Which `<name, field>` pairs this dialog has already written — the stored-pin
   *  cue skips those (their difference is explained by the edit). */
  edited: ReadonlySet<string>;
  onPatch: (name: string, field: keyof AgentOverride, value: string | string[] | undefined) => void;
}) {
  // The stale-override rule for the MODEL (the `storedLevelOutsideUnion`
  // pattern): a pinned key no longer in the catalog matches no item, and Radix
  // would then show the placeholder — a false claim about the saved state. Offer
  // it as its own DISABLED item instead (clicking it changes nothing).
  const staleModel =
    stored?.model !== undefined &&
    !models.some((m) => `${m.provider}/${m.id}` === stored.model)
      ? stored.model
      : null;
  // The same rule applied per ROW to the thinking level (the analogue of
  // `SettingsPage`'s `storedLevelOutsideUnion`, which is app-wide): a stored
  // level no model still advertises must render as its own option — keyed on
  // `stored.thinking`, because the picker's job is to show what the user PINNED,
  // not what runs (`row.effective.thinking` is the other column, and the resolver
  // demotes a pin the winning model lacks, so the two differ routinely). Offered
  // DISABLED for the same reason the model above is.
  const staleLevel =
    stored?.thinking !== undefined &&
    stored.thinking !== "" &&
    !thinkingLevelUnion.includes(stored.thinking)
      ? stored.thinking
      : null;
  // The stored-pin disagreement for THIS row (see `storedPinDiff`): the fields
  // where the fetch-time `row.override` column and the entry the pickers are bound
  // to disagree for a reason this modal did not cause. An empty list renders
  // nothing, which is the ordinary case.
  const pinDiff = storedPinDiff(row.name, row.override, stored, edited);

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-ui-base">{row.name}</span>
        {row.scope === "user" && (
          <MutedCaption>global</MutedCaption>
        )}
        <MutedCaption className="min-w-0 flex-1 truncate" title={row.path}>
          {row.path}
        </MutedCaption>
      </div>
      {row.description !== "" && (
        <span
          className="min-w-0 truncate text-ui-sm text-foreground-subtle"
          title={row.description}
        >
          {row.description}
        </span>
      )}

      {/* The stored-pin disagreement (see `storedPinDiff`): one muted line naming
          each field whose STORED value the backend's selector read differently from
          the entry the pickers below are bound to. PLAIN TEXT like the shadowing
          disclosure at the bottom of the row — there is no honest control here (the
          fix is to set the field again from the picker), and a button would promise
          a repair this component cannot perform. */}
      {pinDiff.length > 0 && (
        <MutedCaption className="min-w-0 truncate">
          stored pin the last fetch saw differs — {pinDiff.join(", ")}
        </MutedCaption>
      )}

      {/* MODEL. The three spans are SEPARATE nodes on purpose: the source label
          is the fact ADR 0068 exists to show, so it must be pointable-at rather
          than buried inside a sentence — and the two CONTEXT columns are worded
          `runs …` / `in the file …` so neither of them is the string `override`
          or `file`. A column literally headed `override:` would make any query
          for the `override` SOURCE LABEL trivially true (a test that cannot
          fail); the wording difference is what keeps the pin honest. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
          Model
        </span>
        <MutedCaption className="min-w-0 truncate">
          runs {row.effective.model ?? "—"}
        </MutedCaption>
        <LayerTag>{sourceLabel(row.source.model, "model")}</LayerTag>
        <MutedCaption className="min-w-0 truncate">
          in the file {row.file.model ?? "—"}
        </MutedCaption>
        <ModelPicker
          label={`Model for ${row.name}`}
          value={stored?.model ?? ""}
          placeholder="Inherits"
          items={[
            // The typed catalog, mapped DIRECTLY (issue #9). This used to route
            // through `modelItemsFromCatalog`, which takes `string[]` — so it
            // threw away the `selectable` / `supportsTools` the `ModelDto`s
            // already carried and offered an unselectable model as fully usable
            // for a SUBAGENT, the exact asymmetry the session picker closed.
            // `modelItemsFromModelDtos` keeps that derivation (bare name,
            // provider display-name cue) AND the disabled + note pair. The
            // "Inherits" item stays an `items` entry (NOT a "leading" flag:
            // `ModelPickerDialog` re-sorts items alphabetically by name and
            // DISCARDS caller order, so nothing could lead anywhere). Picking it
            // DELETES the key (ADR 0067).
            ...modelItemsFromModelDtos(models, providers),
            { value: "", name: "Inherits" },
            ...(staleModel !== null
              ? [{ value: staleModel, name: staleModel, disabled: true }]
              : []),
          ]}
          onSelect={(value) =>
            // `""` (the "Inherits" item) maps to `undefined` = DELETE the field.
            onPatch(row.name, "model", value === "" ? undefined : value)
          }
        />
      </div>

      {/* THINKING (the same three-node shape as Model, for the same reason). */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
          Thinking
        </span>
        <MutedCaption className="min-w-0 truncate">
          runs {row.effective.thinking ?? "—"}
        </MutedCaption>
        <LayerTag>{sourceLabel(row.source.thinking, "thinking")}</LayerTag>
        <MutedCaption className="min-w-0 truncate">
          in the file {row.file.thinking ?? "—"}
        </MutedCaption>
        <Select
          value={stored?.thinking ?? ""}
          onValueChange={(value) =>
            onPatch(row.name, "thinking", value === "" ? undefined : value)
          }
        >
          <SelectTrigger aria-label={`Thinking for ${row.name}`} className="w-48">
            <SelectValue placeholder="Inherits" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Inherits</SelectItem>
            {thinkingLevelUnion.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
            {staleLevel !== null && (
              // DISABLED, symmetric with the stale MODEL item: the control already
              // holds this value, so clicking it re-fires `onValueChange` with the
              // same string and rewrites the same level — a control that looks like
              // it does something and only costs a save.
              <SelectItem value={staleLevel} disabled>
                {staleLevel}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* TOOLS (ADR 0067): the empty state is LABELLED, never silent. Unticking
          everything writes NO key — which is "this override does not speak", not
          "no tools" — so the line says so in words. The cluster is rendered in
          BOTH states (nothing ticked is a reachable, editable state, not a
          read-only one); only the sentence above it changes. `subagent` /
          `list_agents` are stripped by the harness at this layer too, and the
          `tools` prop is the harness's own list, so they never appear here. */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
            Tools
          </span>
          {stored?.tools === undefined ? (
            <MutedCaption className="min-w-0 truncate">
              {/* Two spans, not one interpolated sentence: ADR 0067's labelled
                  empty state has to be findable as ITS OWN text (the
                  `Inherits parent tools` string is what the ADR names, and the
                  test — and a screen reader's announcement — should be able to
                  point at it). */}
              <span>file: {(row.file.tools ?? []).join(", ") || "—"}</span>
              <span> · </span>
              <span>{toolsInheritLabel(row.source.tools)}</span>
            </MutedCaption>
          ) : (
            <MutedCaption className="min-w-0 truncate">
              file: {(row.file.tools ?? []).join(", ") || "—"} · runs:{" "}
              {(row.effective.tools ?? []).join(", ") || "—"} (
              {sourceLabel(row.source.tools, "tools")})
            </MutedCaption>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-16">
          {tools.map((name) => (
            <label
              key={name}
              className="flex items-center gap-1.5 text-ui-sm text-foreground"
            >
              <input
                type="checkbox"
                checked={stored?.tools?.includes(name) ?? false}
                // "tick this override", so the label names what the control
                // actually does (the deleted cluster said `Enable tool …`,
                // which reads as the app-wide enabled-tools toggle — a
                // different setting on a different screen).
                aria-label={`Override tool ${name} for ${row.name}`}
                onChange={(e) =>
                  onPatch(
                    row.name,
                    "tools",
                    e.target.checked
                      ? [...(stored?.tools ?? []), name]
                      : (stored?.tools ?? []).filter((t) => t !== name),
                  )
                }
              />
              {name}
            </label>
          ))}
        </div>
      </div>

      {/* The declared `permission:` block (issue #101) — muted PLAIN TEXT under
          the field lines, ABOVE the shadow report.

          Two placement reasons, both deliberate:
          1. It is a REPORT, not a field line. Model/Thinking/Tools are editable
             columns (value + layer + control); a definition's ruleset is authored
             in the markdown FILE and there is no honest control for it here, so it
             takes the shape the shadow report and the stored-pin cue already use.
          2. The shadow report is the row's CLOSING disclosure — name-collision
             meta, always last. Declared policy belongs to the definition, so it
             sits above it. The row's DOM order is NOT reversed to get there.
          Nothing sorts: the block is rendered in the order Rust sent it, because
          opencode resolves a tool's patterns in order and the LAST match governs. */}
      <PermissionReport row={row} />

      {/* The shadowing report (ADR 0065) — muted PLAIN TEXT under the winning
          row: never a `Button`, never `role="row"`, never clickable, because a
          control naming a loser resolves to the WINNER's file (name, not path,
          is a definition's identity). The Skills dialog groups its report at the
          dialog's foot; here it sits under the row, because the Agent row already
          carries the winner's identity and the fact is per-name — the DISCLOSURE
          rule carries over, not the layout. Filtered by the dialog's needle. */}
      <ShadowReport row={row} needle={needle} />
    </div>
  );
}
