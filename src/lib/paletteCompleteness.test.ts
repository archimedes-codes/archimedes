import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readResolvedIndexCss } from "./cssSource";
import { createSourceSweep } from "./sourceSweep";
import {
  blockHeads,
  contrast,
  cssReader,
  diff,
  gradePalette,
  GRADED_TEXT_TOKENS,
  layerOrderFailures,
  listPaletteSpecs,
  lumOf,
  readCssFile,
  resolveToHex,
  stripComments,
} from "./paletteTestKit";
import {
  DEFAULT_PALETTE_ID,
  PALETTES,
  SHIKI_FALLBACK_THEME,
  paletteClass,
  shikiThemeFor,
  shikiThemeIds,
  shikiThemesToLoad,
  themeClassNames,
  type PaletteId,
} from "./palettes";
import { applyThemeToDocument } from "./theme";
import type { PaletteSpec } from "./paletteSpec";
import { loadedShikiThemes } from "../components/AgentMarkdown";
import { loadedCodemodeShikiThemes } from "../components/CodemodeCard";
import { PALETTE_PICKER_VALUES } from "./palettePicker";
// The Wave-3 fixture: a THIRD Palette row that discovery cannot see, because it
// lives outside `src/lib/palettes/` — the directory `listPaletteSpecs` sweeps. See
// the `Wave 3` describe below for why that placement is the whole mechanism.
import {
  WAVE3_PROBE_CSS_FILE,
  WAVE3_PROBE_ID,
  spec as WAVE3_SPEC,
} from "../test/fixtures/palettes/wave3probe";

// This app deliberately ships no `@types/node` (its globals stay DOM-only), so
// Node's `fs` is reached through a COMPUTED specifier — an untyped `any`
// import that `tsc` accepts without the Node type packages. Used for the
// chrome-bar JSX gate (which sweeps `src/**/*.tsx`); the CSS itself comes from
// `cssSource.ts`.
const NODE_FS = "node:" + "fs";
// The MODULE, not just the two readers, because the live guard at the bottom of
// this file writes and deletes files. Kept as one object so the cast lives once.
// `writeFileSync`/`rmSync`/`existsSync` are reached through it, each call site
// casting the shape it needs — this app ships no `@types/node`, so there is no
// `typeof import("node:fs")` to point at.
const NODE_FS_MODULE = (await import(NODE_FS)) as unknown;
const { readdirSync } = NODE_FS_MODULE as {
  readdirSync: (path: string, options: { recursive: true; encoding: string }) => string[];
};
// Source reads go through the SWEEP READER (see `sourceSweep.ts`). This file
// sweeps `src/` for the chrome-bar gate, and vitest runs test files concurrently
// across workers — so a listed path can be deleted before it is opened.
const sweep = createSourceSweep();

/**
 * Sweep the live guard's artifact BEFORE this file reads the directory.
 *
 * The guard at the bottom of this file writes a row into `src/lib/palettes/` and
 * deletes it in a `finally`, so the normal path leaves nothing. But a run KILLED
 * inside that window leaves a fake Palette, and a `beforeEach` cannot undo a
 * killed process — worse, `SPECS` below is read at MODULE scope, before any hook
 * runs, so a leftover would be baked into every derivation in this file and the
 * first failure a reader saw would be the guard's own "the state before" check,
 * naming nothing useful. Deleting here, ahead of the read, makes the next run
 * clean rather than confusing, and costs one `rmSync` of two paths that are
 * normally absent.
 *
 * It removes ONLY the guard's two own-named paths. It never sweeps a directory,
 * so it cannot touch a real Palette or a hand-built probe somebody is using to
 * reproduce something.
 */
{
  const fs = NODE_FS_MODULE as {
    rmSync: (path: string, options?: { force?: boolean }) => void;
  };
  fs.rmSync("src/lib/palettes/guardprobe.ts", { force: true });
  fs.rmSync("src/styles/guardprobe.css", { force: true });
}

/**
 * Every `.tsx` file under `src/`, paths prefixed with the directory because
 * `readdirSync({ recursive: true })` returns names relative to it.
 *
 * The chrome-bar gate below sweeps this instead of reading one named file, so
 * the invariant survives the element MOVING. The extension filter is not
 * skipping real input today (`src/` holds `.ts`, `.tsx` and `.css` and nothing
 * else — measured in `themeTokens.test.ts`), it is here so a later asset cannot
 * turn the sweep into a binary read. Test files are deliberately NOT excluded:
 * a `data-testid` inside a `querySelector('…')` string is not a JSX tag and
 * cannot match the tag regex, and if one ever did, a second chrome bar in a
 * fixture is exactly what the "exactly one" assertion should catch.
 *
 * THE `.tsx` FILTER DOES NOT MAKE THIS SWEEP RACE-PROOF, and the two are
 * unrelated properties. The live palette guard writes `.ts` and `.css`, so today
 * its `guardprobe` files cannot appear in this list — but the filter exists so a
 * later asset cannot turn the sweep into a binary read, not as a promise about
 * which files come and go. Any future test that writes a `.tsx` probe, an editor
 * mid-save, or a parallel worktree churning this tree hits the same
 * list-then-open window. So the read below goes through the sweep reader like
 * every other sweep in `src/lib/` (see `sourceSweep.ts`): identical contract,
 * identical tolerance, no latent trap left behind for the next person to find.
 */
const tsxSourceFiles = (): string[] =>
  readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((p) => /\.tsx$/.test(p))
    .map((p) => `src/${p}`);

/**
 * The RESOLVED stylesheet — `src/index.css` with its `src/styles/*.css`
 * imports inlined (see `cssSource.ts`), comments KEPT.
 *
 * READ FOR ONE PURPOSE ONLY: the layer-order gate, which is a fact about the
 * CASCADE and therefore about the assembled stylesheet and nothing else. Every
 * GRADING read in this file goes through `readCssFile(spec.cssFile)` instead,
 * for the reason the kit's header states and which is worth repeating here
 * because it is the reason Wave 3 can run four Palettes in parallel: `block()`
 * throws `no <selector> block` when a selector is missing from the text it was
 * given, and the resolved stylesheet contains only the `@import`s that exist. A
 * grading gate reading it would therefore either go red for a Palette whose
 * `@import` has not landed yet, or have to skip it — and skipping makes the
 * completeness / spec / ladder checks **vacuous for exactly the Palettes they
 * exist to grade**.
 */
const css = readResolvedIndexCss();

/**
 * The per-Palette grading rows, discovered by reading `src/lib/palettes/`.
 *
 * EVERY predicate below that used to iterate `DRACULA_VALUES` now iterates this
 * list. That is the fix for the measured silent pass: four gates graded Dracula
 * alone, so a fifth Palette bought no completeness, spec, ladder or contrast
 * grading at all.
 */
const SPECS = await listPaletteSpecs();

/** Look up one row by id. Throws rather than returning `undefined`, because a
 *  missing row would turn every gate that reads it into a loop over nothing. */
const specFor = (id: string) => {
  const found = SPECS.find((spec) => spec.id === id);
  if (!found) throw new Error(`no spec row for "${id}" in src/lib/palettes/`);
  return found;
};

const DRACULA_SPEC = specFor("dracula");
const DEFAULT_SPEC = specFor(DEFAULT_PALETTE_ID);

/** The shared base layers (`@theme`, `.dark`, and the Default palette's two
 *  readings), read from the file that declares them. This is what a Palette's
 *  `var()` hops resolve against, and it is also the completeness reference. */
