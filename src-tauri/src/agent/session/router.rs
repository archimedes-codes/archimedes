//! The Worker event router + the crash / stalled / pending-modal cluster
//! (ADR 0025) — a CHILD module of `session`, so it sees the parent's private
//! items (`SessionManager`'s `sessions` map and the `with_session` accessors,
//! the private `LiveWorkerSession` / `CloseKind`) with no visibility widening.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::agent::crashlog::find_crash_log_for_pid;
use crate::agent::diagnostics;
use crate::agent::events::RpcEvent;
use crate::agent::normalize::now_ms;
use crate::agent::worker::client::WorkerInboundEvent;
use crate::agent::worker::Inbound;
use crate::storage::Db;
use fulcrum_harness::seams::{TaskCall, TaskStore, TaskStoreError};

use super::{CloseKind, ClosedReason, SessionManager, StalledInfo, StopReason, TurnDisposition};

impl SessionManager {
    // ── The Worker event router (ADR 0025 Task 4) ──────────────────────────
    // The `WorkerManager`'s `on_event` callback (wired in `lib.rs` with the
    // `OnceLock` late-wire). The reviewer-corrected routing: the UI's contract
    // is the `SinkFrame`s (re-emitted verbatim); the store frames drive
    // persistence only; the raw `RpcEvent` stream drives internal bookkeeping
    // only (settle detection + the `pending_turn` resolution — NEVER the UI, to
    // avoid double-delivering the `session-update` frames); the
    // `PermissionRequest` / `InteractiveRequest` frames are re-emitted with the
    // payload UNCHANGED (the frontend contract preserved by construction).
    pub fn route_event(&self, session_id: &str, is_subagent: bool, evt: WorkerInboundEvent) {
        match evt {
            WorkerInboundEvent::Store(frame) => {
                // Persistence ONLY (not the UI — the `TranscriptPersister` applies
                // the store frame to SQLite, the sole writer).
                if let Some(p) = self.persister.get() {
                    p.apply(is_subagent, &frame);
                }
            }
            WorkerInboundEvent::SinkFrame { event, payload } => {
                // The interactive-persistence gate, narrowed PER EVENT (issue
                // #105). `!is_subagent` stays for `todos_update` /
                // `todos_clear`: the todo panel is a MAIN-session surface, so
                // a child's todo frames must never reach the DB (pinned by
                // `sink_frame_interactive_event_todos_update_persists_for_main_not_subagent`).
                // `cost_update` is the one exception — a child's spend is its
                // OWN money and must land on the child's row, or the child's
                // stored figure disagrees with its own card. The discriminator
                // is the payload's inner `event` field, in scope here.
                if event == "interactive-event" {
                    let inner = payload.get("event").and_then(|v| v.as_str());
                    if !is_subagent || inner == Some("cost_update") {
                        // WHICH row owns the money. A subagent's frames are
                        // delivered under the PARENT's delivery id (the pump
                        // re-targets them so the child's UI lives in the
                        // parent's scope — `pump.rs`'s `delivery_id`), but the
                        // ROW belongs to the CHILD. This is the same
                        // distinction `TranscriptPersister::apply` documents
                        // for `StoreFrame`s, and it is load-bearing here:
                        // writing a child's own `cost_update` to the delivery
                        // id would put the child's TOTAL on the PARENT's row,
                        // and since the write is a SNAPSHOT that OVERWRITES it
                        // would replace the parent's own figure with the child's
                        // — the parent reporting a child's spend as its own. The
                        // payload's `sessionId` is the emitting loop's own id
                        // (pinned loop-side by
                        // `a_priced_call_emits_one_cost_update_frame_carrying_that_calls_cost`),
                        // so it is the child id for a child frame. The parent's
                        // own frames — including the one `fold_child_cost` emits
                        // when a child returns — arrive with `is_subagent: false`
                        // under the parent's id and so take the `else` branch:
                        // the parent's row, written by ONE producer.
                        //
                        // Inert for `todos_*`: a subagent's todo frames never
                        // reach this branch at all.
                        let target = if is_subagent {
                            payload
                                .get("sessionId")
                                .and_then(|v| v.as_str())
                                // ⚠ This fallback is DELIBERATELY UNREACHABLE:
                                // the loop always stamps its own id on the frame
                                // (pinned loop-side by
                                // `a_priced_call_emits_one_cost_update_frame_carrying_that_calls_cost`),
                                // so a child frame never arrives WITHOUT
                                // `sessionId`. Do not read it as a safe default —
                                // it writes the child's money to the PARENT's row,
                                // which is precisely the double-count the branch
                                // above exists to prevent. If the loop ever stops
                                // stamping, this must SKIP the write (a frame with
                                // no owner is unpersistable), NOT fall back.
                                .unwrap_or(session_id)
                        } else {
                            session_id
                        };
                        if let Some(p) = self.persister.get() {
                            p.apply_interactive_event(target, is_subagent, &payload);
                            // (#155, Task 3) Flush the row this frame just
                            // wrote. THREE reasons this is a flush point when the
                            // `Store` arm above deliberately is not:
                            //
                            // * `cost_update` / `todos_update` arrive a few times
                            //   per TURN, not ~60/sec — flushing here costs a
                            //   handful of commits per turn, so it does not
                            //   re-create the pressure the batching removes.
                            // * The stored figure is READ BACK on paths that do
                            //   not go through this decorator: `list_sessions`
                            //   after a close, and `resume_session` seeding
                            //   `StartEnv.cost_usd`. A buffered cost would make a
                            //   closed session's row disagree with the card the
                            //   user just watched — the exact contract
                            //   `a_stored_cost_survives_a_close_and_a_list` pins.
                            // * `target`, NOT `session_id`: a child's frames are
                            //   delivered under the PARENT's delivery id, so
                            //   flushing `session_id` here would drain the
                            //   parent's buffer and leave the child's money
                            //   sitting there. `target` is the row that was just
                            //   written — the same distinction the block above
                            //   exists to make.
                            self.flush_batched(target, "after apply_interactive_event");
                        }
                    }
                }
                // The ENTIRE UI contract — re-emitted VERBATIM (the same event name +
                // payload; the frontend is unchanged).
                if let Some(sink) = self.sink.get() {
                    sink.emit(&event, payload);
                }
            }
            WorkerInboundEvent::Event(e) => {
                // (issues #190 + #193) STASH THE DISPOSITION before anything can
                // settle. The engine emits `turn_truncated` / `turn_capped`
                // BEFORE `turn_end` / `agent_settled` on the SAME pipe (both
                // frames' contract), so this arm always runs before the
                // `resolve_turn` below reads the slot. MAIN sessions only, for
                // exactly the reason the `agent_settled` arm documents: a child's
                // frames arrive under the PARENT's delivery id, and a child's
                // cut-off reply must not mark the parent's turn truncated.
                // Neither turn is a success — `resolve_turn` maps `Truncated` to
                // `StopReason::MaxTokens` and `Capped` to
                // `StopReason::MaxTurnRequests` (ADR 0108).
                //
                // A `turn_capped` on the SAME turn as a `turn_truncated` is
                // IMPOSSIBLE by construction, so the last-writer-wins below is
                // not a real hazard: the cap fires at the TOP of a loop iteration
                // — before any provider stream is opened — while the truncation
                // is a fact ABOUT a stream that ran and hit the output cap. A
                // turn that never opened a stream cannot have been cut off in
                // one, and a turn whose stream ended `length` settles on that
                // stream and never reaches the next iteration's bound check. If
                // that ever changed, `Truncated` would WIN: it is the more
                // specific provider fact (it names what the provider did), and
                // the identical-refusal run firing afterwards would be describing
                // a turn we already know the reason for. Implementing that
                // preference needs a compare, not an assign — so it stays a
                // documented impossibility rather than a branch no event sequence can reach.
                if !is_subagent {
                    let stashed = match e {
                        RpcEvent::turn_truncated => Some(TurnDisposition::Truncated),
                        RpcEvent::turn_capped => Some(TurnDisposition::Capped),
                        _ => None,
                    };
                    if let Some(disposition) = stashed {
                        // UNSEQUENCED against the forced clear (issue #190, round-2
                        // finding): this SET and `resolve_turn_forced`'s clear run
                        // on DIFFERENT tasks (this pump vs the crash-watch) with no
                        // ordering between them, so a dying Worker's posthumous
                        // disposition frame can arrive AFTER the crash cleared the
                        // slot — the slot goes back to `Some(_)`, the row stays live,
                        // and the NEXT turn's claim→clear window inherits a stale
                        // `MaxTokens` / `MaxTurnRequests`. Before the forced clear
                        // existed this direction of the race could not happen. The
                        // consequence is BOUNDED and wrong-direction only — one dead
                        // Worker, one turn, an over-reported disposition — and it
                        // cannot chain, because every turn-start clears the slot. The
                        // real fix sequences this stash and that clear through ONE
                        // lock; that is a separate change, not this one. A reviewer's
                        // suggested `!stalled` gate was REJECTED on evidence:
                        // `stalled` is written only by `handle_crash` and NEVER
                        // removed (ADR 0025; pinned by
                        // `a_stalled_row_is_frozen_until_the_next_crash`), while a
                        // resumed session re-uses the SAME id with a fresh live
                        // Worker — gating here would silently drop a legitimate
                        // truncation on a session that has every right to hit the
                        // output cap again, reintroducing the silent `EndTurn` this
                        // slot exists to eliminate.
                        //
                        // Clone the `Arc` OUT under the `sessions` lock and lock it
                        // AFTER the lock is released — the `cancel_requested`
                        // discipline, and a poisoned lock is RECOVERED (the registry
                        // guards independent per-key rows).
                        let slot = self
                            .with_session(session_id, |s| {
                                s.live.as_ref().map(|live| live.disposition.clone())
                            })
                            .flatten();
                        if let Some(slot) = slot {
                            *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(disposition);
                        }
                    }
                }
                // Internal bookkeeping ONLY (NOT the `TauriSink` — forwarding would
                // DOUBLE-DELIVER every `session-update` the loop emits both as an
                // `RpcEvent` and as a `session-update` `SinkFrame`): the
                // `agent_settled` settle detection (the session's "busy" state) + the
                // `pending_turn` resolution. MAIN sessions only: a child subagent's
                // `agent_settled` arrives under the parent's delivery id with
                // `is_subagent: true` and must NEVER settle the parent turn early.
                if !is_subagent && matches!(e, RpcEvent::agent_settled) {
                    // (#155, Task 3) THE TURN-BOUNDARY FLUSH — and it must run
                    // BEFORE `resolve_turn`, which is the load-bearing detail.
                    // `resolve_turn` completes the `send_prompt` oneshot, and a
                    // test (or a user's next command) that reads the transcript
                    // after `send_prompt` returns is therefore reading AFTER this
                    // point and not before it. Flush after the resolve and the
                    // read can land inside the window, which is the failure mode
                    // the plan warns about: a test that passes because the write
                    // was deferred, and a UI that shows a transcript the disk has
                    // not got yet.
                    //
                    // Why the settle and not every frame: "everything the app was
                    // told about this turn is on disk" is the contract a reader
                    // can actually rely on, it fires once per turn (not ~60/sec),
                    // and it is the point after which nothing about the turn can
                    // change the buffered rows.
                    self.flush_batched(session_id, "agent_settled");
                    self.resolve_turn(session_id);
                }
                // Session naming: `agent_end` is the turn's last frame
                // (`agent_settled` is the settle signal the turn resolver
                // waits on). MAIN sessions only — a subagent's transcript is
                // hidden (`is_subagent` rows are filtered out of
                // `list_sessions`). The hook guards and spawns: the model
                // call never blocks this router.
                if !is_subagent && matches!(e, RpcEvent::agent_end { .. }) {
                    self.maybe_name_session(session_id);
                }
            }
            WorkerInboundEvent::PermissionRequest { id, payload } => {
                // Re-emit as the `permission-request` Tauri event with the payload
                // UNCHANGED (the frontend contract preserved by construction —
                // `PermissionPrompt.tsx` / `store/permissions.ts` consume the
                // payload's `requestId` / `toolTitle` / `options` verbatim).
                if let Some(sink) = self.sink.get() {
                    sink.emit("permission-request", payload);
                }
                self.track_modal(session_id, &id);
            }
            WorkerInboundEvent::InteractiveRequest { id, payload } => {
                // Re-emit as the `interactive-request` Tauri event with the payload
                // UNCHANGED (same reasoning — `store/interactive.ts` consumes
                // `method` + `params`).
                if let Some(sink) = self.sink.get() {
                    sink.emit("interactive-request", payload);
                }
                self.track_modal(session_id, &id);
            }
            WorkerInboundEvent::FetchRenderRequest { id, payload } => {
                // Internal machine call (ADR 0058 Task 7): do NOT call track_modal!
                let session_id = payload
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(session_id)
                    .to_string();
                let wm = self.worker_manager.get().cloned();
                let app = self.app_handle.get().cloned();
                tokio::spawn(async move {
                    let reply_value = match app {
                        Some(app_handle) => {
                            let req = crate::agent::web::render::RenderRequest {
                                session_id: session_id.clone(),
                                request_id: id.clone(),
                                url: payload
                                    .get("url")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                timeout_ms: payload
                                    .get("timeoutMs")
                                    .and_then(serde_json::Value::as_u64)
                                    .unwrap_or(30_000),
                            };
                            let reply = crate::agent::web::render::render(&app_handle, req).await;
                            if let Some(err) = reply.error {
                                json!({ "error": err })
                            } else {
                                json!({
                                    "html": reply.html.unwrap_or_default(),
                                    "status": reply.status,
                                    "finalUrl": reply.final_url.unwrap_or_default(),
                                })
                            }
                        }
                        None => {
                            json!({ "error": "Supervisor AppHandle not available" })
                        }
                    };
                    if let Some(wm) = wm {
                        if let Some(handle) = wm.handle_for(&session_id) {
                            let _ = handle.send_fetch_render_response(&id, &reply_value);
                        }
                    }
                });
            }
            WorkerInboundEvent::TaskRequest {
                request_id,
                session_id: origin_id,
                call,
            } => {
                // Internal machine call (ADR 0092, issue #180 D2): do NOT call
                // track_modal! The `FetchRenderRequest` arm above is the template
                // and this arm copies its shape for the same reason — the Worker
                // asked the SUPERVISOR to run a board verb, and the Supervisor is
                // the sole SQLite writer (ADR 0025), so the answer is computed HERE
                // and never in the Worker.
                //
                // A DELIVERY ADDRESS IS NOT A REPLY ADDRESS (ADR 0117). The comment
                // that used to sit here claimed `handle_for` answers `None` for a
                // session that is already gone, so a frame that cannot be delivered
                // is an ordinary miss and the send result may be discarded. For a
                // LIVE SUBAGENT neither half holds. The pump re-keys a child's frames
                // to the PARENT's session id — correctly, because a child's UI renders
                // in the parent's scope (`pump.rs:91-102`) — so `handle_for(session_id)`
                // here HITS and hands back the PARENT's handle. The parent's per-Worker
                // pending map has no such `request_id` and ignores the frame exactly as
                // its contract requires, the child stays parked on a `oneshot` with no
                // timeout, and the subagent Dead bound is disarmed while a `tool_call_id`
                // is outstanding — which is the 255m55s `get_artifact` hang
                // (ADR 0117, and
                // `docs/research/board-tool-hang-subagent-task-response-misroute.md`).
                // The REPLY address is therefore the frame's ORIGIN id — the
                // `session_id` field `Outbound::TaskRequest` has carried since
                // `fulcrum-harness` 0.6.0, bound here as `origin_id` so it does NOT
                // shadow `route_event`'s `session_id` (the delivery id, which stays
                // the UI-scope key it is). Meanwhile a miss is never silently
                // discardable: every path below that fails to answer records an
                // always-on `diagnostics` line, and `spawn_board` bounds the call
                // itself, so the paths that still cannot answer are bounded and
                // visible instead of a hang nobody can explain.
                let db = self.driver.db.clone();
                let wm = self.worker_manager.get().cloned();
                // Decided BEFORE the spawn, so the early `return` below exits
                // `route_event` with nothing spawned and nothing left parked on the
                // Supervisor side (`route_event` returns `()` and this `match evt` is
                // its entire body, so `return` skips nothing). `is_subagent` is
                // `route_event`'s second parameter and needs no capture, because the
                // decision is made here and not in the spawned future.
                let reply_target =
                    match task_reply_target(session_id, is_subagent, origin_id.as_deref()) {
                        Some(target) => target,
                        None => {
                            crate::agent::diagnostics::record(&format!(
                                "task-request: a Subagent frame for delivery {session_id} \
                                 carried no origin id, request {request_id} - the answer \
                                 was dropped"
                            ));
                            return;
                        }
                    };
                tokio::spawn(async move {
                    let result: Result<serde_json::Value, TaskStoreError> = match db {
                        Some(db) => run_task_call(&db, call).await,
                        None => Err(TaskStoreError::Io {
                            message: "Supervisor database not available".to_string(),
                        }),
                    };
                    let Some(wm) = wm else {
                        // The `OnceLock` was never wired — a Worker exists and is
                        // parked on this answer, and NOTHING can ever deliver it.
                        diagnostics::record(&format!(
                            "task-response: no WorkerManager for request {request_id}"
                        ));
                        return;
                    };
                    let Some(handle) = wm.handle_for(&reply_target) else {
                        diagnostics::record(&format!(
                            "task-response: no Worker for session {reply_target}, request \
                             {request_id} — the answer was dropped"
                        ));
                        return;
                    };
                    // The one path back to the Worker. An `Err` here means the process
                    // is already gone (the `exited` watch) and F1's Drop guard cleans
                    // the pending entry — but the answer is still undelivered, and a
                    // line behind `ARCHIMEDES_DEBUG` cannot answer "why did nothing
                    // happen" for a user who never set the var (`pump.rs:62-77`), so
                    // this records rather than swallowing the result. The clone keeps
                    // the id readable in the line: the frame MOVES it.
                    let frame = Inbound::TaskResponse {
                        request_id: request_id.clone(),
                        result,
                    };
                    if let Err(e) = handle.send_inbound_frame(frame) {
                        diagnostics::record(&format!(
                            "task-response: the answer for request {request_id} could not \
                             be sent: {e}"
                        ));
                    }
                });
            }
            WorkerInboundEvent::Exited(code) => {
                // (#155, Task 3) The LAST frame this session will ever produce.
                // Drain it before anything else in this arm — the teardown below
                // removes the session's registry row, and `RunEvent::Exit`'s
                // whole-buffer flush is then the only thing left between these
                // rows and the disk. Flushing here costs one commit per session
                // per lifetime.
                //
                // THIS LINE ALSO DRAINS A CHILD'S BUFFER — but under which KEY is
                // a RACE in the crate, and it is worth naming rather than
                // guessing, because it decides whether a child's last display
                // rows wait for this line or for the interval. `finish_subagent`
                // calls `reap_worker(handle).await` and only THEN does
                // `drives.remove(child_id)` (`subagent_flow.rs:1681` then `:1688`), while
                // the child's `Exited` reaches the pump as soon as the process is
                // gone — so the pump's `drives` lookup either still HITS (the
                // delivery id is the PARENT's, `pump.rs:81-90`) or already MISSES
                // (the fallback is the CHILD's own id). Both are possible.
                //
                // That is acceptable here, and the reason is worth keeping:
                // NOTHING a test or the UI asserts about a child's row waits on
                // it. The child's `native_messages` are pass-through (written
                // immediately), its `cost_update` flushes with its own frame, and
                // its `ensure_session_row` is immediate — so the ephemeral row,
                // the transcript and the money are all on disk before
                // `subagent-closed` fires. What a race over the key can delay is
                // the child's buffered DISPLAY rows, and the bound on that is the
                // interval, or the next whole-buffer flush. `RunEvent::Exit`'s
                // `flush()` takes the WHOLE map precisely because it never has to
                // know which key a row is under.
                self.flush_batched(session_id, "Exited");
                // EXPECTED (a `detach` / `reap_all` was in flight) → the
                // `session-closed` cleanup. UNEXPECTED (a crash — the `WorkerManager`
                // fired `on_crash`) → `is_exit_expected` is `false` → no-op (the
                // `on_crash` path handles the stalled marking + the same cleanup).
                // MAIN sessions only: a child subagent's exit is managed by the
                // drive task and must never close the parent session.
                if !is_subagent {
                    if let Some(wm) = self.worker_manager.get() {
                        if wm.is_exit_expected(session_id) {
                            self.on_session_exited_expected(session_id);
                        }
                    }
                }
                let _ = code;
            }
            WorkerInboundEvent::Ready { .. }
            | WorkerInboundEvent::WorkerError { .. }
            | WorkerInboundEvent::SubagentDispatch(_)
            | WorkerInboundEvent::SubagentCancel { .. } => {
                // The `WorkerManager`'s pump owns these: the `SubagentDispatch`
                // (the Supervisor-side `dispatch_subagent` flow) and the
                // `SubagentCancel` (a parent turn abort → `cancel_drive` — the
                // frame arrives on the PARENT's pump, which holds the `drives`
                // map). The `Ready` / `WorkerError` frames are bookkeeping.
                // Nothing UI-facing to do here.
            }
        }
    }

