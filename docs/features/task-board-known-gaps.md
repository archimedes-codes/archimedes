---
status: live
last-verified: 2026-11-23
verified-by: re-measured at the tip of the task-board-selected-space run — the comment-only claim covers commit `595e8f4f` ALONE and not the run — that commit changed no behaviour (its four `src` edits are comment text in `src/components/SessionConfigBlock.tsx`, `src/hooks/useActiveSpaceCwd.ts`, `src/components/StageEditor.test.tsx` and `src/store/sessions.ts`, so no test can show THOSE). The RUN is not comment-only, and two behavioural changes in it ARE test-visible — (i) the board's Space key moved from a prop to a store read, `TasksBoard` now calling `useSessions((s) => s.activeSpacePath)` and taking no Space prop at all, pinned by `renders the board for a SELECTED Space with no active Session (the board is per-Space)` in `src/components/TasksBoard.test.tsx` and by `the board loads for the selected Space when every Session is archived` in `src/App.test.tsx`; (ii) the sidebar's Archived section changed its open rule to follow the Landing Session, pinned by `the Archived section is OPEN by default when it holds the active Session`, `the Archived section stays collapsed by default when the active Session is elsewhere` and `the Archived section opens when the Landing Session ARRIVES after mount (the boot order)` in `src/components/SpacesList.test.tsx`. So nothing here should be read as "the run changed no behaviour". Every number below was re-run in this sitting and none is carried over. New for §7 — `grep -rn "useActiveSpaceCwd()" src/App.tsx src/components/ChatStream.tsx` gives **2** (the two production consumers and no third), `grep -rn "activeSpacePath=" src/App.tsx` gives **0** (the board's prop is gone) and `grep -c "useSessions((s) => s.activeSpacePath)" src/components/TasksBoard.tsx` gives **1**, `grep -rn "the board is only reachable while a Session IS active" src/` gives **0**, `grep -n "stored/paused banner" src/store/sessions.ts` gives **0**, `grep -n "disabled={activeSpacePath === null}" src/components/TasksBoard.tsx` gives **2** (so `New task` and `Configure` now gate on NO Space open rather than on no active Session), and `npx vitest run src/components/SessionConfigBlock.test.tsx src/components/StageEditor.test.tsx` gives **49 passed** with `pnpm build` green. Carried claims re-checked — `grep -rn "on_enter ==" src-tauri/src src` still gives **exactly 1** hit and it is `commands/tasks.rs`'s "compact" arm, `grep -rn "UPDATE stages SET on_enter = " src-tauri/src` still gives **2** hits both inside `storage/db/tests/mod.rs`, `grep -rn "DELETE FROM tasks" src-tauri/src` still gives **2** lines (one test and one prose comment) so §1 stays latent, and `grep -c "tauri::command" src-tauri/src/commands/tasks.rs` still gives **18**. ONE carried claim was FALSE and is corrected in §2 — `grep -rln "TaskStore" src-tauri/src` gives **12 files** now, and this line had been carrying **5**, which went stale twice and was never re-measured. The count is a moving target and this line is the proof — dated, because a bare number here rots inside a week (see the census convention above). The TRUE series, measured at each commit — **5** from `2814d561` itself (2026-11-11) through `256dab26` (2026-11-13), NOT "from before §2 existed" as this line used to say — `2814d561` is the commit that put the symbol into `src-tauri/src` AND wrote §2's bullet, and `git grep -l TaskStore 2814d561^ -- src-tauri/src` gives **0** files, so no pre-`2814d561` reading of 5 was ever possible (what §2 carried before the symbol existed was "0 files", which was TRUE of that tree); `256dab26` is the commit that wrote "the desktop count is 5, not 4" and was TRUE at its own commit, `agent/errors.rs` and `commands/tasks/tests/artifacts.rs` being the two §2's original **4** had missed; **8** at `b19dfe2e` (2026-11-16), which added `text.rs`, `commands/tasks/tests/board.rs` and `storage/db/tests/mod.rs` — a step no amendment of this line ever recorded, so the "5" it carried was already stale within three days; and **12** at `94af00d1` (2026-11-22), where the ADR 0113 subject split retired the single `db.rs` and its `tests/mod.rs` and gained `storage/db/{mod,artifacts,seams,tasks}.rs` plus `storage/db/tests/{seams,tasks}.rs` (2 removed and 6 added, so net +4). Note what the archaeology does NOT support — §2's original **4** was false the day it was written, not merely overtaken — at `2814d561` (2026-11-11), the commit that wrote it, the same grep already gave **5**, which is exactly what §2's own 2026-11-12 correction established, so the honest series is 5 → 8 → 12 and the 4 is a reading that was never true. §2's body carries the same **12** as its current figure and keeps that series as dated evidence of decay rather than as a contradiction. §5's seed sites were re-read rather than executed — `seed_default_stages` runs inside `get_board` before the stage SELECT and again inside `create_task`. Rust read, not executed; `cargo test` and `cargo clippy` deliberately not run here. Kept to one line and free of interior colons so this front-matter parses as strict YAML, which a MINORITY of the files in this directory do not — the durable claim is that RULE (AGENTS.md records it), the count rots, and it is therefore quoted dated rather than bare; re-measured 2026-11-23 as **31 files, 20 parse and 11 do not**, where the "27 files, 18 parse" this line carried from 2026-11-16 had decayed by four inside a week, and the "seven" before that had decayed by two. Re-measured 2026-11-13 for the drop-seeded-discuss-stage run (ADR 0107) — `grep -n "const DEFAULT_STAGES" src-tauri/src/storage/db.rs -A6` gives a `[(&str, &str, Option<&str>); 5]` of backlog / research / approved / doing / done with `research` the ONLY Skill-bearing entry, `grep -rn "seeds_the_six\|seeds_six" src-tauri/src` gives **0** (the six-stage pins are renamed, not merely failing), `grep -rn "UPDATE stages SET on_enter_skill" src-tauri/src/storage/db.rs` gives **2** and they are the ONLY two — the migration's `'research'` backfill and `set_stage_skill`'s parameterised write — so the `discuss` UPDATE and the `discuss` row-insert are gone, and the three gate pins that asserted the insert (`five_stage_database_gains_discuss_before_research_and_both_skills_on_open`, `a_space_that_already_has_a_discuss_row_is_left_alone_by_the_backfill`, `a_space_with_a_hand_renamed_research_slug_gains_no_discuss_row`) give **0** hits and are replaced by `the_on_enter_skill_gate_backfills_research_and_inserts_no_discuss_row`. §3 and §5 were re-read line by line, `docs/decisions/0098-*.md` was checked for a front-matter-only supersession note, and `docs/decisions/ | grep -oE "^[0-9]{4}" | sort | uniq -d` still gives **0086** alone. The §3 and §5 edits in THIS amendment are prose and front-matter only — no test reads `docs/`, so nothing could measure them and the greps above ARE the instrument (the code they describe landed in the two commits before this one).Re-measured 2026-11-14 for §8 (the `next_slugs` un-configure gap folded in from the edit-task-clear-fields run BEFORE that plan doc was deleted, since the report that found it is titled for the `edit_task` question and no one hunting a Stage-graph gap would reach it) — `grep -rn "UPDATE stages SET next_slugs" src-tauri/src --include=*.rs` gives **2** and exactly one is production, `set_stage_next` takes a plain slice so it has no third state, `seed_default_stages` and `create_stage` both omit the column so a NEW row is `NULL`, the strict-move gate comment reads "NULL passes unconditionally" so `None` is legal while `[]` refuses every move, and `set_stage_skill_sets_and_clears_the_skill` is the clear-capable precedent in the same file. §1–§7 were not re-measured in that sitting and none was rewritten by it. `ls docs/decisions/ | grep -oE "^[0-9]{4}" | sort | uniq -d` still gives **0086** alone. §8 is prose and front-matter only — no test reads `docs/`, so the greps above ARE the instrument. Re-measured 2026-11-16 for §2 item 2 (the seam-bypass claim) — `grep -n "THE ONE OWNER" src-tauri/src/storage/db.rs` gives **2** and `grep -n "crate::text::clean_title" src-tauri/src/storage/db.rs` gives **6** lines of which **2** are the call sites inside `Db::create_task` and `Db::edit_task`, `git grep -c "EmptyTitle" -- src-tauri/src/storage/db.rs src-tauri/src/agent/errors.rs` gives **9** and **8**, the two phrases that item 2 was built on gave **2** hits before it was rewritten and **0** after (`git grep -n "the seam bypasses nothing"` gives the rewritten title alone), and `git grep -n "task-board-known-gaps" -- src src-tauri scripts .github` gives **0**, which is why the greps in this clause carry the claim rather than any test. The census in the parenthetical above WAS re-measured in this sitting and is corrected here from 24 files / 15 parse to **27 files, 18 parse and 9 that do not**, under both the `split("---")[1]` method this file's own check uses and a strict front-matter parse, and the two methods name the same 9 (that 27/18/9 is KEPT as the dated reading it is — it is the decay evidence for the rule above; it had itself decayed to 31 files / 20 parse / 11 that do not by 2026-11-23, which is the figure the parenthetical carries now, re-measured under the same two methods and again naming the same files under both). §2 item 2 is prose and front-matter only, no test reads `docs/`, so the greps above ARE the instrument. §1 and §3–§8 were not re-measured in that sitting and none was rewritten by it. Re-measured 2026-11-23 for the new addressing block in §2 (ADR 0117 — a frame's delivery address is never a reply address) — `grep -n "fn a_subagents" src-tauri/tests/worker_e2e.rs` gives **1** and the name it lands on is `a_subagents_task_request_is_answered_in_the_child_and_not_the_parent`, quoted verbatim above; `grep -rn "task_reply_target\|TASK_BOARD_CALL_TIMEOUT\|with_board_deadline" src-tauri/src` gives **19** lines and the per-symbol split in that same order is **5 / 9 / 5**, measured 2026-11-23 at this HEAD by that exact command, and all 19 are in `agent/session/router.rs` which is why the block names the seam's owner rather than a commit hash. THE FIGURE IS DERIVED AND NOT CARRIED — re-run that command rather than quoting this clause, because a comment naming any one of the three symbols moves the count by one and the archaeology here proves that rather than arguing it — **17** at `bf99f90f` (the reading this line first carried and TRUE at its own commit), **18** once `fdda21a2` added a match inside a comment while `6d48c7a7` failed to re-measure it, and **19** once `9fb3bda4` added a nineteenth by writing a comment that names this `const` itself — so the sentence that closed the previous amendment, "the 18 is the current reading", was falsified by that same round's next commit and is REMOVED rather than re-numbered in place, which is the SECOND decay inside this one run (the first being 17 to 18 above) and the reason this clause is now written as a command to re-run rather than as a number to carry; `docs/decisions/0117-*.md` and `docs/research/board-tool-hang-subagent-task-response-misroute.md` both exist in the tree; and the two `CONTEXT.md` terms the block leans on, **delivery address** and **origin address**, are both present in `CONTEXT.md`. `src-tauri/Cargo.toml` pinned `fulcrum-harness = "0.6.0"` when this was measured on 2026-11-23 (the desktop now pins a later crate — that clause is dated, not current, and nothing else in this stamp was re-verified against it), and the crate extract's `worker/manager/pump.rs` is where `delivery_id` is computed (3 hits), which is the durable spelling of the path the sibling doc `subagent-sessions.md` had to correct from the dead `src-tauri/src/agent/worker/manager.rs`. NOTHING in §1–§8 was re-run in this sitting and nothing outside the §2 addressing block was rewritten by it — the daemon's `task-unsupported` paragraph and its hang-until-cancel cost are carried UNCHANGED from the paragraph above and were re-READ only, and the non-discriminating-assertion finding is quoted from `worker_e2e.rs`'s own mutation note (the doc comment above that test records the failing message the mutation produced) rather than from a run in this sitting. The three citations a future reader will look for and that are DELIBERATELY ABSENT are the desktop branch hashes for this run and a desktop PR number, because the squash-merge convention orphans a cited branch hash and no desktop PR for this branch exists yet — hence the test name, ADR 0117 and the engine's `v0.6.0` / fulcrum PR #36 carry the claim instead (AGENTS.md's squash-orphan rule). Re-measured 2026-11-23 for the seam's timing and visibility claims, stated here as CURRENT truth only — this line's own history carried TWO false claims, that the render `timeoutMs` this repo SENDS is 5000 and the `unwrap_or(30_000)` fallback therefore unreachable (both of its citations landed in test code), and that the board deadline is landed BESIDE the arm's `record` sites (it is armed INSIDE the spawned future, which is why it covers less than the sentence implied); both are corrected below and the rest of that archaeology lives in the git log, which does not rot, so it is not repeated here. The naming backstop IS 30 s (`grep -rn "NAME_REQUEST_TIMEOUT" src-tauri/src/agent/session/naming.rs` gives three hits and exactly one is the `const` itself, `Duration::from_secs(30)`). The render path runs 30 000 END TO END — `grep -n "request_render" ~/.cargo/registry/src/*/fulcrum-harness-0.6.0/src/web/tools.rs` gives `requester.request_render(url, 30_000)` at 261 inside `exec_fetch_content` (`mod tests` there begins at 471), `grep -n "timeoutMs" ~/.cargo/registry/src/*/fulcrum-harness-0.6.0/src/worker/core.rs` gives `"timeoutMs"` at 196 inside `IpcRenderRequester::request_render` (`mod tests` begins at 990), and the desktop reads that frame back with an identical fallback (`grep -rn "unwrap_or(30_000)" src-tauri/src` gives exactly ONE hit, the `timeout_ms` field of the ONLY production `RenderRequest` construction, `grep -rn "render::RenderRequest {" src-tauri/src` giving exactly ONE hit and it in `session/router.rs`) — so the fallback and the value actually sent are the SAME number, which is what §2's paragraph says. Those four crate figures stay as LINE NUMBERS on purpose, a published crates.io version is immutable and cannot drift. The desktop numbers this line used to carry are replaced by CONTENT instead, and the reason is MEASURED rather than assumed — of the sixteen desktop line numbers the previous amendment carried, fourteen still resolved at this HEAD and TWO were already wrong on the day they were committed, both in `router.rs` (the `mod tests` and the 5000 payload, each sitting four lines BELOW the number cited for it), because the very commit that wrote those two numbers had added lines above them; that is the whole argument, a `file:line` into a moving file can be false the moment you write it, and `docs/agents/test-counts-and-splits.md` carries the rule (never cite `file:line`, it decays as files move). On that rule the 5000s that misled the earlier versions are located by WHAT THEY ARE rather than by a number — in `router.rs` the single 5000 `timeoutMs` payload sits BELOW that file's `mod tests`, which is why it is a test fixture and not production, and in `web/render.rs` BOTH 5000s sit inside `test_render_request_reply_serde`, a serde round-trip of a locally-built `RenderRequest`, the only 5000 in that file outside a test being the `tokio::time::timeout(Duration::from_millis(5000), win_rx)` window. `busy_timeout` is still 5 000 ms (`grep -n "busy_timeout" src-tauri/src/storage/db/mod.rs` → the `pragma_update` inside `set_journal_pragmas`), so the 6× holds. And the unqualified "every path that fails to answer records" stays FALSE — the `WorkerInboundEvent::TaskRequest` arm has exactly FOUR `diagnostics::record` SITES (`grep -c "diagnostics::record(" src-tauri/src/agent/session/router.rs` gives **4** — the trailing paren is what makes it a call site, because the bare symbol greps **6** in that file and the two extra are a doc comment and a test comment, not paths) and all four sit inside the `WorkerInboundEvent::TaskRequest` arm (`sed -n '/WorkerInboundEvent::TaskRequest {/,/WorkerInboundEvent::Exited(code)/p' src-tauri/src/agent/session/router.rs | grep -c "diagnostics::record("` gives the same **4**) and they cover only the four paths the arm's own comment scopes them to, its words being "every path below that fails to answer", namely the unroutable child frame, the missing `WorkerManager`, the `handle_for` miss and a `send_inbound_frame` `Err`; a panic inside the spawned answering task and a `tokio::spawn` on a shutting-down runtime stay SILENT and are covered by NEITHER mechanism, because the deadline is armed INSIDE the spawned future (`tokio::spawn` to `run_task_call` to `spawn_board` to `with_board_deadline`) so a task that panics or never runs never reaches it, while the Dead bound is disarmed for as long as a `tool_call_id` is outstanding, which is exactly a parked child's state. Both this file and `subagent-sessions.md` now carry the arm comment's OWN words "every path below that fails to answer" rather than a paraphrase of them, and name those two as the residual; §2 item 1 carries the same qualification. The directory census above was re-counted in the same sitting as 31 files / 20 parse / 11 that do not, under both the `split`-slice method this file's own check uses and a strict front-matter parse, and the two methods name the SAME 11 files. NOTHING in §1–§8 was RE-RUN in that sitting either — the instruments there are greps and a file census, and no test reads `docs/`. The parent-side negative in the end-to-end pin is NON-DISCRIMINATING and this file had been counting it as a tooth — MEASURED and not reasoned, with `task_reply_target` forced back to the delivery id and a probe placed before the child's tool-row poll giving `parent-row-count=3` and `parent-negative-predicate-holds=true`, i.e. the predicate HOLDS on the broken code (that run then died on the child's tool row, exactly as the mutation note says). One clause was ADDED and no behaviour changed — a timed-out board call may still COMMIT, because the `spawn_blocking` closure keeps the `conn` mutex, and `create_task` is the one non-idempotent verb (`grep -rn "Uuid::new_v4" src-tauri/src/storage/db/tasks.rs` gives exactly ONE hit, the `format!("tsk_{}", ...)` inside `create_task` that mints a fresh id per call), so a retry after a timed-out-but-committed create duplicates the card, while `write_artifact` upserts on `ON CONFLICT(task_id, key)` (`grep -rn "ON CONFLICT(task_id" src-tauri/src/storage/db/artifacts.rs` gives exactly ONE hit, inside `write_artifact`) and `edit_task` / `move_task` are last-writer-wins UPDATEs (`grep -n "UPDATE tasks SET" src-tauri/src/storage/db/tasks.rs` gives exactly TWO statements, one inside each of those two functions). Those four paths are the POST-split files — the stale `storage/db.rs` references elsewhere in this file are pre-existing decay from the ADR 0113 split, in sections this branch never touched, and were left EXACTLY as found on purpose rather than swept up inside a hang-fix PR. Runs in that sitting — `cargo test --lib -- a_board_call an_unanswerable unroutable a_subagents a_main_frame` gives **6 passed**, `cargo test --test worker_e2e` gives **13 passed**, `cargo clippy --all-targets -- -D warnings` gives **0**, `cargo fmt --all -- --check` is clean, `bash scripts/check-file-size.sh` is clean, and TWO more mutations were run to prove the test edits bite — forcing the const to `from_secs(130)` reddens the deadline test on the new `timed out after 30s` phrase (a bare `30s` would have PASSED it, since `grep -c "30s"` on the resulting 130s sentence gives 1), and `on_worker_crash` placed immediately before the `stalled_info` negative reddens THAT assertion, which is the measurement that REFUTES the review finding calling it vacuous (the row is absent on the passing path, true, but the ONLY writer of its `stalled` slice is `handle_crash`, which writes through the entry-or-default helper and CREATES that row for an id never started).
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

