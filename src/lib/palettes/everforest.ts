import { SURFACE_TOKEN_PATTERN, type PaletteSpec } from "../paletteSpec";

/**
 * The 25 file-type DESCRIPTORS, in the order `paletteCompleteness.test.ts` lists
 * them. `file-node*` are NOT here — they are the file-row ROLE CHIP and ride
 * `.dark`'s reading rather than being restated by a Palette.
 *
 * Everforest needs 24 of them allow-listed, and the shape is the one all five
 * merged Palettes are in for the same reason: `palette.md` publishes TEN dark
 * hues (`fg`, `red`, `orange`, `yellow`, `green`, `aqua`, `blue`, `purple`,
 * `grey0/1/2`) and there are 25 file types. Re-huing the descriptors to the spec
 * set would make a `.py` chip indistinguishable from a `.json` one, and the hue IS
 * the only thing distinguishing them — so the **Identity color** rule
 * (`CONTEXT.md`) knowingly outranks the spec's "use exact color values from this
 * specification". Listed BY NAME, never by family, because an entry that excuses a
 * whole family is how an allow-list stops meaning anything.
 *
 * `color-file-css` is deliberately ABSENT from the list below, exactly as it is
 * from Dracula's, Catppuccin's, Rosé Pine's and Kanagawa's: this block re-reads it
 * at Everforest's OWN published `purple #d699b6`, so it is on-spec and needs no
 * exception. Allow-listing it anyway would be a HARD FAILURE, not a formality —
 * `gradePalette`'s unused-exception rule convicts any entry carrying no off-spec
 * hex, and a re-read published hex carries none (the packet measured it:
 * allow-listing all 25 while `file-css` is `#d699b6` yields
 * `offenders: ["color-file-css"]`).
 *
 * Every reason below carries THIS descriptor's own worst measured reading on a
 * `rendered` plane (`--color-chat #2e383c`, the tightest of the three the gate
 * grades), because `rendered` surfaces have no exemption path at all — the reason
 * an entry exists is provably hue-identity, never "it did not measure well".
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

/** Per-token worst ratio on `--color-chat #2e383c`, measured with the kit (see the
 *  report's worst-ratio table). `ts`/`py` and `sass`/`graphql` etc. share a hue in
 *  `.theme-default-dark` itself, so those entries say so rather than pretending
 *  this Palette introduced the collision. */
const WORST_ON_CHAT: Record<string, string> = {
  "color-file-ts": "3.1166",
  "color-file-react": "5.2338",
  "color-file-js": "7.8593",
  "color-file-json": "6.0991",
  "color-file-html": "3.1719",
  "color-file-sass": "3.1944",
  "color-file-md": "4.5403",
  "color-file-rs": "4.3791",
  "color-file-py": "3.1166",
  "color-file-sh": "4.3791",
  "color-file-yaml": "3.7667",
  "color-file-toml": "8.3046",
  "color-file-lock": "8.5185",
  "color-file-image": "4.0087",
  "color-file-svg": "6.6969",
  "color-file-archive": "5.3725",
  "color-file-go": "4.3908",
  "color-file-vue": "4.8130",
  "color-file-svelte": "3.7997",
  "color-file-java": "3.2641",
  "color-file-php": "3.2673",
  "color-file-xml": "5.7254",
  "color-file-graphql": "3.1944",
  "color-file-db": "7.8593",
};

/** The hue each descriptor shares with another, inherited from Default verbatim. */
const SHARES: Record<string, string> = {
  "color-file-ts": "py",
  "color-file-py": "ts",
  "color-file-sass": "graphql",
  "color-file-graphql": "sass",
  "color-file-rs": "sh",
  "color-file-sh": "rs",
  "color-file-js": "db",
  "color-file-db": "js",
};

/** The literal hex each descriptor carries in this block (== `.theme-default-dark`'s,
 *  except `file-css`, which is re-read and therefore not allow-listed). Kept as data
 *  so the 24 reasons above cannot drift from the CSS they describe. */
const DEFAULT_DARK_DESCRIPTOR_HEX: Record<string, string> = {
  "color-file-ts": "#0288d1",
  "color-file-react": "#00bcd4",
  "color-file-js": "#ffca28",
  "color-file-json": "#f9a825",
  "color-file-html": "#e65100",
  "color-file-css": "#d699b6", // re-read at Everforest's own purple — NOT allow-listed
  "color-file-sass": "#ec407a",
  "color-file-md": "#42a5f5",
  "color-file-rs": "#ff7043",
  "color-file-py": "#0288d1",
  "color-file-sh": "#ff7043",
  "color-file-yaml": "#ff5252",
  "color-file-toml": "#cfd8dc",
  "color-file-lock": "#ffd54f",
  "color-file-image": "#26a69a",
  "color-file-svg": "#ffb300",
  "color-file-archive": "#afb42b",
  "color-file-go": "#00acc1",
  "color-file-vue": "#41b883",
  "color-file-svelte": "#ff5722",
  "color-file-java": "#f44336",
  "color-file-php": "#1e88e5",
  "color-file-xml": "#8bc34a",
  "color-file-graphql": "#ec407a",
  "color-file-db": "#ffca28",
};

const offSpecAllowList = Object.fromEntries(
  FILE_DESCRIPTORS.filter((token) => token !== "color-file-css").map((token) => {
    const hex = DEFAULT_DARK_DESCRIPTOR_HEX[token]!;
    const shared = SHARES[token];
    const reason =
      `${hex} copied verbatim from .theme-default-dark: Everforest publishes ten dark hues and cannot name 25 file types ` +
      `without collapsing two chips onto one hue, and the hue IS the signal (CONTEXT.md's Identity color rule outranking the spec). ` +
      `Clears the 3:1 glyph floor on every rendered plane (worst ${WORST_ON_CHAT[token]} on --color-chat #2e383c)` +
      (shared
        ? `. Shares ${hex} with the \`${shared}\` descriptor — .theme-default-dark's own collision, inherited verbatim rather than introduced here`
        : `. Unique within the descriptor set, so this chip is distinguishable by hue alone`) +
      ".";
    return [token, reason];
  }),
);

