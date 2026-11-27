---
status: current
last-verified: 2026-11-27
verified-by: >-
  Hybrid research — 3 dispatched angles (2 local-code across three trees, 1 web), 2026-11-27, plus
  the parent agent's own grounding before dispatch. Local claims re-verified by the parent after the
  angles returned: the daemon member's existence and size (`find fulcrum/src | wc -l` → 11 files /
  8,402 lines), `publish = false` at `fulcrum/Cargo.toml:22`, the absence of `transport/` and `db/`
  in the published 0.8.0 crate, `docs/roadmap/` being gitignored (`.gitignore:36`), the on-disk
  identity of ADRs 0092/0093, the exit-reap arm at `src-tauri/src/lib.rs:767`/`:789`, the `--worker`
  arm at `src-tauri/src/main.rs:5-10`, `d4b4995b` touching neither `Cargo.toml` nor `Cargo.lock`,
  `140a342a` at 24 files / +1,649, and `agent_overrides` being the only `Settings` field read at
  `launch.rs:121` in the compiled crate. Web: 30+ primary sources (VS Code, Cline, Codex, Zed, ACP,
  LSP, gopls, tmux, Emacs, systemd, launchd, Tauri).
task: tsk_bcc7a618-d613-439a-a943-c5a901cbcfed
adr: docs/decisions/0122-the-client-is-the-supervisor-the-engine-is-a-pure-core.md
---

# The Client is the Supervisor, the engine is a pure core

Research question: *Is the engine's ownership boundary — a crate that owns `Settings` and a separate
`fulcrum serve` daemon — justified by a capability the desktop cannot provide, or is it residue from a
standalone-daemon plan the owner now rejects?*

Depth: standard (three angles — the daemon's capability inventory and momentum; the measured cost of
the split and of undoing it; external practice in comparable agent/IDE/daemon systems).

