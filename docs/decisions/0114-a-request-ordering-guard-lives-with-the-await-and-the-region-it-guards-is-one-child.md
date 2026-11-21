---
status: accepted
date: 2026-11-20
superseded-by:
---

# A request-ordering guard lives with the `await` that needs it, and the region it guards is ONE child

`src/components/TaskDetailDialog.tsx` (500 production code lines) was declined in PR #206 as *"partial
only"* because *"the artifact-reader's `requestIdRef` is a request-ordering guard whose state feeds two
proposed children, so lifting it changes when the fetch fires."* That reason is **refuted on all three of
its claims** at `b2d6ea95`: there is no `requestIdRef` — the guard is `const requestKey = useRef<string |
null>(null)` (`TaskDetailDialog.tsx:167`); it is touched at four sites, **all inside `selectArtifact`**
(`:170`, `:185`, `:192`) and shared with **nothing** outside it; and the file has **0 `useEffect`s**, so
the only thing that fires the read is the rail button's `onClick` (`:576`) and no amount of moving state
can move that moment. The launch path owns `busy`/`error`/`note` (`:139-145`) and the reader owns
`selectedKey`/`selectedArtifact`/`artifactError`/`requestKey` (`:151-167`): the intersection is empty, and
the comment at `:153-157` records that separation as its own goal.

We decided three things. **The guard belongs in a custom hook, mounted once by the dialog.** **The
artifact region — rail, pane, and the selection they share — is extracted as ONE child, not two.** **The
artifact read and the launch are NOT unified into one state machine.**

## Why a hook, and not the two available alternatives

The invariant this repo already runs is **the counter lives with the code that awaits**:
`store/tasks.ts:248,320-325` (`loadEpoch`), `store/sessions.ts:1193,1731,1765` (`reorderEpoch`),
`hooks/useWindowMaximized.ts:101,117-122` (`checkIdRef` + an `isStale()` closure — the closest structural
analogue), `hooks/useAgentOverridesWrites.ts:87` (`publishEpochRef`), `hooks/useCatalogRow.ts:85`
(`prevKeyRef`). A hook is the only one of the three candidate homes that keeps that invariant true while
leaving the fetch firing from the same click.

- **The store** can hold an epoch and is where ordering can be *enforced* across several consumers — but it
  would need a second module `let` in `tasks.ts`, whose header at `:72-77` says exactly one lives there and
  any new one must be cleared by `reset()` (`src/test/resetStores.ts` cannot reach a module `let`). It would
  also make the store own *which key the reader is looking at*, a view fact, and break `getArtifact`'s
  deliberate contract as a pure pass-through in which `null` is an answer (`store/tasks.ts:235-237`, pinned
  at `store/tasks.test.ts:1289`).
- **Duplicated per child is structurally impossible**, not merely unwise. The rail (`:556-611`) and the pane
  (`:612-642`) read the *same* selection; two guards means two answers to "which key am I looking at", which
  is the single question `aria-current` (`:575`) and the pane's gate (`:612`) both answer today. This is what
  forces the region to be one child.

## The two reads stay separate, and merging them relocates the race rather than removing it

The read's result is valid relative to *which selection asked for it*; a mutation has no identity to compare
against, only "did this command finish". One `status` field carrying both means a pending launch overwrites
the reader's status — a lost document or a lost error sentence — and the ordering problem then sits *inside*
the machine with no type boundary to catch it. It removes the race only by **serializing**, i.e. converting
it into a queue, and serializing changes when the fetch fires: the one thing this decomposition may not do.
Externally this is the documented separation of `useQuery` from `useMutation` (TanStack Query, *Mutations*)
and of server state from commands (TkDodo, *React Query as a State Manager*); locally it is the separation
`:153-157` already made on purpose.

## The guard is the only mechanism available here, and that is a constraint worth recording

The ref guard stops the stale **render**, not the work. `AbortController` would stop the work too, but
Tauri documents `invoke()` with **no cancellation argument** (Tauri v2, *Calling Rust from the Frontend*),
so there is no `signal` to plumb and an abortable race is this guard with extra ceremony.
`useActionState`/`useTransition` serialize and expose `isPending`; they are built for mutations and forms,
not selection-driven reads. So "put it in a hook" is not a preference among four equal options — the hook
holds the one shape that works against a non-cancellable command.

The honest cost is recorded too: hand-rolled async bookkeeping is the pre-library shape and the invariant
"latest wins" lives in a mutable ref no type enforces. That argues for a named hook owning **exactly one**
`await` — this component already has a second `await` path, the launch at `:313-351` — and not for spreading
the guard. The new hook must document what it refuses to improve (no abort, no unmount guard) the way
`src/hooks/useAsyncAction.ts` documents its own refusals.

## Consequences

