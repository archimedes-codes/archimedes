import { describe, expect, it } from "vitest";

import {
  destinationOf,
  isAdvanceAdvice,
  readAdvanceAdvice,
  REASON_ALREADY_ADVANCED,
  sentenceFor,
} from "./advanceAdvice";
import type { AdvanceAdvice, AcpSessionUpdate, StageDto } from "../lib/tauri";

/**
 * `src/store/advanceAdvice.ts` — the ONE reader of Rust's advance advice.
 *
 * ## Why this file mocks NOTHING
 *
 * The module is a pure function over a payload: it takes a value out of a tool
 * result and answers three questions about it. It touches no store, no IPC and no
 * component, so there is no seam to fake — the same shape
 * `lib/workflowEdgeWrite.test.ts` and `lib/workflowGraph.test.ts` argue for in
 * `tauriBarrel.test.ts`'s mocker census. This file therefore does NOT call
 * `vi.mock("../lib/tauri")`, and it must not start: the module's only import of
 * that barrel is `import type`, which `verbatimModuleSyntax` compiles to nothing,
 * so a mock here would be theatre AND would move the pinned mocker counts for a
 * file that proves nothing about the wire.
 *
 * ## What the pins are for
 *
 *  - **the frame matters as much as the payload.** The instruction arrives on a
 *    `tool_call_update` (the settle frame of a tool call, `rawOutput` present),
 *    never on the `tool_call` that announced the call. A reader that accepted both
 *    would fire the launch on the ANNOUNCEMENT — before the tool ran, so before
 *    Rust decided anything — and every mocked test would stay green because a
 *    fixture says which frame it is.
 *  - **one row answers all four destination fields** (ADR 0098): `slug`, `label`,
 *    `onEnterSkill`, `promptPrefix` come out of the same `StageDto`, so a chain
 *    cannot move a card into a column whose Skill and prose name a different one.
 *  - **the bound numbers come from the advice** (`maxSteps`, `ceilingUsd`), never
 *    from a literal here — the fallbacks are Rust-only on purpose and a copied
 *    number is a number that drifts.
 *  - **`already_advanced` has no sentence.** It is the silent arm (D20): the claim
 *    path already spoke for this link, and a second `stopChain` would CLOSE the run
 *    and hand the next link a fresh `steps = 1`.
 */

/** The destination column, spelled through the real wire fields. */
function stage(over: Partial<StageDto> = {}): StageDto {
  return {
    spacePath: "/w/alpha",
    slug: "implement",
    label: "Implement",
    sortOrder: 2,
    onEnter: "none",
    onEnterSkill: "implement",
    nextSlugs: ["done"],
    auto: false,
    promptPrefix: "TDD first.",
    ...over,
  };
}

/** A well-formed advice — the advancing arm, since that is the one carrying a row. */
function advice(over: Partial<AdvanceAdvice> = {}): AdvanceAdvice {
  return {
    advance: true,
    stop: null,
    destination: stage(),
    reason: "advanced",
    maxSteps: 20,
    ceilingUsd: 10,
    taskId: "tsk_1",
    spacePath: "/w/alpha",
    alreadyLaunched: false,
    ...over,
  };
}

/** A well-formed advice with fields replaced by values of the WRONG type.
 *
 *  Goes through `unknown` on purpose: the point of the guard is that it runs on a
 *  value TypeScript never vouched for, so a fixture that had to compile a lie into
 *  `Partial<AdvanceAdvice>` would be testing the compiler instead of the guard. */
function malformed(patch: Record<string, unknown>): unknown {
  return { ...advice(), ...patch };
}

/** A `tool_call_update` carrying a value at `rawOutput.details.advanceAdvice` —
 *  the carrier Task 3 shipped: the pinned crate emits `tool_execution_end{result}`
 *  with `result = to_value(&ToolResult)`, `ToolResult` is `{content, details,
 *  isError}`, and normalisation lands that on a `tool_call_update` with `rawOutput`. */
