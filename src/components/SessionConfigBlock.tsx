import { useCallback, useMemo } from "react";
import { Brain } from "lucide-react";
import SessionConfigSelect from "./SessionConfigSelect";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";
import type { ModelPickerItem } from "./ModelPickerDialog";
import { modelSelectabilityNotice } from "./ModelPickerDialog";
import { selectModelsByProvider, useModelCatalog } from "../store/modelCatalog";
import { useSettings } from "../store/settings";

/**
 * C7: the context PERCENTAGE (the hover trigger for the token counts) is a
 * `<Button variant="link" size="default">`, both named explicitly because
 * `ui/button.tsx:40` sets `defaultVariants {variant:"default"}`, which would
 * otherwise paint the number on a `bg-primary` plate. `link` is the variant that
 * matches what this trigger already was — bare text that changes colour — and it
 * is the only variant with no hover background; its `hover:underline` is
 * cancelled by `hover:no-underline`, and its `text-primary` loses the text-colour
 * group to the ramp's `text-*` label. Its `underline-offset-4` DOES survive (the
 * trigger spells no offset of its own) and is inert: with `hover:no-underline`
 * there is never an underline for an offset to move. Measured with the real
 * `cn()`, the rendered utility SET is exactly what this trigger spelled —
 * including `border-0`, `bg-transparent`, `p-0`, `appearance-none` and
 * `text-ui-sm`, all of which the trigger spells itself and which therefore beat
 * or simply coexist with the base. What `PERCENT_TRIGGER_WALL` undoes:
 *  - `inline-block` — the base's `inline-flex` replaces the UA `inline-block` a
 *    bare `<button>` has. Provably inert at THIS site (the trigger is a flex item
 *    of the bar's `flex min-w-0 items-center gap-2` row, and flex items are
 *    blockified: `inline-block` → `block`, `inline-flex` → `flex`), but the
 *    display group is the one thing here that could move the number on the bar's
 *    line, so the original display is restored explicitly rather than argued
 *    away — and with it the base's `items-center`/`justify-center` have no flex
 *    container to distribute in.
 *  - `h-auto` — the size's `h-7` is a fixed 28px, taller than the `h-1.5` bar it
 *    sits beside; the trigger is text-height today.
 *  - `whitespace-normal` — the base's `whitespace-nowrap` (the trigger inherited
 *    `normal`).
 *  - `select-auto` — the base's `select-none` would make the token percentage
 *    unselectable.
 *  - `transition-none` — the base's `transition-colors` would fade the ramp
 *    colour over 150 ms whenever the band changes (green → caution → warning →
 *    red). The trigger changes colour instantly today.
 *  - `hover:no-underline` — `link`'s `hover:underline` would underline the number
 *    on hover, which it never was.
 * Inert here: `border-0` is the trigger's OWN class and the base's
 * `border-transparent` is left with nothing to draw, which also makes
 * `bg-clip-padding` a no-op (zero-width border ⇒ padding-box == border-box) and
 * `rounded-md` irrelevant under the trigger's own `rounded-sm`; `shrink-0` is the
 * trigger's own; `gap-1` (not a flex container once `inline-block` wins);
 * `text-ui-sm` wins the font-size group over both the size's `text-ui-base` and
 * the base's `text-ui-base/relaxed`, so no line-height is declared either — the
 * same `text-ui-*`-versus-colour pairing the site already documents for
 * `mergeUiClasses`; `outline-none` (`base.css:53-57` forces `outline: none
 * !important` on every focus, and again under `forced-colors`, which is also why
 * the trigger's own `focus-visible:outline-none` stays harmless); `disabled:*` /
 * `aria-invalid:*` / `aria-expanded:*` (a tooltip trigger is none of those —
 * Radix's Tooltip sets `aria-describedby`, never `aria-expanded`);
 * `group/button`; `has-data-[icon=inline-*]:pr/pl` (no child carries
 * `data-icon`); and the three `[&_svg…]` rules — the trigger's only child is the
 * text node `42%`, so there is no `<svg>` for the icon-resize hazard to reach.
 * The `data-slot`/`data-variant`/`data-size` attributes are new, and no test
 * reads them here; `SidePane.test.tsx` finds this node by
 * `data-testid="context-usage"` and pins `text-success` on it, which survives.
 */
