---
status: live
last-verified: 2026-11-13
verified-by: re-measured at the tip of the task-board-selected-space run — the comment-only claim covers commit `595e8f4f` ALONE and not the run — that commit changed no behaviour (its four `src` edits are comment text in `src/components/SessionConfigBlock.tsx`, `src/hooks/useActiveSpaceCwd.ts`, `src/components/StageEditor.test.tsx` and `src/store/sessions.ts`, so no test can show THOSE). The RUN is not comment-only, and two behavioural changes in it ARE test-visible — (i) the board's Space key moved from a prop to a store read, `TasksBoard` now calling `useSessions((s) => s.activeSpacePath)` and taking no Space prop at all, pinned by `renders the board for a SELECTED Space with no active Session (the board is per-Space)` in `src/components/TasksBoard.test.tsx` and by `the board loads for the selected Space when every Session is archived` in `src/App.test.tsx`; (ii) the sidebar's Archived section changed its open rule to follow the Landing Session, pinned by `the Archived section is OPEN by default when it holds the active Session`, `the Archived section stays collapsed by default when the active Session is elsewhere` and `the Archived section opens when the Landing Session ARRIVES after mount (the boot order)` in `src/components/SpacesList.test.tsx`. So nothing here should be read as "the run changed no behaviour". Every number below was re-run in this sitting and none is carried over. New for §7 — `grep -rn "useActiveSpaceCwd()" src/App.tsx src/components/ChatStream.tsx` gives **2** (the two production consumers and no third), `grep -rn "activeSpacePath=" src/App.tsx` gives **0** (the board's prop is gone) and `grep -c "useSessions((s) => s.activeSpacePath)" src/components/TasksBoard.tsx` gives **1**, `grep -rn "the board is only reachable while a Session IS active" src/` gives **0**, `grep -n "stored/paused banner" src/store/sessions.ts` gives **0**, `grep -n "disabled={activeSpacePath === null}" src/components/TasksBoard.tsx` gives **2** (so `New task` and `Configure` now gate on NO Space open rather than on no active Session), and `npx vitest run src/components/SessionConfigBlock.test.tsx src/components/StageEditor.test.tsx` gives **49 passed** with `pnpm build` green. Carried claims re-checked — `grep -rn "on_enter ==" src-tauri/src src` still gives **exactly 1** hit and it is `commands/tasks.rs`'s "compact" arm, `grep -rn "UPDATE stages SET on_enter = " src-tauri/src` still gives **2** hits both inside `storage/db/tests/mod.rs`, `grep -rn "DELETE FROM tasks" src-tauri/src` still gives **2** lines (one test and one prose comment) so §1 stays latent, and `grep -c "tauri::command" src-tauri/src/commands/tasks.rs` still gives **18**. ONE carried claim was FALSE and is corrected in §2 — `grep -rln "TaskStore" src-tauri/src` gives **5 files** and not 4, and it gave 5 at the commit that wrote 4. §5's seed sites were re-read rather than executed — `seed_default_stages` runs inside `get_board` before the stage SELECT and again inside `create_task`. Rust read, not executed; `cargo test` and `cargo clippy` deliberately not run here. Kept to one line and free of interior colons so this front-matter parses as strict YAML, which nine other files in this directory do not (re-counted 2026-11-13 — this directory holds 24 files, 15 parse and 9 do not, and the "seven" this line used to say was itself a carried number that had decayed by two). Re-measured 2026-11-13 for the drop-seeded-discuss-stage run (ADR 0107) — `grep -n "const DEFAULT_STAGES" src-tauri/src/storage/db.rs -A6` gives a `[(&str, &str, Option<&str>); 5]` of backlog / research / approved / doing / done with `research` the ONLY Skill-bearing entry, `grep -rn "seeds_the_six\|seeds_six" src-tauri/src` gives **0** (the six-stage pins are renamed, not merely failing), `grep -rn "UPDATE stages SET on_enter_skill" src-tauri/src/storage/db.rs` gives **2** and they are the ONLY two — the migration's `'research'` backfill and `set_stage_skill`'s parameterised write — so the `discuss` UPDATE and the `discuss` row-insert are gone, and the three gate pins that asserted the insert (`five_stage_database_gains_discuss_before_research_and_both_skills_on_open`, `a_space_that_already_has_a_discuss_row_is_left_alone_by_the_backfill`, `a_space_with_a_hand_renamed_research_slug_gains_no_discuss_row`) give **0** hits and are replaced by `the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row`. §3 and §5 were re-read line by line, `docs/decisions/0098-*.md` was checked for a front-matter-only supersession note, and `docs/decisions/ | grep -oE "^[0-9]{4}" | sort | uniq -d` still gives **0086** alone. The §3 and §5 edits in THIS amendment are prose and front-matter only — no test reads `docs/`, so nothing could measure them and the greps above ARE the instrument (the code they describe landed in the two commits before this one).
---

# Task board — known gaps

Accepted, unfixed defects and deliberately-unbuilt scope in the per-Space Task board (the
`tasks` / `stages` / `task_sessions` / `task_artifacts` tables, their eighteen IPC commands, the
seven model-facing verbs over the `TaskStore` seam, and the board surface).
They live here because the roadmap family that recorded them
(`docs/roadmap/kanban-task-board-*.md`) is deleted on ship and nothing under `docs/roadmap/`
is recoverable afterwards — no `git checkout`, no stash, no dangling blob. This is the
surviving home. Read it before concluding that a limit or a gap is handled.

The storage decision itself is ADR 0090 (no foreign key to `spaces`, lazy stage seeding), the
frozen checklist boundary is ADR 0093, the model-facing seam is ADR 0092, the Stage-owned launch
Skill is ADR 0098, the transition graph is ADR 0099, and the artifact table is ADR 0100. This file
holds only what is still open. Note that ADRs 0098 and 0099 each close a Consequence with "the
board still has no model-facing tools … desktop-only" — true of THOSE changes, false of the board
after #180, and §2 is where that lives now (ADR 0100 says so explicitly).

## 1. Task `number`s ARE reusable, and ADR 0090 says the opposite

**The most load-bearing item here, and it is latent.** ADR 0090 states that numbers "are
never reused after a delete: reusing `#2` would silently re-point every historical mention of
`T2`", and in the same breath mandates
`COALESCE((SELECT MAX(number) FROM tasks WHERE space_path = ?1), 0) + 1`. Those two statements
cannot both hold. Measured against that expression — create four tasks, delete `#4`, create
again — the next task is `#4`. Deleting a *middle* number instead leaves a permanent gap
(`[1,3]` then yields `4`), so only the highest-position delete reuses, which is exactly the
case a "delete the card I just made" flow produces.

Honouring the invariant needs a per-Space counter table, which is a schema change no approved
constraint authorises, so the shipped SQL is the ADR's own SQL and the claim is the thing that
is wrong.

**Why this is not currently a bug** — verified, not assumed:

- There is **no delete verb for tasks**. `grep -rn "DELETE FROM tasks" src-tauri/src` gives **2**
  lines and only one is code — the other is a prose comment in `storage/db.rs` — and the code site
  is inside `storage/db/tests/mod.rs`, simulating a delete to pin numbering.
- `delete_space` runs `DELETE FROM spaces WHERE path = ?1` and nothing else, and the deliberate
  absence of a foreign key (ADR 0090's whole point — closing a Space tab must not cascade a
  board away) means board rows survive it. So no reachable path deletes one task.

A1 pinned the achievable half — `create_task_numbers_are_per_space_and_1_based_and_never_reused`
covers the middle-delete gap — and the boundary is commented at the statement.

**The obligation:** if a task delete is ever added, this becomes live and must be resolved
first. Either amend ADR 0090's claim to "numbers are not renumbered, and a deleted highest
number may be reused" or add the counter table. Do not let a delete command land against the
current SQL — the failure is silent and it re-points every historical `T2` mention.

## 2. The model CAN see and move a card — and the daemon still cannot serve it

**This section used to say the harness tools were never built. That became false on this branch
and the sentence was rewritten, not deleted — the same discipline §1 asks of ADR 0090.**

Seven model-facing verbs now exist, and every one of them reaches the desktop's SQLite through one
seam: `list_board` / `get_task` / `create_task` / `edit_task` / `move_task` / `get_artifact` /
`write_artifact` (ADR 0092's five board tools plus ADR 0100's two artifact tools). Measured, not
assumed:

- `grep -rln "TaskStore" src-tauri/src` → **4 files**, and `storage/db.rs` carries
  `impl TaskStore for Db`. The published crate tells the same story: the same grep over the
  `fulcrum-harness-0.2.0` extract gives **8** files, over `fulcrum-harness-0.1.0` it gives **0**.
  **Corrected 2026-11-12 — the desktop count is 5, not 4, and it was 5 the day this line was
  written.** The two extra files are `agent/errors.rs` (a prose comment naming the `TaskStore`
  backstop, from the D2 fix) and `commands/tasks/tests/artifacts.rs`; `agent/session/router.rs` was
  already in the count. The number is a byproduct of the claim and not the claim — `storage/db.rs`
  carrying `impl TaskStore for Db` is the load-bearing half, and it still holds — but this file's
  whole value is that its numbers are measured, so the number is fixed rather than re-explained.
- An `awk` over `pub fn tool_specs` in the published 0.2.0 counts **26** specs, **7** of them the
  task verbs; the same `awk` on 0.1.0 counts **19**. `tool_specs_advertises_twenty_six_tools` pins
  that number in the crate and says out loud that its two sibling censuses are SUBSET-shaped and
  stay green when a spec is deleted — which is why the count exists at all.
- The desktop answers the wire: `router.rs` has a `WorkerInboundEvent::TaskRequest` arm whose body
  is `run_task_call`, and `run_task_call` spells every arm as `<Db as TaskStore>::verb(…)` rather
  than `db.verb(…)`. That qualification is load-bearing and `run_task_call_creates_edits_and_moves_and_shapes_each_answer`
  reddens if one is spelled back to a method call — six of the seven verbs have an INHERENT `Db`
  twin, Rust prefers an inherent method, and the desktop's `MoveOutcome` is `{ on_enter }` alone
  where the crate's requires `to_stage`, so a silent rebinding ships green and breaks every move.
- The round trip is proven through a real Worker, not a fake: `worker_e2e.rs`'s
  `task_artifact_round_trips_through_a_real_worker` writes an artifact and reads it back across a
  live pipe, and its doc comment enumerates four mutations that would catch a "fully wired but
  returns nothing" seam — the shape ADR 0091 warns about.
- `worker_e2e.rs`'s `assert_advertised_tools` replaced the old `read`/`subagent` substring ban with
  **enumerated names** compared against each case's own enabled set. Issue #180 F1 made the
  substring form VACUOUS rather than wrong — a Task description saying "read a board" would have
  made it pass while proving nothing — and the crate's
  `no_task_tool_description_names_read_or_subagent` keeps the ban visible from Linux over the whole
  spec, params included.

**The gap that replaced the gap — the daemon refuses, loudly.** The `fulcrum` member
(`fulcrum/src/serve.rs`) answers `WorkerInboundEvent::TaskRequest` with a `task-unsupported` frame
naming the `requestId` it refuses, because the daemon holds no `TaskStore` and cannot produce an
`Inbound::TaskResponse`. `a_task_request_gets_a_loud_task_unsupported_refusal` and
`the_task_refusal_is_never_a_silent_drop` pin both halves — the refusal must be a relay with a
reason, and must never be the `null` that recreates a hang with no diagnosis. So **task tools do
not work against the daemon**, and the failure mode is deliberate: the Worker's oneshot stays
unresolved until the turn token cancels the parked call and F1's `TaskRequestCleanup` empties the
pending map. A human sees a reason on screen instead of a tool that looks frozen; the model still
gets no answer. That hang-until-cancel is the real remaining cost of this section.

**Three second-order truths, each measured, because each reads like it should be false.**

1. **A model `move_task` never fires a compaction and never runs a launch.** `grep -rn "on_enter =="
   src-tauri/src src` returns **exactly one** hit, and it is `commands/tasks.rs`'s `"compact"` arm —
   the human drag. The `TaskRequest` router arm names no `SessionManager` at all, and the trait impl
   answers `note: None` for every move. This is ADR 0092's rule (storage cannot name the
   `SessionManager`) rather than an oversight, but the consequence is worth saying plainly: **a
   model can move a card into a `compact` column and nothing compacts.** The two verbs disagree
   about what a move means, and only the human's drag is the full verb.
