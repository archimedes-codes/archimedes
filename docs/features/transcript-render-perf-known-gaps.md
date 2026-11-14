---
status: live
last-verified: 2026-11-14
verified-by: §1–§3 as originally recorded — each claim re-measured against this tree at `041ef6ad` rather than
  copied from the roadmap plan that recorded it (`git merge-base --is-ancestor <fix commit> v0.9.2` for the three
  already-shipped fixes, all three true; `grep -l 'memo(' src/components/**/*.tsx` for the memo census, 3 files,
  none a tool card before this branch; and a read of `src/components/chat/MessageList.tsx` (`react-virtuoso`),
  `src/lib/batchSessionUpdates.ts` (per-frame coalescing) and `src/navigation_guard.rs` (`should_track_label`)
  for the mechanisms). Issue #155's reporter figures (687 MB DB, 25 WebView2 processes, ~42,000 CPU-seconds) are
  the reporter's own, quoted from the issue, not measured here.
  §4 measured live on this machine on 2026-11-14 against the running `archimedes.appimage` **v0.13.0** (host PID
  1790154, one `WebKitWebProcess` PID 1790208, both re-derived with `pgrep -a -f` rather than assumed; DB
  2,333,728,768 bytes). Instruments: `/proc/<pid>/stat` fields 14+15 at HZ=100 sampled at 1 s and 10 s,
  per-thread `/proc/<pid>/task/*/stat` split on the LAST `) `, `strace -f -c` and `-f -tt -e trace=write` runs of
  8–125 s, `/proc/<tid>/syscall`+`wchan` sampling, and read-only `sqlite3` against the live DB. **`perf` is not
  installed here**, so nothing in §4 is perf-derived and the plan's `perf top` step never ran. **`gdb` was
  available and deliberately not used** — this is the user's live session. The reduced-motion toggle was read
  before (`'no-preference'`) and restored after (re-verified). Caveat that bounds all of §4: **the measuring
  session runs inside the app it measures** — the agent `--worker`'s PPID is the host PID — so a genuinely idle
  app is not reachable from it, and both states are measured explicitly instead.
  §5 recorded on the same date at the head of `feature/whole-window-jank`: every deferred item re-verified against
  this tree rather than copied from the run that deferred it — `grep -rn 'wal_autocheckpoint' src-tauri/src` (one
  hit, prose only), `grep -rn 'with_batched' --include=*.rs src-tauri` (the builder method plus `lib.rs`'s single
  production call), `grep -n 'The mutator class is NOT eliminated in general' src/store/sessions.test.ts`,
  `grep -n 'slice(0, 80)' src/components/SidePane.tsx`, `command -v perf` (absent),
  `grep -rl 'prefers-reduced-motion' node_modules/tailwindcss/*.css` (nothing), and
  `wc -l node_modules/tw-animate-css/dist/tw-animate.css` → 0 lines / 14,880 bytes with no `animate-spin` in it,
  which is what corrects the `tw-animate-css:438` citation §4 already retracted. §5.6 also **refutes** the claim
  that reached it: `resumeSession`'s reload re-reads `activeSessionId` after its only `await` and cannot populate
  an off-screen `messages[id]`; the unguarded writers are the frame-driven ones.
---

# Transcript render performance — known gaps

Accepted, unfixed gaps in the chat transcript's render path. They live here because the roadmap
family that recorded them (`docs/roadmap/ui-and-console-fixes-*`) is deleted on ship.

Read this before concluding that issue #155 ("whole-window UI becomes janky with a large
conversation open — typing stays smooth") is fixed, or before adding a `React.memo` to a tool card.

---

## 1. #155's four suggested fixes: three had already shipped, and the symptom is still unexplained

The reporter is on **v0.9.2**. Three of the four fixes the issue asks for were already in that
build — verified with `git merge-base --is-ancestor <commit> v0.9.2`, not assumed:

| The issue asks for | Already in v0.9.2? | The mechanism |
|---|---|---|
| "Virtualize the transcript / cap render rate" — virtualization half | **Yes** | `react-virtuoso` in `src/components/chat/MessageList.tsx`, since PR #67 (`8ff4648e`), first tagged v0.5.0 |
| the same — "batch incoming stream frames … one re-render per animation frame" | **Yes** | `src/lib/batchSessionUpdates.ts` (`c2c71675`), first tagged v0.1.0. Its own doc comment describes the reported symptom almost verbatim: ~1000 chunks/sec applied one-per-`setState` "saturates the webview main thread — the GPU sits idle … and the UI renders at ~1fps" |
| "Clean up `web-fetch-render-*` helper windows" | **Yes** | `should_track_label` in `src/navigation_guard.rs` (`067dba81`), first tagged **v0.8.0** — i.e. before the report |
| "memoize tool-call cards and diffs" | No | the only genuinely open direction; see §2 |

So the leading explanations the issue proposes are **eliminated, not implemented**, and the
reporter's measurements stand unexplained: a 687 MB `archimedes.db` and growing, 25 WebView2
renderer processes at ~2.4 GB with two carrying ~42,000 accumulated CPU-seconds, while the Rust host
is nearly idle. The "typing stays smooth, everything around it stutters" signature is consistent
with renderer saturation but no cause was found.

**`open work`, and the next step is measurement, not another fix.** Two candidates were never
examined:

- **The SQLite write path.** The reporter observed persistence happening per stream frame. Whether
  those writes leave the main thread, and what a 687 MB database does to write cost, has not been
  measured from this repo.
- **25 renderer processes.** Nothing in this repo explains a count that high; leaked helper windows
  were the obvious candidate and that fix had already shipped. Reproduce against a **current** build
  before assuming the reporter's v0.9.2 count describes today.

Do not re-implement the three shipped fixes to "address #155". They are in the build the reporter
was complaining about.

> **Both of those were since measured** — the write path is a real defect but of the wrong kind (per-frame
> commits in rollback-journal + `synchronous=FULL`, ~100× WAL+NORMAL; DB size itself flat between 400 and
> 700 MB), and the 25-process count is an instrument artifact rather than a leak: this tree contains exactly
> one `WebviewWindowBuilder::new`. See `docs/research/whole-window-jank-renderer-saturation.md` §4–§5. Neither
> explains the peg, and **§4 below records what the follow-up measurement found — including that it still did
> not name the cause.**

## 2. `React.memo` on a tool card is a no-op, and shipping one would have been a hollow pin

`src/components/MessageBubble.tsx` is already `memo()`'d, and the card props (`rawInput`,
`rawOutput`, `diff`) come straight off the `message` object — so they are reference-stable exactly
when the message is stable, which is precisely the case the existing memo already skips. A `memo()`
*inside* that boundary compares references that only differ when the card should re-render anyway.

The props that are genuinely unstable, and why each defeats `memo`:

| Component | Unstable prop | Why it is fresh |
|---|---|---|
| `ChangesGroupCard` | `messages` | `ChatStream` re-runs `groupConsecutiveFileWrites` per render; its own doc says "Pure — re-derived per render" |
| `FileSummaryCard` | `diffs` | comes from the `turnDiffs` derivation, whose hook is deliberately un-memoised |
| `ToolCallCardHeader` | `onToggle` | a fresh arrow at all three call sites |

Shallow comparison bails on every one of these, so `memo` on those components would pass CI having
changed nothing — the worst kind of green.

**What shipped instead (PR-less branch `feature/ui-and-console-fixes`, commit `335efff6`):**
`memo(DiffBlock)` — the one unconditionally-correct candidate, two string props, value-compared —
pinned by `src/components/DiffBlock.test.tsx`, which counts renders through a module counter that is
gated behind `import.meta.env?.MODE === "test"` so it is dead-coded out of production bundles. The
test was proven to fail without the `memo` wrap (`expected 3 to be 1`), so it is a test and not a
decorative pin.

