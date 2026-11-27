---
status: live
last-verified: 2026-11-27
verified-by: read against this tree at `2b6bd26` (`agent/mcp/tool.rs`, `agent/harness/tool_specs.rs`) — every gap below re-confirmed still open, not copied from the plan — DATED PATH NOTE 2026-11-25, and it is about a PATH and not about any gap below. The second path this line cites, `agent/harness/tool_specs.rs`, no longer exists in this tree. `agent/harness/` is now an ALIAS module with only `{mod,store,trust}.rs` (the harness moved to the crates.io-pinned `fulcrum-harness`), and since ADR 0102 / issue #183 `tool_specs()` is the ENGINE's 19-name table while the board verbs are this repo's own Host-tool specs in `agent/host_tools/specs.rs`. CORRECTION 2026-11-27, of a figure THIS line had WRONG: it said "the seven board verbs", and `mark_done` (shipped in `d4b4995b`) made that stale — the count measured at `d4b4995b` is EIGHT, not seven — not at `2b6bd26`, where `specs.rs` does not exist at all (it arrived later, in `adec7dbe`), so the read at the head of this line and this count are two different trees and this clause says which is which — and it is re-run rather than carried (`grep -c "ToolSpec {" src-tauri/src/agent/host_tools/specs.rs` gives 8, `src-tauri/src/agent/host_tools/tests/surface.rs` declares `const HOST_TOOL_NAMES: [&str; 8]` and pins `the_eight_host_specs_are_disjoint_from_the_engine_advertised_set`, and the composed advertised set that file asserts (the engine's 19 plus the eight board verbs, no name in both halves) is 27). No `mcp` gap is closed or opened by that move. `mcp` stays a loop-internal arm, its `action: "auth"` needs to prompt so no name-level `ScriptAccess` field can express its reach, and the `mcp` spec text itself is unchanged among the crate's 19. NEW SECTION 2026-11-27 — `## MCP as the way to add a tool, and what an MCP tool is invisible to (#47)` — seven registration-consequence claims, each re-measured in that sitting against the registry extract of the PINNED `fulcrum-harness` 0.8.0 (`src-tauri/Cargo.toml` declares it, so the crate line numbers below cannot drift) plus this tree. The three-layer `mcpServers` merge with the project layer last, `mcp` outside `POLICIED_TOOLS` with `mcp: deny` a no-op at BOTH the gate and the child's advertised set, `enabled_tools` unable to name a server or one of its tools, `push_config_update` excluding `mcp_servers` while `apply_config_update` has no parameter to receive it, `collect_tools` awaiting every server serially under a 60 s per-request bound, the `#`-mention picker dropping a `disabled` server with no note, and `annotations` discarded by both `list_tools` parsers (0 hits crate-wide). CORRECTION 2026-11-27, of one claim that section carried as false-in-the-tree: it said there was NO Settings off-switch for an MCP server, that `draftToEntry` never set `disabled` and that the section listed every entry unfiltered, so `disabled: true` was reachable only by hand-editing `settings.json`. Both halves of it have SINCE SHIPPED in this same run (#47): `93d4be46` added the per-server off-switch (`McpDraft.disabled`, the `Switch server off` control, the `Off` badge, `draftToEntry`'s conditional write that omits the key when false) and `0cb795ff` gave the off state its own honest sentence in `test_mcp_server` / `auth_mcp_server` (`disabled_mcp_server_error`, ahead of `classify_server`). The two items that carried it now say that instead, and every `McpSection.tsx` and `commands/settings.rs` line number near those edits was RE-MEASURED at the merged tree — the siblings inserted code above them. Rust read, not executed — no test reads this file, so the citations ARE the instrument. `docs/decisions/0123-user-supplied-tool-code-is-declined-the-registered-tool-surface-is-mcp-and-data.md` (`status: accepted`) HAS LANDED since this file was first written; it records that a user-supplied tool SCRIPT executed in-process is DECLINED and that the registered-tool surface is MCP and data — the security half of the registration story — and it is still deliberately NOT cited in any item above, so nothing here depends on it. SQUASH-ORPHAN CAVEAT 2026-11-27: this repo squash-merges feature branches into `main`, so the hashes this file cites are dating anchors and not durable handles — the hashes this file cites that come from this branch's own run and are measured not ancestors of `main` at this sitting (`0cb795ff`, `649b241a`, `93073edc`, `93d4be46`, `a9b2347`, `bac7b122`, `d2cb1fa`) are unreachable once this branch squash-merges, and this enumeration is deliberately left uncounted because any total goes stale the moment a citation is added, so the named greps and test names are the durable instrument.
---

