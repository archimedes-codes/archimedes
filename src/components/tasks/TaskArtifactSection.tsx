import { ChevronRightIcon } from "lucide-react";
import { AgentMarkdown } from "../AgentMarkdown";
import { IpcErrorLine } from "../IpcErrorLine";
import { MutedCaption } from "../MutedCaption";
import { cn } from "../lib/utils";
import { fileIconFor } from "../../lib/fileIcons";
import type { Artifact } from "../../lib/tauri";

/** Every **Task artifact** is markdown (ADR 0100), so the key row's leading glyph is
 *  the `fileIconFor("x.md")` descriptor — the SAME `FileTextIcon` in `text-file-md`
 *  that the transcript's `FileChip` draws for a `.md` fence. Resolved ONCE at module
 *  scope: the extension-table lookup is constant, so a per-row call would re-derive
 *  the same answer for every key on the rail.
 *
 *  The glyph is what makes "has a leading icon" mean "clickable" in this dialog — the
 *  read-only `id` / `spec` rows deliberately carry none (see `MetaRow`). */
const ARTIFACT_SPEC = fileIconFor("x.md");
const ArtifactGlyph = ARTIFACT_SPEC.icon;

export interface TaskArtifactSectionProps {
  /** The keys the board read carried. KEYS ONLY, never content. */
  artifactKeys: string[];
  selectedKey: string | null;
  selectedArtifact: Artifact | null;
  artifactError: string | null;
  onSelect: (key: string) => Promise<void>;
}

/**
 * THE ARTIFACT REGION — the key rail and the selected key's document, as ONE child
 * (ADR 0114).
 *
 * ## Why ONE child and not two
 *
 * The rail and the pane read the SAME selection. `aria-current` on a key row and the
 * pane's gate both answer "which key am I looking at", and two children each holding
 * their own reader would be two answers to the one question that has a single answer
 * on screen. That is what forces the region to move whole (ADR 0114).
 *
 * ## The reader is NOT mounted here
 *
 * `useArtifactReader` stays mounted ONCE by `TaskDetailDialog`, which hands down the
 * selection it owns. This component is a pure function of what it was handed: no
 * store read, no `await`, no request epoch of its own — the epoch lives with the
 * `await` that needs it, and the only `await` is in the hook.
 *
 * ## It adds NO DOM level
 *
 * The returned root IS the `artifact-section` `<div>`, with nothing wrapped around it.
 * `TaskDetailDialog.test.tsx` asserts structure through `.parentElement` (the rail's,
 * the pane's) and through the dialog's single `.overflow-y-auto` scroller by identity,
 * and a component boundary contributes no node — so this file is invisible to those
 * pins exactly as long as it returns one element and no wrapper `<div>`. A wrapper
 * would redden four of them.
 *
 * ## `artifactKeys.length > 0` is the CALLER's gate
 *
 * It stays in the dialog because the same array also decides the shell's width class
 * and the "no detail yet" line. A Task with no artifacts renders NO node at all from
 * here — no header, no rail, no pane, no placeholder.
 */
