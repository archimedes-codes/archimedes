/**
 * The **Palette registry** — the app-side source of truth for
 * id → label → available modes → Shiki theme → CSS class.
 *
 * WHY A REGISTRY AND NOT A UNION PLUS A TERNARY. Before this file existed the
 * Palette vocabulary was spread across four places that each had to be edited in
 * step and none of which could see the others: the `AppPalette` union,
 * `PALETTE_OPTIONS` in the Settings picker, the `palette === "dracula"` branch in
 * `theme.ts`, and `shikiThemeFor`'s two-arm ternary. Measured consequences
 * (`docs/research/five-more-palettes-and-the-default-rename.md` §4, all four
 * re-verified): a new Palette silently rendered `github-dark` code, the picker's
 * save rule wrote `"dracula"` for a third Palette's selection, and the class
 * invariant's name list could not see a fourth class at all. A registry makes
 * the vocabulary ONE list, so "add a Palette" is one entry rather than four
 * coordinated edits, and the gates can enumerate it.
 *
 * NO NODE HERE. This module is in the shipped graph (`main.tsx` imports it), so
 * unlike `paletteTestKit.ts` it must not touch the filesystem — the test-side
 * half (`src/lib/palettes/<id>.ts`, the grading rows) is discovered by the kit,
 * not imported here. The registry says which Palettes EXIST; the spec-data
 * directory says how each is GRADED. Keeping those separate is what lets the
 * wiring gates enumerate the registry (a Palette registered without its import is
 * a defect) while the grading gates enumerate the directory (a spec row that is
 * not registered yet is just the plan's state, not a defect).
 */

/** The two readings a Palette can ship. */
export type PaletteMode = "light" | "dark";

/**
 * The Settings theme value — the MODE axis, orthogonal to the Palette axis
 * (ADR 0027). `"system"` defers to the OS query.
 */
export type SettingsTheme = "system" | "dark" | "light";

/** One Palette's entry in the registry. */
export interface PaletteDefinition {
  /** The persisted `palette` value. `null` in `settings.json` means
   *  `DEFAULT_PALETTE_ID`, so a default install stays a minimal document. */
  readonly id: string;
  /** The Settings picker's label. A Palette that later ships a second VARIANT of
   *  the same family names the variant here (ADR 0027's amendment 1). */
  readonly label: string;
  /** Which readings this Palette ships. A Palette with ONE entry pins that mode:
   *  the Theme setting is inert under it, `system` included. That pinning is a
   *  property of THIS Palette, not of the axis — ADR 0104. */
  readonly modes: readonly PaletteMode[];
  /**
   * The Shiki theme id per mode. Drives BOTH the highlighter's `themes:` list and
   * `shikiThemeFor`, so a Palette cannot be registered with a class and forget its
   * code colour — which is the exact silent-pass this registry closes (a new
   * Palette used to render `github-dark` code with a green suite).
   *
   * `undefined` means "this reading publishes no Shiki theme" and the highlighter
   * falls back to `SHIKI_FALLBACK_THEME`. That is deliberate rather than a hole:
   * every mode the registry declares SHOULD have an id, and
   * `paletteCompleteness.test.ts` asserts it — but a missing id must degrade to
   * readable code, never to a thrown `codeToHtml` swallowed by the call site's
   * bare `catch`, which is the other silent fallback this repo has already been
   * bitten by.
   */
  readonly shiki: Readonly<Record<PaletteMode, string | undefined>>;
}

/** The Palette that answers for every value the registry does not recognise. */
export const DEFAULT_PALETTE_ID = "default";

/**
 * The theme a code fence falls back to when a Palette's reading publishes no
 * Shiki id. Named rather than inlined because it is the pre-palette behaviour of
 * the app, and a fallback with no name is indistinguishable from a bug.
 */
export const SHIKI_FALLBACK_THEME = "github-dark";

/**
 * Every Palette the app offers: seven, all but Dracula shipping two readings.
 * Dracula Classic is dark-only — its light reading, Alucard Classic, is deferred,
 * not rejected (ADR 0027's amendment 1) — which is why it is the one row whose
 * `shiki.light` is `undefined` and the one row under which the Theme mode is inert.
 *
 * ORDER IS THE PICKER'S ORDER, and it is pinned by name by
 * `paletteCompleteness.test.ts` so a reorder is a decision rather than a drift.
 * `default` first because it is the value a fresh install gets; the three rows
 * that shipped before this one keep their positions so existing muscle memory does
 * not churn; the four added by the more-palettes plan land in plan order after
 * Everforest (Catppuccin, Ayu, Rosé Pine, Kanagawa — the Wave-3 authoring order,
 * Everforest having been Wave 4's own first job).
 *
 * This order affects the PICKER AND NOTHING ELSE. Palette-vs-palette CSS order is
 * inert: `src/lib/theme.ts` guarantees at most one `.theme-*` class is ever present
 * on `<html>`, so there is no tie for source order to break between two Palettes
 * (the layer-order gate states the same fact from the cascade side and declines to
 * pin the palettes' mutual order for exactly this reason).
 *
 * Written `as const satisfies` so the id LITERALS survive: `PaletteId` is derived
 * from this list, which replaces the hand-maintained `AppPalette` union. A plain
 * `readonly PaletteDefinition[]` annotation would widen every id to `string` and
 * the derivation would be vacuous — a union that accepts anything cannot catch a
 * typo, which was the whole point of having a union.
 */
