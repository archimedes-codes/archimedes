---
status: accepted
date: 2026-10-04
superseded-by:
---

# Sessions run in Worker processes — the desktop is a pure Supervisor

The native harness (ADR 0011/0022) ran every session — main and subagent — as `tokio::spawn` tasks in the single Tauri app process, with `panic = "abort"` in the release profile: a Rust panic in ANY task aborts the whole app (observed 2026-10-03: a panic during an 8-subagent fan-out killed the app, with zero logging to diagnose it). **Decision: every session runs in its own child OS process (a Worker process) — one binary, self-exec `archimedes --worker` — running the existing `AgentLoop` unchanged over a stdio JSONL protocol; the Tauri app process becomes the Supervisor: UI + worker lifecycle + sole SQLite writer (persisting from the event stream) + the response side of the permission/interactive gates.** A Worker crash degrades to a *stalled* (resumable) session or a `SubagentOutcome::Failed` tool error — never an app death. `panic = "abort"` is retired (→ `unwind`), and both processes get panic hooks writing `~/.local/share/archimedes/crash-<ts>-<tag>-<pid>.log` — the name shape, the injected directory and the retention rule are spelled out under *Amendment (2026-10-18)* at the end; the original `crash-<ts>-<tag>.log` form stands as written for the 14 days it shipped.

ADR 0022 stands: the Worker is the desktop's OWN binary running the OWN harness — no external pi process comes back (the pi-archimedes repo stays dead). ADR 0020 is unaffected (Agent definitions still resolve; the child just runs in a Worker).

## Considered Options

