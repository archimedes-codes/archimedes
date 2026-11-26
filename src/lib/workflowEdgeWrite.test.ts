import { describe, expect, it } from "vitest";

import {
  canConnectStages,
  EDGE_OUTCOME_SUGGESTIONS,
  edgeOutcomesOf,
  nextOutcomesAfterConnect,
  nextSlugsAfterConnect,
} from "./workflowEdgeWrite";
import type { StageDto, StageWithTasks } from "./tauri";

/**
 * The write behind **drawing an edge on the Workflows canvas**, as a pure function.
 *
 * ## WHY THIS IS A MODULE AND NOT A HANDLER IN THE CANVAS
 *
 * Two surfaces make this write and they must not spell the rule twice:
 *
 *  - `NodeDestinations` inside the settings panel — a `Select` and a keyboard;
 *  - a drag from one node's source handle to another's target handle.
 *
 * The panel already owned the rule (`NodeSettingsBody`'s add-destination), the canvas
 * is the second reader, and the three-state rule below is exactly the kind of thing
 * that drifts when it is re-spelled: `workflowGraph.ts` exists because the READ of
 * `next_slugs` was spelled three times. This is the same extraction, on the write side.
 *
 * The canvas keeps a SECOND reason for the predicate: `isValidConnection` is what makes
 * a refused drag LOOK refused while the pointer is still down. A guard that only runs at
 * the drop is a silent nothing — the gesture ends, nothing changes, and the reason lives
 * nowhere. So the canvas asks the same function twice, once to paint and once to write.
 *
 * ## The three answers `nextSlugs` holds, and the one collapse this refuses (ADR 0099)
 *
 * `null` is UNCONFIGURED and `[]` is CONFIGURED-AND-CLOSED. Appending to either yields
 * the SAME stored list — `[target]` — and that is not an accident to smooth over, it is
 * the coherence the pill and the auto-chain read: `nextStepSlugs` returns the row's own
 * list when there is one, so a column whose first-ever destination was drawn by drag has
 * exactly the destinations the person drew, and nothing else. There is no arm here that
 * writes `null`, and none that writes `[]`; a drag always names a destination.
 *
 * ## What is REFUSED rather than dropped
 *
 *  - a SELF-LOOP. `set_stage_next` refuses a column's own slug with `kind: "not_found"`,
 *    so drawing one would paint an edge the server rejects and then revert it — the
 *    canvas would be showing a chain for one frame. Refused at the handle instead.
 *  - a target the loaded slice CANNOT name (a ghost node). Same argument: the command
 *    refuses an unknown slug, so the drag can only fail.
 *  - a destination the list ALREADY holds. Not a refusal with a message — a duplicate
 *    would make xyflow render one edge and warn, and the person asked for the edge that
 *    is already there. The caller writes nothing.
 *
 * ADR 0099's `[]` is deliberately NOT refused: appending to it is the sentence
 * "this column led nowhere, and now it leads here", which is a real thing a person does
 * by dragging out of a box marked *Leads nowhere*.
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

const column = (slug: string, over: Partial<StageDto> = {}): StageWithTasks => ({
  stage: stage(slug, {
    sortOrder: ["backlog", "todo", "doing", "done"].indexOf(slug),
    ...over,
  }),
  tasks: [],
});

const board = (...columns: StageWithTasks[]): StageWithTasks[] => columns;

describe("canConnectStages", () => {
  it("refuses the drag that would only DRAW THE FALLBACK BACK — the no-op gesture", () => {
    // THE HAZARD THIS REFUSAL EXISTS FOR, and the one the reviewer measured rather than
    // inferred. `backlog.nextSlugs` is `null`, so the canvas already drew the
    // `sortOrder + 1` wire to `todo` — as an INFERRED edge (see `IMPLICIT_EDGE_CLASS`),
    // which is the same wire `nextStepSlugs` answers. Dragging onto `todo` therefore
    // changes NOTHING ON SCREEN while `nextSlugsAfterConnect` writes `["todo"]`, and on a
    // `board_strict = 1` Space that is a contract flip: `NULL` permits ANY outgoing move
    // and `["todo"]` permits only `todo` (ADR 0099), and known-gaps §8 records the flip is
    // NOT reversible through the UI (`[]` is not `NULL`). A gesture whose visible effect is
    // nil and whose stored effect is a narrowing is the worst possible combination, and
    // refusing it costs nothing — the wire the person is aiming at is already drawn.
    const columns = board(column("backlog"), column("todo"));
    expect(canConnectStages(columns, "backlog", "todo")).toBe(false);
    expect(nextSlugsAfterConnect(columns, "backlog", "todo")).toBeNull();
  });

  it("still ALLOWS a genuine new edge out of an unconfigured column, which is the feature", () => {
    // THE OTHER ARM, and the reason the refusal above is a verdict and not a ban on
    // configuring by drag. `doing` is NOT the fallback (`todo` is), so this drag removes
    // a wire the person can now see is inferred and binds the column to one destination.
    // That is a real edit with a visible before-and-after, so it is allowed — with the
    // consequence disclosed in this module's header, ADR 0120 and known-gaps §10.
    const columns = board(
      column("backlog"),
      column("todo", { nextSlugs: [] }),
      column("doing"),
    );
    expect(canConnectStages(columns, "backlog", "doing")).toBe(true);
    expect(nextSlugsAfterConnect(columns, "backlog", "doing")).toEqual(["doing"]);
  });

  it("refuses the fallback for the column whose fallback is NOT the next array element", () => {
    // The refusal is computed from `nextStepSlugs`, not from array adjacency, and this is
    // what separates the two. `todo` is at `sortOrder 3`, so `backlog`'s fallback is
    // `doing` (sortOrder 1 — see the fixture's own overrides): a rule spelled
    // `columns[index + 1]` would refuse `todo` and allow `doing`, which is backwards.
    const columns = [
      { ...column("backlog"), stage: column("backlog").stage },
      { ...column("doing"), stage: { ...column("doing").stage, sortOrder: 1 } },
      { ...column("todo"), stage: { ...column("todo").stage, sortOrder: 3 } },
    ];
    expect(canConnectStages(columns, "backlog", "doing")).toBe(false);
    expect(canConnectStages(columns, "backlog", "todo")).toBe(true);
  });

  it("does NOT refuse the fallback for a column that IS configured (only `null` is unconfigured)", () => {
    // `[]` is CONFIGURED-AND-CLOSED and `["x"]` is CONFIGURED. Neither is "the graph
    // inferred this", so neither has a fallback to re-draw, and refusing here would break
    // the `[]` case this module's header insists is legal. `["x"]`'s arm is the duplicate
    // refusal; `[]`'s is the case two lines below.
    const closed = board(column("backlog", { nextSlugs: [] }), column("todo"));
    expect(canConnectStages(closed, "backlog", "todo")).toBe(true);

    const configured = board(column("backlog", { nextSlugs: ["doing"] }), column("todo"));
    // `todo` is not in the list and is not what a `null` fallback would have produced,
    // because there is no fallback once the row owns its list.
    expect(canConnectStages(configured, "backlog", "todo")).toBe(true);
  });

  it("allows a hop to another column of this board", () => {
    // THE POSITIVE ARM, kept honest after the no-op refusal landed: `todo` is `backlog`'s
    // `sortOrder + 1` fallback, so this fixture used to assert `true` for exactly the
    // gesture the case above refuses. `doing` is not, so the assertion is now about
    // "another column" and not accidentally about the fallback.
    expect(
      canConnectStages(
        board(column("backlog"), column("todo"), column("doing")),
        "backlog",
        "doing",
      ),
    ).toBe(true);
  });

  it("refuses a self-loop, which the server refuses too", () => {
    expect(canConnectStages(board(column("backlog")), "backlog", "backlog")).toBe(false);
  });

  it("refuses a target the loaded slice cannot name", () => {
    expect(canConnectStages(board(column("backlog")), "backlog", "archived")).toBe(false);
    // …and an unknown SOURCE, which the drag cannot produce (a connection starts on a
    // node) but the signature has to answer anyway.
    expect(canConnectStages(board(column("backlog")), "ghost", "backlog")).toBe(false);
  });

  it("refuses a destination the list already holds", () => {
    expect(
      canConnectStages(
        board(column("backlog", { nextSlugs: ["todo"] }), column("todo")),
        "backlog",
        "todo",
      ),
    ).toBe(false);
  });

  it("allows the hop out of a column configured to lead nowhere", () => {
    // `[]` is a decision to STOP, and dragging out of it is a decision to stop stopping.
    expect(
      canConnectStages(board(column("backlog", { nextSlugs: [] }), column("todo")), "backlog", "todo"),
    ).toBe(true);
  });

  it("allows a second destination beside the ones already there", () => {
    // Fan-out is legal data; `NodeDestinations` says out loud which of the two the
    // auto-chain actually follows.
    expect(
      canConnectStages(
        board(column("backlog", { nextSlugs: ["todo"] }), column("todo"), column("doing")),
        "backlog",
        "doing",
      ),
    ).toBe(true);
  });

  it("answers false for a board that was never loaded", () => {
    // `undefined` is "no slice", not "no columns": nothing on it can be named, so
    // nothing can be connected.
    expect(canConnectStages(undefined, "backlog", "todo")).toBe(false);
  });
});

describe("nextSlugsAfterConnect", () => {
  it("turns the `null` (unconfigured) case into the one-item list the drag drew", () => {
    // THE `null → [a]` CASE, and the DISCLOSURE that belongs with it. `null` is
    // UNCONFIGURED and the fallback is the column at `sortOrder + 1` — `todo` here. So the
    // target must be a column the fallback is NOT (`doing`), because drawing the fallback
    // itself is the refused no-op the case above names.
    //
    // What this write does, stated plainly because it is wider than it looks: the moment
    // this lands the column IS configured, and it is configured to exactly the one edge on
    // the canvas. Three consequences follow and none of them is visible in the payload:
    //  - the `sortOrder + 1` wire the canvas was drawing as INFERRED disappears — the
    //    person has just deleted a step their cards were being sent to, one drag earlier;
    //  - `nextStepSlugs` now answers the row's own list, so the launch pill and the
    //    auto-chain follow `doing` and not `todo`;
    //  - under Strict workflow the column goes from "any column may follow" to "only
    //    `doing`", and known-gaps §8 says that is not reversible through the UI.
    // That is the feature — a drag that configures a column has to be able to do it — but
    // it is why the inferred wire is drawn dashed (`IMPLICIT_EDGE_CLASS`) so the wire being
    // removed is visible as an inferred one before the drop.
    expect(
      nextSlugsAfterConnect(
        board(column("backlog"), column("todo", { nextSlugs: [] }), column("doing")),
        "backlog",
        "doing",
      ),
    ).toEqual(["doing"]);
  });

  it("appends to an existing list, in the row's order, with the new one last", () => {
    // Order is render order and `[0]` is the live edge (ADR 0099), so an append must not
    // become a prepend: a drag onto a second column must not silently STEAL the head.
    expect(
      nextSlugsAfterConnect(
        board(column("backlog", { nextSlugs: ["todo"] }), column("todo"), column("doing")),
        "backlog",
        "doing",
      ),
    ).toEqual(["todo", "doing"]);
  });

  it("appends to `[]` without ever writing `null`", () => {
    expect(
      nextSlugsAfterConnect(
        board(column("backlog", { nextSlugs: [] }), column("todo")),
        "backlog",
        "todo",
      ),
    ).toEqual(["todo"]);
  });

  it("answers null for every refused case, so the caller writes nothing", () => {
    const columns = board(column("backlog", { nextSlugs: ["todo"] }), column("todo"));
    expect(nextSlugsAfterConnect(columns, "backlog", "backlog")).toBeNull();
    expect(nextSlugsAfterConnect(columns, "backlog", "ghost")).toBeNull();
    expect(nextSlugsAfterConnect(columns, "backlog", "todo")).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * THE EDGE NAME (D6 / D13) — an OPTIONAL label on an outgoing edge
 * ---------------------------------------------------------------------------
 *
 * `stages.next_outcomes` is a second TEXT column POSITIONAL to `next_slugs`:
 * element `i` names the edge at `i`, and `null` means that edge carries no label.
 * It exists because ADR 0099's fan-out could not be ROUTED: `nextStepOf` follows
 * `[0]` and nothing else, so a second destination was a permission and never a
 * step. `mark_done` now answers with the column whose edge carries the name the
 * claim gave it (`src-tauri/src/storage/db/advise.rs`), which makes a label the
 * only way a person can reach D6's routing at all.
 *
 * TWO THINGS THIS MAKES LEGAL DATA THAT WAS PREVIOUSLY REFUSED, and both are
 * pinned below rather than left to the reader:
 *
 *  - **the same destination twice.** `set_stage_next` validates that every
 *    element is a real column and is not the column itself; it never checks that
 *    the list has no repeats. Two edges to `done`, one named `failed` and one
 *    named `success`, is the shape a person actually wants from a review column.
 *    The unlabelled duplicate stays refused — two edges with the SAME id is what
 *    makes xyflow render one and warn — so the refusal is now about the
 *    collision, not about the destination.
 *  - **a second edge to the fallback column.** `canConnectStages` refuses
 *    re-drawing the inferred wire because nothing on screen would change. A
 *    NAMED edge to that same column changes the picture (it gains a label) and
 *    it is a real second edge, so the no-op argument does not hold.
 *
 * AND ONE THING IT MUST NOT DO: clear the labels that are already there.
 * `setStageNext`'s 4th argument is optional and its default paints one `null` per
 * edge — so a caller that appends a destination and omits the labels silently
 * un-names every edge the person had already named. That is data loss dressed as
 * an add, and `nextOutcomesAfterConnect` exists so neither surface can do it.
 */

