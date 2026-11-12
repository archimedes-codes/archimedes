import { SURFACE_TOKEN_PATTERN, type PaletteSpec } from "../paletteSpec";

/**
 * The 25 file-type DESCRIPTORS, in the order `paletteCompleteness.test.ts` lists
 * them. `file-node*` are NOT here — those are the file-row ROLE CHIP, inherited
 * from `.dark` with the rest of the Identity families.
 *
 * THE REASONS ARE PER TOKEN AND MEASURED, deliberately not one family-wide
 * string. Dracula's row is the precedent for the SHAPE (24 entries, one reason
 * each) and its reason is generic; here each descriptor carries the ratio that
 * makes its own case, because "the hue is the signal" is the reason all 24 stay
 * on the Default palette's hues, but the number that shows each one is legible is
 * a fact about that hue. `file-css` is absent because it carries an Ayu hue and
 * therefore needs no exception — see the CSS block for the legibility argument.
 */
const FILE_DESCRIPTORS: Record<string, string> = {
  "color-file-ts": "Identity hue copied from .theme-default-dark (the hue says what kind of file this is, so a Palette must not re-hue it); #0288d1 is the tightest glyph in the set at 4.61 on the raised step and 4.78 on the slab, so it is legible and re-huing it would only make it indistinguishable from .py",
  "color-file-react": "Identity hue copied from .theme-default-dark; #00bcd4 reads 7.73 on its worst surface and no Ayu cyan is distinguishable from it at chip size, so the Default hue is both legible and the one that means React",
  "color-file-js": "Identity hue copied from .theme-default-dark; #ffca28 is the brightest descriptor here (11.61 worst-case) and is the JS yellow every other layer of this app already prints",
  "color-file-json": "Identity hue copied from .theme-default-dark; #f9a825 at 9.01 worst-case, kept because JSON and JS must not share a hue and Ayu's single yellow cannot give them both",
  "color-file-html": "Identity hue copied from .theme-default-dark; #e65100 at 4.69 worst-case, the second-tightest in the set and still over the 3:1 glyph floor on all four surfaces a chip rides",
  "color-file-sass": "Identity hue copied from .theme-default-dark; #ec407a at 4.72 worst-case, shared with .graphql exactly as in every other palette so the two stay one colour app-wide",
  "color-file-md": "Identity hue copied from .theme-default-dark; #42a5f5 at 6.71 worst-case, and Markdown's blue is the one descriptor hue users learn outside this app",
  "color-file-rs": "Identity hue copied from .theme-default-dark; #ff7043 at 6.47 worst-case, shared with .sh as in Default so the pairing stays stable",
  "color-file-py": "Identity hue copied from .theme-default-dark; #0288d1 at 4.61 worst-case — the same hue as .ts by Default's own choice, which is a Default-palette decision this Palette must not silently re-make",
  "color-file-sh": "Identity hue copied from .theme-default-dark; #ff7043 at 6.47 worst-case",
  "color-file-yaml": "Identity hue copied from .theme-default-dark; #ff5252 at 5.57 worst-case, and it is already close to this palette's error red, which is the reason NOT to substitute Ayu's own red and make it closer",
  "color-file-toml": "Identity hue copied from .theme-default-dark; #cfd8dc at 12.27 worst-case, the palest descriptor in the set and legible precisely because it is near-white on every dark surface",
  "color-file-lock": "Identity hue copied from .theme-default-dark; #ffd54f at 12.59 worst-case, the brightest token in the block",
  "color-file-image": "Identity hue copied from .theme-default-dark; #26a69a at 5.92 worst-case, and Ayu's teal l4/l5 would collide with the regexp hue its syntax already owns",
  "color-file-svg": "Identity hue copied from .theme-default-dark; #ffb300 at 9.90 worst-case, kept distinct from .js and .json rather than collapsed onto one Ayu amber",
  "color-file-archive": "Identity hue copied from .theme-default-dark; #afb42b at 7.94 worst-case, the only olive in the set and not reproducible from Ayu's yellow or green without joining them",
  "color-file-go": "Identity hue copied from .theme-default-dark; #00acc1 at 6.49 worst-case, distinct from .react's #00bcd4 by a hair and from every Ayu cyan by more, which is the trade Default already made",
  "color-file-vue": "Identity hue copied from .theme-default-dark; #41b883 at 7.11 worst-case, the framework green that is not Ayu's syntax green",
  "color-file-svelte": "Identity hue copied from .theme-default-dark; #ff5722 at 5.61 worst-case, the brand orange, deliberately not this palette's #ff8f40 warning hue",
  "color-file-java": "Identity hue copied from .theme-default-dark; #f44336 at 4.82 worst-case, and distinguishable from this block's #d95757 error red by hue position rather than by lightness",
  "color-file-php": "Identity hue copied from .theme-default-dark; #1e88e5 at 4.83 worst-case, one of the three tightest and the reason this row is stated per token: each is legible, but not by much, and a re-hue would have to answer for it by name",
  "color-file-xml": "Identity hue copied from .theme-default-dark; #8bc34a at 8.46 worst-case",
  "color-file-graphql": "Identity hue copied from .theme-default-dark; #ec407a at 4.72 worst-case, deliberately the same hex as .sass because Default ships them equal and a palette that splits them changes what a chip means",
  "color-file-db": "Identity hue copied from .theme-default-dark; #ffca28 at 11.61 worst-case, the same hex as .js in Default — an existing app-wide ambiguity this Palette inherits rather than invents",
};

