/**
 * The per-Space TASK BOARD: the columns (`stages`), the cards (`tasks`), and
 * which Session a card owns (`task_sessions`). Spec §2, ADR 0090.
 *
 * `startTaskSession` DOES create a Session from a card, and it does so through
 * the SAME Rust start path plain `startSession` uses — see its doc below for why
 * it takes no task-context argument at all.
 *
 * Three wire facts worth knowing before you change a signature:
 *   - `get_board` WRITES. The six default stages seed lazily on the first read
 *     of a Space that has no stage rows, so "just fetch it" is also what creates
 *     a Space's columns. That is deliberate (no migration writes for every
 *     existing Space), and it means a board fetch is not free of side effects.
 *   - `moveTask` can return a `boostNote`. A card that moved into a `compact`
 *     stage is a card that MOVED; the note says the boost it configured did not
 *     fire (usually: no live Session). Treat it as a warning on the card, never
 *     as a failed drag — the write already happened.
 *   - There are TWO drag verbs, and they write different columns. `moveTask` is
 *     the cross-column drop (`stage_slug` + `on_enter`); `reorderTasks` is the
 *     within-column drop (`sort_order` only). Neither is a general patch and
 *     `editTask` is not a third: see spec §3's table.
 *
 * Issue #179 added EIGHT more wrappers — the six Stage verbs (`createStage`,
 * `renameStage`, `setStageSkill`, `setStageNext`, `reorderStages`, `deleteStage`)
 * and the Strict-workflow pair (`setBoardStrict`, `getBoardStrict`) — and two more
 * wire facts come with them:
 *   - A Stage's `slug` is FROZEN after `createStage` derives it from the label.
 *     `renameStage` changes the label only, so the editor shows the slug rather
 *     than hiding the mismatch (spec §5).
 *   - `nextSlugs: null` and `nextSlugs: []` are DIFFERENT answers (ADR 0099):
 *     unconfigured-and-unconstrained versus configured-and-leading-nowhere. And a
 *     drag is only refused when `getBoardStrict` says the Space opted in — with the
 *     flag off, every wrapper here behaves exactly as it did before #179.
 *   - `setStageNext`'s FOURTH argument, `outcomes`, is POSITIONAL to `slugs` and is
 *     the one place in this file where a `null` is a VALUE rather than a clear:
 *     `outcomes[i]` names the edge `slugs[i]`, so `["ok", null]` labels the first
 *     edge and leaves the second bare. Same length as `slugs` or the write refuses
 *     naming both counts — a shifted label is a card that advances on the wrong
 *     claim, invisible on the board. `nextOutcomes: null` is a THIRD answer beside
 *     `nextSlugs`'s two: a graph that exists and carries no labels.
 *
 * Issue #180 D1 added TWO more wrappers — `writeArtifact` and `getArtifact` — and
 * one more wire fact:
 *   - The board carries artifact KEYS only (`TaskCardView.artifactKeys`); content
 *     comes from `getArtifact` alone. And a write against a Task that does not
 *     exist is REFUSED — `task_artifacts` has no foreign key on purpose, so nothing
 *     below this call would catch a dangling id.
 *
 * The workflow-graph work adds FOUR more — the two per-Column fields (`setStageAuto`,
 * `setStagePromptPrefix`) and the two per-Space guards (`getAutoGuards`,
 * `setAutoGuards`) — and one more wire fact worth knowing before you change one:
 *   - THREE of the four can be CLEARED, and `null` is the only spelling of that.
 *     `setStageNext`'s plain `string[]` is the recorded accepted defect beside them:
 *     a value written through it can never be un-configured. `null` is also never
 *     `0` — an unconfigured guard falls back to a shipped default, a `0` guard is a
 *     bound a person chose. See the section header above the four.
 *
 * The chain's RUN RECORD adds TWO more (`workflowRunStep`,
 * `workflowRunClose`) and they are a different kind of wrapper from the nine above:
 * none of them answers a person, none has a store action, and none refuses
 * anything on the record's own account — see the section header above the two for
 * why that distinction is
 * real. The one wire fact to carry away from them is the same `null` ≠ `0` rule the
 * guards stand on, moved from a bound to the figure the bound is compared against:
 * `workflowRunStep(…, null)` says "this step reported nothing" and leaves the
 * chain's cost alone, where `0` says "this step cost nothing".
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AdvanceVerdict,
  Artifact,
  ArtifactMeta,
  AutoGuards,
  MoveTaskOutcome,
  SessionInfo,
  StageDto,
  StageWithTasks,
  TaskNumberRow,
  TaskRow,
} from "../types";


// ---------------------------------------------------------------------------
// Task board commands (spec §2 — ADR 0090)
// ---------------------------------------------------------------------------

/** The board for one Space: every stage in `sort_order`, each carrying its own cards. */
export async function getBoard(spacePath: string): Promise<StageWithTasks[]> {
  return invoke<StageWithTasks[]>("get_board", { spacePath });
}

