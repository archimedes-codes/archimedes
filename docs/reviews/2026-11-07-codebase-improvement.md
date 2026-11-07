# Codebase Improvement Report — 2026-11-07

**Scope: both trees, weighted to what the T1–T8 engine extraction changed.** The prior audit
(2026-10-30) is 8 days old and **43 commits** have landed since. Three of them
(`eb8ac18b`, `820baf6b`, `a67800c9`) moved the engine — harness, tools, mcp, providers, worker —
out of this checkout into `fulcrum-core`, now a **rev-pinned git dependency**
(`src-tauri/Cargo.toml:47`, rev `78e5954`, one workspace member). That extraction is the single
biggest influence on this report: it did not change how big the desktop is so much as **what the
desktop's own gates can still see.**

## Summary

**17 findings across 8 lenses. 3 high, 10 medium, 4 low.**

The headline is not size — it is that **the extraction left the desktop full of spellings nothing
spells, and prose that asserts consumers who moved away.** Of the **245 named re-exports** in the
five post-extraction alias files, **139 (57%) are unreachable at every desktop spelling**: 88 are
aliases of names that survive one level deeper, 51 name things no desktop code names at all.
Worse than being unused, three of these files carry `//!` headers that are now **false** —
`agent/web.rs:37-38` says `worker/core.rs` implements `RenderRequester`; `worker/core.rs` has been
crate-owned since S8.2, and `RenderRequester` has zero desktop references. And
`tests/fulcrum_seams.rs:28-45`, the file whose whole method is "each pin names the deletion that
breaks it", tells a reader to delete `impl Dispatcher for WorkerManager`
(`worker/manager/mod.rs`), `impl Store for IpcStore` (`agent/worker/store.rs`) and a `pub use` in
`agent/worker/types.rs` — **all three files are absent here**, so three falsification proofs are
no longer performable and would now reddened nothing.

The second theme is **unguarded spellings that cross into the crate.** The repo pins every string
vocabulary it *owns* — `events.test.ts` freezes event names byte-for-byte, `errors.rs` has a
`*_spellings_are_frozen` test per error family, `toolDetailsRegistry.test.ts` pins 35 keys with a
compile-time tuple assert. The four vocabularies that cross into `fulcrum-core` have **no pin at
all**, and the worst (`option_id`) gates two *persistent* side effects off a bare string compare
with the tests hard-coding the same literal as the production code.

The third is the operator's actual question — **the monster files.** Honest answer: the two biggest
are **tests**, and only two production files exceed 1,000 code lines. One `describe` block in
`ChatStream.test.tsx` holds **3,483 lines and ~157 tests** across at least eight unrelated subjects;
`agent/session/mod.rs` carries **2,952 inline test lines** with no sibling split. The `tests/` dir
convention exists in **2 of 28** `#[cfg(test)]` sites, was never written down, and the last split
**moved the pile rather than dissolving it** — `ChatStream.test.tsx` went 5,583 → 2,905 while
`ChatStreamDirectoryCompletion.test.tsx` arrived at 1,243.

Measured baseline at `73abf9a4` (HEAD; `521e8484` is its pre-squash twin — `git diff --stat` between
them is empty, so both are valid anchors):

| | files | code lines | >200 lines |
|---|---|---|---|
| Rust production (inline `#[cfg(test)]` subtracted) | 46 | **7,791** | 12 |
| Rust inline test code | — | 11,270 | 10 |
| Rust test files (`tests/**`) | 44 | 19,704 | 29 |
| Frontend production | 227 | **24,514** | 38 |
| Frontend tests | 169 | 54,328 | 72 |

**Production is 19% of files and 63% of production lines sit in files over 200 lines.** Test:prod is
**2.5×** (Rust) and **2.2×** (frontend).

## Context

- **CONTEXT.md**: loaded (337 lines, 88 glossary entries, 76 `_Avoid_` lists). **No `## Engineering
  Rules` section** — and note this: **the 200-line threshold is not codified anywhere in this repo.**
  `AGENTS.md`, `CONTEXT.md`, `Makefile` and the docs hold no file-length rule; the only hits for
  "200" are an HTTP status, a 200 ms read timeout and prose. Every `>200` figure above is measured
  against an **audit convention, not a repo rule** — which matters for a report about size.
- **ADRs**: 82 in `docs/decisions/` (this repo uses `docs/decisions/`, not `docs/adr/`). Most cited
  here: **0091** (the boundary-seam decision), **0086** (glossary conformance — see finding 12),
  0063 (IPC error envelope), 0025 (worker processes, sole SQLite writer), 0072 (unconsumed palette
  tokens), 0075 (list position is not evidence), 0045 (overflow recovered in-turn).
- **Plans**: 18 docs in `docs/roadmap/` (2 tracked, 16 ignored — `fulcrum-harness-status.md` alone is
  250 KB).
- **Prior audits treated as closed unless re-caused**: 2026-10-30 (20 findings, all approved),
  2026-10-22 (18), 2026-10-19, 2026-10-04.
- **Explicit non-goals honoured** (not re-reported): the five D5 renames (`ChatStream`, `Reasoning`,
  `MessageBubble`, `TodoBoardPanel`, bare `rail`) — ADR 0086 names them with §6's measured costs;
  the `store/sessions.ts` split as a size target; `ui/badge.tsx`; `whole_tool`'s mixed casing; the
  `Subagent*` component names blessed by CONTEXT.md's **Agents** entry; ADR 0072's unconsumed tokens;
  building a glossary copy-guard (ADR 0086 explicitly declines to authorise one).

## Verification note — read this before quoting any number below

**Seven scan claims did not survive verification, and one of them was mine.** The corrections are
load-bearing, so they are in the body:

| Claim | Reality at HEAD | Effect |
|---|---|---|
| "`pasted_token_and_cli_sso_refresh_are_noops` is cited by `refresh.rs:117` but **does not exist**" | It exists at **`src-tauri/tests/provider_oauth_flow.rs:1202`** | Finding 1 loses `oauth.flow` — that vocabulary **is** pinned. A `grep` scoped to `src-tauri/src` cannot see an integration target; the doc-comment was right |
| "`Settings.subagentDeadBoundSecs` is missing from `AppSettings`, so a Settings save **silently resets it to 1800**" | **Refuted.** `useSettingsDocument.ts:96` and `useAgentOverridesWrites.ts:173` both spread a runtime object (`{...settings, ...changes}`), and TS types strip at compile time — an undeclared field **survives the round trip**. No data loss today | Finding 8 keeps the drift, loses the alarm. The real gap is the missing boundary pin, not a live corruption |
| "`sessions.ts` teardown clears `inTurn` but not `stalled` → stuck spinner or lost crash evidence" | **Refuted.** `handleSessionClosed` (`:2394`,`:2397`) clears `inTurn: false` and `stalled: undefined` **in the same `set`**, deliberately, pinned by `sessions.test.ts:1788-1802`. The frontend does not need the Rust "stalled survives teardown" rule — it is a rendered mirror, not the crash-attribution store | The god-object finding is **downgraded High → Medium** and its proposal changed from an aggregate to a write-set contract |
| "`MessageRow.kind`'s `(string & {})` + `default: return []` is a data-loss bug" | **Deliberate forward-compat**, same philosophy as `events.ts` and `AgentToolKey`: an unknown kind from a newer crate is ignored, not fatal | Not filed as a bug. Filed instead as finding 1's missing-pin asymmetry |
| Prior audit: "16 of 47 commands flatten to `String`" | **0 of 52.** 48 typed-error commands + 4 infallible | Finding 20 closed. But **the promised grep guard was never built** — `scripts/check-commands.sh` is a consumer census, not an error-type guard |
| Prior audit: dead commands `list_agent_definitions` + `get_stalled_info` | `list_agent_definitions` **does not exist** (dropped, recorded at `docs/features/improvement-correctness-seams-closeout.md:516`). `get_stalled_info` is **retained with a written decision** + an allowlist entry | The command surface is 52 registered / 51 TS callers / 1 deliberate exception. Clean |
| Prior audit task E2: split `launch.rs` and `sandbox.rs` | **Both files are gone** — crate-owned since `eb8ac18b`. 1 of 3 targets was already done, 2 cannot be executed here | Finding 4 re-grounded against the current tree |

