import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTaskFromDraft,
  launchTaskSession,
  resetTaskLaunchInFlight,
  SAVE_ONLY,
  type TaskLaunchCatalogs,
} from "./taskLaunch";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import { useSessions } from "./sessions";
import { useTasks } from "./tasks";
import { resetStores } from "../test/resetStores";
import {
  createTask,
  moveTask,
  sendPrompt,
  startTaskSession,
  type SessionInfo,
  type SkillInfo,
  type StageWithTasks,
  type TaskRow,
} from "../lib/tauri";

/**
 * `src/store/taskLaunch.ts` — the ONE orchestration behind "open this Task as a
 * Session".
 *
 * THE CONTRACT UNDER TEST, in the order the two surfaces need it:
 *  1. a launch STARTS a real Session linked to the card, selects it, and sends ONE
 *     first message built by `lib/taskPrompt` (so the `<task>` block is last and
 *     the `$skill` token was expanded);
 *  2. `research` moves the card to the Research column BEFORE the Session starts,
 *     and only when that column actually exists;
 *  3. a skill the Space's catalog does not have REFUSES the launch, because
 *     `expandMentions` leaves an unmatched token VERBATIM and the model would read
 *     a literal `$discuss` as if it were a skill call;
 *  4. the send settles its turn even when the IPC rejects — an unsettled turn
 *     locks the composer forever;
 *  5. a draft-only create files the card and starts NOTHING.
 *
 * WHY THE BARREL IS MOCKED WITH THE WRAPPER NAMES: the factory spreads
 * `importActual`, so an un-mocked export resolves to the REAL wrapper, which calls
 * `invoke`, which rejects in jsdom (`window.__TAURI_INTERNALS__` is undefined).
 * AGENTS.md's boot-mock trap in its exact shape — the test would then be pinning a
 * rejection instead of the behaviour under test.
 *
 * TWO RESETS, both load-bearing: `resetStores()` (which covers `useTasks`) plus
 * the tasks store's own `reset()`, because `src/test/resetStores.ts` documents that
 * it cannot reach a module-scope `let` and `store/tasks.ts` guards its `load` epoch
 * with exactly one.
 */
const SPACE = "/w/alpha";

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    createTask: vi.fn(),
    moveTask: vi.fn(),
    linkSession: vi.fn(),
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    getBoard: vi.fn(),
    reorderTasks: vi.fn(),
    getTask: vi.fn(),
    editTask: vi.fn(),
    loadHistory: vi.fn(),
  };
});

/** The order a mock was first called in, typed.
 *
 *  `vi.mocked(...)` narrows to a bare `Mock<Procedure>` whose `mock` object does
 *  not expose `invocationCallOrder` in this repo's mock typings, and the casts the
 *  first draft of this file used compiled only by lying about the shape. Reading
 *  `vi.fn().mock.invocationCallOrder` is the documented property, so go through the
 *  `MockInstance` type that actually carries it rather than a hand-written one.
 */
function firstCallOrder(fn: { mock: { invocationCallOrder: number[] } }): number {
  return fn.mock.invocationCallOrder[0]!;
}

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "tsk_1",
    spacePath: SPACE,
    number: 3,
    title: "Wire the board",
    body: "A card needs a detail modal.",
    specPath: null,
    stageSlug: "backlog",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function info(sessionId = "sess_new"): SessionInfo {
  return { sessionId, cwd: SPACE, capabilities: {}, archived: false };
}

function skill(name: string): SkillInfo {
  return {
    name,
    description: `${name} skill`,
    path: `/s/${name}.md`,
    dir: "/s",
    scope: "user",
    // The BODY is what `buildBlock` puts inside the `<skill>` element. A fixture
    // without it would still expand, so a broken expansion could hide behind an
    // empty body — the assertions below look for the element, so keep it real.
    body: `${name.toUpperCase()} BODY`,
    disableModelInvocation: false,
    // Required, not decoration: `SkillsDialog` reads it, and a fixture that omitted
    // it would type-check only behind a cast.
    shadowed: [],
  };
}

/** A column with no cards — the board shape `get_board` publishes.
 *
 *  `onEnterSkill` / `nextSlugs` are REQUIRED on `StageRow` (the Rust reader always
 *  emits both), so every fixture spells them. Both default to `null` = the state a
 *  pre-#179 column is in; a case that launches from a Skill-bearing column passes
 *  `skill`, because that field is now the ONLY thing that decides which Skill a
 *  launch loads (ADR 0098 — the mode table that used to decide it is deleted). */
