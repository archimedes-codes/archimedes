import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTasks } from "./tasks";
import {
  editTask,
  getBoard,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
  type TaskSessionRow,
} from "../lib/tauri";
import { resetStores } from "../test/resetStores";

/**
 * `src/store/tasks.ts` — the card-text write, `editTask`.
 *
 * WHY ITS OWN FILE: `tasks.test.ts` is baselined at 1066 code lines
 * (`scripts/file-size-baseline-test.txt`) and may not grow by one, and the subject
 * (a card's title / body / spec path) is its own — the split is by subject, as
 * `tasks.position.test.ts` is.
 *
 * THE BARREL MOCK spreads `vi.importActual` and overrides the CAMELCASE wrapper
 * names the store imports; a snake_case key would leave the real wrapper live and
 * it rejects in jsdom (a green test pinning a rejection). `getBoard` is mocked
 * because `beforeEach` seeds the board through `load`.
 *
 * THE LOAD-BEARING ASSERTIONS are the CALL ARGUMENTS: the wrapper is positional and
 * its keep / clear / write states are `undefined` / `null` / string, so every case
 * that forwards pins the exact argument list, `undefined` and `null` apart.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    editTask: vi.fn(),
  };
});

/** The three text fields a caller may pass. Local so the table below reads as the
 *  patch it describes, not as a `Parameters<…>` puzzle. */
type Patch = { title?: string; body?: string | null; specPath?: string | null };

const SPACE = "/p/alpha";
const OTHER = "/p/beta";

const stage = (slug: string, spacePath = SPACE): StageDto => ({
  spacePath,
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
});

const task = (
  id: string,
  number: number,
  stageSlug: string,
  over: Partial<TaskRow> = {},
): TaskRow => ({
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
  ...over,
});

const links: TaskSessionRow[] = [
  { taskId: "t1", sessionId: "sess_first", stageSlug: "backlog" },
  { taskId: "t1", sessionId: "sess_second", stageSlug: null },
];

/** t1 carries two session links, a cost and an artifact key — the only way to pin
 *  "the wrapper's board-only fields survive" (a bare card's `[]`/`null` would be
 *  satisfied by a mutation that dropped them). */
const linked = (): TaskCardView => ({
  task: task("t1", 1, "backlog", {
    title: "Old title",
    body: "old body",
    specPath: "docs/old.md",
  }),
  sessions: links,
  costUsd: 1.75,
  artifactKeys: ["spec"],
  ready: false,
  readySessions: [],
});

const bare = (row: TaskRow): TaskCardView => ({
  task: row,
  sessions: [],
  costUsd: null,
  artifactKeys: [],
  ready: false,
  readySessions: [],
});

const board = (): StageWithTasks[] => [
  {
    stage: stage("backlog"),
    tasks: [linked(), bare(task("t2", 2, "backlog"))],
  },
  { stage: stage("doing"), tasks: [bare(task("t3", 3, "doing"))] },
];

/** The row the command answers: what the DB now holds. */
const stored = (over: Partial<TaskRow> = {}): TaskRow =>
  task("t1", 1, "backlog", {
    title: "New title",
    body: "new body",
    specPath: "docs/new.md",
    updatedAt: 99,
    ...over,
  });

const slice = (space = SPACE): StageWithTasks[] | undefined =>
  useTasks.getState().boardsBySpace[space];

const cardOf = (id: string): TaskCardView | undefined =>
  (slice() ?? []).flatMap((c) => c.tasks).find((t) => t.task.id === id);

beforeEach(async () => {
  resetStores();
  useTasks.getState().reset();
  vi.mocked(getBoard).mockReset();
  vi.mocked(editTask).mockReset();
  vi.mocked(getBoard).mockImplementation(async (space: string) =>
    space === SPACE ? board() : [{ stage: stage("backlog", OTHER), tasks: [] }],
  );
  vi.mocked(editTask).mockResolvedValue(stored());
  await useTasks.getState().load(SPACE);
  await useTasks.getState().load(OTHER);
});

