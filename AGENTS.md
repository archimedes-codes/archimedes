# AGENTS.md

Archimedes Desktop — a cross-platform (Windows / macOS / Linux) Tauri 2 app
that runs coding agents in-process — the desktop's own Rust runtime is the
only Agent harness (a native session, ADR 0022). Rust backend (`src-tauri/`)
+ React 19 / TypeScript frontend (`src/`). See `CONTEXT.md` for terminology
and `docs/decisions/` for ADRs.

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

`cd src-tauri && cargo test` is not a substitute for the root run — though since
T8b/S8b.4-part-3 the reason has changed, and the old reason is now FALSE. There
used to be a second workspace member (`crates/fulcrum-core`) that a member-scoped
run would quietly skip; the crate is a **rev-pinned git dependency** now, so this
checkout has exactly ONE member and `cd src-tauri && cargo test` runs the same
suite as the root. **The crate's own ~1400 tests are no longer runnable from this
repo at all** — they run in `archimedes-codes/fulcrum`'s CI. What remains true is
the discipline underneath: a command that checks less than you think still exits 0,
so read what a run actually selected.

Concretely, `cargo test -p fulcrum-core` **fails here** with
`package fulcrum-core cannot be tested because it requires dev-dependencies and is
not a member of the workspace`. That is correct, not a breakage: to test the engine,
clone `https://github.com/archimedes-codes/fulcrum` (or point `.cargo/config.toml`
at a sibling checkout — see `.cargo/config.toml.example`) and run `cargo test` there.

When a change moves code between the two packages, the check that matters is test
**names**, not totals — a moved test that silently disappears leaves the total
looking plausible. Enumerate them with `cargo test -- --list`; do
**not** grep the sources for `#[test]`, because a source grep counts
`#[cfg(windows)]`-only tests that never reach the compiler on Linux (measured: 6
too many), so a grep-based "no test lost" is confidently wrong.

**Any test COUNT is compiler-derived or it is wrong, and the two ways a grep
disagrees point in opposite directions.** Measured on one file
(`crates/fulcrum-core/src/worker/manager/tests/mod.rs`): a loose grep for
`#[test` reported **31**, a strict `^\s*#\[test\]$` grep reported **29**, and
`cargo test -- --list` reported **30** — which is also the exact-form attribute
count (7 `#[test]` + 23 `#[tokio::test]` + 1 `#[tokio::test(flavor = …)]`). The
loose grep over-counted because a doc comment at `:2650` mentions `#[tokio::test]`
in prose; the strict grep under-counted because it misses an attribute that takes
arguments. **Three instruments, three answers, one authority.** This bit a plan
that "corrected" a correct count to a wrong one and then had to be corrected back.
Report which uniqueness metric you used — `--list` gives **leaf-unique** or
**full-path-unique**, and they differ for two unrelated reasons. Measured at
the tip of PR **#158**: **2226** listed, **2221** full-path unique, **2215**
leaf-unique (cited by PR number, not the head SHA, per the squash-orphan rule below).
- **2226→2221: `--list` does NOT prefix test names with their target, so same-named
  tests in DIFFERENT binaries are indistinguishable and dedupe to one line.** Five such
  collisions: two `test_support::tests::*` names defined in **both** crates (the deliberate
  `test_support` duplication — `archimedes` and `fulcrum-core` each list the identical path),
  and three identically-named tests in two integration targets each (`harness_store.rs` +
  `storage.rs` share two scratch-leak tests; `harness_dispatch_native.rs` +
  `harness_subagent_worker.rs` share one). **Consequence: a workspace-level `--list` diff cannot
  see one of a colliding pair vanish** — it survives on the other target's line. Not a blocker
  for the loss check (the collision is symmetric and pre-existing), but do not claim a `--list`
  diff proves per-target coverage.
- **2221→2215: 5 leaf names shared by 11 distinct full paths**
  (`pkce_challenge_is_the_s256_of_the_verifier` alone has 3), which is what a desktop→crate MOVE
  produces — the leaf survives, the path changes. So a leaf-unique diff reads "nothing lost"
  exactly when a full-path diff reads "everything churned".

**Use leaf-unique to prove loss, and expect the full-path set to churn by 2× the number of tests
moved.** The assertion is **loss = 0**, never the total.

**Split a test region by SUBJECT, not by line ratio — one `describe` / one `#[cfg(test)]` module =
one subject, and >~25 tests in one block is a tripwire to go find that boundary, not a number to
satisfy.** The trigger is **subject count**: no single `describe` block and no single `#[cfg(test)]`
module may hold more than ~25 **unrelated** tests. A block that crosses ~25 is a signal to go find
where the subjects actually divide — a 40-test block over ONE subject is fine; a 20-test block that
spans two is already wrong. **Splitting a file without splitting the block relocates the problem** —
a split is done when no `describe` spans two subjects, not when the file count went up; several
subject-named `describe`s living in one file is a legitimate outcome and costs no new mocks. The
shape that works is `mod tests;` + a `tests/` directory (e.g. `src/foo/tests/mod.rs`), **not** a
`tests.rs` sibling — `find src-tauri/src -name 'tests.rs'` reports **0** sites, while the directory
shape already exists at `src-tauri/src/commands/files/tests`, `src-tauri/src/storage/db/tests` and
`src-tauri/src/agent/session/tests` — `find src-tauri/src -type d -name tests` → **3**. The last of the
three is this rule being applied: `936dcafe` moved the session registry's inline test module out to
exactly that shape.

Do **not** use the old trigger "split when the test body exceeds the production body". The 2026-11-07
audit rejected it — it reports that the ratio "fires on 15 of 16 candidates", but **names no instrument
for that tally, so treat it as the audit's judgement, not a measurement you can re-run**. The judgement
itself holds on its own terms: the four files it lists (`errors.rs`, `settings.rs`, `router.rs`,
`refresh.rs`) have coherent tests over small production bodies, so splitting them buys nothing. And the
deeper reason stands regardless of the tally — a **file-level** ratio cannot name a block, so it is
blind to the hazard this rule exists to catch: the `describe("ChatStream", () => { … })` region that
`src/components/ChatStream.test.tsx` used to hold, **3,483 lines over 149 `it(` calls** across ~8
unrelated subjects. The ratio pointed at that FILE — the audit measured **4,156 test lines over a
710-line `ChatStream.tsx`** (both verified at `73abf9a4`; that component is still 710 lines) — and
stopped there. It never said which `describe` to split, and splitting the file moved the whole block
intact, which is exactly what the earlier split did.