**`open work` — the memo that would actually pay.** Making `units` content-keyed in `ChatStream`
(`useMemo` over the existing `unitKeys` machinery) would make `ChangesGroupCard.messages`
reference-stable, and only then would memoizing that card stop being a no-op. That is a larger
change than #155 scoped, so it was recorded rather than smuggled in. Anyone pursuing it should
measure first: the benefit is real only if composer keystrokes actually re-render `ChatStream`.

## 3. If `.window-state.json` shows `web-fetch-render-*` again, that is a regression

The leaked-hidden-windows half of #155 was fixed by #91's `should_track_label` filter (v0.8.0). The
filter's own comment records why it must keep working: the plugin's default flags include
`StateFlags::VISIBLE` and its `on_window_ready` restore calls `show()` + `set_focus()` for any label
with no saved state, which is every render webview because its label carries a fresh uuid. A release
whose `.window-state.json` accumulates `web-fetch-render-*` entries is therefore **a new regression
against a shipped fix**, not an open feature request — and the comment warns that the accumulation
argument specifically dies on a `tauri-plugin-window-state` bump, so re-check the ordering on any
plugin upgrade.

## 4. §1's measurement was run: the peg is episodic, four causes are excluded, and the cause is still not named

§1 closed with *"the next step is measurement, not another fix"*. That measurement happened on 2026-11-14 against
the running app on this machine. **It did not name the cause.** What it did was fix the shape of the thing, kill
four candidates that §1 and the research report were still carrying, and hand over a shorter list. Read §1's
"next step is measurement" together with this section: the measurement is done, and it did not pay off in a fix.

Full numbers, per-thread tables and the confound analysis are in
`docs/research/whole-window-jank-renderer-saturation.md` §10. This section is the re-runnable summary.

### The shape is wrong in §1 and in the report's title: episodic, not sustained

The report says *"holds ~100% of one core"*. Over 600 × 1 s samples that is true of **17% of seconds**. The real
shape is a floor with spikes:

```
mean 41.1%   ≥90%: 17% of seconds   ≤25%: 66% of seconds
floor (all samples <60%, n=447): mean 20.5%, range 10.9–59.8%
bursts: 27 s @ 86.7%,  57 s @ 108.5%,  49 s @ 113.2%   — onset ~every 2 min, NOT periodic
```

Per-thread **during** a burst reproduces the report's split almost exactly, which is how we know the original
snapshot was a burst and not a misreading: **38.9% JS main thread, 27.5% + 25.5% `SkiaGPUWorker`, 10.3%
`ThreadedCompositor`, 7.3% `cs0`.**

**This is the finding that matters most for anyone picking this up: a 20-second A/B window on this app measures
which side of the ~2-minute cycle you landed on, not your treatment effect.** Every future experiment needs to
straddle several bursts or it is noise. §2's `memo(DiffBlock)` pin is a render-count test and so is immune;
anything measured in CPU is not.

### Excluded, with the evidence that excludes it

