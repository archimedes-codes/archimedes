import { costUsdOf } from "../lib/sessionCost";
import type { SessionLookupSource } from "../lib/sessionLookup";
import { workflowAdvanceAdvice, workflowRunClose } from "../lib/tauri";
import type { AdvanceAdvice, StopReason, TaskRow } from "../lib/tauri";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import {
  destinationOf,
  REASON_ALREADY_ADVANCED,
  sentenceFor,
} from "./advanceAdvice";
import type { CostUpdatePayload } from "./interactive";
import { useInteractive } from "./interactive";
import { useSessions } from "./sessions";
import type { TaskLaunchOutcome } from "./taskLaunch";

/**
 * The **auto-advance chain** — the runtime a `stages.auto` column is the switch for.
 *
 * ## What it does
 *
 * A column with `auto: true` means: when the **Session launched on entering this
 * column settles**, move the card to the column its edge names and launch that
 * column's Skill. A board therefore becomes a chain — Skill A → Skill B → Skill C —
 * and each link carries its own column's Skill (`stages.on_enter_skill`, ADR 0098)
 * and its own extra prompt (`stages.prompt_prefix`), because both are read from the row
 * of the column being ENTERED, never from the one being left.
 *
 * ## It ASKS. It no longer derives.
 *
 * One `workflowAdvanceAdvice(sessionId, …)` call answers the whole question — does the
 * card advance, where, with what Skill and prose, is the chain over budget, has this
 * link already been taken — and this module obeys it. `verdict.advance` used to be the
 * only field obeyed and that rule is unchanged; what changed is that the derivation
 * beside it is gone. The old body read `stages.auto` out of the board **slice**, walked
 * `nextStepOf` over the same slice, and only then stepped the run. The slice is
 * populated while a board or a canvas is mounted, and `App`'s view ternary makes both
 * of those mutually exclusive with `ChatStream` — i.e. exactly the case an unattended
 * chain settles in. So the automation silently did nothing, and `workflow_runs` held
 * **zero rows** against 456 Sessions created in a week.
 *
 * Rust answers from the **database**, which is always there, and it answers the same
 * question the model's own `mark_done` tool call was answered with — one decider, so a
 * claim and a fallback cannot disagree about the same card. Re-deriving the next column
 * here anyway would put a second authority beside it, which is the shape ADR 0098
 * exists to prevent, and the bounds and their shipped fallbacks are Rust-only on
 * purpose: re-deriving "is this chain over budget?" would copy a policy number across
 * the wire, one refactor from disagreeing with the first copy, and the disagreement is a
 * chain that runs past a bound a person set.
 *
 * ## Where it is called from, and why there is no watcher
 *
 * `taskLaunch.sendLaunchMessage` `await`s `sendPrompt` and gets the settle **reason**
 * back, and its arguments already carry the Space, the card and the destination column
 * that was launched. That is the settle edge, and it is exact. A subscriber on the
 * sessions store that fired when `inTurn` fell and then read the card's stage from the
 * board slice cannot work: `store/tasks.ts`'s `load` has one call site per **board-shaped
 * surface** — the board's own mount and `WorkflowsCanvas`'s — and neither of those is
 * mounted while the chat column is. That is the worst failure an automation can have:
 * it looks configured and does nothing. The fix was never a watcher on the slice; it is
 * that the question no longer needs the slice.
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
 *
 * ## THE CLOSE RULE, and the field that makes it mechanical (D20)
 *
 * **Close the run only when the chain ends here.** A run left open is not a small thing
 * in either direction, and both directions are load-bearing:
 *
 *  - leaving one open hands this chain's step count and running cost to the NEXT chain
 *    this card ever starts (`workflowRunStep` UPSERTS onto an OPEN run), so a person who
 *    set a 20-step bound silently gets a shorter one;
 *  - closing one that is not finished hands the next link a FRESH run, because the step
 *    verb's `None` branch INSERTs `steps = 1` — and a fresh run resets `cost_usd` to
 *    NULL, which can never trip a ceiling. That turns a 20-step bound into 20 steps
 *    **per link** and a ceiling into a per-link allowance: the spend bound failing open.
 *
 * The mechanical test is the advice's `alreadyLaunched` field, not its `reason`, because
 * `already_advanced` and `cost_ceiling` are mutually exclusive answers from one call and
 * a ceiling stop on a link that ALREADY launched must not close for the same reason the
 * silent arm must not. So every close below is gated on `alreadyLaunched === false`,
 * including the `max_tokens` / `cancelled` whitelist arm, which used to close
 * unconditionally — a model that claimed (launching its next link) and then got cut off
 * would have reset the very budget D20 exists to protect, with no `stop_reason` changing.
 *
 * THE GATE IS ON EVERY CLOSE PATH, AND THAT IS A CODE FACT AND NOT A BORROWED ONE.
 * `finishLink`'s three closes (the guard trip, the skipped-move note, and the success
 * arm's `manual`) sit behind the same test, which is where they used NOT to be: they were
 * safe only because Rust's arm 3 returns `already_advanced` before its arms 6/7, so an
 * `advance: true` payload always happens to carry `alreadyLaunched: false`. Resting a
 * spend bound on the ORDER of `if`s in another language, asserted by nothing on this side,
 * is the failure this repo keeps cataloguing — an arm reorder would have opened the bound
 * with every TypeScript test green. The pins for the gated behaviour are in
 * `workflowChain.test.ts`'s D20 block, and they are DEFENSIVE: none of them claims Rust
 * emits an `advance: true` + `alreadyLaunched: true` payload today (it cannot), only that
 * this side does not close a run on one.
 */

