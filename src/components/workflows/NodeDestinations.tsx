import type { ReactElement } from "react";
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

import { PANEL_SELECT } from "./settingsStyles";

/**
 * The **ordered destination list** of one node — the state caption that stands in
 * when there are no chips, the chips themselves, the `Select` that appends one, and
 * the sentence that says which edge the chain actually follows.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE DESTINATION BLOCK OF `stages/StageDestinations.tsx`, RE-HOMED
 * ---------------------------------------------------------------------------
 *
 * Same three states, same two whole-list writes, same accessible names and
 * `data-testid`s, same `key` on the uncontrolled add-`Select`. It is a move and not
 * a redesign, because the board's stage dialog had already pinned this block
 * case-by-case and the panel took those fields over when the dialog was deleted.
 * What was ADDED is one element, `destination-fanout`, for
 * the one thing a row of chips could never say (below).
 *
 * It renders no element of its own around the block and reads no store, exactly as
 * the dialog's version did: both writes are WHOLE-LIST writes (`set_stage_next`
 * takes the ENTIRE ordered list, never one edge), so the component that owns the
 * slug implements them and hands them down as `onWrite` / `onAdd`. That is what
 * keeps this file about the LIST rather than about a Stage.
 *
 * ---------------------------------------------------------------------------
 * `destinations` IS `string[] | null`, AND THE THIRD STATE IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * The two empties are opposite facts and this caption is the only place either is
 * shown: `null` is UNCONFIGURED ("any column may follow", and the runtime uses the
 * column at `sortOrder + 1`) and `[]` is CONFIGURED-AND-CLOSED ("nothing may
 * follow") — ADR 0099, pinned by two sentences in the dialog's suite and two more
 * here. So the `null` has to reach the component that renders the caption;
 * collapsing it to `[]` upstream would print the wrong sentence for a closed board
 * and would manufacture, on screen, the edge a person deleted.
 *
 * ---------------------------------------------------------------------------
 * THE FAN-OUT SENTENCE, AND WHY IT IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * `nextSlugs` is an ordered list and **the auto-chain follows `[0]` only**:
 * `nextStepOf` in `src/lib/workflowGraph.ts` reads
 * `nextStepSlugs(columns, stage)[0]` and returns that one column, which is the same
 * single answer the card's launch pill and the detail modal's buttons take. A card
 * lives in exactly ONE column — `tasks.stage_slug` is one string — so a column with
 * two destinations is not two parallel Sessions. It is one followed edge and one
 * the chain ignores.
 *
 * Nothing in the app said that out loud. The kanban shows neither edge; the canvas
 * draws both as identical wires; the dialog's chips were ordered but unexplained.
 * An owner who asks for "one node fires several" gets, from the data model, a list
 * whose head is the step and whose tail is a Strict-mode permission — so the panel
 * NAMES the live edge and NAMES the ones that are not followed, rather than
 * rendering two equal-looking wires and letting the picture imply a fork.
 *
 * The head being unresolvable (an edge to a column this read cannot name) is stated
 * too rather than papered over: `nextStepOf` yields NOTHING for it, so claiming a
 * live edge there would be a sentence about a hop the runtime will not take.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS HERE ARE PINNED BY TESTS AND MUST NOT BE "TIDIED"
 * ---------------------------------------------------------------------------
 *
 *  - the add-destination `Select`'s `key`. It is UNCONTROLLED, so without a key
 *    change it keeps the item the person just picked and shows it in the trigger
 *    forever — and a second pick of that same destination is then a silent no-op
 *    they read as a broken control. It is keyed on the CURRENT LIST.
 *  - the `disabled` on the FIRST chip's reorder button. An inert affordance is honest
 *    and a missing one is a moving layout, which is the same reason the reorder arrows
 *    in the body carry `aria-disabled` rather than disappearing.
 *
 * WHAT WAS DROPPED, and it is a decision: every `stopPropagation()` this block carried
 * in the dialog. Its row was a `role="button"` whose single affordance was "focus this
 * Stage's label field", so a chip click that bubbled stole focus out of the control the
 * person had just used, and that dialog's suite pinned it twice. A panel section is
 * a plain `<div>` with no row affordance, so there is nothing to bubble INTO — and stops
 * with no subject are the thing that makes the next reader add a handler to match.
 */