/**
 * Everforest's grading row — `hard` (dark) and `medium` (light).
 *
 * WHERE THE VALUES COME FROM, and it is a cleaner case than Kanagawa's: one file,
 * hash-verified. `palette.md`
 * (https://github.com/sainnhe/everforest/blob/master/palette.md, raw
 * https://raw.githubusercontent.com/sainnhe/everforest/master/palette.md, sha256
 * `76c4b1a1bb612a0bdb39db0f5af944ea2fb83495423398e7dfb6d540c7120414`, 21,927
 * bytes, 100 distinct hexes) was fetched and hash-compared rather than
 * spot-checked, its 27-row highlights table cross-checked swatch-against-hex (0
 * mismatches) and every link-reference label cross-checked against the hex in its
 * own URL (0 mismatches). `publishedHexes` below is that file's 100 hexes, carried
 * IN THE CASE THE FILE WRITES THEM: `#45443c` (`bg_yellow`, dark `hard`) and
 * `#56635f` (`bg5`, dark `medium`) are lowercase there and uppercase everywhere
 * else. `gradePalette` lowercases before comparing so this is not a gate risk — it
 * is carried that way so the next reader does not "fix" a typo that is not there.
 * (`#BDC3AF`, the light `bg5`, is uppercase in the source; the CSS writes it
 * lowercase and `gradePalette` compares case-insensitively.)
 *
 * THE ONE DEPARTURE, and it is the spec's own dial rather than an invented value.
 * `palette.md` names three contrast levels and marks `medium` the default; this
 * row's DARK reading takes `hard`. That is a recorded, measured departure, not a
 * preference, and it exists because of a wall with no allow-list path: the 25
 * file-type DESCRIPTORS are Identity hues, `fileIconContrast.test.ts` grades all 25
 * at 3:1 on `--color-background`, `--color-chat` and `--color-panel`, and a
 * `rendered` surface has no exemption of any kind. With `--color-file-css` at the
 * Default palette's `#7e57c2` an exhaustive search of all 39 published dark steps ×
 * every ordered 4-rung assignment (39⁴ = 2,313,441 candidates) found **zero**
 * ladders that keep every rendered plane safe — only `hard/bg_dim` is dark enough
 * for that hue, and the pill rule needs the page ≠ the panel. Re-reading
 * `--color-file-css` at Everforest's own `purple #d699b6` (the move all five merged
 * Palettes make, each with its own published violet) lifts the ceiling to L ≤
 * 0.04075, and at that point `hard` is the ONLY level with three steps under it:
 * `hard` has `bg_dim`/`bg0`/`bg1`, `medium` has two, `soft` has one, and every
 * `medium` and every `soft` shape leaves ≥5 descriptors under 3:1 on a `rendered`
 * plane. `hard` is therefore forced by the app's planes, not chosen for its look.
 * The light reading keeps the spec's `medium`, because the wall is a dark wall (a
 * dark hue on a pale ground gets BETTER as the ground lightens) — 0 of 25 fail on
 * any light plane this block uses.
 *
 * WHAT THAT BUYS, measured: 0 exemptions, 0 invented hexes, 0 new
 * `FORBIDDEN_SURFACE_FAILURES` lines, and the dark ladder strictly ascending. The
 * price is recorded too — a sub-floor slab/float hop of 1.1473, and the fact that
 * `hard` is the scheme's LOW-contrast flavour, so the dark reading is subtler than
 * Everforest as most users meet it. Both are stated in `src/styles/everforest.css`
 * and mirrored in the ladder labels and floors below.
 */
