---
status: accepted
date: 2026-11-09
superseded-by:
---

# The per-Session todo surface is renamed to **Checklist** because a kanban board now owns the word "board" — and the tool keeps the name `manage_todo_list`, because a migration reads that literal string out of stored rows

Adding a per-Space kanban **Task board** collides with four existing glossary terms —
**Todo board**, **Reduced board** / **Full board**, **Todo rail** / **board mark** — and with
`TodoBoardPanel` / `TodoRail` / `useTodoBoards` in the frontend. Two things named "board",
one per-Session and one per-Space, is confusion that compounds every session. We decided to
rename the older, narrower concept to **Checklist** (panel, rail, hook, and the glossary
entries) and to leave **Task** and **Board** pristine for the new surface.

**The decision that is actually hard to reverse: nothing below the UI is renamed.** The
rename stops at the frontend. Three names below it are frozen, each by a different kind of
persisted or cross-language contract, and the first is the reason the whole boundary exists:

1. **`manage_todo_list` — the tool name.** `backfill_session_todos` in
   `src-tauri/src/storage/db.rs` (ADR 0073's one-time backfill of `sessions.todos_json`)
   selects historical display rows by a literal string match:

   ```sql
   WHERE session_id = ?1 AND kind = 'tool-call' AND payload_json LIKE '%manage_todo_list%'
   ```

   and then re-checks `payload.get("title") != Some("manage_todo_list")`. **Those rows are
   already written in users' SQLite databases and they are never rewritten.** Renaming the
   tool without widening that predicate makes every existing install backfill *nothing*: the
   **Checklist** comes up empty after an upgrade, the migration reports success, and no error
   is raised. Silent data loss with a green suite. The name also sits at ~28 sites inside
   `fulcrum-core` (a tag-pinned git dependency — a two-repo change plus a tag bump), and
   `AGENTS.md` cites `manage_todo_list` as the canonical example of an interactive tool
   excluded from codemode's callable set.
2. **`todos_update` / `todos_clear` — the wire event strings.** These are not frontend
   identifiers. `todos_update` is *emitted by Rust* (`fulcrum-core/src/interactive/mod.rs`,
   in `todo_apply`) and *consumed by TypeScript* (`useInteractive.applyTodoUpdate`), routed
   through `src-tauri/src/agent/session/router.rs`. A string that crosses the language
   boundary cannot be renamed from one side, and a one-sided rename produces a Checklist that
   silently never updates — the same failure shape as (1), reached differently.
3. **`sessions.todos_json` — the DB column.** Renaming a column means a migration for data
   that is already at rest, for no user-visible gain.

Measured boundary, so the split is a fact rather than a judgement: `todos_update` is 14
occurrences across 8 frontend files *plus* the Rust emit and route sites; `todos_json` is 12
sites in `db.rs` and **zero** in the frontend, which is what makes it safely frozen — nothing
in the renderer can observe the column name.

**The glossary therefore names a UI concept while the tool, the wire, and the column keep the
old spelling — deliberately.** A future reader who "fixes" the tool name to match the term has
reintroduced the silent backfill loss. The **Checklist** glossary entry carries the reason,
not only this ADR.

## Why this is NOT the deferred §6 rename batch

`docs/roadmap/frontend-component-extraction-follow-ups.md` §6 defers five renames including
`TodoBoardPanel → TodoBoard`, recording **"Status: deferred. Not deferred for cost — for
authority."** ADR 0086 (the glossary-conformance one — cite **by slug**, `0086` is duplicated
on disk) then grants the naming rule while stating, in terms, that it *"cannot be read as
resurrecting those five renames, and any reader who takes it that way has read it backwards."*

This rename is not that batch, on two grounds:

1. **Different target.** §6's proposed target was `TodoBoard` — consolidating on the word
   "board". This rename moves *away* from "board" precisely because that word has a new,
   broader owner. It is not the deferred decision re-litigated; it is a different decision
   that happens to touch the same file.
2. **Different mechanism.** ADR 0086's rule is *"a name follows the `CONTEXT.md` term for the
   thing it names."* Here the **term is changing first** — deliberately, because "board" is
   now taken — and the identifier rename is the *consequence* of the term change. That is the
   rule operating exactly as written, not a sweep. ADR 0086 forbids a **wholesale,
   single-purpose rename pass across the tree**; this is six names in one concept's own
   boundary, at the moment that concept's glossary entry is rewritten.

The five §6 names (`ChatStream`, `Reasoning`, `MessageBubble`, `TodoBoardPanel → TodoBoard`,
the bare `rail`) remain deferred. Nothing here re-authorises them.

## Considered options

- **Rename the tool too, with a dual-match backfill** — correct but larger, and it belongs in
  `fulcrum`, not here. Recorded as a separate issue, and that issue must carry this
  requirement: any rename there must make `backfill_session_todos` match **both** the old and
  the new spelling **permanently**, because old rows are never rewritten.
- **Rename the old concept to something else entirely** — "board" was the specific collision;
  a synonym that kept "board" in any of its four terms would not have resolved it.
- **No rename, just fence the terms in the glossary** — cheapest, touches no standing
  decision, but leaves the sidebar saying **Tasks**, the right pane saying **Todo board**, and
  the code saying `TodoBoard` for three different things.

## Consequences

