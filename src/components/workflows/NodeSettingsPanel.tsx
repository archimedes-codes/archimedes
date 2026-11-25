import type { ReactElement } from "react";
import { XIcon } from "lucide-react";

import { IpcErrorLine } from "../IpcErrorLine";
import { MutedCaption } from "../MutedCaption";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { useMentionCatalogs } from "../../hooks/useMentionCatalogs";
import { useTasks } from "../../store/tasks";

import { NodeSettingsBody } from "./NodeSettingsBody";
import { WorkflowSettingsBody } from "./WorkflowSettingsBody";

/**
 * The **workflow settings panel** — the right-hand panel the Workflows canvas shows
 * beside the graph: one selected node's settings when a node is selected, and the
 * workflow's own settings when nothing is.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS, AND WHAT IT REFUSES TO BE
 * ---------------------------------------------------------------------------
 *
 * It is the SHELL. It resolves the selection out of the board slice, mounts one of two
 * bodies, renders the store's error line, and owns nothing else. The bodies are their
 * own subjects and their own files:
 *
 *  - `NodeSettingsBody.tsx` — the per-column fields (label, Skill, extra prompt,
 *    Continue-when-finished, destinations, order, delete), with the destination block
 *    in `NodeDestinations.tsx`;
 *  - `WorkflowSettingsBody.tsx` — the two per-Space subjects that never belonged to a
 *    column (`StrictWorkflowToggle`, `AutoChainGuards`) plus the add-a-column field.
 *
 * It holds **only uncommitted draft state, and only inside the body that owns the
 * field**. There is no panel-level `Record<slug, draft>`: the stage dialog this panel
 * replaced held one, keyed by slug, and the record outlived the row it described — so a
 * half-typed label survived the row disappearing and coming back, which is the defect
 * the rule exists to stop. The panel's equivalent of "the row went away" is a different
 * node being selected, and the same rule holds: the draft lives in the body that
 * unmounts.
 *
 * ---------------------------------------------------------------------------
 * NO SECOND OWNER OF THE SAME STATE
 * ---------------------------------------------------------------------------
 *
 * Every read is `useTasks`' board slice; every write is a store action (`renameStage`,
 * `setStageSkill`, `setStageNext`, `setStageAuto`, `setStagePromptPrefix`,
 * `reorderStages`, `deleteStage`, and the per-Space Strict / guard pairs). **No new
 * IPC** — the actions all exist. The store owns the optimistic paint, the whole-slice
 * re-derivation and the revert into `error`; this component owns what a person sees.
 * Two consequences that are visible below:
 *
 *  - the panel reads the column set from the SAME slice the canvas paints, so a panel
 *    and a canvas that disagree about a column are not reachable;
 *  - the error line is the store's `error` cell — the one the canvas and the board
 *    render too. A second error surface would be two answers to "what went wrong", and
 *    every refused write in either body leans on this line to explain itself: a field
 *    that reverts with no sentence beside it is a field that looks broken.
 *
 * THE CATALOG IS NOT FETCHED HERE. `useMentionCatalogs` is module-cached per Space and
 * the canvas/board already mounted it, so this read SHARES that promise instead of
 * issuing a second `listSkills` (spec §8's "not a second fetch"). It is mounted on the
 * SHELL and handed down as a prop, exactly as the stage dialog this panel replaced
 * mounted it once for the whole form rather than once per row: one fetch, N consumers.
 *
 * It lives under `components/` and not `lib/` because it runtime-imports `store/tasks`,
 * and `src/lib/layerBoundary.test.ts` forbids that edge in `lib/`.
 *
 * ---------------------------------------------------------------------------
 * THE THREE ARMS OF A SELECTION, AND WHY THE THIRD IS NOT "NOTHING SELECTED"
 * ---------------------------------------------------------------------------
 *
 *  - a `stageSlug` the slice can answer → **node mode**;
 *  - `stageSlug` `null` / absent → **workflow mode**, which is a real mode and not a
 *    placeholder: clicking empty canvas is how a person reaches the per-Space settings,
 *    so it renders the Strict switch and the guards rather than an empty box;
 *  - a `stageSlug` the slice CANNOT answer → neither, and that is a state the canvas
 *    reaches for real (a column deleted in another window, or a slice that has not
 *    refreshed — the same reason `workflowGraphLayout.ts` draws a ghost node). The panel
 *    says which slug it could not resolve instead of falling back to workflow mode,
 *    because a panel that silently changes subject on a stale selection is how "I
 *    clicked the node and got the Space's settings" happens.
 *
 * ---------------------------------------------------------------------------
 * MOUNTABLE STANDALONE — THE CONTRACT FOR THE WIRING TASK
 * ---------------------------------------------------------------------------
 *
 * `WorkflowsCanvas.tsx` is NOT modified by this task; a later one mounts this panel from
 * it. The contract that makes that mount legal:
 *
 *  - `spacePath: string | null` — pass `activeSpacePath` straight through; `null`
 *    renders NOTHING, so the canvas needs no guard of its own;
 *  - `stageSlug?: string | null` — the selected node's slug or `null`. xyflow's
 *    `onSelectionChange` hands over the selected nodes, so `nodes[0]?.id ?? null` is the
 *    value, and a GHOST node's id is a slug the slice cannot resolve — that is the third
 *    arm above, already handled;
 *  - `onClose?: () => void` — OPTIONAL. The panel renders a Close control ONLY when this
 *    is passed, because deselecting by clicking empty canvas is the primary route and a
 *    panel that always shows a close button next to a canvas that already deselects on
 *    click is two controls for one gesture;
 *  - `className?: string` — the caller's geometry, merged through `cn()`;
 *  - mount it as a SIBLING of the canvas box, not inside the `<ReactFlow>` viewport:
 *    the viewport is a transform surface xyflow measures (the node-box pin in
 *    `workflowGraphLayout.ts` is the same class of coupling), and a field inside it
 *    would be a text input inside a drag surface — the exact defect `WorkflowNodes.tsx`
 *    records as the reason its nodes host no input at all.
 *
 * The panel owns NO open flag. The canvas owns selection and this component reads it, so
 * there is one owner of "what is selected" and the panel cannot disagree with the
 * picture beside it.
 */
