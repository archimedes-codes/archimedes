---
status: current
last-verified: 2026-11-16
verified-by: 6 parallel researcher subagents (Rust storage / Rust agent-session / Rust commands-config /
  TS state-lib / TS components / metric evidence) + primary re-verification of every load-bearing claim
  at HEAD `4c06b1de`. Local tree measurements plus web research (Hatton 1997, Fenton & Ohlsson 2000,
  Koru et al. 2008/2009, Nagappan & Ball ICSE 2005, SmartBear/Cisco, Google eng-practices, ESLint,
  Clippy, SwiftLint). 2026-11-16.
task: tsk_0ef56cb0-1b91-4017-8744-76bc3d7d6f74
---

# Production godfiles: the census, the seams, and whether size is a legitimate split trigger

## Executive Summary

**Settled question.** Which production files in Archimedes Desktop are genuinely too large to
maintain, which can actually be split, and is raw line count a legitimate split trigger — or is
`AGENTS.md`'s "subject count, not line ratio" rule an excuse? **Production code only**; test files and
`tests/` directories are counted as blast radius, never as split candidates.

Four results, in the order that matters:

1. **The raw line counts in circulation overstate every candidate by 2–4×.** They include doc
   comments and inline `#[cfg(test)]` regions. Measured on **code lines only** (comment-only and blank
   lines stripped, the `#[cfg(test)]` region excluded), there are exactly **two** production files
   over 1,000 code lines: `storage/db.rs` (2,100) and `agent/session/mod.rs` (1,560). Everything else
   on the "huge" list is prose, inline tests, or a data table. `commands/agents.rs` — 1,603 raw lines
   and 7th on the naive ranking — has **141 code lines**.

2. **The challenge to `AGENTS.md`'s rule is correct, and the rule's own showcase example is
   falsifiably wrong.** The rule cites `ChatStreamMentionPicker.test.tsx` as *"62 tests over ONE
   subject… do not split"*. That one `describe` cites **five different ADRs** (0031, 0032, 0033, 0035,
   0044) and the file's own header comment argues its `?`-completion cluster is a *different* subject.
   One `describe` means the subject rule has **no lever on the file at all** — it blessed the file for
   being one subject when the file argues it is four.

3. **But a raw line count is the wrong *split* trigger, and the local data settles it.** Fix density
   by size band across 111 production files is **not monotonic** (100–300 → 1.91 fixes/kLOC, 300–600 →
   1.34, 600–1000 → **2.61**, 1000+ → 1.79): the biggest files are *less* defect-dense per line than
   the small ones. And **0 of 64 recorded known-gaps defects and 0 of 87 audit findings attribute a
   defect to a file being long.** Length here has been a *symptom* noticed on the way to a real
   finding, never the cause.

4. **`db.rs` is the real target and the best-shaped split in the repo**: one `impl Db` of 2,409 lines,
   54 `pub` methods with **zero private**, seven contiguous subject blocks with **zero cross-group
   method calls**, E0117-clean, and its 8,061-line test module needs **zero edits** provided `db.rs`
   keeps its name.