- **The glossary and the code disagree on purpose, and the reason must stay written down.**
  A future reader who "fixes" the tool name to match the term has reintroduced the silent
  backfill loss. The **Checklist** glossary entry carries the reason, not only this ADR.
- **The frontend rename follows ADR 0086's prescribed shape:** one name, one commit, the
  measured reference count in the commit message, and any test that reads the symbol as
  *source* moved in the same commit. Verified: `src/lib/classNameConvention.test.ts` holds a
  literal path for `TodoBoardPanel.tsx` in its `STATIC_TERNARY_SECTIONS` exemption set, keyed
  `` `${file} ${prop}= ${expr[0..60]}` ``, and that set detects a new file — so renaming
  without updating the key fails loudly, which is the good kind of pin.
- **Cost, re-measured at HEAD in §6's own metric (references / files):** `TodoBoardPanel` 43/9,
  `TodoRail` 22/6, `useTodoBoards` 21/8, `TodoBoard` 16/6, `TodoItem` 35/9, `todoBoardsOf`
  38/8, `useMainTodoItems` 12/5 — **187 occurrences across ~20 files**. §6 recorded
  `TodoBoardPanel` at 71/8; that figure does not reproduce at HEAD and the numbers above are
  re-measured, not inherited. For scale, §6 rejected `ChatStream → MessageList` at 779/74.
- **The frozen set is the deliverable, not the rename.** Six frontend identifiers move; the
  tool name, two wire event strings and one DB column do not, for three different reasons. A
  future pass that sees only the naming inconsistency will "complete" the rename and lose data
  — which is why the boundary is stated as a table in the spec and as three numbered
  constraints here.
- **`pnpm build` is the only gate that catches an orphaned import** here (`noUnusedLocals`),
  so delete the block first and re-grep each symbol before dropping its import line.
- **Three merged ADRs keep titles that now name a retired term, and they are NOT edited.**
  `0041-todo-boards-are-keyed-by-session-not-by-source`,
  `0042-the-side-pane-opens-itself-but-never-closes-itself` and
  `0073-the-store-holds-a-history-window-and-session-state-is-not-derived-from-it` all use
  "Todo board" / "board mark". `docs/decisions/` is **append-only — never edit a merged
  decision's body**, and `superseded-by:` is the wrong instrument: those three *decisions*
  still hold in full (keying by session id, the pane never closing itself, session state not
  derived from the **History window**). Only the noun changed. So a reader of those titles maps
  **Todo board → Checklist**, and this ADR is where the mapping is recorded. The same applies to
  `docs/features/subagent-sessions.md`, which is left stale deliberately — repairing it is a
  touch-repair on the next visit to that file, not a sweep authorised here.
- **The glossary now runs ahead of the code, and that is the one place this ADR cuts against
  ADR 0086's own guidance.** 0086 says terms are added "when the concept lands, not later", and
  the **Checklist** term lands before `TodoBoardPanel` is renamed, so for the interval between
  this ADR and the rename task the glossary and the identifiers disagree. That interval is
  intended: the glossary is the naming authority for NEW code, and the new **Task board** code
  needs terms to conform to the moment it is written. The **Checklist** entry names the pending
  rename explicitly so the disagreement reads as scheduled rather than as drift.

## Amendment (2026-11-09) — the dependency is now the published `fulcrum-harness`; **none** of the four frozen names was renamed

**This task renames NONE of the four frozen names.** Stated explicitly so a reader of this ADR does
not have to guess: `manage_todo_list`, `todos_update`, `todos_clear` and `sessions.todos_json` are
untouched by the crate rename. The rename's instrument was a case-sensitive replacement of the
exact tokens `fulcrum_core` (the Rust path prefix) and `fulcrum-core` (prose), and no occurrence of
any frozen name shares either token — verified before the sweep, and the four counts are unchanged
after it. The one frozen-adjacent line the sweep did reach is
`src-tauri/src/agent/session/tests/mod.rs:3925`, an assertion **message** that named the producing
crate; the `option_id` string VALUES that test pins (`trust-space`, `allow-directory`) are untouched.

**The decision is untouched, and the rename re-verified its premise rather than weakening it.**
`manage_todo_list` is still spelled that way in the published crate: **28** occurrences of
`manage_todo_list` in `fulcrum-harness-0.1.0`, and **0** of `manage_checklist`. The name sits in
stored rows on users' disks, and the crate that owns it is now a published artifact rather than a
tag — which if anything raises the cost of changing it, since a published version is immutable where
a git tag was mutable. The rename of the tool itself is fulcrum#20 and remains gated on the
desktop's dual-match widen releasing first.

**What changed is only the dependency description.** `:33` said the name sits at ~28 sites inside
`fulcrum-core`, "a tag-pinned git dependency — a two-repo change plus a tag bump". Read that as:
the name sits at 28 sites inside **`fulcrum-harness`**, a crates.io-pinned dependency — a two-repo
change plus a **version publish**. `:37` cites `fulcrum-core/src/interactive/mod.rs` as the emitter
of `todos_update`; the current address is `fulcrum/src/interactive/mod.rs` in
`archimedes-codes/fulcrum`, published inside `fulcrum-harness`, and that file exists in the published
`0.1.0` artifact — verified — so the emitter the ADR points at is still findable at the re-aimed
address. The `crates/fulcrum-core/...` form in the body is left as written, per ADR 0091's amendment.
