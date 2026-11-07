---
status: live
last-verified: 2026-11-07
verified-by: the wave-4 gate at the tip of `feature/codebase-improvement-1107` (Rust 565 lib + 15 seams tests, clippy 0 warnings, fmt clean; frontend 172 files / 3479 tests / 1 skipped; `pnpm build` clean). The alias figures are re-derived by the brace-aware census, not copied from the audit. Hashes below are PRE-SQUASH and will be orphaned by the squash-merge — locate by the content signatures given, not by hash.
---

# improvement-boundary-residue — close-out record

The surviving home for what the `docs/roadmap/codebase-improvement-1107-*` family recorded. That family
is deleted on ship, its files are **unrecoverable** (`docs/roadmap/` is gitignored, so git never held
them), and squash-merge orphans the per-task hashes — so the durable facts live here, cited by content.

Source audit: `docs/reviews/2026-11-07-codebase-improvement.md` (17 findings, all 17 approved). 11 tasks,
4 waves, 0 blocked, 0 approved findings dropped.

---

## The gate at ship

| layer | result |
|---|---|
| rust `cargo test --lib` | **565 passed / 0 failed** (baseline 563; +2 = the two frozen-spelling pins R1 added) |
| rust `cargo test --test fulcrum_seams` | 15 passed / 0 failed |
| rust clippy `--all-targets` | **0 warnings** |
| rust `cargo fmt --all -- --check` | clean |
| frontend `npx vitest run` | **172 files / 3479 passed / 1 skipped / 0 failed** |
| frontend `pnpm build` (`tsc && vite build`) | clean |

Baseline was 563 Rust / a scoped 477 vitest. The first FULL vitest run was 3469 at wave 1 — the scoped and
full figures are different measurements and must never be compared.

---

## Durable rule now in AGENTS.md: one `describe` = one subject

Added by D1. This is the run's most reusable output, and its wording was fought over, so the reasoning is
recorded here rather than only in the bullet.

A `describe` block (or `#[cfg(test)]` module) holding more than ~25 tests is a **tripwire to go look for
the subject boundary — not a number to satisfy by padding or by counting.** The rule is one `describe` =
one subject. A 40-test block over ONE subject is fine; a 20-test block spanning two subjects is already
wrong.

**The corollary is the load-bearing half: "splitting a file without splitting the block relocates the
problem."** A split is done when no `describe` spans two subjects, not when a file count went up. Several
subject-named `describe`s in ONE file is a legitimate outcome and costs no new mocks — a `describe` is not
a module.

The rejected alternative trigger was *"split when the test body exceeds the production body."* It is a
**file-level instrument that cannot name a block**: it fires on `ChatStream.test.tsx` (4,156 test lines vs
a 710-line component), and acting on it splits the file while moving the oversized block intact. That is
precisely the failure the rule exists to prevent.

Also added: the **lock-poisoning** rule — recover with `unwrap_or_else(|p| p.into_inner())` when the lock
guards independent per-key state, panic when it guards one shared resource. Both pre-existing behaviours
(`agent/session/*` recovers, `storage/db.rs` panics 28×) are correct and were NOT changed; the rule exists
so a new file does not copy whichever neighbour it happened to open. New panic-on-poison sites owe a
one-line rationale.

---

## The alias census: 51 dead-entirely pruned, and how to re-measure it

Five files re-export the crate across the boundary. The audit found **245** named re-exports: 67 live,
39 test-only, 88 dead-aliases (the name survives one level deeper — ADR 0091 intends these), **51
dead-entirely**. R2 pruned the 51 and left the rest. After the run: **0 dead-entirely**, LIVE 67→66 (the
one deleted item is `noop_refresher_factory`), TEST-ONLY 39 and DEAD-alias 88 untouched, total 245→193.

**How to re-measure, and the trap.** Count `pub use` statements, brace-expanded, `as`-aware, skipping
comments — then scan every `.rs` under `src-tauri/src` and `src-tauri/tests` for each name at root-qualified
path, module-qualified prefix, and bare spelling. A naive line grep was **wrong three times** on this
inventory because it missed brace-form imports (`pub use x::{A, B}`) and called live names dead. Two named
traps survive in the tree deliberately: `ProviderSource`, `should_probe` and `poll_team_info` are reached
through the LIVE `budget::` **module** alias, so only the *named* re-exports are dead; and `save` is a
bare-word trap. Deleting a module alias breaks callers; deleting a named re-export of a name that survives
deeper does not.