# MCP — known gaps

Accepted, unfixed defects in the MCP client. They live here because the roadmap
family that recorded them (`docs/roadmap/issue-triage-backlog-*`) is deleted on
ship, and the issue tracker holds only the parts of it that were filed. This is
the surviving home for the rest — read it before concluding that a token, a
state or an option is handled.

## The five `NeedsAuth` / OAuth residuals (#68, shipped by T7 as `d2cb1fa`)

T7 fixed the two reported symptoms — a skipped server now FAILS a bare `mcp`
call instead of reporting `Tool not found`, and an expired stored token is now
refreshed and persisted before it is sent (`manager::usable_token_provider`).
These five were recorded while planning and deliberately left open; four are at
the bottom of the deleted `task07` plan doc, the fifth is T4's session-vs-Settings
gap that its own plan named.

- **The OAuth access token goes out with no `Bearer ` prefix.** `http.rs` frames
  `Bearer {t}` for the STATIC `AuthSpec::Bearer` header only
  (`http.rs:86`); an OAuth token from the provider closure is handed to
  `Authorization` verbatim (`http.rs:157`, `:281`). Spec-strict auth servers
  reject that, so MCP OAuth may fail against a real provider for a reason
  unrelated to #68.
- **Mid-session token expiry is not handled.** The provider closure is built once
  at connect time and captures one token string
  (`manager.rs:355-368`), and only `ensure_connected` maps a 401 → `NeedsAuth`
  (`manager.rs:183`, `http.rs:177-181`). A token that expires mid-session leaves
  the entry `Connected` and every later call failing — the fix wants a
  401→refresh→retry inside `http.rs`.
- **A stdio connect failure never reaches `McpState::Error`.** `ServerDef::Stdio`
  propagates with `?` (`manager.rs:171`) past the `Error { text }` arm that only
  the HTTP branch has, so the entry sits in `Connecting` and `status` never
  reports why the server is dead. `tool.rs`'s `skip_reason` fallback covers the
  symptom, not the cause.
- **Refresh-token ROTATION drops the rotated token.** `parse_token_response`
  takes `refresh_token` from the response and nothing else (`oauth.rs:273-276`),
  so a server that rotates the refresh token but omits it from the refresh
  response replaces the stored one with `None` — and `oauth::refresh` returns
  `None` at once without one (`oauth.rs:396`), ending auto-refresh for that
  server permanently.
- **Authenticating from Settings does not unstick a live session.**
  `authenticate_server` (`manager.rs:536`, reached from
  `commands/settings.rs::auth_mcp_server`) writes `mcp-auth.json` and returns —
  it has no manager entry to correct, because it runs outside any session's
  `McpManager`. A live session holding that server in `NeedsAuth` stays stuck
  until it reconnects: `ensure_connected` never auto-retries `NeedsAuth`
  (`manager.rs:161-166`). The `mcp` tool's own `auth` action does clear the state
  (`authenticate_with` drops client + state, `manager.rs:314-318`), so the gap is
  specific to the Settings door, not to authenticating.

## The `server_tool` name forms, and what the precedence shadows (#118, T3)

