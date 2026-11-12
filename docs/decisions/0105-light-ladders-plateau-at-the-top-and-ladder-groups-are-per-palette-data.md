---
status: accepted
date: 2026-11-12
superseded-by:
---

# Light ladders **plateau at the top**, dark ladders ascend strictly, ladder group membership is per-**Palette** data, and **alpha** is allowed on text tokens and refused on surfaces

The ladder gate in `paletteTestKit.ts` used to carry one group table and one rule — strictly ascending —
both lifted from Dracula, where they happened to be true. Grading the default Palette's **light**
reading against them is impossible, so we decided three linked things: **a dark reading must strictly
ascend; a light reading must be non-decreasing and may plateau only at its top group**; **group
membership is per-Palette spec-data (`ladderGroups` in `src/lib/palettes/<id>.ts`), never a shared
table**; and **alpha is allowed on TEXT tokens and refused on SURFACE tokens** — a translucent surface
is not an elevation step, and belongs in `ladderExemptions` with a reason rather than in a group. The
resolver had to be rebuilt for the third point to be checkable at all, which is why this ADR records a
toolchain decision next to two design ones.

**Why:** ADR 0096 decided to design the elevation ladder against Dracula and let flatter palettes
degrade. That decision stands — but it was made when Dracula was the only Palette the ladder gate
*graded*, so "design against Dracula" silently also meant "the gate's tables are Dracula's". The moment
a second Palette is graded, those tables become assertions about every other scheme, and two of them
are false.

## The measurements that forced this

Every figure below is relative luminance, computed by the kit's own `lumOf` from the declarations in
`src/styles/theme.css` — not recalled from a design doc, which is the lesson ADR 0027 wrote down after
retracting three self-reported facts.

The **default light** reading, in ladder order:

| step | tokens | hex | L |
| --- | --- | --- | --- |
| the recessed chips | `secondary`, `tag`, `tooltip-tag` | `#e6e6e6` | **0.7913** |
| the column's backdrop | `background-win-alt` | `#ececee` | 0.8400 |
| the chrome and quiet fills | `frame`, `menu-hover`, `tab`, `tooltip` | `#f0f0f0` | **0.8714** |
| the page plane and its aliases | `background`, `chat`, `inspector`, `popover-header`, `terminal-bg` | `#f8f8f8` | **0.9387** |
| the white plateau | `card`, `composer`, `header`, `input`, `input-focused`, `menu`, `panel`, `popover`, `tab-active`, `toast` | `#ffffff` | **1.0000** |

Three facts come out of that table, and no shared Dracula-shaped table can carry all three.

1. **A light ladder has a ceiling, so it plateaus.** `frame #f0f0f0` → `background #f8f8f8` →
   `card #ffffff` ascend, and then **ten tokens are `#ffffff`**. No light theme publishes anything
   lighter than its own Base, so the top step is not a design failure to fix by inventing `#fffffe` —
   it is the palette running out of headroom. A strictly-ascending rule there does not detect a bug; it
   forbids the palette from existing. Hence *non-decreasing, plateau allowed at the top group only*:
   `#ffffff` after `#f8f8f8` passes, `#f8f8f8` after `#ffffff` (an inversion) still fails, and a
   plateau in the **middle** still fails, because a middle plateau is an untracked rung rather than a
   ceiling.
2. **Group membership inverts between palettes.** `secondary #e6e6e6` (L 0.7913) sits **below**
   `card #ffffff` (1.0000) — in default light the badge and inline-code chip are the *recessed* step,
   the darkest thing in the reading. In Dracula `--color-secondary` **is** `--color-card`, both
   `#343746`, the *raised* step. One shared table would have to put `secondary` in two groups at two
   different heights, so the group a token belongs to is now declared per-Palette, per-mode, with a
   `label` that appears in the failure message so a designed plateau reads differently from a bug.
   What decides membership is **consumption, not hue**: `secondary`/`tag` are the "raised" *class* in
   the contrast gate in both palettes because a chip sits ON them, and they are the darkest *ladder
   step* in light and the brightest in dark. Those are different questions and the row answers each
   separately.
3. **The selection state follows the ceiling.** `--color-card-selected` is `var(--color-input)` — the
   white plateau itself — so the light reading's rule is `at-or-above-card` rather than "strictly
   above the resting step". A selected row must not *sink* below the surface it sits on; demanding it
   rise above white asks for a colour that does not exist.

## The resolver reason, because the alpha rule is unenforceable without it

