import { describe, expect, it } from "vitest";
import {
  GRADED_TEXT_TOKENS,
  contrast,
  cssReader,
  defaultReferenceTokens,
  diff,
  gradePalette,
  isResolvable,
  listPaletteSpecs,
  lumOf,
  readCssFile,
  resolveToHex,
  skippedSpecFiles,
  stripComments,
} from "./paletteTestKit";
import { DEFAULT_PALETTE_ID, PALETTES } from "./palettes";
import type { PaletteSpec } from "./paletteSpec";
import { createSourceSweep } from "./sourceSweep";

/** A reader for the structural pin below: a kit file that cannot be read is a red
 *  test, not a silently-skipped one (`named()`, not `listed()`). */
const sweep = createSourceSweep();

/**
 * Proves the KIT, not any one Palette.
 *
 * Every predicate here exists because the Dracula-only gate it replaced had
 * already been observed passing on a broken thing — `theme.test.ts` records that
 * dropping `theme.ts`'s `!dracula` guard left 113 tests green, and
 * `paletteCompleteness.test.ts` records that collapsing four of Dracula's five
 * thinking levels onto status hexes stayed green, and that a hex-only parser let
 * a descriptor be graded on a surface it never sat on. A gate that has never been
 * seen failing is the failure mode, not the remedy (ADR 0027,
 * `docs/features/palettes.md`).
 *
 * So each mutation below is applied to a SYNTHETIC COPY of a real block — the
 * shipped CSS is never edited — and asserts the failure NAMES the token or the
 * group it is supposed to name. Deleting a helper would prove only that it is
 * instantiated; these mutations still parse, still resolve, and change what the
 * gate reports.
 */

const specs = await listPaletteSpecs();
const specFor = (id: string): PaletteSpec => {
  const found = specs.find((spec) => spec.id === id);
  if (!found) throw new Error(`no spec row for "${id}" — discovery found ${specs.map((s) => s.id)}`);
  return found;
};
const defaultSpec = specFor("default");
const draculaSpec = specFor("dracula");

const BASE_CSS = readCssFile(defaultSpec.baseCssFile);
const DRACULA_CSS = readCssFile(draculaSpec.cssFile);
const DEFAULT_CSS = readCssFile(defaultSpec.cssFile);

/** Replace one declaration's value in one block, leaving everything else alone.
 *  The mutation tool: a real edit to a real file, applied to a string copy. */
const mutateValue = (
  css: string,
  selector: string,
  token: string,
  value: string,
): string => {
  const pattern = new RegExp(
    `(^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[\\s\\S]*?--${token}:\\s*)[^;]+;`,
    "m",
  );
  if (!pattern.test(css)) {
    throw new Error(`mutation target --${token} not found in ${selector}`);
  }
  return css.replace(pattern, `$1${value};`);
};

/** Delete one declaration from one block (the "Palette forgot a token" case). */
const mutateDelete = (css: string, selector: string, token: string): string => {
  const pattern = new RegExp(
    `(^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[\\s\\S]*?)--${token}:[^;]+;`,
    "m",
  );
  if (!pattern.test(css)) {
    throw new Error(`mutation target --${token} not found in ${selector}`);
  }
  return css.replace(pattern, "$1");
};

