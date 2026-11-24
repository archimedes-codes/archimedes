---
status: accepted
date: 2026-11-23
superseded-by:
---

# A closed Subagent session's transcripts are pruned at 24 hours, and `VACUUM` runs only on a measured freelist

> **Three snapshots of one growing file, and this ADR quotes all three by name.** They are different reads
> of the same database, and they must never be blended. **Census A** — read by this decision, read-only
> (`mode=ro`) at `07ccb4f3` on 2026-11-22: **2,976,337,920 bytes**, 726,645 pages × 4096,
> `freelist_count` = 8, `sessions` 2,790, subagents 2,649, `messages` 469,998, `native_messages` 425,410.
> **Census B** — the research report's **correction 6** (`docs/research/database-size-unbounded-transcript-growth.md`,
> 2026-11-22, read at `94af00d1`, an earlier read of the same day): **2,825 MB**, `sessions` 2,779, subagents
> 2,639, `messages` 467,934, `native_messages` 423,499. Census B is **151 MB (≈5%) smaller** than Census A
> because the file grew between the two reads — which is the whole thesis of this ADR, visible in 24 hours of
> ordinary use. **Census C** — a re-read taken the day this ADR was dated, 2026-11-23 17:37, `mode=ro` at
> `1428c941`: **3,096,555,520 bytes** on disk (`page_count` 755,998 × 4096 = 3,096,567,808 — the 12,288-byte
> difference between the product and the file is **WAL state, not a fixed relation to the freelist**: it
> happens to equal `freelist_count` × `page_size` at this read, and at a later read of the same file on the
> same day it was 32,768 B — 8 pages — with `freelist_count` still 3. Quote `stat` for the file and
> `page_count` for the product, never one for the other, and never explain one by the other), `auto_vacuum` 0, `user_version` 0,
> `sessions` 2,865, subagents 2,714, archived subagents **0**, `messages` 486,691, `native_messages` 439,904.
> Census C is **not** a new measurement of anything this ADR decides — it is the growth rate confirming
> itself: **+114.6 MiB over Census A in about a day** (the interval is measured, not rounded: Census A was
> read on the base commit dated 2026-11-22 12:57, Census C at 2026-11-23 17:37 — **≈1.19 days**, so the
> implied rate is **≈96 MiB/day**), against the ≈33–35 MiB/day this ADR quotes, and a
> `freelist_count` still in single-digit pages, i.e. still ~21,000× below the threshold below. **Every
> percentage in this ADR names its census.** Do not attach Census B's 72% to Census A's denominator, and do
> not "update" Census A to Census C — an undated figure is the failure mode this note exists to prevent.

`~/.local/share/archimedes/archimedes.db` measures **2,976,337,920 bytes** on the machine this decision
was taken on — **Census A** (726,645 pages × 4096, `journal_mode = wal`, `auto_vacuum = 0`,
`freelist_count` = 8 — so **32,768 bytes** of it is reclaimable and the rest is retained data, not churn).
**2,649 of its 2,790 `sessions` rows are Subagent sessions** (Census A), and 2,594 of those are older than
24 hours. No surface can read
any of them: `list_sessions` filters `is_subagent = 0` in **both** arms and `session_recency` filters it
too, and no IPC command takes an `is_subagent` argument or can name a child. The rows are not bloat and
not a leak — they are retained data retained **forever, for a reader that was never built**.

**Decision: bound them, and return the bytes.** Six parts:

1. **`sessions.parent_session_id`** — nullable, **no `DEFAULT`**. `NULL` means "parent never known", which
   is honest for the ~50% of existing children already orphaned; a `DEFAULT` would invent a parent, the
   phantom-`$0.00` mistake the `cost_usd` migration refuses. Added by a desktop `gate(…)`; **no crate
   change** — the crate's `ensure_session_row` creates the child row and the desktop fills the parent in
   afterwards.
