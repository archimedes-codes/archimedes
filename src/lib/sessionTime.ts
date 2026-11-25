import type { Message } from "./sessionTypes";
import { recencyOf } from "./sessionRecency";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DATE_ARM_MS = 30 * DAY_MS;

/**
 * The relative time of an **instant**, bucketized — the ONE owner of the bucket
 * rule, for ANY caller that already holds a timestamp.
 *
 * `<60s` → `now`, `<60m` → `Nm`, `<24h` → `Nh`, `<30d` → `Nd`, else a short
 * date: `Nov 11` within the calendar year of `now`, `Nov 11, 2022` from a prior
 * year. No "ago" suffix, and that is a contract rather than a taste: the **Session**
 * list and a **Task** card print this string in the same app, so a suffix on one
 * arm would make two surfaces read as two clocks.
 *
 * A future `at` (negative diff) falls in the `<60s` arm and prints `now`, because
 * that arm is tested first and so a future stamp never reaches the date arm.
 *
 * This is `relativeTimeFor`'s own arithmetic, lifted verbatim, so a caller holding
 * a DIFFERENT instant can share the rule instead of copying it. A Task card
 * buckets `task.updatedAt` — Unix **ms**, written by `now_ms()` in
 * `src-tauri/src/storage/db.rs`, the same unit as a message's `at`, so no scaling
 * happens here — and it has no transcript and no boot recency map to walk, so it
 * cannot reach `relativeTimeFor` at all. Four copied lines would have created
 * exactly the second owner this module exists to prevent, which is why
 * `relativeTimeFor` delegates here after resolving its instant instead of keeping
 * its own buckets.
 *
 * `now` stays the last parameter (defaulting to the wall clock) for the same
 * reason as below: a caller — and a test — can pin the arithmetic to a fixed
 * instant.
 */
export function relativeTimeFromInstant(
  at: number,
  now: number = Date.now(),
): string {
  const diff = now - at;
  if (diff < MINUTE_MS) return "now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  if (diff < DATE_ARM_MS) return `${Math.floor(diff / DAY_MS)}d`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(
    "en-US",
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

/**
 * The full localized date and time of an **instant** — for a `title` tooltip.
 *
 * The relative label (`relativeTimeFromInstant`) is the glance; this is the exact
 * instant behind it, so hovering a timestamp shows when it actually happened.
 */
export function absoluteTimeFromInstant(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The relative time of a **Session**'s last activity — the DISPLAY side of the
 * ONE recency rule.
 *
 * The rule itself lives in `sessionRecency.ts`'s `recencyOf`, and this function
 * DELEGATES to it: same `(sessionId, loadedMessages, recencyMap)` triple, same
 * transcript-first walk, same boot-map fallback. What `relativeTimeFor` adds is
 * only the bucketizing of that one number — and even that it delegates, to
 * `relativeTimeFromInstant` above, so the buckets have ONE owner across every
 * instant the app prints rather than one owner per surface.
 *
 * That delegation is the whole point of this module. It used to read
 * `messages[messages.length - 1]` itself and return `null` when no transcript
 * was loaded, while `recencyOf` — the number `sortByRecency` orders the
 * **Archived** list by and the Landing session pick decides by — fell back to
 * the boot `sessionRecency` stamp for exactly that case. Two owners of "when was
 * this Session last active?" disagreed on the no-transcript arm, and the
 * user-visible symptom was a list ORDERED by a stamp its own rows refused to
 * print. One rule now decides both the number and the string, so they cannot
 * drift (the same shape of fix `sessionTitle.ts`'s Phase A applied to titles).
 *
 * The empty slot therefore changes meaning rather than disappearing: `null` now
 * means **"neither the transcript nor the boot recency map can prove recency"**
 * — reachable, not defensive, for a Session that CLOSED this boot
 * (`handleSessionClosed` appends it to `historySessions` with no boot-map entry).
 * A caller holding a definite instant never has that arm to represent, which is why
 * `relativeTimeFromInstant` returns `string` and this one keeps `string | null`.
 *
 * `now` stays the last parameter (defaulting to the wall clock) so a caller —
 * and a test — can pin the arithmetic to a fixed instant. The buckets are the
 * ones `relativeTimeFromInstant` owns (`now`, `Nm`, `Nh`, `Nd`, then a short
 * date), so a Session row and a Task card print the same string for the same
 * instant; this function only decides where the instant comes from.
 */
export function relativeTimeFor(
  sessionId: string,
  loadedMessages: Message[] | undefined,
  recencyMap: Record<string, number>,
  now: number = Date.now(),
): string | null {
  const at = recencyOf(sessionId, loadedMessages, recencyMap);
  if (at === null) return null;
  return relativeTimeFromInstant(at, now);
}
