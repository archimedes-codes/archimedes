import { expandMentions } from "../lib/skills";
import {
  buildLaunchMessage,
  type TaskLaunchDestination,
} from "../lib/taskPrompt";
import {
  getTask,
  listAgentDefinitionsForSpace,
  listSkills,
  sendPrompt,
  startTaskSession,
  type AcpSessionUpdate,
  type SessionInfo,
} from "../lib/tauri";
import { describeIpcError } from "../lib/ipcError";
import type { AgentDefinitionDto, SkillInfo, TaskRow } from "../lib/tauri";
import { useSessions } from "./sessions";
import { useTasks } from "./tasks";
// The move arm a launch with no board slice needs (D19). The MODE is passed to the
// store action, which forwards it to `taskMove.moveTaskVerb` — the one owner of the verb.
import { BOARD_REQUIRED, NO_BOARD } from "./taskMove";
// The ONE reader of Rust's advance advice, and the claim path's whole first half.
import { destinationOf, readAdvanceAdvice } from "./advanceAdvice";
// The auto-advance chain's settle edge, and the money figure it needs from before the
// turn. TYPE-ONLY cycle by construction: `workflowChain` takes its next launch as an
// ARGUMENT of the settle rather than importing `launchTaskSession`, so the runtime edge
// here is one-way and there is no initialisation order to get wrong.
import { advanceWorkflowChainOnSettle, sessionCostFigure } from "./workflowChain";

/**
 * The ONE orchestration behind "open this **Task** as a **Session**", shared by the
 * Task detail modal's launch buttons and the New Task modal's two buttons.
 *
 * ## What moved here, and why it is not in a component
 *
 * `NewTaskDialog` owned this sequence privately and correctly (create → start →
 * select → send, in that order, for the reasons its header records). Task
 * interaction adds a SECOND family of launch surfaces, and a second copy of a
 * write-ordering rule is exactly the drift this repo documents: the order inside the
 * sequence IS the feature, so the sequence needs one owner. The components keep the
 * part that differs — which DESTINATION column a click means, whether it launches at
 * all, and what to paint.
 *
 * ## The destination Stage replaced the mode (issue #179, ADR 0098)
 *
 * Every function here used to thread a `TaskLaunchMode` literal, and a `switch` in
 * `lib/taskPrompt` translated that literal into a skill name and a preferred column.
 * That made the TypeScript a second authority beside the `stages` rows, and
 * `resolveStage` was already printing "This Space has no `research` column" as the
 * sound of the two disagreeing. A Stage row now answers all three questions — its
 * `slug` is where the card goes, its `label` is the instruction sentence, its
 * `on_enter_skill` is the Skill — and this module resolves the row from the SAME
 * `boardsBySpace` slice the board renders, so a Space that renames a column changes
 * the button, the gate, the prompt and the move together.
 *
 * ## The order, and the three rules that make it load-bearing
 *
 *  1. **Move before start.** `task_sessions.stage_slug` records the stage the card
 *     was in when linked, and that stage is what a later drag into a `compact`
 *     column compacts FROM (`pick_compact_target` in `commands/tasks.rs`). A
 *     Research launch that started first would anchor the link at `backlog` for a
 *     Session that only ever worked in `research`.
 *  2. **Create before start** (the draft path). `task_sessions.task_id` carries NO
 *     foreign key (ADR 0090), so `write_task_session_link` gates the link on a
 *     `get_task` existence check and REFUSES an explicit stage for a Task that does
 *     not exist. Start first and the link is refused: a live orphan Session and a
 *     card with no Session.
 *  3. **Expand, then append the `<task>` block** — never the reverse, and never
 *     expand over the block. `lib/taskPrompt`'s `buildLaunchMessage` owns that
 *     ordering so a call site cannot get it wrong; see its header for the injection
 *     argument.
 *
 * ## The turn settles even on failure
 *
 * `turnCompleted` is the ONLY frontend path that clears `inTurn`. A launch that
 * rethrows without settling leaves the composer locked and the working indicator
 * spinning for the life of the Session — so the `catch` settles FIRST and then
 * rethrows, which is the asymmetry `NewTaskDialog` documented for its own send.
 *
 * ## Why the skill must exist in the catalog
 *
 * `expandMentions` leaves an UNMATCHED token byte-identical. Launching `discuss`
 * against a Space whose catalog has no `discuss` skill would therefore ship the
 * literal `$discuss` to the model — a confident, well-formed nothing that reads
 * like a skill call. So an absent skill REFUSES the launch rather than degrading,
 * which is the same reason `NewTaskDialog`'s dropdown only ever offered names the
 * catalog had.
 *
 * ## Why the column is CHECKED and not assumed
 *
 * A destination slug arrives from a button the board painted, so under #179 it names
 * a row that exists — but the slice can still be STALE (a column deleted in another
 * window) or NEVER LOADED, and `move_task` / `create_task` REFUSE an unknown slug
 * rather than filing an invisible card (ADR 0090). So the board is consulted first,
 * and:
 *  - a launch SKIPS the move and reports the skip in its return value (a click whose
 *    job was to open a Session must not fail because a column went away);
 *  - a draft CREATE falls back to the board's FIRST column, which is what the modal
 *    did before this change — losing the user's text to a renamed column is worse
 *    than filing it somewhere visible.
 *
 * ## `mcpServers` is EMPTY here, on purpose
 *
 * The literal `[image #3]` marker IS a `#` mention token, and the workspace's send
 * path masks it out before expanding precisely because an MCP server named `3`
 * would otherwise get a block appended to a prompt nobody asked for. That mask lives
 * inside `useChatPromptDispatch.sendText`, which this module does not route through;
 * so, exactly as `NewTaskDialog` concluded, the precondition is removed instead of
 * the rule being copied. A launch message carries no image marker and no `#`
 * catalog, so nothing can match.
 */

/** The catalogs a launch expands against. The caller already holds both (the board
 *  surface fetches them for its Mention picker), so this module takes them as an
 *  argument rather than owning a third catalog cache — `lib/` fetches, `store/`
 *  orchestrates, and neither here. */
export interface TaskLaunchCatalogs {
  skills: SkillInfo[];
  agents: AgentDefinitionDto[];
}

