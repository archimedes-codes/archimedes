import { describe, expect, it } from "vitest";
import { gradePalette, readCssFile } from "./paletteTestKit";
import { spec } from "./palettes/ayu";

/**
 * The Ayu Palette, graded IN ISOLATION.
 *
 * This file is thin ON PURPOSE and that is load-bearing, not laziness. Every
 * predicate that judges Ayu lives in `paletteTestKit.gradePalette` — the same
 * function the shared sweep in `paletteCompleteness.test.ts` runs over every row
 * it discovers in `src/lib/palettes/`. Restating the completeness / spec / ladder
 * / contrast predicates here would create a second source of truth that drifts
 * from the first, which is the exact divergence (`resolveToHex` vs `composite`)
 * the kit was extracted to delete.
 *
 * So the only thing this file adds is a TARGET: `npx vitest run
 * src/lib/ayuPalette.test.ts` grades Ayu alone, reading Ayu's own
 * `src/styles/ayu.css` through `readCssFile` — never the resolved `index.css`, so
 * it grades for real before Task 7 lands the `@import`.
 *
 * `readCssFile` is called here rather than left to the kit for one reason: it is
 * the read that produces the loudest failure. A missing file throws naming the
 * path; a grade that found nothing would look like a palette with zero tokens.
 */
describe("the Ayu palette (src/styles/ayu.css)", () => {
  it("is readable before its @import lands", () => {
    // `readCssFile` throws with the path if the file is gone, so a row pointing
    // at nothing cannot reach the grader and pass as "a block with no tokens".
    expect(readCssFile(spec.cssFile)).toContain(".theme-ayu-dark");
    expect(readCssFile(spec.cssFile)).toContain(".theme-ayu-light");
  });

  it("grades clean: completeness both directions, published hexes, ladder, contrast floors", () => {
    // `gradePalette` RETURNS failures rather than throwing, so a broken row
    // reports every problem it has instead of hiding the second behind the first.
    expect(gradePalette(spec)).toEqual([]);
  });
});