/** Create a card. `stageSlug` omitted lands it in the Space's FIRST stage.
 *
 * The returned row carries the per-Space `number` (`T1`, `T2`, …) and the
 * `tsk_<uuid>` id: the number is what a person says out loud, the id is what you
 * pass to every other command here. A title that trims to nothing REJECTS with
 * `kind: "empty_title"` and writes no row. */
export async function createTask(
  spacePath: string,
  title: string,
  body?: string | null,
  stageSlug?: string | null,
): Promise<TaskRow> {
  return invoke<TaskRow>("create_task", { spacePath, title, body, stageSlug });
}

/** One card by its GLOBAL id. `null` when it is gone — a deleted card is an answer, not an error. */
export async function getTask(taskId: string): Promise<TaskRow | null> {
  return invoke<TaskRow | null>("get_task", { taskId });
}

/** Patch a card's text, ONE FIELD AT A TIME — three readings per field:
 *
 *   - **omit the argument** → the column keeps its stored value;
 *   - **pass `null`** → the column is cleared to NULL;
 *   - **pass a string** → the column is written with it (`""` writes an empty
 *     string, which is a WRITE and not a clear).
 *
 * `title` is the one exception: the column is `NOT NULL`, so `title: null` is
 * REFUSED (`kind: "other"`) rather than blanking the card's label — rename it, do
 * not clear it. A `title` string goes through the same cleaner `createTask`'s does,
 * so a whitespace-only one rejects with `kind: "empty_title"` and writes nothing.
 *
 * So the three are three different answers, and the first two are NOT
 * interchangeable. This is the **inverse** of the `startTaskSession` rule below
 * ("pass the explicit `null`, never `undefined`"): there the wrapper normalizes,
 * so an omitted argument and an explicit `null` mean the same thing. Here they are
 * different ON PURPOSE, and the mechanism is `JSON.stringify` — the encoder the
 * real `invoke` hands this payload to drops an `undefined` property entirely, so an
 * omitted argument arrives as an ABSENT key while `null` arrives as a key holding
 * `null`. Rust's `Option<String>` cannot tell those apart (both deserialize to
 * `None`), which is why the command reads presence off the raw body
 * (`tauri::ipc::Request`). Do not "normalize" an argument here to `null` or `?? `
 * anything: that would turn every keep-it into a clear-it and blank a card's body
 * and spec path on a rename.
 *
 * `null` clears **from this side only**. The model's `edit_task` tool reaches the
 * published two-state seam and still cannot clear a field until #183 — see ADR 0102.
 *
 * Deliberately NOT a general patch: the stage (`moveTask` runs the destination's
 * `on_enter`), the `number` (never renumbered), and the within-column position
 * are not writable through this verb.
 *
 * Position is not unpersisted — it has its OWN verb, `reorderTasks` below, which
 * is the shape `reorderSpaces`/`reorderSessions` already set: a drag writes a
 * whole slice in one call rather than patching rows one at a time. Keeping
 * `sortOrder` out of HERE is not an omission, it is what makes a reorder
 * atomic — N `editTask` calls can half-succeed and leave a column renumbered
 * against a card that never moved. */
export async function editTask(
  taskId: string,
  title?: string | null,
  body?: string | null,
  specPath?: string | null,
): Promise<TaskRow> {
  return invoke<TaskRow>("edit_task", { taskId, title, body, specPath });
}

/** Move a card to another column and run that column's `on_enter`.
 *
 * `boostNote` on the result is a WARNING, not a failure — see the module header. */
export async function moveTask(
  spacePath: string,
  taskId: string,
  toStage: string,
): Promise<MoveTaskOutcome> {
  return invoke<MoveTaskOutcome>("move_task", { spacePath, taskId, toStage });
}

