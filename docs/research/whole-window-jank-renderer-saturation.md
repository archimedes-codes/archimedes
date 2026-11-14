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
  any kind, react-virtuoso's internal cost (read from shipped `dist`, not instrumented). **Second pass 2026-11-14
  (§10, same day):** the animation A/B **has now been run twice and is NULL** (§10.4), the eventfd claim in the
  Executive summary is **withdrawn and corrected** (§Corrections, §10.2), and the peg turns out to be **episodic**
  rather than constant (§10.1). **`perf` is not installed on this machine** — the planned `perf top` step never
  ran and no figure here is perf-derived; §10 names the `/proc`/`strace` substitutes. Still not measured: a
  DevTools profile of one burst (the running 0.13.0 AppImage is read-only and has no devtools feature), and the
  animation test with the CSS classes actually commented (likewise unreachable read-only). The app under test is
  **v0.13.0, which contains NONE of the four fixes this branch shipped** — verified by CONTENT (§10 names the
  marker loop), not by commit hash: the hashes would be orphaned by this branch's squash-merge.
  **Doc-accuracy pass 2026-11-15** — every command in this report re-run; three defects corrected and
  recorded in §Corrections rather than silently rewritten: the `tw-animate.css` "no `spin`" claim (§10.4),
  the §10.5 census command that did not run as printed and could not produce one of its own four figures,
  and four per-issue commit hashes removed as squash-orphans. **This report is published on #155, so the
  published text stays wrong where it was wrong; §Corrections is the authoritative record of what changed.**
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

**The burn is not streaming-driven.** All six `archimedes --worker` processes held ~0 CPU, and `strace` on the
host for 8 s recorded **zero `fdatasync`/`fsync`** — no stream was running and no DB write was committing while
the renderer held ~95%. Per-thread accumulated CPU puts the cost in the renderer's **JS main thread** (19,823 s)
plus **GPU/compositor** (5,976 + 5,751 `SkiaGPUWorker` + 3,865 `ThreadedCompositor`); instantaneously 39% JS +
35% GPU + 11% compositor. §3.

> **CORRECTION (2026-11-14, same day).** An earlier draft of this paragraph also counted that trace's
> **8,333 `write` calls** as part of the idleness case. That was backwards and is withdrawn. Every one of those
> writes was `write(fd, "\1\0\0\0\0\0\0\0", 8)` on an `anon_inode:[eventfd]` — i.e. ~1,000 **event-loop wakeups
> per second inside an app the paragraph was calling idle**. They are evidence of internal activity, not of
> idleness, and the exclusion above rests on the zero fsyncs and the idle workers alone, which is where it
> should have rested. Re-measured and chased in §10: the storm is real, it is **~1,144/sec and flat**, and it is
> present at the same rate whether the app is pegged or not — so it is neither the idleness marker the first
> draft read it as, nor the cause of the peg.


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

> **Follow-up (§10, same day).** This table's snapshot (93–112%) was a burst. Re-measured over 600 × 1 s samples
> the peg is **episodic** — a 20.5% floor with ~2-minute bursts to 100–130%, 17% of seconds ≥90% — and the
> per-thread split above reproduces almost exactly *during* a burst (38.9% JS / 53% GPU / 10.3% compositor). The
> accumulated figures here are also superseded: renderer 41,089 s → **52,794 s**, 43.4 h, mean 33.8% of a core.

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

**UPDATE (2026-11-14, §10).** This test has now been run twice. The OS `prefers-reduced-motion` half is **NULL**
(§10.4: 87.7% → 78.2%, against a control that fell to 21.4% on its own). The class-commenting half **could not be
run** — the installed AppImage is read-only. And the confound stated above is understated: the measuring session
runs *inside* this app, so a clean idle state is not reachable from it at all (§10.1). The peg survives the agent
at verifiably 0.0% CPU, so it is real; **animations are not exonerated, because `animate-spin` — the one the
stale-status census mounts — has no reduced-motion rule and the OS flag cannot disable it** (§10.4.3).

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
  fsyncs, which is consistent — nothing was committing. **Qualification from §10:** the host is not always
  quiet — during one of the CPU bursts a 10 s trace counted **64 `fsync` + 255 `pwrite64`**, so "zero fsyncs"
  describes a quiet window, not the app in general. It does not weaken the ratio, which was measured on a
  benchmark, not on the live app). Per-frame commits therefore pay 3 fsyncs per stream
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

