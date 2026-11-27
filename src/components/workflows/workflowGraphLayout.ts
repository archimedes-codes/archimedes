import dagre from "@dagrejs/dagre";
import type { CSSProperties } from "react";
import type { Edge, Node } from "@xyflow/react";

import { nextStepSlugs } from "../../lib/workflowGraph";
import { edgeOutcomesOf } from "../../lib/workflowEdgeWrite";
import type { StageDto, StageWithTasks } from "../../lib/tauri";

/**
 * The **layout** of the workflow graph — columns in, positioned nodes and edges
 * out. Pure, and deliberately apart from `WorkflowsCanvas.tsx`: the canvas owns
 * the stores, the load and the selection, and none of that is needed to answer
 * "where does this box go, and what lines join them", which is the part worth
 * testing without a renderer in the loop.
 *
 * ## Why dagre draws it and not a plain row
 *
 * A kanban is a row of lanes and the board can therefore lay itself out with
 * `flex`. A workflow is not: `nextSlugs` is a person's list, so a column can
 * point at the one two places before it, two places after it, or back at the
 * start, and a row of lanes cannot show that without crossing lines nobody can
 * trace. `@dagrejs/dagre` does the rank assignment — the same layered
 * Sugiyama-style job the n8n-style canvas the owner asked for needs — so the
 * graph reads left to right by DEPTH rather than by `sortOrder`.
 *
 * ## Positions: the STORE is the authority, dagre is the fallback
 *
 * This section used to argue the opposite — that a stored position "would be a
 * per-Space fact with no column to live in, and a second answer to 'what is this
 * workflow' that the editor cannot edit". **The first half of that sentence is now
 * false and the second half was never much of an argument.** `stages` gained
 * `position_x` / `position_y` (both nullable, both read as ONE pair, written by
 * `set_stage_position`), and the panel beside this canvas edits every field the node
 * shows — so a stored position has a column to live in and an editor that edits it.
 * What made the old decision wrong was not the reasoning, it was that the surface
 * became an editor: a canvas you can drag but cannot persist a drag to is worse than
 * one you cannot drag at all, because the drag promises something the next render
 * takes back.
 *
 * So the rule, in the order it is applied:
 *
 *  - a node whose `positionX` **and** `positionY` are both non-null is drawn at that
 *    pair, exactly. The store is the authority; there is no second source of truth
 *    and no local position state anywhere near it;
 *  - a node with only ONE of the two is treated as unpositioned. `set_stage_position`
 *    takes both coordinates or neither and refuses a half pair, and `StageDto.positionX`
 *    tells a reader that finds half a pair to treat the node as unpositioned — a node
 *    at a stored X and a computed Y is the state the write refuses to STORE, so it
 *    must not be the state the canvas PAINTS either;
 *  - `0` is a coordinate somebody placed and `null` is the only "nobody ever moved
 *    it", so the check is `!== null` and not truthiness. `positionX || dagreX` would
 *    silently free every node pinned to the left or top edge of the canvas;
 *  - **if any node lacks a stored pair, dagre runs over the whole graph** and the
 *    stored nodes are overridden afterwards. That is what keeps a half-arranged board
 *    readable: the never-arranged columns land at sane depths RELATIVE to the
 *    arranged ones instead of at the origin under them. When every node has a pair,
 *    dagre is skipped — nothing it computes would survive.
 *
 * The last branch is the one a test cannot see: "skip dagre" and "run dagre then
 * override" return the same array, so the pin on it is behavioural (every stored pair
 * comes back verbatim, in a fixture deliberately arranged against the ranker) and not
 * a spy on dagre. It is worth having anyway, and not only to save the call — a graph
 * somebody arranged by hand has an ORDER in it, and re-ranking it to discover the
 * positions are then thrown away is the same disrespect the drag is here to end.
 *
 * One thing stays computed and it cannot be otherwise: the GHOST node, an edge whose
 * target column the read cannot name, has no row and so no `position_x`. It is fed to
 * dagre like any real node (which also means a board with a stale edge can never reach
 * the "every node is arranged" branch), and it is marked `draggable: false`, because
 * the drag verb writes through `set_stage_position` and that command refuses a slug
 * the Space does not hold. A draggable ghost would be a drag that always fails, always
 * reverts and always lands its sentence in the error line — the snap-back, made
 * permanent.
 *
 * ## The three answers `nextSlugs` holds, and the collapse to avoid (ADR 0099)
 *
 * The edges come from `lib/workflowGraph`'s `nextStepSlugs`, which is the ONE
 * derivation — the same one the card's launch pill, the detail modal's buttons
 * and the auto-advance runtime read. It is called rather than re-spelled here
 * because the distinction it carries is the one thing a canvas must not lose:
 *
 *  - `null` — UNCONFIGURED: falls back to the column at `sortOrder + 1`, so a
 *    board that predates the graph still draws a chain;
 *  - `[]` — configured, and it **leads nowhere**: NO edge, and that column is a
 *    dead end the canvas has to show;
 *  - `["a", "b"]` — configured, in the row's own order.
 *
 * `workflowGraph.ts`'s own header carries the long argument for why `[]` must
 * never fall back to the `sortOrder + 1` edge; what lives here is the visible
 * consequence — a column whose `nextSlugs` is `[]` draws NO line, and a canvas
 * that drew one would be showing a chain the person deleted.
 *
 * ## An edge naming a column that is not there
 *
 * `nextStepSlugs` REPORTS such a slug (its header explains why the modal keeps
 * it: "we could not name it" is a different claim from "it has no column"). A
 * canvas has the same problem in a worse form — an edge to a node id that does
 * not exist renders NOTHING at all, so a stale destination would be invisible
 * rather than merely unclickable. So the ghost node: the slug is drawn as its
 * own node, marked as missing, and the line lands on it. The person sees the
 * broken edge, which is the honest rendering of a stale read.
 */

