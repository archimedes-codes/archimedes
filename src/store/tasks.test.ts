import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTasks } from "./tasks";
import {
  createStage,
  createTask,
  deleteStage,
  getArtifact,
  getBoard,
  linkSession,
  moveTask,
  renameStage,
  reorderStages,
  reorderTasks,
  setBoardStrict,
  setStageNext,
  setStageSkill,
  writeArtifact,
  getBoardStrict,
  type Artifact,
  type ArtifactMeta,
  type MoveTaskOutcome,
  type StageRow,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
  type TaskSessionRow,
} from "../lib/tauri";
import { resetStores } from "../test/resetStores";

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so a
// bare `import "node:fs"` does not typecheck. The idiom `classNameConvention.test.ts`
// / `tauriBoundary.test.ts` / `TaskCard.test.tsx` use, borrowed here for the ONE
// assertion below that can only be made against the mirror's SOURCE (the drift pin).
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/** Strip JS comments before scanning, matching the helper those files use. A field
 *  name that appears only in a doc-comment is PROSE, not a declared key. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** The fields `types.ts` declares on an interface, IN DECLARATION ORDER, with the
 *  `?` modifier and the declared type kept so the shape can be asserted and not
 *  merely the key names. Throws rather than returning `[]`: a mirror that lost the
 *  interface entirely must fail LOUDLY, not green-by-emptiness. */
const interfaceFields = (
  source: string,
  name: string,
): { key: string; optional: boolean; type: string }[] => {
  const header = `export interface ${name} {`;
  const open = source.indexOf(header);
  if (open === -1) throw new Error(`types.ts declares no \`${header}\``);
  const close = source.indexOf("\n}", open);
  if (close === -1) throw new Error(`\`${name}\` has no closing brace in types.ts`);
  const body = source.slice(open + header.length, close);
  return [...body.matchAll(/^ *([A-Za-z0-9_]+)(\?)?: *([^;\n]+);$/gm)].map((m) => ({
    key: m[1]!,
    optional: m[2] !== undefined,
    type: m[3]!,
  }));
};

/**
 * `src/store/tasks.ts` — the per-Space Task board store.
 *
 * THE BARREL MOCK IS THE WHOLE POINT OF THE SHAPE. This file mocks the barrel by
 * path (`../lib/tauri`) and SPREADS `vi.importActual`, so an export it does not
 * name still resolves. It overrides the CAMELCASE WRAPPER NAMES
 * (`getBoard`/`moveTask`/…), because those are what the store imports. Mocking
 * the snake_case Rust command names (`get_board`) would leave the real wrapper
 * live, and the real wrapper calls `invoke`, which rejects in jsdom — a green
 * test pinning a rejection instead of a call.
 *
 * TWO RESETS IN `beforeEach`, BOTH LOAD-BEARING (AGENTS.md, and the note at the
 * top of `src/test/resetStores.ts`):
 *   - `resetStores()` restores every store in `ALL_STORES` to the state zustand
 *     captured at creation — `useTasks` is in that list, so the STATE half is
 *     covered from here;
 *   - `useTasks.getState().reset()` is the store's OWN named reset, and it is the
 *     only thing that can reach this module's bookkeeping (`resetStores()` cannot
 *     touch a module-`let` — that limitation is pinned live by
 *     `src/test/fixtures.test.ts`).
 * Dropping either one hands the next case a dirty board, and the suite's green
 * depends on file order (AGENTS.md), so "it passed alone" proves nothing.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    createTask: vi.fn(),
    getTask: vi.fn(),
    editTask: vi.fn(),
    moveTask: vi.fn(),
    reorderTasks: vi.fn(),
    linkSession: vi.fn(),
    // T3's seven Stage verbs and the Strict pair (issue #179), plus the two
    // artifact wrappers (issue #180 D1) — the store calls all ten, so all ten are
    // mocked UNDER THE WRAPPER NAMES like the seven above. A name the store awaits
    // that this factory does not list resolves to the REAL wrapper, which calls
    // `invoke` and rejects in jsdom: the file would then be pinning a rejection
    // rather than the write.
    createStage: vi.fn(),
    renameStage: vi.fn(),
    setStageSkill: vi.fn(),
    setStageNext: vi.fn(),
    reorderStages: vi.fn(),
    deleteStage: vi.fn(),
    setBoardStrict: vi.fn(),
    getBoardStrict: vi.fn(),
    writeArtifact: vi.fn(),
    getArtifact: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures (local: `src/test/fixtures/` is not this task's file to extend).
// ---------------------------------------------------------------------------

const SPACE = "/w/alpha";
const OTHER = "/w/beta";

/* `onEnterSkill`/`nextSlugs` are REQUIRED on the wire type (the Rust side always
 * emits both), so they default here rather than becoming optional. `null` =
 * UNCONFIGURED, matching every pre-#179 column; `nextSlugs: []` means something
 * different (configured, leading nowhere — ADR 0099), so a test wanting the empty
 * case passes it through `over`. Defaults sit BEFORE the spread so `over` wins. */
const stage = (slug: string, over: Partial<StageRow> = {}): StageRow => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder: 0,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
  ...over,
});

const task = (id: string, number: number, stageSlug: string, title = `T${number}`): TaskRow => ({
  id,
  spacePath: SPACE,
  number,
  title,
  body: null,
  specPath: null,
  stageSlug,
  sortOrder: number - 1,
  createdAt: 1,
  updatedAt: 1,
});

/** A board card as the wire shape actually carries it (issue #174): the row under
 *  `task`, with the board-only fields. A board built from bare `TaskRow`s no
 *  longer typechecks against `StageWithTasks.tasks` — which is the point. */
const cardOf = (row: TaskRow): TaskCardView => ({
  task: row,
  sessions: [],
  costUsd: null,
  artifactKeys: [],
});

/** One `task_sessions` link as the wire row carries it. `stageSlug` is NULLABLE on
 *  the column (`task_sessions.stage_slug`) and is the stage the Session was in when
 *  the link was written — a later drag compacts from it. */
const linkOf = (
  taskId: string,
  sessionId: string,
  stageSlug: string | null = null,
): TaskSessionRow => ({ taskId, sessionId, stageSlug });

/** A card that HAS links — the shape `cardOf` cannot express, and the shape this
 *  branch exists to carry. The optimistic paths in `tasks.ts` all claim to leave
 *  the wrapper's two board-only fields alone; every assertion made with `cardOf`
 *  is made against `sessions: []`/`costUsd: null`, which a mutation dropping both
 *  would satisfy. This is the fixture that makes those claims checkable. */
const linkedCardOf = (
  row: TaskRow,
  sessions: TaskSessionRow[],
  costUsd: number | null,
  artifactKeys: string[] = [],
): TaskCardView => ({ task: row, sessions, costUsd, artifactKeys });

/** A two-column board, NESTED the way the wire shape is (`{ stage, tasks }`). */
const board = (...cols: [StageRow, TaskRow[]][]): StageWithTasks[] =>
  cols.map(([s, tasks]) => ({ stage: s, tasks: tasks.map(cardOf) }));

const backlog = stage("backlog");
const doing = stage("doing", { sortOrder: 3, onEnter: "compact" });

const cards = (spacePath: string): StageWithTasks[] =>
  spacePath === SPACE
    ? board(
        [backlog, [task("t1", 1, "backlog"), task("t2", 2, "backlog")]],
        [doing, [task("t3", 3, "doing")]],
      )
    : board([stage("backlog", { spacePath: OTHER }), []]);

/** The outcome `moveTask` answers with when nothing needs saying. */
const quiet: MoveTaskOutcome = { onEnter: "none", boostNote: null };