/** Rewrite the order of the cards WITHIN ONE COLUMN, in one pass (spec §3).
 *
 * The other drag verb. `moveTask` is a card dropped in ANOTHER column (writes
 * `stage_slug`, runs that column's `on_enter`); this is a card dropped in the
 * SAME column, and it writes `sort_order` and nothing else — not the stage, not
 * the title, not `updated_at`.
 *
 * `taskIds` is that column's whole visible slice in its NEW order. The index in
 * the list becomes the card's stored position, so the order you pass IS the
 * order that lands: do not sort, dedupe or tidy it.
 *
 * A card that is not in `stageSlug` of `spacePath` is REFUSED (`kind: "not_found"`,
 * naming the id) rather than quietly moved — `tasks.id` is a global key, so a
 * stale slice can name a card from another column or another Space. The write is
 * one transaction, so a refusal writes NOTHING: the column keeps its old order
 * instead of landing half-renumbered. Revert your optimistic reorder on reject.
 *
 * No harness tool mirrors this, deliberately — within a column, position is not
 * evidence (ADR 0075), so the model has no reason to see it. That is an absence
 * of TOOL surface, not of persistence: a drag here survives a restart. */
export async function reorderTasks(
  spacePath: string,
  stageSlug: string,
  taskIds: string[],
): Promise<void> {
  return invoke("reorder_tasks", { spacePath, stageSlug, taskIds });
}

/** Link a Session to a card. `stageSlug` omitted records the card's CURRENT stage.
 *
 * The FIRST link wins (`INSERT OR IGNORE` in Rust): the stage it recorded is the
 * stage a later `compact` compacts FROM, so re-linking does not move that anchor. */
export async function linkSession(
  taskId: string,
  sessionId: string,
  stageSlug?: string | null,
): Promise<void> {
  return invoke("link_session", { taskId, sessionId, stageSlug });
}

/**
 * Start a real Session for a card (spec §3 — the board's New-Task flow).
 *
 * THE START IS IDENTICAL TO `startSession`. That is the entire design, and it is
 * why this wrapper takes NO task-context argument: the Rust side calls the same
 * `SessionManager::start_session`, which passes `system_prompt: None` so the
 * Worker builds the REAL main prompt. Seeding task context into the system prompt
 * would REPLACE that prompt, not extend it — the harness's `(Fresh, Some(seed))`
 * start arm never builds the main prompt at all, so a "seeded" Task Session would
 * open blind to its own `<tools>` section, its discovered skills, its `cwd` and
 * `AGENTS.md`. Task context therefore arrives as the first USER message,
 * `expandMentions`-style, composed by the New Task dialog.
 *
 * What this command adds over `startSession` is ONE `task_sessions` row joining
 * the Session to the card, and the return value is the ordinary `SessionInfo` the
 * Session started with — the same shape `startSession` returns, so drive it with
 * `sendPrompt` exactly as you would any other Session.
 *
 * The Session is ORDINARY: an ordinary sidebar row. Nothing is hidden and nothing
 * is flagged, which is what makes the conversation survive closing the dialog.
 *
 * `stageSlug` omitted records the card's CURRENT stage — the stage it was in when
 * linked, which is the stage a later drag into a `compact` column compacts FROM.
 * `null` is the Rust `Option::None`; pass the explicit `null`, never `undefined`
 * (the `compactSession` `instructions` precedent — this wrapper normalizes for
 * you, so an omitted argument and an explicit `null` mean the same thing).
 *
 * A card that no longer exists rejects with `kind: "command"` naming the id, and
 * the Session it started stays live and listed — retry the link, do not
 * re-start.
 */
export async function startTaskSession(
  cwd: string,
  taskId: string,
  stageSlug?: string | null,
): Promise<SessionInfo> {
  return invoke<SessionInfo>("start_task_session", {
    cwd,
    taskId,
    stageSlug: stageSlug ?? null,
  });
}

/** Every **Session** that has a **Task badge**, app-wide (spec D3: Settings → Detached
 *  sessions lists Spaces with no tab, so a per-Space read cannot answer them). Each row
 *  carries the frozen **Stage** the link was made in (spec D12). */
export async function taskNumbers(): Promise<TaskNumberRow[]> {
  return invoke<TaskNumberRow[]>("task_numbers");
}


// ---------------------------------------------------------------------------
// The configurable Stage (issue #179 — spec §4/§4.1/§5, ADRs 0098 + 0099)
// ---------------------------------------------------------------------------

/**
 * Add a column to one Space's board.
 *
 * The SLUG is derived from `label` in Rust (lowercase, runs of non-`[a-z0-9-]`
 * collapse to `-`) and it is FROZEN afterwards — `renameStage` writes the label
 * only, because `tasks.stage_slug` points at the slug by string with no foreign
 * key (spec §5). So show the slug in the editor; do not hide it.
 *
 * A collision within the Space REJECTS with `kind: "not_found"` naming the slugs
 * that are taken, rather than suffixing: a silent `spike-2` is a slug nobody
 * typed. `skill` is the ADR 0098 launch Skill (the `$name` a Session started from
 * this column loads); omit it or pass `null` for a column that launches nothing.
 */
