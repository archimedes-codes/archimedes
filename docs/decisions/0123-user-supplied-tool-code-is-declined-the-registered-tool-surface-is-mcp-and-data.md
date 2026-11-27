---
status: accepted
date: 2026-11-27
superseded-by:
---

# The registered tool surface is MCP and data; a user-supplied tool script executed in-process is declined

ADR 0102 made a **Host tool**'s spec travel to the **engine** as data, and the follow-up measurement is
stronger than 0102 claimed: of the twenty sites on the host-tool path, **eighteen are name-agnostic** (they
map over a `Vec` or carry a `String`), `ToolSpec` derives `Deserialize`, `PROTOCOL_VERSION` stays **1**
because the frame carries `tool: String` and the **Worker** is a self-exec of the same binary so wire skew
is *unrepresentable*, and adding *N* names needs **no crate change and no protocol change**. So "the desktop
can add a tool without a crate release" is settled fact, and the next question will keep arriving from that
fact: *can a user add one, with code?*

**We decided: no — not as code the Client executes in-process.** A person may register a tool by **adding an
MCP server** — an external process or endpoint the desktop never executes code inside — and, if declarative
registration ever lands, by supplying a **spec whose executor is a name the Client already implements** (an
allowlist of host-implemented dispatch targets). A person may **not** supply **code** the Client evaluates in
its own process. This declines a thing that does not exist yet; it does not amend 0102, whose ruling on the
registry as sole dispatch authority stands unchanged, and it is NOT the same decision as 0121 (a Search
provider is Host-tool territory) or 0122 (the Client is the Supervisor).

**Why this is ADR-worthy and not a backlog preference.** One product in this market ships a real in-process
tool-registration API, and that same product ships no install-time consent and a base policy of
`{action:"*",resource:"*",effect:"allow"}`. The co-occurrence is the whole argument, and it is only visible
if someone writes down which door this product chose and why.

## Why the seam does not settle it

**The seam is data-shaped, and data-shape is not the same as safe-to-supply.** `ToolSpec`
(`fulcrum-harness 0.8.0`, `src/provider_types.rs:151-156`) is **three fields** — `name`, `description`,
`parameters: Value` — with no dispatch discriminator, no script-reach field, and no permission key.
`ToolEntry`'s `executor: Arc<dyn ToolExecutor>` and `script: ScriptAccess` are `pub` and **never cross the
wire**. So a registration file can say *what a tool is called* and nothing about *who answers it* or *what
it may touch*; the shape that makes the seam free to extend is the same shape that makes it silent about
authority.

**Worse, a spec from disk is automatically reachable from a script, with no opt-out.** `host_entries`
(`src/tools/exec/registry.rs:532`) assigns `ScriptAccess::Allowed` to every accepted spec — documented as a
*preservation rule*, not a default, because ADR 0092 chose those executor arms specifically so a `roadmap`
script could create N Tasks — and `script_access()` (`:617`) falls through to
`.unwrap_or(ScriptAccess::Allowed)` for any name the crate has never named. A user-registered tool is
therefore **immediately callable and discoverable from a `codemode` script**, and the registrant cannot
decline short of editing a pinned crate. Whatever else a script tier needs, it needs this default reversed
first, and that is engine-side work.

## The gate we would be leaning on is consent over the user's own authority, not containment

**Every one of these five is true at the shipped default posture, and each was re-read in 0.8.0 rather than
inherited from the report.** ADR 0089 states its own limits honestly — the script limits exist "so that a
*bug* cannot wedge the **Worker**, not to contain an adversary" — and that is the right model for
model-authored `codemode` and the wrong model for adversarial user-authored code.

| Hole | Measurement |
|---|---|
| At defaults the gate **asks nothing** | `AccessPolicy`'s `#[default]` is `Allow` (`src/policy.rs:23-31`, comment: "THE derived default — see `FilePolicy`"), and `FilePolicy` derives `Default`, so `reads` / `writes` / `shell` are all `Allow` and `decision_for` answers silently. A script's `bash` call runs `sh -c` at the user's full permissions with **zero prompts**. Rules never apply to `bash`. |
| `mcp` and both web tools are **ungated** | `POLICIED_TOOLS` is exactly **seven** names (`bash read find grep ls write edit`, `src/harness/loop/gate.rs:18-26`), and `policy_verdict` opens with `policed_direction(&tc.name)?`. A script's `mcp` call spawns stdio children with no prompt ever. |
| A script chooses its own egress path | `web_search` advertises a caller-supplied `proxy` (`src/web/tools.rs:134`) that reaches `reqwest::Proxy::all` (`src/web/net.rs:254`); the SSRF guard rejects private ranges — loopback is *explicitly allowed*, ADR 0057 — so an attacker-chosen **public** proxy passes. Mechanism code-verified; **not tested as an exploit**, and `bash` achieves the same more simply at defaults. |
| **No call budget of any kind** | No call counter, no rate limit, no child-process cap. A nested `bash` accepts `timeout_ms` up to `MAX_BASH_TIMEOUT = 15 * 60` s (`src/tools/exec/bash.rs:17`) — **3× the script's own `WALL_CLOCK = 300` s** (`src/harness/loop/codemode.rs:87`). |
| Confinement is **absent or partial** | Off Linux the sandbox module is not compiled at all and `Sandboxed` returns "unavailable on this platform" (fail-closed, correct). On Linux `handled_access_net` is **0 at every ABI** (`src/tools/sandbox.rs:107`) — "a confined command can still `curl` out with anything it was allowed to read." |

