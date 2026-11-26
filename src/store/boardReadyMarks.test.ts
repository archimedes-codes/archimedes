import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTasks } from "./tasks";
import { readyCardKey, readyTicket, useInteractive } from "./interactive";
import { resetStores } from "../test/resetStores";
import { useSessions } from "./sessions";
import {
  getBoard,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
  type TaskSessionRow,
} from "../lib/tauri";

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so a
// bare `import "node:fs"` does not typecheck. The idiom `tasks.test.ts`,
// `tauriBoundary.test.ts` and `classNameConvention.test.ts` use, borrowed here for
// the ONE assertion below that can only be made against a store's SOURCE.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/** Strip JS comments before scanning — the helper those files use. A symbol that
 *  appears only in a doc-comment is PROSE about a write, not a write. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/**
 * THE BOARD FEED — the one writer that puts a `ready` mark INTO
 * `useInteractive.ready`, and the reason the mark is now durable.
 *
 * ## Why this is a new file
 *
 * `src/store/tasks.test.ts` is 1,078 code lines and BASELINED in
 * `scripts/file-size-baseline-test.txt`; the ratchet refuses a baselined file
 * growing by even one code line, so nothing can be added there. `sessions.test.ts`
 * is 5,543 against a 1,000-line test gate for the same reason. ADR 0113's mirror
 * rule is the sanctioned answer — a new file per SUBJECT, named for the subject and
 * not numbered — and the subject here is narrow and nameable: what a board read
 * writes into the ready slot.
 *
 * ## What changed, and what this file therefore pins
 *
 * The mark used to be scraped out of a Session's todo list — a `completed` item
 * whose content was the single word `ready` — and the launch message told the model
 * the word existed. That is retired: the `mark_done` host verb sets
 * `sessions.ready`, `send_prompt_with_images` clears it, and `get_board` publishes
 * the OR over a card's linked Sessions as `TaskCardView.ready`. One column, one
 * read, one writer. What only THIS file can pin is the shape of that write:
 *
 *  1. **It happens on a board read** — through `load` AND `refresh`, the two
 *     volumes of the same read — so a mark arrives for a Session that was never
 *     opened. The todo-scrape design could not do that and its own doc said so.
 *  2. **It is scoped to the Space that was read.** `boardsBySpace` is per-Space and
 *     so is the mark set; a global replace would wipe another Space's bells, and a
 *     Space the user is not looking at gets no read at all.
 *  3. **The slot is keyed by CARD, not by Session**, because `TaskCardView.ready`
 *     is a per-CARD OR that does not say which link carries the claim.
 *     `a card that only links the UNREADY half of a ready card's links stays
 *     unmarked` is the pin that stops anyone "simplifying" the key back to a
 *     session id.
 *  4. **The optimistic clears still reach it** — `beginTurn` (pinned in
 *     `sessionReadyMark.test.ts`) and `dismissSession` (here) both withdraw a mark
 *     given a SESSION id, which is why the feed also keeps a Session → cards index.
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

const SPACE = "/w/alpha";
const OTHER = "/w/beta";

const stage = (spacePath: string, slug: string, sortOrder = 0): StageDto => ({
  spacePath,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder,
  onEnter: "none",
  onEnterSkill: null,
  nextSlugs: null,
  auto: false,
  promptPrefix: null,
});

const row = (spacePath: string, id: string, number: number): TaskRow => ({
  id,
  spacePath,
  number,
  title: `Card ${number}`,
  body: null,
  specPath: null,
  stageSlug: "doing",
  sortOrder: number - 1,
  createdAt: 1,
  updatedAt: 1,
});

const link = (taskId: string, sessionId: string): TaskSessionRow => ({
  taskId,
  sessionId,
  stageSlug: "doing",
});

/** A card whose OWN `ready` field is the fact under test.
 *
 *  `ready` here is the STORAGE-side claim the board read carries — an OR over the
 *  card's linked Sessions' `sessions.ready` column, computed in Rust — and it is
 *  exactly what the feed reads. A fixture that left it `false` everywhere could not
 *  test the feed at all.
 *
 *  `claimants` is `TaskCardView.readySessions`: WHICH of the links carry the claim.
 *  It DEFAULTS to every link when the card is ready and to none when it is not,
 *  because that is the common case (one claiming Session, or none) and because the
 *  default keeps the wire invariant `ready === readySessions.length > 0` true of
 *  every fixture in this file. A test that needs a card linking a claiming AND a
 *  silent Session passes it explicitly — that is the shape the two P1 fixes are
 *  about, and a fixture that could not express it could not test them. */
