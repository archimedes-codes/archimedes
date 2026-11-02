---
status: accepted
date: 2026-11-02
superseded-by:
---

# rquickjs is the codemode sandbox engine, embedded in the Worker

**Decision.** The `codemode` tool's JavaScript runs in an embedded **QuickJS**, reached through
`rquickjs = { version = "0.14.0", features = ["futures", "parallel"] }`, in
`src-tauri/src/agent/codemode/engine.rs`. `CodemodeEngine` is one `AsyncRuntime` + one
`AsyncContext`, constructed per codemode call by the bridge with the turn's `CancellationToken`
and an `EngineLimits` budget, and it is `Send + Sync` — so it can live inside
`tokio::spawn(loop_.run())` (`src-tauri/src/agent/worker/core.rs:412,890`) across `.await`
points. Nothing about the engine is wired into the session loop yet; that is the bridge task's
(C2) job.

**Why the engine must be `Send + Sync`, and how `parallel` was decided.** The Worker runs the
session loop on a multi-threaded Tokio runtime, so every future that holds the engine must be
`Send`. rquickjs 0.14.0 gates the `unsafe impl Send`/`Sync` for `AsyncRuntime`
(`rquickjs_core/src/runtime/async.rs:70,78`) and `AsyncContext`
(`rquickjs_core/src/context/async.rs:239,244`) behind the crate's `parallel` feature. This was
settled by a **compile-time assertion**, not by prose: `fn assert_send_sync<T: Send + Sync>()`
instantiated as `engine_is_send_sync` in the engine's test module.

- **Without** `parallel` the test module does **not compile** — four `E0277` errors, all naming
  the engine's own rquickjs fields:
  `` `NonNull<JSContext>` cannot be sent between threads safely``,
  `` `NonNull<JSContext>` cannot be shared between threads safely``,
  `` `NonNull<JSRuntime>` cannot be sent between threads safely`` (each reached through
  `async_lock::mutex::Mutex<InnerRuntime>` → `Arc<Mutex<…>>: Send` → `AsyncRuntime` →
  `CodemodeEngine`), plus `` `*mut Box<dyn Allocator>` cannot be sent between threads safely``.
  All four are `note: required by a bound in assert_send_sync`.
- **With** `["futures", "parallel"]` the same code compiles and the test passes.

So the feature list is `["futures", "parallel"]` (plus the crate's default `std`). `loader` and
`bindgen` stay off — `rquickjs-sys` ships pre-generated bindings for our three targets
(`x86_64-unknown-linux-gnu`, `x86_64-pc-windows-gnu`, `x86_64-pc-windows-msvc`).
`rust-alloc`/`allocator` must **never** be enabled: they turn `set_memory_limit` into a no-op,
which would silently void the 256 MiB cap this ADR's contract depends on.

`parallel` is upstream-experimental — the crate's README warns it "may not works as expected.
Use it for your own risk". The mitigation is architectural: the engine exists only inside the
Worker process, so a hypothetical race degrades to a Worker-local failure (a stalled session,
ADR 0025) and never to an app death. `engine_is_send_sync` stays in the tree as the permanent
guard that the crate's feature story has not moved under us.

**Why not WASM / Wasmtime.** A Wasmtime embed buys a sandbox we do not need at the price of a
second runtime in the process and a WebAssembly boundary on top of what is a small,
host-callback-heavy scripting surface: the codemode script's whole purpose is to call back into
the harness's tools and await their results. Two contract requirements map onto QuickJS
natively and fight the Wasm boundary. (1) The resource contract is `EngineLimits`, and QuickJS
gives it directly — `set_memory_limit` and `set_max_stack_size` are per-runtime and take plain
byte counts. (2) Cancellation must work while the script is *executing*, and QuickJS has an
engine-level interrupt hook (`JS_SetInterruptHandler`, polled every 10 000 bytecodes) that rquickjs
exposes as `set_interrupt_handler`; across a Wasm boundary there is no equivalent "stop the
bytecode now" primitive that does not require restructuring the guest module.

**Why not boa.** Boa is pure Rust, which is attractive, but its embedding story is the weaker
fit for a Worker-hosted async engine: there is no maintained async runtime pairing with
promise/host-future interop equivalent to rquickjs's `futures` + `parallel` (a Rust `Future`
becoming a JS Promise that JS can `await`, and `Promise::into_future` turning a JS promise back
into a pollable Rust future). The memory-cap and interrupt semantics this design relies on are
QuickJS-native, not something Boa offers with the same guarantees.

**The two-part cancellation, and one correction to the plan that produced this.** Cancellation
is (1) the interrupt handler, which fires only while bytecode runs, and (2) `race_turn`, a
`tokio::select!` of the script future against `turn.cancelled()` and a wall-clock `sleep`, so a
script parked on a host `await` — running no bytecode, so silent to part 1 — is still stoppable.

