import { describe, expect, it } from "vitest";
import { sessionStatusRollupOf } from "./sessionStatusRollup";
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
