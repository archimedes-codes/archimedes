/**
 * The **Task launch prompt** — the one place a Task's context is turned into the
 * first USER message of a Session, shared by every surface that opens a Session
 * *for* a card (the card's primary-next-step pill, one button per outgoing edge on
 * the Task detail modal, and the New Task modal's destination buttons).
 *
 * WHY THIS MOVED OUT OF `NewTaskDialog.tsx`. That file owned `escapeAttr` and
 * `taskBlock` privately, and it owned them correctly (the reasoning below is
 * largely its own, carried over verbatim). Task interaction adds a SECOND family
 * of launch surfaces — a card's launch buttons start a Session against an
 * ALREADY-EXISTING card — and a second copy of a prompt-injection boundary is
 * exactly the drift this repo keeps documenting: the escape rules would be spelled
 * twice and only one of them would get fixed. So the block builder lives here, in
 * `lib/` (pure, no store — `layerBoundary.test.ts` forbids the upward edge), and
 * every surface imports it.
 *
 * ## The destination Stage is the input, not a mode (issue #179, ADR 0098)
 *
 * This module used to own a mode table — `TASK_LAUNCH_MODES` plus
 * `skillOfMode` / `stageOfMode` / `instructionOfMode` — that decided which Skill a
 * launch loaded and which column it filed into. That table was a SECOND authority
 * beside the `stages` rows, and it was already losing: `stageOfMode("research")`
 * returned the literal `"research"` for a column a Space is free to rename, and
 * `store/taskLaunch.ts` printed "This Space has no `research` column" as the sound
 * of that disagreement. ADR 0098 made the **Stage** row the sole authority, so the
 * table is DELETED rather than kept as a fallback, and what arrives here instead is
 * one [`TaskLaunchDestination`] the caller resolved from the board it is rendering.
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
 * The destination's `$skill` token FIRST, `<task>` block LAST:
 *  - the token sits where the instruction sits, so `expandMentions` — which APPENDS
 *    its block at the END of the text it is given — puts any expanded block ahead of
 *    the task block rather than after it;
 *  - the task block is appended AFTER expansion, never before. A Task title is free
 *    text and a title containing `$some-skill` would otherwise be expanded into a
 *    skill block by a card a harness tool created. `NewTaskDialog.test.tsx` pins the
 *    `$discuss`-before-`<task ` ordering for the create surface and this module is
 *    what makes it true for every surface.
 *
 * Note what is NOT pinned any more: `3ebab9e2` deleted the older assertion that
 * compared `indexOf("<skill")` to `indexOf("<task ")`, because that shape described
 * an INLINED skill and inlining is what was removed — it put 18 KB of SKILL.md into
 * the user's own bubble. A model-visible Skill ships the bare token (spec §6.2), so
 * the live pin is about the token. Do not re-create the deleted assertion.
 */
import type { TaskRow } from "./tauri";

/**
 * The **destination Stage** a launch is aimed at — the whole of what a launch needs
 * to know about a column, and every field of it is DATA read from a `StageRow`.
 *
 * This shape is the replacement for the deleted mode union: where a mode was a
 * TypeScript literal that a `switch` translated into a skill name and a column, a
 * destination IS the row. The caller (`store/taskLaunch`, from the same
 * `boardsBySpace` slice the board renders) resolves it, so a Space that renames or
 * reorders its columns changes the prompt, the gate and the move together, with no
 * code to edit.
 *
 * `slug` and `onEnterSkill` are the two wire fields (`stages.slug`,
 * `stages.on_enter_skill`); `label` is `stages.label`, which is what the instruction
 * sentence is built from (spec §6.1 accepts the rough edge that a Stage labelled
 * `WIP` produces "Let's work on WIP." — data over prose, and a per-Stage prompt
 * field is the additive later fix).
 */
