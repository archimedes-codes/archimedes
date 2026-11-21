---
status: current
last-verified: 2026-11-20
verified-by: code research — 4 researcher angles (ADR 0063's per-family guarantee; mechanical split cost; the
  size-ratchet consequence; the realised-cost audit) run READ-ONLY at HEAD `add3054a`. Angles A and C returned
  complete reports; angle D returned complete; angle B (mechanical census) was cancelled twice in transmission
  and was RE-RUN BY HAND by the primary, so its numbers carry no adversarial second opinion and are marked as
  such below. Every load-bearing local figure was re-measured by the primary: the 1,719/1,135/497/638 line
  split, the 12 family boundaries and their per-family code lines, the 19-test single-family finding (with
  comments stripped), the 14 `errors.rs:<N>` citations, the 6-of-9 files-over-1,000-from-tests table, and
  `bash scripts/check-file-size.sh`. No mutation was compiled: every "this would still fail to compile" claim
  is a reading of the source, not a measurement, and is marked as such.
re-verified: 2026-11-20, at the commit that puts this file in git. Three corrections, each measured: §2b's
  pin count is **five**, not four, and `OpenError` is pinned (`open_error_kind_of_maps_the_refusal_codes`)
  rather than unpinned — see the correction note there; `SpacesError` is **2 of 4** unpinned, not "3 of 4",
  so "majority" was false for it; and deviation 10 records that this card's own header re-word moved raw
  `wc -l` to 1,723 while 1,135/497 still reproduce. The gap §2b describes is **closed** by
  `src-tauri/tests/error_wire_gate.rs`, and recommendation 1 is discharged by the 2026-11-20 amendment to
  ADR 0063. Every `errors.rs:<N>` citation below the header still carries `add3054a` numbering (+4 for the
  §2b table, which was re-pinned); the file is byte-identical between `add3054a` and that re-word, so the
  citations were correct when written.
task: tsk_018fbd23-1334-477d-b84a-0e8f5ac5922d
---

# `agent/errors.rs`: the per-family guarantee holds — and that is not the argument the decision rests on

Research question: *Is ADR 0063's "one place owns the user-facing English" guarantee still true **per family**
if the families are split, and does a new argument (not a new line count) exist that legitimately reopens the
three recorded NOs?*

**Answer in one line: the guarantee is per-family already, so ADR 0063 is not the obstacle the record claims —
but the cost case for splitting is empty on all four candidate axes, the 1,135 figure is 56% tests, the
governance question is already decided by an accepted-but-unlanded ADR 0112, and the one defect class the
file's shape actually enables gets worse with twelve files. Reaffirm, do not split.**

The card's stated fork was: *"If yes, the argument against collapses; if no, it stands and this card should be
closed."* The finding is that the fork is **false as posed** — the answer is yes, and the argument against does
not collapse, because the guarantee was never one of its load-bearing legs. Section 1 explains why the card's
own discriminator mis-specified which of the three NOs carried the weight.

---

## Findings

### 1. The card's decisive question answers YES — and it removes the weakest of the three legs, not the strongest

#### 1a. ADR 0063 contains no one-file requirement

Every sentence in the ADR that states where a new variant's user-facing English must be written is scoped to
one variant or one enum. The file path appears three times, always as a locator inside a per-variant
obligation.

| Sentence | Source | What the load-bearing noun actually is |
|---|---|---|
| "adding an error variant means writing its user-facing English in `errors.rs`, in the `#[error(…)]` attribute, **next to the variant** — one place, one language, one owner" | `docs/decisions/0063-ipc-errors-carry-a-kind-and-a-message.md:39` | per-variant. "One place" is defined by the immediately preceding "next to the variant"; "one language" is English-vs-`kind`; "one owner" is Rust-vs-frontend |
| "**A new error variant is a three-line obligation in one file**: the variant, its `#[error(…)]` sentence, and its arms in `kind()` and the `From` match" | `…0063…:78` | per-variant. The colon enumerates ONE variant's edits; "in one file" quantifies over that enumeration, not over the repository |
| "Each **enum's** `kind()` match and its `From` match are exhaustive with no catch-all arm, so a new variant must be **named twice**" | `…0063…:111-113` | per-enum, explicitly |
| The frozen-kind table | `…0063…:117-123` | keyed on **error type**, never on path — and it names only **5 of 12** families, so it cannot be the "all families in one file" rule |

The ADR states the **opposite** of a file-layout rule twice, in its own amendment:

> "The error type is chosen by the wire, not by the file." — `…0063…:94`
> "The discriminator is the wire surface a command answers on, **never the module it is declared in**." — `…0063…:105`

The only sentence that can be stretched into a one-file requirement is `:78`'s "in one file", read as "THE one
file". Its own colon defeats the reading, because what follows the colon is a single variant's four edits. The
second-choice stretch is the amendment's descriptive "All hand-built in `src-tauri/src/agent/errors.rs`"
(`:109`) read as a rule rather than an inventory — defeated by that amendment's own table naming 5 of 12
families, and by the file header's confession that five families take a different code path
(`src-tauri/src/agent/errors.rs:7-9`).

