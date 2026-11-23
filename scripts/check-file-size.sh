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
# braces are NOT stripped, so `{/* … */}` counts as code. The production bar is
# 800 code lines (TEST_HARD_GATE is 1,000, see THE NUMBERS) and the largest
# PRODUCTION `.tsx` file here is `MessageList.tsx` in
# `src/components/chat/` at 583, re-measured at 2fb9a2a7 — a per-file figure, not one
# of the walk counts, so it is stamped once here rather than tracked everywhere it is
# quoted. Since ADR 0112 the walk also reads `.tsx`
# TEST files, and the largest `.tsx` of ANY class is 2,128
# (`src/components/settings/SettingsPage.test.tsx`), which sits in the TEST book
# under the test gate. The limit still costs nothing today, on an argument different
# from the one this comment used to make: the JSX over-count is NOT small — one
# 66-line `{/* … */}` block in `SubagentModals.tsx` is counted whole, and stripping
# every JSX comment would take 139 lines off `SpacesList.tsx` — but it changes no
# verdict, because no `.tsx` file of either class sits within its own over-count of a
# threshold: the production class's largest is that same 583 against a 700 seed and an 800
# gate, and all EIGHT ledgered test `.tsx` entries measure 0 JSX lines, so their
# recorded figures are exact. Stated because an unlisted inaccuracy in a metric
# becomes an argument later.
#
# IT COUNTS AN INLINE `#[cfg(test)] mod tests` AS PART OF THE FILE. That diverges
# from the census ON PURPOSE. The census audited PRODUCTION size and correctly cut
# the tests; a ratchet guards against GROWTH, and a cut-at-`#[cfg(test)]` ratchet
# can be satisfied by MOVING code into the test module — the measured number
# shrinks and nothing real changes. A whole-file count cannot be dodged that way.
# Inline test modules are therefore NOT excluded, and nothing inside a production
# file is excluded.
#
# AND A TEST SOURCE IS NOW ITS OWN GOVERNED CLASS (ADR 0112). Directories named
# `tests` (`src-tauri/tests/`, `src/**/tests/`) and `*.test.ts(x)` used to be
# EXCLUDED from the walk — retired by the two `continue`s this function used to
# carry — which left 243 test sources ungoverned while `agent/session/naming.rs`
# was flagged for the 1,680 lines of its INLINE region. That asymmetry made
# relocating a region out of a file a FREE DODGE, free on both sides. They are now
# WALKED and classified `test`, with their own gate, seed threshold and ledger, all
# three at 1,000 (see THE NUMBERS). So the sentence above is now true for a stronger
# reason than it was: a file cannot shed 1,500 lines of tests to slip under the bar
# because the test gate catches those lines wherever they live — inline in the
# production file, or moved next door into `foo/tests/`.
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
#   (`src-tauri/src/storage/db.rs` no longer exists — ADR 0113 split it into
#   `storage/db/{mod,rows,seams,artifacts,board,messages,migrations,sessions,spaces,
#   stages,tasks}.rs` — so this row is provenance for the 1355cd2a measurement and is
#   NOT reproducible on the current tree. Neither is the 6,128-line figure quoted
#   below for its test module, which is now a 13-code-line shell beside its own split.)
#
# THE COUNTS THAT FOLLOW, re-measured on this tree at 2fb9a2a7 — the commit this table
# is stamped against (same instrument, now classified — `--update` remains the only
# authoritative source). THE STAMP IS NOT CEREMONY, IT IS THE POINT: this table moved
# within a single PR. The row it replaces carried 7a1a0f37's figures — the commit that
# merged the `db` split in, and the first table stamped on a tree that actually contains
# it — and that table in turn replaced beef4b27's, the pre-merge branch tip: the new
# guard without the split, under prose that claimed the current tree. Between 7a1a0f37
# and 2fb9a2a7 the TEST class gained one file (`storage/db/tests/seams.rs`, 125 code
# lines, under the 1,000 test seed so it correctly does not enter the ledger) and one of
# its files crossed the 500 bar (`storage/db/tests/migrations.rs`, 490 -> 504). That is
# one walked file and one over-500 file of drift inside one change, which is exactly why
# THE WALK FIGURES BELOW ARE STAMPED WITH THEIR COMMIT. The qualification is part of the
# claim, not a loophole: the stamping covers the counts of the walk — the table, the floor
# clearances, the ledger head-counts — and NOT the per-file illustrations scattered through
# this file (`scene.ts` 729, `everforest.ts` 707, `sessions.test.ts` 5,543, the largest
# `.tsx` at 2,128 and the like), which are single-file examples quoted to make a point about
# the instrument and are re-measured only when someone notices them. Treat an unstamped
# per-file figure as the weakest kind of citation here: directionally useful, individually
# unproven. READ A MISMATCH BETWEEN A STAMPED FIGURE AND YOUR OWN RE-MEASUREMENT AS
# "THIS WAS TRUE THEN", NOT AS "THIS IS BROKEN NOW": re-run the walk this guard runs
# (`git ls-files -z -- src-tauri/src
# src-tauri/tests src`, classified by `classify_file`, counted by `code_lines`) and the
# difference is drift in the tree, not a defect in the argument. Nothing that runs at
# check time reads these numbers — the refusals below compare `$n_walked` and
# `$n_over_big`, measured fresh on every run.
#
#   class        walked   >200   >500   >700   >1000   >1500   >2000      at 2fb9a2a7
#   production     329     80     22     12       8       2       1
#   test           255    134     65     36      19       8       4
#   COMBINED       584    214     87     48      27      10       5
#
# The production row is the walk this script has always done. (ADR 0112 quotes 312
# production files and this script's own earlier comment 298; both were measured at
# earlier commits, and the `**` pathspecs the plan illustrates are not what this walk
# runs — see THE WALK below. `--update` is the only authoritative source here.) The 12
# production files over 700 are the 10 the instrument RECORDS
# (`scripts/file-size-baseline.txt`) plus the 2 it EXEMPTS —
# `scene.ts` 729 and `everforest.ts` 707 — which is why the baseline has 10 lines
# and the census says 12: an exemption means "not ratcheted", and an exempt file
# that is not in the ledger is the only way to say that. The test class is SEEDED at
# its own 1,000 rather than at 700, so 19 test files are ledgered and gated at once
# (12 frontend `*.test.ts(x)`, 4 integration `src-tauri/tests/`, 3 Rust `foo/tests/`),
# the largest being `src/store/sessions.test.ts` at 5,543. (The 6,128 this comment
# used to name as the class's largest was `src-tauri/src/storage/db/tests/mod.rs`
# BEFORE the ADR 0113 split; that path is now a 13-code-line shell and the figure is
# pre-split provenance, not today's head of the test ledger.)
#
# A VACUITY FLOOR closes the loop (check-commands.sh calls it a blind-walk
# tripwire): a walk that finds fewer than 250 files, or finds ZERO files over 500
# code lines, is REFUSED. A metric that read no file must not read as green. That is
# this guard's most important line. It has a THIRD arm, below in THE INSTRUMENT: a
# file the walk named but could not OPEN is refused too, because such a file measures
# 0 and 0 satisfies the gate, the ratchet and both floors at once — the floors ask
# about the walk and about the other files, never about one file's unreadability.
#
# BOTH FLOORS MEASURE THE COMBINED WALK, BOTH CLASSES TOGETHER, and their VALUES are
# untouched by ADR 0112: `FLOOR_FILES=250` and `FLOOR_OVER_BIG=1`, neither one re-tuned
# when the walk grew from one class to two. What that choice buys, stated plainly because
# the earlier sentence here argued the opposite and was wrong: the combined walk sits well
# above a floor of 250, and EACH CLASS CLEARS THAT FLOOR ON ITS OWN — the test class by a
# handful of files, the production class by a few dozen. So the combined floor DETECTS A
# TOTAL BLACKOUT (a walk that read nothing, or a pathspec that matches nothing) AND NOT A
# SINGLE-CLASS ONE: drop either class from the walk entirely and the other still clears 250
# by itself, so a half-blind walk is green here. THE SINGLE-CLASS BLACKOUT IS A KNOWN LIMIT
# OF THESE FLOORS, and it is not covered anywhere else in this script either: the earlier
# sentence here claimed a class that reads nothing "is caught downstream by
# `print_class_positive_line`'s empty-measurement refusal", and THAT WAS FALSE. That function
# early-returns on `if ((n_class == 0)) { return 0; }` — before the refusal is reached — so a
# class that walked nothing takes the silent path BY DESIGN (several harness fixtures are
# legitimately that shape). The refusal below that early return is reachable only for a class
# that DID walk files and produced no row, which the unreadable-file refusal already
# precludes. Measured: mutating a COPY of this script so the walk drops the test class
# entirely prints `329 production file(s) walked` and EXITS 0.
#
# WHAT ACTUALLY CATCHES IT IS THE TEST SUITE, NOT THIS GUARD: `check-file-size.test.sh`
# recomputes the walk per class independently of this script (`ledger_walk_paths`, with its
# own `classify_walked_path`) and asserts its own figure against the guard's output —
# `"$n_mirrored production file(s) walked"` and `"$n_mirrored_test test file(s) walked"`. A
# walk that loses a class prints no line for it, so that assertion cannot be satisfied.
# Verified by running that harness against the mutated copy above: it goes RED on three
# real-tree cases, including the mirror pin, while the guard itself stayed green.
#
# The honest consequence of that division of labour is stated rather than glossed: the
# protection lives in the harness, so A RUN OF `check-file-size.sh` ALONE, ON A TREE THAT
# LOOKS HEALTHY, CAN STILL BE BLIND TO A HALF-BLIND WALK. CI runs both, which is what makes
# the arrangement hold; a workflow that invoked only the guard would not. The only shape
# that would catch the single-class blackout AT THE FLOOR is a per-class floor set WELL BELOW
# each class's size, and that was deliberately NOT done here (see THE NUMBERS and THE TWO
# FLOORS below: ADR 0112 forbids re-tuning the floors to the new denominator).
#
# THE MARGIN IS STATED QUALITATIVELY ON PURPOSE, and that is a fix, not a softening: this
# paragraph is the second time it has had to be re-worded because a number in it rotted.
# The sentence it replaced carried the test class's exact head-count over the floor; that
# figure moved by one file WITHIN ONE PR (a new 125-line mirror child landed), and it moves
# again on the next test file anyone adds. A floor argument whose validity is pinned to
# yesterday's head-count reads as a broken guard the moment the tree moves, which is worse
# than no argument. What survives the drift is the SHAPE: each class sits only a few files
# (test) to a few dozen (production) above the 250 floor, and both clear it, so neither can
# substitute for the other and neither is what this floor is watching. The exact figures
# are still given, stamped with the commit they were measured at — at 2fb9a2a7 the walk was
# 584 files (329 production + 255 test) with 87 over 500 (22 production + 65 test) — but
# they are PROVENANCE for that shape, not its premises. Re-measure them at your own commit
# and expect a different number: that is the tree moving, not the argument failing.
#
# The VALUES stay combined and un-re-tuned, and that is the deliberate part: ADR
# 0112's Consequences say so in as many words — "they ask about the walk, not about
# one file, so they are unchanged by this decision and must not be re-tuned to the new
# denominator". Re-tuning the floors to per-class denominators is out of scope for
# this change; tightening what the combined floor claims to detect is not.
#
# Usage: check-file-size.sh [repo-root] [--self-test] [--update]   (root default: .)
#   repo-root    the checkout to read (its `src-tauri/src`, `src`, and this file's
#                own `scripts/file-size-baseline.txt` and
#                `scripts/file-size-baseline-test.txt`)
#   --self-test  plant fixtures under a throwaway root and prove THIS guard —
#                re-invoked, never a second implementation — can still fail
#   --update     rewrite BOTH baselines from the tree and print the diffs, so an
#                intentional rise is a reviewable one-line change

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
# HARD_GATE / SEED_THRESHOLD are production policy; TEST_HARD_GATE /
# TEST_SEED_THRESHOLD are the same policy for the test class (ADR 0112). The FLOORs
# are the blind-walk tripwire: they are what the walk measures TODAY rounded DOWN to
# where only a walk that read nothing can trip them, and they are deliberately NOT
# the current counts — a file legitimately splitting in two, or a 563rd file
# landing, passes untouched. A floor that has to be raised for ordinary work is a
# floor that gets deleted.
#
# THE TEST CLASS IS GATED AND SEEDED AT THE SAME 1,000, and that number is chosen by
# the dodge it has to close rather than by a size opinion. `agent/session/naming.rs`
# is 327 production code lines under a 1,680-line inline `#[cfg(test)]` region; at
# the 2,000 the predecessor report recommended, MOVING that region into
# `agent/session/tests/` would drop the file to 327 AND put the region under a gate
# it could never reach — a free pass on both sides. At 1,000 relocation is a wash:
# the region stays gated wherever it lives, so the only way down is to split it by
# subject. The test seed threshold is 1,000 and NOT the production class's 700
# because ADR 0112 gates the class at 1,000: a ledger that recorded files the gate
# does not govern would freeze 36 test files (measured at 2fb9a2a7; the 34 this
# sentence carried was true at beef4b27, and the split moved the figure by three
# `db/tests/` children crossing 700 on their own — `board.rs`, `open.rs`,
# `sessions.rs` — against `db/tests/mod.rs` falling out of the set as its contents
# moved into them) nobody is stopped from growing, and every one of them would then
# need a `--update` diff for an edit the gate permits.
HARD_GATE=800      # refuse a production file crossing this unless it is baselined.
                   # Moved from 1,000 when AGENTS.md made 600-800 the band: the gate
                   # is where CI refuses and the band is where you should already
                   # have split, and a gate set above the band makes the band a
                   # number nobody is gated on (the objection ADR 0112 raises against
                   # report-only). MEASURED blast radius at the commit this moved:
                   # ZERO un-ledgered production files sit at or above 800, so the
                   # tightening reddens nothing that exists — it only stops what is
                   # not yet written. TEST_HARD_GATE stays 1,000 on purpose: see the
                   # dodge argument below, which is about relocation, not taste.
