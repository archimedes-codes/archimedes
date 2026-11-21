---
status: current
last-verified: 2026-11-20
verified-by: one web researcher subagent (5 sources, cited) + primary first-hand measurement of every local
  claim at HEAD `b2d6ea95`. Four further researcher dispatches hit their turn limit and returned nothing,
  so the seam inventory, the gate sweep, and the declined-set re-check were re-run by hand rather than
  delegated — they carry no adversarial second opinion. Local instruments: `bash scripts/check-file-size.sh`
  (run with `TMPDIR` on real disk), `grep`/`git grep` over `src/` and `src-tauri/`, and a line-by-line read
  of `src/components/TaskDetailDialog.tsx` and its 1,589-line test file.
task: tsk_043da34a-1255-495e-9ee1-217448c864f6
---

# TaskDetailDialog's artifact guard: where it must live if the file is split

**The settled question.** *Where does `TaskDetailDialog.tsx`'s artifact request-ordering guard belong if
children are extracted — the dialog, a shared hook, or duplicated per child — and does unifying the two
async reads first remove the ordering problem?* Move-only (`behaviour MOVED, not improved`, PR #206's rule)
is the default for the split itself; unification was researched as a live candidate rather than assumed out.

**The answer, in one line.** The guard goes in a hook mounted **once in the dialog**, and the artifact
region must be extracted as **one child, not two**. Unifying the two reads is refuted: it re-couples what
the file deliberately decoupled, and it *relocates* the ordering problem rather than removing it.

**This report produced ADR 0114** (`docs/decisions/0114-a-request-ordering-guard-lives-with-the-await-and-the-region-it-guards-is-one-child.md`),
which records that decision, and the glossary term **request epoch** in `CONTEXT.md`, which names the
pattern (the code currently spells it six different ways). Note the naming finding: `guard` is already this
repo's noun for a source-scanning *test* instrument, so the runtime mechanism must not be called one.

---

## Executive Summary

PR #206's decline reason — *"the artifact-reader's `requestIdRef` is a request-ordering guard whose state
feeds two proposed children, so lifting it changes when the fetch fires"* — **is refuted as written on all
three of its claims.** The named symbol does not exist. The coupling it describes does not exist: the real
guard is touched at four sites, all inside one function, and the launch path shares **zero** state cells
with it. And nothing in the component fetches on mount, so lifting state cannot change when a fetch fires.

The guard is five lines. It was never what made this file hard to split. What actually constrains a split
is that `TaskDetailDialog.test.tsx` is **testid-and-DOM-structure driven** — the exact inverse of the
property that made PR #206's three component splits test-transparent. That is a real cost, and it is
satisfiable: a React component boundary adds no DOM node, so a child that returns the same elements with
no added wrapper keeps every structural assertion green.

---

## Findings

### 1. The guard, measured — the audit's reason does not survive contact with the source

| Claim in `docs/features/godfile-decomposition-closeout.md` | Reality at `b2d6ea95` |
|---|---|
| "the artifact-reader's **`requestIdRef`**" | No such symbol anywhere in `src/`. Real: `const requestKey = useRef<string \| null>(null)` — `src/components/TaskDetailDialog.tsx:167` |
| "whose state **feeds two proposed children**" | `requestKey` is written at `:170` and read at `:185` and `:192`. **All three are inside `selectArtifact`** (`:169-197`). Nothing else in the file touches it. |
| "so lifting it **changes when the fetch fires**" | The file contains **0 `useEffect`s**. The only call site is the rail button's `onClick={() => void selectArtifact(key)}` (`:576`). Firing is event-driven, so moving state cannot move the firing time. |

The launch path owns `busy` (`:139`), `error` (`:140`), `note` (`:145`). The reader owns `selectedKey`
(`:151`), `selectedArtifact` (`:152`), `artifactError` (`:157`), `requestKey` (`:167`). **The intersection
is empty.** The comment at `:153-157` states that separation as its own design goal — *"one cell would let
a stale launch sentence sit under an artifact read, or a reader failure claim the launch failed."* The split
the audit feared would break has already been performed inside the file, on purpose, with the reason written
down.

**The real coupling is a prop, not the guard.** `artifactKeys` is read in three places outside the artifact
region: `:379` (it decides the dialog's width class), `:486` (it gates the whole section), `:801` (the
"no detail yet" line). It arrives as a required prop (`:117`), so it stays with the dialog no matter where
the reader goes. The card's own note about the width being "decided at open, never on selection" is
accurate and is a genuine constraint on any extraction — but it is a constraint on the *shell*, not on the
guard.

### 2. Where the guard lives — this repo has already answered, five times

| Site | Shape | Citation |
|---|---|---|
| `store/tasks.ts` | `let loadEpoch` at module scope; `if (epoch !== loadEpoch) return` | `src/store/tasks.ts:248`, `:320-325` |
| `store/sessions.ts` | `reorderEpoch = { sessions: 0, spaces: 0 }` — the precedent `tasks.ts` cites | `src/store/sessions.ts:1193`, `:1731`, `:1765` |
| `hooks/useWindowMaximized.ts` | `checkIdRef` + `const isStale = () => currentId !== checkIdRef.current` | `src/hooks/useWindowMaximized.ts:101`, `:117-122` |
| `hooks/useAgentOverridesWrites.ts` | `publishEpochRef`, epoch captured at publish, compared on completion | `src/hooks/useAgentOverridesWrites.ts:87-97` |
| `hooks/useCatalogRow.ts` | `prevKeyRef` — key-identity across renders | `src/hooks/useCatalogRow.ts:85` |

The invariant all five share: **the counter lives with the code that awaits.** `useWindowMaximized` is the
closest structural analogue to the artifact reader — a hook-local monotonic ref with an `isStale()` closure
guarding a `setState` after an `await`. `useAsyncAction.ts` is the in-repo template for a hook that
*documents what it refused to improve* (no unmount guard, no re-entrancy by default, each with a reason and
a pin), which is exactly the honesty a new reader hook needs about its missing abort.

**Store ownership is available and wrong.** It would require a second module `let` in `tasks.ts`, whose
header at `:72-77` explicitly says only one lives there and that any new one must be cleared by `reset()` —
because `src/test/resetStores.ts` cannot reach a module `let`. It would also make the store own "which key
the reader is looking at", a view fact, and would break `getArtifact`'s deliberate contract as a pure
pass-through in which `null` is an answer (`src/store/tasks.ts:235-237`, pinned in
`src/store/tasks.test.ts:1289`).

**Duplicating per child is structurally impossible.** The rail (`:556-611`) and the pane (`:612-642`) read
the *same* selection. Two children each holding a guard means two answers to "which key am I looking at",
which is the one question `aria-current` (`:575`) and the pane's gate (`:612`) both answer today. This is
what forces the region to be extracted as one child.

### 3. Unifying the two reads — refuted on both local and external grounds

- **Local.** It re-couples `artifactError` from `error`, the exact separation `:153-157` exists to make.
  The card floated unification; the file already rejected it and recorded why.
- **External.** TanStack ships `useQuery` and `useMutation` as distinct primitives with separate status
  machines, and mutations get their own `isIdle`/`isPending`/`isError`/`isSuccess` plus `reset()`
  ([TanStack Query — Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations),
  first-party). The discriminator differs in kind: the read's result is valid relative to *which selection*
  asked for it; a mutation has no identity to compare against, only "did this command finish". Merging them
  into one `status` field means a pending mutation overwrites the read's status — lost data or lost error —
  and the ordering problem now sits *inside* the machine with no type boundary to catch it.
  ([TkDodo — React Query as a State Manager](https://tkdodo.eu/blog/react-query-as-a-state-manager),
  TanStack Query maintainer.)
- **Merging removes the race only by serializing** — converting it into a queue, which is precisely what
  `useActionState` does inside its own scope
  ([React — useActionState](https://react.dev/reference/react/useActionState), first-party). Serializing
  changes when the fetch fires. That is the one thing this refactor is not permitted to do.

**Verdict: unification relocates the ordering problem, it does not remove it.** Do not do it.

### 4. The guard's mechanism is the only one actually available here

The ref guard stops the stale **render**, not the work. React's own docs teach this shape as
`let ignore = false` in Effect cleanup
([React — You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect);
[React — Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)). `AbortController`
would stop the work too, but it requires the work to accept a `signal`, and Tauri documents `invoke()` as
returning a promise with **no cancellation argument**
([Tauri v2 — Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/), first-party).
Wrapping `invoke` in an abortable race only makes the caller stop awaiting — the ref guard with extra
ceremony. `useActionState`/`useTransition` serialize and expose `isPending`; they are built for mutations
and forms ([React 19 release post](https://react.dev/blog/2024-12-05/react-19)), not selection-driven reads.

**The strongest argument against the pattern is worth keeping in view**, not burying: hand-rolled async
bookkeeping is the documented pre-library shape, and the invariant "latest wins" lives in a mutable ref no
type enforces, so *"the bug returns the moment a second `await` path is added"*
([TkDodo](https://tkdodo.eu/blog/react-query-as-a-state-manager)). This component **already has a second
`await` path** — the launch at `:319-361`. That is an argument for putting the guard in a named hook that
owns exactly one await, where the invariant has a home and a test. It is not an argument for spreading it.

**The guard is load-bearing and it is pinned.** `src/components/TaskDetailDialog.test.tsx:868-905` ("an
out-of-order resolution cannot paint one key's document under another") hangs both reads on manual `slots`
and answers them out of order. Its own comment states that clearing on select cannot catch this case, so the
test sees the guard and nothing else. A companion at `:842-866` pins the other lock (clear-before-fetch).
Any extraction that loses the guard turns `:868` red and nothing else.

### 5. Seam inventory (code lines, ratchet's classifier: comments and blanks stripped)

| Block | Lines | Reads | Writes |
|---|---|---|---|
| Artifact region `:486-645` | **106** | `artifactKeys`, `selectedKey`, `selectedArtifact`, `artifactError` | via `selectArtifact` |
| Artifact reader state + guard + `selectArtifact` `:147-197` | **19** | `task.id`, `getArtifact` | 4 cells |
| Sessions list `:652-780` | 75 | `sessions`, 4 `useSessions` slices, `statusById`, `spacePath` | — |
| Launch footer `edges.map` `:807-862` | 43 | `edges`, `noSpace`, `busy`, `skills` | via `launch` |
| `edges` useMemo + `launch` + launch state `:139-364` | 48 | `columns`, `catalogs`, `spacePath`, `task` | `busy`/`error`/`note` |
| Shell + header + scroller `:365-443` | 63 | `task`, `stageLabel`, `money`, `artifactKeys` | — |
| Body markdown `:444-485` | 36 | `task.body` | — |
| Meta + note + error + empty `:781-806` | 23 | `task.specPath`, `task.id`, `note`, `error` | — |
| `MetaRow` `:866-882` | 17 | — | — |

Three subjects, cleanly separated: **reader ≈ 126**, **sessions ≈ 85**, **launch ≈ 91**. `MetaRow` is
already an in-file private component, which is the precedent for "a helper may stay in the file". The file
is 500 code lines / 882 raw — below the 1,000 tripwire and not in `scripts/file-size-baseline.txt`, so this
is a subject-count split, not a ratchet split.

### 6. The test file is NOT test-transparent — and this is the actual cost

PR #206's splits were cheap because `SpacesList.test.tsx` is 85 `getByText` / 48 `getByRole` / **0
`getByTestId`**. `TaskDetailDialog.test.tsx` is the inverse: 63 tests across 10 `describe` blocks, roughly
55 testid queries over 9 ids (`task-body` ×12, `artifact-key` ×22, `artifact-rail` ×5, `artifact-body` ×9,
`detail-scroll` ×5, `task-session-row` ×11, plus `artifact-section`, `session-status-mark`, `meta-row`), and
it asserts DOM **structure**:

- `rail.parentElement!.classList` — `:1370`
- `pane.parentElement!.classList` — `:1403`
- sessions wrapper `.parentElement!` — `:1469`
- `dialog().querySelectorAll(".overflow-y-auto")` must have length `1` — `:1436`
- `.closest(".overflow-y-auto")` compared by **identity** against the scroller — `:1442-1443`

A React component boundary adds no DOM node, so a child returning the same elements with no added wrapper
keeps every one of these green. **A child that adds a `<div>` to "help" reddens four of them.** That is the
one hard constraint of this split. It is satisfiable, and it is not the free pass PR #206's splits had.

The card asked whether the file queries by role/testid. It does both: roles for the launch buttons
(`getByRole("button", { name: "Research" })`, `getByRole("alert")`, `getByRole("status")`) and testids for
everything in the artifact and sessions surfaces. The launch surface is therefore already test-transparent;
the artifact surface is not.

### 7. Gates a new file trips (concrete, and all findable)

- **`src/lib/tauriBarrel.test.ts:769` asserts `expect(mockers).toHaveLength(56)`** — a *count*, not a set,
  with a ledger comment documenting every historical increment (`35 → 56`). A new test file that `vi.mock`s
  `../lib/tauri` reddens it. **Mitigation:** if the hook takes the fetch function as an argument instead of
  importing the barrel, its test needs no barrel mock and the count stays 56. The dialog already reaches the
  action through the store (`useTasks((state) => state.getArtifact)`, `:161`), so passing it in is the shape
  the code already has.
- **`src/components/mutedCaption.test.ts:100`** walks `src/components` recursively with an allowlist
  compared by `toEqual`, baseline `["src/components/MutedCaption.tsx"]`. The region's chevron carries
  `text-foreground-subtlest` **alone**, which the file's comment near `:600` already reasons about; that
  comment must travel with the chevron or the next reader "consistifies" it into an offender.
- **`src/lib/classNameConvention.test.ts`** keys its allowlist by *path + prop + first 40 characters*.
  `TaskDetailDialog.tsx` is **not** in it, because the file composes through `cn()`. A new file must keep
  using `cn()` and it stays green. Safe.
- **`noUnusedLocals` is on** (`tsconfig.json`), and `tsc` checks `src/**/*.test.tsx`. Deleting the region
  before dropping its imports is `TS6133`, a build failure. `AGENTS.md`'s rule applies directly: delete the
  block, then re-grep each symbol before dropping the import line.
- **Test-file precedent is split.** PR #206 left tests in the parent — `AgentsDialog.test.tsx` (1284) and
  `SpacesList.test.tsx` (2691) still sit beside their extracted dirs, and `src/components/tasks/` has no
  test file at all. Issue #135 split by subject into siblings (`ChatStreamDirectoryCompletion.test.tsx`
  etc.), and every one of those additions is a line in the barrel ledger above. For a move-only split,
  leaving the 1,589-line test file whole is both the PR #206 precedent and the zero-barrel-count option.
- The barrel and boundary guards both tolerate a file vanishing mid-sweep and both throw on a *named* path
  that is missing, so nothing here is keyed on `TaskDetailDialog.tsx` by path. Confirmed by grep: the only
  mentions of that filename outside its own test are prose comments in `tauriBarrel.test.ts:727`,
  `TasksBoard.test.tsx:1000` and `:1099`.

### 8. The declined set re-verified (shallow, one or two commands per blocker)

| File | Stated reason | Re-measured now | Verdict |
|---|---|---|---|
| `src/components/StageEditor.tsx` | needs a 3-deep split, not a row extraction | 504 code / 718 raw — unchanged | **HELD** |
| `src/components/chat/MessageList.tsx` | 11 of 17 refs cross the seam | 583 code, **17 `useRef`** confirmed at `:309-803` | **HELD** |
| `src/components/chat/EmptyStateFilm.tsx` | ADR 0070 probe sits between the effects | 387 code, 11 refs, probe still at `:465` | **HELD** |
| `src-tauri/src/storage/batching.rs` | 57% of it is prose | 539 code / 1403 raw → **61.6%** non-code (the "57%" was a different quantity — comment-only lines alone; see the closeout's Corrections) | **HELD, stronger** |
| `src-tauri/src/storage/db.rs` | 4 `include_str!` + vacuous lint + ~51 poison sites | `db/tests/mod.rs:5012/:5041/:5746/:6200`; `REFERENCES spaces` assertion at `:5064` still asserts an absent string; **52** poison expects | **HELD** |
| `src-tauri/src/agent/session/mod.rs` | 17 recovery sites, partitioning forces the poison decision | 17 `into_inner()`; ratchet reports **1583** code lines | **HELD** |
| `src-tauri/src/commands/tasks.rs` | **14 `pub(crate)` widenings** | **6**, not 14 | **REFUTED on the count.** The `include_str!("../../tasks.rs")` constraint still holds (`commands/tasks/tests/stages.rs:294`), and `commands/tasks/` already exists as a directory. **The only declined file whose stated blocker got measurably weaker.** |

Baseline membership unchanged: 11 entries, largest `db.rs` at 2154, `TaskDetailDialog.tsx` not among them,
and nothing new crossed 1,000. Ratchet green — `TMPDIR=$PWD/.tmp bash scripts/check-file-size.sh` →
"312 production file(s) walked, largest src-tauri/src/storage/db.rs 2154", exit 0. **It needs `TMPDIR` on
real disk**: the first run died with `printf: write error: Disk quota exceeded` on the shared `/tmp` tmpfs.

Decline-reason taxonomy for the next planner: `StageEditor` = **shape** (needs a redesign);
`MessageList` / `EmptyStateFilm` = **state** (refs cross the seam); `batching.rs` / `errors.rs` = **prose**
(the file argues its own case); `TaskDetailDialog` = **test structure** (now shown to be satisfiable);
`commands/tasks.rs` = **mechanical, and the count was wrong**.

---

## The three options, with costs

| | Guard ownership | Cost | Verdict |
|---|---|---|---|
| **A** | `src/hooks/useArtifactReader.ts`, mounted **once in the dialog**; the artifact region extracted as **one** child taking `selectedKey` / `selectedArtifact` / `artifactError` / `select` | New hook + colocated test. Barrel count moves `56 → 57` **only if** the hook imports the barrel — avoidable by taking the fetch as an argument, which is the shape the dialog already has. Zero behaviour change; the guard body moves byte-for-byte with its comments. | **Recommended.** Matches five in-repo precedents and answers the card's open question. |
| **B** | The store (`tasks.ts`, a second module `let`) | `reset()` must clear it (`resetStores.ts` cannot reach a module `let`); the store owns a view fact; breaks `getArtifact`'s pure pass-through contract and its `null`-is-an-answer pin | Available, wrong owner |
| **C** | Duplicated per child | Two guards on one selection → two answers to "which key am I looking at" | **Structurally impossible** |

---

## Unresolved contradictions

1. **Poison-site counts are quoted pasted together.** `AGENTS.md` says 17 recovery sites in
   `session/mod.rs`; the closeout says ~51 in `db.rs`. Both are right about their own file — 17
   `into_inner()` and 52 `expect("db mutex poisoned")` respectively — and the numbers are routinely mixed.
2. **`session/mod.rs` code lines: 1563 (census) vs 1583 (the ratchet's own run) vs 1589 (my
   reimplementation).** The ratchet is authoritative: **1583**. My classifier is not its classifier and
   should not be quoted as a ratchet figure.
3. **Idiomatic vs. smell (Finding 4) is genuinely unresolved in the literature.** React's own docs teach the
   ref flag; the query-library school calls the same shape the pre-library approach. Both sides are above;
   no winner was picked, and the recommendation rests on the repo's own five precedents rather than on
   settling that argument.

## Gaps

- **The React 18 "setState on unmounted component" removal was NOT verified at the primary source** — the
  web researcher flagged this itself. The React 19 release post does not mention it; the removal is a React
  18 change (facebook/react PR #22114) that neither of us fetched. The local code deliberately has no
  unmount guard (`useAsyncAction.ts` documents the same refusal), so nothing here depends on the claim — but
  do not cite it in a doc until someone checks the changelog.
- **Four of five researcher dispatches hit their turn limit and returned nothing.** Those angles were
  re-run first-hand. The seam cost grades therefore carry no adversarial second opinion.
- **No measured test count for a `useArtifactReader` test file.** It depends entirely on whether the hook
  takes the fetch as an argument (0 barrel mocks, count stays 56) or imports the barrel (+1).
- **`commands/tasks.rs` was checked shallowly** — the `pub(crate)` count was measured, the rest of its
  blockers were not re-derived. It is the one declined file that may deserve its own look.

## Evidence

**Local, primary** (all re-measured at `b2d6ea95`): `src/components/TaskDetailDialog.tsx` in full;
`src/components/TaskDetailDialog.test.tsx` (structure-sensitive assertions enumerated in Finding 6);
`src/store/tasks.ts`; `src/store/sessions.ts`; `src/hooks/useWindowMaximized.ts`;
`src/hooks/useAgentOverridesWrites.ts`; `src/hooks/useCatalogRow.ts`; `src/hooks/useAsyncAction.ts`;
`src/hooks/useMentionCatalogs.ts`; `src/lib/tauriBarrel.test.ts`; `src/lib/tauriBoundary.test.ts`;
`src/lib/classNameConvention.test.ts`; `src/components/mutedCaption.test.ts`;
`src/components/chromeButton.test.ts`; `src/components/TasksBoard.tsx`; `scripts/file-size-baseline.txt`;
`docs/features/godfile-decomposition-closeout.md`;
`docs/research/production-godfile-census-and-the-size-metric.md`; `docs/features/chatstream-decomposition-closeout.md`.

**Web** (credibility): React official docs — `useActionState`, *You Might Not Need an Effect*,
*Synchronizing with Effects*, the React 19 release post (first-party, highest). Tauri v2 docs, *Calling
Rust from the Frontend* (first-party). TanStack Query docs, *Mutations* (first-party for the library).
TkDodo, *React Query as a State Manager* and *Automatic Query Invalidation after Mutations* (TanStack Query
maintainer — expert, not normative). One practitioner writeup on `AbortController` in React (j-labs) was
cited by the researcher and is low-credibility; nothing here rests on it.
