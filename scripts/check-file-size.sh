#!/usr/bin/env bash
#
# THE SIZE TRIPWIRE, AS A RATCHET ON CODE LINES.
#
# The census this descended from was an argument, not a check: raw `wc -l` flagged
# 117 production files over 200 lines and a code-line instrument flagged 75, and the
# difference was settled by hand. This script makes the instrument a script, so the
# next census starts from a rule instead of a re-litigation. It is a LOOK-AT
# TRIPWIRE, NOT A DEFECT THRESHOLD: subject count is still what decides whether a
# split is done (AGENTS.md), and size is NOT a defect predictor here — fix density
# by size band is non-monotonic (600-1000 worst at 2.61/kLOC, 1000+ at 1.79),
# size~relative-churn r=0.057, and zero known-gaps defects and zero audit findings
# attribute a defect to file length. So the mechanism is a RATCHET: nothing may
# grow past what is recorded in `file-size-baseline.txt`, and a rise is a visible
# `--update` diff in the PR body rather than a CI red someone silences by editing a
# threshold.
#
# THE INSTRUMENT — one literal command, a line classifier, and deliberately NOT
# the census's:
#
#     code=$(grep -vcE '^[[:space:]]*(//|\*|/\*|$)' "$f")
#
# Drops blank lines, whole-line `//`, block-comment continuation lines starting
# `*`, and lines starting `/*`. KNOWN LIMIT, pinned by a test: a JSX comment's
# braces are NOT stripped, so `{/* … */}` counts as code. The bar is 1,000 code
# lines and the largest .tsx file here is 622, so the limit costs nothing today; it
# is stated because an unlisted inaccuracy in a metric becomes an argument later.
#
# IT COUNTS AN INLINE `#[cfg(test)] mod tests` AS PART OF THE FILE. That diverges
# from the census ON PURPOSE. The census audited PRODUCTION size and correctly cut
# the tests; a ratchet guards against GROWTH, and a cut-at-`#[cfg(test)]` ratchet
# can be satisfied by MOVING code into the test module — the measured number
# shrinks and nothing real changes. A whole-file count cannot be dodged that way.
# Inline test modules are therefore NOT excluded, and nothing inside a production
# file is excluded: a file cannot shed 1,500 lines of tests to slip under the bar.
# Directories named `tests` (`src-tauri/tests/`, `src/**/tests/`) and `*.test.ts(x)`
# ARE excluded — they are test sources, not production — which is why the walk
# names `src-tauri/tests` in its pathspecs and then retires those files.
#
# RECONCILING THE TWO INSTRUMENTS, because both sets of figures appear in the plan.
# Rust files with big inline test modules diverge HARD; TS/TSX never diverge,
# because a .tsx file has no inline test module. This ratchet uses the MIDDLE
# column. (Re-measured at 1355cd2a, this task's base — `--update` is the only
# authoritative source for current numbers.)
#
#   file                                   raw   whole-file   census(cfg-cut)
#   src-tauri/src/agent/session/naming.rs 3193         2259               585
#   src-tauri/src/storage/db.rs           4308         2154              2152
#   src-tauri/src/agent/session/mod.rs    3112         1563              1561
#   src-tauri/src/agent/session/router.rs 2286         1388               496
#   src/store/sessions.ts                 2928         1370              1370
#   src-tauri/src/config.rs               1810         1289               259
#   src-tauri/src/agent/errors.rs         1719         1135               497
#   src-tauri/src/commands/settings.rs    1530         1070               442
#   src-tauri/src/commands/agents.rs      1603         1055               140
#   src/components/SpacesList.tsx         1234          622               622
#   src/components/AgentsDialog.tsx        934          550               550
#   src/components/TasksBoard.tsx          751          398               398
#
# THE COUNTS THAT FOLLOW (same base): 298 production files walked — two more than
# the 296 the plan states, because the plan's illustrative `**` pathspecs miss the
# depth-1 files (see THE WALK below) — and over 200 -> 75, over 500 -> 27, over 700
# -> 13, over 1000 -> 9, over 1500 -> 3. The 13 files over 700 are the 11 the
# instrument RECORDS (`scripts/file-size-baseline.txt`) plus the 2 it EXEMPTS —
# `scene.ts` 729 and `everforest.ts` 707 — which is why the baseline has 11 lines
# and the census says 13: an exemption means "not ratcheted", and an exempt file
# that is not in the ledger is the only way to say that. The census's cfg-cut
# instrument gives 67 / 17 / 5 / 3 / 2 at the same thresholds, which is why "1,000
# flags 10 files" had to be restated: the honest figure is 9 under THIS ratchet and
# 3 under the census's. 1,000 is still the right place for the bar; the number
# attached to it is the one the script actually runs.
#
# A VACUITY FLOOR closes the loop (check-commands.sh calls it a blind-walk
# tripwire): a walk that finds fewer than 250 production files, or finds ZERO files
# over 500 code lines, is REFUSED. A metric that read no file must not read as
# green. That is this guard's most important line.
#
# Usage: check-file-size.sh [repo-root] [--self-test] [--update]   (root default: .)
#   repo-root    the checkout to read (its `src-tauri/src`, `src`, and this file's
#                own `scripts/file-size-baseline.txt`)
#   --self-test  plant fixtures under a throwaway root and prove THIS guard —
#                re-invoked, never a second implementation — can still fail
#   --update     rewrite `scripts/file-size-baseline.txt` from the tree and print
#                the diff, so an intentional rise is a reviewable one-line change

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [repo-root] [--self-test] [--update]" >&2
}