Three trees are cited and must not be conflated. **`[A]`** = `/home/daniel/Coding/Archimedes/archimedes`
(the desktop, HEAD `5d07b092`). **`[F]`** = `/home/daniel/Coding/Archimedes/fulcrum` (the engine repo,
HEAD `7b55e53`, both manifests at 0.8.0, clean tree). **`[R]`** = the **published** crate at
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fulcrum-harness-0.8.0/` — **what the desktop
actually compiles against** (per `AGENTS.md`, the desktop does not build from the sibling checkout).

---

## Executive summary

1. **The card's premise is false, and this repo already recorded the correction.** `fulcrum-daemon` was
   built. Package `fulcrum-harness-daemon` (lib+bin `fulcrum`), 11 files / 8,402 lines, 128 tests, shipped
   in fulcrum PR #2 (squash `38a9986`, 2026-11-06). `[A]docs/roadmap/fulcrum-harness-status.md:888`
   already reads *"⚠ WAVE 9 (T9) HAS ALREADY SHIPPED… Do not implement T9."* The daemon is not the residue
   of an abandoned idea — it is the one realised part of the T1–T15 program.
2. **ADR 0091's justification therefore stands, but its settings half is over-broad by a factor of 24.**
   The crate reads exactly **one of `Settings`'s 24 fields** (`agent_overrides`), at two production sites,
   and one of them builds a synthetic `Settings` from nothing but the map — the crate's own code proves the
   narrower input suffices.
3. **The owner's thesis splits, and the evidence splits with it.** "The engine should be a core where the
   loop and tools live, so the app supplies settings" is **supported** — it is the direction ADR 0102
   shipped, it is the shape `DesktopConfig` and `ProviderSource` already take, and Cline's `@cline/agents`
   ships it externally. "The app should be the daemon" is **already true in the glossary** and the contested
   remainder is only whether a *second* host may exist.
4. **On capabilities, app-as-daemon loses on two of eleven, structurally.** Surviving its own death, and
   version skew. The other nine are policy unwired, not architecture blocked.
5. **External practice: nobody ships durable local sessions with the loop inside the GUI process — but the
   dominant compromise is one binary, N modes, daemon optional with embedded fallback**, which is
   compatible with the owner's collapse.
6. **The settings symptom is real, cheap, and independent of the daemon question.** 13 crates.io pin moves
   and 14 hand-run irreversible publishes in 18 days. But ADR 0102 already deleted the *tool* half of that
   friction, and the harder remaining gate is `WebSettings`, not `Settings`.

---

## Findings

### Q1 — What does a separate daemon process actually deliver?

| Capability | Needs a separate process? | Evidence |
|---|---|---|
| Session outlives a Client **quit** | **No** | `[A]src-tauri/src/lib.rs:767` `if let tauri::RunEvent::Exit` → `:789 rt.block_on(wm.reap_all())` is one arm of `run_event_callback`. The daemon's equivalent is already proven behaviour in `[F]fulcrum/tests/serve.rs:1447 a_client_that_vanishes_mid_turn_leaves_the_session_running_and_persisting` |
| Session outlives the Client's **crash / OOM-kill / panic** | **Yes — structural** | `[A]src-tauri/src/lib.rs:376-382`: *"a Supervisor panic STILL kills the app (it IS the app — the `release` profile's `panic = "unwind"` only protects the WORKERS)"*. ADR 0025 isolates Workers from each other, never the Supervisor from itself |
| Independent engine upgrade / version skew | **Yes — structural** | `[F]fulcrum/Cargo.toml:25-31` states the guarantee *"a path dependency inside one workspace cannot be built in two versions at once"*; `[A]src-tauri/Cargo.toml:145` is a crates.io version pin. One binary = one engine version |
| Gates park durably, answerable after restart | **Neither shape has it** | `pending_gates` = **0 occurrences** in `[F]fulcrum/src/db/schema.rs` (4 tables, asserted at `:492`); `handle_frame` accepts only `hello`/`start`/`prompt`/`close` (`serve.rs:2345-2357`); `[R]src/permission.rs:277` awaits with *"NO DEADLINE"* (a 300 s cap was deliberately removed) |
| `fulcrum.db` authoritative store | No | The desktop already owns `archimedes.db` with identical WAL pragmas (`[A]src-tauri/src/storage/db/mod.rs:633-638` vs `[F]fulcrum/src/db/mod.rs:28`). The spec itself scopes sole-writer *"per database"* |
| Restart discovery / rehydrate over the wire | No, mechanically | `[F]fulcrum/src/db/mod.rs:826 list_sessions`, `:880 messages_for` exist; **no frame exposes them** (0 hits for `attach`/`list-sessions`/`afterSeq` in `serve.rs`) |
| Remote `wss://`, no desktop running | Yes, weakly | `[F]fulcrum/src/transport/mod.rs:92-97` — `Endpoint` is `Socket(PathBuf) \| Pipe(String)`, **no TCP**; 0 hits for `TcpListener`/`wss://`. The daemon member has zero `tauri` code references, and `[F]fulcrum/tests/boundary.rs:1171` forbids the UI framework |
| Config transfer from Settings | No | The spec's own correction (`fulcrum-harness-status.md:928-932`): *"`StartEnv` already carries all five fields… **No config-push work is needed**"* |
| Orphan-safe spawn + a Stop control | Identical work either way — **and it exists nowhere**: `setsid` = **0 occurrences** in engine and daemon source (only prose at `[R]src/tools/exec/bash.rs:504`). What exists is the daemon→**Worker** group (`[R]src/worker/client.rs:440 setpgid`, `childproc.rs:225-235 kill(-pgid)`), which isolates a tool tree with its Worker; it is not host orphan-safety |
| Idle reaper + `NotificationSink` | No | 0 hits in `[F]fulcrum/src/`. The desktop has the pieces the daemon **lacks**: `[A]src-tauri/src/attention.rs` (Rust-side because a backgrounded webview is throttled), `agent/retention.rs` |
| `abort` — stop a turn, keep the session | Topology-independent, absent in both | `close` → `manager.detach` (`serve.rs:2599`) **ends** the session; `[R]src/worker/protocol.rs:141 Abort` already exists as a variant |