**The metric decision (taken by the requester, 2026-11-16): both rules, with non-overlapping roles.**
Subject count remains the **split trigger** — it decides *where* to cut and *whether a split is done*.
Raw size becomes a **look-at tripwire** at **1,000 production code lines** / 2,000 test lines, as a
ratchet, never a hard CI gate. See [Recommendation](#recommendation-the-metric).

---

## The census (one instrument, applied uniformly)

**Instrument.** Rust: cut at the first top-level `#[cfg(test)]`, then strip comment-only and blank
lines from the remainder. TS/TSX: strip comment-only and blank lines.

```bash
# Rust production code lines
for f in $(git ls-files 'src-tauri/src/*.rs' | grep -vE '/tests?/'); do
  s=$(grep -nE '^#\[cfg\(test\)\]' "$f" | head -1 | cut -d: -f1); s=${s:-$(( $(wc -l < "$f") + 1 ))}
  code=$(sed -n "1,$((s-1))p" "$f" | grep -vcE '^\s*(//|\*|/\*|$)')
  [ "$code" -ge 400 ] && printf "%5s  %s\n" "$code" "$f"
done | sort -rn
# TS/TSX production code lines
for f in $(git ls-files 'src/*.ts' 'src/*.tsx' | grep -vE '\.(test|spec)\.'); do
  code=$(grep -vcE '^\s*(//|\*|/\*|$)' "$f"); [ "$code" -ge 400 ] && printf "%5s  %s\n" "$code" "$f"
done | sort -rn
```

### Production files over 400 code lines, at HEAD `4c06b1de`

| Code lines | Raw | File | Verdict |
|---|---|---|---|
| **2,100** | 4,148 | `src-tauri/src/storage/db.rs` | **the only true godfile** |
| **1,560** | 3,103 | `src-tauri/src/agent/session/mod.rs` | **real, second** |
| 560 | 2,958 | `src-tauri/src/agent/session/naming.rs` | one subject; split the primitives anyway (cheap) |
| 532 | 1,305 | `src-tauri/src/commands/tasks.rs` | splittable, messiest |
| 497 | 1,719 | `src-tauri/src/agent/errors.rs` | mechanically cleanest; **ruled against, 3× recorded** |
| 496 | 2,286 | `src-tauri/src/agent/session/router.rs` | cleanest Rust split |
| 442 | 1,530 | `src-tauri/src/commands/settings.rs` | splittable, moderate value |
| **1,344** | 2,840 | `src/store/sessions.ts` | real, **blocked by arithmetic** (F5) |
| 729 | 1,196 | `src/lib/archimedes-film/scene.ts` | exempt — **for a different reason than recorded** |
| 707 | 1,061 | `src/lib/palettes/everforest.ts` | exempt, **earned** |
| 636 | 1,018 | `src/lib/paletteTestKit.ts` | a test kit; exempt by role |
| 595 | 1,169 | `src/components/SpacesList.tsx` | **cleanest TS seam, biggest test bill** |
| 583 | 876 | `src/components/chat/MessageList.tsx` | messy — 17-ref surface |
| 557 / 551 / 549 / 419 | — | `palettes/{catppuccin,kanagawa,ayu,rose-pine}.ts` | exempt, **earned** |
| 550 | 934 | `src/components/AgentsDialog.tsx` | **best value-per-risk in the TS set** |
| 531 | — | `src/components/Reasoning.tsx` | below the tripwire |
| 528 | 1,550 | `src/lib/tauri/types.ts` | **size is the wrong lens**; leave it |
| 504 | 718 | `src/components/StageEditor.tsx` | **blocked on shape** (needs a 3-deep split) |
| 500 | 882 | `src/components/TaskDetailDialog.tsx` | partial only |
| 468 / 446 / 444 | — | `toolOutput.ts`, `SettingsPage.tsx`, `McpSection.tsx` | low value |

**Files that the raw ranking puts in the queue and the code ranking removes:**

| Raw | **Code** | File | Why it is not a godfile |
|---|---|---|---|
| 1,603 | **141** | `commands/agents.rs` | 2 commands, 8 items, 1,264 inline test lines (9:1 test:code) |
| 749 | **116** | `open.rs` | a decision table + one delegation; its 489 test lines are the table's rows |
| 1,364 | **197** | `agent/provider_auth/refresh.rs` | 13 items all under 60 lines; **already ruled on by name** in the 2026-11-07 audit |
| 1,810 | **260** | `config.rs` | 109 lines of logic + 152 lines of static `KNOWN_PROVIDERS` table |
| 1,459 | **289** | `commands/update.rs` | splittable, but for platform isolation, not size |
| 683 | **190** | `src/components/SpaceTabs.tsx` | **9th biggest by raw, smallest by code** — 487 comment lines carry the ARIA/geometry argument |
| 737 | **290** | `src/components/ChatStream.tsx` | **DONE** — split by issue #135, 1,553 → 710 |

---

## Findings

### F1. `db.rs` presents the cleanest seam a 4,148-line file can present

Measured internally (`grep -nE '^impl'`; spans by brace-matching scanner):

- **One `impl Db` at `:1009–3417` = 2,409 lines, holding all 54 inherent methods.** Not several impls.
  (`grep -cE '^    pub fn '` → **54**; private `fn` *inside* `impl Db` → **0**. The 28 private `fn`s
  the raw grep finds belong to the five *other* impls — the three `From` conversions,
  `FulcrumPersistence`, and `TaskStore`.)
- **The multi-file inherent-impl pattern is already in production in this repo**, four times for
  `SessionManager`: `session/mod.rs:741`, `:1340`, `naming.rs:479`, `router.rs:20`.
- Methods fall into **seven contiguous subject blocks**: board+tasks 726, sessions 436, `open` 355,
  stages 331, artifacts 227, messages 140, spaces 115.
- **Cross-group `self.method()` calls: 3 total, all intra-group. Zero cross-group.** A `db/tasks.rs`
  that needs `db/sessions.rs` does not exist.
- All 51 `expect("db mutex poisoned")` sites reconcile to the seven groups (sessions 16, stages 8,
  spaces 7, tasks 6, messages 6, board 4, artifacts 4) with **none** in `db.rs` itself — `Db::open`
  holds the raw `Connection` before `Db` exists.

**Proposed shape — `db.rs` KEEPS ITS NAME, seven siblings under `db/`:**

| File | Content | Raw | Poison |
|---|---|---|---|
| `db.rs` (stays) | errors, `Db`, **`open`**, schema machinery, `SCHEMA`, re-exports, `mod tests;` | ~930 | 0 |
| `db/rows.rs` | 6 row structs, `*_COLUMNS`/`*_ROW_FIELDS`/arity ties, 6 `*_row_from` mappers | 483 | 0 |
| `db/views.rs` | `StageWithTasks`, `TaskCardView`, `Artifact`, `ArtifactMeta`, `MoveOutcome`, `SessionRecency` | 162 | 0 |
| `db/seams.rs` | `impl FulcrumPersistence for Db`, `impl TaskStore for Db` | 301 | 0 |
| `db/tasks.rs` / `db/board.rs` / `db/stages.rs` | the task/board/stage verbs + the shared slug helpers | 541 / 195 / 461 | 6 / 4 / 8 |
| `db/sessions.rs` / `db/messages.rs` / `db/spaces.rs` / `db/artifacts.rs` | the per-table verbs | 453 / 146 / 130 / 240 | 16 / 6 / 7 / 4 |

Biggest resulting file: `db.rs` at ~930 raw / ~559 code — **4.5× smaller, and structurally below
`session/mod.rs`.**

**Why `db.rs` must keep its name (rustc-probed, not inferred).** The repo's production convention is
`foo.rs` + `foo/bar.rs` — `agent/web.rs` + `web/render.rs`, `attention.rs` + `attention/delivery.rs`,
`agent/session/mod.rs` + `naming.rs` + `router.rs`. The five `foo/` directories that use `mod.rs` are
**test-only**. Probed with throwaway crates: `include_str!("../m.rs")` **compiles** when `m.rs` stays
a file and gains an `m/t.rs` sibling; the same probe with `m.rs` renamed to `m/mod.rs` fails with
`error: couldn't read src/m/../m.rs: No such file or directory`. **A rename is what would break the
tests, not the split.**

**Cost, measured:**
- **Test churn: ZERO** if `db.rs` keeps its name. `db/tests/mod.rs` (8,061 lines, **136 tests**,
  compiler-derived via `cargo test --lib -- --list | grep -c '^storage::db::tests::'`) has exactly one
  import — `use super::*` — and `super` is `db`. The private `db.conn` field it touches 22× is visible
  from a descendant module (probed). **No test moves, no test body changes.**
- **Visibility widening: zero for the methods** (54/54 already `pub`). ~26 `pub(crate)` tokens for the
  shared `*_COLUMNS` consts, the 6 `*_row_from` mappers, and the 6 stage helpers. ⚠️ The probed
  mechanic: `pub(super) use rows::*;` in the parent is **silently broken** (`glob import doesn't
  reexport anything with visibility pub(crate) because no imported item is public enough`); the items
  themselves must be `pub(crate)`. It fails loudly, which is acceptable.
- **Production fan-in: 141 call sites across 12 files, every one through `Arc<Db>` methods.** No
  external caller names a free function, a const, or a private helper (`src-tauri/tests/fulcrum_seams.rs:84`
  keeps compiling unchanged). The split adds **one** compiler-visible line: `storage/mod.rs`'s
  `pub use` list, and even that need not change.

### F2. One hazard goes silently green — and it is the one that matters

Six tests read `db.rs`'s **source text by path**. Five redden loudly (good). One does not:

```rust
// src-tauri/src/storage/db/tests/mod.rs:4895
fn no_board_table_has_a_foreign_key_to_spaces() {
    let source = include_str!("../../db.rs");
    // … asserts !source.contains("REFERENCES spaces")
```

`grep -c 'REFERENCES spaces' src-tauri/src/storage/db.rs` → **0** today, so it passes. **Move `SCHEMA`
to `db/schema.rs` and this assertion reads a file containing no DDL at all — passes for the wrong
reason, forever.** It must be re-pointed at `schema.rs`, or better, at the `SCHEMA` *symbol*, which
cannot drift. This is `AGENTS.md`'s own recorded warning applied verbatim: *"check any vacuity floor
in that lint."*

The other five, with their proposed homes:

| Site | Anchor | Survives? |
|---|---|---|
| `db/tests/mod.rs:4866` | `gate(&mut conn, ` ×12 | ✅ `open` stays in `db.rs` |
| `db/tests/mod.rs:5600` | `FROM task_sessions ts` exactly once | ❌ → re-point to `db/board.rs` |
| `db/tests/mod.rs:6054` | `fn backfill_session_todos` | ✅ stays in `db.rs` |
| `commands/tasks/tests/stages.rs:326` | `pub fn delete_stage(` | ❌ → re-point to `db/stages.rs` |
| `commands/tasks/tests/artifacts.rs:427` | `impl TaskStore for Db` | ❌ → re-point to `db/seams.rs` |

The dispatch-style probe **misses all six**: `grep -rn CARGO_MANIFEST_DIR … | grep read_to_string`
finds none of them, because these use `include_str!` and `format!`. Widen the probe to
`grep -rn 'include_str!\|read_to_string' src-tauri/ | grep -i '<file>.rs'`.

**The second real limit: `Db::open` is 355 lines of load-bearing sequential migration logic** — 12
schema gates, the `agent_id` drop-migration, `native_messages_migrated` crash recovery, `SCHEMA`, two
backfills — whose *ordering* is the design. It cannot be split. **A split buys navigability, not
decomposition.** If the complaint is "this file does too much," the split is cosmetic and `open` is
the actual work.

### F3. `session/mod.rs` — the expensive half is invisible to grep

3,101 production lines, but **1,560 code / 1,421 comment (46%)**. It is **not** one impl: two
`impl SessionManager` blocks (426 + 1,639 lines) plus `router.rs` and `naming.rs` carrying two more.
The responsibilities map onto **contiguous** ranges, so the seam exists:

`session/mod.rs` → a ~90-line shell plus ~12 siblings (`types/`, `catalog.rs`, `model_resolve.rs`,
`manager/{struct,accessors,wiring,hooks,builder,lifecycle,worker_boot,prompt,turn,config_option,refresh,interactive,close}.rs`),
max file ~392 lines.

**Use the flat variant, not a nested `manager/`.** Probed with rustc: a nested `manager/` forces
`pub(crate) mod manager;` plus `pub(in crate::agent::session)` on 12 field groups (`LiveWorkerSession`,
`SessionState`, `SessionDriver`, `NativeConfigState`) — and breaks the **6 `LiveWorkerSession { … }`
struct literals** in `router.rs`'s test module with `E0616: field is private`. The flat variant matches
the existing `router.rs`/`naming.rs` shape exactly and needs `pub(super)` only.

**The dominant hidden cost:** `session/tests/mod.rs` (4,046 lines) does `use super::*`, and **28 of the
parent's 41 import names** reach the tests through that glob with no local re-import. Probe:

- parent keeps `use std::collections::HashMap;` → compiles.
- code + its `use` move to a sibling, parent keeps only the `mod` decl → **`error[E0425]: cannot find
  type HashMap`**.
- parent keeps a re-export shim the child's glob consumes → **`cargo clippy --all-targets -- -D
  warnings` fails with `unused import`**, which is this repo's hard gate.

So a re-export shim needs `#[allow(unused_imports)]`, or the 4,046-line test module needs ~28 explicit
imports. **No grep finds this.**

**A real cost the split fixes rather than causes:** the poison-recovery rationale block sits at
`session/mod.rs:781–787`, and **11 of the 16 mod.rs poison sites are 574–2,136 lines away from it.**
It already justifies a minority of what it is cited for. Per-file one-line headers (which `AGENTS.md`
already demands for *new* panic sites, and which `router.rs:165–167` already does) are strictly better
than a 2,136-line distance — but that is a prose obligation, not a free win.

### F4. The cheapest real wins, ranked by value-per-unit-risk

| # | Split | Gain | Risk | Evidence |
|---|---|---|---|---|
| 1 | `router.rs` crash-log trio → `agent/crashlog.rs` | 117 lines | **L** | destination **already documents it in prose** (`crashlog.rs:12` names `is_worker_crash_log_name`); 0 external callers; no source lint |
| 2 | `naming.rs` primitives → `session/naming/prompt.rs` | 366 lines | **L** | boundary **pre-documented in the file's own `//!` header**; the primitives half has no `Db`, no `SessionManager`, no async; 9 of 10 items have 0 external callers; the test module already imports them by name |
| 3 | `attention/delivery.rs` → `delivery/{bus,plugin}.rs` | 591 lines | **L** | the module boundaries (`pub mod bus` 591 lines, `pub mod plugin` 133) **already exist in source**; 5 `super::` → `super::super::` edits. ⚠️ keep `Cargo.toml:253-269`'s cfg comment paired with `delivery.rs:44` |
| 4 | `AgentsDialog.tsx` → 4 files (903→380) | 523 lines | **L** | **best ratio in the TS set**: 3 `useState`, **0 `useEffect`**, 5 already-separate top-level functions, and its 37-test file is **prop-driven with zero IPC mock and zero `resetStores`** |
| 5 | `lib.rs` focus cluster + `worker_program_from` → 2 files | 227 lines | **L** | must keep a crate-root re-export (`agent/session/mod.rs:1294` calls `crate::ProductionWorkerFactory`) |
| 6 | `TasksBoard.tsx` → 3 files (727→330) | 397 lines | **L-M** | `TaskColumn` is already a top-level function; thread `columnProps()` carefully or cross-column drag breaks with no test naming it |
| 7 | `router.rs` remaining subjects → 5 files | ~660 lines | **L** | ⚠️ `commands/tasks/tests/artifacts.rs:432` reads `router.rs` by path and asserts `WorkerInboundEvent::TaskRequest` is present — draw the boundary **below** the match arm |
| 8 | `SpacesList.tsx` → 6 files (1142→470) | 672 lines | **M** | the most concrete seam (`SessionRow`, `ArchivedSection`, `ArchivedSessionRow` are **already at column 0**) and the biggest bill: 2,393 + 1,340 test lines, 11 imports to re-grep |
| 9 | `session/mod.rs` → ~12 files | 3,101→~390 max | **M** | the 28-import glob above |
| 10 | `commands/tasks.rs` → 5 files | 534 code | **H** | 14 `pub(crate)` widenings; `board_call` alone has 14 sites across every block; `include_str!("../../tasks.rs")` delimits the region on a `// ── A4` **banner the split moves**; two new filenames collide with existing test filenames |

**Ruled against, with the reason:** `errors.rs` (F6), `config.rs` / `agents.rs` / `open.rs` /
`refresh.rs` (below the tripwire on code lines), `SpaceTabs.tsx` and `ChatStream.tsx` (**DONE**),
`StageEditor.tsx` (**blocked on shape** — extracting the 388-line single return into one `StageRow`
*relocates* the problem; the honest move is a 3-deep split into six row components),
`TaskDetailDialog.tsx` (**partial only** — the artifact reader's `requestIdRef` is a request-ordering
guard whose state feeds two proposed children, so lifting it changes when the fetch fires),
`MessageList.tsx` and `EmptyStateFilm.tsx` (**messy** — 11 of 17 refs cross the seam; the ADR 0070
liveness probe sits *between* the two effects a split would separate).

### F5. `store/sessions.ts` is blocked by arithmetic, not by opinion

Three prior audits carry it forward as an explicit non-goal on the ADR argument (ADR 0016's ordering,
0073, 0049, 0041 *are* the interleaving). The mechanical reason is sharper:

**441 `useSessions.setState({...})` sites, 431 of them hand-written object-literal key lists.**
`setState` on a fresh literal gets TypeScript's excess-property check — verified as **TS2353** against
the repo's real `tsconfig.json` via the compiler API. So a slice split does not leave tests stale, it
**fails `pnpm build` on every key that moved**:

| File | Lists | Span >1 store | Key entries re-homed |
|---|---|---|---|
| `App.test.tsx` | 24 | **21 (88%)** | 128 of 131 |
| `sessions.test.ts` | 151 | **81 (54%)** | 401 of 499 |
| **Total** | | **≈102 build-breaking rewrites** | **≈529 key entries** |

And `tsc` **checks the test files** (`tsconfig.json` `include: ["src"]`; `npx tsc --showConfig` → 435
files, **187 of them `*.test.ts(x)`**), so these are build failures, not warnings.

While verifying this, `AGENTS.md`'s `App.test.tsx` warning was re-confirmed live: `grep -cE
"^\s*resetStores\(\)" src/App.test.tsx` → **0** (all 5 mentions are prose), and the 24 `setState` lists
cover 14 of 18 state fields, never resetting `history`, `contextUsage`, `compacting`, `stalled`.

**The cheap version nobody has pulled:** extract the **11 pure selectors (543 lines, verified to read
the store zero times)**, the 26-line write-set contract (`SESSION_KEYED_FIELDS`), and the
`SessionsState` interface (473 lines, **409 of them comments**) into `src/store/sessions/`. Store drops
~750 lines, all 20 names stay re-exported so the **86-file import graph is untouched**, and nothing
crosses `layerBoundary.test.ts`'s allowlist. Note `zustand` slice middleware is a dependency but
**unused and untested in this repo** (0 hits for `StateCreator`/`combine`/`createStore`) — adopting it
is a new pattern, not a house one.

### F6. The exemptions: one earned, one asserted-but-right, one mis-stated, one reversed

- **Palettes: EARNED.** `paletteTestKit.ts:559 gradePalette()` runs a **per-token census** —
  `declaredHere.size === modeSpec.declaredCount` (94 for everforest dark), `inheritedFromDefault`
  set-diffed against `referenceTokens`, and an `offSpecAllowList` that *refuses an exception naming a
  hex the source does not publish*. A split produces a file the kit grades identically → zero gain,
  real risk. Also note `paletteCompleteness.test.ts` **writes a probe file into `src/lib/palettes/`
  and deletes it in a `finally`** — adding files to that directory is not free.
- **`scene.ts`: the exemption is ASSERTED and its stated reason is FALSE, but the conclusion holds for
  a better reason.** It is described as a verbatim data table. Measured: **0 data lines, 729 code
  lines** — it is a graphics engine (`createScene` 368, `updateScene` 147, `solveLimbIK` 47,
  `evaluateChoreography` 64). No generator, no checksum pin, no `DO NOT EDIT` marker. **But** its
  visual correctness is pinned by a rendered frame against `/tmp/film-ref-6p5s.png`, **which is not in
  the repo** (`find . -name "film-ref*"` → empty); its own header says *"No jsdom test can see either
  failure."* So splitting it is possible and **no test would tell you whether you broke it** — a
  stronger anti-split argument than "it's data", and the one a planner should be given.
- **`src/lib/palettes.ts` (629) is mis-listed** alongside the palette tables — it is the
  behaviour-bearing registry (`PALETTES`, `paletteClass`, `shikiThemeFor`), not data.
- **`errors.rs`: a three-way recorded decision, and mechanically the cleanest split available.**
  12 error families, **zero code-level cross-family references**, largest resulting file 180 lines,
  zero consumers needing edits (all reach it through `agent/mod.rs:99`'s re-export), zero source-text
  lints, E0117-clean. Against it: the file's own `//!` header at `:12` (*"do NOT split this file by
  layer"*), `docs/features/improvement-boundary-residue-closeout.md:267`, and the 2026-11-07 audit at
  `:369` and `:806`. Plus ADR 0063's guarantee that a new variant's user-facing English lands in
  **one** file. **This is the case that proves "long" and "bad" are different claims.**

### F7. Component tests are cheap to preserve — measured, not assumed

The question that decides whether component splits are cheap: do Testing Library tests survive
extraction? **Yes.** `SpacesList.test.tsx`: **85 `getByText`, 48 `getByRole`, 95 `screen.getBy*`,
0 `getByTestId`, 0 snapshots**, and it imports **exactly one** production module for its query surface
(`SessionListRow`). The precedent is case-proven — commit `dc418826` extracted `SessionRow` and
`ArchivedSessionRow`, **134 lines deleted from `SpacesList.tsx`, zero test files touched.**

Three constraints keep the contract green (all three are quoted from that commit's own message):
**add no DOM level** between a row and its children (10 `.closest('[role="button"]')` reads), **add no
text of your own** (a test asserts `row.textContent === "alpha"` exactly), **add no second
`role="button"`**.

`SpaceTabs.test.tsx` is the exception — 4 `getByTestId`, and it pins nesting directly
(`expect(close.parentElement).toBe(pill)`, `querySelectorAll("button button")` length 0). That is a
second, independent reason it is done.

**Style coupling is free:** 0 CSS modules, 0 per-component stylesheets; all styling is Tailwind
literals inside the JSX being moved. Two gates to respect: `chromeButton.test.ts` forbids an
extraction from `SpaceTabs.tsx` importing `chromeButton.ts`, and `classNameConvention.test.ts` keys one
allowlist entry by **file path** (`MessageList.tsx`'s `isEmpty` ternary) — moving that ternary reddens
it, one-line fix.

### F8. `AGENTS.md`'s own hazard list, verified concretely

| Hazard | Result |
|---|---|
| **E0117 orphan rule** | **Cannot fire.** `grep -rnE '^impl(<[^>]*>)? .+ for .*\bfulcrum_harness::' src-tauri/src` → **0 hits**. Every `impl` in every candidate has a locally-defined `Self`. A module move within one crate does not affect coherence — only the defining *crate* does. The recorded `BudgetFacts` hazard was a **cross-package** move; none of this is. |
| **One compilation unit** | Confirmed and **binding on sequencing**: every split is strictly serial, and `session/tests/mod.rs`'s glob means every intermediate `mod.rs` state must compile. Budget a full `cargo test` (~981–1003 tests) per commit — `storage/` edits invalidate ~40 test binaries. |
| **`fulcrum-harness` pin** | `cargo tree -i fulcrum-harness` → `v0.3.3`, no path suffix; `Cargo.lock` carries a crates.io `source` + `checksum`; `.cargo/config.toml` **absent**. Constrains nothing here — no type moves into the engine. |
| **Source-text lints** | The real hazard class, and the standard probe misses it. 6 on `lib.rs`, 6 on `db.rs`, 2 on `batching.rs`, 2 on `update.rs`, 1 on `router.rs`, 1 on `tasks.rs`. **Zero** on `session/mod.rs`, `naming.rs`, `errors.rs`, `config.rs`. |
| **`noUnusedLocals`** | Confirmed, and **worse than documented**: an unused `import type` is also **TS6133** (`verbatimModuleSyntax`), and `tsc` checks `src/**/*.test.tsx`. Choreography: **delete the block first, then re-grep each symbol, then drop the import** — the reverse order breaks the build with no hint which block needed it. Asymmetry: an orphaned **exported** symbol is silent, so an extracted-but-unimported `lib/` module will *not* redden the build. |
| **File-order dependence** | `AGENTS.md` is still true: `--sequence.shuffle` on `sessions.test.ts` → 1 failed / 253 passed. **But all six component targets are already shuffle-clean** (73 / 91 / 52 / 85 / 49 / 37 passed). It is a `src/store/` problem, not a component-test problem. Vitest `isolate: true` means a new file cannot see another's store state — but any new test file must call `resetStores()` itself. |

---

## The metric

### Recommendation

**Both rules, with non-overlapping roles. Neither as a hard CI gate.**

| Rule | Answers | Fires on | Instrument | Enforcement |
|---|---|---|---|---|
| **Subject count** — the **SPLIT trigger** | *Where do I cut, and is it done?* | a `describe` / `#[cfg(test)]` block over ~25 **unrelated** tests, or a module spanning two written-down subjects | `npx vitest list` / `cargo test -- --list` per block | **Judgement.** Never automated — "unrelated" is not mechanisable |
| **Raw size** — the **LOOK-AT tripwire** | *Which files must someone open and justify?* | production **>1,000 code lines**; test **>2,000 lines** | `wc -l` **after stripping comments and blanks**; `#[cfg(test)]` counted separately | **Ratchet** — existing files may not grow past their recorded size; new files may not exceed the threshold. A shell script in the `check-commands.sh` / `check-temp-dir-census.sh` idiom |

**Why both, and why they are not in conflict.** `AGENTS.md`'s formulation — *"subject count, not line
ratio"* — correctly rejects the **ratio** trigger (a file-level instrument pretending to be a
block-level one; it fires on `errors.rs`, `settings.rs`, `router.rs`, `refresh.rs`, all of which have
coherent tests over small production bodies). But it over-generalises from *"ratio is not the trigger"*
to *"size is not a signal"*, and size is a signal — just not a **split** signal.

**The evidence that the subject rule structurally cannot see the biggest files.** Of 57 test files over
500 lines, **46 (81%) have no block over 25** — the rule blesses them. Of 22 over 1,000 lines, **14
(64%) are blessed**. The largest, `sessions.test.ts` at 7,183 lines, has a max block of **23** across
41 describes: the rule says *nothing to do here* about a 289 KB / ~72k-token file.

**And the rule's own showcase example is wrong.** `ChatStreamMentionPicker.test.tsx` — cited in
`AGENTS.md` as the case the rule **PERMITS**, *"62 tests over ONE subject… do not split"* — is **one
`describe`** (so the rule has no lever), cites **five ADRs** (0031×3, 0032×1, 0033×7, 0035×2, 0044×1),
and its own header comment argues the `?`-completion cluster is a *different* subject from the
`$`/`@`/`#` mentions and again from the picker geometry. **The rule blessed it for being one subject
when the file argues it is four.** A `describe` is a container a human typed, not a semantic unit the
rule can verify. (Defensible as a *split* decision — 2 commits ever, 0 fix commits. Indefensible as a
*tripwire exemption*.)

### Why 1,000 and not 200

- **Ecosystem convergence.** SwiftLint `file_length` defaults 400 warn / **1000 error**; the open
  Clippy file-length proposal (`rust-clippy#16674`) defaults **1000**; ESLint `max-lines` defaults 300
  but is **not in `eslint:recommended`** and **Airbnb sets it off**; Google C++ sets no limit.
  **vscode, angular, react, next.js and rust-lang/rust enforce nothing at all.**
- **Locally, 1,000 code lines flags 10 of 296 production files (4 Rust, 6 TS)** — a list a person will
  work. **200 flags 111 (38%) holding 82% of all raw lines** — that is a rewrite, not a backlog, and
  it reproduces the "fires on 15 of 16 candidates" failure the repo already rejected in the ratio
  trigger.
- **It correctly excludes this repo's genuinely hot files** — `lib/tauri.ts` (307 code lines, 62
  commits, churn/line 10.1, the highest fix/kLOC at 16.29), `ChatStream.tsx` (738, churn/line 9.3).
  Those are **churn** problems and the churn metric already names them. Two metrics, two lists, no
  overlap — that is a feature, not a gap.
- **Test threshold 2,000, deliberately 2× production**, because a lower number is all noise: 46 of 57
  test files over 500 lines are subject-clean. At 2,000 it flags exactly 6 files.

### Fix the instrument before fixing the number

**47 of 296 production files cross 200 in raw lines but not in code lines, and the divergence is
entirely one-way** (0 files are code-only-over-200): `commands/files/completion.rs` 517→134,
`agent/crashlog.rs` 317→89, `agent/harness/store.rs` 207→94. **The same 200-line threshold measured
"raw" versus measured "code" yields 111 versus 64 files — a 73% swing from the instrument alone.** The
2026-11-07 audit's `>200 lines` column names no instrument and is therefore not re-runnable. **Any
rule this repo adopts must name its instrument in the rule text**, the way `AGENTS.md` already does for
test counting (*"Count tests with the runner, not by grepping `it(`"*).

**Exemptions by explicit allowlist**, mirroring the precedent already set: generated / verbatim ports /
data tables (`scene.ts` — 1 commit ever, churn/line 1.0; the four palette files — 1 commit each), and
pure-declaration files (`lib/tauri/types.ts` — 84 declarations, 0 functions, 0 runtime values, erased
by `verbatimModuleSyntax`; `mod.rs`-style re-export barrels by the same rule). Exempt by the
"no branching logic" test, not by a number.

**`AGENTS.md`'s claim verified: the 200-line threshold is still not codified anywhere.** All 642
tracked non-markdown files → **0** matches for `max[_-]?lines|file.?length.?limit`; no `rustfmt.toml`,
`clippy.toml`, or `.editorconfig`; CI runs `cargo clippy --all-targets -- -D warnings` with no pedantic
group. **So this is a first choice with no precedent to violate — which is exactly why 1,000 is safer
than 200: a 10-file threshold is far easier to walk back than a 111-file one.**

---

## Evidence

### Local measurements (all re-runnable at `4c06b1de`)

**Churn and fix density, top 15 production files.** `FIX/kLOC` = strict `^fix(` / `^fix:` / `^fix!`
commits per 1,000 production lines (61 such commits; a case-insensitive `^fix` gives 80 — the strict
form is used throughout). `churn/line` = Σ(added+removed) ÷ current lines.

| File | Prod lines | Commits | `fix:` | FIX/kLOC | churn/line |
|---|---|---|---|---|---|
| `storage/db.rs` | 4,146 | 41 | 3 | **0.72** | 2.9 |
| `agent/session/mod.rs` | 3,101 | 28 | 5 | 1.61 | 3.9 |
| `store/sessions.ts` | 2,841 | 55 | 10 | 3.52 | 1.6 |
| `lib/tauri/types.ts` | 1,551 | 18 | 4 | 2.58 | **1.1** |
| `commands/tasks.rs` | 1,303 | 7 | 1 | 0.77 | 1.2 |
| `archimedes-film/scene.ts` | 1,197 | **1** | **0** | **0.00** | **1.0** |
| `SpacesList.tsx` | 1,170 | 34 | 6 | 5.13 | 3.6 |
| `palettes/everforest.ts` | 1,062 | 1 | 0 | 0.00 | 1.0 |
| `agent/session/router.rs` | 1,054 | 17 | 3 | 2.85 | 2.6 |
| `agent/errors.rs` | 942 | 16 | 1 | 1.06 | 2.1 |
| `agent/session/naming.rs` | 846 | 13 | 3 | 3.55 | 4.4 |
| `chat/MessageList.tsx` | 877 | 11 | 4 | 4.56 | 1.9 |

**Correlations over 111 production files ≥200 lines:**

| Pair | Pearson | Reading |
|---|---|---|
| size ~ **absolute** churn | **0.820** | mechanically trivial — a bigger file must accumulate more edits |
| size ~ **relative** churn | **0.057** | the metric Nagappan found predictive — **here it is noise** |
| size ~ fix commits | 0.502 | weak |
| commit count ~ fix commits | **0.863** | **how often you touch a file dominates how big it is** |

**Fix density by size band:** 100–300 → 1.91 · 300–600 → 1.34 · 600–1000 → **2.61** · 1000+ → 1.79.
Not monotonic. Bottom tercile by size: 2.28 fix/kLOC. Top tercile: **1.99.** The smallest reacting file
(`agent/mod.rs`, 117 lines) runs at **8.55** — ~12× `db.rs`'s density. This is the *Theory of Relative
Defect Proneness* reproduced locally.

**Defect attribution in this repo's own record.** `docs/features/*known-gaps*.md`: 8 documents, **64
recorded gaps**; grep for causal language tying a defect to length (`too long|too large|hard to
navigate|lost in|because the file is`) → **0 hits, re-verified by the primary**. `docs/reviews/*.md`:
**87 findings** across five audits; 14 carry a `File Length + Structure` lens tag, but reading the
bodies shows every one is a **coupling, DRY, or multi-responsibility** defect whose *title* quotes a
line count. **0 of 64 and 0 of 87 attribute a defect to length.**

**And the repo's one real size problem was solved by an architectural boundary, not a split.** All six
god files the 10-04/10-19/10-30 audits named as High — `harness/loop.rs` (9,035), `provider.rs`
(4,599), `agent/session.rs` (4,357), `interactive.rs` (2,787), `worker/manager.rs` (1,987),
`tools/exec.rs` (4,633) — **are gone from the tree, and none was split for size.** They left in
`eb8ac18b` (the move into `fulcrum-core`).

**Cost audit — which of the four candidate costs is real:**

| Cost | Verdict |
|---|---|
| **Merge conflicts** | **Unfounded here — drop the argument.** 1 distinct committer (1,337 + 2 commits), **9 merge commits in 507**, `db.rs` in 1, `ChatStream.tsx` in 0. The prior audits' "#1 merge-conflict surface" claim is inherited from a many-developer model this repo does not have. |
| **Review size** | **Real, but it is a *commit* property.** Median commit 373 LOC, p90 4,577, p99 25,878; **244 of 507 commits (48%) exceed 400 LOC**; 65 exceed GitHub's 3,000-line diff cap. **But commit size does not track file size** — `db.rs`'s median diff is 134 lines and only 6 of 41 exceed 400. |
| **Navigation / tooling** | Small. No `rust-analyzer` config, no `.editorconfig`, no `rustfmt.toml`, and **0 region markers** in the four biggest files — a real cost that is fixable with comments and that **0 files have tried**. And because `archimedes` is one compilation unit, **splitting `db.rs` buys exactly zero incremental compile time.** |
| **Context / token cost** | **The one unambiguous cost, and no rule measures it.** `db/tests/mod.rs` ≈ **83k tokens**, `sessions.test.ts` ≈ 72k, `db.rs` ≈ 51k, `session/mod.rs` ≈ 40k. Three files cannot be read whole in a 200k context alongside anything else. Grows monotonically; unmitigable by discipline. |

**`AGENTS.md`'s own census has drifted within 9 days** (`db/tests/mod.rs` stated 131 → measured **136**;
`naming.rs` 77 → **73**; `session/tests/mod.rs` 73 → **75**; total tests 3,147 → **~3,705**), and its
live-violation list names 3 blocks where HEAD shows **11 blocks over 25**. There is **zero mechanical
enforcement** — nothing in CI counts tests per block. A rule nobody can re-measure decays this fast,
which matters directly: the first person to split these files will be reading a stale tripwire.