describe("editTask forwards the patch untouched (keep / clear / write)", () => {
  it("sends (taskId, title, body, specPath) positionally and NOT the spacePath", async () => {
    await useTasks
      .getState()
      .editTask(SPACE, "t1", { title: "T", body: "B", specPath: "s.md" });
    expect(editTask).toHaveBeenCalledTimes(1);
    expect(editTask).toHaveBeenCalledWith("t1", "T", "B", "s.md");
    expect(vi.mocked(editTask).mock.calls[0]).toStrictEqual([
      "t1",
      "T",
      "B",
      "s.md",
    ]);
  });

  // [patch, the four wire arguments]. `undefined` = KEEP, `null` = CLEAR,
  // a string = WRITE — and `""` is a write.
  const states: [string, Patch, unknown[]][] = [
    ["an empty patch keeps all three", {}, ["t1", undefined, undefined, undefined]],
    ["a title alone keeps body and specPath", { title: "X" }, ["t1", "X", undefined, undefined]],
    ["body: null clears the body only", { body: null }, ["t1", undefined, null, undefined]],
    ["specPath: null clears the spec path only", { specPath: null }, ["t1", undefined, undefined, null]],
    ["both nulls clear both, title kept", { body: null, specPath: null }, ["t1", undefined, null, null]],
    ['body: "" is a WRITE of the empty string, not a clear', { body: "" }, ["t1", undefined, "", undefined]],
    ['specPath: "" is a WRITE, not a clear', { specPath: "" }, ["t1", undefined, undefined, ""]],
    ["an explicit undefined stays undefined", { title: undefined, body: "b" }, ["t1", undefined, "b", undefined]],
  ];

  it.each(states)("%s", async (_name, patch, args) => {
    await useTasks.getState().editTask(SPACE, "t1", patch);
    // `toStrictEqual` on the raw argument array: it tells `undefined` from `null`
    // and a missing slot from a present one, which `toHaveBeenCalledWith` alone
    // is looser about.
    expect(vi.mocked(editTask).mock.calls[0]).toStrictEqual(args);
    expect(vi.mocked(editTask).mock.calls[0]).toHaveLength(4);
  });
});