/** What a launch did.
 *
 *  `sessionId` is the Session that was started, or `null` when nothing was started
 *  — the Backlog button files a card and opens nothing, and the re-entrancy guard
 *  answers `null` rather than throwing at a second click. It is returned so a caller
 *  can tell "opened" from "refused"; the sidebar row and the visible transcript are
 *  already handled by `addSession`, which selects.
 *
 *  `note` is a WARNING and never a failure — the Session started, the card exists.
 *  It is the "your Research column is gone" case, which is this repo's documented
 *  silent-green shape made visible: a configured effect that did not fire. */
export interface TaskLaunchOutcome {
  sessionId: string | null;
  note: string | null;
}

/** A create's outcome: the card the server wrote, plus what the launch did. */
export interface TaskCreateOutcome extends TaskLaunchOutcome {
  task: TaskRow;
}

/** Nothing was started. */
const NOTHING: TaskLaunchOutcome = { sessionId: null, note: null };

/** The create that must NOT launch a Session — the New Task modal's save-only button.
 *
 *  It is a real destination rather than a `null` or a separate `launch: boolean`
 *  argument on purpose: the button still files the card in a column, so it still has
 *  a slug and a label, and the ONLY thing that differs from a launch is that nothing
 *  is started afterwards. `launches: false` says that directly.
 *
 *  `slug: "backlog"` is the seeded column it belongs to and it is NOT inert: the
 *  create still writes that column explicitly, which is what keeps a card out of
 *  "whatever happens to be first" on a Space whose board was reordered (pinned in
 *  `NewTaskDialog.test.tsx` as "files it in the backlog column, not the board's first
 *  column"). `onEnterSkill: null` is what makes `missingSkill` never refuse it.
 *
 *  `promptPrefix: null` for the same reason and a different mechanism: this constant
 *  is a literal, not a row, so there is no `stages.prompt_prefix` cell to read and no
 *  column-specific framing to carry. A save-only create starts no Session at all, so
 *  the field could not reach a message even if it held text — `null` says so rather
 *  than inventing prose for a button whose whole job is to start nothing.
 *
 *  NOTE the deliberate divergence from the plan this task was written against, which
 *  specified `slug: ""` with the save-only arm keyed on that empty string. An empty
 *  slug falls through to the board's FIRST column, which silently changes that pinned
 *  behaviour on any Space whose first column is not `backlog` — and `NewTaskDialog
 *  .test.tsx` is outside this task's owned file set, so the pin is not mine to
 *  rewrite. `launches` is the same decision spelled without a magic string. */
export const SAVE_ONLY: TaskLaunchDestination = {
  slug: "backlog",
  label: "Backlog",
  onEnterSkill: null,
  promptPrefix: null,
  launches: false,
};

/** Launches currently in flight, keyed by the thing being launched.
 *
 *  A module `Set` and not `useState`, for the reason `useAsyncAction`'s header
 *  records: a `guard` flag reads RENDERED state, so two clicks delivered inside one
 *  batch both get through. A double click on Research would otherwise start TWO
 *  Sessions and link both — the card would then read "2 sessions" for one intent.
 *
 *  Module scope means it survives a component unmount, which is what makes the
 *  guard hold when a modal closes mid-flight; `resetTaskLaunchInFlight()` below is
 *  the test seam, because `src/test/resetStores.ts` cannot reach a module `let`. */
const inFlight = new Set<string>();

/** Test-only: clear the in-flight guard (a module `Set` is not store state). */
export function resetTaskLaunchInFlight(): void {
  inFlight.clear();
}

/** The destination column this Space actually has, and what to write.
 *
 *  Returns the slug to write, or `null` for "do not write a column". A card whose
 *  stored stage is already the destination is `null` too: `moveTask`'s own guard
 *  drops a same-column move silently, so firing it would be an IPC that provably
 *  does nothing.
 *
 *  Since ADR 0098 there is no "do not move it" arm for a chosen destination: the
 *  wanted slug is ALWAYS the destination, because the destination is a real row the
 *  caller painted a button for (the old `stageOfMode("discuss") === null` case — a
 *  mode with no column — cannot arise when the column is where the button came FROM).
 *
 *  `absent` reports the case the caller must surface: a destination was asked for and
 *  this Space's slice does not have it. `undefined` means "nothing to say".
 *
 *  It stays reachable rather than being deleted as "unreachable under #179", for two
 *  reasons this repo cares about. (1) An absent slice means NEVER LOADED, not "no
 *  columns", and neither proves the destination exists — guessing is a refused write
 *  and an error line under a click that succeeded. (2) The slice can go stale between
 *  painting the button and clicking it (a column deleted in another window), which is
 *  the same shape the detail modal's header argues about. The draft-create flow needs
 *  it too: a new card falls back to the board's FIRST column so a draft is never lost
 *  for want of a column.
 *
 *  `trusted` is D19's arm, and it keys on ONE of the two refusals below: an absent
 *  slice (NEVER LOADED) becomes a write rather than a note, because the caller is an
 *  auto-advance chain whose destination came from a `StageDto` Rust read out of the
 *  DATABASE, and a board slice is by construction not mounted in the window that
 *  settles (that is the defect that left `workflow_runs` holding zero rows). The
 *  SECOND refusal — a loaded slice that does not contain the slug, i.e. STALE — is
 *  deliberately NOT bypassed. It is the case `TaskDetailDialog` renders as a NOTE
 *  ("T3 stayed in `doing`") and not an error; collapsing the two would send that move
 *  to the server, where `Db::move_task` refuses it with `missing_stage` and the dialog
 *  shows a failure where it showed a note. No pin covers the note, so nothing would
 *  redden — hence this paragraph rather than one shared `absent` return. */
function resolveStage(
  spacePath: string,
  task: TaskRow,
  destination: TaskLaunchDestination,
  trusted = false,
): { slug: string | null; absent?: true; sliceFree?: true } {
  const wanted = destination.slug;
  const columns = useTasks.getState().boardsBySpace[spacePath];
  // Absent board slice is "NEVER LOADED", not "no columns" — and neither proves a
  // destination column exists, so a caller that holds no row of its own answers
  // "cannot write it". Guessing is a refused write and an error line under a click that
  // succeeded. A TRUSTED caller does hold a row: the advice's, read from the database.
  if (columns === undefined) {
    // `sliceFree` is the mode the MOVE needs, not just this function's answer: with no
    // slice, `useTasks.moveTask`'s default arm refuses ("No board loaded for this
    // Space.") and a refusal here is a throw and a `launch_refused` on a write that
    // would have succeeded. So the caller is told which arm it is in rather than
    // re-deriving it from the store a second time.
    return trusted ? { slug: wanted, sliceFree: true } : { slug: null, absent: true };
  }
  // A loaded slice without the slug is STALE, and stale is never trusted (above).
  if (!columns.some((c) => c.stage.slug === wanted)) {
    return { slug: null, absent: true };
  }
  if (task.stageSlug === wanted) return { slug: null };
  return { slug: wanted };
}

