import { describe, expect, it } from "vitest";
import { gradePalette, readCssFile } from "./paletteTestKit";
import { spec } from "./palettes/rose-pine";

/**
 * Rosé Pine (main + dawn), graded in isolation.
 *
 * THIN ON PURPOSE. Every predicate lives in `paletteTestKit.gradePalette` and the
 * shared sweep in `paletteCompleteness.test.ts` discovers `src/lib/palettes/rose-pine.ts`
 * and runs the SAME function on it. A second copy of the ladder / floor /
 * published-hex assertions here would be a second source of truth, and the two
 * would drift — which is the failure `paletteTestKit.ts`'s header records for the
 * four pre-kit gate files.
 *
 * What this file buys is a one-palette iteration loop:
 * `npx vitest run src/lib/rosePinePalette.test.ts` grades Rosé Pine alone, with no
 * sibling's row present and no `@import` in `src/index.css` — per-Palette grading
 * reads `spec.cssFile`, never the resolved stylesheet.
 *
 * The file name is camelCase because the Palette id contains a hyphen
 * (`rose-pine`, and the CSS classes `.theme-rose-pine-dark` /
 * `.theme-rose-pine-light` keep it too); a hyphenated TypeScript module name is
 * awkward to import.
 */
describe("the Rosé Pine palette (main + dawn)", () => {
  it("declares both readings in the file its own row names", () => {
    // Presence, so a missing block fails with THIS file's name on it rather than
    // surfacing only as one entry inside `gradePalette`'s returned list.
    const css = readCssFile(spec.cssFile);
    expect(css).toMatch(/^\.theme-rose-pine-dark\s*\{/m);
    expect(css).toMatch(/^\.theme-rose-pine-light\s*\{/m);
  });

  it("grades clean: completeness both directions, published hexes, ladder, contrast floors", () => {
    expect(gradePalette(spec)).toEqual([]);
  });
});
