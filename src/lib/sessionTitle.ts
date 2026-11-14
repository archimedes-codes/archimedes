import type { Message } from "./sessionTypes";

/**
 * A **Session**'s label: its GENERATED **Title** (`SessionInfo.title`, written
 * once by the naming pass — ADR 0037) when it has one, else the first user
 * message truncated to ~80 chars, else the **Space**'s folder name.
 *
 * THE ONE title rule, shared by every surface that labels a Session (the
 * **Session list**'s rows, the close-confirm's list of open Sessions, …) — a
 * label that disagrees with the row it names is worse than no label, which is
 * the same reasoning that once put the side pane's rail marks and its panel on
 * one derivation (both of those surfaces' shared owner is gone with the rails —
 * ADR 0094 — but the rule this function owns still has the consumers named
 * above). (`SidePane`'s header and `SpacesList`'s row used to carry their
 *  own inline copies of the TITLE LOOKUP; that walk now has one owner,
 *  `sessionFieldOf` in `lib/sessionLookup.ts`, which they call from inside their
 *  selectors. The two are still separate on purpose: this function owns the
 *  LABEL (title → prompt truncation → folder name), the lookup owns WHERE the
 *  title comes from.)
 *
 * `""` is no title (the backend never writes one; a generated title is cleaned
 * to a non-empty string or not written at all).
 *
 * **The second arm does not need the transcript any more** (ADR 0073's
 * amendment, issue #155). A Session's transcript is now released when the user
 * navigates away from it, so `messages` is `undefined` for every Session the
 * window is not currently showing — and eight surfaces label rows for Sessions
 * they are not showing. Rather than let all eight fall to the folder name,
 * `store/sessions.ts` carries this arm's ANSWER onto the `SessionInfo.title` of
 * every list holding the id at the moment it releases the transcript, so the
 * first arm supplies what the second arm used to. Read that as: `title` is the
 * label the store holds, which is the naming pass's title when there is one and
 * a carried first-prompt label when there is not. This function's own chain is
 * unchanged, and so is its output.
 */
export function titleFor(
  messages: Message[] | undefined,
  spaceName: string,
  title?: string | null,
): string {
  if (title !== null && title !== undefined && title !== "") return title;
  // `""` is NOT a label — the pre-existing behaviour is that an empty first
  // user message falls through to the folder name, so the shared helper's
  // `null` covers it.
  return firstPromptLabelOf(messages) ?? spaceName;
}

/**
 * The first arm's answer on its own: the first **user** message's text,
 * truncated to 80 chars, or `null` when the transcript has none or its text is
 * empty.
 *
 * It exists so the truncation rule has ONE owner. The store needs exactly this
 * value at the moment it releases a transcript (see the note on `titleFor`), and
 * a second copy of `slice(0, 80)` in `store/sessions.ts` is how two surfaces
 * start naming one Session differently — the failure this module was extracted
 * to prevent. A caller that has the label and not the transcript reads it back
 * off `SessionInfo.title` through `lib/sessionLookup`'s walk.
 */
export function firstPromptLabelOf(
  messages: readonly Message[] | undefined,
): string | null {
  const firstUser = messages?.find((m) => m.kind === "user");
  if (!firstUser || firstUser.text === "") return null;
  return firstUser.text.length > 80 ? firstUser.text.slice(0, 80) : firstUser.text;
}