SEED_THRESHOLD=700 # `--update` records PRODUCTION files ABOVE this. Deliberate consequence,
                   # stated rather than buried: a file at or below 700 is not
                   # recorded, so it can grow unwatched until it crosses the gate.
                   # Raising the threshold tightens the ratchet and makes every
                   # ordinary file a re-baseline; lowering it to 200 would put 75
                   # files in the ledger and get this file deleted.
TEST_HARD_GATE=1000     # the same bar, for the test class (ADR 0112)
TEST_SEED_THRESHOLD=1000 # `--update` records TEST files above this — the same 1,000,
                         # so the ledger never holds a test entry the gate does not
                         # govern, and no test file is governed on the sly.
# THE TWO FLOORS MEASURE THE COMBINED WALK — production AND test together — and NEITHER
# VALUE was re-tuned when the walk grew from a single class to two. They ask "did this
# metric read any file at all", which is a question about the walk, not about one class,
# and that is exactly why their value stayed combined. What they therefore CANNOT do is
# catch a walk that lost one class: the combined walk clears a 250 floor comfortably, and
# EACH class clears it alone, so the floor detects a TOTAL blackout and not a single-class
# one. The earlier sentence here said a per-class floor "would REDDEN A HEALTHY TREE"
# because the test class was 243 files — that was true of the tree at the ADR 0112 change
# and is FALSE of the tree this file describes, where the test class sits ABOVE the floor.
# Which is the reason the margin is now stated as a shape rather than as a number: the
# exact head-count over the floor moved by one file inside one PR, so an argument carried
# on that number rots on the next test file anyone adds. Measured at 2fb9a2a7 the walk was
# 584 files, 329 production + 255 test, against FLOOR_FILES=250 — so BOTH classes clear
# the floor, the test class by a handful of files and the production class by a few dozen,
# and neither can stand in for the other. Per-class floors set well below each class's size
# is the only shape that would catch the single-class regression, and it was deliberately
# NOT done here (ADR 0112's Consequences forbid re-tuning these values to the new
# denominator), so treat a half-blind walk as a KNOWN LIMIT of this floor. Nothing in
# THIS script sees it either — `print_class_positive_line` early-returns on a zero-sized
# class rather than refusing one — so what sees it is the harness's real-tree walk-mirror
# pins, which recompute the walk per class and assert their own count against the guard's
# output. See THE NUMBERS for that, and for the caveat that it is the test suite and not
# the guard that carries this protection.
OVER_500_BAR=500
FLOOR_FILES=250     # COMBINED classes, and read the paragraph above for what that
                    # does and does not detect: BOTH classes clear it on their own, so it
                    # catches a walk that read NOTHING and not one that read only half the
                    # tree. Value deliberately unchanged. (Clearance measured at 2fb9a2a7:
                    # 329 production + 255 test against 250 — both above it, the test class
                    # only slightly. Re-measure at your own commit; a different number there
                    # is the tree moving, not this floor failing.)
FLOOR_OVER_BIG=1

# The baselines live next to the instrument, so the two cannot be edited apart.
# ONE LEDGER PER CLASS, and not one file with a class column: the production
# ledger's `<count><TAB><path>` shape is what every research doc in this repo cites
# and what `read_baseline` parses, and a third field would invalidate all of them
# (and trip the malformed-line refusal) for no gain — the class is a property of the
# PATH, which is already in the row.
BASELINE_REL="scripts/file-size-baseline.txt"
TEST_BASELINE_REL="scripts/file-size-baseline-test.txt"

# A literal TAB, spelled once. `sort -t"$TABS"` and `${x%%"$TABS"*}` are used
# instead of an inline tab because a tab inside a `${…}` is invisible to a reader
# and to every future diff.
TABS="$(printf '\t')"