/** The box dagre is told each node occupies, and the box the node's own CSS keeps
 *  it to — `NODE_BOX_STYLE` in `WorkflowNodes.tsx` writes these two numbers into the
 *  node body's inline `width`/`height`, importing them from here. They are ONE pair
 *  spelled once: dagre's rank separation is measured between boxes, so a layout built
 *  on 240×104 while the node renders 200 wide overlaps its neighbour by 40px, and
 *  nothing in a browser-less test would notice. `WorkflowsCanvas.test.tsx` reads the
 *  inline style off the rendered element to make that visible; the `>= NODE_WIDTH`
 *  assertions in the layout test by themselves cannot, because they compare two
 *  positions this same constant produced. */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 104;

/** Left-to-right, because a workflow is read that way. The two separations are
 *  set against the box above rather than to dagre's defaults (50/40), which
 *  place a 240px-wide box on top of its neighbour. */
const RANK_SEPARATION = 96;
const NODE_SEPARATION = 40;

/** The data one **column** node carries. Every field is the column's OWN state,
 *  read off the `StageDto` the board already paints — the layout invents nothing and
 *  edits nothing. Every one of these fields is edited by `NodeSettingsPanel`, which
 *  reads the SAME slice this function is handed, so a node and the panel beside it
 *  cannot disagree about a column. */
export interface WorkflowStageNodeData extends Record<string, unknown> {
  slug: string;
  label: string;
  /** The Skill this column launches, or `null` for "launches nothing". */
  onEnterSkill: string | null;
  /** The per-column auto-advance flag, ON meaning a card here moves itself. */
  auto: boolean;
  /** The column's extra prompt. `null` is the ONLY "no extra prompt" state. */
  promptPrefix: string | null;
  /** The cards in this column — the count the node prints, the same
   *  `tasks.length` the Stage editor's row prints. */
  taskCount: number;
  /** TRUE when the graph gives this column nowhere to go, i.e. it produced no
   *  edge at all. This is the fact a kanban structurally cannot show, and the
   *  reason the canvas exists: it is where an auto chain STOPS. */
  deadEnd: boolean;
  /** Every edge's target, resolved label or bare slug, for the node's
   *  accessible description (the counts are swallowed by an `aria-label`). */
  nextLabels: string[];
}

