---
status: live
last-verified: 2026-11-25
verified-by: read against this tree at `main` after `fix/card-single-attention-mark` — `lib/readyMarker.ts` (the word + the sentence), `store/interactive.ts` (`isReadyMarker`, `boardAssertsReady`, the `ready` slot), `store/sessions.ts` (`beginTurn`), `lib/sessionStatusRollup.ts` (`cardMarkOf`), `components/TaskCard.tsx` (the one mark), `lib/taskPrompt.ts` (the trailer), `hooks/useTaskBoardAutoRefresh.ts`
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

**A model-facing verb used to be engine-gated, and this repo could not add one.**
`TaskCall` and `trait TaskStore` lived in `fulcrum-harness`, a **crates.io-pinned**
dependency (`src-tauri/Cargo.toml`), and `tool_specs()` was the crate's — the desktop
contributed **zero** tool specs. A new verb meant an engine change, a crates.io
publish, and a pin bump here.

**That gate is gone and the marker is still a convention, so read the reason
carefully.** ADR 0102 / issue #183 landed on 2026-11-25: `trait TaskStore` is deleted
from the crate and the desktop now ships **seven** of its own **Host tool** specs from
`src-tauri/src/agent/host_tools/` as data on `StartEnv.host_tools`, so a tool can be
added without publishing a crate release. **A `mark_ready` verb was nonetheless NOT part
of that run and is DELIBERATELY DEFERRED** — ADR 0102 §5 caps the run at the seven board
and artifact verbs and §6 names session lifecycle as the seam's *second consumer, recorded
but not in scope*. Nothing in this file should be read as promising otherwise: **the
sentence in `lib/readyMarker.ts` IS the contract today, not a placeholder awaiting a
tool.** The independent argument below (the engine constructs the `TodoItem` vector, so an
extra key dies crate-side) is untouched by #183 and holds on its own.

The obvious shortcut does not work either. The engine **constructs**
`TodoItem { content, status, description }` and emits the *constructed* vector, so
an extra key on an item (`"ready": true`) is dropped inside the crate, **before the
frame the desktop would read exists**. Only the model-authored *string* survives.
That is the whole reason the marker is a word and not a field.

The shape a fix would take is **ADR 0102**'s (**issue #183**):
`StartEnv.host_tools` plus a vocabulary-free `HostToolCall` / `HostToolResponse`
pair, so the desktop can ship a tool without publishing a crate release.
**Amended 2026-11-25 — ADR 0102 has since shipped, and this verb is still not built.**
The mechanism now exists and is exercised by seven board/artifact verbs; a `mark_ready`
verb is the seam's documented *next* tenant and was explicitly left out of #183's scope.
So the sentence above about sequencing still describes the state, with one word changed:
the expensive half is now **available and unbuilt** rather than **approved and unbuilt**.
**If a `mark_ready` verb is ever built, the read path does not change** — the mark already
rides a store slot, so such a change swaps the *writer* only. That is why the convention was
built first: the expensive half was sequenced after the cheap half on purpose, not by
omission. (The `docs/roadmap/tool-separation.md` this paragraph used to cite is unreachable
by design — `docs/roadmap/` is gitignored and nothing there is recoverable after a ship;
ADR 0102 and `docs/features/task-board-known-gaps.md` §2 are the durable records.)

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

`TaskCard` renders a `BellRingIcon` (`data-testid="task-card-ready"`) in
`text-warning` when `cardMarkOf` resolves the card to `ready`.

- **ONE mark per card.** The card wears at most one glyph, chosen by
  `cardMarkOf` (`src/lib/sessionStatusRollup.ts`): `waiting` > `ready` > `running`.
  This **reversed** the first design, which painted a `ready` glyph *beside* the
  session mark and argued the pair was "more actionable than either half". The pair
  was built, and on a real board a green check next to an amber `?` read "finished,
  but blocked" — two marks disagreeing about whether anyone was needed. The fact a
  card reports is single, so the contradictory state is now **unrepresentable**
  rather than discouraged. `sessionStatus` and `sessionStatusRollupOf` are still
  untouched; the wider precedence lives beside them, not inside them.
- **Amber, and NOT a check.** The first glyph was `CircleCheckIcon` in
  `text-success`, which was a mistake the repo's own vocabulary should have
  prevented: `SubagentStatusIcon`'s `completed` case draws `CheckCircle2` in
  `text-success` and `ChecklistPanel`'s done indicator is a check circle in
  `text-success` too. The app spends real ink teaching that **a green tick means
  DONE** — and `ready` means the opposite, that a person is needed NOW to review. So
  it wears the attention hue the `?` already uses, and the SHAPE carries the
  difference: a bell for a hand-off, a question mark for a blockage, a spinner for
  progress. Sharing one hue across the attention family is coherent precisely
  because only one mark renders.
- **A separate prop, not a fifth `SessionStatus`.** Adding `"ready"` to that union
  would drag in `sessionStatusOf`, `useSessionStatus`, `SpaceTabs`,
  `TaskDetailDialog`, and `TasksBoard.test.tsx`'s dot census. The two inputs are
  also different KINDS of fact — one derived from live stores, one authored by the
  model — so the card takes both and `cardMarkOf` decides.
- **Glyph, never a coloured word.** `text-warning` as 12px *text* is a recorded
  defect (2.12 Everforest light), and `text-foreground-subtlest` on `bg-card` is
  2.36 / 2.18 with no palette gate able to see it. At 14px stroked the mark is WCAG
  non-text UI (the 3:1 class), where `text-warning` measures 3.00 on a white card.
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

## How the model is told: the launch-message trailer

**A convention nobody is told about is a convention nobody uses**, and nothing in the
tool descriptions, the system prompt, or the board used to mention it. The tool
descriptions are engine-owned, so they cannot say it from here, and
`StartEnv.system_prompt` is not a way out either: the harness's `(Fresh, Some(seed))`
arm calls `prepend_system` and **never** `build_main_prompt`, so "seeding" a Task
Session would leave it blind to its own `<tools>` section, its discovered skills, its
`cwd` and `AGENTS.md`.

The channel that ships is the **launch message**. `lib/readyMarker.ts` owns the
sentence, `buildLaunchMessage` appends it **after** the `<task>` block, and every
card-launched Session gets it automatically — no per-column prose, no per-Space
setup. It rides the block's side of the injection boundary, so it is never expanded
(`readyMarker.test.ts` pins that it carries no `$`, and `taskPrompt.test.ts` pins the
expander's argument).

Both strings live in `lib/readyMarker.ts` on purpose: the detector
(`store/interactive.ts`) and the instruction must agree on the exact word, and the
`lib/` layer cannot runtime-import `store/`, so a literal in each layer would drift
silently. `readyMarker.test.ts` pins the sentence against the constant.

Scope is **every card-launched Session**, including a column with no Skill. Sessions
started from the sidebar or the workspace never call `buildLaunchMessage` and so are
not told — correct, since `ready` is a claim about a Task. It is also inert in a
Space that has `manage_todo_list` switched off in Settings.

**Amended 2026-11-25 — #183 has landed and this sentence has NOT moved, because no session
verb shipped in it.** The retirement of the marker word is DEFERRED, not scheduled: ADR 0102
§5 allows no host tool beyond the seven board/artifact verbs and §6 records session lifecycle
as a later consumer of the same seam. If someone builds a `mark_ready` verb, then this sentence
moves out of the launch message and into a real tool description, the marker word retires, and
**the read path does not move** — which is why the convention was built first. Until that
happens, the launch-message instruction is the only thing telling a model the convention
exists, and removing it would silently un-ship the feature.