# ---------------------------------------------------------------------------
# THE EXEMPTIONS — `path<TAB>reason`, one per line, reason MANDATORY on the same
# line (an unexplained exemption is how a permanent free pass arrives, and a
# reasonless line is itself a refusal). An exemption buys exactly ONE thing:
# freedom to grow past a recorded baseline WITHOUT an `--update` diff. The hard
# 800 gate still applies to an exempt file, so this list is not a licence — and
# because the gate is the ONLY ceiling an exempt file has, tightening it shrinks
# what an exemption buys, from 1,000 unchecked to 800.
#
# Measured with this instrument, FOUR production files sit in the 700-1,000 band:
# `provider_auth/refresh.rs` 866, `commands/update.rs` 734, `scene.ts` 729,
# `palettes/everforest.ts` 707. Under the 1,000 gate NONE of them crossed it, so an
# exemption bought nothing for the first two and they are NOT exempt — they are
# ordinary logic, and ordinary logic is what a ratchet is for. NOTE the asymmetry
# the 800 gate creates: `refresh.rs` at 866 now DOES cross, and it is carried by its
# LEDGER ENTRY (grandfathered, may not grow), not by an exemption. The other three
# stay under 800. (The census's inherited exemption
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
# `grep -c` prints `0` AND EXITS 1 when nothing matches, so THAT status is absorbed
# and the VALUE is what is read — a file of nothing but comments legitimately
# measures 0 and must not look like a failed measurement. But exit 1 and exit 2 are
# DIFFERENT FACTS and only one of them is a measurement:
#
#   exit 0  at least one line matched — a measurement
#   exit 1  the file was READ and nothing matched — a measurement of ZERO
#   exit 2+ the file was NOT READ at all — not a measurement, and never a number
#
# Absorbing all three with a bare `|| true` (which is what this function used to do)
# makes an unopenable file read as 0 code lines, and 0 is the one figure that
# satisfies every check downstream: it clears the hard gate, it clears the ratchet
# (`0 > baseline` is false), and it clears both vacuity floors, because those ask
# about the WALK and about the OTHER files. The guard then prints a confident green
# for a file it never measured, and `--update` seeds it at 0 — under the 700 seed
# threshold, so its ledger entry is dropped and the file leaves the ratchet with
# nobody having decided that. Pinned by `check-file-size.test.sh` cases 8e (the
# refusal, and the entry surviving `--update`) and 8f (the no-match zero that must
# STAY green, so this fix cannot become a guard that reddes on a comment-only file).
#
# The verdict is still never taken from grep's exit status as a COUNT — the trap
# check-temp-dir-census.sh documents for `grep -Fxv -f`, arriving here from the
# opposite direction. A non-zero status is only ever read as "did this file get read
# at all", and a read failure is REFUSED rather than routed around, because a failed
# search is not an empty one (check-test-data-dir.sh's rule, inherited).
code_lines() {
  local file="$1" n status=0
  n="$(grep -vcE '^[[:space:]]*(//|\*|/\*|$)' -- "$file")" || status=$?
  if ((status > 1)); then
    # Print no number: a caller that gets a non-zero status back must not be able to
    # read a half-truth out of stdout, and grep itself prints the OS error.
    return "$status"
  fi
  printf '%s\n' "${n:-0}"
}

# ---------------------------------------------------------------------------
# THE WALK. Tracked files under the production roots, BOTH CLASSES — production and
# test. It used to RETIRE the test sources; ADR 0112 made them a governed class, so
# the two `continue`s that retired them are now the classifier below.
#
# WHY DIRECTORIES AND NOT THE PLAN'S `**` GLOB PATTERNS — a real trap, measured on
# this repo, not a stylistic preference: `git ls-files 'src-tauri/src/**/*.rs'` does
# NOT match `src-tauri/src/config.rs`, because git's `**` still requires at least
# one `/`. Nine top-level Rust files (including `config.rs` at 1,289 code lines and
# `errors.rs` at 1,135, both over the gate) and every depth-1 file under `src/`
# (including `src/App.tsx`) vanish from that walk, and the guard prints a confident
# green. Passing the DIRECTORIES and filtering the extension here is what makes the
# file denominators and the over-1,000 figures reproducible.
walk_tracked_files() {
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
      printf '%s\0' "$rel"
    done |
    LC_ALL=C sort -z
}

