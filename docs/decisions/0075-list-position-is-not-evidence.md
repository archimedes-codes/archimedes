---
status: accepted
date: 2026-10-24
superseded-by:
---

# List position is not evidence

A list's position was a *derived* fact — Space tabs ranked by `last_opened_at`,
sidebar Sessions by their transcript's last stamp — and four places in
`src/store/sessions.ts` then read that position back as **evidence of recency**
(`autoSelectActive`, `selectSpace`, `spaceViewFor.newestId`, `removeSpace`'s
fallback, all summarised by the ordering note at `sessions.ts:98`: "input order
IS newest-first — do NOT re-sort"). Making the order user-owned breaks that
circle, so we decided the two facts apart: a `sort_order` column owns **display**
and changes only when the user drags a row, and an explicit `lastActiveAt`
(derived at read time from the existing
`COALESCE(MAX(messages.created_at), sessions.created_at)` expression) owns every
decision that needs recency. Position now means only position.

The obvious alternative — keep sorting, add a manual pin at the top — was
rejected because it preserves the movement the user is asking us to stop: a
pinned list still reshuffles underneath the pin, and the frontend still owns an
order that contradicts the server's.

## Considered Options

- **`localStorage`** (the `lib/leftPaneState.ts` pattern): no migration, but the
  order becomes renderer state shadowing DB rows, so the frontend must re-sort
  after every `setSpaces`/`setSessions` — inverting the "do NOT re-sort" rule
  rather than preserving it — and clearing webview storage silently loses every
  arrangement.
- **`settings.json`** (the `agentOverrides` precedent, ADR 0066): one write path
  already exists, but a per-Session entry in an app-global settings document
  grows unbounded with history and needs its own GC on delete.
- **SQLite** (chosen): both read queries change *only* their `ORDER BY`, so the
  standing "input order IS the order, do NOT re-sort" rule stays **true** instead
  of being inverted, and the frontend still never sorts.

## Consequences

- `Db::list_sessions` no longer returns most-recently-active-first. Anyone who
  wants that order must now ask for it explicitly — which is exactly the point,
  and exactly the trap: the **Archived** section rendered `archived.filter(…)` in
  input order and *inherited* recency for free. It now has to sort by
  `lastActiveAt` itself, or it silently presents a manual order under a recency
  heading while passing every pre-existing test.
- A new Session or Space joins at the **bottom** (`MAX + 1`), and nothing ever
  moves a row again — not a new message, not a close, not a boot.
- HTML5 drag-and-drop is pointer-only, so a keyboard user cannot reorder. Accepted
  and recorded in `docs/features/manual-list-order.md` rather than left implicit.
- `src/lib/sessionActivity.ts` is deleted: `sortByActivity`, `activityKeyOf` and
  `activityFromKey` existed only to feed that one sort, including the
  subscription key built so streaming would not re-sort the list on every token.
- The phase-11 space-backfill `INSERT` in `Db::open` carries the same
  bottom-join expression (`COALESCE((SELECT MAX(sort_order) …), -1) + 1`) as
  `Db::upsert_space`, because on the upgrade path where a database has stored
  sessions but no `spaces` rows the seed numbers nothing — there is nothing to
  number — so a plain `DEFAULT 0` would tie every backfilled row and hand the
  user an alphabetical list on the very boot the spec promises is unchanged.
- The seed queries in `seed_space_sort_order` / `seed_session_sort_order`
  hardcode the OLD display order (`last_opened_at DESC, path ASC` and
  last-activity `DESC, id DESC`) and must never be pointed at `sort_order`: at
  seed time every value in that column is still `DEFAULT 0`, so `ORDER BY
  sort_order` is a pure tie and would pick an order nobody ever saw.

## Amendment (2026-11-12) — the Landing Session gains a fourth arm (most recent ARCHIVED), and the all-archived Space had no stated answer before it

**AMENDED 2026-11-12 — the reach of the recency rule, not the rule itself.** What stands unchanged:
position is never evidence, `sort_order` owns display and changes only on a drag, `lastActiveAt`
(derived at read time) owns every decision that needs recency, and both read queries still order by
`sort_order` so "input order IS the order, do NOT re-sort" stays true. This ADR is NOT superseded and
its `status` is unchanged.

**What changed.** The **Landing Session** — the Session boot and a tab click land on — now runs
**live → most recent stored → most recent archived → nothing**. Both of its sites (`autoSelectActive`,
called from `setSpaces`, and `selectSpace`, the tab click) used to read `historySessions` alone, so an
install whose every Session had been archived booted with **no** active Session, and clicking its only
tab set `activeSpacePath` to a real path and `activeSessionId` to `null` in the same `set` (issue #185;
see ADR 0106 for what that triple did to the **Task board**).

**The archived arm is a LAST RESORT, not a max over stored ∪ archived.** It fires only when the Space
owns no live and no stored Session. This is not a new rule invented for the Landing pick — it is the
rule this file's own `spaceViewFor` pin already enforced for `lastReason`, where the fallback to the
most recent archived Session is documented as "a last resort (the close-reason banner must not
silently vanish for an archived-only Space)". Extending the existing rule to a second consumer is why
the change needed no schema, no new field, and no argument about which list outranks which: the
ordering was already decided once, in this file, for the neighbouring question. A max over the union
would have been the tempting implementation and it is the wrong one — it would let an archived row
displace a stored one, and an archived row is a Session the user deliberately put away, so the pick
would change what a Space opens every time its newest transcript was archived.

**Position is still never evidence, so the arm is chosen with `mostRecentByRecency`.** The archived
arm takes the same `recencyOf`-based function the stored arm takes, over the same evidence map. It is
not "the first archived row", and `archivedSessions`' input order is `sort_order` — the very order
this ADR stripped of meaning. A `rows[0]` shortcut here would pass a fixture with one archived Session
and be wrong in every real one.

**Why this needed writing down: the all-archived case had no answer anywhere.** Not in this ADR, not
in ADR 0016 (which decides what archiving *is*), and not in `CONTEXT.md`, whose **Landing Session**
entry named the three *moments* the pick runs — boot, a tab click, the selected tab closing — without
ever saying that a Space might contain only archived rows. So the behaviour was undefined rather than
decided, and two implementations of "the most recent Session" disagreed about whether archived counted
— a disagreement about which LIST is in scope, not this ADR's question of which ROW inside a list
counts — precisely the failure `src/lib/sessionLookup.ts` warns about in its own header.

**An archived-only Space is not an empty Space, and the store already knew that in two places.**
`SpaceView.archivedSessionIds` exists precisely "so a space whose only sessions are archived still
resolves its `view`", and `spaceViewFor`'s `lastReason` falls back to the most recent archived Session
so a banner does not silently vanish. The sidebar's **Archived** section lists those rows with a
non-zero count. The Landing pick was the odd one out: it treated a Space with three archived
transcripts as a Space with nothing in it. That asymmetry — the same store calling the same rows
first-class for the view, for the banner, and for the list, and absent for the thing the app opens —
is the reason it matters, and the reason the fix belongs in this ADR rather than as a local patch.

**What this does NOT do.** It does not reconcile **Selected Space** with **Active session**: those two
fields are *supposed* to be able to disagree, `src/store/sessions.test.ts` pins the disagreement as
intended behaviour, and ADR 0106 is the decision about which one a per-Space surface reads. It does
not un-archive anything, touch the sticky flag (ADR 0016), or change what the **Archived** section
lists. And it does not make position evidence: the arm is chosen by recency, exactly as every other
recency decision in this file.
