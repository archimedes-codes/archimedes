import { describe, expect, it } from "vitest";
import {
  cssReader,
  gradePalette,
  readCssFile,
} from "./paletteTestKit";
import { flavourHexes, spec as catppuccin } from "./palettes/catppuccin";

/**
 * THE CATPPUCCIN PALETTE, GRADED IN ISOLATION.
 *
 * This file is deliberately almost empty. Every predicate that grades a Palette
 * — completeness in both directions against `.theme-default-dark`, "every
 * declared hex is published or allow-listed by name", the elevation ladder, the
 * contrast floors — lives in `paletteTestKit.gradePalette`, and the shared sweep
 * in `paletteCompleteness.test.ts` runs it over `listPaletteSpecs()`, which
 * discovers `src/lib/palettes/catppuccin.ts` by reading the directory. A second
 * copy of those predicates here would be a second source of truth, and the day
 * the kit tightened a rule this file would stay green while the shared sweep went
 * red — the exact drift the harness exists to prevent.
 *
 * What this file is FOR: `npx vitest run src/lib/catppuccinPalette.test.ts`
 * grades ONE Palette in seconds, reading `spec.cssFile` — Catppuccin's own
 * `src/styles/catppuccin.css` — so it works with no `@import` in `src/index.css`
 * (registration is Task 7). That is the whole authoring loop: change a hex,
 * re-run this one file.
 *
 * It also fails LOUDLY on the two ways a Palette row goes missing rather than
 * wrong: a CSS file that cannot be read (`readCssFile` throws with the path) and
 * a row that grades a reading its file does not declare (`gradePalette` reports
 * it by selector). Both are asserted here as well as inside the grade, because
 * the first is a module-level throw that would otherwise look like a broken
 * import.
 */
describe("the Catppuccin palette (Mocha + Latte)", () => {
  it("owns a CSS file that can be read before any @import exists (the Wave-3 property)", () => {
    expect(readCssFile(catppuccin.cssFile)).toContain(".theme-catppuccin-");
  });

  it("grades clean: completeness both directions, published hexes, ladder, contrast floors", () => {
    // Failures are RETURNED, not thrown, so a Palette with five problems reports
    // five. `toEqual([])` prints every one of them.
    expect(gradePalette(catppuccin)).toEqual([]);
  });

  /**
   * EACH READING USES ONLY ITS OWN FLAVOUR'S HEXES — the property the kit cannot
   * check, so this file owns it.
   *
   * `publishedHexes` is per-PALETTE by contract, so the hex gate pools both
   * flavours and can only ask "is this a Catppuccin hex". A reading wearing the
   * OTHER flavour's colour passes it. That is not hypothetical: Latte's
   * `--color-find-highlight` was `#89dceb`, which is Mocha's Sky — published, so
   * the gate was green, and wrong, because Latte's own Sky is `#04a5e5`. A
   * flavour is not a colour scheme you may mix across: the two tables are
   * separate publications of the same 26 NAMES, and a light block holding a dark
   * flavour's pastel is a transcription error no shared gate can see.
   */
  it("keeps each reading inside its own flavour's table (the pooled-hex blind spot)", () => {
    const reader = cssReader(readCssFile(catppuccin.cssFile));
    for (const mode of ["dark", "light"] as const) {
      const selector = `.theme-catppuccin-${mode}`;
      const body = reader.block(new RegExp(`^\\${selector}\\s*\\{`, "m"));
      const own = new Set(flavourHexes[mode].map((h) => h.toLowerCase()));
      // The off-spec allow-list is exempt for the same reason the kit exempts it:
      // those are Identity hues copied from `.theme-default-dark`, not flavour
      // colours. `file-css` is deliberately NOT exempt — it takes the flavour's
      // own Purple, so it must be caught by this check like any other declaration.
      // (`values()` strips comments itself, so a hex named in prose is not read
      // as a declaration — see `cssReader`'s doc-comment.)
      const offenders = Object.entries(reader.values(body))
        .filter(([token]) => catppuccin.offSpecAllowList[token] === undefined)
        .flatMap(([token, value]) =>
          (value.match(/#[0-9a-fA-F]{6}/g) ?? [])
            .map((h) => h.toLowerCase())
            .filter((h) => !own.has(h))
            .map((h) => `--${token}: ${h}`),
        );
      expect(offenders, `${selector} declares hexes its own flavour does not publish`).toEqual([]);
    }
  });
});