/** The sentence for a destination whose column this Space does not have.
 *
 *  Names the slug in backticks and lowercase on purpose: it is the slug the caller
 *  asked for, and the detail modal's test resolves the word in it. The sentence is
 *  byte-identical to the pre-#179 one and is pinned in THREE files — do not reword
 *  it as a side effect of touching this module. */
function missingColumnNote(task: TaskRow, wanted: string): string {
  return (
    `This Space has no \`${wanted}\` column, so T${task.number} stayed in ` +
    `\`${task.stageSlug}\`.`
  );
}

/** Refuse a launch whose skill the catalog does not have.
 *
 *  Returns `null` when the destination needs no skill or the catalog has it. The
 *  thrown error names the skill, because the operator's next action is "install that
 *  skill" and a message that does not say which one is not actionable.
 *
 *  The NAME now comes from the Stage row (`onEnterSkill`) rather than from a
 *  `switch`, which is what makes the refusal honest for a Space that configured its
 *  own Skill: the sentence names the skill the row actually asks for. A Stage with no
 *  Skill answers `null` first and never refuses. */
function missingSkill(
  destination: TaskLaunchDestination,
  catalogs: TaskLaunchCatalogs,
): Error | null {
  const skill = destination.onEnterSkill;
  if (skill === null) return null;
  const known = catalogs.skills.some((s) => s.name === skill);
  // A skill marked `disable-model-invocation` is still launchable: ADR 0036 drops
  // it from the Agent-offered tool list, but a `$name` Mention reaches it whenever
  // the mention grammar can carry the name, which is exactly this path.
  return known ? null : new Error(`This Space has no \`${skill}\` skill to load.`);
}

/** Decide whether a launch must INLINE the skill body or may send the bare token.
 *
 *  Default: send the token and let the model load it. The system prompt's
 *  `<available_skills>` section already instructs the model to load a skill BY
 *  NAME with `read_skill`, and the launch's own instruction line ("Let's work on
 *  Research.") names the Stage whose Skill is being asked for, which is a phrase the
 *  merged `research` Skill's description advertises, so the load is organic rather
 *  than a token the model has to decode.
 *
 *  Inlining `discuss` put 18 KB (and 12 KB for `research`) into every launch
 *  message. Worse, `expandMentions` APPENDS its block at the END of the text while
 *  `buildLaunchMessage` concatenates the `<task>` block AFTER the expansion, so the
 *  wire shape was `<skill>…</skill>` then `<task>…</task>`. `MessageBubble` renders
 *  through `splitMentionBlocks`, whose NO-LOSS rule refuses to parse when anything
 *  trails the last block, so it bailed and printed the whole skill as literal text
 *  in the user's own bubble — measured on a real launch: 0 blocks collapsed, 18,076
 *  of 18,076 characters raw.
 *
 *  Two cases still need the body inlined, and both are about the token route being
 *  UNAVAILABLE rather than merely unwelcome:
 *   - `disableModelInvocation` — `read_skill` REFUSES such a skill ("the Agent may
 *     not load it"), so a token would open a Session with no methodology and no
 *     error. Client-side inlining is the only route that reaches it, which is what
 *     `missingSkill`'s comment means by "a `$name` Mention reaches it … exactly this
 *     path". NOTE the consequence: in that case the raw-dump rendering still
 *     happens, because the block is still appended before the `<task>` block. That
 *     is the pre-existing shape, and it is a display wart on a path that must stay;
 *     the renderer's NO-LOSS rule is load-bearing for pasted-block cases
 *     (`skills.test.ts`) and was left alone deliberately.
 *
 *  There is deliberately no "name outside the `$` grammar" arm. The Skill name is
 *  whatever `stages.on_enter_skill` holds, and `missingSkill` already REFUSED any
 *  launch whose catalog has no exact-named row — so an unmatchable name can never
 *  reach here. An arm for it would be unreachable code pretending to be a guard.
 *
 *  The same argument is STRONGER than it was when the name came from the mode table:
 *  a user-typed Skill name is more likely to sit outside the grammar, and it still
 *  cannot get here, because the catalog row is the precondition for reaching this
 *  line at all. No new inlining logic arrives with a Stage-owned Skill (spec §6.2) —
 *  the bare-token route generalises for free.
 */
function shouldInlineSkill(
  destination: TaskLaunchDestination,
  catalogs: TaskLaunchCatalogs,
): boolean {
  const name = destination.onEnterSkill;
  if (name === null) return false;
  const skill = catalogs.skills.find((s) => s.name === name);
  // `undefined` cannot reach here either (the same guard), but inlining is the
  // safe answer for a catalog we cannot read, so it is not a panic.
  return skill?.disableModelInvocation ?? true;
}

