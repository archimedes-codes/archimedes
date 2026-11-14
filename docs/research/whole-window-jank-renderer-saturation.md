---
status: current
last-verified: 2026-11-14
verified-by: mixed instruments, run read-only at `2f2d5f19` on 2026-11-14 (the session began at `98b25a59`,
  which became **unreachable from `main` mid-run** — this repo's squash-merge orphans per-issue commits — so the
  stamp names the reachable commit; `git diff --stat 98b25a59 HEAD` is **empty for all nine cited files**
  (`sessions.ts`, `ChatStream.tsx`, `chat/MessageList.tsx`, `SubagentDelegatingCard.tsx`, `storage/db.rs`,
  `agent/web/render.rs`, `Reasoning.tsx`, `transcript/reducer.ts`, `subagentActivity.ts`), so every line
  citation below holds unchanged at this stamp). **Live process measurement on this
  machine** (the load-bearing evidence): `/proc/<pid>/stat` utime+stime sampled at 1 s × 20 and 10 s intervals,
  per-thread via `/proc/<pid>/task/*/stat`, `ps` for RSS/etime, `strace -f -c -e trace=fdatasync,fsync,write,pwrite64`
  against the running host for 8 s. **SQLite measurement against this machine's real 2.33 GB `archimedes.db`** —
  read via `.backup` into `/home/daniel/jank-bench/snap.db` (real disk, never `/tmp`: it is a shared tmpfs here)
  because the live DB is locked; the exact production SQL from `db.rs:1649-1677` replayed at limit 15 / 500 /
  unlimited, 7 reps, medians, JSON parse timed separately. **My own SQLite write benchmark, run twice** (cold-built
  and then interleaved A/B, 400 MB and 700 MB, `journal_mode`/`synchronous` read back from the connection to
  confirm each setting applied) — **the two runs disagreed and both are reported**, §4 and §Unresolved.
  **Synthetic microbenchmarks** of
  `estimateTokensFromMessages` (copied verbatim from `subagentActivity.ts:148`) and of the derivation chain, run
  under `node --experimental-strip-types` against the real modules. **Code reading** of this tree plus the
  crates.io-pinned `fulcrum-harness-0.2.0` source in the cargo registry cache
  (`~/.cargo/registry/src/index.crates.io-*/fulcrum-harness-0.2.0/src/persist.rs`). **Web research** — 5 researcher
  angles dispatched (write path, SQLite benchmark, renderer process count, jank signature, precedent/toolkit); a
  6th (platform generality) was **cancelled and is a named gap below**, so §6's cross-platform claims rest on the
  live Linux reproduction plus code reading, NOT on the WebKitGTK/WKWebView process-model research that angle was
  to return. **Two numbers cited by a researcher were re-measured here and one disagreed** — see §Corrections.
  Not measured, and said so where claimed: Windows/WebView2 numbers (this machine is Linux), Windows behaviour of
  any kind, react-virtuoso's internal cost (read from shipped `dist`, not instrumented), and whether the sustained
  idle peg survives disabling the CSS animations (the confound in §3).
task: tsk_74e3a9d0-2d96-48cd-bedf-1f433f44e96e
issue: https://github.com/archimedes-codes/archimedes/issues/155
---

# Whole-window jank is renderer saturation, sustained while idle, and it is not WebView2-specific

Research question: *issue #155 reports whole-window UI jank with a long conversation open while typing stays
smooth. Three of its four suggested fixes shipped before the reporter's build and the symptom is unexplained —
so what is the actual mechanism, and is the SQLite write path or the 25-process renderer count the cause?*

Settled with the requester before dispatching: pin the cause from code **and measure what is measurable on a
Linux box** (the card's "reproduce and report WebView2 process count and DB size" is not literally executable
here — this machine has no Windows); treat the WebView2 figures as a reportable artifact; investigate
platform-generality; deep depth.

---

## Executive summary

**Reproduced — on Linux/WebKitGTK, on this machine, during this session.** One `WebKitWebProcess` holds
**~100% of one core**, sampled 20× at 1 s intervals (range 93–112%), accumulating **41,089 CPU-seconds** over
38 h 11 m of uptime (29.8% of a core sustained since launch). The reporter's Windows figures were 25,570 s and
16,417 s on two `msedgewebview2.exe` processes with the Rust host nearly idle. Same signature, different engine.

**That reproduction overturns the issue's two framing claims.**

1. **It is not the Windows/WebView2 counterpart of anything.** WebKitGTK shows it too, so `docs/features/transcript-render-perf-known-gaps.md` §1's platform-neutral framing is right and the fix must be platform-neutral. Linux and macOS users have this bug unreported — reporting bias, not absence. §6.
2. **"25 WebView2 processes" is a counting artifact, not a leak.** `msedgewebview2.exe` is the image name for browser, GPU, utility and crashpad processes *and every other WebView2 app on the box*; a healthy single-webview app shows many. This tree contains exactly **one** `WebviewWindowBuilder::new` (`src-tauri/src/agent/web/render.rs:135`). The known-gaps doc's "something else is holding 25 renderers alive" is chasing an instrument that cannot distinguish a leak from a normal process group. §5.