/**
 * The allow-list, and what is NOT in it.
 *
 * Exactly 24 entries, all file-type DESCRIPTORS. `--color-card-selected` used to
 * have a 25th, because the block stated `#1e242f` — Ayu's `ui.selection.active`
 * composited over the slab, a hex no source publishes. The gate refused it as an
 * unused exception and it was right on the merits: rather than argue the
 * exception, the block now states `palette.gray.l1` `#333b44`, which the YAML does
 * publish, so the token needs no excuse at all. See the selection declaration in
 * `src/styles/ayu.css` for the measurement that picked that step.
 *
 * `file-css` is absent from the map because it carries an Ayu hue
 * (`syntax.constant` `#d2a6ff`) and is therefore on-spec — an entry for it would
 * be the same kind of free slot the gate just refused.
 */
const offSpecAllowList: Record<string, string> = { ...FILE_DESCRIPTORS };


/**
 * Ayu's grading row.
 *
 * SOURCE OF TRUTH — `ayu-theme/ayu-colors`, `themes/dark.yaml` and
 * `themes/light.yaml`, at `master`. The YAML is the only place Ayu defines a
 * colour (its `AGENTS.md`: "The `themes/` YAML files are the only place colors
 * are defined … Edit the YAML, never the output"), and most values are DERIVED
 * there — a per-hue 5-step OKLCH ramp (`palette:` with `range: 0.675:0.875`,
 * `steps: 5`) and `$ref` chains with `A`/`L`/`C` modifiers.
 *
 * HOW MUCH OF `publishedHexes` IS VERIFIED, stated because the honest answer is
 * "not all of it". 55 of the 153 hexes below are LITERALS in one of the two YAMLs
 * and were read there directly — every surface step, every `ui.*` / `editor.*`
 * literal, every `common.*` value, every `vcs.*` value, and every hue literal.
 * The other 98 are ramp steps, `$ref` resolutions and alpha resolutions, which
 * need Ayu's own generator (`src/color.ts`) to derive; that generator is not
 * vendored in this repo and was NOT run here. They were CHECKED rather than
 * derived: for each hue, the five steps are evenly spaced in OKLCH lightness
 * across the declared `range`, and the hue's YAML literal lands on exactly the
 * step the `syntax:` reference names — `syntax.string` is `palette.green.l4` and
 * `#aad94c` is green's fourth step at L 0.8251; `syntax.markup` is
 * `palette.red.l2` and `#f07178` is red's second at L 0.7009; likewise gray
 * (literal at l4), purple and indigo/blue (literal at l3 and l2), and the light
 * green/blue/gray. Nine hues checked that way, every one landing on the predicted
 * step, is strong evidence the ramp table is the scheme's — it is not the same
 * thing as running the generator, and anyone with the repo checked out should
 * re-derive and diff.
 *
 * ONE CLASS THAT IS FULLY CHECKABLE, worth naming because it is the largest block
 * of literals in the CSS: all ten of the dark block's terminal tokens that the
 * YAML gives as a literal or as a plain `$syntax.*` reference — `black` and
 * `brightBlack` `#0a0000`, `white` and `brightWhite` `#ffffff`, and the six
 * brights `#f07178 / #aad94c / #ffb454 / #59c2ff / #d2a6ff / #95e6cb` — match the
 * YAML to the character. Only the six CHROMATIC slots (`red` … `cyan`) are
 * derived there, each as `$syntax.X -L0.07`, and those six are in the
 * checked-not-derived class.
 *
 * ONE CLAIM THIS ROW USED TO MAKE AND NO LONGER DOES: that the npm package
 * `ayu@9.1.0` was run and 21 of its values differ from `master`. It was not run
 * here — `ayu` is not a dependency of this repo and no copy exists on this
 * machine, so the number was unverifiable and has been dropped. What IS
 * verifiable is that the older `editor.fg` reading is real and still shipped:
 * `@shikijs/themes@4.4.3`'s `ayu-dark` states `colors["editor.foreground"] =
 * #bfbdb6`, while the current YAML publishes `editor.fg: FCF8EC A0.74` →
 * `#fcf8ecbd`. Two published revisions of one scheme disagree about the app's
 * single most-used colour, which is the reason the YAML — not a shipped theme
 * file — is the source graded here.
 *
 * THE ALPHA, WHICH IS THE DEFINING CONSTRAINT. Ayu's foregrounds are published
 * as 8-digit alpha (`editor.fg: FCF8EC A0.74` → `#fcf8ecbd`) and its own
 * `AGENTS.md` says why: "text colors are translucent so they blend over any
 * surface", with alpha SCALING by default (`A0.5` multiplies, `=A0.5` sets) so a
 * colour derived from a translucent one stays a fraction of it. De-alphasing
 * `editor.fg` to `#fcf8ec` would raise its own weight from 74% to 100% and
 * silently undo the mechanism. So `--color-foreground` keeps the alpha and the
 * kit composites it (ADR 0105): on `--color-background` `#0d1017` it composites
 * to `#bebcb5` at **10.01**, and its worst RESTING reading in the dark block is
 * **9.55** on the raised `#141821` step (6.70 on the selection state, which is a
 * state and not a resting surface). Alpha is refused on SURFACE tokens for the
 * opposite reason — a translucent surface is not an elevation step — and every
 * surface token in `ayu.css` is therefore an opaque published hex. The audit is
 * in the CSS header: 21 alpha-bearing declarations across both blocks, none of
 * them matching `SURFACE_TOKEN_PATTERN`, none of them a ladder member.
 *
 * THREE DIFFERENT BACKGROUNDS EXIST AND NONE IS THE CODE-BLOCK COLOUR. The spec
 * page says `#0B0E14`, the shipped theme file's `editor.background` says
 * `#10141c`, and Shiki's normalised `bg` says `#0d1017`. The code-block surface
 * must come from `getTheme(<id>).bg` at runtime (ADR 0104 / plan decision 8),
 * never from the spec page and never from `editor.background`.
 *
 * CORRECTING THE RECORD ON THE THIRD NUMBER: this row used to say Shiki emits
 * `#0d1017` "for all three Ayu variants". Measured through `normalizeTheme`
 * against `@shikijs/themes@4.4.3` it does not — `ayu-dark` gives `#0d1017`,
 * `ayu-light` gives `#f8f9fa` and `ayu-mirage` gives `#1f2430`. Each variant
 * emits its OWN `surface.base`; nothing is shared, and a per-variant value cannot
 * be quoted as a constant. (`ayu-dark`'s own two fields still disagree with each
 * other: `tokenColors[].settings.background` is `#0d1017` while
 * `editor.background` is `#10141c`, which is the reason to read `.bg` and not the
 * colour map.) What `#0d1017` IS, legitimately, is `surface.base` — Ayu's own
 * page step, which is why it is the page token here. `#0B0E14` appears nowhere in
 * this row because it is published by none of the machine-readable sources.
 *
 * THE LADDER IS AYU'S OWN VOCABULARY. `surface.sunk / base / lift / over` are the
 * four rungs the scheme ships, and the group LABELS below use those names so a
 * reader can trace each rung to a key in the YAML: `sunk` `#010102` recessed,
 * `base` `#0d1017` the page, `lift` `#10141c` the slab and every float, and above
 * those the two published UI steps the scheme ships for widgets (`ui.panel.bg`
 * `#141821`) and hairlines (`ui.line` `#1b1f29`). `surface.over` `#ffffff` is NOT
 * the fifth rung of the dark ladder: in Ayu's own VS Code reading `#ffffff`
 * appears exactly once, as `terminal.ansiBrightWhite`, so treating it as the
 * brightest surface would invent a role the scheme never gives it. It is the top
 * rung of the LIGHT ladder instead, where `ui.popup.bg: FFFFFF` really does
 * publish it as a surface.
 */

