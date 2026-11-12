import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  applySettingsTheme,
  applyThemeToDocument,
  modeOf,
  resolveMode,
  resolveTheme,
  themeClassViolations,
} from "./theme";
import {
  DEFAULT_PALETTE_ID,
  PALETTES,
  paletteClass,
  paletteFor,
  paletteModeFor,
  themeClassNames,
  type PaletteId,
  type PaletteMode,
} from "./palettes";

/** A CAPTURING matchMedia stub: `addEventListener` stores the callback so
 * the test can invoke it (a plain `vi.fn()` stub DISCARDS the callback and
 * the cleanup assertion would be vacuous). */
function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners: Record<string, () => void> = {};
  const removeEventListener = vi.fn();
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return matches;
    },
    media: q,
    addEventListener: (event: string, cb: () => void) => {
      listeners[event] = cb;
    },
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return {
    removeEventListener,
    flip: (value: boolean) => {
      matches = value;
    },
    fire: (event: string) => listeners[event]?.(),
  };
}

/**
 * THE CLASS LIST, DERIVED FROM THE REGISTRY.
 *
 * This used to be a hardcoded three-name array, and that is the bug ADR 0027's
 * central invariant died of: a fourth `.theme-*` class was INVISIBLE to the
 * filter, so two palette classes co-applied still satisfied
 * `toEqual([expected])` and the suite stayed green. `themeClassNames()` returns
 * every registered id × mode pair, so registering a Palette extends the invariant
 * automatically — the gate cannot be left behind by the thing it gates.
 */
const THEME_CLASSES = themeClassNames();

/**
 * THE PREDICATE, as `theme.ts` states it. The matrix below filters `THEME_CLASSES`
 * itself, which is the same expression in both places and so proves only that the
 * list is the list; `themeClassViolations` is the rule, and the mutation test hands
 * it a class list the production loop cannot produce.
 */
const violations = () => themeClassViolations(document.documentElement.classList);

/** Every value the persisted `palette` can hold: every REAL palette, the `null`
 *  default the Settings page writes, an out-of-enum value from a hand-edited
 *  `settings.json`, and `undefined` (a pre-feature document, and the shape every
 *  non-palette call site uses).
 *
 *  DERIVED, for the same reason as `THEME_CLASSES`: the matrix used to list
 *  `"default"` and `"dracula"` by hand and pinned `3 × 5 × 2 === 30`, so a new
 *  Palette silently joined neither the matrix nor the count. */
const PALETTES_UNDER_TEST: (string | null | undefined)[] = [
  ...PALETTES.map((palette) => palette.id),
  null,
  "bogus",
  undefined,
];
const MODES = ["light", "dark", "system"] as const;
const OS_PREFS = [true, false] as const; // prefers-color-scheme: dark?

/** Every class the tests may need to clear between cases — derived, so it cannot
 *  lag a new Palette the way the old five-argument `remove(...)` call did. */
const clearRoot = () => {
  document.documentElement.classList.remove("dark", ...THEME_CLASSES);
};

describe("applyThemeToDocument", () => {
  beforeEach(clearRoot);

  it("adds theme-default-dark AND dark for the dark mode and removes theme-default-light", () => {
    applyThemeToDocument(DEFAULT_PALETTE_ID, "dark");
    const classes = document.documentElement.classList;
    expect(classes.contains("theme-default-dark")).toBe(true);
    expect(classes.contains("dark")).toBe(true);
    expect(classes.contains("theme-default-light")).toBe(false);
  });

  it("flips all three classes when switching to the light mode", () => {
    applyThemeToDocument(DEFAULT_PALETTE_ID, "dark");
    applyThemeToDocument(DEFAULT_PALETTE_ID, "light");
    const classes = document.documentElement.classList;
    expect(classes.contains("theme-default-light")).toBe(true);
    expect(classes.contains("dark")).toBe(false);
    expect(classes.contains("theme-default-dark")).toBe(false);
  });
});

