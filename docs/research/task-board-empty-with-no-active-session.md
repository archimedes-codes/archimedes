---
status: current
last-verified: 2026-11-12
verified-by: local code research — 3 researcher angles (root-cause trace, two-derivations audit, blast-radius sweep) re-verified by hand at HEAD 55567ac6, plus `npx vitest run src/hooks/useActiveSpaceCwd.test.ts` → 7 passed; Rust read, not executed
task: tsk_b0b11b7b-c30c-43d8-8caa-179ed7e0a25f
issue: https://github.com/archimedes-codes/archimedes/issues/185
---

# The Task board goes blank when no Session is active — because its Space is derived from a Session, not from the tab

**Settled question:** when a **Space** tab is selected but NO **Session** is active (every
Session archived, or the last one deleted), what should the **Task board** show — and what else
in the app degrades for the same reason? Scope agreed with the reporter: the board **and** the
archived-blind **Landing Session**. Depth: standard (3 angles). Type: code research, local tree
only, no web.

All citations recomputed at `55567ac6`. Test claims are named by **title**, never by line — line
numbers decay.

## Executive Summary

The board is not empty. It is **refusing to load**.

`TasksBoard` is handed the Space path derived from the **active Session's `cwd`**, not from the
**selected Space tab**. With every Session archived there is no active Session, that derivation
returns `null`, and the board takes its "no Space is open" arm: no `get_board` call, no columns,
`New task` and `Configure` disabled. Creating a Session fixes it because starting a Session is
exactly what makes the derivation non-null again.

The store already holds the correct value — `useSessions.activeSpacePath`, the tab selection — and
it is **not** `null` in this state. The Session list beside the board reads it and shows that
Space's rows, its Archived section with a non-zero count, its project Skills catalog, and `⌘N`
starts a Session **in that Space**. The app therefore makes two mutually exclusive claims about the
same folder in the same frame.

The reporter's design read — "the board is per-Space, not per-Session" — is the one the repo's own
durable docs support, and nothing needs to be invented to justify the fix:

- `CONTEXT.md:326` — the Task board "is PER-**SPACE**, one board per Space".
- ADR 0090 — `stages` / `tasks` are keyed on a `space_path` **string with no foreign key to
  `spaces`**; a Space with no sessions is not a case the schema excludes.
- `Db::get_board` → `seed_default_stages` (`src-tauri/src/storage/db.rs:3150`) counts only
  `stages WHERE space_path = ?1` and consults **no session at all**.

**The storage layer is ready for a session-less Space. Only the renderer's key refuses it.**

## Findings

### 1. The causal chain

| Step | Citation | Value in the reported state |
|---|---|---|
| Boot fetches archived rows | `src/App.tsx:335` — `listSessions(true)` | the full list, archived included |
| The store splits by flag | `src/store/sessions.ts:1619-1630` (`setHistorySessions`) | rows land in `archivedSessions`; `historySessions` becomes `[]` |
| The Landing Session is chosen | `src/store/sessions.ts:217-221` — `autoSelectActive(spaces, sessions, historySessions, evidence)` | **takes no `archivedSessions` argument** → returns `null` |
| The store's own Space field still lands on a Space | `src/store/sessions.ts:1186` — `activeSpacePath: owner ? owner.path : rows[0]?.path ?? null` | `activeSpacePath = "<leftmost tab>"` ✔ |
| The board's value is the *Session's* cwd | `src/App.tsx:414` `const spaceCwd = useActiveSpaceCwd()` → `src/hooks/useActiveSpaceCwd.ts:40-44` → `sessionFieldOf(s, s.activeSessionId, "cwd")`; `src/lib/sessionLookup.ts:132` short-circuits on a null id before the three-list walk | `spaceCwd = null` ✘ |
| The board refuses | `src/App.tsx:575` `activeSpacePath={spaceCwd}` → `src/components/TasksBoard.tsx:307-309` (early-return, no `load`) · `:446-449` (`"No Space is open, so there is no Task board to show."`) · `:374` / `:400` (`New task` / `Configure` `disabled`) · `:185` / `:323` (`launchFromCard` / `moveCard` early-return) · `:437` (`dismissBoostNote` guarded) | the reported blank board |

