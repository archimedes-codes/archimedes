---
status: accepted
date: 2026-11-09
superseded-by:
---

# The `bg-frame` plane is chrome — the titlebar and the Session list, and nothing else; every view surface is an island

The app has two planes, and the boundary between them was undefined until the Task board and
Settings were found sitting on the frame colour and reading as background rather than surface
(issue #173). We decided: `bg-frame` means **chrome**, and chrome is exactly two surfaces — the
titlebar and the Session list, which form one continuous recessed band down the left of the window.
**Everything that happens is an island floating above it** (`m-1 rounded-xl` on the content plane),
so the workspace row is Session list · chat island · side pane island, Settings is
Session list · **Menu panel** island · content island, and the Task board is Session list · board
island.

The rejected alternative was to make the Session list an island too, which is the option that
presents itself first: once its right-hand neighbour floats, a flat pane beside it looks like an
oversight. It was rejected because the Session list is not a view — it is the thing that is *always*
there while views change, and it shares its plane with the titlebar for the reason
`paletteCompleteness.test.ts` pins ("the titlebar must read the same token as the sidebar").
Floating it would dissolve that pairing and make the chrome band nothing.

## Consequences

- **A flat surface beside a floating one is now a deliberate signal, not an accident.** The Session
  list reads as recessed next to the chat, the side pane, the Menu panel and the board *on purpose*:
  recessed means chrome, floating means a place you can be. A future change that "fixes" the Session
  list to match its neighbour has reversed this decision and must also rewrite the chrome-bar
  pairing test, which asserts only the chrome bar's own class and would **stay green while the
  invariant it names became false** — that test scans `data-testid="chrome-bar"`, never
  `SpacesList`.
- **Fixed overlays are exempt, including one with a known elevation inversion.**
  `SubagentDetailHost`'s transcript sheet is `bg-background` (`#21222c`), which reads *darker* than
  the side pane it overlaps (`#282a36`) — 1.11 in Dracula, 1.09 in default dark — so only its
  `shadow-xl` claims it is on top. Accepted: an overlay is not a pane, and giving it `m-1` would
  detach it from the window edge it is meant to run flush against. This is recorded so the
  inversion reads as decided rather than missed.
- **Every flanking column is now expected to be an island.** Adding a third pane to the content row
  without `m-1 rounded-xl` is the same defect this decision was made to fix; use the shared
  `MenuPanel` shell rather than re-spelling the recipe.
