---
status: accepted
date: 2026-11-09
superseded-by:
---

# Task tools are native tools over a `TaskStore` seam, not an MCP server, and they are `execute_tool` arms so codemode can reach them

Giving the harness access to the **Task board** has two obvious routes: five native tools,
or an MCP server. We chose native tools over a fifth seam (`trait TaskStore` in
`fulcrum-core/src/seams.rs`), following ADR 0091's rule — *a thing the crate needs but cannot
hold becomes a seam* — since Tasks are DB-backed and `DbError` wraps `rusqlite::Error` so they
cannot cross the boundary.

**The seam crosses a process boundary, not just a package one, so it needs TWO
implementations.** `AgentLoop` — and with it `execute_tool`, the would-be caller — runs in the
**Worker process**, which has no `Db`: its `Store` is `IpcStore`, whose read half errors with
*"worker store is write-only — resume is rehydrated via the start envelope"*. The **Supervisor**
is the sole SQLite writer (ADR 0025). So `impl TaskStore for storage::Db` is correct but lives
Supervisor-side, and the Worker gets `IpcTaskStore`, mirroring the `Store` split exactly.

`manage_todo_list` is the tempting precedent and it is a **trap**: it works over write-only IPC
because it never needs a value back — it pushes `todos_update` and the Supervisor persists.
`get_task` and `list_board` must return rows, and no `Outbound` variant returns data (they are
`Event` / `TranscriptInsert` / `TranscriptReplace` / `DisplayUpsert` / `ContextUsage`, all
one-way). The read round trip is precedented by `Inbound::InteractiveResponse` /
`PermissionResponse` resolving a oneshot the Worker parked before emitting its request, and the
two rules that path documents — register the oneshot **before** emitting, and a `Drop` cleanup
guard for when the `dispatch_tool` turn-cancel arm drops the parked future — are mandatory here
for the same reasons.

**Why MCP was rejected, on a measured fact rather than a preference.** MCP servers are
discovered from `settings.json`'s `mcpServers` map, `~/.pi/agent/mcp.json`, and
`<cwd>/.pi/mcp.json` — an **app-global and project-level** configuration. A **Task board** is
per-**Space**, so a per-Space MCP server would require the desktop to synthesize a server
entry per Space and to tell each child which Space it belongs to. Natively, `ToolCtx.cwd`
*is* the Space path already, and `AgentLoop` holds `self.session_id` — so both identities
arrive free. Native tools also inherit the **Permission prompt**, the `enabled_tools` filter,
and `list_tools()` (so all five are disableable in Settings) for free; an MCP server is
invisible to all three.

**Why `execute_tool` arms and not loop-internal.** `manage_todo_list` is the in-repo
precedent for a stateful tool and it is loop-internal — dispatched in `dispatch_tool`'s own
`match`, not in `execute_tool`. That shape has `session_id` in scope for free, but the
codemode bridge calls `execute_tool` directly (`loop/codemode.rs:1067`), so loop-internal
tools are physically unreachable from a script; that is exactly why `manage_todo_list` sits
in `EXCLUDED_FROM_SCRIPT`. Task tools are neither interactive nor recursive, so they do not
belong on that list, and the batch case is real: `roadmap` turning an approved backlog into N
**Tasks** is one script with a loop under placement 2, and N separate tool calls under
placement 1.

## Considered options

- **An MCP server** — rejected on the per-Space configuration fact above, plus a second
  child process per session.
- **Land the E.6 executor-trait inversion first**, so the desktop supplies executors and any
  future feature gets the same door. Fixes the root limitation, but the crate author
  explicitly declined it because it touches the hot dispatch path; a bigger sell for a
  smaller feature.
- **Client-only v1, tools later.** Ships the visualisation without the engine change, but
  contradicts the point — the model cannot move its own card, so the loop stays open.

## Consequences

- **The change spans two repos and a tag pin.** `fulcrum-core` is a tag-pinned git
  dependency, so the sequence is: desktop PR (usable by a human alone) → fulcrum PR → tag →
  bump `src-tauri/Cargo.toml` → wire the seam. `cargo test -p fulcrum-core` fails in this
  checkout by design; the engine tests run in a `fulcrum` clone.
- **Four registration sites are mandatory, and the censuses are the proof.** `tool_specs()`,
  `execute_tool`'s match, `exec_param_keys()` (required because these are arms, not
  loop-internal), and `src/lib/toolDetailsRegistry.ts`. `every_tool_spec_is_in_the_param_key_table`
  and `every_loop_internal_tool_is_covered_by_a_param_key_census` close the union, so a
  half-registered tool is a red test rather than a silent gap.