**The burn is not streaming-driven.** All six `archimedes --worker` processes held ~0 CPU; `strace` on the host
for 8 s recorded **8,333 `write` calls and zero `fdatasync`/`fsync`**. No stream was running, no DB write was
committing, and the renderer still held ~95%. Per-thread accumulated CPU puts the cost in the renderer's **JS
main thread** (19,823 s) plus **GPU/compositor** (5,976 + 5,751 `SkiaGPUWorker` + 3,865 `ThreadedCompositor`);
instantaneously 39% JS + 35% GPU + 11% compositor. §3.

**Both suspects the issue named are answered, and one is eliminated.**

- **DB size — ELIMINATED, and the mode is the real cost.** Single-transaction write latency shows **no clear
  dependence on database size between 400 MB and 700 MB** (16.8 ms vs 14.3 ms interleaved — within this run's
  noise), because an indexed insert touches one leaf plus the journal with no scan. The known-gaps doc asks
  "what does a 687 MB database do to write cost" — the answer is *nothing much*. What costs 100× is the
  **journal mode**: the app ships rollback-journal + `synchronous=FULL` at ~14–17 ms per commit against
  ~0.12 ms for WAL + `NORMAL`. §4.
- **The SQLite write path — real, but for a different reason than suspected.** `TranscriptPersister::apply`
  (`fulcrum-harness-0.2.0/src/persist.rs:117`) writes **per frame with no batching**, and `Db::open` **never
  enables WAL** (no `journal_mode` pragma anywhere in `src-tauri/src`; the live DB has a `-journal` file, not
  `-wal`), so every commit pays 3 fsyncs at ~14–17 ms. Batching a thousand rows into one transaction is worth
  two to three orders of magnitude per row. This is a real defect that throttles frame delivery — it is not what
  pegs a core while idle. §4.

**The requester's hypothesis ("loading too much history at once") found the right class of cause and the wrong
knob.** Paging already ships — `INITIAL_HISTORY_PAGE = 500`, `OLDER_HISTORY_PAGE = 200`
(`src/store/sessions.ts:45-46`, ADR 0073) — and the load it performs costs **6–20 ms**, which cannot peg a
core. Two corrections: **rows are not the cost, bytes are** (one `tool-call` row measured 1,179 KB; 256 rows
exceed 100 KB; the session with 3× the rows loads 4× cheaper), so a row-count limit is the wrong instrument and
a **byte budget** is the right one. **But the second half of the hypothesis — "proactively pop the buffer" — is
the largest unaddressed leak found**, and ADR 0073 rejected it on grounds that need re-litigating rather than
repeating. §7.

---

## Findings

### 1. The reproduction, in full

Measured on this machine (Linux, `niri` compositor, 8 cores, NVMe `/home`), against the installed
`archimedes.appimage` (v0.13.0), 2026-11-14.

| Process | Accumulated CPU | Note |
|---|---|---|
| `WebKitWebProcess` (1790208) | **41,089 s** | the renderer — reporter's #1 suspect shape |
| `archimedes` (1790154) | 23,294 s | the Rust host |
| `WebKitNetworkPr` (1790180) | 77 s | |

Elapsed 38 h 11 m → **29.8% of one core sustained since launch**. Fine-grained sampling while this session was
otherwise doing nothing: `112 100 96 102 105 103 98 98 104 99 96 100 102 101 94 95 99 98 93 98` (% of one
core, 1 s apart). RSS 425 MB.

Per-thread accumulated CPU inside the renderer:

```
19823s WebKitWebProces   ← JS main thread
 5976s SkiaGPUWorker
 5751s SkiaGPUWorker
 3865s eadedCompositor
 2570s WebKitWebP:cs0
  821s ReceiveQueue
```

Instantaneous over 10 s: `39% JS main · 18% + 17% SkiaGPUWorker · 11% ThreadedCompositor · 8% cs0`.

**MEASURED.** The JS main thread is the single largest consumer, and a third of the burn is GPU/compositor — a
continuously-repainting surface, not a one-off computation.

### 2. Why typing stays smooth and everything else stutters — CONFIRMED mechanically