**Do not "tidy" the 88 dead-aliases.** They are the shape ADR 0091 chose so `SessionManager` compiled
across the move.

---

## The three false module docs — what is actually true now

Three `//!` headers asserted consumers that had moved into `fulcrum-core`. They are corrected, and the
corrections are the kind a reader cannot re-derive from this checkout, so they are recorded:

- `agent/web.rs` claimed `worker/core.rs` implements `RenderRequester`. `worker/core.rs` is **crate-owned**
  since T8/S8.2; the trait is the crate's own, and `RenderRequester` has zero desktop references. The real
  desktop-side fact: `render.rs` did NOT move, and the crate's `worker/core.rs` carries the impl.
- `agent/mod.rs` cited `crate::agent::fs_backend::canonicalize_lenient` and
  `crate::agent::codemode::engine::CODEMODE_MEMORY_LIMIT` as the reason its aliases exist. Neither
  spelling exists in this checkout — they are `fulcrum_core/src/fs_backend.rs` and
  `fulcrum_core/src/codemode/engine.rs`.
- `src/lib/tauri/types.ts` named a desktop path that moved in T5/S2.

**The general hazard:** after a package extraction, a module doc can be fluent, confident, and describe
files that are not in the repository. A doc that cites a path is a claim about the tree.

---

## `fulcrum_seams.rs` — the falsification repair, and its lesson

The file's stated method is *"each pin names the deletion that breaks it."* Three of its bullets told the
reader to delete files that **do not exist in this checkout** (`worker/manager/mod.rs`,
`agent/worker/store.rs`, `agent/worker/types.rs`, `protocol.rs` — all crate-owned since T8). Three
non-vacuity proofs had silently become unperformable.

They are now marked **CRATE-SIDE** with the crate path, said to be proven in
`archimedes-codes/fulcrum`'s CI, and — the part that matters — each keeps a **desktop-performable
substitute**: dropping the `manager` or `protocol` token from the `pub use fulcrum_core::worker::{…}` in
`agent/worker/mod.rs` fails the corresponding pin with `E0432`/`E0433`. Verified by doing it.

**Lesson worth keeping:** a falsification instruction rots faster than the test it describes, because
nobody runs it. If a pin's failure recipe names a path, that path needs to exist.

---

## Two new wire pins, both proven falsifiable

- **`permission_option_id_spellings_are_frozen`** — `option_id` gates two persistent side effects (marking
  a Space trusted; writing an allow-rule) off a bare string compare, and `PermissionOutcome` is
  crate-owned so the desktop cannot constrain the type. Producers of `"trust-space"` /
  `"allow-directory"` live in the **crate**, so this pins the CONSUMER side only — the only thing a
  single-language policy permits. The two fixtures that previously repeated the literals now reference the
  named constants, which is what makes the pin non-vacuous. Verified red by mutating `"trust-space"` →
  `"trust"`.
- **`closed_reason_spellings_are_frozen`** — `ClosedReason` carries BOTH a serde `rename_all` derive and a
  hand-written `as_str()`, and only `as_str()` reaches the wire (`router.rs` emits it). Nothing
  deserialises the enum, so the derive is dead today; it is kept for `StopReason` parity with a one-line
  why. Verified red by mutating `"agent-exited"` → `"agent"`.

Also extended: `the_config_dtos_are_one_type_across_the_boundary` now pins `Settings`, `FontSettings`,
`OidcConfig` and `WebSettings` alongside the two it already covered. Falsified by a twin struct (E0308) and
by dropping `rename_all` from the crate's `FontSettings` (camelCase assert fails). **Method note:** cargo
fingerprints git dependencies by rev, so a crate-side mutation needs `cargo clean -p fulcrum-core` before
it takes effect.

---

## Decisions recorded instead of executed

Each of these was considered and declined with evidence. They are verdicts, not omissions — check here
before re-proposing.

- **`src/lib/errors.ts` deleted, not imported.** Importing meant editing ~12 component sites, three inside
  other tasks' owned sets, which would have collapsed two waves. Rust already freezes all ten vocabularies,
  so deletion removed a mirror with **zero importers**, not a working guard. The gap is real and stated:
  `src/` has ~128 `.kind` branch sites with no TS-side type binding. The absence is recorded in
  `agent/errors.rs`.