/** The settle this runtime was called on: everything the edge already knows, so this
 *  module has to look nothing up that the caller was holding.
 *
 *  NOTE what this no longer decides anything about. The advice is keyed on
 *  `sessionId` ALONE, and Rust resolves the card, the Space, the launching column, the
 *  edge and both budgets from the database — so `spacePath` and `launchedSlug` are
 *  context, not inputs. `launchedSlug` in particular used to be the key this module
 *  looked its `auto` flag up by; the database's frozen `task_sessions.stage_slug` is a
 *  better answer for the same question (it is the column the launch actually happened
 *  in, not what this window believed when it painted), so nothing here reads the slice
 *  at all any more. */
export interface WorkflowSettle {
  spacePath: string;
  /** The card, as the launch surface holds it. The fallback for the run's owner: the
   *  advice carries the card IT resolved its decision for, and the step write and the
   *  close must name the SAME row or the run stays open forever. */
  task: TaskRow;
  /** The Session that just settled — the transcript a stop sentence goes into, and the
   *  ONLY thing the advice is keyed on. */
  sessionId: string;
  /** WHY the turn ended. Only `"end_turn"` advances; see the whitelist in
   *  [`advanceWorkflowChainOnSettle`]. */
  reason: StopReason;
  /** The column that was LAUNCHED (its `slug`). Kept for the record and for the
   *  caller's own wiring, NOT consulted for the decision — see the header. */
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
   *  `taskLaunch` wires it to `launchTaskSession`, i.e. to the FULL move verb, AND to
   *  the destination the advice carried rather than a bare slug — so the move, the Skill
   *  and the extra prompt all arrive from the one `StageDto` Rust read, and none of them
   *  needs a board slice to exist. It refuses THREE different ways — it THROWS for a
   *  Skill the catalog lacks, it THROWS when `moveTask` reports the card ended in a
   *  column other than the one it was aimed at, and it answers `{ sessionId: null }`
   *  when its in-flight guard trips with NOBODY behind the guard — and all three are
   *  handled in [`finishLink`]. The guard's fourth answer is the one that is NOT a
   *  refusal: when the trip is caused by the chain's OWN pending claim, the executor
   *  awaits that claim and returns its outcome, so this runtime never sees the case. See
   *  [`finishLink`]'s invariant. */
  launch: (next: TaskLaunchDestination) => Promise<TaskLaunchOutcome>;
}

