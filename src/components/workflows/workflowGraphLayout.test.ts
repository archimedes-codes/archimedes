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
  ready: false,
  readySessions: [],
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

describe("layoutWorkflowGraph — the STORE owns a position a person arranged", () => {
  /** The dagre answer for the same column set, as the baseline the stored pair is
   *  compared against. Computed from the SAME builder with no position overridden, so
   *  a stored value that merely coincided with dagre's could not pass for an override. */
  const dagreOf = (
    columns: StageWithTasks[],
    slug: string,
  ): { x: number; y: number } => {
    const node = layoutWorkflowGraph(columns).nodes.find((n) => n.id === slug)!;
    return node.position;
  };

  it("uses the stored pair verbatim for a node that has one", () => {
    // THE ANTI-SNAP-BACK RULE AT ITS SOURCE. A drag writes the drop point through
    // `set_stage_position`, the store echoes it onto the row, and the layout effect
    // re-derives from that row — so if the derived position were dagre's again, the
    // node would jump back the instant the write landed. The pair is returned
    // EXACTLY, not approximately, and not merged with dagre's.
    const columns = [
      column("backlog", { positionX: -1234.5, positionY: 777 }),
      column("todo", { nextSlugs: [] }),
    ];
    const { nodes } = layoutWorkflowGraph(columns);
    expect(nodes.find((n) => n.id === "backlog")!.position).toEqual({
      x: -1234.5,
      y: 777,
    });
    // And the stored value is NOT what dagre would have said, so the assertion above
    // cannot be satisfied by a layout that ignores the columns' own fields.
    expect(dagreOf([column("backlog"), column("todo", { nextSlugs: [] })], "backlog")).not.toEqual({
      x: -1234.5,
      y: 777,
    });
  });

  it("treats a HALF pair as unpositioned, which is the reading the wire type allows", () => {
    // `positionX`/`positionY` are read as a PAIR (`set_stage_position` takes both or
    // neither and refuses one), and `StageDto.positionX`'s own doc says a reader that
    // finds half a pair "may treat the node as unpositioned". A layout that read
    // `positionX ?? dagre` would put the node at a stored X and a dagre Y — the exact
    // half-positioned state the write refuses to store, painted on screen.
    const onlyX = layoutWorkflowGraph([
      column("backlog", { positionX: 500, positionY: null }),
      column("todo", { nextSlugs: [] }),
    ]);
    const plain = layoutWorkflowGraph([column("backlog"), column("todo", { nextSlugs: [] })]);
    expect(onlyX.nodes.find((n) => n.id === "backlog")!.position).toEqual(
      plain.nodes.find((n) => n.id === "backlog")!.position,
    );

    const onlyY = layoutWorkflowGraph([
      column("backlog", { positionX: null, positionY: 500 }),
      column("todo", { nextSlugs: [] }),
    ]);
    expect(onlyY.nodes.find((n) => n.id === "backlog")!.position).toEqual(
      plain.nodes.find((n) => n.id === "backlog")!.position,
    );
  });

  it("reads `0` as a placed coordinate and not as absence", () => {
    // The column has no SQL `DEFAULT`, so `null` is the only "never arranged" state and
    // `0` is a coordinate somebody pinned. `positionX || dagreX` — the shape that reads
    // naturally — loses every node arranged on the left or top edge, silently and
    // permanently.
    //
    // THE PAIR IS PINNED TO THE SECOND COLUMN AND THAT IS LOAD-BEARING: dagre places
    // the leftmost box at x = 0 itself, so a `(0, 0)` stored on `backlog` would come
    // back `(0, 0)` from a layout that ignored the stored pair entirely. On `todo` the
    // two answers differ, and the guard below states that.
    const columns = [
      column("backlog"),
      column("todo", { nextSlugs: [], positionX: 0, positionY: 0 }),
    ];
    const { nodes } = layoutWorkflowGraph(columns);
    expect(nodes.find((n) => n.id === "todo")!.position).toEqual({ x: 0, y: 0 });
    expect(
      layoutWorkflowGraph([column("backlog"), column("todo", { nextSlugs: [] })]).nodes.find(
        (n) => n.id === "todo",
      )!.position,
    ).not.toEqual({ x: 0, y: 0 });
  });

  it("lays out the node that has NO stored pair by dagre, beside the one that has one", () => {
    // THE MIXED CASE. One arranged column and one never-arranged: the un-arranged one
    // still has to land somewhere sane, so dagre runs over the WHOLE graph and the
    // stored node is overridden afterwards. Both answers are finite and the two boxes
    // are not stacked on the same point — a layout that returned `{0, 0}` for the
    // un-positioned node would be a node at the origin under the arranged one.
    const columns = [
      column("backlog", { positionX: 2000, positionY: 1500 }),
      column("todo", { nextSlugs: [] }),
    ];
    const { nodes } = layoutWorkflowGraph(columns);
    const todo = nodes.find((n) => n.id === "todo")!.position;
    expect(Number.isFinite(todo.x) && Number.isFinite(todo.y)).toBe(true);
    expect(nodes.find((n) => n.id === "backlog")!.position).toEqual({ x: 2000, y: 1500 });
    expect(todo).not.toEqual({ x: 0, y: 0 });
    // And the un-arranged node's answer is dagre's for the SAME graph with nothing
    // arranged — the position-free twin, not this same call (a cross-check against the
    // implementation's own output would be the self-referential pin
    // `WorkflowsCanvas.test.tsx`'s node-box case exists to avoid).
    expect(todo).toEqual(
      dagreOf([column("backlog"), column("todo", { nextSlugs: [] })], "todo"),
    );
  });

  it("returns the stored positions for every node when every node has one", () => {
    // Every column arranged ⇒ dagre's answer is unused. THE PIN IS THE RESULT, and it
    // is stated as such rather than over-claimed: "skip dagre" and "run dagre then
    // override" return the SAME array here, so nothing in a pure-layout test can tell
    // the two branches apart. What this case DOES catch is a layout that averages,
    // clamps or re-ranks stored positions — which is why the fixture is deliberately
    // OUTRANKING: `done` sits left of `backlog`, the opposite of what the ranker would
    // choose, and a ranker that survived into the output would move one of them.
    const columns = [
      column("backlog", { positionX: 900, positionY: 40 }),
      column("todo", { nextSlugs: ["done"], positionX: 40, positionY: 300 }),
      column("done", { nextSlugs: [], positionX: -800, positionY: -250 }),
    ];
    const { nodes } = layoutWorkflowGraph(columns);
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 900, y: 40 },
      { x: 40, y: 300 },
      { x: -800, y: -250 },
    ]);
  });

  it("keeps a GHOST node on dagre, since a ghost has no row to store a position on", () => {
    // A ghost is an edge whose target column the read cannot name. It is not a column,
    // so it has no `position_x` — and because it can never carry a stored pair it also
    // makes "every node is arranged" false, which is what keeps dagre running to place
    // it. Without that, a hand-arranged board with one stale edge would put the ghost
    // at the origin with nothing laid out around it.
    const { nodes } = layoutWorkflowGraph([
      column("doing", { nextSlugs: ["archived"], positionX: 10, positionY: 20 }),
    ]);
    const ghost = nodes.find((n) => n.id === "archived")!;
    expect(ghost.type).toBe("missing");
    expect(Number.isFinite(ghost.position.x) && Number.isFinite(ghost.position.y)).toBe(
      true,
    );
    expect(ghost.position).not.toEqual({ x: 0, y: 0 });
    expect(nodes.find((n) => n.id === "doing")!.position).toEqual({ x: 10, y: 20 });
  });

  it("marks the ghost node NOT draggable, because its position is not a fact anybody can store", () => {
    // `onNodeDragStop` writes the drop point through `set_stage_position`, which
    // refuses a slug the Space does not have. A draggable ghost would therefore be a
    // drag that always fails and always snaps back — the failure the whole position
    // rule exists to avoid — so the flag is off at the source instead.
    const { nodes } = layoutWorkflowGraph([
      column("doing", { nextSlugs: ["archived"] }),
    ]);
    expect(nodes.find((n) => n.id === "archived")!.draggable).toBe(false);
    // A real column stays draggable: it is `undefined` and not `true`, so a person can
    // still override it per node and the canvas-level `nodesDraggable` decides.
    expect(nodes.find((n) => n.id === "doing")!.draggable).toBeUndefined();
  });
});