2. **The command layer's refusals are bypassed by the seam, and the artifact key grammar is the
   sharp one.** `require_title`, `require_artifact_key` and `require_artifact_size` have exactly
   **two** non-test call sites each and all six sit in `commands/tasks.rs` — the model's path goes
   `run_task_call` → `<Db as TaskStore>::…` and never touches them. So a model can write a card
   with a title the human's `create_task` would clean, and can write an artifact key outside
   `[a-z0-9][a-z0-9-]{0,39}` and a markdown over 256 KiB. The size cap is the smaller problem — the
   crate's own `a_256_kib_markdown_round_trips_byte_for_byte_through_the_executor` says out loud
   that the readers on both ends are unbounded `read_line` and F1 adds no crate-side cap, so an
   uncapped frame is possible through the seam. **The key is the one that bites**: ADR 0100 calls
   the grammar load-bearing precisely because a key is interpolated into the `<task>` launch block,
   and that is true of the block even though `taskBlock` runs the keys through `escapeAttr` — the
   grammar was chosen to make escaping unnecessary, and the seam is now a door that writes keys the
   grammar forbids. Nothing in the tree pushes a bad key or an oversize markdown through the seam:
   every `TaskCall::WriteArtifact` in the tests uses `"spec"`. Either lift the two checks to the
   `TaskStore` impl or make the router arm call them, and until then do not describe the artifact
   key grammar as enforced.
