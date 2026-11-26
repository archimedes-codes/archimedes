---
status: current
last-verified: 2026-11-25
verified-by: 3 parallel researcher subagents (read path / write path+executor / retirement+back-compat) read against `feature/tool-separation` at `3c0bca1d`, plus first-person re-verification of every load-bearing claim and one read-only SQLite census of the live production database (`~/.local/share/archimedes/archimedes.db`, 2,989 sessions) — no test was executed, so every "would redden" below is derived from what an assertion compares, not from a run
task: tsk_6ff47c39-9d12-4d10-a820-b102fa705569
---

# A `mark_ready` host verb — the read path moves, the verb's name is illegal, and `update_session` should not ride along

**Settled question (one sentence):** for the `mark_ready` + `update_session` host-verb pair, what must change on the read path, where does the write path land, and what happens to the magic-word marker and to Sessions already persisted under it — given the owner's decision that a persisted `ready` column **is** in scope and the restart boundary is the bug worth fixing.

**Scope note.** The owner chose **both** session verbs and **standard depth (3 angles)**. The angles
were: the read path, the write path and executor, and retirement/back-compat. `update_session` is
answered in §6 and the recommendation there is *against* it — that is a finding, not a scope reduction.

**Verified against `main` at `adec7dbe`.** Tool separation is **merged** — PR **#220**
(`feat(host-tools)!: the Client owns the 7 board verbs; the crate's Tasks are gone (ADR 0102 / #183)`),
and the ready-marker trailer is `391d322a`. Every file, test name, count and line cited below was
re-checked at this HEAD after the merge, including through PR **#219**'s concurrent Task-card redesign
(which moved lines in `TaskCard.tsx` and `TasksBoard.tsx` but changed none of the findings — the
ready-mark consumer is still `TasksBoard.tsx:436-437`, the glyph is still `data-testid="task-card-ready"`,
and `cardMarkOf` is still `sessionStatusRollup.ts:120`). Re-measured here: `GATED` **19**, `gate()` call
sites **19**, `open.rs` **967** code lines, `exec.rs` **290** code lines,
`HOST_TOOL_NAMES: [&str; 7]`. Per `AGENTS.md`, cite by content and recompute the path — these numbers
are this HEAD's, not a plan's.

---

## Executive summary

Four findings change the shape of this card. Only one of them is a design decision.

1. **`mark_ready` cannot be the verb's name.** `"ready"` contains the substring `read`, and the
   host-spec ban scans **`spec.name`**, not just its prose. Renaming is mandatory, not a preference.
2. **The doc's "the read path does not change" is FALSE** — and false twice over, once with a column
   and once without. This answers the card's first open question: **no.**
3. **`update_session` should not ride along.** Every session mutator has a guard living in the command
   layer that `Db` cannot express, and a host executor structurally reaches only the unguarded method.
4. **The reliability argument for building this has no evidence behind it.** The production database
   contains **one** marker in total, and the launch trailer that tells models the convention exists
   shipped **8 h 47 m** before the database's last write. The measurement is null, not supportive.

The card's title premise is also mis-sourced (§7): **no tracked durable record ever named
session lifecycle as this seam's second consumer.** The seven-verb cap is real; the "second consumer"
line is not in any tracked file.

---

## Findings

### 1. The verb's name is illegal, and the ban's own documentation is wrong twice

`src-tauri/src/agent/host_tools/tests/surface.rs:128` `no_host_tool_spec_names_read_or_subagent`
builds `format!("{} {} {}", spec.name, spec.description, parameters_json)` and asserts neither
`read` nor `subagent` occurs. **The name is inside the scanned string.**

Verified with `python3 -c "print('read' in 'ready')"` → `True`.

| Candidate | contains `read`? | verdict |
|---|---|---|
| `mark_ready` | **yes** (`r-e-a-d-y`) | **fails** |
| description "…ready for human review" | **yes** | **fails** |
| `update_session` | no | passes |
| `mark_done`, `flag_for_review`, `session_complete` | no | viable |

Two defects in the constraint's own documentation (`specs.rs:21-36`), both machine-verified:

- `specs.rs:31` lists **`threshold`** as poisoned. It is not (`thr/hre/res/esh/sho/hol/old`).
- The **stated reason is historical.** The doc says the ban protects
  `worker_e2e.rs`'s `!tools_section.contains("read")` assertion. That assertion **was deleted** at
  issue #180 F1 and replaced by enumerated-name comparison (`src-tauri/tests/worker_e2e.rs:769-780`,
  `assert_advertised_tools` at `:398`). The ban is still enforced by `surface.rs:128`; only its
  justification is stale.
- The poisoned list **omits `ready` itself** — the one word this card needs.

**Constraint boundary worth knowing:** the ban covers Rust `ToolSpec` strings only. The TypeScript
launch trailer and `READY_MARKER_TEXT` render outside the `<tools>` section, so the *word* `ready`
remains legal in frontend prose. Only the tool name and description are constrained.

### 2. THE READ PATH — the feature doc's claim is false, twice

`docs/features/session-ready-marker.md:66-68` and `:211` both assert a `mark_ready` verb "swaps the
*writer* only."

**(a) Even with no column, a verb is not a writer swap.** The `ready` slot's only writer is
`applyTodoUpdate` (`src/store/interactive.ts:467`), fed by four call sites that all receive **todo
frames the renderer already gets**: `src/App.tsx:185` (live listener), `src/store/sessions.ts:2223`
and `:2504` (the two `history_page` seeds), `src/store/sessionLifecycle.ts:31` (the close carry).
A Host tool is not a frame. `exec.rs` contains **zero** `emit`/`sink`/`Emitter`, and the router's
`HostToolCall` arm answers only back over `Inbound::HostToolResponse`
(`src-tauri/src/agent/session/router.rs:319-445`) — no `sink.emit` anywhere between `:319` and the
next arm at `:445`. A verb that writes Supervisor-side SQLite **leaves the renderer's map untouched**.
A new read site or a new frame is required either way.

**(b) With a persisted column in scope, the read path necessarily changes.** There is exactly **one**
existing channel by which the board learns a per-session SQLite fact for a Session it has never
opened — `get_board`'s link statement JOINing `sessions` to read `s.cost_usd`
(`src-tauri/src/storage/db/board.rs:97-101`). `list_sessions` is not an alternative: `SessionRow` and
`SessionInfo` are **crate types** (`src-tauri/src/types.rs:21` → `fulcrum-harness` 0.8.0
`store_rows.rs:44`/`:124`) carrying no `ready`, no `todos_json` and no `parent_session_id`, so that
route costs a crates.io publish plus a pin bump. The focus-driven refresh is not one either —
`mergeRefreshedSessionRows` (`src/store/sessions.ts:1839-1910`) copies only `contextUsage`,
`configOptions`, `title`, and skips unknown ids.

So closing the restart boundary means **extending the board query**, and that surface is triple-fenced:

- `FROZEN_CARD_KEYS = ["task","sessions","costUsd","artifactKeys"]`
  (`src-tauri/src/storage/db/tests/board.rs:674`) and
  `FROZEN_LINK_KEYS = ["taskId","sessionId","stageSlug"]` (`:693`);
- a byte-identical TypeScript mirror (`src/store/tasks.test.ts:1416-1456`, parsing
  `src/lib/tauri/types.ts:463`/`:566`);
- a source-text pin requiring the projection's index 3 to be exactly `s.cost_usd`
  (`storage/db/tests/board.rs:834-906`) — a new term is legal **only after** index 3.

The consumer that changes is `TasksBoard.tsx:436-437`:
`card.sessions.some((link) => readyBySession[link.sessionId] === true)`. `TaskCard.tsx` and
`cardMarkOf` (`src/lib/sessionStatusRollup.ts:120-138`) take a boolean and **do not change** — so the
defensible version of the doc's sentence is *"the render half of the read path does not change."*