function column(
  slug: string,
  tasks: TaskRow[] = [],
  over: {
    label?: string;
    sortOrder?: number;
    skill?: string | null;
    nextSlugs?: string[] | null;
    artifactKeys?: string[];
  } = {},
): StageWithTasks {
  return {
    stage: {
      spacePath: SPACE,
      slug,
      label: over.label ?? slug,
      sortOrder: over.sortOrder ?? 0,
      onEnter: "none",
      onEnterSkill: over.skill ?? null,
      nextSlugs: over.nextSlugs ?? null,
    },
    // `artifactKeys: []` is the "card has no artifacts" answer, and it is REQUIRED
    // on the wire type (issue #180) — an optional field would compile against every
    // fixture here and render nothing when real data arrives. The `over.artifactKeys`
    // arm exists for D2's `<artifacts>` threading case, which needs a card the board
    // says HAS documents.
    tasks: tasks.map((task) => ({
      task,
      sessions: [],
      costUsd: null,
      artifactKeys: over.artifactKeys ?? [],
    })),
  };
}

/** The destination Stage a launch is aimed at (issue #179).
 *
 *  Defaults to the seeded `discuss` Stage. A case that means a DIFFERENT column
 *  spells the slug — and the point of the destination shape is that the Skill comes
 *  along with the column rather than from a `switch` on a mode literal, so a case
 *  that cares about the Skill overrides `onEnterSkill`. */
function destination(
  over: Partial<TaskLaunchDestination> = {},
): TaskLaunchDestination {
  return { slug: "discuss", label: "Discuss", onEnterSkill: "discuss", ...over };
}

const CATALOGS = (): TaskLaunchCatalogs => ({
  skills: [skill("discuss"), skill("research")],
  agents: [],
});

function seedBoard(...columns: StageWithTasks[]): void {
  useTasks.setState({ boardsBySpace: { [SPACE]: columns } });
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  // A module-scope Set is not store state, so `resetStores()` cannot reach it —
  // the same limitation `src/test/resetStores.ts` documents for a module `let`.
  resetTaskLaunchInFlight();
  vi.clearAllMocks();
  useSessions.setState({ sessions: [], historySessions: [], archivedSessions: [] });
  vi.mocked(startTaskSession).mockResolvedValue(info());
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
  vi.mocked(createTask).mockResolvedValue(taskRow());
});

