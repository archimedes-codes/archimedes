#!/usr/bin/env bash
# Tests for scripts/check-file-size.sh.
#
# That script is the size TRIPWIRE: a production file crossing 1,000 CODE lines
# is a look-at signal, and a file growing past its recorded baseline is a red.
# It is a ratchet, not a defect threshold — subject count is still what decides
# whether a split is done (see AGENTS.md) — so what these fixtures have to prove
# is that the ratchet measures the one thing it claims to measure and fails when
# THAT moves:
#
#   - a file over 1,000 code lines with no baseline entry is red and named
#     (case 1 — the teeth),
#   - a baselined file that gains ONE CODE LINE is red and prints both numbers
#     (case 2), while the same file gaining one COMMENT line stays green
#     (case 3) — a ratchet a comment trips is measuring typing, not code,
#   - the instrument is a line CLASSIFIER and not `wc -l` in disguise: a Rust
#     file of 1,010 `///` lines and a TSX file of 1,010 `/* */` lines both
#     measure 0 code lines and stay green (cases 10–11),
#   - the instrument counts a WHOLE FILE, inline `#[cfg(test)] mod tests`
#     included (case 13). THAT is the discriminating case. The census this plan
#     descends from cut at `#[cfg(test)]`, and both candidate instruments pass
#     every other case in this file — only a fixture with N production code lines
#     PLUS an inline test module of M more, asserted by EXACT number N+M, tells
#     them apart. The whole-file instrument is the one that cannot be dodged by
#     MOVING code into the test module,
#   - a walk that read almost nothing is REFUSED, not green (case 8): a metric
#     that read no file must not read as coverage. The guard's most important
#     line, so it gets a case in both harnesses.
#
# Every fixture is its own throwaway GIT repository (`git ls-files` is the walk,
# so `git add -A` is what puts a fixture file in scope) and every fixture carries
# enough files to clear the vacuity floor, so each planted red below is provably
# the plant and not the fixture being too small to measure.
#
# Plain bash, not vitest: these are shell scripts, and green is the same bar
# `bash scripts/check-file-size.test.sh` has to clear in CI.
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check_script="$test_dir/check-file-size.sh"
repo_root="$(cd "$test_dir/.." && pwd)"

# Fail loudly rather than letting every case die with 126: a missing script
# under test is a different bug from a wrong exit code, and it is the first
# thing a TDD run needs to be told. THIS is the RED of task 8.
if [[ ! -f "$check_script" ]]; then
  echo "FATAL: $check_script does not exist — implement it before running these tests." >&2
  exit 1
fi

failures=0

# One temp root for the whole run, removed on EXIT. Deliberately a plain
# variable and not a list appended to inside a function: `roots+=("$(mktemp -d)")`
# records into the command substitution's subshell only, so the trap would clean
# nothing and leave a directory behind per case.
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

# The tracked ledger's content hash, taken BEFORE any case runs, so the mutation
# guard at the end of this file can prove the whole suite left the ledger as it
# found it. `cksum` and not a git comparison: a ledger that arrived dirty from
# outside this suite must not be able to hide a write this suite made, nor fake a
# red this suite did not earn.
baseline_pre_hash="$(cksum "$repo_root/scripts/file-size-baseline.txt" 2>/dev/null || true)"

# Runs the script under test, capturing exit status and merged output. The
# `|| status=$?` is what keeps `set -e` from aborting the driver on the exits
# this test is asserting.
run_check() {
  status=0
  output="$("$check_script" "$@" 2>&1)" || status=$?
}

assert_eq() {
  local what="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    echo "       output:   $output"
    failures=$((failures + 1))
  fi
}

assert_contains() {
  local what="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected to contain: $needle"
    echo "       actual output:       $haystack"
    failures=$((failures + 1))
  fi
}

assert_not_contains() {
  local what="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected NOT to contain: $needle"
    echo "       actual output:           $haystack"
    failures=$((failures + 1))
  fi
}

# The baseline line for a path, or empty. Tab-separated `<count>\t<path>`, read
# with the tab spelled as a literal so a reader can see the format.
baseline_count() {
  local file="$1" path="$2"
  awk -F'\t' -v p="$path" '$2 == p { print $1; exit }' "$file"
}

# ---------------------------------------------------------------------------
# Fixture builders. Every fixture states its expected CODE count as a literal
# next to the builders that make it, so no assertion re-derives the shape.

emit_code() {
  local n="$1" prefix="$2" i
  for ((i = 1; i <= n; i++)); do
    printf '%s%s = 1;\n' "$prefix" "$i"
  done
}

emit_doc() {
  local n="$1" prefix="$2" i
  for ((i = 1; i <= n; i++)); do
    printf '%s%s\n' "$prefix" "$i"
  done
}

# One-line `/* … */` IS dropped (the classifier's `/\*` arm matches a line that
# starts `/*`), as is a continuation line starting `*`. `{/* … */}` is NOT — its
# first character is `{` — see case 11b.
emit_block_comment() {
  local n="$1" i
  for ((i = 1; i <= n; i++)); do
    printf '/* note %s */\n' "$i"
  done
}

emit_jsx_comment() {
  local n="$1" i
  for ((i = 1; i <= n; i++)); do
    printf '{/* note %s */}\n' "$i"
  done
}

# A fixture repo big enough to clear BOTH vacuity floors (>=250 production files,
# >=1 file over 500 code lines), so every planted red below is the plant.
#
# The two EXEMPT paths exist in every fixture: check-file-size.sh refuses an
# exemption that names no file it walked (a stale exemption excuses nothing and
# parks a typo forever — check-commands.sh's allowlist rule, same reason).
fixture() {
  local name="$1"
  root="$tmp_root/$name"
  mkdir -p "$root/src-tauri/src" "$root/src/lib/archimedes-film" "$root/src/lib/palettes" "$root/scripts"
  local i
  for ((i = 1; i <= 251; i++)); do
    printf 'export const v%s = %s;\n' "$i" "$i" >"$root/src/f$i.ts"
  done
  # 600 code lines: clears the "at least one file over 500" floor (the real tree
  # has 27 such files) and stays under the 700 seed threshold and the 1,000 gate,
  # so it is inert for every case that is not about the floors.
  emit_code 600 'export const b' >"$root/src/big.ts"
  printf 'export const scene = 1;\n' >"$root/src/lib/archimedes-film/scene.ts"
  printf 'export const palette = 1;\n' >"$root/src/lib/palettes/everforest.ts"
  # Header-only baseline: nothing grandfathered, which is the state case 1 needs.
  printf '# fixture baseline\n' >"$root/scripts/file-size-baseline.txt"
  git -C "$root" init -q
  git -C "$root" add -A
}

# `fixture()`, but with every walked PATH renamed to ~240 characters. The files,
# the counts and the floors are identical — ONLY the path lengths differ, and that
# difference is what makes the SIGPIPE race in the guard's success line visible.
# The race depends on how many bytes `sort` still has left to write when the reader
# downstream of it closes the pipe, so `measured_file`'s SIZE is the dial: the
# short-path fixture gives ~3 KB of sort output and fires 0 times in 40 runs
# against the buggy pipeline (it is blind to the defect), this one gives ~62 KB and
# fires 20 times in 20. Padded to 240 and not longer, to stay under the 255-byte
# per-component limit.
fixture_long_paths() {
  local name="$1"
  fixture "$name"
  local i stem pad
  pad="$(printf '%237s' '')"
  for ((i = 1; i <= 251; i++)); do
    stem="$(printf 'paletteVariant%03d' "$i")"
    mv "$root/src/f$i.ts" "$root/src/$stem${pad:0:237-${#stem}}.ts"
  done
  # The rename must reach the index: the walk IS `git ls-files`, and a path the
  # index still holds at its old name is a file the guard cannot open.
  git -C "$root" add -A
}