export async function createStage(
  spacePath: string,
  label: string,
  skill?: string | null,
): Promise<StageDto> {
  return invoke<StageDto>("create_stage", {
    spacePath,
    label,
    skill: skill ?? null,
  });
}

/** Rename a column's LABEL. The slug does not move (spec §5 — see `createStage`). */
export async function renameStage(
  spacePath: string,
  slug: string,
  label: string,
): Promise<StageDto> {
  return invoke<StageDto>("rename_stage", { spacePath, slug, label });
}

/**
 * Set or clear the Skill a Session started from this column loads (ADR 0098).
 *
 * `null` CLEARS it (the column launches nothing). This is the write that makes
 * `lib/taskPrompt.ts`'s `TASK_LAUNCH_MODES` map redundant: ADR 0098 rules the
 * Stage row the SOLE authority for the launch Skill, so that constant is deleted
 * rather than kept as a fallback — two authorities deciding one question is the
 * split `store/taskLaunch.ts` already reports as a bug ("This Space has no
 * `research` column"). Removing it is the launch-path task's edit; until it lands,
 * nothing here reads it.
 */
export async function setStageSkill(
  spacePath: string,
  slug: string,
  skill: string | null,
): Promise<StageDto> {
  return invoke<StageDto>("set_stage_skill", { spacePath, slug, skill });
}

/**
 * Set one column's outgoing transitions (ADR 0099) — the destinations a Task in
 * this column may go to, in button-render order — and their edge LABELS.
 *
 * Three distinctions the renderer has to keep:
 *   - `[]` means "configured, and nothing may follow this column". A `null`
 *     `nextSlugs` on the way back means UNCONFIGURED, which is unconstrained, and
 *     the fallback is the column at `sort_order + 1`. The two are not the same
 *     answer and neither is the absence of the other.
 *   - An unknown slug or the column's own slug (a self-loop) REJECTS with
 *     `kind: "not_found"` naming the valid slugs. Nothing is silently dropped — a
 *     dropped destination is a workflow that shrank.
 *   - `outcomes` is POSITIONAL to `slugs`: `outcomes[i]` is the NAME of the edge
 *     `slugs[i]`, and a `null` element means that one edge carries no label (the
 *     position is the meaning, so `null` is a value here and not a clear — the same
 *     `null` ≠ absence rule `setStagePosition`'s coordinates and
 *     `workflowRunStep`'s cost each stand on). It must be the SAME LENGTH as
 *     `slugs`, including both being empty; a mismatch REJECTS with
 *     `kind: "not_found"` naming BOTH counts and writes NEITHER column, because a
 *     shifted label is a card that advances on the wrong claim and nothing on the
 *     board would show it. `nextSlugs: null` and `nextOutcomes: null` are likewise
 *     two different absences on two different columns: the first is an unconfigured
 *     graph, the second is a graph nobody labelled.
 *
 * `sortOrder` is a separate question and a separate verb (`reorderStages`): ADR
 * 0099 splits "where does this render" from "what may a Task go to next", and
 * neither is derived from the other.
 */
export async function setStageNext(
  spacePath: string,
  slug: string,
  slugs: string[],
  outcomes: (string | null)[],
): Promise<StageDto> {
  return invoke<StageDto>("set_stage_next", {
    spacePath,
    slug,
    slugs,
    outcomes,
  });
}

/**
 * Rewrite the board's column order in one pass.
 *
 * `slugs` is the board's WHOLE visible slice in its new order — pass every column
 * you show. The index becomes each column's stored `sort_order`, dense from 0, and
 * a slug that matches no row is a silent no-op (the `reorderSpaces` contract, not
 * `reorderTasks`'s refusal). Do not sort or dedupe it: the order you hand over is
 * the order that lands.
 */
export async function reorderStages(
  spacePath: string,
  slugs: string[],
): Promise<void> {
  return invoke("reorder_stages", { spacePath, slugs });
}

/**
 * Delete a column, optionally relocating its cards first.
 *
 * `relocateTo` is the answer to the editor's "where do these cards go?" step. Omit
 * it (or pass `null`) while the column holds cards and this REJECTS with
 * `kind: "not_found"` naming the count and the columns available; a column another
 * column's `nextSlugs` points at rejects too, naming the pointing columns; and the
 * LAST column of a Space cannot be deleted at all, because a board with no columns
 * cannot receive a card.
 *
 * The relocation is one bulk write and never runs a column's `on_enter` — so no
 * compaction fires for the relocated cards, and this returns nothing precisely
 * because there is no per-card outcome to report (spec §4.1).
 */
