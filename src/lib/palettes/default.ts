import { SURFACE_TOKEN_PATTERN, type PaletteSpec } from "../paletteSpec";

/**
 * The Default palette's grading row.
 *
 * THE DEFAULT PALETTE PUBLISHES NO SPEC, and pretending otherwise would make
 * this row's `publishedHexes` mean something it does not. Dracula's half of the
 * spec gate is a CONFORMANCE check against draculatheme.com/spec; here it is a
 * REGRESSION net over the app's own recorded readings: every hex in the two
 * blocks is listed, so introducing a new one is a deliberate edit to this file
 * rather than a silent addition to a stylesheet. `specSourceUrl` says which kind
 * of record the reader is looking at, because a reader who mistakes one for the
 * other will draw the wrong conclusion from a green gate.
 *
 * WHY THE DEFAULT BLOCKS ARE ALSO THE COMPLETENESS REFERENCE. `.theme-default-dark`
 * is the complete standalone dark palette (168 declarations) that every other
 * block is a diff over, so "what must a Palette state its intent for?" is
 * answered by that block's token set. The kit compares both directions against
 * it, which is what makes a new token in `.theme-default-dark` a decision for
 * every other Palette rather than a silent inheritance.
 *
 * WHAT THIS ROW EXPOSES, and why the floors are not all 4.5. Grading the Default
 * palette the way Dracula is graded found three text hues that do not clear the
 * WCAG minimum on the surfaces the app actually paints them on — measured here,
 * not inherited from another palette's figures:
 *
 *   `--color-warning`   #e07b00  2.82 on #f8f8f8 · 3.00 on #ffffff · 2.40 on #e6e6e6
 *   `--color-success`   #1e8a3e  4.15 on #f8f8f8 · 4.41 on #ffffff · 3.53 on #e6e6e6
 *   `--color-destructive` #e03131 4.25 on #f8f8f8 · 4.51 on #ffffff · 3.62 on #e6e6e6
 *   `--color-destructive` #ff5c5c 3.99 on #363636 (default dark's `secondary`/`tag`/`menu-hover`)
 *
 * All four are consumed as TEXT (`text-warning` 25 uses, `text-success` 19,
 * `text-destructive` 82 across `src/components` + `src/lib`). They are recorded
 * as walls with the number each reaches, NOT fixed here: changing a default
 * surface or hue is a palette decision the plan assigns to Task 7's closeout
 * with user input, and inventing values inside a gate refactor is exactly the
 * "invented hue" failure ADR 0027 was written about. Each floor carries
 * `expiresAt: 4.5`, so the exemption dies the moment the hue clears the floor —
 * the ratchet Dracula's `RAISED_FLOOR` invented, applied per Palette by ADR 0105.
 */