function updateFrame(value: unknown): AcpSessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_1",
    status: "completed",
    rawOutput: { content: [{ type: "text", text: "advanced" }], details: value },
  };
}

describe("isAdvanceAdvice — the guard over a rawOutput.details payload", () => {
  it("accepts a well-formed advice", () => {
    expect(isAdvanceAdvice(advice())).toBe(true);
  });

  it("accepts the non-advancing arms (they are the same shape with a null row)", () => {
    expect(isAdvanceAdvice(advice({ advance: false, destination: null }))).toBe(true);
    expect(
      isAdvanceAdvice(
        advice({
          advance: false,
          stop: "max_steps",
          destination: null,
          reason: "max_steps",
          taskId: null,
          spacePath: null,
          maxSteps: null,
          ceilingUsd: null,
        }),
      ),
    ).toBe(true);
  });

  it("rejects a value that is not an object at all", () => {
    for (const junk of [undefined, null, "advanceAdvice", 7, [], true]) {
      expect(isAdvanceAdvice(junk)).toBe(false);
    }
  });

  it("rejects a payload missing any one of the nine keys", () => {
    // Nine keys, and `shape.rs` pins the set from Rust's side. Dropping the guard's
    // check on one of them means a payload that lost it downstream reads as a
    // well-formed advice and the caller branches on `undefined`.
    const keys = [
      "advance",
      "stop",
      "destination",
      "reason",
      "maxSteps",
      "ceilingUsd",
      "taskId",
      "spacePath",
      "alreadyLaunched",
    ];
    for (const key of keys) {
      const partial: Record<string, unknown> = { ...advice() };
      delete partial[key];
      expect(isAdvanceAdvice(partial)).toBe(false);
    }
  });

  it("rejects a key whose type is wrong", () => {
    // `malformed` and not `advice({ … }) as unknown`: the wrong-typed value has to
    // survive to RUNTIME for the guard to be the thing that refuses it, and a
    // `Partial<AdvanceAdvice>` patch would not compile the lie in the first place.
    expect(isAdvanceAdvice(malformed({ reason: 7 }))).toBe(false);
    expect(isAdvanceAdvice(malformed({ advance: "yes" }))).toBe(false);
    expect(isAdvanceAdvice(malformed({ alreadyLaunched: 1 }))).toBe(false);
    expect(isAdvanceAdvice(malformed({ maxSteps: "20" }))).toBe(false);
    expect(isAdvanceAdvice(malformed({ ceilingUsd: "10" }))).toBe(false);
    expect(isAdvanceAdvice(malformed({ taskId: 3 }))).toBe(false);
    // `stop` is a `ChainStop` or `null` — a bare string that is not one of the four
    // spellings is not a bound this side can name.
    expect(isAdvanceAdvice(malformed({ stop: "budget" }))).toBe(false);
    // …and each of the four real spellings IS accepted.
    for (const stop of ["no_next_stage", "max_steps", "cost_ceiling", "launch_refused"]) {
      expect(isAdvanceAdvice(malformed({ stop }))).toBe(true);
    }
  });

  it("rejects a destination row that is not a row", () => {
    expect(isAdvanceAdvice(malformed({ destination: "implement" }))).toBe(false);
    expect(isAdvanceAdvice(malformed({ destination: {} }))).toBe(false);
    // The four fields `destinationOf` reads, plus `auto`, which decides whether the
    // chain continues past the arriving column.
    for (const key of ["slug", "label", "auto", "onEnterSkill", "promptPrefix"]) {
      const row: Record<string, unknown> = { ...stage() };
      delete row[key];
      expect(isAdvanceAdvice(malformed({ destination: row }))).toBe(false);
    }
    // `null` and `""` are the two stored states of `promptPrefix` and both are legal;
    // a number is not.
    expect(isAdvanceAdvice(advice({ destination: stage({ promptPrefix: "" }) }))).toBe(true);
    expect(
      isAdvanceAdvice(malformed({ destination: { ...stage(), promptPrefix: 3 } })),
    ).toBe(false);
  });

  it("rejects a NaN bound rather than reading it as a number", () => {
    // `typeof NaN === "number"`, so a naive check accepts it and the sentence then
    // renders "$NaN" as a bound a person supposedly configured.
    expect(isAdvanceAdvice(malformed({ maxSteps: Number.NaN }))).toBe(false);
    expect(isAdvanceAdvice(malformed({ ceilingUsd: Number.NaN }))).toBe(false);
  });
});