**Verdict: ADR 0063 requires (i) exactly one hand-written `impl From<…> for InvokeError` per error type,
(ii) no `Serialize` derive, (iii) an exhaustive `kind()` match and an exhaustive `From` match so a variant is
named twice, and (iv) the `#[error(…)]` sentence beside its variant. All four are per-family properties and
none mentions a path.**

#### 1b. The compile-error property is per-enum and survives a split intact

This is the load-bearing half of ADR 0063 ("the derive stays off"), and it is a coherence-and-exhaustiveness
property, not a file-adjacency property:

1. With no `Serialize` on the enum, Tauri's blanket `impl<T: Serialize> From<T> for InvokeError`
   (`tauri-2.12.2/src/ipc/mod.rs:240-247`, quoted at `…0063…:19-24`) cannot apply, so a command returning
   `Result<_, FamilyError>` has no implicit conversion and fails to compile unless the hand-written impl exists.
2. That impl's `extra` match and the `kind()` match are exhaustive with no catch-all arm.

Both matches are written **over the enum**, and an enum's `thiserror::Error` attribute and its impls must live
in the crate that defines it. So the property attaches to the enum plus its two matches wherever the enum is
declared. A split keeps enum + `kind()` + `From` in one file, so a new variant lacking its sentence, its
`kind()` arm, or its `From` arm is still a compile error. **Verified by reading, not compiled.**

The one way to weaken it is a split that separates a family's enum from its `From<…> for InvokeError` impl (a
single `wire.rs` holding all twelve impls). That is legal Rust, keeps the compile error, and breaks the "next to
the variant" locality. **No document forbids that variant today**, so any plan that splits must state the
per-family-file constraint explicitly.

#### 1c. Two sentences go false — in letter only, and both are locators

| Sentence | After a split inside `agent/errors/` |
|---|---|
| "`nothing outside this file builds one`" (`…0063…:41`) | False per file, true per directory. It is a **descriptive** claim, not a guarantee; currently true of the tree (measured: **0** direct `InvokeError(…)` constructions outside `errors.rs`; the only outside use is the *conversion* `InvokeError::from(err)`, 12 calls in 3 files, which builds nothing itself). Must be re-spelled "nothing outside `agent/errors/`" |
| "All hand-built in `src-tauri/src/agent/errors.rs`" (`…0063…:109`) | Path literal goes stale. The normative content of the same sentence ("Each enum's… named twice") is untouched |

The header's inventory sentence "All IPC error families live here" (`errors.rs:1`) and its "the `kind()` strings
here are the single source of truth" (`:18-21`) become true of the directory; the *singularity* claim is
unaffected, since one definition per `kind` is unchanged.

#### 1d. The header's "do NOT split this file by layer" forbids a different move

The normative passage, verbatim (as it read at `add3054a`, and **since re-worded** — see the note at the end of
this sub-section):

> "`DbError`/`FsError` stay with their own layers (`storage` / the crate's `fs_backend.rs`) because they are NOT
> IPC types — the wire contract fixes the envelope, and the error type is chosen by the WIRE, not by the file.
> **So do NOT split this file by layer, and do NOT move an IPC family out of it with the argument that it belongs
> next to its callers.**" — `src-tauri/src/agent/errors.rs:9-14`

The `Because` clause defines the term used one clause later: "layer" is what `storage` and `fs_backend.rs` are,
i.e. the **non-IPC architectural layer**, and the motive named is "belongs next to its **callers**" — a motive
that only makes sense for a move *out* of the IPC file, into `storage/` (where `DbError` and `BoardError` live)
or into `commands/` beside the constructing command. An `errors/{session,history,mcp}.rs` sibling changes no
layer, gains no non-IPC home, and every resulting file is still an IPC type inside `agent`. The header's stated
rationale ("the WIRE chooses the type, not the file") is therefore untouched by it.

**The honest counter-reading, stated so it is not quietly suppressed:** "do NOT move an IPC family out of **it**"
— if "it" is *this file* rather than *this layer*, the clause forbids any family leaving `errors.rs`, a
per-family split included. That reading makes the clause broader than the reason attached to it supports. **The
clause's letter forbids the split; its stated reason does not reach it.** This is the one sentence in the entire
corpus that can be read as prohibiting the move — and it is a file header, not an ADR.

