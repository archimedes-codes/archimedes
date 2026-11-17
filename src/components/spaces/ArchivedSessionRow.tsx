import { ArchiveXIcon, Trash2Icon } from "lucide-react";
import type { SessionInfo, TaskBadge } from "../../lib/tauri";
import { titleFor } from "../../lib/sessionTitle";
import { relativeTimeFor } from "../../lib/sessionTime";
import { taskBadgeOf } from "../../lib/taskNumber";
import { useSessions } from "../../store/sessions";
import { SessionListRow } from "../SessionListRow";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import {
  ROW_HOVER_ACTION,
  SESSION_ROW_ACTION_ROW,
  spaceNameFor,
} from "./sessionRowStyles";

/**
 * One archived-session row (the `SessionRow` visual pattern): 16px
 * leading slot (empty — archived sessions are NEVER live, so no
 * spinner), the title, and the relative time (empty slot only when
 * NEITHER the transcript nor the boot recency map proves recency — the
 * Archived list is sorted by that map, so a row it stamped now prints
 * the stamp it was sorted by). NO `· {spaceName}` suffix: the
 * section is scoped to the active Space, so a row here can never belong to
 * another Space and the cue would only repeat what the header already says.
 * (`spaceName` still feeds `titleFor` as the last-resort label when the
 * session has neither a generated title nor a loaded transcript.)
 * Hover: Unarchive (`ArchiveX`, reversible — no confirm) + Delete (`Trash2`,
 * the only destructive action — confirm dialog). Click opens the transcript
 * (identical to a stored row — the first send resumes it).
 */
export function ArchivedSessionRow({
  session,
  active,
  onOpen,
  onDelete,
  recencyMap,
  badgeMap,
}: {
  session: SessionInfo;
  active: boolean;
  onOpen: (sessionId: string) => void;
  onDelete: (session: SessionInfo) => void;
  /** The boot recency map the SECTION already selects (it is the very value
   *  `archivedInSpace` sorted these rows by). Passed down, never indexed here:
   *  `recencyOf` does the reading, so the label a row prints is the number that
   *  ordered it. */
  recencyMap: Record<string, number>;
  /** The **Task badge** map, from the pane through `ArchivedSection`. Same rule as
   *  the live/stored row: the badge nests in the SAME title-span slot, which is what
   *  keeps the two sections title-aligned. */
  badgeMap: Record<string, TaskBadge>;
}) {
  const messages = useSessions((s) => s.messages[session.sessionId]);
  const spaces = useSessions((s) => s.spaces);
  const unarchiveSession = useSessions((s) => s.unarchiveSession);
  const spaceName = spaceNameFor(session.cwd, spaces);
  const title = titleFor(messages, spaceName, session.title);
  const time = relativeTimeFor(session.sessionId, messages, recencyMap);
  // The **Task badge** — the same rule the live/stored row reads, so the two
  // sections answer the question identically and their titles stay aligned.
  const badge = taskBadgeOf(badgeMap, session.sessionId);
  // Unarchive first, Delete OUTERMOST: Delete is the only destructive action on
  // this row (confirm dialog), so it sits furthest from the content. The live
  // row deliberately does NOT copy this rule — Archive there is reversible and
  // never destroys a transcript (ADR 0016), so it can sit outside Stop.
  //
  // NO `leading` prop: an archived Session is NEVER live, so the leading slot is
  // `SessionListRow`'s empty 16px spacer — the same width the status mark
  // occupies, which is what keeps these rows aligned with the ones above.
  return (
    <SessionListRow
      title={title}
      active={active}
      time={time}
      onOpen={() => onOpen(session.sessionId)}
      badge={badge}
      actions={
        <>
          <Button
            type="button"
            draggable={false}
            variant="ghost"
            size="icon-sm"
            title="Unarchive"
            aria-label={`Unarchive ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              void unarchiveSession(session.sessionId).catch((err) => {
                console.error("Failed to unarchive session:", err);
              });
            }}
            className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
          >
            <ArchiveXIcon className="size-4" />
          </Button>
          <Button
            type="button"
            draggable={false}
            variant="ghost"
            size="icon-sm"
            title="Delete"
            aria-label={`Delete ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session);
            }}
            className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </>
      }
    />
  );
}
