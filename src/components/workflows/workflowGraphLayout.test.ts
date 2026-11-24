import { describe, expect, it } from "vitest";

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgeIdOf,
  layoutWorkflowGraph,
} from "./workflowGraphLayout";
import type { StageDto, StageWithTasks, TaskCardView, TaskRow } from "../../lib/tauri";

/**
 * The workflow graph's LAYOUT — columns in, positioned nodes and edges out.
 *
 * A `.test.ts` and NOT a `.test.tsx`: this module imports no React and renders
 * nothing, so there is no component here. It is also NOT a barrel mocker — it
 * imports `StageDto` as a TYPE only and touches no IPC, which is the shape
 * `src/lib/tauriBarrel.test.ts`'s census prefers (its `workflowGraph.test.ts`
 * paragraph states the same rule for the sibling pure module).
 *
 * The fixtures mirror `TasksBoard.test.tsx`'s `stage()` on purpose: `auto` and
 * `promptPrefix` are REQUIRED on the wire type (`stages.auto` is
 * `NOT NULL DEFAULT 0`, `promptPrefix` has no SQL DEFAULT and NULL is its only
 * "no extra prompt" state), so a fixture that omitted either would be a literal
 * that lies about the wire.
 */
const SPACE = "/w/alpha";

const stage = (slug: string, over: Partial<StageDto> = {}): StageDto => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder: 0,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
  auto: false,
  promptPrefix: null,
  ...over,
});

const card = (id: string, stageSlug: string): TaskCardView => ({
  task: {
    id,
    spacePath: SPACE,
    number: 1,
    title: `Card ${id}`,
    body: null,
    specPath: null,
    stageSlug,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  } satisfies TaskRow,
  sessions: [],
  costUsd: null,
  artifactKeys: [],
});

const column = (
  slug: string,
  over: Partial<StageDto> = {},
  taskCount = 0,
): StageWithTasks => ({
  stage: stage(slug, {
    sortOrder: ["backlog", "todo", "doing", "done"].indexOf(slug),
    ...over,
  }),
  tasks: Array.from({ length: taskCount }, (_, i) => card(`${slug}-${i}`, slug)),
});

