import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeAdvanceAdvice,
  hasPendingClaim,
  launchTaskSession,
  resetTaskLaunchInFlight,
  type TaskLaunchCatalogs,
} from "./taskLaunch";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import { useSessions } from "./sessions";
import { useTasks } from "./tasks";
// The ONE reader of Rust's advance advice — used here to build the destination the claim's
// advice carries, so the follow-up launch in the reservation cases is the SAME destination
// the claim was handed rather than a hand-written copy of it.
import { destinationOf } from "./advanceAdvice";
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
  type AcpSessionUpdate,
  type AdvanceAdvice,
  type SessionInfo,
  type SkillInfo,
  type StopReason,
  type TaskRow,
} from "../lib/tauri";

/**
 * `src/store/taskLaunch.ts` — the CLAIM half: `consumeAdvanceAdvice` and its async
 * worker `carryOutClaim`. ADR 0113 mirror naming beside `taskLaunch.test.ts`, which
 * owns the launch half (`launchTaskSession`, `createTaskFromDraft`, the settle edge).
 *
 * WHY THIS FILE EXISTS SEPARATELY: the parent reached 998 code lines against the
 * 1,000-line test gate (`docs/agents/file-size.md`, ADR 0112), and the claim path is a
 * SEPARATE SUBJECT from the launch — a second entry point into the same executor,
 * reached from `App.tsx`'s session-update batcher rather than from a click. Splitting
 * on that boundary is what `docs/agents/test-counts-and-splits.md` asks for; the size
 * was the occasion, the subject is the reason.
 *
 * THE CONTRACT UNDER TEST: a live `tool_call_update` whose `rawOutput.details` carries
 * `advanceAdvice` MOVES A CARD AND STARTS A SESSION, and every failure on the way is
 * reported in the CLAIMANT's transcript rather than lost — because the board may not be
 * mounted, so the transcript is the only surface guaranteed to be on screen.
 *
 * WHY THE BARREL IS MOCKED WITH THE WRAPPER NAMES: the factory spreads
 * `importActual`, so an un-mocked export resolves to the REAL wrapper, which calls
 * `invoke`, which rejects in jsdom (`window.__TAURI_INTERNALS__` is undefined) —
 * AGENTS.md's boot-mock trap. The factory lists exactly the arms this subject drives:
 * the card read, the two catalog reads, the move, the start, the send, the badge refetch
 * and the two chain verbs the settling turn reaches.
 *
 * TWO RESETS, both load-bearing and inherited from the parent: `resetStores()` plus the
 * tasks store's own `reset()`, because `src/test/resetStores.ts` cannot reach a
 * module-scope `let` and `store/tasks.ts` guards its `load` epoch with one.
 */
const SPACE = "/w/alpha";

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // THE READS `carryOutClaim` makes before it can dispatch. Every one is a raw
    // `invoke` wrapper, and every one sits inside the `try` whose `catch` is F1's
    // subject — an un-mocked read would pin a jsdom rejection instead of the failure
    // the case means to install.
    getTask: vi.fn().mockResolvedValue(null),
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    // THE WRITE AND THE LAUNCH. `moveTask` is the store action's wrapper (the claim
    // path runs `taskMove`'s slice-free arm, D19); `startTaskSession` / `sendPrompt`
    // are `startAndSendLinked`'s two calls; `taskNumbers` is the badge refetch
    // `startAndSendLinked` awaits after the dispatch.
    moveTask: vi.fn(),
    startTaskSession: vi.fn(),
    sendPrompt: vi.fn(),
    taskNumbers: vi.fn().mockResolvedValue([]),
    // THE CHAIN VERBS the settling turn reaches through `sendLaunchMessage` →
    // `advanceWorkflowChainOnSettle`. `workflowAdvanceAdvice` defaults to `unclaimed`
    // — Rust's answer for a Session that never called `mark_done` — so a claim case
    // settles without starting a second chain it never asked about.
    workflowAdvanceAdvice: vi.fn(),
    workflowRunClose: vi.fn().mockResolvedValue(undefined),
  };
});

/** The order a mock was first called in, typed (same reason the parent spells it:
 *  `Mock<Procedure>` does not expose `invocationCallOrder` in this repo's typings). */
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
    // The BODY is what `buildBlock` puts inside the `<skill>` element, and the case
    // below looks for the element, so keep it real rather than empty.
    body: `${name.toUpperCase()} BODY`,
    disableModelInvocation: false,
    shadowed: [],
  };
}

/** A refusal, spelled through the nine wire keys `shape.rs` pins. The default answer
 *  is `unclaimed`, which is what keeps a claim case from following its own launch into
 *  a second chain. */
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

/** The destination the `advancing()` advice carries, read through the ONE reader of that
 *  payload. The reservation cases launch the SAME card into the SAME column twice — once
 *  through the claim and once through `launchTaskSession` directly — so the second launch
 *  is built from this rather than from a hand-written copy of the row. */
