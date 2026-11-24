import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CSSProperties, ReactElement } from "react";
import { CornerDownRightIcon, SparklesIcon, ZapIcon } from "lucide-react";

import { MutedCaption } from "../MutedCaption";
import { cn } from "../lib/utils";
import {
  MISSING_NODE_TYPE,
  NODE_HEIGHT,
  NODE_WIDTH,
  STAGE_NODE_TYPE,
  type WorkflowMissingFlowNode,
  type WorkflowStageFlowNode,
} from "./workflowGraphLayout";

/**
 * The canvas's TWO node components, and why they are one file: both are presentational
 * boxes with no store, no fetch and no dialog of their own, and the pair is registered
 * into one `nodeTypes` object the canvas hands to `<ReactFlow>`. Splitting them into
 * two files would put the pair on opposite sides of a module boundary that the
 * registration crosses anyway.
 *
 * ## NEITHER NODE HOSTS AN INPUT, AND THAT IS WHY EITHER CAN BE DRAGGABLE
 *
 * `draggable` inherits to children — the hazard `TaskCard.tsx` records for a card, the
 * one `TasksBoard` cites as the reason Stage editing lives behind a dialog rather than
 * on a column header, and the one `StageEditor`'s header repeats for its two text
 * fields. A drag surface that hosts a text input is that defect: the caret and the
 * drag handler are both answering the same mousedown, and the drag wins.
 *
 * These nodes host NO input. There is no label field, no Skill picker, no extra-prompt
 * `<textarea>`, no Auto switch and no destination editor on a node — every one of those
 * eight fields is edited by the existing `StageEditor` dialog, which the canvas opens
 * on a node click. That decision is what makes a draggable node legal here at all, and
 * it is the reason the canvas ships no second form. A future executor tempted to put a
 * field on a node is re-opening that defect; the answer is the dialog.
 *
 * The one interactive element a node does hold is a `<button>`, and a button is not the
 * hazard above: nothing types into it, and its activation is a click like any other
 * click on the node — the same handler, the same dialog. It is a `<button>` rather than
 * a `<div role="button">` precisely so it needs NO key handler: a native button
 * activates on Enter and Space on its own, so the `ChecklistPanel` precedent (a
 * non-native control spelling those two keys plus `preventDefault` by hand) is not
 * wanted here — copying it would be re-implementing the platform.
 *
 * ## The badges are the column's REAL state, read off the row
 *
 * Nothing here derives or guesses. `onEnterSkill`, `auto` and `promptPrefix` arrive on
 * the `StageDto` the board already paints, and the dead-end marker arrives as a
 * computed boolean from the layout (it is "this column produced no edge", which is a
 * graph fact and not a column fact). An absent Skill renders NOTHING rather than a
 * placeholder: a badge that says "no Skill" on every column of a board that predates
 * the feature would be noise wearing the same weight as the signal.
 */

/** The shared box's CLASSES. Its SIZE is not here — see `NODE_BOX_STYLE`.
 *
 *  `nodrag` is xyflow's own escape hatch and is deliberately NOT on the button: the
 *  button lives inside the drag surface and a click that never moved is a click, which
 *  is the behaviour we want to keep. */
const NODE_BOX =
  "rounded-xl border border-border bg-card px-3 py-2 text-left shadow-sm";

/** The shared box's SIZE, and the reason it is inline rather than a class.
 *
 *  `workflowGraphLayout.ts` tells dagre that every node occupies `NODE_WIDTH` ×
 *  `NODE_HEIGHT`, and dagre's rank separation is measured between THOSE boxes — so the
 *  element has to be exactly that, or a long label pushes the node past the rank beside
 *  it and the layout's stated invariant is simply false. It cannot be a Tailwind
 *  `w-[240px]`/`h-[104]` pair, because that spells the two numbers a second time and
 *  lets them drift from the constants; and `w-full`/`h-full` does not pin anything at
 *  all: xyflow's node wrapper is `position: absolute` with no width of its own, so
 *  `w-full` resolves against a shrink-to-fit parent, the box sizes to max-content, the
 *  label's `truncate` never engages, and a label over ~28 characters overruns the 240
 *  the layout reserved. Importing the constants and writing them inline is what keeps
 *  the two answers from drifting, and `WorkflowsCanvas.test.tsx` reads the inline style
 *  so a restyle reddens. */