describe("layoutWorkflowGraph — the nodes", () => {
  it("draws one node per column, in the store's order", () => {
    const columns = [column("backlog"), column("todo"), column("doing"), column("done")];
    const { nodes } = layoutWorkflowGraph(columns);
    expect(nodes.map((n) => n.id)).toEqual(["backlog", "todo", "doing", "done"]);
    // Every node is a STAGE node and carries its own label — the canvas prints
    // what the row holds and invents nothing.
    expect(nodes.every((n) => n.type === "stage")).toBe(true);
    expect(nodes.map((n) => n.data.label)).toEqual([
      "Backlog",
      "Todo",
      "Doing",
      "Done",
    ]);
  });

  it("gives every node a DISTINCT finite position, derived from the graph", () => {
    const columns = [column("backlog"), column("todo"), column("doing"), column("done")];
    const { nodes } = layoutWorkflowGraph(columns);
    for (const node of nodes) {
      expect(Number.isFinite(node.position.x), node.id).toBe(true);
      expect(Number.isFinite(node.position.y), node.id).toBe(true);
    }
    // LEFT TO RIGHT: an unconfigured chain falls back to `sortOrder + 1`, so
    // backlog → todo → doing → done and each box must sit further right than the
    // one before it. This is the dagre call doing its job — a hand-rolled
    // `x = index * WIDTH` would satisfy it too, which is why the BRANCH case
    // below is the one that proves a ranker is involved.
    const xs = nodes.map((n) => n.position.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    // And the boxes do not overlap horizontally: rank separation is measured
    // against the box width the layout was told, not a bare index step.
    //
    // SELF-REFERENTIAL ON PURPOSE, and left that way. `xs[i-1] + NODE_WIDTH` reads
    // the same constant the layout fed dagre, so these two assertions pin the
    // CONSTANT and not the render: a node whose CSS rendered 300 wide would keep
    // them green. That is not an oversight to fix here — this file renders nothing,
    // so it cannot see a box. The render half now lives in
    // `WorkflowsCanvas.test.tsx`'s "the node box IS the box the layout was built
    // on", which reads the inline width/height off the element. What these lines
    // still earn is the SHAPE: a hand-rolled `x = index * 40` step would fail them
    // while passing every other case in the file.
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]! + NODE_WIDTH);
    }
  });

  it("ranks by DEPTH and not by sortOrder, so a branch lays out as a branch", () => {
    // `backlog` points at BOTH `doing` and `done`, skipping `todo`. A row of
    // lanes ordered by `sortOrder` would put `todo` between them and draw the
    // skip as a line over a box; a ranker puts `done` one rank after `doing` and
    // floats `todo` beside them. The assertion is about the RANK (x), not the
    // array order: `done` must not sit between `backlog` and `doing`.
    const columns = [
      column("backlog", { nextSlugs: ["doing", "done"] }),
      column("todo", { nextSlugs: ["done"] }),
      column("doing"),
      column("done"),
    ];
    const { nodes } = layoutWorkflowGraph(columns);
    const x = (slug: string) => nodes.find((n) => n.id === slug)!.position.x;
    expect(x("backlog")).toBeLessThan(x("doing"));
    expect(x("doing")).toBeLessThan(x("done"));
    // `todo` is at rank 1 with `doing` (its only incoming edge is from
    // `backlog`), so it shares a rank — the same x — rather than being wedged
    // into the sequence. THIS is what dagre buys over `index * WIDTH`.
    expect(x("todo")).toBe(x("doing"));
    // Same rank, so they must be separated VERTICALLY or they would overlap.
    // (Same caveat as the `>= NODE_WIDTH` step above: this reads the constant, and
    //  the render half lives in `WorkflowsCanvas.test.tsx`.)
    const ys = nodes.filter((n) => n.id === "todo" || n.id === "doing");
    const [a, b] = [...ys].sort((p, q) => p.position.y - q.position.y);
    expect(b!.position.y).toBeGreaterThanOrEqual(a!.position.y + NODE_HEIGHT);
  });

  it("carries the column's real state on the node: Skill, auto, extra prompt, cards", () => {
    const { nodes } = layoutWorkflowGraph([
      column("backlog", { onEnterSkill: "specify", auto: true, promptPrefix: "Read the card first." }, 3),
    ]);
    expect(nodes[0]!.data).toMatchObject({
      slug: "backlog",
      onEnterSkill: "specify",
      auto: true,
      promptPrefix: "Read the card first.",
      taskCount: 3,
    });
    // And the OFF readings, from the same builder with nothing overridden — the
    // node must not read an absent Skill as a Skill, or a null prompt as a prompt.
    const plain = layoutWorkflowGraph([column("todo")]).nodes[0]!;
    expect(plain.data).toMatchObject({
      onEnterSkill: null,
      auto: false,
      promptPrefix: null,
      taskCount: 0,
      deadEnd: true,
    });
  });

  it("marks a column with no outgoing edge as a dead end, and one with an edge as not", () => {
    // The thing a person cannot see on a kanban, and the reason this canvas
    // exists. `[]` (configured, leads nowhere) and `null` with no successor both
    // mean "the chain stops here" and both must be MARKED.
    const configuredToStop = layoutWorkflowGraph([
      column("doing", { nextSlugs: [] }),
    ]).nodes[0]!;
    expect(configuredToStop.data.deadEnd).toBe(true);

    const nothingAfter = layoutWorkflowGraph([
      column("backlog", { nextSlugs: null }),
      column("todo", { nextSlugs: null }),
    ]).nodes[1]!;
    expect(nothingAfter.data.deadEnd).toBe(true);

    const hasAStep = layoutWorkflowGraph([
      column("backlog", { nextSlugs: null }),
      column("todo", { nextSlugs: null }),
    ]).nodes[0]!;
    expect(hasAStep.data.deadEnd).toBe(false);
  });
});