# ---------------------------------------------------------------------------
# 1. THE TEETH: a production file over the hard 1,000 code-line gate with no
#    baseline entry is a red, and the message names the file, its count, and how
#    to re-measure it. A failure that does not say which file is a failure nobody
#    can act on.
fixture over_hard_gate
emit_code 1001 'const p' >"$root/src-tauri/src/huge.rs"   # 1001 code lines
git -C "$root" add -A
run_check "$root"
assert_eq "a file over 1,000 code lines with no baseline entry exits 1" "1" "$status"
assert_contains "the refusal names the file" "src-tauri/src/huge.rs" "$output"
assert_contains "and its measured code-line count" "1001" "$output"
assert_contains "and the gate it crossed" "1000" "$output"
assert_contains "and the command to re-measure the file" "grep -vcE" "$output"

# 1b. The same file at exactly 1,000 code lines is NOT over the bar. The bar is
#     "over 1,000", and a bar that bites at its own value makes the number the
#     AGENTS.md bullet publishes a lie.
fixture at_hard_gate
emit_code 1000 'const p' >"$root/src-tauri/src/edge.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "a file at exactly 1,000 code lines is not over the bar" "0" "$status"
assert_contains "and the run prints the positive line" "production file(s) walked" "$output"

# 1c. A file over 1,000 that IS in the baseline is grandfathered. That is what a
#     ratchet is: `db.rs` at 2,154 is allowed to EXIST, it is not allowed to
#     grow. Without this case the 1,000 gate would be a hard limit and the
#     baseline would be dead weight.
fixture baselined_above_gate
emit_code 1050 'const p' >"$root/src-tauri/src/old.rs"
git -C "$root" add -A
run_check "$root" --update
assert_eq "--update seeds a file over the 700 seed threshold" "0" "$status"
run_check "$root"
assert_eq "a baselined file above 1,000 code lines is grandfathered" "0" "$status"
assert_not_contains "and it is not reported as a gate violation" "1000-line hard gate" "$output"

# 2. THE RATCHET: one CODE line past the recorded baseline is a red, and BOTH
#    numbers print — "which side do I fix" is the only question a red can answer
#    from a CI log.
fixture grew
emit_code 704 'const p' >"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root" --update
assert_eq "--update seeds the baseline for a file over 700" "0" "$status"
assert_contains "and says what it wrote" "baseline" "$output"
printf 'const extra = 1;\n' >>"$root/src-tauri/src/mid.rs"   # 704 -> 705
git -C "$root" add -A
run_check "$root"
assert_eq "a baselined file that gains one code line exits 1" "1" "$status"
assert_contains "the refusal names the file" "src-tauri/src/mid.rs" "$output"
assert_contains "and the new count" "705" "$output"
assert_contains "and the recorded baseline" "704" "$output"
assert_contains "and the sanctioned way out" "--update" "$output"

# 3. THE SAME FILE GAINING A COMMENT LINE STAYS GREEN. Comments are stripped, so
#    documenting a baselined file can never redden CI. A ratchet a comment trips
#    is measuring keystrokes, and it gets silenced the first time someone writes
#    a doc comment.
fixture grew_comment
emit_code 704 'const p' >"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root" --update
printf '/// one more line of documentation\n' >>"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "a baselined file that gains one COMMENT line exits 0" "0" "$status"
assert_contains "and the positive line still prints" "file sizes within baseline" "$output"

# 4. SHRINKING IS ALWAYS ALLOWED (the verdict does not latch, and a ratchet that
#    only ever refuses punishes the fix).
fixture back_at_baseline
emit_code 704 'const p' >"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root" --update
printf 'const extra = 1;\n' >>"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "the grown file is red before it is shrunk" "1" "$status"
emit_code 600 'const p' >"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "the same file shrunk below its baseline exits 0" "0" "$status"

# 5. `--update` REGENERATES the baseline and the check that follows is green, so
#    an intentional rise is a reviewable diff rather than a threshold someone
#    edits to make the red go away.
fixture update_then_check
emit_code 712 'const p' >"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root" --update
assert_eq "--update seeds the rising file" "0" "$status"
printf 'const extra = 1;\n' >>"$root/src-tauri/src/mid.rs"   # 712 -> 713
git -C "$root" add -A
run_check "$root"
assert_eq "the rise is red before the second --update" "1" "$status"
run_check "$root" --update
assert_eq "--update after the rise exits 0" "0" "$status"
run_check "$root"
assert_eq "the check after --update is green" "0" "$status"

# 6. `--update` IDEMPOTENCE: a second --update over an unchanged tree writes the
#    same bytes and says nothing changed. Without this, --update could not be run
#    as "regenerate and read the diff" — the diff would be noise, and a step whose
#    output is noise is a step nobody reads.
fixture update_idempotent
emit_code 720 'const p' >"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root" --update
baseline_copy="$tmp_root/update-idempotent-copy.txt"
cp "$root/scripts/file-size-baseline.txt" "$baseline_copy"
run_check "$root" --update
assert_eq "the second --update exits 0" "0" "$status"
assert_contains "and reports the baseline unchanged" "unchanged" "$output"
if cmp -s "$baseline_copy" "$root/scripts/file-size-baseline.txt"; then
  echo "ok   the second --update leaves the baseline byte-identical"
else
  echo "FAIL the second --update rewrote the baseline (not idempotent)"
  diff -u "$baseline_copy" "$root/scripts/file-size-baseline.txt" | sed 's/^/       /'
  failures=$((failures + 1))
fi
run_check "$root"
assert_eq "and the check after two --update runs is green" "0" "$status"

# 7. `--update` PRINTS A DIFF for a real change, so the rise is visible in the PR
#    body rather than invisible in a rewritten file.
fixture update_prints_diff
emit_code 705 'const p' >"$root/src-tauri/src/mid.rs"
git -C "$root" add -A
run_check "$root" --update
printf 'const extra = 1;\n' >>"$root/src-tauri/src/mid.rs"   # 705 -> 706
git -C "$root" add -A
run_check "$root" --update
assert_eq "--update after a rise exits 0" "0" "$status"
assert_contains "and prints the old figure as removed" "-705" "$output"
assert_contains "and the new figure as added" "+706" "$output"

# 8. THE VACUITY FLOOR (the guard's most important line). A root with almost no
#    files is a walk that read nothing, and a metric that read no file must not
#    read as green. Asserted here AND in `--self-test`.
floor_root="$tmp_root/blind-walk"
mkdir -p "$floor_root/src" "$floor_root/src-tauri/src" "$floor_root/scripts"
printf 'export const one = 1;\n' >"$floor_root/src/one.ts"
printf 'export const two = 2;\n' >"$floor_root/src/two.ts"
printf '# fixture baseline\n' >"$floor_root/scripts/file-size-baseline.txt"
git -C "$floor_root" init -q
git -C "$floor_root" add -A
run_check "$floor_root"
assert_eq "a walk that found almost no files exits 1" "1" "$status"
assert_contains "and it is called BLIND, not clean" "BLIND" "$output"
assert_contains "and it names the count it saw" "2 production file(s) walked" "$output"
assert_contains "and the floor it fell short of" "floor is 250" "$output"
assert_not_contains "and a blind walk is never reported as green" "file sizes within baseline" "$output"

