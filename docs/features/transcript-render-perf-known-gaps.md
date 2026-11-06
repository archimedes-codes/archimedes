---
status: live
last-verified: 2026-11-06
verified-by: each claim re-measured against this tree at `041ef6ad` rather than copied from the
  roadmap plan that recorded it — `git merge-base --is-ancestor <fix commit> v0.9.2` for the three
  already-shipped fixes (all three true), `grep -l 'memo(' src/components/**/*.tsx` for the memo
  census (3 files, none a tool card before this branch), and a read of
  `src/components/chat/MessageList.tsx` (`react-virtuoso`), `src/lib/batchSessionUpdates.ts`
  (per-frame coalescing) and `src/navigation_guard.rs` (`should_track_label`) for the mechanisms.
  Issue #155's reporter figures (687 MB DB, 25 WebView2 processes, ~42,000 CPU-seconds) are the
  reporter's own, quoted from the issue, not measured here.
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