The premise `docs/features/transcript-render-perf-known-gaps.md` §2 left open ("measure first: the benefit is
real only if composer keystrokes actually re-render `ChatStream`") is **true**:

- `draft` is `useState` **inside** `ChatStream` (`src/components/ChatStream.tsx:245`).
- `ComposerRow` is a plain un-memoised child receiving `draft`/`setDraft` (`ComposerRow.tsx:35`, rendered at
  `ChatStream.tsx:700-706`).
- `grep -c useMemo` → **0** in `ChatStream.tsx` **and** `src/components/chat/MessageList.tsx`.

So a keystroke re-renders the whole transcript subtree, and per render this runs over **all N messages**:

| Work | Site | Memoised? |
|---|---|---|
| `groupConsecutiveFileWrites(messages)` | `ChatStream.tsx:632` | no — returns fresh objects, so **`units` identity changes every render** |
| `unitKeys(units)` | `MessageList.tsx:330` | no |
| `turnDiffs(messages)` | `useChatSessionDerivations.ts:81` | no — doc says "Deliberately UNMEMOISED" |
| `anchoredAskRequestIds(askRequests, messages)` | `chatSessionDerivations.ts:49-62` | no — **A×N** |

**MEASURED** (real modules, `node --experimental-strip-types`, 100 reps averaged, synthetic 5-kind mix,
800-char texts): the full chain costs **0.17 ms @ N=500 → 0.36 ms @ N=2000 → 3.18 ms @ N=10000**. Monotonic in
N, real, and **far too small to be the peg** — which is exactly why typing can still feel smooth.

The input stays smooth because it is a small controlled `<textarea>` **outside** the virtualized subtree: a
keystroke mounts no rows and triggers no measurement, whereas scrolling, expanding a card, or a permission
prompt arriving all do. `App.tsx:586-600` renders `ChatStream`, `SidePane`, `SubagentDetailHost` and
`SubagentModals` as siblings in **one webview document**, and `PermissionPrompt` renders inside the transcript's
Virtuoso **Footer** (`MessageList.tsx:69,663` → `TranscriptFooter.tsx:43`). One main thread, so a long task
anywhere makes every pane sticky. **VERIFIED-BY-READING.**

### 3. What actually burns — ranked, with the idle-peg confound stated

**Idle timers are REFUTED as the cause.** `grep -rn "setInterval" src --include=*.ts* | grep -v "\.test\."`
returns exactly four, all gated: `braille-loader.tsx:79` (inside `WorkingIndicator`, which returns `null` when
idle), `Reasoning.tsx:154` (`isOpen && isStreaming`), `SubagentDelegatingCard.tsx:402` (`hasRunning`),
`ProviderAuthSection.tsx:238` (Settings, `devicePending`). The braille loader writes `textContent` through a
ref — no React render at all. `EmptyStateFilm`'s WebGL/rAF loop is gated on `units.length === 0`
(`MessageList:834-843`) **and** on `visible && focused && onScreen` (`EmptyStateFilm.tsx:664`), so it cannot
run with a transcript open.

**⚠️ THE CONFOUND, and it is load-bearing.** Those "idle" samples were taken while *this* agent session was
active, so working spinners were mounted. The `strace` (0 fsyncs) and the idle workers rule out **streaming**
and the **DB**, but they do **not** rule out "an always-mounted CSS animation costs a full core". That is
itself a candidate finding, and it is the cheapest test available:

- `Spinner` is `animate-spin` (`src/components/ui/spinner.tsx:9`) and `SessionStatusMark` renders one **per
  session row** (`SpaceTabs.tsx:558`, `SpacesList.tsx:926`, `TaskDetailDialog.tsx:748`);
  `SubagentStatusIcon.tsx:26` adds `animate-spin` per subagent.
- The 35% GPU + 11% compositor share is the signature of continuous repaint, which is what an infinite CSS
  animation on a `will-change`/`translateZ(0)` layer produces.
- **Free A/B test:** disable the animations (`prefers-reduced-motion`, or comment the class) and re-sample
  `/proc/<pid>/stat`. If the peg drops, the idle burn is named. **This was offered to the requester and
  deferred to the plan; it should be the plan's first step.**

Amplifiers, by evidence quality:

1. **`SubagentDelegatingCard` subscribes to the entire `s.messages` map** (`:118`), so every streamed token of
   **any** session re-renders every visible card; per row it runs `estimateTokensFromMessages` over a whole
   transcript (`:296`) and `sessionMessages.filter(...)` (`:344`). It is **not** `memo`'d (`:98` is a plain
   `export default function`).
   **MEASURED, and the cost is shape-dependent, not size-dependent** — `rawOutput` as a **string** is cheap, as
   an **object** it triggers `JSON.stringify` per call:

   | `rawOutput` | N=200 | N=1000 | N=3000 |
   |---|---|---|---|
   | string | 0.04 ms | 0.22 ms | 0.37 ms |
   | object | 0.38 ms | 1.94 ms | **6.24 ms** |

   A researcher reported 26.8 ms @ N=3000. **I could not reproduce that and trust my own numbers**; the 17×
   string/object spread is the mechanism it was reaching for. Real transcripts carry object `rawOutput`, so the
   object column is the live path.
2. **Virtuoso rebuilds its offset tree in O(total measured items) per measurement** — `dist/index.mjs:714-737`
   slices the tree at the changed index then pushes one entry per size range to ∞, called from `:680-705` on
   every item measurement. Aggravators **VERIFIED-BY-READING**: no `defaultItemHeight`
   (`grep -n "defaultItemHeight\|totalHeightEstimate\|fixedItemHeight" src/components/chat/MessageList.tsx` →
   no match), so the library takes its documented "probe" path; `increaseViewportBy={{top:600,bottom:600}}`
   (`:644`) roughly triples mounted rows; `context`, `components` and `itemContent` are fresh identities every
   render (`:653-668`), defeating any `memo` bailout. **INFERRED — read from shipped `dist`, not instrumented.**
   This is the mechanism that makes cost scale with **total** history rather than visible rows, and it is why
   virtualization does not save you here.