# 8b. THE SECOND FLOOR ARM: enough files, but nothing over 500 code lines. The
#     real tree has 27 such files, so a walk that finds ZERO is a classifier that
#     stopped classifying — or a tree it never read. Both must redden.
fixture no_big_files
rm "$root/src/big.ts"
git -C "$root" add -A
run_check "$root"
assert_eq "a walk that finds no file over 500 code lines exits 1" "1" "$status"
assert_contains "and it is called BLIND" "BLIND" "$output"
assert_contains "and it says what it was looking for" "over 500 code lines" "$output"

# 8c. A root that is not a git checkout is REFUSED rather than treated as an
#     empty walk: `git ls-files` failing is a failed search, and a failed search
#     is not an empty one (check-test-data-dir.sh's rule, inherited).
notgit="$tmp_root/not-a-git-repo"
mkdir -p "$notgit/src" "$notgit/scripts"
printf 'export const one = 1;\n' >"$notgit/src/one.ts"
printf '# fixture baseline\n' >"$notgit/scripts/file-size-baseline.txt"
run_check "$notgit"
assert_eq "a repo root that is not a git checkout exits 1" "1" "$status"
assert_contains "and the refusal says why" "git" "$output"
assert_not_contains "and it is never reported as green" "file sizes within baseline" "$output"

# 8d. A MISSING BASELINE is a red, not a free pass. With no baseline, every
#     grandfathered file would read as a fresh 1,000-line violation OR everything
#     would be waved through; either way the run is UNCHECKED, and an unchecked
#     run must not print the clean line.
fixture missing_baseline
rm "$root/scripts/file-size-baseline.txt"
git -C "$root" add -A
run_check "$root"
assert_eq "a missing baseline file exits 1" "1" "$status"
assert_contains "and it names the file it wanted" "file-size-baseline.txt" "$output"
assert_contains "and it says how to make one" "--update" "$output"
assert_not_contains "and it is never reported as green" "file sizes within baseline" "$output"

# 9. A MALFORMED BASELINE LINE is refused. A parser that skips what it cannot
#    read silently un-ratchets every file after it.
fixture malformed_baseline
printf 'not-a-number\tsrc/lib/f.ts\n' >>"$root/scripts/file-size-baseline.txt"
git -C "$root" add -A
run_check "$root"
assert_eq "a malformed baseline line exits 1" "1" "$status"
assert_contains "and the refusal quotes the line" "not-a-number" "$output"

# 10. THE INSTRUMENT IS NOT `wc -l`: 1,010 whole-line `///` doc lines in a Rust
#     file measure 0 code lines — neither over the gate nor seeded into the
#     baseline. A `wc -l` instrument reads 1,010 and reddens a file with no code
#     in it at all.
fixture all_doc_rust
emit_doc 1010 '/// doc' >"$root/src-tauri/src/docs.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "a Rust file that is all /// doc comments measures 0 code lines" "0" "$status"
assert_not_contains "so it is never named as a violation" "src-tauri/src/docs.rs" "$output"

# 10b. `//!` module docs are the other whole-line Rust comment form; 1,010 of
#      them are equally weightless.
fixture all_module_doc_rust
emit_doc 1010 '//! module doc' >"$root/src-tauri/src/moddocs.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "a Rust file that is all //! module docs measures 0 code lines" "0" "$status"
assert_not_contains "so it is never named as a violation" "src-tauri/src/moddocs.rs" "$output"

# 10c. And the third whole-line form: `/* … */` on one line, plus the `*`
#      continuation lines a real block comment is made of.
fixture all_block_comment_rust
{
  emit_block_comment 505
  emit_doc 505 ' * continuation'
} >"$root/src-tauri/src/block.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "a Rust file of 1,010 block-comment lines measures 0 code lines" "0" "$status"
assert_not_contains "so it is never named as a violation" "src-tauri/src/block.rs" "$output"

# 11. THE TSX HALF: 1,010 `/* */` lines measure 0 code lines.
fixture all_comment_tsx
emit_block_comment 1010 >"$root/src/Notes.tsx"
git -C "$root" add -A
run_check "$root"
assert_eq "a TSX file that is all block comments measures 0 code lines" "0" "$status"
assert_not_contains "so it is never named as a violation" "src/Notes.tsx" "$output"

# 11b. THE DOCUMENTED LIMIT, PINNED rather than wished away: a JSX comment's
#      braces are NOT stripped. `{/* … */}` starts with `{`, and the instrument is
#      the plan's LITERAL classifier — the one whose figures the plan's own table
#      vouches for (`AgentsDialog.tsx` 550, not the 541 a `{/*`-stripping
#      classifier gives). So a file of JSX-braced comments DOES measure its line
#      count. Asserting the exact number here means a future "improvement" that
#      strips `{/*` reddens a test instead of quietly lowering every .tsx figure in
#      the tree by its comment count.
fixture jsx_braced_comments
emit_jsx_comment 1005 >"$root/src/Braced.tsx"
git -C "$root" add -A
run_check "$root"
assert_eq "a JSX-braced comment is NOT stripped (documented limit): 1005 is over the gate" "1" "$status"
assert_contains "and the exact figure measured is 1005, not 0 and not 1005+5" "1005" "$output"

# 12. THE CLASSIFIER'S POSITIVE HALF, by exact number through the baseline: 705
#     code lines plus 10 whole-line comments seed 705 — not 715 (a `wc -l`
#     instrument) and not 695 (an over-eager stripper).
fixture classifier_exact
{
  emit_doc 5 '/// doc'
  emit_code 705 'const p'
  emit_doc 5 '// trailing note'
} >"$root/src-tauri/src/exact.rs"
git -C "$root" add -A
run_check "$root" --update
recorded="$(baseline_count "$root/scripts/file-size-baseline.txt" 'src-tauri/src/exact.rs')"
assert_eq "705 code lines + 10 comment lines seed a baseline entry of exactly 705" "705" "$recorded"

# 12b. THE SEED THRESHOLD, both sides: 701 code lines is seeded ("over 700"), 700
#      is not. That threshold is what lets an ordinary file grow a little without
#      a re-baseline, so its off-by-one is load-bearing.
fixture seed_threshold_both
emit_code 700 'const p' >"$root/src-tauri/src/atseed.rs"
emit_code 701 'const p' >"$root/src-tauri/src/overseed.rs"
git -C "$root" add -A
run_check "$root" --update
assert_eq "a file at 701 code lines is seeded" "701" "$(baseline_count "$root/scripts/file-size-baseline.txt" 'src-tauri/src/overseed.rs')"
assert_eq "a file at exactly 700 code lines is not seeded" "" "$(baseline_count "$root/scripts/file-size-baseline.txt" 'src-tauri/src/atseed.rs')"

