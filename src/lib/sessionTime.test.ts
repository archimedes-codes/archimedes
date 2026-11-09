import { describe, expect, it } from "vitest";
import { relativeTimeFor, relativeTimeFromInstant } from "./sessionTime";
import { makeMessage } from "../test/fixtures";

const user = (text: string, at: number) => makeMessage("user", { text, at });
const agent = (text: string, at: number) =>
  makeMessage("agent-text", { text, at });

const NOW = 1_700_000_000_000;

describe("relativeTimeFor (ONE rule for a Session's relative last-activity label)", () => {
  it("is `now` under a minute", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 1000)], {}, NOW)).toBe("now");
    expect(relativeTimeFor("s1", [user("a", NOW - 59_999)], {}, NOW)).toBe("now");
  });

  it("is `Nm` under an hour", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 5 * 60_000)], {}, NOW)).toBe("5m");
    expect(relativeTimeFor("s1", [user("a", NOW - 59 * 60_000)], {}, NOW)).toBe("59m");
  });

  it("is `Nh` at or above an hour", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 60 * 60_000)], {}, NOW)).toBe("1h");
    expect(relativeTimeFor("s1", [user("a", NOW - 5 * 3_600_000)], {}, NOW)).toBe("5h");
  });

  it("boundary: exactly 60_000 ms leaves `now` for `1m`", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 60_000)], {}, NOW)).toBe("1m");
  });

  it("boundary: exactly 3_600_000 ms leaves `Nm` for `1h`", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 3_600_000)], {}, NOW)).toBe("1h");
  });

  it("prints the boot recency stamp when no transcript is loaded (the unified fallback)", () => {
    // THE ARM THE TWO MODULES USED TO DISAGREE ON. `recencyOf` (which
    // `sortByRecency` and the Landing pick order by) answered the boot
    // `sessionRecency` stamp here, while the DISPLAYED label rendered an empty
    // slot — the Archived list was ordered by a number its own rows refused to
    // print. `relativeTimeFor` now takes the same
    // `(sessionId, loadedMessages, recencyMap)` triple and delegates, so the
    // string is that one number bucketized: the map's stamp prints.
    // `SessionInfo` has NO `createdAt`, so the boot map is the only evidence a
    // stored row never opened this boot has — and it is evidence.
    expect(relativeTimeFor("s1", undefined, { s1: NOW - 5 * 60_000 }, NOW)).toBe("5m");
    expect(relativeTimeFor("s1", [], { s1: NOW - 5 * 60_000 }, NOW)).toBe("5m");
  });

  it("is null only when neither the transcript nor the map can prove recency", () => {
    // The surviving half of the unified rule, mirroring `recencyOf`'s own test
    // of the same name: the empty slot is NOT gone, it just moved — it now
    // means "no evidence on EITHER side", not "no transcript". REACHABLE, not
    // defensive: a Session that CLOSED this boot is appended to
    // `historySessions` by `handleSessionClosed` with no boot-map entry.
    expect(relativeTimeFor("ghost", undefined, {}, NOW)).toBeNull();
    expect(relativeTimeFor("ghost", [], {}, NOW)).toBeNull();
  });

  it("uses the LATEST (last) message, not the first", () => {
    expect(
      relativeTimeFor(
        "s1",
        [agent("old", NOW - 10 * 60_000), user("new", NOW - 30_000)],
        {},
        NOW,
      ),
    ).toBe("now");
    expect(
      relativeTimeFor(
        "s1",
        [user("new", NOW - 30_000), agent("old", NOW - 2 * 3_600_000)],
        {},
        NOW,
      ),
    ).toBe("2h");
  });
});

describe("relativeTimeFromInstant (the bucket rule, for ANY instant)", () => {
  // The rule this module owns was extracted from `relativeTimeFor` so a **Task**
  // card can bucket `task.updatedAt` — a different instant from a Session's
  // recency, reached with no transcript and no boot map in sight. Copying the four
  // lines into the card would have re-created the exact defect this module was
  // written to fix (two owners of one rule, drifting), so the card DELEGATES here
  // and these cases pin the arithmetic the card inherits.
  //
  // Buckets are `now` / `Nm` / `Nh` with NO "ago" suffix — byte-identical to what
  // the Session list prints, so a card's timestamp and the row beside it read the
  // same way. `now` is pinned so the arithmetic is deterministic.
  it("buckets a bare instant: `now` under a minute, `Nm` under an hour, `Nh` beyond", () => {
    expect(relativeTimeFromInstant(NOW - 1000, NOW)).toBe("now");
    expect(relativeTimeFromInstant(NOW - 59_999, NOW)).toBe("now");
    // The boundary leaves `now` at exactly a minute…
    expect(relativeTimeFromInstant(NOW - 60_000, NOW)).toBe("1m");
    expect(relativeTimeFromInstant(NOW - 59 * 60_000, NOW)).toBe("59m");
    // …and leaves `Nm` at exactly an hour.
    expect(relativeTimeFromInstant(NOW - 60 * 60_000, NOW)).toBe("1h");
    expect(relativeTimeFromInstant(NOW - 5 * 3_600_000, NOW)).toBe("5h");
  });

  it("agrees with relativeTimeFor on the same instant (the delegation pin)", () => {
    // THE reason the extraction is an extraction and not a copy: one rule decides
    // the Session row's label AND the card's. If `relativeTimeFor` grew its own
    // buckets back again — or the new function grew a suffix, a rounding step, a
    // different threshold — this case reddens, because both paths are fed the SAME
    // instant and must print the SAME string. `relativeTimeFor` reaches that instant
    // through `recencyOf` (the transcript arm); `relativeTimeFromInstant` is handed
    // it directly.
    for (const ago of [
      0,
      1_000,
      59_999,
      60_000,
      5 * 60_000,
      59 * 60_000,
      60 * 60_000,
      5 * 3_600_000,
    ]) {
      const at = NOW - ago;
      expect(relativeTimeFromInstant(at, NOW)).toBe(
        relativeTimeFor("s1", [user("a", at)], {}, NOW),
      );
    }
  });
});
