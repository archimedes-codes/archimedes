import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  advanceWorkflowChainOnSettle,
  costDeltaOf,
  type WorkflowSettle,
} from "./workflowChain";
import { launchTaskSession, type TaskLaunchCatalogs } from "./taskLaunch";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import { resetTaskLaunchInFlight } from "./taskLaunch";
import { useInteractive } from "./interactive";
import { useSessions } from "./sessions";
import { useTasks } from "./tasks";
import { resetStores } from "../test/resetStores";
import {
  moveTask,
  sendPrompt,
  startTaskSession,
  taskNumbers,
  workflowRunClose,
  workflowRunStep,
  type AdvanceVerdict,
  type ChainStop,
  type SessionInfo,
  type SkillInfo,
  type StageWithTasks,
  type TaskCardView,
  type StopReason,
  type TaskRow,
} from "../lib/tauri";

/**
 * `src/store/workflowChain.ts` — the runtime that consumes the step verb's verdict.
 *
 * ## The seam under test
 *
 * A column with `auto: true` means: when the Session launched on entering it SETTLES,
 * move the card to the column this one points at and launch that column's Skill. The
 * settle edge is `taskLaunch.sendLaunchMessage`'s `await sendPrompt(...)` — the one
 * place that already holds the reason, the Space, the card and the launched column —
 * and this module is what that edge calls. `taskLaunch.test.ts` owns the proof the edge
 * is WIRED into the send path; this file owns what the runtime does with a settle.
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
 * catalog lacks THROWS inside `launchTaskSession`, and that throw is observed rather
 * than asserted against a stub.
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
    getTask: vi.fn(),
    editTask: vi.fn(),
    loadHistory: vi.fn(),
    taskNumbers: vi.fn().mockResolvedValue([]),
    // The chain's TWO run verbs. (`workflowRunOpen` used to be mocked here too; the
    // wrapper, its command and its `Db` verb were deleted as dead IPC, and a mock
    // entry for a name the barrel no longer exports would read as "it still exists".)
    workflowRunStep: vi.fn(),
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
    stage: {
      spacePath: SPACE,
      slug,
      label: over.label ?? slug,
      sortOrder: over.sortOrder ?? 0,
      onEnter: "none",
      onEnterSkill: over.skill ?? null,
      nextSlugs: over.nextSlugs ?? null,
      auto: over.auto ?? false,
      promptPrefix: over.prefix ?? null,
    },
    tasks: [],
  };
}

/** The default board: `research` (auto) → `implement` → `done`, plus a `backlog`. */
function chainBoard(): StageWithTasks[] {
  return [
    column("backlog", { sortOrder: 0 }),
    column("research", { sortOrder: 1, skill: "research", auto: true }),
    column("implement", { sortOrder: 2, skill: "implement" }),
    column("done", { sortOrder: 3 }),
  ];
}

/** The board's card wrapper. `moveTask`'s optimistic paint reads `card.task.id`, so a
 *  column meant to HOLD the card carries the real `TaskCardView`, and an empty
 *  `sessions` / `null` cost / `[]` artifacts are the truth for a card that has none. */
function card(task: TaskRow): TaskCardView {
  return { task, sessions: [], costUsd: null, artifactKeys: [] };
}

/** Paint a board AND put the card in the column its `stageSlug` names.
 *
 *  The card has to be IN the slice, and that is not decoration: `useTasks.moveTask`
 *  refuses a move whose source column does not hold the card ("a stale gesture beats
 *  inventing a column") and returns WITHOUT calling the command. Seed a board that does
 *  not hold the card and every move assertion below would be pinning an early return
 *  that looks like a move. */
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

