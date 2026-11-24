import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
} from "@xyflow/react";
// NO `@xyflow/react/dist/style.css` import here, and do not add one. `src/index.css`
// owns that sheet and its cascade position (its comment argues the placement against the
// palette blocks); this component needs only the CLASS NAMES, which the global sheet
// supplies. The local copy used to sit on this line, Vite deduped it so nothing broke, and
// it made the stylesheet look duplicated to the next reader — who would then delete the
// `index.css` line and silently move the sheet after the palette imports.

import StageEditor from "../StageEditor";
import { EmptyListLine } from "../EmptyListLine";
import { IpcErrorLine } from "../IpcErrorLine";
import { Spinner } from "../ui/spinner";
import { workflowNodeTypes } from "./WorkflowNodes";
import {
  layoutWorkflowGraph,
  type WorkflowFlowNode,
} from "./workflowGraphLayout";
import { useSessions } from "../../store/sessions";
import { useTasks } from "../../store/tasks";

/**
 * The **Workflows** canvas — the graph the Task board's columns form, which is what
 * `App`'s `"workflows"` view renders in place of the chat column and the Side pane.
 *
 * ---------------------------------------------------------------------------
 * IT IS READ-ONLY, AND THAT IS A DECISION AND NOT AN OMISSION
 * ---------------------------------------------------------------------------
 *
 * There is no side panel and no second form. Every field a node shows — the label, the
 * Skill, the extra prompt, the Auto switch, the destinations, the order — is edited by
 * the existing `StageEditor` dialog, which this canvas mounts from its own open flag
 * and reaches on a node click (the same dialog the board's `Configure` door opens, the
 * same store actions, the same eight fields). A second editor would be a second owner
 * of the same eight fields, and this repo argues hard against that.
 *
 * What the canvas therefore owns is the thing a kanban structurally cannot show: which
 * columns are automatic, which Skill each one launches, where the edges actually go,
 * and **where a chain dead-ends**. The dead-end marker is the point of the whole
 * surface — on a board, a column with no destination looks exactly like a column with
 * one, and an auto chain that stops is invisible until a card stops on it.
 *
 * There is also NO drag-to-connect. Edges are already editable through
 * `StageDestinations` inside the dialog, and a new write path is scope the read-only
 * decision removes; it would additionally need a keyboard route, which this repo has
 * none of for a drag (`ChecklistPanel`'s `ChildBoard` header is the precedent such a
 * route would have to follow). `nodesConnectable` is therefore off, and the handles on
 * a node are anchor points for the picture, not controls — but that sentence is only
 * true because BOTH node components forward the flag down to their `<Handle>`s. It
 * reaches a node as the `isConnectable` prop and stops; a `<Handle>` left at its own
 * defaults is connectable, `pointer-events: all` and all. `WorkflowNodes.tsx` carries
 * the three-prop detail and `WorkflowsCanvas.test.tsx` pins each resulting class.
 *
 * A node is also exactly ONE tab stop: `nodesFocusable` is off, so the wrapper xyflow
 * would otherwise put in the tab order is not there and the only stop a node has is its
 * own `<button>`. Left on its default every node cost two, and the first one's Enter
 * selected instead of opening the editor.
 *
 * ---------------------------------------------------------------------------
 * IT LOADS ITS STORE, ON THE SAME SCHEDULE THE BOARD DOES
 * ---------------------------------------------------------------------------
 *
 * `store/tasks.ts`'s `load` had exactly ONE call site before this file —
 * `TasksBoard.tsx`'s mount effect. Verified at the base commit: the literal call form
 * that file uses appears at ONE production site and nowhere else (every other hit is a
 * store test). This file's own call is spelled through `getState()` below, so the
 * census stays one production site plus this one and the comment does not name the
 * pattern it cites — a doc-comment that reproduces a grep needle makes the grep count
 * prose, which is the trap `tauriBoundary.test.ts:24` records. A canvas that only read the slice
 * would render an EMPTY graph on a Space whose board was never mounted, which is the
 * silent-nothing failure this feature has been fighting since issue #185 — the door is
 * on screen, the click works, and the picture is blank. So the canvas calls `load`
 * itself, on mount and whenever the Space changes, exactly as the board does.
 *
 * It is UNCONDITIONAL rather than "only when `boardsBySpace[path]` is `undefined`", for
 * the same reason the board's is: the store's own `loadEpoch` guard already collapses
 * the racing replies, and a view that refuses to re-read shows whatever the last view
 * left behind. `get_board` seeds a Space's default stages on read (ADR 0090's lazy
 * seeding), which is precisely what you want when a person opens a workflow for a Space
 * they have never looked at.
 *
 * THE COST, stated so the next reader weighs it instead of inheriting it: an
 * unconditional mount read means board → workflows → board pays TWO extra `get_board`
 * calls per hop, one per view, and `get_board` is not a pure read — it WRITES, the lazy
 * stage seeding of ADR 0090. So a hop between two views of a Space that has never been
 * seeded performs that write twice, and a hop between two views of one that has performs
 * two reads that can only answer what the other already had. A guard on
 * `boardsBySpace[path] === undefined` would buy both back and would cost the "show
 * whatever the last view left behind" failure the paragraph above names. Neither answer
 * is wrong; this file currently pays the calls, deliberately.
 *
 * ---------------------------------------------------------------------------
 * IT READS THE SELECTED SPACE, NOT A SESSION'S FOLDER
 * ---------------------------------------------------------------------------
 *
 * A Task board is PER-**SPACE** (`CONTEXT.md`) and ADR 0090 keys stages on a `space_path`
 * STRING with no foreign key to a Session, so a Space with no Session running in it is
 * a graph with nodes in it, not a graph out of input. `App`'s comment at the board's
 * render site carries the whole argument (issue #185); the short form is that a
 * per-Session projection cannot key a per-Space view. Hence no Space prop — the canvas
 * reads `activeSpacePath`, the field the Session list and the tab strip already read.
 *
 * ---------------------------------------------------------------------------
 * DRAGGING A NODE ARRANGES THE PICTURE AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * `stages` has no position column, so the layout is derived (see
 * `workflowGraphLayout.ts`'s header for the whole argument). Dragging a node therefore
 * moves it for this view only: the next board write re-derives the layout and the box
 * snaps back. That is stated here rather than hidden because it is the kind of thing a
 * reader would otherwise call a bug — and the alternative, persisting a position, needs
 * a column that does not exist and a second answer to "what is this workflow".
 */