/**
 * Open an EXISTING card as a Session: optionally move it, start a linked Session,
 * select it, and send the first message.
 *
 * Resolves what the launch did and REJECTS when the Session could not be started or
 * the prompt could not be sent — the caller renders that through `describeIpcError`.
 * A rejection after the Session exists leaves the Session live and listed: that is
 * the honest outcome, and the user can retry from the sidebar row.
 *
 * ## The destination is a slug OR a row, and the difference is the D19 arm
 *
 * `toStageSlug` names the DESTINATION column, and it replaced a mode for the reason
 * ADR 0098 gives: the destination Stage IS the mode. Its row supplies the label the
 * instruction sentence names, the Skill the message loads, and the extra prompt the
 * message opens with — so the button a person clicked and the prompt that goes out
 * cannot disagree about what that column means.
 *
 *  - Pass a **`string`** (every board surface) and the row is read from the
 *    `boardsBySpace` slice the board renders. No slice → the move is skipped and the
 *    launch reports the skip in its `note`. That is right for a click: the person is
 *    standing in front of a board that just changed under them.
 *  - Pass a **[`TaskLaunchDestination`]** (the auto-advance chain, both of its entry
 *    points) and the caller is declaring *I hold the row; there is no board here*.
 *    When the slice is absent the move still happens, through `taskMove`'s slice-free
 *    arm, because the row came out of the database and the slice is by construction
 *    unmounted in the window that settles. That is D19, and it is the reason
 *    `workflow_runs` held zero rows while 456 Sessions ran.
 *
 * It is ONE parameter with two shapes rather than a destination plus a `trusted:
 * boolean`, because two arguments can disagree: a `true` beside a slug the caller has
 * no row for would be exactly the invented-Skill launch this module refuses. A row
 * either is held or it is not.
 *
 * When a slice IS loaded, the slice's row wins even for a supplied destination — the
 * existing behaviour, byte for byte, and the right ordering: a mounted board is a
 * fresher read of `on_enter_skill` than an advice computed before the turn ran, and a
 * person watching that board should see the column they just edited take effect.
 */
export async function launchTaskSession(
  spacePath: string,
  task: TaskRow,
  toStageSlug: string | TaskLaunchDestination,
  catalogs: TaskLaunchCatalogs,
): Promise<TaskLaunchOutcome> {
  // A supplied destination IS the trust claim (see the header), so `trusted` and
  // `sliceFree` are derived from the argument's shape and cannot contradict it.
  const supplied = typeof toStageSlug === "string" ? null : toStageSlug;
  // Narrowed from `toStageSlug` directly rather than from `supplied`, which TS cannot
  // correlate back to the argument's shape.
  const wantedSlug = typeof toStageSlug === "string" ? toStageSlug : toStageSlug.slug;
  const stage = useTasks.getState().boardsBySpace[spacePath]?.find(
    (c) => c.stage.slug === wantedSlug,
  )?.stage;
  // Three readings, in this order, and each is the honest one for its case:
  //  - the SLICE's row: what the board on screen renders, and what a click meant;
  //  - else the SUPPLIED row: the `StageDto` Rust read from the database, which is the
  //    whole reason this launch can happen with nothing mounted;
  //  - else a Skill-less destination labelled with the slug. That is not a shrug, it is
  //    the only honest reading: the label fallback is the same one the detail modal's
  //    stage line uses ("we could not name it" is a different claim from "it has no
  //    column"), and `onEnterSkill: null` means we never invent a Skill for a row we
  //    cannot read. `resolveStage` then answers `absent` for the same slice, so the
  //    caller sees the skipped-column note rather than a Session launched on an invented
  //    Skill. `promptPrefix` follows the same rule for the same reason: no row, no text
  //    — the field is the COLUMN's prose, and a message cannot be framed by a cell
  //    neither the slice nor the caller supplied.
  //
  // This is the read that makes the Stage editor's "extra prompt" field mean
  // something: it is the same `boardsBySpace` slice the board renders, so the text a
  // person typed into a column's row reaches the Session that column starts, with no
  // second owner and no fetch. What it deliberately does NOT do here is decide
  // anything about auto-advance — the advice decided it, and this module's job ends at
  // "the prefix reaches the message".
  const destination: TaskLaunchDestination =
    (stage
      ? {
          slug: wantedSlug,
          label: stage.label,
          onEnterSkill: stage.onEnterSkill,
          promptPrefix: stage.promptPrefix,
        }
      : supplied) ?? {
      slug: wantedSlug,
      label: wantedSlug,
      onEnterSkill: null,
      promptPrefix: null,
    };
  const refusal = missingSkill(destination, catalogs);
  if (refusal !== null) throw refusal;
  // Guarded on the CARD id and not per-destination: launching two buttons against one
  // card at once is the same double-Session outcome the guard exists for.
  if (inFlight.has(task.id)) return NOTHING;
  inFlight.add(task.id);
  // ONE-SHOT, and the one-shot is the point. The guard is released at the dispatch (the
  // callback below) and this `finally` is the safety net for every arm that returns before
  // it. Without the flag, the net would delete the key a SECOND launch had legitimately
  // taken in the meantime — which is exactly what happens on a chain: the parent releases
  // at the dispatch, the chain's launch of the same card takes the key, and the parent's
  // `finally` then fires once the badge refetch lands and clears a guard it no longer owns.
  // Deleting a key you do not hold is how a guard becomes a hole.
  let guardHeld = true;
  const releaseGuard = (): void => {
    if (!guardHeld) return;
    guardHeld = false;
    inFlight.delete(task.id);
  };
  try {
    const { slug, absent, sliceFree } = resolveStage(
      spacePath,
      task,
      destination,
      supplied !== null,
    );
    let note: string | null = null;
    if (slug !== null) {
      // THE MOVE IS CHECKED, not assumed. `useTasks.moveTask` never rejects — a refusal
      // reverts the optimistic paint, lands the sentence in `error` and RESOLVES, because
      // that is what a drop handler needs. It now also ANSWERS with the column the card is
      // in, and that is the half this call site needs: a backend refusal (`StrictMoveRefused`
      // under `board_strict`, or a destination that vanished from the slice) used to fall
      // straight through to a Session whose `<task stage="…">` block named the column the
      // card had just been told it could not enter — and the `error` line that would have
      // surfaced it renders only if a board or a canvas happens to be mounted, which an
      // unattended auto-advance chain is precisely not. Throwing is the honest arm:
      // `workflowChain.finishLink` maps a throw to `launch_refused`, so the chain closes
      // with a sentence instead of launching a lie. For a human click the cost is an error
      // line on a click that would otherwise have started a Session on a stale stage.
      //
      // `sliceFree` selects the OTHER arm of the same verb (D19): no slice exists, so the
      // write goes ahead with no optimistic paint and no revert, and the answer is
      // `toStageSlug` or `null`. The check below still applies unchanged — a `null` out of
      // that arm is a REFUSED write, and launching on it would be the same lie.
      const landed = await useTasks
        .getState()
        .moveTask(spacePath, task.id, slug, sliceFree ? NO_BOARD : BOARD_REQUIRED);
      if (landed !== slug) {
        throw new Error(
          `This Space would not move the card into \`${slug}\` — it is in ` +
            `\`${landed ?? "(a column this window cannot read)"}\`.`,
        );
      }
    } else if (absent) {
      note = missingColumnNote(task, destination.slug);
    }
    // The block must carry the stage the card is ACTUALLY in at the moment the
    // Session starts, not the one the modal read when it painted. After a launch into
    // a new column those differ, and a `<task stage="backlog">` on a card the user can
    // see sitting in Research is a small lie on the wire. That is now guaranteed rather
    // than hoped: the arm above refuses to start anything unless the card really landed.
    const launched = await startAndSendLinked(
      spacePath,
      slug !== null ? { ...task, stageSlug: slug } : task,
      destination,
      catalogs,
      // THE GUARD IS RELEASED AT THE DISPATCH AND NOT AT THE RETURN, and the choice is
      // the chain's. The guard's stated job is stopping a double click from starting TWO
      // Sessions, and start + dispatch is the whole of that job — the badge refetch
      // `startAndSendLinked` still awaits afterwards is cosmetic and has nothing a second
      // click could corrupt. Holding it across that refetch instead (the old `finally`)
      // meant a turn that settled first found the chain's OWN PARENT still holding the
      // card's key, so the chain's next launch was refused by the launch that spawned it
      // and the run closed `launch_refused` with "it was already being launched" — a false
      // statement about a benign ordering, indistinguishable from a real double-click
      // refusal. The alternative fix was to move `refreshTaskNumbers()` out of the guarded
      // block; that was rejected because it would move the ordering rule (`sendLaunchMessage`
      // is dispatched BEFORE the badge fetch is awaited, which its own test pins) into two
      // call sites, and the ordering is the part that must not drift.
      () => releaseGuard(),
    );
    return { sessionId: launched.sessionId, note };
  } finally {
    // Idempotent, and it still has a job: every arm that returns before the dispatch
    // (a refused move, a rejected `startTaskSession`) leaves here without having run the
    // callback above, and a guard that survived a failure would make the card permanently
    // un-launchable.
    releaseGuard();
  }
}