| Candidate | Verdict | The evidence |
|---|---|---|
| Streaming / agent activity | **Excluded as the peg's cause** | My own `--worker` sampled every 1 s: **0.0% in all 120 samples** of a window where the renderer held ≥90% for 117 of them; and **0.0% for all 300 samples** of a second window. Streaming *does* add load (renderer 13.9→115.8% while emitting an 8 KB delta) — it is just not what the idle peg is. |
| The ~1,000/sec eventfd storm | **Excluded as the cause** (was published as *evidence of idleness*; that is withdrawn — see the report's Corrections) | Host writes are **flat at 1,144/sec** (mean over 125 s; min 589, max 1,341) with no step at burst onset, and quiet-state rounds measured **882–1,091/sec while the renderer sat at 13–16% CPU**. A 1 kHz tick driving continuous repaint is refuted: it would have to be absent in the 20% floor, and it is not. |
| `prefers-reduced-motion` / the two CSS animations it covers | **NULL** | Baseline 87.7% → reduced-motion 78.2%, but the *control* (flag restored, animations back on) fell to **21.4% on its own** — the burst was decaying anyway. Contemporaneous comparison is 79.3% vs 74.5% = **4.8 points**, inside the noise of a signal that swings 10.9→130.6% unaided. |
| The SQLite write path **as the trigger** | **Excluded as the trigger** (its cost ratio stands — §1, report §4) | A burst-time 10 s trace of the host found `fsync` 64, `pwrite64` 255, `pread64` 48 — real DB traffic, ~6.4 commits/sec, ≈1 ms of work against a full core. A passenger, not a driver. |

### Not excluded, and now the leading candidate

**Something in the renderer's paint/GPU path enters a sustained ~2-minute repaint episode**, and the Rust host is
not a bystander during it: across 300 × 1 s samples, **burst = renderer 119.8% + host 62.1%; baseline = renderer
15.6% + host 10.5%**, with the **host main thread at 53.2%** during a burst. The best single clue is where the
compositor blocks — `/proc/<tid>/wchan` sampling during a burst:

```
compositor 1790256   224 samples in drm_syncobj_array_wait_timeout   (waiting on the GPU)
renderer   1790208   236 poll_schedule_timeout, 145 running
host main  1790154   244 poll_schedule_timeout, 138 running
```

Two things are still alive that the OS flag could not reach:

- **`animate-spin` has no reduced-motion rule anywhere**, so the flag never disabled it. Tailwind defines
  `--animate-spin: spin 1s linear infinite;` at **`node_modules/tailwindcss/theme.css:438`** — *not* at the
  `tw-animate-css/dist/tw-animate.css:438` citation that was circulating: that file is 14,880 bytes on **one
  line** (0 newlines) and contains neither `spin` nor `reduced-motion`. Three non-test uses:
  `src/components/ui/spinner.tsx:9`, `SubagentStatusIcon.tsx:26`, `SessionStatusMark.tsx:161`. App CSS gates only
  `.animated-gradient-text` (`src/styles/utilities.css:70`) and `.flip-in` (`:92`).
- **The stale-status census says those spinners really are mounted.** Read-only against the live 2.33 GB DB:
  **1,064** `in_progress` tool-call rows (of 186,322), and **355 of 2,278 sessions carry one inside their newest
  500 messages** — the first page loaded when you open them. **Task 1 (`e5170826`) fixes this**, but see the
  version caveat below. So §4's null result does **not** exonerate mounted spinners; it only exonerates the two
  selectors the flag covers.

`VBlankMonitor` and `PressureMonitor` turned up in the write attribution and are **WebKitGTK's own threads**, not
ours — `strings` finds both in `/usr/lib64/libwebkit2gtk-4.1.so.0.24.5`, zero hits in `src-tauri/src`. Related
incidental find: the host reads `/proc/meminfo` **121 times/sec** (all by tid 1790206) and its own `cgroup`
16/sec. Engine-side polling, steady, and not the peg either.

### Commands

`perf` is **not installed on this machine** — the planned `perf top -p <pid>` never ran and nothing above is
perf-derived. `gdb` is available and was deliberately not used (live user session). These are the substitutes.

```bash
# 0. Re-derive PIDs. Never trust a PID from a doc.
pgrep -a -f WebKitWebProcess; pgrep -a -f 'archimedes --worker'
readlink /proc/<host>/exe; mount | grep archim    # the AppImage is mounted ro

# 1. Instantaneous % of one core. HZ=100; fields 14+15. NEVER use `ps` pcpu — lifetime average.
#    comm can contain parens/spaces and is truncated to 15 chars, so strip through the LAST ") ".
#    A naive `awk '{print $14}'` on the raw line is fine when comm has no spaces but silently
#    returns 0 when it does; that bug produced two pages of confident zeros in this pass.
#    After the strip, field 1 is state (orig 3), so utime = field 12 and stime = field 13.
sed 's/^.* **) //' /proc/$P/stat | awk '{print $12+$13}'   # verified == awk '{print $14+$15}'
a=$(sed 's/^.* **) //' /proc/$P/stat | awk '{print $12+$13}'); t0=$(date +%s.%N)
sleep 10
b=$(sed 's/^.* **) //' /proc/$P/stat | awk '{print $12+$13}'); t1=$(date +%s.%N)
awk -v a=$a -v b=$b -v t0=$t0 -v t1=$t1 'BEGIN{printf "%.1f%% of a core\n",(b-a)/100/(t1-t0)*100}'

# 2. Per-thread, during a burst (names come back truncated: "SkiaGPUWorker", "eadedCompositor")
for t in /proc/<renderer>/task/*; do tid=${t##*/}
  sed 's/^.* **) //' $t/stat | awk -v tid=$tid '{print $12+$13, tid}'
done   # sample twice, 10 s apart, diff, divide by 10*100

# 3. The eventfd storm, per thread and per fd. Keep traces <=8 s; ptrace_scope is 0.
strace -f -c  -e trace=write,read,poll,epoll_wait -p <host>       # 8 s census
strace -f -tt -e trace=write -p <host> -o w.txt                   # then:
awk '{print $1}' w.txt | sort | uniq -c | sort -rn | head         # which TIDs
grep -o 'write([0-9]*' w.txt | sort | uniq -c | sort -rn | head   # which fds
for fd in 4 38; do readlink /proc/<host>/fd/$fd; done             # fds are the HOST's, not the renderer's
#    duration from the trace itself, NOT from your `timeout` value — strace runs the full window:
awk '{split($2,t,":"); s=t[3]+60*t[2]+3600*t[1]; if(!mn||s<mn)mn=s; if(s>mx)mx=s} END{print mx-mn}' w.txt

# 4. Poor man's profiler (no ptrace, never interrupts the app) — where threads actually wait
cat /proc/<tid>/wchan; cat /proc/<tid>/syscall        # sample in a loop during a burst

# 5. Reduced-motion A/B. THE KEY IS AN ENUM, not a boolean:
gsettings range org.gnome.desktop.a11y.interface reduced-motion   # 'no-preference' | 'reduce'
ORIG=$(gsettings get org.gnome.desktop.a11y.interface reduced-motion); echo "ORIGINAL=$ORIG"
gsettings set org.gnome.desktop.a11y.interface reduced-motion "'reduce'"; # ...sample...
gsettings set org.gnome.desktop.a11y.interface reduced-motion "$ORIG"     # restore, then re-read to verify

# 6. Stale-status census (read-only; the live DB is locked for writes)
sqlite3 "file:$HOME/.local/share/archimedes/archimedes.db?mode=ro" "
  PRAGMA busy_timeout=10000;
  WITH page AS (SELECT session_id, kind, json_extract(payload_json,'\$.status') AS st,
    row_number() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn FROM messages)
  SELECT count(*) FROM messages WHERE kind='tool-call'
     AND json_extract(payload_json,'\$.status')='in_progress';
  SELECT count(DISTINCT session_id) FROM page
   WHERE rn<=500 AND kind='tool-call' AND st='in_progress';"
```

### Two traps that produced wrong results in this pass

1. **`gsettings set … reduced-motion true` fails** with *"The provided value is outside of the valid range"* —
   it is an enum. The first A/B run "measured" a run in which **nothing was ever applied** and its numbers looked
   plausible. Print `gsettings get` *inside* the treatment phase; if it still says `no-preference`, you measured
   nothing.
2. **`strace` runs for its own window, not for your `timeout`.** Dividing a 12 s capture by 8 inflated every
   per-thread CPU by 50% (79.8% → the true 53.2%). Derive the duration from the trace's own timestamps.

### What could not be measured, and why

- **A DevTools Performance profile of one burst** — the one instrument that would settle the paint-path question
  — is **unreachable**: the running 0.13.0 AppImage is mounted **read-only** (`fuse.archimedes.appimage … ro`) and
  ships no devtools feature. This is §9 step 4 of the research report, still unexecuted.
- **The animation test with the classes actually commented** (the half that could reach `animate-spin`) needs to
  edit the installed app's CSS. Same read-only wall, and rebuilding would destroy the process under study. **Only
  the OS-flag half was run, and it is null.**
- **A truly idle app is not reachable from an agent session.** The agent `--worker`'s **PPID is the app host** —
  the measuring session runs *inside* the thing it measures, and its output is painted by the renderer under test.
  Both states were therefore measured explicitly, with the worker's own CPU sampled alongside.
- **The peg cannot be provoked on demand**; every burst above was caught by polling for up to 8 minutes.
- **The app under test is v0.13.0 and contains NONE of Tasks 1–4** — checked with
  `git merge-base --is-ancestor <fix> v0.13.0`, which fails for all four (`e5170826`, `2ae39645`, `fda3fc45`,
  `d03c13cf`); the tag is dated Nov 11, the fixes Nov 14. **Nothing in this section tests the shipped fixes**, and
  the spinners the census predicts are still mounting on this machine. Re-running §4 against a build that contains
  Task 1 is the cheapest thing on the list and has not been done.

## 5. What this branch deliberately did NOT fix

Issue #155 landed six commits on `feature/whole-window-jank`, named here by what they did rather than by hash —
the squash-orphan rule above says per-issue objects die with the branch: the tool-call **status-hydration split**
(an unresolved persisted status now hydrates as `failed`), the **WAL / `busy_timeout` / `synchronous` pragmas**
plus a batched message write, **releasing the transcript of a session the user has left** (and the
**carried-label salvage** that forced, both in that one commit), the **pin that the ADR 0050 third mutator no
longer duplicates** a hydrated card, **history and session-list reads moved off the tokio workers**, and the
**`FulcrumPersistence` batching decorator**. What follows is the accepted-deferred list from that run — each item
with the command or content anchor that locates it, so the next reader re-measures instead of trusting this
prose. **Nothing here is a defect the branch missed; each was weighed and left.**

### 1. `wal_autocheckpoint` is un-tuned, on purpose

WAL does not only remove cost, it **introduces** a checkpoint cost that rollback-journal never had. The
measurement that matters is the **81 ms `wal_checkpoint(TRUNCATE)` observed at 703 MB** during planning.

Located by content in `src-tauri/src/storage/db.rs`, in the doc comment on the pragma setter — the comment ends
*“Deliberately NOT here: `wal_autocheckpoint` … tuning the autocheckpoint blind against it would trade one stall
for another with no measurement to say which is cheaper.”* Re-runnable:

```bash
grep -rn 'wal_autocheckpoint' src-tauri/src          # exactly ONE hit, and it is prose, not a pragma
grep -n 'journal_mode\|synchronous\|busy_timeout' src-tauri/src/storage/db.rs | head
```

The three pragmas that DID ship are set in one function and read back (`journal_mode` refuses silently on some
filesystems, so a `?` cannot see it). A fourth is a tuning decision with no data behind it, so it was not taken.

### 2. `with_batched` on the builder is load-bearing and enforced by nothing but a comment

`attach_db` deliberately does **not** build a second decorator when a persister is already installed — a second
buffer nobody writes to would be what every flush point drains, while the real one filled up and was never
drained. The consequence: **a future production caller that builds its own `TranscriptPersister` and hands it to
`SessionManagerBuilder` silently gets no batching.** No compile error, no red test, just a slower app.

```bash
grep -n 'with_batched\|flush_batched\|fn attach_db' src-tauri/src/agent/session/mod.rs
grep -rn 'with_batched' --include=*.rs src-tauri      # the builder method + lib.rs's ONE production call
```

The obligation is stated in `with_batched`'s own doc comment (“REQUIRED for batching to be reachable at all on
this path … `lib.rs` does; the persister-shaped test call sites do not”). **Nothing enforces it** — no source
lint, no boundary pin, no test names the missing-`with_batched` mistake. Note the related asymmetry while you
are in there: `SessionManager::batched()` (the accessor) has **zero call sites** — the router reaches the
decorator through `flush_batched` and the exit path through the `app.manage`d concrete `Arc`, so the accessor
exists for tests that were never written against it.

