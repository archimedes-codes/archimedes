import { expandMentions } from "../lib/skills";
import {
  buildLaunchMessage,
  type TaskLaunchDestination,
} from "../lib/taskPrompt";
import { sendPrompt, startTaskSession, type SessionInfo } from "../lib/tauri";
import { describeIpcError } from "../lib/ipcError";
import type { AgentDefinitionDto, SkillInfo, TaskRow } from "../lib/tauri";
import { useSessions } from "./sessions";
import { useTasks } from "./tasks";

/**
 * The ONE orchestration behind "open this **Task** as a **Session**", shared by the
 * Task detail modal's Discuss / Research buttons and the New Task modal's three
 * buttons.
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
 *  for want of a column. */
function resolveStage(
  spacePath: string,
  task: TaskRow,
  destination: TaskLaunchDestination,
): { slug: string | null; absent?: true } {
  const wanted = destination.slug;
  const columns = useTasks.getState().boardsBySpace[spacePath];
  // Absent board slice is "NEVER LOADED", not "no columns" — and neither proves a
  // destination column exists, so both answer "cannot write it". Guessing is a
  // refused write and an error line under a click that succeeded.
  if (columns === undefined) return { slug: null, absent: true };
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
 *  NAME with `read_skill`, and the launch's own instruction line ("Let's discuss
 *  this task.") is a trigger phrase the target skill's description advertises, so
 *  the load is organic rather than a token the model has to decode.
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
 * `toStageSlug` is the DESTINATION column, and it replaced a mode for the reason
 * ADR 0098 gives: the destination Stage IS the mode. Its row supplies the label the
 * instruction sentence names and the Skill the message loads, read from the SAME
 * `boardsBySpace` slice the board is rendering — so the button a person clicked and
 * the prompt that goes out cannot disagree about what that column means.
 */
export async function launchTaskSession(
  spacePath: string,
  task: TaskRow,
  toStageSlug: string,
  catalogs: TaskLaunchCatalogs,
): Promise<TaskLaunchOutcome> {
  const stage = useTasks.getState().boardsBySpace[spacePath]?.find(
    (c) => c.stage.slug === toStageSlug,
  )?.stage;
  // A destination the slice does not have resolves to a Skill-less destination
  // labelled with the slug. That is not a shrug, it is the only honest reading: the
  // label fallback is the same one the detail modal's stage line uses ("we could not
  // name it" is a different claim from "it has no column"), and `onEnterSkill: null`
  // means we never invent a Skill for a row we cannot read. `resolveStage` then
  // answers `absent` for the same slice, so the caller sees the skipped-column note
  // rather than a Session launched on an invented Skill.
  const destination: TaskLaunchDestination = {
    slug: toStageSlug,
    label: stage?.label ?? toStageSlug,
    onEnterSkill: stage?.onEnterSkill ?? null,
  };
  const refusal = missingSkill(destination, catalogs);
  if (refusal !== null) throw refusal;
  // Guarded on the CARD id and not per-destination: launching two buttons against one
  // card at once is the same double-Session outcome the guard exists for.
  if (inFlight.has(task.id)) return NOTHING;
  inFlight.add(task.id);
  try {
    const { slug, absent } = resolveStage(spacePath, task, destination);
    let note: string | null = null;
    if (slug !== null) {
      await useTasks.getState().moveTask(spacePath, task.id, slug);
    } else if (absent) {
      note = missingColumnNote(task, destination.slug);
    }
    // The block must carry the stage the card is ACTUALLY in at the moment the
    // Session starts, not the one the modal read when it painted. After a launch into
    // a new column those differ, and a `<task stage="backlog">` on a card the user can
    // see sitting in Research is a small lie on the wire.
    const launched = await startAndSendLinked(
      spacePath,
      slug !== null ? { ...task, stageSlug: slug } : task,
      destination,
      catalogs,
    );
    return { sessionId: launched.sessionId, note };
  } finally {
    inFlight.delete(task.id);
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
 *  the whole first turn, and for these two skills that is not a latency problem, it
 *  is a DEADLOCK:
 *
 *    - `discuss`'s whole shape is to end a turn on an `ask` gate, and `ask_flow`
 *      blocks on a oneshot with NO timeout (`harness/ask.rs`);
 *    - that gate renders through `AskQuestionCard`, which is mounted ONLY by
 *      `MessageList` under `ChatStream`;
 *    - and `App`'s view ternary renders the board INSTEAD of `ChatStream`.
 *
 *  So the turn waits on a gate that has no renderer, and the gate cannot appear
 *  until the turn ends to let the view switch. A Discuss click produced a Session,
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
  try {
    const reason = await sendPrompt(info.sessionId, text);
    useSessions.getState().turnCompleted(info.sessionId, reason);
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
    );
    return { task, sessionId: launched.sessionId, note };
  } finally {
    inFlight.delete(guardKey);
  }
}
