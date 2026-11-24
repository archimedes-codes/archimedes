# AGENTS.md

Archimedes Desktop — a cross-platform (Windows / macOS / Linux) Tauri 2 app
that runs coding agents in-process — the desktop's own Rust runtime is the
only Agent harness (a native session, ADR 0022). Rust backend (`src-tauri/`)
+ React 19 / TypeScript frontend (`src/`). See `CONTEXT.md` for terminology
and `docs/decisions/` for ADRs.

This file is the always-loaded half: the build bar, the conventions, and the
one-line form of every trap that changes how you work. **The evidence behind
those traps is in `docs/agents/` — read the linked file when the one-liner is
not enough, not before.** Splitting on "is this needed while writing code?"
keeps this file small enough to actually be read on every turn.

| File | Read it when |
|---|---|
| `docs/agents/flake-registry.md` | a test went red and the diff does not plausibly reach it |
| `docs/agents/test-counts-and-splits.md` | you are proving "no test was lost", or splitting a test region |
| `docs/agents/census.md` | you are about to quote a `grep -c` count of code |
| `docs/agents/file-size.md` | you are splitting a file, or about to change a size threshold |
| `docs/agents/repo-gotchas.md` | you are trusting `gh api`, `git check-ignore`, a cross-package move, or a `docs/roadmap/` deletion |
| `docs/agents/releasing.md` | you are cutting a release |

## Build & Testing

Everything validates from the repo root — the frontend with `pnpm`, the Rust
workspace with `cargo`. A branch is ready to merge when all of these are
green:

| What | Command | Where |
|------|---------|-------|
| Frontend unit tests | `pnpm test` | repo root |
| Frontend type-check + build | `pnpm build` | repo root |
| Rust tests | `cargo test` | repo root (the workspace) |
| Rust lint | `cargo clippy --all-targets` | repo root (must be 0 warnings) |
| Rust formatting | `cargo fmt --all -- --check` | repo root |

`make check` runs exactly this bar, in that order, fast-fail.

`pnpm build` is `tsc && vite build`, and `tsconfig.json` sets `noUnusedLocals:
true` — so an import left behind by deleting its last JSX use is a **build
failure** (`error TS6133: 'X' is declared but its value is never read`, exit 2;
measured with a throwaway file, not inferred).
There is no eslint / biome / prettier dependency, config file, or CI step, so
this is the FRONTEND's only unused-code gate — Rust's equivalent is `cargo
clippy --all-targets -- -D warnings` in the same CI job, a different language's
gate and not a substitute.

`tsc` is invoked plain, so it checks `include: ["src"]` — which DOES include
`src/**/*.test.ts` and `.test.tsx` — and it does NOT build the
`tsconfig.node.json` reference, so `vite.config.ts` is outside `pnpm build`
entirely: an unused local there is invisible. **When removing a component:
delete the block first, then re-grep each symbol it used before dropping the
import line** — the reverse order breaks the build mid-edit with no hint which
block still needed it.

`cd src-tauri && cargo test` is not a substitute for the root run, though the
old reason is now false: there used to be a second workspace member
(`crates/fulcrum-core`) that a member-scoped run would quietly skip, and the
crate is a **crates.io-pinned dependency** now, so this checkout has exactly ONE
member and the two commands run the same suite. **The crate's own tests are no
longer runnable from this repo at all** — they run in
`archimedes-codes/fulcrum`'s CI. What remains true is the discipline
underneath: a command that checks less than you think still exits 0, so read
what a run actually selected.

`cargo test -p fulcrum-harness` **fails here** with `package fulcrum-harness
cannot be tested because it requires dev-dependencies and is not a member of the
workspace`. That is correct, not a breakage: clone
`https://github.com/archimedes-codes/fulcrum` (or point `.cargo/config.toml` at
a sibling checkout — see `.cargo/config.toml.example`) and run `cargo test`
there.

When a change moves code between the two packages, what matters is test
**names**, not totals, and **any test count is compiler-derived or it is
wrong**. The instruments, the two ways a grep disagrees with them, and how to
prove a move lost nothing are in
`docs/agents/test-counts-and-splits.md`. The short form: enumerate with `cargo
test -- --list`, prove **loss = 0**, and never assert a total.