/** What ONE turn spent, from the figure on each side of it.
 *
 *  The advice ADDS its argument to the run's banked figure (`COALESCE(cost_usd, 0.0) +
 *  ?`), so what it is handed has to be a delta. The figure `costUsdOf` answers is a
 *  running TOTAL, and feeding a total into an additive column sums the totals: a
 *  three-link chain whose Sessions cost $1, $2 and $3 in total would record $6 against
 *  a ceiling the person set for $3, and the guard would fire early while every Rust test
 *  stayed green. That is a fabricated number, so this returns one only when it can
 *  compute it.
 *
 *  THIS IS THE CALL WHERE THE CEILING IS EVALUATED (D18). It is the only place in the
 *  tree that holds a real cost figure, so it is the only place a ceiling can trip: at
 *  the claim the turn is still running and no delta for it exists. Which makes the
 *  `null` half ADR 0082 verbatim, and load-bearing rather than tidy:
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

/** The card whose run this settle is allowed to close.
 *
 *  The advice's, when it has one: Rust stepped the run of the card IT resolved from the
 *  newest link, and a step write and its close must name the same row or the run sits
 *  open forever. `settle.task` is the fallback for the arms that never got an answer. */
function runOwner(settle: WorkflowSettle, advice: AdvanceAdvice | null): string {
  return advice?.taskId ?? settle.task.id;
}

/** Record the stop, then say so — one call per stop, so the record and the sentence
 *  cannot disagree about why a chain ended.
 *
 *  Reached only when the chain ENDS here. A refusal on a link that already launched goes
 *  to `tellWhyStopped` alone: say it, do not close it (the module header's close rule). */
async function stopChain(
  settle: WorkflowSettle,
  advice: AdvanceAdvice | null,
  reason: string,
  sentence: string,
): Promise<void> {
  await closeRun(runOwner(settle, advice), reason);
  tellWhyStopped(settle.sessionId, sentence);
}

/** The sentence for a reason this build does not know.
 *
 *  `advance: false` with a `reason` `advanceAdvice.ts` has no case for is a payload from
 *  a newer Rust than this renderer. The old arm fell back to `"no_next_stage"`, which
 *  INVENTS a graph reason for what might be a bound failure — a specific falsehood on a
 *  path only a broken or newer payload can reach, and one indistinguishable in the
 *  record from a column that genuinely has no edge. `unknown` says the only true thing
 *  available, and the log line is what makes it a report rather than a shrug (the
 *  transcript sentence a person sees cannot carry the diagnostics, and `stop_reason` must
 *  not be a guess). */
const UNKNOWN_SENTENCE =
  "The auto-advance chain stopped: the advance verb refused to advance the card and " +
  "gave a reason this build does not recognise (`unknown`). The card stays where it is.";

/** The chain step: settle in, advice obeyed, next link dispatched or run closed.
 *
 *  Every early return is a DIFFERENT reason and each is recorded with its own, so the
 *  chain's history reads as the truth. Nothing here writes `stages.auto` — see the
 *  header. */