fail() {
  printf 'error: %s\n' "$1" >&2
  if [[ $# -gt 1 ]]; then
    shift
    local line
    for line in "$@"; do
      printf '       %s\n' "$line" >&2
    done
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# THE NUMBERS.
#
# HARD_GATE and SEED_THRESHOLD are policy. The FLOORs are the blind-walk tripwire:
# they are what the walk measures TODAY (298 files, 27 files over 500) rounded DOWN
# to where only a walk that read nothing can trip them, and they are deliberately
# NOT the current counts — a file legitimately splitting in two, or a 299th file
# landing, passes untouched. A floor that has to be raised for ordinary work is a
# floor that gets deleted.
HARD_GATE=1000     # refuse a production file crossing this unless it is baselined
SEED_THRESHOLD=700 # `--update` records files ABOVE this. Deliberate consequence,
                   # stated rather than buried: a file at or below 700 is not
                   # recorded, so it can grow unwatched until it crosses the gate.
                   # Raising the threshold tightens the ratchet and makes every
                   # ordinary file a re-baseline; lowering it to 200 would put 75
                   # files in the ledger and get this file deleted.
OVER_500_BAR=500
FLOOR_FILES=250
FLOOR_OVER_BIG=1

# The baseline lives next to the instrument, so the two cannot be edited apart.
BASELINE_REL="scripts/file-size-baseline.txt"

# A literal TAB, spelled once. `sort -t"$TABS"` and `${x%%"$TABS"*}` are used
# instead of an inline tab because a tab inside a `${…}` is invisible to a reader
# and to every future diff.
TABS="$(printf '\t')"

# ---------------------------------------------------------------------------
# THE EXEMPTIONS — `path<TAB>reason`, one per line, reason MANDATORY on the same
# line (an unexplained exemption is how a permanent free pass arrives, and a
# reasonless line is itself a refusal). An exemption buys exactly ONE thing:
# freedom to grow past a recorded baseline WITHOUT an `--update` diff. The hard
# 1,000 gate still applies to an exempt file, so this list is not a licence.
#
# Measured with this instrument, FOUR production files sit in the 700-1,000 band:
# `provider_auth/refresh.rs` 866, `commands/update.rs` 734, `scene.ts` 729,
# `palettes/everforest.ts` 707. NONE crosses the 1,000 gate, so an exemption buys
# nothing at all for the first two — they are ordinary logic, and ordinary logic is
# what a ratchet is for. They are NOT exempt. (The census's inherited exemption
# named "scene.ts and the four palettes"; six of the seven `palettes/*.ts` files are
# 227-557, nowhere near the bar, so a blanket palette exemption guards nothing and
# hides the one palette file that is here. `paletteTestKit.ts`, which the census
# exempted "by role", is 636 code lines — under the 700 seed threshold, so it never
# enters the baseline and needs no exemption line. Do not add one.)
#
# READ THE REASONS AS WHAT IS UNCOVERED, NOT AS COVERAGE. An exemption that reads
# "there is a reference image" invites someone to delete it as stale.
exemption_table() {
  # path <TAB> reason (what the ratchet CANNOT see here — not a claim of coverage)
  cat <<'TABLE'
src/lib/archimedes-film/scene.ts	The only check that would report a broken split is a manual rendered-frame comparison against /tmp/film-ref-6p5s.png, which is not in the repo — no automated test guards this file. `scene.test.ts` (346 lines, 89 assertions) covers ONLY the two pure exports `evaluateChoreography` and `solveLimbIK`, and its own header says "The look of the film is NOT testable this way", because a Float32Array of luminance that is uniformly wrong passes any number of unit tests. `createScene` spans :367-732 and is never constructed by a test, so a split of the scene graph has no automated consequence at all. This is NOT a data table: it is 0 data lines and 729 code lines of graphics engine.
src/lib/palettes/everforest.ts	The published-hex tables (`publishedHexes`, `FILE_DESCRIPTORS`, `WORST_ON_CHAT`, `SHARES`, `DEFAULT_DARK_DESCRIPTOR_HEX`) are carried verbatim from upstream's palette.md and cannot be edited down to satisfy a line count without changing a shipped color, so the only growth this file can have is "upstream published another hex". The VALUES are checked (paletteCompleteness / themeTokens / fileIconContrast / everforestPalette tests); what is NOT checked is that a restructure keeps every entry — that is the part this exemption is about, and it is a gap, not a coverage claim.
TABLE
}

# ---------------------------------------------------------------------------
# THE INSTRUMENT. One file in, one integer out.
#
# `grep -c` prints `0` AND EXITS 1 when nothing matches, so the status is absorbed
# (`|| true`) and the VALUE is what is read — a file of nothing but comments
# legitimately measures 0 and must not look like a failed measurement. The verdict
# is never taken from grep's exit status (the trap check-temp-dir-census.sh
# documents for `grep -Fxv -f`, arriving here from the opposite direction).
code_lines() {
  local file="$1" n
  n="$(grep -vcE '^[[:space:]]*(//|\*|/\*|$)' -- "$file" || true)"
  printf '%s\n' "${n:-0}"
}

# ---------------------------------------------------------------------------
# THE WALK. Tracked files under the production roots, production only.
#
# WHY DIRECTORIES AND NOT THE PLAN'S `**` GLOB PATTERNS — a real trap, measured on
# this repo, not a stylistic preference: `git ls-files 'src-tauri/src/**/*.rs'` does
# NOT match `src-tauri/src/config.rs`, because git's `**` still requires at least
# one `/`. Nine top-level Rust files (including `config.rs` at 1,289 code lines and
# `errors.rs` at 1,135, both over the gate) and every depth-1 file under `src/`
# (including `src/App.tsx`) vanish from that walk, and the guard prints a confident
# green. Passing the DIRECTORIES and filtering the extension here is what makes the
# 298-file denominator and the 9-over-1,000 figure reproducible.
walk_production_files() {
  local root="$1" rel
  # `-z` end to end: a path containing a space must not become two files, or a file
  # that cannot be opened and that a `while read` loop would skip in silence.
  git -C "$root" ls-files -z -- src-tauri/src src-tauri/tests src |
    while IFS= read -r -d '' rel; do
      case "$rel" in
        *.rs) ;;
        *.ts | *.tsx) ;;
        *) continue ;;
      esac
      # Not production: a `*.test.ts(x)` sibling, or anything under a directory
      # named `tests` (which is what retires `src-tauri/tests/**` again — the
      # pathspec above names it so the exclusion is a decision on the record, not an
      # accident of a pattern). An inline `#[cfg(test)] mod tests` is INSIDE a
      # production file and is NOT retired: see the header.
      case "$rel" in
        *.test.ts | *.test.tsx) continue ;;
      esac
      case "/$rel" in
        */tests/*) continue ;;
      esac
      printf '%s\0' "$rel"
    done |
    LC_ALL=C sort -z
}

# The baseline's one permitted line shape: `<digits><TAB><path>`. Held in a
# variable rather than inline because a raw TAB inside `[[ … =~ … ]]` is a parse
# error in bash, and a `\t` escape is not portable between regex engines — a
# variable holding a real tab is the only spelling that is unambiguous.
BASELINE_LINE_RE=$'^([0-9]+)\t(.+)$'

# ---------------------------------------------------------------------------
# The baseline: `<count><TAB><path>` per line, `#` comments and blanks ignored.
# A line that is not `<digits><TAB><path>` is REFUSED, not skipped — a parser that
# waves through what it cannot read silently un-ratchets that file, and every entry
# in this file is a promise.
read_baseline() {
  local file="$1" out="$2" lineno=0 line
  : >"$out"
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ ! "$line" =~ $BASELINE_LINE_RE ]]; then
      fail "the baseline has a malformed line ($file:$lineno): $line" "the format is <count><TAB><path>; a line this script cannot read is a file this script does not guard, so it is a refusal and not a skip"
    fi
    printf '%s\t%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" >>"$out"
  done <"$file"
}

# ---------------------------------------------------------------------------
# The guard.
run_guard() {
  local root="$1" update="$2"

  if [[ ! -d "$root" ]]; then
    echo "error: repo root is not a directory: $root" >&2
    usage
    exit 1
  fi
  # In a non-repo, `git ls-files` prints nothing and exits 0 — the walk would be
  # empty, and an empty walk is the vacuous green the floor below exists to refuse.
  # Say what is actually wrong rather than letting the floor report a mystery.
  if ! git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1; then
    fail "the repo root is not a git checkout, so there is nothing for \`git ls-files\` to walk: $root" "this guard reads TRACKED files only — run it inside the clone (a failed search is not an empty one)"
  fi
  if [[ ! -d "$root/src-tauri/src" && ! -d "$root/src" ]]; then
    fail "neither production root exists under $root (src-tauri/src, src)" "run this from the repo root, or pass the repo root"
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp_dir'" EXIT

  local walked_file="$tmp_dir/walked"
  : >"$walked_file"
  local rel
  while IFS= read -r -d '' rel; do
    printf '%s\n' "$rel" >>"$walked_file"
  done < <(walk_production_files "$root")

  local n_walked
  n_walked="$(wc -l <"$walked_file" | tr -d ' ')"

  # --- the VACUITY FLOOR (blind-walk tripwire) --------------------------------
  # FIRST, before anything else is believed, and in both modes: a `--update` off a
  # walk that read nothing would otherwise write an empty baseline and make every
  # later run green forever. This is the guard's most important line.
  if ((n_walked < FLOOR_FILES)); then
    fail "the walk is BLIND: $n_walked production file(s) walked under $root, floor is $FLOOR_FILES" "a metric that read no file must not read as green (this tree holds ~298 tracked production .rs/.ts/.tsx files)" "check the walk's pathspecs against the tree: \`git ls-files -z -- src-tauri/src src-tauri/tests src\`"
  fi

  # Measure every walked file: `<count><TAB><path>`.
  local measured_file="$tmp_dir/measured"
  : >"$measured_file"
  local n
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    n="$(code_lines "$root/$rel")"
    printf '%s\t%s\n' "$n" "$rel" >>"$measured_file"
  done <"$walked_file"

  local n_over_big
  n_over_big="$(awk -F'\t' -v bar="$OVER_500_BAR" '$1 > bar { c++ } END { print c + 0 }' "$measured_file")"
  if ((n_over_big < FLOOR_OVER_BIG)); then
    fail "the walk is BLIND: $n_over_big file(s) over $OVER_500_BAR code lines among $n_walked walked files, floor is $FLOOR_OVER_BIG" "this tree holds 27 such files, so ZERO means the classifier stopped classifying (or the walk opened nothing) — either way this is not a green"
  fi

  # --- exemptions: validated, then applied ------------------------------------
  local exempt_file="$tmp_dir/exempt"
  : >"$exempt_file"
  local ex_path ex_reason
  while IFS=$'\t' read -r ex_path ex_reason _rest; do
    [[ -z "$ex_path" || "$ex_path" == \#* ]] && continue
    if [[ -z "${ex_reason//[[:space:]]/}" ]]; then
      fail "an exemption must carry a cited reason on the same line (an unexplained exemption is how a permanent free pass arrives): $ex_path"
    fi
    # An exemption naming a file the walk did not see excuses nothing; it only
    # parks a typo or outlives a rename, and no later reader can tell which.
    if ! grep -qxF -- "$ex_path" "$walked_file"; then
      fail "an exemption names no production file this walk saw: $ex_path" "either the file moved or it left scope — delete the exemption or fix the path; a stale exemption is how an exemption list stops meaning anything"
    fi
    printf '%s\n' "$ex_path" >>"$exempt_file"
  done < <(exemption_table)

  # --- the baseline ------------------------------------------------------------
  local baseline="$root/$BASELINE_REL"
  local baseline_rows="$tmp_dir/baseline.rows"
  local baseline_present=1
  if [[ -r "$baseline" ]]; then
    read_baseline "$baseline" "$baseline_rows"
  else
    : >"$baseline_rows"
    # `--update` is the generation route, so it may create the file. A plain CHECK
    # with no baseline is an UNCHECKED run: with no ledger every grandfathered file
    # would read as a fresh violation, or the ratchet would simply be absent. Either
    # way the run must not print the clean line.
    if ((update == 0)); then
      fail "the baseline file is missing or unreadable: $BASELINE_REL" "this run is UNCHECKED, not clean — generate it with \`bash scripts/check-file-size.sh --update\` and commit the output"
    fi
    baseline_present=0
  fi

  # --- `--update`: regenerate the baseline and print the diff ------------------
  if ((update == 1)); then
    # The baseline's directory must exist to write it. In this repo it always does
    # (this script lives in it), so a missing one means the wrong root was passed,
    # and a bare `set -e` redirect failure would not say that.
    if [[ ! -d "$root/$(dirname "$BASELINE_REL")" ]]; then
      fail "--update cannot write the baseline: no $(dirname "$BASELINE_REL") directory under $root" "run this from the repo root, or pass the repo root"
    fi
    local new_baseline="$tmp_dir/baseline.new"
    # Files ABOVE the seed threshold, exempt files excluded, biggest first (ties
    # broken by path, so a re-run is byte-identical and the diff is the only noise).
    # `FILENAME == exf` and NOT the usual `NR == FNR` first-file idiom: that idiom
    # misfires when the first file is EMPTY (awk skips it, reads the second file's
    # records as exemptions, and seeds nothing) — and an exemption list someone
    # empties is exactly the input this script has to survive.
    awk -F'\t' -v bar="$SEED_THRESHOLD" -v exf="$exempt_file" '
      FILENAME == exf { exempt[$1] = 1; next }
      $1 > bar && !($2 in exempt) { print }
    ' "$exempt_file" "$measured_file" |
      LC_ALL=C sort -t"$TABS" -k1,1rn -k2,2 >"$new_baseline"

    local n_entries n_old_entries=0 diff_status=0
    n_entries="$(wc -l <"$new_baseline" | tr -d ' ')"
    if ((baseline_present == 1)); then
      n_old_entries="$(wc -l <"$baseline_rows" | tr -d ' ')"
    fi

    diff -u "$baseline_rows" "$new_baseline" >"$tmp_dir/diff" 2>/dev/null || diff_status=$?
    if ((diff_status == 2)); then
      fail "diff could not compare the baseline against the regenerated one (exit 2)" "a diff that could not run is not a baseline that did not change"
    fi

    if ((diff_status == 0 && baseline_present == 1)); then
      printf 'baseline unchanged: %s file(s) over %s code lines recorded in %s\n' "$n_entries" "$SEED_THRESHOLD" "$BASELINE_REL"
    else
      # The diff IS the product: an intentional rise has to be a line a reviewer
      # sees, not a file that silently got rewritten. Both sides are HEADER-STRIPPED
      # entry lists (`baseline_rows` is what `read_baseline` parsed), so the header
      # this script writes can never show up as a spurious change.
      if ((baseline_present == 0)); then
        printf 'baseline created in %s: %s file(s) over %s code lines\n' "$BASELINE_REL" "$n_entries" "$SEED_THRESHOLD"
      else
        printf 'baseline changed (%s -> %s entries) in %s:\n' "$n_old_entries" "$n_entries" "$BASELINE_REL"
        sed -n '3,$p' "$tmp_dir/diff" | sed 's/^/  /'
      fi
      {
        printf '# Size ratchet baseline — GENERATED by `bash scripts/check-file-size.sh --update`;\n'
        printf '# do not hand-edit. One <code-line-count><TAB><path> line per PRODUCTION file over\n'
        printf '# %s code lines, largest first. Exempt files (see the EXEMPTIONS table in\n' "$SEED_THRESHOLD"
        printf '# scripts/check-file-size.sh) are deliberately absent: an exemption means "not\n'
        printf '# ratcheted", and the hard %s-line gate still applies to them. Inline Rust\n' "$HARD_GATE"
        printf '# `#[cfg(test)] mod tests` ARE counted — that is what makes this ratchet undodgeable.\n'
        cat "$new_baseline"
      } >"$baseline"
      printf '  (justify any rise in the PR body: the ratchet exists so a growth is a decision)\n'
    fi
    # The verdict below must be taken against the ledger that was JUST written, not
    # the one that was there before. Without this, `--update` on a fresh tree would
    # seed `db.rs` at 2,154 and then refuse its own seed as an unbaselined file over
    # the gate — the documented generation route would exit 1 on the tree it just
    # made green.
    read_baseline "$baseline" "$baseline_rows"
  fi

  # --- the verdict -------------------------------------------------------------
  local violations="$tmp_dir/violations"
  : >"$violations"
  local n_violations=0

  local measured_count path baseline_count
  while IFS=$'\t' read -r measured_count path; do
    [[ -z "${path:-}" ]] && continue
    if grep -qxF -- "$path" "$exempt_file"; then
      # Exempt from the BASELINE only. The hard gate still applies, and this is the
      # line that keeps an exemption from being a licence.
      if ((measured_count > HARD_GATE)); then
        n_violations=$((n_violations + 1))
        printf '  %s: %s code lines — over the %s-line HARD GATE, and an exemption does not cover the gate\n' "$path" "$measured_count" "$HARD_GATE" >>"$violations"
      fi
      continue
    fi
    baseline_count="$(awk -F'\t' -v p="$path" '$2 == p { print $1; exit }' "$baseline_rows")"
    if [[ -z "$baseline_count" ]]; then
      if ((measured_count > HARD_GATE)); then
        n_violations=$((n_violations + 1))
        printf '  %s: %s code lines — over the %s-line hard gate with no baseline entry. This is a LOOK-AT tripwire, not a defect threshold: subject count is what decides a split. Either split it by subject, or record it with `bash scripts/check-file-size.sh --update` and justify it in the PR body.\n' "$path" "$measured_count" "$HARD_GATE" >>"$violations"
        printf '  re-measure it yourself: grep -vcE %s %s\n' "'^[[:space:]]*(//|\\*|/\\*|\$)'" "$path" >>"$violations"
      fi
      continue
    fi
    if ((measured_count > baseline_count)); then
      n_violations=$((n_violations + 1))
      printf '  %s: %s > baseline %s — either shrink it or re-run with --update and justify it in the PR body\n' "$path" "$measured_count" "$baseline_count" >>"$violations"
    fi
  done < <(LC_ALL=C sort -t"$TABS" -k1,1rn -k2,2 "$measured_file")

  if ((n_violations > 0)); then
    {
      printf 'error: %s production file(s) broke the size ratchet\n' "$n_violations"
      cat "$violations"
      printf '  the instrument is CODE lines, not raw lines: comments and blanks are stripped, an inline #[cfg(test)] mod tests is NOT\n'
      printf '  this is a look-at tripwire; subject count is still what decides whether a split is DONE (AGENTS.md, and size is not a defect predictor here)\n'
    } >&2
    exit 1
  fi

  # The positive line — the sibling prints `versions match: X.Y.Z`. A count and the
  # largest file make the claim checkable by eye: if the walked count falls off a
  # cliff, or the largest file is one nobody expected, the walk changed and this
  # green is not the green the guard advertises.
  #
  # THE SORT WRITES A FILE AND THE FIRST LINE IS READ FROM IT, never
  # `sort … | head -n1`. That was the shape here, and under `set -euo pipefail` it
  # was a race that killed this very line: `head` exits after one line and closes
  # the pipe, `sort` is still writing and dies of SIGPIPE (141), `pipefail`
  # propagates the 141, the command substitution returns non-zero, and `set -e`
  # aborts BEFORE the positive line prints — a guard whose green was intermittently
  # a silent 141, measured at ~1 run in 10 on this tree. It is not a `head`
  # peculiarity, it is any downstream reader that stops early: `sed -n 1q` short
  # reads the same way. There is no pipe in the construction below, so there is no
  # reader to close one — `sort`'s only destination is a file it writes to
  # completion, and `read` takes one line from a FILE whose remaining bytes nobody
  # has to consume. `head -n1 <"$largest_file"` would be a pipe again (to the
  # command substitution) and is deliberately not used.
  #
  # Pinned by `check-file-size.test.sh` case 16b, which runs this 25 times in a
  # row against a fixture sized so the old pipeline failed 24 of 25: one run of a
  # race proves nothing.
  local largest_file="$tmp_dir/largest"
  LC_ALL=C sort -t"$TABS" -k1,1rn -k2,2 "$measured_file" >"$largest_file"
  local largest_line="" largest_path="" largest_count=""
  # `IFS=` (and not a tab IFS) keeps the line intact so the two cuts below still
  # split at the FIRST tab, exactly as they did before. `|| true` is here because
  # `read` returns 1 at an EOF that carries no newline — an empty sort output must
  # reach the refusal below, not abort through `set -e` with 128+0.
  IFS= read -r largest_line <"$largest_file" || true
  if [[ -z "$largest_line" ]]; then
    # Unreachable behind both vacuity floors (they refuse a walk under 250 files
    # before this line), so this is not a guard against a real input, it is the
    # refusal that keeps the positive line TRUE whenever it does print: a
    # `largest  ` with nothing in either field is a confident green built on a
    # measurement that read nothing, which is what this whole script exists to
    # refuse.
    fail "the walk measured no file to rank, so there is no largest file to report under $root" "the positive line would print an empty count and an empty path; a green that cannot name the biggest file it saw is not a green"
  fi
  largest_count="${largest_line%%"$TABS"*}"
  largest_path="${largest_line#*"$TABS"}"
  printf 'file sizes within baseline: %s production file(s) walked, largest %s %s\n' "$n_walked" "$largest_path" "$largest_count"
}

# ---------------------------------------------------------------------------
# `--self-test`: the premise mode.
#
# A GREEN GUARD PROVES NOTHING. This mode plants fixtures under a throwaway root
# and re-invokes THIS script against them (`self_run` — never a second copy of the
# logic, which would test the copy), asserting the exit code AND the message each
# case needs. The cases are the ones a refactor would silently disable: the hard
# gate, the ratchet, the comment-vs-code distinction, the inline `#[cfg(test)]`
# count, and above all the vacuity floor.
self_test_failures=0
self_test_root=""
# Every path THIS invocation created, by exact name. The EXIT trap deletes these
# and nothing else — never a glob, never a pattern sweep.
self_test_created=()

self_mk() {
  local args=()
  if [[ "${1:-}" == "-p" ]]; then
    args+=("-p")
    shift
  fi
  local p
  for p in "$@"; do
    if (( ${#args[@]} > 0 )); then
      # `-p` creates PARENTS too and every created path must be registered, or the
      # root is left un-rm-able and something nobody registered survives the run.
      local ancestors=() probe="$p" a
      while true; do
        probe="$(dirname -- "$probe")"
        [[ -e "$probe" ]] && break
        ancestors+=("$probe")
      done
      mkdir -p -- "$p"
      self_test_created+=("$p")
      for a in "${ancestors[@]+"${ancestors[@]}"}"; do
        self_test_created+=("$a")
      done
    else
      mkdir -- "$p"
      self_test_created+=("$p")
    fi
  done
}

self_mkfile() {
  local p="$1"
  : >"$p"
  self_test_created+=("$p")
}

self_test_cleanup() {
  local p
  for p in "${self_test_created[@]+"${self_test_created[@]}"}"; do
    if [[ -e "$p" ]]; then
      rm -rf -- "$p"
    fi
  done
  if [[ -n "$self_test_root" && -e "$self_test_root" ]]; then
    if ! rmdir -- "$self_test_root" 2>/dev/null; then
      # NOT emptied: something lives there that this invocation did not register,
      # and deleting unregistered paths is the pattern sweep this discipline forbids.
      printf 'warning: the self-test root is not empty, so it was left in place (nothing unregistered is ever deleted): %s\n' "$self_test_root" >&2
    fi
  fi
  return 0
}

self_ok() { printf 'ok   %s\n' "$1"; }

self_fail() {
  printf 'FAIL %s\n' "$1" >&2
  if [[ $# -gt 1 ]]; then
    printf '       %s\n' "$2" >&2
  fi
  self_test_failures=$((self_test_failures + 1))
}

self_status=0
self_output=""
self_run() {
  local script="$1"
  shift
  self_status=0
  self_output="$("$script" "$@" 2>&1)" || self_status=$?
}

# `self_emit_code N PREFIX` / `self_emit_doc N PREFIX`: the fixture's CODE count is
# then exactly N (or 0), which is the only reason the assertions can name a number.
self_emit_code() {
  local n="$1" prefix="$2" i
  for ((i = 1; i <= n; i++)); do
    printf '%s%s = 1;\n' "$prefix" "$i"
  done
}

self_emit_doc() {
  local n="$1" prefix="$2" i
  for ((i = 1; i <= n; i++)); do
    printf '%s%s\n' "$prefix" "$i"
  done
}

# A fixture checkout big enough to clear BOTH floors (>=250 production files, one
# file over 500 code lines), so every planted failure below is provably the plant
# and not the fixture being too small to measure. Case 0 asserts that first.
self_mk_fixture_root() {
  local root="$1" i
  self_mk -p "$root/src-tauri/src" "$root/src/lib/archimedes-film" "$root/src/lib/palettes" "$root/scripts"
  for ((i = 1; i <= 251; i++)); do
    local ts="$root/src/f$i.ts"
    self_mkfile "$ts"
    printf 'export const v%s = %s;\n' "$i" "$i" >"$ts"
  done
  local big="$root/src/big.ts"
  self_mkfile "$big"
  self_emit_code 600 'export const b' >"$big"
  local scene="$root/src/lib/archimedes-film/scene.ts"
  self_mkfile "$scene"
  printf 'export const scene = 1;\n' >"$scene"
  local palette="$root/src/lib/palettes/everforest.ts"
  self_mkfile "$palette"
  printf 'export const palette = 1;\n' >"$palette"
  local baseline="$root/$BASELINE_REL"
  self_mkfile "$baseline"
  printf '# fixture baseline\n' >"$baseline"
  git -C "$root" init -q
  git -C "$root" add -A
}

run_self_test() {
  local script
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  local real_root
  real_root="$(cd "$(dirname "$script")/.." && pwd)"

  self_test_root="$(mktemp -d)"
  trap self_test_cleanup EXIT
  local root="$self_test_root/fixture"

  # Case 0: THE PREMISE. A clean fixture that clears the floors must be green, or
  # every "it refused" below could be the fixture being too small rather than the
  # plant doing its job.
  self_mk_fixture_root "$root"
  self_run "$script" "$root"
  if [[ "$self_status" == "0" && "$self_output" == *"file sizes within baseline"* ]]; then
    self_ok "a clean fixture root is green (so the planted cases below are the delta, not the floors)"
  else
    self_fail "a clean fixture root is green" "expected exit 0 with the positive line, got exit $self_status: $self_output"
  fi

  # Case 1: THE HARD GATE. A new file over 1,000 code lines with no baseline entry
  # is refused, by name and by number.
  local huge="$root/src-tauri/src/huge.rs"
  self_mkfile "$huge"
  self_emit_code 1001 'const p' >"$huge"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"src-tauri/src/huge.rs"* && "$self_output" == *"1001"* ]]; then
    self_ok "a file over the 1,000-line hard gate is refused (exit 1, named, with its count)"
  else
    self_fail "a file over the 1,000-line hard gate is refused" "expected exit 1 naming the file and 1001, got exit $self_status: $self_output"
  fi
  rm "$huge"
  git -C "$root" add -A

  # Case 2: THE VACUITY FLOOR — the guard's most important line, and the one a
  # refactor is most likely to disarm (a pathspec typo, a stray `cd`, a walk that
  # opens nothing). A tiny root must be a BLIND refusal, never the clean line.
  local thin="$self_test_root/thin"
  self_mk -p "$thin/src" "$thin/src-tauri/src" "$thin/scripts"
  local thin_file="$thin/src/one.ts"
  self_mkfile "$thin_file"
  printf 'export const one = 1;\n' >"$thin_file"
  local thin_baseline="$thin/$BASELINE_REL"
  self_mkfile "$thin_baseline"
  printf '# fixture baseline\n' >"$thin_baseline"
  git -C "$thin" init -q
  git -C "$thin" add -A
  self_run "$script" "$thin"
  if [[ "$self_status" == "1" && "$self_output" == *"BLIND"* && "$self_output" != *"file sizes within baseline"* ]]; then
    self_ok "a walk that read almost nothing is REFUSED as blind (exit 1, never green)"
  else
    self_fail "a walk that read almost nothing is REFUSED as blind" "expected exit 1 with BLIND, got exit $self_status: $self_output"
  fi

  # Case 2b: the SECOND floor arm — enough files, none over 500 code lines. A
  # classifier that stopped classifying reads EXACTLY like a tree with no big files,
  # which is why the floor has two arms and not one.
  local nobig="$self_test_root/nobig"
  self_mk_fixture_root "$nobig"
  rm "$nobig/src/big.ts"
  git -C "$nobig" add -A
  self_run "$script" "$nobig"
  if [[ "$self_status" == "1" && "$self_output" == *"BLIND"* && "$self_output" == *"over $OVER_500_BAR code lines"* ]]; then
    self_ok "a walk that finds no file over $OVER_500_BAR code lines is REFUSED as blind"
  else
    self_fail "a walk that finds no file over $OVER_500_BAR code lines is REFUSED as blind" "expected exit 1 with BLIND, got exit $self_status: $self_output"
  fi

  # Case 3: THE RATCHET, both directions of the same file. One CODE line over the
  # baseline is a red naming BOTH numbers; one COMMENT line is not a red at all. A
  # ratchet a comment trips measures keystrokes and gets silenced the first time
  # someone writes a doc comment.
  local mid="$root/src-tauri/src/mid.rs"
  self_mkfile "$mid"
  self_emit_code 704 'const p' >"$mid"
  git -C "$root" add -A
  self_run "$script" "$root" --update
  if [[ "$self_status" != "0" ]]; then
    self_fail "the ratchet fixture seeds (--update exits 0)" "got exit $self_status: $self_output"
  else
    printf '/// one more line of documentation\n' >>"$mid"
    git -C "$root" add -A
    self_run "$script" "$root"
    if [[ "$self_status" == "0" ]]; then
      self_ok "a baselined file that gains a COMMENT line stays green (the instrument strips comments)"
    else
      self_fail "a baselined file that gains a COMMENT line stays green" "expected exit 0, got exit $self_status: $self_output"
    fi
    printf 'const extra = 1;\n' >>"$mid"
    git -C "$root" add -A
    self_run "$script" "$root"
    if [[ "$self_status" == "1" && "$self_output" == *"705"* && "$self_output" == *"baseline 704"* ]]; then
      self_ok "a baselined file that gains one CODE line is refused (exit 1, both numbers printed)"
    else
      self_fail "a baselined file that gains one CODE line is refused" "expected exit 1 with 705 and baseline 704, got exit $self_status: $self_output"
    fi
    # And `--update` after a rise PRINTS THE DIFF — the rise has to be a line a
    # reviewer sees, not a file that silently changed.
    self_run "$script" "$root" --update
    if [[ "$self_status" == "0" && "$self_output" == *"-704"* && "$self_output" == *"+705"* ]]; then
      self_ok "--update prints the rise as a diff (-704 / +705), so it is reviewable"
    else
      self_fail "--update prints the rise as a diff" "expected exit 0 with -704 and +705, got exit $self_status: $self_output"
    fi
    # And a second `--update` over an unchanged tree writes nothing and says so —
    # the idempotence that makes "regenerate and read the diff" a usable command.
    self_run "$script" "$root" --update
    if [[ "$self_status" == "0" && "$self_output" == *"baseline unchanged"* ]]; then
      self_ok "--update is idempotent (a second run reports the baseline unchanged)"
    else
      self_fail "--update is idempotent" "expected exit 0 with 'baseline unchanged', got exit $self_status: $self_output"
    fi
  fi

  # Case 4: THE INSTRUMENT IS NOT `wc -l`. 1,010 whole-line `///` lines measure 0
  # code lines, so the file is neither over the gate nor in the baseline.
  local docs="$root/src-tauri/src/docs.rs"
  self_mkfile "$docs"
  self_emit_doc 1010 '/// doc' >"$docs"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "0" && "$self_output" != *"src-tauri/src/docs.rs"* ]]; then
    self_ok "a Rust file of 1,010 /// lines measures 0 code lines (the metric is not wc -l)"
  else
    self_fail "a Rust file of 1,010 /// lines measures 0 code lines" "expected exit 0 and no mention of docs.rs, got exit $self_status: $self_output"
  fi
  rm "$docs"
  git -C "$root" add -A

  # Case 5: THE DISCRIMINATING CASE. 1,000 production code lines + an inline
  # `#[cfg(test)] mod tests` of 11 more must measure 1011. The census instrument
  # that cuts at `#[cfg(test)]` reads 1000 here and reports GREEN — this is the only
  # case in either harness that tells the two instruments apart, and it is the case
  # that pins the dodge-proofness the header argues for. Asserted by EXACT number.
  local dodged="$root/src-tauri/src/dodged.rs"
  self_mkfile "$dodged"
  {
    self_emit_doc 5 '/// doc above the production code'
    self_emit_code 1000 'const p'
    printf '#[cfg(test)]\n'
    printf 'mod tests {\n'
    self_emit_code 8 '    const t'
    printf '}\n'
  } >"$dodged"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"1011"* && "$self_output" == *"src-tauri/src/dodged.rs"* ]]; then
    self_ok "an inline #[cfg(test)] mod tests counts toward the file (1000 + 11 = 1011, by exact number)"
  else
    self_fail "an inline #[cfg(test)] mod tests counts toward the file" "expected exit 1 naming dodged.rs with 1011, got exit $self_status: $self_output"
  fi

  # Case 6: A MISSING BASELINE is a red, not a free pass, and never the clean line.
  rm "$root/$BASELINE_REL"
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"$BASELINE_REL"* && "$self_output" == *"--update"* && "$self_output" != *"file sizes within baseline"* ]]; then
    self_ok "a missing baseline is refused as an UNCHECKED run (exit 1, names --update)"
  else
    self_fail "a missing baseline is refused as an UNCHECKED run" "expected exit 1 naming the baseline and --update, got exit $self_status: $self_output"
  fi

  # Case 7: A STALE EXEMPTION is refused. An exemption naming a file the walk did
  # not see excuses nothing and outlives its own reason.
  local stale_root="$self_test_root/stale-exemption"
  self_mk_fixture_root "$stale_root"
  rm "$stale_root/src/lib/palettes/everforest.ts"
  git -C "$stale_root" add -A
  self_run "$script" "$stale_root"
  if [[ "$self_status" == "1" && "$self_output" == *"everforest.ts"* ]]; then
    self_ok "an exemption naming a file the walk did not see is refused (exit 1)"
  else
    self_fail "an exemption naming a file the walk did not see is refused" "expected exit 1 naming everforest.ts, got exit $self_status: $self_output"
  fi

  # Case 8: A REASONLESS EXEMPTION is refused. The table lives inside this script,
  # so the case runs a COPY in the temp root with one reason blanked — the script
  # under test is never rewritten, because it lives in the checkout.
  local copied="$self_test_root/reasonless-copy.sh"
  self_mkfile "$copied"
  awk -F'\t' -v OFS='\t' '$1 == "src/lib/palettes/everforest.ts" { $2 = "" } { print }' "$script" >"$copied"
  chmod +x "$copied"
  local reason_root="$self_test_root/reasonless-fixture"
  self_mk_fixture_root "$reason_root"
  self_run "$copied" "$reason_root"
  if [[ "$self_status" == "1" && "$self_output" == *"reason"* && "$self_output" != *"file sizes within baseline"* ]]; then
    self_ok "an exemption with no cited reason is refused (exit 1, never green)"
  else
    self_fail "an exemption with no cited reason is refused" "expected exit 1 mentioning a reason, got exit $self_status: $self_output"
  fi

  # Case 9: THE REAL TREE, read-only. The premise the CI step depends on, and the
  # only case that would catch a guard that works on fixtures and nowhere else.
  self_run "$script" "$real_root"
  if [[ "$self_status" == "0" && "$self_output" == *"file sizes within baseline"* ]]; then
    self_ok "the real checkout is green: $self_output"
  else
    self_fail "the real checkout is green" "expected exit 0 with the positive line, got exit $self_status: $self_output"
  fi

  if ((self_test_failures > 0)); then
    printf '\nself-test: %s case(s) FAILED — the guard cannot be trusted to fail\n' "$self_test_failures" >&2
    exit 1
  fi
  printf '\nself-test: all cases behaved (the guard has teeth)\n'
}

# --- flag parsing (the check-versions.sh contract: `-h|--help`, every error to
# stderr as `error: …` + usage, no silent "nothing was asked for") --------------
repo_root=""
want_self_test=0
want_update=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --self-test)
      want_self_test=1
      shift
      ;;
    --update)
      want_update=1
      shift
      ;;
    -*)
      echo "error: unknown argument: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$repo_root" ]]; then
        echo "error: unexpected argument: $1" >&2
        usage
        exit 1
      fi
      repo_root="$1"
      shift
      ;;
  esac
done

if ((want_self_test == 1)); then
  if [[ -n "$repo_root" ]]; then
    echo "error: --self-test takes no repo-root (it builds its own fixture root)" >&2
    usage
    exit 1
  fi
  if ((want_update == 1)); then
    # `--self-test --update` would plant fixtures and then rewrite the REAL baseline
    # from them — a guard that edits its own ledger as a side effect of a test is not
    # a guard.
    echo "error: --self-test takes no --update (it plants fixtures; rewriting the real baseline from fixtures would be the guard editing its own ledger)" >&2
    usage
    exit 1
  fi
  trap self_test_cleanup EXIT
  run_self_test
  exit 0
fi

run_guard "${repo_root:-.}" "$want_update"
