import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  advanceWorkflowChainOnSettle,
  costDeltaOf,
  type WorkflowSettle,
} from "./workflowChain";
import { consumeAdvanceAdvice, launchTaskSession, type TaskLaunchCatalogs } from "./taskLaunch";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import { resetTaskLaunchInFlight } from "./taskLaunch";
import { useInteractive } from "./interactive";
import { useSessions } from "./sessions";
import { useTasks } from "./tasks";
import { resetStores } from "../test/resetStores";
import {
  getTask,
  listAgentDefinitionsForSpace,
  listSkills,
  moveTask,
  sendPrompt,
  startTaskSession,
  taskNumbers,
  workflowAdvanceAdvice,
  workflowRunClose,
  type AcpSessionUpdate,
  type AdvanceAdvice,
  type SessionInfo,
  type SkillInfo,
  type StageDto,
  type StageWithTasks,
  type StopReason,
  type TaskCardView,
  type TaskRow,
} from "../lib/tauri";

/**
 * `src/store/workflowChain.ts` — the runtime that obeys Rust's advance advice.
 *
 * ## The seam under test
 *
 * A column with `auto: true` means: when the Session launched on entering it SETTLES,
 * move the card to the column its edge names and launch that column's Skill. The settle
 * edge is `taskLaunch.sendLaunchMessage`'s `await sendPrompt(...)` — the one place that
 * already holds the reason, the Space, the card and the launched column — and this module
 * is what that edge calls. `taskLaunch.test.ts` owns the proof the edge is WIRED into the
 * send path; this file owns what the runtime does with a settle.
 *
 * ## It ASKS now. The cases changed shape, none was dropped.
 *
 * This runtime used to derive the decision itself: `stageOf` read `stages.auto` out of the
 * board slice, `nextStepOf` walked the graph in the same slice, and `workflowRunStep`
 * stepped the run. Every one of those reads a slice that is not populated in the case the
 * automation exists for, and the tree measured the consequence (`workflow_runs`: zero rows
 * against 456 Sessions in a week). It now makes ONE `workflowAdvanceAdvice(sessionId,
 * delta)` call and obeys it, so:
 *
 *  - a case that used to seed a slice and assert the slice-derived verdict now hands over
 *    an ADVICE and asserts what the runtime does with it;
 *  - the four `ChainStop` cases became SIX, because the advice also refuses with the three
 *    Session-shaped reasons `ChainStop` has no spelling for (`unclaimed`, `not_automatic`,
 *    `unlinked`) and those arms have to be pinned too;
 *  - the slice-shaped cases that no longer describe anything reachable (`[]` vs `NULL`,
 *    the unresolvable edge, the sortOrder+1 fallback) did NOT get deleted — they became
 *    the pins that this side does NOT re-derive, which is the property that replaced them.
 *    ADR 0098's two-authorities rule is now the thing under test rather than a comment.
 *
 * ## The mocks, and what is deliberately NOT mocked
 *
 * The barrel is mocked with the wrapper names spreading `importActual`, for the reason
 * AGENTS.md records: an un-mocked wrapper resolves to the real one, calls `invoke`, and
 * rejects outside a webview — every case would then pin a rejection it cannot see.
 *
 * `./taskLaunch` is NOT mocked, and the default `launch` below is the REAL
 * `launchTaskSession`. So the move is the full verb (the store action, the `moveTask`
 * command, the optimistic slice) and the `launch_refused` arm is real code: a Skill the
 * catalog lacks THROWS inside `launchTaskSession`, and that throw is observed rather than
 * asserted against a stub.
 *
 * ## TWO resets are load-bearing
 *
 * `resetStores()` plus `useTasks.getState().reset()` (the tasks store guards its `load`
 * epoch with a module `let`), and `resetTaskLaunchInFlight()` — `taskLaunch`'s
 * `inFlight` is a module `Set` that `resetStores()` cannot reach, and one left dirty
 * from the case above answers `{ sessionId: null }` for the card below, which reads as
 * "the chain was refused" when nothing was refused.
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
    // The **Task badge** map's boot fetch, which `startAndSendLinked` re-calls after a
    // launch. Mocked with its implementation IN THE FACTORY (not only in `beforeEach`),
    // because `vi.clearAllMocks()` clears calls and keeps implementations, and every
    // real-launch case here reaches the refetch.
    taskNumbers: vi.fn().mockResolvedValue([]),
    // The card read the CLAIM path makes (it holds only a Session id). Not used by the
    // settle path this file drives, and mocked so an accidental call cannot reach
    // `invoke` and reject outside a webview.
    getTask: vi.fn().mockResolvedValue(null),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    // The chain's TWO run verbs. (`workflowRunOpen` used to be mocked here too; the
    // wrapper, its command and its `Db` verb were deleted as dead IPC, and a mock
    // entry for a name the barrel no longer exports would read as "it still exists".)
    // `workflowRunStep` is GONE from this list because the runtime no longer calls it:
    // the advice counts the step inside Rust, and a mock for a name nothing calls would
    // read as "this path still steps".
    workflowAdvanceAdvice: vi.fn(),
    workflowRunClose: vi.fn().mockResolvedValue(undefined),
  };
});

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "tsk_1",
    spacePath: SPACE,
    number: 3,
    title: "Wire the board",
    body: null,
    specPath: null,
    stageSlug: "research",
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
    body: `${name.toUpperCase()} BODY`,
    disableModelInvocation: false,
    shadowed: [],
  };
}

/** A column, spelled through the real wire fields.
 *  `auto` defaults to `false` because that is the stored default
 *  (`INTEGER NOT NULL DEFAULT 0`) — a case that means an automatic column says so. */
function column(
  slug: string,
  over: {
    label?: string;
    sortOrder?: number;
    skill?: string | null;
    nextSlugs?: string[] | null;
    auto?: boolean;
    prefix?: string | null;
  } = {},
): StageWithTasks {
  return {
    stage: stage(slug, over),
    tasks: [],
  };
}

/** The bare `StageDto` (the advice carries a row, not a board column). */
function stage(
  slug: string,
  over: {
    label?: string;
    sortOrder?: number;
    skill?: string | null;
    nextSlugs?: string[] | null;
    auto?: boolean;
    prefix?: string | null;
  } = {},
): StageDto {
  return {
    spacePath: SPACE,
    slug,
    label: over.label ?? slug,
    sortOrder: over.sortOrder ?? 0,
    onEnter: "none",
    onEnterSkill: over.skill ?? null,
    nextSlugs: over.nextSlugs ?? null,
    auto: over.auto ?? false,
    promptPrefix: over.prefix ?? null,
  };
}

/** The board's card wrapper. `moveTask`'s optimistic paint reads `card.task.id`, so a
 *  column meant to HOLD the card carries the real `TaskCardView`, and an empty
 *  `sessions` / `null` cost / `[]` artifacts / `false` readiness are the truth for a
 *  card that has none — `ready` is an OR over the linked Sessions' `sessions.ready`
 *  column and this card has no links to contribute to it. */
function card(task: TaskRow): TaskCardView {
  return { task, sessions: [], costUsd: null, artifactKeys: [], ready: false, readySessions: [] };
}

/** Paint a board AND put the card in the column its `stageSlug` names.
 *
 *  The card has to be IN the slice, and that is not decoration: `useTasks.moveTask`
 *  refuses a move whose source column does not hold the card ("a stale gesture beats
 *  inventing a column") and returns WITHOUT calling the command. Seed a board that does
 *  not hold the card and every move assertion below would be pinning an early return
 *  that looks like a move.
 *
 *  NOTE that most cases here no longer NEED a board — the whole point of the advice is
 *  that the decision and the destination both arrive without one. The board is seeded
 *  where the case is about the slice (the optimistic paint, the stale-column arm, or the
 *  "the advice wins over the slice" pin), and deliberately absent where the case is about
 *  working without it. */
