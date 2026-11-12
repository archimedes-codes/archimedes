import { SURFACE_TOKEN_PATTERN, type PaletteSpec } from "../paletteSpec";

/**
 * The 25 file-type DESCRIPTORS, in the order `paletteCompleteness.test.ts` lists
 * them. `file-node*` are NOT here — those are the file-row ROLE CHIP, and they
 * stay inherited.
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

/**
 * The one reason every descriptor is off-spec, spelled per token because the
 * allow-list is the review surface: a reader must be able to see WHICH token is
 * excused, and an entry that excuses a whole family is how an allow-list stops
 * meaning anything (Dracula's 24-entry list is the precedent this copies in
 * shape, with Rosé Pine's reason).
 *
 * Rosé Pine publishes TWELVE roles. There are twenty-five file types. Re-huing the
 * descriptors to the published set would make a `.py` chip indistinguishable from
 * a `.json` one, and the hue is the ONLY thing that distinguishes them — so this
 * is the **Identity color** rule (`CONTEXT.md`) knowingly outranking the
 * specification's own "use exact color values". `file-css` needs no exemption:
 * this row reads it `#c4a7e7`, which IS published `iris`. The Default palette's
 * `#7e57c2` is why it is re-read at all — 2.91 on this palette's raised step,
 * under the 3:1 glyph floor.
 */
const offSpecAllowList = Object.fromEntries(
  FILE_DESCRIPTORS.filter((token) => token !== "color-file-css").map((token) => [
    token,
    "file-type Identity hue copied from .theme-default-dark: Rosé Pine's 12 roles cannot name 25 file types and the hue IS the signal (CONTEXT.md's Identity color rule outranking the spec)",
  ]),
);

/**
 * Rosé Pine's grading row — `main` as the dark reading, `dawn` as the light one.
 *
 * THE PAIRING IS THE THEME'S OWN, not this app's choice: `dist/css/
 * rose-pine-media.css` serves `dawn` at `:root` and `main` under
 * `prefers-color-scheme: dark`. `moon` is a second dark and the registry has one
 * slot per mode, so it is not shipped.
 *
 * WHAT MAKES THIS ROW DIFFERENT FROM DRACULA'S, and the difference is the point of
 * ADR 0105 saying ladder facts are per-reading:
 *
 * - **Dark has FOUR resting rungs and light has SIX.** Rosé Pine publishes six
 *   dark neutrals but reserves `highlightHigh` for "cursor background, borders",
 *   so only four are resting steps in the dark reading; dawn, whose `surface` role
 *   is defined as "atop base", puts two neutrals above its page and gets a full
 *   six-rung ladder. One shared group table cannot express both.
 * - **The light ladder does NOT plateau.** ADR 0105's plateau comes from nothing
 *   in a light theme being lighter than its own Base; dawn escapes it on the
 *   strength of one role definition, and its ONE remaining collapse is the
 *   selection state, which is why `selectionRule` is `at-or-above-card` here and
 *   `strictly-above-all` in the dark reading.
 * - **The walls are all in the light reading except two.** Main clears 4.5 on
 *   every resting and raised plane it grades; dawn, whose darkest published ink
 *   is 6.66 on its own page, carries ten recorded floors. Both readings' floors
 *   carry `expiresAt: 4.5`, so no exemption outlives its reason.
 *
 * Every ratio in this file was computed with the kit's own `lumOf` / `contrast` /
 * `resolveToHex` against the two blocks in `src/styles/rose-pine.css`, and none is
 * quoted from another palette's figures.
 */
