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
  getTask,
  moveTask,
  sendPrompt,
  startTaskSession,
  taskNumbers,
  workflowAdvanceAdvice,
  workflowRunClose,
  type AdvanceAdvice,
  type SessionInfo,
  type SkillInfo,
  type StageWithTasks,
  type StopReason,
  type TaskNumberRow,
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
 *
 * THE CLAIM PATH IS NOT HERE. `consumeAdvanceAdvice` / `carryOutClaim` — the
 * `App.tsx`-batcher entry point, a SECOND subject than the click-driven launch — live
 * in the ADR 0113 mirror sibling `taskLaunch.claim.test.ts`. They moved there when this
 * file reached 998 code lines against ADR 0112's 1,000-line test gate; the move was
 * verbatim (leaf-name diff, loss = 0), so nothing was added to it and nothing was taken
 * from it.
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
    editTask: vi.fn(),
    loadHistory: vi.fn(),
    // The auto-advance chain's DECIDER and RUN RECORD. Mocked for the same boot-mock
    // reason as every name in this factory, and the DEFAULT below is what keeps the 39
    // cases above untouched: the decider answers `unclaimed`, which is what Rust answers
    // for a Session that never called `mark_done`, so nothing launches and no run closes.
    // That is the compatibility story of D4 (an un-claimed settle never moves a card)
    // observed at the seam that would otherwise change every launch's behaviour.
    // (`workflowRunStep` is GONE from this list: the runtime no longer calls it — the
    // advice counts the step inside Rust.)
    workflowAdvanceAdvice: vi.fn(),
    getTask: vi.fn().mockResolvedValue(null),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    workflowRunClose: vi.fn().mockResolvedValue(undefined),
    // The **Task badge** map's boot fetch, which `startAndSendLinked` re-calls after
    // a launch (D10). It MUST be mocked here for the reason this file's header
    // records and AGENTS.md records for `App.test.tsx`: the factory spreads
    // `importActual`, so an un-mocked `taskNumbers` resolves to the REAL wrapper,
    // which calls `invoke` and rejects outside a webview — every launch case in this
    // file would then be pinning a rejection it cannot see.
    taskNumbers: vi.fn().mockResolvedValue([]),
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
 *  `onEnterSkill` / `nextSlugs` are REQUIRED on `StageDto` (the Rust reader always
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
    prefix?: string | null;
    /** The column's **auto-advance** flag. Defaults to `false`, which is the stored
     *  default and what every fixture above uses — the ones that do not pass it are
     *  asserting the compatibility story (`auto` OFF means the chain never starts). */
    auto?: boolean;
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
      // Both REQUIRED on the wire type since the workflow-graph columns landed
      // (`stages.auto` is `NOT NULL DEFAULT 0`; `promptPrefix` has no SQL DEFAULT and
      // NULL is its only "no extra prompt" state), so a fixture that omits either is
      // a board the database cannot answer with. OFF + `null` is what every existing
      // column carries, which is also the compatibility story: adding the capability
      // must not make an existing board advance anything.
      auto: over.auto ?? false,
      // `over.prefix` exists for the extra-prompt cases below: the column's
      // `prompt_prefix` is what has to REACH the message, so a fixture that could
      // only ever say `null` could not test the feature at all.
      promptPrefix: over.prefix ?? null,
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
      // REQUIRED wire field: the board computes `ready` as an OR over the linked
      // Sessions' `sessions.ready` column, and a fixture with no links has no claim.
      ready: false,
      readySessions: [],
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
  // `promptPrefix: null` because the field is REQUIRED (the `StageDto.auto` argument:
  // an optional field compiles against a fixture and then renders nothing on real
  // data). `null` is the state every existing column holds, so a case that means a
  // prefix-bearing column passes `promptPrefix` the way it passes `onEnterSkill`.
  return {
    slug: "discuss",
    label: "Discuss",
    onEnterSkill: "discuss",
    promptPrefix: null,
    ...over,
  };
}

/** A refusal, spelled through the nine wire keys `shape.rs` pins.
 *
 *  The default for EVERY case in this file: an ordinary launch's Session never called
 *  `mark_done`, so Rust answers `unclaimed` and the chain does nothing. That is D4, and
 *  it is what keeps the 39 cases above untouched — the settle edge fires, asks, and is
 *  told to stay out of the way.
 *
 *  `workflowChain.test.ts` owns what the runtime does with each arm; this file needs only
 *  the refusal (the default) and the advancing one (the chain describe below). */