export async function advanceWorkflowChainOnSettle(
  settle: WorkflowSettle,
): Promise<void> {
  // The delta is computed once, before any branch, because BOTH arms hand it over: the
  // whitelist arm needs it to keep the ceiling reachable on a cut-off turn, and the
  // ordinary arm is where the ceiling is actually evaluated (D18). No `?? 0` and no
  // `|| null` anywhere on the way — see [`costDeltaOf`].
  const costDeltaUsd = costDeltaOf(
    settle.costBeforeTurnUsd,
    sessionCostFigure(settle.sessionId),
  );

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
    // The run is CLOSED rather than left open — UNLESS the link already launched.
    // This arm used to close unconditionally, and the close was the bug rather than the
    // spelling: a model that called `mark_done` (so the next link is already launched and
    // running) and THEN got cut off by `max_tokens` would close the run its own claim had
    // just stepped, and the next link's step would open a fresh run at `steps = 1` with
    // `cost_usd` NULL — a per-link budget, reached with no `stop_reason` changing at all.
    // So the same `alreadyLaunched` test applies here, and the advice call that answers
    // it costs nothing extra: it is the one call this settle makes either way.
    //
    // It is read in a `try` and the fallback on failure is the OLD behaviour (close):
    // a run this side could not read is a run it must leave closed rather than leak into
    // the next chain. The sentence goes out either way — it is a true statement about
    // THIS turn regardless of what the link did.
    //
    // The reason is stored verbatim (`"cancelled"`, `"max_tokens"`, …) because
    // `stop_reason` is the record's only narrative field and the wire's own vocabulary is
    // the truest thing to put in it.
    let alreadyLaunched = false;
    let advice: AdvanceAdvice | null = null;
    try {
      advice = await workflowAdvanceAdvice(settle.sessionId, costDeltaUsd);
      alreadyLaunched = advice.alreadyLaunched;
    } catch (err) {
      console.error(
        `Could not read the advance advice for ${settle.sessionId} on a ${settle.reason} settle:`,
        err,
      );
    }
    if (!alreadyLaunched) {
      await closeRun(runOwner(settle, advice), settle.reason);
    }
    tellWhyStopped(
      settle.sessionId,
      `This Session ended (\`${settle.reason}\`) without advancing the card — only a ` +
        "turn that finishes drives an auto-advance chain.",
    );
    return;
  }

  // ── 2. Ask. One call, one authority, no slice, and the real cost delta — this is the
  // only ceiling evaluation left in the tree (D18), so a `null` here is the ceiling
  // staying unarmed and a `0` would arm it against a chain that never reported money.
  //
  // A REJECTION PROPAGATES. This side cannot know whether the step landed, so it will not
  // invent a `stop_reason` for a write it did not read, and it certainly will not move a
  // card on the strength of an answer it never saw. `sendLaunchMessage`'s `.catch` is the
  // one owner of that case and reports it the way this file reports everything else it
  // cannot rethrow — a line in the Session it failed in.
  const advice = await workflowAdvanceAdvice(settle.sessionId, costDeltaUsd);

  // ── 3. The instruction. `destinationOf` is the ONLY reading of `advance`: `advance` is
  // the authority and a row is never a proxy for it. It returns null for every
  // non-advancing reason, `already_advanced` among them — and note the reason is NOT that
  // the dedupe leaves a resolved row sitting on the payload for a careless reader to trip
  // on. Rust answers that arm with `destination: None` (arm 3 of `advise.rs`); the row its
  // dedupe looks at is a local read for the lookup and is never serialised. So nothing on
  // this side is defending against a smuggled row — the guard is simply that a refusal is
  // not an instruction, whatever its `destination` field happens to hold.
  const destination = destinationOf(advice);
  if (destination !== null) {
    // Does the chain continue past the column we are about to arrive in? Read from the
    // SAME row the destination came from — the arriving column's `auto` flag is on it, so
    // this asks the database rather than a slice, and it is the last point that can ask
    // before the dispatch (which is not awaited, header).
    //
    // A column that is not `auto` ends the chain: nothing will fire a settle hook past it.
    // The run is then CLOSED rather than left open, and that is not tidiness — see the
    // close rule in the header. The close happens in [`finishLink`] and not here, so that
    // a launch which then REFUSES still records `launch_refused`: `workflow_run_close`
    // scopes on `finished_at IS NULL`, so a close written before the dispatch would turn
    // the refused case's reason into `manual` and the record would name the wrong bound.
    //
    // An absent row here is impossible (`destinationOf` returned a destination, which is
    // built FROM the row); defaulting to "ends here" is the conservative reading of a
    // payload that cannot be, because a leaked-open run is the worse of the two errors.
    const chainEndsHere = !(advice.destination?.auto ?? false);
    void finishLink(settle, advice, destination, chainEndsHere);
    return;
  }

  // ── 4. `already_advanced` is the SILENT arm (D20): no `stopChain`, no close, no word
  // in the transcript. The claim path owns this link and already spoke, and closing the
  // run the claim just stepped hands the next link a fresh run at `steps = 1` with
  // `cost_usd` NULL — a 20-step bound becomes 20 steps PER LINK and a ceiling becomes a
  // per-link allowance, which is the spend bound failing open. This arm is also why the
  // settle fallback is not merely a duplicate of the claim: it is the arm that PROVES the
  // claim landed, and its whole job is to get out of the way.
  if (advice.reason === REASON_ALREADY_ADVANCED) return;

  // ── 5. A refusal that must reach a person.
  const sentence = sentenceFor(advice);
  if (sentence === null) {
    // An `advance: false` with no sentence this build knows: a reason from a newer Rust,
    // or an `advance: true` whose row went missing. Neither is a reason to guess.
    console.error(
      `workflowAdvanceAdvice refused to advance ${settle.task.id} with a reason this ` +
        `build cannot speak: ${JSON.stringify(advice.reason)}`,
    );
    if (!advice.alreadyLaunched) {
      await stopChain(settle, advice, "unknown", UNKNOWN_SENTENCE);
    }
    return;
  }
  // The `stop_reason` spelling: the bound's own, when a bound stopped it, and the
  // Session-shaped refusal's `reason` otherwise (`unclaimed`, `not_automatic`,
  // `unlinked`) — those three have no spelling in the `ChainStop` enum by design (adding
  // one would be an enum change plus a migration to say what a string already says), and
  // `stop_reason` is free text whose whole job is the narrative.
  //
  // And the close is gated, not assumed: a ceiling that trips on a link which ALREADY
  // launched is still true and still worth saying, but closing there would reset the
  // cost the next link inherits and hand the chain a fresh allowance.
  if (!advice.alreadyLaunched) {
    await stopChain(settle, advice, advice.stop ?? advice.reason, sentence);
    return;
  }
  tellWhyStopped(settle.sessionId, sentence);
}