const CLAIM_DESTINATION: TaskLaunchDestination = destinationOf(advancing())!;

/** The catalogs a direct `launchTaskSession` call needs for the same launch. A claim reads
 *  its catalogs through the mocked barrel (`claimCatalogs`); the launch verb takes them as
 *  an ARGUMENT, so a follow-up launch hands over the `implement` Skill itself —
 *  `missingSkill` refuses a launch whose Skill the catalog lacks. */
const CLAIM_CATALOGS = (): TaskLaunchCatalogs => ({
  skills: [skill("implement")],
  agents: [],
});

/** The catalog a SUCCESSFUL claim needs. The shared mock answers `[]` for both catalog
 *  reads (which is what keeps the ordinary launch cases honest about a missing Skill),
 *  and `missingSkill` REFUSES a launch whose Skill the catalog lacks — so a case that
 *  means a successful claim has to hand over `implement` itself.
 *
 *  MODULE SCOPE, not inside the `describe`: two blocks drive the claim now — the original
 *  six cases and the reservation block below — and a fixture either of them needs is not
 *  one to duplicate. */
function claimCatalogs(): void {
  vi.mocked(listSkills).mockResolvedValue([skill("implement")]);
  vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([]);
}

/** A `tool_call_update` carrying `next` at `rawOutput.details.advanceAdvice` —
 *  the carrier `normalize.rs` ships (`tool_execution_end{result}` → `ToolResult`
 *  `{content, details, isError}` → normalised onto a `tool_call_update`). */
function claimFrame(next: AdvanceAdvice, sessionUpdate = "tool_call_update"): AcpSessionUpdate {
  const details = { advanceAdvice: next };
  const content = [{ type: "text", text: "advanced" }];
  return { sessionUpdate, toolCallId: "tc_1", status: "completed", rawOutput: { content, details } } as AcpSessionUpdate;
}

/** Make the decider answer `next` for the FIRST Session that asks and `UNCLAIMED`
 *  afterwards — the shape `taskLaunch.test.ts` and `workflowChain.test.ts` both use,
 *  because a constant here would model a decider with no dedupe and send a real-launch
 *  case into an unbounded chain. */
function answerOnce(next: AdvanceAdvice): void {
  let asked = false;
  vi.mocked(workflowAdvanceAdvice).mockImplementation(async () => {
    if (asked) return UNCLAIMED;
    asked = true;
    return next;
  });
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  // A module-scope Set is not store state, so `resetStores()` cannot reach it.
  resetTaskLaunchInFlight();
  vi.clearAllMocks();
  useSessions.setState({ sessions: [], historySessions: [], archivedSessions: [] });
  // Every default is restated AFTER `clearAllMocks`, for the reason the parent records:
  // a case that installs a one-shot rejection must not decide what THIS case answers.
  vi.mocked(startTaskSession).mockResolvedValue(info());
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
  vi.mocked(taskNumbers).mockResolvedValue([]);
  vi.mocked(workflowAdvanceAdvice).mockResolvedValue(UNCLAIMED);
  vi.mocked(getTask).mockResolvedValue(taskRow());
});

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so a bare
// `import "node:fs"` does not typecheck. The idiom `boardReadyMarks.test.ts`,
// `tauriBoundary.test.ts` and `classNameConvention.test.ts` use, borrowed here for the ONE
// assertion below that can only be made against a function's SOURCE: that nothing `await`s
// between the claim's decision and its reservation.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/** Strip JS comments before scanning — the helper those files use. A symbol that appears
 *  only in a doc-comment is PROSE about a write, not a write, and this repo's own guard
 *  suite records why an unstripped walk mis-counts (`tauriBoundary.test.ts:24`). */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** The body of `consumeAdvanceAdvice`, comments stripped, read out of the module it
 *  guards. A slice and not the whole file: the assertion is about the ONE function that
 *  decides and dispatches, and `carryOutClaim` below it is allowed to await all it likes. */
