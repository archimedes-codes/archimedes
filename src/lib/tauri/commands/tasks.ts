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
 *
 * Issue #180 D1 added TWO more wrappers — `writeArtifact` and `getArtifact` — and
 * one more wire fact:
 *   - The board carries artifact KEYS only (`TaskCardView.artifactKeys`); content
 *     comes from `getArtifact` alone. And a write against a Task that does not
 *     exist is REFUSED — `task_artifacts` has no foreign key on purpose, so nothing
 *     below this call would catch a dangling id.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  Artifact,
  ArtifactMeta,
  MoveTaskOutcome,
  SessionInfo,
  StageRow,
  StageWithTasks,
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
): Promise<StageRow> {
  return invoke<StageRow>("create_stage", {
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
): Promise<StageRow> {
  return invoke<StageRow>("rename_stage", { spacePath, slug, label });
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
): Promise<StageRow> {
  return invoke<StageRow>("set_stage_skill", { spacePath, slug, skill });
}

/**
 * Set one column's outgoing transitions (ADR 0099) — the destinations a Task in
 * this column may go to, in button-render order.
 *
 * Two distinctions the renderer has to keep:
 *   - `[]` means "configured, and nothing may follow this column". A `null`
 *     `nextSlugs` on the way back means UNCONFIGURED, which is unconstrained, and
 *     the fallback is the column at `sort_order + 1`. The two are not the same
 *     answer and neither is the absence of the other.
 *   - An unknown slug or the column's own slug (a self-loop) REJECTS with
 *     `kind: "not_found"` naming the valid slugs. Nothing is silently dropped — a
 *     dropped destination is a workflow that shrank.
 *
 * `sortOrder` is a separate question and a separate verb (`reorderStages`): ADR
 * 0099 splits "where does this render" from "what may a Task go to next", and
 * neither is derived from the other.
 */
export async function setStageNext(
  spacePath: string,
  slug: string,
  slugs: string[],
): Promise<StageRow> {
  return invoke<StageRow>("set_stage_next", { spacePath, slug, slugs });
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