### Web sources, with credibility

| Source | Claim | Credibility |
|---|---|---|
| Hatton, *IEEE Software* 1997 — [leshatton.org/IEEE_Soft_97b.html](https://www.leshatton.org/IEEE_Soft_97b.html), [Ubend_IS697.pdf](https://www.leshatton.org/Documents/Ubend_IS697.pdf) | Fault density is U-shaped in size: logarithmic to **~200 lines**, then **approximately quadratic** | Peer-reviewed, high. **But Hatton calls his own mechanism "conjectures"** |
| Fenton & Ohlsson, *IEEE TSE* 26(8) 2000 | **No significant dependence** of fault density on size | Peer-reviewed, high. **Contradicts Hatton** |
| Koru et al., *EMSE* 2008 / *IEEE TSE* 2009 — [springer](https://link.springer.com/article/10.1007/s10664-008-9080-x) | Power law across 10 OSS products: **smaller modules are proportionally MORE defect-prone** | Peer-reviewed, high. **Contradicts both** |
| Withrow, *IEEE Software* 1990 | Density minimum in the 161–250 line band | Peer-reviewed, weak n (362 modules) |
| **Nagappan & Ball, ICSE 2005** — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/use-of-relative-code-churn-measures-to-predict-system-defect-density) | **Absolute** churn is a poor predictor; **relative** churn is highly predictive (89.0% accuracy, Windows Server 2003) | **The most load-bearing result for this question — and it argues against thresholding on absolute size** |
| SmartBear/Cisco — [smartbear.com](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review) | Review **200–400 LOC at a time**; beyond 400 the ability to find defects diminishes | Industry study, medium. **Its own source says this is a REVIEW BATCH size, not a file size** — it is routinely miscited |
| Google eng-practices — [small-cls.html](https://google.github.io/eng-practices/review/developer/small-cls.html) | "100 lines is usually reasonable, 1000 usually too large, **but it's up to the judgment of your reviewer**" | Official, high. **About CLs, and explicitly refuses to be a number** |
| ESLint `max-lines` — [docs](https://eslint.org/docs/latest/rules/max-lines) | Default **300**; docs say "recommendations usually range from 100 to 500" | Official. **Not in `eslint:recommended`; Airbnb sets it `off`** |
| Clippy — [issue #16674](https://github.com/rust-lang/rust-clippy/issues/16674) / [PR #16675](https://github.com/rust-lang/rust-clippy/pull/16675) | **No file-level lint exists.** `too_many_lines` is per-*function*, default 100, in `pedantic` (off by default). The file-level proposal defaults **1000** and lists "some files legitimately need to be long" as a drawback | Official |
| SwiftLint `file_length` — [docs](https://realm.github.io/SwiftLint/file_length.html) | **400 warn / 1000 error**, enabled by default | Official |
| vscode / angular / react / next.js / rust-lang/rust configs | **No file-length rule in any of them** | Verified by grepping each repo's config |

---

## Unresolved Contradictions

1. **The size–defect literature does not settle the number and will not.** Hatton's U-shape, Fenton's
   null, and Koru's inverse power law were obtained on different corpora and point in three
   directions. Hatton concedes his mechanism is unexplained. **The recommendation above therefore does
   NOT claim 1,000 is a *defect* threshold** — it claims 1,000 is the number the ecosystem enforces and
   the number the context cost makes urgent. That is a different and weaker claim, stated so
   deliberately.
2. **`errors.rs`: mechanically clean vs thrice-ruled-against — RESOLVED (2026-11-20).** Zero code
   coupling, zero consumer edits, zero source lints — and a `//!` header, a close-out doc, an audit, and
   ADR 0063 all saying don't. This report deferred to the recorded decision *"unless the 'one place owns
   the error English' guarantee is explicitly re-affirmed per-family"*. **That condition is now met.**
   ADR 0063's 2026-11-20 amendment answers it directly: every sentence in 0063 that places a variant's
   user-facing English is per-variant or per-enum (`:39` *"next to the variant — one place, one language,
   one owner"*; `:78`'s colon enumerating **one variant's** four edits), and the ADR states the opposite
   of a file rule twice — *"The error type is chosen by the wire, not by the file"* (`:94`) and *"never the
   module it is declared in"* (`:105`). The guarantee is that the variant, its `#[error(…)]` sentence, its
   `kind()` arm and its `From` arm stay **together**; it survives any layout that keeps them together, and
   the amendment names and forbids the one layout that would weaken it (a shared `wire.rs` holding all
   twelve `From` impls). The decline therefore stands, but on its actual grounds — coherence plus a cost
   case that measured empty on all four axes — not on a one-file rule, and the `//!` header clause this
   report quoted at `:317` has been re-worded to what its reason clause supports. The one real cost the
   shape does enable (three families with the majority of their `kind` spellings unpinned, a fourth at
   exactly half, and no test enumerating families at all)
   is a **gating** gap that a split makes strictly worse; it is closed by
   `src-tauri/tests/error_wire_gate.rs`. See `docs/research/agent-errors-rs-per-family-guarantee-and-the-reopen-argument.md`.
   The item stays numbered so the deferral it corrects remains readable.
3. **`session/mod.rs`'s rationale scatter.** A split forces the poison-recovery rationale to be
   restated per file. Arguably better than today's 2,136-line distance; also a prose obligation with a
   real chance of rotting. Not priced.
4. **The two rules' numbers are not independent.** A 1,000-line tripwire will flag files the subject
   rule is content with, and this report argues that is the *point*. But it means the tripwire will
   generate work the split rule will then decline — which needs to be a legitimate outcome, or the
   tripwire gets ignored the way the ratio trigger was.

---

## Gaps

- **No evidence exists on file size vs LLM/agent task success** — the one cost this report would
  actually bet on. The token counts are measured; the harm is labelled **speculation**.
- **A ratchet's counterfactual is untested.** `db.rs` grew 1,607 → 4,148 lines over 43 commits with 39
  new functions landing *inside* it by plan. Whether a recorded-size ratchet would have changed those
  commits individually requires a per-commit reviewability check that was not done.
- **Test-file *split* cost is unquantified.** This report scoped tests out as candidates. The one local
  precedent (`650bfe55`, splitting `SpacesList.test.tsx`) re-declared ~1,356 lines of module scope. If
  test files are split too, that is the bill, and it is the largest number this exercise did not price.
- **`rust-analyzer` behaviour at 4,000 lines is unverified.** Found only anecdote (a >100k-LoC bindgen
  file; crate-level rather than file-level slowness). 4,146 lines is well inside normal; do not
  represent this as a measured cost.
- **`AGENTS.md`'s live-violation census is stale and its full candidate set was not re-enumerated**
  for this report (11 blocks over 25 at HEAD vs 3 named). Only a read of each block's test titles
  decides whether it crosses subjects.