export async function deleteStage(
  spacePath: string,
  slug: string,
  relocateTo?: string | null,
): Promise<void> {
  return invoke("delete_stage", { spacePath, slug, relocateTo: relocateTo ?? null });
}

/**
 * The Strict-workflow opt-in (ADR 0099): does this Space's transition graph BIND
 * its drags, or only describe them?
 *
 * Off (the default, and the state every existing Space is in) `moveTask` accepts
 * any column, exactly as it always did — the flag exists so upgrading cannot
 * change how a board answers a drag.
 */
export async function setBoardStrict(
  spacePath: string,
  strict: boolean,
): Promise<void> {
  return invoke("set_board_strict", { spacePath, strict });
}

/**
 * Read the Strict-workflow flag back — the seed for the editor's `Strict
 * workflow` Switch, and for the board header's Strict marker.
 *
 * The value this returns is the SAME flag `moveTask` enforces: both key the
 * `spaces` row the same way and both treat a Space with no `spaces` row as
 * `false`. That agreement is the contract — a Switch showing Strict ON over a
 * board whose drags are all accepted is the failure it exists to prevent, so do
 * NOT seed this from a cached `SpaceRow` or a local default.
 */
export async function getBoardStrict(spacePath: string): Promise<boolean> {
  return invoke<boolean>("get_board_strict", { spacePath });
}


// ---------------------------------------------------------------------------
// The workflow graph (the auto-advance chain): the two per-Column fields and the
// two per-Space guards.
//
// The pair above the line is per-COLUMN and rides on the `stages` row, so both
// answer the stored `StageDto` like the six Stage verbs beside them. The pair
// below it is per-SPACE and rides on the `spaces` row, so it is the `Strict
// workflow` pair's exact twin: a `void` write and a read that seeds the editor.
//
// THREE of the four take an `Option` on the field they write, and that is the
// point. `promptPrefix` and BOTH guards are settable AND clearable, and `null` is
// the only spelling of "cleared" — which is the deliberate refusal to repeat
// `setStageNext`, whose plain `string[]` is the recorded accepted defect: a
// configured value can never be un-configured through it, because `[]` and `null`
// are unrecoverable from each other once written. A bound a person set by mistake
// has to be removable, so none of these three repeats that. `null` is also NOT
// `0`: `setAutoGuards(space, 0, null)` means "no auto-chaining, and the ceiling is
// unconfigured", and the two must not meet in a wrapper.
// ---------------------------------------------------------------------------

/**
 * Turn one column's **auto-advance** flag on or off (the workflow-graph work).
 *
 * ON means a card LAUNCHED on this column advances itself when its Session settles,
 * rather than waiting for a person to drag it. Nothing acts on it until the runtime
 * does — this is the field the editor sets and the runtime reads.
 *
 * `auto` is a plain `boolean` and not an `Option`, because the column is
 * `NOT NULL DEFAULT 0`: a two-valued flag has no third state for a `NULL` to mean,
 * so there is nothing to clear and no clear-to-null arm to get wrong (the
 * `setBoardStrict` shape, one row over — not `setStageSkill`'s).
 *
 * Answers the stored `StageDto` so the editor updates the column from this call
 * rather than from a second round trip.
 */
export async function setStageAuto(
  spacePath: string,
  slug: string,
  auto: boolean,
): Promise<StageDto> {
  return invoke<StageDto>("set_stage_auto", { spacePath, slug, auto });
}

/**
 * Set or clear one column's **extra prompt**, prepended BEFORE its Skill launch.
 *
 * `null` CLEARS it (no extra prompt), and it is the ONLY spelling of that: the
 * column carries no SQL `DEFAULT`, so `""` is a stored VALUE a person typed and
 * round-trips as `""`, while NULL stays the sole "nothing to prepend" state. The
 * launcher prepends the text verbatim and treats the two the same — but a clear
 * from this side sends `null`, never `""`, or the database holds a second state
 * nothing can distinguish from the first.
 *
 * That optional parameter is the whole reason this wrapper exists in this shape:
 * a prefix typed by mistake has to be removable, which is `setStageSkill`'s reason
 * for the same signature and the gap `setStageNext`'s plain slice left behind.
 *
 * The text is NOT trimmed, templated or interpreted here — storage keeps it raw and
 * the launch path is what prepends it.
 */
export async function setStagePromptPrefix(
  spacePath: string,
  slug: string,
  promptPrefix: string | null,
): Promise<StageDto> {
  return invoke<StageDto>("set_stage_prompt_prefix", {
    spacePath,
    slug,
    promptPrefix,
  });
}

