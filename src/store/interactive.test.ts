import { beforeEach, describe, expect, it } from "vitest";
import { useInteractive } from "./interactive";

const S1 = "s1";
const S2 = "s2";

beforeEach(() => {
  const s = useInteractive.getState();
  // Reset everything a previous test may have left behind.
  for (const id of new Set([
    ...Object.keys(s.requests),
    ...Object.keys(s.todos),
    ...Object.keys(s.agentState),
    ...Object.keys(s.cost),
    ...Object.keys(s.session),
  ])) {
    s.dismissSession(id);
  }
});

describe("addRequest / removeRequest", () => {
  it("adds a request keyed by session id", () => {
    useInteractive.getState().addRequest(S1, {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: { questions: [] },
    });
    const list = useInteractive.getState().requests[S1];
    expect(list).toHaveLength(1);
    expect(list?.[0]).toMatchObject({
      requestId: "r1",
      method: "ask",
      source: "main",
    });
  });

  it("dedups by requestId (a re-delivered frame replaces, not duplicates)", () => {
    const add = useInteractive.getState().addRequest;
    add(S1, {
      requestId: "r1",
      method: "confirm",
      source: "main",
      params: { command: "a", reason: "b" },
    });
    add(S1, {
      requestId: "r1",
      method: "confirm",
      source: "main",
      params: { command: "a2", reason: "b2" },
    });
    const list = useInteractive.getState().requests[S1];
    expect(list).toHaveLength(1);
    expect(list?.[0].params).toEqual({ command: "a2", reason: "b2" });
  });

  it("keeps requests for different sessions separate", () => {
    const add = useInteractive.getState().addRequest;
    add(S1, { requestId: "r1", method: "ask", source: "main", params: {} });
    add(S2, { requestId: "r1", method: "confirm", source: "main", params: {} });
    expect(useInteractive.getState().requests[S1]).toHaveLength(1);
    expect(useInteractive.getState().requests[S2]).toHaveLength(1);
  });

  it("removes a request by requestId", () => {
    useInteractive
      .getState()
      .addRequest(S1, {
        requestId: "r1",
        method: "ask",
        source: "main",
        params: {},
      });
    useInteractive.getState().removeRequest(S1, "r1");
    expect(useInteractive.getState().requests[S1]).toHaveLength(0);
  });
});

/**
 * Boards are keyed by SESSION id and by nothing else (ADR 0041): one Session
 * runs one Agent harness, so it produces exactly one board, and the payload's
 * `source` label is inert. Every frame the desktop emits carries
 * `"native"` for a MAIN session and a Subagent session alike, so the cases
 * below deliberately drive the SAME session id through every label variant —
 * the regression pin for the `native`-heading bug.
 */