**The Rust compiler is pinned** in the repo-root `rust-toolchain.toml`, so plain
`cargo …` from the repo root (the workspace) is the pinned one — CI installs
from that same file rather than naming a version. Do not float it: a newer rustc
adds lints, and a lint CI hits that a local toolchain cannot see reddens `main`
unreproducibly.

**`@tauri-apps/cli` is pinned** to the exact `tauri` version in the repo-root
`Cargo.lock` for the same reason: the CLI *is* the bundler that writes the
AppImage/deb/dmg/NSIS artifacts, so a Rust-side Tauri bump must move it in the
same commit. A floated CLI changes shipped output — desktop entries, bundle
metadata — that no local build reproduces. The reason is live, not historical:
an older CLI exports the now-deprecated `STATIC_VCRUNTIME` (2.11.4 still does,
2.12.2 no longer does) and a newer `tauri-build` turns that into a
`cargo:warning=` (`tauri-build` 2.7.2, `src/lib.rs:939-941`). The skew is easy to miss because cargo replays a build
script's stored warnings from before the fix, so check the two versions rather
than trusting the warning.

The `pi-archimedes` monorepo (the agent-side extension suite, a separate repo)
is validated with `pnpm test` + `pnpm -r exec -- tsc --noEmit` from its root.

## Releasing

See **`docs/agents/releasing.md`** — the ceremony in execution order, including
the two skill-executable steps the `release` skill cannot derive on its own
(third-version-file bump, and the human pass over the release notes).

The three rules worth knowing before you open that file:

- **The version lives in THREE files** — `package.json`, `src-tauri/Cargo.toml`
  and `src-tauri/tauri.conf.json`. A bumping tool finds the first two; the third
  is Tauri's bundle version and it is the one the updater reads, so leaving it
  behind makes the updater see the previous release as "already newer".
  `scripts/check-versions.sh` fails any PR where the three disagree.
- **A `feat:` in the payload does NOT force a minor bump.** The level tracks
  whether the release is worth upgrading for, not commit subjects — a `feat`
  that adds no UI surface and changes no API may ship in a patch. `breaking!:`
  is the one thing that must force a major. When a payload looks minor- or
  major-sized, **ASK** before tagging: the tag is the irreversible half.
- **A draft is not a shipped release.** The updater endpoint
  (`/releases/latest/download/latest.json`) serves only a published,
  non-prerelease release, so `release.yml` publishes LAST.

The human-facing half — keypair creation, the two signing secrets, verifying the
keypair before tagging (a mismatch is **warn-only** in CI), unsigned local
builds, and the Linux DMABUF variables — is `README.md`'s `## Releasing`.

## Conventions

- **TDD**: write the failing test first, confirm it fails, then make it pass.
- **Squash-merge** feature branches into `main` (one commit per feature).
- **A poisoned mutex: recover when the lock guards independent per-key state,
  panic when it guards one shared resource.** The discriminator, not a
  preference: `unwrap_or_else(|p| p.into_inner())` when the guarded data is a
  map of independent per-key rows (one poisoned entry must not wedge the
  others), `.expect(…)`/panic when the lock guards a SINGLE shared resource a
  panic may have left genuinely unusable. **Both existing behaviours are
  correct and must not change.** The session registry recovers (see the comment
  block above its per-session state accessors in
  `src-tauri/src/agent/session/mod.rs`); the `storage/db/` unit panics because
  `Db` holds ONE `rusqlite::Connection` in a `StdMutex` and a panic
  mid-transaction can leave that single connection unusable. **No site count and
  no sibling count is quoted here, on purpose** — this file is loaded on every
  task, and the count moves whenever a verb is added — this branch's own
  guard/run-record commits added sites to it, and `docs/agents/census.md` keeps
  the dated provenance for the figures it has carried. Measure it when you need
  it, with the
  comment-anchored command `docs/agents/census.md` gives:
  `grep -rn 'expect("db mutex poisoned")' src-tauri/src/storage/db/*.rs | grep -vc '://'`.
  Name which spelling you ran. The two-stage grep prints a different number from
  the bare one (`… | wc -l`), because `grep -n` prefixes each line with
  `path:NN:` and a comment line that begins with `//` at column 0 therefore
  contains the substring `://` — so `grep -v '://'` drops exactly the per-file
  `WHY THIS FILE PANICS` headers that QUOTE the pattern, and keeps every real
  call site. That is also its limit: a quoted occurrence sitting in an INDENTED
  comment survives the filter and inflates the "production" figure, so the number
  is anchored, not proven production. **Any NEW
  panic-on-poison site must carry a one-line rationale for why its resource is
  single and shared** — `record_messages_batch` is the in-repo example. The
  arithmetic, the per-file split, and the way each grep disagrees are in
  `docs/agents/census.md`.
