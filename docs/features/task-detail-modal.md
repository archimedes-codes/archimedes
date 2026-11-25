---
status: live
last-verified: 2026-11-25
verified-by: every claim below re-read against the tree at the B2 commit on `feature/task-card-redesign-task4`, not lifted from the plan that designed it. Runner counts from `npx vitest run` on the owned files (60 in `TaskDetailDialog.test.tsx`, 20 in `TaskDetailDialog.edit.test.tsx`, 11 + 21 + 6 + 33 in the four `components/tasks/*` children, 312 across the owned-set run, which also includes `TasksBoard`, `TasksBoardReady`, `NewTaskDialog`, `useArtifactReader`, `tauriBarrel`, `classNameConvention`, `mutedCaption` and `slabFloatSeparation`, all green, none edited). Code-line counts from `grep -vcE '^[[:space:]]*(//|\*|/\*|$)'`, the ratchet's classifier, never `wc -l`: `TaskDetailDialog.tsx` 399 (down from 382 + the 301-line artifact section it no longer carries; its own 684 `wc -l` figure is not the unit), `TaskDetailDialog.test.tsx` 855 (test gate 1,000), `TaskDetailDialog.edit.test.tsx` 381, and the four children 104 / 124 / 43 / 270. `npx tsc --noEmit` clean. `bash scripts/check-file-size.sh` passes with the baseline unchanged. The `tauriBarrel` mocker census moved 70 → 71 for the one new barrel mocker (`TaskDetailDialog.edit.test.tsx`), and the spread half 69 → 70.
---

# The Task detail modal — a wide, Document-First two-column surface

`src/components/TaskDetailDialog.tsx` is the surface that exists to **unclip** what a **Task** card
truncates. That purpose is the design brief, and it is the test any change here should be judged
against: a limitation of the card that reappears in the dialog is a bug in the dialog, not a shared
constraint.

The modal is a wide (`sm:max-w-4xl`) two-column surface. The left column is a **Document-First** tab
strip — `Overview` plus one tab per **Task artifact** — over ONE scroller. The right column is a
compact **Properties** column. The header and the launch footer stay pinned. Title, Description and
spec path edit inline through `useTasks.editTask`, and the Stage is a dropdown over `moveTask`.

## Layout: one scroller, two columns, pinned header and footer

- **Width is always `sm:max-w-4xl`**, with or without artifacts. The `sm:` form is required: the base
  `DialogContent` declares `sm:max-w-md`, and a bare `max-w-*` loses to it.
- **The shell is a flex column, capped at `max-h-[85vh]`.** `DialogContent` ships as `grid`; the
  override to `flex` survives `cn()`'s merge, and a test pins it.
- **The tab strip is omitted when there are no artifacts.** With keys, it is `role="tablist"`:
  `Overview` (`data-tab-key="overview"`) and then one tab per key, in the order the card lists them.
  The active tab wears `border-brand text-foreground`; an inactive one wears `text-foreground-subtle`.
  Tabs are visible text with a `title`, never an `aria-label`, so the footer's `aria-label` census
  stays exact.
- **`detail-scroll` is the only element with `overflow-y-auto` inside the dialog.** It holds the
  Overview (Description, then Sessions) or the open artifact pane. `min-h-0` is load-bearing: a flex
  item's default `min-height: auto` refuses to shrink, so `flex-1` alone clips.
- **The Properties column is an `<aside>` with no `overflow-*`.** It sits beside the left column at
  `md:` and stacks beneath it on a narrow window. It carries `min-w-0 break-words`, so a long spec path
  or id wraps inside its 16rem column instead of widening the modal.
- **The launch note and the launch error sit between the scroller and the footer**, outside
  `detail-scroll` and outside `[data-slot="dialog-footer"]`. The note is `role="status"`; the error is
  `IpcErrorLine`, `role="alert"`.
- **The footer is one button per outgoing workflow edge.** `edges[0]` is the **Primary next step** and
  is `variant="default"`; the rest are `variant="outline"`. Each keeps its skill gate and its
  `aria-label`, and the footer buttons are still the only `aria-label`ed buttons in the dialog.

## The four children are props-only

