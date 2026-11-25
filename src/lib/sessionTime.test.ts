import { describe, expect, it } from "vitest";
import {
  absoluteTimeFromInstant,
  relativeTimeFor,
  relativeTimeFromInstant,
} from "./sessionTime";
import { makeMessage } from "../test/fixtures";

const user = (text: string, at: number) => makeMessage("user", { text, at });
const agent = (text: string, at: number) =>
  makeMessage("agent-text", { text, at });

const NOW = 1_700_000_000_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Local NOON, so the calendar day is the same in every TZ the suite runs in: a
// local midnight can fall on the previous UTC day west of Greenwich.
const localNoon = (y: number, m: number, d: number) =>
  new Date(y, m, d, 12).getTime();

describe("relativeTimeFor (ONE rule for a Session's relative last-activity label)", () => {
  it("is `now` under a minute", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 1000)], {}, NOW)).toBe("now");
    expect(relativeTimeFor("s1", [user("a", NOW - 59_999)], {}, NOW)).toBe("now");
  });

  it("is `Nm` under an hour", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 5 * 60_000)], {}, NOW)).toBe("5m");
    expect(relativeTimeFor("s1", [user("a", NOW - 59 * 60_000)], {}, NOW)).toBe("59m");
  });

  it("is `Nh` at or above an hour and under a day", () => {
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
  it("buckets a bare instant: `now` under a minute, `Nm` under an hour, `Nh` under a day", () => {
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
      23 * HOUR,
      DAY - 1,
      DAY,
      3 * DAY,
      30 * DAY - 1,
      30 * DAY,
      400 * DAY,
      // Negative `ago` is a FUTURE instant: both paths must print `now`.
      -9_000_000_000,
    ]) {
      const at = NOW - ago;
      expect(relativeTimeFromInstant(at, NOW)).toBe(
        relativeTimeFor("s1", [user("a", at)], {}, NOW),
      );
    }
  });

  it("pins the prior-year date label on both paths", () => {
    // The loop above covers the FUTURE side of the date arm (`-9_000_000_000`).
    // This pins the PAST side: a stamp from a prior calendar year carries the
    // year, and both paths must print it identically.
    const at = localNoon(2022, 10, 11);
    expect(relativeTimeFromInstant(at, NOW)).toBe("Nov 11, 2022");
    expect(relativeTimeFor("s1", [user("a", at)], {}, NOW)).toBe("Nov 11, 2022");
  });
});

describe("relativeTimeFromInstant — hour and day arms", () => {
  it("boundaries: 59s is `now`, 60s is `1m`, 59m is `59m`, 60m is `1h`", () => {
    expect(relativeTimeFromInstant(NOW - 59_000, NOW)).toBe("now");
    expect(relativeTimeFromInstant(NOW - MIN, NOW)).toBe("1m");
    expect(relativeTimeFromInstant(NOW - 59 * MIN, NOW)).toBe("59m");
    expect(relativeTimeFromInstant(NOW - HOUR, NOW)).toBe("1h");
  });

  it("boundaries: 23h and DAY-1 are `23h`, 24h is `1d`", () => {
    expect(relativeTimeFromInstant(NOW - 23 * HOUR, NOW)).toBe("23h");
    expect(relativeTimeFromInstant(NOW - (DAY - 1), NOW)).toBe("23h");
    expect(relativeTimeFromInstant(NOW - DAY, NOW)).toBe("1d");
  });

  it("is `Nd` from one day up to thirty days", () => {
    expect(relativeTimeFromInstant(NOW - (2 * DAY + 5 * HOUR), NOW)).toBe("2d");
    expect(relativeTimeFromInstant(NOW - (30 * DAY - 1), NOW)).toBe("29d");
  });

  it("at exactly thirty days leaves the `Nd` arm for a short date, never `ago`", () => {
    const label = relativeTimeFromInstant(NOW - 30 * DAY, NOW);
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(label).not.toContain("ago");
  });
});

describe("relativeTimeFromInstant — short date arm (>= 30 days)", () => {
  it("omits the year within the same calendar year as `now`", () => {
    expect(
      relativeTimeFromInstant(localNoon(2023, 10, 11), localNoon(2023, 11, 31)),
    ).toBe("Nov 11");
  });

  it("drops the leading zero from the day: early January is `Jan 5`", () => {
    expect(
      relativeTimeFromInstant(localNoon(2023, 0, 5), localNoon(2023, 2, 15)),
    ).toBe("Jan 5");
  });

  it("adds the year when `at` is in a prior calendar year", () => {
    expect(
      relativeTimeFromInstant(localNoon(2022, 10, 11), localNoon(2023, 10, 14)),
    ).toBe("Nov 11, 2022");
  });

  it("crosses the year boundary: a 36-day gap into a new year still prints the prior year", () => {
    expect(
      relativeTimeFromInstant(localNoon(2022, 11, 15), localNoon(2023, 0, 20)),
    ).toBe("Dec 15, 2022");
  });

  it("takes the year from the injected `now`, not the wall clock", () => {
    // Same calendar year as `now` → no suffix. A wall-clock year would be 2025+,
    // and would wrongly append ", 2020".
    expect(
      relativeTimeFromInstant(localNoon(2020, 5, 3), localNoon(2020, 11, 1)),
    ).toBe("Jun 3");
  });

  it("does not throw at the epoch and prints a 1969/1970 year", () => {
    expect(relativeTimeFromInstant(1, NOW)).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, (1969|1970)$/,
    );
  });
});

describe("relativeTimeFromInstant — future instants", () => {
  it("prints `now` for a stamp a moment ahead", () => {
    expect(relativeTimeFromInstant(NOW + 1_000, NOW)).toBe("now");
  });

  it("prints `now` for a stamp ~104 days ahead, never the date arm", () => {
    // The `< 60_000` arm is FIRST for this reason: a negative diff must not fall
    // through to the short-date arm.
    expect(relativeTimeFromInstant(NOW + 9_000_000_000, NOW)).toBe("now");
  });
});

describe("absoluteTimeFromInstant (the exact instant, for a `title` tooltip)", () => {
  // 2023-11-11 14:45 LOCAL — local so the wall-clock digits are deterministic.
  const at = new Date(2023, 10, 11, 14, 45).getTime();
  // ICU puts a narrow no-break space (U+202F) before AM/PM in some versions.
  const plain = (s: string) => s.replace(/\u202f/g, " ");

  it("is a non-empty string", () => {
    const label = absoluteTimeFromInstant(at);
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });

  it("names the calendar date: year, month and day", () => {
    const label = absoluteTimeFromInstant(at);
    expect(label).toContain("2023");
    expect(label).toContain("Nov");
    expect(label).toContain("11");
  });

  it("names the time to the minute, 12-hour with AM/PM", () => {
    const label = plain(absoluteTimeFromInstant(at));
    expect(label).toMatch(/\d{1,2}:45/);
    expect(label).toMatch(/ (AM|PM)$/);
  });

  it("is exactly the en-US medium-date, short-time rendering", () => {
    expect(absoluteTimeFromInstant(at)).toBe(
      new Date(at).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
  });

  it("includes the current year for `Date.now()`", () => {
    expect(absoluteTimeFromInstant(Date.now())).toContain(
      String(new Date().getFullYear()),
    );
  });

  it("distinguishes two instants five minutes apart", () => {
    expect(absoluteTimeFromInstant(at)).not.toBe(
      absoluteTimeFromInstant(at + 5 * MIN),
    );
  });

  it("does not throw on the epoch instant `1`", () => {
    expect(() => absoluteTimeFromInstant(1)).not.toThrow();
  });
});

