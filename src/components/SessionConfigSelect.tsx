import { memo, useEffect } from "react";
import { Bot } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
} from "../components/ui/select";
import ModelPicker from "./ModelPicker";
import {
  modelItemsFromCatalog,
  type ModelPickerItem,
} from "./ModelPickerDialog";
import { useSettings } from "../store/settings";
import type { SessionConfigOption } from "../lib/tauri";
import { THINKING_GLYPHS } from "../lib/toolOutput";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { cn } from "./lib/utils";

type OnSet = (optionId: string, value: string) => Promise<void>;

/**
 * The composer triggers' width contract: CONTENT-SIZED (no fixed `w-*`, and
 * `shrink` + `min-w-0` override the Button's `shrink-0`) — the trigger hugs
 * its text, so a short value never leaves dead space, and it gives width
 * back when the row gets tight (the inner `truncate` ellipsizes it). The
 * cap is generous: sized for the widest realistic value — `<model id> ·
 * <provider>` (`Qwen/Qwen3.8-27B · tama`) — where the old `max-w-48`
 * (12rem) chopped it to the unreadable `Qwen/Qwen3.8-27…`.
 *
 * The two triggers face each other on a SEAM, so the seam-side padding drops
 * to `1` (4px) while the text side keeps its `2` (8px) inset: with the
 * cluster's `gap-1`, the old 8px + 8px + 4px was a dead 20px band that made
 * the pair read as two unrelated controls.
 */
const COMPOSER_TRIGGER_WIDTH = "min-w-0 shrink max-w-72";
/**
 * The SAME contract for a trigger that owns a WHOLE LINE (the side pane's
 * `SessionConfigBlock`): stretch to the line, and the cap is GONE rather than
 * merely out-joined. `w-full` and `max-w-72` are separate `tailwind-merge`
 * groups (`src/components/lib/utils.ts`), so `cn` keeps BOTH when they arrive
 * together — and a `w-full max-w-72` trigger inside a 300px line still stops at
 * 18rem, i.e. the "full width" prop would be a lie. Hence two branch strings,
 * never a join.
 *
 * The SEAM edges (`pr-1` / `pl-1`, see below) are dropped here too: they exist
 * only because the two composer triggers face each other across a 4px gap, and
 * on a line of its own a trigger has no neighbour to share a seam with.
 */
const FULL_WIDTH_TRIGGER = "min-w-0 shrink w-full";
/** The model trigger's right edge (it faces the thinking trigger). */
const COMPOSER_MODEL_EDGE = "pr-1";
/** The thinking trigger's left edge (it faces the model trigger). */
const COMPOSER_THINKING_EDGE = "pl-1";

/**
 * The props: a REAL option (the `kind` is optional — it falls back to the
 * option's `category` / `id`) OR a `null` option (a closed session's config
 * is dropped — the `kind` is REQUIRED then, since there is no option to
 * derive it from). The `null` case is MODEL-ONLY: it renders a disabled model
 * stub (the control's identity, no data — the config re-emits on resume), and
 * a model selector is meaningful for any session. Thinking has no null case —
 * a model with no thinking levels has nothing to select, so the caller
 * (`SessionConfigBlock`) gates the whole reasoning line on the option existing
 * rather than passing `null` here.
 *
 * `items` (MODEL ONLY — the thinking line ignores it) is the picker's option
 * list from OUTSIDE the session snapshot: the live model catalog the pane
 * assembles from `useModelCatalog`. When it is absent the picker falls back to
 * the option's own `options` (see `modelItems` below for the one derivation that
 * honours both).
 */
type SessionConfigSelectProps =
  | {
      option: SessionConfigOption;
      onSet: OnSet;
      kind?: "model" | "thinking";
      disabled?: boolean;
      fullWidth?: boolean;
      items?: ModelPickerItem[];
    }
  | {
      option: null;
      kind: "model";
      onSet: OnSet;
      disabled?: boolean;
      fullWidth?: boolean;
      items?: ModelPickerItem[];
    };