**A fact that constrains every option.** The desktop **cannot consume the daemon as a crate today**:
`publish = false` at `[F]fulcrum/Cargo.toml:22`, and the published `[R]src/` contains **no `transport/` and
no `db/`**. The only routes to the daemon are (a) a sidecar binary — T12, unbuilt, `externalBin` absent from
`tauri.conf.json`, `fulcrum-harness-daemon` absent from `[A]Cargo.lock` — or (b) copying transport + db into
the desktop, which is a **fork** of the store, not a dependency, because `rusqlite` is legal in the daemon and
forbidden in the engine by ADR 0091.

**Nothing suspected of blocking the desktop-as-host actually blocks it.** `--worker` is already dispatched
**before** Tauri init (`[A]src-tauri/src/main.rs:5-10`, *"the Tauri runtime never starts in a Worker"*), and
`[F]fulcrum/src/main.rs:16-18` says the daemon's shape is the same trick — *"The desktop already ships this
shape"*. So a `serve` arm is one more `match` arm in the same place. `AppHandle` has 53 mentions / 15 files
but every hard use has a no-handle arm already (`agent/session/router.rs:280-310` answers
`"Supervisor AppHandle not available"`; `TauriSink` is `AppHandle::emit` and the daemon has `FanOutSink` at
`serve.rs:1416-1425`). The Supervisor core is **already driven headless** in `[A]src-tauri/tests/ipc.rs`
(`tauri::test::MockRuntime`). `load_settings` is `std::fs` + serde and `config.rs` names `tauri` once, in a
doc comment. The one genuinely blocking feature is the webview render round-trip
(`agent/web/render.rs:128-160`), already ruled desktop-side.

### Q1b — Shipped vs promised, and momentum

**T9 shipped. T10–T15 have zero code in any branch or PR in either repo.** All four legs of
`durable-sessions.md`'s `done-when` are missing (list over the wire, rehydrate over the wire, answer a parked
prompt, Stop). `[A]` issue #163 states it: *"nothing here is testable end-to-end until [#8] lands."*
`gh pr list --repo archimedes-codes/fulcrum --state open` → **empty**; the 15 most recent merged PRs are all
engine-side.

**Substantive daemon work stopped 2026-11-07** (`26d7648`, PR #10 hardening: `serve.rs +1289/−200`,
`transport/* +968`, tests +2353). Everything touching `fulcrum/` since is a rename (`12488ee`, `9aee743`),
`publish = false` (`5b91212`), docs (`3d0381b`), or a 1–11 line engine ride (`0fdddf1` +11, `5573060` +3,
`7b55e53` 103:67). `de074b9` changed **no production code**. The daemon's open issues (#7, #8) have had no
activity since the day they were filed (2026-11-06).

**The desktop is moving in the opposite direction.** 126 commits since 2026-11-01, none mentioning durable
sessions, the daemon, Hosts, or supervision. The last merged PRs are #222 (`mark_done` host verb), **#220
"the Client owns the 7 board verbs; the crate's Tasks are gone" (ADR 0102)**, #219, #218, #217. ADR 0121 is
titled *"a Search provider is Host-tool territory and the `search_providers` seam is rejected"*. Capability is
being pulled **into** the app and the crate narrowed to loop + tools — the owner's thesis, executing, one PR at
a time. The daemon is documented as the deployment that receives features **later, by decision**:
`[A]docs/features/supervisor-log-diagnostics.md:256` *"`fulcrum serve` arms **neither** channel"*.

### Q2 — What the split costs, and what undoing it costs

**Cost of the status quo, measured** (`git log -- src-tauri/Cargo.toml`, 2026-10-29 → 2026-11-26):

| Measure | Value |
|---|---|
| Desktop commits in window | 144 |
| …touching `src-tauri/Cargo.toml` | 36 |
| …with a real engine-dependency line change | **13** (`18592d0a`→0.1.0 … `adec7dbe`→0.8.0) |
| fulcrum tags in window | **14** (`v0.1.0` 11-08 → `v0.8.0` 11-25) |
| Each requiring a hand-run, irreversible `cargo publish` | **all of them** |