# 13. THE DISCRIMINATING FIXTURE. A Rust file with N production code lines PLUS an
#     inline `#[cfg(test)] mod tests` of M more must measure N + M.
#
#     Both candidate instruments pass every case above. A census instrument that
#     cuts at `#[cfg(test)]` reads this file as 1,000 and reports GREEN; this
#     ratchet reads 1,011 and refuses. That difference is the whole of the
#     dodge-proofness argument — a cut-at-cfg ratchet is satisfied by MOVING code
#     into the test module, which shrinks the number and changes nothing real.
#     Asserted by EXACT number: "greater than N" would let a mis-chosen N pass the
#     cut instrument too.
fixture inline_test_module
{
  emit_doc 5 '/// doc above the production code'
  emit_code 1000 'const p'
  printf '#[cfg(test)]\n'
  printf 'mod tests {\n'
  emit_code 8 '    const t'
  printf '}\n'
} >"$root/src-tauri/src/dodged.rs"   # 1000 code + 11 more (attribute, mod open, 8, brace) = 1011
git -C "$root" add -A
run_check "$root"
assert_eq "an inline #[cfg(test)] mod tests counts toward the file" "1" "$status"
assert_contains "the refusal names the file" "src-tauri/src/dodged.rs" "$output"
assert_contains "and the figure is exactly 1000 + 11 = 1011" "1011" "$output"
assert_not_contains "and the cfg(test)-cut figure (1000 code lines) is not what was measured" "1000 code lines" "$output"

# 13b. THE SAME PIN AT SMALL SCALE, read out of the baseline where a reader can
#      check the arithmetic: 700 production code lines + a 4-line inline test
#      module (attribute, `mod tests {`, one line, closing brace) seed 704.
fixture inline_test_module_seeded
{
  emit_code 700 'const p'
  printf '#[cfg(test)]\n'
  printf 'mod tests {\n'
  emit_code 1 '    const t'
  printf '}\n'
} >"$root/src-tauri/src/smalltest.rs"
git -C "$root" add -A
run_check "$root" --update
assert_eq "700 production code lines + a 4-line inline test module seed exactly 704" "704" "$(baseline_count "$root/scripts/file-size-baseline.txt" 'src-tauri/src/smalltest.rs')"

# 13c. THE DODGE ITSELF, shown to fail: moving 10 code lines from the production
#      half of a baselined file into its inline `mod tests` must not lower the
#      measured figure. Under the census instrument this move drops the number
#      from 710 to 700 and the file "shrinks"; here both halves read 713.
fixture dodge_attempt
{
  emit_code 710 'const p'
  printf '#[cfg(test)]\n'
  printf 'mod tests {\n'
  printf '}\n'
} >"$root/src-tauri/src/dodge.rs"    # 710 + 3 = 713
git -C "$root" add -A
run_check "$root" --update
before="$(baseline_count "$root/scripts/file-size-baseline.txt" 'src-tauri/src/dodge.rs')"
assert_eq "the pre-dodge figure is 713" "713" "$before"
{
  emit_code 700 'const p'
  printf '#[cfg(test)]\n'
  printf 'mod tests {\n'
  emit_code 10 '    const t'
  printf '}\n'
} >"$root/src-tauri/src/dodge.rs"    # 700 + 13 = 713 — the same, because the whole file counts
git -C "$root" add -A
run_check "$root"
assert_eq "moving 10 code lines into the inline test module does not redden or shrink" "0" "$status"
run_check "$root" --update
after="$(baseline_count "$root/scripts/file-size-baseline.txt" 'src-tauri/src/dodge.rs')"
assert_eq "and the re-measured figure is unchanged (the dodge buys nothing)" "713" "$after"

# 14. THE EXEMPTIONS HAVE TEETH, IN BOTH DIRECTIONS. An exempt file is not seeded
#     and may grow freely — that is ALL an exemption buys, since none of the
#     exempt files is anywhere near the gate — but the hard 1,000 gate still
#     applies to it.
fixture exempt_grows_freely
emit_code 800 'export const x' >"$root/src/lib/palettes/everforest.ts"
git -C "$root" add -A
run_check "$root" --update
assert_eq "an exempt file over 700 is not seeded into the baseline" "" "$(baseline_count "$root/scripts/file-size-baseline.txt" 'src/lib/palettes/everforest.ts')"
emit_code 950 'export const x' >"$root/src/lib/palettes/everforest.ts"
git -C "$root" add -A
run_check "$root"
assert_eq "an exempt file may grow past the seed threshold with no re-baseline" "0" "$status"
emit_code 1001 'export const x' >"$root/src/lib/palettes/everforest.ts"
git -C "$root" add -A
run_check "$root"
assert_eq "an exempt file still cannot cross the hard 1,000 gate" "1" "$status"
assert_contains "and the refusal names it" "everforest.ts" "$output"

# 14b. A STALE EXEMPTION is refused: an exemption naming a file the walk did not
#      see excuses nothing and parks a typo forever.
fixture stale_exemption
rm "$root/src/lib/palettes/everforest.ts"
git -C "$root" add -A
run_check "$root"
assert_eq "an exemption naming a file that no longer exists exits 1" "1" "$status"
assert_contains "and the refusal names the exemption" "everforest.ts" "$output"

# 14c. An exemption WITHOUT a reason is refused (the check-commands.sh allowlist
#      rule: an unexplained exemption is how a permanent free pass arrives). The
#      exemption list lives inside the script, so this case runs a COPY of the
#      script in the temp root with the reason stripped from one line — never the
#      script under test itself, which lives in the checkout.
copied="$tmp_root/reasonless-copy.sh"
# Blanks the reason on ONE exemption line (everything after the TAB separator),
# leaving the path intact, so the only thing left to refuse is the missing reason.
awk -F'\t' -v OFS='\t' '$1 == "src/lib/palettes/everforest.ts" { $2 = "" } { print }' "$check_script" >"$copied"
chmod +x "$copied"
fixture reasonless_exemption
run_check_copy() {
  status=0
  output="$("$copied" "$@" 2>&1)" || status=$?
}
run_check_copy "$root"
assert_eq "an exemption with no cited reason on its line exits 1" "1" "$status"
assert_contains "and the refusal says a reason is required" "reason" "$output"
assert_not_contains "and a reasonless exemption is never reported as green" "file sizes within baseline" "$output"

# 15. THE PRODUCTION SCOPE. `*.test.ts(x)` and anything under a `tests/` directory
#     are not production, and a 1,100-line test file is not a size violation.
#     Inline `mod tests` IS production (case 13); a directory named `tests` is not.
fixture scope_excludes
mkdir -p "$root/src-tauri/src/agent/tests"
emit_code 1100 'const p' >"$root/src-tauri/src/agent/tests/module.rs"
emit_code 1100 'export const x' >"$root/src/lib/Big.test.ts"
emit_code 1100 'export const x' >"$root/src/lib/Big.test.tsx"
git -C "$root" add -A
run_check "$root"
assert_eq "a tests/ file and *.test.ts(x) over 1,000 lines are out of scope" "0" "$status"
assert_not_contains "the tests/ file is not named" "src-tauri/src/agent/tests/module.rs" "$output"
assert_not_contains "neither is the *.test.ts file" "src/lib/Big.test.ts" "$output"