const PERCENT_TRIGGER_WALL =
  "inline-block h-auto whitespace-normal select-auto transition-none hover:no-underline";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { useSessions } from "../store/sessions";
import { setSessionConfigOption } from "../lib/tauri";
import {
  contextPercentOf,
  contextRampFor,
  contextUsageOf,
  findConfigOption,
  sessionConfigOptionsOf,
} from "../lib/sessionConfig";

/**
 * The session's config LINES — Model, Reasoning, Context — stacked at the
 * BOTTOM of the side pane. Reasoning is the only GATED one: it exists solely
 * when the session's options carry a `thought_level` select, so a model with no
 * thinking levels (and a session whose config we never learned) shows TWO lines
 * — Model, then Context — and never a thinking control that cannot open. They
 * used to be the composer's bottom row; they moved because a 40px-wide composer
 * row cannot hold a bar, two triggers and two buttons, and because the move
 * kills a perf coupling: the composer re-renders
 * on every keystroke (`draft` is its state), and the selectors sat in that
 * subtree (see the memo note in `SessionConfigSelect.tsx` — a per-option closure
 * re-rendered ~600 mounted model `SelectItem`s at ~140ms per keystroke). The
 * pane reads STORES and never the draft, so typing cannot re-render these
 * controls at all.
 *
 * Both selectors are ENABLED for EVERY session, stored or live (#154). They used
 * to carry `disabled={!isLive}` on the theory that a stored session has no agent
 * process to deliver `set_config_option` to; the backend now persists the change
 * and returns the re-synthesized options even when no Worker runs, so the only
 * thing that gates a trigger is the in-flight request (the `pending` join inside
 * `SessionConfigSelect`). The one control that keeps a hard `disabled` is the
 * `null`-option Model stub — a session with NO config options has no data and no
 * persist path, and enabling it would make the UI lie. The Model line's OPTION
 * list also comes from a store rather than from the session's snapshot: the live
 * `useModelCatalog` filtered to the configured providers, so a Settings change
 * reaches an already-open session (see `catalogItems` below).
 *
 * Two placement decisions, each load-bearing:
 *
 * - **A sibling AFTER the pane's scroll area, never inside it.** The content
 *   div is `flex-1 overflow-y-auto` and the todo boards GROW, so a block inside
 *   it scrolls away and drifts with the board's length — the config of the
 *   session you are looking at would be somewhere above the fold. Pinned by the
 *   `mounts the config block AFTER the scroll area` case in `SidePane.test.tsx`. * - **`shrink-0` on the wrapper.** The frame is a `flex-col` whose only other
 *   child is the `flex-1` (basis 0) scroller, so a new sibling with the default
 *   `flex-basis: auto` would be the ONLY item able to absorb a height shortfall:
 *   a long board would squash the block to nothing instead of scrolling. The
 *   composer island documents the identical trap (`ComposerRow.tsx`).
 *
 * The session-id selector now can be overridden: the `sessionId` prop names
 * which **Session** these three lines read AND write, so the New Task modal can
 * mount this footer for the Session it just started instead of the globally
 * active one. OMITTED it is the global active Session, which is what `SidePane`
 * gets by passing nothing; an explicit `null` means "no Session yet" (the stub,
 * and no write). See the prop's doc for the hazard that made the prop mandatory
 * rather than nice, and for why those two are NOT the same value.
 *
 * The Context line has NO well of its own, deliberately. It used to sit in a
 * `bg-input` box, and it read as a sunken slot inside a pane that is already a
 * plane — the user asked for it gone. The honest cost: the `#343746` track now
 * paints on `--color-inspector` (`#282a36`) at 1.208, and NO non-Selection
 * Dracula surface clears 1.3 against the pane (`#191a21` 1.218, `#21222c` 1.109)
 * — the 1.3 the gates used was a property of the well, not of the pane. What
 * actually carries the bar is the FILL-vs-TRACK contrast (every band clears 3:1
 * with room to spare: worst 4.33), and band separation against the bare pane
 * IMPROVES (5.23 vs 4.33 with the well). The gates are graded against
 * `--color-inspector` at a 1.2 floor that states this explicitly.
 */
