import {
  SURFACE_TOKEN_PATTERN,
  type PaletteMode,
  type PaletteSpec,
} from "../paletteSpec";

/**
 * The published hex set, transcribed from the official specification —
 * https://catppuccin.com/palette, cross-checked against the machine-readable
 * `palette.json` in `catppuccin/palette` (v1.8.0), which carries the same values
 * as hex/RGB/HSL/OKLCH. Both flavors publish EXACTLY 26 colours; 25 of the 26
 * NAMES are shared between Mocha and Latte but NO HEX is (the two flavours share
 * a vocabulary, not a value — measured: the intersection of the two tables is
 * empty), so the two flavours
 * together publish 52 distinct hexes and this row allows both (the kit grades
 * the PALETTE, not the reading, so one set is right — but that pooling is exactly
 * why a reading CAN wear the other flavour's colour and pass the hex gate: the
 * ladder and the floors may or may not notice. `catppuccinPalette.test.ts` owns
 * that property and grades it per reading — see `flavourHexes`, which exists
 * because a Mocha Sky once sat in the Latte block with every gate green).
 *
 * Nothing here comes from a community `.json` dump or an editor port. That is
 * the exact failure ADR 0027 records for Dracula: the first `.theme-dracula-dark`
 * was transcribed from `pi-dracula`, a legacy port that labels `#44475a`
 * "currentLine" when the spec says Current Line is `#6272a4`, and reading the
 * label literally made the selection colour the app's border colour at 1.56:1.
 * Catppuccin has the same trap available — its `catppuccin/vim`,
 * `catppuccin/nvim` and `catppuccin/terminal` repositories each re-label these
 * 26 colours for their own surfaces — so the flavour tables above are the only
 * source of hexes in `src/styles/catppuccin.css`, and everything the style guide
 * gives instead of a hex (the ANSI brights, the semantic mixes) is recorded as a
 * FORMULA and derived, not recalled. See `ansiBright` in the CSS header.
 */
const MOCHA = {
  rosewater: "#f5e0dc",
  flamingo: "#f2cdcd",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  maroon: "#eba0ac",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  sapphire: "#74c7ec",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
} as const;

const LATTE = {
  rosewater: "#dc8a78",
  flamingo: "#dd7878",
  pink: "#ea76cb",
  mauve: "#8839ef",
  red: "#d20f39",
  maroon: "#e64553",
  peach: "#fe640b",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  sky: "#04a5e5",
  sapphire: "#209fb5",
  blue: "#1e66f5",
  lavender: "#7287fd",
  text: "#4c4f69",
  subtext1: "#5c5f77",
  subtext0: "#6c6f85",
  overlay2: "#7c7f93",
  overlay1: "#8c8fa1",
  overlay0: "#9ca0b0",
  surface2: "#acb0be",
  surface1: "#bcc0cc",
  surface0: "#ccd0da",
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
} as const;

/**
 * The two flavours' hex sets, KEPT SEPARATE, for the one property
 * `publishedHexes` cannot express.
 *
 * `PaletteSpec.publishedHexes` is per-PALETTE (see its doc-comment in
 * `paletteSpec.ts`), so the kit's hex gate pools Mocha and Latte and can only ask
 * "is this a Catppuccin hex?". A reading can therefore wear the OTHER flavour's
 * colour and pass every gate — which is not hypothetical: Latte's
 * `--color-find-highlight` carried Mocha's Sky `#89dceb` while every other
 * declaration in that block is Latte's own, and the full shared sweep was green
 * with it in place, because `#89dceb` IS published — just not by Latte.
 *
 * The kit cannot own this check, because the contract gives it no per-reading
 * value set to grade against — so it lives HERE, derived from the tables above
 * rather than hand-copied, which is what keeps it from drifting.
 */
export const flavourHexes: Record<PaletteMode, readonly string[]> = {
  dark: Object.values(MOCHA),
  light: Object.values(LATTE),
};