### 10. Re-measurement, the eventfd storm, and the reduced-motion null result (2026-11-14, second pass)

A second measurement pass on the same machine, same running app. **The app under test is v0.13.0**
(`/tmp/.mount_archimbcMJab/usr/bin/archimedes`, PID 1790154; renderer PID 1790208 — both re-derived with
`pgrep -a -f`, not assumed). **v0.13.0 contains NONE of the four fixes this branch shipped**: the
status-hydration split, the WAL/`busy_timeout`/`synchronous` pragmas plus a batched message write, the
release of a left session's transcript, and the history/session-list reads moved off the tokio workers.
**How this was checked, and a correction:** it was originally checked with
`git merge-base --is-ancestor <fix> v0.13.0`, which fails for all four — but that command needs the four
fix commits' **hashes**, and this branch squash-merges, so a hash cited here resolves today and nowhere
after the merge. **They are therefore removed from this document** (a second instance of the orphan rule
this report already flags for line citations, whose front-matter stamp exists so they can be re-checked) and
replaced by a content check that survives a
squash — each fix leaves a marker in a file that exists in the tag, and the tag has zero of all four:

```bash
for spec in "src/lib/transcript/reducer.ts:mapPersistedStatus" \
            "src-tauri/src/storage/db.rs:journal_mode" \
            "src/store/sessions.ts:releaseUnseenTranscripts" \
            "src-tauri/src/commands/history.rs:spawn_blocking"; do
  f=${spec%:*}; s=${spec#*:}
  printf "%-52s tag=%s HEAD=%s\n" "$spec" \
    "$(git show v0.13.0:$f 2>/dev/null | grep -c "$s")" "$(grep -c "$s" "$f")"
done
# → four lines, every one `tag=0` with a non-zero HEAD=
```

The tag is dated Nov 11 while the fixes are Nov 14. **Nothing in this section tests the shipped fixes.**
Live DB `~/.local/share/archimedes/archimedes.db` = 2,333,728,768 bytes.

**`perf` is not installed on this machine** (`command -v perf` → nothing), so the plan's `perf top -p <pid>`
step could not run at all. Everything below comes from `/proc` sampling, `strace -f`, and `/proc/<tid>/syscall`.
`ptrace_scope` = 0, `HZ` = 100.

#### 10.1 The instrument, and the confound that is worse than §3's

`ps` `pcpu` is a **lifetime average** and was never used as an instantaneous reading. Instantaneous values are
`utime+stime` deltas from `/proc/<pid>/stat` fields 14+15; per-thread from `/proc/<pid>/task/*/stat`, split on
the **last** `) ` — the kernel truncates `comm` to 15 chars and it can contain parentheses, so naive field
extraction silently returns 0. (That bug bit twice in this pass and produced two pages of convincing zeros.)

**The confound is structural, not incidental: this measuring session runs INSIDE the app being measured.**
`archimedes --worker` PID 2312298 has PPID 1790154 — the host. My own output is rendered by the renderer whose
CPU I am measuring. A "truly idle app" is therefore **not reachable from this session**; §3's confound cannot be
removed, only bracketed. Both states were therefore measured explicitly, with my worker's own CPU sampled
alongside:

| State | How it was forced | Renderer % of core | My worker |
|---|---|---|---|
| Streaming | emitted a ~8 KB transcript delta | 13.9 → 114.7 → 115.8 → 111.9 (mean 39.0%, n=22) | active |
| 45 s after stream ended | slept | **mean 106.4%** (n=45, range 41.6–130.6) | 0 |
| 120 s, worker sampled every 1 s | slept | first 60 s **128.4%**, last 60 s **100.3%**; 117/120 samples ≥90% | **0.0% in all 120 samples** |
| 30 s, nothing attached | slept | **4.7%** | 0 |
| 1 s × 20, quiet window | slept | 3.0 1.0 2.0 11.9 2.0 3.0 1.0 12.9 … (mean ~5%) | 0 |