    /// The `WorkerManager`'s `on_crash` callback (the UNEXPECTED `Exited` — a Worker
    /// crash): mark the session STALLED (the `stalled` slice of the session's
    /// `SessionState` row + the `session-stalled` event + the `stalled_info`
    /// query), perform the pending-modal
    /// cleanup (the `interactive-request-close` frames — a crashed session's open
    /// permission / interactive modals are dismissed, no stuck modal alongside the
    /// banner), resolve the in-flight `send_prompt` (the crash outcome — the
    /// composer unlocks; it never stays locked forever), and drop the session's
    /// NAMING slice (a resumed session re-uses the same id — see the site).
    ///
    /// `pid` is the DEAD child's pid (the handle's, captured at spawn); `None`
    /// when the Supervisor never saw one. It selects the crash log — see
    /// `find_crash_log_for_pid` (private; the banner's link is `None` when the
    /// pid names no log).
    pub fn handle_crash(&self, session_id: &str, code: Option<i32>, pid: Option<u32>) {
        let at = now_ms();
        // The crash log for THIS Worker, resolved ONCE and then frozen. A
        // second lookup for the emit below is what let the pushed
        // `session-stalled` event and the pulled `stalled_info` name
        // different files for ONE crash — a second Worker crashing in between
        // moved the banner's link out from under the registry.
        let crash_log = self
            .crash_log_dir
            .get()
            .and_then(|d| find_crash_log_for_pid(d, pid));
        // Mark the session STALLED (the row's `stalled` slice — the frontend
        // reads it via `stalled_info` + the `session-stalled` event) and drop
        // the NAMING slice in the same lock acquisition. The other two slices
        // are LEFT ALONE — that is today's crash-path shape, and it is a
        // contract, not an oversight:
        //
        // - `naming` goes because a crashed-then-resumed session re-uses the
        //   SAME id, so a stale `in_flight` would block naming for ever and a
        //   stale `fails == MAX_FAILURES` would silently kill it;
        // - `live` / `config_state` stay, so a stalled session still passes the
        //   `close_session` / `cancel_session` `live` guards (the frontend's
        //   `store/sessions.ts` documents exactly that: a crash "removes no
        //   `live` entry", so Stop answers `Ok(())` instead of erroring, and the
        //   row stays resumable). Blanking them here would turn those `Ok`s into
        //   `UnknownSession` errors — a behaviour change this merge forbids
        //   ("Repairing that row's liveness bookkeeping is its own decision, not
        //   a tidy-up to fold in here").
        //
        // A crash for an id that was never started CREATES the row holding ONLY
        // the `stalled` slice (the same thing the standalone `stalled` map did
        // today) — which is why the write goes through the entry-or-default
        // helper rather than a `get_mut`.
        self.with_session_entry(session_id, |row| {
            row.stalled = Some(StalledInfo {
                at,
                crash_log: crash_log.clone(),
            });
            row.naming = None;
        });
        // The pending-modal cleanup (the `interactive-request-close` frames — the
        // unanswered-request-id diff: a crashed session's open permission / interactive
        // modals are dismissed, no stuck modal alongside the banner).
        self.cleanup_pending_modals(session_id);
        // Resolve the in-flight `send_prompt` (the crash outcome — the turn is
        // incomplete; `Cancelled` unlocks the composer. The `StopReason` has no error
        // variant — the `session-stalled` event is the frontend's crash signal).
        self.resolve_turn_forced(session_id, StopReason::Cancelled);
        // Emit the `session-stalled` event (the frontend's banner — the `StalledInfo`
        // shape: `at` + `crash_log`). The path is the one the registry just froze —
        // NEVER a second glob (that is what let the push and the pull disagree).
        if let Some(sink) = self.sink.get() {
            sink.emit(
                "session-stalled",
                json!({
                    "sessionId": session_id,
                    "at": at,
                    "crashLog": crash_log,
                }),
            );
        }
        let _ = code;
    }

    /// The `stalled_info` query (the frontend's banner query — the `SessionManager`
    /// exposes it; the `get_stalled_info` command wraps it). The row's `stalled`
    /// slice CLONED out under the one lock, released before this returns.
    pub fn stalled_info(&self, session_id: &str) -> Option<StalledInfo> {
        self.with_session(session_id, |s| s.stalled.clone())
            .flatten()
    }