- **`FilesError::kind()` left absent.** Its two variants are matched inline by the only code reading its
  kind discrimination; a method would be dead code normalising shape at zero behavioural value. A
  leave-comment is in the file. (`SessionError::kind` WAS made `pub`, to match its siblings.)
- **ADR 0086 annotated, not renumbered** — 13 external citation lines across the two files sharing `0086`.
  Cite by slug.
- **`lib/settings.ts` did NOT move to `store/`.** The finding named it alongside `sessionLifecycle.ts`, but
  it is a DOM-application module (font/CSS custom properties on `documentElement`) with one read-only store
  read — a legitimate `lib` resident — and `src/store/settings.ts` already exists. Allowlisted in the new
  census with that reason.
- **`sessions.ts` NOT collapsed into a `SessionState` aggregate.** Refuted: Zustand's identity primitive IS
  the flat key set, ~99 selector sites index inside the selector (`s.messages[id]`), and an aggregate makes
  any field write rewrite the session's row identity — 11 small re-render domains swapped for one. The Rust
  merge traded four *lock* domains for one; there are no locks here. The delivered artefact is a
  **write-set contract** (`clearSessionState`) plus an enumeration pin whose count is the guard.
- **`archimedes-film/scene.ts` not split** — verbatim art-file port, zero growth across the audited window,
  and the only large file whose tests are smaller than its production. Splitting destroys the auditability
  that makes it safe.
- **`agent/errors.rs` not split** — its ten families share `InvokeErrorExt` and are coherent; splitting
  buys a directory and nothing else. Its `//!` header now names all ten instead of two.

---

## Open work this run deliberately left

1. **`ChatStreamMentionPicker.test.tsx` — 62 tests in one `describe`, 1,861 lines.** It satisfies the rule
   as written (one subject: the mention pickers). But the tripwire's purpose is "go look for the boundary"
   and nobody looked INSIDE the cluster, which plausibly holds four pickers (`$`/`@`/`#`/`?`) plus
   expansion, gating and scroll-geometry groups. **Open question for the rule's owner:** does "one
   `describe` = one subject" license a 62-test block? If yes, say so; if no, the rule needs a second
   clause for large single-subject blocks. Same shape at `ChatStreamDirectoryCompletion.test.tsx`.
2. **`tauriBarrel.test.ts` is a shared tally** — it pins EQUALITIES on the mocker/spreader counts over
   every file under `src/`, with a hand-maintained provenance chain. Any task that adds a mocking file OR
   moves a file across directories edits it, so it should be partitioned like a **lockfile**. Wave 3 put
   two such tasks in one wave on disjoint `Owns` sets; both computed the same next value; the merge
   conflicted and the combined truth was visible to neither. **A move can change a path-derived census**:
   a test became a barrel mocker purely by moving to `store/`, because the predicate counts a mock by its
   path containing `lib/tauri` and no spelling from `store/` avoids it. Disjoint file sets are not
   disjoint effects.
3. **Retired-but-live UI labels.** An uncommitted `CONTEXT.md` (pre-existing, never touched by this run)
   declares three labels retired while all three still render: `"Open Space"` (a `SpacesList` menu label
   and a span), `"New space"` (the `NewSpaceDialog` title for an unvalidated folder), and `"New Session in
   this Space"` (the `···` menu item). `SpacesList.test.tsx` asserts the first by role/name, so the code
   half must move with the glossary or the glossary describes a UI that does not exist.
4. **Two vestigial test harnesses** kept byte-identical on purpose: `ChatStream.test.tsx`'s shared
   `beforeAll` still stubs `scrollIntoView`/`getBoundingClientRect` for tests that moved away (measured
   safe to delete), and `SpacesList.test.tsx` keeps the Agents-modal harness (`probeOn`, `rollsSeen`, the
   `./AgentsDialog` mock wrapper) that no remaining test exercises. Each is a one-liner.
5. **ADR 0086's "Honesty" section still cites "76 files / highest 0085"**, the figure the corrected probe
   refuted. And the causal claim is harsher than the evidence: the file's ORIGINAL add (`fe2111de`)
   predates the titling commit by ~7h on a branch with no dupe, so the author's probe was plausibly
   accurate and the collision materialised at the later squash-merge onto a main that already carried the
   other `0086` — a merge-order failure, not a skipped check.