export default function SessionConfigBlock({
  sessionId,
}: {
  /** Which **Session** these lines read AND write.
   *
   *  THREE-valued on purpose, and the middle value is the whole point:
   *   - **omitted** → the globally active Session. That is what `SidePane`
   *     gets by passing nothing, which is why the default is a default.
   *   - a **string** → that Session. The New Task modal passes the Session it
   *     just started for the Task.
   *   - **`null`** → there is NO Session to configure yet: the disabled Model
   *     stub, and `onSet` refuses. The modal passes this before its first send.
   *
   *  WHY THIS EXISTS (the hazard, not a convenience). Every derivation and the
   *  write path used to key off `s.activeSessionId` internally, so mounting this
   *  component verbatim inside the New Task modal would have rendered — and then
   *  WRITTEN — the model / thinking level of whatever Session the workspace had
   *  selected, while the user believed they were configuring the NEW Task's
   *  Session. Silent, and one click wide.
   *
   *  WHY `null` IS NOT THE DEFAULT. `sessionId ?? activeSessionId` — the obvious
   *  reading of "defaults to the active session" — makes `null` mean "use the
   *  global one", and inside the modal that is the exact hazard this prop exists
   *  to remove: the board is only reachable while a Session IS active (the
   *  board's own Space is `useActiveSpaceCwd()`, i.e. derived from
   *  `activeSessionId`), so a pre-send footer written with `??` would print and
   *  WRITE the workspace Session's model while the user picks a model for a Task
   *  that has no Session yet. Omission and `null` therefore mean different
   *  things. Pinned in `SessionConfigBlock.test.tsx` in both directions — read
   *  and WRITE — because a picker that reads the right Session but writes the
   *  wrong one is the half that loses data. */
  sessionId?: string | null;
}) {
  // The one id every line below keys off. Declared BEFORE the selectors that
  // read it, and the hook is called UNCONDITIONALLY: `sessionId ??
  // useSessions(…)` would skip the call whenever `sessionId` is a non-empty
  // string, which changes the hook count between renders — the white-page
  // crash every other hook-count note in this repo warns about.
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const targetId = sessionId === undefined ? activeSessionId : sessionId;
  // The derivations are the SHARED ones (`lib/sessionConfig`), run INSIDE the
  // selector so this component subscribes to the derived VALUE and not to the
  // three session lists. Stable references either way: `sessionConfigOptionsOf`
  // returns the stored array (or `null`), `contextUsageOf` a stored object (or
  // `undefined`) — never a fresh literal. Both are `null`-safe, so a pre-send
  // modal with no Session and no override gets the no-config render.
  const configOptions = useSessions((s) =>
    sessionConfigOptionsOf(s, targetId),
  );
  const contextUsage = useSessions((s) =>
    contextUsageOf(s, targetId),
  );
  // A stored (non-live) session is NO LONGER a reason to disable anything
  // (#154): the backend (`set_session_config_option`) persists the change and
  // returns the re-synthesized options even when no Worker runs, so both
  // selectors stay ENABLED for a stored session and the only thing that ever
  // gates them here is the in-flight request (`pending`, inside
  // `SessionConfigSelect`). The old `isLive` selector is gone with its gate.
  const applyConfigOptions = useSessions((s) => s.applyConfigOptions);

  // ONE stable callback for both config selects (the consumer-side half of the
  // SessionConfigSelect memo fix): a per-option closure minted per render would
  // re-render the ~600 mounted model-catalog SelectItems on every re-render of
  // the parent. `applyConfigOptions` is a zustand action — a stable reference —
  // so this callback's identity only changes when the session this block targets
  // changes. `targetId` and not `activeSessionId`: a modal footer writes the
  // Session it names, never the workspace's selection.
  const onSet = useCallback(
    async (optionId: string, value: string) => {
      if (!targetId) return;
      const options = await setSessionConfigOption(targetId, optionId, value);
      applyConfigOptions(targetId, options);
    },
    [targetId, applyConfigOptions],
  );

  const contextPercent = contextPercentOf(contextUsage);
  const contextRamp = contextRampFor(contextPercent);
  const modelOption = findConfigOption(configOptions, "model", "model");
  // THE MODEL PICKER'S OPTIONS COME FROM THE LIVE CATALOG, not from the
  // session's snapshot (#154). The harness bakes the model option's `options` at
  // start / resume / every set (`synthesize_catalog_config_options`), so an
  // option-derived list can NEVER show a provider the user added in Settings
  // after the session opened; the global `useModelCatalog` store does, and plain
  // zustand propagates it to every subscriber (the precedent is
  // `SubagentDelegatingCard`, whose test proves a seeded `models` re-renders it).
  //
  // `models` is the store's OWN array — a STABLE reference (the invariant
  // `src/lib/sessionLookup.ts` states). Subscribe to the slice, NEVER to a
  // selector that mints a fresh array: zustand v5 re-runs a selector on every
  // snapshot read and re-renders forever when the result is not `Object.is`
  // stable, which HANGS the suite (documented in `sessionLookup.ts`,
  // `SubagentModals.tsx`, `SessionCostLine.tsx`, `SidePane.tsx`). So
  // `selectModelsByProvider` is called INSIDE the memo over `getState()`, and
  // the subscription that guarantees the re-render is the stable slice below —
  // which is also a dependency of the memo.
  const catalogModels = useModelCatalog((s) => s.models);
  // The settings document — the CONFIGURED provider ids the catalog is filtered
  // against (a provider removed in Settings drops its rows reactively, with no
  // re-fetch; `ModelDto` carries no "still configured" flag on the wire).
  const settings = useSettings((s) => s.settings);
  const configuredProviderIds = useMemo(
    () => new Set(settings?.providers.map((p) => p.id) ?? []),
    [settings],
  );
  // The picker rows, in the shape `ModelPickerItem` wants: `value` the composed
  // `provider/id` key (what `set_config_option` receives), `name` the BARE model
  // id (the provider rides as the cue, so keeping the prefix printed it twice),
  // `provider` the RAW key — `SessionConfigSelect` decorates it into the
  // provider's display name, the one decoration these rows still need.
  //
  // MEMOISED ON PURPOSE: `SessionConfigSelect` is `memo`ized (the perf fix — a
  // fresh prop identity every render re-renders the whole catalog subtree), so a
  // fresh `items` array per render would defeat it exactly like a fresh `onSet`
  // closure did. A new array per render is fine in the render body only because
  // it is assembled here (no subscription) and memoised by these two stable deps.
  const catalogItems: ModelPickerItem[] = useMemo(
    () =>
      selectModelsByProvider(configuredProviderIds)(
        useModelCatalog.getState(),
      ).map((m) => ({
        value: `${m.provider}/${m.id}`,
        name: m.id,
        // The RAW key — `SessionConfigSelect` decorates it (see its
        // `displayNameFor`); the `ModelDto[]` variant below does the decoration
        // itself because ITS caller (`AgentsDialog`) has no decorating layer.
        provider: m.provider,
        // The one shared derivation of `disabled` + `note` (issue #9) — the
        // Agents modal's subagent picker runs the SAME function, so the two
        // surfaces cannot disagree about which rows are usable or what they say.
        ...modelSelectabilityNotice(m),
      })),
    [catalogModels, configuredProviderIds],
  );
  const thinkingOption = findConfigOption(
    configOptions,
    "thought_level",
    "thought_level",
  );
  // The token counts as TEXT (the number is what the bar shows; these are
  // what the assistive tech and the tooltip carry). `undefined` until the
  // first usage frame — the same gate as the label itself.
  const countsText =
    contextUsage && contextPercent !== undefined
      ? `${contextUsage.used.toLocaleString()} of ${contextUsage.window.toLocaleString()} tokens (${contextPercent}%)`
      : undefined;
  const countsLabel = countsText ? `Context used: ${countsText}` : undefined;

  return (
    // `pb-3` matches the scroller's own inset. It used to be `pb-10`, because
    // a pane collapse toggle floated at `bottom-2 left-2` and would have sat on
    // top of the Context line; that toggle is retired with the panes' collapse
    // flags (ADR 0094), so the block keeps ordinary padding. (Its old comment
    // said the chrome bar's app-control cluster was "the gear alone" — that
    // cluster is gone too: ADR 0095 moved the Settings door into the Session
    // list.)
    <div
      data-testid="session-config-block"
      className="shrink-0 px-3 pb-3 pt-2"
    >
      <div className="flex flex-col gap-1.5" data-testid="session-config-controls">
        {/* Model, then Reasoning, then Context: one control per line, each
            full line-width (`fullWidth` — see `SessionConfigSelect`). REASONING
            IS THE EXCEPTION: it renders only when the session's options carry a
            `thought_level` select, so the line order is Model → [Reasoning] →
            Context. The composer's tight `gap-1` cluster is gone: it existed to
            knit two side-by-side triggers into one block of session config, and
            on a stacked line there is nothing to knit. */}
        <div className="min-w-0">
          <SessionConfigSelect
            kind="model"
            option={modelOption ?? null}
            onSet={onSet}
            items={catalogItems}
            fullWidth
          />
        </div>
        {/* Reasoning is the ONE gated line: it renders only when the session's
            options carry a `thought_level` select, so a model advertising no
            thinking levels shows no thinking control at all (the user asked for
            exactly that — a dropdown that can never open is a lie about the
            model). The asymmetry against the Model line above is deliberate: a
            model selector is meaningful for ANY session (the user can always
            switch to a model that has levels), a thinking selector is not for a
            model that has none. The Rust harness already omits the option in
            that case (`synthesize_catalog_config_options`), and this guard is
            the frontend honouring it rather than manufacturing a stub back.
            `findConfigOption` returns `undefined` for every no-level state
            (option absent / empty options / no config options at all), so the
            same rule covers "we do not know the config" — one rule, no stub. */}
        {thinkingOption && (
          <div className="min-w-0">
            <SessionConfigSelect
              kind="thinking"
              option={thinkingOption}
              onSet={onSet}
              fullWidth
            />
          </div>
        )}
        {/* The context bar (the dynamic percentage — the reference UI's
            `🧠 [====] 61%` look), ALWAYS rendered: a live session's fill appears
            as the session grows, the label waits for the first frame, and a
            closed session (the context is dropped on close — re-emitted on
            resume) shows the empty 0% track. No well, no rounded box — the bar
            rides the pane's own plane (see the component note for why). */}
        <div
          className="flex min-w-0 items-center gap-2"
          data-testid="context-usage-bar"
        >
          <Brain
            className="size-3.5 shrink-0 text-foreground-subtle"
            aria-hidden
            data-testid="context-bar-icon"
          />
          {/* The counts ride the progressbar as its TEXT alternative
              (`aria-valuetext`) — a bare percentage is what the bar draws, but
              the numbers are the useful part and a progressbar exposes only its
              value. */}
          {/* The track is its OWN token (`--color-context-track`), not the
              subtlest-TEXT token it used to borrow. The bar's whole meaning is
              the band FILL (green → caution → warning → red) and the track is
              the only thing separating that fill from the unfilled remainder;
              under Dracula the borrowed Comment hue measured 3.43 / 4.21 /
              2.76 / 1.73 against the four fills this component emits, so the red
              band was almost invisible on the bar it was drawn on. Every palette
              but Dracula aliases the new token straight back to
              `foreground-subtlest`, so the default palette renders EXACTLY as it always
              has. The
              per-palette ratios (track vs the pane it rides, and each band vs
              the track) are pinned in the context-bar gate in
              `paletteCompleteness.test.ts`. */}
          <div
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={contextPercent ?? 0}
            aria-valuetext={countsText}
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-context-track"
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                contextRamp.fill,
              )}
              style={{ width: `${contextPercent ?? 0}%` }}
            />
          </div>
          {contextPercent !== undefined && contextUsage && (
            <TooltipProvider>
              <Tooltip>
                {/* The trigger is a BUTTON, not a `<span>`: Radix opens
                    the tooltip on focus, so the counts are
                    keyboard-reachable only if the trigger is a tab stop;
                    and they ride in the accessible NAME, so they are
                    heard without opening the tooltip at all. Visuals are
                    unchanged — the reset classes keep the bare-number
                    look. */}
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="link"
                    size="default"
                    data-testid="context-usage"
                    aria-label={countsLabel}
                    className={cn(
                      PERCENT_TRIGGER_WALL,
                      // The ramp's `label` is a text COLOUR and the base spells
                      // `text-ui-sm`, a font size: `mergeUiClasses` registers
                      // `text-ui-*` as its own group precisely so these two do
                      // not fight. Measured — both survive the merge.
                      "shrink-0 cursor-help appearance-none rounded-sm border-0 bg-transparent p-0 text-ui-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      contextRamp.label,
                    )}
                  >
                    {contextPercent}%
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="end">
                  {contextUsage.used.toLocaleString()} /{" "}
                  {contextUsage.window.toLocaleString()} tokens ·{" "}
                  {contextPercent}% of context
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </div>
  );
}
