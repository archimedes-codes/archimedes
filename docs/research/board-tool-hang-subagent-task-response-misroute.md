---
status: current
last-verified: 2026-11-23
verified-by: mixed — desktop + engine source audit (2 repos, ~30 files) with parent re-verification of every load-bearing link, local SQLite measurement against the live 3.0 GB file, and a tokio/tarball source read; 3 researcher dispatches at HEAD 07ccb4f3 (archimedes) / 20e6060 (fulcrum), engine read from the crates.io pin fulcrum-harness 0.5.1
task: tsk_bc5c5c5a-104b-4e34-86af-06b018d725cc
---

# A board tool hangs forever in a Subagent session: the `TaskResponse` is written to the parent's Worker

## Executive Summary

**Settled question:** `get_artifact` stalled for 255m55s — does it need a timeout, or better error
handling? **Neither.** The call was answered — correctly, in under a millisecond — and the answer was
written into the **wrong process**. A timeout would have converted a four-hour hang into a confident
thirty-second lie and left the bug live.

**The root cause:** every model-facing board verb called from a **Subagent session** hangs forever.
The engine's pump re-keys a child's frames to the **parent's** session id before handing them to the
desktop (a correct rule for **UI delivery**), and the desktop's `TaskRequest` arm uses that same id as
the **reply address** (wrong for a **control-plane** frame). The parent's Worker receives a
`TaskResponse` for a `request_id` it never issued and — by design, silently, in a line the crate
documents as deliberate — ignores it. The child stays parked on a `oneshot` with **no timeout**, and the
one reaper that could fire is disarmed precisely because a tool call is outstanding.

**Scope decision (this session):** the user first constrained the fix to the desktop, then relaxed it
after seeing that the constraint cannot express the fix. The correct change is **one field on the
wire** — a `sessionId` on `Outbound::TaskRequest`, mirroring what `Outbound::FetchRenderRequest` already
carries — which lands in the engine (`fulcrum-harness`, a sibling checkout), with a small desktop change
to read it. The desktop-only bound and diagnostics are still worth landing: they are the difference
between an unbounded invisible hang and a bounded visible one, and they hold until the engine release
ships.

**The user's two hypotheses, scored:**

| Hypothesis | Verdict |
|---|---|
| "The other board tools all do this" | **CORRECT.** All seven verbs share one helper, one park, one reply address. Six of the seven are strictly *more* DB-exposed than `get_artifact` and none is safer. |
| "It's almost usually a database lock thing" | **REFUTED for this hang** — and refuting it surfaced a separate, real, undocumented finding (§5): the `Db` mutex is the true serialization point and has neither a bound nor a log line. |

**A third finding, unrelated and independent:** `move_task` calls `fs::canonicalize` **while holding the
`Db` mutex** — the only unbounded non-SQL syscall in the entire lock surface. Worth its own card (§6).

---

## Findings

### 1. The hang chain — every link verified in source

Citations are `repo:path:line` for the desktop and `fh:` for the crates.io-pinned
`fulcrum-harness 0.5.1` (`Cargo.lock:1665`, read from
`~/.cargo/registry/src/*/fulcrum-harness-0.5.1/src/`).

| # | Link | Source | Status |
|---|---|---|---|
| 1 | A subagent's frames are delivered under the **parent's** id: `delivery_id = drives[child].parent_session_id`, falling back to the child id only when the `drives` entry is gone | `fh:worker/manager/pump.rs:91-102` | VERIFIED |
| 2 | The `TaskRequest` arm receives `is_subagent` in its own signature and **never reads it**; it uses the envelope id verbatim as the reply address | `src-tauri/src/agent/session/router.rs:303`, `:322`, `:331` | VERIFIED |
| 3 | `handle_for(parent_id)` **HITS** — `workers` holds main session ids — so it returns the **parent's** `WorkerHandle`. It does not return `None`, so the `if let` succeeds | `fh:worker/manager/registry.rs:78-90` | VERIFIED |
| 4 | The frame is written to the **parent's** stdin and `send_inbound_frame` returns `Ok` | `fh:worker/client.rs:715-733` | VERIFIED |
| 5 | The parent's `pending_task_requests` is **per-Worker** and has no such entry → *"An absent entry is IGNORED, never an error and never a panic"* → `Vec::new()` | `fh:worker/core.rs:958-972` | VERIFIED |
| 6 | The child is still parked on `rx.await`. The only escapes are a real answer, a closed outbound channel at emit time, a dropped sender, or the caller dropping the future | `fh:worker/task_store.rs:100-128` | VERIFIED |
| 7 | No reaper fires: `_ = &mut sleep, if !in_flight => break Race::Dead`, and `in_flight` is populated by the `tool_execution_start` of the very call it is parked inside | `fh:worker/manager/subagent_flow.rs:1242`, `:544-551`; `fh:harness/loop/turn.rs:749-753` | VERIFIED |

