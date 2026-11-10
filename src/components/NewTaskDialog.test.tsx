import { beforeEach, describe, expect, it, vi } from "vitest";

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so a bare
// `import "node:fs"` does not typecheck. The idiom `classNameConvention.test.ts`,
// `mutedCaption.test.ts` and `TaskCard.test.tsx` use.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import NewTaskDialog from "./NewTaskDialog";
import { resetTaskLaunchInFlight } from "../store/taskLaunch";
import { useTasks } from "../store/tasks";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import {
  createTask,
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSkills,
  listSpaceListing,
  loadHistory,
  moveTask,
  sendPrompt,
  setSessionConfigOption,
  startTaskSession,
  type SkillInfo,
  type StageRow,
  type StageWithTasks,
  type TaskRow,
} from "../lib/tauri";

/**
 * `NewTaskDialog` — the board's creation point, now TEXT ONLY.
 *
 * THE CONTRACT, and the change: one textarea, three buttons. **Backlog** saves the
 * card and opens nothing; **Discuss** and **Research** save it and then open it as a
 * Session through `store/taskLaunch`. NO LLM RUNS AT CREATION TIME — the previous
 * version was a full chat surface whose FIRST SEND did the creating, which meant a
 * person who just wanted a card on the board had to start a Session to get one.
 *
 * WHAT THIS FILE NO LONGER PINS, and why that is not a coverage loss: the transcript,
 * the composer lock, the Mention picker, the attachment refusals, the footer's model
 * picker and the `<task>` block's placement were all pinned here, and every one of
 * them moved with the behaviour. The block's placement is now `lib/taskPrompt`'s
 * concern (three of its cases name the ordering explicitly) and the launch ordering is
 * `store/taskLaunch.test.ts`'s. Deleting a test whose subject no longer exists is not
 * a loss; leaving a test that asserts a removed surface would be a lie.
 *
 * WHY THE BARREL IS MOCKED WITH THE WRAPPER NAMES: the factory spreads `importActual`,
 * so an un-mocked export resolves to the REAL wrapper, which calls `invoke` and rejects
 * in jsdom. AGENTS.md's boot-mock trap — and the specific shape it warns about: the
 * case would assert a REJECTION as if it were the behaviour under test.
 */
const SPACE = "/w/alpha";

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
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    setSessionConfigOption: vi.fn(),
    listSkills: vi.fn(),
    listAgentDefinitionsForSpace: vi.fn(),
    listMcpServersEffective: vi.fn(),
    listSpaceListing: vi.fn(),
    listCompletionEntries: vi.fn(),
    loadHistory: vi.fn(),
    cancelSession: vi.fn(),
  };
});

const stage = (slug: string, sortOrder: number): StageRow => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder,
  onEnter: "none",
});

const taskRow = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "tsk1",
  spacePath: SPACE,
  number: 1,
  title: "Fix the parser",
  body: null,
  specPath: null,
  stageSlug: "backlog",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const skill = (name: string): SkillInfo => ({
  name,
  description: `the ${name} skill`,
  path: `/home/u/.agents/skills/${name}/SKILL.md`,
  dir: `/home/u/.agents/skills/${name}`,
  scope: "user",
  body: `${name.toUpperCase()} BODY`,
  disableModelInvocation: false,
  shadowed: [],
});

/** The NESTED board shape (`{ stage, tasks }`) in `get_board`'s own order. */
const BOARD: StageWithTasks[] = [
  { stage: stage("backlog", 0), tasks: [] },
  { stage: stage("research", 1), tasks: [] },
  { stage: stage("doing", 3), tasks: [] },
];

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

interface RenderArgs {
  spacePath?: string | null;
  onClose?: () => void;
  onCreated?: (task: TaskRow, sessionId: string | null) => void;
  /** Seeded into the STORE, which is the ONLY place the modal resolves a column. It
   *  used to be a prop as well, and the two could disagree — a modal rendered from a
   *  stale prop could offer a column the write then refused to use. */
  boards?: StageWithTasks[];
}