/** The data the GHOST node carries — an edge whose target column is not in the
 *  loaded slice. Deliberately NOT a `WorkflowStageNodeData` with empty fields: a
 *  ghost has no label, no Skill and no auto flag, and inventing those for it
 *  would be the canvas making up column state it was never told. */
export interface WorkflowMissingNodeData extends Record<string, unknown> {
  slug: string;
}

/** A laid-out graph, ready for `<ReactFlow>`. */
export interface WorkflowGraph {
  nodes: WorkflowFlowNode[];
  edges: Edge[];
}

/** The node type keys, exported because the canvas registers them and a typo on
 *  either side of the pair renders nothing at all (an unknown type falls back to
 *  `default` with an `onError` nobody mounted). */
export const STAGE_NODE_TYPE = "stage";
export const MISSING_NODE_TYPE = "missing";

/** The two node types AS xyflow sees them, payload included.
 *
 *  They exist so the payload survives the trip to the node component. A
 *  `useNodesState<Node>` (the bare default, whose data is `Record<string, unknown>`)
 *  erases it, and both node components then have to assert their way back to their own
 *  fields — an assertion that would keep compiling quietly if the layout stopped putting
 *  `deadEnd` on the data. Named here rather than in the component file because this
 *  module is the PRODUCER: the `satisfies` clauses in `layoutWorkflowGraph` are what
 *  prove the data matches, and reading it back through the same alias is what makes that
 *  proof load-bearing on both ends. */
export type WorkflowStageFlowNode = Node<WorkflowStageNodeData, typeof STAGE_NODE_TYPE>;
export type WorkflowMissingFlowNode = Node<
  WorkflowMissingNodeData,
  typeof MISSING_NODE_TYPE
>;
/** Either node, i.e. everything the canvas hands xyflow. */
export type WorkflowFlowNode = WorkflowStageFlowNode | WorkflowMissingFlowNode;

/** The edge id for one hop, optionally NAMED.
 *
 *  Keyed on the pair rather than random, so a re-render of an unchanged graph hands
 *  xyflow the SAME ids and it does not rebuild every edge — and so a test can name the
 *  edge it means.
 *
 *  The `outcome` half exists because the pair alone could not identify an edge once an
 *  edge could carry a name. `next_slugs` is not a set — `set_stage_next` validates each
 *  element names a real column and never that the list has no repeats — so
 *  `["done","done"]` labelled `["failed","success"]` is legal data that routes two ways
 *  (`advise.rs` takes the first edge whose label the claim named). With the id keyed on
 *  the pair alone, the hop loop's dedupe swallowed the second edge: one route in the
 *  database, one wire on the canvas, and no warning anywhere.
 *
 *  **`null` MUST answer the unchanged `${from}->${to}`**, and that is a compatibility
 *  contract and not a formatting preference: the canvas tests name edge ids as literal
 *  DOM attributes (`rf__edge-backlog->todo`, `.react-flow__edge[data-id='backlog->doing']`)
 *  across `WorkflowsCanvas.test.tsx` and `WorkflowsCanvas.editor.test.tsx`, so those pins
 *  staying green IS the evidence that an unlabelled board — every board that exists today,
 *  since `next_outcomes` has no SQL `DEFAULT` and is never backfilled — renders exactly as
 *  it did before this field existed.
 *
 *  The separator is `:` and not `->`: an id built as `${from}->${to}->${outcome}` would
 *  read like a three-node path, and a name is not a node. */
export const edgeIdOf = (from: string, to: string, outcome: string | null = null): string =>
  outcome === null ? `${from}->${to}` : `${from}->${to}:${outcome}`;