- `grep -rln "TaskStore" src-tauri/src` → **12 files**, re-run 2026-11-23 at this HEAD, and
  `storage/db.rs` carries
  `impl TaskStore for Db`. The published crate tells the same story: the same grep over the
  `fulcrum-harness-0.2.0` extract gives **8** files, over `fulcrum-harness-0.1.0` it gives **0**.
  **This number has moved TWICE since it was first corrected (three true readings, four written ones)
  and every reading is kept here dated, because that history IS the finding.** The **4** this bullet
  originally carried was FALSE the day it was written — at `2814d561` (2026-11-11), the commit that
  wrote it, `grep -rln "TaskStore" src-tauri/src` already gave **5**; that is what the correction below
  established. The true series is **5** → **8** → **12**: **5** held from `2814d561` itself — the commit
  that introduced the symbol into `src-tauri/src` AND wrote this bullet, so there is NO window before it
  in which 5 held (`git grep -l TaskStore 2814d561^ -- src-tauri/src` gives **0** files; the symbol did
  not exist there, and what §2 said before it was "0 files", which was TRUE then) — through
  `256dab26` (2026-11-13), the commit that wrote "the desktop count is 5, not 4" and was TRUE at
  its own commit — the two extra files were
  `agent/errors.rs` (a prose comment naming the `TaskStore`
  backstop, from the D2 fix) and `commands/tasks/tests/artifacts.rs`, and `agent/session/router.rs` was
  already in the count; **8** at `b19dfe2e` (2026-11-16), which brought in `text.rs`,
  `commands/tasks/tests/board.rs` and `storage/db/tests/mod.rs`; and **12** at `94af00d1` (2026-11-22),
  where the ADR 0113 subject split retired the single `db.rs` and its `tests/mod.rs` and gained
  `storage/db/{mod,artifacts,seams,tasks}.rs` plus `storage/db/tests/{seams,tasks}.rs` (2 out, 6 in).
  The number is a byproduct of the claim and not the claim — `storage/db.rs`
  carrying `impl TaskStore for Db` is the load-bearing half, and it still holds — but this file's
  whole value is that its numbers are measured, so the number is fixed rather than re-explained, and
  the reason it is now fixed WITH its history is that the **5** this line carried went stale TWICE in
  the nine days after it was written (to 8 at 2026-11-16 and to 12 at 2026-11-22) and no amendment
  caught either one.
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
  returns nothing" seam — the shape ADR 0091 warns about. **Amended 2026-11-23: this bullet used to
  stand as THE proof of the seam, and it is not — it attaches a MAIN session, where the pump's delivery
  address and the emitting loop's own id are the SAME id, so it cannot see an addressing error at all.
  That is not a criticism of the test, it is why ADR 0117's bug shipped green.** The seam now has a
  SECOND end-to-end proof, on the path the first one never crossed:
  `a_subagents_task_request_is_answered_in_the_child_and_not_the_parent`, same file, dispatching a real
  **Subagent session**. Read the addressing block below before citing either one as "the" proof — the
  two pin different things, and the artifact round trip pins LESS than it looks like it pins.
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

