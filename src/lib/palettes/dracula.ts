import { SURFACE_TOKEN_PATTERN, type PaletteSpec } from "../paletteSpec";

/** The 25 file-type DESCRIPTORS, in the order `paletteCompleteness.test.ts`
 *  lists them. `file-node*` are NOT here — those are the file-row ROLE CHIP (an
 *  identity colour that rides the `.dark` reading), not a descriptor. */
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
 * meaning anything.
 *
 * Dracula publishes 11 hues. There are 25 file types. Re-huing the descriptors to
 * the spec set would make a `.py` chip indistinguishable from a `.json` one, and
 * the hue is the ONLY thing distinguishing them — so this is the **Identity
 * color** rule (`CONTEXT.md`) knowingly outranking the spec's "use exact color
 * values from this specification". `file-css` needs no exemption: Dracula reads it
 * `#bd93f9`, which IS spec Purple (the Default palette's `#7e57c2` is 2.73 on this
 * palette's SLAB `#282a36`, under the 3:1 glyph floor, which is why it is re-read
 * at all — it clears the PAGE `#21222c` by 0.03 at 3.03, so the slab is the
 * surface that decides. The one-step-down amendment to ADR 0027 moved the page off
 * `#282a36`, and this sentence used to quote 2.73 against "the page").
 */
const offSpecAllowList = Object.fromEntries(
  FILE_DESCRIPTORS.filter((token) => token !== "color-file-css").map((token) => [
    token,
    "file-type Identity hue copied from .theme-default-dark: Dracula's 11 hues cannot name 25 file types and the hue IS the signal (CONTEXT.md's Identity color rule outranking the spec)",
  ]),
);

/**
 * Dracula Classic's grading row.
 *
 * This row is the shape every later Palette copies, because Dracula is the one
 * Palette whose values came from an external specification and whose history
 * ADR 0027 records in full. Three of its facts are the reason the harness looks
 * the way it does:
 *
 * - **One reading, so the mode is inert.** `modes.dark` only; the registry's
 *   `modes: ["dark"]` is what "Dracula pins dark" became (ADR 0104). The light
 *   slot is `undefined`, not an empty object — a graded mode with no block and a
 *   block with no graded mode are both hard failures in the kit.
 * - **The 4.3 wall that must expire.** `destructive` `#ff6e6e` is the brightest
 *   red the specification publishes and reaches 4.33 on the raised step. ADR 0027
 *   amended this to *fail if it ever clears 4.5*, because an exemption with no
 *   expiry is a permanent decision wearing a temporary one. That ratchet is
 *   `FloorRule.expiresAt`, and ADR 0105 makes it per-Palette data rather than a
 *   Dracula-only constant buried in a gate.
 * - **`secondary` IS `card`.** Both `#343746`, one ladder group. In
 *   `default-light` `secondary #e6e6e6` sits BELOW `card #ffffff`. No shared group
 *   table can say both, which is the concrete measurement behind ADR 0105's
 *   "group membership is per-Palette".
 */
