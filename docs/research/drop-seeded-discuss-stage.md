---
status: current
last-verified: 2026-11-11
verified-by: code research — 3 researcher angles (Rust seed + gate, TS launch surfaces + tests, docs/ADRs/glossary + alternatives) run read-only at `ee45e6a6` on `feature/attention-alert-click-to-navigate`, plus inline verification of every claim the three disagreed on or that contradicted the card. Rust test counts are **grep-derived, not compiler-derived** — `target/` is 152G with 13G free on `/home`, so no `cargo` run was possible and nothing Rust here is run-verified. TS test NAMES are `npx vitest list`-derived (the required instrument); the FAIL/pass verdicts are read from source and were **not executed**.
task: tsk_14419c6c-7e83-4955-a4c4-5c5282e23626
---

# Drop the seeded `discuss` Stage — the skill merge is a board migration, not a docs edit

**Settled question:** what exactly breaks, and what is the right fix, when the `discuss` Skill is deleted from disk and merged into `research` as Path A/Path B — given ADR 0098 made a **Stage** row the sole authority for what a launch loads?

**Routing:** the design was walked through in-session (Path B) after this evidence pass (Path A) and approved section by section. The approved design is §Design below; `specify` is the writer of the spec and plan.

## Executive Summary

1. **The card's direction survives and its blast radius is roughly right — but three of its specific claims are false**, one of which would have left a Rust test broken with no hint why, and one of which over-states the TypeScript breakage by ~14 cases.
2. **The card understates its own premise.** It says a new Space gets a button that cannot work. The larger live defect: on every **fresh** Space the **Backlog column currently renders no launch pill at all, silently** — and that is caused by this same deletion. It is repaired as a side effect of the five-stage seed, and by no smaller change.
3. **The alternative (repoint `discuss` → `research`) is refuted by the merged skill's own text, not by app code.** Nothing in Rust or TypeScript forbids `slug ≠ onEnterSkill` — repointing would work mechanically. But `research/SKILL.md` says *"Both signals present → A first, then B"* while `db.rs:3178` says *"discuss sits BEFORE research (discuss it, then research it)"*: the seeded order is now **backwards** relative to the skill it would load, and the column label becomes a permanent lie.
4. **ADR 0104's real subject is a gap in 0098, not a value in it.** 0098 contemplated only *"A Space **without** the `discuss` skill installed"* — a fresh-install state. It never contemplated a Skill **disappearing from every catalog**. Its justification for hardcoding skill names — *"a one-time migration that ages out, not a live switch that keeps asserting"* — is **falsified by this change**: a migration that writes a deleted skill's name is a live assertion and does not age out.
5. **Chosen fix: five-stage seed** (`backlog / research / approved / doing / done`), `NewTaskDialog` down to two buttons, the `discuss` statements **deleted** from the `on_enter_skill` gate so it cannot invent a dead column on a pre-#179 upgrade, legacy `discuss` columns **deliberately not migrated**, and ADR 0104 written as a **partial supersession** of 0098 via its front-matter.

## Findings

### 1. Card claims that are FALSE at HEAD