describe("readAdvanceAdvice — the frame decides", () => {
  it("reads the advice off a tool_call_update's rawOutput.details", () => {
    const payload = advice();
    const read = readAdvanceAdvice(updateFrame({ advanceAdvice: payload }));
    expect(read).toEqual(payload);
  });

  it("returns null when the SAME payload sits on a tool_call (the wrong frame)", () => {
    // THE FRAME PIN. `tool_call` announces a call — the tool has not run yet, so no
    // decision exists. Accepting it would launch the next link before Rust answered,
    // and only a fixture that spells the frame name can tell the two apart.
    const announced: AcpSessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc_1",
      title: "mark_done",
      rawOutput: { details: { advanceAdvice: advice() } },
    };
    expect(readAdvanceAdvice(announced)).toBeNull();
  });

  it("returns null for every other update kind", () => {
    const chunk: AcpSessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "advanced to `implement`" },
    };
    expect(readAdvanceAdvice(chunk)).toBeNull();
  });

  it("returns null when the payload is absent or malformed on the right frame", () => {
    expect(readAdvanceAdvice(updateFrame(undefined))).toBeNull();
    expect(readAdvanceAdvice(updateFrame(null))).toBeNull();
    expect(readAdvanceAdvice(updateFrame({}))).toBeNull();
    expect(readAdvanceAdvice(updateFrame({ advanceAdvice: { reason: "advanced" } }))).toBeNull();
    // A `details` that is not an object (a foreign tool may answer anything).
    expect(
      readAdvanceAdvice({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_1",
        rawOutput: { details: "advanceAdvice" },
      }),
    ).toBeNull();
    // A `rawOutput` that is the plain-text form the transcript also carries.
    expect(
      readAdvanceAdvice({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_1",
        rawOutput: "advanced to `implement`",
      }),
    ).toBeNull();
    expect(
      readAdvanceAdvice({ sessionUpdate: "tool_call_update", toolCallId: "tc_1" }),
    ).toBeNull();
  });
});

describe("destinationOf — one row answers all four fields (ADR 0098)", () => {
  it("builds slug, label, onEnterSkill and promptPrefix from the single row", () => {
    expect(destinationOf(advice())).toEqual({
      slug: "implement",
      label: "Implement",
      onEnterSkill: "implement",
      promptPrefix: "TDD first.",
    });
  });

  it("keeps a null Skill and a null prefix null rather than inventing either", () => {
    const bare = advice({
      destination: stage({ onEnterSkill: null, promptPrefix: null }),
    });
    expect(destinationOf(bare)).toEqual({
      slug: "implement",
      label: "Implement",
      onEnterSkill: null,
      promptPrefix: null,
    });
  });

  it("carries the `advanced_unnamed_edge` arm too — an invented outcome still advances", () => {
    expect(destinationOf(advice({ reason: "advanced_unnamed_edge" }))).not.toBeNull();
  });

  it("returns null for EVERY non-advancing reason, even one that smuggles a row", () => {
    // `advance` is the only field a caller obeys, so `advance: false` must answer
    // `null` here whatever else the payload holds — a row on a refusal is a payload
    // this side cannot explain, and launching on it would move a card Rust refused to
    // move.
    //
    // DEFENSIVE, and the wording matters: Rust does NOT emit a row on the
    // `already_advanced` arm. `advise.rs`'s arm 3 answers `destination: None`, and the
    // row its dedupe matched is a local read that is never serialised. So this is a pin
    // on a MALFORMED payload (one this guard cannot produce but a future arm, a partial
    // write, or a newer Rust could), not a claim about a wire shape that exists today.
    // The property it pins is the one that must survive any such change: `advance` is
    // the authority and a row is never a proxy for it.
    const reasons = [
      "unlinked",
      "unclaimed",
      REASON_ALREADY_ADVANCED,
      "not_automatic",
      "no_next_stage",
      "max_steps",
      "cost_ceiling",
      "some_future_spelling",
    ];
    for (const reason of reasons) {
      expect(destinationOf(advice({ advance: false, destination: null, reason }))).toBeNull();
      expect(destinationOf(advice({ advance: false, reason }))).toBeNull();
    }
  });

  it("returns null when advance is true but no row arrived (a payload it cannot honour)", () => {
    expect(destinationOf(advice({ destination: null }))).toBeNull();
  });
});