function seedBoard(...columns: StageWithTasks[]): void {
  const task = taskRow();
  useTasks.setState({
    boardsBySpace: {
      [SPACE]: columns.map((c) =>
        c.stage.slug === task.stageSlug ? { ...c, tasks: [card(task)] } : c,
      ),
    },
  });
}

const CATALOGS = (): TaskLaunchCatalogs => ({
  skills: [skill("research"), skill("implement")],
  agents: [],
});

/** The real launch, wired the way `taskLaunch` wires it — the WHOLE destination, not
 *  `next.slug`, which is D19's other half: dropping the row is what made the chain
 *  re-resolve a Skill against a slice that is not mounted. */
function realLaunch(task: TaskRow): WorkflowSettle["launch"] {
  return (next: TaskLaunchDestination) => launchTaskSession(SPACE, task, next, CATALOGS());
}

/** The settle of the Session launched on `research`.
 *
 *  `costBeforeTurnUsd: null` is the ordinary chain case: each column launches its OWN
 *  Session, and a fresh one has reported nothing before its first frame. */
function settle(over: Partial<WorkflowSettle> = {}): WorkflowSettle {
  const base: WorkflowSettle = {
    spacePath: SPACE,
    task: taskRow(),
    sessionId: "sess_new",
    reason: "end_turn",
    launchedSlug: "research",
    costBeforeTurnUsd: null,
    launch: realLaunch(taskRow()),
  };
  return { ...base, ...over };
}

/** The advice the decider answers with, spelled through the nine wire keys `shape.rs`
 *  pins — the shipped fallbacks written out, because this side of the wire holds NO copy
 *  of them and a case that wants a bound has to hand one over the way the wire does.
 *
 *  The default is the ADVANCING arm into a non-auto `implement`: one link forward, and the
 *  chain ends there. */
function advice(over: Partial<AdvanceAdvice> = {}): AdvanceAdvice {
  return {
    advance: true,
    stop: null,
    destination: stage("implement", { sortOrder: 2, skill: "implement" }),
    reason: "advanced",
    maxSteps: 20,
    ceilingUsd: 10,
    taskId: "tsk_1",
    spacePath: SPACE,
    alreadyLaunched: false,
    ...over,
  };
}

/** A refusal, with the two fields every refusal shares set the way Rust sets them. */
function refusal(reason: string, over: Partial<AdvanceAdvice> = {}): AdvanceAdvice {
  return advice({ advance: false, destination: null, stop: null, reason, ...over });
}

/** The transcript lines this Session holds, as text. */
function lines(sessionId = "sess_new"): string[] {
  return (useSessions.getState().messages[sessionId] ?? []).map(
    (m) => ((m as { text?: string }).text ?? ""),
  );
}

/// ── THE OTHER CHAIN DOOR, so the two doors can be raced HERE and not only in
/// `taskLaunch.claim.test.ts`.
///
/// The bug these helpers reach for is a TWO-DOOR bug: the claim (`consumeAdvanceAdvice`,
/// rAF-deferred by `App.tsx`'s batcher) and the settle (`advanceWorkflowChainOnSettle`,
/// deferred by nothing) both launch the same card for the same link. Pinning the trip at the
/// claim alone would leave the consequence — a closed run, and therefore a step count and a
/// cost ceiling that restart per link — asserted nowhere, because the consequence lives in
/// THIS file's `finishLink`. So the settle door is driven by the real entry point below and
/// the claim door by the real `consumeAdvanceAdvice`, both against the real
/// `launchTaskSession`, which `./taskLaunch` is deliberately not mocked to replace.
/** A promise plus its resolver, for parking the claim's first read at a chosen instant —
 *  every mock in this file resolves immediately, so the window the settle has to arrive
 *  inside is manufactured by hand rather than hoped for. */
function deferred<T>(value: () => T): { promise: Promise<T>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<T>((r) => {
    resolve = () => r(value());
  });
  return { promise, resolve };
}

/** A macrotask, to flush past a dispatch whose ordering microtasks cannot pin. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The catalog the CLAIM reads through the barrel mocks. `launchTaskSession` expands the
 *  destination's `$implement` token against `catalogs.skills`, and `missingSkill` REFUSES a
 *  launch whose Skill the catalog lacks — so a claim that is meant to succeed has to be
 *  handed the Skill itself. */
function claimCatalogs(): void {
  vi.mocked(listSkills).mockResolvedValue([skill("implement")]);
  vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([]);
}

/** A live `tool_call_update` carrying `next` at `rawOutput.details.advanceAdvice` — the
 *  carrier `normalize.rs` ships, and the frame `consumeAdvanceAdvice` reads. */
function claimFrame(next: AdvanceAdvice): AcpSessionUpdate {
  const details = { advanceAdvice: next };
  const content = [{ type: "text", text: "advanced" }];
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_1",
    status: "completed",
    rawOutput: { content, details },
  } as AcpSessionUpdate;
}

beforeEach(() => {
  firstAnswer = advice();
  sessionsAsked = new Set<string>();
  resetStores();
  useTasks.getState().reset();
  resetTaskLaunchInFlight();
  vi.clearAllMocks();
  useSessions.setState({ sessions: [], historySessions: [], archivedSessions: [] });
  seedBoard(...[
    column("backlog", { sortOrder: 0 }),
    column("research", { sortOrder: 1, skill: "research", auto: true }),
    column("implement", { sortOrder: 2, skill: "implement" }),
    column("done", { sortOrder: 3 }),
  ]);
  vi.mocked(startTaskSession).mockResolvedValue(info());
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
  vi.mocked(taskNumbers).mockResolvedValue([]);
  vi.mocked(workflowRunClose).mockResolvedValue(undefined);
  // The decider's answer for this test — and a DEDUPE, not a constant.
  //
  // A real chain ASKS TWICE: `launchTaskSession` dispatches the next link's turn, that
  // turn settles under the mocks, and `taskLaunch`'s settle edge fires this runtime again
  // for the link it just started. Rust answers the second ask `already_advanced`, because
  // its dedupe is a `task_sessions` row the launch itself wrote (D17). So the mock answers
  // each Session ONCE and `already_advanced` thereafter — which is both the faithful model
  // and the thing that makes a real-launch case terminate instead of chaining forever.
  //
  // It is an IMPLEMENTATION and not a `mockResolvedValue` for exactly that reason: a case
  // that replaced the implementation with a constant would re-open the recursion, and a
  // suite that hangs on the runner's timeout is a worse red than one that fails.
  vi.mocked(workflowAdvanceAdvice).mockImplementation(async (sessionId: string) => {
    const asked = sessionsAsked.has(sessionId);
    sessionsAsked.add(sessionId);
    return asked ? ALREADY_ADVANCED : firstAnswer;
  });
});

/** The dedupe's answer, spelled once. */
const ALREADY_ADVANCED: AdvanceAdvice = {
  advance: false,
  stop: null,
  destination: null,
  reason: "already_advanced",
  maxSteps: 20,
  ceilingUsd: 10,
  taskId: "tsk_1",
  spacePath: SPACE,
  alreadyLaunched: true,
};

/** Which Sessions the decider has already answered for, reset per test — the dedupe's
 *  whole state, and the reason the mock is a closure over it rather than a constant. */
let sessionsAsked = new Set<string>();

/** What the decider answers the FIRST time a Session asks. Every case that wants a
 *  specific advice goes through this rather than through `mockResolvedValue`, because
 *  replacing the implementation would replace the dedupe above with a constant and send
 *  any real-launch case into an unbounded chain. */
