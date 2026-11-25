---
status: live
last-verified: 2026-11-25
verified-by: read against this tree at `99aa04cc` + `feature/session-ready-mark` — `store/interactive.ts` (`READY_MARKER_TEXT`, `isReadyMarker`, `boardAssertsReady`, the `ready` slot), `store/sessions.ts` (`beginTurn`), `components/TaskCard.tsx` (the glyph), `hooks/useTaskBoardAutoRefresh.ts`
---

# The session `ready` marker

A **convention**, not a feature with a verb behind it. A model that wants to say
"the work on this Session is finished and someone should look at it" writes a todo
item whose content is the word `ready`. The desktop reads that item and puts a mark
on every Task card the Session is linked to.

This document exists because the mark **looks** like a persisted state and is not
one, and because the reason it is a convention is a constraint a future reader will
otherwise try to "fix".

## The rule, exactly

A `ChecklistItem` marks its Session ready when **both** halves hold:

- `content.trim().toLowerCase() === "ready"` — **exact**, not a substring.
  `"get the board ready"` is a plan item *about* readiness, and a substring test
  would mark a card ready for half the English language.
- `status === "completed"`. A **pending** `"ready"` in a plan means "still need to
  make it ready" — the opposite of the claim. `in_progress` means the same.

Owners: `READY_MARKER_TEXT` and `isReadyMarker` (`src/store/interactive.ts`) are the
one definition; `boardAssertsReady` applies it to a list. Both halves are pinned by
tests in `src/store/interactive.test.ts`.

## Why a convention and not a tool

**A model-facing verb is engine-gated, and this repo cannot add one.** `TaskCall`
and `trait TaskStore` live in `fulcrum-harness`, a **crates.io-pinned** dependency
(`src-tauri/Cargo.toml`), and `tool_specs()` is the crate's — the desktop
contributes **zero** tool specs today. A new verb means an engine change, a
crates.io publish, and a pin bump here.

The obvious shortcut does not work either. The engine **constructs**
`TodoItem { content, status, description }` and emits the *constructed* vector, so
an extra key on an item (`"ready": true`) is dropped inside the crate, **before the
frame the desktop would read exists**. Only the model-authored *string* survives.
That is the whole reason the marker is a word and not a field.