describe("the kit's resolver (resolveToHex = resolveToHex ∪ composite)", () => {
  it("resolves a bare #rrggbb verbatim", () => {
    expect(resolveToHex("x", "#282A36", {}, "#ffffff")).toBe("#282a36");
  });

  it("resolves an 8-DIGIT hex — the case `composite` threw on", () => {
    // THE mutation test decision 7 asks for. Ayu publishes its foregrounds as
    // `#fcf8ecbd`, Rosé Pine publishes `#6e6a8633`, Everforest `#475258c0`; the
    // completeness gate's `composite()` matched only
    // `color-mix(in oklab, #rrggbb N%, transparent)` and a bare `#rrggbb`, so it
    // threw on all three and the ladder/text floors could not grade those Palettes
    // at all. The merged resolver composites them over the surface they paint on.
    expect(resolveToHex("x", "#ff000080", {}, "#000000")).toBe("#800000");
    expect(resolveToHex("x", "#fcf8ecbd", {}, "#0b0e14")).not.toBe("#fcf8ec");
    expect(lumOf(resolveToHex("x", "#fcf8ecbd", {}, "#0b0e14"))).toBeGreaterThan(
      lumOf("#0b0e14"),
    );
  });

  it("resolves #rgba by expanding the shorthand", () => {
    expect(resolveToHex("x", "#f00f", {}, "#000000")).toBe("#ff0000");
    // `8` expands to `88` = 136/255, not 0.5 — the alpha nibble doubles, it does
    // not round to a half.
    expect(resolveToHex("x", "#f008", {}, "#000000")).toBe("#880000");
  });

  it("resolves rgb()/rgba() including the alpha argument", () => {
    expect(resolveToHex("x", "rgb(40, 42, 54)", {}, "#ffffff")).toBe("#282a36");
    expect(resolveToHex("x", "rgba(255, 0, 0, 0.5)", {}, "#000000")).toBe("#800000");
  });

  it("resolves a single-colour color-mix over the surface it paints on", () => {
    // The half `resolveToHex` took from `composite`: a translucent value must be
    // graded COMPOSITED, because that is the pixel that renders. Grading it raw
    // is how `--color-foreground-subtle` looked like a different colour than the
    // one the user sees.
    expect(
      resolveToHex("x", "color-mix(in oklab, #f8f8f2 70%, transparent)", {}, "#343746"),
    ).toBe("#bdbebe");
  });

  it("follows ONE hop of var() and no further", () => {
    const map = { "color-input": "#191a21", "color-input-focused": "var(--color-input)" };
    expect(resolveToHex("color-input-focused", map["color-input-focused"]!, map, "#000000")).toBe(
      "#191a21",
    );
    const twoHops = { "color-a": "var(--color-b)", "color-b": "var(--color-c)" };
    expect(() => resolveToHex("color-a", twoHops["color-a"]!, twoHops, "#000000")).toThrow(
      /cannot resolve/,
    );
  });

  it("refuses to guess, naming the token", () => {
    // Loud on purpose: a value that silently vanished from the map used to be
    // graded against the `@theme` fallback on a surface it never touches, which is
    // the failure `fileIconContrast.test.ts` was rewritten to stop.
    expect(() => resolveToHex("mystery", "hsl(120, 50%, 50%)", {}, "#000000")).toThrow(
      /cannot resolve --color-mystery/,
    );
    expect(isResolvable("mystery", "oklch(50% 0.2 200)", {}, "#000000")).toBe(false);
    expect(isResolvable("plain", "#ffffff", {}, "#000000")).toBe(true);
  });

  it("reports a cyclic var() instead of looping", () => {
    const map = { "color-a": "var(--color-b)", "color-b": "var(--color-a)" };
    expect(() => resolveToHex("color-a", map["color-a"]!, map, "#000000")).toThrow(/cyclic/);
  });

  it("agrees with WCAG on the figures every gate here quotes", () => {
    // The numbers ADR 0027 and `docs/features/palettes.md` record, so a
    // future edit to `lumOf`/`contrast` cannot silently move them all.
    expect(contrast("#f8f8f2", "#343746")).toBeCloseTo(11.06, 1);
    expect(contrast("#ff6e6e", "#343746")).toBeCloseTo(4.33, 1);
    expect(contrast("#ff6e6e", "#424450")).toBeCloseTo(3.54, 1);
    expect(contrast("#6272a4", "#343746")).toBeCloseTo(2.51, 1);
  });
});

