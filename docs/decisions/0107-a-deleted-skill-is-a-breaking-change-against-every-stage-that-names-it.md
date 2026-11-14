---
status: accepted
date: 2026-11-13
superseded-by:
---

# A deleted **Skill** is a breaking change against every **Stage** that names it, and the fix is a board change rather than a migration

The **Skill** catalog is not ours. Rust discovers it from roots a person owns — the Space's
`.agents/skills` + `.pi/skills` walked up to the repo root, plus `~/.agents/skills` +
`~/.pi/agent/skills` (ADR 0013) — so the set is **external and it can shrink**: a Skill deleted on
disk vanishes from every catalog on the machine at once, with no release, no deprecation and no
signal to the app. ADR 0098 made a **Stage** row's `on_enter_skill` the ONE authority for what a
launch loads, and that decision has a consequence 0098 did not follow: **deleting a Skill is a
breaking change against every Stage row that names it.** Every such column's launch button becomes
unresolvable, simultaneously, in every Space.

It is also **invisible**. `missingSkill` refuses correctly, but the refusal is only reachable where
a control exists to be refused — and a **Task** card's launch pill is gated on `launchReady`, so a
Stage whose Skill cannot be resolved renders **nothing** where the pill used to be rather than a
disabled control (`TaskCard.tsx`'s `launchStep !== undefined && launchStep.launchReady` branch).
That is the right call for its own case (the catalog is an async fetch that starts EMPTY, and a
greyed control on every card mid-fetch is noise), and it is the wrong broadcast for this one: the
board does not say "this column is broken", it says nothing at all. The decision here is therefore
twofold — **treat a shrinking catalog as a breaking change against the board's data**, and **fix
the data rather than adding a warning surface to it**.

**Supersedes ADR 0098 PARTIALLY.** Only its "`discuss` needs a Stage to own it, and the seed had
none" Consequence — the one that says *"The seed grows a sixth entry, `discuss`"* — and its
two-Skill backfill (the `'discuss'` `UPDATE` and the `discuss` row-insert) fall. The core decision
— the **Stage** row is the ONE authority for a launch **Skill**, and the `TASK_LAUNCH_MODES` /
`skillOfMode` / `stageOfMode` constant map stays DELETED — STANDS untouched, and this change is an
INSTANCE of it, not an exception to it: the reason a deleted Skill is a board problem at all is
that 0098 moved the answer onto the board. `on_enter_skill` as a second column beside `on_enter`,
the raw-render argument for keeping them orthogonal, and the inert-`fresh` Consequence all stand
too.

**The worked example is the `discuss` Skill.** `~/.agents/skills` commit `38341e7` deleted
`discuss/SKILL.md` and merged its content into `research` as Path A / Path B. The catalog shrank.
Every seeded Space held a `discuss` column whose `on_enter_skill` named a Skill nothing could
resolve. The fix is the one 0098's own mechanism points at: `DEFAULT_STAGES` goes back to FIVE
(`backlog / research / approved / doing / done`), the `on_enter_skill` gate stops inserting a
`discuss` column on a pre-#179 upgrade and backfills `research` alone, and `NewTaskDialog` loses its
second launch button. A side effect is the repair of the live defect this deletion actually caused:
with the six-stage seed and `next_slugs` NULL by design (ADR 0099), `nextStepOf` fell back to the
Stage at `sort_order + 1`, so a fresh Space's `backlog` card pointed at `discuss` — a column whose
pill could not render — and **the Backlog column showed no launch affordance at all, silently**.
Five stages makes `backlog → research` again, and the pill comes back. No smaller change fixes it.

**0098's justification for the hardcoded names is falsified, and it is worth saying plainly.**
0098 accepted two Skill names hardcoded in Rust as *"a one-time migration that ages out, not a live
switch that keeps asserting."* A migration that writes a name **nothing can resolve** IS a live
switch: every Space it touches keeps asserting a fact about the catalog on every open, forever, and
it does not age out — the row it wrote is durable data, not a transient upgrade step. 0098
contemplated exactly one related failure, *"A Space without the `discuss` skill installed"*, which
is a **fresh-install** state: a person who has not installed that Skill yet, on a board whose shape
is still correct. A Skill **disappearing from every catalog** is a different failure class — the
board's shape is now wrong, not merely unprovisioned — and 0098 never contemplated it. That gap,
not any value inside 0098, is what this ADR fills.

**Legacy `discuss` columns are not migrated, as policy.** They are **user data**: a column a person
may have renamed, reordered, pointed at from `next_slugs`, or filled with cards, in a table whose
`slug` is part of its primary key. Three reasons, in order of force. (1) **There is no latch.**
Every one-time migration in `storage/db.rs` is a `gate()` on a MISSING COLUMN — the probe is
`SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2`, so a gate can fire exactly once
because a column stops being missing. A `DELETE FROM stages WHERE slug = 'discuss'` has no column
to latch on. There is no `user_version` pragma and no migrations table anywhere in the repo, so a
data-only gate would need a mechanism that does not exist. (2) **It would be the repo's first data
destroyer for no schema reason**, against a precedent that goes the other way: ADR 0098's own
*"removing a legal value from a stored union is a migration for no gain"*, the deliberately
UNBACKFILLED `next_slugs` (*"Backfilling it would have given every existing board a graph it never
asked for"*) and `board_strict`, and the seed's own *"deleting a column is the editor's job, not the
seed's"*. (3) **It would not age out either** — a `DELETE` is a permanent clause in every open path,
which is the exact defect this ADR is fixing in the first place. Deleting the column is the Stage
editor's job, and it is available to the person who owns the board.

**What a leftover column actually does, measured rather than assumed.** A drag INTO it is completely
silent: neither `useDragCard` nor Rust `move_task` consults the Skill catalog at all — the storage
layer never learns the word — which is what `TasksBoard.test.tsx`'s *"a card dropped in another
column starts NO Session"* pins. So a stale column is not a trap that fires an error at the moment
of use; only the launch affordances refuse, and they refuse with `missingSkill`'s templated
``This Space has no `discuss` skill to load.`` And it is not one careless click from deletion:
`delete_stage` refuses while the column holds cards (naming the count), refuses while another Stage
names it in `next_slugs`, and refuses the last Stage — so a column with cards in it survives until
someone relocates them deliberately.

## Considered options

- **Delete the `discuss` entry from the seed and the gate** (chosen) — it is the only option that
  makes the SEED describe a catalog that exists, it repairs the fresh-Space Backlog pill as a side
  effect, and it leaves existing boards alone. It costs one launch button and no data.
- **Repoint `discuss` → `research`** (`on_enter_skill = 'research'` on the existing row) —
  mechanically legal and nothing objects: no code asserts `slug === onEnterSkill`, so the button
  would work. Refuted by the merged Skill's own text: `research/SKILL.md` says *"Both signals
  present → A first, then B"* — research, then design — while the seeded order said *"discuss sits
  BEFORE research"*. A `Discuss` column at position 2 loading a Skill whose first act is research
  is backwards relative to the thing it loads, and a column labelled `Discuss` that loads
  `research` makes the label a permanent lie about what the click does.
- **Remove the button from `NewTaskDialog` only, leave the seed alone** — this WAS the shipped
  state, and it is what produced the silent missing pill. It hides the affordance while leaving the
  dead column live in the seed, so every fresh Space keeps inheriting a column nothing can launch.
- **Relabel the column to `Design`** — leaves slug `discuss`, label `Design` and Skill `research`:
  three names for one column, in a repo that documents slug-vs-label drift as the thing to expose
  rather than encode (the editor shows the slug precisely so a rename does not hide it).

## Consequences

- **A shrinking catalog is now a documented breaking change, and nothing detects it.** This ADR
  records the rule; it adds no lint, no warning chip and no "unknown Skill" surface. A Stage naming
  a Skill that is gone still renders no pill and says nothing. That is accepted deliberately — the
  alternative is a loud warning on every card during the async catalog fetch, which is the failure
  mode `launchReady` exists to avoid — but a future reader should not mistake the silence for
  health.
- **The seed is five and the gate backfills one Skill.** `get_board_seeds_the_five_default_stages_once`
  pins the roster and count, `fresh_database_gets_the_three_new_columns_from_schema_and_seeds_five`
  pins the fresh-DB shape, and `the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row`
  is the REPLACEMENT gate pin — it asserts the `research` backfill happened AND that no `discuss`
  row was invented on an upgraded database. The three gate pins this deletes
  (`five_stage_database_gains_discuss_before_research_and_both_skills_on_open`,
  `a_space_that_already_has_a_discuss_row_is_left_alone_by_the_backfill`,
  `a_space_with_a_hand_renamed_research_slug_gains_no_discuss_row`) existed to pin the insert, so
  they go with it.
- **Existing Spaces keep their `discuss` columns indefinitely, by design.** `seed_default_stages`
  fires only at ZERO rows, so the seed never heals a board — the gap `docs/features/task-board-known-gaps.md`
  §5 already records — and this change makes that gap the mechanism by which stale columns persist.
  The documented remedy is the Stage editor. The behaviour of such a column is specified above, so
  nobody has to re-derive it under pressure.
- **ADR numbering is unsafe off a branch, and this plan proved it.** 0101 and 0102 were
  untracked-but-spoken-for and 0103 was tracked when this branch was cut, so `max+1` computed from
  `main` collides with work that is not on `main` yet; the directory also has gaps, where a
  gap-filler collides and `max+1` does not. Hence the rule: **pick, then verify** —
  `ls docs/decisions/ | grep -oE '^[0-9]{4}' | sort | uniq -d` must print only the known
  pre-existing collision `0086`, which is left alone. This plan named **0104** and was wrong:
  0104, 0105 and 0106 were all taken by the time it was executed, which is the same failure class
  the numbering note exists to warn about. It is recorded here rather than quietly corrected,
  because a note that is silently amended teaches nothing.
