import { describe, expect, it } from "vitest";
import { gradePalette, readCssFile } from "./paletteTestKit";
import { spec } from "./palettes/kanagawa";

/**
 * Kanagawa, graded in ISOLATION.
 *
 * This file is thin on purpose and that is its whole design. Every predicate —
 * completeness in both directions against `.theme-default-dark`, "every declared
 * hex is one Kanagawa publishes or is allow-listed by name", the elevation ladder,
 * the selection rule, the three text-contrast classes — lives in
 * `paletteTestKit.gradePalette` and runs over EVERY row in `src/lib/palettes/`
 * from the shared sweep in `paletteCompleteness.test.ts`. Re-stating one of them
 * here would create a second source of truth that drifts from the first, which is
 * the divergence this kit was extracted to remove.
 *
 * What this file buys is the ability to grade ONE palette without the rest of the
 * suite: `npx vitest run src/lib/kanagawaPalette.test.ts`. That is how a Palette
 * gets iterated on, and it is the reason the authoring waves can run in parallel.
 *
 * It needs no `@import`. `gradePalette` opens `spec.cssFile` directly — never the
 * resolved `index.css` — so this row is graded from the day its own file lands and
 * not the day Task 7 wires it in. Registration is Task 7's; the wiring gates
 * enumerate the REGISTRY, which this Palette has not touched.
 */
describe("the Kanagawa palette (wave + lotus)", () => {
  it("is a real row over a real file, so the grading below cannot be vacuous", () => {
    expect(spec.id).toBe("kanagawa");
    expect(spec.cssFile).toBe("src/styles/kanagawa.css");
    // Both readings the row claims are graded, and neither is an empty object.
    expect(Object.keys(spec.modes).sort()).toEqual(["dark", "light"]);
    for (const mode of ["dark", "light"] as const) {
      const modeSpec = spec.modes[mode];
      expect(modeSpec, `${mode}: the row grades no ${mode} reading`).toBeTruthy();
      expect(modeSpec!.ladderGroups.length, `${mode}: no ladder groups`).toBeGreaterThan(1);
      expect(modeSpec!.declaredCount, `${mode}: a row that pins zero declarations`).toBeGreaterThan(0);
    }
    // The file exists and is readable through the kit's own reader, which throws a
    // named error rather than returning an empty block for a missing file.
    expect(readCssFile(spec.cssFile)).toContain(".theme-kanagawa-");
  });

  it("grades clean: completeness both directions, published hexes, ladder, contrast floors", () => {
    // `gradePalette` RETURNS failures rather than throwing, so a Palette with three
    // problems reports three instead of hiding the second behind the first.
    expect(gradePalette(spec)).toEqual([]);
  });
});