### 3. `insert_native_message` passes through unbatched — a deviation from the plan, kept deliberately

The plan listed it among the writes to buffer. Batching it **reddens**
`src-tauri/tests/ipc.rs::a_subagent_transcript_persists_as_a_hidden_ephemeral_row`, which reads
`load_native_messages(child_id)` immediately after the crate emits `subagent-closed` — and nothing between a
child's last frame and that emission is a flush point the desktop controls: `finish_subagent` emits
`subagent-closed` on the sink directly, and the child's `Exited` (the router's other candidate) arrives only
after the reap.

```bash
grep -n 'a_subagent_transcript_persists_as_a_hidden_ephemeral_row' src-tauri/tests/ipc.rs
grep -n 'DEVIATION FROM THE PLAN' -A22 src-tauri/src/storage/batching.rs   # the method doc carries the analysis
```

Cost is negligible, and that is the honest second half of the argument: an `Insert` frame is one per transcript
message (a handful per turn), **not** the ~60/sec `Display` flood the batching exists to absorb. Documented on
the method in `src-tauri/src/storage/batching.rs`, and summarised in that module's “Why coalescing is legal
here” header.

### 4. `mergeDedupeKey` still carries `status`, so the ADR 0050 duplicate-card class is NOT eliminated

`src/lib/transcript/identity.ts` builds a `tool-call` key as `tool-call|<id>|<title>|<status>` — content-
inclusive by design. Task 1 made the **common** case collapse to one card by splitting the status mapper from
the hydrate path (`rowToMessages` → `mapPersistedStatus` in `src/lib/transcript/reducer.ts` now maps an
unresolved persisted status to `failed`, matching `finalizeSessionMessages`). But **a live card whose status
disagrees with the hydrated row still duplicates.**

