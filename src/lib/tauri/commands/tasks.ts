/**
 * The per-Space TASK BOARD: the columns (`stages`), the cards (`tasks`), and
 * which Session a card owns (`task_sessions`). Spec §2, ADR 0090.
 *
 * `startTaskSession` DOES create a Session from a card, and it does so through
 * the SAME Rust start path plain `startSession` uses — see its doc below for why
 * it takes no task-context argument at all.
 *
 * Three wire facts worth knowing before you change a signature:
 *   - `get_board` WRITES. The five default stages seed lazily on the first read
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
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  MoveTaskOutcome,
  SessionInfo,
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

/** Patch a card's text. An omitted field keeps its stored value.
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
