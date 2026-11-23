# File size: the instrument, the bands, and why the bar moved

Read this before splitting a file because it is long, before quoting a size
number, or before changing a threshold in `scripts/check-file-size.sh`.

The **rule** lives in `AGENTS.md` (the size bullet). This file holds the
arithmetic, the history of the threshold, and the ways the instruments disagree.

**No count here is a target.** Each is correct only for the commit it was
measured at — re-measure with `bash scripts/check-file-size.sh` before quoting
one.

## Two instruments, and they are not interchangeable

| Instrument | What it counts | Who uses it |
|---|---|---|
| **code lines** | comments and blanks stripped; an inline `#[cfg(test)] mod tests` **counted** | `scripts/check-file-size.sh`, every threshold in the ledgers |
| **raw LOC** | `wc -l`, everything | what a human eyeballs in an editor |

Code lines run **~62–71 %** of raw LOC on this repo's large files, so the two
disagree by a third or more:

```
src-tauri/src/agent/session/router.rs     raw 2384   code 1471   (62 %)
src-tauri/src/agent/session/naming.rs     raw 2836   code 2007   (71 %)
src/store/sessions.test.ts                raw 7451   code 5543   (74 %)
```

So **"800 lines" is ambiguous by ~350 lines.** Every threshold in this repo is
**code lines**. When a human states a size in raw LOC, convert before acting.

## The bands, measured at this commit

584 source files (`src`, `src-tauri/src`, `src-tauri/tests`; `.rs`, `.ts`,
`.tsx`), split by whether the path is a test source:

| code lines | production | test |
|---|---|---|
| ≥ 600 | 14 | 48 |
| ≥ 700 | 12 | 36 |
| ≥ 800 | 9 | 26 |
| ≥ 1000 | 8 | 19 |

In **raw** LOC the same tree reads ≥ 600: 117 files, ≥ 800: 75 files,
≥ 1000: 54 files. The production/test skew is the point: **the long tail is
overwhelmingly test sources**, which is why the test class is governed where it
lives rather than excluded (ADR 0112).

## Why the bar moved from "look at it" to "split it"

The policy was originally **1,000 code lines, and size alone is never a reason to
split**, justified by defect data. That data is real and is recorded below — but
it measured a different axis than the one that bites now.

* What was measured: **fix density** and **churn correlation**.
* What was **never measured**: a number for **what a file costs an agent to read.**

The *concern* is not new and must not be presented as new: **ADR 0112 already
records it**, in its rejected-alternatives section, as the requester's position
that "a huge test region is a real navigation and context cost to be *acted on*"
(`docs/decisions/0112-…-1000-code-lines.md:74-76`) — which is why the test class
is gated rather than merely reported. What is absent is a **quantification** of
it. So the 600–800 bar below is a **judgment band chosen from the repo's split
precedent**, not a figure derived from a measurement; do not cite it as measured.

A 1,400-code-line
file is not a defect risk, it is a **context tax paid on every read**, and it is
read with `grep` because nothing in it is findable by name. The bar is therefore
about **navigability and context cost**, not about bugs. Read the defect numbers
below as *refuting "big files are buggy"*, which they do, and not as *refuting
"big files are expensive to read"*, which they do not touch.

So the two claims now coexist, and neither is a mistake:

- **Size does not predict defects.** (measured, below)
- **Size does predict read cost.** (the reason for the 600–800 band)

## The defect data — do not re-litigate it

Fix density by size band is **non-monotonic**: the 600–1000 band is the worst at
**2.61 fixes/kLOC**, and 1000+ is *better* at **1.79**. Correlation between size
and relative churn is **r = 0.057**. **0** defects in the `docs/features/*-known-gaps.md`
set and **0** audit findings attribute a defect to file length.

This is why the split trigger is still a **subject boundary**, never a line
count, and why `errors.rs` (1,135 code lines whole-file, of which **497 are
production** and the rest its inline test module) was deliberately **not** split:
a coordinated move bought nothing measurable. Splitting for size alone, with no
subject to separate, trades a real cost for a hypothetical one.

## The ratchet, as it is wired today

`scripts/check-file-size.sh` walks **two classes**, each with its own gate, seed
threshold and ledger:

| Class | Hard gate | Seed threshold | Ledger |
|---|---|---|---|
| production | 800 | 700 | `scripts/file-size-baseline.txt` |
| test | 1,000 | 1,000 | `scripts/file-size-baseline-test.txt` |

Ledger contents at this commit: **10** production entries, **19** test entries. A
baselined file may not grow by even **one** code line — a rise is a `--update`
diff a reviewer sees, never a threshold someone edits. Run it and it prints one
positive line **per class**; check both.

Two deliberate asymmetries, both recorded in the script's own comments:

- The test class is seeded at **1,000, not 700**, so 19 test files are ledgered
  at once instead of 36. The test-class *gate* is what closes the relocation
  dodge — a file cannot shed lines into its own inline test module to shrink.
- Four production files sit in the 700–1,000 band (`provider_auth/refresh.rs`
  866, `commands/update.rs` 734, `scene.ts` 729, `palettes/everforest.ts` 707)
  and are **not exempt** — ordinary logic is what a ratchet is for. Under the
  800 gate, `refresh.rs` is the one of those four that crosses, and it stands on
  its ledger entry rather than an exemption.

## The in-repo worked example of a good split

`src-tauri/src/storage/db/` — one file into a directory, shipped as **PR #215**:

```
mod.rs 479   stages.rs 254   rows.rs 222   seams.rs 221   board.rs 214
tasks.rs 188   sessions.rs 185   messages.rs 155   artifacts.rs  …
```

`seams.rs` is the pattern the AGENTS.md rule points at: it holds the
`impl FulcrumPersistence for Db` / `impl TaskStore for Db` **seam** bodies
(221 code lines), so the trait wiring is readable in one screen and the
per-subject SQL lives in the sibling named after the subject. Note what made this
possible: **there were real subjects** (board, tasks, stages, artifacts,
messages…). Size was the occasion, not the reason.

Test children follow ADR 0113's mirror rule: one `tests/` child per production
child, `docs/decisions/0113-a-split-production-unit-gets-a-mirror-test-tree-one-tests-child-per-production-child.md`.
ADR 0112 owns the test-class gate boundary,
`docs/decisions/0112-the-size-ratchet-governs-test-sources-as-their-own-class-gated-at-the-same-1000-code-lines.md`.

## The gate moved to 800 — and what that cost

`AGENTS.md` states a **600–800 code line** bar. `HARD_GATE` was **1,000**, which
made the band a number nothing was gated on — the exact objection ADR 0112 raises
against report-only ("a number nobody is gated on is not acted on"). So
`HARD_GATE` is now **800**.

**The measured blast radius, which is why it was free:** **zero** un-ledgered
production files sit at or above 800. The tightening reddens nothing that exists;
it only stops what has not been written yet. `provider_auth/refresh.rs` at 866 is
the one real-tree file that now crosses the gate, and it is carried by its
**ledger entry** (grandfathered, may not grow), not by an exemption — which is
what distinguishes a ratchet from a hard limit.

**`TEST_HARD_GATE` stays 1,000, deliberately.** That number was chosen by the
dodge it closes, not by a size opinion: at 2,000, moving a 1,680-line inline
`#[cfg(test)]` region into `agent/session/tests/` would drop the file under one
gate and put the region under a gate it could never reach — a free pass on both
sides. At 1,000 relocation is a wash, so the only way down is to split by
subject. The two classes having **different** gates is now itself load-bearing,
and the harness's test-class fixtures are what pin it: they still plant 1,001-line
test files and assert the refusal names `gate 1000`.

**Three traps this move sprang, each fixed, all recorded here because they are
the kind that come back:**

1. **The exemptions got smaller, not just the numbers.** An exempt file's only
   ceiling *is* the gate — exemptions skip the ledger, not the gate. So an exempt
   file went from "may reach 1,000 unchecked" to "may reach 800". The harness case
   that planted 950 to prove "grows freely" was planting an illegal file; it is
   750 now, and its over-gate half is 801.
2. **Case 13 lost its teeth silently.** The inline-`#[cfg(test)]` fixture is the
   only case in either harness that tells the whole-file instrument apart from a
   cut-at-`#[cfg(test)]` one. It discriminates *only while the cut figure is at or
   below the gate and the whole-file figure is above it*. At 1,000 + 11 under an
   800 gate, a cut-at-`cfg` instrument reading 1,000 is **refused anyway** — so the
   case prints `ok` while the ratchet is dodgeable again. N is now pinned to the
   gate value (800 + 11 = 811) in **both** harnesses. **If `HARD_GATE` moves
   again, this fixture moves with it.**
3. **The generated ledger header lies until it is rewritten.** `--update` emits the
   gate into `file-size-baseline.txt`'s header but only rewrites the file when the
   *entries* change, so a gate-only change leaves a header naming the old gate.
   The tracked header now reads 800; a `--update` that changes only the header is
   a no-op on disk, so this is a manual step.

**Teeth were proven, not assumed** (AGENTS.md: a pin that passes on the broken
thing is worse than no pin). With `HARD_GATE` reverted to 1,000, the harness
fails **6** assertions — the over-gate case, its gate-number and re-measure
hints, the no-inline-region message, and both exemption halves. With 800 in
place: all pass, and the real-tree run is green.
