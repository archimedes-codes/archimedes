import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import NewTaskDialog from "./NewTaskDialog";
import { useSessions } from "../store/sessions";
import { useTasks } from "../store/tasks";
import { useModelCatalog } from "../store/modelCatalog";
import { useSettings } from "../store/settings";
import { resetStores } from "../test/resetStores";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import {
  cancelSession,
  createTask,
  editTask,
  getBoard,
  getTask,
  linkSession,
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSkills,
  listSpaceListing,
  loadHistory,
  moveTask,
  readClipboardImage,
  readFileBytes,
  reorderTasks,
  sendPrompt,
  setSessionConfigOption,
  startTaskSession,
  type ModelDto,
  type SkillInfo,
  type StageRow,
  type StageWithTasks,
  type TaskRow,
} from "../lib/tauri";

/**
 * `NewTaskDialog` — the board's creation point, which is also a real chat.
 *
 * THE CONTRACT UNDER TEST, in the order the spec states it: the first message
 * creates the **Task** (stage = the board's FIRST stage, title = the first line)
 * and a linked **Session**, that Session becomes the modal's chat, the task
 * context rides the first USER message as a `<task>` block appended after the
 * user's own words, and closing the modal leaves BOTH artifacts behind.
 *
 * WHY `../lib/tauri` IS MOCKED WITH THE WRAPPER NAMES and why every entry here
 * is load-bearing: the factory spreads `importActual`, so an un-mocked export
 * resolves to the REAL wrapper, which calls `invoke`, which rejects in jsdom
 * (`window.__TAURI_INTERNALS__` is undefined). `AGENTS.md`'s boot-mock trap in
 * its exact shape — a test would then be pinning a rejection, and a rejection
 * that looks like the behaviour under test. `startTaskSession` and `sendPrompt`
 * are the two this task adds to that family.
 *
 * TWO RESETS, both required: `resetStores()` (which now covers `useTasks`) plus
 * the store's own `reset()` — `src/test/resetStores.ts` documents that it cannot
 * reach a module-scope `let`, and `store/tasks.ts` guards its `load` epoch with
 * exactly one. The catalog caches are module state too, so both cache clears run
 * as well: `useSkillCatalog`'s promise cache is keyed per Space and would
 * otherwise serve one case's skill rows to the next.
 */
const SPACE = "/w/alpha";

/**
 * The barrel mock. NOTHING here may reference a module-scope const: `vi.mock`
 * factories are hoisted above the test module's own `const` declarations, so a
 * factory that reads `SPACE` or `DISCUSS` throws in the temporal dead zone (the
 * same hoisting rule `src/test/chatStreamFixtures.ts` records). The resolved
 * values are installed in `beforeEach` instead.
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
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    setSessionConfigOption: vi.fn(),
    // The composer's four catalogs (`useMentionCatalogs` / `useSkillCatalog`).
    listSkills: vi.fn(),
    listAgentDefinitionsForSpace: vi.fn(),
    listMcpServersEffective: vi.fn(),
    listSpaceListing: vi.fn(),
    listCompletionEntries: vi.fn(),
    // The attachment paths (the composer's `+` / paste / drop routes).
    readClipboardImage: vi.fn(),
    readFileBytes: vi.fn(),
    loadHistory: vi.fn(),
    cancelSession: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

const stage = (slug: string, sortOrder: number, over: Partial<StageRow> = {}): StageRow => ({
  spacePath: SPACE,
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
  sortOrder,
  onEnter: "none",
  ...over,
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

/** The NESTED board shape (`{ stage, tasks }`) in `get_board`'s own order. */
const BOARD: StageWithTasks[] = [
  { stage: stage("backlog", 0), tasks: [] },
  { stage: stage("research", 1), tasks: [] },
  { stage: stage("doing", 3, { onEnter: "compact" }), tasks: [] },
];

const skill = (
  name: string,
  body: string,
  dir = `/home/u/.agents/skills/${name}`,
): SkillInfo => ({
  name,
  description: `the ${name} skill`,
  path: `${dir}/SKILL.md`,
  dir,
  scope: "user",
  body,
  disableModelInvocation: false,
  // Required on the wire (Rust always serializes the Vec); UI-only, and this
  // dialog never reads it — `expandMentions` does not either (ADR 0036).
  shadowed: [],
});

const DISCUSS = skill("discuss", "DISCUSS BODY");
const RESEARCH = skill("research", "RESEARCH BODY");

/** The previously-active workspace Session — the thing the modal must never
 *  read or write. It disagrees with everything the modal's Session would show. */