describe("modeOf — the mode half, on its own", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("maps the concrete settings themes", () => {
    expect(modeOf("dark")).toBe("dark");
    expect(modeOf("light")).toBe("light");
  });

  it("resolves 'system' to the OS scheme", () => {
    stubMatchMedia(true);
    expect(modeOf("system")).toBe("dark");
    vi.unstubAllGlobals();
    stubMatchMedia(false);
    expect(modeOf("system")).toBe("light");
  });

  it("is exported BECAUSE a code fence needs the mode without the palette", () => {
    // The reason this function was EXTRACTED from `resolveTheme`: the syntax theme
    // depends on the mode as well as the palette, and `resolveTheme` collapsed both
    // into one value. A component cannot read the answer off
    // `documentElement.classList` — that is imperative and not a React
    // subscription, so an already-mounted fence would keep the previous mode's
    // paper colour forever. So the mode must be computable from settings alone,
    // purely, which is what this asserts.
    stubMatchMedia(false);
    expect(modeOf("system")).toBe("light");
    expect(typeof modeOf("light")).toBe("string");
  });
});

describe("resolveTheme", () => {
  beforeEach(() => {
    clearRoot();
    vi.unstubAllGlobals();
  });

  it("maps the concrete themes", () => {
    expect(resolveTheme("dark")).toBe("theme-default-dark");
    expect(resolveTheme("light")).toBe("theme-default-light");
  });

  it("resolves 'system' to the OS scheme", () => {
    stubMatchMedia(true);
    expect(resolveTheme("system")).toBe("theme-default-dark");
    vi.unstubAllGlobals();
    stubMatchMedia(false);
    expect(resolveTheme("system")).toBe("theme-default-light");
  });

  it("is the CLASS, derived — so no Palette can be registered without one", () => {
    // The old function returned an `AppTheme` string union and `applyThemeToDocument`
    // translated it to a class with a hardcoded list of three `toggle` calls. Now the
    // class is `` `theme-${id}-${mode}` `` from the registry, so the set of classes
    // `applyThemeToDocument` can produce and the set the invariant enumerates are the
    // SAME expression.
    for (const palette of PALETTES) {
      for (const mode of palette.modes) {
        // `PALETTES` is typed `readonly PaletteDefinition[]`, whose `id` is
        // `string`; the literal ids live in `PaletteId`. The cast is the
        // registry-boundary assertion, not a suppression: the loop iterates the
        // registry's OWN ids, so there is nothing outside the union to sneak in.
        expect(resolveTheme(mode, palette.id as PaletteId)).toBe(
          paletteClass(palette.id, mode),
        );
      }
    }
  });
});

