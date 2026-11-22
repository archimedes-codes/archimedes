# Counting, moving and splitting tests

Read this when you are about to claim "no test was lost", or when you are about
to split a test region. Both activities have a wrong instrument that reports
success confidently, so the instruments are named here and no totals are.

**No total is recorded in this file on purpose.** A test count is correct only
for one commit, and every figure this file used to carry had already drifted by
the time it was next read. Run the instrument; do not trust a number.

## Count with the compiler, never with a grep

**Any test COUNT is compiler-derived or it is wrong, and the two ways a grep
disagrees point in opposite directions.** Measured on one file
(`crates/fulcrum-core/src/worker/manager/tests/mod.rs`): a loose grep for
`#[test` over-counted, an anchored `^\s*#\[test\]$` grep under-counted, and
`cargo test -- --list` agreed with the exact-form attribute count. The loose grep
over-counted because a doc comment mentioned the attribute in prose; the strict
grep under-counted because it misses an attribute that takes arguments. **Three
instruments, three answers, one authority.**

This has bitten a plan that "corrected" a correct count to a wrong one and then
had to be corrected back. Use `cargo test -- --list` and report which uniqueness
metric you used — `--list` gives **leaf-unique** or **full-path-unique**, and
they differ for two unrelated reasons.

## What `--list` cannot see

`--list` does NOT prefix test names with their target, so same-named tests in
DIFFERENT binaries are indistinguishable and dedupe to one line. Five such
collisions exist here: two `test_support::tests::*` names defined in **both**
packages (the deliberate `test_support` duplication — `archimedes` and
`fulcrum-core` each list the identical path), and three identically-named tests
in two integration targets each (`harness_store.rs` + `storage.rs` share two
scratch-leak tests; `harness_dispatch_native.rs` + `harness_subagent_worker.rs`
share one).

**Consequence: a workspace-level `--list` diff cannot see one of a colliding pair
vanish** — it survives on the other target's line. Not a blocker for the loss
check (the collision is symmetric and pre-existing), but do not claim a `--list`
diff proves per-target coverage.

Leaf names shared by many distinct full paths are what a desktop→crate MOVE
produces: the leaf survives, the path changes. (`pkce_challenge_is_the_s256_of_the_verifier`
alone was shared by three distinct full paths.) So a leaf-unique diff reads
"nothing lost" exactly when a full-path diff reads "everything churned".

## How to prove a move lost nothing

**Use leaf-unique to prove loss, and expect the full-path set to churn by 2× the
number of tests moved.** The assertion is **loss = 0**, never the total.

**A `comm`/`diff` census is only valid if BOTH inputs are normalised
identically.** `--list` prints `name: test`, so stripping the `: test` suffix
from one file and not the other makes every name read as BOTH deleted and added
— a confident, well-formed, meaningless result. Normalise both sides or neither.

## Splitting a test region: by SUBJECT, not by line ratio

**A test source is a GOVERNED SUBJECT, not blast radius.** `scripts/check-file-size.sh`
walks test files as their own class, gated and seeded at **1,000 code lines** with
their own ledger (`scripts/file-size-baseline-test.txt`) —
`docs/decisions/0112-the-size-ratchet-governs-test-sources-as-their-own-class-gated-at-the-same-1000-code-lines.md`.
That governs **size**; it does not change what decides a split, which is still the
subject count below. A test file over 1,000 is a `--update` diff a reviewer sees,
not on its own a thing to split.

**One `describe` / one `#[cfg(test)]` module = one subject, and >~25 tests in one
block is a tripwire to go find that boundary, not a number to satisfy.** The
trigger is **subject count**: no single block may hold more than ~25
**unrelated** tests. A block that crosses ~25 is a signal to go find where the
subjects actually divide — a 40-test block over ONE subject is fine; a 20-test
block that spans two is already wrong.

**Splitting a file without splitting the block relocates the problem** — a split
is done when no `describe` spans two subjects, not when the file count went up;
several subject-named `describe`s living in one file is a legitimate outcome and
costs no new mocks.