describe("todos", () => {
  it("applyTodoUpdate writes the session's own board", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "in_progress" }],
    });
    expect(useInteractive.getState().todos[S1]).toEqual([
      { content: "a", status: "in_progress" },
    ]);
  });

  it("the `source` label routes NOTHING: every variant lands in the same session's slice", () => {
    const board = [{ content: "board", status: "pending" }];
    for (const payload of [
      { source: "native", todos: board },
      { source: "main", todos: board },
      { source: "subagent:x", todos: board },
      // No `source` key at all — the store must not read it, so a payload
      // missing it is still a board for this session.
      { todos: board },
    ]) {
      useInteractive.getState().applyTodoUpdate(S1, payload);
      expect(useInteractive.getState().todos[S1]).toEqual(board);
    }
    // Keyed by id, so another session's slice is untouched (and the label
    // never became a key of its own).
    expect(useInteractive.getState().todos[S2]).toBeUndefined();
  });

  it("applyTodoUpdate replaces the board on re-delivery (latest wins)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "b", status: "completed" }],
    });
    expect(useInteractive.getState().todos[S1]).toEqual([
      { content: "b", status: "completed" },
    ]);
  });

  /**
   * The shape guard (`!Array.isArray(p.todos)`) is the only thing standing
   * between a malformed frame and every board consumer in the Client —
   * `useMainChecklistItems` hands its result straight to `ChecklistPanel`'s
   * `.filter`/`.map`, so a write of `"nope"` or `{}` would throw inside the
   * Side pane, not merely render oddly. It is also the ONLY guard left: ADR
   * 0041 deleted the `source` branch, so a payload with a bad label and a
   * good array still lands (pinned above), while a payload with a good label
   * and a bad `todos` must not land at all.
   */
  it("applyTodoUpdate ignores a payload whose `todos` is not an array (the state object is returned IDENTICAL)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "the board", status: "pending" }],
    });
    for (const todos of ["nope", {}, null, undefined, 0, true]) {
      const before = useInteractive.getState();
      useInteractive.getState().applyTodoUpdate(S1, { source: "native", todos });
      // `toBe` on the STATE OBJECT, not `toEqual` on the slice: the guard
      // returns `state` untouched, so no store notification and no re-render
      // (an `toEqual` on `todos[S1]` would also pass for a write of the same
      // contents, which is a different event).
      expect(useInteractive.getState()).toBe(before);
      expect(useInteractive.getState().todos[S1]).toEqual([
        { content: "the board", status: "pending" },
      ]);
    }
    // A payload that is not an object at all is the same no-op (the guard's
    // `!p ||` half, which the `todos` loop above cannot reach).
    const before = useInteractive.getState();
    useInteractive.getState().applyTodoUpdate(S1, null);
    useInteractive.getState().applyTodoUpdate(S1, undefined);
    useInteractive.getState().applyTodoUpdate(S1, "nope");
    expect(useInteractive.getState()).toBe(before);
  });

  it("applyTodoClear drops the session's WHOLE board (no `source` argument)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    useInteractive.getState().applyTodoClear(S1);
    expect(useInteractive.getState().todos[S1]).toBeUndefined();
  });

  /**
   * The key DELETED, not an empty array written. `toBeUndefined()` above
   * cannot tell the two apart (`({} as …)["s1"]` is `undefined` too), and the
   * difference is the documented consequence: `applyTodoClear` leaves the
   * session's board empty until the next `todos_update`.
   */
  it("applyTodoClear DELETES the key rather than writing `[]`", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    useInteractive.getState().applyTodoClear(S1);
    expect("s1" in useInteractive.getState().todos).toBe(false);
    // The sibling sessions survive the spread-copy-and-delete (the write is
    // not a wholesale reset of the map).
    useInteractive.getState().applyTodoUpdate(S2, {
      source: "native",
      todos: [{ content: "b", status: "pending" }],
    });
    useInteractive.getState().applyTodoClear(S1);
    expect("s1" in useInteractive.getState().todos).toBe(false);
    expect("s2" in useInteractive.getState().todos).toBe(true);
  });

  it("applyTodoClear for a session with no board is a no-op (identical state object)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    const before = useInteractive.getState();
    useInteractive.getState().applyTodoClear("nope");
    expect(useInteractive.getState()).toBe(before);
  });
});

describe("wired-but-not-rendered state", () => {
  it("applyState stores the agent state", () => {
    useInteractive.getState().applyState(S1, { state: "blocked" });
    expect(useInteractive.getState().agentState[S1]).toBe("blocked");
  });

  it("applySession stores the session payload", () => {
    useInteractive.getState().applySession(S1, { bridgeSession: "abc" });
    expect(useInteractive.getState().session[S1]).toEqual({ bridgeSession: "abc" });
  });
});

/**
 * `applyCost` — the session's money (issue #87).
 *
 * This describe used to be a case inside `wired-but-not-rendered state`,
 * asserting `applyCost(S1, { inputTokens: 10 })` stored the payload back
 * VERBATIM (`toEqual({ inputTokens: 10 })`). That assertion was the defect: a
 * frame is not stored, it is NORMALISED and ADDED, and after #87 the figure is
 * rendered. The case now lives here and asserts the normalised shape.
 */
