---
status: accepted
date: 2026-10-20
superseded-by:
---

# The store holds a History window, and session state is never derived from it

> **Renumbered from ADR 0066 on 2026-10-23.** Two decisions were committed on 2026-10-20 under the
> same number: this one (09:53, `a277dd5`) and *Agent overrides live in the store, not the database*
> (20:54, `6969610`, alongside ADRs 0067 and 0068 which cross-reference it by number). **0066 stays
> with the Agent-overrides decision**, on two grounds. Volume: measured at the commit before the
> move, 82 `ADR 0066` occurrences — **69 mean that one, 13 mean this one** (`src-tauri/` 49 of which 7
> are this decision; `src/` 15 of which 4; `docs/` 13 none; `CONTEXT.md` 5 of which 2). And adjacency:
> 0066/0067/0068 were committed as one trilogy in a single commit and reference each other by number,
> so moving the Agent-overrides file would sever those cross-references while moving this one severs
> nothing. No decision changed; only its address.
>
> **The first pass at this move missed the 7 `src-tauri/` sites** (paged history in `commands/history.rs`,
> the `todos_json` migration and updates in `storage/db.rs`, the Supervisor's event-router persistence in
> `agent/persist.rs`) because the sweep grepped `docs/` and `src/` and assumed the Rust hits were uniform.
> They were not — which is the same failure the counts above were written to prevent. If you are here to
> renumber something else, grep the whole tree including `src-tauri/`.

A stored **Session**'s transcript is loaded as a **History window** — the latest 500 display rows, with 200 more prepended per scroll-up page (`load_history` takes `limit` / `beforeId`, cursor = the autoincrement `messages.id`) — and rendered through a virtualized list (`react-virtuoso`). `useSessions.messages[sessionId]` is therefore a *window onto* the transcript, never the transcript. Anything that must be correct regardless of how far the user has scrolled is **session state** with its own storage, and is never recovered by scanning `messages[]`. The first such case is the **Todo board**: its list is persisted in `sessions.todos_json` (written by the **Supervisor**'s event router on a main session's `todos_update` frame, and returned as `todos` on the FIRST page of `load_history`, which seeds `useInteractive.todos` on open / resume), and `useMainTodoItems`' history-scan fallback is deleted.

**Why:** an unbounded `load_history` made load time and draw cost O(session length) — the IPC payload, the `rowToMessages` parse (base64 image attachments dominate) and one DOM subtree per row. Bounding only the render would leave the load cost; bounding only the load would leave a long live transcript unbounded in the DOM. But a windowed store silently breaks every reader that assumed `messages[]` is complete, and the Todo board was the one that mattered: it found the newest `manage_todo_list` write by scanning backwards, so a write older than the window made the board vanish on reload. Making the invariant explicit ("the store is a window") is what stops the next reader from re-introducing the scan.

**Considered Options**

- **Render-only window** (load everything, render the last N): rejected — fixes draw cost and not load time.
- **Return the newest todo row with the first page**: rejected — keeps the board derived from a transcript row, so the fix would be one more special case of the same assumption instead of removing it.
- **A bounded sliding window in the store** (evict the far end as the user scrolls): rejected — a streaming tail cannot be evicted, and the ADR 0050 resume merge would need rework; the DOM is bounded by virtualization either way.

## Amendment (2026-11-14): the transcript of a session the user has left is released

*Partial reversal of the third Considered Option above, in the direction of more
eviction, not less. Issue #155. Code: `releaseUnseenTranscripts` in
`src/store/sessions.ts`, called from `openSession` and `selectSpace`; tests:
`describe("transcript eviction on navigation (ADR 0073 amendment, issue #155)")`
in `src/store/sessions.test.ts`.*