describe("taskLaunch — the discuss launch", () => {
  // The destination Stage has to EXIST in the board slice for its Skill to be
  // readable, because since ADR 0098 the Stage row IS where the Skill comes from —
  // the mode table that used to answer "which skill for `discuss`" is deleted. So
  // every case here seeds a `discuss` column carrying `on_enter_skill: "discuss"`;
  // without it the destination resolves Skill-less and the case would be pinning a
  // launch that sends no token at all.
  beforeEach(() => {
    // The card starts in `backlog`, so these cases DO move it into `discuss` — that
    // is the new behaviour, not an accident of the fixture: a Stage-backed launch's
    // destination is a real row the caller chose, so `resolveStage` no longer has a
    // "do not move it" arm for `discuss`. The move is inert here (the mock resolves);
    // the ordering of the move against the start is pinned in the research describe.
    seedBoard(
      column("backlog", [taskRow()]),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
    );
  });

  it("tells the Session which artifact keys the card has", async () => {
    // D2's `<artifacts>` threading. `taskBlock` can render the list, but the keys
    // live on `TaskCardView.artifactKeys` (the board payload) and NOT on the bare
    // `TaskRow` the dialog hands over — so `taskLaunch` has to resolve them from
    // the same `boardsBySpace` slice it already reads for the destination Stage.
    // Without this, the element ships invisible: a card with three documents
    // launches a Session that cannot know any of them exist.
    seedBoard(
      column("backlog", [taskRow()], { artifactKeys: ["research", "spec"] }),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
    );
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain("<artifacts>research, spec</artifacts>");
    // Inside the `<task>` block, before its body — not floating in the head.
    expect(sent.indexOf("<artifacts>")).toBeGreaterThan(
      sent.indexOf("<task "),
    );
    expect(sent.indexOf("<artifacts>")).toBeLessThan(
      sent.indexOf("A card needs a detail modal."),
    );
  });

  it("sends no <artifacts> element for a card the board says has none", async () => {
    // The other half: the store read must not INVENT an empty list into an element.
    // The seeded board's card carries `artifactKeys: []`, and spec §5 is explicit
    // that an empty element asserts something the truth does not support.
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).not.toContain("<artifacts");
  });

  it("sends no <artifacts> element when the board slice was never loaded", async () => {
    // The fresh-draft path reaches `sendLaunchMessage` with a row `create_task`
    // just returned, and an unloaded slice is "never read" — which must NOT become
    // a guess. An absent card in the slice resolves to no keys, i.e. no element.
    useTasks.setState({ boardsBySpace: {} });
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).not.toContain("<artifacts");
  });

  it("starts a linked Session, selects it, and sends ONE first message", async () => {
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());

    // `stageSlug: null` and NOT the card's slug spelled out: the Rust command
    // resolves a null to the card's CURRENT stage, so there is one answer to
    // "which stage was it in when linked" — the value the detail modal read can be
    // stale after another window's drag.
    expect(startTaskSession).toHaveBeenCalledWith(SPACE, "tsk_1", null);
    // `addSession` is the store's own "a Session was started" action: it upserts
    // the row AND selects it, which is what puts the row in the sidebar.
    expect(useSessions.getState().sessions.map((s) => s.sessionId)).toEqual([
      "sess_new",
    ]);
    expect(useSessions.getState().activeSessionId).toBe("sess_new");

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const [sentId, sentText] = vi.mocked(sendPrompt).mock.calls[0]!;
    expect(sentId).toBe("sess_new");
    // The bubble and the wire read ONE string: the store's recorded message is
    // byte-identical to what went on the wire (ADR 0031's content-based dedupe key
    // compares on that content, so a divergence re-imports the turn on reload).
    // The Message shape is `{ kind: "user", text, at }` (`addUserMessage`), so the
    // recorded text is `.text`.
    expect(useSessions.getState().messages["sess_new"]?.[0]).toMatchObject({
      kind: "user",
      text: sentText,
    });
  });

  /// The model-VISIBLE skill is sent as the bare `$discuss` token, NOT inlined.
  ///
  /// The token was always there; what used to ride alongside it was the whole
  /// SKILL.md — 18 KB for `discuss`, 12 KB for `research` — appended by
  /// `expandMentions` at the END of the text, with the `<task>` block concatenated
  /// after it. That shape is what broke the transcript: `MessageBubble` renders via
  /// `splitMentionBlocks`, whose NO-LOSS rule refuses to parse when anything trails
  /// the last block, so it gave up and printed the ENTIRE skill as literal text.
  /// Measured on a real launch message: 0 blocks collapsed, 18,076 of 18,076
  /// characters rendered raw, in the user's own bubble.
  ///
  /// The model loads it itself instead: the system prompt's `<available_skills>`
  /// section already tells it to `read_skill` BY NAME. The instruction sentence is
  /// now built from the destination Stage's LABEL (spec §6.1), so the trigger phrase
  /// is whatever that Stage's description advertises rather than a hardcoded line.
  it("sends a visible skill as the bare token and inlines no body", async () => {
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain("$discuss");
    expect(sent).not.toContain("<skill");
    expect(sent).not.toContain("DISCUSS BODY");
    expect(sent.trimEnd().endsWith("</task>")).toBe(true);
    expect(sent).toContain('id="tsk_1"');
    // The instruction line survives, and it names the DESTINATION Stage rather than
    // a per-mode constant: the sentence is `Let's work on <label>.`.
    expect(sent).toContain("Let's work on Discuss.");
  });

  /// The exception, and it is a documented behaviour rather than a leftover:
  /// `read_skill` REFUSES a `disable-model-invocation` skill ("the Agent may not
  /// load it"), so for a hidden skill the token route would open a Session with no
  /// methodology and no error — a confident, well-formed nothing. Client-side
  /// inlining is the ONLY thing that reaches those, which is what `missingSkill`'s
  /// comment means by "a `$name` Mention reaches it … which is exactly this path".
  /// So inlining survives for exactly this case.
  it("still inlines the body for a skill the model is refused", async () => {
    const hidden = CATALOGS();
    hidden.skills = hidden.skills.map((k) =>
      k.name === "discuss" ? { ...k, disableModelInvocation: true } : k,
    );
    await launchTaskSession(SPACE, taskRow(), "discuss", hidden);
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain('<skill name="discuss"');
    expect(sent).toContain("DISCUSS BODY");
    expect(sent).toContain("$discuss");
  });

  /// A send failure must NOT vanish behind the navigation.
  ///
  /// The launch no longer awaits the turn (see `sendLaunchMessage`), so the dialog
  /// that used to render a rejection through `describeIpcError` is already closed.
  /// Dropping the rejection there would be this repo's silent-green shape: the user
  /// sees their own message in a fresh transcript and no hint that it never reached
  /// the model. So the failure lands as a line IN THAT TRANSCRIPT — the existing
  /// `addSystemLine` surface, which is how the composer reports a command it could
  /// not run — and the turn still settles.
  it("reports a failed first send inside the session it failed in", async () => {
    vi.mocked(sendPrompt).mockRejectedValue(new Error("session is not live"));
    const launched = await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    // The launch itself SUCCEEDS — the Session exists, the navigation is correct,
    // and a rejection here would strand the user on the board with a dead Session.
    expect(launched.sessionId).toBe("sess_new");
    await vi.waitFor(() => {
      const lines = useSessions.getState().messages["sess_new"] ?? [];
      expect(lines.some((m) => m.kind === "agent-text" && /session is not live/.test((m as { text: string }).text))).toBe(true);
    });
    expect(useSessions.getState().inTurn["sess_new"]).toBeFalsy();
  });

  it("settles the turn on success, so the composer is not left locked", async () => {
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    expect(useSessions.getState().inTurn["sess_new"]).toBeFalsy();
  });

  it("settles the turn when the SEND rejects — a stuck turn locks the session forever", async () => {
    vi.mocked(sendPrompt).mockRejectedValue(new Error("provider is down"));
    // The launch RESOLVES. It no longer awaits the turn (see `sendLaunchMessage`),
    // so there is no rejection left to propagate — the report moved into the
    // transcript, pinned by the case above. What this case still owns is the
    // `inTurn` settle, and it now needs a microtask flush because the settle happens
    // on a promise nothing awaits.
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    await vi.waitFor(() =>
      expect(useSessions.getState().inTurn["sess_new"]).toBeFalsy(),
    );
    // The user's message stays recorded — it was recorded at commit, not at settle,
    // so a failed send must not resurrect it into the composer. The notice line is
    // the SECOND row, so the prompt row is still there beneath it.
    const rows = useSessions.getState().messages["sess_new"] ?? [];
    expect(rows[0]?.kind).toBe("user");
    expect(rows).toHaveLength(2);
  });

  it("does not start a Session when the start itself fails", async () => {
    vi.mocked(startTaskSession).mockRejectedValue(new Error("no provider"));
    await expect(
      launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS()),
    ).rejects.toThrow("no provider");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions).toHaveLength(0);
  });

  it("refuses when the catalog has no such skill, rather than sending a literal $token", async () => {
    // `expandMentions` leaves an UNMATCHED token byte-identical, so an un-cataloged
    // name ships the literal `$discuss` to the model — a confident, well-formed
    // nothing. This is the same reason `NewTaskDialog`'s dropdown only offers names
    // the catalog actually has.
    await expect(
      launchTaskSession(
        SPACE,
        taskRow(),
        "discuss",
        { skills: [skill("research")], agents: [] },
      ),
    ).rejects.toThrow(/discuss/);
    expect(startTaskSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});

describe("taskLaunch — the research launch (the column transition)", () => {
  it("moves the card to research BEFORE the Session starts", async () => {
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], { label: "Research", skill: "research" }),
    );
    await launchTaskSession(SPACE, taskRow(), "research", CATALOGS());
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "research");
    // ORDER IS LOAD-BEARING, not stylistic. The link records the stage the card is
    // in when linked, and that stage is what a later drag into a `compact` column
    // compacts FROM. Start first and the anchor is `backlog` for a Session that
    // only ever worked in `research`.
    expect(firstCallOrder(vi.mocked(moveTask))).toBeLessThan(
      firstCallOrder(vi.mocked(startTaskSession)),
    );
  });

  it("sends the skill block for research, not for discuss", async () => {
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], { label: "Research", skill: "research" }),
    );
    await launchTaskSession(SPACE, taskRow(), "research", CATALOGS());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain("$research");
    expect(sent).not.toContain("$discuss");
    expect(sent).not.toContain("<skill");
  });

  it("refuses with the name the DESTINATION row carries, not a hardcoded one", async () => {
    // THE ADR 0098 PIN for `missingSkill`. The refusal used to be able to name the
    // skill from a `switch`, because there were exactly three answers. Now a Space
    // can configure ANY Skill on a column, so the sentence must name the row's own
    // `on_enter_skill` — both halves matter, and each catches a different regression:
    //  - a refusal that names the WRONG skill sends the operator to install something
    //    that is already installed;
    //  - a refusal that fires for a skill the catalog DOES have is a launch that
    //    cannot be made to work at all on a Space that renamed nothing but its skills.
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], { label: "Research", skill: "ml-research" }),
    );
    // The row asks for `ml-research`, the catalog has `discuss` and `research` only.
    await expect(
      launchTaskSession(SPACE, taskRow(), "research", CATALOGS()),
    ).rejects.toThrow(/ml-research/);
    expect(startTaskSession).not.toHaveBeenCalled();
    // The other half: the SAME column against a catalog that DOES carry its own
    // skill launches — and does not refuse because `discuss` is missing from it.
    await launchTaskSession(SPACE, taskRow(), "research", {
      skills: [skill("ml-research")],
      agents: [],
    });
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPrompt).mock.calls[0]![1]).toContain("$ml-research");
  });

  it("does NOT move the card when the Space has no research column", async () => {
    // A slug the Space does not own is REFUSED by Rust and names the valid slugs
    // back (ADR 0090). Firing it anyway would land an error line under a click
    // whose job was to open a Session — so the board is consulted first and the
    // launch proceeds WITHOUT the move, reporting the skip.
    //
    // The `absent` arm survives ADR 0098 for exactly this shape: the destination
    // slug was asked for and the loaded slice has no such row.
    seedBoard(column("backlog", [taskRow()]), column("doing"));
    const outcome = await launchTaskSession(
      SPACE,
      taskRow(),
      "research",
      CATALOGS(),
    );
    expect(moveTask).not.toHaveBeenCalled();
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    expect(outcome.note).toContain("research");
    expect(outcome.sessionId).toBe("sess_new");
  });

  it("does NOT move a card that is already in research", async () => {
    // `moveTask` is optimistic and its own guard drops a same-column move silently,
    // so a call here would be an IPC that provably does nothing.
    seedBoard(
      column("research", [taskRow({ stageSlug: "research" })], {
        label: "Research",
        skill: "research",
      }),
    );
    const outcome = await launchTaskSession(
      SPACE,
      taskRow({ stageSlug: "research" }),
      "research",
      CATALOGS(),
    );
    expect(moveTask).not.toHaveBeenCalled();
    expect(outcome.note).toBeNull();
  });

  it("says nothing when the move was performed", async () => {
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], { label: "Research", skill: "research" }),
    );
    const outcome = await launchTaskSession(
      SPACE,
      taskRow(),
      "research",
      CATALOGS(),
    );
    expect(outcome.note).toBeNull();
  });

  it("still reports the skipped column when the board was never loaded", async () => {
    // `boardsBySpace` absent is "never loaded", NOT "no columns". Both mean we
    // cannot prove a `research` column exists, and guessing wrong is a refused
    // write — so the honest answer is "no move", with the note.
    const outcome = await launchTaskSession(
      SPACE,
      taskRow(),
      "research",
      CATALOGS(),
    );
    expect(moveTask).not.toHaveBeenCalled();
    expect(outcome.note).toContain("research");
    expect(startTaskSession).toHaveBeenCalledTimes(1);
  });
});