const card = (
  spacePath: string,
  id: string,
  number: number,
  sessionIds: string[],
  ready: boolean,
  claimants: string[] = ready ? sessionIds : [],
): TaskCardView => ({
  task: row(spacePath, id, number),
  sessions: sessionIds.map((sessionId) => link(id, sessionId)),
  costUsd: null,
  artifactKeys: [],
  ready,
  readySessions: claimants,
});

/** One `doing` column carrying the cards, in the NESTED wire shape. */
const columnsOf = (
  spacePath: string,
  ...cards: TaskCardView[]
): StageWithTasks[] => [{ stage: stage(spacePath, "doing"), tasks: cards }];

/** Point the board read at an answer (or a SEQUENCE — the first call answers the
 *  first read, the rest answer the reads after it).
 *
 *  The LAST board is the DEFAULT and the earlier ones are the Once queue, which is
 *  the order the mock library consumes them in: a queued `Once` value is spent
 *  before the default is consulted, so spelling it the other way round hands the
 *  first read the LAST answer and every case below tests the wrong board. */
const readAnswers = (...boards: StageWithTasks[][]): void => {
  const last = boards[boards.length - 1]!;
  for (const board of boards.slice(0, -1)) {
    vi.mocked(getBoard).mockResolvedValueOnce(board);
  }
  vi.mocked(getBoard).mockResolvedValue(last);
};

/** Is this card marked, as the board would read it? Keyed by Space + TASK id — see
 *  the `ready` slot doc for why the CARD owns the claim and not the Session.
 *
 *  PRESENCE is the claim (the value carries the card's Session ids, which is the
 *  hop `dismissSession` resolves through), so this asks `in` and not `=== true`. */
const marked = (spacePath: string, taskId: string): boolean =>
  readyCardKey(spacePath, taskId) in useInteractive.getState().ready;

/** Every mark currently in the slot, as `readyCardKey`s. */
const marks = (): string[] => Object.keys(useInteractive.getState().ready);

beforeEach(() => {
  // BOTH halves, as in every `useTasks` test: `resetStores()` (which includes
  // `useInteractive`, so the mark map AND the feed's indexes go back to their
  // initial state) and the store's own `reset()`, the only thing that can reach
  // `tasks.ts`'s module `let`s (`loadEpoch`, `positionWritesInFlight`).
  resetStores();
  useTasks.getState().reset();
  vi.mocked(getBoard).mockReset();
  vi.mocked(getBoard).mockResolvedValue([]);
});

