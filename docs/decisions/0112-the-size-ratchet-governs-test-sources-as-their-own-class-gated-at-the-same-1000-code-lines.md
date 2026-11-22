---
status: accepted
date: 2026-11-17
superseded-by:
---

# The size ratchet governs TEST sources as their own class, gated at the same 1,000 code lines as production

`scripts/check-file-size.sh` ratchets PRODUCTION files over 1,000 code lines and deliberately counts
an inline `#[cfg(test)] mod tests` as part of the file. Its walk USED TO RETIRE anything under a
`tests/` directory and every `*.test.ts(x)` — the `*/tests/*` case in the walk function, now called
`walk_tracked_files`; it carries that name because this decision removed the two `continue`s that
retired them, and the name that did the retiring became false the moment it stopped applying. That
retirement is the **superseded** behaviour this ADR reverses; the walk now classifies instead of
skipping. Measured consequence at
`b2d6ea95`: **241 test sources, 19 over 1,000 code lines, 5 over 2,000, and the guard saw none of
them** — the largest test file in the repo, `src-tauri/src/storage/db/tests/mod.rs` at 6,128 code
lines, was invisible to it. Six of the nine files the guard DID flag at that commit are over 1,000
only because of an inline test region (`agent/session/naming.rs` is 327 production code lines under a
1,680-line `mod tests`).

We decided the guard classifies every walked file as **production** or **test** and gives each class
its own `HARD_GATE`, `SEED_THRESHOLD` and baseline, with the test class gated and seeded at the **same
1,000** code lines. The test-side numbers were the decision; the production-side ratchet is unchanged.

## The threshold is chosen by the dodge it has to close, not by a size opinion

This is the load-bearing part, and it is why the number is 1,000 and not the 2,000 the predecessor
report recommended. The guard's header justifies counting inline tests on the grounds that *"a file
cannot shed 1,500 lines of tests to slip under the bar"*. That is true only while the tests stay
**inline**. Relocate them to `foo/tests/` and today they leave the instrument entirely. So the test
gate has to be low enough that relocating is never better than splitting:

| File | production | inline region | relocated to `foo/tests/`, caught at 1,000? | at 2,000? |
|---|---|---|---|---|
| `agent/session/naming.rs` | 327 | 1,680 | **yes** | **no — invisible** |
| `src-tauri/src/config.rs` | 259 | 1,030 | **yes** | **no** |
| `agent/session/router.rs` | 456 | 1,015 | **yes** | **no** |
| `commands/agents.rs` | 140 | 915 | no | no |
| `agent/errors.rs` | 497 | 638 | **no** | no |
| `commands/settings.rs` | 442 | 628 | no | no |

At 2,000, moving `naming.rs`'s region out drops that file from 2,007 to 327 **and** puts the region
below the test gate — a free pass on both sides, and the exact behaviour that produced this work item.
At 1,000 relocation is a wash **for the three files above the line**: the region stays gated wherever
it lives, so the only way down is to split it by subject.

**And the honest boundary of that claim, measured.** The last three rows are the remainder the number
does NOT cover, and `agent/errors.rs` is the case that makes it concrete: its inline region is 638
code lines, so a relocated child of it lands at 638 — **under** the 1,000 test gate — while the file
it left drops from 1,135 to 497 production code lines, **under** `SEED_THRESHOLD=700`. Such a
relocation is free on **both** sides of the move at 1,000 exactly as it was at 2,000. **The 1,000 gate
does not close the dodge for a file whose inline region is smaller than 1,000.** What closes that
remainder instead is not a number: it is `AGENTS.md`'s **subject-count rule**, which is what actually
decides whether a region gets split (no `describe` / `#[cfg(test)]` block over ~25 unrelated tests),
plus the fact that the relocated region is no longer **invisible** — it appears in the walk, in the
ledger and in the `--update` diff, so the move is a decision a reviewer sees rather than a deletion no
one is asked about. This ADR does not pretend otherwise, and it does not re-tune the threshold to
chase the remainder: a gate below 638 would re-open nothing that was not already rejected above, and
was considered and rejected. The consequence for the record is this — a claim that this ADR closes the
relocation dodge **entirely** is false, and any later decision that cites it to decline a relocation
must cite the subject-count rule for the sub-1,000 case, not this gate.

**`docs/research/production-godfile-census-and-the-size-metric.md` recommended a
2,000-line test threshold; that number does not close the dodge it was offered for, and is superseded
here.** (That recommendation was never implemented — the shipped script defines only `HARD_GATE=1000`
and `SEED_THRESHOLD=700`.)

## Considered Options

- **Split the oversized files, leave the guard alone.** Rejected: the 6,128-line file that motivated
  the work becomes nine unguarded files, nothing stops regrowth, and the inline-vs-directory
  asymmetry keeps rewarding relocation over splitting.
- **Report-only — print the production/inline-test split, fail on neither.** Rejected: the requester's
  position is that a huge test region is a real navigation and context cost to be *acted on*, and a
  number nobody is gated on is not acted on.
- **Test gate 1,000 with headroom, or gate 2,000.** Rejected: both re-open the relocation dodge above.

## Consequences

