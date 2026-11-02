---
status: live
last-verified: 2026-11-02
verified-by: read against this tree on PR #151 (its pre-squash commits are orphaned by the squash merge — cite the PR, not a hash). `grep '\.eval(' src/agent/` gives 7 hits, all inside `codemode/engine.rs`'s own `mod tests`. No `NestedStatus`/`NestedRow` consumer outside `harness/loop/codemode.rs`. The duplicated doc paragraph is gone. The `TimedOut` and `WALL_CLOCK` grep of `loop/tests/codemode.rs` is still 0. Every item re-confirmed against the code, not copied from the roadmap family. Kept to one line and free of interior colons so this front-matter parses as strict YAML, which several other files in this directory do not.
---

# Codemode — known gaps

Accepted, unfixed defects and open work in the `codemode` tool. They live here because the
roadmap family that recorded them (`docs/roadmap/codemode-*.md`) is deleted on ship and
nothing in `docs/roadmap/` is recoverable afterwards — no `git checkout`, no stash, no
dangling blob. This is the surviving home. Read it before concluding that a limit, a
coverage gap or a duplication is handled.

The wire contract is NOT here — it is `docs/features/codemode-transcript-contract.md`. The
engine decision and the threat model are in ADR 0089. This file holds only what is still
open.

## 1. `CodemodeEngine::eval` is production-dead, so the cancellation invariant exists twice

**The most load-bearing item here.** `CodemodeEngine::eval` has seven call sites and every
one is inside `codemode/engine.rs`'s own `mod tests`. Production never calls it. The bridge
drives the script itself — `engine.context().async_with` + `ctx.eval_promise` inside
`race_turn` — because servicing a host `await` while the script runs is something `eval`'s
synchronous `with` cannot do (ADR 0089 records why: the sync `with` blocks its task, so
nothing polls a `select!` while JS spins).

Three things follow, and all three are the same duplication:

- The bridge **overwrites** the engine's interrupt handler. `CodemodeEngine::new` installs
  one (`codemode/engine.rs`), and `exec_codemode` immediately replaces it through the `pub`
  `runtime()` accessor with one watching the bridge's own clock. The engine's handler is
  installed and discarded on every run, so it can never observe a running script.
- The engine's `WallClock` is private, so the bridge re-implements `WallClock`,
  `arm_deadline` and `clock_expired`.
- `CodemodeEngine::exception_verdict` is private, so the bridge has a hand-copied free
  function spelling the same rule (token first, then deadline, then a genuine throw).

The two copies are behaviourally equivalent today — same `base.elapsed().as_nanos() +
duration`, same `NO_DEADLINE` sentinel, same `Release`/`Acquire` orderings. So this is not a
wrong behaviour. It is **one copy that no production path reaches, carrying the more
expensive test**: `eval_cancels_on_turn_token` builds the parked-await recipe that only the
bridge's own path actually runs in production, and `eval_timeouts_on_wall_clock` proves the
wall clock on the dead path. See §3.

**Recommended fix (reviewer-endorsed, not yet done): fold the host-await-capable path into
`CodemodeEngine`.** An `eval_async(code, host)` that takes the channel-driven host callbacks,
runs `eval_promise` under `async_with`, and owns BOTH the handler and the wall clock,
returning an owned script outcome. That makes the engine the single owner of both halves of
cancellation, re-activates the parked-await test as a production path, and deletes the
bridge's `WallClock` / `arm_deadline` / `clock_expired` / `exception_verdict`. The alternative
— keeping the bridge as the script driver and shrinking the engine to a reusable
clock + verdict pair — removes the copies but leaves the invariant split across two files, so
prefer the fold. It was not done during the run because it spans the engine's and the
bridge's owned file sets.

## 2. The gate corridor is duplicated, and three refusals are re-typed literals