- **`EXCLUDED_FROM_SCRIPT` stays at six entries, which keeps a literal passing.**
  `loop/tests/codemode.rs` asserts `tool_specs().len() - 6`; the `len()` is runtime and only
  the `6` is a literal. Adding five callable tools and zero exclusions leaves that test
  untouched. The loop-internal placement would have had to become `- 9` *and* rename the
  test's own message about "the six excluded tools".
- **Task tool descriptions must not contain `read` or `subagent`.**
  `src-tauri/tests/worker_e2e.rs` asserts `!tools_section.contains("read") &&
  !tools_section.contains("subagent")` over the whole rendered `<tools>` section. Same ban
  ADR 0079-era prose already carries for the `codemode` description, now extended to five new
  tools — and a trip reddens the Windows CI leg only, so it will not reproduce locally.
- **`POLICIED_TOOLS` is deliberately untouched.** It lists only the seven path/shell tools; a
  Task row is not a filesystem access, so the **Boundary** and the **Beyond-boundary policy**
  have nothing to judge.
- **This is a protocol change, not only a seam.** Two new wire variants (a Worker→Supervisor
  task request on `Outbound`, its response on `Inbound`) plus `IpcTaskStore` and the Supervisor
  router branch that answers it. That is the bulk of the `fulcrum` half, and it is why the tools
  cannot be described as "just add five match arms". It also means the seam must be proved on
  both sides: the crate-side `IpcTaskStore` framing and the desktop-side `Db` impl are separate
  proofs, and an instantiation pin alone says nothing about the round trip — the same
  instantiation-vs-behaviour distinction ADR 0091 records for the other seams.
- **A task tool call can now be cancelled mid-flight, so cancellation is a real state.** The
  parked read must race the turn token (as `todo_apply` does) and clean up its pending-map entry
  on `Drop`. A Stop that leaves the entry behind is a leak; a Stop that leaves the Worker parked
  forever is a hang. Neither was possible for the write-only tools this was first modelled on.

## Amendment (2026-11-09) — the dependency is a published crate, so the sequence ends in a PUBLISH, not a tag

**The decision is untouched.** Native tools over a `TaskStore` seam rather than an MCP server, arms
of `execute_tool` so codemode can reach them, four mandatory registration sites, and the
process-boundary reading of the seam added earlier today — none of that changes, and nothing here
unlocks the deferred harness tools. What changes is the release mechanics this ADR's first
Consequence describes, because the dependency's source changed: `fulcrum-core` was renamed
`fulcrum-harness` (fulcrum#17, `12488ee`) and published to crates.io as `fulcrum-harness` 0.1.0
(2026-11-08, from `b52ce68`), and `src-tauri/Cargo.toml` now pins that release.

**The sequence, corrected.** This ADR said: *desktop PR → fulcrum PR → tag → bump
`src-tauri/Cargo.toml` → wire the seam.* Today the tag step is a **publish** step:

> desktop PR (usable by a human alone) → fulcrum PR → **publish a new `fulcrum-harness` version** →
> bump the version in `src-tauri/Cargo.toml` → wire the seam

The tag step is **temporarily** a publish step, not abandoned: `v0.1.0` cannot carry the new name —
it peels to `ae1fe97`, whose manifest still declares `name = "fulcrum-core"`, so a tag pin of the
renamed package hard-fails resolution with `no matching package named fulcrum-harness found`. Tag +
version returns with a NEW fulcrum tag on a post-rename commit, and the sequencing rule from
fulcrum#20 still binds: the desktop's dual-match widen must **release before** any tag bump that
carries the rename. Never re-point `v0.1.0` — it is cited as history in both repos and the ancestry
gate forbids moving it. Note also that a green `check-versions.sh --tag` is not proof of a usable
tag: fulcrum's `162bf48` records it printing "versions match", exit 0, over this un-installable tag.

**`cargo test -p fulcrum-harness` still fails here, in the same words.** Measured after the rename,
exit 101: `package `fulcrum-harness` cannot be tested because it requires dev-dependencies and is
not a member of the workspace` — the identical sentence `cargo test -p fulcrum-core` printed as a
git dep, because a registry dep whose published manifest carries dev-dependency stanzas lands in the
same arm. So `AGENTS.md`'s guidance survives with only the name changed. (Do not confuse it with
`package ID specification `fulcrum-harness` did not match any packages`, which is what that command
prints *before* the rename, when no such package exists yet.)

**`trait TaskStore` still goes in the crate's seams module.** `:11` cites `fulcrum-core/src/seams.rs`;
the file is now `fulcrum/src/seams.rs` in `archimedes-codes/fulcrum`, published inside
`fulcrum-harness`, and `fulcrum/src/seams.rs` exists in the published `0.1.0` artifact — verified, so
the forward-looking citation still has a destination. The `crates/fulcrum-core/...` addresses in this
ADR's body are where code lived at decision time and are left as written, per ADR 0091's amendment.