So §1's peg **replicates with the agent at verifiably zero CPU** — the §3 confound does not explain it — but it
is **not constant**. 600 × 1 s samples over 10 min: mean **41.1%**, of which **17% of seconds ≥90%** and **66%
≤25%**. Baseline (samples <60%, n=447) is **20.5%** (min 10.9, max 59.8). The peg is **episodic**: bursts of
27 s, 57 s, 49 s at 86.7 / 108.5 / 113.2% means, starting ~every 2 min, **not periodic**. "Sustained while idle"
in this report's title is true of the *average* and misleading about the *shape*: the honest shape is a ~20%
floor with ~1–2 minute spikes to 100–130%. **This is the single most important correction in this section — any
fix measured against a 20-second window will read as a success or a failure at random.**

Per-thread composition **during** a burst (10 s window), which reproduces §1's split almost exactly:

```
38.9%  24961s acc  WebKitWebProces   ← JS main thread
27.5%   7786s      SkiaGPUWorker
25.5%   7498s      SkiaGPUWorker
10.3%   5052s      ThreadedCompositor
 7.3%   3339s      WebKitWebP:cs0
 1.2%   1038s      ReceiveQueue
```

Accumulated totals also still climb: renderer **41,089 s → 52,794 s**, elapsed 43.4 h, mean **33.8%** of a core
(§1 said 29.8%; the window between contains my own streaming and several `strace` runs, so it is inflated).

#### 10.2 The eventfd storm: real, ~1,144/sec, and NOT the cause of the peg

The §Corrections item. Re-measured on the host, 8 s and 125 s runs, `strace -f -tt -e trace=write`:

- Every write is `write(fd, "\1\0\0\0\0\0\0\0", 8)` — an 8-byte counter, the eventfd signature. Confirmed
  verbatim, including the value.
- **The fds are on the HOST (1790154), not the renderer**: `readlink /proc/1790154/fd/4` and `/fd/38` are both
  `anon_inode:[eventfd]`. In the *renderer* fd 4 is `/dev/urandom` and fd 38 does not exist. §4's trace was
  against the host and said so, but the fd numbers are easy to misread as the renderer's.
- **A 125 s continuous capture: 130,832 host writes, mean 1,144/sec, min 589, max 1,341 — FLAT.** No step at
  burst onset, no decay. Sampled per-second rates over the whole window: `589 1213 1087 1126 … 1288 747`.
- Per-thread attribution (25 s capture, 5,277 writes): `ReceiveQueue` tid 1790218 → 2,957 (fd38 2,272 + fd4 685);
  host **main thread** 1790154 → 1,444 (fd4 820, fd38 624); `tokio-rt-worker` 1790212 → 565 (all fd4);
  `VBlankMonitor` 2209237 → 298. So the §Corrections' "tokio-rt-worker and ReceiveQueue" was right about the
  threads and missed the **main thread**, which is the second-largest writer.
- The renderer has **its own** storm on its own fds (5, 11, 28), driven by renderer main thread 1790208 and its
  `ReceiveQueue` 1790231 — ~478/sec in 8 s.
- **The discriminator: the storm is present at the same rate when the app is NOT pegged.** Three quiet-state
  rounds: **1,091 / 882 / 1,018 writes/sec** while the renderer sat at 13–16% CPU. During bursts: 2,530 and
  1,422/sec. So the peg *multiplies* the wakeups ~2–2.5×; the wakeups do not cause the peg. **A 1 kHz tick
  driving continuous repaint is REFUTED** — it would have to be absent, or far rarer, in the 20% floor, and it is
  not.
- fd 38 is a **round trip, not a timer**: in 12 s, 8,180 writes vs 6,321 reads, and **all 6,321 reads are by
  `ReceiveQueue` 1790218** while the main thread wrote 1,740 and read 0. That is a producer/consumer channel
  (WebKit IPC), not a periodic signal.