`Bridge::run_nested` is a second, hand-ordered copy of `run_tool_batch`'s decision path.
The duplication is forced: `dispatch_tool` takes `&mut self` for the whole turn, so a script
running inside it cannot call it back — the nested built-in goes to `execute_tool` on a
cloned `ToolCtx` instead.

The gate **decisions** are genuinely reused (`policy_verdict` → `guard_target` →
`gate_tool` → `deny_tool_result`, same order). What is re-typed is the scaffolding around
them:

- `"permission denied"` appears in `codemode.rs` and in `turn.rs` as two separate literals.
- ~~`cancelled_result()` duplicated `cancelled_tool_result()`.~~ **Fixed** — the bridge now
  calls the shared `tools::cancelled_tool_result()`.
- The `"tool not enabled: {}"` wording is a third copy of `dispatch_tool`'s.

Only the `Deny` path has a byte-identity pin
(`nested_gate_denial_returns_the_identical_denial_wording`). The Ask-rejection and the
disabled-tool paths do not, so if the direct route's wording is ever parameterized the
bridge silently stops being byte-identical there and nothing reddens. The feature's whole
safety claim is that the model cannot tell a nested call from a direct one, so the wording
*is* the property. Either share the constructors (a `denied_result()` beside
`deny_tool_result`) or pin each refusal the way `Deny` is pinned.

## 3. The wall-clock timeout has no live-path coverage

`eval_timeouts_on_wall_clock` runs the dead `eval` (§1). The live timeout depends on the
bridge arming its own deadline that its own interrupt handler watches, and that
arming/handler pair is exercised by **no test that produces a timeout through
`exec_codemode`** — `grep 'TimedOut\|timed out\|WALL_CLOCK' loop/tests/codemode.rs` finds
nothing. `the_wall_clock_distinguishes_an_armed_deadline_from_no_deadline` tests the clock as
a pure function.

So a refactor that dropped `arm_deadline`, or that left the engine's handler installed
instead of replacing it, would make `while (true) {}` unstoppable by wall clock — only a Stop
would end it — and the whole suite would stay green. This is not hypothetical: ADR 0089
records that exactly this bug (a token-only handler, hung past 60 s) was shipped once during
the run and caught by hand.

The mechanism is currently sound — QuickJS polls the interrupt handler inside `OP_goto` /
`OP_if_true` / `OP_if_false` every 10 000 bytecodes, which is where a hot loop spends its
life, and the interrupt is an uncatchable internal throw, so no JS `catch` can swallow it.
That is why the handler is load-bearing and `race_turn`'s `sleep` arm alone cannot stop a
synchronous loop.

**Wanted:** a test that runs `while (true) {}` through `dispatch_tool` and asserts
`"codemode: timed out"`. `WALL_CLOCK` is a `const`, so this needs a `#[cfg(test)]` override
or an injected clock — do not "fix" it by waiting 300 s.

## 4. The memory cap depends on the feature set; two pins, and one does not pin what it looks like

`set_memory_limit` is documented as a no-op when rquickjs is built with `rust-alloc` or
`allocator`, and features are transitive — no crate in this graph asks for them today, and
`archimedes` is the only crate in `Cargo.lock` that depends on `rquickjs` at all, but a future
dependency can turn this on silently while every behavioural test keeps passing.

Three layers hold it, and they hold different halves:

- The dependency-line comment in `Cargo.toml` — for a human reader.
- `memory_cap_is_installed_not_merely_requested` (`codemode/engine.rs`) reads `malloc_limit`
  back out of the C runtime via `memory_usage` → `JS_ComputeMemoryUsage`, with a control
  asserting an untouched runtime reports `0` so the equality discriminates. It detects a cap
  never *installed*.