    /// Resolve the session's in-flight turn (the `pending_turn` oneshot) on an
    /// `agent_settled` (the `cancel_requested` flag maps the settle to `Cancelled`,
    /// the `disposition` slot to `MaxTokens` / `MaxTurnRequests`, else `EndTurn` —
    /// the existing settle semantics plus the issue #190 / #193 dispositions). A
    /// no-op when no turn is in flight (the slot is empty) or the session is gone.
    ///
    /// This is an exhaustive `match` and that is the point. It used to be
    /// `if cancelled / else if was_truncated / else`, which is a chain that
    /// silently drops a disposition it has no arm for: a fifth one would resolve
    /// as `EndTurn` — the composer unlocks, no footer line appears, and
    /// `attention.ts` announces a turn that never finished as "finished — waiting
    /// for you". That is precisely the silent-success bug #190 and #193 each
    /// shipped, and a chain cannot be warned about. Matching on
    /// `Option<TurnDisposition>` turns the next one into an `E0004` here.
    fn resolve_turn(&self, session_id: &str) {
        // Copy out the three SHARED `Arc` slots (the `Arc`s are cloned, not the
        // slot contents — resolving through the clone resolves the session's
        // real slot) and act OUTSIDE the `sessions` lock, exactly as the
        // borrowed `live` reference did under the old map lock.
        let slots = self
            .with_session(session_id, |s| {
                s.live.as_ref().map(|live| {
                    (
                        live.cancel_requested.clone(),
                        live.disposition.clone(),
                        live.pending_turn.clone(),
                    )
                })
            })
            .flatten();
        let Some((cancel_requested, disposition, pending_turn)) = slots else {
            return;
        };
        let cancelled_guard = cancel_requested.lock().unwrap_or_else(|p| p.into_inner());
        let cancelled = *cancelled_guard;
        drop(cancelled_guard);
        // (issues #190 + #193) `Cancelled` > the engine's disposition > `EndTurn`.
        // A user who pressed Stop on a turn whose reply was ALSO cut off (or
        // stopped by the bound) cancelled it — the more specific fact about what
        // happened (ADR 0108's amendment), which is why `(true, _)` is the FIRST
        // arm and not a check after the disposition. Both guards are dropped
        // BEFORE the `pending_turn` lock, as the `cancel_requested` guard always
        // was: never hold two of these at once.
        let disposition_guard = disposition.lock().unwrap_or_else(|p| p.into_inner());
        let stashed = *disposition_guard;
        drop(disposition_guard);
        let reason = match (cancelled, stashed) {
            (true, _) => StopReason::Cancelled,
            (false, Some(TurnDisposition::Truncated)) => StopReason::MaxTokens,
            (false, Some(TurnDisposition::Capped)) => StopReason::MaxTurnRequests,
            (false, None) => StopReason::EndTurn,
        };
        let mut pending_guard = pending_turn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tx) = pending_guard.take() {
            let _ = tx.send(reason);
        }
    }

    /// Resolve the session's in-flight turn with a FORCED reason (the `Exited`
    /// / crash path — the turn is over regardless of the `cancel_requested` flag;
    /// a mid-turn death / a close must not tell `send_prompt` "turn ended normally").
    fn resolve_turn_forced(&self, session_id: &str, reason: StopReason) {
        let slots = self
            .with_session(session_id, |s| {
                s.live
                    .as_ref()
                    .map(|live| (live.pending_turn.clone(), live.disposition.clone()))
            })
            .flatten();
        if let Some((pending_turn, disposition)) = slots {
            let mut pending_guard = pending_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(tx) = pending_guard.take() {
                let _ = tx.send(reason);
            }
            drop(pending_guard);
            // (issues #190 + #193) Retire the disposition with the turn it
            // describes. `resolve_turn` is the slot's only consumer and
            // `send_prompt` its only clearer, so a turn that ends WITHOUT a
            // settle strands it — and a settle really can go missing: the
            // per-Worker transport is a 256-slot `tokio::sync::broadcast` whose
            // `Lagged` arm logs and `continue`s (`worker/client.rs`), silently
            // dropping frames. This path already ends the turn regardless of
            // `cancel_requested`, so the disposition must not outlive it either:
            // the next `send_prompt` clears it only AFTER claiming
            // `pending_turn`, so a late settle arriving in that window would
            // resolve the NEW turn with THIS turn's `MaxTokens` /
            // `MaxTurnRequests`. Clearing it here closes that window on the
            // shapes this helper actually runs on — the crash and the close. The
            // third no-settle shape (a settle dropped off a LIVING Worker's
            // broadcast) never reaches this path, so it stays open; see the note
            // in `send_prompt_with_images`.
            //
            // The WHOLE slot goes to `None`, not one variant: this clear is
            // about the turn ending, not about which disposition was stashed, so
            // it must not grow a match that has to be revisited for every new
            // variant (the same exhaustiveness reasoning that made `resolve_turn`
            // a `match` — but inverted: here a missed arm would be a silent
            // strand, and an unconditional clear cannot have one).
            //
            // `cancel_requested` is deliberately LEFT ALONE: `close_session`
            // sets it BEFORE forcing `Cancelled` and its docblock documents that
            // pairing as the close-reason contract. Clearing it here is provably
            // harmless for THIS call (the forced reason ignores the flag, and the
            // next `send_prompt` resets it), but the flag's contract belongs to
            // `close_session`, not to every caller of this helper — this clear is
            // about removing a stranded disposition, not auditing a different
            // flag's contract.
            *disposition.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
    }

    /// The EXPECTED `Exited` handling (a `detach` / `reap_all` was in flight — the
    /// `close_session` / `reap_all` path): emit `session-closed` (the `ClosedReason`
    /// payload — the `close_kind`: `User` for a `close_session`, `AgentExited` for a
    /// clean self-exit), resolve the in-flight `pending_turn` → `Cancelled`, perform
    /// the pending-modal cleanup (the `interactive-request-close` frames), and remove
    /// the live-session bookkeeping.
    ///
    /// `pub(crate)`: the ONE close / clean-self-exit teardown — `close_session`
    /// only marks the close kind and `detach`s, reaching this site through the
    /// Worker's EXPECTED `Exited` — so it is also what a test asserts the
    /// per-session cleanup against.
    pub(crate) fn on_session_exited_expected(&self, session_id: &str) {
        // The `ClosedReason` mapping (the current `session.rs:876` shape): a
        // `close_session` (`CloseKind::User`) → `User`; a clean self-exit
        // (`None` — the Worker exited on its own) → `AgentExited`. Read OUTSIDE
        // the lock below (the `close_kind` `Arc` is copied out under it), so the
        // idempotent early-return for a session with no `live` slice stays
        // exactly where the old `live`-map `get` put it.
        let reason = self
            .with_session(session_id, |s| {
                s.live.as_ref().map(|live| {
                    let kind_guard = live.close_kind.lock().unwrap_or_else(|p| p.into_inner());
                    match *kind_guard {
                        Some(CloseKind::User) => ClosedReason::User,
                        None => ClosedReason::AgentExited,
                    }
                })
            })
            .flatten();
        let Some(reason) = reason else {
            return; // the session is already gone (idempotent).
        };
        // Resolve the in-flight `pending_turn` → `Cancelled` (a close / a clean self-
        // exit kills the turn — the composer unlocks; it never stays locked forever).
        self.resolve_turn_forced(session_id, StopReason::Cancelled);
        // The pending-modal cleanup (the `interactive-request-close` frames — the
        // unanswered-request-id diff: a session ending with an open prompt must NOT
        // leave a stuck modal).
        self.cleanup_pending_modals(session_id);
        // Remove the session's per-session state (`live` / `config_state` /
        // `naming` — a stalled-less row is removed wholesale; the `stalled` slice
        // is deliberately NEVER removed: ADR 0025 makes it the crash-attribution
        // source — the pushed `session-stalled` event and the pulled `stalled_info`
        // both read it, and the frontend banner may still be reading it).
        //
        // This is the ONE place the merge could have erased that attribution, and
        // the prohibition is pinned: a crash marks the session stalled and the
        // user then closes it, so the `detach` removes the `workers` entry first
        // and this teardown runs on a row that HOLDS a `stalled` slice. A
        // blanket "remove the row" here would delete the crash record mid-read,
        // so the stalled-bearing case clears the three slices IN PLACE and leaves
        // the row (grow-only, bounded by DISTINCT crashed sessions); a
        // stalled-less row goes wholesale — for a plain close the two shapes are
        // indistinguishable, and dropping the row keeps the map from holding
        // state for a session that is over.
        //
        // The naming semantics the deleted per-field comment used to explain are
        // preserved by this: an in-flight title request of a closing session
        // finds NO naming slice afterwards (`InFlightClaim::drop`,
        // `note_failure` and `note_success` all treat "missing → do not
        // re-create"), so nothing is resurrected for a session that is over.
        // The two lock acquisitions below are SEQUENTIAL (no guard is held into
        // the second call — the merge's lock discipline), and the invariant
        // survives either interleaving with a concurrent crash: if a crash
        // writes `stalled` BEFORE the read, this clears in place; if it writes
        // AFTER the read and this removes the row, the crash's own write goes
        // through the entry-or-default helper and re-creates the row holding its
        // `stalled` — so the attribution is never the loser.
        let stalled_row = self
            .with_session(session_id, |s| s.stalled.is_some())
            .unwrap_or(false);
        if stalled_row {
            self.with_session_mut(session_id, |row| {
                row.live = None;
                row.config_state = None;
                row.naming = None;
            });
        } else {
            self.remove_session(session_id);
        }
        // Emit the `session-closed` event (the `ClosedReason` payload — the frontend's
        // close handling).
        if let Some(sink) = self.sink.get() {
            sink.emit(
                "session-closed",
                json!({
                    "sessionId": session_id,
                    "reason": reason.as_str(),
                }),
            );
        }
    }

    /// The pending-modal cleanup (the round-3 fix — the Worker's pending maps die with
    /// it, so the Supervisor tracks the cleanup state itself: per session, the
    /// `PermissionRequest` / `InteractiveRequest` frames it relayed MINUS the
    /// `*Response`s it sent = the UNANSWERED request ids — the Supervisor sees both
    /// halves of every round-trip, so the diff is exact). Emits the same
    /// `interactive-request-close` frames the in-process teardown emits for unanswered
    /// prompts (keyed by the unanswered ids; a session ending with an open
    /// permission / interactive prompt must NOT leave a stuck modal).
    fn cleanup_pending_modals(&self, session_id: &str) {
        let unanswered = self
            .with_session(session_id, |s| {
                s.live.as_ref().map(|live| {
                    live.pending_modal_ids
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .clone()
                })
            })
            .flatten();
        let Some(unanswered) = unanswered else {
            return;
        };
        if unanswered.is_empty() {
            return;
        }
        // The EMIT runs OUTSIDE the `sessions` lock (the sink is a re-emitting
        // `TauriSink` — an emit must never re-enter these maps under a guard).
        let Some(sink) = self.sink.get() else {
            return;
        };
        for request_id in unanswered {
            sink.emit(
                "interactive-request-close",
                json!({
                    "sessionId": session_id,
                    "requestId": request_id,
                }),
            );
        }
    }

    /// Track a relayed `PermissionRequest` / `InteractiveRequest` frame (the
    /// `pending_modal_ids` set — the pending-modal cleanup's source). The `id` is the
    /// request's `requestId` (the payload's key — the `interactive-request-close`
    /// frame's `requestId` field).
    ///
    /// A SUBAGENT's gates are NOT closed here: this set is reached only through
    /// `on_session_exited_expected` → `cleanup_pending_modals`, which a child's
    /// `Exited` never reaches (the arm is gated `!is_subagent`) and which returns
    /// without a `live` entry that a child never has. A torn-down child closes
    /// its OWN cards from `finish_subagent` (`worker/manager.rs`, ADR 0055).
    fn track_modal(&self, session_id: &str, id: &str) {
        self.with_session_mut(session_id, |row| {
            if let Some(live) = row.live.as_mut() {
                let mut ids_guard = live
                    .pending_modal_ids
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                ids_guard.insert(id.to_string());
            }
        });
    }
    // ── (Fulcrum T3) The `config-update` push (live-reload) ────────────────

    /// Push the three live-reload desktop-config fields to every LIVE Worker
    /// (Fulcrum T3) — the frame that REPLACED the Worker's per-turn
    /// `settings.json` read, so "edit Settings, it applies at the next prompt,
    /// no restart" survives the removal of that read.
    ///
    /// Called from `commands::settings::save_settings` after the file is
    /// written: the Supervisor is the only process that reads desktop config,
    /// and it hands the result down. Without this trigger the frame exists but
    /// nothing sends it, and a green suite would claim live-reload works.
    ///
    /// All THREE fields go on every push (the caller just saved the whole
    /// `Settings`, so all three are fresh). `None` would mean "leave it alone"
    /// — used by a partial push, which the frame supports for an older
    /// Supervisor; here there is no such caller, and sending all three is what
    /// keeps the Workers' packaged state equal to the file that was just saved.
    ///
    /// Best-effort per session, the `refresh_live_models` discipline verbatim:
    /// a dead / mid-teardown Worker is SKIPPED, never an error — the save
    /// already succeeded and must not be reported as failed because one
    /// session is going away. The `sessions` lock is collected BEFORE any send
    /// so it is never held across an `await` / a pipe write.
    ///
    /// On a DELIVERED frame the registry's STORED env is mirrored too
    /// (`mirror_stored_desktop_config`) — that copy is what each child's
    /// packaged five are read from, so the push reaches subagents dispatched
    /// after this point (ADR 0023's next-dispatch property). A failed send
    /// mirrors NOTHING: the loop never applied it, and a child must not inherit
    /// a policy its parent is not running (finding 12's rule).
    ///
    /// `providers` / `mcp_servers` are deliberately NOT pushed — the recorded
    /// residual hole (both stay session-construction snapshots).
    ///
    /// Returns the number of Workers the frame was DELIVERED to.
    pub async fn push_config_update(&self, settings: &crate::config::Settings) -> usize {
        let Some(wm) = self.worker_manager.get().cloned() else {
            // No `WorkerManager` wired (the pre-`setup_dirs` state, or a test
            // harness): nothing is running, so there is nothing to push to.
            return 0;
        };
        // The live MAIN session ids, collected BEFORE any send.
        let ids: Vec<String> = {
            let sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            sessions.keys().cloned().collect()
        };
        let mut delivered = 0;
        for id in ids {
            let Some(handle) = wm.handle_for(&id) else {
                // A row with no live Worker (already reaped) — skip.
                continue;
            };
            let policy = settings.file_policy.clone();
            let web = settings.web.clone();
            let overrides = settings.agent_overrides.clone();
            if handle
                .send_config_update(
                    Some(policy.clone()),
                    Some(web.clone()),
                    Some(overrides.clone()),
                )
                .is_ok()
            {
                wm.mirror_stored_desktop_config(&id, Some(&policy), Some(&web), Some(&overrides));
                delivered += 1;
            }
        }
        delivered
    }
}