```bash
grep -n 'tool-call|' src/lib/transcript/identity.ts            # the key composition
grep -n 'The mutator class is NOT eliminated in general' src/store/sessions.test.ts
```

That last grep is the point: **the residual gap is documented only in a test comment** — inside the `it(...)`
that pins the collapsed single card (`collapses a tool card to ONE failed card when a session close finalizes it
inside the load window`). Nothing outside that test file says the class survives. ADR 0050's rule (where
identity cannot decide, KEEP the message) is untouched and is the reason a duplicate is the safe direction.

### 5. `SidePane.tsx` re-implements the truncation inline instead of calling `titleFor`

Every other labelling surface goes through the one rule; `SidePane` is the exception, so it is the one surface
that does **not** inherit the carried-label salvage Task 5 added.

```bash
grep -rn 'titleFor(' src --include=*.tsx | grep -v '\.test\.'   # SessionsSection, SpaceTabs, SpacesList, TaskDetailDialog
grep -n 'slice(0, 80)' src/components/SidePane.tsx src/lib/sessionTitle.ts   # the duplicate, + the helper it duplicates
```

`src/lib/sessionTitle.ts` exists precisely so `slice(0, 80)` has one owner, and its own doc comment names the
risk (“a second copy … is how two surfaces start naming one Session differently”). **Still correct today**, and
that is why it was left: `SidePane` reads `messages[activeSessionId]`, and the active session is live, so its
transcript is never released — the arm it does not inherit is the arm it never needs. It is a divergence waiting
for someone to make the pane render a non-active session.