**RESOLVED 2026-11-20 — the passage above no longer exists.** The header was re-worded to what its reason clause
supports, and the counter-reading it enabled is gone with it: the header now forbids moving an IPC family **to a
non-IPC layer** (`storage`, the crate's `fs_backend.rs`, or the command module that constructs it), states that
the wire chooses the type and never the file it sits in, and points at the 2026-11-20 amendment to ADR 0063 for
the per-family decision. Unresolved contradiction `1.` below is closed by the same edit. The quote is kept above
untouched because the analysis in this sub-section is of *that* wording.

#### 1e. The other two NOs are benefit-claims, and they are the ones the cost evidence tests

Both are arguments about payoff, not about guarantees (the first is quoted as it read at `add3054a`; that
bullet now says **twelve** families and sits at `:270` — see deviation 4):

> "**`agent/errors.rs` not split** — its ten families share `InvokeErrorExt` and are coherent; splitting buys a
> directory and nothing else." — `docs/features/improvement-boundary-residue-closeout.md:267`

> "**Do not split the file** — the families are coherent, share `InvokeErrorExt`, and splitting buys an `errors/`
> directory and nothing else." — `docs/reviews/2026-11-07-codebase-improvement.md:369`

"Buys nothing" is a claim about cost and benefit, and **it is the claim section 2 falsifies or confirms.** It is
also the *right* kind of claim: unlike a guarantee, it can be re-examined with new numbers. The numbers came,
and they confirm it.

#### 1f. No cross-family guarantee is stated anywhere as a requirement

The nearest candidates are descriptive or about a different subject:

- `errors.rs:1` "All IPC error families live here" — a description of the file.
- `errors.rs:18-21` "Rust owns every `kind()` vocabulary below… the `kind()` strings here are the single source
  of truth" — a **singularity** claim (one definition per kind), which a split preserves.
- `…0063…:127` "one frontend union holds every family's kinds" — about the **frontend**, and see deviation 3 in
  **Deviations found**: that union has been deleted, so the sentence describes a nonexistent artifact.

Nobody writes down "all twelve `kind` vocabularies must be visible in one read". And that property is **already
partly false at HEAD**, which is why a split loses a view rather than a check: `TasksError`'s vocabulary is
pinned *outside* this file (`src-tauri/src/commands/tasks/tests/board.rs:135`), `FilesError` has no `kind()`
method at all (deliberately — `errors.rs:512-520`), and 51 distinct spellings across 63 arms are reused across
families (`io` ×4, `other` ×7, `database` ×2, `not_found` ×3) with **no assertion anywhere** that the union is
globally unique.

---

### 2. Does anyone experience the 1,135 lines as a cost? No — and the census understated the file

| Candidate cost | Verdict | Measurement |
|---|---|---|
| **Defects** | **Unsupported** | 0 of 87 audit findings and 0 of 61–76 known-gaps entries attribute a defect to file length. The single causal-language hit in `docs/reviews/` is `2026-10-30…:130` — an LLM "prompt is too long", not a source file |
| **Churn / fix density** | **Unsupported, and the census flattered the file** | 16 commits, 1 `fix:`, 12 months. 1.06 fix/kLOC is computed on **raw** lines; on the ratchet's own code-line basis it is **2.01 against a repo line-weighted average of 1.98** — rank 46 of 115, dead median |
| **Review size** | **Unsupported** | Median diff **58.5 LOC** vs a repo median commit of 358 LOC; 1 of 16 diffs exceeds 400 lines |
| **Agent context / tokens** | Real mechanism, **non-binding here** | Census method reverse-engineered as **bytes ÷ 4** (reproduces all four named files to within 1%: `db/tests/mod.rs` 331,139 B → 83k, `sessions.test.ts` 288,976 B → 72k, `db.rs` 206,199 B → 51k, `session/mod.rs` 159,837 B → 40k). `errors.rs` = 73,852 B → **18.5k tokens**, i.e. 4.5×–19× below the four, 9% of a 200k window |

**The one finding that names the file does not blame its length.** `docs/reviews/2026-11-07-codebase-improvement.md:345-370`
diagnoses (i) a `//!` header naming 2 of 10 types and (ii) two `kind()` shape inconsistencies across families.
Its own proposal is *"Minimum fix, two lines of prose and one signature"* and it closes with **"Do not split the
file"**. The `1,494 lines` in its opening is scene-setting, not a cause.

**Neither defect was caused by distance, and a split would not have prevented either.** Both were derivable in
two greps (`grep -nE '^pub (enum|struct) '` → 11 declarations; `grep -c 'fn kind\('` → 10; the set difference is
`FilesError`). The distance the finding relies on is 25 lines, not 1,494. The header fix landed in `de88a2d8` as
a **30-insertion / 4-deletion** diff in 3 hunks. `SessionError::kind` is `pub` at HEAD (`errors.rs:86`);
`FilesError`'s missing `kind()` is a **recorded decision with a leave-comment in the file** (`errors.rs:512-520`,
`improvement-boundary-residue-closeout.md:250-252`) and its wire vocabulary is pinned anyway
(`errors.rs:1084`). **Twelve files means twelve `impl` blocks that can each independently diverge — a split
multiplies this defect class, it does not remove it.**

### 2b. The one real cost the shape enables is a missing gate, not a long file

Twelve families are each supposed to freeze their `kind` spellings. **Only five do**, and **no meta-test
enumerates families**, so a new family can land with no pin and nothing notices. The repo has already measured
the consequence:

> rewriting the Rust arm to `SettingsError::McpAuthFailed(_) => "mcp_auth_faild"` — a real typo — passes the
> **entire** Rust suite: **1,651 passed / 0 failed / 1 ignored**, and `tsc --noEmit` stays clean.
> — `docs/features/improvement-correctness-seams-closeout.md:264-279`

`settings_error_kind_spellings_are_frozen` was named a **required step** at `:240` and called "a required step"
again at `:449`. **At HEAD it still does not exist.** `TasksError` (added `2814d561`) has no pin in this file
either — its pin lives three directories away at `commands/tasks/tests/board.rs:135`, and it survived only
because someone remembered it in the file's one `fix:` commit.