| Card says | Reality | Evidence |
|---|---|---|
| `missingSkill` refuses with `` This Space has no `discuss` skill to load. `` | **Templated on the skill name**, not a `discuss` literal. It only *prints* `discuss` because `NewTaskDialog.tsx:136` hardcodes `onEnterSkill: "discuss"`. | `src/store/taskLaunch.ts:246`: `` return known ? null : new Error(`This Space has no \`${skill}\` skill to load.`); `` — read directly |
| `set_stage_next_persists_the_edges_and_round_trips_them` will break | **The card is right; the Rust researcher who "corrected" it was wrong.** `set_stage_next` validates **every** destination slug against the table and returns `missing_stage` otherwise, so `["discuss","research"]` on a 5-stage seed returns `Err` and the test's `.expect` panics. | `src-tauri/src/storage/db.rs:2897-2900` (`if !stage_slug_exists(&guard, space_path, wanted)? { return Err(missing_stage(…)) }`), test body at `db/tests/mod.rs:6081` |
| `taskLaunch.test.ts`'s ~13 discuss cases break | **They do not break.** `launchTaskSession` takes the catalog as an **injected argument**; `listSkills` appears **zero times** in the file and `CATALOGS()` hand-builds `skills: [skill("discuss"), skill("research")]`. Deleting a skill on disk cannot reach them. | `src/store/taskLaunch.test.ts:176-179`, `:64` (`getBoard: vi.fn()`), `grep -c listSkills` → **0** |
| Two Rust test names | Both truncated. Actual: `delete_stage_refuses_a_stage_that_holds_cards_and_names_the_count_and_the_slugs`, `create_stage_inserts_at_the_end_and_refuses_a_taken_slug_naming_the_valid_ones`. The other 16 names on the card exist verbatim. | `db/tests/mod.rs:6275`, `:5942` |

### 2. The live defect the card does not know about: fresh Spaces lost the Backlog pill

Not a stale button — a **missing affordance with no explanation**, already in effect on every new Space.

The seed leaves `next_slugs` NULL by design (ADR 0099: *"a seeded graph stays NULL = unconfigured"*), so `nextStepOf` falls back to the Stage at `sort_order + 1`:

```ts
// src/components/TasksBoard.tsx:207-212
const slugs =
  column.stage.nextSlugs ??
  (columns ?? []).filter((c) => c.stage.sortOrder === column.stage.sortOrder + 1).map(…);
```

On a seeded board `backlog` is index 0, so its Next step is **`discuss`** → `onEnterSkill: "discuss"` → absent from the catalog → `launchReady: false` (`TasksBoard.tsx:240-242`) → and `TaskCard.tsx:440` renders **nothing**:

```tsx
{launchStep !== undefined && launchStep.launchReady && ( … )}
```

The silence is deliberate and documented — *"the card paints NOTHING in that frame rather than a disabled pill, because a greyed control on every card during a fetch is the loud-on-quiet-surface pass this file's own chips avoid"* (`TaskCard.tsx:425-430`). The gate was written for an async-fetch race; a permanently-absent skill makes that frame permanent. **So today a card in a fresh Space's first column offers no launch and says nothing about it.** Deleting the `discuss` entry repairs this (`backlog` index 0 → `research` index 1); repointing repairs it too, but the pill reads *Discuss* while loading `research`; the button-only minimal diff **leaves the defect live** — it is the one option that does.

### 3. Rust: the removal is mechanically clean

- **`DEFAULT_STAGES` has exactly one production reader** — the `iter().enumerate()` seed loop at `db.rs:3166`. Nothing indexes it positionally or assumes length 6. Dropping to 5 yields `sort_order` 0–4 with no other code touched.
- **The gate stays coherent** with its `discuss` statements removed: `gate()`'s latch is `SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2` (`db.rs:829`; the `gate()` fn signature is at `:823`) and it commits only if every statement returns `Ok`, so ALTER + the one surviving `'research'` UPDATE still runs exactly once and stays crash-idempotent.
- **`next_slugs` needs nothing.** The seed writes it nowhere; no production code names `discuss` as a transition target. Every edge in the tree is test-authored (`db/tests/mod.rs:6087`, `:6103`, `commands/tasks/tests/stages.rs:184`).
- **No migration mechanism exists**: `user_version` / `schema_version` / `MIGRATION_VERSION` / migrations table → **zero hits** across `src-tauri/` and `src/`. The only production `PRAGMA` is `foreign_keys` (`db.rs:836`).
- **No Rust code asserts `on_enter_skill == slug`.** Rust stores the value uninterpreted; the only consumer of the name is TypeScript.

### 4. Frontend: one file breaks, four stay green legitimately, two stay green wrongly

