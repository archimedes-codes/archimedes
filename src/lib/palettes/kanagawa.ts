import { SURFACE_TOKEN_PATTERN, type PaletteSpec } from "../paletteSpec";

/**
 * The 25 file-type DESCRIPTORS, in the order `paletteCompleteness.test.ts` lists
 * them. `file-node*` are NOT here — those are the file-row ROLE CHIP, and they ride
 * `.dark`'s reading rather than being restated by a Palette.
 *
 * Kanagawa needs 24 of them allow-listed, and the shape is Dracula's for the same
 * reason: the scheme publishes ~100 hues and still cannot name 25 file types
 * without making a `.py` chip indistinguishable from a `.json` one, and the hue IS
 * the only thing distinguishing them — so the **Identity color** rule
 * (`CONTEXT.md`) knowingly outranks the spec's "use exact color values from this
 * specification". Listed BY NAME, never by family, because an entry that excuses a
 * whole family is how an allow-list stops meaning anything.
 *
 * `color-file-css` is the one descriptor that needs no exemption: it is re-read at
 * `oniViolet #957fb8`, which IS a published Kanagawa value, for the measured reason
 * on the declaration in `src/styles/kanagawa.css` (the default palette's `#7e57c2`
 * is 2.27 on this block's raised `#363646`, under the 3:1 glyph floor that surface
 * is graded on).
 */
const FILE_DESCRIPTORS = [
  "color-file-ts",
  "color-file-react",
  "color-file-js",
  "color-file-json",
  "color-file-html",
  "color-file-css",
  "color-file-sass",
  "color-file-md",
  "color-file-rs",
  "color-file-py",
  "color-file-sh",
  "color-file-yaml",
  "color-file-toml",
  "color-file-lock",
  "color-file-image",
  "color-file-svg",
  "color-file-archive",
  "color-file-go",
  "color-file-vue",
  "color-file-svelte",
  "color-file-java",
  "color-file-php",
  "color-file-xml",
  "color-file-graphql",
  "color-file-db",
] as const;

const offSpecAllowList = Object.fromEntries(
  FILE_DESCRIPTORS.filter((token) => token !== "color-file-css").map((token) => [
    token,
    "file-type Identity hue copied from .theme-default-dark: Kanagawa's ~100 hues cannot name 25 file types without collapsing two chips onto one hue, and the hue IS the signal (CONTEXT.md's Identity color rule outranking the spec)",
  ]),
);

/**
 * Kanagawa's grading row — wave (dark) and lotus (light). `dragon`, the third
 * variant, is out of scope: it is a second dark, not a light, and the registry
 * ships two readings.
 *
 * WHERE THE VALUES COME FROM, because the two files disagree and a reader must know
 * which one this row obeyed. The README's Name/Hex/Usage table publishes FIVE
 * background shades and numbers them `sumiInk0`…`sumiInk4`; `lua/kanagawa/colors.lua`
 * publishes SEVEN (`sumiInk0 #16161D`, `sumiInk1 #181820`, `sumiInk2 #1a1a22`,
 * `sumiInk3 #1F1F28`, `sumiInk4 #2A2A37`, `sumiInk5 #363646`, `sumiInk6 #54546D`)
 * and `lua/kanagawa/themes.lua` maps six of them to the ladder `ui.bg_m3…bg_p2`. So
 * the same NAME means a different HEX in the table than in the Lua, and the two rungs
 * the table omits are the SECOND and THIRD steps of the scheme, not spares. This row
 * follows `themes.lua`, because it is the file that states what each colour is FOR —
 * and that decision is what makes the ladder six steps instead of four.
 *
 * THE SPEC PUBLISHES A CONTRAST CLAUSE and this row holds it where the scheme can
 * and reports it where it cannot. Verbatim from
 * https://github.com/rebelot/kanagawa.nvim#accessibility:
 *
 *   "The colors maintain a `4.5:1` contrast ratio, complying with
 *   [WCAG 2.1 | Level AA](https://www.w3.org/TR/WCAG21/#contrast-minimum)."
 *
 * That is the same shape as Dracula's "Maintain 4.5:1 minimum contrast ratio", so it
 * is treated the same way: it is not scoped to body text and names no exemption,
 * every sub-4.5 floor below is a REPORTED WALL carrying the measured number, and
 * every one carries `expiresAt: 4.5` so the exemption dies the day the hue clears the
 * floor. Nothing here was re-hued to make a wall disappear.
 *
 * WAVE HOLDS IT ON 14 OF ITS 21 GRADED READINGS AND MISSES ON SEVEN. Grading all
 * seven text tokens against all three surface classes gives 21 readings; 14 clear 4.5.
 * The seven that do not are spread over four tokens — `foreground-subtlest` (all three
 * classes: 4.34 resting, 3.64 raised, 2.66 selected), `destructive` (3.94 raised, 2.88
 * selected) and, on the selection step only, `success` (3.98) and `warning` (4.21).
 * Three tokens — `foreground`, `foreground-subtle`, `caution` — clear everywhere.
 * `destructive` has no better published
 * option at all — the semantic alternative, `samuraiRed`, is 2.66 on the same surface.
 * `foreground-subtlest` DOES have one, and it is stated rather than hidden:
 * `springViolet2` would clear the floor on every resting plane and the raised one
 * (6.12 on the float, 5.13 on the card) and fail only on the selection step. It is not
 * taken because it is this block's own `--color-thinking-medium` — a text token
 * printing the same hex as a ramp LEVEL is what `themeTokens.test.ts` convicts by
 * name, and it does (verified by mutation) — and the scheme has already spent that hue
 * on "Brackets and punctuation". So this wall is a CHOICE with a gate behind it, not
 * an impossibility, and `expiresAt: 4.5` keeps it revisable.
 *
 * LOTUS CANNOT HOLD IT, and the reason is structural, so it is worth stating once
 * here rather than per token. Lotus is not a white theme: its Base is `lotusWhite3
 * #f2ecbc` and its darkest published light STEP is `lotusWhite0 #d5cea3`, relative
 * luminance 0.6093 against `default-light`'s page at 0.9387. A mid-tone yellow ground
 * costs a light theme roughly a point and a half of contrast against every dark ink.
 * The size of the problem is countable rather than rhetorical: of lotus's 40 published
 * values, exactly THREE clear 4.5 on that binding `#d5cea3` ground — `lotusInk2
 * #43436c` (5.84, but DARKER than the foreground, so it out-inks the body copy it is
 * supposed to sit under), `lotusInk1 #545464` (4.66, clearing the clause with 0.16 to
 * spare — and it IS `--color-foreground`, the scheme's only published foreground) and
 * `lotusViolet4 #624c83` (4.58 — but it is this block's own `--color-brand`/
 * `--color-primary` and separates from the foreground by only 1.0183, so it is a
 * de-emphasis tier that does not de-emphasise). EVERY published value lighter than
 * `--color-foreground-subtle` tops out at 3.06 there, so the de-emphasis tier and all
 * four status hues are walls on the frame step, and the scheme's own semantic
 * assignments are usually WORSE, not better: `diag.ok` is `lotusGreen` at 2.46 there
 * and `diag.warning` is `lotusOrange2` at 1.63. Each floor below therefore names both
 * the number this block reaches and the published value that would beat it, so a
 * future reader can see the choice was measured rather than inherited.
 */