function refusal(reason: string, over: Partial<AdvanceAdvice> = {}): AdvanceAdvice {
  return {
    advance: false,
    stop: null,
    destination: null,
    reason,
    maxSteps: 20,
    ceilingUsd: 10,
    taskId: "tsk_1",
    spacePath: SPACE,
    alreadyLaunched: false,
    ...over,
  };
}

const UNCLAIMED: AdvanceAdvice = refusal("unclaimed");

/** The "advance into `implement`" advice, the destination row carried WHOLE so the launch
 *  needs no board slice for the Skill or the prose (D19). */
function advancing(over: Partial<AdvanceAdvice> = {}): AdvanceAdvice {
  return refusal("advanced", {
    advance: true,
    destination: {
      spacePath: SPACE,
      slug: "implement",
      label: "Implement",
      sortOrder: 2,
      onEnter: "none",
      onEnterSkill: "implement",
      nextSlugs: null,
      auto: false,
      promptPrefix: null,
    },
    ...over,
  });
}

/** Make the decider answer `next` for the FIRST Session that asks and `UNCLAIMED`
 *  afterwards. Same shape as `workflowChain.test.ts`'s mock: a real chain ASKS AGAIN once
 *  its own launched turn settles, and Rust's `task_sessions` dedupe answers that second ask
 *  `already_advanced`. A constant here would model a decider with no dedupe and send every
 *  real-launch case into an unbounded chain. */