/** The SECOND entry point into the chain: the **claim** path.
 *
 * ## What it is
 *
 * The model's own `mark_done` call answers with a launch instruction, and that answer
 * arrives in this window as a `tool_call_update` frame whose `rawOutput.details` carries
 * `advanceAdvice`. This function is what the app's session-update batcher hands those
 * frames to. It reads the advice, and if it says "advance", it launches — through
 * [`launchTaskSession`], the one owner of move-then-start-then-send, which is what makes
 * the chain's move the human's drag rather than a third meaning of "a move"
 * (ADR 0119 §6).
 *
 * ## Why this is a separate entry point and not part of the settle
 *
 * Because the claim is the moment the decision was made, and the settle edge is a
 * fallback for the case where nobody consumed it (D14's accepted cost). Both ask the
 * same Rust decider and both hand the same destination to the same executor, so they
 * cannot disagree; and Rust's dedupe (`alreadyLaunched`) is what stops the pair from
 * launching the same link twice — the settle that follows a consumed claim gets
 * `already_advanced`, which is a silent no-op for exactly that reason.
 *
 * ## THE SEAM, and why it is `App.tsx`'s batcher callback
 *
 * Two earlier drafts put this in `sessions.ts`, and both were wrong for the same class
 * of reason: the reducer has TWO store call sites, the singular `applySessionUpdate` and
 * the plural `applySessionUpdates`, and **the plural is the live path** — `App.tsx` builds
 * `createBatchedSessionUpdate((items) => useSessions.getState().applySessionUpdates(items),
 * requestAnimationFrame)` and feeds EVERY `session-update` into it. The singular action's
 * only production caller is `addSystemLine`. A seam in the singular action would never
 * see a live `tool_call_update`: the headline clause would have no channel while every
 * mocked test stayed green — the exact "looks configured, does nothing" failure this
 * feature exists to remove. `App.tsx`'s callback is outside every `set` updater, so the
 * StrictMode double-invoke objection that closed the in-updater option does not bind it,
 * and it is already fire-and-forget.
 *
 * ## `void`ed, never awaited — the same deadlock, one level deeper
 *
 * `sendPrompt` resolves on `agent_settled`; the merged `research` Skill ends its turn on
 * an `ask` gate; `AskQuestionCard` renders only under `ChatStream`; and `App`'s view
 * ternary renders the board INSTEAD of `ChatStream`. This function is called from inside
 * the turn that is still running, so awaiting a launch here would hold the turn on a gate
 * that has no renderer. The `.catch` is therefore load-bearing and not decoration:
 * nothing upstream awaits, so a rejection would be reported nowhere.
 *
 * ## Why the catalogs are fetched here
 *
 * `launchTaskSession` expands `$skill` Mentions against `catalogs.skills`, and
 * `useSkillCatalog` is a HOOK whose promise cache is module-private — there is no
 * non-hook accessor, and this path runs with no component mounted at all. So the two
 * catalog calls are made directly. They are two IPC round trips on a path that already
 * costs two (`mark_done` itself, and the launch), on a frame that arrives at most once
 * per turn, for a launch that cannot be built without them. A wrong `skills` list is not
 * a degraded launch either: `missingSkill` REFUSES it, which is the correct outcome for a
 * catalog this path cannot read.
 *
 * Returns whether it dispatched. `false` covers every silent arm at once — not an advice
 * frame, an advice that does not advance, an advice already launched by its own claim, a
 * card that is gone — and the caller does not care which, because all four mean "nothing
 * for you to do".
 *
 * `sessionId` is the Session the FRAME arrived on, which the batch item already carries.
 * It is not derived from the advice: the advice names the card it decided for, and the
 * transcript a refusal belongs in is the one the person is watching — the claimant's.
 *
 * ## SYNCHRONOUS, and it is not a style choice
 *
 * This is called for EVERY item of EVERY frame — ~1000 times a second on a thinking
 * model. An `async` function allocates a promise per call no matter how early it
 * returns, so the guard is a plain function that bails on a string compare and only
 * reaches an `async` helper once a frame has actually carried an instruction. That
 * happens at most once per turn.
 */