- `scripts/check-rquickjs-allocator.sh` (CI's `scripts` job) reads the FULL
  `cargo tree -e features`, never the `-p rquickjs` subtree form — **the `-p` form does not
  print the incoming feature edge and would print green forever**. It must also not
  false-positive on `allocator-api2`, which is legitimately in the graph via `hashbrown` and
  is an unrelated crate.

**Measured, and it narrows what the runtime pin buys:** with `--features rquickjs/rust-alloc`
on this dependency set, the limit was still reported AND still enforced — QuickJS's cap check
sits in `js_malloc_rt`, above the allocator dispatch. So the `malloc_limit` read-back would
**not** detect the literal documented no-op. The build-graph guard is the only layer that
would. Do not treat the runtime test as the whole defence.

Separately: the cap counts QuickJS-managed memory, not process RSS. A script's `bash`
children allocate entirely outside it. That is a property of the design, not a gap — see
ADR 0089's threat model.

## 5. The MCP half of the bridge has never been executed

`grep mcp src-tauri/src/agent/harness/loop/tests/codemode.rs` found zero hits at the review.
So these are production code with zero execution: `dispatch_nested`'s MCP arm (including the
`MCP_TIMEOUT` bound and the race against the turn token), the MCP half of `search_tools`
(`server_names` → `list_tools` → the `skipped` aggregation) and of `describe_tool`. The
`&mut`→`&self` manager lowering has its own tests, but they do not go through the bridge, and
one of them proves concurrency across two **different** servers — same-entry concurrency (the
`drop(client_guard)` before the transport await) is untested.

A bug here is a silent wrong answer to a script, not a crash. `fake_mcp_stdio` already grew
the `hold`/`release` shape needed to test this without timing assertions.

**Landed since the review:** the interactive `mcp` `action: "auth"` refusal and its two tests
(`the_interactive_mcp_auth_action_is_refused_from_a_script`,
`the_interactive_mcp_auth_action_is_refused_while_every_other_action_is_not`). Those drive
the bridge's refusal, which happens **before** dispatch, so they do not close this item — no
test has still completed a real nested MCP call.

## 6. `details.calls` is bounded only by the wall clock

Per-row sizes inherit the tools' own caps (`bash` output 100 KiB, read 2000 lines), but the
ARRAY LENGTH has no cap, and two consumers pay for it:

- the final `tool_execution_end` result persists the whole array into the transcript row;
- every live `tool_execution_update` frame re-serializes the whole snapshot, and one frame is
  emitted per nested call **start and per settle** — so a script making N calls emits ~2N
  frames of growing size, and `Db::record_message` re-upserts the row whole each time.

A plausible model bug (a runaway loop) rather than a hostile-actor event, and the 300 s wall
clock bounds it, so it is recorded rather than fixed. If it ever needs a cap, the honest shape
is a row cap with a `calls_truncated` marker plus coalescing live frames per scheduler pass —
not a smaller `WALL_CLOCK`, which would break legitimate long scripts.

## 7. A timed-out script abandons its in-flight nested children

Losing `race_turn`'s wall-clock arm drops the script future and the in-flight nested futures.
A dropped `bash` future takes its child via `kill_on_drop`, so nothing leaks indefinitely —
but a child that was mid-run when the script died is killed rather than reaped, and the turn
does not wait for them. Bounded per child by that tool's own execution limit. Recorded so it
reads as a decision; nobody has tested it.

## 8. Untested branches, listed so they are not re-derived

Read off the tree, not from a plan. Each is a branch that exists and no test reaches:

- `exec_codemode`: engine construction failure, and `install_world` failure.
- `run_script`: the `Step::Request(None)` arm (all senders dropped) and the
  `script_outcome.unwrap_or(ScriptEnd::Cancelled)` fallback.
- `run_nested`: the `is_tool_enabled` refusal and the **nested** `unknown_param_error`
  refusal (the *outer* `codemode` param check is tested; the nested one is not).
- `describe_tool`'s excluded-name branch — the only piece of the exclusion enforced at CALL
  time rather than install time.
- `search_tools`' `skipped` array (a server that will not answer).
- `exception_verdict`'s `TimedOut` arm and its non-`Error` fallback (`"unknown exception"`) —
  both only on the live path (§3).