The ceremony for **one** engine-side change is 9 steps across two repos. `[F]AGENTS.md:345-354`: *"a version
requirement can only match a published version."* `[F]AGENTS.md:382-388`: *"that name is burned permanently —
crates.io supports neither rename nor delete."* Publishing is never automated (`release.yml` publishes a
GitHub release *"and nothing else"*). Absorbing 0.7.0 cost **24 desktop files / +1,649 lines** (`140a342a`).

**How much ADR 0102 already removed** — the answer is "the tool half, entirely":

| Change class | Crate release? | Evidence |
|---|---|---|
| Add a tool / a new Search provider as a host verb | **No** — ~6 desktop files | ADR 0121 prices it: Keenable = *"two repos, two commits, ten crate files, one irreversible `cargo publish`, and a pin bump"*; `mark_done` = *"one commit, one repo, zero crate files"*. Verified: `git show d4b4995b -- src-tauri/Cargo.toml src-tauri/Cargo.lock` → **empty** |
| Display-only setting (`theme`, `palette`, `paneLayout`, `font`, `spinnerStyle`, `emptyStateAnimation`, `mcpMentionsEnabled`, `attentionAlerts*`) | **No** | These 10 fields have **zero Rust readers in either repo**; `get_settings`/`save_settings` pass the whole document (`[A]src/commands/settings.rs:21-25,45-52`) |
| New session-construction or live-reload value | **No, if additive** | `StartEnv`'s `Option` + `#[serde(default)]` + builder template, proven 4× (`permission`, `cost_usd`, `diagnostics_dir`, the five `DesktopConfig` fields); `config-update`'s 3 fields are all `Option` and unknown keys are ignored |
| **A new `Settings` field the crate must read** | **Yes** | The struct lives in `[R]src/config_types.rs:265`; no `#[non_exhaustive]` anywhere in the crate |
| **A new `WebSettings` key** | **Yes — and it forces a MINOR** | Fulcrum `477d3d4`: *"the `WebSettings` field is BREAKING for source"*. **This, not `Settings`, is the hardest gate in the set** |
| **A new `ProviderConfig` field** | **Yes** | 21 full literals across both trees |
| The failover ladder / `defaultProvider` vocabulary | **Yes regardless** | `AVAILABILITY_ORDER`/`SEARCH_PROVIDERS` are crate consts; `WebConfig::from_web_settings` filters an unlisted provider to `"auto"` |
| A "this provider is paid" attribute | **Yes regardless** | ADR 0121's accepted cost — `SearchProvider` exposes only `id`/`name`/`is_available()` |

**The FLOOR — types the crate must own for reasons unrelated to the daemon:** `StartEnv` (it *is* the `start`
frame, `[R]src/worker/protocol.rs:78-79`), `DesktopConfig` (`harness/loop.rs:1094`), `FilePolicy` (the gate
judges on it, `harness/loop/gate.rs:425-427`), `WebSettings` (`harness/loop.rs:415`), `ProviderConfig`
(`harness/provider/mod.rs:571`, `provider_auth/budget.rs:605-608`), `AgentOverrideFields`
(`harness/launch.rs:121`), `OidcConfig` (transitively, as `ProviderConfig.oidc`), `ToolCtx`/`ToolSpec` (the
frozen-gate invariant), and the row types behind `FulcrumPersistence`. **`Settings` itself has a floor of one
field.** `FontSettings` is in the crate only because `Settings.font` is `pub` — 7 hits, all in
`config_types.rs`, zero readers.

**Migration surface if the settings boundary is redrawn:** 23 `pub use fulcrum_harness::…` statements in 12
files; 126 named symbols plus module aliases; **222 alias-resolved references across 67 files**; 27 files in
`src-tauri/src` and 8 in `src-tauri/tests` naming `fulcrum_harness::` directly. The desktop's own inline claims
of *"~40 sites"* for `ProviderConfig` and *"20 call sites"* for `WebSettings` (`config.rs:38-40,57-58`) **do
not reproduce** and should be treated as stale.