const WORKSPACE_SESSION = "ws-old";

function seedWorkspace(options: { withTaskBoard?: boolean } = {}): void {
  useSessions.setState({
    activeSessionId: WORKSPACE_SESSION,
    activeSpacePath: SPACE,
    sessions: [
      {
        sessionId: WORKSPACE_SESSION,
        cwd: SPACE,
        capabilities: {},
        archived: false,
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/old",
            options: [{ value: "acme/old", name: "old" }],
          },
        ],
      },
    ],
    messages: { [WORKSPACE_SESSION]: [] },
    configOptions: {
      [WORKSPACE_SESSION]: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "acme/old",
          options: [{ value: "acme/old", name: "old" }],
        },
      ],
    },
    contextUsage: { [WORKSPACE_SESSION]: { used: 115_200, window: 128_000 } },
  });
  if (options.withTaskBoard !== false) {
    useTasks.setState({ boardsBySpace: { [SPACE]: BOARD } });
  }
}

function catalogModel(id: string, provider = "acme"): ModelDto {
  return {
    id,
    provider,
    contextWindow: 128_000,
    supportsThinking: false,
    thinkingLevels: [],
    supportsTools: true,
    selectable: true,
  };
}

function open(): void {
  render(
    <NewTaskDialog spacePath={SPACE} boards={BOARD} onClose={vi.fn()} />,
  );
}

const composer = (): HTMLTextAreaElement =>
  document.querySelector('[data-testid="composer-island"] textarea') as HTMLTextAreaElement;

/** The dialog's own node — the workspace behind it is `aria-hidden` while a
 *  Radix Dialog is open, so document-wide queries must be scoped here. */
function dialog(): HTMLElement {
  const node = document.querySelector('[data-slot="dialog-content"]');
  if (!node) throw new Error("the dialog is not open");
  return node as HTMLElement;
}

function typeDraft(text: string): void {
  fireEvent.change(composer(), { target: { value: text } });
}

function pressSend(): void {
  fireEvent.click(within(dialog()).getByRole("button", { name: "Send" }));
}

/** Choose a skill in the modal's picker (a Radix Select). */
async function chooseSkill(label: string): Promise<void> {
  const trigger = within(dialog()).getByRole("combobox", { name: "Skill" });
  fireEvent.click(trigger);
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => (el.textContent ?? "").trim() === label,
    );
    if (!found) throw new Error(`no skill option named ${label}`);
    return found as HTMLElement;
  });
  fireEvent.click(option);
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  useModelCatalog.setState({
    models: [catalogModel("old"), catalogModel("beta")],
    loadStarted: true,
    loadedOk: true,
  });
  useSettings.setState({
    settings: { providers: [{ id: "acme", name: "acme" }] },
  } as never);
  vi.mocked(getBoard).mockReset();
  vi.mocked(getBoard).mockResolvedValue(BOARD);
  vi.mocked(createTask).mockReset();
  vi.mocked(createTask).mockResolvedValue(taskRow());
  vi.mocked(getTask).mockResolvedValue(null);
  vi.mocked(linkSession).mockResolvedValue(undefined);
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
  vi.mocked(reorderTasks).mockResolvedValue(undefined);
  vi.mocked(editTask).mockResolvedValue(taskRow());
  vi.mocked(cancelSession).mockResolvedValue(undefined);
  vi.mocked(loadHistory).mockResolvedValue({
    rows: [],
    hasMore: false,
    todos: null,
  });
  vi.mocked(readClipboardImage).mockResolvedValue(null);
  vi.mocked(readFileBytes).mockResolvedValue(null);
  vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([]);
  vi.mocked(listMcpServersEffective).mockResolvedValue([]);
  const emptyListing = { entries: [], truncated: false };
  vi.mocked(listSpaceListing).mockResolvedValue(emptyListing);
  vi.mocked(listCompletionEntries).mockResolvedValue(emptyListing);
  vi.mocked(startTaskSession).mockReset();
  vi.mocked(startTaskSession).mockResolvedValue({
    sessionId: "snap1",
    cwd: SPACE,
    capabilities: {},
    archived: false,
  });
  vi.mocked(sendPrompt).mockReset();
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(setSessionConfigOption).mockReset();
  vi.mocked(setSessionConfigOption).mockResolvedValue([]);
  vi.mocked(listSkills).mockReset();
  vi.mocked(listSkills).mockResolvedValue([DISCUSS, RESEARCH]);
  seedWorkspace();
});