And the ceiling that no gate change removes: **the process holding the script is the process holding the
provider keys and the user's file permissions.** A script tier's honest ceiling is "the Worker is lost."

**QuickJS says so about itself, in the source this build vendors.**
`rquickjs-sys-0.14.0/quickjs/SECURITY.md:59-62` states the threat model as a bug "reachable from untrusted
JavaScript source running in an **otherwise trusted embedder**", and disclaims bytecode input and C-API
values — i.e. the embedder's trust is an *assumption*, and a user script is precisely the input that
withdraws it. Measured upstream: 33 CVEs on NVD for `quickjs` and 31 OSS-Fuzz findings (report-sourced
counts, not re-queried here), including a 2025-10 cluster of five at CVSS 8.8 reachable from plain JS source
— inside the stated model, not outside it. The strongest
prior art is almost this product's shape: Telegram's QuickJS widgets (app-supplied JS in QuickJS) were RCE'd
**in a day**, and the move-to-a-process + seccomp fix was bypassed **two days later** because the filter was
a ~30-call denylist. Their conclusion is the one this decision adopts: assume the engine is already
compromised and design for what the attacker holds next.

## An engine swap does not buy a boundary

**Confinement is an OS question, and no JS engine choice answers it.** `v8` / `deno_core`: **isolates are
context separation, not a security boundary** against a compromised V8. `deno_runtime`: a real permission
model, but taking it means taking the whole runtime. `boa_engine`: pure Rust, so the C memory-safety class
disappears entirely — and ADR 0089 rejected it on async/host-promise interop, which is still the right read;
it removes one bug class and buys zero containment. The engine choice is about JS quality and host-await
ergonomics, where rquickjs is genuinely the best fit — so the engine argument was never the objection here,
and treating it as one would produce a rewrite with the same ceiling.

## What would reopen it

**Four prerequisites, each necessary, none sufficient** — all of them gate changes rather than features:

1. a **script-scoped narrowing** a script cannot inherit `Allow` from (the `permission:` layer's
   narrowing-only, child-only `Allow < Confine < Ask < Deny` shape is the template);
2. **gating `mcp` and both web tools for script calls** (today `POLICIED_TOOLS` cannot see them by name);
3. **removing the `proxy` override for script calls**;
4. a **call budget** (calls, rate, children, and a nested-tool timeout bounded by the script's remaining wall
   clock rather than 3× it).

**Plus the ceiling that survives all four:** the process holding the script holds the provider keys. That is
why the durable shape for adversarial code is a **confined helper process** with a tainted return boundary —
where Linux Landlock is already written and child-installed via `pre_exec` (the work is net rights and a
per-helper profile, not adopting bubblewrap, whose non-setuid path Ubuntu's AppArmor userns clampdown
breaks), and where **Windows has no off-the-shelf answer**: OpenAI evaluated AppContainer, Windows Sandbox
and Mandatory Integrity Control for Codex on Windows and **rejected all three**. Do not start that from a
registration card.

## Considered options

- **A user script in the existing QuickJS engine** — **rejected.** Nothing to reuse (the desktop's `rquickjs`
  dependency at `src-tauri/Cargo.toml:240` has **zero source hits** — vestigial; the live engine is
  ADR 0089's and lives in the crate, in the **Worker**), everything to build (a new subsystem plus a new
  security story), and the five measured holes above under a ceiling that no gate change lifts.
- **A user tool expressed as a Tauri plugin** — **rejected, and not on security grounds: it is not a user-code
  channel at all.** Tauri plugins are compiled-in Rust crates, and Tauri states plainly that "any code
  executed by the plugins or the application core has full access to all available system resources and is
  not constrained", listing "malicious or insecure Rust code" among what capabilities do *not* cover. It
  would be a release-shaped mechanism wearing an extension-shaped costume. (`capabilities/default.json`
  grants only `core:default`, `dialog:default`, `opener:default` and four `core:window:*`;
  `tauri-plugin-shell` is deliberately not installed — `commands/update.rs:11`.)