- **Keep files small: 600–800 code lines is the breakpoint, and the preference is
  to split, not to keep.** A file past that band is a **context tax paid on every
  read** — it swallows the window and gets `grep`'d instead of read, which is the
  failure this rule exists to prevent. **The default move is to extract, not to
  add:** put the seam in a small file (a trait / interface / types module that
  reads in one screen) and push the per-subject bodies into siblings named after
  their subject — `storage/db/` is the in-repo worked example (`seams.rs` 221
  holds the trait wiring, `board.rs` / `tasks.rs` / `stages.rs` / `messages.rs`
  hold the SQL, all 155–254), shipped as PR #215. In TypeScript the twin is
  `types.ts` plus one module per subject. **Split on a subject boundary** — that
  is still what makes a split *correct*, and size alone with no subject to
  separate is the one case not to split (`errors.rs` was deliberately left alone
  for exactly that reason). **Subject count still decides whether a split is
  DONE**: no `describe` / `#[cfg(test)]` block may hold more than ~25 unrelated
  tests (`docs/agents/test-counts-and-splits.md`). **The instrument is code
  lines** (comments/blanks stripped, inline `#[cfg(test)]` **counted**) — NOT raw
  LOC, which runs **40–60 % larger** on these files (code lines are 62–71 % of
  raw), so an editor showing 800 lines is ~520 code lines. `scripts/check-file-size.sh` enforces it as a **ratchet**:
  **production gate 800** (seed 700, `scripts/file-size-baseline.txt`), **test gate
  1,000** (seed 1,000, `scripts/file-size-baseline-test.txt`) — the test class keeps
  its own higher number because ADR 0112 chose it to close a *relocation* dodge, not
  as a size opinion. A baselined file may not grow by even **one** code line; a rise
  is a `--update` diff a reviewer sees, never a threshold someone edits. **So CI
  refuses at exactly the top of the band.** A red here is one of two things: a
  production file **over 800 code lines with no ledger entry** — split it by subject,
  do not add the entry — or a **baselined file that gained code lines**, which is a
  decision you justify in the PR body or undo. No test source is excluded,
  so a test region is governed **wherever it lives** — inline, in `foo/tests/`, or a
  `*.test.ts(x)` sibling — and the test-class gate is what closes the relocation
  dodge. Mirror naming per ADR 0113, test-class boundary per ADR 0112 (both in
  `docs/decisions/`, by filename). **Size is NOT a defect predictor** — fix density
  is non-monotonic (600–1000 worst at 2.61 fixes/kLOC, 1000+ better at 1.79),
  size↔churn is r = 0.057, and 0 audit findings attribute a defect to length.
  **Split for navigability and read cost, never because you think long means buggy.**
  Bands, the raw-vs-code conversion, and the threshold history: `docs/agents/file-size.md`.
- **Docs**: durable design decisions live in `docs/decisions/NNNN-slug.md`
  (ADR format); in-flight plans live in `docs/roadmap/<feature>.md` and are
  deleted on ship. Anything a roadmap records that must survive that deletion
  moves while the branch is still open — a durable fact or accepted defect goes
  to `docs/features/` (see `docs/features/mcp-known-gaps.md`) or an ADR, not to
  a comment in the plan.
- **Planning**: when expanding a roadmap task into a plan (`specify`), dispatch
  the `researcher` agent definition (`subagent` with `agentName: "researcher"`)
  rather than a config-less dispatch.
- **A plan that consumes a predecessor must tell the implementer to VERIFY it,
  not assert it.** When a wave plans all its tasks before any implementer runs,
  no predecessor has landed while the planners write — so "task A1 has landed"
  is false at planning time no matter what the orchestrator believes. Measured
  on `codemode`: two planners were told A1 had landed, and the one that checked
  and reported `DEVIATION:` at its own HEAD was right. Instruct
  verification-at-start and require a `DEVIATION:` report on mismatch.
  Related: `finish` deletes the plan family, so a plan that is ALSO a durable
  record must be copied out first.

