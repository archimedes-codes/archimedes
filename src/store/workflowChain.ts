import { costUsdOf } from "../lib/sessionCost";
import type { SessionLookupSource } from "../lib/sessionLookup";
import { workflowRunClose, workflowRunStep } from "../lib/tauri";
import type { ChainStop, StageDto, StopReason, TaskRow } from "../lib/tauri";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import { nextStepOf, nextStepSlugs } from "../lib/workflowGraph";
import type { CostUpdatePayload } from "./interactive";
import { useInteractive } from "./interactive";
import { useSessions } from "./sessions";
import { useTasks } from "./tasks";
import type { TaskLaunchOutcome } from "./taskLaunch";

/**
 * The **auto-advance chain** — the runtime a `stages.auto` column is the switch for.
 *
 * ## What it does
 *
 * A column with `auto: true` means: when the **Session launched on entering this
 * column settles**, move the card to the column this one points at and launch that
 * column's Skill. A board therefore becomes a chain — Skill A → Skill B → Skill C —
 * and each link carries its own column's Skill (`stages.on_enter_skill`, ADR 0098) and
 * its own extra prompt (`stages.prompt_prefix`), because both are read from the row of
 * the column being ENTERED, never from the one being left.
 *
 * The step is recorded in `workflow_runs` and measured against the Space's two guards
 * (the per-Space step bound and the USD ceiling) by `workflowRunStep`, which answers an
 * [`AdvanceVerdict`](../lib/tauri/types). **`verdict.advance` is the only field this
 * module obeys and it never overrules it.** The bounds and their shipped fallbacks live
 * in Rust deliberately, so re-deriving "is this chain over budget?" here would copy a
 * policy number across the wire — one refactor from disagreeing with the first copy, and
 * the disagreement is a chain that runs past a bound a person set.
 *
 * ## Where it is called from, and why there is no watcher
 *
 * `taskLaunch.sendLaunchMessage` `await`s `sendPrompt` and gets the settle **reason**
 * back, and its arguments already carry the Space, the card and the destination column
 * that was launched. That is the settle edge, and it is exact. A subscriber on the
 * sessions store that fired when `inTurn` fell and then read the card's stage from the
 * board slice cannot work: `store/tasks.ts`'s `load` has one call site per **board-shaped
 * surface** — the board's own mount and `WorkflowsCanvas`'s — and neither of those is
 * mounted while the chat column is, which is precisely the case an unattended chain
 * settles in. The slice is therefore populated only while a person is looking at a board
 * or a canvas, and a slice-reading watcher would silently no-op in the one situation the
 * automation exists for. That is the worst failure an automation can have: it looks
 * configured and does nothing.
 *
 * (The claim used to read "exactly ONE call site — the board itself", stated in the
 * present tense, and this branch made it false by adding the canvas. ADR 0119 §5 dates
 * the claim instead; the durable form is above, because the count of call sites is a
 * fact about the tree that a later surface can change while the CASE it argues for —
 * nobody has a board mounted when the chain settles — is a fact about the view ternary
 * and does not move.)
 *
 * ## Why the caller must NOT await this, and why this must not await the next turn
 *
 * `sendLaunchMessage`'s own header records the DEADLOCK, and it is a deadlock and not a
 * latency problem: `sendPrompt` resolves on `agent_settled`; the merged `research` Skill
 * ends its turn on an `ask` gate; `AskQuestionCard` renders only under `ChatStream`; and
 * `App`'s view ternary renders the board **instead of** `ChatStream` — "the turn waits
 * on a gate that has no renderer, and the gate cannot appear until the turn ends to let
 * the view switch." That is why the existing call is `void sendLaunchMessage(...)`.
 *
 * The same rule binds this module and its caller, in two halves:
 *
 *  - **the caller `void`s this** — a chain must never hold the settle it was born on;
 *  - **this module never awaits the next launch's turn.** It dispatches the launch and
 *    observes only its *outcome* ([`WorkflowSettle.launch`]) — the half
 *    `launchTaskSession` resolves before any turn runs, because it moves, starts the
 *    Session and dispatches the message with a `void` of its own.
 *
 * Every `sendPrompt` mock in this repo resolves immediately, so a suite written with
 * resolving mocks **cannot tell `void` from `await` here** — the file's own comment says
 * exactly that about the existing pins. That is the second reason `launch` is an
 * argument of [`WorkflowSettle`] rather than a direct import: a test can hand this
 * function a launch that has not resolved and assert it returned anyway.
 *
 * ## ⚠️ The defect this makes load-bearing (named follow-up, deliberately NOT fixed)
 *
 * For the same reason, **a chain whose Skill ends its turn on an unanswered `ask` gate
 * stalls forever**: `sendPrompt` never resolves, so the settle edge never fires and the
 * next link never launches. The card sits in a column that says it is automatic while
 * its Session waits on a gate the board view cannot render. This is a PRE-EXISTING
 * defect in `App`'s view ternary — a human-launched `research` Session has always had
 * it — but before this module nothing depended on the settle in order to continue, so it
 * was a stuck transcript rather than a broken automation. Fixing it means rendering the
 * gate across views, which is a separate feature and is filed as such.
 *
 * ## What a tripped bound does NOT do
 *
 * It closes the run and says so in the transcript. It does **not** flip `stages.auto`
 * off. `auto` is the user's configuration for **every card in that Space**: one card
 * hitting its 20-step bound would silently reconfigure everyone's board, with no UI hint
 * that the column had stopped being automatic. The `stop_reason` column exists to carry
 * exactly this narrative, and `addSystemLine` is the house answer for "a thing the user
 * must see that has no other surface" — which is why `sendLaunchMessage`'s own `catch`
 * uses it. Configuration stays as configured.
 */