3. **Per-row work redone on mount.** `CodeBlock` keeps `codeToHtml` output in component-local `useState`
   (`AgentMarkdown.tsx:262-300`), so scrolling a code block out and back **re-highlights it**; `DiffBlock` is
   `memo`'d but does `patch.split("\n")` and emits **one `<div>` per line** (`DiffBlock.tsx:68`), so a 20k-line
   patch creates 20k nodes (split+scan measured 1.79 ms; the DOM cost, unmeasured, is what "expanding feels
   delayed" describes); `FileSummaryCard` re-runs `parseDiffStats` per render off the un-memoised `turnDiffs`;
   `ChangesGroupCard` runs a `ResizeObserver` + `getBoundingClientRect` in `useLayoutEffect` (`:100-140`),
   forcing layout per visible group.
4. **Scroll-geometry reads on the hot path**, the signature the OpenAI trace named: `MessageList.tsx` reads
   `clientHeight`/`scrollHeight`/`scrollTop` at `:180`, `:213`, `:389-395`, `:541-543`, `:571`; `Reasoning.tsx`
   runs two `ResizeObserver`s (`:348`, `:527`) whose callbacks write `scrollLeft`/`scrollTop` on the observed
   nodes. **A feedback loop is plausible but NOT established** — the RO callbacks write *scroll* offsets, not
   *content-box size*, so they should not retrigger the observer. Listed as a gap.

### 4. The two named suspects

**DB size — ELIMINATED.** I ran this benchmark **twice, with different results, and both are reported** — the
disagreement is itself the cautionary finding.

Schema mirrored from `db.rs:3681` (`messages` + `UNIQUE(session_id,kind,message_key)` +
`idx_messages_session`), ~2 KB payloads drawn from the real row-size distribution, one small
`BEGIN IMMEDIATE` / 1 INSERT / `COMMIT` probed with the `total_changes` guard (see the trap below).

**Run A — cold-built DBs, each measured once after its own bulk build** (10 / 100 / 400 / 700 MB targets,
25 reps each, `journal_mode` and `synchronous` re-read back from the connection to confirm the setting took):

| DB size | on disk | delete-journal/FULL | WAL/FULL | WAL/NORMAL |
|---|---|---|---|---|
| 10 MB | 11 MB | **3.77 ms** | 1.25 ms | 0.10 ms |
| 100 MB | 106 MB | 3.90 ms | 1.24 ms | 0.06 ms |
| 400 MB | 421 MB | 3.96 ms | 1.34 ms | 0.12 ms |
| 700 MB | 738 MB | **19.34 ms** | 1.64 ms | 0.06 ms |

Flat from 10→400 MB, then a **5× jump at 700 MB** in the shipped mode. That jump is why I did not stop here.

**Run B — the same two DBs measured INTERLEAVED** (6 alternating rounds of 10 reps, so disk-cache state and
thermal drift hit both conditions equally; n=60 per cell):

| DB size | delete-journal/FULL median | p90 | max | WAL/NORMAL median | max |
|---|---|---|---|---|---|
| 400 MB | **16.81 ms** | 148.5 ms | 2539 ms | 0.16 ms | 15.8 ms |
| 700 MB | **14.25 ms** | 52.1 ms | 2515 ms | 0.12 ms | 13.1 ms |

**Run B contradicts Run A's headline, and Run B is the one to believe.** At 400 MB the interleaved median is
16.8 ms — the *same* as 700 MB — so the 3.9 ms at 400 MB in Run A was a **warm-page-cache artifact of building
the smaller DB last**, not a size effect. Conclusion, stated at the confidence the data supports:

- **Between 400 MB and 700 MB there is no detectable size dependence** in single-commit latency. **MEASURED,
  interleaved, n=60.** (Unmeasured above 700 MB: the run at 900 MB timed out on this machine, so the 2.33 GB
  live DB is *outside* the measured range — do not read this as "flat all the way to 2.33 GB".)
- **The ~5× "jump" in Run A does not replicate and is not a size effect.** What survives is a weak decline, so
  the honest reading of the size question is **flat-within-noise**.
- **The robust finding is the ratio, not the absolute.** delete/FULL vs WAL/NORMAL is **~100×** (14–17 ms vs
  ~0.12 ms) and delete/FULL vs WAL/FULL is **~11×** (14–17 vs 1.1–1.6 ms). Ratios survive load; absolutes do
  not — Run B's delete/FULL **maxima hit ~2.5 s** because other work was competing for the disk during the
  run. **Quote the ratios; never quote these millisecond absolutes as a machine-independent figure.**

**And a third number, from a researcher, disagreed with both.** The dispatched benchmark angle reported ~36.9 ms
per commit; my own figures are 3.8–19.3 ms (Run A) and 14.3–16.8 ms (Run B). I could not reproduce theirs and
report my own, but the direction of *all* measurements agrees, and the direction is the only part that matters
for the decision: **per-commit cost in the shipped configuration is measured in tens of milliseconds, and the
stream produces commits far faster than that.**

**The write path — a real defect, misdiagnosed in kind.** Verified:

- `TranscriptPersister::apply` (`fulcrum-harness-0.2.0/src/persist.rs:117`) does **one `record_message` per row
  in a loop** and **one `insert_native_message` per frame**, with no transaction wrapper and no coalescing.
  `grep` for throttle/debounce/coalesce across the crate → 0 hits.
- **WAL is never enabled.** `grep -rn "journal_mode\|WAL\|wal_autocheckpoint" src-tauri/src --include=*.rs`
  (excluding comments/tests) → **empty**; the only pragma in `db.rs` is `foreign_keys` (`:905`). Confirmed at
  runtime: the live data dir holds `archimedes.db-journal`, **not** `-wal`.
- Measured consequence: **delete-journal + `synchronous=FULL` costs ~11× WAL+FULL and ~100× WAL+NORMAL** at
  identical size (Run B above: 14–17 ms vs 1.1–1.6 ms vs ~0.12 ms). `strace` shows a real commit in that mode
  issuing **3 `fdatasync`** calls (researcher's `strace`; my own 8 s trace of the *idle* host showed **zero**
  fsyncs, which is consistent — nothing was committing). Per-frame commits therefore pay 3 fsyncs per stream
  update for durability the app does not need.
- **Batching is the highest-leverage single change.** A researcher measured 1000 rows in ONE transaction at
  ~700 MB at **39.5 / 21.4 / 10.8 ms** (delete / WAL-FULL / WAL-NORMAL) — i.e. one commit's cost buys a
  thousand rows — against **~14–17 ms per commit** measured here in the shipped mode, so batching is worth
  roughly **two to three orders of magnitude per row**. I did not re-run the batch side, only the per-commit
  side; the direction is unambiguous and the ratio is the point.
- At the documented ~1000 chunks/sec (`src/lib/batchSessionUpdates.ts` doc comment) coalesced to ~60/sec, a
  per-frame commit at the measured 14–17 ms **oversubscribes the writer by ~1× at 60/sec and by ~17× at
  1000/sec**: 14 ms of DB work per 16 ms of frame budget, before anything else runs. **INFERRED from two
  separately-measured numbers, not measured end to end.**
- `wal_checkpoint(TRUNCATE)` at 703 MB costs **81 ms** (WAL) — a real whole-window stall candidate at the
  default ~1000-page autocheckpoint, i.e. roughly every ~3 s under load. **Researcher's measurement, not
  re-run here.** Note it only becomes reachable once WAL is enabled, so it is a cost the WAL fix must plan for,
  not a reason to skip it.
- **Reads and writes serialize on ONE `StdMutex<Connection>`**: `load_native_messages` (`db.rs:1671`),
  `list_sessions` (`:1437`), `session` (`:1397`), `record_message` (`:1381`), `insert_native_message` (`:1656`).
  And `grep -c spawn_blocking` → **0** in both `commands/history.rs` and `commands/sessions.rs`, with
  `SessionManager::list_sessions` calling `db.list_sessions(...)` inline in an `async fn`
  (`agent/session/mod.rs:1657-1659`) and `load_history` likewise (`history.rs:87-93`). So a UI-triggered read
  blocks a **tokio worker thread** behind a per-token writer. **MEASURED (grep counts) + VERIFIED-BY-READING.**
- **No FTS table exists** → FTS maintenance cost is zero. Hypothesis eliminated.
- WAL readers do not block writers: writer median 7.26 ms alone vs 7.45 ms with a reader doing 118
  `COUNT(*)`/sec on a second connection — noise.

**A benchmarking trap worth keeping — it bit twice in one session.** The first harness run reported
`delete/FULL` at 15 µs: a duplicate `message_key` had made `INSERT OR IGNORE` a no-op, and **an empty
transaction commits with no fsync at all**. My own rewrite caught the same class of bug twice — first a
duplicate key, then reading `total_changes` *after* the insert so the delta was always 0 and the assert fired
on every single probe. The guard has to read the counter **before** the write:

```python
before = c.total_changes          # BEFORE, not after
c.execute("BEGIN IMMEDIATE"); c.execute("INSERT …"); c.commit()
assert c.total_changes - before == 1, "empty transaction - measured nothing"
```

A naive SQLite benchmark passes green having measured nothing. And the *second* trap is subtler: **if you
measure each condition once per database, build order silently becomes a result** — that is exactly how Run A's
fake 5× size effect was manufactured. Interleave, or measure nothing.

**Live DB census** (this machine, `archimedes.db`, **2.33 GB** — 3.4× the reporter's 687 MB):
354,777 `messages`, 323,837 `native_messages`, 2,247 `sessions`, 2,202 sessions with rows.
`PRAGMA page_size`=4096, `page_count`=569,758, **`freelist_count`=21,643 → 88.7 MB of pages never reclaimed**.
Nothing vacuums, prunes, or caps; `clear_native_messages` runs only on the compaction rewrite path; archived
sessions keep their transcripts.

### 5. The renderer process count

The reporter's "25 processes at 2.4 GB" cannot support the inference drawn from it. WebView2 is Chromium's
multi-process model — browser, GPU-process, utility-process, crashpad-handler and per-site-instance renderers
all share the `msedgewebview2.exe` image name, **and so does every other WebView2 application on the machine**.

**The census of webview-creating sites in this app is one.** `WebviewWindowBuilder::new` appears at exactly
`src-tauri/src/agent/web/render.rs:135` — a hidden 1280×900 window labelled `web-fetch-render-<request_id>`.
No JS-side `new WebviewWindow` in `src/` (`grep` → 0 non-test hits). No other window builder in
`src-tauri/src`.

**The leak hunt came back mostly clean, with one real hole.** `render.rs` guards the window with a `Drop` impl
calling `destroy()` (`:205-206`), and `destroy()` does tear the renderer down (Tauri's close → tao
`TaoWindowEvent::Destroyed` → registry removal). But there are **five pre-build early returns** (`:68`, `:78`,
`:89`, `:109`, plus the dispatch failure at `:181`) and — the real one — a **5 s `tokio::time::timeout` on
`win_rx`** (`:170`). If the main thread is stalled and the timeout fires *after* the window was built,
`render()` returns at `:194` **with no guard constructed**, and the eventual `Ok(w)` is dropped inside the
failed `win_tx.send(Ok(w))`. `WebviewWindow` has **no `Drop` impl**, so a dropped-but-not-destroyed window
leaks. **VERIFIED mechanism, INFERRED trigger** — and note the trigger is a stalled main thread, which is the
symptom, so this is plausibly an *amplifier* of jank rather than its origin. `let _ =` on `destroy()` hides
failure.

`.window-state.json` **cannot** resurrect windows: `should_track_label` (`navigation_guard.rs:165`) returns
false for `web-fetch-render-*`, and the plugin never creates windows. **That hypothesis is dead.**

**The correct instrument**, handed to the reporter: count **only `Type=renderer`, grouped by user-data-folder**,
and read PPID upward to confirm the tree belongs to `archimedes.exe`:

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ForEach-Object {
  $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }
  $u = if ($_.CommandLine -match '--user-data-folder="?([^"\s]+)') { $Matches[1] } else { 'default' }
  [pscustomobject]@{ PID=$_.ProcessId; PPID=$_.ParentProcessId; Type=$t; UDF=$u
    CPUsec=[math]::Round((Get-Process -Id $_.ProcessId).CPU,0)
    WS_MB=[math]::Round($_.WorkingSet64/1MB,0) }
} | Sort-Object UDF,Type | Format-Table -Auto
```

Microsoft's supported per-webview enumeration is `CoreWebView2.OpenTaskManagerWindow` /
`ICoreWebView2Environment13::GetProcessExtendedInfos` (present in `webview2-com-sys-0.39.1`), **not exposed by
wry 0.57** — so there is no supported in-app path today.

**On the CPU-seconds themselves:** they are *cumulative since process start*, so a high figure proves sustained
load, not instantaneous load. This machine's 41,089 s proves the sustained half directly, by sampling. The
render webviews live ≤5 s and inject one non-looping `eval`, so they are not an obvious source of tens of
thousands of seconds — and the live reproduction shows the burn is in the **main** window's renderer anyway.

### 6. Platform generality

The live WebKitGTK reproduction (§1) is the strongest available evidence and it says: **same symptom, same
engine family, different vendor.** The mechanism — one webview's main thread saturated, one document holding
every pane — is app-level, not vendor-level, because `App.tsx` renders every pane as a sibling in one webview.

The reporter's own analogy was right: *"The README itself documents Linux DMABUF rendering jank; this is the
Windows WebView2 counterpart."* The relationship runs the other way — the Linux rendering notes and this bug are
both about the same compositor, and this machine (which is Linux, with no overrides set) reproduces the CPU peg.

**GAP, stated plainly:** the angle dispatched to establish the per-engine threading model — specifically
*whether the JS main thread is ever the same OS thread as the window message loop on Windows in Tauri 2* —
**was cancelled and never returned.** So the claim "one saturated webview starves window messages for the whole
window on Windows specifically" is **UNRESOLVED as to mechanism**, though the symptom is observed on two
engines. `run_on_main_thread` is used at `render.rs:134` and `:278`, which shows the app dispatches webview work
to the Tauri main thread; it does not establish the WebView2 JS-thread identity. Do not build a
platform-conditional fix on that gap.

### 7. The history-load hypothesis — right class, wrong knob, and one big true leak

**Paging already ships** and the card's premise predates it: `INITIAL_HISTORY_PAGE = 500`,
`OLDER_HISTORY_PAGE = 200` (`src/store/sessions.ts:45-46`), cursor = `messages.id`, `has_more` via an n+1 probe
(`db.rs:1649-1668`), documented in **ADR 0073** (`docs/decisions/0073-…-history-window…md`). `limit: None` does
mean no `LIMIT` clause at all (`db.rs:1672-1680`) — an unbounded path that exists but that the frontend never
takes (all three `loadHistory` call sites pass a limit).

**Measured against this machine's real DB** (production SQL, snapshot, 7 reps, medians, SQL and JSON-parse timed
separately):

| session | rows | MB | limit 15 | limit 500 | unlimited |
|---|---|---|---|---|---|
| `313c82f3` | 727 | 5.8 | 0.2 + 0.4 ms | **5.2 + 11.7 ms** | 6.5 + 15.8 ms |
| `f464db6c` | 547 | 5.2 | 0.2 + 0.5 | 5.9 + 13.7 | 6.4 + 16.6 |
| `f396f1e5` | 2292 | 4.1 | 0.1 + 0.1 | 1.2 + 2.5 | 8.3 + 14.9 |
| `bcc2c5f7` | 250 | 4.0 | 0.3 + 0.6 | 3.7 + 8.5 | 3.7 + 9.0 |

So `limit 15` would turn **6–20 ms into ~0.5 ms**. It cannot be the peg. Two corrections follow:

- **Rows are not the cost; bytes are.** The largest single row measured **1,179.7 KB** (a `tool-call`); 256 rows
  exceed 100 KB; one exceeds 1 MB. `f396f1e5` has **3× the rows** of `313c82f3` but loads **4× cheaper**,
  because it has a quarter of the bytes. A row-count limit is the wrong instrument; a **payload-byte budget** is
  the right one, and it is what `has_more`/cursor paging can support unchanged.
- **`list_sessions` is unbounded and it is not the problem either** — 2,247 rows, `SELECT *` median **3.3 ms**.
  A space switch is cheap on the Rust side.

**Where the hypothesis is right, and it is the largest leak found: the buffer is never popped for main
sessions.**

- `discardSessionMessages` returns immediately for any id with no `SubagentEntry` — `if
  (!useSubagents.getState().entries[sessionId]) return; // main: keep` (`sessions.ts:85`).
- The close path clears only `maps: ["inTurn", "stalled", "compacting"]` (`:2478`); `messages` **is** in
  `SESSION_KEYED_FIELDS` (`:478-490`) but is opted out here. Only `deleteSession` (`:1924`) passes the full set.
- ADR 0073 **explicitly rejected** a sliding window.

**Measured cost of never popping:** worst-12 opened sessions retain **39.2 MB** of `payload_json`; **all**
sessions' 500-row windows total **1,109 MB** (×2–3 as JS objects, plus retained DOM). That is the memory growth
and the GC pressure, and it is unbounded across a long-lived window.

**But ADR 0073's rejection reasons are live and must be re-litigated, not ignored:** (a) a streaming tail cannot
be evicted; (b) the ADR 0050 resume merge would need rework. And ADR 0073's own Consequence already accepts a
related loss — *"Virtualization drops row-local state for rows scrolled far away"* — so a buffer eviction is not
automatically disqualifying, it is a trade-off with precedent. **Any plan here owes an answer to both reasons.**

### 8. Precedent, and what it does and does not give us

**No comparable app has published a confirmed root cause for jank-while-streaming.** The issue's citation is
therefore *unresolved*, and saying so is the finding:

- **`openai/codex#58654`** — the closest match in the world, on Windows: frames ~278 ms, gesture-scroll latency
  243 ms, hot paths `reconcileViewport`, `scrollHeight`/`clientHeight` reads, `getBoundingClientRect`, console
  flooded with *"ResizeObserver loop completed with undelivered notifications"*. **Root cause "not confirmed" by
  OpenAI.** Our code reads the same geometry on the same hot path (§3.4). **VERIFIED that it is unconfirmed.**
- **`openai/codex#20864`** — the one **solved** case, and it is the one that backs the requester: Desktop
  eagerly scanned all `~/.codex/sessions` (109 files / 78 MB); *"Clearing or moving files out… immediately fixes
  the Desktop UI lag."* Note the class — **O(app-data) work re-paid on a UI path**, i.e. data growth, not
  streaming. Our analogue would be a 2.33 GB DB scanned on a UI path; §7 measured ours at 3.3 ms, so we do not
  have that bug.
- **`microsoft/vscode#316407`** — *"becomes noticeably laggy as message history grows"*; suggested fix is
  virtualize/lazy-render. **Open, not root-caused, and its proposed fix already ships here** — so this
  precedent does not explain persistence.
- **Method precedent**: `openai/codex#43726` / `#56941` isolated the cause by **process-level A/B kill**
  ("terminating only `codex-computer-use.exe`… responsiveness returned immediately"). Cheapest causal test
  there is, and free for us.

### 9. The measurement protocol (what to ask the reporter for)

Priority order; each names what it rules out. Steps 1–3 are the three numbers the issue has been asking for.

1. **Renderer process split** — the PowerShell above. Rules out / confirms a leak, by splitting `--type=` and
   grouping by user-data-folder. **Rules out** the §5 counting artifact.
2. **WebView2 runtime version** from `edge://version`, and Evergreen vs Fixed. **Rules out** a runtime-version
   regression.
3. **Attach DevTools**: `set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` **before
   launch**, then `edge://inspect`. If attach fails, the env var was swallowed — **that is itself a finding**,
   because a shipped build with no `devtools` feature exposes nothing otherwise. **Rules out** "unmeasurable".
4. **★ One trace** — DevTools Performance, 10 s of one streaming response, **no throttling**, Bottom-Up the
   longest main-thread task. Dominant `UpdateLayoutTree`/`Layout`/`Recalculate Style` → layout thrash (the
   #58654 signature); `MajorGC` wedges → allocation churn; main thread idle but frames dropped → compositor/GPU
   back-pressure. **Rules out three hypotheses in one shot.** This is the single cheapest discriminator.
5. **Keystroke attribution** — React DevTools Profiler + "Highlight updates", type one character. **Rules out /
   in** per-keystroke whole-tree re-renders — the discriminator the issue has never run.
6. **GPU bisect** — relaunch with `--disable-gpu` (troubleshooting only, never a fix). **Rules out** the
   hybrid-graphics compositor class (the reporter runs an RTX 4070 **plus** onboard AMD — a known source of
   compositor stalls).
7. **System trace only if 4–6 are clean** — `wpr -start cpu` … `wpr -stop jank.etl`, or `WebView2.wprp`,
   grouped by process. **Rules out** browser-process / DWM-side delay.

Report items 1, 3 and 4 together and the issue stops being unexplainable.

**Already shipped — do not re-propose** (verified present in the reporter's v0.9.2 by
`git merge-base --is-ancestor` in `docs/features/transcript-render-perf-known-gaps.md` §1): `react-virtuoso`
virtualization (`MessageList.tsx`, PR #67), per-frame coalescing to one `setState` per rAF
(`src/lib/batchSessionUpdates.ts`), the `web-fetch-render-*` window-state filter (`should_track_label`), and
`memo(DiffBlock)` (shipped after, from PR #164).

---

## Unresolved contradictions

1. **The SQLite benchmark disagrees with itself across runs, and I report both.** Cold-built Run A said 3.9 ms
   at 400 MB and 19.3 ms at 700 MB (a 5× size effect); interleaved Run B said 16.8 ms at 400 MB and 14.3 ms at
   700 MB (no size effect). **Run B wins** — Run A's low 400 MB figure is a warm-cache artifact of build order.
   A third figure, the researcher's ~36.9 ms/commit, matched neither. **Lesson kept: a SQLite benchmark must
   interleave its conditions, and its absolute millisecond figures are not portable off the machine — only the
   ratios are.** §4.
2. **`estimateTokensFromMessages` cost: 6.24 ms vs 26.8 ms @ N=3000.** A researcher reported the higher figure
   for a "realistic 3 KB tool output"; my reproduction of the same function gives 0.37 ms (string) / 6.24 ms
   (object). I could not reproduce theirs and I report my own measurement. **The disagreement is informative
   either way** — the discriminator is whether `rawOutput` is a string or an object, because the object path
   `JSON.stringify`s per call. Both agree the shape matters more than N.
3. **Is the idle peg animation or a leak?** §3's confound is not resolved. `strace` (0 fsyncs) and idle workers
   rule out streaming and DB; they do not rule out always-mounted infinite CSS animation. The A/B test is free
   and unbudgeted.
4. **`freelist_count` 21,643 (this snapshot) vs 22,973 (a researcher's snapshot).** Different copies of a
   live-growing DB; both are correct for their own instant. Cited: mine, with the command.
5. **Is the `render.rs` timeout leak an origin or an amplifier?** The trigger (a stalled main thread) is the
   symptom, so the causal direction is genuinely open.

## Gaps

- **Nothing is measured above 700 MB.** The 900 MB run timed out on this machine, so the 2.33 GB live DB sits
  **outside** the measured range. The size-elimination claim is proven for 400–700 MB and *assumed* to hold to
  2.33 GB.
- **The batch-write numbers (1000 rows in one txn, 81 ms checkpoint) are the researcher's, not re-run here.**
  Only the per-commit half is mine.
- **No Windows measurement at all.** Every Windows claim is the reporter's, quoted. This machine is Linux;
  `cargo check --target x86_64-pc-windows-gnu` type-checks `#[cfg(windows)]` but nothing here runs it.
- **The platform-generality angle was cancelled**, so §6's threading-model question — is the WebView2 JS thread
  the window message loop in Tauri 2? — is **UNRESOLVED**, and §6's "one document, one main thread" argument is
  about the *JS* thread, which is solid, and says nothing about the *native* message loop, which is the part
  that would explain whole-window stickiness at the OS level.
- **Virtuoso's O(measured-items) rebuild is INFERRED from shipped `dist`, not instrumented.** It is the leading
  explanation for "cost scales with total history, not visible rows", and it is unproven.
- **The idle spinner/animation A/B test has not been run** — the cheapest decisive experiment available.
- **No DOM-cost measurement.** `DiffBlock`'s 20k-node expansion and re-highlight-on-remount are read from
  source; their real cost, which is what "expanding feels delayed" names, is unmeasured.
- **`synchronous` is not set anywhere in `db.rs`**, so it is SQLite's default (`FULL` for rollback-journal
  mode) — INFERRED from zero code hits plus SQLite's documented default, not read from a pragma statement.
- Whether the 2.33 GB DB on **this** machine is representative of the reporter's 687 MB is assumed, not
  verified; row-size distributions here are measured, theirs are not published.

## Corrections since publication

- **The report's own SQLite size claim was wrong on first draft and is corrected here.** The dispatched
  benchmark angle reported write latency "flat with DB size" at ~36.9 ms/commit, and my first cold-built run
  appeared to *refute* it with a 5× jump at 700 MB. The interleaved re-run refuted **me**: the jump was a
  build-order cache artifact. Both runs and the resolution are in §4; the ~100× mode ratio is what survives.
- A researcher's **26.8 ms @ N=3000** for `estimateTokensFromMessages` did not reproduce (mine: 6.24 ms with
  object `rawOutput`, 0.37 ms with string). §3.1 reports both and names the discriminator.
- A researcher's **22,973 free pages** differs from this run's **21,643** — both correct, different snapshots of
  a live DB. §4 cites the re-runnable command.
- The card's premise "reproduce and report WebView2 process count and DB size" turned out to be **partly
  already-done work**: paging (ADR 0073) and the `web-fetch-render-*` filter shipped, and the DB-size suspect is
  now measured flat. §7 records the ADR so a plan does not re-implement it.