function consumeAdvanceAdviceSource(): string {
  const source = stripJsComments(readFileSync("src/store/taskLaunch.ts", "utf8"));
  const start = source.indexOf("export function consumeAdvanceAdvice");
  const end = source.indexOf("async function carryOutClaim");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** A macrotask. The claim's three reads are IPC round trips in production and microtasks in
 *  the mocked suite, and the race under test is a TIMING race — so the cases that manufacture
 *  an ordering defer by a real task rather than hoping microtasks land in the right order. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The transcript lines one Session holds, as text (the claim cases need the
 *  CLAIMANT's transcript, which is not the Session the launch starts). */
function lines(sessionId: string): string[] {
  return (useSessions.getState().messages[sessionId] ?? []).map((m) => (m as { text?: string }).text ?? "");
}

describe("consumeAdvanceAdvice — the claim path", () => {
  it("starts the Session the advice names from a tool_call_update's rawOutput.details", async () => {
    // THE HEADLINE, and the one thing no other file could prove: a frame arriving on
    // the live path MOVES A CARD AND STARTS A SESSION. The claimant's Session
    // (`sess_claim`) is not the Session that gets started (`sess_new`) — the advice
    // names the card, and the claimant's transcript is where a refusal belongs.
    //
    // No board slice is seeded, deliberately: the window a claim settles in has no
    // board mounted (`App`'s view ternary), which is D19, and this launch has to work
    // anyway through `taskMove`'s slice-free arm.
    claimCatalogs();
    const dispatched = consumeAdvanceAdvice("sess_claim", claimFrame(advancing()));
    expect(dispatched).toBe(true);
    // The card first (the claim path holds only a Session id), then the launch.
    await vi.waitFor(() => expect(getTask).toHaveBeenCalledWith("tsk_1"));
    await vi.waitFor(() =>
      expect(startTaskSession).toHaveBeenCalledWith(SPACE, "tsk_1", null),
    );
    expect(firstCallOrder(vi.mocked(getTask))).toBeLessThan(firstCallOrder(vi.mocked(startTaskSession)));
    // And the first message carries the DESTINATION column's Skill, not the
    // claimant's — the row the advice carried is what configures the new Session.
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendPrompt).mock.calls[0]![1]).toContain("$implement");
    // The move is the slice-free arm of the real verb (no slice exists to paint).
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement");
  });

  it("returns false and launches nothing for a `tool_call` frame, a non-advice payload, and an `already_advanced` advice", async () => {
    // THREE silent arms, one case, because they all answer `false` and the caller
    // does not care which: the announcement frame (the tool has not run, so nothing
    // has been decided), a frame whose `details` carries no advice (every other tool
    // in the app), and the dedupe's answer (the claim already launched this link —
    // launching it again from the settle would start TWO Sessions for one edge).
    claimCatalogs();
    const already = advancing({
      advance: false,
      reason: "already_advanced",
      destination: null,
      alreadyLaunched: true,
    });

    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing(), "tool_call"))).toBe(false);
    expect(consumeAdvanceAdvice("sess_claim", claimFrame(refusal("unclaimed")))).toBe(false);
    expect(consumeAdvanceAdvice("sess_claim", claimFrame(already))).toBe(false);
    const noAdvice = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_2",
      rawOutput: { content: [], details: { somethingElse: true } },
    } as AcpSessionUpdate;
    expect(consumeAdvanceAdvice("sess_claim", noAdvice)).toBe(false);

    // Nothing dispatched, so nothing downstream ran — not a card read, not a Session.
    await Promise.resolve();
    expect(getTask).not.toHaveBeenCalled();
    expect(startTaskSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("reports a card read that fails, in the claimant's Session, and does not reject unhandled", async () => {
    // F1. `await getTask(taskId)` sits OUTSIDE the only internal `try`, and nothing
    // upstream awaits, so before this pin an IPC failure here was reported NOWHERE:
    // the launch was lost with no console line and no transcript line — the exact
    // silent-green shape this feature exists to remove. The claimant's Session is the
    // only guaranteed surface (the board may not be mounted), so the sentence goes
    // there through the house mechanism.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      claimCatalogs();
      vi.mocked(getTask).mockRejectedValue({ kind: "command", message: "get_task failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      const all = lines("sess_claim").join("\n");
      expect(all).toContain("get_task failed");
      expect(all).toContain("nothing launched");
      expect(startTaskSession).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports a catalog read that fails rather than launching on a catalog it cannot read", async () => {
    // The second unguarded read: `Promise.all([listSkills, listAgentDefinitionsForSpace])`.
    // A wrong `skills` list must not become a degraded launch — `missingSkill` refuses
    // it — so a failed read refuses too, and says so.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(listSkills).mockRejectedValue({ kind: "command", message: "skill scan failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      const all = lines("sess_claim").join("\n");
      expect(all).toContain("skill scan failed");
      expect(startTaskSession).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the LAUNCH diagnosis when the launch fails and the transcript write fails too", async () => {
    // F1. The inner `catch` of `carryOutClaim` reports a refused launch, and its
    // `addSystemLine` sits UNGUARDED inside the outer `try`. So the shape "the launch
    // failed AND the transcript write threw" threw out of the inner reporter and into the
    // OUTER catch — which prints "could not be read (the card, the skills or the agents)"
    // and appends a second line saying NOTHING WAS LAUNCHED. Both halves are false here:
    // every read succeeded, and the card may well have moved before the start failed. An
    // operator reading "nothing launched; the card stayed where it was" on a card the
    // chain did move is a worse outcome than no line at all.
    //
    // The property under test is therefore the WORDING, not just the loudness: the
    // launch-failure sentence must be the one that is said, the read-failure sentence
    // must NOT be said, and the reporter must be attempted ONCE rather than a second
    // time under a wrong diagnosis.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const addSystemLine = vi.spyOn(useSessions.getState(), "addSystemLine");
    addSystemLine.mockImplementation(() => {
      throw new Error("transcript unavailable");
    });
    try {
      claimCatalogs();
      // The reads all succeed (the defaults: `getTask` answers a row, both catalogs
      // answer through `claimCatalogs`), the MOVE succeeds through the slice-free arm,
      // and the START fails — so the failure is a launch failure and nothing else.
      vi.mocked(startTaskSession).mockRejectedValue({
        kind: "command",
        message: "start_task_session failed",
      });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("could not be carried out"),
          expect.anything(),
        ),
      );
      const said = consoleError.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      // THE WRONG DIAGNOSIS MUST NOT APPEAR. This is the whole case: the outer catch's
      // sentence is true of a failed READ and false of a failed launch.
      expect(said).not.toContain("could not be read");
      // The reporter's own failure is still LOUD somewhere (the belt's job) — the
      // guard's console line, not a rethrow into the outer catch.
      expect(said).toContain("could not be recorded");
      // And the transcript was written at ONCE, not twice: a second attempt under the
      // outer arm's sentence is the wrong-diagnosis line reaching the user.
      expect(addSystemLine).toHaveBeenCalledTimes(1);
      expect(startTaskSession).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
      addSystemLine.mockRestore();
    }
  });

  it("reports a failure the transcript itself could not record", async () => {
    // The `.catch` on the dispatch is the ONE owner of the case the body's `try` cannot
    // report: a throw from the REPORTER. Rejecting `addSystemLine` is how that is reached,
    // and the property under test is that nothing escapes unhandled — a rejection raised
    // inside the handler for a rejection is the same lost launch, one layer further out.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const addSystemLine = vi.spyOn(useSessions.getState(), "addSystemLine");
    addSystemLine.mockImplementation(() => { throw new Error("transcript unavailable"); });
    try {
      vi.mocked(getTask).mockRejectedValue({ kind: "command", message: "get_task failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      const loud = () => consoleError.mock.calls.some((c) => /could not be recorded/.test(String(c[0])));
      await vi.waitFor(() => expect(loud()).toBe(true));
    } finally {
      consoleError.mockRestore();
      addSystemLine.mockRestore();
    }
  });
});

/// THE CLAIM'S LAUNCH RESERVATION — the card's key in the module `inFlight` `Set`, taken
/// by `consumeAdvanceAdvice` SYNCHRONOUSLY and released by `carryOutClaim` on every arm.
///
/// ## The race this pins, in the tree's own words
///
/// Two paths can launch the same card for the same link. The **claim** reads the advice off
/// a `tool_call_update`, and `App.tsx` hands it over from inside a `requestAnimationFrame`
/// callback (`createBatchedSessionUpdate(…, (fn) => requestAnimationFrame(fn), onAdvice)`,
/// and `batchSessionUpdates.ts` calls `onAdvice` inside that scheduled callback). The
/// **settle** fires the instant `await sendPrompt(...)` resolves — `sendLaunchMessage`'s
/// `void advanceWorkflowChainOnSettle({…})`, which is NOT deferred by anything.
///
/// So the settle can launch first while the claim's advice is still sitting in the queue,
/// and the claim used to walk into it regardless: `destinationOf` gates on `advance` and
/// `destination !== null` and nothing else, and between the frame and the launch sit three
/// awaits (`getTask`, `listSkills`, `listAgentDefinitionsForSpace`). By the time the claim
/// reached `launchTaskSession`, the settle's launch had already RELEASED the key — it is
/// released at the dispatch, not at the return — so the guard that should have refused the
/// second launch was free. The card got TWO Sessions.
///
/// ## The fix these cases pin
///
/// The claim takes the key at the moment it DECIDES, in the same synchronous turn as that
/// decision, on the same key `launchTaskSession` guards on. Two paths that both hold the
/// one key cannot both launch, whichever order they arrive in, and it costs no IPC.
describe("consumeAdvanceAdvice — the claim's launch reservation", () => {
  /** A promise plus its resolver, for parking a mocked read or launch at a chosen instant.
   *  The race is a TIMING race and every mock in this file resolves immediately, so the
   *  orderings the production paths can reach have to be manufactured by hand — the same
   *  reason `taskLaunch.test.ts`'s settle case defers `sendPrompt` rather than trusting a
   *  synchronous one ("a synchronous `sendPrompt` manufactures the very ordering the guard
   *  exists for"). */
  function deferred<T>(value: () => T): { promise: Promise<T>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<T>((r) => {
      resolve = () => r(value());
    });
    return { promise, resolve };
  }

  it("does not launch a second Session when the settle path launched the card first", async () => {
    // THE HEADLINE. The settle wins the race and is still holding the card's key when the
    // rAF-deferred claim advice finally lands; the claim's reads then complete AFTER the
    // settle released that key at its dispatch. Before the fix the claim found the guard
    // free and launched anyway — TWO Sessions, TWO moves, TWO first messages for one link.
    //
    // This is the REAL settle edge, not a stand-in: `launchTaskSession` on `research` starts
    // the turn, `sendPrompt` resolves it, and `void advanceWorkflowChainOnSettle` asks Rust,
    // gets `advancing()`, and calls `finishLink` → `settle.launch` → `launchTaskSession` on
    // the SAME card. The chain's launch is the second `startTaskSession`, parked below so the
    // key is provably held at the instant the claim's frame is consumed.
    claimCatalogs();
    answerOnce(advancing());
    // Parked: the claim's first read, so the claim is mid-flight across the settle's release.
    const cardRead = deferred(() => taskRow());
    vi.mocked(getTask).mockImplementation(() => cardRead.promise);
    // The OUTER turn settles by hand (a real turn takes seconds); the chain's own turn is
    // inert because `answerOnce` answers its ask `unclaimed`. Its `sendPrompt` stays PARKED
    // for the whole case: `startAndSendLinked` releases the parent's guard at the dispatch,
    // so a send mock that resolves synchronously would let the parent finish its badge
    // refetch and be observed holding nothing — this case needs the settle provably IN
    // FLIGHT, holding `tsk_1`, at the instant the frame lands.
    let settleTurn!: (reason: StopReason) => void;
    let sends = 0;
    vi.mocked(sendPrompt).mockImplementation(() => {
      sends += 1;
      return sends === 1
        ? new Promise<StopReason>((resolve) => (settleTurn = resolve))
        : new Promise<StopReason>(() => {});
    });
    // The chain's launch of the card parks at the START, which is AFTER `moveTask` and
    // BEFORE the dispatch that releases the guard — so the key is held, observably, at the
    // instant the frame is consumed. It resolves with its OWN `SessionInfo`: a parked mock
    // that resolves `undefined` would crash `startAndSendLinked` one step later, and the
    // case would be pinning a `TypeError` instead of a launch.
    let chainStart!: (info: SessionInfo) => void;
    let starts = 0;
    vi.mocked(startTaskSession).mockImplementation(() => {
      starts += 1;
      return starts === 2
        ? new Promise<SessionInfo>((resolve) => (chainStart = resolve))
        : Promise.resolve(info());
    });

    void launchTaskSession(SPACE, taskRow(), "research", CLAIM_CATALOGS());
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    settleTurn("end_turn");
    await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(2));
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement");

    // ── THE FRAME LANDS. The claim's advice was queued behind the frame; the settle is
    // mid-launch and holds `tsk_1`. The claim has to notice, HERE and NOW — a check made
    // three IPC round trips later would be a check of a key the settle already released.
    // Pre-fix this answered `true` and dispatched a launch that walked in behind the
    // settle's own, because nothing on the claim's side consulted the guard.
    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(false);

    // The settle dispatches and releases at the dispatch; THEN the claim's reads land — the
    // exact ordering that used to produce the second Session.
    chainStart(info("sess_chain"));
    cardRead.resolve();
    await macrotask();
    await macrotask();
    // ONE Session for the link, ONE move into it, ONE first message.
    expect(startTaskSession).toHaveBeenCalledTimes(2);
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it("hands the settle's launch the claim's outcome when the claim reached the card first", async () => {
    // THE OTHER INTERLEAVING: the claim decides while the key is FREE, and the settle's
    // launch starts while the claim is still reading. The claim's reservation is what trips
    // the SETTLE's guard — and a trip caused by the OTHER CHAIN DOOR is NOT a refusal. The
    // claim registers itself in the pending-claim map when it takes the key, so the tripped
    // arm answers with the HOLDER'S OUTCOME instead of `NOTHING`: a real `sessionId`, one
    // Session for the link, and nothing for `finishLink` to refuse and close.
    //
    // THE BUG THIS PINS (the mirror of the one the reservation closed): the reservation made
    // the claim the HOLDER across three IPC round trips, and the settle was the party
    // refused. `NOTHING` could not say "someone else is already launching this card, and
    // here is what they did", so `finishLink` recorded `launch_refused` and CLOSED THE LIVE
    // RUN — and `workflow_runs`' `None` branch re-INSERTs the next link at `steps = 1` with
    // `cost_usd` NULL, which restarts `max_steps` and the cost ceiling per link. The spend
    // bound fails open, beside a false "could not start a Session in Implement".
    //
    // `launchTaskSession` is called directly here because that IS what the settle edge
    // calls: `sendLaunchMessage` wires `launch: (next) => launchTaskSession(…)`, and the
    // wiring itself is pinned in `taskLaunch.test.ts`'s settle-edge block.
    claimCatalogs();
    const cardRead = deferred(() => taskRow());
    vi.mocked(getTask).mockImplementation(() => cardRead.promise);

    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
    // The settle's launch of the same card, dispatched inside the claim's read window. NOT
    // awaited yet — it now waits on the holder, so awaiting it before releasing the claim
    // would be a test that hangs rather than a test that fails.
    const settled = launchTaskSession(
      SPACE,
      taskRow(),
      CLAIM_DESTINATION,
      CLAIM_CATALOGS(),
    );
    // It did not launch, and it did not refuse: it is waiting for the claim.
    expect(startTaskSession).not.toHaveBeenCalled();

    // The claim carries its own launch out, and the settle is handed THAT outcome.
    cardRead.resolve();
    await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    expect((await settled).sessionId).toBe("sess_new");
    // EXACTLY ONE launch for the link — the whole point of the reservation, preserved. The
    // settle awaits the claim's Session rather than starting its own.
    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not wait on the holder's TURN, only on its outcome", async () => {
    // THE DEADLOCK CHECK for the await Option A adds. `finishLink` awaits the launch's
    // OUTCOME and never its turn, and the header of both doors says why: `sendPrompt`
    // resolves on `agent_settled`, the merged `research` Skill ends on an `ask` gate, and
    // `AskQuestionCard` has no renderer outside `ChatStream`. Awaiting a promise that
    // awaits three IPC reads is safe; awaiting one that awaits a TURN is the wedge. So the
    // claim's `sendPrompt` is parked FOREVER here, and the racing launch still resolves —
    // because `startAndSendLinked` resolves the launch at the DISPATCH and `void`s the turn.
    claimCatalogs();
    vi.mocked(sendPrompt).mockImplementation(() => new Promise<StopReason>(() => {}));
    const cardRead = deferred(() => taskRow());
    vi.mocked(getTask).mockImplementation(() => cardRead.promise);

    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
    const settled = launchTaskSession(
      SPACE,
      taskRow(),
      CLAIM_DESTINATION,
      CLAIM_CATALOGS(),
    );
    cardRead.resolve();
    // The turn is parked and will never settle; the outcome is nonetheless delivered.
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect((await settled).sessionId).toBe("sess_new");
  });

  it("hands the racing launch a REFUSAL when the claim launched nothing", async () => {
    // The map entry carries the holder's OUTCOME, not a blanket success. A claim whose
    // reads failed started nothing, and a step that did not move the card is exactly what
    // `finishLink` must still record as `launch_refused`. A fix that answered "someone else
    // has it" with a fabricated `sessionId` would pass the case above and lie here.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(getTask).mockRejectedValue({ kind: "command", message: "get_task failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      const raced = await launchTaskSession(
        SPACE,
        taskRow(),
        CLAIM_DESTINATION,
        CLAIM_CATALOGS(),
      );
      expect(raced.sessionId).toBeNull();
      expect(startTaskSession).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("takes the reservation with no await between the decision and the key", async () => {
    // THE FIX'S SHAPE, asserted against the source. A reservation taken one microtask late
    // is a reservation the settle takes first, because the settle is not deferred at all
    // while the claim is deferred by a frame: the window is exactly the gap between them,
    // and ANY `await` inside `consumeAdvanceAdvice` re-opens it. A doc-comment cannot hold
    // that, so the guard reads the function.
    const source = consumeAdvanceAdviceSource();
    const guard = source.indexOf("inFlight.has(taskId)");
    const taken = source.indexOf("inFlight.add(taskId)");
    const dispatched = source.indexOf("carryOutClaim(");
    expect(guard).toBeGreaterThan(-1);
    expect(taken).toBeGreaterThan(guard);
    expect(dispatched).toBeGreaterThan(taken);
    // Nothing between the top of the function and the `add` may suspend — `await` or
    // `.then`, both of which hand the turn back to the settle.
    expect(source.slice(0, taken)).not.toMatch(/\bawait\b/);
    expect(source.slice(0, taken)).not.toMatch(/\.then\(/);
    // Comments are stripped by the scanner, so this says the CODE holds no await, not that
    // the file says so in prose.
    expect(source).not.toBe("");

    // ── AND THE PENDING-CLAIM REGISTRY SITS IN THAT SAME SYNCHRONOUS BLOCK.
    //
    // The other chain door answers a guard trip by awaiting the holder's outcome, which
    // only works if it can FIND the holder. A `pendingClaims.set` that landed a microtask
    // later — e.g. inside `carryOutClaim` — would be invisible to a settle that trips the
    // guard in the gap, and the gap is exactly the window this whole file is about: the
    // answer would fall back to a refusal and the run would close. So the insert is pinned
    // POSITIONALLY rather than by a timing test that could pass by luck: after the `add`,
    // and with nothing between the two that can suspend.
    const registered = source.indexOf("pendingClaims.set(taskId");
    expect(registered).toBeGreaterThan(taken);
    expect(source.slice(taken, registered)).not.toMatch(/\bawait\b/);
    expect(source.slice(taken, registered)).not.toMatch(/\.then\(/);
    // The registration is still inside the function that decides, not deferred into the
    // async half — `carryOutClaim`'s own body may await all it likes.
    expect(registered).toBeLessThan(source.length);
  });

  it("removes the pending-claim entry on every arm, including a successful claim", async () => {
    // THE SECOND LEAK, and the one the reservation's own release does NOT cover. The
    // `inFlight` key is released on every arm by `carryOutClaim`'s `finally`; the
    // pending-claim entry is SEPARATE state, and a stale entry outlives a released key. It
    // is a module `Map`, so it survives a component unmount and grows one entry per card
    // that ever claimed for the life of the app — and a stale entry is what a later guard
    // trip would read as "the other door owns this card", answering a dead claim's outcome
    // for a launch that is nothing to do with it. The fix's own new state therefore gets the
    // same per-arm net the reservation's leak pins demand, and the same test seam
    // (`resetTaskLaunchInFlight` is the module's documented seam for exactly this reason:
    // `src/test/resetStores.ts` cannot reach module scope).
    //
    // EVERY arm is walked, and the arms are the ones the existing `inFlight` pins walk: a
    // `getTask` rejection, a card the database does not have, a catalog read that fails, a
    // launch that refuses, and a SUCCESS — success being the arm where the entry is handed
    // to `launchTaskSession` rather than dropped, and therefore the arm most likely to be
    // forgotten.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      claimCatalogs();
      // Arm 1: `getTask` rejects.
      vi.mocked(getTask).mockRejectedValue({ kind: "command", message: "get_task failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(hasPendingClaim("tsk_1")).toBe(false);

      // Arm 2: `getTask` answers `null` — the card is gone.
      consoleError.mockClear();
      vi.mocked(getTask).mockResolvedValue(null);
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(hasPendingClaim("tsk_1")).toBe(false);

      // Arm 3: a catalog read rejects.
      consoleError.mockClear();
      vi.mocked(getTask).mockResolvedValue(taskRow());
      vi.mocked(listSkills).mockRejectedValue({ kind: "command", message: "skill scan failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(hasPendingClaim("tsk_1")).toBe(false);

      // Arm 4: the launch itself fails.
      consoleError.mockClear();
      vi.mocked(listSkills).mockResolvedValue([skill("implement")]);
      vi.mocked(startTaskSession).mockRejectedValue({
        kind: "command",
        message: "start_task_session failed",
      });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("could not be carried out"),
          expect.anything(),
        ),
      );
      expect(hasPendingClaim("tsk_1")).toBe(false);

      // Arm 5: SUCCESS — the entry is handed over, not leaked.
      vi.mocked(startTaskSession).mockResolvedValue(info());
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(hasPendingClaim("tsk_1")).toBe(false));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("registers the pending claim SYNCHRONOUSLY, at the instant the key is taken", async () => {
    // THE BEHAVIOURAL HALF of the source-scan pin above. A scan proves the `set` sits in the
    // right BLOCK; this proves the ENTRY IS VISIBLE BEFORE THE FIRST AWAIT RETURNS, which is
    // the only property the other chain door depends on when it trips the guard. A `set`
    // that ran a microtask late would satisfy the positional scan (it still sits between the
    // `add` and the dispatch) and still leave the window open, because the window this whole
    // file guards is one macrotask wide at its narrowest.
    claimCatalogs();
    const cardRead = deferred(() => taskRow());
    vi.mocked(getTask).mockImplementation(() => cardRead.promise);

    expect(hasPendingClaim("tsk_1")).toBe(false);
    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
    // Same synchronous turn: no `await` between the two lines, so nothing could have run.
    expect(hasPendingClaim("tsk_1")).toBe(true);

    cardRead.resolve();
    await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
  });

  it("binds a launch of the card to the claim the instant it decides, before any read has run", async () => {
    // THE SAME FACT BEHAVIOURALLY, because a source scan alone would pass on a function that
    // takes the key in the wrong place. The claim is parked on `getTask`; a launch of the
    // SAME card dispatched in the same synchronous turn does not start a Session of its own.
    // Without the synchronous reservation the key is still free at that instant, this launch
    // wins, and the assertion below is a SECOND `startTaskSession` rather than none.
    //
    // WHAT THIS CASE USED TO ASSERT, and why it no longer can: `raced.sessionId` was
    // expected to be `null`. That `null` was the bug — the trip could not tell the other
    // chain door from a real refusal, so it answered "nothing was launched", and
    // `finishLink` closed the run on the strength of it. The reservation's job was always
    // "not TWO Sessions", and it still is; what changed is that the late arrival is handed
    // the holder's outcome instead of a refusal. So the case is RESTATEd, not dropped: no
    // second Session starts, and the racing launch ends up holding the CLAIM's Session.
    claimCatalogs();
    const cardRead = deferred(() => taskRow());
    vi.mocked(getTask).mockImplementation(() => cardRead.promise);

    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
    // NO `await` on the line above and this one: same turn, same tick, no interleaving.
    const raced = launchTaskSession(
      SPACE,
      taskRow(),
      CLAIM_DESTINATION,
      CLAIM_CATALOGS(),
    );
    // Nothing has launched and nothing has been refused — it is bound to the claim.
    expect(startTaskSession).not.toHaveBeenCalled();

    // Release the claim so the case does not leave the card's key behind for the reset.
    cardRead.resolve();
    await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    expect((await raced).sessionId).toBe("sess_new");
    // ONE Session for one link — the reservation's actual job.
    expect(startTaskSession).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation when a READ fails, so the card is launchable again", async () => {
    // A leaked key is worse than the double launch the reservation exists to prevent: it
    // makes the card un-launchable by any chain for the life of the app. THREE read arms,
    // each followed by a launch of the same card that MUST succeed.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Arm 1: `getTask` rejects.
      vi.mocked(getTask).mockRejectedValue({ kind: "command", message: "get_task failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect((await relaunchCard()).sessionId).toBe("sess_new");

      // Arm 2: `getTask` answers `null` — the card is gone.
      consoleError.mockClear();
      vi.mocked(getTask).mockResolvedValue(null);
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect((await relaunchCard()).sessionId).toBe("sess_new");

      // Arm 3: a catalog read rejects.
      consoleError.mockClear();
      claimCatalogs();
      vi.mocked(listSkills).mockRejectedValue({ kind: "command", message: "skill scan failed" });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect((await relaunchCard()).sessionId).toBe("sess_new");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("releases the reservation when the LAUNCH fails, including when the report fails too", async () => {
    // The other two arms: the launch itself refuses, and the launch fails AND the transcript
    // write throws — the double-failure path, which exits `carryOutClaim` through the inner
    // `catch`'s own belt rather than the outer one. Both must leave the key behind, and the
    // proof is a launch that starts a Session afterwards.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Arm 4: the launch throws.
      claimCatalogs();
      vi.mocked(startTaskSession).mockRejectedValue({
        kind: "command",
        message: "start_task_session failed",
      });
      expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("could not be carried out"),
          expect.anything(),
        ),
      );
      vi.mocked(startTaskSession).mockResolvedValue(info());
      expect((await relaunchCard()).sessionId).toBe("sess_new");

      // Arm 5: the launch throws AND the reporter throws with it.
      const addSystemLine = vi.spyOn(useSessions.getState(), "addSystemLine");
      addSystemLine.mockImplementation(() => {
        throw new Error("transcript unavailable");
      });
      vi.mocked(startTaskSession).mockRejectedValue({
        kind: "command",
        message: "start_task_session failed",
      });
      try {
        expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
        await vi.waitFor(() =>
          expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining("could not be recorded"),
            expect.anything(),
          ),
        );
      } finally {
        addSystemLine.mockRestore();
      }
      vi.mocked(startTaskSession).mockResolvedValue(info());
      expect((await relaunchCard()).sessionId).toBe("sess_new");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("launches, releases, and launches the same card again after a SUCCESSFUL claim", async () => {
    // THE PIN THE FIX DEMANDS. Success is an arm too: the reservation is handed to
    // `launchTaskSession` just before the call, and if that hand-off left the key held,
    // every card a chain ever advanced would be un-launchable for the rest of the session —
    // silently, with the chain's own next link refused by the link before it.
    claimCatalogs();
    expect(consumeAdvanceAdvice("sess_claim", claimFrame(advancing()))).toBe(true);
    await vi.waitFor(() => expect(startTaskSession).toHaveBeenCalledTimes(1));
    // The hand-off is atomic: `launchTaskSession` takes the key synchronously, so the second
    // Session is the CLAIM's and not a race the case happened to win.
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));

    const again = await launchTaskSession(
      SPACE,
      taskRow({ stageSlug: "implement" }),
      CLAIM_DESTINATION,
      CLAIM_CATALOGS(),
    );
    expect(again.sessionId).toBe("sess_new");
    expect(startTaskSession).toHaveBeenCalledTimes(2);
  });

  /** A launch of the card through the ONE verb the settle edge also uses — the probe that
   *  answers "was the reservation released?". A leaked key answers `null` here, and `null`
   *  is what the guard-trip arm returns, so this cannot be confused with a launch that ran. */
  function relaunchCard(): Promise<{ sessionId: string | null }> {
    return launchTaskSession(
      SPACE,
      taskRow({ stageSlug: "backlog" }),
      CLAIM_DESTINATION,
      CLAIM_CATALOGS(),
    );
  }
});
