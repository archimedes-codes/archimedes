---
status: current
last-verified: 2026-11-16
verified-by: local code research at HEAD 74e38fa1 — 4 parallel researcher passes over src-tauri/src, src/, docs/decisions, docs/features, plus the published fulcrum-harness 0.3.2 sources read from the cargo registry cache; every load-bearing claim re-measured by the synthesising agent, and clean_title's behaviour measured by EXECUTING a verbatim Rust port (rustc -O) rather than by reading it; no test was executed and no mutation was compiled, so the "breaks 0 tests" table is high-confidence static inference
task: tsk_18e8a988-1993-4e90-97dc-5582f8fa4fa0
---

# The title rule is enforced on one door only — and the card's own fix list is measurably unworkable

## Executive Summary

The reported defect is real. It is **wider than reported** (two verbs, not one; two rules, not one),
**narrower in consequence than it looks** (blankness is unreadability, never misidentification), and
its fix is **not the shape the card proposes**.

Three findings drive everything below.

1. **The residue is exactly the title, and I can prove it rather than fail to find others.** Every
   other model-facing verb's command layer is a zero-statement delegation or a pre-flight that storage
   already owns. Two verbs carry the title rule (`create_task` AND `edit_task` — the card names only
   the first), and each carries **two distinct rules of different kinds**: a CLEAN (transform, then
   store the transformed value) and a REFUSE (reject when nothing survives).

2. **Both options the card lists are unworkable, and the legal shape is the one it omits.**
   `docs/features/task-board-known-gaps.md` §2 offers "lift the two checks to the `TaskStore` impl" or
   "make the router arm call them". Measured: the first cannot reach the cleaner without the one import
   edge this repo holds at **0**, and the second needs the `agent → commands` inversion that commit
   `24b8e06a` exists to have deleted, plus an error conversion that does not exist. The third option —
   a neutral crate-root module — is the only one with a **shipped precedent** (`types.rs` was created
   for precisely this reason) and it is absent from both the card and §2.

3. **`clean_title` is NOT idempotent, which kills the obvious cheap fix.** Measured by execution: the
   input `"  \" Foo \"  "` (whitespace-padded, quote-wrapped) cleans to `" Foo "` once and to `"Foo"`
   twice. So adding a clean at storage while the
   command layer keeps its own **silently changes what a human's card stores**. Any fix must REPLACE
   the command-layer clean, not add to it. One researcher reported the opposite; its report tested only
   fixed points, and it is wrong.

**Recommended shape** (chosen by the requester): hoist the cleaner to a neutral crate-root module, and
enforce there inside the inherent `Db::create_task` / `Db::edit_task` — the single path both doors
already pass through — REPLACING the command layer's own clean with a delegation. This is the same
shape `write_artifact` uses for the artifact rules: one rule, one owner, both doors.

---

## Findings

### F1 — Two doors, mapped

| verb | human door | seam arm (`impl TaskStore for Db`) | inherent method it calls |
|---|---|---|---|
| `list_board` | `get_board` `commands/tasks.rs:407` | `db.rs:3588` | `Db::list_tasks` `db.rs:2232` — **not** `Db::get_board` |
| `get_task` | `:446` | `db.rs:3610` | `Db::get_task` `db.rs:2246` |
| `create_task` | `:421` | `db.rs:3633` | `Db::create_task` `db.rs:2277` |
| `edit_task` | `:525` (+ core `:506`) | `db.rs:3644` | `Db::edit_task` `db.rs:2397` |
| `move_task` | `:568` | `db.rs:3667` | `Db::move_task` `db.rs:2458` |
| `get_artifact` | `:1122` (+ core `:1071`) | `db.rs:3681` | `Db::get_artifact` `db.rs:2874` |
| `write_artifact` | `:1092` (+ core `:1032`) | `db.rs:3699` | `Db::write_artifact` `db.rs:2811` |

`INSERT INTO tasks` has exactly **one** production site (`db.rs:2351`) and `UPDATE tasks SET title`
exactly one (`db.rs:2404`). **Storage is already the single path both doors pass through** — the exact
predicate the repo uses to justify moving a rule down.

### F2 — The residue is the title, on two verbs, as two rules of different kinds

