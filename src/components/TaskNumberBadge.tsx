import type { ReactElement } from "react";
import type { TaskBadge } from "../lib/tauri";

/**
 * The **Task badge** — `T12`, the per-Space `tasks.number` of the most recently LINKED
 * Task (spec D5/D6/D7), carrying the **Stage** it was linked from as a tooltip (D12).
 *
 * Renders NOTHING for `null`, and nothing is the whole negative answer: an empty
 * element would eat a flex `gap` slot and, on the **Side pane**, would turn a
 * two-child column into three (pinned there).
 *
 * WHY THE FILL IS `bg-surface` AND NOT `TaskCard.tsx`'S `bg-background`. This badge
 * sits on FOUR host surfaces (`bg-frame` in the Session list, `bg-inspector` in the
 * Side pane, `bg-chat` in Settings, `bg-card` on a card) plus the row's own
 * `bg-selected` / `bg-surface-hover` states. `bg-background` is an ABSOLUTE token and
 * collapses on several of them — measured, dark readings: its contrast against
 * `--color-frame` is EXACTLY **1.00** in `.theme-default-dark` (the boot default),
 * `.theme-everforest-dark` and `.theme-rose-pine-dark`, i.e. byte-identical to the
 * sidebar behind it. `bg-surface` is an alpha OVERLAY (`rgba(255,255,255,.05)` /
 * `rgba(13,13,13,.03)`), so it is a delta from whatever it lands on and cannot
 * collapse: worst measured case across all 14 palette readings × 5 host surfaces is
 * **1.058** (`.theme-default-light` over `bg-selected`). Same reasoning
 * `slabFloatSeparation.test.ts` already applies to the board's pills — there, the
 * board pill's job is to differ from the CARD, so it wears the page step; here the
 * badge's job is to differ from the CHROME, and the page step IS the chrome. That
 * is also why this file is NOT in that gate's `PILLS` array (adding it would fail by
 * construction: that gate forces its files ONTO `bg-background`); a sibling `it`
 * there enforces the opposite direction.
 *
 * WHY THE TOOLTIP PRINTS THE SLUG, AND WHY THAT IS NOT A BUG TO FIX. The payload
 * carries `task_sessions.stage_slug` — the Stage's identity FROZEN at link time.
 * Resolving a display LABEL would need `boardsBySpace`, which is exactly the
 * stale/unloaded source D4 rejected for this feature: a Space whose board has not
 * been opened has no label to read, and a Space that renamed `research` to `Spike`
 * would have its HISTORY re-labelled. So a Space that renamed `research` to `Spike`
 * still reads `research` here, on purpose. `CONTEXT.md`'s **Stage** entry sets the
 * precedent in the same direction — a rename writes `label` alone and "the editor
 * shows the slug rather than hiding it". Do not reach for the board store to
 * "improve" this string.
 *
 * `text-foreground-subtle` (not `subtlest`) is load-bearing beyond taste:
 * `mutedCaption.test.ts` allow-lists the ADJACENT pair
 * `text-ui-xs text-foreground-subtlest` to `MutedCaption.tsx` alone.
 *
 * `mr-1` because the badge sits INSIDE the masked title span (D7), which carries no
 * `gap` of its own. A static `className` string rather than a `cn()` call is what
 * `classNameConvention.test.ts` accepts for a class list with nothing to merge.
 */
export function TaskNumberBadge({
  badge,
}: {
  badge: TaskBadge | null;
}): ReactElement | null {
  if (badge === null) return null;
  return (
    <span
      title={
        badge.stageSlug === null
          ? `Task T${badge.number}`
          : `Task T${badge.number} — started in ${badge.stageSlug}`
      }
      className="mr-1 shrink-0 rounded-full bg-surface px-2 py-px font-mono text-ui-xs text-foreground-subtle"
    >
      T{badge.number}
    </span>
  );
}