### Working in this repo

- **`archimedes` is ONE compilation unit**, so a syntax error anywhere breaks
  every scoped `cargo test` run: two Rust implementation tasks can never share a
  wave. Read-only planning dispatches fan out freely. (Established with a
  planted error, not assumed.)
- **`cargo test --lib` does not rebuild `fake_worker`.** A stale
  `bin/fake_worker.rs` binary surfaces as `manager::tests` failing with
  misleading values after a protocol change; run `cargo build --all-targets`
  first when a fixture looks like it is lying.
- **`cargo check --target x86_64-pc-windows-gnu --all-targets` is the only local
  Windows proof** (the mingw target is installed). The msvc target needs
  `lib.exe` and there is no wine here, so `#[cfg(windows)]` code type-checks
  locally and only RUNS on CI's `windows-latest` leg — never describe Windows
  behaviour as behaviourally verified from this machine.
- **`TMPDIR` is not a usable workaround for temp-dir pressure in the Rust
  suite.** Two `commands::files` tests (`completion.rs`, `space_walk.rs`, via
  `assert_readdir_disagrees_with_sorted_order`) PANIC on unix unless the temp
  dir's `readdir` is unsorted — i.e. a tmpfs — because their "the survivors are
  the alphabetically first" assertion needs raw order to disagree with the sort.
  Two `sandbox` tests shell out to `TMPDIR=/tmp mktemp`, pinning `/tmp`
  explicitly. So pointing `TMPDIR` at a real disk fixes most tests and breaks
  those four. (Both halves re-measured, not copied from the plan that recorded
  them.)
- **A full `pnpm test` can report ~170 failed files and "no tests", and that is
  not a broken suite.** Here `/tmp` is a tmpfs shared with everything else on the
  machine, and vitest creates one jsdom environment per file, each needing temp
  space; when the tmpfs fills, every file dies at IMPORT time with
  `ENOENT: … open '/tmp/<rand>/client/<sha>'` and the summary reads `Test Files
  N failed (N) / Tests no tests`. The tell is **"0 tests ran"** — a real failure
  runs tests and names them. Check `df -h /tmp`, then
  `export TMPDIR=/some/dir/on/real/disk` **for the frontend command only** — a
  repo-wide export trades a green frontend for four red Rust tests (see the
  bullet above). No free-space threshold was measured, so do not encode one. A
  single test file re-run in isolation passes, so "it works alone" is the wrong
  conclusion. If this ever bites CI the honest fix is `pool: 'vmThreads'` /
  `isolate: false`.
- **A second cold Rust build in a sibling worktree is not affordable on this
  machine, so a wave's Rust child belongs in the PRIMARY checkout.** `target/`
  is ~150 G against ~13 G free on `/home`, and isolating the Rust child buys
  nothing anyway: two `cargo` runs against one shared `target/` serialize on
  cargo's build lock regardless. For a width-2 wave, put the Rust task in the
  primary tree and isolate the TypeScript one (`node_modules` is ~400 M from a
  warm pnpm store). The `trees-and-branches` invariant still holds: siblings
  share the object store, never the index. Check `df -h` before widening a Rust
  wave, and re-measure rather than trusting these figures.
- **Component rule: locate by content string, not by path.** When adding or
  verifying a component (a Rust module, a TS component, a test file), find it by
  its content signature — the `impl`, the trait name, the string literal —
  rather than by a hard-coded path. Paths move (the `harness` move from
  `src-tauri/` to `crates/fulcrum-core/` proved that twice), and content is what
  the claim is about, so locate by content and recompute the path at run time.
- **A boot fetch that `src/App.test.tsx` does not mock reddens tests that have
  nothing to do with it.** That file's `vi.mock("./lib/tauri")` factory spreads
  `importActual`, so an un-mocked export resolves to the real wrapper, which
  rejects outside a webview; the boot `Promise.all` rejects and its `.catch`
  swallows the reason. Measured by deleting one boot mock: **3 of the file's 41
  tests fail and only one names the fetch** — the other two are Settings /
  start-failure cases that merely need a booted store and fail on
  `activeSpacePath: null`. **When `App.tsx` gains a boot fetch, add its mock in
  the same commit.** (Only a minority of that file's tests need a booted store,
  so the blast radius is small but misleading.)