# 15b. And the scope is not accidentally WIDER than the two production roots.
fixture scope_outside
mkdir -p "$root/crates/other/src"
emit_code 1100 'const p' >"$root/crates/other/src/elsewhere.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "a file outside the two production roots is out of scope" "0" "$status"
assert_not_contains "and it is not named" "crates/other/src/elsewhere.rs" "$output"

# 15c. THE WALK READS THE WHOLE DIRECTORY, not a `**` glob that silently misses
#      the depth-1 files. This is a real trap, measured on this repo: the plan's
#      illustrative pattern list (`git ls-files 'src-tauri/src/**/*.rs'`) does NOT
#      match `src-tauri/src/config.rs` — a file the plan itself names at 1,289
#      code lines — because git's `**` needs at least one slash. A walk built that
#      way would drop nine top-level Rust files, three of them over 1,000 lines,
#      and print a confident green.
fixture walk_reads_depth_one
emit_code 1050 'const p' >"$root/src-tauri/src/toplevel.rs"
git -C "$root" add -A
run_check "$root"
assert_eq "a depth-1 file under src-tauri/src is walked (git's ** needs a slash)" "1" "$status"
assert_contains "and named" "src-tauri/src/toplevel.rs" "$output"

# 16. THE POSITIVE LINE, checkable: the count walked plus the largest file by
#     path and number (the sibling prints `versions match: X.Y.Z`).
fixture positive_line
emit_code 730 'const p' >"$root/src-tauri/src/largest.rs"
git -C "$root" add -A
run_check "$root" --update
run_check "$root"
assert_eq "a clean fixture exits 0" "0" "$status"
assert_contains "the positive line names the walked count" "production file(s) walked" "$output"
assert_contains "and the largest file with its figure" "src-tauri/src/largest.rs 730" "$output"

# 16b. THE SUCCESS LINE CANNOT DIE OF SIGPIPE BEFORE IT PRINTS.
#
# WHY A REPEAT LOOP IS THE ONLY INSTRUMENT THAT CAN SEE THIS. The defect this case
# pins was a short read: the guard computed its own success line through
# `sort … | head -n1`, `head` exited after one line and closed the pipe, `sort`
# died of SIGPIPE with output still buffered, `pipefail` propagated 141, and
# `set -e` aborted the script BEFORE the positive line was printed — a guard whose
# own green was intermittently a silent 141. Whether it fires is a RACE between
# `sort`'s remaining write and `head` closing the pipe, so a single run is not
# evidence of anything: 39 runs out of 40 on the real tree exited 0 having printed
# the line, and the 40th printed nothing and exited 141. A case that runs the guard
# once passes 97% of the time against the broken code, which is worse than no case
# — it is a green that argues the defect is fixed. Only N consecutive runs, ALL of
# which must hold, can see a race whose failure rate is below 1.
#
# Every run must satisfy all three: exit 0, stdout non-empty, and stdout carrying
# `production file(s) walked`. One bad iteration FAILS the case; nothing is retried
# away, because a retry would be the same flake-management this defect is.
#
# The fixture is `fixture_long_paths`, not `fixture`: the fire rate scales with the
# bytes `sort` has left to write when `head` closes, and the short-path fixture's
# ~3 KB of `measured_file` fires ZERO times in 40 runs against the broken pipeline.
# Against that broken pipeline this fixture fired 20 times in 20, so this loop is
# not hoping to catch the race — it is the shape that reproduces it. The real tree
# fires ~1 run in 10 and is already covered once by case 18/18d; the loop runs
# here, where it fires every time.
fixture_long_paths sigpipe_pin
emit_code 730 'const p' >"$root/src-tauri/src/largest.rs"   # 730 code lines
git -C "$root" add -A
run_check "$root" --update
assert_eq "the SIGPIPE pin's fixture is seeded so its runs are green runs" "0" "$status"

sigpipe_runs=25
sigpipe_bad=0
sigpipe_codes=""
for ((sigpipe_i = 1; sigpipe_i <= sigpipe_runs; sigpipe_i++)); do
  sigpipe_out="$("$check_script" "$root" 2>&1)" && sigpipe_code=0 || sigpipe_code=$?
  if [[ "$sigpipe_code" != 0 ]] || [[ -z "$sigpipe_out" ]] || [[ "$sigpipe_out" != *"production file(s) walked"* ]]; then
    sigpipe_bad=$((sigpipe_bad + 1))
    sigpipe_codes="$sigpipe_codes run$sigpipe_i:exit=$sigpipe_code:len=${#sigpipe_out}"
  fi
done
assert_eq "all $sigpipe_runs consecutive runs exit 0 AND print a non-empty positive line (a short read under pipefail is a silent 141)$sigpipe_codes" "0" "$sigpipe_bad"

# 17. USAGE ERRORS (the check-versions.sh contract): a second positional root, an
#     unknown flag, `--self-test` with a root, and `--update` with `--self-test`
#     are all errors — never a silent "nothing was asked for".
run_check "$tmp_root" "$tmp_root"
assert_eq "two repo roots is a usage error" "1" "$status"
assert_contains "and it prints usage" "usage" "$output"
run_check "$tmp_root" --nope
assert_eq "an unknown flag is a usage error" "1" "$status"
run_check --self-test "$tmp_root"
assert_eq "--self-test takes no repo root" "1" "$status"
run_check "$tmp_root" --update --self-test
assert_eq "--update together with --self-test is a usage error" "1" "$status"
run_check --help
assert_eq "--help exits 0" "0" "$status"

# 18. THE REAL TREE. The assertion CI depends on: green as it stands, against the
#     committed baseline, and it actually walked the tree.
run_check "$repo_root"
assert_eq "the real tree is green against its committed baseline" "0" "$status"
assert_contains "and it walked the production tree" "production file(s) walked" "$output"