- **MCP-only for everything** — **adopted for the external class, declined as a universal answer.** Adding a
  server is a JSON edit or a Settings row: no rebuild, no crate release, three config layers with the
  per-Space `.pi/mcp.json` at highest precedence. But it is a second process the policy layer cannot address
  **by name**: all three of 0102's invisibility claims hold in 0.8.0 and the first is worse than stated —
  the only name the model can emit is `mcp`, the server tool is a string *inside* its arguments, so there is
  no judgeable identity and `mcp: deny` is a total no-op at both layers; no `enabled_tools` value means "not
  this server"; and `list_tools` is stateless by design so it *cannot* reach a per-session `McpManager`.
  `annotations` (`readOnlyHint`/`destructiveHint`/…) are **discarded at the transport boundary** — `ToolInfo`
  is three fields, both `list_tools` parsers pick exactly those three, and `grep -rn annotations` across the
  crate returns **0 hits** (the desktop's 5 are unrelated `MessageBubble` prose comments) — and even if read
  there is no gate for them to plug into, which
  matches the MCP spec's own warning against deciding on them. Capability boundary, not defect: external
  substance fits, host-mutating substance is the wrong vehicle.
- **A confined helper process** — **deferred.** The only shape that could actually host adversarial code;
  Linux is the cheap leg, Windows is a project. Not started from this decision.
- **OpenCode's in-process `ctx.tool.transform` model** — **rejected as the precedent it is.** It is the
  market's only live example of the first option, and the same product ships no install-time consent, an
  allow-everything base policy, unpinned plugins that self-update on startup and every 24 h, and a
  permission namespace plugins may extend. Meanwhile every product that lets a person add a tool without a
  release does it with a `mcpServers` entry, and all three model vendors say in their own words that the
  **host** executes a declared tool — a spec is a **wire format, not an extension mechanism**. The market
  converged twice, in the same direction, on the property this decision protects: the host never runs user
  code, so the trust question collapses to "do you want to talk to this thing," which a user can answer.

## Consequences

- **Any future declarative registration inherits two crate-side blind spots.** Cards **#45** (`ToolKey`
  names none of the host verbs, so a `permission:` block naming one is parsed, announced as
  `UnrecognizedToolKey`, and **inert at the gate**) and **#46** (`narrow` filters a definition's `tools:`
  against the engine's specs, so it cannot narrow to host tools at all). Both are ≥0.9.0 engine work, so
  "registered" must not be sold as "permissionable" until they close.
- **`docs/research/keenable-as-a-search-provider.md` is stale on this point.** Its claim that "the sanctioned
  mechanism exists on paper and is not built" describes a world before `adec7dbe` (ADR 0102) — it shipped in
  **0.8.0**. Read it as pre-0102 context.
- **The evidence lives on an unmerged branch.** Every finding here (§F1 the 18-of-20 name-agnostic census,
  §F2 the MCP verdict and the three invisibility claims, §F3 the market convergence, §F4 the script ceiling
  and the engine survey, §F5 the twenty-surface table, §F6 where work lands) comes from
  `docs/research/the-host-tool-seam-takes-data-but-nothing-supplies-it.md`, which **was not merged when this
  ADR was written** — read it at commit `d3d6d090` (`git show
  d3d6d090:docs/research/the-host-tool-seam-takes-data-but-nothing-supplies-it.md`) if the path does not
  resolve in your tree. Its load-bearing local claims were re-read at this repo's HEAD, not inherited.
- **The falsifier: a Space-supplied or hand-authored `host_tools` list makes declined work required.**
  `host_entries` refuses — by dropping and logging — any spec whose name `tool_specs()` already carries, and
  that refusal is **provably unreachable today**, because the Client's specs are disjoint from the engine's
  advertised set by construction: **eight** host specs at this HEAD (`list_board get_task create_task
  edit_task move_task get_artifact write_artifact mark_done` — the seven of 0102 plus `mark_done` from
  `d4b4995b`; the plan that produced this ADR counted seven, and **the count is not the argument, the
  invariant is**) against 19 engine built-ins, asserted by
  `the_eight_host_specs_are_disjoint_from_the_engine_advertised_set` in
  `src-tauri/src/agent/host_tools/tests/surface.rs`. The moment a list can come from a **Space** or from a
  hand-authored file, a colliding name becomes constructible, the drop becomes reachable, and the
  **dropped-tool visibility surface this run deliberately declined becomes required work** — because the
  drop currently lands only in `eprintln!` + `diagnostics::record`, and no command in the IPC surface (80
  `generate_handler!` entries at this HEAD) returns or reveals that file — the frontend's only "diagnostics"
  hits are three comments in test and source files, zero production reads — so the person who registered the
  tool would see a tool that simply vanished. Adopt the **agents** honesty standard (announce, per row, with
  a reason) if that day comes, not the skills standard (skip silently).
- **Nothing here forecloses Tier 2.** A declarative spec whose executor is a name the Client already
  implements remains buildable desktop-only, one repo, no publish, no protocol change — it is gated on the
  visibility prerequisite above and on a dispatch discriminator `ToolSpec` cannot carry, not on this
  decision.