/** The nine names `mark_done` advertises. Read from the SPEC the model is shown —
 *  `src-tauri/src/agent/host_tools/specs.rs`, the `mark_done` `ToolSpec`'s
 *  `parameters.properties.outcome.enum` — because a suggestion the tool would
 *  refuse is a control that can only fail. `ready` and `review` are absent ON
 *  PURPOSE: both contain the substring `read`, which the host-tool name ban
 *  forbids, and the spec's own comment records that measurement. */
const ENUM = [
  "done",
  "failed",
  "error",
  "success",
  "blocked",
  "partial",
  "finished",
  "complete",
  "handoff",
];

describe("EDGE_OUTCOME_SUGGESTIONS — the vocabulary the tool actually accepts", () => {
  it("is exactly the enum mark_done advertises, as a closed set", () => {
    // Compared as a SET: the order is this module's business (it is the order the
    // picker prints), the MEMBERSHIP is `specs.rs`'s.
    expect([...EDGE_OUTCOME_SUGGESTIONS].sort()).toEqual([...ENUM].sort());
  });

  it("carries no name the host-tool substring ban forbids", () => {
    // `ready` and `review` both contain `read` and are therefore NOT in the spec's
    // enum. A picker that offered one would let a person name an edge no claim can
    // ever carry — an edge that looks routed and never routes is worse than no edge.
    for (const name of EDGE_OUTCOME_SUGGESTIONS) {
      expect(name).not.toMatch(/read/i);
    }
    expect(EDGE_OUTCOME_SUGGESTIONS).not.toContain("ready");
    expect(EDGE_OUTCOME_SUGGESTIONS).not.toContain("review");
  });
});