export interface TaskLaunchDestination {
  /** The Stage's slug — the column the card is written into by the move. */
  slug: string;
  /** The Stage's display label — the instruction sentence "Let's work on <label>." */
  label: string;
  /** The Stage's `on_enter_skill`, or `null` for a Stage that loads no Skill. */
  onEnterSkill: string | null;
  /** Does arriving here start a Session? `true` (absent = `true`) for every Stage a
   *  board can lead you to; `false` for exactly one thing, the New Task modal's
   *  save-only button ([`SAVE_ONLY`] in `store/taskLaunch`).
   *
   *  OPTIONAL and read by ONE consumer: `createTaskFromDraft`. This module never
   *  looks at it, because a message is only ever built for a launch — so the shape
   *  spec §6.1 describes (`{ slug, label, onEnterSkill }`) still satisfies this type
   *  everywhere, and a destination resolved from a `StageRow` has nothing to say. It
   *  lives here rather than as a second argument because "which column" and "does it
   *  launch" are two facts about the SAME button, and a `launches: boolean` parameter
   *  beside a destination parameter is two arguments that can disagree. */
  launches?: boolean;
}


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
 * The title is carried ONCE, in the attribute. It used to be echoed as the first
 * line of element content too, and `body` fell back to the title when the card
 * had none — so a one-line card reached the model with its sentence TWICE, both
 * copies the same text. That read as two fields agreeing, which is a worse signal
 * than an empty body: it implies there IS a body and it happens to be the title.
 * A body-less card now has an empty element body, which is the truth.
 *
 * ## The `<artifacts>` line (issue #180 D2)
 *
 * `artifactKeys` are the card's artifact KEY NAMES — `TaskCardView.artifactKeys`,
 * D1's keys-only board payload. A Session started from a card cannot otherwise
 * learn that a `research` document exists: the names are what a `get_artifact`
 * call takes, so an unlisted artifact is an artifact the model will never read
 * (spec §5). The line sits between the open tag and the body — the list frames
 * the card, it does not follow its prose.
 *
 * **Absent entirely when the card has no artifacts.** `<artifacts></artifacts>`
 * would assert "there is an artifact list and it is empty", where the truth is
 * "nobody has written one"; spec §5 names that distinction and the empty element
 * is the wrong side of it. The default `[]` keeps every existing caller and fixture
 * (a fresh draft card has no artifacts) byte-identical to the pre-D2 output.
 */
export function taskBlock(
  task: TaskRow,
  artifactKeys: readonly string[] = [],
): string {
  const open =
    `<task id="${escapeAttr(task.id)}" stage="${escapeAttr(task.stageSlug)}"` +
    ` title="${escapeAttr(task.title)}">`;
  // Keys through `escapeAttr` like every other value that enters the block. The
  // key grammar (`[a-z0-9][a-z0-9-]{0,39}`, ADR 0100) already excludes anything
  // tag-unsafe — the same split `escapeAttr`'s doc makes for Mentions — but the
  // value arrives from a `String` column through a wire type, and this module
  // escapes unconditionally rather than trusting a grammar two layers away.
  const artifacts =
    artifactKeys.length === 0
      ? ""
      : `<artifacts>${artifactKeys.map(escapeAttr).join(", ")}</artifacts>`;
  const body = task.body?.replace(/<\/task>/gi, "&lt;/task>");
  // An empty element when there is no body, rather than an element holding one
  // blank line: the blank line is whitespace the model has to explain to itself.
  // Same rule for the artifacts line: no keys, no line, no newline.
  if (body) return `${open}\n${artifacts}${artifacts ? "\n" : ""}${body}\n</task>`;
  return artifacts ? `${open}\n${artifacts}\n</task>` : `${open}\n</task>`;
}

/**
 * The pre-expansion HEAD of a launch message: the instruction line plus the
 * destination's `$skill` token, and NOTHING else. Exported so a test can read it
 * directly; production builds a message through [`buildLaunchMessage`].
 *
 * The name still says "mode" for one reason: `taskPrompt.test.ts` reads this to pin
 * that `expand` receives ONLY this string (the injection pin), and that pin is the
 * load-bearing one — renaming it is a cosmetic change to the file whose whole job is
 * a security boundary. What changed is the INPUT: a destination row, not a literal
 * from a deleted table. It stays EXPORTED for the same reason it was before — the
 * test is a reader of it, and an unexported function cannot be asserted against.
 *
 * The instruction sentence is built from the Stage's own label (spec §6.1), and a
 * destination with no skill contributes no token.
 */
export function headOfMode(destination: TaskLaunchDestination): string {
  const instruction = `Let's work on ${destination.label}.`;
  return destination.onEnterSkill === null
    ? instruction
    : `${instruction}\n\n$${destination.onEnterSkill}`;
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
  destination: TaskLaunchDestination,
  expand: (text: string) => string,
  artifactKeys: readonly string[] = [],
): string {
  const head = expand(headOfMode(destination));
  return `${head}\n\n${taskBlock(task, artifactKeys)}`;
}