export const spec: PaletteSpec = {
  id: "everforest",
  cssFile: "src/styles/everforest.css",
  baseCssFile: "src/styles/theme.css",
  specSourceUrl: "https://github.com/sainnhe/everforest/blob/master/palette.md",
  publishedHexes: [
    // ── dark palette1, `hard` (the level the DARK reading takes) ──────────────
    "#1E2326", // bg_dim
    "#272E33", // bg0
    "#2E383C", // bg1
    "#374145", // bg2
    "#414B50", // bg3
    "#495156", // bg4      — the selection step
    "#4F5B58", // bg5      — published "Not currently used"
    "#4C3743", // bg_visual
    "#493B40", // bg_red
    "#45443c", // bg_yellow — LOWERCASE in the source; carried as published
    "#3C4841", // bg_green
    "#384B55", // bg_blue
    "#463F48", // bg_purple
    // ── dark palette1, `medium` (the spec's default level; unused here) ───────
    "#232A2E", // bg_dim
    "#2D353B", // bg0
    "#343F44", // bg1
    "#3D484D", // bg2
    "#475258", // bg3
    "#4F585E", // bg4
    "#56635f", // bg5      — LOWERCASE in the source; carried as published
    "#543A48", // bg_visual
    "#514045", // bg_red
    "#4D4C43", // bg_yellow
    "#425047", // bg_green
    "#3A515D", // bg_blue
    "#4A444E", // bg_purple
    // ── dark palette1, `soft` ─────────────────────────────────────────────────
    "#293136", // bg_dim
    "#333C43", // bg0
    "#3A464C", // bg1
    "#434F55", // bg2
    "#4D5960", // bg3
    "#555F66", // bg4
    "#5D6B66", // bg5
    "#5C3F4F", // bg_visual
    "#59464C", // bg_red
    "#55544A", // bg_yellow
    "#48584E", // bg_green
    "#3F5865", // bg_blue
    "#4E4953", // bg_purple
    // ── dark palette2 (foregrounds; statusline reuses green/fg/red) ───────────
    "#D3C6AA", // fg
    "#E67E80", // red
    "#E69875", // orange
    "#DBBC7F", // yellow
    "#A7C080", // green
    "#83C092", // aqua
    "#7FBBB3", // blue
    "#D699B6", // purple   — the value --color-file-css is re-read at
    "#7A8478", // grey0
    "#859289", // grey1
    "#9DA9A0", // grey2
    // ── light palette1, `hard` ────────────────────────────────────────────────
    "#F2EFDF", // bg_dim == bg2 (ONE published hex for both slots)
    "#FFFBEF", // bg0
    "#F8F5E4", // bg1
    "#EDEADA", // bg3
    "#E8E5D5", // bg4
    "#BEC5B2", // bg5
    "#F0F2D4", // bg_visual
    "#FFE7DE", // bg_red
    "#FEF2D5", // bg_yellow
    "#F3F5D9", // bg_green
    "#ECF5ED", // bg_blue
    "#FCECED", // bg_purple
    // ── light palette1, `medium` (the level the LIGHT reading takes) ──────────
    "#EFEBD4", // bg_dim == bg2
    "#FDF6E3", // bg0      — the lightest published light value: the top plateau
    "#F4F0D9", // bg1
    "#E6E2CC", // bg3
    "#E0DCC7", // bg4
    "#BDC3AF", // bg5      — the darkest published light value: the context track
    "#EAEDC8", // bg_visual
    "#FDE3DA", // bg_red
    "#FAEDCD", // bg_yellow
    "#F0F1D2", // bg_green
    "#E9F0E9", // bg_blue
    "#FAE8E2", // bg_purple
    // ── light palette1, `soft` ────────────────────────────────────────────────
    "#E5DFC5", // bg_dim == bg2
    "#F3EAD3", // bg0
    "#EAE4CA", // bg1
    "#DDD8BE", // bg3
    "#D8D3BA", // bg4
    "#B9C0AB", // bg5
    "#E1E4BD", // bg_visual
    "#FADBD0", // bg_red
    "#F1E4C5", // bg_yellow
    "#E5E6C5", // bg_green
    "#E1E7DD", // bg_blue
    "#F1DDD4", // bg_purple
    // ── light palette2 (foregrounds, incl. the three statusline values) ───────
    "#5C6A72", // fg       — the ONLY published light foreground
    "#F85552", // red
    "#F57D26", // orange
    "#DFA000", // yellow
    "#8DA101", // green
    "#35A77C", // aqua
    "#3A94C5", // blue
    "#DF69BA", // purple
    "#A6B0A0", // grey0
    "#939F91", // grey1
    "#829181", // grey2
    "#93B259", // statusline1
    "#708089", // statusline2
    "#E66868", // statusline3
  ],
  offSpecAllowList,
  modes: {
    /* ══════════════════════════════════════ LIGHT — `medium` ═══════════════════
     * The light reading is the half ADR 0105 exists for: no light theme publishes
     * anything LIGHTER than its own Base, so the ladder is non-decreasing with the
     * plateau at the TOP, and the selection state cannot be "the brightest step"
     * the way the dark reading's is.
     *
     * `bg0 #fdf6e3` is the lightest value the `medium` level publishes, so it is
     * the top plateau — the move `default-light` makes with its `#ffffff` and
     * Kanagawa Lotus makes with `lotusWhite3`. Six groups, strictly ascending into
     * that plateau: `#bdc3af` 0.52944 → `#e0dcc7` 0.71157 → `#e6e2cc` 0.75575 →
     * `#efebd4` 0.82521 → `#f4f0d9` 0.86563 → `#fdf6e3` 0.92340, hops 1.3143 /
     * 1.0580 / 1.0862 / 1.0462 / 1.0631. The tight hops are the scheme's own and
     * the pair the 1.2 floor actually grades — the context track `#bdc3af` against
     * the pane it rides `#f4f0d9` — clears it at **1.5802**.
     *
     * `bg_dim` AND `bg2` ARE ONE PUBLISHED HEX (`#efebd4`, labelled "bg_dim/bg2" by
     * the source) and therefore cannot be two rungs. THE PAGE GROUP HOLDS THEM:
     * `--color-background`, `--color-composer`, `--color-background-win-alt` and
     * `--color-terminal-bg` all sit on that one step, and `bg2` is used NOWHERE as
     * a separate rung. Splitting them would have made two rungs 1.0000 apart, which
     * the ladder gate correctly refuses. The near-miss worth recording is
     * `bg_visual #eaedc8` — 0 of 25 for descriptors and a tempting free rung, but
     * L 0.82231 against `bg_dim`'s 0.82521, i.e. **1.0033** apart: a plateau in the
     * middle of a ladder, which ADR 0105 allows only at the top. It is used only as
     * a tint (`--color-find-highlight`), never as a plane. */
    light: {
      mode: "light",
      ladderGroups: [
        {
          label:
            "the context bar's TRACK — `bg5 #bdc3af`, the DARKEST published light value (L 0.52944) and the one rung whose job is separation rather than plane. It rejects 25 of 25 descriptors at 3:1 (worst file-svelte 1.9985), and the consumer census is what makes that legal: a track is a rail and carries no file glyph. Against the pane it rides (--color-chat #f4f0d9) it scores 1.5802, over slabFloatSeparation's 1.2 floor — and the step above it (#e0dcc7) would score only 1.2023, so this rung is the one with real headroom, as well as the scheme's own mark-on-a-light-ground step",
          tokens: ["color-context-track"],
        },
        {
          label:
            "THE MARKS — `bg4 #e0dcc7`, the scheme's own quiet-mark step (\"Window Splits Separators, Whitespaces, Breaks\"). In a LIGHT reading a badge and a hover state are DARKER than the surface they sit on, the exact inverse of the dark block where they are the brightest; that inversion is ADR 0105's measurement for why group membership is per-reading data (default-light's secondary #e6e6e6 sits BELOW its card #ffffff). This rung rejects 19 of 25 descriptors and carries none — these fills hold TEXT, graded by the 4.5 floors below, not by the 3:1 glyph floor",
          tokens: [
            "color-secondary",
            "color-tag",
            "color-tooltip-tag",
            "color-menu-hover",
          ],
        },
        {
          label:
            "THE CHROME BAND — `bg3 #e6e2cc`, DARKER than the page it frames exactly as default-light's #f0f0f0 is darker than its #f8f8f8. It is the scheme's \"List Chars, Special Keys, Tab Line Label Background (inactive)\" step: the colour for things drawn but not read. It rejects 19 of 25 descriptors and the census names no raw descriptor on it (session rows and section headers wear the inherited role chips and text tokens), and it is the BINDING surface for every text token in this reading — the 4.2863 wall on --color-foreground is measured here",
          tokens: ["color-frame"],
        },
        {
          label:
            "THE PAGE PLANE — `bg_dim #efebd4`, the scheme's \"Dimmed Background\". THIS GROUP HOLDS BOTH `bg_dim` AND `bg2`: palette.md publishes the SAME hex for the two slots in all three contrast levels (its label reads \"bg_dim/bg2\"), so they cannot be two rungs and `bg2` is used nowhere else. The page sits below the slab so the content column reads as lifted without a border, and below the plateau so the pill rule (page ≠ card, page ≠ panel) holds",
          tokens: [
            "color-background",
            "color-composer",
            "color-background-win-alt",
            "color-terminal-bg",
          ],
        },
        {
          label:
            "THE CONTENT SLAB — `bg1 #f4f0d9`, the scheme's \"Cursor Line Background … Tab Line Background\". One token for the transcript column, the side pane and the active tab, so they cannot drift apart. 0 of 25 descriptors fail here (worst file-svelte 3.1580), which is the property the slab needs because FileChip rides it",
          tokens: ["color-chat", "color-inspector", "color-tab-active"],
        },
        {
          label:
            "THE PLATEAU — `bg0 #fdf6e3`, the scheme's \"Default Background\" and the LIGHTEST value the level publishes, so it is where a light reading is ALLOWED to plateau (ADR 0105) and the only group here that plateaus. Card, header, panel, the recessed controls, the tab strip and every float are ONE colour and cannot be separated by fill at all; separation is carried by --color-card-border and a float's shadow, which is what ADR 0096's designed collapse means and why slabFloatSeparation.test.ts reads the float components. --color-panel is on the plateau rather than recessed the way Kanagawa Lotus recesses its own, and the census forces it: the code-block header rides --color-panel, so that plane must sit on a 0-of-25 step, and Lotus's recessed #d5cea3 rejects 20",
          tokens: [
            "color-card",
            "color-header",
            "color-panel",
            "color-input",
            "color-input-focused",
            "color-tab",
            "color-menu",
            "color-popover",
            "color-toast",
            "color-tooltip",
          ],
        },
      ],
      /* `--color-card-selected` is `var(--color-card)` — the plateau itself.
       * Everforest light publishes nothing lighter than `bg0`, so
       * "strictly-above-all" is not satisfiable here and would veto the scheme
       * rather than describe it. `at-or-above-card` is the property that actually
       * matters — a selected row must not SINK below the surface it sits on — and
       * it is the rule `default-dark`, `default-light` and Kanagawa Lotus already
       * use. (The dark reading takes the other rule and can afford it, because
       * `hard/bg4` sits above every resting rung there.) A selected row here reads
       * by its ring and its foreground, not by elevation. */
      selectionRule: "at-or-above-card",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      /* EMPTY. Every surface token this block declares is a plane and is classified
       * above, including `--color-context-track`, which is a literal step on this
       * palette's own ladder and not Default's `var()` into a TEXT token (that alias
       * is why Default needs an exemption and this reading does not). A stale
       * exemption fails, so this stays empty deliberately. */
      ladderExemptions: {},
      textSurfaces: {
        /* Five resting planes over FOUR distinct published rungs. `frame` (#e6e2cc,
         * the chrome band) is in the class because chrome carries copy — the
         * sidebar's section headers, the session rows — and it is the BINDING
         * surface for every text token in this reading; grading only the page would
         * report 4.66 where the app renders 4.2863. `panel` is in it because the
         * code-block header paints on it, and it is named even though the plateau
         * collapses it onto the SAME hex as `popover` (#fdf6e3) — the census says a
         * glyph and its label ride the panel, so the row says so out loud rather
         * than letting a future de-plateau silently ungrade it. The plateau's copy
         * is graded once through `popover`. */
        resting: [
          "color-background",
          "color-chat",
          "color-frame",
          "color-popover",
          "color-panel",
        ],
        /* The RAISED class is the DARK step here (`bg4 #e0dcc7`): what makes a
         * badge raised is that it lands ON something, not which direction it moves
         * in. Same three tokens are the brightest rung in the dark block. */
        raised: ["color-secondary", "color-tag", "color-menu-hover"],
        /* EMPTY, and it is a measurement: `--color-card-selected` is
         * `var(--color-card)` == `#fdf6e3` == `--color-popover` == `--color-panel`,
         * which the resting class already grades. Re-listing it would restate a hex
         * already measured and force a second copy of every floor to agree with the
         * first. The STATE is still graded, as a ladder relation, by `selectionRule`. */
        selected: [],
      },
      /* Every entry is a RECORDED WALL against the 4.5 text floor, and the worst
       * reading in its class, measured with the kit against the plane the copy
       * actually lands on. None is fixed here, because for most of them there is
       * nothing to fix it WITH: `fg #5c6a72` is the ONLY foreground `palette2`
       * publishes for light and is the DARKEST published light value of any kind
       * (L 0.13798 — `statusline2 #708089` is 0.20689 and `grey0` is 0.41696, both
       * LIGHTER), so on the chrome band there is no published value to move it to.
       * Every one carries `expiresAt: 4.5` so the exemption dies the day the hue
       * clears the floor, and none was re-hued to make a wall disappear. */
      textFloors: {
        "color-foreground": {
          floor: 4.28,
          reason:
            "worst resting reading, and the scheme's ceiling rather than a pick: fg #5c6a72 reaches 4.2863 on the #e6e2cc chrome band (4.66 on the page, 4.87 on the slab, 5.18 on the plateau). NOTHING in palette.md is darker — fg is L 0.13798 and the next candidate down, statusline2 #708089, is L 0.20689 and would read WORSE — so there is no published value to move it to. The alternative is named so it can be overruled with numbers: putting the chrome band on the page step (#efebd4) lifts fg to 4.66 and clears the floor, but it makes the chrome band the page and gives up the frame/page separation every merged reading keeps. The chrome band is where the app puts its quietest copy, so this reading pays 0.21 there rather than lose the band.",
          expiresAt: 4.5,
        },
        "color-foreground-subtle": {
          floor: 2.55,
          reason:
            "worst resting reading: grey2 #829181 reaches 2.5513 on the #e6e2cc chrome band (2.77 page, 2.90 slab, 3.08 plateau). It is the scheme's own \"Cursor Line Number, Tab Line Label (inactive)\" tier and is DIMMER than the foreground BY CONSTRUCTION (L 0.26582 against 0.13798) — which is the property this token exists to buy, and the reason it cannot be lifted to 4.5 without becoming the body copy.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 2.11,
          reason:
            "worst resting reading: grey1 #939f91 reaches 2.1180 on the chrome band (2.30 page, 2.41 slab, 2.56 plateau). It is the scheme's quietest published light ink (\"Comments, Punctuation Delimiters, Closed Folds, Ignored/Disabled, UI Borders, Status Line Text\"), and grey0 #a6b0a0 is LIGHTER still, so there is nothing between this and the floor to move to.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 2.51,
          reason:
            "worst resting reading: red #f85552 reaches 2.5131 on the chrome band (2.73 page, 2.86 slab, 3.04 plateau). This IS the scheme's designated \"Error Messages, Error Signs\" hue and the brightest red palette2 publishes for light, so the wall is the clause's, not a substitution.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 2.22,
          reason:
            "worst resting reading: green #8da101 reaches 2.2286 on the chrome band (2.42 page, 2.53 slab, 2.69 plateau). It IS the scheme's \"Hint Messages, Hint Signs\" hue; the only greener published value, statusline1 #93b259, is lighter and therefore worse on a pale ground.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 1.75,
          reason:
            "worst resting reading and THE LOWEST TEXT RATIO IN EITHER READING: yellow #dfa000 reaches 1.7582 on the chrome band (1.91 page, 2.00 slab, 2.12 plateau). It is the scheme's own \"Warning Messages, Warning Signs\" value and the brightest yellow palette2 has for light, so no published alternative clears 4.5 on any light plane. Recorded at the measured number, not rounded down.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.77,
          reason:
            "worst resting reading: #a16207 reaches 3.7780 on the chrome band (4.10 page, 4.29 slab, 4.56 plateau). NOT declared in this block — `caution` belongs to the RAMP family, which this Palette does not re-hue, so a light reading resolves @theme's light-safe reading, the same value .theme-default-light renders. The kit grades what the browser paints, so it is graded here rather than skipped; it carries a LABEL (the context bar's percentage band), so it is held to the text floor and not the 3:1 glyph floor.",
          expiresAt: 4.5,
        },
      },
      /* The raised class is the DARK mark step #e0dcc7, and every hue fails again
       * there — worse than on the page and better than on the chrome band for the
       * inks, WORSE for the foreground itself (4.05). Kept as a separate table
       * rather than merged into `textFloors`, because a merged table makes the
       * expiry ratchet fire on the class the exemption was never about. */
      raisedFloors: {
        "color-foreground": {
          floor: 4.05,
          reason:
            "the #e0dcc7 mark step: fg #5c6a72 reaches 4.0513 there. Below its resting worst only because the mark step is darker than the chrome band — a light reading's chip is a dark mark, so the same ink reads worse on it.",
          expiresAt: 4.5,
        },
        "color-foreground-subtle": {
          floor: 2.41,
          reason: "the #e0dcc7 chip step: grey2 #829181 reaches 2.4114 there.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 2.0,
          reason: "the #e0dcc7 chip step: grey1 #939f91 reaches 2.0018 there.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 2.37,
          reason: "the #e0dcc7 chip step: red #f85552 reaches 2.3753 there.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 2.1,
          reason: "the #e0dcc7 chip step: green #8da101 reaches 2.1064 there.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 1.66,
          reason:
            "the #e0dcc7 chip step: yellow #dfa000 reaches 1.6617 there — the lowest text ratio in either reading.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 3.57,
          reason:
            "the #e0dcc7 chip step: the inherited @theme reading #a16207 reaches 3.5708 there.",
          expiresAt: 4.5,
        },
      },
      /* EMPTY by measurement, not by omission: the selection state IS the plateau
       * (#fdf6e3), which the resting class already grades through
       * --color-popover/--color-panel. Every graded token's reading on that exact
       * hex is therefore already asserted there (fg 5.18, subtle 3.08, subtlest
       * 2.56, destructive 3.04, success 2.69, warning 2.12, caution 4.56 — only
       * `caution` clears 4.5) — the same numbers the resting class reports for that
       * surface, which is exactly why a second table would restate them rather than
       * measure them. */
      selectedFloors: {},
      /* EMPTY, and that is a checked assertion: this block states every graded text
       * token as a literal published hex, and the one graded token it omits
       * (`caution`) resolves to @theme's LITERAL `#a16207` — unlike both Default
       * readings, whose foreground family aliases Tailwind v4's `oklch()` scale and
       * therefore has to be named ungradeable. The kit fails any entry named here
       * that really IS resolvable, so an empty map is verified, not trusted. */
      textUngradeable: {},
      /* 101 tokens, counted from the CSS by the kit's own reader rather than
       * recalled: the 54 Identity/overlay families every Palette inherits (the 6
       * usage-chart steps and 5 heatmap steps, the 7 context-breakdown steps, the 8
       * git hues, the 18 role chips, the privacy hint, the 3 luminance overlays,
       * the 3 workflow tokens, the 2 wordmark gradients), PLUS the 25 file-type
       * DESCRIPTORS, PLUS 21 of the 22 `--color-terminal-*` tokens, PLUS
       * `color-popover-header`. Both directions of the completeness predicate check
       * this list, so a token added to `.theme-default-dark` has to be classified
       * rather than silently inherited. Three families deserve their own sentence:
       *
       * - THE 25 DESCRIPTORS are the light reading's own rule and not the dark
       *   block's. A LIGHT reading renders with NO `.dark` class, so it resolves the
       *   descriptors through `@theme`'s light-safe readings — chosen to be legible
       *   on a pale page, and measured here at 0 of 25 failing on every plane this
       *   block uses (worst file-svelte 3.0186 / 3.1580 / 3.3573 on background /
       *   chat / panel). Restating the vivid dark hues would put a `#ff5252` glyph
       *   on the `#f4f0d9` slab (measured 2.7828, under the 3:1 glyph floor — and it
       *   is not one hue but SIXTEEN of the 25 vivid readings that fail there, from
       *   `#ffd54f` at 1.23 up) AND shadow the value a classless document depends
       *   on. `.theme-default-light`
       *   declares none of the 25 and names all 25 as inherited for exactly this
       *   reason, and this row follows it. That includes `color-file-css`: the dark
       *   block's `#d699b6` re-read is a DARK-surface fix and a light reading needs
       *   no fix — which is also why it is not allow-listed in either direction.
       * - THE 21 TERMINAL TOKENS because `palette.md` publishes NO ANSI table at all
       *   (`palette2` names 10 hues; a terminal wants 16 slots plus a paper and a
       *   selection), so owning the set would mean inventing a MAPPING and writing
       *   it into shipped CSS. 21 of the 22 paint nothing in any palette — this app
       *   has no terminal surface. Unlike the dark block, this reading also inherits
       *   `--color-terminal-bright-blue`, the one live consumer: Everforest light's
       *   blue reaches only 2.94 on the slab as link text and `@theme`'s light-safe
       *   reading exists precisely to be legible on a pale page, so this reading
       *   leaves it unshadowed (Catppuccin Latte's documented choice for the same
       *   token; Kanagawa Lotus takes the other side and says so).
       * - `color-popover-header` because the light block puts its popovers on the
       *   plateau and publishes no separate header step it needs — `bg_visual`
       *   (#eaedc8) is 1.0033 from the page step and cannot be a rung, so there is
       *   no published value that would make a header distinct from the popover it
       *   heads; inheriting `@theme`'s light-safe reading keeps the pair level
       *   rather than inventing a half-step. */
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
        "color-popover-header",
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
      /* EMPTY: the ramp (`caution` + `thinking-*`) is NOT re-hued, so nothing here
       * pulls the reading into themeTokens.test.ts's per-palette ramp gate. The
       * family's rule is that the hue answers "which level is this", so it may not
       * be painted with hues the block already spends elsewhere — and `palette2`
       * publishes ten light hues, six of which this block's status, brand and accent
       * roles already wear (blue, aqua, green, yellow, purple, red). Five mutually
       * distinct, ordered, non-colliding published hues do not exist here. Both
       * readings take the shared ramp, which is Rosé Pine's documented decision. */
      extraBeyondDefault: [],
      /* COUNTED from `.theme-everforest-light` with the kit's own reader
       * (`cssReader(...).declared(block).size` = 67), not recalled — a row that
       * pins the wrong number cannot pass, which is the point of the pin. */
      declaredCount: 67,
    },

    /* ══════════════════════════════════════ DARK — `hard` ══════════════════════
     * Five published `hard` rungs plus the scheme's selection step, STRICTLY
     * ASCENDING as a dark reading must be:
     *
     *   #1e2326 0.01618  →  #272e33 0.02624  →  #2e383c 0.03735
     *   →  #374145 0.05022  →  #414b50 0.06735      (selection #495156 0.07973)
     *   hops 1.1521 / 1.1457 / 1.1473 / 1.1709, selection 1.1055 over the raised rung
     *
     * The third hop is the concession the block comment prices: slab against float
     * at **1.1473**, under the **1.2** floor `slabFloatSeparation.test.ts` states
     * (1.2, not 1.3 — its own comment is explicit about which number is real). That
     * gate grades Dracula's context-track against Dracula's pane today, so this row
     * does not fail it; it is recorded anyway because Kanagawa records the identical
     * concession, and the pair the 1.2 floor actually exists to grade — the context
     * bar's track `#414b50` against the pane it rides `#2e383c` — clears it at
     * **1.3434**. The alternative was inventing a hex between `bg1` and `bg2`, which
     * would no longer be Everforest. */
    dark: {
      mode: "dark",
      ladderGroups: [
        {
          label:
            "THE PAGE PLANE and the chrome band, the composer island and the terminal's paper — `hard/bg_dim #1e2326`, the deepest published step (L 0.01618). The titlebar and the sidebar read --color-frame, so the seam ADR 0027 records cannot come back when either moves; taking the deepest rung rather than the page is what makes the top and left of the window one recessed band. This is the step that made `hard` mandatory: with --color-file-css at Default's #7e57c2 it was the ONLY one of the 39 published dark steps dark enough for a rendered plane",
          tokens: ["color-background", "color-frame", "color-composer", "color-terminal-bg"],
        },
        {
          label:
            "RECESSED — the borderless cards INSIDE the slab (ToolCallCard, the SubagentDelegatingCard body, the code-block header) and the popover header — `hard/bg0 #272e33`. They carry no borders, so sitting below their container is the only thing that makes them cards. It is also the SECOND-worst rendered plane for the identity hues (worst file-ts/file-py 3.5708) and the surface the code-block header's glyph actually rides",
          tokens: ["color-panel", "color-popover-header"],
        },
        {
          label:
            "THE CONTENT SLAB and everything that shares its plane — `hard/bg1 #2e383c`, the scheme's own \"Cursor Line Background, Color Columns, Closed Folds Background, Tab Line Background\". The transcript column, the side pane and the composer chat column all read --color-chat, so they cannot drift apart; the active tab IS the sheet showing through the chrome; and the RAISED card plus the control wells sit here too. bg1 is the only published step that is both a plausible raised card and clean for all 25 descriptors — bg2, the next rung up, rejects 7 of 25 — so the slab/card plateau is a designed collapse (ADR 0096 records the same one for default-dark) and it costs nothing the gates care about: the pill rule compares --color-background against --color-card and --color-panel and all three differ. 1.1457 below the slab against the recessed plane; the tightest rendered plane in the palette at file-ts/file-py 3.1166",
          tokens: [
            "color-chat",
            "color-inspector",
            "color-tab-active",
            "color-card",
            "color-input",
            "color-input-focused",
          ],
        },
        {
          label:
            "EVERY FLOAT and the window's alternate step — `hard/bg2 #374145`, the scheme's OWN \"Popup Menu Background, Floating Window Background, Window Toolbar Background\", taken literally rather than a rung borrowed from elsewhere. 1.1473 above the slab — the sub-floor hop the block comment records — and a float's shadow is what carries it, which is why slabFloatSeparation.test.ts reads the float components",
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
            "RAISED CHIPS, the hover state and the context bar's track — `hard/bg3 #414b50`, the scheme's \"List Chars, Special Keys, Tab Line Label Background (inactive)\", i.e. its own mark-on-a-surface colour, which is what a chip is. secondary/tag/tooltip-tag are HERE and not on the slab's rung because a --color-secondary badge lands INSIDE a --color-menu float and must read as raised over it; the badge-outshines-the-card inversion is the one ADR 0027 records fixing. The track is the one pair the 1.2 floor actually grades that this palette CLEARS: 1.3434 against the pane it rides, where the rung below it would score 1.1473",
          tokens: [
            "color-secondary",
            "color-tag",
            "color-tooltip-tag",
            "color-menu-hover",
            "color-context-track",
          ],
        },
      ],
      /* THE SELECTION STATE IS `hard/bg4 #495156` and the rule is
       * `strictly-above-all` — Dracula's rule, and the one this reading can afford.
       * `bg4` is L 0.07973: 1.1055 over the raised rung, 1.9603 over the page, so it
       * is brighter than every resting step. Two published steps qualified and the
       * choice between them is stated rather than silent: `bg5 #4f5b58` (L 0.09849)
       * also clears but the spec publishes it as \"_Not currently used_\" — the
       * scheme's spare — while `bg4` is the immediate next rung, so the state
       * separates by the smallest published step that still clears everything.
       * `bg_visual #4c3743`, the scheme's own \"Visual Selection\" and the obvious
       * candidate, CANNOT be it: L 0.04674 puts it BELOW `bg3` and it would sink
       * under the badges a selected row must clear. `at-or-above-card` — which the
       * light reading here, `default-dark` and every merged light reading use — was
       * the other honest answer and would have made `bg_visual` legal; it was not
       * taken because the selection step then stops being the brightest thing in the
       * reading, which is what a selection is FOR. */
      selectionRule: "strictly-above-all",
      selectedTokens: ["color-card-selected"],
      surfaceTokenPattern: SURFACE_TOKEN_PATTERN,
      /* EMPTY. All 24 surface tokens this block declares are classified above and
       * every one is an OPAQUE literal or a `var()` to one — `palette.md` publishes
       * zero alpha values (all 100 hexes are opaque `#rrggbb`), so ADR 0105's
       * \"alpha on a surface is refused\" is satisfied by construction here rather
       * than by exemption. The six `color-mix()` declarations in the block are all
       * tints or overlays (`idle-task-surface`, `interaction-ask-surface`,
       * `interaction-ask-fill`, `interaction-confirmation-surface`,
       * `find-highlight`, `plugin-paid-plan-badge`) and match no surface pattern.
       * A stale exemption fails, so this stays empty deliberately. */
      ladderExemptions: {},
      textSurfaces: {
        /* Five resting planes over four distinct published rungs. `popover`
         * (#374145, the float step) is the BINDING surface for every text token in
         * this reading — the dialog copy the kit's whole floor redesign exists to
         * catch lands there — and `panel` (#272e33) is the recessed column the
         * code-block header paints on. `input` shares the slab's rung (#2e383c) and
         * is named ANYWAY because the control well is where placeholder and typed
         * copy lands; its reading is identical to `chat`'s by construction, and
         * that identity is itself the assertion that the alias has not drifted.
         * `frame` (#1e2326 == --color-background) and `tooltip` (#374145 ==
         * --color-popover) are NOT listed: they are the same hex as a token already
         * in the class, so grading them would restate a reading rather than add one. */
        resting: [
          "color-background",
          "color-chat",
          "color-panel",
          "color-popover",
          "color-input",
        ],
        raised: ["color-card", "color-menu-hover", "color-secondary", "color-tag"],
        /* The selection step is a REAL surface here (unlike the light reading, whose
         * selection state is the plateau): #495156 is its own published rung and the
         * brightest plane in the palette, so it is the worst ground a coloured hue
         * can meet and is graded as its own class. */
        selected: ["color-card-selected"],
      },
      /* Six resting walls, all measured against #374145 — the float step, which is
       * the worst of the six resting grounds for every one of them (the page
       * #1e2326 is 1.5–2.3 points more legible, which is exactly why a page-only
       * floor is not a floor). Three tokens clear 4.5 everywhere and are absent:
       * `foreground` (worst 6.20), `success` (5.24) and `warning` (5.74), plus the
       * inherited ramp `caution` at 5.46. Every entry carries `expiresAt: 4.5`. */
      textFloors: {
        "color-foreground-subtle": {
          floor: 4.29,
          reason:
            "worst resting reading: grey2 #9da9a0 reaches 4.2985 on the #374145 float step (6.51 on the page, 4.93 on the slab and the control well, 5.65 on the recessed panel). It is the scheme's own \"Cursor Line Number, Tab Line Label (inactive)\" tier. THE ALTERNATIVE IS NAMED so it can be overruled with numbers: `fg #d3c6aa` clears every surface (worst 5.30) — but then the de-emphasis tier IS the body copy, and separation, not legibility, is what this token exists to buy; grey2 separates from the foreground by only 1.4423 (its L is 0.38082 against fg's 0.57139). `text-foreground-subtle` carries timestamps and secondary labels.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 3.22,
          reason:
            "worst resting reading: grey1 #859289 reaches 3.2278 on the #374145 float step (4.89 on the page, 3.70 on the slab, 4.24 on the panel). It is the scheme's own quiet ink (\"Comments, Punctuation Delimiters, Closed Folds, Ignored/Disabled, UI Borders, Status Line Text\") and, below it, its border colour too — one published hue legitimately serves \"comment\" and \"UI border\" because both are marks that must not compete with content. No published value sits between this and grey0 #7a8478 (3.09 on the slab), so there is nothing to move TO without leaving the palette.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.82,
          reason:
            "worst resting reading: red #e67e80 reaches 3.8217 on the #374145 float step (5.79 on the page, 4.38 on the slab, 5.02 on the panel). It IS the scheme's designated \"Error Messages, Error Signs\" hue and the only red palette2 publishes for dark — bg_red #493b40 is a diff GROUND, not ink — so no published value clears 4.5 on the float step. The FILL's ink improves either way (#1e2326 on #e67e80 is 5.79), which is why the wall is on the TEXT and not on the button.",
          expiresAt: 4.5,
        },
      },
      /* The raised class is `bg3 #414b50` — badges, the inline-code chip, menu hover
       * — one rung above the slab, and every hue pays again for being on the
       * brighter ground. `card` itself sits on the slab's rung (#2e383c) and reads
       * better than these numbers, which is exactly why the class is graded to its
       * WORST member rather than surface by surface. */
      raisedFloors: {
        "color-foreground-subtle": {
          floor: 3.67,
          reason:
            "the raised step #414b50: grey2 #9da9a0 reaches 3.6712 there (4.93 on the slab-rung card).",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 2.75,
          reason:
            "the raised step #414b50: grey1 #859289 reaches 2.7567 there. It is also --color-border, and the scheme put those two jobs on one published hue on purpose.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 3.26,
          reason:
            "the raised step #414b50: red #e67e80 reaches 3.2640 there (4.38 on the slab-rung card). Same wall as the resting one, one rung worse, and the error copy that lands on a chip or a menu item is the copy this number describes.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 4.47,
          reason:
            "the raised step #414b50: green #a7c080 reaches 4.4715 there — 0.03 under the floor, and it clears 4.5 on all six resting planes (worst 5.2356). It IS the scheme's \"Hint Messages, Hint Signs\" hue and the brightest green palette2 publishes for dark, so the shortfall is the clause's at one rung, not a substitution.",
          expiresAt: 4.5,
        },
      },
      /* THE SELECTION STATE IS THE WORST SURFACE IN THIS READING for a coloured hue,
       * and it is graded as its own class so a resting exemption cannot be stretched
       * over it. #495156 is `bg4`, taken because it is the only published step that
       * is brighter than every resting rung (`strictly-above-all`), and a bright
       * ground is precisely what a mid-tone status hue cannot survive. The FOREGROUND
       * clears it (4.7898), which is what matters most: the copy that renders
       * selected is the row's own foreground, not its de-emphasis tier. */
      selectedFloors: {
        "color-foreground-subtle": {
          floor: 3.32,
          reason:
            "grey2 #9da9a0 reaches 3.3209 on the selection step #495156 — a transient state, graded apart so the resting exemption cannot be stretched over it.",
          expiresAt: 4.5,
        },
        "color-foreground-subtlest": {
          floor: 2.49,
          reason: "grey1 #859289 reaches 2.4936 on the selection step #495156.",
          expiresAt: 4.5,
        },
        "color-destructive": {
          floor: 2.95,
          reason:
            "red #e67e80 reaches 2.9525 on the selection step #495156 — a red-adjacent hue on the brightest ground the palette owns. No published dark red clears 4.5 there.",
          expiresAt: 4.5,
        },
        "color-success": {
          floor: 4.04,
          reason:
            "green #a7c080 reaches 4.0447 on the selection step #495156 (4.4715 raised, 5.2356 resting). The scheme's own \"Hint Messages\" hue at its worst surface.",
          expiresAt: 4.5,
        },
        "color-warning": {
          floor: 4.43,
          reason:
            "yellow #dbbc7f reaches 4.4367 on the selection step #495156 (4.9048 raised, 5.7430 resting). The scheme's own \"Warning Messages\" hue, and the only yellow it publishes for dark.",
          expiresAt: 4.5,
        },
        "color-caution": {
          floor: 4.22,
          reason:
            "the inherited .dark reading #eab308 reaches 4.2202 on the selection step #495156 (4.6655 raised, 5.4627 resting). `caution` belongs to the RAMP family, which this Palette does not re-hue, so this row grades what the cascade actually paints rather than a value the block does not state. It carries a LABEL, so it is held to the text floor and not the 3:1 glyph floor.",
          expiresAt: 4.5,
        },
      },
      /* EMPTY, and it is the assertion that this reading grades every graded token
       * for real. Everforest states every text reading as a literal published hex,
       * and the one graded token it omits (`caution`) resolves to `.dark`'s LITERAL
       * `#eab308` — so unlike BOTH Default readings, whose foreground family aliases
       * Tailwind v4's `oklch()` scale with no hex reading anywhere in this repo,
       * there is nothing here the resolver cannot reach. The kit fails any entry
       * named here that really IS resolvable. */
      textUngradeable: {},
      /* 74 tokens, counted from the CSS by the kit's own reader (67 for the light
       * reading): the 54 Identity/overlay families every other Palette inherits (the
       * 6 usage-chart steps and 5 heatmap steps whose STEPS are the signal, the 7
       * context-breakdown steps, the 8 git hues, the 18 role chips including the
       * three `file-node*` chips, the privacy hint, the 3 luminance overlays, the 3
       * workflow tokens, the 2 wordmark gradients) PLUS 20 of the 22
       * `--color-terminal-*` tokens. Checked in BOTH directions by the completeness
       * gate; untouched BY this Palette, not preserved FROM the Default one.
       *
       * THE 25 DESCRIPTORS ARE NOT HERE, and that is the dark reading's own rule:
       * they are declared in `@theme` (light-safe) and in `.theme-default-dark`
       * (vivid) but NOT in `.dark`, so a DARK palette that omits one does not fail —
       * it silently resolves through `.dark` to `@theme`'s light-safe reading, a
       * DIFFERENT HUE, which is the real hazard when the hue is the whole signal. So
       * this block restates all 25; 24 are allow-listed by name and `file-css` is
       * re-read at Everforest's own `purple #d699b6`.
       *
       * THE TERMINAL SET is inherited because `palette.md` publishes NO ANSI table at
       * all — `palette2` names 10 hues, a terminal wants 16 slots plus a paper and a
       * selection — so owning it would mean inventing a MAPPING and writing it into
       * shipped CSS. Catppuccin is in the same position and inherits for the same
       * reason, and 21 of the 22 paint nothing in any palette because this app has no
       * terminal surface. TWO are owned rather than inherited and so are absent from
       * this list: `--color-terminal-bg`, which is a rung of this ladder and must be
       * the block's own, and `--color-terminal-bright-blue`, the single live consumer
       * of any terminal token (`@theme`'s `--color-icon-blue` aliases it, so markdown
       * links and diff `@@` hunks ride Everforest's blue at 6.34 on the panel instead
       * of `.dark`'s generic sky). The HEXES of any mapping would all have been
       * published; it is the ASSIGNMENT that would not be. */
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
      /* EMPTY — the ramp is not re-hued, for the measured reason the light reading
       * states (ten published hues, six already spent on status/brand/accent roles;
       * five mutually distinct, cool→hot-ordered, non-colliding published hues do not
       * exist). A non-empty list here would pull the reading into
       * themeTokens.test.ts's per-palette ramp gate. */
      extraBeyondDefault: [],
      /* COUNTED from `.theme-everforest-dark` with the kit's own reader
       * (`cssReader(...).declared(block).size` = 94), not recalled and not copied
       * from another Palette — this repo's repeated lesson is that a recalled
       * declaration count is how a truncated block passes every predicate at once. */
      declaredCount: 94,
    },
  },
};