`mcp({ tool: … })` and `mcp({ describe: … })` now accept the callable prefixed
spelling: `<server>_<tool>` (the form `search` and the single-`server` listing
print) and the `mcp__<server>__<tool>` alias. Both resolve against the server
names the manager
HOLDS by LONGEST prefix — never a split on the first `_` — so with a `github` and
a `github_enterprise` server, `github_enterprise_get_issue` is server
`github_enterprise`'s `get_issue`. Whatever the tier resolves to, the RAW tool
name is what reaches the server: the prefix is a spelling this proxy understands
and is never forwarded. The rules that decide an awkward name:

- **A prefix naming a known server WINS over a literal raw name.** `github_echo`
  is server `github`'s `echo` even if some other server serves a tool literally
  called `github_echo`. A `server` param forces the RAW reading — the name is
  passed through untouched — and a name carrying no `_` is never a prefix
  candidate at all, which is what keeps every raw-name behavior below intact.
- **A prefixed miss FAILS even when every server answered** (#118). This is
  layered onto the #68 partial-set rule, not a replacement of it: a raw name's
  miss keeps its exact bytes (`Tool not found: nope`, a SUCCESS on an all-healthy
  set), and a prefixed miss composes the same `Skipped servers:` note, scoped to
  the server the prefix named.
- **A resolved prefix never reaches the ambiguity rule.** The tie arm counts the
  servers owning a RAW name; a prefix has already picked its server by
  construction.

**The residual limitation the precedence leaves:** a tool literally named
`X_<something>` on a server that is NOT `X` is SHADOWED whenever `X` is also a
known server — `{ "tool": "github_echo" }` cannot reach server `linear`'s
tool of that literal name, because the prefix reading wins. The escape hatch is
the raw reading: `mcp({ tool: "echo", server: "linear" })` (and, for the literal
name, `mcp({ tool: "github_echo", server: "linear" })` — a `server` param means
the name is raw). `search` still lists the shadowed tool under its own
`[linear] linear_github_echo` line, so it is findable, merely not callable by
that spelling. Accepted: the alternative — preferring a literal raw name over a
known-server prefix — would make the callable form `search` prints unreliable,
which is the whole point of the change.

## MCP as the way to add a tool, and what an MCP tool is invisible to (#47)

Board card #47 is "No way to add a tool without a desktop release", and the
mechanism that answers it is already in the tree — `mcpServers` IS the extension
door. What no document said before this section is what an MCP tool is NOT wired
into: the permission gate, the tool allowlist, the live config push, and the
`#`-mention picker. Every claim below was re-measured in one sitting against the
registry extract of `fulcrum-harness` 0.8.0 (the pin in `src-tauri/Cargo.toml`)
and this tree; the crate paths are that extract's, and a published crates.io
version is immutable, so those line numbers cannot drift.

- **A `mcpServers` entry is the registration mechanism — no rebuild, no crate
  release.** Three layers merge crate-side in `load_servers`
  (`mcp/config.rs:36-58`) — `<$HOME>/.pi/agent/mcp.json`, then the desktop's
  `settings.json` `mcpServers`, then `<space cwd>/.pi/mcp.json`
  (`mcp/config.rs:42-49`) — and because the merge is a later-`insert`-wins loop
  over exactly that order (`mcp/config.rs:50-56`), **per-Space MCP config
  already ships, at the highest precedence**. The first server costs zero extra
  context, because the `mcp` spec sits in the engine's own table
  (`harness/tool_specs.rs:322`) and `advertised_tool_specs` filters that table on
  `enabled_tools` and the child guard and nothing else
  (`harness/loop.rs:2199-2215`) — there is no server-count condition anywhere on
  that path, so the name is advertised whether or not a single server exists.
- **An MCP tool reaches no permission judge at all — and `mcp: deny` is a no-op
  at both layers.** `POLICIED_TOOLS` is exactly
  `bash read find grep ls write edit` (`harness/loop/gate.rs:18-26`) and
  `policy_verdict` opens with `policed_direction(&tc.name)?`
  (`harness/loop/gate.rs:179`), so a name off that table returns `None` —
  ungated — before any policy is read, and that table's own doc names `mcp` as
  one of the ungated tools (`gate.rs:40-42`). The only name the model can emit
  is `mcp`, and the server tool is a STRING inside its arguments
  (`harness/loop/tools.rs:259-271`), so no spelling of it can reach the judge.
  There is no `ToolKey::Mcp` variant (`definition_permission.rs:156-172` — an
  `mcp` key falls to `Unrecognized`, `:193`) and the `definition_verdict` consult
  sits at `gate.rs:252`, PAST that early return, so a `permission:` block naming
  `mcp` produces no verdict. Nor does it narrow a child — the pre-wire deny
  filter drops a name only where `tool_key_name` answers `Some`
  (`harness/launch.rs:353-366`) and `Unrecognized` answers `None`
  (`harness/launch.rs:425`), so the name stays in the child's advertised set.
  ADR 0030 already says it: "`sudo_exec` and the MCP tools sit outside the policy
  … `Shell = Sandboxed` confines `bash` and nothing else."
  (`docs/decisions/0030-file-access-policy.md:46`).
- **No `enabled_tools` value can mean "not this server" or "not this tool".**
  `enabled_tools` is a name filter over `advertised_tool_specs`
  (`harness/loop.rs:2208-2211`), and MCP tools are not in that set and
  structurally cannot be — a server tool has no `ToolSpec` and no executor, it
  is a name the one `mcp` arm forwards at call time (`mcp/types.rs:99-103`,
  `harness/loop/tools.rs:259-271`). `disabled: true` is therefore the ONLY
  per-server switch, and it works by making `classify_server` answer `None`
  (`mcp/types.rs:280-282`). **The Settings off-switch for it exists** (it
  landed in the same run as this section, `93d4be46`, after this item was
  written). The dialog draft carries the flag (`McpDraft.disabled`,
  `src/components/settings/McpSection.tsx:235`, grep `disabled: boolean;` —
  names locate, the numbers only date them, measured at `649b241a`) and the
  `Switch server off` control binds it for BOTH kinds, because that row sits
  AFTER the kind ternary (`src/components/settings/McpSection.tsx:444-448`,
  grep `Switch server off`). `draftToEntry`
  (`src/components/settings/McpSection.tsx:272`, grep `function draftToEntry`)
  writes the wire field (`src/lib/tauri/types.ts:1341`) OUTSIDE the `kind`
  branch, as `if (d.disabled) entry.disabled = true;`
  (`src/components/settings/McpSection.tsx:293`) — OMITTED when false, so a
  clean entry stays clean and the key still means only "off". The row badges
  it `Off` (`src/components/settings/McpSection.tsx:127-131`, grep
  `isDisabled &&`) and DEADENS only Authenticate — its flow is interactive and
  cannot work while the entry is not registered
  (`src/components/settings/McpSection.tsx:155`, grep
  `disabled={testing || authenticating || isDisabled}`). Test is NOT deadened:
  `649b241a` dropped `isDisabled` from its predicate on purpose
  (`src/components/settings/McpSection.tsx:177`, grep
  `disabled={testing || authenticating}`), so clicking Test on an off row
  reaches the command and the row ANSWERS with the off sentence rather than
  refusing silently — arriving in the error badge's `title` while the visible
  badge text is the word `error`
  (`src/components/settings/McpSection.tsx:145`, grep
  `title={result.error}>error<`), the hover-only channel the other Settings
  sections use for an IPC error
  (`src/components/settings/WebSearchSection.tsx:86`,
  `src/components/settings/ProviderAuthSection.tsx:313`), so it is revealed on
  hover and not inline; Edit and Remove stay live. `entryToDraft` reads the key
  back as `entry.disabled === true`
  (`src/components/settings/McpSection.tsx:256`, grep
  `disabled: entry.disabled === true`) — mirroring `classify_server`'s
  `as_bool() == Some(true)`, so a malformed `"disabled": "yes"` still edits as
  ON. The list is still unfiltered
  (`src/components/settings/McpSection.tsx:488`, grep
  `Object.entries(settings.mcpServers)`): an off entry is listed and badged,
  not hidden. Switching a server off is a Settings click, not a hand-edit of
  `settings.json`.
- **A new or edited server takes effect for the NEXT session, not the running
  one.** `push_config_update` deliberately excludes `providers` and
  `mcp_servers` — the recorded "residual hole (both stay session-construction
  snapshots)" (`src-tauri/src/agent/session/router.rs:913-914`, grep
  `residual hole`) — and sends the three remaining fields
  (`router.rs:934-945`); crate-side, `apply_config_update` has no
  `mcp_servers` parameter that could receive it
  (`harness/loop.rs:1148-1155`). The reason is real rather than laziness: the
  desktop layer arrives by REBUILDING the manager
  (`harness/loop.rs:1111-1126`, which is safe only because it runs before any
  server has connected), so a push after connect would drop a live child. The
  wait IS disclosed — but for the OFF SWITCH ONLY, and inside the dialog, not at
  the point of save: the add/edit dialog's `<DialogDescription>` says
  "Switching a server off means Settings stops registering it; it takes effect
  for new sessions" (`src/components/settings/McpSection.tsx:328-334`, grep
  `takes effect`; `93073edc` reworded this copy from "the harness never
  registers it" — names locate, the numbers only date them, measured at
  `649b241a`), and that block renders while the dialog is still OPEN, i.e.
  BEFORE save. It is the only such sentence (`grep -c 'takes effect'` there is
  **1**) and it names only the switch, so a plain add or edit that never
  touches it gets no disclosure at all — `saveMcpServer`
  (`src/components/settings/SettingsPage.tsx:415-419`) raises no toast and no
  notice, it updates and closes. The section's OTHER session sentence,
  "Existing sessions are unaffected"
  (`src/components/settings/McpSection.tsx:207`, grep that sentence), is the
  REMOVE dialog's — a separate and narrower statement, true of the running
  Worker.