3. **A card the model writes is invisible until the board is remounted.** `store/tasks.ts`'s `load`
   has exactly one call site, `TasksBoard`'s mount effect keyed on `activeSpacePath`. Nothing
   subscribes to a task tool's result, so `create_task` / `write_artifact` over the seam do not
   repaint the board, and the new card appears on the next visit. The `details` the tools emit
   (`board`, `task`, `moveOutcome`, `artifactMeta`) are registered — the frozen producer tuple in
   `toolDetailsRegistry.test.ts` grew from 35 to 39 names for exactly those four — but a census of
   the readers finds **no structural consumer** for any of them, and the registry says so out loud
   rather than leaving it to inference — `artifactMeta`'s row reads "D2 deliberately ships NO
   reader: the artifact chip list comes from the board's `artifactKeys`, not from a tool result",
   `board`'s reads "the board UI renders `get_board`, never a tool result, so the rows are dumped as
   opaque text", and `task`'s records that its producer key is "unread and NOT spanning" because
   the reader union's `task` is a subagent field with the same spelling. The header reads its facts
   from RAW INPUT, not from `details`. So the wire vocabulary is live by decision; the surface that
   would use it to repaint the board was never built, and §6 records what that costs.

The static-`Vec` constraint ADR 0090 predicted is still exactly what shaped this: a stage slug and
an artifact key are free-form strings validated at the executor/storage boundary, never
JSON-Schema enums. And the per-session **Checklist** is still `manage_todo_list` (ADR 0093) — a
task tool and the checklist are two different surfaces, and `EXCLUDED_FROM_SCRIPT` still holds
**6** names, so all seven task verbs are reachable from a `codemode` script, which is the batch
case ADR 0092 bought the `execute_tool` arms for.