### 6. An off-screen `messages[id]` can still be populated — but NOT by the path this section first named

The claim carried into this run was that `resumeSession`'s fire-and-forget reload could populate `messages[id]`
for an id the user has navigated away from. **That is wrong, and it is worth recording as wrong because the
opposite is the thing to check.** `resumeSession` re-reads `activeSessionId` after its only `await` and returns
without touching `messages`, and the `set` that writes the transcript is reached synchronously from that guard:

```bash
# exactly ONE await between the guard and the write, in the resume reload:
awk 'NR>=2250 && NR<=2390 && (/await /||/activeSessionId !== sessionId/||/messages: \{ \.\.\./)' src/store/sessions.ts
```

The paths that CAN write `messages` for an id nobody is looking at are the **frame-driven** ones, which carry no
`activeSessionId` guard at all: `applySessionUpdate`/`applySessionUpdates`, `addUserMessage`, and
`handleSessionClosed` — the last of which writes `finalizeSessionMessages(state.messages[id] ?? [])`, so a late
`session-closed` **re-creates `messages[id] = []`** for a released id. This is known and already defended:
`openSession`'s loaded test is a TWO-signal test (`history[id] !== undefined` AND a non-empty transcript) for
exactly this reason, and its comment spells out that `[]` is truthy and defeats an absence guard. A live id is
never evicted, so the frames themselves are ADR 0073's intended behaviour, not a leak. Left as-is: no observed
cost, and the guard that would “fix” it is the one that already exists.