**This is deterministic, not a race.** `is_subagent` is `true` for a child pump from spawn
(`fh:worker/manager/subagent_flow.rs:1005-1011`) and the `drives` entry survives the child's whole live
life (removed in `finish_subagent` only *after* `reap_worker`, `:1907`/`:1914`). So for the entire window
in which a child can issue a board call, `delivery_id == parent_id`. **100% of subagent board calls
misroute.** The recursion guard (`subagent_enabled: false`, `:881`) means exactly one pump hop, so depth
does not matter.

**Children do hold the board tools.** The child set is the parent's tool list minus `subagent` and
`list_agents` only (`fh:worker/manager/subagent_flow.rs:829-846`), and with the default empty
`enabled_tools` the child receives **all** `tool_specs()` — which includes `get_artifact`
(`fh:harness/tool_specs.rs:529`). The desktop passes `None` for the empty set
(`src-tauri/src/agent/session/mod.rs:1697-1701`) and the crate turns that into `[]`
(`fh:harness/dispatch.rs:345`).

**Why 255m55s and not 30 minutes.** The only bound that could have fired is the subagent **Dead bound**
(30 min — `fh:worker/manager/mod.rs:70-71`, `src-tauri/src/config.rs:679-684`), and link 7 above disarms
it. The crate **documents this residual about itself** (`fh:worker/manager/subagent_flow.rs:1216-1229`,
verbatim):

> a STALE id — announced, never closed, and the child never settles — leaves this drive with NO timeout
> at all, endable only on settle, process exit or cancel.

The crate also names the failure mode of the seam itself (`fh:worker/task_store.rs:14-19`,
`fh:worker/protocol.rs:333-337`): an answer that never arrives is *"a hang, not an error"*. So
255m55s ≈ a human pressing Stop. The duration is itself **evidence against** any watchdog having fired.

**The bogus arguments are the tell, not a clue.** `{"task_id":"noop","key":"noop"}` passes argument
validation (`fh:tools/exec/task_tools.rs:419-427`), and `Db::get_artifact` returns `Ok(None)` for a
missing task **by design** (`src-tauri/src/storage/db/artifacts.rs:231`) — an answer, not an error, as
`docs/features/task-board-known-gaps.md` and the test
`get_artifact_answers_null_for_a_missing_artifact_and_a_missing_task` both pin. The tool should have
replied *"no artifact `noop` for task `noop`"* (`fh:tools/exec/task_tools.rs:410`) in **0.00 s**
(measured, §4). A DB stall would be *slower for a real row*, not slower for a missing one.

### 2. Why the sibling arm does not have this bug — it is a copy-fault, and the arm says so

`router.rs:305-309` states the `TaskRequest` arm *"copies its shape"* of the `FetchRenderRequest` arm.
That template does two things the copy dropped:

| | render — the template | task — the copy |
|---|---|---|
| Identity used for the reply | re-extracts `payload["sessionId"]` (`router.rs:258-262`), which the Worker stamps with **its own** id (`fh:worker/core.rs:192-197`) | **the envelope id, blindly** (`router.rs:322`) |
| Worker-side timeout on the park | **YES** — `tokio::time::timeout(timeout_ms, rx)` (`fh:worker/core.rs:210`), expiry resolves the pending entry with an error | **NO** — parks bare (`fh:worker/task_store.rs:123`) |
| Supervisor-side timeout | **YES** — three stages (`src-tauri/src/agent/web/render.rs:175`, `:214`, `:298`) plus a `saturating_sub` budget (`:263`) | **NO** (`router.rs:323-329`) |

