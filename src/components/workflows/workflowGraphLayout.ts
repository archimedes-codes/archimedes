import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import { nextStepSlugs } from "../../lib/workflowGraph";
import type { StageWithTasks } from "../../lib/tauri";

/**
 * The **layout** of the workflow graph — columns in, positioned nodes and edges
 * out. Pure, and deliberately apart from `WorkflowsCanvas.tsx`: the canvas owns
 * the stores, the load and the dialog, and none of that is needed to answer
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
 * ## Positions, and why they are computed and not stored
 *
 * There is no position column. `stages` holds
 * `space_path / slug / label / sort_order / on_enter / on_enter_skill /
 * next_slugs / auto / prompt_prefix` and nothing else (verified against
 * `SCHEMA` in `src-tauri/src/storage/db/mod.rs` — the schema of record, and one of
 * THREE copies of this `CREATE TABLE`: the others are the test fixtures in
 * `storage/db/tests/support.rs` and `storage/db/tests/open.rs`. The fixture is what
 * this citation used to name, and it is the wrong owner: it is re-synced by hand
 * under the gate-isolation rule, so quoting it lets this list go stale while every
 * test stays green), so the layout is DERIVED from the same two facts
 * the board paints from — the columns
 * and their edges — and a Space that has never seen this canvas still gets a
 * sane graph. That is the decision, not an omission: a stored position would be
 * a per-Space fact with no column to live in, and a second answer to "what is
 * this workflow" that the editor cannot edit.
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
 *  read off the `StageDto` the board already paints — the canvas invents nothing
 *  and edits nothing (the `StageEditor` dialog owns all eight fields). */
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

/** The edge id for one hop. Keyed on the pair rather than random, so a re-render
 *  of an unchanged graph hands xyflow the SAME ids and it does not rebuild every
 *  edge — and so a test can name the edge it means. */
export const edgeIdOf = (from: string, to: string): string => `${from}->${to}`;

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
  /** Every hop, in column order, deduplicated. Deduplicated because a person can
   *  save the same slug twice into `next_slugs` — the write validates that each
   *  entry is a real column, not that the list has no repeats — and two identical
   *  ids in one `edges` array make xyflow render one of them and warn. */
  const hops: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    for (const to of nextStepSlugs(columns, column.stage)) {
      const id = edgeIdOf(column.stage.slug, to);
      if (to === column.stage.slug || seen.has(id)) continue;
      seen.add(id);
      hops.push({ from: column.stage.slug, to });
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

  // dagre answers with the box's CENTRE; xyflow wants its top-left corner.
  const positionOf = (slug: string): { x: number; y: number } => {
    const box = g.node(slug);
    return {
      x: (box?.x ?? 0) - NODE_WIDTH / 2,
      y: (box?.y ?? 0) - NODE_HEIGHT / 2,
    };
  };

  const nodes: WorkflowFlowNode[] = columns.map((column) => {
    const stage = column.stage;
    const targets = nextStepSlugs(columns, stage);
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
        nextLabels: targets.map(
          (slug) => bySlug.get(slug)?.stage.label ?? slug,
        ),
      } satisfies WorkflowStageNodeData,
    };
  });

  for (const slug of missing) {
    nodes.push({
      id: slug,
      type: MISSING_NODE_TYPE,
      position: positionOf(slug),
      data: { slug } satisfies WorkflowMissingNodeData,
    });
  }

  return {
    nodes,
    edges: hops.map((hop) => ({
      id: edgeIdOf(hop.from, hop.to),
      source: hop.from,
      target: hop.to,
    })),
  };
}
