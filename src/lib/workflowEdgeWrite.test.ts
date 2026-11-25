import { describe, expect, it } from "vitest";

import { canConnectStages, nextSlugsAfterConnect } from "./workflowEdgeWrite";
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
