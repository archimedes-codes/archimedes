import { describe, expect, it } from "vitest";

/**
 * The two RAMP token families — `--color-caution` (the context bar's 50–69%
 * band) and `--color-thinking-*` (the thinking-LEVEL indicator hue) — must be
 * real theme-overridable tokens, never raw Tailwind hues in a component.
 *
 * Two rules are pinned here.
 *
 * (1) A thinking LEVEL's hue is an IDENTITY color (`CONTEXT.md`), not a
 *     status: it answers "which level is this", exactly like `--color-file-*`
 *     answers "which file type is this". Riding it on the status tokens
 *     (`--color-warning` / `--color-destructive`) would make a max-effort
 *     model look like a failure, and would let a Palette re-hue the level.
 *     So the family is its own (`--color-thinking-low` … `-max`), the sibling
 *     of the `THINKING_GLYPHS` table in `src/lib/toolOutput.ts` that supplies
 *     the glyph for the same levels.
 *
 * (2) WHERE each reading lives, given the class model `src/lib/theme.ts`
 *     installs: default dark is `.dark` + `.theme-default-dark`, default LIGHT is
 *     `.theme-default-light` ALONE (no `.dark`), and no class at all reads the
 *     `@theme` block. So the LIGHT-SAFE value must live in `@theme` — that is
 *     what a light mode reads — and the dark reading in `.dark`, which default
 *     dark also gets. `.theme-default-light` must therefore NOT declare them: a
 *     second light value there would silently shadow the `@theme` one and
 *     leave the classless reading unlegible. This is the same structure the
 *     `--color-file-*` descriptors already use.
 *
 * The floors: a thinking glyph is a non-text UI indicator (WCAG 3:1), the
 * `caution` token is ALSO a text label (the context percentage sits in it),
 * so it is held to the 4.5:1 text floor.
 */

import { readResolvedIndexCss } from "./cssSource";
import { cssReader, listPaletteSpecs, readCssFile, stripComments } from "./paletteTestKit";
import { paletteClass, themeClassNames } from "./palettes";
import { createSourceSweep } from "./sourceSweep";
import type { PaletteSpec } from "./paletteSpec";

/**
 * THE STYLESHEETS THIS FILE GRADES — the shared base layers from the file that
 * declares them, and each palette block from the Palette's OWN CSS file.
 *
 * WHY NOT THE RESOLVED `index.css`. `readResolvedIndexCss()` inlines only the
 * `@import`s that exist, so a grading gate that reads it either goes red for a
 * Palette whose import has not landed yet, or has to skip that Palette — and
 * skipping makes every check here vacuous for exactly the Palettes it exists to
 * grade. `paletteCompleteness.test.ts` already made this switch; the reason is
 * stated at length in the kit's header. Reading `spec.cssFile` grades the Palette
 * before its import lands, which is what lets four Palettes be authored in
 * parallel. Verified equivalent on today's tree: for all five selectors the body
 * `block()` returns is BYTE-IDENTICAL whether cut from the resolved sheet or from
 * the owning file, so this is a wiring change and not a re-grade.
 *
 * WHY `@theme` AND `.dark` COME FROM `theme.css` AND NOT FROM THE RESOLVED SHEET
 * (the choice the slice asks this comment to state). They are the SHARED base
 * layers — one file owns them, every spec row names that file as its
 * `baseCssFile`, and they are not palette blocks, so the "the import may not
 * exist yet" argument does not apply to them. Reading them from their owning file
 * anyway buys two things: this file has ZERO grading dependency on the import
 * wiring (one model of reading, not two), and the read no longer depends on which
 * package imports happen to be dropped by `cssSource.ts`. The bodies are
 * byte-identical either way, so nothing is traded for it.
 *
 * COMMENTS are removed BEFORE anything is parsed, exactly as before — and the
 * reason is unchanged: a rule's selector can be matched in PROSE (`.dark`,
 * `@theme` and the ramp tokens are all discussed in comments long before any
 * block opens), and a comment parsed as a block yields ZERO tokens, which makes
 * an absence assertion pass for the wrong reason. The mirror hazard is the
 * positive one: a declaration that is COMMENTED OUT still matches the
 * declaration regex, so `--color-thinking-max` can read as declared with a
 * value the browser never sees. This file used to have both.
 */

/**
 * A CSS file as the kit's block/declaration reader — comments removed FIRST, so
 * the SELECTOR MATCH itself cannot land on a rule's name in prose. `cssReader`
 * deliberately runs `block()` on the text as given (a byte-offset assertion needs
 * the raw text), so a caller that wants the stripped reading — which is every
 * caller in this file, and what reading the resolved sheet used to hand us — has
 * to strip before constructing the reader. `indexOfBlock` strips on its own;
 * `block()` does not.
 */
const readerFor = (path: string) => cssReader(stripComments(readCssFile(path)));

/** Pin that the strip really is doing work — a no-op regex would silently put the
 * fail-open behaviour back. Kept on the RESOLVED stylesheet (the assembled sheet
 * is what the cascade sees, and `cssSource.ts` is deliberately not told to strip),
 * and mirrored per-file below for the files this file actually grades: a file
 * whose comments were silently not stripped would make an absence assertion pass
 * on prose, which is the failure this guard exists to catch. */
if (!/\/\*[\s\S]*?\*\//.test(readResolvedIndexCss())) {
  throw new Error("index.css has no comments: the comment-strip guard is vacuous");
}

/**
 * The per-Palette grading rows, discovered by reading `src/lib/palettes/`. Every
 * palette table below is derived from these plus the registry; a hardcoded name
 * array is what made a fourth Palette buy no grading at all, which is the defect
 * Task 2 exists to close.
 */
const SPECS = await listPaletteSpecs();

/** Look up a row by id. Throws rather than returning `undefined`: a missing row
 *  would turn every gate that reads it into a loop over nothing. */
const specFor = (id: string): PaletteSpec => {
  const found = SPECS.find((spec) => spec.id === id);
  if (!found) throw new Error(`no spec row for "${id}" in src/lib/palettes/`);
  return found;
};

/** The Default row — the one whose file owns the shared `@theme` / `.dark` base. */
const DEFAULT_SPEC = specFor("default");

/** The file that declares `@theme` and `.dark`. */
const BASE_FILE = DEFAULT_SPEC.baseCssFile;

/**
 * The block reader, bound to the file that owns a selector.
 *
 * `@theme` and `.dark` resolve to `baseCssFile`; a `.theme-<id>-<mode>` selector
 * resolves to the row of the Palette that owns that reading. An UNOWNED selector
 * throws rather than falling back to the base file, because silently reading the
 * wrong file is how `block()` returns a body full of tokens the block never
 * declared — or throws `no <selector> block` for a Palette that is perfectly
 * healthy and simply not imported yet.
 */
const baseReader = readerFor(BASE_FILE);

/** The per-file half of the comment-strip guard above. The resolved sheet is what
 * the cascade sees, but this file no longer GRADES off it — so the guard has to
 * hold for the files it actually reads, or a file whose comments were silently not
 * stripped would make an absence assertion pass on prose. */