describe("applySettingsTheme", () => {
  beforeEach(() => {
    clearRoot();
    vi.unstubAllGlobals();
  });

  it("applies the concrete theme; the cleanup is a no-op", () => {
    const cleanup = applySettingsTheme("light");
    expect(document.documentElement.classList.contains("theme-default-light")).toBe(
      true,
    );
    expect(() => cleanup()).not.toThrow();
  });

  it("re-applies on an OS scheme change and the cleanup removes the listener", () => {
    const mm = stubMatchMedia(true);
    const cleanup = applySettingsTheme("system");
    // OS is dark → the dark theme applied.
    expect(document.documentElement.classList.contains("theme-default-dark")).toBe(
      true,
    );
    // The OS flips to light → the captured "change" listener re-applies.
    mm.flip(false);
    mm.fire("change");
    expect(document.documentElement.classList.contains("theme-default-light")).toBe(
      true,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // The cleanup removes the SAME listener.
    cleanup();
    expect(mm.removeEventListener).toHaveBeenCalledTimes(1);
    expect(mm.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});

describe("palette axis", () => {
  beforeEach(() => {
    clearRoot();
    vi.unstubAllGlobals();
  });

  it("applies dark + theme-dracula-dark for dracula over the LIGHT mode, with no default class", () => {
    applyThemeToDocument("dracula", "light");
    const classes = document.documentElement.classList;
    expect(classes.contains("dark")).toBe(true);
    expect(classes.contains("theme-dracula-dark")).toBe(true);
    expect(classes.contains("theme-default-light")).toBe(false);
    expect(classes.contains("theme-default-dark")).toBe(false);
  });

  it("removes theme-dracula-dark when the palette goes back to the default", () => {
    applyThemeToDocument("dracula", "dark");
    applyThemeToDocument("default", "dark");
    const classes = document.documentElement.classList;
    expect(classes.contains("theme-dracula-dark")).toBe(false);
    expect(classes.contains("theme-default-dark")).toBe(true);
    expect(classes.contains("dark")).toBe(true);
  });

  it("resolves dracula to its own dark reading before the mode (even 'light')", () => {
    // No `matchMedia` stub: a Palette that pins a mode must short-circuit BEFORE
    // any mode/OS-scheme resolution, so even an unimplemented `matchMedia` (jsdom)
    // cannot influence the answer.
    expect(resolveTheme("light", "dracula")).toBe("theme-dracula-dark");
    expect(resolveTheme("dark", "dracula")).toBe("theme-dracula-dark");
    expect(resolveMode("light", "dracula")).toBe("dark");
  });

  it("keeps theme-dracula-dark + dark on an OS-light machine when the theme is 'system'", () => {
    stubMatchMedia(false);
    applySettingsTheme("system", "dracula");
    const classes = document.documentElement.classList;
    expect(classes.contains("theme-dracula-dark")).toBe(true);
    expect(classes.contains("dark")).toBe(true);
    expect(classes.contains("theme-default-light")).toBe(false);
  });

  it("pins a mode from the Palette's OWN modes list, not from a name in the resolver", () => {
    // ADR 0104. "Dracula is dark-only" used to be a `palette === "dracula"` branch
    // that ran before the mode was consulted. It is now `paletteModeFor`: a Palette
    // whose `modes` lacks the requested mode answers with its own single mode. So
    // the pin is DATA, and a future Palette that ships one LIGHT reading would pin
    // light with no change to `theme.ts` at all.
    const dracula = paletteFor("dracula");
    expect(dracula.modes).toEqual(["dark"]);
    expect(paletteModeFor(dracula, "light")).toBe("dark");
    expect(paletteModeFor(dracula, "dark")).toBe("dark");
    // And the Default palette, which ships both, follows the mode.
    const fallback = paletteFor(DEFAULT_PALETTE_ID);
    expect(paletteModeFor(fallback, "light")).toBe("light");
    expect(paletteModeFor(fallback, "dark")).toBe("dark");
  });

  it("routes an unrecognised palette id to the Default palette (the measured fallback)", () => {
    // The behaviour ADR 0104 records as MEASURED rather than assumed: before the
    // registry, `resolveTheme` branched on `palette === "dracula"` and on nothing
    // else, so `"tokyonight"` was indistinguishable from `null` and the default's
    // class was applied. That is now explicit code, so it is a decision instead of
    // an accident of a single guard. The list covers the whole equivalence class —
    // a wrong case, an empty string, an unknown scheme, and the value a
    // `settings.json` written before the rename carries, which is just another
    // member of it: `paletteFor` has no branch that treats that one specially.
    for (const id of ["solarized", "", "DEFAULT", "Dracula", "tokyonight"]) {
      expect(paletteFor(id).id, `palette=${JSON.stringify(id)}`).toBe(DEFAULT_PALETTE_ID);
    }
    expect(paletteFor(null).id).toBe(DEFAULT_PALETTE_ID);
    expect(paletteFor(undefined).id).toBe(DEFAULT_PALETTE_ID);
  });
});

/**
 * THE central hazard of ADR 0027, stated in `theme.ts`'s own comment and in the
 * ADR: every palette block is a single-class selector of EQUAL specificity, so if
 * two `.theme-*` classes ever co-exist on `<html>` the winner is decided by
 * SOURCE ORDER in `index.css` — silently, and it flips on any reorder. Nothing
 * here before this matrix enforced that: `theme.ts` toggled every theme class
 * with explicit booleans, and dropping the `!dracula` guard from the two default
 * toggles (so `theme-default-dark` and `theme-dracula-dark` co-applied) left 113
 * tests green — because the filter that was supposed to catch it iterated a
 * hardcoded three-name array.
 *
 * So: exhaust the state space (mode × palette × OS scheme), and in every cell
 * assert (a) EXACTLY ONE `.theme-*` class out of the DERIVED list, (b) `dark`
 * present iff the resolved mode is dark, and (c) WHICH class it is. A cell that
 * asserted only "not two" would still pass if a toggle were dropped entirely, so
 * the expected class is named, not counted around.
 */
describe("the class invariant: exactly ONE .theme-* class, in every state", () => {
  beforeEach(() => {
    clearRoot();
    vi.unstubAllGlobals();
  });

  for (const mode of MODES) {
    for (const palette of PALETTES_UNDER_TEST) {
      for (const osDark of OS_PREFS) {
        const label = `${mode} / palette=${JSON.stringify(palette)} / OS ${osDark ? "dark" : "light"}`;
        it(`applies exactly one theme class for ${label}`, () => {
          stubMatchMedia(osDark);
          const settings = applySettingsTheme(mode, palette as PaletteId | null | undefined);

          const root = document.documentElement;
          const present = THEME_CLASSES.filter((c) => root.classList.contains(c));
          // A Palette that ships one reading pins it, so neither the mode nor the OS
          // scheme behind `"system"` decides it; a Palette with two readings defers
          // to the resolved mode.
          const definition = paletteFor(palette);
          const appliedMode = paletteModeFor(definition, modeOf(mode));
          const expected = paletteClass(definition.id, appliedMode);

          expect(present, `theme classes present for ${label}`).toEqual([expected]);
          expect(root.classList.contains("dark")).toBe(appliedMode === "dark");
          settings(); // the cleanup must not throw
          vi.unstubAllGlobals();
        });
      }
    }
  }

  it("also holds when applyThemeToDocument is driven directly (the boot-path entry point)", () => {
    // The same invariant from the other entry point: `main.tsx` and the error path
    // in `loadAndApplySettings` call this one, and a caller may hand it a mode the
    // palette does not ship (the resolution lives upstream).
    for (const mode of ["light", "dark"] as const) {
      for (const palette of [...PALETTES.map((p) => p.id), null, undefined] as PaletteId[]) {
        clearRoot();
        applyThemeToDocument(palette, mode);
        const present = THEME_CLASSES.filter((c) =>
          document.documentElement.classList.contains(c),
        );
        expect(present, `palette=${JSON.stringify(palette)} mode=${mode}`).toHaveLength(1);
      }
    }
  });

  it("is not a vacuous matrix (every palette, every mode, every OS scheme is covered)", () => {
    // A gate that skips everything and a gate that passes are the same green. The
    // old pin was `toBe(30)` — a literal that a new Palette left stale in prose
    // while the count quietly grew. It is now the PRODUCT of the same lists the
    // matrix iterates, so it can only fail by the lists themselves shrinking.
    expect(MODES.length * PALETTES_UNDER_TEST.length * OS_PREFS.length).toBe(
      3 * PALETTES_UNDER_TEST.length * 2,
    );
    expect(PALETTES_UNDER_TEST.length).toBe(PALETTES.length + 3);
    // And the real coverage claim: every class the registry can produce is reached
    // by at least one cell. A derived list that nothing ever applies is a filter
    // that gates nothing.
    const reached = new Set<string>();
    for (const mode of MODES) {
      for (const palette of PALETTES_UNDER_TEST) {
        for (const osDark of OS_PREFS) {
          stubMatchMedia(osDark);
          applySettingsTheme(mode, palette as PaletteId | null | undefined);
          for (const candidate of THEME_CLASSES) {
            if (document.documentElement.classList.contains(candidate)) reached.add(candidate);
          }
          vi.unstubAllGlobals();
        }
      }
    }
    expect([...reached].sort(), "every registered class must be reachable").toEqual([
      ...THEME_CLASSES,
    ].sort());
    // And the registry really does hold the two shipped Palettes — so the
    // derivation is being exercised, not stubbed.
    expect(THEME_CLASSES.length).toBe(
      PALETTES.reduce((total, palette) => total + palette.modes.length, 0),
    );
    expect(THEME_CLASSES).toContain("theme-default-light");
    expect(THEME_CLASSES).toContain("theme-default-dark");
    expect(THEME_CLASSES).toContain("theme-dracula-dark");
  });

  it("catches TWO classes co-applied, which the hardcoded name list could not see", () => {
    // THE gate ADR 0027's own doc-comment says was blind. `applyThemeToDocument`
    // toggles every derived class with an explicit boolean, so the invariant holds
    // by construction — but a construction is only as good as the assertion that
    // watches it. This plants the exact failure (a sibling palette class left on
    // `<html>`) and requires the matrix's own filter to report two classes.
    clearRoot();
    applyThemeToDocument("dracula", "dark");
    // Simulate the regression: a `toggle` that lost its boolean and became an `add`,
    // leaving the default class alongside Dracula's.
    document.documentElement.classList.add("theme-default-dark");
    const present = THEME_CLASSES.filter((c) =>
      document.documentElement.classList.contains(c),
    );
    expect(present.length, `co-applied classes: ${present.join(", ")}`).toBeGreaterThan(1);
    // And prove the DERIVATION is what catches it: a hardcoded list that omitted
    // `theme-dracula-dark` — the shape this file had — would have seen one class
    // and passed. The assertion below is that statement, made about the old list.
    const hardcoded = ["theme-default-light", "theme-default-dark"];
    const blind = hardcoded.filter((c) =>
      document.documentElement.classList.contains(c),
    );
    expect(blind, "the old hardcoded filter would have reported exactly one class").toEqual([
      "theme-default-dark",
    ]);
  });

  it("fails a MUTATED applier that leaves two classes on <html> (the gate is not merely untriggered)", () => {
    // The acceptance criterion this file exists for, made into a mutation rather
    // than a plant. Copying `applyThemeToDocument` and turning its last `toggle`
    // into an `add` reproduces the exact regression ADR 0027 records; the gate must
    // REPORT it. Asserting only that the shipped function produces one class would
    // be the same green as a gate that detects nothing, which is the failure mode
    // this repo has now written down three times.
    const applyWithTheBug = (palette: PaletteId | null | undefined, mode: PaletteMode): void => {
      const root = document.documentElement;
      const definition = paletteFor(palette);
      const applied = paletteModeFor(definition, mode);
      // THE MUTATION: `add` instead of `toggle(candidate, candidate === className)`.
      // It still compiles, it still applies the right class, and it leaves the
      // previous Palette's class in place — which is precisely why a construction
      // needs a predicate watching it.
      root.classList.add(paletteClass(definition.id, applied));
      root.classList.toggle("dark", applied === "dark");
    };

    clearRoot();
    applyThemeToDocument("default", "dark");
    expect(violations(), "the shipped applier must produce no violation").toEqual([]);

    applyWithTheBug("dracula", "dark");
    const found = violations();
    expect(
      found.length,
      "the mutated applier co-applied two palette classes and nothing reported it",
    ).toBe(1);
    // The message names BOTH classes and says what decides the winner, so a reader
    // sees the mechanism and not just a count.
    expect(found[0]).toContain("theme-default-dark");
    expect(found[0]).toContain("theme-dracula-dark");
    expect(found[0]).toMatch(/SOURCE ORDER/);
    // And the same pair through the SHIPPED applier is clean, so the predicate is
    // sensitive to the difference rather than rejecting everything.
    clearRoot();
    applyThemeToDocument("dracula", "dark");
    expect(violations()).toEqual([]);
    clearRoot();
  });

  it("enumerates every registered class, so a fourth Palette cannot escape the invariant", () => {
    // The mechanism behind the fix, asserted directly: the predicate's list is the
    // registry's list. A synthetic "fourth Palette" class is invisible to the OLD
    // three-name filter and visible to the derived one — which is the whole claim,
    // stated without waiting for someone to register a Palette.
    //
    // THIS TEST USED TO HAVE TO DEFER ITS BEST HALF. It paired
    // `theme-default-dark` with `theme-catppuccin-dark` and could only assert
    // `themeClassViolations` returned NO violation, because Catppuccin was not
    // registered and the predicate — which filters `themeClassNames()` — could not
    // see the name. Now that the closeout registers Catppuccin the same pair is a
    // REAL co-application and the predicate reports it, so the deferred half is
    // asserted for real: the old three-name filter still sees one class and passes,
    // the derivation sees two and fails. Note the asymmetry that exposes: a class
    // OUTSIDE the registry is invisible to the predicate, so this demonstration only
    // bites once a Palette is registered — which is precisely the day it needs to.
    const legacyFilter = ["theme-default-light", "theme-default-dark", "theme-dracula-dark"];
    const synthetic = ["theme-default-dark", "theme-catppuccin-dark"];
    expect(
      legacyFilter.filter((name) => synthetic.includes(name)).length,
      "the hardcoded three-name filter saw one class and passed",
    ).toBe(1);
    const found = themeClassViolations(synthetic);
    expect(
      found.length,
      "two registered palette classes co-applied and nothing reported it",
    ).toBe(1);
    expect(found[0]).toContain("theme-default-dark");
    expect(found[0]).toContain("theme-catppuccin-dark");
    expect(THEME_CLASSES.length).toBe(
      PALETTES.reduce((total, palette) => total + palette.modes.length, 0),
    );
    // Non-vacuity of the derivation: the sweep is not looping over a short list
    // that happens to satisfy the count above.
    expect(THEME_CLASSES.length).toBeGreaterThan(3);
  });
});
