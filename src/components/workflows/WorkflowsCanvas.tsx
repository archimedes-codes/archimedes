import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Wand2Icon } from "lucide-react";
import {
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from "@xyflow/react";
// NO `@xyflow/react/dist/style.css` import here, and do not add one. `src/index.css`
// owns that sheet and its cascade position (its comment argues the placement against the
// palette blocks); this component needs only the CLASS NAMES, which the global sheet
// supplies. The local copy used to sit on this line, Vite deduped it so nothing broke, and
// it made the stylesheet look duplicated to the next reader — who would then delete the
// `index.css` line and silently move the sheet after the palette imports.

import { EmptyListLine } from "../EmptyListLine";
import { IpcErrorLine } from "../IpcErrorLine";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { workflowNodeTypes } from "./WorkflowNodes";
import { NodeSettingsPanel } from "./NodeSettingsPanel";
import {
  layoutWorkflowGraph,
  storedPositionOf,
  type WorkflowFlowNode,
} from "./workflowGraphLayout";
import {
  canConnectStages,
  nextOutcomesAfterConnect,
  nextSlugsAfterConnect,
} from "../../lib/workflowEdgeWrite";
import { useSessions } from "../../store/sessions";
import { useTasks } from "../../store/tasks";
import { useTaskBoardAutoRefresh } from "../../hooks/useTaskBoardAutoRefresh";

/**
 * The **Workflows editor** — the graph the Task board's columns form, which is what
 * `App`'s `"workflows"` view renders in place of the chat column and the Side pane.
 *
 * ---------------------------------------------------------------------------
 * IT IS AN EDITOR, AND THIS HEADER USED TO ARGUE THAT IT WAS NOT
 * ---------------------------------------------------------------------------
 *
 * The page this replaced was titled "IT IS READ-ONLY, AND THAT IS A DECISION AND NOT AN
 * OMISSION", and every sentence under it was a reason not to put a control on the
 * canvas: a second editor would be a second owner of the same eight fields, a drag needs
 * a keyboard route the repo does not have, and positions could not persist because no
 * column existed to hold them. Three things happened since, and they took the argument
 * one at a time:
 *
 *  - `NodeSettingsPanel.tsx` became the **sole owner** of those eight fields (the dialog
 *    this header pointed at is being retired by the next task), so the panel beside the
 *    graph is not a second owner — it is the only one;
 *  - `stages` gained `position_x` / `position_y`, so a dragged node has somewhere to
 *    live;
 *  - and `NodeDestinations` inside the panel turned the destination write into a
 *    `Select` and a keyboard, which is the answer the header said it needed before it
 *    would allow a drag.
 *
 * What is left is the editor. The rest of this file says what each surface owns.
 *
 * ---------------------------------------------------------------------------
 * SELECTION IS XYFLOW'S, AND THE PANEL READS IT
 * ---------------------------------------------------------------------------
 *
 * The canvas keeps NO notion of "the selected node" of its own beyond a copy of what
 * xyflow reports through `onSelectionChange`, and that copy is write-only in one
 * direction: it is never handed back to decide what is highlighted. Two owners of "what
 * is selected" is how a panel and a picture disagree about the same click.
 *
 * So the panel's `stageSlug` is `selectedNodes[0]?.id ?? null`, and the two modes fall
 * out of it: a node's slug → the node's settings; nothing selected → the workflow's own
 * settings, which is what clicking empty canvas is FOR (`resetSelectedElements` runs on
 * a pane click inside xyflow; the canvas adds no handler to compete with it). A ghost
 * node's id is a slug the slice cannot name, and the panel says so instead of changing
 * subject — its third arm.
 *
 * The re-derivation effect below PRESERVES the selection when it rebuilds the node
 * array, and that is load-bearing rather than tidy: a panel write (a rename, the Auto
 * switch) repaints the board slice, which re-runs the layout, which hands xyflow a fresh
 * array. Rebuilt without the flag, the person's keystroke would deselect the node they
 * were typing about and swap the panel to the Space's settings under them.
 *
 * THE ONE TAB STOP, updated for what ships now. `nodesFocusable` is still off, so the
 * wrapper xyflow would otherwise put in the tab order is not there and each node has
 * exactly one stop: its own `<button>`. That stop still does something real — the
 * wrapper routes the button's click through `onNodeClick`, and a click is what selects,
 * so **Enter on a focused node opens its settings in the panel**. Left on its default
 * every node cost two stops and the first one's Enter did the same thing as the second,
 * which is a wrapper paying for nothing. What the wrapper's keys would have added —
 * arrow-key nudging of a selected node — is NOT lost, it is just not the only route:
 * arrow keys move a node without ever calling `onNodeDragStop`, so they move it for the
 * view and not for the database, i.e. the snap-back. Dragging is the verb that persists.
 *
 * THE KEYBOARD GAP, NARROWED — and what is left is named rather than papered over.
 *
 *  Leaving node mode BY KEYBOARD is shipped: `Escape` inside the viewport calls the same
 *  `clearSelection` the panel's Close control calls, and it hands focus back to the node
 *  that opened the panel (see `clearSelection` — without the restore, Escape is a route
 *  that drops the person on `<body>` and loses their place in the graph). Reaching node
 *  mode was always possible by keyboard — Tab lands on a node's `<button>`, Enter selects
 *  — so open-and-close is now a round trip. That closes what this paragraph used to state
 *  in the present tense as an unfixable gap; `known-gaps` §10c carries the same amendment
 *  and the three reasons the fix is spelled the way it is (the handler sits on the viewport
 *  `<div>` and NOT on `document`, so Escape in a panel field still means what it means
 *  everywhere else; it could not reuse xyflow's own Escape handling, because that means
 *  `nodesFocusable` back on and the focused wrapper is exactly the non-persisting arrow-key
 *  mover below).
 *
 *  What REMAINS pointer-only, and is the actual residual gap: the POSITION verb, and the
 *  edge DELETE. Dragging is the only thing that calls `onNodeDragStop`, and `deleteKeyCode`
 *  is `null` with `edgesFocusable` off, so an edge goes away through the panel's destination
 *  list rather than by selecting the edge. The panel is a real mitigation for edges and there
 *  is none for positions — that half is filed in §10c with the shape of a fix.
 *
 *  The panel's Close control is still passed ONLY while a node is selected. Escape made it
 *  redundant, not wrong: in workflow mode it would be a button that clears an already-empty
 *  selection, and a dead control is the shape this repo refuses, so the control exists
 *  exactly when it has a subject.
 *
 * ---------------------------------------------------------------------------
 * TWO WRITES LIVE ON THE PICTURE ITSELF, AND BOTH GO THROUGH THE STORE
 * ---------------------------------------------------------------------------
 *
 *  - **Drag-to-connect.** `onConnect` writes through `store/tasks`' `setStageNext`, and
 *    the rule — the three-state `next_slugs` rule, the self-loop refusal, the
 *    already-there refusal, and the refused no-op that would only re-draw the fallback —
 *    is `lib/workflowEdgeWrite.ts`, the SAME module the panel calls. Name the caller
 *    exactly, because the obvious one is the wrong file: the `Select` WIDGET is
 *    `NodeDestinations.tsx` and it holds NO rule — it takes `onAdd`/`onWrite` as props —
 *    and the rule call lives one level up in `NodeSettingsBody.tsx`, which is the file
 *    that holds the loaded slice. So the drag is a pointer convenience for an edge the
 *    panel can make and remove by keyboard, which is the honest resolution of the
 *    objection this header used to raise rather than a silent dropping of it. The refusal
 *    is handed to `isValidConnection` as well as to the handler, so a self-loop reads as
 *    refused WHILE THE LINE IS STILL DOWN instead of failing after the drop.
 *    `nodesConnectable` is on, and it only becomes real because both node components
 *    forward `isConnectable` into all three of a `<Handle>`'s connectability props —
 *    `WorkflowNodes.tsx` carries that detail and the canvas test pins each class.
 *  - **Drag-to-position.** `onNodeDragStop` writes through `setStagePosition`. The store
 *    is the authority (see `workflowGraphLayout.ts`'s header), the drag paints
 *    optimistically, and the layout re-derives to the number it was just given — so the
 *    node stays where it was dropped. **Tidy up** is the other half of that: without a
 *    way back to dagre, a hand-arranged graph can never be un-arranged.
 *
 * Neither write touches xyflow's own arrays. The store echoes, `graph` re-derives, and
 * the effect hands xyflow the answer — one direction, always.
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
 * THE ERROR LINE IS THE PANEL'S, WITH ONE EXCEPTION
 * ---------------------------------------------------------------------------
 *
 * The store's `error` cell has one renderer in this view: `NodeSettingsPanel`, which
 * mounts it in both of its modes. This file renders it ONLY when there is no Space at
 * all, because that is the one state where the panel renders nothing and the cell would
 * otherwise be invisible — a failed write whose sentence is off-screen is a control that
 * looks broken. Two lines for one cell would be two answers to "what went wrong", which
 * is the reason both files' headers have been arguing about this since they were
 * written. It sits in the CANVAS island's own column, at the top, because that is the
 * island that survives a Spaceless render: the panel is not mounted there at all, so a
 * line parked in the panel would be parked on nothing.
 *
 * ---------------------------------------------------------------------------
 * TWO ISLANDS, NOT ONE ISLAND WITH A PANE NESTED IN IT (ADR 0097)
 * ---------------------------------------------------------------------------
 *
 * This file used to return ONE `<section>` whose flex row held the picture and the
 * panel. The panel wore `m-1 rounded-xl` — the island recipe — INSIDE an island, so its
 * 4px gap was an inset, its corners were clipped by the parent's `overflow-hidden`, and
 * what read on screen was a flat, divider-separated strip: the exact defect ADR 0097 was
 * written to end ("Adding a third pane to the content row without `m-1 rounded-xl` is
 * the same defect this decision was made to fix"). It now returns TWO SIBLINGS and
 * `App`'s content row is their flex parent, exactly as it is the parent of `SidePane`.
 * The divider went with the nesting: a border between two surfaces that no longer touch
 * is a line describing a seam that no longer exists.
 *
 * ---------------------------------------------------------------------------
 * THE GRAPH PLANE IS THAMED, NOT PAINTED OVER
 * ---------------------------------------------------------------------------
 *
 * `src/index.css` imports `@xyflow/react/dist/style.css` and that sheet is a COMPONENT
 * sheet: it ships in `@layer xyflow`, which the compiled stylesheet emits AFTER
 * `@layer utilities`, so its rules out-rank the app's own utilities at equal
 * specificity. It also defaults its own plane to a near-black `--xy-background-color`
 * that has nothing to do with any palette. Fighting that with class selectors would
 * mean `!important` or a new block in `src/styles/`, and the second is refused outright
 * by `paletteCompleteness.test.ts`'s layer gate. So the theme is written as the values
 * xyflow's own sheet asks for — its rules read `var(--xy-*, var(--xy-*-default))`, so
 * setting the custom property IS the sheet's documented override point, and a custom
 * property set on the wrapper needs no specificity argument at all.
 *
 * Every value below is a palette token and never a hex, so the graph follows the palette
 * the person picked (`--color-chat` is a different colour in all seven Palettes and in
 * both readings of each). Two of them are the same argument the app already makes about
 * the wires it draws: `--color-workflow-trace` / `-trace-strong` are the tokens
 * `theme.css` declares for a workflow wire and its emphasised wire. They are ALPHA
 * overlays (`.dark` reads `color-mix(… var(--color-white) 35% / 60%, transparent)`) and
 * every non-default Palette INHERITS them rather than re-huing them, so they land as a
 * step above whatever plane they are painted on — which is what keeps the stored edge and
 * the INFERRED edge two different marks on every palette rather than two greys xyflow
 * invented (measured on Dracula's `#282a36`: 3.10 and 6.14 against the plane, 1.98 apart
 * from each other; xyflow's own default edge reaches only 1.72 on its own default plane).
 */

/** The graph's palette, written as the properties xyflow's own sheet reads.
 *
 *  One static string, applied to `<ReactFlow className>` — which lands on the root
 *  `.react-flow` element, the element that declares every `--xy-*-default` and the
 *  ancestor every one of those rules matches on. A static string and not `cn()`:
 *  xyflow builds that class list with `classcat`, not tailwind-merge, so there is no
 *  base for a merge to reconcile and nothing to conflict with.
 *
 *  THE ORDER OF THE TWO EDGE ENTRIES IS LOAD-BEARING. Both set the same property on the
 *  same element for different subjects — the wrapper for every edge, the implicit class
 *  for the inferred ones — and the descendant selector the class form compiles to
 *  (`[&_.workflow-edge-implicit]` → `.wrapper .workflow-edge-implicit`) is one class
 *  deeper than the plain property on the wrapper, so the inherited value loses to it on
 *  the marked edge whatever the source order. The dash stays too: two marks are cheaper
 *  to tell apart than one.
 *
 *  `--xy-attribution-background-color` is an OVERLAY token (`--color-surface` is a 5%
 *  alpha wash) and not a fill, on the reason `lib/slabFloatSeparation.test.ts` records:
 *  a float painted with a surface token measures 1.00 against the surface it floats on,
 *  and the badge is a float on the plane it sits on. The link is themed by a utility
 *  with `!` on purpose — xyflow hardcodes `color: #999` for it, and that rule is in
 *  `@layer xyflow`, which compiles after `@layer utilities`, so an unqualified utility
 *  loses to it.
 *
 *  ⚠️ The `\\_` in the attribution selector is not a typo and not decoration. Tailwind
 *  reads a bare `_` inside an arbitrary variant as a SPACE — measured,
 *  `[class~='react-flow__attribution']` compiles to `[class~="react-flow  attribution"]`
 *  and matches nothing. An escaped `\_` survives into the selector as the literal `_`
 *  the class actually contains.
 */
const CANVAS_THEME =
  // THE GRAPH PLANE IS THE ISLAND'S OWN PLANE. Two wrong answers were tried before this
  // one, and both are recorded here because each looks right from a different angle.
  //
  //   1. xyflow's default — a near-black `--xy-background-color` that covered the island
  //      entirely. That was the original defect.
  //   2. `--color-panel`, on the argument that a node is `bg-card` and card-on-chat is a
  //      weak step (1.21 in Dracula), so the plane should be the RECESSED rung the Task
  //      board's columns use. WRONG, and worse than the problem it solved: `--color-panel`
  //      is byte-identical to `--color-frame` in 6 of the 13 readings — Dracula, both Ayu,
  //      both Kanagawa, Catppuccin dark — and ADR 0097 states that `bg-frame` means CHROME
  //      and chrome is exactly two surfaces, the titlebar and the Session list. Painting the
  //      graph with it makes the whole view read as background rather than surface, which is
  //      the defect issue #173 exists to prevent. A recessed well works for a COLUMN because
  //      it is a small inset INSIDE a lighter island with gaps of island colour between the
  //      columns; full-bleed it is just chrome with rounded corners.
  //
  // So the plane is `--color-chat` and the node's separation is carried the way ADR 0096
  // says a collapsed step must be carried: by its BORDER, not by the plane under it. That
  // is why `NODE_BOX` wears `border-card-border` (it was on the loud app-wide
  // `--color-border`, which is what a weak plane pushes you toward).
  "[--xy-background-color:var(--color-chat)]" +
  " [--xy-edge-stroke:var(--color-workflow-trace-strong)]" +
  " [--xy-edge-stroke-selected:var(--color-foreground)]" +
  " [--xy-connectionline-stroke:var(--color-workflow-trace-strong)]" +
  " [--xy-handle-background-color:var(--color-foreground-subtle)]" +
  " [--xy-handle-border-color:var(--color-card)]" +
  " [--xy-attribution-background-color:var(--color-surface)]" +
  " [&_.workflow-edge-implicit]:[--xy-edge-stroke:var(--color-workflow-trace)]" +
  " [&_.react-flow\\_\\_attribution_a]:text-foreground-subtlest!";

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
  // The two writes the picture makes, taken as ACTIONS and not as slices: zustand keeps
  // an action's identity for the life of the store, so subscribing to one re-renders the
  // canvas for nothing. Both own the optimistic paint, the whole-slice re-derivation and
  // the revert into `error`, and both rethrow on a refusal.
  const setStageNext = useTasks((s) => s.setStageNext);
  const setStagePosition = useTasks((s) => s.setStagePosition);

  // The mount fetch, through `getState()` rather than a subscribed action: the canvas
  // needs the ACTION and not a slice, and zustand keeps an action's identity for the
  // life of the store, so subscribing here would re-render the canvas for nothing.
  // The action captures its own failure into `error`, so nothing throws out of here.
  useEffect(() => {
    if (activeSpacePath === null) return;
    void useTasks.getState().load(activeSpacePath);
  }, [activeSpacePath]);

  // The canvas shows the same `boardsBySpace` slice the board does — including each
  // column's CARD COUNT — so it takes the same re-read on a turn settle. Without this
  // the canvas would be the one surface where a model-written card stayed invisible
  // until a remount, and its node labels are the fact that would go stale.
  useTaskBoardAutoRefresh(activeSpacePath);

  /** The graph. `undefined` (no Space, or a slice never loaded) is NOT the same state
   *  as an empty array — the empty array is "this Space has no columns" and gets its own
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
  /** The selected node's slug, COPIED out of xyflow's selection for the panel and for
   *  nothing else. `null` is workflow mode, and it is also what an empty selection
   *  reports, so the two are the same state rather than two claims. */
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // Re-derive on every layout change (which means: on every change to the column set,
  // and on every stored position). The selection is carried across the rebuild — see the
  // header for the keystroke that would otherwise be eaten.
  useEffect(() => {
    if (graph === undefined) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes((previous) => {
      const selected = new Set(
        previous.filter((node) => node.selected).map((node) => node.id),
      );
      return graph.nodes.map((node) =>
        selected.has(node.id) ? { ...node, selected: true } : node,
      );
    });
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  /** xyflow's own selection, read once per change. Stable so the listener xyflow
   *  registers for it is not torn down and re-added on every render. */
  const onSelectionChange = useCallback(
    ({ nodes: selected }: { nodes: WorkflowFlowNode[] }): void => {
      setSelectedSlug(selected[0]?.id ?? null);
    },
    [],
  );

  /** Clear the selection, which is the panel's Close doing the one thing it can do.
   *  Spelled on the controlled array's `selected` flag — xyflow's own representation —
   *  rather than on a canvas-side flag that would be a second owner of the fact.
   *
   *  It also HANDS THE FOCUS BACK, and that belongs HERE rather than at either call
   *  site: `Close` and Escape are one gesture with one effect, and a restore bolted to
   *  the keydown handler would leave the pointer route dropping focus into `<body>` —
   *  and the pointer user who then presses Tab is a keyboard user for that keystroke.
   *
   *  The focus happens BEFORE the re-render it triggers, not after, and that ordering is
   *  the whole mechanism. `setNodes` only queues; the panel is still in the DOM for the
   *  rest of this tick, and it is the panel's OWN control that holds focus on the Close
   *  route. Moving focus to the node first means the panel unmounts with nothing focused
   *  inside it — focus the node instead, and the unmount has no focused descendant left
   *  to destroy. Focusing after the commit would be undone by that very unmount.
   *
   *  The selector targets the node's `<button>` and not the `workflow-node-*` div: the
   *  div is the subject the test id names, the button is the thing actually in the tab
   *  order (`nodesFocusable` is off, so the wrapper is not a stop). Putting focus on an
   *  element Tab cannot reach is the same as not restoring it. The `?.` is not decoration
   *  — a column deleted while its panel was open has no node to return to, and the choice
   *  then is a silent no-op or a TypeError in a click handler. */
  const clearSelection = useCallback((): void => {
    // Read the subject BEFORE the write: this is the column whose panel is closing,
    // and it is the only place the two halves of the gesture agree on it.
    const opened = selectedSlug;
    setNodes((previous) =>
      previous.some((node) => node.selected)
        ? previous.map((node) =>
            node.selected ? { ...node, selected: false } : node,
          )
        : previous,
    );
    if (opened !== null) {
      // `HTMLElement` and not the default `Element`: `Element` has no `focus()`, and
      // `tsc` says so. A `<button>` is the widest thing the selector can match.
      document
        .querySelector<HTMLElement>(
          `[data-testid="workflow-node-${opened}"] button`,
        )
        ?.focus();
    }
  }, [setNodes, selectedSlug]);

  /** Escape inside the viewport is the keyboard's route from node mode back to
   *  workflow mode, and it calls the SAME `clearSelection` the panel's Close control
   *  calls — one owner of the gesture's effect, spelled on xyflow's own `selected`
   *  flag. It writes NOTHING: deselecting is a view change, and the verb that persists
   *  a column is the panel's, not the canvas's.
   *
   *  WHY THE HANDLER LIVES ON THE VIEWPORT `<div>` AND NOT ON `document`. The panel is
   *  this div's SIBLING, so a key pressed in a panel field never reaches here — which is
   *  what keeps Escape meaning what it already means inside those fields (the Skill
   *  `Select`'s popup, and every other Escape handler in the app). A document-level
   *  listener would close the panel from inside a half-typed rename: a discarded draft
   *  and a lost place in the form, on a key the person pressed to dismiss a popup.
   *
   *  This closes the gap the header used to disclose. Reaching node mode was ALWAYS
   *  possible by keyboard (Tab to a node's `<button>`, Enter selects); it was LEAVING
   *  that needed a pointer, because the pane click that deselects is a mouse event and
   *  the xyflow wrapper that owns its own Escape handling is deliberately not in the tab
   *  order (`nodesFocusable={false}` — a focused wrapper is the second tab stop, and its
   *  arrow keys move a node without ever calling `onNodeDragStop`, i.e. a move that
   *  cannot persist). xyflow's Escape cannot be reused for this precisely because
   *  turning it on means turning that wrapper back on. */
  const onViewportKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") clearSelection();
    },
    [clearSelection],
  );

  /** Draw the edge. The rule is `lib/workflowEdgeWrite`'s, shared with the panel; this
   *  handler only refuses (writes nothing) or appends, and never invents a list.
   *
   *  The `catch` is not swallowing: the store has already reverted the paint and written
   *  the sentence into `error`, which the panel renders, and it rethrows so a caller
   *  that cares can see — this caller's report IS the error line, and an unhandled
   *  rejection is a crash with no subject. */
  const onConnect = useCallback(
    (connection: Connection): void => {
      if (activeSpacePath === null) return;
      const next = nextSlugsAfterConnect(
        columns,
        connection.source,
        connection.target,
      );
      // THE LABEL LIST, and the drag must not skip it. `setStageNext`'s 4th argument
      // defaults to `slugs.map(() => null)` — omitting it CLEARS every name on the
      // column — so a 3-arg call here would silently un-name the edges a person labelled
      // in the panel, as a side effect of a gesture that only added a destination. The
      // drag writes NO name for its own edge (a pointer gesture has no keyboard in it, so
      // `null` is the honest value) and carries the stored names for the edges it is not
      // touching. Same owner as the panel, so the two surfaces cannot disagree — which is
      // known-gaps §10b's rule: a guard belongs here and not in the handler.
      const outcomes = nextOutcomesAfterConnect(
        columns,
        connection.source,
        connection.target,
      );
      if (next === null || outcomes === null) return;
      void setStageNext(
        activeSpacePath,
        connection.source,
        next,
        outcomes,
      ).catch(() => {});
    },
    [activeSpacePath, columns, setStageNext],
  );

  /** The same predicate, asked while the pointer is still down, so a self-loop or a
   *  drag onto a ghost node shows up as an invalid connection line instead of as
   *  nothing at all. */
  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean =>
      activeSpacePath !== null &&
      canConnectStages(columns, connection.source, connection.target),
    [activeSpacePath, columns],
  );

  /** Where the pointer left the box. One call, both coordinates — the command's rule,
   *  not a convenience: half a pair is the state it refuses to store. */
  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: WorkflowFlowNode): void => {
      if (activeSpacePath === null) return;
      void setStagePosition(
        activeSpacePath,
        node.id,
        node.position.x,
        node.position.y,
      ).catch(() => {});
    },
    [activeSpacePath, setStagePosition],
  );

  /** Every column a person has moved. `storedPositionOf` is the layout's own pair rule,
   *  imported rather than re-spelled: a second answer to "is this node positioned" is
   *  how **Tidy up** ends up clearing the wrong set. */
  const positionedSlugs = useMemo(
    () =>
      (columns ?? [])
        .filter((column) => storedPositionOf(column.stage) !== null)
        .map((column) => column.stage.slug),
    [columns],
  );

  /** **Tidy up**: hand the whole graph back to dagre. One clear per positioned column —
   *  `setStagePosition` takes a pair and `null, null` is that pair's only spelling of
   *  "nobody ever moved it", so there is no bulk verb to reach for. Each write repaints
   *  and re-derives on its own, which means the graph settles one column per reply; on a
   *  five-to-ten column board that is a visible cascade and not a problem, and a single
   *  command that cleared the board would be a new IPC verb for a nicety. */
  const tidyUp = useCallback((): void => {
    if (activeSpacePath === null) return;
    for (const slug of positionedSlugs) {
      void setStagePosition(activeSpacePath, slug, null, null).catch(() => {});
    }
  }, [activeSpacePath, positionedSlugs, setStagePosition]);

  return (
    <>
      {/* SIBLING ISLAND ONE — the picture. ADR 0097's island recipe, taken from
          `TasksBoard` verbatim: the frame plane is CHROME and every view surface is an
          ISLAND above it, so the canvas and the board cannot sit at different contrasts
          against the pane beside them. `min-w-0` is the load-bearing one (the parent is
          `App`'s content-row flex ROW, so width is the main axis) and `overflow-hidden`
          clips the island's corners — xyflow sizes itself to this box, which is why the
          box must be a real flex item and not a shrink-to-fit one.

          There is NO header, and no `h1`. The surface used to name itself to a screen
          reader because it replaced the whole content row; the sidebar door that opened
          it is on screen the entire time it is up (ADR 0094/0095), so the bar cost a row
          of the picture to repeat a word the chrome already says. `App.workflows.test.tsx`
          carries the silent-else pin the `h1` used to serve, re-pointed at the panel's
          accessible name. */}
      <section
        className="relative m-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-chat"
        data-testid="workflows-canvas"
        aria-label="Workflow graph"
      >
        {/* The store's error cell, and ONLY here — see the header: the panel beside the
            graph renders the same cell for every state where it is mounted, and this is
            the one state where it is not. It stayed when the header around it went, and
            `WorkflowsCanvas.test.tsx` pins that it did. */}
        {activeSpacePath === null && (
          <IpcErrorLine error={error} className="shrink-0 px-3 pt-2" />
        )}

        {activeSpacePath === null ? (
          // `subtle`, not `EmptyListLine`'s default `subtlest`: everywhere else that
          // component is a quiet row inside a list, and its 8 other call sites keep the
          // default. Here it is the WHOLE VIEW — the only thing on screen — and
          // `subtlest` on this plane is 2.33 default-light / 2.21 default-dark, a pair the
          // default palette declares `textUngradeable` and so no palette gate reads. The
          // same step the node's card count takes, for the same reason.
          <EmptyListLine className="text-foreground-subtle">
            No Space is open, so there is no workflow to show.
          </EmptyListLine>
        ) : graph === undefined && loading ? (
          // `Spinner` IS the `role="status"` node, so this wrapper adds no second live
          // region — the reason is spelled out at the board's copy of this branch.
          <div className="flex items-center gap-2 p-3">
            <Spinner className="size-4 text-foreground-subtle" />
            <span className="text-ui-sm text-foreground-subtle">
              Loading the workflow…
            </span>
          </div>
        ) : graph === undefined ? (
          // Never-loaded is NOT the same state as empty, and after a failed fetch
          // `columns` is still `undefined` — so this line, under the error, must not
          // claim the Space has no columns when the FETCH failed.
          <EmptyListLine className="text-foreground-subtle">
            The board has not loaded yet.
          </EmptyListLine>
        ) : graph.nodes.length === 0 ? (
          <EmptyListLine className="text-foreground-subtle">
            This Space has no columns yet.
          </EmptyListLine>
        ) : (
          // The canvas. The attribution corner is deliberately LEFT IN: `@xyflow/react`
          // is MIT and asks only that the credit stay unless a licence is bought, so
          // hiding it would be a licensing decision made inside a component file. No
          // `proOptions` override is passed, and none should be added to reclaim 20px
          // of corner. It is THEMED below instead, which is the other half of the same
          // refusal: a credit that is invisible is a credit removed by another route.
          // `onKeyDown` here and not on `document` — see `onViewportKeyDown`: the
          // panel is this div's SIBLING ISLAND now, so Escape in a panel field stays the
          // field's own business and only Escape from the graph clears the selection.
          <div
            className="min-h-0 flex-1"
            data-testid="workflows-canvas-viewport"
            onKeyDown={onViewportKeyDown}
          >
            <ReactFlow
              className={CANVAS_THEME}
              nodes={nodes}
              edges={edges}
              nodeTypes={workflowNodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onSelectionChange={onSelectionChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeDragStop={onNodeDragStop}
              // Connectable: the drag is the pointer's route to the destination write
              // the panel's `Select` already makes by keyboard, and both go through
              // `lib/workflowEdgeWrite`. It reaches the node COMPONENT and stops there
              // — a `<Handle>` defaults to connectable on its own three props, so this
              // flag only becomes real because `WorkflowNodes.tsx` forwards it into all
              // three, which the canvas test pins class by class.
              nodesConnectable
              // One stop per node, and it is the node's own `<button>`: left at its
              // `true` default every wrapper is `tabIndex={0}` and eats a tab to
              // *select* a node the button below it already selects.
              nodesFocusable={false}
              // No removal by keyboard, in either direction: a column is deleted from
              // the panel's own picker, which relocates its cards first, and an edge is
              // removed by removing the destination — a canvas that deleted either on a
              // keypress would be a second owner of a write that has a card-relocation
              // step it cannot show.
              deleteKeyCode={null}
              edgesFocusable={false}
              minZoom={0.2}
              maxZoom={1.75}
            >
              {/* **Tidy up**, on the picture rather than above it — where a graph's other
                  controls live. A whole-graph reset is a rare verb and it used to sit in
                  the window's top-right like the primary action of the page; the primary
                  verb here is the one on the nodes. `bottom-left` is the cluster xyflow
                  reserves for chrome (`Controls` and `MiniMap` are `<Panel>`s too), which
                  leaves the credit's corner alone.

                  It is INERT rather than absent when nothing is hand-arranged, so the
                  canvas does not reflow on the first drag, and `aria-disabled` rather
                  than the property so a screen reader is told why it did nothing rather
                  than finding no button at all. That rule is load-bearing: the guard in
                  `tidyUp` is what stops a click from firing one write per column. */}
              <Panel position="bottom-left">
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  aria-label="Tidy up"
                  className="gap-1.5 rounded-lg border border-card-border bg-chat px-2 text-foreground-subtle shadow-sm hover:bg-surface-hover hover:text-foreground"
                  aria-disabled={positionedSlugs.length === 0 || undefined}
                  onClick={tidyUp}
                >
                  <Wand2Icon className="size-4" />
                  <span>Tidy up</span>
                </Button>
              </Panel>
            </ReactFlow>
          </div>
        )}
      </section>

      {/* SIBLING ISLAND TWO — the panel that edits what the picture shows. It is a
          sibling of the canvas ISLAND now, not a pane inside it: ADR 0097 says every
          flanking column is an island, and `SidePane` is the reference. It is still never
          inside the `<ReactFlow>` viewport — the viewport is a transform surface xyflow
          measures, and a text input inside a drag surface is the defect
          `WorkflowNodes.tsx` records at length. No `className`: the frame is the
          component's own now, with nothing per-site left to merge. */}
      <NodeSettingsPanel
        spacePath={activeSpacePath}
        stageSlug={selectedSlug}
        // Present exactly when it has a subject: workflow mode has no selection to
        // clear, and a button that clears an already-empty selection is the dead
        // control this repo refuses. Escape does the same thing from the graph —
        // see `onViewportKeyDown` and the header's both-directions paragraph.
        onClose={selectedSlug === null ? undefined : clearSelection}
      />
    </>
  );
}
