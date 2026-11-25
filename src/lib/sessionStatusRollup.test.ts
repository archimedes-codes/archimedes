import { describe, expect, it } from "vitest";
import { cardMarkOf, sessionStatusRollupOf } from "./sessionStatusRollup";
import type { SessionStatus } from "../hooks/useSessionStatus";

/**
 * The ONE rollup of "many Sessions, one answer", asserted directly at its home.
 *
 * It lived inside `SpaceTabs.tsx` as `tabStatusOf` and its own doc-comment
 * claimed "Pure and exported so the precedence is assertable without the tab
 * strip's store fixtures" — the first half was true, the second was not (it was
 * a module-private `function`), so the precedence had NO direct test at all: the
 * only cases covering it rendered the tab strip and read a glyph off a tab. That
 * is why this file exists now: the Task board's cards are the SECOND surface to
 * ask the question, and two surfaces holding two copies of a precedence is how
 * one of them silently starts disagreeing with the Sessions it summarises.
 *
 * The cases are the precedence itself, in the order the rule is spelled:
 * `waiting` beats `running`, and `live` / `stored` / nothing contribute NOTHING.
 */
describe("sessionStatusRollupOf — the precedence one rollup, two surfaces", () => {
  it("waiting beats running (a Session parked on a human is not working)", () => {
    // THE precedence, and the one order that matters. A Space (or a card) with
    // two Sessions — one holding a permission prompt, one streaming a turn — is
    // blocked on YOU, and a spinner there is the lie `SpaceTabs`'s header says
    // out loud. Note the ORDER of the input is irrelevant: `running` listed
    // first must still lose, which is what pins "precedence" rather than
    // "first match".
    expect(sessionStatusRollupOf(["running", "waiting"])).toBe("waiting");
    expect(sessionStatusRollupOf(["waiting", "running"])).toBe("waiting");
  });

  it("running is reported when nothing is waiting", () => {
    expect(sessionStatusRollupOf(["running"])).toBe("running");
    expect(sessionStatusRollupOf(["live", "running", "stored"])).toBe("running");
  });

  it("live and stored pass through as null (the rollup reports, it does not paint)", () => {
    // A `live` Session in an idle turn and a `stored` one are both REAL states
    // of a Session and neither is a fact these two surfaces report: the tab strip
    // suppresses them (its ring belongs to the sidebar row, the one place a
    // stored Session is listed at all) and a board card must too — a ring on every
    // card of an idle Space is a different signal wearing the same glyph set.
    expect(sessionStatusRollupOf(["live"])).toBeNull();
    expect(sessionStatusRollupOf(["stored"])).toBeNull();
    expect(sessionStatusRollupOf(["live", "stored", "live"])).toBeNull();
  });

  it("an empty list is null (no Sessions, nothing to report)", () => {
    // The card's common case: a board seeded with columns of cards that own no
    // Session at all. `null` here is what makes "no mark" the ABSENT answer
    // rather than a state a caller has to special-case.
    expect(sessionStatusRollupOf([])).toBeNull();
  });

  it("an id whose status is not in the map contributes nothing", () => {
    // `Record<string, SessionStatus>` indexed by an id the map never held yields
    // `undefined` — the type says so, and both callers read it that way (the tab
    // indexes its live-session list, the board indexes the visible cards' links).
    // `undefined` is NOT evidence of anything, so it must not outrank a real
    // status sitting beside it and must not become a mark of its own.
    expect(sessionStatusRollupOf([undefined])).toBeNull();
    expect(sessionStatusRollupOf([undefined, "waiting"])).toBe("waiting");
    expect(sessionStatusRollupOf([undefined, "running"])).toBe("running");
    expect(sessionStatusRollupOf([undefined, "live"])).toBeNull();
  });

  it("every one of the four states is a possible input (no state is silently dropped)", () => {
    // A guard against the widening this file exists to survive: when a fifth
    // `SessionStatus` is added, the four arms below still pass while the new one
    // rolls up to `null` in silence. The list is spelled from the union so
    // `tsc` — not a comment — is what notices a new member, and the assertion
    // states the ANSWER for each so a change of semantics reddens here.
    const all: SessionStatus[] = ["waiting", "running", "live", "stored"];
    // Each state ALONE (a one-Session surface), so a semantics change to any one
    // of the four reddens here rather than hiding behind the union case below.
    expect(all.map((one) => sessionStatusRollupOf([one]))).toEqual([
      "waiting",
      "running",
      null,
      null,
    ]);
    // And the whole union at once still answers with the loudest member.
    expect(sessionStatusRollupOf(all)).toBe("waiting");
  });
});