/**
 * Set or clear one column's **position on the Workflows canvas** — the
 * hand-arranged layout, so a node a person dragged stays where they put it.
 *
 * `x`/`y` are canvas coordinates and BOTH must be supplied or NEITHER. That is the
 * signature's whole shape and it is not a convenience: a node is a BOX, so half a
 * coordinate is a lie about where a box is — a renderer handed `(120, null)` has to
 * invent the Y, which is the invented-state move this repo refuses at every
 * nullable column's missing SQL `DEFAULT`. The command refuses the two mixed
 * spellings before it touches the database; `null, null` is the honest pair and it
 * is the CLEAR — the node goes back to dagre.
 *
 * `0` is NOT `null`, and this wrapper passes both through without collapsing them
 * (the guard pair's rule, one section below): `setStagePosition(space, slug, 0, 0)`
 * means "a person pinned this node to the origin" and
 * `setStagePosition(space, slug, null, null)` means "nobody ever moved it".
 *
 * ONE call for the PAIR, following `setAutoGuards` rather than two one-coordinate
 * wrappers, and for the same stated reason: whatever this hands over is exactly
 * what lands, there is no "keep what is there" arm, so a caller that moved one node
 * still has to name both of its numbers. Two setters would make the half-positioned
 * node reachable by a drag handler that painted one coordinate — which is precisely
 * the caller that exists here.
 *
 * Answers the stored `StageDto` so the canvas updates the node from this call
 * rather than from a second round trip. A slug the Space does not have is refused
 * before the write, naming the slugs that are valid.
 */
export async function setStagePosition(
  spacePath: string,
  slug: string,
  x: number | null,
  y: number | null,
): Promise<StageDto> {
  return invoke<StageDto>("set_stage_position", { spacePath, slug, x, y });
}

/**
 * Read one Space's **auto-chain guards** — the seed for the editor's two numeric
 * fields, and the only thing that can tell "unset" from "set to the same number".
 *
 * Both fields answer what is STORED, and an unset one answers `null` rather than
 * the fallback constant: the runtime applies the fallback, the read never
 * substitutes it. A read that filled in `DEFAULT_AUTO_MAX_STEPS` would make the
 * editor show "20" over a Space whose owner never configured anything, and the
 * owner could no longer tell a bound they chose from a bound they inherited — the
 * reason the fallback lives in code and the column's `NULL` stays meaningful.
 *
 * A Space with no `spaces` row answers `{ maxSteps: null, ceilingUsd: null }`
 * rather than refusing, which is the same leniency `getBoardStrict` shows that row
 * (a Detached Space has a board and no bookkeeping row).
 */
export async function getAutoGuards(spacePath: string): Promise<AutoGuards> {
  return invoke<AutoGuards>("get_auto_guards", { spacePath });
}

/**
 * Set or clear one Space's auto-chain guards — the bound a chain of auto-advancing
 * columns may run to, and spend, before it stops.
 *
 * BOTH arguments are optional so each guard is CLEARABLE as well as settable, and
 * `null` writes NULL: "fall back to the shipped default". That is a different
 * answer from `0` — "this Space's bound is zero", i.e. no auto-chaining / no spend —
 * and the two must not be collapsed here, or the Clear button becomes an off switch
 * (ADR 0082's `NULL` ≠ `0.0`, applied to the thing the ceiling exists to bound).
 *
 * ONE call for the PAIR, and that is a wire fact rather than a style: the storage
 * statement writes both columns together and has no "keep what is there" arm, so a
 * caller that wanted to change one field still has to name the other. A caller
 * holding only one of the two would clear the other by omission, which is why the
 * editor reads the pair before it writes either.
 *
 * A Space with no `spaces` row is a SILENT no-op — the write cannot land on a row
 * that does not exist and will not fabricate one from a settings edit. The read
 * answers the only follow-up question ("what does this Space hold now?"), so a
 * caller that needs to know whether its write stuck re-reads rather than assumes.
 */
export async function setAutoGuards(
  spacePath: string,
  maxSteps: number | null,
  ceilingUsd: number | null,
): Promise<void> {
  return invoke("set_auto_guards", { spacePath, maxSteps, ceilingUsd });
}