| Family | `kind()` | dedicated frozen-vocabulary pin |
|---|---|---|
| `SessionError` `:90` | yes | **—** (every spelling appears as a literal inside a wire-envelope test; no vocabulary pin) |
| `HistoryError` `:178` | yes | `:1247` |
| `AttentionError` `:261` | yes | `:1365` |
| `ClipboardError` `:314` | yes | `:1443` |
| `OpenError` `:390` | yes | `:1530` — `open_error_kind_of_maps_the_refusal_codes`, whose own doc comment reads *"`kind_of`'s ENTIRE code table, frozen"*, and which asserts the **deduped** `BTreeSet` of spellings against a five-element literal |
| `UpdateError` `:477` | yes | `:1581` |
| `FilesError` | **none by decision** (`:516-524`) | **—** (no `kind()` to pin; wire vocabulary pinned by the envelope test) |
| `SettingsError` `:608` | yes | **none** — named required, never landed |
| `SpacesError` `:653` | yes | **none** |
| `TasksError` `:743` | yes | **none in this file** (pin at `commands/tasks/tests/board.rs:135`) |
| `McpError` `:894` | yes | **none** |
| `AgentsError` `:928` | yes | **none** |

**Correction to the first draft of this table (2026-11-20).** It read **"Only four do"** and it grouped
`OpenError` with `SessionError` and `FilesError` under a `—` pin. Both were wrong, and the `OpenError`
error was the substantive one: `open_error_kind_of_maps_the_refusal_codes` freezes that family's vocabulary
completely — the test builds its `frozen` table over `kind_of`'s whole code table, then collects the
spellings into a `BTreeSet` and asserts the deduped vector against a literal of exactly the five values
(`denied_scheme`, `invalid_href`, `os_error`, `other`, `relative_without_cwd`), with a comment stating *"the
frozen vocabulary is five values, not six"*. A re-worded `kind_of` arm fails that assertion. `OpenError`
therefore belongs in the **pinned** column and the count is **five**, not four. `FilesError`'s `—` is
correct and stays: it has no `kind()` at all, by the recorded decision at `:516-524`.

The other two `—`s are real gaps and of different shapes: `SessionError`'s seven spellings each appear as a
literal inside a wire-envelope test but no assertion freezes the **set**, and `TasksError`'s six are
asserted as literals but in a flat `assert_eq!` sequence three directories away. Of the four families whose
named pin never landed, `SettingsError` has **4 of 12** spellings asserted anywhere (`save_failed` from its
envelope test and the three OIDC kinds from `the_three_oidc_settings_error_kinds_are_on_the_wire` — the other
eight, `mcp_auth_failed` itself included, nowhere), `McpError` **2 of 4** (`load_failed`, `not_found`) and
`AgentsError` **2 of 3** (`discovery_failed`, `not_found`) — a clear majority unpinned in each. `SpacesError`
is **2 of 4**, which is half and not a majority: `folder_not_found` and `not_a_folder` are asserted at
`commands/spaces.rs:165,179`, while `database` and `other` are never produced as a `SpacesError` in any test —
their `kind()` arms exist and nothing exercises them. Each of these four families has exactly **one** variant
constructed by its in-file envelope test, which is why "has an envelope test" and "has a pinned vocabulary"
are not the same claim.

**Re-verified 2026-11-20 — this gap is closed, and the closure is a gate, not more pins.**
`src-tauri/tests/error_wire_gate.rs` is the meta-test this section asked for: nine variant-bearing families
each gated by an exhaustive `match` written from one macro entry per variant (pattern + frozen spelling +
construction, so they cannot diverge), each asserted against an **independent** literal that does not read
`kind()`, plus a family scan keyed on `impl From<…> for tauri::ipc::InvokeError` that fails the build naming
any family absent from the gate. `OpenError`, `UpdateError` and `FilesError` are its three documented
exemptions — the first two because their vocabularies are already frozen by the `kind_of` pins above (which
it deliberately does not duplicate), `FilesError` because it has a `From` impl and no `kind()`. The
`mcp_auth_faild` typo quoted above now fails that gate. **The line numbers in the table above are the
post-header-re-word numbers** (the 2026-11-20 header edit shifted every `errors.rs` line below the header by
**+4**); every `errors.rs:<N>` citation elsewhere in this document still points at the `add3054a` numbering,
which is exactly the rot this section's own §"Cost that is real" predicted. **The same drift applies to this
section's citations into the two docs that run corrected:** in
`docs/features/improvement-correctness-seams-closeout.md` the `:240` file-list row is now `:241`, the
`:264-279` "missing drift pin" section is now `:265-305`, and the `:449` corrections-table row is now `:467`
(that doc grew 18 lines from the closure notes this run added to it); in
`docs/features/improvement-boundary-residue-closeout.md` the `:250-252` `FilesError` bullet is now `:253-255`
and the `:267` split bullet is now `:270`. Those citations were correct when written and are left at their
original values, per the same rule.