export function consumeAdvanceAdvice(
  sessionId: string,
  update: AcpSessionUpdate,
): boolean {
  const advice = readAdvanceAdvice(update);
  const destination = advice === null ? null : destinationOf(advice);
  // A launch needs a card, and the claim path holds only a Session id — which is
  // precisely why the advice carries `taskId` and `spacePath` (arm 7). Either one absent
  // and there is nothing to launch against: the `"unlinked"` arm, or a card that was
  // deleted while the turn ran.
  const taskId = advice?.taskId;
  const spacePath = advice?.spacePath;
  if (destination === null || taskId == null || spacePath == null) return false;
  void carryOutClaim(sessionId, spacePath, taskId, destination);
  return true;
}

/** The claim path's async half: read the card, read the catalogs, dispatch. Split from
 *  the guard above so the hot path allocates nothing. */
async function carryOutClaim(
  sessionId: string,
  spacePath: string,
  taskId: string,
  destination: TaskLaunchDestination,
): Promise<void> {
  // The card, read fresh. `launchTaskSession` needs the `TaskRow` (its `<task>` block,
  // its number, its stored stage), and the claim path has never held one. `null` is a
  // real answer — the card is gone — and launching on a fabricated row would put a
  // `<task number>` on the wire that names a card the database does not have.
  const task = await getTask(taskId);
  if (task === null) {
    console.error(
      `An advance advice named ${taskId}, which this window cannot read — nothing launched.`,
    );
    return;
  }
  const [skills, agents] = await Promise.all([
    listSkills(spacePath),
    listAgentDefinitionsForSpace(spacePath),
  ]);
  // DISPATCHED, NOT AWAITED, for the deadlock the header records. The outcome is
  // observed (a refusal is a fact a person needs, and this frame's transcript is the one
  // surface guaranteed to be on screen) and the TURN is never waited on.
  try {
    await launchTaskSession(spacePath, task, destination, { skills, agents });
  } catch (err) {
    console.error(`The advance advice could not be carried out for ${taskId}:`, err);
    useSessions
      .getState()
      .addSystemLine(
        // The Session the CLAIM was made in — the turn this frame belongs to, and the
        // transcript the person is actually watching. Not the Session the advice
        // launched: a refusal to move is news about the turn that just asked.
        sessionId,
        `The card was not moved to \`${destination.label}\` — ` +
          `${describeIpcError(err)} (\`launch_refused\`).`,
      );
  }
}

/** Start the linked Session and send its first message, WITHOUT touching the board.
 *
 *  The half the two surfaces share; the MOVE is the half only a launch-from-a-column
 *  needs. A draft create must NOT reach it: the card was just filed in its
 *  destination column by `create_task` itself, so a move here would be a second
 *  write for one fact — and its `on_enter` would fire for a card that was never
 *  anywhere else.
 *
 *  It also has to be separate for the in-flight guard to be correct: the create path
 *  holds a `draft:` key, and re-entering `launchTaskSession` would find the CARD key
 *  free (fine) but then re-resolve a column the create already wrote (wrong). */
async function startAndSendLinked(
  spacePath: string,
  task: TaskRow,
  destination: TaskLaunchDestination,
  catalogs: TaskLaunchCatalogs,
  // Called the instant the first message has been DISPATCHED — i.e. as soon as there is
  // nothing left for a re-entrant call to duplicate. The caller's re-entrancy guard is
  // released from here and not from the caller's `finally`, for the reason its call site
  // spells out: this helper still awaits a cosmetic badge refetch afterwards, and a turn
  // can settle inside it.
  onDispatched: () => void,
): Promise<TaskLaunchOutcome> {
  // `stageSlug: null` and not `task.stageSlug`: the Rust command resolves a null to
  // the card's CURRENT stage, so "which stage was it in when linked" has ONE answer
  // — the value the server reads — instead of one here and another there.
  const info = await startTaskSession(spacePath, task.id, null);
  // `addSession` is the store's own "a Session was started" action: it upserts the
  // row AND selects it, which is what puts the row in the sidebar and makes this
  // transcript the one on screen.
  useSessions.getState().addSession(info);
  // DISPATCHED, NOT AWAITED — see `sendLaunchMessage`'s header for why awaiting it
  // deadlocks. The Session exists and the prompt is committed, so this half's job is
  // done; the turn's outcome belongs to the transcript, not to the click.
  void sendLaunchMessage(info, task, destination, catalogs, artifactKeysFor(spacePath, task.id));
  // The re-entrancy guard's job ENDS HERE: the Session exists, it is selected, and the
  // prompt is on its way, so there is nothing a second click could duplicate. Everything
  // this helper still awaits is the cosmetic badge refetch below — and a turn can settle
  // inside it, which is why the guard may not. See the call site in `launchTaskSession`.
  onDispatched();
  // The **Task badge** map is boot-fetched, so the link `startTaskSession` just wrote is
  // not in it yet (spec D10). REFETCHED, not patched from here: which of a Session's
  // links is newest is `MAX(rowid)`'s answer in Rust, and an optimistic write would give
  // that rule a second owner in the renderer — the same reason `store/tasks.ts` refuses
  // to invent a link on `linkSession`. Awaited but failure-proofed: the badge is cosmetic
  // next to a Session that has genuinely started, so a failed refetch must not turn a
  // successful launch into a rejected promise. That failure-proofing lives INSIDE
  // `refreshTaskNumbers` now (it logs and resolves, never rejects), which is why there is
  // no `try` here — and it is the same action boot calls, so the two reads share one
  // staleness rule rather than racing to own the map.
  //
  // AFTER the dispatch above, not before it. `await`ing here first would make the
  // prompt's own dispatch wait on a cosmetic fetch: measured with a refetch held open,
  // `sendPrompt` had NOT been called while it was pending, i.e. the "not awaited"
  // above buys nothing when a slow `taskNumbers()` sits in front of it. Awaited still
  // holds (the caller's promise resolves with the badge map refreshed or explicitly
  // not), it just no longer gates the wire.
  await useSessions.getState().refreshTaskNumbers();
  return { sessionId: info.sessionId, note: null };
}

