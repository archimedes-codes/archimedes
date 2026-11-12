import type { ReactElement } from "react";
import {
  PALETTE_OPTIONS as PALETTE_OPTIONS_FROM_REGISTRY,
  PALETTE_PICKER_VALUES,
  PALETTE_SENTINEL,
} from "@/lib/palettePicker";
import { MAX_FONT_PX, MIN_FONT_PX } from "@/lib/settings";
import type { AppSettings } from "@/lib/tauri";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroupCard, SettingsRow, closedSelectValue, openSelectItems } from "./primitives";
import {
  EMPTY_STATE_ANIMATION_OPTIONS,
  EmptyStateAnimationPicker,
  FontSizeInput,
  SpinnerStylePicker,
} from "./controls";

/** The Theme picker's options — its CLOSED vocabulary (Radix renders no label
 * for a value outside it), and the single source for both the select's items
 * and the membership check. */
const THEME_OPTIONS = [
  { value: "system", label: "System (follow the OS)" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const;
/** The Palette picker's options (ADR 0027), DERIVED FROM THE REGISTRY and shared
 *  with `paletteCompleteness.test.ts` through `@/lib/palettePicker`.
 *
 *  This used to be a hand-written two-entry list paired with a save rule that
 *  named both values, and the measured consequence was that selecting a third
 *  Palette WROTE `"dracula"` into `settings.json` — a wrong value persisted by a
 *  green suite. Both halves are now one expression over `PALETTES`, so
 *  registering a Palette puts it in the picker with no edit here, and the gate
 *  that asserts "every registered Palette is offered" reads the SAME list this
 *  component renders rather than a copy of it. */
const PALETTE_OPTIONS = PALETTE_OPTIONS_FROM_REGISTRY;

/** The UI font's offered families (the saved value is the QUOTED CSS family
 * name for a web font — `applySettingsFont` splices it into the `--font-sans`
 * stack, where an unquoted multi-word name would not be a valid family. The
 * stack's tail (system + CJK fallbacks) still applies when a web font is
 * unavailable, e.g. offline). The `"default"` sentinel (saved as `null`) is the
 * APP DEFAULT — Noto Sans, which the `index.css` `--font-sans` stack resolves
 * to first, with the system tail as the offline fallback. */
const UI_FONT_OPTIONS = [
  { value: "default", label: "Default (Noto Sans)" },
  { value: "ui-serif, Georgia, serif", label: "Serif" },
  {
    value: "ui-monospace, SFMono-Regular, Menlo, monospace",
    label: "Monospace",
  },
  { value: '"Noto Sans"', label: "Noto Sans" },
  { value: '"Fira Sans"', label: "Fira Sans" },
  { value: '"Martel Sans"', label: "Martel Sans" },
] as const;

/** The Code font's offered families (the `"default"` sentinel and the quoted
 * web-font names follow the UI font's conventions; the value is spliced into
 * the `--font-mono` stack). The default is Fira Code — the `index.css`
 * `--font-mono` stack resolves to it first, with the system + CJK tail as the
 * offline fallback. */
const CODE_FONT_OPTIONS = [
  { value: "default", label: "Default (Fira Code)" },
  { value: '"JetBrains Mono"', label: "JetBrains Mono" },
  { value: '"Fira Code"', label: "Fira Code" },
  { value: '"Cascadia Code"', label: "Cascadia Code" },
  { value: "Menlo", label: "Menlo" },
  { value: "Consolas", label: "Consolas" },
] as const;

/** The Empty-session animation picker's CLOSED vocabulary, derived from the
 * picker's own option list (`controls.tsx`) so the membership check and the
 * cells are one document. `null` is not in it — it is the stored default, and it
 * resolves to `"animated"` (ADR 0070's app default). */
const FILM_ANIMATION_VALUES = EMPTY_STATE_ANIMATION_OPTIONS.map(
  (option) => option.value,
);

/** The Appearance section's props (every piece of state stays in `SettingsPage`). */
interface AppearanceSectionProps {
  settings: AppSettings | null;
  /** The immediate-save pattern. */
  onSave: (patch: Partial<AppSettings>) => void;
}

/** The Appearance section: theme / font size / fonts / thinking spinner. */
export default function AppearanceSection({
  settings,
  onSave,
}: AppearanceSectionProps): ReactElement | null {
  if (settings === null) return null;
  // The font families have an OPEN vocabulary — `applySettingsFont` splices
  // ANY non-null family into the CSS stack — so a stored family the list does
  // not offer (a hand-edited `"Georgia"`) is genuinely applied and is surfaced
  // as its own option rather than coerced to the default, which would lie
  // about the font on screen (the app's pattern for a stored value outside a
  // select's list, as in the default-thinking-level picker).
  const uiFont = openSelectItems(settings.font.uiFamily, UI_FONT_OPTIONS);
  const codeFont = openSelectItems(settings.font.codeFamily, CODE_FONT_OPTIONS);
  const themeValues = THEME_OPTIONS.map((option) => option.value);
  const paletteValues = PALETTE_PICKER_VALUES;
  return (
    <SettingsGroupCard>
      <SettingsRow
        label="Theme"
        control={
          <Select
            // A `theme` outside the vocabulary (a hand-edited file) resolves to
            // the LIGHT mode — `resolveTheme`'s final branch treats anything not
            // `dark` as light — so that is the mode the trigger names, rather
            // than the documented `dark` default (which would describe the
            // default while the window rendered light).
            value={closedSelectValue(settings.theme, themeValues, "light")}
            onValueChange={(value) =>
              onSave({ theme: value as AppSettings["theme"] })
            }
          >
            <SelectTrigger aria-label="Theme" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label="Palette"
        description="Which hues the app wears. Following the Theme setting is each palette's own choice: Dracula is dark-only — it overrides the Theme setting (including System)."
        controlLayout="wide"
        control={
          <Select
            // `closedSelectValue`: the backend stores `palette` as an
            // unvalidated string, so any value can arrive (e.g. a hand-edited
            // `"solarized"`). Nothing but a palette the picker offers selects a
            // scheme other than the default, so the Default label is the honest
            // readout for anything unrecognised — and it keeps the default
            // selectable, instead of blanking the trigger (Radix renders no
            // label for an off-list value). RENDERING ONLY: nothing is re-saved
            // for being unreadable.
            value={closedSelectValue(
              settings.palette,
              paletteValues,
              PALETTE_SENTINEL,
            )}
            onValueChange={(value) =>
              // Pass the chosen value through rather than naming the options this
              // picker happens to offer: a palette added tomorrow would otherwise
              // save `"dracula"`. The cast is the Radix boundary —
              // `onValueChange` hands back a `string` (the same cast the Theme
              // row above makes).
              onSave({
                palette:
                  value === PALETTE_SENTINEL
                    ? null
                    : (value as AppSettings["palette"]),
              })
            }
          >
            {/* The `"default"` option saves `null` (not `"default"`) — the same
                default-sentinel pattern as `spinnerStyle` and the font
                families — so a default palette leaves `settings.json`
                minimal, and a pre-feature file (no `palette` key) and an
                explicit Default choice stay the SAME document (ADR 0027). The
                handler passes any OTHER value through rather than naming the
                two options it knows: a palette the picker adds tomorrow must
                save ITSELF, not fall through to `"dracula"`. */}
            <SelectTrigger aria-label="Palette" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PALETTE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label="Font size"
        description="The UI base size (12–20px)"
        control={
          <FontSizeInput
            value={settings.font.sizePx}
            min={MIN_FONT_PX}
            max={MAX_FONT_PX}
            ariaLabel="Font size"
            onChange={(sizePx) =>
              onSave({ font: { ...settings.font, sizePx } })
            }
          />
        }
      />
      <SettingsRow
        label="UI font"
        control={
          <Select
            value={uiFont.value}
            onValueChange={(value) =>
              onSave({
                font: {
                  ...settings.font,
                  uiFamily: value === "default" ? null : value,
                },
              })
            }
          >
            <SelectTrigger aria-label="UI font" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {uiFont.items.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label="Code font"
        control={
          <Select
            value={codeFont.value}
            onValueChange={(value) =>
              onSave({
                font: {
                  ...settings.font,
                  codeFamily: value === "default" ? null : value,
                },
              })
            }
          >
            <SelectTrigger aria-label="Code font" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {codeFont.items.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label="Thinking spinner"
        description="The animation the composer's working indicator runs while the agent is busy"
        controlLayout="wide"
        control={
          <SpinnerStylePicker
            value={settings.spinnerStyle ?? "typing"}
            onChange={(spinnerStyle) => onSave({ spinnerStyle })}
          />
        }
      />
      <SettingsRow
        label="Empty-session animation"
        description="The animation the transcript shows when a session has no messages yet. Reduced-motion settings always stop it."
        controlLayout="wide"
        control={
          // The vocabulary is CLOSED (`off` / `static` / `animated`) and the
          // stored default is `null`, so `closedSelectValue`'s rule applies: an
          // off-list value (a hand-edited `"spatial"`) reads back as the
          // default — Animated, which is what `resolveFilmMode` actually shows —
          // and is rendered, never re-saved. Each click writes a real value:
          // unlike `palette`'s `null` sentinel, Animated writing `"animated"` is
          // the user's explicit choice and this default is genuinely animated.
          <EmptyStateAnimationPicker
            value={closedSelectValue(
              settings.emptyStateAnimation,
              FILM_ANIMATION_VALUES,
              "animated",
            )}
            onChange={(emptyStateAnimation) => onSave({ emptyStateAnimation })}
          />
        }
      />
    </SettingsGroupCard>
  );
}