| # | verb | rule | kind | human door | seam | reachable? |
|---|---|---|---|---|---|---|
| R1 | `create_task` | title cleaning; the CLEANED string is what is stored | **CLEAN** | `commands/tasks.rs:433` | `db.rs:3640` passes `title` verbatim | **reachable, unchecked** |
| R2 | `create_task` | refuse when nothing survives cleaning | **REFUSE** | `:116` → `EmptyTitle` | none | **reachable, unchecked** |
| R3 | `edit_task` | title cleaning on a `Set` patch | **CLEAN** | `:209` | `db.rs:3660` `title.map_or(Keep, Set)` — raw string | **reachable, unchecked** |
| R4 | `edit_task` | refuse when nothing survives | **REFUSE** | `:209` | none | **reachable, unchecked** |
| R5 | `edit_task` | "cannot clear `title`" | REFUSE | `:204-208` | **structurally unreachable** — `Option<&str>` + `map_or(Keep, Set)` | **unreachable** |

`tasks.title` is `TEXT NOT NULL` with **zero `CHECK` constraints in the whole file**. `TaskCall::EditTask
{ title: Some("") }` is a fully expressible `FieldPatch::Set("")`, which the `CASE` at `db.rs:2404`
writes as `''`. **The defect is not `create_task`-only**, which the card does not say.

The clean/refuse split is load-bearing, not taxonomic: the artifact rules were both pure REFUSALS, which
is exactly why they could move to storage unchanged. A CLEAN cannot move the same way.

### F3 — The title is the ONLY residue: proof by exhaustion, not by absence

For each other verb, what its command layer actually contributes:

- **`get_board` / `get_task` / `get_artifact`** — zero statements between parameters and the storage call.
- **`move_task`** — one pre-read (`from_stage` + `task_sessions`) that feeds `pick_compact_target`; it
  validates nothing and cannot refuse on a bad argument.
- **`write_artifact`** — two pre-flights (`:1103-1104`) now **byte-redundant** with the storage backstop
  (`db.rs:2820`, `:2825`), plus a `get_task` gate the storage existence check also covers.
- **`create_task`** minus `let title = require_title(&title)?;` is a pure delegation like the others.
- **`edit_task`**'s five non-delegation statements are: the `InvokeBody` match (structural), `task_id_from`,
  and three `patch_*` calls — of which `patch_title` IS R3/R4/R5.

Also verified as **not residue**: `body` has no length or whitespace rule on **either** door; `spec_path`
is validated as a path by **neither**; `task_id` shape is checked by **neither**; the artifact key grammar
is deliberately unchecked on the **read** path by both; `stage_slug`/`to_stage` are validated **at storage**
so both doors inherit it.

**Three asymmetries DO exist between the doors, and none is a validation gap:**

- **A1** `list_board` calls `Db::list_tasks` (no seed) while `get_board` calls `Db::get_board` (seeds five
  stages). Deliberate and pinned (`fulcrum_seams.rs:1320-1325`). The model's `list_board` says "the board
  is empty" over a Space that shows five columns the moment a human opens it.
- **A3** the `compact` boost fires only on the human drag; the seam hardcodes `note: None` (`db.rs:3677`).
  A model can move a card into a `compact` column and nothing compacts. ADR 0092's rule, not an oversight.
- **A4** the human door can `Clear` a field; the seam cannot (R5).

### F4 — The naive storage predicate has the WRONG refusal set (measured)

Executed a verbatim Rust port of `clean_title` (`rustc -O`, scratch, tree untouched):

Notation: every input below is shown **with its surrounding Rust quotes visible**, so that the empty
string and the two-character string made of two quote marks are not confusable. Row 3 is two quote
characters, not nothing — that distinction *is* the finding.

```
row  input (as Rust source)   trim().is_empty()?   clean_title().is_none()?
1    ""        (empty)        true                 true
2    "   "     (3 spaces)     true                 true
3    "\"\""    (two quotes)   FALSE                TRUE    ← naive predicate WRITES this card
4    "''"      (two apost.)   FALSE                TRUE    ← and this
5    "\""      (one quote)    false                false
6    " x "                    false                false
```

`commands/tasks/tests/board.rs:26-30` names rows 3 and 4 — `""` and `''` — **"the reachable ones"**; they
are the exact cases a
`slug.trim().is_empty()`-style guard (the `create_stage` precedent at `db.rs:2995`) lets through, producing
a card labelled with a bare quote pair. **So the tidy version of "refuse at storage" fails on the very
cases the existing test singles out.**

To match `require_title`'s refusal set, the storage predicate must *be* `clean_title`'s `None` arm. There
is no subset of it that is a simple predicate. And a refusal can never transform, so **refuse-only does
not fix the milder half at all** — `"  Foo   Bar  "` and `"thing"` stay stored exactly as sent.

