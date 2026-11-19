---
status: current
last-verified: 2026-11-14
verified-by: mixed instruments at `312c60e9` on 2026-11-14 — 3 parallel researchers (write path / disk
  census / decision-corpus audit) + main-agent re-verification of every load-bearing claim. **Live
  read-only SQLite measurement** on this machine's 2.17 GiB `~/.local/share/archimedes/archimedes.db`
  (`dbstat` per-table sizing, per-kind/per-role payload byte sums, `PRAGMA page_count`/`freelist_count`/
  `journal_mode`/`integrity_check`). **Filesystem census** (`du`/`find`/`lsof`-equivalent open-fd check on
  pid 1790154). **Code**: this checkout + the crates.io-pinned `fulcrum-harness-0.2.0` sources at
  `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fulcrum-harness-0.2.0` (checksum `c45f3502…`
  per `Cargo.lock:1665-1668`). **Docs corpus** (81 ADRs, `docs/features/`, `CONTEXT.md`, `AGENTS.md`) +
  `gh` issue searches. **Official docs**: sqlite.org (limits, lang_vacuum, fileformat, wal), webkitgtk
  reference, wry 0.57.0 source.
task: tsk_1e926ed5-474f-42db-b6ba-7e84d3b60391
---

# Why `archimedes.db` is 2.17 GiB — where the bytes went, and whether that is by design

**Settled question:** where did the 2.17 GiB in `archimedes.db` go, is unbounded retention the design
or an oversight, and what else does Archimedes own on disk? A cited report — no fix was designed here.

## Executive Summary

The database is big because **2,197 subagent transcripts averaging ~653 KiB each were deliberately
persisted for a purpose that was never built, and nothing in the schema, the UI, or the decision
corpus provides any path by which they are ever read, capped, or deleted.**

- **It is not bloat.** ~80% of the file (1.74 GiB of 2.17) is live payload; the freelist is ~41 MB
  (1.9%). This is retained data, not churn and not a leak. `integrity_check: ok`.
- **94.5% of it is unreachable by design.** Subagent rows are filtered out of every listing
  (`db.rs:1628`, `:1635`), have no parent link in the schema, and are never archived (0 of 2,197 have
  `archived = 1`). Deleting every session the UI can name leaves 1,680 MB in place.
- **The one ADR that covers this — 0025 — justifies the persistence with a "debug view" that does not
  exist** in the code, in any ref's history, or in the IPC surface. The frontend states the opposite
  in its own comment (`src/store/sessions.ts:72-76`).
- **Growth is normal, not anomalous:** ~35 MiB/day, ~500–675 MiB/month, driven entirely by subagent
  fan-out (peak 147 subagents on 2026-11-11). The arithmetic reproduces the observed file exactly.
  The next 2 GiB arrives in ~60 days at current usage.
- **The repo has treated 11 MB of unbounded growth as an ADR-plus-two-issue defect** (crash logs,
  issues #37/#42). 1.7 GiB of transcripts has never been the subject of a decision: the word "vacuum"
  appears in **zero** ADRs, **zero** features docs, **zero** GitHub issues.

## Findings

### 1. Where the bytes are

Measured with `dbstat` against the live file (read-only), 2026-11-14:

| Object | Rows | Size | What it is |
|---|---|---|---|
| `messages` (payload) | 361,722 | **1,175 MB** | Display transcript — never cleared, never compacted |
| `native_messages` (payload) | 329,557 | **603 MB** | Provider replay history — rewritten by compaction |
| `messages` indexes | | 58 MB | `sqlite_autoindex_messages_1` 36 MB + `idx_messages_session` 22 MB |
| `native_messages` index | | 19 MB | |
| everything else | | <2 MB | `sessions` 0.5 MB (2,275 rows), `tasks`/`task_artifacts`/`spaces`/`stages` |
| freelist | | 41 MB | 10,660 pages |

`PRAGMA page_size` = 4096, `page_count` = 569,758 → 2,333,728,768 B exactly. `journal_mode` reads
**`delete`**, not WAL — see Contradiction 1.

Inside the display table, by `kind`:

| kind | Rows | Size | avg | max |
|---|---|---|---|---|
| `tool-call` | 186,524 | **638 MB** | 3.5 KB | **1,179 KB** |
| `agent-thought` | 127,732 | **509 MB** | 4.1 KB | 254 KB |
| `agent-text` | 46,691 | 24 MB | 0.5 KB | 221 KB |
| `user` | 333 | **2 MB** | 9.2 KB | 661 KB |

Inside the replay table, by `role`: `tool` 439 MB / 178k rows, `assistant` 141 MB / 147k, `system`
11 MB, `user` 10 MB.

**The surprise:** `docs/decisions/0008-inline-attachment-persistence.md:21-22` was written specifically
to anticipate this table growing from inline base64 attachments — *"total growth scales with usage
(bounded per message by the caps)"*, with an *"Escape hatch: if growth ever bites, a one-off data
migration rewrites rows to `path` references."* Attachments are **0.16% of the display table** (54
`tool-call` rows / 3.4 MB, 12 `user` rows / 2.6 MB). The one growth event the corpus anticipated is
not the growth that happened.