**Breaks — `NewTaskDialog.test.tsx` only.** 9 discuss-named runnable tests (`npx vitest list`, verbatim below) plus four `for (const name of ["Backlog","Discuss","Research"] as const)` loops at `:277`, `:417`, `:526`, `:606`. **All hard-fail**: `button()` is `screen.getByRole`, which throws on a miss, and there is **no length or count assertion anywhere in the file**. The frontend researcher's prediction that three loops go "vacuous-green" is **inverted** — nothing degrades silently here, so the risk was under-estimating the red.

```
NewTaskDialog — Discuss and Research > Discuss creates the card, then starts a linked session
NewTaskDialog — Discuss and Research > Discuss loads the discuss skill and appends the task block
NewTaskDialog — Discuss and Research > Research files the card in the research column AND loads the research skill
NewTaskDialog — Discuss and Research > passes the same two fields for all three buttons
NewTaskDialog — Discuss and Research > leaves the board view when it launches a session
NewTaskDialog — Discuss and Research > Backlog reports NO session id, so the board stays put
NewTaskDialog — Discuss and Research > stays open with its error when the launch fails after the create
NewTaskDialog — Discuss and Research > disables each button whose skill the catalog does not have
NewTaskDialog — Discuss and Research > disables all three with no Space, rather than creating a card nowhere
```

Runtime counts (`npx vitest list`, not `it(` grep): `NewTaskDialog.test.tsx` **9**, `taskLaunch.test.ts` **13**, `TaskDetailDialog.test.tsx` **1**.

**Stays green, legitimately** (user-data class — a Space may have a hand-made `discuss` column with any skill): `taskLaunch.test.ts` (catalog injected), `TaskDetailDialog.test.tsx`, `TasksBoard.test.tsx`, `StageEditor.test.tsx` (all three mock `listSkills`).

**Stays green, wrongly** — the silent-green set, and *not* where the card looked:

- **`taskPrompt.test.ts`** — the default `destination()` fixture is documented as *"the SEEDED `discuss` stage — the sixth entry of Rust's `DEFAULT_STAGES`"* (`:38-41`). That sentence asserts a **seed fact** and becomes false. The assertions at `:274` (`not.toContain("$discuss")`) and `:308` (`message.indexOf("$discuss")`) **pass forever regardless**, because `"$discuss"` is a string literal the fixtures concatenate. The file keeps pinning a `$discuss`-before-`<task` ordering for a launch that can no longer be produced. The card files this under *"stale, not broken"* — it is the one file that will keep passing while asserting nothing.
- **`StageEditor.test.tsx:482,492`** — mock-injects `skill("discuss")` and asserts `getByRole("option", {name:"discuss"})`: passes indefinitely, testing a catalog entry that no longer exists.

**Discriminator for the implementer** (decides ~5 files): *does this fixture assert what the **SEED** contains, or what a **USER** could have made?* Seed claims get corrected; user-data claims stay.

**No orphaned imports.** `SAVE_ONLY` and `TaskLaunchDestination` are both still referenced by the two surviving `BUTTONS` entries and by `submit`/`disabledFor`, so removing the entry is build-clean under `noUnusedLocals` — verified symbol by symbol. The build risk lives in **test** edits, not the component.

**`TaskDetailDialog.tsx` needs no code change** — verified it derives its buttons from the Stage graph per ADR 0099 (`edges` → `edges.map(…)` at `:477-540`); there is no hardcoded Discuss/`research` button literal. `:37` and `:70` are stale prose only. The card's "only `NewTaskDialog` hardcodes buttons" is **confirmed**.

### 5. A mis-attributed deadlock comment — a correctness-of-explanation defect

`src/store/taskLaunch.ts:430-445` justifies **never awaiting** the first turn (`void sendLaunchMessage(…)` at `:393`) by naming `discuss`:

> `discuss`'s whole shape is to end a turn on an `ask` gate, and `ask_flow` blocks on a oneshot with NO timeout (`harness/ask.rs`) … that gate renders through `AskQuestionCard`, which is mounted ONLY by `MessageList` under `ChatStream` … and `App`'s view ternary renders the board INSTEAD of `ChatStream` … A Discuss click produced a Session, …

`research` **inherits that shape exactly**: Path A Phase 0 asks *before dispatching anything*, Phase 4 is a REQUIRED hard stop, Path B is an `ask` chain at B3/B4/B5. The code is correct; **the one sentence explaining a deadlock-safe design now names a skill that does not exist.** Re-aim it at `research` in this PR.

### 6. ADR 0104 — numbering, the real convention, and 0098's gap

**Numbering verified:** `ls docs/decisions/ | grep -oE '^[0-9]{4}' | sort | uniq -d` → **`0086` only** (two files, both tracked). 0100 and 0103 **tracked** at HEAD; **0101/0102 untracked** (tasks #12/#13). **0104 is free.**

**The convention is not a body edit and not a "Superseded by" heading.** It is two moves, quoted from live examples:

```yaml
# the ONLY sanctioned edit to 0098 — a front-matter edit (docs/decisions/0031:1-5 is the template)
---
status: accepted
date: 2026-11-10
superseded-by: 0104-<slug>.md
---
```

and the new ADR opens with 0032's / 0020's shape: *"**Supersedes ADR 0098 PARTIALLY.** Only … changes — … all STAND untouched."* ADR 0022 codifies the rest: *"ADR numbers are append-only: the gaps in the numbering are the record."* The **amendment** route exists too (0036: *"which is why `superseded-by:` stays EMPTY and no new ADR is written for it"*) but is wrong here — 0036's own framing is correcting a decision's *own statements*, and retiring a seeded slug is a reversal.

**0098's gap is conceptual, not a stale value.** Its Consequence reads: *"**The seed grows a sixth entry, `discuss`.**"* and *"The backfill hardcodes two skill names in Rust. Accepted as the smaller evil: **it is a one-time migration that ages out, not a live switch that keeps asserting.** A Space **without** the `discuss` skill installed gets a Discuss Stage whose button `missingSkill` refuses…"* — it considered only a Space that *never had* the Skill. No ADR anywhere records that a Skill can be **deleted** from the external user-owned catalog (ADR 0013's roots) and thereby break every Stage row naming it. **That is 0104's subject**, with this case as its worked example.

What falls: 0098's *"the seed grows a sixth entry"* Consequence and the two-Skill backfill. What stands: the Stage row is the ONE authority; the constant map stays deleted.

### 7. The no-migration stance — fact vs policy

The card's claim is **true as fact**: every one-time migration is a `gate()` on a missing COLUMN; there is no `user_version` and no migrations table. Its **corollary is policy, not fact** — and the honest framing for 0104 is that a `DELETE FROM stages WHERE slug='discuss'` would be the repo's **first data-only gate**, with no schema hole to justify it, requiring a latch mechanism that does not exist.

- **Strongest precedent FOR:** this very `discuss` INSERT — the repo has already shipped a data step that writes board rows for every Space, accepting hardcoded skill names "as the smaller evil". A DELETE is its mirror image.
- **Strongest precedent AGAINST:** `db.rs:483-490` — *"removing a legal value from a stored union is a migration for no gain"* — plus `cost_usd` (`db.rs:984-999`), `is_subagent` (*"ADR 0025 §6: no data migration"*), and the deliberately-unbackfilled `next_slugs` / `board_strict` bare ALTERs (*"Backfilling it would have given every existing board a graph it never asked for"*).
- **Decisive:** a delete-migration would not age out either — it would re-run on any DB that still holds the row, which is the exact defect being fixed.

Runtime facts that make leaving legacy columns acceptable: dragging into one is **completely silent** (`useDragCard.ts:214-236` → `move_task`; neither consults the catalog — pinned by `TasksBoard.test.tsx:418` *"a card dropped in another column starts NO Session"*); the card pill paints nothing; the detail-dialog and New-Task buttons disable with a tooltip; and `delete_stage` refuses on cards-held / referenced-as-`next_slugs` / last-stage, so a column containing cards is not one careless click from deletion.

