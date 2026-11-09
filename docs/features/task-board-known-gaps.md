---
status: live
last-verified: 2026-11-09
verified-by: read against this tree at the tip of the kanban-task-board run (PR-pending). `grep -rn "DELETE FROM tasks" src-tauri/src` gives 1 hit and it is inside `storage/db/tests/mod.rs` only. `grep -rln "TaskStore" ` plus the published-crate extract of `fulcrum-harness-0.1.0.crate` both give 0 files. Every item below was re-confirmed against the code at this HEAD rather than copied from the roadmap family that found it. Section 6 was added on the island-parity branch, where its two load-bearing claims were measured directly — the eight `#[tauri::command]`s in `src-tauri/src/commands/tasks.rs` were each opened and none returns a link row, and `specPath` had zero rendering sites across `src/components` and `src/store`. Kept to one line and free of interior colons so this front-matter parses as strict YAML, which several other files in this directory do not.
---

# Task board — known gaps

Accepted, unfixed defects and deliberately-unbuilt scope in the per-Space Task board (the
`tasks` / `stages` / `task_sessions` tables, their eight IPC commands, and the board surface).
They live here because the roadmap family that recorded them
(`docs/roadmap/kanban-task-board-*.md`) is deleted on ship and nothing under `docs/roadmap/`
is recoverable afterwards — no `git checkout`, no stash, no dangling blob. This is the
surviving home. Read it before concluding that a limit or a gap is handled.

The storage decision itself is ADR 0090 (no foreign key to `spaces`, lazy stage seeding) and
the frozen checklist boundary is ADR 0093. This file holds only what is still open.

## 1. Task `number`s ARE reusable, and ADR 0090 says the opposite

**The most load-bearing item here, and it is latent.** ADR 0090 states that numbers "are
never reused after a delete: reusing `#2` would silently re-point every historical mention of
`T2`", and in the same breath mandates
`COALESCE((SELECT MAX(number) FROM tasks WHERE space_path = ?1), 0) + 1`. Those two statements
cannot both hold. Measured against that expression — create four tasks, delete `#4`, create
again — the next task is `#4`. Deleting a *middle* number instead leaves a permanent gap
(`[1,3]` then yields `4`), so only the highest-position delete reuses, which is exactly the
case a "delete the card I just made" flow produces.

Honouring the invariant needs a per-Space counter table, which is a schema change no approved
constraint authorises, so the shipped SQL is the ADR's own SQL and the claim is the thing that
is wrong.

**Why this is not currently a bug** — verified, not assumed:

- There is **no delete verb for tasks**. `DELETE FROM tasks` appears once in the tree and that
  single site is inside `storage/db/tests/mod.rs`, simulating a delete to pin numbering.
- `delete_space` runs `DELETE FROM spaces WHERE path = ?1` and nothing else, and the deliberate
  absence of a foreign key (ADR 0090's whole point — closing a Space tab must not cascade a
  board away) means board rows survive it. So no reachable path deletes one task.

A1 pinned the achievable half — `create_task_numbers_are_per_space_and_1_based_and_never_reused`
covers the middle-delete gap — and the boundary is commented at the statement.

**The obligation:** if a task delete is ever added, this becomes live and must be resolved
first. Either amend ADR 0090's claim to "numbers are not renumbered, and a deleted highest
number may be reused" or add the counter table. Do not let a delete command land against the
current SQL — the failure is silent and it re-points every historical `T2` mention.

## 2. The model cannot see or move a card — the harness tools were never built