describe("the board feed writes the ready slot", () => {
  it("a board read that reports a card ready marks that card", async () => {
    // THE line, end to end through the real action: `get_board` → `load` → the feed
    // → the slot. A `sessions.ready` row is the whole durable store of the claim, so
    // a card whose linked Session was marked by `mark_done` is marked here on the
    // FIRST read — no todo list, no history page, no magic word.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)));

    await useTasks.getState().load(SPACE);

    expect(marked(SPACE, "t1")).toBe(true);
  });

  it("a card the read reports NOT ready sets nothing", async () => {
    // The negative, so the case above cannot pass on a key written for every card
    // the read happened to mention.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], false)));

    await useTasks.getState().load(SPACE);

    expect(marked(SPACE, "t1")).toBe(false);
    expect(marks()).toEqual([]);
  });

  it("a link-free card is never marked, whatever the read claims", async () => {
    // `ready` is an OR over the card's links, so a card with none is `false` from
    // Rust and could only be `true` here through a bug (or a card whose links were
    // all CASCADE-deleted with their Sessions). Pinned because a feed that ignored
    // the link list would mark one.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, [], true)));

    await useTasks.getState().load(SPACE);

    expect(marked(SPACE, "t1")).toBe(false);
  });

  it("a card that only links the UNREADY half of a ready card's links stays unmarked", async () => {
    // WHY THE SLOT IS KEYED BY CARD AND NOT BY SESSION, pinned. The fixture is the
    // shape a re-launch produces: `sess_busy` holds the claim and `sess_calm` does
    // not, so `t1` is ready (an OR) while `t2`, which links only `sess_calm`, is
    // not. `card.ready` never says WHICH link carries the claim, so a feed that
    // wrote `(sessionId, card.ready)` pairs would stamp `sess_calm` with `t1`'s
    // claim, and `t2` would then wear a bell the board never claimed for it — a
    // false bell on the exact surface the owner already rejected a contradictory
    // mark on.
    readAnswers(
      columnsOf(
        SPACE,
        card(SPACE, "t1", 1, ["sess_busy", "sess_calm"], true),
        card(SPACE, "t2", 2, ["sess_calm"], false),
      ),
    );

    await useTasks.getState().load(SPACE);

    expect(marked(SPACE, "t1")).toBe(true);
    expect(marked(SPACE, "t2")).toBe(false);
  });

  it("a `refresh` feeds the marks too, not only a `load`", async () => {
    // The two volumes of ONE read, and the auto-refresh rides the quiet one:
    // `useTaskBoardAutoRefresh` fires `refresh` on `inTurn`'s falling edge, so the
    // mark a `mark_done` writes mid-turn reaches the board through `refresh` and
    // nothing else. A feed hung only off `load` would leave the bell dark until a
    // remount.
    readAnswers(
      columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], false)),
      columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)),
    );

    await useTasks.getState().load(SPACE);
    expect(marked(SPACE, "t1")).toBe(false);

    await useTasks.getState().refresh(SPACE);
    expect(marked(SPACE, "t1")).toBe(true);
  });

  it("a failed read leaves the marks exactly as they were", async () => {
    // `refresh` swallows its failure and keeps the rows on screen, and the marks are
    // part of those rows: a board that went dark because an opportunistic read
    // tripped would be a board that lied about work still waiting for a human.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)));
    await useTasks.getState().load(SPACE);
    expect(marked(SPACE, "t1")).toBe(true);

    vi.mocked(getBoard).mockRejectedValueOnce(new Error("ipc down"));
    await useTasks.getState().refresh(SPACE);

    expect(marked(SPACE, "t1")).toBe(true);
  });
});