### 8. Alternatives, as facts

| Option | Mechanically viable? | Refuting evidence |
|---|---|---|
| **Delete — five-stage seed** *(chosen)* | Yes: 1 reader, coherent gate | ~10 doc sites flip six→five; `docs/features/task-board-known-gaps.md` gets amended in the **opposite** direction from its existing *"Amended 2026-11-11 — the seed is SIX, not five"* block |
| **Repoint** `on_enter_skill → "research"` | Yes — **zero** equality checks between `slug` and `onEnterSkill` in `src/`; `missingSkill` keys only on the skill, `resolveStage` only on the slug | `research/SKILL.md` *"Both signals present → A first, then B"* vs `db.rs:3178` *"discuss sits BEFORE research"* — the seeded order is backwards; two columns load one skill; the label becomes a permanent lie |
| **Button only** (minimal diff) | Yes | **This is today's state.** New Spaces still get a `discuss` column at index 1, so Backlog's Next step is still `discuss` and Backlog cards still render **no pill**. The only option that leaves the live defect live |
| **Repoint + relabel `Design`** | Yes, keeping slug `discuss` | slug `discuss` + label `Design` + skill `research` = three names for one column — the conflation CONTEXT.md's *Avoid* lists exist to prevent; order still backwards |

**No option keeps all current prose true.**

### 9. Docs inventory

**Becomes false (durable, must be edited):** `CONTEXT.md:332` (Stage entry — the seeded slug list *and* *"the seeded `discuss` and `research` Stages carry those Skills"*) and `:335` (Stage transition — *"`backlog` may lead to both `discuss` and `research`"*). Both are **committed** text: the other session's `git diff` is a `+9`-line append at EOF (Engine tool / Host tool / Seam), so the collision tripwire is narrower than the card feared. `docs/features/task-board-known-gaps.md` at `:169`, `:176`, `:224-227`, `:233`.

**Roadmap (gitignored, untracked — edited in-tree, never force-added):** `docs/roadmap/task-board-stage-config.md` (`:4` `done-when`, `:71-77`, `:87-89`, `:95-96`, `:339-340`), `docs/roadmap/task-artifacts.md` (`:54`, `:115`). Verified untracked via `git ls-files --error-unmatch`.

**Historical narrative — do NOT touch:** `docs/decisions/0090:25`, `0098` body, `0099:16` (its `backlog → discuss` / `discuss → research` worked example remains a valid illustration of graph-vs-order), `0029:21`, and the ordinary-English hits in `0057`, `0080`, `docs/reviews/*`. README has **zero** hits.

**Unrelated word-use in `src/`:** `cssSource.ts:69`, `themeTokens.test.ts`, `paletteCompleteness.test.ts`, `subagentSheetLayout.test.ts`, `fileIconContrast.test.ts` — all the English "discussed". `toolOutput.test.ts:436-441` uses `discuss` as a throwaway skill-name string in a summariser test. No `.snap` files, no TS-side `DEFAULT_STAGES` mirror, no E2E reference.

## Design (approved in-session, 2026-11-11)

**1 — Rust.** `DEFAULT_STAGES` → `[(&str, &str, Option<&str>); 5]`, `discuss` entry removed. Rewrite three doc comments, don't trim them: `db.rs:3176` *"six"*, `:3178` *"discuss sits BEFORE research"*, `:3160` *"The six defaults"*. **Keep** the `approved`-stays rationale (*"deleting a column is the editor's job, not the seed's"*) — it becomes load-bearing twice, as the argument for not migrating legacy columns too. Gate (`:1068`): keep `ALTER` + the `'research'` UPDATE; **delete** the `'discuss'` UPDATE, the `SELECT DISTINCT … slug='discuss'` probe, the `sort_order` shift and the `INSERT`, so a pre-#179 upgrade gets the same board a fresh Space gets. Its doc comment (`:1058-1067`) must be **replaced, not trimmed** — it currently argues the opposite (*"a board with no `discuss` column is exactly the silent-green shape ADR 0098's Consequence warns about"*), and post-change that describes the shape we **want**; a surviving fragment reads as an instruction to restore the INSERT. `next_slugs`: nothing.