/** The card's artifact KEY NAMES, read from the board slice the store already holds.
 *
 *  D2's `<artifacts>` source (issue #180, spec §5). The keys are
 *  `TaskCardView.artifactKeys` — a field of the BOARD payload, not of `TaskRow`,
 *  because `get_task` / `create_task` / `edit_task` all answer a bare row and grew
 *  no artifact field (see `lib/tauri/types.ts`). So the launch path, which is handed
 *  a bare `TaskRow`, has to look the card up. It reads the SAME `boardsBySpace`
 *  slice `launchTaskSession` already reads for the destination Stage — one owner for
 *  "what the board says", no new fetch, and no new prop threaded through two
 *  components that would otherwise have to learn a fact only the prompt needs.
 *
 *  `[]` for a card the slice does not carry, and that is the right answer twice
 *  over: an unloaded slice is "never read" and must not become a guess, and a card
 *  `create_task` just returned has no artifacts by construction. `[]` renders NO
 *  `<artifacts>` element at all (spec §5), so an unresolved lookup says nothing
 *  rather than asserting an empty list.
 *
 *  By ID and not by position: a drag between columns repaints the slice between the
 *  click and this read, and the id survives the move that position does not. */
function artifactKeysFor(spacePath: string, taskId: string): string[] {
  const columns = useTasks.getState().boardsBySpace[spacePath];
  if (!columns) return [];
  for (const column of columns) {
    const card = column.tasks.find((c) => c.task.id === taskId);
    if (card) return card.artifactKeys;
  }
  return [];
}

/** Record the first message and dispatch it, WITHOUT holding the caller.
 *
 *  ## Why nothing above this awaits it
 *
 *  `sendPrompt` resolves when the turn SETTLES — `router.rs` resolves the session's
 *  `pending_turn` on `agent_settled`. Awaiting it here therefore held the click for
 *  the whole first turn, and for a Skill whose first turn ends on an `ask` gate that
 *  is not a latency problem, it is a DEADLOCK:
 *
 *    - the merged `research` Skill ends a turn on an `ask` gate (Path A's Phase 0
 *      asks before dispatching anything, Phase 4 is a REQUIRED hard stop, and Path B
 *      is an `ask` chain at B3/B4/B5), and `ask_flow`
 *      blocks on a oneshot with NO timeout (`harness/ask.rs`);
 *    - that gate renders through `AskQuestionCard`, which is mounted ONLY by
 *      `MessageList` under `ChatStream`;
 *    - and `App`'s view ternary renders the board INSTEAD of `ChatStream`.
 *
 *  So the turn waits on a gate that has no renderer, and the gate cannot appear
 *  until the turn ends to let the view switch. A Research click produced a Session,
 *  a sidebar row, and a board that never moved. Every `sendPrompt` mock in the suite
 *  resolves immediately, which is why the pins for "leaves the board view" passed
 *  while the feature did not.
 *
 *  The composer does not have this problem and this is the asymmetry to keep in
 *  mind: `useChatPromptDispatch.sendText` awaits `sendPrompt` too, but by then the
 *  transcript it needs is already on screen.
 *
 *  ## Where a failure goes instead
 *
 *  It cannot propagate: the dialog that used to render it through
 *  `describeIpcError` is closed by the time this settles, so a rejection would be
 *  reported NOWHERE — the user would see their own message sitting in a fresh
 *  transcript with no reply and no sentence saying why. So the failure appends a
 *  line to the Session it failed in, through `addSystemLine`, which is how the
 *  composer already reports a command it could not run. It renders as an agent-text
 *  bubble (that is what `addSystemLine` emits) — the same known imprecision the
 *  `/compact` notice has, chosen over a new message kind, a new store field, and a
 *  banner that would need mounting outside the view ternary to be visible at all.
 *
 *  `addUserMessage` → `beginTurn` → `sendPrompt` with the SAME string, then
 *  `turnCompleted` — which is what `sendText` does, and for the same reason (ADR
 *  0031's dedupe key is content-based, so a bubble and a wire text that diverge
 *  re-import the turn on the next resume).
 */
async function sendLaunchMessage(
  info: SessionInfo,
  task: TaskRow,
  destination: TaskLaunchDestination,
  catalogs: TaskLaunchCatalogs,
  artifactKeys: readonly string[] = [],
): Promise<void> {
  const inline = shouldInlineSkill(destination, catalogs);
  const text = buildLaunchMessage(task, destination, (head) =>
    inline
      ? expandMentions(head, {
          skills: catalogs.skills,
          agents: catalogs.agents,
          mcpServers: [],
        })
      : head,
    artifactKeys,
  );
  const sessions = useSessions.getState();
  sessions.addUserMessage(info.sessionId, text);
  sessions.beginTurn(info.sessionId);
  // The money figure as it stands BEFORE this turn runs. Read here and not at settle,
  // because `workflowRunStep` ADDS what it is handed and the session figure is a running
  // TOTAL: the delta needs both ends of the turn, and this is the only place standing at
  // the front of one. `null` is a real answer ("no figure yet") and is kept as `null` —
  // see `lib/sessionCost.ts` and ADR 0082.
  const costBeforeTurn = sessionCostFigure(info.sessionId);
  try {
    const reason = await sendPrompt(info.sessionId, text);
    useSessions.getState().turnCompleted(info.sessionId, reason);
    // ── THE AUTO-ADVANCE CHAIN'S SETTLE EDGE.
    //
    // This is the exact moment the feature needs: the turn has settled, the reason is in
    // hand, and the arguments already name the Space, the card and the COLUMN that was
    // launched (`destination.slug`) — so the runtime never has to guess which column's
    // `auto` flag it is answering for, and never has to read the card's stage back out of
    // a board slice that is only populated while the board is mounted.
    //
    // `void`, and the reason is the same DEADLOCK that made the call above a `void` — see
    // the header. Awaiting the chain would hold this settle on the chain's own next turn,
    // which is the `ask`-gate deadlock one level deeper. `advanceWorkflowChainOnSettle`
    // dispatches that next launch the same way and for the same reason; the whole point of
    // its header is that neither half waits.
    //
    // It cannot reject into anything: nothing upstream awaits this, so a rejection would
    // be reported NOWHERE — the silent-green shape the `catch` below exists to prevent,
    // arriving through the chain instead of the send. The runtime reports the stops IT
    // can name (see its header) and deliberately does NOT catch a failed step verb: it
    // cannot know whether the step landed, so it will not invent a `stop_reason` for a
    // write it did not read. This belt is therefore the ONE owner of that case, and it
    // reports it the way this file reports everything else it cannot rethrow — a line in
    // the Session it failed in — and moves nothing, because a verdict this side could not
    // read is a verdict it must not guess.
    void advanceWorkflowChainOnSettle({
      spacePath: task.spacePath,
      task,
      sessionId: info.sessionId,
      reason,
      launchedSlug: destination.slug,
      costBeforeTurnUsd: costBeforeTurn,
      // The FULL verb, so the chain's move is the human's drag: `launchTaskSession`
      // moves through `useTasks.moveTask` (optimistic paint, whole-slice re-derivation,
      // revert-into-`error`) before it starts anything.
      //
      // And the WHOLE destination, not `next.slug` — which is the other half of D19. The
      // old wiring dropped `label`, `onEnterSkill` and `promptPrefix` on the floor and
      // forced `launchTaskSession` to re-read them from a slice that is not mounted in
      // this window, so it resolved a Skill-less destination, skipped the move and set a
      // note nobody renders. Passing the row the advice carried is what lets the Skill
      // actually reach the message with no board anywhere.
      launch: (next) => launchTaskSession(task.spacePath, task, next, catalogs),
    }).catch((err: unknown) => {
      console.error(`Auto-advance chain failed for task ${task.id}:`, err);
      useSessions
        .getState()
        .addSystemLine(
          info.sessionId,
          "The auto-advance chain could not be checked, so the card was left where it " +
            `is — ${describeIpcError(err)}`,
        );
    });
  } catch (err) {
    // Settle FIRST: `turnCompleted` is the only thing that clears `inTurn`, and a
    // turn that never settles locks this composer for the life of the Session. The
    // message stays recorded — it was recorded at COMMIT, not at settle, so a failed
    // send must not resurrect it into the composer.
    useSessions.getState().turnCompleted(info.sessionId, "end_turn");
    // Reported INSTEAD of rethrown (see the header): nothing upstream can show it.
    useSessions
      .getState()
      .addSystemLine(
        info.sessionId,
        `That message was never sent — ${describeIpcError(err)}`,
      );
  }
}