2. **The router writes it**, after `p.apply(…)`, and **only when `session_id != child_id`** — when they are
   equal the crate's `drives` lookup missed and the delivery id is the child's own. Skipping leaves `NULL`,
   never a wrong parent: **it fails safe and is idempotent.** It does **not** "self-heal on the next frame" —
   that sentence is in the research report (`:575`) and it is **false**; do not repeat it here. The crate
   inserts the `drives` entry **once, at dispatch**, and removes it **at teardown**, and never re-inserts it,
   so a delivery-id miss can only happen at the **end** of a child's stream — there is no later frame left to
   resolve it. The guard is right (skip, leave `NULL`, never invent a parent); the *reason* the report gave is
   wrong, and the honest consequence is weaker: **a child whose delivery id raced keeps `parent_session_id =
   NULL` forever.** That is exactly the population `NULL` was designed to mean, so the design absorbs the miss
   — but it absorbs it by staying unknown, not by recovering. **Why the guard compares those two ids at all
   is ADR 0117's ruling, not this one's:** a frame's **delivery address** is a UI-scope key and is never a
   reply/origin address, so the id the pump hands a child's frame to the Client under is the **parent's**, and
   the child's own id has to be read out of the payload (`CONTEXT.md` now names both terms — **delivery
   address** `:433`, **origin address** `:436`). This ADR borrows that distinction to key the parent link; it
   does not re-argue it, and it is not the reason `0117` exists.
3. **Archiving a Session prunes its closed children** — per child: flush the batch buffer, then delete the
   whole **provider transcript** (`native_messages`) and every **stored display row** (`messages`) except
   the newest. Inline; only the `VACUUM` is expensive.
4. **Deleting a Session prunes its children with the same verb** — the case archive can never reach, because
   `ON DELETE CASCADE` destroys the parent's rows while the children survive: **1,325 of 2,643 existing
   children (50.1%) already have a deleted parent.**
5. **A one-time upgrade sweep**, marked by `PRAGMA user_version` (`RETENTION_SCHEMA_MARKER` = 1; the pragma
   is verified unused — `grep -rn "user_version" src-tauri/src/` is exit 1), sweeping every **closed Subagent
   session** older than **`MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE` = 24 h**. **Not inside `Db::open`** — the
   journal-pragma comment records that the gates and the drop-migration are "the expensive writes, and they
   are the reason an upgrade-first open used to stall the window". A 2 GB delete there reintroduces exactly
   that stall.
6. **`VACUUM`, threshold-gated and idle-gated** — `Db::vacuum_if_freelist_over(threshold_bytes)` runs only
   when `freelist_count × page_size` exceeds **`VACUUM_FREELIST_THRESHOLD_BYTES` = 256 MiB**, and only with
   the idle gate re-checked immediately before. `RETENTION_TICK_INTERVAL` = 15 min is the Supervisor's tick
   (`src-tauri/src/agent/retention.rs`), never a bound on a live child.

The verbs, verbatim: `Db::prune_closed_subagent_transcripts(&self, max_age: Duration) ->
Result<PrunedCounts, DbError>` and `Db::vacuum_if_freelist_over(&self, threshold_bytes: u64) ->
Result<bool, DbError>`, both in `src-tauri/src/storage/db/retention.rs`. The verb lives in a **new sibling file
under `db/`** because ADR 0113 splits `db` **by subject**, and retention is its own subject. That placement costs
nothing in access: `struct Db` and its `conn` field are declared in `db/mod.rs`, and `db/mod.rs` declares its
children with bare `mod` declarations, so every `db/*.rs` child is a **descendant** module of `db` and already
reads `self.conn` — the existing siblings do exactly this (`sessions.rs`, `board.rs`, `messages.rs`, `spaces.rs`,
`stages.rs`, `artifacts.rs`, `tasks.rs` all call `self.conn`). **A sibling is precisely where `conn` is reachable
without widening anything**, which is why each verb is an `impl Db` in `db/retention.rs` rather than a method
added to `mod.rs`. (This is *not* an ADR 0113 rule about `Db::conn` — 0113 is the mirror-test-tree ADR and says
nothing about the field or its privacy. What it does say, and what this respects, is that a sibling may read the
**parent's** private items but not another **sibling's** private item.)

## What goes, and what stays — named in the vocabulary that names it

Per pruned child: **every `messages` row but `MAX(id)`** goes, and **the entire `native_messages` provider
transcript** goes. **The `sessions` row survives** — 0.6 MB for the 2,639 subagent rows of **Census B** (the
snapshot that measured it; Census A counts 2,649, which is the same population 151 MB and a few children later),
and it carries `cost_usd`.

