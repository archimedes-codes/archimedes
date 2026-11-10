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
   * `FROZEN_CARD_KEYS` / `FROZEN_TASK_KEYS` in
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

    const types = stripJsComments(readFileSync("src/lib/tauri/types.ts", "utf8"));
    const card = interfaceFields(types, "TaskCardView");
    const row = interfaceFields(types, "TaskRow");

    // The Rust test compares a SORTED key set, so the sorted read is the pin that
    // must match it byte-for-byte; the declaration-order read below is the stricter
    // TS-side pin (the repo's frozen tuples are in interface order, not alphabetical).
    expect([...card.map((f) => f.key)].sort()).toEqual([...FROZEN_CARD_KEYS].sort());
    expect(card.map((f) => f.key)).toEqual(FROZEN_CARD_KEYS);
    expect([...row.map((f) => f.key)].sort()).toEqual([...FROZEN_TASK_KEYS].sort());
    expect(row.map((f) => f.key)).toEqual(FROZEN_TASK_KEYS);

    // NO optional field on either. `sessions?:`/`costUsd?:` would compile against
    // every existing fixture and then render nothing while real data arrives.
    expect(card.filter((f) => f.optional).map((f) => f.key)).toEqual([]);
    expect(row.filter((f) => f.optional).map((f) => f.key)).toEqual([]);

    // The TYPES behind the keys, so `string` cannot quietly replace `number | null`
    // (that swap is what would let a phantom `$0.00` reach the card).
    expect(card.map((f) => f.type)).toEqual(["TaskRow", "TaskSessionRow[]", "number | null"]);

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