describe("layoutWorkflowGraph — the edges (ADR 0099's three answers)", () => {
  it("draws the configured edges in the row's OWN order", () => {    // `doing` is configured to stop (`[]`) so it contributes no edge of its own
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
    // invisible, which is the opposite of what a canvas that claims to show the
    // chain is for.
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

describe("layoutWorkflowGraph — an INFERRED edge looks unlike a DRAWN one", () => {
  /* The hazard this marks: `nextStepSlugs` answers the `sortOrder + 1` fallback for a
   * `nextSlugs: null` column, and the canvas drew that fallback as a wire PIXEL-IDENTICAL
   * to a stored edge. Both looked like "this is where the column goes", but they are two
   * different contracts — `NULL` permits ANY outgoing move under Strict workflow and
   * `["research"]` permits only `research` (ADR 0099), and per known-gaps §8 the flip is
   * not reversible through the UI. A person cannot protect a distinction they cannot see,
   * so the inferred wire is dashed and classed and the stored one is not.
   *
   * THE ASSERTIONS ARE LITERALS AND NOT THE PRODUCTION CONSTANTS, on purpose. Reading the
   * marker back off the module that set it is the self-referential pin
   * `WorkflowsCanvas.test.tsx`'s node-box case exists to avoid: it would stay green if the
   * marker were renamed to something a stylesheet does not know, and the dash is only a
   * dash if the sheet draws one. */

  it("marks the sortOrder + 1 fallback edge as implicit, by class and by dash", () => {
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: null }),
      column("todo", { nextSlugs: null }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.className).toBe("workflow-edge-implicit");
    // The dash is the VISIBLE half — a class a stylesheet ignores would leave the two
    // wires identical again, which is the exact defect this exists to remove.
    expect(edges[0]!.style).toMatchObject({ strokeDasharray: expect.any(String) });
    expect(String(edges[0]!.style!.strokeDasharray).length).toBeGreaterThan(0);
  });

  it("does NOT mark an edge the row's own nextSlugs names, so the two are distinguishable", () => {
    // THE PAIR THIS WHOLE BLOCK DEPENDS ON. Marking every edge implicit would be the same
    // blindness with a different label, so the assertion is that a stored edge carries
    // NEITHER marker while an inferred one from the same fixture carries both.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: ["todo"] }),
      column("todo", { nextSlugs: null }),
      column("doing", { nextSlugs: null }),
    ]);
    const stored = edges.find((e) => e.id === edgeIdOf("backlog", "todo"))!;
    const inferred = edges.find((e) => e.id === edgeIdOf("todo", "doing"))!;
    expect(stored.className).toBeUndefined();
    expect(stored.style).toBeUndefined();
    expect(inferred.className).toBe("workflow-edge-implicit");
    expect(inferred.style).toMatchObject({ strokeDasharray: expect.any(String) });
  });

  it("marks a GHOST edge implicit when its source is unconfigured, and not when it is stored", () => {
    // A ghost is about the TARGET's resolvability and says nothing about whether the
    // SOURCE was configured — so the marker follows `nextSlugs` and not the ghostliness.
    // The second fixture is the reason this cannot be "every edge to a ghost is dashed":
    // a configured column with a stale destination is a wire the person DID draw.
    const configuredToAGhost = layoutWorkflowGraph([
      column("backlog", { nextSlugs: null }),
      column("todo", { nextSlugs: ["archived"] }),
    ]);
    expect(
      configuredToAGhost.edges.find((e) => e.id === edgeIdOf("todo", "archived"))!
        .className,
    ).toBeUndefined();

    const inferredToAGhost = layoutWorkflowGraph([
      column("todo", { nextSlugs: null }),
      column("doing", { nextSlugs: ["archived"] }),
    ]);
    expect(
      inferredToAGhost.edges.find((e) => e.id === edgeIdOf("todo", "doing"))!.className,
    ).toBe("workflow-edge-implicit");
  });
});