### F5 — `clean_title` is NOT idempotent (this contradicts one researcher, who was wrong)

Same executed port, 13 inputs, 2 differ under a second application. Inputs are **Rust source literals**
(so `"\"thing\""` is the 9-character string holding a quote-wrapped word), outputs are the `Option` the
function returned:

```
input (Rust source)     once                twice               idempotent?
"  Foo   Bar  "         Some("Foo Bar")     Some("Foo Bar")     yes
"\"thing\""             Some("thing")       Some("thing")       yes
"\"a\" and \"b\""       unchanged           unchanged           yes
"\"\"x\"\""             unchanged           unchanged           yes
"  \" Foo \"  "         Some(" Foo ")       Some("Foo")         *** NO ***
"  ' spaced '  "         Some(" spaced ")    Some("spaced")      *** NO ***
```

The cause is documented and deliberate at `naming.rs:365-371`: the trim happens **before** the quote strip
because that is pi's chain order. **Consequence: if storage cleans while `commands/tasks.rs:433` keeps
cleaning, the human door cleans twice**, and a title typed as `  " Foo "  ` in `NewTaskDialog` changes from
` Foo ` to `Foo` — an unrequested behaviour change to the human path that no test would catch.

**Any fix must replace the command-layer clean, not add to it.** The rejected researcher report claimed
idempotency; its evidence was six inputs that are all fixed points, which is the failure mode this repo
already documents about vacuous fixtures.

### F6 — Both options the card names are blocked by measured import edges

| edge | measured | note |
|---|---|---|
| `storage/` → `crate::agent` | **0** | the one edge option (a) needs |
| `storage/` → `crate::commands` | **0** | |
| `agent/` → `crate::commands` | **0 production**, 1 test (`agent/session/tests/mod.rs:440`) | the edge option (c) needs |
| `agent/` → `crate::storage` | 22 | the allowed direction |
| `commands/` → `crate::storage` | 15 | the allowed direction |
| `From<TasksError> for TaskStoreError` | **0 impls** | option (c) needs it |

Control greps confirm the zeros are real (`crate::zzznonexistent` → 0; `crate::config` in `commands/` → 10,
so hits are detected).

**Option (c) — router arm calls the command checks — is the worst available.** `require_title` is **private**
(`commands/tasks.rs:115`), so it needs a widening *plus* the `agent → commands` inversion that review finding 8
in `docs/reviews/2026-10-04-codebase-improvement.md` named and `24b8e06a` removed; it needs an error
conversion with no precedent; it leaves storage — the actual shared path — unguarded; and it duplicates
rather than unifies, which is the direct opposite of the repo's own stated test.

### F7 — The legal shape has a shipped precedent the card and §2 both omit

`src-tauri/src/types.rs` docblock, verbatim:

> Crate-root shared types (ADR-agnostic value types that more than one layer needs — `storage` and `agent`
> both use `SessionInfo`, so it lives at the crate root rather than under either, **which is what keeps
> `storage` from importing `agent`**). … A future crate-root type that `storage` and `agent` BOTH need joins it

and commit `24b8e06a`'s message: *"config module … + crate-root types.rs — `agent->commands` and
`storage->agent` layer inversions fixed"*. **This repo has already answered this exact question once, with
exactly this shape.** `config.rs` carries the template for how such a module announces itself: *"this module
is a LEAF … no `commands` / `storage` imports"*.

`crate::types` is today a 4-line re-export of two DTOs whose doc says "type"; a `fn` there is a stretch, so
a new crate-root leaf module is the honest home. **Nothing forbids one** — no ADR, no test, and no census
pins `lib.rs`'s module list.

### F8 — The cleaner is self-contained; its blast radius is small and already scheduled

`clean_title` (`naming.rs:372`) is `str`-only. It never touches `SessionManager`, `EventSink`, `Db`,
`Settings` or `ModelCatalog`. Its dependencies:

| item | moves? |
|---|---|
| `strip_one_quote_layer` (`naming.rs:325`) | **yes** — private, `clean_title` is its only caller |
| `cap_chars` (`naming.rs:54`) | **yes, and this pays a named debt** — 7 other uses inside `naming.rs`, and `commands/attention.rs:31` already carries a **second copy**; `agent/mod.rs:122` says *"a third caller of THAT should hoist one shared helper"* |
| `TITLE_MAX_CHARS` (`naming.rs:45`) | **NO** — it is the session namer's *argument*, not the cleaner's dependency |