- `VBlankMonitor` and `PressureMonitor` are **WebKitGTK's own threads**, not ours — `strings` finds both names in
  `/usr/lib64/libwebkit2gtk-4.1.so.0.24.5` and neither appears anywhere in `src-tauri/src`. Do not go looking for
  them in our code.
- One incidental find worth recording: the host reads **`/proc/meminfo` 121 times/sec** (fd 40, 1,450 reads in
  12 s, every one by tid 1790206) and `/proc/1790154/cgroup` 16/sec. That is `PressureMonitor`, and it is a real
  ~121 syscall/sec of pure polling — but it is engine-side and steady, so it is not the peg either.

#### 10.3 What the burst actually is, and where this leaves the question

`perf` being unavailable, the substitute was a **poor man's profiler**: sample `/proc/<tid>/syscall` and
`/proc/<tid>/wchan` in a tight loop (no `ptrace`, so the live app is never interrupted). During a burst:

```
host main 1790154      244 poll_schedule_timeout   138 running (wchan=0)
renderer 1790208       236 poll_schedule_timeout   145 running
compositor 1790256     224 drm_syncobj_array_wait_timeout   113 poll   35 running
```

The compositor is blocked **waiting on the GPU** (`drm_syncobj_array_wait_timeout`) — consistent with the
53%-of-the-peg GPU share in §1, and the closest this pass came to a mechanism: the renderer main thread is busy
and the compositor is queueing behind it. `gdb` was available but deliberately not used — interrupting the
user's live session was out of bounds.

Burst-time host syscalls (10 s): **`futex` 1,586 calls / 9.26 s / 518 errors**, `fsync` 64, `pwrite64` 255,
`pread64` 48. So there IS DB write traffic during a burst (64 fsyncs/10 s ≈ 6.4/sec) — see the §4 qualification.
And the host is not a bystander: across 300 × 1 s samples, **burst = renderer 119.8% + host 62.1%; baseline =
renderer 15.6% + host 10.5%**, with all six long-lived workers at **0.0% for the entire 300 s**.

