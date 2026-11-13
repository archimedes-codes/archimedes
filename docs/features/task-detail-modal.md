---
status: live
last-verified: 2026-11-13
verified-by: every claim below re-read against the shipped tree at the tip of PR #187 (squash commit `698397cd`), not lifted from the plan that designed it. Gates re-measured in the primary checkout at that commit — `pnpm test` 4498 passed / 187 files / 1 skipped, `pnpm build` green, `npx tsc --noEmit` clean. `TaskDetailDialog.test.tsx` measured with the RUNNER (`npx vitest list src/components/TaskDetailDialog.test.tsx | wc -l` → 61, and `grep -c '^\s*it('` on the same file agrees at 61 because the file holds no `it.each`), against 38 at the commit before the design pass, so the count only grew as the plan's verification rule required. Per-describe counts came from the same runner list, never from a grep. The census claims were re-run — `grep -c 'rounded-full' src/components/TaskDetailDialog.tsx` → 0 and the `PILLS` array in `src/lib/slabFloatSeparation.test.ts` names `TaskCard.tsx` and `TasksBoard.tsx` and no third board file, so the dialog really is outside that gate; `grep -c MutedCaption src/components/TaskDetailDialog.tsx` → 9 and `grep -c 'cn(' ` → 7. Rust was not touched by this change and `cargo` was deliberately not run.
---

# The Task detail modal — one document surface, and what makes a row clickable