/** The class and the inline style that mark an edge as **inferred by the graph** rather
 *  than **drawn by a person**.
 *
 *  THIS EXISTS BECAUSE THE TWO WERE PIXEL-IDENTICAL, and the difference between them is a
 *  documented contract, not a shade of taste. `nextStepSlugs` answers the column at
 *  `sortOrder + 1` for a `nextSlugs: null` row, so a board that predates the graph draws a
 *  full chain — and every one of those wires was drawn exactly like a wire somebody saved.
 *  On a `board_strict = 1` Space `NULL` permits *any* outgoing move and `["research"]`
 *  permits only `research` (ADR 0099), and known-gaps §8 records that the flip is **not
 *  reversible through the UI** (`[]` is not `NULL`). A person cannot guard a distinction
 *  they cannot see, so the inferred wire is dashed and the stored one is not.
 *
 *  BOTH a class and a `strokeDasharray`, deliberately. xyflow puts `edge.className` on the
 *  `<g>` wrapper AND on the `.react-flow__edge-path` (measured in the installed
 *  `@xyflow/react@13.0.3`: the path's class is `classnames('react-flow__edge-path',
 *  className)`), so the class is the hook a stylesheet in `index.css` can theme later; the
 *  inline dash is what makes the wire visibly different TODAY, without depending on a sheet
 *  that does not exist yet. A class alone would be a promise about CSS nobody has written.
 *
 *  `workflowGraphLayout.test.ts` asserts these two values as LITERALS rather than reading
 *  them back from here, so renaming the class or emptying the dash reddens it. */
export const IMPLICIT_EDGE_CLASS = "workflow-edge-implicit";
export const IMPLICIT_EDGE_STYLE: CSSProperties = { strokeDasharray: "6 4" };

/** The pair this column was HAND-ARRANGED at, or `null` for "nobody ever moved it".
 *
 *  THE pair rule, spelled once: BOTH coordinates must be present, so a half pair reads
 *  as unpositioned (that is what `set_stage_position` refuses to store, and what
 *  `StageDto.positionX` tells a reader to do if it ever finds one), and BOTH tests are
 *  `!== null` and NOT truthiness, because `0` is a coordinate somebody pinned to an edge
 *  and `null` is the only absence the column can hold. The canvas reads this too — the
 *  **Tidy up** control clears exactly the nodes it answers non-`null` for. */
export const storedPositionOf = (
  stage: StageDto,
): { x: number; y: number } | null =>
  stage.positionX !== null &&
  stage.positionX !== undefined &&
  stage.positionY !== null &&
  stage.positionY !== undefined
    ? { x: stage.positionX, y: stage.positionY }
    : null;

/** Run dagre over the whole graph and answer the top-left corner per slug.
 *
 *  Called for EVERY node that needs a computed place, including the ones whose stored
 *  pair will override the answer — that is what places the never-arranged columns at
 *  sane depths RELATIVE to the arranged ones, which is the mixed case's whole point.
 *  The ghosts go in as real nodes so a broken edge has somewhere to land.
 *
 *  A map and not a closure over a live dagre graph, so `layoutWorkflowGraph` can hold
 *  ONE position lookup whose stored-first ordering is the position rule; a second way
 *  to ask "where is this box" is exactly the second source of truth the header
 *  disclaims. */