export interface NodeSettingsPanelProps {
  /** The **Space** whose workflow is being edited. `null` renders nothing. */
  spacePath: string | null;
  /** The selected node's **slug**, or `null` / absent for workflow mode. */
  stageSlug?: string | null;
  /** Ask the caller to clear the selection. Rendered ONLY when provided — see above. */
  onClose?: () => void;
  /** Per-site geometry (width, border, shadow) merged through `cn()`. */
  className?: string;
}

/** The island frame — ADR 0097's recipe, and this component IS the island now rather
 *  than a pane mounted inside one. The recipe is `MenuPanel`'s and `SidePane`'s, down to
 *  `SidePane.tsx`'s `bg-inspector`: `--color-inspector` is the semantic token for the
 *  RIGHT-HAND PANE ("one plane with the transcript", `styles/ayu.css`). It equals
 *  `--color-chat` in every palette today, so this is not a colour change — it is the
 *  token that says what this surface IS, and it is the token that survives a palette
 *  that ever gives the two panes different values. `basis-80` (320px) is `SidePane`'s
 *  OWN `DEFAULT_WIDTH`, not a number picked here: this pane was `basis-72`, and the
 *  controls transferred from the deleted dialog were sized for a dialog that was wider
 *  than 288px, so a 264px content column packed the guard row onto three lines and made
 *  the whole form read as cramped. Matching the app's other right-hand pane fixes the
 *  width question at the same number the rest of the app already uses.
 *  `min-w-0` is the load-bearing one (the
 *  parent is `App`'s content-row flex ROW, so width is the axis that shrinks) and the
 *  scroller inside is what `overflow-hidden` clips. */
const PANEL_FRAME =
  "relative m-1 flex min-w-0 shrink-0 basis-80 flex-col overflow-hidden rounded-xl bg-inspector";
/** The inset every flanking pane in this app carries. `SidePane` — the reference ADR 0097
 *  points at — wraps its content in `p-3`, and this panel shipped WITHOUT it: the title,
 *  the switches and the `Add column` field all sat flush against the island's rounded
 *  corner, which is what the owner saw. `px-3` on the bands and `p-3` on the scroller so
 *  the gutter is the same 12px on all three edges and a scrolled row still clears the
 *  bottom corner instead of sliding under it. */
const PANEL_INSET_X = "px-3";

/** The scroller. `gap-2` and `overflow-y-auto` are the dialog's inherited pair, so a long
 *  node form scrolls the way the dialog's does instead of pushing the footer off; the
 *  padding is `SidePane`'s, not the dialog's, because this is a pane and not a modal. */
