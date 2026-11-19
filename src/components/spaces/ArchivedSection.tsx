import { useState } from "react";
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import type { SessionInfo, TaskBadge } from "../../lib/tauri";
import { archivedInSpace, useSessions } from "../../store/sessions";
import { RowButton } from "../RowButton";
import { ArchivedSessionRow } from "./ArchivedSessionRow";

/**
 * The **active Space's** Archived section: the archived rows whose `cwd` is the
 * selected Space, rendered AFTER that Space's groups and scrolling with the
 * list. COLLAPSED by default — EXCEPT when it holds the active Session, in which
 * case it is open (see the derived `open` below); the header (icon + "Archived" +
 * count + chevron) toggles it either way. The count is the SAME array the rows
 * render, so it is the Space's count and never the app-wide total.
 *
 * The ORDER is explicit recency, and the two filters below are `archivedInSpace`'s
 * rather than this component's — one call, so the badge, the rows and the sort
 * cannot disagree. This section is the list ADR 0075 calls the trap: it used to
 * inherit its order from the query's input order and get recency for free, and
 * once that query returned the Manual order it presented a manual arrangement
 * under a heading that means recency while passing every test that did not assert
 * the order.
 *
 * Two filters, both load-bearing (applied by the store function, whose own doc
 * says why):
 * - the sticky live ids are view-filtered out — a resumed archived session
 *   renders in its Space group (live), not here (CONTEXT.md "Archived session");
 * - rows of another Space are excluded — the section is the SELECTED Space's, so
 *   a sibling tab's archived rows appear when that tab is selected, never while
 *   this one is. A row whose Space has no open tab at all is **Detached** and is
 *   listed in Settings → Detached sessions; there is no fallback listing here.
 *
 * With no Space selected (`activeSpacePath === null`) `cwd === null` matches
 * nothing, so the "No archived sessions." empty state renders while archived rows
 * exist. That is honest: none of them belong to a Space the sidebar is showing.
 */
export function ArchivedSection({
  activeSessionId,
  onOpen,
  onDelete,
  badgeMap,
}: {
  activeSessionId: string | null;
  onOpen: (sessionId: string) => void;
  onDelete: (session: SessionInfo) => void;
  /** The **Task badge** map, threaded from the pane (which holds the ONE
   *  `taskNumbers` subscription) rather than selected here. The section does select
   *  `sessionRecency` for ITSELF — `archivedInSpace` sorts by it — but a badge sorts
   *  nothing, so this section needs the map only to hand it on. */
  badgeMap: Record<string, TaskBadge>;
}) {
  const archived = useSessions((s) => s.archivedSessions);
  const sessions = useSessions((s) => s.sessions);
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
  // The recency the section sorts by (ADR 0075). `{ recency }` only, never
  // `{ recency, messages }`: subscribing this section to the transcripts would
  // re-render it on every streamed token, and the boot map is the same SQL
  // expression the row's label reads (T03's D3, inherited here).
  const sessionRecency = useSessions((s) => s.sessionRecency);
  // ONE call, so the badge and the rows cannot disagree, and so the sort is the
  // STORE's — said out loud — rather than an order inherited from a query that
  // since ADR 0075 returns the Manual order. The defect this line closes: the
  // section used to `archived.filter(…)` in input order and inherit recency for
  // free, and after T01's ORDER BY swap that input order became the Manual
  // order — a manual arrangement under a heading that means recency, passing
  // every test that did not assert the order (this is the one that does).
  const visible = archivedInSpace(activeSpacePath, archived, sessions, {
    recency: sessionRecency,
  });
  // Collapsed by default, because the section is secondary — with ONE exception
  // that decides the whole shape: the Landing Session can now be an ARCHIVED one
  // (ADR 0075's amendment), and `activeView.sessionIds` is `mergeSessionOrder`'s
  // output, which by construction never contains an archived id — so the Space
  // group can never carry the highlight and THIS section is the only place that
  // row lives. Left collapsed, the app would boot with a transcript on screen and
  // nothing in the sidebar pointing at it. Opening the section does not select
  // anything: it reveals the row that is already selected.
  //
  // DERIVED, not seeded at mount. The rule is the controlled/uncontrolled split:
  // the user's own click, once made, is final for this mount; until then the
  // section is open exactly when it holds the row that is actually on screen.
  //
  // Why the initialiser-only form (this file's previous shape) was inert in the
  // shipped app — THE BOOT ORDER, which is the finding: `src/main.tsx` renders
  // `<App />` with no boot gate, so `SpacesList` — and this section — mounts on
  // the FIRST frame, while boot's
  // `Promise.all([listSessions(true), listSpaces(), sessionRecency()]).then(… setSpaces …)`
  // is what runs `autoSelectActive` and lands `activeSessionId` on the archived
  // row strictly LATER. This component is mounted unconditionally and UNKEYED in
  // the permanent sidebar (ADR 0094/0095), so a lazy initialiser ran exactly once
  // against `activeSessionId === null`, computed `false`, and never recomputed —
  // collapsed on boot in precisely the state the rule exists to serve. The tab-
  // click route failed the same way: the section is mounted long before
  // `selectSpace` sets the id. A test that seeded the active row BEFORE `render`
  // could not see this, which is exactly why the pin now renders first and lands
  // the Session after.
  //
  // No effect is needed and none is wanted: `holdsActiveRow` is a boolean
  // PRIMITIVE, so this compares a value, not an identity. Do NOT put `visible` in
  // a dependency list — `archivedInSpace` returns a fresh array every render, so
  // an effect keyed on it churns (and an effect that sets state is the shape that
  // risks a render loop).
  //
  // `userChoice === null` means "untouched": open iff this section holds the
  // active row. A hand-collapsed section therefore STAYS collapsed even if the
  // active row later leaves it, and a hand-opened one stays open — the user's
  // click outranks the derivation for the rest of this mount.
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const holdsActiveRow = visible.some((s) => s.sessionId === activeSessionId);
  const open = userChoice ?? holdsActiveRow;
  return (
    // NO horizontal padding: the list scroller owns the pane's 12px rail, and this
    // section sits INSIDE it, so a `px-*` here would double the inset for every
    // archived row and push its glyph past the live rows above. The toggle's own
    // `px-2` below is then the only inner inset, matching `PANE_COMMAND_ROW`'s.
    <div className="py-1">
      <RowButton
        onClick={() => setUserChoice(!open)}
        className="group flex cursor-pointer items-center gap-1 rounded-lg px-2 hover:bg-surface-hover"
      >
        <ArchiveIcon className="size-4 shrink-0 text-foreground-subtlest" />
        <span className="flex-1 truncate text-ui-base text-foreground-subtlest group-hover:text-foreground-subtle">
          Archived
        </span>
        <span className="text-ui-sm text-foreground-subtlest">
          {visible.length}
        </span>
        {open ? (
          <ChevronDownIcon className="size-4 shrink-0 text-foreground-subtlest" />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" />
        )}
      </RowButton>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5">
          {visible.length === 0 ? (
            <p className="px-1 py-1 text-ui-sm text-foreground-subtlest">
              No archived sessions.
            </p>
          ) : (
            visible.map((session) => (
              <ArchivedSessionRow
                key={session.sessionId}
                session={session}
                active={activeSessionId === session.sessionId}
                onOpen={onOpen}
                onDelete={onDelete}
                recencyMap={sessionRecency}
                badgeMap={badgeMap}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