let firstAnswer: AdvanceAdvice = advice();
function answerWith(next: AdvanceAdvice): void {
  firstAnswer = next;
}

describe("the auto-advance chain — advancing", () => {
  it("moves the card to the advised column and launches that column's Skill", async () => {
    // The feature in one assertion pair: the card lands in `implement` THROUGH THE FULL
    // MOVE VERB (`useTasks.moveTask` → `move_task`, so the optimistic paint, the
    // whole-slice re-derivation and the revert-into-`error` all still happen — the chain's
    // move is the human's drag, not a third meaning of "a move"), and the Session that
    // starts is the one the ADVICE's column configures: `$implement`, not `$research`.
    // Each link carries its own column's Skill and its own extra prompt, which is what
    // makes the chain Skill A → Skill B → Skill C.
    // The dispatch is `void`ed, so the move and the launch land after this call
    // returns — that is the feature, and the flush is what makes the assertions below
    // observe it rather than race it. NOTE the settle is invoked directly here, so the
    // chain's OWN launch is `sendPrompt` call 0; through `taskLaunch` there would be a
    // first send (the turn that settled) beneath it.
    await advanceWorkflowChainOnSettle(settle());
    await vi.waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement"),
    );
    // The optimistic paint is visible without a refetch — the proof the store action ran
    // and not a bare `Db::move_task` equivalent.
    const landed = useTasks
      .getState()
      .boardsBySpace[SPACE]?.find((c) => c.stage.slug === "implement");
    expect(landed?.tasks.map((t) => t.task.id)).toContain("tsk_1");
    // The launch's own dispatch sits behind `startTaskSession`, so it lands a beat after
    // the move — flushed, not assumed.
    await vi.waitFor(() => expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendPrompt).mock.calls[0]![1]).toContain("$implement");
    // `implement` is not `auto`, so the chain DOES close — but only once the launch's
    // outcome is known, so a refusal can still claim the reason column.
    await vi.waitFor(() =>
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "manual"),
    );
  });

  it("asks about the SESSION and nothing else — there is no Space to aim the question at", async () => {
    // THE replacement for the case that used to pin which Space `workflowRunStep` was
    // handed. That question existed because the step verb took a `spacePath` and a wrong
    // one measured the chain against another Space's budget. The advice is keyed on the
    // Session id ALONE and Rust resolves the card, the Space, the column, the edge and
    // both budgets from it, so the failure this case used to guard is now unreachable by
    // construction — and the guard is that the call carries nothing else.
    //
    // The fixture still makes the two Space fields DIFFER on purpose: `settle.spacePath`
    // and `settle.task.spacePath` are the same string in production, so a fixture that
    // left them equal could not tell which one anything read.
    await advanceWorkflowChainOnSettle(
      settle({ task: taskRow({ spacePath: "/w/other" }) }),
    );
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", null);
    expect(vi.mocked(workflowAdvanceAdvice).mock.calls[0]).toHaveLength(2);
    // And neither Space nor card id can be smuggled in beside it.
    expect(workflowAdvanceAdvice).not.toHaveBeenCalledWith(SPACE, "sess_new", null);
    expect(vi.mocked(workflowAdvanceAdvice).mock.calls.flat()).not.toContain("tsk_1");
  });

  it("carries the destination column's extra prompt into the message", async () => {
    // T5's field, one hop deeper: a chain that dropped it would rebuild the bug T5
    // fixed, and the whole point of the graph is a chain with per-column prose. The
    // prefix is spelled on BOTH the slice and the advice's row here because either can be
    // the source (the slice wins when it is mounted — see the case below), and this case
    // is about the prose reaching the message, not about which row it came from.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("implement", { sortOrder: 2, skill: "implement", prefix: "TDD first." }),
    );
    answerWith(
      advice({ destination: stage("implement", { skill: "implement", prefix: "TDD first." }) }),
    );
    await advanceWorkflowChainOnSettle(settle());
    await vi.waitFor(() => expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendPrompt).mock.calls[0]![1]).toContain("TDD first.");
  });

  it("prefers the mounted board's row over the advice's when BOTH describe the column", async () => {
    // The one direction that is NOT "obey the advice", and it is deliberate. The advice
    // decides WHETHER to advance and WHICH column; the four fields that go into the
    // MESSAGE (`label`, `onEnterSkill`, `promptPrefix`) are read from the slice when a
    // slice is mounted, because a mounted board is a fresher read of a column a person may
    // have edited since the claim, and `launchTaskSession`'s order is documented. The
    // DECISION is still the advice's — the column is `implement` either way — so this is
    // not a second authority on where the card goes, only on what the destination says.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("implement", { sortOrder: 2, skill: "ghost", prefix: "From the slice." }),
    );
    await advanceWorkflowChainOnSettle(settle());
    // The slice's Skill is `ghost`, which the catalog does not have, so the launch is
    // REFUSED — which is the observable proof the slice's row was the one read.
    await vi.waitFor(() =>
      expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
    );
    expect(lines().join("\n")).toContain("`ghost`");
  });

  it("closes the run when the column it advanced INTO is not automatic", async () => {
    // `implement` is NOT `auto`, so nothing will fire a settle hook past this point and
    // the chain is over the moment the card lands. Closing is not a courtesy: the step
    // UPSERTS onto an OPEN run, so a run left open would hand its step count and running
    // cost to the NEXT chain this card ever starts, and a person who set a 20-step bound
    // would silently get a shorter one. `"manual"` is the record's own vocabulary for "a
    // person's column took over" — `workflowRunClose`'s doc names it, and the four
    // `ChainStop` spellings are the BOUND vocabulary, which this is not.
    await advanceWorkflowChainOnSettle(settle());
    // Awaited through the launch's OUTCOME and not its turn: the close is written after
    // the launch resolves, because a close written before it would beat a
    // `launch_refused` to the record and name the wrong reason (`finished_at IS NULL`
    // makes the second close a no-op).
    await vi.waitFor(() =>
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "manual"),
    );
    expect(lines().some((t) => /manual/.test(t))).toBe(true);
  });

  it("leaves the run OPEN when the next column is automatic too", async () => {
    // A → B → C: B's settle is the next link's settle edge, so the run must still be
    // OPEN for B to step onto — the step verb UPSERTS onto an open run, and that is what
    // makes the step bound cover the WHOLE chain rather than each link separately. The
    // arriving column's `auto` flag rides the SAME row the destination came from, which is
    // how this is known without a slice.
    answerWith(
      advice({ destination: stage("implement", { skill: "implement", auto: true }) }),
    );
    await advanceWorkflowChainOnSettle(
      settle({ launch: async () => ({ sessionId: "sess_next", note: null }) }),
    );
    expect(workflowAdvanceAdvice).toHaveBeenCalled();
    expect(workflowRunClose).not.toHaveBeenCalled();
  });
});

describe("the auto-advance chain — it does NOT await the next launch", () => {
  /// The DEADLOCK this guards, from `taskLaunch.sendLaunchMessage`'s own header:
  /// `sendPrompt` resolves on `agent_settled`; the merged `research` Skill ends its turn
  /// on an `ask` gate; `AskQuestionCard` renders only under `ChatStream`; and `App`'s
  /// view ternary renders the board INSTEAD of `ChatStream`. Awaiting the next launch
  /// therefore chains the card to a gate that has no renderer and cannot appear until
  /// the turn ends. Every `sendPrompt` mock in the repo resolves immediately, so a suite
  /// built on resolving mocks CANNOT tell `void` from `await` — which is why `launch` is
  /// an argument of the settle and this case hands over one that has not resolved.
  it("returns while the next launch has not resolved", async () => {
    let launchResolved = false;
    let launchAttempted = false;
    const never = new Promise<never>(() => {});
    const launched = advanceWorkflowChainOnSettle(
      settle({
        launch: () => {
          launchAttempted = true;
          return never.then(() => {
            launchResolved = true;
            return { sessionId: "sess_next", note: null };
          });
        },
      }),
    );
    // If the runtime awaited the next launch, this `await` hangs and the case reddens on
    // the runner's timeout — that IS the red, and it is the only thing in the suite that
    // distinguishes `void` from `await`.
    await launched;
    // The advice was read before the function returned, so this is not the trivial
    // pass of an empty function: real work happened and it still did not wait.
    expect(workflowAdvanceAdvice).toHaveBeenCalled();
    expect(launchResolved).toBe(false);
    // The injected launch is what never resolves — the real one moves the card and then
    // starts a turn, and the move is therefore inside the unresolved half.
    expect(launchAttempted).toBe(true);
  });
});