const BASE = cssReader(readCssFile(DEFAULT_SPEC.baseCssFile));
const THEME_BODY = BASE.block(/^@theme\s*\{/m);
const DARK_BODY = BASE.block(/^\.dark\s*\{/m);
const DEFAULT_LIGHT_BODY = BASE.block(/^\.theme-default-light\s*\{/m);
const DEFAULT_DARK_BODY = BASE.block(/^\.theme-default-dark\s*\{/m);

const DARK = BASE.declared(DARK_BODY);
const DEFAULT_DARK = BASE.declared(DEFAULT_DARK_BODY);
const DEFAULT_LIGHT = BASE.declared(DEFAULT_LIGHT_BODY);

const DARK_VALUES = BASE.values(DARK_BODY);
const THEME_VALUES = BASE.values(THEME_BODY);

/** A Palette's own reader, from its own CSS file — never the resolved sheet. */
const readerFor = (cssFile: string) => cssReader(readCssFile(cssFile));
const DRACULA_READER = readerFor(DRACULA_SPEC.cssFile);
const draculaBody = DRACULA_READER.block(/^\.theme-dracula-dark\s*\{/m);
/** `.theme-dracula-dark`'s declared NAMES. Kept under its historical name: the
 *  Dracula-specific describes below read it as data, not as a predicate. */
const DRACULA = DRACULA_READER.declared(draculaBody);
const DRACULA_VALUES = DRACULA_READER.values(draculaBody);
const DEFAULT_DARK_VALUES = BASE.values(DEFAULT_DARK_BODY);

/**
 * The cascade a reading actually resolves to, as `{ map, resolve }`.
 *
 * `@theme`, then `.dark` (a DARK reading only — `applyThemeToDocument` gives a
 * light reading no `.dark` class, so `.dark` must not leak into what a light
 * Palette resolves to), then the block's own declarations. `resolve` reduces a
 * token to the OPAQUE hex that paints, compositing a translucent value over the
 * reading's own page.
 *
 * This is the same cascade `gradePalette` builds internally; the Dracula-named
 * describes below need it to make the historical, Dracula-specific claims (the
 * slab-vs-panel relationship, the context-bar track's band separation) that no
 * generic row can express. It exists so those claims go through ONE model of
 * compositing rather than a fourth copy of the maths.
 */
const cascadeFor = (spec: (typeof SPECS)[number], mode: "light" | "dark") => {
  const reader = readerFor(spec.cssFile);
  const tokens = reader.values(
    reader.block(new RegExp(`^\\.${paletteClass(spec.id, mode)}\\s*\\{`, "m")),
  );
  const map: Record<string, string> =
    mode === "dark" ? { ...THEME_VALUES, ...DARK_VALUES, ...tokens } : { ...THEME_VALUES, ...tokens };
  const page = resolveToHex(
    "color-background",
    map["color-background"] ?? "#ffffff",
    map,
    "#ffffff",
  );
  return {
    tokens: map,
    /** The hex a token paints on this reading's page. Throws, naming the token,
     *  when the value cannot be reduced — never silently skips. */
    resolve: (token: string): string => resolveToHex(token, map[token]!, map, page),
  };
};

const DRACULA_CASCADE = cascadeFor(DRACULA_SPEC, "dark");


/**
 * A Palette block (ADR 0027) is a DIFF over `.dark`, so the question it must
 * answer is not "are these values right" (the contrast tests cover that) but
 * "did the palette state its intent for EVERY token" — because a token it
 * forgets does not fail, it silently inherits. That is the whole hazard of the
 * layering: `.theme-default-dark` is the only place the 25 `--color-file-*`
 * descriptors carry a dark reading, so a palette block that omits one gets the
 * `@theme` light-safe mud-brown on a purple-black surface and nothing complains.
 *
 * So this is a COMPLETENESS test, and it is written as a SET EQUALITY IN BOTH
 * DIRECTIONS, which is the part that matters:
 *
 *   tokens(.theme-default-dark) − tokens(a palette block)  ==  that row's `inheritedFromDefault`
 *   inheritedFromDefault        − tokens(.theme-default-dark)  ==  ∅
 *
 * Asserting only "nothing is missing" would let a token be silently DROPPED
 * from a palette (a palette that forgets the terminal hues); asserting only
 * "nothing is extra" would let a token be silently INHERITED that default dark
 * restates by hand (a palette that forgets the git hues, so a `.dark` reading
 * shows through on a Dracula row). Both directions together mean a NEW token
 * added to `.theme-default-dark` must be classified — every palette restates it or
 * names it in its own `inheritedFromDefault`. There is no third option, and that
 * list is the review surface: for Dracula it is exactly the **Identity color** set
 * from `CONTEXT.md` plus the white overlays, i.e. the hues that encode WHAT a
 * thing is rather than how the palette dresses it.
 *
 * THE SECOND HALF OF THIS FILE is the spec gate, and it exists because the set
 * equality above is silent about VALUES. `.theme-dracula-dark` was first built from
 * `pi-dracula`, a community TUI port that disagrees with the current official
 * specification (it labels `#44475a` "currentLine"; the spec says Current Line
 * is `#6272a4` and `#44475a` is Selection), and the implementation then invented
 * further hues on top. Every token was in the right place, both directions
 * passed, and the palette was still off-spec. So every block's hexes are pinned
 * against the value set its own source publishes — see each row's
 * `publishedHexes` / `offSpecAllowList`, and `OFF_SPEC_ALLOW_LIST` below for the
 * Dracula instance of that shape.
 *
 * WHAT MOVED WHERE, and why the prose below stays. Every PREDICATE — the two
 * directions of the set equality, the hex gate, the ladder, the contrast floors,
 * the declaration counts — now lives in `paletteTestKit.gradePalette` and runs
 * over `SPECS`, one iteration per Palette. What remains in the Dracula-named
 * describes is that Palette's HISTORY: the record of why `#44475a` may not be a
 * border, of what `pi-dracula` got wrong, of which surface the context bar's
 * track actually paints on. That is not a shared rule and moving it into a kit
 * would lose it; a reader who wants the predicate reads the kit.
 */

/**
 * THE READERS ARE THE KIT'S (`cssReader`), not copies. Four gate files each
 * carried their own `block` / `declared` / `values` and the copies had already
 * diverged in the direction that matters — `fileIconContrast.test.ts` resolved
 * 8-digit hexes and this file's `composite` THREW on them — so there is now one
 * implementation and it is bound to a text, not to a global stylesheet.
 *
 * What those readers must be given is the point of the move: `BASE` reads the
 * file that declares `@theme` / `.dark` / the two Default readings, and each
 * Palette's reader reads THAT Palette's own file. `block()` throws
 * `no <selector> block` when a selector is absent from the text it was handed,
 * and that is what makes a Wave-3 Palette gradeable from its own file before its
 * `@import` exists.
 *
 * The brace-counting and prose-anchor properties the deleted copies documented
 * are documented on the kit's `cssReader` and asserted in
 * `paletteTestKit.test.ts` ("counts brace DEPTH, so a nested rule does not
 * truncate a block", "cannot be fooled by a selector named in PROSE", "does not
 * read a commented-out declaration as a declaration").
 */

/** The two base layers, declared by the file every row names as its `baseCssFile`. */
const BASE_LAYERS = [
  { name: "@theme", reader: BASE, selector: /^@theme\s*\{/m },
  { name: ".dark", reader: BASE, selector: /^\.dark\s*\{/m },
] as const;

/**
 * ══ TWO LAYER ENUMERATIONS, AND WHY THEY MUST NEVER BE MIXED ══
 *
 * Task 2 split the gates into two kinds and this file had only finished half the
 * split. The kinds need DIFFERENT enumerations, and the earlier shape used ONE
 * list for both, which is what made Wave 3 red:
 *
 *  - `ALL_LAYERS` — kind (a), PER-Palette grading. Enumerated from the SPEC
 *    DIRECTORY, because a row is the thing that says "grade me", and each entry
 *    is bound to that row's OWN `cssFile`. A row that is not registered yet joins
 *    this list and is graded for real; that is the whole point of reading
 *    `spec.cssFile`.
 *  - `APP_LAYERS` — kind (b), the cascade the APP assembles. Enumerated from the
 *    REGISTRY (`themeClassNames()`), because the app can only ever apply a
 *    registered class, and only registered Palettes are `@import`ed. An
 *    unregistered row is not in the app's cascade at all, so a rule over the
 *    cascade must not ask it a question.
 *
 * THE BUG THIS SEPARATION KILLS, measured on the throwaway probe (a `probe` row +
 * `probe.css`, unregistered and un-imported — the exact state Tasks 3–6 leave
 * behind and Task 7 closes): names came from the DIRECTORY while offsets came
 * from the RESOLVED sheet, and `indexOfBlock` threw `no /^\.theme-probe-dark
 * \s*\{/m block in the stylesheet`. A gate over the assembled stylesheet cannot
 * find a block the stylesheet does not contain, and it must not try. Feeding
 * directory-derived names to a resolved-sheet read is forbidden in both
 * directions: names from the directory go with own-file reads, names from the
 * registry go with resolved-sheet reads.
 *
 * `fileIconContrast.test.ts` is the reference: its `DARK_SURFACES` derives from
 * `REGISTRY.filter(…)` and its pinned `counts` equality survived the probe
 * unchanged, precisely because the registry was the enumeration.
 */

/** Bind one row's readings to readers over that row's OWN file (kind (a)).
 *
 * A FUNCTION rather than a constant so the Wave-3 fixture at the bottom of this
 * file can ask "what does the per-Palette enumeration look like with a THIRD,
 * unregistered row present?" without leaving a fake Palette in
 * `src/lib/palettes/` — the kit's discovery is a directory sweep and the kit is
 * frozen for Wave 3, so the seam lives here, where adding it is free. */
const gradeLayersFor = (rows: readonly PaletteSpec[]) => [
  ...BASE_LAYERS,
  ...rows.flatMap((spec) =>
    (["light", "dark"] as const)
      .filter((mode) => spec.modes[mode] !== undefined)
      .map((mode) => ({
        name: `.${paletteClass(spec.id, mode)}`,
        reader: readerFor(spec.cssFile),
        selector: new RegExp(
          `^\\.${paletteClass(spec.id, mode).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`,
          "m",
        ),
      })),
  ),
];

/** Every block the cascade can produce for `<html>`, each bound to the FILE that
 *  declares it and derived from the spec rows — so a Palette added in a later
 *  wave joins this list with no edit here.
 *
 * `@theme` and `.dark` are the base every row names; the palette blocks come from
 * each row's own `cssFile`. Order is the cascade's, and
 * `paletteCompleteness.test.ts`'s layer gate pins it on the RESOLVED sheet (that
 * assertion is about the assembled file, so it is the one read in this file that
 * legitimately uses `readResolvedIndexCss`).
 *
 * THE NAME KEEPS ITS MEANING FOR kind (a) READS ONLY — `layerValues`, and the
 * per-row describes. A name from here must never be handed to `indexOfBlock` or
 * `CODE`, which read the RESOLVED SHEET: that mix is the probe failure above. The
 * nesting gate used to make exactly that hand-off; it now measures each layer in
 * its own file through `nestingFailures`, which takes this list and never looks at
 * the assembled sheet.
 */
const ALL_LAYERS = gradeLayersFor(SPECS);

/**
 * The cascade the APP assembles: the two base layers plus every class the
 * REGISTRY can apply, each still read from the file its own row names.
 *
 * Registry-derived, so a spec row that has not been registered yet is simply not
 * here — which is correct, not a gap: nothing can select its class, nothing
 * `@import`s its file, and the wiring describe asserts the moment it IS
 * registered that the `@import`, the picker entry and the Shiki ids landed.
 *
 * The reader is still the row's own file rather than the resolved sheet, so a
 * registered-but-not-yet-imported Palette is graded rather than skipped; what the
 * registry derivation changes is WHO IS ASKED, not WHERE the text comes from.
 */
const APP_LAYERS: { name: string; reader: ReturnType<typeof cssReader>; selector: RegExp }[] = [
  ...BASE_LAYERS,
  ...PALETTES.flatMap((palette) =>
    palette.modes.map((mode) => {
      const className = paletteClass(palette.id, mode);
      return {
        name: `.${className}`,
        // The row tells us WHICH FILE declares this reading. A registered Palette
        // with no row is convicted by the wiring gate below ("no spec row for the
        // registered Palette"), and `specFor` throws before this line can be
        // reached with nothing to read, so there is no silent skip here.
        reader: readerFor(specFor(palette.id).cssFile),
        selector: new RegExp(
          `^\\.${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`,
          "m",
        ),
      };
    }),
  ),
];

/** A layer's declared VALUES by layer name, looked up rather than re-parsed. The
 *  layer list is derived from the spec rows, so a Palette added in a later wave
 *  joins every "in every block" assertion below with no edit here — which is what
 *  the five hardcoded name lists in this file's earlier shape could not do (a 6th
 *  block joined none of them).
 *
 *  VALUES and not declared-NAMES, because that is all the (a) side of this file
 *  reads by layer name; the (b) side's `appLayerDeclared` below is the one whose
 *  callers ask "is this token declared here". */
const layerValues = (name: string): Record<string, string> => {
  const layer = ALL_LAYERS.find((candidate) => candidate.name === name);
  if (!layer) throw new Error(`no ${name} layer in the spec rows`);
  return layer.reader.values(layer.reader.block(layer.selector));
};

/** The same lookups over the APP's cascade (kind (b)). Kept SEPARATE from
 *  `layerValues` rather than unified behind a boolean parameter, so a call site
 *  states WHICH enumeration it means — the conflation of the two is the defect this
 *  rewrite is about, and a flag is precisely how it would come back. */
const appLayerValues = (name: string): Record<string, string> => {
  const layer = APP_LAYERS.find((candidate) => candidate.name === name);
  if (!layer) throw new Error(`no ${name} layer in the registry`);
  return layer.reader.values(layer.reader.block(layer.selector));
};
const appLayerDeclared = (name: string): Set<string> => {
  const layer = APP_LAYERS.find((candidate) => candidate.name === name);
  if (!layer) throw new Error(`no ${name} layer in the registry`);
  return layer.reader.declared(layer.reader.block(layer.selector));
};

/**
 * The 25 file-type DESCRIPTORS. `@theme` declares ALL 25 (light-safe readings)
 * and so does `.theme-default-dark` (vivid dark ones), which is why every palette
 * must restate them: a token a block omits does not fail, it falls back through
 * `.dark` to the `@theme` light-safe value, and on a dark page that is a
 * different hue entirely. `file-node*` are NOT here on purpose — those are the
 * file-row ROLE CHIP, an identity color that rides the `.dark` reading.
 */const FILE_DESCRIPTORS = [
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
];

/**
 * The 54 tokens `.theme-default-dark` declares that `.theme-dracula-dark` deliberately
 * does NOT. Each is inherited from `.dark` by design (ADR 0027's "data-identity
 * palettes stay inherited" consequence), NOT by omission:
 *
 * - 11 usage scales (`usage-chart-*`, `usage-heatmap-*`) and 7
 *   `context-breakdown-*` — ordinal data scales whose STEPS are the signal.
 * - 8 `git-*` — git state hues.
 * - 18 role chips (`file-node*`, `skill-*`, `command-*`, `session-*`,
 *   `plugin-*`, `subagent-node*`) — "what kind of row is this".
 * - `feedback-privacy-hint` — the same warning hue as the ramp, not a palette hue.
 * - 7 white overlays (`surface`, `surface-hover`, `hover`, `selected`,
 *   `workflow-rule`, `workflow-trace`, `workflow-trace-strong`) — luminance,
 *   not hue; they are correct on any dark surface.
 * - 2 `animated-gradient-text-*` — the gradient wordmark is white-on-dark in
 *   every palette.
 *
 * NOTE these WILL render differently from the default dark reading, because that
 * block restates them by hand and Dracula leaves them on `.dark`. That is
 * intended: the rule is "untouched BY Dracula", not "preserved FROM Default".
 *
 * THE 22 `--color-terminal-*` tokens are NOT in this list — `.theme-dracula-dark`
 * owns them (`TERMINAL_ANSI`) — and the reason is NOT that the app has a
 * terminal. **It does not, and it never has.** Re-verified for this comment:
 * there is no terminal component (the repo's only `Terminal` identifiers are
 * the Rust `PermissionMode::Terminal` and a `SquareTerminalIcon` glyph choice),
 * no `xterm`/`@xterm/*`/`node-pty`/`portable-pty`/`alacritty`/`vt100` in either
 * manifest, zero `bg-terminal-*`/`text-terminal-*` class consumers, and the ONE
 * declaration that reads a terminal token today is `@theme`'s
 * `--color-icon-blue: var(--color-terminal-bright-blue)`.
 *
 * So these 22 are FORWARD DECLARATIONS: 21 of them are inert in every palette,
 * and they exist so that a future terminal surface picks up the spec's colours
 * for free instead of inheriting `.dark`'s generic UI readings. What made
 * owning them right was never a consumer, it is that the values are not a
 * guess — the specification publishes the 16-colour ANSI table, so copying it
 * costs nothing and leaves no half-owned palette. (An earlier version of this
 * comment asserted the app "has a terminal now". It was false, it shipped, and
 * it is the reason this one states the measurement instead of the conclusion:
 * a comment that names a component that does not exist is trusted without being
 * checked.)
 */
const INHERITED = [
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
];

/**
 * The comment-stripped RESOLVED stylesheet, for the layer-order gate only. A
 * position lookup must not land on a selector named in PROSE (`.dark`, `@theme`
 * and `.theme-default-dark` are all discussed in comments long before any block
 * opens). Offsets shift relative to the raw text, but RELATIVE ORDER — the only
 * thing the layering depends on — is preserved.
 */
const CODE = stripComments(css);

/** Byte offset of a rule's head in the comment-stripped RESOLVED stylesheet. */
const indexOfBlock = (selector: RegExp): number => {
  const where = CODE.search(selector);
  if (where < 0) throw new Error(`no ${selector} block in the stylesheet`);
  return where;
};

/** A rule's end offset in ANY comment-stripped text, by brace depth. This used
 *  to be bound to `CODE` alone, because the nesting gate it served read the
 *  resolved sheet; that gate now measures each layer in its OWN file, so the
 *  helper takes the text. A block's END must not depend on which view of the
 *  stylesheet you came from, so both views go through this one function. */
const endOfBlockIn = (code: string, at: number): number => {
  const open = code.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/**
 * The nesting predicate, as a function over a layer list rather than a loop inside
 * one `it`.
 *
 * Returned as failures rather thrown, for the kit's reason (`gradePalette`,
 * `layerOrderFailures`): a mutation test can assert the message it expects without
 * a runner in the loop, and the Wave-3 fixture can ask the question of an
 * AUGMENTED layer list — the shipped rows plus a synthetic unregistered one — which
 * is the state that used to make the gate THROW.
 *
 * Each layer's OWN block is located the way the kit locates everything, anchored at
 * LINE START, because that is what keeps a selector named in PROSE from being read
 * as a block. But the INNER head of a nesting is then invisible to that anchor: a
 * nested rule is INDENTED, and `^` will not match it. So the inner search is
 * deliberately NOT anchored and runs over the parent's BODY, name by name. That is
 * the difference between a gate that fires on the shape an author actually writes
 * and one that fires only on a block pushed to column zero — and it is why this is
 * not simply `indexOfBlock` twice.
 *
 * Two blocks can only nest if they are in the SAME text, so text identity is part
 * of the comparison; the resolved sheet CONCATENATES files rather than nesting
 * them, which is why reading each file separately loses nothing.
 */
const nestingFailures = (
  layers: readonly { name: string; reader: ReturnType<typeof cssReader>; selector: RegExp }[],
): string[] => {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** A layer name as it appears in CSS: `@theme` is a rule name, every palette and
   *  base-block name ALREADY carries its own leading dot. Prefixing blindly here
   *  produced `\.\.theme-default-dark`, which matches nothing — and a nesting gate
   *  that matches nothing is the blind-predicate failure this repo records over and
   *  over: green, and lying. */
  const nameInCss = (name: string): string =>
    name.startsWith("@") ? name : `\\.${escape(name.replace(/^\./, ""))}`;
  const heads = layers.map((layer) => {
    // Anchored, and NOT via the kit's `indexOfBlock`, which THROWS on a miss: a
    // nested block is INDENTED and has no anchored head, and that is a FINDING this
    // function reports, not an error it propagates.
    const at = layer.reader.code.search(layer.selector);
    const open = at < 0 ? -1 : layer.reader.code.indexOf("{", at);
    return {
      name: layer.name,
      code: layer.reader.code,
      at,
      open,
      end: at < 0 ? -1 : endOfBlockIn(layer.reader.code, at),
    };
  });
  const failures: string[] = [];
  for (const head of heads) {
    if (head.at < 0) {
      // A layer whose block appears nowhere at all — as opposed to indented, which
      // the body scan below reports as nesting. Loud, because a missing block used
      // to be the thing that silently shrank a gate's comparison.
      const anywhere = new RegExp(`${nameInCss(head.name)}(?![a-z0-9-])\\s*\\{`).test(head.code);
      if (!anywhere) failures.push(`${head.name} declares no block in the file that should hold it`);
      continue;
    }
    if (head.end <= head.open) failures.push(`${head.name} has unbalanced braces`);
  }
  for (const head of heads) {
    if (head.end <= head.open) continue;
    const body = head.code.slice(head.open + 1, head.end);
    for (const other of heads) {
      if (other.name === head.name || other.code !== head.code) continue;
      // `(?![a-z0-9-])` so `.theme-default-dark` cannot be "found" inside a longer
      // name like `.theme-default-dark-alt`. The body is comment-stripped, so a
      // selector named in prose cannot match either.
      const nested = new RegExp(`${nameInCss(other.name)}(?![a-z0-9-])\\s*\\{`);
      if (nested.test(body)) failures.push(`${other.name} is nested inside ${head.name}`);
    }
  }
  return failures;
};

/**
 * Replace ONE declaration's value in ONE block, leaving everything else —
 * including the block's declaration COUNT — alone.
 *
 * MODULE SCOPE, not a closure inside one `it`, because TWO describes need it: the
 * mutation sweep at the bottom of this file and the Wave-3 fixture, whose whole
 * job is to prove a synthetic row is GRADED rather than skipped. Two copies of a
 * mutation helper is how a mutation stops being the same mutation in two places.
 *
 * THE FIXTURE IS COMMENT-STRIPPED FIRST, and that is load-bearing. Locating a
 * declaration in the raw text hits the same trap the kit's readers exist for: a
 * doc-comment that QUOTES the token (`* --color-chat: #282a36;`) matches a
 * declaration regex, and `[^;]+` then runs across newlines to a semicolon lines
 * away — so the first version of this helper rewrote PROSE and the gate reported a
 * missing token instead of an off-spec hex. `gradePalette` strips comments per use
 * anyway, so grading a stripped fixture changes nothing about what is measured.
 */
const mutateValue = (text: string, selector: string, token: string, value: string): string => {
  const code = stripComments(text);
  const reader = cssReader(code);
  const body = reader.block(
    new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m"),
  );
  // Line-anchored and single-line: this mutates a DECLARATION, and a pattern that
  // can span lines can also span a whole doc-comment.
  const pattern = new RegExp(`(^|\\n)\\s*--${token}:\\s*[^;\\n]+;`);
  if (!pattern.test(body)) throw new Error(`--${token} is not declared in ${selector}`);
  const mutated = body.replace(
    pattern,
    (_match, lead: string) => `${lead}  --${token}: ${value};`,
  );
  // The function form of the replacement, because a CSS body can contain `$&`.
  return code.replace(body, () => mutated);
};

/** Delete ONE declaration from ONE block: the shape of "a Palette missing a
 *  token", which is the hazard the layering creates (a missing token does not
 *  fail, it silently inherits). See `mutateValue` for why this is at module scope. */
const deleteDeclaration = (text: string, selector: string, token: string): string => {
  const code = stripComments(text);
  const reader = cssReader(code);
  const body = reader.block(
    new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m"),
  );
  const pattern = new RegExp(`(^|\\n)\\s*--${token}:\\s*[^;\\n]+;`);
  if (!pattern.test(body)) throw new Error(`--${token} is not declared in ${selector}`);
  const mutated = body.replace(pattern, "");
  return code.replace(body, () => mutated);
};

/**
 * The 22 `--color-terminal-*` tokens `.theme-dracula-dark` now owns, with the value
 * the spec mandates. The 16 ANSI entries are the spec's Dracula Classic ANSI
 * table verbatim; `bg` is Background Darker, `fg`/`cursor` are AnsiWhite, the
 * cursor accent is AnsiBlack, and selection is spec Selection `#44475a` at alpha
 * (a terminal selection would have to sit over whatever the cell painted).
 *
 * WHAT THIS TABLE IS AND IS NOT. It is a pin on the VALUES, because the
 * completeness test only asks whether a token is DECLARED, so a palette that
 * restated `--color-terminal-red` with some other red would pass it. It is NOT
 * evidence that anything paints with them: no terminal surface exists, so 21 of
 * these 22 declarations colour nothing in any palette today. The single live
 * effect is `--color-terminal-bright-blue`, which `@theme` aliases as
 * `--color-icon-blue` (markdown links, diff `@@` hunks).
 */
const TERMINAL_ANSI: Record<string, string> = {
  "color-terminal-bg": "#191a21",
  "color-terminal-fg": "#f8f8f2",
  "color-terminal-cursor": "#f8f8f2",
  "color-terminal-cursor-accent": "#21222c",
  "color-terminal-selection": "color-mix(in oklab, #44475a 55%, transparent)",
  "color-terminal-selection-inactive":
    "color-mix(in oklab, #f8f8f2 12%, transparent)",
  "color-terminal-black": "#21222c",
  "color-terminal-red": "#ff5555",
  "color-terminal-green": "#50fa7b",
  "color-terminal-yellow": "#f1fa8c",
  "color-terminal-blue": "#bd93f9",
  "color-terminal-magenta": "#ff79c6",
  "color-terminal-cyan": "#8be9fd",
  "color-terminal-white": "#f8f8f2",
  "color-terminal-bright-black": "#6272a4",
  "color-terminal-bright-red": "#ff6e6e",
  "color-terminal-bright-green": "#69ff94",
  "color-terminal-bright-yellow": "#ffffa5",
  "color-terminal-bright-blue": "#d6acff",
  "color-terminal-bright-magenta": "#ff92df",
  "color-terminal-bright-cyan": "#a4ffff",
  "color-terminal-bright-white": "#ffffff",
};

/**
 * Every hex the official specification publishes for Dracula Classic
 * (draculatheme.com/spec), gathered from its tables:
 *
 * - the 11 core palette values (12 tokens; Current Line and Comment are the
 *   same `#6272a4`),
 * - the 4 distinct UI elevation values — Background Darker / Dark / Light /
 *   Lighter, where "Floating interactive elements" reuses Light's `#343746`,
 * - the 5 Functional colors, which the spec marks "do not use in editor or
 *   terminal applications" and assigns to borders, focus and state indicators,
 * - the 16 ANSI values.
 *
 * Deliberately ABSENT: `#353747`, which the spec does publish — as the opaque
 * Current-Line fallback for editors that cannot alpha-blend. It is in the
 * spec's "Current Line Rendering" prose, which says outright that the fallback
 * values "are implementation guidance for line highlight rendering only. They
 * do not add new syntax tokens to the official palette", and NO token in
 * `.theme-dracula-dark` carries it. An allow-list is a list of what the gate must
 * forgive, so an entry nothing uses is not bookkeeping, it is a free slot: it
 * silently licenses any future token to paint `#353747` — a hue this app has no
 * reason to produce — with no test to notice. (It used to sit here, described
 * as "the spec's Selection at 90% alpha"; that is not what it is either —
 * `#44475a` at 90% composites to `#414456` over the page and `#404355` over the
 * well, neither of which is `#353747`.) If a real rendering ever needs the
 * fallback, re-add it then, with the declaration that uses it in the comment.
 *
 * Note what is NOT here: `pi-dracula`'s `#9aa4c4`, `#2fb27d`, `#ff6b81`,
 * `#5b4a10`, `#5a341b`, `#ffd8b8`. None appear in the spec at all.
 */
const SPEC_HEX = new Set([
  // core palette
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
  // UI elevation ladder
  "#191a21", // Background Darker
  "#21222c", // Background Dark == AnsiBlack
  "#343746", // Background Light == Floating interactive elements
  "#424450", // Background Lighter
  // Functional
  "#de5735", // Functional Red
  "#a39514", // Functional Orange
  "#089108", // Functional Green
  "#0081d6", // Functional Cyan
  "#815cd6", // Functional Purple
  // ANSI
  "#ff6e6e",
  "#69ff94",
  "#ffffa5",
  "#d6acff",
  "#ff92df",
  "#a4ffff",
  "#ffffff",
]);

/**
 * The ONLY tokens allowed to carry a hex outside `SPEC_HEX`: the 24 file-type
 * DESCRIPTORS Dracula copies from `.theme-default-dark` (25 minus `file-css`, which
 * is `#bd93f9` and so already on-spec). This is the **Identity color** rule
 * from `CONTEXT.md`, deliberately overriding the spec's "use exact color values
 * from this specification": Dracula has 11 hues and there are 25 file types,
 * so re-huing them to the spec set would make a `.py` chip indistinguishable
 * from a `.json` one — the icon's whole signal. It is a departure, so it is
 * listed by name here rather than waved at in a comment; every other hex in the
 * block must be a spec value.
 */
const OFF_SPEC_ALLOW_LIST = FILE_DESCRIPTORS.filter((n) => n !== "color-file-css");

/**
 * ══ PER-PALETTE GRADING — one iteration per row in `src/lib/palettes/` ══
 *
 * These are the predicates that used to iterate `DRACULA_VALUES` and therefore
 * graded exactly one Palette. They now run over `SPECS`, and every one of them
 * reads that Palette's OWN CSS file (`spec.cssFile`) rather than the resolved
 * `index.css`, which is what lets a Palette be graded before its `@import`
 * exists. `paletteTestKit.test.ts` proves each predicate bites on a synthetic
 * mutation; the gate-level mutations this task was required to observe are the
 * `the harness bites` describe at the bottom of this file.
 */
describe("every Palette is graded by the same predicates (per spec row)", () => {
  for (const spec of SPECS) {
    describe(`${spec.id} (${spec.cssFile})`, () => {
      it("grades clean: completeness both directions, published hexes, ladder, contrast floors", () => {
        // `gradePalette` is the single place these five predicates live. It
        // RETURNS failures rather than throwing, so a Palette with three problems
        // reports three rather than hiding the second behind the first.
        expect(gradePalette(spec)).toEqual([]);
      });

      it("is graded by a non-vacuous row (surfaces, groups and floors are all populated)", () => {
        // A row that named one surface and no groups would satisfy every
        // assertion above while grading almost nothing, and the difference is
        // invisible in a green list. The kit carries the two floor checks; the
        // rest is pinned here so the ROW cannot be hollowed out.
        for (const mode of ["light", "dark"] as const) {
          const modeSpec = spec.modes[mode];
          if (modeSpec === undefined) continue;
          const where = `${spec.id} ${mode}`;
          expect(modeSpec.ladderGroups.length, `${where}: no ladder groups`).toBeGreaterThan(1);
          expect(
            modeSpec.textSurfaces.resting.length +
              modeSpec.textSurfaces.raised.length +
              modeSpec.textSurfaces.selected.length,
            `${where}: fewer than four surface readings`,
          ).toBeGreaterThanOrEqual(4);
          expect(modeSpec.declaredCount, `${where}: a row that pins zero declarations`).toBeGreaterThan(0);
        }
      });

      it("declares every file-type DESCRIPTOR a dark reading needs (a palette that omits one inherits @theme)", () => {
        // The descriptors are declared in EVERY DARK layer that can win for
        // `<html>`: `@theme` holds all 25 light-safe readings and
        // `.theme-default-dark` all 25 vivid ones. So omitting one from a DARK
        // reading is not a missing-declaration error, it is a SILENT downgrade —
        // the descriptor resolves through `.dark` to `@theme`, and 5 of those 25
        // `@theme` base values fall below the 3:1 floor on Dracula's `#282a36`
        // (`file-ts`/`file-py` 2.97, `file-sass`/`file-graphql` 2.88, `file-css`
        // 2.73). That is a legibility bug, not a cosmetic one, and it is why the
        // restatement is forced rather than left to the palette's taste. Checked
        // per spec so a Palette added in a later wave is held to it too.
        // DARK readings only, and that is the rule rather than an oversight: a
        // LIGHT reading inherits the descriptors from `@theme`, whose readings are
        // already light-safe, and restating them would SHADOW that value for a
        // classless document. `.theme-default-light`'s row names all 25 in
        // `inheritedFromDefault`, which the completeness predicate checks.
        for (const mode of ["dark"] as const) {
          if (spec.modes[mode] === undefined) continue;
          const reader = readerFor(spec.cssFile);
          const declaredHere = reader.declared(
            reader.block(new RegExp(`^\\.${paletteClass(spec.id, mode)}\\s*\\{`, "m")),
          );
          const fileTokens = [...declaredHere]
            .filter((name) => name.startsWith("color-file-"))
            // `file-node*` are ROLE CHIPS and must NOT be restated here.
            .filter((name) => !name.startsWith("color-file-node"))
            .sort();
          expect(fileTokens, `${spec.id} ${mode}: the descriptor set drifted`).toEqual([
            ...FILE_DESCRIPTORS,
          ].sort());
        }
      });

      it("is declared in its own file BEFORE anything imports it (the Wave-3 property)", () => {
        // The reason the grading gates read `spec.cssFile` and not the resolved
        // sheet, asserted where it matters: this Palette's blocks are readable
        // from a file that needs no `@import`. `readCssFile` throws a named error
        // if the file is gone, so a row that points at nothing cannot pass.
        const text = readCssFile(spec.cssFile);
        for (const mode of ["light", "dark"] as const) {
          if (spec.modes[mode] === undefined) continue;
          expect(
            stripComments(text),
            `${spec.id}: .${paletteClass(spec.id, mode)} is not declared in ${spec.cssFile}`,
          ).toMatch(new RegExp(`^\\.${paletteClass(spec.id, mode)}\\s*\\{`, "m"));
        }
      });
    });
  }

  it("runs the value-grading predicates over MORE than Dracula (the sweep is not vacuous)", () => {
    // The measured silent pass this task exists to close: every value assertion
    // in this file used to iterate `DRACULA_VALUES`, so a new Palette got NO
    // completeness, spec, ladder or contrast grading at all and the suite stayed
    // green. Pin the size of the sweep, so a discovery step that quietly returns
    // one row reddens this rather than halving the coverage in silence.
    expect(SPECS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(SPECS.map((spec) => spec.id)).size, "duplicate spec rows").toBe(
      SPECS.length,
    );
    // Every registry mode is graded by a row — the direction that lets a Palette
    // be registered and render ungraded.
    for (const palette of PALETTES) {
      const row = SPECS.find((spec) => spec.id === palette.id);
      expect(row, `no spec row grades the registered Palette "${palette.id}"`).toBeTruthy();
      for (const mode of palette.modes) {
        expect(
          row!.modes[mode],
          `${palette.id}: the registry ships a ${mode} reading no row grades`,
        ).toBeTruthy();
      }
    }
  });
});

describe("the .theme-dracula-dark palette block (ADR 0027 completeness)", () => {
  it("inherits exactly the 54 identity/overlay tokens — nothing dropped", () => {
    // THE RECORD, for this Palette. The predicate — "the tokens
    // `.theme-default-dark` declares and this block does not must equal the row's
    // `inheritedFromDefault`, in both directions" — runs over EVERY Palette in the
    // describe above (through `gradePalette`). What lives here is the claim that
    // Dracula's list is the 54 the ADR reasoned about: usage scales, git hues,
    // role chips, white overlays, the wordmark.
    expect(diff(DEFAULT_DARK, DRACULA)).toEqual([...INHERITED].sort());
    // And the row agrees with the record, so the two cannot drift apart: a row
    // edited to forgive an omission would fail here even though `gradePalette`
    // would pass against the edited row.
    expect([...DRACULA_SPEC.modes.dark!.inheritedFromDefault].sort()).toEqual(
      [...INHERITED].sort(),
    );
  });

  it("names no token that .theme-default-dark does not (minus the ramp)", () => {
    // The other direction: everything Dracula declares that default dark omits
    // must be accounted for. The only such tokens are the six RAMP tokens,
    // which live in `.dark` + `@theme` (Task 2) and which Dracula re-hues.
    const draculaOnly = diff(DRACULA, DEFAULT_DARK);
    expect(draculaOnly).toEqual([
      "color-caution",
      "color-thinking-high",
      "color-thinking-low",
      "color-thinking-max",
      "color-thinking-medium",
      "color-thinking-xhigh",
    ]);
    // Same facts as the row's `extraBeyondDefault`, checked against the record.
    expect([...DRACULA_SPEC.modes.dark!.extraBeyondDefault].sort()).toEqual(
      [...draculaOnly].sort(),
    );
  });

  it("has an INHERITED list that matches reality in both directions", () => {
    // Guards the list itself: an entry that no longer exists in .theme-default-dark
    // (a rename, a deletion) must not linger and mask a real omission.
    expect(diff(new Set(INHERITED), DEFAULT_DARK)).toEqual([]);
    expect(INHERITED.length).toBe(new Set(INHERITED).size);
  });

  it.each(FILE_DESCRIPTORS)("%s is declared by BOTH palette blocks", (token) => {
    expect(DEFAULT_DARK.has(token), `${token} missing from .theme-default-dark`).toBe(true);
    expect(DRACULA.has(token), `${token} missing from .theme-dracula-dark`).toBe(true);
  });

  it("restates all 25 descriptors (a palette that omits one inherits @theme)", () => {
    // The descriptors are declared in EVERY layer that can win for `<html>`
    // except `.dark` and `.theme-default-light`, which carry only the `file-node*`
    // role chips: `@theme` holds all 25 light-safe readings and
    // `.theme-default-dark` all 25 vivid ones. So omitting one here is not a
    // missing-declaration error, it is a SILENT downgrade — the descriptor
    // resolves through `.dark` to `@theme`, and 5 of those 25 `@theme` base
    // values fall below the 3:1 floor on Dracula's `#282a36` (`file-ts`/`file-py`
    // 2.97, `file-sass`/`file-graphql` 2.88, `file-css` 2.73). That is a
    // legibility bug, not a cosmetic one, and it is why the restatement is
    // forced rather than left to the palette's taste.
    expect(FILE_DESCRIPTORS.length).toBe(25);
    const fileTokens = [...DRACULA].filter((n) => n.startsWith("color-file-"));
    // `file-node*` are role chips and must NOT be restated here.
    expect(fileTokens.sort()).toEqual([...FILE_DESCRIPTORS].sort());
  });

  it("re-hues exactly one descriptor: file-css (the default palette's purple is 2.73 on Dracula's slab #282a36; it clears the page #21222c at 3.03)", () => {
    expect(layerValues(".theme-dracula-dark")["color-file-css"]).toBe("#bd93f9");
    expect(layerValues(".theme-default-dark")["color-file-css"]).toBe("#7e57c2");
  });

  it("declares every structural .dark token the INHERITED set does not cover", () => {
    // Derived, not hard-coded: `.dark` minus INHERITED is the palette-owned
    // surface/border/text/accent/status/interaction/terminal set (89) plus the
    // ramp (6). A token added to `.dark` therefore has to be classified here too.
    // (89 since ADR 0071's `--color-film-glyph` joined `.dark`; 88 before it, and
    // 83 before ADR 0062's row pair — this assertion is derived, so only the
    // prose has to be kept honest.)
    expect(diff(DARK, new Set(INHERITED)).filter((n) => !DRACULA.has(n))).toEqual([]);
  });

  it("is 120 declarations: 89 structural + 25 descriptors + 6 ramp", () => {
    // The arithmetic that proves nothing was double-counted: 89 structural + 6
    // ramp = the 95 tokens `.dark` declares once INHERITED is removed, plus the
    // 25 descriptors `.dark` never declares at all = 120. The REGION RENAME
    // (`sidebar`->`frame`, `background-alt`->`chat`) is count-neutral, and the
    // two NEW tokens `--color-inspector` / `--color-composer` are declared in
    // EVERY layer, which is why all four counts below moved by two. At the time
    // that sentence was written they were aliased in all four non-Dracula layers,
    // so the default palette rendered byte-identically; TODAY only the Default
    // palette's two readings still alias them, and the other eleven (Dracula's and
    // the ten this plan added) state their own values. The arithmetic below is
    // unaffected — a declaration counts whether it is an alias or a literal — but
    // "aliased" no longer describes four of fifteen layers.
    //
    // ADR 0062 then moved all FOUR, and it is worth stating why the two halves
    // of that change are not a wash: it adds `--color-row-icon` /
    // `--color-row-verb` to EVERY layer, and deletes the five dead row-KIND
    // tokens from `@theme`, `.dark`, `.theme-default-light` and `.theme-default-dark` —
    // all four, while `.theme-dracula-dark` declared none of them to begin with. So:
    // Dracula only ever gains (+2 = 119); `diff(DARK, INHERITED)` is unmoved by
    // the deletion, because the five deleted `.dark` tokens were all members of
    // `INHERITED` and so already excluded, and it gains the two new ones (+2 =
    // 94); `DEFAULT_DARK` loses five and gains two (−3 = 167); `INHERITED` loses the
    // five it listed (−5 = 54). That leaves the cross-check below at 48 == 48.
    // A partial edit — the addition without the deletion, or the reverse —
    // breaks that line loudly rather than passing quietly, which is exactly what
    // a completeness gate is for.
    //
    // ADR 0071's `--color-film-glyph` moves three of the four again, and it is
    // the simplest possible version of that pattern: ONE token added to EVERY
    // layer, nothing deleted. So Dracula gains one (+1 = 120), `diff(DARK,
    // INHERITED)` gains one (+1 = 95) and `DEFAULT_DARK` gains one (+1 = 168).
    // `INHERITED` is UNCHANGED at 54 — that list means "in default dark but
    // NOT in
    // Dracula", and the film token is declared in Dracula too — so the 48 == 48
    // cross-check below is count-neutral and stays exactly where ADR 0062 left
    // it. Leaving any one of these three stale fails here; the fourth number
    // this block's own sibling gate reads lives further down in the
    // `DRACULA_VALUES` count, which has to move with it.
    expect([...DRACULA].length).toBe(120);
    expect(diff(DARK, new Set(INHERITED)).length).toBe(95);
    expect(DEFAULT_DARK.size).toBe(168);
    // And the two directions of the difference add up the same way: default dark
    // withholds 54 from Dracula, Dracula adds the 6 ramp tokens default dark
    // leaves to `.dark`, so the block sizes differ by 54 − 6.
    expect(DEFAULT_DARK.size - DRACULA.size).toBe(INHERITED.length - 6);
  });

  it("sits AFTER .theme-default-dark, and no palette block nests inside another", () => {
    // Every palette block is a single-class selector of EQUAL specificity, so
    // source order is the tie-breaker if two ever co-exist on <html>. `theme.ts`
    // guarantees at most one is present, and this pins the placement the ADR
    // specifies so the ordering stays honest about which block wins by order.
    const defaultDarkAt = indexOfBlock(/^\.theme-default-dark\s*\{/m);
    const draculaAt = indexOfBlock(/^\.theme-dracula-dark\s*\{/m);
    expect(defaultDarkAt).toBeGreaterThanOrEqual(0);
    expect(draculaAt).toBeGreaterThan(defaultDarkAt);
  });

  it("pins the full layer order: @theme < .dark < the palette blocks in manifest order", () => {
    // THE layering contract, pinned in full. Every one of these rules is a
    // single-class selector of equal specificity (ADR 0027), so the cascade has
    // NO other way to break a tie than by source order — the order IS the
    // feature.
    //
    // `.dark`'s slot is the one that used to be unpinned, and it is the load-
    // bearing one: the palette blocks are deliberately PARTIAL diffs over
    // `.dark` (54 tokens are inherited on purpose — see `INHERITED`), so
    // `.dark` must lose every tie against them. Move the `.dark` block to the
    // end of the file and it silently out-specifies every `.theme-*` block:
    // Dracula renders the default palette's colours, `.theme-default-light`
    // renders dark-mode tokens on a white page, and every value assertion in this
    // file used to still pass because they read the block bodies, not the
    // cascade.
    //
    // THE LIST IS DERIVED: the two base layers plus every class `themeClassNames()`
    // can produce. The five names this test used to hardcode are what made it a
    // five-layer gate — a sixth block joined neither the list nor the assertions,
    // so it could sit anywhere including before `@theme`. The registry-wide gate
    // with the "nothing before `@theme`" half lives in the wiring describe; this
    // one keeps the shipped line pinned as the record it is.
    const found = [
      ["@theme", indexOfBlock(/^@theme\s*\{/m)],
      [".dark", indexOfBlock(/^\.dark\s*\{/m)],
      ...themeClassNames().map(
        (name) => [`.${name}`, indexOfBlock(new RegExp(`^\\.${name}\\s*\\{`, "m"))] as const,
      ),
    ] as const;
    // Every class the registry can produce must be present, or the layering below
    // silently grades a subset — the exact shape of the old five-name blind spot.
    expect([...found.map(([name]) => name)].sort()).toEqual(
      ["@theme", ".dark", ...themeClassNames().map((name) => `.${name}`)].sort(),
    );
    const byOffset = [...found].sort((a, b) => a[1] - b[1]);
    // THE TWO FACTS THAT CARRY THE CASCADE, asserted as the ordered list rather
    // than as pairwise `<`s so a reorder names the whole layering: `@theme` is
    // first and `.dark` is second, i.e. every `.theme-*` block OUT-SPECIFIES both
    // base layers. Which palette block comes before which other one does not
    // matter to the cascade — `theme.ts` guarantees at most one is ever present —
    // so the palettes' mutual order is reported, not pinned: pinning it would make
    // a registry reorder a red suite for no design reason.
    expect(byOffset.map(([name]) => name).slice(0, 2)).toEqual(["@theme", ".dark"]);
    const offsets = byOffset.map(([, at]) => at);
    expect(offsets.every((at) => at >= 0)).toBe(true);
    for (let i = 1; i < offsets.length; i++) {
      expect(
        offsets[i]!,
        `${byOffset[i]![0]} must come after ${byOffset[i - 1]![0]} (observed order: ${byOffset
          .map(([name]) => name)
          .join(" < ")})`,
      ).toBeGreaterThan(offsets[i - 1]!);
    }
    // And the historical full order, for the reader who wants the whole line: the
    // two base layers then every shipped Palette in the order the manifest
    // assembles them. Each Palette's own file declares dark before light, so the
    // two readings land in THAT order — the manifest's import position decides
    // where a Palette joins, not the registry's mode list. The four Wave-3 Palettes
    // join after Everforest because their `@import`s sit beside Everforest's at the
    // end of `src/index.css`; the tail is what the layer-order gate measured, and
    // the pairwise loop above is what actually grades the cascade.
    expect(byOffset.map(([name]) => name)).toEqual([
      "@theme",
      ".dark",
      ".theme-default-light",
      ".theme-default-dark",
      ".theme-dracula-dark",
      ".theme-everforest-dark",
      ".theme-everforest-light",
      ".theme-catppuccin-dark",
      ".theme-catppuccin-light",
      ".theme-ayu-dark",
      ".theme-ayu-light",
      ".theme-rose-pine-dark",
      ".theme-rose-pine-light",
      ".theme-kanagawa-dark",
      ".theme-kanagawa-light",
    ]);
  });

  it("keeps the layers it grades as siblings, none nested inside another", () => {
    // A block nested inside another would change which selectors match it (a
    // `.theme-x` rule inside `.dark` needs BOTH classes), which is a different
    // bug from an ordering one — and brace-depth counting cannot see it, since
    // the outer block's body would then CONTAIN the inner head.
    //
    // ENUMERATED from the spec rows and MEASURED IN EACH LAYER'S OWN FILE. This
    // used to take its NAMES from `ALL_LAYERS` (the directory) and its OFFSETS from
    // `CODE` (the comment-stripped RESOLVED sheet) — the exact mix Task 2 forbids,
    // and the reason a Wave-3 Palette reddened the shared suite: a row whose
    // `@import` has not landed has no block in the resolved sheet, so `indexOfBlock`
    // threw `no /^\.theme-probe-dark\s*\{/m block in the stylesheet` for a Palette
    // that is in no way broken.
    //
    // Reading each file separately is not a weakening, it is the STRONGER claim:
    // nesting inside one's own file is what a palette author can actually do, and
    // cross-FILE nesting is not a thing CSS can express — the resolved sheet
    // CONCATENATES files, it does not nest them. The base layers (`@theme`, `.dark`)
    // are graded here too, from the base file, so nothing is skipped.
    //
    // THE ORDER of the assembled cascade is a resolved-sheet property and stays
    // one — it lives in the two tests above, which enumerate the REGISTRY
    // (`themeClassNames()`), the enumeration the assembled sheet can actually
    // satisfy.
    //
    // Non-vacuity: the base layers plus every reading the rows grade are in the
    // list, and the predicate demonstrably fires on a planted nesting (asserted
    // inside the Wave-3 fixture below, where the same function is run over an
    // augmented list).
    expect(ALL_LAYERS.length).toBeGreaterThanOrEqual(5);
    expect(nestingFailures(ALL_LAYERS)).toEqual([]);
    const nested = cssReader(
      [
        ".theme-catppuccin-dark {",
        "  --color-background: #1e1e2e;",
        "  .theme-default-dark { --color-background: #161616; }",
        "}",
      ].join("\n"),
    );
    // The fixture is synthetic for the obvious reason — a shipped CSS file is not a
    // place to park a broken rule. Without this the empty list above could be the
    // predicate being blind rather than the tree being clean.
    expect(
      nestingFailures([
        { name: ".theme-catppuccin-dark", reader: nested, selector: /^\.theme-catppuccin-dark\s*\{/m },
        { name: ".theme-default-dark", reader: nested, selector: /^\.theme-default-dark\s*\{/m },
      ]),
      "the nesting gate cannot see a block inside another's body",
    ).toEqual([".theme-default-dark is nested inside .theme-catppuccin-dark"]);
  });

  it("leaves the default blocks untouched (the palette axis must not move them)", () => {
    // `.theme-default-light` declares exactly `.dark`'s set and `.theme-default-dark`
    // is a complete standalone dark palette; both are frozen by this task.
    expect(diff(DEFAULT_LIGHT, DARK)).toEqual([]);
    // `.dark`'s only extras are the six RAMP tokens, whose light-safe reading
    // lives in `@theme` (Task 2) — `.theme-default-light` must stay silent there or
    // it would shadow it.
    const RAMP_TOKENS = [
      "color-caution",
      "color-thinking-high",
      "color-thinking-low",
      "color-thinking-max",
      "color-thinking-medium",
      "color-thinking-xhigh",
    ];
    expect(diff(DARK, DEFAULT_LIGHT).sort()).toEqual(RAMP_TOKENS);
    expect(diff(DARK, DEFAULT_DARK).sort()).toEqual(RAMP_TOKENS);
  });
});

describe("the .theme-dracula-dark block follows the official Dracula spec", () => {
  it("declares all 22 terminal tokens with the spec's ANSI palette", () => {
    // Exact strings, because `--color-terminal-*` is a NAME-only concern for
    // the completeness test: a token restated with the wrong hue is "declared".
    // These 22 inherited `.dark`'s generic UI readings untouched until now,
    // which is what this assertion is guarding.
    for (const [token, expected] of Object.entries(TERMINAL_ANSI)) {
      expect(DRACULA_VALUES[token], `${token} missing from .theme-dracula-dark`).toBe(
        expected,
      );
    }
  });

  it("owns exactly the 22 terminal tokens the spec's ANSI table names", () => {
    // Guards the table above: a token renamed or added on either side must be
    // reconciled, not quietly dropped from the assertion.
    const declaredTerminal = [...DRACULA].filter((n) => n.startsWith("color-terminal-")).sort();
    expect(declaredTerminal).toEqual(Object.keys(TERMINAL_ANSI).sort());
    expect(declaredTerminal.length).toBe(22);
  });

  it("uses no hex that the specification does not publish", () => {
    // THE GATE THAT WOULD HAVE CAUGHT THE ORIGINAL MISTAKE. Every hex in the
    // block must appear in the spec's own tables, except the allow-listed file
    // descriptors — so `#44475a` surviving as a border, or `#9aa4c4` / `#2fb27d`
    // / `#5b4a10` surviving as invented hues, fails here by NAME.
    const offenders: string[] = [];
    for (const [token, value] of Object.entries(DRACULA_VALUES)) {
      if (OFF_SPEC_ALLOW_LIST.includes(token)) continue;
      for (const hex of value.match(/#[0-9a-fA-F]{6}/g) ?? []) {
        if (!SPEC_HEX.has(hex.toLowerCase())) offenders.push(`${token}: ${hex}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has a non-empty allow-list, so the spec gate cannot pass vacuously", () => {
    // A gate that skips everything and a gate that passes are the same green.
    // Pin the size and pin that the allow-listed tokens really do carry off-spec
    // hexes, so the exception is doing real work rather than hiding a bug.
    expect(OFF_SPEC_ALLOW_LIST.length).toBe(24);
    expect(OFF_SPEC_ALLOW_LIST).not.toContain("color-file-css");
    const offSpec = OFF_SPEC_ALLOW_LIST.filter((token) =>
      (DRACULA_VALUES[token]?.match(/#[0-9a-fA-F]{6}/g) ?? []).some(
        (hex) => !SPEC_HEX.has(hex.toLowerCase()),
      ),
    );
    expect(offSpec.length).toBe(24);
    // And the gate really does look at the block: it sees 120 declarations, not
    // zero. (A parser that returned {} would pass the offender scan outright.)
    // This is the FOURTH count ADR 0071's `--color-film-glyph` moves — it sits
    // in a different `it` from the three in the completeness test above, so it
    // is the easy one to miss: that block's `DRACULA` set and this block's
    // `DRACULA_VALUES` map are parsed independently and must agree.
    expect(Object.keys(DRACULA_VALUES).length).toBe(120);
  });

  it.each([
    ["color-border", "#6272a4"], // spec: subtle borders use Current Line
    ["color-border-hover", "#0081d6"], // spec: interactive borders use functional colors
    ["color-brand", "#815cd6"], // spec: focus rings use Functional Purple
    ["color-primary", "#815cd6"],
    ["color-card", "#343746"], // Background Light: the raised step (ladder shifted one step down)
    ["color-card-selected", "#424450"], // Background Lighter: the selection state
    ["color-popover", "#282a36"], // Floating interactive elements
    ["color-input", "#191a21"],
    ["color-secondary", "#343746"], // Background Light — with the raised card
    ["color-tag", "#343746"],
    ["color-context-track", "#343746"], // best visible track against the `#191a21` side-pane well (1.47, worst band 4.33)
    // De-emphasis TEXT is no longer Comment: `#6272a4` scored 2.51–3.68 across
    // the surfaces its 88 consumers actually paint. See the token's comment.
    ["color-foreground-subtlest", "color-mix(in oklab, #f8f8f2 55%, transparent)"],
  ])("maps %s to the spec value %s", (token, expected) => {
    // The decisions the block exists to make, pinned individually so a revert
    // names the token rather than reporting a diff in a 114-entry snapshot.
    expect(DRACULA_VALUES[token], `${token} missing from .theme-dracula-dark`).toBe(expected);
  });

  it("derives subtle text from Foreground rather than inventing a hue", () => {
    // The spec has no "subtle text" token, Comment (3.03) cannot carry body
    // copy, and the previous value (`#9aa4c4`) was invented. Deriving from
    // Foreground at 70% is the one move that stays on-palette at every
    // elevation, so it is asserted as a formula and not as a hex.
    expect(DRACULA_VALUES["color-foreground-subtle"]).toBe(
      "color-mix(in oklab, #f8f8f2 70%, transparent)",
    );
  });

  it("puts the content slab on the spec's Background step, one rung down", () => {
    // `--color-chat` is the most-used surface in the app: the
    // transcript column (`ChatStream.tsx`), the side pane (`SidePane.tsx`) and
    // the composer island (`ComposerRow.tsx`) all read it, so one declaration
    // keeps the three islands in agreement by construction.
    //
    // IT USED TO BE A DERIVATION — `color-mix(var(--color-background-win-alt)
    // 33%, transparent)`, compositing to `#2c2e3b` — and that formulation had a
    // cost nobody noticed at the time: a `color-mix()` is not comparable as a
    // hex, so the ladder test had to EXEMPT it. The app's primary surface sat
    // outside the gate that exists to police surfaces. Taking the spec's step
    // literally puts it ON a rung and back inside the ladder, which is why the
    // exemption is gone from the ladder test and must not come back. The slab
    // was Background Light `#343746`; the one-step-down shift (amendment to
    // ADR 0027) re-anchored it to the spec's Background `#282a36`, with
    // everything else following one rung down.
    expect(DRACULA_VALUES["color-chat"]).toBe("#282a36");

    // The slab is the TOP resting plane, so everything the app treats as
    // recessed or as chrome must sit below it and everything raised above.
    // These are the relationships the island layout now depends on.
    const lum = (v: string) => {
      const n = parseInt(v.slice(1), 16);
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const slab = DRACULA_VALUES["color-chat"]!;
    // Chrome frames the islands, so it must be DARKER than them or the islands
    // stop being islands. 1.35 measured (slab `#282a36` vs chrome `#191a21`).
    expect(lum(slab), "the slab must read above the chrome").toBeGreaterThan(
      lum(DRACULA_VALUES["color-background"]!),
    );
    // A card INSIDE the slab must separate from it. The three `bg-panel`
    // consumers have no borders, so this is the only thing that makes a card a
    // card. Recessing gives 1.34; the old `#343746` measured exactly 1.00.
    const panel = DRACULA_VALUES["color-panel"]!;
    expect(lum(panel), "a borderless card inside the slab would be invisible").toBeLessThan(
      lum(slab),
    );
    // default dark is NOT part of the island scheme and must not move (its slab is
    // still a 60% mix of `#2b2b2b` over its own `#161616` page, i.e. `#232323`).
    expect(DEFAULT_DARK_VALUES["color-chat"]).toBe(
      "color-mix(in oklab, var(--color-background-win-alt) 60%, transparent)",
    );
  });

  it("keeps the titlebar and the left sidebar on ONE plane", () => {
    // THE INVARIANT IS "SAME TOKEN", NOT "SAME HEX AS THE PAGE".
    //
    // This test used to assert `--color-frame: var(--color-background)`, and
    // its comment blamed the seam on the sidebar sitting on `#21222c`. That
    // diagnosis was wrong, and the wrongness is worth keeping: the seam was
    // never caused by WHICH step the sidebar was on, it was caused by the
    // titlebar and the sidebar reading DIFFERENT tokens (`bg-background` vs
    // `bg-frame`). The alias hid that by making the two tokens accidentally
    // equal, so the invariant was enforced by a coincidence rather than by
    // construction.
    //
    // It is now enforced structurally: the chrome bar reads `bg-frame`, the same
    // token `SpacesList` reads, so the two CANNOT drift apart whatever the palette
    // says. That is what the JSX half of this test pins, and it is why moving the
    // chrome band to `#191a21` draws no seam.
    //
    // SCANNED ACROSS `src/**/*.tsx`, NOT READ OUT OF ONE FILE. This used to be
    // `readFileSync("src/App.tsx")` plus a regex tuned to that file's attribute
    // ORDER (its `className` sits on the line BEFORE `data-testid`, and the
    // comment here recorded that a wider `[\s\S]` window had once reached past the
    // bar into the settings branch and pinned the WRONG ELEMENT). Pinning a
    // palette invariant to one file's line layout is the failure mode Finding 1 is
    // about: move the chrome bar into its own component — a change this program
    // will make — and the gate fails with "chrome bar not found", which is a
    // complaint about WHERE the element lives, not about what it wears.
    //
    // It stays TEXTUAL on purpose, and that is a considered limit rather than an
    // unfinished job. This file is a CSS/token test that imports no React; the
    // invariant it owns is "the element the app calls its chrome bar wears
    // `bg-frame`", which is a class-string fact about one element. Mounting the
    // app root to read the class off the DOM would pull the whole application
    // graph — every store, the IPC layer, the dialogs — into a palette test, and
    // would make a colour gate depend on `App`'s store wiring. The honest scope is
    // file-AGNOSTIC and still textual.
    //
    // The tag is matched as ONE tag: `[^<>]` cannot cross a tag boundary, so the
    // scan cannot walk off the bar into a sibling the way the old `[\s\S]` window
    // did. `data-testid="chrome-bar"` is the element's identity — the same handle
    // `App.test.tsx` queries it by.
    const CHROME_BAR_TAG = /<[a-zA-Z][\w.-]*(?:\s[^<>]*?)?data-testid="chrome-bar"[^<>]*>/g;
    const chromeBars = tsxSourceFiles()
      .map((file) => ({
        file,
        // `null` = the file vanished between `tsxSourceFiles` and this read; it
        // carries no tags because it carries no text, and `sourceSweep.ts`
        // records the skip rather than hiding it.
        tags: (sweep.listed(file) ?? "").match(CHROME_BAR_TAG) ?? [],
      }))
      .filter((found) => found.tags.length > 0);
    // Exactly ONE. Zero means the bar moved somewhere the scan cannot see (a
    // computed `data-testid`, or a renamed handle) — which is the moment this gate
    // stops defending anything, so it fails loudly instead of quietly scanning
    // nothing; two means the app has two chrome bars and "the titlebar is on the
    // sidebar's plane" is a claim about an ambiguous element. Note that the
    // message names the FILES, so the count assertion carries no file binding: the
    // bar may leave `App.tsx` for its own component and this stays green, which is
    // the whole point of dropping `readFileSync("src/App.tsx")` above.
    expect(
      chromeBars.map((found) => `${found.file} (${found.tags.length})`),
      "expected exactly one element carrying data-testid=\"chrome-bar\" in src/**/*.tsx",
    ).toHaveLength(1);
    const chromeBar = chromeBars[0]!.tags[0]!;
    // The bar's OWN `className` attribute — read out of the tag, so nothing
    // outside the element can satisfy the class assertion.
    const className = chromeBar.match(/className="([^"]*)"/)?.[1];
    expect(className, "the chrome bar has no string className to read").toBeTruthy();
    expect(className!, "the titlebar must read the same token as the sidebar").toMatch(
      /(^|\s)bg-frame(\s|$)/,
    );

    // The band itself: `#191a21` (Background Darker), i.e. the chrome now reads
    // as the DEEPEST recessed plane and the islands float above it. Pinned as a
    // hex because unlike the pairing above, this value IS a free choice and
    // could drift.
    expect(DRACULA_VALUES["color-frame"]).toBe("#191a21");
    // The same step as the other recessed surfaces, so the recess is ONE step
    // and not two. Asserted against them rather than a literal so the whole
    // recessed band moves together if it ever has to.
    expect(DRACULA_VALUES["color-frame"]).toBe(DRACULA_VALUES["color-input"]);
    expect(DRACULA_VALUES["color-frame"]).toBe(DRACULA_VALUES["color-popover-header"]);
    // And it must stay BELOW the page: chrome above the content would invert the
    // frame the islands sit in.
    expect(
      DRACULA_VALUES["color-frame"],
      "the chrome band must not out-shine the page it frames",
    ).not.toBe(DRACULA_VALUES["color-background"]);
  });

  it("reserves Selection for selection, never as a border", () => {
    // `#44475a` is spec Selection and is 1.56 on the page — as `--color-border`
    // it erased the UI's structure. Pinned as a negative because the value is
    // legal elsewhere in the block, so the hex gate alone would not catch it.
    expect(DRACULA_VALUES["color-border"]).not.toBe("#44475a");
    expect(DRACULA_VALUES["color-input-border"]).not.toBe("#44475a");
    expect(DRACULA_VALUES["color-card-border"]).not.toBe("#44475a");
    expect(DRACULA_VALUES["color-tab-border"]).not.toBe("#44475a");
    expect(DRACULA_VALUES["color-popover-border"]).not.toBe("#44475a");
  });

  it("keeps a real elevation ladder, not one flat step", () => {
    // The spec's UI palette is a ladder and the first cut collapsed it, leaving
    // header == panel == page. Asserted as strict ordering of distinct surfaces,
    // and now over the FULL set of surface tokens rather than a five-token chain.
    //
    // Why the chain grew: the old chain was
    // `terminal-bg < popover-header < background < header < card`, and the three
    // tokens that turn out to have been INVERTED — `secondary`, `tag`,
    // `card-selected` — were simply not in it, so a palette that made a badge
    // fill brighter than the card it sits on stayed green. A ladder test only
    // gates the links it names, so it names every surface token the block owns.
    //
    // THE READER IS THE KIT'S (`resolveToHex`, through `DRACULA_CASCADE` below),
    // not this test's old local `resolve`, which understood one hop of `var()` and
    // nothing else. That sufficed for Dracula, whose ladder tokens are all
    // literals, and was wrong in general: a light reading whose `card` is
    // `var(--color-input)` resolved to the literal string `var(…)` and the ladder
    // then asserted `/^#[0-9a-f]{6}$/` on it. The merged resolver handles `#rgba`,
    // `#rrggbbaa`, `rgb()`, a single-colour `color-mix` and `var()` hops and THROWS
    // with the token name on anything it cannot reduce — the property that keeps a
    // token from being graded on a surface it does not paint.
    /**
     * The ladder as ORDERED GROUPS. Tokens inside one group are a deliberate
     * PLATEAU (they are one band of chrome and share a step, exactly as
     * `.theme-default-dark` gives its header and panel one value); consecutive groups
     * must be STRICTLY ordered, and a token may not appear in two groups.
     *
     * `secondary` / `tag` sit with `card` because they are the raised step: a
     * `bg-secondary` badge lands inside a `bg-menu`/`bg-popover` float, so it
     * must read as raised above it, and the inline-code chip (which aliases
     * `tag`) must not be brighter than the card it lands on — which is the
     * inversion this group boundary now forbids.
     *
     * `card-selected` is the one token ABOVE the ladder: it is spec SELECTION, a
     * transient pressed/selected state, and the spec's own rule is that Selection
     * is the brightest step. It is therefore asserted as strictly brighter than
     * every resting surface rather than as a rung, and pinned to appearing
     * nowhere else at all.
     *
     * THE ISLAND LAYOUT MOVED THREE TOKENS, and one of them is now graded that
     * used to be invisible to this test:
     *   `color-chat` — the content slab — WAS `color-mix(…)`, which is
     *   not comparable as a hex, so it was EXEMPTED below. It is now a literal
     *   spec step (first `#343746`, then re-anchored to `#282a36` by the
     *   one-step-down shift), so the exemption is gone and the slab is
     *   classified with the floats. That is the whole point of taking the
     *   spec's step literally:
     *   the most-used surface in the app is now inside the gate instead of
     *   outside it.
     *   `color-panel` moved from the floating step DOWN to recessed, because its
     *   three consumers are cards INSIDE the slab and they have no borders.
     *   `color-context-track` sits on the RAISED step. It has now been on three
     *   steps across two layout changes and the reason keeps being the same: the
     *   track must differ from whatever the composer island wears, and the island
     *   moved twice. On `#191a21` it measured 1.47 against the `#343746` island;
     *   once the island became `#282a36` that fell to 1.218, under the 1.3 floor,
     *   and `#424450` became the only non-Selection candidate that reads.
     *
     * THE REGION RENAME added `color-frame` and `color-composer`, and both land
     * on EXISTING steps rather than inventing rungs: `frame` (the gaps, the
     * titlebar, the session list) shares the recessed step, and `composer` shares
     * the page step. That is the point of naming regions — five spec steps still
     * cover every region, so a new theme assigns hues to places without needing a
     * sixth step.
     */
    const LADDER: Array<{ label: string; tokens: string[] }> = [
      {
        label: "the deepest AND the recessed plane — the terminal's paper, form controls, popover header, the cards inside the chat, and the FRAME the islands sit in (Background Darker + Background Dark merged: a one-step-down shift of the whole content collapsed the chrome and the recessed controls onto the deepest rung)",
        tokens: [
          "color-terminal-bg",
          "color-input",
          "color-input-focused",
          "color-popover-header",
          "color-panel",
          "color-frame",
        ],
      }, // #191a21 Background Darker
      {
        label: "the page plane AND the composer island (the inspector's backdrop, tabs' active state)",
        tokens: ["color-background", "color-composer"],
      }, // #21222c Background Dark
      {
        label: "the chat column, the inspector AND every float (header, tabs, menus, popovers, toasts, tooltips) — and the ACTIVE TAB, which is the chat sheet showing through the frame",
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
      }, // #282a36 Background == Floating interactive elements
      {
        label: "raised (cards, badges, the inline-code chip, menu hover, the context bar's track)",
        tokens: [
          "color-card",
          "color-secondary",
          "color-tag",
          "color-tooltip-tag",
          "color-menu-hover",
          "color-context-track",
        ],
      }, // #343746 Background Light
    ];

    // THE TABLE IS THE RECORD; THE ROW IS THE SOURCE. `gradePalette` runs the
    // ordering predicate over EVERY Palette's `ladderGroups` (in the per-Palette
    // describe), and Dracula's groups now live in `src/lib/palettes/dracula.ts`.
    // What this assertion does that the kit cannot is hold that row to the table
    // the ADRs reasoned about: same groups, same order, same membership. A row
    // edited to forgive an inversion — a group merged, a rung dropped — fails here
    // even though it would grade clean against itself.
    expect(LADDER.map((group) => group.tokens)).toEqual(
      DRACULA_SPEC.modes.dark!.ladderGroups.map((group) => [...group.tokens]),
    );
    // The LABELS are the row's own prose and are deliberately not compared: they
    // appear in the kit's failure messages, and requiring two files to phrase the
    // same rung identically would buy nothing. MEMBERSHIP and ORDER are the claim.

    const resolve = DRACULA_CASCADE.resolve;

    // A plateau is a plateau: every token in a group must be the SAME colour,
    // otherwise "deliberate plateau" is hiding a fourth untracked step. Re-checked
    // here on THIS table (the kit asserts the same over the row) because the
    // `#44475a`-as-`secondary` bug was exactly a step nobody had grouped.
    const seen = new Set<string>();
    for (const group of LADDER) {
      const distinct = new Set(group.tokens.map((t) => resolve(t).toLowerCase()));
      expect(
        distinct.size,
        `${group.label}: claimed as one step but carries ${distinct.size} colours (${[...distinct].join(", ")})`,
      ).toBe(1);
      for (const token of group.tokens) {
        expect(seen.has(token), `${token} is named in two ladder groups`).toBe(false);
        seen.add(token);
      }
    }

    // Every surface token the block declares is either in a group above or is
    // Selection — so the ladder cannot be widened past this test by adding a
    // surface token nobody classified. The PATTERN is the row's
    // (`surfaceTokenPattern`), so a Palette cannot shrink what gets classified;
    // the SET here is derived from the block, so a renamed token cannot vanish.
    const unclassified = Object.keys(DRACULA_VALUES)
      .filter((t) => DRACULA_SPEC.modes.dark!.surfaceTokenPattern.test(t))
      // `card-selected` is Selection (asserted above the ladder, not on it) and
      // nothing else is exempt any more: every region token — `frame`, `chat`,
      // `inspector`, `composer` included — is classified above, so a new region
      // token cannot slip in ungraded and a renamed one cannot quietly vanish.
      .filter((t) => !seen.has(t) && !DRACULA_SPEC.modes.dark!.selectedTokens.includes(t))
      .sort();
    expect(unclassified, "surface tokens missing from the ladder").toEqual([]);

    // THE INVERSION ITSELF, named. `secondary`/`tag` were `#44475a` (L 0.0647),
    // brighter than `card` `#424450` (L 0.0587), so a badge inside a dropdown
    // separated from its own float by 1.06 and the inline-code chip out-shone the
    // card it sat on. Pinned directly, in words, so a regression reports the bug
    // and not a group ordering.
    expect(lumOf(resolve("color-secondary"))).toBeLessThanOrEqual(
      lumOf(resolve("color-card")),
    );
    expect(lumOf(resolve("color-tag"))).toBeLessThanOrEqual(
      lumOf(resolve("color-card")),
    );
    // And Selection stays the one thing brighter than the raised step, because it
    // is a state and not a surface. `strictly-above-all` is the row's rule and the
    // kit enforces it for every group; this is the same fact named in prose.
    expect(DRACULA_SPEC.modes.dark!.selectionRule).toBe("strictly-above-all");
    expect(lumOf(resolve("color-card-selected"))).toBeGreaterThan(
      lumOf(resolve("color-card")),
    );
  });

  it("uses spec Selection for selection ONLY — never a border, never a resting surface", () => {
    // With the ladder shifted one step down, `#44475a` (the spec's Selection)
    // is no longer the app's selected-state step (that is `#424450`); it survives
    // only as the terminal's TRANSLUCENT selection overlay, which sits over
    // whatever the cell painted and so is not a resting surface. The border half
    // is kept (a `var()` alias makes the exact-set test blind to a border that
    // ALIASES a Selection-valued token). Asserted as an EXACT SET of the tokens
    // that may carry the raw `#44475a`, so adding one fails by name.
    const carriers = Object.entries(DRACULA_VALUES)
      .filter(([, v]) => v.toLowerCase().includes("#44475a"))
      .map(([t]) => t)
      .sort();
    expect(carriers).toEqual(["color-terminal-selection"]);
    // The border assertions, kept (a `var()` alias makes the exact-set test blind
    // to a border that ALIASES a Selection-valued token).
    for (const token of [
      "color-border",
      "color-input-border",
      "color-card-border",
      "color-tab-border",
      "color-popover-border",
    ]) {
      const v = DRACULA_VALUES[token] ?? "";
      expect(v, `${token} must not be Selection`).not.toContain("#44475a");
      expect(v, `${token} must not alias a Selection-valued token`).not.toMatch(
        /var\(--color-(card-selected|secondary|tag)\)/,
      );
    }
    // Non-vacuous: the set really is a subset of the block, and `#44475a` really
    // still lives where its NAME says it belongs — the terminal's translucent
    // selection overlay. What this gates is that the raw Selection hex stays
    // confined to that one token, so a future consumer cannot acquire it.
    expect(carriers.length).toBe(1);
    // And the app's selected-state step is the spec's Background Lighter.
    expect(DRACULA_VALUES["color-card-selected"]).toBe("#424450");
  });

  it("grades every surface the contrast gate it replaced graded (the refactor cannot weaken a predicate)", () => {
    // THE REFACTOR'S OWN REGRESSION NET, and the reason this test exists. The
    // predicate MOVED — out of this file's Dracula-only loop and into
    // `gradePalette`, which reads each row's `textSurfaces`. A row that named
    // FEWER surfaces than the loop it replaced would therefore grade less while
    // printing the same green, and nothing else in the suite would notice. That is
    // this repo's recorded failure in its purest form: "a pin that passes on the
    // broken thing is worse than no pin" — and a refactor that relocates a
    // predicate is exactly when it happens.
    //
    // So the OLD census is reproduced verbatim: every plain-hex token matching the
    // surface pattern `73d667fd`'s loop used, in the block it read
    // (`.theme-dracula-dark`), each graded against the floors that loop applied.
    // Every one of those readings must still be measured, either by naming the
    // token or by naming a token that resolves to the SAME hex (an alias step —
    // grading one of Dracula's two `#282a36` floats grades the other, which is why
    // `menu` == `popover` and `popover-header` == `panel` are not coverage lost).
    const OLD_SURFACE_PATTERN =
      /^color-(background|input|popover-header|panel|card|card-selected|menu|menu-hover|popover|tooltip)$/;
    const gradedHexesFor = (spec: (typeof SPECS)[number], mode: "light" | "dark") => {
      const modeSpec = spec.modes[mode]!;
      const cascade = cascadeFor(spec, mode);
      const graded = [
        ...modeSpec.textSurfaces.resting,
        ...modeSpec.textSurfaces.raised,
        ...modeSpec.textSurfaces.selected,
      ];
      return {
        graded,
        hexes: new Map(graded.map((token) => [cascade.resolve(token).toLowerCase(), token])),
      };
    };

    const draculaGraded = gradedHexesFor(DRACULA_SPEC, "dark");
    const oldCensus = Object.entries(DRACULA_VALUES)
      .filter(([, value]) => /^#[0-9a-f]{6}$/i.test(value.trim()))
      .filter(([token]) => OLD_SURFACE_PATTERN.test(token))
      .map(([token]) => token);
    // The old loop read TEN surfaces. If the parse finds fewer, the census itself
    // has shrunk and the comparison below is vacuous.
    expect(oldCensus.length).toBe(10);
    const lost = oldCensus.filter(
      (token) =>
        !draculaGraded.graded.includes(token) &&
        !draculaGraded.hexes.has(DRACULA_VALUES[token]!.trim().toLowerCase()),
    );
    expect(
      lost,
      `.theme-dracula-dark: the row grades FEWER surfaces than the gate it replaced — unmeasured readings: ${lost.join(", ")}`,
    ).toEqual([]);
    // The three floor tables the old loop carried (TEXT_TOKENS / RAISED_FLOOR /
    // SELECTED_FLOOR) named 7 tokens over those 10 surfaces. The row must carry at
    // least as many token × surface pairs, or the move dropped measurements.
    expect(draculaGraded.graded.length * GRADED_TEXT_TOKENS.length).toBeGreaterThanOrEqual(
      10 * 7,
    );

    // THE OTHER DIRECTION, which is the actual gain: the palette the old gate did
    // NOT grade at all. Both Default readings are graded now, on at least four
    // surfaces each, with their own measured floors — where before this task the
    // Default palette's status hues were graded by NOTHING in this file. A row that
    // was later hollowed out would fail the same non-vacuity floor the kit applies.
    for (const spec of SPECS) {
      for (const mode of ["light", "dark"] as const) {
        const modeSpec = spec.modes[mode];
        if (modeSpec === undefined) continue;
        const count =
          modeSpec.textSurfaces.resting.length +
          modeSpec.textSurfaces.raised.length +
          modeSpec.textSurfaces.selected.length;
        expect(
          count,
          `${spec.id} ${mode}: ${count} graded surfaces — one page and one float is not a contrast gate`,
        ).toBeGreaterThanOrEqual(4);
        expect(
          modeSpec.textSurfaces.resting.length,
          `${spec.id} ${mode}: grade text on the page AND a float`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
    expect(DEFAULT_SPEC.id).toBe("default");
  });

  it("keeps text tokens legible on EVERY surface their consumers actually paint", () => {
    // The gap every other contrast test in this repo has: they all grade against
    // a palette's `--color-background`, and the tokens they name overwhelmingly
    // render on the FLOATING surfaces. `--color-destructive` is the proof —
    // 4.53 on the page, one notch from the spec's 4.5 floor, and 4.33 on
    // `#343746`, which is where the error copy actually lives (`NewSpaceDialog`,
    // `SudoConfirmModal`/`SudoPasswordModal` on `bg-popover`, the six ✗ rows in
    // `SubagentDelegatingCard` on `bg-panel`, the `data-[variant=destructive]`
    // dropdown item on `bg-menu`). A page-only floor is how that survived.
    //
    // THE PREDICATE NOW RUNS OVER EVERY ROW, in `gradePalette`'s three
    // `gradeSurfaceSet` passes (resting / raised / selected, each with its own
    // floor table and its own 4.5-expiry ratchet). What stays here is this
    // Palette's record of the three numbers the ADRs argue about, and the tables
    // they came from — because the reason `destructive` sits below 4.5 on the
    // raised step is a Dracula fact (the spec publishes no red that clears it
    // there) and a shared gate cannot carry that reasoning for five other schemes.
    //
    // Floors: 4.5 for text (the spec's own minimum). Surfaces are named by TOKEN
    // in the row, so a palette that moves a surface moves the test with it.
    const modeSpec = DRACULA_SPEC.modes.dark!;
    /**
     * The tokens the old gate held to a text floor: the seven COPY tokens whose
     * consumers this file counted. `GRADED_TEXT_TOKENS` in the kit is the same
     * list and is asserted to be it below — which tokens count as copy is a fact
     * about the APP, not about a scheme, so no row may shrink it.
     */
    const TEXT_TOKENS = [
      "color-destructive",
      "color-caution",
      "color-foreground-subtlest",
      "color-foreground-subtle",
      "color-foreground",
      "color-success",
      "color-warning",
    ];
    expect([...GRADED_TEXT_TOKENS].sort()).toEqual([...TEXT_TOKENS].sort());

    /** The one token the old `RAISED_FLOOR` exempted on the resting raised step,
     *  pinned to the number it DOES reach, with the reason. This is a reported
     *  shortfall, not a fudge — and it is the reason the code-block header moved
     *  off `bg-card`.
     *
     *  `destructive` `#ff6e6e` (4.33): the brightest red the specification
     *  publishes. Nothing spec-published reaches 4.5 on `#343746`, and the
     *  alternative that would — AnsiBrightMagenta `#ff92df` — is Pink, a syntax
     *  hue this palette uses for strings.
     *
     *  `foreground-subtlest` is NOT exempted on the resting raised step: the
     *  one-step-down shift moved that step from `#424450` to `#343746` (one rung
     *  darker), and at 55% it clears 4.5 there (4.57).
     *
     *  THE RATCHET IS THE PART THAT MATTERS. The old table was a bare number and a
     *  separate `expect(c).toBeLessThan(4.5)` in a loop; the row expresses the same
     *  rule as `expiresAt: 4.5`, which the kit asserts for every class of surface
     *  independently. Asserted as an equality on the row, so the exemption cannot
     *  be widened, lowered, or quietly deleted without failing HERE: a merged floor
     *  table would also have made the ratchet fire on a surface it was never about
     *  (`destructive` clears 4.5 on the PAGE, so a merged table reads the raised
     *  exemption as stale).
     */
    expect(modeSpec.raisedFloors).toEqual({
      "color-destructive": expect.objectContaining({ floor: 4.3, expiresAt: 4.5 }),
    });
    /** The two tokens the old `SELECTED_FLOOR` exempted on the SELECTION STATE
     *  `#424450`, one rung above the raised step and therefore worse for a
     *  dark-adjacent hue: `destructive` `#ff6e6e` reaches 3.54 there and
     *  `foreground-subtlest` (55%) reaches 4.01. Raising the latter to clear 4.5
     *  would make it indistinguishable from `foreground-subtle` (at 60% the two
     *  separate by only 1.11 on `#424450`), and a de-emphasis token that is not
     *  de-emphasised is a different bug than a 0.5 shortfall on a transient state
     *  it rarely renders on. Graded as its OWN class for that reason.
     */
    expect(Object.keys(modeSpec.selectedFloors).sort()).toEqual([
      "color-destructive",
      "color-foreground-subtlest",
    ]);
    expect(modeSpec.selectedFloors["color-destructive"]!.floor).toBe(3.3);
    expect(modeSpec.selectedFloors["color-foreground-subtlest"]!.floor).toBe(3.8);
    // Nothing is exempt on the PAGE: every graded token clears 4.5 there, which is
    // what makes the resting class the reference and the other two the exception.
    expect(modeSpec.textFloors).toEqual({});
    // And Dracula names NO ungradeable text token — every reading is a literal hex
    // or a single-colour `color-mix` the resolver reaches. An empty map is an
    // assertion here, not an omission: the kit fails any entry a Palette names in
    // `textUngradeable` that it could in fact have graded.
    expect(modeSpec.textUngradeable).toEqual({});

    // The three measurements themselves, restated so the numbers in the prose
    // above stay MEASURED rather than recalled (ADR 0096: "count it, do not recall
    // it"). These are the tightest readings of their class.
    const cascade = DRACULA_CASCADE;
    expect(contrast(cascade.resolve("color-destructive"), cascade.resolve("color-card")))
      .toBeCloseTo(4.33, 1);
    expect(contrast(cascade.resolve("color-destructive"), cascade.resolve("color-card-selected")))
      .toBeCloseTo(3.54, 1);
    expect(
      contrast(
        resolveToHex(
          "color-foreground-subtlest",
          cascade.tokens["color-foreground-subtlest"]!,
          cascade.tokens,
          cascade.resolve("color-card-selected"),
        ),
        cascade.resolve("color-card-selected"),
      ),
    ).toBeCloseTo(4.01, 1);

    // Non-vacuity, in the direction the old gate pinned as a count: seven tokens
    // over the non-raised surfaces plus the pinned raised and selected pairs is
    // dozens of measurements. The row's surface sets are what make that true, so
    // they are counted here rather than asserted as a report length.
    const readings =
      modeSpec.textSurfaces.resting.length +
      modeSpec.textSurfaces.raised.length +
      modeSpec.textSurfaces.selected.length;
    expect(readings * GRADED_TEXT_TOKENS.length).toBeGreaterThanOrEqual(40);
  });

  it("splits the subtlest-TEXT role from the context-bar TRACK role", () => {
    // `--color-foreground-subtlest` had TWO jobs, and they need opposite values.
    //
    // As text it is documented "never body text", which was untrue: 88 call
    // sites read it for small body-size copy (the sidebar's "Sessions" header,
    // dropdown/select labels and `data-disabled:` items, the
    // `SessionConfigSelect` trigger value, `ToolCallCardHeader` metadata, the
    // `SubagentDelegatingCard` metadata line), and Comment `#6272a4` scored
    // 3.36 on the page, 3.68 on `bg-input`, 3.03 on the panel and 2.51 on the
    // card — under the 4.5 text floor on every one of them.
    //
    // As a FILL it was the context bar's track, where its job is the OPPOSITE:
    // to be far enough from the band fills that the bands are visible. That is
    // why it could not simply be lightened — lightening the track into a pale
    // grey collapses fill-vs-track contrast to ~1.06 and the bar loses its
    // meaning entirely.
    //
    // So the roles are split. The text token gets a lightened reading that
    // clears the floor (asserted above, per surface); the bar gets its own
    // token, declared per palette, so default keeps the track it has always had and
    // Dracula gets one chosen for band separation.
    expect(DRACULA_VALUES["color-context-track"]).toBe("#343746");
    // The text token must no longer be the border/Comment colour, or the split
    // did not happen — it is one declaration and the two roles are back.
    expect(DRACULA_VALUES["color-foreground-subtlest"]).not.toBe(
      DRACULA_VALUES["color-border"],
    );
    // And the track must be a SURFACE value, not the text value.
    expect(DRACULA_VALUES["color-context-track"]).not.toBe(
      DRACULA_VALUES["color-foreground-subtlest"],
    );
  });

  it("leaves the DEFAULT palette's context-bar track byte-identical (the split must not move default)", () => {
    // The role split is a Dracula fix, and the brief is explicit that default must
    // not move. `--color-context-track` is therefore declared in `@theme` and in
    // both default blocks as a pure ALIAS back to `--color-foreground-subtlest`, so
    // those readings composite to exactly the colour they composited to before
    // the token existed — and `.theme-default-light`, which declares no
    // `foreground-subtlest` of its own, resolves through `.dark`/`@theme` the
    // same way it always did. Pinned as the ALIAS rather than a resolved value:
    // if someone later restates the default palette's subtlest, the track follows
    // it, which is the pre-split behaviour.
    //
    // THE SUBJECT IS THE DEFAULT PALETTE AND THE BASE LAYERS, and this used to be
    // wrong about it. It read `ALL_LAYERS.filter(name !== dracula)`, i.e. "every
    // block in the repo that is not Dracula's", and asserted the ALIAS on all of
    // them. That generalises a decision nobody made. The rule exists because the
    // Dracula role-split must not have MOVED `default`; it says nothing about a
    // Palette that has never had a track to move. A new Palette may legitimately —
    // and usually must — state its OWN `--color-context-track` value, because the
    // track has to separate from that Palette's own surfaces: Dracula's `#343746`
    // is chosen against Dracula's `#282a36` pane, and the gate twelve lines below
    // grades exactly that choice per Palette. So the generalisation asserted "every
    // future palette aliases the text token", which is false on its face, and it
    // fired on the Wave-3 probe (`expected '#343746' to be
    // 'var(--color-foreground-subtlest)'`) for a Palette that had broken nothing.
    //
    // DERIVED, not hardcoded — but derived from the rule's SUBJECT, not from
    // everything-but-one: the two base layers and the Default palette's readings,
    // all four declared by the file `DEFAULT_SPEC.baseCssFile` names. A fifth
    // Default reading would join this loop with no edit here; a second Palette
    // would correctly NOT.
    const aliasLayers = trackAliasLayers();
    expect(aliasLayers).toEqual([
      "@theme",
      ".dark",
      ".theme-default-light",
      ".theme-default-dark",
    ]);
    for (const name of aliasLayers) {
      // `appLayerValues`: the subject is the SHIPPED cascade, so the lookup is the
      // registry-derived one. Same text either way for these four blocks, but the
      // call site says which enumeration it means.
      const v = appLayerValues(name)["color-context-track"];
      expect(v, `${name} must declare the track as an alias`).toBe(
        "var(--color-foreground-subtlest)",
      );
    }
    // And a Palette that DOES state its own track is not exempt from scrutiny — it
    // is graded by the band-separation gate below, which is the per-Palette rule.
    // Dracula's own reading, asserted in the test above, is the instance.
    expect(
      appLayerValues(`.${paletteClass(DRACULA_SPEC.id, "dark")}`)["color-context-track"],
    ).not.toBe("var(--color-foreground-subtlest)");
    // `.theme-default-light` carries it too, and that is forced rather than
    // optional: the existing "default blocks untouched" gate asserts that block
    // declares EXACTLY `.dark`'s token set, so an alias added to `.dark` has to
    // appear there. It is still a no-op — it resolves to the same colour the
    // component already read.
    // And the default `foreground-subtlest` values the split touched NOTHING: each
    // block still declares the reading it always did, so the alias is inert.
    expect(DARK_VALUES["color-foreground-subtlest"]).toContain("neutral-200");
    expect(layerValues(".theme-default-dark")["color-foreground-subtlest"]).toContain(
      "neutral-300",
    );
  });

  it("gives the context bar a track that keeps every band legible", () => {
    // The bar's meaning is the band FILL (green → caution → warning → red), and
    // the only thing separating it from the unfilled remainder is the track.
    // Graded against the four fills the component actually emits
    // (`lib/sessionConfig.ts`'s ramp, rendered by `SessionConfigBlock.tsx`:
    // `bg-success` / `bg-caution` / `bg-warning` / `bg-destructive`), on the
    // surface the track really paints on.
    //
    // THAT SURFACE HAS MOVED THREE TIMES. The bar sat in a `bg-input` well; the
    // island layout moved the composer onto its own plane (gate re-pointed at
    // `--color-composer`); the config lines left the composer for the side pane
    // and got a fresh `bg-input` well (gate re-pointed at `--color-input`); and
    // the well is now GONE — the user read it as a sunken slot inside a plane
    // and asked for it removed (`SessionConfigBlock.tsx`'s component note). The
    // track's pixels land on `--color-inspector`, so this reads `color-inspector`.
    // Each move left the gates naming a surface nothing paints on, which is
    // exactly the failure this file's amendments keep recording — and each time
    // the WRONG token kept the suite green, because a contrast assertion against
    // a surface that is not there still passes.
    const surface = DRACULA_VALUES["color-inspector"]!;
    const track = DRACULA_VALUES["color-context-track"]!;
    const lumOf = (hex: string) => {      const n = parseInt(hex.slice(1), 16);
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return (
        0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
      );
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [lumOf(a), lumOf(b)].sort((m, n) => n - m);
      return (x + 0.05) / (y + 0.05);
    };
    const bands: Record<string, string> = {
      "bg-success": DRACULA_VALUES["color-success"]!,
      "bg-caution": DRACULA_VALUES["color-caution"]!,
      "bg-warning": DRACULA_VALUES["color-warning"]!,
      "bg-destructive": DRACULA_VALUES["color-destructive"]!,
    };
    const ratios: Record<string, number> = {};
    for (const [band, hex] of Object.entries(bands)) {
      expect(hex, `${band} must be a plain hex`).toMatch(/^#[0-9a-f]{6}$/i);
      const c = contrast(hex, track);
      ratios[band] = Math.round(c * 100) / 100;
      // 3:1 — a progress band is non-text UI.
      expect(c, `${band} (${hex}) against the track ${track}`).toBeGreaterThanOrEqual(3);
    }
    // The track must also read against the pane, or the bar's extent (how much
    // is left) is invisible and the track is doing no work at all. The floor is
    // 1.2, and that is the honest number: 1.3 was only measurable because of
    // the well. Against the bare pane the palette has NO step at 1.3 —
    // `#343746` measures 1.208, `#191a21` 1.218, `#21222c` 1.109 — so the old
    // floor would have demanded a Selection hex, which the elevation ladder
    // fences off absolutely. 1.2 still rejects the real collisions: a track that
    // IS the pane (`#282a36` at 1.000) or the page plane under it (`#21222c` at
    // 1.109). See also the `slabFloatSeparation.test.ts` gate, which pins the
    // same pair from the separation side.
    expect(
      contrast(track, surface),
      `the track ${track} is invisible against the pane ${surface} it rides`,
    ).toBeGreaterThanOrEqual(1.2);
    // WHY `#343746` AND NOT THE DARK STEP — stated as a measurable criterion.
    //
    // The two candidates that clear 1.2 are a RAISED step (`#343746`, 1.208
    // above the pane) and the RECESSED step (`#191a21`, 1.218 below it). Their
    // separation is a 0.8% difference — noise, not a decision — and the dark one
    // wins the old "maximise the worst band" ranking outright (6.36 vs 4.33).
    // That ranking is therefore GONE, because following it here is how the box
    // came back: a track darker than its surface is a GROOVE, and the groove is
    // what the user just rejected, twice, as a well. The bar rides the pane, so
    // the unfilled remainder must read as a rail ON the plane, never a slot
    // cut into it. So the criterion is directional:
    const lighter = Object.entries(DRACULA_VALUES).filter(
      ([t, v]) =>
        /^#[0-9a-f]{6}$/i.test(v) &&
        /^color-(card|panel|background|chat|composer|frame|input|popover-header|terminal-bg|secondary|tag|tooltip|toast|menu|header)$/.test(
          t,
        ) &&
        lumOf(v) > lumOf(surface),
    );
    //   (a) the track is LIGHTER than the pane — a rail, not a groove:
    expect(
      lumOf(track),
      `track ${track} sits BELOW the pane ${surface}: that is a groove, and the groove was rejected`,
    ).toBeGreaterThan(lumOf(surface));
    //   (b) it is the ONLY lighter non-Selection STEP in the block — one
    //       distinct hex, the raised plateau (three tokens wear `#343746`:
    //       `card`, `tag`, `secondary`), and every brighter resting value in
    //       the palette is Selection (`#424450`), which the ladder asserts
    //       appears nowhere as a resting surface. Enumerating distinct HEXES
    //       is the point: if someone adds a lighter resting step, this fails
    //       and the choice gets re-made on purpose.
    expect([...new Set(lighter.map(([, v]) => v))]).toEqual([track]);
    // Non-vacuity: the candidate pool really did contain darker steps that the
    // directional rule rejected, or (a) is just "not the pane".
    const darker = Object.entries(DRACULA_VALUES).filter(
      ([t, v]) =>
        /^#[0-9a-f]{6}$/i.test(v) &&
        /^color-(card|panel|background|chat|composer|frame|input|popover-header|terminal-bg|secondary|tag|tooltip|toast|menu|header)$/.test(
          t,
        ) &&
        lumOf(v) < lumOf(surface),
    ).length;
    expect(darker).toBeGreaterThanOrEqual(3);
    expect(Object.keys(ratios).length).toBe(4);
  });

});

/**
 * Cross-cutting ALIASES: tokens whose whole job is to point at another token,
 * so a palette can re-hue a surface by editing one declaration. These are the
 * most fragile links in the layering and the easiest to break silently — an
 * alias that is deleted, or that points at a token no block declares, does not
 * error, it just stops following the palette.
 */
describe("the @theme aliases that make a palette re-hue reach the UI", () => {

  it("aliases --color-icon-blue to the palette's ANSI bright blue", () => {
    // `text-icon-blue` has exactly two live consumers — markdown LINKS
    // (`MessageBubble.tsx`) and diff `@@` hunk headers (`DiffBlock.tsx`) — and
    // neither reads the settings store, so the ONLY thing that makes a link
    // follow the palette is this one line in `@theme`. Delete it and every link
    // silently reverts to the fallback hue under Dracula while the palette
    // itself still looks perfect; nothing else in the suite touches it. Pinned
    // as the ALIAS rather than a hex so the coupling survives any re-hue.
    expect(THEME_VALUES["color-icon-blue"]).toBe("var(--color-terminal-bright-blue)");
  });

  it("declares --color-terminal-bright-blue everywhere the alias could be resolved", () => {
    // A `var()` whose target no block declares resolves to nothing: the
    // property becomes invalid at computed-value time and the link inherits its
    // parent's colour — a failure mode with no error and no visual cue in dev.
    // These are the blocks that can be the winner for `<html>` (ADR 0027).
    // `@theme` and `.dark` must both carry it (every reading passes through one
    // of them); the palette blocks may, and Dracula does (AnsiBrightBlue).
    //
    // KIND (b), SO THE ENUMERATION IS THE REGISTRY (`APP_LAYERS`). "Can be the
    // winner for `<html>`" is a claim about what the app can apply, and only a
    // registered class can be applied — this used to sweep `ALL_LAYERS`, the
    // directory, so a Wave-3 row joined a gate about the live cascade and got
    // asked a question its Palette cannot yet answer. It still asks every FUTURE
    // registered Palette the same question, because `APP_LAYERS` grows with the
    // registry: the coverage the directory sweep was buying is exactly the
    // coverage a registry sweep buys, one step later and without the false
    // positive. Text still comes from each row's own file, so a registered Palette
    // whose `@import` has not landed is graded, not skipped.
    expect(APP_LAYERS.length).toBeGreaterThanOrEqual(5);
    for (const layer of APP_LAYERS) {
      const declaredHere = appLayerDeclared(layer.name).has("color-terminal-bright-blue");
      if (layer.name === "@theme" || layer.name === ".dark" || layer.name === `.theme-${DRACULA_SPEC.id}-dark`) {
        expect(declaredHere, `${layer.name} must declare the alias's target`).toBe(true);
      }
    }
    // And the Dracula reading is the spec's AnsiBrightBlue, i.e. the link colour
    // is the palette's own and not `.dark`'s sky leaking through.
    expect(DRACULA_VALUES["color-terminal-bright-blue"]).toBe("#d6acff");
  });

  it("names no var() target that the stylesheet never declares (no dangling alias)", () => {
    // Generalised net for the class of bug above, over the whole `@theme` block.
    // A `var(--x)` with no `--x` anywhere is the silent failure: the property is
    // invalid at computed-value time and the consumer inherits instead.
    //
    // Two target families are legitimately NOT declared in `index.css`, so they
    // are excluded BY PATTERN rather than by hand:
    //  - Tailwind's own colour scale (`--color-yellow-500` …), which the `@theme`
    //    namespace extension provides, and which no block restates;
    //  - the runtime-set custom properties (`--ui-font-size`), which
    //    `applySettingsFont` writes inline on `<html>`.
    // KIND (b), AND THE REGISTRY ENUMERATION IS THE STRONGER READING HERE. The
    // subject is `@theme`, which the app assembles whether or not any Palette
    // imports it, so the question "is this target declared anywhere the app can
    // see?" is a question about the app's cascade. Sweeping the DIRECTORY (the old
    // shape) makes the net WEAKER, not broader: an alias whose target lives only in
    // an UNREGISTERED Palette's file dangles in the shipped app today, and a
    // directory sweep would excuse it. `APP_LAYERS` catches that. The net still
    // catches a `var()` whose target lives only in a Palette nobody listed — with
    // the registry enumeration it now catches it on the day the Palette is
    // registered, and names it.
    const declaredAnywhere = new Set(APP_LAYERS.flatMap((layer) => [...appLayerDeclared(layer.name)]));
    const TAILWIND_SCALE = /^color-[a-z]+-\d{2,3}$/;
    // Tailwind's own non-numeric theme defaults, also not restated here.
    const TAILWIND_FIXED = new Set(["color-white", "color-black", "color-current", "color-transparent"]);
    const RUNTIME = /^ui-/;
    const targets = Object.values(THEME_VALUES).flatMap((v) => [
      ...[...v.matchAll(/var\(--([a-z][a-z0-9-]*)\)/g)].map((m) => m[1]!),
    ]);
    const appAliasTargets = targets.filter(
      (t) => !TAILWIND_SCALE.test(t) && !TAILWIND_FIXED.has(t) && !RUNTIME.test(t),
    );
    const dangling = [...new Set(appAliasTargets)]
      .filter((target) => !declaredAnywhere.has(target))
      .sort();
    expect(dangling).toEqual([]);
    // Non-vacuous: the block really does carry var() aliases (so the scan above
    // had something to look at), and the app-token kind — the kind that can
    // dangle — is what `--color-icon-blue` is.
    expect(appAliasTargets).toContain("color-terminal-bright-blue");
    const aliasCount = Object.values(THEME_VALUES).filter((v) =>
      /var\(--/.test(v),
    ).length;
    expect(aliasCount).toBeGreaterThan(20);
  });
});

/**
 * ══ CROSS-PALETTE WIRING — enumerated over the REGISTRY, not the spec directory ══
 *
 * WHY THE REGISTRY AND NOT `listPaletteSpecs()`. A grading row can legitimately
 * exist before its Palette is wired: that is exactly what the authoring waves do
 * — a Palette's CSS file and its row land together, its `@import`, its picker
 * entry and its Shiki theme land in the closeout. So a wiring gate that swept the
 * DIRECTORY would go red mid-plan for the plan's own state, and the temptation
 * would be to skip unregistered rows, which is how a gate becomes decorative.
 * Enumerating the REGISTRY gets both properties: nothing registered can be
 * half-wired, and nothing unregistered is demanded. The closeout task observes
 * this gate FAIL before the imports exist; that failure is its proof.
 *
 * The two invariants at the end are deliberately NOT per-spec: "at most one
 * `.theme-*` class" and "the layer order" are properties of the WHOLE cascade, so
 * a per-row loop could not express either one — a row knows its own block, not the
 * set they are members of.
 */
describe("every REGISTERED Palette is wired (registry, not spec directory)", () => {
  /** `src/index.css` as the build sees it: an assembly manifest of `@import`s. */
  const indexCss = readCssFile("src/index.css");

  for (const palette of PALETTES) {
    describe(palette.id, () => {
      it("has a CSS file that src/index.css imports", () => {
        // The import line, not the inlined text: a Palette whose file exists but
        // is never imported declares blocks nothing loads, and every grading gate
        // would still pass because they read the file directly. THAT asymmetry —
        // grading reads the file, the app reads the manifest — is the whole reason
        // this gate enumerates the registry.
        const spec = SPECS.find((row) => row.id === palette.id);
        expect(spec, `no spec row for the registered Palette "${palette.id}"`).toBeTruthy();
        // The manifest spells its imports relative to itself: `./styles/<file>`.
        expect(
          indexCss,
          `${palette.id}: ${spec!.cssFile} is not @imported by src/index.css, so the app never loads it`,
        ).toContain(`@import "./${spec!.cssFile.replace(/^src\//, "")}";`);
      });

      it("is offered by the Settings picker", () => {
        // The measured failure: the handler used to name both options it knew
        // (`value === <default> ? null : "dracula"`), which
        // wrote `"dracula"` for a third Palette's selection. The picker's options
        // and its save rule are now one expression over the registry, so a Palette
        // cannot be registered without being offered — and cannot be offered with a
        // rule that renames it.
        expect(
          PALETTE_PICKER_VALUES,
          `${palette.id} is registered but the picker does not offer it`,
        ).toContain(palette.id);
      });

      it("has every class toggled by applyThemeToDocument", () => {
        // The class invariant in `theme.test.ts` proves exactly one class ends up
        // on `<html>`. This proves the stronger, registry-shaped claim: EVERY
        // class the registry can name is reachable, so `applyThemeToDocument`'s
        // toggle loop cannot be left behind by a newly registered Palette. A class
        // that is never toggled ON is dead; one that is never toggled OFF is how
        // two co-exist.
        const cleared = themeClassNames();
        for (const mode of palette.modes) {
          document.documentElement.classList.remove("dark", ...cleared);
          // Cast, NOT a widened parameter. `PALETTES` is typed
          // `readonly PaletteDefinition[]` (deliberately — see its declaration),
          // so `palette.id` reaches here as `string` even though the registry
          // literal is `as const satisfies` and therefore really does hold the
          // `PaletteId` literals. Loosening `applyThemeToDocument`'s parameter to
          // `string` would erase the only compile-time catch for a typo'd palette
          // value, because the Rust side stores an unvalidated `Option<String>`
          // and `paletteFor` routes ANY unknown id to the Default — so a
          // `string`-typed parameter cannot fail, only silently resolve. The
          // cast is sound and is not merely assumed: the registry-enumeration
          // gate below pins `PALETTES.map(p => p.id)` to the exact literal list
          // `PaletteId` is derived from. Same shape as the registry sweeps in
          // `theme.test.ts` and `MessageBubble.codeblock.test.tsx`.
          applyThemeToDocument(palette.id as PaletteId, mode);
          const present = cleared.filter((candidate) =>
            document.documentElement.classList.contains(candidate),
          );
          expect(present, `${palette.id} ${mode}`).toEqual([paletteClass(palette.id, mode)]);
        }
        document.documentElement.classList.remove("dark", ...cleared);
      });

      it("has its Shiki ids loaded by BOTH highlighter singletons", async () => {
        // The fourth silent-pass gate. Each call site holds its OWN
        // `createHighlighter` promise and both used to list
        // `["github-dark", "dracula"]` verbatim, so a new Palette's
        // `codeToHtml` asked for a theme that was never loaded, THREW, and the
        // call site's bare `catch` rendered the plain fallback — wrong output,
        // green suite, no error anywhere. Reading `getLoadedThemes()` from both
        // singletons checks the answer Shiki holds rather than the argument it was
        // handed.
        const needed = [...new Set(palette.modes.map((mode) => shikiThemeFor(palette.id, mode)))];
        const loaded = [
          ...(await loadedShikiThemes()),
          ...(await loadedCodemodeShikiThemes()),
        ];
        for (const id of needed) {
          expect(loaded, `${palette.id}: Shiki theme "${id}" is not loaded`).toContain(id);
        }
      });
    });
  }

  it("enumerates the registry, and the registry is what this task promises", async () => {
    // The acceptance criterion "every Palette in the registry has its CSS, its
    // import and its picker entry" — no Palette may be offered before its CSS
    // exists, and this is where that is enforced rather than in prose. The
    // authoring waves add a row and a file WITHOUT touching this test, and the
    // closeout registers them here. EVERFOREST WAS THE FIRST to arrive that way;
    // the closeout registered the other four (catppuccin / ayu / rose-pine /
    // kanagawa) alongside it, so this list is the whole vocabulary the plan
    // promised rather than the plan's mid-flight state.
    expect(PALETTES.map((palette) => palette.id).sort()).toEqual([
      "ayu",
      "catppuccin",
      "default",
      "dracula",
      "everforest",
      "kanagawa",
      "rose-pine",
    ]);
    // THE ORDER, PINNED UNsorted. The `.sort()` above proves MEMBERSHIP and cannot
    // see a reorder — and order is the ONE thing the registry shape decides,
    // because it is the picker's order (`PALETTE_OPTIONS` is `PALETTES.map`, so the
    // list the user reads IS this list). Palette-vs-palette CSS order is inert (at
    // most one `.theme-*` class is ever present, so there is no tie for source
    // order to break), which is exactly why the picker's order is worth pinning
    // while the cascade's is not: `themeClassNames()`-derived gates deliberately
    // decline to pin the palettes' mutual order, leaving this as the only place
    // that claim is graded.
    //
    // The rule the order encodes: `default` FIRST because it is what a fresh
    // install gets, the three already-shipped rows keep their positions so existing
    // muscle memory does not churn, and the four new ones land in plan order after
    // Everforest.
    expect(PALETTES.map((palette) => palette.id)).toEqual([
      "default",
      "dracula",
      "everforest",
      "catppuccin",
      "ayu",
      "rose-pine",
      "kanagawa",
    ]);
    // And the picker really does render THAT list rather than a re-sorted copy —
    // the coupling the sentence above rests on. `PALETTE_PICKER_VALUES` is derived
    // from the registry in `palettePicker.ts`, so this holds by construction today;
    // it is asserted because the picker used to carry a hand-written list, and a
    // re-introduced one would drift here rather than in the save rule.
    expect(PALETTE_PICKER_VALUES).toEqual(PALETTES.map((palette) => palette.id));
    expect(DEFAULT_PALETTE_ID).toBe("default");
    // The registry's Shiki ids, deduplicated, are what both singletons must load.
    expect(shikiThemeIds().sort()).toEqual([
      "ayu-dark",
      "ayu-light",
      "catppuccin-latte",
      "catppuccin-mocha",
      "dracula",
      "everforest-dark",
      "everforest-light",
      "github-dark",
      "github-light",
      "kanagawa-lotus",
      "kanagawa-wave",
      "rose-pine",
      "rose-pine-dawn",
    ]);
    // The fallback is loaded too. Here it happens to coincide with a registry id
    // (`github-dark` is the Default palette's dark paper AND the fallback), so the
    // claim that matters is the one below: every id `shikiThemeFor` can ANSWER
    // with is loaded, including any answer a reading with no published id produces.
    for (const id of shikiThemesToLoad()) {
      expect(await loadedShikiThemes()).toContain(id);
    }
  });

  it("publishes a Shiki id for every mode it declares, so the documented fallback stays a last resort", async () => {
    // `PaletteDefinition.shiki` types its values `string | undefined` and promises
    // that an `undefined` reading "falls back to `SHIKI_FALLBACK_THEME`" rather
    // than throwing — and the registry comment states that "every mode the
    // registry declares SHOULD have an id, and `paletteCompleteness.test.ts`
    // asserts it". Until now NOTHING did, which left the promise doubly unheld:
    // the sweep above asserts `shikiThemesToLoad()` ⊆ what loaded, and today the
    // fallback COINCIDES with a registry id (`github-dark` is both the Default
    // palette's dark paper and the fallback), so deleting `SHIKI_FALLBACK_THEME`
    // from that union fails no gate at all. Deleting a name and having the suite
    // stay green is the silent-pass shape this whole task exists to close, so the
    // promise is pinned two ways:
    //
    // (1) every mode the registry DECLARES must publish an id — the assertion the
    //     comment advertises. This is the one with a trigger today: give the
    //     Default palette's dark reading `undefined` and it goes red.
    // (2) the fallback is in the load list and in BOTH singletons. Honest caveat,
    //     recorded rather than glossed: (2) is a TRIPWIRE, not a detectable
    //     mutation guard, precisely because of the coincidence above. It earns
    //     its place by failing the day the fallback stops being a registry id —
    //     the day it becomes load-bearing is the day it stops being checked by
    //     the sweep above.
    for (const palette of PALETTES) {
      for (const mode of palette.modes) {
        expect(
          palette.shiki[mode],
          `${palette.id} declares a ${mode} reading with no Shiki id, so code fences there silently take the fallback paper`,
        ).toBeTruthy();
      }
    }
    expect(shikiThemesToLoad()).toContain(SHIKI_FALLBACK_THEME);
    const loaded = [
      ...(await loadedShikiThemes()),
      ...(await loadedCodemodeShikiThemes()),
    ];
    expect(
      loaded.filter((id) => id === SHIKI_FALLBACK_THEME).length,
      `both highlighter singletons must have loaded the fallback "${SHIKI_FALLBACK_THEME}"`,
    ).toBe(2);
  });

  it("is the ONLY place a Palette class may appear: exactly one per state (not per spec)", () => {
    // An INVARIANT over the set of classes, which is why it is not in the per-row
    // loop: a row knows its own block and cannot see the set. `themeClassNames()`
    // is the enumeration, so registering a Palette extends it with no edit here —
    // the property the hardcoded three-name filter this replaced did not have, and
    // the reason two co-applied classes once satisfied `toEqual([expected])`.
    // The full state-space matrix lives in `theme.test.ts`; this is the
    // registry-wide restatement, from the CSS side, that the class LIST here and
    // the class list there are the same derivation.
    expect(themeClassNames().sort()).toEqual(
      PALETTES.flatMap((palette) => palette.modes.map((mode) => paletteClass(palette.id, mode))).sort(),
    );

    // BOTH DIRECTIONS, OVER THE REGISTERED PALETTES ONLY.
    //
    // The property is real and must survive: a class the registry applies with no
    // block behind it is a NO-OP (the palette silently renders `.dark`), and a
    // block whose class nothing applies is CSS NOTHING CAN SELECT (it is invisible
    // to the single-class invariant, so no other gate can see it either). Neither
    // half errors; both are graded here, one direction per assertion.
    //
    // What was wrong is the ENUMERATION. It swept `SPECS` — the spec-data
    // DIRECTORY — and compared it to the registry, which is precisely the (a)/(b)
    // conflation this describe's own header forbids: a row that is not registered
    // yet is the plan's state, not a defect. On the Wave-3 probe it failed with
    // `.theme-probe-dark` as the extra entry, demanding that a Palette be
    // registered before its closeout task is allowed to register it.
    //
    // So the sweep runs over the FILES OF REGISTERED PALETTES — registry-derived
    // names, own-file text. An unregistered row's file is not asked, and a
    // REGISTERED Palette cannot hide a block or mis-name one. The per-Palette
    // properties of an unregistered row (its own file parses, its blocks are named
    // `theme-<id>-<mode>`, its tokens are graded) are asserted by the per-row
    // describe, which reads its own file and needs no `@import`; the fixture at the
    // bottom of this file proves that grading actually RUNS for a row the registry
    // has never heard of.
    const declaredClasses = declaredPaletteClasses(SPECS);
    // Non-vacuity of the sweep itself: it read a real file per registered Palette
    // and found a block in each, so neither direction below can be looping over an
    // empty list.
    expect(declaredClasses.length).toBeGreaterThanOrEqual(themeClassNames().length);
    // THIS GATE IS IMMUNE TO DISCOVERY, asserted here rather than only in the
    // Wave-3 fixture, so a reversion fails with THIS gate's name on it. Handing the
    // sweep an extra unregistered row must change nothing: the row names no class
    // the app can apply, and its file is not shipped CSS. Point the implementation
    // back at the spec directory and this reddens naming `.theme-wave3probe-dark`.
    expect(declaredPaletteClasses([...SPECS, WAVE3_SPEC])).toEqual(declaredClasses);
    // Direction 1: every class the registry can apply has a block, in the file its
    // own row names. A registered Palette whose block is missing fails HERE — that
    // route stays shut.
    expect(
      themeClassNames().map((name) => `.${name}`).filter((name) => !declaredClasses.includes(name)),
      "a registered Palette class with no block is a no-op",
    ).toEqual([]);
    // Direction 2: every block a registered Palette's file declares is named by the
    // registry. A block nothing can apply fails here by name.
    const registryClasses = themeClassNames().map((name) => `.${name}`);
    expect(
      declaredClasses.filter((name) => !registryClasses.includes(name)),
      "a .theme-* block the registry cannot name is CSS nothing can select",
    ).toEqual([]);
    // And the two sets are EQUAL, not merely each a subset of the other — the
    // one-class-per-state claim, restated from the CSS side.
    expect(declaredClasses.sort()).toEqual(registryClasses.sort());
  });
  it("does not demand that an UNREGISTERED spec row be wired (Wave 3's state, not a defect)", () => {
    // The half the old assertion got backwards, asserted positively so it cannot
    // be "fixed" back by re-pointing the gate at the directory. Tasks 3–6 each add
    // `src/styles/<id>.css` + `src/lib/palettes/<id>.ts` and touch NEITHER
    // `src/index.css` NOR `src/lib/palettes.ts`; registration is Task 7. A wiring
    // gate that swept the directory would go red for the plan's own state, and the
    // temptation at that moment is to skip unregistered rows — which is how a gate
    // becomes decorative.
    const registered = new Set(PALETTES.map((palette) => palette.id));
    const unregistered = SPECS.filter((spec) => !registered.has(spec.id));
    // Today that set is empty and this test would be vacuous on its own, so the
    // Wave-3 state is constructed for real in the `Wave 3` describe below — a
    // synthetic row that discovery really does find, graded for real. What this
    // assertion pins is the DEFINITION: discovery finds rows the registry has never
    // heard of, and the wiring gate above enumerates the registry's classes and the
    // CSS files of REGISTERED Palettes, so an extra row changes nothing about it.
    for (const spec of unregistered) {
      expect(
        themeClassNames().some((name) => name === paletteClass(spec.id, "dark") || name === paletteClass(spec.id, "light")),
        `${spec.id} is not registered, so no class of its may be in the registry's list`,
      ).toBe(false);
      // And its file is not among the ones the wiring gate sweeps — which is how
      // "unregistered" stops being a question that gate is allowed to ask.
      expect(
        PALETTES.map((palette) => specFor(palette.id).cssFile),
        `${spec.id} is not registered, so its CSS file must not be swept for classes`,
      ).not.toContain(spec.cssFile);
    }
    expect(Array.isArray(unregistered)).toBe(true);
  });

  it("keeps every block AFTER @theme and after .dark (layer order over EVERY block)", () => {
    // THE gate the fixed five-name list could not be. It compared the offsets of
    // five literals, so a sixth block was simply not in the comparison and could
    // sit before `@theme` — out-specified by both base layers, silently — with the
    // gate green. The predicate is the kit's `layerOrderFailures`, over the heads
    // the stylesheet actually declares, with `themeClassNames()` as the list that
    // MUST be present so a missing block cannot shrink the comparison.
    expect(layerOrderFailures(css, ["@theme", ".dark", ...themeClassNames().map((name) => `.${name}`)]))
      .toEqual([]);
    // Non-vacuity: the sweep really did see every layer, and more than the two
    // base rules it would degrade to if the class derivation were empty.
    const { heads } = blockHeads(css, []);
    expect(heads.filter((name) => name.startsWith(".theme-")).length).toBe(
      themeClassNames().length,
    );
    expect(heads.length).toBeGreaterThan(2);
  });
});

/**
 * The layers whose `--color-context-track` is REQUIRED to be the alias.
 *
 * The subject of the rule is the BASE LAYERS and THE DEFAULT PALETTE — the
 * readings that existed before the role split and must not have moved. It is a
 * function over NOTHING (no parameters) because the subject cannot grow: the rule
 * exists to say "the Dracula split did not move Default", and nothing a later
 * Palette does can add a layer to that claim.
 *
 * THE BUG THIS SHAPE KILLS. The gate used to read
 * `ALL_LAYERS.filter(name !== dracula)` — "every block in the repo that is not
 * Dracula's" — and asserted the alias on all of them. That generalises a decision
 * nobody made: a new Palette may legitimately, and usually must, state its OWN
 * `--color-context-track`, because the track has to separate from that Palette's
 * own surfaces (the band-separation gate below grades exactly that choice, per
 * Palette). It fired on the Wave-3 probe — `expected '#343746' to be
 * 'var(--color-foreground-subtlest)'` — for a Palette that had broken nothing.
 */
const trackAliasLayers = (): string[] => [
  ...BASE_LAYERS.map((layer) => layer.name),
  ...(["light", "dark"] as const)
    .filter((mode) => DEFAULT_SPEC.modes[mode] !== undefined)
    .map((mode) => `.${paletteClass(DEFAULT_SPEC.id, mode)}`),
];

/** The OLD shape of the track gate, kept as a function so the Wave-3 fixture can
 *  run it over an AUGMENTED row list and show it widening. A regression test that
 *  only asserts the new shape is green is weaker than one that shows the old shape
 *  catching the state — this is the derivation that produced failure 2 of 3. */
const trackAliasLayersAsSweptFrom = (
  layers: readonly { name: string }[],
): string[] =>
  layers.filter((layer) => layer.name !== `.${paletteClass(DRACULA_SPEC.id, "dark")}`).map((l) => l.name);

/**
 * Every `.theme-*` class the SHIPPED CSS can apply, swept from the text of the
 * files the REGISTRY's rows name.
 *
 * `_rows` IS NOT READ, and that is the assertion. The signature carries the spec
 * rows so the Wave-3 fixture can pass an EXTRA, unregistered one and require the
 * answer not to move — the only way to prove the enumeration is the registry rather
 * than the directory. Revert the body to `declaredPaletteClassesSweptFrom(_rows)`
 * and that fixture test goes red, naming `.theme-wave3probe-dark`. A kind (b) gate
 * must be immune to discovery; here the immunity is executed, not commented.
 *
 * Sweeps the TEXT rather than deriving from `themeClassNames()`, because a list
 * built from the registry cannot see a name the registry does not contain — which is
 * precisely what direction 2 of the class gate must catch (a stray `.theme-foo-dark`
 * parked in `dracula.css`, or a block misnamed `.theme-dracula-lightside`).
 */
const declaredPaletteClasses = (_rows: readonly PaletteSpec[]): string[] => {
  const files = [...new Set(PALETTES.map((palette) => specFor(palette.id).cssFile))];
  return files.flatMap((cssFile) =>
    [...readerFor(cssFile).code.matchAll(/^(\.theme-[a-z0-9-]+)\s*\{/gm)].map((m) => m[1]!),
  );
};

/** The OLD shape of the class gate: sweep the DIRECTORY and compare it to the
 *  registry. Kept as a function so the Wave-3 fixture can hand it the augmented
 *  row list and watch it produce the extra entry that made failure 3 of 3. */
const declaredPaletteClassesSweptFrom = (rows: readonly PaletteSpec[]): string[] =>
  rows.flatMap((spec) =>
    [...readerFor(spec.cssFile).code.matchAll(/^(\.theme-[a-z0-9-]+)\s*\{/gm)].map(
      (match) => match[1]!,
    ),
  );

/**
 * ══ WAVE 3: AN UNREGISTERED, UN-IMPORTED SPEC ROW IS GRADED, NOT SKIPPED ══
 *
 * THE STATE. Tasks 3–6 of `docs/roadmap/more-palettes.md` each add
 * `src/styles/<id>.css` + `src/lib/palettes/<id>.ts` and touch NEITHER
 * `src/index.css` NOR `src/lib/palettes.ts`; registration is Task 7. Mid-plan, a
 * spec row exists, its CSS file exists, and neither the registry entry nor the
 * `@import` exists. NOTHING in this suite asserted that state, so three gates here
 * were free to conflate the two kinds Task 2 separated:
 *
 *   (a) PER-Palette grading — reads that Palette's OWN CSS file, enumerates the
 *       SPEC DIRECTORY (a row is what says "grade me");
 *   (b) CROSS-Palette wiring — enumerates the REGISTRY, because only a registered
 *       class can be applied and only a registered Palette is `@import`ed.
 *
 * THE THREE FAILURES, reproduced by a throwaway `probe` row + `probe.css`:
 *
 *   1. `keeps the five layers as siblings…` — `Error: no /^\.theme-probe-dark
 *      \s*\{/m block in the stylesheet`. Names from the directory, offsets from the
 *      comment-stripped RESOLVED sheet.
 *   2. `leaves EVERY other palette's context-bar track byte-identical` — expected
 *      `#343746` to be `var(--color-foreground-subtlest)`. The rule's subject is
 *      Default; it asserted "every block that is not Dracula aliases", a rule about
 *      future Palettes that was never decided.
 *   3. `is the ONLY place a Palette class may appear` — `.theme-probe-dark` as the
 *      extra entry. `declaredClasses` swept the DIRECTORY and was compared to the
 *      REGISTRY.
 *
 * WHY A FIXTURE AND NOT A MANUAL STEP. The probe was a hand-built throwaway, and
 * "I ran it once and it was green then" is not a regression net. `WAVE3_SPEC` is a
 * row discovery CANNOT see (it lives outside `src/lib/palettes/`, the swept
 * directory) and its CSS is a real file on disk, so the kit's `gradePalette` grades
 * it for real while the registry-shaped gates never hear of it. That is the
 * (a)/(b) split expressed as data.
 *
 * WHY THE IMPORTANT HALF IS THE MUTATION. Green is not the goal; GRADED is the
 * goal. The plan names the failure mode outright: "the gate must skip unimported
 * specs, which makes the checks vacuous for exactly the Palettes they exist to
 * grade." A row that is silently skipped and a row that grades clean look
 * identical in a green list — so every "it passes" here is paired with "and
 * breaking its CSS makes it fail, by name."
 */
describe("Wave 3: an unregistered spec row is graded from its own file, not skipped", () => {
  /** The fixture's own reader — the file, not the resolved sheet. */
  const probeReader = readerFor(WAVE3_SPEC.cssFile);

  it("is the state the plan says it is: not registered, not imported, not swept", () => {
    // If this drifts, everything below stops describing Wave 3. A fixture that
    // gets wired becomes a shipped Palette and the gates it exists to test stop
    // being tested.
    expect(
      PALETTES.map((palette) => palette.id),
      "the fixture must never be registered — registration is Task 7's, and a wired fixture grades nothing",
    ).not.toContain(WAVE3_PROBE_ID);
    expect(
      readCssFile("src/index.css"),
      `${WAVE3_PROBE_CSS_FILE} must never be @imported — it is a test fixture, not shipped CSS`,
    ).not.toContain(WAVE3_PROBE_CSS_FILE);
    // Discovery cannot see it, which is what keeps the rest of the suite from
    // having to tolerate a fake Palette while still letting THIS file grade one.
    expect(
      SPECS.map((spec) => spec.id),
      "the fixture must stay OUT of src/lib/palettes/, the directory discovery sweeps",
    ).not.toContain(WAVE3_PROBE_ID);
    // And it really is a row the per-row describe would grade if it were in the
    // swept directory: same type, same shape, one dark reading.
    expect(Object.keys(WAVE3_SPEC.modes).sort()).toEqual(["dark", "light"]);
    expect(WAVE3_SPEC.modes.light).toBeUndefined();
  });

  it("grades clean from its OWN file, with no @import and no registry entry", () => {
    // The kind (a) claim, and the one that used to THROW. `gradePalette` opens
    // `WAVE3_SPEC.cssFile` directly, so the missing `@import` is simply not its
    // business — which is the property that lets four Palettes be authored in
    // parallel and graded the day their file lands.
    expect(readCssFile(WAVE3_SPEC.cssFile)).toMatch(/^\.theme-wave3probe-dark\s*\{/m);
    expect(gradePalette(WAVE3_SPEC)).toEqual([]);
    // Non-vacuity: `gradePalette` ran a real predicate over a real block rather
    // than returning `[]` because it found nothing to look at. Default's dark
    // reading is the completeness reference and this block matches it, so the
    // declaration count is the same 168 — and the row's own floors and ladder
    // groups are populated, not empty.
    expect(probeReader.declared(probeReader.block(/^\.theme-wave3probe-dark\s*\{/m)).size).toBe(
      WAVE3_SPEC.modes.dark!.declaredCount,
    );
    expect(WAVE3_SPEC.modes.dark!.ladderGroups.length).toBeGreaterThan(1);
    const surfaces = WAVE3_SPEC.modes.dark!.textSurfaces;
    expect(
      surfaces.resting.length + surfaces.raised.length + surfaces.selected.length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("THE MUTATION: breaking the fixture's own CSS fails ITS grading, by name", () => {
    // THE TEST THAT MATTERS. Everything above could be satisfied by a gate that
    // skipped this row; this one cannot. The same two helpers the shipped-Palette
    // mutation sweep uses are pointed at the fixture's OWN CSS, and each must come
    // back naming the token it broke. If the row were skipped, every `failures`
    // below would be empty and this reddens — so "graded" is PROVEN, not assumed.
    const probeCss = readCssFile(WAVE3_SPEC.cssFile);
    const probeSelector = `.theme-${WAVE3_PROBE_ID}-dark`;

    // (1) An off-spec hex → the published-hex gate convicts it by name.
    const offSpec = mutateValue(probeCss, probeSelector, "color-chat", "#123456");
    expect(offSpec).not.toBe(stripComments(probeCss));
    const offSpecFailures = gradePalette(WAVE3_SPEC, { css: offSpec });
    expect(offSpecFailures.join("\n")).toMatch(/declares hexes the source does not publish/);
    expect(offSpecFailures.join("\n")).toContain("color-chat: #123456");

    // (2) A deleted declaration → the completeness predicate calls it a forgotten
    //     token, which is the hazard the layering creates and the reason this file
    //     exists.
    const deleted = deleteDeclaration(probeCss, probeSelector, "color-chat");
    expect(deleted).not.toBe(stripComments(probeCss));
    const deleteFailures = gradePalette(WAVE3_SPEC, { css: deleted });
    expect(deleteFailures.join("\n")).toMatch(
      /Unexpectedly inherited \(a token this Palette forgot\): \["color-chat"\]/,
    );

    // (3) An INVERTED ladder rung → the ladder predicate fires, so the grading is
    //     not merely a hex census over the block.
    const inverted = mutateValue(probeCss, probeSelector, "color-chat", "#000000");
    const ladderFailures = gradePalette(WAVE3_SPEC, { css: inverted });
    expect(ladderFailures.join("\n")).toMatch(/ladder step/);

    // (4) A block whose NAME the class scheme cannot produce → the naming rule
    //     fires, which is the per-Palette half of what the registry gate does for
    //     registered Palettes.
    const renamed = stripComments(probeCss).replace(
      /^\.theme-wave3probe-dark\s*\{/m,
      ".theme-wave3probe-lightside {",
    );
    expect(renamed).not.toBe(stripComments(probeCss));
    expect(gradePalette(WAVE3_SPEC, { css: renamed }).join("\n")).toMatch(
      /is not theme-wave3probe-<mode>/,
    );

    // (5) The block MISSING entirely → graded as an omission, not as nothing to do.
    //     This is the case a "skip unimported specs" gate would silently swallow.
    const emptied = stripComments(probeCss).replace(
      /^\.theme-wave3probe-dark\s*\{[\s\S]*?\n\}/m,
      "",
    );
    expect(emptied).not.toBe(stripComments(probeCss));
    expect(gradePalette(WAVE3_SPEC, { css: emptied }).join("\n")).toMatch(
      /declares no \.theme-wave3probe-dark block/,
    );

    // And the unmutated fixture is clean, so none of the five above is firing on a
    // row that was already broken — each mutation is the ONLY difference.
    expect(gradePalette(WAVE3_SPEC)).toEqual([]);
  });

  it("joins the per-Palette layer enumeration without disturbing the nesting gate", () => {
    // GATE 1'S REGRESSION. This is the exact call that threw `no /^\.theme-probe-dark
    // \s*\{/m block in the stylesheet`: the layer list gains the row's readings, and
    // each one is then measured in the file that declares it. With the old shape the
    // offset lookup went to the RESOLVED sheet, which has no such block, and threw.
    const augmented = gradeLayersFor([...SPECS, WAVE3_SPEC]);
    expect(augmented.map((layer) => layer.name)).toContain(
      `.${paletteClass(WAVE3_PROBE_ID, "dark")}`,
    );
    // More layers than the shipped set — the row joined, it was not filtered out.
    // RELATIONAL, not `augmented.length === ALL_LAYERS.length + 1`: both sides of
    // that are directory-derived so it survives a surplus row, but it still states
    // the count rather than the property. What is claimed is that the augmented
    // list is the shipped list PLUS exactly the fixture's own readings.
    const shippedLayerNames = ALL_LAYERS.map((layer) => layer.name);
    const augmentedNames = augmented.map((layer) => layer.name);
    expect(
      shippedLayerNames.filter((name) => !augmentedNames.includes(name)),
      "the augmented layer list lost a shipped layer — the comparison below would be vacuous",
    ).toEqual([]);
    expect(
      augmentedNames.filter((name) => !shippedLayerNames.includes(name)).sort(),
    ).toEqual([`.${paletteClass(WAVE3_PROBE_ID, "dark")}`]);
    expect(augmentedNames.length).toBeGreaterThan(shippedLayerNames.length);
    expect(nestingFailures(augmented)).toEqual([]);
    // And the shipped set on its own is clean, so the assertion above is not
    // passing because the predicate is blind.
    expect(nestingFailures(ALL_LAYERS)).toEqual([]);
    expect(
      nestingFailures([
        {
          name: ".theme-catppuccin-dark",
          reader: cssReader(
            [
              ".theme-catppuccin-dark {",
              "  --color-background: #1e1e2e;",
              "  .theme-default-dark { --color-background: #161616; }",
              "}",
            ].join("\n"),
          ),
          selector: /^\.theme-catppuccin-dark\s*\{/m,
        },
        {
          name: ".theme-default-dark",
          reader: cssReader(
            [
              ".theme-catppuccin-dark {",
              "  --color-background: #1e1e2e;",
              "  .theme-default-dark { --color-background: #161616; }",
              "}",
            ].join("\n"),
          ),
          selector: /^\.theme-default-dark\s*\{/m,
        },
      ]),
      "the nesting predicate cannot see a block inside another's body"
    ).toEqual([".theme-default-dark is nested inside .theme-catppuccin-dark"]);
  });

  it("leaves every registry-shaped gate UNMOVED (kind (b) does not see it)", () => {
    // GATES 2 AND 3'S REGRESSION, asserted BOTH WAYS: the shipped derivations do
    // not move, and the OLD derivations demonstrably DO. The second half is what
    // makes this a regression test rather than a restatement of the fix — without
    // it, a reader cannot tell "the gate is registry-derived" from "the gate happens
    // to be green today".
    const augmentedLayers = gradeLayersFor([...SPECS, WAVE3_SPEC]);

    // ── Gate 2, the context-bar track. ────────────────────────────────────────
    // The shipped subject: base layers + Default's readings. Unmoved.
    expect(trackAliasLayers()).toEqual(["@theme", ".dark", ".theme-default-light", ".theme-default-dark"]);
    // The OLD subject — every layer that is not Dracula's — widens the moment a
    // third row exists, and that widening is failure 2 of 3. Asserted
    // RELATIONALLY, and that is load-bearing: this read
    // `expect(oldSubject.length).toBe(trackAliasLayers().length + 1)`, which is
    // arithmetic on ABSOLUTE lengths and therefore true only while the spec
    // directory holds EXACTLY the registered Palettes — the same (a)/(b)
    // assumption the gate it audits was fixed for, one level down. It failed the
    // real Wave-3 state as `expected 6 to be 5`, because a hand-built `probe` row
    // had already widened BOTH sides. What is actually claimed is containment plus
    // one extra: the old subject sees the row the new one does not.
    const oldSubject = trackAliasLayersAsSweptFrom(augmentedLayers);
    const shippedSubject = trackAliasLayers();
    expect(oldSubject).toContain(`.${paletteClass(WAVE3_PROBE_ID, "dark")}`);
    expect(shippedSubject).not.toContain(`.${paletteClass(WAVE3_PROBE_ID, "dark")}`);
    // A strict superset: every layer the shipped subject names is in the old one,
    // and the old one names at least one the shipped one does not.
    expect(
      shippedSubject.filter((name) => !oldSubject.includes(name)),
      "the old (directory-swept) subject lost a layer the shipped subject names — it is not a superset, so the comparison below says nothing",
    ).toEqual([]);
    expect(
      oldSubject.filter((name) => !shippedSubject.includes(name)),
      "the old subject does not widen when a row joins — the bug this gate audits would be invisible",
    ).not.toEqual([]);
    // And the fixture's block carries the ALIAS (it is Default's block), while
    // Dracula's carries its own hex — so under the old subject the assertion is
    // satisfiable, meaning the old gate would have gone red on a Palette whose
    // track is a real, per-Palette choice. Asserting the alias on a future Palette
    // would be that bug under a new name.
    expect(
      probeReader.values(probeReader.block(/^\.theme-wave3probe-dark\s*\{/m))[
        "color-context-track"
      ],
    ).toBe("var(--color-foreground-subtlest)");
    expect(
      appLayerValues(`.${paletteClass(DRACULA_SPEC.id, "dark")}`)["color-context-track"],
    ).toBe("#343746");

    // ── Gate 3, the class list. ───────────────────────────────────────────────
    // Shipped: the registry's files. Unmoved, and equal to the registry's classes.
    expect(declaredPaletteClasses([...SPECS, WAVE3_SPEC])).not.toContain(
      `.${paletteClass(WAVE3_PROBE_ID, "dark")}`,
    );
    expect([...declaredPaletteClasses([...SPECS, WAVE3_SPEC])].sort()).toEqual(
      themeClassNames().map((name) => `.${name}`).sort(),
    );
    // The OLD sweep — the spec DIRECTORY — acquires the fixture's class and stops
    // matching the registry. That difference IS failure 3 of 3.
    const oldSweep = declaredPaletteClassesSweptFrom([...SPECS, WAVE3_SPEC]);
    expect(oldSweep).toContain(`.${paletteClass(WAVE3_PROBE_ID, "dark")}`);
    expect([...oldSweep].sort()).not.toEqual(
      themeClassNames().map((name) => `.${name}`).sort(),
    );

    // ── The layer-order gate, which legitimately reads the RESOLVED sheet. ────
    // It enumerates the registry's classes, so the fixture's block — absent from
    // the sheet, because nothing imports it — is not demanded there.
    expect(
      layerOrderFailures(css, [
        "@theme",
        ".dark",
        ...themeClassNames().map((name) => `.${name}`),
      ]),
    ).toEqual([]);
    // And asking it about the fixture's class is exactly the wrong question: the
    // answer is a failure, which is why the wiring gate must never derive its
    // expected list from the spec directory.
    expect(
      layerOrderFailures(css, [
        "@theme",
        ".dark",
        `.${paletteClass(WAVE3_PROBE_ID, "dark")}`,
      ]).join("\n"),
    ).toMatch(/declares no block in the stylesheet/);
  });

  it("cannot drift silently: its block still equals .theme-default-dark modulo the name", () => {
    // The fixture's grading is only meaningful while its block is a real Palette
    // reading. If `.theme-default-dark` gains a token and this file does not, the
    // row's pinned `declaredCount` catches it inside `gradePalette` — but that
    // failure reads as "this Palette forgot a token", which sends a reader to the
    // wrong file. This names the actual cause.
    const fixtureBody = stripComments(readCssFile(WAVE3_SPEC.cssFile))
      .replace(/^\.theme-wave3probe-dark\s*\{/m, ".theme-default-dark {")
      .replace(/\s+/g, " ")
      .trim();
    const referenceBody = stripComments(readCssFile(DEFAULT_SPEC.cssFile))
      .match(/^\.theme-default-dark\s*\{[\s\S]*?\n\}/m)![0]!.replace(/\s+/g, " ")
      .trim();
    expect(fixtureBody).toBe(referenceBody);
  });
});

/**
 * ══ THE LIVE GUARD: a row materialised INTO `src/lib/palettes/`, for real ══
 *
 * WHY THIS EXISTS WHEN THE FIXTURE ABOVE EXISTS. `WAVE3_SPEC` is deliberately
 * placed OUTSIDE `src/lib/palettes/`, so `listPaletteSpecs()` cannot see it and
 * the fixture is handed to this file's OWN derivations by hand. That proves the
 * derivations are registry-shaped, but it leaves the thing that actually broke
 * untested: **discovery itself**. All three failures the orchestrator measured
 * came from a row the DIRECTORY returned, and a fixture discovery never returns
 * cannot reproduce that — which is exactly why the hand-built `probe` row was
 * needed, and why "I ran it once and it was green then" was the state of the
 * suite after the previous fix.
 *
 * So this describe builds the real state automatically: it WRITES
 * `src/lib/palettes/guardprobe.ts` + `src/styles/guardprobe.css`, re-runs
 * `listPaletteSpecs()` and sees the row come back, asserts the registry-shaped
 * gates did not move, asserts the new row is GRADED (its own file, its own
 * failures, by name), and deletes both files in a `finally` that runs on failure
 * too.
 *
 * WRITING INTO `src/` IS THE PART THAT DESERVES THE SUSPICION, and the answer is
 * the window, not the location. A stray fake Palette would be discovered by every
 * gate in the suite, so the exposure is minimised rather than merely cleaned up:
 * write → discover → assert → delete happens INSIDE ONE test with a `finally`, so
 * the row exists for milliseconds instead of for the length of a `describe`; the
 * on-disk copy is never MUTATED during that window (the mutations below are
 * in-memory), so a test file that imports concurrently grades a HEALTHY row; the
 * id is `guardprobe`, which is not a real Palette's name and greps to this file
 * and nothing else; the module-scope sweep at the top of this file removes a
 * leftover from a run that was KILLED mid-window before anything reads the
 * directory; and the last test below asserts the tree is clean, which is the
 * alarm that says the cleanup stopped working (verified: suppressing the cleanup
 * makes it fail, naming both paths). A crash between write and delete leaves two
 * UNTRACKED files, and measured honestly, NOTHING else catches them: `tsc` passes
 * (a valid `PaletteSpec` is valid), and the sibling gates pass too — which is the
 * FIX working, since an unregistered row that grades clean is exactly the state
 * they now permit. So the recovery is the sweep at the top of this file, not an
 * alarm elsewhere, and the alarm here is the only one that exists.
 *
 * WHY A QUERY-BUSTED KIT IMPORT. Vite resolves the kit's
 * `new URL(\`./palettes/${name}\`, import.meta.url)` when it TRANSFORMS the kit,
 * so the copy this file imported at module scope keeps the directory as it was
 * when the run started and reports `…/src/lib/undefined` for a row written
 * mid-run. Importing `./paletteTestKit.ts?liveGuard=1` is a NEW module to Vite —
 * re-transformed, glob re-evaluated — so discovery is asked the question with a
 * fresh view. This is not a seam standing in for the real thing: `listPaletteSpecs`
 * still `readdirSync`s the real directory and still imports the real file, which
 * is exactly the property under test. (`vi.resetModules()` was tried first and
 * does NOT work when the kit was already loaded in the same file — measured, and
 * recorded here so nobody re-tries it.)
 *
 * WHY THE WINDOW IS NOT NARROWED FURTHER, and why the sweeps are the thing that
 * changed. The tempting second fix is to make the guard hold the tree steady — a
 * lock file the sibling scanners poll, or running this file with file parallelism
 * off. Both were considered and neither buys anything:
 *
 *  - A lock only works if EVERY reader takes it. That couples seven source
 *    scanners to a protocol this one test owns, to defend a window of
 *    milliseconds, and it still leaves the window open for any reader that
 *    forgets. Coupling seven guards to one test's cleanup is a worse dependency
 *    than the one it removes.
 *  - Serialising the suite slows every commit to protect one describe block, and
 *    it does not even close the hole: a scanner's listing is taken at MODULE
 *    scope, at import time, so ordering test FILES cannot make a listing and a
 *    read from two different files agree on a tree.
 *  - Moving the artifact out of `src/lib/palettes/` is not available. Discovery
 *    IS a sweep of that directory; a row anywhere else is the `WAVE3_PROBE`
 *    fixture, which is exactly what this guard was written because it cannot
 *    express.
 *
 * The deeper reason the primary fix is the right one: the race is not the guard's.
 * Vitest runs test files concurrently, and this repo's scanners walk a tree that
 * parallel worktrees, editor swap files and build churn also move. A sweep that
 * assumes its listing is stable is wrong for ALL of those, and the guard is only
 * the first thing fast enough to make it show. So the sweeps were made tolerant
 * (`sourceSweep.ts`) and the guard is UNCHANGED: its window, its `finally`, its
 * module-scope leftover sweep and its "the tree is clean" alarm all stand.
 */
describe("the live guard: discovery really does see a row dropped into src/lib/palettes/", () => {
  const GUARD_ID = "guardprobe";
  const GUARD_TS = `src/lib/palettes/${GUARD_ID}.ts`;
  const GUARD_CSS = `src/styles/${GUARD_ID}.css`;
  const GUARD_CLASS = paletteClass(GUARD_ID, "dark");

  /** The kit, TRANSFORMED AGAIN, so its view of `src/lib/palettes/` is fresh.
   *
   *  Vite resolves the kit's `new URL(\`./palettes/${name}\`, import.meta.url)` at
   *  TRANSFORM time, so the copy this file imported at module scope holds the
   *  directory as it was when the run started, and asking it to load a row written
   *  mid-run yields `…/src/lib/undefined`. A query-busting specifier is a NEW
   *  module to Vite — re-transformed, glob re-evaluated — while `listPaletteSpecs`
   *  itself is untouched: it still `readdirSync`s the real directory and still
   *  imports the real file. `vi.resetModules()` does NOT do this (measured: the
   *  re-imported kit returns the stale glob when the module was loaded earlier in
   *  the same file), and the specifier must be a LITERAL — a computed one is a
   *  `Unknown variable dynamic import`. */
  const freshKit = async (): Promise<typeof import("./paletteTestKit")> => {
    // @ts-expect-error TS2307: the `?liveGuard=1` query is a Vite concept, so `tsc`
    // has no resolver that knows about it — exactly as it has none for `node:fs`,
    // which this file already reaches the same way. The directive covers the import
    // line ALONE, whose only possible error is that unresolved query, and the
    // specifier must stay a LITERAL (Vite refuses a computed one). `tsc` cannot
    // check a module it cannot resolve, so the kit's SHAPE is checked where it can
    // be: the return type below is the real module's, so every member this guard
    // calls on it is typed against `paletteTestKit.ts`, and `listPaletteSpecs`
    // returning the shipped ids is asserted at runtime two lines down.
    const kit = await import("./paletteTestKit.ts?liveGuard=1");
    return kit as typeof import("./paletteTestKit");
  };

  /** Delete both files. Idempotent, so it is safe to call before anything was
   *  written and safe to call twice. */
  const removeGuardFiles = (): void => {
    const fs = NODE_FS_MODULE as { rmSync: (path: string, options?: { force?: boolean }) => void };
    fs.rmSync(GUARD_TS, { force: true });
    fs.rmSync(GUARD_CSS, { force: true });
  };

  /** Write the row and its CSS: `.theme-default-dark` renamed, so every predicate
   *  the kit applies has a real reading to chew on and the row grades CLEAN —
   *  a fixture that already fails cannot tell "graded" from "skipped". */
  const writeGuardFiles = (): void => {
    const fs = NODE_FS_MODULE as {
      writeFileSync: (path: string, data: string) => void;
    };
    const defaultCss = stripComments(readCssFile(DEFAULT_SPEC.cssFile));
    const body = defaultCss.match(/^\.theme-default-dark\s*\{[\s\S]*?\n\}/m);
    if (!body) throw new Error("no .theme-default-dark block to copy — the guard has nothing to build from");
    // The comment is NOT decoration: `fileIconContrast.test.ts` and
    // `themeTokens.test.ts` both THROW if a file the sweep grades carries no
    // comment, because their comment-strip guard would otherwise be vacuous. A
    // generated file that trips that throw would look like an unrelated failure in
    // another file, so the generated CSS keeps one.
    fs.writeFileSync(
      GUARD_CSS,
      [
        `/* TEST ARTIFACT — id "${GUARD_ID}". Written by the live guard in`,
        " * `paletteCompleteness.test.ts` and deleted in the same test's finally block.",
        " * Nothing may @import this file; it is not a Palette. Its block is",
        " * `.theme-default-dark` renamed, so the row grades clean by construction. */",
        body[0].replace(/^\.theme-default-dark\s*\{/m, `.theme-${GUARD_ID}-dark {`),
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      GUARD_TS,
      [
        "// TEST ARTIFACT — id \"guardprobe\". Written and deleted by the live guard in",
        "// `paletteCompleteness.test.ts`. It is NOT a Palette: no registry entry, no",
        "// @import. The row is Default's dark reading, spread rather than re-typed, so",
        "// it cannot drift from the block its CSS copies.",
        'import { spec as DEFAULT_SPEC } from "./default";',
        'import type { PaletteSpec } from "../paletteSpec";',
        "",
        "export const spec: PaletteSpec = {",
        `  id: "${GUARD_ID}",`,
        `  cssFile: "${GUARD_CSS}",`,
        "  baseCssFile: DEFAULT_SPEC.baseCssFile,",
        '  specSourceUrl:',
        '    "TEST ARTIFACT — no source. `.theme-guardprobe-dark` is a rename of `.theme-default-dark`",',
        "  publishedHexes: DEFAULT_SPEC.publishedHexes,",
        "  offSpecAllowList: {},",
        "  modes: { light: undefined, dark: DEFAULT_SPEC.modes.dark! },",
        "};",
        "",
      ].join("\n"),
    );
  };

  // Belt to the module-scope sweep's braces: the sweep ahead of `SPECS` handles a
  // leftover from a killed run, this handles anything left between tests here.
  beforeEach(removeGuardFiles);
  afterAll(removeGuardFiles);

  it("materialises a third row into the swept directory, grades it, and leaves the tree clean", async () => {
    // ── 0. The state BEFORE, captured so "unmoved" is a comparison and not a
    // description of a tree that never changed. ────────────────────────────────
    const before = {
      ids: SPECS.map((spec) => spec.id).sort(),
      classes: themeClassNames().sort(),
      declared: declaredPaletteClasses(SPECS).sort(),
      trackSubject: trackAliasLayers().slice(),
      registry: PALETTES.map((palette) => palette.id).sort(),
    };
    expect(before.ids).not.toContain(GUARD_ID);

    writeGuardFiles();
    try {
      // ── 1. DISCOVERY sees it. This is the half the outside-the-directory
      //      fixture could never reach, and the half every one of the three
      //      failures came from. ───────────────────────────────────────────────
      const kit = await freshKit();
      const discovered = await kit.listPaletteSpecs();
      const ids = discovered.map((spec) => spec.id).sort();
      expect(ids, "discovery did not see the row — the guard is grading nothing").toContain(GUARD_ID);
      expect(ids.length).toBeGreaterThan(before.ids.length);
      const row = discovered.find((spec) => spec.id === GUARD_ID)!;

      // ── 2. It is GRADED, not skipped. Two halves, because each proves a
      //      different thing.
      //
      // (i) FROM DISK: `gradePalette(row)` with NO `css` override opens
      //     `row.cssFile` — the path the DISCOVERED row names — so a non-empty
      //     result could only come from the file on disk. It is asserted clean
      //     first, because a guard whose baseline were non-empty cannot tell
      //     "graded clean" from "graded nothing".
      // (ii) BY NAME: the shipped predicates are then run over that same text with
      //     ONE mutation, and each must come back naming the token it broke AND
      //     `guardprobe` — a string that exists in no other row. If the row were
      //     skipped every list below would be empty and this reddens.
      //
      // WHY THE MUTATION IS IN MEMORY AND NOT WRITTEN TO DISK: the file is inside
      // the swept directory, so a test file that imports DURING this window would
      // discover it and grade it too. Keeping the on-disk copy clean means a
      // concurrent worker sees a healthy row; the mutation never escapes this
      // function. `row.cssFile` is pinned to the guard's own path below, so the
      // text being mutated is demonstrably the file discovery handed us.
      expect(row.cssFile).toBe(GUARD_CSS);
      const guardCss = readCssFile(GUARD_CSS);
      expect(guardCss).toMatch(new RegExp(`^\\.${GUARD_CLASS}\\s*\\{`, "m"));
      expect(gradePalette(row)).toEqual([]);

      const guardSelector = `.theme-${GUARD_ID}-dark`;

      // (a) An off-spec hex → the published-hex gate convicts the token by name.
      const offSpec = mutateValue(guardCss, guardSelector, "color-chat", "#123456");
      expect(offSpec).not.toBe(guardCss);
      const offSpecFailures = gradePalette(row, { css: offSpec });
      expect(offSpecFailures.join("\n")).toMatch(/declares hexes the source does not publish/);
      expect(offSpecFailures.join("\n")).toContain("color-chat: #123456");
      expect(offSpecFailures.join("\n")).toContain(GUARD_ID);

      // (b) A FORGOTTEN token → the completeness predicate names it, which is the
      //     hazard the layering creates and the reason this harness exists.
      const deleted = deleteDeclaration(guardCss, guardSelector, "color-chat");
      const deleteFailures = gradePalette(row, { css: deleted });
      expect(deleteFailures.join("\n")).toMatch(
        /Unexpectedly inherited \(a token this Palette forgot\): \["color-chat"\]/,
      );
      expect(deleteFailures.join("\n")).toContain(GUARD_ID);

      // (c) An INVERTED ladder rung → the ladder predicate fires, so the grading is
      //     not merely a hex census over the block.
      const inverted = mutateValue(guardCss, guardSelector, "color-chat", "#000000");
      expect(gradePalette(row, { css: inverted }).join("\n")).toMatch(/ladder step/);

      // (d) The block GONE → graded as an omission. This is the case a "skip
      //     unimported specs" gate would swallow whole.
      const emptied = stripComments(guardCss).replace(
        new RegExp(`^\\.${GUARD_CLASS}\\s*\\{[\\s\\S]*?\\n\\}`, "m"),
        "",
      );
      expect(emptied).not.toBe(stripComments(guardCss));
      expect(gradePalette(row, { css: emptied }).join("\n")).toMatch(
        new RegExp(`declares no \\.${GUARD_CLASS} block`),
      );

      // ── 3. The per-Palette derivations WIDEN (kind (a) sees it). ────────────
      const augmented = gradeLayersFor(discovered);
      expect(augmented.map((layer) => layer.name)).toContain(`.${GUARD_CLASS}`);
      expect(nestingFailures(augmented)).toEqual([]);
      // …and the OLD derivations demonstrably DO break on it, which is what makes
      // the next block a regression test rather than a restatement of the fix.
      const oldSweep = declaredPaletteClassesSweptFrom(discovered);
      expect(oldSweep).toContain(`.${GUARD_CLASS}`);
      expect([...oldSweep].sort()).not.toEqual(
        themeClassNames().map((name) => `.${name}`).sort(),
      );
      const oldSubject = trackAliasLayersAsSweptFrom(augmented);
      expect(oldSubject).toContain(`.${GUARD_CLASS}`);

      // ── 4. Every REGISTRY-shaped gate is UNMOVED. Each is compared to the value
      //      captured before the row existed, so no absolute count is involved and
      //      the assertion holds with 2 rows or with 6. ─────────────────────────
      expect(themeClassNames().sort(), "the class list moved for an unregistered row").toEqual(
        before.classes,
      );
      expect(PALETTES.map((palette) => palette.id).sort()).toEqual(before.registry);
      expect(declaredPaletteClasses(discovered).sort()).toEqual(before.declared);
      expect(trackAliasLayers()).toEqual(before.trackSubject);
      expect(declaredPaletteClasses(discovered)).not.toContain(`.${GUARD_CLASS}`);
      // The wiring gate's own enumeration: only registered rows are asked for an
      // `@import`, so the guard's file is not among the files it sweeps.
      expect(PALETTES.map((palette) => specFor(palette.id).cssFile)).not.toContain(GUARD_CSS);
      // The layer-order gate reads the RESOLVED sheet, which no `@import` widened.
      expect(
        layerOrderFailures(css, [
          "@theme",
          ".dark",
          ...themeClassNames().map((name) => `.${name}`),
        ]),
      ).toEqual([]);
      // And the kind-(b) gate that would have demanded the row be wired: asking it
      // about the guard's class is the WRONG QUESTION, asserted as such.
      expect(
        layerOrderFailures(css, ["@theme", ".dark", `.${GUARD_CLASS}`]).join("\n"),
      ).toMatch(/declares no block in the stylesheet/);
    } finally {
      removeGuardFiles();
    }
  });

  it("leaves no artifact behind: the swept directory is the shipped one again", () => {
    // The alarm for a cleanup that stopped working. If the `finally` above ever
    // fails to run, this names the file rather than letting a fake Palette ride
    // into every other gate — and into `tsc`, `pnpm build` and `git status`.
    const fs = NODE_FS_MODULE as { existsSync: (path: string) => boolean };
    expect(fs.existsSync(GUARD_TS), `${GUARD_TS} survived the guard — delete it`).toBe(false);
    expect(fs.existsSync(GUARD_CSS), `${GUARD_CSS} survived the guard — delete it`).toBe(false);
    expect(SPECS.map((spec) => spec.id).sort()).not.toContain(GUARD_ID);
  });
});

/**
 * ══ THE PROOF THAT THE GATES BITE ══
 *
 * Every gate above has now been OBSERVED FAILING on a deliberately broken fixture
 * — which is the discipline `docs/features/palettes.md` and ADR 0027 both
 * record ("a pin that passes on the broken thing is worse than no pin"), and the
 * reason four of these gates were green while a Palette rendered the wrong colours.
 *
 * The fixtures are MUTATIONS OF A COPY: the kit's `gradePalette` and
 * `layerOrderFailures` both take text, so a gate is broken without editing a
 * shipped CSS file, and the mutation changes what a function RETURNS rather than
 * deleting a helper (which proves only that the helper is instantiated). The
 * messages this task observed are recorded in each test's comment, and the tests
 * re-run the same mutations on every commit — a gate that stops biting is a
 * failing test, not a stale claim.
 */
describe("the harness bites (mutations on synthetic copies)", () => {
  const draculaCss = readCssFile(DRACULA_SPEC.cssFile);

  /** The Shiki subset relation the wiring gate applies, as a function so a
   *  mutation can hand it a loaded list that omits one id. Returns the ids the
   *  registry needs and the singleton does not have. */
  const unloadedShikiIds = (loaded: readonly string[]): string[] =>
    shikiThemeIds().filter((id) => !loaded.includes(id));

  it("names the token a Palette FORGOT, and the Palette that forgot it", () => {
    // Observed failing (before the row was made to match) as:
    //   default dark: inherits 1 token(s) that the Default dark block declares,
    //   but the spec row names 0. Unexpectedly inherited (a token this Palette
    //   forgot): ["color-chat"]. …
    const failures = gradePalette(DEFAULT_SPEC, {
      css: deleteDeclaration(readCssFile(DEFAULT_SPEC.cssFile), ".theme-default-dark", "color-chat"),
    });
    expect(failures.join("\n")).toMatch(
      /Unexpectedly inherited \(a token this Palette forgot\): \["color-chat"\]/,
    );
    expect(failures.join("\n")).toContain("color-chat");
  });

  it("names a hex the source does not publish (the gate that would have caught pi-dracula)", () => {
    // Observed failing as:
    //   dracula .theme-dracula-dark: declares hexes the source does not publish —
    //   color-chat: #123456
    const failures = gradePalette(DRACULA_SPEC, {
      css: mutateValue(draculaCss, ".theme-dracula-dark", "color-chat", "#123456"),
    });
    expect(failures.join("\n")).toMatch(/declares hexes the source does not publish/);
    expect(failures.join("\n")).toContain("color-chat: #123456");
  });

  it("fails an INVERTED ladder, naming both rungs and which way it went", () => {
    // Observed failing as:
    //   dracula .theme-dracula-dark: ladder step 3 (raised (cards, badges, …)) is
    //   DARKER than the chat column, the inspector AND every float (…) — #282a36
    //   then #191a21 (a dark reading must strictly ascend)
    const inverted = mutateValue(draculaCss, ".theme-dracula-dark", "color-card", "#191a21");
    const failures = gradePalette(DRACULA_SPEC, { css: inverted });
    expect(failures.join("\n")).toMatch(/ladder step 3 .* is DARKER than/);
    expect(failures.join("\n")).toMatch(/a dark reading must strictly ascend/);
  });

  it("fails a Palette whose Shiki id is not loaded, and passes when it is", async () => {
    // Observed failing as:
    //   dracula: Shiki theme "dracula" is not loaded
    // The fixture is the loaded list with `dracula` deleted — the shape the shipped
    // gate evaluates when a singleton's `themes:` list is a stale literal. Same
    // subset relation, same message, no shipped component mutated.
    const registryIds = shikiThemeIds();
    const loadedButMissingOne = registryIds.filter((id) => id !== "dracula");
    expect(
      unloadedShikiIds(loadedButMissingOne),
      "the gate must name the theme the loaded list omits",
    ).toEqual(["dracula"]);
    // And the complete list is clean, so the gate detects the OMISSION and not the
    // existence of a registry.
    expect(unloadedShikiIds(registryIds)).toEqual([]);
    // The shipped relation, on the real singletons — so the helper above cannot
    // drift from what the wiring gate actually asserts.
    const actuallyLoaded = [
      ...(await loadedShikiThemes()),
      ...(await loadedCodemodeShikiThemes()),
    ];
    expect(unloadedShikiIds(actuallyLoaded)).toEqual([]);
  });

  it("fails the layer order for a block inserted BEFORE @theme", () => {
    // Observed failing as:
    //   .theme-catppuccin-dark appears before @theme — @theme must be the first
    //   rule so every block resolves against the tokens it declares (observed
    //   order: .theme-catppuccin-dark < @theme < .dark < …)
    // The fixture is a synthetic stylesheet, so no shipped CSS is touched. The
    // block is a REAL one with a real token, which is what makes the mutation
    // change what the gate RETURNS instead of proving only that it runs.
    //
    // THE BASELINE BLOCKS ARE DERIVED FROM THE REGISTRY, not written out. This
    // fixture passes `themeClassNames()` as the `expected` list — the very list
    // that makes the gate refuse to grade a subset — so a hardcoded copy of the
    // shipped blocks silently went stale the day Everforest registered: the sheet
    // declared 3 palette blocks, `expected` named 5, and the gate returned
    // "declares no block" for the two it had never heard of instead of the
    // "appears before @theme" this mutation exists to produce. Deriving the sheet
    // from the same list the assertion passes makes the two impossible to drift.
    //
    // THE PROBE NAME IS NOW DERIVED TOO, for the same reason one step on. It used
    // to be `.theme-catppuccin-dark` — a real shipped block — and the moment
    // Catppuccin registered, `filter(name => name !== PROBE)` deleted a REAL block
    // out of the derived baseline, so the sheet carried 13 of the 14 names the
    // assertion demanded and the gate returned "declares no block" instead of the
    // ordering failure this mutation exists to produce. That is the same staleness
    // one level up: a constant naming a thing the registry is free to grow into.
    // So the probe is a name OUTSIDE the registry's vocabulary, and the gate below
    // asserts it stays outside — a future Palette called `mutationprobe` reddens
    // THAT instead of silently weakening this fixture.
    const PROBE = ".theme-mutationprobe-dark";
    expect(
      themeClassNames(),
      "the mutation fixture's probe block must not collide with a registered Palette class, or the derived baseline loses a real block",
    ).not.toContain(PROBE.slice(1));
    const shippedBlocks = themeClassNames()
      .map((name) => `.${name}`)
      .filter((name) => name !== PROBE)
      .map((name) => `${name} { --color-background: #161616; }`);
    const probeBlock = [PROBE, "{", "  --color-background: #1e1e2e;", "}"];
    const baseRules = [
      "@theme {",
      "  --color-background: #ffffff;",
      "}",
      ".dark {",
      "  --color-background: #161616;",
      "}",
    ];
    const fixture = [
      ...probeBlock,
      ...baseRules,
      ...shippedBlocks,
    ].join("\n");
    const failures = layerOrderFailures(fixture, [
      "@theme",
      ".dark",
      ...themeClassNames().map((name) => `.${name}`),
    ]);
    expect(failures.join("\n")).toMatch(/appears before @theme/);
    expect(failures.join("\n")).toContain(PROBE);
    // Non-vacuity of the DERIVED baseline: the sheet really does carry every class
    // the assertion demands, so the failure above is the ORDER and not a missing
    // block. Without this the derivation could rot exactly like the literal did.
    expect(shippedBlocks.length).toBe(themeClassNames().length);
    // And the same fixture with the block MOVED to the end is clean: the gate
    // detects the ORDER, not the presence of an unfamiliar name.
    const fixed = [...baseRules, ...shippedBlocks, ...probeBlock].join("\n");
    expect(
      layerOrderFailures(fixed, ["@theme", ".dark", ...themeClassNames().map((name) => `.${name}`)]),
    ).toEqual([]);
  });

  it("fails the layer order when a block is MISSING from the expected list (no quiet subset)", () => {
    // The other half of the fix: a gate over a list that silently lost a member is
    // the same five-name blind spot wearing a different hat.
    const failures = layerOrderFailures(css, [
      "@theme",
      ".dark",
      ".theme-does-not-exist-dark",
    ]);
    expect(failures.join("\n")).toMatch(/declares no block in the stylesheet/);
    expect(failures.join("\n")).toContain(".theme-does-not-exist-dark");
  });
});