/** Normalise the two form fields into the two COLUMNS.
 *
 *  There used to be a SPLIT here instead: one textarea, "line 0 is the title, the
 *  rest is the body". That invented a heading out of whatever the first line of a
 *  paste happened to be, and it made the body unaddressable — you could not write a
 *  short title with a multi-line body without typing a newline you did not mean. The
 *  form now has two fields, so this decides nothing about where a title ends. It only
 *  trims, and maps an all-whitespace body to `null`, because `tasks.body` is nullable
 *  and a body of three spaces renders as an empty paragraph in the detail dialog —
 *  which reads as a broken card rather than a body-less one.
 *
 *  A blank title is refused here rather than sent. `clean_title` runs server-side and
 *  would reject it anyway with `kind: "empty_title"`, but the caller has a dialog
 *  open and the sentence is identical either way.
 *
 *  What this must NOT do is fall back to the body when the title is empty. Guessing a
 *  heading out of prose is the exact behaviour the two fields exist to remove, and a
 *  card filed under a sentence lifted from its own body is a lie the board repeats
 *  forever. The title field is the only source of the title.
 */
function fieldsToColumns(
  title: string,
  body: string | null,
): { title: string; body: string | null } {
  const trimmedTitle = title.trim();
  const trimmedBody = body?.trim();
  return { title: trimmedTitle, body: trimmedBody ? trimmedBody : null };
}

/**
 * The New Task modal's one action: turn a draft into a card, then (for a destination
 * that launches) open it as a Session.
 *
 * NO LLM RUNS FOR A SAVE-ONLY DESTINATION, and that is the point of the change — a
 * card is created from text alone, in one write, and nothing is started. Which
 * button means that is the modal's decision, carried by
 * [`SAVE_ONLY`]'s `launches: false`; everything else a button means is a column.
 */
export async function createTaskFromDraft(
  spacePath: string,
  titleField: string,
  bodyField: string | null,
  destination: TaskLaunchDestination,
  catalogs: TaskLaunchCatalogs,
): Promise<TaskCreateOutcome> {
  const { title, body } = fieldsToColumns(titleField, bodyField);
  if (title === "") {
    // Refused HERE rather than paid for with an IPC round trip: the server's
    // `empty_title` rejection says the same thing, but the caller has a dialog open
    // and the sentence is identical either way.
    throw new Error("Give the Task a title — the Title field names the card.");
  }
  const guardKey = `draft:${spacePath}:${title}`;
  if (inFlight.has(guardKey)) {
    throw new Error("That Task is already being created.");
  }
  inFlight.add(guardKey);
  try {
    const refusal = missingSkill(destination, catalogs);
    if (refusal !== null) throw refusal;

    const wanted = destination.slug;
    const columns = useTasks.getState().boardsBySpace[spacePath];
    const hasWanted = columns?.some((c) => c.stage.slug === wanted) ?? false;
    // The create writes the column DIRECTLY: a create-then-move would be two writes
    // for one fact, and the move's `on_enter` would fire for a card that was never
    // anywhere else. A missing wanted column falls back to the board's FIRST column
    // (what the modal did before), because an invisible card is worse than a card in
    // an unexpected column — and `create_task` would REFUSE the unknown slug anyway.
    const stageSlug = hasWanted ? wanted : (columns?.[0]?.stage.slug ?? null);

    const task = await useTasks.getState().createTask(spacePath, title, body, stageSlug);
    if (destination.launches === false) return { task, ...NOTHING };
    // The note is computed from the row the SERVER returned (its `number` and stored
    // stage are what the sentence names), and the launch skips the move — the create
    // already filed the card in its destination column.
    const note = !hasWanted ? missingColumnNote(task, wanted) : null;
    const launched = await startAndSendLinked(
      spacePath,
      task,
      destination,
      catalogs,
      // NO EARLY RELEASE here, and that is a difference and not an oversight: this path's
      // guard is keyed on the DRAFT TITLE and its job is to stop a second click filing a
      // SECOND card. The create is the guarded half and it is not finished until the
      // promise returns, so releasing at the dispatch would let a double click create two
      // cards. The card's own key is not held at all on this path, so the auto-advance
      // chain's launch of the card this create just wrote cannot be refused by it.
      () => {},
    );
    return { task, sessionId: launched.sessionId, note };
  } finally {
    inFlight.delete(guardKey);
  }
}