/** The settle this runtime was called on: everything the edge already knows, so this
 *  module has to look nothing up that the caller was holding.
 *
 *  `spacePath` travels with it because the guard read is keyed on the card's real Space
 *  — `workflowRunStep` looks the Space's bounds up by it, so a Space other than the
 *  card's own measures the chain against the wrong budget. */
export interface WorkflowSettle {
  spacePath: string;
  /** The card, as the launch surface holds it. */
  task: TaskRow;
  /** The Session that just settled — the transcript a stop sentence goes into. */
  sessionId: string;
  /** WHY the turn ended. Only `"end_turn"` advances; see the whitelist in
   *  [`advanceWorkflowChainOnSettle`]. */
  reason: StopReason;
  /** The column that was LAUNCHED (its `slug`) — the column whose `auto` flag and
   *  outgoing edge decide what happens next. NOT the card's stored stage: a launch
   *  moves the card first, and the settle belongs to the column the person, or the
   *  previous link, aimed at. */
  launchedSlug: string;
  /** The Session's money figure as it stood BEFORE this turn ran, or `null` for "no
   *  figure then". The settle handler is the only place that can see the figure on both
   *  sides of a turn, which is why the delta is computed from a snapshot rather than
   *  reconstructed afterwards — see [`costDeltaOf`]. */
  costBeforeTurnUsd: number | null;
  /** Start the next column's Session. An argument rather than a direct import for two
   *  reasons, the first of them load-bearing.
   *
   *  **No cycle.** This module would otherwise import `launchTaskSession` from
   *  `./taskLaunch` while `./taskLaunch` imports this module to make the settle call: a
   *  cycle that happens to work (both edges sit inside function bodies) and would keep
   *  working, but one that makes initialisation order an untested fact. Passing `launch`
   *  removes the runtime edge and leaves only a type edge, which `verbatimModuleSyntax`
   *  compiles to nothing.
   *
   *  **The `void` becomes checkable.** A test can hand this function a launch that never
   *  resolves, which is the only way to prove it does not wait on the next turn. With a
   *  hard-wired import, every mock resolves immediately and the deadlock is invisible —
   *  the exact trap `sendLaunchMessage`'s header describes.
   *
   *  `taskLaunch` wires it to `launchTaskSession`, i.e. to the FULL move verb: that
   *  function moves the card through `useTasks.getState().moveTask` (optimistic paint,
   *  whole-slice re-derivation, revert-into-`error`) before it starts anything, so a
   *  chain's move IS the human's drag and not a third meaning of "a move". It also
   *  refuses THREE different ways — it THROWS for a Skill the catalog lacks, it THROWS
   *  when `moveTask` reports the card ended in a column other than the one it was aimed
   *  at (a stale-slice `StrictMoveRefused` or a destination that vanished from the
   *  slice), and it answers `{ sessionId: null }` when its in-flight guard trips — and
   *  all three are handled below, which is why this returns an outcome and not `void`.
   *  [`finishLink`] names them again at the arm that reads them. */
  launch: (next: TaskLaunchDestination) => Promise<TaskLaunchOutcome>;
}