The board is **human-only by omission**, not by decision. The spec asked for model-facing task
verbs; nothing was built, and the reason is a missing feature rather than a naming problem:
`TaskStore` appears in **0 files** of the desktop and **0 files** of the published
`fulcrum-harness` artifact, and the engine's per-session checklist tool is still
`manage_todo_list`. A `move_task` tool parameter would also need validating against the Space's
`stages` rows in the executor, because `tool_specs()` returns a static `Vec` and so a stage slug
cannot be a JSON-Schema enum (ADR 0090's first Consequence).

Until that exists, "the agent works the board" means the agent writes a checklist with
`manage_todo_list` and a human drags the card. Do not describe board moves as
model-visible from this tree.

## 3. `on_enter: "fresh"` is stored and returned but nothing acts on it

`stages.on_enter` is a three-valued string (`none` / `compact` / `fresh`), deliberately a
string union and not a Rust enum so a Space can be retuned without a schema change. `compact`
is implemented — `move_task` reads the destination's value inside its own lock and reports a
`boostNote`. **`fresh` is inert**: the value round-trips to the frontend and nothing schedules a
new Session for it. A Space configured with a `fresh` column therefore behaves like `none` and
nothing says so in the UI.

## 4. Within-column position persists but is never read back into a stable order guarantee

`reorder_tasks` writes `sort_order` in one transaction, scoped so an id from another stage or
another Space is refused rather than silently relocated. Two edges are accepted:

- **`sort_order` is per-Space, not per-stage.** The verb writes positions only for the ids it
  was given and does not renumber across stages, so a card's stored position is only meaningful
  relative to its own column. That matches how `create_task` assigns it and how the board reads
  it, but it means the column is not globally dense.
- `edit_task` deliberately cannot write `sort_order` at all. That is not an oversight —
  `edit_task` stamps `updated_at` unconditionally and returns one row, so routing a reorder
  through it would move the last-edited clock on cards nobody edited and could half-succeed
  across N calls. `reorder_tasks` exists precisely to avoid that. Do not "simplify" the two
  verbs back into one.

## 5. `create_task` seeds stages too, which is wider than the spec's laziness

Spec §3 puts the five default stages in `get_board`. A1 also seeds them in `create_task`,
because a card cannot live in a Space with no columns and `start_task_session` is reachable
without the board ever being opened. Seeding runs under the caller's already-held connection
guard — taking a second lock there is the interleave ADR 0090 forbids. Per-Space laziness is
still pinned (`seeding_one_space_leaves_another_space_unseeded`). This is a deliberate widening
of the spec's letter, recorded so a future reader does not file it as a bug.

## 6. A card cannot show its Sessions, cost, state, or attachments — tracked as #174

The card anatomy (pill'd number, wrapping title, spec chip, relative time) ships on
`number` / `title` / `body` / `specPath` / `updatedAt` only. Everything a reference-style board
would put on a card is missing for one of two distinct reasons, and conflating them sends the
work to the wrong place.

**Reachable, not exposed.** `task_sessions (task_id, session_id, stage_slug)` exists, is written by
`link_session` / `write_task_session_link`, and is read INTERNALLY by `move_task`'s compaction
target picker — but **no `#[tauri::command]` returns a link row**, so the client cannot render a
session link or count. `SessionInfo.costUsd` is already persisted, so cost follows the same join.
The fix is one command on THIS repo: the tasks and task_sessions schema live in
`src-tauri/src/storage/db.rs`, and `fulcrum-harness` is a crates.io dependency owning none of it.
Aggregate server-side rather than letting the card issue a query per row, and remember
`costUsd: null` means "never reported", not `0` (ADR 0082).

**No data source at all.** "Finished" has no representation — `CloseReasonStr`
(`user | agent-exited | error` — a *close reason*, not a terminal state) is the closest thing and
is not it. "Has a question" is live transcript frames (`InlineGateRow` → `AskQuestionCard`), never
persisted per Session. Attachments exist only as composer-to-model payloads with no table and no
link to a Task. Each needs persistence designed first; a command cannot rescue them.

`specPath` was the same story until now: stored, crossing IPC on `edit_task`, and rendered nowhere.
It is the one field with a chip today, and `TaskCard.test.tsx`'s present/absent case is its only
guard.