- **A — Task-level containment only (rejected as the answer, adopted as a complement).** `panic = "unwind"` + `catch_unwind` around session tasks + a crash-logging panic hook, keeping one process. Rejected as the *answer*: it contains the panic but not the memory — a leaky or wedged session still takes the UI down, and there is no per-session resource boundary. The containment pieces are still adopted (a Worker panic stays in the Worker; both processes log crashes).
- **B — Subagents out, main session stays in-process (rejected).** The main session is the interactive one — its panics would still kill the app, and the app would still die from a leak in the session the user is typing into. Rejected: the user chose full isolation (a harness's UI must be leak-proof).
- **C — Chosen: everything out — the desktop is a pure Supervisor.** Every session (main + subagent) in its own Worker process. Accepted costs: the session driver, resume, config options, and the interactive/permission round-trips all cross IPC (µs per line — not a practical latency risk); the in-process native driver is deleted (no dual-mode fallback — a Worker spawn failure is a visible session error with retry).

## Consequences

- **The throwaway-DB machinery is deleted** (`open_throwaway_db`, `TempFileGuard`, the FK dance) — the Worker has no DB at all (its `SessionStore` is a no-op; the conversation is in-memory). The Supervisor persists ALL transcripts from the event stream, including **subagent transcripts as hidden ephemeral session rows** (never archived, hidden from Space lists, inspectable in a debug view — previously discarded, which is why a 32-minute subagent's work was un-inspectable after the fact).
- **Resume re-hydrates via the Supervisor**: the Supervisor reads `native_messages` and sends the transcript in the `start` envelope (the re-read moves from harness to Supervisor; the resume *semantics* are unchanged).
- **The permission gate and interactive channel cross the boundary**: the Worker's request side sends `permission-request` / `interactive-request` IPC; the Supervisor relays to the existing Tauri events (the **frontend is unchanged**) and forwards the user's answer back. The trust flag travels in the envelope + `config` updates; `sudo_exec` executes in the Worker (the password lives in the Worker's memory for the session, replacing the desktop-side `CachedPassword` — same trust boundary: same machine, same user).
- **A new UI state: the Stalled session** — a session whose Worker died: transcript intact (persisted as events arrived), last turn incomplete (no `agent_settled` = incomplete), a banner with a Resume action (fresh Worker + re-hydrate).
- **The UI process is I/O-bound only** — a CPU-heavy subagent can no longer starve the UI; N parallel sessions are parallel at the OS level, not the thread level.
- **`panic = "abort"` is retired from the release profile** (→ `unwind`) — the release binary grows (unwind tables) and a Worker panic is contained to the Worker; both processes get crash-logging panic hooks (the app's first logging of any kind).
- **Cross-platform**: process-group kill = `setpgid` (unix) / job objects (Windows) — the same treatment the existing `RealSudoRunner` has.
- **Rollback is a git revert of the feature** — the in-process driver comes back; the crash-logging/`unwind` profile changes are kept either way (they are strictly an improvement).

## Amendment (2026-10-18) — the crash log's directory is injected, its name carries the pid, and it is pruned

**What changed is the crash-log contract only** — where the hook writes, what it names the file, and how long the files live. The architecture above stands unchanged: Worker-per-session, `unwind`, a Stalled session on a Worker death, crash logging as the app's first logging of any kind. This ADR is NOT superseded.

Three defects in the Task-2 hook (`src/agent/crashlog.rs`) were found from a real crash log, and all three are the same mistake seen three times: the hook resolved its own surroundings at panic time.

- **The directory was resolved DURING the panic.** `write_crash_log` called `dirs::data_dir()` on the panic path, so *whatever closure happened to be in the process-global hook slot* decided where the file went — and the slot is shared by every thread of the `--lib` test suite, which runs as threads of one process. While `install_panic_hook_is_idempotent` held the slot with the production hook (it had to, to prove the `Once`), a panic on any other test's thread wrote into the user's real data dir. Observed: 862 crash logs in `~/.local/share/archimedes/`, **every one** with `tests::` in its backtrace and not one a real crash. The first fix (`9035d9d`) serialised the two tests on a mutex, which lowered the odds and changed nothing about reachability — the hole was only shut once the hook could not resolve a directory at all (below).
- **Nothing was ever deleted.** 862 files / 11 MB accumulated. `debuglog` rotates at 5 MB; `crashlog` had no policy at all.
- **Attribution was recency, not identity.** `find_newest_crash_log()` (also deleted — it resolved the dir itself, so no temp-dir test could reach it) took the newest `crash-*-worker.log` by mtime, so with N concurrent subagent Workers the Stalled banner could name a *different Worker's* crash. The name itself made that worse: two Workers crashing in the same millisecond collide on `crash-<ts>-worker.log` and one panic silently overwrites another.

**Decision: the hook is handed its directory and never resolves one.** `install_panic_hook(tag, dir)` captures the dir in the closure it installs (`hook_closure`) at install time — once, on the main thread, before any other thread of either binary runs app code: in the Worker a multi-thread runtime already exists by then, but no thread of it is running our code yet. `write_crash_log` (the only `dirs::data_dir()` resolver in the panic path) is DELETED, so nothing on that path resolves anything. `install_panic_hook` also keeps the chain to the previous hook (`take_hook`, called after the log — this std has no `default_hook`); `hook_closure` is deliberately chaining-free and holds no `Once`, which is what lets a test install a crash-writing hook without consuming the single-use `install_panic_hook` `Once` — and that is why the chain has exactly one possible home. The two production sites (`lib.rs`'s `run()` and `worker/mod.rs`'s `run_worker_inner()`) each resolve `dirs::data_dir().join("archimedes")` themselves and skip installing the hook when it is `None` — a `None` data dir is not a supported state (`setup()` hard-fails on it), so that skip is belt-and-braces, not a mode. A test that wants a crash dir passes a temp dir and the user's path is then never named in that process.

**The writer has two names because the hook's argument is unconstructible.** `write_crash(dir, tag, payload, location)` (private) is the writer; `write_crash_log_from_info(&dir, tag, info)` is a thin adapter over it that only decodes the `PanicHookInfo` into plain strings. That is not a redundancy a later edit may collapse: `PanicHookInfo::new` is `pub(crate)` and its fields are private (`error[E0451]`), so no test can build the hook's argument — the adapter is reachable ONLY from inside a live hook, and `write_crash` is the sole way to hand the writer a payload, a location and a directory directly. Every name, content and prune-ordering assertion in `crashlog.rs` rides through it; the two hook-path tests install their own closure — one of them `hook_closure` itself — rather than `install_panic_hook`. The old "a `None` base is a no-op that never panics" posture went with the resolver that needed it: the adapter takes the caller's `dir` and has no base left to fail to resolve.

**Decision: the name carries the pid.** `crash-<ts>-<tag>-<pid>.log` (`write_crash` stamps `std::process::id()` into the name — the writing process stamps itself, so the Supervisor's own log has the same shape as a Worker's). `WorkerHandle::pid()` reads a field captured in `spawn()` — deliberately NOT `child.lock().await.id()` at crash time, because tokio returns `None` for an already-reaped child, which is exactly the state a crash leaves behind. `on_crash` widens to `(session_id, code, pid)` — as the alias `type OnCrash = Arc<dyn Fn(String, Option<i32>, Option<u32>) + Send + Sync>`, which exists for `clippy::type_complexity` exactly like the `CwdRegistrar`/`SinkLookup` aliases beside it, and is NOT an `#[allow]` in disguise (the lint is a build failure under `-D warnings`). The router selects the file BY NAME (`find_crash_log_for_pid(dir, pid)`), falling back to the newest pid-less `crash-*-worker.log` only when the pid is `None` — i.e. identity is used whenever it is knowable, and recency only when it is not. `router.rs`'s `session-stalled` emit also stops re-globbing and reuses the path it froze into the registry, so the pushed event and the pulled `stalled_info` can no longer name different files for one crash.

**Decision: retention is enforced in the hook, after a successful write** — `MAX_CRASH_LOG_AGE_DAYS` = 30 days and `MAX_CRASH_LOG_FILES` = 50 files, oldest-first, in `prune_crash_logs` (private; driven through `write_crash`), which is called ONLY after `fs::write` returned `Ok` — a write that failed has spent nothing, and on a full disk this crash is worth more than the history. Best-effort by construction (every fallible call is swallowed: pruning must never turn a logged crash into a lost log or a second panic). mtime is the only clock, and an age that cannot be computed — no metadata, or an mtime in the FUTURE — means KEEP: clock skew must never delete history. The prune pattern is deliberately `crash-*.log`, wider than the `crash-*-worker.log` the attribution code matches — the pid suffix means a narrow pattern would spare exactly the files worth deleting — while still sparing `debuglog`'s `supervisor.log` / `supervisor.log.old`, which sit in the same directory.

**Decision: the router is handed the crash dir too.** `find_crash_log_for_pid` takes `&Path` and the `SessionManager` carries it as the late-wired `crash_log_dir` (`Arc<OnceLock<PathBuf>>`, set by `pub fn set_crash_log_dir(&self, dir)` beside the existing `attach_app_handle`-shaped setters — `&self`, because the manager is behind an `Arc` by the time `lib.rs` wires it), and `dirs` is gone from `router.rs` entirely. Production is unaffected: `setup_dirs_with_factory` passes the `app_data_dir` it already computes, byte-identical to the `dirs::data_dir().join("archimedes")` the router used to build for itself. The gain is that the selector is testable over a temp dir at all — a self-resolved path is unreachable from one, and a crash-log dir resolved deep in a call chain is the same shape the census forbids in the panic path.

**Three name readers exist and all three are load-bearing.** `write_crash` composes the name; `is_worker_crash_log_name` decides which names are a Worker's crash log at all, and accepts BOTH shapes — the pid-stamped one and the pid-less pre-amendment one — because logs already on disk in a user's directory keep their names; `has_pid_suffix` decides whether a given name claims a specific process. Both predicates anchor at the END of the name (peel `.log`, peel the last `-`, require a non-empty ASCII-digit run) and never split the name into fields — a field parser is what drifts from the writer's format. `find_crash_log_for_pid` applies BOTH halves in BOTH arms, and each half fails open if removed: the pid tail alone would let a `notes-worker-1.log` answer a query for pid 1, and the predicate alone is the recency rule this replaced — so the `None` arm needs `has_pid_suffix` to keep a pid-stamped log out of a pid-less answer. They look like belt-and-braces duplication. They are not; deleting either one is a silent behaviour change.

## Considered Options (amendment)

- **`cfg!(test)` gate on the production dir resolution (rejected).** One line, and it makes the suite unable to write to the user's dir whatever the hook state is. Rejected: it puts a build-configuration branch in shipped code, and the line that decides where a real user's crash log goes is then the line the test binary never executes.
- **An `ARCHIMEDES_CRASH_DIR` env var read per write (rejected).** `commands/files.rs` refused exactly this shape for `HOME`: `set_var` mutates process-global state while the `--lib` suite runs in parallel threads, and enough of that suite reads env without the shared `ENV_LOCK` (`tools::sandbox`'s Landlock ruleset, `mcp::oauth`, and — at the time — `session::router`, which has since stopped resolving a directory at all) that a mutation held under the lock still races them. It would also add a supported user-facing knob for a diagnostic path nobody configures.
- **A mutable global crash dir (`debuglog`-shaped `init`), still resolved lazily at panic time (rejected).** Closer to `debuglog::init(enabled, dir)`, but the value is still read during the panic, so an unseeded or late-seeded global falls back to the real dir — the same failure with one more step. Capturing at install has no unseeded state to fall back from. This is NOT what the router's `crash_log_dir` `OnceLock` is: that one is written once by `setup_dirs_with_factory` and read outside any panic, and the crash hook still never consults it.
- **Keep `write_crash_log` and just stop calling it from tests (rejected).** The minimal diff, and the one that had already been tried once. It relies on hook hygiene holding forever, in a file whose whole hazard is that the hook slot is global and shared. Deleting the resolver makes the reported failure signature unconstructible instead of unlikely.
- **Per-Worker nonce in the filename instead of the pid (rejected).** Sturdier in principle (a pid is gone by the time a human reads the log) but it must be minted by the Supervisor and carried to the Worker through the `Start` envelope — a change to the IPC protocol, to name a file whose only reader opens it in the OS viewer. The pid is already known on both sides of the crash and is what actually makes the name unique.

## Consequences (amendment)

- **`~/.local/share/archimedes/crash-*.log` is now bounded** at `MAX_CRASH_LOG_FILES` = 50 files and `MAX_CRASH_LOG_AGE_DAYS` = 30 days, so the directory is a window on recent crashes rather than a permanent append-only record. The 862 accumulated files were deleted as a one-off — every one of them was test residue.
- **`StalledInfo.crash_log` keeps its type, its `Option` and its meaning** ("`None` when none is found"), so the frontend is untouched: `SessionStalledBanner` renders the path string and already null-checks it, and the path only ever reaches `externalOpen` (ADR 0051). What `None` *covers* got wider, though: a known pid that names no log on disk is now `None`, where the recency rule returned whatever log happened to be newest. That is the deliberate trade — a banner with no link beats a link to another Worker's crash. No other code reads these files.
- **`on_crash` gains a third parameter**, so every `WorkerManager::new` call site (14 across `src/` and `tests/`) threads an `Option<u32>` — the cost of exactness, paid once.
- **Two guards keep the leak from returning, and they do not cover the same ground.** A census invariant in the `childproc` idiom (`production_crashlog_never_resolves_a_data_dir`: no production line in `crashlog.rs` may contain `dirs::data_dir()`, comment-filtered, with a vacuity guard) is the cheap source-level claim that runs everywhere, Windows included. `scripts/check-test-data-dir.sh` is the behavioural one, and it runs **on Linux and macOS only** — Linux redirects with `XDG_DATA_HOME`, macOS with `HOME`. There is deliberately **no Windows arm and no `APPDATA` line**, because the redirect is impossible there: `dirs` 6.0.0 resolves the Windows data dir with `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` (`dirs-sys-0.5.0/src/lib.rs:150-178`; `dirs-6.0.0/src/win.rs:10`), which **ignores `%APPDATA%`** — a Windows "redirect" would move nothing and the check would go green for exactly the wrong reason. So on Windows the census is the ONLY guard: no behavioural guard exists for a `dirs::data_dir()` reached from outside `crashlog.rs`, and a `dirs` upgrade that starts honouring the variable is undetectable there. That gap is recorded, not closed. What the two OSes do check is load-bearing on its own terms: without the redirect the script inspects a directory the suite never wrote to, which is how the first version of the `exec` stdin test passed while guarding nothing (`agent/tools/exec.rs:1780-1791`) — which is also why `test_support::the_ci_data_dir_redirect_took_effect` fails the run when the redirect did not take effect, asserting the premise instead of leaving it assumed.
- **A pre-amendment crash log is still attributable**: the pid-less fallback finds `crash-*-worker.log`, and the wider prune pattern matches those names too.

## Amendment (2026-11-23) — a closed Subagent session's transcripts are bounded at 24 hours, and the "debug view" that justified persisting them was never built

**What stands unchanged, in full:** every session in its own **Worker process** with the desktop a pure
**Supervisor**; the sole-writer persistence of transcripts from the Worker event stream; `unwind` and the crash
hooks; the **Stalled session**; the deletion of the throwaway-`Db` machinery. And two of the three clauses of the
parenthetical quoted below still hold exactly: a child's rows are still **never archived** (0 of 2,649 carry
`archived = 1` at Census A, and 0 of 2,714 at the 2026-11-23 re-read), and they are still **hidden from Space
lists** (`list_sessions` filters `is_subagent = 0` in both arms, as does `session_recency`). **This ADR is NOT superseded and its `status` is unchanged.** What is narrowed is
one clause of one Consequences bullet and the argument attached to it. ADR 0118 carries the decision; this section
records what it did to this one.

**The clause being retired.** Above, "The throwaway-DB machinery is deleted", the promise reads *"never archived,
hidden from Space lists, **inspectable in a debug view**"*. The third clause **was never true and is now moot.**
`grep -rniE "debug view|debugview|debug-view" src/ src-tauri/src/` is **exit 1** — the phrase exists nowhere in the
frontend or the backend. No IPC command takes an `is_subagent` argument or can name a child session; every reader
of the two transcript tables is either `is_subagent = 0` filtered (`list_sessions`, `session_recency`), reachable
only with an id no list can produce (`load_history`/`messages_page`, `messages_for`, `load_native_messages`), or
in-memory-only (`SubagentTranscript` reads `useSessions.messages[entry.sessionId]`, and `discardSessionMessages`
deletes that entry at `subagent-closed`). `git log --all -S "debug view"` names **seven commits at
`1428c941` — `d3e552ea`, `07ccb4f3`, `022d2f53`, `98c970d9`, `d5a23ded`, `1146a59b`, `1a47f823` — and
every one of them is docs, none under `src/` or `src-tauri/src/`**
(`git log --all -S "debug view" -- src/ src-tauri/src/` prints **nothing**). Named
honestly: `1a47f823` is the commit that added ADR 0025 itself (with its plan and the glossary terms), `1146a59b`
is that plan, `d5a23ded` / `98c970d9` / `022d2f53` / `07ccb4f3` are the research report and its three
correction passes, and `d3e552ea` is main's own ADR 0117 commit, which touches the same research report and
quotes the same phrase while ruling on a different seam. Every hit is a document quoting the phrase; **no ref
of this repository ever contained a debug view.**

**What changed in the argument — this is the part that has to be argued, not asserted.** Above, the rows were
persisted because they were *"previously discarded, which is why a 32-minute subagent's work was un-inspectable
after the fact."* Deleting them at 24 h **re-creates that defect on a delay**, so "the bytes are large" is not an
answer. Three things changed:

1. **The promise was never kept, so the argument never bought what it claimed.** Inspectability was the
   justification; what shipped was **unreadable storage with an inspectability rationale that had no
   implementation**. A bound on a thing no surface can reach costs nothing the decision actually delivered —
   and it is the *unboundedness* that was never argued for, not the persistence.
2. **Inspectability now has a real home, and it is the parent.** The child's final report is delivered to the
   parent as the `subagent` tool result and persisted in the **parent's own** stored display row
   (`payload_json.rawOutput.content[0].text`), which `ToolCallCard` renders on expand — untouched by this change,
   and kept for the parent's whole life. So "what did that 32-minute child actually do" is answerable from the
   parent's transcript forever, while the child's own verbatim copy — the only copy that survives for the 64%
   whose text does not match the parent's — is kept for a working day. 24 h is not a decay curve chosen for the
   bytes; it is the window in which the investigation actually happens, priced at 23.4 MB kept out of 2,042 MB
   freed.
3. **The cost was never measured when this decision was taken, and the asymmetry was never argued.** This same
   ADR's 2026-10-18 amendment bounded **11 MB** of crash logs with two constants, a named prune function, a
   clock-skew rule and a one-off cleanup. 2,042 MB of product data bounded nothing for seven weeks (this ADR is
   dated 2026-10-04; this amendment is 2026-11-23, fifty days later). The distinction
   (diagnostic noise vs the product's own transcript) is right **in kind** and was wrong **in degree**: the
   product's data deserves a *longer* window than a crash log, not an infinite one. 24 h against 30 days is that
   claim made numeric.

**And the honest residue, stated rather than smoothed.** For a child older than 24 hours the child's own
transcript is gone and nothing recovers it. If the 64% of newest rows that do not match a parent's `rawOutput`
turn out to matter, the reader that would need them must be built **before** the window shrinks, not after — and
if the window is ever shortened, this amendment is the file that has to be revisited first.

## Considered Options (amendment)

- **Supersede this ADR outright (rejected).** Nothing above reverses this ADR's decision; only its reach moved.
  `superseded-by:` is the instrument for a whole-decision replacement (7 of 109 use it that way), and using it here
  would bury the Worker-process architecture under a retention rule. ADR 0016 rejected the same shape for the same
  reason: *"a separate ADR superseding this one — rejected because nothing above reverses this ADR's decision, only
  its stated reach."*
- **Edit line 21 in place (rejected).** `docs/decisions/` is append-only. The clause is the record of what was
  believed on 2026-10-04, and 0024's precedent is explicit that a clause false of shipped code is left standing and
  corrected below.
- **A `*Partial: see ADR 0118*` note instead (rejected).** That is the instrument for narrowing one sentence of a
  *merged* ADR from the new file. It was considered — and the narrowing sentence does live in ADR 0118 as well — but
  the change here retires a whole clause **and its argument**, which is amendment-sized, and this file already
  carries the precedent two lines above.

## Consequences (amendment)

- **"Inspectable in a debug view" is no longer a promise this repository makes.** Any future doc that repeats it is
  wrong; the phrase is now cited only to be retired. The frontend's own comment at `src/store/sessions.ts` — "a
  child's rows DO persist … no surface can re-open a closed child" — is the sentence that matches the code, and it
  weakens to "persist for 24 hours" when the code lands.
- **The rows this ADR justified persisting now have a lifetime**: `MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE` = 24 h after
  the child is **closed**, with the newest `messages` row and the `sessions` row surviving. ADR 0118 owns the rule,
  the measurements and the `VACUUM` threshold; this section owns the correction to the rationale.
- **`CONTEXT.md`'s "Subagent session" entry still calls the row a "hidden ephemeral row — ADR 0025"**, and the
  **Closed Subagent session** entry (added 2026-11-22) now defines the state that triggers the prune. Per ADR 0086
  names are repaired **on touch**, not by sweep, so the older clause stays until something touches it.
