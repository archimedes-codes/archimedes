import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import TaskDetailDialog from "./TaskDetailDialog";
import { resetTaskLaunchInFlight } from "../store/taskLaunch";
import { useSessions } from "../store/sessions";
import { useTasks } from "../store/tasks";
import { resetStores } from "../test/resetStores";
import { makeMessage, makeSessionRow } from "../test/fixtures";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import {
  externalOpen,
  getArtifact,
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSkills,
  listSpaceListing,
  loadHistory,
  moveTask,
  sendPrompt,
  startTaskSession,
  type SessionInfo,
  type SkillInfo,
  type StageDto,
  type StageWithTasks,
  type TaskRow,
  type TaskSessionRow,
} from "../lib/tauri";

/**
 * `TaskDetailDialog` — the modal a card opens when it is clicked.
 *
 * THE CONTRACT: it shows the WHOLE card (the board's card is a two-line summary and
 * this is the thing it summarises), it lists the card's Sessions and lets each be
 * opened, and its two buttons launch a Session for the card — Discuss loads the
 * `discuss` skill, Research loads `research` AND moves the card to the Research
 * column. The button work itself is `store/taskLaunch`'s and is pinned there; what
 * THIS file owns is which mode each button means, what gets rendered, and that the
 * board is left when a Session opens.
 *
 * WHY THE BARREL IS MOCKED WITH THE WRAPPER NAMES: the factory spreads
 * `importActual`, so an un-mocked export resolves to the REAL wrapper, which calls
 * `invoke` and rejects in jsdom. AGENTS.md's boot-mock trap — and here it is the
 * catalog fetches that bite first, because the modal reads the skill catalog to
 * decide whether its buttons can work at all.
 */
const SPACE = "/w/alpha";

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getBoard: vi.fn(),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    linkSession: vi.fn(),
    getTask: vi.fn(),
    editTask: vi.fn(),
    // The artifact reader (issue #180). MOCKED because the real wrapper `invoke`s;
    // NOT bypassed — the dialog calls the STORE's `getArtifact` action, and this mock
    // is what that passthrough reaches, so the case exercises the real action (its
    // `null`-is-an-answer rule and its rethrow) rather than a stubbed one.
    getArtifact: vi.fn(),
    // MOCKED because the real wrapper `invoke`s Tauri in jsdom. It matters for the
    // BODY's links: `AgentMarkdown` renders them through `OpenAnchor`, whose click
    // handler calls `externalOpen`. Left real, the wrapper swallows the refusal into
    // a `console.warn` and never rejects, so the click would look like it worked
    // while nothing could assert where the link went.
    externalOpen: vi.fn(),
    reorderTasks: vi.fn(),
    loadHistory: vi.fn(),
    listSkills: vi.fn(),
    listAgentDefinitionsForSpace: vi.fn(),
    listMcpServersEffective: vi.fn(),
    listSpaceListing: vi.fn(),
    listCompletionEntries: vi.fn(),
  };
});

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "tsk_1",
    spacePath: SPACE,
    number: 3,
    title: "Wire up the detail modal",
    body: "A card should open a modal with Discuss and Research.",
    specPath: "/w/alpha/docs/spec.md",
    stageSlug: "backlog",
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
    ...overrides,
  };
}

function link(sessionId: string, stageSlug: string | null = "backlog"): TaskSessionRow {
  return { taskId: "tsk_1", sessionId, stageSlug };
}

function skill(name: string): SkillInfo {
  return {
    name,
    description: `${name} skill`,
    path: `/s/${name}.md`,
    dir: "/s",
    scope: "user",
    body: `${name.toUpperCase()} BODY`,
    disableModelInvocation: false,
    shadowed: [],
  };
}

/** A column, in the nested shape `get_board` publishes.
 *
 *  `onEnterSkill` / `nextSlugs` are REQUIRED on `StageDto` (the Rust reader always
 *  emits both), so they are spelled here rather than left optional. Both default to
 *  `null` = the pre-#179 state, and `nextSlugs: null` specifically means
 *  UNCONFIGURED — the renderer then falls back to the column at `sortOrder + 1`,
 *  while `nextSlugs: []` is a DIFFERENT answer (configured, leading nowhere), so a
 *  case that means the empty case passes it explicitly. */
function column(
  slug: string,
  label = slug,
  tasks: TaskRow[] = [],
  over: Partial<Pick<StageDto, "sortOrder" | "onEnterSkill" | "nextSlugs">> = {},
): StageWithTasks {
  return {
    stage: {
      spacePath: SPACE,
      slug,
      label,
      sortOrder: over.sortOrder ?? 0,
      onEnter: "none",
      onEnterSkill: over.onEnterSkill ?? null,
      nextSlugs: over.nextSlugs ?? null,
      // Both REQUIRED on the wire type since the workflow-graph columns landed
      // (`stages.auto` is `NOT NULL DEFAULT 0`; `promptPrefix` has no SQL DEFAULT and
      // NULL is its only "no extra prompt" state). OFF + `null` is what every
      // existing column carries.
      auto: false,
      promptPrefix: null,
    },
    // `artifactKeys: []` is the "card has no artifacts" answer, and it is REQUIRED
    // on the wire type (issue #180) — an optional field would compile against every
    // fixture here and render nothing when real data arrives.
    tasks: tasks.map((task) => ({
      task,
      sessions: [],
      costUsd: null,
      artifactKeys: [],
    })),
  };
}

/** The board the cases launch against, with the card IN its column.
 *
 *  Not incidental: `useTasks.moveTask` refuses a drag whose card is not in the
 *  loaded board ("a stale gesture") and never reaches the command, so a fixture
 *  whose columns hold no cards would make every launch a silent no-op — and the
 *  orchestrator inherits that guard. The first draft of this file seeded empty
 *  columns and `moveTask` was never called, which read like an orchestrator bug.
 *
 *  The GRAPH is what this fixture exists to state now (issue #179): the buttons are
 *  derived from `backlog`'s `next_slugs`, so the seeded board declares the two
 *  shipped destinations as real edges in the order a person reads them. Before #179
 *  these two buttons came from a hardcoded pair in the component and the fixture had
 *  nothing to say about them; now the fixture IS the reason they exist, which is the
 *  point of the change. */
const BOARDS = [
  column("backlog", "Backlog", [taskRow()], {
    sortOrder: 0,
    nextSlugs: ["discuss", "research"],
  }),
  column("discuss", "Discuss", [], { sortOrder: 1, onEnterSkill: "discuss" }),
  column("research", "Research", [], { sortOrder: 2, onEnterSkill: "research" }),
];