This is a **gating** gap that a per-family split makes strictly worse (12 independent omissions, still no
enumerator) and that a meta-test closes today, in one file, at zero navigational cost.

---

### 3. The ratchet finding is new, and it moots the premise that this file is "1,135 lines of code"

| Instrument | `errors.rs` | vs the 1,000 bar |
|---|---|---|
| raw `wc -l` | 1,719 | not a gate |
| **whole-file code lines** — the instrument the repo actually ships | **1,135** | **over by 135**; ledgered at `scripts/file-size-baseline.txt:13` |
| census cfg-cut (stop at `#[cfg(test)]`, `errors.rs:943`) | **497** production | **under by 503** |

`1,135 − 497 = 638` = the inline test region's code lines. AGENTS.md already states both halves in one sentence
("`errors.rs` (1,135 code lines whole-file, of which 497 are production and the rest its inline test module)"),
so the honest statement is the pair, and the operative one for the gate is 1,135.

**`errors.rs` is not special.** Of the 9 files the guard flags over 1,000, **six are there only because of an
inline test region**:

| File | recorded | production-only | inline region | over 1,000 only because of tests? |
|---|---|---|---|---|
| `storage/db.rs` | 2,154 | 2,152 | 2 | no |
| `agent/session/naming.rs` | 2,007 | **327** | 1,680 | **yes** |
| `agent/session/mod.rs` | 1,583 | 1,581 | 2 | no |
| `agent/session/router.rs` | 1,471 | **456** | 1,015 | **yes** |
| `store/sessions.ts` | 1,370 | 1,370 | 0 | no |
| `config.rs` | 1,289 | **259** | 1,030 | **yes** |
| **`agent/errors.rs`** | **1,135** | **497** | **638** | **yes** |
| `commands/settings.rs` | 1,070 | **442** | 628 | **yes** |
| `commands/agents.rs` | 1,055 | **140** | 915 | **yes** |

Only `db.rs`, `session/mod.rs` and `sessions.ts` are genuinely over on production — and all three are already
owned by their own cards (`tsk_31`, `tsk_32`, `tsk_33`).

#### 3b. ADR 0112 already decides this — and its premise is in the tree while its decision is not

`docs/decisions/0112-the-size-ratchet-governs-test-sources-as-their-own-class-gated-at-the-same-1000-code-lines.md`
(accepted 2026-11-17) names the asymmetry and closes it by gating test sources as their own class at the same
1,000 lines, explicitly so relocation is never cheaper than splitting:

> "That is true only while the tests stay **inline**. Relocate them to `foo/tests/` and today they leave the
> instrument entirely. … At 1,000 relocation is a wash: the region stays gated wherever it lives, so the only way
> down is to split it by subject." — `0112:24-41`

Three consequences for this card:

1. **0112 is untracked and unimplemented.** `git status --porcelain` shows it as `??` (as does `0113`;
   `0114` and `0115` have since been committed), and `scripts/check-file-size.sh` still defines only
   `HARD_GATE=1000` and `SEED_THRESHOLD=700` — no classifier, no test gate, no second baseline. Its
   premise (241 test sources, 19 over 1,000, guard sees none)
   is in the tree; its decision is not, and CI does not read it.
2. **0112's own table omits `errors.rs`.** It says "five of the nine"; measured at HEAD it is **six**. Its
   superseded-threshold table (`0112:30-36`) lists `settings.rs` 628 and `agents.rs` 915 as **"not caught"** at a
   1,000-line test gate — and `errors.rs`'s region is **638**, the same band. So even after 0112 lands as
   written, moving `errors.rs`'s tests to `errors/tests/` would leave production at ~499 (under `SEED_THRESHOLD`
   700, so `--update` **deletes the ledger row**, and no pin objects — `check-file-size.test.sh:1056` only demands
   an entry above 700) **and** the region under the test gate. Free on both sides, which is the exact outcome
   0112 exists to prevent. **This is a real gap in 0112 and should be reported to it, not worked around here.**
3. **Relocation has no precedent and would be the first.** The ledger has three commits and **no entry has ever
   been removed**; all five existing `tests/` directories predate the ledger (`47432a38`, `de88a2d8`, `18592d0a`,
   `18d56a44`). `db.rs`'s 2,154 is production with its tests **already** in `db/tests/` (6,128 code lines,
   invisible to the guard) — the opposite shape. ADR 0113's mirror-test-tree rule binds a `tests/` directory that
   exists, and explicitly rejects "split the test region without splitting production" as *"a repeat of a recorded
   failure"* (`0113`, Considered Options, citing `936dcafe`).

**So the tests-relocation route is excluded by the repo's own governance, and the split route is the only
legitimate way down — which puts the entire weight of the decision back on §1 and §2, where it does not
support a split.**

---

### 4. Mechanical cost: the census's "cleanest split in the repo" reproduces, and the payoff is twelve small files