function renderDialog(args: RenderArgs = {}): {
  onClose: () => void;
  onCreated: (task: TaskRow, sessionId: string | null) => void;
  unmount: () => void;
} {
  useTasks.setState({
    boardsBySpace: { [SPACE]: [...(args.boards ?? BOARD)] },
  });
  const onClose = args.onClose ?? vi.fn();
  const onCreated = args.onCreated ?? vi.fn();
  const view = render(
    <NewTaskDialog
      spacePath={args.spacePath === undefined ? SPACE : args.spacePath}
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return {
    onClose,
    onCreated,
    unmount: view.unmount,
  };
}

const typeDraft = (text: string): void => {
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: text },
  });
};

const button = (name: string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

/** Wait for a button to be ENABLED, then return it.
 *
 *  Not ceremony: the two launch buttons are gated on the skill they need, and the
 *  catalog is an async fetch that starts EMPTY, so clicking the first paint clicks a
 *  disabled button and asserts on nothing. The gate and this wait are the same fact
 *  seen from two sides. */
async function ready(name: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const b = button(name);
    expect(b.disabled).toBe(false);
    return b;
  });
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  resetTaskLaunchInFlight();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  vi.clearAllMocks();
  vi.mocked(listSkills).mockResolvedValue([skill("discuss"), skill("research")]);
  vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([]);
  vi.mocked(listMcpServersEffective).mockResolvedValue([]);
  vi.mocked(listSpaceListing).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(listCompletionEntries).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(loadHistory).mockResolvedValue({ rows: [], hasMore: false, todos: null });
  vi.mocked(createTask).mockResolvedValue(taskRow());
  vi.mocked(startTaskSession).mockResolvedValue({
    sessionId: "sess_new",
    cwd: SPACE,
    capabilities: {},
    archived: false,
  });
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
  vi.mocked(setSessionConfigOption).mockResolvedValue([]);
});

describe("NewTaskDialog — the shape (no LLM at creation time)", () => {
  it("is one textarea and three buttons", () => {
    // The whole point of the change: a card is a sentence, and getting a sentence
    // onto a board must not require a chat. The previous version mounted `MessageList`
    // and `ComposerRow` and made the FIRST SEND do the creating, so "just save this"
    // was impossible without starting a Session.
    renderDialog();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(button("Backlog")).toBeTruthy();
    expect(button("Discuss")).toBeTruthy();
    expect(button("Research")).toBeTruthy();
  });

  it("renders NO chat surface", () => {
    // Pinned as ABSENCE with the selectors the chat surfaces ACTUALLY emit, and those
    // testids are live rather than invented: `transcript-scroll` is `MessageList`'s own
    // root (found by `ChatStreamChildGates.test.tsx` through the same selector) and
    // `session-config-block` is the footer's. An earlier draft of this case queried
    // `message-list`, a testid NO component emits, so it passed vacuously — the shape
    // this repo's census files exist to catch.
    //
    // `SessionConfigBlock` is the other half: a model picker in a modal that starts no
    // Session is a control with nothing to configure.
    renderDialog();
    expect(within(dialog()).queryByTestId("transcript-scroll")).toBeNull();
    expect(within(dialog()).queryByTestId("session-config-block")).toBeNull();
  });

  it("does not import the chat machinery at all (the non-vacuity half)", () => {
    // The rendered-absence case above can only see what a MOUNTED component paints. A
    // `MessageList` that rendered nothing on an empty transcript would slip past it, so
    // this reads the SOURCE for the imports — the idiom `TaskCard.test.tsx` and the
    // census files use for exactly this class of claim, where the compiler is the
    // instrument and `tsc` does not run inside vitest.
    const src = readFileSync("src/components/NewTaskDialog.tsx", "utf8");
    for (const gone of [
      "./chat/MessageList",
      "./chat/ComposerRow",
      "./chat/ComposerModals",
      "./SessionConfigBlock",
      "../hooks/useMentionPicker",
      "../lib/skills",
    ]) {
      expect(src).not.toContain(gone);
    }
    // Vacuity guard: the read got the real file.
    expect(src).toContain("export default function NewTaskDialog");
  });

  it("offers no skill dropdown — the skill is the BUTTON, not a selection", () => {
    // The old modal had a Skill `Select` because its send was generic chat. Here the
    // choice of skill IS the choice of button, so a dropdown beside the buttons would
    // be a second, contradictable answer to "which skill".
    renderDialog();
    expect(within(dialog()).queryByText("Skill")).toBeNull();
    expect(within(dialog()).queryByRole("combobox")).toBeNull();
  });

  it("names itself New task", () => {
    renderDialog();
    expect(within(dialog()).getByRole("heading").textContent).toContain("New task");
  });
});