`paletteCompleteness.test.ts`'s old `composite()` parsed exactly two shapes:
`color-mix(in oklab, #rrggbb N%, transparent)` and a bare `#rrggbb`. **It threw on an 8-digit hex.**
`fileIconContrast.test.ts`'s `resolveToHex` already handled `#rgba`, `#rrggbbaa`, `rgb()`/`rgba()`, a
single-colour `color-mix` and one hop of `var()` — but it read a translucent value raw rather than
compositing it over the surface it paints on. The kit's `resolveToHex` is a **merge** of the two, and
the merge is the point: **Catppuccin, Rosé Pine, Everforest and Ayu all publish key UI colours as hex +
alpha** (Rosé Pine's `#6e6a8633`, Everforest's `#475258c0`, Catppuccin's selection = Overlay 2 at
20–30%, Ayu throughout), so a gate built on `composite` could not grade the four Palettes this plan
adds — it would throw on the transcription, and a gate that throws gets skipped, which is how a gate
becomes decorative.

Ayu is the sharpest case, because de-alpha-ing is not merely inaccurate, it is against the theme's own
instructions: Ayu publishes its foregrounds as 8-digit alpha (`#fcf8ecbd`) and its `AGENTS.md` states
that text colours are translucent **deliberately**, so they blend over any surface. Dropping the alpha
to satisfy a `^#[0-9a-f]{6}$` gate erases the theme's 74% weight. Hence: **alpha on a text token is
allowed, and is composited over the surface the copy actually lands on before the ratio is taken.**

**Alpha on a surface token is refused**, and the reason is not tidiness. The ladder is an *elevation*
model: step N is distinguishable from step N−1 because their luminances differ. A translucent surface
has no luminance of its own — it re-resolves against whatever is painted under it — so "it is one step
up" is not a claim about it that can be measured. A palette that put `color-mix(… 12%, transparent)` in
a ladder group would be graded against a hex it never renders, which is the exact failure this kit
exists to catch (a token graded on a surface it does not paint on). Such a token goes in
`ladderExemptions` **with a reason**, and the kit proves a named exemption is genuinely unresolvable
via `isResolvable`, so a refusal cannot rot into a skip; it also fails an exemption naming a token the
reading no longer declares, so the list cannot stale.

## Considered Options

- **Keep one shared group table, add a per-palette exception list to it.** Rejected: `secondary` is not
  an exception to a shared table, it is *in a different place* in two palettes — the table would become
  a copy of every palette's ladder with the palette's name stripped off, and the copy would drift.
- **Grade light ladders with a descending allowance, since light themes "recess by darkening".**
  Rejected: the default light reading is monotonically ascending, the plateau is at the top, and a
  rule that permits descents would let a genuine inversion (`card` darker than the page it sits on)
  through in the palette that most needs catching.
- **De-alpha at transcription so the hex gate stays 6-digit.** Rejected for Ayu's specific reason: the
  theme's own guidance says the translucency is the design, so "transcribe faithfully" and "satisfy the
  gate" would be in direct conflict, and the gate would win by fiat.
- **Give up on `#rrggbbaa` and grade only opaque tokens.** Rejected: that silently drops four of the
  seven Palettes from the contrast gate, and a partial gate printed as green is worse than no gate.

## Consequences

- **The ladder message says which rule fired** (`a dark reading must strictly ascend` / `a light reading
  must be NON-DECREASING and may plateau only at its top group: no light theme publishes anything
  lighter than its Base` / `a light reading may only plateau at the top`), because the three failures
  need three different fixes and one message cannot guide all three.
- **A group must carry exactly one colour.** `distinct.size <= 1` — a group claiming one step and
  carrying two is an untracked rung, and it is reported rather than averaged.
- **Every surface token a reading declares must be classified** — group member, selection token, or
  named exemption. A new region token cannot join a palette ungraded, and a renamed one cannot vanish
  quietly.
- **`composite` is gone and both contrast gates share one resolver.** A resolver that throws with the
  token name is the design: a value that silently vanished from the map used to be graded on a fallback
  surface. The mutation pin for the nastiest bug found on the way lives in `paletteTestKit.test.ts` —
  handing the hex parser a capture group without the `#` drops the **top nibble** (`#ff0000` read as
  `#0f0000`), which is what `fileIconContrast.test.ts` shipped before the merge.
- **ADR 0096's premise is narrower than it read.** "Design to Dracula" was about which palette's steps
  the *layout* targets, not about where the gate's tables live. The layout decision is untouched; the
  group table is data now. A future Palette does not ask permission from Dracula's ladder, and Dracula
  does not get to veto a light palette's ceiling.
- **Dracula's own ladder is unchanged** — four strictly-ascending steps, `#191a21` · `#21222c` ·
  `#282a36` · `#343746`, with `secondary == card` expressed as one group. The uniform rule is
  "strictly ascending" for it, so nothing about the shipped dark palette moved.
- **The spec-hex gate still matches 6-digit hexes** (`#[0-9a-fA-F]{6}`) on purpose: it asks "is this
  value published?", and an alpha channel is a *use* of a published value rather than a new one. The
  published set is therefore checked against the RGB part; the alpha lives in the resolver's domain,
  not the transcription's.