### 2. What the write path persists — and the asymmetry nobody documented

**There is no size guard of any kind on the persistence path.** `Db::record_message`
(`src-tauri/src/storage/db.rs:1511`) and `Db::insert_native_message` (`db.rs:1831`) bind their `&str`
verbatim into `payload_json TEXT NOT NULL` / `content_json TEXT NOT NULL`. The row payload is an
untyped `serde_json::Value` (`fulcrum-harness-0.2.0/src/store_rows.rs:236-241`) mutated by
`merge_json` — **there is no type to hang a bound on**. Repo-wide greps for `MAX_PAYLOAD` /
`MAX_CONTENT` / `MAX_ROW` / `MAX_JSON` return nothing.

Tool caps do exist — `bash` `MAX_OUTPUT_BYTES = 100 KiB` (`tools/exec/bash.rs:27`), `read` 2000 lines
(`fs_tools.rs:10`), `find`/`grep` 100 results (`search.rs:9`), `fetch_content` 20k default / 200k max
(`web/tools.rs:238-243`) — but they sit **inside the tools, upstream of both sinks**. The model and
the disk receive the same already-capped bytes. So the headline is **not** "truncated for the model,
stored whole." It is the reverse: **two categories of bytes are disk-only surplus.**

1. **`ToolResult.details` never reaches the model, but is always written to disk.**
   `turn.rs:622-627` pushes `result.content` only; `details` appears in no provider serialization
   path (`provider_types.rs` + all three provider modules). It reaches disk via
   `turn.rs:614` (`serde_json::to_value(&result)`) → `normalize.rs:413-423` (`"rawOutput": result`) →
   `compute_display_rows`' `tool_call_update` merge → `payload_json`. This includes `edit`'s unified
   diff: `unified_diff` (`fs_tools.rs:186-231`) elides only the unchanged prefix/suffix, so a
   whole-file rewrite writes a whole-file diff that the model never saw. Two live `edit` rows carry
   548 KB and 446 KB of `rawOutput` against a 164-byte `rawInput`.
2. **`rawInput` is stored twice** — once as `messages.payload_json.rawInput` (`normalize.rs:380-398`),
   again as `native_messages` `assistant.tool_calls[].arguments`.
3. **`codemode` produces the monster rows.** Nested tool calls accumulate in a `FuturesUnordered`
   with no count or concurrency cap (`harness/loop/codemode.rs:878`, `:928`) and the whole snapshot is
   serialized into `details` (`:688-691`, `:757-762`). The largest row in this DB is **1.15 MB**, of
   which `details.calls` is **1,201,073 B across 67 nested calls**.