**The asymmetry is the argument.** The one prior request/answer pair over this same wire is bounded
*twice*; the newer one is bounded *zero* times. And the render arm's identity trick is not copyable:
`Outbound::TaskRequest { request_id, call }` carries **no session id at all**
(`fh:worker/protocol.rs:341`) — deliberately, per `fh:worker/task_store.rs:47-54`, because the pending map
is per-Worker. So the arm **cannot recover the child id from the frame**. The information needed to route
the reply was destroyed upstream of the desktop.

**And the comment licensing the current code reasons about the wrong failure mode.** `router.rs:311-316`
reads: *"`handle_for` answers `None` for a session that is already gone … A frame to a dead Worker is an
ordinary miss, not an error."* For a live child neither half holds — the lookup does **not** answer `None`,
and the frame does **not** go to a dead Worker; it goes to a **live** one that is contractually forbidden
from erroring on it.

### 3. Every way an answer never arrives (the exhaustive enumeration)

The card asked whether a timeout would mask a lost-response bug. It would. Here is the full set, so the
fix can be aimed rather than sprayed.

| # | Failure mode | Status |
|---|---|---|
| 1 | **Subagent `TaskResponse` misrouted to the parent's handle via `delivery_id`; parent silently ignores the unknown `request_id`** | **LIVE — the root cause** |
| 2 | `handle_for → None` → bare `if let`, no `else`, no log, nothing sent | LIVE but not this case — reachable only post-teardown, when the Worker is gone and nothing is parked |
| 3 | `worker_manager` `OnceLock` unset → nothing sent, unlogged | THEORETICAL (boot ordering) |
| 4 | Panic inside the spawned `run_task_call` → tokio swallows it, no frame, no log, child parks forever, **no crash log** (the Worker's panic hook covers the loop task only) | THEORETICAL |
| 5 | `tokio::spawn` on a shutting-down runtime → the answering task never runs; the `JoinHandle` is discarded | THEORETICAL |
| 6 | `Lagged` drop of the outbound `task-request` line off the frame ring | THEORETICAL — and this one **is** logged |
| 7 | Stdin writer `break` after a write/flush error (`fh:worker/client.rs:446-450`) → the frame evaporates | THEORETICAL |
| 8 | `send_inbound_frame`'s `Err` discarded by `let _ =` (`router.rs:337`) | EXCLUDED — the child is alive, which is why the misroute "succeeds" |
| 9 | MAIN-session window: a pump starts before `workers.insert` (`fh:worker/manager/mod.rs:232` vs `:239-251`) | THEORETICAL — needs a Worker to act before its `Start` frame |
| 10 | `drives` entry present but `handle` still `None` (`fh:worker/manager/registry.rs:89`) | EXCLUDED — `start_pump` runs after the assignment |
| 11 | `db == None` | EXCLUDED — sends an `Err(Io)` frame |
| 12 | `run_task_call` `Err` / serialization `Err` / `spawn_board` `JoinError` | EXCLUDED — all three still send a frame |
| 13 | Answer arrives before the Worker registers the pending entry | EXCLUDED — the engine registers before emitting, pinned by `register_happens_before_the_frame_is_emitted` |
| 14 | Cross-talk: a child's answer resolves a *parent* call | EXCLUDED — `task-{uuid v4}` per call, pinned unique |

Two of these matter beyond the root cause. **#4 is the scariest** (a Supervisor-side panic produces the
identical invisible hang and no crash log). **#2, #3, #4, #5 and #7 are all silent by construction** — a
fix addressing only #1 leaves five holes that each produce the same indistinguishable symptom.

### 4. The database-lock hypothesis — refuted, and what replaced it

**`busy_timeout` cannot fire for a board verb, and this is worth stating plainly because it is the
intuition everyone reaches for.** `set_journal_pragmas` sets `journal_mode=WAL`,
`synchronous=NORMAL`, `busy_timeout=5000` (`src-tauri/src/storage/db/mod.rs:502-512`) — its docblock
explains the timeout exists because *"WAL is the first mode where a reader can meet a writer at all"*.
But SQLite's table/file locks are **between connections**, and this app has exactly **one** `Connection`
(`mod.rs:551`, opened once in `Db::open`, `app.manage`d at `src-tauri/src/lib.rs:116`/`:188`). The Worker
opens none (`run_worker()` at `lib.rs:318` has no `Db::open`; ADR 0025 makes the Supervisor the sole
SQLite writer). **So there is no second connection to contend with, `busy_timeout` can never fire, and it
cannot be what stalls a board verb.**