// ---------------------------------------------------------------------------
// The auto-advance chain's RUN RECORD: step → close.
//
// The four wrappers above ask a person to configure a chain. These two let a
// chain count itself, and they are the wire half of `Db::workflow_run_step` /
// `_close`. The pair above the line is per-Space state a person edits;
// this is per-RUN state a machine writes once per auto-advance.
//
// THERE WERE THREE. `workflowRunOpen` — "the open chain for this card, or null" —
// was deleted as dead IPC, along with its command, its barrel entry and the `Db`
// verb behind it. Nothing called it: the runtime never asks "is this card
// mid-chain", because `workflowRunStep` IS the upsert — opening a chain when none
// is open is what the step verb does. It survived the consumer gate only because
// `scripts/check-commands.sh` counts the wrapper's own `invoke("workflow_run_open")`
// literal as its consumer, i.e. a command can pay for its own registration by
// exporting a function nobody calls; that is the gate's stated failure mode one
// layer above the layer it inspects, and the honest fix was the deletion rather
// than an allowlist entry.
//
// NO STORE ACTION FOR EITHER OF THESE TWO, and that is a real distinction rather
// than an omission. `setStageAuto` has one because the flag it writes IS board
// state: it is a field on a `StageDto` the board slice already holds, so the
// action paints that slice optimistically and reverts it on a refusal — the store
// is the only place the "what does this column say" answer lives. A run record is
// none of that. It belongs to no column and no card the board renders, no component
// reads it, and it changes on every auto-advance rather than when a person acts, so
// a store action would put a per-step counter in the slice that renders a board and
// make that slice a second owner of a fact the database owns. The runtime calls
// these wrappers directly. If an observability surface ever wants to SHOW a chain,
// the store action belongs to that feature and not here.
//
// NEITHER of the two refuses anything ON THE RECORD'S OWN ACCOUNT, and neither
// should be made to. Every absence in this family is a `null` or a silent no-op,
// because the caller is a settle-handler:
// bookkeeping must never fail a Session that already did its work. A
// `workflowRunClose` that closed nothing is an `undefined` like any other.
// `workflowRunStep` DOES refuse, and only at arguments rather than absences: a
// `spacePath` that is not the card's own Space, and a `taskId` that names no card.
// Those are not "nothing to do", they are inputs that cannot be honoured, and the
// storage verb says so rather than answering with a stranger Space's budget.

/**
 * Record ONE auto-advance, opening a chain if none is open (the upsert), and return
 * the VERDICT: the row after the write plus whether the chain may take another step.
 *
 * Answers an [`AdvanceVerdict`] and not a bare `WorkflowRunRow`, and the reason is
 * the one that governs this whole family: the guard's two bounds fall back to
 * SHIPPED DEFAULTS that live in Rust and are deliberately not mirrored here, so this
 * layer cannot decide "is the chain over budget" without copying a policy number it
 * would then be obliged to keep in step. The decision is made in Rust and obeyed
 * here. `advance` is the field to branch on; `stop`, `maxSteps` and `ceilingUsd` are
 * the ones that make the sentence a caller writes about a stopped chain true (see
 * the type's doc — including the `null` cost case, which is the reason `ceilingUsd`
 * is handed over rather than left implicit).
 *
 * Do not re-derive `steps`, `costUsd`, or either bound here: a second copy of the
 * increment rule or of a fallback constant on this side of the wire is one refactor
 * away from disagreeing with the first, and the disagreement is a chain that runs
 * past a bound a person set.
 *
 * `costDeltaUsd: null` means THIS step reported no figure, and the wrapper passes
 * it through as `null` rather than `0` because the two are different writes: `null`
 * leaves `cost_usd` untouched, a number does `COALESCE(cost_usd, 0.0) + x`. Folding
 * the first into the second would give every chain that never reported a cost a
 * real `0.0` — ADR 0082's phantom zero, and a ceiling that then reads the chain as
 * free. A genuine `0` from a Session that really cost nothing is likewise passed
 * through as `0` and NOT treated as absent, so neither `?? 0` nor `|| null` belongs
 * in this signature.
 *
 * Takes a `spacePath` where `workflowRunClose` does not, on two counts. The INSERT
 * arm needs a Space to mint a row, and since the verdict landed it is ALSO the key
 * the guard read looks the Space's bounds up by — so passing a Space other than the
 * card's own USED to get a verdict measured against the wrong Space's budget. It no
 * longer can: the storage verb reads the card's own `tasks.space_path` under the same
 * lock, REFUSES a `spacePath` that canonicalises to a different folder, and stores
 * the canonicalised form so the audit column and the bound agree. Pass the card's
 * real Space (the settle handler holds it); the verb checks rather than believes.
 */
export async function workflowRunStep(
  spacePath: string,
  taskId: string,
  costDeltaUsd: number | null,
): Promise<AdvanceVerdict> {
  return invoke<AdvanceVerdict>("workflow_run_step", {
    spacePath,
    taskId,
    costDeltaUsd,
  });
}