### 2. Three ways in — only one of which is the reported one

The archived case is what was reported, but the same divergence is a single ordinary click away.

- **(a) Boot with every stored Session archived.** As above. The reporter's phrasing ("all
  sessions are archived") points here.
- **(b) Click a Space tab with no live and no un-archived stored Session.** `selectSpace`
  (`src/store/sessions.ts:1250`) sets `activeSpacePath: path` **and** `activeSessionId: null` in the
  *same* `set` — atomic, by design, not a race. Its stored arm reads `historySessions` **only**
  (`:1246`), so an archived-only Space lands on `null` even though `sessionFieldOf`'s own walk
  *does* reach `archivedSessions` (`src/lib/sessionLookup.ts:130-138`). The two arms of one feature
  disagree about whether archived belongs in the walk — the exact failure
  `src/lib/sessionLookup.ts:12-16` warns about.
- **(c) Delete the active Session.** `deleteSession` (`src/store/sessions.ts:1875-1890`) clears
  `activeSessionId` via `clearSessionState({ …, activeSessionId: true })` (`:142-144`) and **never
  touches `activeSpacePath`**.

**What is NOT a route:** archiving the last Session *mid-run* does not blank the board.
`handleSessionClosed` deliberately retains `activeSessionId` (`src/store/sessions.ts:2463` — a close
is "a pause, not a discard") and `sessionFieldOf` still resolves the cwd through
`archivedSessions`. This is a **boot-state and tab-selection** bug, not an archive-button bug —
which is why it survived: the gesture that looks like the cause is not one.

### 3. Which writers can null `activeSpacePath` — and neither is this state

| Writer | Citation | Can null it? |
|---|---|---|
| `setSpaces` | `:1186` | only when `rows` is empty (`rows[0]?.path ?? null`) |
| `addSpace` | `:1221` | **no** — always sets the path, no Session involved |
| `selectSpace` | `:1250` | **no** — always sets the path |
| `removeSpace` | `:1279` | only when the removed tab was the selected one *and* none remain |
| `openSession` | `:1834` | no — only *moves* it, and leaves it alone when the `cwd` matches no row |
| `archiveSession` / `deleteSession` / `handleSessionClosed` | `:1659` / `:1875` / `:2381` | **never touch it** |

So in every state the reporter describes, `activeSpacePath` holds a real path. **The store is
correct and the board's input is wrong** — which is why the fix is a wiring fix and not a
state-machine fix.

### 4. Two derivations of "the active Space", and the naming trap

| | Meaning | Consumers | Behaviour at `null` |
|---|---|---|---|
| **A** — `useSessions(s => s.activeSpacePath)`, documented at `src/store/sessions.ts:545-551` as "the selected Space's path — the top tabs' state (a Space is a tab, like a browser tab)" | **Selection.** A first-class piece of UI state with its own lifecycle. | `SpaceTabs.tsx:245`/`:371`; `SpacesList.tsx:298`/`:349`/`:389`/`:393`/`:739`/`:973`; `startSessionInActiveSpace` (`:1317`) | Every one degrades to a *wider catalog* or an empty state that a code comment argues is **honest** (`SpacesList.tsx:957-960`). No consumer dies. |
| **B** — `useActiveSpaceCwd()` (`src/hooks/useActiveSpaceCwd.ts:40-44`) | **Projection** of the on-screen Session. No lifecycle; cannot exist without an active Session. | `App.tsx:516` (`SpaceCwdProvider`), `ChatStream.tsx:405`, **`App.tsx:575` → `TasksBoard`** | Dead surface (`external_open` refuses a relative path) or **a whole inert view**. |