**That 3,483-line region is HISTORIC, and its instruments no longer reproduce it — on purpose, because
the finding was fixed.** `6690966d` dissolved it into subject describes and moved the mention-picker
cluster to its own file. Do not re-run the audit's commands expecting the old numbers: `grep -n
'^describe(' src/components/ChatStream.test.tsx` finds **no `describe("ChatStream",` at all** (every
block there now carries a subject name in its title), and both the audit's `it(`-count instrument and
its brace counter **print nothing** against the current file. Its former `it(` content anchors now live
in `ChatStreamMentionPicker.test.tsx`, not the file the audit named.

Cite oversized regions by **content** (a `describe` name, a module name, a test title) — never by
`file:line`, which decays as files move (this file's own rule: match on the test name, never the line).
The audit's own `file:line` citations are the cautionary example: three commits on the branch that
*implemented* it (`6690966d`, `650bfe55`, `936dcafe`) invalidated every one of them. Everything below
is named by content and **re-runnable as written at HEAD**; historic figures are labelled and attributed
to the commit that dissolved them.

**The discriminator made concrete — this case the rule PERMITS:**
`src/components/ChatStreamMentionPicker.test.tsx`'s
`describe("ChatStream — the mention/file-completion pickers (ADR 0031/0033)")` holds **62 tests over
ONE subject** (the `$`/`@`/`#`/`?` pickers and their geometry). That is far over 25 and correct — do not
split it. Re-run: `npx vitest list src/components/ChatStreamMentionPicker.test.tsx | wc -l` → **60**,
not 62, because `vitest list` prints one `it.each` template unexpanded instead of its 3 cases; the real
figure is 59 `it(` + 3 = 62. **Count tests with the runner, not by grepping `it(`** — a grep undercounts
every `it.each`.

**Known live violations of the rule** (measure them yourself; each holds several subjects in one block,
which is exactly the shape this rule says to split). Naming them is the point — a rule with unlisted
exceptions reads as unenforced. **This list is verified but NOT exhaustive**: the candidate set is every
block over ~25, and only a read of the test titles decides whether a candidate crosses subjects.
Instrument: `npx vitest list | awk -F' > ' 'NF>=3 {print $1" || "$2}' | sort | uniq -c | sort -rn`
(3,147 tests today) — which puts `SidePane (the status panel)` (59), `MessageList scroll behavior` (43)
and `chatAttachments` (37) alongside the first bullet below as candidates to inspect, while
`ChatStream — out-of-Space Directory completion (ADR 0035)` (34) reads as ONE subject — every title is a
`?`-completion behaviour — and so is permitted, like the MentionPicker case above.

- `src/components/SpacesList.test.tsx`'s `describe("SpacesList (archive, ADR 0016)")` holds **38 tests
  across several subjects** — Stop-closes-session semantics, the archive flag itself, hover-action click
  swallowing, the Archived section's collapse/ordering/empty-state, unarchive, and the collapsed rail's
  marks and icons. Re-run: `npx vitest list src/components/SpacesList.test.tsx | grep -c "archive, ADR
  0016"` → `38`.
- `src-tauri/src/agent/session/naming.rs`'s `#[cfg(test)] mod tests` holds **77 test attributes** across
  several subjects — excerpt construction, quote/whitespace trimming, title capping (incl. multi-byte),
  reasoning-level forwarding, and composed-key resolution. Re-run:
  `sed -n '/^mod tests {/,$p' src-tauri/src/agent/session/naming.rs
  | grep -cE '#\[(tokio::)?test\]'` → `77`.
- `src-tauri/src/agent/session/tests/mod.rs` holds **73 test attributes flat** (no inner grouping at all)
  across session-id format, `SessionInfo` serialisation, settings push, compaction/cancel, titling on
  close, resume semantics and more. Re-run:
  `grep -cE '#\[(tokio::)?test\]' src-tauri/src/agent/session/tests/mod.rs` → `73`. **This is the rule's
  own cautionary tale in its current form**: `936dcafe` moved the pile into the correct *shape* but did
  not split the *module*, so the navigation hazard survived the move — a completed move, not a completed
  split.

Splitting `ChatStream.test.tsx` the right way is the counter-example and the proof the rule is
achievable: after `6690966d` its largest `describe` is
`describe("ChatStream — the compaction indicator (ADR 0045)")` at **22 tests**, and every block there is
subject-named. Re-run: `npx vitest list src/components/ChatStream.test.tsx | awk -F' > ' '{print $2}'
| sort | uniq -c | sort -rn | head -1`.

**Historic, and deliberately unreproducible** — the oversized blocks this branch *dissolved*, kept so the
numbers above are traceable rather than invented:

- `describe("ChatStream", …)` in `src/components/ChatStream.test.tsx`: **3,483 lines / 149 `it(`**, i.e.
  **152 runtime tests** once its one 3-case `it.each` is expanded (the review's "~157 tests" overcounts;
  its "4,156 raw lines, 162 `it`s" for the whole file is exact). Over ~8 subjects. Dissolved by
  **`6690966d`**. Its former instruments now print `0` / nothing against HEAD; they reproduce only
  against `6690966d^`.
- `describe("SpacesList")` in `src/components/SpacesList.test.tsx`: **37 `it(`**. Now **16** — the
  Agents-modal cluster left for `SpacesList.agents.test.tsx` in **`650bfe55`**.
- `mod session_tests` in `src-tauri/src/agent/session/mod.rs`: **71 test attributes**. That module
  **no longer exists anywhere**; **`936dcafe`** moved it to `src-tauri/src/agent/session/tests/mod.rs`,
  which holds **73** (the same commit added 2). Re-run against HEAD:
  `grep -cE '^\s*#\[tokio::test\]$|^\s*#\[test\]$' src-tauri/src/agent/session/tests/mod.rs` → `73`.
  Its anchors `fn mint_session_id_format()` and
  `fn session_manager_builder_cyclic_weak_reference_drops_cleanly()` still exist — **in `tests/mod.rs`,
  not `mod.rs`**.

The Rust compiler is pinned in the repo-root `rust-toolchain.toml`, so plain
`cargo …` from the repo root (the workspace) is the pinned one — CI installs
from that same file rather than naming a version. Do not float it: a newer rustc adds lints,
and a lint CI hits that a local toolchain cannot see reddens `main`
unreproducible.

`@tauri-apps/cli` is pinned to the exact `tauri` version in
the repo-root `Cargo.lock` for the same reason: the CLI *is* the bundler that writes
the AppImage/deb/dmg/NSIS artifacts, so a Rust-side Tauri bump must move it in
the same commit. A floated CLI changes shipped output — desktop entries, bundle
metadata — that no local build reproduces.

The reason is live, not historical: an older CLI exports the now-deprecated
`STATIC_VCRUNTIME` — the 2.11.4 the floated `^2` resolved to here before the
pin still does, 2.12.2 no longer does — and a newer `tauri-build` turns that
into a `cargo:warning=` (`tauri-build` 2.7.2, `src/lib.rs:939-941`). The skew
is easy to miss either way, because cargo replays a build script's stored
warnings from before the fix — a rebuild can print a warning the current
version pair no longer produces, so check the two versions rather than
trusting the warning.

The `pi-archimedes` monorepo (the agent-side extension suite, a separate repo)
is validated with `pnpm test` + `pnpm -r exec -- tsc --noEmit` from its root.

## Releasing

**The version lives in THREE files**, and nothing but the check script knows
all three: `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`. The first two are the ones a bumping tool can
find; the third is Tauri's bundle version, and it is the one that ends up in
the artifact names, the updater manifest and the About box. A release where it
was left behind produces a bundle labelled with the previous version — which
the updater then reads as "already newer", so the drift is not cosmetic. The
`release` skill's version table knows the first two, so the step below exists
for the third. CI enforces it: `scripts/check-versions.sh` (the `scripts` job
in `.github/workflows/ci.yml`) fails any PR where the three disagree, so a
forgotten file reddens the PR that introduced it rather than the release.

**Skill-executable step** (the `release` skill reads this file at Step 1 and
applies release instructions at Step 5, so this is written to be executed, not
just read): after the skill's automated bump, set `version` in
`src-tauri/tauri.conf.json` to the SAME `X.Y.Z`, then run
`bash scripts/check-versions.sh` from the repo root and require it to print
`versions match: X.Y.Z` before tagging. The bump commit covers all three
files. The values stay bare `X.Y.Z` — no `v` prefix (the tag carries the `v`;
the manifest composer rejects a `v`-prefixed version precisely because the two
are not interchangeable).

**Skill-executable final step — write the release notes.** This one runs AFTER
the skill's tag push and after `release.yml` has published (it is the only step
here that cannot run before the tag exists, so run it last and do not skip it
because the workflow "already did it"). `release.yml` now puts GitHub's
*generated* notes on the release automatically, so what remains — and what no
workflow can do — is writing notes a person would read.

1. Generate the draft:
   `bash scripts/release-notes.sh --repo "<owner>/<repo>" --tag vX.Y.Z --out /tmp/notes.md`
   — the markdown body goes to `--out`, the one-line summary to stdout. Do NOT
   call `POST /releases/generate-notes` by hand: it does not validate
   `tag_name`, so a tag with no release behind it answers 200 with confident,
   correctly-formatted notes describing the PREVIOUS release. The script refuses
   that case; two `gh` lines in a terminal do not.
2. **Rewrite it.** The generated list is squash-merged PR subjects with
   `by @user` suffixes — accurate, and not something to ship as the notes. Group
   by what a user would notice (New / Fixed / Changed), drop internal-only
   entries (`docs`, `chore`, CI, test-only), keep the PR links for what stays,
   and open with the one change worth upgrading for. The script's output is the
   floor, not the result.
3. Apply: `gh release edit vX.Y.Z --notes-file /tmp/notes.md`.
4. Refresh the in-app text too — Settings → Updates renders the `notes` field of
   `latest.json`, NOT the release body, so step 3 alone leaves the app showing
   one line. Download every `*.sig` plus `latest.json` off the release, re-compose
   the manifest over the downloaded one, and re-upload it with `--clobber`. This is
   the ONE ceremony step no workflow runs for you, so it is written out as the two
   commands that actually decide the outcome — the completeness gate, and the
   composer it feeds — in the shape `.github/workflows/release.yml`'s
   "Compose latest.json" step uses them:

   ```bash
   set -euo pipefail   # a plain terminal does NOT have this on — see the trap below
   gh release download vX.Y.Z --pattern '*.sig' --dir sigs --clobber
   gh release download vX.Y.Z --pattern latest.json --clobber
   bash scripts/check-release-signatures.sh \
     --repo "<owner>/<repo>" --tag vX.Y.Z > expected-payloads.txt
   require_args=()
   while IFS= read -r payload; do
     # `if`, not `[[ … ]] && …` — mirrored from the workflow comment: the runner's
     # default shell is `bash -e`, and a false test at the end of a compound list
     # aborts. Measured: with a command AFTER the loop the `&&` form survives, but as
     # the LAST command of a step (or inside a function) it aborts the step — so the
     # `if` form is what makes editing this block safe.
     if [[ -n "$payload" ]]; then
       require_args+=(--require-payload "$payload")
     fi
   done < expected-payloads.txt
   bash scripts/compose-updater-manifest.sh \
     --sigs-dir sigs \
     --version X.Y.Z \
     --tag vX.Y.Z \
     --repo "<owner>/<repo>" \
     --out latest.json \
     --notes "<the new one-liner>" \
     ${require_args[@]+"${require_args[@]}"}
   gh release upload vX.Y.Z latest.json --clobber
   ```

   Five of those six flags are enforced by the script itself, which names the one
   you forgot: `--sigs-dir` (where the `--dir sigs` download put the signatures —
   signatures only, never installers), `--version` (bare `X.Y.Z`, never
   `v`-prefixed), `--tag` (the `v` form; the URLs are pinned to it), `--repo`, and
   `--out` (where `latest.json` was just downloaded, which is what makes the
   refusal behaviour below matter). `--notes` is the sixth, and the script DOES
   accept its absence — which is exactly why the workflow passes
   `${NOTES_SUMMARY:-Archimedes $TAG}` rather than omitting it: an empty `notes` is
   legal JSON that passes self-validation, and the in-app panel renders it as the
   whole update description. Pass the one-line summary, never the markdown body.
   **The quotes around the two angle-bracket placeholders above are load-bearing, not
   punctuation:** an UNQUOTED `<owner>/<repo>` is two bash redirections, not an
   argument, so pasting the block never runs the command at all — `<owner` is an
   INPUT redirect from a file called `owner`, and with no such file in the terminal's
   cwd the line dies as `owner: No such file or directory` before the gate or the
   composer is reached (measured; exit 1, no `expected-payloads.txt` created, so the
   loop below would feed the composer ZERO expectations if the line ever got past
   that). If a file called `owner` does exist, the second half bites: `/<repo>`
   redirects output to `/` and bash says `/: Is a directory`. The workflow quotes the
   same argument as `--repo "$GITHUB_REPOSITORY"` for the same reason. Every other
   placeholder in the block is safe to paste: `X.Y.Z` / `vX.Y.Z` are literal-shaped,
   `'*.sig'` is quoted for globbing, `latest.json` / `sigs` / `expected-payloads.txt`
   are plain paths, and the `${require_args…}` expansion is quoted inside.
   `${require_args[@]+…}`
   is copied from the workflow rather than tidied: a bare `"${require_args[@]}"` on
   an EMPTY array is an unbound-variable error under `set -u` on the older bash
   still in wide use (bash fixed it in 4.4; macOS ships 3.2), and an empty
   `expected-payloads.txt` should say what is wrong, not die as a shell fault.

   **The gate writes a FILE and the loop reads it — do not hand-run it as
   `reqs="$(bash scripts/check-release-signatures.sh …)"`.** A terminal has no
   `-e`, so inside `$(…)` a refusal is invisible: every diagnostic the gate prints
   goes to stderr, `reqs` comes back EMPTY, the loop builds ZERO
   `--require-payload` flags, and the composer runs with no expectations at all —
   which is the opt-in, behave-as-it-always-has path that composes the shrunken
   manifest and **exits 0**. Measured on this tree: that shape reaches the compose
   with 0 flags and exit 0. And note where a substitution sits — `-e` judges a
   command by its OWN status, so one buried in a word (an argument, or a here-string
   like `done <<< "$(…)"`) never aborts the block even with `-e` on; only a bare
   `reqs=$(…)` assignment would, and a terminal has no `-e` anyway. Both reasons
   point the same way: the gate's stdout goes to a file, the loop reads the file, and
   `set -euo pipefail` at the top of the block is what stops a refusal AT the gate
   instead of turning it into an unguarded compose — the exact silent shrink this
   whole step exists to prevent.

   The whole step is worth running only when the downloaded `.sig` set is
   COMPLETE, because the composer emits one key per signature it was given and
   **exits 0 on the shrunken result**, so a missing sig publishes a manifest with
   a platform missing over the good one (ADR 0052).
   **COMPLETE means one `.sig` per platform this release targets — not one per
   filename on the release.** On Windows and Linux the payload IS the installer
   (`createUpdaterArtifacts: true` signs the raw `.exe`/`.AppImage`/`.deb`/`.rpm`;
   `tauri-plugin-updater` sniffs the bytes, not the URL), so a correct Linux+
   Windows release has **4 sigs serving 6 keys**: `windows-x86_64` and
   `-nsis` share the `.exe`, `linux-x86_64` and `-appimage` share the
   `.AppImage`. **Decide completeness with
   `bash scripts/check-release-signatures.sh --repo "<owner>/<repo>" --tag vX.Y.Z`,
   which asks the RELEASE's asset list — never the manifest.** Completeness
   cannot be checked against the manifest at all: the composer builds its
   `.platforms[].url` values FROM the very signatures under test, so counting the
   distinct URL names and requiring a `.sig` for each shrinks on both sides
   when a signature was never uploaded — it passes exactly when it should fail
   (issue #41(d)). The script requires a `<name>.sig` beside every installer asset
   and prints the installer list it accepted — that stdout IS the expectation list,
   which is what the `while read` loop above turns into one `--require-payload
   <name>` per line, and what makes this step's re-compose **fail** rather than
   shrink. The flag asserts that `<name>.sig` is in `--sigs-dir`; it does not need
   the installer file itself, because `--sigs-dir` holds signatures only. `.dmg` and
   `latest.json` are on the script's allow-list because they are legitimately
   unsigned and are not updater payloads — leave them there: a release carrying an
   unsigned `.dmg` is healthy, and a check that demanded a signature for it would
   fail every release. What a
   genuinely incomplete set looks like is a *target with no signature at all* (a
   deb built but its `.deb.sig` never uploaded). Re-uploading is otherwise safe:
   the signatures and the tag-pinned URLs come out identical, and
   `tauri-plugin-updater` reads `pub_date` for display only. An incomplete set
   means stop — stale-but-correct notes beat a broken manifest.

   **When the composer refuses, it deletes `latest.json`, so re-download before you
   retry.** Every refusal it reports — every path through its `fail()`, including a
   `--require-payload` refusal — removes a pre-existing `--out`, and it does so
   whatever the flag order: the target is the `--out` you TYPED, found in the
   invocation's own arguments, so a typo two flags short of the end
   (`--verison`, with `--out` last) cannot leave the old manifest behind. So after
   such a refusal the `latest.json` the second download put there is GONE, and the
   `gh release upload` you are about to type
   fails with "no such file or directory" instead of silently `--clobber`-ing the
   OLD manifest over a release whose notes rewrite never landed. (A refusal by the
   GATE is different and safer: the block stops before the compose, so the download
   is untouched.) The composer's deletion is the point (ADR 0052's 2026-10-24
   amendment): a stale manifest sitting at `--out` is the hazard, not the safety net.
   It is also cheap to undo, because the file being removed is a copy of a published
   asset — so fix the sig set, run
   `gh release download vX.Y.Z --pattern latest.json --clobber` to put the baseline
   back, and re-compose from there. What does NOT touch `--out` is everything that
   never reaches `fail()` — i.e. everything that reports no refusal at all: a missing
   `scripts/updater-payload-shapes.sh` (a broken checkout is not a refused
   composition, and a tool that never started has formed no opinion about this
   release, so it must not destroy the operator's download); a legacy value-less flag
   at the END of the line (`… --out latest.json --notes` shifts past the end of argv
   and dies as a shell fault with no message — the flag is the `--notes` / `--arch` /
   `--repo` family, and the fix is to give it a value); and an `--out` path the OS
   refuses (`mkdir: cannot create directory …` before the write). Treat any of them
   as "nothing was decided about `--out`": the file there is still the one you
   downloaded, and uploading it would publish the PREVIOUS
   release's manifest.
5. Confirm the human pass actually landed, on BOTH surfaces, and believe only
   the second one for the manifest:

   ```bash
   gh release view vX.Y.Z --json body -q .body | head -3
   # QUOTES LOAD-BEARING, same reason as the `--repo "<owner>/<repo>"` trap
   # above: an unquoted `<owner>` here is an input redirect from a file called
   # `owner`, so the line dies before curl runs instead of fetching anything.
   curl -sSL "https://github.com/<owner>/<repo>/releases/latest/download/latest.json" \
     | jq -r .notes
   ```

   **Checking for the placeholder is the wrong test.** `Archimedes vX.Y.Z` is
   what `create-release` seeds and what the manifest falls back to when the
   notes step FAILS — but that step is `continue-on-error`, and when it
   SUCCEEDS the workflow applies GitHub's generated notes to the body and puts
   its one-line summary in the manifest. So the ordinary way this step gets
   skipped leaves the body opening `## What's Changed` with `by @user` suffixes
   and the manifest notes reading `vX.Y.Z — N changes: <url>`, and a check for
   `Archimedes vX.Y.Z` passes on both. The manifest half was measured on the
   live v0.7.0 manifest before its rewrite; the body half is read off
   `release.yml` ("Apply the generated notes to the release" writes the
   generated markdown there) rather than observed — the body is not versioned,
   so once step 5 rewrites it the pre-rewrite text is gone. Either way, look for
   the generated shapes above, not for the placeholder.

   **And `gh` cannot verify the manifest.** `gh release view`/`download` are
   authenticated and read the asset API, so they return the file you just
   uploaded immediately; `--clobber` replaces the asset but the
   `/releases/latest/download/` URL keeps serving the PREVIOUS object for a
   while after. A step-5 check built on `gh` therefore passes whether or not
   installed clients can see the new notes yet — which is the one thing this
   verification exists to catch. `curl` the public endpoint and wait it out.
   Observed on v0.7.0: still old immediately after the upload and on a check 5
   seconds later; the `/releases/download/vX.Y.Z/` form was stale too, so
   pinning the version does not dodge this; fresh after a further 3-minute wait
   with nothing done in between. Stale-at-5s and fresh-by-then is a bracket, not
   an expiry — do not encode a sleep from it. Before suspecting the upload,
   prove the asset itself:
   `gh release download … --pattern latest.json` then `cmp` against the file you
   composed. If they match, the upload landed and only the public URLs lag.

- The minisign private key and its password live as GitHub secrets —
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — and
  nowhere in the repo; the public half is committed in
  `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, because that is
  what every installed client verifies signatures against.
- A keypair MISMATCH is **warn-only** in CI (tauri-cli logs it and carries on),
  so CI cannot be the check: verify the pair before tagging — the ceremony is in
  README's `## Releasing` section.
- **Ask the RELEASE which key signed it — the check that needs no private key.**
  A minisign signature blob is PLAIN (2 type bytes, 8 key-id bytes, 64
  signature bytes) and the committed pubkey prints its own id in words, so:

  ```bash
  jq -r .plugins.updater.pubkey src-tauri/tauri.conf.json \
    | base64 -d | head -n1        # -> "minisign public key: <ID>"
  gh release download vPREV --pattern '*.sig' --dir sigs --clobber
  for f in sigs/*.sig; do
    base64 -d "$f" | sed -n 2p | base64 -d | od -An -tx1 -j2 -N8
  done                            # byte-reversed <ID> must appear here
  ```

  The `.sig` files are themselves one base64-wrapped line, so decode the FILE
  first and take line 2 of the result — `sed -n 2p` on the raw file yields
  nothing. This asks the question a release actually poses ("will installed
  clients accept what CI just signed?"). Verified this way on v0.6.0 and v0.7.0:
  all four signatures on each carry the committed pubkey's id.
- **Do NOT read a key id out of the SECRET key file.** The offset trick above
  works only on PLAIN blobs. `archimedes-updater.key` is an ENCRYPTED key — its
  decoded blob is 158 bytes, not 74, and its comment says `rsign encrypted
  secret key` — so bytes 2..9 there are **KDF salt**, and reading them prints a
  confident, well-formed, completely wrong key id. That is exactly what happened
  during the v0.7.0 release: it produced a false "the local key is an orphan,
  CI's key is the right one" conclusion that was nearly written into this file.
  Verify the local pair by SIGNING something, which is also the only check that
  exercises the password (README step 4):

  ```bash
  # cwd MUST be the repo root — `pnpm` resolves the project from it, and from
  # anywhere else it dies with a `runDepsStatusCheck` stack trace that reads
  # like a signing failure but is not one. The scratch FILE goes elsewhere; the
  # .sig is written beside it, so the tree stays clean.
  echo scratch > /tmp/scratch.txt
  TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.archimedes/archimedes-updater.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.archimedes/archimedes-updater.key.password)" \
    pnpm tauri signer sign /tmp/scratch.txt
  base64 -d /tmp/scratch.txt.sig | sed -n 2p | base64 -d | od -An -tx1 -j2 -N8
  ```

  That id must equal the byte-reversed id of the committed pubkey. Verified on
  this machine after v0.7.0: it matches `2C0BB905F9BAB271`, so the local keypair
  IS the deployed one. Two gotchas in that block, both hit live: the password
  file is `archimedes-updater.key.password` (with `.key` — guessing
  `archimedes-updater.password` fails before signing), and there is no
  `tauri signer verify` subcommand, so decode and compare instead.
- **A draft is not a shipped release.** The updater endpoint is
  `/releases/latest/download/latest.json`, and that path serves only a
  published, non-prerelease release — a draft 404s, which every installed
  client reads as `release-not-found`. Hence `release.yml` publishes LAST,
  after the manifest is uploaded.
- **macOS packaging is gated on the `APPLE_*` signing secrets** and is silently
  skipped while they are absent — the matrix rows exist in `release.yml` but
  the step gate refuses, so "no macOS asset" on a release means no secrets, not
  a failed build.

## Conventions

- **TDD**: write the failing test first, confirm it fails, then make it pass.
- **Squash-merge** feature branches into `main` (one commit per feature).
- **A poisoned mutex: recover when the lock guards independent per-key state, panic when it guards
  one shared resource.** The discriminator, not a preference: `unwrap_or_else(|p| p.into_inner())`
  when the guarded data is a map of independent per-key rows (one poisoned entry must not wedge the
  others), `.expect(…)`/panic when the lock guards a SINGLE shared resource a panic may have left
  genuinely unusable. **Both existing behaviours are correct and must not change.** The session
  registry recovers, and documents why in the comment block above its per-session state accessors in
  `src-tauri/src/agent/session/mod.rs` ("a panic while holding a registry lock must not wedge every
  later session read") — one map of independent per-session rows, **25 production recovery sites**
  across `agent/session/`: `grep -rn "unwrap_or_else(|p| p.into_inner())" src-tauri/src/agent/session/
  | grep -vE ':\s*//' | wc -l` → **29** call-site lines, of which 4 sit in test modules. Per file:
  `session/mod.rs` **15** (all production), `naming.rs` **6** = 3 production + 3 inside its
  `#[cfg(test)] mod tests`, `router.rs` **7** (all production), `session/tests/mod.rs` **1** (test).
  Production = 15 + 3 + 7 = **25**. Use the comment-anchored filter, not `grep -v "//"`: the raw grep
  prints **30** because a prose comment in `session/mod.rs` quotes the very pattern, and `grep -v "//"`
  happens to give 29 today but would silently drop any real call site carrying a trailing `//` comment.
  `src-tauri/src/storage/db.rs` panics with
  `.expect("db mutex poisoned")` at **28 production sites** (`grep -c 'expect("db mutex poisoned")
  src-tauri/src/storage/db.rs` → 28) because `Db` holds ONE `rusqlite::Connection` in a `StdMutex`
  and a panic mid-transaction can leave that single connection unusable. Note the asymmetry in the
  evidence, not just the code: `db.rs` carries **no rationale anywhere in the file** — `grep -n
  "poison" src-tauri/src/storage/db.rs | grep -v 'expect("db mutex poisoned")'` prints nothing — so a
  new file that opens `session/mod.rs` first copies recovery and one that opens `db.rs` first copies
  panic, and the written discriminator above is what makes the choice deliberate rather than
  inherited. Hence the obligation: **any NEW panic-on-poison site must carry a one-line rationale for
  why its resource is single and shared**, so `db.rs`'s bare `.expect("db mutex poisoned")` — which
  asserts rather than argues — does not propagate. (Do not conflate counts: the tree-wide `grep -rn
  "into_inner()" src-tauri/src/ | wc -l` → **37** includes test modules and non-lock uses; that is the
  figure the review attributed to `agent/session/*`, which is a mis-attribution — `agent/session/`
  itself holds **30** raw / **29** after dropping the comment line above, 25 of them production. Still
  verify with the tree-wide command, since it is the one that reproduces.)
- **Docs**: durable design decisions live in `docs/decisions/NNNN-slug.md`
  (ADR format); in-flight plans live in `docs/roadmap/<feature>.md` and are
  deleted on ship. Anything a roadmap records that must survive that deletion
  moves while the branch is still open — a durable fact or accepted defect goes
  to `docs/features/` (see `docs/features/mcp-known-gaps.md`) or an ADR, not to
  a comment in the plan.
- **Planning**: when expanding a roadmap task into a plan (`specify`), dispatch
  the `researcher` agent definition (`subagent` with `agentName: "researcher"`)
  rather than a config-less dispatch.
- **A plan that consumes a predecessor must tell the implementer to VERIFY it, not assert it.**
  When a wave plans all its tasks before any implementer runs, no predecessor has landed while
  the planners write — so "task A1 has landed" is false at planning time no matter how the
  orchestrator believes it. Measured on `codemode`: the orchestrator told two planners A1 had
  landed, and the one that checked and reported `DEVIATION:` at its own HEAD was right. So
  instruct verification-at-start and require a `DEVIATION:` report on mismatch; that instruction
  is what turned a wrong premise into a harmless one. Related: `finish` deletes the plan family,
  so a plan that is ALSO a durable record must be copied out first (see the Docs bullet above).

### Working in this repo

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

- **`archimedes` is ONE compilation unit**, so a syntax error anywhere breaks
  every scoped `cargo test` run: two Rust implementation tasks can never share a
  wave. Read-only planning dispatches fan out freely. (Established with a planted
  error, not assumed.)
- **`cargo test --lib` does not rebuild `fake_worker`.** A stale
  `bin/fake_worker.rs` binary surfaces as `manager::tests` failing with
  misleading values after a protocol change; run `cargo build --all-targets`
  first when a fixture looks like it is lying.
- **`cargo check --target x86_64-pc-windows-gnu --all-targets` is the only local
  Windows proof** (the mingw target is installed). The msvc target needs `lib.exe`
  and there is no wine here, so `#[cfg(windows)]` code type-checks locally and
  only RUNS on CI's `windows-latest` leg — never describe Windows behaviour as
  behaviourally verified from this machine.
- **`TMPDIR` is not a usable workaround for temp-dir pressure in the Rust
  suite.** Two `commands::files` tests (`completion.rs`, `space_walk.rs`, via
  `assert_readdir_disagrees_with_sorted_order`) PANIC on unix unless the temp
  dir's `readdir` is unsorted — i.e. a tmpfs — because their "the survivors are
  the alphabetically first" assertion needs raw order to disagree with the sort.
  Two `sandbox` tests shell out to `TMPDIR=/tmp mktemp`, pinning `/tmp`
  explicitly. So pointing `TMPDIR` at a real disk fixes most tests and breaks
  those four. (Both halves re-measured, not copied from the plan that recorded
  them.)
- **Component rule: locate by content string, not by path.** When adding or verifying a
  component (e.g. a Rust module, a TS component, a test file), find it by its content
  signature — the `impl`, the trait name, the string literal — rather than by a
  hard-coded path. Paths move (the `harness` move from `src-tauri/` to
  `crates/fulcrum-core/` proved that twice: the `CARGO_MANIFEST_DIR.parent()` trap and
  the `settings.json` pin). Content is what the claim is about, so locate by content
  and recompute the path at run time.
- **`grep -c '#\[cfg(unix)\]'` counts LINES, including prose that names the
  attribute.** A census count needs the anchored `^#\[cfg(unix)\]$` or it
  false-reports high.
- **A boot fetch that `src/App.test.tsx` does not mock reddens tests that have
  nothing to do with it.** That file's `vi.mock("./lib/tauri")` factory spreads
  `importActual`, so an un-mocked export resolves to the real wrapper, which
  rejects outside a webview; the boot `Promise.all` rejects and its `.catch`
  swallows the reason. Measured by deleting one boot mock: **3 of the file's 41
  tests fail and only one names the fetch** — the other two are Settings /
  start-failure cases that merely need a booted store and fail on
  `activeSpacePath: null`. When `App.tsx` gains a boot fetch, add its mock in the
  same commit. (Found the hard way adding the third one — and note that only a
  minority of the file's tests need a booted store, so the blast radius is small
  but misleading, not large.)
- **The suite's green depends on file order.** Many `describe` blocks in
  `src/store/sessions.test.ts` never call `resetStores()`, so they inherit
  whatever a previous block left in the store; under
  `npx vitest run src/store/sessions.test.ts --sequence.shuffle` some fail.
  Nothing runs shuffled (no `shuffle` in `vitest.config.*`, `package.json`, or CI),
  so `pnpm test` is legitimately green — but a new test that asserts on store
  state must reset first, or it can pass for a reason nobody intends.
  `src/App.test.tsx` is the extreme case: it never calls `resetStores()` and
  hand-writes `useSessions.setState({...})` key lists per test, so a field the
  list omits survives from one test to the next — when you add a store field,
  grep that file rather than assuming the new field starts clean.
  `src/test/resetStores.ts` also documents that it cannot reach module-`let`
  state, so a store module holding its own bookkeeping needs a named reset.
- **`src/components/MessageBubble.codeblock.test.tsx`'s
  `renders a \`%s\` fence genuinely highlighted` (the `it.each` JSON case) flakes**
  — it intermittently renders the unhighlighted fallback through shiki's async
  path. Pre-existing, unrelated to whatever you just changed: if it fails once,
  re-run before investigating. It needs an owner, not a drive-by fix.
- **`src-tauri/tests/worker_e2e.rs::subagent_dispatch_end_to_end_real_workers` flakes, is
  undocumented elsewhere, and needs an owner — not a drive-by fix.** It intermittently fails
  `the subagent dispatch Completed (not Failed), got {"isError": true, "text": "subagent failed:
  the subagent settled with no output"}` — a real-worker spawn that settles before its output
  rendezvous. **Five observations, one per OS leg** — CI runs `41052924099` (macOS), `41188804029`
  (macOS, PR #137), `41228486025` (macOS, PR #140), `41054872558` (Windows) and `41280792380`
  (ubuntu, PR #142 — which then PASSED on re-run at the same SHA). Cite these run IDs, not the head
  SHAs: four of the five are unreachable from `main` (one is not even a local object), which is the
  squash-orphan trap this file already records — `gh run view <id>` is the durable handle, and the
  quoted assertion above is the version that survives the object. Only PR #142's case is verified
  Rust-free in its diff; the older four were not audited. But three OSes and five unrelated
  checkouts is not one branch's bug, and same-SHA pass/fail across legs is the load signature.
  So re-run the job before
  investigating, and do not go hunting for a Rust fix when the diff is TypeScript. Note the
  assertion's line number moves with the file (`:1287` and `:1314` were both observed) — match on
  the test name, never the line.
- **The `cargo test` temp-dir guard (`the Rust test suite left N new directories in … — #96's leak
  is back`) is often a CONSEQUENCE of the `worker_e2e` flake above, not a second failure.** Seven
  observations (runs `41052924099`, `41187113475`, `41188776833`, `41192896331`, `41195614333`,
  `41225507859`, `41228486025`), every one on `macos-latest` — though the CI
  step is `if: runner.os != 'windows'`, so it runs on ubuntu too and has simply never tripped there.
  Measured overlap: of the five runs where `subagent_dispatch_end_to_end_real_workers` failed, two
  (`41052924099`, `41228486025`) ALSO tripped the guard in the same job — a killed-or-abandoned
  real-worker spawn leaves its temp
  dir behind. So read a red guard on a run that also failed that test as one incident, not two, and
  do not go looking for a new leak on the branch under review. It is a distinct mechanism from the
  `check-temp-dir-census` case-13 bullet below (that is the script's own `--self-test` on Linux
  `/tmp`; this is the CI wrapper around `cargo test` on macOS's per-user `$TMPDIR`), and the
  guard's own message names #96 as the leak it exists to catch.
- **`Reasoning.test.tsx`'s `is O(last line), not O(whole text)` is a wall-clock
  assertion and flakes under full-suite load.** It measures
  `performance.now()` for a big input vs a small one and requires the ratio to be
  under 50, so a loaded machine or a GC pause can tip it — it passes in isolation
  and failed once on `main` right after an unrelated merge. Same advice: re-run
  before investigating, and do not "fix" it by tightening or loosening the
  threshold, which only moves the flake.
- **`harness::provider::transport::tests::a_slow_stream_completes_but_a_silent_stream_errors`
  flakes on ubuntu and needs an owner — not a drive-by fix.** It dribbles one body byte every
  **50 ms** against a **200 ms `read_timeout`** and asserts the dribbling stream COMPLETES while a
  silent one ERRORS, so a scheduler stall longer than the 150 ms margin reads as "the slow stream
  was cut". **Two failures, one per CI event type, in two runs of PR #158:** run
  **`41944729705`** (a `pull_request` run) failed while its sibling `push` run at the same SHA
  passed; then run **`41947586793`** (a `push` run) failed on **attempt 1** and went green on the
  re-run, while its sibling `pull_request` run `41947592114` passed at that same SHA. **That
  cross-event split at an unchanged SHA is the load signature** — cite these run IDs, not the SHAs,
  per the squash-orphan rule below. **Passed on re-run both times.** **Pre-existing, not
  introduced by the crate extraction** — verified by diffing the test body against
  `origin/main:src-tauri/src/agent/harness/provider/transport.rs`: **0 differing lines**, only its
  path moved (`agent/harness/` → `crates/fulcrum-core/src/harness/`). Same advice as the two above:
  re-run before investigating, and do not touch the 50/200 ms thresholds, which only moves the flake.
- **`scripts/check-temp-dir-census.test.sh` case 13 (`--self-test leaves the real
  census base unchanged`) reddens on a loaded Linux box, and the assertion is
  correct.** Its metric is `count_entries` — `find /tmp -mindepth 1 -maxdepth 1`,
  **every** depth-1 entry, not just directories, so on a dev box it is in the
  hundreds (~729 measured here) rather than the ~130 a directory-only count gives.
  `/tmp` here is a **tmpfs** shared with everything else on the machine, so anything
  else creating a temp dir mid-run legitimately violates the assertion. It moved
  twice (686→683, 697→694) during a wave that ran three agents in one tree with two
  cold `cargo build --all-targets` in flight — those two figures come from the agent
  that hit them, not from a re-measurement, but their magnitude agrees with the ~729
  above, so they are the same metric. On a quiet box the count was stable at 729
  across six samples. So re-run before investigating, and do not "fix" it by
  loosening the assertion — the churn is a real violation, and CI's `/tmp` does not
  churn. If it ever bites CI, the honest fix is a dedicated temp root for the census,
  not a wider tolerance.
- **`npx vitest run src/components` does NOT run `src/lib/toolDetailsRegistry.test.ts`, and the
  file's own tests are the repo's main guard on the tool-details wire contract.** Measured at
  `cb28abd0`: that glob matches 78 files and the registry is not among them. CI is safe — its
  `pnpm test` is `vitest run` with no path filter, so it does cover the file — so this is a
  LOCAL-GATE trap, not a coverage hole: a run that validates "the components" and reports green
  has not touched the registry, and a producer/reader key change it would catch goes untested.
  Run the file explicitly alongside the components glob.
- **`agent::childproc::tests::tool_child_reads_eof_on_closed_stdin` flakes on Windows and needs
  an owner — not a drive-by fix.** Observed failing on CI's `windows-latest` leg while
  `childproc.rs` was untouched by the branch under review, passing on the other run of the same
  SHA and on all runs of the next push. Its own docblock already says why: *"A regression pin,
  not the proof. On a host where cargo's own stdin is already `/dev/null` — which is what a CI
  step gets — this test passes with OR without `closed_stdin`."* So its pass/fail depends on the
  inherited handle, and the behaviour proof lives in the `execute_tool` test that re-execs the
  binary with a real pipe. Re-run before investigating.
- **ADR numbers collide on disk, and a plan will confidently name one that is taken.** `0086` is used by
  TWO files (`0086-glossary-names-govern-new-code-and-are-repaired-on-touch-not-by-sweep.md` and
  `0086-two-stage-async-session-titling-with-wire-isolation.md`) — pre-existing, and the only collision
  measured at `9cb94746`: `ls docs/decisions/ | grep -oE '^[0-9]{4}' | sort | uniq -d` prints `0086`, and
  81 files carry 80 distinct numbers. The reason this costs a run time rather than being cosmetic: a
  plan that names the next number is wrong more often than it is right. The `codemode` spec said `0088`,
  then "corrected" itself to `0087`, and BOTH were already taken — `0087` and `0088` exist on disk — so
  the shipped ADR is `0089`. Do not derive the number from a plan or from `max+1` alone: the directory
  has gaps (0001–0089 holds 80 distinct numbers, so 9 are missing), so `max+1` avoids collisions but a
  gap-filler will not, and the check that matters is the `uniq -d` above run AFTER you pick, not before.
- **Run cargo from the repository root — the workspace. A stray `cd src-tauri` no longer fails loudly;
  it silently builds one member.** Before T4 this repo had no root `Cargo.toml`, so a backgrounded
  `cargo` with no `cd` died with `could not find Cargo.toml` and, at exit 101, masqueraded as a real
  test failure (`worker_e2e` flake, once). **That failure mode is gone and a quieter one replaced it:**
  the repo root now holds the `[workspace]` manifest, so plain `cargo …` from the root is correct and
  is where `Cargo.lock` and `target/` live. Since T8b/S8b.4-part-3 the workspace has ONE member
  (`src-tauri`) — `fulcrum-core` is a rev-pinned git dependency, built as a dependency, never a
  member — so `cd src-tauri && cargo …` now runs the SAME suite as the root. The older trap this
  bullet was written for (a second member quietly skipped by a member-scoped run) is gone with it;
  what survives is the shape of the warning, because it reappears the moment a member is added:
  nothing errors, the command just checks less than you think. So write `cargo …` at the root,
  and still read the TEXT of a `cargo` failure before concluding a test flaked: "could not find
  Cargo.toml" means the command never ran, and re-running it to confirm a flake will simply fail again.
- **Plans carry stale baselines within hours** on a busy branch: re-measure test
  counts at your own HEAD rather than trusting the plan's.
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

