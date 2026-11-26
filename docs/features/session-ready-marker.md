---
status: live
last-verified: 2026-11-26
verified-by: read against this tree at `feature/mark-done-host-verb` (HEAD `ace2ffbb`) — `src-tauri/src/agent/host_tools/specs.rs` (**EIGHT** specs, `mark_done` the eighth, with `{"properties":{},"required":[]}`), `src-tauri/src/agent/host_tools/exec/session.rs` (`mark_done` — the frame's origin id as its subject, the Subagent refusal), `src-tauri/src/agent/host_tools/tests/surface.rs` (`no_host_tool_spec_names_read_or_subagent`, `the_composed_advertised_set_is_the_twenty_six_names_plus_mark_done`), `src-tauri/src/agent/host_tools/tests/verbs.rs` (the five `mark_done_*` pins), `src-tauri/src/storage/db/mod.rs` (the **20th** `gate` — `sessions` / `ready`, no `DEFAULT`, `backfill_session_ready` on the SAME transaction as the `ALTER`), `src-tauri/src/storage/db/migrations.rs::backfill_session_ready`, `src-tauri/src/storage/db/sessions.rs::set_session_ready`, `src-tauri/src/storage/db/board.rs` + `storage/db/rows.rs` (`TaskCardView.ready` — the per-card `OR`, DERIVED as `!ready_sessions.is_empty()` — and `TaskCardView.readySessions`, the claimants), `src-tauri/src/storage/db/tests/rows.rs` (`the_task_card_view_wire_keys_are_frozen`, SIX card keys, MOVED here from `tests/board.rs`), `src-tauri/src/agent/session/mod.rs` (`send_prompt_with_images` → `set_session_ready(…, Some(false))`), `src/store/interactive.ts` (`ReadyCardEntry`, `readyCardKey`, `readyFence` + `readyTicket` + `raiseReadyFence`, `applyReadyMarks`, `clearReady`), `src/store/sessions.ts` (`beginTurn`), `src/store/tasks.ts` (`refresh` — the board feed), `src/lib/sessionStatusRollup.ts` (`cardMarkOf`), `components/TaskCard.tsx` (the one mark), `hooks/useTaskBoardAutoRefresh.ts` (the falling-edge trigger). DELETED and confirmed gone — `lib/readyMarker.ts`, `READY_MARKER_TEXT`, `isReadyMarker`, `boardAssertsReady`; `grep -rn` over `src/` gives **0** hits for all four, and this stamp names the shipped mechanism in their place because the previous one named only the deleted ones. Rust and TypeScript read, not executed — no test in this repo reads `docs/`, so the greps above ARE the instrument.
---

# The session `ready` marker

A **claim the model makes, stored in a column.** A Session that wants to say "the work
on this Session is finished and someone should look at it" calls the `mark_done`
**Host tool**, which writes `sessions.ready = 1` for the calling Session. The board
read carries that flag out as `TaskCardView.ready` — an `OR` over a card's linked
Sessions — and the desktop puts a bell on every card the read reports ready.

This document exists because the mark **looks** like a status and is not one, because
it is a per-Session fact rendered as a per-Card one, and because it used to be a
**convention** — a todo item whose content was the single word `ready` — and that
history is load-bearing rather than incidental: the migration that replaced the word
READS the word out of stored rows, so a reader who treats the old rule as dead prose
will break the backfill's premise.

## The rule, exactly

A Session is ready when `sessions.ready` is `1` for it. Nothing else sets it.

- `mark_done` writes `1` — and only for the Session that called it. The verb takes NO
  arguments; its subject is the frame's origin id, so a Session cannot mark another
  one done, and a **Subagent session**'s call is REFUSED with a reason (a child's
  completion is not a card's fact — cards link to the Session that launched the work).
- A turn start writes `0`, unconditionally, from Rust.
- `NULL` means the column has never been written for that row.

The board folds the three states into a `bool` per card: `ready` is true when ANY
linked Session holds `Some(1)`, so `NULL` and `0` are the same `false` to every
consumer. `cardMarkOf` then ranks it `waiting` > `ready` > `running`, and one mark
renders.

### The retired rule (the migration reads it — do not delete this)

Until 2026-11-26 the mechanism was a word, and its two halves were: a `ChecklistItem`
with `content.trim().toLowerCase() === "ready"` (**exact**, not a substring — "get the
board ready" is a plan item *about* readiness) **and** `status === "completed"` (a
*pending* `"ready"` means "still need to make it ready" — the opposite of the claim).
`READY_MARKER_TEXT`, `isReadyMarker` and `boardAssertsReady` were the definition and
they are **deleted**; `src/lib/readyMarker.ts` no longer exists and `interactive.ts`
scrapes nothing.

Those two halves survive in exactly one place:
`storage/db/migrations.rs::backfill_session_ready`, the 20th migration's data step,
which marks `1` exactly the rows whose stored `todos_json` still holds a `completed`
item whose content is that word — the same exactness, the same status test — so no
user loses a mark they already had. It writes `1` for a match and NOTHING for a
non-match, never `0` and never an explicit `NULL`, because absent is already `NULL`
and `NULL` is the honest answer for a row that never claimed anything.

## Why it was a convention for so long, and why it is a tool now

**A model-facing verb used to be engine-gated, and this repo could not add one.**
`TaskCall` and `trait TaskStore` lived in `fulcrum-harness`, a **crates.io-pinned**
dependency (`src-tauri/Cargo.toml`), and `tool_specs()` was the crate's — the desktop
contributed **zero** tool specs. A new verb meant an engine change, a crates.io
publish, and a pin bump here.

**That gate is gone, and the verb got built.** ADR 0102 / issue #183 landed on
2026-11-25: `trait TaskStore` is deleted from the crate and the desktop ships its own
**Host tool** specs from `src-tauri/src/agent/host_tools/` as data on
`StartEnv.host_tools`, so a tool can be added without publishing a crate release. The
run itself shipped **seven** — the board and artifact verbs, carried over verbatim from
the crate's `tool_specs()` entries 20–26. `mark_done` is the **eighth**, added after
that run, and it is the first spec text this repo has ever *written* rather than
inherited. `host_tool_specs()` returns eight; `agent/host_tools/tests/surface.rs` pins
the count, the disjoint-and-composed census (**27** names, the 26 the model saw at
0.7.0 plus `mark_done`), and the `read`/`subagent` substring ban.

**Why the verb is called `mark_done` and not `mark_ready`.** The obvious name is
banned by a live test. `no_host_tool_spec_names_read_or_subagent`
(`agent/host_tools/tests/surface.rs`) scans the WHOLE spec — name, description and
parameters JSON — for the substrings `read` and `subagent`, and it fails on any host
spec that carries either. `ready` contains `read`. So the flag is called a **flag** and a
**claim** in every piece of spec prose that exists, and the verb is `mark_done`. Do not
"fix" the naming mismatch between the verb and the column — it is what the ban forces,
and the pin is the reason.

One caveat about that pin, stated because this doc's whole subject is citations that
stopped resolving: the test's own comment says the ban exists so that "`worker_e2e`'s
`!tools_section.contains(\"read\")` assertion" cannot start passing while proving
nothing. **That assertion no longer exists.** Issue #180 F1 replaced it with
`assert_advertised_tools`, which enumerates the advertised tool NAMES from the rendered
`<tools>` bullets and compares them to the case's enabled set — the commit message and
the comment there both record that the substring form had already been made *vacuous*,
since any tool whose description merely contained the word would let it pass. So the ban
is now enforcing a rule whose original justification was retired: the test is live, it
bites, and its stated reason is stale. That does not make `mark_done` renameable —
removing the ban is a separate decision with a CI-behaviour argument to re-litigate, not
a docs correction — but a reader who goes looking for the assertion the comment names will
find its replacement and should know why.

**Why the marker was a word and not a field, historically.** The engine **constructs**
`TodoItem { content, status, description }` and emits the *constructed* vector, so an
extra key on a checklist item (`"ready": true`) is dropped inside the crate, **before
the frame the desktop would read exists**. Only the model-authored *string* survived
that path. That is why the original mechanism was a word — and it is also why the word
was never a good long-term home for the claim: the fix could not be a field on the
thing the model already writes, it had to be a different channel entirely. That is what
shipped: a verb that writes a column, and a board read that carries it.

**Correction (2026-11-26) — the two citations this section carried never resolved, and
the deferral they were built on was never a tracked decision.** This paragraph used to
say "ADR 0102 §5 caps the run at the seven board and artifact verbs and §6 names
session lifecycle as the seam's *second consumer, recorded but not in scope*". **There
is no §5 and no §6 in ADR 0102.** `docs/decisions/0102-the-tool-registry-is-the-engines-sole-dispatch-authority-and-host-tools-arrive-as-data.md`
has exactly four headings — its title, `Considered options`, `Consequences`, and
`Amendment (2026-11-25) — as shipped: the D1/D2 boundary, narrow, and ONE WRONG TYPE
NAME` — and it contains neither the string `mark_ready` nor the word `lifecycle` nor
the phrase "second consumer". The seven-verb cap that the sentence was paraphrasing
lived in `docs/roadmap/tool-separation.md`, which is **gitignored** (`docs/roadmap/` is
in `.gitignore`) and **deleted** — plan families are removed on ship, and ADR 0102's own
Amendment records that the migration table it carried is "unrecoverable after a ship —
no checkout, no stash, no dangling blob". **So do not re-cite that file as "the real
home" of the cap either; that is the same defect one level down, a citation to a page no
reader can open.** What is true and tracked: ADR 0102's `Consequences` and its
2026-11-25 `Amendment` are the surviving record of the seven-verb run, and **no tracked
record ever named session lifecycle as this seam's second consumer.** The deferral was
real — that run's scope was the board verbs — but it was scoped in a file that no longer
exists, and this doc dressed that scope up as an ADR section number.
`docs/features/task-board-known-gaps.md` §2 is the durable record of the seven verbs
themselves.

**Correction (2026-11-26) — "if a `mark_ready` verb is ever built, the read path does
not change" was FALSE twice over, and it is the most expensive sentence this doc ever
carried.** It was false in the verb: one was built, named `mark_done` for the substring
reason above. It was false in the read path, and that is the half worth learning from:
the claim did not stay on the same channel. The board payload **gained a field**
(`TaskCardView.ready`, `storage/db/rows.rs`), the board read **gained a JOIN** on
`sessions` (`storage/db/board.rs` — the same channel `cost_usd` rides, and the only one
by which the board learns a per-session SQLite fact about a Session it has never
opened), and the word-scraping detector was **deleted** from `applyTodoUpdate`
(`src/store/interactive.ts`), which now writes `todos` and nothing else.
`storage/db/tests/board.rs` puts three pins on that JOIN, and its header names this very
sentence as the false premise the change was written against. "The mark already rides a
store slot, so a verb swaps the *writer* only" was wrong because the store slot was
**fed by a transcript read**, and a transcript read cannot serve a Session nobody has
opened — the restart boundary below is the reason the read had to change, and it is why
the write and the read moved together.

## The column, its three states, and why it has no `DEFAULT`

`sessions.ready` is a nullable `INTEGER` with **no `DEFAULT`**, added by the **20th**
migration gate in `storage/db/mod.rs` (`gate(&mut conn, "sessions", "ready", …)`;
`GATED` in `storage/db/tests/open.rs` is a 20-element list and its derivation pin proves
the set is `Db::open`'s actual gate surface rather than a list someone maintains by hand).
Three states, which is why `Db::set_session_ready` takes an `Option<bool>`:

| written | means |
|---|---|
| `1` | "this Session is done, come look" — the claim `mark_done` makes |
| `0` | "it was checked and it is NOT ready" — what every turn start writes |
| `NULL` | the column has never been written for this row |

The missing `DEFAULT` is the load-bearing part of the gate, and it is ADR 0082's
phantom-`$0.00` discipline with a flag in place of a cost: `DEFAULT 0` would migrate a
person's whole history into the *second* meaning — a verdict of "checked, and no" about
work nobody re-checked — and the flag would stop being a fact the moment it arrived.
`the_ready_gate_arrives_null_for_every_pre_existing_session`
(`storage/db/tests/migrations.rs`) reads `pragma_table_info('sessions').dflt_value` and
requires NULL, so a `DEFAULT` added later fails a pin rather than passing the `NULL`
asserts. `set_session_ready_roundtrips_all_three_states` in
`storage/db/tests/sessions.rs` pins the three states at the write verb.

The gate's ALTER and its one data step (`backfill_session_ready`) run in **one**
transaction, so a crash rolls both back and retries on the next open — the
`todos_json` gate's shape, for the same reason: the data step writes the column the
ALTER creates, so the two cannot be separated.

**What `NULL` does NOT mean, and this is where the obvious story is false.** `NULL` is
not "never claimed". `send_prompt_with_images` writes `Some(false)` — `0` — on **every**
turn start, unconditionally, so `0` is the dominant value for any Session that has ever
run a turn, a claim-then-worked Session and a never-claimed one land on the same `0`,
and the turn-start write does not preserve a "claimed then worked" distinction, it
destroys one. Nothing consumes the difference: the board read, the column's only reader,
folds the tri-state with `Some(1)` as its sole truthy value, so `NULL` and `0` are the
same `false` everywhere above storage. `None` is still reachable at the storage layer
(a hand-written row can hold it) and `set_session_ready` still accepts it; no production
caller writes it.

## Why the mark is a slot and not a derivation

The owner's clear rule is **"the next turn on that Session clears it."** That rule
cannot be derived. Deriving readiness as `ready && !inTurn` makes the mark **vanish
during a turn and reappear when it settles**, which is the opposite of the rule — and
`the mark does NOT come back when the turn settles`
(`src/store/sessionReadyMark.test.ts`) exists to stop that shape coming back. So the
render half is an explicit slot on `useInteractive`, `ready: Record<string, readonly
string[]>` keyed by `readyCardKey(spacePath, taskId)` — **per (Space, card)**, not per
Session, because `TaskCardView.ready` is a per-CARD `OR` and one card wears ONE bell;
keying it by Session would light the bell on a different card that merely shares a
linked Session (`a card that only links the UNREADY half of a ready card's links stays
unmarked`, `src/store/boardReadyMarks.test.ts`).

**The slot's VALUE is the CLAIMANTS, not every link.** It used to hold every linked
Session id, because the read carried only a per-card `bool` and could not say which link
claimed. That made the optimistic clears unable to do anything except ask "does this card
link B" and delete the whole mark — so a turn on a silent Session unlit a bell that a
different Session was still carrying in the column. `TaskCardView.readySessions` names
the owner, and a clear now removes ONE id and drops the key only when the list empties
(`a turn on the NON-claiming Session leaves the claiming Session's bell lit`, and its
`dismissSession` twin). The invariant `ready === readySessions.length > 0` is total and
is **structural in Rust**: `board.rs` folds the list and derives the `bool` from
`!ready_sessions.is_empty()` rather than folding both, so the two cannot drift.

### The clear is TWO writes, and both are needed

1. **Rust, at turn start** — `send_prompt_with_images` calls
   `set_session_ready(session_id, Some(false))` before it dispatches the prompt. It is
   the ONLY Rust entry that starts a turn (`send_prompt` delegates to it, and the
   prompt-queue flusher's `sendText` reaches it too), so one placement catches every
   path. It is best-effort (`let _ =`): a turn must not fail because a boolean column
   did not clear. **This is the half that survives a restart.** `useInteractive` has no
   `persist` middleware, so a renderer-only clear is gone on the next launch and the
   board read would hand the mark back on every boot — worse than the stale mark this
   column replaced.
2. **`beginTurn`, in the renderer** — `src/store/sessions.ts` calls
   `useInteractive.getState().clearReady(sessionId)`. The column is already `0` by the
   time this runs, so this write changes no truth; it changes **when the card stops
   lying**. `useTaskBoardAutoRefresh` re-reads the board only on `inTurn`'s **falling
   edge**, so with the Rust clear alone the bell would be worn for the entire turn that
   disproves it — and `cardMarkOf` ranks `ready` ABOVE `running`, which is exactly the
   "running but ready" pair the owner rejected on a real board. The optimistic clear
   bridges the gap between the column being cleared and the board being read again, and
   the next settle's read confirms it.

A third writer, `dismissSession`, withdraws the mark when a Session's Worker goes away,
so a dismissed Session's bell does not wait for that Space's next read (which can be
minutes). Three writers of one map is deliberate: one writes what is TRUE, the other two
write what is TRUE A MOMENT EARLIER, and nothing between them derives anything. **All
three now also raise the ready fence** — see "The ticket" below — and the two optimistic
ones withdraw a CLAIMANT rather than a card.

Ordering costs nothing here: the client's optimistic clear runs BEFORE the `sendPrompt`
IPC on both dispatch paths (`useChatPromptDispatch.ts` and `store/taskLaunch.ts` both
call `beginTurn` before they await), so the renderer's copy and the row agree by
construction whichever lands first. (What ordering now DOES cost is the ready fence —
a read dispatched before that clear is dropped. That is the fence working, and it is
argued in its own section rather than here.)

`applyTodoClear` (the `todos_clear` path) **no longer** drops the mark. That arm went
with the word: a checklist says nothing about readiness once readiness is a column, so a
cleared board is no longer a reason to withdraw a bell. A Session that stops being ready
has its column cleared in Rust and the next read says so; a DELETED Session is cleared by
`dismissSession`, which is the close that actually means the claim is over.

## Why the read is the board: the funnel moved

The old funnel was `applyTodoUpdate` — the single writer of `todos[sessionId]`, which
every producer passed through, so reading the word there bought live detection and
restart-when-opened for free. **That funnel is retired.** `applyTodoUpdate` writes
`todos` and nothing else now; two channels for one claim is what this change removed.

The new funnel is the **board read**. `useTasks.load` and `useTasks.refresh` both feed
`applyReadyMarks(spacePath, ticket, entries)` with what the read answered, and the feed
replaces
ONE Space's keys and leaves every other Space standing (a Space the user is not looking
at gets no read at all, and a global replace would wipe its marks). A read that agrees
with the slot returns the identical state object, because `TasksBoard` subscribes to this
map and the auto-refresh would otherwise re-render the whole board on every settle.

### The ticket: a read must say when it STARTED

A board read is an `await`, so a read dispatched **before** a turn starts can resolve
**after** `beginTurn` cleared the bell, carrying the pre-turn `ready: true` — and it would
write the mark straight back. `loadEpoch` (`src/store/tasks.ts`) cannot catch this: it
rejects a read superseded by **another read**, and starting a turn is not a read.

So the slot has a monotonic counter, `readyFence` (a module `let` in
`src/store/interactive.ts`). A reader takes a ticket from `readyTicket()` **before** the
`await` and hands it to `applyReadyMarks`; the feed drops the feed when
`ticket < readyFence`. Both optimistic writers raise the fence **unconditionally** — even
when they withdraw nothing, because the fence's question is "could a read in flight
already know what the user has just been told?", and it cannot.

**The accepted consequence, which is a product decision and not an artefact:** a
`mark_done` that lands MID-turn is not painted until the turn settles, because the read
that would carry it was dispatched before the clear. The owner chose this explicitly —
`cardMarkOf` ranks `ready` ABOVE `running`, so a mid-turn bell would hide the running dot,
and "the bell waits for the settle" is the pairing wanted on a real board. The durable
claim is never lost, only its paint: the falling-edge read carries it
(`the falling-edge read after the turn lights the bell the mid-turn claim earned`).
Dropping a feed **writes nothing**, so it can never unlight a bell already on screen, and
it gates the ready slot ONLY — column paint still goes through `loadEpoch`
(`the fence gates the ready slot ONLY — a dropped feed still paints the columns`).

## The restart boundary — CLOSED, and what closing it cost

The old honest limit: the seed restored `todos` only for a Session whose history was
**opened**, so a Session never reopened after a restart had no mark even though
`todos_json` still held the word. That was accepted then as "live only, fine".

**It is closed.** `get_board` JOINs `sessions` and folds `s.ready` into
`TaskCardView.ready`, so a card reports the bell for a Session the process has never
opened — `the_board_reports_ready_for_a_session_the_reopened_db_has_never_opened`
(`storage/db/tests/board.rs`) is that pin, and it is the acceptance criterion for the
whole change. `list_sessions` was not an alternative: `SessionRow` / `SessionInfo` are
crates.io-pinned types, so the board's link statement is the only channel by which the
board learns a per-session SQLite fact about a Session it has not opened — the same one
`cost_usd` rides.

The cost is the one the doc used to deny: a migration gate, the 20th, plus fields on a
frozen wire type (`TaskCardView` — REQUIRED, never `Option`, never
`skip_serializing_if`, for the documented reason every sibling field gives: an optional
field compiles against every fixture and then renders nothing when real data arrives).
`TaskCardView.ready` is a `bool` and NOT an `Option<bool>`, which deliberately differs
from `cost_usd`'s null rule one field above: a figure renders, so "never reported" and
"a real zero" must stay split all the way to the renderer, while a bell renders NOTHING
when the answer is no — `NULL` and `0` are the same answer to the question the card asks.
The tri-state is a STORAGE fact and the card has no use for it.

`readySessions: string[]` joined it with the PR #222 review fixes, and it is a LIST and
NOT `string[] | null` for the mirror-image reason: "nobody claims" is an ANSWER, so `[]`
says it and there is no absent state for a consumer to mishandle. Both halves of the
presence rule are pinned against `serde_json`
(`the_task_card_view_wire_keys_are_frozen`, now SIX card keys). **That pin moved** from
`storage/db/tests/board.rs` to `storage/db/tests/rows.rs` when `board.rs` passed its size
ratchet — it hand-builds a `TaskCardView` and asks what keys come out, which is a shape
question about types declared in `db/rows.rs` and never read a board, so the move is the
subject split the ratchet asks for and not a threshold edit. `db/tests/mod.rs`'s header
records it.

## The mark on the card

`TaskCard` renders a `BellRingIcon` (`data-testid="task-card-ready"`) in
`text-warning` when `cardMarkOf` resolves the card to `ready`.

- **ONE mark per card.** The card wears at most one glyph, chosen by
  `cardMarkOf` (`src/lib/sessionStatusRollup.ts`): `waiting` > `ready` > `running`.
  This **reversed** the first design, which painted a `ready` glyph *beside* the
  session mark and argued the pair was "more actionable than either half". The pair
  was built, and on a real board a green check next to an amber `?` read "finished,
  but blocked" — two marks disagreeing about whether anyone was needed. The fact a
  card reports is single, so the contradictory state is now **unrepresentable**
  rather than discouraged. `sessionStatus` and `sessionStatusRollupOf` are still
  untouched; the wider precedence lives beside them, not inside them.
- **Amber, and NOT a check.** The first glyph was `CircleCheckIcon` in
  `text-success`, which was a mistake the repo's own vocabulary should have
  prevented: `SubagentStatusIcon`'s `completed` case draws `CheckCircle2` in
  `text-success` and `ChecklistPanel`'s done indicator is a check circle in
  `text-success` too. The app spends real ink teaching that **a green tick means
  DONE** — and `ready` means the opposite, that a person is needed NOW to review. So
  it wears the attention hue the `?` already uses, and the SHAPE carries the
  difference: a bell for a hand-off, a question mark for a blockage, a spinner for
  progress. Sharing one hue across the attention family is coherent precisely
  because only one mark renders.
- **A separate prop, not a fifth `SessionStatus`.** Adding `"ready"` to that union
  would drag in `sessionStatusOf`, `useSessionStatus`, `SpaceTabs`,
  `TaskDetailDialog`, and `TasksBoard.test.tsx`'s dot census. The two inputs are
  also different KINDS of fact — one derived from live stores, one authored by the
  model — so the card takes both and `cardMarkOf` decides.
- **Glyph, never a coloured word.** `text-warning` as 12px *text* is a recorded
  defect (2.12 Everforest light), and `text-foreground-subtlest` on `bg-card` is
  2.36 / 2.18 with no palette gate able to see it. At 14px stroked the mark is WCAG
  non-text UI (the 3:1 class), where `text-warning` measures 3.00 on a white card.
- **Stroke compensated.** Lucide draws on a 24-unit viewBox at `stroke-width: 2`,
  so a 14px box renders ~1.17px — a hairline on the one mark with no text beside it.
  `READY_GLYPH_STROKE_WIDTH` matches `SessionStatusMark`'s own `?` compensation
  (1.25 rendered px). The two are a deliberate pair: change both.
- **Decoration, not a name.** `aria-hidden` + `role="presentation"`. `TaskCard` is a
  `RowButton`, and a `div[role="button"]`'s accessible name is computed recursively
  from its subtree, so an announced mark would rename the card mid-turn. Same reason
  `SpaceTabs` passes `announce={false}`.
- `SessionStatusMark`'s `className` prop is **geometry-only** — `cn()` drops an ink
  utility a caller passes — so the mark could not be re-inked from the card anyway.
  A dedicated glyph was the only option that did not silently diverge two surfaces.

## The board must be able to see it: the refresh

A mark whose value is immediacy is broken if the board cannot see a model's write.
`docs/features/task-board-known-gaps.md` **§2** records that a card the model writes
is invisible until the board remounts (`useTasks.load` had only mount/Space-change
call sites). Shipped with the mark, in the same branch:

- `useTasks.refresh(spacePath)` — the **silent** re-read. Same read, same
  `loadEpoch`, same in-flight position merge, and **no `loading` write at any point**
  and no error write. A background refresh that sets `loading` is a board that
  flashes blank on every settle.
- `useTaskBoardAutoRefresh(spacePath)` (`src/hooks/`) — fires on the **falling edge
  of `inTurn`** (the settle signal), debounced at 350 ms per Space, cancelled on
  Space change and unmount. Mounted by **both** `TasksBoard` and `WorkflowsCanvas`.
- No new Tauri event: the frontend already receives what a settle needs.

## How the model is told: the tool description

**A convention nobody is told about is a convention nobody uses** — and the telling
channel moved when the verb landed.

It used to be the **launch message**. There was no session verb, the tool descriptions
were engine-owned and could not say it from here, and `StartEnv.system_prompt` was not a
way out either: the harness's `(Fresh, Some(seed))` arm calls `prepend_system` and
**never** `build_main_prompt`, so "seeding" a Task Session would leave it blind to its own
`<tools>` section, its discovered skills, its `cwd` and `AGENTS.md`. So `lib/readyMarker.ts`
owned a sentence, `buildLaunchMessage` appended it **after** the `<task>` block, and every
card-launched Session got it for free.

**That trailer is deleted** (`src/lib/taskPrompt.ts` records the removal where it used to
sit). `mark_done` now carries its own description, written by this repo, in
`agent/host_tools/specs.rs`: it says the Session flags itself done, hands it to a person
for review, takes no arguments because the caller IS the subject, and that the flag
clears at the start of the next turn. A model learns the affordance from the same place it
learns every other affordance — the `<tools>` section — which is the only honest home for
it: a launch-message trailer told a model a rule about a tool that did not exist, and a
Session started from the sidebar or the workspace never called `buildLaunchMessage` at all,
so it was never told. `mark_done` is advertised to every Session instead, and
`list_tools_advertises_mark_done_to_settings` (`agent/host_tools/tests/verbs.rs`) pins that
Settings lists it too, which means a person can switch it off through `enabled_tools` — the
one thing the launch-message trailer could never do.

Note what the removal did NOT disturb: the `<task>` block-last pins guard the fact that the
block is appended AFTER mention expansion, so a card titled `$deploy` cannot inject a
skill. That is a claim about the expander's argument, not about who is last in the string,
and dropping a static trailer after the block leaves it exactly as it was — the spy case in
`taskPrompt.test.ts` still pins it.

## Amendment (2026-11-26) — the word retired, and why ADR 0093's dual-reader rule does NOT apply here

The mechanism is now the verb + the column + the board read, described above. The marker
**word** is retired, and the retirement is the part a careful reader will try to reverse, so
the argument is written down rather than left to inference.

`docs/decisions/0093-…` rules that a rename which leaves stored data alone must still keep
**dual readers permanently**: `backfill_session_todos` selects historical rows by the
literal string `manage_todo_list` out of already-stored `messages.payload_json`, so old rows
are never rewritten and any reader that stops matching the old spelling silently loses them.
That rule is correct and it still binds. **It does not bind here, and the difference is the
direction of the data step.** The `manage_todo_list` → **Checklist** rename renames **no
data** — the stored rows keep the old spelling forever, so the reader must learn to see both.
This change **rewrites the data**: `backfill_session_ready` reads every stored marker out of
`todos_json` at open and lands it in `sessions.ready`, once, in the same transaction as the
`ALTER`, and `the_ready_backfill_does_not_rerun_on_a_second_open` pins that it runs once.
After that gate the word in `todos_json` is **read by nothing** — a copy at rest, not a
source of truth — so a dual reader here would not preserve information, it would maintain a
SECOND LIVE CHANNEL for one claim, which is precisely what the change set out to remove.

So: do not restore a word-scraping reader in `applyTodoUpdate`, and do not re-add the
launch-message trailer. Both are deleted on purpose, and the migration is the reason they
are allowed to stay deleted. What must survive is the *backfill's* copy of the old rule —
the exact-and-`completed` test in `storage/db/migrations.rs` — because that is the code that
still reads the word, and it is what keeps a user's existing mark.

Three further things this amendment fixes in place, all of them citations that did not
resolve (each was checked against this tree, not against the prose that carried it):

- **"ADR 0102 §5 caps the run at the seven board and artifact verbs and §6 names session
  lifecycle as the seam's second consumer"** — false. ADR 0102 has no numbered sections
  (`Considered options`, `Consequences`, `Amendment (2026-11-25)` are its headings) and never
  contains `mark_ready`, `lifecycle`, or "second consumer". The cap lived in a gitignored,
  deleted plan file; see the correction above for what is actually tracked.
- **"If a `mark_ready` verb is ever built, the read path does not change"** — false, in both
  halves; see the correction above. The board payload gained `ready` and the detector was
  deleted.
- **"`GATED` is pinned at 19 … deliberately not paid"** — paid. `GATED` is a 20-element list,
  the 20th gate is `sessions` / `ready`, and the restart boundary that figure was the price of
  is closed.

And the counts the sibling docs and comments carry: `host_tool_specs()` is **8** (seven
inherited board/artifact verbs + `mark_done`), and the composed advertised set is **27**
names (the 26 of 0.7.0, unchanged, plus `mark_done`). Where a comment still says "seven",
read it as the board/artifact SUBSET — that is what `host_tools/mod.rs` and `specs.rs` mean
by it, and there the word is right.