The plan specified the handler as `move || cancel.is_cancelled()` and asserted that a
wall-clock-bounded hot loop would be ended by `race_turn`'s `sleep` arm. **That premise is
false, and it was caught by running the test as written**: a synchronous `Ctx::eval` blocks the
task that runs it, so nothing polls the `select!` while `while (true) {}` spins — with the
token-only handler `eval_timeouts_on_wall_clock` hung past 60 seconds and had to be killed. The
implemented handler therefore watches the deadline as well as the token:

```rust
set_interrupt_handler(Some(Box::new(move || {
    handler_token.is_cancelled() || handler_clock.expired()
})))
```

`WallClock` is one `Arc`-shared `AtomicU64` (absolute nanos, `u64::MAX` = unarmed), armed at the
top of the eval closure and cleared at its end, so `wall_clock` now enforces itself **inside**
bytecode as well as across a host await. This adds no public surface: the frozen signatures are
untouched and the deadline is a private field. Both routes to a timeout report
`ScriptEnd::TimedOut` and both routes to a cancelled hot loop report `ScriptEnd::Cancelled` —
the exception-path rule (check the turn token, then the deadline, *before* falling back to
`Failed`) is what makes those deterministic rather than a `select!` arm-order coin-flip, since
the interrupt raises an **uncatchable** exception and `Ctx::eval` surfaces it as
`Error::Exception`.

**Threat model: QuickJS is not a security boundary against a determined script.** The
sandbox is a JS VM plus three resource limits — 256 MiB of QuickJS-managed memory, a 256 KiB JS
stack, a 300 s wall clock — and it provides **no capability containment**. Everything a script
can reach is a host tool: `tools.<name>(args)` is the only door into the host
(`__codemodeCall`, `loop/codemode.rs`), and a call that comes through it is contained by the
nested-call **policy gate** — the same `policy_verdict` → `gate_tool` / `deny_tool_result`
corridor a direct model-initiated call runs, in the same decision order (`Bridge::run_nested`).
So a script is granted **exactly the model's own reach, no wider and no narrower**, and the gate
carries the scope and the limits ADR 0030 already assigns it: `bash` is always beyond the
boundary, `mcp` and the web tools are ungated, and the write floor is by ADR 0030's own words "a
guard-rail, not a security boundary". Nothing about embedding QuickJS widens or narrows that.
The word "sandbox" in the tool's advertised description therefore means *a VM with limits*; the
clause in that description which carries a guarantee is *"Every nested call passes the same
policy gate as a direct call"*, and that clause is the one the implementation holds.

