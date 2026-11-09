---
status: accepted
date: 2026-10-13
superseded-by: 0094-the-sidebars-are-permanent-no-collapse-affordance.md
---

# The Side pane opens itself, and never closes itself

The **Side pane**'s auto behavior was symmetric: `SidePane` watched the open-todo count and
wrote `setSidePaneCollapsed(!visible)` on ANY edge, so a **Todo board** completing
(`visible` 1 → 0) — or the count merely dipping between two `manage_todo_list` writes —
collapsed the frame out from under the user mid-run. Now that a **Subagent session**'s
board counts toward `visible` too (ADR 0041 makes it visible at all), that dip is routine:
a child finishing while its siblings work would close the pane on the exact work still in
flight. We decided the frame may open itself and never close itself — the edge trigger
keeps its `!was && visible` arm and its collapse arm is deleted, so the user's own toggle
is the ONLY thing that collapses the pane.

**Consequences.** A run that finishes leaves the frame open and empty (the Todos section
is data-gated and simply disappears, the session title remains) — the accepted price of
"the surface never disappears on its own". The `prevVisible` ref survives solely to stop a
re-expand on a count change without the 0 → 1 edge, which is what keeps a MANUAL collapse
while work is in flight from being undone. Anything that later wants a "tidy up when the
run ends" rule must be driven by the turn settling, not by the todo count.

## Amendment (2026-10-13) — the edge is judged inside the active Session

**This narrows one sentence of Consequences; the decision stands.** "The `prevVisible` ref
survives solely to stop a re-expand on a count change without the 0 → 1 edge" was true
while the count was the pane's own with one Session in view; the ref is now ALSO the
per-Session baseline, so this amendment supersedes that sentence's scope. What does not
move: the effect still only ever opens, still never collapses itself, and a MANUAL collapse
while work is in flight is still what the ref protects.

What the effect judges is now explicit — the 0 → >0 edge of the **ACTIVE** Session's board
(`useBoardOpenCount(activeSessionId)`: the parent's open items PLUS every running child's,
the derivation the Todos section gates itself on, `src/components/SidePane.tsx`). A
**Session switch** is not an edge: `prevSessionIdRef` re-baselines `prevVisibleRef` to the
new session's `visible` and returns WITHOUT writing the flag, because `visible` is
per-Session while the collapsed flag is app-global (it is the value `localStorage`
persists) — so landing on a session that already has an open board moves `visible`
`false → true` on its own, and `!was && visible` would pop the frame over a board that
appeared where the user was not looking. Neither may a switch create an edge with itself:
`openSession` flips `activeSessionId` synchronously and leaves `loadHistory` to land the
transcript later (`src/store/sessions.ts`), and a stored session's parent board is nothing
but the `rawInput` seed off that transcript — so at the instant of the switch the new board
is not knowable and one tick later it is. The re-baseline therefore holds until that
session's messages exist (`hydrated`, plus `prevHydratedRef`, since the transcript and the
board it seeds land in the SAME render pass — ONE `messages` write from `loadHistory`, and
the seed is a derivation over it (`useMainTodoItems`), not a second write), or the frame
pops a tick after the switch on a board that was already in the transcript.

**Accepted residual:** a board that appears while the active transcript is still absent has
its one open suppressed — the gap swallows the arrival; the first board written after the
transcript lands is a genuine edge again. Both arms, and the re-baseline itself, are pinned
in `src/components/SidePane.test.tsx` (`does NOT auto-expand when the session it SWITCHED
TO hydrates a board that was already in its transcript`, `stops suppressing the moment the
session it SWITCHED TO is hydrated`). That residual has one PERMANENT form: a history load
that FAILS leaves `messages[sessionId]` absent for good (`openSession`'s catch only logs —
`src/store/sessions.ts`), so the session reads as un-hydrated forever and every edge for it
stays suppressed until the user opens the pane by hand; accepted as-is here. The store was
deliberately NOT touched on this branch. The obvious fix — write an EMPTY transcript in the
catch so an unreadable session reads as hydrated, the shape a live session's `[]` already has
(`addSession`) — is a decision NOT yet taken, and it is not free: an empty transcript is also
what a "nothing to load" Session looks like, so it erases the difference between an EMPTY and
an UNREADABLE one (a retry affordance would have nothing to key on; a `historyFailed` flag
beside `messages` keeps the distinction, at the cost of a second term in this gate), and the
catch does not re-check `activeSessionId` the way the success path does, so a write there
would stamp a Session the user already left. Whoever takes it owes a `src/store/sessions.ts`
case (a rejected `loadHistory` still leaves `messages[sessionId]` defined) and a
`src/components/SidePane.test.tsx` case (a board arriving after a FAILED load opens the frame).

## Amendment (2026-11-09) — SUPERSEDED by ADR 0094: the pane can no longer collapse at all, so there is no edge to judge

**This supersedes the whole decision.** ADR 0094 made both flanking panes permanent: the
collapsed flag, the module that owned it and its persistence, and every control that wrote it
are deleted. There is no boolean left for an edge to write, so this decision is not overruled
on its merits — its reasoning (never yank the surface that just showed the work out from under
the user) is the reason that change went the way it did — it is superseded because its subject
is gone. The text above stays as the record of what was decided and why.

**What died structurally**, in `src/components/SidePane.tsx` and its module:

- the **auto-open effect** — the `useEffect` that read the ACTIVE Session's open-board count
  and wrote the collapsed flag on the 0 → >0 edge;
- **the three refs** this decision and its 2026-10-13 amendment required — `prevVisibleRef`
  (the edge baseline), `prevSessionIdRef` (the per-Session re-baseline) and `prevHydratedRef`
  (the hold-until-the-transcript-lands arm);
- the flag's writer and its `localStorage` key, and with them the **concept of a manual
  collapse** — the thing this entire design kept working around. "The user's own toggle is the
  ONLY thing that collapses the pane" is now vacuously true: there is no toggle, and no pane
  state to collapse.

The pane's *data* gates survive untouched. The **Checklist** section still renders only while a
board has an open item and still vanishes when the work finishes, with the session title
remaining — the frame just no longer has a second, user-owned axis on which to disappear. The
open-item rule this amendment named is still what the section gates itself on inside
`ChecklistPanel`; what is gone is any reader of that rule that opened or closed a frame.

**The accepted residual of the 2026-10-13 amendment is CANCELLED, not inherited.** That
amendment accepted that a FAILED `loadHistory` leaves `messages[sessionId]` absent for good, so
the session reads as un-hydrated forever and every auto-open edge for it stays suppressed until
the user opens the pane by hand — and it left its taker two cases to write: a
`src/store/sessions.ts` case (a rejected `loadHistory` still leaves `messages[sessionId]`
defined) and a `src/components/SidePane.test.tsx` case (a board arriving after a FAILED load
opens the frame). **Neither is owed any more, and the debt is discharged rather than
transferred.** The residual's only symptom was a frame that would not open; there is no frame
to open, and the second named case has no subject at all. The empty-vs-unreadable transcript
distinction that amendment weighed is still a genuine question for any consumer that wants to
offer a *retry*, and ADR 0094 takes no position on it — cancelling this residual is not a
ruling on that.

A reader who wants the pane to hide again is not looking for a bug to fix here. They owe a
collapsed flag, a persistence key, a control, and a ruling on auto-collapse — i.e. they owe
superseding ADR 0094, whose own text explains why auto-collapse is the failure this file was
written to end.