const PALETTE_REGISTRY = [
  {
    id: DEFAULT_PALETTE_ID,
    label: "Default",
    modes: ["light", "dark"],
    // `github-light` for the light reading: the app had no light-mode-aware
    // mapping before (one ternary answered `github-dark` for every non-Dracula
    // Palette, so a light bubble carried dark paper), and the registry is what
    // makes asking for the right one possible.
    shiki: { light: "github-light", dark: "github-dark" },
  },
  {
    id: "dracula",
    label: "Dracula",
    // One reading → the Theme mode is inert under it (`system` included).
    modes: ["dark"],
    shiki: { light: undefined, dark: "dracula" },
  },
  {
    id: "everforest",
    label: "Everforest",
    // Two readings → the Theme mode is live under it (`system` included).
    modes: ["light", "dark"],
    shiki: { light: "everforest-light", dark: "everforest-dark" },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    // Two readings → the Theme mode is live under it (`system` included).
    modes: ["light", "dark"],
    // Mocha as the dark reading, Latte as the light one — the pair `src/lib/
    // palettes/catppuccin.ts` grades ("Catppuccin's grading row (Mocha = dark,
    // Latte = light)"). Shiki ships two further flavours, frappe and macchiato;
    // the registry has one slot per mode, so they are not offered.
    shiki: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  },
  {
    id: "ayu",
    label: "Ayu",
    // Two readings → the Theme mode is live under it (`system` included).
    modes: ["light", "dark"],
    // The `dark.yaml` / `light.yaml` pair the grading row reads its values out
    // of. `ayu-mirage` is the scheme's third variant — a second dark, not a
    // light — so it has no slot.
    shiki: { light: "ayu-light", dark: "ayu-dark" },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    // Two readings → the Theme mode is live under it (`system` included).
    modes: ["light", "dark"],
    // `main` as the dark reading (so its Shiki id is the BARE `rose-pine`, the
    // only one here without a `-dark` suffix) and `dawn` as the light one — the
    // pairing the theme's own `rose-pine-media.css` serves. `moon` is a second
    // dark and has no slot.
    shiki: { light: "rose-pine-dawn", dark: "rose-pine" },
  },
  {
    id: "kanagawa",
    label: "Kanagawa",
    // Two readings → the Theme mode is live under it (`system` included).
    modes: ["light", "dark"],
    // wave (dark) and lotus (light), per the grading row. `dragon`, the third
    // variant, is a second dark and has no slot.
    shiki: { light: "kanagawa-lotus", dark: "kanagawa-wave" },
  },
] as const satisfies readonly PaletteDefinition[];

/** The registry, as the app reads it. Kept as a separate export from the literal
 *  so `PaletteId` can be derived from the literal's INFERENCE (below) while
 *  consumers get a stable, non-literal-widened type. */
export const PALETTES: readonly PaletteDefinition[] = PALETTE_REGISTRY;

/**
 * The persisted `palette` vocabulary, derived from the registry instead of being
 * written a second time. This replaces `AppPalette`, which was a hand-maintained
 * union that every new Palette had to be added to by hand in three files.
 *
 * It is a union of LITERALS and not `string`, and that is the point: the Rust
 * side stores `palette` as an unvalidated `Option<String>` (ADR 0104), so the
 * frontend union is the only place a typo can be caught at compile time. It is
 * also deliberately NOT the whole truth at RUNTIME — an out-of-vocabulary value
 * can still arrive from disk, and `paletteFor` routes it to the Default palette
 * rather than throwing.
 */
export type PaletteId = (typeof PALETTE_REGISTRY)[number]["id"];

/**
 * Look a Palette up by its persisted value.
 *
 * An unrecognised id — the value a `settings.json` written before the rename
 * carries, a hand-edited `"solarized"`, or a value whose Palette was later removed — resolves
 * to the DEFAULT. That is not a convenience: it is the measured behaviour of the
 * code this replaces (`resolveTheme` branched on `palette === "dracula"` and on
 * nothing else, so any other value was indistinguishable from `null` and the
 * default's class was applied), and it is now EXPLICIT code rather than an
 * accident of a single guard. ADR 0104 records the evidence.
 */