**The precedent exists, twice, in this codebase.** `DesktopConfig` (`[R]src/worker_types.rs:413`) is **5
fields carved from `Settings`'s 24**, applied by builder (`with_desktop_config`) precisely because a positional
parameter *"would break EVERY call site in BOTH repos"*, with one propagation function (`from_env`) so a
forgotten field cannot silently freeze a knob. `ProviderSource` is the sharper precedent: T7 found
`budget.rs` reading `settings.json` **on every 15 s poll tick**, and the fix deleted the poller's `config_dir`
field entirely — *"[the] crate holds no settings directory at all… so the poller cannot ask for the file even
by accident"* (`[R]src/seams.rs:42-62`). That is the owner's thesis, executed once, already shipped.

**Two anti-patterns already rejected in writing**, which any fix must avoid: a trait the crate does not call
(`seams.rs:13-23`, *"a trait with no caller has no runtime behaviour to test"* — two tasks cancelled on that
ground), and a seam populated by nobody (ADR 0102's *"Registry as an appendix"*, *"that is the weak-pin shape
`seams.rs` documents at length"*).

**Split-created overhead: 9 duplicated guards** across the two repos — childproc invariant A (`[R]src/childproc.rs`
+ `[A]src-tauri/tests/childproc_census.rs`); the whole source-scan harness (`strip_comments`,
`strip_string_literals`, `needle`, both vacuity proofs) duplicated in `[R]src/boundary_pins.rs` and
`[F]fulcrum/tests/boundary.rs`; the no-SQLite-driver, no-UI-framework and no-foreign-module pins asserted from
**both** sides of the same bytes; two unrelated `scripts/check-versions.sh` (3 files vs 2 manifests); and a
hand-copied schema fingerprint.

### Q3 — What comparable systems do

**The strongest external data point splits the thesis the same way.** Cline's Hub-Spoke architecture
([docs](https://docs.cline.bot/sdk/architecture/hub-spoke.md)) states the case for a daemon in the
counter-position's words — *"Sessions that survive when a window closes or the CLI exits; Multiple clients
viewing and controlling the same session; Process isolation so a runaway agent doesn't freeze the UI"* — and
assigns the roles: *"Hub: singleton daemon per machine… **Does not run the agent loop**. Spoke: executes the
agent loop… Owned by the daemon, not by any client."* Its package layering is the owner's pure-core, shipped:
`@cline/agents` *"does not own session storage, built-in file/shell tools, hub transports, or Node-specific
orchestration"*, and *"Dependencies flow downward only. Lower layers stay embeddable without pulling in the
full runtime."* But it also keeps `backendMode: "local"` for *"environments where a background process isn't
appropriate."*

**VS Code** ([Agent Host blog, 2026-08-26](https://code.visualstudio.com/blogs/2026-08-26/agent-host-architecture);
[Agent Host architecture docs](https://code.visualstudio.com/docs/agents/concepts/agent-host)) moved *from* the
owner's shape — *"it also ties the agent runtime to one VS Code window. Closing that window stops the runtime"*
— to a dedicated host, and lists the motivations the counter-position argues. **But for the local case the host
is a GUI-supervised utility process and the docs say "keep the application running."** Three tiers, GUI demoted
to client, durability withheld locally. Their AHP doctrine is directly relevant to parked gates: *"The host is
the source of truth… If the connection drops, the client reconnects and receives missed actions or a fresh
snapshot."*

**Codex** ([app-server docs](https://developers.openai.com/codex/app-server);
[app-server-daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)) is
one binary in four shapes — embedded, stdio `app-server`, `--listen ws://`/`unix://`, and a detached pidfile
daemon *"used by remote clients such as the desktop and mobile apps"* — with **documented embedded fallback**:
*"If an implicitly discovered daemon cannot initialize the connection, the TUI starts an embedded server
instead."* Its `core` is **not** settings-free (it depends on `codex-config`, `codex-login`,
`codex-thread-store`) — a real counter-example to "the core owns no settings".

**Zed** ([Agent docs](https://zed.dev/docs/ai/zed-agent),
[`crates/agent/src/agent.rs` @ `e4fa1642…`](https://github.com/zed-industries/zed/blob/e4fa16422543ab77b129d7f4ad825630b993ecdd/crates/agent/src/agent.rs))
runs its native agent **in-process**, coupled to Zed's own `Settings`; its only daemon is the *remote* server
(proxy mode, reconnect-after-drop). Split by machine, not by durability.

**ACP**, the standard in this space, assumes the owner's topology: *"Agents are programs that use generative
AI to autonomously modify code. **They typically run as subprocesses of the Client.**"*
([Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options)) puts config
ownership with the **agent**, exposing `configOptions` the client may mutate, with the degradation rule
*"Agents MUST be able to operate with it, even if the Client doesn't support configuration options."*

**gopls** added a daemon *to* the sidecar model, with the cost stated
([daemon.md](https://github.com/golang/tools/blob/master/gopls/doc/daemon.md)): *"a command that uses the
daemon shares the cache, the memory, and **the fate of all other clients of that daemon**, which may include
your editor"* — and mitigates with **idle-exit after one minute with no clients**.

**tmux / Emacs** are the canonical one-binary shapes. tmux documents two costs directly: the server's
environment is whoever started it (hence `update-environment[]`), and version skew requires `kill-server`,
destroying all sessions. Emacs documents all three lifecycles in one manual section, including the owner's
proposal **with its cost stated**: *"Run the command `server-start` in an existing Emacs process… when you exit
Emacs, the server dies with the Emacs process."*

**Durability in this market comes from a server-side runner** (Cursor Cloud Agents — *"you can close your
laptop and check the result later"*; Claude Code cloud; Codex Cloud; GitHub Copilot coding agent; Devin; Cline
Cloud) **or a detached local process the GUI does not own** (Cline hub, OpenCode's background service, Codex's
daemon, Zed's remote server, Claude Code's SSH *"background helper"*). **No shipped system was found that
claims local sessions survive the GUI app being quit while the loop runs inside the GUI process.** The nearest
thing to a postmortem is Claude Code's SSH caveat — survival works, **re-attachment is the fragile part**:
*"the task keeps running, but you lose it when the session opens again unless Desktop can rejoin its process."*

**Platform mechanics for whichever host is chosen.** macOS: `AbandonProcessGroup`
([`launchd.plist(5)`](https://www.manpagez.com/man/5/launchd.plist/)) is the documented key when a job's
process group must outlive it; per-user agents get `SIGTERM` at logout. Linux: `KillUserProcesses=yes` *"will
break tools like `screen(1)` and `tmux(1)`, unless they are moved out of the session scope"*
([`logind.conf(5)`](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html)) — surviving
*logout* needs linger or a user unit, surviving *app quit* generally does not. Windows: a job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills the tree unless breakaway is requested
([Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)). Tauri: the sidecar
contract is *"you are also in charge of killing the child process when your app closes; otherwise, you pollute
the users' machine with orphan processes"*, kill-on-exit behaviour has differed by version
([#1896](https://github.com/tauri-apps/tauri/issues/1896)), and grandchild orphaning is still open
([#14360](https://github.com/tauri-apps/tauri/issues/14360)) — which is exactly the `app --worker` grandchild
case.

---

## Evidence and credibility

Local claims were read from three trees and labelled; the parent re-verified the load-bearing ones directly
after the angles returned (see `verified-by`). The engine repo and the published crate agree at 0.8.0 today,
but they are separate sources and both were read. Web sources are official docs and primary source code with
permalinks; one GitHub permalink was verified reachable at a concrete SHA (Zed `e4fa1642…`). Secondary
third-party summaries were used only for Cursor's local-agent topology and are marked as such.

## Unresolved contradictions

1. **The spec that opposes the owner's thesis is untracked working-tree material whose ADRs collide with
   different ADRs on `main`.** `.gitignore:36` is `docs/roadmap/`, so `durable-sessions.md`,
   `fulcrum-harness.md` and `fulcrum-harness-status.md` have no commit history, no stash and no dangling blob.
   And `[A]docs/decisions/0092-*.md` is *"Task tools are native tools over a `TaskStore` seam"* and `0093` is
   *"the per-session todo surface is renamed to checklist"* — the **durable-sessions** 0092/0093 exist only on
   the unmerged branch `docs/durable-sessions-decisions` (`bf952ce5`, not an ancestor of `main`). **This does
   not mean the approval is fake** — the status file records owner approval at a Step 0 gate, and that intent
   is real. It means the durable record does not exist, and any argument resting on "ADRs 0092/0093 say X" is
   resting on files that say something else on the trunk.
2. **The glossary contradicts that spec and agrees with the owner.** `[A]CONTEXT.md:8` defines the **Client**
   as *"the **Supervisor**"*; `:82` lists **daemon** under `_Avoid_`. The spec's central term, **Host**, is
   **absent from `CONTEXT.md` entirely**.
3. **`[F]fulcrum/src/db/schema.rs:34-35` asserts something false at HEAD** — *"The desktop runs the SAME
   comparator in its own CI… a DDL change THERE reddens the desktop"* — while `[F]AGENTS.md:48-51,223` states
   correctly that *"the cross-repo half is not yet wired"* and *"the leg is absent, not refusing."* Verified:
   `[A]scripts/` has no comparator and `[A].github/workflows/` holds only `ci.yml` and `release.yml`. Fulcrum
   issue #6's acceptance criterion 1 is unmet.
4. **ADR 0091 is right in direction and over-broad in degree.** "The crate may not name a desktop module" is
   sound, and its stated justification (a daemon will link the crate) is realised. But the crate's need for
   `Settings` is one field, so the boundary as drawn is 24× wider than the requirement. Both are true; see
   ADR 0122, which narrows the settings half and leaves the disk half standing.

## Gaps

- **No user signal on durability.** No issue, report, or request for "sessions survive quitting the app"
  exists outside the epic itself. This is the *only* capability the app-as-Supervisor cannot provide, so the
  decision turns on a demand that has never been measured. **Next step for a later session: establish it
  before planning anything that touches supervision.**
- **"The app should be the daemon" is still ambiguous in a way that changes the answer.** Three distinct
  readings, with different costs: (a) *ownership only* — the app owns the settings types, the crate narrows its
  seam; (b) *a headless `--serve` mode on the desktop binary* — the tmux/Emacs shape, one binary N modes, which
  the `--worker` arm shows is mechanically cheap; (c) *the app as the only host, ever* — which forecloses
  remote and crash-survival permanently. **A later session planning from this report must resolve which one the
  owner means, first.**
- **Whether this subsumes board card #47** ("No way to add a tool without a desktop release"). ADR 0102 +
  ADR 0121 + `d4b4995b` suggest #47 is **already largely resolved** and should be re-checked against the tree
  rather than assumed open.
- Two enforcement holes found in passing, both load-bearing and neither owned by this card: a definition's
  `permission:` block naming a **host** tool is parsed, retained as `ToolKey::Unrecognized`, announced and
  **never enforced** (so `specstream_search: deny` is a silent no-op), and `narrow` cannot filter host verbs at
  all because `harness/launch.rs` filters `tools:` against the 19 engine specs. These are board cards #45 and
  #46; this report only confirms they are still open at 0.8.0.
- Whether any comparable system runs the arrangement "the daemon owns the single SQLite file the app also
  wants", and how it resolves write contention. Not found.

**Handoff:** the decision taken is recorded in
`docs/decisions/0122-the-client-is-the-supervisor-the-engine-is-a-pure-core.md`. A session started from this
card should read that ADR first, resolve Gap 2 (which of the three readings is meant), and settle Gap 1 (is
durability wanted) before planning any change to supervision or to the settings boundary.
