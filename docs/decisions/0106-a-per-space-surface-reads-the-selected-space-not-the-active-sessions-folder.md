---
status: accepted
date: 2026-11-12
superseded-by:
---

# A per-Space surface reads the **Selected Space**, not the active **Session**'s folder

The **Task board** rendered an empty state for a Space that had a tab, a name in the tab strip, and
a **Session** list full of rows — because the value it keyed on was not that Space. It was the
active **Session**'s `cwd`, and with every Session archived (or the last one deleted) there is no
active Session, so that value was `null` and the board took its "no Space is open" arm: no
`get_board`, no columns, `New task` and `Configure` dead. The store was holding the right folder the
whole time, in a different field, under the same name.

## Context

Two things in the Client answer the question "which Space is active?", and they are not the same
thing.

- **`useSessions((s) => s.activeSpacePath)`** — the store's own field, documented there as "the
  selected Space's path — the top tabs' state (a Space is a tab, like a browser tab)". It is a
  **selection** with a lifecycle of its own: the **Session list** lists this Space's Sessions, `⌘N`
  starts a Session in it, the tab strip marks it selected, and `addSpace` / `selectSpace` set it
  without consulting any Session. It is `null` only when no Space is open at all.
- **`useActiveSpaceCwd()`** (`src/hooks/useActiveSpaceCwd.ts`) — the active **Session**'s `cwd`,
  resolved through the three-list walk in `src/lib/sessionLookup.ts` (live → stored → archived). It
  is a **projection** of what is on screen: no active Session, no value. `null` is a normal answer,
  and its own test pins it as one.

They agree whenever a Session is active, because a Session's `cwd` IS its Space's folder. They
diverge whenever none is — and **only the first is defined in that state**. That is the whole
difference, and it is a difference of noun, not of freshness.

The bug is a naming collision, and the collision is documented in the report
(`docs/research/task-board-empty-with-no-active-session.md`, issue #185): `TasksBoard`'s prop was
*named* `activeSpacePath` and was fed the **second** derivation. One identifier named both
derivations in two files, so the call site read as correct. `src/App.tsx` handed down
`useActiveSpaceCwd()` under that prop name and `TasksBoard` passed every test written against it —
the report's own finding is that every pin in the family handed the prop in by hand, so none of them
rendered the real tree with a Space selected and no Session. The board acquired the projection
through a call site, not through its contract, and the hook's own header (which enumerated its two
consumers) never learned it had a third.

What made this survivable in review is that the claim it falsifies was never written down. The rule
the board needed — **a Space can be selected with zero Sessions, and a per-Space surface must still
answer** — appears nowhere in `docs/decisions/`, `docs/features/` or `CONTEXT.md`. Its *opposite*
does appear, three times, in code comments: "a space is born at the same time as a session (the
`record_session → upsert_space` hook)" in the `SpaceView` docblock in `src/store/sessions.ts`, "no
empty spaces: a space is born when a conversation starts in it" in `src/components/NewSpaceDialog.tsx`,
and the matching note on `record_session` in `src-tauri/src/agent/session/mod.rs`. All three are
**forward** — start a Session and a Space row exists — and none implies the converse. `CONTEXT.md`'s
**Task board** entry already said the board "is PER-**SPACE**, one board per Space", and ADR 0090
already keys `stages` and `tasks` on a `space_path` **string with no foreign key to `spaces`**, so a
Space row with zero Session rows is a case the schema does not exclude. The storage layer was ready
for a session-less Space; only the renderer's key refused it.

## Decision

**A surface whose data is keyed on a Space reads the Selected Space. A surface whose data is keyed
on a Session may read the active Session's `cwd`.**

Which key a surface has is answered by what its reads and writes are addressed to, not by what is
currently on screen:

- **Keyed on a Space** → `useSessions((s) => s.activeSpacePath)`. The **Task board**, the **Stage**
  editor, the New Task modal, the per-Space catalog scopes. These are addressed to a folder that has
  a tab; the tab is the selection, and the selection outlives every Session in the folder.
- **Keyed on a Session** → the active Session's `cwd` (`useActiveSpaceCwd()`, or `sessionFieldOf`
  over `activeSessionId`). `ChatStream`'s picker catalogs and `App`'s `SpaceCwdProvider` stay here,
  deliberately — see Consequences.

The two derivations are **different nouns**, and the glossary now says so. `CONTEXT.md` gains
**Selected Space** as the canonical name for the first, with **Active Space** on its _Avoid_ list —
that phrase is what the code comments used for *both*, which is how one word came to license the
substitution. `TasksBoard` takes no Space prop at all now: it reads the store field itself, so the
substitution cannot be reintroduced at a call site by someone who wires "the obvious" value.

## Considered options

