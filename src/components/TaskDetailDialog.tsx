import { useId, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { IpcErrorLine } from "./IpcErrorLine";
import { MutedCaption } from "./MutedCaption";
import { SessionStatusMark } from "./SessionStatusMark";
import { TaskArtifactTabPane } from "./tasks/TaskArtifactTabPane";
import { TaskDescription } from "./tasks/TaskDescription";
import { TaskDetailHeader } from "./tasks/TaskDetailHeader";
import { TaskDetailProperties } from "./tasks/TaskDetailProperties";
import { cn } from "./lib/utils";
import { sessionFieldOf } from "../lib/sessionLookup";
import { titleFor } from "../lib/sessionTitle";
import { basenameOfPath } from "../lib/paths";
import { sessionStatusRollupOf } from "../lib/sessionStatusRollup";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { useSessionStatuses } from "../hooks/useSessionStatus";
import { useArtifactReader } from "../hooks/useArtifactReader";
import { launchTaskSession } from "../store/taskLaunch";
import { useSessions } from "../store/sessions";
import { useTasks } from "../store/tasks";
import { describeIpcError } from "../lib/ipcError";
import { nextStepSlugs } from "../lib/workflowGraph";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "./ui/dialog";
import type { TaskRow, TaskSessionRow } from "../lib/tauri";

/**
 * The **Task detail** modal: what a card opens when it is clicked.
 *
 * ## Why this surface exists
 *
 * The card is a two-line summary by construction, and that is correct on a card. This
 * modal is where the clipped information goes, and where the launch buttons live. It is
 * wide (`sm:max-w-4xl`) and two-column: a Document-First tab strip (Overview plus one tab
 * per artifact) over ONE scroller on the left, and a Properties column on the right. The
 * header and the launch footer stay pinned.
 *
 * ## It is the only file that reads stores or IPC
 *
 * ADR 0074: the four children under `components/tasks/` are props-only. This file owns
 * `useArtifactReader`, the `useTasks` actions, `launchTaskSession`, the session-row label
 * chain, and the lifted editing state that decides whether Escape closes the modal.
 *
 * ## Two buttons and the edges they come from
 *
 * The launch footer is one button per outgoing workflow edge. The first is the Primary
 * next step (`variant="default"`); the rest are `outline`. Each is gated on the skill its
 * own destination needs, and the modal closes after a successful launch.
 *
 * ## `onLaunched` is what makes the feature visible
 *
 * The launch selects the new Session in the store, but the board view covers the chat
 * column. Without `onLaunched` the click starts a real Session and the user sees nothing.
 * It is REQUIRED for that reason.
 */
export interface TaskDetailDialogProps {
  /** The card, whole. The board's slice already carries every field, so no `getTask`
   *  fetch is issued for a card that is on screen. */
  task: TaskRow;
  /** The card's linked Sessions, OLDEST FIRST. Rendered as given, so this list and the
   *  card's chip agree about which Session "this card's" is. */
  sessions: TaskSessionRow[];
  /** Summed cost of those Sessions. `null` renders nothing; `0` renders `$0.00` (ADR 0082). */
  costUsd: number | null;
  /** The artifact KEYS on the card (ADR 0100). Keys only, never content: the document is
   *  fetched for the ONE tab the human opens. REQUIRED, so a caller that forgets it is a
   *  type error and not a silently empty tab strip. */
  artifactKeys: string[];
  /** The Space whose board is showing, and the cwd a launched Session starts in. `null`
   *  disables the Stage control and the launch buttons. */
  spacePath: string | null;
  /** Does ANY linked Session carry the `ready` marker? The board passes `readyFor(card)`.
   *  REQUIRED: the Status row's ready mark depends on it. */
  ready: boolean;
  onClose: () => void;
  /** Opens a Session. The board forwards `useSessions.getState().openSession`. */
  onOpenSession: (sessionId: string) => void;
  /** Leave the board view: a Session is now open. REQUIRED. */
  onLaunched: () => void;
}

export default function TaskDetailDialog({
  task,
  sessions,
  costUsd,
  artifactKeys,
  spacePath,
  ready,
  onClose,
  onOpenSession,
  onLaunched,
}: TaskDetailDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The launch's WARNING (the skipped-column case). Kept apart from `error` because the
  // Session did start; a successful action is never announced as a failure.
  const [note, setNote] = useState<string | null>(null);

  // THE TAB. `null` is Overview. A vanished key falls back to Overview below.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const shownKey =
    activeKey !== null && artifactKeys.includes(activeKey) ? activeKey : null;

  // WAI-ARIA TABS: a stable per-dialog id prefix, so each tab can name the panel and the
  // panel can name its selected tab. Tab ids are namespaced by kind, so an artifact keyed
  // `overview` cannot collide with the Overview tab's id (keys are `[a-z0-9][a-z0-9-]*`).
  const tabsId = useId();
  const tabDomId = (key: string | null): string =>
    key === null ? `${tabsId}-tab-overview` : `${tabsId}-tab-artifact-${key}`;
  const panelDomId = `${tabsId}-panel`;
  const activeTabDomId = tabDomId(shownKey);
  const tablistRef = useRef<HTMLDivElement>(null);

  // The inline editors' open state, LIFTED here so the dialog's Escape handler can tell
  // "an editor is open" from "nothing is". Each child reports every transition.
  const [titleEditing, setTitleEditing] = useState(false);
  const [specEditing, setSpecEditing] = useState(false);
  // The Description draft lives HERE so it survives Overview → artifact → Overview. It
  // only counts while its textarea is mounted (Overview showing), see `bodyEditorMounted`.
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // THE STORE READS, all in this file (ADR 0074). The prop is authoritative for which
  // Space the card belongs to; `task.spacePath` is the fallback for a null prop.
  const editTask = useTasks((state) => state.editTask);
  const moveTask = useTasks((state) => state.moveTask);
  const editSpace = spacePath ?? task.spacePath;
  const boostNote = useTasks((state) =>
    spacePath ? (state.boostNotes[spacePath] ?? null) : null,
  );

  // The artifact reader (ADR 0114). Mounted once here; the tab strip and the pane read
  // the same selection. The store action is passed in, never selected in the hook.
  const getArtifact = useTasks((state) => state.getArtifact);
  const { selectedKey, selectedArtifact, artifactError, select } =
    useArtifactReader({ taskId: task.id, getArtifact });

  // `mcpServers` is dropped: a launch message carries no `[image #3]` marker, so the
  // catalog precondition is skills and agents only.
  const { skills, agents } = useMentionCatalogs(spacePath);
  const catalogs = useMemo(() => ({ skills, agents }), [skills, agents]);

  // THE COLUMN LABEL COMES FROM THE STORE. `store/taskLaunch` reads the same slice to
  // decide whether a move is legal, so the two can never disagree. A slice that no longer
  // holds the column prints the SLUG: "we could not name it" differs from "no column".
  const columns = useTasks((state) =>
    spacePath ? state.boardsBySpace[spacePath] : undefined,
  );
  const stageLabelOf = (slug: string): string =>
    columns?.find((c) => c.stage.slug === slug)?.stage.label ?? slug;

  // THE SESSION ROWS' LABELS. Each selector returns the store's own reference, the zustand
  // v5 rule `lib/sessionLookup.ts` records; a fresh object here re-runs forever.
  const liveSessions = useSessions((s) => s.sessions);
  const historySessions = useSessions((s) => s.historySessions);
  const archivedSessions = useSessions((s) => s.archivedSessions);
  const sessionMessages = useSessions((s) => s.messages);

  // ONE batch call for the whole list. A hook cannot be called inside the `map` below.
  const statusById = useSessionStatuses(sessions.map((row) => row.sessionId));
  const lookupSource = {
    sessions: liveSessions,
    historySessions,
    archivedSessions,
  };

  // THE OUTGOING EDGES, from the same slice the Stage control reads. `nextStepSlugs` is the
  // one derivation shared with the board's launch pill. An edge whose slug is no longer a
  // column is KEPT and labelled with the slug, so a stale edge still reaches the skipped-
  // column note; the pill drops such an edge instead, because it has no note to show.
  const edges = useMemo(() => {
    const current = columns?.find((c) => c.stage.slug === task.stageSlug);
    if (!current) return [];
    return nextStepSlugs(columns, current.stage).map((slug) => {
      const stage = columns?.find((c) => c.stage.slug === slug)?.stage;
      return {
        slug,
        label: stage?.label ?? slug,
        // An unresolvable row contributes NO Skill, so its button is never gated.
        onEnterSkill: stage?.onEnterSkill ?? null,
        promptPrefix: stage?.promptPrefix ?? null,
      };
    });
  }, [columns, task.stageSlug]);

  // The Stage's rollup for the Properties Status row: the same rule the board paints.
  const rollup = sessionStatusRollupOf(sessions.map((r) => statusById[r.sessionId]));

  const launch = async (toStageSlug: string): Promise<void> => {
    if (spacePath === null) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const outcome = await launchTaskSession(spacePath, task, toStageSlug, catalogs);
      if (outcome.note !== null) {
        // THE NOTE WINS OVER THE NAVIGATION: the Session started, but the card did not move,
        // and a note about a card belongs on the surface showing the card.
        setNote(outcome.note);
        return;
      }
      // Leave the board first so the transcript is on screen when this frame paints.
      onLaunched();
      onClose();
    } catch (err) {
      // Stay open and say why.
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  // THE STAGE SWITCH. `moveTask` returns the slug the card is in AFTER the attempt; a
  // different slug means the move was refused (the store has already written the sentence
  // to `error`, and the optimistic slice was reverted, so the control re-reads the old Stage).
  const moveStage = async (slug: string): Promise<void> => {
    if (spacePath === null) return;
    setMoveError(null);
    const landed = await moveTask(spacePath, task.id, slug);
    if (landed !== slug) {
      setMoveError(useTasks.getState().error ?? "Could not move this task.");
    }
  };

  // THE HEADER TITLE. Rejects on failure so the header keeps its draft open.
  const saveTitle = async (title: string): Promise<void> => {
    setTitleError(null);
    try {
      await editTask(editSpace, task.id, { title });
    } catch (err) {
      setTitleError(describeIpcError(err));
      throw err;
    }
  };

  // THE SPEC PATH. Rejects on failure so the editor keeps its draft open.
  const saveSpecPath = async (specPath: string | null): Promise<void> => {
    setSpecError(null);
    try {
      await editTask(editSpace, task.id, { specPath });
    } catch (err) {
      setSpecError(describeIpcError(err));
      throw err;
    }
  };

  // THE DESCRIPTION. Never rejects: on failure it keeps the draft and shows the error.
  const saveBody = async (body: string | null): Promise<void> => {
    setBodyError(null);
    try {
      await editTask(editSpace, task.id, { body });
      setBodyDraft(null);
    } catch (err) {
      setBodyError(describeIpcError(err));
    }
  };
  const startBodyEdit = (): void => {
    setBodyError(null);
    setBodyDraft(task.body ?? "");
  };
  const cancelBodyEdit = (): void => {
    setBodyError(null);
    setBodyDraft(null);
  };

  // The Description editor counts only while its textarea is mounted, which is Overview
  // showing. On an artifact tab a held draft is in memory but invisible, so it must not
  // block Escape from closing the modal.
  const bodyEditorMounted = bodyDraft !== null && shownKey === null;

  // Open an artifact tab. A tab whose document is already loaded is not refetched.
  const openTab = (key: string | null): void => {
    setActiveKey(key);
    if (key !== null && !(selectedKey === key && selectedArtifact !== null)) {
      void select(key);
    }
  };

  const noSpace = spacePath === null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className={cn("flex max-h-[85vh] w-full flex-col gap-3 sm:max-w-4xl")}
        onEscapeKeyDown={(e) => {
          // THE BLURRED-DESCRIPTION CASE. The Description editor has no `onBlur`, so a
          // click elsewhere leaves its draft open with the textarea unfocused, and the
          // Escape keydown never reaches the textarea. So cancel the draft HERE, directly.
          // The first Escape cancels; a second one (no editor open) closes the modal.
          if (bodyEditorMounted) {
            e.preventDefault();
            cancelBodyEdit();
            return;
          }
          // Title and spec-path inputs COMMIT on blur, so they can never be open-but-blurred.
          // Keeping the modal open is enough for them.
          if (titleEditing || specEditing) e.preventDefault();
        }}
      >
        <TaskDetailHeader
          number={task.number}
          title={task.title}
          onSaveTitle={saveTitle}
          onEditingChange={setTitleEditing}
          error={titleError}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          {artifactKeys.length > 0 && (
            <div
              ref={tablistRef}
              role="tablist"
              data-testid="detail-tabs"
              onKeyDown={(e) => {
                // WAI-ARIA tabs: Arrow keys move between tabs (wrapping), Home and End jump
                // to the ends. The selection FOLLOWS focus, and focus moves to the new tab.
                const order: (string | null)[] = [null, ...artifactKeys];
                const current = order.indexOf(shownKey);
                let next: number;
                if (e.key === "ArrowRight") next = (current + 1) % order.length;
                else if (e.key === "ArrowLeft")
                  next = (current - 1 + order.length) % order.length;
                else if (e.key === "Home") next = 0;
                else if (e.key === "End") next = order.length - 1;
                else return;
                e.preventDefault();
                const target = order[next]!;
                openTab(target);
                // Focus by POSITION in the tablist, not by building a selector from the key:
                // the tabs render in `order`, so index N is tab N and no key is spliced in.
                const tabs = tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
                tabs?.[next]?.focus();
              }}
              className="flex min-w-0 shrink-0 flex-wrap gap-1 border-b border-border"
            >
              <TabButton
                id={tabDomId(null)}
                panelId={panelDomId}
                dataKey="overview"
                label="Overview"
                active={shownKey === null}
                onClick={() => openTab(null)}
              />
              {artifactKeys.map((key) => (
                <TabButton
                  key={key}
                  id={tabDomId(key)}
                  panelId={panelDomId}
                  dataKey={key}
                  label={key}
                  active={shownKey === key}
                  onClick={() => openTab(key)}
                />
              ))}
            </div>
          )}

          {/* THE ONE SCROLLER. The document AND Properties sit inside it, so there is exactly
              one scroll container in the dialog. Below `md` Properties stacks under the
              document; at `md+` it sits beside it, and if it is taller than the viewport the
              whole body scrolls to reach it. `min-h-0` is load-bearing: a flex item's default
              `min-height: auto` refuses to shrink below its content, so without it the box
              grows past the cap and clips. */}
          <div
            data-testid="detail-scroll"
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto py-3 md:flex-row md:items-start md:gap-4"
          >
            <div
              role="tabpanel"
              id={panelDomId}
              aria-labelledby={activeTabDomId}
              className="flex min-w-0 flex-1 flex-col gap-3"
            >
              {shownKey === null ? (
                <>
                  <TaskDescription
                    body={task.body}
                    draft={bodyDraft}
                    onDraftChange={setBodyDraft}
                    onStartEdit={startBodyEdit}
                    onCancel={cancelBodyEdit}
                    onSave={saveBody}
                    error={bodyError}
                  />
                  {sessions.length > 0 && (
                    <div className="flex shrink-0 flex-col gap-1">
                      <MutedCaption className="shrink-0">Sessions on this task</MutedCaption>
                      {sessions.map((row) => {
                        // THE ONE LABEL RULE, walked: live → history → archived, then
                        // title → first user message → Space folder, the same rule the
                        // sidebar prints. The id is demoted to `title`/`data-session-id`.
                        const storedTitle =
                          sessionFieldOf(lookupSource, row.sessionId, "title") ?? null;
                        const sessionCwd = sessionFieldOf(lookupSource, row.sessionId, "cwd");
                        const spaceName =
                          basenameOfPath(sessionCwd ?? "") ||
                          sessionCwd ||
                          basenameOfPath(spacePath ?? "") ||
                          spacePath ||
                          "";
                        const title = titleFor(
                          sessionMessages[row.sessionId],
                          spaceName,
                          storedTitle,
                        );
                        const status = statusById[row.sessionId] ?? "stored";
                        return (
                          <button
                            key={row.sessionId}
                            type="button"
                            data-testid="task-session-row"
                            data-session-id={row.sessionId}
                            title={row.sessionId}
                            onClick={() => onOpenSession(row.sessionId)}
                            className="flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                          >
                            <SessionStatusMark
                              status={status}
                              size={16}
                              dotSize={8}
                              testId="session-status-mark"
                            />
                            <span className="min-w-0 flex-1 truncate">{title}</span>
                            {row.stageSlug !== null && (
                              <MutedCaption className="shrink-0">
                                from {stageLabelOf(row.stageSlug)}
                              </MutedCaption>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <TaskArtifactTabPane
                  artifactKey={shownKey}
                  artifact={selectedKey === shownKey ? selectedArtifact : null}
                  artifactError={selectedKey === shownKey ? artifactError : null}
                />
              )}
            </div>

            <TaskDetailProperties
              task={task}
              columns={columns}
              stageDisabled={spacePath === null}
              status={rollup}
              ready={ready}
              sessionCount={sessions.length}
              costUsd={costUsd}
              onMoveStage={moveStage}
              onSaveSpecPath={saveSpecPath}
              onEditingChange={setSpecEditing}
              moveError={moveError}
              moveNote={boostNote}
              specError={specError}
            />
          </div>
        </div>

        {/* A WARNING, not a failure. Outside `detail-scroll`, directly above the footer. Not
            an `IpcErrorLine`: that is `role="alert"`, and a successful launch is not an alert. */}
        {(note !== null || error !== null) && (
          <div className="flex shrink-0 flex-col gap-1">
            {note !== null && (
              <div
                className="shrink-0 text-ui-sm text-warning"
                data-testid="launch-note"
                role="status"
              >
                {note}
              </div>
            )}
            <IpcErrorLine error={error} className="shrink-0" />
          </div>
        )}

        <DialogFooter className="shrink-0 gap-2">
          {/* ONE BUTTON PER OUTGOING EDGE. The first is the Primary next step; the rest are
              outline. Each is disabled while busy, when the Space is absent, or when its own
              destination's skill is not in the catalog. */}
          {edges.map((dest, index) => {
            const disabled =
              noSpace ||
              busy ||
              (dest.onEnterSkill !== null &&
                !skills.some((sk) => sk.name === dest.onEnterSkill));
            return (
              <Button
                key={dest.slug}
                type="button"
                variant={index === 0 ? "default" : "outline"}
                onClick={() => void launch(dest.slug)}
                disabled={disabled}
                aria-label={dest.label}
                title={
                  disabled
                    ? dest.onEnterSkill !== null
                      ? `This Space has no \`${dest.onEnterSkill}\` skill`
                      : dest.label
                    : `Open a session that works on ${dest.label}`
                }
              >
                {dest.label}
              </Button>
            );
          })}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One tab in the Document-First strip. Visible text and a `title`, never an `aria-label`,
 *  so the footer's `aria-label` census still lists exactly the launch buttons.
 *
 *  WAI-ARIA: `id` names the tab so the panel's `aria-labelledby` can point at it, and
 *  `aria-controls` names the one panel. Only the SELECTED tab is in the Tab order
 *  (`tabIndex` 0); the rest are `-1`, reached with the arrow keys on the tablist. */
function TabButton({
  id,
  panelId,
  dataKey,
  label,
  active,
  onClick,
}: {
  id: string;
  panelId: string;
  dataKey: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      data-testid="detail-tab"
      data-tab-key={dataKey}
      title={label}
      onClick={onClick}
      className={cn(
        "-mb-px min-w-0 max-w-[14rem] cursor-pointer truncate border-b-2 px-3 py-1.5 text-ui-sm",
        active
          ? "border-brand text-foreground"
          : "border-transparent text-foreground-subtle hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