- The kept row is `MAX(id)` **regardless of `kind`**. Measured: 2,447 of 2,597 children end on `agent-text`,
  **77 end on `tool-call` and 73 on `agent-thought`** — a `kind = 'agent-text'` filter would keep *nothing*
  for 6% of children. (Those three numbers are one census and they add up: 2,447 + 77 + 73 = 2,597. The
  **2,449** in the reader section below is a **different read** — the rawOutput-matching measurement, taken
  separately — not a correction of this one. Quote each with its own instrument; do not "harmonise" them.)
- The kept row is not a **Transcript row** (that glossary term names a rendered UI line). Say **the newest
  `messages` row**.
- **`archived = 1` rows are never swept by the timer.** Archive is a *view* action — `CONTEXT.md`'s
  **Archived session** entry (`:114`) says archiving a stored Session is "a view property — the flag and
  nothing else" and that either way "the transcript stays in the desktop's storage, the session is still
  openable and resumable"; that entry describes **ADR 0016 as amended 2026-10-20** (0016:28 — "Archive stays
  hide-not-destroy (the `sessions` row and its transcript survive, the session stays openable and
  resumable)"). Both quoted phrases are the **glossary's** wording, not ADR 0016's — `grep -c` for either in
  `docs/decisions/0016-session-archive-first-delete.md` is **0**. This rule
  sets no flag and is not Archive; where it *is* triggered by Archive (part 3) the user caused it.
- **A `Stalled` session is not eligible.** No `agent_settled` means incomplete, and a Stalled session is
  resumable. Eligibility is **closed**, which is terminal and irreversible because a Subagent session is
  *ephemeral, no resume*.

## Why 24 hours is a floor and not the predicate — the ADR 0055 lesson

ADR 0055 deleted the delegation-duration bound precisely because **"a Worker that deadlocks INSIDE a tool
keeps an outstanding `tool_call_id` forever and is therefore never reaped"**, and its amendment sharpens the
same point: the Dead bound measures silence **as the Supervisor OBSERVES it**, so a measurement can say
otherwise about a child that never stopped. **A wall-clock age alone cannot tell a wedged child from a busy
one.** So the age is never the predicate:

- the predicate is **closed Subagent session** — its **Worker process** has exited;
- `MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE` is a **floor beneath** that test, keyed on `sessions.created_at`,
  which for a child is a stable lower bound because nothing touches a child's row after it closes;
- the background sweep additionally requires the **idle gate**, and it is **three** conditions, not one:
  `SessionManager::session_count() == 0` **and** `WorkerManager::test_session_count() == 0` **and**
  `WorkerManager::test_drive_count() == 0`. The second and third are load-bearing: `row.live` is set at
  exactly one production site (the main-session start/resume path), so **`session_count()` is blind to a
  running Subagent session** — which is the exact population this rule must not touch. The crate says so about
  its own accessor: a subagent Worker **"is NOT in `workers`, so `test_session_count` never sees it"**, and
  `test_drive_count` is the in-flight `drives` view. **This three-condition gate supersedes the design doc's
  part 6 "Why this is safe"**, which rested safety on `session_count() == 0` alone — that claim is no longer
  true as written, and this ADR is where the corrected gate belongs, because this gate is what answers ADR
  0055's never-reaped-while-in-a-tool objection. Reaching for the
  `test_*`-prefixed accessors from production code is a naming smell; they are the crate author's
  deliberately-ungated way to see drives, and the alternative (`drive_count()`) is `pub(crate)`.
- **The batch buffer is not a footgun the age can ignore.** The display write is an upsert
  (`ON CONFLICT(session_id, kind, message_key) DO UPDATE`), `BatchingPersistence` is in-memory and flushes
  every `DEFAULT_FLUSH_INTERVAL` = 250 ms, and because the `sessions` row is deliberately **kept** the FK
  does not refuse a late insert — so a prune that races the buffer has its rows **resurrected with a larger
  `rowid`**, i.e. re-appearing at the END of the transcript. For the sweep the 24 h floor closes the hole by
  construction (a >24 h-old child cannot have rows in a 250 ms buffer); for the archive and delete triggers
  `flush_session(child)` closes it explicitly. **Neither `Db` verb can drain the buffer** — `Db::conn` is
  private — so draining is the trigger's job through the managed `Arc<BatchingPersistence>`.

