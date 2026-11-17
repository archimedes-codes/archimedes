import { describe, expect, it, vi } from "vitest";
import { taskBadgeOf } from "./taskNumber";
import type { TaskBadge } from "./tauri";

/**
 * The ONE reader of the `taskNumbers` map (spec D3/D12). Three cases, and each
 * one is the reason the function exists at all:
 *  - a present key returns the PAIR (number AND frozen lane) — a reader that
 *    returned only the number would drop the lane the badge renders;
 *  - a missing key returns `null`, never a `0`/`undefined`-ish stand-in: the
 *    absent key IS the negative answer (ADR 0082's rule for cost, same shape);
 *  - a `null` sessionId returns `null` WITHOUT touching the map — that is why the
 *    signature is nullable, and `SidePane` reaches it on every render with no
 *    active Session.
 */
describe("taskBadgeOf (the Task badge's ONE reader)", () => {
  const map: Record<string, TaskBadge> = {
    s1: { number: 7, stageSlug: "implement" },
    // A real number with a NULL lane (the column is nullable) — a different
    // answer from "no badge", and the badge still renders `T3`.
    s3: { number: 3, stageSlug: null },
  };

  it("taskBadgeOf returns the number AND the frozen lane for a present key", () => {
    expect(taskBadgeOf(map, "s1")).toEqual({ number: 7, stageSlug: "implement" });
    // The nullable-lane row is still a badge: `null` here is the Stage column's
    // null, not the absence of a Task.
    expect(taskBadgeOf(map, "s3")).toEqual({ number: 3, stageSlug: null });
  });

  it("taskBadgeOf is null for a Session with no entry (absent, not zero)", () => {
    // The negative answer has to be `null` and not a `TaskBadge` with a
    // fabricated number: a badge reading `T0` would be an invented label.
    expect(taskBadgeOf(map, "ghost")).toBeNull();
    expect(taskBadgeOf({}, "s1")).toBeNull();
  });

  it("taskBadgeOf is null for a null sessionId WITHOUT reading the map", () => {
    // The signature is `string | null` because three of the four call sites hold
    // `activeSessionId`. A proxy witness proves the map is never indexed — a
    // `map[null]` read would answer `undefined` for a Session literally keyed
    // `"null"` rather than short-circuiting.
    const read = vi.fn();
    const watched: Record<string, TaskBadge> = new Proxy(map, {
      get(target, prop) {
        read(prop);
        return target[prop as string];
      },
    });
    expect(taskBadgeOf(watched, null)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