- **The suite's green depends on file order.** Many `describe` blocks in
  `src/store/sessions.test.ts` never call `resetStores()`, so they inherit
  whatever a previous block left in the store; under
  `npx vitest run src/store/sessions.test.ts --sequence.shuffle` some fail.
  Nothing runs shuffled (no `shuffle` in `vitest.config.*`, `package.json`, or
  CI), so `pnpm test` is legitimately green — but **a new test
  that asserts on store state must reset first**, or it can pass for a reason
  nobody intends. `src/App.test.tsx` is the extreme case: it never calls
  `resetStores()` and hand-writes `useSessions.setState({...})` key lists per
  test, so **when you add a store field, grep that file** rather than assuming
  the new field starts clean. `src/test/resetStores.ts` cannot reach
  module-`let` state, so a store module holding its own bookkeeping needs a
  named reset.
- **A red test whose subject the diff cannot reach is a known flake.** There is
  a registry of them, each with its evidence and its "re-run before
  investigating": **`docs/agents/flake-registry.md`**. Five are load- or
  timing-sensitive on CI across three OSes and have passed on re-run every time;
  none is a drive-by fix. **Re-run the job before investigating.**
- **`npx vitest run src/components` does NOT run
  `src/lib/toolDetailsRegistry.test.ts`**, the repo's main guard on the
  tool-details wire contract. CI is safe (its `pnpm test` has no path filter), so
  this is a LOCAL-GATE trap: a run that validates "the components" and reports
  green has not touched the registry. Run that file explicitly alongside the
  glob.
- **ADR numbers collide on disk, and a plan will confidently name one that is
  taken.** `0086` is used by two files — pre-existing. **Do not derive the
  number from a plan or from `max+1` alone**: the directory has gaps, so `max+1`
  avoids collisions but a gap-filler will not. **Verify against the DIRECTORY,
  not `git ls-files`** — two untracked neighbours have already held the numbers
  a tracked-only check declared free. After you pick, run
  `ls docs/decisions/ | grep -oE '^[0-9]{4}' | sort | uniq -d` and require that
  **your chosen number is not in its output**. Do NOT require the output to be
  empty: `0086` is already duplicated, so this prints `0086` on a perfectly
  healthy directory and an "expect nothing" gate can never be satisfied — a gate
  that always fails is worse than no gate, because it trains the next agent to
  wave the check off as broken noise and skip it. The rule is **no NEW
  duplicate**, not "no duplicate".
- **Run cargo from the repository root — the workspace.** A stray `cd src-tauri`
  no longer fails loudly; it silently builds one member. Before T4 there was no
  root `Cargo.toml`, so a backgrounded `cargo` with no `cd` died with `could not
  find Cargo.toml` and, at exit 101, masqueraded as a real test failure. **That
  failure mode is gone and a quieter one replaced it** — the root now holds the
  `[workspace]` manifest. Since T8b the workspace has ONE member, so a
  member-scoped run checks the same suite; what survives is the shape of the
  warning, because it reappears the moment a member is added. So write `cargo …`
  at the root, and **read the TEXT of a `cargo` failure before concluding a test
  flaked**: "could not find Cargo.toml" means the command never ran, and
  re-running it to confirm will simply fail again.
- **The engine is a SIBLING checkout, and the desktop does not build from it —
  so editing it and then testing here tests nothing.**
  `/home/daniel/Coding/Archimedes/fulcrum` (origin `archimedes-codes/fulcrum`)
  sits one directory from this repo (origin `archimedes-codes/archimedes`), and `.cargo/config.toml` is ABSENT here
  (only the `.example`), so `cargo tree -i fulcrum-harness` prints a bare
  `fulcrum-harness vX.Y.Z` with **no path suffix** — the build consumes the
  crates.io-pinned crate, never the sibling. Two silent (exit 0) hazards follow:
  an edit to the sibling followed by `cargo test` here reports green having
  tested none of that edit, and a shell with no `cd` inside a subagent commits
  into whichever of the two repos the session cwd happens to be. So a task
  spanning both says which repo each command runs in, run `git rev-parse
  --show-toplevel` before the first write and again before the first commit, and
  remember the engine's own tests are not runnable from here at all. Check
  `df -h` before deciding a sibling build is affordable.
