import { describe, expect, it } from "vitest";
import { READY_MARKER_TEXT, readyMarkerInstruction } from "./readyMarker";

/**
 * `readyMarker` — the ONE owner of the two strings that make the session `ready`
 * mark work: the word a model writes into its todo list, and the sentence that
 * tells the model to write it.
 *
 * They live in ONE module on purpose. The detector (`store/interactive.ts`'s
 * `isReadyMarker`) compares against `READY_MARKER_TEXT`, and the launch trailer
 * (`lib/taskPrompt`'s `buildLaunchMessage`) tells the model that exact word. Split
 * the two across files and they drift silently: the instruction tells a model to
 * write `ready` while the detector looks for `done`, every card stays unmarked, and
 * no test reddens because both sides are individually consistent. A test that pins
 * the sentence against the constant is the only thing that sees it.
 */
describe("readyMarker — the marker word", () => {
  it("is the exact lowercase word the detector matches", () => {
    expect(READY_MARKER_TEXT).toBe("ready");
    // The detector's rule is `content.trim().toLowerCase() === READY_MARKER_TEXT`,
    // so a constant carrying whitespace or capitals could NEVER match a real item
    // — it would be a marker nothing can set. Pinned rather than assumed.
    expect(READY_MARKER_TEXT).toBe(READY_MARKER_TEXT.trim().toLowerCase());
  });
});

describe("readyMarker — the sentence the model is told", () => {
  it("names the marker word, so the instruction and the detector cannot drift", () => {
    // THE TEST THAT MATTERS MOST IN THIS FILE. Change the constant without
    // touching the sentence (or the reverse) and this reddens; nothing else does.
    expect(readyMarkerInstruction).toContain(READY_MARKER_TEXT);
  });

  it("asks for the word ALONE, so an exact-match detector can match it", () => {
    // The detector is exact-match, not substring, so an instruction that says
    // "add an item about ready" produces an item that never marks anything.
    expect(readyMarkerInstruction).toMatch(
      new RegExp(`exactly the single word \`${READY_MARKER_TEXT}\``),
    );
  });

  it("asks for the item to be completed, the other half of the rule", () => {
    // A PENDING "ready" means "still need to make it ready" — the opposite claim.
    // An instruction that omitted this would have models leave the item pending
    // and the mark would never appear, with no side at fault.
    expect(readyMarkerInstruction.toLowerCase()).toContain("completed");
  });

  it("carries NO mention token, because it rides the expanding side of the boundary", () => {
    // `$word` is a Mention. The trailer is appended AFTER expansion so this is
    // belt-and-braces, but a `$` added later would be a silent skill injection
    // the moment anyone moved this string into the head.
    expect(readyMarkerInstruction).not.toContain("$");
  });

  it("is a single line, so it cannot break the block's blank-line structure", () => {
    expect(readyMarkerInstruction).not.toContain("\n");
  });
});