describe("NewTaskDialog — Backlog", () => {
  it("saves the card and starts NOTHING", async () => {
    // THE HEADLINE CASE. No `startTaskSession`, no `sendPrompt`, no Session row. A
    // regression here would silently cost every quick capture a round trip to the
    // provider — and it would still LOOK like it worked.
    renderDialog();
    typeDraft("Fix the parser\nIt drops trailing quotes.");
    fireEvent.click(button("Backlog"));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(startTaskSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("files it in the backlog column, not the board's first column", async () => {
    // `createTask` with NO stage lands a card in the Space's FIRST column, which
    // happens to be Backlog on a seeded board — so on the default fixture the two
    // answers are indistinguishable. This case re-orders the board so the distinction
    // is observable, which is the only way to tell "asked for backlog" from "asked for
    // nothing and got whatever was first".
    renderDialog({
      boards: [
        { stage: stage("inbox", 0), tasks: [] },
        { stage: stage("backlog", 1), tasks: [] },
      ],
    });
    typeDraft("Fix the parser");
    fireEvent.click(button("Backlog"));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createTask).mock.calls[0]![3]).toBe("backlog");
  });

  it("falls back to the board's first column when there is no backlog column", async () => {
    // A card filed under a slug the Space does not have is INVISIBLE (`create_task`
    // refuses an unknown slug — ADR 0090), so the fallback keeps the card reachable.
    renderDialog({
      boards: [
        { stage: stage("today", 0), tasks: [] },
        { stage: stage("later", 1), tasks: [] },
      ],
    });
    typeDraft("Fix the parser");
    fireEvent.click(button("Backlog"));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createTask).mock.calls[0]![3]).toBe("today");
  });

  it("lands the new card in the board the human is looking at", async () => {
    renderDialog();
    // Not a re-fetch. `get_board` SEEDS stages on read, so a refetch to show a new card
    // is a wider mutation than the one being displayed.
    typeDraft("Fix the parser");
    fireEvent.click(button("Backlog"));
    await waitFor(() =>
      expect(
        useTasks.getState().boardsBySpace[SPACE]?.[0]?.tasks.map((t) => t.task.id),
      ).toEqual(["tsk1"]),
    );
  });

  it("closes and reports the card", async () => {
    const { onClose, onCreated } = renderDialog();
    typeDraft("Fix the parser");
    fireEvent.click(button("Backlog"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tsk1" }),
      null,
    );
  });

  it("disables every button on a blank draft, and the draft survives", () => {
    // A DISABLED BUTTON rather than an error line on click. The alternative — enabled,
    // then "Give the Task a title first" after the click — asks the person to discover
    // the rule by violating it. `store/taskLaunch` still throws on a blank draft as the
    // backstop for any caller that is not this dialog, and that throw is pinned in
    // `taskLaunch.test.ts` rather than here.
    const { onClose } = renderDialog();
    typeDraft("   \n  \n");
    for (const name of ["Backlog", "Discuss", "Research"] as const) {
      expect(button(name).disabled).toBe(true);
    }
    fireEvent.click(button("Backlog"));
    expect(createTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The whitespace survives — a dialog that clears a draft the person is still
    // composing loses their text.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "   \n  \n",
    );
  });

  it("enables the buttons as soon as the draft has a title line", async () => {
    // The gate is `draft.trim() !== ""`, the same predicate the split uses for "is
    // there a title", so a button can never be enabled on a draft whose title would be
    // empty.
    renderDialog();
    expect(button("Backlog").disabled).toBe(true);
    typeDraft("A title");
    await waitFor(() => expect(button("Backlog").disabled).toBe(false));
  });

  it("shows the server's empty-title rejection rather than a generic failure", async () => {
    // ADR 0063 puts the sentence in Rust; the frontend adds only the lead-in naming the
    // action to take. `describeIpcError` alone would print the server's message and
    // lose "Give the Task a title first".
    vi.mocked(createTask).mockRejectedValue(
      Object.assign(new Error("task title is empty after trimming"), {
        kind: "empty_title",
      }),
    );
    // REACHABLE despite the blank-draft gate, and with an input the FRONTEND cannot
    // rule out on its own: a draft of two quote characters is not blank, so the button
    // is enabled and the create goes out — and `clean_title` strips ONE matching
    // SURROUNDING quote pair, leaving nothing. `strip_one_quote_layer` leaves a LONE
    // quote alone (it fails the suffix test), so `"` is a valid title and `""` is not;
    // reproducing that distinction here would be the second title implementation the
    // spec forbids. The input is not invented: `commands/tasks/tests/board.rs` asserts
    // `""""` and `"''"` in its refused list, so this is the server's own pinned case.
    renderDialog();
    typeDraft('""');
    fireEvent.click(await ready("Backlog"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "task title is empty after trimming",
      ),
    );
    expect(screen.getByRole("alert").textContent).toContain("Give the Task a title");
  });
});