/** Flush the fire-and-forget IPC chain of a `reorderWithinStage` call. That
 *  action returns `void` (a reorder has no UI to await it — the optimistic slice
 *  is already painted), so a test drives it and then yields until the rejection
 *  handler has had its turn. Three microtask ticks covers the chained
 *  `.then().catch()` regardless of which arm it takes. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  vi.mocked(getBoard).mockReset();
  vi.mocked(createTask).mockReset();
  vi.mocked(moveTask).mockReset();
  vi.mocked(reorderTasks).mockReset();
  vi.mocked(linkSession).mockReset();
  // T3's ten. Every one is reset rather than left carrying the previous case's
  // resolved value, and the ones the store AWAITS a value from get a default: a
  // bare `vi.fn()` resolves `undefined`, and an action that then reads a field off
  // it fails on `undefined.field` instead of on the thing the case is checking.
  for (const fn of [
    createStage,
    renameStage,
    setStageSkill,
    setStageNext,
    reorderStages,
    deleteStage,
    setBoardStrict,
    getBoardStrict,
    writeArtifact,
    getArtifact,
  ]) {
    vi.mocked(fn).mockReset();
  }
  // The Stage verbs answer the STORED `StageRow`, and every action merges that row
  // back over its own optimistic guess — so a default that ignores its arguments
  // would overwrite whatever a case painted. These defaults echo the arguments back,
  // which is what the Rust side actually does, so a case that only checks the ERROR
  // path or the paint does not have to spell a response.
  vi.mocked(createStage).mockImplementation(async (_space, label) => ({
    ...spikeStage(),
    slug: label.toLowerCase(),
    label,
  }));
  vi.mocked(renameStage).mockImplementation(async (_space, slug, label) => ({
    ...stage(slug),
    label,
  }));
  vi.mocked(setStageSkill).mockImplementation(async (_space, slug, skill) => ({
    ...stage(slug),
    onEnterSkill: skill ?? null,
  }));
  vi.mocked(setStageNext).mockImplementation(async (_space, slug, slugs) => ({
    ...stage(slug),
    nextSlugs: slugs,
  }));
  vi.mocked(reorderStages).mockResolvedValue(undefined);
  vi.mocked(deleteStage).mockResolvedValue(undefined);
  vi.mocked(setBoardStrict).mockResolvedValue(undefined);
  vi.mocked(getBoardStrict).mockResolvedValue(false);
  vi.mocked(writeArtifact).mockResolvedValue({
    key: "spec",
    updatedAt: 1,
    bytes: 0,
  });
  vi.mocked(getArtifact).mockResolvedValue(null);
});

/** The column set as slugs, in the slice's order — the shape every T3 case reads,
 *  because a Stage write changes the column SET and the ORDER is half of what it
 *  changed. */
const sliceSlugs = (spacePath: string = SPACE): string[] =>
  (useTasks.getState().boardsBySpace[spacePath] ?? []).map((c) => c.stage.slug);

/** The cards of one column, as ids — the assertion shape every case below reads. */
const idsOf = (spacePath: string, slug: string): string[] =>
  (useTasks.getState().boardsBySpace[spacePath] ?? [])
    .find((c) => c.stage.slug === slug)
    ?.tasks.map((t) => t.task.id) ?? [];