interface RenderArgs {
  task?: TaskRow;
  sessions?: TaskSessionRow[];
  costUsd?: number | null;
  /** The card's artifact KEYS (issue #180). Defaults to the EMPTY set because a card with
   *  no artifacts is the common case. */
  artifactKeys?: string[];
  spacePath?: string | null;
  /** Does a linked Session carry the `ready` marker? Defaults to `false`. */
  ready?: boolean;
  /** Seeded into the STORE, which is where the modal reads the column label from —
   *  the same slice `store/taskLaunch` consults for the Research move. */
  boards?: readonly StageWithTasks[];
  onOpenSession?: (sessionId: string) => void;
  onLaunched?: () => void;
}

function renderDialog(args: RenderArgs = {}) {
  // The board goes into the STORE and not into a prop. A modal that printed a label
  // from a prop while the orchestrator read the store would be two answers to one
  // question, so the fixture has to seed the same place production does.
  useTasks.setState({
    boardsBySpace: { [SPACE]: [...(args.boards ?? BOARDS)] },
  });
  const onOpenSession = args.onOpenSession ?? vi.fn();
  const onLaunched = args.onLaunched ?? vi.fn();
  const onClose = vi.fn();
  const view = render(
    <TaskDetailDialog
      task={args.task ?? taskRow()}
      sessions={args.sessions ?? []}
      costUsd={args.costUsd ?? null}
      artifactKeys={args.artifactKeys ?? []}
      spacePath={args.spacePath === undefined ? SPACE : args.spacePath}
      ready={args.ready ?? false}
      onClose={onClose}
      onOpenSession={onOpenSession}
      onLaunched={onLaunched}
    />,
  );
  return { onOpenSession, onLaunched, onClose, unmount: view.unmount };
}

/** The modal's `DialogContent` element. */
function dialog(): HTMLElement {
  return screen.getByRole("dialog");
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
  vi.mocked(startTaskSession).mockResolvedValue({
    sessionId: "sess_new",
    cwd: SPACE,
    capabilities: {},
    archived: false,
  });
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
});

describe("TaskDetailDialog — what the card cannot show", () => {
  it("shows the number, the full title and the full body", () => {
    // The board's card clamps the title to two lines and the body to two more. The
    // modal exists to show what was clamped, so the BODY is not clamped here — an
    // earlier pass that reused the card's `line-clamp-2` would put the same clip in
    // the surface that removed it.
    renderDialog();
    expect(within(dialog()).getByText("T3")).toBeTruthy();
    expect(within(dialog()).getByText("Wire up the detail modal")).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "A card should open a modal with Discuss and Research.",
      ),
    ).toBeTruthy();
  });

  it("names the column the card is in by LABEL and not by slug", () => {
    // `stageSlug` is what the wire carries and what a person never says. The Stage control
    // prints the LABEL, and a modal that printed `doing` beside an `In Progress` column
    // would be two answers to one question.
    renderDialog({
      boards: [column("backlog", "Backlog"), column("doing", "In Progress")],
      task: taskRow({ stageSlug: "doing" }),
    });
    const combobox = within(dialog()).getByRole("combobox", { name: "Stage" });
    expect(combobox.textContent).toContain("In Progress");
    expect(combobox.textContent).not.toContain("doing");
  });

  it("falls back to the slug when the board has no column by that name", () => {
    // The board slice can be stale (a column deleted in another window). Printing
    // NOTHING would read as "this card has no column", which is a different claim
    // from "we could not name it" — the slug is the honest fallback.
    renderDialog({ task: taskRow({ stageSlug: "archived-later" }) });
    const combobox = within(dialog()).getByRole("combobox", { name: "Stage" });
    expect(combobox.textContent).toContain("archived-later");
  });

  it("renders no body region for an empty body — an empty body is not a body", () => {
    // The card hides `""` through truthiness; the modal agrees, so the two surfaces give
    // one answer. An empty body shows the placeholder instead of a region.
    const first = renderDialog({ task: taskRow({ body: "A body" }) });
    expect(within(dialog()).getByTestId("task-body")).toBeTruthy();
    first.unmount();
    renderDialog({ task: taskRow({ body: "" }) });
    expect(within(dialog()).queryByTestId("task-body")).toBeNull();
    expect(within(dialog()).getByText("Add a description…")).toBeTruthy();
  });

  it("prints the summed cost, and prints NOTHING for a cost never reported", () => {
    // ADR 0082, and the rule is `moneyOf`'s: `null` is "no linked Session ever reported a
    // cost" and `0` is "a real zero". The figure lives in the Properties Activity row now.
    const { unmount } = renderDialog({ costUsd: 2.5, sessions: [link("sess_a")] });
    expect(activityText()).toContain("$2.50");
    unmount();
    renderDialog({ costUsd: 0, sessions: [link("sess_a")] });
    expect(activityText()).toContain("$0.00");
    unmount();
    renderDialog({ costUsd: null });
    expect(activityText()).not.toContain("$");
  });
});

/** The Activity row's text, in the Properties column. */
function activityText(): string {
  return dialog().querySelector('[data-property="activity"]')?.textContent ?? "";
}

describe("TaskDetailDialog — the sessions list", () => {
  it("lists one row per linked session and opens the one clicked", () => {
    // The card carries only a COUNT (a chip saying "2 sessions" is the right amount
    // of information on a card). Listing them is what the card cannot do and what
    // this modal exists for.
    const { onOpenSession } = renderDialog({
      sessions: [link("sess_old"), link("sess_new")],
    });
    const rows = within(dialog()).getAllByTestId("task-session-row");
    expect(rows).toHaveLength(2);
    // Read the identity off the row BEFORE clicking it, then assert the callback got
    // THAT id. A test that only asserted "onOpenSession was called with sess_new"
    // would pass for a row wired to a different entry than the one it rendered.
    expect(rows[1]!.getAttribute("data-session-id")).toBe("sess_new");
    fireEvent.click(rows[1]!);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("sess_new");
  });

  it("renders no sessions section at all when the card has none", () => {
    // No placeholder: "0 sessions" is a fact the header already states, and an empty
    // section header over an empty list is the shape that makes a surface look
    // broken rather than young.
    renderDialog({ sessions: [] });
    expect(within(dialog()).queryAllByTestId("task-session-row")).toHaveLength(0);
    // No section HEADER for an empty list either — the header line above already
    // states the count, so a second "0 sessions" line under it is the placeholder
    // this case exists to refuse.
    expect(within(dialog()).queryByText(/Sessions on this task/)).toBeNull();
  });

  it("says which session a card's chip would open, and opens the NEWEST", () => {
    // The card's chip opens `sessions[sessions.length - 1]` because the query is
    // oldest-first. If the modal's list ORDER disagreed with the card's, the two
    // surfaces would disagree about "this card's session" — so the ORDER is pinned
    // here and not left to the caller having sorted correctly.
    const { onOpenSession } = renderDialog({
      sessions: [link("sess_old"), link("sess_new")],
    });
    const rows = within(dialog()).getAllByTestId("task-session-row");
    // Read the ORDER off the attribute each row carries, since the ids are session
    // ids and not text a query can name.
    expect(rows.map((r) => r.getAttribute("data-session-id"))).toEqual([
      "sess_old",
      "sess_new",
    ]);
    // The newest is LAST, and the modal opens whichever row was clicked — it does
    // not re-pick.
    fireEvent.click(rows[1]!);
    expect(onOpenSession).toHaveBeenCalledWith("sess_new");
  });
});

