import { ArchiveIcon, SquareIcon } from "lucide-react";
import type { TaskBadge } from "../../lib/tauri";
import { sessionFieldOf } from "../../lib/sessionLookup";
import { titleFor } from "../../lib/sessionTitle";
import { relativeTimeFor } from "../../lib/sessionTime";
import { taskBadgeOf } from "../../lib/taskNumber";
import { useSessions } from "../../store/sessions";
import {
  type DragReorderHandlers,
  type DropEdge,
} from "../../hooks/useDragReorder";
import { useSessionStatus } from "../../hooks/useSessionStatus";
import { SessionStatusMark } from "../SessionStatusMark";
import { SessionListRow } from "../SessionListRow";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW } from "./sessionRowStyles";

/**
 * One session row: the leading `SessionStatusMark` (spinner = in a turn,
 * `?` = a pending permission / `ask` / sudo password or a child holding one,
 * filled ring = live and idle, dim ring = stored — the SAME glyph set the
 * tab draw), the title with a gradient-fade mask
 * (applied to the text ITSELF — background-agnostic, so it works over
 * `bg-frame` / `bg-selected` / `bg-surface-hover` alike; the text is NOT
 * `truncate`-ellipsized, it overflows under the fade), and the right slot: the
 * relative time of last activity — ALWAYS the time. Hover swaps it for the
 * row's actions: EVERY row swaps, live or stored. A live row offers Stop then
 * Archive (`inTurn` → cancel the turn, else close the Session), a stored row
 * offers Archive alone (reversible — no confirm). The live row used to have no
 * hover action at all: the Pause button was deleted and nothing replaced it, so
 * a running Session could not be stopped or put away without opening it first.
 *
 * THE TRAILING "Waiting" PILL IS GONE, and the `?` in the leading slot is why.
 * The pill and the leading mark were the same fact drawn twice in two shapes,
 * and the pill's price was the time: while a session waited you could not see
 * how long ago it had been active. One attention glyph in the slot the spinner
 * already occupies (where the eye already looks for "what is this session
 * doing") says it and leaves the time alone.
 */