/**
 * The provider key → its configured display `name` (the `tama` key → `Tama`),
 * falling back to the raw key when unconfigured — the SAME rule
 * `modelItemsFromCatalog` applies via its own `providerDisplayName`
 * (`ModelPickerDialog.tsx`). Duplicated here on purpose: the display decoration
 * belongs to THIS component (see `modelItems` below) and a module-local copy
 * keeps `ModelPickerDialog.tsx`'s private helper private.
 */
function displayNameFor(
  providerId: string,
  providers: { id: string; name: string }[],
): string {
  return providers.find((p) => p.id === providerId)?.name ?? providerId;
}

/**
 * The thinking-level indicator (the pi-archimedes footer's
 * `thinkingLevelIcons` + `thinkingLevelColors` ramp, ported to the design
 * system): the GLYPH's fill is the level's magnitude (○ off/minimal,
 * ◔ low 25%, ◑ medium 50%, ◕ high 75%, ● xhigh/max full — the app's own
 * `THINKING_GLYPHS`, the same source), the HUE is the level's identity (the
 * `--color-thinking-*` ramp, off/minimal in the dim color). An empty /
 * unknown level is the open circle in the dim color (the reference's `off`
 * state).
 *
 * The hues are TOKENS, never raw Tailwind shades: a level's hue is an IDENTITY
 * color (CONTEXT.md), so it must survive a Palette swap and stay out of the
 * status ramp — a red glyph would read as a failure, not as max effort.
 */
function thinkingLevelIndicator(
  level: string,
): { glyph: string; className: string } {
  const l = level.toLowerCase();
  // `THINKING_GLYPHS` covers every known level (off/minimal → ○); the empty
  // value (no level set — the model default) is the open circle too, and an
  // unknown level falls back to the mid glyph (the `formatThinkingIndicator`
  // fallback).
  const glyph = l === "" ? "○" : THINKING_GLYPHS[l] ?? "◑";
  const className =
    l === "low"
      ? "text-thinking-low"
      : l === "medium"
        ? "text-thinking-medium"
        : l === "high"
          ? "text-thinking-high"
          : l === "xhigh"
            ? "text-thinking-xhigh"
            : l === "max"
              ? "text-thinking-max"
              : "text-foreground-subtle";
  return { glyph, className };
}

