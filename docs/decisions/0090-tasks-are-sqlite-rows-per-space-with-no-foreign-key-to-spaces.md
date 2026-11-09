---
status: accepted
date: 2026-11-09
superseded-by:
---

# A Task is a SQLite row per Space with no foreign key to `spaces`, and the board is never a view over `docs/roadmap/`

A **Task** needs a home, and this repo already keeps its work artifacts as files
(`docs/roadmap/<topic>.md`, `docs/reviews/`, `docs/research/`). We decided instead that a
**Task** is a row in a new `tasks` table keyed `tsk_<uuid>` with a per-Space `number`, owned
by a Space and deliberately **not** joined to `spaces` by a foreign key — because closing a
Space tab runs `delete_space` (`DELETE FROM spaces WHERE path = ?1`, ADR 0016/0043: closing
a tab *forgets*), and a board whose rows cascade-deleted on a tab close would lose a
person's whole workflow to a click that deletes nothing else.

**Why not files.** The obvious design — a **Task** *is* a `docs/roadmap/<topic>.md`, the
board a view over its front-matter `status:` — fails on three measured facts about that
directory: it is gitignored (`.gitignore`, the `docs/roadmap/` entry), its untracked files
are unrecoverable (no `git checkout`, no stash, no dangling blob), and the `finish` skill
**deletes the plan family on ship**. A file-as-authority board therefore eats its own Done
column on every successful ship. A Task is the thing that *outlives* the doc; it cites the
doc through a nullable `spec_path` rather than being one. The vocabulary fork also matters:
the skills' recorded ladder is `status: approved` / `status: committed` plus the roadmap
skill's open / done / blocked — `research` and `discuss` are **skills**, not states anything
records, so a columns-from-front-matter board would be inventing an authority, not mirroring
one.

**Why no FK, concretely.** `sessions.cwd` carries no FK to `spaces` for the identical
reason, and the consequence is the same and accepted: a **Task** whose Space has no open tab
is unreachable from the board — a **Detached task**, the sibling of the existing **Detached
session**. Re-opening the folder makes it an ordinary card again.

## Considered options

- **A `tasks` table with no link to specs** — cleanest boundary, but a Task and its spec
  become two unrelated records that can disagree about what stage the work is at.
- **A Task IS a `docs/roadmap/<topic>.md`** — rejected above, on the gitignore + delete-on-
  ship facts.
- **Per-Space task numbering as the primary key** — rejected; the key stays an opaque
  `tsk_<uuid>` mirroring `SessionId::mint()` (`ids.rs`) and `number` is a per-Space *label*
  from `COALESCE((SELECT MAX(number) …), 0) + 1`, the existing `sort_order` idiom. Numbers
  are never reused after a delete: reusing `#2` would silently re-point every historical
  mention of `T2`.

## Consequences

- **Stage names cannot be a JSON-Schema enum.** `tool_specs()` returns a static `Vec`, so a
  `move_task` stage parameter is a free-form slug validated in the executor against the
  Space's `stages` rows. A bad slug returns an error naming the valid ones, so the model
  self-corrects without a schema-discovery round trip.
- **Stages seed lazily, not by migration.** `get_board(space_path)` inserts the defaults
  (`backlog`, `research`, `approved`, `doing`, `done`) on first read of a Space with no stage
  rows, so a Space that never opens the board pays nothing.
- **`read`-then-`insert` must share one mutex lock.** The per-Space `MAX(number) + 1` is two
  statements; `Db` holds one `Connection` in a `StdMutex` so writes are already serialised,
  but the two calls must not take the lock separately.
- **Any new tool that addresses a Task by its visible number needs the Space.** `get_task(1)`
  is ambiguous across Spaces; the executor resolves it from `ToolCtx.cwd`, which is already
  the Space path. A bare integer resolves per-Space, a `tsk_` prefix resolves globally.


## Amendment (2026-11-09) — the "never reused" claim is **false** of the SQL this ADR mandates, and by-number resolution was not built

**The body above is left as written, because it records the decision as it was made. Two of its
statements do not survive contact with the implementation, and a reader must not have to discover
that by experiment.**

**1. Numbers are not "never reused after a delete".** The Considered-options section rejects
per-Space numbering as a primary key and mandates
`COALESCE((SELECT MAX(number) FROM tasks WHERE space_path = ?1), 0) + 1`, then asserts in the same
paragraph that numbers "are never reused after a delete". **That expression reuses a deleted
highest number.** Measured: create four tasks, delete `#4`, create again — the next task is `#4`.
Deleting a *middle* number leaves a permanent gap (`[1,3]` then yields `4`), so only the
highest-position delete reuses, which is exactly what a "delete the card I just made" flow does.
The invariant and the SQL are not jointly satisfiable without a per-Space counter table, which is a
schema change no approved constraint authorised. **The shipped SQL is this ADR's own SQL; the claim
is what is wrong.**

It is latent, verified rather than assumed: there is no task delete verb anywhere
(`DELETE FROM tasks` has exactly one site in the tree and it is a test simulating a delete), and
`delete_space` deletes from `spaces` alone — the deliberate absence of a foreign key, which is this
ADR's central point, means board rows survive a Space tab closing. **If a task delete is ever added,
resolve this first: either adopt the weaker true claim — numbers are never renumbered, and a deleted
highest number may be reused — or add the counter table.** A silent reuse re-points every historical
mention of `T2`, which is the harm this paragraph was written to prevent.

**2. `get_task` does not resolve a bare integer.** The final Consequence describes an executor that
takes a visible number and resolves it per-Space from `ToolCtx.cwd`, with a `tsk_` prefix resolving
globally. **None of that was built**, because the harness tools that would need it were never built
(see `docs/features/task-board-known-gaps.md` §2). What shipped is
`Db::get_task(task_id: &str) -> Result<Option<TaskRow>, BoardError>` and the TS wrapper
`getTask(taskId: string)`, both keyed by the global `tsk_<uuid>` **only** — one argument, no Space
parameter, no integer path. The design intent survives as intent: the reason `number` is a label and
`id` is the key is unchanged, and the reason a `number` cannot be trusted alone (it is meaningless
without its Space) is exactly why the shipped signature refuses to accept one. **Do not build the
integer path without first settling item 1** — resolving `T2` to a card whose number was reused is
the failure this ADR foresaw, and it is reachable the moment both a delete verb and a number-based
lookup exist.