The real fix is **ADR 0102** and `docs/roadmap/tool-separation.md` (**issue #183**):
`StartEnv.host_tools` plus a vocabulary-free `HostToolCall` / `HostToolResponse`
pair, so the desktop can ship a tool without publishing a crate release. It is
**approved and unbuilt**. When it lands, the marker becomes a real verb and **the
read path does not change** — the mark already rides a store slot, so #183 swaps
the *writer* only. That is why the convention was built first: the expensive half
was sequenced after the cheap half on purpose, not by omission.

## Why the mark is a slot and not a derivation

The owner's clear rule is **"the next turn on that Session clears it."** That rule
cannot be derived from the todo list. Deriving readiness as `marker && !inTurn`
makes the mark **vanish during a turn and reappear when it settles**, because a
turn that never touches the todo list leaves the marker in place. So `ready` is an
explicit `Record<string, true>` on `useInteractive`, and `beginTurn` deletes the
entry (`src/store/sessions.ts`). The cross-store write has an existing precedent:
`sessions.ts` already calls `useInteractive.applyTodoUpdate` from its history seed.

`applyTodoClear` (the `todos_clear` path) also drops the mark: a cleared checklist
no longer asserts readiness.

## Why the mark is cheap: one funnel

`useInteractive.applyTodoUpdate` is the **only** writer of `todos[sessionId]`, and
**every** producer goes through it:

1. the live listener — `src/App.tsx`, `listenInteractiveEvent` → `todosUpdate`;
2. the restart seed — `src/store/sessions.ts` (two call sites, both fed by
   `commands/history.rs::history_page`, which returns `db.session_todos(...)` on the
   **first page only**, `before_id.is_none()`);
3. the close carry — `src/store/sessionLifecycle.ts::onSessionClosed`, which
   re-applies the board so a still-rendered Session keeps its checklist.

Reading the marker inside `applyTodoUpdate` therefore yields live detection **and**
restart persistence with **no new column, no migration, no IPC command, and no
`src-tauri/` change**.

`dismissSession` deletes both the board and the mark, and `onSessionClosed`
re-applies the board immediately afterwards — so a Session closed while ready
**gets the mark back through the same funnel**, which is correct: the board it is
still showing still says `ready`.

## The restart boundary (honest limit)

The seed restores `todos` only for a Session whose history is **opened**. A Session
that was never reopened after a restart has no `todos` in the store, and therefore
**no mark** — even though `todos_json` still holds the marker in the database.

This is the accepted boundary of the zero-migration design: the owner was offered
"must survive restart" and chose **"live only, fine."** A persisted per-session
`ready` column would close it and is a 20th migration gate (`GATED` is pinned at 19
in `storage/db/tests/open.rs`) — deliberately not paid.

## The mark on the card

`TaskCard` renders a `CircleCheckIcon` (`data-testid="task-card-ready"`) when the
board tells it the card's linked Sessions include a ready one.

- **Separate prop, separate glyph.** It does **not** ride `sessionStatus`
  (`"waiting" | "running" | "live" | "stored"`). Adding `"ready"` to that union
  would drag in `sessionStatusOf`, `useSessionStatus`, `SpaceTabs`,
  `TaskDetailDialog`, `sessionStatusRollup.test.ts`'s precedence, and
  `TasksBoard.test.tsx`'s `toEqual(["waiting","spinner","none"])` census. A card can
  be **ready AND have a Session waiting**; collapsing them loses information, so the
  three-way `sessionStatusRollupOf` answer is untouched.
- **Glyph, never a coloured word.** `text-success` as 12px *text* is a measured
  worst resting reading (3.87 on the `#f0f0f0` band, `src/lib/palettes/default.ts`).
  As a 14px **glyph** the applicable bar is 3:1 for non-text, which `text-success`
  clears (3.53–4.41 across the measured readings).
- **Stroke compensated.** Lucide draws on a 24-unit viewBox at `stroke-width: 2`,
  so a 14px box renders ~1.17px — a hairline on the one mark with no text beside it.
  `READY_GLYPH_STROKE_WIDTH` matches `SessionStatusMark`'s own `?` compensation
  (1.25 rendered px). The two are a deliberate pair: change both.
- **Decoration, not a name.** `aria-hidden` + `role="presentation"`. `TaskCard` is a
  `RowButton`, and a `div[role="button"]`'s accessible name is computed recursively
  from its subtree, so an announced mark would rename the card mid-turn. Same reason
  `SpaceTabs` passes `announce={false}`.
- `SessionStatusMark`'s `className` prop is **geometry-only** — `cn()` drops an ink
  utility a caller passes — so the mark could not be re-inked from the card anyway.
  A dedicated glyph was the only option that did not silently diverge two surfaces.

## The board must be able to see it: the refresh

A mark whose value is immediacy is broken if the board cannot see a model's write.
`docs/features/task-board-known-gaps.md` **§2** records that a card the model writes
is invisible until the board remounts (`useTasks.load` had only mount/Space-change
call sites). Shipped with the mark, in the same branch:

- `useTasks.refresh(spacePath)` — the **silent** re-read. Same read, same
  `loadEpoch`, same in-flight position merge, and **no `loading` write at any point**
  and no error write. A background refresh that sets `loading` is a board that
  flashes blank on every settle.
- `useTaskBoardAutoRefresh(spacePath)` (`src/hooks/`) — fires on the **falling edge
  of `inTurn`** (the settle signal), debounced at 350 ms per Space, cancelled on
  Space change and unmount. Mounted by **both** `TasksBoard` and `WorkflowsCanvas`.
- No new Tauri event: the frontend already receives what a settle needs.

## A convention nobody is told about is a convention nobody uses

**No in-app text currently tells a model this marker exists.** Nothing in the tool
descriptions, the system prompt, or the board mentions it — and the tool descriptions
are engine-owned, so they cannot be edited from here.

The channel that reaches a model **today** is desktop-owned and already exists:

- a column's **prompt prefix** (`stages.prompt_prefix`), or
- a column's **on-enter Skill** (`stages.on_enter_skill`).

Either can say "when the work is done, write a todo item whose content is exactly
`ready`". Until someone puts that text in a column, the mark will only appear for a
model that happens to guess the convention — **which is the expected state, not a
bug**, and it is the reason this file is written as a contract.

When #183 lands, the sentence moves out of the column prompt and into a real tool
description, and the marker text retires.