/**
 * The 24 off-spec descriptors, excused ONE BY ONE with the figure that excuses
 * each, because the allow-list is the review surface: a reader must be able to
 * see WHICH token is excused and WHY, and an entry that excuses a whole family is
 * how an allow-list stops meaning anything (Dracula's 24-entry list is the
 * precedent this copies, and `paletteSpec.ts` says so in terms).
 *
 * THE SHARED REASON, stated once here rather than pasted 24 times: Catppuccin
 * publishes 26 colours of which **14 are accents**, and there are 25 file types,
 * so the accent set cannot name them all — 14 hues cannot cover 25 types without
 * at least 11 shared hues by the pigeonhole principle. Re-huing the descriptors to
 * the spec set would therefore force collisions inside the descriptor set itself,
 * and the hue is the ONLY thing distinguishing a `.py` chip from a `.json` one. So
 * this is the **Identity color** rule (`CONTEXT.md`) knowingly outranking the style
 * guide's "use exact color values from this specification".
 *
 * Each entry below then carries what is TRUE OF THAT TOKEN: its own hex, its own
 * worst measured ratio across the four planes of the dark reading, and — for the 8
 * descriptors that share a hue with a sibling — the fact that the collision is
 * `.theme-default-dark`'s own and is inherited verbatim rather than introduced
 * here. `file-css` is the one descriptor NOT listed: it takes this palette's Mauve,
 * a published hue, so it needs no exception (see departure 4 in the CSS header).
 *
 * Mocha's pastel accents buy one real advantage over Dracula here: every restated
 * descriptor clears the 3:1 non-text floor on every plane of the dark reading
 * (worst `file-ts`/`file-py` 3.26 on the raised `#313244`, 4.25 on the slab, 4.55
 * on the page, 4.86 on the chrome). The restatement is nonetheless forced by the
 * COMPLETENESS rule and not by a legibility failure: a dark reading that omits a
 * descriptor silently resolves through `.dark` to `@theme`'s light-safe hue, which
 * is a different colour and, on the raised step, puts six tokens under 3:1.
 *
 * The LATTE reading inherits those light-safe readings deliberately and pays for
 * it — 19 of the 25 fall under 3:1 on its Crust panel, which is where the
 * code-block header renders. That wall is measured and explained at the foot of
 * the light block in `src/styles/catppuccin.css`, because no gate grades a light
 * reading's own planes. Not one descriptor is re-hued away from the default
 * palette's: the hues ARE the signal, so a palette must not move them.
 */
const offSpecAllowList: Record<string, string> = {
  // TS #0288d1 — worst 3.26 (raised #313244), shares its hue with py
  "color-file-ts":
    "#0288d1 copied verbatim from .theme-default-dark; worst reading 3.26 on raised #313244, clearing the 3:1 non-text floor. Shares #0288d1 with the `py` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
  // REACT #00bcd4 — worst 5.47 (raised #313244)
  "color-file-react":
    "#00bcd4 copied verbatim from .theme-default-dark; worst reading 5.47 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // JS #ffca28 — worst 8.22 (raised #313244), shares its hue with db
  "color-file-js":
    "#ffca28 copied verbatim from .theme-default-dark; worst reading 8.22 on raised #313244, clearing the 3:1 non-text floor. Shares #ffca28 with the `db` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
  // JSON #f9a825 — worst 6.38 (raised #313244)
  "color-file-json":
    "#f9a825 copied verbatim from .theme-default-dark; worst reading 6.38 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // HTML #e65100 — worst 3.32 (raised #313244)
  "color-file-html":
    "#e65100 copied verbatim from .theme-default-dark; worst reading 3.32 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // SASS #ec407a — worst 3.34 (raised #313244), shares its hue with graphql
  "color-file-sass":
    "#ec407a copied verbatim from .theme-default-dark; worst reading 3.34 on raised #313244, clearing the 3:1 non-text floor. Shares #ec407a with the `graphql` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
  // MD #42a5f5 — worst 4.75 (raised #313244)
  "color-file-md":
    "#42a5f5 copied verbatim from .theme-default-dark; worst reading 4.75 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // RS #ff7043 — worst 4.58 (raised #313244), shares its hue with sh
  "color-file-rs":
    "#ff7043 copied verbatim from .theme-default-dark; worst reading 4.58 on raised #313244, clearing the 3:1 non-text floor. Shares #ff7043 with the `sh` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
  // PY #0288d1 — worst 3.26 (raised #313244), shares its hue with ts
  "color-file-py":
    "#0288d1 copied verbatim from .theme-default-dark; worst reading 3.26 on raised #313244, clearing the 3:1 non-text floor. Shares #0288d1 with the `ts` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
  // SH #ff7043 — worst 4.58 (raised #313244), shares its hue with rs
  "color-file-sh":
    "#ff7043 copied verbatim from .theme-default-dark; worst reading 4.58 on raised #313244, clearing the 3:1 non-text floor. Shares #ff7043 with the `rs` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
  // YAML #ff5252 — worst 3.94 (raised #313244)
  "color-file-yaml":
    "#ff5252 copied verbatim from .theme-default-dark; worst reading 3.94 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // TOML #cfd8dc — worst 8.69 (raised #313244)
  "color-file-toml":
    "#cfd8dc copied verbatim from .theme-default-dark; worst reading 8.69 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // LOCK #ffd54f — worst 8.91 (raised #313244)
  "color-file-lock":
    "#ffd54f copied verbatim from .theme-default-dark; worst reading 8.91 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // IMAGE #26a69a — worst 4.19 (raised #313244)
  "color-file-image":
    "#26a69a copied verbatim from .theme-default-dark; worst reading 4.19 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // SVG #ffb300 — worst 7.00 (raised #313244)
  "color-file-svg":
    "#ffb300 copied verbatim from .theme-default-dark; worst reading 7.00 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // ARCHIVE #afb42b — worst 5.62 (raised #313244)
  "color-file-archive":
    "#afb42b copied verbatim from .theme-default-dark; worst reading 5.62 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // GO #00acc1 — worst 4.59 (raised #313244)
  "color-file-go":
    "#00acc1 copied verbatim from .theme-default-dark; worst reading 4.59 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // VUE #41b883 — worst 5.03 (raised #313244)
  "color-file-vue":
    "#41b883 copied verbatim from .theme-default-dark; worst reading 5.03 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // SVELTE #ff5722 — worst 3.97 (raised #313244)
  "color-file-svelte":
    "#ff5722 copied verbatim from .theme-default-dark; worst reading 3.97 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // JAVA #f44336 — worst 3.41 (raised #313244)
  "color-file-java":
    "#f44336 copied verbatim from .theme-default-dark; worst reading 3.41 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // PHP #1e88e5 — worst 3.42 (raised #313244)
  "color-file-php":
    "#1e88e5 copied verbatim from .theme-default-dark; worst reading 3.42 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // XML #8bc34a — worst 5.99 (raised #313244)
  "color-file-xml":
    "#8bc34a copied verbatim from .theme-default-dark; worst reading 5.99 on raised #313244, clearing the 3:1 non-text floor. Unique within the descriptor set, so this chip is distinguishable by hue alone.",
  // GRAPHQL #ec407a — worst 3.34 (raised #313244), shares its hue with sass
  "color-file-graphql":
    "#ec407a copied verbatim from .theme-default-dark; worst reading 3.34 on raised #313244, clearing the 3:1 non-text floor. Shares #ec407a with the `sass` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
  // DB #ffca28 — worst 8.22 (raised #313244), shares its hue with js
  "color-file-db":
    "#ffca28 copied verbatim from .theme-default-dark; worst reading 8.22 on raised #313244, clearing the 3:1 non-text floor. Shares #ffca28 with the `js` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here.",
};