describe("taskLaunch — the draft create (the New Task modal)", () => {
  // The draft board the shipped buttons file into: `backlog` saves, `discuss` and
  // `research` save AND launch, and each carries the Skill its own row names
  // (ADR 0098). A case that means a DIFFERENT board overrides `seedBoard` itself.
  const seedCreateBoard = (): void => {
    seedBoard(
      column("backlog", [], { label: "Backlog" }),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
      column("research", [], { label: "Research", skill: "research" }),
    );
  };

  it("files the card in backlog and starts NOTHING for the backlog button", async () => {
    seedCreateBoard();
    const created = await createTaskFromDraft(
      SPACE,
      "Wire the board",
      "It needs a detail modal.",
      SAVE_ONLY,
      CATALOGS(),
    );
    expect(createTask).toHaveBeenCalledWith(
      SPACE,
      "Wire the board",
      "It needs a detail modal.",
      "backlog",
    );
    // THE POINT OF THE CHANGE: no LLM at creation time. Nothing is started and
    // nothing is sent.
    expect(startTaskSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(created.task.id).toBe("tsk_1");
    expect(created.sessionId).toBeNull();
  });

  it("lands the new card in the board the human is looking at", async () => {
    seedCreateBoard();
    await createTaskFromDraft(SPACE, "Wire the board", null, SAVE_ONLY, CATALOGS());
    expect(
      useTasks.getState().boardsBySpace[SPACE]?.find((c) => c.stage.slug === "backlog")
        ?.tasks.map((t) => t.task.id),
    ).toEqual(["tsk_1"]);
  });

  it("creates the card BEFORE the Session is started for discuss", async () => {
    seedCreateBoard();
    await createTaskFromDraft(SPACE, "Wire the board", null, destination(), CATALOGS());
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    // `task_sessions.task_id` carries NO foreign key (ADR 0090), so the Rust
    // command gates the link on a `get_task` existence check: start first and the
    // link is refused, leaving a live orphan and a card with no Session.
    expect(firstCallOrder(vi.mocked(createTask))).toBeLessThan(
      firstCallOrder(vi.mocked(startTaskSession)),
    );
  });

  it("files a research create in the research column, in one write", async () => {
    seedCreateBoard();
    await createTaskFromDraft(
      SPACE,
      "Wire the board",
      null,
      destination({ slug: "research", label: "Research", onEnterSkill: "research" }),
      CATALOGS(),
    );
    // `create_task` takes the stage directly, so a create-then-move would be two
    // writes for one fact — and the move's `on_enter` would fire for a card that
    // was never anywhere else.
    expect(createTask).toHaveBeenCalledWith(
      SPACE,
      "Wire the board",
      null,
      "research",
    );
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("falls back to the board's first column when the wanted column is absent", async () => {
    // A card filed under a slug the Space does not have is INVISIBLE on the board
    // (ADR 0090 refuses it), so the fallback keeps the card reachable. The
    // `createTask` store action surfaces the refusal as an error, so falling back
    // is the only path that does not lose the user's text.
    seedBoard(column("inbox"), column("doing"));
    await createTaskFromDraft(
      SPACE,
      "Wire the board",
      null,
      destination({ slug: "research", label: "Research", onEnterSkill: "research" }),
      CATALOGS(),
    );
    expect(createTask).toHaveBeenCalledWith(
      SPACE,
      "Wire the board",
      null,
      "inbox",
    );
  });

  it("a destination with no Skill launches and sends no token", async () => {
    // The `onEnterSkill: null` arm of the destination, on the CREATE path. A Stage
    // that loads nothing is a legal destination (spec §7.1: moving a card is still
    // useful with nothing to load), so the launch must start a Session and must NOT
    // put a bare `$` — or any token — in its first message. A `switch`-shaped
    // implementation could only reach this by giving every mode a skill.
    seedBoard(
      column("backlog"),
      column("review", [], { label: "Review", skill: null }),
    );
    await createTaskFromDraft(
      SPACE,
      "Wire the board",
      null,
      destination({ slug: "review", label: "Review", onEnterSkill: null }),
      CATALOGS(),
    );
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain("<task ");
    expect(sent).not.toContain("$");
    // And the sentence still names the destination, so the message is not just a
    // bare XML block.
    expect(sent).toContain("Let's work on Review.");
  });

  it("refuses a blank TITLE without calling the IPC", async () => {
    seedBoard(column("backlog"));
    // The title field is what gates the create. A blank title is refused HERE rather
    // than paid for with an IPC round trip whose sentence says the same thing.
    await expect(
      createTaskFromDraft(SPACE, "   ", null, SAVE_ONLY, CATALOGS()),
    ).rejects.toThrow(/title/i);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("passes the two fields through as the two COLUMNS", async () => {
    seedBoard(column("backlog"));
    await createTaskFromDraft(
      SPACE,
      "Default action for notifications",
      "Clicking one should focus the window\nand open the session that raised it.",
      SAVE_ONLY,
      CATALOGS(),
    );
    expect(createTask).toHaveBeenCalledWith(
      SPACE,
      "Default action for notifications",
      "Clicking one should focus the window\nand open the session that raised it.",
      "backlog",
    );
  });

  it("sends no body when the body field is blank", async () => {
    seedBoard(column("backlog"));
    // Whitespace-only is ABSENT, not a body of spaces: `tasks.body` is nullable and a
    // card whose body is three spaces renders as an empty paragraph in the detail
    // dialog, which reads as a broken card rather than a body-less one.
    await createTaskFromDraft(SPACE, "Just a title", "   \n  ", SAVE_ONLY, CATALOGS());
    expect(createTask).toHaveBeenCalledWith(SPACE, "Just a title", null, "backlog");
  });

  it("a body never becomes the title, whatever it contains", async () => {
    // The rule this replaces was "line 0 of one textarea is the title", so a paste
    // whose first line was prose silently invented a heading from it. With two fields
    // a blank title is refused even when the body is full — the body is never a
    // fallback, because guessing at a heading is exactly what the user objected to.
    seedBoard(column("backlog"));
    await expect(
      createTaskFromDraft(SPACE, "", "A long explanation with\nseveral lines.", SAVE_ONLY, CATALOGS()),
    ).rejects.toThrow(/title/i);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("launches with the row the SERVER returned, not the text it was given", async () => {
    // `clean_title` runs server-side (whitespace collapse, one quote layer
    // stripped, multi-byte-safe cap) and the STORED title is what the `<task>` block
    // must carry — a block quoting a title that was never stored is a small lie on
    // the wire.
    vi.mocked(createTask).mockResolvedValue(
      taskRow({ title: "Cleaned title", stageSlug: "backlog" }),
    );
    seedCreateBoard();
    await createTaskFromDraft(
      SPACE,
      '"Cleaned title with quotes"',
      null,
      destination(),
      CATALOGS(),
    );
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent).toContain('title="Cleaned title"');
    expect(sent).not.toContain("quotes");
  });

  it("does not launch a Session when the create is refused", async () => {
    seedBoard(column("backlog"));
    vi.mocked(createTask).mockRejectedValue(
      Object.assign(new Error("empty"), { kind: "empty_title" }),
    );
    await expect(
      createTaskFromDraft(SPACE, "Whatever", null, destination(), CATALOGS()),
    ).rejects.toThrow();
    expect(startTaskSession).not.toHaveBeenCalled();
  });
});

describe("taskLaunch — re-entrancy", () => {
  it("a second launch while one is in flight does not start a second Session", async () => {
    // A double click on Research would otherwise start TWO Sessions and link both,
    // and the FIRST link wins per (task, session) so the card would show two
    // Sessions for one intent. `useAsyncAction`'s `guard` reads RENDERED state and
    // so cannot catch two clicks in one batch — hence an in-flight ref here.
    // The resolver is captured in a one-slot box rather than a bare `let`: TS's
    // control-flow analysis narrows a `let` assigned only inside a callback to
    // `never` at the call site, and the deferred `new Promise` executor is exactly
    // that shape.
    const slots: { resolve?: (v: SessionInfo) => void } = {};
    vi.mocked(startTaskSession).mockReturnValue(
      new Promise<SessionInfo>((resolve) => {
        slots.resolve = resolve;
      }),
    );
    const first = launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    const second = launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    slots.resolve?.(info());
    const [a, b] = await Promise.all([first, second]);
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    // The refused click resolves rather than throwing — a button that throws at a
    // double click surfaces an error line for a click the user made once.
    expect(b.sessionId).toBeNull();
    expect(a.sessionId).toBe("sess_new");
  });

  it("releases the guard after a FAILURE, so a retry is possible", async () => {
    // A guard that stayed set on rejection turns one transient error into a card
    // that can never be opened again without a reload.
    vi.mocked(startTaskSession)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(info());
    await expect(
      launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS()),
    ).rejects.toThrow("transient");
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    expect(startTaskSession).toHaveBeenCalledTimes(2);
  });
});
