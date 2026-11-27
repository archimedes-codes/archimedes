---
status: accepted
date: 2026-11-10
superseded-by: 0107-a-deleted-skill-is-a-breaking-change-against-every-stage-that-names-it.md (PARTIAL — the `discuss` seed entry and its two-Skill backfill only; this ADR's core decision STANDS, see the Amendment at the foot of this file)
---

# A **Stage** is the sole authority for a **Task**'s launch skill, and `on_enter_skill` is a second column beside `on_enter`

A **Task board** column should be able to name the **Skill** a **Session** starts with, so a
person's workflow — not a TypeScript switch — decides that dragging a card into Research loads
`research`. We decided the **Stage** row is the ONE source of that fact: `stages` gains a nullable
`on_enter_skill TEXT`, and `lib/taskPrompt.ts`'s `TASK_LAUNCH_MODES` / `skillOfMode` /
`stageOfMode` constant map is deleted rather than kept as a fallback.

**Why not keep the constant map beside it.** The map was already a second authority and it was
already losing: `stageOfMode("research")` returns the literal `"research"`, a Space that renames
that column has no such row, and `store/taskLaunch.ts::resolveStage` answers by SKIPPING the move
and printing "This Space has no `research` column". That note is the sound of a constant asserting
something the board can contradict. Two authorities deciding one question is also the split this
repo keeps documenting as the thing to remove, not to preserve.

**Why a second column and not a widened `on_enter`.** `on_enter` is a free-form string by design
(its DDL comment: "the value is DATA a user can change per Space") and its value is rendered RAW
into the column-header chip and tooltip in `TasksBoard.tsx`. A composite `'fresh:discuss'` would
print as a label. Keeping them as two fields also keeps them orthogonal: a Stage can be `compact`
AND carry a skill, and `move_task`'s Rust stays untouched — it branches only on `"compact"`, and
`fresh` needs no server-side action because starting a Session needs the `SessionManager`, the
skill catalog and `expandMentions`, none of which the storage layer is allowed to name.

## Considered options

- **Keep the constant map, add a Stage action beside it** — cheapest, no shipped behaviour
  changes, and rejected for re-creating exactly the disagreement `resolveStage` already reports.
- **Stage authority for the new pill only, dialog keeps the constants** — a documented interim
  split. Rejected: it leaves `research`'s skill living in a Rust-visible-free TS switch while its
  column lives in the database, which is the state we are trying to leave rather than arrive at.
- **Widen `on_enter` to `fresh:<skill>`** — rejected above, on the raw-render site.

## Consequences

- **`on_enter: "fresh"` STAYS inert, and that is deliberate.** This design does not implement the
  `fresh` value — it adds a second column beside it. `docs/features/task-board-known-gaps.md` §3
  therefore remains TRUE after this ships and must not be deleted as "closed"; it should gain a
  line saying `on_enter_skill` is the mechanism that actually starts a **Session**, and that
  `fresh` is now redundantly inert rather than merely unimplemented. Whether to drop `fresh` from
  the value union is a separate, unmade decision — the column is a free-form string, so nothing
  breaks by leaving it, and removing a legal value from a stored union is a migration for no gain.
- **`discuss` needs a Stage to own it, and the seed had none.** `DEFAULT_STAGES` is
  backlog / research / approved / doing / done — `stageOfMode("discuss")` returned `null` precisely
  because there was no column to move to. The seed grows a sixth entry, `discuss`.
- **The seed cannot fix existing Spaces, so a migration must.** Lazy seeding only fires for a
  Space with ZERO `stages` rows (`seed_default_stages`'s count check), and every existing install
  has five. Without a one-time backfill, deriving the card's buttons from Stage rows would
  silently REMOVE both shipped launch buttons from every existing board — no error, a
  plausible-looking board. Hence the backfill in the migration, following the `ADD COLUMN`-gated
  shape `storage/db.rs` already uses for its other columns.
- **The backfill hardcodes two skill names in Rust.** Accepted as the smaller evil: it is a
  one-time migration that ages out, not a live switch that keeps asserting. A Space without the
  `discuss` skill installed gets a Discuss Stage whose button `missingSkill` refuses with "This
  Space has no `discuss` skill to load." — a refusal that already exists and is the correct
  behaviour for an unmatchable `$name` token.
- **Nothing here touches `fulcrum-harness`.** The board has no model-facing tools at all
  (`docs/features/task-board-known-gaps.md` §2: `TaskStore` is in 0 files of the desktop and 0 of
  the published crate), so there is no crate-side seam to widen, no two-package move, and no
  orphan-rule exposure. Desktop-only: SQLite, one IPC command family, and the renderer.

## Amendment (2026-11-27) — what ADR 0107 did and did not supersede

**AMENDED 2026-11-27 — the front-matter pointer, not the decision.** 0098 is **NOT superseded as a
whole** and its `status` is unchanged. ADR 0107's own body says so in its own words — *"**Supersedes
ADR 0098 PARTIALLY.**"* — and then names, one by one, what falls and what stands. Only the
**"`discuss` needs a Stage to own it"** Consequence (the six-entry `DEFAULT_STAGES`) and the
**two-Skill backfill** (the `'discuss'` `UPDATE` and the `discuss` row-insert) fell. What stands,
unchanged and load-bearing: the **Stage** row is the ONE authority for a launch **Skill**; the
`TASK_LAUNCH_MODES` / `skillOfMode` / `stageOfMode` constant map stays **deleted**; `on_enter_skill`
stays a second column beside `on_enter`, orthogonal to it; and the inert-`fresh` Consequence stands.

**Why the line was filled rather than left empty.** This repo carries two readings of the same
pattern — ADR 0030 leaves `superseded-by:` empty for a narrowing, ADR 0120 §7 records 0098 as the
instance where the line was filled anyway, and calls it *"the one ambiguity in the house pattern."*
The line stays filled so a tool reading only front matter does not read the two dead Consequences as
live policy; **the scope is governed by this note, not by the pointer.** ADR 0120 §7 does the same
thing to 0119 and says so in the same words — *"The scope is governed by the inline note, not by the
front-matter line."*

**`on_enter_skill` is live, measured at this HEAD, and this feature depends on it.** It is the field
the next chain link launches: `mark_done` → advice → the destination column's `on_enter_skill` →
`launchTaskSession`. The proof is in the launch path, not in prose — `src/store/taskLaunch.ts` reads
`destination.onEnterSkill` in `missingSkill` (the refusal's message is templated on it) and in
`shouldInlineSkill`, and the name arrives there from the Stage row (`STAGE_COLUMNS` names
`on_enter_skill` and `stage_row_from` decodes it in `src-tauri/src/storage/db/rows.rs` — no index
is quoted here because a column added in the middle moves every index after it). A reader who takes
the bare pointer to mean 0098 is dead would be reading `on_enter_skill` as retired while the canvas
still edits it (`NodeSettingsBody.tsx`) and the node still renders it (`WorkflowNodes.tsx`). That is
the reading this
amendment exists to close.