export const spec: PaletteSpec = {
  id: "dracula",
  cssFile: "src/styles/dracula.css",
  baseCssFile: "src/styles/theme.css",
  specSourceUrl: "https://draculatheme.com/spec",
  publishedHexes: [
    // The spec's own tables: the 11 core values (12 tokens — Current Line and
    // Comment are the same `#6272a4`), the 4 UI elevation values, the 5 Functional
    // colors, and the 16 ANSI values.
    "#282a36", // Background
    "#6272a4", // Current Line / Comment
    "#44475a", // Selection
    "#f8f8f2", // Foreground
    "#ff5555", // Red
    "#ffb86c", // Orange
    "#f1fa8c", // Yellow
    "#50fa7b", // Green
    "#8be9fd", // Cyan
    "#bd93f9", // Purple
    "#ff79c6", // Pink
    "#191a21", // Background Darker
    "#21222c", // Background Dark == AnsiBlack
    "#343746", // Background Light == Floating interactive elements
    "#424450", // Background Lighter
    "#de5735", // Functional Red
    "#a39514", // Functional Orange
    "#089108", // Functional Green
    "#0081d6", // Functional Cyan
    "#815cd6", // Functional Purple
    "#ff6e6e", // AnsiBrightRed
    "#69ff94", // AnsiBrightGreen
    "#ffffa5", // AnsiBrightYellow
    "#d6acff", // AnsiBrightBlue
    "#ff92df", // AnsiBrightMagenta
    "#a4ffff", // AnsiBrightCyan
    "#ffffff", // AnsiBrightWhite
    // Deliberately ABSENT: `#353747`, which the spec does publish — as the opaque
    // Current-Line fallback for editors that cannot alpha-blend, in prose that
    // says outright those values "do not add new syntax tokens to the official
    // palette". An allow-list entry nothing uses is a free slot, so it was removed
    // rather than kept as bookkeeping. If a real renderer needs it, re-add it with
    // the declaration that uses it.
  ],
  offSpecAllowList,
  modes: {
    light: undefined,
    dark: {
      mode: "dark",
      // Four rungs, after ADR 0027's one-step-down re-anchor merged the two
      // deepest (Background Darker `#191a21` and Background Dark `#21222c` were
      // adjacent rungs; shifting the whole content one step down put the chrome
      // and the recessed controls on the SAME `#191a21`). The spec's five steps
      // still exist; the app no longer uses `#21222c` for chrome — it is the page
      // plane now.
      ladderGroups: [
        {
          label:
            "the deepest AND the recessed plane — the terminal's paper, form controls, popover header, the borderless cards inside the slab, and the FRAME the islands sit in (Background Darker; merged with Background Dark by the one-step-down shift)",
          tokens: [
            "color-terminal-bg",
            "color-input",
            "color-input-focused",
            "color-popover-header",
            "color-panel",
            "color-frame",
          ],
        },
        {
          label: "the page plane AND the composer island (the inspector's backdrop)",
          tokens: ["color-background", "color-composer"],
        },
        {
          label:
            "the chat column, the inspector AND every float (header, tabs, menus, popovers, toasts, tooltips) — and the ACTIVE TAB, which is the chat sheet showing through the frame (Background == the spec's Floating interactive elements; the collision `slabFloatSeparation.test.ts` prices)",
          tokens: [
            "color-chat",
            "color-inspector",
            "color-header",
            "color-background-win-alt",
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
            "raised (cards, badges, the inline-code chip, menu hover, the context bar's track) — `secondary` and `tag` are HERE because a `bg-secondary` badge lands inside a `bg-menu` float and must read as raised above it; this is the group that `default-light` cannot share",
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
      // Spec Selection is the brightest step, and the app keeps it out of every
      // resting surface and out of every border.
      selectionRule: "strictly-above-all",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {},
      textSurfaces: {
        // The page, the slab, a float, and the recessed well. `panel`/`input` are
        // the deepest rung, so they belong with the resting class rather than the
        // raised one — and the island layout made `panel` the surface the
        // borderless cards actually paint on.
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
      // Every graded text token clears 4.5 on the resting surfaces (measured: the
      // tightest is `foreground-subtlest` at 4.93 on the slab), so there are no
      // resting overrides — which is the point of grading the resting class at all:
      // a Palette that needs an exemption on the PAGE has a different problem from
      // one that needs one on a raised row.
      textFloors: {},
      raisedFloors: {
        "color-destructive": {
          floor: 4.3,
          reason:
            "#ff6e6e is the brightest red the specification publishes and reaches 4.33 on the raised step #343746. The only spec value near enough to red to clear 4.5 there is AnsiBrightMagenta #ff92df (5.86) — Pink, the hue this palette gives string literals: trading a 0.17 shortfall for a real ambiguity. This is why the code-block header moved off bg-card.",
          expiresAt: 4.5,
        },
      },
      selectedFloors: {
        "color-destructive": {
          floor: 3.3,
          reason:
            "#ff6e6e reaches 3.54 on the selection state #424450, one rung above the raised step and therefore worse for a dark-adjacent hue. A transient state, graded separately so the resting exemption cannot be stretched to cover it.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 3.8,
          reason:
            "Foreground at 55% reaches 4.01 on #424450. Raising it to clear 4.5 would make it indistinguishable from --color-foreground-subtle (at 60% the two separate by only 1.11 there), and a de-emphasis token that does not de-emphasise is a worse bug than a 0.5 shortfall on a transient state.",
          expiresAt: 4.5,
        },
      },
      // Dracula states every text reading as a literal hex or a single-colour
      // `color-mix` over one, so the resolver reaches all of them. An EMPTY map
      // here is a real assertion: the kit fails any entry it names, and grading
      // every graded token is the point.
      textUngradeable: {},
      // The 54 tokens `.theme-default-dark` declares that this block deliberately
      // does NOT (ADR 0027's "data-identity palettes stay inherited" consequence).
      // Each is inherited from `.dark` by design, not by omission: the 11 usage
      // scales and 7 context-breakdown steps whose STEPS are the signal, the 8 git
      // hues, the 18 role chips ("what kind of row is this"), the privacy hint, the
      // 7 white overlays (luminance, not hue — correct on any dark surface), and the
      // 2 gradient-wordmark tokens.
      //
      // The 22 `--color-terminal-*` tokens are NOT here: this block OWNS them
      // (ADR 0027's amendment 2), and the reason is not that the app has a terminal
      // — it does not, and never has. The basis is that the spec publishes the
      // 16-colour ANSI table, so copying costs nothing and leaves no half-owned
      // palette. Note these render differently from the default dark reading
      // anyway: that block restates the 54 by hand and this one leaves them on
      // `.dark`. The rule is "untouched BY this Palette", not "preserved FROM
      // Default".
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
      // The 6 RAMP tokens, which live in `.dark` + `@theme` and which Dracula
      // re-hues (they were raw Tailwind hues in components, which no Palette can
      // move). Their light-safe readings stay in `@theme` and their dark readings
      // in `.dark`; this block is the third reading.
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