const NODE_BOX_STYLE: CSSProperties = { width: NODE_WIDTH, height: NODE_HEIGHT };

/** The three `<Handle>` props that make a handle an ANCHOR and not a CONTROL, for one
 *  node's `isConnectable`. Spread onto every handle on both node types — see
 *  `WorkflowStageNode`'s header for why one prop is not the whole decision. */
const handleAnchorProps = (isConnectable: boolean) => ({
  isConnectable,
  isConnectableStart: isConnectable,
  isConnectableEnd: isConnectable,
});

/** One badge's GEOMETRY. The caption pair it used to carry is NOT here: the
 *  `mutedCaption.test.ts` census refuses a second file spelling
 *  `text-ui-xs text-foreground-subtlest`, and its stated reading of an offender is
 *  "this file should have rendered a `MutedCaption` instead" — which is exactly right
 *  here, so the component owns the pair and this constant owns only the chip's box.
 *  A badge's `title` carries the meaning a glyph alone does not. */
const BADGE =
  "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5";

/** One column of the workflow, as a node.
 *
 *  The whole body is the `<button>` described above, and it carries NO `onClick` of its
 *  own: the click bubbles to xyflow's node wrapper, which calls `onNodeClick`, which is
 *  where the canvas opens `StageEditor`. Two handlers on one gesture would be two owners
 *  of "open the editor for this column", and the wrapper's is the one xyflow documents.
 *
 *  `isConnectable` is a PROP and not a global. `nodesConnectable` on `<ReactFlow>` lands
 *  on the node component as `isConnectable`; it does NOT reach a `<Handle>`, whose own
 *  default is `true`. A node component that ignores the prop therefore ships connectable
 *  handles — the hover ring, `pointer-events: all`, the whole control — on a canvas that
 *  has no drag-to-connect, which is the single most common `@xyflow/react` surprise.
 *
 *  Forwarding that ONE prop is NOT enough, which is why all three appear on every handle
 *  below. `<Handle>` reads three, each defaulting to `true` on its own: `isConnectable`
 *  (the `connectable` class), `isConnectableStart` (the `connectablestart` class AND the
 *  gate on the pointer-down that starts a connection) and `isConnectableEnd` (the
 *  `connectableend` class and whether the handle counts as a target for a connection in
 *  flight); the `connectionindicator` hover ring is a function of all three. Measured on
 *  the installed @xyflow/react@13.0.3: with only `isConnectable` forwarded, the handles
 *  still carry `connectablestart`/`connectableend`. One canvas-level decision, three
 *  props — and `WorkflowsCanvas.test.tsx` pins each class individually. */