**The real serialization point is `conn: StdMutex<Connection>`** (`src-tauri/src/storage/db/mod.rs:540-542`)
— 51 lock statements across 7 files — and a thread queued on it has **no timeout, no `SQLITE_BUSY`, and no
log line**. That is a genuine unbounded wait. It is simply not what happened here.

**Measured against the live production file** (`~/.local/share/archimedes/archimedes.db`, 3,006,599,168 B,
472,751 `messages`, 2,810 `sessions`, 82 `tasks`, 95 `task_artifacts`), read-only, fresh process each time:

| Query | Wall |
|---|---|
| `SELECT * FROM task_artifacts WHERE task_id='noop' AND key='noop'` — the exact failing call | **0.00 s** |
| `session_recency` (the `LAST_ACTIVITY` correlated subquery, worst in the module) | 0.07–0.09 s |
| `messages_page`, latest 500 of the largest session (2,379 rows / 4.58 MB) | 0.03 s |
| `task_numbers`, `list_sessions(true)` | 0.00 s |
| Largest `task_artifacts.markdown` / largest `messages.payload_json` | 91,793 B / 250,480 B |

Independent corroboration: `docs/research/database-size-unbounded-transcript-growth.md:305-308` already
concluded *"The size is not why anything is slow."*

**No deadlock is reachable.** `std::sync::Mutex` is not reentrant, so a double-lock *would* be exactly this
hang — but every nested `Db` call drops its guard first (`tasks.rs:165` before `:170`, `:272` before
`:288`) and the helpers that would double-lock take `&Connection` and receive the caller's guard instead
(`stages.rs:367-395`, `:411`, `:427`, `:439`, `:337`). A deliberate, documented rule, not luck.

**Blocking-pool exhaustion is an honest "not it".** `spawn_board` uses `spawn_blocking`
(`router.rs:966-978`); tokio 1.53's default `max_blocking_threads` is **512**
(`tokio-1.53.1/src/runtime/builder.rs:306`), nothing overrides it, and the mutex *self-limits* how many tasks
can be in flight (it serialises them), so the pool queues rather than wedges.

**A correction to the repo's own docs, measured now:** `archimedes.db` **is** in WAL today (header bytes
18/19 = `2 2`; `archimedes.db-wal` 13.5 MB with a live mtime). `database-size-…md:332-338` and
`whole-window-jank-renderer-saturation.md:305-307` both record `journal_mode = delete` — those described
the older installed AppImage, as those files themselves note.

### 5. Exposure is general, and `get_artifact` is the *least* exposed verb

All seven model-facing verbs run `run_task_call` (`router.rs:844`) → `spawn_board` (`router.rs:966`) →
`<Db as TaskStore>::verb` → the same single mutex:

| Verb | Locks taken | Extra exposure |
|---|---|---|
| `list_board` | **1 + N** | N+1 sequential acquisitions (`seams.rs:191-211` calls `artifact_keys` per row) — the **most** DB-exposed |
| `get_task` | 2 | write-free, then `artifact_keys` |
| `create_task` | 2 | `seed_default_stages` writes inside the guard (`stages.rs:367`) |
| `edit_task` | 2 | write, then a re-read (`tasks.rs:288`) |
| `move_task` | 1 | **the `canonicalize`-under-lock site (§6)** |
| `write_artifact` | 1 | ≤256 KiB payload bound (`artifacts.rs:69`) |
| `get_artifact` | 1 | **none — the least exposed of all seven** |

So the generalisation holds for the **hang** (all seven share one park and one reply address, so all seven
hang identically in a child), and it holds backwards for the **DB** — the verb that actually hung is the
one least able to. That is more evidence against the lock.