export function NodeDestinations({
  stageSlug,
  destinations,
  candidates,
  labelOf,
  headResolvable = true,
  impliedSlug = null,
  onWrite,
  onAdd,
}: {
  stageSlug: string;
  /** The configured destinations, in render order. The FIRST entry is the card's
   *  primary next step (ADR 0099 / CONTEXT.md) — the one `nextStepOf` returns —
   *  which is why these are ordered chips and not a set. `null` is UNCONFIGURED. */
  destinations: string[] | null;
  /** Every OTHER Stage of the Space. The caller excludes this column itself: a
   *  self-loop is refused by `set_stage_next`, so offering it would be a control
   *  that can only fail. */
  candidates: { slug: string; label: string }[];
  /** Resolve a slug to its label; falls back to the slug at the CALLER, so an edge
   *  the slice cannot resolve still shows its slug rather than shrinking the graph. */
  labelOf: (slug: string) => string;
  /** Can the FIRST destination be resolved to a column this read holds? The caller
   *  answers it (it holds the column set) and it decides the fan-out sentence's
   *  head clause — see `fanOutSentence` for why it is not inferred from `labelOf`.
   *  Defaults to `true`, the answer for every board whose edges resolve. */
  headResolvable?: boolean;
  /** The column the ORDER implies for an UNCONFIGURED column — `nextStepSlugs`'s
   *  `sortOrder + 1` answer, which is what the canvas draws as a DASHED wire
   *  (`IMPLICIT_EDGE_CLASS`). `null` when there is no such column (the last one
   *  standing) and for any configured list, because a configured column has no
   *  fallback to name.
   *
   *  A PROP and not something derived here: this component takes the destination LIST,
   *  not the column set, and `sortOrder + 1` is a question about the set. The caller
   *  (`NodeSettingsBody`) holds the slice and asks `nextStepSlugs` — the ONE derivation —
   *  so the panel cannot print a neighbour the graph did not draw.
   *
   *  Rendered as a SENTENCE and not a chip on purpose: a chip carries remove and reorder,
   *  and "remove" here would have to write `[]`, i.e. CLOSE the column rather than unlink
   *  a destination. An affordance whose verb is a lie is the dead-control shape this repo
   *  refuses. */
  impliedSlug?: string | null;
  /** Write the whole ordered list (the shape `setStageNext` takes). */
  onWrite: (next: string[]) => void;
  /** Append one destination (the caller owns the `null` → list and dedupe rules). */
  onAdd: (slug: string) => void;
}): ReactElement {
  // The `null` arm joins as `[]`, exactly as the dialog's row spelled it
  // (`stage.nextSlugs ?? []`), so the add-`Select`'s key is the same string.
  const list = destinations ?? [];
  // Only an UNCONFIGURED column has an implied next step, and the prop is honoured ONLY
  // there — so a caller that passes a slug beside a configured list gets silence rather
  // than a sentence about a fallback that `nextStepSlugs` would never answer.
  const implied =
    destinations === null && impliedSlug !== null
      ? labelOf(impliedSlug)
      : null;

  return (
    <>
      {destinations === null || list.length === 0 ? (
        <MutedCaption as="p" data-testid="destination-state" className="min-w-0">
          {destinations === null
            ? implied === null
              ? "Unconfigured — any column may follow, and the chain uses the column after this one"
              : `Unconfigured — any column may follow, and the chain uses ${implied}, implied by the order`
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
                onClick={() => {
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
                onClick={() => onWrite(list.filter((s) => s !== slug))}
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
          );
        })
      )}

      {/* THE FAN-OUT TRUTH. Only when there IS more than one destination, because
          with one there is nothing to disambiguate and the sentence would be noise
          wearing the weight of a warning. The head is named as the followed edge
          because `nextStepOf` takes `nextStepSlugs(...)[0]`; the tail is named as
          unfollowed because a card has one column, not two. */}
      {list.length > 1 && (
        <MutedCaption as="p" data-testid="destination-fanout" className="min-w-0">
          {fanOutSentence(list, labelOf, headResolvable)}
        </MutedCaption>
      )}

      <Select
        // Uncontrolled and keyed on the current list, so the trigger reads
        // "Add a destination" again after each append instead of showing the
        // destination that was just added (a second pick would then be a
        // no-op the person reads as a broken control).
        key={`add-${stageSlug}-${list.join(",")}`}
        onValueChange={(next) => onAdd(next)}
      >
        <SelectTrigger
          aria-label={`Add a destination for ${stageSlug}`}
          className={PANEL_SELECT}
          variant="ghost"
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
      {/* The chips wrap in the CALLER's stack: this fragment adds no element of its own,
          so the DOM stays the flat sibling list the dialog's block rendered. */}
    </>
  );
}

/** Join names the way a sentence does it: `A`, `A and B`, `A, B and C`. */
const andList = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * The sentence that says which edge is live.
 *
 * `nextStepOf` takes the HEAD of `nextStepSlugs`, so the head is the followed edge
 * and everything after it is a Strict-mode permission and nothing more. A card has
 * one `stage_slug`, so this is never a fork, and the sentence says so because the
 * canvas draws every one of these as an identical wire.
 *
 * The head being unresolvable (an edge whose slug the loaded columns cannot name)
 * gets its own clause, and `headResolvable` is a PROP rather than something inferred
 * from `labelOf(head) === head`: that comparison is true for a correctly configured
 * column whose label happens to equal its slug (`done` / `done`, which `createStage`
 * derives from a lowercase label), and a panel that told such a person their chain
 * was dead would be inventing a defect. `NodeSettingsBody` has the column set in
 * hand and answers the question directly.
 */
const fanOutSentence = (
  list: readonly string[],
  labelOf: (slug: string) => string,
  headResolvable: boolean,
): string => {
  const head = list[0]!;
  const others = andList(list.slice(1).map((slug) => labelOf(slug)));
  const plural = list.length === 2 ? "is" : "are";
  const edges = list.length === 2 ? "edge" : "edges";
  const headClause = headResolvable
    ? `Follows ${labelOf(head)} only. `
    : `Follows ${labelOf(head)} only, and no column this read can resolve carries that slug, so the chain follows nothing here. `;
  return (
    `${headClause}${others} ${plural} not followed. ` +
    `A card lives in exactly one column, so this is not several parallel runs — ` +
    `the other ${edges} only ${edges === "edge" ? "says" : "say"} what a drag may land on while Strict workflow is on.`
  );
};