describe("the board feed replaces ONE Space's marks only", () => {
  it("a read of another Space leaves the first Space's bell standing", async () => {
    // THE per-Space rule. A global replace (build a whole new map from this Space's
    // cards, assign it) passes every single-Space case in this file and breaks the
    // moment two Spaces exist: `boardsBySpace` holds both, a board read covers one,
    // and the other Space's marks would be deleted until someone visited it again —
    // a bell that goes out on a card nobody touched.
    vi.mocked(getBoard).mockImplementation(async (spacePath: string) =>
      spacePath === SPACE
        ? columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true))
        : columnsOf(OTHER, card(OTHER, "t9", 9, ["sess_9"], false)),
    );

    await useTasks.getState().load(SPACE);
    expect(marked(SPACE, "t1")).toBe(true);

    await useTasks.getState().load(OTHER);

    expect(marked(SPACE, "t1")).toBe(true);
    expect(marked(OTHER, "t9")).toBe(false);
    expect(marks()).toEqual([readyCardKey(SPACE, "t1")]);
  });

  it("a second read of the SAME Space withdraws a claim it no longer carries", async () => {
    // The other half of "replace": within the Space that was read, the read is
    // AUTHORITATIVE. This is the path a cleared column takes — `mark_done` set it,
    // a later turn cleared it in Rust, and the next read says so — and it is what
    // makes the durable column the durable answer rather than a first-write-wins
    // latch.
    readAnswers(
      columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)),
      columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], false)),
    );
    await useTasks.getState().load(SPACE);
    expect(marked(SPACE, "t1")).toBe(true);

    await useTasks.getState().refresh(SPACE);

    expect(marked(SPACE, "t1")).toBe(false);
    expect(marks()).toEqual([]);
  });

  it("a card that leaves the board leaves the slot", async () => {
    // A deleted Task, or one moved out of the loaded Space: its key would otherwise
    // sit in the map for the life of the window. The per-Space replace drops it.
    readAnswers(
      columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)),
      columnsOf(SPACE),
    );
    await useTasks.getState().load(SPACE);
    expect(marked(SPACE, "t1")).toBe(true);

    await useTasks.getState().refresh(SPACE);

    expect(marks()).toEqual([]);
  });

  it("re-reading identical claims leaves the map's IDENTITY standing", async () => {
    // Not a micro-optimisation: zustand compares a selector's result with
    // `Object.is`, and `TasksBoard` subscribes to this map, so a fresh object on
    // every read would re-render the whole board every time the auto-refresh fires.
    // The `applyTodoUpdate` read this replaced carried the same rule.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)));
    await useTasks.getState().load(SPACE);
    const before = useInteractive.getState().ready;

    await useTasks.getState().refresh(SPACE);

    expect(useInteractive.getState().ready).toBe(before);
  });
});

describe("dismissSession withdraws a ready card", () => {
  it("a dismissed Session on a ready card clears the mark", () => {
    // The THIRD writer of the slot, and the reason the feed keeps a Session → cards
    // index: without it a dismissed Session's bell survives until that Space's next
    // board read, and the auto-refresh only schedules one when a turn was running,
    // so it can be minutes.
    useInteractive.getState().applyReadyMarks(SPACE, readyTicket(), [
      { taskId: "t1", ready: true, readySessions: ["sess_1"] },
    ]);
    expect(marked(SPACE, "t1")).toBe(true);

    useInteractive.getState().dismissSession("sess_1");

    expect(marked(SPACE, "t1")).toBe(false);
  });

  it("dismissing one Session leaves another Session's card standing", () => {
    useInteractive.getState().applyReadyMarks(SPACE, readyTicket(), [
      { taskId: "t1", ready: true, readySessions: ["sess_1"] },
      { taskId: "t2", ready: true, readySessions: ["sess_2"] },
    ]);

    useInteractive.getState().dismissSession("sess_1");

    expect(marked(SPACE, "t1")).toBe(false);
    expect(marked(SPACE, "t2")).toBe(true);
  });

  it("dismissing a Session no board ever named changes nothing at all", () => {
    // The identity no-op the slot has always had. `sessionLifecycle`'s
    // `onSessionClosed` dismisses EVERY closed Session, and a child close on a board
    // carrying marks must not hand `TasksBoard` a fresh map to re-render for.
    useInteractive.getState().applyReadyMarks(SPACE, readyTicket(), [
      { taskId: "t1", ready: true, readySessions: ["sess_1"] },
    ]);
    const before = useInteractive.getState().ready;

    useInteractive.getState().dismissSession("sess-unheard-of");

    expect(useInteractive.getState().ready).toBe(before);
  });
});