export const spec: PaletteSpec = {
  id: "rose-pine",
  cssFile: "src/styles/rose-pine.css",
  baseCssFile: "src/styles/theme.css",
  specSourceUrl: "https://rosepinetheme.com/palette",
  publishedHexes: [
    // Rosé Pine (main) — the 15 roles, from `rose-pine/palette` `source/index.ts`
    // and `dist/css/rose-pine-media.css`, cross-checked against the code blocks
    // rosepinetheme.com/palette generates.
    "#191724", // base          — primary background, main application panels
    "#1f1d2e", // surface       — low contrast background ATOP base
    "#26233a", // overlay       — medium contrast background ATOP surface
    "#6e6a86", // muted         — low contrast foreground
    "#908caa", // subtle        — medium contrast foreground
    "#e0def4", // text          — high contrast foreground
    "#eb6f92", // love          — terminal red, builtins, errors, git delete
    "#f6c177", // gold          — terminal yellow, strings, warnings
    "#ebbcba", // rose          — terminal cyan, booleans, git change
    "#31748f", // pine          — terminal green, functions, git rename
    "#9ccfd8", // foam          — terminal blue, object keys, info, git add
    "#c4a7e7", // iris          — terminal magenta, parameters, links, hints
    "#21202e", // highlightLow  — cursor line
    "#403d52", // highlightMed  — selection background (paired with text)
    "#524f67", // highlightHigh — cursor background, borders
    // Rosé Pine Dawn — the same 15 roles. Note dawn's `text`: the repository's
    // `source/index.ts` and `dist/json/*` publish `#575279`, while the site's own
    // generated dawn blocks publish `#464261`. Both are Rosé Pine's; the block
    // takes `#575279`, the machine-readable master and the WEAKER of the two on
    // dawn's base, so the walls below are recorded against the ink that forces
    // them. `#464261` is deliberately NOT in this list — nothing declares it, and
    // an entry no token uses is a free slot (the kit fails it).
    "#faf4ed", // base
    "#fffaf3", // surface
    "#f2e9e1", // overlay
    "#9893a5", // muted
    "#797593", // subtle
    "#575279", // text
    "#b4637a", // love
    "#ea9d34", // gold
    "#d7827e", // rose
    "#286983", // pine
    "#56949f", // foam
    "#907aa9", // iris
    "#f4ede8", // highlightLow
    "#dfdad9", // highlightMed
    "#cecacd", // highlightHigh
    // The `alpha` variants are published too (`highlightLow/Med/High.alpha.hex`):
    // main `6e6a861a` / `6e6a8633` / `6e6a8666`, dawn `6e6a860d` / `6e6a8614` /
    // `6e6a8626`. They are all `muted` at an alpha, so the 6-digit hex the kit
    // grades is `#6e6a86` above; the two this row uses (`#6e6a8633` in the dark
    // terminal, `#6e6a8614` in the light one) are therefore already on-spec.
    //
    // Deliberately ABSENT: `moon`'s fifteen values. The registry has one dark slot
    // and moon is a second dark, so no token in either block can carry one, and an
    // allow-list entry nothing uses licenses any future token to paint it.
  ],
  offSpecAllowList,
  modes: {
    dark: {
      mode: "dark",
      // Four resting rungs, and they are every rung the specification offers once
      // `highlightHigh` is taken literally as "cursor background, borders" rather
      // than promoted to a resting plane. The labels quote Rosé Pine's own role
      // names so a reader can trace each rung back to the role table.
      //
      // The hops are 1.071 / 1.029 / 1.056 — the three dark neutrals and the low
      // highlight sit within 0.01 luminance of one another, so the first three
      // rungs are barely separable by FILL. That is the specification's spacing,
      // not a rung assignment that could be improved: the six dark candidates are
      // `#191724 #1f1d2e #21202e #26233a #403d52 #524f67` and any four-rung use of
      // them walks the same hops. Separation here is carried by `--color-border`
      // (2.04 on the slab) and by the float shadows, which
      // `slabFloatSeparation.test.ts` pins.
      ladderGroups: [
        {
          label:
            "base — the page plane, the chrome band the islands sit in, the tab strip and the terminal's own paper (main's darkest published step, L 0.0095)",
          tokens: ["color-background", "color-frame", "color-terminal-bg", "color-tab"],
        },
        {
          label:
            "surface — the recessed step: the cards inside the slab, form controls, the popover header, the composer island as a well in the page (L 0.0137, 1.071 above base)",
          tokens: [
            "color-panel",
            "color-input",
            "color-input-focused",
            "color-popover-header",
            "color-composer",
          ],
        },
        {
          label:
            "highlightLow — the reading surface AND every float: the transcript slab, the inspector, the secondary window plane, the header, menus, popovers, toasts, tooltips, and the active tab as the sheet showing through the frame (the spec's cursor-line step, L 0.0155)",
          tokens: [
            "color-chat",
            "color-inspector",
            "color-background-win-alt",
            "color-header",
            "color-menu",
            "color-popover",
            "color-toast",
            "color-tooltip",
            "color-tab-active",
          ],
        },
        {
          label:
            "overlay — RAISED: cards, badges, the inline-code chip and menu hover. The spec's own words are 'medium contrast background atop surface', so this is the step ABOVE the floats, which is what a `bg-secondary` badge inside a `bg-menu` float needs in order not to sink into it (L 0.0192)",
          tokens: [
            "color-card",
            "color-secondary",
            "color-tag",
            "color-tooltip-tag",
            "color-menu-hover",
          ],
        },
      ],
      // The role table names `highlightMed` as "selection background (paired with
      // text foreground)" and it is the brightest value this block owns
      // (L 0.0504 against the raised step's 0.0192), so the selection state is
      // graded as strictly the brightest thing in the palette. `#6e6a8633` — the
      // published `highlightMed.alpha` — appears ONLY as the terminal's
      // translucent overlay, never as a border or a resting surface, which is
      // Dracula's rule for its own Selection colour and ADR 0105's rule for alpha
      // on a surface-shaped token.
      selectionRule: "strictly-above-all",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {
        // The context bar's TRACK. It is `highlightHigh #524f67` (L 0.0837), which
        // is BRIGHTER than the selection state `#403d52` (L 0.0504) — so promoting
        // it to a resting rung would put a resting plane above the selection step,
        // which is exactly the inversion the role table forbids and which
        // `selectionRule: "strictly-above-all"` would (correctly) refuse. It is not
        // an elevation step: it is a bar inside the side pane, and what it must
        // satisfy is separation from the PANE it rides (measured 2.04 against
        // `--color-inspector` `#21202e`; the step below it scores 1.53 and a track
        // that IS the pane scores 1.00) and from the four band fills, which
        // `slabFloatSeparation.test.ts` and the track gate in
        // `paletteCompleteness.test.ts` grade directly.
        "color-context-track":
          "the context bar's track, not an elevation step: it is highlightHigh (L 0.0837), brighter than this palette's own selection state, so a group would put a resting plane above Selection. Graded against the pane it rides (2.04 on --color-inspector) instead.",
      },
      textSurfaces: {
        // The planes copy actually lands on, chosen so the WORST is measured
        // rather than the prettiest. The slab `#21202e` is the binding resting
        // surface for every token in the family, and `panel`/`input` are graded
        // because the island layout made the recessed step the surface the
        // borderless cards — and the code-block header — paint on.
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
      // EMPTY, and it is a measurement: all seven graded text tokens clear 4.5 on
      // every resting plane (worst 4.68, `foreground-subtlest` on the slab) and on
      // the raised step (worst 4.52, the same token on `#26233a`). Rosé Pine's
      // accent roles are all high-luminance on a near-black base, so main needs no
      // resting exemption at all — unlike the Default palette, whose four status
      // hues are all exempt on its light reading.
      textFloors: {},
      // Also EMPTY. 4.52 is the tightest raised reading in the dark palette and it
      // clears; a Palette that needs a raised exemption on a dark reading has a
      // different problem from one that needs one only on the transient state.
      raisedFloors: {},
      // The two walls in this reading, both on the SELECTION state `#403d52`. Both
      // carry `expiresAt: 4.5`, so each dies the moment its hue clears the floor.
      selectedFloors: {
        "color-foreground-subtlest": {
          floor: 3.6,
          reason:
            "worst selected reading: text at 55% is 3.63 on the selection step #403d52 (4.68 on the slab, 4.52 on the raised card, 4.84 on the page). highlightMed is the brightest step main publishes, so no published value is further from it; raising this token until it clears 4.5 there would put it at 1.33x --color-foreground-subtle (4.83 on the same step) instead of the 1.42 the two tiers hold everywhere else, and a de-emphasis token that does not de-emphasise is a worse bug than a 0.87 shortfall on a transient state.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.5,
          reason:
            "worst selected reading: love #eb6f92 is 3.60 on the selection step #403d52 (5.51 on the slab and every float, 5.22 on the raised card, 6.07 on the page — all clear). love is the only red main publishes; the alternative that clears 4.5 on #403d52 is text #e0def4 at 7.93, i.e. an error that renders indistinguishable from body copy. `text-destructive` is the app's most-used status text, which is why the FILL and every resting plane are held to 4.5 and only the selection state is exempted.",
          expiresAt: 4.5,
        },
      },
      // EMPTY, and it is a real assertion: this block states every graded text
      // token as a literal hex or a single-colour `color-mix` over one, so the
      // resolver reaches all seven. The kit fails any entry named here that it CAN
      // resolve, so the day a Palette aliases one onto Tailwind's `oklch()` scale
      // it has to be recorded rather than silently dropped from grading.
      textUngradeable: {},
      // The 54 tokens `.theme-default-dark` declares that this block deliberately
      // does NOT — the **Identity color** set from `CONTEXT.md` plus the white
      // overlays. Each encodes WHAT a thing is rather than how a palette dresses
      // it: the 6 usage-chart hues and 5 heatmap steps whose STEPS are the signal,
      // the 7 context-breakdown steps, the 8 git statuses, the 18 transcript role
      // chips ("what kind of row is this"), the privacy hint, the 7 white overlays
      // (luminance, not hue — correct on any dark surface), and the 2 gradient
      // wordmark tokens. Asserted as a SET EQUALITY IN BOTH DIRECTIONS, so a token
      // added to `.theme-default-dark` must be classified rather than silently
      // dropped or silently inherited.
      //
      // The 22 `--color-terminal-*` tokens are NOT here: this block OWNS them,
      // because Rosé Pine's README assigns six of its twelve roles to the terminal
      // explicitly ("terminal red", "terminal yellow", …), so the mapping is the
      // specification's and not an invention. Rosé Pine publishes no bright row,
      // so `bright-*` repeats its normal counterpart rather than being tinted
      // toward white. One is live today via an alias rather than a class:
      // `--color-icon-blue` is `@theme`'s `var(--color-terminal-bright-blue)`, so
      // markdown links and diff `@@` hunks ride foam `#9ccfd8` — 10.37 on the page,
      // 9.41 on the slab, 8.91 on a card.
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
      // EMPTY: this block declares nothing `.theme-default-dark` omits. The six
      // ramp tokens (`--color-caution` + `--color-thinking-*`) are NOT named here
      // either — they are not in `.theme-default-dark`'s set at all (they live in
      // `@theme` and `.dark`), so naming them would fail the kit's staleness
      // check. Rosé Pine publishes no five-step severity ramp and inventing one
      // would mean six hues the source does not publish, so this reading takes the
      // shared `.dark` ramp: `caution #eab308` clears 4.5 on every dark plane it
      // can reach (worst 5.46 on the selection step), and `themeTokens.test.ts`
      // grades the ramp in the blocks that DO re-hue it.
      extraBeyondDefault: [],
      declaredCount: 114,
    },
    light: {
      mode: "light",
      // SIX rungs, strictly ascending end to end — and the reason this is
      // interesting is that ADR 0105's light plateau does NOT fire here. The
      // plateau exists because nothing in a light theme publishes anything lighter
      // than its own Base; dawn publishes TWO neutrals above its base, because
      // `surface` is defined in the role table as "low contrast background ATOP
      // base". So the raised planes get a real step and only the selection state
      // collapses.
      //
      // `--color-frame` takes `overlay` — a DARKER published value than the page —
      // because a chrome band must sit below the planes it frames. `highlightHigh`
      // is available at 1.48 from the page and is deliberately not used for the
      // band: a frame that far down reads as a fourth surface rather than as the
      // frame, and the role table reserves that step for the track and for borders.
      ladderGroups: [
        {
          label:
            "highlightHigh — the context bar's track only, and the darkest published step in dawn (L 0.5977). The role table assigns this step to 'cursor background, borders'; here it is the track because the track is the one thing that must sit BELOW the pane it rides",
          tokens: ["color-context-track"],
        },
        {
          label:
            "highlightMed — the RECESSED chip step: badge, inline-code chip, tooltip tag, menu hover. The light inversion of the dark reading, where `secondary`/`tag` are the RAISED step: dawn's own cursor-line direction is downward, and ADR 0105's measurement is exactly this — group membership cannot be one shared table (L 0.7084)",
          tokens: ["color-secondary", "color-tag", "color-tooltip-tag", "color-menu-hover"],
        },
        {
          label:
            "overlay — the chrome band, the secondary window plane, the tab strip and the tooltip: 'medium contrast background atop surface', one step below dawn's page (L 0.8259)",
          tokens: ["color-background-win-alt", "color-frame", "color-tab", "color-tooltip"],
        },
        {
          label:
            "highlightLow — the content slab, the inspector, the popover header and the terminal's paper: the reading surface, quieter than the page around it so the raised planes and the slab do not compete for the same attention (L 0.8563)",
          tokens: ["color-chat", "color-inspector", "color-popover-header", "color-terminal-bg"],
        },
        {
          label: "base — THE PAGE plane (L 0.9114)",
          tokens: ["color-background"],
        },
        {
          label:
            "surface — every raised plane at once: card, composer, header, panel, popover, menu, toast, input and the active tab. Dawn's lightest published value, so this is where a light reading runs out of room; `--color-card-selected` plateaus HERE (the `at-or-above-card` rule) and separation on that plateau is carried by `--color-card-border`, not by fill — ADR 0096's designed collapse, in a new palette, with new numbers (L 0.9610)",
          tokens: [
            "color-card",
            "color-composer",
            "color-header",
            "color-panel",
            "color-popover",
            "color-input",
            "color-input-focused",
            "color-menu",
            "color-toast",
            "color-tab-active",
          ],
        },
      ],
      // `--color-card-selected` is `#fffaf3` — `surface`, i.e. `--color-card`
      // itself, because nothing in dawn is lighter than `surface`. It cannot be
      // brighter than every resting step, so the rule is "never dimmer than the
      // card", which is the property that actually matters for a selected row.
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      // EMPTY: every surface token this block declares is a classified rung,
      // including the track (dawn's darkest step, so unlike the dark reading it
      // does not out-rank the selection state).
      ladderExemptions: {},
      textSurfaces: {
        // The chrome band `--color-frame` `#f2e9e1` is in the resting class
        // because chrome carries copy — the sidebar's section headers, the session
        // rows — and it is the WORST resting plane for all seven graded tokens. Grading only the page would report a floor the app never
        // renders, which is the gap this kit's per-surface grading exists to close.
        resting: ["color-background", "color-chat", "color-frame", "color-popover"],
        // `secondary`/`tag` are the RAISED CLASS here in the sense the kit means:
        // a badge or chip sits ON something. They are the darkest graded surface in
        // this reading, which is why they produce the palette's worst numbers.
        raised: ["color-secondary", "color-tag", "color-menu-hover"],
        // EMPTY on purpose, and it is a measurement rather than an omission:
        // `--color-card-selected` IS `#fffaf3`, the same hex `color-popover`
        // already contributes to the resting class. Re-listing it would restate a
        // ratio already measured and force a second copy of every floor to agree
        // with the first. The selection STATE is still graded — as a ladder rung,
        // by `selectionRule` above.
        selected: [],
      },
      // Four recorded walls in the resting class (six more in the raised class
      // below — ten in all). Dawn is the lightest reading in
      // this plan and its darkest published ink is 6.66 on its own base, so a
      // de-emphasis tier has almost no headroom and the status hues have less.
      // NONE is fixed here: the alternative in every case is a hue dawn does not
      // publish, and inventing one is the exact failure the published-hex gate
      // exists to refuse. Every floor carries `expiresAt: 4.5`, so each exemption
      // dies the moment the value clears the minimum.
      textFloors: {
        "color-foreground-subtlest": {
          floor: 3.5,
          reason:
            "worst resting reading: text at 75% is 3.51 on the #f2e9e1 chrome band (3.70 on the #faf4ed page, 3.58 on the #f4ede8 slab, 3.84 on a #fffaf3 float). The lowest alpha clearing 4.5 on all four resting planes is 87% (4.52 on the band) and it separates from --color-foreground-subtle by only 1.15 there — two de-emphasis tiers three points apart are one tier. 90/75 separates by 1.42 on the page, the ratio the dark reading buys, so the tiers are real and this plane is simply beyond both. 88 call sites read this token for small copy.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.4,
          reason:
            "worst resting reading: love #b4637a is 3.50 on the #f2e9e1 chrome band (3.84 on the page, 3.62 on the slab, 4.04 on a float). It is the only red dawn publishes; the value that clears 4.5 on the band is text #575279 at 6.07, i.e. an error indistinguishable from body copy. `text-destructive` is the app's most-used status text.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 1.8,
          reason:
            "worst resting reading, and the worst token in the palette: gold #ea9d34 is 1.87 on the #f2e9e1 chrome band (2.05 on the page, 1.93 on the slab, 2.16 on a float). Dawn publishes exactly one amber and the role table assigns it to 'warnings', so this is the specification's own number, not a value that was chosen. `--color-caution` (4.11 on the same band) is what a warning LABEL must read as; `text-warning` has 25 consumers, which is why the wall is recorded at its true depth rather than rounded up.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 4.1,
          reason:
            "worst resting reading: the inherited .dark/@theme caution #a16207 is 4.11 on the #f2e9e1 chrome band (4.51 on the page, 4.25 on the slab, 4.74 on a float). This reading declares no caution of its own — Rosé Pine publishes no severity ramp, so the token stays on the shared ramp and is NOT in extraBeyondDefault. The shortfall exists only on the chrome band, and `caution` also paints the context bar's percentage label, so it is held to the text floor and not the 3:1 glyph floor.",
          expiresAt: 4.5,
        },
      },
      // The chip step `#dfdad9` is dawn's `highlightMed` and the darkest surface a
      // badge or an inline-code chip can wear, so it is where a light reading's
      // text tokens are worst. Six of the seven graded tokens are below 4.5 there.
      raisedFloors: {
        "color-foreground-subtle": {
          floor: 4.2,
          reason:
            "the #dfdad9 chip step: text at 90% reaches 4.27 there while clearing 4.5 on all four resting planes (5.25 on the page, 4.96 on the slab, 4.85 on the chrome band, 5.45 on a float). No alpha clears 4.5 on #dfdad9 and on the #f2e9e1 band while keeping a real separation from --color-foreground-subtle, so the wall belongs to the step, not to the derivation.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 3.2,
          reason:
            "the #dfdad9 chip step: text at 75% reaches 3.21 there, the second-worst text reading in the palette after gold. Graded separately from the resting exemption on purpose — a merged table would let the worst surface in the palette excuse every surface in it.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.0,
          reason:
            "the #dfdad9 chip step: love #b4637a reaches 3.03 there. `bg-destructive` is a FILL and this grades the TEXT token on a badge surface; the nearest published value clearing 4.5 on #dfdad9 is text #575279 at 5.25, i.e. copy again.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 4.4,
          reason:
            "the #dfdad9 chip step: pine #286983 reaches 4.41 there and clears 4.5 on all four resting planes (worst 5.09). It misses by 0.09, which is exactly the distance a rounded-down comment would hide, so it is recorded as a wall rather than reported as a pass — a comment claiming the floor was met is exactly what stops the next reader measuring.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 1.6,
          reason:
            "the #dfdad9 chip step: gold #ea9d34 reaches 1.62 there — the worst single reading of the whole row, resting or raised. Recorded at its true depth: no published dawn value clears 4.5 on #dfdad9 except text itself.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.5,
          reason:
            "the #dfdad9 chip step: the inherited caution #a16207 reaches 3.56 there (4.11 on the chrome band, its worst resting reading, already exempted above).",
          expiresAt: 4.5,
        },
      },
      // EMPTY because the selection state plateaus onto `#fffaf3`, which the
      // resting class already grades through `color-popover`. There is no second
      // selection surface to state a floor against.
      selectedFloors: {},
      textUngradeable: {},
      // The same 54 Identity-color families and white overlays as the dark
      // reading, PLUS the 25 file-type DESCRIPTORS — 79 in all. The descriptors are
      // inherited here and restated in the dark reading, and the asymmetry is the
      // rule, not an oversight: `@theme` holds all 25 light-safe readings precisely
      // so a light page reads them correctly, so restating them in a LIGHT block
      // would SHADOW that value for a classless document. `.theme-default-light`
      // names the same 25 for the same reason, and the descriptor gate in
      // `paletteCompleteness.test.ts` is DARK-readings-only for exactly this.
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
      // EMPTY, for the same reason as the dark reading: the six ramp tokens are not
      // in `.theme-default-dark`'s set. This reading inherits `@theme`'s light-safe
      // `caution #a16207`, which is the token the resting floor above records.
      extraBeyondDefault: [],
      declaredCount: 89,
    },
  },
};
