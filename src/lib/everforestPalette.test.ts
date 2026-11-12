import { describe, expect, it } from "vitest";
import { gradePalette, readCssFile } from "./paletteTestKit";
import { spec } from "./palettes/everforest";

/**
 * Everforest, graded in ISOLATION.
 *
 * Thin on purpose, and that is its whole design. Every predicate it runs —
 * completeness in BOTH directions against `.theme-default-dark`, "every declared
 * hex is one `palette.md` publishes or is named by a per-token entry in
 * `offSpecAllowList`", the elevation ladder (strictly ascending for the dark
 * reading, non-decreasing with a top-only plateau for the light one), the
 * selection rule, the three text-contrast classes with their `expiresAt`
 * ratchets — lives in `paletteTestKit.gradePalette`, and the shared sweep in
 * `paletteCompleteness.test.ts` discovers `src/lib/palettes/everforest.ts` and
 * runs the SAME function on it. Re-stating any of them here would put a second
 * copy of the ladder table and the floor table in the repo, and the two would
 * drift; `paletteTestKit.ts`'s header records exactly that divergence as the
 * reason the kit was extracted out of the four pre-kit gate files.
 *
 * What this file buys is the ability to grade ONE palette without the rest of the
 * suite: `npx vitest run src/lib/everforestPalette.test.ts`. That is how a Palette
 * gets iterated on, and it is what lets the authoring waves run in parallel.
 *
 * It needs no `@import` in `src/index.css` and no registry entry. `gradePalette`
 * opens `spec.cssFile` directly — never the resolved stylesheet — so this row is
 * graded from the day its own file lands. Registration is the next task's; the
 * wiring gates enumerate the REGISTRY, which this Palette has not touched.
 *
 * The first `it` is the non-vacuity check for THIS file: the second one asserts
 * `gradePalette` returns no failures, and a grader that found no blocks to grade
 * would be a very quiet pass. Pinning that the row names two readings and that the
 * file it points at really declares both of them is what makes the empty list
 * below mean "graded and clean" rather than "nothing was looked at". Observed
 * failing: with `src/styles/everforest.css` reduced to a single comment, both
 * assertions fail, the second one naming
 * `everforest: src/styles/everforest.css declares no .theme-* block`.
 */
describe("the Everforest palette (hard dark + medium light)", () => {
  it("is a real row over a real file, so the grading below cannot be vacuous", () => {
    expect(spec.id).toBe("everforest");
    expect(spec.cssFile).toBe("src/styles/everforest.css");
    // Both readings the row claims are graded, and neither is an empty object.
    expect(Object.keys(spec.modes).sort()).toEqual(["dark", "light"]);
    for (const mode of ["dark", "light"] as const) {
      const modeSpec = spec.modes[mode];
      expect(modeSpec, `${mode}: the row grades no ${mode} reading`).toBeTruthy();
      expect(modeSpec!.ladderGroups.length, `${mode}: no ladder groups`).toBeGreaterThan(1);
      expect(
        modeSpec!.declaredCount,
        `${mode}: a row that pins zero declarations grades nothing`,
      ).toBeGreaterThan(0);
    }
    // The file exists and is readable through the kit's own reader, which throws a
    // named error rather than returning an empty block for a missing file.
    const css = readCssFile(spec.cssFile);
    expect(css).toMatch(/^\.theme-everforest-dark\s*\{/m);
    expect(css).toMatch(/^\.theme-everforest-light\s*\{/m);
  });

  it("grades clean: completeness both directions, published hexes, ladder, contrast floors", () => {
    // `gradePalette` RETURNS failures rather than throwing, so a Palette with three
    // problems reports three instead of hiding the second behind the first.
    expect(gradePalette(spec)).toEqual([]);
  });
});