**(c) The clear-on-next-turn rule does not survive a column.** The owner's rule is "the next turn
clears it," implemented by `beginTurn` → `clearReady` (`src/store/sessions.ts:2668`). `beginTurn` is
**frontend-only** (call sites: `useChatPromptDispatch.ts:321`, `taskLaunch.ts:598`,
`usePromptQueueFlusher.ts:97`), and nothing on the `send_prompt` path writes `sessions`
(`src-tauri/src/agent/session/mod.rs:2196-2200`; `begin_user_turn` is a documented **no-op** at
`:1450-1458`). `useInteractive` has no `persist` middleware. **A column cleared only in the renderer
returns `ready` on every launch** — a worse defect than the one it fixes. Closing the boundary
therefore needs a **new Rust write** at turn start (the natural site is `send_prompt_with_images`,
where `self.driver.db` is already in hand), and the **inversion** of
`src/store/sessionReadyMark.test.ts:234` — "a session whose history is NEVER opened after a restart
has NO mark", which pins the boundary as *intended*.

**(d) Ordering, already correct and worth preserving.** In both dispatch paths `beginTurn` runs
*before* `sendPrompt` (`:321` vs `:328`; `:598` vs `:606`). A Rust-side clear must be paired with the
frontend clear or the two disagree for one frame.

### 3. The true cost of the column (the doc prices only the gate)

`docs/features/session-ready-marker.md:114-116` says a column "is a 20th migration gate — deliberately
not paid." The gate is the *cheap* part. Measured edit surface for `sessions.ready`:

1. the `sessions` DDL in `SCHEMA` (`src-tauri/src/storage/db/mod.rs:1159-1177`);
2. a `gate(&mut conn, "sessions", "ready", …)` call (measured: **19** call sites today);
3. `GATED: [(&str,&str); 19]` → `20` (`storage/db/tests/open.rs:1014`);
4. the fixture array `[(&str,&str); 16]` → `17` (`open.rs:1035`);
5. author `SCHEMA_WITHOUT_READY` in `storage/db/tests/support.rs`, **and** add `ready` to the
   `legacy_sessions_complete!` macro (`support.rs:225-245`) — miss the macro and 7 other gates each
   see two omissions and all redden;
6. **18 hand-written `CREATE TABLE sessions` fixtures** must stay column-complete (measured:
   `migrations.rs` 3, `open.rs` 5, `support.rs` 10, `tests/storage.rs` 1). `open.rs:431-437` records
   this exact trap firing once before, on a `title_stage` fixture that silently omitted
   `parent_session_id` too;
7. four fixtures stay deliberately multi-omission and must **not** be "fixed"
   (`support.rs:836`, `migrations.rs:28`/`:494`, `open.rs:29`/`:113`/`:259`, `tests/storage.rs:265`);
8. a dedicated legacy-database test for the gate;
9. **5 prose counts saying "nineteen"** (measured across `db/mod.rs:17`, `open.rs:1`, `:8`, `:1199`,
   `support.rs:95`) — this class has already rotted once: `open.rs:961` says "fifteen" while the array
   holds sixteen;
10. only if projected: `SESSION_COLUMNS` + `SESSION_ROW_FIELDS` + the mapper
    (`storage/db/rows.rs:45`/`:58`/`:77-90`) **and** its independent mirror
    `EXPECTED_SESSION_COLUMNS` (`storage/db/tests/rows.rs:89`). `parent_session_id` is the precedent
    for *not* touching these (`open.rs:726-731`: the column is deliberately invisible to the row
    structs so the crate type never moves).