describe("NewTaskDialog — the first send creates the Task and its Session", () => {
  it("creates the Task in the board's FIRST stage, titled from the first line", async () => {
    open();
    typeDraft("Fix the parser\nand add a regression test");
    pressSend();

    await waitFor(() => expect(createTask).toHaveBeenCalled());
    // `body` is `undefined` (the Task body is the first line only, per spec §3)
    // and the stage is the FIRST column — `boards[0].stage.slug`, read NESTED.
    expect(createTask).toHaveBeenCalledWith(
      SPACE,
      "Fix the parser",
      undefined,
      "backlog",
    );
  });

  it("starts the linked Session AFTER the Task row exists, with the Task id", async () => {
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(startTaskSession).toHaveBeenCalled());

    // THE ORDER IS THE FEATURE. `task_sessions.task_id` has no FK (ADR 0090), so
    // the Rust command gates the link on a `get_task` existence check: a Session
    // started BEFORE the row lands would leave the card with no Session at all.
    expect(startTaskSession).toHaveBeenCalledWith(SPACE, "tsk1", "backlog");
    expect(vi.mocked(createTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(startTaskSession).mock.invocationCallOrder[0],
    );
  });

  it("never seeds the system prompt — the start carries no task context at all", async () => {
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(startTaskSession).toHaveBeenCalled());

    // SPEC FIX 2: `(Fresh, Some(seed))` REPLACES the main prompt (it never calls
    // `build_main_prompt`), so a seeded Task Session would open blind to its own
    // `<tools>`, its skills, its `cwd` and `AGENTS.md`. Task context therefore
    // arrives as the first USER message. Pinned as args because a seed that
    // leaked in would arrive HERE: three arguments, none of them prose.
    const call = vi.mocked(startTaskSession).mock.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call.every((arg) => typeof arg !== "string" || !arg.includes("<task")))
      .toBe(true);
    expect(JSON.stringify(call)).not.toContain("system_prompt");
  });

  it("the started Session becomes the modal's chat (and the store's row)", async () => {
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    // `addSession` is the store's own "a Session was started" action — it
    // upserts the row AND selects it (`store/sessions.ts`), which is what puts
    // the row in the sidebar AND makes the modal's transcript the visible one.
    const state = useSessions.getState();
    expect(state.sessions.map((s) => s.sessionId)).toContain("snap1");
    expect(state.activeSessionId).toBe("snap1");
  });

  it("records and sends ONE byte-identical text, with the `<task>` block after the user's words", async () => {
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
    const stored = useSessions
      .getState()
      .messages["snap1"]!.filter((m) => m.kind === "user")
      .map((m) => (m.kind === "user" ? m.text : ""));

    // ADR 0031's dedupe key is CONTENT-based: the bubble, the persisted row and
    // the wire text must be the SAME string or a resume re-imports the turn.
    expect(stored).toEqual([sent]);
    expect(sent.indexOf("Fix the parser")).toBeLessThan(
      sent.indexOf("<task "),
    );
    expect(sent).toContain('<task id="tsk1"');
    expect(sent).toContain('stage="backlog"');
    expect(sent).toContain('title="Fix the parser"');
    // ONE block, LAST in the message, closed like `<skill>` is.
    expect(sent.match(/<task /g)).toHaveLength(1);
    expect(sent.trimEnd().endsWith("</task>")).toBe(true);
    // The turn opened and settled (`turnCompleted` is the only thing that clears
    // `inTurn`, and the modal owns that settle).
    expect(useSessions.getState().inTurn["snap1"]).toBe(false);
    expect(useSessions.getState().stopReasons["snap1"]).toBe("end_turn");
  });

  it("expands the chosen skill the way a `$name` Mention does, before the message is recorded", async () => {
    open();
    await chooseSkill("discuss");
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
    // The REAL `expandMentions` output (not a hand-rolled body): the `<skill>`
    // block with the catalog's `location` and `References…` note.
    expect(sent).toContain(`<skill name="discuss" location="${DISCUSS.path}">`);
    expect(sent).toContain("References are relative to");
    expect(sent).toContain("DISCUSS BODY");
    // ADR 0013: expansion happens BEFORE the message is recorded, so the stored
    // row is what the agent saw.
    const stored0 = useSessions.getState().messages["snap1"]![0]!;
    expect(stored0.kind).toBe("user");
    expect(stored0.kind === "user" ? stored0.text : null).toBe(sent);
    // …and the task block still lands LAST.
    expect(sent.indexOf("<skill")).toBeLessThan(sent.indexOf("<task "));
  });

  it("with no skill chosen, sends no `<skill>` block", async () => {
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
    expect(sent).not.toContain("<skill");
    expect(sent).toContain("<task ");
  });

  it("escapes the title attribute instead of shipping an injection point", async () => {
    // `clean_title` strips only a MATCHING SURROUNDING quote pair, so inner
    // quotes survive into `TaskRow.title` — which this dialog interpolates into
    // an XML-ish attribute of a prompt-injected block. `expandMentions` avoids
    // this by only interpolating grammar-validated names; a title is free text,
    // so it must be escaped at the injection point.
    vi.mocked(createTask).mockResolvedValue(
      taskRow({ title: 'x" onload="boom' }),
    );
    open();
    typeDraft('x" onload="boom');
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
    const tag = sent.slice(sent.indexOf("<task "), sent.indexOf(">", sent.indexOf("<task ")) + 1);
    expect(tag).not.toContain('onload="boom"');
    expect(tag).toContain("&quot;");
    // The BODY is element content, not an attribute: an unescaped `</task>` in a
    // first line would close the block early and let the rest of the line out of
    // the block (the plan's "no nested block" rule, made enforced rather than
    // aspirational).
    expect(sent.match(/<\/task>/g)).toHaveLength(1);
  });

  it("a title the server rejects leaves no Session, no send, and the dialog open", async () => {
    // `clean_title` returning `None` is a REJECTION (`kind: "empty_title"`), not
    // a fallback: `""` is non-empty after `trim()`, strips its quote pair, and
    // cleans to nothing. The frontend must NOT re-implement that predicate — it
    // must map the server's answer.
    vi.mocked(createTask).mockRejectedValue({
      kind: "empty_title",
      message: "task title is empty after trimming",
    });
    open();
    typeDraft('""');
    pressSend();

    const alert = await screen.findByRole("alert");
    // The modal's OWN lead-in, not merely the server's sentence. This is the
    // mutation-checked half: `describeIpcError` alone yields "task title is empty
    // after trimming", which ALSO contains the word "title" — an assertion on the
    // word would pass with the `empty_title` branch deleted. Measured that way:
    // removing the branch reddened NOTHING until this line named the lead-in.
    expect(alert.textContent).toContain("Give the Task a title first");
    // …and the server's message travels unchanged (ADR 0063: the prose is Rust's).
    expect(alert.textContent).toContain("task title is empty after trimming");
    expect(startTaskSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    // The draft survives — the user's words are not eaten by a rejection.
    expect(composer().value).toBe('""');
  });

  it("an empty draft sends nothing at all", () => {
    open();
    pressSend();
    expect(createTask).not.toHaveBeenCalled();
    expect(startTaskSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("one Enter creates one Task (the double-send guard holds)", async () => {
    open();
    typeDraft("Fix the parser");
    pressSend();
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(startTaskSession).toHaveBeenCalledTimes(1);
  });

  it("a failed send settles the turn and shows why, and keeps the Task", async () => {
    vi.mocked(sendPrompt).mockRejectedValue({
      kind: "command",
      message: "agent is not running",
    });
    open();
    typeDraft("Fix the parser");
    pressSend();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("agent is not running");
    // `inTurn` clears ONLY through `turnCompleted` — without the settle the
    // composer stays pinned and the WorkingIndicator spins forever.
    await waitFor(() =>
      expect(useSessions.getState().inTurn["snap1"]).toBe(false),
    );
    // The Task row is NOT rolled back: the card is the board's truth and the
    // Session is live; only the prompt failed.
    expect(useTasks.getState().boardsBySpace[SPACE]?.[0]?.tasks.map((t) => t.id))
      .toContain("tsk1");
  });
});

describe("NewTaskDialog — the footer configures the modal's Session, never the workspace's", () => {
  it("before the first send there is NO config control to misdirect", async () => {
    // The hazard's pre-send half. `addSession` has not run yet, so the global
    // `activeSessionId` is still the workspace's Session — and `??`-falling back
    // to it would show (and let the user WRITE) that Session's model while they
    // believe they are choosing one for the new Task.
    open();
    // The footer's honest pre-send state is the DISABLED no-data stub (there is
    // no Session to configure yet) — never a live picker showing the workspace
    // Session's model.
    const trigger = within(dialog()).getByRole("button", { name: "Model" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.textContent ?? "").not.toContain("old");
    // …and the workspace Session's config is untouched.
    expect(
      useSessions.getState().configOptions[WORKSPACE_SESSION]?.[0],
    ).toMatchObject({ currentValue: "acme/old" });
  });

  it("after the first send the picker reads and writes the NEW Session", async () => {
    vi.mocked(startTaskSession).mockResolvedValue({
      sessionId: "snap1",
      cwd: SPACE,
      capabilities: {},
      archived: false,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "acme/beta",
          options: [{ value: "acme/beta", name: "beta" }],
        },
      ],
    });
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    const trigger = within(dialog()).getByRole("button", { name: "Model" });
    // The NEW session's model (`beta`), not the workspace's (`old`).
    await waitFor(() => expect(trigger.textContent).toContain("beta"));
    expect(trigger.textContent).not.toContain("old");

    fireEvent.click(trigger);
    const pickerDialog = await waitFor(() => {
      const nodes = document.querySelectorAll('[data-slot="dialog-content"]');
      const node = nodes[nodes.length - 1];
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    const row = Array.from(pickerDialog.querySelectorAll("[role=button]")).find(
      (el) => (el.textContent ?? "").startsWith("old"),
    )!;
    fireEvent.click(row);

    await waitFor(() =>
      expect(setSessionConfigOption).toHaveBeenCalledWith(
        "snap1",
        "model",
        "acme/old",
      ),
    );
    // The negative half: the previously-active workspace Session was NOT written.
    expect(setSessionConfigOption).not.toHaveBeenCalledWith(
      WORKSPACE_SESSION,
      expect.anything(),
      expect.anything(),
    );
  });

  it("leaves the workspace Session's transcript and config alone throughout", async () => {
    useSessions.setState({
      messages: {
        [WORKSPACE_SESSION]: [
          { kind: "user", text: "workspace turn", at: 1 },
        ],
      },
    });
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    expect(
      useSessions
        .getState()
        .messages[WORKSPACE_SESSION]!.map((m) => (m.kind === "user" ? m.text : "")),
    ).toEqual(["workspace turn"]);
    expect(vi.mocked(sendPrompt).mock.calls[0]![0]).toBe("snap1");
  });
});

describe("NewTaskDialog — a follow-up send is an ordinary prompt", () => {
  it("sends plain text to the SAME Session with no second Task", async () => {
    open();
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));

    typeDraft("And add a test");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    const second = vi.mocked(sendPrompt).mock.calls[1]!;
    expect(second[0]).toBe("snap1");
    expect(second[1]).toBe("And add a test");
    // Both turns are in the modal's transcript — the store owns the merge, the
    // dialog keeps no parallel message list.
    expect(
      useSessions.getState().messages["snap1"]!.filter((m) => m.kind === "user"),
    ).toHaveLength(2);
  });
});

describe("NewTaskDialog — closing leaves both artifacts", () => {
  it("the card is on the board and the Session is a row, after onClose", async () => {
    const onClose = vi.fn();
    render(<NewTaskDialog spacePath={SPACE} boards={BOARD} onClose={onClose} />);
    typeDraft("Fix the parser");
    pressSend();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();

    // "Nothing is lost to a dismissed dialog" is the STORE's truth, not the
    // DOM's: the card is in the board's first column and the Session is listed.
    expect(
      useTasks.getState().boardsBySpace[SPACE]?.[0]?.tasks.map((t) => t.id),
    ).toContain("tsk1");
    expect(useSessions.getState().sessions.map((s) => s.sessionId)).toContain(
      "snap1",
    );
  });

  it("closes on Escape through onOpenChange", () => {
    const onClose = vi.fn();
    render(<NewTaskDialog spacePath={SPACE} boards={BOARD} onClose={onClose} />);
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the composer inside the composer island (the reused surface)", () => {
    open();
    expect(document.querySelector('[data-testid="composer-island"]')).toBeTruthy();
    expect(composer()).toBeTruthy();
    expect(
      within(dialog()).getByRole("heading", { name: "New task" }),
    ).toBeTruthy();
  });
});

describe("NewTaskDialog — the skill picker", () => {
  it("offers the roadmap skills that exist in the catalog, plus No skill", async () => {
    open();
    const trigger = within(dialog()).getByRole("combobox", { name: "Skill" });
    fireEvent.click(trigger);
    await waitFor(() => expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0));
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
      (el) => (el.textContent ?? "").trim(),
    );
    expect(labels).toEqual(["discuss", "research", "No skill"]);
  });

  it("offers only No skill when the catalog has none of them", async () => {
    vi.mocked(listSkills).mockResolvedValue([skill("other", "O")]);
    open();
    const trigger = within(dialog()).getByRole("combobox", { name: "Skill" });
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(document.querySelectorAll('[role="option"]').length).toBe(1),
    );
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
      (el) => (el.textContent ?? "").trim(),
    );
    expect(labels).toEqual(["No skill"]);
  });
});