/**
 * THE TWO P1 REVIEW FIXES on PR #222, pinned so neither can regress.
 *
 * Both are about a card that links MORE THAN ONE Session, which every fixture above
 * avoids by linking exactly one — so nothing above would notice either bug.
 *
 *  1. **A clear withdraws a CLAIMANT, not a card.** With `TaskCardView.ready` a
 *     per-card `bool`, the only question an optimistic clear could ask was "does this
 *     card link B", and clearing on that unlighted a bell that session A was still
 *     carrying in `sessions.ready`. `readySessions` names the owner; the slot stores
 *     claimants, so a partial clear is expressible.
 *  2. **A read older than the last clear paints nothing.** A board read is an
 *     `await`, so a read dispatched before `beginTurn` can resolve after it carrying
 *     the pre-turn `ready: true` and relight a bell the user was just told is gone.
 *     `loadEpoch` cannot catch that — it rejects a read superseded by ANOTHER read,
 *     and a turn is not a read. The ready fence is a counter a read tickets at
 *     DISPATCH time; `readyFence` in `interactive.ts` owns the argument, including
 *     the mid-turn consequence the owner accepted (a bell earned mid-turn waits for
 *     the settle, because `cardMarkOf` ranks `ready` above `running`).
 */
describe("a clear withdraws the claimant and not the card (P1 #1)", () => {
  it("a turn on the NON-claiming Session leaves the claiming Session's bell lit", async () => {
    // THE shape that was broken: a card linking a Session that claimed done and one
    // that never did. `ready` is true from the OR, and Rust says WHO owns it through
    // `readySessions`. Starting a turn on the silent link must leave the bell alone —
    // A's column is still `1`, and the next read will say so, so clearing here would
    // make the bell vanish and then return.
    readAnswers(
      columnsOf(
        SPACE,
        card(SPACE, "t1", 1, ["sess_claiming", "sess_silent"], true, [
          "sess_claiming",
        ]),
      ),
    );
    await useTasks.getState().load(SPACE);
    expect(marked(SPACE, "t1")).toBe(true);

    useSessions.getState().beginTurn("sess_silent");

    expect(
      marked(SPACE, "t1"),
      "the claim belongs to `sess_claiming`, and a turn on a DIFFERENT Session " +
        "cannot withdraw it — this is the exact case the `bool` got wrong",
    ).toBe(true);
    expect(useInteractive.getState().ready[readyCardKey(SPACE, "t1")]).toEqual([
      "sess_claiming",
    ]);
  });

  it("a turn on the CLAIMING Session is what drops the mark", async () => {
    // The other arm, so the test above cannot pass by never clearing anything: the
    // owner's rule ("the next turn on that Session clears it") still holds when the
    // turn is on the Session that owns the claim.
    readAnswers(
      columnsOf(
        SPACE,
        card(SPACE, "t1", 1, ["sess_claiming", "sess_silent"], true, [
          "sess_claiming",
        ]),
      ),
    );
    await useTasks.getState().load(SPACE);

    useSessions.getState().beginTurn("sess_claiming");

    expect(marked(SPACE, "t1")).toBe(false);
  });

  it("one of TWO claimants starting a turn keeps the bell lit", () => {
    // The partial-clear arithmetic itself, isolated. A card both Sessions claimed is
    // ONE bell; a turn on one of them leaves the other's column at `1`, so the bell
    // stays and only the clearable id goes. Deleting the key here is the same bug as
    // above with a different fixture, and it is what a `bool` cannot express.
    useInteractive.getState().applyReadyMarks(SPACE, readyTicket(), [
      { taskId: "t1", ready: true, readySessions: ["sess_a", "sess_b"] },
    ]);

    useSessions.getState().beginTurn("sess_a");

    expect(marked(SPACE, "t1")).toBe(true);
    expect(useInteractive.getState().ready[readyCardKey(SPACE, "t1")]).toEqual(["sess_b"]);
  });

  it("dismissing the NON-claiming Session also leaves the bell lit", () => {
    // The third writer takes the same rule. A dismissed Session's claim is over, but
    // a card that also links a Session still holding the column is still ready.
    useInteractive.getState().applyReadyMarks(SPACE, readyTicket(), [
      { taskId: "t1", ready: true, readySessions: ["sess_claiming", "sess_silent"] },
    ]);

    useInteractive.getState().dismissSession("sess_silent");

    expect(marked(SPACE, "t1")).toBe(true);
    expect(useInteractive.getState().ready[readyCardKey(SPACE, "t1")]).toEqual([
      "sess_claiming",
    ]);

    // And the last claimant going is the key going — `ready` and "the key is
    // present" stay one statement.
    useInteractive.getState().dismissSession("sess_claiming");
    expect(marked(SPACE, "t1")).toBe(false);
  });
});