/// Run one Worker task-board call against the Supervisor's `Db` (issue #180 D2).
///
/// The body of the `WorkerInboundEvent::TaskRequest` router arm, factored out so
/// it is testable without a live Worker: the arm needs a `WorkerManager` and a
/// live session to deliver its answer, this needs only a `Db`.
///
/// Every arm runs the SYNC `impl TaskStore for Db` inside `spawn_blocking`. That
/// is not defensive style — `rusqlite` is a blocking driver and `Db`'s methods
/// take the connection mutex, so calling one directly from this `async` block
/// would hold a tokio worker thread for the duration of a SQLite statement. The
/// crate's trait is sync BY DESIGN (ADR 0092: the desktop implements it on `Db`,
/// Supervisor-side, because the Supervisor is the sole SQLite writer), so the
/// async shape lives HERE and never in the trait.
///
/// The return is the DTO SERIALIZED, because `Inbound::TaskResponse` carries a
/// `serde_json::Value` and F1's Worker arm deserializes the shape its verb
/// expects. `None` serializes to `null`, which is what F1's `get_task` /
/// `get_artifact` arms decode as "no row" — an answer, not an error.
async fn run_task_call(db: &Arc<Db>, call: TaskCall) -> Result<serde_json::Value, TaskStoreError> {
    // Every arm goes through `<Db as TaskStore>::…` and NOT through a method call
    // on `db`. That is load-bearing, not ceremony. Six of the seven verbs have an
    // INHERENT `Db` method of the same name (the desktop's own board API), and Rust
    // prefers inherent methods — so `db.move_task(…)` here would bind to the
    // DESKTOP's `move_task`, whose `MoveOutcome` is `{ on_enter }` alone. The answer
    // would serialize without `toStage`/`note`, and F1's Worker arm decodes a
    // REQUIRED `to_stage`, so the tool would fail with "task response was not a move
    // outcome" — a desktop-green, CI-green build whose every move is broken. Same
    // trap for `get_task` (the desktop's row has no `artifactKeys`, which the crate's
    // `TaskDetail` requires). The qualified path is the only spelling that says
    // "the seam, not the desktop's twin", and `run_task_call_creates_edits_and_moves_and_shapes_each_answer`
    // is the pin that reddens if one is spelled back to a method call.
    //
    // One `db.clone()` per arm: the `FnOnce` the blocking pool runs has to own what
    // it closes over, and `Arc<Db>` is the cheap kind of clone.
    let value = match call {
        TaskCall::ListBoard { space_path } => {
            let db = db.clone();
            let rows = spawn_board("list_board", move || {
                <Db as TaskStore>::list_board(&db, &space_path)
            })
            .await?;
            serde_json::to_value(rows)
        }
        TaskCall::GetTask { task_id } => {
            let db = db.clone();
            let row = spawn_board("get_task", move || {
                <Db as TaskStore>::get_task(&db, &task_id)
            })
            .await?;
            serde_json::to_value(row)
        }
        TaskCall::CreateTask {
            space_path,
            title,
            body,
            stage_slug,
        } => {
            let db = db.clone();
            let row = spawn_board("create_task", move || {
                <Db as TaskStore>::create_task(
                    &db,
                    &space_path,
                    &title,
                    body.as_deref(),
                    stage_slug.as_deref(),
                )
            })
            .await?;
            serde_json::to_value(row)
        }
        TaskCall::EditTask {
            task_id,
            title,
            body,
            spec_path,
        } => {
            let db = db.clone();
            let row = spawn_board("edit_task", move || {
                <Db as TaskStore>::edit_task(
                    &db,
                    &task_id,
                    title.as_deref(),
                    body.as_deref(),
                    spec_path.as_deref(),
                )
            })
            .await?;
            serde_json::to_value(row)
        }
        TaskCall::MoveTask {
            space_path,
            task_id,
            to_stage,
        } => {
            let db = db.clone();
            let outcome = spawn_board("move_task", move || {
                <Db as TaskStore>::move_task(&db, &space_path, &task_id, &to_stage)
            })
            .await?;
            serde_json::to_value(outcome)
        }
        TaskCall::GetArtifact { task_id, key } => {
            let db = db.clone();
            let artifact = spawn_board("get_artifact", move || {
                <Db as TaskStore>::get_artifact(&db, &task_id, &key)
            })
            .await?;
            serde_json::to_value(artifact)
        }
        TaskCall::WriteArtifact {
            task_id,
            key,
            markdown,
        } => {
            let db = db.clone();
            let meta = spawn_board("write_artifact", move || {
                <Db as TaskStore>::write_artifact(&db, &task_id, &key, &markdown)
            })
            .await?;
            serde_json::to_value(meta)
        }
    };
    value.map_err(|e| TaskStoreError::Invalid {
        message: format!("task response could not be serialized: {e}"),
    })
}

/// One board verb, on the blocking pool, with both error maps applied.
///
/// Generic over the error the closure returns, and that is not generality for its
/// own sake: `list_board` exists ONLY on the `TaskStore` trait (the desktop has no
/// inherent `list_board` — its flat board read is `list_tasks`), so that arm yields
/// the crate's `TaskStoreError` while every other arm hits an INHERENT `Db` method
/// and yields the desktop's `BoardError`. Both belong in this one helper, mapped by
/// the `From` impls in `storage/db.rs` — the same "one place owns the mapping" split
/// `From<DbError> for StoreError` uses for the persistence seam.
///
/// A panicked blocking task, or a runtime shutting down mid-call, becomes an `Io`
/// naming the verb, because the Worker shows that sentence to the model and
/// "the Supervisor's `move_task` call failed" is the truth.
///
/// And a call that NEVER returns becomes one too, at `TASK_BOARD_CALL_TIMEOUT` —
/// with its own sentence (`timed out`, not `failed`), because "the blocking task
/// died" and "the blocking task was still running after half a minute" are
/// different facts and the model reads both verbatim.
async fn spawn_board<T, E, F>(verb: &'static str, f: F) -> Result<T, TaskStoreError>
where
    T: Send + 'static,
    E: Into<TaskStoreError> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    with_board_deadline(verb, async move {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| TaskStoreError::Io {
                message: format!("Supervisor `{verb}` board call failed: {e}"),
            })?
            .map_err(Into::into)
    })
    .await
}

