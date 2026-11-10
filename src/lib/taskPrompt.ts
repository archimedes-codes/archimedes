/**
 * The **Task launch prompt** — the one place a Task's context is turned into the
 * first USER message of a Session, shared by every surface that opens a Session
 * *for* a card (the New Task modal's Backlog/Discuss/Research buttons and the two
 * buttons on the Task detail modal).
 *
 * WHY THIS MOVED OUT OF `NewTaskDialog.tsx`. That file owned `escapeAttr` and
 * `taskBlock` privately, and it owned them correctly (the reasoning below is
 * largely its own, carried over verbatim). Task interaction adds a SECOND family
 * of launch surfaces — a card's Discuss and Research buttons start a Session
 * against an ALREADY-EXISTING card — and a second copy of a prompt-injection
 * boundary is exactly the drift this repo keeps documenting: the escape rules
 * would be spelled twice and only one of them would get fixed. So the block
 * builder lives here, in `lib/` (pure, no store — `layerBoundary.test.ts` forbids
 * the upward edge), and both surfaces import it.
 *
 * ## The context is a USER message and never a system seed
 *
 * `StartEnv.system_prompt` exists and the desktop passes `None` for every main
 * Session, so a seed looks free. It is not: the harness's `(Fresh, Some(seed))`
 * start arm calls `prepend_system` and never `build_main_prompt`, so a "seeded"
 * Task Session opens blind to its own `<tools>` section, its discovered skills,
 * its `cwd` and `AGENTS.md`. `startTaskSession` therefore takes NO context
 * argument at all, and the task arrives as the first user message — the shape
 * `expandMentions` already uses for `<skill>` / `<agent>` / `<mcp>` blocks
 * (ADR 0013: expanded on send, BEFORE the message is recorded, so the bubble, the
 * persisted row and the wire text are ONE string).
 *
 * ## The order of the parts is the contract
 *
 * `<skill>` block FIRST, `<task>` block LAST:
 *  - the skill block comes from `expandMentions` running over the instruction
 *    text, so it sits where the instruction sits;
 *  - the task block is appended AFTER expansion, never before. A Task title is
 *    free text and a title containing `$some-skill` would otherwise be expanded
 *    into a skill block by a card a harness tool created. `NewTaskDialog.test.tsx`
 *    pins `indexOf("<skill") < indexOf("<task ")` and this module is what makes
 *    that ordering true for both surfaces.
 */
import type { TaskRow } from "./tauri";

/**
 * Escape a value going into an XML-ish ATTRIBUTE of a prompt-injected block.
 *
 * `expandMentions` gets away without this by only ever interpolating names the
 * token grammar can carry (`[a-z0-9-]`), which excludes every tag-unsafe
 * character by construction. A **Task title is free text**: `clean_title`
 * collapses whitespace, caps at 80 chars and strips one MATCHING SURROUNDING
 * quote pair, so inner quotes, `<` and `>` survive into `TaskRow.title`.
 * Unescaped, a title of `x" onload="boom` would close the attribute and add one,
 * and a first line containing `</task>` would end the block early and let the
 * rest of the line out of it. Both are reachable from a card a harness tool
 * created, so this is an injection point and not a formatting nicety.
 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The `<task>` block: open, self-contained, LAST in the message — the
 * `<skill>` shape (`lib/skills.ts`'s `buildBlock`), no nesting, no fence. The
 * title is an ATTRIBUTE and is escaped; the body is element content, where the
 * one sequence that matters is the one that could close the tag early.
 *
 * `body` falls back to the TITLE when the card has no body. That is deliberate
 * and not padding: `tasks.body` is nullable, and a card created from a one-line
 * sentence has nothing but its title — an empty element body would hand the model
 * a block whose content is one blank line. The title is already repeated as
 * element content on the line after the tag, which is what the pre-existing
 * `NewTaskDialog` shape did (it passed the first line of the draft as the body).
 */
export function taskBlock(task: TaskRow): string {
  const body = task.body ?? task.title;
  return (
    `<task id="${escapeAttr(task.id)}" stage="${escapeAttr(task.stageSlug)}"` +
    ` title="${escapeAttr(task.title)}">\n` +
    `${task.title}\n\n` +
    `${body.replace(/<\/task>/gi, "&lt;/task>")}\n` +
    `</task>`
  );
}

/** The two ways a card is opened as a Session, and the one skill each loads.
 *
 *  The skill NAMES are pinned here rather than passed in, because the token has
 *  to survive `expandMentions`: an unmatched `$name` token is left VERBATIM in
 *  the text, so a typo here would ship the literal `$discuss` to the model and
 *  look like a skill call. `store/taskLaunch.ts` refuses to launch when the
 *  catalog has no row for the name, which is what makes this constant safe. */