export const spec: PaletteSpec = {
  id: "default",
  cssFile: "src/styles/theme.css",
  baseCssFile: "src/styles/theme.css",
  specSourceUrl:
    "docs/css-theme-tokens.md (the app's OWN design record — the Default palette publishes no external specification, so this row's publishedHexes is a regression net over the recorded readings, not a conformance check)",
  publishedHexes: [
    // Measured from `.theme-default-light` + `.theme-default-dark` (every hex
    // either block declares, comments stripped), 90 distinct. Re-measure with
    // `npx vitest run src/lib/paletteTestKit.test.ts`'s discovery gate rather
    // than recalling this list — ADR 0027: count it, do not recall it.
    "#000000",
    "#001d3d",
    "#0066dd",
    "#00acc1",
    "#00bcd4",
    "#0288d1",
    "#0aa7a7",
    "#0b7fff",
    "#0d0d0d",
    "#14807a",
    "#160d38",
    "#161616",
    "#166b32",
    "#1a70b8",
    "#1e88e5",
    "#1e8a3e",
    "#202020",
    "#26a69a",
    "#2b2b2b",
    "#338fff",
    "#363636",
    "#4099ff",
    "#41b883",
    "#42a5f5",
    "#42c8c8",
    "#46bf72",
    "#4b280f",
    "#542500",
    "#566270",
    "#5a341b",
    "#5c5c5c",
    "#5ca7ff",
    "#66adff",
    "#6f7a2f",
    "#7453b0",
    "#747474",
    "#7b5ce5",
    "#7e57c2",
    "#80beff",
    "#85bbff",
    "#87d9a4",
    "#888888",
    "#8bc34a",
    "#8ee5e5",
    "#8fc5ef",
    "#93d8d2",
    "#9dceff",
    "#9e77ed",
    "#a888f2",
    "#acd0ff",
    "#adadad",
    "#afb42b",
    "#b5c0cc",
    "#b87a1a",
    "#b9ddff",
    "#bda5e6",
    "#bd93f9",
    "#c8cd90",
    "#c8ddff",
    "#cfd8dc",
    "#d0e8ff",
    "#e03131",
    "#e07b00",
    "#e0ecff",
    "#e4f1ff",
    "#e65100",
    "#e6e6e6",
    "#eaf7ee",
    "#ebf4ff",
    "#ec407a",
    "#ececee",
    "#efc58f",
    "#f0f0f0",
    "#f44336",
    "#f5f3ff",
    "#f8f8f8",
    "#f9a825",
    "#ff5252",
    "#ff5722",
    "#ff5c5c",
    "#ff7043",
    "#ff8a30",
    "#ff9999",
    "#ffb26b",
    "#ffb300",
    "#ffca28",
    "#ffd54f",
    "#ffd8b8",
    "#ffe3c8",
    "#fff4eb",
    "#ffffff",
  ],
  // The Default palette has no off-record hex: it is the app's own palette, so
  // every value is on record by definition. An empty list here is the honest
  // answer, not a gate that grades nothing — the hex gate still scans every
  // declaration, and `paletteTestKit.test.ts` proves a planted hex outside this
  // list fails by name.
  offSpecAllowList: {},
  modes: {
    light: {
      mode: "light",
      // THE LIGHT LADDER RUNS THE OTHER WAY and this is the row that proves the
      // gate has to know it (ADR 0105). Dracula's ladder ascends to a Selection
      // step; a light theme's own Base is its LIGHTEST published value, so
      // nothing can sit above it. `default-light` answers by PLATEAU: `card`,
      // `input`, `popover`, `menu`, `panel`, `header`, `toast` and the composer
      // are ALL `#ffffff`, which ADR 0096 records as a designed collapse (the
      // reason `bg-panel` is not always recessed). So the top group is a plateau
      // and every group below it strictly ascends.
      //
      // `secondary`/`tag` at `#e6e6e6` (L 0.7913) sit BELOW `card` `#ffffff`
      // (L 1.0000) — the exact case the shared Dracula group table cannot express,
      // since in Dracula `secondary` IS `card`. ADR 0105's measurement.
      ladderGroups: [
        {
          label:
            "the recessed chips (badge fill, inline-code chip) — the DARKEST step in a light reading, the inverse of Dracula where these are the raised step",
          tokens: ["color-secondary", "color-tag", "color-tooltip-tag"],
        },
        {
          label: "the content column's backdrop (`--color-background-alt`'s base)",
          tokens: ["color-background-win-alt"],
        },
        {
          label:
            "the chrome and the quiet fills (frame, tab strip, tooltip, menu hover)",
          tokens: ["color-frame", "color-menu-hover", "color-tab", "color-tooltip"],
        },
        {
          label:
            "the page plane and everything aliased to it (the slab, the inspector, the popover header, the terminal's paper)",
          tokens: [
            "color-background",
            "color-chat",
            "color-inspector",
            "color-popover-header",
            "color-terminal-bg",
          ],
        },
        {
          label:
            "the white plateau — every surface a light theme cannot differentiate because its Base IS its lightest published value (ADR 0096's designed collapse; separation here is carried by `--color-card-border`, not by fill)",
          tokens: [
            "color-card",
            "color-composer",
            "color-header",
            "color-input",
            "color-input-focused",
            "color-menu",
            "color-panel",
            "color-popover",
            "color-tab-active",
            "color-toast",
          ],
        },
      ],
      // `--color-card-selected` is `var(--color-input)`, i.e. the white plateau
      // itself. It cannot be brighter than every resting step — nothing in a light
      // palette is brighter than white — so the rule is "never dimmer than the
      // card", which is the property that actually matters for a selected row.
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {
        // The context bar's track is an ALIAS of a TEXT token
        // (`var(--color-foreground-subtlest)`), so it is not a step at all and
        // composites against whatever the pane behind it wears. Grading it as a
        // surface would grade a text hue on the elevation ladder — the role split
        // `paletteCompleteness.test.ts` documents.
        "color-context-track":
          "aliases --color-foreground-subtlest (a TEXT token); the role split makes it not an elevation step",
      },
      textSurfaces: {
        // The four planes copy lands on, chosen so the WORST is graded: the page,
        // the slab, the chrome band and a float. `frame` (#f0f0f0) is in the resting
        // class because chrome carries copy — the sidebar's section headers, the
        // session rows — and it is the darkest light surface, so grading only the
        // page would report a floor the app never renders. `secondary`/`tag` are the
        // RAISED class here even though they are the OPPOSITE of Dracula's raised
        // step: what makes them the raised class is that a badge or chip sits ON
        // something, not which direction they move in.
        resting: ["color-background", "color-chat", "color-frame", "color-popover"],
        raised: ["color-secondary", "color-tag", "color-menu-hover"],
        // EMPTY on purpose, and it is a measurement rather than an omission:
        // `--color-card-selected` is `var(--color-input)`, i.e. the same `#ffffff`
        // the resting class already grades through `color-popover`. Re-listing it
        // would restate a hex already measured and force a second copy of every
        // floor to agree with the first. The selection STATE is still graded — as a
        // ladder rung, by `selectionRule` above.
        selected: [],
      },
      // Every one of these is a RECORDED WALL, not a fixed defect. Grading the
      // Default palette the way Dracula is graded found that all four status hues
      // fail the 4.5 text minimum somewhere in the LIGHT reading, and all four are
      // consumed as text (`text-destructive` 82, `text-warning` 25, `text-success`
      // 19, `text-caution` 4 uses across `src/components` + `src/lib`). Each floor
      // is the WORST resting reading, measured here rather than recalled from
      // another palette's figures (ADR 0096: "a contrast check in one palette
      // proves nothing"). None is fixed in this commit: moving a Default palette
      // hue is a palette decision the plan gives to Task 7's closeout with user
      // input, and inventing values inside a gate refactor is exactly the
      // "invented hue" failure ADR 0027 was written about. Every floor carries
      // `expiresAt: 4.5`, so each exemption dies the moment the hue clears it.
      textFloors: {
        "color-warning": {
          floor: 2.6,
          reason:
            "worst resting reading: #e07b00 is 2.63 on the #f0f0f0 tooltip/menu-hover band (2.82 on the #f8f8f8 page, 3.00 on white). `text-warning` has 25 consumers.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 3.8,
          reason:
            "worst resting reading: #1e8a3e is 3.87 on the #f0f0f0 band (4.15 on the #f8f8f8 page, 4.41 on white). `text-success` has 19 consumers.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.9,
          reason:
            "worst resting reading: #e03131 is 3.96 on the #f0f0f0 band (4.25 on the #f8f8f8 page, 4.51 on white). `text-destructive` is the app's most-used status text (82 consumers).",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 4.3,
          reason:
            "worst resting reading: #a16207 is 4.32 on the #f0f0f0 band (4.64 on the #f8f8f8 page, 4.92 on white). `caution` also paints the context bar's percentage LABEL, so it is held to the text floor and not the 3:1 glyph floor.",
          expiresAt: 4.5,
        },
      },
      raisedFloors: {
        "color-warning": {
          floor: 2.4,
          reason:
            "the #e6e6e6 chip step: #e07b00 reaches 2.40 there — the worst reading of the raised class and of the whole palette.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 3.5,
          reason: "the #e6e6e6 chip step: #1e8a3e reaches 3.53 there.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.6,
          reason:
            "the #e6e6e6 chip step: #e03131 reaches 3.62 there, the worst reading of the raised class.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.9,
          reason: "the #e6e6e6 chip step: #a16207 reaches 3.94 there.",
          expiresAt: 4.5,
        },
      },
      selectedFloors: {},
      textUngradeable: {
        "color-foreground":
          "aliases Tailwind v4's --color-neutral-800, which is oklch() with no hex reading in this repo (node_modules/tailwindcss/theme.css); grading it would mean hardcoding a hex the browser never sees",
        "color-foreground-subtle":
          "color-mix over --color-neutral-800 (oklch) — unresolvable to a hex for the same reason",
        "color-foreground-subtlest":
          "color-mix over --color-neutral-800 (oklch) — unresolvable to a hex for the same reason",
      },
      // `.theme-default-light` declares a strict SUBSET of `.dark`: the 25 file
      // descriptors it omits carry their light-safe reading in `@theme`, which is
      // what a classless document and a light reading both resolve. Restating them
      // here would shadow `@theme`, and the same argument is why this block must
      // stay silent on the 6 ramp tokens — which is why they are absent from this
      // block's declaration set for a different reason and appear in
      // `extraBeyondDefault` as empty.
      inheritedFromDefault: [
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
      ],
      extraBeyondDefault: [],
      declaredCount: 143,
    },

    dark: {
      mode: "dark",
      // Default dark is the COMPLETENESS REFERENCE, so its own row is the
      // degenerate case: it inherits nothing from itself and declares nothing the
      // reference does not. That is not a vacuous row — `declaredCount` pins the
      // 168, the ladder and the floors below are graded like everyone else's, and
      // the eight collapsed steps ADR 0096 records show up here as groups of
      // tokens sharing one value.
      ladderGroups: [
        {
          label:
            "the chrome and the page, on ONE value — ADR 0096's first collapse (`--color-frame == --color-background`), so the island layout's 'chrome frames the islands' property does not exist in this palette",
          tokens: [
            "color-frame",
            "color-background",
            "color-tab-active",
            "color-terminal-bg",
          ],
        },
        {
          label: "the recessed band (header, panel, popover header, tab strip)",
          tokens: ["color-header", "color-panel", "color-popover-header", "color-tab"],
        },
        {
          label: "the content slab and the inspector (a 60% mix over the column's own base)",
          tokens: ["color-chat", "color-inspector"],
        },
        {
          label:
            "the raised step and everything aliased onto it — the second collapse (`--color-card-selected == --color-input == --color-card`), which is why the selection rule below is not 'strictly above'",
          tokens: [
            "color-background-win-alt",
            "color-card",
            "color-composer",
            "color-input",
            "color-input-focused",
            "color-menu",
            "color-popover",
            "color-toast",
            "color-tooltip",
          ],
        },
        {
          label:
            "the brightest resting step (menu hover, badge fill, inline-code chip) — brighter than the selection state in this palette, the inversion Dracula's ladder forbids and default dark lives with",
          tokens: ["color-menu-hover", "color-secondary", "color-tag", "color-tooltip-tag"],
        },
      ],
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {
        "color-context-track":
          "aliases --color-foreground-subtlest (a TEXT token); the role split makes it not an elevation step",
      },
      textSurfaces: {
        resting: ["color-background", "color-chat", "color-popover", "color-tooltip"],
        raised: ["color-secondary", "color-tag", "color-menu-hover", "color-card"],
        // EMPTY for the same measured reason as the light reading:
        // `--color-card-selected` is `var(--color-input)` == `#2b2b2b` ==
        // `--color-card`, and `color-card` is already in the raised class. ADR 0096
        // records that collapse as designed; duplicating the surface here would
        // only duplicate its floors.
        selected: [],
      },
      textFloors: {
        "color-destructive": {
          floor: 4.6,
          reason:
            "worst resting reading: #ff5c5c is 4.68 on the #2b2b2b float (5.98 on the #161616 page). Clears 4.5 with a hair of margin — pinned so a future re-hue that loses the margin fails by name rather than quietly landing at 4.4.",
        },
      },
      raisedFloors: {
        "color-destructive": {
          floor: 3.9,
          reason:
            "measured wall: #ff5c5c reaches 3.99 on the #363636 step (`secondary`/`tag`/`menu-hover`) — the brightest red this palette carries, and `text-destructive` is the app's most-used status text (82 consumers). Recorded, not fixed here: moving a Default palette hue is Task 7's decision with user input.",
          expiresAt: 4.5,
        },
      },
      selectedFloors: {},
      textUngradeable: {
        "color-foreground":
          "aliases Tailwind v4's --color-neutral-300, which is oklch() with no hex reading in this repo",
        "color-foreground-subtle":
          "color-mix over --color-neutral-300 (oklch) — unresolvable to a hex for the same reason",
        "color-foreground-subtlest":
          "color-mix over --color-neutral-300 (oklch) — unresolvable to a hex for the same reason",
      },
      // The reference row: a Palette cannot be incomplete against itself.
      inheritedFromDefault: [],
      extraBeyondDefault: [],
      declaredCount: 168,
    },
  },
};