export default function WorkflowsCanvas() {
  // Read BEFORE the `useTasks` selectors below, for the reason `TasksBoard` records: a
  // zustand selector runs synchronously during the render, so one that closed over this
  // name would read it in its temporal dead zone and throw on the first render. A
  // PRIMITIVE selector — an object or array result would re-render forever.
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
  const columns = useTasks((s) =>
    activeSpacePath ? s.boardsBySpace[activeSpacePath] : undefined,
  );
  const loading = useTasks((s) => s.loading);
  const error = useTasks((s) => s.error);

  // The mount fetch, through `getState()` rather than a subscribed action: the canvas
  // needs the ACTION and not a slice, and zustand keeps an action's identity for the
  // life of the store, so subscribing here would re-render the canvas for nothing.
  // The action captures its own failure into `error`, so nothing throws out of here.
  useEffect(() => {
    if (activeSpacePath === null) return;
    void useTasks.getState().load(activeSpacePath);
  }, [activeSpacePath]);

  /** The graph. `undefined` (no Space, or a slice never loaded) is NOT the same state
   *  as an empty array — the empty array is "this Space has no stages" and gets its own
   *  sentence below, so the layout is only run when there is a slice to lay out. */
  const graph = useMemo(
    () => (columns === undefined ? undefined : layoutWorkflowGraph(columns)),
    [columns],
  );

  // xyflow's controlled arrays. Both start EMPTY and are seeded by the effect below,
  // because `graph` can be `undefined` on the first render and the hooks take arrays.
  // `WorkflowFlowNode` and not the bare `Node`: the latter's data is
  // `Record<string, unknown>`, which erases the payload and forces both node components
  // to cast it back — see `workflowGraphLayout.ts`'s `WorkflowFlowNode`.
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Re-derive on every layout change (which means: on every change to the column set).
  // A drag between those moments is deliberately lost — see the header.
  useEffect(() => {
    if (graph === undefined) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  // The **Stage editor**'s open flag, in this view's state for the same reasons
  // `TasksBoard` gives for its own: the dialog needs the board's column set, the column
  // set is already here, and neither survives leaving the view — which is right, because
  // the STAGES are owned by the store and the database, so closing this dialog loses
  // nothing. One owner for the flag: the dialog's `onClose` flips it and nothing else.
  const [stageEditorOpen, setStageEditorOpen] = useState(false);

  /** A node click opens the existing editor.
   *
   *  It opens the SAME dialog for every node, because `StageEditor` takes no
   *  "start at this column" prop — it is a searchable list of all the Space's columns,
   *  and it already holds a filter field for finding one. Adding a focus prop would make
   *  the canvas a second owner of the dialog's own scroll/filter state for a jump the
   *  dialog can already perform.
   *
   *  Bound to xyflow's `onNodeClick` and not to a handler on the node itself, so one
   *  gesture has one owner. That covers the keyboard too: xyflow's node wrapper routes
   *  its own selection keys through the same `onNodeClick`, and the node's body is a
   *  native `<button>`, which activates on Enter and Space without a handler of ours. */
  const openStageEditor = useCallback(() => setStageEditorOpen(true), []);

  return (
    <section
      // ADR 0097's island recipe, taken from `TasksBoard` verbatim: the frame plane is
      // CHROME and every view surface is an ISLAND above it, so the canvas and the board
      // cannot sit at different contrasts against the pane beside them. `min-w-0` is the
      // load-bearing one (the parent is a flex ROW, so width is the main axis) and
      // `overflow-hidden` clips the island's corners — xyflow sizes itself to this box,
      // which is why the box must be a real flex item and not a shrink-to-fit one.
      className="relative m-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-chat"
      data-testid="workflows-canvas"
      aria-label="Workflow graph"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        {/* An `h1` because this surface replaces the whole content row while it is up —
            the same reason the board names itself, and the reason `App.test.tsx`'s
            silent-else pin can ask for it by role. */}
        <h1 className="flex-1 text-ui-base font-medium">Workflows</h1>
      </header>
      {/* The store's error cell, the same one the board and the Stage editor render. A
          second error surface would be two answers to "what went wrong". */}
      <IpcErrorLine error={error} className="shrink-0 px-3 pb-2" />

      {activeSpacePath === null ? (
        <EmptyListLine>
          No Space is open, so there is no workflow to show.
        </EmptyListLine>
      ) : graph === undefined && loading ? (
        // `Spinner` IS the `role="status"` node, so this wrapper adds no second live
        // region — the reason is spelled out at the board's copy of this branch.
        <div className="flex items-center gap-2 p-3">
          <Spinner className="size-4 text-foreground-subtlest" />
          <span className="text-ui-sm text-foreground-subtlest">
            Loading the workflow…
          </span>
        </div>
      ) : graph === undefined ? (
        // Never-loaded is NOT the same state as empty, and after a failed fetch
        // `columns` is still `undefined` — so this line, under the error, must not
        // claim the Space has no stages when the FETCH failed.
        <EmptyListLine>The board has not loaded yet.</EmptyListLine>
      ) : graph.nodes.length === 0 ? (
        <EmptyListLine>This Space has no stages yet.</EmptyListLine>
      ) : (
        // The canvas. The attribution corner is deliberately LEFT IN: `@xyflow/react` is
        // MIT and asks only that the credit stay unless a licence is bought, so hiding it
        // would be a licensing decision made inside a component file. No `proOptions`
        // override is passed, and none should be added to reclaim 20px of corner.
        <div className="min-h-0 flex-1" data-testid="workflows-canvas-viewport">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={workflowNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={openStageEditor}
            // READ-ONLY, in the three ways xyflow exposes: no new edge (the dialog's
            // destination editor owns edges), no removal by keyboard, and no edge
            // selection. Nodes STAY draggable — see the header for what that does and
            // does not do — and they can be draggable because a node hosts no input.
            // `nodesConnectable` reaches the node COMPONENT and stops there: a `<Handle>`
            // defaults to `isConnectable = true`, so it only becomes real because both
            // node components forward it. `nodesFocusable` is off for the same class of
            // reason — left at its `true` default every node wrapper is `tabIndex={0}`
            // and eats a tab stop with a *select* rather than the button's *open*.
            nodesConnectable={false}
            nodesFocusable={false}
            deleteKeyCode={null}
            edgesFocusable={false}
            minZoom={0.2}
            maxZoom={1.75}
          />
        </div>
      )}

      {/* The Stage editor — mounted the way `TasksBoard` mounts it, from this view's
          flag and as a child of the island, because `DialogContent` portals to `body`
          anyway and mounting it here keeps the data it reads (the Space) in scope. Only
          while open: a closed editor would keep a form, a catalog read and a
          `get_board_strict` round trip alive behind the canvas. */}
      {stageEditorOpen && (
        <StageEditor
          spacePath={activeSpacePath}
          onClose={() => setStageEditorOpen(false)}
        />
      )}
    </section>
  );
}
