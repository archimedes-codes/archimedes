/**
 * The palette test kit: every helper the palette gates share, plus the
 * per-Palette grading entry point.
 *
 * WHY IT WAS EXTRACTED. Four gate files each carried their OWN copy of `block()`,
 * the declaration parser and the luminance maths, and the copies had already
 * diverged in the direction that matters: `fileIconContrast.test.ts` resolves
 * `#rgba`, `#rrggbbaa`, `rgb()`, a single-colour `color-mix()` and one hop of
 * `var()`, while `paletteCompleteness.test.ts`'s `composite()` parsed ONLY
 * `color-mix(in oklab, #rrggbb N%, transparent)` and a bare `#rrggbb` and *threw*
 * on an 8-digit hex. Two resolvers means two answers for one token, and the
 * divergence is silent: a value one parser cannot read does not fail, it
 * disappears from the map, and the token is then graded against a surface it
 * never paints on — the exact failure `fileIconContrast.test.ts`'s own
 * doc-comment says it exists to catch. So there is now ONE resolver (decision 7:
 * the MERGE, not an extraction of either one) and ONE copy of the brace-counting
 * reader.
 *
 * NODE, AND THE COMPUTED SPECIFIER. This module reads the filesystem, so it is a
 * TEST module and must never enter the shipped graph. It reaches `node:fs`
 * through a computed specifier — an untyped `any` import `tsc` accepts without the
 * Node type packages, because the app deliberately ships no `@types/node`.
 * `cssSource.ts` and `paletteCompleteness.test.ts` already use the trick for the
 * same reason.
 *
 * WHY THE PER-PALLETTE GATES READ A PALETTE'S OWN FILE AND NOT THE RESOLVED
 * STYLESHEET. `block()` throws `no <selector> block` when a selector is absent
 * from the text it was given, and `readResolvedIndexCss()` inlines only the
 * `@import`s that exist. A gate reading the resolved stylesheet would therefore
 * THROW for a Palette whose `@import` has not landed yet — so either that
 * Palette's author gets a red shared suite, or the gate has to skip un-imported
 * Palettes, which makes every check here vacuous for exactly the Palettes it
 * exists to grade. Reading `spec.cssFile` removes the dependency: the grading is
 * real before the import exists. The WIRING gates (import present, picker offers
 * it, classes toggled, Shiki ids loaded) are the ones that legitimately care about
 * the import, and they enumerate the REGISTRY instead — see
 * `paletteCompleteness.test.ts`.
 */

import { createSourceSweep, type VanishedPath } from "./sourceSweep";
import type { FloorRule, PaletteMode, PaletteSpec } from "./paletteSpec";

const NODE_FS = "node:" + "fs";
const { readFileSync, readdirSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (path: string, options?: { recursive?: boolean; encoding?: string }) => string[];
};

const NODE_URL = "node:" + "url";
const { pathToFileURL } = (await import(NODE_URL)) as {
  pathToFileURL: (path: string) => URL;
};

/** Where the per-Palette grading rows live, relative to the repo root (the cwd
 *  every test here runs in). */
const SPEC_DIR = "src/lib/palettes";

/** The Default palette's id, spelled here rather than imported from the registry
 *  so the kit does not depend on app runtime state for its reference set. It
 *  matches `DEFAULT_PALETTE_ID`, and `paletteCompleteness.test.ts` asserts the
 *  registry really does carry it. */
const DEFAULT_ID = "default";

/** A CSS file's raw text, comments KEPT (each caller strips per use, exactly as
 *  it did when every gate read the resolved `index.css`). Throws with the path, so
 *  a missing file reads as "this Palette has no CSS yet" rather than as a block
 *  with zero tokens in it. */
export const readCssFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `${path} cannot be read — a Palette spec must name a CSS file it owns`,
    );
  }
};

/** Remove every CSS comment. Selectors and values are matched only after this,
 *  because a rule's selector can be named in PROSE (`.dark`, `@theme` and every
 *  `.theme-*` block are discussed in comments long before any block opens), and a
 *  declaration that is COMMENTED OUT still matches a declaration regex — a comment
 *  parsed as a block yields zero tokens, which makes an absence assertion pass for
 *  the wrong reason. */
export const stripComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The four text-bound readers, bound to one stylesheet text. Returned as a
 * factory rather than as free functions taking `css` first, so every gate file
 * keeps calling `block(/^\.dark\s*\{/m)` exactly as it always did — the move
 * deleted duplicates, it did not rewrite call sites.
 *
 * `block` runs on the text AS GIVEN (raw where the caller kept comments, stripped
 * where it stripped them) because a byte-offset assertion needs the raw text and
 * an absence assertion needs the stripped one. `indexOfBlock` strips FIRST so an
 * offset can never land on a selector named in prose; relative order — the only
 * thing the cascade depends on — survives the strip, which is what makes that
 * safe.
 */