**That hang and THIS hang are different bugs that only share a symptom — do not merge them.** The
paragraph above describes a Worker parked because the process it asked **refused** to answer, loudly,
and the refusal is the design. A **Subagent**'s board call hung for the opposite reason: the answer WAS
computed, successfully, and written into the WRONG Worker — a silent misdelivery with no refusal
anywhere on the wire (ADR 0117; `docs/research/board-tool-hang-subagent-task-response-misroute.md`).
Nothing about the daemon's `task-unsupported` refusal was wrong, nothing about it was changed by the
addressing fix, and the daemon **still** refuses with `task-unsupported` and **still** hangs until
cancel — the two facts sit beside each other unchanged. The shared symptom (a tool call that never
resolves) is what makes the pair a trap: reading this section and concluding "the hang is the daemon's
loud refusal, already accounted for" would have explained away a desktop bug that had nothing to do with
the daemon. The daemon's cost is a refusal by design; the desktop's was a wrong reply address, and it is
the one the next block records.

**The addressing rule — a Subagent's board call was answered at its PARENT's handle until ADR 0117.**
The engine's pump re-keys a child's frames to the **parent's** session id before handing them to the
desktop, correctly, because a child's UI renders in the parent's scope — that id is the frame's
**delivery address** (`CONTEXT.md`). The desktop's `TaskRequest` arm used that same id as the address to
**reply to**, so `handle_for(parent_id)` HIT, handed back the parent's `WorkerHandle`, the parent's
per-Worker pending map had no such `request_id` and ignored the frame exactly as its contract requires,
and the child stayed parked on a `oneshot` with no timeout while the Subagent **Dead bound** is disarmed
for as long as a `tool_call_id` is outstanding — 255m55s of it for one `get_artifact`. The rule ADR 0117
settles is the one `CONTEXT.md` now names with two terms: **delivery address** (the scope a frame renders
in — legal for transcripts, gates and money, never a reply address) and **origin address** (the id the
emitting loop stamps on its own frame, the only legal reply address for a request/answer pair). The arm
now answers at `task_reply_target(delivery_id, is_subagent, origin)`, which returns the frame's **origin**
id and, for a child frame carrying no origin, `None` — unroutable, with an always-on
`diagnostics::record` line naming the `request_id` — rather than falling back to the delivery id. That
wire field (`sessionId` on `Outbound::TaskRequest`) is the engine's, published as **`fulcrum-harness`
0.6.0** / tag **`v0.6.0`** (fulcrum PR #36 added the field, PR #37 released it); the desktop's arm reads
it. The two unit pins are `a_subagents_task_request_is_answered_at_its_origin_and_not_its_delivery_id`
and `a_subagent_frame_with_no_origin_is_never_routed_to_the_delivery_id`, and the end-to-end pin is
`a_subagents_task_request_is_answered_in_the_child_and_not_the_parent`.

**The 30 s Supervisor-side deadline is a backstop, not the fix — and it must never be sold as one.**
`TASK_BOARD_CALL_TIMEOUT` (30 s, a module `const` because the `Settings` value type is the crate's, not
the desktop's) wraps every board verb through `with_board_deadline`, mapping expiry to
`TaskStoreError::Io` with the sentence the Worker shows the model byte-for-byte. ITS SCOPE IS THE BOARD
VERB ITSELF and nothing else, and the arm's own comment is explicit that a bound on the call and a record
on a miss are "two different mechanisms, not one" — the deadline does NOT share the scope of the arm's
four `diagnostics::record` sites (see the next sentences, which are about those sites and not about this
bound). The honest claim about the sites is the arm's comment's, quoted
verbatim: **every path below that fails to answer** records an always-on `diagnostics` line — the
unroutable child frame, the missing `WorkerManager`, the `handle_for` miss, and a
`send_inbound_frame` `Err`. Two modes
the research doc enumerates stay **silent**, and no `record` site covers them: a panic inside the
spawned answering task (the `JoinHandle` is dropped and tokio swallows it) and a `tokio::spawn` on a
shutting-down runtime (the task never runs). And the deadline does NOT cover them either — it is armed
INSIDE the spawned future (`tokio::spawn` → `run_task_call` → `spawn_board` → `with_board_deadline`), so
a task that panics, or that never runs at all, never reaches it. Those two modes are therefore covered
by NEITHER mechanism, and the Dead bound does not rescue them either: it is disarmed while a
`tool_call_id` is outstanding, which is exactly the state of a child parked on one. They are the
residual, and they are why the non-goal this section sits under still stands. The counterfactual this
bound actually supports is NARROWER than the one it was first sold on. It turns an UNBOUNDED hang into
a thirty-second confident error for a **wedged `Db`** — the one mode where the verb itself is what is
stuck, and therefore the only mode where the timeout is the thing that answers. Against the misroute it
fires **not at all**, and that is precisely why it **leaves the misroute live** rather than softening
it — which is what ADR 0117 rejects as "the fix": masking, not curing. A misroute IS a downstream
delivery failure: the verb runs and answers, and the answer then goes to the wrong Worker. So it
belongs with the DOWNSTREAM paths and not with the wedge — where the verb completes and the failure is
DOWNSTREAM (the misroute, an unwired `OnceLock`, a `Lagged` ring drop, a stdin `break`) the deadline
never fires at all, because the call it wraps finished — and the research doc measured the exact failing
`get_artifact` at **0.00 s**, so for the misroute the margin is not close. Had it fired, the `Err` it
composed would have travelled to that same wrong handle and been dropped there, a Worker ignoring an
answer whose `request_id` it does not hold (the crate pins that behaviour as deliberate), so even a fired
bound of this shape masks, it does not route. The other three DOWNSTREAM paths are made visible by the
`record` sites (the `OnceLock` and the `send` `Err`) or by the ring's own logging, not by this bound.
**The misroute is made visible by NEITHER** — that is the finding, and it is why the addressing block
above calls the misroute a silent misdelivery with no refusal anywhere on the wire: a wrong-but-successful
send is not a miss, so no `record` site is on that path (the four cover an unroutable frame, a missing
`WorkerManager`, a `handle_for` miss and a send `Err`, and the misroute is none of them — the handle HIT
and the send returned `Ok`). And the four-hour hang this seam is named for ended on something OTHER than a
bound — the crate names settle, process exit or cancel as the only ways such a drive ends, and the research
doc reads 255m55s as a human pressing Stop, which is what a bound that never fires predicts. Three edges
of it are worth knowing before relying on it: the work is NOT cancellable (a `spawn_blocking` closure
keeps the `conn` mutex until SQLite returns), so a model retry during a wedge hits the same deadline and
you see a burst of identical timeouts rather than one; **the same non-cancellability means a call the
model was told had timed out may still COMMIT after the error was returned**, and `create_task` is the
one verb where that is visible, because it mints a fresh
`format!("tsk_{}", uuid::Uuid::new_v4())` per call — a retry after a timed-out-but-committed create
lands a **duplicate card** (`write_artifact` upserts on `ON CONFLICT(task_id, key)` and
`edit_task`/`move_task` are last-writer-wins, so a retry of those is safe); and 30 s is evidence-led —
the same value this repo chose for the naming backstop (`NAME_REQUEST_TIMEOUT`, `session/naming.rs`)
and the value the render path runs on END TO END: the engine's `exec_fetch_content` asks for a render
with `requester.request_render(url, 30_000)` (`fulcrum-harness` 0.6.0 `web/tools.rs`),
`WorkerCore::request_render` stamps that number onto the frame as `"timeoutMs"` (`worker/core.rs`), and
the desktop reads it back with an identical `30_000` fallback for a frame that omits it
(`unwrap_or(30_000)`, `session/router.rs`) — so the fallback and the value actually sent are the same
number, and 30 s is 6× the SQLite `busy_timeout` (5 000 ms, `storage/db/mod.rs`), so it cannot fire on
a healthy board read. Do not reach for a smaller number; it collides with `busy_timeout` and turns an
ordinary lock meeting into a model-visible error.

**The assertion this seam's own test does NOT make, and the trap in it.** This is the finding the next
reader will otherwise re-make, so it is stated plainly. **The artifact row is not a discriminating
assertion for a board misroute.** The router arm runs the verb on the `Db` (`run_task_call`) **before** it
decides where the answer goes (`handle_for(&reply_target)`), so a misroute **still writes the artifact
row** — the write happens, the poll for it succeeds, and the test that asserts it passes on the broken
code. Only the **tool row**, and the child's turn resolving at all, can see a misroute. This is not
inference, it is what the mutation produced: with `task_reply_target` forced to hand back the delivery id
— the pre-ADR-0117 behaviour, a one-line change — the `spec` row still landed, `wait_for_artifact` still
passed, and `a_subagents_task_request_is_answered_in_the_child_and_not_the_parent` failed instead with:

> no `role: tool` row for `call_child_write` — the tool call never resolved.

The card's own done-when named the artifact round trip as the proof of this seam, and that was **weaker
than assumed** — a test built on it would have passed both before and after the fix, which is to say it
would have been worthless while looking like coverage. The artifact assertion is not wrong (it reddens if
the arm is dropped, or answers a wrong DTO shape); it is **not the addressing assertion**, and the
addressing is pinned by exactly TWO things: the child's own `role: tool` row for `call_child_write`, and
the child closing `completed` rather than **never closing at all**. The Dead bound cannot rescue
that parked child and therefore cannot discriminate it either — it is disarmed for as long as a
`tool_call_id` is outstanding, which is exactly the state a parked board call holds (the paragraph
above, and `subagent-sessions.md` on the same rule), so NO BOUND ever ends that drive and no status is
ever reported on one — the drive stays endable only on settle, process exit or cancel, which is how the
observed 255m55s hang actually ended; the hang is the proof, being roughly 8.5× the crate's 30-minute
`DEFAULT_SUBAGENT_DEAD_BOUND`. What the close assertion sees is the ABSENCE of a close — and it is the
SECOND failure on that path, not the first: the child's `role: tool` row poll is the earlier one (a
two-stage bound — `wait_for_rows` up to 30 s, then `wait_for_tool_row` up to 30 s more, which is the
~60 s the mutation above is measured to redden in), and the test's 90 s
`subagent-closed` await is the later one, the assertion that sees the DRIVE never ending rather than
the tool call never resolving. The test ALSO asserts a
parent-side negative (`call_child_write` appears NOWHERE in the parent's transcript) and that one is
**non-discriminating** — it passes on the broken code, measured rather than reasoned: with
`task_reply_target` forced to the delivery id the predicate still held over the parent's persisted rows
(`parent-row-count=3`, `parent-negative-predicate-holds=true`). Under the misroute the frame reached the
parent's stdin, where `WorkerCore` drops an unmatched `request_id` and persists nothing, and
`TranscriptPersister` keys every write off the frame's own `session_id` and never off the delivery id,
so no child frame could land a row in the parent's transcript either way. It is kept as a cheap
invariant, not counted as a tooth. The general shape,
for a seam where a side effect and a delivery decision sit in that order: **assert on the delivery, not on
the effect** — an effect that precedes the routing cannot discriminate the routing.

**Three second-order truths, each measured, because each reads like it should be false.**

1. **A model `move_task` never fires a compaction and never runs a launch.** `grep -rn "on_enter =="
   src-tauri/src src` returns **exactly one** hit, and it is `commands/tasks.rs`'s `"compact"` arm —
   the human drag. The `TaskRequest` router arm names no `SessionManager` at all, and the trait impl
   answers `note: None` for every move. This is ADR 0092's rule (storage cannot name the
   `SessionManager`) rather than an oversight, but the consequence is worth saying plainly: **a
   model can move a card into a `compact` column and nothing compacts.** The two verbs disagree
   about what a move means, and only the human's drag is the full verb. **Amended 2026-11-23 — still
   true, and no longer the whole story about what the arm is.** "Names no `SessionManager`" describes
   what the arm does NOT do; it says nothing about what it DOES do with the identity it is handed, and
   that is where ADR 0117's defect lived. The arm has since grown a reply-addressing decision
   (`task_reply_target`) and an always-on `diagnostics::record` on **every path below that fails to
   answer** — the arm's own comment's words, and FOUR sites (the two silent modes the addressing block
   above names live
   inside the spawned task, not in the arm's decision tree), so
   it is no longer a thin dispatch worth reasoning about from its omissions alone — read the addressing
   block above rather than inferring the arm's shape from this item.
2. **The seam bypasses nothing that matters, and the title rule was the last thing it
   bypassed.** This item used to claim that the seam bypassed the command layer's refusals and
   named the artifact key grammar as the sharp one. Both halves are false now and the sentence was
   rewritten rather than deleted, the way §2's opener and §5's reversal were. **The artifact half
   closed at `2814d561`** ("D2 fix: enforce key grammar + 256 KB cap in storage backstop (was
   bypassed)"): `Db::write_artifact` owns `MAX_ARTIFACT_MARKDOWN_BYTES` and
   `artifact_key_is_well_formed` and runs both refusals BEFORE the lock, so they hold on both doors
   and **the key grammar IS enforced at storage** — ADR 0100 calls it load-bearing because a key is
   interpolated into the `<task>` launch block, and ADR 0100's amendment now records where the rule
   lives. **This item's own supporting census was false and is corrected here** — it claimed nothing
   in the tree pushes a bad key or an oversize markdown through the seam and that every
   `TaskCall::WriteArtifact` in the tests uses `"spec"`, while `router.rs`'s
   `run_task_call_refuses_a_bad_artifact_key_and_an_oversized_markdown` and `fulcrum_seams.rs`'s
   `the_task_store_refuses_a_key_outside_the_grammar_and_writes_nothing` do exactly that, over
   `My Spec`, `a<b`, `spec"id`, `UPPER`, `""` and a 41-character key. **The title half closed on
   this branch**: a neutral crate-root leaf module owns `clean_title`, the inherent `Db::create_task`
   / `Db::edit_task` clean-and-refuse before the lock, and `BoardError::EmptyTitle` maps
   variant-to-variant onto `TasksError::EmptyTitle` and onto `TaskStoreError::Invalid` — one sentence,
   both doors, `require_title` left as a refusal-only pre-flight (ADR 0101's amendment records that
   shape). **The constraint a future reader will get wrong is that `clean_title` is NOT idempotent** —
   `  " Foo "  ` cleans to ` Foo ` once and to `Foo` twice, the trim running before the quote strip
   (pi's chain order) — so exactly one layer may clean and it is storage, pinned by
   `a_title_is_cleaned_once_not_twice`, and a naive `trim().is_empty()` has the **wrong refusal set**:
   it is `false` for `""` and `''` as two-character strings, the two cases
   `require_title_cleans_like_the_session_namer_and_refuses_an_empty_one` names as the reachable ones.
   What stays open is what is NOT argument validation — items 1 and 3 beside this one, `list_board`
   not seeding the stages `get_board` seeds, and `Clear` on `title` staying in the command layer
   because the seam maps `None → Keep` and no wire value a model can send expresses a clear.
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

## 8. A configured `next_slugs` can never be UN-configured — the state ADR 0099 argues for is unrecoverable

**Added 2026-11-14 while shipping the `edit_task` clear (PR #189).** That card's research report
found this beside-defect and deliberately left it un-investigated; the report survives, but it is
titled for the `edit_task` question, so nobody looking for a Stage-graph gap would find it. It
belongs here.

**The shape.** `stages.next_slugs` is a nullable TEXT column and ADR 0099 spends real argument on
what `NULL` *means* — "unconfigured, unconstrained", explicitly NOT the same thing as `[]`, which
means "configured, no outgoing transitions". Collapsing the two is what that ADR calls the
silent-green shape it refuses. But **no verb can produce `NULL` once a value has been written**:

- `Db::set_stage_next` is the ONLY statement in production that writes the column
  (`grep -rn "UPDATE stages SET next_slugs" src-tauri/src --include=*.rs` → **2** hits, one in
  `storage/db.rs` and one in `storage/db/tests/mod.rs`), and its `slugs` parameter is a plain slice
  that is always serialised — `[]` becomes the JSON `"[]"`, never `NULL`. Its own doc says so on purpose.
- There is no `clear_stage_next`, no sentinel, no optional parameter. The signature has no third
  state to express.
- A fresh row IS `NULL` — both `seed_default_stages` and `create_stage` leave `next_slugs` out of
  the column list, and the seed's comment says that absence is deliberate (ADR 0099). So `NULL` is
  reachable **once**, on insert, and unreachable **again** after that.

**Why it is not merely theoretical.** `lenient_next_slugs` reads `NULL` as `None` and the strict-move
gate under `spaces.board_strict = 1` passes `None` **unconditionally** (its comment reads "NULL passes
unconditionally") — unconfigured means every destination is legal. So the difference between `NULL`
and `[]` is the difference between "this column can go anywhere" and "nothing may follow this column",
and it is user-visible: a user who configures edges and then wants the column back to unconstrained
cannot get there. They can only get an explicit empty graph, which under `board_strict` refuses every
move — the exact opposite of what they asked for.

**The workaround, and why it is not the fix.** Delete the Stage (`delete_stage`) and re-create it
(`create_stage`), which inserts with `next_slugs` absent and therefore `NULL`. It costs three things
the user did not ask for — `delete_stage` refuses while cards sit in the column without a
`relocate_to`, the recreated column lands at `MAX(sort_order) + 1` so its position is lost, and
`on_enter_skill` must be re-supplied by hand. Reaching an already-defined state by destroying and
rebuilding the row is not a repair.

**This is the same class as the `edit_task` hole PR #189 closed, reached from the other side.** There
the bug was a `COALESCE` patch whose `NULL` meant "leave it alone", so no value could clear a column;
here the bug is a plain-assignment writer that can only ever assign. Different mechanism, different
owner, same shape — *a state the schema admits and the ADR argues for that no verb can reach*. The
fix shape already has a precedent in the same file — `Db::set_stage_skill` takes an `Option` and
clears with a plain assignment, pinned by `set_stage_skill_sets_and_clears_the_skill` — so making
`set_stage_next` accept an optional slice would follow that precedent rather than invent one.

**Not fixed by #189, deliberately** — that card's scope was the `tasks` patch verb, and a Stage-graph
change moves `StageEditor`'s contract as well as storage's.