6. **Prose naming the old module path:** `src/store/sessions.ts` and `sessions.test.ts` still say
   `lib/sessionLifecycle.ts`; `src/lib/sessionLookup.ts` still says the store "does not export"
   `SessionsState`, which is false since the completeness pin needed it exported.
7. **Flakes.** Named: `provider_gcloud_adc.rs::env_override_beats_the_provider_flag` — failed one full run,
   green standalone 3×, green as a target 3×, green on the next 4 full runs; process-global
   `LITELLM_GCLOUD_TOKEN_AUTH` bleed under parallel harnesses. **Unnamed, flagged not assumed:** one
   post-change `cargo test --lib` reported `564 passed; 1 failed` with the `failures:` block cut by a
   `tail` pipe, so the name is lost; eight later runs were 565/0 and no `--lib` test reaches the wrapped
   code. Harness lesson: never pipe a first post-change test run through `tail`.

---

## Process lessons that generalise

- **Compile a plan that carries literal code; do not proof-read it.** Two of one plan's three vetoes were
  found by compiling its snippets under the repo's real flags: a union-keyed write-back resolves its LHS to
  the INTERSECTION of the field types (TS2322), and an unread module-scope const trips `noUnusedLocals`
  (TS6133) so the build fails on **green** code. Reading found neither.
- **`expect(x).not.toHaveProperty(k, "message")` is vacuous.** In vitest 5 the second argument is an
  expected VALUE, so a red-first TDD test passes on the unfixed store. Put the message on `expect(...)`.
  This silently defeated an entire red step and no reviewer caught it by reading.
- **A plan's numeric expectation is not the criterion when the plan names the criterion.** One plan
  expected 160 test paths after its own earlier step had added 2 tests to that module; its stated authority
  was *"loss = 0, never the total"*, and that held exactly.
- **Name the instrument for every count.** Three `it(`-counting instruments were run on one file; an AST
  walk, a line-anchored grep and vitest's own per-file counts agreed at 215 executed — but the first
  version of the AST instrument under-counted by treating `it.each` as a plain `it`, which would have
  masked a loss.
- **`docs/roadmap/` is gitignored, and the roadmap skill's "commit the plan docs" instruction conflicts
  with that.** The repo rule wins: plans and grounding reports stay untracked and must be `cp`'d into each
  worktree after `git worktree add`. Force-adding is what once shipped fourteen grounding-report files
  inside a PR. Untracked files here are unrecoverable — delete by explicit pathspec, and fold durable
  content here first.

---

## Verified clean — recorded so the next audit does not re-spend it

No unused npm dependency; zero emitted-but-unqueried `data-testid` (71/71); zero orphan `.rs`; zero
`unreachable!()` / `todo!()` / `unimplemented!()`; zero real commented-out code blocks; production
`#[allow(dead_code)]` both `cfg_attr`-gated with correct reasons; the 52 IPC command names and 3 event
names all glossary-clean; the audited window's newest commits introduced zero vague names
(`data`/`info`/`item`/`payload`/`util`/`helper`). After this run there are **zero dead-entirely aliases**
in the five boundary files and every falsification instruction names a file that exists.

---

## Task → area map (what to read if something misbehaves)

| area | what changed |
|---|---|
| session lifecycle | inline tests moved to `agent/session/tests/`; `option_id` constants + `match`; two frozen-spelling pins; `with_catalog` deleted (its `catalog` FIELD is still read by `build()`) |
| boundary aliases | 51 dead-entirely `pub use` pruned across five files; three module docs corrected; `lib.rs` two dead items gone |
| wire contracts | `errors.rs` header + `SessionError::kind` public; four more config DTOs pinned; `fulcrum_seams.rs` falsification repaired |
| session store | `clearSessionState` write-set contract; session-keyed field enumeration pin; both retirement paths routed |
| frontend structure | `describe("ChatStream")` eliminated into subject-named blocks + a mention-picker file; `SpacesList` split three ways; `sessionLifecycle` moved to `store/`; new `src/lib/layerBoundary.test.ts` census |
| copy | `shadowHeading()` → Shadowing vocabulary in both dialogs; six assertions and six negative pins reconciled |
| rules / docs | AGENTS.md subject-count + lock-poison rules; ADR 0086 probe corrected |
| misc | `matchMedia` subscription shared (seed difference kept deliberately); `subagentSheetLayout` vacuity floor; two dead CSS tokens removed; `spaces.rs` canonicalize off the async executor |