- **19 test files are ledgered and simultaneously gated on day one** (12 frontend `*.test.ts(x)`,
  4 integration `src-tauri/tests/`, 3 Rust `foo/tests/`), frozen at their recorded size. Adding one
  code line to any of them requires a `--update` diff a reviewer sees. That is the intended
  consequence of governing them, not an oversight — but `src/App.test.tsx` (1,848) is named here
  specifically, because `AGENTS.md` already records that it hand-writes `useSessions.setState({...})`
  key lists per test, so it is the file most likely to need that diff for a legitimate reason.
- **Two files that `AGENTS.md` treats as blast radius rather than split candidates are now governed
  subjects.** `AGENTS.md`'s size bullet and `docs/agents/test-counts-and-splits.md` both have to be
  read with this ADR: what that audit rejected was a file-level **ratio** trigger ("split when the
  test body exceeds the production body"), which is a different instrument from an absolute
  per-file threshold and is still rejected. Nothing here licenses splitting a test region by ratio.
- **The guard's header claim becomes true rather than being softened.** *"A file cannot shed 1,500
  lines of tests to slip under the bar"* now holds because the test gate catches them inside `tests/`,
  not because they are counted inline.
- **The walk grows from 312 production files to 553 total — 312 production + 241 test — so the
  combined denominator `FLOOR_FILES` measures is untouched.** Both vacuity floors
  (`FLOOR_FILES=250`, `FLOOR_OVER_BIG=1`) still pass untouched; they ask about the walk, not about one
  file, so they are unchanged by this decision and must not be re-tuned to the new denominator. (The
  two endpoints are both measured at `b2d6ea95`, and they are not comparable to each other: 312 is the
  **production** class alone, 553 is **both** classes. Quoting them as a single "312 → 553" growth
  compares a one-class denominator with a two-class one, which is the conflation
  `docs/agents/census.md` exists to prevent.)
- **Once the script classifies per file, the per-file production/inline-test split is nearly free to
  report**, so a flagged file can name which of its two subjects it is complaining about — the
  question this decision started from.
- **2026-11-22, re-measured at `2fb9a2a7` on the integrated tree after the `db` split (ADR 0113).**
  The split changed *which* files the ledger holds, so both classes were re-baselined over the
  integrated tree with one `--update`: **329 production files walked** (ledger holds **10** entries,
  all naming files the walk visits, 8 of them over the 1,000 gate, largest `agent/session/naming.rs`
  at 2,007; 12 production files are over the 700 seed and the 2 the ledger does not carry are the 2
  the script EXEMPTS) and **255 test files walked** (**19** over the 1,000 seed,
  largest `src/store/sessions.test.ts` at 5,543). The production ledger lost the dead
  `storage/db.rs` row (2,154, the file no longer exists) and the test ledger lost
  `storage/db/tests/mod.rs` (6,128, now a 13-code-line `mod`-decl shell) and gained
  `src-tauri/src/storage/db/tests/sessions.rs` at **1,086** — the one ledgered **over-gate** file this
  branch produces. It is the largest test subject in the repo's mirror tree (30 tests, session
  persistence) and it is ledgered rather than exempted on purpose: an exemption buys freedom from the
  ledger, and a `--update` diff on it keeps a growth reviewable. Splitting it further would separate
  those tests from the `db/sessions.rs` subject ADR 0113's mirror names. The 19 still divide 12
  frontend / 4 integration / 3 Rust `foo/tests/`, and the vacuity floors were not touched.
- **The commit stamp on that block is load-bearing, and it is here because the block rotted inside
  its own PR.** The sentence above it said **254 test files walked**; the guard on the tree at
  `2fb9a2a7` prints **255**, and this ADR was written on the branch where that happened. The drift is
  two files' worth of ordinary mirror work: `storage/db/tests/seams.rs` landed at 125 code lines —
  under the 1,000 test seed, so it correctly does **not** enter the ledger — and
  `storage/db/tests/migrations.rs` grew 490 → 504, crossing the 500 bar the guard's second floor arm
  counts. The test class therefore walked 254 → 255 and stood 64 → 65 over 500, which moved the
  combined walk to 584 and the combined over-500 count to 87 (22 production + 65 test). **The
  production class did not move at all**: 329 walked, 10 ledger entries, 8 over the gate, 12 over the
  700 seed with the 2 unledgered being the 2 exemptions. A figure with no stamp reads as a standing
  claim about the current tree, so a tree that moved made this ADR look *broken* when it was only
  *dated*: quote `255` as "what the walk was at `2fb9a2a7`" and it stays true forever, quote it bare
  and it is false the moment anyone adds a test file — which, for a governed test tree, is a matter of
  days. Re-measure with the guard's own instrument (`git ls-files -z -- src-tauri/src src-tauri/tests
  src`, classified by `classify_file`, counted by `code_lines`) and expect the test-class figures to
  have moved; that is the tree, not a contradiction of this decision. Nothing in what was *decided*
  depends on any of these counts: the 1,000 gate, the 1,000 test seed, `FLOOR_FILES=250` and
  `FLOOR_OVER_BIG=1` are all unchanged by this drift, and the floors measure the combined walk, where
  each class clears 250 on its own.
