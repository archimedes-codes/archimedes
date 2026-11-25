import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";

import { useTasks } from "./tasks";
import {
  getBoard,
  setStageAuto,
  setStagePosition,
  setStagePromptPrefix,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";
import { resetStores } from "../test/resetStores";
import { storedPositionOf } from "../components/workflows/workflowGraphLayout";

/**
 * `src/store/tasks.ts` — the ONE canvas action, `setStagePosition`, and the two
 * `StageDto` fields it rides on (`positionX` / `positionY`).
 *
 * WHY ITS OWN FILE rather than cases in `src/store/tasks.workflows.test.ts`: that
 * file is named for the WORKFLOW GRAPH — the auto-advance flag, the extra prompt
 * and the two per-Space guards. A node's screen coordinates are a different
 * subject (they say where a box is drawn; nothing about launching, advancing or
 * bounding a chain), and `docs/agents/test-counts-and-splits.md` is explicit that
 * a split is decided by SUBJECT and not by a line ratio. The size ratchet is not
 * the reason — that file is far under its gate — so the reason is the subject
 * boundary alone. What it shares with the file it sits beside is the shape.
 *
 * THE BARREL MOCK IS THE WHOLE POINT OF THE SHAPE (the note in `tasks.test.ts`
 * states the rule). It mocks the barrel by path and SPREADS `vi.importActual`,
 * overriding the CAMELCASE WRAPPER NAMES, because those are what the store imports.
 *
 * TWO RESETS in `beforeEach`, both load-bearing: `resetStores()` (whose `ALL_STORES`
 * holds `useTasks`) restores the STATE half, and `useTasks.getState().reset()` is the
 * only thing that reaches this store's module-`let` (`loadEpoch`).
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    // The three this file drives. A name the store awaits that this factory does not
    // list resolves to the REAL wrapper, which calls `invoke` and rejects in jsdom —
    // the noisy-green case the header above is about. The two `setStage*` siblings
    // are mocked because `beforeEach` seeds the board through `load` and a real
    // wrapper would write a rejection into `error` that this file's own cases read.
    setStagePosition: vi.fn(),
    setStageAuto: vi.fn(),
    setStagePromptPrefix: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures (local, as in `tasks.workflows.test.ts`).
// ---------------------------------------------------------------------------

const SPACE = "/p/alpha";

/**
 * All ELEVEN wire fields are defaulted, matching `StageDto` as it stands: the nine
 * the board and the chain already read are REQUIRED, and the two new coordinates
 * are OPTIONAL (`positionX?: number | null`) — deliberately, and
 * `src/lib/tauri/types.ts` carries the measured reason (making them required
 * reddens `tsc` in 18 files this change may not touch, and absence means the same
 * thing to the only reader that `null` does). They are spelled here anyway, set to
 * `null`, because every column of an upgraded database is in exactly that state and
 * a fixture that omitted them would hide the difference between "unpositioned" and
 * "not mentioned".
 */
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
  positionX: null,
  positionY: null,
  ...over,
});

const task = (id: string, number: number, stageSlug: string): TaskRow => ({
  id,
  spacePath: SPACE,
  number,
  title: `Card ${number}`,
  body: null,
  specPath: null,
  stageSlug,
  sortOrder: number - 1,
  createdAt: 1,
  updatedAt: 1,
});

const card = (id: string, number: number, stageSlug: string): TaskCardView => ({
  task: task(id, number, stageSlug),
  sessions: [],
  costUsd: null,
  artifactKeys: [],
});

/** A three-column board, NOTHING hand-arranged — the state every existing database
 *  is in the moment the two gates land and before anyone drags a node. */
const board = (): StageWithTasks[] => [
  { stage: stage("backlog", { sortOrder: 0 }), tasks: [card("t1", 1, "backlog")] },
  { stage: stage("doing", { sortOrder: 1 }), tasks: [card("t2", 2, "doing")] },
  { stage: stage("done", { sortOrder: 2 }), tasks: [] },
];