describe("useTasks.load", () => {
  it("populates boardsBySpace for the Space it loaded and clears loading", async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
    expect(getBoard).toHaveBeenCalledWith(SPACE);
    expect(useTasks.getState().boardsBySpace[SPACE]).toEqual(cards(SPACE));
    expect(useTasks.getState().loading).toBe(false);
    expect(useTasks.getState().error).toBeNull();
  });

  it("raises `loading` while the fetch is in flight (the board's loading arm)", async () => {
    let release: (v: StageWithTasks[]) => void = () => {};
    vi.mocked(getBoard).mockReturnValue(
      new Promise<StageWithTasks[]>((resolve) => {
        release = resolve;
      }),
    );
    const inflight = useTasks.getState().load(SPACE);
    expect(useTasks.getState().loading).toBe(true);
    release([]);
    await inflight;
    expect(useTasks.getState().loading).toBe(false);
  });

  it("captures a readable error when getBoard rejects, without throwing", async () => {
    // The typed envelope (ADR 0063): the store renders it through
    // `describeIpcError`, so a rejection is a SENTENCE here and not
    // `[object Object]` in the board's error line.
    vi.mocked(getBoard).mockRejectedValue({
      kind: "not_a_space",
      message: "that folder is not a Space",
    });
    await expect(useTasks.getState().load(SPACE)).resolves.toBeUndefined();
    expect(useTasks.getState().error).toBe("that folder is not a Space");
    expect(useTasks.getState().loading).toBe(false);
  });

  it("keys results per Space so two Spaces never share one column set", async () => {
    vi.mocked(getBoard).mockImplementation(async (p: string) => cards(p));
    await useTasks.getState().load(SPACE);
    await useTasks.getState().load(OTHER);
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2"]);
    expect(idsOf(OTHER, "backlog")).toEqual([]);
    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("lets the NEWER of two overlapping loads win (a stale fetch cannot repaint)", async () => {
    // Switching Space tabs fast fires two `get_board` calls. The one that
    // resolves LAST must not be the one that paints if it started FIRST.
    let releaseFirst: (v: StageWithTasks[]) => void = () => {};
    let n = 0;
    vi.mocked(getBoard).mockImplementation(() => {
      n += 1;
      if (n === 1) {
        return new Promise<StageWithTasks[]>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(cards(OTHER));
    });
    const first = useTasks.getState().load(SPACE);
    await useTasks.getState().load(OTHER);
    releaseFirst(cards(SPACE));
    await first;
    // The newer load's Space is intact; the stale one wrote nothing.
    expect(idsOf(OTHER, "backlog")).toEqual([]);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBeUndefined();
  });
});

describe("useTasks.moveTask (the cross-column drag verb)", () => {
  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("moves the card into the target column and calls the command once", async () => {
    vi.mocked(moveTask).mockResolvedValue(quiet);
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    expect(moveTask).toHaveBeenCalledWith(SPACE, "t1", "doing");
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(idsOf(SPACE, "backlog")).toEqual(["t2"]);
    expect(idsOf(SPACE, "doing")).toEqual(["t3", "t1"]);
  });

  it("carries the card's stageSlug over to the destination column", async () => {
    // The optimistic write must agree with what Rust stored, or the NEXT drag
    // reads a `stageSlug` that names a column the card left.
    vi.mocked(moveTask).mockResolvedValue(quiet);
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    const moved = (useTasks.getState().boardsBySpace[SPACE] ?? [])
      .flatMap((c) => c.tasks)
      .find((t) => t.task.id === "t1");
    expect(moved?.task.stageSlug).toBe("doing");
  });

  it("carries the card's sessions and cost across the drop (the chip survives a drag)", async () => {
    // THE case every other `moveTask` test in this file skipped, and the reason
    // the store comment's claim ("the WRAPPER is carried along untouched by the
    // spread") was prose: all of them move a card built by `cardOf`, whose
    // `sessions` is `[]` and whose `costUsd` is `null` — so a destination write
    // that rebuilt the wrapper from the `TaskRow` alone and dropped BOTH fields
    // passed the whole suite. Those two fields are the entire payload this branch
    // exists to carry: drop them on the optimistic path and the chip on a card the
    // user just dragged vanishes until the next `get_board`, silently, green.
    //
    // A card with TWO links (not one) so the array is not something a `slice`/`pop`
    // style mutation could survive by accident, and a NON-NULL cost so the
    // ADR 0082 `null`-vs-figure distinction is exercised rather than defaulted.
    vi.mocked(getBoard).mockResolvedValue([
      {
        stage: backlog,
        tasks: [
          linkedCardOf(
            task("t1", 1, "backlog"),
            [linkOf("t1", "sess_first", "backlog"), linkOf("t1", "sess_second", null)],
            1.75,
          ),
          cardOf(task("t2", 2, "backlog")),
        ],
      },
      { stage: doing, tasks: [cardOf(task("t3", 3, "doing"))] },
    ]);
    await useTasks.getState().load(SPACE);
    vi.mocked(moveTask).mockResolvedValue(quiet);

    await useTasks.getState().moveTask(SPACE, "t1", "doing");

    const moved = (useTasks.getState().boardsBySpace[SPACE] ?? [])
      .flatMap((c) => c.tasks)
      .find((t) => t.task.id === "t1");
    // The whole wrapper, asserted as ONE equality: the row's `stageSlug` updated
    // AND both board-only fields standing, in the order the wire published them.
    expect(moved).toEqual(
      linkedCardOf(
        task("t1", 1, "doing"),
        [linkOf("t1", "sess_first", "backlog"), linkOf("t1", "sess_second", null)],
        1.75,
      ),
    );
    // Spelled again as separate assertions so a failure names WHICH field dropped
    // rather than diffing an object the reader has to decode.
    expect(moved?.task.stageSlug).toBe("doing");
    expect(moved?.sessions.map((s) => s.sessionId)).toEqual([
      "sess_first",
      "sess_second",
    ]);
    expect(moved?.costUsd).toBe(1.75);
    // And the destination column is the only place it now reads — the source
    // column did not keep a stale copy carrying the same links.
    expect(idsOf(SPACE, "backlog")).toEqual(["t2"]);
    expect(idsOf(SPACE, "doing")).toEqual(["t3", "t1"]);
  });

  it("surfaces a `boostNote` as a warning — the card moved AND the note is readable", async () => {
    // Spec §5's caveat 2: a `compact` stage with no live Session is a SILENT
    // no-op. The card moved; the boost did not fire. Swallowing the note here is
    // the silent-green case, so the store must hold it for the board to render.
    vi.mocked(moveTask).mockResolvedValue({
      onEnter: "compact",
      boostNote: "no live session to compact",
    });
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    // The move landed…
    expect(idsOf(SPACE, "doing")).toContain("t1");
    // …and the warning survived to be rendered.
    expect(useTasks.getState().boostNotes[SPACE]).toBe("no live session to compact");
  });

  it("holds no note when the outcome's `boostNote` is null (no phantom warning)", async () => {
    vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    expect(useTasks.getState().boostNotes[SPACE]).toBeUndefined();
  });

  it("replaces an older note rather than stacking warnings per Space", async () => {
    vi.mocked(moveTask)
      .mockResolvedValueOnce({ onEnter: "compact", boostNote: "first" })
      .mockResolvedValueOnce({ onEnter: "compact", boostNote: "second" });
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    await useTasks.getState().moveTask(SPACE, "t2", "doing");
    expect(useTasks.getState().boostNotes[SPACE]).toBe("second");
  });

  it("reverts the optimistic move and captures the error when the command rejects", async () => {
    vi.mocked(moveTask).mockRejectedValue({
      kind: "not_found",
      message: "no such stage: doing",
    });
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2"]);
    expect(idsOf(SPACE, "doing")).toEqual(["t3"]);
    expect(useTasks.getState().error).toBe("no such stage: doing");
  });

  it("clears the note on dismiss (a read warning must be puttable away)", async () => {
    vi.mocked(moveTask).mockResolvedValue({
      onEnter: "compact",
      boostNote: "no live session to compact",
    });
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    expect(useTasks.getState().boostNotes[SPACE]).toBeTruthy();
    useTasks.getState().dismissBoostNote(SPACE);
    expect(useTasks.getState().boostNotes[SPACE]).toBeUndefined();
  });
});

describe("useTasks.reorderWithinStage (the within-column drag verb)", () => {
  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("rewrites the column order optimistically and persists it with ONE call", async () => {
    vi.mocked(reorderTasks).mockResolvedValue(undefined);
    useTasks.getState().reorderWithinStage(SPACE, "backlog", ["t2", "t1"]);
    // Optimistic: the order is visible BEFORE the IPC resolves.
    expect(idsOf(SPACE, "backlog")).toEqual(["t2", "t1"]);
    await settle();
    // ONE call for the whole slice — never a per-card `editTask` (which would
    // stamp `updated_at` on cards nobody edited and could half-succeed).
    expect(reorderTasks).toHaveBeenCalledTimes(1);
    expect(reorderTasks).toHaveBeenCalledWith(SPACE, "backlog", ["t2", "t1"]);
  });

  it("names only the dragged column's ids (sort_order is per-Space, not per-stage)", async () => {
    // `reorder_tasks` renumbers the slice it is handed. Passing `t3` (a `doing`
    // card) would move it inside `doing` against a slice the user never dragged.
    vi.mocked(reorderTasks).mockResolvedValue(undefined);
    useTasks.getState().reorderWithinStage(SPACE, "backlog", ["t2", "t1"]);
    const [, , ids] = vi.mocked(reorderTasks).mock.calls[0]!;
    expect(ids).toEqual(["t2", "t1"]);
    expect(ids).not.toContain("t3");
    await settle();
  });

  it("leaves the other columns untouched", async () => {
    vi.mocked(reorderTasks).mockResolvedValue(undefined);
    useTasks.getState().reorderWithinStage(SPACE, "backlog", ["t2", "t1"]);
    expect(idsOf(SPACE, "doing")).toEqual(["t3"]);
    await settle();
    expect(idsOf(SPACE, "doing")).toEqual(["t3"]);
  });

  it("reverts to the pre-drag order when the command refuses", async () => {
    // `reorder_tasks` is one transaction and writes NOTHING on refusal, so the
    // order the drag replaced IS the order to go back to — not a refetch.
    vi.mocked(reorderTasks).mockRejectedValue({
      kind: "not_found",
      message: "task t9 is not in stage backlog",
    });
    useTasks.getState().reorderWithinStage(SPACE, "backlog", ["t2", "t1"]);
    expect(idsOf(SPACE, "backlog")).toEqual(["t2", "t1"]);
    await settle();
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2"]);
    expect(useTasks.getState().error).toBe("task t9 is not in stage backlog");
  });

  it("costs no write for an empty slice (a reorder of nothing is not an IPC)", async () => {
    useTasks.getState().reorderWithinStage(SPACE, "backlog", []);
    await settle();
    expect(reorderTasks).not.toHaveBeenCalled();
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2"]);
  });

  it("skips an id the column does not hold, keeps an unseen card at the END, and still sends the ORIGINAL slice", async () => {
    // The two ordering rules the store states in prose (`tasks.ts` — "an id the
    // column does not hold is SKIPPED… a card the slice never named keeps its
    // place at the END") had NO test: every other case in this file hands over a
    // COMPLETE slice (`["t2","t1"]`) or an empty one, so both arms were unreachable
    // and either could be deleted with the suite green. Both arms exist for a real
    // race — a card created mid-drag, or a board that reloaded under the gesture.
    //
    // A THREE-card column, so "unseen card at the END" is distinguishable from
    // "nothing moved at all": the shared two-card fixture cannot tell those apart.
    vi.mocked(getBoard).mockResolvedValue([
      {
        stage: backlog,
        tasks: [
          cardOf(task("t1", 1, "backlog")),
          cardOf(task("t2", 2, "backlog")),
          cardOf(task("t4", 4, "backlog")),
        ],
      },
      { stage: doing, tasks: [cardOf(task("t3", 3, "doing"))] },
    ]);
    await useTasks.getState().load(SPACE);
    // The command REFUSES the slice, and that is the state this case is really
    // about: the server rejects an id it does not hold (`BoardError::MissingTask`),
    // so the optimistic preview is a preview and nothing more.
    vi.mocked(reorderTasks).mockRejectedValue({
      kind: "not_found",
      message: "task t9 is not in stage backlog",
    });

    // ONE call, two shapes: `t9` is a phantom the column never held, and `t1` is a
    // card the slice never named.
    const ids = ["t4", "t9", "t2"];
    useTasks.getState().reorderWithinStage(SPACE, "backlog", ids);
    // (i) the phantom id is NOT painted — inserting what `byId.get` cannot resolve
    // would put `undefined` in the strip and take the column's render down:
    expect(idsOf(SPACE, "backlog")).toEqual(["t4", "t2", "t1"]);
    expect(
      (useTasks.getState().boardsBySpace[SPACE] ?? [])
        .find((c) => c.stage.slug === "backlog")
        ?.tasks.some((t) => t.task.id === "t9"),
    ).toBe(false);
    // (ii) the omitted card SURVIVES, at the END — the same new-row rule
    // `reorderSpaces` follows. Losing it here is a card vanishing from the board on
    // a drag that never touched it, with no failure to explain the absence.
    expect(idsOf(SPACE, "backlog")).toContain("t1");
    expect(idsOf(SPACE, "backlog")[idsOf(SPACE, "backlog").length - 1]).toBe("t1");
    // (iii) THE load-bearing assertion. The command is called with the caller's
    // ORIGINAL `ids` — phantom `t9` included — and NOT with the filtered preview
    // the optimistic paint produced. A reviewer verified the server refuses an
    // unknown id (`BoardError::MissingTask`) and the `.catch` reverts the slice, so
    // the phantom is refused loudly and undone; and the optimistic filter is safe
    // ONLY because what gets SENT is the untouched slice. Silently sending the
    // filtered list would renumber the column against a slice the user never
    // dragged and hide the phantom from the one place that could report it.
    expect(reorderTasks).toHaveBeenCalledWith(SPACE, "backlog", ["t4", "t9", "t2"]);
    const [, , sent] = vi.mocked(reorderTasks).mock.calls[0]!;
    // The SAME array object the caller handed the store — not a copy, not a filter.
    // `toHaveBeenCalledWith` is a deep-equality check and would pass on a rebuilt
    // list that happened to read alike; identity is what says nothing was rebuilt.
    expect(sent).toBe(ids);
    expect(sent).toContain("t9");
    expect(sent).not.toEqual(idsOf(SPACE, "backlog"));
    // Let that first refusal's `.catch` land before driving the verb again — two
    // rejections in flight at once would race over who restores which slice, and
    // this case is about WHICH slice was sent, not about the revert's ordering.
    await settle();
    // The refusal path is the other half of why (iii) matters: the server rejects
    // the phantom (`reorderTasks` is still mocked to refuse, set above), the
    // `.catch` restores the pre-drag order, and the human sees the order they had
    // rather than a quietly renumbered column.
    useTasks.getState().reorderWithinStage(SPACE, "backlog", ids);
    await settle();
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2", "t4"]);
    expect(useTasks.getState().error).toBe("task t9 is not in stage backlog");
  });
});

describe("useTasks.createTask / useTasks.linkSession", () => {
  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("createTask forwards to the command and lands the row in its column", async () => {
    const created = task("t4", 4, "backlog", "Write the board");
    vi.mocked(createTask).mockResolvedValue(created);
    const row = await useTasks.getState().createTask(SPACE, "Write the board");
    expect(createTask).toHaveBeenCalledWith(SPACE, "Write the board", undefined, undefined);
    expect(row).toEqual(created);
    // The board shows the new card without waiting for a reload.
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2", "t4"]);
    // …and the board's element is the WRAPPER, spelled out: `create_task` answers a
    // plain `TaskRow`, so an empty `sessions` and a `null` cost are BUILT here. Both
    // are the truth for a card that just came into the world — it has no links, and
    // no Session has ever reported a cost for it. `costUsd: null` and not `0` is
    // ADR 0082 ("never reported" renders NOTHING; a `0` here would be a phantom
    // `$0.00` on the chip), and `undefined` would not be this type at all.
    const landed = (useTasks.getState().boardsBySpace[SPACE] ?? [])
      .flatMap((c) => c.tasks)
      .find((t) => t.task.id === "t4");
    expect(landed).toEqual({
      task: created,
      sessions: [],
      costUsd: null,
      artifactKeys: [],
    });
  });

  it("createTask forwards an explicit body and stage", async () => {
    vi.mocked(createTask).mockResolvedValue(task("t4", 4, "doing"));
    await useTasks.getState().createTask(SPACE, "x", "body", "doing");
    expect(createTask).toHaveBeenCalledWith(SPACE, "x", "body", "doing");
    expect(idsOf(SPACE, "doing")).toContain("t4");
  });

  it("linkSession forwards to the command and writes no board state", async () => {
    vi.mocked(linkSession).mockResolvedValue(undefined);
    const before = useTasks.getState().boardsBySpace[SPACE];
    await useTasks.getState().linkSession("t1", "s1", "backlog");
    expect(linkSession).toHaveBeenCalledWith("t1", "s1", "backlog");
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// T3 — the STAGE writes (issue #179 §8.1) and the ARTIFACT reads/writes
// (issue #180 D1). Six subject-scoped describes, none of them folded into the
// board-drag blocks above: a Stage write changes the COLUMN SET and an artifact
// write changes no board state at all, so neither shares a subject with a drag.
//
// THE WHOLE-SLICE RULE is what most of these assert. Spec §8.1: every Stage write
// re-derives the WHOLE `boardsBySpace[spacePath]` value, because a column list
// that disagrees with the cards under it is a board that lies. The assertions
// therefore read the ORDER of the slice and the IDENTITY of the columns that were
// not touched — a partial patch that mutates one entry in place satisfies
// "the label changed" and fails those.
// ---------------------------------------------------------------------------

/** The Stage row the T3 `createStage` fake answers with. `spike` is the column a
 *  test ADDS, and its slug is spelled by the FAKE COMMAND rather than by the
 *  store — which is the point of `createStage`'s await-then-paint shape. */
const spikeStage = (over: Partial<StageRow> = {}): StageRow => ({
  spacePath: SPACE,
  slug: "spike",
  label: "Spike",
  sortOrder: 1,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
  ...over,
});

describe("useTasks.createStage / useTasks.renameStage (T3)", () => {
  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("createStage appends the column the COMMAND named, with no cards of its own", async () => {
    vi.mocked(createStage).mockResolvedValue(spikeStage({ sortOrder: 9 }));
    const row = await useTasks.getState().createStage(SPACE, "Spike", "research");
    expect(createStage).toHaveBeenCalledWith(SPACE, "Spike", "research");
    expect(createStage).toHaveBeenCalledTimes(1);
    expect(row).toEqual(spikeStage({ sortOrder: 9 }));
    const slice = useTasks.getState().boardsBySpace[SPACE]!;
    expect(slice.map((c) => c.stage.slug)).toEqual(["backlog", "doing", "spike"]);
    // A brand-new column is EMPTY. Cards belong to the column that held them, and
    // inventing one here would be a card the database has never heard of.
    expect(slice[2]!.tasks).toEqual([]);
  });

  it("createStage lands the column where the wire's sortOrder says, not last", async () => {
    // `get_board` returns columns in `sort_order`, so the optimistic slice has to
    // agree with the NEXT load or the column jumps one frame later. `spike` comes
    // back at `sortOrder: 1`, between `backlog` (0) and `doing` (3).
    vi.mocked(createStage).mockResolvedValue(spikeStage({ sortOrder: 1 }));
    await useTasks.getState().createStage(SPACE, "Spike");
    expect(
      useTasks.getState().boardsBySpace[SPACE]!.map((c) => c.stage.slug),
    ).toEqual(["backlog", "spike", "doing"]);
  });

  it("createStage paints NOTHING before the write lands — the slug is Rust's to derive", async () => {
    // THE shape this action has and `renameStage` does not, and it is forced: the
    // slug is derived in Rust from the label and a collision REFUSES rather than
    // suffixing (spec §5), so a client-side guess would be a second owner of the
    // slug rule. Identity (`toBe`), not structural equality: an implementation
    // that painted a guessed column first hands back a NEW array even when the
    // command then refuses, and this is the case that catches it.
    const before = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(createStage).mockRejectedValue({
      kind: "not_found",
      message: "stage spike already exists",
    });
    await expect(
      useTasks.getState().createStage(SPACE, "Spike"),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(before);
    expect(useTasks.getState().error).toBe("stage spike already exists");
  });

  it("createStage still writes for a Space whose board never loaded, and paints nothing", async () => {
    // The same rule `createTask` already runs: the command is the truth and the
    // paint is conditional on there being a column set to paint into. Refusing the
    // write outright would make the editor's Add button dead on a board that has
    // not fetched yet, which is a fetch problem wearing a permission mask.
    useTasks.getState().reset();
    vi.mocked(createStage).mockResolvedValue(spikeStage());
    const row = await useTasks.getState().createStage(SPACE, "Spike");
    expect(createStage).toHaveBeenCalledTimes(1);
    expect(row.slug).toBe("spike");
    expect(useTasks.getState().boardsBySpace[SPACE]).toBeUndefined();
  });

  it("renameStage changes the LABEL and leaves the slug where it was (spec §5)", async () => {
    vi.mocked(renameStage).mockResolvedValue(
      stage("doing", {
        sortOrder: 3,
        onEnter: "compact",
        label: "In flight",
      }),
    );
    await useTasks.getState().renameStage(SPACE, "doing", "In flight");
    expect(renameStage).toHaveBeenCalledWith(SPACE, "doing", "In flight");
    const slice = useTasks.getState().boardsBySpace[SPACE]!;
    const doing = slice.find((c) => c.stage.slug === "doing")!;
    expect(doing.stage.label).toBe("In flight");
    // The slug is FROZEN — `tasks.stage_slug` points at it by string with no
    // foreign key, so a rename that moved it would orphan every card in the column.
    expect(slice.map((c) => c.stage.slug)).toEqual(["backlog", "doing"]);
    // And the rest of the row survives a rename: it patches the label, not the row.
    expect(doing.stage.onEnter).toBe("compact");
    expect(doing.tasks.map((t) => t.task.id)).toEqual(["t3"]);
  });

  it("renameStage keeps the OTHER columns identical objects (a whole slice, not a rebuilt one)", async () => {
    vi.mocked(renameStage).mockResolvedValue(
      stage("doing", { sortOrder: 3, label: "x" }),
    );
    const before = useTasks.getState().boardsBySpace[SPACE]!;
    await useTasks.getState().renameStage(SPACE, "doing", "x");
    const after = useTasks.getState().boardsBySpace[SPACE]!;
    expect(after).not.toBe(before); // a fresh slice — the whole-slice rule
    expect(after[0]).toBe(before[0]); // …carrying the untouched column UNCHANGED
  });

  it("renameStage cannot move the slug, even if the response's row disagrees", async () => {
    // The frozen-slug rule (spec §5) enforced against the WIRE and not just against
    // this file: `tasks.stage_slug` points at the slug by string with no foreign
    // key, so a column re-keyed by a rename would orphan every card under it — the
    // cards would survive, keep costing money through their Sessions, and be
    // unreachable. The merge pins the slug back to the column that was found.
    vi.mocked(renameStage).mockResolvedValue(
      stage("in-flight", { sortOrder: 3, label: "In flight" }),
    );
    await useTasks.getState().renameStage(SPACE, "doing", "In flight");
    expect(sliceSlugs()).toEqual(["backlog", "doing"]);
    const doing = useTasks.getState().boardsBySpace[SPACE]!.find(
      (c) => c.stage.slug === "doing",
    )!;
    expect(doing.stage.slug).toBe("doing");
    expect(doing.stage.label).toBe("In flight");
    // And the cards are still under it — the orphaning this rule prevents.
    expect(doing.tasks.map((t) => t.task.id)).toEqual(["t3"]);
  });

  it("renameStage shows what the SERVER stored when it trims the label", async () => {
    // The command answers the stored `StageRow`, and the optimistic paint is a
    // guess about it. Merging the row back is what stops the board showing a label
    // the database refused to store.
    vi.mocked(renameStage).mockResolvedValue(
      stage("doing", { sortOrder: 3, label: "In flight" }),
    );
    await useTasks.getState().renameStage(SPACE, "doing", "  In flight  ");
    const doing = useTasks.getState().boardsBySpace[SPACE]!.find(
      (c) => c.stage.slug === "doing",
    )!;
    expect(doing.stage.label).toBe("In flight");
  });

  it("renameStage still writes with no board loaded, and paints nothing", async () => {
    // The decision that departs from `moveTask`'s "refuse when nothing is loaded",
    // pinned here so it stays a decision rather than drift: `moveTask` refuses
    // because it cannot compute its own endpoints from an absent slice. A Stage
    // write CAN — the command is the truth either way — so an unloaded slice costs
    // the PAINT and not the WRITE. Returning early would make a rename silently do
    // nothing during the frame the board has not fetched yet.
    useTasks.getState().reset();
    vi.mocked(renameStage).mockResolvedValue(
      stage("backlog", { label: "Inbox" }),
    );
    const row = await useTasks.getState().renameStage(
      SPACE,
      "backlog",
      "Inbox",
    );
    expect(renameStage).toHaveBeenCalledWith(SPACE, "backlog", "Inbox");
    expect(row.label).toBe("Inbox");
    expect(useTasks.getState().boardsBySpace[SPACE]).toBeUndefined();
    expect(useTasks.getState().error).toBeNull();
  });

  it("renameStage puts the slice back EXACTLY as it was and says why, on rejection", async () => {
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(renameStage).mockRejectedValue({
      kind: "not_found",
      message: "no such stage: nope",
    });
    // Rethrown, and the reason is the return type: this action answers the STORED
    // `StageRow` and on a refusal there is not one to hand back. The `void` Stage
    // writes below (`reorderStages`, `deleteStage`, `setBoardStrict`) do not
    // rethrow — they have nothing to return, so the reverted slice plus `error` is
    // the whole report, exactly as `moveTask` has always reported.
    await expect(
      useTasks.getState().renameStage(SPACE, "nope", "Whatever"),
    ).rejects.toBeTruthy();
    // `toBe` is the assertion: the revert restores the captured slice rather than
    // a re-derived lookalike, the same rule `moveTask`'s revert follows — a
    // refetch is a WIDER mutation than the one being undone, because `get_board`
    // seeds stage rows on read.
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(useTasks.getState().error).toBe("no such stage: nope");
  });
});

describe("useTasks.setStageSkill / useTasks.setStageNext (T3)", () => {
  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("setStageSkill paints the Skill on the column it names and nowhere else", async () => {
    vi.mocked(setStageSkill).mockResolvedValue(
      stage("doing", {
        sortOrder: 3,
        onEnter: "compact",
        onEnterSkill: "research",
      }),
    );
    await useTasks.getState().setStageSkill(SPACE, "doing", "research");
    expect(setStageSkill).toHaveBeenCalledWith(SPACE, "doing", "research");
    const slice = useTasks.getState().boardsBySpace[SPACE]!;
    expect(slice[1]!.stage.onEnterSkill).toBe("research");
    // ADR 0098: the Skill is a SECOND column beside `onEnter`, so setting one must
    // not disturb the other — a merged field here would print `research` where the
    // board advertises `compact`.
    expect(slice[1]!.stage.onEnter).toBe("compact");
    expect(slice[0]!.stage.onEnterSkill).toBeNull();
  });

  it("setStageSkill with null CLEARS the Skill (a column that launches nothing)", async () => {
    vi.mocked(setStageSkill).mockResolvedValue(
      stage("doing", { sortOrder: 3 }),
    );
    await useTasks.getState().setStageSkill(SPACE, "doing", null);
    expect(setStageSkill).toHaveBeenCalledWith(SPACE, "doing", null);
    expect(
      useTasks.getState().boardsBySpace[SPACE]![1]!.stage.onEnterSkill,
    ).toBeNull();
  });

  it("setStageSkill reverts and reports on rejection (the paint is not the write)", async () => {
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(setStageSkill).mockRejectedValue({
      kind: "not_found",
      message: "no such skill: research",
    });
    await expect(
      useTasks.getState().setStageSkill(SPACE, "doing", "research"),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(useTasks.getState().error).toBe("no such skill: research");
  });

  it("setStageNext stores the ORDER it was handed (the first entry is the card's pill)", async () => {
    // Read off the OPTIMISTIC paint, with the command deliberately never
    // resolving: the success path merges the wire's row back over the guess, so an
    // assertion made after the await would pass for an implementation that painted
    // a sorted copy and then quietly corrected itself one round trip later.
    vi.mocked(setStageNext).mockReturnValue(new Promise<StageRow>(() => {}));
    void useTasks.getState().setStageNext(SPACE, "backlog", [
      "doing",
      "backlog",
    ]);
    // Order is the render order AND the pill's primary next step (spec §7.1), so a
    // sorted or deduplicated copy is a different workflow.
    expect(
      useTasks.getState().boardsBySpace[SPACE]![0]!.stage.nextSlugs,
    ).toEqual(["doing", "backlog"]);
  });

  it("setStageNext forwards the list verbatim, in the caller's order", async () => {
    vi.mocked(setStageNext).mockResolvedValue(
      stage("backlog", { nextSlugs: ["doing", "backlog"] }),
    );
    await useTasks.getState().setStageNext(SPACE, "backlog", [
      "doing",
      "backlog",
    ]);
    expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", [
      "doing",
      "backlog",
    ]);
  });

  it("setStageNext keeps [] as \"configured and leading nowhere\", never as null (ADR 0099)", async () => {
    vi.mocked(setStageNext).mockResolvedValue(
      stage("backlog", { nextSlugs: [] }),
    );
    await useTasks.getState().setStageNext(SPACE, "backlog", []);
    expect(setStageNext).toHaveBeenCalledWith(SPACE, "backlog", []);
    const next = useTasks.getState().boardsBySpace[SPACE]![0]!.stage.nextSlugs;
    expect(next).toEqual([]);
    expect(next).not.toBeNull();
  });

  it("setStageNext reverts a refused edge list and names the missing slug", async () => {
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(setStageNext).mockRejectedValue({
      kind: "not_found",
      message: "unknown stage: ghost",
    });
    await expect(
      useTasks.getState().setStageNext(SPACE, "backlog", ["ghost"]),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(useTasks.getState().error).toBe("unknown stage: ghost");
  });
});

describe("useTasks.reorderStages (T3)", () => {
  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(
      board(
        [stage("backlog"), []],
        [stage("doing", { sortOrder: 1 }), []],
        [stage("done", { sortOrder: 2 }), []],
      ),
    );
    await useTasks.getState().load(SPACE);
  });

  it("hands the command the WHOLE ordered slice, not the two columns that swapped", async () => {
    // Requirement 1, and the difference between the two reorder contracts:
    // `reorder_spaces` renumbers everything the caller shows, `reorder_tasks`
    // refuses an id it does not know. The board's editor shows every column, so it
    // passes every column — a partial patch would leave the untouched columns
    // keeping stale `sort_order` values that can collide with the renumbered ones.
    vi.mocked(reorderStages).mockResolvedValue(undefined);
    await useTasks.getState().reorderStages(SPACE, [
      "done",
      "backlog",
      "doing",
    ]);
    expect(reorderStages).toHaveBeenCalledTimes(1);
    expect(reorderStages).toHaveBeenCalledWith(SPACE, [
      "done",
      "backlog",
      "doing",
    ]);
  });

  it("paints the new column order before the write resolves", async () => {
    // The optimistic read is taken WITHOUT awaiting: the paint is synchronous and a
    // drag that waited for the IPC would flicker back to the old order. The
    // command never settles on purpose.
    vi.mocked(reorderStages).mockReturnValue(new Promise<void>(() => {}));
    void useTasks.getState().reorderStages(SPACE, [
      "done",
      "backlog",
      "doing",
    ]);
    expect(
      useTasks.getState().boardsBySpace[SPACE]!.map((c) => c.stage.slug),
    ).toEqual(["done", "backlog", "doing"]);
  });

  it("carries each column's cards along with it (a reorder moves columns, not their contents)", async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
    vi.mocked(reorderStages).mockResolvedValue(undefined);
    await useTasks.getState().reorderStages(SPACE, ["doing", "backlog"]);
    const slice = useTasks.getState().boardsBySpace[SPACE]!;
    expect(slice.map((c) => c.stage.slug)).toEqual(["doing", "backlog"]);
    expect(idsOf(SPACE, "doing")).toEqual(["t3"]);
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2"]);
  });

  it("drops a slug the slice does not hold from the PAINT but sends it anyway (the reorder_spaces no-op)", async () => {
    // Rust treats an unknown slug as a silent no-op (spec §4 — explicitly NOT
    // `reorder_tasks`' refusal), and the client cannot render a column it does not
    // have. So the two sides differ on purpose: the paint skips it, the argument
    // keeps the caller's list verbatim.
    vi.mocked(reorderStages).mockResolvedValue(undefined);
    await useTasks.getState().reorderStages(SPACE, [
      "done",
      "ghost",
      "backlog",
      "doing",
    ]);
    expect(reorderStages).toHaveBeenCalledWith(SPACE, [
      "done",
      "ghost",
      "backlog",
      "doing",
    ]);
    expect(
      useTasks.getState().boardsBySpace[SPACE]!.map((c) => c.stage.slug),
    ).toEqual(["done", "backlog", "doing"]);
  });

  it("keeps a column the list never named at the END of the paint instead of painting it away", async () => {
    // The same rule `reorderWithinStage` records: a slice that forgot a row must
    // not DELETE it from what the human sees. Rust leaves an unnamed column's
    // `sort_order` alone, so the honest client-side answer is "still there, at the
    // end" — dropping it here would blank a live column on a stale list.
    vi.mocked(reorderStages).mockResolvedValue(undefined);
    await useTasks.getState().reorderStages(SPACE, ["doing"]);
    expect(
      useTasks.getState().boardsBySpace[SPACE]!.map((c) => c.stage.slug),
    ).toEqual(["doing", "backlog", "done"]);
  });

  it("reverts the order and reports when the command refuses", async () => {
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(reorderStages).mockRejectedValue({
      kind: "command",
      message: "reorder refused",
    });
    await useTasks.getState().reorderStages(SPACE, [
      "done",
      "backlog",
      "doing",
    ]);
    expect(
      useTasks.getState().boardsBySpace[SPACE]!.map((c) => c.stage.slug),
    ).toEqual(["backlog", "doing", "done"]);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(useTasks.getState().error).toBe("reorder refused");
  });
});

describe("useTasks.deleteStage (T3)", () => {
  beforeEach(async () => {
    // Cards in BOTH columns, so the relocation is observable: the column that goes
    // away holds `t3`, and the picker's destination is `backlog`.
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("removes the column, moves its cards to the destination, and re-derives the whole slice", async () => {
    vi.mocked(deleteStage).mockResolvedValue(undefined);
    await useTasks.getState().deleteStage(SPACE, "doing", "backlog");
    const slice = useTasks.getState().boardsBySpace[SPACE]!;
    expect(slice.map((c) => c.stage.slug)).toEqual(["backlog"]);
    // The relocated card shows up in the destination, because the command moved it
    // there in the same transaction. Painting the column away and leaving the card
    // unpainted would drop `t3` off the board until the next load — a card that
    // exists, costs money through its Session, and is nowhere to be clicked.
    expect(idsOf(SPACE, "backlog")).toEqual(["t1", "t2", "t3"]);
    const moved = slice[0]!.tasks.find((c) => c.task.id === "t3")!;
    // …and its `stageSlug` travels with it, the same rule `moveTask`'s slice
    // follows: a card still naming the column it left makes the NEXT drag read a
    // stage the card is not in.
    expect(moved.task.stageSlug).toBe("backlog");
  });

  it("NEVER calls moveTask for the cards the deleted column held (the five-compactions bug)", async () => {
    // THE pin. `move_task` reads the destination's `on_enter` and fires its boost,
    // so relocating N cards with N `moveTask` calls would attempt N COMPACTIONS as
    // a side effect of bookkeeping (spec §4.1). The relocation is ONE bulk UPDATE
    // inside `delete_stage`'s own transaction, and this action must not add a
    // per-card verb to it — not even "just to refresh the cards' stage".
    vi.mocked(deleteStage).mockResolvedValue(undefined);
    await useTasks.getState().deleteStage(SPACE, "doing", "backlog");
    await settle();
    expect(moveTask).toHaveBeenCalledTimes(0);
  });

  it("threads the picker's destination to the wire as relocateTo", async () => {
    vi.mocked(deleteStage).mockResolvedValue(undefined);
    await useTasks.getState().deleteStage(SPACE, "doing", "backlog");
    expect(deleteStage).toHaveBeenCalledWith(SPACE, "doing", "backlog");
    expect(deleteStage).toHaveBeenCalledTimes(1);
  });

  it("sends no destination when the column was empty (nothing to relocate)", async () => {
    // An empty column needs no picker and no destination; the wrapper normalizes an
    // absent argument to the Rust `None`, and the store passes the caller's value
    // through rather than inventing a column of its own.
    vi.mocked(deleteStage).mockResolvedValue(undefined);
    await useTasks.getState().deleteStage(SPACE, "done");
    expect(deleteStage).toHaveBeenCalledWith(SPACE, "done", undefined);
  });

  it("puts a refused delete back, column and all", async () => {
    const previous = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(deleteStage).mockRejectedValue({
      kind: "not_found",
      message: "stage research is still a destination",
    });
    await useTasks.getState().deleteStage(SPACE, "doing", "backlog");
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(previous);
    expect(useTasks.getState().error).toBe(
      "stage research is still a destination",
    );
    expect(moveTask).toHaveBeenCalledTimes(0);
  });
});

describe("useTasks.setBoardStrict / useTasks.getBoardStrict (T3)", () => {
  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("setBoardStrict writes the flag and paints NO board state at all", async () => {
    // The flag binds DRAGS (spec §4.2), it does not change the column set, so the
    // whole-slice rule does not apply here — and neither does any paint. Identity
    // on the slice is the assertion: a version of this action that flipped a field
    // on the board would be a second owner of a fact the `spaces` row owns.
    vi.mocked(setBoardStrict).mockResolvedValue(undefined);
    const before = useTasks.getState().boardsBySpace[SPACE];
    await useTasks.getState().setBoardStrict(SPACE, true);
    expect(setBoardStrict).toHaveBeenCalledWith(SPACE, true);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(before);
    expect(useTasks.getState().error).toBeNull();
  });

  it("setBoardStrict still writes with no board loaded (the guard's one exemption)", async () => {
    // Every other guarded Stage action is a no-op without a loaded slice because
    // there is no column set to re-paint. This one has no slice to paint, so
    // refusing it would make the editor's Switch dead on a board that has not
    // fetched — and the flag would still be written by any other route.
    useTasks.getState().reset();
    vi.mocked(setBoardStrict).mockResolvedValue(undefined);
    await useTasks.getState().setBoardStrict(SPACE, false);
    expect(setBoardStrict).toHaveBeenCalledWith(SPACE, false);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBeUndefined();
  });

  it("setBoardStrict reports a refusal without touching the board", async () => {
    const before = useTasks.getState().boardsBySpace[SPACE];
    vi.mocked(setBoardStrict).mockRejectedValue({
      kind: "not_found",
      message: "no such space",
    });
    await useTasks.getState().setBoardStrict(SPACE, true);
    expect(useTasks.getState().error).toBe("no such space");
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(before);
  });

  it("getBoardStrict forwards and hands back the flag the enforcement reads", async () => {
    vi.mocked(getBoardStrict).mockResolvedValue(true);
    await expect(useTasks.getState().getBoardStrict(SPACE)).resolves.toBe(true);
    expect(getBoardStrict).toHaveBeenCalledWith(SPACE);
    expect(getBoardStrict).toHaveBeenCalledTimes(1);
  });

  it("getBoardStrict answers false for a Space that never opted in, and writes nothing", async () => {
    vi.mocked(getBoardStrict).mockResolvedValue(false);
    const before = useTasks.getState().boardsBySpace[SPACE];
    await expect(useTasks.getState().getBoardStrict(SPACE)).resolves.toBe(false);
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(before);
  });

  it("getBoardStrict lands a refusal in `error` and rethrows for the caller", async () => {
    // Rethrows rather than swallowing: the editor must be able to tell "Strict is
    // off" from "I could not read it", because that difference decides whether the
    // Switch is a fact or a guess.
    vi.mocked(getBoardStrict).mockRejectedValue({
      kind: "command",
      message: "board_strict read failed",
    });
    await expect(
      useTasks.getState().getBoardStrict(SPACE),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().error).toBe("board_strict read failed");
  });
});

describe("useTasks.writeArtifact / useTasks.getArtifact (T3)", () => {
  const meta: ArtifactMeta = { key: "spec", updatedAt: 7, bytes: 12 };
  const artifact: Artifact = {
    taskId: "t1",
    key: "spec",
    markdown: "# Spec\n",
    createdAt: 5,
    updatedAt: 7,
  };

  beforeEach(async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
  });

  it("writeArtifact forwards the document and hands back the meta untouched", async () => {
    vi.mocked(writeArtifact).mockResolvedValue(meta);
    await expect(
      useTasks.getState().writeArtifact("t1", "spec", "# Spec\n"),
    ).resolves.toEqual(meta);
    expect(writeArtifact).toHaveBeenCalledWith("t1", "spec", "# Spec\n");
    expect(writeArtifact).toHaveBeenCalledTimes(1);
  });

  it("writeArtifact writes NO board state — the board carries keys, not documents", async () => {
    // Spec §1: the board read ships `artifactKeys` alone, so a write that patched
    // `artifactKeys` here would be a client-side guess about a card the wire has
    // not re-read. The keys arrive on the next `load`, same rule `linkSession` runs.
    vi.mocked(writeArtifact).mockResolvedValue(meta);
    const before = useTasks.getState().boardsBySpace[SPACE];
    await useTasks.getState().writeArtifact("t1", "spec", "# Spec\n");
    expect(useTasks.getState().boardsBySpace[SPACE]).toBe(before);
  });

  it("writeArtifact reports a refused key AND rethrows so the editor keeps its draft", async () => {
    vi.mocked(writeArtifact).mockRejectedValue({
      kind: "bad_artifact_key",
      message: "bad artifact key: Bad Key",
    });
    await expect(
      useTasks.getState().writeArtifact("t1", "Bad Key", "x"),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().error).toBe("bad artifact key: Bad Key");
  });

  it("getArtifact forwards and hands back the document", async () => {
    vi.mocked(getArtifact).mockResolvedValue(artifact);
    await expect(
      useTasks.getState().getArtifact("t1", "spec"),
    ).resolves.toEqual(artifact);
    expect(getArtifact).toHaveBeenCalledWith("t1", "spec");
  });

  it("getArtifact passes `null` through as the answer it is (no artifact, no error)", async () => {
    // The `getTask` shape: asking for something that is not there is an answer. A
    // version that turned `null` into an error sentence would make the dialog's
    // "this card has no spec yet" state indistinguishable from a failed read.
    vi.mocked(getArtifact).mockResolvedValue(null);
    await expect(
      useTasks.getState().getArtifact("t1", "spec"),
    ).resolves.toBeNull();
    expect(useTasks.getState().error).toBeNull();
  });

  it("getArtifact reports a failure and rethrows", async () => {
    vi.mocked(getArtifact).mockRejectedValue({
      kind: "command",
      message: "artifact read failed",
    });
    await expect(
      useTasks.getState().getArtifact("t1", "spec"),
    ).rejects.toBeTruthy();
    expect(useTasks.getState().error).toBe("artifact read failed");
  });
});

describe("useTasks.reset — the store-owned half of isolation", () => {
  it("drops every board, the error, the loading flag and the notes", async () => {
    vi.mocked(getBoard).mockResolvedValue(cards(SPACE));
    await useTasks.getState().load(SPACE);
    vi.mocked(moveTask).mockResolvedValue({
      onEnter: "compact",
      boostNote: "no live session to compact",
    });
    await useTasks.getState().moveTask(SPACE, "t1", "doing");
    useTasks.setState({ error: "boom" });

    useTasks.getState().reset();
    expect(useTasks.getState().boardsBySpace).toEqual({});
    expect(useTasks.getState().boostNotes).toEqual({});
    expect(useTasks.getState().error).toBeNull();
    expect(useTasks.getState().loading).toBe(false);
  });

  it("invalidates a load already in flight (the module bookkeeping resetStores cannot reach)", async () => {
    // THE pin for the mandate that BOTH resets are load-bearing. The in-flight
    // `getBoard` belongs to a previous case; a `reset()` that only replaced state
    // would let it land and repopulate a store the next case believes is clean.
    let release: (v: StageWithTasks[]) => void = () => {};
    vi.mocked(getBoard).mockReturnValue(
      new Promise<StageWithTasks[]>((resolve) => {
        release = resolve;
      }),
    );
    const inflight = useTasks.getState().load(SPACE);
    useTasks.getState().reset();
    release(cards(SPACE));
    await inflight;
    expect(useTasks.getState().boardsBySpace).toEqual({});
    expect(useTasks.getState().loading).toBe(false);
  });

  it("leaves the actions callable (a reset that lost them would hang the board)", () => {
    useTasks.getState().reset();
    expect(typeof useTasks.getState().load).toBe("function");
    expect(typeof useTasks.getState().moveTask).toBe("function");
    expect(typeof useTasks.getState().reorderWithinStage).toBe("function");
    // T3's actions too, and this is the half of `reset()` that a state-only reset
    // gets wrong: `reset()` installs `getInitialState()` with `replace=true`, so an
    // action that was accidentally declared on the INITIAL object and not the
    // interface (or the other way round) disappears from a reset store — and the
    // editor's next click is a `… is not a function` throw, in the next test file
    // rather than in this one.
    expect(typeof useTasks.getState().createStage).toBe("function");
    expect(typeof useTasks.getState().renameStage).toBe("function");
    expect(typeof useTasks.getState().setStageSkill).toBe("function");
    expect(typeof useTasks.getState().setStageNext).toBe("function");
    expect(typeof useTasks.getState().reorderStages).toBe("function");
    expect(typeof useTasks.getState().deleteStage).toBe("function");
    expect(typeof useTasks.getState().setBoardStrict).toBe("function");
    expect(typeof useTasks.getState().getBoardStrict).toBe("function");
    expect(typeof useTasks.getState().writeArtifact).toBe("function");
    expect(typeof useTasks.getState().getArtifact).toBe("function");
  });
});

describe("the board's wire shape — the Rust↔TS drift pin (issue #174)", () => {
  /**
   * THE DRIFT PIN for the board's card payload, on the TypeScript side.
   *
   * `src/lib/tauri/types.ts` is a HAND-WRITTEN mirror of the Rust `Serialize`
   * types and this repo holds NO automated Rust↔TS shape check (verified: no Rust
   * test reads a `.ts` file), so the only thing standing between the two is that
   * the key list below is spelled a SECOND time and is BYTE-IDENTICAL to
   * `FROZEN_CARD_KEYS` / `FROZEN_TASK_KEYS` / `FROZEN_LINK_KEYS` in
   * `src-tauri/src/storage/db/tests/mod.rs::the_task_card_view_wire_keys_are_frozen`.
   * A rename on either side reddens one of the two. Modelled on
   * `closed_reason_spellings_are_frozen`, which is the repo's existing
   * spellings-freeze idiom.
   *
   * FOUR card keys since #180 added `artifactKeys`. Both pins were widened in the
   * SAME commit, and that is the only reason either is worth having: a Rust-side
   * field with no TS-side twin is a mirror that stopped being a mirror.
   *
   * WHY IT LIVES HERE rather than in `src/lib/tauri/`: `types.ts` is a pure type
   * module — every field it declares vanishes at compile time, so a test of the
   * interface can only be a test of its SOURCE text plus a literal that the
   * compiler checks. Both halves are here because the store is the file that
   * CONSUMES the shape (it builds a card out of a bare `TaskRow`), which is where
   * a drifted mirror would actually do damage.
   *
   * The `?` (optional) check is the load-bearing extra: an optional `sessions`
   * compiles against every fixture in the repo and then renders NOTHING when real
   * data arrives — the silent-green failure the plan calls out for this field.
   */
  it("the task card view wire keys are frozen (mirror of the Rust pin)", () => {
    // BYTE-IDENTICAL to `FROZEN_CARD_KEYS` in
    // `src-tauri/src/storage/db/tests/mod.rs::the_task_card_view_wire_keys_are_frozen`.
    const FROZEN_CARD_KEYS = ["task", "sessions", "costUsd", "artifactKeys"];
    // BYTE-IDENTICAL to `FROZEN_TASK_KEYS` in that same Rust test — the UNCHANGED
    // 10-field `TaskRow`, which the wrapper adds nothing to. That is what keeps
    // `get_task`/`create_task`/`edit_task` (all plain `TaskRow`) telling the truth.
    const FROZEN_TASK_KEYS = [
      "id",
      "spacePath",
      "number",
      "title",
      "body",
      "specPath",
      "stageSlug",
      "sortOrder",
      "createdAt",
      "updatedAt",
    ];
    // BYTE-IDENTICAL to `FROZEN_LINK_KEYS` in that same Rust test
    // (`src-tauri/src/storage/db/tests/mod.rs::the_task_card_view_wire_keys_are_frozen`),
    // which asserts it against the SERIALIZED `value["sessions"][0]`. This is the
    // THIRD list and the one the chip actually reads: `sessionId` is what a click
    // on the card's chip hands to `openSession`, so a `session_id` ↔ `sessionId`
    // rename would redden nothing in the TS suite and blank every chip on the
    // board — the `#[serde(rename_all = "camelCase")]` seam sat unfrozen.
    const FROZEN_LINK_KEYS = ["taskId", "sessionId", "stageSlug"];

    const types = stripJsComments(readFileSync("src/lib/tauri/types.ts", "utf8"));
    const card = interfaceFields(types, "TaskCardView");
    const row = interfaceFields(types, "TaskRow");
    const link = interfaceFields(types, "TaskSessionRow");

    // The Rust test compares a SORTED key set, so the sorted read is the pin that
    // must match it byte-for-byte; the declaration-order read below is the stricter
    // TS-side pin (the repo's frozen tuples are in interface order, not alphabetical).
    expect([...card.map((f) => f.key)].sort()).toEqual([...FROZEN_CARD_KEYS].sort());
    expect(card.map((f) => f.key)).toEqual(FROZEN_CARD_KEYS);
    expect([...row.map((f) => f.key)].sort()).toEqual([...FROZEN_TASK_KEYS].sort());
    expect(row.map((f) => f.key)).toEqual(FROZEN_TASK_KEYS);
    expect([...link.map((f) => f.key)].sort()).toEqual([...FROZEN_LINK_KEYS].sort());
    expect(link.map((f) => f.key)).toEqual(FROZEN_LINK_KEYS);

    // NO optional field on any of the three. `sessions?:`/`costUsd?:` would compile
    // against every existing fixture and then render nothing while real data
    // arrives, and an optional `sessionId?` on the link would make the chip's click
    // hand `undefined` to `openSession` — the same silent-green shape one level down.
    expect(card.filter((f) => f.optional).map((f) => f.key)).toEqual([]);
    expect(row.filter((f) => f.optional).map((f) => f.key)).toEqual([]);
    expect(link.filter((f) => f.optional).map((f) => f.key)).toEqual([]);

    // The TYPES behind the keys, so `string` cannot quietly replace `number | null`
    // (that swap is what would let a phantom `$0.00` reach the card). The link's
    // `stageSlug` is NULLABLE (`task_sessions.stage_slug` is a nullable column) and
    // its `sessionId` is not — swapping those two is how a chip starts opening a
    // Session that does not exist.
    expect(card.map((f) => f.type)).toEqual([
      "TaskRow",
      "TaskSessionRow[]",
      "number | null",
      "string[]",
    ]);
    expect(link.map((f) => f.type)).toEqual(["string", "string", "string | null"]);

    // The column carries CARDS, not rows — the other half of the wrapper.
    expect(interfaceFields(types, "StageWithTasks").map((f) => f.type)).toEqual([
      "StageRow",
      "TaskCardView[]",
    ]);

    // The RUNTIME mirror of the Rust test's `None` half of ADR 0082: `costUsd` must
    // be PRESENT and `null` for a card with no figure, never absent. Rust pins that
    // against `serde_json` (a `skip_serializing_if` would delete the key); the TS
    // side pins it against the compiler plus the literal the store writes — a card
    // that omitted `costUsd` does not typecheck, and `undefined` is not assignable.
    const unmeasured: TaskCardView = {
      task: task("t_frozen", 1, "backlog"),
      sessions: [],
      costUsd: null,
      artifactKeys: [],
    };
    expect(Object.keys(unmeasured).sort()).toEqual([...FROZEN_CARD_KEYS].sort());
    expect("costUsd" in unmeasured).toBe(true);
    expect(unmeasured.costUsd).toBeNull();
    // `artifactKeys` follows the SAME rule as `costUsd`: present and EMPTY, never
    // absent. Rust pins that against `serde_json` (no `skip_serializing_if` runs on
    // a `Vec<String>`); the TS side pins it here, because `artifactKeys?:` would
    // typecheck against every fixture and then render no chips at all.
    expect("artifactKeys" in unmeasured).toBe(true);
    expect(unmeasured.artifactKeys).toEqual([]);

    // The two #180 artifact shapes, frozen the same way. `Artifact` is the ONLY
    // interface that carries artifact CONTENT across the wire, and its camelCase
    // seam (`taskId`/`createdAt`/`updatedAt`) is exactly the kind of rename that
    // reddens NOTHING: Rust serialises `task_id` → `taskId` through
    // `#[serde(rename_all = "camelCase")]`, so a TS-side `id` would read
    // `undefined` on every artifact. `ArtifactMeta` deliberately has NO `markdown`
    // field — a write echoing the document back is how the board eventually
    // acquires one — so its key list IS the assertion that it does not.
    expect(interfaceFields(types, "Artifact").map((f) => f.key)).toEqual([
      "taskId",
      "key",
      "markdown",
      "createdAt",
      "updatedAt",
    ]);
    expect(interfaceFields(types, "Artifact").map((f) => f.type)).toEqual([
      "string",
      "string",
      "string",
      "number",
      "number",
    ]);
    expect(interfaceFields(types, "Artifact").filter((f) => f.optional).map((f) => f.key)).toEqual(
      [],
    );
    expect(interfaceFields(types, "ArtifactMeta").map((f) => f.key)).toEqual([
      "key",
      "updatedAt",
      "bytes",
    ]);
    expect(interfaceFields(types, "ArtifactMeta").map((f) => f.type)).toEqual([
      "string",
      "number",
      "number",
    ]);
    expect(
      interfaceFields(types, "ArtifactMeta").filter((f) => f.optional).map((f) => f.key),
    ).toEqual([]);
  });
});
