---
status: live
last-verified: 2026-11-02
verified-by: written while shipping the codemode family, from the approved spec (revision 2, fetched from the owner-designated gist to `docs/roadmap/codemode.md` during the run) reconciled line by line against this tree on PR #151 (pre-squash tip `e826c023`, which the squash orphans — cite the PR). Claims re-checked here rather than copied — the MinGW compiler, the mingw build dir, `LOOP_INTERNAL_TOOLS`, the census tables, the exclusion list and the four limits. Single-line `verified-by` with no interior colon so this parses as strict YAML, which several other files in this directory do not.
---

# Codemode — the design

Why the `codemode` tool exists, what it was designed to do, and the places where the
approved spec was wrong about the tree. The other three codemode docs cover different
ground and none of them holds this:

- `docs/features/codemode-transcript-contract.md` — the frozen WIRE contract (element
  shape, frame keying, why frames are keyed on the parent call id).
- `docs/features/codemode-known-gaps.md` — what is still OPEN (dead `eval`, the duplicated
  gate corridor, untested paths).
- `docs/decisions/0089` — the ENGINE choice and the threat model.
- `CONTEXT.md` → **Codemode** — the glossary term.

This file is the durable half of the spec. The spec itself lived only on a gist and in the
gitignored roadmap family, and issue #145 does not contain it.

## What it is for

The model writes ONE JavaScript program where it would otherwise take many sequential tool
turns. Four objectives, from the approved spec:

1. Run independent calls concurrently — `Promise.all` genuinely batches, it does not serialize.
2. Filter large output inside the sandbox so only the completion value reaches the model.
3. Chain dependent calls without a model round trip between each.
4. Reach MCP tools without listing their schemas in the system prompt.

Objectives 1 and 2 are the ones with a checkable property behind them. (1) is pinned by
`promise_all_batches_nested_calls_in_completion_order`. (2) holds because the parent's
`ToolResult` text is the script's completion value, the nested rows ride in `details`, and
`run_tool_batch` puts `result.content` — never `details` — into the provider message. So a
script that fans out fifty `bash` runs costs the model one text block while the UI still
shows all fifty rows.

## The two decisions the author made

Both were recorded in the spec's §7 and both are load-bearing, so they are here rather than
only in a gist:

- **Callable set.** Every `execute_tool` built-in, plus `mcp` through the shared manager.
  `subagent`, `ask`, `sudo_exec` and `manage_todo_list` are excluded as interactive or
  recursive. Revision 1 of the spec had listed `subagent` as callable; revision 2 removed
  it. `list_agents` and `codemode` were added to the exclusion by the tree, not the spec —
  `list_agents` because it is the sixth loop-internal tool the spec's reachability list
  omitted, and `codemode` because a nested `codemode` is a second engine running a second
  script.
- **Result shape: uniform, not structured.** Every nested call resolves to
  `{ text, isError, details }` taken straight from `ToolResult` (or `ToolCallResult` for
  MCP). No executor changes. Consequence the author accepted explicitly: `bash` yields ONE
  combined text block with no stdout/stderr split, because that is what the executor
  returns. Structured per-tool results are deferred until scripts actually need them.

## Where the spec was wrong about the tree

Recorded because the same mistakes will be re-derived otherwise, and because "the spec said
so" is not evidence here. Every one was caught by reading the tree.

- **The census instruction is wrong, and following it would have broken a test.** The spec
  said to list `codemode` in all three censuses. `codemode` is an `execute_tool` built-in,
  so it belongs ONLY in `exec_param_keys()`; `suite_param_keys()` and `LOOP_INTERNAL_TOOLS`
  must stay untouched. The placement rule is now written in ADR 0079's Consequences, which
  is the census ADR.
- **The ADR number was wrong twice.** The spec said `0088`, then corrected itself to `0087`.
  Both exist on disk (and `0086` is duplicated), so the shipped ADR is `0089`. See AGENTS.md
  for the check.
- **Every MCP path in the spec was stale.** MCP lives at `src-tauri/src/agent/mcp/`, not
  `src-tauri/src/mcp/`. Likewise `harness/gate.rs` → `harness/loop/gate.rs`,
  `harness/permission.rs` → `agent/permission.rs`,
  `harness/normalize.rs` → `agent/normalize.rs`.
- **The Worker runtime line anchor was wrong.** The spec cited `src-tauri/src/lib.rs:323`,
  which is a doc comment about webview key-focus. The multi-thread runtime is
  `run_worker()` at `lib.rs:442-449`.