beforeEach(async () => {
  resetStores();
  useTasks.getState().reset();
  for (const fn of [getBoard, setStagePosition, setStageAuto, setStagePromptPrefix]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(getBoard).mockResolvedValue(board());
  // The write answers the STORED row and the store merges that row over its
  // optimistic guess, so this default ECHOES its arguments the way the Rust side
  // does. A fixed row would be merged onto whichever column a case edited, and every
  // "the slice agrees with the write" assertion below would read a fake row.
  vi.mocked(setStagePosition).mockImplementation(async (_space, slug, x, y) => ({
    ...stage(slug),
    positionX: x,
    positionY: y,
  }));
  vi.mocked(setStageAuto).mockResolvedValue(stage("doing"));
  vi.mocked(setStagePromptPrefix).mockResolvedValue(stage("doing"));
  await useTasks.getState().load(SPACE);
});

/** One column's `stage`, read out of the slice the store holds. */
const stageOf = (slug: string): StageDto | undefined =>
  (useTasks.getState().boardsBySpace[SPACE] ?? []).find(
    (c) => c.stage.slug === slug,
  )?.stage;

describe("the two position fields survive a board read (the wire mirror is real)", () => {
  it("carries `positionX`/`positionY` from the read onto the column", async () => {
    // THE MIRROR CASE, and it is about the WIRE rather than a widget: a board read
    // whose rows say "this node sits at (-120, 340)" has to arrive saying so, or the
    // canvas falls back to dagre for a node its owner arranged by hand — the exact
    // defect this feature exists to remove.
    vi.mocked(getBoard).mockResolvedValue([
      { stage: stage("doing", { positionX: -120, positionY: 340 }), tasks: [] },
    ]);
    await useTasks.getState().load(SPACE);
    expect(stageOf("doing")).toMatchObject({ positionX: -120, positionY: 340 });
  });

  it("keeps `0` distinct from `null` across the read", async () => {
    // `0` is a coordinate a person PLACED and `null` is "never arranged". A `?? 0`
    // or a `|| null` anywhere on the read path silently unpins a node someone pinned
    // to the edge, or pins one nobody moved. This is ADR 0082's `cost_usd` rule
    // (`$0.00` reported versus never reported) moved from a cost to a coordinate.
    vi.mocked(getBoard).mockResolvedValue([
      { stage: stage("a", { positionX: 0, positionY: 0 }), tasks: [] },
      { stage: stage("b", { positionX: null, positionY: null }), tasks: [] },
    ]);
    await useTasks.getState().load(SPACE);
    expect(stageOf("a")?.positionX).toBe(0);
    expect(stageOf("a")?.positionY).toBe(0);
    expect(stageOf("b")?.positionX).toBeNull();
    expect(stageOf("b")?.positionY).toBeNull();
  });

  it("seeds every column UNPOSITIONED (the upgrade story)", () => {
    // Both columns arrive NULL from the gate, so a board an existing user upgrades
    // into reads as "nothing hand-arranged" and dagre still owns every node. If a
    // migration ever grew a `DEFAULT 0`, this is the case that says so.
    expect(
      (useTasks.getState().boardsBySpace[SPACE] ?? []).map((c) => [
        c.stage.positionX,
        c.stage.positionY,
      ]),
    ).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });
});

describe("useTasks.setStagePosition", () => {
  it("paints the pair on the column it names and nowhere else", async () => {
    await expect(
      useTasks.getState().setStagePosition(SPACE, "doing", 250, -80),
    ).resolves.toBeTruthy();
    expect(setStagePosition).toHaveBeenCalledWith(SPACE, "doing", 250, -80);
    expect(stageOf("doing")).toMatchObject({ positionX: 250, positionY: -80 });
    // The other two columns are untouched — a drag moves ONE node.
    expect(stageOf("backlog")).toMatchObject({ positionX: null, positionY: null });
    expect(stageOf("done")).toMatchObject({ positionX: null, positionY: null });
  });

  it("paints the pair BEFORE the command resolves (the optimistic half)", async () => {
    // A drag that waited for the round trip would lag the pointer by a network hop,
    // which is the whole reason the board's other writes paint first. The paint and
    // the await are separable and this case separates them; a store that awaited
    // first would pass every other case in this file.
    let release: (row: StageDto) => void = () => {};
    vi.mocked(setStagePosition).mockReturnValue(
      new Promise<StageDto>((resolve) => {
        release = resolve;
      }),
    );
    const inflight = useTasks.getState().setStagePosition(SPACE, "backlog", 10, 20);
    expect(stageOf("backlog")).toMatchObject({ positionX: 10, positionY: 20 });
    expect(useTasks.getState().error).toBeNull();
    release(stage("backlog", { positionX: 10, positionY: 20 }));
    await inflight;
    expect(stageOf("backlog")).toMatchObject({ positionX: 10, positionY: 20 });
  });

  it("paints BOTH coordinates from ONE patch — never a half-positioned frame", async () => {
    // The state the command refuses to STORE must never appear on screen either. A
    // two-step paint (`withStage` for X, then another for Y) would put a node at a
    // known X and an unknown Y on screen for one frame, and a React render landing
    // inside that window would draw a node whose position the database will never
    // hold. One patch, both fields, is what makes the intermediate unreachable.
    const painted: Array<[number | null | undefined, number | null | undefined]> = [];
    const original = vi.mocked(setStagePosition);
    original.mockImplementation(async (_space, slug, x, y) => {
      // Read the slice WHILE the command is in flight: whatever the action painted,
      // this is it, and it must be a whole pair or a whole clear.
      const now = stageOf(slug);
      painted.push([now?.positionX, now?.positionY]);
      return { ...stage(slug), positionX: x, positionY: y };
    });
    await useTasks.getState().setStagePosition(SPACE, "doing", 7, 9);
    expect(painted).toEqual([[7, 9]]);
  });

  it("sends `0, 0` as a real position and never folds it into a clear", async () => {
    // Pinning a node to the origin is a legitimate arrangement, and it is a
    // DIFFERENT fact from "nobody ever moved this node". A `x || null` in the action
    // — the most natural-looking refactor of this signature — turns one into the
    // other and silently un-pins the node on the next board read.
    await useTasks.getState().setStagePosition(SPACE, "doing", 0, 0);
    expect(setStagePosition).toHaveBeenCalledWith(SPACE, "doing", 0, 0);
    expect(stageOf("doing")).toMatchObject({ positionX: 0, positionY: 0 });
  });

  it("holds `0` on the SLICE while the write is in flight, not just after it", async () => {
    // THE OPTIMISTIC HALF of the case above, and the half that was unpinned. This file's
    // default `setStagePosition` mock ECHOES its arguments, so the assertion the previous
    // case makes is satisfied TWICE — once by the paint and once by the reply that overwrites
    // it. Measured: `withStage(previous, slug, { positionX: x || null, positionY: y || null })`
    // in the paint kept 12/12 in this file and 11/11 in the canvas editor suite green,
    // because the echo repaints the `0` one tick later and nothing ever looked at the slice
    // in between. A node pinned to the origin would be painted as UNPOSITIONED for the whole
    // round trip — dagre's box instead of the corner the pointer chose — and only snap to the
    // right place when the reply landed.
    //
    // The idiom is this file's own: `paints BOTH coordinates from ONE patch` reads the slice
    // from INSIDE the command mock. Same trick, same reason — the only way to see the paint
    // is to look before the echo.
    const painted: Array<[number | null | undefined, number | null | undefined]> = [];
    vi.mocked(setStagePosition).mockImplementation(async (_space, slug, x, y) => {
      painted.push([
        stageOf(slug)?.positionX,
        stageOf(slug)?.positionY,
      ]);
      return { ...stage(slug), positionX: x, positionY: y };
    });

    await useTasks.getState().setStagePosition(SPACE, "doing", 0, 0);

    // ONE read, and it is the pair — `0` and not `null`, on BOTH axes. A one-sided
    // `x || null` is caught here too rather than being allowed to fail only on X.
    expect(painted).toEqual([[0, 0]]);
    // And the reply agrees, so the case still says the whole round trip holds `0`.
    expect(stageOf("doing")).toMatchObject({ positionX: 0, positionY: 0 });
  });

  it("sends `null, null` on a clear and leaves the stored state NULL", async () => {
    // "Return this node to dagre" has to be expressible, and `null` is its only
    // spelling — the `setStagePromptPrefix` / `setStageSkill` rule for every clearable
    // field on this row, so a clear is never spelled two ways.
    vi.mocked(setStagePosition).mockResolvedValue(
      stage("doing", { positionX: null, positionY: null }),
    );
    await useTasks.getState().setStagePosition(SPACE, "doing", null, null);
    expect(setStagePosition).toHaveBeenCalledWith(SPACE, "doing", null, null);
    expect(stageOf("doing")).toMatchObject({ positionX: null, positionY: null });
  });

  it("paints NOTHING for a half pair, and still lets the command refuse it", async () => {
    // A half pair is not a position, so there is nothing honest to paint: a node at a
    // known X and an unknown Y is the state the command refuses to store. The store
    // does NOT invent a second verdict — it declines to paint, calls the command
    // anyway, and the refusal lands in `error` and rethrows like every other write.
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(setStagePosition).mockRejectedValue({
      kind: "other",
      message: "a stage position must set BOTH coordinates or NEITHER",
    });
    await expect(
      useTasks.getState().setStagePosition(SPACE, "doing", 5, null),
    ).rejects.toBeTruthy();
    expect(setStagePosition).toHaveBeenCalledWith(SPACE, "doing", 5, null);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(useTasks.getState().error).toBe(
      "a stage position must set BOTH coordinates or NEITHER",
    );
  });

  it("puts the slice back EXACTLY as it was and says why, on rejection", async () => {
    // The revert matters MORE here than on any sibling action: the paint follows a
    // POINTER, so a node left at the drop point over a Space that refused the write is a
    // node the user believes they moved, until the next fetch teleports it.
    //
    // `toEqual` and NOT the `toBe(previous)` this case used to assert. `toBe` compared the
    // ARRAY IDENTITY and so pinned the whole-slice revert — `paint(set, spacePath,
    // previous)` — which is the bug the next case names: a new array holding the same rows
    // fails `toBe` while being the correct behaviour, and the old identity check is what let
    // a reviewer say "the comment says the node goes back exactly where it was; it actually
    // goes back where ANOTHER node was". The claim that survives is narrower and it is the
    // one asserted: the column this write owns is back to its stored pair, and nothing else
    // in the slice moved.
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(setStagePosition).mockRejectedValue({
      kind: "not_found",
      message: "no stage ghost in this space (valid stages: backlog, doing, done)",
    });
    await expect(
      useTasks.getState().setStagePosition(SPACE, "ghost", 100, 100),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().boardsBySpace[SPACE]).toEqual(previous);
    expect(useTasks.getState().error).toBe(
      "no stage ghost in this space (valid stages: backlog, doing, done)",
    );
  });

  it("a failed drag leaves a concurrent node's successful drag standing", async () => {
    // THE F2 PIN. Two overlapping drags, in the order a fast person actually produces them:
    //
    //   1. drag A (`backlog`) captures the slice, paints backlog@new, awaits;
    //   2. drag B (`done`) captures the slice — WHICH NOW CARRIES A's PAINT — paints
    //      done@new, awaits;
    //   3. A's write REJECTS.
    //
    // The catch arm used to do `paint(set, spacePath, previous)` with `previous` captured at
    // action entry, i.e. the pre-A slice. That paints B back to its pre-drag position while
    // the DATABASE HOLDS B's new one — the picture contradicts the store, and the next
    // `get_board` contradicts the picture. The header comment's "The node goes back exactly
    // where it was" was false: it went back where *another* node was.
    //
    // `Tidy up` is the worst trigger, because it fires N writes in one click and a mid-list
    // rejection re-paints every later success as still hand-arranged (known-gaps §10d
    // describes the post-refetch state; this is the immediate, wider one).
    //
    // THE FIX, and the shape of the assertion: revert ONLY the column the write owns, via
    // `withStage(…, slug, previousRowForSlug)`. So `done` keeps its pair and `backlog`
    // loses its.
    const columns = useTasks.getState().boardsBySpace[SPACE]!;
    expect(columns.map((c) => c.stage.slug)).toEqual(["backlog", "doing", "done"]);

    // A never resolves on its own terms — it rejects after B has landed.
    let rejectA: (err: unknown) => void = () => {};
    vi.mocked(setStagePosition).mockImplementationOnce(
      () =>
        new Promise<StageDto>((_resolve, reject) => {
          rejectA = reject;
        }),
    );

    // (1) drag A paints and goes in flight.
    const inflightA = useTasks.getState().setStagePosition(SPACE, "backlog", 500, 500);
    expect(stageOf("backlog")).toMatchObject({ positionX: 500, positionY: 500 });

    // (2) drag B starts while A is still in flight, and its write resolves.
    await useTasks.getState().setStagePosition(SPACE, "done", 900, 900);
    expect(stageOf("done")).toMatchObject({ positionX: 900, positionY: 900 });
    // B's paint survived A's optimistic one — the precondition for the whole case.
    expect(stageOf("backlog")).toMatchObject({ positionX: 500, positionY: 500 });

    // (3) A is refused.
    rejectA({ kind: "db", message: "set_stage_position failed" });
    await expect(inflightA).rejects.toBeTruthy();

    // THE COLUMN THAT FAILED goes back. Asked with the layout's own pair rule, because this
    // fixture's factory leaves the two fields `undefined` where a real row says `null`, and
    // `storedPositionOf` is what treats both as "nobody ever moved it".
    expect(storedPositionOf(stageOf("backlog")!)).toBeNull();
    // AND THE COLUMN THAT SUCCEEDED KEEPS ITS POSITION. This is the assertion the
    // whole-slice revert reddens: it repaints `done` from the pre-A slice.
    expect(stageOf("done")).toMatchObject({ positionX: 900, positionY: 900 });
    // The untouched third column is untouched, too.
    expect(storedPositionOf(stageOf("doing")!)).toBeNull();
    // And the refusal is still said out loud — narrowing the revert must not lose the error.
    expect(useTasks.getState().error).toBe("set_stage_position failed");
  });

  it("writes an unloaded Space anyway and paints nothing", async () => {
    // The Stage-write rule `tasks.test.ts` pins for `renameStage`: the command is the
    // truth either way, so an absent slice costs the PAINT and not the WRITE.
    // Refusing would make a drag silently do nothing during the one frame the board
    // has not fetched — a fetch problem wearing a permission mask.
    useTasks.getState().reset();
    vi.mocked(setStagePosition).mockResolvedValue(
      stage("doing", { positionX: 1, positionY: 2 }),
    );
    const row = await useTasks.getState().setStagePosition(SPACE, "doing", 1, 2);
    expect(setStagePosition).toHaveBeenCalledWith(SPACE, "doing", 1, 2);
    expect(row.positionX).toBe(1);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBeUndefined();
    expect(useTasks.getState().error).toBeNull();
  });

  it("re-derives the WHOLE slice from the answered row, not from the guess", async () => {
    // The paint is a GUESS and the reply is the fact. If the Rust side rounds, clamps
    // or otherwise answers something other than what it was handed, the slice has to
    // end up holding the ANSWER — otherwise the store owns a position the database
    // never agreed to, and the next `get_board` contradicts it.
    vi.mocked(setStagePosition).mockResolvedValue(
      stage("doing", { positionX: 250.5, positionY: -80.25 }),
    );
    await useTasks.getState().setStagePosition(SPACE, "doing", 250, -80);
    expect(stageOf("doing")).toMatchObject({
      positionX: 250.5,
      positionY: -80.25,
    });
  });
});

describe("useTasks.load does not undo a position write that is in flight", () => {
  it("a load landing AFTER a drag does not repaint the dragged column (F3)", async () => {
    // THE SNAP-BACK THAT COMES THROUGH THE REFETCH, and a different hole from the one
    // `loadEpoch` closes: that counter guards load-against-load, and says nothing about
    // load-against-a-WRITE. `WorkflowsCanvas` and `TasksBoard` both call `load` on mount and
    // the canvas renders immediately when the slice is already populated, so the sequence
    // board → Workflows → drag before that mount read lands is reachable by an ordinary
    // click. The write SUCCEEDS and the paint shows the pre-drag row — the picture lies, and
    // it defeats `workflowGraphLayout.ts`'s claim that its stored-first ordering "IS the
    // anti-snap-back rule".
    //
    // THE FIX IS A MERGE, not a dropped response: the loaded rows land, and only the TWO
    // FIELDS the in-flight write owns (`positionX`/`positionY`) are kept from the slice for a
    // column with a write outstanding. Dropping the whole response would also throw away the
    // cards and labels another window just changed, which is a wider loss than the one being
    // prevented.
    let release: (row: StageDto) => void = () => {};
    vi.mocked(setStagePosition).mockReturnValueOnce(
      new Promise<StageDto>((resolve) => {
        release = resolve;
      }),
    );
    // The drag is in flight, its optimistic paint is on the slice.
    const inflight = useTasks.getState().setStagePosition(SPACE, "doing", 10, 20);
    expect(stageOf("doing")).toMatchObject({ positionX: 10, positionY: 20 });

    // The mount read answers LATE, with the pre-drag rows (what the database held when the
    // read started) plus a label change, to prove the rest of the response still lands.
    vi.mocked(getBoard).mockResolvedValue(
      board().map((c) =>
        c.stage.slug === "backlog"
          ? { ...c, stage: { ...c.stage, label: "Inbox" } }
          : c,
      ),
    );
    await useTasks.getState().load(SPACE);

    // The dragged column keeps the pair the pointer chose.
    expect(stageOf("doing")).toMatchObject({ positionX: 10, positionY: 20 });
    // And everything else from the fresh read still arrives — this is a merge, not a discard.
    expect(stageOf("backlog")?.label).toBe("Inbox");

    release({ ...stage("doing"), positionX: 10, positionY: 20 });
    await inflight;
    expect(stageOf("doing")).toMatchObject({ positionX: 10, positionY: 20 });
  });

  it("merges ONLY the column with a write in flight, and only for its own Space", async () => {
    // Two halves the previous case cannot separate. (a) A SECOND column with no write
    // outstanding is overwritten by the load — a merge that preserved the whole slice would
    // be the "never shows what the last view left behind" failure the canvas header argues
    // about, and it is not what the in-flight write owns. (b) The counter is PER SPACE: a
    // drag on `/p/alpha` must not protect `/p/beta`'s rows, because a stale read of the
    // OTHER Space would then be silently mangled too.
    const other: StageWithTasks[] = [
      { stage: { ...stage("backlog", { spacePath: "/p/beta" }) }, tasks: [] },
    ];

    let release: (row: StageDto) => void = () => {};
    vi.mocked(setStagePosition).mockReturnValueOnce(
      new Promise<StageDto>((resolve) => {
        release = resolve;
      }),
    );
    const inflight = useTasks.getState().setStagePosition(SPACE, "doing", 77, 88);

    // A hand-arranged `done` on the SAME Space, with no write of its own in flight.
    act(() => {
      useTasks.setState((state) => ({
        boardsBySpace: {
          ...state.boardsBySpace,
          [SPACE]: (state.boardsBySpace[SPACE] ?? []).map((c) =>
            c.stage.slug === "done"
              ? { ...c, stage: { ...c.stage, positionX: 555, positionY: 666 } }
              : c,
          ),
          "/p/beta": other,
        },
      }));
    });

    // The late read answers with NOTHING arranged anywhere.
    vi.mocked(getBoard).mockResolvedValue(board());
    await useTasks.getState().load(SPACE);

    expect(stageOf("doing")).toMatchObject({ positionX: 77, positionY: 88 });
    // `done` had no write in flight, so the load owns it — the merge is per COLUMN.
    expect(storedPositionOf(stageOf("done")!)).toBeNull();

    release({ ...stage("doing"), positionX: 77, positionY: 88 });
    await inflight;

    // (b) The other Space's slice is untouched by a read of THIS one.
    expect(
      (useTasks.getState().boardsBySpace["/p/beta"] ?? []).map((c) => c.stage.slug),
    ).toEqual(["backlog"]);
  });

  it("stops protecting the column once the write settles, so a later load wins", async () => {
    // THE OTHER DIRECTION, and the reason the protection cannot be a permanent pin. Once the
    // write has answered, the database is the authority again and the next `get_board` is
    // allowed to move the node — including to a CLEAR, which is what **Tidy up** from another
    // window looks like. A counter that was never decremented would make a hand-arranged
    // position un-updatable for the life of the session.
    let release: (row: StageDto) => void = () => {};
    vi.mocked(setStagePosition).mockReturnValueOnce(
      new Promise<StageDto>((resolve) => {
        release = resolve;
      }),
    );
    const inflight = useTasks.getState().setStagePosition(SPACE, "doing", 33, 44);
    release({ ...stage("doing"), positionX: 33, positionY: 44 });
    await inflight;
    expect(stageOf("doing")).toMatchObject({ positionX: 33, positionY: 44 });

    // The write has settled, so a subsequent load is authoritative and clears it.
    vi.mocked(getBoard).mockResolvedValue(board());
    await useTasks.getState().load(SPACE);
    expect(storedPositionOf(stageOf("doing")!)).toBeNull();
  });
});