`src/components/tasks/` holds the four pieces the dialog composes. None of them reads a store or calls
IPC, so none needs a barrel mock, and the dialog remains the only file that does (ADR 0074).

| Child | Owns | Notes |
| --- | --- | --- |
| `TaskDetailHeader` | `T{n}` and the title, click-to-edit | Enter commits, Escape cancels, blur commits; a rejected save keeps the draft. |
| `TaskDescription` | The Description, as markdown or an editor | The draft is held by the **dialog**, so it survives a tab switch. No `onBlur`. |
| `TaskArtifactTabPane` | One artifact's document | No scroller of its own. Shows `updated <relative>` with the absolute time as its tooltip. |
| `TaskDetailProperties` | Stage, Status, Activity, spec path, Updated/Created, id | The Stage is a `Select` over `moveTask`; the spec path edits inline. |

## The body is markdown, rendered by the transcript's renderer

`task.body` goes through `AgentMarkdown` — the same component the **Task artifact** pane uses. This is
a decision with a cost, recorded in
`docs/decisions/0101-task-prose-is-markdown-and-one-renderer-serves-it.md`: nothing in the schema says a
`body` is markdown (`tasks.body` is a nullable `TEXT`, and the model's `create_task` writes a sentence),
so the field's type is unchanged and its *meaning* moved by convention. Do not describe it as a blurb in
new prose.

What that buys, with zero new code: `safeUrlTransform`'s ADR 0051 denylist, `OpenAnchor` routing
activation to `external_open` rather than navigating the Client's own webview, `remark-gfm` (tables,
strikethrough, `- [ ]`), and relative links resolving against the board's own **Space**.

**The accepted cost is visible.** Markdown collapses a single newline to a space, so a body typed as two
short lines becomes one wrapped sentence. `remark-breaks` was considered and rejected: it would be the
repo's first new markdown dependency and it would make a **Task** body render differently from the
transcript and from a **Task artifact**. A body that wants line breaks uses a list.

