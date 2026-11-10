import { expandMentions } from "../lib/skills";
import {
  skillOfMode,
  stageOfMode,
  buildLaunchMessage,
  type TaskLaunchMode,
} from "../lib/taskPrompt";
import { sendPrompt, startTaskSession, type SessionInfo } from "../lib/tauri";
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
 * write-ordering rule is exactly the drift this repo documents: the order inside
 * the sequence IS the feature, so the sequence needs one owner. The components keep
 * the part that differs — which button means which mode, and what to paint.
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
 * `research` and `backlog` are the SEEDED slugs. A Space whose columns were renamed
 * has no such row, and `move_task` / `create_task` REFUSE an unknown slug rather
 * than filing an invisible card (ADR 0090). So the board is consulted first, and:
 *  - a launch SKIPS the move and reports the skip in its return value (a click
 *    whose job was to open a Session must not fail because a column was renamed);
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

/** The column a mode wants, and whether this Space actually has it.
 *
 *  Returns the slug to write, or `null` for "do not write a column". A card whose
 *  stored stage is already the wanted one is `null` too: `moveTask`'s own guard
 *  drops a same-column move silently, so firing it would be an IPC that provably
 *  does nothing.
 *
 *  `absent` reports the case the caller must surface: the mode WANTED a column and
 *  the Space does not have one. `undefined` means "nothing wanted, nothing to say". */
function resolveStage(
  spacePath: string,
  task: TaskRow,
  mode: TaskLaunchMode,
): { slug: string | null; absent?: true } {
  const wanted = stageOfMode(mode);
  if (wanted === null) return { slug: null };
  const columns = useTasks.getState().boardsBySpace[spacePath];
  // Absent board slice is "NEVER LOADED", not "no columns" — and neither proves a
  // `research` column exists, so both answer "cannot write it". Guessing is a
  // refused write and an error line under a click that succeeded.
  if (columns === undefined) return { slug: null, absent: true };
  if (!columns.some((c) => c.stage.slug === wanted)) {
    return { slug: null, absent: true };
  }
  if (task.stageSlug === wanted) return { slug: null };
  return { slug: wanted };
}

/** The sentence for a mode whose column this Space does not have.
 *
 *  Names the slug in backticks and lowercase on purpose: it is the slug the caller
 *  asked for, and the detail modal's test resolves the word in it. */
function missingColumnNote(task: TaskRow, wanted: string): string {
  return (
    `This Space has no \`${wanted}\` column, so T${task.number} stayed in ` +
    `\`${task.stageSlug}\`.`
  );
}

/** Refuse a launch whose skill the catalog does not have.
 *
 *  Returns `null` when the mode needs no skill or the catalog has it. The thrown
 *  error names the skill, because the operator's next action is "install that
 *  skill" and a message that does not say which one is not actionable. */