export const spec: PaletteSpec = {
  id: "ayu",
  cssFile: "src/styles/ayu.css",
  baseCssFile: "src/styles/theme.css",
  specSourceUrl:
    "https://github.com/ayu-theme/ayu-colors/blob/master/themes/dark.yaml (+ themes/light.yaml) — the YAML literals were read there directly; the ramp steps and $ref resolutions in publishedHexes were checked structurally against the declared OKLCH range, not re-derived (see this row's header)",
  publishedHexes: [
    // ── DARK (`themes/dark.yaml`, resolved) ────────────────────────────────
    "#000000", // ui.panel.shadow / ui.popup.shadow
    "#010102", // surface.sunk
    "#05a2e5", // palette.blue.l1
    "#0a0000", // terminal.black / terminal.brightBlack
    "#0d1017", // surface.base / ui.bg  (and Shiki's normalised `bg` for ayu-dark)
    "#0f131a", // ui.popup.bg
    "#10141c", // surface.lift / editor.bg
    "#141821", // ui.panel.bg
    "#161a24", // editor.line
    "#17acf2", // terminal.blue
    "#1b1f29", // ui.line
    "#2eb2f6", // palette.blue.l2
    "#30a5cc", // palette.indigo.l1
    "#333b44", // palette.gray.l1
    "#3388ff", // editor.selection.active
    "#39bae6", // palette.indigo.l2 / syntax.tag
    "#404953", // palette.gray.l2
    "#475266", // ui.selection.active / ui.selection.normal
    "#4c4126", // editor.findMatch.active
    "#4cc9f5", // palette.indigo.l3
    "#4d5763", // palette.gray.l3
    "#59c2ff", // palette.blue.l3 / syntax.entity / terminal.brightBlue
    "#5a6673", // palette.gray.l4 / syntax.comment
    "#667381", // palette.gray.l5
    "#69a591", // palette.teal.l1
    "#6dd6ff", // palette.indigo.l4
    "#70bf56", // vcs.added
    "#73b8ff", // vcs.modified
    "#74b59f", // palette.teal.l2
    "#765b24", // common.accent.on
    "#7fc5ae", // palette.teal.l3
    "#80b5ff", // editor.selection.inactive
    "#81a637", // palette.green.l1
    "#84ceb5", // terminal.cyan
    "#85d0ff", // palette.blue.l4
    "#8ad5bc", // palette.teal.l4
    "#8eb73e", // palette.green.l2
    "#95e6cb", // palette.teal.l5 / syntax.regexp / terminal.brightCyan
    "#97c142", // terminal.green
    "#9ae2ff", // palette.indigo.l5
    "#9cc845", // palette.green.l3
    "#aad94c", // palette.green.l4 / syntax.string / terminal.brightGreen
    "#aadeff", // palette.blue.l5
    "#b09165", // palette.peach.l1
    "#b8eb53", // palette.green.l5
    "#b969fd", // palette.purple.l1
    "#c2a070", // palette.peach.l2
    "#c385fe", // terminal.magenta
    "#c4d6fe", // ui.fg / editor.lineNumber / editor.indentGuide
    "#c589fe", // palette.purple.l2
    "#c8872d", // palette.yellow.l1
    "#d2a6ff", // palette.purple.l3 / syntax.constant / terminal.brightMagenta
    "#d5b07c", // palette.peach.l3
    "#d95757", // common.error
    "#dab8ff", // palette.purple.l4
    "#dc9534", // palette.yellow.l2
    "#e1753a", // palette.pink.l1
    "#e3c9ff", // palette.purple.l5
    "#e5730e", // palette.orange.l1
    "#e6495a", // terminal.red
    "#e6b450", // common.accent.tint
    "#e6c08a", // palette.peach.l4 / syntax.special
    "#e89d37", // terminal.yellow
    "#ed834b", // palette.pink.l2
    "#ef616b", // palette.red.l1
    "#f07178", // palette.red.l2 / syntax.markup / terminal.brightRed
    "#f0a33a", // palette.yellow.l3
    "#f0d1a5", // palette.peach.l5
    "#f26d78", // vcs.removed
    "#f29668", // palette.pink.l3 / syntax.operator
    "#f39193", // palette.red.l3
    "#f67e1a", // palette.orange.l2
    "#f6adae", // palette.red.l4
    "#f6b18f", // palette.pink.l4
    "#f9c8c7", // palette.red.l5
    "#facab3", // palette.pink.l5
    "#fcf8ec", // editor.fg  (published as `#fcf8ecbd`; the base, alpha kept in CSS)
    "#ff8f40", // palette.orange.l3 / syntax.keyword
    "#ffad7a", // palette.orange.l4
    "#ffb454", // palette.yellow.l4 / syntax.func / terminal.brightYellow
    "#ffc9a8", // palette.orange.l5
    "#ffcb8f", // palette.yellow.l5
    "#ffffff", // surface.over / terminal.white / terminal.brightWhite
    // ── LIGHT (`themes/light.yaml`, resolved) ──────────────────────────────
    "#020a12", // editor.fg (published as `#020a12a3`)
    "#021a3c", // ui.fg / editor.lineNumber / editor.indentGuide / editor.line
    "#035bd6", // editor.selection.active / .inactive
    "#1a91cd", // palette.blue.l1
    "#22a4e6", // palette.blue.l2 / syntax.entity / terminal.blue
    "#3b9b7c", // palette.teal.l1
    "#3fb3f4", // palette.blue.l3
    "#4393ae", // palette.indigo.l1
    "#44ad8a", // palette.teal.l2
    "#478acc", // vcs.modified
    "#4ca3c1", // palette.indigo.l2
    "#4cbf99", // palette.teal.l3 / syntax.regexp / terminal.cyan
    "#54d0a7", // palette.teal.l4
    "#55b4d4", // palette.indigo.l3 / syntax.tag
    "#5ce1b5", // palette.teal.l5
    "#60c5e7", // palette.indigo.l4
    "#63c1fb", // palette.blue.l4
    "#6b7d8f", // ui.line / ui.selection / ui.panel.shadow / ui.popup.shadow
    "#6cbf43", // vcs.added
    "#719700", // palette.green.l1
    "#75d5f6", // palette.indigo.l5
    "#7ba500", // palette.green.l2
    "#7e4b01", // common.accent.on
    "#86878c", // palette.gray.l1 / terminal.black
    "#86b300", // palette.green.l3 / syntax.string / terminal.green
    "#88cffd", // palette.blue.l5
    "#939498", // palette.gray.l2 / terminal.brightBlack
    "#95c702", // palette.green.l4
    "#9d6fc8", // palette.purple.l1
    "#a0a1a4", // palette.gray.l3
    "#a37acc", // palette.purple.l2 / syntax.constant / terminal.magenta
    "#a5dc04", // palette.green.l5
    "#adaeb1", // palette.gray.l4 / syntax.comment / terminal.white
    "#b190d4", // palette.purple.l3
    "#b37c00", // palette.yellow.l1
    "#b87734", // palette.peach.l1
    "#c0a6dd", // palette.purple.l4
    "#c58900", // palette.yellow.l2
    "#c5c5c8", // palette.gray.l5 / terminal.brightWhite
    "#ce863d", // palette.peach.l2
    "#cf6610", // palette.orange.l1
    "#cfbce5", // palette.purple.l5
    "#d89600", // palette.yellow.l3
    "#e24e37", // palette.pink.l1
    "#e5474f", // palette.red.l1
    "#e59645", // palette.peach.l3 / syntax.special
    "#e65050", // common.error
    "#e77316", // palette.orange.l2
    "#eba400", // palette.yellow.l4 / syntax.func / terminal.yellow
    "#ebeef0", // surface.sunk
    "#ec6a53", // palette.pink.l2
    "#ef8774", // palette.pink.l3
    "#f07171", // palette.red.l2 / syntax.markup / terminal.red
    "#f28886", // palette.red.l3
    "#f29718", // common.accent.tint
    "#f2a191", // palette.pink.l4 / syntax.operator
    "#f3a455", // palette.peach.l4
    "#f49d9a", // palette.red.l4
    "#f5b3a6", // palette.pink.l5
    "#f6b1ae", // palette.red.l5
    "#f8f9fa", // surface.base / ui.bg
    "#f9b677", // palette.peach.l5
    "#fa8532", // palette.orange.l3 / syntax.keyword
    "#fafafa", // ui.panel.bg
    "#fcfcfc", // surface.lift / editor.bg
    "#fe9b5d", // palette.orange.l4
    "#ff7383", // vcs.removed
    "#ffb183", // palette.orange.l5
    "#ffb62b", // palette.yellow.l5
    "#ffe294", // editor.findMatch.active
    // Deliberately ABSENT: `#0B0E14`. It is the background the Ayu SPEC PAGE
    // quotes, and it is published by none of the machine-readable sources
    // (not the YAML, not a resolution of it, not Shiki's `bg`). A hex no
    // source resolves to cannot be a spec value here, and an allow-list entry
    // carrying it would be a free slot.
    //
    // ALSO ABSENT, and this is the entry that used to be here in spirit:
    // `#1e242f`, the composite of `ui.selection.active` over `surface.lift`. The
    // dark block used to declare it as its selection step. It is a real colour
    // and a real derivation, and it is still not published by anything, which is
    // exactly what this set exists to refuse; the block now states
    // `palette.gray.l1` `#333b44` instead, which IS here.
  ],
  offSpecAllowList,
  modes: {
    dark: {
      mode: "dark",
      // Ayu ships FOUR surface steps and the app's ladder takes all four, plus
      // the two published UI steps the scheme defines above `lift` for widgets
      // and hairlines. The group labels are Ayu's own names, so a reader can see
      // the rung came from the scheme and not from a taste call.
      ladderGroups: [
        {
          label:
            "surface.sunk `#010102` — the recessed plane: the cards that live inside the slab (they carry no borders, so sitting below it is the only thing that makes them cards), the chrome band the islands sit in, form controls, popover headers. Ayu derives this step itself (`sunk: $surface.base -L0.1`), so it is the scheme's own idea of 'one notch below the page'",
          tokens: [
            "color-panel",
            "color-frame",
            "color-popover-header",
            "color-input",
            "color-input-focused",
          ],
        },
        {
          label:
            "surface.base `#0d1017` — the page plane, the composer island and the terminal's paper (Ayu's `ui.bg`; and the step Shiki's normalised `ayu-dark` emits as `bg`, which is why the code-block surface is read from `getTheme(...).bg` and never hardcoded from here)",
          tokens: ["color-background", "color-composer", "color-terminal-bg"],
        },
        {
          label:
            "surface.lift `#10141c` — the content slab, the inspector and every float (header, tabs, menus, popovers, toasts, tooltips). Ayu's `editor.bg`, and the step its port gives `editorWidget.background`'s neighbours",
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
            "ui.panel.bg `#141821` — RAISED: cards, badges, the inline-code chip, menu hover. Ayu's own `editorWidget.background` / `dropdown.background` step, i.e. the value the scheme uses for things that sit ON a panel",
          tokens: [
            "color-card",
            "color-secondary",
            "color-tag",
            "color-tooltip-tag",
            "color-menu-hover",
          ],
        },
        {
          label:
            "ui.line `#1b1f29` — the context bar's TRACK. A rail ON the pane, never a groove cut into it, so it is the one published step above the slab that is not a fill (`panel.border`, `editorGroup.border`, `widget.border` are all this value in Ayu's port)",
          tokens: ["color-context-track"],
        },
      ],
      // Ayu publishes its selection as ALPHA (`ui.selection.active: 475266
      // A0.25`), and an alpha surface is not an elevation step (ADR 0105), so the
      // block had to state an opaque step. It states `palette.gray.l1` `#333b44` —
      // a value the YAML publishes — and it is brighter than every resting group,
      // which is the property the rule below asserts (L 0.042491 against the
      // hairline rung's 0.013731).
      //
      // WHY THAT STEP AND NOT AYU'S SELECTION COLOUR COMPOSITED: the composite
      // `#1e242f` is not published by any source, so keeping it meant keeping an
      // allow-list exception, and an exception nobody needs is a free slot for the
      // next token. The two cheaper published steps (`editor.line` `#161a24`,
      // `ui.line` `#1b1f29`) hold the text but separate from the raised card by
      // only 1.021 and 1.078 — a selected row that does not read as selected — and
      // `#161a24` is dimmer than the hairline, so it cannot be the brightest thing
      // the palette owns. `gray.l2` `#404953` buys separation and costs the text on
      // the state (subtlest falls to 3.51). The measurement is at the declaration.
      selectionRule: "strictly-above-all",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      // EMPTY, and that is the assertion: `surface.over` `#ffffff` is NOT
      // exempted as an off-ladder surface because it is not a surface at all in
      // the dark reading (see the header — one use in Ayu's port,
      // `terminal.ansiBrightWhite`), and every token the block declares that IS
      // a surface is classified in a group above.
      ladderExemptions: {},
      textSurfaces: {
        // The planes copy actually lands on: the page, the slab, two floats and
        // the two recessed wells. `panel`/`input` are the deepest rung, so they
        // belong with the resting class and not the raised one — the island
        // layout made `panel` the surface the borderless cards paint on.
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
      // Every graded text token clears 4.5 on the resting surfaces — the tightest
      // is `foreground-subtlest` at 5.05 on the slab `#10141c` — so there are no
      // resting overrides. See the CSS block for how that floor was reached without
      // de-alphasing a foreground.
      textFloors: {},
      // Same story on the raised step: the tightest is `foreground-subtlest` at
      // 5.01 on `#141821`, and `destructive` reaches 4.61 there — over the floor,
      // so unlike Dracula this Palette needs no raised exemption. (Dracula's
      // exists because its brightest published red lands at 4.33; Ayu's does not
      // have that problem on a resting surface, only on its selection state.)
      raisedFloors: {},
      selectedFloors: {
        "color-destructive": {
          floor: 2.9,
          reason:
            "#d95757 is `common.error`, the only value Ayu publishes for 'this failed', and it reaches 2.95 on the selection step #333b44 (4.61 on the raised step, 4.79 on the slab, 4.94 on the page — so this is the selection state alone, and a transient one). The shortfall is the price of the step: `#333b44` is the only published dark value that is both brighter than every resting rung and separated enough from the raised card to read as selected (1.565, against 1.021/1.078 for the two cheaper steps). No published red fixes it: palette.red.l2 #f07178 is `syntax.markup`, and l3 #f39193 upward are pale pinks that would read as a selection tint everywhere else they appear. Ratchet: delete this the day it clears 4.5.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 4.0,
          reason:
            "editor.fg's hue at 50% reaches 4.01 on the selection step #333b44 (5.09 on the page, 5.05 on the slab, 5.01 on raised — every resting and raised reading clears 4.5). Lightening it does not escape: 55% reaches 4.48 there and still misses, and 60% would equal `foreground-subtle`, collapsing two de-emphasis steps into one. Recorded as the state's wall rather than moved, exactly as Dracula's `selectedFloors` entry for the same token makes the same trade for the same reason.",
          expiresAt: 4.5,
        },
      },

      // Ayu states every text reading as a literal hex or an 8-digit alpha, both
      // of which the kit resolves. An EMPTY map here is a real assertion: the kit
      // fails any entry it names, and grading every graded token is the point.
      textUngradeable: {},
      // The 54 tokens `.theme-default-dark` declares that this block deliberately
      // does NOT — the Identity-color families (the 11 usage scales, the 7
      // context-breakdown steps, the 8 git hues, the 18 role chips, the privacy
      // hint) whose HUE is the signal, and the white overlays (the 3 workflow
      // lines, hover/selected/surface/surface-hover and the 2 gradient-wordmark
      // tokens), which are luminance rather than hue and so read correctly over
      // any dark surface. Per ADR 0027's completeness consequence, inherited is a
      // decision that has to be written down, because an omitted token does not
      // fail — it silently inherits.
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
      // The 6 RAMP tokens. They live in `.dark` + `@theme` (raw Tailwind hues a
      // Palette cannot move from a component), and this block is the third
      // reading — built from Ayu's `l1` steps, which is the scheme's own answer
      // to "five ordered steps of one hue". See the CSS block for the ordering
      // proof and the collision audit.
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

    light: {
      mode: "light",
      // Ayu's light steps run `sunk < base < lift < over` in luminance
      // (0.85103 < 0.94610 < 0.95600 < 0.97345 < 1.00000), so the light ladder
      // ASCENDS on the scheme's own vocabulary and needs no plateau at all —
      // `ui.panel.bg` `#fafafa` is a published step between `base` and `lift`
      // that makes the slab sit between them. That is a better outcome than
      // `default-light`, which has to answer with a white plateau (ADR 0105), and
      // it is why `card`/`menu-hover` can be a real raised step here instead of
      // collapsing onto the page.
      ladderGroups: [
        {
          label:
            "surface.sunk `#ebeef0` — the recessed plane: the cards inside the slab, the chrome band, form controls, and the quiet fills (badge, inline-code chip) that a light reading puts BELOW its page rather than above it",
          tokens: [
            "color-panel",
            "color-frame",
            "color-input",
            "color-input-focused",
            "color-secondary",
            "color-tag",
            "color-tooltip-tag",
          ],
        },
        {
          label:
            "surface.base `#f8f9fa` — the page plane, the composer, the tab strip, the popover header and the terminal's paper (Ayu's `ui.bg`)",
          tokens: [
            "color-background",
            "color-composer",
            "color-tab",
            "color-popover-header",
            "color-terminal-bg",
          ],
        },
        {
          label:
            "ui.panel.bg `#fafafa` — the content slab, the inspector and the chrome floats (Ayu's `editorWidget.background` / `dropdown.background` step)",
          tokens: ["color-chat", "color-inspector", "color-header", "color-background-win-alt", "color-tab-active"],
        },
        {
          label:
            "surface.lift `#fcfcfc` — every float that opens over the slab (menu, popover, toast, tooltip). Ayu's `editor.bg`, one step above the widgets",
          tokens: ["color-menu", "color-popover", "color-toast", "color-tooltip"],
        },
        {
          label:
            "surface.over `#ffffff` — RAISED (cards, menu hover) AND the context bar's track. In the LIGHT reading Ayu really does publish `over` as a surface: `ui.popup.bg: FFFFFF`. The track rides the `ui.panel.bg` pane and must be LIGHTER than it (a track below its plane is a groove, and the groove was rejected twice as a white); `#ffffff` is the only published light step that is",
          tokens: ["color-card", "color-menu-hover", "color-context-track"],
        },
      ],
      // `surface.over` is the top rung, so the selection state cannot be brighter
      // than every resting step — nothing in a light palette is brighter than
      // white. `--color-card-selected` is `var(--color-card)`, i.e. the top rung
      // itself, exactly as `default-light` answers the same problem. The property
      // that matters for a selected row is that it never sinks below its surface.
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      ladderExemptions: {},
      textSurfaces: {
        // The same six planes as the dark reading, plus the recessed `sunk` step
        // twice over (`panel`/`input`) — which is the WORST light surface for
        // text (L 0.85103), so grading only the page would report a floor the app
        // never renders.
        resting: [
          "color-background",
          "color-chat",
          "color-popover",
          "color-tooltip",
          "color-panel",
          "color-input",
        ],
        raised: ["color-card", "color-menu-hover"],
        // `--color-card-selected` is `var(--color-card)` == `#ffffff`, which the
        // raised class already grades. Re-listing it would restate a hex already
        // measured and force a second copy of every floor to agree with the first.
        selected: [],
      },
      // THE LIGHT READING'S RECORDED WALLS. Ayu publishes its status hues as
      // syntax hues, and a syntax hue is tuned to read on a DARK page; the light
      // scheme's own `common.error` `#e65050` reaches 3.20 on the recessed
      // `#ebeef0` step and `syntax.string` `#86b300` reaches 2.13 there. Each
      // floor below is therefore set on the DARKEST published step of the right
      // hue (`palette.<hue>.l1` — the scheme's own "readable on light" end of the
      // ramp) and recorded with the number it reaches, exactly as
      // `.theme-default-light` records its four. None is a fix and none is a
      // fudge: `text-destructive` / `text-warning` / `text-success` are consumed
      // as text, so the alternative to recording the wall is inventing a hex the
      // scheme does not publish. Every floor carries `expiresAt: 4.5`.
      textFloors: {
        "color-destructive": {
          floor: 3.3,
          reason:
            "worst resting reading: palette.red.l1 #e5474f is 3.37 on the recessed #ebeef0 step (3.73 on the #f8f9fa page, 3.93 on white). Ayu's own common.error #e65050 is worse still at 3.20 there; #e5474f is the darkest published step of the red ramp. `text-destructive` is the app's most-used status text.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 2.9,
          reason:
            "worst resting reading: palette.green.l1 #719700 is 2.94 on the recessed #ebeef0 step (3.25 on the page, 3.43 on white). Ayu's syntax.string #86b300 reaches only 2.13 there — the light scheme publishes no green that clears 4.5 on its own Base.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 3.2,
          reason:
            "worst resting reading: palette.orange.l1 #cf6610 is 3.24 on the recessed #ebeef0 step (3.58 on the page, 3.78 on white). syntax.keyword #fa8532 is 2.13 there — the light scheme's own orange is no better than its green.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.1,
          reason:
            "worst resting reading: palette.yellow.l1 #b37c00 is 3.11 on the recessed #ebeef0 step (3.43 on the page, 3.62 on white). `caution` also paints the context bar's percentage LABEL, so it is held to the text floor and not the 3:1 glyph floor.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 4.2,
          reason:
            "worst resting reading: editor.fg's hue #020a12 at 55% is 4.24 on the recessed #ebeef0 step (4.35 on the page, 4.44 on white). Ayu publishes exactly two text steps — editor.fg at 64% and ui.fg #021a3c at 48% — and ui.fg at its published alpha reaches only 3.05 on #ebeef0, so 55% of editor.fg is the nearest published-hue reading that stays visibly DIMMER than foreground-subtle (60%).",
          expiresAt: 4.5,
        },
      },
      raisedFloors: {
        "color-destructive": {
          floor: 3.9,
          reason: "the #ffffff raised step: #e5474f reaches 3.93 there.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 3.4,
          reason: "the #ffffff raised step: #719700 reaches 3.43 there.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 3.7,
          reason: "the #ffffff raised step: #cf6610 reaches 3.78 there.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.6,
          reason: "the #ffffff raised step: #b37c00 reaches 3.62 there.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 4.4,
          reason:
            "the #ffffff raised step: editor.fg's hue at 55% reaches 4.44 there (4.24 on the recessed resting step, which `textFloors` records). 60% would clear 4.5 but then sits only 1.193 above foreground-subtle on this step, and a de-emphasis token that does not de-emphasise is the worse bug — Dracula's selectedFloors record makes the same trade for the same reason.",
          expiresAt: 4.5,
        },
      },
      selectedFloors: {},
      textUngradeable: {},
      // The dark reading's 54, PLUS the 25 file-type DESCRIPTORS. A light reading
      // must not restate them: `@theme` holds all 25 light-safe readings and a
      // light block would SHADOW them for a classless document. This is the same
      // argument `.theme-default-light`'s row records, and it is why the light
      // reading's descriptor set is inherited rather than re-hued.
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
      // ONE token, and the reason is specific: `caution` carries a TEXT label (the
      // context bar's percentage), so the light reading moves it to the readable
      // end of Ayu's yellow ramp. The five thinking LEVELS are 3:1 indicator
      // GLYPHS whose light-safe `@theme` readings already clear that floor on a
      // light surface, so the light block stays silent on them — the same
      // reasoning `.theme-default-light` records for the whole family. Naming
      // `color-thinking-low` here would put this block into the ramp gate's
      // enumeration, and it does not ship a ramp.
      extraBeyondDefault: ["color-caution"],
      declaredCount: 90,
    },
  },
};
