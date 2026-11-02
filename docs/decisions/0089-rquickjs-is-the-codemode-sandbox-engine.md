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