describe("layoutWorkflowGraph — the edge NAME (D6/D13: two edges, one destination)", () => {
  /* `next_outcomes` is positional to `next_slugs`, so `["done","done"]` labelled
   * `["failed","success"]` is legal data — `set_stage_next` validates each element names a
   * real column, never that the list is a set — and `advise.rs` routes a claim to "the
   * FIRST edge whose label is the outcome it named". None of that reaches a person until
   * the canvas can DRAW both edges, which is what this block is about.
   *
   * The hazard was structural and it was silent: `edgeIdOf` was `${from}->${to}` and the
   * hop loop deduped on it, so two edges to one destination collapsed into one wire with
   * no warning anywhere. A person who labelled both edges was looking at one of them and
   * had no way to tell which. */

  it("draws TWO edges for two destinations that are the same column with different names", () => {
    // THE HIGHEST-VALUE CASE IN THIS TASK. Before the outcome joined the id, `seen`
    // swallowed the second hop and this fixture drew one wire: the `success` route
    // existed in the database, fired on a claim, and was invisible on the picture the
    // person uses to reason about their workflow.
    const { edges } = layoutWorkflowGraph([
      column("backlog", {
        nextSlugs: ["done", "done"],
        nextOutcomes: ["failed", "success"],
      }),
      column("done", { nextSlugs: [] }),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual(["done", "done"].map(() => "backlog->done"));
    // Two DISTINCT ids, which is the whole point — a duplicate id is what makes xyflow
    // render one edge and warn.
    expect(new Set(edges.map((e) => e.id)).size).toBe(2);
    expect(edges.map((e) => e.id)).toEqual([
      edgeIdOf("backlog", "done", "failed"),
      edgeIdOf("backlog", "done", "success"),
    ]);
  });

  it("labels the edge with the outcome it carries", () => {
    // `label` is a first-class `EdgeLabelOptions` field in `@xyflow/react@13.0.3` and the
    // builtin `default` edge renders it through `BaseEdge` → `EdgeText`, so no custom edge
    // component is needed — and `WorkflowsCanvas.tsx` passes no `edgeTypes`, which is what
    // makes that true rather than aspirational.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: ["done"], nextOutcomes: ["handoff"] }),
      column("done", { nextSlugs: [] }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.label).toBe("handoff");
  });

  it("leaves `label` UNSET for an unlabelled edge — an unlabelled board is byte-identical", () => {
    // THE ACCEPTANCE CRITERION, pinned as a SHAPE and not as a claim. `label: undefined`
    // and no `label` key at all are different objects, and the second is what the canvas
    // tests below compare against literal DOM attributes. Spreading a `label: undefined`
    // would put a key on every edge of every existing board, and the assertion that
    // catches that is `toEqual` on the whole edge object.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: ["done"] }),
      column("done", { nextSlugs: [] }),
    ]);
    expect(edges).toHaveLength(1);
    expect(Object.keys(edges[0]!).sort()).toEqual(["id", "source", "target"]);
    expect(edges[0]!.label).toBeUndefined();
  });

  it("answers the unchanged `${from}->${to}` when no outcome is given", () => {
    // The THIRD copy of this pin, and the load-bearing one: the canvas tests name edge
    // ids as literal DOM attributes (`rf__edge-backlog->todo`,
    // `.react-flow__edge[data-id='backlog->doing']`) across two files. Those pins staying
    // green IS the proof that an unlabelled board renders identically to today — this
    // assertion is the unit-level statement of the same fact.
    expect(edgeIdOf("backlog", "done")).toBe("backlog->done");
    expect(edgeIdOf("backlog", "done", null)).toBe("backlog->done");
    // And a name makes it distinct, deterministically, from data that cannot collide
    // with it: `->` and `:` are not legal in a slug-derived id otherwise.
    expect(edgeIdOf("backlog", "done", "failed")).toBe("backlog->done:failed");
    expect(edgeIdOf("backlog", "done", "failed")).not.toBe(edgeIdOf("backlog", "done"));
  });

  it("still collapses two UNLABELLED edges to one destination (the id really would collide)", () => {
    // The existing dedupe pin, restated beside the new one so the reader sees the
    // boundary: the outcome joins the id, it does not abolish the dedupe. Two unnamed
    // edges to `done` have ONE id, xyflow would render one and warn, and the layout is
    // where that is caught.
    const { edges } = layoutWorkflowGraph([
      column("doing", { nextSlugs: ["done", "done"] }),
      column("done"),
    ]);
    expect(edges.map((e) => e.id)).toEqual([edgeIdOf("doing", "done")]);
  });

  it("names a partially-labelled pair without shifting either label", () => {
    // `[null, "blocked"]` is a real configuration (`StageDto.nextOutcomes`'s own docblock
    // says a partially-labelled graph must not degrade to unlabelled). Position is the
    // meaning, so the FIRST edge stays unnamed and the SECOND carries `blocked` — a
    // shifted label is a card that advances on the wrong claim.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: ["todo", "doing"], nextOutcomes: [null, "blocked"] }),
      column("todo", { nextSlugs: [] }),
      column("doing", { nextSlugs: [] }),
    ]);
    expect(edges.map((e) => e.label)).toEqual([undefined, "blocked"]);
    expect(edges.map((e) => e.id)).toEqual([
      edgeIdOf("backlog", "todo"),
      edgeIdOf("backlog", "doing", "blocked"),
    ]);
  });

  it("does not invent a label from a short cell", () => {
    // A cell shorter than the slug list means "the edges past its end are unlabelled" —
    // `advise.rs` reads it that way and so must the picture. Padding index 1 with anything
    // other than "no label" would name an edge its owner never named.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: ["todo", "doing"], nextOutcomes: ["done"] }),
      column("todo", { nextSlugs: [] }),
      column("doing", { nextSlugs: [] }),
    ]);
    expect(edges.map((e) => e.label)).toEqual(["done", undefined]);
  });

  it("draws no label for an inferred edge, because a `null` row owns no positions to label", () => {
    // A `nextSlugs: null` row has no list for `next_outcomes` to be positional TO, so its
    // one wire — the inferred `sortOrder + 1` neighbour — cannot carry a label. This pins
    // the two markers stay independent: `implicit` answers "did the row name this edge at
    // all", the label answers "what must a claim say to take it", and an inferred wire is
    // unnamed, dashed and byte-identical to today's.
    const { edges } = layoutWorkflowGraph([
      column("backlog", { nextSlugs: null }),
      column("todo", { nextSlugs: [] }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.className).toBe("workflow-edge-implicit");
    expect(edges[0]!.label).toBeUndefined();
  });

  it("puts the name in the node's accessible description too", () => {
    // `nextLabels` becomes the node's `aria-label` (`WorkflowNodes.tsx`: "Leads to …").
    // Two edges to `Done` reading "Leads to Done, Done" is worse than useless to a
    // screen-reader user — it is the same invisible-collapse defect with a different
    // sensor. An unlabelled edge keeps contributing its bare label, so every existing
    // board reads exactly as it does today.
    const { nodes } = layoutWorkflowGraph([
      column("backlog", {
        nextSlugs: ["done", "done"],
        nextOutcomes: ["failed", "success"],
      }),
      column("done", { nextSlugs: [] }),
    ]);
    expect(nodes.find((n) => n.id === "backlog")!.data.nextLabels).toEqual([
      "Done (failed)",
      "Done (success)",
    ]);
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