describe("applyCost (the session's cumulative USD figure, #87)", () => {
  it("normalises the first frame instead of storing it raw", () => {
    useInteractive.getState().applyCost(S1, { inputTokens: 10 });
    // Every field the entry type carries is present after ONE frame — the
    // entry's shape must not depend on how many frames have arrived (rule R3).
    expect(useInteractive.getState().cost[S1]).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: null,
      costUsd: null,
    });
  });

  it("two cost frames LAST-FRAME-WINS — a frame carries the RUNNING TOTAL", () => {
    // Fulcrum T2 flipped the frame's VALUE from per-call delta to session total,
    // and this is the pin `combineSessionCost`'s doc named as the one that would
    // redden when an emitter changed its mind. `0.02` then `0.05` is a session
    // that reached 2 cents and then 5 cents: the entry reads `0.05`.
    //
    // `0.07` is the value the retired SUM produced, and it is the number this
    // assertion exists to forbid — a store that adds two totals reports the same
    // money twice, which is exactly the double count ADR 0082's limit 7 was the
    // other half of.
    useInteractive.getState().applyCost(S1, { costUsd: 0.02 });
    useInteractive.getState().applyCost(S1, { costUsd: 0.05 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number;
      cost: number;
    };
    expect(entry.costUsd).toBeCloseTo(0.05, 10);
    expect(entry.costUsd).not.toBeCloseTo(0.07, 10);
    // Rule R1: the card's `cost` alias tracks the same last-wins figure.
    expect(entry.cost).toBeCloseTo(0.05, 10);
  });

  it("a replayed frame leaves the entry exactly where it was (the store is a snapshot)", () => {
    // The frontend half of the idempotency the DB write gained: a re-delivered
    // total frame is not a second spend.
    useInteractive.getState().applyCost(S1, { costUsd: 0.0000341 });
    useInteractive.getState().applyCost(S1, { costUsd: 0.0000341 });
    const entry = useInteractive.getState().cost[S1] as { costUsd: number };
    expect(entry.costUsd).toBeCloseTo(0.0000341, 12);
  });

  it("a frame with costUsd: null never becomes a real 0 — the session total stays null", () => {
    // D5: `null` means "no call this session reported a cost" and renders
    // NOTHING. The old arithmetic was `(prev.cost ?? 0) + (p?.cost ?? 0)`,
    // which manufactured a numeric `0` out of two unknowns — the phantom
    // `$0.00` #87 was filed to end.
    useInteractive.getState().applyCost(S1, { costUsd: null });
    useInteractive.getState().applyCost(S1, { costUsd: null });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeNull();
    // The alias cannot drift from the primary: both say "unknown".
    expect(entry.cost).toBeNull();
  });

  it("a frame that carries no money key at all is unknown, not zero", () => {
    // T09's emitter never emits a no-figure frame at all — it returns early
    // before building one — so in practice this key is always present on a frame
    // that reaches the store. Absence is still a state the reducer must handle
    // (a malformed or foreign frame), and it must land in the SAME unknown state
    // as `null`, never a manufactured `0`.
    useInteractive.getState().applyCost(S1, { inputTokens: 100, outputTokens: 20 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeNull();
    expect(entry.cost).toBeNull();
  });

  it("an unknown frame followed by a priced frame yields the figure, not figure+0", () => {
    useInteractive.getState().applyCost(S1, { costUsd: null });
    useInteractive.getState().applyCost(S1, { costUsd: 0.03 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeCloseTo(0.03, 10);
    expect(entry.cost).toBeCloseTo(0.03, 10);
  });

  it("a priced frame followed by an unknown frame keeps the figure (unknown is not a number to add)", () => {
    useInteractive.getState().applyCost(S1, { costUsd: 0.03 });
    useInteractive.getState().applyCost(S1, { costUsd: null });
    const entry = useInteractive.getState().cost[S1] as { costUsd: number | null };
    expect(entry.costUsd).toBeCloseTo(0.03, 10);
  });

  it("the legacy cost key still lands AND gains the costUsd alias (SubagentDelegatingCard reads cost)", () => {
    // A REAL zero-cost `0` is a figure (D5: `$0.00`), so the state below is a
    // figure and not an unknown.
    //
    // Applied to an EMPTY store on purpose: this is the FIRST frame, and the
    // branch this pins away was `interactive.ts`'s
    // `if (!prev) return { cost: { ...state.cost, [sessionId]: payload } }`,
    // which stored the payload RAW and left it with NO `costUsd` key — so the
    // renderer read nothing while money existed. Do not "fix" this case by
    // seeding a second frame: that would route it around the branch again.
    useInteractive.getState().applyCost(S1, { cost: 0.035 });
    const entry = useInteractive.getState().cost[S1] as {
      cost: number | null;
      costUsd: number | null;
    };
    expect(entry.cost).toBeCloseTo(0.035, 10);
    expect(entry.costUsd).toBeCloseTo(0.035, 10);
  });

  it("the FIRST costUsd frame is normalised too: the entry gains the cost alias on frame one", () => {
    // The mirror of the case above (rule R3, other direction): a D5-shaped
    // first frame stored raw carries NO `cost` key, and
    // `SubagentDelegatingCard`'s `interactiveCost?.cost` link reads `undefined`
    // for that session until a second frame arrives.
    useInteractive.getState().applyCost(S1, { costUsd: 0.0042 });
    const entry = useInteractive.getState().cost[S1] as {
      cost: number | null;
      costUsd: number | null;
    };
    expect(entry.costUsd).toBeCloseTo(0.0042, 10);
    expect(entry.cost).toBeCloseTo(0.0042, 10);
  });

  it("a legacy frame and a costUsd frame are ONE accumulator, never two figures", () => {
    // Rule R4, restated for the totals contract (Fulcrum T2). `costUsd` and
    // `cost` are ONE accumulator, not two sums: the frame's money is chosen ONCE
    // (`costUsd` first, legacy `cost` second) and only then combined. Under the
    // delta wire that pair had to SUM to `0.01`; a frame now carries the session
    // TOTAL, so the second frame's word is `0.005` and the entry reads that.
    //
    // The intent is unchanged and still the point: `0.02` — what adding BOTH keys
    // of one frame would produce — remains forbidden, and so is the retired
    // `0.01`, which is the same money counted twice under a different name.
    useInteractive.getState().applyCost(S1, { cost: 0.005 });
    useInteractive.getState().applyCost(S1, { costUsd: 0.005 });
    const entry = useInteractive.getState().cost[S1] as {
      cost: number | null;
      costUsd: number | null;
    };
    expect(entry.costUsd).toBeCloseTo(0.005, 10);
    expect(entry.costUsd).not.toBeCloseTo(0.01, 10);
    expect(entry.costUsd).not.toBeCloseTo(0.02, 10);
    // And the alias tracks the primary, so the card cannot show a different
    // figure from the session line.
    expect(entry.cost).toBeCloseTo(0.005, 10);
  });

  it("costUsd wins when one frame carries both keys", () => {
    // Rule R2: `costUsd` is D5's authoritative key; `cost` is the fallback for
    // a pre-D5 emitter. A frame carrying both must count the D5 one ONCE.
    useInteractive.getState().applyCost(S1, { cost: 0.005, costUsd: 0.007 });
    const entry = useInteractive.getState().cost[S1] as { costUsd: number | null };
    expect(entry.costUsd).toBeCloseTo(0.007, 10);
  });

  it("a malformed figure (string / NaN / negative) is unknown, never invented money", () => {
    useInteractive.getState().applyCost(S1, { costUsd: "0.05" });
    useInteractive.getState().applyCost(S1, { costUsd: Number.NaN });
    useInteractive.getState().applyCost(S1, { costUsd: -1 });
    useInteractive.getState().applyCost(S1, { costUsd: Number.POSITIVE_INFINITY });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeNull();
    expect(entry.cost).toBeNull();
  });

  it("a real zero figure is kept as 0, not collapsed into unknown", () => {
    // D5: `0` is a real zero and renders `$0.00` — the opposite state from
    // `null`. The store must not lose the difference.
    useInteractive.getState().applyCost(S1, { costUsd: 0 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBe(0);
    expect(entry.cost).toBe(0);
  });

  it("keeps the token fields the SubagentDelegatingCard reads off the same entry", () => {
    // The card's context-% chain (`interactiveCost.inputTokens/outputTokens`)
    // and its `#85` test seed tokens with NO cost key at all.
    useInteractive.getState().applyCost(S1, { inputTokens: 25000 });
    useInteractive.getState().applyCost(S1, { outputTokens: 5000 });
    const entry = useInteractive.getState().cost[S1] as {
      inputTokens: number;
      outputTokens: number;
    };
    expect(entry.inputTokens).toBe(25000);
    expect(entry.outputTokens).toBe(5000);
  });
});

/**
 * TRAP 3 — the accumulator restarts at zero, the stored row does not.
 *
 * `dismissSession` deletes `cost[sessionId]` on close, so after a resume the map
 * is empty and the session shows no figure until its next frame arrives. The fix
 * is to seed the entry from the row at resume.
 *
 * Fulcrum T2 moved WHERE the arithmetic happens but not what this seam is for.
 * The store used to be the accumulator (`combineSessionCost` was pure addition),
 * so a seed that was routed through `applyCost` added the stored total to itself.
 * The emitter is the accumulator now (`AgentLoop::cost_acc`, seeded from the same
 * row through `StartEnv.cost_usd`), `combineSessionCost` is last-frame-wins, and
 * a total-bearing frame cannot double a seeded total — but a hydrator must STILL
 * write the key directly, because `applyCost` also writes the four token fields,
 * and tokens are never persisted (see the "writes MONEY ONLY" pin, which is the
 * assertion that still catches a mis-routed seed).
 */
describe("seedCostFromRow (a resumed session continues its stored total, #105)", () => {
  it("seeds the accumulator with the stored TOTAL, and a frame's total replaces it", () => {
    // TRAP 3 (#105), restated for the totals contract (Fulcrum T2).
    //
    // What the seed is FOR changed, and saying so is the honest part of this
    // rewrite. Under the delta wire it was load-bearing for ARITHMETIC: the
    // first frame after a resume had to ADD to the stored figure, and `1.1` was
    // the number that proved a seed had been routed through the summing
    // `applyCost`. Under the totals contract the arithmetic moved to the emitter
    // (`StartEnv.cost_usd` → `AgentLoop::seed_cost`, pinned Rust-side by
    // `a_seeded_loop_continues_the_stored_total_instead_of_restarting_at_zero`),
    // so the first frame of a resumed session ALREADY carries 0.5 + 0.1 = 0.6.
    // The seed's job here is now the gap BEFORE that frame: a resumed session
    // that has not made a call yet must show its stored figure, not nothing.
    //
    // Recorded rather than hidden: the `not.toBeCloseTo(1.1)` check this test
    // used to carry has NO discriminating power left — under last-frame-wins a
    // seed routed through `applyCost` also lands on the frame's value. The
    // assertion that still catches that exact bug is the shape one below
    // (`applyCost` writes the four token keys, a direct write does not), pinned
    // by "writes MONEY ONLY — no token keys on the seeded entry".
    useInteractive.getState().seedCostFromRow(S1, 0.5);
    const seeded = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(seeded.costUsd).toBeCloseTo(0.5, 10);
    expect(seeded.cost).toBeCloseTo(0.5, 10);

    // The next frame carries the session's TOTAL (the Rust loop added its own
    // call to the same row this seed came from), so the entry reads it whole.
    useInteractive.getState().applyCost(S1, { costUsd: 0.6 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeCloseTo(0.6, 10);
    // `1.1` (0.5 + 0.6) is what a summing reducer would produce from a
    // total-bearing frame on top of a seeded total. Asserted as an absence
    // alongside the positive value above: it no longer discriminates the seed
    // route, but it DOES catch a reducer that drifts back to addition.
    expect(entry.costUsd).not.toBeCloseTo(1.1, 10);
    // Rule R1: one total under BOTH names, so the card's `cost` alias link sees
    // the seeded figure too.
    expect(entry.cost).toBeCloseTo(0.6, 10);
  });

  it("seeding twice does NOT accumulate (it is a seed, not a delta)", () => {
    useInteractive.getState().seedCostFromRow(S1, 0.5);
    useInteractive.getState().seedCostFromRow(S1, 0.5);
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
    };
    expect(entry.costUsd).toBe(0.5);
  });

  it("seeds nothing for a session whose row never reported a figure (no entry, so `null` is not `0`)", () => {
    // A `NULL` column means "no call ever reported a cost". Creating an entry
    // for it would write `costUsd: null` into the map, which `costUsdOf` reads
    // as a REPORT ("live and reporting nothing") and would then suppress the
    // row figure — the exact precedence the selector documents.
    useInteractive.getState().seedCostFromRow(S1, null);
    expect(S1 in useInteractive.getState().cost).toBe(false);
    useInteractive.getState().seedCostFromRow(S1, undefined);
    expect(S1 in useInteractive.getState().cost).toBe(false);
  });

  it("does NOT clobber an entry the live frames already wrote", () => {
    // A resume racing an in-flight frame: the map is fresher than the row this
    // seed came from, so the seed stands down.
    useInteractive.getState().applyCost(S1, { costUsd: 0.9 });
    useInteractive.getState().seedCostFromRow(S1, 0.5);
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
    };
    expect(entry.costUsd).toBe(0.9);
  });

  it("seeds a stored REAL zero as 0 (D5: a free session renders $0.00, not nothing)", () => {
    useInteractive.getState().seedCostFromRow(S1, 0);
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBe(0);
    expect(entry.cost).toBe(0);
  });

  it("writes MONEY ONLY — no token keys on the seeded entry (plan fact 3)", () => {
    // `applyCost` always writes the four token fields; a seeded entry must NOT
    // carry them. `SubagentDelegatingCard`'s context-% chain tests
    // `inputTokens !== undefined || outputTokens !== undefined || tokens !==
    // undefined` before using the store entry, and tokens are never persisted —
    // so a seeded `0` would win that chain and drive the child's bar to 0% (and,
    // once real tokens existed, past 100%: `calculatedPct` has no clamp).
    useInteractive.getState().seedCostFromRow(S1, 0.5);
    const entry = useInteractive.getState().cost[S1] as Record<string, unknown>;
    expect("inputTokens" in entry).toBe(false);
    expect("outputTokens" in entry).toBe(false);
    expect("cacheReadTokens" in entry).toBe(false);
    expect("cacheWriteTokens" in entry).toBe(false);
    expect("tokens" in entry).toBe(false);
    expect(Object.keys(entry).sort()).toEqual(["cost", "costUsd"]);
  });

  it("leaves other sessions' entries alone", () => {
    useInteractive.getState().applyCost(S2, { costUsd: 0.2 });
    useInteractive.getState().seedCostFromRow(S1, 0.5);
    const other = useInteractive.getState().cost[S2] as {
      costUsd: number | null;
    };
    expect(other.costUsd).toBe(0.2);
  });
});

describe("dismissSession", () => {
  it("clears requests, todos, agentState, cost, and session for the session", () => {
    const s = useInteractive.getState();
    s.addRequest(S1, {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {},
    });
    s.applyTodoUpdate(S1, {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    s.applyState(S1, { state: "working" });
    s.applyCost(S1, { inputTokens: 1 });
    s.applySession(S1, { bridgeSession: "abc" });
    s.dismissSession(S1);
    const after = useInteractive.getState();
    expect(after.requests[S1]).toBeUndefined();
    expect(after.todos[S1]).toBeUndefined();
    expect(after.agentState[S1]).toBeUndefined();
    expect(after.cost[S1]).toBeUndefined();
    expect(after.session[S1]).toBeUndefined();
  });

  it("leaves other sessions alone", () => {
    const s = useInteractive.getState();
    s.addRequest(S1, {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {},
    });
    s.addRequest(S2, {
      requestId: "r2",
      method: "ask",
      source: "main",
      params: {},
    });
    s.dismissSession(S1);
    expect(useInteractive.getState().requests[S2]).toHaveLength(1);
  });
});