**`agent-thought` is 509 MB of chain-of-thought that is display-only.** It never enters a
`ChatMessage` — the assistant persist site writes `acc.text` alone (`harness/loop.rs:1431`), and
`native_messages` holds exactly **one** row containing a `thinking` block against 127,732 display
rows. Resume reads only `native_messages` (`session/mod.rs:1492-1497`). So ~509 MB exists purely to
redraw collapsed Reasoning blocks (`src/components/MessageBubble.tsx:403`). No document anywhere
discusses its retention.

**Images do reach the DB, in three places**, all bounded per-message and never per-lifetime: composer
attachments as base64 by design (ADR 0008; `MAX_IMAGE_BYTES` 10 MiB × `MAX_IMAGE_COUNT` 8, worst case
~108 MB/message, `session/mod.rs:161-167`); the `read` tool base64-encoding a whole image with **no
size check** (`fs_tools.rs:37-53`, `fs_backend.rs:94-99`) into **both** tables; and nested `read`
inside `codemode`.

### 3. Is this by design? The three-way verdict

**Documented as intended:**

- **Persisting subagent transcripts at all** — `docs/decisions/0025-sessions-in-worker-processes.md:21`,
  verbatim: *"The Supervisor persists ALL transcripts from the event stream, including **subagent
  transcripts as hidden ephemeral session rows** (never archived, hidden from Space lists,
  inspectable in a debug view — previously discarded, which is why a 32-minute subagent's work was
  un-inspectable after the fact)."* A real reversal of discard-on-teardown, pinned by
  `src-tauri/tests/ipc.rs:832` (`a_subagent_transcript_persists_as_a_hidden_ephemeral_row`).
- **Two tables holding transcript data** — `docs/decisions/0022-native-harness-only.md:11` and `:23`,
  the latter recorded as a *reviewer-verified correction*: dropping `messages` *"would have destroyed
  every native session's displayable history."* Different keys, different readers, different clearing
  rules. ADR 0048 proves the split is semantically load-bearing — a retraction must agree in *"the
  harness accumulator, the persisted display row, and the live store"*, and the provider transcript is
  deliberately **not** one of the three.