The human-facing surface (18 board commands in `src-tauri/src/commands/tasks.rs`, all on
`spawn_blocking`) contends for the identical mutex but is **not** affected by the misroute, because a Tauri
`invoke` is not addressed by a pump `delivery_id`. Seven commands do take the mutex **inline on an async
worker thread** with no `spawn_blocking` hop — `commands/history.rs:166`, `:178` (`delete_session`, a
cascade DELETE inline), `:189` (`session_recency`, 0.07 s inline), `:202`, and `commands/spaces.rs:64`,
`:75`, `:90` — which is the head-of-line shape #155 was filed against. Notable because
`session_recency` is fetched at boot (`src/App.tsx:379`).

### 6. Separate finding: `move_task` holds the `Db` mutex across `fs::canonicalize`

`Db::move_task` takes the guard at `src-tauri/src/storage/db/tasks.rs:313` and calls
`space_key(space_path)` at `:342`, which is `std::fs::canonicalize` (`storage/db/seams.rs:343-347`) —
**while the guard is held**. Every other `space_key` caller canonicalises *before* locking
(`board.rs:440`, `:464`; `spaces.rs:43`, `:60`, `:101`), so `move_task` is the outlier. It is the **only**
thing in the entire lock surface that is unbounded and not SQLite: on a stale NFS/FUSE mount an `openat`
there can sit for minutes **with the mutex held**, stalling every DB consumer in the app — the transcript
writer, the sidebar, every board verb.

It is not the cause of this hang (a drag is a human action, and the observed stall was a model call), and
the canonicalise is *load-bearing* — the ADR 0099 comment at `tasks.rs:333-341` explains that reading the
Strict flag by the raw path would let the editor's Strict Switch show ON while drags are accepted. So the
fix is to canonicalise **before** `let guard = …`, matching `board.rs`/`spaces.rs`, not to drop the
canonicalise. **Recommend its own card.**

### 7. Detectability: today this event is invisible

- **Zero log calls in the whole `TaskRequest` arm** — nothing at the `handle_for` miss, nothing at the
  discarded `let _ = send` result (`grep -n "diagnostics::record\|debuglog" src-tauri/src/agent/session/router.rs`
  → no output).
- `debuglog::log` is a **no-op unless `ARCHIMEDES_DEBUG`** (`fh:debuglog.rs:60-63`,
  `src-tauri/src/lib.rs:358`). If it had been armed it would have been decisive: `fh:worker/client.rs:727`
  logs `→` for every inbound line, so a `task-response` written to a session that never issued a matching
  `task-request` **is the signature of this bug**.
- `diagnostics::record` is always-on once armed (`fh:diagnostics.rs:175`) and the desktop arms it
  (`src-tauri/src/lib.rs:356`) — but it is **not wired on the task path in either codebase.**
- **No `Stalled session` transition**: `handle_crash` fires only from an *unexpected process exit*
  (`fh:worker/manager/registry.rs:104-116`). Nothing exits here.
- **What the user sees:** nothing. The child's card sits `in_progress`; the parent stays parked on
  `SubagentResult`, which only arrives from `finish_subagent` — unreachable while the drive runs. The UI
  shows a live, thinking subagent indefinitely.