Measured at HEAD by the primary (this angle's researcher dispatch was cancelled twice in transmission):

- **Twelve families, per-family code lines:** `TasksError` 94, `SessionError` 50, `SettingsError` 54,
  `UpdateError` 40, `HistoryError` 41, `OpenError` 36, `SpacesError` 35, `FilesError` 31, `McpError` 30,
  `AttentionError` 29, `ClipboardError` 29, `AgentsError` 26. Sum 495. **Largest resulting file ≈ 94 code lines
  of production** (the census's "largest resulting file 180 lines" is a raw-line figure and is consistent).
  **Five families are under 32 code lines** — a per-family file for each is a directory of twelve files averaging
  ~41 lines.
- **Zero code-level cross-family references.** All cross-family mentions are doc-comment prose: "the
  `SessionError::Io` precedent" ×5 (`:199, :208, :323, :401, :488`) and "the `FilesError::ImageTooLarge`
  precedent" ×2 (`:725, :860`). No family names another in a match arm, a call, or a `From` impl. The four
  inbound `From` impls (`From<DbError>`, `From<rusqlite::Error>` ×2, `From<BoardError>`) come from `storage`, not
  from sibling families.
- **All 19 tests are single-family at code level.** A naive scan flags four tests as multi-family; re-run with
  comment lines stripped, **every one touches exactly one family** — the apparent cross-family hits are prose
  ("the `SessionError::Io` precedent" inside `history_error_kind_spellings_are_frozen`). Tests therefore relocate
  cleanly per family.
- **Zero consumers need edits.** Six `crate::agent::errors::<Type>` imports plus `agent/mod.rs:21`'s
  `pub mod errors;` and `:99`'s `pub use errors::{…}`; both module shapes resolve identically.
- **E0117-clean** (every `impl` has a locally-defined `Self`; a module move within one crate cannot affect
  coherence) and **zero source-text lints** — no `include_str!` or `read_to_string` anywhere reads `errors.rs`,
  unlike `db.rs`, which has four.
- **Cost that is real:** `trait InvokeErrorExt` (`:538`, five users) is file-private today and must widen to
  `pub(crate)`/`pub(super)` and move to `errors/mod.rs` — a visibility widening the current design avoids.
- **Cost that is real:** **14 `errors.rs:<N>` line citations rot**, 3 of them in production source
  (`storage/db.rs:47`, `storage/db.rs:69`, `agent/harness/store.rs:376`) and 11 in docs. Every one silently
  points at the wrong line — no compiler or test catches a stale prose line number.

**Net: mechanically clean, as advertised, and the payoff is twelve files of ~41 production code lines each,
against a file whose production size already sits under the bar on the census instrument.**

---

## Unresolved contradictions

1. **RESOLVED 2026-11-20.** **The letter of the header vs the letter of the ADR.** `errors.rs:12-14` forbids moving an IPC family "out of
   it", which on its face bans a per-family sibling; ADR 0063 `:94`/`:105` says the module is *never* the
   discriminator. The record does not reconcile them. This report reads the header's `Because` clause as binding
   the layer move and its "out of it" as the broader literal — and notes that **a file header is not an ADR**, so
   if the header is meant to be a layout rule it belongs in 0063, which currently says the opposite.
   **Closed 2026-11-20, and note which way it went:** the header was re-worded to the layer reading its reason
   clause supports, so the broader literal is gone, and 0063's 2026-11-20 amendment now states the layout rule on
   the record — reaffirming `:94`/`:105` (the wire, never the module) as what governs layout, and naming and
   forbidding the one layout that would weaken the guarantee (a shared `wire.rs` holding all twelve `From` impls).
   The contradiction was resolved by **removing the header's claim to be a layout rule**, not by promoting it into
   0063 as one.
2. **The census calls the split "mechanically the cleanest in the repo" and simultaneously declines it.** Not a
   contradiction — mechanical cleanness is not a benefit — but the two claims sit 240 lines apart in one document
   and read as one.
3. **ADR 0112 is `accepted` on disk, absent from git, and its own table omits this file.** Until it is committed
   and implemented, the repo's stated intent (relocation is a wash) is not the repo's actual behaviour (relocation
   is free). Any decision that assumes "the governance question is settled" is assuming an untracked file has
   landed.

## Gaps

- **No evidence exists on file size vs LLM/agent task success.** The token counts are measured; the census
  explicitly labels the harm *"speculation"* (`production-godfile-census-and-the-size-metric.md:539`). This report
  inherits that limit — 18.5k tokens is measured, "that is affordable" is an inference.
- **The 12-file split's effect on the drift-pin class is reasoned, not measured.** "Twelve files means twelve
  chances to omit a pin" follows from there being no enumerator today; it was not tested by attempting the split.
- **Whether ADR 0113's mirror rule would make `errors/tests/` mandatory after a split** is argued from 0113's own
  "Scope" section (which says the mirror binds a `tests/` directory that exists but does not demand extraction
  below a trigger) but not settled, because 0113 is itself untracked.
- **Angle B carries no adversarial second opinion** — its dispatch was cancelled twice and the primary re-ran it.

---

## Evidence

**Local, primary (high credibility) — all re-measured at HEAD `add3054a`; `errors.rs`, `check-file-size.sh` and
`file-size-baseline.txt` are byte-unchanged since `b2d6ea95` (`git diff --stat` between them is empty):**

`src-tauri/src/agent/errors.rs:{1-30, 43, 86, 156, 199, 208, 237, 296, 323, 354, 395, 401, 438, 488, 505, 512-520,
538, 542, 550, 628, 634, 671, 695, 725, 860, 869, 875, 906, 912, 939, 943, 1084, 1120, 1163, 1243, 1266, 1361,
1439, 1577}` · `src-tauri/src/agent/mod.rs:{21, 99}` · `src-tauri/src/agent/harness/store.rs:376` ·
`src-tauri/src/storage/db.rs:{47, 69, 185-187}` · `src-tauri/src/commands/tasks/tests/board.rs:135` ·
`scripts/check-file-size.sh:{21, 29-38, 46-53, 117-126, 194, 218-235, 405-408}` ·
`scripts/check-file-size.test.sh:{394-460, 572-619, 669-681, 717-759, 1056}` ·
`scripts/file-size-baseline.txt:13` · `tauri-2.12.2/src/ipc/mod.rs:224, 240-247` (crates.io source).

**Local, documentary:** `docs/decisions/0063-…:{9, 19-24, 39, 41, 66, 78, 94, 102, 105, 109-127}` ·
`docs/decisions/0112-…:{14, 24-41, 30-36}` (**untracked**) · `docs/decisions/0113-…` (**untracked**) ·
`docs/features/improvement-boundary-residue-closeout.md:{250-252, 267}` ·
`docs/features/improvement-correctness-seams-closeout.md:{240, 264-279, 449}` ·
`docs/features/godfile-decomposition-closeout.md:{105-118}` ·
`docs/reviews/2026-11-07-codebase-improvement.md:{345-370, 388, 780, 806}` ·
`docs/reviews/2026-10-19-codebase-improvement.md:{59, 90}` ·
`docs/reviews/2026-10-30-codebase-improvement.md:{130, 588}` ·
`docs/research/production-godfile-census-and-the-size-metric.md:{82, 314-318, 352, 447-449, 464, 476, 487, 521-525, 539}` ·
`docs/roadmap/db-split-and-mirror-test-tree.md` (**gitignored**) · `AGENTS.md:144-167`.

**Git:** `b19dfe2e`, `de88a2d8`, `67b9378c`, `47432a38`, `2814d561`, `18592d0a`, `18d56a44`, `22f61dd1`,
`29beb578`, `9997f13f`, `936dcafe`, `4c06b1de`, `1355cd2a`, `b2d6ea95`, `add3054a`. Blob `8849b67b…` for
`errors.rs` is identical at the census commit and at HEAD.

## Deviations found (docs disagreeing with HEAD)

1. `docs/reviews/2026-11-07-codebase-improvement.md:352` — "1,494 lines, **10** IPC error enums" with an
   **eleven**-name line map. HEAD: 1,719 raw / 1,135 code / 497 production, **12 families** at
   `:43,156,237,296,354,438,505,550,634,695,875,912`. Its "`SessionError::kind` is private (`:68`)" is **false at
   HEAD** (`:86` is `pub fn kind`); its "`FilesError` … at `:496-499`" is now `:523-526`.
2. **FIXED by the 2026-11-20 header re-word.** `src-tauri/src/agent/errors.rs:19` — "`src/` branches on `.kind` in
   ~128 places". Measured **83** non-test lines (93 occurrences); 193 including tests. No spelling reproduces
   ~128. The header now says "83 non-test lines (93 occurrences)"; the sentence sits at `:22-25` after the re-word.
3. **CORRECTED 2026-11-20, from inside the amendment.** `docs/decisions/0063-…:127` — "one frontend union holds
   every family's kinds" (present tense).
   `src/lib/errors.ts` is **deleted**; no such union exists at HEAD. The 2026-11-20 amendment's
   `### The kind-spelling gate is now an obligation of this contract` corrects it there rather than editing
   `:127`, per the append-only convention; `:127` itself is unchanged and still false in place.
4. **FIXED 2026-11-20.** `docs/features/improvement-boundary-residue-closeout.md:267` — "its **ten** families".
   HEAD: twelve
   (the file's own header says twelve, `errors.rs:1-5`). Now reads **twelve**, and the bullet has moved to `:270`
   because the `src/lib/errors.ts` bullet above it grew.
5. `docs/decisions/0112-…:14` — "Five of the nine files the guard DOES flag are over 1,000 only because of an
   inline test region". Measured **six** (`naming.rs`, `router.rs`, `config.rs`, `errors.rs`, `settings.rs`,
   `agents.rs`); its table omits `errors.rs`.
6. `scripts/check-file-size.sh:26` — "the largest .tsx file here is 622". Largest walked `.tsx` at HEAD is
   `chat/MessageList.tsx` at 583 (622 was `SpacesList.tsx` at `1355cd2a`). Harmless to the argument.
7. `scripts/check-file-size.sh:60-71, 305, 352` — the counts (298 walked; 75/27/13/9/3) reproduce **exactly at
   their stated base `1355cd2a`**; at HEAD they are **312 / 76 / 24 / 13 / 9 / 3**. Labelled with its base, so
   lag rather than error — but `:305`'s "~298" and `:352`'s floor message are read today.
8. `scripts/check-file-size.sh:68` — "The census's cfg-cut instrument gives **67** / 17 / 5 / 3 / 2". 17/5/3/2
   reproduce; **67 could not be constructed** (measured 64, or 66 depending on the cut rule).
9. **No deviation** in the figures this report turns on: `check-file-size.sh:53`'s `1719 / 1135 / 497`, the
   ledger's 1135, `AGENTS.md:165-167`, and the census's `497 | 1,719` row all reproduce to the digit.
10. **Added 2026-11-20, caused by this card's own header re-word.** Deviation 9 is now true only for the two
   figures that gate. The `//!` header edit added 4 comment lines, so raw `wc -l` on `errors.rs` is **1,723**,
   not 1,719: `check-file-size.sh:53`'s `1719` column and the census's `497 | 1,719` row are stale by exactly
   that +4, and both are **left alone** — the script comment is labelled with its own base and the census
   reports what it measured at `4c06b1de`, and neither is in this card's owned set. What still reproduces to
   the digit is what every gate in the repo actually reads: **1,135** whole-file code lines (the ledger, and
   `check-file-size.sh`'s classifier), **497** production code lines on the census's cfg-cut, and therefore
   `AGENTS.md:165-167`'s pair. A comment-only edit moves the raw count and cannot move the gated one — which
   is the distinction §3 of this report is about.

---

## Recommendation (for the ADR that closes this card)

**Reaffirm the NO — with the reasoning corrected — and spend the effort on the gate, not the file.**

**Discharge status (2026-11-20).** Recommendations 1 and 4 are done as written: ADR 0063 carries a second
`## Amendment` answering the per-family question and reaffirming the decline, and the header plus the three
living docs are corrected (with `docs/reviews/` untouched, per item 4). Item 2 is done **by a different device
than asked**: the meta-test exists (`src-tauri/tests/error_wire_gate.rs`, keyed on the `From` impls, so it
enumerates families) and it freezes every family's vocabulary, but neither named pin was written —
`settings_error_kind_spellings_are_frozen` still does not exist under that name (the gate's
`settings_error_kinds_are_frozen_and_complete` is its closure), and `TasksError` still has no pin inside
`errors.rs` (the gate covers it from `src-tauri/tests/`). Both omissions are forced, not chosen: `errors.rs`
is ratcheted at 1135 code lines and an inline test region counts. Item 3 is **not done** — ADR 0112 is still
untracked and its table still omits `errors.rs`.

1. **Amend or reaffirm ADR 0063** with the per-family question answered on the record: the guarantee is
   per-variant/per-enum, it is **not** a one-file rule, and `:94`/`:105` say the module is never the
   discriminator. Reaffirm the split-decline on its **actual** grounds (coherence + "buys nothing"), and record
   that the file header's "out of it" and the ADR's "never the module" need reconciling — the header should say
   "do not move a family to a non-IPC layer", which is what its reason clause supports.
2. **Fix the drift-pin class** — the only real cost found. A meta-test enumerating every IPC error family and
   requiring a frozen-spelling pin per family, plus the two named-missing pins (`settings_error_kind_spellings_are_frozen`,
   which was declared required and never landed, and a `TasksError` pin reachable from this file).
3. **Report the `errors.rs` gap to ADR 0112** — it is missing from that ADR's superseded-threshold table, and its
   638-line region falls in the band its own table marks "not caught", so 0112 as written leaves this file free on
   both sides of a relocation.
4. **Correct the stale figures in the LIVING docs only — and explicitly NOT in `docs/reviews/`.** Correctable:
   `src-tauri/src/agent/errors.rs:19` (the "~128 places" claim, measured 83 non-test lines),
   `docs/features/improvement-boundary-residue-closeout.md:267` ("ten families" → twelve), and
   `docs/features/godfile-decomposition-closeout.md:113` — both are `status: live` with a `last-verified:` /
   `verified-by:` apparatus, which is precisely what a doc carries for being re-verified.
   **NOT correctable: deviation 1** (`docs/reviews/2026-11-07-codebase-improvement.md:352` and `:361-364`). Dated
   review docs are append-only records — that review says so of itself at `:57-61` ("a dated point-in-time record,
   deliberately **not** rewritten — the measurements are what was observed"), `docs/roadmap/permanent-sidebars.md:807`
   and `docs/roadmap/sidebar-view-tabs.md:447` both state "Do NOT back-edit … dated review docs are the record", and
   `git log --diff-filter=M --name-only -- docs/reviews/` shows exactly **one** modified review in the whole repo,
   whose 2-insertion diff was a broken ADR cross-reference, not a measurement. **This report's own deviation 1 is
   therefore a finding to be recorded in a living doc, not an edit to make.** (This paragraph was corrected after
   the first draft of this recommendation listed the review as a correction target; the grounding pass caught it.)
   The same applies to the 14 `errors.rs:<N>` prose citations noted in §4 — they are citations into a file that is
   not moving, so a reaffirmation must not disturb them.

This satisfies the card's done-when (*"either an ADR amends or reaffirms 0063 with the per-family question
answered, or the file is split with the envelope guarantee demonstrably intact — but not merely because it is
long"*) on the first branch, and it does so without splitting merely because the file is long.
