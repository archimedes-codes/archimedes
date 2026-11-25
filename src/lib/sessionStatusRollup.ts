import type { SessionStatus } from "../hooks/useSessionStatus";

/**
 * The ONE rollup of many Sessions' statuses into the one mark a SURFACE shows:
 * `waiting` > `running` > nothing.
 *
 * ## Why this exists as a module and not as a component's local function
 *
 * It was `SpaceTabs.tsx`'s `tabStatusOf`, and its own doc-comment said it was
 * *"Pure and exported so the precedence is assertable without the tab strip's
 * store fixtures."* The first half was true and the second was simply false — it
 * was a module-private `function`, not exported — so the precedence had **no
 * direct test at all**. What covered it was the tab strip's suite, which reaches
 * it only by mounting the strip, seeding four stores and reading a glyph out of a
 * tab. That is the shape of stale comment this repo keeps tripping over: the
 * claim was written when the extraction was planned, the export never happened,
 * and nothing could tell.
 *
 * The Task board's cards are the second surface to ask the same question ("does
 * this card own a Session that is waiting on someone, or working?"), and per
 * `workflowGraph.ts` — the precedent for exactly this move — two surfaces
 * spelling one precedence is how one of them starts disagreeing with the Sessions
 * it summarises. So the function moved here, IS exported, and the comment above
 * is now the truth it always claimed to be. `SpaceTabs.tsx` imports it; its
 * existing suite is unchanged, and `sessionStatusRollup.test.ts` is what
 * asserts the precedence directly.
 *
 * ## `null` means "nothing to report", and it is not a fifth state
 *
 * [`sessionStatusOf`][0] answers one Session with one of four states. This
 * answers a GROUP, and its answer is deliberately narrower: `waiting`, `running`,
 * or `null`.
 *
 * `live` and `stored` pass through as `null` — the tab strip's reading, which the
 * card inherits rather than re-deciding. A Space with no live Session, and a
 * Session that is live and in an idle turn, are both real and neither is a fact
 * these two surfaces report: the ring belongs to the sidebar row, which is the
 * only place a stored Session is listed at all (`SessionStatusMark`'s header
 * records that), and a tab that is a tab needs no idle mark. A board card has the
 * same reason and a louder one — a ring on every card of an idle Space would
 * paint the whole board with a state nobody asked about, using the glyph set that
 * means "blocked on you" two states away.
 *
 * [0]: ../hooks/useSessionStatus.ts
 *
 * ## The order is the whole rule
 *
 * `waiting` beats `running` because a Session parked on a human is not working —
 * the same precedence `sessionStatusOf` gives one Session, restated here only for
 * the group (a card with two linked Sessions, one holding a permission prompt and
 * one streaming, is blocked on YOU, and a spinner there is the lie). `includes`
 * rather than a sort or a rank table: two states, two lines, and the order is
 * legible as the precedence it is.
 *
 * ## The signature takes `(SessionStatus | undefined)[]` because that is what
 * ## both callers hold
 *
 * Both read a `Record<string, SessionStatus>` (what `useSessionStatuses` answers)
 * by indexing it with ids they got from somewhere else — the strip from the
 * Space's live Sessions, the board from a card's linked Sessions. An id the map
 * never held yields `undefined`, and `tsconfig.json` sets no
 * `noUncheckedIndexedAccess`, so the compiler does not say so. `undefined` is
 * absence, not a status: it must neither outrank a real status beside it nor
 * become a mark of its own. Accepting it here is what keeps both callers from
 * spelling their own `?? "stored"` — a default that would turn "I have not heard
 * of this Session" into "this Session is stored", which is a claim about a
 * Session nobody made.
 */
export function sessionStatusRollupOf(
  statuses: (SessionStatus | undefined)[],
): SessionStatus | null {
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.includes("running")) return "running";
  return null;
}

/** The ONE mark a **Task card** paints, across three states: `waiting` > `ready`
 * > `running` > nothing.
 *
 * ## Why this is a separate answer from [`sessionStatusRollupOf`]
 *
 * That function answers "what are this group of Sessions doing" and is shared with
 * the tab strip, which has no notion of `ready` and must not acquire one. This
 * answers "what does this CARD need from the person looking at the board", which
 * is a wider question with a wider input — the session rollup PLUS the card's own
 * `ready` claim. Keeping them separate is what stops the tab strip inheriting a
 * state it has no way to source.
 *
 * ## Why a card paints ONE mark and not two
 *
 * `ready` first shipped as a SECOND, additive glyph beside the session mark, and
 * the pair was wrong in a way no test could see: a green check next to an amber
 * `?` reads "finished, but blocked", and the two marks disagreed about whether
 * anyone was needed. The underlying fact is single — "the model declared the work
 * done, or it is stuck on you". Collapsing to one mark makes the contradictory
 * state UNREPRESENTABLE instead of merely discouraged, which is the same reason
 * [`sessionStatusRollupOf`] answers one glyph for a group of Sessions.
 *
 * ## The order
 *
 *  - `waiting` first: a Session parked on a HUMAN is the most time-critical thing
 *    a card can be, and this is already the rule [`sessionStatusRollupOf`] gives a
 *    group. A card cannot be more urgent than "answering you is blocked".
 *  - `ready` second: also "a person is needed", to review rather than to unblock.
 *    It outranks `running` because a finished card is IDLE work while a running one
 *    is progress — and this is the case the two-mark design got visibly wrong: a
 *    model that declares `ready` and then starts another turn was showing a
 *    spinner over its own hand-off.
 *  - `running` last: nothing is needed of anyone. It is the weakest claim, and it
 *    is the one that would otherwise hide the two that matter.
 *
 * ## `ready` is a CLAIM and `sessionStatus` is a DERIVATION, and that is fine
 *
 * The two inputs have different epistemic status — `sessionStatus` is computed
 * from live store state, `ready` is a word a model chose to write. The precedence
 * does not need them to agree or to be the same kind of thing; it needs one glyph.
 * A false `ready` is a model lying about being finished, which the mark surfaces
 * rather than conceals — you see the claim and can click through.
 */
export function cardMarkOf({
  sessionStatus,
  ready,
}: {
  sessionStatus: SessionStatus | null;
  ready: boolean;
}): "waiting" | "ready" | "running" | null {
  if (sessionStatus === "waiting") return "waiting";
  if (ready) return "ready";
  // `running` is the ONLY remaining state worth a mark. Named rather than
  // `return sessionStatus`, which the first version did and which `tsc` caught:
  // the parameter is the full `SessionStatus | null`, so returning it verbatim
  // would hand a caller `live` or `stored` and paint a RING on a card — the glyph
  // set that means "blocked on you" two states away. The board never produces
  // those (`sessionStatusRollupOf` answers only `waiting` / `running` / `null`),
  // but this function's contract is about the CARD, so it refuses them itself
  // rather than relying on its caller. Pinned by a test, not by the build.
  return sessionStatus === "running" ? "running" : null;
}