Consumers: **2 production** (`naming.rs:797` with `Some(TITLE_MAX_CHARS)`; `commands/tasks.rs:116` with `None`),
plus **2 re-export hops** (`agent/session/mod.rs:70`, `agent/mod.rs:123`) that become **dead** — and
`agent/mod.rs:116` says those hops exist for *"the ONE symbol `commands/tasks.rs` needs"*, so their comments
become false unless edited. 6 test fns inside `naming.rs` change their import list. `commands/tasks/tests/board.rs`
is untouched (it calls `require_title`, which stays).

### F9 — A fix breaks zero tests, but forces two exhaustive matches

- All **60 distinct literal titles** passed to `create_task` tree-wide: **0** would change under
  `clean_title`, **0** would be refused. So a clean-at-storage is a no-op on every existing fixture, and a
  refusal hits no existing test.
- `BoardError` has **12 variants**, **no `#[non_exhaustive]`**, and is matched exhaustively with **no catch-all
  arm** in exactly two places: `db.rs:339` (`From<BoardError> for TaskStoreError`) and `agent/errors.rs:772`
  (`From<BoardError> for TasksError`). A new variant is a **compile error in both** — a forcing function, and
  two files of real work a plan must budget.
- **No crate change, no publish, no pin bump.** The crate's `TaskStoreError::Invalid` already fits: its own doc
  says *"the call was well-formed JSON and still not admissible (a key outside the artifact grammar, a markdown
  over the command layer's size cap)"* — an empty title is that same shape.
- `fulcrum-harness` is a **registry** pin (`Cargo.toml:121` = `0.3.2`; `Cargo.lock` has a `registry+` source and
  checksum), so its sources are not in this checkout — read from the cargo registry cache. `.cargo/config.toml`
  is absent (only the `.example`), so a sibling checkout is not consumed.

### F10 — The suite structurally cannot see this bug

`run_task_call_creates_edits_and_moves_and_shapes_each_answer` is the test that looks like it covers the
model's title path. It uses `"second card"` and `"renamed"` — both already clean and non-empty — so it
**passes today with the bug present and would pass after any fix**. Same for
`the_task_store_surface_round_trips_through_a_real_db` (`"Wire the board"` / `"Renamed"`). **Zero tests
anywhere feed a blank or dirty title through either door.** This is why the defect survived, and it means a
new test is mandatory, not optional — and per the repo's mutation standard it must target the NEW asserts.

### F11 — Impact, ranked, and lower than the card implies

1. **The card has no subject.** `TaskCard.tsx:285` renders `{task.title}` in a `line-clamp-2` span. **No
   fallback anywhere in `src/`** — only 3 readers of the title exist (`TaskCard.tsx:285`,
   `TaskDetailDialog.tsx:391`, `taskPrompt.ts:156`) and `grep` for `title ||` / `title ??` finds no task
   one. The file's own comment at `:280-283` calls the title *"the one sentence a card exists to show"*.
2. **The launch block carries no prose at all.** `taskPrompt.ts:156` emits `title=""`, and with `body` null
   the element body is empty by design (`:186-188`), so the model receives a stage slug and a uuid and
   nothing human-readable. Note the engine never parses the attribute (0 hits in the crate), so this is
   lost signal, not an injection risk — `escapeAttr` already covers that.
3. **The detail modal's accessible name is `T{n}` alone** (`TaskDetailDialog.tsx:391`).
4. **The milder half** — uncleaned whitespace runs and un-stripped quotes stored on the model's door while
   the human's door cleans them.
5. ~8px dead gap where the title was (`flex flex-col gap-2`, `TaskCard.tsx:237`) — **inference from flexbox
   semantics, not measured**; jsdom performs no layout and the existing title test asserts class tokens.

**Explicitly NOT consequences** (each verified absent): no title-keyed lookup, no `WHERE title`, no
`ORDER BY title`, no by-title map in TS, no title in any `aria-label`, no search/filter on any task surface,
no `UNIQUE` constraint. The one title-keyed string (`store/taskLaunch.ts:564`) is an in-flight double-submit
guard that refuses `""` first. **Blankness is unreadability, never misidentification** — cards stay
distinguished by `T{n}` and `tsk_<uuid>`, which is ADR 0090 working as designed. This materially lowers the
sharp half's severity.

### F12 — The stale prose is SEVEN sites, not one paragraph

(Count as measured, and it moved twice: the draft said five, the table held six, and the plan's reviewer
found a seventh that this sweep's one-line greps could not see. If you re-count, re-grep — do not trust
this sentence either.)