## 3. `on_enter: "fresh"` is stored and returned but nothing acts on it

**AMENDED 2026-11-11, not closed.** Issue #179 §10 and ADR 0098 both ruled this section stays TRUE
and gains a pointer rather than a deletion, and it does stay true. What landed beside it is a
DIFFERENT mechanism, and confusing the two is now the likelier error.

`stages.on_enter` is a three-valued string (`none` / `compact` / `fresh`), deliberately a
string union and not a Rust enum so a Space can be retuned without a schema change. `compact`
is implemented — `move_task` reads the destination's value inside its own lock and reports a
`boostNote`. **`fresh` is still inert**: the value round-trips to the frontend and nothing
schedules a new Session for it. Measured at this HEAD, `grep -rn "on_enter ==" src-tauri/src src`
returns **exactly one** hit and it is the `"compact"` arm in `commands/tasks.rs` — there is no
`fresh` arm anywhere, and the crate never learns the word — `move_task_names_the_stage_and_note_but_not_on_enter`
refuses to narrate `on_enter` at all (it passes `"fresh"` through as opaque data) and
`move_outcome_stays_free_of_compaction` forbids `MoveOutcome` from even naming `compact`, `session`,
`launch` or `boost`. `fresh` is inert on BOTH sides of the seam.

**The pointer — `stages.on_enter_skill` is the thing that actually starts a Session with a Skill.**
ADR 0098 added it as a SECOND column beside `on_enter`, not a widened `on_enter`, and it is live
end to end: the column exists in `storage/db.rs` (`STAGE_COLUMNS` is 7 entries, `StageRow` carries
`on_enter_skill`, `set_stage_skill` writes it, the migration backfills `research` alone — the
`discuss` backfill went out with the retired Stage, ADR 0107),
`StageEditor` edits it through a Skill `Select`, and `taskPrompt.ts`'s `headOfMode` appends a bare
`$`-prefixed Skill token to the launch head. So the sentence "this column starts a Session that
loads `research`" is now carried entirely by `on_enter_skill`, and `on_enter` carries none of it.

