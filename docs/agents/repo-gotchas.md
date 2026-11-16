# Repo gotchas

Traps that have each cost a run real time. Read this when you are about to trust
the output of `gh api`, `git check-ignore`, a file move between the two packages,
or a `docs/roadmap/` deletion.

`AGENTS.md` keeps a one-line statement of the ones that change how you work; this
file carries the evidence, the wrong answer each instrument gives, and the
re-runnable check.

- **The squash-merge convention silently orphans the commit hashes the docs cite.**
  `docs/decisions/` + `docs/features/` cite **52** distinct 7-hex tokens that resolve to
  commits; **17** are unreachable from `main`, and **10** of those resolve nowhere at all —
  not locally, not on GitHub. Measured at `6f501ab`, re-runnable as:
  `git grep -hoE '\b[0-9a-f]{7}\b' -- docs/decisions docs/features | sort -u` then keep each
  token where `git cat-file -e "$h^{commit}"` succeeds and
  `git merge-base --is-ancestor "$h" HEAD` fails. The cause is structural, not neglect: the
  convention above lands one squash commit, so every per-issue commit the branch described
  becomes unreachable the moment the branch is deleted. Seven of the seventeen still resolve
  because GitHub keeps `refs/pull/N/head` after the branch is deleted — **but only if you have
  fetched those refs** (`git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`), so
  they are unresolvable in a normal clone, which is what a reader has. Worse case seen live: a
  **dangling stash-commit** cited as forensic evidence is local to one machine and dies to
  `git gc`'s default two-week prune. So: in durable prose, cite the **squash commit** (or the PR
  number) rather than the per-issue hash, and when a hash is the *evidence* for a claim — "this
  shape existed and was wrong" — **quote the text verbatim** so the claim survives the object.
  `AGENTS.md` itself was the source of this trap: it told the run to squash, and the docs it
  inherits already cite pre-squash hashes.
  **And the instrument above is under-counting, by construction: `[0-9a-f]{7}` with `\b` on both ends
  matches EXACTLY seven hex characters, so it is blind to every 8-hex citation — and 8 is what `git
  rev-parse --short` emits in this repo (`git rev-parse --short HEAD` → 8 chars), so 8-hex is the form
  `git log --oneline` hands a writer, meaning the docs are being fed the form this regex cannot see.**
  Measured on the same tracked set both ways (`docs/decisions` + `docs/features`, this worktree, kept =
  resolves AND is not an ancestor of `HEAD`, identical normalisation on both sides):
  `\b[0-9a-f]{7}\b` → **113** resolve / **71** kept; `\b[0-9a-f]{7,8}\b` → **144** resolve / **91** kept.
  So **31 citations that resolve, and 20 of the kept-orphan class, are invisible to the command as
  written** — which is also why the four 8-hex #155 hashes removed from the #155 docs on 2026-11-15 move
  neither figure above: they are invisible to `{7}` by definition. Under `{7,8}` the same removal takes the
  distinct-token count from **174** (at `HEAD`) to **170** (this worktree) and the resolving count from
  **148** to **144**, while the kept-orphan count stays **91** — correct, since those four are still
  ancestors of `HEAD` and only become orphans at the squash. Use `{7,8}` when you re-measure; the numbers in
  the paragraph above are the `{7}` figures at their stated commit and are left as recorded.
- **`gh api` writes its error body to STDOUT, not stderr.** So `2>/dev/null` does not suppress a
  404/422, and a `-n "$(...)"` truthiness test is **true for every failure** — a loop built that
  way reported "all 11 commits present on GitHub" for 11 commits that were all absent. Branch on
  exit status (`gh api … >/dev/null 2>&1 && …`), never on captured output. Hit live while
  measuring the bullet above; the wrong answer was confident and well-formed.
- **`gh api … /issues/comments` without an issue number returns the REPO-WIDE latest comment, and a
  PATCH against it destroys an unrelated human comment.** Hit live: to fix a typo in a comment just
  posted on #155, the id was fetched with `--jq '.[-1]'` on the repo-wide list rather than from
  `issues/<n>/comments`, which returned a 2026-10-17 comment on #35 — and the `PATCH` overwrote it.
  **GitHub stores only the current body**, so the original is unrecoverable: the API, the issue
  timeline, and search all return the post-overwrite text. Two things saved the content: the comment
  said it was a *mirror* of a doc, and that doc survives in a **reachable** squash commit
  (`git show f8450d42:docs/roadmap/…`). Note the mirror was ~9 KB of a ~23 KB doc, so it was
  **condensed** — the restore is the full source plus a provenance note, not a verbatim recovery, and
  saying so is part of the fix. The discipline: resolve a comment id from
  `issues/<n>/comments` (issue-scoped), or echo the id you are about to PATCH and confirm its
  `html_url` points at the issue you meant. Never derive an id from "latest" or from a repo-wide list.
