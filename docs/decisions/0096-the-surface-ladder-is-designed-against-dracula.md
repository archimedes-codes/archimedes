---
status: accepted
date: 2026-11-09
superseded-by:
---

# The surface ladder is designed against Dracula; a palette that collapses a step degrades rather than vetoing the design

> **Narrowed 2026-11-12 by ADR 0105.** This ADR decided *which palette to design the ladder against*,
> and that decision stands. What it silently also decided — because Dracula was the only Palette the
> ladder gate *graded* — was that the gate's **tables** were Dracula's too: one shared group table, and
> one rule, strictly ascending. Neither survives a second Palette. ADR 0105 moves group membership to
> per-Palette spec-data and splits the rule (dark ascends strictly, light may plateau at its top group).
> "Design to Dracula" now means *the floors are calibrated there*, not *the tables are Dracula's*. Read
> that ADR before quoting "four strictly ascending steps" or `secondary`-on-the-raised-rung as a
> property of the ladder rather than of Dracula.

The app ships four surface-bearing palettes (`.dark`, `.theme-default-light`, `.theme-default-dark`,
`.theme-dracula-dark`) and they do **not** expose the same number of distinct steps: Dracula has four
(`#191a21` frame+panel · `#21222c` page+composer · `#282a36` slab+floats · `#343746`
card+secondary), while default dark and default light each declare eight groups but collapse the ones that
matter — default dark sets `--color-frame == --color-background`, and default light sets
`--color-panel == --color-card == --color-input == --color-popover == --color-menu == #ffffff`.
When a new surface needs to separate from the one behind it, those collapses conflict: a token that
separates cleanly in Dracula is a literal no-op in default light. We decided to **design to Dracula's
four steps** and let a palette that collapses two of them degrade, with separation falling back to
the `border-border` that cards and columns already carry.

("Four surface-bearing palettes" counted `.dark` as one of them and was true of the tree on
2026-11-09; the registry now offers 13 readings across 7 Palettes. The count is left as written — it is
the premise this ADR was argued from, and ADR 0105's measurement of what changed is the record. One
generalisation this text invites is measurably false, so it is corrected here rather than left to
inference: a light reading is NOT a collapsed dark ladder and it is not the flattest surface in the app
either. Counting distinct hexes across the 14 surface tokens (`frame`, `background`, `panel`, `header`,
`chat`, `card`, `input`, `popover`, `menu`, `secondary`, `tag`, `composer`, `inspector`, `sidebar`;
`color-mix` values excluded because they are not comparable by eye), every reading lands between 4 and 6:
default light 4, default dark 4, dracula dark 4, ayu 4 D / 5 L, catppuccin 4 D / 5 L, rose-pine 4 D / 5 L,
kanagawa 4 L / 6 D, everforest 5 both. The spread the ADR was written about is real and it survives the
widening — but it does not sort by light-versus-dark, which is why ADR 0105 carves light out of the
strict-ascending rule instead of granting exemptions inside it.)

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
  hides the collapse rather than surfacing it — nothing in default light looks broken, so the ladder
  quietly stops existing.
- **Add a token per region so every palette has a real step.** Rejected: a new `--color-*` enters
  `paletteCompleteness.test.ts`'s arithmetic gates ("is 120 declarations: 89 structural + 25
  descriptors + 6 ramp", "inherits exactly the 54 identity/overlay tokens") and the test that
  freezes the default blocks, so a colour decision becomes a five-layer CSS change. Every fill this
  design needs already exists.
- **Design to Dracula, accept degradation elsewhere.** Chosen.

## Consequences

- **A contrast check in one palette proves nothing.** Every separation claim in this and future
  work must be measured per palette. The figures that drove an earlier round of this design were
  computed from Dracula alone and produced a recommendation — recess cards to `bg-panel` — that is
  a **no-op in default light**, because both tokens are `#ffffff` there. Verify in
  Settings → Appearance, all three, before calling a surface done.
- **`bg-panel` is not always recessed.** It is `#191a21` in Dracula (a genuine step below the
  `#282a36` slab) and `#ffffff` in default light (level with the card it is meant to sit under). "Use
  `bg-panel` to recess" is a Dracula-shaped instruction, not a universal one.
- **A collapsed step is not a bug to fix in the palette.** The default blocks are frozen
  by `paletteCompleteness.test.ts` ("leaves the default blocks untouched (the palette axis
  must not move them)"). If a surface reads flat in default light, the fix is the border that
  is already there, not
  a palette edit.
- **Dracula is now load-bearing as the reference.** A future change that re-anchors Dracula's
  ladder (as the one-step-down amendment to ADR 0027 already did) re-decides this decision's
  premises, not just its colours.

## Amendment (2026-11-09, issue #173): the border that is "already there" is now a token, and Dracula's is retuned

The consequence above — *"if a surface reads flat in default light, the fix is the border that is
already there, not a palette edit"* — was written when every card and column border resolved
through `--color-border`. That made the fallback and the app-wide divider the **same** value, so
quieting a resting seam meant editing `--color-border`, which feeds inputs, popovers, tabs and
every divider in the app and is graded by the LADDER and Selection gates. The Task board shipped
with five outlined rectangles at 3.68 against their own column fill while the elevation ladder
steps only 1.22 / 1.21 — outlines dominating fills, which is the failure this ADR exists to avoid.

The fix routes the resting seam through the palette's **existing** seam token
`--color-card-border` and retunes it in `.theme-dracula-dark` only, to `#21222c`. That value is not
invented: it is the **exact per-channel midpoint** of the recessed column `#191a21` and the island
`#282a36` it sits between, so the seam measures **1.10** against the column and **1.11** against
the island — equidistant, therefore neither a highlight nor a shadow. It is the page step, already
published by the Dracula spec, so `paletteCompleteness.test.ts`'s "spec publishes this hex" gate
holds and no new token enters its declaration arithmetic.

What this does **not** change, and why:

- **The four quiet palettes keep `--color-card-border: var(--color-border)`.** Their borders are
  already a 10% alpha wash; only Dracula's `--color-border` is opaque, which is precisely why a
  seam that is quiet everywhere else screams there. This is the ADR's own logic applied one level
  down: design to Dracula, let the others keep the alias.
- **An opacity modifier was the wrong instrument.** `border-border/50` composites to `#3e4663`
  over the column and `#4b5575` over the card — **1.87** and **1.60** respectively, still louder
  than either fill step (1.22 / 1.21) — while cutting default light's *only* separation from 1.24 to
  1.11.
  A per-palette token quiets one palette; a modifier taxes all four. This is the "a contrast check
  in one palette proves nothing" consequence, measured rather than asserted.
- **Borderlessness remains unavailable**, and the reference board this work copied from is
  borderless. In `.theme-default-light` `--color-panel == --color-card == #ffffff`, so a
  borderless
  column measures 1.08 against the `#f6f6f6` island — invisible. Its monotonic ascending ladder
  affords no borders; our descending-then-ascending ladder plus the designed no-op does not.
- **A drag affordance is not a resting seam.** The drop target keeps `border-brand`: it is meant to
  be loud. `twMerge` resolves `border-brand` over either border token byte-identically, so the
  affordance's merge outcome did not move, and it stays pinned by `data-over` rather than by a
  class assertion — a test on the *state* cannot pass by accident because a different utility
  survived the merge.

A `SettingsGroupCard` detail worth keeping: its shell passed `border border-border` over
`ui/card.tsx`'s `border border-card-border`. Those are the **same tailwind-merge group**, so the
override had to be **deleted**, not replaced — a second border utility in the same group silently
loses to argument order. A pin that only greps for `border-border` would have passed either way.