**My own instrument was wrong three times before it was right, and this is the trap the report is
about.** Counting the dead aliases: instrument 1 (regex on root-spelling only) reported **171 dead**;
instrument 2 (adding bare-word scanning) reported **245 total with 171 dead**; both were wrong
because they missed **brace-form imports** — `use crate::agent::{SessionError, SettingsError}` — so
they called `SettingsError` dead while it was live at `commands/settings.rs:15`. Instrument 3 added
brace expansion **and** path-prefix scanning (`worker::manager::WorkerManager` makes `manager` live)
and additionally caught a **second alias layer** at `lib.rs:11,17` (`pub use agent::agents;`). Final
number: **245 named aliases, 67 live, 39 test-only, 139 dead.** A fourth pass was needed to stop it
counting private `use` lines as re-exports (it briefly reported a dead alias named `Arc`).
**Four instruments, four answers.** Anyone re-running this census should start from
`/tmp/census4.py`'s shape, not from a grep.

---

## Findings

### 🔴 High Severity

#### 1. `option_id` gates two persistent side effects off a bare string compare, with the tests hard-coding the same literal

- **Lens:** Weak Abstractions
- **Files:** `src-tauri/src/agent/session/mod.rs:2586`, `:2598`
- **Severity:** High
- **Confidence:** High

**Problem.** Two behaviours the user depends on are keyed off raw string literals:

```rust
// session/mod.rs:2586
if option_id == "trust-space" { … db.set_space_trusted(&cwd.display().to_string(), true); }
// session/mod.rs:2598
if option_id == "allow-directory" { self.persist_allow_directory_rule(value.as_deref()); }
```

`PermissionOutcome` is crate-owned (`agent/mod.rs:107` re-exports `permission` from
`fulcrum_core`), so the desktop cannot constrain `option_id: String`. There is **no constant for
either spelling anywhere in the desktop** — the full non-comment census is the two compares above
plus two test fixtures at `:6408`/`:6449` that hard-code the **same** literals, so a rename updates
production and test together and the suite stays green. TS widens it to `string`
(`src/lib/tauri/types.ts:170`) and `PermissionPrompt.tsx:66-72` forwards whatever the gate emitted —
its own test at `:106` *celebrates* that `"trust-space"` is absent from the fixture, so it cannot
catch drift either.

The failure mode is **silent success**: `respond_permission` still returns `Ok(true)`, the modal
closes, the tool runs — and "Always allow this directory" quietly stops persisting the rule. Every
later access re-prompts. This is the exact shape the prior audit attributed to `compaction_reason`;
that one has since been fixed into a TS union with a `never` exhaustiveness arm
(`toolOutput.ts:119-128`), and this one has taken its place.

**The asymmetry is the finding.** The repo pins every vocabulary it owns:

| vocabulary | pinned? | evidence |
|---|---|---|
| event names | ✅ | `events.test.ts:63-76`, byte-for-byte + a negative assert |
| `details` keys | ✅ | `toolDetailsRegistry.test.ts:636` (`toBe(35)`) + `:185` compile-time tuple |
| error `kind`s | ✅ | `errors.rs:1018`, `:1136`, `:1214`, `:1352` |
| `budget.level` | ✅ | `settings.rs:766`, `:773` assert the serialized wire values |
| `CompactionReason` | ✅ | TS `never` arm, `toolOutput.ts:126` |
| **`option_id`** | ❌ | literals on both sides, no pin |
| **`ClosedReason`** | ❌ | finding 9 |

**Proposal (Confidence High).** Two increments, no crate change:
1. **Desktop-side frozen-spelling pins**, mirroring the `*_error_kind_spellings_are_frozen`
   precedent — assert that the desktop's two literals are the exact strings, so a *desktop* typo
   fails CI. This is what the repo already does for its own vocabularies and it is the only thing a
   single-language policy permits.
2. **Named constants** (`const TRUST_SPACE: &str = "trust-space"`) so the emitter-side fixture and
   the compare share one source, and a `match` instead of two `if`s so a third option id is a
   visible omission rather than a fall-through.

**Reviewer dissent, recorded:** the realistic trigger is a desktop typo rather than a crate rename,
and the consequence is a fail-closed availability regression (re-prompting), not a security or
data-loss bug — which argues Medium. Filed High because the failure is silent, the side effect is
persistent, and the guard is not weak but absent.

**Non-goal:** do not add a cross-package parity test. `src/lib/ipc/events.ts:20-31` refuses
grep-parity as unsound, and this repo's policy is single-language pins.

#### 2. The extraction left 139 unreachable aliases in five files, and three of those files' module docs now assert consumers that moved into the crate

- **Lens:** Dead Code (+ Coupling)
- **Files:** `src-tauri/src/agent/mod.rs`, `agent/worker/mod.rs`, `agent/harness/mod.rs`, `agent/web.rs`, `agent/provider_auth/mod.rs`, `tests/fulcrum_seams.rs`
- **Severity:** High
- **Confidence:** High (census re-run four times; see the verification note)

**Problem.** The alias files are load-bearing and deliberate — ADR 0091's mechanism for keeping
`SessionManager` and friends compiling across the move — but the alias **blocks** were never
pruned. Measured per file (named `pub use` targets only, module aliases included):

| file | named | LIVE | TEST-ONLY | DEAD-alias | DEAD entirely |
|---|---|---|---|---|---|
| `agent/mod.rs` | 81 | 33 | 7 | 23 | 16 |
| `agent/worker/mod.rs` | 38 | 3 | 4 | 19 | 12 |
| `agent/harness/mod.rs` | 61 | 17 | 23 | 12 | 9 |
| `agent/web.rs` | 8 | 3 | 0 | 2 | 3 |
| `agent/provider_auth/mod.rs` | 57 | 11 | 5 | 32 | 11 |
| **Total** | **245** | **67** | **39** | **88** | **51** |

`agent/worker/mod.rs` is the clearest case: its own doc says it *"declares NO modules and DEFINES
NOTHING at all"*, and of its 38 named aliases **only `client`, `manager`, `protocol` are spelled at
that root** — everything else (`WorkerManager`, `WorkerCore`, `StartEnv`, `encode_inbound`, …) is
reached through the deeper path. The dead-entirely set includes four aliases that are **renames** —
`pub use key_helper::run as run_key_helper`, `litellm_oauth::{login as litellm_oauth_login}`,
`gcloud::{token as gcloud_token}` — which are the misleading ones: a reader greps the alias, finds
the declaration, and concludes the name is in use.

**Three doc-comments now assert consumers that are not in this repo.** These cost more than the
dead code, because they are how a contributor decides what is safe to change:

- `agent/web.rs:37-38` — *"`worker/core.rs` implements the crate's `crate::agent::web::
  RenderRequester`."* `worker/core.rs` is crate-owned since S8.2 (`worker/mod.rs:23` says so);
  `RenderRequester`/`RenderedPage` have **zero** desktop references.
- `agent/mod.rs:31`, `:46` — cite `crate::agent::fs_backend::canonicalize_lenient(..)` and
  `crate::agent::codemode::engine::CODEMODE_MEMORY_LIMIT` as the reason those aliases exist. Neither
  spelling exists in this checkout; both name crate-internal paths.
- `tests/fulcrum_seams.rs:28-45` — the file's stated method is *"each pin names the deletion that
  breaks it"*, then instructs: delete `impl Dispatcher for WorkerManager`
  (`worker/manager/mod.rs`), delete `impl Store for IpcStore` (`agent/worker/store.rs`), delete a
  `pub use` in `agent/worker/types.rs`. **All three files are absent here** (verified with `ls`), so
  those three proofs now reddened nothing — the non-vacuity of three pins is unverifiable from this
  tree. (`agent/harness/store.rs:~840` carries the same stale instruction for `IpcStore`.)

**Coupling measure.** 29 of 34 integration targets reach the crate **only** through a desktop shim;
5 spell `fulcrum_core::` directly. That is the design intent ("every one of them compiles with ZERO
edits") and it is also why a crate-side rename is invisible to 85% of the suite.

**Proposal (Confidence High).** Three separate commits, cheapest first:
1. **Fix the three false doc-comments** — prose only, zero risk, and it is the part that misleads.
   Each should say which crate file now holds the thing.
2. **Repair `fulcrum_seams.rs`'s falsification instructions** to name only files that exist here,
   and mark the crate-side proofs as *"performed in `archimedes-codes/fulcrum`'s CI"* — otherwise the
   file claims a verification method it can no longer deliver.
3. **Prune the 51 dead-entirely aliases** (nothing at any spelling references them), leaving the
   88 dead-aliases alone for now — those are one level deeper and are the "keep the old spelling
   working" set ADR 0091 intends. Do this **before** the next crate rev bump, when the diff is still
   attributable.

**Non-goals:** do not delete the shim files themselves (38 files depend on them); do not prune the
test-only aliases (they are the integration suite's import surface); do not attempt the 88
dead-aliases in the same commit as the 51.

#### 3. One `describe` block holds 3,483 lines and ~157 tests, and the last split moved the pile instead of dissolving it

- **Lens:** File Length + Structure
- **Files:** `src/components/ChatStream.test.tsx:224`, `src/components/SpacesList.test.tsx:443`, `src/store/sessions.test.ts`
- **Severity:** High
- **Confidence:** High

**Problem.** This is the honest answer to "there are some fuckin monster files": the largest file in
the repo is a **test** file, and the worst structural offender is a **single block inside one**.

`ChatStream.test.tsx` — 4,156 raw lines, 162 `it`s. Four of its five `describe`s are small and
subject-named (`:3707`, `:3877`, `:3963`, `:4091`). The fifth, `describe("ChatStream")` at `:224`,
runs to `:3706` — **3,483 lines, ~157 tests** — covering at least eight unrelated subjects, readable
straight off the test names: working indicator and quip truncation · compaction row and Esc-during-
compaction · composer island styling · resume-stored-session semantics (~15) · attachment staging and
send-race safety (~12, including *"send is aborted if the session switches during the read"*) ·
Esc/cancel routing (~5) · **mention pickers `$`/`@`/`#`/`?` (~45 — the single biggest cluster)** ·
directory completion. `SpacesList.test.tsx:443` is the same shape: a 1,310-line block holding ~68
tests against a component with 28 store subscriptions.

**The split was started and abandoned, and that is measurable.** `ChatStream.test.tsx` went **5,583 →
2,905** code lines (`dd7ed4fb`, the chatstream-decomposition program) with **7 new test files**
created since 2026-10-29 — but the big `describe` survived intact, and one of the extractions,
`ChatStreamDirectoryCompletion.test.tsx`, arrived at **1,243 lines**. Splitting a file without
splitting the block just relocates the problem.

**Proposal (Confidence High).** Split `describe("ChatStream")` along the subject boundaries the test
names already state — mention pickers (~45 tests) first, they are the largest and most separable.
**Deliverable is the block boundary, not the file count**: a rule that no single `describe` exceeds
~25 tests, because file-size rules demonstrably do not catch this (see finding 4).

**Non-goal:** do not touch `src/lib/archimedes-film/scene.ts` (729 lines). It is a verbatim-number
port of an art file, has **zero** growth in the 43-commit window, and its sibling test is *smaller*
than it (295 lines) — the only monster in the tree whose tests are smaller than its production.
Splitting it destroys the auditability that makes it safe.

### 🟡 Medium Severity

#### 4. `agent/session/mod.rs` carries 2,952 inline test lines; the `tests/` split exists in 2 of 28 sites and was never written down

- **Lens:** File Length + Structure
- **Files:** `src-tauri/src/agent/session/mod.rs`, `agent/session/naming.rs`, `config.rs`, `commands/agents.rs`
- **Severity:** Medium
- **Confidence:** High

**Problem.** `agent/session/mod.rs` is 6,838 raw lines: **1,524 production + 2,952 inline test**
(`#[cfg(test)] mod session_tests` at `:2932-6838`, 71 tests). `naming.rs` is 590/1,591 (77 tests),
`config.rs` 259/1,030 (47), `commands/agents.rs` 140/915. **None has a sibling `tests/` dir.** The
pattern exists twice in the whole crate — `storage/db.rs:1607` and `commands/files/mod.rs:21` — and
`db/tests/mod.rs` was **added in-window** by `47432a38` (an audit-remediation commit) with no
rationale comment. `AGENTS.md` and `CONTEXT.md` contain **no rule** (verified: no hit for
`cfg(test)` / `mod tests` / "test module").

So a `cargo test` failure in the repo's biggest file lands in a 3,900-line tail, and the newest
precedent in the tree is a minority shape nobody documented.

**The prior audit's proposed trigger is the wrong one.** "Split when the test body exceeds the
production body" fires on 15 of 16 candidates — including `errors.rs`, `settings.rs`, `router.rs` and
`refresh.rs`, where splitting removes no pain because their tests are already coherent and their
production bodies are the small part. **The defensible trigger is subject count, not line ratio**:
one `#[cfg(test)]` region holding >25 unrelated tests, or one `describe` holding >25. That is also
the rule that catches finding 3, which no size rule catches at all.

**Proposal (Confidence High).** (a) Write the rule into `AGENTS.md` naming the subject-count trigger
and the `tests/` dir (not `tests.rs` — zero sites use it) as the shape. (b) Then apply it to
`agent/session/mod.rs` only, where the precedent (`db.rs`) and the pain are both highest. The move
is intra-crate and needs three things an implementer must not skip:
1. `naming.rs:926` imports `TestSink` from the `session_tests` module — **one import edit**, verify
   it after the move.
2. Test **names must be preserved**: `cargo test --lib -- --list` before and after, diffed on
   **full paths** — AGENTS.md records that leaf-unique and full-path-unique differ, and a moved test
   that silently disappears leaves the leaf alive. Enumerate with `--list`; **do not grep for
   `#[test]`** (AGENTS.md: a loose grep over-counted by 1 on a measured file).
3. `cargo build --all-targets` first — AGENTS.md: `cargo test --lib` does not rebuild `fake_worker`,
   and 10 integration targets spawn it.

**Non-goal:** do not split `config.rs`, `crashlog.rs` or `commands/agents.rs` on the ratio trigger;
do not re-split `db/tests/mod.rs` (flat, 58 homogeneous sibling tests, already moved).

#### 5. Two subsystems give opposite answers to "is a poisoned mutex recoverable", and only one of them wrote down why

- **Lens:** Inconsistent Patterns
- **Files:** `src-tauri/src/storage/db.rs` (28 sites) vs `agent/session/*` (37 sites)
- **Severity:** Medium
- **Confidence:** Medium