**2 — Frontend.** Remove the `Discuss` entry from `BUTTONS`. Keep "hardcoded deliberately" — it argues against deriving one button per loaded Stage and was never conditional on the count. Rewrite `:21`, `:30`, `:42` heading, `:112`/`:114`, and `DialogDescription` `:220`. `TaskDetailDialog.tsx`: prose only. **Re-aim the `taskLaunch.ts:430-445` deadlock comment at `research` in this PR** (plus `:14` "three buttons", `:181`'s `stageOfMode` history), and move `taskPrompt.ts:50`'s ordering-pin citation to whichever test becomes it.

**3 — Tests.** Rust: ~17 names break on one mechanism (exact length/slug-set asserts); three lose their premise entirely and are **deleted** — `five_stage_database_gains_discuss_before_research_and_both_skills_on_open`, `a_space_that_already_has_a_discuss_row_is_left_alone_by_the_backfill`, `a_space_with_a_hand_renamed_research_slug_gains_no_discuss_row`. TS: `NewTaskDialog.test.tsx` only, and its three titles naming "three" are mandatory renames. Apply the **seed-claim vs user-data** discriminator to fixtures. `taskPrompt.test.ts` must be edited even though nothing fails there.

**4 — ADR + docs.** `docs/decisions/0104-<slug>.md`: general rule as the Decision (the catalog is external and can shrink; deleting a Skill breaks every Stage row naming it), this case as the worked example, the no-migration stance stated as **policy with its runtime justification**, and 0098's falsified "ages out" claim said plainly. `superseded-by:` filled on 0098's front-matter; 0104 opens with the PARTIALLY-supersedes sentence. Doc sweep: CONTEXT.md ×2, known-gaps ×4 (the `:224-227` block is a **second** amendment in the opposite direction and should say so), the two gitignored roadmap files edited in-tree and **not force-added**. Branch off `main`; if `CONTEXT.md`'s `discuss` lines or ADRs 0101/0102 change mid-work, that is the other session — stop.

## Evidence

| Source | What it settles | Credibility |
|---|---|---|
| `src/store/taskLaunch.ts:240-249` | The refusal string is templated, not a `discuss` literal | Primary — read directly |
| `src-tauri/src/storage/db.rs:2879-2910` | `set_stage_next` validates every destination slug → the round-trip test **does** break | Primary — read directly |
| `src-tauri/src/storage/db.rs:790-843` | `gate()`'s `pragma_table_info` latch + all-or-nothing commit → removal stays coherent | Primary |
| `src-tauri/src/storage/db.rs:3150-3190` | `DEFAULT_STAGES`'s single `iter().enumerate()` reader; `next_slugs` unseeded | Primary |
| `src/components/TasksBoard.tsx:196-245`, `TaskCard.tsx:425-440` | The Backlog-pill mechanism and its deliberate silence | Primary |
| `src/store/taskLaunch.test.ts:64,170-235,391-405` | Catalog is injected; `listSkills` count 0 → those 13 tests cannot break | Primary |
| `src/lib/taskPrompt.test.ts:30-55,274,308` | The false seed-fact comment; assertions on plain string literals | Primary |
| `npx vitest list` on the three TS files | Runtime test names (9 / 13 / 1) | Compiler-equivalent instrument for TS |
| `docs/decisions/0031:1-5`, `0032:11`, `0020:11`, `0036:38-40`, `0022:27` | The real supersede vs amend convention | Primary |
| `docs/decisions/0098` Consequences | 0098's gap and the falsified "ages out" claim | Primary |
| `~/.agents/skills/research/SKILL.md` "Which path?" + commit `38341e7` | Path A/B are chosen on what's missing; "A first, then B" refutes repointing | Primary (external) |
| `git ls-files` / `git diff` / `uniq -d` on `docs/` | 0104 free; 0086 sole collision; roadmap files untracked | Primary |

## Unresolved contradictions

1. **`set_stage_next_persists_the_edges_and_round_trips_them`** — the Rust researcher claimed it survives because its `["discuss","research"]` is "a fixture the test round-trips through itself". **Resolved against the researcher:** production `set_stage_next` calls `stage_slug_exists` for every `wanted` slug, so on a 5-stage seed it returns `Err` and the test's `.expect("set_stage_next")` panics. The card was right.
2. **Vacuous vs hard-failing loops** — the TS researcher claimed three `for…of` loops go silently green. **Resolved against the researcher:** `button()` is `getByRole`, which throws; there is no count assertion in the file; all four loops fail.
3. **`taskLaunch.test.ts` breakage** — the card listed ~13 failures, the TS researcher confirmed them *and* labelled them a "wrong-reason red". **Resolved against both:** the catalog is an injected argument, `listSkills` is never imported, so none of them can fail.

## Gaps

- **No compiler-derived Rust test counts and no Rust run.** `target/` is 152G with 13G free on `/home`; `cargo test -- --list` was forbidden. Per AGENTS.md a grep count disagrees with the compiler in both directions, so the ~17-name Rust list is a **name-verified floor, not a run-verified spec**. The implementer must re-derive it at its own HEAD.
- **No test execution at all.** Every FAIL/pass verdict is read from source. `npx vitest list` collects names; it does not run them.
- **The un-named `Discuss` clicks in `TaskDetailDialog.test.tsx`** (`:459`, `:474`, `:496`, `:508`, `:519`, `:539-546`, `:644`, `:655`, `:669`) were not individually adjudicated — they are fixture-driven, so their fate depends on whether the implementer touches `BOARDS`/`listSkills`.
- **`docs/decisions/0029:21`** cites `discuss → adr-format.md, context-format.md`; those bundles now ship under `research`. Not audited — out of this card's scope, worth a look if anyone re-reads 0029.
- **The exact `discuss/SKILL.md` → `research/SKILL.md` content mapping** was not diffed (`git show 38341e7^:discuss/SKILL.md` not read). Only needed if someone wants to prove Path B fully absorbed the old `discuss` flow.

## Corrections since publication (2026-11-11, from the plan's two reviewer rounds)

Two `reviewer` rounds against the plan written from this report found things this report missed. They are
recorded here because a later reader who trusts §Findings as complete would repeat the misses. All were
verified against the tree by the report's author, not accepted on the reviewer's word — and two of the
reviewer's own citations did not survive that check (see the last bullet).

- **A missed breaking test.** `reorder_stages_is_a_silent_no_op_on_an_unknown_slug`
  (`src-tauri/src/storage/db/tests/mod.rs:6236`) asserts an untouched-list loop
  `[("discuss", 1), ("research", 2), ("approved", 3), ("doing", 4)]` at `:6256-6260`; `named("discuss")` is
  `None` after the change. Angle 1 listed it; this report dropped it from its own list. That is the
  report's failure, not the researcher's.
- **A second length assertion inside an already-listed test.**
  `create_stage_inserts_at_the_end_and_refuses_a_taken_slug_naming_the_valid_ones` (`:5942`) asserts
  `sort_order == 6` at `:5956` **and** `list_stages().len() == 7` at `:5981-5985`. The `7` is invisible to
  any grep keyed on `len() == 6` / `sort_order == 6`, which is the instrument this report itself prescribed —
  so the prescribed instrument could not find its own gap. Several of these tests assert a count twice with
  different values.
- **Prose-only stage counts in four files no angle opened.** `.expect("get_board seeds the six stages")`
  and equivalents live in `src-tauri/tests/fulcrum_seams.rs:1192`/`:1383`,
  `src-tauri/tests/worker_e2e.rs:2560`, `src-tauri/src/agent/session/router.rs:1671` (inside
  `#[cfg(test)] mod tests` at `:894`), plus `.expect("seed the six")` at
  `commands/tasks/tests/stages.rs:72`/`:119` and `db/tests/mod.rs:5260`/`:5946`. None fails at runtime —
  they are message strings — but each is a false claim about the seed, which is the exact defect ADR 0104
  records. Angle 1's grep was scoped to three files and so could not see them.
- **Two more production doc comments assert the six-stage seed:** `db.rs:1911` (`get_board`) and
  `commands/tasks.rs:276`. Distinct from the `commands/tasks.rs:12`/`:665` and `lib.rs:644`/`:665` hits,
  which count the **six Stage verbs** (`create_stage` / `rename_stage` / `set_stage_skill` /
  `set_stage_next` / `reorder_stages` / `delete_stage`) and stay true whatever the seed holds — editing
  those would be a false fix.
- **The fixture the replacement gate test must use is `SCHEMA_PRE_TASK_BOARD_CONFIG`** (`:5656`) with
  `pre_task_board_rows` (`:5665`) and `preexisting_db` (`:2794`) — the construction the three
  migration tests slated for deletion actually use (`:5768-5771`, `:5866`, `:5896`). It is a pre-#179
  database: five `stages` rows with no `on_enter_skill` column and no `board_strict`. **Not**
  `SCHEMA_WITHOUT_STAGES_ON_ENTER_SKILL` (`:2696`), which is a *cluster* fixture consumed only by the
  cluster pin at `:2744`, and whose own file rules (`:2478-2481`, `:5651-5655`) forbid using it for a
  migration test: a cluster fixture must omit exactly one gated column, and
  `SCHEMA_PRE_TASK_BOARD_CONFIG` is *"the ONLY fixture allowed to omit TWO gated columns, because a
  migration test wants every #179 gate to fire at once"*. Corollary the plan must honour: the three
  deletions orphan `SCHEMA_PRE_TASK_BOARD_CONFIG`, `pre_task_board_rows` and
  `legacy_stages_pre_task_board_config!` (`:2482`) unless the replacement test consumes them, and dead code
  in a `#[cfg(test)]` module with no `allow(dead_code)` reddens `cargo clippy --all-targets -D warnings`.
  The cluster fixture's doc comment at `:2692-2695` also becomes false — it says *"the `discuss` backfill
  inside this gate is what the migration test observes"*.
- **Two `NewTaskDialog.test.tsx` cases are behaviour pins, not Discuss pins, and must be re-aimed rather
  than deleted:** *"leaves the board view when it launches a session"* (`:542`) pins
  `onCreated(…, "sess_new")` — the non-null sessionId arm, covered nowhere else for this component (the
  Backlog case at `:556` covers only the null arm) — and *"stays open with its error when the launch fails
  after the create"* (`:565`) pins stay-open-plus-both-fields after a failed `startTaskSession`. Deleting
  them while editing `submit` loses coverage at the worst possible moment.
- **Reviewer citations that failed verification, kept as a caution:** round 1 asserted a
  `"valid stages: discuss"` literal at `fulcrum_seams.rs:159` — that string does not exist in the file, and
  the real `valid stages: {available}` formatting is the `BoardError` Display at `db.rs:160`. Round 2
  attributed its grep false-positives to a `"six"` pattern — `grep -rn '"six"' --include=*.rs src-tauri/`
  matches **nothing**; the actual noise is `len() == 6` matching a 6-char lowercase-hex incarnation stamp in
  `test_support.rs:102/:115/:405/:411` and `session_native.rs:266`, plus a display-row count at
  `normalize_display_db.rs:404`. Both findings' *substance* was real; both citations were invented. Verify
  before you apply.