/** Settle the chain's bookkeeping once the next link's OUTCOME is known.
 *
 *  Awaits the launch's outcome and nothing else — never its turn. `launchTaskSession`
 *  refuses THREE different ways and all three are reachable from here: it THROWS when the
 *  column's Skill is not in the catalog (`expandMentions` leaves an unmatched token
 *  byte-identical, so a literal `$ghost` would read to the model as a skill call), it
 *  THROWS when the store's `moveTask` reports the card ended up somewhere other than the
 *  column it was aimed at (a `board_strict` refusal — the case whose swallow used to make
 *  this look like a success — or a destination a slice never had), and it answers
 *  `{ sessionId: null }` when its in-flight guard trips and NOTHING is behind the guard.
 *  A refusal is a RETURN and not a throw for the last of the three, which is why the
 *  outcome is read and not merely caught — a `try`/`catch` alone would call a refusal a
 *  success.
 *
 *  ## THE INVARIANT, and where this function's half of it lives
 *
 *  **A guard trip caused by the other chain door is NOT a refusal, and must never close
 *  the run.** The two doors (`consumeAdvanceAdvice`, rAF-deferred, and this runtime,
 *  deferred by nothing) launch the same card for the same link, and since the claim began
 *  taking its reservation synchronously it can HOLD the key across three IPC reads while a
 *  settle trips on it. That trip used to answer `{ sessionId: null }` like a refusal, this
 *  function recorded `launch_refused`, and `workflowRunClose` closed the live run — so the
 *  next link's step verb re-INSERTed at `steps = 1` with `cost_usd` NULL: `max_steps` and
 *  the cost ceiling restart per link, the spend bound failing open, beside a false "could
 *  not start a Session in X" in the transcript.
 *
 *  The fix sits in `taskLaunch` and not here, deliberately: the executor is the one party
 *  that can tell WHICH kind of trip it has, because it is the one holding the registry, so
 *  it answers an other-door trip with the holder's outcome and this arm never sees one.
 *  What this function keeps is the honest half — a `null` that reaches it means no launch
 *  happened (nobody else is launching the card, or the other door tried and launched
 *  nothing), and a step that started nothing is a refusal that must be recorded AND closed,
 *  or the run leaks into the next chain. Both halves are pinned: the other-door case in
 *  `taskLaunch.claim.test.ts` and in "does NOT close when the claim holds the card" here,
 *  the genuine refusal in "closes with launch_refused when NOTHING is launching the card".
 *
 *  A refusal means THIS STEP did not move the card: a missing Skill throws before the move
 *  is resolved, and a refused move reverted the optimistic paint it had already made (or,
 *  on the slice-free arm, never made one). That is the outcome to report — a card that
 *  stayed put with a sentence saying why, rather than a card parked in a column whose
 *  Session never started. It is NOT a claim about where the card is overall (the guard arm
 *  names another launch, which may have moved it), which is why the sentence says "not
 *  moved by this step". */