**Problem.** `agent/session/mod.rs:729-736` states its rule: *"a panic while holding a registry lock
must not wedge every later session read"* — and 37 production sites recover with
`unwrap_or_else(|p| p.into_inner())`. `storage/db.rs` panics instead, 28 times in production
(`+39` more in its test module), with `.expect("db mutex poisoned")` — a message that asserts rather
than argues, and **no rationale anywhere in the file**. `AGENTS.md` has **no lock/poison rule at all**
(verified: 0 hits for `poison` / `into_inner` / `Mutex`).

Both positions are probably right, which is exactly why it needs writing: the session registry holds
independent per-session state, so a panic under one lock should not poison every other session;
`Db` holds one `Connection`, and a panic mid-transaction may leave it genuinely unusable. But that
second justification exists only in this report — nothing in the repo says it, so a new file picks
whichever neighbour it happened to open, and the reviewer's judgement is that `db.rs` is currently
"undocumented drift from intent."

**Proposal (Confidence High).** One paragraph in `AGENTS.md` under Conventions stating both rules and
the discriminator (independent-per-key state → recover; single shared resource → panic), plus a
`//` rationale at the top of `db.rs`'s lock helper. **RULE, not refactor** — changing either
subsystem's behaviour is not justified by this finding.

#### 6. `agent/errors.rs` describes itself as holding 2 of its 10 types, and offers two incompatible shapes for a new error family

- **Lens:** File Length + Structure (+ Inconsistent Patterns)
- **Files:** `src-tauri/src/agent/errors.rs`
- **Severity:** Medium
- **Confidence:** High

**Problem.** 1,494 lines, **10** IPC error enums for 10 unrelated domains (`SessionError:25`,
`HistoryError:138`, `AttentionError:219`, `ClipboardError:278`, `OpenError:336`, `UpdateError:420`,
`FilesError:487`, `SettingsError:523`, `SpacesError:607`, `McpError:650`, `AgentsError:687`), 10
hand-written `impl From<_> for InvokeError`, and a shared `InvokeErrorExt` trait. Its `//!` header
reads: *"Errors for the session and files layers: `SessionError` and `FilesError`."* — naming 2 of 10,
untouched since before the 43-commit window. A contributor placing a new error type reads that header
and looks elsewhere; the only other precedent is `DbError`, which lives with its own layer
(`storage/db.rs:48`). So there are two placement rules and the file states the wrong one.

The **shape** split is the more concrete half: 9 families expose `pub fn kind(&self)`, but
**`FilesError` has no `kind()` at all** (it inlines the match in its `From` impl at `:496-499`), and
**`SessionError::kind` is private** (`:68`, `fn kind`) while every sibling is `pub`. ADR 0063's rule
is "the error type is chosen by the wire, not by the file" — three shapes to copy for one wire.

**Proposal (Confidence High).** Minimum fix, two lines of prose and one signature: correct the `//!`
header to name the file's actual rule (all IPC error families live here; `DbError`/`FsError` stay
with their layers because they are not IPC types), and make `SessionError::kind` `pub` so the
`kind()` shape is uniform. **Do not split the file** — the families are coherent, share
`InvokeErrorExt`, and splitting buys an `errors/` directory and nothing else.

#### 7. `src/lib/errors.ts` is a 164-line orphan whose header claims importers that do not exist — so the frozen error kinds have no TS-side mirror

- **Lens:** Dead Code
- **Files:** `src/lib/errors.ts`
- **Severity:** Medium
- **Confidence:** High

**Problem.** All ten of its exported unions (`IpcErrorEnvelope`, `HistoryErrorKind`,
`AttentionErrorKind`, `ClipboardErrorKind`, `OpenErrorKind`, `UpdateErrorKind`, `SessionErrorKind`,
`FilesErrorKind`, `SettingsErrorKind`, `McpTestErrorKind`) have **zero importers**. Every apparent
reference is a doc comment naming the file (`external.ts:36`, `update.ts:22`, `catalogs.ts:65`,
`settings.ts:67`, `McpSection.test.tsx:151`) — the exact false-positive class this repo's AGENTS.md
warns about. Its own header claims the unions are *"DIRECT-imported (the `ipcError.ts` precedent)"*;
`ipcError.ts:20` says of itself *"Zero imports on purpose"*, so the precedent it cites is a
deliberately standalone module, not an imported one.

The consequence is not the dead lines — it is that **`errors.rs` freezes 10 wire vocabularies in
Rust and nothing on the TS side is bound to any of them.** A renderer that branches on `kind` gets no
type checking, and the mirror can drift silently in the one direction the Rust pins cannot see.

**Proposal (Confidence High).** Decide and record which of two things this file is, then act:
either **import it** where `kind` is actually branched on (making the mirror real and the drift a
type error), or **delete it** and note in `errors.rs` that the TS side has no vocabulary mirror by
decision. Either is fine; a file that claims consumers it lacks is the worst of the three options
because it reads like coverage.

#### 8. Four of the six ADR-0091 config DTOs have no cross-boundary identity pin, and `Settings`/`AppSettings` are already two fields apart

- **Lens:** DRY Violations (+ Coupling)
- **Files:** `src-tauri/src/config.rs:67-69`, `src/lib/tauri/types.ts`, `src-tauri/tests/fulcrum_seams.rs`
- **Severity:** Medium
- **Confidence:** High

**Problem.** ADR 0091: *"`Settings` and `FontSettings` moved into the crate as plain DTOs … **The
type lives in both places; the file lives in one.**"* On the Rust side that is safe — `config.rs:67-69`
**re-exports** rather than mirrors (verified: 0 local `struct Settings`), so the two spellings cannot
diverge. The real second copy is TypeScript, and it has drifted:

```
Rust Settings: 24 fields   AppSettings: 22 fields
IN RUST, NOT IN TS:  subagentDeadBoundSecs   subagentModels
```

`subagentModels` is correct to omit (`#[serde(default, skip_serializing)]` — never reaches the wire).
`subagentDeadBoundSecs` is `#[serde(default = "default_subagent_dead_bound_secs")]` → **always
serialized**, so `get_settings()` really returns it and `AppSettings` really does not declare it;
`grep -rn subagentDeadBoundSecs src/` → 0 hits, and `src/test/fixtures/settings.ts` omits it too.

**I checked and refuted the alarming version of this.** It does **not** silently reset the value on
save: both writers spread a runtime object (`useSettingsDocument.ts:96`,
`useAgentOverridesWrites.ts:173`) and TS types strip at compile time, so an undeclared field survives
the round trip. The exposure is narrower and real: a field the renderer cannot see is a field nobody
can render, and the guard that was supposed to catch it does not cover it. `src/test/fixtures/settings.ts:66-70`
types `DEFAULT_SETTINGS: AppSettings` so a field added to the **TS** type fails compilation — it is
blind to a field added only in Rust. And `fulcrum_seams.rs::the_config_dtos_are_one_type_across_the_boundary`
pins type identity for **`ProviderConfig` and `AgentOverrideFields` only** (verified by counting the
identifiers in its body: 5 and 3, and **0** for `Settings`, `FontSettings`, `OidcConfig`,
`WebSettings`).

**Proposal (Confidence High).** Add the four unpinned DTOs to the existing identity pin — same shape,
same file, minutes of work, and it is the guard that would have caught this class of drift. Then add
`subagentDeadBoundSecs` to `AppSettings` (or mark it deliberately renderer-invisible in one comment,
which is what its crate-side doc already implies: *"no Settings-UI control, deliberately"*).

#### 9. `ClosedReason` is the one wire vocabulary in the desktop with a hand-rolled spelling and no frozen-spelling pin

- **Lens:** Weak Abstractions
- **Files:** `src-tauri/src/agent/session/mod.rs:66-85`, `src/lib/tauri/types.ts:134`
- **Severity:** Medium
- **Confidence:** High

