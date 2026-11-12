import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import TasksBoard from "./TasksBoard";
import { useTasks } from "../store/tasks";
import { useSessions } from "../store/sessions";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import {
  createStage,
  createTask,
  deleteStage,
  getArtifact,
  getBoard,
  getBoardStrict,
  listSkills,
  moveTask,
  renameStage,
  reorderStages,
  reorderTasks,
  setBoardStrict,
  setStageNext,
  setStageSkill,
  startTaskSession,
  writeArtifact,
  type StageRow,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";

/**
 * `TasksBoard` — the board surface `App`'s `"board"` view renders.
 *
 * THE BARREL MOCK OVERRIDES THE WRAPPER NAMES (`getBoard`, `moveTask`, …), not the
 * snake_case Rust command names — the store imports the wrappers, so mocking
 * `get_board` would leave the real wrapper live and it rejects in jsdom.
 *
 * TWO RESETS in `beforeEach`, both load-bearing: `resetStores()` (the store half of
 * isolation — `useTasks` is now in `ALL_STORES`) plus the store's own `reset()`,
 * which is the only thing that can reach the module-scope load epoch
 * (`src/test/resetStores.ts` documents that limitation, and `tasks.test.ts` pins the
 * consequence). Dropping either hands the next case a dirty board.
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
    // T3's ten: the seven Stage verbs, the Strict pair (issue #179) and the
    // artifact pair (issue #180 D1). The board's `Configure` control mounts the
    // Stage editor, which drives the store's actions, which call these — so an
    // un-mocked one reaches the real `invoke` and rejects in jsdom, and a case
    // below would then be asserting on a rejection instead of on a write. Mocked
    // under the WRAPPER names for the same reason as the seven above.
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
    // The New Task modal's surface (A5). Its composer mounts the four mention
    // catalogs, so an un-mocked export reaches the REAL `invoke` and rejects in
    // jsdom — green-but-noisy tests that hide a real fetch failure. They are
    // mocked under the WRAPPER names for the same reason as the seven above.
    startTaskSession: vi.fn().mockResolvedValue({
      sessionId: "snap1",
      cwd: "/w/alpha",
      capabilities: {},
      archived: false,
    }),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    listMcpServersEffective: vi.fn().mockResolvedValue([]),
    listSpaceListing: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});

const SPACE = "/w/alpha";

/* The New Task modal's mock below spells this path as a LITERAL rather than
 * reading `SPACE`: `vi.mock` factories are hoisted above every declaration in the
 * file, so a factory that names a module const throws
 * `Cannot access 'SPACE' before initialization` and the whole file fails to load
 * with zero tests run. (Measured: this exact shape, on this exact file.) */

/* `onEnterSkill`/`nextSlugs` are REQUIRED on the wire type (the Rust side always
 * emits both), so they default here rather than becoming optional. Both default to
 * `null` = UNCONFIGURED, which is what every pre-#179 column is; `nextSlugs: []` is a
 * DIFFERENT answer (configured, leading nowhere — ADR 0099), so a test that means the
 * empty case must pass it explicitly through `over`. Defaults sit BEFORE the spread so
 * `over` can still override either field. */
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

/** A board CARD as the wire shape carries it (issue #174): the row under `task`
 *  plus the two board-only fields. `task()` stays a plain `TaskRow` because
 *  `createTask` still answers one — the wrapper exists ONLY on the board read. */
const card = (id: string, number: number, stageSlug: string): TaskCardView => ({
  task: task(id, number, stageSlug),
  sessions: [],
  costUsd: null,
  // REQUIRED on the wire type (issue #180): the board carries artifact KEYS only,
  // never the markdown. `[]` means "this card has no artifacts" — an optional field
  // would compile here and render nothing when real data arrives.
  artifactKeys: [],
});

/** The NESTED wire shape. A board built flat (`{ slug, label, tasks }`) is the
 *  failure mode this file exists to catch: it renders BLANK columns without a type
 *  error, so the column-header assertions below are the pin, not decoration. */
const SEED: StageWithTasks[] = [
  { stage: stage("backlog", { sortOrder: 0 }), tasks: [card("t1", 1, "backlog")] },
  {
    stage: stage("doing", { sortOrder: 3, onEnter: "compact" }),
    tasks: [card("t2", 2, "doing"), card("t3", 3, "doing")],
  },
  { stage: stage("done", { sortOrder: 4 }), tasks: [] },
];

/** Give the columns real boxes: jsdom has no layout, so without this every pointer
 *  resolves to no column and the drag assertions would pass on an inert board. */
const layOut = (el: HTMLElement, left: number, top: number, width = 200, height = 400) => {
  el.getBoundingClientRect = () =>
    ({
      left,
      right: left + width,
      width,
      top,
      bottom: top + height,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
};

const layOutColumns = () => {
  for (const [index, slug] of ["backlog", "doing", "done"].entries()) {
    layOut(screen.getByTestId(`task-column-${slug}`), index * 200, 0);
  }
};

/** Give the cards in one column real VERTICAL boxes, because the within-column hook
 *  (`useDragReorder`, `axis: "y"`) reads the ROW's rect and its Y midpoint. Both
 *  axes are non-degenerate on purpose (the lesson at the top of
 *  `useDragReorder.test.tsx`): a rect with no width would let a hook reading the X
 *  axis answer whatever the test expects and pass while broken. */
const layOutCards = (slug: string) => {
  const cards = within(screen.getByTestId(`task-column-${slug}`)).getAllByTestId(
    "task-card-slot",
  );
  cards.forEach((card, index) => {
    layOut(card as HTMLElement, 0, index * 40, 200, 40);
  });
};

/** A `dragover` carrying BOTH coordinates (jsdom swallows the init members, so
 *  they are assigned after construction — see the header of
 *  `useDragReorder.test.tsx`). Y defaults to 10, which is inside every column rect
 *  (0..400) and in the UPPER half of every card rect (0..40 / 40..80). */
const dragOverAt = (el: Element, clientX: number, clientY = 10) => {
  const ev = new Event("dragover", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.assign(ev, { clientX, clientY });
  return fireEvent(el, ev);
};

/** A hand-built `drop` — returned, not fired, so a test can read
 *  `defaultPrevented` afterwards. Takes no element: the caller fires it. */
const dropAt = (clientX: number, clientY = 10) => {
  const ev = new Event("drop", { bubbles: true, cancelable: true, composed: true });
  Object.assign(ev, { clientX, clientY });
  return ev;
};

/**
 * The class STRING via the ATTRIBUTE, not `el.className` — the property is an
 * `SVGAnimatedString` for SVG elements, so reading the property would throw (or
 * read an object) the moment one of these nodes is swapped for an SVG one.
 * Copied from `MutedCaption.test.tsx`, which carries the same note.
 */
function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

/** Whole class TOKENS, so `bg-panel` cannot be satisfied by a substring of some
 *  longer utility the way a `toContain` on the raw string would allow. */
const classTokens = (el: Element): string[] => classOf(el).split(/\s+/);

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  vi.mocked(getBoard).mockReset();
  vi.mocked(moveTask).mockReset();
  vi.mocked(reorderTasks).mockReset();
  vi.mocked(getBoard).mockResolvedValue(SEED);
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
  vi.mocked(reorderTasks).mockResolvedValue(undefined);
  // `createTask` is the modal's write path (A5). It gets a default here because
  // the factory declares a bare `vi.fn()`, which resolves `undefined` — and a
  // modal awaiting a `undefined` TaskRow fails on `task.id` rather than on the
  // thing a test is actually checking.
  vi.mocked(createTask).mockReset();
  vi.mocked(createTask).mockResolvedValue(task("tsk_new", 9, "backlog"));
  // T3's ten, reset and defaulted. The defaults matter for the two the Stage
  // editor AWAITS on mount: `getBoardStrict` seeds the footer Switch, and a bare
  // `vi.fn()` resolves `undefined` there, which the editor reads as a FAILED read
  // and renders the Switch disabled — so every editor case would silently be
  // testing the failure arm.
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
  vi.mocked(getBoardStrict).mockResolvedValue(false);
  vi.mocked(setBoardStrict).mockResolvedValue(undefined);
  vi.mocked(createStage).mockResolvedValue(stage("spike", { sortOrder: 3 }));
  vi.mocked(renameStage).mockResolvedValue(stage("backlog"));
  vi.mocked(setStageSkill).mockResolvedValue(stage("backlog"));
  vi.mocked(setStageNext).mockResolvedValue(stage("backlog"));
  vi.mocked(reorderStages).mockResolvedValue(undefined);
  vi.mocked(deleteStage).mockResolvedValue(undefined);
  vi.mocked(writeArtifact).mockResolvedValue({ key: "spec", updatedAt: 1, bytes: 0 });
  vi.mocked(getArtifact).mockResolvedValue(null);
});

describe("TasksBoard — the header (and the absence of a way back)", () => {
  it("renders NO exit control of its own (the Session list's doors are the only way out)", () => {
    render(<TasksBoard activeSpacePath={SPACE} />);
    // The board is a view the strip switches out of: the pressed `Tasks` door
    // toggles it off and any Session row leaves it, so a board-level `Back` was a
    // third exit only this surface offered. Pinned by the ABSENCE of the control,
    // so re-adding one fails here instead of passing silently.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("titles the surface Tasks", () => {
    render(<TasksBoard activeSpacePath={SPACE} />);
    // The heading, not the sidebar's button (this file renders no sidebar). The
    // board replaces the chat column AND the Side pane, so it has to say what it is.
    expect(
      screen.getByRole("heading", { name: "Tasks", level: 1 }),
    ).toBeTruthy();
  });
});

describe("TasksBoard — what it draws from the store", () => {
  it("loads the board on MOUNT, for the Space it was given", () => {
    render(<TasksBoard activeSpacePath={SPACE} />);
    // MOUNT, not boot: `App`'s boot `Promise.all` gains no fetch, so
    // `App.test.tsx`'s boot mocks stay as they are and a Space that never opens the
    // board never pays for `get_board` — which WRITES (it seeds the five default
    // stages, ADR 0090).
    expect(getBoard).toHaveBeenCalledWith(SPACE);
  });

  it("re-loads when the active Space changes", () => {
    const { rerender } = render(<TasksBoard activeSpacePath={SPACE} />);
    rerender(<TasksBoard activeSpacePath="/w/beta" />);
    expect(getBoard).toHaveBeenLastCalledWith("/w/beta");
    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("renders one column per stage, labelled from board.stage.label", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    // THE NESTED-SHAPE PIN. A board read as `{ slug, label, tasks }` (the original
    // draft's flat shape) renders THREE EMPTY COLUMNS here and typechecks if the
    // value is spread loosely — so the label assertion is the loud version of a
    // failure that would otherwise be silent.
    expect(screen.getByTestId("task-column-backlog").textContent).toContain("Backlog");
    expect(screen.getByTestId("task-column-doing").textContent).toContain("Doing");
    expect(screen.getByTestId("task-column-done").textContent).toContain("Done");
    expect(screen.getAllByTestId(/^task-column-/)).toHaveLength(3);
  });

  it("renders the cards inside their own column, with the number label", () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    const backlog = screen.getByTestId("task-column-backlog");
    const doing = screen.getByTestId("task-column-doing");
    expect(within(backlog).getByText("T1")).toBeTruthy();
    expect(within(backlog).getByText("Card 1")).toBeTruthy();
    expect(within(doing).getAllByTestId("task-card")).toHaveLength(2);
    // A card never leaks into a sibling column — that is what a flat-shape or
    // wrong-key join looks like from the outside. `backlog` holds EXACTLY `t1`, and
    // `doing`'s two cards are `T2`/`T3` with no `T1` among them.
    expect(within(backlog).getAllByTestId("task-card")).toHaveLength(1);
    expect(within(backlog).getByTestId("task-card").getAttribute("data-task-id")).toBe(
      "t1",
    );
    expect(within(doing).queryByText("T1")).toBeNull();
  });

  it("renders an empty column as an empty column (not a missing column)", () => {
    // `get_board` sends an empty column as an empty `tasks`, and the seeded default
    // board is FIVE columns with no cards. Dropping empty columns would make a fresh
    // board look like the fetch failed.
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    const done = screen.getByTestId("task-column-done");
    expect(within(done).queryAllByTestId("task-card")).toHaveLength(0);
    expect(done.textContent).toContain("Done");
  });

  it("shows a loading state while the first fetch is in flight", () => {
    let release: (v: StageWithTasks[]) => void = () => {};
    vi.mocked(getBoard).mockReturnValue(
      new Promise<StageWithTasks[]>((resolve) => {
        release = resolve;
      }),
    );
    render(<TasksBoard activeSpacePath={SPACE} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryAllByTestId("task-column")).toHaveLength(0);
    release(SEED);
  });

  it("renders the store's error sentence on failure", async () => {
    vi.mocked(getBoard).mockRejectedValue({
      kind: "not_a_space",
      message: "that folder is not a Space",
    });
    render(<TasksBoard activeSpacePath={SPACE} />);
    // `role="alert"` is the repo's inline IPC-error line (`IpcErrorLine`), so a
    // screen reader hears the failure rather than seeing red text appear.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "that folder is not a Space",
    );
  });

  it("renders nothing but the header when there is no active Space", () => {
    // `useActiveSpaceCwd()` is `null` with no active Session, and the board arm is
    // reachable from the sidebar then. `get_board(null)` is not a thing.
    render(<TasksBoard activeSpacePath={null} />);
    expect(getBoard).not.toHaveBeenCalled();
    // The header still renders — and its one remaining control is the creation
    // affordance, correctly dead with no Space to file a Task in. (The `Back`
    // this case used to assert is retired: the strip's doors are the way out.)
    expect(
      (screen.getByRole("button", { name: "New task" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByRole("heading", { name: "Tasks" })).toHaveLength(1);
  });
});

describe("TasksBoard — the cross-column drag", () => {
  it("a card dropped in another column calls moveTask once", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    const card = within(screen.getByTestId("task-column-backlog")).getByTestId(
      "task-card",
    );
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    const done = screen.getByTestId("task-column-done");
    dragOverAt(done, 450);
    fireEvent(done, dropAt(450));
    // The cross-column verb, and NOT the within-column one: `moveTask` writes
    // `stage_slug` and runs the destination's `on_enter`.
    await Promise.resolve();
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(moveTask).toHaveBeenCalledWith(SPACE, "t1", "done");
    expect(reorderTasks).not.toHaveBeenCalled();
  });

  it("a card dropped in another column starts NO Session (spec §6.4)", async () => {
    // THE INVARIANT NOTHING ELSE PINNED AT THE BOARD. A drop that started a Session
    // would strand its own `ask` gate: `App`'s view ternary renders THIS board in
    // place of `ChatStream`, so the gate's transcript is not on screen to be answered,
    // and `ask_flow` blocks on a oneshot with no timeout — the board would hang on its
    // own drag. `TaskCard.test.tsx` pins the half at the card boundary (a drop from the
    // pill's subtree reaches the row and launches nothing); that file explicitly reports
    // the board's drop route as a gap it cannot observe from a card render. This is the
    // other half.
    //
    // THE PIN IS NOT VACUOUS, and the reason matters. `store/taskLaunch` refuses a
    // launch whose skill the catalog lacks, and this file's `listSkills` resolves `[]`,
    // so a destination WITH a skill would never reach `startTaskSession` — the case
    // would pass on a refusal rather than on the absence of a call. The column dropped
    // into here is `done`, whose `onEnterSkill` is `null`: a destination with NO Skill
    // is launchable outright (`missingSkill` answers `null`), so if the drop route ever
    // reached `launchFromCard`, `startTaskSession` WOULD be called. Its silence is
    // therefore evidence about the route and not about the catalog.
    //
    // `mockClear` scopes the claim to THIS gesture. Unlike `moveTask`/`reorderTasks`,
    // `startTaskSession` is not reset in the file's `beforeEach` — the mock factory
    // gives it a resolved value there and every case in the file shares that one
    // `vi.fn` — so without the clear a launch from an EARLIER case would redden a
    // board that never launched on its own drop.
    vi.mocked(startTaskSession).mockClear();
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    const card = within(screen.getByTestId("task-column-backlog")).getByTestId(
      "task-card",
    );
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    const done = screen.getByTestId("task-column-done");
    dragOverAt(done, 450);
    fireEvent(done, dropAt(450));
    // A macrotask, not one microtask tick: a launch is a CHAINED async sequence
    // (move → start → send), so draining a single `Promise.resolve` would let a
    // regressed route still look silent at assertion time. This flushes every
    // pending microtask, so `startTaskSession` would have been reached if it were
    // going to be.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(startTaskSession).not.toHaveBeenCalled();
    // And the board is not merely INERT: the drop still performs the one write it
    // owns — the cross-column move, and not the within-column reorder.
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(moveTask).toHaveBeenCalledWith(SPACE, "t1", "done");
    expect(reorderTasks).not.toHaveBeenCalled();
  });

  it("the column a drop would land in is marked while the card is over it", () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    const card = within(screen.getByTestId("task-column-backlog")).getByTestId(
      "task-card",
    );
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    const doing = screen.getByTestId("task-column-doing");
    dragOverAt(doing, 250);
    expect(screen.getByTestId("task-column-doing").getAttribute("data-over")).toBe(
      "true",
    );
    expect(screen.getByTestId("task-column-backlog").hasAttribute("data-over")).toBe(
      false,
    );
  });
});

describe("TasksBoard — the boostNote warning (spec §5's caveat 2)", () => {
  it("renders the note the move returned, because the card moved AND the boost did not fire", async () => {
    vi.mocked(moveTask).mockResolvedValue({
      onEnter: "compact",
      boostNote: "no live session to compact",
    });
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    const card = within(screen.getByTestId("task-column-backlog")).getByTestId(
      "task-card",
    );
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    const doing = screen.getByTestId("task-column-doing");
    dragOverAt(doing, 250);
    fireEvent(doing, dropAt(250));
    // THE SILENT-GREEN PIN. A `compact` column with a stored Session compacts
    // NOTHING; the drag looked perfect. The sentence must be on screen.
    expect(await screen.findByTestId("boost-note")).toBeTruthy();
    expect(screen.getByTestId("boost-note").textContent).toContain(
      "no live session to compact",
    );
    // And it is a WARNING, not an error: the card moved, so the destructive error
    // line must not be what carries it.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders nothing when the outcome carries no note", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    const card = within(screen.getByTestId("task-column-backlog")).getByTestId(
      "task-card",
    );
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    const done = screen.getByTestId("task-column-done");
    dragOverAt(done, 450);
    fireEvent(done, dropAt(450));
    await Promise.resolve();
    expect(screen.queryByTestId("boost-note")).toBeNull();
  });

  it("a read note can be dismissed", async () => {
    vi.mocked(moveTask).mockResolvedValue({
      onEnter: "compact",
      boostNote: "no live session to compact",
    });
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    const card = within(screen.getByTestId("task-column-backlog")).getByTestId(
      "task-card",
    );
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    const doing = screen.getByTestId("task-column-doing");
    dragOverAt(doing, 250);
    fireEvent(doing, dropAt(250));
    expect(await screen.findByTestId("boost-note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("boost-note")).toBeNull();
  });
});

describe("TasksBoard — the within-column drag", () => {
  it("a card dropped on a sibling in its OWN column persists with ONE reorderTasks call", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    layOutCards("doing");
    const doing = screen.getByTestId("task-column-doing");
    const [first, second] = within(doing).getAllByTestId("task-card");
    // `t2` is grabbed and dropped onto `t3`'s LOWER half → AFTER it. `t3` spans y
    // 40..80, so y 70 is below its midpoint. The midpoint arithmetic is
    // `useDragReorder`'s, reused unchanged with `axis: "y"`.
    fireEvent.dragStart(first!, { dataTransfer: { setData: vi.fn() } });
    dragOverAt(second!, 250, 70);
    fireEvent(second!, dropAt(250, 70));
    await Promise.resolve();
    expect(reorderTasks).toHaveBeenCalledTimes(1);
    expect(reorderTasks).toHaveBeenCalledWith(SPACE, "doing", ["t3", "t2"]);
    // The within-column verb writes NO stage: a reorder that also moved the card
    // would run the destination column's `on_enter` for a drag that changed nothing.
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("the drop edge paints on the row the pointer is in, and only there", () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    layOutColumns();
    layOutCards("doing");
    const doing = screen.getByTestId("task-column-doing");
    const [first, second] = within(doing).getAllByTestId("task-card");
    fireEvent.dragStart(first!, { dataTransfer: { setData: vi.fn() } });
    // The UPPER half of `t3`'s box (it spans y 40..80 as laid out) → BEFORE.
    dragOverAt(second!, 250, 50);
    expect(
      within(doing).getAllByTestId("task-card-slot")[1]!.getAttribute("data-edge"),
    ).toBe("before");
    expect(
      within(doing).getAllByTestId("task-card-slot")[0]!.hasAttribute("data-edge"),
    ).toBe(false);
  });
});

describe("TasksBoard — the New Task modal's render site (A5)", () => {
  // The claim here is the RENDER SITE and nothing else: the board owns the open
  // flag and the affordance, and the modal it renders is pointed at the SAME
  // Space and the SAME column set the board is painting (the first column is
  // where a new Task lands, so a board and a modal that disagree about the
  // columns would file a card in a stage the user never chose). What the modal
  // itself does on send is `NewTaskDialog.test.tsx`'s subject.
  it("the header carries a New task affordance", () => {
    render(<TasksBoard activeSpacePath={SPACE} />);
    expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
  });

  it("the affordance is disabled with no active Space (createTask(null, …) is not a thing)", () => {
    render(<TasksBoard activeSpacePath={null} />);
    const button = screen.getByRole("button", {
      name: "New task",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("clicking it opens the modal; closing it leaves the board", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    expect(screen.queryByRole("heading", { name: "New task" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const heading = await screen.findByRole("heading", { name: "New task" });
    expect(heading).toBeTruthy();
    // The modal is a FORM, not a chat. No composer island, no send affordance, no
    // message list — the text-only shape the rewrite introduced is what this case
    // exists to keep visible.
    expect(document.querySelector('[data-testid="composer-island"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "New task" })).toBeNull(),
    );
    // The board is still standing underneath (the modal is an overlay, not a
    // route): closing it must not cost the user the board they came from.
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    expect(screen.getAllByTestId(/^task-column-/)).toHaveLength(3);
  });

  it("the modal files a Backlog card in the backlog column", async () => {
    // The wiring assertion that makes the render site more than a boolean, restated
    // for the text-only modal: the modal resolves its column from the STORE the board
    // seeded, so a card lands in the column the human is looking at — without a refetch
    // (`get_board` seeds stages on read, so a refetch is a wider mutation than the one
    // being displayed).
    vi.mocked(createTask).mockResolvedValue({
      id: "tsk_new",
      spacePath: SPACE,
      number: 9,
      title: "Draft card",
      body: null,
      specPath: null,
      stageSlug: "backlog",
      sortOrder: 8,
      createdAt: 1,
      updatedAt: 1,
    });
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} onReturnToWorkspace={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    // Named, not bare: the modal now has a Title `<input>` AND a Body `<textarea>`,
    // and BOTH carry ARIA role `textbox`, so an unnamed query is an ambiguous match.
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "Draft card" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Backlog" }));

    // `null` and not `undefined` for the body: the Body field was left empty, and the
    // store's parameter is `body?: string | null`.
    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(SPACE, "Draft card", null, "backlog"),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("task-column-backlog")).getByText("T9"),
      ).toBeTruthy(),
    );
    // Backlog starts no Session, so the board STAYS — the new card is the thing to
    // look at, and it is on this surface.
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
  });
});

describe("TasksBoard — the surface ladder (ADR 0097: island, then recess)", () => {
  // Three of the four rungs the board owns, pinned as CLASS TOKENS. This file had
  // zero className assertions before this block — everything else here reads
  // `data-testid` / `data-*` / call counts — and the defect being fixed here is
  // invisible to all of those: the board's root was painted the CHROME colour, the
  // exact colour the Session list wears, so island-vs-chrome contrast was 1.00 and
  // the board read as the background showing through. One level lower, the column
  // and the card wore the SAME token, so a card sitting ON a column was the same
  // colour as the column it sat in, separated only by its border.
  //
  // Token strings and not computed colours: jsdom resolves no cascade, so
  // `getComputedStyle` would answer `""` for every one of these and the test would
  // pass on a broken board.
  const seeded = () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
  };

  it("the board is an island", () => {
    // The island recipe the Side pane and the Settings halves already wear:
    // `m-1` (the 4px frame gap that lets the chrome plane show around it),
    // `rounded-xl` (what makes it read as an island and not a column), `bg-chat`
    // (the transcript's own plane, one rung above chrome), and `overflow-hidden`
    // (the island clips its own corners).
    //
    // `min-w-0` is the LOAD-BEARING one and is pinned here: the board is a direct
    // child of `content-row`, which is a flex ROW with no `flex-col`, so the main
    // axis is width and a long row of `w-72` columns would otherwise push the
    // section wide instead of handing the width to `overflow-x-auto`.
    //
    // `min-h-0` is deliberately ABSENT and asserted so: the parent is a row, not a
    // column, so `min-height:auto` never blocks shrinking, and `overflow-hidden`
    // already gives a flex item an automatic minimum size of zero per the flexbox
    // spec. `SidePane`'s root — the exact structural twin (row child, `flex-col`,
    // `overflow-hidden`) — carries neither.
    seeded();
    const tokens = classTokens(screen.getByTestId("tasks-board"));
    expect(tokens).toContain("m-1");
    expect(tokens).toContain("rounded-xl");
    expect(tokens).toContain("bg-chat");
    expect(tokens).toContain("overflow-hidden");
    expect(tokens).toContain("min-w-0");
    expect(tokens).not.toContain("min-h-0");
    // The chrome token must be GONE, not merely joined by another: two background
    // utilities on one node is a tie CSS resolves by stylesheet order, so a
    // half-migrated root would still paint chrome on some themes.
    expect(tokens).not.toContain("bg-frame");
  });

  it("a column recesses", () => {
    // The recess half of the pair — the raise half lives in
    // `TaskCard.test.tsx`, where the card's own tests live. Together they pin the
    // PAIR: an edit that returns both to the one shared translucent token reddens
    // one of the two. A column sits ON the island, so it goes DOWN a rung
    // (`bg-panel`), which is what `MessageBubble` / `ToolCallCard` already do
    // inside the transcript for the same reason. `border border-border` stays: in
    // default-light `bg-panel` and `bg-card` are both `#ffffff`, so there the border is
    // the only thing separating a column from the island under it.
    seeded();
    const tokens = classTokens(screen.getByTestId("task-column-backlog"));
    expect(tokens).toContain("bg-panel");
    expect(tokens).not.toContain("bg-surface");
    // The seam is the SEAM token now, not the generic border. The reasoning in the
    // comment above still holds, it just applies to `--color-card-border`: in
    // default-light `bg-panel` and `bg-card` are both `#ffffff`, so there the seam is
    // the only thing separating a column from the island under it — and the four
    // quiet palettes keep that token aliasing `--color-border` (10% alpha) exactly
    // so this sentence stays true.
    expect(tokens).toContain("border-card-border");
    expect(tokens).not.toContain("border-border");
  });

  it("the seam is the card-border token, not the generic border", () => {
    // Dracula is the only palette whose `--color-border` is OPAQUE (`#6272a4`,
    // 3.68 against the column fill) while its elevation ladder steps 1.22 / 1.47
    // — so a column outline drawn in that token dominated the fills it was meant
    // to sit between. The palette declares a seam token for exactly this job and
    // it had effectively no consumer, so the board's resting seam routes through
    // it and the generic border must be GONE rather than merely joined: two
    // border-colour utilities on one node is a tie CSS resolves by stylesheet
    // order, so a half-migrated column would still paint the loud ink on Dracula.
    //
    // The DRAG affordance is deliberately not pinned here. A drop target is meant
    // to be loud, and the gesture state is DATA (`data-over`, asserted in the
    // case above) rather than a class — the same reason `SessionStatusMark` is
    // queried by `data-dot`: a test that asserts on the STATE cannot pass because
    // a different utility happened to survive tailwind-merge.
    seeded();
    const tokens = classTokens(screen.getByTestId("task-column-backlog"));
    expect(tokens).toContain("border-card-border");
    expect(tokens).not.toContain("border-border");
  });

  it("the board's columns line up with its header", () => {
    // THE ALIGNMENT FIX, and the correction of a wrong call. An earlier pass
    // dropped `px-3 pb-3` from the scroller on the theory that the island's `m-1`
    // "provides the gutter". It does not: `m-1` is the OUTER frame gap — the 4px of
    // chrome plane that shows OUTSIDE the island — and not inner padding at all.
    // With the scroller unpadded the header sat inset 12px (`px-3`) while the first
    // column started at 0, so the board had two left edges. The padding is therefore
    // RESTORED and this case now asserts the opposite of what it used to.
    //
    // The scroller has NO `data-testid` and gets none: the class is the thing under
    // test, so it is also the handle, and `overflow-x-auto` appears exactly once
    // inside the board (no column or card carries it), which makes this selector
    // single-match by construction.
    seeded();
    const scroller = document.querySelector(
      '[data-testid="tasks-board"] .overflow-x-auto',
    ) as HTMLElement | null;
    expect(scroller).toBeTruthy();
    const tokens = classTokens(scroller as HTMLElement);
    expect(tokens).toContain("px-3");
    expect(tokens).toContain("pb-3");
    // And the three that must SURVIVE the change: without `overflow-x-auto` the
    // `w-72` columns have no escape and the island clips them; without `min-h-0`
    // the scroller cannot shrink inside the `flex-col` root; without `gap-2` the
    // columns touch.
    expect(tokens).toContain("overflow-x-auto");
    expect(tokens).toContain("min-h-0");
    expect(tokens).toContain("gap-2");
    // The header's inset is the OTHER half of "one left edge" — pinned so a future
    // edit cannot restore the mismatch by moving the header instead of the columns.
    const header = screen
      .getByRole("heading", { name: "Tasks" })
      .closest("header") as HTMLElement;
    expect(classTokens(header)).toContain("px-3");
  });

  it("the columns hug their content, not the board's height", () => {
    // THE MECHANISM, pinned as a class because that is the only honest handle
    // here: jsdom performs no layout, so a column's HEIGHT cannot be asserted at all
    // (the drag tests stub every `getBoundingClientRect` with hardcoded rects, which
    // is precisely why real column height affects no other assertion in this repo).
    //
    // The scroller is a flex ROW, and a flex row's default `align-items` is
    // `stretch` — that default, and nothing else, is what stretched every column to
    // the full board height. `items-start` is therefore THE switch: drop it and the
    // column fills return, silently, no matter what the inner list does. The inner
    // list is the second half: `flex-1` + `overflow-y-auto` made a column fill and
    // scroll INTERNALLY, which is the behaviour being removed — with content-height
    // columns the board scrolls instead (the scroller's `overflow-y-auto`).
    seeded();
    const scroller = document.querySelector(
      '[data-testid="tasks-board"] .overflow-x-auto',
    ) as HTMLElement | null;
    expect(scroller).toBeTruthy();
    expect(classTokens(scroller as HTMLElement)).toContain("items-start");
    // A tall column scrolls the BOARD, so the vertical axis has to be scrollable
    // here once no column scrolls itself.
    expect(classTokens(scroller as HTMLElement)).toContain("overflow-y-auto");
    // The inner list is the card strip; the slot is its direct child, so the
    // slot's parent IS the list — no new selector or attribute needed.
    const slot = within(screen.getByTestId("task-column-backlog")).getByTestId(
      "task-card-slot",
    );
    const list = slot.parentElement as HTMLElement;
    expect(list).toBeTruthy();
    const listTokens = classTokens(list);
    expect(listTokens).toContain("flex");
    expect(listTokens).toContain("flex-col");
    expect(listTokens).not.toContain("flex-1");
    expect(listTokens).not.toContain("overflow-y-auto");
    expect(listTokens).not.toContain("min-h-0");
  });

  it("the column count is a pill on the island plane", () => {
    // The count is a COUNT, not a caption, so it gets a fill rather than quiet ink.
    // The fill must DIFFER FROM BOTH surfaces it can sit against — the column's
    // `bg-panel` and the card's `bg-card` — IN EVERY PALETTE. The claim this
    // replaces read "`bg-chat` is the one token that reads on BOTH surfaces
    // (1.22 / 1.21)": those were Dracula-only figures, and that single-palette
    // check is exactly what shipped the bug — in `.theme-default-dark` `--color-chat`
    // is `color-mix(… var(--color-background-win-alt) 60%, transparent)` and
    // `--color-background-win-alt` IS `--color-card` (`#2b2b2b`), so compositing
    // the pill over a card gives the card back: 1.00, invisible. `bg-background`
    // measures 1.10 (panel) / 1.34 (card) in Dracula, 1.11 / 1.28 in default-dark and
    // 1.06 / 1.06 in default-light, and its ink stays readable in all three. The
    // per-palette census lives in `src/lib/slabFloatSeparation.test.ts`.
    seeded();
    const count = within(screen.getByTestId("task-column-backlog")).getByText("1");
    const tokens = classTokens(count);
    expect(tokens).toContain("rounded-full");
    expect(tokens).toContain("bg-background");
    // The number is DATA and not only a class — the column still reports its own
    // count, which is what `renders one column per stage` and the empty-column case
    // read through `textContent`.
    expect(count.textContent).toBe("1");
  });
});

describe("TasksBoard — the sessions chip's wiring (issue #174)", () => {
  it("the board hands the session store to the card", () => {
    // THE WIRING, pinned where the store is imported. `TaskCard` is presentational
    // and subscribes to NO store — so the board, which already reads `useTasks`,
    // is what reads `useSessions.getState().openSession` and passes it down. A
    // card that imported the sessions store itself would be a second owner of
    // "which Session is open" and would have to be mocked by every test that
    // renders one.
    //
    // `openSession` and NOT `setActiveSession`: `setActiveSession` only sets an id,
    // while `openSession` resolves the owner Space by `cwd` across live / stored /
    // archived membership and loads the history — which is what makes a CLOSED or
    // archived Session openable from a card. A linked Session is not structurally
    // in the card's Space (`sessions` has no `space_path`), so the Space has to be
    // resolved rather than assumed.
    //
    // The action is OVERRIDDEN through the store rather than `vi.spyOn(useSessions, …)`:
    // zustand actions are reached by selector, so a spy on the module object cannot
    // see them (`SessionsSection.test.tsx` documents the same limitation). The
    // override additionally keeps this from firing a real `loadHistory` IPC into
    // jsdom.
    const openSession = vi.fn();
    useSessions.setState({ openSession });
    const board: StageWithTasks[] = [
      {
        stage: stage("backlog"),
        tasks: [
          {
            task: task("t1", 1, "backlog"),
            // OLDEST FIRST, as the board read publishes it: `sess_old` was linked
            // before `sess_new`, so `sess_new` is the one a click must open.
            sessions: [
              { taskId: "t1", sessionId: "sess_old", stageSlug: "backlog" },
              { taskId: "t1", sessionId: "sess_new", stageSlug: "doing" },
            ],
            costUsd: 1.25,
            artifactKeys: [],
          },
        ],
      },
    ];
    // Both the store seed and the mount fetch, so the board cannot be replaced by
    // the file's default `SEED` (whose cards carry no links) mid-case.
    vi.mocked(getBoard).mockResolvedValue(board);
    useTasks.setState({ boardsBySpace: { [SPACE]: board } });
    render(<TasksBoard activeSpacePath={SPACE} />);

    // The chip renders from the board's OWN card view — the board passes
    // `sessions` and `costUsd` through rather than re-deriving them (the cost is
    // summed in Rust, and the card adds nothing).
    const chip = within(screen.getByTestId("task-column-backlog")).getByText(
      "2 sessions · $1.25",
    );
    fireEvent.click(chip);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith("sess_new");
  });
});

describe("TasksBoard — opening a card (PR #178)", () => {
  /** The nth card of one column. Scoped, because the detail modal renders the same
   *  title text as the card it came from. */
  const cardIn = (slug: string, index: number): HTMLElement =>
    within(screen.getByTestId(`task-column-${slug}`)).getAllByTestId(
      "task-card",
    )[index]!;

  /** The board with one linked card, seeded AND fetched, so the mount effect cannot
   *  replace the slice mid-case with the file's card-less `SEED`. */
  const seedLinkedBoard = (): void => {
    const board: StageWithTasks[] = [
      {
        stage: stage("backlog"),
        tasks: [
          {
            task: task("t1", 1, "backlog"),
            sessions: [{ taskId: "t1", sessionId: "sess_1", stageSlug: "backlog" }],
            costUsd: 0.5,
            artifactKeys: [],
          },
        ],
      },
      // The column the launch cases below ASSUME. `TaskDetailDialog` derives its
      // buttons from the Stage graph (issue #179): `next_slugs` first, and with that
      // NULL the Stage at `sortOrder + 1`. `backlog` here is unconfigured, so the
      // fallback is the ONLY thing that can produce a button — and with no column at
      // `sortOrder 1` the modal correctly renders NO button at all. A fixture that
      // seeded only `backlog` (0) and `doing` (also 0, the `stage()` default) therefore
      // made "click Discuss" click a control that never existed. The column is what was
      // missing, not the assertion.
      { stage: stage("discuss", { sortOrder: 1, onEnterSkill: "discuss" }), tasks: [] },
      { stage: stage("doing"), tasks: [] },
    ];
    vi.mocked(getBoard).mockResolvedValue(board);
    useTasks.setState({ boardsBySpace: { [SPACE]: board } });
  };

  it("clicking a card opens the detail modal for THAT card", () => {
    // The board owns the modal's open flag and the id it names, exactly as it owns
    // the New Task modal's flag: the columns the modal needs are already here.
    seedLinkedBoard();
    render(<TasksBoard activeSpacePath={SPACE} onReturnToWorkspace={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Clicked through the COLUMN, because the modal renders the same title text the
    // card does — an unscoped `getByText("Card 1")` would be a multiple-match throw
    // once the modal is up, which is a fixture artifact and not the behaviour.
    fireEvent.click(cardIn("backlog", 0));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("T1")).toBeTruthy();
  });

  it("one card click opens ONE modal, not one per card", () => {
    // A flag that stored `true` instead of an id would render a dialog per card, and
    // every one of them would name the first card.
    const board: StageWithTasks[] = [
      {
        stage: stage("backlog"),
        tasks: [
          { task: task("t1", 1, "backlog"), sessions: [], costUsd: null, artifactKeys: [] },
          { task: task("t2", 2, "backlog"), sessions: [], costUsd: null, artifactKeys: [] },
        ],
      },
    ];
    vi.mocked(getBoard).mockResolvedValue(board);
    useTasks.setState({ boardsBySpace: { [SPACE]: board } });
    render(<TasksBoard activeSpacePath={SPACE} onReturnToWorkspace={vi.fn()} />);
    fireEvent.click(cardIn("backlog", 1));
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]!).getByText("T2")).toBeTruthy();
  });

  it("closing the modal leaves the board", async () => {
    seedLinkedBoard();
    render(<TasksBoard activeSpacePath={SPACE} onReturnToWorkspace={vi.fn()} />);
    fireEvent.click(cardIn("backlog", 0));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
  });

  it("the modal disappears when the board leaves, so no dialog floats over Settings", () => {
    // The flag lives in THIS component, so unmounting the board unmounts the modal —
    // the same reason the New Task flag lives here rather than at `App`. Pinned
    // because moving the flag to `App` for convenience would put a Task dialog over
    // the Settings page, where the card it names is not even visible.
    seedLinkedBoard();
    const { unmount } = render(
      <TasksBoard activeSpacePath={SPACE} onReturnToWorkspace={vi.fn()} />,
    );
    fireEvent.click(cardIn("backlog", 0));
    expect(screen.getByRole("dialog")).toBeTruthy();
    unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the chip opens its session AND leaves the board", () => {
    // THE BUG THIS CHANGE FIXES. `openSession` selects the Session in the store, but
    // the board VIEW covers the chat column — `App`'s "board" arm renders the board in
    // place of `ChatStream`. So before this prop existed, clicking the chip started a
    // visible nothing: the row appeared in the sidebar beside the board and the
    // transcript stayed behind it.
    const openSession = vi.fn();
    useSessions.setState({ openSession });
    const onReturnToWorkspace = vi.fn();
    seedLinkedBoard();
    render(
      <TasksBoard
        activeSpacePath={SPACE}
        onReturnToWorkspace={onReturnToWorkspace}
      />,
    );
    fireEvent.click(screen.getByText("1 session · $0.50"));
    expect(openSession).toHaveBeenCalledWith("sess_1");
    expect(onReturnToWorkspace).toHaveBeenCalledTimes(1);
  });

  it("the detail modal leaves the board when it launches a session", async () => {
    // The same occlusion, one surface later: a launched Session is invisible behind
    // the board. The modal calls `onLaunched`, the board turns it into the view
    // switch, and `App` owns `setView` — the board has never owned a view and does
    // not start here.
    // THE FILE'S DEFAULT `listSkills` RESOLVES `[]`, and `store/taskLaunch` REFUSES a
    // launch whose skill the catalog lacks (an unmatched `$discuss` token would ride
    // the message verbatim). So this case has to install the skill, or it is asserting
    // a refusal it never intended to test — the launch fails, the modal stays up, and
    // the view switch never happens. That refusal is itself pinned in
    // `TaskDetailDialog.test.tsx`; here it is only an obstacle.
    vi.mocked(listSkills).mockResolvedValue([
      {
        name: "discuss",
        description: "discuss",
        path: "/s/discuss.md",
        dir: "/s",
        scope: "user",
        body: "DISCUSS",
        disableModelInvocation: false,
        shadowed: [],
      },
    ]);
    // The catalog is MODULE-CACHED per Space, and an earlier case in this file already
    // rendered the modal against the default `[]`, so the mock alone would never be
    // consulted — the cached promise answers first. The cache that holds SKILLS is
    // `useSkillCatalog`'s own Map and NOT `useMentionCatalogs`' three (the skills hook
    // keeps its independent Map precisely so an agent-overwrite invalidation cannot
    // evict the shared skill listing), so clearing the wrong one is a silent no-op.
    clearSkillCatalogCache();
    const onReturnToWorkspace = vi.fn();
    seedLinkedBoard();
    render(
      <TasksBoard
        activeSpacePath={SPACE}
        onReturnToWorkspace={onReturnToWorkspace}
      />,
    );
    fireEvent.click(cardIn("backlog", 0));
    // Wait for ENABLED, not merely for the button to exist: each button is gated on
    // the skill it needs, and the catalog is an async fetch that starts empty. Clicking
    // the first paint would click a disabled button and assert on nothing.
    const discuss = await waitFor(() => {
      const b = screen.getByRole("button", {
        name: "Discuss",
      }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(discuss);
    await waitFor(() => expect(onReturnToWorkspace).toHaveBeenCalledTimes(1));
  });

  it("leaves the board when a session row in the sidebar is clicked", () => {
    // The board carries no exit control (ADR 0095: the Session list IS the switcher),
    // so if a Session row did not leave the view, a card's chip would be the ONLY way
    // to reach a transcript — and the modal's session list routes through the very
    // same `openSession`.
    const onReturnToWorkspace = vi.fn();
    seedLinkedBoard();
    render(
      <TasksBoard
        activeSpacePath={SPACE}
        onReturnToWorkspace={onReturnToWorkspace}
      />,
    );
    fireEvent.click(cardIn("backlog", 0));
    fireEvent.click(within(screen.getByRole("dialog")).getByTestId("task-session-row"));
    expect(onReturnToWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("TasksBoard — the Stage editor's render site (T3)", () => {
  // The claim is the RENDER SITE and nothing else — the same shape the New Task
  // modal's describe above makes. `Configure` is the board's affordance and the
  // board owns the open flag; what the editor does inside its rows is
  // `StageEditor.test.tsx`'s subject, and nothing here re-pins it.
  it("the header carries a Configure affordance beside New task", () => {
    render(<TasksBoard activeSpacePath={SPACE} />);
    expect(screen.getByRole("button", { name: "Configure" })).toBeTruthy();
    // Beside, and AFTER. The header band is one flex row (`<header>` inside the
    // board's `<section>` — note it carries NO `banner` role, because a `<header>`
    // scoped to sectioning content is not a banner, so this walks the element), and
    // the affordances read safe-first: create, then configure.
    const header = screen.getByTestId("tasks-board").querySelector("header")!;
    expect(
      [...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["New task", "Configure"]);
  });

  it("Configure is disabled with no active Space (there is no board to configure)", () => {
    render(<TasksBoard activeSpacePath={null} />);
    const button = screen.getByRole("button", {
      name: "Configure",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The SAME rule `New task` runs, for the same reason: a dead button that opens
    // a dialog which cannot write is worse than one that says nothing is open.
    expect(
      (screen.getByRole("button", { name: "New task" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("clicking Configure opens the Stage editor over the board", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Configure stages" }),
    ).toBeTruthy();
    // One row per column the BOARD is showing — the editor reads the same store
    // slice, so a board and an editor that disagreed about the columns would be two
    // answers to "what columns does this Space have".
    for (const slug of ["backlog", "doing", "done"]) {
      expect(within(dialog).getByTestId(`stage-row-${slug}`)).toBeTruthy();
    }
    // The footer's Space-level Switch, which is the editor's only non-row control.
    expect(
      within(dialog).getByRole("switch", { name: "Strict workflow" }),
    ).toBeTruthy();
  });

  it("closing the editor leaves the board (the flag has one owner)", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    await screen.findByRole("dialog");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The board is still there behind it — the editor is a dialog over the same
    // view, not a route away from it.
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
  });

  it("the editor is mounted only while open (a closed editor is an idle catalog read)", async () => {
    useTasks.setState({ boardsBySpace: { [SPACE]: SEED } });
    render(<TasksBoard activeSpacePath={SPACE} />);
    // The Strict flag read happens on the editor's mount, so its call count IS the
    // mount count: a dialog that stayed mounted while closed would keep re-reading
    // the flag and keep a form alive behind the board, exactly the idle-surface
    // cost the New Task modal's render site records for its own composer.
    expect(getBoardStrict).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    await waitFor(() => expect(getBoardStrict).toHaveBeenCalledTimes(1));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(getBoardStrict).toHaveBeenCalledTimes(1);
  });
});