describe("NewTaskDialog — Discuss and Research", () => {
  it("Discuss creates the card, then starts a linked session", async () => {
    renderDialog();
    typeDraft("Why does the parser drop quotes?");
    fireEvent.click(await ready("Discuss"));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    // THE ORDER. `task_sessions.task_id` has no foreign key (ADR 0090), so the Rust
    // command gates the link on a `get_task` existence check: start first and the link
    // is refused, leaving a live orphan and a card with no Session.
    expect(
      (vi.mocked(createTask).mock as unknown as { invocationCallOrder: number[] })
        .invocationCallOrder[0],
    ).toBeLessThan(
      (
        vi.mocked(startTaskSession).mock as unknown as {
          invocationCallOrder: number[];
        }
      ).invocationCallOrder[0],
    );
  });

  it("Discuss loads the discuss skill and appends the task block", async () => {
    renderDialog();
    typeDraft("Why does the parser drop quotes?");
    fireEvent.click(await ready("Discuss"));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    // The token, not the body — see `taskLaunch.shouldInlineSkill`. The block-order
    // assertion this replaced was pinning a shape that BROKE the transcript: a
    // `<task>` block trailing the appended `<skill>` block makes
    // `splitMentionBlocks` refuse to parse, so the bubble rendered the entire skill
    // as literal text.
    expect(sent).toContain("$discuss");
    expect(sent).not.toContain("<skill");
    expect(sent).toContain("<task ");
    expect(sent.trimEnd().endsWith("</task>")).toBe(true);
  });

  it("Research files the card in the research column AND loads the research skill", async () => {
    renderDialog();
    // The create writes the destination column DIRECTLY — a create-then-move would be
    // two writes for one fact, and the move's `on_enter` would fire for a card that was
    // never anywhere else.
    typeDraft("How does the parser tokenise quotes?");
    fireEvent.click(await ready("Research"));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createTask).mock.calls[0]![3]).toBe("research");
    expect(moveTask).not.toHaveBeenCalled();
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain("$research");
    expect(sent).not.toContain("$discuss");
  });

  it("splits the draft into title and body the same way for all three buttons", async () => {
    // One rule, three buttons. If each button spelled its own split, a multi-line
    // paste would produce a different card depending on which was clicked — and only
    // the Backlog case would be visible on the board.
    for (const name of ["Backlog", "Discuss", "Research"] as const) {
      vi.clearAllMocks();
      vi.mocked(listSkills).mockResolvedValue([skill("discuss"), skill("research")]);
      vi.mocked(createTask).mockResolvedValue(taskRow());
      const view = renderDialog();
      typeDraft("First line\nsecond line\nthird");
      fireEvent.click(await ready(name));
      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
      const call = vi.mocked(createTask).mock.calls[0]!;
      expect(call[1]).toBe("First line");
      expect(call[2]).toBe("second line\nthird");
      // `unmount()` and not an Escape round-trip: Radix plays an exit animation, so the
      // dialog node outlives `onClose` by a frame and the next iteration's render would
      // see two of them.
      view.unmount();
    }
  });

  it("leaves the board view when it launches a session", async () => {
    const onCreated = vi.fn();
    renderDialog({ onCreated });
    typeDraft("Discuss this please");
    fireEvent.click(await ready("Discuss"));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    // The modal reports the launch through `onCreated` with the Session id, and the
    // BOARD turns that into the view switch — the modal has never owned a view.
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tsk1" }),
      "sess_new",
    );
  });

  it("Backlog reports NO session id, so the board stays put", async () => {
    const onCreated = vi.fn();
    renderDialog({ onCreated });
    typeDraft("Just save this");
    fireEvent.click(button("Backlog"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]![1]).toBeNull();
  });

  it("stays open with its error when the launch fails after the create", async () => {
    // The card EXISTS by then, so the modal must not claim the whole action failed —
    // and it must not close, or the error line goes with it and the person has no idea
    // their card was actually saved.
    vi.mocked(startTaskSession).mockRejectedValue(new Error("no provider configured"));
    renderDialog();
    typeDraft("Discuss this please");
    fireEvent.click(await ready("Discuss"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "no provider configured",
      ),
    );
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("disables each button whose skill the catalog does not have", async () => {
    // The same race the detail modal pins: the catalog is an async fetch that starts
    // EMPTY, so an enabled button clicked before it lands fails with a sentence that is
    // false two frames later.
    vi.mocked(listSkills).mockResolvedValue([skill("research")]);
    renderDialog();
    // A DRAFT IS REQUIRED FIRST, and not as a fixture courtesy: with nothing typed
    // every button is disabled because there is no card to create, which would make
    // this case pass for the wrong reason.
    typeDraft("Something to gate on");
    await waitFor(() => expect(button("Research").disabled).toBe(false));
    expect(button("Discuss").disabled).toBe(true);
  });

  it("disables all three with no Space, rather than creating a card nowhere", async () => {
    // `createTask(null, …)` is not a thing. The board already disables its own New task
    // affordance for this reason; the modal refuses too, so a keyboard path cannot get
    // past the disabled button.
    renderDialog({ spacePath: null });
    typeDraft("Anything");
    for (const name of ["Backlog", "Discuss", "Research"] as const) {
      expect(button(name).disabled).toBe(true);
    }
    fireEvent.click(button("Backlog"));
    await new Promise((r) => setTimeout(r, 0));
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("NewTaskDialog — closing", () => {
  it("closes on Escape without creating anything", async () => {
    const { onClose } = renderDialog();
    typeDraft("Never mind");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createTask).not.toHaveBeenCalled();
  });

  it("disables all three buttons while one is in flight", async () => {
    // Three buttons over ONE create: clicking Backlog then Research mid-flight would
    // file two cards for one sentence.
    const slots: { resolve?: (v: TaskRow) => void } = {};
    vi.mocked(createTask).mockReturnValue(
      new Promise<TaskRow>((resolve) => {
        slots.resolve = resolve;
      }),
    );
    renderDialog();
    typeDraft("Slow card");
    fireEvent.click(button("Backlog"));
    await waitFor(() => expect(button("Backlog").disabled).toBe(true));
    expect(button("Discuss").disabled).toBe(true);
    expect(button("Research").disabled).toBe(true);
    slots.resolve?.(taskRow());
  });
});