- `drain_after_script` in its entirety: a script that fires `tools.x()` **without awaiting**
  is the explicit contract ("rows still belong in `details.calls`") and the trickiest drain on
  the branch, and nothing exercises it.
- Gate postures: only a `read` `Deny` is pinned. No test drives a nested `write`/`edit` `Deny`
  or a `Confine` (the sandboxed-shell route), and `promise_all_batches` proves concurrency from
  wall-clock sleeps rather than an event pairing.
- Two concurrent `codemode` calls in one batch: two engines, two sequence counters, one
  `RowBook` each. Untested.

## 9. Frontend coverage gaps

- **No transcript/reducer test carries a codemode payload.** The card's premise — that a live
  frame folds via `rawOutput: update.rawOutput ?? prev.rawOutput` (`transcript/reducer.ts`) —
  is simulated by re-rendering with a new prop, which is what the card sees but not the fold
  itself. The generic `tool_call_update` arm is independently tested, so residual risk is low;
  the value would be pinning the live→final fold end to end.
- **No resume/reload fixture.** A codemode row rehydrated from a persisted display
  `payload_json` (where `title` and `rawOutput` come from the DB, not a live frame) is untested,
  and `MessageBubble` routes on `message.title === "codemode"` — a string discriminator, tested
  only against live-frame props. The `ask` reload test proves the pattern exists.
- **No live→final merge assertion against the DB.** `LoopEventSink` owns a *separate*
  `TurnState` and accumulator set from the loop's; the safety argument (the
  `tool_execution_update` arm mutates no turn state, and `compute_display_rows` inserts-then-
  merges from an empty map) is sound and is spelled out in `loop/emit.rs`, but it is a comment.
  No test asserts that a live frame and the final `tool_execution_end` land on the SAME
  persisted display row — the B1 acceptance test uses `NoopStore` and the bridge tests read sink
  frames, never the DB. `build_loop_with_sink` already returns an `Arc<Db>`, so this is a
  one-test gap. The `ask` path has the analogue
  (`the_persisted_ask_row_and_the_emitted_request_carry_the_same_payload`).
- `rowStatus`' default branch is tested on its streaming side only; the settled-parent →
  `completed` side has no fixture, and neither does a failed parent carrying mixed
  `denied` + `ok` rows.

## 10. Smaller things, deliberately not fixed

- `searchTools` / `describeTool` re-implement the MCP match predicate over `McpManager`'s
  public API instead of reusing `agent/mcp/tool.rs`'s helpers, which are module-private. Fine
  for two callers; expose one shared matcher if a third appears.
- No ranking for discovery — case-insensitive substring matching, no BM25. The spec deferred
  ranking.
- Nested results are the uniform `{ text, isError, details }` triple with no structured
  per-tool shape; `bash` yields ONE combined text block with no stdout/stderr split (accepted
  for v1).
- The nested-call sequence counter is a `u32`; overflow would collide `<parent>/<n>` ids and
  the card's last-writer-wins reconcile would collapse two distinct calls. Practically
  unreachable (every call parks on a host await), so `checked_add` or `u64` is a nicety.
- `emit_live` re-sends the PARENT's `args` — the whole script text — on every frame, for raw
  event-stream self-consistency. Bounded by frame count, worth revisiting with §6.
- `rquickjs::markers::ParallelSend`, **not** `rquickjs::ParallelSend` — core's `pub use` list
  does not re-export it and `markers` is a `pub mod`, so the plain path does not resolve. Saves
  a compile-error chase.
- `parallel` is a REQUIRED feature, not an optimisation: without it
  `assert_send_sync::<CodemodeEngine>()` fails with 4 × `E0277`, and the loop runs inside
  `tokio::spawn`. The compile-time assertion in `codemode/engine.rs` is the permanent guard —
  never "trim an unused feature".