describe("edgeOutcomesOf — the positional read, spelled once", () => {
  it("pads a short cell with nulls, which is the storage layer's own reading", () => {
    // `advise.rs`: "A short `next_outcomes` cell means the edges past its end are
    // unlabelled". Padding to the slug list's length is how that reading becomes an
    // array a caller can index without a `.get()` arm — and it INVENTS NOTHING,
    // because `null` is the same fact the absent element means.
    const s = stage("backlog", {
      nextSlugs: ["todo", "doing", "done"],
      nextOutcomes: ["failed"],
    });
    expect(edgeOutcomesOf(s)).toEqual(["failed", null, null]);
  });

  it("answers one null per edge for a column that labels nothing", () => {
    expect(edgeOutcomesOf(stage("backlog", { nextSlugs: ["todo", "doing"] }))).toEqual([
      null,
      null,
    ]);
    expect(
      edgeOutcomesOf(stage("backlog", { nextSlugs: ["todo"], nextOutcomes: null })),
    ).toEqual([null]);
  });

  it("answers NOTHING for an unconfigured column, whose only wire is inferred", () => {
    // `nextSlugs: null` means `nextStepSlugs` falls back to `sortOrder + 1`, and that
    // neighbour is not an edge the row owns — it has no position in `next_slugs`, so
    // there is no index a label could sit at. Answering `[null]` here would hand the
    // canvas a label slot for a wire nobody drew.
    expect(edgeOutcomesOf(stage("backlog", { nextSlugs: null }))).toEqual([]);
  });

  it("keeps a partially-labelled list in its own order", () => {
    const s = stage("backlog", {
      nextSlugs: ["todo", "doing"],
      nextOutcomes: [null, "done"],
    });
    expect(edgeOutcomesOf(s)).toEqual([null, "done"]);
  });
});