- **What survives afterwards:** the child's `tool_execution_start` row is left `in_progress` permanently
  (the crate's own documented unrecoverable race, `fh:worker/manager/subagent_flow.rs:1679-1699`) and the
  child never settles. A transcript audit could *infer* "announced `get_artifact`, never closed it, no
  settle" — but **nothing records the dropped frame.**

The crate already chose the right mechanism for the one other place a frame dies
(`fh:worker/manager/pump.rs:62-77`, verbatim):

> ALWAYS-ON (`diagnostics`, not `debuglog`): this is the one place a frame is DISCARDED … A line behind
> `ARCHIMEDES_DEBUG` cannot answer "why did nothing happen" for a user who never set the var.

### 8. Why it shipped green

The only end-to-end proof of this seam is `task_artifact_round_trips_through_a_real_worker`
(`src-tauri/tests/worker_e2e.rs:2529`), and it attaches a **main** session (`wm.attach`, the `workers`-map
path). On the main path `delivery_id == session_id`, so the arm is correct and the test is honestly green.
**No test in either repository routes a `TaskRequest` with `is_subagent: true`** — `grep -rn "dispatch_subagent"
tests/worker_e2e.rs` gives one doc-comment hit and no call. The bug is exclusively on the child path,
which no test crosses.

### 9. The fix, and where each half must land

**The real fix (engine, now in scope).** Add a `sessionId` to `Outbound::TaskRequest` — exactly what
`Outbound::FetchRenderRequest` already does via its `payload["sessionId"]` (`fh:worker/core.rs:192-197`) —
and have the desktop's `TaskRequest` arm address its reply by the **emitting loop's own id** rather than by
the delivery id. The desktop already has this pattern and already documents it as load-bearing: the
`cost_update` arm at `router.rs:75-92` re-extracts `payload["sessionId"]` precisely because *"the ROW
belongs to the CHILD"* while the delivery id belongs to the parent. The task arm needs the same treatment,
and unlike the `cost_update` fallback its fallback must **not** be the delivery id — `router.rs:78-86` says
of its own fallback: *"Do not read it as a safe default."*

Note the desktop **cannot** build a parent→child map from existing hooks: `WorkerHooks::register_child_cwd`
receives the child id but not the parent (`fh:worker/manager/mod.rs:98`), and `sink_for` receives the parent
but not the child (`:97`). This is why "desktop only" was not expressible, and it is the reason the scope
was relaxed.

**The desktop-side bound (worth landing regardless, and independent of the engine release).** Wrap
`run_task_call` in `tokio::time::timeout` and answer expiry with `TaskStoreError::Io`. ~6 lines inside the
already-spawned future; `result` is already the right type and the `Io` arm is already constructed two
lines above (`router.rs:326-328`). The engine surfaces that message **byte-for-byte to the model**
(`fh:tools/exec/task_tools.rs:104-125` → `ToolResult::fail(message, None)`), so the desktop composes the
sentence the model reads. The house phrasing already exists at `router.rs:975`:
`` format!("Supervisor `{verb}` board call failed: {e}") `` — the expiry sibling is
`` Supervisor `{verb}` board call timed out after {…:?} ``.

- **Value, honestly stated:** it does **not** fix the misroute — a subagent board call would fail in 30 s
  with a confident "timed out" instead of hanging. It is worth landing for a *wedged DB* and for failure
  modes #4–#7, and it closes a documented copy-fault. It must not be sold as the fix.
- **The late double-answer is provably harmless.** The engine removes-before-send and ignores an absent
  entry (`fh:worker/core.rs:958-972`), pinned by `task_response_with_an_unknown_request_id_is_ignored`,
  whose doc names exactly this scenario. Ids are fresh uuid v4 per call, pinned unique.
- **Cancelling the work is not possible.** Tokio: *"tasks spawned using `spawn_blocking` cannot be
  aborted … the task will continue running normally"* (`tokio-1.53.1/src/task/blocking.rs:104-113`). The
  detached closure keeps the `conn` mutex until SQLite returns, so a model **retry hits the same deadline**
  — expect a burst of identical timeouts during a wedge, not one error.
- **30 s is the evidence-led value.** It is what this repo chose twice for exactly this role —
  `NAME_REQUEST_TIMEOUT` (`src-tauri/src/agent/session/naming.rs:115-120`, whose doc calls itself *"the
  backstop"*) and the render `timeoutMs` default of 30_000 (`router.rs:276-279`) — on the same wire, and 6×
  the SQLite `busy_timeout`, so anything exceeding it is already past every lower-layer bound the desktop
  owns. A healthy board read is sub-millisecond, so **30 s cannot fire on a healthy database.** Do **not**
  reach for 5 s: it collides with `busy_timeout` and would turn an ordinary lock meeting into a
  model-visible error.
- **A `settings.json` knob is impossible desktop-only:** `Settings` is not a desktop type — it is
  `fulcrum_harness::config_types::Settings`, re-exported at `src-tauri/src/config.rs:67-69` with the comment
  *"The VALUE types are no longer here at all."* A module-level `const` is both the only option and the
  established pattern.

**Make it loud regardless.** Three `diagnostics::record` calls in `router.rs:330-339`: the `wm`-missing
miss, the `handle_for` miss (naming `request_id` + session id), and the `send_inbound_frame` `Err` (stop
writing `let _ =`). Zero behavioural risk, and it is the change that turns the next occurrence from
unrecoverable into one `grep` away. Follow `pump.rs:70-72`'s rule and keep the content ids-only.

**Do not touch `src-tauri/src/agent/errors.rs`.** `TasksError` (`errors.rs:705-758`) is the *human* IPC
wire (ADR 0063) reached from the Tauri commands, not from the Worker seam; its `kind()` vocabulary is frozen
by `src-tauri/tests/error_wire_gate.rs:386-412`.

### 10. Constraints a plan must budget for, not discover

- **The size ratchet is at zero headroom.** `router.rs` is **1471 code lines against a baseline of 1471**
  (`scripts/file-size-baseline.txt:9`), and the whole tree measures green at exactly baseline. **One added
  code line reddens CI.** Any change here needs `scripts/check-file-size.sh --update` plus a PR-body
  justification. `agent/errors.rs` is likewise frozen at 1135.
- **Two repositories, and the engine's tests are not runnable from here.** The engine is the sibling
  checkout `/home/daniel/Coding/Archimedes/fulcrum` (on `main` at `20e6060`, `Cargo.toml` version `0.5.1`);
  `.cargo/config.toml` is absent here, so `cargo` consumes the **crates.io-pinned** crate and *"editing it
  and then testing here tests nothing"* (AGENTS.md). A wire change also has to respect
  `fulcrum/schema-sha.txt`, the shape pin for the fulcrum↔desktop contract (issue #6). Per AGENTS.md, a
  shell with no `cd` inside a subagent commits into whichever repo the cwd happens to be — so a plan
  spanning both must name the repo for every command and re-check
  `git rev-parse --show-toplevel` before the first write and again before the first commit.
- **The engine change is a breaking wire change** (a new field on a protocol enum variant), and the engine
  releases semver separately: `3d7dfb6 chore: release 0.5.0 — the TurnState field is BREAKING, so this is a
  minor bump`. So the sequence is engine → release → desktop pin bump → desktop arm, and AGENTS.md's
  one-compilation-unit rule means two Rust tasks can never share a wave.
- **TDD pins this repo wants.** The pinning discipline for this seam is explicit in the crate: rule 1
  (register-before-emit) and rule 2 (drop clears the map) each have a named test, plus a *"returns
  PROMPTLY"* test because *"an empty map after an awaited cancel proves no leak; it does not prove no
  hang."* The new pins should follow that shape:
  - `a_subagents_task_request_is_answered_in_the_child_not_the_parent` — the **write-this-first** test.
    Shape it after `worker_e2e.rs:2529` (which already builds through `SessionManagerBuilder`, so the real
    router runs), dispatch a child whose canned stream calls `get_artifact`, assert the read resolves. If
    it comes back **green**, this report's chain is wrong and the timeout is the whole answer.
  - `a_board_call_still_running_at_the_deadline_answers_an_io_error_naming_the_verb` —
    `#[tokio::test(start_paused = true)]` over a `pending()` future; assert the message names the verb and
    "timed out". Mutation: delete the `timeout` and the test hangs on its own deadline.
  - `an_unanswerable_task_request_records_a_diagnostic_naming_the_request_id` — needs the crate's
    `DisableDiagnosticsOnExit` discipline (`fh:worker/core.rs:2064-2080`) so a failing assertion does not
    leave the process-global armed.

---

## Evidence

**Desktop (`/home/daniel/Coding/Archimedes/archimedes` @ `07ccb4f3`)** — all read directly, and the
load-bearing ones re-read by the parent after the researchers reported:
`src-tauri/src/agent/session/router.rs:30-95` (the `is_subagent`/`payload["sessionId"]` precedent),
`:303-342` (the arm), `:844-978` (`run_task_call`, `spawn_board`), `:344-375` (the child-key race comment);
`storage/db/tasks.rs:308-346` (`move_task` + the canonicalise rationale); `storage/db/seams.rs:343-347`
(`space_key`); `storage/db/mod.rs:502-542` (pragmas, `Db`); `storage/db/artifacts.rs:215-235`;
`agent/session/naming.rs:115-120`, `:399-415`; `agent/web/render.rs`; `src-tauri/tests/worker_e2e.rs:2437`,
`:2529`; `src/App.tsx:379`; `scripts/file-size-baseline.txt:9`.

**Engine (`fulcrum-harness 0.5.1`, crates.io pin per `Cargo.lock:1665`)** —
`worker/manager/pump.rs:62-102`; `worker/manager/registry.rs:78-116`; `worker/manager/mod.rs:70-130`,
`:232-251`, `:461-471`; `worker/manager/subagent_flow.rs:829-846`, `:881`, `:955-1011`, `:1216-1242`,
`:1679-1699`, `:1907-1919`; `worker/core.rs:188-240`, `:947-975`; `worker/task_store.rs:1-188`, `:475-514`;
`worker/protocol.rs:186-193`, `:335-341`; `worker/client.rs:446-450`, `:715-733`; `seams.rs:265-324`;
`harness/loop/turn.rs:749-753`; `harness/dispatch.rs:345`; `tools/exec/task_tools.rs:104-125`, `:410-427`;
`config_types.rs:255-260`; `diagnostics.rs:175`; `debuglog.rs:33-63`.

**Sibling checkout** `/home/daniel/Coding/Archimedes/fulcrum` — `main` @ `20e6060`, version `0.5.1`,
`schema-sha.txt` present.

**Third-party** — `tokio-1.53.1/src/task/blocking.rs:104-113`, `src/runtime/builder.rs:306`;
`tauri-2.12.2/src/async_runtime.rs:243-249`, `:311-319`.

**Measurement** — the live `archimedes.db` (3.0 GB, timings in §4); WAL header bytes 18/19;
`~/.local/share/archimedes/diagnostics.log` (260 lines, all provider-wire, `grep -c lagged` → **0**).

**Prior repo docs relied on** — `docs/research/database-size-unbounded-transcript-growth.md:59`, `:305-308`,
`:332-338`; `docs/research/whole-window-jank-renderer-saturation.md:305-307`, `:325`, `:336`;
`docs/research/round-ceiling-deletion.md` (no absolute turn cap survives);
`docs/features/task-board-known-gaps.md:96-105` (documents only the *daemon's* loud refusal as a known
non-answer — the subagent path is undocumented); `docs/features/subagent-sessions.md` (records no
child-vs-parent control-plane addressing rule).

**Credibility.** Everything in §1–§3, §5, §7–§9 is read from primary source (the two codebases, tokio's
own docs). §4's timings are my own measurements on the live file. Only the attribution of *this specific*
255m55s event to link-chain #1 is **inferred** — see Gaps.

---

## Unresolved Contradictions

**None between the sources.** Two researchers traced this chain independently and arrived link for link,
and the parent re-verified every load-bearing line. The `journal_mode` contradiction between the repo's own
docs and the live file is resolved in §4 (the docs describe an older installed AppImage, as they note).

**The remaining tension is a decision, not evidence:** the desktop-side timeout is cheap, precedented, and
independently useful, but it *masks* this bug rather than fixing it. This report recommends landing it
**only** alongside the engine fix and the diagnostics, and never alone.

---

## Gaps

1. **Which session made the failing call is unrecoverable.** No log line names a session for a board verb
   and `diagnostics.log` holds no `Lagged` entry. The subagent context comes from the user's screenshot,
   not from an artifact. **This is the single fact that would promote the root cause from "verified
   mechanism, inferred instance" to proven** — and it is exactly what the `diagnostics::record` change buys.
2. **No mutex instrumentation exists anywhere**, so every hold duration in §4 is measured from a side
   connection, not observed in-process. A stall caused by something outside the code (a device, an OS-level
   freeze) would be invisible to this analysis.
3. **`native_messages` size today was not measured** — aggregation over the 3.0 GB file exceeded the time
   budget twice. The "compaction rewrite is the longest lock hold" ranking rests on the schema and the
   earlier census in `database-size-…md:59`, not a fresh number.
4. **Whether the deployed AppImage matches this checkout.** `pgrep` shows `/tmp/.mount_archim*/usr/bin/archimedes
   --worker` children and `~/AppImages/archimedes.appimage`; the build was not verified against `07ccb4f3`.
   The repo's own docs record that a stale AppImage already produced one wrong conclusion here.
5. **`fs::canonicalize` on a genuinely stale mount was not tested** — the site in §6 was identified, not
   exercised.
6. **Failure modes #4–#7 in §3 are reasoned, not reproduced.** Each is argued from source to be reachable;
   none was made to happen.