function rank(
  columns: readonly StageWithTasks[],
  missing: readonly string[],
  hops: readonly { from: string; to: string }[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  // `setGraph` FIRST: dagre keeps layout settings on the graph object, and
  // `layout()` reads `rankdir` from it — set it after `setNode` and the default
  // top-to-bottom rankdir is what the ranks get.
  g.setGraph({
    rankdir: "LR",
    nodesep: NODE_SEPARATION,
    ranksep: RANK_SEPARATION,
  });
  // Required by dagre even with no edge labels: it reads the default label to
  // decide an edge's size, and without it `setEdge` throws.
  g.setDefaultEdgeLabel(() => ({}));
  for (const column of columns) {
    g.setNode(column.stage.slug, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const slug of missing) {
    g.setNode(slug, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const hop of hops) g.setEdge(hop.from, hop.to);

  dagre.layout(g);

  const out = new Map<string, { x: number; y: number }>();
  // dagre answers with the box's CENTRE; xyflow wants its top-left corner.
  for (const slug of [...columns.map((c) => c.stage.slug), ...missing]) {
    const box = g.node(slug);
    out.set(slug, {
      x: (box?.x ?? 0) - NODE_WIDTH / 2,
      y: (box?.y ?? 0) - NODE_HEIGHT / 2,
    });
  }
  return out;
}

/** Lay the Space's columns out.
 *
 *  `columns` is the loaded slice IN THE ORDER THE STORE HOLDS IT (the board's
 *  own order, which `get_board` returns by `sort_order`). An empty slice yields
 *  an empty graph — that is the store's "this Space has no stages" state, and the
 *  canvas renders its own line for it rather than drawing a blank rectangle. */
export function layoutWorkflowGraph(
  columns: readonly StageWithTasks[],
): WorkflowGraph {
  const bySlug = new Map(columns.map((c) => [c.stage.slug, c]));
  /** Every hop, in column order, deduplicated on its EDGE ID.
   *
   *  Deduplicated because a person can save the same slug twice into `next_slugs` — the
   *  write validates that each entry is a real column, not that the list has no repeats —
   *  and two identical ids in one `edges` array make xyflow render one of them and warn.
   *
   *  The dedupe key is the whole edge id and NOT the destination, which is the difference
   *  between this line and the one it replaced. Keyed on the destination, two edges to
   *  `done` labelled `failed` and `success` collapsed into one wire: both routes existed
   *  in the database and fired on a claim, and the person could see only one of them and
   *  could not tell which. Keyed on the id, they are two hops, and the pair that really
   *  does collide — same destination, no name on either — still collapses, because that
   *  one genuinely is one id.
   *
   *  `implicit` records the ONE thing the drawing must not lose: whether this hop came
   *  from the row's own list or from `nextStepSlugs`' `sortOrder + 1` fallback. It is
   *  read off `nextSlugs === null` and NOT off "did the fallback fire", because an
   *  unconfigured row's hop is inferred even when its target is a ghost. */
  const hops: { from: string; to: string; outcome: string | null; implicit: boolean }[] =
    [];
  const seen = new Set<string>();
  for (const column of columns) {
    const implicit = column.stage.nextSlugs === null;
    // The positional read, asked of the ONE owner (`workflowEdgeWrite`), so the picture
    // and the write cannot disagree about which edge a name sits on. A `null` row answers
    // `[]` — an inferred wire has no index to hold a label.
    const outcomes = edgeOutcomesOf(column.stage);
    for (const [index, to] of nextStepSlugs(columns, column.stage).entries()) {
      const outcome = outcomes[index] ?? null;
      const id = edgeIdOf(column.stage.slug, to, outcome);
      if (to === column.stage.slug || seen.has(id)) continue;
      seen.add(id);
      hops.push({ from: column.stage.slug, to, outcome, implicit });
    }
  }

  // The ghost set: a hop whose target the loaded columns cannot name. Fed to
  // dagre as real nodes so a broken edge still gets a place on the canvas.
  const missing = [
    ...new Set(
      hops
        .map((h) => h.to)
        .filter((slug) => !bySlug.has(slug)),
    ),
  ].sort();

  // EVERY node arranged ⇒ dagre's answer would be thrown away, so it is not computed.
  // The ghost counts as un-arranged on purpose: it has no row to hold a position, so a
  // board with a stale edge always takes the dagre branch and the ghost gets a place.
  const everyNodeArranged =
    columns.length > 0 &&
    missing.length === 0 &&
    columns.every((c) => storedPositionOf(c.stage) !== null);

  /** dagre's answer per slug. EMPTY when every node is arranged — `positionOf`
   *  consults the stored pair first, so nothing reads an empty map in that branch. */
  const computed = everyNodeArranged
    ? new Map<string, { x: number; y: number }>()
    : rank(columns, missing, hops);

  // The one position lookup: stored first, dagre second. This ordering IS the anti-
  // snap-back rule — the drag writes through the store, the store echoes the pair onto
  // the row, this re-derives, and it reads back the number it was just given.
  const positionOf = (slug: string): { x: number; y: number } => {
    const column = bySlug.get(slug);
    const stored = column === undefined ? null : storedPositionOf(column.stage);
    return stored ?? computed.get(slug) ?? { x: 0, y: 0 };
  };

  const nodes: WorkflowFlowNode[] = columns.map((column) => {
    const stage = column.stage;
    const targets = nextStepSlugs(columns, stage);
    const nodeOutcomes = edgeOutcomesOf(stage);
    return {
      id: stage.slug,
      type: STAGE_NODE_TYPE,
      position: positionOf(stage.slug),
      data: {
        slug: stage.slug,
        label: stage.label,
        onEnterSkill: stage.onEnterSkill,
        auto: stage.auto,
        promptPrefix: stage.promptPrefix,
        taskCount: column.tasks.length,
        // No hop at all — the `[]` case, or the `null` case with no column at
        // `sortOrder + 1`. Both mean "the chain stops here" and both look
        // identical on a kanban, which is the point of drawing it.
        deadEnd: targets.length === 0,
        // A named edge says so here too, because this becomes the node's
        // `aria-label` ("Leads to …"). Two edges to `Done` reading "Leads to Done, Done"
        // is the invisible-collapse defect with a different sensor; an UNLABELLED edge
        // still contributes its bare label, so every existing board reads verbatim as it
        // does today.
        nextLabels: targets.map((slug, index) => {
          const label = bySlug.get(slug)?.stage.label ?? slug;
          const outcome = nodeOutcomes[index] ?? null;
          return outcome === null ? label : `${label} (${outcome})`;
        }),
      } satisfies WorkflowStageNodeData,
    };
  });

  for (const slug of missing) {
    nodes.push({
      id: slug,
      type: MISSING_NODE_TYPE,
      position: positionOf(slug),
      // Not a column, so no row, so no `position_x` — and the drag verb
      // (`set_stage_position`) refuses a slug the Space does not hold. Left draggable
      // this box would be a drag that can only fail, revert and land a sentence in the
      // error line: the snap-back, made permanent. `false` and not absent, because the
      // canvas-level `nodesDraggable` is what an absent flag defers to.
      draggable: false,
      data: { slug } satisfies WorkflowMissingNodeData,
    });
  }

  return {
    nodes,
    edges: hops.map((hop) => ({
      id: edgeIdOf(hop.from, hop.to, hop.outcome),
      source: hop.from,
      target: hop.to,
      // The inferred wire LOOKS inferred. See `IMPLICIT_EDGE_CLASS` for the contract
      // this marks — a `null` column and a saved one are different Strict-mode
      // permissions, and the canvas used to draw them identically.
      ...(hop.implicit
        ? { className: IMPLICIT_EDGE_CLASS, style: IMPLICIT_EDGE_STYLE }
        : {}),
      // The edge's NAME, rendered by the builtin `default` edge — `label` is a
      // first-class `EdgeLabelOptions` field in `@xyflow/react@13.0.3` and `BaseEdge`
      // hands it to `EdgeText`, so no `edgeTypes` and no custom edge component are
      // needed, and `WorkflowsCanvas.tsx` passing none is what makes that true.
      //
      // SPREAD CONDITIONALLY, never `label: hop.outcome`. Spreading an unset key puts a
      // `label` property on every edge of every board, and an unlabelled board is then a
      // different object than it was — the layout test asserts the exact key set, and the
      // canvas tests assert literal DOM attributes, because "`null` means no edge carries
      // a label, so behaviour is exactly as today" is a promise about the byte-level
      // picture and not a claim about intent.
      ...(hop.outcome === null ? {} : { label: hop.outcome }),
    })),
  };
}