async function finishLink(
  settle: WorkflowSettle,
  advice: AdvanceAdvice,
  next: TaskLaunchDestination,
  chainEndsHere: boolean,
): Promise<void> {
  // THE SAME GATE AS ARM 5, and it binds here too. `alreadyLaunched` is the mechanical
  // test for "the run this link stepped is still live", and a close from inside the link
  // resets it exactly as a close from the refusal arms would: `workflowRunStep`'s `None`
  // branch re-INSERTs at `steps = 1` with `cost_usd` NULL, so a 20-step bound becomes 20
  // steps PER LINK and a ceiling becomes a per-link allowance.
  //
  // Rust cannot answer `advance: true` with `alreadyLaunched: true` today — its arm 3
  // returns `already_advanced` before the advancing arms — so this gate is currently
  // unreachable, and that is precisely why it belongs HERE rather than in a comment: the
  // un-gated version rested on an arm ORDER in another language, asserted by nothing on
  // this side, and an arm reorder would open the spend bound silently. The gate makes the
  // header's sentence true OF THE CODE instead of true of Rust's current `if` chain.
  const mayClose = !advice.alreadyLaunched;
  /** Record a stop, or say it without recording it. A refusal on a launched link is still
   *  TRUE and still worth a transcript line — it is only the CLOSE that is withheld. */
  const stopOrSay = async (reason: string, sentence: string): Promise<void> => {
    if (mayClose) {
      await stopChain(settle, advice, reason, sentence);
      return;
    }
    tellWhyStopped(settle.sessionId, sentence);
  };
  const refused = async (why: string): Promise<void> => {
    await stopOrSay(
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
      // THE GUARD ARM, and the sentence is about THIS STEP rather than about a cause. It
      // used to say "it was already being launched", and since the other-door fix that is
      // FALSE on one of the two shapes that reach here: a trip whose holder was the chain's
      // own pending claim means that launch has ALREADY finished and started nothing — and
      // the claim has just written its own line saying so ("nothing launched; the card
      // stayed where it was"), so a second sentence claiming a launch was in flight would
      // contradict it in the same transcript. What this arm can see is true of both shapes:
      // something held the card's guard, and this step started nothing. The other shape it
      // can reach — a double click — is honest under the same wording.
      await refused("another launch of this card held its guard, and this step started nothing");
      return;
    }
    if (outcome.note !== null) {
      // THE MOVE WAS SKIPPED, and a Session that started anyway is not a success for THIS
      // step. `launchTaskSession` sets `note` on exactly one arm — `missingColumnNote`,
      // the destination is absent from a LOADED slice, i.e. the STALE case that D19
      // deliberately does NOT trust — so a non-null note here means the card stayed where
      // it was while the next link's Session started against it. Closing `manual` on that
      // would write "the card moved to Implement" into the chain's history for a card a
      // person can see sitting in Research, which is the record-level version of the
      // swallowed refusal this function exists to stop.
      await stopOrSay(
        "launch_refused",
        `The auto-advance chain could not move the card into \`${next.label}\` — ` +
          `${outcome.note} The Session that started is working the column the card is ` +
          "actually in (`launch_refused`).",
      );
      return;
    }
  } catch (err) {
    await refused(err instanceof Error ? err.message : String(err));
    return;
  }
  // The success arm's close. Silent when the gate is shut, and that is the honest half
  // rather than a convenience: `manual`'s sentence claims "the chain ends here", which is
  // the very claim a withheld close refuses to make. A launched link keeps its run open for
  // the link that already launched — arm 4's rule, applied to the same field.
  if (chainEndsHere && mayClose) {
    // `"manual"` is the record's own vocabulary for "a person's column took over"
    // (`workflowRunClose`'s doc names it). The four `ChainStop` spellings are the BOUND
    // vocabulary, and this is not a bound — nothing tripped, the graph simply ran out.
    await stopChain(
      settle,
      advice,
      "manual",
      `The card moved to \`${next.label}\`, which is not an automatic column, so the ` +
        "chain ends here (`manual`).",
    );
  }
}