# THE CLASSIFIER. Sets the global `CLASS` to `production` or `test` for one walked
# path. (A global and not command substitution: this runs once per walked file, and
# a fork per walked file — several hundred, both classes together — to read four
# characters back would be the slowest thing in the script.)
#
# THE RULE IS THE ONE THE WALK USED TO RETIRE ON, INVERTED, VERBATIM — a
# `*.test.ts(x)` sibling, or anything under a directory named `tests`. Keeping the
# two spellings identical is the point: the set of files that stopped being
# production is EXACTLY the set that became the test class, so no file can be in
# both classes or in neither, and the walk's total is unchanged by the split. An
# inline `#[cfg(test)] mod tests` is INSIDE a production file and stays production:
# see the header.
#
# The `/$rel` prefix on the second case is load-bearing, not decoration: without the
# leading slash a top-level path beginning `tests/` would classify on its FIRST
# segment with no separator before it, and `src-tauri/tests/` (39 files) would not
# match at all.
classify_file() {
  local rel="$1"
  CLASS=production
  case "$rel" in
    *.test.ts | *.test.tsx) CLASS=test; return ;;
  esac
  case "/$rel" in
    */tests/*) CLASS=test; return ;;
  esac
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
# THE PER-CLASS POLICY, in one place. Everything downstream of here is the SAME
# machinery run once per class — the seed `awk`, the verdict loop, the largest-file
# sort — and the only thing that differs is these four values. A second copy of the
# machinery for the test class is what would drift.
class_baseline_rel() {
  case "$1" in
    production) printf '%s\n' "$BASELINE_REL" ;;
    test) printf '%s\n' "$TEST_BASELINE_REL" ;;
  esac
}

class_gate() {
  case "$1" in
    production) printf '%s\n' "$HARD_GATE" ;;
    test) printf '%s\n' "$TEST_HARD_GATE" ;;
  esac
}

class_seed_threshold() {
  case "$1" in
    production) printf '%s\n' "$SEED_THRESHOLD" ;;
    test) printf '%s\n' "$TEST_SEED_THRESHOLD" ;;
  esac
}

# ---------------------------------------------------------------------------
# One class's ledger: read it into `baseline_rows`, or record that it is absent.
#
# A plain CHECK with no ledger is an UNCHECKED run: with no ledger every
# grandfathered file would read as a fresh violation, or the ratchet would simply be
# absent. Either way the run must not print the clean line — and that is as true of
# the test class as of the production one. A run that found every test file under
# its gate while the test ledger was simply MISSING would otherwise print the
# positive line with the whole test class ungoverned in silence, which is the state ADR 0112
# exists to end, arriving back as a green.
#
# Sets `baseline_present` (0/1) for the caller. `--update` is the generation route,
# so it may create a file that is not there yet.
read_class_baseline() {
  local root="$1" update="$2" cls="$3" tmp_dir="$4"
  local rel baseline rows
  rel="$(class_baseline_rel "$cls")"
  baseline="$root/$rel"
  rows="$tmp_dir/baseline.$cls.rows"
  baseline_present=1
  if [[ -r "$baseline" ]]; then
    read_baseline "$baseline" "$rows"
  else
    : >"$rows"
    if ((update == 0)); then
      fail "the baseline file is missing or unreadable: $rel" "this run is UNCHECKED, not clean — generate it with \`bash scripts/check-file-size.sh --update\` and commit the output"
    fi
    baseline_present=0
  fi
}

# ---------------------------------------------------------------------------
# One class's `--update`: regenerate its ledger and print the diff. Byte-identical
# in behaviour to the single-ledger original, run once per class.
update_class_ledger() {
  local root="$1" cls="$2" tmp_dir="$3" exempt_file="$4" present="$5"
  local rel gate seed baseline measured_rows new_baseline
  rel="$(class_baseline_rel "$cls")"
  gate="$(class_gate "$cls")"
  seed="$(class_seed_threshold "$cls")"
  baseline="$root/$rel"
  measured_rows="$tmp_dir/measured.$cls"
  new_baseline="$tmp_dir/baseline.$cls.new"

  # Files ABOVE the class's seed threshold, exempt files excluded, biggest first
  # (ties broken by path, so a re-run is byte-identical and the diff is the only
  # noise). `FILENAME == exf` and NOT the usual `NR == FNR` first-file idiom: that
  # idiom misfires when the first file is EMPTY (awk skips it, reads the second
  # file's records as exemptions, and seeds nothing) — and an exemption list someone
  # empties is exactly the input this script has to survive.
  #
  # The exemption table is validated against the PRODUCTION class below, so no test
  # path can ever be in it; passing it here unchanged means the test class simply
  # excludes nothing, rather than this call needing a different shape.
  awk -F'\t' -v bar="$seed" -v exf="$exempt_file" '
    FILENAME == exf { exempt[$1] = 1; next }
    $1 > bar && !($2 in exempt) { print }
  ' "$exempt_file" "$measured_rows" |
    LC_ALL=C sort -t"$TABS" -k1,1rn -k2,2 >"$new_baseline"

  local baseline_rows="$tmp_dir/baseline.$cls.rows"
  local n_entries n_old_entries=0 diff_status=0
  n_entries="$(wc -l <"$new_baseline" | tr -d ' ')"
  if ((present == 1)); then
    n_old_entries="$(wc -l <"$baseline_rows" | tr -d ' ')"
  fi

  diff -u "$baseline_rows" "$new_baseline" >"$tmp_dir/diff.$cls" 2>/dev/null || diff_status=$?
  if ((diff_status == 2)); then
    fail "diff could not compare the baseline against the regenerated one (exit 2): $rel" "a diff that could not run is not a baseline that did not change"
  fi

  if ((diff_status == 0 && present == 1)); then
    printf 'baseline unchanged: %s file(s) over %s code lines recorded in %s\n' "$n_entries" "$seed" "$rel"
  else
    # The diff IS the product: an intentional rise has to be a line a reviewer
    # sees, not a file that silently got rewritten. Both sides are HEADER-STRIPPED
    # entry lists (`baseline.$cls.rows` is what `read_baseline` parsed), so the
    # header this script writes can never show up as a spurious change.
    if ((present == 0)); then
      printf 'baseline created in %s: %s file(s) over %s code lines\n' "$rel" "$n_entries" "$seed"
    else
      printf 'baseline changed (%s -> %s entries) in %s:\n' "$n_old_entries" "$n_entries" "$rel"
      sed -n '3,$p' "$tmp_dir/diff.$cls" | sed 's/^/  /'
    fi
    # The two headers differ ONLY in the class word and the two numbers, so the
    # production ledger's bytes stay exactly what every research doc in this repo
    # cites. Two fields per line in both files — the class is NOT a column.
    if [[ "$cls" == production ]]; then
      {
        printf '# Size ratchet baseline — GENERATED by `bash scripts/check-file-size.sh --update`;\n'
        printf '# do not hand-edit. One <code-line-count><TAB><path> line per PRODUCTION file over\n'
        printf '# %s code lines, largest first. Exempt files (see the EXEMPTIONS table in\n' "$seed"
        printf '# scripts/check-file-size.sh) are deliberately absent: an exemption means "not\n'
        printf '# ratcheted", and the hard %s-line gate still applies to them. Inline Rust\n' "$gate"
        printf '# `#[cfg(test)] mod tests` ARE counted — that is what makes this ratchet undodgeable.\n'
        cat "$new_baseline"
      } >"$baseline"
    else
      {
        printf '# Size ratchet baseline, TEST class — GENERATED by `bash scripts/check-file-size.sh --update`;\n'
        printf '# do not hand-edit. One <code-line-count><TAB><path> line per TEST file over\n'
        printf '# %s code lines, largest first. A TEST file is a `*.test.ts(x)` sibling or anything\n' "$seed"
        printf '# under a `tests/` directory; the production ledger is scripts/file-size-baseline.txt.\n'
        printf '# The test class is gated AND seeded at the same %s (ADR 0112), so at this threshold\n' "$gate"
        printf '# an exemption would be indistinguishable from a grandfathered entry and none applies.\n'
        cat "$new_baseline"
      } >"$baseline"
    fi
    printf '  (justify any rise in the PR body: the ratchet exists so a growth is a decision)\n'
  fi
  # The verdict below must be taken against the ledger that was JUST written, not
  # the one that was there before. Without this, `--update` on a fresh tree would
  # seed `naming.rs` at 2,007 (and `sessions.test.ts` at 5,543) and then refuse its
  # own seed as an unbaselined file over the gate — the documented generation route
  # would exit 1 on the tree it just made green.
  read_baseline "$baseline" "$baseline_rows"
}

# ---------------------------------------------------------------------------
# THE PRODUCTION / INLINE-TEST SPLIT, for a flagged PRODUCTION file only.
#
# ADR 0112's last Consequence: "once the script classifies per file, the per-file
# production/inline-test split is nearly free to report, so a flagged file can name
# which of its two subjects it is complaining about — the question this decision
# started from". That is what this is: DISPLAY, never measurement. The gate, the
# ratchet and the ledger all keep reading the WHOLE-FILE figure, because a cut at
# `#[cfg(test)]` is exactly the instrument case 13 exists to refuse — a number that
# shrinks when code is moved into the test module.
#
# The cut is the same `awk '/#\[cfg\(test)\]/{exit}'` the plan's census used, and the
# harness mirrors it in `instrument_cut_lines` so the two cannot drift silently.
# Nothing here can turn into a second instrument: the value is only ever interpolated
# into a message, never compared against a gate or a threshold.
#
# Prints nothing when the file has no inline region (cut == whole), so a plain
# production violation reads exactly as it always did.
inline_test_split() {
  local file="$1" whole="$2" cut
  # The file is REDIRECTED and not passed as an argument: `awk` has no `--`
  # end-of-options marker, so `awk '…' -- path` treats `--` as a missing input file,
  # prints a fatal, and yields an empty stream — which `grep -c` then measures as 0
  # and the message reads "(production 0 + inline tests N)". Measured, and the reason
  # this spelling is the one that is safe for every path the walk can name.
  #
  # `awk` exits at the `#[cfg(test)]` line and `grep -c` reads to EOF, so the reader
  # is never the side that stops early — no SIGPIPE in this direction, and `|| true`
  # absorbs grep's no-match exit 1, which is a measurement of ZERO and not a failure
  # (see `code_lines` for why that distinction is not absorbed wholesale).
  cut="$(awk '/#\[cfg\(test)\]/{exit} {print}' <"$file" |
    grep -vcE '^[[:space:]]*(//|\*|/\*|$)' || true)"
  cut="${cut:-0}"
  ((cut < whole)) || return 0
  # Spelled WITHOUT the words "code lines" after the production figure: case 13
  # asserts a red run does NOT contain "1000 code lines", because that is the cut
  # figure the census instrument prints for the very file it plants, and a message
  # that re-introduced the string would make that case blind to the instrument it
  # exists to tell apart.
  printf ' (production %s + inline tests %s)' "$cut" "$((whole - cut))"
}

# ---------------------------------------------------------------------------
# One class's verdict. Appends to the shared `violations` file and the shared
# `n_violations` counter, and prints a class header ONLY when that class has
# something to say — a clean class adds nothing to the output, which is what keeps
# every production-only message in the existing harness byte-identical.
verdict_class() {
  local root="$1" cls="$2" tmp_dir="$3" exempt_file="$4"
  # `split` is declared ONCE, in the loop's list below — it was declared in both
  # lists, which is harmless but reads as two different variables.
  local gate rel measured_rows baseline_rows violations_class
  # ADR 0112's reporting consequence, applied to the PRODUCTION class only: a test
  # file's whole body IS its test subject, so "production P + inline tests I" would
  # be noise there, and the classifier has already put every `tests/` file in the
  # class where it belongs.
  local report_split=0
  [[ "$cls" == production ]] || report_split=1
  gate="$(class_gate "$cls")"
  rel="$(class_baseline_rel "$cls")"
  measured_rows="$tmp_dir/measured.$cls"
  baseline_rows="$tmp_dir/baseline.$cls.rows"
  violations_class="$tmp_dir/violations.$cls"
  : >"$violations_class"

  local n_here=0 measured_count path baseline_count split
  # The sort's output goes to a FILE and the loop reads that file, for the same
  # reason the success line below does: `sort | while read` would let the reader's
  # last iteration close the pipe while `sort` still had bytes to write, and under
  # `set -euo pipefail` 141 would abort the run. (Here the loop reads to EOF, so the
  # pipe is not short-read today — but the file shape is the one that cannot regress
  # into the bug this file has already shipped once.)
  local ranked="$tmp_dir/ranked.$cls"
  LC_ALL=C sort -t"$TABS" -k1,1rn -k2,2 "$measured_rows" >"$ranked"
  while IFS=$'\t' read -r measured_count path; do
    [[ -z "${path:-}" ]] && continue
    if grep -qxF -- "$path" "$exempt_file"; then
      # Exempt from the BASELINE only. The hard gate still applies, and this is the
      # line that keeps an exemption from being a licence. (The table is production
      # paths only — see the exemption validation — so this arm never fires for the
      # test class; it is here because it is the SAME machinery, not because the
      # test class has exemptions.)
      if ((measured_count > gate)); then
        n_here=$((n_here + 1))
        split=""
        ((report_split == 0)) && split="$(inline_test_split "$root/$path" "$measured_count")"
        printf '  %s: %s code lines%s — over the %s-line HARD GATE, and an exemption does not cover the gate\n' "$path" "$measured_count" "$split" "$gate" >>"$violations_class"
      fi
      continue
    fi
    baseline_count="$(awk -F'\t' -v p="$path" '$2 == p { print $1; exit }' "$baseline_rows")"
    if [[ -z "$baseline_count" ]]; then
      if ((measured_count > gate)); then
        n_here=$((n_here + 1))
        split=""
        ((report_split == 0)) && split="$(inline_test_split "$root/$path" "$measured_count")"
        printf '  %s: %s code lines%s — over the %s-line hard gate with no baseline entry. This is a LOOK-AT tripwire, not a defect threshold: subject count is what decides a split. Either split it by subject, or record it with `bash scripts/check-file-size.sh --update` and justify it in the PR body.\n' "$path" "$measured_count" "$split" "$gate" >>"$violations_class"
        printf '  re-measure it yourself: grep -vcE %s %s\n' "'^[[:space:]]*(//|\\*|/\\*|\$)'" "$path" >>"$violations_class"
      fi
      continue
    fi
    if ((measured_count > baseline_count)); then
      n_here=$((n_here + 1))
      split=""
      ((report_split == 0)) && split="$(inline_test_split "$root/$path" "$measured_count")"
      printf '  %s: %s > baseline %s%s — either shrink it or re-run with --update and justify it in the PR body\n' "$path" "$measured_count" "$baseline_count" "$split" >>"$violations_class"
    fi
  done <"$ranked"

  if ((n_here > 0)); then
    # The header names the class, its gate and its ledger, so a red says which of
    # the two books it is complaining about — without a per-message class prefix,
    # which would change every violation sentence the existing harness pins.
    #
    # The gate is spelled `gate 1000` and NOT `gate 1000 code lines`: case 13 of the
    # harness asserts the ABSENCE of the string "1000 code lines" in a red run,
    # because that is the figure the cfg(test)-CUTTING census instrument prints for
    # the very file that case plants (1,000 production + 11 inline test). A header
    # that emitted that string would make case 13 blind to the instrument it exists
    # to tell apart.
    printf '  %s class — gate %s, ledger %s:\n' "$cls" "$gate" "$rel" >>"$violations"
    cat "$violations_class" >>"$violations"
  fi
  n_violations=$((n_violations + n_here))
}

# ---------------------------------------------------------------------------
# THE POSITIVE LINE, one per class — the sibling prints `versions match: X.Y.Z`. A
# count and the largest file make the claim checkable by eye: if the walked count
# falls off a cliff, or the largest file is one nobody expected, the walk changed and
# this green is not the green the guard advertises.
#
# AT FILE SCOPE and not nested inside `run_guard`. It used to be defined there, which
# made it a global anyway (bash has no nested scopes) while reading as if it were not;
# the move is mechanical, and `$root` — which the empty-measurement refusal names in
# its message, and which was an enclosing `run_guard` local it read implicitly — is
# now its first parameter.
#
# ONE LINE PER CLASS, production first. The production line is BYTE-IDENTICAL to
# the one this script printed before ADR 0112 — the count beside
# `production file(s) walked` is the PRODUCTION walked count, which is what the
# harness's real-tree agreement pin compares against its own mirrored walk — and
# the test line is appended after it, so nothing the existing harness asserts on
# moves. A combined `N file(s) walked` would have been the tidier sentence and
# would have broken that pin, which is a feature: the two classes have different
# gates and different ledgers, so they report separately.
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
# command substitution) and is deliberately not used. THIS SHAPE IS KEPT FOR BOTH
# CLASSES; a second `sort | head` for the test class would reintroduce the race.
#
# Pinned by `check-file-size.test.sh` case 16b, which runs this 25 times in a
# row against a fixture sized so the old pipeline failed 24 of 25: one run of a
# race proves nothing. And WHICH FILE each line names is pinned per class, by this
# script's own `--self-test` (a fixture whose two classes disagree about the winner)
# and by harness case 18d for the production line on the real tree — pointing one
# class's sort at the other class's `measured.<class>` file prints a confident line
# about the wrong subject, and until those cases existed both suites stayed green on
# exactly that mutation.
print_class_positive_line() {
  local root="$1" cls="$2" n_class="$3" tmp_dir="$4"
  # A class the walk found nothing for prints nothing. This is not a loosened
  # refusal: the vacuity floors measure the COMBINED walk, so a tree with no test
  # sources at all is legitimately green for the test class (there is nothing in
  # that ledger to govern), and every existing fixture in the harness is that
  # shape. What must never happen is a line with an EMPTY path and figure in it —
  # that is the confident green built on a measurement that read nothing, and the
  # refusal below is what stops it for a class that DID walk files.
  if ((n_class == 0)); then
    return 0
  fi
  local largest_file="$tmp_dir/largest.$cls"
  LC_ALL=C sort -t"$TABS" -k1,1rn -k2,2 "$tmp_dir/measured.$cls" >"$largest_file"
  local largest_line="" largest_path="" largest_count=""
  # `IFS=` (and not a tab IFS) keeps the line intact so the two cuts below still
  # split at the FIRST tab, exactly as they did before. `|| true` is here because
  # `read` returns 1 at an EOF that carries no newline — an empty sort output must
  # reach the refusal below, not abort through `set -e` with 128+0.
  IFS= read -r largest_line <"$largest_file" || true
  if [[ -z "$largest_line" ]]; then
    # Unreachable behind the vacuity floors and the unreadable-file refusal (every
    # walked file of a class that walked files has a row), so this is not a guard
    # against a real input, it is the refusal that keeps the positive line TRUE
    # whenever it does print: a `largest  ` with nothing in either field is a
    # confident green built on a measurement that read nothing, which is what this
    # whole script exists to refuse.
    fail "the $cls class walked $n_class file(s) but measured none to rank under $root" "the positive line would print an empty count and an empty path; a green that cannot name the biggest file it saw is not a green"
  fi
  largest_count="${largest_line%%"$TABS"*}"
  largest_path="${largest_line#*"$TABS"}"
  printf 'file sizes within baseline: %s %s file(s) walked, largest %s %s\n' \
    "$n_class" "$cls" "$largest_path" "$largest_count"
}

# ---------------------------------------------------------------------------
# The guard.
run_guard() {
  local root="$1" update="$2"
  local cls
  # ONE PLAIN SCALAR PER CLASS, and deliberately NOT `declare -A baseline_presence`:
  # an associative array is a bash 4 construct, and this repo's guards avoid it on
  # purpose (check-temp-dir-census.sh carries the same comment for its `local -A`)
  # because the job matrix includes `macos-latest`, whose `/bin/bash` is 3.2 and
  # would stop here with `declare: -A: invalid option` and exit 2. The array bought
  # nothing anyway — it was keyed by the two literal strings `production` and `test`,
  # which are exactly two variables. Both are written before they are read (see the
  # two `read_class_baseline` calls below), so they carry no default.
  local presence_production presence_test

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

  # THE WALK, both classes, and the CLASSIFICATION. `walked_file` is the whole walk
  # (both classes) because that is the denominator the vacuity floors measure;
  # `walked.<class>` and `measured.<class>` are the per-class slices the per-class
  # machinery runs over.
  local walked_file="$tmp_dir/walked"
  : >"$walked_file"
  local walked_production="$tmp_dir/walked.production"
  local walked_test="$tmp_dir/walked.test"
  : >"$walked_production"
  : >"$walked_test"
  local rel
  while IFS= read -r -d '' rel; do
    printf '%s\n' "$rel" >>"$walked_file"
    classify_file "$rel"
    case "$CLASS" in
      production) printf '%s\n' "$rel" >>"$walked_production" ;;
      test) printf '%s\n' "$rel" >>"$walked_test" ;;
    esac
  done < <(walk_tracked_files "$root")

  local n_walked n_prod_walked n_test_walked
  n_walked="$(wc -l <"$walked_file" | tr -d ' ')"
  n_prod_walked="$(wc -l <"$walked_production" | tr -d ' ')"
  n_test_walked="$(wc -l <"$walked_test" | tr -d ' ')"

  # --- the VACUITY FLOOR (blind-walk tripwire) --------------------------------
  # FIRST, before anything else is believed, and in both modes: a `--update` off a
  # walk that read nothing would otherwise write an empty baseline and make every
  # later run green forever. This is the guard's most important line.
  #
  # ITS DENOMINATOR IS THE WHOLE WALK, BOTH CLASSES, and its VALUE is unchanged by
  # ADR 0112 (see THE NUMBERS). What that denominator can and cannot detect is stated
  # there and not glossed here: the combined walk clears a floor of 250 comfortably and
  # EACH class clears it alone, so this floor catches a walk that read NOTHING and NOT a
  # walk that lost one class. NOTHING IN THIS SCRIPT catches the single-class blackout
  # either: `print_class_positive_line` early-returns on a class of zero rather than
  # refusing one (several fixtures are legitimately that shape), so the claim this
  # comment used to make — that the positive-line refusal sees it — was false. What
  # catches it is `check-file-size.test.sh`'s real-tree walk-mirror pins, which recompute
  # the walk per class and assert their own count against the guard's own output; a walk
  # that lost a class prints no line for it and that assertion fails. That places the
  # protection in the TEST SUITE and not in the guard, so this guard run alone can stay
  # green on a half-blind walk. A per-class floor is the shape that would catch it here —
  # deliberately not done (see THE NUMBERS; the values are not re-tuned to the new
  # denominator).
  #
  # THE FIRST LINE CARRIES THE PRODUCTION COUNT under the production label, and the
  # combined count in parentheses. It used to carry the COMBINED count under that
  # label, which was false by the size of the test class: a mixed fixture of 3
  # production + 2 test files printed `5 production file(s) walked`. The line after
  # this one spells out the split, but the FIRST line is the one a CI log shows and
  # the one `check-file-size.test.sh` case 8 greps (`2 production file(s) walked` —
  # a fixture of two production files and no test files, so the corrected line still
  # reads exactly that there).
  if ((n_walked < FLOOR_FILES)); then
    fail "the walk is BLIND: $n_prod_walked production file(s) walked under $root, floor is $FLOOR_FILES ($n_walked walked in both classes)" "the floor measures the WHOLE walk, both classes: production $n_prod_walked + test $n_test_walked = $n_walked. It asks whether this metric read any file at all, so it is NOT applied per class — and note that this means it detects a TOTAL blackout only: BOTH classes clear this floor on their own (measured at 2fb9a2a7: 329 production + 255 test against a floor of 250), so a walk that lost ONE class entirely is a KNOWN LIMIT of this floor and is not caught here, nor by the per-class positive line (which early-returns on an empty class). \`check-file-size.test.sh\`'s real-tree walk-mirror pins are what catch it — run that harness, not just this guard" "a metric that read no file must not read as green (the tree at 2fb9a2a7 held 584 tracked .rs/.ts/.tsx files: 329 production + 255 test — re-measure it, your tree may differ, and that is drift and not this refusal failing)" "check the walk's pathspecs against the tree: \`git ls-files -z -- src-tauri/src src-tauri/tests src\`"
  fi

  # Measure every walked file: `<count><TAB><path>`, into its class's file.
  #
  # A file that cannot be OPENED is a refusal, not a row. It cannot be recorded as
  # 0 (see `code_lines`: 0 passes the gate, the ratchet and both floors), and it
  # cannot be skipped either — a skipped file is unguarded and the positive line
  # would still report the full walked count, so the green would be a lie of
  # omission instead of a lie of commission. Collected rather than failed-on-first,
  # because a walk with three unreadable files has to tell you about all three.
  # Refused in BOTH modes and BEFORE either baseline is written, so `--update` cannot
  # regenerate a ledger from a tree it could not read.
  #
  # THIS COVERS BOTH CLASSES, and it must: the loop below runs over the whole walk
  # and classifies as it measures, so an unreadable `db/tests/mod.rs` is refused
  # exactly as an unreadable `db.rs` is. Routing one class around the refusal would
  # hand back the 0-clears-everything hole case 8e pins shut, and it would hand it
  # back in the class that was just added to the walk and has no history of being
  # measured at all.
  local unreadable="$tmp_dir/unreadable"
  : >"$unreadable"
  : >"$tmp_dir/measured.production"
  : >"$tmp_dir/measured.test"
  local n
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    if ! n="$(code_lines "$root/$rel")"; then
      printf '%s\n' "$rel" >>"$unreadable"
      continue
    fi
    classify_file "$rel"
    printf '%s\t%s\n' "$n" "$rel" >>"$tmp_dir/measured.$CLASS"
  done <"$walked_file"

  if [[ -s "$unreadable" ]]; then
    local n_unreadable
    n_unreadable="$(wc -l <"$unreadable" | tr -d ' ')"
    {
      printf 'error: %s tracked .rs/.ts/.tsx file(s) could not be read, so this run is UNCHECKED\n' "$n_unreadable"
      while IFS= read -r rel; do
        printf '  %s\n' "$rel"
      done <"$unreadable"
      printf '       a file that cannot be opened is not a file with 0 code lines: 0 clears the gate, the ratchet and both vacuity floors, so the guard would print a green it never measured\n'
      if ((update == 1)); then
        printf '       the baselines were NOT rewritten (regenerating them from a tree this walk could not read would drop these files from the ratchet)\n'
      fi
      printf '       a tracked path with no worktree file is a half-finished \`git rm\` or an interrupted checkout: \`git status\` says which\n'
    } >&2
    exit 1
  fi

  # The SECOND floor arm, over BOTH class files (awk reads both to EOF; no
  # `NR == FNR` idiom is used here, so an empty class file is harmless).
  local n_over_big
  n_over_big="$(awk -F'\t' -v bar="$OVER_500_BAR" '$1 > bar { c++ } END { print c + 0 }' \
    "$tmp_dir/measured.production" "$tmp_dir/measured.test")"
  if ((n_over_big < FLOOR_OVER_BIG)); then
    fail "the walk is BLIND: $n_over_big file(s) over $OVER_500_BAR code lines among $n_walked walked files, floor is $FLOOR_OVER_BIG" "the tree at 2fb9a2a7 held 87 such files across both classes (22 production, 65 test), so ZERO means the classifier stopped classifying (or the walk opened nothing) — either way this is not a green"
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
    #
    # Matched against the PRODUCTION class and not the whole walk: the exemption
    # table is a production instrument (the test class is SEEDED at its own gate, so
    # an exempt test path and a grandfathered test entry would be indistinguishable),
    # and since ADR 0112 the walk contains test paths too — checking the combined
    # walk would let an exemption name a test file and silently excuse nothing.
    if ! grep -qxF -- "$ex_path" "$walked_production"; then
      fail "an exemption names no production file this walk saw: $ex_path" "either the file moved or it left scope — delete the exemption or fix the path; a stale exemption is how an exemption list stops meaning anything"
    fi
    printf '%s\n' "$ex_path" >>"$exempt_file"
  done < <(exemption_table)

  # --- the two baselines --------------------------------------------------------
  # One ledger per class, read by the same `read_baseline` with the same two-field
  # shape. A missing ledger is UNCHECKED for EITHER class — see read_class_baseline.
  # TWO CALLS, not a loop over the two class names, because the two results land in
  # two named scalars. A loop needs a container to put them in, and a container keyed
  # by the class names is precisely the associative array this function no longer
  # uses (see the comment at its top). `read_class_baseline` still sets the same
  # global it always set; it is simply read once per class here.
  local baseline_present
  read_class_baseline "$root" "$update" production "$tmp_dir"
  presence_production="$baseline_present"
  read_class_baseline "$root" "$update" test "$tmp_dir"
  presence_test="$baseline_present"

  # --- `--update`: regenerate BOTH ledgers and print both diffs -----------------
  if ((update == 1)); then
    # The baselines' directory must exist to write them. In this repo it always does
    # (these scripts live in it), so a missing one means the wrong root was passed,
    # and a bare `set -e` redirect failure would not say that.
    if [[ ! -d "$root/$(dirname "$BASELINE_REL")" ]]; then
      fail "--update cannot write the baselines: no $(dirname "$BASELINE_REL") directory under $root" "run this from the repo root, or pass the repo root"
    fi
    update_class_ledger "$root" production "$tmp_dir" "$exempt_file" "$presence_production"
    update_class_ledger "$root" test "$tmp_dir" "$exempt_file" "$presence_test"
  fi

  # --- the verdict, once per class ----------------------------------------------
  # ONE violation list and ONE counter, shared: the run is red if either class has
  # anything to say, and the per-class header inside the list says which. Running the
  # production verdict and exiting on it first would let a red production run never
  # look at the test class at all — the class this change exists to govern would be
  # reported last and only when nothing else was wrong.
  local violations="$tmp_dir/violations"
  : >"$violations"
  local n_violations=0
  for cls in production test; do
    verdict_class "$root" "$cls" "$tmp_dir" "$exempt_file"
  done

  if ((n_violations > 0)); then
    {
      printf 'error: %s file(s) broke the size ratchet\n' "$n_violations"
      cat "$violations"
      printf '  the instrument is CODE lines, not raw lines: comments and blanks are stripped, an inline #[cfg(test)] mod tests is NOT\n'
      printf '  production and test are separate classes with separate ledgers and their own gate (production 800, test 1000 per ADR 0112)\n'
      printf '  this is a look-at tripwire; subject count is still what decides whether a split is DONE (AGENTS.md, and size is not a defect predictor here)\n'
    } >&2
    exit 1
  fi

  # The positive lines, one per class — see `print_class_positive_line` above the
  # guard for what each line claims, and for the shape its ranking deliberately
  # avoids. Production first, so nothing the existing harness asserts on moves.
  print_class_positive_line "$root" production "$n_prod_walked" "$tmp_dir"
  print_class_positive_line "$root" test "$n_test_walked" "$tmp_dir"
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
  # BOTH ledgers, header-only: nothing grandfathered, which is the state case 1
  # needs. A fixture with only the production ledger would now be an UNCHECKED run
  # for the missing test ledger and every planted case below would be the missing
  # file and not the plant.
  local baseline
  for baseline in "$root/$BASELINE_REL" "$root/$TEST_BASELINE_REL"; do
    self_mkfile "$baseline"
    printf '# fixture baseline\n' >"$baseline"
  done
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

  # Case 1: THE HARD GATE. A new PRODUCTION file over 800 code lines with no
  # baseline entry is refused, by name and by number. The fixture deliberately sits
  # at 801 and NOT above the test class's 1,000, so this case cannot pass by
  # tripping the wrong class's gate.
  local huge="$root/src-tauri/src/huge.rs"
  self_mkfile "$huge"
  self_emit_code 801 'const p' >"$huge"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"src-tauri/src/huge.rs"* && "$self_output" == *"801"* ]]; then
    self_ok "a file over the 800-line hard gate is refused (exit 1, named, with its count)"
  else
    self_fail "a file over the 800-line hard gate is refused" "expected exit 1 naming the file and 801, got exit $self_status: $self_output"
  fi
  rm "$huge"
  git -C "$root" add -A

  # Case 1b: THE SAME GATE ON THE TEST CLASS (ADR 0112). The gate that closes the
  # relocation dodge has to have teeth of its own, and a fixture is the only place
  # that proves it: `naming.rs`'s 1,680-line inline region moved to
  # `agent/session/tests/` lands here. The path is planted in BOTH shapes the
  # classifier knows — a `tests/` directory and a `*.test.ts` sibling — because the
  # classifier is a two-arm rule and an implementation that only matched one arm
  # would pass a single-path case.
  local testdir="$root/src-tauri/src/agent/session/tests"
  self_mk -p "$testdir"
  local test_huge="$testdir/mod.rs"
  self_mkfile "$test_huge"
  self_emit_code 1001 '    const t' >"$test_huge"
  local ts_huge="$root/src/lib/relocated.test.ts"
  self_mkfile "$ts_huge"
  self_emit_code 1001 'export const x' >"$ts_huge"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "1" &&
        "$self_output" == *"src-tauri/src/agent/session/tests/mod.rs"* &&
        "$self_output" == *"src/lib/relocated.test.ts"* &&
        "$self_output" == *"1001"* &&
        "$self_output" == *"$TEST_BASELINE_REL"* ]]; then
    self_ok "a tests/ file and a *.test.ts over the 1,000-line gate are refused (exit 1, both named, test ledger named)"
  else
    self_fail "a tests/ file and a *.test.ts over the 1,000-line gate are refused" "expected exit 1 naming both files, 1001 and $TEST_BASELINE_REL, got exit $self_status: $self_output"
  fi

  # ... AND THE GATE IS A GATE: the same two files at 1000 and 999 code lines are
  # green, so the refusal above is the threshold and not a blanket refusal of
  # anything the classifier calls a test.
  self_emit_code 1000 '    const t' >"$test_huge"
  self_emit_code 999 'export const x' >"$ts_huge"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "0" && "$self_output" == *"file sizes within baseline"* ]]; then
    self_ok "test sources at 1,000 and 999 code lines are green (the test gate bites above its value, not at it)"
  else
    self_fail "test sources at 1,000 and 999 code lines are green" "expected exit 0 with the positive lines, got exit $self_status: $self_output"
  fi

  # Case 1c: THE TEST LEDGER IS ITS OWN LEDGER. Seeded at the test class's 1,000,
  # the test ledger records the 1,000-line-ish test file and NOT the 900-line one,
  # and it holds no production path; the production ledger holds no test path. A
  # single ledger with a class column, or one class reading the other's book, breaks
  # one of these four assertions.
  local test_mid="$testdir/mid.rs"
  self_mkfile "$test_mid"
  self_emit_code 1100 '    const t' >"$test_mid"
  local test_small="$root/src/lib/small.test.ts"
  self_mkfile "$test_small"
  self_emit_code 900 'export const y' >"$test_small"
  git -C "$root" add -A
  self_run "$script" "$root" --update
  if [[ "$self_status" != "0" ]]; then
    self_fail "the test-class ledger fixture seeds (--update exits 0)" "got exit $self_status: $self_output"
  else
    local test_ledger="$root/$TEST_BASELINE_REL"
    local rec_mid rec_small rec_prod_in_test rec_test_in_prod
    rec_mid="$(awk -F'\t' -v p='src-tauri/src/agent/session/tests/mid.rs' '$2 == p { print $1; exit }' "$test_ledger")"
    rec_small="$(awk -F'\t' -v p='src/lib/small.test.ts' '$2 == p { print $1; exit }' "$test_ledger")"
    # The classifier's two arms spelled the way the GUARD spells them: a `tests/`
    # DIRECTORY is a path CONTAINING `/tests/`, a `.test.ts(x)` is a SUFFIX. Anchoring
    # both at `$` makes `foo/tests/mod.rs` read as a production path and turns this
    # assertion into a green that can never fire.
    rec_prod_in_test="$(awk -F'\t' '!/^#/ && NF == 2 { print $2 }' "$test_ledger" | grep -vE '(/tests/|\.test\.tsx?$)' || true)"
    rec_test_in_prod="$(awk -F'\t' '!/^#/ && NF == 2 { print $2 }' "$root/$BASELINE_REL" | grep -E '(/tests/|\.test\.tsx?$)' || true)"
    if [[ "$rec_mid" == "1100" ]]; then
      self_ok "the test ledger records the test file over its own 1,000 seed threshold at 1100"
    else
      self_fail "the test ledger records the test file over its own 1,000 seed threshold at 1100" "expected 1100, got [$rec_mid]"
    fi
    if [[ -z "$rec_small" ]]; then
      self_ok "and it holds no entry for a 900-line test file (the test class seeds at 1,000, not at the production class's 700)"
    else
      self_fail "and it holds no entry for a 900-line test file" "expected no entry, got [$rec_small]"
    fi
    if [[ -z "$rec_prod_in_test" && -z "$rec_test_in_prod" ]]; then
      self_ok "and the two ledgers are disjoint: no production path in the test ledger, no test path in the production ledger"
    else
      self_fail "and the two ledgers are disjoint" "test ledger holds production paths: [$rec_prod_in_test]; production ledger holds test paths: [$rec_test_in_prod]"
    fi
    # THE LEDGER IS THE RATCHET FOR THE TEST CLASS TOO: one code line past the
    # recorded 1,100 is a red, and it is the TEST ledger that says so.
    printf '    const extra = 1;\n' >>"$test_mid"
    git -C "$root" add -A
    self_run "$script" "$root"
    if [[ "$self_status" == "1" && "$self_output" == *"1101"* && "$self_output" == *"baseline 1100"* ]]; then
      self_ok "a baselined test file that gains one code line is refused (1101 over baseline 1100)"
    else
      self_fail "a baselined test file that gains one code line is refused" "expected exit 1 with 1101 and baseline 1100, got exit $self_status: $self_output"
    fi
    printf '/// one more line of documentation\n' >>"$test_mid"
    git -C "$root" add -A
    self_run "$script" "$root"
    if [[ "$self_status" == "1" && "$self_output" == *"1101"* ]]; then
      self_ok "and the same file gaining a COMMENT line is still 1101, not 1102 (the instrument strips comments in both classes)"
    else
      self_fail "and the same file gaining a COMMENT line is still 1101, not 1102" "expected exit 1 still citing 1101, got exit $self_status: $self_output"
    fi
  fi

  # Case 1d: A MISSING TEST LEDGER IS AN UNCHECKED RUN, exactly as a missing
  # production ledger always was. This is the state that would otherwise let the
  # whole test class go ungoverned behind a green positive line — which is the
  # condition ADR 0112 was written to end.
  rm "$root/$TEST_BASELINE_REL"
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"$TEST_BASELINE_REL"* && "$self_output" == *"--update"* && "$self_output" != *"file sizes within baseline"* ]]; then
    self_ok "a missing test ledger is refused as an UNCHECKED run (exit 1, names the test ledger and --update)"
  else
    self_fail "a missing test ledger is refused as an UNCHECKED run" "expected exit 1 naming $TEST_BASELINE_REL and --update, no positive line, got exit $self_status: $self_output"
  fi
  rm "$test_huge" "$ts_huge" "$test_mid" "$test_small"
  git -C "$root" add -A
  self_mkfile "$root/$TEST_BASELINE_REL"
  printf '# fixture baseline\n' >"$root/$TEST_BASELINE_REL"
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
  local thin_test_baseline="$thin/$TEST_BASELINE_REL"
  self_mkfile "$thin_test_baseline"
  printf '# fixture baseline\n' >"$thin_test_baseline"
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

  # Case 2c: A TRACKED FILE THAT CANNOT BE READ is refused, not measured as 0. The
  # third arm of the same rule the two floors above enforce, and the one neither
  # floor can see: an unreadable file reads 0, and 0 clears the gate, the ratchet
  # AND both floors, because those ask about the walk and about the other files.
  # The state is a MISSING WORKTREE FILE whose index entry survives (the walk is
  # `git ls-files`, which reads the index) rather than `chmod 000`, so this case
  # tests something on the Windows runners too — Git for Windows does not enforce
  # POSIX mode bits, and a chmod fixture would be green there and prove nothing.
  local unread="$root/src-tauri/src/unreadable.rs"
  self_mkfile "$unread"
  self_emit_code 704 'const p' >"$unread"
  git -C "$root" add -A
  self_run "$script" "$root" --update
  if [[ "$self_status" != "0" ]]; then
    self_fail "the unreadable fixture seeds (--update exits 0)" "got exit $self_status: $self_output"
  else
    rm "$unread"
    self_run "$script" "$root"
    if [[ "$self_status" == "1" && "$self_output" == *"src-tauri/src/unreadable.rs"* && "$self_output" != *"file sizes within baseline"* ]]; then
      self_ok "a tracked file the instrument cannot read is REFUSED as UNCHECKED (exit 1, named, never green)"
    else
      self_fail "a tracked file the instrument cannot read is REFUSED as UNCHECKED" "expected exit 1 naming unreadable.rs and no positive line, got exit $self_status: $self_output"
    fi
    # THE DURABLE HALF: the ledger must survive an attempted `--update`, because a
    # regenerated ledger would seed the unreadable file at 0 — under the seed
    # threshold — and silently take it off the ratchet.
    self_run "$script" "$root" --update
    if [[ "$self_status" == "1" ]] && grep -qF -- 'src-tauri/src/unreadable.rs' "$root/$BASELINE_REL"; then
      self_ok "--update refuses to regenerate from an unreadable tree and leaves the ledger entry in place"
    else
      self_fail "--update refuses to regenerate from an unreadable tree" "expected exit 1 with the ledger entry intact, got exit $self_status: $self_output"
    fi
  fi

  # Case 2d: THE REFUSAL IS NOT THE NO-MATCH STATUS. `grep -c` exits 1 when nothing
  # matches, and that is a legitimate measurement of ZERO. Without this case, the
  # fix for 2c could be "absorb nothing" and every comment-only file in the repo
  # would redden CI — cases 4 and 5 cover the all-comment half, this covers empty.
  local zero="$root/src/zero.ts"
  self_mkfile "$zero"
  : >"$zero"
  git -C "$root" add -A
  # The unreadable file must be back in the worktree for this to be a clean run.
  self_emit_code 704 'const p' >"$unread"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "0" && "$self_output" == *"file sizes within baseline"* ]]; then
    self_ok "a tracked EMPTY file measures 0 and stays green (grep's no-match exit is a measurement)"
  else
    self_fail "a tracked EMPTY file measures 0 and stays green" "expected exit 0 with the positive line, got exit $self_status: $self_output"
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

  # Case 5: THE DISCRIMINATING CASE. 800 production code lines + an inline
  # `#[cfg(test)] mod tests` of 11 more must measure 811. The census instrument
  # that cuts at `#[cfg(test)]` reads 800 here and reports GREEN — this is the only
  # case in either harness that tells the two instruments apart, and it is the case
  # that pins the dodge-proofness the header argues for. Asserted by EXACT number.
  # N IS PINNED TO HARD_GATE: the fixture discriminates only while the CUT figure is
  # at or below the gate and the WHOLE-FILE figure is above it, so a 1,000-line plant
  # under an 800 gate would refuse BOTH instruments and print a false ok.
  local dodged="$root/src-tauri/src/dodged.rs"
  self_mkfile "$dodged"
  {
    self_emit_doc 5 '/// doc above the production code'
    self_emit_code 800 'const p'
    printf '#[cfg(test)]\n'
    printf 'mod tests {\n'
    self_emit_code 8 '    const t'
    printf '}\n'
  } >"$dodged"
  git -C "$root" add -A
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"811"* && "$self_output" == *"src-tauri/src/dodged.rs"* ]]; then
    self_ok "an inline #[cfg(test)] mod tests counts toward the file (800 + 11 = 811, by exact number)"
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
  #
  # BOTH POSITIVE LINES ARE REQUIRED, not the one substring `file sizes within
  # baseline`. That needle is satisfied by the PRODUCTION line alone, so a guard
  # that had lost its `print_class_positive_line test` call entirely — the whole
  # test class silently unreported, which is the state ADR 0112 exists to end —
  # passed this case until it was tightened. The two class words are what make the
  # assertion about both classes; ` test file(s) walked` carries a leading space so
  # the production line cannot satisfy it.
  self_run "$script" "$real_root"
  if [[ "$self_status" == "0" &&
        "$self_output" == *"file sizes within baseline"* &&
        "$self_output" == *"production file(s) walked"* &&
        "$self_output" == *" test file(s) walked"* ]]; then
    self_ok "the real checkout is green on BOTH classes: $self_output"
  else
    self_fail "the real checkout is green with a production line AND a test line" "expected exit 0 with the positive line for both classes (production file(s) walked / test file(s) walked), got exit $self_status: $self_output"
  fi

  # Case 10: THE TEST CLASS'S POSITIVE LINE RANKS THE TEST CLASS. The mirror of the
  # case above for the production class (harness case 18d pins the production line
  # against an independently mirrored walk; this is the same claim for the test line,
  # and the same defect class). Pointing the test class's largest-file sort at the
  # PRODUCTION measurements — `sort … measured.production` in the test call — prints
  # a production path under the test label (`N test file(s) walked, largest
  # …/naming.rs 2007`) and left BOTH suites green until this case existed, because
  # every other assertion asks about a count, a gate or a ledger and none of them
  # asks which FILE the test line names.
  #
  # THE FIXTURE MAKES THE TWO CLASSES DISAGREE ABOUT THE WINNER ON PURPOSE: the
  # biggest production file (790) is bigger than the biggest test file (700), so a
  # line built from the production rows names `bigprod.rs` and a line built from the
  # test rows names `big.test.ts`. Asserting the test file's name+figure is therefore
  # a test of WHICH ROW SET the line was ranked from, and the production line is
  # asserted in the same run so a guard that swapped the two arguments outright
  # reddens here too. Both files sit under their class's gate, so the run is green
  # for the ordinary reason and the only thing under test is the ranking.
  #
  # PRODUCTION MUST STAY THE OVERALL LARGEST, and that is a load-bearing property
  # rather than a taste: the blunt half of this case asserts the test line names no
  # production path, which is the documented bug (`largest …/naming.rs 2007` printed
  # under the TEST label). If the test file were the bigger of the two, a guard that
  # ranked the test line from ALL rows would name the test file anyway and that
  # assertion would pass by accident. Both figures are pinned below HARD_GATE (800)
  # because neither fixture is seeded with `--update`, so an over-gate production
  # file here is a refusal and the case never reaches its assertions.
  local rank_root="$self_test_root/rank-per-class"
  self_mk_fixture_root "$rank_root"
  local big_prod="$rank_root/src-tauri/src/bigprod.rs"
  local big_test="$rank_root/src/lib/big.test.ts"
  self_mkfile "$big_prod"
  self_emit_code 790 'const p' >"$big_prod"
  self_mkfile "$big_test"
  self_emit_code 700 'export const t' >"$big_test"
  git -C "$rank_root" add -A
  self_run "$script" "$rank_root"
  if [[ "$self_status" != "0" ]]; then
    self_fail "the per-class ranking fixture is green (so the assertions below read a positive line)" "expected exit 0 with the positive lines, got exit $self_status: $self_output"
  else
    # The line for a class is the one whose LABEL names that class, selected by
    # grepping the output rather than by position: a guard that printed the two
    # lines in the other order would otherwise make a positional read the test.
    local prod_line test_line
    prod_line="$(printf '%s\n' "$self_output" | grep -F 'production file(s) walked' || true)"
    test_line="$(printf '%s\n' "$self_output" | grep -F ' test file(s) walked' || true)"
    if [[ "$prod_line" == *"largest src-tauri/src/bigprod.rs 790"* ]]; then
      self_ok "the production line names the largest PRODUCTION file with its figure"
    else
      self_fail "the production line names the largest PRODUCTION file with its figure" "expected 'largest src-tauri/src/bigprod.rs 790', got [$prod_line]"
    fi
    if [[ "$test_line" == *"largest src/lib/big.test.ts 700"* ]]; then
      self_ok "and the TEST line names the largest TEST file, not the largest file the walk saw"
    else
      self_fail "and the TEST line names the largest TEST file, not the largest file the walk saw" "expected 'largest src/lib/big.test.ts 800' on the test line, got [$test_line]"
    fi
    # The blunt half of the same pin: the production file must not appear on the
    # test line at all, whatever the ranking machinery did to get there.
    if [[ "$test_line" == *"bigprod.rs"* ]]; then
      self_fail "and the TEST line names no production file" "the test line carries a production path: [$test_line]"
    else
      self_ok "and the TEST line names no production file"
    fi
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