# --- helpers for the real-tree cases 18b-18e ------------------------------
# The instrument's own walk, mirrored: same pathspecs, same extensions, same two
# exclusions. Duplicated deliberately rather than shelling out to the guard, so
# the predicates below can ask the walk a question the guard never asks. Case 18e
# asserts this mirror's COUNT against the guard's own positive line, which is what
# turns a drift between the two into a red instead of a silently un-pinned pin.
ledger_walk_paths() {
  local r="$1" rel
  git -C "$r" ls-files -z -- src-tauri/src src-tauri/tests src |
    while IFS= read -r -d '' rel; do
      case "$rel" in *.rs) ;; *.ts | *.tsx) ;; *) continue ;; esac
      case "$rel" in *.test.ts | *.test.tsx) continue ;; esac
      case "/$rel" in */tests/*) continue ;; esac
      printf '%s\n' "$rel"
    done
}

# The guard's own field separator, spelled the way the guard spells it, so the
# `sort` invocations below are the SAME sort and break a tie the same way.
TABS="$(printf '\t')"

# THE OTHER INSTRUMENT: the census variant, which stops at the first
# `#[cfg(test)]` line. This is what the plan's census measured, and what a ratchet
# built on it would have recorded. It lives here so the pins below can ask "could
# a cutting instrument have written this ledger?" of the real checkout, which is
# the only question that tells the two instruments apart at all.
instrument_cut_lines() {
  local file="$1" n
  n="$(awk '/#\[cfg\(test)\]/{exit} {print}' "$file" |
    grep -vcE '^[[:space:]]*(//|\*|/\*|$)' || true)"
  printf '%s\n' "${n:-0}"
}

# The whole-file instrument, mirrored: `code_lines`' classifier verbatim, applied
# to every path `ledger_walk_paths` visits, as `<count><TAB><path>`.
instrument_measured() {
  local r="$1" p n
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    n="$(grep -vcE '^[[:space:]]*(//|\*|/\*|$)' -- "$r/$p" || true)"
    printf '%s\t%s\n' "${n:-0}" "$p"
  done <<<"$(ledger_walk_paths "$r")"
}

# The guard's own ranking of a `<count><TAB><path>` list — the identical
# invocation, so a tie for largest resolves the same way on both sides of every
# comparison below.
instrument_rank() {
  LC_ALL=C sort -t"$TABS" -k1,1rn -k2,2 <<<"$1"
}

# Ledger entries only a CUTTING instrument could have written: a file whose inline
# `#[cfg(test)]` module contributes counted lines today (so the two instruments
# genuinely DISAGREE about it) whose recorded figure does not sit ABOVE the cut
# figure. Files with no inline test module are skipped — there the two instruments
# agree by construction and there is nothing to pin. Lag in the other direction is
# fine and expected: a recorded figure may sit far above a shrunk file, this asks
# only that it not sit AT OR BELOW the cut figure.
ledger_entries_cut_short() {
  local r="$1" p rec whole cut bad=""
  while IFS=$'\t' read -r rec p; do
    [[ -z "$p" ]] && continue
    [[ -f "$r/$p" ]] || continue
    whole="$(grep -vcE '^[[:space:]]*(//|\*|/\*|$)' -- "$r/$p" || true)"
    whole="${whole:-0}"
    cut="$(instrument_cut_lines "$r/$p")"
    ((whole > cut)) || continue
    ((rec > cut)) || bad="$bad$p(rec=$rec<=cut=$cut)"$'\n'
  done < <(awk -F'\t' '!/^#/ && NF == 2 { print $1 "\t" $2 }' "$r/scripts/file-size-baseline.txt")
  printf '%s' "$bad"
}

# The real checkout's walk and ledger, read ONCE so every case below ranks the
# same snapshot instead of a possibly-different one per case.
real_walk="$(ledger_walk_paths "$repo_root")"
real_baseline="$repo_root/scripts/file-size-baseline.txt"

# The tree as the whole-file instrument ranks it, computed ONCE and shared by 18c
# (which asks which three files are largest) and 18d (which asks which one is).
# Recomputed on every run: nothing below recites a file name or a figure.
tree_ranked="$(instrument_rank "$(instrument_measured "$repo_root")")"

# 18b. THE INSTRUMENT PIN ON THE REAL TREE, in comparative form and with no
#      leaderboard in it. Two claims, both of the shape `recorded > cut`:
#
#   (1) THE NAMED SAMPLE. The committed baseline records
#       `src-tauri/src/agent/session/naming.rs` ABOVE what a `#[cfg(test)]`-cut
#       instrument gives that same file. naming.rs is where the two instruments
#       disagree most — its inline `mod tests` is ~1,675 lines — so it is the
#       cheapest place to ask the census-vs-ratchet question of the real checkout.
#       naming.rs appears here as a SAMPLE of the tree and not as its largest
#       file: the assertion holds whatever it measures and whatever else is bigger.
#   (2) THE SWEEP, which is claim (1) applied to every ledger entry the two
#       instruments disagree about. One file can be pinned by accident; ten
#       cannot, and the sweep is what catches a ledger that was cut in only some
#       of its rows.
#
# WHY COMPARATIVE AND NOT A NUMBER. A frozen figure reddens the moment anyone
# shrinks the file, which is the entire point of the plan this guard belongs to.
# `recorded > cut` survives any later shrink, because a shrink moves BOTH sides of
# the comparison together.
if [[ -f "$real_baseline" ]]; then
  recorded="$(baseline_count "$real_baseline" 'src-tauri/src/agent/session/naming.rs')"
  cut_figure="$(instrument_cut_lines "$repo_root/src-tauri/src/agent/session/naming.rs")"
  if [[ -z "$recorded" ]]; then
    echo "FAIL the committed baseline has no entry for src-tauri/src/agent/session/naming.rs"
    failures=$((failures + 1))
  elif ((recorded > cut_figure)); then
    echo "ok   the baseline counts naming.rs whole: $recorded > the cfg(test)-cut figure $cut_figure"
  else
    echo "FAIL the baseline records naming.rs at $recorded, not above the cfg(test)-cut figure $cut_figure — the instrument is cutting at #[cfg(test)]"
    failures=$((failures + 1))
  fi
else
  echo "FAIL $real_baseline does not exist — generate it with --update and commit it"
  failures=$((failures + 1))
fi

assert_eq "and every ledger entry the two instruments disagree about is recorded ABOVE its cfg(test)-cut figure" \
  "" "$(ledger_entries_cut_short "$repo_root")"

# 18c. THE LEDGER'S HEAD IS A RANKING OF THE TREE THE INSTRUMENT SEES — recomputed,
#      not recited. This case used to assert that the three largest were naming.rs,
#      db.rs and session/mod.rs IN THAT ORDER, which was a snapshot of the tree
#      wearing the clothes of a test: Task 2 legitimately cut naming.rs from 2,259
#      to 2,002 and the case went red on a green tree. Three claims replace it,
#      none of which names a winner:
#
#   (1) SORTEDNESS, the one ordering claim that IS invariant: the ledger's own
#       figures run largest-first, because that is the order `--update` writes
#       them in. A hand-edited or re-spliced ledger breaks this and nothing else.
#   (2) REALNESS: each of the ledger's three largest is a tracked production file
#       this walk actually visits, so the head of the ledger is the head of a real
#       list and not of an invented one.
#   (3) MEMBERSHIP, order-free: the three files the WHOLE-FILE instrument measures
#       as largest on this tree are exactly the three files heading the ledger.
#       ORDER IS DELIBERATELY NOT COMPARED between the two sides: the ledger is a
#       RATCHET and its figures legitimately LAG (it holds naming.rs at 2,259 while
#       the file measures 2,002), and a lagging figure can reorder the two lists
#       without either side being wrong. MEMBERSHIP is what survives that lag, and
#       membership is what a cutting instrument breaks — under the census
#       instrument naming.rs reads 327 and leaves the top three altogether.
#
# Read from the file rather than by running `--update` against the real checkout: a
# test must not rewrite a tracked file in the tree it is testing (case 18e).
#
# `awk 'NR <= 3'` and NOT `head -n3`: this pipeline runs under this file's own
# `set -euo pipefail` (line 37), and `head -n3` is the same short read that made
# check-file-size.sh's own success line die of SIGPIPE — `head` exits at 3 lines,
# `sort` dies writing the rest, `pipefail` propagates 141 and `set -e` aborts the
# whole test file before the summary. `awk 'NR <= 3'` prints the same three lines
# and reads to EOF, so nothing downstream of `sort` stops early.
ledger_ranked="$(instrument_rank "$(awk -F'\t' '!/^#/ && NF == 2 { print $1 "\t" $2 }' "$real_baseline")")"
ledger_top3="$(printf '%s\n' "$ledger_ranked" | awk 'NR <= 3 { print $2 }')"
tree_top3="$(printf '%s\n' "$tree_ranked" | awk 'NR <= 3 { print $2 }')"

assert_eq "the ledger holds a top three at all" "3" \
  "$(printf '%s\n' "$ledger_top3" | grep -c . || true)"
assert_eq "the ledger's recorded figures run largest-first" "" \
  "$(awk -F'\t' '!/^#/ && NF == 2 { seen++; if (seen > 1 && $1 > prev) print "entry " seen ": " $1 " > " prev; prev = $1 }' "$real_baseline")"

top3_unwalked=""
while IFS= read -r top_path; do
  [[ -z "$top_path" ]] && continue
  grep -qxF -- "$top_path" <<<"$real_walk" || top3_unwalked="$top3_unwalked$top_path"$'\n'
done <<<"$ledger_top3"
assert_eq "and each of the ledger's three largest is a tracked production file this walk visits" \
  "" "$top3_unwalked"

assert_eq "the ledger's top three are the three files the whole-file instrument measures as largest (recomputed, order-free)" \
  "$(printf '%s\n' "$tree_top3" | LC_ALL=C sort)" "$(printf '%s\n' "$ledger_top3" | LC_ALL=C sort)"

# 18d. THE POSITIVE LINE NAMES THE BIGGEST FILE THE INSTRUMENT SAW — the largest
#      file RECOMPUTED from the tree, path AND figure, so this case tracks the tree
#      instead of freezing it. Same claim as 18c(3), taken from the guard's own
#      output rather than from the ledger. The FIGURE is part of the needle on
#      purpose: a guard cutting at `#[cfg(test)]` still names the right FILE here
#      (db.rs) and the wrong NUMBER (2,152, not 2,154), so pinning the pair keeps
#      18d carrying teeth of its own instead of merely restating 18c.
run_check "$repo_root"
# `-F'\t'` and not whitespace splitting: the guard reads its own `<count><TAB><path>`
# lines by cutting at the FIRST tab precisely so a path containing a space stays one
# path, and a whitespace-splitting mirror would truncate such a path here.
expected_largest="$(printf '%s\n' "$tree_ranked" | awk -F'\t' 'NR == 1 { print "largest " $2 " " $1 }')"
# `assert_contains` with an EMPTY needle passes, so a recomputation that produced
# nothing would turn this case into a green that checked nothing — the same
# "confident green built on a measurement that read nothing" the guard itself
# refuses. Pinned well-formed first, so the needle is known to carry BOTH a path
# and a figure and not merely the word `largest`.
assert_eq "and the recomputed largest-file expectation has the shape \`largest <path> <figure>\`" \
  "ok" "$(case "$expected_largest" in
            'largest '*[![:space:]]' '[0-9]*) echo ok ;;
            *) echo "malformed: [$expected_largest]" ;;
          esac)"
assert_contains "the success line names the file the instrument measures as largest, with its figure" \
  "$expected_largest" "$output"

# 18b-TEETH. THE CUT INSTRUMENT, SIMULATED, so the pin in 18b is PROVEN to catch it
# rather than merely asserted to (AGENTS.md: a pin that passes on the broken thing
# is worse than no pin). The fixture is case 13c's shape — 700 production code lines
# plus a 13-line inline `mod tests` — which the whole-file instrument reads at 713
# and a census instrument reads at 700. Its ledger entry is then REWRITTEN to the
# figure the census instrument would have recorded, which IS the broken state, and
# the sweep predicate must name it. The honest ledger is asserted clean first, so a
# predicate that fires on nothing cannot hide behind its own plant.
fixture cut_instrument_ledger
{
  emit_code 700 'const p'
  printf '#[cfg(test)]\n'
  printf 'mod tests {\n'
  emit_code 10 '    const t'
  printf '}\n'
} >"$root/src-tauri/src/cutledger.rs"   # 700 + 13 = 713 whole-file; 700 under a cut
git -C "$root" add -A
run_check "$root" --update
assert_eq "the cut-instrument fixture seeds at the whole-file figure" "713" \
  "$(baseline_count "$root/scripts/file-size-baseline.txt" 'src-tauri/src/cutledger.rs')"
assert_eq "an honest ledger draws no complaint from the cfg(test)-cut sweep" \
  "" "$(ledger_entries_cut_short "$root")"
# THE BROKEN INSTRUMENT, spelled as a number: the row a census ratchet writes.
awk -F'\t' 'BEGIN { OFS = "\t" } $2 == "src-tauri/src/cutledger.rs" { $1 = 700 } { print }' \
  "$root/scripts/file-size-baseline.txt" >"$root/ledger.tmp"
mv "$root/ledger.tmp" "$root/scripts/file-size-baseline.txt"
assert_eq "TEETH: a ledger seeded by a cfg(test)-cutting instrument is refused" \
  "src-tauri/src/cutledger.rs(rec=700<=cut=700)" \
  "$(ledger_entries_cut_short "$root")"

# --- helpers for case 18e -------------------------------------------------
# The exemption table, read out of the instrument itself and never re-listed
# here: an exemption someone added there and this file did not know about would
# otherwise redden a pin for an absence everyone had already agreed to.
ledger_is_exempt() {
  sed -n '/^exemption_table()/,/^TABLE/p' "$check_script" |
    awk -F'\t' -v q="$1" '$1 == q { found = 1 } END { exit !found }'
}

# Ledger entries naming a path this walk does not visit. Empty output = none.
ledger_dead_entries() {
  local r="$1" paths="$2" p bad=""
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    grep -qxF -- "$p" <<<"$paths" || bad="$bad$p"$'\n'
  done < <(awk -F'\t' '!/^#/ && NF == 2 { print $2 }' "$r/scripts/file-size-baseline.txt")
  printf '%s' "$bad"
}

# Production files over the seed threshold with NO ledger entry, exemptions
# excepted. The threshold is spelled here as the number the ledger's own header
# publishes; the two exempt files sit ABOVE it (scene.ts 729, everforest.ts 707)
# and are absent from the ledger by agreement, which is why the exemption check
# is not optional — without it this pin reddes on a green tree.
ledger_missing_entries() {
  local r="$1" paths="$2" p n bad=""
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    ledger_is_exempt "$p" && continue
    n="$(grep -vcE '^[[:space:]]*(//|\*|/\*|$)' -- "$r/$p" || true)"
    n="${n:-0}"
    ((n > 700)) || continue
    awk -F'\t' -v q="$p" '$2 == q { found = 1 } END { exit !found }' "$r/scripts/file-size-baseline.txt" ||
      bad="$bad$p($n)"$'\n'
  done <<<"$paths"
  printf '%s' "$bad"
}

# 18e. THE BASELINE IS MACHINE-GENERATED, NOT HAND-AUTHORED.
#
# WHY THE FORM THIS CASE HAD WAS WRONG TWICE OVER. It ran `--update` against the
# real checkout and required the committed ledger to come back UNCHANGED.
#
#   (1) `--update` WRITES `scripts/file-size-baseline.txt`. Measured: one run of
#       this file left `git status --porcelain` reporting ` M` on that tracked
#       file — every CI run of this suite dirtied the very tree it was testing,
#       which is the thing case 18c's own comment forbids ("a test must not
#       rewrite a tracked file in the tree it is testing"). Guarded at the end of
#       this file, so it cannot come back quietly.
#   (2) EXACT EQUALITY IS THE WRONG PROXY, and it is red by design in the normal
#       state of the plan this case belongs to. The ratchet refuses GROWTH only,
#       so a ledger figure left ABOVE a shrunk file is the intended state for the
#       whole middle of a decomposition: the committed ledger holds `router.rs` at
#       1388 while Task 1 of this plan cut it to 1343, and Tasks 2, 3, 4, 6 and 7
#       each shrink another baselined file. An equality assertion therefore reddens
#       after every remaining wave, and silencing it by regenerating the ledger
#       would be the test editing the ledger it exists to police — that
#       regeneration is the orchestrator's scheduled act, not a test's.
#
# WHAT IT PINS NOW — the two hand-authoring moves that make a ledger decorative,
# each by PREDICATE rather than by `--update`'s diff, so neither touches the tree:
#
#   - AN ENTRY FOR A PATH THE WALK DOES NOT VISIT: a rename nobody followed, or a
#     fabricated path. A dead entry guards nothing, and no later reader can tell it
#     apart from a file that simply moved.
#   - A FILE OVER THE 700-LINE SEED THRESHOLD WITH NO ENTRY: deleting one line is
#     otherwise all it takes to dodge the ratchet on a 2,000-line file. The guard
#     does NOT refuse this itself — it refuses an un-ledged file only above the
#     1,000 HARD_GATE, so a 700-to-1,000 file can be dropped from the ledger and
#     then grow freely. Measured against the guard as it stands: an 800-code-line
#     file with its ledger entry deleted exits 0, and exits 0 again after growing
#     to 999 lines. Same for a dead entry — a ledger naming a file that no longer
#     exists exits 0.
#
# Both predicates are LAG-TOLERANT by construction: neither compares a ledger
# NUMBER against today's measurement, so a mid-plan shrink stays green. The one
# number-comparison made below is the one direction a lag cannot imitate — an
# entry may sit ABOVE its file's current figure (a shrink not yet re-seeded) and
# never BELOW it, because below is a growth the ratchet must already refuse.
#
# TEETH, PROVEN AND NOT ASSUMED (AGENTS.md: a pin that passes on the broken thing
# is worse than no pin). Each predicate runs against an honest ledger first, so a
# pin that fires on nothing cannot hide, and then against its own plant, where it
# must name the planted path.
fixture ledger_dead_entry
emit_code 800 'const p' >"$root/src-tauri/src/alive.rs" # 800 code lines: seeded
git -C "$root" add -A
run_check "$root" --update
assert_eq "the dead-entry fixture seeds (--update exits 0)" "0" "$status"
dead_walk="$(ledger_walk_paths "$root")"
assert_eq "an honest ledger draws no complaint from the dead-entry pin" \
  "" "$(ledger_dead_entries "$root" "$dead_walk")"
printf '999\tsrc-tauri/src/RETIRED_NEVER_EXISTED.rs\n' >>"$root/scripts/file-size-baseline.txt"
assert_eq "TEETH: a ledger entry naming a path the walk never visits is refused" \
  "src-tauri/src/RETIRED_NEVER_EXISTED.rs" "$(ledger_dead_entries "$root" "$dead_walk")"

fixture ledger_dropped_entry
emit_code 800 'const p' >"$root/src-tauri/src/alive.rs" # 800 code lines: seeded
git -C "$root" add -A
run_check "$root" --update
assert_eq "the dropped-entry fixture seeds (--update exits 0)" "0" "$status"
dropped_walk="$(ledger_walk_paths "$root")"
assert_eq "an honest ledger draws no complaint from the missing-entry pin" \
  "" "$(ledger_missing_entries "$root" "$dropped_walk")"
# THE DODGE ITSELF: one deleted line, and an 800-code-line file is off the ratchet.
grep -v 'src-tauri/src/alive.rs' "$root/scripts/file-size-baseline.txt" >"$root/ledger.tmp"
mv "$root/ledger.tmp" "$root/scripts/file-size-baseline.txt"
assert_eq "TEETH: a file over 700 code lines with its ledger entry deleted is refused" \
  "src-tauri/src/alive.rs(800)" "$(ledger_missing_entries "$root" "$dropped_walk")"

# ... and the same two predicates over the COMMITTED ledger of the real checkout,
# mutation-free: the file is read, never regenerated.
real_walk="$(ledger_walk_paths "$repo_root")"
assert_eq "the committed ledger names no path this walk does not visit" \
  "" "$(ledger_dead_entries "$repo_root" "$real_walk")"
assert_eq "the committed ledger holds an entry for every production file over 700 code lines (exemptions excepted)" \
  "" "$(ledger_missing_entries "$repo_root" "$real_walk")"

# THE ONE DIRECTIONAL NUMBER CHECK, the only one safe to make while a plan is
# shrinking files: above today's figure is a lag, below it is a growth.
understated=""
while IFS=$'\t' read -r rec u_path; do
  [[ -f "$repo_root/$u_path" ]] || continue
  act="$(grep -vcE '^[[:space:]]*(//|\*|/\*|$)' -- "$repo_root/$u_path" || true)"
  act="${act:-0}"
  ((rec < act)) && understated="$understated$u_path($rec<$act)"$'\n'
done < <(awk -F'\t' '!/^#/ && NF == 2 { print $1 "\t" $2 }' "$real_baseline")
assert_eq "and no entry UNDERSTATES its file (above is a shrink not yet re-seeded, below is a growth)" \
  "" "$understated"

# The mirrored walk is only trustworthy while it agrees with the instrument, and
# the guard's own positive line is the cheapest witness: a pathspec or exclusion
# drifting apart would otherwise un-pin both real-tree assertions in silence.
run_check "$repo_root"
n_mirrored="$(printf '%s\n' "$real_walk" | grep -c . || true)"
assert_contains "the mirrored walk agrees with the guard's own count" \
  "$n_mirrored production file(s) walked" "$output"

# THE MUTATION GUARD, in two independent witnesses. The direct proof that this
# file no longer rewrites the tree it tests — asserted HERE rather than watched by
# hand, because a case that silently dirties the tree under test reports its own
# green and leaves the next run red.
#
#   (a) the ledger's content hash is the one captured at the top of this file, so
#       a `--update` over the real tree reintroduced ANYWHERE in this file reddes
#       here — including in a case added after this one, which is why the guard
#       sits LAST, after every case, and not inside 18e where it could only see
#       what ran before it;
#   (b) `git status` reports the tracked path clean, the shape the plan asked for.
#       It is also the stricter of the two: a ledger that arrived dirty from
#       OUTSIDE this suite reddes (b) while (a) stays green, and that split is the
#       diagnosis — (a) red means this suite rewrote its own test input, (b) alone
#       red means the tree was already dirty before the suite ran. A tracked
#       ledger dirty during a CI run is worth seeing either way, so the stricter
#       reading is kept.
baseline_post_hash="$(cksum "$repo_root/scripts/file-size-baseline.txt" 2>/dev/null || true)"
assert_eq "this run leaves the tracked baseline byte-for-byte as it found it (no case may rewrite the ledger it tests)" \
  "$baseline_pre_hash" "$baseline_post_hash"
assert_eq "and git status reports the tracked baseline clean after the whole suite" \
  "" "$(git -C "$repo_root" status --porcelain -- scripts/file-size-baseline.txt)"


if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