describe("the kit's readers", () => {
  it("counts brace DEPTH, so a nested rule does not truncate a block", () => {
    // The `\n}` heuristic the sibling files used to use truncates at the first
    // nested block, which fails an ABSENCE assertion OPEN: the token looks
    // undeclared because it was never read.
    const css = [
      ".theme-x {",
      "  --color-a: #000000;",
      "  @media (min-width: 1px) { --color-inside: #ffffff; }",
      "  --color-b: #ffffff;",
      "}",
    ].join("\n");
    const reader = cssReader(css);
    const body = reader.block(/^\.theme-x\s*\{/m);
    expect(reader.declared(body)).toContain("color-b");
    expect(reader.declared(body)).toContain("color-inside");
  });

  it("cannot be fooled by a selector named in PROSE", () => {
    // The documented hazard: a doc-comment whose line BEGINS with a selector, which
    // is exactly how these stylesheets discuss `.dark` and `@theme`. Anchored at
    // line start is necessary but NOT sufficient — the anchor cannot tell a comment
    // line from a rule. Reading the RAW text finds the COMMENT as the block and
    // yields `--color-ghost`, a token nothing declares; an absence assertion for
    // `--color-a` then PASSES FOR THE WRONG REASON. Stripping first finds the real
    // block. Both halves are pinned so the strip stays load-bearing.
    const css = ["/*", ".dark { --color-ghost: #ffffff; }", "*/", ".dark { --color-a: #000000; }"].join("\n");
    const raw = cssReader(css);
    expect([...raw.declared(raw.block(/^\.dark\s*\{/m))]).toEqual(["color-ghost"]);
    const stripped = cssReader(stripComments(css));
    expect([...stripped.declared(stripped.block(/^\.dark\s*\{/m))]).toEqual(["color-a"]);
  });

  it("does not read a commented-out declaration as a declaration", () => {
    const css = ".theme-x { --color-a: #000000; /* --color-ghost: #ffffff; */ }";
    const reader = cssReader(css);
    const body = reader.block(/^\.theme-x\s*\{/m);
    expect([...reader.declared(body)]).toEqual(["color-a"]);
    expect(reader.values(body)["color-ghost"]).toBeUndefined();
  });

  it("throws with the selector when a block is absent, rather than returning ''", () => {
    // This throw is WHY per-Palette grading reads a Palette's own file: a gate
    // reading the resolved `index.css` would throw for a Palette whose `@import`
    // does not exist yet, so the shared suite would go red mid-plan or the gate
    // would have to skip — and a skipped gate is vacuous for exactly the Palettes
    // it exists to grade.
    const reader = cssReader(".theme-only { --color-a: #000; }");
    expect(() => reader.block(/^\.theme-missing\s*\{/m)).toThrow(/no .* block/);
  });

  it("diff() is a set difference and not an array filter on the wrong side", () => {
    expect(diff(new Set(["a", "b"]), new Set(["b"]))).toEqual(["a"]);
    expect(diff(new Set(["b"]), new Set(["a", "b"]))).toEqual([]);
  });

  it("throws a named error for a CSS file that does not exist", () => {
    expect(() => readCssFile("src/styles/nope.css")).toThrow(/cannot be read/);
  });

  it("reads a Palette's OWN file without needing the @import to exist", () => {
    // The Wave-3 property in one assertion: `src/styles/dracula.css` is graded
    // here with no reference at all to whether `src/index.css` imports it.
    expect(readCssFile("src/styles/dracula.css")).toMatch(/\.theme-dracula-dark\s*\{/);
  });
});

describe("listPaletteSpecs — discovery", () => {
  it("discovers one row per Palette the registry offers", () => {
    // THE COVERAGE DIRECTION, and it is the only direction that may compare the
    // two lists. A registered Palette with no row renders UNGRADED — no
    // completeness, no ladder, no contrast floor — and nothing else in the suite
    // can see it, so this half stays shut.
    //
    // THE OTHER DIRECTION IS GONE, ON PURPOSE. `expect(discoveredIds).toEqual(
    // registeredIds)` asserted DIRECTORY == REGISTRY, which is precisely the
    // (a)/(b) conflation `paletteCompleteness.test.ts`'s wiring describe forbids:
    // Tasks 3–6 each add `src/lib/palettes/<id>.ts` + `src/styles/<id>.css` and
    // touch NEITHER `src/lib/palettes.ts` NOR `src/index.css` — registration is
    // Task 7 — so mid-plan the directory holds MORE rows than the registry, and
    // an unregistered row is the plan's state, not dead data. It failed on the
    // Wave-3 probe as `expected [ 'default', 'dracula', 'probe' ] to deeply equal
    // [ 'default', 'dracula' ]`, demanding that a Palette be registered before
    // the closeout task that registers it is allowed to run.
    const ids = specs.map((spec) => spec.id);
    const registered = PALETTES.map((palette) => palette.id);
    const missing = registered.filter((id) => !ids.includes(id));
    expect(
      missing,
      `registered Palettes with no spec row — they render ungraded: ${missing.join(", ")}`,
    ).toEqual([]);
    // Non-vacuity, relational rather than as a literal count: discovery found at
    // least the registered set. `toBeGreaterThanOrEqual` rather than `toEqual`
    // because the surplus IS Wave 3. A directory the sweep cannot read yields
    // `[]`, and `[] ⊆ registered` only when the registry is empty too — which the
    // next test pins against the two shipped Palettes by name.
    expect(
      ids.length,
      "discovery found fewer rows than the registry has Palettes, so the sweep is reading the wrong directory",
    ).toBeGreaterThanOrEqual(registered.length);
    // And the surplus, if any, is EXPLICITLY permitted rather than tolerated by
    // omission: an unregistered row is graded by the per-row tests below, which is
    // the half of the split that must not be skipped.
    const unregistered = ids.filter((id) => !registered.includes(id));
    for (const id of unregistered) {
      expect(
        specs.find((spec) => spec.id === id),
        `${id} is in the directory but not the registry: Wave 3's state, so it must still carry its own row`,
      ).toBeTruthy();
    }
  });

  it("discovers AT LEAST the two shipped Palettes, so the sweep is not vacuous", () => {
    // A gate over an empty list and a gate over a clean tree are the same green —
    // the sentence this repo's own gates keep repeating, applied to the harness
    // that replaced them.
    const ids = specs.map((spec) => spec.id);
    expect(specs.length).toBeGreaterThanOrEqual(2);
    expect(ids).toContain(DEFAULT_PALETTE_ID);
    expect(ids).toContain("dracula");
  });

  it("every row's modes match its blocks, and every registry mode is graded", () => {
    // TWO properties with TWO enumerations, and the old shape ran them as one
    // loop over the DIRECTORY — which is what made an unregistered row a defect.
    //
    // (i) PER ROW (kind (a)): a row's own blocks must be exactly the modes its own
    //     row grades. This runs for EVERY row, registered or not — an unregistered
    //     row is the plan's mid-wave state, and its per-row properties are the
    //     half that must NOT be skipped.
    // (ii) PER REGISTERED PALETTE (kind (b)): every mode the registry ships must be
    //     graded by the row. Loud, and it stays loud: a Palette registered with an
    //     ungraded reading is the failure the harness exists to prevent.
    //
    // What is GONE is `expect(PALETTES.find(p => p.id === spec.id)).toBeTruthy()`
    // — "every discovered row has a registry entry" — which failed on the Wave-3
    // probe as `probe: a spec row with no registry entry: expected undefined to be
    // truthy`, i.e. it forbade the state Tasks 3–6 leave behind.
    for (const spec of specs) {
      const css = readCssFile(spec.cssFile);
      const blocks = [...stripComments(css).matchAll(/^\.theme-([a-z0-9-]+)-(light|dark)\s*\{/gm)]
        .map((m) => m[2])
        .sort();
      const graded = (["light", "dark"] as const).filter((m) => spec.modes[m] !== undefined);
      expect(blocks, `${spec.id}: blocks vs graded modes`).toEqual([...graded].sort());
    }

    // (ii) The registry-shaped half, enumerated over the REGISTRY.
    for (const palette of PALETTES) {
      const row = specs.find((spec) => spec.id === palette.id);
      expect(row, `${palette.id}: a registered Palette no spec row grades`).toBeTruthy();
      expect(
        (["light", "dark"] as const).filter((m) => row!.modes[m] !== undefined).sort(),
        `${palette.id}: the row grades a different set of readings than the registry ships`,
      ).toEqual([...palette.modes].sort());
    }

    // And an UNREGISTERED row is permitted, explicitly rather than by silence:
    // discovery may find rows the registry has never heard of, and none of the
    // above may demand otherwise. Pinned relationally so it holds with 2 rows and
    // with 6.
    const unregistered = specs.filter(
      (spec) => !PALETTES.some((palette) => palette.id === spec.id),
    );
    for (const spec of unregistered) {
      // Its own per-row properties are still checked (they were, in the loop
      // above — this is the assertion that says SO). Graded, not skipped.
      expect(
        (["light", "dark"] as const).filter((m) => spec.modes[m] !== undefined).length,
        `${spec.id} is unregistered, which excuses wiring but never grading — a row with no graded reading grades nothing`,
      ).toBeGreaterThan(0);
      expect(
        gradePalette(spec),
        `${spec.id} is unregistered, which excuses wiring but never grading`,
      ).toEqual([]);
    }
  });

  it("every row declares its own id and its own CSS file", () => {
    for (const spec of specs) {
      expect(spec.id).toBeTruthy();
      expect(spec.cssFile).toMatch(/^src\/styles\/.+\.css$/);
      expect(readCssFile(spec.cssFile)).toContain(".theme-");
      expect(spec.specSourceUrl.length, `${spec.id}: a spec row must cite where its values come from`).toBeGreaterThan(0);
    }
  });

  it("grades every shipped Palette clean, so the harness is not simply broken", () => {
    const report = specs.map((spec) => [spec.id, gradePalette(spec)] as const);
    const dirty = report.filter(([, failures]) => failures.length > 0);
    expect(
      dirty.map(([id, failures]) => `${id}:\n    ${failures.join("\n    ")}`),
      "the parametrised gates must pass on the two shipped Palettes",
    ).toEqual([]);
    // Non-vacuous: grading really did look at something.
    for (const [id] of report) {
      expect(id).toBeTruthy();
    }
    expect(specs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("gradePalette bites (mutation tests on synthetic copies)", () => {
  /** Grade a MUTATED copy of Dracula's dark block. `onlyMode` isolates one
   *  reading so a failure list contains only the mutation's own complaint. */
  const gradeMutant = (
    css: string,
    spec: PaletteSpec = draculaSpec,
    overrides: { baseCss?: string; referenceTokens?: ReadonlySet<string> } = {},
  ): string[] =>
    gradePalette(spec, {
      css,
      baseCss: overrides.baseCss ?? BASE_CSS,
      referenceTokens: overrides.referenceTokens ?? defaultReferenceTokens(BASE_CSS),
      onlyMode: "dark",
    });

  it("names the token a Palette FORGOT (completeness, inheritance direction)", () => {
    // The single hazard of the layering: an omitted token does not fail, it
    // silently inherits. Before the harness there was one completeness gate and it
    // read `DRACULA_VALUES`, so a NEW Palette got no grading of any kind.
    // `--color-terminal-red` is one of the 22 ANSI tokens this block OWNS (ADR
    // 0027's amendment 2), so deleting it is exactly "a palette that forgot the
    // terminal hues" — and nothing about the CSS is malformed afterwards.
    const css = mutateDelete(DRACULA_CSS, ".theme-dracula-dark", "color-terminal-red");
    const failures = gradeMutant(css);
    expect(
      failures.some((f) => f.includes("color-terminal-red")),
      `expected a failure naming color-terminal-red, got:\n${failures.join("\n")}`,
    ).toBe(true);
    expect(failures.join("\n")).toMatch(/Unexpectedly inherited/);
  });

  it("names a token a Palette declared that the Default palette does not", () => {
    const withNew = DRACULA_CSS.replace(
      /^\.theme-dracula-dark\s*\{/m,
      ".theme-dracula-dark {\n  --color-brand-new: #123456;",
    );
    const failures = gradeMutant(withNew);
    expect(failures.join("\n")).toMatch(/color-brand-new/);
  });

  it("names a token INHERITED by the row but restated by the block", () => {
    // The other direction of the same equality, and the one that hides a real bug:
    // `color-surface` is a white overlay the block deliberately leaves on `.dark`.
    // Restating it means the row's `inheritedFromDefault` no longer describes the
    // block, so a future reader inherits something that is actually owned.
    const restated = DRACULA_CSS.replace(
      /^\.theme-dracula-dark\s*\{/m,
      ".theme-dracula-dark {\n  --color-surface: #ffffff;",
    );
    const failures = gradeMutant(restated);
    expect(failures.join("\n")).toMatch(/Listed as inherited but actually declared.*color-surface/);
  });

  it("names a hex the source does not publish (the gate that would have caught pi-dracula)", () => {
    // Every token in the right slot, both completeness directions passing, and the
    // Palette still off-spec: that is the original Dracula mistake, and it is why
    // this predicate exists at all. `#9aa4c4` is `pi-dracula`'s invented
    // foreground-subtle and appears nowhere in the specification.
    const css = mutateValue(
      DRACULA_CSS,
      ".theme-dracula-dark",
      "color-border",
      "#9aa4c4",
    );
    const failures = gradeMutant(css);
    expect(
      failures.some((f) => f.includes("color-border") && f.includes("#9aa4c4")),
      `expected a failure naming color-border and #9aa4c4, got:\n${failures.join("\n")}`,
    ).toBe(true);
  });

  it("refuses an allow-list entry that excuses nothing (a free slot)", () => {
    // `#353747` once sat in Dracula's allow-list described as something it was
    // not; an exception nothing uses silently licenses any future token.
    const padded: PaletteSpec = {
      ...draculaSpec,
      offSpecAllowList: {
        ...draculaSpec.offSpecAllowList,
        "color-border": "an invented excuse for a token that is already on-spec",
      },
    };
    const failures = gradePalette(padded, {
      css: DRACULA_CSS,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
      onlyMode: "dark",
    });
    expect(failures.join("\n")).toMatch(/offSpecAllowList names .*color-border/);
  });

  it("fails an INVERTED ladder step, naming both groups", () => {
    // The elevation inversion this repo already shipped once (`secondary`/`tag`
    // brighter than `card`, so a badge out-shone the card it sat on). Made darker
    // than the recessed rung it must sit above, the inversion the ladder exists to
    // catch.
    const css = mutateValue(DRACULA_CSS, ".theme-dracula-dark", "color-card", "#101015");
    const failures = gradeMutant(css);
    expect(
      failures.some((f) => /ladder step/.test(f) && /DARKER than/.test(f)),
      `expected a ladder-order failure, got:\n${failures.join("\n")}`,
    ).toBe(true);
    expect(failures.join("\n")).toMatch(/#101015/);
  });

  it("fails a group that claims one step but carries two", () => {
    const css = mutateValue(DRACULA_CSS, ".theme-dracula-dark", "color-secondary", "#404050");
    const failures = gradeMutant(css);
    expect(failures.join("\n")).toMatch(/claims ONE step but carries 2 colours/);
  });

  it("fails a declared surface token nobody classified on the ladder", () => {
    // THE MECHANISM: the classifier enumerates the block's DECLARATIONS against the
    // pattern, not the group list. So a surface that exists but was never placed on
    // a rung is named — which is how a new region token cannot slip in ungraded and
    // a renamed one cannot quietly vanish from the table.
    const unclassified: PaletteSpec = {
      ...draculaSpec,
      modes: {
        ...draculaSpec.modes,
        dark: {
          ...draculaSpec.modes.dark!,
          ladderGroups: draculaSpec.modes.dark!.ladderGroups.map((group) => ({
            ...group,
            tokens: group.tokens.filter((t) => t !== "color-tooltip-tag"),
          })),
        },
      },
    };
    const failures = gradePalette(unclassified, {
      css: DRACULA_CSS,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
      onlyMode: "dark",
    });
    expect(
      failures.some((f) => /missing from the ladder/.test(f) && f.includes("color-tooltip-tag")),
      `expected an unclassified-surface failure, got:\n${failures.join("\n")}`,
    ).toBe(true);
  });

  it("fails text that drops below its floor, naming the token and the surface", () => {
    const css = mutateValue(DRACULA_CSS, ".theme-dracula-dark", "color-foreground", "#555559");
    const failures = gradeMutant(css);
    expect(
      failures.some((f) => f.includes("color-foreground") && /below the 4\.5 floor/.test(f)),
      `expected a floor failure for color-foreground, got:\n${failures.join("\n")}`,
    ).toBe(true);
    expect(failures.join("\n")).toMatch(/on color-background/);
  });

  it("fails an exemption whose reason has gone away (the 4.5 ratchet)", () => {
    // Dracula pins `destructive` at 4.3 on the raised step and MUST fail if it ever
    // clears 4.5 — an exemption that outlives its reason is worse than none.
    const css = mutateValue(DRACULA_CSS, ".theme-dracula-dark", "color-destructive", "#ff92df");
    const failures = gradeMutant(css);
    expect(
      failures.some((f) => f.includes("color-destructive") && /delete the 4\.3 exemption/.test(f)),
      `expected the ratchet to fire, got:\n${failures.join("\n")}`,
    ).toBe(true);
  });

  it("fails a sub-4.5 floor that does not say when it expires", () => {
    const loosened: PaletteSpec = {
      ...draculaSpec,
      modes: {
        ...draculaSpec.modes,
        dark: {
          ...draculaSpec.modes.dark!,
          raisedFloors: {
            "color-destructive": { floor: 2.0, reason: "no expiry stated" },
          },
        },
      },
    };
    const failures = gradePalette(loosened, {
      css: DRACULA_CSS,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
      onlyMode: "dark",
    });
    expect(failures.join("\n")).toMatch(/without `expiresAt`/);
  });

  it("fails a declared selection token that is missing from the block", () => {
    const css = mutateDelete(DRACULA_CSS, ".theme-dracula-dark", "color-card-selected");
    const failures = gradeMutant(css);
    expect(failures.join("\n")).toMatch(/color-card-selected/);
  });

  it("fails a block whose name the class invariant cannot see", () => {
    // `themeClassNames()` derives `theme-<id>-<mode>`; a block named anything else
    // is invisible to the single-class invariant, so it must fail HERE.
    const renamed = DRACULA_CSS.replace(/^\.theme-dracula-dark\s*\{/m, ".theme-dracula {");
    const failures = gradePalette(draculaSpec, {
      css: renamed,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
    });
    expect(failures.join("\n")).toMatch(/is not theme-dracula-<mode>/);
  });

  it("fails a graded mode with no block, and a block with no graded mode", () => {
    const noBlock = stripComments(DRACULA_CSS).replace(
      /^\.theme-dracula-dark\s*\{[\s\S]*?\}/m,
      "",
    );
    const missing = gradePalette(draculaSpec, {
      css: noBlock,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
    });
    expect(missing.join("\n")).toMatch(/declares no \.theme-\* block|grades a dark reading but/);

    const extraBlock = `${DRACULA_CSS}\n.theme-dracula-light {\n  --color-background: #ffffff;\n}\n`;
    const ungraded = gradePalette(draculaSpec, {
      css: extraBlock,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
    });
    expect(ungraded.join("\n")).toMatch(/ships a light reading the spec row does not grade/);
  });

  it("fails a declaration count that no longer matches the row", () => {
    const css = mutateDelete(DRACULA_CSS, ".theme-dracula-dark", "color-terminal-bg");
    const failures = gradeMutant(css);
    expect(failures.join("\n")).toMatch(/declares 119 tokens, the spec row pins 120/);
  });

  it("refuses to let a textUngradeable entry become a permanent skip", () => {
    // The Default palette's foreground family aliases Tailwind's oklch scale, so it
    // is genuinely ungradeable. Make it a literal hex and the harness must demand
    // it be graded — otherwise a named refusal quietly becomes the hole the old
    // hex-only parser had.
    const withLiteral = mutateValue(DEFAULT_CSS, ".theme-default-dark", "color-foreground", "#d4d4d4");
    const failures = gradePalette(defaultSpec, {
      css: withLiteral,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
      onlyMode: "dark",
    });
    expect(failures.join("\n")).toMatch(/textUngradeable names --color-foreground .* but it IS resolvable/);
  });

  it("grades the Default palette's status walls, and fails if one drifts", () => {
    // The Default palette's three status hues do NOT clear 4.5 as text — measured
    // in `palettes/default.ts` and recorded there as walls with `expiresAt`. This
    // asserts the floors are the MEASURED values: brighten `warning` past its
    // recorded wall and the ratchet must fire rather than the gate staying green on
    // a now-unnecessary exemption.
    expect(
      gradePalette(defaultSpec, {
        css: mutateValue(DEFAULT_CSS, ".theme-default-light", "color-warning", "#e07b00"),
        baseCss: BASE_CSS,
        referenceTokens: defaultReferenceTokens(BASE_CSS),
        onlyMode: "light",
      }),
    ).toEqual([]);
    const brighter = mutateValue(DEFAULT_CSS, ".theme-default-light", "color-warning", "#7a4a00");
    const failures = gradePalette(defaultSpec, {
      css: brighter,
      baseCss: BASE_CSS,
      referenceTokens: defaultReferenceTokens(BASE_CSS),
      onlyMode: "light",
    });
    expect(failures.join("\n")).toMatch(/delete the 2\.6 exemption/);
  });

  it("grades every graded text token in every Palette — a Palette cannot shrink the set", () => {
    // The set of COPY tokens the app paints is a fact about the app, so no Palette
    // row may opt a token out by omitting it; only `textUngradeable`, which the kit
    // verifies really is ungradeable, can excuse one.
    for (const spec of specs) {
      for (const mode of ["light", "dark"] as const) {
        const modeSpec = spec.modes[mode];
        if (modeSpec === undefined) continue;
        const css = readCssFile(spec.cssFile);
        const reader = cssReader(css);
        const base = cssReader(readCssFile(spec.baseCssFile));
        const map: Record<string, string> = {
          ...base.values(base.block(/^@theme\s*\{/m)),
          ...base.values(base.block(/^\.dark\s*\{/m)),
          ...reader.values(reader.block(new RegExp(`^\\.theme-${spec.id}-${mode}\\s*\\{`, "m"))),
        };
        for (const token of GRADED_TEXT_TOKENS) {
          const excused = modeSpec.textUngradeable[token] !== undefined;
          if (excused) continue;
          expect(
            map[token] !== undefined,
            `${spec.id} ${mode}: --${token} is graded by the kit but undeclared — the row must name it in textUngradeable with a reason`,
          ).toBe(true);
        }
      }
    }
  });
});

/**
 * ══ DISCOVERY IS WIRED TO THE SWEEP READER ══
 *
 * `listPaletteSpecs` is a LIST-THEN-IMPORT sweep of `src/lib/palettes`, and that
 * is the directory the live palette guard in `paletteCompleteness.test.ts` writes
 * `guardprobe.ts` into and deletes from a `finally` in ANOTHER worker. Four gate
 * files call discovery at module scope, so their listing can name a row that is
 * gone by the time the `import()` runs — measured to answer
 * `ERR_MODULE_NOT_FOUND`, the same class of failure that reddened
 * `tauriBarrel.test.ts` at the Wave-3 fan-in.
 *
 * WHY THE SKIP BRANCH IS NOT EXERCISED BY PLANTING A ROW HERE, which is the
 * obvious question and the honest answer: to drive it, a test would have to write
 * a real file into `src/lib/palettes` and delete it mid-call — becoming a SECOND
 * writer into the directory every sibling sweep reads, which is precisely the
 * hazard this change exists to remove. Trading one flake for a wider one is not a
 * fix. So the branch itself is proven deterministically in
 * `sourceSweep.test.ts`, which drives the SAME `listedModule`
 * (`ERR_MODULE_NOT_FOUND` → skipped and recorded; a module that exists and throws
 * → rethrown; the stale-glob case → rethrown loudly) against scratch files under
 * gitignored `.tmp/`. What is pinned here is the WIRING: that discovery goes
 * through that reader and reports its ledger.
 */
describe("discovery goes through the sweep reader (the guard writes into this directory)", () => {
  it("reports an EMPTY skip ledger on a healthy tree, so the ledger is real", async () => {
    // Two calls, because a ledger nobody clears or fills is indistinguishable
    // from one that is never written: the point of `skippedSpecFiles` is that a
    // skip is VISIBLE, and a permanently-empty array proves nothing until the
    // reader is shown to be the one discovery used.
    const first = await listPaletteSpecs();
    expect(skippedSpecFiles(), "a healthy tree must skip nothing").toEqual([]);
    const second = await listPaletteSpecs();
    expect(second.map((spec) => spec.id)).toEqual(first.map((spec) => spec.id));
    expect(skippedSpecFiles(), "still skipping nothing").toEqual([]);
    // And discovery really did return rows — an empty result would make the two
    // assertions above vacuous in exactly the way this repo keeps documenting.
    expect(first.length).toBeGreaterThanOrEqual(2);
  });

  it("the kit reads through sourceSweep, not a bare import (structural pin)", async () => {
    // A structural assertion, and labelled as one rather than dressed up as a
    // behavioural proof: it catches the regression this file cannot reproduce
    // locally — someone reverting discovery to a bare `await import(href)`, which
    // restores the ENOENT-shaped failure for every sibling gate.
    const kitSource = sweep.named("src/lib/paletteTestKit.ts");
    expect(kitSource).toContain("sweep.listedModule");
    expect(kitSource).not.toMatch(/await import\(href\)/);
  });
});