for (const path of [BASE_FILE, ...SPECS.map((spec) => spec.cssFile)]) {
  if (!/\/\*[\s\S]*?\*\//.test(readCssFile(path))) {
    throw new Error(
      `${path} has no comments: the comment-strip guard is vacuous for a file this gate grades`,
    );
  }
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The CSS selector for a registry reading (`theme-x-dark` → `.theme-x-dark`).
 *  `paletteClass()` answers with the bare class; every selector matched here, and
 *  every test title printed from it, carries the leading dot. */
const selectorFor = (className: string): string => `.${className}`;

/** Which file declares a reading's block, by asking the spec rows. */
const fileForReading = (selector: string): string => {
  const owner = SPECS.find((spec) =>
    (["light", "dark"] as const).some(
      (mode) => selectorFor(paletteClass(spec.id, mode)) === selector,
    ),
  );
  if (!owner) {
    throw new Error(
      `${selector} is not a reading any row in src/lib/palettes/ owns, so this gate cannot know which CSS file declares it`,
    );
  }
  return owner.cssFile;
};

/** A block's body, read from the file that owns the reading it declares. Throws
 *  (through the kit's `block()`) if the selector is absent from that file — which
 *  is the loud behaviour this file wants: a palette block that is not in the file
 *  its own spec row names is a broken Palette, not a skipped one. */
const blockOf = (selector: string): string =>
  readerFor(fileForReading(selector)).block(
    new RegExp(`^${escapeRegExp(selector)}\\s*\\{`, "m"),
  );

const declarations = (body: string) =>
  Object.fromEntries(
    [...body.matchAll(/--(color-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim(),
    ]),
  );

/** The base layers, from the file that declares them. Both reads go through the
 *  kit's brace-counting `block()`, so there is ONE copy of that reader in the
 *  repo: the `\n}` heuristic the sibling `fileIconContrast.test.ts` used to use
 *  truncates at the FIRST nested block, which for an absence assertion fails
 *  OPEN — the tokens look undeclared because they were never looked at. Anchored
 *  at line start so a match cannot land on a prose mention of the selector. */
const THEME = declarations(baseReader.block(/^@theme\s*\{/m));
const DARK = declarations(baseReader.block(/^\.dark\s*\{/m));
/** The palette readings, each from its Palette's own file. */
const DEFAULT_LIGHT = declarations(blockOf(".theme-default-light"));
const DEFAULT_DARK = declarations(blockOf(".theme-default-dark"));
const DRACULA = declarations(blockOf(".theme-dracula-dark"));



/** The six ramp tokens, and the Tailwind hue (as its v3 HEX) each `.dark` value
 *  REPLACES — asserting the pairing keeps this a token introduction rather than
 *  a re-design for default dark.
 *
 *  NOT "the shipped rendering must not move by one byte", which is what this
 *  comment used to claim and which is false. This repo is Tailwind v4 and its
 *  palette is `oklch()` (`node_modules/tailwindcss/theme.css`:
 *  `--color-blue-500: oklch(62.3% 0.214 259.815)`), while the values below are
 *  the v3 hex equivalents. So a component that read `text-blue-500` was
 *  rendering `#2b7fff` and now renders `#3b82f6`. Decoding the real oklch and
 *  comparing, the worst case across these six is 0.0110 relative luminance
 *  (orange, the context band) and 0.19 contrast against the surface the glyph
 *  paints on — sub-perceptual, and every value still clears the floor this file
 *  enforces below, but this assertion pins the VALUE PAIRING, not pixel
 *  equality with what v4 rendered before. */
const RAMP: Record<string, string> = {
  // The context bar's 50–69% band, between `success` and `warning`.
  "color-caution": "#eab308", // = yellow-500
  // The thinking-level ramp (SessionConfigSelect's indicator glyph hue).
  "color-thinking-low": "#3b82f6", // = blue-500
  "color-thinking-medium": "#6366f1", // = indigo-500
  "color-thinking-high": "#a855f7", // = purple-500
  "color-thinking-xhigh": "#ec4899", // = pink-500
  "color-thinking-max": "#ef4444", // = red-500
};

const names = Object.keys(RAMP);

// The surfaces these are judged on. Light: the `@theme` card/white AND default
// light's `#f8f8f8` page; dark: default dark's `#161616` page.
const WHITE = "#ffffff";
const LIGHT_BG = "#f8f8f8"; // .theme-default-light --color-background
const DARK_BG = "#161616"; // .theme-default-dark --color-background

const parseHex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const relLum = ([r, g, b]: [number, number, number]) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [relLum(parseHex(a)), relLum(parseHex(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/** Hue angle (0–360) of a plain hex. */
const hue = (hex: string): number => {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

/**
 * How far a hue sits from the COOL end. Cyan (hue 180) is the coolest colour
 * there is and red (hue 0) the hottest, so "hotter" is exactly "further from
 * 180", measured as an angle in 0–180.
 *
 * This is the definition the per-palette ramp assertion needs. The naive one —
 * "the hue angle increases" — is true of Default (blue 217 → indigo 239 → purple
 * 271 → pink 330 → red 0) and FALSE of Dracula (cyan 190 → green 135 → yellow
 * 65 → orange 31 → red 0), yet both are unmistakably cool → hot. Asserting
 * increasing hue would make this file wrong about a palette that is entitled to
 * its own ramp ordering.
 */
const hotness = (hex: string): number => Math.abs(((hue(hex) + 360) % 360) - 180);

/** The five thinking LEVELS in magnitude order (the sibling of
 *  `THINKING_GLYPHS` in `src/lib/toolOutput.ts`). */
const THINKING_LEVELS = [
  "color-thinking-low",
  "color-thinking-medium",
  "color-thinking-high",
  "color-thinking-xhigh",
  "color-thinking-max",
];

/** The status family the ramp must never be mistaken for. */
const STATUS_TOKENS = [
  "color-success",
  "color-warning",
  "color-destructive",
  "color-caution",
];

/**
 * The tokens a thinking LEVEL must never print the same hex as.
 *
 * This used to be the four `STATUS_TOKENS`, and that was too narrow to express
 * the family's own rationale. The rule is "a level's hue is IDENTITY, not
 * status" — so any token that paints UI meaning is off-limits: the status set,
 * the interaction/diff hues a transcript row already uses to mean something,
 * the accent/brand fills, and the file descriptors. `@theme` and `.dark` carry
 * none of these as literal hexes (they are `var()` into Tailwind's scale), so
 * widening the set costs nothing there and catches everything in Dracula, where
 * every token is a literal.
 *
 * The 22 `--color-terminal-*` tokens are EXCLUDED, and deliberately so: the
 * spec's ANSI table reuses the palette's own syntax hues by construction (Ansi
 * Green IS `#50fa7b`), so a ramp built from spec hues shares hexes with the ANSI
 * set no matter which values it picks — the previous ramp already did (`#50fa7b`,
 * `#8be9fd`, `#f1fa8c`, `#ff5555` all appeared twice). No terminal token paints
 * UI today, so none can be mistaken for a status. That exclusion is the ONLY
 * one, and it is checked below so it cannot quietly widen.
 */
const MEANINGFUL_TOKENS = [
  "color-caution",
  "color-success",
  "color-warning",
  "color-destructive",
  "color-diff-added",
  "color-diff-removed",
  "color-interaction-ask-foreground",
  "color-interaction-confirmation-foreground",
  "color-brand",
  "color-primary",
  "color-accent",
  "color-idle-task",
  "color-foreground",
  "color-foreground-subtle",
  "color-foreground-subtlest",
  // The row token family (ADR 0062). Adding these WIDENS the set the
  // `statusCollisions` loop compares — a thinking level may not print the same
  // hex as a row glyph or a row verb either. Dracula's ramp is built from the
  // ANSI BRIGHTS and uses neither `#ffb86c` nor `#8be9fd`, so this costs
  // nothing today; it is here so the two families cannot be collapsed onto each
  // other later without failing by name.
  "color-row-icon",
  "color-row-verb",
  // The film token (ADR 0071). `--color-film-glyph` is OPAQUE by decision, so it
  // shares a hex with nothing today. It is here so the film's colour and the
  // thinking ramp cannot later be collapsed onto one hex without failing by name
  // — the same reason the row pair above is listed.
  "color-film-glyph",
  "color-border",
];

/**
 * The thinking-level ⇄ meaningful-token collisions that exist TODAY and are
 * accepted deliberately. Empty as of the ANSI-bright re-hue: every level now
 * prints a hex that no other UI-meaningful token in its block prints.
 *
 * The list is kept rather than deleted because it is the mechanism that makes
 * the gate specific — a NEW collision fails by name, and an entry that stops
 * being true fails as stale (asserted below), so the list cannot become a
 * blanket exemption and cannot rot.
 */
const KNOWN_STATUS_COLLISIONS: string[] = [];

/**
 * The levels of one block that print the SAME hex as another UI-meaningful
 * token of the same block, as `"<block>: <level> == <token> (<hex>)"`. Kept as
 * a function so the test can run it on a synthetic map and prove it detects a
 * collision at all — see the non-vacuity assertion in the test that reads the
 * allow-list.
 */
const statusCollisions = (
  blockName: string,
  tokens: Record<string, string>,
): string[] => {
  const out: string[] = [];
  for (const level of THINKING_LEVELS) {
    const v = tokens[level];
    if (v === undefined) continue;
    for (const status of MEANINGFUL_TOKENS) {
      if (status === level) continue;
      const s = tokens[status];
      if (s !== undefined && s.toLowerCase() === v.toLowerCase()) {
        out.push(`${blockName}: ${level} == ${status} (${v})`);
      }
    }
  }
  return out;
};

/**
 * Every block that ships its OWN reading of the ramp: `@theme` is the light (and
 * classless) reading, `.dark` is default dark's, and then EVERY palette reading
 * that re-hues the ramp — today `.theme-dracula-dark`, tomorrow whichever Palette
 * names the ramp in its spec row's `extraBeyondDefault`.
 *
 * DERIVED, NOT LISTED. This used to be a three-entry array with Dracula spelled
 * in it, and that is the shape this task exists to retire: a fourth Palette that
 * re-hued the ramp would appear nowhere in the loop below, so its ramp would be
 * ungraded while the suite stayed green. The rule the derivation encodes is the
 * one the spec contract already states — a reading that declares tokens the
 * Default dark block does not declares them in `extraBeyondDefault`, and the kit
 * asserts that set as an EQUALITY in both directions. So a Palette cannot opt out
 * of ramp grading by being new: declaring a ramp token without naming it puts the
 * kit's own completeness gate red, and naming it here buys it five more gates.
 *
 * `.theme-default-light` and `.theme-default-dark` are absent on purpose and are
 * asserted absent below — a value there would shadow the two readings above.
 */
const RAMP_BLOCKS: { name: string; tokens: Record<string, string> }[] = [
  { name: "@theme", tokens: THEME },
  { name: ".dark", tokens: DARK },
  ...SPECS.flatMap((spec) =>
    (["light", "dark"] as const)
      .filter((mode) => spec.modes[mode]?.extraBeyondDefault.includes("color-thinking-low"))
      .map((mode) => {
        const selector = selectorFor(paletteClass(spec.id, mode));
        return { name: selector, tokens: declarations(blockOf(selector)) };
      }),
  ),
];


/**
 * The thinking-level ⇄ status-hue collisions that exist TODAY and are accepted
 * deliberately — see the test that reads this list for why clearing them is a
 * design decision rather than a fix. `@theme` and `.dark` contribute nothing:
 * their status tokens are `var()` into Tailwind's scale, so they share no
 * literal hex with the ramp. Entries are `"<block>: <level> == <status>"`.
 */

/** Text (4.5) for the token that carries a label, glyph (3) for the pure
 *  indicator hues. */
const FLOOR: Record<string, number> = {
  "color-caution": 4.5,
  ...Object.fromEntries(names.filter((n) => n !== "color-caution").map((n) => [n, 3])),
};

describe("the ramp tokens (--color-caution + --color-thinking-*)", () => {
  it.each(names)("%s is declared in @theme (the light-safe reading)", (name) => {
    expect(THEME[name], `${name} missing from @theme`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(names)("%s is declared in .dark (the dark reading)", (name) => {
    expect(DARK[name], `${name} missing from .dark`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("carries no raw Tailwind hue: every @theme value is a literal hex", () => {
    // A `var(--color-blue-500)` indirection would compile today and survive
    // every other assertion here, yet stay frozen across a palette swap.
    for (const name of names) {
      expect(THEME[name]).not.toContain("var(");
      expect(DARK[name]).not.toContain("var(");
    }
  });

  it.each(names)("%s keeps default dark on the hue it replaces (value pairing)", (name) => {
    // The pairing, not pixel-identity: see the `RAMP` comment for why the v3 hex
    // and the v4 `oklch()` utility are not the same colour.
    expect(DARK[name]?.toLowerCase()).toBe(RAMP[name]);
  });

  it.each(names)(
    "%s is NOT declared in .theme-default-light (light mode must inherit @theme)",
    (name) => {
      expect(DEFAULT_LIGHT[name], `${name} must not shadow @theme in .theme-default-light`).toBeUndefined();
    },
  );

  it.each(names)("%s is NOT declared in .theme-default-dark (.dark already covers it)", (name) => {
    expect(DEFAULT_DARK[name], `${name} belongs in .dark, not .theme-default-dark`).toBeUndefined();
  });

  it.each(names)("%s clears its floor on white", (name) => {
    expect(contrast(THEME[name]!, WHITE)).toBeGreaterThanOrEqual(FLOOR[name]!);
  });

  it.each(names)("%s clears its floor on the default-light background", (name) => {
    expect(contrast(THEME[name]!, LIGHT_BG)).toBeGreaterThanOrEqual(FLOOR[name]!);
  });

  it.each(names)("%s clears its floor on the default-dark background", (name) => {
    expect(contrast(DARK[name]!, DARK_BG)).toBeGreaterThanOrEqual(FLOOR[name]!);
  });

  it("the thinking ramp is a real ramp, in EVERY palette reading", () => {
    // Formerly "in either reading" — and that comment was FALSE as written: the
    // test read only `@theme` and `.dark`, so `theme-dracula-dark` appeared nowhere in
    // this file. Collapsing all five Dracula levels to one hex left 179 tests
    // green. There are three palette readings now (ADR 0027), so the ramp is
    // checked once per block that ships its own.
    for (const p of RAMP_BLOCKS) {
      const levels = THINKING_LEVELS.map((n) => p.tokens[n]);
      // (a) PRESENT: a level a palette forgets does not fail, it inherits the
      //     `@theme` light-safe hue onto a dark surface.
      for (const [i, name] of THINKING_LEVELS.entries()) {
        expect(
          levels[i],
          `${name} is undeclared in ${p.name} — it would silently inherit @theme`,
        ).toBeTruthy();
      }
      const hexes = levels.map((v) => v!.toLowerCase());
      // (b) MUTUALLY DISTINCT: two levels that render the same colour are
      //     indistinguishable, and the glyph already repeats for xhigh/max, so
      //     the hue is the only signal left.
      expect(new Set(hexes).size, `${p.name}: two thinking levels share a hue`).toBe(
        hexes.length,
      );
      // Every value must be a plain hex or this file cannot judge it.
      for (const [i, name] of THINKING_LEVELS.entries()) {
        expect(
          hexes[i],
          `${name} in ${p.name} is not a plain hex (${levels[i]}) — the ramp must be comparable by hue`,
        ).toMatch(/^#[0-9a-f]{6}$/);
      }
      // (c) ORDERED cool → hot, asserted as `hotness` strictly increasing — see
      //     `hotness` for why this is proximity-to-red and not "the hue angle
      //     increases". The default-specific increasing-hue assertion is kept below.
      const heat = hexes.map(hotness);
      for (let i = 1; i < heat.length; i++) {
        expect(
          heat[i]!,
          `${p.name}: ${THINKING_LEVELS[i]} must read HOTTER than ${THINKING_LEVELS[i - 1]} (ramp hue order)`,
        ).toBeGreaterThan(heat[i - 1]!);
      }
      // The endpoints, named: the ramp must START cool and END on the hot end,
      // so a palette cannot satisfy "strictly ordered" by walking the wrong way.
      expect(heat[0]!, `${p.name}: -low must be a cool hue`).toBeLessThanOrEqual(60);
      expect(heat[4]!, `${p.name}: -max must sit on the hot end`).toBeGreaterThanOrEqual(150);
    }
  });

  it("orders the ramp cool → hot, matching the level's magnitude", () => {
    // The assertion this file shipped with, unchanged in substance and now
    // labelled for what it actually covered: the two default readings (the shipped
    // dark one, and the light one). The per-palette version above is the one
    // that also looks at `.theme-dracula-dark`.
    const hues = THINKING_LEVELS.map((n) => hue(DARK[n]!));
    expect(hues[0]).toBeLessThan(hues[1]!);
    expect(hues[1]!).toBeLessThan(hues[2]!);
    expect(hues[2]!).toBeLessThan(hues[3]!);
    expect(hues[4]!).toBeLessThan(30);
    // Same shape in the light reading.
    const lightHues = THINKING_LEVELS.map((n) => hue(THEME[n]!));
    expect(lightHues[0]).toBeLessThan(lightHues[1]!);
    expect(lightHues[1]!).toBeLessThan(lightHues[2]!);
    expect(lightHues[2]!).toBeLessThan(lightHues[3]!);
    expect(lightHues[4]!).toBeLessThan(30);
  });

  it("never RIDES a status token (--color-thinking-* is its own family)", () => {
    // The structural half of the family's rationale: `index.css` states the
    // levels are IDENTITY colors, so they get their own tokens rather than
    // riding `--color-warning`/`--color-destructive` — which would make a
    // max-effort model read as a failure AND let a Palette re-hue the level by
    // editing a status token. Checked as an ALIAS (what the CSS actually
    // promises), in every block that declares the ramp.
    for (const p of RAMP_BLOCKS) {
      for (const name of [...THINKING_LEVELS, "color-caution"]) {
        const v = p.tokens[name];
        if (v === undefined) continue;
        expect(
          /var\(--color-(success|warning|destructive|caution)\)/.test(v),
          `${name} in ${p.name} rides a status token: ${v}`,
        ).toBe(false);
      }
    }
    // Non-vacuous: the ramp really is graded in EVERY block that ships its own
    // reading of it. This used to read `expect(RAMP_BLOCKS.length).toBe(3)` —
    // correct while the list was written out by hand, and a red shared suite for
    // the first Palette that re-hued the ramp once the list was derived. So the
    // guard is now a CROSS-CHECK instead of a count: the blocks graded here must
    // be exactly the base layers plus every reading whose own spec row says it
    // declares the ramp (`extraBeyondDefault`, which the kit asserts as a
    // two-directional set equality — so a Palette cannot neither opt out nor sneak
    // in). A floor of three keeps the old guard's real job: a derivation that
    // found nothing would otherwise grade the ramp in the base layers alone.
    expect(
      RAMP_BLOCKS.map((b) => b.name),
      "the blocks the ramp gate reads are not the blocks that ship a ramp reading",
    ).toEqual([
      ...BASE_LAYERS,
      ...SPECS.flatMap((spec) =>
        (["light", "dark"] as const)
          .filter((mode) =>
            spec.modes[mode]?.extraBeyondDefault.includes("color-thinking-low"),
          )
          .map((mode) => selectorFor(paletteClass(spec.id, mode))),
      ),
    ]);
    expect(RAMP_BLOCKS.length).toBeGreaterThanOrEqual(3);
    // And Dracula — the one palette that re-hues the ramp today — is in there.
    // Named deliberately: it is the block whose ramp this file's whole rationale
    // is about, and a derivation that silently dropped it would otherwise be
    // indistinguishable from a clean sweep.
    expect(RAMP_BLOCKS.map((b) => b.name)).toContain(selectorFor(paletteClass("dracula", "dark")));
  });

  it("does not print the same hex as any other UI-meaningful token", () => {
    // The VALUE half of the family's rationale — "a max-effort model must not
    // look like a failure" — checked as a literal hex collision inside one block.
    //
    // This is the hole that let `.theme-dracula-dark` paint FOUR of its five levels
    // with a status hex verbatim (`-medium` == success `#50fa7b`, `-high` ==
    // caution `#f1fa8c`, `-xhigh` == warning `#ffb86c`, `-max` == destructive
    // `#ff5555`), which is precisely the confusion the family's own doc-comment
    // says it exists to prevent. The ramp is now built from the spec's ANSI
    // BRIGHTS, which are hues no UI token in the block uses, so the allow-list is
    // EMPTY and every collision fails by name.
    //
    // Checked per block because `@theme` and `.dark` express their status tokens
    // as `var()` into Tailwind's scale and so share no literal hex with anything.
    for (const p of RAMP_BLOCKS) {
      const offenders = statusCollisions(p.name, p.tokens);
      const allowed = KNOWN_STATUS_COLLISIONS.filter((o) => o.startsWith(`${p.name}:`));
      // The offender strings carry the offending hex for the failure message, so
      // they are matched against the allow-list on the `block: level == token`
      // prefix — an entry cannot absorb a collision merely by naming the pair,
      // the pair has to be the one actually listed.
      const unexpected = offenders.filter(
        (o) => !allowed.some((a) => o.startsWith(`${a} (`)),
      );
      expect(unexpected, `${p.name}: new thinking/status hue collision`).toEqual([]);
    }

    // The gate is non-vacuous in two directions.
    // (1) A detector that always returned "no collisions" would be
    // indistinguishable
    //     from a clean palette, so it is run on a synthetic map where a collision
    //     is forced — with the allow-list EMPTY, so this proves the collision is
    //     reported as an OFFENDER and not swallowed by an exemption.
    const synthetic = {
      ...DRACULA,
      "color-thinking-low": DRACULA["color-success"]!,
    };
    expect(
      statusCollisions(".theme-dracula-dark", synthetic),
      "the collision detector must report a forced collision",
    ).toContain(
      `.theme-dracula-dark: color-thinking-low == color-success (${DRACULA["color-success"]})`,
    );
    // (2) The clean result is measured, not assumed: the block really does carry
    //     all five levels and all the meaningful tokens, so a zero-offender result
    //     came from comparing five things against many, not from an empty input.
    const draculaLevels = THINKING_LEVELS.filter((n) => DRACULA[n] !== undefined);
    expect(draculaLevels.length).toBe(THINKING_LEVELS.length);
    const compared = MEANINGFUL_TOKENS.filter((n) => DRACULA[n] !== undefined);
    expect(compared.length).toBeGreaterThan(10);
    // And every meaningful token named above must be a token the stylesheet can
    // actually resolve, or the set has silently shrunk.
    // The four status tokens are the CORE of the forbidden set — the whole
    // rationale of the family is about them — so pinning that they survived into
    // the wider list is what keeps "wider" from meaning "different".
    for (const status of STATUS_TOKENS) {
      expect(MEANINGFUL_TOKENS).toContain(status);
    }
    expect(MEANINGFUL_TOKENS).toContain("color-interaction-ask-foreground");

    // The allow-list may only name real blocks, levels and tokens — so it cannot
    // quietly accrete entries that match nothing.
    for (const entry of KNOWN_STATUS_COLLISIONS) {
      const [blockName, pair] = entry.split(": ");
      const [level, status] = pair.split(" == ");
      expect(RAMP_BLOCKS.some((b) => b.name === blockName), `stale block in list: ${entry}`).toBe(true);
      expect(THINKING_LEVELS).toContain(level);
      expect(MEANINGFUL_TOKENS).toContain(status);
    }
    // And an entry may not outlive the collision it excuses: each one must be
    // live in the block it names, or it is a permanent exemption wearing a
    // temporary one.
    for (const entry of KNOWN_STATUS_COLLISIONS) {
      const [blockName, pair] = entry.split(": ");
      const [level, status] = pair.split(" == ");
      const block = RAMP_BLOCKS.find((b) => b.name === blockName)!;
      expect(
        statusCollisions(blockName, block.tokens),
        `stale allow-list entry (the collision is gone): ${entry}`,
      ).toContain(`${blockName}: ${level} == ${status} (${block.tokens[level]})`);
    }
  });

  it("keeps the Dracula ramp legible as a glyph on both surfaces it renders on", () => {
    // The ramp's own floors, re-measured for the palette that owns them. The
    // thinking glyph rides the composer's config row (`bg-input`, `#191a21` under
    // Dracula) and the page; a glyph is non-text UI, so 3:1 is the floor. The
    // previous ramp's hottest level sat at 4.53 on the page and 3.75 on a panel,
    // so the numbers below are the ones the re-hue was chosen against.
    const surfaces: Array<[string, string]> = [
      ["the Dracula page", DRACULA["color-background"]!],
      ["the Dracula composer well (bg-input)", DRACULA["color-input"]!],
    ];
    for (const [label, bg] of surfaces) {
      expect(bg, "the surfaces must be plain hexes to be comparable").toMatch(
        /^#[0-9a-f]{6}$/,
      );
      for (const name of THINKING_LEVELS) {
        const v = DRACULA[name]!;
        expect(
          contrast(v, bg),
          `${name} (${v}) on ${label} ${bg}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps the Dracula ramp ordered by PERCEIVED heat, not just by hue angle", () => {
    // `hotness` (proximity to red) is what orders the ramp, and it is an ANGLE:
    // it says `#ff92df` (318°) is nearer red than `#ffffa5` (60°) without saying
    // whether the two are tellable apart at 14px. So this pins the two things
    // `hotness` cannot express.
    //
    // (1) ADJACENT HUE SEPARATION. The naive version of this assertion is "the
    //     luminance contrast between adjacent levels must exceed 1.3", and that
    //     is the WRONG metric — it fails a ramp that is perfectly readable, because
    //     a cool→hot ramp necessarily passes through yellow, the BRIGHTEST hue
    //     there is, so luminance rises for the first half and falls for the second.
    //     (It also fails the shipped default ramp, which is not a bug.) Hue distance
    //     is what a glyph is recognised by, so that is what is required: ≥ 25°
    //     between neighbours, measured the short way round the wheel.
    // (2) THE HOT END IS NOT THE PALE END. `hotness` is maximised by any pure red
    //     INCLUDING a near-white one, so without this a palette could satisfy the
    //     whole ramp by walking from saturated cyan to washed-out pink.
    const hexes = THINKING_LEVELS.map((n) => DRACULA[n]!.toLowerCase());
    const hueOf = (hex: string) => {
      const [r, g, b] = parseHex(hex).map((v) => v / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      const h =
        max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const hueDistance = (a: string, b: string) => {
      const d = Math.abs(hueOf(a) - hueOf(b));
      return Math.min(d, 360 - d);
    };
    for (let i = 1; i < hexes.length; i++) {
      expect(
        hueDistance(hexes[i - 1]!, hexes[i]!),
        `${THINKING_LEVELS[i - 1]} (${hexes[i - 1]}) and ${THINKING_LEVELS[i]} (${hexes[i]}) are less than 25° apart in hue — indistinguishable as a 14px glyph`,
      ).toBeGreaterThanOrEqual(25);
    }
    const lumOf = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return (
        0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
      );
    };
    expect(
      lumOf(hexes[4]!),
      `-max (${hexes[4]}) must not be brighter than -low (${hexes[0]}) — the hot end of the ramp is the saturated end, not the washed-out one`,
    ).toBeLessThan(lumOf(hexes[0]!));
    // And `max` specifically must be a RED, not a pink that merely scores 180:
    // red is the hue the family is allowed to end on because it is the palette's
    // own hot end.
    expect(hueOf(hexes[4]!)).toBeLessThan(15);
  });
});

/**
 * The ROW token family — `--color-row-icon` / `--color-row-verb` (ADR 0062).
 *
 * Named for `TRANSCRIPT_ROW` (`src/components/lib/transcriptRow.ts`), the class
 * constant the tool rows, the `Thought` trigger and the `Changes` group share,
 * so all three consumers are in scope and not only the tools. Four rules are
 * pinned below.
 *
 * (1) PRESENT IN EVERY LAYER. This app's class model (ADR 0027, and the
 *     header comment of this file) means a token a palette forgets does not
 *     fail — it silently inherits the `@theme` reading. A row token is no
 *     exception: `.theme-dracula-dark` must state its own orange/cyan or every Dracula
 *     row renders the default palette's greys, and nothing would complain.
 *     "Every layer" is `ALL_LAYERS` below — the two base layers plus every reading
 *     `themeClassNames()` can produce, 15 today — and it is DERIVED rather than
 *     written out, because the five names this array used to hold were hand-listed
 *     and a sixth Palette joined none of the loops that read it.
 * (2) THE ALIAS IS THE CONTRACT in every non-Dracula reading — 12 of the 13 the
 *     registry offers, all of them verified to be the alias and not a literal.
 *     `var(–color-
 *     foreground-subtle)` / `var(–color-foreground-subtlest)` are TODAY's
 *     readings, restated as an indirection so a palette can re-hue a row without
 *     a component being touched. A literal hex there would freeze the value
 *     across a palette swap while still passing rule (1) — hence pinning the
 *     value as a `var()` and not merely as "declared".
 * (3) DRACULA'S TWO HEXES ARE PINNED BY VALUE. This is deliberately NOT a
 *     generic "collides with no other `MEANINGFUL_TOKENS` entry" gate, because
 *     the family's own design makes such a gate false on day one:
 *
 *       - the ICON is `#ffb86c`, verbatim `--color-warning`, the collision ADR
 *         0062 records and accepts;
 *       - the VERB is `#8be9fd`, which `--color-interaction-ask-foreground`
 *         already carried BEFORE this family existed — and that token is itself
 *         in `MEANINGFUL_TOKENS`.
 *
 *     So a collision gate would have to allow-list two entries to pass, and an
 *     allow-list that big is how a gate stops meaning anything. Pinning the
 *     values instead makes the job "someone chose these two hexes, on purpose,
 *     per palette": collapsing the icon onto `--color-warning` or the verb onto
 *     the ask-foreground token is then a decision with a failing test attached
 *     rather than a silent simplification.
 * (4) THE DEAD ROW-KIND FAMILY STAYS DEAD. The predecessor family split by row
 *     KIND and rendered nothing; ADR 0062 deletes it so the codebase ships one
 *     row-hue family rather than two. Its name is asserted absent from every
 *     CSS layer and from every file under `src/`, so a re-introduction — or a
 *     half-migration that leaves the old names in a glossary-adjacent test list
 *     — fails here.
 */

/**
 * The dead family's name, CONSTRUCTED rather than written out.
 *
 * The whole point of the deletion gate below is that this word appears NOWHERE
 * under `src/` — which is also the manual check the task states (a recursive
 * grep for it over `src/` must return nothing). A test that spelled the word in
 * its own prose would BE the single file that made that grep return a hit, and
 * would then have to exempt itself to pass — a gate with a hole the size of the
 * gate. So the string is assembled from two halves, exactly like `cssSource.ts`
 * assembles `node:fs` to stay inside a DOM-only `@types` budget: the constant
 * holds the value, no file holds the word. The non-vacuity test below asserts
 * that this file really is word-free, so the trick cannot silently rot into a
 * file that names the word AND passes.
 */
const DEAD_ROW_KIND_PREFIX = "traje" + "ctory";

/**
 * Reading FILES (not just the stylesheet) is what lets the gates below check the
 * three consumer components and sweep the whole of `src/`. `cssSource.ts` owns
 * the CSS read and deliberately exposes no directory listing, so this file goes
 * to Node directly — through the same COMPUTED specifier the sibling
 * `paletteCompleteness.test.ts` and `cssSource.ts` use, because this app ships
 * no `@types/node` and a bare `node:fs` import would not typecheck.
 */
const NODE_FS = "node:" + "fs";
const { readdirSync } = (await import(NODE_FS)) as {
  readdirSync: (path: string, options: { recursive: true; encoding: string }) => string[];
};
// Reads go through the SWEEP READER (see `sourceSweep.ts`): the two directory
// sweeps below list `src/` and then open every path in a later loop, and vitest
// runs test files concurrently across workers — so a listed path can be deleted
// between the listing and the open. This file is exposed on the CSS half in
// particular: the live palette guard writes `src/styles/guardprobe.css`, which
// `textFilesUnder("src")` picks up, and deletes it from ANOTHER worker's
// `finally`.
const sweep = createSourceSweep();

/** A file's text, relative to the repo root (the cwd every test here runs in).
 *  For paths a LITERAL names. A missing one is a broken gate, not a moving tree,
 *  so it throws — see `sourceSweep.ts`. */
const readTextFile = (relPath: string): string => sweep.named(relPath);

/** A file's text for a path that came out of `textFilesUnder`. `""` for one that
 *  vanished since the listing: it does not exist, so it cannot name the dead
 *  family and cannot contribute a declaration, and the skip is RECORDED in
 *  `sweep.skipped()` rather than silent. */
const readListedFile = (relPath: string): string => sweep.listed(relPath) ?? "";

/** The module, for the non-vacuity probe at the bottom: it CREATES and DELETES a
 *  scratch file so the skip branch is driven on purpose rather than waited for.
 *  Same COMPUTED specifier (this app ships no `@types/node`). */
const NODE_FS_MODULE = (await import(NODE_FS)) as unknown as {
  writeFileSync: (path: string, data: string) => void;
  rmSync: (path: string, options?: { force?: boolean; recursive?: boolean }) => void;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
};
const fs = NODE_FS_MODULE;

/**
 * Remove COMMENTS from a TS/TSX source, so a class name that appears only in
 * PROSE cannot be counted as a consumer — the exact hazard every CSS test in
 * this repo already guards against, and which this file's own `Thought` comment
 * demonstrated by failing the utility count below before the strip went in.
 *
 * The coverage is deliberately narrow and stated rather than implied: block
 * comments (`/* … *\/`, which is also how a `{…}` JSX comment looks) and
 * WHOLE-LINE `//` comments. A trailing `// note` is NOT stripped, because
 * telling a comment from a `"https://…"` string needs a real parser and this
 * repo ships none. That boundary is enforced rather than trusted — the last
 * assertion of the non-vacuity test scans the three row components for a
 * utility name to the right of a `//` and fails if one appears, so the blind
 * spot cannot start mattering unnoticed.
 */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** Text files under a directory, recursively. Measured on this tree, `src/`
 *  holds 124 `.ts`, 123 `.tsx` and 5 `.css` files and NOTHING else, so the
 *  extension filter is not skipping real input today; it is here so that adding
 *  a font or an image later cannot turn the sweep below into a binary read.
 *  A `readdirSync` that returned only names (not paths) is why the mapping
 *  prefixes the directory. */
const textFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.[cm]?[jt]sx?$|\.css$/.test(p))
    .map((p) => `${dir}/${p}`);

/** The dead-family census over a LIST of paths, extracted from the gate below so
 *  the non-vacuity probe can drive THIS predicate — the one that guards, not a
 *  copy of it — over a listing it controls. `tauriBoundary.test.ts`'s
 *  one-predicate-used-twice lesson: a vacuity guard over a second copy is
 *  decoration.
 *
 *  A path that vanished between `textFilesUnder` and this read contributes
 *  nothing and lands in `sweep.skipped()`. A deleted file cannot name the dead
 *  family because it is not there, and the skip is recorded rather than silent —
 *  see `sourceSweep.ts`. */
const deadFamilyHitsIn = (files: readonly string[]): string[] =>
  files.filter((f) => readListedFile(f).includes(DEAD_ROW_KIND_PREFIX));

/** The two SHARED base layers, always present, always declared by `baseCssFile`.
 *  Kept separate from the palette readings because they are not palettes: they
 *  exist whether or not any `@import` has landed, and the rules below need to tell
 *  "a base layer must alias" from "a palette reading may state its own hex". */
const BASE_LAYERS = ["@theme", ".dark"] as const;

/**
 * Every layer of the cascade, in source order, DERIVED FROM THE REGISTRY.
 *
 * `@theme` and `.dark` come from the file that declares them; then EVERY reading
 * `themeClassNames()` can produce, each read from the Palette's own CSS file. The
 * five names this array used to hold were written out by hand, so a sixth Palette
 * joined none of the loops that read it — "all five layers" became "all five
 * names someone remembered", which is the defect Task 2 exists to close. The
 * order itself is pinned by `paletteCompleteness.test.ts`; it is listed here so
 * "every layer" is a loop rather than five copy-pasted assertions that can lose
 * one.
 *
 * A reading whose block is missing from the file its own spec row names throws
 * rather than being skipped — that is a broken Palette, not an ungraded one.
 */
const ALL_LAYERS: { name: string; tokens: Record<string, string> }[] = [
  ...BASE_LAYERS.map((name) => ({
    name,
    tokens: declarations(baseReader.block(new RegExp(`^${escapeRegExp(name)}\\s*\\{`, "m"))),
  })),
  ...themeClassNames().map((className) => {
    const selector = selectorFor(className);
    return { name: selector, tokens: declarations(blockOf(selector)) };
  }),
];

/** The row family, and the value each layer is REQUIRED to carry. The base layers
 *  and the Default readings alias; a palette with its own reading states hexes. */
const ROW_ICON = "color-row-icon";
const ROW_VERB = "color-row-verb";
const ALIAS_ICON = "var(--color-foreground-subtle)";
const ALIAS_VERB = "var(--color-foreground-subtlest)";

/**
 * Per-palette readings, pinned BY VALUE — see rule (3) of the block comment.
 *
 * KEYED BY READING and REQUIRED FOR EVERY READING THE REGISTRY OFFERS, which is
 * the part that used to be implicit: the old table had five entries because there
 * were five layers, and nothing checked that. A Palette that ships a reading and
 * states no expectation here now THROWS at load (see `pinnedReading` below) rather
 * than defaulting — "this palette inherits the alias" is a claim ABOUT the palette
 * and this file may not assume it on the palette's behalf. Assuming it would be
 * the silent weakening this conversion must not introduce: a palette that states
 * its own hex would be graded against an alias it does not carry.
 */
const PALETTE_ROW_READINGS: Record<
  string,
  { icon: string; verb: string }
> = {
  ".theme-default-light": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-default-dark": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-dracula-dark": { icon: "#ffb86c", verb: "#8be9fd" },
  // Everforest states NO hex for this family: both readings carry the aliases
  // verbatim (`.theme-everforest-{dark,light}` declare `var(--color-foreground-subtle)`
  // / `var(--color-foreground-subtlest)`), so it is graded against the alias and
  // stays outside the "exactly one layer states a literal row hex" count below.
  // The alternative was Everforest's own grey1/grey0 (#859289 / #939f91) — its
  // "inactive tab label" and "comments/UI borders" steps — and that would have
  // made this Palette the SECOND layer to state a literal, which ADR 0062 says is
  // a deliberate act requiring its own amendment. Inheriting is also what the
  // scheme asks for: Everforest's foreground family already carries the de-emphasis
  // tiers, so an alias keeps the row glyphs on the palette by way of the ink.
  ".theme-everforest-light": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-everforest-dark": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  // The four Wave-3 Palettes alias too, so none of them joins the single
  // literal-stating layer above (the count gate below still expects exactly one).
  // Each CSS file declares the two aliases verbatim — read off `src/styles/
  // {catppuccin,ayu,rose-pine,kanagawa}.css`, two lines per block — and each states
  // its OWN `--color-film-glyph` instead, which is the split ADR 0062 / ADR 0071
  // draw: the row family rides the palette's ink tiers, the film glyph cannot
  // because alpha is the one dimmer the film cannot afford.
  ".theme-catppuccin-light": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-catppuccin-dark": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-ayu-light": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-ayu-dark": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-rose-pine-light": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-rose-pine-dark": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-kanagawa-light": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".theme-kanagawa-dark": { icon: ALIAS_ICON, verb: ALIAS_VERB },
};

/** The base layers' pinned readings (rule (2): the alias IS the contract there). */
const BASE_ROW_READINGS: Record<string, { icon: string; verb: string }> = {
  "@theme": { icon: ALIAS_ICON, verb: ALIAS_VERB },
  ".dark": { icon: ALIAS_ICON, verb: ALIAS_VERB },
};

const ROW_READINGS: Record<string, { icon: string; verb: string }> = {
  ...BASE_ROW_READINGS,
  ...PALETTE_ROW_READINGS,
};

/** Fail loudly on a reading this table has no expectation for, rather than
 *  inventing one. Returns the entry so the call site stays an expression. */
const pinnedReading = <T>(table: Record<string, T>, name: string, what: string): T => {
  const found = table[name];
  if (found === undefined) {
    throw new Error(
      `${name} has no pinned ${what} reading in this file. Stating an expectation for a new Palette is the palette's job — defaulting it would grade the reading against a value it does not carry.`,
    );
  }
  return found;
};

/** Non-vacuity of the tables: every layer the cascade produces must be pinned, and
 *  every pinned name must be a real layer. Both directions, so the table can be
 *  neither short (a palette graded against nothing) nor stale (an entry naming a
 *  layer that no longer exists). Asserted in the suite below, not here. */
const unpinnedLayers = (table: Record<string, unknown>): string[] =>
  ALL_LAYERS.map((l) => l.name).filter((name) => table[name] === undefined);
const staleTableEntries = (table: Record<string, unknown>): string[] => {
  const live = new Set(ALL_LAYERS.map((l) => l.name));
  return Object.keys(table).filter((name) => !live.has(name));
};


const LAYER_NAMES = ALL_LAYERS.map((l) => l.name);

/** The three `TRANSCRIPT_ROW` consumers the family repaints. One list, so the
 *  "carries both utilities" gate and the "kept its other muted spans" gate
 *  cannot drift to cover different sets of files. */
const ROW_CONSUMER_FILES = [
  "src/components/ToolCallCardHeader.tsx",
  "src/components/ChangesGroupCard.tsx",
  "src/components/Reasoning.tsx",
];

describe("the row token family (--color-row-icon / --color-row-verb, ADR 0062)", () => {
  it.each(LAYER_NAMES)("%s declares both row tokens", (name) => {
    // Rule (1). A palette that forgets one silently inherits `@theme`'s grey,
    // so this fails only if the message can name the layer — hence `it.each`.
    const tokens = ALL_LAYERS.find((l) => l.name === name)!.tokens;
    expect(tokens[ROW_ICON], `${ROW_ICON} missing from ${name}`).toBeTruthy();
    expect(tokens[ROW_VERB], `${ROW_VERB} missing from ${name}`).toBeTruthy();
  });

  it.each(LAYER_NAMES)("%s carries exactly the ADR's reading for both tokens", (name) => {
    // Rules (2) and (3) in one table: the alias layers must read `var()`, and
    // Dracula must read its two spec hexes. Comparing the whole value (not just
    // "contains `var(`") is what stops a re-anchor onto a different token — e.g.
    // aliasing the icon to `--color-warning`, which is the "cleanup" ADR 0062
    // says must fail by name.
    const tokens = ALL_LAYERS.find((l) => l.name === name)!.tokens;
    expect(tokens[ROW_ICON]?.toLowerCase(), `${ROW_ICON} in ${name}`).toBe(
      pinnedReading(ROW_READINGS, name, "row").icon,
    );
    expect(tokens[ROW_VERB]?.toLowerCase(), `${ROW_VERB} in ${name}`).toBe(
      pinnedReading(ROW_READINGS, name, "row").verb,
    );
  });

  it("aliases in every non-hex layer, so a palette can re-hue without touching a component", () => {
    // The point of the family, asserted as a COUNT and not only per layer: if
    // somebody replaces the aliases with literals, the per-layer table above
    // would be edited along with it and stay green, whereas "the layers that
    // state a hex are exactly the layers PINNED to a hex" is the structural claim
    // ADR 0062 rests on.
    //
    // The set is DERIVED rather than spelled out, and that is not a loosening:
    // the per-layer test above already pins every layer's value exactly, so
    // naming four aliases here added nothing except a fifth place to edit. What
    // the gate actually protects is that stating a hex is a DELIBERATE ACT, and
    // that is now enforced upstream — a reading with no entry in
    // `PALETTE_ROW_READINGS` throws instead of defaulting, so a new Palette cannot
    // state a row hex (or inherit one) without someone writing the decision down.
    const aliased = ALL_LAYERS.filter((l) =>
      (l.tokens[ROW_ICON] ?? "").startsWith("var(--color-foreground-subtle)"),
    );
    const literal = ALL_LAYERS.filter((l) => /^#[0-9a-f]{6}$/i.test(l.tokens[ROW_ICON] ?? ""));
    // Every layer is one or the other — a third shape (a literal that is not a
    // plain hex, a `var()` into something else) must not slip through uncounted.
    expect(
      [...aliased, ...literal].map((l) => l.name).sort(),
      "a layer carries neither the alias nor a plain hex as --color-row-icon",
    ).toEqual(LAYER_NAMES.slice().sort());
    expect(
      literal.map((l) => l.name).sort(),
      "the layers that state a literal row hex are not the layers pinned to one",
    ).toEqual(
      Object.entries(ROW_READINGS)
        .filter(([, reading]) => /^#[0-9a-f]{6}$/i.test(reading.icon))
        .map(([name]) => name)
        .sort(),
    );
    // THE COUNT, pinned. This is the assertion the original test carried as
    // `toEqual([".theme-dracula-dark"])` — "exactly ONE layer states a hex" — kept
    // as a number rather than a palette name so the list stops being a fourth copy
    // of the registry, while still failing the day a second palette states its own
    // row hex. Which palette that one is stays pinned BY NAME in the per-layer
    // value gate above, so nothing is lost: adding a hex-reading palette requires
    // editing both the pin table and this number, exactly as it required editing
    // both before.
    expect(
      literal.length,
      `${literal.length} layers state a literal --color-row-icon (${literal.map((l) => l.name).join(", ")}); ADR 0062 ships exactly one`,
    ).toBe(1);
    // And the BASE layers — the contract every palette inherits — alias, always.
    // This half is palette-independent and stays exact: if `@theme` or `.dark`
    // ever carries a literal, every reading that intends to inherit one freezes.
    expect(
      literal.filter((l) => (BASE_LAYERS as readonly string[]).includes(l.name)).map((l) => l.name),
      "a base layer states a literal row hex instead of the alias",
    ).toEqual([]);
    expect(aliased.length).toBe(LAYER_NAMES.length - 1);
  });

  it("pins a row and film reading for every layer, and none for a layer that is gone", () => {
    // Non-vacuity of the PIN TABLES now that the layer list is derived. The old
    // five-entry tables could not go stale because the old layer list was written
    // beside them; with a derived list, a table that no longer covers every layer
    // would silently drop that layer out of the value gate — the exact shape of
    // the bug this task retires, arriving from the other direction. So both
    // directions are checked: nothing unpinned, nothing stale.
    for (const [what, table] of [
      ["row", ROW_READINGS],
      ["film glyph", FILM_READINGS],
    ] as const) {
      expect(unpinnedLayers(table), `${what}: layers with no pinned reading`).toEqual([]);
      expect(staleTableEntries(table), `${what}: pinned readings for layers that no longer exist`).toEqual([]);
    }
    // The layer list itself is the registry's, not a list this file maintains:
    // the two base layers plus every reading `themeClassNames()` can produce.
    expect(LAYER_NAMES).toEqual([
      ...BASE_LAYERS,
      ...themeClassNames().map(selectorFor),
    ]);
    expect(
      LAYER_NAMES.filter((name) => name.startsWith(".theme-")).sort(),
      "the palette layers are not exactly the readings the registry offers",
    ).toEqual(themeClassNames().map(selectorFor).sort());
  });


  it("keeps the three TRANSCRIPT_ROW consumers reading the tokens, not the greys", () => {
    // The repaint is half the change: a token declared five times and consumed
    // by nothing is the exact mistake this task deletes the old family for. So
    // each of the three components is required to carry BOTH utilities on the
    // glyph and the verb, and to have DROPPED the old muted utility there.
    //
    // READ FROM THE COMMENT-STRIPPED SOURCE, the same treatment the utility count
    // below gets and for the same documented reason: these components explain
    // their own class choices in block comments that NAME `text-row-verb` and
    // `animated-gradient-text`, so a raw read is satisfied by PROSE after the
    // class has been deleted from the markup. Verified by mutation: deleting the
    // verb from the verb expression left this gate green on the raw read, which is
    // the landmine shape `src/lib/skills.test.ts:16-24` warns about — a gate that
    // passes for a reason unrelated to what ships.
    for (const file of ROW_CONSUMER_FILES) {
      const source = stripJsComments(readTextFile(file));
      expect(source, `${file} must colour its glyph with text-row-icon`).toContain(
        "text-row-icon",
      );
      expect(source, `${file} must colour its verb with text-row-verb`).toContain(
        "text-row-verb",
      );
    }
    // And the pending call keeps the shimmer: `--color-row-verb` is the SETTLED
    // reading (ADR 0062's consequence), so the conditional must survive a
    // "simplify the verb to one colour" refactor.
    //
    // ASSERTED STRUCTURALLY, NOT POSITIONALLY. This used to be
    // `/status === "pending"[\s\S]{0,120}text-row-verb/` — a 120-byte window that
    // pinned the pairing by BYTE PROXIMITY. That is a claim about where two
    // strings sit in a file, so it broke on a JSX re-ordering, a wrapped line, or
    // an extracted class helper that put the condition and the class on opposite
    // sides of a component, while the shipped behaviour was unchanged. The three
    // presence assertions below carry the same guarantee in the shape the
    // invariant actually has: the file reads the pending state, it uses the
    // settled verb token, and it keeps the shimmer class the pending branch
    // paints.
    //
    // What the window could see and these cannot is that the three are wired to
    // EACH OTHER by adjacency — so that half is pinned where it is OBSERVABLE, by
    // the render tests that already own it: `ToolCallCard.test.tsx`'s "shows the
    // running verb with the shimmer while pending" and "colours the SETTLED verb
    // with the row token, and the pending one not at all" both grade the rendered
    // verb's class list per status, and both were confirmed by mutation to fail
    // when the shimmer or the token is removed from the expression. A source grep
    // was never the stronger check for a per-status class (same reasoning that
    // retired this file's sibling pin in `src/lib/skills.test.ts:16-24`).
    const header = stripJsComments(readTextFile("src/components/ToolCallCardHeader.tsx"));
    expect(header).toContain("animated-gradient-text");
    expect(header).toContain('status === "pending"');
    expect(header).toContain("text-row-verb");
  });

  it("leaves the row's OTHER muted spans on the foreground utilities", () => {
    // The repaint touches a glyph and a verb and nothing else. Each row also
    // carries separators, durations, counts and ranges that are de-emphasis
    // TEXT, not row decoration — repainting those would make a timestamp the
    // same cyan as the verb. Pinned by COUNTING the `text-foreground-subtle*`
    // utilities that survive, so deleting one (rather than retargeting it) fails.
    //
    // COUNTED AS A TOTAL ACROSS THE THREE FILES, not per file — and that is a
    // deliberate change of scope, not a loosening. The invariant this gate owns
    // is "de-emphasis TEXT utilities were not deleted by the row repaint". That
    // is a TOTAL. Where the total is DISTRIBUTED across files is a property of
    // the file layout, and the file layout is exactly what this program's Phase
    // C is going to change: the byte-identical hover chevron in
    // `ToolCallCardHeader.tsx` and `ChangesGroupCard.tsx` is scheduled to become
    // one shared child component, and moving a muted span into that child
    // changes two per-file counts while deleting nothing. A per-file count here
    // would therefore redden an extraction for the crime of existing — the same
    // landmine `src/lib/skills.test.ts:16-24` records retiring a source-reading
    // pin over, and the reason the count moved to the union.
    //
    // What is kept, and why the gate still has force: the number is still
    // EXACT (not `>=`), so deleting one utility anywhere in the three files
    // fails it by the same margin it used to, and the failure message still
    // names the repaint. What is lost is only the ability to say WHICH file
    // lost it — a worse error message, deliberately traded for the ability to
    // refactor. (A retarget, i.e. swapping a muted span onto `text-row-icon`,
    // fails here too: the total drops.)
    //
    // Vacuity guard: a `reduce` over an empty file list is a `0` that would
    // fail the total for the wrong reason — the message would read "a row
    // repaint took the glyph and the verb" when in fact the file list was
    // emptied. Pin the input first.
    expect(ROW_CONSUMER_FILES, "the row consumer list was emptied").toHaveLength(3);
    const total = ROW_CONSUMER_FILES.reduce(
      (n, file) =>
        // COMMENTS STRIPPED FIRST, for the same reason the CSS tests do it: a
        // doc-comment that NAMES a utility is prose, not a consumer, and counting
        // it would make an explanatory comment fail a gate about the rendered
        // classes. (This file's own comment about the `Thought` glyph is exactly
        // that case, and it did fail this assertion until the strip went in.)
        n +
        ((stripJsComments(readTextFile(file)).match(
          /text-foreground-subtle(?:st)?\b/g,
        )) ?? []).length,
      0,
    );
    // 5 (`ToolCallCardHeader`: the range, command and summary spans, the
    // copy-button icon, the hover chevron) + 4 (`ChangesGroupCard`:
    // filesCountLabel, one separator, the pending chip, the hover chevron) + 9
    // (`Reasoning`: the separators, the two duration spans, the summary
    // separator, the streaming summary, the chevron, the two body-copy spans).
    // Re-measured from the reader on 2026-10-22.
    expect(
      total,
      `the three row files should still carry 18 de-emphasis text utilities between them (found ${total}) — a row repaint takes the glyph and the verb only`,
    ).toBe(18);
  });

  it("declares no dead row-kind token, in any layer", () => {
    // Rule (4), the CSS half. Checked against EVERY block body rather than the
    // raw stylesheet so a leftover in a layer the parser does not read cannot
    // hide, and checked as a regex over the parsed key set rather than as "the
    // five known names are absent" — the family had five members today and a
    // sixth could be invented tomorrow; the prefix catches either.
    for (const layer of ALL_LAYERS) {
      const dead = Object.keys(layer.tokens).filter((n) =>
        n.includes(DEAD_ROW_KIND_PREFIX),
      );
      expect(dead, `${layer.name} still declares the dead family`).toEqual([]);
    }
    // And in EVERY CSS FILE on disk, comment-stripped: a declaration parked
    // outside the graded blocks (a `:root`, a stray media query) would escape the
    // loop above entirely. This used to sweep the RESOLVED stylesheet; it now
    // sweeps the files themselves, which is strictly stronger — the resolved sheet
    // contains only the `@import`s that exist, so a Palette CSS file that had not
    // been imported yet could carry the dead family and stay invisible here, and a
    // Wave-3 Palette's file would have to be skipped until its import landed. A
    // directory sweep grades the file the moment it exists.
    const cssFiles = textFilesUnder("src").filter((f) => f.endsWith(".css"));
    expect(cssFiles.length, "the CSS sweep found no files to read").toBeGreaterThan(0);
    expect(
      cssFiles.flatMap((cssFile) =>
        [
          ...stripComments(readListedFile(cssFile)).matchAll(
            new RegExp(`--[\\w-]*${DEAD_ROW_KIND_PREFIX}[\\w-]*\\s*:`, "g"),
          ),
        ].map((m) => `${m[0]} in ${cssFile}`),
      ),
      "a dead row-kind declaration survives outside the graded layers",
    ).toEqual([]);
  });

  it("names the dead family in no file under src/", () => {
    // Rule (4), the source half. The CSS gate above cannot see a test list that
    // still carries the old names — which is exactly how the family stayed
    // "alive" in the first place (a completeness list was its only consumer).
    // So the sweep is over every text file under `src/`, and it is a PREFIX
    // sweep, so re-adding one name to a list fails it too.
    const hits = deadFamilyHitsIn(textFilesUnder("src"));
    expect(hits, `dead row-kind family still named in: ${hits.join(", ")}`).toEqual([]);
  });


  it("is non-vacuous: the sweep can read files, and the detector detects", () => {
    // A gate over an empty file list, or over a detector that matches nothing, is
    // indistinguishable from a clean tree. So pin the machinery rather than the
    // conclusion: the walk finds real files, the detector fires on a planted name
    // and stays quiet on a live one, and THIS file — the one that would most
    // naturally re-introduce the word while documenting its removal — really is
    // word-free because the prefix is constructed.
    const namesTheDeadFamily = (text: string): boolean =>
      text.includes(DEAD_ROW_KIND_PREFIX);
    const files = textFilesUnder("src");
    expect(files.length, "the sweep found almost nothing to read").toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("themeTokens.test.ts"))).toBe(true);
    expect(namesTheDeadFamily(`--color-${DEAD_ROW_KIND_PREFIX}-user: #2563eb;`)).toBe(true);
    expect(namesTheDeadFamily("--color-row-icon: #ffb86c;")).toBe(false);
    expect(
      namesTheDeadFamily(readTextFile("src/lib/themeTokens.test.ts")),
      "this file must not contain the word it gates on, or its own sweep cannot pass",
    ).toBe(false);
    // And the comment-stripper's known blind spot is measured, not assumed: it
    // drops BLOCK comments and whole-line `//` comments but NOT a trailing
    // `// note` (telling one from a `"https://…"` string needs a parser this
    // repo does not ship). That gap is only safe while no trailing comment in
    // the three row components names a utility, so look for exactly that: strip
    // the block comments the stripper already handles, then ask whether any
    // remaining line still carries a utility name to the right of a `//`. If it
    // ever does, the blind spot has started to matter and this names the file.
    const UTILITY = /text-foreground-subtle(?:st)?\b/;
    for (const file of ROW_CONSUMER_FILES) {
      const offenders = stripJsComments(readTextFile(file))
        .split("\n")
        .filter((line) => {
          const at = line.indexOf("//");
          return at >= 0 && UTILITY.test(line.slice(at));
        });
      expect(
        offenders,
        `${file}: a trailing // comment names a text utility, which stripJsComments cannot see — the count gate would then be reading prose as a consumer`,
      ).toEqual([]);
    }
  });

  it("documents Dracula's two accepted collisions instead of gating them away", () => {
    // The asymmetry rule (3) describes, pinned as a measurement so the comment
    // cannot rot. `#ffb86c` is THIS palette's own `--color-warning`, and
    // `#8be9fd` is what `--color-interaction-ask-foreground` already carried.
    // Both are therefore collisions with tokens that live in `MEANINGFUL_TOKENS`
    // — which is precisely why the gate above pins VALUES and this test asserts
    // the collisions EXIST rather than forbidding them.
    expect(DRACULA[ROW_ICON]).toBe(DRACULA["color-warning"]);
    expect(DRACULA[ROW_VERB]).toBe(DRACULA["color-interaction-ask-foreground"]);
    expect(MEANINGFUL_TOKENS).toContain("color-interaction-ask-foreground");
    // And they are spec-published values, which is why the spec gate in
    // `paletteCompleteness.test.ts` needs no new allow-list entry.
    for (const hex of [DRACULA[ROW_ICON]!, DRACULA[ROW_VERB]!]) {
      expect(hex.toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("the sweep survives a file that vanishes between listing and reading", () => {
  // THE SKIP BRANCH, DRIVEN ON PURPOSE — not a race attempt. This file sweeps
  // `src/` twice while the live palette guard in `paletteCompleteness.test.ts` is
  // writing `src/lib/palettes/guardprobe.ts` + `src/styles/guardprobe.css` and
  // deleting them from ANOTHER worker's `finally`, so both sweeps can name a path
  // that is gone by the time it is opened. The collision needs full-suite
  // scheduling to reproduce, so this hands the REAL census a listing it controls
  // and deletes one path from under it. `.tmp/` is gitignored and outside `src/`,
  // so a probe cannot become a fake source file in the tree these gates grade.
  const probe = ".tmp/themeTokensSweep";
  /** A dead row-kind declaration, BUILT FROM THE PREFIX CONSTANT — the reason the
   *  prefix is constructed in the first place. A probe that spelled the word would
   *  make this file name the family its own sweep forbids. */
  const deadDeclaration = (): string =>
    `:root { --color-${DEAD_ROW_KIND_PREFIX}-user: #2563eb; }\n`;

  it("skips a listed file that disappears mid-sweep, and records it", () => {
    fs.mkdirSync(probe, { recursive: true });
    const real = `${probe}/real.css`;
    const doomed = `${probe}/doomed.css`;
    fs.writeFileSync(real, deadDeclaration());
    fs.writeFileSync(doomed, deadDeclaration());
    sweep.resetSkipped();
    try {
      // Pass 1: both exist, both are convicted. Without this, pass 2's empty
      // result would be indistinguishable from a census that reads nothing — the
      // vacuity trap this file's own non-vacuity test exists to prevent.
      expect(deadFamilyHitsIn([real, doomed])).toEqual([real, doomed]);
      expect(sweep.skipped(), "nothing has vanished yet").toEqual([]);

      // Pass 2: the file is gone, the SAME listing is swept again.
      fs.rmSync(`${probe}/doomed.css`, { force: true });
      expect(
        deadFamilyHitsIn([real, doomed]),
        "the vanished file is gone (it does not exist); the real one is still a hit",
      ).toEqual([real]);
      expect(sweep.skipped(), "the skip is recorded, never silent").toEqual([
        { file: doomed, code: "ENOENT" },
      ]);
    } finally {
      fs.rmSync(probe, { force: true, recursive: true });
      sweep.resetSkipped();
    }
  });

  it("reads a listed file that is PRESENT, so a leaked artifact is still caught", () => {
    // A `guardprobe.css` LEFT behind by a killed run is PRESENT, so the sweep
    // opens it. Tolerating a vanishing path must not become tolerating a stray one.
    fs.mkdirSync(probe, { recursive: true });
    const leaked = `${probe}/leaked.css`;
    fs.writeFileSync(leaked, deadDeclaration());
    sweep.resetSkipped();
    try {
      expect(deadFamilyHitsIn([leaked])).toEqual([leaked]);
      expect(sweep.skipped(), "a present file is never skipped").toEqual([]);
    } finally {
      fs.rmSync(leaked, { force: true });
      fs.rmSync(probe, { force: true, recursive: true });
    }
  });

  it("a NAMED path that is missing still throws (tolerance does not leak to literals)", () => {
    // `ROW_CONSUMER_FILES`, the two base layers and every spec `cssFile` are named
    // by literals or by the registry. If the sweep went tolerant of those, the
    // "three consumers still carry the tokens" gate would pass on a tree where the
    // components had been deleted.
    expect(() => sweep.named("src/lib/not-a-real-module.ts")).toThrow(/ENOENT|no such file/);
    expect(sweep.named("src/components/ToolCallCardHeader.tsx")).toContain("className");
  });
});

/**
 * `--color-film-glyph` — the colour the Transcript's empty-state FILM paints its
 * glyphs with (ADR 0071). The film's brightness IS its data: luminance picks
 * both the glyph and its intensity, so the token must be OPAQUE. This is the
 * gate ADR 0071's second Consequence asks for, in the shape of the row-family
 * gate above: a palette that omits the token fails BY NAME instead of silently
 * inheriting a grey, and a palette that re-anchors it onto a text token fails
 * the same way.
 */
const FILM_GLYPH = "color-film-glyph";
const FILM_LIGHT = "var(--color-neutral-500)";
const FILM_DARK = "var(--color-neutral-400)";

/**
 * Per-layer readings, pinned BY VALUE for the same reason `ROW_READINGS` is:
 *  "contains `var(`" would still pass if somebody aliased the glyph onto
 *  `--color-foreground-subtlest`, which is the exact trap ADR 0071 exists to
 *  avoid — that token carries alpha 0.4, and the film cannot afford a second
 *  dimmer. `.theme-default-light` / `.theme-default-dark` alias to the `@theme` /
 *  `.dark` readings (the row family does exactly this) so every default surface
 *  renders byte-identically; `.theme-dracula-dark` is the only layer with its own
 *  value today.
 *
 *  Split base/palette and REQUIRED FOR EVERY READING, for the reason stated on
 *  `PALETTE_ROW_READINGS`: a new Palette gets no default here. It must state
 *  whether it aliases or carries its own glyph colour, and until it does, this
 *  file throws rather than grading it against a value it does not carry.
 */
const FILM_BASE_READINGS: Record<string, string> = {
  "@theme": FILM_LIGHT,
  ".dark": FILM_DARK,
};

const FILM_PALETTE_READINGS: Record<string, string> = {
  ".theme-default-light": FILM_LIGHT,
  ".theme-default-dark": FILM_DARK,
  ".theme-dracula-dark": "#6272a4",
  // Everforest's own `grey0`, in each reading — the scheme's quietest published
  // foreground step ("Comments, Punctuation Delimiters, Closed Folds,
  // Ignored/Disabled"). Taken as a literal rather than an alias for the reason
  // ADR 0071 was written for: the film's luminance bands are the ONLY dimmer, so
  // the glyph must be a fixed opaque value per reading, and `foreground-subtlest`
  // (which is what an alias would land on) is grey1/grey1 — a step brighter than
  // the scheme's own comment colour. Both hexes are opaque, which the gate below
  // grades directly.
  ".theme-everforest-dark": "#7a8478",
  ".theme-everforest-light": "#a6b0a0",
  // The four Wave-3 Palettes each state their OWN opaque glyph hex per reading,
  // read off the CSS (`grep -B3` over `--color-film-glyph` in each file, so the
  // block it sits in and the comment naming its source both came with it) rather
  // than inferred — one Rosé Pine pair (`#908caa` / `#9893a5`) differs only in the
  // last two digits, so an inferred value would be indistinguishable from a wrong
  // one. Each CSS comment names the scheme step it took, and all eight are opaque,
  // which is ADR 0071's actual rule (a fixed per-reading value, because the film's
  // luminance bands are its only dimmer):
  //   catppuccin  Overlay 1 in both readings (Mocha's / Latte's quiet grey)
  //   ayu         `palette.gray.l5` dark, `gray.l1` light (the darkest published
  //               grey that clears the 3:1 glyph floor on the light page)
  //   rose-pine   `subtle` dark, `muted` light
  //   kanagawa    `sumiInk6` dark, `lotusViolet1` light — the scheme's own
  //               `ui.nontext` / `ui.whitespace`, its "drawn but not read" ink
  ".theme-catppuccin-dark": "#7f849c",
  ".theme-catppuccin-light": "#8c8fa1",
  ".theme-ayu-dark": "#667381",
  ".theme-ayu-light": "#86878c",
  ".theme-rose-pine-dark": "#908caa",
  ".theme-rose-pine-light": "#9893a5",
  ".theme-kanagawa-dark": "#54546d",
  ".theme-kanagawa-light": "#a09cac",
};

const FILM_READINGS: Record<string, string> = {
  ...FILM_BASE_READINGS,
  ...FILM_PALETTE_READINGS,
};


describe("the film token (--color-film-glyph, ADR 0071)", () => {
  it.each(LAYER_NAMES)("%s declares the film glyph token", (name) => {
    // All layers — `it.each` over `LAYER_NAMES`, so a Palette that ships a reading
    // and forgets this token fails by name, and the failure names the layer that
    // dropped it. The consequence of an omission is silent: the film inherits
    // `@theme`'s light-grey reading onto whatever pane that Palette paints.
    const tokens = ALL_LAYERS.find((l) => l.name === name)!.tokens;
    expect(tokens[FILM_GLYPH], `${FILM_GLYPH} missing from ${name}`).toBeTruthy();
  });

  it.each(LAYER_NAMES)("%s carries exactly the ADR's reading for the film glyph", (name) => {
    // The WHOLE value, not `contains("var(")`: that is what stops a re-anchor
    // onto a different token — ADR 0071 rejected `--color-foreground-subtlest`
    // because its alpha multiplies with the film's own luminance bands.
    const tokens = ALL_LAYERS.find((l) => l.name === name)!.tokens;
    expect(tokens[FILM_GLYPH]?.toLowerCase(), `${FILM_GLYPH} in ${name}`).toBe(
      pinnedReading(FILM_READINGS, name, "film glyph"),
    );
  });

  it("keeps the token opaque in every layer, because the luminance bands are the only dimmer", () => {
    // The one property ADR 0071 was written to protect, asserted directly so it
    // cannot be reintroduced by a value that LOOKS right. `color-mix(… transparent)`
    // or an `/ alpha` suffix would stack a second multiplicative dimmer on a
    // glyph whose brightness is already the data, flattening the whole dynamic
    // range into the bottom few percent.
    for (const layer of ALL_LAYERS) {
      const value = layer.tokens[FILM_GLYPH] ?? "";
      // Assert presence FIRST: `not.toMatch` passes on `""`, so a token that is
      // simply missing would otherwise make this gate green for the wrong reason.
      expect(value, `${FILM_GLYPH} missing from ${layer.name}`).toBeTruthy();
      expect(value, `${FILM_GLYPH} in ${layer.name} must not carry alpha`).not.toMatch(
        /transparent|\/\s*[\d.]+\s*%?/,
      );
    }
  });
});

