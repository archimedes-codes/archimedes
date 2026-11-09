import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import TasksBoard from "./TasksBoard";
import { useTasks } from "../store/tasks";
import { resetStores } from "../test/resetStores";
import {
  createTask,
  getBoard,
  moveTask,
  reorderTasks,
  type StageRow,
  type StageWithTasks,
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

const stage = (slug: string, over: Partial<StageRow> = {}): StageRow => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder: 0,
  onEnter: "none",
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

/** The NESTED wire shape. A board built flat (`{ slug, label, tasks }`) is the
 *  failure mode this file exists to catch: it renders BLANK columns without a type
 *  error, so the column-header assertions below are the pin, not decoration. */
const SEED: StageWithTasks[] = [
  { stage: stage("backlog", { sortOrder: 0 }), tasks: [task("t1", 1, "backlog")] },
  {
    stage: stage("doing", { sortOrder: 3, onEnter: "compact" }),
    tasks: [task("t2", 2, "doing"), task("t3", 3, "doing")],
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
    // The composer comes with it — the modal IS a chat, not a form.
    expect(document.querySelector('[data-testid="composer-island"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "New task" })).toBeNull(),
    );
    // The board is still standing underneath (the modal is an overlay, not a
    // route): closing it must not cost the user the board they came from.
    expect(screen.getByTestId("tasks-board")).toBeTruthy();
    expect(screen.getAllByTestId(/^task-column-/)).toHaveLength(3);
  });

  it("the modal files Tasks in the board's FIRST stage", async () => {
    // The wiring assertion that makes the render site more than a boolean: the
    // modal gets the board's own columns, so its first stage IS `backlog`.
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
    render(<TasksBoard activeSpacePath={SPACE} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const island = await waitFor(() => {
      const el = document.querySelector(
        '[data-testid="composer-island"] textarea',
      );
      expect(el).toBeTruthy();
      return el as HTMLTextAreaElement;
    });
    fireEvent.change(island, { target: { value: "Draft card" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(SPACE, "Draft card", undefined, "backlog"),
    );
    // And the card lands in the column the board is showing — the store write the
    // modal performs through `useTasks.createTask` is visible without a refetch.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("task-column-backlog")).getByText("T9"),
      ).toBeTruthy(),
    );
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
    // axis is width and a long row of `w-60` columns would otherwise push the
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
    // zai-light `bg-panel` and `bg-card` are both `#ffffff`, so there the border is
    // the only thing separating a column from the island under it.
    seeded();
    const tokens = classTokens(screen.getByTestId("task-column-backlog"));
    expect(tokens).toContain("bg-panel");
    expect(tokens).not.toContain("bg-surface");
    expect(tokens).toContain("border-border");
  });

  it("the board's columns are not double-padded", () => {
    // The island's own `m-1` now provides the gutter the scroller used to carry,
    // so keeping `px-3 pb-3` would stack 12px of padding outside a 4px margin and
    // give the board a visibly fat bottom edge. The scroller has NO `data-testid`
    // and gets none: the class is the thing under test, so it is also the handle,
    // and `overflow-x-auto` appears exactly once inside the board (no column or
    // card carries it), which makes this selector single-match by construction.
    seeded();
    const scroller = document.querySelector(
      '[data-testid="tasks-board"] .overflow-x-auto',
    ) as HTMLElement | null;
    expect(scroller).toBeTruthy();
    const tokens = classTokens(scroller as HTMLElement);
    expect(tokens).not.toContain("px-3");
    expect(tokens).not.toContain("pb-3");
    // And the three that must SURVIVE the trim: without `overflow-x-auto` the
    // `w-60` columns have no escape and the island clips them; without `min-h-0`
    // the scroller cannot shrink inside the `flex-col` root.
    expect(tokens).toContain("overflow-x-auto");
    expect(tokens).toContain("min-h-0");
    expect(tokens).toContain("gap-2");
  });
});
