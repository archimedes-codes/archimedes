/**
 * The Palette picker's option list — the ONE place the Settings picker's Palette
 * vocabulary is written.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A CONST INSIDE `AppearanceSection.tsx`. The
 * measured failure this replaces: the picker carried a hand-written two-entry
 * list AND a save rule that named both values, so selecting a third Palette
 * WROTE `"dracula"` into `settings.json` — a wrong value persisted by a green
 * suite. Deriving both halves from the registry fixes the app, but a gate that
 * wanted to check "every registered Palette is offered" would then have to import
 * `AppearanceSection`, and that drags Radix, the whole settings page and every
 * store into what is otherwise a CSS/token test. A three-line data module keeps
 * the claim assertable at the cost of one import — and keeps the claim honest,
 * because the gate reads the SAME list the component renders rather than a copy
 * of it.
 *
 * NO REACT HERE, and no Node: this is in the shipped graph.
 */

import { DEFAULT_PALETTE_ID, PALETTES } from "./palettes";

/** The picker's options, in registry order. */
export const PALETTE_OPTIONS = PALETTES.map((palette) => ({
  value: palette.id,
  label: palette.label,
}));

/** The values the picker offers, i.e. the vocabulary its membership check uses. */
export const PALETTE_PICKER_VALUES: string[] = PALETTE_OPTIONS.map((option) => option.value);

/**
 * The trigger's sentinel for "the Default palette".
 *
 * The picker SAVES `null` for the Default palette (so a default install leaves
 * `settings.json` minimal — ADR 0027) but must still RENDER a label for it, and
 * Radix renders nothing for `""`. The sentinel is therefore the Default palette's
 * id, taken from the registry so the sentinel and `paletteFor`'s fallback id
 * cannot drift apart.
 */
export const PALETTE_SENTINEL = DEFAULT_PALETTE_ID;
