import {
  paletteClass,
  paletteFor,
  paletteModeFor,
  themeClassNames,
  type PaletteId,
  type PaletteMode,
  type SettingsTheme,
} from "./palettes";

export type { PaletteId, PaletteMode, SettingsTheme };

const DARK_QUERY = "(prefers-color-scheme: dark)";

function osPrefersDark(): boolean {
  // jsdom does not implement `window.matchMedia` — default to dark (the
  // app's existing default).
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * The MODE half of the resolution, on its own: `"system"` → the OS query,
 * otherwise the concrete mode.
 *
 * EXTRACTED rather than left inside `resolveTheme`, because a code fence needs
 * exactly this and nothing else. `resolveTheme` collapsed mode with palette into
 * one value, so `AgentMarkdown` / `CodemodeCard` could not ask "which reading am I
 * painting on" without also taking the palette — and both call sites subscribed to
 * `palette` alone, so a code fence under the Default palette in LIGHT mode had no
 * way to know it was light. Reading the answer off `document.documentElement`
 * instead would be worse than not reading it: `classList` is imperative and is not
 * a React subscription, so an already-mounted fence would keep the previous mode's
 * paper colour forever.
 *
 * Pure and DOM-light on purpose (one `matchMedia` call), so it stays assertable
 * without rendering anything — the same reason `shikiThemeFor` is exported.
 */
export function modeOf(theme: SettingsTheme): PaletteMode {
  if (theme === "system") return osPrefersDark() ? "dark" : "light";
  return theme === "dark" ? "dark" : "light";
}

/**
 * The reading that actually applies, given the settings mode AND the palette.
 *
 * A Palette that does not ship the requested mode answers with its own single
 * mode — that is what "Dracula pins dark" became (ADR 0104). It used to be a
 * `palette === "dracula"` branch that ran BEFORE the mode was even consulted; now
 * it is a property of the Palette's `modes` list, so a Palette that ships one
 * light reading pins light with no code change, and a Palette that ships both
 * follows the mode.
 */
export function resolveMode(
  theme: SettingsTheme,
  palette?: PaletteId | null,
): PaletteMode {
  const definition = paletteFor(palette);
  return paletteModeFor(definition, modeOf(theme));
}

/**
 * Resolve a settings theme + palette to the CSS class `<html>` wears.
 *
 * An out-of-vocabulary `palette` — a hand-edited `"solarized"`, or the value a
 * `settings.json` written before the rename carries — resolves to Default's class, which
 * is `paletteFor`'s documented behaviour rather than a branch here. The mode is
 * still honoured for it, which is exactly what the measured fallback did before
 * the registry existed.
 */
export function resolveTheme(
  theme: SettingsTheme,
  palette?: PaletteId | null,
): string {
  const definition = paletteFor(palette);
  return paletteClass(definition.id, resolveMode(theme, palette));
}

/**
 * How many `.theme-*` classes a class list carries, and why more than one is a
 * defect rather than a style choice.
 *
 * THE INVARIANT, not a count: every palette block is a single-class selector of
 * EQUAL specificity, so two co-existing on `<html>` would be resolved by SOURCE
 * ORDER in the assembled stylesheet — silently, and flipping on any reorder. ADR
 * 0027's central hazard, and the one its own gate could not see: the check was a
 * `filter` over a hardcoded three-name array, so a fourth class was invisible and
 * `toEqual([expected])` still passed with two classes applied.
 *
 * EXPORTED, AND DELIBERATELY NOT DOM-BOUND, for two reasons. (1) It is the
 * assertion's whole point, so a test can hand it a class list that `applyThemeToDocument`
 * could never produce — the co-applied pair — and require it to report a violation
 * rather than merely observe that the current code does not produce one. (2) It
 * enumerates `themeClassNames()`, so registering a Palette extends it: the class
 * that the old hardcoded list could not see is now the class the derivation cannot
 * miss.
 */
export function themeClassViolations(classes: Iterable<string>): string[] {
  const present = new Set(classes);
  const applied = themeClassNames().filter((name) => present.has(name));
  if (applied.length <= 1) return [];
  return [
    `${applied.length} palette classes are applied at once (${applied.join(", ")}) — every palette block is a single-class selector of equal specificity, so which one wins would be decided by SOURCE ORDER, silently and reversibly. At most one may be present (ADR 0027).`,
  ];
}

/**
 * Apply the resolved theme + palette to `<html>`.
 *
 * Takes the two axes SEPARATELY (`palette`, `mode`) rather than one collapsed
 * `AppTheme` string, because the collapsed form is what made the class name a
 * hardcoded list three lines long: with `(palette, mode)` the class is derived as
 * `` `theme-${palette}-${mode}` `` and the set of classes the function knows about
 * is `themeClassNames()` — the registry — so registering a Palette cannot leave a
 * class that is never toggled off.
 *
 * (ADR 0027) At most ONE `.theme-*` class may ever be present: every palette block
 * is a single-class selector of equal specificity, so two co-existing would be
 * resolved by SOURCE ORDER in the resolved `index.css` — silently, and it would
 * flip on any reorder. Hence EVERY class in `themeClassNames()` is `toggle`d
 * (never `add`ed), each with an explicit boolean. That makes the invariant a rule
 * about the loop rather than a count of the names. The loop is the CONSTRUCTION
 * and `themeClassViolations` is the ASSERTION over its result: the predicate is
 * handed a class list the loop could never produce (the co-applied pair) and must
 * report a violation, so the gate is proven to detect the bug rather than merely
 * to be untriggered by the current code. That is the difference the mutation in
 * `theme.test.ts` demonstrates.
 */
export function applyThemeToDocument(
  palette: PaletteId | null | undefined,
  mode: PaletteMode,
): void {
  const root = document.documentElement;
  const definition = paletteFor(palette);
  const applied = paletteModeFor(definition, mode);
  const className = paletteClass(definition.id, applied);
  // Mirrors ZCode's useTheme.ts:66-68 — the `dark` class is toggled ALONGSIDE
  // the theme classes because the ported primitives use `dark:` utilities,
  // which (via the `@custom-variant dark` definition in src/styles/base.css) key off
  // the `.dark` class; without the toggle they would never apply. Note this reads
  // the PINNED mode, so a Palette that ships only a dark reading lands on `.dark`
  // whatever the settings said.
  root.classList.toggle("dark", applied === "dark");
  for (const candidate of themeClassNames()) {
    root.classList.toggle(candidate, candidate === className);
  }
}

/**
 * Apply a settings theme + palette: resolve + `applyThemeToDocument`. Returns a
 * cleanup function. For "system" it subscribes a `matchMedia` "change" listener
 * that re-applies live (the listener is removed by the cleanup). For concrete
 * themes the cleanup is a no-op function. The `palette` is threaded through the
 * listener so an OS flip under a Palette with two readings keeps working, and
 * under a Palette with one keeps resolving to that reading.
 */
export function applySettingsTheme(
  theme: SettingsTheme,
  palette?: PaletteId | null,
): () => void {
  applyThemeToDocument(palette, resolveMode(theme, palette));
  if (theme !== "system" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);
  const onChange = () =>
    applyThemeToDocument(palette, resolveMode("system", palette));
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