/** A money figure for a sentence about a BOUND.
 *
 *  Neither existing formatter fits, and both arguments are short. `moneyOf`
 *  (`components/SessionCostLine.tsx`) is the right rule but lives under `components/`,
 *  and `src/store/` holds ZERO runtime edges into `src/components/` — this would be the
 *  first, for a string. `formatCost` (`lib/toolOutput.ts`) is reachable but renders a
 *  real `0` as the EMPTY string, which is right for a cost chip that means "nothing to
 *  show" and wrong for a ceiling: `$0` is a bound a person can legitimately configure
 *  ("no budget at all"), and a sentence that prints no number for it describes a guard
 *  nobody can read. So: `toFixed(2)`, no cleverness. A ceiling is a round number a
 *  person typed. */
function usdOf(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** This Session's money figure now, or `null` for "no figure" — read through
 *  [`costUsdOf`], the file that owns the `NULL` ≠ `0` rule (ADR 0082) and the
 *  live-map-first / stored-row-fallback precedence.
 *
 *  EXPORTED because the settle edge needs it on BOTH sides of the turn: the delta a
 *  chain step is charged needs the figure as it stood before `sendPrompt` was awaited,
 *  and only `sendLaunchMessage` is standing there. A raw
 *  `useInteractive.getState().cost[id]` would not do — that map is in-memory only,
 *  `dismissSession` deletes the entry on close and boot hydrates none of it, so a
 *  resumed Session's figure lives on its ROW and nowhere else, and a raw map read would
 *  answer `null` for money that was genuinely spent. */
export function sessionCostFigure(sessionId: string): number | null {
  const sessions = useSessions.getState();
  return costUsdOf(
    useInteractive.getState().cost[sessionId] as CostUpdatePayload | undefined,
    {
      sessions: sessions.sessions,
      historySessions: sessions.historySessions,
      archivedSessions: sessions.archivedSessions,
    } satisfies SessionLookupSource,
    sessionId,
  );
}

/** What ONE turn spent, from the figure on each side of it.
 *
 *  `workflowRunStep` ADDS its argument (`cost_usd = COALESCE(cost_usd, 0.0) + ?`), so
 *  what it is handed has to be a delta. The figure `costUsdOf` answers is a running
 *  TOTAL, and feeding a total into an additive column sums the totals: a three-link
 *  chain whose Sessions cost $1, $2 and $3 in total would record $6 against a ceiling
 *  the person set for $3, and the guard would fire early while every Rust test stayed
 *  green. That is a fabricated number, so this returns one only when it can compute it.
 *
 *  The `null` half is ADR 0082 verbatim:
 *   - `after === null` → `null`. Nothing was ever reported, and `0` would write
 *     `COALESCE(cost_usd, 0.0) + 0`, turning "unbilled" into "billed zero" and
 *     permanently arming the ceiling against a chain that has never reported money. T6a
 *     pins that a NULL-cost chain cannot trip its ceiling; a caller passing `0` undoes
 *     that from this side while every Rust test stays green.
 *   - `before === null` → `after`. Nothing had been reported when the turn started, so
 *     everything reported at settle was spent by THIS turn. That is the ordinary case
 *     for a chain link, since each column launches its OWN Session and a fresh one has
 *     no figure at all before its first frame.
 *   - `after - before <= 0` → `null`, for BOTH the flat total and a backwards one. This
 *     used to be `Math.max(0, after - before)`, and the floor was the defect wearing the
 *     floor's clothes: `0` is not neutral on this wire, it is `COALESCE(cost_usd, 0.0) + 0`
 *     — the exact "billed zero" write the arm above exists to prevent, reached by a link
 *     that reported nothing new instead of by a Session that never reported anything. A
 *     FLAT total (`5, 5`) is the ordinary "no `cost_update` frame arrived this turn" case;
 *     a BACKWARDS one (`5, 2`) is a resumed Session's row figure and a live frame landing
 *     in the other order across a `mergeRefreshedSessionRows` refresh. Neither is money
 *     this turn spent, so neither is chargeable, and a chain must not be able to arm its
 *     ceiling against itself by arithmetic.
 *
 *  THE UNDER-COUNT THAT REMAINS, and it is bounded: a `cost_update` frame that lands AFTER
 *  the settle is missed by that link and never recovered, because the before/after pair is
 *  read on a Session that has already been charged its delta — and the next link launches a
 *  NEW Session, so the late frame belongs to a session id no later pair will read. The
 *  ceiling therefore sees every chain's spend as slightly LESS than it cost, never more: the
 *  bound fails open by a fraction of a turn and never fails shut on a chain that was within
 *  budget. Fixing it would mean charging the delta at the frame instead of at the settle,
 *  i.e. a second owner of the run's running total.
 */
export function costDeltaOf(
  before: number | null,
  after: number | null,
): number | null {
  if (after === null) return null;
  if (before === null) return after;
  const delta = after - before;
  if (delta <= 0) return null;
  return delta;
}

/** Append the stop sentence to the transcript that just ended.
 *
 *  `addSystemLine` is the house answer for a thing the user must see that has no other
 *  surface — the same reason `sendLaunchMessage`'s `catch` uses it. The alternative was
 *  a field on the board slice, and there is nowhere on a board to render "this card's
 *  chain stopped three minutes ago because of its 20-step bound" where a person who is
 *  not looking at the board would ever see it. The transcript they were just watching is
 *  the surface actually in front of them. */
function tellWhyStopped(sessionId: string, sentence: string): void {
  useSessions.getState().addSystemLine(sessionId, sentence);
}

/** The column a slug names in the loaded slice, or `undefined` for "not there / not
 *  read". Both answers mean the same thing to this module and are treated identically:
 *  see the note in [`advanceWorkflowChainOnSettle`] about the unloaded slice. */
function stageOf(spacePath: string, slug: string): StageDto | undefined {
  return useTasks
    .getState()
    .boardsBySpace[spacePath]?.find((c) => c.stage.slug === slug)?.stage;
}

/** `workflowRunClose`, failure-proofed. It must never be able to fail a chain that
 *  already did its work — it is bookkeeping, and a rejection on a path nothing awaits
 *  would be reported nowhere, so it is logged instead. The storage verb is itself silent
 *  when there is no open run to close (a card that never chained and a chain already
 *  closed are both ordinary); the CALLER's job is to have opened the run it means to
 *  close, and every close below either follows a step that could have opened one or
 *  names the reason a chain never got that far. */
async function closeRun(taskId: string, reason: string): Promise<void> {
  try {
    await workflowRunClose(taskId, reason);
  } catch (err) {
    console.error(`Failed to close the auto-advance run for ${taskId}:`, err);
  }
}

/** Record the stop, then say so — one call per stop, so the record and the sentence
 *  cannot disagree about why a chain ended. */
async function stopChain(
  settle: WorkflowSettle,
  reason: string,
  sentence: string,
): Promise<void> {
  await closeRun(settle.task.id, reason);
  tellWhyStopped(settle.sessionId, sentence);
}

/** The sentence for a bound that tripped, built from the verdict's OWN effective
 *  numbers.
 *
 *  This is what `maxSteps` and `ceilingUsd` are on the verdict for: TypeScript does not
 *  know the shipped fallbacks, so a sentence that says "20" or "$10" is a policy number
 *  this side of the wire invented, and it is a lie for every Space that configured
 *  something else. `ceilingUsd: null` means NO bound — under the shipped fallback no
 *  current Space means that, but the type allows it, and the money clause is dropped
 *  rather than rendered as `$0` or `null`, both of which describe a guard that did not
 *  run. */
function boundSentence(
  stop: ChainStop,
  maxSteps: number,
  ceilingUsd: number | null,
): string {
  if (stop === "max_steps") {
    return (
      "The auto-advance chain stopped: it reached this Space's " +
      `${maxSteps}-step bound (\`max_steps\`). The card stays where it is.`
    );
  }
  if (stop === "cost_ceiling") {
    if (ceilingUsd === null) {
      return "The auto-advance chain stopped: it reached its cost ceiling (`cost_ceiling`).";
    }
    return (
      `The auto-advance chain stopped: it reached this Space's ${usdOf(ceilingUsd)} ` +
      "per-chain ceiling (`cost_ceiling`). The card stays where it is."
    );
  }
  // The two `ChainStop` values the database cannot produce and this handler can. They
  // live in the shared vocabulary (`lib/tauri/types.ts`) precisely so a caller does not
  // hand-type a fifth spelling of "it stopped" — a `"no_next"` in one file and a
  // `"no_next_stage"` in another is two reasons for one event, and the chain history
  // would read as though chains stopped for more reasons than they did.
  return `The auto-advance chain stopped (\`${stop}\`). The card stays where it is.`;
}

/** The chain step: settle in, verdict obeyed, next link dispatched or run closed.
 *
 *  Every early return is a DIFFERENT reason and each is recorded with its own, so the
 *  chain's history reads as the truth. Nothing here writes `stages.auto` — see the
 *  header. */
export async function advanceWorkflowChainOnSettle(
  settle: WorkflowSettle,
): Promise<void> {
  // ── 1. Only a turn that FINISHED settles a chain. A WHITELIST, never
  // `reason !== "cancelled"`: `max_tokens` is the provider cutting a reply off and
  // `max_turn_requests` is the engine's own turn bound (issue #193) — neither is a
  // finish, and neither is a pause the user owes. A blacklist also has to be widened by
  // hand for every reason the engine learns to report, with nothing failing when someone
  // forgets. `lib/attention.ts` states the same rule, the same reasoning, and the timing
  // fact this relies on: `turnCompleted` writes `inTurn` and `stopReasons` in ONE
  // `set()`, so a snapshot in which the turn has already fallen carries the reason that
  // ended it — a whitelist could otherwise have missed an `end_turn`.
  if (settle.reason !== "end_turn") {
    // The run is CLOSED rather than left open, whatever the reason. A chain whose last
    // turn was cancelled or cut off is over, and `workflowRunStep` UPSERTS onto an OPEN
    // run, so a run left open here would hand this chain's steps and running cost to the
    // NEXT chain this card ever starts — a person who set a 20-step bound would silently
    // get a shorter one. The reason is stored verbatim (`"cancelled"`, `"max_tokens"`, …)
    // because `stop_reason` is the record's only narrative field and the wire's own
    // vocabulary is the truest thing to put in it.
    await stopChain(
      settle,
      settle.reason,
      `This Session ended (\`${settle.reason}\`) without advancing the card — only a ` +
        "turn that finishes drives an auto-advance chain.",
    );
    return;
  }

  // ── 2. Only a column that was MARKED automatic.
  const from = stageOf(settle.spacePath, settle.launchedSlug);
  // An UNLOADED slice and an absent row both answer "not automatic", and that is the
  // conservative answer rather than a shrug: this module's job is to carry out an
  // automation a person configured, and a column it cannot read is a column nobody has
  // told it anything about. Inventing one is the failure mode this file is shaped to
  // avoid — a card that moves on its own with no column that asked for it.
  //
  // THIS is the one case the design cannot reach, stated rather than papered over:
  // `store/tasks.ts`'s `load` has one call site per board-shaped surface — the board's
  // mount and `WorkflowsCanvas`'s — and NEITHER is mounted while the chat column is, so a
  // chain that settles with no board and no canvas on screen has no slice to read, and
  // therefore does not advance. (This used to read "exactly ONE call site (the board)" in
  // the present tense, which the canvas made false; the durable claim is the one above,
  // and the conclusion is unchanged.) It says NOTHING either, which is the honest half of
  // the same rule: a sentence about a graph this window never read would be a claim about
  // rows it did not read. Reaching this case properly means fetching the board on this
  // path, and that is a decision about who owns the board slice — not something to
  // smuggle into a settle handler.
  if (from === undefined || !from.auto) return;

  // ── 3. Where the graph says this column goes — THE SAME derivation the board's launch
  // pill and the detail modal's buttons run, now shared in `lib/workflowGraph`. That
  // matters more here than it did for either component: a chain that invented an edge
  // would move a card along a path the board does not show. `nextSlugs: []` is
  // "configured, leads nowhere" and yields nothing here exactly as it yields no pill;
  // `null` is UNCONFIGURED and falls back to the column at `sortOrder + 1`.
  const columns = useTasks.getState().boardsBySpace[settle.spacePath];
  const next = nextStepOf(columns, from);
  if (next === undefined) {
    // TWO DIFFERENT NOES, and only one of them is "there is nothing after this column".
    // `nextStepOf` DROPS an edge whose slug the loaded columns cannot resolve while
    // `nextStepSlugs` KEEPS it — ADR 0119 §7 argues the two verdicts stay two, and they
    // do; the canvas is drawing this very edge as a ghost node that says "we could not
    // name it". So when the slug list is NON-EMPTY and the destination still will not
    // resolve, a sentence saying "`X` is an automatic column with no column after it"
    // contradicts the graph on screen: the chain took the pill's verdict (correct, do not
    // move) but the pill has no note to fall back on and the chain does, so it must use
    // the modal's vocabulary. The `stop_reason` SPELLING stays `no_next_stage` either
    // way — the column carries the narrative, so a third vocabulary would buy an enum
    // change and a migration for what one sentence can say.
    const edge = nextStepSlugs(columns, from);
    const unresolvable = edge.length > 0;
    await stopChain(
      settle,
      "no_next_stage",
      unresolvable
        ? `The chain stopped at \`${from.label}\`: the column after it (\`${edge[0]}\`) ` +
          "could not be read — the board may be stale (`no_next_stage`). Reload the board " +
          "to see where this edge goes."
        : `\`${from.label}\` is an automatic column with no column after it, so the chain ` +
          "stopped here (`no_next_stage`). Move the card yourself to continue.",
    );
    return;
  }

  // ── 4. Record the step and OBEY the verdict. The delta goes through untouched — no
  // `?? 0` and no `|| null`, neither of which belongs in that signature.
  const verdict = await workflowRunStep(
    settle.spacePath,
    settle.task.id,
    costDeltaOf(settle.costBeforeTurnUsd, sessionCostFigure(settle.sessionId)),
  );
  if (!verdict.advance) {
    // Rust guarantees `advance: false ⇒ stop.is_some()`, so the arm below is unreachable
    // through the wire. It used to fall back to `"no_next_stage"`, which INVENTS a graph
    // reason for what would be a bound failure — a specific falsehood on a path only a
    // broken verdict can reach, and one that would be indistinguishable in the record from
    // a column that genuinely has no edge. `unknown` says the only true thing available:
    // the verdict refused and this side could not read why. The log line is what makes it
    // a report rather than a shrug (the transcript sentence a person sees cannot carry the
    // diagnostics, and `stop_reason` must not be a guess).
    const stop = verdict.stop;
    if (stop === null || stop === undefined) {
      console.error(
        `workflowRunStep refused to advance ${settle.task.id} with no stop reason`,
      );
      await stopChain(
        settle,
        "unknown",
        "The auto-advance chain stopped: the step verb refused to advance the card and " +
          "gave no reason (`unknown`). The card stays where it is.",
      );
      return;
    }
    await stopChain(settle, stop, boundSentence(stop, verdict.maxSteps, verdict.ceilingUsd));
    return;
  }

  // ── 5. Does the chain continue past the column we are about to arrive in? Read
  // BEFORE the dispatch, because the dispatch is not awaited (header) and this point is
  // the last one that can still ask.
  //
  // A column that is not `auto` ends the chain: nothing will fire a settle hook past it.
  // The run is then CLOSED rather than left open, and that is not tidiness —
  // `workflowRunStep` UPSERTS onto an OPEN run, so a run left open here would hand this
  // chain's step count and running cost to the NEXT chain this card ever starts, and a
  // person who set a 20-step bound would silently get a shorter one. The close happens in
  // [`finishLink`] and not here, so that a launch which then REFUSES still records
  // `launch_refused`: `workflow_run_close` scopes on `finished_at IS NULL`, so a close
  // written before the dispatch would turn the refused case's reason into `manual` and
  // the record would name the wrong bound.
  const arriving = stageOf(settle.spacePath, next.slug);

  // ── 6. Dispatch the next link. `void`, for the reason the header gives: awaiting the
  // next launch's TURN is the `ask`-gate deadlock, and it would be that deadlock one
  // level deeper, not less real. What IS observed is the launch's OUTCOME — the half
  // `launchTaskSession` resolves before any turn runs — because a refused launch has to
  // be seen, not assumed.
  void finishLink(settle, next, arriving === undefined || !arriving.auto);
}

/** Settle the chain's bookkeeping once the next link's OUTCOME is known.
 *
 *  Awaits the launch's outcome and nothing else — never its turn. `launchTaskSession`
 *  refuses THREE different ways and all three are reachable from here: it THROWS when the
 *  column's Skill is not in the catalog (`expandMentions` leaves an unmatched token
 *  byte-identical, so a literal `$ghost` would read to the model as a skill call), it
 *  THROWS when the store's `moveTask` reports the card ended up somewhere other than the
 *  column it was aimed at (a `board_strict` refusal — the case whose swallow used to make
 *  this look like a success), and it answers `{ sessionId: null }` when its in-flight guard
 *  refuses a second launch of the same card. The guard trip is a RETURN and not a throw,
 *  which is why the outcome is read and not merely caught — a `try`/`catch` alone would
 *  call a refusal a success.
 *
 *  A refusal means THIS STEP did not move the card: a missing Skill throws before the move
 *  is resolved, and a refused move reverted the optimistic paint it had already made. That
 *  is the outcome to report — a card that stayed put with a sentence saying why, rather
 *  than a card parked in a column whose Session never started. It is NOT a claim about
 *  where the card is overall (the guard arm names another launch, which may have moved it),
 *  which is why the sentence says "not moved by this step". */
async function finishLink(
  settle: WorkflowSettle,
  next: TaskLaunchDestination,
  chainEndsHere: boolean,
): Promise<void> {
  const refused = async (why: string): Promise<void> => {
    await stopChain(
      settle,
      "launch_refused",
      `The auto-advance chain could not start a Session in \`${next.label}\` — ${why} ` +
        // "The card is where it was" was FALSE in the guard-trip arm: a guard trip means
        // ANOTHER launch of this card is in flight, and that launch may well have moved
        // the card. Every arm of this sentence can say the weaker thing truthfully — the
        // Skill-missing arm throws before the move is resolved, the refused-move arm
        // reverted its own paint, and the guard arm is not the launch that moved anything.
        "(`launch_refused`). The card was not moved by this step.",
    );
  };
  try {
    const outcome = await settle.launch(next);
    if (outcome.sessionId === null) {
      await refused("it was already being launched");
      return;
    }
  } catch (err) {
    await refused(err instanceof Error ? err.message : String(err));
    return;
  }
  if (chainEndsHere) {
    // `"manual"` is the record's own vocabulary for "a person's column took over"
    // (`workflowRunClose`'s doc names it). The four `ChainStop` spellings are the BOUND
    // vocabulary, and this is not a bound — nothing tripped, the graph simply ran out.
    await stopChain(
      settle,
      "manual",
      `The card moved to \`${next.label}\`, which is not an automatic column, so the ` +
        "chain ends here (`manual`).",
    );
  }
}