describe("TaskDetailDialog — the graph buttons", () => {
  it("has one button per outgoing edge, in next_slugs order", async () => {
    // THE REPLACEMENT FOR "exactly Discuss and Research". The set of buttons is no
    // longer a fact the component knows; it is the Stage's `next_slugs`. So the pin
    // is about DERIVATION and ORDER: three edges in, three buttons out, in the order
    // the row declares them — which is the only way a Space's own workflow can decide
    // what the modal offers without a code change (ADR 0098/0099).
    //
    // Order is asserted as a LIST and not with three `getByRole` calls, because three
    // separate lookups cannot see a swap: a component that reversed the array would
    // satisfy every one of them.
    renderDialog({
      boards: [
        column("backlog", "Backlog", [taskRow()], {
          nextSlugs: ["research", "doing", "review"],
        }),
        column("research", "Research", [], { onEnterSkill: "research" }),
        column("doing", "Doing"),
        column("review", "Review"),
      ],
    });
    const labels = (await screen.findAllByRole("button"))
      .map((b) => b.getAttribute("aria-label") ?? "")
      .filter((label) => label !== "");
    expect(labels).toEqual(["Research", "Doing", "Review"]);
  });

  it("falls back to the Stage at sortOrder + 1 when next_slugs is NULL", async () => {
    // `next_slugs: null` means UNCONFIGURED (ADR 0099), not "leads nowhere" — so an
    // unconfigured board must still offer the shipped launch button rather than
    // silently losing it on upgrade. The fallback is the column at `sortOrder + 1`,
    // which on the default seeded order after `backlog` is `discuss`.
    //
    // `nextSlugs: []` is deliberately NOT tested as this case: it is the OTHER answer
    // (configured, leading nowhere) and renders no button, pinned by the case below.
    renderDialog({
      boards: [
        column("backlog", "Backlog", [taskRow()], {
          sortOrder: 0,
          nextSlugs: null,
        }),
        column("research", "Research", [], {
          sortOrder: 1,
          onEnterSkill: "research",
        }),
      ],
    });
    const buttons = (await screen.findAllByRole("button")).filter(
      (b) => (b.getAttribute("aria-label") ?? "") !== "",
    );
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Research"]);
  });

  it("renders NO button for a Stage with no edge and no successor", async () => {
    // The last column of a board leads nowhere, so the modal offers nothing — an
    // empty footer rather than a disabled button that cannot be made to work. This is
    // the `nextSlugs: []` / no-successor answer, which is DIFFERENT from `null`
    // (unconfigured, falls back to the next column) and the two must not collapse.
    renderDialog({
      task: taskRow({ stageSlug: "done" }),
      boards: [
        column("done", "Done", [taskRow({ stageSlug: "done" })], {
          nextSlugs: [],
        }),
      ],
    });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: /Research|Discuss|Backlog/ }),
    ).toBeNull();
  });

  it("Discuss starts a session with the discuss skill and files it in Discuss", async () => {
    // THE BEHAVIOUR SWAP this task makes, and it is deliberate rather than collateral:
    // `discuss` used to load its skill WITHOUT moving the card, because
    // `stageOfMode("discuss")` returned `null` — there was no column to move to. ADR
    // 0098 grew the seed a sixth entry, `discuss`, so the destination is a real row
    // now and `resolveStage` has no "do not move it" arm: a destination is a column
    // the person clicked, so the card goes there.
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "discuss");
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    // The `$` TOKEN, not an inlined body: `taskLaunch.shouldInlineSkill` sends a
    // model-visible skill as a token and lets the Worker `read_skill` it. Asserting
    // the name rather than a block keeps this pin about WHICH skill the destination
    // carries, which is the only thing this surface decides.
    expect(sent).toContain("$discuss");
    expect(sent).not.toContain("$research");
    expect(sent).not.toContain("<skill");
    expect(sent).toContain("<task ");
    // The instruction sentence names the destination's LABEL, not a per-mode string.
    expect(sent).toContain("Let's work on Discuss.");
  });

  it("Research moves the card to the research column AND loads the research skill", async () => {
    // The transition is the difference between the two buttons, and it is the whole
    // of PR #178: a research Session belongs under Research. #179 keeps the behaviour
    // and changes where the slug and the skill come from — the row, not a switch.
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Research" }));
    await waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "research");
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain("$research");
    expect(sent).not.toContain("$discuss");
  });

  it("leaves the board view once a session is open", async () => {
    // THE PROP THAT MAKES THE FEATURE VISIBLE. The launch selects the new Session in
    // the store, but the board view COVERS the chat — so without `onLaunched` the
    // click starts a real Session and the user sees nothing happen at all. That is
    // the same defect the card's sessions chip had, and it is pinned here rather
    // than left to be re-discovered.
    const { onLaunched } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
  });

  /// THE NAVIGATION MUST NOT WAIT FOR THE TURN.
  ///
  /// `launch` awaited `sendLaunchMessage`, and `sendPrompt` resolves only when the
  /// turn SETTLES — `router.rs` resolves `pending_turn` on `agent_settled`, and the
  /// `discuss` skill's whole shape is to end its turn on an `ask` gate. So on a real
  /// click the board stayed up for the entire first turn.
  ///
  /// That is not merely slow, it is a DEADLOCK: the board view replaces
  /// `ChatStream` in `App`'s ternary, and `AskQuestionCard` is rendered ONLY by
  /// `MessageList` under `ChatStream`. So the gate the turn is waiting on has no
  /// renderer while the launch is in flight, and the turn cannot settle to let the
  /// view switch that would mount one. Every mocked `sendPrompt` in this file
  /// resolves immediately, which is why the existing pins pass and the feature does
  /// not.
  it("leaves the board WITHOUT waiting for the first turn to settle", async () => {
    // A turn that never settles — the `ask`-gate case, not a pathological fixture.
    vi.mocked(sendPrompt).mockReturnValue(new Promise(() => {}));
    const { onLaunched } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    // The navigation happens on the START of the turn, not at its end.
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    // And the turn is still in flight — proof the assertion above did not simply
    // race a fast mock to the finish line.
    expect(useSessions.getState().inTurn["sess_new"]).toBeTruthy();
  });

  it("closes itself after launching", async () => {
    // The modal has no reason to survive its own action, and leaving it up over the
    // transcript it just opened is the same occlusion in a second layer.
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("does NOT close or leave the board when the launch fails", async () => {
    // A failed launch that closed the dialog would lose the card the user was
    // reading, and the error line it wanted to show would be gone with it.
    vi.mocked(startTaskSession).mockRejectedValue(
      new Error("no provider configured"),
    );
    const { onClose, onLaunched } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "no provider configured",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("disables both buttons while a launch is in flight", async () => {
    // A double click would otherwise be two launches; `store/taskLaunch` guards it,
    // but a button that visibly answers twice is a lie about the outcome.
    const slots: { resolve?: (v: SessionInfo) => void } = {};
    vi.mocked(startTaskSession).mockReturnValue(
      new Promise<SessionInfo>((resolve) => {
        slots.resolve = resolve;
      }),
    );
    renderDialog();
    const discuss = await screen.findByRole("button", { name: "Discuss" });
    fireEvent.click(discuss);
    // `.disabled` and not `aria-disabled`: this repo's vitest setup carries no
    // jest-dom, and `Button` renders a real `<button>`, so the property is the
    // thing that exists (the same idiom `TasksBoard.test.tsx` uses for New task).
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      (screen.getByRole("button", { name: "Research" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    slots.resolve?.({
      sessionId: "s",
      cwd: SPACE,
      capabilities: {},
      archived: false,
    });
  });

  it("shows the skipped-column note when the Space has no research column", async () => {
    // A WARNING and not a failure: the Session started, the card did not move. The
    // board is what tells us the column is missing, and this is the only surface that
    // can say so — `store/taskLaunch` returns the note and nothing else renders it.
    //
    // The edge is declared as `nextSlugs: ["research"]` and the board has no such
    // column, which is the case the `absent` arm still exists for: the button was
    // painted from a slice that has since gone stale (or the graph names a slug the
    // Space deleted). The sentence is byte-identical to the pre-#179 one and names
    // `research`, so it is pinned verbatim here as well as in `taskLaunch.test.ts`.
    const { onLaunched, onClose } = renderDialog({
      task: taskRow(),
      boards: [
        column("backlog", "Backlog", [taskRow()], { nextSlugs: ["research"] }),
        column("doing", "Doing"),
      ],
    });
    // The button is labelled with the SLUG, because the slice has no row to name it —
    // the same honest fallback the stage line uses two cases above.
    fireEvent.click(await screen.findByRole("button", { name: "research" }));
    await waitFor(() =>
      expect(within(dialog()).getByRole("status").textContent).toContain("research"),
    );
    expect(moveTask).not.toHaveBeenCalled();
    // THE NOTE WINS OVER THE NAVIGATION. The Session did start, but the thing the
    // user clicked for — the card moving — did not, and a note about a CARD belongs
    // on the surface showing the card. Navigating away would bury the only sentence
    // that explains it.
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a destination with NO Skill is never disabled, and launches with no token", async () => {
    // Spec §7.1's other half, and the one a `skills.some(...)` predicate destroys by
    // accident: a Stage whose `on_enter_skill` is NULL has nothing to wait for, so
    // gating it on the catalog would disable a launch that CANNOT fail. Moving a card
    // is still useful with nothing to load.
    //
    // The catalog here is EMPTY of anything the board mentions, so a component that
    // gated every button on "is there a catalog row" renders this button disabled —
    // the exact silent-green shape where a working destination looks broken.
    vi.mocked(listSkills).mockResolvedValue([]);
    const { onLaunched } = renderDialog({
      task: taskRow({ stageSlug: "doing" }),
      boards: [
        column("doing", "Doing", [taskRow({ stageSlug: "doing" })], {
          nextSlugs: ["review"],
        }),
        column("review", "Review", [], { onEnterSkill: null }),
      ],
    });
    const review = await screen.findByRole("button", { name: "Review" });
    await waitFor(() =>
      expect((review as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(review);
    await waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "review");
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    // No token at all — not a bare `$`, and not a guessed skill name.
    expect(sent).not.toContain("$");
    expect(sent).toContain("<task ");
    expect(sent).toContain("Let's work on Review.");
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it("disables each button whose skill the catalog does not have", async () => {
    // THE RACE THIS PREVENTS, found while wiring the board: the catalog is an async
    // fetch, so a button enabled from the first paint is clickable BEFORE the catalog
    // lands — and the first click then fails with "This Space has no `discuss` skill",
    // a sentence that is false two frames later. Gating each button on the skill it
    // actually needs removes the race instead of narrowing it, because the same
    // condition decides both the enabled state and the orchestrator's refusal.
    vi.mocked(listSkills).mockResolvedValue([skill("research")]);
    renderDialog();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Research" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("is disabled on the FIRST paint, before the catalog has landed", async () => {
    // The catalog starts EMPTY (`useCatalogRow`'s empty constant), so the first frame
    // cannot know whether either skill exists. A button enabled there is the race
    // above; a button disabled there costs the user one frame.
    vi.mocked(listSkills).mockReturnValue(new Promise(() => {})); // never resolves
    renderDialog();
    expect(
      (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("refuses both buttons when the Space has no such skill, and says which", async () => {
    // `expandMentions` leaves an unmatched token VERBATIM, so a missing skill would
    // otherwise send a literal `$discuss`. The modal surfaces the refusal rather
    // than starting a Session that quietly does nothing.
    vi.mocked(listSkills).mockResolvedValue([skill("other")]);
    renderDialog();
    // BOTH are disabled, so nothing can be clicked and no error line is needed — the
    // disabled state IS the message, and it appears without a click being wasted.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Discuss" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(
      (screen.getByRole("button", { name: "Research" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(startTaskSession).not.toHaveBeenCalled();
  });

  it("offers NO button with no Space, rather than opening a session nowhere", async () => {
    // `startTaskSession(null, …)` is not a thing, and since #179 the refusal is
    // STRUCTURAL rather than a `disabled` flag: the buttons are derived from the
    // board slice, and the modal reads that slice through `spacePath`, so with no
    // Space there is no slice, no edges, and nothing to paint. That is a stronger
    // answer than a disabled button — there is no control to enable by accident — and
    // it is why `noSpace` remains in the per-edge predicate as well, for a board that
    // is somehow present while the Space is not.
    renderDialog({ spacePath: null });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: /Discuss|Research/ }),
    ).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(startTaskSession).not.toHaveBeenCalled();
  });
});

describe("TaskDetailDialog — the artifact tabs (issue #180)", () => {
  /** One artifact row, as `getArtifact` answers it. */
  const artifact = (key: string, markdown: string) => ({
    taskId: "tsk_1",
    key,
    markdown,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
  });

  /** The tab for one key (or Overview), by its `data-tab-key`. */
  const tab = (key: string): HTMLElement =>
    within(dialog()).getByTestId("detail-tabs").querySelector(
      `[data-tab-key="${key}"]`,
    ) as HTMLElement;

  /** The reader's own node. The assertions about the DOCUMENT scope to it because the
   *  dialog's TITLE is itself a heading, so a dialog-wide `getByRole("heading")` answers
   *  the card's name and not the artifact's. */
  const reader = async (): Promise<HTMLElement> =>
    await within(dialog()).findByTestId("artifact-body");

  it("a Task with no artifacts renders NO tab strip and fetches nothing", () => {
    // `[]` gets NO placeholder. The board read answers `[]` for a card without artifacts,
    // and the common case must read as nothing at all.
    renderDialog();
    expect(within(dialog()).queryByTestId("detail-tabs")).toBeNull();
    expect(within(dialog()).queryByTestId("artifact-body")).toBeNull();
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("a card with artifact keys lists them as tabs and fetches NOTHING until one is opened", () => {
    // The keys came from the board read; the DOCUMENT did not, and must not be fetched for
    // a tab nobody opened — the whole point of the keys-only board payload (spec §1).
    renderDialog({ artifactKeys: ["plan", "research"] });
    expect(
      within(dialog()).getAllByRole("tab").map((t) => t.textContent),
    ).toEqual(["Overview", "plan", "research"]);
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("opening a tab fetches it and renders the markdown as a DOCUMENT", async () => {
    // A spec is markdown, so it renders through `AgentMarkdown`: a heading becomes a
    // heading. The pin is the parsed element and not the text.
    vi.mocked(getArtifact).mockResolvedValue(artifact("plan", "# The plan\n\n- do it"));
    renderDialog({ artifactKeys: ["plan"] });
    fireEvent.click(tab("plan"));
    await waitFor(() => expect(getArtifact).toHaveBeenCalledWith("tsk_1", "plan"));
    expect(tab("plan").getAttribute("aria-selected")).toBe("true");
    const body = await reader();
    expect(within(body).getByRole("heading", { level: 1 }).textContent).toBe("The plan");
    expect(within(body).getByRole("listitem").textContent).toBe("do it");
    expect(body.querySelector(".whitespace-pre-wrap")).toBeNull();
    expect(within(body).queryByText("# The plan")).toBeNull();
  });

  it("an artifact that is gone answers null and renders no document", async () => {
    // `null` is an ANSWER from the store (no such artifact), not a failure — no error line.
    vi.mocked(getArtifact).mockResolvedValue(null);
    renderDialog({ artifactKeys: ["plan"] });
    fireEvent.click(tab("plan"));
    await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(within(dialog()).queryByTestId("artifact-body")).toBeNull();
    expect(tab("plan").textContent).toBe("plan");
  });

  it("re-opening a LOADED tab does not refetch its document", async () => {
    // `useArtifactReader` has no cache and no deselect, so the dialog skips the refetch when
    // the document it would ask for is already the one on screen.
    vi.mocked(getArtifact).mockResolvedValue(artifact("plan", "# The plan"));
    renderDialog({ artifactKeys: ["plan"] });
    fireEvent.click(tab("plan"));
    await reader();
    fireEvent.click(tab("overview"));
    fireEvent.click(tab("plan"));
    await reader();
    expect(getArtifact).toHaveBeenCalledTimes(1);
  });

  it("switching tabs drops the old document while the next fetch is still in flight", async () => {
    // THE in-flight gap: the second read hangs, so the only frame that can exist is "key
    // `research` selected, nothing loaded yet". The FIRST of two locks in the reader.
    const slots: Array<(v: ReturnType<typeof artifact> | null) => void> = [];
    vi.mocked(getArtifact).mockImplementation(
      () => new Promise((resolve) => slots.push(resolve)),
    );
    renderDialog({ artifactKeys: ["plan", "research"] });
    fireEvent.click(tab("plan"));
    slots[0]!(artifact("plan", "# First spec"));
    expect(within(await reader()).getByRole("heading", { level: 1 }).textContent).toBe(
      "First spec",
    );
    fireEvent.click(tab("research"));
    await waitFor(() => expect(within(dialog()).queryByTestId("artifact-body")).toBeNull());
    expect(within(dialog()).queryByText("First spec")).toBeNull();
    expect(getArtifact).toHaveBeenCalledTimes(2);
  });

  it("an out-of-order resolution cannot paint one key's document under another", async () => {
    // THE case the request-identity check exists for. Two reads in flight and the FIRST
    // answers LAST: the late `plan` document must be DROPPED while `research` is shown.
    const slots: Array<(v: ReturnType<typeof artifact> | null) => void> = [];
    vi.mocked(getArtifact).mockImplementation(
      () => new Promise((resolve) => slots.push(resolve)),
    );
    renderDialog({ artifactKeys: ["plan", "research"] });
    fireEvent.click(tab("plan"));
    fireEvent.click(tab("research"));
    expect(getArtifact).toHaveBeenCalledTimes(2);
    slots[1]!(artifact("research", "# Second report"));
    expect(within(await reader()).getByRole("heading", { level: 1 }).textContent).toBe(
      "Second report",
    );
    slots[0]!(artifact("plan", "# First spec"));
    await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(2));
    expect(within(await reader()).queryByText("First spec")).toBeNull();
    expect(within(await reader()).getByRole("heading", { level: 1 }).textContent).toBe(
      "Second report",
    );
  });

  it("a failed fetch shows the error line and keeps the dialog open", async () => {
    vi.mocked(getArtifact).mockRejectedValue(new Error("ipc failed"));
    const { onClose } = renderDialog({ artifactKeys: ["plan"] });
    fireEvent.click(tab("plan"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("ipc failed"),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(tab("plan").textContent).toBe("plan");
  });
});

describe("TaskDetailDialog — closing", () => {
  it("closes on Escape via the dialog's own dismiss", async () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("names itself with the card's number, so two modals are never ambiguous", () => {
    // `T3` is what a person says out loud (ADR 0090: the number is the label, the
    // `tsk_` id is the key). A title of "Task" would make every modal identical.
    renderDialog({ task: taskRow({ number: 7 }) });
    expect(within(dialog()).getByRole("heading").textContent).toContain("T7");
  });
});

describe("TaskDetailDialog — the modal scrolls (issue #180 follow-up)", () => {
  /**
   * A long Task body used to clip the launch buttons out of view. The content between the
   * header and the footer is ONE scroller, and it is the only scroll container in the modal.
   * Pinned by CLASS because jsdom runs no layout.
   */
  const scroller = (): HTMLElement => within(dialog()).getByTestId("detail-scroll");

  it("the content between header and footer is a scroll container", () => {
    renderDialog({ task: taskRow({ body: "x".repeat(5000) }) });
    const s = scroller();
    // It must SCROLL, and `min-h-0` is the half people forget: a flex item's default
    // `min-height: auto` refuses to shrink below its content, so `flex-1` alone still
    // grows the box past the cap and clips exactly as before.
    expect(s.classList.contains("overflow-y-auto")).toBe(true);
    expect(s.classList.contains("min-h-0")).toBe(true);
    expect(s.classList.contains("flex-1")).toBe(true);
  });

  it("the Description and the sessions list sit INSIDE the scroller", () => {
    renderDialog({
      task: taskRow({ body: "A long body" }),
      sessions: [link("sess_a"), link("sess_b")],
    });
    const s = scroller();
    expect(within(s).getByTestId("task-body")).toBeTruthy();
    expect(within(s).getAllByTestId("task-session-row")).toHaveLength(2);
  });

  it("the Properties column sits OUTSIDE the scroller — the spec path and id live there", () => {
    // `task-properties` is a sibling of the scroll region, so a property never scrolls away
    // with the document.
    renderDialog({ task: taskRow({ specPath: "/w/alpha/spec.md" }) });
    const props = within(dialog()).getByTestId("task-properties");
    expect(scroller().contains(props)).toBe(false);
    expect(props.textContent).toContain("/w/alpha/spec.md");
    expect(props.textContent).toContain(taskRow().id);
  });

  it("the footer and the header sit OUTSIDE the scroller and cannot be scrolled away", () => {
    renderDialog({ task: taskRow({ body: "x".repeat(5000) }) });
    const s = scroller();
    const footer = dialog().querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(s.contains(footer)).toBe(false);
    expect(footer!.classList.contains("shrink-0")).toBe(true);
    const header = dialog().querySelector('[data-slot="dialog-header"]');
    expect(s.contains(header)).toBe(false);
    expect(header!.classList.contains("shrink-0")).toBe(true);
  });

  it("the shell is a capped flex column — the premise the scroller depends on", () => {
    renderDialog();
    const cls = Array.from(dialog().classList);
    expect(cls.some((c) => c.startsWith("max-h-"))).toBe(true);
    expect(cls).toContain("flex-col");
    // The base primitive is a `grid`; the override has to survive `cn()`'s merge.
    expect(cls).not.toContain("grid");
  });

  it("detail-scroll is the ONLY scroll container in the dialog", async () => {
    // DIALOG-WIDE: "only one scrollbar" is a property of the whole dialog.
    vi.mocked(getArtifact).mockResolvedValue({
      taskId: "tsk_1",
      key: "plan",
      markdown: "# The spec",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_600_000,
    });
    renderDialog({
      task: taskRow({ body: "A body" }),
      artifactKeys: ["plan"],
      sessions: [link("sess_a"), link("sess_b")],
    });
    fireEvent.click(
      within(dialog()).getByTestId("detail-tabs").querySelector('[data-tab-key="plan"]')!,
    );
    await within(dialog()).findByTestId("artifact-body");
    const scrollers = Array.from(dialog().querySelectorAll(".overflow-y-auto"));
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]!.getAttribute("data-testid")).toBe("detail-scroll");
  });

  it("the sessions section is not a scroll container and does not shrink", () => {
    // `min-h-0` + `overflow-y-auto` with no `shrink-0` is a real nested scrollbar once
    // anything else in the scroller is tall, so the wrapper must not be a second scroller.
    renderDialog({
      task: taskRow({ body: "A body" }),
      sessions: [link("sess_a"), link("sess_b")],
    });
    const wrapper = within(scroller()).getByText("Sessions on this task").parentElement!;
    const cls = Array.from(wrapper.classList);
    expect(cls).toContain("shrink-0");
    expect(cls).not.toContain("overflow-y-auto");
    expect(cls).not.toContain("min-h-0");
  });
});

describe("TaskDetailDialog — the body renders as markdown", () => {
  /**
   * Spec §1. The body is the ONE field the card clamps to two lines, and until this
   * pass the modal printed it through a `whitespace-pre-wrap` `<p>` — so a link a
   * person wrote in a Task body was inert text and no GFM construct rendered.
   * `AgentMarkdown` is the transcript's renderer (extracted verbatim in issue #180
   * for exactly this), and reusing it is what keeps the URL policy (`safeUrlTransform`,
   * ADR 0051) and the External-open routing (`OpenAnchor`) in ONE place rather than
   * re-spelled here.
   *
   * Every assertion is on the RENDERED DOM, not on the file's text: a comment may
   * name a class without wearing it, and it is the wearing the spec forbids.
   */
  it("renders the body through AgentMarkdown, so a heading is a heading", () => {
    const first = renderDialog({ task: taskRow({ body: "# The plan\n\n- one\n- two" }) });
    // Throws while the body is still a `<p>` — that is the red state this describe
    // exists to close.
    const body = within(dialog()).getByTestId("task-body");
    expect(within(body).getByRole("heading", { level: 1 }).textContent).toBe(
      "The plan",
    );
    expect(within(body).getAllByRole("listitem")).toHaveLength(2);
    // DIALOG-WIDE, not scoped to the body node: the criterion is that NOTHING in the
    // rendered dialog wears the prose class, and a query scoped to `body` would let a
    // `whitespace-pre-wrap` wrapper anywhere else pass.
    expect(dialog().querySelectorAll(".whitespace-pre-wrap")).toHaveLength(0);
    first.unmount();

    // ADR 0101's ACCEPTED COST, pinned. `remark-breaks` was considered and rejected,
    // so a single newline collapses to a space. There is no `.remark-breaks`-style
    // class to grep for in the DOM — the `<br>` it would emit is the only observable
    // trace, which is why the criterion is phrased as its ABSENCE.
    renderDialog({ task: taskRow({ body: "line one\nline two" }) });
    const soft = within(dialog()).getByTestId("task-body");
    expect(soft.querySelectorAll("br")).toHaveLength(0);
    expect(soft.textContent).toContain("line one");
    expect(soft.textContent).toContain("line two");
  });

  it("renders GFM: a table, a strikethrough and a task list", () => {
    // `remark-gfm` is already mounted inside `AgentMarkdown`, so all three constructs
    // come free with the swap — and each is a construct the `<p>` printed verbatim.
    renderDialog({
      task: taskRow({
        body: "| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n- [ ] todo",
      }),
    });
    const body = within(dialog()).getByTestId("task-body");
    expect(body.querySelector("table")).not.toBeNull();
    expect(within(body).getAllByRole("columnheader")).toHaveLength(2);
    expect(body.querySelector("del")?.textContent).toBe("gone");
    // A `- [ ]` item is a real checkbox, not the literal text `[ ]`.
    expect(body.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it("a body link is an anchor that External-opens rather than navigating", () => {
    // A bare `<a href>` in the Client's webview NAVIGATES it — the navigation guard
    // then refuses, so the click used to do nothing at all. `OpenAnchor` cancels the
    // default and hands the href to `external_open` instead.
    renderDialog({ task: taskRow({ body: "[docs](https://x.test/a)" }) });
    const body = within(dialog()).getByTestId("task-body");
    const a = body.querySelector("a");
    expect(a).not.toBeNull();
    // The href SURVIVES to the DOM (hover target, focus and copy-link all need it) —
    // read off the ATTRIBUTE, since the `href` property resolves against jsdom's base.
    expect(a!.getAttribute("href")).toBe("https://x.test/a");
    // `false` is RTL's signal that the handler called `preventDefault`, i.e. the
    // webview would NOT have navigated.
    expect(fireEvent.click(a!)).toBe(false);
    expect(externalOpen).toHaveBeenCalledTimes(1);
    expect(externalOpen).toHaveBeenCalledWith("https://x.test/a", null);
  });

  it("a RELATIVE body link hands a null cwd to external_open without a SpaceCwdProvider", () => {
    // This is the PINNED half of the `relative-without-cwd` refusal, and only that
    // half. The refusal STRING is produced in Rust and swallowed into a
    // `console.warn` by `lib/tauri/commands/external.ts`, so jsdom cannot observe it
    // and no TS-side union names the code. What IS assertable is that the cwd went
    // out as `null` rather than as a guess.
    //
    // This file mounts NO `SpaceCwdProvider` at all, which is also the real
    // no-active-Session case (`useActiveSpaceCwd` answers `null` there) — so the
    // behaviour is PINNED here, not fixed. Do NOT wrap this render in a provider to
    // make the link "work".
    renderDialog({ task: taskRow({ body: "[spec](docs/roadmap/x.md)" }) });
    const body = within(dialog()).getByTestId("task-body");
    const a = body.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("docs/roadmap/x.md");
    expect(fireEvent.click(a!)).toBe(false);
    expect(externalOpen).toHaveBeenCalledTimes(1);
    expect(externalOpen).toHaveBeenCalledWith("docs/roadmap/x.md", null);
  });

  it("a javascript: link in a body renders an empty href and does not throw", () => {
    // ADR 0051's denylist, and the reason reusing `AgentMarkdown` adds no new
    // security code: `safeUrlTransform` refuses `javascript` / `data` / `vbscript` /
    // `blob` / `filesystem`, so no script-bearing href ever reaches the DOM.
    renderDialog({ task: taskRow({ body: "[x](javascript:alert(1))" }) });
    const body = within(dialog()).getByTestId("task-body");
    const a = body.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("");
    // A refused scheme must not be a broken control: the click is swallowed by the
    // wrapper's `console.warn`, never thrown into the click handler.
    expect(() => fireEvent.click(a!)).not.toThrow();
  });

  it("a card with no body renders no body region at all", () => {
    // The ABSENCE assertion needs its positive control in the SAME case, because
    // `task-body` does not exist anywhere today: a bare `queryByTestId(…) === null`
    // would pass against the unmodified component and pin nothing. Sequence is
    // render → assert present → re-render → assert absent, so the case is red for the
    // right reason (the control throws while the body is a `<p>`) and the absence half
    // is proven to measure a real conditional render.
    const first = renderDialog({ task: taskRow({ body: "A body" }) });
    expect(within(dialog()).getByTestId("task-body")).toBeTruthy();
    first.unmount();
    renderDialog({ task: taskRow({ body: null }) });
    expect(within(dialog()).queryByTestId("task-body")).toBeNull();
  });
});

describe("TaskDetailDialog — the clickable grammar", () => {
  /**
   * Spec §2. The session rows are the clickable rows in this dialog: a status mark leads
   * them and a trailing "from Stage" caption closes them. The artifact tabs replaced the
   * old key rows, so the glyph/chevron grammar now lives on the tabs, not in this describe.
   */
  it("every session row carries a SessionStatusMark, and the state comes from the store", () => {
    // The mark is `SessionStatusMark` — the ONE session-state glyph the sidebar row
    // and the Space tab already draw — and the state comes from `useSessionStatuses`,
    // never from a value this component invents.
    useSessions.setState({
      sessions: [makeSessionRow({ sessionId: "sess_a", cwd: SPACE })],
      inTurn: {},
    });
    const first = renderDialog({ sessions: [link("sess_a")] });
    const row = within(dialog()).getByTestId("task-session-row");
    expect(within(row).getByTestId("session-status-mark")).toBeTruthy();
    // Live and NOT in a turn ⇒ `live` ⇒ the filled ring.
    expect(row.querySelector('[data-dot="live"]')).toBeTruthy();

    // SECOND ARM, same case: the claim is "the state is DERIVED, not painted", and one
    // state cannot prove that. Put the same Session in a turn and the very same row
    // draws the spinner instead of the ring — no prop changed, only the store.
    first.unmount();
    useSessions.setState({
      sessions: [makeSessionRow({ sessionId: "sess_a", cwd: SPACE })],
      inTurn: { sess_a: true },
    });
    renderDialog({ sessions: [link("sess_a")] });
    const busy = within(dialog()).getByTestId("task-session-row");
    expect(within(busy).getByTestId("session-status-mark")).toBeTruthy();
    // `Spinner` carries its own `role="status"`. (`waiting`/`running` outrank `live`,
    // so the ring is gone — and nothing else in this render is a `status` node,
    // because the launch note only exists after a launch.)
    expect(busy.querySelector('[role="status"]')).toBeTruthy();
    expect(busy.querySelector('[data-dot="live"]')).toBeNull();
  });

  it("a session row prints the TITLE and demotes the id out of the text flow", () => {
    // `titleFor` is the ONE label rule (title → first user message → Space folder),
    // shared with the sidebar row, so the two surfaces cannot name one Session
    // differently. The id is DEMOTED, not deleted — a card discussed across two
    // windows is named by a session id, so it stays reachable on hover and by copy.
    useSessions.setState({
      sessions: [
        makeSessionRow({
          sessionId: "sess_a",
          cwd: SPACE,
          title: "Fix the login bug",
        }),
      ],
    });
    renderDialog({ sessions: [link("sess_a")] });
    const row = within(dialog()).getByTestId("task-session-row");
    expect(row.textContent).toContain("Fix the login bug");
    expect(row.textContent).not.toContain("sess_a");
    expect(row.getAttribute("title")).toBe("sess_a");
    // And still addressable by the attribute the board's own test clicks through.
    expect(row.getAttribute("data-session-id")).toBe("sess_a");
  });

  it("a session row with no title falls back to the transcript's first user message", () => {
    // The SECOND arm of `titleFor`, and the case that proves the dialog reads that ONE
    // rule rather than printing `SessionInfo.title` directly — a dialog that did the
    // latter would render the Space folder name here (`alpha`).
    useSessions.setState({
      sessions: [makeSessionRow({ sessionId: "sess_a", cwd: SPACE })],
      messages: { sess_a: [makeMessage("user", { text: "Refactor the parser" })] },
    });
    renderDialog({ sessions: [link("sess_a")] });
    const row = within(dialog()).getByTestId("task-session-row");
    expect(row.textContent).toContain("Refactor the parser");
  });
});

describe("TaskDetailDialog — the session's Stage label", () => {
  /**
   * Spec §2's one correctness fix. `stageSlug` is what the wire carries; printing it on
   * a session row while this dialog's OWN header prints the Stage's `label` three lines
   * above puts two answers to one question in one modal. The dialog already holds the
   * `columns` slice it resolved the header's label from, so resolving the link's slug
   * through the same lookup is free — one read, one source.
   */
  it("a session row prints the Stage LABEL, not its slug", () => {
    // RED until the fix lands: the row prints `from doing`.
    //
    // BOTH columns are seeded on purpose. `backlog` is what the HEADER resolves, so a
    // fixture carrying only `doing` would leave the header printing a slug and this case
    // would be measuring two things instead of one.
    renderDialog({
      boards: [column("backlog", "Backlog"), column("doing", "In Progress")],
      sessions: [link("sess_a", "doing")],
    });
    const row = within(dialog()).getByTestId("task-session-row");
    expect(row.textContent).toContain("from In Progress");
    expect(row.textContent).not.toContain("doing");
  });

  it("falls back to the slug when the board slice cannot name that Stage", () => {
    // REGRESSION GUARD — this PASSES before the fix, because the slug fallback is
    // today's behaviour and the fix must not lose it. "We could not name it" is a
    // different claim from "it has no Stage", which is the same argument the header's
    // `stageLabel` carries.
    renderDialog({ sessions: [link("sess_a", "archived-later")] });
    const row = within(dialog()).getByTestId("task-session-row");
    expect(row.textContent).toContain("from archived-later");
  });

  it("a session row with no Stage prints no from-caption", () => {
    // REGRESSION GUARD — passes before the fix. `stageSlug: null` is "this link names no
    // Stage", which is not the same claim as "a Stage we could not name", so printing
    // `from ` with nothing after it would invent a Stage.
    renderDialog({ sessions: [link("sess_a", null)] });
    const row = within(dialog()).getByTestId("task-session-row");
    expect(row.textContent).not.toContain("from ");
  });
});

describe("TaskDetailDialog — the wide two-column shell", () => {
  it("is always sm:max-w-4xl, with or without artifacts", () => {
    const first = renderDialog({ artifactKeys: ["a"] });
    expect(Array.from(dialog().classList)).toContain("sm:max-w-4xl");
    first.unmount();
    renderDialog({ artifactKeys: [] });
    expect(Array.from(dialog().classList)).toContain("sm:max-w-4xl");
    expect(Array.from(dialog().classList)).not.toContain("sm:max-w-2xl");
  });

  it("the active tab wears the brand token; an inactive tab does not", () => {
    renderDialog({ artifactKeys: ["a"] });
    const tabs = within(dialog()).getByTestId("detail-tabs");
    const overview = tabs.querySelector('[data-tab-key="overview"]')!;
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.className).toContain("border-brand");
    const a = tabs.querySelector('[data-tab-key="a"]')!;
    expect(a.getAttribute("aria-selected")).toBe("false");
    expect(a.className).not.toContain("border-brand");
  });

  it("the launch error sits OUTSIDE the scroller and the footer", async () => {
    vi.mocked(startTaskSession).mockRejectedValue(new Error("no provider configured"));
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
    const alert = await within(dialog()).findByRole("alert");
    const scroller = within(dialog()).getByTestId("detail-scroll");
    const footer = dialog().querySelector('[data-slot="dialog-footer"]')!;
    expect(scroller.contains(alert)).toBe(false);
    expect(footer.contains(alert)).toBe(false);
  });

  it("footer edges[0] is the Primary next step (default) and the rest are outline", async () => {
    renderDialog({
      boards: [
        column("backlog", "Backlog", [taskRow()], { nextSlugs: ["discuss", "research"] }),
        column("discuss", "Discuss", [], { sortOrder: 1, onEnterSkill: "discuss" }),
        column("research", "Research", [], { sortOrder: 2, onEnterSkill: "research" }),
      ],
    });
    const discuss = await screen.findByRole("button", { name: "Discuss" });
    const research = await screen.findByRole("button", { name: "Research" });
    expect(discuss.getAttribute("data-variant")).toBe("default");
    expect(research.getAttribute("data-variant")).toBe("outline");
  });

  it("the footer buttons are still the only aria-labelled buttons in the dialog", async () => {
    renderDialog();
    await screen.findByRole("button", { name: "Discuss" });
    const labelled = within(dialog())
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? "")
      .filter((label) => label !== "");
    expect(labelled).toEqual(["Discuss", "Research"]);
  });
});

describe("TaskDetailDialog — the Status row", () => {
  it("shows 'Ready' with the BellRing glyph when a session is marked ready and none is live", () => {
    renderDialog({ sessions: [link("sess_a")], ready: true });
    const status = dialog().querySelector('[data-property="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Ready");
    const glyph = status!.querySelector('[data-testid="property-ready-glyph"]');
    expect(glyph!.getAttribute("class") ?? "").toContain("text-warning");
    expect(status!.querySelector('[data-testid="property-status-mark"]')).toBeNull();
  });

  it("omits the Status row entirely for a stored session with ready=false", () => {
    renderDialog({ sessions: [link("sess_a")], ready: false });
    expect(dialog().querySelector('[data-property="status"]')).toBeNull();
  });
});