/**
 * Catppuccin's grading row (Mocha = dark, Latte = light).
 *
 * The shape is Dracula's (`src/lib/palettes/dracula.ts` is the model row); the
 * VALUES are Catppuccin's, from https://catppuccin.com/palette only. Three
 * things make this row different in kind rather than in colour:
 *
 * - **TWO readings, so the mode is live.** ADR 0104: a Palette ships a reading
 *   per mode. Catppuccin ships one light and one dark flavour of the SAME 26
 *   colour names, which is the cleanest case the registry can hold.
 * - **The seam property, reproduced from a different theme.** ADR 0096 chose
 *   Dracula's `--color-card-border` `#21222c` because it is the exact per-channel
 *   midpoint of `#191a21` ↔ `#282a36` AND is itself spec-published. For Mocha the
 *   midpoint of `#11111b` (Crust) and `#1e1e2e` (Base) is **`#181825` (Mantle)** —
 *   also published. See the CSS header; this is why `--color-card-border` is a
 *   literal here instead of the `var(--color-border)` alias every other reading
 *   carries.
 * - **Latte's ladder runs the other way from every dark reading, and the shared
 *   gate expects that.** In luminance the flavour ascends
 *   `surface2 < surface1 < surface0 < crust < mantle < base`, so the app's
 *   `frame` takes a DARKER published grey than its page and `card` plateaus on
 *   `base`. ADR 0105: light ladders are non-decreasing with the top group allowed
 *   to plateau. Nothing is invented to fix it; the theme's own semantics (Crust =
 *   "the deepest", Base = "the page") are visibly overridden, and the CSS says so
 *   with the luminances next to the declarations.
 */