describe("the auto-advance chain — what does not count as settling", () => {
  it.each(["cancelled", "max_tokens", "refusal", "max_turn_requests"] as StopReason[])(
    "a %s settle closes the run and does not advance",
    async (reason) => {
      // A WHITELIST (`reason === "end_turn"`), never `!== "cancelled"`: `max_tokens` is
      // the provider cutting the reply off and `max_turn_requests` is the engine's own
      // turn bound — neither is a finish, and neither is a pause the user owes.
      // `lib/attention.ts` carries the reasoning verbatim, including the timing fact this
      // relies on: `turnCompleted` writes `inTurn` and `stopReasons` in ONE `set()`.
      //
      // The advice IS still asked on this arm — it is the one call that answers
      // `alreadyLaunched`, and the close below is gated on that. Nothing moves.
      await advanceWorkflowChainOnSettle(settle({ reason }));
      expect(moveTask).not.toHaveBeenCalled();
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", reason);
    },
  );

  it("does NOT close a %s settle whose link already launched", async () => {
    // THE THIRD CALL SITE of the close rule, and the one nobody looks at. This arm used to
    // close UNCONDITIONALLY, and the close was the bug rather than the spelling: a model
    // that called `mark_done` (so the next link is launched and running) and was THEN cut
    // off by `max_tokens` closed the run its own claim had just stepped. The next link's
    // step opens a fresh run at `steps = 1` with `cost_usd` NULL — and NULL can never trip
    // a ceiling — so a 20-step bound became 20 steps per link and the ceiling became a
    // per-link allowance, with no `stop_reason` changing anywhere. The sentence still goes
    // out: it is a true statement about THIS turn regardless of what the link did.
    answerWith(
      advice({ advance: false, destination: null, reason: "already_advanced", alreadyLaunched: true }),
    );
    await advanceWorkflowChainOnSettle(settle({ reason: "max_tokens" }));
    expect(workflowRunClose).not.toHaveBeenCalled();
    expect(lines().some((t) => /max_tokens/.test(t))).toBe(true);
  });

  it("still closes a non-finishing settle when the advice call itself fails", async () => {
    // The conservative half of the arm that now has to ask. A run this side could not read
    // is a run it must leave CLOSED rather than leak into the next chain, so the fallback
    // on a rejected advice call is the old unconditional behaviour. The sentence goes out
    // either way, because it describes this turn and not the advice.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(workflowAdvanceAdvice).mockRejectedValue(new Error("db is busy"));
      await advanceWorkflowChainOnSettle(settle({ reason: "cancelled" }));
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "cancelled");
      expect(lines().some((t) => /cancelled/.test(t))).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("says so in the transcript that just ended", async () => {
    await advanceWorkflowChainOnSettle(settle({ reason: "cancelled" }));
    expect(lines().some((t) => /cancelled/.test(t))).toBe(true);
  });

  it("does not launch anything on a non-end_turn settle", async () => {
    // The move verb is reached only through the launch, so zero `moveTask` calls is the
    // proof nothing downstream of the verdict ran.
    await advanceWorkflowChainOnSettle(settle({ reason: "max_tokens" }));
    expect(moveTask).not.toHaveBeenCalled();
  });
});

describe("the auto-advance chain — it asks, so the board slice is irrelevant", () => {
  it("THE HEADLINE: moves the card and launches the Skill with NO board slice loaded", async () => {
    // This is the case that has NEVER worked, and the reason `workflow_runs` is empty in
    // the live database. `App`'s view ternary renders the board INSTEAD of `ChatStream`,
    // so the window an unattended chain settles in has no `boardsBySpace` entry at all.
    // The old runtime read `stages.auto` from that entry, got `undefined`, answered "not
    // automatic", and said nothing.
    //
    // Now: the decision comes from the database (the advice), the destination row comes
    // from the database (its four fields), and the move takes `taskMove`'s slice-free arm.
    // Nothing in this path reads a slice, so nothing here can no-op on one.
    useTasks.setState({ boardsBySpace: {} });
    await advanceWorkflowChainOnSettle(settle());
    await vi.waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement"),
    );
    await vi.waitFor(() => expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1));
    // The Skill reached the message — the part `resolveStage` used to drop, because the
    // destination it built came from a slice with no row in it.
    expect(vi.mocked(sendPrompt).mock.calls[0]![1]).toContain("$implement");
    expect(vi.mocked(sendPrompt).mock.calls[0]![1]).toContain("<task ");
    await vi.waitFor(() =>
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "manual"),
    );
  });

  it("asks the decider even with no slice, rather than answering 'not automatic' from silence", async () => {
    // The old early return. An unloaded slice used to BE the answer, and the file argued
    // the conservatism was the honest half. It was honest and it was useless: a column a
    // person HAD marked automatic did not advance, and no sentence said so, because a
    // sentence about rows this window never read would be a claim about rows it did not
    // read. The fix is to read the rows.
    useTasks.setState({ boardsBySpace: {} });
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", null);
  });

  it("does not move the card when the column is not automatic (the bell stays lit)", async () => {
    // `not_automatic` is the non-auto half of the done-when, and it is a REFUSAL the
    // runtime must record rather than a silent return: `auto` is the user's configuration
    // and the amber bell is the surface that says "a person, now".
    answerWith(refusal("not_automatic"));
    await advanceWorkflowChainOnSettle(settle());
    expect(moveTask).not.toHaveBeenCalled();
    expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "not_automatic");
    expect(lines().join("\n")).toContain("not automatic");
    // And nothing here flips `auto` off — the flag is every card in the Space's config.
    expect(vi.mocked(moveTask)).not.toHaveBeenCalled();
  });
});