/**
 * Close one card's open chain, recording WHY it stopped.
 *
 * `stopReason` is stored VERBATIM — it is the record's only narrative field and the
 * one thing an afterwards reader has, so nothing here normalizes, lowercases or
 * defaults it.
 *
 * THE VOCABULARY IS CITED, NOT ENUMERATED. Everything the column legitimately holds
 * is a `ChainStop` spelling (`max_steps`, `cost_ceiling`, `no_next_stage`,
 * `launch_refused` — see the `ChainStop` union in `../types.ts`, which mirrors the
 * Rust `ChainStop::as_str()` that owns them), the literal `"manual"` for a person's
 * column taking the card over, the literal `"interrupted"` for a chain a process
 * restart orphaned (written by Rust's `Db::open`, never from this side), or a
 * verbatim `StopReason` (`"cancelled"`, `"max_tokens"`, …) for a turn that never
 * finished. The enumeration that used to sit here named `"steps"` and `"ceiling"`,
 * and NOTHING has ever emitted either; that drift is why the spellings are cited to
 * their owning symbol instead of retyped.
 *
 * Resolves `undefined` whether or not there was a chain to close: a card that never
 * auto-advanced and a chain already closed are both ordinary, and a settle-handler
 * must not fail a Session because the bookkeeping had nothing to do. The flip side
 * of that leniency is the caller's job — it must have OPENED the run it means to
 * close, and a repeated close never rewrites the reason the chain actually stopped
 * (the storage verb scopes its update on `finished_at IS NULL`). There is no
 * read-your-close in this family: the read that used to offer one was deleted as
 * dead IPC (see the section header), so a caller that must audit a chain reads the
 * `workflow_runs` table rather than asking a command.
 */
export async function workflowRunClose(
  taskId: string,
  stopReason: string,
): Promise<void> {
  return invoke("workflow_run_close", { taskId, stopReason });
}


// ---------------------------------------------------------------------------
// Task artifacts (issue #180 D1 — spec §1/§2, ADR 0100)
// ---------------------------------------------------------------------------

/**
 * Write (UPSERT) one Task artifact.
 *
 * Answers `{ key, updatedAt, bytes }` and NEVER the markdown — the caller has it,
 * and echoing a 256 KB document back for no information is a second frame for
 * nothing. One row per `(taskId, key)`, ever: the second write wins and `createdAt`
 * survives, because `PRIMARY KEY (task_id, key)` is what makes an overwrite an
 * upsert rather than a second card holding a second `spec`.
 *
 * Refuses, and writes NOTHING, in three cases (the wire `kind` in brackets):
 *   - a key outside `[a-z0-9][a-z0-9-]{0,39}` [`bad_artifact_key`], naming the key
 *     AND the grammar. Load-bearing, not cosmetic: a key is interpolated into the
 *     `<task>` launch block, so a key carrying `<` or `"` is an injection point on
 *     a card a harness tool created. The key is REJECTED, never cleaned — a mangled
 *     key is a different key.
 *   - a markdown over 256 KB [`artifact_too_large`], naming the limit AND the size
 *     (plus `size`/`max` envelope keys). Refused and NEVER truncated: a spec that
 *     silently ends mid-sentence reads as a complete spec.
 *   - a `taskId` that does not exist [`not_found`]. `task_artifacts.task_id`
 *     carries NO foreign key (ADR 0100, for ADR 0090's reason — a Space tab close
 *     must not take a card's documents with it), so SQLite will not catch a
 *     dangling id and this call refuses it instead.
 */
export async function writeArtifact(
  taskId: string,
  key: string,
  markdown: string,
): Promise<ArtifactMeta> {
  return invoke<ArtifactMeta>("write_artifact", { taskId, key, markdown });
}

/**
 * Read one Task artifact.
 *
 * `null` when the artifact OR the Task is absent — asking for something that is
 * not there is an answer, not an error (the `getTask` shape). Both absences answer
 * the same way, so a caller that needs to tell "no such card" from "no such key"
 * must ask about the card separately; the dialog does not care, which is why this
 * read carries no gate the write does.
 *
 * This is the ONLY call that brings artifact content over the wire. The board
 * carries [`TaskCardView.artifactKeys`] alone, so a document travels only when a
 * person opens a card and picks a key.
 */
export async function getArtifact(
  taskId: string,
  key: string,
): Promise<Artifact | null> {
  return invoke<Artifact | null>("get_artifact", { taskId, key });
}