- **`Arc<Mutex<McpManager>>` does not give parallel MCP calls.** Revision 1 claimed it did;
  a mutex held across `call_tool` serializes every call, and the revision-1 text described
  an `Arc` that did not exist in the tree at all — `AgentLoop.mcp` was a plain owned field
  and grepping for `Arc<McpManager>` returned zero hits. The real fix was to lower `&mut` to
  `&self` through `McpManager` and the clients, which is what shipped. The mechanism that
  made it feasible was already there: the stdio client routes replies by id through a
  pending map and never holds the lock across an await.
- **`ToolCtx` had no event sink, so live progress was impossible as designed.** Revision 1
  said rows would publish as they happen. The `tool_execution_update` normalizer arm existed
  with zero emitters and zero frontend consumers. Building the sink is what B1 was.
- **`details.calls` did not exist anywhere** — neither the key nor a consumer. The element
  shape was frozen at the start of the run precisely so the UI task and the bridge task, in
  different waves, coded to one string.
- **Adding a field to `ToolCtx` breaks 10 of its 36 construction sites at compile time.**
  The other 26 use `..ctx(..)` and survive. That blast radius, not preference, is why the
  event-sink task owned nine test fixture files.
- **Nested calls cannot reuse `dispatch_tool`.** It takes `&mut self` for the whole turn and
  the `codemode` call runs inside it, so a nested call would deadlock. Built-ins go to
  `execute_tool` on a cloned `ToolCtx`; MCP goes through the shared handle. The consequence
  is the duplicated gate corridor that `codemode-known-gaps.md` §2 now records.

## Two facts about the engine that cost real time

Both are in ADR 0089 and repeated here only because they are the ones a person hits first:

- **A synchronous `Ctx::eval` cannot park, and it blocks its task.** `EvalOptions { promise:
  false }` is the default, so a script that merely constructs a `Promise` returns
  immediately — a test asserting `Cancelled` for that script is deterministically RED, not
  flaky. Parking needs a host `await`. And because the sync `with` closure blocks its task,
  nothing polls a `tokio::select!` while JavaScript spins, which is why the wall-clock bound
  must be enforced INSIDE the interrupt handler rather than only by racing a `sleep` arm.
- **The interrupt handler raises an UNcatchable exception**, so an interrupted busy loop
  arrives as `Error::Exception` — indistinguishable from a genuine `throw`. Mapping every
  exception to `Failed` makes "hot loop + Stop" a coin flip against the `select!` arms. The
  token is checked FIRST and the deadline second, which is what makes both outcomes
  deterministic.

## What the spec asked for that the tree then refused

Useful as a record of where design and implementation diverged by decision, not by accident.

- **`parallel` was optional in the spec, "add it if the spike says so".** The spike said so
  hard: without it `assert_send_sync::<CodemodeEngine>()` fails with four `E0277` errors,
  and the loop runs inside `tokio::spawn`, so `Send + Sync` is not optional. It is a required
  feature now and the compile-time assertion in `codemode/engine.rs` is the permanent guard.
- **The Windows proof was declared blocked on a missing compiler, and the premise was
  false.** The spec stated `x86_64-w64-mingw32-gcc` was not installed. It is installed
  (`/usr/bin/x86_64-w64-mingw32-gcc`, Fedora MinGW 16.2.1), and the local mingw build
  directory exists, so `cargo check --target x86_64-pc-windows-gnu --all-targets` — which
  AGENTS.md calls the only local Windows proof — was run rather than deferred to CI. The
  owner's choice had been "accept CI-only proof" on a false premise; the choice was about
  not installing anything, which held either way. Still true, and unchanged: MSVC is not
  provable from a Linux box (`lib.exe`, no wine), so `#[cfg(windows)]` behaviour remains
  CI-only evidence.
- **`shiki` is in devDependencies**, at `package.json:45` (the spec said `:46`), and the
  card's highlighting had to survive that.
- **`ToolCallCardHeader` never sets `aria-expanded`** — its own doc comment says the header
  is the tooltip trigger. So the card's tests assert a visible TEXT marker, following the
  `MessageBubble.test.tsx` subagent precedent, rather than inventing an aria contract.

## What was deliberately NOT built in v1

- No ranking for discovery — `searchTools` is case-insensitive substring matching on name
  and description, reusing the `mcp` search rule. Archimedes has no BM25 ranker and the spec
  deferred ranking.
- No structured per-tool results (see the uniform-shape decision above).
- No per-call limit override. The spec left it open in §7 and nothing has asked for it since.
- No nested `codemode`, no nested `subagent`, no nested interactive tools.