export function WorkflowStageNode({
  data,
  isConnectable,
}: NodeProps<WorkflowStageFlowNode>): ReactElement {
  const { slug, label, onEnterSkill, auto, promptPrefix, taskCount, deadEnd, nextLabels } =
    data;
  return (
    <div
      className="relative"
      // The test id names the SUBJECT rather than the widget: a case about "the doing
      // column is marked automatic" should not care which element inside the node wears
      // the mark.
      data-testid={`workflow-node-${slug}`}
    >
      {/* The two handles are xyflow's anchor points, not controls. An edge needs
          somewhere to land and a node without one renders no edge at all, so they exist;
          `isConnectable` is what keeps them anchors and not controls. */}
      <Handle
        type="target"
        position={Position.Left}
        {...handleAnchorProps(isConnectable)}
      />
      <button
        type="button"
        style={NODE_BOX_STYLE}
        className={cn(
          NODE_BOX,
          // The one thing a person cannot see on a kanban gets the loudest mark on the
          // node: this is where an auto chain STOPS.
          deadEnd && "border-warning",
        )}
        // The accessible name says what the badges say visually, in the order a person
        // reads them, and includes the destinations — a node's outgoing edges are
        // invisible to anything that is not the picture.
        aria-label={`Column ${label}. ${auto ? "Auto-advance on. " : ""}${
          onEnterSkill === null ? "No skill. " : `Skill ${onEnterSkill}. `
        }${
          promptPrefix === null ? "" : "Has an extra prompt. "
        }${taskCount === 0 ? "No cards. " : `${taskCount} cards. `}${
          deadEnd
            ? "Leads nowhere — the chain stops here."
            : `Leads to ${nextLabels.join(", ")}.`
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
            {label}
          </span>
          <MutedCaption className="shrink-0 tabular-nums">{taskCount}</MutedCaption>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {auto && (
            <MutedCaption
              className={cn(BADGE, "border-warning text-warning")}
              title="A card launched on this column advances itself when its Session settles"
              data-testid={`workflow-node-auto-${slug}`}
            >
              <ZapIcon className="size-3" />
              Auto
            </MutedCaption>
          )}
          {onEnterSkill !== null && (
            <MutedCaption
              className={BADGE}
              title="The Skill a Session started from this column loads"
              data-testid={`workflow-node-skill-${slug}`}
            >
              <SparklesIcon className="size-3" />
              {onEnterSkill}
            </MutedCaption>
          )}
          {promptPrefix !== null && (
            <MutedCaption
              // The badge is a MARKER and not the text: a column's extra prompt can be
              // a paragraph, and a paragraph on a node would decide the node's height,
              // which the layout does not know about. The full text is in the dialog.
              className={BADGE}
              title="This column prepends an extra prompt before its Skill"
              data-testid={`workflow-node-prompt-${slug}`}
            >
              Extra prompt
            </MutedCaption>
          )}
          {deadEnd && (
            <MutedCaption
              className={cn(BADGE, "border-warning text-warning")}
              title="No destination: a card that lands here stays here"
              data-testid={`workflow-node-dead-end-${slug}`}
            >
              <CornerDownRightIcon className="size-3" />
              Leads nowhere
            </MutedCaption>
          )}
        </span>
      </button>
      <Handle
        type="source"
        position={Position.Right}
        {...handleAnchorProps(isConnectable)}
      />
    </div>
  );
}

/** An edge's target that the loaded slice cannot name.
 *
 *  Deliberately NOT a `WorkflowStageNode` with empty fields: a column that is not in the
 *  read has no label, no Skill and no auto flag, and printing those three as absent
 *  would claim the canvas knows the column is unconfigured when all it knows is that it
 *  cannot see the row. So this node says one thing — the slug, and that it is missing.
 */
export function WorkflowMissingNode({
  data,
  isConnectable,
}: NodeProps<WorkflowMissingFlowNode>): ReactElement {
  const { slug } = data;
  return (
    <div
      className="rounded-xl border border-dashed border-warning px-3 py-2 text-ui-sm text-foreground-subtlest"
      style={NODE_BOX_STYLE}
      data-testid={`workflow-node-missing-${slug}`}
      // Not a `<button>`: there is nothing to open. A destination with no column has no
      // row for `StageEditor` to edit, and a control that opens nothing is the
      // dead-button shape this repo refuses.
      aria-label={`Destination "${slug}" is not a column of this board`}
    >
      <span className="block truncate">{slug}</span>
      <MutedCaption as="span" className="mt-1 block">
        No such column
      </MutedCaption>
      <Handle
        type="target"
        position={Position.Left}
        {...handleAnchorProps(isConnectable)}
      />
    </div>
  );
}

/** The registry `<ReactFlow>` matches a node's `type` against.
 *
 *  Module scope, and it must stay there: xyflow documents that a `nodeTypes` object
 *  rebuilt on every render remounts every node, which on a live board would drop the
 *  pan/zoom state on each store write. */
export const workflowNodeTypes = {
  [STAGE_NODE_TYPE]: WorkflowStageNode,
  [MISSING_NODE_TYPE]: WorkflowMissingNode,
};