export const TASK_LAUNCH_MODES = ["backlog", "discuss", "research"] as const;
export type TaskLaunchMode = (typeof TASK_LAUNCH_MODES)[number];

/** The skill a mode loads, or `null` for a mode that loads none.
 *
 *  `backlog` is `null` on purpose: it never reaches this module's prompt at all —
 *  it saves a card and opens nothing. It is in the mode union because the same
 *  three buttons exist on both surfaces and the type describes the BUTTONS, not
 *  the launches. */
export function skillOfMode(mode: TaskLaunchMode): string | null {
  return mode === "discuss" || mode === "research" ? mode : null;
}

/** The column a mode wants the card to end up in, or `null` for "do not move it".
 *
 *  Both slugs are SEEDED DEFAULTS (`DEFAULT_STAGES` in `storage/db.rs`:
 *  backlog / research / approved / doing / done). A Space whose columns were
 *  renamed or reordered has no guarantee of either row, so this is a PREFERENCE
 *  and not a write — every caller must check the board for the column before
 *  asking for it, because `create_task` and `move_task` REFUSE an unknown slug
 *  rather than filing an invisible card (ADR 0090), and an invisible card is the
 *  silent-green shape this repo keeps documenting.
 *
 *  The two surfaces resolve a MISS differently, and deliberately so — that is why
 *  there is no shared `resolveStageSlug` helper here:
 *   - the New Task modal falls back to the board's FIRST column, which is what it
 *     did before this change (`boards[0]`), so a card is never lost for want of a
 *     column it was only ever *labelled* after;
 *   - the detail modal does NOT move at all and says so, because "put it in the
 *     first column" would drag a card out of `doing` into an unrelated column on
 *     a click whose whole job was to start a research Session. */
export function stageOfMode(mode: TaskLaunchMode): string | null {
  if (mode === "backlog") return "backlog";
  if (mode === "research") return "research";
  return null;
}

/** The instruction line a launched Session opens with.
 *
 *  A Session started from a card has no user prose to send — the card IS the
 *  request — so the message would otherwise be two XML blocks and nothing that
 *  says what to do with them. One sentence per mode, and it is the ONLY invented
 *  prose in this file: everything else is data. */
function instructionOfMode(mode: TaskLaunchMode): string {
  switch (mode) {
    case "discuss":
      return "Let's discuss this task.";
    case "research":
      return "Research this task.";
    case "backlog":
      // Unreachable — `backlog` opens no Session. Returns empty rather than
      // throwing so this stays a total function over the mode union.
      return "";
  }
}

/**
 * The pre-expansion HEAD of a launch message: the instruction line plus the
 * mode's `$skill` token, and NOTHING else. Exported so a test can read it
 * directly; production builds a message through [`buildLaunchMessage`].
 *
 * A mode with no skill contributes no token.
 */
export function headOfMode(mode: TaskLaunchMode): string {
  const skill = skillOfMode(mode);
  const instruction = instructionOfMode(mode);
  return skill === null ? instruction : `${instruction}\n\n$${skill}`;
}

/**
 * The WHOLE first message for launching a card as a Session.
 *
 * ## Why `expand` is a parameter and the block is appended after it
 *
 * The `<task>` block must NEVER pass through `expandMentions`, and that is a
 * security property, not tidiness. A Task title is free text — a harness tool, or
 * a person typing `$deploy` into a card body, can put a real Mention token in it —
 * and `expandMentions` expands every token it finds with no idea what it is
 * inside. Handing it the finished message would therefore let a card titled
 * `$some-skill` inject a skill block into a Session nobody asked for. This is the
 * same reason `NewTaskDialog` appends its block AFTER expansion rather than
 * composing first.
 *
 * So the order is enforced HERE and is not available to get wrong at a call site:
 * `expand` sees the head (instruction + token) and nothing else; the block is
 * concatenated after its return value. Passing the whole message to `expand` is
 * structurally impossible from this function — which is what `taskPrompt.test.ts`
 * pins with a spy that asserts its argument carries no `<task`.
 *
 * `expand` is a parameter rather than an import of `expandMentions` for the same
 * reason the block builder moved here at all: expansion needs the Space's skill /
 * agent catalogs, and this module is pure (no store, no fetch — and
 * `layerBoundary.test.ts` keeps it that way). The caller supplies the catalogs it
 * already holds.
 */
export function buildLaunchMessage(
  task: TaskRow,
  mode: TaskLaunchMode,
  expand: (text: string) => string,
): string {
  const head = expand(headOfMode(mode));
  return `${head}\n\n${taskBlock(task)}`;
}