describe("canConnectStages — the name makes two refusals become verdicts", () => {
  it("still refuses the destination the list holds when the new edge names nothing", () => {
    // THE UNLABELLED ARMS ARE UNCHANGED, and that is the byte-identical-board pin on
    // this side. Two edges with the same source, the same target and no name on
    // either have the same `edgeIdOf` value, which is the one case xyflow renders
    // once and warns about.
    const columns = board(column("backlog", { nextSlugs: ["todo"] }), column("todo"));
    expect(canConnectStages(columns, "backlog", "todo")).toBe(false);
    expect(canConnectStages(columns, "backlog", "todo", null)).toBe(false);
  });

  it("ALLOWS the same destination again when the new edge carries a different name", () => {
    // THE ACCEPTANCE CRITERION, at the rule level: `done` twice, named `failed` and
    // `success`, is what a review column actually means. `set_stage_next` accepts it
    // (it validates each element is a real column, never that the list is a set), so
    // refusing it here would make D6's routing unreachable from both surfaces.
    const columns = board(
      column("backlog", { nextSlugs: ["done"], nextOutcomes: ["failed"] }),
      column("done"),
    );
    expect(canConnectStages(columns, "backlog", "done", "success")).toBe(true);
  });

  it("refuses the name that edge already carries", () => {
    // The duplicate refusal moves from the destination to the PAIR: two edges to
    // `done` both named `failed` are one edge written twice, and `advise.rs` picks
    // "the FIRST edge whose label matches" — so the second could never fire. A name
    // that can never route is the dead control this repo refuses.
    const columns = board(
      column("backlog", { nextSlugs: ["done"], nextOutcomes: ["failed"] }),
      column("done"),
    );
    expect(canConnectStages(columns, "backlog", "done", "failed")).toBe(false);
  });

  it("allows a second named edge to the fallback column, which the no-op refusal does not cover", () => {
    // `todo` is `backlog`'s inferred neighbour, so an UNNAMED drop on it is the
    // refused no-op (nothing on screen changes, and the Strict contract narrows
    // behind it). A NAMED edge to `todo` is not that gesture: it lands a label on
    // the canvas, so there IS a before-and-after.
    const columns = board(column("backlog"), column("todo"));
    expect(canConnectStages(columns, "backlog", "todo")).toBe(false);
    expect(canConnectStages(columns, "backlog", "todo", "blocked")).toBe(true);
  });

  it("still refuses a self-loop and an unnameable endpoint whatever the name says", () => {
    // The name is a label, not a permission. `set_stage_next` refuses both of these
    // server-side and no label changes that.
    const columns = board(column("backlog"), column("todo"));
    expect(canConnectStages(columns, "backlog", "backlog", "done")).toBe(false);
    expect(canConnectStages(columns, "backlog", "ghost", "done")).toBe(false);
  });
});