- **A grounding report's silence is not a measurement of absence.** On this same run, the report for
  the Windows-console area never mentioned the reporter's §3 headline (`CREATE_NO_WINDOW` +
  `start "" cmd /c` → 3/3 visible), so the implementer concluded the harness had *never run* that
  combination, the reviewer praised the resulting caveat as exemplary, and it shipped into a research
  doc and an ADR as "unmeasured, not refuted". It was measured, and the flag **lost** — which is the
  opposite finding and changes what the fix has to be (root suppression goes from candidate to
  required; job-object reaping is confirmed to fix *lingering* only). When a doc claims some case was
  "never measured", **read the primary source it is summarizing** — the issue body or comment, here
  `gh issue view <n> --json comments` — before writing that claim. A sub-claim resting on an
  upstream report's coverage is resting on someone else's completeness.

These are properties of the repo, not of any branch:

- **`npx vitest run src/components` does NOT run `src/lib/toolDetailsRegistry.test.ts`, and the
  file's own tests are the repo's main guard on the tool-details wire contract.** Measured at
  `cb28abd0`: that glob matches 78 files and the registry is not among them. CI is safe — its
  `pnpm test` is `vitest run` with no path filter, so it does cover the file — so this is a
  LOCAL-GATE trap, not a coverage hole: a run that validates "the components" and reports green
  has not touched the registry, and a producer/reader key change it would catch goes untested.
  Run the file explicitly alongside the components glob.
- **Moving a file between the two packages breaks three things that no path grep finds.** The crate
  extraction (T5–T8, **13 sub-commits**: S1–S5b, S7.1–S7.2, S8.1–S8.5) hit each of these repeatedly:
  1. **The orphan rule (E0117) is invisible to every audit that works on paths.**
     `impl From<&BudgetFacts> for Vec<ProviderBudgetDto>` compiled for its whole life while
     `BudgetFacts` was desktop-local; moving that type into `fulcrum-core` made BOTH the trait
     (`From`) and the `Vec<…>` target foreign, so the impl became illegal and had to be rewritten as
     a function (`commands/settings.rs::budget_rows`). Coherence depends on **where a type lives**,
     so no `crate::X::` census, boundary pin, or `Cargo.toml` diff predicts it — only rustc does.
     Before a move: `grep -n '^impl .* for ' <file>` and flag any impl whose Self type AND target
     type are both foreign.
     The two traps that proved it: `CARGO_MANIFEST_DIR.parent()` and the
   `settings.json` pin.

2. **Integration tests that read SOURCE TEXT by PATH break, and they are not symbol references.**
     `tests/provider_gcloud_adc.rs` and `tests/provider_oidc.rs` lint `gcloud.rs` / `oidc.rs` by
     `read_to_string`, so a move reddens them with no compile error anywhere. **A plan's "zero edits
     under `src-tauri/tests/`" claim is wrong the moment a moved file is text-linted** — enumerate
     with `grep -rn CARGO_MANIFEST_DIR src-tauri/tests | grep -E 'join|read_to_string'` and open
     every hit. Cross-package source reads are legal (an integration target reads files, not
     symbols — no cycle), so the fix is a `../crates/…` path, matching the `mcp/callback.rs`
     precedent. **Then check any vacuity floor in that lint: scanning one directory after the split
     would pass GREEN having opened 3 of 9 files.**
  3. **`Path::is_file()` does not append `EXE_SUFFIX`; `CreateProcessW` does.** A fixture resolver
     returning a suffix-less `fake_worker` SPAWNS fine on Windows and fails an existence witness —
     so the bug is invisible until a test *observes* the file instead of exec'ing it. Both
     `worker/client.rs` and `worker/manager/tests/mod.rs` carried it and only CI's Windows leg saw
     it; `test_support::fixture_bin()` now owns the name (suffix as a **parameter**, so the rule is
     assertable on Linux, where `EXE_SUFFIX` is `""` and reading the constant would pass vacuously).
     Keep `target_debug_dir()` **directory-only**: appending the suffix there
     would break every caller that joins a directory and then supplies its own file name. The `mcp`
     spawners are unaffected by the missing suffix precisely because they hand the path to a
     `Command` and never OBSERVE the file (`grep -c is_file` over their `fake_mcp_stdio` sites: 0) —
     `CreateProcess` fills the suffix in. **Note the residual gap the helper itself records: those
     `mcp` spawners have no vacuity guard of their own, so only
     `childproc::target_debug_dir_is_where_cargo_actually_builds` stands between a wrong root and a
     silently-green suite.**
