---
status: accepted
date: 2026-11-11
superseded-by:
---

# A **Task artifact** is a row in its own `task_artifacts` table — not a file in the Space, and not a JSON column on `tasks`

A **Task** needs to hold long-form markdown a **Session** can write and a later **Session** can
read — a spec, a research report — and it needs to hold more than one. We decided a
**Task artifact** is a row in a new `task_artifacts(task_id, key, markdown, created_at,
updated_at)` table keyed `PRIMARY KEY (task_id, key)`, with the markdown stored IN the database,
addressed by a free-form slug.

**Why not files.** This is the same argument ADR 0090 made about a Task itself, one level down, and
it holds for the same measured reason: the natural home for a markdown document in this repo is
`docs/roadmap/`, which is gitignored, whose untracked files are unrecoverable (no `git checkout`,
no stash, no dangling blob), and which the `finish` skill **deletes on ship**. A file-backed
artifact is content that dies when the work it describes succeeds. It also makes a **Detached
task**'s artifacts unreachable (no open tab, so no **Boundary** to resolve the path against) and
gives the **Beyond-boundary policy** a say in whether the model can read its own card's spec —
which is a policy question about the model's own work product that nobody wants to answer.

**Why not the JSON column that is sitting right there.** `sessions.todos_json` is the in-repo
precedent, it has a `gate()` migration and a persistence test, and it is the wrong precedent for
the same reason `manage_todo_list` is called a trap in ADR 0092: **it is write-mostly**. The tool
pushes `todos_update` and never reads a value back, which is the only reason it works over the
Worker's write-only IPC. A **Task artifact** must be read back — that is its entire purpose — and a
JSON column cannot serve the two read patterns this design needs: listing an artifact's KEYS
without deserializing any content (the board read returns every card in the Space on every mount,
and `artifactKeys` is names only), and fetching one artifact without rewriting the others. It also
puts the blob on `TaskRow`, which `get_task` / `create_task` / `edit_task` all return — the exact
shape the `TaskCardView` wrapper exists to avoid, where a field on the row forces a single-row read
to either join or lie.

## Considered options

- **Files in the Space, `tasks` holds a key→path map** — rejected above, on the delete-on-ship
  fact and the **Detached task** reachability problem.
- **`tasks.artifacts_json TEXT`** — rejected above, on the write-mostly precedent and the
  `TaskRow`-widening hazard `TaskCardView` was created to prevent.
- **A closed key vocabulary (`spec` / `plan` / `research` / `review`)** — rejected; it fights ADR
  0090's first Consequence (a **Stage** slug is a free-form string validated in the executor,
  because `tool_specs()` returns a static `Vec` and cannot carry an enum). The key follows the
  identical rule for the identical reason.

## Consequences

- **Zero migration entries, and a schema-pin test changes its own number.** A new TABLE needs no
  `gate()` — the `CREATE TABLE IF NOT EXISTS` batch is already idempotent. But
  `the_three_task_tables_are_in_schema_and_have_no_gate_entry` asserts THREE tables by name, and it
  must become four. The companion assertion (`gate(&mut conn, ` appears exactly 9 times) does NOT
  move, because no column was added. ⚠️ ADRs 0098 and 0099 each add `stages`/`spaces` COLUMNS, so
  whichever of those lands first moves the 9; this change must not "restore" it.
- **No foreign key to `tasks`, for ADR 0090's reason.** A Task survives its Space tab closing
  because `delete_space` deletes from `spaces` alone; an artifact cascading away with a card would
  be that bug one level down. Note the asymmetry with `task_sessions`, which DOES carry an FK to
  `sessions` — because a Session is a row that can actually be deleted, while a **Task has no
  delete verb at all** (`DELETE FROM tasks` has exactly one site in the tree and it is a test).
  If a task delete is ever added, resolve ADR 0090's amendment item 1 first, and this table's
  orphans with it.
- **The key is validated in the command layer, never in the schema** — the `require_title` split
  restated: a shape rule is a wire rule and `storage/db.rs` has no business owning it. Slug grammar
  is `[a-z0-9][a-z0-9-]{0,39}`, chosen to match the Mention token grammar `[a-z0-9-]` that
  `taskPrompt.ts` already relies on for tag-safety. That is load-bearing and not cosmetic: an
  artifact's key is interpolated into the `<task>` launch block, so a key carrying `<` or `"` is an
  injection point on a card a harness tool created.
- **`markdown` is capped at the command layer, refused and not truncated.** It crosses a JSONL pipe
  (the Worker has no `Db`; the **Supervisor** is the sole SQLite writer — ADR 0025), so an uncapped
  `TEXT` is an uncapped frame. A truncation would be the confident, well-formed lie this repo keeps
  documenting: a spec that silently ends mid-sentence reads as a complete spec.
- **The seam is ADR 0092's, widened by two methods, so the protocol change happens ONCE.**
  `trait TaskStore` carries seven methods and the wire gains two variants
  (`Outbound::TaskRequest` / `Inbound::TaskResponse`) regardless of whether artifacts exist, so
  adding `get_artifact` / `write_artifact` costs two match arms and not a second protocol change.
  This is the reason artifacts and the five board verbs are one delivery and not two.
- **ADR 0099's final Consequence is superseded in fact, if not in text.** It states "The board
  still has no model-facing tools … none of this touches `fulcrum-harness`: no crate seam, no
  two-package move, no orphan-rule exposure. Desktop-only." This design is exactly that crate seam.
  Per ADR 0099's own wording that Consequence was a statement about the state at its decision time
  and it remains true *of that change*; the board's model-facing tools are this one's to add, and
  `docs/features/task-board-known-gaps.md` §2 is the file that must be updated when they land.