describe("nextOutcomesAfterConnect — the label list an append writes", () => {
  it("PRESERVES the labels already on the other edges (the data-loss pin)", () => {
    // THE DECISION THIS TASK OWNS, and the reason it is not an edge case.
    // `setStageNext`'s 4th argument defaults to `slugs.map(() => null)`, i.e. OMITTING
    // IT CLEARS EVERY LABEL. So a panel that appends a destination with a 3-arg call
    // would un-name `failed` while the person was adding `success` — a side effect
    // nobody asked for and no control announced. The append therefore answers the
    // WHOLE positional list: the stored labels first, the new edge's name last.
    const columns = board(
      column("backlog", { nextSlugs: ["todo"], nextOutcomes: ["failed"] }),
      column("todo"),
      column("doing"),
    );
    expect(nextOutcomesAfterConnect(columns, "backlog", "doing", null)).toEqual([
      "failed",
      null,
    ]);
    expect(nextSlugsAfterConnect(columns, "backlog", "doing")).toEqual([
      "todo",
      "doing",
    ]);
  });

  it("appends the name it was given, last, beside the labels it kept", () => {
    const columns = board(
      column("backlog", { nextSlugs: ["todo", "doing"], nextOutcomes: ["failed", null] }),
      column("todo"),
      column("doing"),
      column("done"),
    );
    expect(nextOutcomesAfterConnect(columns, "backlog", "done", "success")).toEqual([
      "failed",
      null,
      "success",
    ]);
  });

  it("pads a short stored cell before appending, so the write is never a length mismatch", () => {
    // `set_stage_next` refuses `outcomes.length !== slugs.length` with
    // `EdgeOutcomeCount`, and the storage doc is explicit that padding is the
    // CALLER'S job (`stages.rs`: "A caller with no labels to write passes …
    // all-`None` alongside a real one"). A short cell means "unlabelled", so
    // padding with `null` writes the same fact and satisfies the arity check.
    const columns = board(
      column("backlog", { nextSlugs: ["todo", "doing"], nextOutcomes: ["failed"] }),
      column("todo"),
      column("doing"),
      column("done"),
    );
    const outcomes = nextOutcomesAfterConnect(columns, "backlog", "done", "success")!;
    expect(outcomes).toEqual(["failed", null, "success"]);
    expect(outcomes).toHaveLength(
      nextSlugsAfterConnect(columns, "backlog", "done")!.length,
    );
  });

  it("answers a one-item pair for the column that was unconfigured", () => {
    // The `null → [target]` case, labelled. Both lists go out the same length and
    // neither is `null` — a drag always names a destination, and naming it does not
    // make the list optional.
    const columns = board(
      column("backlog"),
      column("todo", { nextSlugs: [] }),
      column("doing"),
    );
    expect(nextSlugsAfterConnect(columns, "backlog", "doing")).toEqual(["doing"]);
    expect(nextOutcomesAfterConnect(columns, "backlog", "doing", "done")).toEqual([
      "done",
    ]);
  });

  it("answers null for a refused hop, so the caller writes nothing to either column", () => {
    const columns = board(
      column("backlog", { nextSlugs: ["todo"], nextOutcomes: ["failed"] }),
      column("todo"),
    );
    // The name that edge already carries, and the self-loop.
    expect(nextOutcomesAfterConnect(columns, "backlog", "todo", "failed")).toBeNull();
    expect(nextOutcomesAfterConnect(columns, "backlog", "backlog", "done")).toBeNull();
    expect(nextOutcomesAfterConnect(undefined, "backlog", "todo", "done")).toBeNull();
  });

  it("allows an UNNAMED edge beside a NAMED one to the same destination", () => {
    // THE CASE THE PAIR RULE FORCES YOU TO DECIDE, and the answer falls out of the
    // hazard `edgeIdOf` is built to avoid rather than from taste. Two edges to `todo`,
    // one labelled `failed` and one not, get DIFFERENT ids once the outcome joins the
    // id (`workflowGraphLayout.ts`), so xyflow renders BOTH and does not warn — the
    // duplicate refusal's whole reason ("two identical ids make xyflow render one and
    // warn") is simply absent here. And the pair means something: the labelled edge
    // routes the claim that names it, and the unlabelled one is what the head position
    // holds for every claim that names nothing. Refusing it would cost a person the
    // "always go to `todo`, and ALSO go to `todo` on `failed`" shape for no hazard.
    const columns = board(
      column("backlog", { nextSlugs: ["todo"], nextOutcomes: ["failed"] }),
      column("todo"),
    );
    expect(nextOutcomesAfterConnect(columns, "backlog", "todo", null)).toEqual([
      "failed",
      null,
    ]);
  });

  it("writes one null per edge when the gesture named nothing", () => {
    // A drag-to-connect has no name to give, and `null` is the ONLY spelling of
    // "this edge is unlabelled" — `undefined` is not a JSON value and `""` would be
    // a label that renders as nothing (the `promptPrefix` `""`-vs-`null` defect, one
    // column over). Note this is the APPEND's null, not a default that clears: the
    // stored labels ride along in the same list.
    const columns = board(
      column("backlog", { nextSlugs: ["todo"], nextOutcomes: ["failed"] }),
      column("todo"),
      column("doing"),
    );
    expect(nextOutcomesAfterConnect(columns, "backlog", "doing")).toEqual([
      "failed",
      null,
    ]);
  });
});

