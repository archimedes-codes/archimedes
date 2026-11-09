---
status: accepted
date: 2026-11-09
superseded-by:
---

# Both flanking panes are permanent — there is no collapse affordance for either, and ADR 0042's auto-open is made structurally impossible rather than merely un-wanted

Both flanking panes used to be hideable, by two generations of controls. The first generation lived inside the panes (the sidebar's footer gear, each pane's bottom-corner toggle); the second moved those toggles to the chrome bar so one button per pane could collapse AND expand in both states. We decided to remove the ability entirely: the **Session list** (the left pane) and the **Side pane** (the right) are always mounted at their own widths, there is no collapse flag, no persisted collapse state, and no control anywhere that hides either. The chrome bar's app-control cluster is now the Settings gear alone.

This is hard to reverse in the way an ADR is supposed to be: it deletes the *state* the feature would need, not just its button. A future reader's first question is "why is there no collapse?", and the answer is recorded here rather than reconstructed from a missing component.

**Why the trade-off is real and which side it falls on.** A collapse affordance buys horizontal room, and this app needs that room — the window defaults to 800px (`src-tauri/tauri.conf.json` → `width: 800`). The Settings view now spends **528px of that 800px on navigation**: 260 (`LEFT_PANE_WIDTH`, `src/components/SpacesList.tsx`) plus 268 (`SettingsPage`'s own section `aside`) = 528, leaving 272px for the section content. That is the worst case this decision creates, and it is accepted for the surface it is on: a settings page read once per session, not the transcript you work in all day. **And nothing stops it going further** — there is no `min_inner_size` in `tauri.conf.json` and no `set_min_inner_size` anywhere in `src-tauri/src/` (both re-verified at this commit, not inherited from the plan), so a user can shrink the window until the two nav columns leave the content column a strip. **A minimum window size is deliberately NOT decided here.** It is a separate decision with frameless-window implications on Windows and Linux (this window ships `decorations: false`, so the app owns the frame and any minimum has to survive that), and bundling it in would have made an irreversible UI decision carry an unrelated platform risk. If the 272px case turns out to be intolerable in practice, the fix is that separate decision — not resurrecting the collapse.

**Considered Options**

- **Keep the toggles, keep the flags, fix the annoyances** (the status quo): rejected — the annoyances *were* the state. Every one of them was a consequence of the panes being hideable, and the list below is what deleting the flag deletes with it.
- **Collapse, but only the Side pane** (the transcript-adjacent one): rejected — half the machinery survives, so half the cost survives: the persisted flag, the two-store subscription module, the "render in both states" rule, and the whole auto-open question in ADR 0042 stay. A half-permanent pane is the worst of both.
- **Auto-hide on a rule instead of a button** (collapse when a board empties, when Settings opens, …): rejected — this is the decision ADR 0042 already lost, twice. Its own text records that a count-driven collapse "collapsed the frame out from under the user mid-run", and ADR 0042's fix was to stop the pane closing itself at all. Auto-hide re-opens the exact failure that ADR was written to end.
- **Keep the two readout components, re-pointed at something** (`SessionRail`, `ChecklistRail`): rejected — see the consequences. Both existed only to answer "what is behind the pane I just hid". With nothing behind anything they have no subject, and a readout with no subject is a component that must be justified by something other than its original job.

**The consequences that make deletion cheaper than repair.** Each of these existed *because* the panes could hide, and each fell with the flag rather than needing its own fix:

- The gear had to be *hidden* rather than clipped so it would not poke into a sliver.
- The collapsed sidebar rail needed a **tail action strip** so collapsing did not lock you out of Settings.
- The rails reserved `bottom-9` and the **session config block** reserved `pb-10`, purely to leave a control a gap.
- A collapsed pane's sliver had to be *exactly* wide enough to hold a 24px button.
- Both collapse flags needed a module of their own (no store, no React) to bridge writer and reader through `useSyncExternalStore`, plus a `localStorage` key each (`left-pane-collapse`, `side-pane-collapse`), a guarded `setItem`, and an import-time seed.
- The chrome-bar pending dot meant "something needs you BEHIND the hidden pane". Nothing is behind anything, so the dot went; `useHasPendingRequest` survives, because `ChatStream` and `NewTaskDialog` still read it.

## The two readouts were deleted, not repurposed

`SessionRail` (the collapsed Session list's marks) and `ChecklistRail` (the collapsed Side pane's per-list marks) were removed outright, with their tests. Both are pure projections of data the open panes already render — `useSessionStatuses` for the one, `useChecklists` for the other — so nothing was lost that the open surfaces do not already show, and neither hook needed a new consumer. `useSessionStatuses` in particular now has exactly one production caller: the **Space** tab strip (`SpaceTabs.tsx`), which is a genuine batch consumer and was always the second one. The hooks stay; the components that summarised a hidden surface do not.

That deletion is also what retires the word **rail** from this repo's vocabulary. It had two meanings — the collapsed sliver itself, and the readout drawn inside it — and `CONTEXT.md`'s **Checklist rail** entry documented the ambiguity as a hazard (`_Avoid_: "the rail" bare`). Both meanings die in the same change, so the term leaves cleanly rather than being narrowed.

## ADR 0042 is made structurally impossible, not merely superseded in spirit

ADR 0042 ruled that the Side pane may open itself but never close itself, and amended that the 0 → >0 edge must be judged on the ACTIVE Session's board with a per-Session re-baseline. That decision is not overruled on its merits — its reasoning (never yank the surface that just showed the work out from under the user) is the very reason this change went the way it did. It is **superseded because its subject no longer exists**: with no collapsed flag there is nothing for an edge to write.

What died is the machinery, not just the behavior:

- the auto-open `useEffect` in `SidePane.tsx` (the only effect of its kind left in that file — the drag-resize effect is untouched);
- the three refs that amendment required — `prevVisibleRef`, `prevSessionIdRef`, `prevHydratedRef`;
- `setSidePaneCollapsed` and the module that owned it;
- and with them the **concept of a manual collapse**, which was the thing the whole design kept working around.

The consequence is stronger than "the code no longer does that": the code **cannot** do that. There is no boolean to set, so a future change that wants auto-collapse must re-introduce state, a persistence key and a control, and must supersede this ADR to do it. That is the point of recording it here.

**The 2026-10-13 amendment's accepted residual is cancelled, not inherited.** That amendment accepted, knowingly, that a FAILED `loadHistory` leaves `messages[sessionId]` absent forever, so the session reads as un-hydrated and every auto-open edge for it stays suppressed until the user opens the pane by hand — and it told whoever took the problem next that they owed two tests (`src/store/sessions.ts`: a rejected `loadHistory` still leaves `messages[sessionId]` defined; `src/components/SidePane.test.tsx`: a board arriving after a failed load opens the frame). **Neither is owed.** The residual's symptom was a pane that would not open; there is no pane to open. The debt is discharged by its subject's disappearance, and ADR 0042's amendment carries that cancellation so the obligation does not read as live to the next reader. What the amendment does NOT cancel is unrelated: the empty-vs-unreadable transcript distinction it weighed is a real question for any *other* consumer that wants to offer a retry, and this ADR takes no position on it.

## Consequences

- **The `Side pane`'s data gates are now the only gates.** Sections still come and go with their data (the **Checklist** disappears when nothing is open, the session title stays); what is gone is the option of the *frame* being absent. "The surface never disappears on its own" — ADR 0042's accepted price — is now free, because the surface never disappears at all.
- **The Session list renders in all three views** (workspace, Settings, Task board), hoisted out of `App.tsx`'s content-row view ternary. That is what makes the 528px arithmetic above possible, and it is what makes the pane's own commands (`Skills` / `Agents` / `Tasks`, and the `+`) reachable while a page is in front of the center column — they are `fixed` Radix portals mounted inside the pane, so hoisting them out of the ternary is the point, not a leak.
- **Clicking a Session row while Settings is open switches the Session and leaves Settings open.** `SpacesList` gained no `view` awareness. That is a decision (spec D8) and not an oversight: the pane is a peer of the content column, not something the content column can hide.
- **`ADR 0093`'s deliberately-stale `docs/features/subagent-sessions.md` is repaired by this change**, not by a sweep — the three bullets naming `TodoRail` and the auto-open rule are exactly the "next visit to that file" repair 0093 deferred, and this change is that visit.
- **`CONTEXT.md` gains a term for the left pane** (**Session list**). Its absence is how the drift happened: with no entry, "sidebar", "left bar" and "the Space/Session list" all shipped. Under ADR 0086's rule the `_Avoid_` lists are binding, so the new entry is the conformance instrument, not documentation.
- **A third generation of collapse control will look obvious, and should read this first.** The pressure to add it returns the moment someone wants more room for the transcript, and the obvious move is "just a button". That button needs the flag, the persistence module, the both-states render rule, the reserved-gap classes, and a ruling on auto-collapse — i.e. this whole file re-opened.

> **Amended 2026-11-09 (D8 is reversed by ADR 0095).** The bullet above that reads "Clicking a
> Session row while Settings is open switches the Session and leaves Settings open" is **no longer
> true**: a row click now switches the Session AND returns to the workspace. The original text
> stands because this file is the record of what was decided when, and because its reasoning was
> sound at the time — it is worth stating why it stopped applying rather than quietly replacing it.
>
> D8 rested on the pane being **a peer of the content column**: two things that coexist, neither
> able to hide the other, so showing a Session row and showing a Settings page were independent
> facts and a row click had no business touching the second. ADR 0095 changed the pane's role
> without changing its permanence — the command strip became the app's **view switcher** (the
> Settings door moved into it from the chrome bar, and both `Back` buttons were deleted), so the
> strip now *states* which view is up via `aria-pressed`. Once a surface states the current view,
> clicking something inside it is an assertion about the view, and a row click reading "show me
> this Session" while the pressed door still says **Settings** is a contradiction on the same
> screen. So the row click means "show me this Session" **including its view** — the workspace —
> and the door that opens Settings is also the door that closes it.
>
> What survives of D8 intact is its premise, which is why this reads as an amendment and not a
> refutation: the pane is still a peer the content column cannot hide, it is still mounted in all
> three views, and its commands are still reachable while a page is in front of the center column.
> The change is that peerhood turned out to imply switcherhood, and a switcher cannot be neutral
> about where you are. `App.test.tsx`'s D8 case was **inverted rather than deleted**, so the new
> behaviour carries the coverage the old one had.

## Citing the code

The implementation is five serial tasks on `feature/kanban-task-board`. At authoring time the four code commits are `a2046f81` (retire the pane collapse toggles), `7370b29d` (render the Session list in all three views), `c69f08f8` (delete `leftPaneState` / `SessionRail`) and `7ef766d7` (delete `sidePaneState` / `ChecklistRail` / ADR 0042's auto-open).

**Those four hashes are NOT the durable citation, and they are named here under protest.** The repo squash-merges, so each becomes unreachable the moment the branch is deleted (`AGENTS.md`'s squash-orphan bullet measures 17 such hashes already stranded in `docs/`). No PR number is citable either: at authoring time the branch is unmerged and `gh` is unauthenticated in this environment, so the number cannot be read rather than merely inconvenient. **The durable handle is the squash commit (or the PR number) that lands this branch**, and the reader who has it should prefer it. Where a hash would otherwise be load-bearing evidence, the text is quoted verbatim above instead — the deleted components' names, the two `localStorage` keys, the reserved `bottom-9` / `pb-10` classes and the 528px arithmetic all stand on their own without a reachable object, which is what `AGENTS.md` prescribes for exactly this case.
