---
status: accepted
date: 2026-11-09
superseded-by:
---

# The surface ladder is designed against Dracula; a palette that collapses a step degrades rather than vetoing the design

The app ships four surface-bearing palettes (`.dark`, `.theme-zai-light`, `.theme-zai-dark`,
`.theme-dracula`) and they do **not** expose the same number of distinct steps: Dracula has four
(`#191a21` frame+panel · `#21222c` page+composer · `#282a36` slab+floats · `#343746`
card+secondary), while zai-dark and zai-light each declare eight groups but collapse the ones that
matter — zai-dark sets `--color-frame == --color-background`, and zai-light sets
`--color-panel == --color-card == --color-input == --color-popover == --color-menu == #ffffff`.
When a new surface needs to separate from the one behind it, those collapses conflict: a token that
separates cleanly in Dracula is a literal no-op in zai-light. We decided to **design to Dracula's
four steps** and let a palette that collapses two of them degrade, with separation falling back to
the `border-border` that cards and columns already carry.

This is a decision against the obvious reading of "support all themes equally", and it is worth
recording because the wrong answer is easy to reach and confident. Designing to the intersection of
all four palettes is achievable and wrong: it forces every surface onto tokens that survive the
flattest palette, which in practice means `bg-surface` (a translucent 5%-white / 3%-ink wash that
re-resolves against whatever is under it) everywhere, and the elevation ladder stops being a ladder.
That is exactly what the Task board had done — columns and cards both on `bg-surface`, cards
sitting on columns at ~1.16, separation carried entirely by borders.

## Considered Options

- **Design to the intersection (the token that works in all four palettes).** Rejected: the
  flattest palette sets the ceiling, so the ladder collapses to one rung plus borders. It also
  hides the collapse rather than surfacing it — nothing in zai-light looks broken, so the ladder
  quietly stops existing.
- **Add a token per region so every palette has a real step.** Rejected: a new `--color-*` enters
  `paletteCompleteness.test.ts`'s arithmetic gates ("is 120 declarations: 89 structural + 25
  descriptors + 6 ramp", "inherits exactly the 54 identity/overlay tokens") and the test that
  freezes the zai blocks, so a colour decision becomes a five-layer CSS change. Every fill this
  design needs already exists.
- **Design to Dracula, accept degradation elsewhere.** Chosen.

## Consequences

- **A contrast check in one palette proves nothing.** Every separation claim in this and future
  work must be measured per palette. The figures that drove an earlier round of this design were
  computed from Dracula alone and produced a recommendation — recess cards to `bg-panel` — that is
  a **no-op in zai-light**, because both tokens are `#ffffff` there. Verify in
  Settings → Appearance, all three, before calling a surface done.
- **`bg-panel` is not always recessed.** It is `#191a21` in Dracula (a genuine step below the
  `#282a36` slab) and `#ffffff` in zai-light (level with the card it is meant to sit under). "Use
  `bg-panel` to recess" is a Dracula-shaped instruction, not a universal one.
- **A collapsed step is not a bug to fix in the palette.** The zai blocks are frozen by
  `paletteCompleteness.test.ts` ("leaves the zai blocks untouched (the palette axis must not move
  them)"). If a surface reads flat in zai-light, the fix is the border that is already there, not
  a palette edit.
- **Dracula is now load-bearing as the reference.** A future change that re-anchors Dracula's
  ladder (as the one-step-down amendment to ADR 0027 already did) re-decides this decision's
  premises, not just its colours.