## The reclaim, measured

**Census B** (the research report's correction 6, read 2026-11-22 at `94af00d1`; 2,825 MB file, 2,779
`sessions`, 2,639 subagents, 2,583 of them past 24 h). At a 24 h age bound against that snapshot:
**2,042 MB of a 2,825 MB file (72%)**, keeping **23.4 MB** —
1,331.3 MB of display payload and 710.7 MB of provider transcript out, 23.4 MB of final reports kept
(0.8% of the file). Growth is ~35 MiB/day (~500–675 MiB/month), essentially all Subagent fan-out, so the
next 2 GiB arrives in about 60 days without this rule. **The 72% is Census B's own ratio** — against Census A's
2,976,337,920-byte denominator the same 2,042 MB is a smaller percentage, and the two must not be mixed.

## The `VACUUM` threshold, measured — and why the no-work case is the expensive one

`docs/features/transcript-render-perf-known-gaps.md` §5.1 refuses to tune `wal_autocheckpoint` on the
grounds that *"tuning the autocheckpoint blind … would trade one stall for another with no measurement to
say which is cheaper"* — this corpus's **"no data, no knob"** posture on database tuning. A freelist
threshold is a first-ever tuning decision on this database, so it is taken with a measurement, not an
opinion. Measured on this machine, SQLite 3.53.4, `journal_mode = wal`, `synchronous = NORMAL`,
`page_size` = 4096, on synthetic databases of this size:

| File | Freelist | `VACUUM` | Peak extra disk | Reclaimed |
|---|---|---|---|---|
| 2,822 MiB | 1,978 MiB | 7,831 ms | +711 MiB (≈25%) | → 843 MiB |
| 3,261 MiB | 2,417 MiB | 8,314 ms | +850 MiB (≈26%) | → 843 MiB |
| **847 MiB** | **0** | **6,871 ms** | **+1,031 MiB (+122%)** | **nothing — 847 MiB before and after** |

**The cost tracks the file, not the work.** An ungated boot-time `VACUUM` therefore costs ~7 seconds of
whole-connection lock and ~1 GiB of peak disk **per boot** and returns **zero** bytes, because the live
database's freelist is 8 pages (32,768 B). `PRAGMA incremental_vacuum` is not a cheaper option: with
`auto_vacuum = 0` (the shipped state; `Db::open` never sets it) freeing 39,384 pages and asking for 1,000
back leaves `freelist_count` **unchanged**. Full `VACUUM` is the only reclaim available, and it cannot run
inside a transaction (`cannot VACUUM from within a transaction`, measured), so it is necessarily a separate
autocommit critical section from the deletes — a crash between the two leaves freed pages un-reclaimed,
which is idempotent and acceptable.

