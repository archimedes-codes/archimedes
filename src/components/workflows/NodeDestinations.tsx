import { useState } from "react";
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

import { EDGE_OUTCOME_SUGGESTIONS } from "../../lib/workflowEdgeWrite";

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
  outcomes = null,
  candidates,
  labelOf,
  headResolvable = true,
  impliedSlug = null,
  onPendingOutcomeChange,
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
   *  that can only fail.
   *
   *  The caller computes this list WITH the name the add-control is showing (see
   *  `onPendingOutcomeChange`), and it has to:
   *  `canConnectStages` refuses an unnamed edge onto a destination the column already
   *  holds and ALLOWS a named one, so which options are legal depends on the name about
   *  to be added. A name held in this component's own state would leave the caller
   *  computing the option set with `outcome = null` and the second edge to one
   *  destination would never appear in the picker. */
  candidates: { slug: string; label: string }[];
  /** The NAME of each edge, POSITIONAL to `destinations`: element `i` names the edge at
   *  `i`, and `null` means that edge carries no label. `null` (or absent) for the whole
   *  prop means "no edge out of here is named", which is every board that exists today —
   *  `stages.next_outcomes` has no SQL `DEFAULT` and is never backfilled.
   *
   *  A short array reads as `advise.rs` reads it ("the edges past its end are
   *  unlabelled"), NOT as an error: the write refuses a length mismatch, but a stale read
   *  must paint a graph rather than crash on one. */
  outcomes?: (string | null)[] | null;
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
  /** Told every time the name picked for the NEXT added edge changes, so the caller can
   *  re-derive `candidates` through `canConnectStages` WITH that name. Optional and
   *  one-directional BY DESIGN: the pick itself is owned HERE (see `pendingOutcome`), so a
   *  caller that mirrors it is reading a draft, not co-owning it — the same shape
   *  `NodeSettingsBody`'s header gives its text drafts ("the drafts live here and die
   *  here"). A caller that ignores this simply never widens its option set. */
  onPendingOutcomeChange?: (outcome: string | null) => void;
  /** Write the whole ordered list AND its positional names (the shape `setStageNext`
   *  takes: both columns in one call, always the same length, because a shifted label is
   *  a card that advances on the wrong claim). */
  onWrite: (next: string[], outcomes: (string | null)[]) => void;
  /** Append one destination with the name it should carry (the caller owns the
   *  `null` → list, the dedupe and the positional padding — all of it lives in
   *  `lib/workflowEdgeWrite`, the one owner of the edge write). */
  onAdd: (slug: string, outcome: string | null) => void;
}): ReactElement {
  // The `null` arm joins as `[]`, exactly as the dialog's row spelled it
  // (`stage.nextSlugs ?? []`), so the add-`Select`'s key is the same string.
  const list = destinations ?? [];
  // The positional names, padded to the list's length. `null` for the whole prop and a
  // short array both mean "these edges name nothing" — the same reading `advise.rs`
  // applies, so the panel and the decider cannot disagree about which edge a name sits on.
  const names = list.map((_, index) => outcomes?.[index] ?? null);
  // Does ANY edge carry a name? This single boolean decides which fan-out sentence prints,
  // and therefore whether the sentence may claim the tail is unfollowed at all.
  const anyNamed = names.some((name) => name !== null);
  /** The name picked for the NEXT added edge — a DRAFT, owned here, `null` until somebody
   *  picks one. `onAdd` reads THIS and nothing else, so the name in the payload is the
   *  name the trigger is showing; a caller that passed a mirrored copy of its own could
   *  write a label the person never saw selected. Reported upward for one purpose only:
   *  the caller's `candidates` needs it to decide whether a second edge to an existing
   *  destination is offerable at all.
   *
   *  STICKY across an add, and visibly so — composing a routing table means naming several
   *  edges in a row, and a control that reset between rows would write `null` for the
   *  second one while the person believed they were still naming. */
  const [pendingOutcome, setPendingOutcome] = useState<string | null>(null);
  // Only an UNCONFIGURED column has an implied next step, and the prop is honoured ONLY
  // there — so a caller that passes a slug beside a configured list gets silence rather
  // than a sentence about a fallback that `nextStepSlugs` would never answer.
  const implied =
    destinations === null && impliedSlug !== null
      ? labelOf(impliedSlug)
      : null;

  /** Write the list with ONE position's name changed, everything else kept. A whole-list
   *  write is the shape `set_stage_next` takes, and positionally it is the only safe one:
   *  sending just the new name would either mismatch the lengths (the `EdgeOutcomeCount`
   *  refusal) or shift every name after it off the edge it belongs to. */
  const writeNameAt = (index: number, outcome: string | null): void => {
    const next = [...names];
    next[index] = outcome;
    onWrite(list, next);
  };

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
          const outcome = names[index];
          // Uniqueness, and only where the new data model breaks it. An accessible name
          // built from the destination alone was unique while a destination could appear
          // once; `["done","done"]` labelled `failed`/`success` is legal now, and two
          // buttons called `Remove Done from backlog` is a control an assistive tech
          // cannot aim. The suffix therefore appears ONLY for a destination this list
          // repeats, so every existing board keeps its accessible names byte-identical —
          // the same compatibility rule `edgeIdOf` follows on the canvas.
          const suffix =
            list.filter((s) => s === slug).length > 1
              ? ` (${outcome ?? "no name"})`
              : "";
          const chipLabel = `${label}${suffix}`;
          return (
            <span
              data-testid={`destination-${slug}${
                outcome === null ? "" : `:${outcome}`
              }`}
              // INDEX in the key, and it is not laziness: `["done","done"]` with no labels
              // on either edge is REACHABLE data — `set_stage_next` never required the list
              // to be a set, which is the very case `workflowGraphLayout` deduplicates on
              // the canvas. A `slug`-only key (what this was) gave React two identical keys
              // for it, and a `slug + name` key does too. An index key is the only spelling
              // that is unique for every row the database can hold, and it costs nothing
              // here because a chip holds no state of its own — the name `Select` is fully
              // controlled by props, and the one piece of local state in this component
              // (`pendingOutcome`) belongs to the add row, not to a chip.
              key={`${slug}-${index}`}
              className="flex min-w-0 shrink-0 items-center gap-0.5 rounded-md bg-panel py-0.5 pr-0.5 pl-2 text-ui-sm text-foreground-subtle"
            >
              {/* Its own testid so a test can read THE DESTINATION NAME off a chip
                  without also reading the name-`Select`'s trigger, which now lives in the
                  same span. `chipText` in the test file queries THIS needle for exactly
                  that reason. */}
              <span
                data-testid={`destination-label-${slug}${
                  outcome === null ? "" : `:${outcome}`
                }`}
                className="min-w-0 truncate"
              >
                {label}
              </span>
              {/* THE EDGE NAME — the only way D6's outcome routing is reachable at all.
                  `mark_done` can name a transition until the cows come home and
                  `advise.rs` will find no edge carrying it and fall back to the head.
                  Suggestions come from `EDGE_OUTCOME_SUGGESTIONS`, the enum the tool
                  actually advertises; they are SUGGESTIONS, since nothing on the wire
                  validates a label, so a name outside the list still routes. */}
              <Select
                value={outcome ?? NO_NAME}
                onValueChange={(next) =>
                  writeNameAt(index, next === NO_NAME ? null : next)
                }
              >
                <SelectTrigger
                  aria-label={`Name the edge to ${chipLabel} from ${stageSlug}`}
                  title={`Which claim takes this edge. Leave it blank and only the head edge is followed.`}
                  // NO height override, and that is a pinned invariant, not an
                  // oversight: `NodeSettingsPanel.test.tsx` requires every field on this
                  // panel to carry the component's own `h-7`, because the whole reason
                  // these controls were moved out of the dialog was that a mix of `h-5`
                  // and `h-7` read as cramped in a 288px pane. A "compact" name control
                  // would be the first regression that pin exists to catch.
                  className={cn(PANEL_SELECT, "max-w-28 border-0")}
                  variant="ghost"
                >
                  <SelectValue placeholder={NO_NAME} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_NAME}>{NO_NAME}</SelectItem>
                  {EDGE_OUTCOME_SUGGESTIONS.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                aria-label={`Move ${chipLabel} earlier in ${stageSlug}`}
                title={`Move ${chipLabel} earlier in ${stageSlug}`}
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
                  // BOTH lists move together. The head is the edge a claim that names
                  // nothing takes, so swapping the slugs and not the names swaps which
                  // name the head carries — a shift no length check can catch, because
                  // the two lists still agree on how long they are.
                  const next = [...list];
                  const nextNames = [...names];
                  const [moved] = next.splice(index, 1);
                  const [movedName] = nextNames.splice(index, 1);
                  next.splice(index - 1, 0, moved!);
                  nextNames.splice(index - 1, 0, movedName!);
                  onWrite(next, nextNames);
                }}
              >
                <ChevronUpIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Remove ${chipLabel} from ${stageSlug}`}
                title={`Remove ${chipLabel} from ${stageSlug}`}
                className="flex size-5 shrink-0 items-center justify-center rounded text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
                // Filtered by INDEX and not by slug. `list.filter(s => s !== slug)` was
                // correct while one destination appeared once; with `["done","done"]` it
                // would delete BOTH edges from a click on one chip — and, worse, leave the
                // names describing the graph that used to be there.
                onClick={() =>
                  onWrite(
                    list.filter((_, i) => i !== index),
                    names.filter((_, i) => i !== index),
                  )
                }
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
          );
        })
      )}

      {/* THE FAN-OUT TRUTH. With no name on any edge this is the sentence it has always
          printed, at `length > 1` and nowhere else. A name changes both halves of that
          rule: a labelled non-head edge IS followed (on a claim that names it), so the
          tail may no longer be called unfollowed; and a name on the ONLY edge is worth a
          sentence at `length === 1`, because the person who just typed one believes they
          configured routing when in fact they configured nothing. See `fanOutSentence`. */}
      {(list.length > 1 || anyNamed) && (
        <MutedCaption as="p" data-testid="destination-fanout" className="min-w-0">
          {fanOutSentence(list, names, labelOf, headResolvable)}
        </MutedCaption>
      )}

      {/* THE NAME THE NEXT EDGE WILL CARRY. It sits beside the add-`Select` rather than
          being folded into it because the two picks answer different questions (which
          column, and what a claim must say to take that edge), and because the destination
          `Select` is uncontrolled and keyed on the list — folding the name into its values
          would mean an `option` per (name × column) pair.

          The pick is held HERE and reported upward, and both halves of that matter. Held
          here so the value in `onAdd` is the value the trigger is showing — a name the
          person cannot see they are about to write is the half-set this repo refuses.
          Reported upward because `canConnectStages` refuses an unnamed edge onto a
          destination the list already holds and ALLOWS a named one, so a caller that
          computed its option set with `outcome = null` would never offer the second edge
          to one destination however the trigger read.

          It is STICKY across an add on purpose, and visible, so it is not a hidden mode:
          composing a routing table means naming several edges in a row, and a control that
          resets itself between rows would write `null` for the second one silently. */}
      <Select
        value={pendingOutcome ?? NO_NAME}
        onValueChange={(next) => {
          const picked = next === NO_NAME ? null : next;
          setPendingOutcome(picked);
          onPendingOutcomeChange?.(picked);
        }}
      >
        <SelectTrigger
          aria-label={`Name for a new edge from ${stageSlug}`}
          title={`Which claim takes a newly added edge. Leave it blank and the new edge is unnamed.`}
          className={cn(PANEL_SELECT, "max-w-28 border-0")}
          variant="ghost"
        >
          <SelectValue placeholder={NO_NAME} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_NAME}>{NO_NAME}</SelectItem>
          {EDGE_OUTCOME_SUGGESTIONS.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        // Uncontrolled and keyed on the current list, so the trigger reads
        // "Add a destination" again after each append instead of showing the
        // destination that was just added (a second pick would then be a
        // no-op the person reads as a broken control).
        key={`add-${stageSlug}-${list.join(",")}`}
        onValueChange={(next) => onAdd(next, pendingOutcome)}
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
 * The sentence that says which edge is live — and the sentence that went FALSE.
 *
 * Until the edge name landed this printed one claim and it was true: `nextStepOf` takes
 * the HEAD of `nextStepSlugs`, so the head is the followed edge and everything after it is
 * a Strict-mode permission and nothing more. `stages.next_outcomes` broke the tail clause.
 * `advise.rs` now answers a `mark_done` claim with "the FIRST edge whose label is the
 * outcome the claim named", falling back to the head only when nothing matches — so a
 * labelled non-head edge **is** followed, on a claim that names it, and a panel still
 * printing "`<others>` are not followed" beside that chip is a UI contradicting its own
 * chips. ADR 0120 §6, `docs/features/task-board-known-gaps.md` §10 and `CONTEXT.md`'s
 * fan-out entry carry the same sentence and moved in the same commit, because a corrected
 * panel beside an uncorrected ADR is the citation-drift failure
 * `docs/features/session-ready-marker.md` documents at length.
 *
 * What survives the rewrite, and deliberately keeps its own words: **exactly one edge
 * fires per claim.** Routing is a choice between doors, not a fork — `tasks.stage_slug` is
 * one value and `idx_workflow_runs_open` is a partial UNIQUE index allowing one open
 * `workflow_runs` row per card, and that index is what stops the spend bound failing open.
 * The unlabelled branch therefore prints the ORIGINAL sentence verbatim: `next_outcomes`
 * has no SQL `DEFAULT` and is never backfilled, so an unlabelled board is every board that
 * exists today and its sentence must be the one it has always printed.
 *
 * The head being unresolvable (an edge whose slug the loaded columns cannot name) gets its
 * own clause in both branches, and `headResolvable` is a PROP rather than something
 * inferred from `labelOf(head) === head`: that comparison is true for a correctly
 * configured column whose label happens to equal its slug (`done` / `done`, which
 * `createStage` derives from a lowercase label), and a panel that told such a person their
 * chain was dead would be inventing a defect. `NodeSettingsBody` has the column set in
 * hand and answers the question directly.
 */
const fanOutSentence = (
  list: readonly string[],
  names: readonly (string | null)[],
  labelOf: (slug: string) => string,
  headResolvable: boolean,
): string => {
  const headLabel = labelOf(list[0]!);
  const edges = list.map((slug, index) => ({
    label: labelOf(slug),
    name: names[index] ?? null,
  }));
  const named = edges.filter((e) => e.name !== null);

  // ONE EDGE, NAMED. The name does nothing, and the person who just typed it needs to be
  // told so rather than left holding a plausible-looking configuration. `advise.rs` takes
  // the first edge whose label matches and falls back to the HEAD otherwise, so with a
  // single edge a claim that names `failed` and a claim that names nothing both land on
  // that same edge. Silence here would be the panel agreeing that routing was configured.
  if (list.length === 1) {
    // The ghost clause still applies, and it is not decoration: `nextStepOf` yields
    // NOTHING for a slug this read cannot resolve, so a named edge to a ghost is not a
    // door at all — the honest sentence is "nothing is taken", not "both claims take it".
    const ghost = headResolvable
      ? ""
      : `No column this read can resolve carries that slug, so the chain follows nothing here. `;
    return (
      `The name on this edge names the only edge out of here, which changes nothing — ` +
      `a claim that names it and a claim that names nothing both take it. ` +
      `${ghost}Add a second destination and the names start choosing between them.`
    );
  }

  if (named.length === 0) {
    const others = andList(edges.slice(1).map((e) => e.label));
    const plural = list.length === 2 ? "is" : "are";
    const otherEdges = list.length === 2 ? "edge" : "edges";
    const headClause = headResolvable
      ? `Follows ${headLabel} only. `
      : `Follows ${headLabel} only, and no column this read can resolve carries that slug, so the chain follows nothing here. `;
    return (
      `${headClause}${others} ${plural} not followed. ` +
      `A card lives in exactly one column, so this is not several parallel runs — ` +
      `the other ${otherEdges} only ${otherEdges === "edge" ? "says" : "say"} what a drag may land on while Strict workflow is on.`
    );
  }

  // SOME EDGE CARRIES A NAME. The head keeps its role — it is what a claim that names
  // nothing takes — so the head clause gains a condition rather than losing its subject.
  const headClause = headResolvable
    ? `Follows ${headLabel} unless a claim names an edge. `
    : `Follows ${headLabel} unless a claim names an edge, and no column this read can resolve carries that slug, so the chain follows nothing here. `;
  const namedPhrase = andList(named.map((e) => `${e.label} (${e.name})`));
  const when =
    named.length === 1
      ? `when a claim names ${named[0]!.name}`
      : "when a claim names them";
  // A NAMELESS edge that is not the head is followed by nothing — `advise.rs` matches a
  // label or takes the head, and this is neither. That is the original sentence's claim,
  // and for these edges it is still the truth, so it stays said.
  const nameless = edges.slice(1).filter((e) => e.name === null);
  const namelessClause =
    nameless.length === 0
      ? ""
      : `${andList(nameless.map((e) => e.label))} ${
          nameless.length === 1 ? "carries" : "carry"
        } no name and ${
          nameless.length === 1 ? "is" : "are"
        } not the head, so ${
          nameless.length === 1 ? "nothing" : "they"
        } ever takes ${nameless.length === 1 ? "it" : "them"}. `;
  return (
    headClause +
    `${namedPhrase} ${named.length === 1 ? "fires" : "fire"} ${when}. ` +
    namelessClause +
    `A card lives in exactly one column, so this is not several parallel runs — ` +
    `exactly one edge fires per claim.`
  );
};

/** The `Select` sentinel for "this edge carries no name". NOT the empty string: Radix
 *  refuses a `SelectItem` with `value=""`, and `""` would be a label that renders as
 *  nothing — the `promptPrefix` `""`-vs-`null` defect, one column over, and here it would
 *  additionally be a label no claim can ever send, because the enum has no `""`. The word
 *  is `no name` and not `none` so it cannot collide with a Skill named `none` in a
 *  reader's head; the two controls sit six rows apart on the same panel. */
const NO_NAME = "no name";
