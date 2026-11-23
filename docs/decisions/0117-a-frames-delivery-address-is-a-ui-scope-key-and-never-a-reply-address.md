---
status: accepted
date: 2026-11-23
superseded-by:
---

# A frame's delivery address is a UI-scope key and is NEVER a reply address; a request/answer pair names its originator

A model-facing board verb called from a **Subagent session** hung forever (`get_artifact`, 255m55s —
`docs/research/board-tool-hang-subagent-task-response-misroute.md`). The cause was one identity used for
two jobs. The engine's pump re-keys a child's frames to the **parent's** session id before handing them to
the desktop (`fulcrum-harness` `worker/manager/pump.rs:91-102`) — correct, because a child's UI belongs to
the parent's scope — and the desktop's `TaskRequest` arm used that same id as the **address to reply to**
(`src-tauri/src/agent/session/router.rs:322`, `:331`). `handle_for(parent_id)` therefore HITS and returns
the **parent's** `WorkerHandle`; the parent's per-Worker pending map has no such `request_id` and ignores
the frame exactly as its contract requires (`worker/core.rs:958-972`, *"An absent entry is IGNORED, never an
error and never a panic"*). The child stays parked on a `oneshot` with no timeout
(`worker/task_store.rs:100-128`), and the subagent Dead bound is disarmed while a `tool_call_id` is
outstanding (`worker/manager/subagent_flow.rs:1242`), so nothing reaps it.

**We decided: a frame's delivery address identifies the SCOPE IT RENDERS IN, and is never the address of
the process that must be answered.** Anything that must be replied to names its own originator inside the
frame, and the reply is addressed by that field alone. The desktop already obeys this twice: the
`FetchRenderRequest` arm re-extracts `payload["sessionId"]` (`router.rs:258-262`) because the emitting loop
stamps its own id (`worker/core.rs:192-197`), and the `cost_update` arm does the same because *"the ROW
belongs to the CHILD"* (`router.rs:75-92`). `Outbound::TaskRequest { request_id, call }`
(`worker/protocol.rs:341`) is the sole reply-bearing frame that carries no originator — deliberately,
because its pending map is per-Worker (`worker/task_store.rs:47-54`) — so the arm CANNOT recover the child
id, and the one signal that survives the boundary (`is_subagent`, in scope at `router.rs:303`) is ignored by
the arm. The fix is therefore one field on the wire (`sessionId` on `Outbound::TaskRequest`, mirroring the
render frame) plus a desktop arm that reads it.

**Considered options.** (1) *A Supervisor-side timeout only* — rejected as the fix, though it is worth
landing alongside: it converts a four-hour hang into a thirty-second confident error and leaves the
misroute live, so it masks rather than cures. (2) *A desktop-only parent→child routing table* — impossible:
`WorkerHooks::register_child_cwd` receives the child id but not the parent (`worker/manager/mod.rs:98`) and
`sink_for` receives the parent but not the child (`:97`), so no existing hook can build the mapping. This is
what forced the scope from "desktop only" to the engine. (3) *A per-Worker pending map keyed harder* — no:
the map is correct, the **key handed to it** is wrong.

**Consequences.** The `let _ =` on `send_inbound_frame` and the bare `if let` on `handle_for`
(`router.rs:330-339`) stay silent today, and five other failure modes produce the identical invisible hang
(a panic in the spawned answering task, an unset `worker_manager` `OnceLock`, a `tokio::spawn` on a
shutting-down runtime, a `Lagged` frame-ring drop, a stdin writer `break`) — so the arm gains always-on
`diagnostics::record` on every path that fails to answer, following `pump.rs:62-77`'s reasoning that *"a
line behind `ARCHIMEDES_DEBUG` cannot answer 'why did nothing happen' for a user who never set the var."*
A reply-bearing frame must also **never** fall back to the delivery id when its originator field is absent:
`router.rs:78-86` already warns of exactly that fallback — *"Do not read it as a safe default."* And the
seam's only end-to-end test attaches a MAIN session (`src-tauri/tests/worker_e2e.rs:2529`), where delivery
address and originator coincide — which is why this shipped green; no test in either repository routes a
`TaskRequest` with `is_subagent: true`, and one must.
