---
status: accepted
date: 2026-11-10
superseded-by:
---

# The **Stage** transition graph is a graph, not an order — and `move_task` enforces it only under a per-Space opt-in

A **Task board** should be able to say which **Stage** a **Task** may go to next, and drive its
buttons from that. We decided adjacency is stored as data on the **Stage** row —
`stages.next_slugs TEXT` holding a JSON array of destination slugs, in button-render order — and
that `move_task` validates against it **only when the Space opts in**
(`spaces.board_strict INTEGER NOT NULL DEFAULT 0`).

**Why a graph and not `sort_order + 1`.** The workflow this was designed against branches at the
first step: `backlog → discuss` OR `backlog → research`, and `discuss → research` points
*backwards* against render order. A position cannot express either. So the two fields are split by
question, and the split is the part worth recording: **`sort_order` answers only "where does this
column render"; `next_slugs` answers only "what may a Task go to next."** Neither is derived from
the other, and neither is allowed to contradict the other because neither is a copy of it. A
future reader who "simplifies" this by inferring adjacency from position will silently collapse
the branch.

**Why opt-in enforcement, when refusing was nearly free.** The refusal path already existed:
`store/tasks.ts::moveTask` is optimistic and reverts on rejection into `error`, which
`TasksBoard.tsx` renders as an `IpcErrorLine` with `role="alert"` — so "illegal drag snaps back
and says why" needed no new UI. The objection is behavioural, not architectural: a kanban surface
that refuses drags is a different instrument, and the flag's default (`0`) means upgrading cannot
change how an existing board responds to a drag. Always-on was rejected for exactly that;
never-enforce was rejected because a workflow nobody can violate is a menu, not a workflow.

**Why `NULL` means unconstrained and not "no edges."** Every existing `stages` row gets
`next_slugs = NULL` from the `ADD COLUMN`. If `NULL` meant "no transitions," every existing board
would lose every launch button and gain a board that refuses all drags — this repo's documented
silent-green shape, arriving from the second new column in the same migration. `NULL` is therefore
"unconfigured, unconstrained," and the renderer falls back to the Stage at `sort_order + 1`.
That default is load-bearing and hard to flip later without breaking configured Spaces.

## Considered options

- **`stage_transitions(space_path, from_slug, to_slug, sort_order)`** — a real edge table, clean
  querying, and an obvious home for per-transition data (a different skill per edge). Rejected for
  now: nothing in the design needs per-edge data, the JSON column follows the existing precedent
  of a JSON value at rest here (`sessions.todos_json`), and a 4th board table brings a second
  small command family. It is the shape to reach for the moment an edge needs to carry anything.
- **`sort_order + 1` as the only next step** — rejected above; cannot express the branch.
- **Enforce always** — rejected: changes existing behaviour on upgrade, silently.
- **Soft-enforce in the UI only** (dim illegal columns mid-drag, server accepts anything) —
  rejected because the graph would then bind nothing the model or a future tool has to respect.

## Consequences

- **`delete_stage` gains a second refusal.** It already refuses while cards sit in the Stage (a
  **Task** whose `stage_slug` names no row is invisible to `get_board`, which groups by Stage —
  the cards would survive and be unreachable). It must also refuse while another Stage's
  `next_slugs` names it. Filtering dangling slugs at read time was the alternative and is
  rejected: a silently-shrunk workflow is the failure this repo keeps documenting.
- **The bulk relocation inside `delete_stage` must NOT run `on_enter`.** It is one
  `UPDATE tasks SET stage_slug = ? WHERE space_path = ? AND stage_slug = ?`, not N `move_task`
  calls — `move_task` reads the destination's `on_enter` and fires its boost, so "move these 5
  cards out first" would attempt 5 compactions as a side effect of a bookkeeping operation.
  Reusing `move_task` here looks like good deduplication and is wrong; it needs a comment.
- **A Stage's `slug` is frozen.** `stages` is keyed `(space_path, slug)` and `tasks.stage_slug`
  references it by string with no foreign key, so `rename_stage` writes `label` only. A renamed
  Stage keeps its original slug, which is why the editor shows the slug rather than hiding it.
- **The board still has no model-facing tools** (`docs/features/task-board-known-gaps.md` §2), so
  none of this touches `fulcrum-harness`: no crate seam, no two-package move, no orphan-rule
  exposure. Desktop-only.