| # | file | anchor | verdict |
|---|---|---|---|
| 1 | `docs/features/task-board-known-gaps.md` | §2 "Three second-order truths", item **2** | **half-false** — the artifact half is fixed; the title half is still true; the closing instruction *"do not describe the artifact key grammar as enforced"* is what will mislead the next reader |
| 2 | same | §2 item 2, *"Nothing in the tree pushes a bad key … every `TaskCall::WriteArtifact` in the tests uses `"spec"`"* | **false** — `router.rs:2150` uses `"My Spec"`, `:2169` an oversize markdown; `fulcrum_seams.rs:1420-1432` uses `a<b`, `spec"id`, `UPPER`, `""`, 41 chars |
| 3 | `docs/decisions/0100-…` | `## Consequences`, key bullet (`:62-63`) | **false** — *"storage/db.rs has no business owning it"* is the inverse of `db.rs:2704` *"THE ONE OWNER of the artifact key grammar"*. Written in the same squash commit (`2814d561`) whose own message says *"D2 fix: enforce key grammar + 256 KB cap in storage backstop (was bypassed)"* |
| 4 | `docs/decisions/0100-…` | `## Consequences`, cap bullet (`:68`) | **half-false** — *"capped at the command layer"*; storage owns the constant and the command imports it |
| 5 | `docs/decisions/0101-…` | `## Consequences`, first bullet (`:45`) | **false** — *"capped at 80"*; task titles are deliberately uncapped since `9b9bbe7b` (`clean_title(raw, None)`), pinned by `a_long_task_title_is_kept_whole_and_never_cut_at_the_session_namer_cap` |
| 6 | `src-tauri/src/storage/db.rs` | `Artifact` struct doc-comment (`:761`) | **false** — *"the grammar is validated in the command layer"*, contradicted by the same file 2,000 lines later. **A code comment, not a doc** — among the most damaging, because a reader hits the type before the method |
| 7 | `src/lib/tauri/types.ts` | `Artifact` interface, `key` field JSDoc (`:214-215`) | **false** — the same sentence mirrored into the hand-maintained TypeScript DTO ("*validated in the command layer (the `require_title` split) and never in the schema*"). **Found by the plan's reviewer, not by this sweep** — the sentence **wraps across two lines**, so the contiguous one-line grep this report used could not see it. Correcting site 6 while missing 7 leaves the frontend reader with the same false belief |

Also noted, already durably discharged elsewhere: ADR 0098's and ADR 0099's *"the board has no model-facing
tools"* claims are false since #180 but are already pointed at §2 by `task-board-known-gaps.md:20-22`.
ADR 0092's `read`/`subagent` substring-ban bullet is separately stale (replaced by enumerated names in
`worker_e2e.rs:758-766`) — unrelated to this task, worth its own amendment.