The shape that works is `mod tests;` + a `tests/` directory (e.g.
`src/foo/tests/mod.rs`), **not** a `tests.rs` sibling —
`find src-tauri/src -name 'tests.rs'` reports **0** sites. Once a production unit
is split, the test tree **MIRRORS** it: one `tests/` child per production child,
**same name**, `tests/mod.rs` stays a shell of `mod` declarations, and
`tests/support.rs` is the only non-mirror child
(`docs/decisions/0113-a-split-production-unit-gets-a-mirror-test-tree-one-tests-child-per-production-child.md`).
Locate the existing directory-shaped ones with `find src-tauri/src -type d -name
tests`, which
currently prints `commands/files/tests`, `commands/tasks/tests`,
`storage/db/tests`, `storage/batching/tests`, `agent/session/tests`. Do not trust
that list over the command: it has been under-counted before (three were named
while four existed, because `commands/tasks/tests` was never listed), so re-run
the find rather than quoting this.

Do **not** use the old trigger "split when the test body exceeds the production
body". The 2026-11-07 audit rejected it, and it **named no instrument for its own
tally**, so treat that as the audit's judgement, not a measurement you can
re-run. The judgement holds on its own terms: four files it lists (`errors.rs`,
`settings.rs`, `router.rs`, `refresh.rs`) have coherent tests over small
production bodies, so splitting them buys nothing. The deeper reason stands
regardless — a **file-level** ratio cannot name a block, so it is blind to the
hazard this rule exists to catch.

**A ratio is a different instrument from an absolute per-file threshold, and it
stays rejected.** What ADR 0112 introduced is the latter: one number, per file,
per class, no comparison to anything else. It **does not revive the ratio**, it
does not make "the test body is bigger than the production body" a trigger
anywhere, and nothing in it licenses splitting a test region by ratio. Read the
paragraph above as still in force, and read ADR 0112 as adding a size ratchet
beside it rather than replacing this.

## Citing and measuring

Cite oversized regions by **content** (a `describe` name, a module name, a test
title) — never by `file:line`, which decays as files move (this repo's rule:
match on the test name, never the line). Any branch that implements a split
invalidates every `file:line` citation in the finding.

**Count tests with the runner, not by grepping `it(`** — a grep undercounts
every `it.each`, because `vitest list` prints one template unexpanded instead of
its cases.

Instruments (re-run at your own HEAD):

```sh
# Rust: the authority for a count
cargo test -- --list

# Rust: which modules hold more than ~25 test attributes
git ls-files '*.rs' | xargs grep -cE '#\[(tokio::)?test\]' | awk -F: '$2+0>=25 {print $2"  "$1}' | sort -rn

# Frontend: candidate blocks over ~25, by file and describe
npx vitest list | awk -F' > ' 'NF>=3 {print $1" || "$2}' | sort | uniq -c | sort -rn

# Frontend: one file's blocks
npx vitest list src/components/<File>.test.tsx | awk -F' > ' '{print $2}' | sort | uniq -c | sort -rn | head -1
```

## The discriminator made concrete — cases the rule PERMITS

- `src/components/ChatStreamMentionPicker.test.tsx`'s
  `describe("ChatStream — the mention/file-completion pickers (ADR 0031/0033)")`
  holds ~60 tests over **ONE subject** (the `$`/`@`/`#`/`?` pickers and their
  geometry). Far over 25 and correct — do not split it.
- `ChatStream — out-of-Space Directory completion (ADR 0035)` reads as ONE
  subject — every title is a `?`-completion behaviour — so it is permitted too.
- `ChatStream.test.tsx` after its split is the counter-example and the proof the
  rule is achievable: every block there is subject-named, and its largest is
  `describe("ChatStream — the compaction indicator (ADR 0045)")`.

## Known live violations of the rule

Measure each yourself; each holds several subjects in one block, which is exactly
the shape the rule says to split. Naming them is the point — a rule with unlisted
exceptions reads as unenforced. **This list is verified but NOT exhaustive**: the
candidate set is every block over ~25, and only a read of the test titles decides
whether a candidate crosses subjects.

- `src/components/SpacesList.test.tsx`'s `describe("SpacesList (archive, ADR
  0016)")` — Stop-closes-session semantics, the archive flag itself,
  hover-action click swallowing, the Archived section's
  collapse/ordering/empty-state, unarchive, and the collapsed rail's marks and
  icons.
- ~~`src-tauri/src/storage/db/tests/mod.rs` — one flat module, no inner
  grouping, over at least the sessions, tasks, spaces, board, artifacts and
  message-record subjects.~~ **FIXED — see the section below the list.**
- `src-tauri/src/agent/session/naming.rs`'s `#[cfg(test)] mod tests` — excerpt
  construction, quote/whitespace trimming, title capping (incl. multi-byte),
  reasoning-level forwarding, and composed-key resolution.