The trap: `TasksBoard`'s prop is *named* `activeSpacePath` (`src/components/TasksBoard.tsx:90`) but
is fed B. One identifier names both derivations in two files. `SpacesList.tsx:277-279` already
forbids this for a neighbouring name (`activeView`); no equivalent rule exists here.

**B's owner does not know B has a third consumer.** `src/hooks/useActiveSpaceCwd.ts:8-13` states
"this is the ONE place that derivation lives, and it has **two** consumers", then enumerates
`ChatStream` and `App`'s `SpaceCwdProvider`. `grep -c TasksBoard src/hooks/useActiveSpaceCwd.ts` →
**0**. The board acquired B through the call site, not the contract. `SidePane.tsx:168-170` is a
fourth, re-deriving inline through `sessionFieldOf` directly (`sessionLookup.ts:8-11` counts it).

Two false claims in comments, both load-bearing for a fix:

- `src/components/SessionConfigBlock.tsx:164-166` — "the board is only reachable while a Session IS
  active (the board's own Space is `useActiveSpaceCwd()`…)". **False.** The `Tasks` door carries no
  `disabled` and no Session guard (`SpacesList.tsx:538-554`). The board is reachable with no active
  Session; what is true is only that it is *inert*.
- `src/App.tsx:563-566` — "the board and the transcript cannot disagree about which folder is
  showing". True *within* B, and silent on the fact that the tab strip (A) is a third party the
  sentence does not cover.
- `ADR 0095`'s invariant "any Session row is a second exit from every view" degrades to **one** exit
  in this state, because with no Session `SpacesList` renders no rows at all. `App.test.tsx` already
  noticed that shape for the *no-Space* case and recorded it as a fixture problem rather than a
  product one.

### 5. Sibling symptoms from the same root

Ordered by severity. All are the same null, so a fix that repairs only the board leaves these.

1. **The board goes inert** — the report. Six consequences, all listed in §1.
2. **Wrong catalog scope, not merely missing data.** `TasksBoard.tsx:165` reads
   `useMentionCatalogs(activeSpacePath)`; `null` maps to cache key `__global__`
   (`src/hooks/useCatalogRow.ts:74`) → `list_skills(None)` → **user-level** Skills. The launch-pill
   gate (`TasksBoard.tsx:232-245`) and `store/taskLaunch.ts:236-247`'s refusal both say *"This Space
   has no `x` skill to load"* — a sentence that is **false about the Space actually selected**. Same
   shape in `NewTaskDialog.tsx:161`/`:198` and `TaskDetailDialog.tsx:184`.
3. **Cache-key thrash.** `useCatalogRow.ts:86-91` deletes the LEFT key on a key change, and
   `ChatStream.tsx:405` calls the hook unconditionally above its `!activeSessionId` early return (the
   hook-count rule at `:388-396`), so every session ↔ session-less flip evicts the real Space's warm
   catalog and re-fetches. `SpacesList` (keyed on A) then disagrees about which key is warm.
4. **`SpaceCwdProvider cwd={null}`** (`App.tsx:516`) → relative **External opens** refuse.
   `useSpaceCwd()` returns `null` rather than throwing (`SpaceCwd.tsx:12-15`); `externalOpen` sends
   `cwd: null` and only `console.warn`s. `App.tsx:513-515` already calls this "the safe direction,
   but a dead surface".
5. **`SidePane` blank** — no title (the title element is not rendered at all), no `SessionCostLine`,
   no `ChecklistPanel` (`SidePane.tsx:191-200`, `:262`, `:266`).
6. **`?` File completion** gets the stable empty Listing (`listSpaceListing(null)`,
   `src/lib/tauri/commands/catalogs.ts:68-70`) — though the picker is behind `ChatStream`'s early
   return, so this one is a wasted fetch more than a visible defect.

**Checked and NOT in the blast radius:** `StageEditor` (`:312` returns `null`), `NewTaskDialog`
(unreachable — mounted only from a `disabled` button) and `TaskDetailDialog` (`columns` is
`undefined`, so `detailCard` is `undefined` and no dialog mounts at all) are unreachable behind
`disabled` parents; `store/taskLaunch` and `getBoard` take `spacePath: string` non-nullable, so the
null case is unrepresentable in TypeScript; `src/lib/taskPrompt.ts` takes no Space at all (its only
`cwd` mention is prose); `useCompletionDir` is keyed by directory prefix, not Space.

### 6. The archived-blind Landing Session (in scope per the reporter's scoping call)

Two functions choose which Session the app lands on, and **both read `historySessions` only**:

- `autoSelectActive(spaces, sessions, historySessions, evidence)` — `src/store/sessions.ts:217-221`,
  called from `setSpaces` at `:1162`. No archived parameter exists to pass.
- `selectSpace` — `:1245-1247`, `state.historySessions.filter(s => s.cwd === path)`.

Meanwhile the same file treats an archived-only Space as **first-class**:

- `archivedSessionIds` exists "so a space whose only sessions are archived still resolves its
  `view`" (`:271-278`).
- `spaceViewFor`'s `lastReason` falls back to the most recent archived Session "as a last resort
  (the close-reason banner must not silently vanish for an archived-only Space)" (`:336-345`).
- `archivedInSpace` (`:377-390`) feeds the sidebar's Archived section, which lists those rows with a
  non-zero count.

So the store already knows the Sessions exist; the two Landing-Session selectors are the blind spot,
and `SpaceTabs` then renders a tab strip in which **no tab reports `aria-selected="true"`**
(`SpaceTabs.tsx:371`, `:510`) while the tabs are all present and clickable.

**This is a decision, not a bug fix.** Teaching the Landing Session to fall back to archived rows
changes what the app opens on boot and on a tab click, and it interacts with ADR 0075 ("position is
not evidence", recency is the only rule) and with the sticky-archived semantics of ADR 0016. It is
in scope by the reporter's choice; it is *not* required to un-blank the board.

### 7. What is pinned today — this shapes any fix

**Pinned, and pinned as intended behaviour:**

- `src/store/sessions.test.ts` — `"selectSpace: live session preferred, then the most RECENT stored, then nothing"`; its third beat asserts `activeSpacePath === "/a"` **and** `activeSessionId === null`, with the comment "An empty space: no session (the chat's empty state)". **The store-level divergence is deliberate.** A fix must not "repair" it — the two fields are *supposed* to be able to disagree.
- `src/hooks/useActiveSpaceCwd.test.ts` — `"no active session → null"`, and a header comment repeating the "BOTH consumers" pair. Ran green at this HEAD: **7 passed**.
- `src/components/TasksBoard.test.tsx` — `"renders nothing but the header when there is no active Space"` (its comment names `useActiveSpaceCwd()` and asserts `getBoard` not called + `New task` disabled), `"the affordance is disabled with no active Space (createTask(null, …) is not a thing)"`, `"Configure is disabled with no active Space (there is no board to configure)"`.
- `NewTaskDialog.test.tsx` / `StageEditor.test.tsx` / `TaskDetailDialog.test.tsx` — the four modal null-Space cases.
- `src/lib/layerBoundary.test.ts` — see §8.

**The shape of every one of these pins: the prop is handed in by hand.** None renders the real `App`
tree with a Space selected and no Session, so **none would notice a fix that changes what `App`
hands down.** That is how the defect shipped.

**Unpinned (each verified by grep, not inferred):**

- The string `"No Space is open"` appears in **0** test files. The sentence a user reads in this
  state is asserted by nobody.
- Boot into an all-archived install through `setSpaces` / `autoSelectActive` — no test seeds
  `archivedSessions` there.
- `selectSpace` onto an archived-only Space.
- `SpaceCwdProvider` carrying `cwd={null}` while a Space row exists.
- `SpaceTabs`' own `activeSpacePath === null` arm (`aria-selected` with nothing selected).
- No test anywhere references both derivations in one case, so nothing pins that they may differ —
  or that they may not.

⚠️ **`App.test.tsx`'s `"the board renders for a Space with no stages without calling any write
command"` is mis-titled.** No Space and no Session are seeded, so the mount effect early-returns,
`getBoard` is never called, and the line rendered is "No Space is open…" rather than the no-stages
line. It passes because it asserts only the five write verbs and never asserts
`expect(getBoard).not.toHaveBeenCalled()` — the one assertion that would have revealed which arm it
was exercising. A fix should rename and re-seed it, not leave it green and misleading.

**Fixture hazard:** `src/App.test.tsx` calls no `resetStores()` and hand-writes per-test `setState`
key lists (its own comment says so), and `setSpaces` rewrites `activeSpacePath` unconditionally
after any seed. Its board helper `bootedWithActiveSession()` always seeds `activeSessionId` **and**
`activeSpacePath` together, and its bare renders resolve `listSpaces` to `[]` — so the two fields
are only ever nulled in concert, which is exactly how the disagreement survived. A fix that reads
`activeSpacePath` makes previously-inert seeds load-bearing.

### 8. Placement constraint for a shared derivation (measured)

- A shared Space derivation that **reads the sessions store at runtime** may live in `src/hooks/`
  (unconstrained — `layerBoundary.test.ts` walks `src/lib` only; precedent
  `src/hooks/useActiveSpaceCwd.ts` plus 15 other hooks) or in `src/store/` (precedent: the pure
  helpers `autoSelectActive`, `archivedInSpace`, `spaceViewFor`).
- It may live in `src/lib/` **only** in the argument-taking pure shape with no runtime store import
  (precedent `src/lib/sessionLookup.ts:128`, `src/lib/sessionRecency.ts:67`), and a store **type**
  import there reddens `layerBoundary.test.ts`'s type-edge pin, which asserts the set is exactly
  `["src/lib/chatSessionDerivations.ts", "src/lib/sessionCost.ts"]`.
- `tauriBoundary.test.ts` / `tauriBarrel.test.ts` are untouched unless a fix adds an `invoke` or
  imports inside `src/lib/tauri/`.
- One known pin to expect, not to treat as a regression: `SidePane.test.tsx`'s
  `"renders NO TODO section when there are no todos (the config block is always there)"` asserts
  `container.textContent` exactly, so any change that makes the pane show a Space name with no
  Session reddens it.

### 9. Not recorded anywhere as a known gap

`docs/features/task-board-known-gaps.md` (289 lines, `status: live`, `last-verified: 2026-11-11`)
has **zero** hits for `useActiveSpaceCwd` and **zero** for `Detached`. Its single
`activeSpacePath` hit (`:127`) is the *repaint* defect ("a card the model writes is invisible until
the board is remounted") and does not ask which derivation feeds the prop. No ADR mentions it. No
`CONTEXT.md` entry covers it.

The claim that would have prevented this — **"a Space is born at the same time as a Session (the
`record_session → upsert_space` hook)"** — appears **three times in code** (`sessions.ts:251-254`,
`NewSpaceDialog.tsx:28-30`, `src-tauri/src/agent/session/mod.rs:1280-1294`) and **zero times in
durable docs**. It is also strictly **forward** (start ⇒ row exists) and does not imply the converse:

- `Db::delete_session` (`src-tauri/src/storage/db.rs:1765-1775`) deletes `native_messages` +
  `sessions` and **nothing from `spaces`**.
- `Db::delete_space` (`:1867-1873`) deletes only the `spaces` row.

The two deletes are independent, so a Space row with zero Session rows is mechanically reachable
(Archived → Delete, or Settings → Detached sessions → Delete). A **Detached task** — ADR 0090's own
term, sibling of the existing **Detached session** — is the concept this state is an instance of, and
the board's own gap doc never names it.

## Evidence

| Source | Credibility | Notes |
|---|---|---|
| `src/App.tsx:414/516/575`, `src/components/TasksBoard.tsx:307/374/400/446`, `src/hooks/useActiveSpaceCwd.ts:40`, `src/lib/sessionLookup.ts:132`, `src/store/sessions.ts:217/1186/1250/1875/2463` | **Highest** — production source, read directly and re-verified by hand at `55567ac6` | The causal chain. Every line number in §1 was re-read from the file, not carried from a report. |
| `src-tauri/src/storage/db.rs:3150` (`seed_default_stages`), `:1765` (`delete_session`), `:1867` (`delete_space`); `src-tauri/src/commands/tasks.rs:279` | **Highest** — source read | **Read, not executed.** The Rust suite was not run. |
| `CONTEXT.md:19-32`, `:326`; `docs/decisions/0090`, `0094`, `0095`; `docs/features/task-board-known-gaps.md` | **Highest** — the project's own durable record | Quoted verbatim where the wording matters. |
| `npx vitest run src/hooks/useActiveSpaceCwd.test.ts` → 7 passed | **Measured** | Confirms the hook's `null` contract is deliberate and pinned. |
| Test-title inventory across `TasksBoard` / `App` / `sessions` / `SpaceTabs` / `SpacesList` / the three modals | **High** — grepped and read at HEAD | Names the pins a fix must survive and the states nothing pins. |
| `src/hooks/useCatalogRow.ts:74/86-91`, `src/store/taskLaunch.ts:236-247` | **High** — source read | Establishes that catalog scope is a *correctness* issue, not a cosmetic one. |

**Evidence classes:** §1–§5, §7, §8 are **verified facts** (observable at the cited line). §6's
claim that the archived-blind Landing Session is a *blind spot rather than a decision* is a
**reasonable inference** — the store's own comments treat archived-only Spaces as first-class, but
no doc states the Landing rule either way. The frequency of session-less Spaces is
**speculation** — no telemetry or issue text was found.

## Unresolved Contradictions

One real tension inside the repo, not between researchers:

- `src/store/sessions.ts:251-254` — "a session without a space is NOT a case here by design … So
  there is no 'unknown sessions' group to render", alongside
- `src/store/sessions.ts:398-411` — `detachedSessions`, "Every **Detached session** — a stored
  Session whose `cwd` matches no open Space row", which `CONTEXT.md:108-109` makes a glossary term.

The docblock's scope is narrow ("no *group* to render in `SpaceView`") and still true as written, but
as a statement about the domain it is stale. A fix should not read it as "a Space always has
Sessions".

## Gaps

- **Which of the three entry states was actually hit is undetermined.** All three end in the same
  triple (`activeSpacePath` = a real path, `activeSessionId = null`, `spaceCwd = null`). The
  reporter's phrasing points at boot-with-all-archived.
- **`get_board` on a path with no `spaces` row is read, not executed.** `seed_default_stages` keys
  only on its `space_path` argument, so it would seed and serve; no higher-level existence gate was
  found, and the Rust tests naming that behaviour were read by name, not line by line. Confirm with
  `cargo test -- --list` at implementation time if the fix relies on it.
- **No durable statement exists** of the rule the fix needs — "a Space can be selected with zero
  Sessions, and a per-Space surface must still answer." There is nothing to cite as the correct
  answer; `CONTEXT.md`'s "PER-SPACE" and ADR 0090's keying are the strongest available support.
- **The catalog-thrash eviction order** and the `App.test.tsx` mis-title's historical pass/fail
  record come from a sub-report whose transport was garbled; they were not independently re-run.
  Neither is load-bearing for the root cause.

## Scope agreed

The reporter chose **board + the archived-blind Landing Session**: make the board take the selected
Space, and make the Landing Session consider archived Sessions as a last resort so the sidebar and
the board agree about which tab is current. The sibling symptoms in §5 items 2–6 are recorded here as
the blast radius a complete fix should be measured against; they are not silently folded in.
