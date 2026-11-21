---
status: live
last-verified: 2026-11-17
verified-by: every number below re-measured on `main` at `22f61dd1` (the squash of PR #206, the tree
  this doc ships in) — code-line counts with the ratchet's own classifier, test counts with
  `cargo test --lib -- --list` and `npx vitest list`, and the deferred-set constraints re-checked
  against the source (the four `include_str!("../../db.rs")` sites, the vacuous `REFERENCES spaces`
  assertion, the 17 poison-recovery sites in `session/mod.rs`, `errors.rs`'s own header). The
  before/after pair was taken against `1355cd2a`, the commit PR #206 branched from. Nothing here is
  copied from the plan family this doc replaces, and the plan's own figures were measured at an
  older HEAD — where the two disagree, the numbers below are the current ones.
re-verified: 2026-11-20 — only the `agent/errors.rs` bullet in "What was deliberately NOT split" was
  touched: its stated reason was false (ADR 0063 is not a one-file rule — see the 2026-11-20 amendment),
  it quoted a `//!` header sentence that has since been re-worded, and the one cost the shape does enable
  now has a closure at `src-tauri/tests/error_wire_gate.rs`. The 1135 code-line figure was re-measured with
  the ratchet's own classifier and still reproduces. No other number in this record was re-run that day.
  Re-verified again 2026-11-21, at `8522173e`: the `TaskDetailDialog.tsx` entry under "What was
  deliberately NOT split" was **refuted** and its split has since shipped, so that entry now records the
  refutation (ADR 0114), and a `## Corrections made to this record's own numbers` section records it with
  the four figures re-measured that day — `commands/tasks.rs` `pub(crate)` **6** not 14, `db.rs` poison
  expects **52** not ~51, `batching.rs` non-code **61.6%** not 57%, `session/mod.rs` **17** `into_inner()`
  and **1583** code lines from the ratchet's own run, not the census's 1563. Nothing else in this record
  was re-run that day.
---

# godfile-decomposition — close-out record

Surviving home for what the `docs/roadmap/godfile-decomposition.md` plan recorded. That file is
deleted on ship and `docs/roadmap/` is gitignored, so this doc and the census beside it are the only
copies. Per `AGENTS.md`, this doc cites the **squash commit `22f61dd1` and PR #206**, not the
sixteen commits that preceded them — squash-merge orphans those hashes.

The task asked which files are genuinely too long. The full census, the churn/fix-density data, and
the literature are in **`docs/research/production-godfile-census-and-the-size-metric.md`** (card
artifact key `research`). This doc records only what shipped and what was deliberately left undone.

## The rule that came out of it

Two instruments, non-overlapping, and neither is a defect claim:

- **Subject count is the SPLIT trigger** — it decides where to cut and whether a split is done.
  Judgement, never automated.
- **Raw code-line size is a LOOK-AT tripwire** at 1,000 production code lines, enforced as a
  **ratchet** by `scripts/check-file-size.sh`: a file crossing 1,000 needs an entry in
  `scripts/file-size-baseline.txt`, and a baselined file may not grow by even one code line.
  `--update` regenerates the ledger so an intentional rise is a reviewable diff, never an edited
  threshold.

Both are stated in `AGENTS.md` (`## Conventions`) **with the "size is not a defect predictor" clause
and its figures** — fix density by size band is non-monotonic here (600–1000 worst at 2.61/kLOC,
1000+ at 1.79), size~relative-churn is r=0.057, and 0 of 64 known-gaps defects and 0 of 87 audit
findings attribute a defect to file length. Read without that clause the rule becomes "big files are
buggy", which is false and would send someone to split `errors.rs`.

**The instrument is code lines, and it counts inline `#[cfg(test)] mod tests`.** That is deliberate:
a cut-at-`#[cfg(test)]` instrument can be satisfied by moving code into the test module, which shrinks
the number and changes nothing real. `naming.rs` beating `db.rs` on this ruler is the tell that the
dodge-proof variant is the one running.

## What shipped (PR #206, `22f61dd1`)

Seven splits, every one at a seam the code had already drawn, plus the ratchet. Rust bodies travelled
verbatim; load-bearing comments travelled with the code they explain.

| Moved from | To | Code lines before → after |
|---|---|---|
| `agent/session/router.rs` | `agent/crashlog.rs` (the crash-log attribution matcher) | 1388 → 1343 / crashlog 599 → 646 |
| `agent/session/naming.rs` | `agent/session/naming/prompt.rs` (the titling primitives) | 2259 → 2002 / prompt **267** |
| `attention/delivery.rs` | `attention/delivery/{mod,bus,plugin}.rs` (the two cfg-gated transports) | 450 → 137 / 248 / 57 |
| `lib.rs` | `commands/key_focus.rs` (key-focus cluster + worker factory) | 533 → 467 / key_focus **73** |
| `AgentsDialog.tsx` | `components/agents/` (5 files) | 550 → **158** / siblings 417 |
| `TasksBoard.tsx` | `components/tasks/TaskColumn.tsx` | 398 → **279** / 124 |
| `SpacesList.tsx` | `components/spaces/` (4 files) | 622 → **381** / siblings 268 |

**No test of the split code moved, changed, or disappeared.** Compiler-derived counts on `main`:
`agent::session::router::tests` 22, `agent::crashlog::tests` 14, `agent::session::naming::tests` 77,
`attention::delivery*` 6, `lib.rs` `tests::` 16, `--lib` total 732. Vitest: `AgentsDialog` 37,
`TasksBoard` 42, `SpacesList` 76, `SpacesList.agents` 18. **Exactly one test file changed in the whole
merge** — `src/lib/slabFloatSeparation.test.ts`, whose column-count-pill entry had to be re-pointed at
`tasks/TaskColumn.tsx` in the same commit as the move, because the only `rounded-full` literal in
`TasksBoard.tsx` lived inside the component that moved.

Two honest numbers that are not wins. **Files over 1,000 code lines: 12 before, 12 after** — the two
Rust files that shed lines (`naming.rs`, `router.rs`) stayed above the bar, so the split count did not
move the tripwire count. And **total production code lines went 64,688 → 64,757 (+69)**: a move-only
refactor *adds* lines (module declarations, import headers, doc glue) and buys navigability, not
volume. Anyone citing this work as "we deleted N lines" is citing the wrong column.

The component splits are DOM-identical by measurement, not assertion: `SpacesList`'s commit records
that the pane's full `outerHTML` was hashed per sidebar state before and after and came out
byte-identical, which settles all three constraints at once (one `role="button"` per row,
`textContent` is the title alone, no added DOM level).

## What was deliberately NOT split

This is the half that stops the next audit from re-litigating it. Each entry is a decision with a
mechanical reason, not a deferral for lack of time.

- **`storage/db.rs` (2154 code lines, the largest file in the tree) — deferred to its own plan.** The
  census found the cleanest seam a file that size can present (one `impl Db`, seven contiguous subject
  blocks, zero cross-group method calls, zero test churn **if the file keeps its name**). Three costs
  make it its own project, not a task:
  1. **It must keep its name.** `git grep -n 'include_str!("\.\./\.\./db\.rs")'` → four sites in
     `storage/db/tests/mod.rs` (`:5012`, `:5041`, `:5746`, `:6200`) plus a path read in
     `commands/tasks/tests/artifacts.rs:427`. Renaming it to `db/mod.rs` breaks them with
     `couldn't read … No such file or directory`. The `foo.rs` + `foo/bar.rs` shape is what to use.
  2. **One lint goes vacuously green.** `no_board_table_has_a_foreign_key_to_spaces`
     (`db/tests/mod.rs:5041`) asserts `!source.contains("REFERENCES spaces")` over `include_str!` of
     `db.rs`, and that string is absent **today** — so the assertion already passes for a reason it
     cannot see. Move `SCHEMA` out and it reads a file with no DDL at all and stays green forever.
     Re-point it at the `SCHEMA` symbol, not at a path.
  3. **~51 poison sites** carry `expect("db mutex poisoned")`, and `AGENTS.md` requires a one-line
     rationale at every *new* panic-on-poison site.
  Also unmovable: `Db::open` is ~355 lines of sequential migration gates whose *ordering* is the
  design. A split buys navigability; `open` is the actual complexity.
- **`agent/session/mod.rs` (1563) — deferred, and it is a design change not a file move.** Its
  poisoned-mutex **recovery** semantics (`unwrap_or_else(|p| p.into_inner())`, 17 sites in `mod.rs`
  alone) are correct *because* one lock guards a map of independent per-session rows. Partitioning
  that map across files forces a per-partition decision on the exact discriminator `AGENTS.md`'s
  poison rule turns on. It belongs with the `db.rs` plan, where the same question is already asked.
- **`src/store/sessions.ts` (1370) — blocked by arithmetic.** 431 hand-written
  `useSessions.setState({...})` object-literal key lists get TypeScript's excess-property check
  (TS2353), so a slice split fails `pnpm build` on ~102 of them. The cheap version nobody has pulled
  is extracting the pure selectors and the `SessionsState` interface, leaving the write-set alone.
- **`agent/errors.rs` (1135 code lines) — declined again, on coherence and measured payoff.** It is
  mechanically the cleanest split available, and the case that proves "long" and "bad" are different
  claims. The reason is **not** "ADR 0063 wants one file to own the IPC error English" — that reading is
  false, and the 2026-11-20 amendment says so: every sentence in 0063 that places a variant's English is
  per-variant or per-enum (`:39` "next to the variant", `:78`'s colon enumerating **one** variant's four
  edits), and the ADR states the opposite of a file rule twice (`:94` "chosen by the wire, not by the
  file"; `:105` "never the module it is declared in"). The `//!` header's own "out of it" clause, which
  read as a per-family prohibition, has been re-worded to what its reason clause supports — do not move
  an IPC family to a **non-IPC layer**. What the decline rests on is coherence (twelve families share
  `InvokeErrorExt`, and twelve files means twelve `impl From` blocks that can each diverge) plus a cost
  case that measured empty on all four axes: 0 of 87 audit findings and 0 of 61–76 known-gaps entries
  blame length; fix density 2.01/kLOC against a repo line-weighted 1.98; median diff 58.5 LOC against a
  repo median commit of 358; 18.5k tokens against the 40k/51k/72k/83k files the census names. See the
  amendment and `docs/research/agent-errors-rs-per-family-guarantee-and-the-reopen-argument.md`. The one
  real cost the shape does enable is a **gating** gap — `SettingsError` had 4 of 12 `kind` spellings
  asserted anywhere, `McpError` 2 of 4 and `AgentsError` 2 of 3 (a clear majority unpinned in each;
  `SpacesError` sat at exactly half), and no test enumerated the families at all. A split makes that
  strictly worse — twelve independent omissions, still no enumerator — and it is closed by
  `src-tauri/tests/error_wire_gate.rs`.
- **`commands/tasks.rs`** (worst risk-per-line: `pub(crate)` widenings — recorded here as 14, **measured
  6**, corrected below — and an `include_str!` region delimited by a banner the split would move),
  **`StageEditor.tsx`** (needs a 3-deep split to be honest — a redesign), **`TaskDetailDialog.tsx`**
  (**REFUTED, and since SPLIT** — this entry used to read *"the artifact reader's `requestIdRef` is a
  request-ordering guard; lifting it changes when the fetch fires"*, and every clause of that is false:
  no such symbol exists, it shared no state with the launch path, and the file has zero `useEffect`s, so
  nothing moved when the fetch fired. It shipped as `src/hooks/useArtifactReader.ts` +
  `src/components/tasks/TaskArtifactSection.tsx` — 500 → **385** code lines on the ratchet's classifier,
  `TaskDetailDialog.test.tsx` byte-identical. Deciding record: **ADR 0114**
  (`docs/decisions/0114-a-request-ordering-guard-lives-with-the-await-and-the-region-it-guards-is-one-child.md`);
  evidence: `docs/research/taskdetaildialog-artifact-guard-ownership.md`. The entry is KEPT, not deleted —
  the useful fact is that this decline reason was wrong), **`storage/batching.rs`** (57% of it is the
  prose arguing a lock ordering — the comment-only share, re-measured 57.3%; see below).
  `ChatStream.tsx` and `SpaceTabs.tsx` were already DONE by issue #135 — see
  `docs/features/chatstream-decomposition-closeout.md`, the precedent this work copied.
- **Exempt from the ratchet, by allowlist:** `archimedes-film/scene.ts` and `palettes/everforest.ts`
  only. The recorded reason for `scene.ts` matters — its inherited excuse ("it is a data table") is
  **false**, it is 729 lines of graphics engine; the true reason is that the only check that would
  report a broken split is a manual rendered-frame comparison against a reference image **that is not
  in the repo**, so no automated test guards it. `provider_auth/refresh.rs` (866) and
  `commands/update.rs` (734) stay **under** the ratchet on purpose: they are ordinary logic, and
  guarding them is the point.

## Corrections made to this record's own numbers

Recorded because each was a confident, well-formed wrong answer. Re-measured on this branch at
`8522173e`; the code-line figures come from `scripts/check-file-size.sh` (its own classifier, `TMPDIR`
on real disk), the rest from the `grep -c` printed beside each one.

- **`requestIdRef` never existed.** This record's declined-set entry for `TaskDetailDialog.tsx` named the
  artifact reader's guard `requestIdRef`. There is no such symbol anywhere in `src/` — the guard was
  `const requestKey = useRef<string | null>(null)` (`TaskDetailDialog.tsx:167` before the split, now
  `src/hooks/useArtifactReader.ts:86`), touched at four sites, all inside `selectArtifact`. A decline
  reason that cites a symbol by name must be checked with a grep against the tree, never from prose.
- **The guard shared no state with the launch path, so the coupling this decline rested on did not
  exist.** The reader owned `selectedKey`/`selectedArtifact`/`artifactError`/`requestKey`; the launch
  owned `busy`/`error`/`note`; the intersection was empty, and the file had **0 `useEffect`s**, so the
  only thing that fired the read was the rail button's `onClick`. The decline had mistaken
  **"shares the pane"** for **"shares state"** — the rail and the pane did read the same selection, which
  is a reason to extract them as ONE child, not a reason to leave the file alone. The split shipped
  accordingly (ADR 0114, `docs/research/taskdetaildialog-artifact-guard-ownership.md`): 500 → **385**
  code lines (`grep -vcE '^[[:space:]]*(//|\*|/\*|$)' src/components/TaskDetailDialog.tsx`), with
  `TaskDetailDialog.test.tsx` byte-identical to the pre-split base and all 63 of its tests passing.
- **`commands/tasks.rs` is recorded here with 14 `pub(crate)` widenings; the measured count is 6**
  (`grep -c "pub(crate)" src-tauri/src/commands/tasks.rs` → **6**). That was the risk case for the
  worst-risk-per-line file in the census, so the number was load-bearing and it was 2.3× too high. The
  file's other blocker **holds**: `include_str!("../../tasks.rs")` delimits a region on a banner the split
  would move (`src-tauri/src/commands/tasks/tests/stages.rs:294`). The decline therefore **stands**, but
  on one reason instead of three.
- **Every other declined file's blocker held on re-measurement**, with two figures corrected in the
  process. `storage/batching.rs`: 539 code / 1403 raw → **61.6%** non-code, not the 57% this record
  quotes — and 57% was never the same quantity anyway, since comment-only lines alone are **57.3%**
  (`grep -cE '^[[:space:]]*(//|\*|/\*)'` → 804 of 1403); the prose blocker is stronger than recorded, not
  weaker. `storage/db.rs`: **52** poison expects, not ~51
  (`grep -c 'expect("db mutex poisoned")' src-tauri/src/storage/db.rs`). `agent/session/mod.rs`: **17**
  `into_inner()` (`grep -c "into_inner()" src-tauri/src/agent/session/mod.rs`) — which is that file's
  number, and is routinely conflated with `db.rs`'s 52. Its size is **1583** code lines per the ratchet's
  own run, where the census says 1563; `bash scripts/check-file-size.sh --update` printed
  `baseline unchanged: 11 file(s) over 700 code lines`, so the ledger's `1583` line is this tree's
  measurement and **1583 is the figure to quote** — a hand-run classifier is not the ratchet's classifier
  and must not be quoted as a ratchet figure (the research report records the 1563/1583/1589 three-way
  and settles it the same way). The `session/mod.rs` decline holds.

## One durable lesson from review

The greptile review on PR #206 found a real defect in the guard itself, fixed in the same PR:
`code_lines` had `|| true` on its `grep`, which conflated exit 1 (*read the file, nothing matched* — a
legitimate zero) with exit 2 (*could not read the file* — not a measurement at all). An unreadable
file therefore measured 0, passed the gate, and `--update` then dropped it from the ledger silently.
**A metric that cannot open a file must refuse, not record zero** — the same principle as the guard's
blind-walk floor, one level down. Its sibling case in `check-file-size.sh --self-test` plants a file
the walk cannot read and requires a refusal in both modes.