- **Keep the prop and re-point `App` at `useSessions((s) => s.activeSpacePath)`.** Rejected, and the
  reason is this ADR's actual finding: it leaves **one identifier naming two derivations**, which is
  exactly what shipped the bug. The call site would be right today and the name would still promise a
  per-Session projection to the next reader, and the same trap already has a precedent two files
  away (`SpacesList`'s own comment forbids reusing `activeView` for a neighbouring derivation). A fix
  that preserves the ambiguity fixes the value and not the cause.
- **Make `useActiveSpaceCwd()` fall back to `activeSpacePath` when no Session is active.** Rejected:
  it makes a projection total, and every consumer of it would silently change meaning — the provider
  would start resolving a session-less Space's relative paths against a folder no transcript is
  being read from. If that is wanted it is a decision about **External open**, argued there.
- **Treat the state as unsupported and show a "start a Session" empty state on the board.** Rejected:
  it contradicts `CONTEXT.md`'s PER-SPACE statement and ADR 0090's keying, and it asks the user to
  create a **Session** — a conversation, with a model and a cost — in order to look at a list of
  work items.

## Consequences

- **`SpaceCwdProvider` and `ChatStream`'s picker catalogs keep the session-derived value, on
  purpose.** A relative path in a transcript is a path *in the folder that transcript was written
  in*, so **External open** resolves against the Session's `cwd` and the `$`/`#`/`@`/`?` catalogs are
  cached under it. Re-keying either on the Selected Space would resolve a Session's relative paths
  against a different folder than the one that produced them — a wrong path that still opens
  something, which is worse than a refusal. The cost is stated where the provider is mounted in
  `src/App.tsx`: with no active Session `useSpaceCwd()` is `null`, `external_open` refuses a relative
  path, and that is "the safe direction, but a dead surface". **A session-less Space therefore still
  cannot External-open a relative path.** Accepted, and recorded in
  `docs/features/task-board-known-gaps.md` rather than left to the comment.
- **`SidePane` still renders nothing for the same state** — its title element is not rendered at all,
  and `SessionCostLine` and `ChecklistPanel` each take `activeSessionId` and go empty. Out of scope
  here: it is keyed on a **Session** and *should* be, and while the board is up the board's arm of
  `App`'s view ternary replaces the chat column **and** the Side pane, so nothing that is broken in
  the reported state is on screen in the state the user complained about.
- **Opening the board for a Space with zero Sessions is now a write.** `get_board` **seeds stages on
  read** (ADR 0090's lazy seeding — the first read of a Space with no `stages` rows inserts the
  defaults), so a read path now writes where it used to refuse. That is the *intended consequence* of
  the lazy-seeding decision, not a leak introduced here: ADR 0090 chose "a Space that never opens the
  board pays nothing", and the only way to honour that is for the first read to create. It is
  recorded because it is surprising, and because ADR 0090's own §5 in
  `docs/features/task-board-known-gaps.md` already documents that `create_task` seeds too — this
  widens *who reaches* the seed, not what the seed does.
- **The catalog scope becomes correct rather than merely wider.** With the Selected Space as the key,
  the launch-pill gate and `store/taskLaunch`'s refusal can no longer say "This Space has no `x`
  skill to load" about a Space the user has selected while reading the **user-level** catalog under
  the `__global__` cache key. That was the report's second symptom and it is a correctness fix, not a
  cosmetic one; it also stops the eviction thrash the same null caused on every session ↔
  session-less flip.
- **`useActiveSpaceCwd()`'s consumer list is true again** — `ChatStream` and `App`'s provider — and
  its header now names the near-miss, because a contract that silently gains a third consumer is how
  this was shipped once. Its "ONE place that derivation lives" claim still holds; what the ADR adds
  is the rule about who is *allowed* to consume it.
- **The store-level divergence is deliberate and stays.** `selectSpace` sets `activeSpacePath`
  unconditionally in one `set` while `activeSessionId` may land `null` — that asymmetry is the
  divergence, and `src/store/sessions.test.ts`'s
  `"selectSpace: live session preferred, then the most RECENT stored, then nothing"` pins it as
  intended behaviour, its last beat asserting both halves under the comment "An empty space: no
  session (the chat's empty state)".
  **Corrected 2026-11-13 — the `null` got narrower, the divergence did not go away.** This bullet
  used to state that the action set `activeSessionId: null` outright, and that stopped being true on
  this branch: `selectSpace` now resolves `const id = live ?? stored ?? archived` and passes that `id`
  to the same `set`, so `activeSessionId` is `null` there only for a Space with **no rows in any of
  the three lists** — the "then nothing" of ADR 0075's amendment of the same date and of the
  **Landing Session** glossary entry, and pinned as such by
  `"selectSpace on an archived-only Space lands on its most recent archived Session"`. An
  archived-only Space therefore has a Session to land on and is not the empty case this bullet
  described. What is unchanged is the bullet's actual point: `activeSpacePath` is set whatever the
  Space holds, `activeSessionId` is not, and this decision does **not** reconcile the two fields — it
  says which one a per-Space surface reads. A future change that "makes them agree" would be
  re-opening this ADR.
- **The sibling symptoms the report enumerated are not all closed here.** `SidePane` (above) and the
  relative-path refusal (above) are the two that remain, both recorded rather than folded in. The
  report's other listed symptom — a **Space** tab strip in which nothing reads as selected, and a boot
  with no Session to show — is a **Landing Session** question and not a key question: the strip marks
  its tab from `activeSpacePath`, which was already correct in the reported state. It is answered by
  ADR 0075's amendment of the same date, which gives an archived-only Space a Session to land on.
