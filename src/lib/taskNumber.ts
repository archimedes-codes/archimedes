import type { TaskBadge } from "../lib/tauri";

/** The **Task badge** for a Session, or `null` for none. The ONLY reader of the
 *  `taskNumbers` map — a call site that indexes the store field directly gives the
 *  rule (`absent means no badge`) a second owner.
 *
 *  `sessionId` is `string | null`, NOT `string`: three of the four call sites hold
 *  `activeSessionId`, which is already nullable, and spelling this `string` turns
 *  each of them into a `pnpm build` error under `strict`.
 *
 *  The shape mirrors `lib/sessionRecency`'s `recencyOf` — same module-less,
 *  store-free position (a `lib → store` edge is the cycle `sessionTypes.ts`'s
 *  header documents): the map is PASSED IN by the caller, so this module knows the
 *  rule and nothing else. */
export function taskBadgeOf(
  map: Record<string, TaskBadge>,
  sessionId: string | null,
): TaskBadge | null {
  if (sessionId === null) return null;
  return map[sessionId] ?? null;
}
