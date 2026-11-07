---
status: live
last-verified: 2026-11-07
verified-by: the wave-4 gate at the tip of `feature/codebase-improvement-1107` (Rust 565 lib + 15 seams tests, clippy 0 warnings, fmt clean; frontend 172 files / 3479 tests / 1 skipped; `pnpm build` clean). The alias figures are the audit's, restated with attribution — the census instrument was a throwaway under `/tmp` and was never committed, so they are NOT re-derivable from this checkout (see the census section). The Rust, IPC and testid figures name their instruments, and the Rust 565/563 and IPC 52 figures are re-runnable here. Hashes below are PRE-SQUASH and will be orphaned by the squash-merge — locate by the content signatures given, not by hash.
---

# improvement-boundary-residue — close-out record

The surviving home for what the `docs/roadmap/codebase-improvement-1107-*` family recorded. That family
is deleted on ship, its files are **unrecoverable** (`docs/roadmap/` is gitignored — the entry is the literal
string `docs/roadmap/`; locate it by that string, not by line number, since the number moves whenever a rule
is added above it — so git never held *those* files), and squash-merge orphans the per-task hashes — so the
durable facts live here, cited by content. **The directory is not, however, uniformly untracked:**
`git ls-files docs/roadmap/` returns **2** files at HEAD — `compaction-recovery-hardening-follow-ups.md` and
`frontend-component-extraction-follow-ups.md` — the legacy force-add residue AGENTS.md documents. The rule is
"git never held a *plan* file here"; it is not "nothing under `docs/roadmap/` is tracked", and a reader who
runs `git ls-files` will otherwise think this paragraph is wrong.

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

**Which instrument produces which Rust number.** `565` and `563` are the **test runner's** figures —
`cargo test --lib`, the count of executed test functions. A second, re-runnable instrument agrees with it
and explains the delta, so the +2 is checkable without a build:

- **Counting test attributes at line start** under `src-tauri/src` (`#[test]`, `#[tokio::test]`, and the
  parameterised `#[tokio::test(...)]` spellings — `grep -rhcE
  '^[[:space:]]*#\[([a-z_]+::)*test(\(.*\))?\][[:space:]]*$' --include=*.rs src-tauri/src` summed) gives
  **566 at HEAD**. The same pattern through `git grep -hEc <pattern> main -- 'src-tauri/src/*.rs'
  'src-tauri/src/**/*.rs'` gives **564 at `main`**.
- **Subtract the tests that do not compile on this platform.** Exactly one test under `src-tauri/src` sits
  behind a `#[cfg(windows)]` (`open.rs`, the `#[cfg(windows)]` immediately above its `#[test]`), so the
  linux-compilable set is **566 − 1 = 565** at HEAD and **564 − 1 = 563** at `main`. That matches the runner
  on both refs, and it is why the runner is 1 below the raw attribute count rather than 2.
- The **+2 is the two frozen-spelling pins** R1 added, both new on this branch and both absent from `main`:
  `permission_option_id_spellings_are_frozen` and `closed_reason_spellings_are_frozen`, in
  `agent/session/tests/mod.rs`.

So: **runner 565 / attribute-count 566 / linux-compilable 565** at HEAD, and the same −1 offset on `main`.
Anyone who counts attributes and gets 566 has not gone wrong — they have counted the Windows test.

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

**Read this first: every number in this section is a throwaway instrument's output, and none of it is
re-runnable from this repository.** `grep -rln "dead-entirely" scripts/ src-tauri/` exits **1** with no
output — the census was never committed, there is no `scripts/check-aliases.sh`, and no test owns any of
these counts. The figures below are the audit's, restated here with attribution (finding 2 of
`docs/reviews/2026-11-07-codebase-improvement.md`) so the durable facts survive, **not** as claims a reader
can reproduce with a command in this checkout. The audit ran four instruments and got four answers before it
landed on this one, which is the reason the instrument is named in full below rather than summarised.