export function paletteFor(id: string | null | undefined): PaletteDefinition {
  return PALETTES.find((palette) => palette.id === id) ?? defaultPalette();
}

/** The Default palette, looked up rather than hardcoded so the registry stays the
 *  only place its entry is written. Throws only if the registry has no default —
 *  which its own gate fails loudly. */
function defaultPalette(): PaletteDefinition {
  const fallback = PALETTES.find((palette) => palette.id === DEFAULT_PALETTE_ID);
  if (!fallback) {
    throw new Error(
      `the registry has no Palette with id "${DEFAULT_PALETTE_ID}", so an unrecognised palette value cannot resolve`,
    );
  }
  return fallback;
}

/** The CSS class a Palette's reading applies to `<html>`: `theme-<id>-<mode>`.
 *  Uniform naming (ADR 0104) — including `.theme-dracula-dark`, which cost one
 *  file an edit and spares every later Palette a special case. These class names
 *  are applied at runtime and persisted nowhere. */
export function paletteClass(id: string, mode: PaletteMode): string {
  return `theme-${id}-${mode}`;
}

/**
 * The reading a Palette actually ships for a requested mode.
 *
 * A Palette that does not ship the requested mode resolves to its OWN single
 * mode — that is what "Dracula pins dark" became. Before the registry that was a
 * branch in `resolveTheme` that named Dracula; now it is a property of the
 * Palette's `modes` list, so a Palette that ships one light reading pins light
 * with no code change.
 */
export function paletteModeFor(p: PaletteDefinition, mode: PaletteMode): PaletteMode {
  return p.modes.includes(mode) ? mode : p.modes[0]!;
}

/** Every class the app can ever apply, i.e. every registered id × mode pair.
 *
 * The single-class invariant in `theme.test.ts` used to filter over a hardcoded
 * three-name array, so a fourth class was INVISIBLE to it: two palette classes
 * co-applied still satisfied `toEqual([expected])`. Deriving the list from the
 * registry is the fix — a registered Palette's classes are graded the moment it
 * is registered, with no edit to the gate. */
export function themeClassNames(): string[] {
  return PALETTES.flatMap((palette) => palette.modes.map((mode) => paletteClass(palette.id, mode)));
}

/** Every Shiki theme id the registry needs loaded, deduplicated. Feeds BOTH
 *  `createHighlighter({ themes })` call sites and the gate that asserts neither
 *  singleton forgot one. */
export function shikiThemeIds(): string[] {
  const ids = PALETTES.flatMap((palette) => Object.values(palette.shiki));
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

/**
 * The `themes:` list BOTH highlighter singletons must pass to `createHighlighter`.
 *
 * `shikiThemeIds()` plus `SHIKI_FALLBACK_THEME`, and the fallback is not padding:
 * `shikiThemeFor` answers with it for a reading that publishes no id, so a list
 * of the registry's ids alone could ask `codeToHtml` for a theme the highlighter
 * never loaded — which throws, and the call sites' `catch` renders the plain
 * fallback, i.e. the failure is invisible. One function rather than the same
 * union spelled twice, because the two singletons had already drifted once and a
 * gate cannot see a value neither call site actually used.
 */
export function shikiThemesToLoad(): string[] {
  return [...new Set([...shikiThemeIds(), SHIKI_FALLBACK_THEME])];
}

/**
 * The Shiki theme id for a palette AND a mode — a registry lookup, not a ternary.
 *
 * The mode is a REQUIRED argument on purpose. The old rule was
 * `palette === "dracula" ? "dracula" : "github-dark"`, which could not know that
 * the Default palette in LIGHT mode wants a light paper, so a code fence on a
 * light bubble carried dark paper. The mode is resolved THROUGH
 * `paletteModeFor`, so a Palette that pins a reading gets that reading's theme
 * whatever the caller asked for — the same rule the CSS class follows, from the
 * same data.
 *
 * Lives in the registry (not in a component) because BOTH highlighter call sites
 * need it and because it is assertable without a DOM — which is the reason it was
 * exported at all. A reading that publishes no id degrades to
 * `SHIKI_FALLBACK_THEME` rather than to a thrown `codeToHtml`.
 */
export function shikiThemeFor(
  palette: string | null | undefined,
  mode: PaletteMode,
): string {
  const definition = paletteFor(palette);
  return definition.shiki[paletteModeFor(definition, mode)] ?? SHIKI_FALLBACK_THEME;
}