**Amendment convention (measured).** `docs/decisions/` is **append-only — never edit a merged decision's
body**, stated in ADRs 0033, 0093 and 0036. So items 3-5 take an appended `## Amendment (date) — …`, body
untouched. ADR 0090's existing amendment is the exact template for this case (a claim falsified by the
implementation the ADR mandated). **`superseded-by:` stays EMPTY on ADR 0100** — the decision (`task_artifacts`
as rows) is untouched; only two Consequences bullets about layer ownership fell. That is the ADR 0036 case,
not the 0056→0057 case. `docs/features/` §-amendments use dated bold paragraphs with the original text kept
(§5's *"this reverses the amendment directly above"* is the strongest example).

**No test can validate any of this.** Exactly one test reads `docs/` — `src/lib/subagentSheetLayout.test.ts`,
and it reads `docs/features/subagent-sessions.md`, not this file, and reads the body not the front-matter.
The instrument is grep, which the doc itself already says twice.

### F13 — Timing: the seam has a scheduled funeral

ADR 0102 (**accepted**) deletes `TaskStore`, `TaskCall`, `TaskStoreError`, `IpcTaskStore` and `task_tools.rs`
(1,191 lines), replacing them with a vocabulary-free `HostToolCall`. `docs/roadmap/tool-separation.md` is
`status: approved` (issue #183), engine work not started. The ADR's own words on widening the seam: it
*"would cost a hand-run `cargo publish` … to buy a wire shape with a scheduled funeral."*

This cuts **both** ways and is the one genuinely open judgement in this report:

- **For acting now:** the blank-card window stays open while #183 is unstarted, and `Db::create_task`'s SQL
  survives either future — so enforcement placed *there* is durable across the migration.
- **Against acting now:** ADR 0102 moves executors **desktop-side**, which arguably restores one door and
  makes the D2 seam the historical anomaly, putting the rule back beside the command layer.

**The recommendation resolves this deliberately:** put the enforcement in the inherent `Db::create_task` /
`Db::edit_task` (survives both futures) behind a neutral module (survives trivially), and put **nothing** in
`run_task_call`'s arms or keyed to `TaskCall`'s shape (does not survive).

---

## Recommended shape

**A neutral crate-root leaf module owning the cleaner, enforced inside the inherent `Db::create_task` and
`Db::edit_task`, REPLACING the command layer's own clean.**

1. New crate-root leaf module (the `config.rs` LEAF-docblock template) holding `clean_title` +
   `strip_one_quote_layer` + `cap_chars`; hoist `commands/attention.rs:31`'s duplicate copy at the same time
   (a debt the repo scheduled by name). `TITLE_MAX_CHARS` stays in `naming.rs`.
2. Delete the two now-dead `pub(crate) use` hops and rewrite their comments, whose stated justification
   ("the ONE symbol `commands/tasks.rs` needs") disappears.
3. `Db::create_task` / `Db::edit_task` clean-and-refuse via that module before the lock, so a rejection
   writes nothing on every door — the `write_artifact` shape, and the `create_stage` "last writer" precedent.
4. New `BoardError` variant whose `Display` is byte-identical to `TasksError::EmptyTitle`, mapped
   variant-to-variant in `agent/errors.rs:772` (preserving `kind() == "empty_title"`) and to
   `TaskStoreError::Invalid` in `db.rs:339`. Both matches are exhaustive, so the compiler finds both.
5. `commands/tasks.rs` keeps `require_title` as a thin pre-flight for the nicer wire envelope, but must not
   double-clean (F5) — the clean must happen once. This is the subtle part of the change.

Why this and not the alternatives: it is the only option with a shipped precedent (F7); it satisfies the
repo's own stated test — *"a rule with two doors belongs on the single path both doors pass through"*; it
needs no crate publish (F9); it breaks no test (F9); and it survives ADR 0102 (F13).

**The one sentence it must argue with** is `db.rs:2712` *"the cleaning is genuinely a wire concern"*. The
available argument is that the same docblock's own licence — *"pure data validation on the row about to be
written, which is exactly what a storage layer may own"* — plus `create_stage`'s *"enforced HERE too because
this is the last writer"*, already establish storage as the enforcement point; and that a naive subset
predicate has the wrong refusal set (F4), so the choice is not "predicate vs cleaner" but "cleaner, or a
third copy of the chain".

---

## Unresolved Contradictions

1. **Idempotency — RESOLVED by execution.** One researcher reported `clean_title` idempotent and used that
   to argue cleaning at both doors was safe. Measured false on 2 of 13 inputs (F5). Its evidence was six
   fixed points. This matters because that claim, if believed, produces a fix that silently changes what a
   human's card stores.
2. **Move now vs. wait for #183 — UNRESOLVED, and it is a decision not a finding.** F13 gives both sides.
   The recommended shape is chosen so the answer does not force a rework either way.

---

## Gaps

- **Frequency is unmeasured, and severity depends on it.** No telemetry and no observed instance of a model
  actually sending a blank title. The bug is reachable-by-construction (F2, F4) — whether it *occurs* is
  unknown. Every existing seam test uses a clean title, so the tree contains no evidence either way.
- **Nothing executed.** No test was run and no mutation was compiled; `cargo test -- --list` was used for
  enumeration only. The "breaks 0 tests" table (F9) is a reading of assertions, not measurement. Before
  trusting it, run the suite once at the real HEAD.
- **`docs/roadmap/task-artifacts.md` carries the same wrong claim** (`:174`, `:319`) but is untracked,
  gitignored and deleted on ship — **not amendable, and must not be cited as a source.**
- **`AGENTS.md`'s YAML bullet** claims all `docs/features/` front-matter fails strict YAML. Measured: **18 of
  27 parse**, and `task-board-known-gaps.md` is one that does. Its file counts have drifted (written at 24
  files / 15 parse). Not this task's, but a reader who trusts it will mis-diagnose their own edit.
- The stale `fulcrum-harness = "0.2.0"` reference in `db.rs:3652`'s comment (actual pin `0.3.2`) is prose-only
  but sits in the exact comment an implementer reads before deciding what the seam can express.
