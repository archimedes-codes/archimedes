import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTasks } from "./tasks";
import {
  createTask,
  getBoard,
  linkSession,
  moveTask,
  reorderTasks,
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
  };
});

// ---------------------------------------------------------------------------
// Fixtures (local: `src/test/fixtures/` is not this task's file to extend).
// ---------------------------------------------------------------------------

const SPACE = "/w/alpha";
const OTHER = "/w/beta";

const stage = (slug: string, over: Partial<StageRow> = {}): StageRow => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder: 0,
  onEnter: "none",
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
 *  `task`, with the two board-only fields. A board built from bare `TaskRow`s no
 *  longer typechecks against `StageWithTasks.tasks` — which is the point. */
const cardOf = (row: TaskRow): TaskCardView => ({
  task: row,
  sessions: [],
  costUsd: null,
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
): TaskCardView => ({ task: row, sessions, costUsd });

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
});

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
    expect(landed).toEqual({ task: created, sessions: [], costUsd: null });
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
    const FROZEN_CARD_KEYS = ["task", "sessions", "costUsd"];
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
    expect(card.map((f) => f.type)).toEqual(["TaskRow", "TaskSessionRow[]", "number | null"]);
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
    };
    expect(Object.keys(unmeasured).sort()).toEqual([...FROZEN_CARD_KEYS].sort());
    expect("costUsd" in unmeasured).toBe(true);
    expect(unmeasured.costUsd).toBeNull();
  });
});
