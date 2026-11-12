import { spec as DEFAULT_SPEC } from "../../../lib/palettes/default";
import type { PaletteSpec } from "../../../lib/paletteSpec";

/**
 * ══ THE WAVE-3 FIXTURE: a THIRD Palette row that is graded and NOT registered ══
 *
 * THE STATE IT ENCODES. `docs/roadmap/more-palettes.md` Tasks 3–6 each add
 * `src/styles/<id>.css` + `src/lib/palettes/<id>.ts` and touch NEITHER
 * `src/index.css` NOR `src/lib/palettes.ts` — registration is Task 7. So mid-plan
 * there is a spec row, there is a CSS file, and there is no registry entry and no
 * `@import`. No test in this repo asserted that state, which is why three gates in
 * `paletteCompleteness.test.ts` were free to conflate per-Palette grading (kind (a),
 * which must read a Palette's OWN file) with cross-Palette wiring (kind (b), which
 * must enumerate the REGISTRY). The orchestrator's throwaway probe — a `probe` row
 * plus `probe.css` — reddened all three. This fixture makes that state a permanent,
 * automated case instead of a manual step.
 *
 * WHY IT LIVES HERE AND NOT IN `src/lib/palettes/`. The kit's discovery
 * (`listPaletteSpecs`) is a directory sweep of `src/lib/palettes`, so a row placed
 * there becomes a row the WHOLE suite discovers — which is the wrong test: it would
 * demand that every other gate tolerate a fake Palette, and it would leave a fake
 * Palette in the shipped directory. The kit is frozen for Wave 3, so rather than
 * add an injection seam to it, the fixture sits outside the swept directory and
 * `paletteCompleteness.test.ts` passes it to its OWN derivation functions
 * (`gradeLayersFor`, `nestingFailures`) and to the kit's pure `gradePalette`, which
 * already takes text overrides. No kit change, no leftover row, same coverage.
 *
 * WHY THE BLOCK IS A RENAME OF `.theme-default-dark` RATHER THAN AN INVENTION.
 * `gradePalette` must return ZERO failures for this row. A fixture that already
 * fails cannot tell "graded and clean" apart from "skipped", and skipping is the
 * exact failure mode the plan names: "the gate must skip unimported specs, which
 * makes the checks vacuous for exactly the Palettes they exist to grade." So the
 * fixture is byte-identical to Default's dark reading modulo the selector, and the
 * row below is that reading — the completeness reference, the ladder, the floors and
 * the named-ungradeable set all hold by construction rather than by assertion-copy.
 * THE MUTATION GATE is what then proves the grading is real: change one hex in the
 * fixture's own CSS and ITS grading must fail, naming the token.
 *
 * THE ONE THING THAT MUST NEVER HAPPEN: nothing may `@import`
 * `wave3probe.css`. `paletteCompleteness.test.ts` asserts it, because the moment
 * this Palette is wired the fixture stops describing Wave 3 and starts shipping.
 */

/** The fixture's CSS, relative to the repo root — deliberately NOT under
 *  `src/styles/`, so no `@import` of a sibling can pick it up by accident. */
export const WAVE3_PROBE_CSS_FILE = "src/test/fixtures/palettes/wave3probe.css";

/** The id. `wave3probe` and not `probe`, so it cannot shadow a future real Palette
 *  id and so a grep for it finds the fixture and nothing else. */
export const WAVE3_PROBE_ID = "wave3probe";

/**
 * The row. One DARK reading — the mode whose block the fixture file declares.
 *
 * The reading is DEFAULT's, spread rather than re-typed, for two reasons. The
 * first is honesty: the fixture's block IS Default's block, so restating the ladder
 * and the floors here would be a second copy of facts already pinned in
 * `src/lib/palettes/default.ts`, and a second copy is a thing that drifts. The
 * second is the drift alarm: `declaredCount` and `inheritedFromDefault` stay
 * Default's values, so the day a token is added to `.theme-default-dark` the
 * fixture's (static) CSS file is short one token and `gradePalette` fails with
 * "a token this Palette forgot" — a loud, named failure, not a fixture that has
 * quietly stopped resembling a Palette.
 */
export const spec: PaletteSpec = {
  id: WAVE3_PROBE_ID,
  cssFile: WAVE3_PROBE_CSS_FILE,
  baseCssFile: DEFAULT_SPEC.baseCssFile,
  specSourceUrl:
    "TEST FIXTURE — no source. `.theme-wave3probe-dark` is a rename of `.theme-default-dark` and publishes exactly what Default publishes",
  // The fixture's block is Default's dark block, so every hex it carries is one
  // Default already publishes. Reusing the list rather than copying it is what
  // keeps the fixture's spec gate honest when Default gains a hue.
  publishedHexes: DEFAULT_SPEC.publishedHexes,
  // Empty, like Default's: a fixture whose values are all on-record has nothing to
  // forgive, and the kit fails any allow-list entry that excuses no declaration.
  offSpecAllowList: {},
  modes: {
    // No light reading. The fixture declares one block, and a graded mode with no
    // block is a hard failure in the kit — so the light slot is `undefined`, the
    // same shape Dracula's row uses for the reading it does not ship.
    light: undefined,
    dark: DEFAULT_SPEC.modes.dark!,
  },
};