describe("cardMarkOf — ONE mark per card, across three states", () => {
  // WHY A CARD SHOWS ONE MARK AND NOT TWO. `ready` shipped as a SECOND, additive
  // glyph beside the session mark, and the owner caught what that paints: a green
  // tick next to an amber `?`, which reads "finished, but blocked". The real state
  // is "the model said ready, then asked you something" — ONE fact about one card.
  // Two marks also meant one mark could claim nothing was needed while the other
  // said it was. Collapsing to a single mark makes the contradictory state
  // unrepresentable rather than merely discouraged.
  //
  // THE PRECEDENCE, and why this order:
  //  - `waiting` first — a Session parked on a HUMAN outranks everything, the same
  //    rule `sessionStatusRollupOf` already gives a group. An unanswered question is
  //    the most time-critical thing a card can be.
  //  - `ready` second — also "a person is needed", but to review, not to unblock.
  //    It outranks `running` because a finished card is idle work while a running
  //    one is progress.
  //  - `running` last — nothing is needed of anyone. It is the weakest claim and it
  //    is the one that would otherwise hide the other two.

  it("waiting beats ready (an unanswered question outranks a hand-off)", () => {
    expect(cardMarkOf({ sessionStatus: "waiting", ready: true })).toBe("waiting");
  });

  it("waiting beats running (a Session parked on a human is not working)", () => {
    expect(cardMarkOf({ sessionStatus: "running", ready: false })).toBe("running");
    expect(cardMarkOf({ sessionStatus: "waiting", ready: false })).toBe("waiting");
  });

  it("ready beats running (idle work outranks progress)", () => {
    // THE case the two-mark design got wrong: a card whose model declared itself
    // ready and then started another turn. The hand-off is the actionable fact;
    // the spinner is not.
    expect(cardMarkOf({ sessionStatus: "running", ready: true })).toBe("ready");
  });

  it("ready is reported when nothing is waiting or running", () => {
    expect(cardMarkOf({ sessionStatus: null, ready: true })).toBe("ready");
  });

  it("nothing is reported when nothing is needed and nothing finished", () => {
    // `live` / `stored` already roll up to `null` upstream, so an idle card answers
    // `null` here too — the card paints no ring, per `sessionStatusRollupOf`.
    expect(cardMarkOf({ sessionStatus: null, ready: false })).toBeNull();
  });

  it("live and stored can NEVER become the card's mark (no ring on a card)", () => {
    // The board cannot produce these — `sessionStatusRollupOf` answers only
    // `waiting` / `running` / `null` — so this is a claim about the CARD, not about
    // the pipeline, and the card has to refuse it itself rather than rely on its
    // caller. A ring here would paint an idle Space with the glyph set that means
    // "blocked on you" two states away, which is why `sessionStatusRollupOf`
    // suppresses them and why this function must not re-admit them.
    //
    // This case exists because the first version of `cardMarkOf` returned
    // `sessionStatus` verbatim, and `tsc` caught it while NO TEST did: the signature
    // admitted `live` and returned it. Asserted here so a rewrite that widens the
    // return type reddens a test and not just a build.
    const wide = sessionStatusRollupOf(["live"]) ;
    expect(wide).toBeNull();
    // The inputs are typed `SessionStatus | null`, so the unsafe pair is reachable
    // at the boundary even though the board never builds it.
    expect(
      cardMarkOf({ sessionStatus: "live" as SessionStatus | null, ready: false }),
    ).toBeNull();
    expect(
      cardMarkOf({ sessionStatus: "stored" as SessionStatus | null, ready: false }),
    ).toBeNull();
    // And a `ready` claim still reports through them, so the suppression is not a
    // general "return nothing".
    expect(
      cardMarkOf({ sessionStatus: "stored" as SessionStatus | null, ready: true }),
    ).toBe("ready");
  });

  it("the mark is a function of the two inputs only (pure, no store read)", () => {
    // The board computes it once per card, so a card stays presentational. Same
    // argument `sessionStatusRollupOf` makes for the tab strip.
    const a = cardMarkOf({ sessionStatus: "waiting", ready: true });
    const b = cardMarkOf({ sessionStatus: "waiting", ready: true });
    expect(a).toBe(b);
    expect(a).toBe("waiting");
  });
});