**Verdict: the peg is NOT named.** It is now characterised (episodic, ~2 min, host+renderer together, workers at
zero) and the following are **excluded as its cause**: streaming (workers at 0 for 120 and 300 consecutive
seconds while pegged); the eventfd/wakeup storm (flat 1,144/sec in the quiet state too); `prefers-reduced-motion`
(§10.4, null); the DB write path *as the trigger* (64 fsyncs/10 s is ~1 ms of work against a full core; it is a
passenger, though §4's mode ratio stands on its own benchmark); and agent activity of any kind.
**Remaining candidate, unproven:** something in the renderer's own paint/GPU path that enters a ~2-minute
sustained repaint episode, with the host main thread (53.2% during a burst) responding to it. The next
instrument that would actually settle this is a **DevTools Performance profile of one burst** — which requires a
build with devtools enabled, and the running 0.13.0 AppImage is mounted read-only (`ro`), so neither a profile
nor the "comment the CSS classes" experiment is reachable from here.

#### 10.4 Reduced-motion A/B: NULL, and the toggle was never going to be clean

Run on a genuinely pegged app (renderer 73–114% at baseline). Original value read and printed first:
`gsettings get org.gnome.desktop.a11y.interface reduced-motion` → **`'no-preference'`**; restored and re-verified
afterwards.

**A false start worth recording:** the key is an **enum** (`gsettings range` → `'no-preference'|'reduce'`). The
first attempt used `true` and failed with *"The provided value is outside of the valid range"* — so that run's
"during" phase **never applied anything**, and its numbers are void. Discarding them is why this subsection has
a result at all.

Valid run, 20 × 1 s per phase, renderer % of one core:

| Phase | Samples | Mean |
|---|---|---|
| A baseline (pegged) | 114.3 104.1 104.2 109.9 110.1 101.1 88.2 73.4 78.3 77.4 80.4 85.2 79.3 78.3 81.2 80.3 80.3 76.3 74.3 77.4 | **87.7%** |
| B `reduced-motion='reduce'` | 71.6 85.2 74.4 76.3 79.3 78.3 78.4 77.3 77.3 75.3 73.4 76.4 76.3 74.4 81.3 77.3 76.4 78.2 79.4 98.2 | **78.2%** |
| C restored `'no-preference'` | 41.8 43.7 19.8 22.8 24.8 33.7 17.9 29.7 16.9 29.7 18.9 15.9 12.9 11.9 14.9 16.9 14.9 16.9 11.9 12.9 | **21.4%** |

A−B = 9.5 points looks like something until phase C is taken into account: the burst was **decaying anyway**, and
C — the flag switched *back off*, i.e. animations restored — fell to 21.4%. Comparing only the contemporaneous
plateau (A's last 10 samples = 79.3%) against B (74.5%) leaves **4.8 points**, inside the run-to-run spread of
this signal (§10.1 shows the same app swinging 10.9→130.6% unaided). **NULL RESULT.** The animation hypothesis
stays refuted, now on a second, better-instrumented run.

**And the toggle was never a clean instrument** — three things the plan's framing missed:

1. In app CSS, `prefers-reduced-motion` covers **exactly two selectors**: `.animated-gradient-text`
   (`src/styles/utilities.css:70`) and `.flip-in` (`:92`). Grep confirms nothing else in `src/styles/`.
2. It also changes **JS** paths, not just CSS — `usePrefersReducedMotion.ts:29`, `braille-loader.tsx:33` and the
   `EmptyStateFilm`/`QueueRow` gates all read `matchMedia`. So the OS flag is not a CSS-only switch; it changes
   behaviour too.
3. `animate-spin` has **no reduced-motion rule anywhere**. Three non-test uses:
   `src/components/ui/spinner.tsx:9`, `SubagentStatusIcon.tsx:26`, `SessionStatusMark.tsx:161`. Tailwind defines
   `--animate-spin: spin 1s linear infinite;` at **`node_modules/tailwindcss/theme.css:438`** and neither
   `theme.css`, `index.css` nor `preflight.css` contains the string `reduced-motion`.

   **A citation in the plan was wrong and is corrected here:** it pointed at
   `node_modules/tw-animate-css/dist/tw-animate.css:438`. That file exists (14,880 bytes) but has **0 newlines**
   — it is one minified line, so line 438 does not exist. The claim was right; the location was not.
   **Second-order correction (2026-11-15): this paragraph originally went further than the evidence and said
   the file "contains no `spin` and no `reduced-motion` at all". The `reduced-motion` half is true
   (`grep -c 'reduced-motion'` → 0); the `spin` half is FALSE.** `grep -c spin` prints **1** — the file is one
   line, so that is one line and **8 occurrences**: the `spin-in` and `spin-out` enter/exit `@utility`
   definitions and their variants. They are unrelated to `animate-spin`, which the file does not define
   (`grep -c 'animate-spin'` → **0**), so nothing above this note changes — but the bare "no `spin`" phrasing
   is refuted by the obvious grep, which is exactly the mistake this report exists to catch.

**Half of the planned A/B could not be run.** The plan asked for a comparison against the animation *classes*
disabled, not just the OS flag. That requires editing the installed app's CSS, and the AppImage is mounted
**read-only** (`fuse.archimedes.appimage … ro`); rebuilding and relaunching would have destroyed the very
process being measured and is the user's live session. **So only the OS-flag half was run, and it is null.**
The class-level test remains open, and it is the one that could still distinguish "no infinite animation is
running" from "an infinite animation is running that the OS flag does not touch".

#### 10.5 Stale-status census, re-run (the mount-spinners lead)

§3's mechanism was: persisted `in_progress` tool rows → `mapStatus` → shimmer + a 1 s `setInterval` per card.
Re-run read-only against the live 2.33 GB DB (`mode=ro`, `busy_timeout`; ~4 s wall):

```
sqlite3 -cmd "PRAGMA busy_timeout=10000;" \
        "file:$HOME/.local/share/archimedes/archimedes.db?mode=ro&immutable=1" "
SELECT 'all_messages='              || (SELECT count(*) FROM messages),
       'in_progress_tool_calls='     || (SELECT count(*) FROM messages
                                          WHERE kind='tool-call'
                                            AND json_extract(payload_json,'\$.status')='in_progress'),
       'sessions_with_one_in_newest_500='
                                     || (SELECT count(DISTINCT session_id) FROM (
                                           SELECT session_id, kind,
                                                  json_extract(payload_json,'\$.status') AS st,
                                                  row_number() OVER (PARTITION BY session_id
                                                                     ORDER BY id DESC) AS rn
                                             FROM messages)
                                          WHERE rn<=500 AND kind='tool-call' AND st='in_progress'),
       'sessions='                   || (SELECT count(*) FROM sessions);"
```

**Correction (2026-11-15): the command this section printed did not run as printed, and it could not produce
one of the four figures it claimed.** Two defects, both found by running it:

1. **It was two statements and a CTE does not survive a statement boundary.** The old block was
   `WITH page AS (…) SELECT …;` followed by `SELECT count(DISTINCT session_id) FROM page …;`. A CTE is
   scoped to the statement it is written on, so the second statement dies
   `Parse error … no such table: page`. Only the FIRST number was ever reproducible from the printed text;
   the "355 sessions" figure came from a command that was not the one printed. The rewrite folds every
   count into **one** `SELECT` of scalar subqueries (the `page` CTE becomes an inline subquery).
2. **`of 186,322` had no producing command at all** — the printed SQL never counted all messages. The
   rewrite adds `SELECT count(*) FROM messages` (the `all_messages=` column).

Two smaller fixes while rewriting: `immutable=1` so the read takes no locks at all against a live app, and
the PRAGMA moved to `-cmd` so the SQL argument is one statement (note the PRAGMA still **prints its own
value**, so the first output line is `10000` and the four labelled figures are the line after it — verified
on sqlite3 3.53.4; `-cmd` does not silence it).

→ **1,064** `in_progress` tool-call rows (of 186,322); **355** sessions carry one inside their **newest 500
messages**, i.e. on the first page loaded when opening them; **2,278** sessions in the DB. The figures recorded
earlier (1,056 / 350 of 2,207, and 1,067 in `silent-turn-settle-…`) and these differ only because the DB is
live-growing; all are correct for their own instant, and the command above is the one to re-run.
**One run of it on 2026-11-15 printed
`all_messages=368,244 | in_progress_tool_calls=1,062 | sessions_with_one_in_newest_500=353 |
sessions=2,297`** — that instant, like every other, is already stale. The message table has nearly doubled
since the figures above while the `in_progress` population barely moved, which is the shape the mechanism
predicts (old rows accumulating, not a fresh leak). **Compare ratios across runs, never absolutes.**

**This is fixed on this branch by the status-hydration split** (`mapPersistedStatus` → unresolved persisted rows render
`failed`, `mapStatus` byte-unchanged) — **but the running 0.13.0 does not contain it**, so the spinners this
census predicts are still mounting on this machine, and §10.4's null result therefore does **not** clear
mounted spinners as a contributor: `animate-spin` is exactly the animation the OS flag cannot disable.

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
3. **Is the idle peg animation or a leak?** §3's confound is **not resolved and cannot be from this session** —
   §10.1 establishes the measuring session runs *inside* the app being measured (worker PPID = the host PID).
   §10.4's second reduced-motion run is **NULL**, and §10.2 refutes the wakeup-storm hypothesis, so the two
   cheapest candidates are both out. **Still open:** always-mounted `animate-spin`, which the OS flag cannot
   disable (§10.4.3) and which the stale-status census (§10.5) says is still mounting on 0.13.0. The test that
   would settle it needs the CSS classes commented, which the read-only AppImage forbids.
4. **`freelist_count` 21,643 (this snapshot) vs 22,973 (a researcher's snapshot).** Different copies of a
   live-growing DB; both are correct for their own instant. Cited: mine, with the command.
5. **Is the `render.rs` timeout leak an origin or an amplifier?** The trigger (a stalled main thread) is the
   symptom, so the causal direction is genuinely open.
6. **"Sustained while idle" vs the measured shape.** The title is right about the average (33.8% of a core since
   launch) and wrong about the shape: §10.1 measures a **20.5% floor with ~2-minute spikes to 100–130%**, 17% of
   seconds ≥90% and 66% ≤25%. Both are true of the same process. Any A/B measured over a short window is
   measuring which side of the cycle it landed on, not a treatment effect.
7. **The eventfd storm: cause, symptom, or neither?** §10.2 shows it is present at 882–1,091/sec while the app
   sits at 13–16% CPU, so it is **not** the peg's cause. But it rises to 1,422–2,530/sec during bursts, and the
   host main thread is the second-largest writer and burns 53.2% during a burst. Whether the main thread is
   *following* the renderer or *driving* it is unanswered — separating them needs a profiler this machine does not
   have installed.


## Gaps

- **`perf` is not installed on this machine**, so the plan's `perf top -p <pid>` step was never run and nothing
  here is perf-derived. §10's substitute was `/proc` deltas, `strace -f`, and `/proc/<tid>/syscall`+`wchan`
  sampling — a poor man's profiler that names *where threads wait*, not *which function costs*. No flame graph,
  no symbol-level attribution exists for the peg.
- **No DevTools profile of a burst.** The running 0.13.0 AppImage is mounted **read-only** and ships no devtools
  feature, so §9's step 4 — the single cheapest discriminator, and the one that would settle §10.3 — is
  unreachable against the process that is actually pegged. Every burst finding in §10 is `/proc`-level.
- **The class-level animation test was never run** (§10.4). Only the OS `reduced-motion` flag was toggled, and it
  cannot reach `animate-spin`. "Animations are not the peg" is therefore proven for the two selectors the flag
  covers, and **unproven** for the spinner the stale-status census actually mounts.
- **The peg cannot be reproduced on demand** — it was caught by waiting through 8-minute polling loops, and its
  onset is unexplained. Nothing in §10 was measured against a *controlled* burst.
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
- **The idle spinner/animation A/B test has been run twice and both runs are NULL** (§10.4) — but only via the
  OS `prefers-reduced-motion` flag, which cannot disable `animate-spin`. The decisive variant (classes commented)
  is still unrun, so this is not closed.
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
- **The eventfd writes were published as evidence of idleness. They are evidence of the opposite, and the claim
  is withdrawn.** The first draft's §Executive-summary paragraph read the `strace` finding — 8,333 `write` calls
  in 8 s, every one `write(fd, "\1\0\0\0\0\0\0\0", 8)` on `fd 4`/`fd 38`, both `anon_inode:[eventfd]`, from
  `tokio-rt-worker` and `ReceiveQueue` — as corroborating "no stream was running, the app was idle". ~1,000
  event-loop wakeups per second is internal activity, not idleness; the sentence was self-refuting and the
  report has been public on #155 with it. Corrected in place with this note rather than silently rewritten.
  Re-measured in §10.2: the storm is real (**1,144/sec mean over 125 s, flat**), the fds are the **host's**, the
  **main thread** is also a large writer (missed first time), and it is **not** the peg's cause — the same rate
  appears at 13–16% CPU. The idleness case now rests only on the zero fsyncs and the idle workers.
- **§1's "sustained while idle" is an average, not a shape.** Re-measurement (§10.1) shows a **20.5% floor with
  ~2-minute bursts to 100–130%** — 17% of seconds ≥90%, 66% ≤25%. The peg is real and it does survive the agent
  sitting at verifiably 0.0% CPU (120 and 300 consecutive samples), so the reproduction stands; what does not
  stand is reading it as a constant ~95–100%.
- **§3's confound is worse than stated, and is structural.** The plan assumed an idle app was reachable by
  waiting. It is not: the measuring session runs *inside* the app (worker 2312298's PPID is the host 1790154),
  so my output is painted by the renderer under test. §10.1 brackets both states explicitly instead of claiming a
  clean one.
- **The reduced-motion A/B is NULL on a second, better-instrumented run** (§10.4): baseline 87.7% vs
  reduced-motion 78.2%, but the control phase — flag restored, animations back on — fell to **21.4%** on its own,
  so the burst was decaying regardless. Contemporaneous comparison is 79.3% vs 74.5% = **4.8 points**, inside
  this signal's noise. §3's "cheapest decisive experiment" is decisive in the negative direction only.
- **A first reduced-motion run was void and its numbers are not reported.** `gsettings` `reduced-motion` is an
  **enum** (`'no-preference'|'reduce'`); the first attempt passed `true`, was rejected with *"value outside of the
  valid range"*, and the "during" phase measured an app that had had nothing changed. Recorded because it is the
  kind of green that reads as a result.
- **A plan citation was wrong: `--animate-spin` is not at `node_modules/tw-animate-css/dist/tw-animate.css:438`.**
  That file is 14,880 bytes on **one line** (0 newlines), so line 438 does not exist, and it carries no
  `reduced-motion`. The
  correct location is **`node_modules/tailwindcss/theme.css:438`**. The claim itself survives and is stronger
  than stated: `animate-spin` (3 non-test uses) has no reduced-motion rule in `theme.css`, `index.css` or
  `preflight.css`, so the OS flag cannot disable the one animation the stale-status census mounts.
  **This bullet used to also say the file "contains neither `spin` nor `reduced-motion`" — the `spin` half of
  that was FALSE, and is corrected in §10.4's note.** `grep -c spin` on it prints **1** line / **8** occurrences
  (the unrelated `spin-in`/`spin-out` enter/exit `@utility` definitions). The conclusion is untouched — the
  file defines no `animate-spin` (`grep -c 'animate-spin'` → 0) — but the phrasing was refuted by the grep a
  reader would naturally run, which is the failure mode this whole section is meant to prevent.
- **The §10.5 census command did not run as printed, and one of its four figures had no producing command.**
  The `WITH page AS (…) SELECT …;` / `SELECT … FROM page;` pair died `Parse error … no such table: page` —
  a CTE is scoped to its own statement — so only the first count was reproducible from the text, and
  `of 186,322` was never produced by anything the section printed. §10.5 now carries a single-statement
  version that emits all four figures labelled, plus a fresh 2026-11-15 run of it. Recorded rather than
  silently rewritten because the published version told readers "the command above is the one to re-run",
  and it was not a command that ran.
- **Four commit hashes cited in this report have been removed, not corrected.** `e5170826`, `2ae39645`,
  `fda3fc45` and `d03c13cf` (the four fixes, cited at §10's opening, §10.5 and this list) all resolve today
  — they are ancestors of this branch's head — but this branch squash-merges, so every one of them will
  resolve nowhere the moment it lands. That is this repo's squash-orphan rule applied to objects — the same
  hazard the report's own front-matter stamp exists to manage for its `file:line` citations. They are
  replaced by the task descriptions
  ("the status-hydration split", …) and, where a hash was load-bearing for a check, by the content-marker
  loop in §10. **A reader of the published version who runs `git show e5170826` after the merge will get
  `unknown revision`; that is expected, and the prose no longer asks you to.**
- **Stale-status census re-run against the live DB** (§10.5): **1,064** `in_progress` tool-call rows and **355 of
  2,278** sessions carrying one in the newest 500 messages — earlier figures (1,056 / 350 of 2,207, and 1,067 in
  `docs/research/silent-turn-settle-after-announcing-a-write.md`) are the same measurement on earlier snapshots
  of a live-growing DB, not disagreements. **The status-hydration split fixes this on this branch**, and the running
  0.13.0 predates it, so the spinners are still mounting here — which is exactly why §10.4's null does not
  exonerate mounted spinners.
- **`perf` was unavailable, contrary to the plan's assumption.** The `perf top -p <pid>` step could not run; §10
  names the `/proc`-based substitutes used instead and no perf-derived figure appears anywhere in this report.