The two fields are ORTHOGONAL, which is why `fresh` was left in place rather than folded in: a
Stage can be `compact` AND carry a Skill. ADR 0098's reason for the split is the render site —
`on_enter`'s value is printed RAW as the column-header chip, so a composite `fresh:research` would
print as a label. Whether to drop `fresh` from the value union is an unmade decision, and removing
a legal value from a stored union is a migration for no gain.

**Two sharpenings this HEAD adds, both measured.**

- **The chip is worse than silent, it advertises, and the chip that was supposed to contradict it
  was never built.** `TasksBoard.tsx` renders the column's `onEnter` raw with the tooltip
  `Entering this stage runs: fresh`. That sentence is false for `fresh`. #179 §7.3 asked for
  `on_enter_skill` to be "rendered the same way (a chip naming the Skill)" in that same header, and
  it is not — `onEnterSkill` appears in `TasksBoard.tsx` only in the launch-destination object and
  the catalog gate, never in the column header, so nothing on the column contradicts the `fresh`
  chip. A `fresh` column does not merely behave like `none`, it claims to run something. §7.3 chose
  the raw render deliberately ("`fresh` continues to advertise itself inertly — consistent with
  §2"), and now that §2 has flipped, that consistency argument no longer holds.
- **Nothing in the app can even SET the value.** `grep -rn "UPDATE stages SET on_enter = "
  src-tauri/src` returns **two** hits and both are inside `storage/db/tests/mod.rs` pinning the
  `compact` boost; no `#[tauri::command]` takes `on_enter` as an argument, `create_stage`'s
  `INSERT` lists `on_enter_skill` and not `on_enter`, and `StageEditor` has no `onEnter` affordance
  at all. The DDL's `DEFAULT 'none'` is therefore the only writer in the shipped app. A `fresh`
  column exists only in a database someone edited by hand — which is why this gap has stayed
  harmless, and why the honest framing is "unimplementable from the UI" rather than "unimplemented".


## 4. Within-column position persists but is never read back into a stable order guarantee

`reorder_tasks` writes `sort_order` in one transaction, scoped so an id from another stage or
another Space is refused rather than silently relocated. Two edges are accepted:

- **`sort_order` is per-Space, not per-stage.** The verb writes positions only for the ids it
  was given and does not renumber across stages, so a card's stored position is only meaningful
  relative to its own column. That matches how `create_task` assigns it and how the board reads
  it, but it means the column is not globally dense.
- `edit_task` deliberately cannot write `sort_order` at all. That is not an oversight —
  `edit_task` stamps `updated_at` unconditionally and returns one row, so routing a reorder
  through it would move the last-edited clock on cards nobody edited and could half-succeed
  across N calls. `reorder_tasks` exists precisely to avoid that. Do not "simplify" the two
  verbs back into one.

## 5. `create_task` seeds stages too, which is wider than the spec's laziness

Spec §3 puts the default stages in `get_board`. A1 also seeds them in `create_task`,
because a card cannot live in a Space with no columns and `start_task_session` is reachable
without the board ever being opened. Seeding runs under the caller's already-held connection
guard — taking a second lock there is the interleave ADR 0090 forbids. Per-Space laziness is
still pinned (`seeding_one_space_leaves_another_space_unseeded`). This is a deliberate widening
of the spec's letter, recorded so a future reader does not file it as a bug.

**Amended 2026-11-11 — the seed is SIX, not five.** `DEFAULT_STAGES` is now a
`[(&str, &str, Option<&str>); 6]` of `(slug, label, on_enter_skill)` and the order is
backlog / **discuss** / research / approved / doing / done, with `discuss` sitting BEFORE
`research` and carrying `Some("discuss")` (ADR 0098, #179 §3.1). `get_board_seeds_the_six_default_stages_once`
pins the count (since RENAMED — see the 2026-11-13 amendment below; the name is left here because
it is what the six-stage state was pinned by) and `on_enter` stays OUT of the tuple so the DDL's
`DEFAULT 'none'` remains the
single source of that value. The part of this section that is still the gap is the SHAPE, not the
number — a lazy seed that also runs from a write verb is wider than the spec, and the sixth entry
made it worse in a new way: **the lazy seed still cannot fix an existing Space**, because
`seed_default_stages`'s count check only fires at ZERO rows and every pre-#179 install has five.
That is why the Skills arrive through a one-time migration backfill rather than through the seed,
and why the backfill hardcodes a Skill name in Rust — ADR 0098 accepts
that as the smaller evil ("a one-time migration ages out, a live switch keeps asserting"; ADR 0107
falsifies that justification for the name it deleted, and keeps it for `research`, which resolves).
As of 2026-11-13 the backfill carries the `research` Skill ONLY — the `discuss` `UPDATE` and the
`discuss` row-insert were removed — so an upgraded database gains the column and the one Skill that
still exists and NO `discuss` row. A
future reader who touches `DEFAULT_STAGES` and expects the seed to heal an old board is the reader
this paragraph exists for.

**Amended 2026-11-13 — the seed is FIVE again, and this reverses the amendment directly above.**
(This is the drop-seeded-discuss-stage run; the §7 amendment carries the same date and is unrelated.)
The `discuss` **Skill** was deleted from disk and merged into `research` (`~/.agents/skills`
`38341e7`), and because ADR 0098 made a **Stage** row the sole authority for a launch, a Skill that
vanishes is a breaking change against every Stage that names it (ADR 0107, which supersedes 0098 on
exactly this point). So `DEFAULT_STAGES` is back to
`[(&str, &str, Option<&str>); 5]` — backlog / research / approved / doing / done, only `research`
carrying `Some("research")` — pinned by `get_board_seeds_the_five_default_stages_once`, with
`fresh_database_gets_the_three_new_columns_from_schema_and_seeds_five` pinning the fresh-DB shape
and `the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row` pinning that the gate
backfills `research` and invents NO `discuss` row. The six-stage amendment above is kept rather
than edited away on purpose: this section has now been corrected in BOTH directions, and the record
of the first correction is what tells a reader the number is unstable rather than trustworthy.
What SURVIVES both amendments is the gap this section is actually about — the lazy seed still cannot
fix an existing Space — and it is now also the REASON legacy `discuss` columns persist: ADR 0107
declines to migrate them (they are user data, `gate()` can only latch on a missing COLUMN, and a
data-only gate would need a mechanism the repo does not have), so a pre-existing board keeps its
`discuss` column until someone deletes it in the **Stage editor**.

## 6. A card cannot show its state or attachments; Sessions and cost now can — was #174

The card anatomy (pill'd number, wrapping title, spec chip, artifact key chips, relative time, a
primary-next-step pill, a sessions chip) ships on `number` / `title` / `body` / `specPath` /
`updatedAt` plus the three board-only facts `TaskCardView` carries beside the row. Everything else a
reference-style board would put on a card is missing for one of two distinct reasons, and
conflating them sends the work to the wrong place.

**Reachable, not exposed — CLOSED by #176, kept as the shape of the fix.** This paragraph used to
say no `#[tauri::command]` returned a link row. That is false now and was closed the way it said to
be closed. `get_board` gained ONE extra statement and returns each card as a
`TaskCardView { task, sessions, costUsd, artifactKeys }`, aggregated server-side in Rust, and
`TaskCard` renders a clickable sessions chip through the imported `moneyOf` rule. Two rulings from
that fix are load-bearing and belong here because the roadmap that recorded them is deleted on
ship:

- **The decoration is a WRAPPER, not a field on `TaskRow`.** `get_task` / `create_task` /
  `edit_task` all answer a plain `TaskRow`, and had `TaskRow` grown a `sessions` field those three
  would have to join on every single-row read or answer an empty `sessions` for a card that HAS
  links — the confident, well-formed lie on the wire. `TaskCardView`'s four keys and `TaskRow`'s
  ten are each pinned by `the_task_card_view_wire_keys_are_frozen` in Rust and its TS mirror
  `the task card view wire keys are frozen (mirror of the Rust pin)` in `store/tasks.test.ts`,
  because this repo holds no automated Rust↔TS shape check.
- **Every field is REQUIRED, never optional** — an optional field compiles against every fixture
  and then renders nothing when real data arrives. And `costUsd: null` means "never reported" and
  renders NOTHING while `0` means "a real zero" and renders `$0.00` (ADR 0082); `moneyOf` is that
  rule's only implementation and is imported, never re-spelled.

`#174`'s remaining scope is what the issue itself called out of scope — a per-session list on the
card. The detail dialog does list them (`TaskDetailDialog`'s `the sessions list` describe), so the
card stays a two-line summary by construction.

**Still reachable, still not exposed — the model's write.** §2's third finding is the new member of
this family: a card a harness tool creates or an artifact a tool writes reaches no surface until
the board remounts, because `store/tasks.ts`'s `load` has one call site and nothing subscribes to a
task tool's result. The data is reachable; the repaint is not.

**No data source at all.** "Finished" has no representation — `CloseReasonStr`
(`user | agent-exited | error` — a *close reason*, not a terminal state) is the closest thing and
is not it. "Has a question" is live transcript frames (`InlineGateRow` → `AskQuestionCard`), never
persisted per Session. Attachments exist only as composer-to-model payloads with no table and no
link to a Task. Each needs persistence designed first; a command cannot rescue them.

`specPath` was the same story until now: stored, crossing IPC on `edit_task`, and rendered nowhere.
It has a chip today, and `TaskCard.test.tsx`'s present/absent case is its guard. Note it is no
longer the ONLY chip on the row — the artifact key chips (`TaskCard`'s `the artifact key chips
(issue #180)` describe) sit beside it as `bg-background` spans — so the card's `rounded-full` census
in `slabFloatSeparation.test.ts` counts literals, not chips, and a new chip moves that census by
exactly one. Do not confuse a **Task artifact** with the attachments this section still lacks: an
artifact is markdown a Session wrote, in `task_artifacts`, and it is NOT a file, has no table
linking it to a Task's composer payload, and does not close this gap.

## 7. What the Selected-Space fix settled, and the three things it left on purpose

**Added 2026-11-12 with ADR 0106 (issue #185).** The board used to be handed the ACTIVE
**Session**'s `cwd` under a prop named `activeSpacePath`, so a Space with zero active Sessions —
every Session archived, the last one deleted, a tab clicked that owns no live Session — rendered
"No Space is open" while the **Session list** beside it named that same folder and counted its
archived rows. `TasksBoard` now reads `useSessions((s) => s.activeSpacePath)` itself and takes no
Space prop at all, so the substitution cannot be re-made at a call site.

**Settled.** The board answers for the **Selected Space**: lanes, cards, `New task` and `Configure`
are live for a Space with no Session running in it, and the launch-pill gate and `store/taskLaunch`'s
refusal can no longer say "This Space has no `x` skill to load" about the Space the user selected
while reading the **user-level** catalog under the `__global__` cache key. That second half is the
part most likely to be mistaken for a cosmetic change — the wrong key produced a confident,
well-formed *false claim about the Space*, not merely missing data. The same key change also stops
the catalog cache from being evicted on every session ↔ session-less flip.

Note the knock-on for §2's third item. `store/tasks.ts`'s `load` still has exactly one call site,
`TasksBoard`'s mount effect — but the value it is keyed on is now the **Selected Space** rather than a
Session projection, so the repaint boundary moved with it: a model-written card appears when the
Selected Space changes, and the board now mounts and loads in states where it used to early-return.
The gap itself (nothing subscribes to a task tool's result) is unchanged.

**Amended 2026-11-13 — this section is not the whole run.** It was written at the docs-and-comments
commit, and behavioural work landed AFTER it, so the sidebar is the part this section says nothing
about while the run changed it. Neither item below reopens anything here — the board still reads the
Selected Space and the three gaps below all still hold (each was re-checked against the tree at this
date). What arrived after: the sidebar's **Archived** section changed its open rule, because the Landing
Session can now be an archived row and `mergeSessionOrder` never carries an archived id, so the Space
group cannot hold the highlight and that section is the only place the row lives
(`SpacesList.test.tsx`'s `the Archived section is OPEN by default when it holds the active Session` and
`the Archived section stays collapsed by default when the active Session is elsewhere`); that first form
seeded the state at mount and turned out to be inert in the shipped app, because `main.tsx` renders
`<App />` with no boot gate and the section mounts on the first frame while boot's `setSpaces` arrives
later — so the open state is now DERIVED, pinned by
`the Archived section opens when the Landing Session ARRIVES after mount (the boot order)`. The same
commit added `App.test.tsx`'s `the board loads for the selected Space when every Session is archived`,
which is the first pin of §7's own claim made through the real `App` tree rather than a hand-handed prop.

**Left, deliberately.** Three things, none of them an oversight:

- **A session-less Space still cannot serve a relative-path External open.** `SpaceCwdProvider` in
  `src/App.tsx` is fed `useActiveSpaceCwd()`, and that is by design: a relative path in a transcript
  is a path in the folder *that transcript was written in*, so re-keying the provider on the Selected
  Space would resolve a Session's paths against a folder that never produced them — a wrong path that
  still opens something, which is worse than `external_open`'s refusal. `useSpaceCwd()` returns `null`
  rather than throwing, and `App.tsx` says so above the provider — "the safe direction, but a dead
  surface". `useActiveSpaceCwd()` has exactly two production consumers today (`App.tsx` and
  `ChatStream.tsx`) and its header states that two is the contract, not a head-count.
- **`SidePane` still renders nothing with no active Session** — no title element at all, an empty
  `SessionCostLine`, no `ChecklistPanel`, and the Model stub in the config block. It is keyed on a
  **Session** and should be, and while the board is up the board's arm of `App`'s view ternary
  replaces the chat column AND the Side pane, so nothing on screen in the reported state.
- **Opening the board for a Space with zero Sessions is a WRITE.** `get_board` seeds stages on read
  (ADR 0090, and §5 above for the shape of that seed), so a read path now creates rows where it used
  to refuse — the intended consequence of "a Space that never opens the board pays nothing", recorded
  because it is surprising and because it widens *who reaches* the seed to a Space that has never had
  a Session in it.