**Why 256 MiB — and what is measured versus what is chosen.** After the one-time sweep and its `VACUUM`, the
only thing that grows the freelist is this same rule pruning children as they pass 24 h — roughly one day's
Subagent bytes, ≈33 MiB at the rate this decision cites. 256 MiB is therefore **about a week (≈7.8 days at
33 MiB/day) of ordinary use**, and Census A's 32,768-byte freelist sits
**~8,000× below it** (Census C's 3 pages, 12,288 B, ~21,845× below): the sweep fires once at upgrade, and after
that a `VACUUM` is a **periodic** event, not a boot-time one. **Say the rate with the period, every time.** The
re-read **about a day** after this decision was drafted measured **+114.6 MiB over Census A**, and the interval
is measured rather than assumed — Census A's base commit is dated 2026-11-22 12:57 and the re-read is
2026-11-23 17:37, i.e. **≈1.19 days**, which makes the observed rate **≈96 MiB/day**. **Name which multiple you
mean, because there are two and they are not the same number:** the *rate* is **≈2.7–2.9× the quoted
≈33–35 MiB/day** (96 / 33 = 2.9; 96 / 35 = 2.7), while the *total* +114.6 MiB is 3.3–3.5× **one day's** quoted
growth — the second compares a 1.19-day total to a 1-day figure and must not be written as if it were a rate
comparison. Either way the threshold is **about 2.7 days** of ordinary use at the observed rate (256 / 96 = 2.67)
rather than a week — still inside "two to three days", now with the arithmetic behind the hedge. That does not
move the value: the gate errs toward NOT running, and a
freelist that refills in under three days rather than seven only means the check is passed more often, which costs 3 ms.
What it does move is the honesty of the word "weekly" — write "≈7.8 days at 33 MiB/day" or "≈2.7 days at the
observed ≈96 MiB/day", never "weekly" as a fact. Below the threshold the pages are **reused, not lost** — the freelist is
free space the database will spend before it grows the file — so declining to `VACUUM` at 40 MiB costs nothing but
a larger number in `du`. That is the asymmetry the threshold buys: `VACUUM` has a multi-second, whole-file,
mutex-holding cost and a ~1 GiB peak-disk cost, and reclaims nothing when the freelist is empty; the
freelist itself costs nothing at all. Reading the two `PRAGMA`s costs **3 ms**, so gating is cheap enough to
run on every tick.

**Stated plainly, because "no data, no knob" is the posture this section answers:** the table above measures
that **gating** is necessary — the empty-freelist row is the argument, and it is shape-insensitive. It does
**not** measure **256**. Nothing in the table varies the freelist below the file size, so no row of it shows
where `VACUUM` starts paying for itself. **256 MiB is not a measured optimum; it is one week of growth rounded
to a power of two**, chosen so the gate is cheap to check and rare enough never to be a boot-time event, and —
because pages below it are reused anyway — it errs toward **not** running. A round number dressed as a measurement
would be worse than this sentence.

**Peak disk, honestly.** SQLite's documentation suggests expecting up to **2× the file size** in free disk, but
**treat that as a rule of thumb, not a ceiling, because the third row above exceeds it**: the two measured
regimes span **+25% (711 MiB on 2,822 MiB) to +122% (1,031 MiB on 847 MiB — ≈2.22× the file)**. Peak-disk
tracks the **file**, not the freelist. Budget **2.5×** the file for the first sweep, or re-measure on the real
database before it runs.

## The single connection, accepted

`Db` holds **ONE** `Connection` behind a `StdMutex<Connection>`. **A `VACUUM` therefore blocks every other
database verb — including the batching flush — for its whole multi-second duration.** The idle gate mitigates
this; **it does not cure it.** A user who opens a session in the second the `VACUUM` starts waits on the
mutex. Accepted knowingly, with three stated costs:

- the reclaim **lags** (a delete does not shrink the file; only the threshold-gated `VACUUM` does);
- the idle gate is a **prediction**, not a lock — the tick can pass the gate and be beaten to the mutex;
- **the sweep's own `DELETE` is not free either**: freeing 2,417 MiB (450,000 rows) measured **13.4–19.3 s**
  on synthetic data of this shape, and the one-time sweep deletes **410,233** stored display rows and **387,750**
  provider-transcript rows on the machine this decision was taken on (measured: 412,827 display rows on the 2,594
  eligible children, less the one row kept per child).
  The mutex is held for tens of seconds by the delete *before* the `VACUUM`'s ~8 s begins. The mitigation is
  the same one (idle, off the main thread, outside `Db::open`), and the honest statement is that the one-time
  upgrade sweep is the single longest database stall this application has ever deliberately caused.

## What this is NOT

- **Not ADR 0117, and not a second bite at the same seam.** `docs/decisions/0117-…-never-a-reply-address.md`
  sits one file away, is also about **Subagent session**s, and rules on something else entirely: a frame's
  **delivery address** is a UI-scope key and never a reply address (the 255m55s `get_artifact` board hang).
  A reader who lands here from `0117` should know the two ADRs share a subject and share no decision. This
  one is about **how long a closed child's bytes live**; `0117` is about **which id may be answered**. This
  ADR cites `0117` for the delivery/origin distinction it borrows (part 2) and borrows nothing else from it.
- **Not ADR 0016's delete path.** Nothing was asked for, no confirm dialog, and **the `sessions` row
  survives** with its transcript's newest row intact. 0016's Delete is cascade-whole-session and is one of
  the two doors a user opens deliberately; this is neither. It is also not Archive, which `CONTEXT.md`'s
  **Archived session** entry (`:114`, describing ADR 0016 as amended **2026-10-20**) calls "a view property —
  the flag and nothing else", with the transcript staying in the desktop's storage.
- **Not ADR 0008's escape hatch.** 0008 anticipated `messages` growth and offered a hatch — *"if growth ever
  bites, a one-off data migration rewrites rows to `path` references"* — but that hatch is scoped to inline
  base64 attachments, and attachments are **0.16% of the display table**. A reader who finds "Escape hatch:
  if growth ever bites" and concludes this is already decided elsewhere is wrong: the hatch is not this
  hatch. 0008's only byte bound is **per-message** (the 10 MiB cap); nothing in the corpus bounded a
  session's **lifetime**, and that is the gap this closes.
- **Not a `wal_autocheckpoint` tuning.** §5.1's refusal stands and is unamended.

## The reader question, closed

The audit that produced this design reported that the kept row "has **no reader**", and that finding was
**wrong**. A child's final report is delivered to the parent as the `subagent` tool result and persisted in
the **parent's own** stored display row — `payload_json.rawOutput.content[0].text`, which this change does
not touch — and `ToolCallCard` renders `rawOutput` on expand. Measured: **1,102** `subagent` tool-call rows
in main sessions carry a `rawOutput`, **961** of them over 500 chars, max 212 KB; of the 2,449 children whose
last display row is `agent-text`, **889 (36.3%)** match a parent's `rawOutput` on a 160-char prefix. So the
kept row is partly **redundant**, and it is kept anyway (the owner's decision) for 23.4 MB — 0.8% — because
the 64% that do not match have not had their cause measured, and the child's own newest row is the only
verbatim copy for those. Shipping a dedicated reader for it is **out of scope**.

## "But what if someone resumes it?"

`resume_native_session` has **no `is_subagent` guard at all** — verified, the function body never mentions
the flag. Deleting a closed child's provider transcript therefore cannot break a *reachable* path only
because **no surface can name a child id**: every list the frontend can ask for is `is_subagent = 0` filtered,
the child sheet reads the in-memory store and never the database, and `discardSessionMessages` deletes that
store entry at `subagent-closed`. The safety is the list filter, not the resume path. That is stated here
rather than fixed here, because a guard on a path nothing can reach would be a pin on an unreachable branch —
and because the same filter is the fact this whole decision is built on.

## Considered Options

- **Delete the child's rows at close (rejected).** Re-creates, immediately, the exact defect ADR 0025 was
  written to fix: a 32-minute child's work un-inspectable after the fact, with no window at all in which the
  "what did it actually do" question can be answered from the child's own copy.
- **Keep everything (rejected).** That is the state being corrected: 2,042 MB of a 2,825 MB file, unreachable
  by design, growing ~2 GiB every 60 days, with a rationale — *"inspectable in a debug view"* — that was never
  implemented.
- **Age-only pruning, no idle gate and no closed test (rejected).** ADR 0055 rules this class unsafe: a child
  deadlocked inside a tool holds an outstanding `tool_call_id` forever, is never reaped, and can outlive any
  age bound. An age-only sweep would delete the transcript of exactly the child whose outcome nobody observed.
- **`auto_vacuum = INCREMENTAL` instead of a gated `VACUUM` (rejected).** `auto_vacuum` is `0` on every
  existing database, and changing it requires a full `VACUUM` to take effect anyway; `incremental_vacuum` is a
  measured no-op while it is `0`. Adopting it would mean the same one-time cost plus a schema-adjacent behaviour
  change for every future write.
- **`VACUUM` on every boot (rejected).** Measured: ~7 s of mutex hold and ~1 GiB of peak disk to reclaim
  **nothing** at today's 8-page freelist. This is §5.1's objection answered with data rather than inherited.
- **Put the sweep in `Db::open` (rejected).** The journal-pragma comment names the gates and the drop-migration
  as "the expensive writes … the reason an upgrade-first open used to stall the window". A 2 GB delete there is
  that stall, worse.

## Consequences

- **A closed Subagent session's transcript now has a lifetime.** Past `MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE` its
  provider transcript is gone entirely and its stored display rows are gone except the newest, and **nothing can
  recover them**. This is the hard-to-reverse core of the decision, named here rather than in a footnote, in the
  spirit of ADR 0022's *"gone by design"*.
- `~/.local/share/archimedes/archimedes.db` is **bounded** for the first time. The one-time sweep reclaims
  ~2,042 MB of a 2,825 MB file on the upgrade (**Census B**, the research report's correction-6 snapshot — see
  the census note at the top; the file had already grown past 2.9 GB by Census A the same day); after that the
  file grows and shrinks on a periodic cycle (days, not boots) instead of monotonically.
- **A `VACUUM` blocks every database verb for its duration** (above). Idle-gated, not cured. **Peak disk for
  the first sweep must be budgeted at 2.5× the file**, not at SQLite's customary 2× — the measured range is
  +25% to +122% and the empty-freelist case exceeded 2×, so 2× is not a ceiling here.
- **Silence is a decision, not an omission.** Nothing is surfaced: no byte figure in the UI, no Settings knob,
  no notification. `Settings` is crate-owned behind a version pin, so a `settings.json` key would need a crate
  release — but the reason there is no knob is that a retention rule with no reader and no unit the user can
  reason about is not a decision a user can make better than the default.
- **`docs/features/transcript-diff-channel.md`'s `verified-by:` probe is corrected in this same change**, because
  a live `DELETE FROM messages` lands beside it — and because the sentence was **already stale** (the doc-comment
  it described was removed by PR #158, so the probe has been exit 1 since 2026-11-05).
- **`docs/features/subagent-sessions.md` is corrected in this same change.** Its **persistence** clauses have
  described a throwaway `:memory:` `Db` and a `TempFileGuard` since before ADR 0025 deleted them on
  2026-10-04, and they survived PR #217's 2026-11-23 re-stamp, which re-verified the **addressing** rule and
  two dead paths and never touched them. A stamp now **seven weeks** newer than the deletion (revision 2 said
  three weeks, against the old `last-verified: 2026-10-27`) is the whole point: a reader trusting the file
  concludes subagent rows never persist and that this rule is a no-op.
- **ADR 0025 is amended, not superseded**, in its own file, per its own precedent.

## What this depends on and what depends on it

*(Not `## Related` — that heading appears in **0 of 109** ADRs, and this file must not be the corpus's only one
to carry it. Prose section headings are house style — `docs/decisions/` has `## Why this is NOT the deferred §6
rename batch`, `## What refutes this`, `## Honesty about what this ADR could not check`, and more. Same list,
house-shaped heading.)*

- `docs/research/database-size-unbounded-transcript-growth.md` §"Approved design (2026-11-22)" — the design of
  record this ADR rules on; every measurement above is reproduced there with its instrument.
- `docs/decisions/0117-a-frames-delivery-address-is-a-ui-scope-key-and-never-a-reply-address.md` — the **delivery
  address / origin address** rule this decision borrows for part 2's guard, and the ADR this one must not be
  conflated with. Both are about **Subagent session**s and they sit one file apart; see "What this is NOT".
  `CONTEXT.md` carries both terms (**delivery address** `:433`, **origin address** `:436`).
- `docs/decisions/0025-sessions-in-worker-processes.md` — amended by this decision (2026-11-23): the clause
  *"inspectable in a debug view"* is retired, and what changed in the argument is stated there.
- `docs/decisions/0055-subagent-liveness-is-tool-boundaries-not-duration.md` — why an age bound alone is unsafe.
- `docs/decisions/0016-session-archive-first-delete.md` — why this is neither of the two doors to Delete.
- `docs/decisions/0022-native-harness-only.md` — the two-table vocabulary, and the precedent for naming
  destruction in the decision sentence.
- `docs/decisions/0008-inline-attachment-persistence.md` — the growth concern that did not materialize, and the
  escape hatch that is not this hatch.
- `docs/features/transcript-render-perf-known-gaps.md` §5.1 — the "no data, no knob" posture this threshold
  answers with the table above.