describe("the auto-advance chain — the advice decides the graph, including when it says stop", () => {
  it("moves along the column the ADVICE names, not the one the loaded graph points at", async () => {
    // TWO AUTHORITIES IS THE SHAPE ADR 0098 PREVENTS, and this is the pin. The mounted
    // slice says `research → implement` (`nextSlugs`), the advice says `done`. The old
    // runtime called `nextStepOf` on that slice and would have moved the card to
    // `implement`; a chain that re-derives an edge in TypeScript is a chain that can
    // disagree with the decider that just answered for the same card.
    seedBoard(
      column("research", {
        sortOrder: 1,
        skill: "research",
        auto: true,
        nextSlugs: ["implement"],
      }),
      column("implement", { sortOrder: 2, skill: "implement" }),
      column("done", { sortOrder: 3 }),
    );
    answerWith(
      advice({ destination: stage("done", { sortOrder: 3 }) }),
    );
    await advanceWorkflowChainOnSettle(settle());
    await vi.waitFor(() =>
      expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "done"),
    );
    expect(moveTask).not.toHaveBeenCalledWith(SPACE, "tsk_1", "implement");
  });

  it("closes with no_next_stage for a column configured `nextSlugs: []`", async () => {
    // THE collapse, now Rust's problem and this side's sentence. `[]` is "configured,
    // leads nowhere" — a person's explicit stop, distinct from `NULL` ("unconfigured, use
    // the column at sortOrder + 1"). The advice answers `no_next_stage` for the first and
    // a destination for the second; this case pins that a refusal to advance moves nothing
    // and does NOT fall through to the column above, which is what a `||` reading would do.
    answerWith(
      refusal("no_next_stage", { stop: "no_next_stage" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(moveTask).not.toHaveBeenCalled();
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "no_next_stage");
    expect(lines().some((t) => /no_next_stage/.test(t))).toBe(true);
  });

  it("advances through the sortOrder + 1 fallback exactly as the advice answers it", async () => {
    // The fallback is a Rust rule now (D15) and this side never had a copy of it. What is
    // pinned here is the consequence: whatever graph reasoning produced the destination,
    // this module moves the card to it. The fixture's slice has NO `nextSlugs` at all —
    // the unconfigured shape — and the advice names the column above, so a runtime that
    // still consulted the slice's edge list would find nothing and stop.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true, nextSlugs: null }),
      column("implement", { sortOrder: 2, skill: "implement" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement");
  });

  it("closes with no_next_stage for the last column of an unconfigured board", async () => {
    // The `NULL`-with-nothing-above arm (and its `sort_order` HOLE twin, which Rust
    // resolves to nothing on purpose so both sides agree): the same "no next stage" close,
    // and no step was charged for a move that did not happen.
    answerWith(
      refusal("no_next_stage", { stop: "no_next_stage" }),
    );
    seedBoard(column("research", { sortOrder: 1, skill: "research", auto: true }));
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "no_next_stage");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("does not invent a graph reason for a reason this build does not know", async () => {
    // A `reason` `advanceAdvice.ts` has no case for is a spelling from a newer Rust than
    // this renderer. The old arm fell back to `"no_next_stage"`, which INVENTS a graph
    // reason for what might be a bound failure — a specific falsehood on a path only a
    // broken or newer payload can reach, and one indistinguishable in the record from a
    // column that genuinely has no edge. `unknown` says the only true thing available, and
    // the log line is what makes it a report rather than a shrug (the transcript sentence a
    // person sees cannot carry the diagnostics, and `stop_reason` must not be a guess).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      answerWith(refusal("budget_exhausted"));
      await advanceWorkflowChainOnSettle(settle());
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "unknown");
      expect(consoleError).toHaveBeenCalled();
      const sentence = lines().join("\n");
      expect(sentence).toContain("unknown");
      expect(sentence).not.toMatch(/no column after it/);
      expect(moveTask).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("launches nothing when advance is true but no row arrived", async () => {
    // `destinationOf` obeys `advance` AND requires the row, so this payload — which Rust
    // cannot produce, since arm 7 emits both together — must not become a launch against a
    // column nobody named. The arm is the one that records `unknown` with the close gated
    // on `alreadyLaunched`, and it must not move a card.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      answerWith(advice({ destination: null }));
      await advanceWorkflowChainOnSettle(settle());
      expect(moveTask).not.toHaveBeenCalled();
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "unknown");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("the auto-advance chain — the refusals", () => {
  it.each([
    "max_steps",
    "cost_ceiling",
    "no_next_stage",
    "unclaimed",
    "not_automatic",
    "unlinked",
  ] as const)(
    "advance: false with reason %s closes with that reason and moves nothing",
    async (reason) => {
      // `advance` is the ONE field the runtime must obey, and the step that trips a bound
      // is still WRITTEN (the run's real length) while the CARD does not move — a chain
      // that hit its budget must not also spend the next column's Session.
      //
      // SIX and not the four this file used to walk: the three Session-shaped refusals
      // (`unclaimed`, `not_automatic`, `unlinked`) have no spelling in `ChainStop` by
      // design — adding one per refusal would be an enum change and a migration to say
      // what a string already says — so the `stop_reason` column gets `reason` verbatim
      // when `stop` is null, and each of the three needs its own pin.
      answerWith(
        refusal(reason, { stop: null, maxSteps: 7, ceilingUsd: 3.25 }),
      );
      await advanceWorkflowChainOnSettle(settle());
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", reason);
      expect(moveTask).not.toHaveBeenCalled();
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
      // And the slice still holds the card in the column it was in — the step was
      // charged, the card did not move.
      const research = useTasks
        .getState()
        .boardsBySpace[SPACE]?.find((c) => c.stage.slug === "research");
      expect(research?.tasks.map((t) => t.task.id)).toContain("tsk_1");
    },
  );

  it("closes a bound that tripped, and says which bound in the transcript", async () => {
    // The ceiling and the step bound share an arm but not a sentence, and the record must
    // name the one that fired rather than a generic "it stopped".
    answerWith(
      refusal("cost_ceiling", { stop: "cost_ceiling" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "cost_ceiling");
    expect(lines().join("\n")).toContain("$10.00");
  });

  it("records the step against the card the ADVICE resolved, not the row the caller held", async () => {
    // The advice resolves the card from the newest `task_sessions` link (D16's rule), and
    // that is not necessarily the card the settle was dispatched with — a Session can be
    // handed between cards, and 31 of 104 live cards hold more than one link. A step
    // written against one row and a close against another leaves the first run OPEN
    // forever, which is the same leak this file's close rule exists to prevent.
    answerWith(
      refusal("max_steps", { stop: "max_steps", taskId: "tsk_other" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_other", "max_steps");
    expect(workflowRunClose).not.toHaveBeenCalledWith("tsk_1", "max_steps");
  });

  it("names the advice's step bound in the sentence, not a hardcoded 20", async () => {
    // The reason the verdict grew `maxSteps` and the advice inherited it: TypeScript does
    // not know the shipped fallback, so a sentence that says "20" is a number this side of
    // the wire invented. A Space configured at 7 must read 7.
    answerWith(
      refusal("max_steps", { stop: "max_steps", maxSteps: 7 }),
    );
    await advanceWorkflowChainOnSettle(settle());
    const sentence = lines().find((t) => /max_steps/.test(t)) ?? "";
    expect(sentence).toContain("7");
    expect(sentence).not.toContain("20");
  });

  it("names the advice's ceiling in the sentence, not a hardcoded $10", async () => {
    answerWith(
      refusal("cost_ceiling", { stop: "cost_ceiling", ceilingUsd: 3.25 }),
    );
    await advanceWorkflowChainOnSettle(settle());
    const sentence = lines().find((t) => /cost_ceiling/.test(t)) ?? "";
    expect(sentence).toContain("$3.25");
    expect(sentence).not.toContain("$10");
  });

  it("does not claim a ceiling it was not given", async () => {
    // `ceilingUsd: null` means NO figure to quote. Under the shipped fallback no current
    // Space means that, but the type allows it, and `$0` / `$null` would each describe a
    // guard that did not run.
    answerWith(
      refusal("cost_ceiling", { stop: "cost_ceiling", ceilingUsd: null }),
    );
    await advanceWorkflowChainOnSettle(settle());
    const all = lines().join("\n");
    expect(all).toContain("cost_ceiling");
    expect(all).not.toMatch(/\$0\b/);
    expect(all).not.toContain("null");
  });

  it("moves nothing when the advice call itself fails", async () => {
    // The conservative half, and the reason the caller's `.catch` is a belt and not a
    // fallback move. When the decider rejects this side cannot know whether the step
    // landed, so it will NOT invent a `stop_reason` for a write it did not read, and it
    // certainly will not move a card on the strength of an answer it never saw. The caller
    // reports the failure in the transcript; the card stays.
    vi.mocked(workflowAdvanceAdvice).mockRejectedValue(new Error("db is busy"));
    await expect(advanceWorkflowChainOnSettle(settle())).rejects.toThrow("db is busy");
    expect(moveTask).not.toHaveBeenCalled();
    expect(workflowRunClose).not.toHaveBeenCalled();
    expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
    const research = useTasks
      .getState()
      .boardsBySpace[SPACE]?.find((c) => c.stage.slug === "research");
    expect(research?.tasks.map((t) => t.task.id)).toContain("tsk_1");
  });
});

describe("the auto-advance chain — D20: the run closes only when the chain ends here", () => {
  it("`already_advanced` closes NOTHING and says NOTHING", async () => {
    // THE pin the plan asked for by name, and the spend bound's whole failure mode.
    //
    // Claim in column A counts step 1 and launches B. The settle then asks, and the dedupe
    // answers `already_advanced` — this link was taken. If this arm closed the run, the
    // NEXT link's step would find no open run and INSERT one at `steps = 1` with
    // `cost_usd` NULL, and NULL can never trip a ceiling. A 20-step bound becomes 20 steps
    // PER LINK and the ceiling becomes a per-link allowance: the guard ADR 0119 §3 and the
    // partial UNIQUE index `idx_workflow_runs_open` exist to prevent, failing open.
    //
    // The claim path owns this link and already spoke, so the transcript stays empty too:
    // a second voice for one event is noise a person learns to ignore.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      answerWith(refusal("already_advanced", { alreadyLaunched: true }));
      await advanceWorkflowChainOnSettle(settle());
      expect(workflowRunClose).not.toHaveBeenCalled();
      expect(lines()).toHaveLength(0);
      expect(moveTask).not.toHaveBeenCalled();
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
      // And it is NOT the unknown-reason arm. `already_advanced` is the ORDINARY outcome of
      // claim-then-settle — it happens on every link of every chain that works — so
      // logging it as a reason this build cannot speak would put a console error on every
      // successful advance, which is how a real error comes to be ignored. This line is
      // what makes the arm's own early return load-bearing rather than merely equivalent:
      // delete it and the four assertions above are unchanged (the unknown arm is gated on
      // `alreadyLaunched` too), and only this one tells the two paths apart.
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a ceiling that trips on a link that ALREADY launched says so and does not close", async () => {
    // The second symptom of the same reset. `alreadyLaunched` is the discriminator and not
    // `reason`, precisely because `cost_ceiling` and `already_advanced` are mutually
    // exclusive answers from ONE call and a ceiling stop on a launched link still must not
    // close. The refusal is true and worth saying; the close is the bug.
    answerWith(
      refusal("cost_ceiling", { stop: "cost_ceiling", alreadyLaunched: true }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunClose).not.toHaveBeenCalled();
    const sentence = lines().find((t) => /cost_ceiling/.test(t)) ?? "";
    expect(sentence).toContain("$10.00");
  });

  it("an unrecognised reason on a launched link speaks without closing", async () => {
    // The close gate is on the arm and not inside the sentence lookup, so an unknown
    // reason from a launched link cannot reach `stopChain` by falling through.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      answerWith(
        refusal("budget_exhausted", { alreadyLaunched: true }),
      );
      await advanceWorkflowChainOnSettle(settle());
      expect(workflowRunClose).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("closes an un-launched refusal, so the run does not leak into the next chain", async () => {
    // The other side of the same gate, stated so the gate is not read as "never close":
    // `alreadyLaunched: false` is the ordinary refusal and it closes exactly as it always
    // did. Without this, a chain that stopped for real would hand its steps and cost to the
    // next chain this card ever starts.
    answerWith(
      refusal("unclaimed", { alreadyLaunched: false }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "unclaimed");
  });
});

describe("the auto-advance chain — the cost figure", () => {
  it("passes null, never 0, when the Session reported no figure", async () => {
    // ADR 0082 from the CALLER's side, and it matters MORE now that this is the only
    // ceiling evaluation left in the tree. The additive write is `COALESCE(cost_usd, 0.0)
    // + ?`, so a `0` turns "unbilled" into "billed zero" and permanently arms a ceiling
    // against a chain that has never reported money. T6a pins that a NULL-cost chain
    // cannot trip the ceiling; a `0` here would undo that from this side while every Rust
    // test stayed green.
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", null);
  });

  it("passes the live figure when the turn reported one", async () => {
    // Read through `costUsdOf`, the file that owns the `NULL` ≠ `0` rule and the
    // map-first / row-fallback precedence — not a raw map read, which would miss a
    // stored session's figure entirely.
    useInteractive.setState({ cost: { sess_new: { cost: 0.42, costUsd: 0.42 } } });
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", 0.42);
  });

  it("falls back to the stored row's figure when no frame arrived", async () => {
    // The cost map is in-memory only and boot hydrates none of it, so a row-only figure
    // is the normal case for a resumed Session; a raw `cost[id]` read answers `null` for
    // money that was genuinely spent.
    useSessions.setState({
      sessions: [
        { sessionId: "sess_new", cwd: SPACE, costUsd: 1.5 } as never,
      ],
    });
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", 1.5);
  });

  it("passes the TURN's spend when the session had a figure before it", async () => {
    // The advice ADDS what it is handed, so a cumulative figure sums the cumulatives:
    // three links totalling $1, $2, $3 would record $6 against a ceiling set for $3 and
    // fire early. The before-snapshot is what makes the delta real, and this settle is the
    // only place in the tree that holds one (D18) — which is what makes the ceiling lag by
    // at most one turn's delta rather than never trip.
    useInteractive.setState({ cost: { sess_new: { cost: 3, costUsd: 3 } } });
    await advanceWorkflowChainOnSettle(settle({ costBeforeTurnUsd: 2 }));
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", 1);
  });

  it("passes null and not 0 when the figure went BACKWARDS across the turn", async () => {
    // A resumed row and a live frame can land in either order across a
    // `mergeRefreshedSessionRows` refresh, so the figure can go DOWN. The old floor
    // (`Math.max(0, …)`) turned that into a `0`, and `0` is not a neutral value on this
    // wire: the additive write turns an UNBILLED run into a BILLED-ZERO one — exactly the
    // write this function's `null` arm exists to prevent (ADR 0082; T6a pins that a
    // NULL-cost chain cannot trip its ceiling, and a `0` arms it from this side while every
    // Rust test stays green).
    useInteractive.setState({ cost: { sess_new: { cost: 1, costUsd: 1 } } });
    await advanceWorkflowChainOnSettle(settle({ costBeforeTurnUsd: 4 }));
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", null);
  });

  it("hands the SAME delta to a non-finishing settle's advice call", async () => {
    // The whitelist arm asks too, and a `0` there would arm the ceiling against an
    // unbilled chain on a path no other test walks. Same rule, same figure, one arm
    // further up the function.
    useInteractive.setState({ cost: { sess_new: { cost: 3, costUsd: 3 } } });
    await advanceWorkflowChainOnSettle(settle({ reason: "max_tokens", costBeforeTurnUsd: 2 }));
    expect(workflowAdvanceAdvice).toHaveBeenCalledWith("sess_new", 1);
  });

  it("costDeltaOf keeps 'no figure' distinct from 'zero', and 'no spend' from both", () => {
    // The arms of the rule, spelled once so the caller cannot re-fold them.
    expect(costDeltaOf(null, null)).toBeNull();
    expect(costDeltaOf(null, 0)).toBe(0);
    // `(0, 0)` is the FLAT case again with a figure on both sides — no spend to charge,
    // so `null` for the same reason as `(5, 5)`. It used to read `0`, and that pin was
    // already red before this file was touched: the floor it came from is the write the
    // paragraph below objects to.
    expect(costDeltaOf(0, 0)).toBeNull();
    expect(costDeltaOf(2, 5)).toBe(3);
    // A FLAT total is the ordinary "no frame arrived this turn" case — the figure never
    // moved, so this turn spent nothing that is not already on the record. `0` would
    // write `COALESCE(cost_usd, 0.0) + 0` and arm the ceiling against a run that has not
    // reported money for this link, so it is `null`.
    expect(costDeltaOf(5, 5)).toBeNull();
    // A BACKWARDS total (the row/live-frame ordering above) is `null` for the same
    // reason: the additive column would be charged a floor of `0`, i.e. billed-zero.
    expect(costDeltaOf(5, 2)).toBeNull();
    expect(costDeltaOf(0, 0.5)).toBe(0.5);
  });
});

describe("the auto-advance chain — a refused launch", () => {
  it("closes with launch_refused when the next column's Skill is missing", async () => {
    // THE REAL PATH: `launchTaskSession` THROWS for a Skill the catalog does not have,
    // because `expandMentions` leaves an unmatched token byte-identical and a literal
    // `$ghost` would read to the model as a skill call. The refusal happens BEFORE the
    // move, so the card must not have moved — a card parked in a column whose Session
    // never started is this repo's silent-green shape.
    //
    // `ghost` is spelled on the slice AND the advice's row because the mounted slice is
    // the one `launchTaskSession` reads for the Skill (see the "prefers the mounted
    // board's row" case); the point of the case is the REFUSAL and the paint, not which
    // row the Skill name came from.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("implement", { sortOrder: 2, skill: "ghost" }),
    );
    answerWith(advice({ destination: stage("implement", { skill: "ghost" }) }));
    await advanceWorkflowChainOnSettle(settle());
    // The close is what the runtime awaits; the sentence is appended immediately after
    // it resolves, so both are flushed together rather than read on the same tick.
    await vi.waitFor(() =>
      expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
    );
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "launch_refused");
    // A missing Skill throws BEFORE the move is resolved, so the card never moved — and
    // the slice proves it independently of the mock: the card is still in `research` and
    // `implement` is still empty, so `moveTask`'s optimistic paint never happened. A
    // card parked in a column whose Session never started is the silent-green shape.
    expect(moveTask).not.toHaveBeenCalled();
    const columns = useTasks.getState().boardsBySpace[SPACE]!;
    expect(
      columns.find((c) => c.stage.slug === "research")?.tasks.map((t) => t.task.id),
    ).toContain("tsk_1");
    expect(
      columns.find((c) => c.stage.slug === "implement")?.tasks ?? [],
    ).toHaveLength(0);
  });

  it("closes with launch_refused when the backend REFUSES the move", async () => {
    // THE SWALLOWED REFUSAL. `useTasks.moveTask` catches the `move_task` rejection,
    // lands it in `error`, reverts the slice and RESOLVES — which is what a drag handler
    // needs (a dropped card must not throw out of a drop handler), but which was invisible
    // to `launchTaskSession`: it awaited the call and then started a Session anyway. So a
    // `StrictMoveRefused` produced a card that stayed put while a Session ran whose
    // `<task stage="…">` block named the column the card was NOT in, and `finishLink` read
    // that as a success and closed the run `manual`.
    //
    // The reachable shape is the one the comment in `launchTaskSession` names: the board
    // slice this window holds disagrees with the stored `next_slugs` the chain aimed at
    // (an edge edited in another window, and `board_strict` is ON so the gate is live).
    // `moveTask`'s own guard is NOT what is exercised here — the destination IS in the
    // slice, so the store paints and calls the command; it is the command that refuses.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("implement", { sortOrder: 2, skill: "implement" }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(moveTask).mockRejectedValue({
        kind: "invalid",
        message: "move from `research` to `implement` is not a legal transition",
      });
      await advanceWorkflowChainOnSettle(settle());
      await vi.waitFor(() =>
        expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
      );
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "launch_refused");
      // The revert put the card back, so the slice proves the refusal.
      const columns = useTasks.getState().boardsBySpace[SPACE]!;
      expect(
        columns.find((c) => c.stage.slug === "research")?.tasks.map((t) => t.task.id),
      ).toContain("tsk_1");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("closes with launch_refused when the slice is stale (the column vanished)", async () => {
    // D19's guard rail. `resolveStage` has TWO refusals and only ONE of them is trusted
    // for an advice-driven caller: a NEVER-LOADED slice becomes a write, a LOADED slice
    // without the column stays a note, because that is the case `TaskDetailDialog` renders
    // as a note and not an error. With no card to hold and no human to read a note, the
    // chain's arm must still record the refusal rather than launch on a column this window
    // can see is gone.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("done", { sortOrder: 3 }),
    );
    await advanceWorkflowChainOnSettle(settle());
    await vi.waitFor(() =>
      expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
    );
    // The move verb was never reached — the refusal is this side's, and it is the honest
    // one for a slice that positively does not have the column.
    expect(moveTask).not.toHaveBeenCalled();
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "launch_refused");
  });

  it("closes NOTHING on a link that already launched, whatever the launch's outcome is", async () => {
    // F4. The module header claims every close is gated on `alreadyLaunched`, and three
    // of `finishLink`'s closes were not: they were safe only because Rust's arm 3 returns
    // `already_advanced` BEFORE its arms 6/7, so an `advance: true` payload always carries
    // `alreadyLaunched: false`. That is an implicit CROSS-LANGUAGE invariant, and it is
    // asserted nowhere in TypeScript — so it is exactly the kind of thing that breaks
    // green when the Rust arm order changes.
    //
    // DEFENSIVE pin, not a claim about what Rust emits today: an `advance: true` +
    // `alreadyLaunched: true` payload is one this side must survive without touching the
    // run. Closing a run that already launched resets `cost_usd` to NULL and hands the
    // next link a fresh `steps = 1`, which turns a 20-step bound into 20 steps PER LINK —
    // the spend bound failing open. The sentence still goes out (the refusal is true);
    // only the close is withheld, which is D20's rule spelled the same way arm 5 spells it.
    useTasks.setState({ boardsBySpace: {} });
    answerWith(advice({ alreadyLaunched: true }));
    await advanceWorkflowChainOnSettle(
      settle({ launch: async () => ({ sessionId: null, note: null }) }),
    );
    await vi.waitFor(() =>
      expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
    );
    expect(workflowRunClose).not.toHaveBeenCalled();
  });

  it("closes NOTHING on a launched link whose move was skipped (the note arm)", async () => {
    // The second ungated close, and the arm that reaches it WITHOUT a malformed payload:
    // `outcome.note` non-null means the destination was missing from a LOADED slice, and
    // the guard is the same field on the same advice. Say it, do not close it.
    answerWith(advice({ alreadyLaunched: true }));
    await advanceWorkflowChainOnSettle(
      settle({
        launch: async () => ({
          sessionId: "sess_other",
          note: "This Space has no `implement` column, so T3 stayed in `research`.",
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
    );
    expect(workflowRunClose).not.toHaveBeenCalled();
  });

  it("closes NOTHING and says NOTHING on a launched link that would end the chain", async () => {
    // The third ungated close, and the one that fires on EVERY successful advance into a
    // non-auto column — so the gate had to be added without breaking the ordinary close,
    // which the first case of the `advancing` block still pins for the normal payload.
    //
    // This arm is SILENT rather than spoken, and that is the honest half rather than a
    // shortcut: `manual`'s sentence ends "so the chain ends here", which is precisely the
    // claim the withheld close refuses to make. A launched link keeps its run open for the
    // link that already launched, which is arm 4's rule (`already_advanced` closes nothing
    // and says nothing) applied to the same field.
    answerWith(advice({ alreadyLaunched: true }));
    await advanceWorkflowChainOnSettle(settle());
    // Flushed through the launch (the real one, so the card genuinely moved) rather than
    // assumed — and the close is the thing under test, not the timing.
    await vi.waitFor(() =>
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1),
    );
    expect(workflowRunClose).not.toHaveBeenCalled();
    expect(lines().some((t) => /manual/.test(t))).toBe(false);
  });

  it("closes with launch_refused when the SLICE-FREE move is refused (no board anywhere)", async () => {
    // F3's chain-side half, and the arm the D19 defect class lives in. With
    // `boardsBySpace: {}` the launch takes `taskMove`'s slice-free arm, whose only
    // signal is its return value: a refused `move_task` (a `board_strict` board whose
    // edge does not exist) answers `null`, `launchTaskSession` compares it against the
    // slug it aimed at and THROWS, and this file's `finishLink` records
    // `launch_refused`.
    //
    // The no-slice headline case above reaches the same arm on the SUCCESS path only, so
    // before this pin the refusal path was pinned at the verb (`taskMove.test.ts`) and
    // nowhere above it — a mutation returning `toStageSlug` from the verb's `catch`
    // leaves 167 tests green and turns a refused move into a `manual` close, i.e. a
    // record that says "the card moved to Implement" for a card that never moved.
    useTasks.setState({ boardsBySpace: {} });
    vi.mocked(moveTask).mockRejectedValue({
      kind: "strict_move_refused",
      message: "research does not lead to implement",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await advanceWorkflowChainOnSettle(settle());
      await vi.waitFor(() =>
        expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
      );
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "launch_refused");
      // The refusal is the BACKEND's, so the verb was reached — unlike the stale-slice
      // case above, which refuses this side and never calls the command.
      expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement");
      // And nothing launched: a card that did not move must not start the destination's
      // Session, or the run records a move the database refused.
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
      expect(vi.mocked(workflowRunClose).mock.calls).toEqual([["tsk_1", "launch_refused"]]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("closes with launch_refused when NOTHING is launching the card (a genuine refusal)", async () => {
    // THE OTHER REFUSAL, and the reason the outcome is READ and not merely caught:
    // `launchTaskSession` answers `{ sessionId: null }` when its in-flight guard trips and
    // NOBODY is registered behind the guard. A guard trip is a RETURN, not a throw, so a
    // `try`/`catch` alone would call this a success.
    //
    // ── WHAT THIS PIN USED TO SAY, and why the shape it kept is the true one.
    // It used to read "when the launch answers no sessionId", on the premise that any
    // `{ sessionId: null }` was a refusal. That premise is what this pin existed to catch
    // for the OTHER door: a trip caused by the chain's OWN pending claim used to answer
    // `null` too, and closing on it handed the next link a fresh run at `steps = 1` with
    // `cost_usd` NULL — the step bound and the cost ceiling restarting per link, i.e. the
    // spend bound failing open, beside a false "could not start a Session in Implement".
    // `taskLaunch` now answers an other-door trip with the HOLDER'S OUTCOME, so a `null`
    // reaching this arm means one of two things, and BOTH are a step that did not move the
    // card: nobody is launching it, or the other door tried and launched nothing (its card
    // read failed, its Skill was missing). Either way the close is right, so the
    // assertions are unchanged and only the SHAPE THE CASE NAMES is corrected. The
    // other-door case is pinned where it is actually decided —
    // `taskLaunch.claim.test.ts`'s reservation block — and, at this level, in the case
    // below: one launch, no sentence, and NO CLOSE.
    await advanceWorkflowChainOnSettle(
      settle({ launch: async () => ({ sessionId: null, note: null }) }),
    );
    await vi.waitFor(() =>
      expect(lines().some((t) => /launch_refused/.test(t))).toBe(true),
    );
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "launch_refused");
    // And the sentence says only what this arm can know. A guard trip means ANOTHER
    // launch of this card is in flight — and that launch may well have MOVED the card, so
    // "the card is where it was" is false here. `finishLink`'s one close sentence is
    // therefore about THIS step ("not moved by this step"), which every refusal arm can
    // say truthfully: the Skill-missing arm throws before the move, the refused-move arm
    // reverted its own paint, and this arm is not the one that moved anything.
    const sentence = lines().find((t) => /launch_refused/.test(t)) ?? "";
    expect(sentence).toContain("not moved by this step");
    expect(sentence).not.toMatch(/is where it was/);
  });

  it("does NOT close when the claim holds the card: the settle inherits its launch", async () => {
    // THE RUN STAYS OPEN, end to end through both real doors. The card's `mark_done` claim
    // is mid-flight — parked on `getTask`, holding the card's key across three IPC reads —
    // and the SETTLE arrives inside that window and asks for the same launch. Pre-fix that
    // trip answered `{ sessionId: null }`, this file recorded `launch_refused`, and
    // `workflowRunClose` CLOSED THE LIVE RUN; the next link's step verb then re-INSERTed at
    // `steps = 1` with `cost_usd` NULL, so `max_steps` and the ceiling restarted per link.
    //
    // THE FIX IS UPSTREAM OF THIS FILE, and that is the point of pinning it here:
    // `launchTaskSession`'s guard-trip arm awaits the pending claim and returns ITS outcome,
    // so the chain continues with a real `sessionId`, the link is not refused, and the only
    // thing `finishLink` is asked about is a launch that worked. `workflowRunStep` counts the
    // step inside Rust, so the TypeScript-side fact that preserves the budget is exactly the
    // one asserted below: NO `workflowRunClose` call. `advance: true` into a column that IS
    // `auto`, so a correct chain has no reason to close at all — the chain continues, and the
    // run it continues on is the run that already carries the step count and the cost.
    useTasks.setState({ boardsBySpace: {} });
    answerWith(advice({ destination: stage("implement", { skill: "implement", auto: true }) }));
    claimCatalogs();
    const cardRead = deferred(() => taskRow({ stageSlug: "research" }));
    vi.mocked(getTask).mockImplementation(() => cardRead.promise);

    // THE CLAIM DOOR takes the card's key and parks on its first read.
    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advice()))).toBe(true);

    // THE SETTLE DOOR arrives inside the window. The chain's launch is the real
    // `launchTaskSession`, and it trips on the claim's key.
    await advanceWorkflowChainOnSettle(settle());
    expect(startTaskSession).not.toHaveBeenCalled();

    // The claim carries its launch out, and the chain is handed THAT Session.
    cardRead.resolve();
    await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement"));
    // Flushed past the dispatch and the settle edge the claim's own launch fires, so the
    // assertions below read a settled chain rather than one still on the wire.
    await macrotask();
    // EXACTLY ONE launch for the link — the reservation's job, unchanged by the fix.
    expect(startTaskSession).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    // NO REFUSAL AND NO CLOSE: the run the next link steps is still the open one, so its
    // `steps` and `cost_usd` carry over instead of restarting.
    expect(lines().some((t) => /launch_refused/.test(t))).toBe(false);
    expect(workflowRunClose).not.toHaveBeenCalled();
  });

  it("says nothing when the launch starts a Session", async () => {
    // The negative for the case above: `{ sessionId }` present is a success, and a chain
    // that reported a refusal on a launch that worked would be a lie in the transcript.
    await advanceWorkflowChainOnSettle(settle());
    await vi.waitFor(() =>
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "manual"),
    );
    // Exactly one close, and it is `manual` and not `launch_refused`: a chain that
    // reported a refusal on a launch that worked would be a lie in the transcript.
    expect(vi.mocked(workflowRunClose).mock.calls).toEqual([["tsk_1", "manual"]]);
    expect(lines().some((t) => /launch_refused/.test(t))).toBe(false);
  });
});