`src/components/TaskDetailDialog.tsx` is the surface that exists to **unclip** what a **Task** card
truncates. That purpose is the whole design brief, and it is the test any change here should be
judged against: a limitation of the card that reappears in the dialog is a bug in the dialog, not a
shared constraint. It was designed in one pass (issue #182, PR #187, ADR 0101) and it changed no
schema, no wire shape, no IPC command, and no dependency.

## The body is markdown, rendered by the transcript's renderer

`task.body` goes through `AgentMarkdown` — the same component the **Task artifact** reader two
sections below it uses. This is a decision with a cost, recorded in
`docs/decisions/0101-task-prose-is-markdown-and-one-renderer-serves-it.md`: nothing in the schema
says a `body` is markdown (`tasks.body` is a nullable `TEXT`, the New Task dialog writes a plain
`<textarea>` into it, the model's `create_task` writes a sentence), so the field's type is unchanged
and its *meaning* moved by convention. A reader who inspects only `db.rs` will still believe a body
is a blurb. Do not describe it as one in new prose.

What that buys, all with zero new code: `safeUrlTransform`'s ADR 0051 denylist (`javascript` /
`data` / `vbscript` / `blob` / `filesystem`), `OpenAnchor` routing activation to `external_open`
rather than navigating the Client's own webview, `remark-gfm` (tables, strikethrough, `- [ ]`), and
relative links resolving against the board's own **Space** because `App.tsx` mounts
`SpaceCwdProvider` above the view ternary and `TasksBoard` receives that same `spaceCwd`.

**The accepted cost is visible immediately:** markdown collapses a single newline to a space, so a
body typed as two short lines in the textarea becomes one wrapped sentence. `remark-breaks` was
considered and rejected — it would be the repo's first new markdown dependency and it would make a
**Task** body render differently from the transcript and from a **Task artifact**, three prose
surfaces with two newline rules. A body that wants line breaks uses a list. Re-open only if
collapsed bodies turn out to be common in practice rather than hypothetical.

`taskBlock` is unaffected and that boundary is worth naming: the `<task>` launch block has always
sent the body to the model as escaped element content, so the model was already receiving markdown.
Making the human surface agree is the whole change; no prompt or escaping rule moved.

## A leading glyph means clickable, and read-only rows carry none

Before this pass an artifact-key `<button>` and the read-only `id` `<div>` wore the same
`font-mono text-ui-xs text-foreground-subtle`, differing only by `hover:bg-surface-hover` — a 5%
`color-mix` wash. "It doesn't look like something I can click" was the correct read of the screen.

- **Artifact key rows** lead with `fileIconFor("x.md")` (the `FileTextIcon` in `text-file-md`, the
  same icon and ink the transcript's `FileChip` draws) and trail a `ChevronRightIcon` — already the
  app's "this goes somewhere" mark in `Reasoning`, `ChangesGroupCard`, `ToolCallCardHeader` and
  `SpacesList`. Selection moved off the 5% wash onto `bg-selected`, the sidebar's active-row token.
- **Session rows** lead with `SessionStatusMark` (spinner / `?` / ring / dim ring), then the
  **title**, then the id demoted out of the text flow. `sessionFieldOf` walks live → history →
  archived (which is what makes an archived session's title reachable at all), `titleFor` is the one
  label rule so the modal and the sidebar cannot name one **Session** differently, and status comes
  from the batch `useSessionStatuses` because a hook cannot be called once per row in a list of
  changing length.
- **Read-only rows (`id`, `spec`) carry no leading glyph.** This is what makes "has a glyph" mean
  anything at all. A change that paints every row identically again is the regression to watch for.

**Do not re-file this as a bug:** `aria-current={selectedKey === key || undefined}` does *not*
serialise to `aria-current="false"` for an unselected row. `false || undefined` evaluates to
`undefined`, React omits the attribute, and the expression was evaluated directly rather than read.
An earlier draft of the design claimed otherwise and was retracted.

## The reading pane is one scroller with a sticky rail

A card **with** artifacts opens at `sm:max-w-4xl`, one without opens at `sm:max-w-2xl` — exactly as
before. **Width is decided at open, never on selection**: `artifactKeys` arrive with the card on the
board read, so no dialog ever resizes itself under the cursor, and the common artifact-less case is
untouched.

The `max-h-72` nested scroll is gone; `detail-scroll` is the only scroll container in the dialog and
the rail is `sticky` so it survives a long document. `max-h-[80vh]`, the pinned header and footer and
the scroller's `min-h-0` all stay as issue #180's follow-up fixed them — a flex item's initial
`min-height: auto` is what clipped the dialog before, and `min-h-0` is the token that removes it. The
inverse rule governs the sections *inside* the scroller: `shrink-0` and **no** `min-h-0`, because a
section that opts out of the min-height floor inside a definite-height column flex box is a section
that gets crushed by the one beside it.

**Below the dialog's breakpoint the rail stacks above the document instead of beside it.** At 400px
the dialog runs `max-w-[calc(100%-2rem)]` = 368px, and a 176px rail plus padding and the pane's own
padding left roughly 126px of document measure. Three tokens had to move to the `sm:` arm *with* the
width, because flipping the row's direction silently moved their axes — each of these would have been
a new defect left unconditional:

- `sticky` → `sm:sticky`. A stuck element paints over its stuck position, so a rail stacked **above**
  the document would cover the document's first lines for the whole scroll.
- `items-start` → `sm:items-start` over `items-stretch`. `align-items` is the **cross** axis, so in a
  stacked row that token shrinks the document to content width instead of stopping the rail from
  stretching — crushing the measure exactly like the bug being fixed.
- `flex-1` → `sm:flex-1` on the pane wrapper. `flex: 1 1 0%`, so stacked, the `0%` basis lands on
  **height** and the layout rests on whether a percentage resolves against an indefinite container
  height.

`w-full` + `sm:w-44` survives both directions on media-query ordering, not on tailwind-merge — that
`className` is a plain literal with no `cn()` in it. `bg-popover` on the rail is load-bearing rather
than decorative, for the same sticky-painting reason.

**No nested navigation.** A card-view / document-view swap with a Back control was rejected: ADR 0095
retired the app's `Back` button on the rule that *a modal is not a location*. A rail plus a pane is
one surface with one selection.

## Reading order follows what a person came to do

Inside `detail-scroll`, in order: **Body** (markdown, full width, no rail beside it) → **Artifacts**
(the only two-column region) → **Sessions** → **Meta** (`spec`, then `id`). Previously `id` and `spec`
sat above the artifacts, so a task id outranked the spec document.

One correctness fix came with the rows: a session link used to print `from <slug>` while the same
dialog's header printed the **Stage**'s `label` a few lines above it, so the modal contradicted itself
about what a **Stage** is called. Both now read the one `columns` slice through `stageLabelOf`, and
both fall back to the **slug** when a lookup misses — "we could not name it" is a different claim from
"it has no **Stage**".

## The race guards are the rail's problem, not the reader's

`selectArtifact` keeps two locks, clear `selectedArtifact` before the fetch and the `requestKey` ref
identity check after the `await`. The rail makes that race **more** reachable, not less — two reads
can be in flight and the older one can answer last, painting one key's document under another. Any
change that adds a second way to select an artifact has to keep both.

## Deliberately absent

- **Editing a Task from the modal.** `edit_task` exists on the wire and `store/tasks.ts`
  deliberately omits `editTask` ("no board action rewrites a card"), with zero UI callers. Adding an
  edit mode would make this component the owner of a write path the store refuses to own.
- **Per-session cost.** The header already shows the sum through `moneyOf`, which owns the
  null-vs-zero rule (ADR 0082).
- **`specPath` as a clickable `FileChip`.** A markdown body can now link to a spec; the `specPath`
  field renders as a read-only row. Two surfaces for one path with two behaviours is the disagreement
  this repo's defect log is made of, so if the chip ever becomes a link it **replaces** the row rather
  than joining it.
- **Nothing for `getArtifact` answering `null`.** `null` is an answer, so there is no document and no
  error sentence. A read *failure* is different and goes in the pane slot through `IpcErrorLine`,
  never in the launch `error` cell — and a launch failure keeps the dialog open with its own line.

## Pin map

`src/components/TaskDetailDialog.test.tsx`, 61 tests, one `describe` per subject (counts from
`npx vitest list`, which is the only instrument that expands an `it.each` — this file happens to hold
none today): `the graph buttons` 16 · `the artifact reader (issue #180)` 8 · `the artifact rail and
pane` 8 · `the clickable grammar` 6 · `the body renders as markdown` 6 · `what the card cannot show` 5
· `the modal scrolls (issue #180 follow-up)` 4 · `the session's Stage label` 3 · `the sessions list` 3
· `closing` 2.

Two gates this file is subject to and one it is not: a dynamic `className` must compose through `cn()`
(`classNameConvention.test.ts`), and the quiet caption pair `text-ui-xs text-foreground-subtlest` has
one carrier, `MutedCaption` (`mutedCaption.test.ts`) — the dialog uses both (7 and 9 sites). It holds
**zero** `rounded-full` literals and is not in `slabFloatSeparation.test.ts`'s `PILLS` census, which
scans `TaskCard.tsx` (5 fills) and `TasksBoard.tsx` (1).

One behaviour to pin rather than "fix": `AgentMarkdown` renders fine with no `SpaceCwdProvider`, but a
**relative** link inside it refuses as `relative-without-cwd`, because `useSpaceCwd()` answers `null`
and `classify` refuses to guess. A test that mounts this dialog without a provider will see that.