- **A pin that passes on the broken thing is worse than no pin, and three shapes hide it.** Measured
  live during the extraction: (a) a fixture path asserting `starts_with(pkg_root.parent())` **and**
  `!starts_with(pkg_root.join("target"))` — **both true of the wrong path**, so it printed "verified"
  while ~45 spawners would hit `ENOENT`; assert **equality** against the known-good root instead.
  (b) A file-wide `contains` on a parameter's signature text, satisfied by a *different* function
  with an identically-typed parameter — scope the scan to the function's own body. (c) **A seam can
  be fully wired and return nothing:** deleting a shell helper proves it is *instantiated*
  (`E0425`), but making its `providers()` return `Vec::new()` compiles clean and silently changes
  behaviour. Only a mutation that **still compiles** and changes what something **returns** tests
  behaviour — so to falsify a source-text lint, hoist a value into a local rather than deleting it
  (a non-compiling mutation never reaches the lint: two attempts died as `E0433`/`E0425` first).
  Aim at least one break at each NEW assert, not only the thing you already know about.
- **Do not `git add -f` a file under `docs/roadmap/` to get it into a sibling worktree — `cp` it there.**
  The directory is gitignored (`.gitignore:36`, the `docs/roadmap/` entry — locate by that string,
  the number moves whenever a rule is added above it) and plan families are working memory: they belong
  on disk, not in a PR. But **an ignored, untracked file does not exist in another worktree** —
  measured: a fresh untracked `docs/roadmap/ZZ-probe-untracked.md` in the primary tree read
  ABSENT from both sibling worktrees, while a committed one read PRESENT in both. That is the
  whole reason the force-add keeps happening: `roadmap` Step 4 says "Commit the plan docs", and at
  wave width ≥2 a child dispatched into its own worktree cannot read its own plan unless the plan
  is tracked. So the instruction and the ignore rule are in genuine conflict, and the run resolves
  it by force-adding — hit live twice: a 6-wave run force-added 14 files across 6 commits and the
  PR carried 14 files of grounding reports beside a 4,500-line refactor, every one committed with
  a message that read like a deliverable ("docs: plan … wave 4"), which is what hid it.
  **The fix is `cp docs/roadmap/<feature>-taskNN-*.md <worktree>/docs/roadmap/` immediately after
  `git worktree add`** — measured: the copy reads PRESENT to the child, does not appear in
  `git status` there, and does not propagate back to the primary tree. Serial (width-1) waves need
  nothing, because the planner and the implementer already share one tree.
  Some files in the directory ARE tracked — `git ls-files docs/roadmap/` returns a small legacy
  residue from runs that force-added them — so the directory is not uniformly disposable and the
  count is a moving number. That residue is what to clean up, never the pattern to copy. Untracked
  files here are unrecoverable — no `git checkout`, no stash, no dangling blob, because git never
  held them — so delete a shipped plan family by explicit pathspec, print the match list before the
  `rm`, reconcile the count, and **fold anything durable into `docs/features/` or an ADR FIRST**.
  The `finish` skill's cleanup loop names `${FEATURE_NAME}`-prefixed files only, which is the right
  shape — the failure mode is deviating from it, or force-adding so there is more to lose.
- **`git check-ignore <path>` exits 1 for a path that is already TRACKED, and that
  reads exactly like "the ignore rule is gone".** Measured live: an agent verifying
  `docs/roadmap/` ran it, got exit 1, and reported "docs/roadmap/ is NOT gitignored" —
  while `git check-ignore --no-index -v` prints `.gitignore:36:docs/roadmap/` and exits
  0. The legacy tracked leftovers in that directory are in the index, so the naive form
  reports nothing for exactly those paths. The wrong conclusion is
  expensive here specifically: it makes the bullet above sound stale and the unrecoverable
  files look recoverable. Trust the `--no-index` form.
- **`docs/roadmap/`'s ignored files do not appear in
  `git ls-files --others --exclude-standard` — use `--others --ignored --exclude-standard`
  to see them.** A count built with `--exclude-standard` reports 0 untracked in a directory
  whose every untracked file is ignored by construction, which is the same false "nothing
  to lose" reading as the bullet above, reached from the other direction. Measured at the
  #139/#138 ship: `--exclude-standard` said 0, `--ignored` named
  `issue-91-fetch-hidden-window-follow-ups.md`, and `git log --all` on that path is empty —
  git has never held it.