**The body is now editable inline.** Click the Description (or the `Edit` button, or the "Add a
description…" placeholder) to open a textarea. Cmd/Ctrl+Enter saves; Escape cancels; Save and Cancel are
visible buttons. Saving an empty or whitespace-only draft writes `null` (a clear). A link inside the
rendered body is still a link: a click on an `<a>` does not open the editor.

`NewTaskDialog`'s body hint reads **"Optional. Supports Markdown."**, which replaced the older "Newlines
are kept." — that wording described the pre-markdown `<pre>` rendering and was stale the moment
the body became markdown.

## A leading glyph means clickable, and read-only rows carry none

- **Artifact tabs** are the clickable grammar for artifacts. The active one is marked by the brand
  underline, not by a fill, so it reads as a section switch rather than a row selection.
- **Session rows** lead with `SessionStatusMark` (spinner / `?` / ring / dim ring), then the **title**,
  then a trailing `from <Stage label>` caption. `sessionFieldOf` walks live → history → archived,
  `titleFor` is the one label rule so the modal and the sidebar cannot name one **Session** differently,
  and status comes from the batch `useSessionStatuses`, because a hook cannot be called once per row in
  a list of changing length.
- **The spec path is inert text that click-to-edits.** It is not a `FileChip` (ADR 0101's sibling rule:
  two surfaces for one path with two behaviours is the disagreement this repo's defect log is made of).
  Read-only rows carry no leading glyph, so "has a glyph" still means "clickable" anywhere it appears.

## Reading order follows what a person came to do

On the Overview: **Description** (markdown, or the placeholder) → **Sessions on this task**. Each
artifact tab is its own document. The **Properties** column is beside them, not inside the scroll.

One correctness fix is kept from the previous pass: a session link prints `from <Stage label>`, and the
Stage control prints the same label. Both read the one `columns` slice through `stageLabelOf`, and both
fall back to the **slug** when a lookup misses — "we could not name it" is a different claim from "it has
no **Stage**".

## Inline editing and Escape

Title, Description and spec path save through the store's `editTask` action. Its positional mapping is
`(taskId, title, body, specPath)`, with `undefined` meaning **keep** and `null` meaning **clear**; the
dialog sends only the field it changed, so a title edit never blanks the body or the spec path.

**The Escape seam.** Radix dismisses on Escape from a capture-phase document listener that runs before
any React `onKeyDown`, and it only dismisses when `!event.defaultPrevented`. So a child that calls
`stopPropagation()` cannot keep the modal open. The fix is the dialog's `onEscapeKeyDown`, which calls
`preventDefault()` while an editor is open:

- **Title and spec-path editors** keep the modal open with `preventDefault()` alone. Their inputs commit
  on blur, so they can never be open-but-blurred, and the Escape keydown reaches their own `onKeyDown`,
  which cancels them.
- **The Description editor** is the exception, and the reason for the dialog-level branch. It has no
  `onBlur`, so a click elsewhere leaves its draft open with the textarea unfocused, and the Escape keydown
  never reaches the textarea. A `preventDefault()`-only handler would deadlock: the modal would neither
  close nor cancel. So the dialog cancels the draft **directly**. The first Escape cancels the draft; a
  second Escape, with no editor open, closes the modal.

The lifted state that makes this decidable is in the dialog: `titleEditing` and `specEditing` (each child
reports every open and close, including unmount), and `bodyDraft` together with `shownKey`. The
Description draft only counts while its textarea is mounted (Overview showing). On an artifact tab a held
draft is in memory but invisible, so it does not block Escape from closing the modal.

A draft **survives a tab switch**: type a Description, open an artifact, return to Overview, and the
textarea still holds the text.

## Stage switching

The Stage control is a `Select` over the columns. Choosing another column calls `moveTask(spacePath, id,
slug)`. The store answers with the slug the card is in **after** the attempt: a different slug means the
move was refused (for example a Strict workflow), and the store has already reverted the optimistic slice
and written the sentence to its `error` cell. The dialog then shows that sentence as a `role="alert"`
under the control, and the control shows the original Stage again.

A `boostNote` (a warning, not a failure: the card moved, but a `compact` column with no live Session
compacted nothing) renders as a `role="status"` line, `data-testid="move-note"`, in the Properties column.

With no Space the Stage control is disabled.

## Properties column

- **Status** shows exactly ONE mark, chosen by `cardMarkOf({ sessionStatus, ready })`, which is the same
  function the card paints with. The precedence is `waiting` > `ready` > `running`:
  - `waiting` → `SessionStatusMark` and "Waiting for you";
  - `ready` → `BellRingIcon` in `text-warning` (`data-testid="property-ready-glyph"`) and "Ready";
  - `running` → `SessionStatusMark` and "Running".

  The whole row is omitted when the mark is `null`. The ready glyph is `text-warning`, not
  `CircleCheckIcon` in `text-success`: the board paints `BellRing` in `text-warning`, and a green check
  in the modal would contradict the glyph on the card the user just clicked. `TasksBoard` passes
  `ready={readyFor(detailCard)}`, so the modal and the card read the same marker.
- **Activity** is `N session(s)`, plus `moneyOf(costUsd)` when the cost is reported. `null` prints no
  dollar figure; `0` prints `$0.00` (ADR 0082).
- **Updated** and **Created** read `relativeTimeFromInstant`, with `absoluteTimeFromInstant` as the
  `title` tooltip.
- **ID** prints the `tsk_` id and a Copy control. The control is icon-only, so its accessible name is an
  `sr-only` span rather than an `aria-label`, which keeps the footer census exact.

## Deliberately absent

- **Per-session cost.** The Activity row shows the sum through `moneyOf`, which owns the null-vs-zero
  rule (ADR 0082).
- **`specPath` as a clickable `FileChip`.** The spec path is inert text that edits inline. If it ever
  becomes a link it **replaces** the editable value rather than joining it.
- **Nothing for `getArtifact` answering `null`.** `null` is an answer, so there is no document and no
  error sentence. A read *failure* goes in the pane slot through `IpcErrorLine`, never in the launch
  `error` cell.
- **No nested navigation.** A card-view / document-view swap with a Back control was rejected: ADR 0095
  retired the app's Back button on the rule that a modal is not a location. The tab strip is one surface
  with one selection, not a second place to go.

## The artifact race is the reader's, and the tab gates on the dialog's key

`select` in `src/hooks/useArtifactReader.ts` keeps two locks: it clears `selectedArtifact` before the
fetch, and the `requestEpochRef` identity check drops a late answer for a key the reader has moved on
from. Both are pinned by `TaskDetailDialog.test.tsx` (the in-flight gap and the out-of-order resolution).

`useArtifactReader` has **no cache and no deselect**, so `selectedKey` stays set after the reader returns
to Overview. The pane is therefore gated on the dialog's own `shownKey`, never on `selectedKey`. Re-opening
a tab whose document is already loaded does not refetch, because the dialog skips the call when the
document on screen is the one it would ask for.

No artifact is fetched on open (ADR 0100). The first fetch happens on the first click of a tab.

## Pin map

`src/components/TaskDetailDialog.test.tsx` — **60 tests**, one `describe` per subject, measured with the
runner (`npx vitest run`, which lists every test, and not a grep):
`what the card cannot show` 5 · `the sessions list` 3 · `the graph buttons` 16 · `the artifact tabs
(issue #180)` 8 · `closing` 2 · `the modal scrolls` 7 · `the body renders as markdown` 6 · `the clickable
grammar` 3 · `the session's Stage label` 3 · `the wide two-column shell` 5 · `the Status row` 2.

`src/components/TaskDetailDialog.edit.test.tsx` — **20 tests**, the store-backed integration: a real
`useTasks` slice and a `Harness` that re-derives the dialog's `task` the way `TasksBoard` does. It covers
inline editing (title, Description, spec path), the Escape seam including the **blurred Description draft
cancelled by the first Escape, with a second Escape closing the modal**, and the Stage switch (a successful
move, a refused move that reverts with a `role="alert"`, a `boostNote`, and a disabled control with no Space).
It mocks the barrel the documented way and spreads `vi.importActual`, which is why it is the one new mocker
in the `tauriBarrel` census (70 → 71).

The four `components/tasks/*.test.tsx` files — **11** (Header), **21** (Description), **6** (ArtifactTabPane)
and **33** (Properties) — have **no** `vi.mock` of `lib/tauri` and use **no** jest-dom matchers. They are
presentational, so they are not barrel mockers and do not move the census.

**Mutate-check.** Disabling the dialog's `onEscapeKeyDown` guard reddens exactly the four Escape cases that
depend on it (the title, the Description, the blurred Description, and the spec path), and the artifact-tab
Escape case stays green as it should. The guard was restored and the suite re-run green.

Two gates this area is subject to: a dynamic `className` composes through `cn()`
(`classNameConvention.test.ts`), and the quiet caption pair `text-ui-xs text-foreground-subtlest` has one
carrier, `MutedCaption` (`mutedCaption.test.ts`). The new children use `MutedCaption` for every caption.

## Unheld by a gate

Facts about this surface that are true and held by **no** automated check:

- **The request epoch orders by key alone, and carries no `taskId`.** `select` mints the epoch from the
  artifact **key** and both locks compare that one value. A read from a previous card whose key matches
  could pass both locks. **Reachability: no path found at HEAD.** The dialog is a Radix `Dialog` with the
  default `modal`, so the board behind it is unclickable while it is open, and a close unmounts it. It
  becomes reachable the moment a card-to-card control is added inside the dialog. Pre-existing.
- **Reader state is not reset when the card changes.** The hook has no `useEffect`, so a card switch on a
  never-unmounted instance would leave the previous card's key and document under it. Reachable only on the
  same path as the entry above. Pre-existing.
- **The no-wrapper rule on the artifact pane is held by review.** A child that adds a wrapper `<div>` is not
  caught by the suite unless the wrapper carries `overflow-y-auto`. The suite pins that one case
  (`detail-scroll is the ONLY scroll container in the dialog`).
- **No gate reads this document.** A doc that names a symbol the tree no longer carries fails nothing. This
  rewrite was checked by hand against the tree.

## Editing inside the modal: what the store refuses

`editTask` writes the three card-text fields only. The stage, the `number` and the within-column position
are not writable through it: the stage moves through `moveTask` (which runs the destination's `on_enter`),
and the order through `reorderTasks`. The modal therefore has a Stage control and no order control.
</content>