export const spec: PaletteSpec = {
  id: "kanagawa",
  cssFile: "src/styles/kanagawa.css",
  baseCssFile: "src/styles/theme.css",
  specSourceUrl:
    "https://github.com/rebelot/kanagawa.nvim — the README's Name/Hex/Usage palette table, plus lua/kanagawa/colors.lua (every published hex) and lua/kanagawa/themes.lua (which hex each theme assigns to which function). themes.lua is the authority where the two disagree on the sumiInk numbering; see the block comment.",
  publishedHexes: [
    "#0d0c0c", // dragon (out of scope): dragonBlack0
    "#12120f", // dragon (out of scope): dragonBlack1
    "#16161d", // wave:   sumiInk0
    "#181616", // dragon (out of scope): dragonBlack3
    "#181820", // wave:   sumiInk1
    "#1a1a22", // wave:   sumiInk2
    "#1d1c19", // dragon (out of scope): dragonBlack2
    "#1f1f28", // wave:   sumiInk3
    "#223249", // wave:   waveBlue1
    "#252535", // wave:   winterBlue
    "#282727", // dragon (out of scope): dragonBlack4
    "#2a2a37", // wave:   sumiInk4
    "#2b3328", // wave:   winterGreen
    "#2d4f67", // wave:   waveBlue2
    "#363646", // wave:   sumiInk5
    "#393836", // dragon (out of scope): dragonBlack5
    "#43242b", // wave:   winterRed
    "#43436c", // lotus:  lotusInk2
    "#49443c", // wave:   winterYellow
    "#4d699b", // lotus:  lotusBlue4
    "#4e8ca2", // lotus:  lotusTeal1
    "#545464", // lotus:  lotusInk1
    "#54546d", // wave:   sumiInk6
    "#597b75", // lotus:  lotusAqua
    "#5a7785", // lotus:  lotusTeal3
    "#5d57a3", // lotus:  lotusBlue5
    "#5e857a", // lotus:  lotusAqua2
    "#624c83", // lotus:  lotusViolet4
    "#625e5a", // dragon (out of scope): dragonBlack6
    "#658594", // wave:   dragonBlue
    "#6693bf", // lotus:  lotusTeal2
    "#6a9589", // wave:   waveAqua1
    "#6e915f", // lotus:  lotusGreen2
    "#6f894e", // lotus:  lotusGreen
    "#716e61", // lotus:  lotusGray2
    "#717c7c", // wave:   katanaGray
    "#727169", // wave:   fujiGray
    "#737c73", // dragon (out of scope): dragonAsh
    "#766b90", // lotus:  lotusViolet2
    "#76946a", // wave:   autumnGreen
    "#77713f", // lotus:  lotusYellow
    "#7a8382", // dragon (out of scope): dragonGray3
    "#7aa89f", // wave:   waveAqua2
    "#7e9cd8", // wave:   crystalBlue
    "#7fb4ca", // wave:   springBlue
    "#836f4a", // lotus:  lotusYellow2
    "#87a987", // dragon (out of scope): dragonGreen
    "#8992a7", // dragon (out of scope): dragonViolet
    "#8a8980", // lotus:  lotusGray3
    "#8a9a7b", // dragon (out of scope): dragonGreen2
    "#8ba4b0", // dragon (out of scope): dragonBlue2
    "#8ea4a2", // dragon (out of scope): dragonAqua
    "#938056", // wave:   boatYellow1
    "#938aa9", // wave:   springViolet1
    "#949fb5", // dragon (out of scope): dragonTeal
    "#957fb8", // wave:   oniViolet
    "#98bb6c", // wave:   springGreen
    "#9cabca", // wave:   springViolet2
    "#9e9b93", // dragon (out of scope): dragonGray2
    "#9fb5c9", // lotus:  lotusBlue3
    "#a09cac", // lotus:  lotusViolet1
    "#a292a3", // dragon (out of scope): dragonPink
    "#a3d4d5", // wave:   lightBlue
    "#a6a69c", // dragon (out of scope): dragonGray
    "#b35b79", // lotus:  lotusPink
    "#b5cbd2", // lotus:  lotusBlue2
    "#b6927b", // dragon (out of scope): dragonOrange
    "#b7d0ae", // lotus:  lotusGreen3
    "#b8b4d0", // wave:   oniViolet2
    "#b98d7b", // dragon (out of scope): dragonOrange2
    "#c0a36e", // wave:   boatYellow2
    "#c34043", // wave:   autumnRed
    "#c4746e", // dragon (out of scope): dragonRed
    "#c4b28a", // dragon (out of scope): dragonYellow
    "#c5c9c5", // dragon (out of scope): dragonWhite
    "#c7d7e0", // lotus:  lotusBlue1
    "#c84053", // lotus:  lotusRed
    "#c8c093", // wave:   oldWhite
    "#c9cbd1", // lotus:  lotusViolet3
    "#cc6d00", // lotus:  lotusOrange
    "#d27e99", // wave:   sakuraPink
    "#d5cea3", // lotus:  lotusWhite0
    "#d7474b", // lotus:  lotusRed2
    "#d7e3d8", // lotus:  lotusCyan
    "#d9a594", // lotus:  lotusRed4
    "#dca561", // wave:   autumnYellow
    "#dcd5ac", // lotus:  lotusWhite1
    "#dcd7ba", // shared: fujiWhite / lotusGray
    "#de9800", // lotus:  lotusYellow3
    "#e46876", // wave:   waveRed
    "#e4d794", // lotus:  lotusWhite5
    "#e5ddb0", // lotus:  lotusWhite2
    "#e6c384", // wave:   carpYellow
    "#e7dba0", // lotus:  lotusWhite4
    "#e82424", // wave:   samuraiRed / lotusRed3
    "#e98a00", // lotus:  lotusOrange2
    "#f2ecbc", // lotus:  lotusWhite3
    "#f9d791", // lotus:  lotusYellow4
    "#ff5d62", // wave:   peachRed
    "#ff9e3b", // wave:   roninYellow
    "#ffa066", // wave:   surimiOrange
  ],
  offSpecAllowList,
  modes: {
    /* ══════════════════════════════════════ LIGHT — lotus ══════════════════════
     * THE LIGHT READING IS THE HARD HALF of this Palette, and ADR 0105 is the rule
     * that makes it gradeable at all: a light theme publishes nothing LIGHTER than
     * its own Base, so the ladder is non-decreasing with the plateau at the TOP, and
     * the selection state cannot be "the brightest step" the way wave's is.
     *
     * Lotus shows why the rule needs to be per-READING and not per-Palette. Its own
     * `themes.lua` ladder is NOT monotonic in luminance — `bg` (`lotusWhite3
     * #f2ecbc`, L 0.8250) is lighter than the two steps nominally above it,
     * `bg_p1 #e7dba0` (0.7019) and `bg_p2 #e4d794` (0.6723). Taking the scheme's rung
     * NAMES in order would produce a ladder that descends and would be correctly
     * rejected. So this reading orders the six published steps by LUMINANCE, puts the
     * scheme's Base at the top as the plateau (the same move `default-light` makes
     * with its white plateau, ADR 0096), and states the page on `bg_m2`, which is
     * `themes.lua`'s own `ui.bg_dim` — the scheme's dimmed ground. `--color-frame`
     * takes a darker published value than the surfaces it frames, exactly as
     * `default-light`'s `#f0f0f0` does. */
    light: {
      mode: "light",
      ladderGroups: [
        {
          label:
            "the context bar's TRACK — an exception to the plane order rather than a plane: its job is to separate from the PANE it rides (1.2302 against --color-inspector, over slabFloatSeparation's 1.2 floor), and lotus's bg_visual #c9cbd1 would score 1.1819 and fail it, which is why the track takes bg_search",
          tokens: ["color-context-track"],
        },
        {
          label:
            "the recessed plane, the chrome band AND the raised chips — bg_m3, lotus's darkest published light step. secondary/tag/tooltip-tag are the DARKEST rung in a light reading, the exact inverse of the dark block where they are the brightest; that inversion is ADR 0105's measurement (default-light's secondary #e6e6e6 sits BELOW its card #ffffff, while Dracula's secondary IS its card) and is why group membership is per-reading data",
          tokens: [
            "color-frame",
            "color-panel",
            "color-popover-header",
            "color-secondary",
            "color-tag",
            "color-tooltip-tag",
          ],
        },
        {
          label:
            "the page plane, the composer island, the window's alternate step and the terminal's paper — bg_m2, which is themes.lua's own ui.bg_dim. The page sits one rung below the slab so the content column reads as lifted without a border",
          tokens: [
            "color-background",
            "color-composer",
            "color-background-win-alt",
            "color-terminal-bg",
          ],
        },
        {
          label: "menu hover and the tooltip — bg_p2, a step above the page and below the slab",
          tokens: ["color-menu-hover", "color-tooltip"],
        },
        { label: "the tab strip — bg_p1, the scheme's bg_gutter rung", tokens: ["color-tab"] },
        {
          label:
            "the CONTENT SLAB and the inspector, plus the active tab showing through — bg_m1. One token for transcript column, side pane and active tab, so they cannot drift apart",
          tokens: ["color-chat", "color-inspector", "color-tab-active"],
        },
        {
          label:
            "THE PLATEAU, and the top group is where a light reading is allowed to plateau (ADR 0105): #f2ecbc is lotusWhite3, themes.lua's ui.bg, and it is the LIGHTEST value the scheme publishes — so card, header, input, menu, popover and toast cannot be separated by fill at all. Separation here is carried by --color-card-border and a float's shadow, which is what ADR 0096's designed collapse means and why slabFloatSeparation.test.ts pins the shadows",
          tokens: [
            "color-card",
            "color-header",
            "color-input",
            "color-input-focused",
            "color-menu",
            "color-popover",
            "color-toast",
          ],
        },
      ],
      /* `--color-card-selected` is `var(--color-input)` — the plateau itself. Nothing
       * in a light palette is lighter than its Base, so "strictly above every resting
       * step" is not satisfiable here and would veto the scheme rather than describe
       * it. `at-or-above-card` is the property that actually matters: a selected row
       * must not SINK below the surface it sits on. Same rule and same reasoning as
       * `default-light`, which collapses the token the same way. */
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {},
      textSurfaces: {
        /* The four planes copy lands on, chosen so the WORST is graded. `frame`
         * (#d5cea3, lotus's darkest light step) is in the resting class because chrome
         * carries copy — the sidebar's section headers, the session rows — and it is
         * the binding surface for every text token in this reading. Grading only the
         * page would report a floor the app never renders: `lotusInk1` is 5.00 on the
         * page and 4.66 on the frame step, and it is the 4.66 that is the wall.
         * `secondary`/`tag` are the RAISED class even though they are the DARKEST step
         * — what makes them raised is that a badge or chip lands ON something, not
         * which direction they move in. */
        resting: ["color-background", "color-chat", "color-frame", "color-popover"],
        raised: ["color-secondary", "color-tag", "color-menu-hover"],
        /* EMPTY, and it is a measurement: `--color-card-selected` is
         * `var(--color-input)` == `#f2ecbc` == `--color-popover`, which the resting
         * class already grades. Re-listing it would restate a hex already measured and
         * force a second copy of every floor to agree with the first. The STATE is
         * still graded, as a ladder rung, by `selectionRule` above. */
        selected: [],
      },
      /* Every one of these is a RECORDED WALL against the 4.5 clause quoted at the top
       * of this file, and every one is the WORST reading in its class, measured with
       * the kit's own `lumOf`/`contrast` against the surface the copy actually lands on.
       * None is fixed here: the fix would be a different palette, because lotus
       * publishes no value between `lotusInk1` (4.66 on the frame step) and
       * `lotusViolet2` (3.08) — there is nothing to move TO. Each carries
       * `expiresAt: 4.5`, so the exemption dies the moment the hue clears the floor. */
      textFloors: {
        "color-foreground-subtle": {
          floor: 3.05,
          reason:
            "worst resting reading: lotusViolet2 #766b90 is 3.08 on the #d5cea3 frame step (3.31 on the #dcd5ac page, 4.09 on the #f2ecbc Base). It is themes.lua's ui.special (SpecialKey). REPORTED WALL AND A CHOICE, not an impossibility — the alternative is named so it can be overruled with numbers: lotusViolet4 #624c83 sits between this and lotusInk1 and clears 4.5 on all four resting grounds (4.58 on the frame step, 4.91 page, 5.31 slab, 6.07 Base). It is not taken because (a) it separates from --color-foreground by only 1.0183, so it would be a de-emphasis tier that does not de-emphasise, and (b) it is this block's own --color-brand/--color-primary — a text token printing the brand fill's hex. Separation is the reason this tier exists, so 1.5115 above lotusViolet2 is the property being bought. `text-foreground-subtle` carries timestamps and secondary labels.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 2.2,
          reason:
            "worst resting reading, and the lowest text ratio in either reading: lotusGray3 #8a8980 is 2.21 on the #d5cea3 frame step (2.37 on the page, 2.93 on the Base). It is lotus's own syn.comment AND syn.deprecated — its designated quiet ink — and it must stay DIMMER than --color-foreground-subtle (luminance 0.2485 against 0.1638; the two tiers separate by 1.3963). MEASURED, not asserted: only THREE of lotus's 40 published values clear 4.5 on the binding #d5cea3 ground at all — lotusInk2 (5.84, DARKER than the foreground, so it out-inks the body copy), lotusInk1 (4.66, which IS --color-foreground) and lotusViolet4 (4.58, which is --color-brand/--color-primary and sits only 1.0183 under the foreground). Every published value LIGHTER than --color-foreground-subtle tops out at 3.06 there, so a de-emphasis tier that cleared 4.5 on lotus's own ground does not exist.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.05,
          reason:
            "worst resting reading: lotusRed #c84053 is 3.06 on the #d5cea3 frame step (3.28 on the page, 4.06 on the Base). It is the BRIGHTEST red lotus puts to use for text — lotusRed2 (vcs.removed) is 2.70 there and lotusRed3 (diag.error) is 2.80, so the scheme's own semantic error red is the WORSE reading and this block takes the legible one. `text-destructive` is the app's most-used status text.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 2.45,
          reason:
            "worst resting reading: lotusGreen #6f894e is 2.46 on the #d5cea3 frame step (2.64 on the page, 3.26 on the Base). This IS themes.lua's diag.ok AND syn.string, so it is not a substitution — it is the scheme's own green, and it is the brightest lotus ships (lotusGreen2, vcs.added, is 2.24 there; lotusGreen3 is a diff GROUND, not ink). The 4.5 clause is unreachable for this hue on lotus's own ground at any published value.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 2.25,
          reason:
            "worst resting reading: lotusOrange #cc6d00 is 2.29 on the #d5cea3 frame step (2.46 on the page, 3.04 on the Base). Deliberately NOT themes.lua's diag.warning, which is lotusOrange2 #e98a00 at 1.63 there — 0.66 weaker, and `text-warning` is overwhelmingly copy. lotusOrange2 stays where the scheme puts it, as the active find match. Neither clears 4.5; the brighter one wins and the wall is recorded.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.05,
          reason:
            "worst resting reading: #a16207 is 3.09 on the #d5cea3 frame step (3.32 on the page, 4.10 on the Base). NOT declared in this block at all — `caution` belongs to the RAMP family, so a light reading inherits @theme's light-safe reading, which is the value .theme-default-light resolves too, and this row grades what the browser actually paints rather than a value the block does not state. It carries a LABEL (the context bar's percentage band), so it is held to the text floor and not the 3:1 glyph floor.",
          expiresAt: 4.5,
        },
      },
      /* The raised class here is the DARK step (a chip is a mark on a surface, not a
       * plane above it), so the same five hues fail again — but slightly less badly
       * than on the frame step, because #d5cea3 IS this class's own surface. Kept as a
       * separate table rather than merged into `textFloors`, because a merged table
       * makes the expiry ratchet fire on the class the exemption was never about. */
      raisedFloors: {
        "color-foreground-subtle": {
          floor: 3.05,
          reason: "the #d5cea3 chip step: lotusViolet2 reaches 3.08 there (3.38 on the #e4d794 menu-hover).",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 2.2,
          reason: "the #d5cea3 chip step: lotusGray3 reaches 2.21 there (2.42 on the #e4d794 menu-hover).",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.05,
          reason: "the #d5cea3 chip step: lotusRed reaches 3.06 there (3.35 on the #e4d794 menu-hover).",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 2.45,
          reason: "the #d5cea3 chip step: lotusGreen reaches 2.46 there (2.69 on the #e4d794 menu-hover).",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 2.25,
          reason: "the #d5cea3 chip step: lotusOrange reaches 2.29 there (2.51 on the #e4d794 menu-hover).",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.05,
          reason: "the #d5cea3 chip step: the inherited @theme reading #a16207 reaches 3.09 there (3.39 on the #e4d794 menu-hover).",
          expiresAt: 4.5,
        },
      },
      /* EMPTY, and it is a measurement rather than an omission: the selection state is
       * the plateau, which the resting class already grades through `color-popover`. */
      selectedFloors: {},
      /* EMPTY, and that is a real assertion. Unlike both Default readings, Kanagawa's
       * foreground family is a LITERAL hex, not a `var()` into Tailwind's `oklch()`
       * scale — lotus publishes `lotusInk1` as a hex, so there is nothing here the
       * resolver cannot reach, and the kit fails any entry named that really IS
       * resolvable. Every graded text token in this reading is graded for real. */
      textUngradeable: {},
      /* 79 tokens: the 54 Identity families Dracula also inherits (the usage/heatmap scales,
       * the context-breakdown steps, the git hues, the six transcript role chips,
       * the file-row chip, the privacy hint, the white overlays, the wordmark) PLUS the 25
       * file-type DESCRIPTORS, which a light reading must NOT restate. Both directions of
       * the completeness predicate check this list, so a token added to
       * .theme-default-dark has to be classified rather than silently inherited. The
       * descriptor half is the light reading's own rule and not Dracula's — he restates
       * them because he is a DARK reading resolving through `.dark`; a LIGHT reading
       * renders with no `.dark` class at all, so it resolves to @theme's light-safe
       * readings, which are light-safe precisely because they were chosen for a light
       * page. Restating the vivid dark hues would put a `#ff5252` glyph on the
       * `#e5ddb0` slab (2.33, under the 3:1 glyph floor) AND shadow the value a
       * classless document depends on. `.theme-default-light` DECLARES none of the 25
       * and names all 25 as inherited in its own spec row for exactly this reason, and
       * this row follows it. The 6 ramp tokens are absent for the same documented
       * reason, which is why extraBeyondDefault below is empty rather than the ramp. */
      inheritedFromDefault: [
        "animated-gradient-text-soft",
        "animated-gradient-text-strong",
        "color-command-node",
        "color-command-node-foreground",
        "color-command-node-hover",
        "color-context-breakdown-1",
        "color-context-breakdown-2",
        "color-context-breakdown-3",
        "color-context-breakdown-4",
        "color-context-breakdown-5",
        "color-context-breakdown-6",
        "color-context-breakdown-7",
        "color-feedback-privacy-hint",
        "color-file-archive",
        "color-file-css",
        "color-file-db",
        "color-file-go",
        "color-file-graphql",
        "color-file-html",
        "color-file-image",
        "color-file-java",
        "color-file-js",
        "color-file-json",
        "color-file-lock",
        "color-file-md",
        "color-file-node",
        "color-file-node-foreground",
        "color-file-node-hover",
        "color-file-php",
        "color-file-py",
        "color-file-react",
        "color-file-rs",
        "color-file-sass",
        "color-file-sh",
        "color-file-svelte",
        "color-file-svg",
        "color-file-toml",
        "color-file-ts",
        "color-file-vue",
        "color-file-xml",
        "color-file-yaml",
        "color-git-added",
        "color-git-deleted",
        "color-git-descendant",
        "color-git-ignored",
        "color-git-modified",
        "color-git-none",
        "color-git-renamed",
        "color-git-untracked",
        "color-hover",
        "color-plugin-node",
        "color-plugin-node-foreground",
        "color-plugin-node-hover",
        "color-selected",
        "color-session-node",
        "color-session-node-foreground",
        "color-session-node-hover",
        "color-skill-node",
        "color-skill-node-foreground",
        "color-skill-node-hover",
        "color-subagent-node",
        "color-subagent-node-foreground",
        "color-subagent-node-hover",
        "color-surface",
        "color-surface-hover",
        "color-usage-chart-1",
        "color-usage-chart-2",
        "color-usage-chart-3",
        "color-usage-chart-4",
        "color-usage-chart-5",
        "color-usage-chart-6",
        "color-usage-heatmap-0",
        "color-usage-heatmap-1",
        "color-usage-heatmap-2",
        "color-usage-heatmap-3",
        "color-usage-heatmap-4",
        "color-workflow-rule",
        "color-workflow-trace",
        "color-workflow-trace-strong",
      ],
      /* EMPTY: the ramp (@theme owns the light-safe reading, see the note above) and
       * nothing else. A non-empty list here would pull the reading into
       * themeTokens.test.ts's per-palette ramp gate, which is the dark block's business. */
      extraBeyondDefault: [],
      declaredCount: 89,
    },

    /* ══════════════════════════════════════ DARK — wave ════════════════════════
     * Six published rungs plus the scheme's own selected-item step, and the ladder is
     * STRICTLY ASCENDING as a dark reading must be. What it costs is stated in the CSS
     * block and repeated in the concession below: the published hops are tight, and the
     * first one is 1.0203. */
    dark: {
      mode: "dark",
      ladderGroups: [
        {
          label:
            "the deepest AND the recessed plane — bg_m3 (sumiInk0): the terminal's paper, the borderless cards INSIDE the slab (they carry no borders, so sitting below their container is the only thing that makes them cards), the popover header, and the chrome band the islands sit in. themes.lua calls this step ui.float.bg; this app puts its floats FOUR rungs higher (bg_p1, one rung above the slab), so #16161d stays the floor rather than becoming the float step",
          tokens: [
            "color-frame",
            "color-panel",
            "color-terminal-bg",
            "color-popover-header",
          ],
        },
        {
          label:
            "the page plane AND the composer island — bg_m2 (sumiInk1), which is themes.lua's own ui.bg_dim",
          tokens: ["color-background", "color-composer"],
        },
        {
          label:
            "the recessed CONTROLS — bg_m1 (sumiInk2), one step above the page so a field reads as a field without its border doing the work (border is 2.36 here and would not carry one)",
          tokens: ["color-input", "color-input-focused"],
        },
        {
          label:
            "the CONTENT SLAB and the inspector, plus the active tab showing through the chrome — bg (sumiInk3), the scheme's own default background, taken literally rather than mixed so the ladder can grade it",
          tokens: ["color-chat", "color-inspector", "color-tab-active"],
        },
        {
          label:
            "every FLOAT and the window's alternate step — bg_p1 (sumiInk4), the README's 'Lighter background (colorcolumn, folds)' and themes.lua's ui.bg_gutter. 1.1556 above the slab, which is what a float needs; the float step is NOT the slab step here, so unlike Dracula this palette has no 1.00 slab/float collision to price",
          tokens: [
            "color-header",
            "color-background-win-alt",
            "color-tab",
            "color-menu",
            "color-popover",
            "color-toast",
            "color-tooltip",
          ],
        },
        {
          label:
            "RAISED — bg_p2 (sumiInk5), the README's cursorline rung. card, the badges, the inline-code chip, menu hover and the context bar's track. secondary/tag/tooltip-tag are HERE because a bg-secondary badge lands inside a bg-menu float and must read as raised over it; this is the group default-light structurally cannot share, where the same three tokens are the DARKEST step",
          tokens: [
            "color-card",
            "color-secondary",
            "color-tag",
            "color-tooltip-tag",
            "color-menu-hover",
            "color-context-track",
          ],
        },
      ],
      /* THE PUBLISHED HOPS, measured (this is the concession the plan asks for, and it
       * is recorded rather than engineered away):
       *
       *   #16161d -> #181820   1.0203   #1f1f28 -> #2a2a37   1.1556
       *   #181820 -> #1a1a22   1.0205   #2a2a37 -> #363646   1.1941
       *   #1a1a22 -> #1f1f28   1.0577   selection #2d4f67 vs raised  1.3682
       *
       * slabFloatSeparation.test.ts grades slab/float separation against a floor its
       * own comment says is 1.2, not 1.3, and the FIRST TWO HOPS FALL UNDER IT. That is
       * a real concession with a real reason, not gate-loosening: the pairs it fails
       * between are the chrome band against the page (1.0203) and the page against the
       * recessed control well (1.0205), and NEITHER is the slab/float pair that floor
       * exists to grade. Every pair that must read by fill does clear — slab against
       * float 1.1556, raised card against slab 1.3798, context track against the pane it
       * rides 1.3798. The alternative was to invent a hex to clear 1.2 between sumiInk0
       * and sumiInk1, which would no longer be Kanagawa; the scheme's three deepest
       * rungs differ by about two percent and that IS the scheme. What those three
       * planes are separated by instead is layout and the shadow a float wears, which is
       * precisely why slabFloatSeparation reads the float components themselves. */
      selectionRule: "strictly-above-all",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      /* EMPTY. Every surface token this block declares is a plane and is classified
       * above, including `--color-context-track` — which is NOT the alias Default uses
       * (Default's track aliases a TEXT token and so is exempt there), it is a literal
       * step on this palette's own ladder, chosen so the track separates from the pane
       * it rides. A stale exemption fails, so this stays empty deliberately. */
      ladderExemptions: {},
      textSurfaces: {
        /* Six resting planes, not two: the page, the slab, two floats, the recessed
         * column and the control well. `panel` and `input` belong to the resting class
         * rather than the raised one because they are BELOW the page — and because
         * `panel` is the surface the borderless cards and the code-block header actually
         * paint on, so a floor that graded only the page would report a number no pixel
         * of copy ever sees. */
        resting: [
          "color-background",
          "color-chat",
          "color-popover",
          "color-tooltip",
          "color-panel",
          "color-input",
        ],
        raised: ["color-card", "color-menu-hover", "color-secondary", "color-tag"],
        selected: ["color-card-selected"],
      },
      /* One resting wall. Every other graded token clears 4.5 on all six resting planes
       * — including `destructive` at 4.71 on the float step, which is the number that
       * decided its hue (the scheme's own diag.error, samuraiRed #e82424, is 3.17
       * there). The wall is springViolet1, the README's designated "Light foreground":
       * 4.34 on the float step. Unlike `destructive`, this one HAD an out — the floor
       * is recorded as a choice, not as an impossibility, and the alternative is named
       * in the floor's own reason so the next reader can overrule it with the numbers
       * rather than re-deriving them. Carries expiresAt so the exemption dies if the
       * hue moves. */
      textFloors: {
        "color-foreground-subtlest": {
          floor: 4.3,
          reason:
            "worst resting reading: springViolet1 #938aa9 is 4.34 on the #2a2a37 float step (5.42 on the page, 5.31 on the control well, 5.02 on the slab, 5.53 on the recessed panel). It is the README's own 'Light foreground' — the scheme's designated de-emphasis value — and the Kanagawa clause asks 4.5, so this is a reported wall and not a pass. THE ALTERNATIVE IS NAMED, because it exists: springViolet2 #9cabca would clear 4.5 on every resting plane and the raised one (6.12 on the float, 5.13 on the raised card) and fails only on the selection step (3.75). It is not taken, for two reasons the next reader can check: it is this block's own --color-thinking-medium, so taking it here would print the same hex as a ramp LEVEL and themeTokens.test.ts convicts that by name (verified — it does), and it is the README's 'Brackets and punctuation', a syntax hue the scheme has already spent on code. Separation from --color-foreground-subtle is the weaker of the two arguments and is stated as a number, not leaned on: 1.26 for springViolet2 against 1.77 for springViolet1.",
          expiresAt: 4.5,
        },
      },
      /* Two walls on the raised step. `destructive` is the one the plan's 4.5 clause
       * cannot reach at ANY published value: peachRed #ff5d62 is the brightest
       * red-leaning hue the scheme puts to use for text (its own 'Standout specials 2 —
       * exception handling, return') and reaches 3.94 on #363646, and the semantic
       * alternative is worse, not better — diag.error samuraiRed is 2.66 there. So the
       * choice is the legible hue plus a pinned floor, and the FILL's ink improves
       * either way (#16161d on peachRed is 6.00). */
      raisedFloors: {
        "color-foreground-subtlest": {
          floor: 3.6,
          reason:
            "the raised step #363646 (card, menu hover, badges, the inline-code chip): springViolet1 reaches 3.64 there. Graded separately from the resting wall because a merged table would make the expiry ratchet fire on the class the exemption is not about.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.9,
          reason:
            "the raised step #363646: peachRed #ff5d62 reaches 3.94 there. It IS the brightest red-leaning value the scheme uses for text — diag.error samuraiRed #e82424 is 2.66 on the same surface and autumnRed #c34043 is 2.33 — so no published Kanagawa red clears 4.5 on the raised step, and this is the clause's wall, not a value that could be improved. The error copy that lands here is on a card or a dropdown item, not the page, which is why the page's 5.88 is not the number that matters.",
          expiresAt: 4.5,
        },
      },
      /* THE SELECTION STATE IS THE WORST SURFACE IN THE PALETTE for a coloured hue, and
       * it is graded as its own class so a resting exemption cannot be stretched to
       * cover it. #2d4f67 is waveBlue2, the scheme's own 'Popup selection background,
       * search background', and it is the only published value that reads above every
       * resting rung — so it cannot also be a good ground for a green or a violet.
       * Nothing in this class was fixed by moving the selection: the alternatives were
       * waveBlue1 #223249, which is LUMINANCE-BELOW the raised card (0.0310 vs 0.0386)
       * and would sink, or an invented hex. */
      selectedFloors: {
        "color-foreground-subtlest": {
          floor: 2.6,
          reason:
            "springViolet1 reaches 2.66 on the selection step #2d4f67. A transient state, graded apart so the resting exemption cannot be stretched over it; the copy that renders selected is the row's own foreground (5.97 here), not its de-emphasis tier.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 2.85,
          reason:
            "peachRed reaches 2.88 on the selection step #2d4f67 — one rung above the raised step and therefore worse for a red-adjacent hue on a blue-adjacent ground. Same reasoning as the raised wall: no published value clears 4.5 here.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 3.95,
          reason:
            "springGreen #98bb6c reaches 3.98 on the selection step (5.45 on the raised step, 6.51 resting). It IS themes.lua's diag.ok and the scheme's 'Strings'; the brighter green lotus ships (lotusGreen3 #b7d0ae) is a wave-absent diff ground, not a wave hue.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 4.2,
          reason:
            "roninYellow #ff9e3b reaches 4.21 on the selection step (5.76 raised, 6.87 resting). It IS themes.lua's diag.warning, so this is the scheme's own value at its worst surface, not a substitution.",
          expiresAt: 4.5,
        },
      },
      /* EMPTY, and it is the assertion that this reading grades every graded token for
       * real. Kanagawa states every text reading as a literal hex (the scheme publishes
       * hexes, not Tailwind aliases), so unlike BOTH Default readings — whose
       * foreground family aliases Tailwind v4's `oklch()` scale, which has no hex
       * reading anywhere in this repo — there is nothing here the resolver cannot
       * reach. The kit fails any entry named in this map that really IS resolvable, so
       * an empty map is checked, not trusted. */
      textUngradeable: {},
      /* The SAME 54 Identity/overlay tokens Dracula inherits, for the SAME stated
       * reason (CONTEXT.md: a hue that encodes what kind of thing this is is never
       * re-hued by a palette — the usage/heatmap scales and context-breakdown steps whose
       * STEPS are the signal, the 8 git hues, the 18 role chips, the privacy hint, the 7
       * white overlays, the 2 wordmark tokens). They render differently from default dark,
       * which restates them by hand, and that is the rule working: untouched BY Kanagawa,
       * not preserved FROM the default palette. The 22 --color-terminal-* tokens are NOT
       * here because this block OWNS them — themes.lua publishes a term table, so copying
       * costs nothing and leaves no half-owned palette (ADR 0027 amendment 2, the same
       * basis Dracula states). The 25 file-type DESCRIPTORS are NOT here either: a DARK
       * reading must restate all 25 or it silently resolves through .dark to @theme's
       * light-safe reading — a DIFFERENT HUE, which is the real hazard, since the hue is
       * the whole signal. Measured rather than assumed: on the three planes
       * fileIconContrast.test.ts grades as `rendered` (page #181820, slab #1f1f28, panel
       * #16161d) all 25 light-safe readings clear the 3:1 glyph floor, so the restatement
       * is forced by the completeness rule and by identity, NOT by a contrast failure. Six
       * of them do fail on the raised card #363646 (file-css 2.27, file-py/file-ts 2.47,
       * file-sass/file-graphql 2.39, file-java 2.80) — and that surface is pinned
       * `forbidden` in that gate precisely so nothing may be allow-listed onto it, which is
       * why the code-block header sits on bg-panel. */
      inheritedFromDefault: [
        "animated-gradient-text-soft",
        "animated-gradient-text-strong",
        "color-command-node",
        "color-command-node-foreground",
        "color-command-node-hover",
        "color-context-breakdown-1",
        "color-context-breakdown-2",
        "color-context-breakdown-3",
        "color-context-breakdown-4",
        "color-context-breakdown-5",
        "color-context-breakdown-6",
        "color-context-breakdown-7",
        "color-feedback-privacy-hint",
        "color-file-node",
        "color-file-node-foreground",
        "color-file-node-hover",
        "color-git-added",
        "color-git-deleted",
        "color-git-descendant",
        "color-git-ignored",
        "color-git-modified",
        "color-git-none",
        "color-git-renamed",
        "color-git-untracked",
        "color-hover",
        "color-plugin-node",
        "color-plugin-node-foreground",
        "color-plugin-node-hover",
        "color-selected",
        "color-session-node",
        "color-session-node-foreground",
        "color-session-node-hover",
        "color-skill-node",
        "color-skill-node-foreground",
        "color-skill-node-hover",
        "color-subagent-node",
        "color-subagent-node-foreground",
        "color-subagent-node-hover",
        "color-surface",
        "color-surface-hover",
        "color-usage-chart-1",
        "color-usage-chart-2",
        "color-usage-chart-3",
        "color-usage-chart-4",
        "color-usage-chart-5",
        "color-usage-chart-6",
        "color-usage-heatmap-0",
        "color-usage-heatmap-1",
        "color-usage-heatmap-2",
        "color-usage-heatmap-3",
        "color-usage-heatmap-4",
        "color-workflow-rule",
        "color-workflow-trace",
        "color-workflow-trace-strong",
      ],
      /* The 6 RAMP tokens. They live in `.dark` + @theme and this block RE-HUES them,
       * which is what pulls the reading into themeTokens.test.ts's per-palette ramp gate
       * (mutually distinct, ordered cool to hot, and never printing the same hex as any
       * other UI-meaningful token in the block — that gate's allow-list is EMPTY, so a new
       * collision fails by name and a stale exemption fails as stale). */
      extraBeyondDefault: [
        "color-caution",
        "color-thinking-high",
        "color-thinking-low",
        "color-thinking-max",
        "color-thinking-medium",
        "color-thinking-xhigh",
      ],
      declaredCount: 120,
    },
  },
};
