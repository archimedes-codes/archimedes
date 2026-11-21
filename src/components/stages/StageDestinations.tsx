import type { KeyboardEvent, MouseEvent, ReactElement } from "react";
import { ChevronUpIcon, XIcon } from "lucide-react";
import { MutedCaption } from "../MutedCaption";
import { cn } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ROW_SELECT } from "./stageStyles";

/**
 * The **ordered destination list** of one Stage row — the state caption that stands
 * in when there are no chips, the chips themselves, and the `Select` that appends
 * one. The only place in the Stage editor where markup genuinely repeats.
 *
 * WHY THIS IS A COMPONENT AND THE REST OF THE ROW IS NOT CUT THE SAME WAY: this
 * block is a `map` over the list and the two buttons on each chip are the same
 * shape spelled twice (`ChevronUpIcon` / `XIcon`), so it is a subject with its own
 * data and its own two writes. The rest of the row is one field, one `Select` and
 * three icon buttons — nothing repeats there.
 *
 * **It renders NO element of its own around the block and reads no store.** It
 * returns the fragment that used to sit inside the row's control `<div>`, so the
 * DOM is byte-for-byte what the row rendered before — and the Skill `Select`, which
 * is the third item in that same `<div>`, stays in the row (it is not about
 * destinations). It also takes no `spacePath`: both of its writes are WHOLE-LIST
 * writes (`set_stage_next` takes the ENTIRE ordered list, never one edge), so the
 * row that owns the slug implements them and hands them down as `onWrite` /
 * `onAdd`. That is what keeps this component about the LIST rather than about a
 * Stage.
 *
 * **`destinations` is `string[] | null`, not `string[]`.** The two empties are
 * opposite facts and the caption is the only place either is shown: `null` is
 * UNCONFIGURED ("any column may follow") and `[]` is CONFIGURED-AND-CLOSED ("nothing
 * may follow") — ADR 0099, and `StageEditor.test.tsx` pins both sentences. So the
 * `null` has to reach the component that renders the caption, which is this one;
 * collapsing it to `[]` at the row would make the two states indistinguishable here
 * and would print the wrong sentence for a closed board.
 *
 * TWO THINGS HERE ARE PINNED BY TESTS AND MUST NOT BE "TIDIED":
 *  - the add-destination `Select`'s `key`. It is UNCONTROLLED, so without a key
 *    change it keeps the item the user just picked and shows it in the trigger
 *    forever — and a second pick of that same destination is then a silent no-op the
 *    user reads as a broken control. It is keyed on the CURRENT LIST, so every
 *    append remounts it back to its placeholder.
 *  - every `stop(event)`. This block sits inside a `role="button"` row whose single
 *    affordance is "focus this Stage's label field", so a chip click that bubbled
 *    would steal focus out of the control the user just used, and a keydown that
 *    bubbled would fire the row's Enter handler on top of the chip's own action
 *    (`RowButton` activates on Enter from its own handler and keydown bubbles).
 */
export function StageDestinations({
  stageSlug,
  destinations,
  candidates,
  labelOf,
  onWrite,
  onAdd,
}: {
  stageSlug: string;
  /** The configured destinations, in render order. The FIRST entry is the card's
   *  primary next step (ADR 0099 / CONTEXT.md "primary next step"), which is why
   *  these are ordered chips and not a set. `null` is UNCONFIGURED — see the header. */
  destinations: string[] | null;
  /** Every OTHER Stage of the Space — a self-loop is refused server-side, so
   *  offering it would be a control that can only fail. */
  candidates: { slug: string; label: string }[];
  /** Resolve a slug to its label; falls back to the slug at the CALLER, so an edge
   *  the slice cannot resolve still shows its slug rather than shrinking the graph. */
  labelOf: (slug: string) => string;
  /** Write the whole ordered list (the shape `setStageNext` takes). */
  onWrite: (next: string[]) => void;
  /** Append one destination (owns the `null` → list and dedupe rules). */
  onAdd: (slug: string) => void;
}): ReactElement {
  const stop = (event: MouseEvent | KeyboardEvent): void => event.stopPropagation();
  // The `null` arm joins as `[]`, exactly as the row spelled it before
  // (`stage.nextSlugs ?? []`), so the add-`Select`'s key is the same string.
  const list = destinations ?? [];

  return (
    <>
      {destinations === null || list.length === 0 ? (
        <MutedCaption data-testid="destination-state">
          {destinations === null
            ? "Unconfigured — any column may follow"
            : "No destinations — nothing may follow"}
        </MutedCaption>
      ) : (
        list.map((slug, index) => {
          const label = labelOf(slug);
          return (
            <span
              data-testid={`destination-${slug}`}
              key={slug}
              className="flex min-w-0 shrink-0 items-center gap-0.5 rounded-md bg-panel py-0.5 pr-0.5 pl-2 text-ui-sm text-foreground-subtle"
            >
              <span className="min-w-0 truncate">{label}</span>
              <button
                type="button"
                aria-label={`Move ${label} earlier in ${stageSlug}`}
                title={`Move ${label} earlier in ${stageSlug}`}
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded text-foreground-subtlest",
                  // The FIRST chip has nothing earlier to move to; an inert
                  // affordance is honest, a missing one is a moving layout.
                  index === 0
                    ? "opacity-40"
                    : "hover:bg-surface-hover hover:text-foreground",
                )}
                disabled={index === 0}
                onKeyDown={stop}
                onClick={(event) => {
                  stop(event);
                  if (index === 0) return;
                  const next = [...list];
                  const [moved] = next.splice(index, 1);
                  next.splice(index - 1, 0, moved!);
                  onWrite(next);
                }}
              >
                <ChevronUpIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Remove ${label} from ${stageSlug}`}
                title={`Remove ${label} from ${stageSlug}`}
                className="flex size-5 shrink-0 items-center justify-center rounded text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
                onKeyDown={stop}
                onClick={(event) => {
                  stop(event);
                  onWrite(list.filter((s) => s !== slug));
                }}
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
          );
        })
      )}

      <Select
        // Uncontrolled and keyed on the current list, so the trigger reads
        // "Add a destination" again after each append instead of showing the
        // destination that was just added (a second pick would then be a
        // no-op the user reads as a broken control).
        key={`add-${stageSlug}-${list.join(",")}`}
        onValueChange={(next) => onAdd(next)}
      >
        <SelectTrigger
          aria-label={`Add a destination for ${stageSlug}`}
          className={ROW_SELECT}
          variant="ghost"
          onClick={stop}
          onKeyDown={stop}
        >
          <SelectValue placeholder="Add a destination" />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((c) => (
            <SelectItem key={c.slug} value={c.slug}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
