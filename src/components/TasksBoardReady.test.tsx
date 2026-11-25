import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

import TasksBoard from "./TasksBoard";
import { useTasks } from "../store/tasks";
import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import {
  getBoard,
  type StageDto,
  type StageWithTasks,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";

/**
 * THE `ready` MARK, WIRED THROUGH THE BOARD — the store-to-card half.
 *
 * ## Why a new file
 *
 * `TasksBoard.test.tsx` is 914 code lines against a 1,000-line test gate that is a
 * RATCHET (`scripts/file-size-baseline-test.txt`, and the ledger may not be
 * regenerated to accommodate a feature). ADR 0113's mirror rule is the sanctioned
 * answer: a new file per SUBJECT. The subject here is nameable and small — the board
 * reading `useInteractive.ready` and handing one boolean per card down — and it is a
 * different subject from the anatomy and the drag gestures that file owns.
 *
 * ## What only THIS file can pin
 *
 * `TaskCardReady.test.tsx` pins what a card DOES with the `ready` prop. The card is
 * presentational and takes a boolean, so it cannot pin that the BOARD computes that
 * boolean correctly — and that is where the failure that actually ships lives: a
 * board that broadcasts one card's mark to every card, or threads it by the wrong id,
 * or reads the map before the frames land. Only a file that mounts `TasksBoard` over
 * the REAL stores can see those, which is the same division of labour
 * `TasksBoard.test.tsx` documents for the session mark.
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
    getBoardStrict: vi.fn().mockResolvedValue(false),
    writeArtifact: vi.fn(),
    getArtifact: vi.fn(),
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    setSessionConfigOption: vi.fn(),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    listMcpServersEffective: vi.fn().mockResolvedValue([]),
    listSpaceListing: vi
      .fn()
      .mockResolvedValue({ entries: [], truncated: false }),
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});

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

/** A card that OWNS `sessionIds` — the link list is what both marks are read
 *  through, so every case here is about which link a mark came from. */
const cardWith = (
  id: string,
  number: number,
  stageSlug: string,
  sessionIds: string[],
): TaskCardView => ({
  task: task(id, number, stageSlug),
  sessions: sessionIds.map((sessionId) => ({
    taskId: id,
    sessionId,
    stageSlug,
  })),
  costUsd: null,
  artifactKeys: [],
});

const boardOf = (...cards: TaskCardView[]): StageWithTasks[] => [
  { stage: stage("doing", { sortOrder: 0 }), tasks: cards },
];

/** Put a board on screen. BOTH halves, and both are load-bearing: the slice (so the
 *  first render has rows) AND the `getBoard` answer (because the board's own mount
 *  effect reads and replaces the slice a microtask later — a test that seeded only
 *  the store would find its cards gone by the first `waitFor`, which is exactly why
 *  `TasksBoard.test.tsx` asserts synchronously after `render`). Seeding both makes
 *  the board STABLE, so a case is about the mark and not about a race. */
const seedBoard = (...cards: TaskCardView[]): StageWithTasks[] => {
  const board = boardOf(...cards);
  useTasks.setState({ boardsBySpace: { [SPACE]: board } });
  vi.mocked(getBoard).mockResolvedValue(board);
  return board;
};

/** The `ready` glyph on a given card, or `null`. Queried by testid and not by role:
 *  the mark is decoration, so a role query reads `null` for a CORRECT card. */
const readyGlyphOf = (card: Element): Element | null =>
  card.querySelector('[data-testid="task-card-ready"]');

/** Every card on the `doing` column, in render order. */
const cards = (): HTMLElement[] =>
  within(screen.getByTestId("task-column-doing")).getAllByTestId("task-card");

/** Drive the mark the way the app does: a `todos_update` frame carrying the marker.
 *  NOT a `setState` of `ready`'s shape — the funnel is the only writer of the slot,
 *  so seeding through it pins the same path the live listener and the restart seed
 *  both take, and a `ready` map that stopped being written by `applyTodoUpdate`
 *  reddens here instead of shipping a mark nothing can set. */
const markSessionReady = (sessionId: string) => {
  useInteractive.getState().applyTodoUpdate(sessionId, {
    source: "native",
    todos: [{ content: "ready", status: "completed" }],
  });
};

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  useSessions.setState({ activeSpacePath: SPACE });
  vi.mocked(getBoard).mockReset();
  vi.mocked(getBoard).mockResolvedValue([]);
  // (A case that wants cards calls `seedBoard`, which re-points this mock at the
  //  SAME rows it puts in the slice — see the helper.)
});