### 7. The idle peg is still NOT named — see §4

§4 is the record; it is not restated here. Two facts from it bound anything a future run can do:

- **`perf` is not installed on this machine** (`command -v perf` → nothing; `gdb` is present and was deliberately
  not used, because the measuring session is the user's live session). So nothing in §4 is perf-derived and the
  planned `perf top` step never ran.
- **There is no DevTools profile of a burst** — the one instrument that would settle the paint-path question —
  because the running AppImage mounts **read-only** (`mount | grep archim` → `fuse.archimedes.appimage … ro`) and
  ships no devtools feature. §4's “What could not be measured” carries the full list, including that the peg
  cannot be provoked on demand.

### 8. `prefers-reduced-motion` does not reach `animate-spin`, so §4's null does NOT exonerate the spinners

The OS flag only turns off what a CSS rule tells it to. App CSS gates exactly two selectors —
`.animated-gradient-text` and `.flip-in`, both in `src/styles/utilities.css` — and Tailwind ships **no reduced-motion
rule for `animate-spin`**:

```bash
grep -rl 'prefers-reduced-motion' node_modules/tailwindcss/*.css   # prints NOTHING (theme/index/preflight/utilities)
grep -n 'prefers-reduced-motion' src/styles/utilities.css          # exactly two blocks: .animated-gradient-text, .flip-in
grep -n -- '--animate-spin' node_modules/tailwindcss/theme.css     # :438 — the definition, unguarded
grep -rn 'animate-spin' src --include=*.tsx | grep -v '\.test\.'   # 3 non-test uses
grep -rn 'motion-reduce' src --include=*.tsx | grep -v '\.test\.'  # also NOTHING — no per-use guard either
```

Do not be thrown by `grep -rl` over the whole package, which does hit `dist/lib.js` and `dist/lib.mjs`: those are
Tailwind's `motion-safe` / `motion-reduce` **variant definitions** — machinery that lets an author *opt in* — not a
rule that switches any animation off. Neither the `animate-spin` utility nor any of the three call sites uses that
variant, so the flag genuinely never reaches them.

The three mounted spinners are `src/components/ui/spinner.tsx`, `src/components/SubagentStatusIcon.tsx` and
`src/components/SessionStatusMark.tsx`. **Cite `tailwindcss/theme.css` for the definition.** The citation that
circulated earlier in this issue — `tw-animate-css/dist/tw-animate.css:438` — is **wrong**, and `tw-animate-css`
is the wrong package too: that file is 14,880 bytes on **one** line (`wc -l` → 0 newlines) and contains neither
`animate-spin` nor `--animate-spin` nor `reduced-motion` (its only `spin` substrings are the unrelated
`spin-in`/`spin-out` enter/exit utilities). `tw-animate-css` IS imported by `src/index.css`, so the correction is
about the location of the rule, not about whether the package is in play.

Consequence, restated because it is the part that changes a conclusion: §4's reduced-motion A/B was **null**, and
that null covers the two selectors the flag reaches. The census-mounted spinners were never switched off during
it, so they remain live candidates — with Task 1's status hydration now mapping an unresolved persisted status
to `failed`, the mount count should fall, but §4 measured a **v0.13.0** build that contains none of these fixes.