- **One `mcp({search})` is not cheap on a multi-server config.** `collect_tools`
  calls `list_tools` on **every** server before it answers, in a plain `for` loop
  that awaits each one in turn (`mcp/tool.rs:121-145`; the callers are
  `tool.rs:530`, `:576`, `:682`), and `list_tools` connects first
  (`mcp/manager.rs:292-298`) — so a five-stdio-server config spawns up to five
  children and waits for them serially. Each is bounded: `TIMEOUT` is
  `Duration::from_secs(60)` (`mcp/tool.rs:36`) and it is the stdio request bound,
  while an HTTP client IGNORES that argument and applies its own `read_timeout`
  (`mcp/manager.rs:41-52`), which `connect` built from the same value
  (`mcp/http.rs:63-66`, `:107`) as an idle-between-bytes bound and not a total
  one. Idle cost is near zero — connect is lazy and an untouched server spawns
  nothing (`mcp/manager.rs:1-4`).
- **A switched-off server is silently absent from the `#`-mention picker, and
  that is accepted.** `commands/mcp.rs` answers the picker with
  `server_infos(&load_servers(…))` (`src-tauri/src/commands/mcp.rs:34`),
  `load_servers` keeps only what
  `classify_server` accepts (`mcp/config.rs:50-56`), and `classify_server`
  answers `None` for `disabled: true` (`mcp/types.rs:278-282`) — so the switch
  removes the row with no note anywhere. And the drop is one-directional, with a
  user-visible consequence: because the merge is a later-`insert`-wins loop
  (`mcp/config.rs:50-56`) and a disabled entry is never `insert`ed at all, it
  SHADOWS nothing, so the lower-precedence GLOBAL layer shows through — switching
  a server off in Settings can leave a same-named server ON via
  `~/.pi/agent/mcp.json`, because Settings writes only the desktop layer (the
  crate pins exactly this in `load_servers_desktop_disabled_entries_are_dropped`
  (`mcp/config.rs:223`), whose comment calls a disabled entry "off", not
  "shadow", `:234-235`). A Space's `.pi/mcp.json` showing the same name is a
  DIFFERENT fact and NOT a consequence of the drop: that layer is LAST in
  `layers` (`mcp/config.rs:42-49`) and so the HIGHEST, so it overrides a
  same-named desktop entry whether or not that entry is switched off
  (`load_servers_project_overrides_desktop_by_name`, `mcp/config.rs:204`) —
  plain precedence, and the order the first bullet states.
  Related, and since `0cb795ff` no longer mis-reported — and since `649b241a`
  reachable from the row itself, because Test is not gated on the off state
  (the item above), though hover-revealed in that badge's `title` and not
  printed inline: `test_mcp_server` and `auth_mcp_server` answer a
  `disabled: true` entry with the off-state's OWN sentence — "this server is
  switched off — turn it on to test it" — from the `disabled_mcp_server_error`
  pre-check that runs BEFORE `classify_server`, at the top of BOTH commands
  (`src-tauri/src/commands/settings.rs`, grep-anchored:
  `disabled_mcp_server_error` `:222-231`, its `test_mcp_server` call site
  `:240-242`, its `auth_mcp_server` one `:256-258` — names locate, the numbers
  only date them, measured at `bac7b122`); it is a `SettingsError::Other`,
  which renders `{0}` bare
  (`src-tauri/src/agent/errors.rs:609-610`), so the sentence stands alone
  instead of inside "invalid MCP server entry (…)". `classify_server`'s `None`
  still covers THREE causes — off (`mcp/types.rs:280-282`), legacy `sse`
  (`:283-285`), neither a usable `url` nor a usable `command` (`:327`) — and
  the collapsed "need a `url` or a `command`" (the `ok_or_else` on
  `classify_server`'s `None`, in both commands — grep
  `SettingsError::InvalidMcpServer` in `settings.rs:243-245` and `:259-261`,
  measured at `bac7b122`) still covers the OTHER two: the legacy-`sse` entry
  and the genuinely-malformed one. The off cause is the one the pre-check took
  over.
  (The `#` trigger is itself off by default — `mcpMentionsEnabled`,
  `src/components/settings/GeneralSection.tsx:61-67`.)