const PANEL_SCROLLER =
  "flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-3 pt-3";
/** The header's subject line. ONE consumer — this file — so it lives here and not in
 *  `settingsStyles.ts`, which states that bar for itself. */
const PANEL_TITLE = "min-w-0 truncate text-ui-base font-medium";

export function NodeSettingsPanel({
  spacePath,
  stageSlug = null,
  onClose,
  className,
}: NodeSettingsPanelProps): ReactElement | null {
  const columns = useTasks((s) =>
    spacePath ? s.boardsBySpace[spacePath] : undefined,
  );
  const error = useTasks((s) => s.error);
  const { skills } = useMentionCatalogs(spacePath);

  // The selection is resolved HERE and not inside a body, because the answer decides
  // WHICH body mounts and a body cannot mount in order to discover it should not have.
  // One `find` per render over a five-to-ten column slice is not worth a `Map`, and a
  // `Map` would be a second copy of the column set the canvas already holds.
  const selected =
    stageSlug === null
      ? undefined
      : columns?.find((c) => c.stage.slug === stageSlug);

  // No Space, no panel — AFTER every hook, which is the only legal place for it. Every
  // write this panel makes addresses a Space, so a mounted panel with no target is a
  // form whose every keystroke goes nowhere.
  if (spacePath === null) return null;

  return (
    <aside
      className={cn(PANEL_FRAME, className)}
      data-testid="workflow-settings-panel"
      // The name says which mode the panel is in, because the two modes have different
      // subjects and a person using the keyboard cannot see the canvas to tell.
      aria-label={
        stageSlug === null ? "Workflow settings" : `Settings for ${stageSlug}`
      }
    >
      <header
        className={cn(
          PANEL_INSET_X,
          "flex min-w-0 shrink-0 items-center gap-2 pb-2 pt-3",
        )}
      >
        <span className={PANEL_TITLE}>
          {/* The title is the SUBJECT, not the word "Settings": in node mode a person
              needs to see WHICH column at a glance, because the panel sits beside a
              canvas of identical boxes. The read-only slug caption is in the body (it is
              the dialog's inherited `stage-slug-<slug>` needle) — the label↔slug
              mismatch is information (`createStage` derives the slug and `renameStage`
              writes the label only) and hiding it would hide the mismatch. An
              unresolvable slug is titled BY that slug, so the sentence in the body and
              the heading agree about which column the panel could not find. */}
          {selected === undefined
            ? stageSlug === null
              ? "Workflow"
              : stageSlug
            : selected.stage.label}
        </span>
        {onClose !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close settings"
            title="Close settings"
            className="ml-auto shrink-0 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </header>

      {/* The store's error cell — the ONE error surface in the panel. */}
      <IpcErrorLine error={error} className={cn(PANEL_INSET_X, "shrink-0")} />

      <div className={PANEL_SCROLLER}>
        {stageSlug === null ? (
          <WorkflowSettingsBody spacePath={spacePath} />
        ) : selected === undefined ? (
          <UnresolvedSelection stageSlug={stageSlug} />
        ) : (
          // `key` on the slug: selecting another node MOUNTS a fresh body rather than
          // re-rendering this one, which is what makes the draft rule hold without any
          // effect to clear it. The stage dialog this panel replaced needed a filter to
          // make a row unmount; here the same rule is one attribute, and it covers the
          // delete picker too —
          // a picker opened on one node cannot survive into another node's panel.
          <NodeSettingsBody
            key={selected.stage.slug}
            stage={selected.stage}
            cardCount={selected.tasks.length}
            spacePath={spacePath}
            skills={skills}
          />
        )}
      </div>
    </aside>
  );
}

/** The third arm: a selection the loaded columns cannot answer. */
function UnresolvedSelection({
  stageSlug,
}: {
  stageSlug: string;
}): ReactElement {
  return (
    <MutedCaption as="p" className="min-w-0" data-testid="selection-unresolved">
      {/* Names the slug it was asked for, and says what it is NOT. Rendering the
          Space's settings here would be the panel changing subject on a stale
          selection — the failure mode the canvas's ghost node exists to avoid. */}
      {`No column named ${stageSlug} in this Space's board, so there is nothing to edit here. The board has probably changed — click empty canvas for the workflow's own settings.`}
    </MutedCaption>
  );
}