function answerOnce(next: AdvanceAdvice): void {
  let asked = false;
  vi.mocked(workflowAdvanceAdvice).mockImplementation(async () => {
    if (asked) return UNCLAIMED;
    asked = true;
    return next;
  });
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
  // Restated after `clearAllMocks` for the same reason `deleteSession`'s default is
  // restated in `SessionsSection.test.tsx`: a case that installed a one-shot
  // rejection below must not be able to decide what THIS case's refetch answers.
  vi.mocked(taskNumbers).mockResolvedValue([]);
  // Restated after `clearAllMocks` for the same reason as the three above it: a case
  // that installed a one-shot below must not decide what THIS case's decider answers.
  vi.mocked(workflowAdvanceAdvice).mockResolvedValue(UNCLAIMED);
  vi.mocked(getTask).mockResolvedValue(taskRow());
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

  it("sends the destination column's extra prompt FIRST in the message", async () => {
    // The whole point of `stages.prompt_prefix`: T3 put an editable field on every
    // Stage row and NOTHING read it, so the control wrote into the void. This is the
    // seam where the column's text becomes the Session's first message — the board
    // slice read `launchTaskSession` already does for the label and the Skill now
    // carries one more field of the SAME row into the prompt.
    //
    // Position matters as much as presence: the design is "1 Skill per column, PLUS a
    // per-column extra-prompt field prepended **before the Skill launch**", so the
    // prefix precedes the instruction, which precedes the token.
    seedBoard(
      column("backlog", [taskRow()]),
      column("discuss", [], {
        label: "Discuss",
        skill: "discuss",
        prefix: "Weigh the trade-offs out loud before proposing anything.",
      }),
    );
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent.indexOf("Weigh the trade-offs out loud")).toBe(0);
    expect(sent.indexOf("Weigh the trade-offs out loud")).toBeLessThan(
      sent.indexOf("Let's work on Discuss."),
    );
    expect(sent.indexOf("Let's work on Discuss.")).toBeLessThan(
      sent.indexOf("$discuss"),
    );
    expect(sent.indexOf("$discuss")).toBeLessThan(sent.indexOf("<task "));
    // The bubble and the wire are still ONE string (ADR 0031's content-based dedupe
    // key): the prefix is part of the recorded message, not of something before it.
    expect(useSessions.getState().messages["sess_new"]?.[0]).toMatchObject({
      kind: "user",
      text: sent,
    });
  });

  it("sends no extra prompt for a column that has none", async () => {
    // The other half, and the common one: `prompt_prefix` carries no SQL `DEFAULT`,
    // so every column an existing install already has reads back NULL. A launch from
    // such a column must produce the message this feature did not exist for, byte for
    // byte — the describe's `seedBoard` gives `discuss` no prefix, so this asserts the
    // leading bytes against a literal rather than against another call.
    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
    expect(sent.startsWith("Let's work on Discuss.\n\n$discuss\n\n<task ")).toBe(
      true,
    );
    // And the absent prefix contributed NOTHING — not the word, not the value.
    expect(sent).not.toContain("undefined");
    expect(sent).not.toContain("null");
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
    // The card's context closes the message and nothing follows it. This reads
    // `endsWith("</task>")` again — the shape it had before the ready trailer
    // existed, restored with the trailer. What it carries is the ORDER, which is
    // what a launch-path test can see; the injection property it used to be
    // mistaken for is a claim about the expander's argument and is pinned at
    // `lib/taskPrompt.test.ts`.
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

  it("issues no move for a card already in the destination column when NO slice is loaded", async () => {
    // F5. The same-column guard used to sit PAST the `columns === undefined` early
    // return, so the slice-free (trusted) arm asked for a move even when the card was
    // already exactly where the chain wanted it. `Db::move_task` never lists a column's
    // own slug in its own `next_slugs`, so under `board_strict = 1` that write is
    // REFUSED — and a refusal out of the slice-free arm is a `null`, which
    // `launchTaskSession` turns into a throw and the chain into `launch_refused` on a
    // card already sitting in the destination. A no-op has to be a no-op: no `move_task`,
    // no note, and the Session starts.
    //
    // The guard belongs in `resolveStage` and not in `taskMove.moveWithoutBoard`: the
    // slice-free verb holds only the slug it was asked to move TO, so only the caller
    // that holds the `TaskRow` can know where the card already is.
    const outcome = await launchTaskSession(
      SPACE,
      taskRow({ stageSlug: "research" }),
      destination({ slug: "research", label: "Research", onEnterSkill: "research" }),
      CATALOGS(),
    );
    expect(moveTask).not.toHaveBeenCalled();
    expect(outcome.note).toBeNull();
    expect(outcome.sessionId).toBe("sess_new");
  });

  it("keeps the note for a loaded slice that lacks the column, even when the stored slug already matches", async () => {
    // THE ORDER, pinned. `resolveStage`'s loaded arm checks STALE FIRST
    // (`!columns.some(...)`) and the same-slug guard SECOND, and its own comment asserts
    // why: a LOADED slice that does not carry the column is a slice this window can
    // positively see is out of date, and that reading must survive the coincidence that
    // the card's stored slug names the same column. Swap the two checks and this case is
    // the one that reddens — the same-slug guard would answer `{ slug: null }` with no
    // `absent`, and the note disappears.
    //
    // The note is not decoration: `TaskDetailDialog` renders it, and
    // `workflowChain.finishLink` records the launch as `launch_refused` from it. Dropping
    // it tells a person the card is where they wanted it on the strength of a stored slug
    // the board on screen contradicts — the slice is the fresher read, and a stale slice
    // is never trusted (the F5 slice-free arm above is the ONLY arm with nothing to
    // contradict, which is why the guard is gated on `trusted` there and not lifted here).
    seedBoard(column("backlog", []), column("doing", []));
    const outcome = await launchTaskSession(
      SPACE,
      taskRow({ stageSlug: "research" }),
      destination({ slug: "research", label: "Research", onEnterSkill: "research" }),
      CATALOGS(),
    );
    // The note is SAID, and it names the column the slice lacks.
    expect(outcome.note).not.toBeNull();
    expect(outcome.note).toContain("research");
    // And no write was attempted — `absent` means "this window cannot prove the column
    // exists", and guessing is a refused write under `board_strict`.
    expect(moveTask).not.toHaveBeenCalled();
    // The Session still starts (a skipped move is not a refused launch).
    expect(outcome.sessionId).toBe("sess_new");
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

  it("a settle landing BEFORE the badge refetch returns does not refuse the chain", async () => {
    // THE GUARD OUTLIVED ITS JOB. `inFlight.delete(task.id)` sat in `launchTaskSession`'s
    // `finally`, i.e. AFTER `startAndSendLinked` resolved — and that helper awaits
    // `refreshTaskNumbers()` after `void sendLaunchMessage(…)`. The chain's next launch is
    // dispatched from the `void`ed call's settle edge, so a turn that settled before the
    // badge refetch came back found the chain's OWN PARENT still holding the key, and
    // `launchTaskSession` answered `{ sessionId: null }`. `finishLink` then closed the run
    // `launch_refused` with "it was already being launched" — a false statement about a
    // benign ordering, and indistinguishable from a real double-click refusal.
    //
    // Both halves are manufactured here by hand, because every mock in this repo resolves
    // synchronously and a synchronous `sendPrompt` manufactures the very ordering the guard
    // must survive: `sendPrompt` is deferred (so the settle is dispatched while the parent
    // is still inside `startAndSendLinked`) and `taskNumbers` is held open (so the parent
    // has NOT returned when that settle runs).
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], {
        label: "Research",
        sortOrder: 1,
        skill: "research",
        auto: true,
      }),
      column("implement", [], {
        label: "Implement",
        sortOrder: 2,
        skill: "implement",
      }),
    );
    const slots: {
      settle?: (reason: StopReason) => void;
      badges?: (rows: TaskNumberRow[]) => void;
    } = {};
    // The chain only moves if the decider says advance.
    answerOnce(advancing());
    vi.mocked(sendPrompt).mockImplementation(
      () => new Promise<StopReason>((resolve) => (slots.settle = resolve)),
    );
    vi.mocked(taskNumbers).mockReturnValue(
      new Promise<TaskNumberRow[]>((resolve) => (slots.badges = resolve)),
    );

    const launched = launchTaskSession(SPACE, taskRow(), "research", {
      // The chain's NEXT column asks for `implement`, so this case names both Skills
      // itself rather than leaning on the shared `CATALOGS()` (which deliberately has only
      // `discuss` and `research`, because several of its cases pin a missing-Skill refusal).
      skills: [skill("research"), skill("implement")],
      agents: [],
    });
    // The parent is now parked on the badge refetch: the prompt is dispatched, the Session
    // exists, the guard is (still, at this instant) held.
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    // The turn settles while the parent has not returned.
    slots.settle?.("end_turn");
    // The chain reaches its own next launch — moved by the CHAIN, not by this call, so
    // flush rather than await.
    await vi.waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement"),
    );
    // THE FACT UNDER TEST: the chain's launch was not refused by its own parent, so the
    // run is not closed `launch_refused` and the chain's prompt goes out.
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(vi.mocked(sendPrompt).mock.calls[1]![1]).toContain("$implement");
    expect(workflowRunClose).not.toHaveBeenCalledWith("tsk_1", "launch_refused");
    expect(
      (useSessions.getState().messages["sess_new"] ?? []).some((m) =>
        /launch_refused/.test((m as { text: string }).text ?? ""),
      ),
    ).toBe(false);

    slots.badges?.([]);
    expect((await launched).sessionId).toBe("sess_new");
  });

  it("does not let the PARENT's cleanup clear the guard the CHAIN'S launch holds", async () => {
    // The other half of releasing the guard early. The parent releases at the dispatch
    // and its `finally` still runs afterwards (once the badge refetch lands), so the
    // release is ONE-SHOT: without the flag the parent's `finally` would delete a key a
    // SECOND launch had legitimately taken in the meantime — and that is exactly the
    // chain's ordering, since the chain's launch of the SAME card starts the instant the
    // parent releases. Deleting a key you no longer hold turns the guard back into a
    // hole, and the hole is a double Session for one intent: the thing the `Set` exists
    // for. The case above pins the opposite error (holding too LONG); this pins the
    // guard surviving the parent's cleanup while a legitimate owner holds it.
    //
    // THE WINDOW IS THE CHAIN'S OWN `startTaskSession`, and BOTH halves have to be held
    // open by hand: the parent parked on its badge refetch (call 1), the chain parked
    // inside its Session start (call 2). That is the only stretch where the chain owns
    // the key AND the parent's `finally` still has an await left to run — release the
    // refetch there and the parent's cleanup fires while the chain is the owner.
    // (Holding only one of the two does not work, and the first draft of this case got
    // that wrong: if the parent's refetch resolves on its own, its `finally` runs BEFORE
    // the chain ever acquires the key, so the one-shot flag changes nothing and the
    // mutant stays green.)
    //
    // This case also seeds its OWN board: the describe it sits in (`re-entrancy`) has no
    // board `beforeEach`, and an unseeded slice would make `resolveStage` answer
    // `absent`, skip the move, and leave the chain with nothing to launch.
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], {
        label: "Research",
        sortOrder: 1,
        skill: "research",
        auto: true,
      }),
      column("implement", [], {
        label: "Implement",
        sortOrder: 2,
        skill: "implement",
      }),
    );
    const slots: { settle?: (reason: StopReason) => void; badges?: () => void } = {};
    let starts = 0;
    answerOnce(advancing());
    vi.mocked(sendPrompt).mockImplementation(
      () => new Promise<StopReason>((resolve) => (slots.settle = resolve)),
    );
    vi.mocked(startTaskSession).mockImplementation(() => {
      starts += 1;
      // The PARENT's start (1) resolves; the CHAIN's (2) never does, which is what keeps
      // the chain inside the guarded half. A THIRD start — which only the mutant reaches
      // — resolves with its own id, so the mutant fails the assertion below instead of
      // hanging on a promise nobody resolves.
      if (starts === 2) return new Promise<SessionInfo>(() => {});
      return Promise.resolve(info(starts === 1 ? "sess_new" : "sess_third"));
    });
    let refetches = 0;
    vi.mocked(taskNumbers).mockImplementation(() => {
      refetches += 1;
      // The PARENT's badge refetch (call 1) is releasable, so its `finally` can be made
      // to land inside the window; the CHAIN's (call 2) is never reached and never needs
      // to be.
      if (refetches === 1) {
        return new Promise<TaskNumberRow[]>((resolve) => {
          slots.badges = () => resolve([]);
        });
      }
      return Promise.resolve<TaskNumberRow[]>([]);
    });

    const chainCatalogs = (): TaskLaunchCatalogs => ({
      skills: [skill("research"), skill("implement")],
      agents: [],
    });
    const parent = launchTaskSession(SPACE, taskRow(), "research", chainCatalogs());
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    slots.settle?.("end_turn");
    // The chain has taken the card's key and is parked inside its own Session start.
    await vi.waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement"),
    );
    await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(2));
    // NOW the parent's badge refetch lands, so its `finally` runs while the CHAIN is the
    // guard's owner — and must not clear a key it no longer holds.
    slots.badges?.();
    await parent;
    // A launch of the same card while the chain still owns the guard is refused rather
    // than starting a SECOND Session for one intent.
    const third = await launchTaskSession(SPACE, taskRow(), "implement", chainCatalogs());
    expect(third.sessionId).toBeNull();
    expect(startTaskSession).toHaveBeenCalledTimes(2);
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