**What is therefore true by design.** A script may drive any granted tool as often as it likes,
in a loop, with **no model turn between calls** — `run_nested` synthesizes a `ToolCall` per
`tools.<name>`, and the bridge keeps no call counter, no rate limit and no per-script budget.
Each nested call is bounded by the *tool's own* execution limit and not by anything the sandbox
adds: a nested `bash` may carry a `timeout_ms` up to `MAX_BASH_TIMEOUT` (15 minutes, three times
the script's own clock) and the bridge clamps it no further than the direct route does. What the
script's clock does bound is the *run*: losing the `race_turn` drops the nested futures, and a
dropped `bash` future takes its child via `kill_on_drop` (a cancelled-but-still-polled run reaches
the executor's post-loop group-kill). So the exposure is not one long call — it is an unbounded
*number* of calls inside the window, each with its own child process and up to `MAX_OUTPUT_BYTES`
(100 KiB) of text, and `details.calls` grows by one element per call with no cap while every live
frame re-serializes the whole snapshot. A script that loops until the clock expires therefore
fills its own parent tool result with rows, and the turn token ends it. That ceiling is real; it
is simply a ceiling on the run, not a judgement about how much work is too much.

**The exclusion list is NAME-based.** `ask`, `sudo_exec`, `manage_todo_list`, `subagent`,
`list_agents` and `codemode` are never installed as script globals (`EXCLUDED_FROM_SCRIPT`), and
that is the mechanism: `callable_specs` filters them out of `ALL_TOOLS`, `tools.<name>` is built
FROM `ALL_TOOLS`, so a hard-coded spelling is a JS `TypeError` rather than a dispatch;
`describeTool` refuses them again at call time so an excluded name is not discoverable either;
and a nested built-in dispatches through `execute_tool`, whose `match` has no arm for any of the
six and ends in `unknown tool`. The consequence of the scope being a NAME is that an interactive
behaviour reachable through a **non-excluded tool's ARGUMENTS** is not covered by it. The live
instance is `mcp`, which a script may call and which carries `action: "auth"` — the interactive
OAuth flow, which opens the user's browser and then waits up to 300 s on a local callback. As of
this commit that path is **not** rejected from a script: no action-level rejection exists in
`agent/mcp/tool.rs` (checked at this SHA). The accepted residual risk is therefore precisely
*argument-level interactivity*, bounded by the fact that the flow is raced against the turn token
and its own wait is bounded, so it costs at most the script's remaining clock — but it does open a
window on the user's desktop for an authorization nobody asked for. If an action-level rejection
for interactive MCP actions lands, record it here as the mitigation for this paragraph; until it
does, this paragraph is the honest state.

**What the sandbox is for.** Two things, neither of them containment: turning many sequential
model turns into one script, and keeping large intermediate outputs inside the sandbox so that
only the script's completion value reaches the model. The second is a real, checkable property —
the parent's `ToolResult` text is the completion value, the nested rows ride in `details`, and
`run_tool_batch` puts `result.content` (never `details`) into the provider message, so a script
that fans out fifty `bash` runs costs the model one block while the UI still sees all fifty rows.
The resource limits exist so that a *bug* cannot wedge the Worker, not to contain an adversary;
and the Worker is the blast-radius ceiling, as elsewhere in this design — a stalled engine
degrades to a Worker-local stalled session (ADR 0025), never to an app death.

**One honest limit on the memory cap.** The 256 MiB figure is a property of rquickjs's FEATURE
SET, not of our code: `set_memory_limit`'s own doc comment (`rquickjs-core-0.14.0`,
`runtime/async.rs`) says it "is a Noop when a custom allocator is being used, as is the case for
the `rust-alloc` or `allocator` features", and those features are **transitive** — nothing in
`src-tauri/Cargo.toml` asks for them, and any dependency that does, anywhere in the graph, makes
the cap decorative while every test that measures the cap's *behaviour* keeps passing. Three
things hold it today, and they hold different halves. The dependency-line comment in
`src-tauri/Cargo.toml` states the rule for a human reader. The engine now carries a runtime pin,
`memory_cap_is_installed_not_merely_requested` (`agent/codemode/engine.rs`), which reads the limit
back out of the C runtime through `memory_usage` → `JS_ComputeMemoryUsage` and asserts it equals
what `CodemodeEngine::new` asked for, with a control asserting an untouched runtime reports `0`
so the equality is discriminating and not tautological — that detects a cap never *installed*, and
it does not detect a limit recorded but not enforced. The enforcement half is a build-graph check,
`scripts/check-rquickjs-allocator.sh` (CI's `scripts` job, with its own `--self-test` fixtures),
because feature unification happens at compile time and only the resolver knows what got unified;
it reads the FULL `cargo tree -e features`, never the `-p rquickjs` subtree form, which does not
print the incoming feature edge and would therefore print green forever. One fact narrows the
exposure without closing it: `archimedes` is the only crate in the graph that depends on
`rquickjs` (checked against `Cargo.lock`), so today no third party can turn this on — a future one
can. And in any configuration the cap counts QuickJS-managed memory rather than process RSS: a
script's `bash` children allocate outside it entirely, which is the same point the threat model
keeps returning to — these limits bound the VM, not the blast radius.

**Consequences.**

- `rquickjs` + `rquickjs-core` + `rquickjs-sys` join the graph (`rquickjs-macro` does **not** —
  `macro` is not in our feature list, contrary to the plan's expectation of four packages).
  `rquickjs-sys` vendors ~82 k lines of QuickJS C built by the `cc` crate, so all three desktop
  targets need a C toolchain; `cc` was already in the lock. The lockfile gained only
  insertions — `rquickjs`, `rquickjs-core`, `rquickjs-sys`, plus `relative-path` (a
  `rquickjs-core` dep) and `allocator-api2` (reached via the already-present `hashbrown`), no
  existing package version moved.
- The local Windows proof runs: `cargo check --target x86_64-pc-windows-gnu --all-targets`
  succeeds and really does compile the QuickJS C for Windows (the build script's `quickjs.o`,
  `libregexp.o`, `libunicode.o`, `dtoa.o` are `pe-x86-64` objects). The spec's claim that MinGW
  gcc is absent from this machine is stale. The `windows-msvc` leg stays CI's — it needs
  `lib.exe`, and QuickJS marks MSVC support experimental upstream.
- Values cannot escape the engine closures: `with`/`async_with` are bounded `for<'js>`, so
  `eval` converts to owned Rust inside the closure and reports only a `ScriptEnd`. Result
  shaping, the `tools.*` bridge and any JS↔JSON conversion (rquickjs 0.14.0 has **no** serde
  feature) belong to C2.
- The engine takes the **turn** token, not the session token. Passing the session token would
  cancel on the wrong boundary; the bridge is the only construction site.
- QuickJS reports an out-of-memory blowup by throwing `JS_NULL` (to avoid recursing in the
  allocator), which is not an `Error` instance, so a memory-cap trip surfaces as
  `ScriptEnd::Failed("unknown exception")`. The contract the test holds is that the cap turns a
  blowup into a `Failed` rather than a hang — the message is not contractual.
