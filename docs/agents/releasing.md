# Releasing

The release ceremony, in the order it is executed. `AGENTS.md` carries only the
pointer to this file, because none of it is needed while writing code — it is
read when a release starts.

The human-facing half of the same rule lives in `README.md`'s `## Releasing`
(keypair creation, secrets, the DMABUF and unsigned-build notes). This file is
the **skill-executable** half: the `release` skill reads it at its Step 1 and
applies these instructions at its Step 5. Where the two overlap the README
explains and this file prescribes.

**A `feat:` in the payload does NOT force a minor bump — the level is the release's
call, and a patch carrying features is permitted here.** This is a deliberate
deviation from strict semver, recorded because the instruments here argue the other
way and a careful releaser will otherwise "correct" it. Measured across ALL tag
ranges (`git tag --sort=v:refname`, then per range
`git log --format="%s" <prev>..<tag> | grep -cE '^feat'` against which part moved):
**10 patch releases, 2 of them carried a `feat`** (`v0.3.2 → v0.3.3`, 1 feat;
`v0.9.1 → v0.9.2`, 2 feat) — so this is permitted, not "routinely done", and the
majority of patches are fix-only. Meanwhile every 0.10.0 → 0.14.0 bump containing a
`feat` went MINOR. The rule is **not** derived from that history — the history is
what makes the deviation look like an error, so it is stated as a decision, not
inferred. What a bump level tracks here is *whether the release is worth upgrading
for*, not whether a commit subject starts with `feat:`; a `feat` that adds no UI
surface and changes no API may ship in a patch. `breaking!:` is still the one thing
that must force a major. When the payload genuinely looks minor- or major-sized,
ASK before tagging — the tag is the irreversible half of the ceremony, and the
answer is not derivable from the commit subjects. Raised live: `v0.14.0 → v0.14.1`
shipped 2 `feat` + 1 `fix` as a patch by that decision, against a measured history
that would have said minor.

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