**Problem.** `ClosedReason` carries **both** `#[serde(rename_all = "snake_case")]` (`:67`) **and** a
hand-written `as_str()` (`:81-83`). Only `as_str()` reaches the wire — `router.rs:441` emits
`reason.as_str()` — so the live spelling `"agent-exited"` exists solely as a match arm, while the
serde attribute 8 lines above would independently produce `"agent_exited"`. TS mirrors it as a
hand-written union. Nothing pins the set: `grep` for `ClosedReason` finds zero assert sites, whereas
`errors.rs:1018`/`:1136`/`:1214`/`:1352` do exactly this for every error family, and
`history_error_kind_spellings_are_frozen`'s own doc states the purpose — *"a spelling drift, or a
fourth variant nobody told the frontend about, fails HERE before CI sees it."*

Change `"agent-exited"` to `"agent_exited"` — which is what the serde attribute sitting above it
argues for — and both sides still typecheck, because `CloseReasonStr` is only ever compared for
identity and never exhaustively switched. The value flows to `SpaceView.lastReason`
(`sessions.ts:299`) and the paused-banner copy, which silently stops distinguishing a user close from
a self-exit. **The event *name* is frozen byte-for-byte (`events.test.ts:63,76`); its payload is not.**

Note this is a **desktop-local** gap, not a crate-boundary one — producer, term and emission are all
here, which is what makes the missing pin indefensible rather than structural.

**Proposal (Confidence High).** A `closed_reason_spellings_are_frozen` test in the existing shape,
asserting the three `as_str()` values against a literal vector. Then decide whether the dead-looking
serde derive should stay; if it stays, say why in one line, because two encodings of one enum with
only one live is the trap.

#### 10. `src/lib/sessionLifecycle.ts` orchestrates four stores from `lib/` — 13 `lib → store` edges, none of them guarded

- **Lens:** Coupling Issues
- **Files:** `src/lib/sessionLifecycle.ts:1-5`, `src/lib/settings.ts:3`, `src/lib/chatSessionDerivations.ts:1`, `src/lib/sessionCost.ts:1`, `src/lib/linkify.tsx:2`
- **Severity:** Medium
- **Confidence:** High

**Problem.** 13 `lib → store` import edges (5 in production) and one `lib → components` edge
(`linkify.tsx:2` renders `OpenAnchor`). The direction that *does* hold is the important one —
`src/store/` → `src/components/` is **0** edges — so the layering is inverted in one place only.
Nothing guards it: the two frontend scanners cover the IPC barrel's incoming edges
(`tauriBarrel.test.ts`) and the Tauri-wire bypass (`tauriBoundary.test.ts`), not layering.

`sessionLifecycle.ts` is the real issue and it is a **placement** bug, not a coupling violation: a
module that imports `useSessions`, `useInteractive`, `usePermissions` and `useQueuedPrompts` to drive
them is a store-layer module misfiled under `lib/`. Type-only imports
(`chatSessionDerivations.ts:1`, `sessionCost.ts:1`) are a different severity — they create no runtime
edge and no cycle risk — and should be carved out explicitly rather than lumped in.

**Proposal (Confidence High).** Move `sessionLifecycle.ts` and `settings.ts` (runtime store
importers) to `src/store/`, and **GUARD** the result with the census shape the repo already uses
three times (`tauriBoundary.test.ts:198` floors the offender *predicate*, not just the walk — copy
that, not the naive version). Allowlist type-only `lib → store` imports and `linkify.tsx` by name with
a reason, following `tauriBoundary.test.ts:156-166`'s pinned-allowlist precedent.

#### 11. `subagentSheetLayout.test.ts` reads a `docs/` file and has no vacuity floor — the one source-text scanner that can go green having read nothing

- **Lens:** Missing Tests / Testability
- **Files:** `src/lib/subagentSheetLayout.test.ts:75`
- **Severity:** Medium
- **Confidence:** High

**Problem.** It `readFileSync`s `docs/features/subagent-sessions.md`. Of the 17 frontend source-text
scanners I enumerated, this is **the only one whose path crosses into `docs/`** — and AGENTS.md
records that `docs/` content moves, that `docs/roadmap/` is deleted on ship, and that a green suite
proves nothing about a docs deletion because **no test reads that directory** (except this one). It
also has **no count floor**: I grepped for `toHaveLength` / `length >` / `toBeGreaterThan` and found
none. Every other scanner in the tree has a floor or fails by exception; three (`subagentSheetLayout`,
`chatStreamFixtures`, `slabFloatSeparation`) fail by exception only, so the failure message names a
missing file rather than naming the vacuity.