describe("a read older than the last clear paints nothing (P1 #2)", () => {
  /** Dispatch a `load` and start a turn BEFORE the mocked read resolves.
   *
   *  The ordering is the whole test, and it is real and not simulated: `getBoard` is
   *  a resolved-promise mock, so the `await` inside `readBoard` yields a microtask and
   *  a synchronous `beginTurn` after the dispatch lands inside that window. That is
   *  the window the reviewer's "mount read finishes after `beginTurn`" describes. */
  const loadRacingATurn = async (sessionId: string): Promise<void> => {
    const pending = useTasks.getState().load(SPACE);
    useSessions.getState().beginTurn(sessionId);
    await pending;
  };

  it("a board read dispatched before `beginTurn` does not relight the bell", async () => {
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)));

    await loadRacingATurn("sess_1");

    expect(
      marked(SPACE, "t1"),
      "the read carries the PRE-TURN `ready: true`, and the user has already been " +
        "told the bell is gone — writing it back is the bug this pins",
    ).toBe(false);
  });

  it("a board read dispatched AFTER the clear still marks the card", async () => {
    // NON-VACUITY for the test above, and the `>=`-not-`>` proof: the fence rejects
    // reads that STARTED before a withdrawal, not every read that follows one. A
    // ticket equal to the fence is current. Without this arm the first test could be
    // satisfied by a feed that never writes.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)));
    useSessions.getState().beginTurn("sess_1");

    await useTasks.getState().load(SPACE);

    expect(marked(SPACE, "t1")).toBe(true);
  });

  it("the falling-edge read after the turn lights the bell the mid-turn claim earned", async () => {
    // THE CONSEQUENCE, stated as a test: a `mark_done` that lands mid-turn is not
    // painted until the settle. The durable claim is never lost — only its paint —
    // and this is what `readyFence` trades away, on the owner's instruction that the
    // bell must not outrank a running dot.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)));
    const pending = useTasks.getState().load(SPACE);
    useSessions.getState().beginTurn("sess_1");
    await pending;
    expect(marked(SPACE, "t1")).toBe(false);

    // The settle's read (what `useTaskBoardAutoRefresh` fires on the falling edge)
    // tickets AFTER the clear, so it lands.
    await useTasks.getState().refresh(SPACE);
    expect(marked(SPACE, "t1")).toBe(true);
  });

  it("the fence gates the ready slot ONLY — a dropped feed still paints the columns", async () => {
    // The blast radius, pinned. A stale read is dropped from the ready feed and must
    // still paint the board, or this guard would have traded a bell for the whole
    // view. `loadEpoch` owns the paint and the fence owns nothing else.
    readAnswers(columnsOf(SPACE, card(SPACE, "t1", 1, ["sess_1"], true)));

    await loadRacingATurn("sess_1");

    const columns = useTasks.getState().boardsBySpace[SPACE];
    expect(columns ?? []).toHaveLength(1);
    expect(columns?.[0]?.tasks.map((c) => c.task.id)).toEqual(["t1"]);
  });
});

describe("the board feed goes through the ACTION", () => {
  it("tasks.ts writes the slot through `applyReadyMarks` and never pokes the map", () => {
    // The cross-store discipline `clearReady` exists for, pinned at the source: a
    // store's map has ONE owner and every other store reaches it through a named
    // action. `tasks.ts` had no dependency on `interactive.ts` at all before this;
    // this pin is what keeps the new edge from becoming a `setState` written into
    // from the wrong side.
    const src = stripJsComments(readFileSync("src/store/tasks.ts", "utf8"));
    expect(src).toContain("applyReadyMarks");
    expect(src).not.toContain("useInteractive.setState");
    // And the shape of the call: one Space per read, so the replace can be scoped.
    expect(src).toMatch(/applyReadyMarks\(\s*spacePath/);
  });
});