export const spec: PaletteSpec = {
  id: "catppuccin",
  cssFile: "src/styles/catppuccin.css",
  baseCssFile: "src/styles/theme.css",
  specSourceUrl: "https://catppuccin.com/palette",
  publishedHexes: [...Object.values(MOCHA), ...Object.values(LATTE)],
  offSpecAllowList,
  modes: {
    light: {
      mode: "light",
      // FIVE rungs from the flavour's six neutrals: Surface 2 `#acb0be` is used
      // by NOTHING, because it is Latte's darkest neutral and no text token the
      // app paints clears the 4.5 text floor on it — the body colour reaches only
      // 3.69 and both de-emphasis steps fall under the 3:1 non-text floor (Text
      // 3.69, Subtext 1 2.89, Subtext 0 2.28). A step nothing can sit on and
      // nothing can be graded against is not
      // an elevation step, so the reading is one rung shorter than Mocha's rather
      // than one rung wider than it can defend.
      //
      // The order is NOT the theme's naming order and that is the point. Latte's
      // `crust` (#dce0e8, L 0.7435) is DARKER than its `base` (#eff1f5, L 0.8785),
      // so a light flavour's "deepest" neutral is a mid-tone and its "page" is
      // the LIGHTEST value the flavour publishes. Hence `frame`/`panel` take the
      // darker published greys, the top group PLATEAUS on `base`, and
      // `--color-card-border` is Mantle — the exact per-channel midpoint of the
      // Crust column and the Base slab, which is ADR 0096's seam property
      // arriving from Latte's own table. ADR 0105: non-decreasing, plateau allowed
      // at the top group. Nothing is invented to make the ladder look symmetric.
      ladderGroups: [
        {
          label:
            "Surface 1 — the recessed chips (badge fill, inline-code chip, tooltip tag): the DARKEST step a light reading uses, the inverse of Mocha where these are the raised step (ADR 0105's group-membership inversion, the same shape as `default-light`'s `#e6e6e6`). Surface 2 `#acb0be` is deliberately NOT used as a surface: it is the flavour's darkest neutral and no text token clears the 4.5 text floor on it — the body colour reaches only 3.69 and both de-emphasis steps fall under the 3:1 non-text floor outright (`Subtext 1` 2.89, `Subtext 0` 2.28)",
          tokens: ["color-secondary", "color-tag", "color-tooltip-tag"],
        },
        {
          label:
            "Surface 0 — the chrome band the islands sit in, the inactive tab strip, the menu hover and the tooltip. A light chrome reads by being DARKER than the page, which is why `frame` takes a published grey BELOW it rather than the flavour's `crust`",
          tokens: [
            "color-frame",
            "color-tab",
            "color-menu-hover",
            "color-tooltip",
          ],
        },
        {
          label:
            "Crust — the theme's own 'secondary panes' step, which in a LIGHT flavour is a mid-tone: the cards INSIDE the slab (they carry no borders, so recessing below the slab is what makes them cards), the popover header, the column's backdrop and the terminal's paper",
          tokens: [
            "color-panel",
            "color-popover-header",
            "color-background-win-alt",
            "color-terminal-bg",
          ],
        },
        {
          label:
            "Mantle — the PAGE plane and the composer island. `--color-card-border` carries this same value (the exact per-channel midpoint of the Crust column and the Base slab — ADR 0096's seam property, arriving from Latte's table), but it is a SEAM and not an elevation step, so it is not named here",
          tokens: ["color-background", "color-composer"],
        },
        {
          label:
            "Base — the flavour's LIGHTEST published value, so the slab, every float, every form control and every card PLATEAU here (ADR 0105's ceiling: no light theme publishes anything lighter than its own Base). Separation inside this group is carried by `--color-card-border` and by a float's shadow, never by an invented lighter grey — which is the one place this reading is knowingly flatter than the theme's own naming would suggest",
          tokens: [
            "color-chat",
            "color-inspector",
            "color-header",
            "color-card",
            "color-input",
            "color-input-focused",
            "color-menu",
            "color-popover",
            "color-tab-active",
            "color-toast",
          ],
        },
      ],
      // Nothing in a light flavour is lighter than Base, so the selection state
      // plateaus with the card instead of rising above it — ADR 0105's rule for
      // every light reading, and the same one `default-light` uses.
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {
        // The context bar's track is an ALIAS of a TEXT token, so it is not an
        // elevation step and composites against whatever the pane behind it
        // wears. The role split `paletteCompleteness.test.ts` documents; the same
        // exemption `default-light` names.
        "color-context-track":
          "aliases --color-foreground-subtlest (a TEXT token); the role split makes it not an elevation step",
      },
      textSurfaces: {
        // The four planes copy lands on, chosen so the WORST is graded: the page
        // (Mantle), the slab (Base — the lightest plane, and the one the app's
        // most-used tokens paint), the chrome band (Surface 0, the darkest light
        // surface; chrome carries copy, so grading only the page would report a
        // floor the app never renders) and a float.
        resting: [
          "color-background",
          "color-chat",
          "color-frame",
          "color-popover",
        ],
        // The RAISED class means "a chip or a badge sits ON this", not "this
        // moves up": in a light reading those three are the DARKEST step, which
        // is precisely ADR 0105's measurement about group membership.
        raised: ["color-secondary", "color-tag", "color-menu-hover"],
        // EMPTY, and it is a measurement rather than an omission:
        // `--color-card-selected` is `base`, the very same `#eff1f5` the resting
        // class already grades through `color-chat`/`color-popover`. Re-listing
        // it would restate a hex already measured and force a second copy of
        // every floor to agree with the first. The selection STATE is still
        // graded — by `selectionRule` above.
        selected: [],
      },
      // Latte is a LIGHT flavour, so its accents are DARK by design and the
      // flavour publishes exactly ONE hue per role. Every floor below is the
      // measured worst reading in its class, computed by the kit's own
      // `lumOf`/`contrast` on the surfaces named above — and every one carries
      // `expiresAt`, so no exemption can outlive its reason. This is the same
      // shape `default-light` records on its `#e6e6e6` chip step (warning 2.40,
      // success 3.53, destructive 3.62): a light Catppuccin has these walls, it
      // is not a transcription error. The three COPY tokens are pinned too, so a
      // future re-hue that loses their margin fails BY NAME instead of quietly
      // landing one notch lower.
      textFloors: {
        "color-foreground": {
          floor: 5.1,
          reason:
            "worst resting reading: Text #4c4f69 is 5.17 on the #ccd0da chrome band (6.57 on the #e6e9ef page, 7.06 on the #eff1f5 slab). Pinned below its measured value so a re-hue that loses the margin fails by name.",
          expiresAt: 6.5,
        },
        "color-foreground-subtle": {
          floor: 4.0,
          reason:
            "worst resting reading: Subtext 1 #5c5f77 is 4.05 on the #ccd0da chrome band (5.14 on the page, 5.53 on the slab). The flavour's own label step, one hair under 4.5 on the darkest plane it is used on.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 3.1,
          reason:
            "worst resting reading: Subtext 0 #6c6f85 is 3.20 on the #ccd0da chrome band (4.06 on the page, 4.37 on the slab). Raising it would collapse it onto `foreground-subtle` (4.05 vs 5.14 on the band already separate by only 1.26), and a de-emphasis token that does not de-emphasise is the worse bug.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.5,
          reason:
            "worst resting reading: Red #d20f39 is 3.52 on the #ccd0da chrome band (4.46 on the page, 4.80 on the slab). `text-destructive` is the app's most-used status text (60 uses in `src/components/` + `App.tsx`, tests excluded, against `text-warning` 21 and `text-success` 11). Latte publishes one Red and one Maroon, and Maroon #e64553 is LIGHTER (L 0.2170 against Red's 0.1434, so only 2.55 on the band), so no published red clears 4.5 there.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 2.1,
          reason:
            "worst resting reading: Green #40a02b is 2.17 on the #ccd0da chrome band (2.75 on the page, 2.96 on the slab). The style guide assigns Success to Green outright and Latte publishes no darker green; `text-success` has 11 uses by the same count.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 1.6,
          reason:
            "worst resting reading: Yellow #df8e1d is 1.70 on the #ccd0da chrome band (2.15 on the page, 2.31 on the slab) — the worst reading of the whole Palette. Latte publishes ONE yellow and the style guide assigns Warnings to it; the darker candidate would be Peach #fe640b (L 0.3021 against Yellow's 0.3512, so 1.93 on the band), which is this reading's `caution`, so trading the hue for 0.23 makes a warning and a caution-indicator the same colour.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.1,
          reason:
            "worst resting reading: Peach #fe640b is 3.19 on the #ccd0da chrome band (4.05 on the page, 4.35 on the slab). `caution` paints the context bar's percentage LABEL, so it is held to a text floor and not the 3:1 glyph floor.",
          expiresAt: 4.5,
        },
      },
      raisedFloors: {
        // The class's worst surface is the Surface 1 chip step `#bcc0cc`
        // (L 0.5275) — the darkest plane in the reading, and the one a badge or
        // an inline-code chip actually lands on.
        "color-foreground": {
          floor: 4.3,
          reason:
            "the Surface 1 chip step #bcc0cc: Text #4c4f69 reaches 4.39 there (5.17 on the Surface 0 menu hover). Pinned so a re-hue that drops it under 4.3 fails by name.",
          expiresAt: 4.5,
        },
        "color-foreground-subtle": {
          floor: 3.4,
          reason:
            "the Surface 1 chip step #bcc0cc: Subtext 1 #5c5f77 reaches 3.44 there.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 2.7,
          reason:
            "the Surface 1 chip step #bcc0cc: Subtext 0 #6c6f85 reaches 2.72 there.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 2.9,
          reason:
            "the Surface 1 chip step #bcc0cc: Red #d20f39 reaches 2.99 there. `default-light` records 3.62 on its own chip step — the same class of wall on a different light palette.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 1.8,
          reason:
            "the Surface 1 chip step #bcc0cc: Green #40a02b reaches 1.84 there.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 1.4,
          reason:
            "the Surface 1 chip step #bcc0cc: Yellow #df8e1d reaches 1.44 there — the worst single reading in the whole Palette, and the reason `bg-secondary` badges carry their own foreground token rather than inheriting body copy colour.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 2.7,
          reason:
            "the Surface 1 chip step #bcc0cc: Peach #fe640b reaches 2.71 there.",
          expiresAt: 4.5,
        },
      },
      selectedFloors: {},
      // Latte states every graded text token as a literal hex or a single-colour
      // `color-mix` over one, so the resolver reaches ALL SEVEN. An empty map is
      // a real assertion: the kit fails any entry it names, and grading every
      // graded token is the point (unlike the Default palette, whose foreground
      // family aliases Tailwind's `oklch()` scale and cannot be reached).
      textUngradeable: {},
      // The 99 tokens `.theme-default-dark` declares that this reading does NOT
      // (of its 168 — 69 declared + 99 inherited = 168; the kit asserts both
      // directions, so the split is checked rather than recalled).
      // The same Identity-color families Mocha inherits — the usage/heatmap and
      // context-breakdown scales, the 8 git hues, the 18 role chips, the privacy
      // hint, the 2 gradient-wordmark tokens and the white overlays. The overlays
      // are inherited by BOTH readings rather than added here, and for a light
      // reading that is the CORRECT rendering, not a gap: a light reading inherits
      // `@theme` alone (no `.dark`), where the overlays read from
      // `--color-neutral-*` and darken rather than whiten. What this reading adds
      // to Mocha's 73 is 26 tokens: the 25 `--color-file-*` DESCRIPTORS, because
      // `.theme-default-light` — the reference's own light reading — declares only
      // the 3 `file-node*` role chips and none of the 25 descriptors, `@theme`
      // holds the light-safe descriptor readings, and a light block that restated
      // them would SHADOW that value for a classless document; plus
      // `--color-terminal-bright-blue`, which Mocha declares as an alias and this
      // reading leaves on `@theme`'s reading for the same shadowing reason.
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
        "color-terminal-black",
        "color-terminal-blue",
        "color-terminal-bright-black",
        "color-terminal-bright-blue",
        "color-terminal-bright-cyan",
        "color-terminal-bright-green",
        "color-terminal-bright-magenta",
        "color-terminal-bright-red",
        "color-terminal-bright-white",
        "color-terminal-bright-yellow",
        "color-terminal-cursor",
        "color-terminal-cursor-accent",
        "color-terminal-cyan",
        "color-terminal-fg",
        "color-terminal-green",
        "color-terminal-magenta",
        "color-terminal-red",
        "color-terminal-selection",
        "color-terminal-selection-inactive",
        "color-terminal-white",
        "color-terminal-yellow",
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

      // Nothing. The 6 RAMP tokens stay on `@theme`'s readings, exactly as
      // `.theme-default-light` leaves them: a light reading that stated them would
      // SHADOW `@theme`'s light-safe hues for a classless document, and Latte's
      // own accents are pastels-to-mid-tones that cannot form a five-level ramp
      // that is both mutually distinct and legible on a light plane (measured on
      // its own Base: Peach 2.64, Sapphire 2.78, Sky 2.47 — all below the 3:1
      // glyph floor). The ramp is the one
      // family this reading declines on purpose; see the CSS header.
      extraBeyondDefault: [],
      declaredCount: 69,
    },
    dark: {
      mode: "dark",
      // FOUR rungs, in the flavour's own luminance order — every one of them a
      // published neutral, none of them invented:
      //
      //   #11111b Crust      0.0060  the chrome FRAME, the cards inside the slab,
      //                              the recessed controls, the terminal's paper
      //   #181825 Mantle     0.0098  the PAGE plane and the composer island
      //   #1e1e2e Base       0.0140  the slab, the inspector and every float
      //   #313244 Surface 0  0.0335  raised: cards, badges, menu hover, the track
      //
      // Surface 1 `#45475a` is the SELECTION state and nothing else, and Surface 2
      // `#585b70` is unused as a surface: it is the flavour's brightest neutral,
      // so a card wearing it would out-shine the selection step, and three graded
      // text tokens fall under 4.5 on it (`foreground-subtlest` 3.00,
      // `destructive` 2.88, `success` 4.49). The style guide's Selection
      // Background is Overlay 2 at 20–30% — a WASH, and ADR 0105 refuses alpha on
      // a surface token — so the published wash goes on `--color-selected`, the
      // token whose whole job is a translucent row overlay, and
      // `--color-card-selected` takes Surface 1 so it stays a gradeable step.
      ladderGroups: [
        {
          label:
            "Crust (L 0.0060) — the deepest step: the chrome FRAME the islands sit in, the cards INSIDE the slab (they carry no borders, so sitting below the slab is the only thing that makes them cards), the recessed form controls and the popover header, and the terminal's paper. The style guide's 'Secondary Panes: Crust, Mantle' taken to its darkest reading",
          tokens: [
            "color-frame",
            "color-panel",
            "color-input",
            "color-input-focused",
            "color-popover-header",
            "color-terminal-bg",
          ],
        },
        {
          label:
            "Mantle (L 0.0098) — the PAGE plane and the composer island (the flavour's other 'secondary pane'; see the CSS header for why Base is the slab here and Mantle the page). `--color-card-border` carries this same value, but a SEAM is not an elevation step — it is this value BECAUSE it is the exact per-channel midpoint of the Crust column and the Base slab it joins, the property ADR 0096 picked Dracula's `#21222c` for — so it is not named in any group",
          tokens: ["color-background", "color-composer"],
        },
        {
          label:
            "Base (L 0.0140) — the CONTENT SLAB (transcript + inspector) and every float (header, tabs, menus, popovers, toasts, tooltips). Taken literally rather than as a `color-mix`, which is what puts the slab ON a rung the ladder can grade; the float-over-slab collision this buys is what `slabFloatSeparation.test.ts` prices",
          tokens: [
            "color-chat",
            "color-inspector",
            "color-background-win-alt",
            "color-header",
            "color-tab",
            "color-tab-active",
            "color-menu",
            "color-popover",
            "color-toast",
            "color-tooltip",
          ],
        },
        {
          label:
            "Surface 0 (L 0.0335) — RAISED: cards, the badge fill, the inline-code chip, menu hover and the context bar's track. `secondary`/`tag`/`tooltip-tag` are HERE and not inherited because a `bg-secondary` badge lands inside a `bg-menu` float and must read as raised above it — and all seven graded text tokens clear 4.5 on it (worst `foreground-subtlest` 5.65), so raising them costs nothing that Dracula's step-6 problem would have forced",
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
      // The style guide gives Selection a translucent Overlay 2 wash rather than a
      // step, so it is graded as a STATE that must not sink below the surface it
      // marks. Over the Base slab that wash composites to `#3b3d4f` (L 0.0483),
      // which sits above all four resting steps — Crust 0.0060, Mantle 0.0098,
      // Base 0.0140 and the raised Surface 0 at 0.0335 — and below Surface 1
      // `#45475a` (0.0651), the opaque step this reading puts on
      // `--color-card-selected`. That is the theme's own semantics (a wash over the
      // row, not an elevation), and the reason this reading does not claim
      // Dracula's "brightest thing I own" rule.
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {},
      textSurfaces: {
        // The page, the slab, a float, and the recessed well + chrome band.
        // `frame`/`input` are the deepest rung, so they belong with the resting
        // class rather than the raised one — and the island layout made the chrome
        // a surface that carries copy (the sidebar's section headers, the session
        // rows), so grading only the page would report a floor the app never
        // renders.
        resting: [
          "color-background",
          "color-chat",
          "color-popover",
          "color-frame",
          "color-input",
        ],
        // `color-card` is in the raised class even though it IS the raised step:
        // a card's own copy lands on it, and the class means "the plane a chip or
        // a card sits on", not "one step above the page".
        raised: [
          "color-card",
          "color-menu-hover",
          "color-secondary",
          "color-tag",
        ],
        selected: ["color-card-selected"],
      },
      // Mocha's accents are pastels: all seven graded text tokens clear 4.5 on
      // EVERY resting surface (worst `foreground-subtlest` 7.37 on the slab) and
      // on every raised one (worst 5.65 on the card). So `textFloors` and
      // `raisedFloors` are EMPTY, and that is a measurement rather than an
      // omission — the point of grading the resting and raised classes at all is
      // that a Palette needing an exemption there has a different problem from
      // one needing one on a transient. Dracula's `destructive` 4.33-on-the
      // raised-step wall has no Catppuccin counterpart: the brightest red this
      // flavour publishes, `#f38ba8`, is a pastel and reaches 5.43 on Surface 0.
      textFloors: {},
      raisedFloors: {},
      // THE ONE WALL IN THE DARK READING. `--color-card-selected` is Surface 1
      // `#45475a` — the flavour's next step above the card, and the only token
      // wearing it — and two tokens fall under 4.5 there, because Mocha's
      // de-emphasis grey and its Red sit close to Surface 1's luminance:
      //   `foreground-subtlest` Subtext 0 #a6adc8   4.10
      //   `destructive`         Red      #f38ba8    3.94
      // The flavour publishes nothing between Subtext 0 (4.10) and Subtext 1
      // (5.15), and Subtext 1 IS this reading's `foreground-subtle` — collapsing
      // the two de-emphasis levels into one is the worse bug. For `destructive`,
      // Maroon `#eba0ac` reaches 4.41 there, still short, and Catppuccin publishes
      // no bright row to climb to (Dracula's escape was its ANSI brights). Both
      // carry the measured number and `expiresAt: 4.5`, so a flavour revision
      // that lifts them deletes the exemption by itself.
      selectedFloors: {
        "color-foreground-subtlest": {
          floor: 4.0,
          reason:
            "Subtext 0 #a6adc8 is 4.10 on the selection step #45475a (7.89 on the Mantle page, 7.37 on the Base slab, 5.65 on the raised card). The flavour's next step up, Subtext 1, is already this reading's `foreground-subtle`; collapsing the two de-emphasis levels to one is the worse bug, and a selection state is transient.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.9,
          reason:
            "Red #f38ba8 is 3.94 on the selection step #45475a (5.43 on the raised card, 7.58 on the Mantle page, 7.08 on the Base slab). Mocha publishes one Red and one Maroon, and Maroon #eba0ac reaches 4.41 there — still short. No published value clears 4.5 on Surface 1, and `text-destructive` is the app's most-used status text (60 uses in `src/components/` + `App.tsx`, tests excluded).",
          expiresAt: 4.5,
        },
      },
      // Mocha states all seven graded text tokens as a literal hex or a
      // single-colour `color-mix` over one, so the resolver reaches every one.
      textUngradeable: {},
      // The 73 tokens `.theme-default-dark` declares that this block deliberately
      // does NOT (its 168 split as 95 restated + 73 inherited; the kit asserts both
      // directions, so the split is measured and not recalled). Counted from the
      // list below rather than from memory: the 11 usage scales and 7
      // context-breakdown steps whose STEPS are the signal, the 8 git hues, the 18
      // role chips, the privacy hint, the 3 workflow tokens, the 2
      // gradient-wordmark tokens, the 3 luminance overlays (`hover`, `surface`,
      // `surface-hover` — luminance rather than hue, so they read correctly on any
      // dark plane), and the 20 `--color-terminal-*` tokens named further down.
      // The families are exactly the ones Dracula inherits.
      //
      // The 25 `--color-file-*` DESCRIPTORS are NOT here: a dark reading that
      // omits one silently resolves through `.dark` to `@theme`'s light-safe hue,
      // so this block restates all 25 (allow-listed off-spec, per the note above).
      // 20 of the 22 `--color-terminal-*` tokens are NOT here either (the other 2,
      // `terminal-bg` and `terminal-bright-blue`, ARE declared by this block) — the
      // flavour
      // publishes no ANSI table of its own (the style guide GENERATES the brights
      // from a formula over the named colours), so owning them would mean writing
      // derived values into shipped CSS. See the CSS header for the derivation and
      // for why inheriting `.dark`'s generic ANSI set is the honest answer today:
      // the app has no terminal surface, so nothing renders these.
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
        "color-terminal-black",
        "color-terminal-blue",
        "color-terminal-bright-black",
        "color-terminal-bright-cyan",
        "color-terminal-bright-green",
        "color-terminal-bright-magenta",
        "color-terminal-bright-red",
        "color-terminal-bright-white",
        "color-terminal-bright-yellow",
        "color-terminal-cursor",
        "color-terminal-cursor-accent",
        "color-terminal-cyan",
        "color-terminal-fg",
        "color-terminal-green",
        "color-terminal-magenta",
        "color-terminal-red",
        "color-terminal-selection",
        "color-terminal-selection-inactive",
        "color-terminal-white",
        "color-terminal-yellow",
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
      // The 6 RAMP tokens, which live in `.dark` + `@theme` and which this Palette
      // re-hues (they were raw Tailwind hues in components, which no Palette can
      // move). Built from the flavour's six remaining accents — the ones no
      // structural or status token in this block wears — so the five levels are
      // mutually distinct, ordered cool → hot, collide with NO other
      // UI-meaningful token in the block (`themeTokens.test.ts` measures that with
      // an EMPTY allow-list), and are all published.
      extraBeyondDefault: [
        "color-caution",
        "color-thinking-high",
        "color-thinking-low",
        "color-thinking-max",
        "color-thinking-medium",
        "color-thinking-xhigh",
      ],
      declaredCount: 101,
    },
  },
};