export const cssReader = (text: string) => {
  const code = stripComments(text);

  /**
   * Extract a rule's body by COUNTING BRACE DEPTH, with the SELECTOR ANCHORED AT
   * LINE START. Two real traps this avoids:
   *
   * (1) A `\n}` "end of block" heuristic truncates at the FIRST nested block, so
   *     the tail of the rule is never examined — an absence assertion then passes
   *     for the WRONG REASON (the token looked undeclared because it was unread).
   * (2) A bare `/\.dark\b/` matches the stylesheet's PROSE, and a comment parsed
   *     as a block yields zero tokens, which makes an absence assertion fail OPEN.
   */
  const block = (selector: RegExp): string => {
    const head = text.match(selector);
    if (!head || head.index === undefined) throw new Error(`no ${selector} block`);
    const open = text.indexOf("{", head.index);
    if (open < 0) throw new Error(`no opening brace for ${selector}`);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    throw new Error(`unbalanced braces after ${selector}`);
  };

  /** Custom-property NAMES a block declares, comments removed first — a
   *  doc-comment that spells a token out (`--color-x` in prose) must not be
   *  mistaken for a declaration of it. */
  const declared = (body: string): Set<string> =>
    new Set(
      [...stripComments(body).matchAll(/--([a-z][a-z0-9-]*)\s*:\s*[^;]+;/g)].map(
        (m) => m[1]!,
      ),
    );

  /** A block's declarations as `name -> value`, comments stripped first so a
   *  doc-comment that quotes a value cannot be mistaken for a declaration. */
  const values = (body: string): Record<string, string> =>
    Object.fromEntries(
      [...stripComments(body).matchAll(/--([a-z][a-z0-9-]*)\s*:\s*([^;]+);/g)].map(
        (m) => [m[1]!, m[2]!.trim()],
      ),
    );

  /** Byte offset of a rule's head in the COMMENT-STRIPPED stylesheet. */
  const indexOfBlock = (selector: RegExp): number => {
    const where = code.search(selector);
    if (where < 0) throw new Error(`no ${selector} block in the stylesheet`);
    return where;
  };

  return { text, code, block, declared, values, indexOfBlock };
};

/** Names in `a` that are not in `b`, sorted. */
export const diff = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((n) => !b.has(n)).sort();

const parseHex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb: readonly number[]): string =>
  "#" +
  rgb
    .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0"))
    .join("");
/** Composite `color` (alpha `a`, 0–1) over an OPAQUE `bg`, per channel. */
const over = (
  color: readonly number[],
  a: number,
  bg: readonly number[],
): number[] => color.map((c, i) => a * c + (1 - a) * bg[i]!);

/** sRGB relative luminance of `#rrggbb` (WCAG 2.x's definition). */
export const lumOf = (hex: string): number => {
  const [r, g, b] = parseHex(hex);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
};