export function SessionRow({
  sessionId,
  spaceName,
  active,
  onOpen,
  drag,
  dropEdge,
  recencyMap,
  badgeMap,
}: {
  sessionId: string;
  spaceName: string;
  active: boolean;
  onOpen: (sessionId: string) => void;
  /** This row's `useDragReorder` spread, from the pane's one hook instance. */
  drag?: DragReorderHandlers;
  /** Which edge of this row to mark, or `null` when it is not the target. */
  dropEdge?: DropEdge | null;
  /** The boot recency map, passed DOWN from the pane (which already selects it
   *  for `spaceViewFor`) so this row adds NO subscription of its own. Required:
   *  `relativeTimeFor` reads it through `recencyOf`, and a row with no loaded
   *  transcript has nothing else to print. */
  recencyMap: Record<string, number>;
  /** The **Task badge** map, passed DOWN from the pane for the SAME reason as
   *  `recencyMap`: the pane holds the ONE subscription and this row adds none of its
   *  own. Required, so a row cannot be rendered without having been asked "does this
   *  Session wear a badge?" — `taskBadgeOf` answers `null` when the map has no entry,
   *  and `null` renders nothing. */
  badgeMap: Record<string, TaskBadge>;
}) {
  const messages = useSessions((s) => s.messages[sessionId]);
  const isLive = useSessions((s) => s.sessions.some((x) => x.sessionId === sessionId));
  const archiveSession = useSessions((s) => s.archiveSession);
  // The row's generated title, read by id: `SessionRow` is given an id (by
  // design — its parent holds `sessionIds`, the id sequence, never the
  // rows), so no `SessionInfo` is threaded through `SpaceView` for it. The
  // selector returns a PRIMITIVE via the ONE three-list walk
  // (`lib/sessionLookup.ts` — live / history / archived, live first): zustand
  // v5 re-runs a selector that yields a fresh OBJECT on every snapshot read, so
  // `{ … }` here would re-render the row forever.
  const storedTitle = useSessions(
    (s) => sessionFieldOf(s, sessionId, "title") ?? null,
  );
  // The row's mark (spinner / `?` / ring) comes from the SAME rule the
  // tab uses — see `useSessionStatus`.
  const status = useSessionStatus(sessionId);
  // The SAME field `stopSession` reads at click time — so tooltip and action can
  // never disagree about WHICH field they mean. A flip between the last render
  // and the click is the render/click gap `stopSession` accepts on purpose
  // ("paint and click are not the same tick"), not drift this row could hide.
  const inTurn = useSessions((s) => !!s.inTurn[sessionId]);
  const stopSession = useSessions((s) => s.stopSession);
  // The triple `recencyOf` takes: this row's own transcript (the FRESHER
  // evidence, already subscribed) plus the boot map the pane handed down, so the
  // no-transcript arm prints the same stamp the list was ordered by.
  const time = relativeTimeFor(sessionId, messages, recencyMap);
  const title = titleFor(messages, spaceName, storedTitle);
  // The **Task badge** for this Session, or `null` — read through the ONE rule
  // (`taskBadgeOf`) rather than indexed here, so `absent means no badge` keeps a
  // single owner. A row with no entry renders exactly what it rendered before the
  // badge existed: no node, no character, no `gap`.
  const badge = taskBadgeOf(badgeMap, sessionId);

  // Stop first: it is the action that pertains to a session that is RUNNING, so the
  // row reads left-to-right as "stop what's running, then put it away". The Archived
  // row keeps its destructive control OUTERMOST (Unarchive then Delete); this row
  // deliberately does not copy that — Archive is not destructive (ADR 0016:
  // reversible, and it never destroys a transcript).
  //
  // The actions are plain `<button>`s, NOT `RowButton`: a `role="button"` inside
  // the row would resolve every `.closest('[role="button"]')` read in
  // `SpacesList.test.tsx` to the button instead of the row, and would turn each
  // `rowOf(…).getByRole("button", …)` into a multiple-match throw.
  //
  // EACH CARRIES `draggable={false}` (spec §Handle). The row itself is
  // `draggable`, and these buttons are its CHILDREN, so a press that begins on
  // Stop or Archive would otherwise start a drag of the row instead of acting —
  // the worst possible failure on the two controls that end a turn and put a
  // Session away. It is spelled on every one rather than inherited: an absent
  // attribute is not the same answer as an explicit opt-out.
  const actions = (
    <>
      {isLive && (
        <Button
          type="button"
          draggable={false}
          variant="ghost"
          size="icon-sm"
          title={inTurn ? "Stop this turn" : "Stop this session"}
          aria-label={`Stop ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            void stopSession(sessionId).catch((err) => {
              console.error("Failed to stop session:", err);
            });
          }}
          className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
        >
          <SquareIcon className="size-4" />
        </Button>
      )}
      <Button
        type="button"
        draggable={false}
        variant="ghost"
        size="icon-sm"
        title="Archive"
        aria-label={`Archive ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          void archiveSession(sessionId).catch((err) => {
            console.error("Failed to archive session:", err);
          });
        }}
        className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
      >
        <ArchiveIcon className="size-4" />
      </Button>
    </>
  );

  // The state glyph, in the slot the spinner already owned: a session that
  // is idle now wears a RING rather than nothing — the cue this list used
  // to omit, which left the idle state drawn as an absence.
  // `dotSize={8}` halves the RING alone: the three states are three different
  // amounts of ink, and the ring is the only one that reads as a solid chunk of
  // paint, so at a shared 16px the idle state outshouted the working state
  // above it — inverting their importance. The spinner and the `?` are outlines
  // whose weight is what makes them readable, and they keep the full slot. No
  // `testId`: the tests reach the mark through the STATE it paints
  // (`[data-dot="…"]`) — the hook that asserts what the user sees rather than
  // which node carried it. The mark owns its own ink (`text-foreground` on the
  // active row, `text-foreground-subtlest` otherwise) — see
  // `SessionListRow`'s note on why the row must not pass one.
  return (
    <SessionListRow
      title={title}
      active={active}
      time={time}
      onOpen={() => onOpen(sessionId)}
      drag={drag}
      dropEdge={dropEdge}
      leading={
        <SessionStatusMark status={status} active={active} size={16} dotSize={8} />
      }
      badge={badge}
      actions={actions}
    />
  );
}