- `src-tauri/src/agent/session/tests/mod.rs` — flat, no inner grouping, across
  session-id format, `SessionInfo` serialisation, settings push,
  compaction/cancel, titling on close, resume semantics and more. **This is the
  rule's own cautionary tale in its current form**: it was moved into the correct
  *shape* but not split, so the navigation hazard survived the move — a completed
  move, not a completed split.

Candidates to inspect rather than assume (each reads as plausibly one subject or
several — read the titles): `SidePane (the status panel)`,
`MessageList scroll behavior`, `chatAttachments`. In Rust, `config.rs` is a
Rust-side candidate by the same instrument.

### Mirror status (ADR 0113) and the size class (ADR 0112), separated

The three instruments are different and a unit can fail one and pass another, so
they are named separately here — conflating them is how `storage/batching.rs` has
been mis-cited as a mirror violation.

- **`storage/db/tests/` — compliant, and it is the worked example.** Its
  `tests/mod.rs` is now 12 code lines of `mod` declarations and nothing else, one
  child per production sibling
  (`db/tests/{artifacts,board,messages,migrations,open,rows,sessions,spaces,
  stages,tasks}.rs` plus `support.rs`), mirroring the ten-subject production
  split. Its largest child, `db/tests/sessions.rs`, is 1,086 code lines / 30
  tests: **over** ADR 0112's test gate, so it is ledgered in
  `scripts/file-size-baseline-test.txt`, and it is **not** a subject-count
  violation — those 30 tests hold one subject (session persistence), which the
  ~25 rule permits. Ledgered, not exempted: adding a line there is a `--update`
  diff a reviewer sees.
- **`agent/session/tests/` — still a violation, on both instruments.** One flat
  `mod.rs`, 3,178 code lines (over the gate, ledgered) with zero inner `mod`
  declarations, against production children `naming.rs`, `router.rs` and
  `naming/prompt.rs`. It has its own card; it is not `db`'s fix to make.
- **`storage/batching.rs` — a subject-count violation, NOT a mirror violation.**
  One production file with one `tests/mod.rs`, so the mirror is trivially
  satisfied; its 1,079 test code lines over ~30 test attributes are the subject
  count problem and a governed size. Do not cite it as a mirror failure.
- **`agent/session/naming.rs`'s inline `#[cfg(test)] mod tests`** is the shape
  ADR 0112 exists to make visible: 1,680 of that file's 2,007 code lines are the
  inline region, so it is governed **wherever it sits** — inline today, and if it
  were relocated it would be caught by the test gate instead.

## Historic, and deliberately unreproducible

Oversized blocks that were **dissolved**, kept so the claims above are traceable
rather than invented. Their numbers are provenance, tied to the commit that fixed
them — this is the one place a figure is meaningful, because an instrument that
printed it against the pre-fix tree prints nothing against HEAD.

- `describe("ChatStream", …)` in `src/components/ChatStream.test.tsx`: 3,483
  lines / 149 `it(`, i.e. 152 runtime tests once its one 3-case `it.each` is
  expanded (the review's "~157 tests" overcounts; its "4,156 raw lines, 162
  `it`s" for the whole file is exact), over ~8 subjects. The audit measured
  4,156 test lines over a **710-line `ChatStream.tsx`** — and that ratio pointed
  at the FILE, never at a block, which is the whole reason the ratio trigger was
  rejected. Dissolved by **`6690966d`**, which moved the mention-picker cluster
  to its own file. Both the `it(`-count instrument and
  a brace counter now print nothing against the current file, and `grep -n
  '^describe(' src/components/ChatStream.test.tsx` finds no
  `describe("ChatStream",` at all. Reproduces only against `6690966d^`.
- `describe("SpacesList")` in `src/components/SpacesList.test.tsx`: 37 `it(`,
  now 16 — the Agents-modal cluster left for `SpacesList.agents.test.tsx` in
  **`650bfe55`**.
- `mod session_tests` in `src-tauri/src/agent/session/mod.rs`: 71 test
  attributes. That module **no longer exists anywhere**; **`936dcafe`** moved it
  to `src-tauri/src/agent/session/tests/mod.rs`. Its anchors
  `fn mint_session_id_format()` and
  `fn session_manager_builder_cyclic_weak_reference_drops_cleanly()` still exist
  — **in `tests/mod.rs`, not `mod.rs`**.