/** WCAG contrast ratio between two OPAQUE `#rrggbb` colours. */
export const contrast = (a: string, b: string): number => {
  const [x, y] = [lumOf(a), lumOf(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

/**
 * THE resolver: reduce a declaration's raw value to the OPAQUE hex that actually
 * paints, on `bg`.
 *
 * This is `fileIconContrast.test.ts`'s `resolveToHex` MERGED with
 * `paletteCompleteness.test.ts`'s `composite` (decision 7), and the merge is the
 * point. `composite` handled only `color-mix(in oklab, #rrggbb N%, transparent)`
 * and a bare `#rrggbb`, and THREW on an 8-digit hex — so three of the five
 * Palettes this plan adds (Ayu's translucent foregrounds, Rosé Pine's
 * `#6e6a8633`, Everforest's `#475258c0`) could not be graded by the gate that
 * grades text contrast. `resolveToHex` already covered `#rgba`, `#rrggbbaa`,
 * `rgb()`/`rgba()`, a single-colour `color-mix` and one hop of `var()`; what it
 * lacked was `composite`'s discipline of compositing a translucent value over the
 * surface it paints on rather than reading it raw. Both halves are here now.
 *
 * Anything it cannot reduce THROWS with the token name. That is deliberate: a
 * value that silently vanished from the map used to be graded on a fallback
 * surface, which is how a descriptor passed a contrast gate it never sat on.
 */
export const resolveToHex = (
  name: string,
  raw: string,
  map: Record<string, string>,
  bg: string,
  seen: ReadonlySet<string> = new Set(),
): string => {
  const v = raw.trim();
  const fail = (): never => {
    throw new Error(
      `cannot resolve --color-${name} to an opaque colour: "${v}" — the token would be ` +
        `graded on a surface it does not paint, which is the failure this kit exists to catch`,
    );
  };
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  const bgRgb = parseHex(bg);
  // #rrggbbaa — the case `composite` threw on.
  const hex8 = v.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/);
  if (hex8) {
    const a = parseInt(hex8[2]!, 16) / 255;
    // The `#` goes back ON before parsing: `parseHex` slices at 1, so handing it
    // a bare capture group silently drops the TOP NIBBLE (`#ff0000` read as
    // `#f0000` = `#0f0000`). `fileIconContrast.test.ts` shipped exactly this and
    // it is why an 8-digit descriptor composited to the wrong colour there — the
    // mutation test in `paletteTestKit.test.ts` is what caught it.
    return toHex(over(parseHex(`#${hex8[1]!}`), a, bgRgb));
  }
  // #rgba
  const hex4 = v.match(/^#([0-9a-fA-F]{3})([0-9a-fA-F])$/);
  if (hex4) {
    const expanded = "#" + [...hex4[1]!].map((c) => c + c).join("");
    const a = parseInt(hex4[2]! + hex4[2]!, 16) / 255;
    return toHex(over(parseHex(expanded), a, bgRgb));
  }
  const rgba = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) {
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return toHex(over([Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], a, bgRgb));
  }
  // var(--x): ONE hop through the map — the cascade the browser resolves. A
  // second hop is a palette that has stopped being readable from its own block,
  // and it is reported rather than followed.
  const ref = v.match(/^var\(--color-([a-z0-9-]+)\)$/);
  if (ref) {
    const target = `color-${ref[1]!}`;
    if (seen.has(target)) {
      throw new Error(`--color-${name} has a cyclic var() reference at --${target}`);
    }
    const next = map[target];
    if (next === undefined) fail();
    return resolveToHex(target, next!, map, bg, new Set([...seen, name]));
  }
  // color-mix(in <space>, <colour> P%, transparent) — one colour at alpha,
  // composited over the surface it paints on.
  const mix = v.match(
    /^color-mix\(\s*in\s+\w+\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/,
  );
  if (mix) {
    const inner = resolveToHex(name, mix[1]!, map, bg, seen);
    const a = Number(mix[2]!) / 100;
    return toHex(over(parseHex(inner), a, bgRgb));
  }
  return fail();
};

/** Can this token be reduced to an opaque colour against `bg`? The kit uses this
 *  to prove a named `textUngradeable` entry really IS ungradeable, so a named
 *  refusal cannot quietly rot into a skip. */
export const isResolvable = (
  name: string,
  raw: string,
  map: Record<string, string>,
  bg: string,
): boolean => {
  try {
    resolveToHex(name, raw, map, bg);
    return true;
  } catch {
    return false;
  }
};

/* -------------------------------------------------------------------------- */
/* Spec discovery                                                             */
/* -------------------------------------------------------------------------- */

/** The spec-data file names, sorted. Filtered to a lowercase identifier so a
 *  stray helper file in the directory cannot be imported as a spec. */
const specFileNames = (): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(SPEC_DIR, { encoding: "utf8" });
  } catch {
    throw new Error(`${SPEC_DIR} does not exist — every Palette ships a spec-data row`);
  }
  return entries.filter((n) => /^[a-z][a-z0-9-]*\.ts$/.test(n)).sort();
};

/** The kit's own sweep reader (see `sourceSweep.ts`).
 *
 *  `listPaletteSpecs` is a LIST-THEN-IMPORT sweep of `src/lib/palettes`, and that
 *  is the very directory the live palette guard in
 *  `paletteCompleteness.test.ts` writes `guardprobe.ts` into and deletes from a
 *  `finally`, in ANOTHER vitest worker. Four sibling gate files call this at
 *  MODULE scope, so their discovery can list a row that is gone by the time the
 *  `import()` below reaches it. Measured, that answers
 *  `ERR_MODULE_NOT_FOUND` — the same class of failure that reddened
 *  `tauriBarrel.test.ts` in the Wave-3 fan-in, arriving through `import()`
 *  instead of `readFileSync`. */
const sweep = createSourceSweep();

/** Every spec file discovery skipped because it vanished mid-sweep, oldest
 *  first. Exposed so a gate can assert the skip list is empty rather than
 *  trusting that it is — see `sourceSweep.ts` on why an unrecorded skip is the
 *  same shape as no guard at all. */
export const skippedSpecFiles = (): VanishedPath[] => sweep.skipped();

/**
 * Every per-Palette grading row, discovered by READING THE DIRECTORY.
 *
 * Discovery is the whole reason the authoring waves are parallel: a gate that
 * enumerated specs by importing them by name would have to be edited by every new
 * Palette, and four Palettes authored in parallel would collide on the same line.
 * Sweeping a directory is this repo's existing convention for exactly this —
 * `paletteCompleteness.test.ts` already finds the chrome bar by sweeping every
 * TSX file under `src/` rather than by reading `App.tsx`, for the reason recorded
 * there:
 * the invariant must survive the thing MOVING.
 *
 * Each row is a module exporting a const named `spec`. A file that exports
 * something else, or a `spec` that is not an object, is a hard error and NOT a
 * silent skip — a spec that quietly failed to load would leave its Palette
 * ungraded, which is the failure mode this file exists to close.
 */
export const listPaletteSpecs = async (): Promise<PaletteSpec[]> => {
  const specs: PaletteSpec[] = [];
  for (const name of specFileNames()) {
    // An ABSOLUTE `file:` URL built from the repo-relative path, NOT
    // `new URL(\`./palettes/${name}\`, import.meta.url)`. The latter looks like the
    // natural spelling and it is a platform trap: Vite rewrites a computed
    // specifier's static part at TRANSFORM time to a glob key that is
    // ROOT-ABSOLUTE (`/src/lib/palettes/ayu.ts`), and what that resolves to then
    // depends on the host OS. Against a POSIX base it lands on
    // `file:///src/lib/palettes/ayu.ts`, which Vite's own resolver maps back to
    // the project root, so it loads and the hazard is invisible. Against a
    // Windows base the drive survives the resolution —
    // `file:///D:/a/archimedes/archimedes/…` + `/src/lib/…` →
    // `file:///D:/src/lib/palettes/ayu.ts` — no resolver maps that, and every
    // gate that sweeps the directory dies at import. Measured on CI's
    // `windows-latest` leg, where it took down five palette files at once.
    //
    // `pathToFileURL` over `SPEC_DIR` sidesteps the whole class: the path is
    // already repo-relative and every test here runs at the repo root, the same
    // assumption `readdirSync(SPEC_DIR)` above makes, so listing and import agree
    // by construction on every platform. It also drops the stale-glob failure
    // mode this used to depend on — the specifier is no longer something a
    // transform-time glob can miss.
    const href = pathToFileURL(`${SPEC_DIR}/${name}`).href;
    // Through the sweep reader, so a row that another worker DELETED between
    // `specFileNames()` and here is skipped and recorded rather than blowing up a
    // sibling gate. The distinction `listedModule` draws is the one this function
    // must keep: a module that EXISTS and fails to load is still a hard error
    // (see the header above), and so is its STALE-GLOB case. That case can no
    // longer arise from THIS specifier — `pathToFileURL` is not something a
    // transform-time glob can miss — but `listedModule` keeps the check, because
    // `sourceSweep.test.ts` drives it directly and a sweep that skips a file it
    // can see is the silent-green this whole mechanism exists to prevent. Only a
    // row that is genuinely gone is skipped.
    const mod = await sweep.listedModule<Record<string, unknown>>(
      href,
      `${SPEC_DIR}/${name}`,
    );
    if (mod === null) continue;
    const candidate = mod["spec"];
    if (candidate === undefined || typeof candidate !== "object" || candidate === null) {
      throw new Error(
        `${SPEC_DIR}/${name} exports no \`spec\` object — a spec-data file must \`export const spec: PaletteSpec\``,
      );
    }
    const spec = candidate as PaletteSpec;
    if (typeof spec.id !== "string" || spec.id.length === 0) {
      throw new Error(`${SPEC_DIR}/${name} has a spec with no \`id\``);
    }
    if (spec.id !== name.replace(/\.ts$/, "")) {
      throw new Error(
        `${SPEC_DIR}/${name} declares id "${spec.id}" — the file name and the id must agree, or discovery and the registry disagree about which Palette a row grades`,
      );
    }
    specs.push(spec);
  }
  return specs;
};

/* -------------------------------------------------------------------------- */
/* Layer order                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The order the cascade actually sees, as the names of the rules it can produce.
 *
 * WHY THIS IS A KIT FUNCTION AND NOT A HARDCODED FIVE-NAME LIST IN A TEST. The
 * layer gate used to compare the offsets of `["@theme", ".dark", ".theme-default-light",
 * ".theme-default-dark", ".theme-dracula-dark"]` — a fixed list, so a sixth block
 * joined no assertion and could be placed anywhere, including BEFORE `@theme`,
 * where it would be out-specified by every base layer and still leave the gate
 * green. This reads the heads it finds, so a block cannot opt out of the ordering
 * assertion by being new.
 *
 * `blockHeads` is the head list; `layerOrderFailures` is the predicate, returned
 * as failures rather than thrown for the same reason `gradePalette` is: a mutation
 * test can then assert the message it expects without a runner in the loop.
 */
/** Every rule head the text declares at LINE START, in source order, comments
 *  stripped (so a selector named in prose cannot join the list). `expected` is the
 *  list of names the caller knows MUST be present — normally every class the
 *  registry can produce plus the two base layers — and one that is missing is a
 *  failure, because a gate over a subset is how a new block escapes. */
export const blockHeads = (
  text: string,
  expected: readonly string[],
): { failures: string[]; heads: string[] } => {
  const code = stripComments(text);
  const pattern = /^((?:@theme|\.[a-z][a-z0-9-]*))\s*\{/gm;
  const heads: string[] = [];
  for (const match of code.matchAll(pattern)) heads.push(match[1]!);
  const missing = expected.filter((name) => !heads.includes(name));
  return {
    failures: missing.map(
      (name) =>
        `${name} declares no block in the stylesheet, so the layer-order gate cannot see it — a rule that is absent from the list is a rule that is exempt from the ordering`,
    ),
    heads,
  };
};

/**
 * The two facts the layering depends on, checked over EVERY block:
 *
 * 1. `@theme` comes first. Tailwind's `@theme` is what materialises the custom
 *    properties; a rule placed before it is not "earlier in the cascade", it is
 *    outside the layer the tokens are declared in.
 * 2. `.dark` comes before every `.theme-*` block. The palette blocks are
 *    deliberate PARTIAL diffs over `.dark` (Dracula inherits 54 tokens on
 *    purpose), all of them single-class selectors of EQUAL specificity, so
 *    source order is the ONLY tie-breaker. Move `.dark` after a palette block
 *    and it silently out-specifies it: Dracula renders the default palette's
 *    colours and every value assertion that reads block BODIES stays green.
 *
 * The palettes' MUTUAL order is deliberately not asserted: `theme.ts` guarantees
 * at most one `.theme-*` class is ever present, so which palette block is written
 * first cannot affect a rendering, and pinning it would turn a registry reorder
 * into a red suite.
 */
export const layerOrderFailures = (
  text: string,
  expected: readonly string[],
): string[] => {
  const { failures, heads } = blockHeads(text, expected);
  if (failures.length > 0) return failures;
  const at = (name: string): number => heads.indexOf(name);
  const themeAt = at("@theme");
  const darkAt = at(".dark");
  if (themeAt < 0 || darkAt < 0) {
    return ["neither @theme nor .dark is declared, so there is no layering to check"];
  }
  // (1) Nothing at all may precede `@theme` — the check the fixed list could not
  // make, because a block it did not name was simply never looked at.
  const before = heads.filter((name) => at(name) < themeAt && name !== "@theme");
  if (before.length > 0) {
    failures.push(
      `${before.join(", ")} appear${before.length === 1 ? "s" : ""} before @theme — ` +
        `@theme must be the first rule so every block resolves against the tokens it declares ` +
        `(observed order: ${heads.join(" < ")})`,
    );
  }
  // (2) `.dark` must precede every palette block.
  for (const name of heads) {
    if (!name.startsWith(".theme-")) continue;
    if (at(name) < darkAt) {
      failures.push(
        `${name} is declared BEFORE .dark, so it loses every tie against it — a palette block is a diff over .dark and must out-rank it (observed order: ${heads.join(" < ")})`,
      );
    }
  }
  return failures;
};

/* -------------------------------------------------------------------------- */
/* Grading                                                                    */
/* -------------------------------------------------------------------------- */

/** The text family the contrast floors are stated for, in EVERY Palette.
 *  Deliberately a kit constant and NOT per-Palette data: which tokens the app
 *  paints as copy is a fact about the APP, not a fact about a scheme. What a
 *  Palette owns is the FLOOR it reaches, never which tokens get graded — so a new
 *  Palette cannot shrink the set by omitting an entry. */
export const GRADED_TEXT_TOKENS = [
  "color-foreground",
  "color-foreground-subtle",
  "color-foreground-subtlest",
  "color-destructive",
  "color-success",
  "color-warning",
  "color-caution",
] as const;

/** The Default palette's dark token set — the reference the completeness check
 *  compares BOTH directions against. Read from its own CSS file, never from the
 *  resolved stylesheet, for the reason in this file's header. */
export const defaultReferenceTokens = (baseCss: string): Set<string> => {
  const base = cssReader(baseCss);
  return base.declared(base.block(new RegExp(`^\\.theme-${DEFAULT_ID}-dark\\s*\\{`, "m")));
};

/** What `gradePalette` may be pointed at instead of the filesystem — the kit's own
 *  mutation tests use these to grade a synthetic block, which is how a gate is
 *  PROVEN to bite without editing a shipped CSS file. */
export interface GradeOverrides {
  /** The Palette's own CSS text. */
  readonly css?: string;
  /** The base layers (`@theme`, `.dark`) text its `var()` hops resolve against. */
  readonly baseCss?: string;
  /** The Default palette's token set. */
  readonly referenceTokens?: ReadonlySet<string>;
  /** Grade only this reading, so a mutation test can isolate one mode. */
  readonly onlyMode?: PaletteMode;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const modesOf = (spec: PaletteSpec): PaletteMode[] =>
  (["light", "dark"] as const).filter((m) => spec.modes[m] !== undefined);

/**
 * Grade ONE Palette against its own spec row. Returns the list of failures — empty
 * means clean.
 *
 * Returns failures rather than throwing, because the shared sweep must report every
 * Palette it graded, and because the kit's mutation tests must be able to ask "does
 * this predicate name the token it is supposed to name" without a runner in the
 * loop. A gate that has never been observed failing is not a gate —
 * `docs/features/palettes.md` and ADR 0027 both record the lesson: "a pin
 * that passes on the broken thing is worse than no pin".
 */
export const gradePalette = (
  spec: PaletteSpec,
  overrides: GradeOverrides = {},
): string[] => {
  const failures: string[] = [];
  const require = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };

  const css = overrides.css ?? readCssFile(spec.cssFile);
  const baseCss = overrides.baseCss ?? readCssFile(spec.baseCssFile);
  const reader = cssReader(css);
  const base = cssReader(baseCss);
  const THEME = base.values(base.block(/^@theme\s*\{/m));
  const DARK = base.values(base.block(/^\.dark\s*\{/m));
  const referenceTokens = overrides.referenceTokens ?? defaultReferenceTokens(baseCss);

  /* The block heads this file declares, and whether they are NAMED. A Palette
     block that does not follow `theme-<id>-<mode>` is invisible to
     `themeClassNames()` and therefore to the single-class invariant, so it is a
     hard failure and not something to skip past. */
  const ownSelectors = [...reader.code.matchAll(/^(\.theme-[a-z0-9-]+)\s*\{/gm)].map((m) => m[1]!);
  require(
    ownSelectors.length > 0,
    `${spec.id}: ${spec.cssFile} declares no .theme-* block`,
  );

  const graded = new Set<PaletteMode>();
  const excluded = new Set<PaletteMode>();
  for (const selectorName of ownSelectors) {
    const suffix = selectorName.replace(`.theme-${spec.id}-`, "");
    const mode: PaletteMode | undefined =
      suffix === "light" ? "light" : suffix === "dark" ? "dark" : undefined;
    if (mode === undefined) {
      require(
        false,
        `${spec.id}: ${selectorName} is not theme-${spec.id}-<mode>, so the class invariant and the cascade cannot see it`,
      );
      continue;
    }
    const modeSpec = spec.modes[mode];
    if (modeSpec === undefined) {
      require(
        false,
        `${spec.id}: ${selectorName} ships a ${mode} reading the spec row does not grade (no modes.${mode}) — an ungraded Palette is the failure this harness exists to prevent`,
      );
      continue;
    }
    if (overrides.onlyMode !== undefined && overrides.onlyMode !== mode) {
      // Deliberately NOT recorded as "graded": the mutation test that isolates one
      // reading must not also be told the other reading's block is missing. The
      // block-existence check below therefore skips modes the caller excluded.
      excluded.add(mode);
      continue;
    }
    graded.add(mode);
    gradeReading({
      spec,
      modeSpec,
      mode,
      selectorName,
      reader,
      THEME,
      DARK,
      referenceTokens,
      require,
    });
  }

  for (const mode of modesOf(spec)) {
    if (!graded.has(mode) && !excluded.has(mode)) {
      require(
        false,
        `${spec.id}: the spec row grades a ${mode} reading but ${spec.cssFile} declares no .theme-${spec.id}-${mode} block`,
      );
    }
  }

  /* ---- The allow-list, across the WHOLE Palette. ------------------------ */
  // An entry carrying no off-spec hex anywhere is a FREE SLOT: it silently
  // licenses any future token to paint that hex with nothing to notice. (This is
  // how `#353747` once sat in Dracula's list, described as something it was not —
  // and the spec's own "Current Line Rendering" prose says outright that its
  // fallback values "do not add new syntax tokens to the official palette".)
  // Checked per PALETTE rather than per reading, because the tokens it names
  // belong to whichever reading declares them: Dracula declares its 25 file
  // descriptors in the DARK block only, so a per-reading check would call every
  // precedent entry "unused" in the light one.
  const published = new Set(spec.publishedHexes.map((h) => h.toLowerCase()));
  const allDeclarations: Record<string, string> = Object.assign(
    {},
    ...[...reader.code.matchAll(/^(\.theme-[a-z0-9-]+)\s*\{/gm)].map((m) =>
      reader.values(reader.block(new RegExp(`^${escapeRegExp(m[1]!)}\\s*\\{`, "m"))),
    ),
  );
  const unused = Object.keys(spec.offSpecAllowList).filter((token) => {
    const value = allDeclarations[token];
    if (value === undefined) return true;
    return !(
      value.match(/#[0-9a-fA-F]{6}/g)?.some((hex) => !published.has(hex.toLowerCase())) ?? false
    );
  });
  require(
    unused.length === 0,
    `${spec.id}: offSpecAllowList names ${JSON.stringify(unused)}, which carr${unused.length === 1 ? "ies" : "y"} no hex the source does not publish — an unused exception is a free slot for any future token, so delete it (or explain the declaration that needs it)`,
  );
  return failures;
};

/** Grade one READING (mode) of one Palette. */
const gradeReading = (args: {
  spec: PaletteSpec;
  modeSpec: NonNullable<PaletteSpec["modes"]["light"]>;
  mode: PaletteMode;
  selectorName: string;
  reader: ReturnType<typeof cssReader>;
  THEME: Record<string, string>;
  DARK: Record<string, string>;
  referenceTokens: ReadonlySet<string>;
  require: (ok: boolean, message: string) => void;
}): void => {
  const { spec, modeSpec, mode, selectorName, reader, THEME, DARK, referenceTokens, require } =
    args;
  const where = `${spec.id} ${selectorName}`;
  const body = reader.block(
    new RegExp(`^${escapeRegExp(selectorName)}\\s*\\{`, "m"),
  );
  const tokens = reader.values(body);
  const declaredHere = reader.declared(body);
  // The cascade the browser resolves. A dark reading also gets `.dark`; a light
  // reading does NOT — `applyThemeToDocument` gives a light reading no `.dark`
  // class, so `.dark` must not leak into what a light Palette resolves to.
  const map: Record<string, string> =
    mode === "dark" ? { ...THEME, ...DARK, ...tokens } : { ...THEME, ...tokens };
  const pageHex = resolveToHex(
    "color-background",
    map["color-background"] ?? "#ffffff",
    map,
    "#ffffff",
  );
  const resolve = (token: string): string => resolveToHex(token, map[token]!, map, pageHex);

  /* ---- 1. Completeness, BOTH directions. --------------------------------- */
  // A token a Palette forgets does not fail, it silently inherits — the single
  // hazard the layering creates, and why this is a completeness test and not a
  // spot check. Asserting only "nothing is missing" lets a token be silently
  // DROPPED; asserting only "nothing is extra" lets a token be silently INHERITED
  // that the reference restates by hand. Both directions together mean a new
  // token in the reference must be classified: restate it, or name it in
  // `inheritedFromDefault`. There is no third option.
  const missing = diff(new Set(referenceTokens), declaredHere);
  const expectedInherited = [...modeSpec.inheritedFromDefault].sort();
  require(
    JSON.stringify(missing) === JSON.stringify(expectedInherited),
    `${where}: inherits ${missing.length} token(s) that the Default dark block declares, but the spec row names ${expectedInherited.length}. ` +
      `Unexpectedly inherited (a token this Palette forgot): ${JSON.stringify(
        missing.filter((t) => !expectedInherited.includes(t)),
      )}. ` +
      `Listed as inherited but actually declared: ${JSON.stringify(
        expectedInherited.filter((t) => !missing.includes(t)),
      )}`,
  );
  const extra = diff(declaredHere, new Set(referenceTokens));
  const expectedExtra = [...modeSpec.extraBeyondDefault].sort();
  require(
    JSON.stringify(extra) === JSON.stringify(expectedExtra),
    `${where}: declares ${JSON.stringify(extra)} that the Default dark block does not, but the spec row expects ${JSON.stringify(expectedExtra)}`,
  );
  require(
    diff(new Set(modeSpec.inheritedFromDefault), new Set(referenceTokens)).length === 0,
    `${where}: inheritedFromDefault names ${JSON.stringify(
      diff(new Set(modeSpec.inheritedFromDefault), new Set(referenceTokens)),
    )} which the Default dark block does not declare either — a stale entry would mask a real omission`,
  );
  require(
    modeSpec.inheritedFromDefault.length === new Set(modeSpec.inheritedFromDefault).size,
    `${where}: inheritedFromDefault contains duplicates`,
  );
  require(
    declaredHere.size === modeSpec.declaredCount,
    `${where}: declares ${declaredHere.size} tokens, the spec row pins ${modeSpec.declaredCount}`,
  );

  /* ---- 2. Values: every declared hex published, or off-spec BY NAME. ----- */
  // The set equality above is silent about VALUES. Dracula's block was built from
  // `pi-dracula`, a community port that disagrees with the specification, and then
  // had invented hues added on top: every token sat in the right slot, both
  // directions passed, and the Palette was still off-spec. So hexes are graded
  // against the published set, and the only way out is a named entry with a reason.
  const published = new Set(spec.publishedHexes.map((h) => h.toLowerCase()));
  const offenders: string[] = [];
  for (const [token, value] of Object.entries(tokens)) {
    if (spec.offSpecAllowList[token] !== undefined) continue;
    for (const hex of value.match(/#[0-9a-fA-F]{6}/g) ?? []) {
      if (!published.has(hex.toLowerCase())) offenders.push(`${token}: ${hex}`);
    }
  }
  require(
    offenders.length === 0,
    `${where}: declares hexes the source does not publish — ${offenders.join(", ")}`,
  );

  /* ---- 3. The ladder. --------------------------------------------------- */
  // Decision 6 / ADR 0105: a DARK reading must strictly ascend. A LIGHT reading is
  // non-decreasing and may plateau ONLY at the top, because no light theme
  // publishes anything lighter than its own Base — `default-light` already answers
  // this by plateau (`card`/`input`/`popover`/`menu` are all `#ffffff`). Group
  // MEMBERSHIP is per-Palette data, never a shared table: Dracula's `secondary` IS
  // `card`, `default-light`'s `secondary #e6e6e6` (L 0.7913) sits BELOW `card
  // #ffffff` (L 1.0000), and one table cannot say both.
  const groupHexes: Array<{ label: string; hex: string }> = [];
  const seen = new Map<string, string>();
  for (const group of modeSpec.ladderGroups) {
    require(group.tokens.length > 0, `${where}: ladder group "${group.label}" names no tokens`);
    const hexes: string[] = [];
    for (const token of group.tokens) {
      if (map[token] === undefined) {
        require(
          false,
          `${where}: ladder token --${token} is not declared anywhere in this reading's cascade`,
        );
        continue;
      }
      let hex: string;
      try {
        hex = resolve(token);
      } catch (error) {
        require(
          false,
          `${where}: ladder token --${token} is not comparable as a colour (${(error as Error).message}) — a translucent SURFACE is not an elevation step (ADR 0105), so it belongs in ladderExemptions with a reason, never in a group`,
        );
        continue;
      }
      require(
        !seen.has(token),
        `${where}: --${token} is named in two ladder groups (${seen.get(token)} and ${group.label})`,
      );
      seen.set(token, group.label);
      hexes.push(hex.toLowerCase());
    }
    const distinct = new Set(hexes);
    require(
      distinct.size <= 1,
      `${where}: group "${group.label}" claims ONE step but carries ${distinct.size} colours (${[...distinct].join(", ")}) — an untracked rung`,
    );
    if (hexes.length > 0) groupHexes.push({ label: group.label, hex: hexes[0]! });
  }
  for (let i = 1; i < groupHexes.length; i++) {
    const prev = lumOf(groupHexes[i - 1]!.hex);
    const at = lumOf(groupHexes[i]!.hex);
    // A plateau is allowed only at the TOP of a LIGHT reading.
    const plateauAllowed = mode === "light" && i === groupHexes.length - 1;
    require(
      plateauAllowed ? at >= prev : at > prev,
      `${where}: ladder step ${i} (${groupHexes[i]!.label}) is ${at > prev ? "lighter than" : at === prev ? "level with" : "DARKER than"} ${groupHexes[i - 1]!.label} — ${groupHexes[i - 1]!.hex} then ${groupHexes[i]!.hex}${
        plateauAllowed
          ? " (a light reading may only plateau at the top)"
          : mode === "light"
            ? " (a light reading must be NON-DECREASING and may plateau only at its top group: no light theme publishes anything lighter than its Base)"
            : " (a dark reading must strictly ascend)"
      }`,
    );
  }
  // Every surface token the block declares must be classified, so the ladder
  // cannot be widened past this gate by adding a surface nobody graded, and a
  // renamed one cannot quietly vanish.
  const unclassified = Object.keys(tokens)
    .filter((t) => modeSpec.surfaceTokenPattern.test(t))
    .filter((t) => !seen.has(t))
    .filter((t) => !modeSpec.selectedTokens.includes(t))
    .filter((t) => modeSpec.ladderExemptions[t] === undefined)
    .sort();
  require(
    unclassified.length === 0,
    `${where}: surface tokens missing from the ladder — ${unclassified.join(", ")}`,
  );
  for (const [token, reason] of Object.entries(modeSpec.ladderExemptions)) {
    require(
      map[token] !== undefined,
      `${where}: ladderExemptions names --${token}, which this reading never declares (${reason}) — a stale exemption`,
    );
    require(
      !seen.has(token),
      `${where}: --${token} is BOTH a ladder group member and an exemption (${reason})`,
    );
  }
  // The selection STATE, graded off the ladder by the reading's own rule.
  for (const token of modeSpec.selectedTokens) {
    if (map[token] === undefined) {
      require(
        false,
        `${where}: --${token} is named as the selection state but is never declared in this reading`,
      );
      continue;
    }
    let sel: string;
    try {
      sel = resolve(token);
    } catch (error) {
      // Reached when the block omits the token but the CASCADE still has a value
      // for it (`.dark`'s reading, usually an unresolvable `var()` into Tailwind's
      // scale). That is the "palette forgot to restate it" case, and it must be
      // REPORTED, not thrown out of the gate.
      require(
        false,
        `${where}: --${token} is the selection state but resolves only through the cascade to something ungradeable (${(error as Error).message}) — the block does not state its own reading`,
      );
      continue;
    }
    if (modeSpec.selectionRule === "strictly-above-all") {
      for (const group of groupHexes) {
        require(
          lumOf(sel) > lumOf(group.hex),
          `${where}: --${token} (${sel}) is not brighter than every resting step (${group.label} ${group.hex}) — this Palette grades Selection as the brightest value it owns`,
        );
      }
    } else {
      require(
        map["color-card"] !== undefined,
        `${where}: selectionRule "at-or-above-card" needs --color-card in this reading`,
      );
      if (map["color-card"] !== undefined) {
        const card = resolve("color-card");
        require(
          lumOf(sel) >= lumOf(card),
          `${where}: --${token} (${sel}) is dimmer than the resting card (${card}) — a selected row must not sink below the surface it sits on`,
        );
      }
    }
  }

  /* ---- 4. Text contrast on the surfaces its consumers actually paint. ---- */
  // The gap every earlier contrast gate in this repo shared: they graded against a
  // Palette's `--color-background`, and the tokens they name overwhelmingly render
  // on FLOATING surfaces. Dracula's `destructive` is the proof — 4.53 on the page,
  // one notch from the floor, and 4.33 on the raised step where the error copy
  // actually lives. A page-only floor is how that survived.
  // One class of surfaces at a time. Ratios are collected per token ACROSS the
  // class before any staleness rule is applied, because a recorded wall is by
  // definition the WORST reading in the class: asserting "the wall is still the
  // wall" surface-by-surface would fail on every surface that happens to be more
  // legible than the worst, which is not a stale wall, that is a ladder working.
  const gradeSurfaceSet = (
    surfaceTokens: readonly string[],
    floors: Readonly<Record<string, FloorRule>>,
    label: string,
  ): void => {
    const resolved: Array<{ token: string; surface: string; hex: string }> = [];
    for (const surfaceToken of surfaceTokens) {
      if (map[surfaceToken] === undefined) {
        require(
          false,
          `${where}: ${label} surface --${surfaceToken} is not declared in this reading — a gate must name a surface the pixels land on`,
        );
        continue;
      }
      let bg: string;
      try {
        bg = resolve(surfaceToken);
      } catch (error) {
        require(
          false,
          `${where}: ${label} surface --${surfaceToken} cannot be resolved (${(error as Error).message})`,
        );
        continue;
      }
      resolved.push({ token: surfaceToken, surface: surfaceToken, hex: bg });
    }
    for (const token of GRADED_TEXT_TOKENS) {
      const ungradeable = modeSpec.textUngradeable[token];
      if (ungradeable !== undefined) {
        for (const { surface, hex: bg } of resolved) {
          const raw = map[token];
          require(
            raw === undefined || !isResolvable(token, raw, map, bg),
            `${where}: textUngradeable names --${token} (${ungradeable}) but it IS resolvable against ${surface} (${raw}) — grade it`,
          );
        }
        continue;
      }
      const raw = map[token];
      if (raw === undefined) {
        require(
          false,
          `${where}: --${token} is undeclared in this reading — grade it or name why not in textUngradeable`,
        );
        continue;
      }
      const readings: Array<{ surface: string; fg: string; bg: string; ratio: number }> = [];
      for (const { surface, hex: bg } of resolved) {
        let fg: string;
        try {
          // Composites a TRANSLUCENT text token over the surface it paints on —
          // the half `resolveToHex` took from `composite`.
          fg = resolveToHex(token, raw, map, bg);
        } catch (error) {
          require(
            false,
            `${where}: --${token} cannot be graded on ${surface} (${bg}): ${(error as Error).message}`,
          );
          continue;
        }
        readings.push({ surface, fg, bg, ratio: contrast(fg, bg) });
      }
      if (readings.length === 0) continue;
      const rule = floors[token];
      const floor = rule?.floor ?? 4.5;
      for (const reading of readings) {
        require(
          reading.ratio >= floor,
          `${where}: --${token} (${reading.fg}) on ${reading.surface} (${reading.bg}) measures ${reading.ratio.toFixed(2)}, below the ${floor} floor${rule ? ` — ${rule.reason}` : ""}`,
        );
      }
      const worst = readings.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      if (rule !== undefined && floor < 4.5 && rule.expiresAt === undefined) {
        // Every sub-4.5 floor is a REPORTED wall, and a reported wall that cannot
        // expire is a permanent exemption wearing a temporary one — which is the
        // failure mode ADR 0027's amendments keep recording. So the floor must
        // name the ratio at which it stops being excusable.
        require(
          false,
          `${where}: --${token} has a ${floor} floor on its ${label} surfaces without \`expiresAt\` — a sub-4.5 floor must say when it stops being excusable (4.5 unless there is a stated reason otherwise)`,
        );
      }
      if (rule?.expiresAt !== undefined) {
        require(
          worst.ratio < rule.expiresAt,
          `${where}: --${token} now clears ${rule.expiresAt} on its worst ${label} surface (${worst.ratio.toFixed(2)} on ${worst.surface}) — delete the ${floor} exemption, which existed only because it could not (${rule.reason})`,
        );
      }
    }
  };
  // Three INDEPENDENT tables, deliberately not one merged down. Merging the
  // resting exemptions into the raised and selected classes made the expiry
  // ratchet fire on a surface the exemption was never about (Dracula's
  // `destructive` is exempted on the raised step at 4.33 and clears 4.5 on the
  // page — a merged table reads that as "the exemption is stale"). Each class
  // states its own floors and a token absent from it is held to 4.5, which is the
  // shape the Dracula gate had before the extraction (TEXT_TOKENS / RAISED_FLOOR /
  // SELECTED_FLOOR were three separate tables for exactly this reason).
  gradeSurfaceSet(modeSpec.textSurfaces.resting, modeSpec.textFloors, "resting");
  gradeSurfaceSet(modeSpec.textSurfaces.raised, modeSpec.raisedFloors, "raised");
  gradeSurfaceSet(modeSpec.textSurfaces.selected, modeSpec.selectedFloors, "selected");
  // Non-vacuity in the direction that matters: a Palette that graded one surface
  // with a lax floor would look identical to one that graded five.
  const readings =
    modeSpec.textSurfaces.resting.length +
    modeSpec.textSurfaces.raised.length +
    modeSpec.textSurfaces.selected.length;
  require(
    readings >= 4,
    `${where}: only ${readings} surface readings are graded — one page and one float is not a contrast gate`,
  );
  require(
    modeSpec.textSurfaces.resting.length >= 2,
    `${where}: grade text on at least the page AND a float — a single-surface floor is how a sub-4.5 status hue stayed green`,
  );
};

export type { PaletteMode, PaletteSpec };