/** The real launch, wired the way `taskLaunch` wires it. */
function realLaunch(task: TaskRow): WorkflowSettle["launch"] {
  return (next: TaskLaunchDestination) =>
    launchTaskSession(SPACE, task, next.slug, CATALOGS());
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

/** The verdict the step verb answers, with the shipped fallbacks spelled out — the
 *  runtime holds NO copy of those numbers, so a case that wants a bound has to hand one
 *  over the way the wire does. */
function verdict(over: Partial<AdvanceVerdict> = {}): AdvanceVerdict {
  return {
    run: {
      id: "wfr_1",
      spacePath: SPACE,
      taskId: "tsk_1",
      startedAt: 1,
      finishedAt: null,
      steps: 1,
      costUsd: null,
      stopReason: null,
    },
    advance: true,
    stop: null,
    maxSteps: 20,
    ceilingUsd: 10,
    ...over,
  };
}

/** The transcript lines this Session holds, as text. */
function lines(sessionId = "sess_new"): string[] {
  return (useSessions.getState().messages[sessionId] ?? []).map(
    (m) => ((m as { text?: string }).text ?? ""),
  );
}

beforeEach(() => {
  resetStores();
  useTasks.getState().reset();
  resetTaskLaunchInFlight();
  vi.clearAllMocks();
  useSessions.setState({ sessions: [], historySessions: [], archivedSessions: [] });
  seedBoard(...chainBoard());
  vi.mocked(startTaskSession).mockResolvedValue(info());
  vi.mocked(sendPrompt).mockResolvedValue("end_turn");
  vi.mocked(moveTask).mockResolvedValue({ onEnter: "none", boostNote: null });
  vi.mocked(taskNumbers).mockResolvedValue([]);
  vi.mocked(workflowRunClose).mockResolvedValue(undefined);
  vi.mocked(workflowRunStep).mockResolvedValue(verdict());
});

describe("the auto-advance chain — advancing", () => {
  it("moves the card to the next column and launches that column's Skill", async () => {
    // The feature in one assertion pair: the card lands in `implement` THROUGH THE FULL
    // MOVE VERB (`useTasks.moveTask` → `move_task`, so the optimistic paint, the
    // whole-slice re-derivation and the revert-into-`error` all still happen — the chain's
    // move is the human's drag, not a third meaning of "a move"), and the Session that
    // starts is the one the NEXT column configures: `$implement`, not `$research`. Each
    // link carries its own column's Skill and its own extra prompt, which is what makes
    // the chain Skill A → Skill B → Skill C.
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

  it("records the step against the Space the SETTLE carries, not the row's own field", async () => {
    // `spacePath` is the key the guard read looks the Space's budget up by, so a wrong
    // one here measures the chain against another Space's bound.
    //
    // THE FIXTURE MAKES THE TWO FIELDS DIFFER ON PURPOSE, and it has to: `settle.spacePath`
    // and `settle.task.spacePath` are the SAME string in production (`taskLaunch` passes
    // `spacePath: task.spacePath`), so a fixture that left them equal could not tell which
    // one the runtime read — swapping one for the other in the source left this case green,
    // which is the exact confusion this case exists to catch. The two axes that matter are
    // therefore separated here:
    //  - `spacePath` is the Space the settle was made on AND the key the board slice is
    //    seeded under, i.e. the Space whose graph the chain just walked and whose budget the
    //    guard read is keyed on;
    //  - the ROW carries a different Space, which is a decoy — and it is a state the wire can
    //    genuinely be in (a card addressed from a non-canonical path spelling, or a row whose
    //    field is not what the launch was aimed at).
    // Reading the decoy instead of the settle is what reddens below.
    await advanceWorkflowChainOnSettle(
      settle({ task: taskRow({ spacePath: "/w/other" }) }),
    );
    expect(workflowRunStep).toHaveBeenCalledWith(SPACE, "tsk_1", null);
    // Spelled as the negative too, so a failure names the swap rather than diffing a call.
    expect(workflowRunStep).not.toHaveBeenCalledWith("/w/other", "tsk_1", null);
  });

  it("carries the next column's extra prompt into the message", async () => {
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("implement", { sortOrder: 2, skill: "implement", prefix: "TDD first." }),
    );
    await advanceWorkflowChainOnSettle(settle());
    await vi.waitFor(() => expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1));
    // T5's field, one hop deeper: a chain that dropped it would rebuild the bug T5
    // fixed, and the whole point of the graph is a chain with per-column prose.
    expect(vi.mocked(sendPrompt).mock.calls[0]![1]).toContain("TDD first.");
  });

  it("closes the run when the column it advanced INTO is not automatic", async () => {
    // `implement` is NOT `auto`, so nothing will fire a settle hook past this point and
    // the chain is over the moment the card lands. Closing is not a courtesy:
    // `workflowRunStep` UPSERTS onto an OPEN run, so a run left open would hand its step
    // count and running cost to the NEXT chain this card ever starts, and a person who
    // set a 20-step bound would silently get a shorter one. `"manual"` is the record's
    // own vocabulary for "a person's column took over" — `workflowRunClose`'s doc names
    // it, and the four `ChainStop` spellings are the BOUND vocabulary, which this is not.
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
    // OPEN for B to step onto — `workflowRunStep` UPSERTS onto an open run, and that is
    // what makes the step bound cover the WHOLE chain rather than each link separately.
    //
    // A SUCCESS outcome is injected rather than routed through the real launch: the real
    // one starts a turn, `sendPrompt` resolves immediately under every mock in this repo,
    // and `taskLaunch`'s settle edge would then fire the NEXT link for real — the feature
    // working, but two links deep, and this case is about exactly one fact.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("implement", { sortOrder: 2, skill: "implement", auto: true }),
    );
    await advanceWorkflowChainOnSettle(
      settle({ launch: async () => ({ sessionId: "sess_next", note: null }) }),
    );
    expect(workflowRunStep).toHaveBeenCalled();
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
    // The step was recorded before the function returned, so this is not the trivial
    // pass of an empty function: real work happened and it still did not wait.
    expect(workflowRunStep).toHaveBeenCalled();
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
      await advanceWorkflowChainOnSettle(settle({ reason }));
      expect(workflowRunStep).not.toHaveBeenCalled();
      expect(moveTask).not.toHaveBeenCalled();
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", reason);
    },
  );

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

describe("the auto-advance chain — a column that is not automatic", () => {
  it("does nothing at all for auto: false", async () => {
    // The flag is the user's configuration, per Space, and OFF is the stored default: a
    // launch on a column nobody marked automatic must not touch the record, the board or
    // the transcript. Nothing here may INVENT an automation.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: false }),
      column("implement", { sortOrder: 2, skill: "implement" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunStep).not.toHaveBeenCalled();
    expect(workflowRunClose).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
    expect(lines()).toHaveLength(0);
  });

  it("does nothing when the board slice was never loaded", async () => {
    // An unloaded slice is "NEVER READ", not "no columns", and the conservative answer
    // for an automation is "not automatic". This is the one case the design cannot reach:
    // `store/tasks.ts`'s `load` has exactly ONE call site — the board — so a chain that
    // settles with no board mounted has no graph to read. It says NOTHING either, which
    // is the honest half: a sentence about rows this window never read would itself be a
    // fabrication.
    useTasks.setState({ boardsBySpace: {} });
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunStep).not.toHaveBeenCalled();
    expect(workflowRunClose).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(0);
  });
});

describe("the auto-advance chain — the graph decides, including when it says stop", () => {
  it("closes with no_next_stage for nextSlugs: [] and does NOT fall through", async () => {
    // THE collapse. `[]` is "configured, leads nowhere" — a person's explicit stop. A
    // `||` fallback reads the empty array as absent and moves the card to the column at
    // `sortOrder + 1`: an automation nobody configured, on a chain configured to END.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true, nextSlugs: [] }),
      column("implement", { sortOrder: 2, skill: "implement" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunStep).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "no_next_stage");
    expect(lines().some((t) => /no_next_stage/.test(t))).toBe(true);
  });

  it("falls back to sortOrder + 1 when nextSlugs is NULL", async () => {
    // UNCONFIGURED is not "leads nowhere": the fallback is what keeps an existing board
    // chaining after the upgrade instead of silently losing the step.
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true, nextSlugs: null }),
      column("implement", { sortOrder: 2, skill: "implement" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "implement");
  });

  it("takes the FIRST configured edge rather than the column above", async () => {
    seedBoard(
      column("research", {
        sortOrder: 1,
        skill: "research",
        auto: true,
        nextSlugs: ["done", "implement"],
      }),
      column("implement", { sortOrder: 2, skill: "implement" }),
      column("done", { sortOrder: 3 }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(moveTask).toHaveBeenCalledWith(SPACE, "tsk_1", "done");
  });

  it("closes with no_next_stage for the last column of an unconfigured board", async () => {
    // The `null`-with-nothing-above arm: the same "no next stage" close as `[]`, and
    // `workflowRunStep` never called means no step was charged for a move that did not
    // happen.
    seedBoard(column("research", { sortOrder: 1, skill: "research", auto: true }));
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "no_next_stage");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("says the column could not be READ (not that there is none) for an unresolvable edge", async () => {
    // THE THIRD CONSUMER'S WRONG SENTENCE. `nextStepOf` DROPS an edge whose slug the
    // loaded columns cannot resolve, and `nextStepSlugs` KEEPS it — ADR 0119 §7 argues
    // those two verdicts should stay two, and they are. But the chain took the pill's
    // verdict (no move) and the MODAL's vocabulary is the only one that fits it: the
    // canvas on screen is drawing this edge as a ghost node that says "we could not name
    // it", so a sentence saying "there is no column after it" contradicts the graph the
    // person is looking at. The distinction is `nextStepSlugs` non-empty + `nextStepOf`
    // undefined.
    //
    // The `stop_reason` SPELLING stays `no_next_stage`: the column carries the narrative,
    // so a third vocabulary would need a migration and an enum change to say what one
    // sentence can say.
    seedBoard(
      column("research", {
        sortOrder: 1,
        skill: "research",
        auto: true,
        nextSlugs: ["ghost"],
      }),
      column("implement", { sortOrder: 2, skill: "implement" }),
    );
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", "no_next_stage");
    expect(moveTask).not.toHaveBeenCalled();
    const sentence = lines().join("\n");
    // The honest reading of an edge the slice cannot resolve…
    expect(sentence).toMatch(/could not be read/);
    expect(sentence).toMatch(/stale/);
    // …and NOT the pill's claim that the column has nothing after it, which is what the
    // canvas on screen contradicts.
    expect(sentence).not.toMatch(/no column after it/);
  });

  it("does not invent a graph reason when the verdict refuses with no stop", async () => {
    // `advance: false ⇒ stop.is_some()` is a Rust guarantee, so this arm is unreachable
    // through the wire. It was written `?? "no_next_stage"`, which invents a GRAPH reason
    // for what would be a BOUND failure — a specific falsehood on a path that can only be
    // reached by a broken verdict. The honest answer is `unknown`, plus a log line, since
    // a reason this side cannot read is a reason it must not guess.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(workflowRunStep).mockResolvedValue(
        verdict({ advance: false, stop: null }),
      );
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
});

describe("the auto-advance chain — the guards", () => {
  it.each(["max_steps", "cost_ceiling", "launch_refused", "no_next_stage"] as ChainStop[])(
    "advance: false with stop %s closes with that reason and moves nothing",
    async (stop) => {
      // `advance` is the ONE field the runtime must obey, and the step that trips a bound
      // is still WRITTEN (the run's real length) while the CARD does not move — a chain
      // that hit its budget must not also spend the next column's Session.
      vi.mocked(workflowRunStep).mockResolvedValue(
        verdict({ advance: false, stop, maxSteps: 7, ceilingUsd: 3.25 }),
      );
      await advanceWorkflowChainOnSettle(settle());
      expect(workflowRunClose).toHaveBeenCalledWith("tsk_1", stop);
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

  it("names the verdict's step bound in the sentence, not a hardcoded 20", async () => {
    // The reason T6a put `maxSteps` on the verdict: TypeScript does not know the shipped
    // fallback, so a sentence that says "20" is a number this side of the wire invented.
    // A Space configured at 7 must read 7.
    vi.mocked(workflowRunStep).mockResolvedValue(
      verdict({ advance: false, stop: "max_steps", maxSteps: 7 }),
    );
    await advanceWorkflowChainOnSettle(settle());
    const sentence = lines().find((t) => /max_steps/.test(t)) ?? "";
    expect(sentence).toContain("7");
    expect(sentence).not.toContain("20");
  });

  it("names the verdict's ceiling in the sentence, not a hardcoded $10", async () => {
    vi.mocked(workflowRunStep).mockResolvedValue(
      verdict({ advance: false, stop: "cost_ceiling", ceilingUsd: 3.25 }),
    );
    await advanceWorkflowChainOnSettle(settle());
    const sentence = lines().find((t) => /cost_ceiling/.test(t)) ?? "";
    expect(sentence).toContain("$3.25");
    expect(sentence).not.toContain("$10");
  });

  it("does not claim a ceiling it was not given", async () => {
    // `ceilingUsd: null` means NO bound. Under the shipped fallback no current Space
    // means that, but the type allows it, and `$0` / `$null` would each describe a guard
    // that did not run.
    vi.mocked(workflowRunStep).mockResolvedValue(
      verdict({ advance: false, stop: "cost_ceiling", ceilingUsd: null }),
    );
    await advanceWorkflowChainOnSettle(settle());
    const all = lines().join("\n");
    expect(all).toContain("cost_ceiling");
    expect(all).not.toMatch(/\$0\b/);
    expect(all).not.toContain("null");
  });

  it("moves nothing when the step verb itself fails", async () => {
    // The conservative half, and the reason the caller's `.catch` is a belt and not a
    // fallback move. When `workflowRunStep` rejects this side cannot know whether the
    // step landed, so it will NOT invent a `stop_reason` for a write it did not read, and
    // it certainly will not move a card on the strength of a verdict it never saw. The
    // caller reports the failure in the transcript; the card stays.
    vi.mocked(workflowRunStep).mockRejectedValue(new Error("db is busy"));
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

describe("the auto-advance chain — the cost figure", () => {
  it("passes null, never 0, when the Session reported no figure", async () => {
    // ADR 0082 from the CALLER's side. `workflow_run_step`'s `None` arm does not mention
    // `cost_usd` at all; a `0` writes `COALESCE(cost_usd, 0.0) + 0` and turns "unbilled"
    // into "billed zero" — permanently arming the ceiling against a chain that has never
    // reported money. T6a pins that a NULL-cost chain cannot trip the ceiling, and a `0`
    // here would undo that from this side while every Rust test stayed green.
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunStep).toHaveBeenCalledWith(SPACE, "tsk_1", null);
  });

  it("passes the live figure when the turn reported one", async () => {
    // Read through `costUsdOf`, the file that owns the `NULL` ≠ `0` rule and the
    // map-first / row-fallback precedence — not a raw map read, which would miss a
    // stored session's figure entirely.
    useInteractive.setState({ cost: { sess_new: { cost: 0.42, costUsd: 0.42 } } });
    await advanceWorkflowChainOnSettle(settle());
    expect(workflowRunStep).toHaveBeenCalledWith(SPACE, "tsk_1", 0.42);
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
    expect(workflowRunStep).toHaveBeenCalledWith(SPACE, "tsk_1", 1.5);
  });

  it("passes the TURN's spend when the session had a figure before it", async () => {
    // `workflow_run_step` ADDS (`COALESCE(cost_usd, 0.0) + ?`), so a cumulative figure
    // handed to it sums the cumulatives: three links totalling $1, $2, $3 would record $6
    // against a ceiling set for $3 and fire early. The before-snapshot is what makes the
    // delta real.
    useInteractive.setState({ cost: { sess_new: { cost: 3, costUsd: 3 } } });
    await advanceWorkflowChainOnSettle(settle({ costBeforeTurnUsd: 2 }));
    expect(workflowRunStep).toHaveBeenCalledWith(SPACE, "tsk_1", 1);
  });

  it("passes null and not 0 when the figure went BACKWARDS across the turn", async () => {
    // A resumed row and a live frame can land in either order across a
    // `mergeRefreshedSessionRows` refresh, so the figure can go DOWN. The old floor
    // (`Math.max(0, …)`) turned that into a `0`, and `0` is not a neutral value on this
    // wire: `workflow_run_step` writes `COALESCE(cost_usd, 0.0) + 0`, which turns an
    // UNBILLED run into a BILLED-ZERO one — exactly the write this function's `null` arm
    // exists to prevent (ADR 0082; T6a pins that a NULL-cost chain cannot trip its
    // ceiling, and a `0` arms it from this side while every Rust test stays green).
    useInteractive.setState({ cost: { sess_new: { cost: 1, costUsd: 1 } } });
    await advanceWorkflowChainOnSettle(settle({ costBeforeTurnUsd: 4 }));
    expect(workflowRunStep).toHaveBeenCalledWith(SPACE, "tsk_1", null);
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
    seedBoard(
      column("research", { sortOrder: 1, skill: "research", auto: true }),
      column("implement", { sortOrder: 2, skill: "ghost" }),
    );
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
      // The refusal reaches the sentence, and it names BOTH columns, so a person can act
      // on it ("it asked for `implement` and the card is in `research`") rather than
      // reading a generic failure.
      const sentence = lines().find((t) => /launch_refused/.test(t)) ?? "";
      expect(sentence).toContain("implement");
      expect(sentence).toContain("research");
      // And NOTHING started: no Session, no prompt. A chain that launched a Session into
      // a column the card never reached is the whole defect.
      expect(startTaskSession).not.toHaveBeenCalled();
      expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(0);
      // The slice proves the card did not move — the revert happened, and the chain said
      // so rather than reporting a launch that never was.
      const columns = useTasks.getState().boardsBySpace[SPACE]!;
      expect(
        columns.find((c) => c.stage.slug === "research")?.tasks.map((t) => t.task.id),
      ).toContain("tsk_1");
      expect(columns.find((c) => c.stage.slug === "implement")?.tasks).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("closes with launch_refused when the launch answers no sessionId", async () => {
    // The OTHER refusal, and the reason the outcome is READ and not merely caught:
    // `launchTaskSession` answers `{ sessionId: null }` when its in-flight guard refuses a
    // second launch of the same card. A guard trip is a RETURN, not a throw, so a
    // `try`/`catch` alone would call this a success.
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