- **The `docs/features/` front-matter does not parse as strict YAML** — the multi-line
  `verified-by:` value is missing its `|`/`>` block-scalar indicator, so PyYAML raises a
  `ParserError`. Two agents on unrelated files hit it independently and both confirmed it
  fails identically *before* their edit: it is pre-existing across these docs, not
  something a branch introduced. Harmless today because nothing parses those fields
  programmatically — the one test that reads `docs/features/` is
  `src/lib/subagentSheetLayout.test.ts`, and it reads the body, not the front-matter. It
  becomes real work the moment a docs linter, staleness bot, or generated index reads
  `status:` / `last-verified:` / `verified-by:` with a parser, and then it should be one
  sweep across `docs/features/`, not a per-visit fix.
- **Two files in `docs/roadmap/` have no durable copy in git** (measured, not
  assumed): `permissions-section.md` is issue #112's approved spec and its only
  in-repo copy — recover it from #112's issue comments, which mirror it — and
  `issue-91-fetch-hidden-window-follow-ups.md` records the human sign-off that
  closes #91 (its durable content is in the tracked
  `docs/features/window-state-render-webviews.md`, so that one is a
  reconstruction, not a loss). Check for a durable home before deleting anything
  in there; "it's gitignored" is not "it's disposable".
- **A green suite proves nothing about a `docs/roadmap/` deletion** — no test
  reads that directory. The proof is the directory count and the presence of the
  files that must survive. (The one doc-scanning test is
  `src/lib/subagentSheetLayout.test.ts`, and it reads `docs/features/`.)

## ADR numbers collide on disk

`0086` is used by TWO files — `0086-glossary-names-govern-new-code-and-are-repaired-on-touch-not-by-sweep.md`
and `0086-two-stage-async-session-titling-with-wire-isolation.md`. Measured at `9cb94746`:
`ls docs/decisions/ | grep -oE '^[0-9]{4}' | sort | uniq -d` prints `0086`, and the directory held 81
files under 80 distinct numbers. It is still the only collision, but the instrument is what matters,
because **a plan that names the next number is wrong more often than it is right.**

The `codemode` spec said `0088`, then "corrected" itself to `0087`, and BOTH were already taken — so the
shipped ADR is `0089`. Do not derive the number from a plan, and do not trust `max+1` on its own: the
directory has gaps (0001–0089 held 80 distinct numbers, so 9 are missing), so `max+1` avoids collisions
but a gap-filler will not. The check that matters is `uniq -d` run AFTER you pick, not before.

**Verify against the DIRECTORY, not against `git ls-files`.** At `e0f3811e` a plan checked `0101` free
against the tracked set and was right at that moment, while two UNTRACKED neighbours (`0101`, `0102`,
from a concurrent in-flight design) already held those numbers on disk. The collision lives on disk, so
a tracked-only check cannot see it; the shipped ADR became `0103`. `ls docs/decisions/` reads both sets,
`git ls-files docs/decisions/` reads one.

## Moving a file between the two packages

The crate extraction hit each of these repeatedly.

1. **The orphan rule (E0117) is invisible to every audit that works on paths.** An `impl` compiled for
   its whole life while its type was desktop-local; moving that type into the crate made BOTH the trait
   and the target type foreign, so the impl became illegal and had to be rewritten as a function. Before
   a move: `grep -n '^impl .* for ' <file>` and flag any impl whose Self type AND target type are both
   foreign. Only rustc predicts this.
2. **Integration tests that read SOURCE TEXT by PATH break, and they are not symbol references.**
   `tests/provider_gcloud_adc.rs` and `tests/provider_oidc.rs` lint `gcloud.rs` / `oidc.rs` by
   `read_to_string`, so a move reddens them with no compile error anywhere. Enumerate with
   `grep -rn CARGO_MANIFEST_DIR src-tauri/tests | grep -E 'join|read_to_string'` and open every hit.
   Cross-package source reads are legal, so the fix is a `../crates/…` path. **Then check any vacuity
   floor in that lint** — scanning one directory after a split can pass GREEN having opened 3 of 9 files.
3. **`Path::is_file()` does not append `EXE_SUFFIX`; `CreateProcessW` does.** A fixture resolver
   returning a suffix-less name SPAWNS fine on Windows and fails an existence witness, so the bug is
   invisible until a test *observes* the file instead of exec'ing it. `test_support::fixture_bin()` owns
   the name now (suffix as a **parameter**, so the rule is assertable on Linux). Keep
   `target_debug_dir()` **directory-only** — appending the suffix there breaks every caller that joins a
   directory then supplies its own file name.