/// How long one Supervisor-side board call may run before the Worker is answered
/// with an error. Every layer below this is already bounded or already fast:
/// `busy_timeout` is 5 s, a healthy board read is sub-millisecond, and the verbs
/// take one mutex. So this is the backstop for a wedged `Db` and for a frame that
/// never reaches its Worker — not a policy about how long a board read should take.
const TASK_BOARD_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Run one board future under `TASK_BOARD_CALL_TIMEOUT`, mapping expiry to the `Io`
/// sentence the Worker shows the model. Factored out of `spawn_board` so the
/// deadline is provable with a `pending()` future and a paused clock.
async fn with_board_deadline<T, E, F>(verb: &'static str, f: F) -> Result<T, TaskStoreError>
where
    T: Send + 'static,
    E: Into<TaskStoreError>,
    F: std::future::Future<Output = Result<T, E>>,
{
    tokio::time::timeout(TASK_BOARD_CALL_TIMEOUT, f)
        .await
        .map_err(|_| TaskStoreError::Io {
            message: format!(
                "Supervisor `{verb}` board call timed out after {TASK_BOARD_CALL_TIMEOUT:?}"
            ),
        })?
        .map_err(Into::into)
}

/// Where a board answer must be delivered: the ORIGIN (the Worker that emitted the
/// frame), never the pump's delivery id. For a Subagent the delivery id is the
/// PARENT's, and answering it writes a correct `TaskResponse` into the parent's
/// stdin, where the parent's per-Worker pending map has no such `request_id` and
/// ignores it exactly as its contract requires — the child then parks with no
/// bound. `None` means UNROUTABLE: a child frame with no origin must NOT fall back
/// (ADR 0117). A main session's delivery id IS its own id, so for a main frame the
/// delivery id is an identity, not a fallback.
///
/// A free function and not an inline `match` precisely so all three branches are
/// unit-testable: the positive "the answer reaches the child" case needs a real
/// `drives` entry, which only exists in the end-to-end (a child's `WorkerHandle`
/// is unreachable from a desktop unit test — `dispatch_subagent` is `pub(crate)`
/// in the crate and `WorkerHandle` exposes no accessor for frames written into a
/// Worker). What is testable here is the DECISION, and that is what this owns.
fn task_reply_target(delivery_id: &str, is_subagent: bool, origin: Option<&str>) -> Option<String> {
    match origin {
        Some(origin) => Some(origin.to_string()),
        None if is_subagent => None,
        None => Some(delivery_id.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::oneshot;

    use super::*;
    use crate::agent::crashlog::is_worker_crash_log_name;
    use crate::agent::events::RpcEvent;
    use crate::agent::session::LiveWorkerSession;

    #[test]
    fn subagent_agent_settled_does_not_resolve_parent_turn() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // A subagent settles under the parent's delivery id (`is_subagent: true`).
        manager.route_event(
            sid,
            true,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );

        // The parent's turn MUST NOT be resolved!
        assert!(
            rx.try_recv().is_err(),
            "parent turn must still be in flight"
        );

        // When the parent itself settles (`is_subagent: false`), the turn resolves.
        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );
        assert_eq!(rx.try_recv().unwrap(), StopReason::EndTurn);
    }

    /// (issue #190) A truncated turn settles as `MaxTokens`, not `EndTurn`.
    ///
    /// The whole desktop half of the fix in one assertion: the engine emits
    /// `turn_truncated` BEFORE `turn_end` / `agent_settled` on the same pipe,
    /// `route_event` stashes the disposition, and `resolve_turn` maps it. The
    /// bug this pins is the SILENT one — a length-truncated turn used to fall
    /// through to `EndTurn`, so the composer unlocked, nothing ran, and no
    /// error appeared (the turn loop read `FinishReason::Length` at zero sites).
    #[test]
    fn main_session_turn_truncated_resolves_the_turn_as_max_tokens() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // The engine's order on the pipe: the disposition FIRST, then the settle.
        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::turn_truncated),
        );
        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );

        assert_eq!(
            rx.try_recv().unwrap(),
            StopReason::MaxTokens,
            "a truncated turn must settle as max_tokens, not the silent end_turn"
        );
    }

    /// (issue #193) A turn the ENGINE stopped (its own bound) settles as
    /// `MaxTurnRequests`, not `EndTurn`.
    ///
    /// The desktop half of the fix, and the first construction site
    /// `StopReason::MaxTurnRequests` has ever had. The engine emits
    /// `turn_capped` BEFORE `turn_end` / `agent_settled` on the same pipe (a run
    /// of identical refused tool batches — since `fulcrum-harness 0.5.1` that run
    /// is the ONLY producer of this frame, the per-prompt round bound being
    /// deleted with ADR 0116), `route_event` stashes it, `resolve_turn` maps it.
    /// The bug this pins is the SAME silent one #190 fixed for `length`: with no
    /// arm naming the frame, a capped turn resolved as `end_turn` — the composer
    /// unlocked, no footer line, and `attention.ts` announced it as "finished —
    /// waiting for you".
    #[test]
    fn main_session_turn_capped_resolves_the_turn_as_max_turn_requests() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // The engine's order on the pipe: the disposition FIRST, then the settle.
        manager.route_event(sid, false, WorkerInboundEvent::Event(RpcEvent::turn_capped));
        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );

        assert_eq!(
            rx.try_recv().unwrap(),
            StopReason::MaxTurnRequests,
            "a capped turn must settle as max_turn_requests, not the silent end_turn"
        );
    }

    /// (issue #190) A CHILD's truncation must not mark its PARENT's turn — the
    /// same reason `subagent_agent_settled_does_not_resolve_parent_turn`
    /// documents for the settle: a subagent's frames arrive under the parent's
    /// delivery id, and the parent's own reply may have ended normally.
    #[test]
    fn subagent_turn_truncated_leaves_the_parent_resolving_end_turn() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        manager.route_event(
            sid,
            true,
            WorkerInboundEvent::Event(RpcEvent::turn_truncated),
        );
        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );

        assert_eq!(
            rx.try_recv().unwrap(),
            StopReason::EndTurn,
            "a child's truncation is the CHILD's outcome — the parent ended normally"
        );
    }

    /// (issue #190, ADR 0108's amendment) `Cancelled` BEATS `MaxTokens`: a user who
    /// pressed Stop on a turn whose reply was also cut off cancelled it — the
    /// more specific fact about what happened.
    #[test]
    fn cancel_requested_wins_over_truncated() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(true)),
                disposition: Arc::new(StdMutex::new(Some(TurnDisposition::Truncated))),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );

        assert_eq!(
            rx.try_recv().unwrap(),
            StopReason::Cancelled,
            "Stop beats a truncation (ADR 0108 amendment)"
        );
    }

    /// (issue #190) A FORCED resolve retires the truncation it ends.
    ///
    /// `resolve_turn` is the flag's only consumer and `send_prompt` its only
    /// clearer, so a turn that ends WITHOUT a settle strands the flag: the
    /// per-Worker transport is a 256-slot broadcast whose `Lagged` arm logs and
    /// `continue`s (`worker/client.rs`), so a dropped `agent_settled` means
    /// nothing ever reads the disposition. The crash / close path already forces
    /// the turn over regardless of `cancel_requested`; it must clear the flag for
    /// the same reason — the flag describes the turn that just ended. Without
    /// the clear, the next turn's `send_prompt` clears it only AFTER claiming
    /// `pending_turn`, so a late settle in that window resolves the NEW turn with
    /// the OLD turn's `MaxTokens`.
    #[test]
    fn a_forced_resolve_retires_a_stranded_truncation() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(Some(TurnDisposition::Truncated))),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // The crash: the forced resolve ends the turn (`Cancelled` unlocks the
        // composer) and the row stays LIVE — which is exactly the shape that
        // strands the flag, since the live entry survives to seed the next turn.
        manager.handle_crash(sid, Some(1), None);

        assert_eq!(
            rx.try_recv().unwrap(),
            StopReason::Cancelled,
            "the crash forces the turn to Cancelled"
        );
        let stranded = manager
            .with_session(sid, |s| {
                s.live
                    .as_ref()
                    .map(|live| *live.disposition.lock().unwrap_or_else(|p| p.into_inner()))
            })
            .flatten();
        assert_eq!(
            stranded,
            Some(None),
            "a forced resolve ends the turn the truncation describes — the flag \
             must not outlive it and strand a stale MaxTokens for the next turn"
        );
    }

    /// (issue #193, ADR 0108's amendment) `Cancelled` BEATS a cap: a user who
    /// pressed Stop on a turn the engine also stopped cancelled it — the more
    /// specific fact about what happened. Same precedence as
    /// `cancel_requested_wins_over_truncated`, and the reason the exhaustive
    /// match puts `(true, _)` FIRST.
    ///
    /// The cap is stashed through the REAL event path rather than hand-seeded, so
    /// the first assertion proves the test is not vacuous — under a `resolve_turn`
    /// with no arm naming `turn_capped` the slot is empty and "Stop wins" is
    /// trivially true of nothing.
    #[test]
    fn cancel_requested_wins_over_a_cap() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // Precondition: the cap is stashed (so the precedence below is real).
        manager.route_event(sid, false, WorkerInboundEvent::Event(RpcEvent::turn_capped));
        let stashed = manager
            .with_session(sid, |s| {
                s.live
                    .as_ref()
                    .map(|live| *live.disposition.lock().unwrap_or_else(|p| p.into_inner()))
            })
            .flatten();
        assert_eq!(
            stashed,
            Some(Some(TurnDisposition::Capped)),
            "precondition: the router stashed the cap as a disposition"
        );

        // The Stop lands after the cap (the user pressed Stop on a capped turn).
        *manager
            .with_session(sid, |s| {
                s.live.as_ref().map(|live| live.cancel_requested.clone())
            })
            .flatten()
            .expect("the live row is still there")
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = true;

        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );

        assert_eq!(
            rx.try_recv().unwrap(),
            StopReason::Cancelled,
            "Stop beats the engine's own bound (ADR 0108 amendment)"
        );
    }

    /// (issue #193) A FORCED resolve retires the CAP it ends — the same stranded-
    /// disposition bug `a_forced_resolve_retires_a_stranded_truncation` exists to
    /// prevent, for the new variant. A cap that outlives its turn resolves the
    /// NEXT turn as `max_turn_requests` (see that test for the full mechanism:
    /// `resolve_turn` is the only consumer, `send_prompt` clears only AFTER
    /// claiming the slot, and the Worker's broadcast can drop an
    /// `agent_settled` off a LIVING Worker).
    #[test]
    fn a_forced_resolve_retires_a_stranded_cap() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // Stash the cap through the real event path (no arm → nothing is stashed,
        // which is what makes the clear un-testable until the stash exists).
        manager.route_event(sid, false, WorkerInboundEvent::Event(RpcEvent::turn_capped));
        let stashed = manager
            .with_session(sid, |s| {
                s.live
                    .as_ref()
                    .map(|live| *live.disposition.lock().unwrap_or_else(|p| p.into_inner()))
            })
            .flatten();
        assert_eq!(
            stashed,
            Some(Some(TurnDisposition::Capped)),
            "precondition: the router stashed the cap"
        );

        // The crash: the forced resolve ends the turn and the row stays LIVE —
        // exactly the shape that strands the disposition.
        manager.handle_crash(sid, Some(1), None);

        assert_eq!(
            rx.try_recv().unwrap(),
            StopReason::Cancelled,
            "the crash forces the turn to Cancelled"
        );
        let stranded = manager
            .with_session(sid, |s| {
                s.live
                    .as_ref()
                    .map(|live| *live.disposition.lock().unwrap_or_else(|p| p.into_inner()))
            })
            .flatten();
        assert_eq!(
            stranded,
            Some(None),
            "a forced resolve ends the turn the cap describes — the disposition \
             must not outlive it and strand a stale max_turn_requests for the \
             next turn"
        );
    }

    #[test]
    fn subagent_exited_does_not_close_parent_session() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // A subagent exits under the parent's delivery id (`is_subagent: true`).
        manager.route_event(sid, true, WorkerInboundEvent::Exited(Some(0)));

        // The parent's session must still be live and pending turn untouched!
        // (The same `contains_key` predicate the `live` map answered — now the
        // row's `live` slice, read through the accessor.)
        assert!(manager
            .with_session(sid, |s| s.live.is_some())
            .unwrap_or(false));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn fetch_render_request_does_not_track_modal() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(None)),
                cancel_requested: Arc::new(StdMutex::new(false)),
                disposition: Arc::new(StdMutex::new(None)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::FetchRenderRequest {
                id: "render-1".to_string(),
                payload: serde_json::json!({
                    "sessionId": sid,
                    "requestId": "render-1",
                    "url": "https://example.com",
                    "timeoutMs": 5000,
                }),
            },
        );

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let modals = manager
            .with_session(sid, |s| {
                s.live
                    .as_ref()
                    .map(|session| session.pending_modal_ids.lock().unwrap().clone())
            })
            .flatten()
            .expect("the seeded live session is still there");
        assert!(
            !modals.contains("render-1"),
            "fetch render request must NOT be tracked as a user modal"
        );
    }

    /// The crash-log NAME matcher accepts BOTH shapes — the pre-amendment
    /// `crash-<ts>-worker.log` and the pid-stamped `crash-<ts>-worker-<pid>.log`
    /// — because the rename and the matcher land in one commit: a banner
    /// whose link silently stops matching is invisible to the integration
    /// suite (`tests/ipc.rs`'s crash case asserts only `at`, never
    /// `crashLog`).
    ///
    /// Tested as a PURE function (no filesystem) on purpose: the two shapes
    /// it accepts are a string rule, and the selector that consumes it
    /// ([`find_crash_log_for_pid`]) is tested separately over temp dirs.
    #[test]
    fn is_worker_crash_log_name_accepts_both_shapes() {
        // The pre-amendment shape (still on disk from before the rename)
        // and the pid-stamped shape.
        assert!(
            is_worker_crash_log_name("crash-1-worker.log"),
            "the pid-less pre-amendment name still matches"
        );
        assert!(
            is_worker_crash_log_name("crash-1-worker-4242.log"),
            "the pid-stamped name matches"
        );

        // Every negative: a different tag, an empty pid, a non-numeric
        // pid, the wrong extension, and a name that merely ENDS like ours
        // without the `crash-` prefix.
        for rejected in [
            "crash-1-supervisor.log",
            "crash-1-worker-.log",
            "crash-1-worker-abc.log",
            "crash-1-worker-4242.txt",
            "notes-worker-1.log",
        ] {
            assert!(
                !is_worker_crash_log_name(rejected),
                "`{rejected}` is not a Worker crash log"
            );
        }
    }

    // ── The pid-based crash-log selector ──────────────────────────────────

    /// Seed `<dir>/<name>` with a given age (seconds ago), so a test can
    /// state which of two crash logs is the NEWER one without racing the
    /// filesystem's mtime granularity. `now - secs_ago` — the larger
    /// `secs_ago`, the OLDER the file.
    fn seed_crash_log(dir: &std::path::Path, name: &str, secs_ago: u64) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "x").expect("the seeded crash log is writable");
        let mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("the seeded crash log is re-openable")
            .set_modified(mtime)
            .expect("the seeded crash log's mtime is settable");
        path
    }

    /// A throwaway directory to seed crash logs into (the selector takes
    /// the directory — that is the whole point of Task 6's seam).
    ///
    /// An owning [`ScratchDir`](crate::test_support::ScratchDir) (#96 task 04):
    /// this used to mint a bare `crashsel-{uuid}` and remove nothing, leaking
    /// one dir per test per run. The prefix stays VERBATIM — only the tag is
    /// new — so #96's census keeps attributing it here.
    fn crash_dir() -> crate::test_support::ScratchDir {
        crate::test_support::ScratchDir::in_env_temp("crashsel-", "select")
    }

    /// Attribution is by IDENTITY, not by recency: with N concurrent
    /// **Subagent** Workers, the newest log on disk is routinely a
    /// *different* Worker's crash, and a banner that names it sends the
    /// user to the wrong post-mortem. The pid the Supervisor holds (the
    /// handle's, captured at spawn) picks the owner's log even when some
    /// other Worker died LATER.
    #[test]
    fn the_pid_named_log_wins_over_a_newer_foreign_one() {
        let dir = crash_dir();
        let mine = seed_crash_log(&dir, "crash-1000-worker-4242.log", 120);
        // A FOREIGN Worker's crash, stamped NEWER — recency would pick it.
        seed_crash_log(&dir, "crash-2000-worker-9999.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, Some(4242)).as_deref(),
            Some(mine.as_path()),
            "the log belonging to pid 4242 wins over a newer foreign crash log"
        );
    }

    /// A crash log written before the pid stamping landed sits in the
    /// user's data dir with NO pid in its name, and a crash whose pid the
    /// Supervisor could not capture queries with `None` — that pair must
    /// still resolve, or the amendment silently drops the banner's link
    /// for exactly the users whose old logs are already on disk.
    #[test]
    fn a_pid_less_log_is_still_found_when_the_pid_is_unknown() {
        let dir = crash_dir();
        let old = seed_crash_log(&dir, "crash-1000-worker.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, None).as_deref(),
            Some(old.as_path()),
            "the pre-amendment pid-less log is still attributed when no pid is known"
        );
    }

    /// A pid-less query never blames a log that names a SPECIFIC process.
    ///
    /// ⚠ This is NOT a vacuous clause, which is easy to assume:
    /// [`is_worker_crash_log_name`] accepts BOTH name shapes (so a rename can
    /// never strand the banner), which means a pid-stamped name DOES satisfy
    /// the predicate — only this suffix check keeps it out of a pid-less
    /// answer. Delete it and a query that explicitly does not know a pid
    /// picks a named process's log.
    #[test]
    fn a_pid_less_query_never_names_a_pid_stamped_log() {
        let dir = crash_dir();
        // Only pid-stamped logs — nobody's pid is known, so nothing is
        // attributable to an anonymous query.
        seed_crash_log(&dir, "crash-1000-worker-4242.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, None),
            None,
            "a query with no pid must not answer with a log that names pid 4242"
        );
    }

    /// A pid that matches NOTHING yields `None`, NOT "the newest log I
    /// could find". The old recency rule always returned *a* path, so a
    /// crashed Worker whose log was already pruned pointed the user at an
    /// unrelated crash — a wrong link is worse than no link, and
    /// `StalledInfo.crash_log` is an `Option` the banner already renders.
    #[test]
    fn an_unmatched_pid_returns_no_log_rather_than_guessing() {
        let dir = crash_dir();
        // A perfectly good Worker crash log — belonging to somebody else.
        seed_crash_log(&dir, "crash-2000-worker-9999.log", 0);
        // And a file whose TAIL matches the queried pid but that is no crash
        // log at all: the pid tail alone must not be the whole rule (the
        // shared `crash-`-anchored predicate still has to agree).
        seed_crash_log(&dir, "notes-worker-1.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, Some(1)),
            None,
            "a pid with no matching log must not borrow another Worker's crash, \
             and must not pick a non-crash file that merely ends `worker-1.log`"
        );
    }

    #[test]
    fn sink_frame_interactive_event_todos_update_persists_for_main_not_subagent() {
        let dir = crate::test_support::ScratchDir::in_env_temp("router-todos-", "persist");
        let db = Arc::new(crate::storage::Db::open(&dir.join("t.db")).unwrap());

        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());

        struct LocalTestSink {
            emitted: Arc<StdMutex<Vec<(String, serde_json::Value)>>>,
        }
        impl crate::agent::events::EventSink for LocalTestSink {
            fn emit(&self, event: &str, payload: serde_json::Value) {
                self.emitted
                    .lock()
                    .unwrap()
                    .push((event.to_string(), payload));
            }
        }
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        manager.set_sink(Arc::new(LocalTestSink {
            emitted: emitted.clone(),
        }));

        let main_sid = "main-session";
        let sub_sid = "sub-session";

        db.record_session(&crate::agent::SessionInfo {
            session_id: main_sid.to_string(),
            cwd: dir.to_path_buf(),
            capabilities: serde_json::Value::Null,
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .unwrap();

        db.record_session(&crate::agent::SessionInfo {
            session_id: sub_sid.to_string(),
            cwd: dir.to_path_buf(),
            capabilities: serde_json::Value::Null,
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: true,
        })
        .unwrap();

        let todos_payload = serde_json::json!({
            "sessionId": main_sid,
            "seq": 0,
            "event": "todos_update",
            "payload": {
                "source": "native",
                "todos": [
                    { "content": "do laundry", "status": "pending" }
                ]
            }
        });

        // (a) Main session (is_subagent: false):
        // receiving SinkFrame writes todos_json in db AND re-emits to sink.
        manager.route_event(
            main_sid,
            false,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: todos_payload.clone(),
            },
        );

        let stored = db
            .session_todos(main_sid)
            .unwrap()
            .expect("main session todos should be stored");
        assert!(stored.contains("do laundry"));
        {
            let frames = emitted.lock().unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].0, "interactive-event");
            assert_eq!(frames[0].1, todos_payload);
        }

        // (b) Subagent session (is_subagent: true):
        // receiving the same frame does NOT touch db.session_todos(sub_sid)
        let sub_payload = serde_json::json!({
            "sessionId": sub_sid,
            "seq": 0,
            "event": "todos_update",
            "payload": {
                "source": "native",
                "todos": [
                    { "content": "subagent work", "status": "pending" }
                ]
            }
        });
        manager.route_event(
            sub_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: sub_payload.clone(),
            },
        );

        assert_eq!(
            db.session_todos(sub_sid).unwrap(),
            None,
            "subagent todos must not be written to db"
        );
        {
            let frames = emitted.lock().unwrap();
            assert_eq!(frames.len(), 2, "sink frame is still re-emitted to UI");
            assert_eq!(frames[1].0, "interactive-event");
            assert_eq!(frames[1].1, sub_payload);
        }
    }

    /// What `manager_with_rows` hands back. The scratch dir comes FIRST so a
    /// caller that destructures it into a `_dir` binding declared first drops
    /// it LAST — the `Db`'s SQLite file lives INSIDE the dir (the same
    /// ordering rule the `persist.rs` `temp_db` doc records; Linux cannot show
    /// the failure, Windows can). Named because a 4-tuple return trips
    /// `clippy::type_complexity` and this crate runs clippy at 0 warnings.
    type Harness = (
        crate::test_support::ScratchDir,
        SessionManager,
        Arc<crate::storage::Db>,
        Arc<StdMutex<Vec<(String, serde_json::Value)>>>,
    );

    /// A harness: a `SessionManager` over a real `Db` + a recording sink (its
    /// `persister` wired by `attach_db`), with EXACTLY the rows `rows` names
    /// pre-recorded (`(session_id, is_subagent)`).
    ///
    /// Which rows exist is the caller's business on purpose: a test that wants
    /// the ROUTER's gate alone pre-seeds both rows (`manager_with_rows`), while
    /// a test that wants the row-ensure in the frame — the shape a cold child
    /// really has — seeds only the parent.
    fn manager_seeded(tag: &str, rows: &[(&str, bool)]) -> Harness {
        let dir = crate::test_support::ScratchDir::in_env_temp(tag, "persist");
        let db = Arc::new(crate::storage::Db::open(&dir.join("t.db")).unwrap());

        struct LocalTestSink {
            emitted: Arc<StdMutex<Vec<(String, serde_json::Value)>>>,
        }
        impl crate::agent::events::EventSink for LocalTestSink {
            fn emit(&self, event: &str, payload: serde_json::Value) {
                self.emitted
                    .lock()
                    .unwrap()
                    .push((event.to_string(), payload));
            }
        }
        let emitted = Arc::new(StdMutex::new(Vec::new()));

        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());
        manager.set_sink(Arc::new(LocalTestSink {
            emitted: emitted.clone(),
        }));

        for (sid, is_subagent) in rows {
            db.record_session(&crate::agent::SessionInfo {
                session_id: sid.to_string(),
                cwd: dir.to_path_buf(),
                capabilities: serde_json::Value::Null,
                config_options: None,
                archived: false,
                title: None,
                context_usage: None,
                cost_usd: None,
                is_subagent: *is_subagent,
            })
            .unwrap();
        }
        (dir, manager, db, emitted)
    }

    /// The both-rows harness: parent AND child rows pre-recorded, so the test
    /// sees the ROUTER's gate and its target extraction with the persister's
    /// row-ensure already out of the way (the row-ensure has its own pin in
    /// `persist.rs`).
    fn manager_with_rows(tag: &str, main_sid: &str, sub_sid: &str) -> Harness {
        manager_seeded(tag, &[(main_sid, false), (sub_sid, true)])
    }

    /// The gate is narrowed PER EVENT, not deleted: a subagent's own
    /// `cost_update` now persists to the CHILD's row (a child's spend is its
    /// own money, and issue #105 needs the child's stored figure to match its
    /// card), while a subagent's `todos_update` STILL does not — the todo
    /// panel is a main-session surface, and that half is pinned unmodified by
    /// `sink_frame_interactive_event_todos_update_persists_for_main_not_subagent`.
    /// Re-emission to the UI is unaffected either way (the sink arm is
    /// unconditional).
    ///
    /// The delivery mirrors the PUMP's real shape, not a convenient one: a
    /// subagent's frames arrive under the PARENT's delivery id (`pump.rs`'s
    /// `delivery_id`) with the CHILD's id only in the payload's `sessionId`.
    /// So this test also pins WHICH row the child's money lands on — the
    /// child's. Getting that wrong is not cosmetic, and since Fulcrum T2 the
    /// failure mode has changed SHAPE: the frames carry TOTALS and the write
    /// overwrites, so a child's figure routed to the parent's delivery id would
    /// not accumulate onto the parent — it would REPLACE the parent's own total
    /// with the child's, silently losing the parent's money. (The retired
    /// roll-up compounded this: it overwrote the parent's row with the child's
    /// total too, so the parent's own spend was unrecoverable — which is the
    /// same two-writers-on-one-key defect the roll-up's removal ended.)
    #[test]
    fn a_subagent_cost_frame_persists_but_a_subagent_todo_frame_still_does_not() {
        let (main_sid, sub_sid) = ("main-session", "sub-session");
        let (_dir, manager, db, emitted) = manager_with_rows("router-cost", main_sid, sub_sid);

        // Delivered under the PARENT's id (what the pump does), payload keyed
        // to the CHILD (what the emitting loop writes).
        manager.route_event(
            main_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: serde_json::json!({
                    "sessionId": sub_sid,
                    "seq": 0,
                    "event": "cost_update",
                    "payload": { "costUsd": 0.00001243, "source": "main" },
                }),
            },
        );
        assert_eq!(
            db.session_cost(sub_sid).unwrap(),
            Some(0.00001243),
            "a child's own cost frame writes the CHILD's row"
        );
        assert_eq!(
            db.session_cost(main_sid).unwrap(),
            None,
            "the child's money must NOT land on the delivery id's row — that id \
             is the PARENT's, and a snapshot write there would replace the \
             parent's own total with the child's figure"
        );

        // A LATER frame from the same child carries the child's NEW total, and
        // the child's row reads exactly that — the stored figure EQUALS the last
        // frame's total (the snapshot contract), where the retired increment
        // would have read the sum `0.00003243`.
        manager.route_event(
            main_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: serde_json::json!({
                    "sessionId": sub_sid,
                    "seq": 0,
                    "event": "cost_update",
                    "payload": { "costUsd": 0.00002, "source": "main" },
                }),
            },
        );
        assert_eq!(
            db.session_cost(sub_sid).unwrap(),
            Some(0.00002),
            "the child's row tracks the LAST total, not the sum of its frames"
        );

        manager.route_event(
            main_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: serde_json::json!({
                    "sessionId": sub_sid,
                    "seq": 0,
                    "event": "todos_update",
                    "payload": {
                        "source": "native",
                        "todos": [{ "content": "subagent work", "status": "pending" }],
                    },
                }),
            },
        );
        assert_eq!(
            db.session_todos(sub_sid).unwrap(),
            None,
            "todos persistence stays MAIN-ONLY — the gate must not be widened \
             generically (this is the assertion the pre-existing gate test pins)"
        );
        assert_eq!(
            db.session_todos(main_sid).unwrap(),
            None,
            "and a child's todo frame must not be redirected onto the parent's row either"
        );

        let frames = emitted.lock().unwrap();
        assert_eq!(
            frames.len(),
            3,
            "every frame is still re-emitted to the UI verbatim (two cost frames \
             and one todo frame)"
        );
        assert_eq!(frames[0].1["event"], "cost_update");
        assert_eq!(frames[1].1["event"], "cost_update");
        assert_eq!(frames[2].1["event"], "todos_update");
    }

    /// A COLD child's first cost frame — the row does not exist yet — still
    /// lands on the CHILD's row, created by the persister's `ensure_session_row`,
    /// under the PARENT's delivery id.
    ///
    /// Why this needs a router-level pin at all: `persist.rs`'s
    /// `a_cost_frame_for_a_session_with_no_row_yet_still_persists` proves the
    /// no-row case by calling `apply_interactive_event` DIRECTLY with the child
    /// id — so the target the router computes is never involved. And the two
    /// sibling router pins pre-record BOTH rows, so the row-ensure is never
    /// involved. Neither half covers the combination, which is exactly what the
    /// real wire delivers: the pump re-targets a child frame's delivery id to
    /// the PARENT (`pump.rs`'s `delivery_id`) while the loop stamps the payload
    /// with the CHILD's `sessionId`, and the child's row is created by THIS
    /// frame.
    ///
    /// The combination is load-bearing in both directions. If the router keyed
    /// the write off the delivery id (`session_id`) instead of extracting the
    /// payload's id, the money would land on the parent's row — and here it
    /// would ALSO create the parent's `cost_usd` before the parent had spent
    /// anything, so the parent's row would carry a child's figure as its own
    /// total, and the snapshot write would leave no trace of what it replaced
    /// (the parent's own money then unrecoverable — the same last-frame-wins loss
    /// that made the retired parent-keyed roll-up a defect rather than a
    /// feature). And if the row-ensure were dropped for this path,
    /// `record_session_cost`'s silent no-op on a missing row would discard the
    /// child's first figure without a sound — the child's card would show a cost
    /// its row never had.
    #[test]
    fn a_childs_first_cost_frame_under_the_parents_delivery_id_creates_and_writes_the_childs_row() {
        let (main_sid, sub_sid) = ("parent-cold", "child-cold");
        // ONLY the parent's row exists — the child is COLD (no `StoreFrame` has
        // created its row yet, which is the real ordering for a fast first call).
        let (_dir, manager, db, emitted) =
            manager_seeded("router-cold-child", &[(main_sid, false)]);
        assert!(
            db.session(sub_sid).unwrap().is_none(),
            "precondition: the child has NO row at all"
        );

        // Delivered under the PARENT's id (what the pump does), payload keyed
        // to the CHILD (what the emitting loop writes) — `is_subagent: true`.
        manager.route_event(
            main_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: serde_json::json!({
                    "sessionId": sub_sid,
                    "seq": 0,
                    "event": "cost_update",
                    "payload": { "costUsd": 0.00001243, "source": "main" },
                }),
            },
        );

        // The row now exists — created by THIS frame — and carries the flag.
        let row = db
            .session(sub_sid)
            .unwrap()
            .expect("the router must reach the persister's ensure_session_row for a no-row child");
        assert!(
            row.is_subagent,
            "the row the router's target created is the ephemeral CHILD row"
        );
        assert_eq!(
            db.session_cost(sub_sid).unwrap(),
            Some(0.00001243),
            "the child's first total lands on the CHILD's row, not into the void \
             (a first frame's total IS that call's figure — the loop started at zero)"
        );
        assert_eq!(
            db.session_cost(main_sid).unwrap(),
            None,
            "the delivery id is the PARENT's: nothing of the child's money may \
             touch its row (that id has no figure yet, and a snapshot write would \
             leave the parent reporting a child's spend as its own)"
        );

        let frames = emitted.lock().unwrap();
        assert_eq!(
            frames.len(),
            1,
            "re-emission is unaffected — the UI still sees the frame verbatim"
        );
        assert_eq!(frames[0].0, "interactive-event");
        assert_eq!(frames[0].1["sessionId"], sub_sid);
    }

    /// A PARENT-KEYED cost frame's persistence, proven where a `Db` is
    /// reachable.
    ///
    /// The frame synthesised below IS the envelope the parent's own loop emits
    /// — `emit_cost_update` for its own calls and `fold_child_cost` for a
    /// child's, which is the SAME envelope with the child's figure already added
    /// in: `sessionId` = the PARENT, `seq: 0`, `event: "cost_update"`,
    /// `payload: { costUsd, source: "main" }`. It reaches this router the way
    /// every main-session frame does: `hooks.on_event(session, false,
    /// WorkerInboundEvent::SinkFrame { event, payload })`. Routing rather than
    /// emitting straight to the Tauri sink is what makes the parent's STORED
    /// total agree with the figure under its own title.
    ///
    /// What used to be documented here was the Supervisor's parent-keyed
    /// ROLL-UP frame, and that frame is DELETED: two writers on the parent's
    /// store key lose money, because a frame is a snapshot the store overwrites
    /// and the parent's accumulator had never seen the child. The write this
    /// test proves is unchanged; only WHO WRITES the frame moved to the parent's
    /// loop. `subagent_flow.rs`'s `rollup_tests` pin the removal (no
    /// parent-keyed frame from the Supervisor at all).
    ///
    /// Why the assertion lives here and not in `subagent_flow.rs`: `ManagerState`
    /// holds only `workers` / `factory` / `hooks` / `drives` (`registry.rs`) — it
    /// has NO `db` field, so that module can prove what is EMITTED but cannot
    /// assert a write at all. This test closes the link: a parent's frame,
    /// through this router, lands on the PARENT's row. The end-to-end proof
    /// through the real IPC surface is `tests/ipc.rs` (Task 3).
    #[test]
    fn a_parent_keyed_cost_frame_from_the_router_writes_the_parents_row() {
        let (main_sid, sub_sid) = ("parent-1", "child-1");
        let (_dir, manager, db, emitted) = manager_with_rows("router-rollup", main_sid, sub_sid);

        let frame = serde_json::json!({
            "sessionId": main_sid,
            "seq": 0,
            "event": "cost_update",
            "payload": { "costUsd": 0.0000341, "source": "main" },
        });
        manager.route_event(
            main_sid,
            false,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: frame.clone(),
            },
        );

        assert_eq!(
            db.session_cost(main_sid).unwrap(),
            Some(0.0000341),
            "the parent's frame writes the PARENT's row — without this the \
             parent's stored figure disagrees with its displayed one. The stored \
             figure EQUALS the frame's total (the frame carries a TOTAL — the \
             parent's own, or the parent's plus a folded child's — and the write \
             is a snapshot, so nothing is added to it here)"
        );
        // Re-delivering the SAME frame leaves the parent's row exactly where it
        // was — the property the whole change exists to buy, proven on the
        // parent's producer and not only on the child's.
        manager.route_event(
            main_sid,
            false,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: frame.clone(),
            },
        );
        assert_eq!(
            db.session_cost(main_sid).unwrap(),
            Some(0.0000341),
            "a replayed frame overwrites to the SAME figure — the doubling \
             ADR 0082's limit 7 pinned is gone at this producer too"
        );
        assert_eq!(
            db.session_cost(sub_sid).unwrap(),
            None,
            "a parent-keyed frame is the parent's money: the child's row must stay clean"
        );
        let frames = emitted.lock().unwrap();
        assert_eq!(frames.len(), 2, "both deliveries still reach the UI");
        assert_eq!(frames[0].0, "interactive-event");
        assert_eq!(
            frames[0].1, frame,
            "re-emitted VERBATIM — the frontend contract is unchanged"
        );
    }

    // ── The D2 task-board router body (issue #180) ───────────────────────────
    //
    // `run_task_call` is the router arm's whole computation, factored out so it is
    // assertable without a live Worker: the arm itself needs a `WorkerManager` and
    // an attached session to deliver its answer, and the end-to-end proof of THAT
    // delivery is `worker_e2e.rs`'s `task_artifact_round_trips_through_a_real_worker`.
    // What these cases own is the VERB-TO-VERB wiring: that a `TaskCall` reaches the
    // matching `Db` method, that the answer is the serialized DTO the Worker's arm
    // deserializes, and that a refusal crosses as the crate's error rather than as a
    // panic or an `Ok`.
    //
    // Non-vacuity: swap one arm's `Db` method for another (say `GetArtifact` calling
    // `write_artifact`) and the case below naming that verb reddens; delete an arm's
    // `spawn_blocking` and the runtime's own "no reactor" behaviour is not what
    // catches it — the `serde_json` shape assertions do, because the DTO would not
    // arrive.

    /// A `Db` with one Space seeded and one card, as the router finds it.
    fn seeded_board_db(prefix: &str) -> (crate::test_support::ScratchDir, Arc<Db>, String) {
        let dir = crate::test_support::ScratchDir::in_env_temp(prefix, "db");
        let db = Arc::new(Db::open(&dir.join("db.sqlite")).expect("a temp db opens"));
        let space = "/router/task-call";
        db.get_board(space)
            .expect("get_board seeds the five stages");
        let task = db
            .create_task(space, "a card", Some("the body"), None)
            .expect("create_task");
        (dir, db, task.id)
    }

    #[tokio::test]
    async fn run_task_call_writes_and_reads_an_artifact_through_the_db() {
        let (_dir, db, task_id) = seeded_board_db("router-task-call-roundtrip-");

        let written = run_task_call(
            &db,
            TaskCall::WriteArtifact {
                task_id: task_id.clone(),
                key: "spec".to_string(),
                markdown: "ROUTER-SENTINEL".to_string(),
            },
        )
        .await
        .expect("write_artifact over the router path");
        assert_eq!(written["key"], "spec", "the meta names the key");
        assert_eq!(
            written["bytes"],
            serde_json::json!("ROUTER-SENTINEL".len()),
            "`bytes` is the byte length, and it is camelCase on the wire"
        );
        // The meta deliberately carries NO markdown (the caller just sent it).
        assert!(
            written.get("markdown").is_none(),
            "the write answer echoes no document — got {written}"
        );

        let read = run_task_call(
            &db,
            TaskCall::GetArtifact {
                task_id: task_id.clone(),
                key: "spec".to_string(),
            },
        )
        .await
        .expect("get_artifact over the router path");
        assert_eq!(
            read["markdown"], "ROUTER-SENTINEL",
            "the markdown rides back, so the Worker's arm can put it in content"
        );

        // The row is in the DESKTOP's table — the router answered from real storage,
        // it did not echo its argument.
        let direct = db
            .get_artifact(&task_id, "spec")
            .expect("direct read")
            .expect("the row exists");
        assert_eq!(direct.markdown, "ROUTER-SENTINEL");
    }

    #[tokio::test]
    async fn run_task_call_answers_a_missing_row_with_null_not_an_error() {
        let (_dir, db, _task_id) = seeded_board_db("router-task-call-null-");

        // `get_task` on an absent id: the crate's contract is `Ok(None)`, which
        // serializes to `null` — and F1's arm decodes `null` as "no task found"
        // rather than as a failure, so an `Err` here would be a behaviour change
        // visible to the model.
        let missing = run_task_call(
            &db,
            TaskCall::GetTask {
                task_id: "tsk_absent".to_string(),
            },
        )
        .await
        .expect("absence is an answer, not an error");
        assert!(missing.is_null(), "an absent card is `null`, got {missing}");

        let no_artifact = run_task_call(
            &db,
            TaskCall::GetArtifact {
                task_id: "tsk_absent".to_string(),
                key: "spec".to_string(),
            },
        )
        .await
        .expect("an absent artifact is an answer too");
        assert!(no_artifact.is_null(), "got {no_artifact}");
    }

    #[tokio::test]
    async fn run_task_call_reports_a_refusal_as_the_crate_error() {
        let (_dir, db, task_id) = seeded_board_db("router-task-call-refusal-");

        // A dangling task id on a WRITE is `NotFound` (the storage gate exists
        // because `task_artifacts` has no FK to catch it).
        let err = run_task_call(
            &db,
            TaskCall::WriteArtifact {
                task_id: "tsk_dangling".to_string(),
                key: "spec".to_string(),
                markdown: "orphan".to_string(),
            },
        )
        .await
        .expect_err("a dangling id refuses");
        assert!(
            matches!(&err, TaskStoreError::NotFound { message } if message.contains("tsk_dangling")),
            "the refusal is `NotFound` naming the id — got {err:?}"
        );

        // A bad stage slug is `Invalid` and keeps the valid slugs in its sentence.
        let bad = run_task_call(
            &db,
            TaskCall::MoveTask {
                space_path: "/router/task-call".to_string(),
                task_id,
                to_stage: "not-a-column".to_string(),
            },
        )
        .await
        .expect_err("an unknown slug refuses");
        assert!(
            matches!(&bad, TaskStoreError::Invalid { message } if message.contains("backlog")),
            "a bad slug names the valid columns — got {bad:?}"
        );
    }

    /// (the two artifact rules, ON THE ROUTER ARM) a `TaskCall::WriteArtifact`
    /// carrying a key outside the grammar, or a markdown over the cap, is refused
    /// as `TaskStoreError::Invalid` and writes nothing.
    ///
    /// This is the same rule `tests/fulcrum_seams.rs` pins one layer down, and it
    /// earns its place by driving the ARBITRARY the Worker actually sends: the
    /// `TaskCall::WriteArtifact` literal, through `run_task_call`, which is the body
    /// of the `WorkerInboundEvent::TaskRequest` arm. The seam test proves storage
    /// refuses; this proves the refusal survives the router's `spawn_board` wrapper
    /// and arrives as the crate's error rather than as an `Ok` meta or a panic — the
    /// three shapes a Worker can misread as success.
    ///
    /// Non-vacuity: delete the storage checks and both `matches!`s redden (an `Ok`
    /// arrives); map `BadArtifactKey`/`ArtifactTooLarge` to `Io` instead of `Invalid`
    /// and the `matches!` reddens while the row count stays green, which is why the
    /// row assertion is here too.
    #[tokio::test]
    async fn run_task_call_refuses_a_bad_artifact_key_and_an_oversized_markdown() {
        let (_dir, db, task_id) = seeded_board_db("router-task-call-artifact-rules-");

        let err = run_task_call(
            &db,
            TaskCall::WriteArtifact {
                task_id: task_id.clone(),
                key: "My Spec".to_string(),
                markdown: "a document the model believed it saved".to_string(),
            },
        )
        .await
        .expect_err("the tool path must not be wider than the human's");
        assert!(
            matches!(&err, TaskStoreError::Invalid { message }
                if message.contains("My Spec")
                && message.contains("[a-z0-9][a-z0-9-]{0,39}")),
            "`Invalid`, naming the key AND the grammar so the model self-corrects \
             without a second call — got {err:?}"
        );

        let err = run_task_call(
            &db,
            TaskCall::WriteArtifact {
                task_id: task_id.clone(),
                key: "spec".to_string(),
                markdown: "x".repeat(256 * 1024 + 1),
            },
        )
        .await
        .expect_err("262145 bytes must be refused, never truncated");
        assert!(
            matches!(&err, TaskStoreError::Invalid { message }
                if message.contains("262144") && message.contains("262145")),
            "`Invalid`, naming the LIMIT and the ACTUAL size — a model that cannot \
             tell how far over it went cannot decide what to cut — got {err:?}"
        );

        assert!(
            db.artifact_keys(&task_id)
                .expect("artifact_keys")
                .is_empty(),
            "and the router's refusals wrote NOTHING — no truncated spec sits on this \
             card pretending to be whole"
        );
    }

    #[tokio::test]
    async fn run_task_call_lists_the_board_with_artifact_keys() {
        let (_dir, db, task_id) = seeded_board_db("router-task-call-board-");
        db.write_artifact(&task_id, "research", "# notes")
            .expect("write_artifact direct");

        let board = run_task_call(
            &db,
            TaskCall::ListBoard {
                space_path: "/router/task-call".to_string(),
            },
        )
        .await
        .expect("list_board over the router path");
        let rows = board.as_array().expect("a board is a JSON array");
        assert_eq!(rows.len(), 1, "one card, got {board}");
        assert_eq!(
            rows[0]["number"],
            serde_json::json!(1),
            "camelCase wire keys"
        );
        assert_eq!(
            rows[0]["artifactKeys"],
            serde_json::json!(["research"]),
            "the board row carries the artifact KEY names — the whole point of \
             splitting `BoardRow` from `Artifact`"
        );
        // Keys only, never the document.
        let text = board.to_string();
        assert!(
            !text.contains("# notes"),
            "a board payload must never carry markdown — got {text}"
        );
    }

    #[tokio::test]
    async fn run_task_call_creates_edits_and_moves_and_shapes_each_answer() {
        let (_dir, db, task_id) = seeded_board_db("router-task-call-verbs-");

        let created = run_task_call(
            &db,
            TaskCall::CreateTask {
                space_path: "/router/task-call".to_string(),
                title: "second card".to_string(),
                body: None,
                stage_slug: Some("doing".to_string()),
            },
        )
        .await
        .expect("createTask");
        assert_eq!(
            created["number"],
            serde_json::json!(2),
            "numbered per Space"
        );
        assert_eq!(created["stageSlug"], "doing");
        // The write answer is the crate's `TaskRow`, which has NO artifact field.
        assert!(
            created.get("artifactKeys").is_none(),
            "a write says nothing about artifacts — got {created}"
        );

        let edited = run_task_call(
            &db,
            TaskCall::EditTask {
                task_id: task_id.clone(),
                title: Some("renamed".to_string()),
                body: None,
                spec_path: None,
            },
        )
        .await
        .expect("editTask");
        assert_eq!(edited["title"], "renamed");

        let moved = run_task_call(
            &db,
            TaskCall::MoveTask {
                space_path: "/router/task-call".to_string(),
                task_id,
                to_stage: "done".to_string(),
            },
        )
        .await
        .expect("moveTask");
        assert_eq!(moved["toStage"], "done");
        assert_eq!(
            moved["onEnter"], "none",
            "`on_enter` crosses as opaque data for the command layer"
        );
        assert!(
            moved.get("note").is_some(),
            "`note` is `None` and serializes as null, not dropped — got {moved}"
        );
        assert!(moved["note"].is_null());
    }

    // ── The answer that never arrives (ADR 0117) ─────────────────────────────
    //
    // A `TaskRequest` the arm cannot answer used to be SILENT three times over:
    // no `WorkerManager`, no `handle_for` hit, or a `send_inbound_frame` `Err` —
    // and the Worker sat parked on a `oneshot` with no timeout, which is how
    // `get_artifact` hung for 255m55s. These cases own the two things that make
    // that failure class bounded and visible: the deadline on the board call, and
    // the always-on `diagnostics::record` on every non-answering path.

    /// Restores the global diagnostics target to UNARMED on scope exit — INCLUDING
    /// on a panicking assertion, which the plain "call `init(None)` last" shape
    /// does not (`naming.rs`'s `DisableDiagnosticsOnExit`, same reason).
    struct DisableDiagnosticsOnExit;
    impl Drop for DisableDiagnosticsOnExit {
        fn drop(&mut self) {
            crate::agent::diagnostics::init(None);
        }
    }

    /// Read `diagnostics.log` until the line this channel is expected to have
    /// written lands. Bounded and self-proving: a line that never arrives returns
    /// `""` and reddens the caller's assertion, so this is a scheduling guard, not a
    /// sleep that manufactures a pass.
    ///
    /// It polls for the EXPECTED line and not merely for a non-empty file, and that
    /// is load-bearing rather than tidy: `diagnostics`'s target is ONE
    /// process-global directory, so a sibling test's orphaned task (a `naming.rs`
    /// pass whose spawned task outlives its own `env_lock` scope) can land its lines
    /// in this dir BEFORE ours does. A "first non-empty read" helper then returns a
    /// file that has nothing to do with this test, and the assertions redden for a
    /// reason that is not a defect.
    async fn diagnostics_log(log_dir: &std::path::Path, expected: &str) -> String {
        let path = log_dir.join(crate::agent::diagnostics::FILE_NAME);
        for _ in 0..500 {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if text.contains(expected) {
                    return text;
                }
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        std::fs::read_to_string(&path).unwrap_or_default()
    }

    /// Only the lines THIS arm writes, so a sibling's line in the shared file can
    /// neither satisfy a positive assertion nor trip a negative one.
    fn task_response_lines(content: &str) -> Vec<&str> {
        content
            .lines()
            .filter(|line| line.contains("task-response:"))
            .collect()
    }

    /// The deadline, PROVEN: a board future that never completes is answered at
    /// `TASK_BOARD_CALL_TIMEOUT` with the `Io` sentence the Worker shows the model.
    ///
    /// `start_paused` (precedented at `provider_auth/refresh.rs:948`, `:1083`) is
    /// what makes this cheap — tokio auto-advances its own clock once nothing but a
    /// timer is left, so the 30 s elapse in microseconds. The turbofish on
    /// `pending()` is required: a bare `pending()` cannot infer its type.
    ///
    /// Non-vacuity: delete the `timeout` from `with_board_deadline` and this test
    /// hangs FOREVER (a `#[tokio::test]` carries no timeout of its own, and with no
    /// timer left to advance to the paused clock never moves) — which is the
    /// mutation proof, run as `timeout 60 cargo test --lib -- a_board_call_still_running`.
    #[tokio::test(start_paused = true)]
    async fn a_board_call_still_running_at_the_deadline_answers_an_io_error_naming_the_verb() {
        let err = with_board_deadline(
            "get_artifact",
            std::future::pending::<Result<serde_json::Value, TaskStoreError>>(),
        )
        .await
        .expect_err("a board call still running at the deadline is an error, never silence");
        assert!(
            matches!(&err, TaskStoreError::Io { message }
                if message.contains("get_artifact") && message.contains("timed out")),
            "`Io`, naming the VERB and the expiry — the model reads this sentence \
             verbatim and must be able to tell which call died — got {err:?}"
        );
        assert!(
            matches!(&err, TaskStoreError::Io { message }
                if message.contains(&format!("{TASK_BOARD_CALL_TIMEOUT:?}"))),
            "the sentence names the DURATION too, so a supporter can tell a wedged \
             `Db` from a misrouted frame without a stopwatch — got {err:?}"
        );
    }

    /// The other half of the pair, and the pin that keeps the two sentences
    /// DISTINGUISHABLE: a `JoinError` (the blocking task panicked, or the runtime
    /// went away mid-call) still says `failed`, and says it even with the deadline
    /// in place.
    ///
    /// It drives `spawn_board` and not the helper on purpose — the `JoinError`
    /// mapping lives in the closure `spawn_board` passes, so driving
    /// `with_board_deadline` here would only assert a string this file hand-wrote.
    /// The explicit return type on the closure is required (a bare `|| panic!()`
    /// cannot infer it). NOT `start_paused`: the blocking pool runs on a real
    /// thread, and an auto-advancing clock would race the deadline against a panic
    /// that lands in microseconds.
    #[tokio::test]
    async fn a_board_call_whose_blocking_task_died_still_says_failed_and_not_timed_out() {
        let err = spawn_board(
            "get_artifact",
            || -> Result<u32, crate::storage::BoardError> { panic!("boom") },
        )
        .await
        .expect_err("a dead blocking task is an error, not a hang");
        let message = match &err {
            TaskStoreError::Io { message } => message.clone(),
            other => panic!("expected `Io`, got {other:?}"),
        };
        assert!(
            message.contains("get_artifact") && message.contains("failed"),
            "the existing `JoinError` sentence survives the deadline wrapper — got \
             {message:?}"
        );
        assert!(
            !message.contains("timed out"),
            "`failed` means the blocking task DIED, `timed out` means it was still \
             running at the deadline; merging them loses the one fact that tells a \
             supporter which half to look at — got {message:?}"
        );
    }

    /// The `#[allow(clippy::await_holding_lock)]` is INTENTIONAL (`naming.rs`'s
    /// precedent): the guard holds the process-global diagnostics target for the
    /// whole test, so a sibling's `diagnostics::init` cannot repoint it between
    /// the `route_event` and the read.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn an_unanswerable_task_request_records_a_diagnostic_naming_the_request_id() {
        // The lock is declared FIRST so it outlives both, and `_disable` BEFORE
        // the dir so it drops AFTER it (locals drop in reverse) — the global target
        // is cleared before the dir it names is removed.
        let _lock = crate::test_support::env_lock();
        let log_dir = crate::test_support::ScratchDir::in_env_temp("router-log-", "log");
        let _disable = DisableDiagnosticsOnExit;
        crate::agent::diagnostics::init(Some(log_dir.to_path_buf()));

        // `manager_seeded` never wires `worker_manager` (the `OnceLock` stays
        // unset), which is exactly the arm's first non-answering path — and one of
        // the five the ADR enumerates that produce the identical invisible hang.
        let (_dir, manager, _db, _emitted) =
            manager_seeded("router-task-request-unanswerable-", &[]);
        manager.route_event(
            "sess-orphan",
            false,
            WorkerInboundEvent::TaskRequest {
                request_id: "task-req-42".to_string(),
                // A MAIN frame with no origin (a stale/foreign Worker binary): it
                // routes to its delivery id — an identity, not a fallback — and so
                // reaches the `wm`-missing path this test pins.
                session_id: None,
                call: TaskCall::GetTask {
                    task_id: "tsk_absent".to_string(),
                },
            },
        );

        let content = diagnostics_log(log_dir.path(), "task-req-42").await;
        let lines = task_response_lines(&content);
        assert!(
            lines.iter().any(|line| line.contains("task-req-42")),
            "a dropped board answer is recorded in the always-on log, and the \
             `request_id` is what ties it back to the parked tool call — got \
             {content:?}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("no WorkerManager for request task-req-42")),
            "the line names WHICH non-answering path fired (here: the unset \
             `worker_manager` `OnceLock`) — got {content:?}"
        );
        // The CONTENT rule (`diagnostics`'s module doc: ids and our own error
        // sentences only, never user content). The `task_id` here is an argument
        // the MODEL sent, so it must not ride along.
        assert!(
            !lines.iter().any(|line| line.contains("tsk_absent")),
            "no task id, no key, no prompt text at a `record` call site — got \
             {lines:?}"
        );
    }

    // ── The reply address (ADR 0117) ─────────────────────────────────────────
    //
    // ADR 0117's rule in one line: **a frame's delivery address is a UI-scope key
    // and is NEVER a reply address.** The pump re-keys a child's frames to the
    // PARENT's session id (`pump.rs:91-102`) so the child's UI renders in the
    // parent's scope; the arm that used that delivery id as the reply address
    // answered the PARENT's process, the parent's pending map had no such
    // `request_id` and ignored the frame exactly as its contract requires, and the
    // child stayed parked on a `oneshot` with no bound — the 255m55s
    // `get_artifact` hang.
    //
    // What these cases own is the DECISION, all three of its branches. They are
    // deliberately NOT a "the answer reaches the child" proof: a child's
    // `WorkerHandle` lives only in the crate's private `drives` map (sole writer
    // `dispatch_subagent`, `pub(crate)`, no desktop-reachable setter) and
    // `WorkerHandle` exposes no accessor for frames written INTO a Worker
    // (`send_inbound_frame` pushes to a private `stdin_tx`; `round_trip_count`
    // counts fetches, not writes), so that positive proof is only writable where a
    // real `drives` entry exists — Task 5's end-to-end.

    /// The misroute, pinned at the level the bug lived at: the answer goes to the
    /// ORIGIN (`child-1`), and the value the arm used to use (`parent-1`, the
    /// pump's delivery id) is not what comes back.
    #[test]
    fn a_subagents_task_request_is_answered_at_its_origin_and_not_its_delivery_id() {
        assert_eq!(
            task_reply_target("parent-1", true, Some("child-1")),
            Some("child-1".to_string()),
            "a Subagent's board answer must be addressed to the Worker that ASKED \
             for it; `parent-1` is the pump's UI-scope key and answering it is the \
             hang ADR 0117 records"
        );
    }

    /// THE ADR 0117 PIN. A child frame whose origin is absent is UNROUTABLE and
    /// must NOT fall back to the delivery id — a fallback here is precisely the
    /// misroute, wearing the costume of a defensive default. This test reddens the
    /// instant anyone writes one.
    #[test]
    fn a_subagent_frame_with_no_origin_is_never_routed_to_the_delivery_id() {
        assert!(
            task_reply_target("parent-1", true, None).is_none(),
            "`None` means UNROUTABLE, not \"use the delivery id\": for a Subagent \
             the delivery id is the PARENT's, so falling back re-creates the \
             255m55s hang this whole change exists to kill"
        );
    }

    /// The third branch, and the reason the arm is not simply `origin.unwrap()`:
    /// a MAIN session's delivery id IS its own id, so routing a main frame with no
    /// origin field to the delivery id is an IDENTITY, not a fallback. (In
    /// production `None` only happens for a foreign or stale Worker binary — the
    /// Worker is this same binary re-entered with `--worker`, so the two cannot
    /// version-skew. The branch is kept because it is what makes the no-fallback
    /// rule above testable.)
    #[test]
    fn a_main_frame_with_no_origin_routes_to_its_delivery_id_because_they_are_the_same_id() {
        assert_eq!(
            task_reply_target("main-1", false, None),
            Some("main-1".to_string()),
            "for a main frame delivery id == origin id, so this is an identity"
        );
    }

    /// The unroutable child is VISIBLE, and the line names the `request_id` so a
    /// supporter can tie it to the parked tool call. Distinct from
    /// `an_unanswerable_task_request_records_a_diagnostic_naming_the_request_id`,
    /// which pins the `worker_manager`-missing path: the `reply_target` decision
    /// and its `return` happen BEFORE `tokio::spawn`, so this case writes its line
    /// and never reaches the `wm` / `handle_for` paths at all — nothing is spawned
    /// and nothing is left parked on the Supervisor side.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn an_unroutable_task_request_records_a_diagnostic_naming_the_request_id() {
        // Declaration order is load-bearing (same reasoning as the `an_unanswerable_…`
        // test): `_lock` FIRST so it outlives both, `_disable` BEFORE the dir so it
        // drops AFTER it and the global target is cleared before the dir it names
        // is removed.
        let _lock = crate::test_support::env_lock();
        let log_dir = crate::test_support::ScratchDir::in_env_temp("router-log-", "log");
        let _disable = DisableDiagnosticsOnExit;
        crate::agent::diagnostics::init(Some(log_dir.to_path_buf()));

        // `is_subagent: true` + `session_id: None` — a child frame with no origin.
        let (_dir, manager, _db, _emitted) = manager_seeded("router-task-request-unroutable-", &[]);
        manager.route_event(
            "parent-of-orphan",
            true,
            WorkerInboundEvent::TaskRequest {
                request_id: "task-req-77".to_string(),
                session_id: None,
                call: TaskCall::GetTask {
                    task_id: "tsk_absent".to_string(),
                },
            },
        );

        let content = diagnostics_log(log_dir.path(), "task-req-77").await;
        // Scoped to THIS arm's lines: `diagnostics`'s target is one process-global
        // dir and a sibling test's orphaned spawn can write its own lines into the
        // armed dir after `env_lock` is released.
        let lines: Vec<&str> = content
            .lines()
            .filter(|line| line.contains("task-request:"))
            .collect();
        assert!(
            lines.iter().any(|line| line.contains("task-req-77")),
            "an UNROUTABLE board answer is recorded in the always-on log, and the \
             `request_id` is what ties it back to the parked tool call — got \
             {content:?}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("no origin id") && line.contains("was dropped")),
            "the line names WHICH path fired (no origin id ⇒ the answer was \
             dropped), not just that something went wrong — got {lines:?}"
        );
        assert!(
            !lines.iter().any(|line| line.contains("tsk_absent")),
            "no task id, no key, no prompt text at a `record` call site — got \
             {lines:?}"
        );
    }
}