**The size ratchet bites.** `storage/db/tests/open.rs` is at **967 code lines** against its **1,000**
test-class gate (measured with the repo's own classifier, `grep -vcE '^[[:space:]]*(//|\*|/\*|$)'`).
A new fixture plus a dedicated test very likely crosses it, forcing a `--update` ledger diff a reviewer
must be told to accept.

**A non-gated column has no precedent.** `stages.on_enter` is the only ungated column and it arrived
*whole with its table* (`git show 18592d0a:src-tauri/src/storage/db.rs`). `open.rs:1168-1177` explains
that gating a new **column** onto a pre-existing table is precisely what the migration factory is for.
An ungated `sessions.ready` fixes fresh databases and breaks every existing install the first time any
SQL names it — and the column's whole purpose is to serve a Session that has never been opened, so the
board SQL *must* name it. The honest options are "gate it" or "don't add it".

### 4. THE WRITE PATH — the plumbing exists and stops one hop short

`Outbound::HostToolCall` carries `session_id: Option<String>` — the **origin** address, stamped once
from `env.session_id` at the channel (crate `worker/core.rs:414-418`; the field's own doc calls it "the
id of the Worker that EMITTED this frame, the CHILD for a Subagent"). Today the router binds it as
`origin_id` (`router.rs:321`), consumes it **only** as a reply address through
`task_reply_target(session_id, is_subagent, origin_id)` (`:387`, the function at `:950-956`), and
drops it: `host_tools::run(&db, &tool, params)` (`:407-410`) receives **no session identity at all**.
`exec`'s `match` is keyed on seven string arms (`exec.rs:87-98`).

So `mark_ready` is a **signature change**, not a new mechanism: thread `origin_id.as_deref()` into
`run`, add an arm.

**This is structurally the right answer, not merely a convenient one.** `params` is untrusted model
JSON; `origin_id` is Worker-supplied. Taking the subject from `origin_id` makes the verb
**un-spoofable** — a model cannot mark another Session ready, and does not need to know its own id.

- **Codemode nested calls** carry the same id (`dispatch_nested` resolves through the loop's own
  registry; the `HostTool` executor's channel was built once per Worker), so a script marks its own
  Session. Reachability is `ScriptAccess::Allowed`, pinned by the crate's `a_nested_call_reaches_a_host_entry`.
- **`Option` must be handled.** In production it is always `Some` (the envelope value is non-optional),
  but `None` is reachable (the crate's round-trip fixture exercises it). ADR 0117's rule is that a
  delivery address is never a reply address (`docs/decisions/0117-…:47`), so the honest answer to
  `None` is a **refusal**, never a fallback to the delivery id. Nothing in the tree states this yet.

### 5. The child-session case: determined in code, undetermined in intent

A child's frame carries the **child's** id — `subagent_flow.rs` builds the child envelope with
`child_id` (`:866-871`) and children explicitly inherit `host_tools`
(`env.with_host_tools(parent_env.host_tools.clone())`, `:945`; the desktop's single hop is
`agent/session/mod.rs:1791`). So `mark_ready` inside a subagent marks the **child**. Not a gap.

**But that answer is nearly meaningless.** A child's row is `is_subagent = 1` and hidden from
`list_sessions`; and a child's `todos_update` **never reaches `todos_json` at all**
(`router.rs:46-52`: "the todo panel is a MAIN-session surface", pinned by
`sink_frame_interactive_event_todos_update_persists_for_main_not_subagent` at `:1572`). Cards link to
the launching session. **A child's `mark_ready` would write durable-looking state that nothing
renders, and the parent — the session the card is linked to — stays unmarked.**

`is_subagent` is already `route_event`'s second parameter (`router.rs:28`), so the guard is free. What
it should *do* — refuse, propagate to `parent_session_id`, or no-op — **is a product decision the code
does not answer.** This is the one genuinely open question on the write path.

### 6. `update_session` — recommend against

`exec::run` holds only `&Arc<Db>`. Every model-facing candidate field has a guard living **above**
`Db`, so a host tool structurally reaches the **unguarded** method:

| Mutator | Why a model-facing setter is wrong |
|---|---|
| `set_session_archived` (`sessions.rs:327`) | the command wraps it with a caller-supplied **liveness guard** + child-transcript **prune** + flush (`commands/history.rs:188-196`, `:247-260`); `Db` is "an id-only UPDATE with no liveness condition, correct for the flag and useless as a guard" |
| `delete_session` (`sessions.rs:407`) | the cascade destroys the parent's rows and `parent_session_id` has **no FK**; the caller must run the per-parent retention prune first |
| `update_session_capabilities` (`sessions.rs:59`) | carries model + thinking level; a model changing its own model is a user cost/policy decision, and the live path needs the IPC re-synthesis |
| `set_session_title` / `_title_stage` (`:389`/`:370`) | titling is level-triggered from undroppable supervisor calls (ADR 0088) and CAS-guarded on `title_stage`; a setter races the naming pass |
| `reorder_sessions` (`:352`) | ADR 0075: manual position belongs to the user |
| `record_session_todos` (`:101`) | `manage_todo_list` already owns this as a loop arm; a second writer of `todos_json` is a second owner |

**`edit_task` is the precedent and it argues this way.** Storage gained three-state
`FieldPatch{Keep, Set, Clear}` (`storage/db/mod.rs:188-195`) and the IPC command reaches `Clear`
through `tauri::ipc::Request` (`commands/tasks.rs:203-215`), while the model-facing tool deliberately
folds to `Keep`/`Set` only (`exec.rs:236-249`), pinned by
`an_optional_field_absent_or_null_leaves_the_card_field_alone` (`host_tools/tests/verbs.rs:246`).
The surviving reason is **expressiveness-as-privilege**: a generic `update_session {…}` over a JSON
object has no closed field set, and every field carries a guard the executor cannot express.

If a second session verb is ever wanted, the shape the repo endorses is **one narrow verb per intent**
with an explicit non-null-expressible parameter set — not a patch verb.

### 7. The card's own provenance is mis-sourced

`docs/features/session-ready-marker.md:45-46`, `:208` and `src/lib/readyMarker.ts:38-40` all cite
**"ADR 0102 §5"** (the seven-verb cap) and **"§6"** (session lifecycle as the seam's second consumer).
Verified: **ADR 0102 has no numbered sections** (headings are `Considered options`, `Consequences`,
`Amendment`), and `mark_ready`, `lifecycle`, `second consumer` appear **zero times** in it. The cap is
real but lives in `docs/roadmap/tool-separation.md:331-337` ("§5. Explicitly not in this spec … **No
host tools beyond the 7**") — a **gitignored** file which also has **no §6** and never mentions session
lifecycle or readiness.

**There is no tracked durable record that session lifecycle was ever named as this seam's second
consumer.** The card's title — "the session-lifecycle tool ADR 0102 deliberately left unshipped" — is
therefore sourced from a file that is not in version control. If the verb is built, that is the
load-bearing claim being spent; if it is not, the citations should be corrected.

Two more stale pointers found: `specs.rs:16` cites `agent/tests/tool_surface.rs`, **which does not
exist** (the real file is `agent/host_tools/tests/surface.rs`), and `AGENTS.md:167` cites `seams.rs`
at 221 code lines (measured **92**).

### 8. The cost an 8th spec pays whether or not a column is built

| Pin / site | Effect of adding a host verb |
|---|---|
| `host_tool_specs_are_exactly_the_seven_board_and_artifact_verbs_in_order` (`surface.rs:30`) | **reddens** — `const HOST_TOOL_NAMES: [&str; 7]`, the length is a type; its message already names "a second host tool beyond the seven ADR 0102 §5 allows" |
| `the_composed_advertised_set_is_the_twenty_six_names_a_session_saw_before` (`surface.rs:70`) | **reddens** — a 26-name sorted literal plus `assert_eq!(len, 26)` |
| `every_host_tool_spec_advertises_the_keys_its_executor_reads` (`surface.rs:155`) | **reddens** — a 7-row `(name, advertised, required)` table |
| `no_host_tool_spec_names_read_or_subagent` (`surface.rs:128`) | **reddens** on any name/description containing `read` (§1) |
| `list_tools_lists_the_engine_tools_and_the_host_tools_together` (`commands/settings.rs:876`) | **does NOT redden** — the 7-name loop is a *subset* assertion and the length is computed. It will not tell you the new verb reached Settings. Adding the name to the loop is the only tooth. |
| `d2_ships_the_artifacts_block_and_the_verbs_that_answer_it_together` (`commands/tasks/tests/artifacts.rs:471`) | stays green, **but names files deliberately** — splitting `specs.rs` reddens needles 2–3 and forces a re-point plus the per-file string-literal hand-check |
| `src/lib/toolDetailsRegistry.test.ts` | a new `details` key costs **four** coordinated edits (a 40th `PRODUCER_KEYS` entry at `:174-181`, a 40th `FrozenProducerTuple` at `:200-207`, a Part-2c reason, a Part-3 fixture group). **`details: None` avoids all four** — `get_artifact` is the in-tree precedent (`exec.rs:339-344`) |
| prose counts of "seven" | ~20 sites across `exec.rs`, `specs.rs`, `mod.rs`, `commands/settings.rs`, `artifacts.rs`, `agent/session/mod.rs` |

`spawn_board` / `TASK_BOARD_CALL_TIMEOUT` are board-vocabulary names, so a session verb riding them
emits `"Supervisor \`mark_done\` board call failed"`. The router arm's own comment states the rule this
breaks: frame vocabulary in a log line "is a lie in a log a supporter reads" (`router.rs:369-377`).

**Executor placement.** `exec.rs` is **290** code lines (production gate 800, seed 700, not baselined),
so size does not force a split. The repo's rule does: "the default move is to extract, not to add …
split on a subject boundary" (`AGENTS.md`), and `exec.rs` names its own subject in its header ("The
SEVEN board / artifact executors"). A session subject is a **second subject**. Note ADR 0113's mirror
rule: today `host_tools/tests/` is named *by subject* (`{mod, surface, shape, mapping, verbs}`) and
cuts **across** verbs, so a mirror split is a re-partition, not a rename.

### 9. Retirement, back-compat, and a live drift bug

**The backfill-precedent question came back against the hypothesis that there is none.** Data steps
inside a gate are well established: `title_stage` (`db/mod.rs:832-842`, `UPDATE … WHERE title IS NOT
NULL`), `on_enter_skill` (`:865-882`, whose `IS NULL` clause the comment calls out as "what makes the
statement a backfill rather than an overwrite"), `todos_json` (`migrations.rs:28-130`), both
`sort_order` seeds, and the `native_messages` FK table recreate. **The binding constraint is
different:** ADR 0107 `:61-75` records that a *data-only* migration has **no latch** — no
`user_version` pragma, no migrations table — so a `ready` backfill **must ride an `ALTER` in one
gate**, which the three above all do. That is the shape to copy.

**The default-value trap is live and already has a tested rule.** `cost_usd`, `parent_session_id`,
`auto_max_steps`, `position_x/y` all arrived `NULL` with **no `DEFAULT` and no backfill**, each pinned
by a `dflt_value IS NULL` test, because `0`/`false` is an *answer* and `NULL` is the *absence of one*.
A boolean `ready` column inherits this: `0` would assert "not ready" for every pre-existing Session —
a claim about work nobody re-checked. So the column should be `NULL`-able, and the backfill (if any)
must set only the rows that actually earned the mark.

**ADR 0093 is the closest retirement precedent and its answer is "readers go dual, permanently"** —
its dual-match predicate (`manage_todo_list` OR `manage_checklist`) exists because stored
model-authored strings are never rewritten, and the release-order rule requires the **widen to ship
before** the rename that makes it necessary. Applied here: keep the word as a fallback reader. The
counter-weight is the one-funnel principle (`interactive.ts:450-466`: "a second site is where the two
would drift").

**A live defect, verified first-person.** `src/store/interactive.ts:133` declares a **second**
`READY_MARKER_TEXT = "ready"` literal, and `src/lib/readyMarker.ts:21` claims "the detector imports the
word DOWNWARD". It does not — `interactive.ts`'s only import is `zustand` — and **no test relates the
two literals**. `layerBoundary.test.ts` forbids `lib/ → store/` but does **not** forbid the downward
`store/ → lib/` import that would fix this. **The word can be changed in one layer today with a fully
green suite** — the exact drift the module's header says it exists to prevent. This is independent of
any verb and worth fixing regardless.

Also stale, all verified: `interactive.ts:102-117` and `interactive.test.ts:228-231` still assert the
engine gate is live ("#183 is the approved, **unbuilt** fix") — false since 2026-11-25; and
`interactive.ts:126-130` still says "Nothing in the app tells a model the convention exists" — false
since `391d322a`, the commit that added the trailer. The tree currently holds **two opposite accounts
of the same gate in three files.**

### 10. The measurement — the reliability case is unsupported

All three research angles reported the same gap: no evidence of what models actually write. It was
measurable, so I ran a **read-only** census of the live production database
(`file:…/archimedes.db?mode=ro`, 2,989 sessions, 120 with `todos_json`, 99 linked to a card):

| Measurement | Result |
|---|---|
| Todo items containing `ready` (substring) | 10 |
| …that are the **exact** marker with `status: completed` | **1** |
| …that are the exact marker with the **wrong** status (the silent no-op) | **0** |
| Plausible-but-failed hand-off attempts (≤40 chars, about readiness) | **0** |
| The 9 near-misses | all incidental — `"…already on main…"`, `"Ready glyph: amber bell…"`, `"READY TO MERGE"` inside a longer status line — and **correctly declined** |

**The confound that kills any conclusion:** the launch trailer that tells models the convention exists
shipped in `391d322a` at **2026-11-25 15:03**; the database's last write is **22:57**. An **8 h 47 m**
observation window, 31 sessions created in it, **4** with any todo list. And the single exact marker
belongs to a session created **2026-11-11**, seven days *before* the convention existed — a coincidental
plan item, not a hand-off claim.

**So: no measurable failure rate for the exact-match rule, in either direction.** The mechanism is real
in code — the engine validates only that `content` is non-empty and `status ∈ {pending, in_progress,
completed}` (crate `interactive/mod.rs:275-300`), then stores, emits, and returns `is_error: false` —
so a model writing `"Ready for review"` does get a success message for a claim nothing recorded. But
**nothing observed it firing.** Anyone arguing this card on reliability is arguing an unmeasured
mechanism. A re-run in a few weeks, once the trailer window is long enough to mean something, is the
cheapest way to settle it.

### 11. What is genuinely FOR building it (stated fairly)

- **Two channels in one payload is a real design smell.** The engine's own `<rules>` line tells the
  model the todo list tracks *multi-step work* (crate `prompt.rs:15`); the marker asks the same channel
  to also mean *hand-off*, and the `completed` requirement exists only to disambiguate two readings of
  one word.
- **A verb's failures are loud, the word's are silent.** Disabled → `tool not enabled: <name>` with
  `is_error: true` (crate `loop/tools.rs:102-116`); an unroutable host frame is recorded always-on.
  The word has **no off-switch at all** — a Settings checkbox for the verb is a genuine gain.
- **The mechanism is now cheap on the write side** — one arm, one signature change, one spec.
- **Scope widens, which may be a feature.** Today only card-launched Sessions are told the convention
  (`buildLaunchMessage` has one production caller, `taskLaunch.ts:586`), which the doc calls *correct*
  "since `ready` is a claim about a Task". A tool description is session-agnostic, so sidebar,
  workspace, and child Sessions would gain the ability. That is a decision, not a free win — and it
  needs a story for a call from a Session with no card link, since `cardMarkOf` renders on cards only.

### 12. What is AGAINST (stated fairly)

- **The repo already says the mark's job is not reliability.** `src/lib/sessionStatusRollup.ts:110-118`:
  "`ready` is a CLAIM and `sessionStatus` is a DERIVATION… A false `ready` is a model lying about being
  finished, which the mark surfaces rather than conceals." A schema-valid call is still an assertion by
  the model. *(Note: the follow-up record's quote "a tool buys clean semantics and a schema, not a more
  reliable model" appears **nowhere in the repo** — `sessionStatusRollup.ts` is the nearest durable
  statement of it.)*
- **The verb must re-buy withdrawal semantics the todo channel gives free.** Today four mechanisms
  withdraw the claim (a later snapshot without the item, a status flip back to `pending`, a
  `todos_clear`, the next `beginTurn`), all pinned. They are free because "manage_todo_list rewrites the
  whole list on every call, so a snapshot WITHOUT the marker is the model withdrawing the claim." An
  additive verb has no snapshot to withdraw from and needs a new, unpinned rule.
- **The mid-plan conflict is already reachable and already answered**, so a verb resolves nothing new:
  `interactive.test.ts:312-324` *pins* a board that is simultaneously mid-plan and ready; `cardMarkOf`
  resolves it to one glyph (`waiting > ready > running`).
- **The measurement (§10) shows no observed cost to the status quo**, and the column costs §3's ~11
  edit sites plus a likely size-ratchet diff.

---

## Unresolved contradictions

1. **Doc vs code on the read path.** The doc is `status: live` and wrong (§2). It must be **amended**,
   not ignored — and `sessionReadyMark.test.ts:234` must be **inverted**, not updated.
2. **Doc vs code on the two literals (§9).** Code is simply broken here; the header asserts a property
   the tree does not have.
3. **`docs/roadmap/` recoverability** is stated as absolute in two feature docs, but two roadmap files
   *are* tracked (`git ls-files docs/roadmap/`). The "unrecoverable" claim is the operative convention,
   not a filesystem fact — which is exactly why §7's citation went unchallenged.

## Gaps

1. **The child-session intent** (refuse / propagate to parent / no-op) — a product decision, the one
   open question on the write path.
2. **No desktop-side "advertised and unreachable" census for the host half.** `HOST_TOOL_NAMES`
   (`surface.rs:19`) and `exec`'s `match` (`exec.rs:87-98`) are **two lists with no cross-assertion**,
   and the crate's own 26-name census composes against a hand-spelled 7-name **fixture**
   (crate `tool_specs.rs:1860-1888`), so it stays green regardless of what the desktop ships. **An 8th
   spec with a missing executor arm is caught by nothing** — only the loud runtime `other =>` refusal.
   This is a gap worth closing independently of this card.
3. **The failure rate is unmeasured, not measured at zero.** 8 h 47 m of observation.
4. **No test was executed.** Every "would redden" is derived from what the assertion compares. A
   planning run should confirm the §8 table by adding a throwaway spec and running the suite.
5. **Non-string host parameters are new ground** — `req_str`/`opt_str` handle `&str` only; there is no
   `req_bool`/`req_num` and no test covering the shape.
6. **`narrow` still cannot filter host verbs** (ADR 0102 Amendment's third correction;
   `docs/features/permissions-model.md` §f.2), so an 8th host verb is **inherited by every child and
   cannot be withheld by a definition's `tools:` frontmatter** — only by the parent's `enabled_tools`.
   Card #46. Equally true of board verbs; it is a property of the class, not the subject.
7. **Host tools land in `ToolKey::Unrecognized`**, so a `permission:` block naming a session verb is
   "a disclosure, not a control" (`permissions-model.md:115`, `:170`; ADR 0084 `:70`). Card #45.
8. **No `CONTEXT.md` glossary entry** for the ready marker, so ADR 0086's naming rule has no term to
   govern either the retirement or the replacement.

---

## Evidence

**Primary local sources** (all read, `repo:path:line` above): `docs/features/session-ready-marker.md`;
`docs/decisions/0102-…` incl. its 2026-11-25 Amendment; `docs/decisions/0093`, `0084`, `0107`, `0113`,
`0117`; `docs/roadmap/tool-separation.md` §5; `src-tauri/src/agent/host_tools/{mod,specs,exec}.rs`;
`agent/host_tools/tests/{surface,shape,verbs}.rs`; `agent/session/router.rs`; `agent/session/mod.rs`;
`storage/db/{mod,board,rows,sessions,tasks}.rs`; `storage/db/tests/{open,support,board,rows,migrations}.rs`;
`commands/{settings,history,tasks,sessions}.rs`; `src/lib/{readyMarker,taskPrompt,sessionStatusRollup}.ts`
+ their tests; `src/store/{interactive,sessions,tasks,taskLaunch,sessionLifecycle}.ts`;
`src/store/{interactive,sessionReadyMark,tasks}.test.ts`; `src/components/{TasksBoard,TaskCard}.tsx`;
`src/lib/toolDetailsRegistry.test.ts`; `src/lib/layerBoundary.test.ts`; `scripts/check-file-size.sh`.

**Engine text** — the crates.io-pinned `fulcrum-harness = "0.8.0"` (`src-tauri/Cargo.toml:145`), read
from the immutable registry extract. Labelled *crate:* above. The sibling checkout at
`/home/daniel/Coding/Archimedes/fulcrum` was deliberately **not** used as authority:
`.cargo/config.toml` is absent, so the build consumes the crates.io crate, not the sibling.

**Production measurement** — `sqlite3` / Python over `file:~/.local/share/archimedes/archimedes.db?mode=ro`
(`mode=ro`, no writes): 2,989 sessions, 120 with non-null `todos_json`, 99 present in `task_sessions`,
last `created_at` 2026-11-25 22:57. Trailer commit timestamp from
`git log -1 --format=%ad 391d322a` → 2026-11-25 15:03 +0100.

**Credibility note.** Code and tests are the highest tier and everything above is read from them. The
one place a first-person check *overturned* a subagent report is the fixture count in §3: reported as
8 hand-written `CREATE TABLE sessions` fixtures, measured at **18**. The reverse also applies to the
doc: `session-ready-marker.md` is `status: live` and its central claim about this card is false.