describe("the board wires the ready mark to its cards", () => {
  it("a card whose linked Session's board carries the marker shows the glyph", async () => {
    // THE end-to-end line: `todos_update` → `applyTodoUpdate` → `ready` → the board's
    // per-card read → the glyph. The store is populated WHILE the board is up, which
    // is what the app-scoped listener does, so the mark appearing is the live path
    // and not a mount-time accident.
    seedBoard(cardWith("t1", 1, "doing", ["sess_1"]));
    render(<TasksBoard />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(readyGlyphOf(cards()[0]!)).toBeNull();

    markSessionReady("sess_1");

    await waitFor(() => expect(readyGlyphOf(cards()[0]!)).not.toBeNull());
  });

  it("every card gets its OWN mark, read from its OWN links", async () => {
    // THE threading proof, and the mutation this file exists for. Three cards, three
    // different Session ids, three different correct answers in ONE render: a board
    // that broadcast one card's mark to all three — the tempting shortcut, since the
    // map is one object — reddens here immediately. This is the same pin shape as
    // `TasksBoard.test.tsx`'s `dots` census for the session mark, and the reason the
    // two marks are threaded by the same factory-per-card shape.
    seedBoard(
      cardWith("t1", 1, "doing", ["sess_a"]),
      cardWith("t2", 2, "doing", ["sess_b"]),
      cardWith("t3", 3, "doing", ["sess_c"]),
    );
    markSessionReady("sess_b");

    render(<TasksBoard />);
    await waitFor(() => expect(cards()).toHaveLength(3));

    const marked = cards().map((card) => readyGlyphOf(card) !== null);
    expect(marked).toEqual([false, true, false]);
  });

  it("a card with TWO links shows ONE mark when EITHER is ready", async () => {
    // A card is a Task and can own several Sessions; the mark is one glyph, not one
    // per link — the card is a two-line summary by construction and the detail dialog
    // is the surface that lists Sessions individually.
    seedBoard(cardWith("t1", 1, "doing", ["sess_first", "sess_second"]));
    markSessionReady("sess_second");

    render(<TasksBoard />);
    await waitFor(() => expect(cards()).toHaveLength(1));

    const glyphs = cards()[0]!.querySelectorAll(
      '[data-testid="task-card-ready"]',
    );
    expect(glyphs).toHaveLength(1);
  });

  it("a card with NO links shows no mark, whatever the map holds", async () => {
    // The common case, and the negative that keeps the read from becoming "anything
    // in the map marks every card": an unlinked card has no links to consult, so a
    // mark on it would be a fact about a Session the card does not own.
    seedBoard(cardWith("t1", 1, "doing", []), cardWith("t2", 2, "doing", []));
    markSessionReady("someone-elses-session");

    render(<TasksBoard />);
    await waitFor(() => expect(cards()).toHaveLength(2));

    for (const card of cards()) expect(readyGlyphOf(card)).toBeNull();
  });

  it("the mark and the session mark both appear on one card", async () => {
    // THE PRECEDENCE DECISION, asserted where both inputs are real. A Session that
    // marked itself ready and then parked on a permission is BOTH finished AND blocked
    // on you, and the card says both — because the actionable half ("come and answer
    // me") must not be hidden behind the informational one. `sessionStatusRollupOf`'s
    // 3-way answer is untouched by this: `ready` never entered it.
    seedBoard(cardWith("t1", 1, "doing", ["sess_1"]));
    useSessions.setState({
      sessions: [
        { sessionId: "sess_1", cwd: SPACE, capabilities: {}, archived: false },
      ],
      inTurn: { sess_1: true },
    });
    markSessionReady("sess_1");

    render(<TasksBoard />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    // Turn running: the spinner, and the ready glyph, together.
    expect(
      cards()[0]!.querySelector('[data-testid="task-card-status"]'),
    ).not.toBeNull();
    expect(readyGlyphOf(cards()[0]!)).not.toBeNull();
  });

  it("the mark disappears when a later frame withdraws the marker", async () => {
    // LIVE in both directions, which is the property a persisted-column design would
    // not have had for free: the model rewrote its list and dropped the item, the
    // slot follows, and the glyph goes.
    seedBoard(cardWith("t1", 1, "doing", ["sess_1"]));
    markSessionReady("sess_1");
    render(<TasksBoard />);
    await waitFor(() => expect(readyGlyphOf(cards()[0]!)).not.toBeNull());

    useInteractive.getState().applyTodoUpdate("sess_1", {
      source: "native",
      todos: [{ content: "keep going", status: "in_progress" }],
    });

    await waitFor(() => expect(readyGlyphOf(cards()[0]!)).toBeNull());
  });

  it("the next turn on that Session clears the mark on the card", async () => {
    // THE OWNER'S RULE, at the surface: "the next turn on that session clears it".
    // `beginTurn` is what a send calls, so this is the sequence a user produces by
    // typing a follow-up prompt while the board is open.
    seedBoard(cardWith("t1", 1, "doing", ["sess_1"]));
    markSessionReady("sess_1");
    render(<TasksBoard />);
    await waitFor(() => expect(readyGlyphOf(cards()[0]!)).not.toBeNull());

    useSessions.getState().beginTurn("sess_1");

    await waitFor(() => expect(readyGlyphOf(cards()[0]!)).toBeNull());
  });

  it("the ready mark adds no control and no pill to a board of cards", async () => {
    // The two censuses, counted where cards are mounted in bulk. `RowButton`'s
    // one-`role="button"`-per-row rule (`SpacesList.test.tsx` resolves rows through
    // `.closest('[role="button"]')` at eight sites and never mounts a card), and the
    // pill count `slabFloatSeparation.test.ts` gates on the source.
    seedBoard(
      cardWith("t1", 1, "doing", ["sess_1"]),
      cardWith("t2", 2, "doing", ["sess_2"]),
    );
    markSessionReady("sess_1");
    markSessionReady("sess_2");

    render(<TasksBoard />);
    await waitFor(() => expect(cards()).toHaveLength(2));

    // TWO cards, TWO `ready` glyphs, and ZERO new `[role="button"]` matches: the
    // document holds exactly the two the cards themselves carry.
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(2);
    expect(
      document.querySelectorAll('[data-testid="task-card-ready"]'),
    ).toHaveLength(2);
    for (const card of cards()) {
      expect(readyGlyphOf(card)!.tagName).not.toBe("BUTTON");
      // TWO pills per card and the mark is not a third: the `T{n}` badge and the
      // sessions chip (this card has one link, so the chip renders). `slabFloatSeparation.test.ts`
      // gates the SOURCE count of `bg-background`-filled `rounded-full` literals at
      // FIVE for this file; the mark adds neither a literal nor a rendered pill.
      expect(card.querySelectorAll('[class*="rounded-full"]')).toHaveLength(2);
      expect(
        Array.from(card.querySelectorAll('[class*="rounded-full"]')).some(
          (pill) => pill.contains(readyGlyphOf(card)!),
        ),
      ).toBe(false);
    }
  });
});