describe("taskLaunch — the Task badge map refetch after a launch (D10)", () => {
  // The badge map is BOOT-fetched, so the link `startTaskSession` has just written
  // is not in it — the new Session's row would sit badge-less until a reload. The
  // fix is REFETCHED rather than patched here, because "which of a Session's links
  // is newest" is `MAX(rowid)`'s answer in Rust and an optimistic write would give
  // that rule a second owner in the renderer (the same reason `store/tasks.ts`
  // refuses to invent a link on `linkSession`).
  //
  // Both launch paths are pinned because the refetch sits in `startAndSendLinked`,
  // the helper the two share — a case for one path alone would survive the helper
  // call being replaced by two call-site copies that drifted apart.

  const rows = (): TaskNumberRow[] => [
    { sessionId: "sess_new", taskNumber: 7, stageSlug: "research" },
  ];

  it("refetches the map and fills the store after a launch from a column", async () => {
    seedBoard(
      column("backlog", [taskRow()]),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
    );
    vi.mocked(taskNumbers).mockResolvedValue(rows());

    await launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());

    // The fetch happened, and it took NO argument — the read is app-wide (D3), not
    // per-Space, so a launch cannot scope it to the Space it came from.
    expect(taskNumbers).toHaveBeenCalledTimes(1);
    // The store holds the ROWS PAIRED into badges — `setTaskNumbers`'s job, and the
    // reason the launch path hands over rows instead of a map.
    expect(useSessions.getState().taskNumbers).toEqual({
      sess_new: { number: 7, stageSlug: "research" },
    });
    // The launch still did its own job: the Session is listed and the prompt is out.
    expect(useSessions.getState().sessions.map((s) => s.sessionId)).toEqual([
      "sess_new",
    ]);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("refetches the map after a DRAFT create-and-launch too (the shared helper)", async () => {
    seedBoard(
      column("backlog", [], { label: "Backlog" }),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
    );
    vi.mocked(taskNumbers).mockResolvedValue(rows());

    await createTaskFromDraft(
      SPACE,
      "Wire the board",
      null,
      destination(),
      CATALOGS(),
    );

    expect(taskNumbers).toHaveBeenCalledTimes(1);
    expect(useSessions.getState().taskNumbers).toEqual({
      sess_new: { number: 7, stageSlug: "research" },
    });
  });

  it("starts NOTHING and fetches no map for a save-only create (no link, so nothing to refresh)", async () => {
    // The negative: the refetch rides the launch, not the click. A card that was
    // only filed has no link, so a fetch here would be a round trip for a fact that
    // cannot have changed.
    seedBoard(
      column("backlog", [], { label: "Backlog" }),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
    );
    await createTaskFromDraft(SPACE, "Wire the board", null, SAVE_ONLY, CATALOGS());
    expect(startTaskSession).not.toHaveBeenCalled();
    expect(taskNumbers).not.toHaveBeenCalled();
  });

  it("a slow refetch does not hold up the prompt dispatch (the dispatch stays ahead of the await)", async () => {
    // `sendLaunchMessage` is deliberately NOT awaited, and an awaited `await
    // taskNumbers()` placed BEFORE it would quietly undo that: measured with the
    // refetch held open, `sendPrompt` had not been called while it was pending, so a
    // slow cosmetic fetch would sit between a click and the wire. This pins the
    // ordering that makes the comment true.
    seedBoard(
      column("backlog", [taskRow()]),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
    );
    const slots: { release?: (v: TaskNumberRow[]) => void } = {};
    vi.mocked(taskNumbers).mockReturnValue(
      new Promise<TaskNumberRow[]>((resolve) => {
        slots.release = resolve;
      }),
    );

    const launched = launchTaskSession(SPACE, taskRow(), "discuss", CATALOGS());
    // Let the awaits up to the refetch settle, then look at what has already gone out.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The prompt is already on the wire while the badge fetch is still in flight.
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(taskNumbers)).toHaveBeenCalledTimes(1);

    slots.release?.([]);
    expect((await launched).sessionId).toBe("sess_new");
  });

  it("a REFUSED badge refetch does not fail the launch (the badge is cosmetic)", async () => {
    // The failure-proofing is the whole point of the `try`/`catch`: the Session has
    // genuinely started, so a map that will not refresh must not turn a successful
    // launch into a rejected promise the modal renders as an error line.
    seedBoard(
      column("backlog", [taskRow()]),
      column("discuss", [], { label: "Discuss", skill: "discuss" }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      vi.mocked(taskNumbers).mockRejectedValue(new Error("ipc down"));
      const launched = await launchTaskSession(
        SPACE,
        taskRow(),
        "discuss",
        CATALOGS(),
      );
      expect(launched.sessionId).toBe("sess_new");
      expect(startTaskSession).toHaveBeenCalledTimes(1);
      expect(sendPrompt).toHaveBeenCalledTimes(1);
      // The map keeps whatever it had — the failed fetch writes nothing.
      expect(useSessions.getState().taskNumbers).toEqual({});
      // And the failure is LOGGED, not swallowed whole.
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

/// The **auto-advance chain's settle edge** — proof the hook is wired into the send
/// path, and not merely implemented next to it.
///
/// `workflowChain.test.ts` owns everything the runtime DOES with a settle; this block
/// owns the one fact only this file can prove: that `sendLaunchMessage`'s `await
/// sendPrompt(...)` actually hands that settle over. A runtime that is correct in
/// isolation and never called is the exact failure this feature cannot ship with — a
/// column that looks automatic and is not.
///
/// The card starts in `backlog`, is launched on `research` (which IS `auto`), and the
/// settle is the mocked `end_turn`. What follows is the real chain: `research` points at
/// `implement`, so the card moves and `implement`'s Skill is what goes out.
describe("the auto-advance chain — the settle edge is wired", () => {
  // A catalog that carries BOTH columns' Skills. `CATALOGS()` above deliberately has only
  // `discuss` and `research`, and several of its cases pin the refusal that a missing
  // Skill produces — widening the shared fixture to cover this chain would put this
  // block's need on their path. The chain's next column asks for `implement`, so this
  // block says so itself.
  const CHAIN_CATALOGS = (): TaskLaunchCatalogs => ({
    skills: [skill("research"), skill("implement")],
    agents: [],
  });

  beforeEach(() => {
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], {
        label: "Research",
        sortOrder: 1,
        skill: "research",
        auto: true,
      }),
      column("implement", [], {
        label: "Implement",
        sortOrder: 2,
        skill: "implement",
      }),
    );
  });

  it("advances the card when the launched column is auto and the turn ends", async () => {
    // The turn settles AFTER the click's promise resolves, which is how it works in
    // production (a turn takes seconds; `launchTaskSession` returns in milliseconds) and
    // which is WHY the chain works at all: `launchTaskSession` guards a card's launch in
    // a module `Set` keyed by `task.id`, and the chain's next launch is a launch of the
    // SAME card. If the turn settled before the parent released that guard the chain's
    // launch would be refused by its own parent. A `sendPrompt` mock that resolves
    // synchronously manufactures exactly that impossible ordering — so this case defers
    // the settle by hand, which is also the only way to observe the edge at all.
    let settleTurn!: (reason: StopReason) => void;
    // THE DECIDER'S ANSWER. The runtime no longer derives "is this column auto?" from the
    // slice — it asks, and this is the case that pins the ask leads to a move and a launch.
    answerOnce(advancing());
    vi.mocked(sendPrompt).mockImplementation(
      () => new Promise<StopReason>((resolve) => (settleTurn = resolve)),
    );
    const launched = await launchTaskSession(
      SPACE,
      taskRow(),
      "research",
      CHAIN_CATALOGS(),
    );
    expect(launched.sessionId).toBe("sess_new");
    settleTurn("end_turn");
    // Flushed, never assumed: the chain is `void`ed on purpose, so neither the step nor
    // the second launch can be awaited from here — awaiting them is the `ask`-gate
    // deadlock `sendLaunchMessage`'s header records, one level deeper.
    await vi.waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement"),
    );
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", null);
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(vi.mocked(sendPrompt).mock.calls[1]![1]).toContain("$implement");
    // The chain's OWN turn is still open — the card moved while the next Session was
    // still working, which is the whole point of a chain that does not wait.
    expect(useSessions.getState().inTurn["sess_new"]).toBe(true);
  });

  it("asks once per settle and moves nothing when the answer is not to advance", async () => {
    // THE compatibility case, and the reason the 39 cases above still pass untouched. It
    // used to read "does not touch the chain for a column that is not auto" and passed for
    // the wrong reason: the runtime never ASKED, because it read `stages.auto` from a slice
    // and answered "not automatic" from absence. It now asks on every settling turn — that
    // is the design — and what keeps an ordinary launch inert is Rust's answer: `unclaimed`
    // for a Session that never called `mark_done` (D4), `not_automatic` for a column nobody
    // marked. One ask per settle, and nothing moves, closes or launches on either answer.
    seedBoard(
      column("backlog", [taskRow()]),
      column("research", [], {
        label: "Research",
        sortOrder: 1,
        skill: "research",
      }),
    );
    await launchTaskSession(SPACE, taskRow(), "research", CHAIN_CATALOGS());
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(workflowAdvanceAdvice).toHaveBeenCalledTimes(1));
    // The refusal is recorded and said — `unclaimed` has no surface but the transcript and
    // the `stop_reason` column, and `workflowRunClose` is a silent no-op when there is no
    // open run to close (this launch never opened one: the step write happens only on an
    // advancing advice). The card does not move and no Session starts.
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "unclaimed");
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(moveTask).toHaveBeenLastCalledWith(SPACE, "tsk_1", "research");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("settles the chain's own failure into the Session, never as a rejected launch", async () => {
    // The `void`ed promise has nothing upstream to catch it, so a rejecting step verb
    // must land as a line in the transcript (this file's own shape for a failure that
    // cannot be rethrown) and must NOT move the card: a verdict this side never read is
    // a verdict it must not guess at.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(workflowAdvanceAdvice).mockRejectedValue(new Error("db is busy"));
      const launched = await launchTaskSession(
        SPACE,
        taskRow(),
        "research",
        CHAIN_CATALOGS(),
      );
      expect(launched.sessionId).toBe("sess_new");
      await vi.waitFor(() => {
        const rows = useSessions.getState().messages["sess_new"] ?? [];
        expect(
          rows.some((m) => /auto-advance chain/.test((m as { text: string }).text ?? "")),
        ).toBe(true);
      });
      expect(moveTask).toHaveBeenCalledTimes(1);
      expect(moveTask).toHaveBeenLastCalledWith(SPACE, "tsk_1", "research");
    } finally {
      consoleError.mockRestore();
    }
  });
});