- **Plans carry stale baselines within hours** on a busy branch: re-measure test
  counts at your own HEAD rather than trusting the plan's.
- **The squash-merge convention silently orphans the commit hashes the docs
  cite** — in durable prose, cite the **squash commit** or the **PR number**, and
  when a hash is the *evidence* for a claim, quote the text verbatim so the claim
  survives the object. The counts, the two instruments (and the reason `{7}` is
  blind to the 8-hex form `git rev-parse --short` emits) are in
  `docs/agents/repo-gotchas.md`.
- **`gh api` writes its error body to STDOUT, not stderr** — so `2>/dev/null`
  does not suppress a 404/422, and a `-n "$(...)"` truthiness test is **true for
  every failure**. Branch on exit status
  (`gh api … >/dev/null 2>&1 && …`), never on captured output.
- **Resolve a GitHub comment id from `issues/<n>/comments`, never from a
  repo-wide "latest"** — `gh api … /issues/comments` without an issue number
  returns the repo's newest comment, and a `PATCH` against it **destroys an
  unrelated human comment**, with no way back (GitHub stores only the current
  body). Echo the id and confirm its `html_url` points at the issue you meant.
- **A grounding report's silence is not a measurement of absence.** When a doc
  claims some case was "never measured", **read the primary source it is
  summarizing** — the issue body or comment — before writing that claim. A
  sub-claim resting on an upstream report's coverage is resting on someone
  else's completeness. (This shipped a wrong "unmeasured, not refuted" finding
  into a research doc and an ADR; it had been measured, and the flag lost — the
  opposite conclusion.)
- **Moving a file between the two packages breaks three things no path grep
  finds**: the orphan rule (E0117, invisible to every path-based audit),
  integration tests that lint source text by path, and `Path::is_file()` not
  appending `EXE_SUFFIX` where `CreateProcessW` does. All three, with the
  detection commands, are in `docs/agents/repo-gotchas.md`.
- **A pin that passes on the broken thing is worse than no pin**, and three
  shapes hide it — assert *equality* against a known-good root, scope a
  source-text scan to the function's own body, and remember that only a mutation
  that **still compiles** and changes what something **returns** tests
  behaviour. Worked examples in `docs/agents/repo-gotchas.md`.
- **Do not `git add -f` a file under `docs/roadmap/` — `cp` it into the sibling
  worktree instead.** The directory is gitignored and plan families are working
  memory, but an ignored, untracked file **does not exist in another worktree**,
  so a child dispatched at wave width ≥2 cannot read its own plan. The fix is
  `cp docs/roadmap/<feature>-taskNN-*.md <worktree>/docs/roadmap/` immediately
  after `git worktree add`. Force-adding is what produced a PR carrying 14 files
  of grounding reports beside a 4,500-line refactor. Untracked files there are
  **unrecoverable** (no `git checkout`, no stash, no dangling blob), so fold
  anything durable into `docs/features/` or an ADR FIRST, print the match list
  before the `rm`, and use the `finish` skill's cleanup loop rather than
  deviating from it.
- **`git check-ignore <path>` exits 1 for a path that is already TRACKED**,
  which reads exactly like "the ignore rule is gone" — trust
  `git check-ignore --no-index -v` instead. Likewise **`docs/roadmap/`'s ignored
  files do not appear in `git ls-files --others --exclude-standard`**; use
  `--others --ignored --exclude-standard` to see them. Two files in that
  directory have no durable copy in git at all — check for a durable home before
  deleting anything, because "it's gitignored" is not "it's disposable". All four
  details, with the measurement that produced each, are in
  `docs/agents/repo-gotchas.md`.
- **A green suite proves nothing about a `docs/roadmap/` deletion** — no test
  reads that directory. The proof is the directory count and the presence of the
  files that must survive.
- **The `docs/features/` front-matter does not parse as strict YAML** (the
  multi-line `verified-by:` value is missing its block-scalar indicator).
  Harmless today because nothing parses those fields programmatically; it becomes
  real work the moment a docs linter or generated index reads them, and then it
  should be one sweep across `docs/features/`, not a per-visit fix.