describe("layoutWorkflowGraph — the edges (ADR 0099's three answers)", () => {
  it("draws the configured edges in the row's OWN order", () => {
    // `doing` is configured to stop (`[]`) so it contributes no edge of its own
    // and the assertion below is about ONE row's list. Left `null` it would fall
    // back to `sortOrder + 1` and add a `doing->done` edge — correct behaviour,
    // but it would make this case's expected list about two rows instead of one.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: ["done", "doing"] }),
      column("doing", { nextSlugs: [] }),
      column("done"),
    ]);
    // The row's order, NOT re-sorted by `sortOrder` — the author of the row made
    // that choice and the FIRST entry is the primary (spec §7.1).
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "backlog->done",
      "backlog->doing",
    ]);
    expect(edges.map((e) => e.id)).toEqual([
      edgeIdOf("backlog", "done"),
      edgeIdOf("backlog", "doing"),
    ]);
  });

  it("falls back to the column at sortOrder + 1 when nextSlugs is null", () => {
    // Note the sortOrder VALUES: `todo` is 3 and `doing` is 4, so the fallback
    // must land on `doing` and NOT on the array's next element. A layout that
    // zipped the array would pass a `todo → doing` assertion built from adjacent
    // fixtures and fail this one.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: null }),
      column("todo", { nextSlugs: null }),
      column("doing", { nextSlugs: null }),
      column("done", { nextSlugs: null }),
    ]);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "backlog->todo",
      "todo->doing",
      "doing->done",
    ]);
  });

  it("draws NO edge for nextSlugs === [] — the two answers never collapse", () => {
    // THE PIN. `[]` is a person's decision that the column leads nowhere; `null`
    // is "no opinion". Read with `||` instead of `??` they are the same drawing,
    // and the canvas then shows a chain the person deleted. The two fixtures are
    // otherwise IDENTICAL, so the only thing separating the two outcomes is which
    // of the two values `nextSlugs` holds.
    const configuredToStop = layoutWorkflowGraph([
      column("backlog", { nextSlugs: [] }),
      column("todo"),
    ]);
    expect(configuredToStop.edges).toEqual([]);
    expect(configuredToStop.nodes.find((n) => n.id === "backlog")!.data.deadEnd).toBe(
      true,
    );

    const unconfigured = layoutWorkflowGraph([
      column("backlog", { nextSlugs: null }),
      column("todo"),
    ]);
    expect(unconfigured.edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "backlog->todo",
    ]);
    expect(unconfigured.nodes.find((n) => n.id === "backlog")!.data.deadEnd).toBe(
      false,
    );
  });

  it("draws no edge for a column that is the last one standing", () => {
    // The `null` fallback with NO column at `sortOrder + 1`: nothing to fall back
    // to, so no edge — and it must not invent a self-loop.
    const { edges, nodes } = layoutWorkflowGraph([column("solo", { nextSlugs: null })]);
    expect(edges).toEqual([]);
    expect(nodes[0]!.data.deadEnd).toBe(true);
  });
});

describe("layoutWorkflowGraph — an edge to a column that is not there", () => {
  it("draws the stale edge onto a ghost node rather than dropping it", () => {
    // `nextSlugs` names `archived`, which the loaded slice cannot resolve (a
    // column deleted in another window, or a slice that has not refreshed). An
    // edge to a node id that does not exist renders NOTHING in xyflow, so the
    // honest alternative is a node that says so — otherwise the broken edge is
    // invisible, which is the opposite of what a read-only canvas is for.
    const { nodes, edges } = layoutWorkflowGraph([
      column("doing", { nextSlugs: ["archived"] }),
    ]);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual(["doing->archived"]);
    const ghost = nodes.find((n) => n.id === "archived");
    expect(ghost).toBeTruthy();
    expect(ghost!.type).toBe("missing");
    expect(ghost!.data.slug).toBe("archived");
    // The real column is NOT a dead end — it has an edge, it just leads somewhere
    // the read cannot name. Marking it dead would tell the person to go configure
    // a destination they already configured.
    expect(nodes.find((n) => n.id === "doing")!.data.deadEnd).toBe(false);
    // And it is labelled by its SLUG, which is all the read has.
    expect(nodes.find((n) => n.id === "doing")!.data.nextLabels).toEqual(["archived"]);
  });

  it("resolves a real target to its LABEL for the node's description", () => {
    const { nodes } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: ["doing"] }),
      column("doing"),
    ]);
    expect(nodes.find((n) => n.id === "backlog")!.data.nextLabels).toEqual(["Doing"]);
  });
});

describe("layoutWorkflowGraph — degenerate input", () => {
  it("yields an empty graph for no columns, rather than a stray node", () => {
    // The store's "this Space has no stages" state. The canvas renders its own
    // sentence for it; the layout must not draw a box for nothing.
    expect(layoutWorkflowGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it("ignores a self-edge, which would otherwise draw a line to its own box", () => {
    // Nothing validates `next_slugs` against the row's OWN slug on the write
    // path, so a self-edge is reachable data. dagre throws on a self-edge in a
    // ranked graph, so dropping it is what keeps the canvas from blanking.
    const { edges } = layoutWorkflowGraph([
      column("doing", { nextSlugs: ["doing"] }),
      column("done"),
    ]);
    expect(edges).toEqual([]);
  });

  it("draws one edge per distinct pair when a row repeats a slug", () => {
    // `set_stage_next` validates that each entry names a real column, not that
    // the list is free of repeats. Two identical ids in one `edges` array make
    // xyflow render one and warn, so the layout deduplicates.
    const { edges } = layoutWorkflowGraph([
      column("doing", { nextSlugs: ["done", "done"] }),
      column("done"),
    ]);
    expect(edges.map((e) => e.id)).toEqual([edgeIdOf("doing", "done")]);
  });
});