function missingSkill(
  mode: TaskLaunchMode,
  catalogs: TaskLaunchCatalogs,
): Error | null {
  const skill = skillOfMode(mode);
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
 *  There is deliberately no "name outside the `$` grammar" arm. The mode's skill
 *  name is the literal `"discuss"` / `"research"` from `skillOfMode`, both of which
 *  the grammar carries, and `missingSkill` already REFUSED any launch whose catalog
 *  has no exact-named row — so an unmatchable name can never reach here. An arm for
 *  it would be unreachable code pretending to be a guard.
 */
function shouldInlineSkill(
  mode: TaskLaunchMode,
  catalogs: TaskLaunchCatalogs,
): boolean {
  const name = skillOfMode(mode);
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
 */
export async function launchTaskSession(
  spacePath: string,
  task: TaskRow,
  mode: TaskLaunchMode,
  catalogs: TaskLaunchCatalogs,
): Promise<TaskLaunchOutcome> {
  const refusal = missingSkill(mode, catalogs);
  if (refusal !== null) throw refusal;
  // Guarded on the CARD id and not per-mode: launching two buttons against one card
  // at once is the same double-Session outcome the guard exists for.
  if (inFlight.has(task.id)) return NOTHING;
  inFlight.add(task.id);
  try {
    const { slug, absent } = resolveStage(spacePath, task, mode);
    let note: string | null = null;
    if (slug !== null) {
      await useTasks.getState().moveTask(spacePath, task.id, slug);
    } else if (absent) {
      note = missingColumnNote(task, stageOfMode(mode)!);
    }
    // The block must carry the stage the card is ACTUALLY in at the moment the
    // Session starts, not the one the modal read when it painted. After a Research
    // move those differ, and a `<task stage="backlog">` on a card the user can see
    // sitting in Research is a small lie on the wire.
    const launched = await startAndSendLinked(
      spacePath,
      slug !== null ? { ...task, stageSlug: slug } : task,
      mode,
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
  mode: TaskLaunchMode,
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
  await sendLaunchMessage(info, task, mode, catalogs);
  return { sessionId: info.sessionId, note: null };
}

/** The send tail: build the ONE string, record it, send it, settle it.
 *
 *  `addUserMessage` → `beginTurn` → `sendPrompt` with the SAME string, then
 *  `turnCompleted` — which is what `useChatPromptDispatch.sendText` does, and for
 *  the same reason (ADR 0031's dedupe key is content-based, so a bubble and a wire
 *  text that diverge re-import the turn on the next resume).
 */
async function sendLaunchMessage(
  info: SessionInfo,
  task: TaskRow,
  mode: TaskLaunchMode,
  catalogs: TaskLaunchCatalogs,
): Promise<void> {
  const inline = shouldInlineSkill(mode, catalogs);
  const text = buildLaunchMessage(task, mode, (head) =>
    inline
      ? expandMentions(head, {
          skills: catalogs.skills,
          agents: catalogs.agents,
          mcpServers: [],
        })
      : head,
  );
  const sessions = useSessions.getState();
  sessions.addUserMessage(info.sessionId, text);
  sessions.beginTurn(info.sessionId);
  try {
    const reason = await sendPrompt(info.sessionId, text);
    useSessions.getState().turnCompleted(info.sessionId, reason);
  } catch (err) {
    // Settle FIRST, then rethrow: `turnCompleted` is the only thing that clears
    // `inTurn`, and a turn that never settles locks this composer for the life of
    // the Session. The message stays recorded — it was recorded at COMMIT, not at
    // settle, so a failed send must not resurrect it into the composer.
    useSessions.getState().turnCompleted(info.sessionId, "end_turn");
    throw err;
  }
}

/** Split a draft into the title the server will accept and the body that follows.
 *
 *  The FIRST LINE is the title and nothing else is re-implemented about it:
 *  `clean_title` runs server-side (whitespace collapse, one matching quote pair
 *  stripped, multi-byte-safe 80-char cap) and a title that cleans to nothing
 *  REJECTS with `kind: "empty_title"` rather than falling back to the raw string.
 *  Re-spelling that predicate locally would be the second implementation the spec
 *  forbids, so the only judgement here is "line 0 is the title, the rest is body".
 */
function splitDraft(draft: string): { title: string; body: string | null } {
  const trimmed = draft.trim();
  const newline = trimmed.indexOf("\n");
  if (newline === -1) return { title: trimmed, body: null };
  const title = trimmed.slice(0, newline).trim();
  const body = trimmed.slice(newline + 1).trim();
  return { title, body: body === "" ? null : body };
}

/**
 * The New Task modal's one action: turn a draft into a card, then (for Discuss and
 * Research) open it as a Session.
 *
 * NO LLM RUNS FOR THE `backlog` MODE, and that is the point of the change — a card
 * is created from text alone, in one write, and nothing is started.
 */
export async function createTaskFromDraft(
  spacePath: string,
  draft: string,
  mode: TaskLaunchMode,
  catalogs: TaskLaunchCatalogs,
): Promise<TaskCreateOutcome> {
  const { title, body } = splitDraft(draft);
  if (title === "") {
    // Refused HERE rather than paid for with an IPC round trip: the server's
    // `empty_title` rejection says the same thing, but the caller has a dialog open
    // and the sentence is identical either way.
    throw new Error("Give the Task a title first — the first line becomes its title.");
  }
  const guardKey = `draft:${spacePath}:${title}`;
  if (inFlight.has(guardKey)) {
    throw new Error("That Task is already being created.");
  }
  inFlight.add(guardKey);
  try {
    const refusal = missingSkill(mode, catalogs);
    if (refusal !== null) throw refusal;

    const wanted = stageOfMode(mode);
    const columns = useTasks.getState().boardsBySpace[spacePath];
    const hasWanted =
      wanted !== null && (columns?.some((c) => c.stage.slug === wanted) ?? false);
    // The create writes the column DIRECTLY: a create-then-move would be two writes
    // for one fact, and the move's `on_enter` would fire for a card that was never
    // anywhere else. A missing wanted column falls back to the board's FIRST column
    // (what the modal did before), because an invisible card is worse than a card in
    // an unexpected column — and `create_task` would REFUSE the unknown slug anyway.
    const stageSlug = hasWanted ? wanted! : (columns?.[0]?.stage.slug ?? null);

    const task = await useTasks.getState().createTask(spacePath, title, body, stageSlug);
    if (mode === "backlog") return { task, ...NOTHING };
    // The note is computed from the row the SERVER returned (its `number` and stored
    // stage are what the sentence names), and the launch skips the move — the create
    // already filed the card in its destination column.
    const note =
      wanted !== null && !hasWanted ? missingColumnNote(task, wanted) : null;
    const launched = await startAndSendLinked(spacePath, task, mode, catalogs);
    return { task, sessionId: launched.sessionId, note };
  } finally {
    inFlight.delete(guardKey);
  }
}