export function TaskArtifactSection({
  artifactKeys,
  selectedKey,
  selectedArtifact,
  artifactError,
  onSelect,
}: TaskArtifactSectionProps) {
  return (
    // `shrink-0` and NO `min-h-0` — the opposite of the rule that governs the
    // SCROLLER, and the direction people get backwards. `detail-scroll` is a
    // definite-height column flex box, so a section holding `min-h-0` and the
    // default `flex-shrink: 1` is COMPRESSED the moment the unbounded pane below
    // is tall; and a compressed element with `overflow: visible` neither scrolls
    // nor grows the scroller — it PAINTS OVER the Sessions and Meta rows under
    // it, which is a worse failure than the one this region fixes. #181's clip
    // was a missing `min-h-0` on the SCROLLER, never a missing `shrink-0` on a
    // child. So the pane stays unbounded (its height IS its content's height) and
    // the section that contains it refuses to compress.
    <div
      data-testid="artifact-section"
      className="flex shrink-0 flex-col gap-1"
    >
      <MutedCaption className="shrink-0">Artifacts</MutedCaption>
      {/* TWO COLUMNS above the dialog's breakpoint, ONE STACK below it, inside the
          ONE scroller.

          The rail is `sm:sticky sm:top-0 self-start` so it survives scrolling a
          long document; `self-start` is what stops it stretching to the row's full
          height, because a stretched sticky element has nowhere to stick.

          WHY IT STACKS: `w-44` + `shrink-0` was an unconditional 176px, and the
          app declares NO minimum window width (`tauri.conf.json`'s window block
          has no `minWidth`), so a squeezed window is reachable, not hypothetical.
          At a 400px viewport the dialog runs `max-w-[calc(100%-2rem)]` = 368px and
          32px of `p-4` + 176px of rail + 8px of `gap-2` + the pane's own `px-3`
          left ~126px for DOCUMENT TEXT — headings, list indents and code columns
          crushed into a gutter, with tables scrolling sideways. So below the
          breakpoint the rail takes the row's full width and the document gets all
          of it. Both arms reach CSS because they are DIFFERENT variants — `w-full`
          is unconditional and `sm:w-44` lives inside a `min-width: 40rem` media
          query that Tailwind emits after the base utilities, so the wide arm wins
          above 640px and the narrow arm below it. (Verified against `twMerge` too,
          even though this `className` is a plain literal and no `cn()` is involved:
          the modifier puts the two in different groups, so a future caller passing
          this through `cn()` could not silently drop one — the trap `ui/dialog.tsx`
          records for a bare `max-w-*` losing to `sm:max-w-md`.)

          `sticky` moves to the `sm:` arm with the width rather than staying
          unconditional, because stickiness is a property OF THE TWO-COLUMN LAYOUT:
          a stuck element is PAINTED over whatever sits at its stuck position, so a
          sticky rail stacked ABOVE a document would cover the document's first
          lines for the whole scroll.

          CROSS-AXIS ALIGNMENT FLIPS AXES when a row becomes a column, so both
          alignment tokens are conditional. Above the breakpoint `items-start` on
          the row + `self-start` on the rail stop the rail stretching to the row's
          height — and a stretched sticky element has nowhere to stick, so without
          them `sticky` does nothing. Below it, that same `items-start` would
          shrink-wrap the DOCUMENT to its content width, crushing the measure the
          same way the fixed rail did and hiding the pane's own border; so the
          narrow arm asks for `items-stretch` (the CSS default, spelled out so the
          pin can see it) and only the wide arm asks for `items-start`. The rail's
          `self-start` is safe unconditionally — it beats the row's stretch, and a
          full-width rail is 100% of the row either way. `shrink-0` stays
          unconditional too: it refuses compression along the MAIN axis, which is
          horizontal above the breakpoint and vertical below it. */}
      <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-start">
        <div
          data-testid="artifact-rail"
          // `bg-popover` is LOAD-BEARING, not decoration. `sticky` floats the rail
          // OVER the scrolling content and `DialogContent`'s own surface is
          // `bg-popover` (`ui/dialog.tsx:66`), so a transparent rail is a stencil:
          // a long document scrolls visibly THROUGH the key rows. `rounded-md`
          // keeps its corners off the pane's border. `sm:w-44` is 11rem = 176px at
          // the 16px root — the rail width spec §3 names, now the wide-window arm.
          className="flex w-full shrink-0 flex-col gap-1 self-start rounded-md bg-popover sm:sticky sm:top-0 sm:w-44"
        >
      {artifactKeys.map((key) => (
        // THE CLICKABLE GRAMMAR (spec §2): leading glyph → key → trailing
        // chevron, and `bg-selected` when it is the key being read. No new
        // component and no new token — the glyph is the one the transcript's
        // `FileChip` draws for a `.md` fence, the chevron is already this app's
        // "this goes somewhere" mark, and `bg-selected` is the sidebar's
        // active-row fill. The 5% hover wash that used to be the ONLY thing
        // separating this row from the read-only `id` row below is no longer the
        // whole signal.
        <button
          key={key}
          type="button"
          data-testid="artifact-key"
          data-artifact-key={key}
          // Which key the reader is showing — the list gives no other answer to
          // "which one am I looking at". An attribute, not a second element.
          // `false || undefined` is `undefined`, so an unselected row simply
          // omits the attribute; this is correct and is NOT to be "fixed" to
          // `"false"`.
          aria-current={selectedKey === key || undefined}
          onClick={() => void onSelect(key)}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm text-foreground-subtle hover:text-foreground",
            // Exactly ONE of these reaches the class list, which is also what
            // stops a selected row's hover from replacing its own fill (the same
            // measured reasoning `SessionListRow.tsx:129` records).
            selectedKey === key ? "bg-selected text-foreground" : "hover:bg-surface-hover",
          )}
        >
          <ArtifactGlyph
            data-testid="artifact-key-glyph"
            className={cn("size-3.5 shrink-0", ARTIFACT_SPEC.className)}
          />
          {/* The key is the row's ONLY text node — the glyph and the chevron are
              `<svg>` elements that carry none — so `textContent` stays exactly
              the key. */}
          <span className="min-w-0 flex-1 truncate font-mono text-ui-xs">
            {key}
          </span>
          <ChevronRightIcon
            data-testid="artifact-key-chevron"
            // The lone token is fine here: the `mutedCaption.test.ts` census
            // matches the ADJACENT PAIR `text-ui-xs text-foreground-subtlest`,
            // and `SpacesList.tsx:1046` already spells this same glyph's chevron
            // with it alone.
            className="size-3.5 shrink-0 text-foreground-subtlest"
          />
        </button>
      ))}
        </div>
        {/* THE PANE. No `max-h`, no `overflow-y-auto`, no `shrink-0`: its height IS
            its content's height and `detail-scroll` is the ONLY scrollbar in this
            dialog now. The old `max-h-72 … overflow-y-auto` reader box was a
            scrollbar nested inside the dialog's own — two in one wheel gesture, the
            wheel-stealing kind — which is the defect spec §3 exists to remove. The
            document grows to full height and the sticky rail follows it. */}
        {(selectedArtifact !== null || artifactError !== null) && (
          // The gate is what keeps spec §3's "artifacts, none selected → rail ONLY,
          // no placeholder pane" state true AND what keeps the `null`-is-an-answer
          // pin green: a key that answers `null` must render NO document node at all,
          // and an always-present pane would break that test.
          //
          // `sm:flex-1` and not `flex-1`: the grow is for the TWO-COLUMN row, where
          // the main axis is horizontal and this is what gives the document the width
          // the rail leaves. Below the breakpoint the row stacks, the main axis turns
          // vertical, and `flex: 1 1 0%` would put a `0%` basis on HEIGHT — a layout
          // resting on whether a percentage resolves against an indefinite height.
          // Stretched cross-axis already gives it the full width there, so the narrow
          // arm is left at plain content height. `min-w-0` stays unconditional: above
          // the breakpoint it lets a long code line shrink instead of pushing the rail
          // out, and below it it stops one unbreakable word widening the dialog.
          <div className="min-w-0 sm:flex-1">
            {selectedArtifact !== null && (
              <div
                data-testid="artifact-body"
                className="rounded-lg border border-border px-3 py-2"
              >
                <AgentMarkdown text={selectedArtifact.markdown} />
              </div>
            )}
            {/* An artifact read failure belongs in THIS column and never in the
                launch `error` cell — the two failures are about different things, and
                one cell would let a stale launch sentence sit under a reader failure
                or make a reader failure claim the launch failed. */}
            <IpcErrorLine error={artifactError} className="shrink-0" />
          </div>
        )}
      </div>
    </div>
  );
}
