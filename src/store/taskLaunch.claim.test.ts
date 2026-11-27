import { beforeEach, describe, expect, it, vi } from "vitest";

import { consumeAdvanceAdvice, resetTaskLaunchInFlight } from "./taskLaunch";
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
  type AcpSessionUpdate,
  type AdvanceAdvice,
  type SessionInfo,
  type SkillInfo,
  type TaskRow,
} from "../lib/tauri";

/**
 * `src/store/taskLaunch.ts` — the CLAIM half: `consumeAdvanceAdvice` and its async
 * worker `carryOutClaim`. ADR 0113 mirror naming beside `taskLaunch.test.ts`, which
 * owns the launch half (`launchTaskSession`, `createTaskFromDraft`, the settle edge).
 *
 * WHY THIS FILE EXISTS SEPARATELY: the parent reached 1,040 code lines against the
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

/** The transcript lines one Session holds, as text (the claim cases need the
 *  CLAIMANT's transcript, which is not the Session the launch starts). */
function lines(sessionId: string): string[] {
  return (useSessions.getState().messages[sessionId] ?? []).map((m) => (m as { text?: string }).text ?? "");
}

describe("consumeAdvanceAdvice — the claim path", () => {
  /** The claim path's catalog. The shared mock answers `[]` for both catalog reads
   *  (which is what keeps the ordinary launch cases honest about a missing Skill),
   *  and `missingSkill` REFUSES a launch whose Skill the catalog lacks — so a case
   *  that means a SUCCESSFUL claim has to hand over `implement` itself. */
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