- **`annotations` are discarded at the transport boundary.** `ToolInfo` is
  `name` / `description` / `input_schema` and nothing else
  (`mcp/types.rs:95-103`), and both `list_tools` parsers pick exactly those three
  keys and drop the rest of the entry (`mcp/stdio.rs:260-279`,
  `mcp/http.rs:321-340`). `grep -rn annotations` across the crate extract is
  **0** hits, and across this repo it is 5, every one of them unrelated UI prose
  about a message bubble's annotation bands
  (`src/components/MessageBubble.tsx:322`) — nothing reads the MCP field. The
  spec defines four hints, `readOnlyHint` / `destructiveHint` /
  `idempotentHint` / `openWorldHint`, and itself warns that a client MUST treat
  annotations as untrusted unless they come from a trusted server (the
  2025-06-18 tools spec at modelcontextprotocol.io), so what is on the table is
  a badge opportunity at most and never a gate.

## Two pointers the same loop recorded, so they are not re-derived

Not MCP defects — they moved here only because this file survives the ship that
deletes the roadmap family which recorded them.

**The web tools still owe option (b) of #82** (`open work`): narrow the handlers
to ONE param dialect (drop the camelCase acceptance) and fix the truncation notice
+ `details` key to say `response_id`. The interim shipped with T9 (`a9b2347`) — the
specs advertise exactly what the handlers read, so #78's unknown-param checker has
zero known false positives (an unknown top-level param is REJECTED, not warned, since
[ADR 0079](../decisions/0079-an-unknown-top-level-tool-parameter-rejects-the-call.md)) —
and the real fix wants a line in the ADR that owns the
web tools, which is why it was not folded into T9. **And `ask`'s nested
`recommended` is read by the handler but unadvertised** in `ask`'s nested
`items.properties` (small; fold into #82's area): #78's checker is top-level-only,
so it can never fire on a nested key and this stays invisible until the nested rule
lands — cheap to advertise when it does.