- **Archive as a pure visibility flag** — ADR 0016:9/17/21/22, `CONTEXT.md:105` (*"a view property —
  the flag and nothing else"*), `db.rs:1694-1700` is one `UPDATE` on one integer column. **Archiving
  all 2,153 candidates reclaims exactly 0 bytes.**
- **Unbounded `messages` growth in principle** — ADR 0008:21, scoped entirely to image attachments.

**Documented as a known gap — barely.** One paragraph, in a research doc about a different subject:

> **Live DB census** (this machine, `archimedes.db`, **2.33 GB** …). `PRAGMA page_size`=4096,
> `page_count`=569,758, **`freelist_count`=21,643 → 88.7 MB of pages never reclaimed**. **Nothing
> vacuums, prunes, or caps**; `clear_native_messages` runs only on the compaction rewrite path;
> archived sessions keep their transcripts. — `docs/research/whole-window-jank-renderer-saturation.md:318-321`

It sits under §5 of a section whose subject is *"why 25 WebView2 processes is a counting artifact"*.
DB size was examined as a **suspect for jank**, pronounced innocent (`:67`, "DB size — ELIMINATED"),
and put down. Never tracked. `docs/features/transcript-render-perf-known-gaps.md:44-48` opened
*"what a 687 MB database does to write cost"* and closed it by measuring write cost — never asking
whether the data should exist.

**No evidence either way — the load-bearing silences:**

1. **No document states how long a subagent transcript lives, or that it lives forever.** Rows are
   created on every store frame (`persist.rs:279-311`), never archived, never reachable from any UI,
   and no ADR caps or prunes them. ADR 0055 bounds subagent *processes* (30-min dead bound), not rows.
2. **The stated purpose is unimplemented.** "Inspectable in a debug view": `grep -rniE "debug
   view|debugview|debug-view" src/ src-tauri/src/` → **exit 1, no hits**; `git log --all -S "debug
   view"` → nothing on any ref; no IPC command selects `WHERE is_subagent = 1`. Meanwhile
   `src/store/sessions.ts:72-76` says: *"Deleting is safe because **nothing can ask for that transcript
   back**: a child's rows DO persist … but `list_sessions` filters those rows out, so no surface can
   re-open a closed child."* Same fact, written by the same project, in opposite directions.
3. **`sessions` has no `parent_session_id` column** (verified against `PRAGMA table_info`: id, cwd,
   created_at, title, capabilities_json, archived, context_usage_json, is_subagent, todos_json,
   sort_order, cost_usd, title_stage). The parent link exists only on the wire (`seams.rs:274`,
   `subagent.rs:157`) and in `task_sessions`. So `ON DELETE CASCADE` reaches a session's **own** rows
   only — **deleting a parent does not touch its children.**
4. **`DELETE FROM messages` has zero sites in the tree** (re-verified: `grep -rn "DELETE FROM
   messages" --include='*.rs' src-tauri/src/` → exit 1). The display transcript is append-only for the
   life of the database, with no bulk path.
5. **`VACUUM` / `auto_vacuum` / `incremental_vacuum` have zero sites** (re-verified: exit 1 over
   `src-tauri/src/`). Live `PRAGMA auto_vacuum` = 0.

**Compaction shrinks `native_messages` only.** `run_compaction` (`harness/compact.rs:441-519`) rebuilds
the vector and calls `replace_messages` → `Db::replace_native_messages` (`db.rs:1881`), whose first
statement is `DELETE FROM native_messages WHERE session_id = ?1`. **No code in `compact.rs` touches
`messages`** — a compaction *adds* two display rows for its card. The two tables diverge permanently,
by design: ADR 0047 even records that the summary trim *"destroys that text either way"*, while the
display rows for that text survive untouched.

**The precedent that makes the asymmetry sharp:** `docs/decisions/0025-…:37` records, for the
*crash-log* directory, *"**Nothing was ever deleted.** 862 files / 11 MB accumulated"* — fixed with
`MAX_CRASH_LOG_AGE_DAYS = 30` / `MAX_CRASH_LOG_FILES = 50` / `prune_crash_logs`
(`src-tauri/src/agent/crashlog.rs:55-57`, `:218`), tracked as issues #37 and #42. **11 MB of
diagnostic noise triggered an ADR and two issues. 1.7 GiB of transcripts has triggered nothing.** The
distinction (diagnostic noise vs the product's data) is defensible — but nothing in the corpus states
it, so the asymmetry is unexamined rather than argued.

### 4. The disk census — everything Archimedes owns on this machine

| Bucket | Size | What it is |
|---|---|---|
| Repo `target/` | **29 G** | Cargo debug artifacts (`deps` 23 G, `incremental` 2.3 G) |
| `~/.cache/fulcrum-target/` | 2.6 G | Separate target dir for the harness crate |
| `~/.local/share/archimedes/` | **2.2 G** | `archimedes.db` 2.17 GiB + `-journal` 8.7 KB + `supervisor.log` 2.5 MB + `.old` 5.2 MB + 2 × `crash-*.log` 16.5 KB |
| `~/.cache/pnpm/` | 1.5 G | **Machine-wide shared store — not Archimedes-owned** |
| `~/.local/share/codes.archimedes.desktop/` | **486 MB** | WebKitCache 481 MB + CacheStorage 3.5 MB + localstorage 400 KB + … |
| `node_modules` / `.tmp` / `.git` / `dist` | 566 MB | Dev tree |
| AppImage + live `/tmp` mount | 363 MB | 89 MB + 274 MB |
| **Stale pre-rename dirs** | **219 MB** | `com.archimedes.desktop` 198 MB + `com.archimedes.app` 21 MB + `.config/com.archimedes.desktop` 4 KB |
| Archimedes-specific dev caches | 177 MB | `~/.cache/archimedes-tmp` 114 MB, `~/.cache/tauri` 48 MB, `~/.cache/tmp/archimedes-*` 13 MB |
| Config + keys | 68 KB | `~/.config/archimedes`, `~/.config/codes.archimedes.desktop`, `~/.archimedes` |

**Two honest totals — do not collapse them:**
- **"Everything Archimedes owns": ≈ 35.7 GB** (≈ 37.2 GB if the shared pnpm store is attributed here).
- **"What a user would call Archimedes data": 2.7 GB**, of which one SQLite file is 2.17 GiB.

29 GB of the first figure is a dev-machine build cache that no shipped user has.

**The four data directories are not a bug.** `src-tauri/src/lib.rs:699-717` deliberately bypasses
Tauri's identifier-derived path and uses the `dirs` crate instead:

```rust
// The on-disk dirs are named `archimedes` (NOT the bundle identifier — Tauri's
// `config_dir()` / `app_data_dir()` append the identifier …)
let app_data_dir = dirs::data_dir().map(|p| p.join("archimedes"))…
```

So app state (`db.rs` via `lib.rs:163`, crash logs, `settings.json`) lives under `archimedes/`, while
the identifier dir holds **only what wry/WebKitGTK and the window-state plugin place automatically**.
`docs/decisions/0021-window-state-plugin.md:20` documents the split and uses the word *"deliberately"*.
Confirmed against the running process by open file descriptors, not inference: pid 1790154 holds
`~/.local/share/archimedes/archimedes.db` and its `-journal`, and nothing under `com.archimedes.*`.

**Gap:** there is **no ADR for the data-dir decision.** The only rationale is commit `c10ebd79`'s
message (*"the old com.archimedes.app ended in `.app`, a macOS footgun"*), whose **stated** reason is
the `.app` collision — the identifier-decoupling is the mechanism it arranges, not a reason the commit
gives.

**The stale dirs are dead** — `git log -L` on the identifier key traces exactly
`a9767585 → com.archimedes.desktop` (Sep 15) → `a04f7179 → com.archimedes.app` (Sep 28) → `c10ebd79 →
codes.archimedes.desktop` (Sep 29), and the on-disk mtimes track that **to the day**. Zero references to
either old identifier in the tree. They are not empty (the Sep-28 DB holds 19 sessions / 539 messages),
but they are unreachable. **Reclaimable: 219 MB** — of which 196 MB is dead WebKitCache, only ~2.3 MB
is old databases. 0.6% of everything, 8% of live app data: *not* the disk problem.

**WebKitCache 481 MB** is WebKitGTK's own HTTP cache (`Blobs` 457 MB + `Records` 25 MB, 13,449 files),
dominated by **dev-mode traffic**: 15,857 records for `http://localhost` (the Vite dev server on :1420,
`tauri.conf.json:7-8`), then `w3.org` 1,619, `tailwindcss.com` 1,531, `github.com` 1,436. Purely a
cache — deleting costs re-fetch and nothing else. It lives in `~/.local/share` rather than `~/.cache`
because of wry's own acknowledged gap: `// TODO: Consider taking a cache_directory so this can be in
XDG_CACHE_HOME` (`wry-0.57.0/src/webkitgtk/web_context.rs:32-44`), which sets `base_cache_directory` =
`base_data_directory`. **No byte limit is in effect**: `WebsiteDataManager` exposes no size setter
(only `builder()` and `set_memory_pressure_settings()`), `set_cache_model` exists on `WebContext`
(`webkit2gtk-2.0.2/src/auto/web_context.rs:597`) and **wry 0.57 never calls it**.
Sources: [WebKitWebContext reference](https://webkitgtk.org/reference/webkit2gtk/2.28.3/WebKitWebContext.html),
[independent confirmation of the missing setter](https://github.com/th-lange/eve-online-tooling/pull/1116).

**Logs are bounded and irrelevant.** `debuglog` rotates at `MAX_LOG_BYTES = 5 MiB`
(`fulcrum/src/debuglog.rs:21`, `:84-88`) — proven by `supervisor.log.old` sitting at exactly
5,243,384 B while the current file is 2.45 MB, both generations of the same session across the
rotation boundary. `crashlog` caps at 30 days **and** 50 files. Total ~7.7 MB, permanently.

**None of this is surfaced to the user.** No byte-formatting helper exists anywhere in `src/`; no
registered Tauri command returns a size (`lib.rs:660-694`); the nearest affordance,
`src/components/settings/ClearDetachedSessionsDialog.tsx`, reports **counts, not bytes** (`:41`). The
2.17 GiB file, the 481 MB cache, and the 219 MB of stale dirs are invisible. `README.md:412-413` tells
users the DB *"contains your conversation text"* and not to send it — so there is no supported export
or size-reduction surface at all.

### 5. Growth rate — the arithmetic reproduces the observed file

| Metric | Value |
|---|---|
| Window | 2026-10-04 → 2026-11-14 (41.2 days, 40 active) |
| Sessions | 2,278 — **2,197 subagent**, 81 main |
| 2026-10 | 1,293 sessions (1,270 sub) → 1,011 MiB |
| 2026-11 | 985 sessions (927 sub) → 765 MiB |
| Per active day | Oct ≈ 39 MiB, Nov ≈ 55 MiB; peak day 64 MiB display (2026-11-06, 17,657 rows) |
| **Subagent bytes/session** | **median 653 KiB** (396 KB display + 245 KB native); mean 803 KB; max 5.8 MiB |
| Main bytes/session | median 939 KiB; mean 1.25 MB |
| Rows/session | subagent median 113; main median 211 |
| Row size | median 1,120 B, mean 3,409 B; **17.7% exceed one 4 KB page** |

Subagents/day peaks: **147** (2026-11-11), 126, 123, 118, 110, 109. Main sessions peak at 17/day — so
~9:1 subagent:main on heavy days. **100 subagents × 653 KiB ≈ 64 MiB/day**, and the measured peak
display day is 64 MiB. The observed rate is exactly what heavy orchestrated days produce; no anomaly
is required.

Evidence of the multi-wave runs that generate it: `docs/roadmap/fulcrum-harness-status.md:114-134`
(a 14-wave plan, each wave an autonomous run); `docs/features/improvement-correctness-seams-closeout.md:556-559`
(waves in parallel worktrees); `docs/decisions/0025-…:9` (the app's origin story is *"a panic during an
8-subagent fan-out"*).

**Projection:** ~640 MiB per 1,000 subagent sessions. The file crossed 2 GiB in 41 days; at the
observed mean (~55 sessions/day, ~35 MiB/day of file) **the next 2 GiB arrives in ~60 days.**

### 6. What a 2 GiB SQLite file actually costs

**Costs nothing** (checked, not assumed):
- **Capacity** — the limit is 4,294,967,294 pages regardless of page size, ~17.5 TB here, so this file
  is 0.012% of the ceiling ([sqlite.org/limits.html](https://www.sqlite.org/limits.html) §14).
- **Open time** — measured 5× against the live file: <10 ms, indistinguishable from a 1-row DB. SQLite
  reads the header and schema pages, it does not walk the file.
- **Read path** — the real UI-path query was measured at **3.3 ms** on this same file
  (`whole-window-jank-renderer-saturation.md:446`). **The size is not why anything is slow.**

**Does cost:**
- **`DELETE` never shrinks the file.** [sqlite.org/lang_vacuum.html](https://www.sqlite.org/lang_vacuum.html):
  *"when a large amount of data is deleted … it leaves behind empty space … Running VACUUM to rebuild
  the database reclaims this space."* With no `VACUUM` anywhere and `auto_vacuum = 0`, a mass delete
  would drop rows and leave a 2.17 GiB file. Deleting the 2,153 unarchived sessions reclaims 0 file bytes.
- **Freelist is a one-way ratchet** — free pages are *reused*, never returned
  ([fileformat §1.5](https://www.sqlite.org/fileformat.html)). Good news: a purge followed by regrowth
  consumes the 41 MB freelist first rather than doubling the file. Bad news: the file only ever grows.
- **Write amplification is the real mechanism.** `tool_call_update` rebuilds and re-upserts the **whole**
  row payload from accumulated state on every streaming frame
  (`normalize.rs:772-803` via `merge_json`), and `tool_execution_update` emits one such frame per live
  partial. A 1 MB result streaming N updates is rewritten whole N times, spilling to overflow-page
  chains ([fileformat §1.7](https://www.sqlite.org/fileformat.html)). 17.7% of rows (63,908) exceed one
  page. That is what the ~20% non-payload overhead is made of.
- **Backup is the whole file, always** — `VACUUM INTO` / the backup API copy everything; this very
  research had to snapshot the live file to read it.
- **WAL checkpoint cost changes shape when `2ae39645` ships** — autocheckpoint is ~1000 pages
  ([wal §6](https://www.sqlite.org/wal.html)) and `wal_checkpoint(TRUNCATE)` was measured at **81 ms**
  on a 703 MB DB (`…jank-renderer-saturation.md:288`). Crucially checkpoint cost tracks **WAL content,
  not database size** — so it is the *row sizes* that bite, not the 2 GiB.

## Unresolved Contradictions

1. **WAL or rollback journal.** The code asks for WAL (`db.rs:937-963`, with a readback because the
   mode "refuses silently"); the live DB reports `journal_mode = delete` and an `archimedes.db-journal`
   file exists. Both researchers independently attributed this to the installed AppImage (Nov 11)
   predating commit `2ae39645` (Nov 14, **untagged** — `git tag --contains 2ae39645` is empty, newest
   tag `v0.13.0`), corroborated by `strings` on the running binary finding the app's
   `"db journal degrade"` sentence 0 times while a current `target/debug` build finds it once.
   Consistent across two independent instruments, but read off binary inspection rather than a version
   report. **Consequence either way:** rollback-journal makes the on-disk high-water mark permanent.
2. **Is 481 MB of WebKitCache steady state or unbounded growth?** No primary source for WebKit's
   eviction formula was found; "sized by a heuristic tied to free space" is community-report level
   only. 70 GB free is consistent with both. **Not determined.**
3. **`record_messages_batch` (`db.rs:1555`) has no production caller** — `persist_display` still loops
   `record_message` per row (`agent/harness/store.rs:120-129`), documented as "moved verbatim". Whether
   that is intentional cannot be determined from the code alone.

## Gaps

- **`codemode` nested-call bound is unknown.** No constant caps how many nested tool rows one call may
  settle; 67 is proven achievable by the 1.15 MB row, the practical maximum is not established.
- **The `read`-tool image path is unbounded and untested.** `fs_tools.rs:37-53` base64-encodes a whole
  file with no size check; the 10 MiB cap guards **composer attachments only**. Not exercised with a
  >10 MiB image.
- **Whether the 2,197 subagent sessions belong to parents the user still has is unanswerable from the
  schema** (no parent column). 0 `messages` rows are FK-orphaned, so the FK is the only link and it
  says nothing about parentage.
- **`~/.cache/tmp/archimedes-*`** — 520 dirs, 13 MB, `archimedes-prompt-*` / `-agents-*` / `-skills-*`.
  Leak or by-design TTL: not determined.
- **Whether anything else on the machine reads the `com.archimedes.*` dirs** (a desktop-file launcher,
  an old AppImage with a pinned identifier, a backup tool) — only the repo tree and running processes
  were checked.
- **`du` reports block size, not apparent size**, and this filesystem may compress, so `target/` at 29 G
  may be smaller on physical media.

## Related

- `docs/research/whole-window-jank-renderer-saturation.md` §4–§5 — the prior census paragraph (§3 above);
  it eliminated DB size as a *jank* suspect and never asked the retention question. Not superseded:
  different subject.
- `docs/decisions/0025-sessions-in-worker-processes.md:21` — the subagent-persistence decision this
  report audits; `:37` — the crash-log precedent.
- `docs/decisions/0016-session-archive-first-delete.md` — why archive reclaims nothing.
- `docs/decisions/0022-native-harness-only.md:11,23` — the two-table decision.
- `docs/decisions/0008-inline-attachment-persistence.md:21-22` — the growth concern that did not
  materialize, and its unused escape hatch.