function SessionConfigSelect({
  option,
  kind,
  onSet,
  disabled,
  fullWidth,
  items,
}: SessionConfigSelectProps) {
  // `pending` is the hook's `busy`, renamed at the destructure so every reader
  // in this file keeps its name (the trigger's `disabled`, the `isDisabled`
  // join, the guard below). `guard: true` because this site self-guarded
  // (`if (pending) return` at the old `:217`): unlike the sudo/ask cards, this
  // control is NOT protected by a `disabled` attribute on the element that
  // fires it — the model option's picker rows live in a DIALOG that is already
  // open, so a second pick reaches `onSelect` regardless of the trigger's
  // disabled state, and only the JS guard stops a second `set_config_option`.
  const { busy: pending, error, run, clearError } = useAsyncAction({
    guard: true,
  });
  // The base disabled state — the `disabled` prop from the call site (still
  // honoured: `SessionConfigBlock` no longer passes `!isLive`, because the
  // backend now persists a stored session's change without a Worker (issue
  // #154), but the prop's `disabled || pending` JOIN remains and the
  // component-level cases pin it) — OR the in-flight `onSet` (one change at a
  // time). Either one disables the trigger.
  const isDisabled = disabled || pending;
  // The settings document — the model picker's provider display names
  // (the `tama` key → the configured provider's `name` `Tama`; the raw
  // key when the provider is unconfigured). `null` (not loaded yet) →
  // the raw keys.
  const settings = useSettings((s) => s.settings);

  useEffect(() => {
    if (error) {
      // The 5s auto-clear stays, and it clears the MESSAGE ONLY: `clearError`
      // never touches `busy`, so a timer can never re-enable a trigger whose
      // `onSet` is still in flight.
      const timer = setTimeout(clearError, 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  const value = typeof option?.currentValue === "string" ? option.currentValue : "";
  // The two controls' indicators (the reference UI's placement): the model
  // picker carries the bot icon (the reference's robot glyph — the web
  // equivalent of the Nerd Font codepoint), the thinking-level picker
  // carries the level's fill-ramp glyph (the pi-archimedes
  // `thinkingLevelIcons` ramp — the fill is the magnitude, the hue the
  // level's identity). The `kind` prop (the call site knows which option
  // it looked up) wins over the option's own `category` / `id` (the
  // fallback — a `null` option has none to derive from).
  const isThinking =
    kind === "thinking" ||
    option?.category === "thought_level" ||
    option?.id === "thought_level";
  const isModel =
    kind === "model" || option?.category === "model" || option?.id === "model";
  // The trigger's WIDTH contract, chosen per call site and not merged (see
  // `FULL_WIDTH_TRIGGER`): the composer hugs its text and caps at 18rem, the
  // side pane's line stretches. The seam edges ride only the composer branch —
  // they exist to tighten the pair's shared seam, and a full-width line has no
  // neighbouring trigger to share one with. THREE sites consume these two
  // strings (the null-model stub, the live model, the live thinking trigger);
  // missing one leaves that one trigger content-sized inside a line that is
  // supposed to be full-width.
  const width = fullWidth ? FULL_WIDTH_TRIGGER : COMPOSER_TRIGGER_WIDTH;
  // Task C8 dropped the LEADING SPACE each of the two edge constants used to
  // carry: it existed only so the hand-written template literal joined cleanly,
  // and all three consumers now go through `cn()`, which joins for free (and
  // drops the `""` full-width arm entirely).
  const modelEdge = fullWidth ? "" : COMPOSER_MODEL_EDGE;
  const thinkingEdge = fullWidth ? "" : COMPOSER_THINKING_EDGE;
  // A `null` option is MODEL-ONLY (the props union below says so): render the
  // DISABLED model stub — the control's identity, no data, the config re-emits
  // on resume. Thinking has no stub at all: `SessionConfigBlock` gates the
  // whole reasoning line on the option existing, so a null thinking option can
  // never reach this component.
  if (option === null) {
    return (
      <div className="relative min-w-0">
        <ModelPicker
          label="Model"
          value=""
          placeholder="Model"
          items={[]}
          onSelect={() => {}}
          variant="ghost"
          triggerClassName={cn(width, modelEdge)}
          disabled
          icon={
            <Bot
              className="size-3.5 text-foreground-subtle"
              aria-hidden
              data-testid="model-icon"
            />
          }
        />
      </div>
    );
  }
  const thinkingIndicator = thinkingLevelIndicator(value);
  // The model picker's items — TWO SOURCES, ONE derivation, stated once here.
  //
  //  - `items` (the normal path, `SessionConfigBlock`): the LIVE catalog,
  //    assembled by the caller from the `useModelCatalog` store filtered to the
  //    configured providers. This is what makes a Settings change (add / refresh
  //    a provider, remove one) reach an ALREADY-OPEN session's picker — the
  //    session's own snapshot could never carry it, because the harness bakes
  //    `configOptions` at start / resume / set (issue #154). Those rows arrive
  //    already shaped for the picker (`name` the BARE model id, `value` the
  //    composed `provider/id` key, `provider` the RAW key), so they need only
  //    the provider display-name decoration. `modelItemsFromCatalog` must NOT be
  //    re-run over them: it splits `value` on its first `/` and looks the
  //    remainder up as if it were an id, so re-running it over already-decorated
  //    rows is the double-decoration bug.
  //  - the fallback (no `items` prop): the config option's OWN options — the
  //    session snapshot (`SessionConfigSelect.test.tsx` renders without `items`).
  //    Flat `{ value: "provider/id" }` entries (the Rust
  //    `synthesize_catalog_config_options` shape, grouped entries flattened) →
  //    `modelItemsFromCatalog` derives name + cue from the composed key.
  //
  // Both paths decorate the provider display name (the `tama` key → the
  // configured `Tama`, the raw key when unconfigured). The `null`-option stub
  // above keeps its own `items={[]}` — no data, no persist path.
  const modelItems =
    items !== undefined
      ? items.map((it) =>
          it.provider
            ? {
                ...it,
                provider: displayNameFor(it.provider, settings?.providers ?? []),
              }
            : it,
        )
      : modelItemsFromCatalog(
          (option.options ?? []).flatMap((opt) =>
            "options" in opt ? opt.options.map((sub) => sub.value) : [opt.value],
          ),
          settings?.providers ?? [],
        );

  const handleValueChange = (val: string) =>
    run(() => onSet(option.id, val));

  // The MODEL option: the shared `ModelPicker` (a ghost trigger — the
  // bot icon + the current value + a chevron — opening the model picker
  // dialog; the catalog is too long for a Radix dropdown). The
  // thinking-level option stays a compact Radix Select (a handful of
  // options).
  if (isModel) {
    return (
      <div className="relative min-w-0">
        <ModelPicker
          label={option.name}
          value={value}
          items={modelItems}
          onSelect={(val) => void handleValueChange(val)}
          variant="ghost"
          triggerClassName={cn(width, modelEdge)}
          disabled={isDisabled}
          icon={
            <Bot
              className="size-3.5 text-foreground-subtle"
              aria-hidden
              data-testid="model-icon"
            />
          }
        />
        {error && (
          <span className="text-ui-sm text-destructive absolute left-0 top-full mt-1 z-10 rounded bg-background px-1" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  // The THINKING-LEVEL option: the compact Radix Select (unchanged).
  return (
    <div className="relative min-w-0">
      <Select value={value} onValueChange={handleValueChange}>
        <SelectTrigger
          variant="ghost"
          size="sm"
          className={cn(
            // The two constants are measured to merge to the same token set the
            // concatenation produced (`thinkingEdge` used to carry a leading
            // space purely so the two literals joined cleanly — `cn` joins for
            // free, so it is gone from both arms). The seam-edge utility is a
            // `pl-*`/`pr-*` and the trigger variant's own inset is `px-*`, which
            // tailwind-merge keeps as separate groups, so
            // `SessionConfigSelect.test.tsx`'s pins (`pl-1` present, `pl-2`
            // absent; `w-full` present and `max-w-72` ABSENT at full width) all
            // hold — that last one because `cn` is applied HERE to a string that
            // already excludes the cap, exactly as before.
            width,
            thinkingEdge,
          )}
          disabled={isDisabled}
          aria-label={option.name}
        >
          {/* The model option never reaches this branch (it returns the
              dialog trigger above) — only the thinking-level icon (or
              none) renders here. */}
          {isThinking && (
            <span
              className={cn(
                // Same reasoning as the trigger above: `thinkingIndicator.className`
                // is a text COLOUR (`text-thinking-*`, or the fallback
                // `text-foreground-subtle`) and `text-ui-sm` is a registered
                // font-size group, so neither drops the other.
                "text-ui-sm",
                thinkingIndicator.className,
              )}
              aria-hidden
              data-testid="thinking-level-icon"
            >
              {thinkingIndicator.glyph}
            </span>
          )}
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {option.options?.map((opt) => {
            if ("options" in opt) {
              return (
                <SelectGroup key={opt.name}>
                  <SelectLabel>{opt.name}</SelectLabel>
                  {opt.options.map((subOpt) => (
                    <SelectItem key={subOpt.value} value={subOpt.value}>
                      {subOpt.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              );
            }
            return (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.name}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {error && (
        <span className="text-ui-sm text-destructive absolute left-0 top-full mt-1 z-10 rounded bg-background px-1" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * MEMO IS THE FIX (perf regression): the composer's `draft` state re-renders
 * `ChatStream` on every keystroke; without this memo (and a stable `onSet`),
 * every keystroke re-rendered the FULL model catalog mounted inside the
 * selects (~600 items × ~8 fibers ≈ 140ms/keystroke — typing lagged a full
 * minute behind). With stable `option`/`onSet` references the subtree is
 * skipped entirely; a new `option` object (config applied) still re-renders.
 */
export default memo(SessionConfigSelect);