describe("editTask resolves and paints the stored row", () => {
  it("resolves the very row the command answered", async () => {
    const row = stored();
    vi.mocked(editTask).mockResolvedValue(row);
    await expect(
      useTasks.getState().editTask(SPACE, "t1", { title: "x" }),
    ).resolves.toBe(row);
  });

  it("paints title/body/specPath/updatedAt on the matching card, keeping the wrapper's other fields", async () => {
    const before = cardOf("t1")!;
    await useTasks.getState().editTask(SPACE, "t1", { title: "x" });
    const after = cardOf("t1")!;
    expect(after.task.title).toBe("New title");
    expect(after.task.body).toBe("new body");
    expect(after.task.specPath).toBe("docs/new.md");
    expect(after.task.updatedAt).toBe(99);
    // Untouched on the row: identity-ish fields the OTHER actions own.
    expect(after.task.id).toBe("t1");
    expect(after.task.number).toBe(1);
    expect(after.task.createdAt).toBe(1);
    // The wrapper's board-only fields ride along by VALUE and by identity.
    expect(after.sessions).toBe(before.sessions);
    expect(after.sessions.map((s) => s.sessionId)).toEqual([
      "sess_first",
      "sess_second",
    ]);
    expect(after.costUsd).toBe(1.75);
    expect(after.artifactKeys).toBe(before.artifactKeys);
    expect(after.artifactKeys).toEqual(["spec"]);
  });

  it("paints a CLEARED field as null (not the old text)", async () => {
    vi.mocked(editTask).mockResolvedValue(
      stored({ body: null, specPath: null }),
    );
    await useTasks
      .getState()
      .editTask(SPACE, "t1", { body: null, specPath: null });
    expect(cardOf("t1")!.task.body).toBeNull();
    expect(cardOf("t1")!.task.specPath).toBeNull();
  });

  it("does not take stageSlug or sortOrder from the row (those belong to the move/reorder actions)", async () => {
    vi.mocked(editTask).mockResolvedValue(
      stored({ stageSlug: "doing", sortOrder: 42 }),
    );
    await useTasks.getState().editTask(SPACE, "t1", { title: "x" });
    expect(cardOf("t1")!.task.stageSlug).toBe("backlog");
    expect(cardOf("t1")!.task.sortOrder).toBe(0);
    expect(
      (slice() ?? [])
        .find((c) => c.stage.slug === "backlog")!
        .tasks.map((t) => t.task.id),
    ).toEqual(["t1", "t2"]);
  });

  it("keeps every untouched column, card and Space slice as the SAME object", async () => {
    const before = slice()!;
    const otherBefore = slice(OTHER);
    const t2 = cardOf("t2");
    await useTasks.getState().editTask(SPACE, "t1", { title: "x" });
    const after = slice()!;
    expect(after).not.toBe(before);
    expect(after[1]).toBe(before[1]); // the "doing" column
    expect(after[0]!.tasks[1]).toBe(t2); // the sibling card in the patched column
    expect(slice(OTHER)).toBe(otherBefore);
  });

  it("leaves the store `error` alone on success", async () => {
    useTasks.setState({ error: "earlier sentence" });
    await useTasks.getState().editTask(SPACE, "t1", { title: "x" });
    expect(useTasks.getState().error).toBe("earlier sentence");
  });

  it("paints nothing for a card the board does not hold, and still resolves the row", async () => {
    const before = slice()!;
    const row = stored();
    vi.mocked(editTask).mockResolvedValue(row);
    await expect(
      useTasks.getState().editTask(SPACE, "t_gone", { title: "x" }),
    ).resolves.toBe(row);
    expect(slice()).toBe(before);
  });

  it("writes through for a Space whose board is not loaded, without inventing a slice", async () => {
    const row = stored();
    vi.mocked(editTask).mockResolvedValue(row);
    await expect(
      useTasks.getState().editTask("/p/unloaded", "t1", { title: "x" }),
    ).resolves.toBe(row);
    expect(editTask).toHaveBeenCalledTimes(1);
    expect(useTasks.getState().boardsBySpace).not.toHaveProperty(
      "/p/unloaded",
    );
  });

  it("reads the slice AFTER the await: a board reloaded mid-flight is the one patched", async () => {
    let settle!: (row: TaskRow) => void;
    vi.mocked(editTask).mockReturnValue(
      new Promise<TaskRow>((resolve) => {
        settle = resolve;
      }),
    );
    const pending = useTasks.getState().editTask(SPACE, "t1", { title: "x" });
    // While the command is in flight the board is re-read with t1 now in "doing".
    vi.mocked(getBoard).mockResolvedValue([
      { stage: stage("backlog"), tasks: [bare(task("t2", 2, "backlog"))] },
      {
        stage: stage("doing"),
        tasks: [bare(task("t3", 3, "doing")), bare(task("t1", 1, "doing"))],
      },
    ]);
    await useTasks.getState().load(SPACE);
    settle(stored());
    await pending;
    const doing = (slice() ?? []).find((c) => c.stage.slug === "doing")!;
    expect(doing.tasks.map((t) => t.task.id)).toEqual(["t3", "t1"]);
    expect(doing.tasks[1]!.task.title).toBe("New title");
    expect(doing.tasks[1]!.task.stageSlug).toBe("doing");
  });
});

describe("editTask on a refusal (the writeArtifact pattern)", () => {
  it("writes `error`, logs, REJECTS with the original error and leaves the slice identical", async () => {
    const refusal = { kind: "empty_title", message: "title must not be empty" };
    vi.mocked(editTask).mockRejectedValue(refusal);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = slice()!;
    try {
      await expect(
        useTasks.getState().editTask(SPACE, "t1", { title: "   " }),
      ).rejects.toBe(refusal);
      expect(useTasks.getState().error).toBe("title must not be empty");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![1]).toBe(refusal);
    } finally {
      log.mockRestore();
    }
    expect(slice()).toBe(before);
  });
});