**Proposal (Confidence High).** Add the floor the other scanners use — assert the doc's length or
that it contains the specific anchor the test cross-checks, so a truncated or emptied doc reads as
"the sweep found almost nothing to read" (`themeTokens.test.ts`'s wording) rather than as a pass.
**Do not delete the cross-check** — it is the only doc↔code coupling in the frontend suite and that
is a feature.

#### 12. ADR 0086's own number-collision check is false in its own text, and it is the ADR that exists because that bug killed a rename batch

- **Lens:** Inconsistent Patterns (governance)
- **Files:** `docs/decisions/0086-glossary-names-govern-new-code-and-are-repaired-on-touch-not-by-sweep.md:13-15`
- **Severity:** Medium
- **Confidence:** High

**Problem.** The ADR has a section headed *"The number 0086 — checked, not assumed"* asserting that
its probe *"printed **nothing** (exit status non-zero, no output line)"* and that the highest existing
number was 0085. Re-running that exact probe at HEAD prints **two** files:

```
$ git log --all --diff-filter=A --name-only --format="" -- docs/decisions/ | grep -E "0086" | sort -u
docs/decisions/0086-glossary-names-govern-new-code-and-are-repaired-on-touch-not-by-sweep.md
docs/decisions/0086-two-stage-async-session-titling-with-wire-isolation.md
$ ls docs/decisions/ | grep -oE '^[0-9]{4}' | sort | uniq -d
0086
```

`0086-two-stage-async-session-titling…` was added by `4998a98f` — one commit **before** `47432a38`
added this ADR, same day. So the self-check was wrong when it was written. The ADR's central argument
is that this is load-bearing, not cosmetic: it records that a rename batch died because *"backed by
ADR 0066"* was a duplicated number and *"neither of the two files holding it named any of those
symbols."* **The ADR written to stop that happened to itself**, and its `superseded-by:` field is
empty, so a reviewer citing "ADR 0086" against a name is citing an ambiguous authority — the precise
failure mode that killed D5. `AGENTS.md:610-612` already records the collision as measured; the ADR's
text still asserts the opposite.

**Proposal (Confidence High).** Correct the section rather than delete it — the wrong probe is the
useful artefact. Replace the "printed nothing" claim with the actual output, state which file holds
which decision, and either renumber the naming ADR (it is the newer of the two) or add an explicit
"0086 is shared with `0086-two-stage-async-session-titling`; cite by slug" line at the top. AGENTS.md's
own rule applies: **the check that matters is `uniq -d` run AFTER you pick, not before.**

#### 13. `deleteSession` clears 2 of the 11 session-keyed maps; `handleSessionClosed` clears 5 — and nothing enumerates the 11

- **Lens:** Weak Abstractions
- **Files:** `src/store/sessions.ts:1793` (`deleteSession`), `:2309` (`handleSessionClosed`)
- **Severity:** Medium
- **Confidence:** High

**Problem, and how it survived being downgraded.** This finding arrived as
*"`sessions.ts` is a god-object: 11 parallel `Record<string, …>` fields keyed by session id
(`closeReasons:478`, `sessionRecency:489`, `sessionOrder:501`, `messages:505`, `configOptions:507`,
`contextUsage:515`, `compacting:530`, `history:532`, `inTurn:545`, `stopReasons:547`, `stalled:556`)
where the Rust side has one `SessionState` aggregate."* Two claims in that framing were refuted and one
survived:

- **Refuted:** the cross-language invariant. `handleSessionClosed` writes `inTurn: false` and
  `stalled: undefined` **in the same `set`** (`:2394`, `:2397`), deliberately — *"A closed session
  cannot be stalled (the banner would linger on the paused transcript — a close supersedes the
  crash)"* — pinned by `sessions.test.ts:1788-1802`. The frontend doesn't need the Rust "stalled
  survives teardown" rule because it is a rendered mirror, not the crash-attribution store.
- **Refuted:** that an aggregate would help. Zustand's identity primitive *is* the flat key set; 99
  `useSessions(` sites index inside the selector (`s.messages[id]`), and collapsing to
  `Record<string, SessionState>` makes a write to any one field rewrite that session's row identity —
  re-running every selector touching that session. It would swap 11 small re-render domains for one
  large one and buy none of the Rust benefit. **The Rust merge traded four *lock* domains for one;
  there are no locks here.**
- **Survived:** the write sets are hand-written, inconsistent, and **unenumerated**. Verified at HEAD:

| path | maps it clears |
|---|---|
| `handleSessionClosed` | `closeReasons` (merge), `inTurn`, `stalled`, `compacting`, + `messages` finalized-but-kept |
| `deleteSession` | **`messages`, `history` only** |

`deleteSession` leaves `inTurn`, `compacting`, `stalled`, `stopReasons`, `closeReasons`,
`configOptions`, `contextUsage`, `sessionRecency`, `sessionOrder` populated for an id that no longer
exists. Not user-visible today — session ids are not reused, so nothing renders the residue — but the
Rust side documents exactly this shape as the reason for its aggregate (*"a session's state can no
longer be half-torn-down between two locks"*, `session/mod.rs:621-650`), and **no test knows the count
of 11**, so adding a 12th session-keyed map fails nothing.

**Proposal (Confidence High).** Not an aggregate. A **write-set contract**: one
`clearSessionState(sessionId, opts)` with an explicit per-field opt-in, called by every path that
retires a session, plus a test that enumerates the session-keyed fields (the count is the pin) and
asserts which subset each lifecycle action may clear. **Write the failing test first for
`deleteSession`'s residue** — that is the one place this becomes user-visible if a future change ever
reuses an id or reads a map by iteration rather than by key.

**Non-goals:** do not collapse the 11 maps into an aggregate; do not make the frontend preserve
`stalled` across close (that would resurrect the banner on a paused transcript — `:2395-2397` was a
deliberate change); do not extract the map-write helpers before the contract test exists.

### 🟢 Low Severity

#### 14. The two "hidden by a …" headings use the banned word for a relation the glossary names, and this copy was already approved in the last audit

- **Lens:** Naming
- **Files:** `src/components/AgentsDialog.tsx:107`, `src/components/SkillsDialog.tsx:121`
- **Severity:** Low · **Confidence:** High

CONTEXT.md:244-246 names the relation **Shadowing** / **shadowed** and its `_Avoid_` list bans
*overridden, masked, conflict, collision*. CONTEXT.md:252-254 separately defines **model-hidden** and
bans *"hidden (alone — reads as a UI visibility property)"*. Both `shadowHeading()` functions render
`"N agents are hidden by a space agent with the same name"` — using the **model-hidden** banned word
for a **Shadowing** relation, in text the user reads. This is prior finding 14's copy fix, approved
and never shipped (the rest of finding 14 landed: `list_agent_config` → `list_agent_config` is 0 hits,
`FileListDto` → `ListingDto`, the Palette "color scheme" copy is gone, the GeneralSection notification
copy is gone). ADR 0086 says repair on touch — both files were touched by `6f501ab3`. Two strings,
site tests only.

#### 15. `braille-loader.tsx` re-implements `usePrefersReducedMotion` without the WebKitGTK fallback the hook documents as non-hypothetical

- **Lens:** DRY Violations
- **Files:** `src/components/ui/braille-loader.tsx:28-54`, `src/hooks/usePrefersReducedMotion.ts:28-56`
- **Severity:** Low · **Confidence:** Medium

The hook seeds `useState(false)` and installs `addListener`/`removeListener` when `addEventListener`
is missing, documenting that *"a `MediaQueryList` without `addEventListener` is not hypothetical on
WebKitGTK"*. `braille-loader` seeds synchronously via `getPrefersReducedMotion` and calls
`addEventListener` unconditionally. The hook's doc at `:19-23` says the duplication is deliberate —
but that note addresses the **seed** difference, which is a legitimate reason; it says nothing about
the missing legacy fallback, which reads as an oversight. Two first-render answers differ (animate vs.
respect the setting) and one platform can throw. Cheap fix: keep the seed difference, share the
subscription.

#### 16. `commands/spaces.rs` does blocking `canonicalize` on the async executor while `commands/files/mod.rs` documents the opposite rule

- **Lens:** Inconsistent Patterns
- **Files:** `src-tauri/src/commands/spaces.rs:28` (via `:44`, `:101`)
- **Severity:** Low · **Confidence:** High

`commands/files/mod.rs:198-200` states the rule — *"the SAME `tauri::async_runtime::spawn_blocking`
this file already uses above, not `tokio::task::spawn_blocking`, which also compiles but would make
one file speak two dialects"* — and `spawn_blocking` is 4 production sites to 0 `tokio::task::` sites.
`space_for_path` and `set_space_trusted` are `pub async fn` reaching `std::fs::canonicalize` directly.
Sub-millisecond in practice; the file is untouched in the window, so this is a **stable minority**,
not growing drift. Worth one `spawn_blocking` wrap for consistency, not a finding on its own merit.

#### 17. Loose ends verified dead with no decision attached

- **Lens:** Dead Code (+ Naming)
- **Severity:** Low · **Confidence:** High

Five individually trivial items, all verified with a reference search that classifies doc-comment and
string-literal hits as non-references:

| item | site | evidence |
|---|---|---|
| `pub fn setup_dirs` | `lib.rs:60` | 26 hits, 25 are doc comments; production uses `setup_dirs_with_factory_refresher` (`:647`), tests use `setup_dirs_with_factory` |
| `pub fn noop_refresher_factory` | `provider_auth/refresh.rs:441` | re-exported twice (`mod.rs:159`, `lib.rs:84`), **0 callers**; every `setup_dirs*` entry passes literal `None` |
| `SessionManagerBuilder::with_catalog` | `session/mod.rs:1150` | **1** hit repo-wide: the definition. Its five sibling builder methods all have callers |
| `Settings.pane_layout` | crate DTO, mirrored `types.ts:765` | **0** readers on either side — 0 desktop prod, 0 TS non-test (`chatWidth` appears only in `config.rs`'s own round-trip tests). The only `Settings` field nobody reads; the other 8 Rust-unread fields are genuinely read by the renderer |
| `--text-ui-2xs`, `--tracking-wf-label` | `src/styles/theme.css:21,23` | 1 hit each — the declaration. Outside ADR 0072's scope, which enumerates `--color-*` only, so they are dead-and-unnamed rather than retained-by-decision |

Also discounted after checking, so the next audit does not re-spend it: **no unused npm dependency**
(`shadcn` is live via `index.css:3`'s `@import`, `@tauri-apps/cli` via `Makefile:204`);
**0 emitted-but-unqueried `data-testid`s** (71 emitted / 71 queried, all 6 apparent orphans are
test-fixture-authored); **0 orphan `.rs` files**; **0 `unreachable!()`/`todo!()`/`unimplemented!()`**
in Rust production; **0 real commented-out code blocks** (all ~40 grep hits are prose); **2
`#[allow(dead_code)]` in production, both `cfg_attr`-gated and both carrying a correct reason**
(`update.rs:474,502` — `restart_target`/`relaunch_patch` are genuinely live on Linux); **no
migration-era backfill that now does nothing**; and `subagent_models`' read-and-clear is **live
migration by design**, blessed by CONTEXT.md's **Agent override** entry.

---

## Considered and not filed

Recorded so the next audit does not re-spend the effort:

- **`test_support.rs` shipping in the release binary** (`lib.rs:19-20`, `#[doc(hidden)] pub mod`, not
  `#[cfg(test)]`). Real, **deliberate and documented** at `test_support.rs:140` — 22 integration
  targets need `ScratchDir`. The reviewer's judgement is that the headline ("attack surface / binary
  size") is filler. The one thing worth having is a narrow guard against a **second** shipped test
  surface (`lib.rs:19-20` is currently the crate's only `#[doc(hidden)]`), and that is worth ~10 lines
  if anyone is already in `lib.rs`.
- **`lib.rs:961`'s 200-byte window.** The scan is right that the anchor occurs twice (registration at
  `:542`, the test's own literal at `:978`) and that deleting the registration goes red only because
  the needle falls outside 200 bytes. But the file **documents** this at `:973-977`, and I verified
  the deletion does go red. "It fails, for a reason the author wrote down" is not a finding.
- **`SqliteTrustSource` has zero production constructions.** Verified: 6 constructions, all in
  `fulcrum_seams.rs` and `permission_gate_db.rs`; production uses `StaticTrustSource` fed from the
  pushed `DesktopConfig`. Already recorded in the prior audit's "considered and not filed" as a
  one-line doc fix. ADR 0091's own text half-concedes it.
- **`impl Store for SessionStore` is never driven as `dyn Store` from desktop production** — `Store`
  is not in scope in `session/mod.rs`, so `store.load_messages()` at `:1473` resolves to the **inherent**
  method (`harness/store.rs:178`, returning `DbError`), and `grep dyn Store src-tauri/src` → 0.
  Consequence: the `DbError → StoreError` mapping ADR 0091 names reaches that site only via the
  crate's own path. Genuinely interesting, **but the behaviour is identical** — the mapping only
  lengthens an error string — so there is no user-visible consequence to justify an item.
- **The `space_key` write/read asymmetry.** `upsert_space` keys on `canonicalize` with a raw fallback
  (`db.rs:1165`); `delete_space` (`:1236`) and `find_space` use the path raw, and no test covers a
  non-canonical upsert→delete round-trip. The asymmetry is **argued in-file** (`:1247` — re-canonicalizing
  would silently skip a row whose folder is gone and leave a partial renumber) and the paths reaching
  delete come from `list_spaces()`, i.e. already the stored key. Real untested edge, no demonstrated
  reachable failure — worth a test if anyone touches `db.rs`, not a finding.
- **`DenialMemory::deny` vs `decision: "deny"`** — one word, two concepts (a budget 403 latch vs a
  permission-rule verdict). Legitimate collision, no glossary term governs the first.
- **`--color-toast` / `--color-panel` / `--color-chat` / `--color-inspector`** vs their glossary
  `_Avoid_` lists. ADR 0072 retains unconsumed tokens by decision and `paletteCompleteness.test.ts`
  pins the names; `bg-chat` sits inside the D5 non-goal. Adjacent to a non-goal, flagged not filed.
- **Rust test naming has no dominant pattern** (262 of 816 article-prefixed, 578 not; 9 `test_`-prefixed
  exceptions clustering in `web/render.rs`). Neither dialect is drift; there is nothing to align to.
- **`useCallback` (32 sites / 13 files) and default-vs-named exports (57 / 19)** — no rule either way,
  flat in the window, no harm demonstrated. The export split is legible as "primitives named, shells
  default" and a new component copies `default`, which is not a problem.
- **Cancellation, serde direction, `#[allow]` hygiene and the IPC barrel are all clean.** `serde`: 22
  `camelCase` vs 2 `rename_all = "snake_case"` (both enum discriminators, both argued in-file), one
  field-level `rename` for the `override` keyword, and `whole_tool` still the sole documented exception
  with a drift pin. `#[allow]`: 3 production sites, all reasoned; 23/23 carry a comment. Barrel:
  0 bypasses, two guards covering opposite directions, and the 2 allowlisted parallel IPC modules are
  pinned with their provenance. The **one** stale citation there: `types.ts:871` says the permission
  shapes mirror `src-tauri/src/agent/definition_permission.rs` — that path is crate-owned since T5/S2.
- **`spawn_blocking`/`spawn` dialect splits are per-context and argued**, not drift
  (`files/mod.rs:198` for blocking, `refresh.rs:412`'s anti-precedent for `try_current` vs
  `handle().inner()` inside the `setup` hook).

## Decisions — 2026-11-07

**All 17 findings approved into the backlog.** Nothing dismissed, nothing deferred — the third
consecutive audit where the operator took the whole list, which is worth noting as a signal about
finding *volume* rather than finding quality.

Two scope modifications came out of the deep-dive reviews rather than the discuss round, and both are
load-bearing enough to sit with the backlog:

- **Finding 13 was demoted from High and had its proposal replaced.** It arrived as "collapse 11
  parallel session-keyed `Record`s into one `SessionState` aggregate, like the Rust side did." That is
  **refuted**: Zustand's identity primitive is the flat key set, 99 selector sites index inside the
  selector, and the Rust merge traded four *lock* domains for one — there are no locks here. The
  surviving deliverable is a **write-set contract**, not an aggregate. Do not let the original framing
  survive into a plan.
- **Finding 1 carries a recorded dissent.** The reviewer argued Medium on the grounds that the
  consequence is a fail-closed re-prompt, not a security or data-loss bug. Filed High. If the backlog
  gets re-sequenced, that is the finding to challenge — not its reality, its rank.

### Execution order

Ordering principle: **the extraction's residue first, because it is the only thing here that misleads
every future reader of the boundary and none of it changes behaviour.** Then the silent-failure guards,
then the two rules that stop the next 43 commits re-entering the same drift, then the splits.

Two repo constraints shape the waves, both from `AGENTS.md`: `archimedes` is **one compilation unit**,
so **two Rust implementation tasks can never share a wave** (read-only planning dispatches fan out
freely); and a plan that consumes a predecessor must **instruct verification-at-start and require a
`DEVIATION:` report**, because no predecessor has landed when the planners write.

#### Phase A — the extraction's residue (prose-only, zero behavioural risk)

| # | Finding | Change | Note |
|---|---|---|---|
| A1 | 2 | Fix the three false `//!`/doc comments: `agent/web.rs:37-38` (`worker/core.rs` is crate-owned since S8.2), `agent/mod.rs:31,:46` (both cite crate-internal paths that don't exist here), `types.ts:871` (names a desktop path that moved in T5/S2) | Docs only. **Highest value per minute in the report** — these are how a contributor decides what is safe to change |
| A2 | 2 | Repair `fulcrum_seams.rs:28-45`'s falsification instructions to name only files that exist here; mark the three crate-side proofs as *"performed in `archimedes-codes/fulcrum`'s CI"* | Prose. Do it in the same sitting as A1 while the boundary is loaded |
| A3 | 2 | Prune the **51 dead-entirely** aliases (census in the report body). Leave the 88 dead-aliases and the shim files | **Before the next crate rev bump**, while the diff is attributable |
| A4 | 7 | Decide `src/lib/errors.ts`: import the unions where `kind` is branched on, or delete the file and record the absence | Needs a decision, not a diff. Do **not** leave a file claiming consumers it lacks |

**Wave note:** A1/A2/A4 are docs-and-frontend, so they can share a wave. A3 is Rust and stands alone.

#### Phase B — the silent-failure guards

| # | Finding | Change | Test work |
|---|---|---|---|
| B1 | 1 | `option_id`: named constants + a `match` instead of two `if`s at `session/mod.rs:2586,:2598` | **Frozen-spelling pin first**, in the `errors.rs` shape — catches the realistic trigger (a desktop typo). Tests at `:6408`/`:6449` currently move *with* production, so they must be changed to pin a constant, not repeat a literal |
| B2 | 9 | `closed_reason_spellings_are_frozen` in the same shape | Then decide whether the dead-looking `serde(rename_all)` derive stays; if it stays, one line saying why |
| B3 | 8 | Extend `the_config_dtos_are_one_type_across_the_boundary` to `Settings`, `FontSettings`, `OidcConfig`, `WebSettings` | Same file, same shape. Then add `subagentDeadBoundSecs` to `AppSettings` **or** mark it renderer-invisible in one comment |
| B4 | 13 | `clearSessionState(sessionId, opts)` write-set contract | **Failing test first** for `deleteSession`'s residue (it clears 2 of 11 maps). The enumeration test that counts the session-keyed fields is the pin — no test knows it's 11 today |

**Wave note:** B1/B2/B3 are Rust (one per wave); B4 is frontend and can pair with any of them.

#### Phase C — the rules, before more code copies the wrong thing

| # | Finding | Change |
|---|---|---|
| C1 | 4 | Write the **subject-count** split rule into `AGENTS.md`, naming `tests/` dir (not `tests.rs` — zero sites) as the shape |
| C2 | 5 | Write the **lock-poison** rule: recover when the lock guards independent per-key state, panic when it guards one shared resource. Plus a rationale comment at `db.rs`'s lock helper |
| C3 | 6 | Correct `errors.rs`'s `//!` header to state the real placement rule; make `SessionError::kind` `pub` so the `kind()` shape is uniform |
| C4 | 12 | Correct ADR 0086's false collision probe; disambiguate the citation or renumber |
| C5 | 11 | Add the vacuity floor to `subagentSheetLayout.test.ts` |

**Do not write** the prior audit's "split when the test body exceeds the production body" rule. It fires
on 15 of 16 candidates, orders splits that remove no pain, and cannot see finding 3's 3,483-line
`describe`.

#### Phase D — the splits, now that the rule exists

| # | Finding | Change |
|---|---|---|
| D1 | 3 | Split `describe("ChatStream")` by subject — mention pickers (~45 tests) first. **Deliverable is the block boundary, not the file count** |
| D2 | 4 | Move `session/mod.rs`'s 2,952 inline test lines to `agent/session/tests/`. Three non-skippable checks: `naming.rs:926` imports `TestSink`; diff `cargo test --lib -- --list` on **full paths** before/after; `cargo build --all-targets` first (`--lib` doesn't rebuild `fake_worker`, which 10 targets spawn) |
| D3 | 10 | Move `sessionLifecycle.ts` + `settings.ts` to `src/store/`, then guard with a census that floors the **offender predicate** (copy `tauriBoundary.test.ts:198`), allowlisting type-only imports and `linkify.tsx` by name |

#### Phase E — cleanup

| # | Finding | Change |
|---|---|---|
| E1 | 14 | The two `shadowHeading()` strings (`AgentsDialog.tsx:107`, `SkillsDialog.tsx:121`) → **Shadowing** vocabulary. Two strings, site tests only |
| E2 | 15 | Share the `matchMedia` subscription between the hook and `braille-loader`; keep the deliberate seed difference |
| E3 | 16 | Wrap the two `canonicalize` calls in `spaces.rs` |
| E4 | 17 | Batch the dead items; **record a decision for `pane_layout`** (wire field, zero readers on either side) |

**Explicit non-goals carried forward:** do not collapse `sessions.ts` into an aggregate; do not make
the frontend preserve `stalled` across close; do not split `agent/errors.rs`; do not split
`archimedes-film/scene.ts`; do not re-split `db/tests/mod.rs`; do not split `config.rs`, `crashlog.rs`
or `commands/agents.rs` on a line-ratio trigger; do not delete the `docs/` cross-check in
`subagentSheetLayout.test.ts`; do not build a glossary copy-guard (ADR 0086 declines to authorise one);
do not re-suggest the five D5 renames; do not touch `test_support.rs`'s shipped-in-binary shape or
`lib.rs:961`'s 200-byte window (both documented decisions, not drift); do not add a cross-package
parity test (`events.ts:20-31` refuses grep-parity); do not change either subsystem's lock-poison
**behaviour** — the finding asks for a rule, not a refactor.

## Post-scan note — an in-flight glossary change whose code half has not landed

Not a finding (it is not in the audited tree), but it surfaced during the run and it is cheap.

`CONTEXT.md` is **modified and uncommitted** at HEAD, adding two entries — **New Space** and **New
Session** — that declare three UI labels retired. All three are still live:

| declared retired by the new entry | still live at | kind |
|---|---|---|
| *"Open Space (the retired sidebar label for this same command)"* | `SpacesList.tsx:455` `label: "Open Space"`, `:523` `<span>Open Space</span>` | user-visible label |
| *"New space (lowercase-s, the old `aria-label`)"* | `NewSpaceDialog.tsx:89` — the dialog title literal `"New space"` for an unvalidated folder | user-visible title |
| *"\"New Session in this Space\" (the retired `···` menu item this replaced)"* | `SpacesList.tsx:586` — the menu item's own rendered text | user-visible menu item |

So the glossary is currently **ahead of the code by three strings**, and ADR 0086's rule is conformance
on new code plus repair on touch — which permits exactly this lag. The risk is only that the entry says
"retired" while the label is on screen, so a reader of the glossary gets a false picture of the shipped
UI. Either land the three-string code change with the glossary edit, or soften "retired" to "being
replaced" until it does.

(Also verified while checking this: the `···` menu item at `:586` already calls
`startSessionInActiveSpace()`, so the *implementation* half of the new entry is correct — it is only
the label that lags.)



## Top Recommendation

**Finding 2 first, and its doc-comment half first.** The engine extraction is the largest structural
change in this repo's history and it left three `//!` headers asserting consumers that now live in
another repository, plus three falsification instructions in `fulcrum_seams.rs` that name absent
files. Those are prose-only fixes with zero behavioural risk, and they are the thing that will mislead
every future contributor touching the boundary — including the next audit. Prune the 51 dead-entirely
aliases in the same sitting, before the next crate rev bump makes the diff unattributable.

**Then finding 1** — one frozen-spelling pin in the shape the repo already uses four times, two named
constants, and a `match` instead of two `if`s. It is the only finding here whose failure mode is a
silent wrong answer for a user, and it costs less than a day.

**Then findings 3 and 4 together**, because they share a deliverable: write the **subject-count** rule
(no `describe` / no `#[cfg(test)]` region over ~25 unrelated tests) into `AGENTS.md`, then apply it to
`describe("ChatStream")` and `agent/session/mod.rs`. Explicitly **do not** write the prior audit's
"split when the test body exceeds the production body" rule — it fires on 15 of 16 candidates, it
would order splits that remove no pain, and it cannot see the 3,483-line `describe`, which is the
single worst navigation hazard in the tree.

**Findings 12 and 14 are the cheapest credible wins in the report** — an ADR whose own text asserts a
probe result that is false is a governance bug in the file that exists to prevent exactly that, and the
two "hidden by a …" strings are copy the last audit already approved and never shipped.