describe("sentenceFor — the transcript line, built from the advice's numbers", () => {
  it("names the advice's step bound rather than a literal 20", () => {
    const sentence = sentenceFor(
      advice({ advance: false, stop: "max_steps", destination: null, reason: "max_steps", maxSteps: 7 }),
    );
    expect(sentence).toContain("7");
    expect(sentence).not.toContain("20");
    expect(sentence).toContain("max_steps");
  });

  it("names the advice's ceiling rather than a literal $10", () => {
    const sentence = sentenceFor(
      advice({ advance: false, stop: "cost_ceiling", destination: null, reason: "cost_ceiling", ceilingUsd: 3.25 }),
    );
    expect(sentence).toContain("$3.25");
    expect(sentence).not.toContain("$10");
    expect(sentence).toContain("cost_ceiling");
  });

  it("renders no number at all for a ceiling that is not a figure", () => {
    // `ceilingUsd: null` means "no figure to quote" — `$0` would describe a bound of
    // nothing and `null` would render the word.
    const sentence = sentenceFor(
      advice({ advance: false, stop: "cost_ceiling", destination: null, reason: "cost_ceiling", ceilingUsd: null }),
    );
    expect(sentence).toContain("cost_ceiling");
    expect(sentence).not.toMatch(/\$0\b/);
    expect(sentence).not.toContain("null");
  });

  it("says nothing for `already_advanced` (D20's silent arm)", () => {
    // The claim path owns this link and already spoke. A sentence here is a second
    // voice for one event, and the `stopChain` that would carry it CLOSES the run —
    // turning a 20-step bound into 20 steps per link.
    expect(
      sentenceFor(
        advice({
          advance: false,
          destination: null,
          reason: REASON_ALREADY_ADVANCED,
          alreadyLaunched: true,
        }),
      ),
    ).toBeNull();
  });

  it("says nothing on an advancing advice — the launch is the sentence", () => {
    expect(sentenceFor(advice())).toBeNull();
    expect(sentenceFor(advice({ reason: "advanced_unnamed_edge" }))).toBeNull();
  });

  it("says why for every refusal that must reach a person", () => {
    // `unclaimed` (D4), `not_automatic`, `unlinked` and `no_next_stage` are the arms
    // with no other surface: the transcript is the house answer for a thing the user
    // must see that has nowhere else to be said.
    const cases: Array<[string, RegExp]> = [
      ["unclaimed", /mark_done/],
      ["not_automatic", /not automatic/],
      ["unlinked", /not linked/],
      ["no_next_stage", /no_next_stage/],
    ];
    for (const [reason, expected] of cases) {
      const sentence = sentenceFor(
        advice({ advance: false, destination: null, reason }),
      );
      expect(sentence).not.toBeNull();
      expect(sentence ?? "").toMatch(expected);
      // And the reason's own spelling is IN the sentence, so the transcript and the
      // `stop_reason` column cannot name different events.
      expect(sentence ?? "").toContain(reason);
    }
  });

  it("says nothing for a reason this side does not know (the caller records `unknown`)", () => {
    expect(
      sentenceFor(advice({ advance: false, destination: null, reason: "budget_exhausted" })),
    ).toBeNull();
  });
});