**What changed.** A stored Session's **History window** — the `messages[id]` array
and its `history[id]` cursor together — is now **released when a navigation leaves
the session behind**. Before this, a main session's transcript was released by
nothing at all: `discardSessionMessages` is gated on a `SubagentEntry` and returns
immediately for a main id, and `handleSessionClosed` clears only
`inTurn`/`stalled`/`compacting`. Measured against the real database, the newest-500
windows of the worst 12 opened sessions retained **39.2 MB** of `payload_json`, and
all sessions' windows totalled **1,109 MB** (×2–3 as JS objects) — unbounded across
the life of a window, which is exactly the shape of the leak this ADR's window was
supposed to bound. ADR 0073 bounded the *window per session*; it never bounded the
*number of windows*.

**The rejection above is re-litigated, not ignored.** It gave two reasons, and both
are answered by scoping eviction to **non-live, non-active** sessions:

- *"a streaming tail cannot be evicted"* — correct, and still true. A streaming tail
  is by definition a **live** session, and a live session is never released here.
  The guard is `state.sessions` (plus a belt for `inTurn`), not a scroll position;
  what is released is the transcript of a session whose Worker is gone and whose
  rows are on disk. The rejected option was a *scroll-driven* window, and a scroll
  cannot tell a tail from a corpse. A navigation can.
- *"the ADR 0050 resume merge would need rework"* — it does not, because
  `resumeSession` reloads **unconditionally** (`loadHistory` at the tail, then the
  ADR 0050 identity pass over whatever arrived during the await). A released
  transcript is not an input to that merge; `resumeSession` never reads a window it
  expects to be complete. The merge that *does* matter is `openSession`'s reload of
  an evicted id, and it now keeps any message that landed on the evicted id during
  the navigation rather than writing the page over it.
- *"the DOM is bounded by virtualization either way"* — also still true, and it was
  never the whole cost. Virtualization bounds the DOM; it does not bound the store,
  and the leak measured above lives entirely in the store.

**This loss is not new to the ADR.** Its own Consequences already accept a
comparable one: *"Virtualization drops row-local state for rows scrolled far away
… Accepted."* Releasing a transcript of a session the user is not looking at, and
reloading it from the database when they come back, is the coarser version of the
same trade — and it is cheaper, because the reload is one paged query and the
transcript was already destined to be re-parsed from disk on the next launch.

**The scope, exactly.** `openSession` and `selectSpace` release; nothing else does.
`selectSpace` owns its own call rather than relying on `openSession` because of its
`id === null` arm: a Space with no Session of its own never reaches `openSession`,
and the chat's empty state is precisely the surface with **no** transcript on
screen. Explicitly **not** owners:

- `handleSessionClosed` — its write-set contract ("clears ONLY
  inTurn/stalled/compacting") is pinned by its own test, and a close deliberately
  leaves the closed session **displayed** (a pause, not a discard). A close is not a
  navigation.
- `setActiveSession` — a bare `set({ activeSessionId })` with no navigation
  semantics: it resolves no Space, loads nothing, and is called directly and
  repeatedly by component tests into files that only sometimes mock `loadHistory`.
  Hanging eviction on it would fire real history fetches from tests that never
  asked for one.

**What is never released**, and why each arm is load-bearing (each is pinned):
the session being landed on; every **live** session (`state.sessions`) — the
streaming tail, and the Worker that can receive a frame at any moment; every id with
`inTurn` set — which is also what protects a **gate**: a session parked on an
`AskUserQuestion` has `inTurn` set because a gate is held inside a tool execution,
so `AskQuestionCard`'s full-scan anchoring keeps the tool call it anchors to; and
every id a `SubagentEntry` names, **as child or as parent** — a child is never in
`sessions`, and `SubagentTranscript` reads the parent's transcript for its progress
fallback, so liveness alone would strand both. A dismissed entry releases the pin,
so this cannot become a permanent hold.

**Two traps this closes, both silent.** (1) `messages[id]` and `history[id]` go
**together**. Release the transcript and keep the cursor and a later
`loadOlderHistory` prepends older rows into an empty array — a transcript whose head
and tail are two disjoint pieces of a conversation with everything between them
missing; releasing both makes the guard at the top of `loadOlderHistory` refuse, and
`openSession` re-arms a fresh **tail** window on the way back in. (2) `messages[id]`
is **re-created** by two paths that survive a release — `handleSessionClosed` writes
`finalizeSessionMessages(state.messages[id] ?? [])`, i.e. `[]`, and `addUserMessage`
spreads `state.messages[id] ?? []` — and `[]` is truthy, so `openSession`'s old
absence guard (`if (state.messages[id]) return`) short-circuits on it forever:
navigate away, let a late `session-closed` land, come back, and the transcript is
**blank permanently**. The guard is therefore a **loaded** test on two signals —
`history[id]` present *and* rows under it — because `history[id]` is the field the
release owns and so the one that cannot lie. (Held outside `SESSION_KEYED_FIELDS`
deliberately: that list is a frozen 11-tuple with an enumeration pin, and the
signal needed no new field.)

**`titleFor`'s first-user-message fallback: the decision, extended and then
narrowed.** This ADR accepted that the fallback "sees only the window", on the
ground that a session long enough to be windowed already has a generated title
(ADR 0037). Release breaks that on different grounds: the fallback no longer sees
*less* of the transcript, it sees **nothing** of it, and it sees nothing for every
session the window is not currently showing — not just long ones. **Eight label sites**
label rows for sessions they are not showing: `SpacesList`'s live row, its archived row
and its delete-confirm; `SpaceTabs`' close-anyway list; Settings → Detached's rows and its
delete-confirm; the Task detail dialog's session rows; and `SidePane`'s header.
**The count is of label SITES, not of components, and that distinction is why the
number looks wrong at first glance.**
`grep -rn 'titleFor(' src --include=*.tsx | grep -v '\.test\.'` finds **7** call sites in
**4** components (`SessionsSection`, `SpaceTabs`, `SpacesList`, `TaskDetailDialog`):
`SpacesList` alone carries three, and `SidePane` carries none because it builds its chain
inline — so **7 call sites + `SidePane`'s inline chain = the eight counted here**. Two
things NOT counted separately, so a reader reconciling the numbers does not add them
twice: `CloseSpaceDialog` contains **no** `titleFor` call at all (it is handed a
pre-resolved `label` by `SpaceTabs`, so its rows ARE that component's site), and
`ClearDetachedSessionsDialog` labels folders, never a Session.
So the unhandled version of this
degrades **every untitled Session** in the app to a folder name at once. That is not
the loss this ADR accepted, so it is not accepted here.

A twelfth session-keyed map is forbidden by the enumeration pin, so the label goes
where `costUsd` and `contextUsage` already go: at release, the store writes the
first-prompt label (via `firstPromptLabelOf`, one owner for the 80-char rule, so the
carried value cannot disagree with the arm it stands in for) onto the `SessionInfo`
of every **stored** list holding the id, and `lib/sessionLookup`'s walk — which
those surfaces already use for `title` — finds it there, with no new subscription
and no new field. A **generated** title always wins: the write is skipped when the
row already carries one, and `titleSession` and `mergeRefreshedSessionRows` overwrite
the carried value exactly as they overwrite a real one, so a carried label never
outlives the title it stands in for. `titleFor`'s own chain and its output are
unchanged; what changed is that its second arm now has a stored answer instead of a
transcript scan. **A future reader of `SessionInfo.title` must therefore know it can
hold a first prompt as well as a generated name** — which is already true of every
label in this app, since `titleFor` has always preferred a title over a prompt and
rendered the two identically.

`SubagentDelegatingCard`'s token estimate falls through to its own sources when a
child's transcript is absent, which is its pre-existing behaviour for a session
never opened this boot. `SubagentTranscript`'s parent scan is protected by the
`SubagentEntry` arm above.

**Recency is salvaged, not lost.** `lib/sessionRecency` reads the transcript's last
message first and the boot map as fallback, and a Session **started this boot** has
no boot entry at all — so releasing its transcript would strip its row's timestamp
the moment the user navigated away. The last message's `at` is therefore folded into
`sessionRecency` on the way out, newer-wins and never older (an older window must
not drag a row's recency backwards). The map remains a snapshot of "every
non-subagent session as of now"; it just learns about the sessions this window has
watched.

**Re-open is a reload, and that is the whole design.** `openSession`'s guard falls
through to `loadHistory(limit: 500)` for a released id, so re-opening costs one
paged query — the same query boot already pays — and the scroll-back cursor is
rebuilt from the tail rather than resumed, which is correct because the rows the
user had scrolled to are no longer in the array. A live session short-circuits
before any of this: its transcript is its frames, and fetching a page over a live
tail would drop the partial message no row holds yet.

**Consequences of this amendment**

- **`messages[id] === undefined` no longer means "never loaded".** It means "not
  loaded *now*". Any reader that must be correct across a navigation reads the row
  or the boot map, never the transcript — which is the invariant this ADR has always
  stated; the amendment makes it load-bearing instead of theoretical.
- **Two behaviour pins were re-aimed, neither deleted.** `discardSessionMessages`'
  "is a no-op for a main session id" still passes unchanged and now reads as a
  division of labour (children here, main sessions at the navigation sweep) rather
  than a retention guarantee. `closeSpace`'s landing assertion expected a
  `loadHistory` over a **live** landing session, a store shape the app cannot produce
  (`addSession` seeds `messages[id] = []`, so the old absence guard already
  returned); it now asserts the pointer and the Space move, and the fetched-landing
  arm stays pinned by the archived-neighbour case beside it.
- **A genuinely empty stored session re-fetches on each navigation to it** — one
  page, and the honest answer: its rows are in the database and the store holds none
  of them.
- **`resetStores()` is mandatory for any new test in this area**, which the eviction
  tests all call: `messages` retention is now a residue assertion, and this file's
  neighbouring blocks hand-write partial `setState` lists without resetting.

**Consequences**

- **Resume resets the window to the tail.** `resumeSession` reloads the latest 500 rows and merges them with the ADR 0050 identity pass; rows the user had scrolled back to are dropped (a resume comes from a send or the banner, both of which land at the bottom).
- **`titleFor`'s first-user-message fallback sees only the window.** Accepted: a session long enough to be windowed already has a generated title (ADR 0037). **Superseded in part by the amendment above** — after 2026-11-14 the fallback sees no window at all for a session the user has left, and the decision recorded there is to carry the label onto the row rather than accept the folder-name fallback.
- **The Worker is unaffected.** Its transcript and the Supervisor's rehydration read `native_messages` (`seq`), not the display rows.
- **A one-time migration backfills `todos_json`** from each non-subagent session's newest `manage_todo_list` write row, so stored sessions keep their boards.
- **Auto-scroll is now follow-only-at-bottom.** The old "scroll to the bottom on every store update" cannot coexist with infinite scroll up.
- **This amends one remark of ADR 0041.** That ADR notes that a main session's `rawInput` seed "comes back on purpose" when `applyTodoClear` drops the board's key. The seed — `useMainTodoItems` scanning `messages[]` for the newest `manage_todo_list` write — is deleted, so a clear now leaves the board empty until the next `todos_update`. (`src-tauri/` has never emitted `todos_clear`, so no shipped path changes.) ADR 0041's decision itself — boards are keyed by session id, never by `source` — is untouched.
- **Known, not fixed here:** a resumed session's Worker starts with an EMPTY in-memory `TodoStore`, so a model `add` / `remove` after a resume operates on an empty list. Persisting the board makes seeding that store possible; it is a separate change.
- **Virtualization drops row-local state for rows scrolled far away.** Rows outside the viewport (plus a 600px overscan) are unmounted, so row-local `useState` — a `Reasoning` block's expanded flag and its "Thought for N seconds" timer — is lost when the user scrolls well away and back. Stable identity keys only protect rows that STAY mounted across a prepend. Accepted; lifting that state into the store is a separate change.
- **A send always lands at the bottom, and a streaming reply is followed only while the user is at the bottom.** Virtuoso's `followOutput` reacts to a changed item count and not to a message growing in place, so `MessageList` re-asserts the follow on every tail change; a send scrolls unconditionally.