**"Five files" is the census's SCOPE, not a count of files that re-export the crate.** The five are
`agent/mod.rs`, `agent/worker/mod.rs`, `agent/harness/mod.rs`, `agent/web.rs`,
`agent/provider_auth/mod.rs` — the boundary the audit was asked about. A reader who greps the tree gets a
bigger number, and should expect to: **11** files under `src-tauri/src` carry a `pub use fulcrum_core`
statement, **12** including `src-tauri/tests/fulcrum_seams.rs`. Six of those are outside the census scope
(`storage/db.rs`, `config.rs`, `types.rs`, `agent/session/mod.rs`, `agent/harness/store.rs`,
`agent/harness/trust.rs`) and were never measured or pruned by this task. Both counts reproduce with
`grep -rln 'pub use fulcrum_core' --include=*.rs src-tauri/src | wc -l` (drop the `src` for the 12). **Do not
build this count from `git ls-files 'src-tauri/src/**/*.rs'` — that glob does not match top-level files, so
it silently drops `config.rs` and `types.rs` and reports 9.** The five-file figure is not reproducible by any
command, because it is a scope decision, not a measurement.

**The census figures, labelled as what they are.** The audit measured **245** named re-exports across those
five files: **67 LIVE, 39 TEST-ONLY, 88 DEAD-alias** (the name survives one level deeper — ADR 0091 intends
these), **51 DEAD-entirely**. R2 pruned the 51 and left the rest. The stated after-state is **0
dead-entirely**, LIVE 67→66, TEST-ONLY 39 and DEAD-alias 88 untouched, total **245→193**. Two things about
that arithmetic are worth pinning so nobody re-derives it wrong:

- The buckets are exhaustive — `named = LIVE + TEST-ONLY + DEAD-alias + DEAD-entirely` — so the
  after-total is `66 + 39 + 88 = 193`, which is `245 − 51` pruned **− 1** further LIVE removal. That
  single LIVE deletion is `noop_refresher_factory`, dropped from the `pub use refresh::{…}` in
  `agent/provider_auth/mod.rs` (it had zero callers; see the audit's dead-code table). Anyone who computes
  `245 − 51 = 194` has missed it.
- **The after-figures are derived, not re-measured.** `0 dead-entirely` and `LIVE 66` follow from "the 51
  were pruned and exactly one LIVE item was deleted"; nobody re-ran the instrument after the prune. Treat
  `0` and `193` as the arithmetic consequence of the prune, and the pre-run `245 / 67 / 39 / 88 / 51` as the
  only directly measured set.

**The instrument, spelled out — because a grep is not it.** The audit's working version is described in its
own report as `/tmp/census4.py`, a throwaway script under `/tmp`, **not committed and not recoverable from
this checkout**. Its algorithm, which a reader would have to rebuild to re-measure:

1. **Seed the names per file.** Parse the five files for statements that *start* `pub use` (multi-line
   aware, semicolon-terminated), **brace-expand** `pub use x::{A, B}`, take the **alias** side of `as`
   (`pub use run as run_key_helper` contributes `run_key_helper`), skip `self` and `*`, and skip comment
   lines. Only names enter the census — module aliases are counted separately and are **not** prunable.
2. **Build the corpus.** Every `.rs` under `src-tauri/src` and `src-tauri/tests`, excluding
   `node_modules`/`target`/`dist`, minus the shim file itself.
3. **`#[cfg(test)]`-awareness is load-bearing, not decoration.** Before scanning, walk each file and record
   the line span of every `#[cfg(test)]` block by brace-counting from the attribute. A hit inside one of
   those spans counts as **test** usage, never production usage. Skip comments when scanning, and strip
   string literals before matching so a name that only appears inside a string is not a reference.
4. **Match each name three ways**, against each per-file root (`crate::agent` and `archimedes_lib::agent`,
   etc.): the **root-qualified** path, any **module-qualified prefix** (`worker::manager::WorkerManager`
   makes `manager` live), and the **bare spelling** as a word-boundary regex.
5. **Classify on the first bucket that fires**, in this order: any production hit → **LIVE**; else any hit
   inside a `#[cfg(test)]` span or under `tests/` → **TEST-ONLY**; else the bare spelling occurs somewhere
   → **DEAD-alias**; else → **DEAD-entirely**. That ordering is what makes DEAD-alias mean "the name
   survives one level deeper" rather than "unused".

**Why a grep cannot reproduce this, and the trap.** A naive line grep was **wrong three times** on this
inventory — it missed brace-form imports (`pub use x::{A, B}`) and called live names dead, and an early
version even counted private `use` lines as re-exports. Two named traps survive in the tree deliberately:
`ProviderSource`, `should_probe` and `poll_team_info` are reached through the LIVE `budget::` **module**
alias, so only the *named* re-exports are dead; and `save` is a bare-word trap. Deleting a module alias
breaks callers; deleting a named re-export of a name that survives deeper does not.

**Do not "tidy" the 88 dead-aliases.** They are the shape ADR 0091 chose so `SessionManager` compiled
across the move.

---

## The false module docs — the audit's three, and a fourth this doc used to claim was fixed

The audit's finding 2 filed **three** false doc-comments: `agent/web.rs`, `agent/mod.rs`, and
`tests/fulcrum_seams.rs`. **The first two are corrected at HEAD** — the third, `fulcrum_seams.rs`, is repaired
in its own section below. The two corrections are the kind a reader cannot re-derive from this checkout, so
they are recorded:

- `agent/web.rs` claimed `worker/core.rs` implements `RenderRequester`. `worker/core.rs` is **crate-owned**
  since T8/S8.2; the trait is the crate's own, and `RenderRequester` has zero desktop references. The real
  desktop-side fact: `render.rs` did NOT move, and the crate's `worker/core.rs` carries the impl.
- `agent/mod.rs` cited `crate::agent::fs_backend::canonicalize_lenient` and
  `crate::agent::codemode::engine::CODEMODE_MEMORY_LIMIT` as the reason its aliases exist. Neither
  spelling exists in this checkout — they are `fulcrum_core/src/fs_backend.rs` and
  `fulcrum_core/src/codemode/engine.rs`.

Both are verifiable as corrected: `git diff --stat main...HEAD` over `src-tauri/src/agent/web.rs` and
`src-tauri/src/agent/mod.rs` shows both files changed on this branch.

**A fourth false doc of the same class is STILL false, and was never touched by this branch.**
`src/lib/tauri/types.ts` names four desktop paths that do not exist at HEAD — they moved to `fulcrum-core` in
T5/S2 and T7. This close-out previously listed it as a *corrected* third item; that was wrong on both halves.
It is not one of the audit's three (its third is `tests/fulcrum_seams.rs`, handled above), and it was never
corrected — running `git diff --stat main...HEAD` against that single path prints **nothing**, because this
branch never opened the file. It is carried as open work (**item 8**), with its paths and content anchors,
because a reader who took the old wording on trust would believe a false doc in the tree had been repaired.
Do not read this section as three corrections.

**The general hazard:** after a package extraction, a module doc can be fluent, confident, and describe
files that are not in the repository. A doc that cites a path is a claim about the tree. This close-out
now demonstrates the second-order version of the same defect: **a close-out doc that claims a correction it
did not make is the same bug one level up**, which is why item 8 names the paths and the command that proves
them rather than simply re-asserting that the doc was fixed.

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
5. **ADR 0086's number section — the two defects this close-out used to carry are now FIXED in the ADR
   itself**, and the two documents agree. Both sections carried figures that had rotted: the "Honesty"
   bullet asserted **76 files / highest 0085** where `ls docs/decisions/ | wc -l` gives **82** and the
   highest number gives **0091**, and the corrected paragraph attributed the collision to a **skipped**
   `uniq -d` check. The clocks refute the causal claim: `fe2111de` 2026-10-30 09:09 (glossary, first add) →
   `4998a98f` 2026-10-30 16:13 (titling, #136) → `47432a38` 2026-10-31 13:02 (glossary re-add, #137). The
   first add predates the titling commit by ~7h on a branch that held no dupe, so the original probe was
   plausibly accurate and the collision materialised at the squash-merge onto a main that already carried
   #136 — a **merge-order** failure, not a skipped check. What remains open is only the residual the ADR
   itself states: **no instrument enforces ADR-number uniqueness at authoring time.** The `uniq -d` probe is
   a convention in `AGENTS.md`, not a guard, so the next collision ships exactly as this one did.
6. **Prose naming the old module path:** `src/store/sessions.ts` and `sessions.test.ts` still say
   `lib/sessionLifecycle.ts`; `src/lib/sessionLookup.ts` still says the store "does not export"
   `SessionsState`, which is false since the completeness pin needed it exported.
7. **Flakes.** Named: `provider_gcloud_adc.rs::env_override_beats_the_provider_flag` — failed one full run,
   green standalone 3×, green as a target 3×, green on the next 4 full runs; process-global
   `LITELLM_GCLOUD_TOKEN_AUTH` bleed under parallel harnesses. **Unnamed, flagged not assumed:** one
   post-change `cargo test --lib` reported `564 passed; 1 failed` with the `failures:` block cut by a
   `tail` pipe, so the name is lost; eight later runs were 565/0 and no `--lib` test reaches the wrapped
   code. Harness lesson: never pipe a first post-change test run through `tail`.
8. **A fourth false module doc — `src/lib/tauri/types.ts` is STILL false, untouched by this run.** This is
   NOT one of the audit's "three false docs" (its third is `tests/fulcrum_seams.rs`, repaired above); it is a
   fourth instance of the same class, and it is **not one of the 17 approved findings either** — no audit
   finding files it, which is precisely why nothing owned it and nothing fixed it. This close-out previously
   listed it as a corrected item, which is the defect this entry exists to undo. Four desktop paths it cites
   do not exist at HEAD; each moved into `fulcrum-core`. Prove the paths are gone with `find src-tauri/src -name
   subagent.rs -o -name manager.rs -o -name definition_permission.rs -o -name litellm_oauth.rs`, which
   prints **nothing**, and prove the file is untouched by running `git diff --stat main...HEAD` against that
   single path, which also prints **nothing**. Locate the sites by content, not by line number —
   `types.ts` is a live file and its line numbers move:

   | false path the doc cites | content anchor (search for this string) |
   |---|---|
   | `src-tauri/src/agent/worker/manager.rs` | `` `SubagentCapture` (`src-tauri/src/agent/worker/manager.rs`) reads the child's `` |
   | same path | `` Emitted by `dispatch_subagent` (`src-tauri/src/agent/worker/manager.rs`) on `` |
   | same path | `` (`src-tauri/src/agent/worker/manager.rs`), emits this event and nothing else. `` |
   | `src-tauri/src/agent/subagent.rs` | `` The Rust `AgentNameResolution` (`src-tauri/src/agent/subagent.rs`) over the `` |
   | same path | `` (`src-tauri/src/agent/subagent.rs`) serialised by serde `` |
   | `src-tauri/src/agent/definition_permission.rs` | `` // BYTE-FOR-BYTE mirror of `src-tauri/src/agent/definition_permission.rs`, and `` |
   | `agent/provider_auth/litellm_oauth.rs` | `` declared in `agent/provider_auth/litellm_oauth.rs` and re-exported by `` |
   | same file, short form | `` the Rust half (`cli_sso.rs` / `litellm_oauth.rs` parse the proxy's snake_case `` |

   Two other paths the same header cites are **genuinely still desktop and must NOT be rewritten**:
   `src-tauri/src/agent/session/router.rs` and `src-tauri/src/agent/session/mod.rs` both exist at HEAD — so
   a reader fixing this must go path by path, not blanket-replace the string `src-tauri/src/agent`. Where
   the moved thing now resolves through a desktop module alias rather than a file (`agent/mod.rs` re-exports
   `definition_permission` from the crate; `provider_auth/mod.rs` re-exports `litellm_oauth`), the honest
   wording names the crate file and notes the desktop alias that still addresses it — the same shape the two
   corrected headers above use. **Left open deliberately:** repairing it is outside this run's approved 17
   findings and outside its owned sets, and a TS-side edit here would be an unattributed drive-by. **Origin of
   the false claim:** the commit that landed this work says "fix three false docs", and that was **accurate** —
   it fixed the audit's three (`agent/web.rs`, `agent/mod.rs`, `tests/fulcrum_seams.rs`). What went wrong is
   one level later: this close-out transcribed the count "three" but **swapped which file filled the third
   slot**, listing `types.ts` where `fulcrum_seams.rs` belongs, and `types.ts` then read as fixed when nothing
   had opened it. That is the transferable failure — a count copied correctly while its referents are
   reconstructed from memory. The commit is pre-squash and will be orphaned, so do not go looking for it to
   correct it; correct the claim by fixing `types.ts`.

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
- **A count can be transcribed correctly while its referents are wrong.** This close-out shipped "three
  false module docs corrected" with the right number and the wrong third file, and the mis-set referent was
  a file nobody had opened. A number carried into a durable document owes its **list**, not just its total —
  and if the list is reconstructed rather than copied, re-derive each item against the tree before writing it
  down.
- **`docs/roadmap/` is gitignored, and the roadmap skill's "commit the plan docs" instruction conflicts
  with that.** The repo rule wins: plans and grounding reports stay untracked and must be `cp`'d into each
  worktree after `git worktree add`. Force-adding is what once shipped fourteen grounding-report files
  inside a PR. Untracked files here are unrecoverable — delete by explicit pathspec, and fold durable
  content here first. **Two caveats so this bullet is not over-read:** the ignore rule and the tracked
  reality coexist — `git ls-files docs/roadmap/` returns **2** legacy force-added files at HEAD (named at
  the top of this document) — so "the directory is disposable" is false even though "these plans are
  unrecoverable" is true. And `git check-ignore <path>` **exits 1 for an already-tracked path**, which reads
  exactly like "the rule is gone"; use `git check-ignore --no-index -v` (AGENTS.md records this trap against
  this very directory).

---

## Verified clean — recorded so the next audit does not re-spend it

Each item names the instrument behind it. Two of these figures were re-measured for this close-out and now
carry the command; the rest are the audit's figures, labelled as such.

- **No unused npm dependency** — the audit's figure (`shadcn` live via `index.css`'s `@import`,
  `@tauri-apps/cli` via `Makefile`).
- **Zero emitted-but-unqueried `data-testid`.** The audit reported **71 emitted / 71 queried**; that pair is
  a throwaway instrument's output at the audit's moment and is **not reproducible** as written. Re-measured
  at HEAD with a stated instrument: **51** unique literal `data-testid` values are *emitted* by non-test
  files under `src/`, **73** unique literal values are *queried* by test files (the `getByTestId` family plus
  `[data-testid=…]` selector strings), and the emitted-minus-queried set is **empty** — so the *conclusion*
  holds, at 51/73 rather than 71/71. The 22 queried-but-not-emitted values are test-fixture-authored ids, the
  same class the audit discounted as its "6 apparent orphans". **Two instrument bugs are worth naming, because
  both were hit while re-measuring and each manufactures a FALSE orphan:** (1) a `getByTestId`-only walk
  reports ~57 queried and calls **10** live ids orphans — all ten are reached *only* through
  `querySelector('[data-testid=…]')`, never through a testing-library query; and (2) a `git ls-files
  'src/**/*.test.tsx'` file list silently drops the one top-level test file `src/App.test.tsx`, which on its
  own manufactures `content-row` (and `chrome-bar`) as phantom orphans. Query both idioms, and enumerate test
  files with all four glob forms — `git ls-files 'src/*.test.ts' 'src/*.test.tsx' 'src/**/*.test.ts'
  'src/**/*.test.tsx'` (172 files, agreeing with `find src -name '*.test.ts*'`); the `.tsx`-only pair gives
  85 and the `**`-only form gives 171, and each drops a different real file. Separately, **66** is the count
  of unique literal `data-testid` values appearing *anywhere* under `src/` in a `data-testid="…"`/`={"…"}`
  spelling — a third, different figure for a third different question; name the question before quoting a
  number here.
- **Zero orphan `.rs`; zero `unreachable!()` / `todo!()` / `unimplemented!()`; zero real commented-out code
  blocks; production `#[allow(dead_code)]` both `cfg_attr`-gated with correct reasons** — the audit's
  measurements.
- **The IPC command surface is clean, and this one IS re-runnable: `bash scripts/check-commands.sh`** prints
  `ok   52 registered command(s), 51 consumed name(s) across 51 invoke literal(s) in 398 file(s); both
  directions agree, 1 allowlist exemption(s) cited`. That is the committed guard, and it reproduces the **52**
  figure exactly: 52 names registered in `lib.rs`'s `generate_handler!`, 51 consumed by a literal
  `invoke("name")` in `src/`, 1 allowlisted with a cited reason (`get_stalled_info`, consumed only from
  `src-tauri/tests/ipc.rs`). **A naive grep gets the same 52 for two wrong reasons that cancel**, which is a
  live demonstration of why the guard exists: it picks up `invoke("…")` from a prose comment in
  `src/lib/tauri.ts:37` (an extra name that is not a command) and it misses `get_stalled_info` (a real command
  the TS walk cannot see), so 51 real + 1 artifact = 52. The script strips comments and allowlists by name with
  a cited reason precisely to avoid that coincidence. The script's own header comment still cites the older
  46/45 tree — those are its **vacuity floors**, deliberately not current counts, so do not read them as a
  stale claim about the surface. All 52 are glossary-clean per the audit.
- **The 3 event names the audit called glossary-clean are the audit's figure** — no committed instrument
  owns an event-name naming count, and the owned vocabulary is larger than 3 anyway. `IPC_EVENTS` in
  `src/lib/ipc/events.ts` holds **13** names — 11 kebab-case Tauri events, plus the updater plugin's
  scheme-prefixed `update://progress`, plus `archimedes:insert-skill`, which is a `window` `CustomEvent` and
  not a Tauri event at all — frozen byte-for-byte by `src/lib/ipc/events.test.ts`. Read "3" as "the three the
  audited window introduced", which is the only reading the evidence supports.
- **The audited window's newest commits introduced zero vague names** (`data`/`info`/`item`/`payload`/`util`/
  `helper`) — the audit's figure.
- **After this run there are zero dead-entirely aliases in the five census-scope files** — derived from the
  prune, not re-measured; see the census section for why that figure is not reproducible here. Every
  falsification instruction in `fulcrum_seams.rs` names a file that exists, which is checkable by reading the
  file.

---

## Task → area map (what to read if something misbehaves)

| area | what changed |
|---|---|
| session lifecycle | inline tests moved to `agent/session/tests/`; `option_id` constants + `match`; two frozen-spelling pins; `with_catalog` deleted (its `catalog` FIELD is still read by `build()`) |
| boundary aliases | 51 dead-entirely `pub use` pruned across the five census-scope files; two of the audit's three false module docs corrected here (`agent/web.rs`, `agent/mod.rs`) and the third repaired in `fulcrum_seams.rs`; a **fourth** false doc, `src/lib/tauri/types.ts`, was never touched and is open work (item 8); `lib.rs` two dead items gone |
| wire contracts | `errors.rs` header + `SessionError::kind` public; four more config DTOs pinned; `fulcrum_seams.rs` falsification repaired |
| session store | `clearSessionState` write-set contract; session-keyed field enumeration pin; both retirement paths routed |
| frontend structure | `describe("ChatStream")` eliminated into subject-named blocks + a mention-picker file; `SpacesList` split three ways; `sessionLifecycle` moved to `store/`; new `src/lib/layerBoundary.test.ts` census |
| copy | `shadowHeading()` → Shadowing vocabulary in both dialogs; six assertions and six negative pins reconciled |
| rules / docs | AGENTS.md subject-count + lock-poison rules; ADR 0086's number section corrected twice — the probe's instrument, then the "76 files / highest 0085" figure and the collision's causal attribution |
| misc | `matchMedia` subscription shared (seed difference kept deliberately); `subagentSheetLayout` vacuity floor; two dead CSS tokens removed; `spaces.rs` canonicalize off the async executor |
