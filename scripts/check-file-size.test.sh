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

# 18b. THE INSTRUMENT PIN ON THE REAL TREE. The committed baseline must record
#      `src-tauri/src/agent/session/naming.rs` ABOVE what a `#[cfg(test)]`-cut
#      instrument would give it. naming.rs is where the two instruments disagree
#      by ~1,670 lines, so this asks the census-vs-ratchet question of the real
#      checkout — and it survives any later shrink, because it compares the two
#      instruments rather than a frozen number.
real_baseline="$repo_root/scripts/file-size-baseline.txt"
if [[ -f "$real_baseline" ]]; then
  recorded="$(baseline_count "$real_baseline" 'src-tauri/src/agent/session/naming.rs')"
  cut_figure="$(awk '/#\[cfg\(test\)\]/{exit} {print}' "$repo_root/src-tauri/src/agent/session/naming.rs" | grep -vcE '^[[:space:]]*(//|\*|/\*|$)' || true)"
  if [[ -z "$recorded" ]]; then
    echo "FAIL the committed baseline has no entry for src-tauri/src/agent/session/naming.rs (the largest file in the tree)"
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

# 18c. THE THREE LARGEST, in order, read out of the committed baseline: naming.rs,
#      db.rs, session/mod.rs. `db.rs` is the largest under EVERY instrument tried,
#      so "db.rs first means your instrument is wrong" proves nothing — whereas
#      naming.rs beating db.rs happens ONLY when an inline `mod tests` is counted,
#      which is exactly the choice this task made. Read from the file rather than
#      by running `--update` against the real checkout: a test must not rewrite a
#      tracked file in the tree it is testing.
top3="$(awk -F'\t' '!/^#/ && NF == 2 { print }' "$real_baseline" | sort -rn | head -n3 | cut -f2)"
expected_top3="$(printf '%s\n' 'src-tauri/src/agent/session/naming.rs' 'src-tauri/src/storage/db.rs' 'src-tauri/src/agent/session/mod.rs')"
assert_eq "the baseline's three largest, in order, are naming.rs, db.rs, session/mod.rs" "$expected_top3" "$top3"

# 18d. The positive line names the largest file, and it is naming.rs — the same
#      claim as 18c, taken from the run's own output rather than the file.
run_check "$repo_root"
assert_contains "the success line names the largest file, and it is naming.rs" "largest src-tauri/src/agent/session/naming.rs" "$output"

# 18e. The committed baseline is what the instrument GENERATES. The plan's rule is
#      that the baseline and the instrument cannot disagree, so the only admissible
#      generation route is `--update`. Asserted by running `--update` over the real
#      tree and requiring it to report the baseline UNCHANGED — which is also why
#      `--update` writes nothing when nothing moved: a test that regenerates a
#      tracked file would be a test that dirties the tree it is testing.
run_check "$repo_root" --update
assert_eq "--update over the real tree exits 0" "0" "$status"
assert_contains "and reports the committed baseline unchanged (so it is exactly what --update generates)" "unchanged" "$output"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