- **Every bare line number below that cites `TaskDetailDialog.tsx` is `b2d6ea95` (`main`) — the pre-split
  base, 882 raw lines where this branch's HEAD has 677.** `:379`, `:486`, `:801`, `:117`, `:161`,
  `:313-351`, `:556-611`, `:612-642`, `:575` and `:576` point elsewhere at HEAD; they are kept rather than
  stripped because each names its symbol in the prose beside it, so the symbol is the citation and the
  number is a hint. The other numbers here DO resolve at HEAD — `TaskDetailDialog.test.tsx` and
  `tauriBarrel.test.ts` are byte-identical between the two commits, which is the point of the split, and
  the `CONTEXT.md` / `store/tasks.ts` / `classNameConvention.test.ts` cites sit in files this branch leaves
  alone. Dropping the numbers instead would shift this file's own, the hazard the scope note records.
- **The guard is pinned by exactly one test.** `TaskDetailDialog.test.tsx:868-905` ("an out-of-order
  resolution cannot paint one key's document under another") hangs both reads on manual promise `slots` and
  answers them out of order; its own comment states that clearing on select cannot catch this case. An
  extraction that loses the guard turns that one test red and nothing else. `:842-866` pins the other lock
  (clear-before-fetch).
- **`artifactKeys` stays with the dialog.** It is read outside the region three times — the width class at
  `:379`, the section gate at `:486`, the "no detail yet" line at `:801` — and it arrives as a required prop
  (`:117`). Width is decided at open, never on selection, and that is a constraint on the shell.
- **A mirror test tree does not apply here, and the reason does not need a citation: it governs Rust
  `tests/` directories and this is a frontend split.** (ADR **0113** says so, but that ADR is in flight on
  another branch and is not in this tree — it may never land, so it is not cited here as authority; the
  jurisdictional fact is.) The precedent here is PR #206, which left `AgentsDialog.test.tsx` (1,284 lines) and
  `SpacesList.test.tsx` (2,691) whole beside their extracted directories — `src/components/tasks/` has no
  test file at all. Keeping `TaskDetailDialog.test.tsx` intact is both that precedent and the cheaper gate.
- **`src/lib/tauriBarrel.test.ts:769` asserts `toHaveLength(56)` on the barrel-mocking test files** — a
  count, not a set, with a ledger comment tracing every increment from 35. If the new hook imports the
  barrel, its test needs a barrel mock and the count moves to 57 with a ledger line. **Passing the fetch
  function as an argument avoids this entirely**, and it is the shape the dialog already has: it reaches the
  action through `useTasks((state) => state.getArtifact)` (`:161`), not a command import.
- **The extracted child may add no DOM level.** `TaskDetailDialog.test.tsx` is testid-and-structure driven —
  the inverse of the `getByRole`/`getByText` property that made PR #206's splits test-transparent — and it
  asserts `rail.parentElement` (`:1370`), `pane.parentElement` (`:1403`), the sessions wrapper's
  `parentElement` (`:1469`), that `dialog().querySelectorAll(".overflow-y-auto")` has length 1 (`:1436`),
  and `.closest(".overflow-y-auto")` by identity (`:1442-1443`). A component boundary adds no DOM node, so a
  child returning the same elements is invisible to all five — **that** is what made the split possible, and it
  holds. This bullet went on to claim *"a child that adds a wrapper `<div>` reddens four of them."* **That was
  asserted and never executed, and it is false.** Executed at `2ececccb`: a bare inert wrapper leaves **63
  passed / 0 failed**, and so does a wrapper carrying `flex shrink-0 flex-col gap-1`; the falsification control
  is that the pins are live — dropping `shrink-0` from the section's own `className` reddens **1**. None of
  these assertions can see upward: `:1370` and `:1403` read the two-column row rendered *below* any wrapper,
  `:1469` reads a region the child does not render, `:1436` counts a **class** an inert wrapper adds none of,
  and `.closest()` walks **up** past ancestors lacking it. The only wrapper the suite catches is one wearing
  `overflow-y-auto`, and it reddens exactly **one** test: `detail-scroll is the ONLY scroll container in the
  dialog, and the rail and pane resolve to it`. So the no-wrapper rule is a **design constraint, not a
  test-enforced one** — it is unguarded, a contributor may add a wrapper with nothing reddening, and what holds
  it is **review**, together with the arithmetic the rule exists for: `detail-scroll`'s height math depends on
  the section's own `shrink-0` and its flex column. An ADR must not rest a ruling on a measurement that does not
  reproduce; that is exactly the failure this ADR was written to catch — the decline reason cited
  `requestIdRef`, a symbol never checked against the tree — and it is the same failure when the ADR does it to
  itself.
- **PR #206's Out-of-scope entry and the census's "partial only" grade are now stale.** `TaskDetailDialog`
  belongs to the *test-structure* class of decline reason — satisfiable — not to the *shape* class
  (`StageEditor`) or the *prose* class (`errors.rs`, `batching.rs`). `docs/features/godfile-decomposition-closeout.md`
  should be corrected when the split lands, not before.
- **Same re-check found one other stale decline.** `commands/tasks.rs` is recorded with *"14 `pub(crate)`
  widenings"*; measured now there are **6**. Its `include_str!("../../tasks.rs")` constraint still holds
  (`commands/tasks/tests/stages.rs:294`). Every other declined file's blocker **held** on re-measurement.
- **The pattern now has a name: `CONTEXT.md`'s "request epoch".** It had six spellings — `loadEpoch`,
  `reorderEpoch`, `checkIdRef`, `publishEpochRef`, `prevKeyRef`, `requestKey` — and a seventh was landing.
  Two naming traps were found while choosing it and both are recorded in the glossary entry: **`guard` is
  already this repo's noun for a source-scanning *test* instrument** (`classNameConvention.test.ts:336`
  *"the exact shape the guard convicts"*; **497 occurrences** of the word across `src`'s test files —
  `grep -rhoi guard src --include='*.test.ts*' | wc -l`, which counts **occurrences case-insensitively**, so a
  line carrying "Guard" and "guard" contributes two; do not compare it against the **414** below, which is a
  different instrument over a different unit — `grep -rn … | wc -l` counts **lines**, case-sensitively), so
  the runtime mechanism must not be called one; and bare **`epoch`** is on the **Session incarnation** entry's
  `_Avoid_` list (`CONTEXT.md:41`), so the qualifier **request epoch** is never optional. The existing
  `requestKey` name is also
  semantically wrong — an id claims identity, this token orders — which is an argument for naming the hook's
  return value rather than carrying the old name forward.
  - **Scope: this rules on the mechanism's NAME, not on the word repo-wide.** In code identifiers and in
    prose that names the mechanism, the noun is **request epoch**. `guard` is not otherwise reserved —
    `CONTEXT.md` spends it on a runtime mechanism in a pre-existing entry, **Self-modification guard**
    (`CONTEXT.md:197-199`; `grep -n "Self-modification guard" CONTEXT.md` → 7 lines), and the glossary warns
    of that itself: guard is "a word this repo already spends on the self-modification guard"
    (`CONTEXT.md:355`). So the rule is *within the request-epoch entry, avoid `guard`* — not *nothing in this
    repo may call anything a guard*. The premise still holds where it counts: the test-instrument sense is the
    dominant modern one — **414 of the 655 lines in `src` that carry the word are in `*.test.ts(x)`**
    (`grep -rn guard src --include='*.test.ts*' | wc -l` over `grep -rn guard src | wc -l`, both measured at
    `61614802`) — and both `classNameConvention.test.ts` and `mutedCaption.test.ts` call themselves guards.
    **Treat that denominator as a snapshot at a commit, not a constant**: an instrument whose denominator is
    "every line in `src` that carries the word" is invalidated by the act of documenting this very rule — the
    commit that wrote down "this is unguarded" added the word to `src` and moved the total from 654 to **655**
    while leaving the numerator at 414. Re-measure before quoting it.
  - **This ADR's H1 (`:7`) and its filename keep the older phrase "request-ordering guard" deliberately**, and
    the body names the mechanism a `guard` 11 more times (`grep -oi guard` over `:8-112` → 11; the upper
    bound was `104` until the Consequences qualification bullet was inserted above it on this same branch,
    which moved the endpoint and not the count — re-measure, do not trust either figure). That is a
    known, bounded exception, not an oversight for the next reader to consistify: the path is cited verbatim
    in three tracked files (`docs/features/godfile-decomposition-closeout.md`,
    `docs/research/taskdetaildialog-artifact-guard-ownership.md`,
    `docs/research/production-godfile-census-and-the-size-metric.md`), plus the branch's own
    **gitignored** plan (`docs/roadmap/taskdetail-dialog-artifact-split.md` — `git check-ignore` confirms;
    `.gitignore:36` ignores `docs/roadmap/`), so a rename is a coordinated three-file move plus a local plan
    bought for a prose preference. **These are cited as files, not as `file:line`** — and for a reason this
    record has now demonstrated on itself: this scope note used to cite
    `docs/features/godfile-decomposition-closeout.md:153`, which was true when `2ececccb` wrote it, and
    `61614802` inserted a section above it in that same file so the ADR's path moved to `:158`
    (`grep -n "0114-a-request-ordering-guard" docs/features/godfile-decomposition-closeout.md`). A bare line
    number into a file the same branch edits is the fragile form of the same hazard `AGENTS.md` warns about
    ("plans carry stale baselines within hours on a busy branch") and `docs/agents/flake-registry.md` states
    outright ("match on the test NAME, never the line number"). What the ruling rests on is the **path**; the
    line is an accident of the file's current length. The plan does not count as a fourth citation site in its
    own right: it is not in the tree, so another worktree never sees it — the same reason this ADR refuses to
    cite **0113** above. The binding forms are the code identifier and the glossary noun; the filename is a
    path. Do not "fix" the title to match the rule.

Evidence: `docs/research/taskdetaildialog-artifact-guard-ownership.md` (card artifact key `research`,
task `tsk_043da34a-1255-495e-9ee1-217448c864f6`).
