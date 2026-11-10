import { useMemo, useState } from "react";
import { MessageSquareIcon, SearchIcon } from "lucide-react";
import { Button } from "./ui/button";
import { EmptyListLine } from "./EmptyListLine";
import { IpcErrorLine } from "./IpcErrorLine";
import { MutedCaption } from "./MutedCaption";
import { moneyOf } from "./SessionCostLine";
import { cn } from "./lib/utils";
import { relativeTimeFromInstant } from "../lib/sessionTime";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { launchTaskSession } from "../store/taskLaunch";
import { useTasks } from "../store/tasks";
import { describeIpcError } from "../lib/ipcError";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import type { TaskRow, TaskSessionRow } from "../lib/tauri";

/**
 * The **Task detail** modal — what a card opens when it is clicked.
 *
 * ## Why this surface exists
 *
 * The card is a two-line summary by construction: `line-clamp-2` on the title and
 * two more on the body, a chip that says "2 sessions" instead of listing them, and a
 * spec path deliberately hidden because an absolute path on every card is noise. All
 * of those are correct ON a card and all of them hide information. This modal is
 * where that information goes, and the two buttons that the card has no room for.
 *
 * ## Two buttons, and the one thing that differs between them
 *
 * **Discuss** loads the `discuss` skill; **Research** loads `research` AND moves the
 * card to the Research column. Everything else — start a Session linked to the card,
 * select it, send one first message with the `<task>` block last — is identical and
 * lives in `store/taskLaunch`, which owns the ORDERING rules (move before start, for
 * the reason its header gives). This component decides which MODE a click means and
 * what to paint; it does not implement launching.
 *
 * There is NO third button. Backlog belongs to the create modal: this card already
 * exists and already lives in a column, so a "Backlog" button here would be a move
 * wearing a create's clothes.
 *
 * ## `onLaunched` is what makes the feature visible
 *
 * The launch selects the new Session in the store, but the board VIEW covers the
 * chat column — `App`'s `"board"` arm renders this board in place of `ChatStream`.
 * Without this callback the click starts a real Session and the user sees nothing at
 * all. That is the same defect the card's sessions chip had (issue #177 found it),
 * and it is why the prop is REQUIRED rather than optional: an optional "leave the
 * board" is a launch that silently does nothing visible, which is this repo's
 * documented silent-green shape.
 *
 * ## It closes on success and stays on failure
 *
 * A launched Session is the surface the user wanted, so the modal gets out of the
 * way. A failed launch keeps the modal up with its error line — closing would discard
 * both the card being read and the reason the click failed.
 *
 * ## The catalogs come from the existing hook, not a new fetch
 *
 * `useMentionCatalogs` is module-cached per Space and is already mounted by the board
 * surface, so this read shares that fetch rather than issuing a second one. The
 * catalog is not decoration: `store/taskLaunch` REFUSES a launch whose skill the
 * Space does not have, because `expandMentions` leaves an unmatched token verbatim
 * and the model would read a literal `$discuss` as a skill call.
 */
export interface TaskDetailDialogProps {
  /** The card, whole. The modal reads every field — the board's slice already
   *  carries them, so no `getTask` fetch is issued for a card that is on screen. */
  task: TaskRow;
  /** The card's linked Sessions, OLDEST FIRST (what `get_board` publishes). The
   *  order is rendered as given: the card's chip opens the LAST entry, and if this
   *  list were re-sorted here the two surfaces would disagree about "this card's
   *  Session". */
  sessions: TaskSessionRow[];
  /** Summed cost of those Sessions, computed in Rust. `null` is "never reported" and
   *  renders NOTHING, `0` is "a real zero" and renders `$0.00` — ADR 0082, owned by
   *  `moneyOf` and imported rather than re-spelled. */
  costUsd: number | null;
  /** The Space whose board is showing, and the cwd a launched Session starts in.
   *  `null` disables both buttons: `startTaskSession(null, …)` is not a thing. */
  spacePath: string | null;
  onClose: () => void;
  /** Opens a Session — the board forwards `useSessions.getState().openSession`. */
  onOpenSession: (sessionId: string) => void;
  /** Leave the board view: a Session is now open and the chat column is behind this
   *  board. REQUIRED — see the module note. */
  onLaunched: () => void;
}

export default function TaskDetailDialog({
  task,
  sessions,
  costUsd,
  spacePath,
  onClose,
  onOpenSession,
  onLaunched,
}: TaskDetailDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The launch's WARNING (the skipped-column case), kept SEPARATE from `error`
  // because it is not one: the Session started. `TasksBoard`'s boost note is the
  // precedent — a `role="status"` line beside a `role="alert"` line, so a successful
  // action is never announced as a failure.
  const [note, setNote] = useState<string | null>(null);

  // `mcpServers` is dropped here and `store/taskLaunch` passes an EMPTY list: this
  // message carries no `[image #3]` marker, and the `#` prefix is the one the
  // workspace's send path has to mask for that reason. Reading only skills and
  // agents keeps the precondition out of the modal too.
  const { skills, agents } = useMentionCatalogs(spacePath);
  const catalogs = useMemo(() => ({ skills, agents }), [skills, agents]);

  // THE COLUMN LABEL COMES FROM THE STORE, not from a `boards` prop. The first draft
  // took the columns as a prop because `TasksBoard` already had them — and that put
  // TWO owners on one fact, because `store/taskLaunch` reads the SAME columns out of
  // the same store to decide whether a Research move is legal. The two can disagree
  // (a modal rendered from a stale prop would print `Research` while the orchestrator
  // refused the move for want of a `research` column), and this repo's own defect
  // log is a list of surfaces that disagreed with the write beneath them. One read,
  // one source.
  //
  // A slice that no longer holds the card's column prints the SLUG rather than
  // nothing: "we could not name it" is a different claim from "it has no column".
  const columns = useTasks(
    (state) => (spacePath ? state.boardsBySpace[spacePath] : undefined),
  );
  const stageLabel =
    columns?.find((c) => c.stage.slug === task.stageSlug)?.stage.label ??
    task.stageSlug;
  const money = moneyOf(costUsd);

  const launch = async (mode: "discuss" | "research"): Promise<void> => {
    if (spacePath === null) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const outcome = await launchTaskSession(spacePath, task, mode, catalogs);
      if (outcome.note !== null) {
        // THE NOTE WINS OVER THE NAVIGATION. The Session did start — this is a
        // warning, not a failure — but the thing the user clicked for (the card
        // moving to Research) did not happen, and a note about a CARD belongs on the
        // surface showing the card. Navigating to the new transcript would bury the
        // only sentence explaining why the column did not change, which is this
        // repo's silent-green shape arriving through a `setTimeout`-free code path.
        //
        // It is not a dead end: the Session list is hoisted above `App`'s view
        // ternary (ADR 0094), so the new Session's row is already on screen beside
        // this dialog and is one click from the transcript.
        setNote(outcome.note);
        return;
      }
      // Leave the board FIRST so the transcript is already the thing on screen when
      // this frame paints, then close.
      onLaunched();
      onClose();
    } catch (err) {
      // Stay open, say why. A dialog that closes on failure takes the error line and
      // the card with it.
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  // EACH BUTTON IS GATED ON THE SKILL IT NEEDS, and not merely on there being a
  // catalog. The reasoning is a race found while wiring the board: the catalog is an
  // async fetch that starts EMPTY, so a button enabled from the first paint is
  // clickable before the catalog lands, and that first click fails with "This Space
  // has no `discuss` skill" — a sentence that is FALSE two frames later. Gating on the
  // same predicate `store/taskLaunch` refuses on removes the race rather than
  // narrowing it: the button is enabled exactly when the launch would succeed, and the
  // orchestrator's refusal stays as the backstop for a launch started from anywhere
  // else (a future keyboard chord, a codemode script).
  //
  // The cost is one disabled frame on every open, which is the correct trade: the
  // alternative is a click that lies.
  const noSpace = spacePath === null;
  const discussReady = skills.some((sk) => sk.name === "discuss");
  const researchReady = skills.some((sk) => sk.name === "research");
  const discussDisabled = noSpace || busy || !discussReady;
  const researchDisabled = noSpace || busy || !researchReady;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          {/* `T{n}` in the heading, because a person says the number out loud and two
              open dialogs must be distinguishable. The `tsk_` id never appears as
              visible text anywhere in this app (ADR 0090: the number is the label,
              the id is the key). */}
          <DialogTitle className="flex items-baseline gap-2">
            <span className="font-mono text-ui-sm text-foreground-subtle">
              T{task.number}
            </span>
            <span className="min-w-0">{task.title}</span>
          </DialogTitle>
          <DialogDescription>
            Stage <span className="font-medium">{stageLabel}</span>
            {" · "}
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
            {/* ADR 0082 through the ONE rule: `null` prints NOTHING rather than
                inventing `$0.00` for a cost nobody measured. Its OWN element so the
                figure is one addressable node rather than half of a concatenated
                sentence — the same reason `SessionCostLine` keeps it separate. */}
            {money !== null && <> · {money}</>}
            {" · "}
            updated {relativeTimeFromInstant(task.updatedAt)}
          </DialogDescription>
        </DialogHeader>

        {/* The body, UNCLAMPED. This is the field the card clips, so clipping it here
            would put the card's limitation in the surface that exists to remove it. */}
        {task.body !== null && (
          <p className="min-h-0 shrink-0 whitespace-pre-wrap text-ui-base text-foreground-subtle">
            {task.body}
          </p>
        )}

        {task.specPath !== null && (
          <MetaRow label="spec">{task.specPath}</MetaRow>
        )}
        {/* The id, in the one place it is useful: a card being discussed across two
            windows is named by its id, not by a per-Space number that repeats. It is
            quiet and it is selectable. */}
        <MetaRow label="id">{task.id}</MetaRow>

        {sessions.length > 0 && (
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
            <MutedCaption className="shrink-0">
              Sessions on this task
            </MutedCaption>
            {sessions.map((row) => (
              // A real `<button>` and NOT a `RowButton`: this dialog is inside a Radix
              // `Dialog`, and `RowButton`'s ONE-`role="button"`-per-row constraint
              // exists for the sidebar's `.closest('[role="button"]')` reads. A plain
              // button needs no role spelled and adds no selector match — the same
              // reasoning the card's chip records.
              <button
                key={row.sessionId}
                type="button"
                data-testid="task-session-row"
                data-session-id={row.sessionId}
                onClick={() => onOpenSession(row.sessionId)}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-ui-xs">
                  {row.sessionId}
                </span>
                {/* `MutedCaption` rather than the hand-spelled pair: the census in
                    `mutedCaption.test.ts` keeps that class pair to ONE file, and this
                    is exactly that caption — a quiet qualifier beside a bolder value. */}
                {row.stageSlug !== null && (
                  <MutedCaption className="shrink-0">
                    from {row.stageSlug}
                  </MutedCaption>
                )}
              </button>
            ))}
          </div>
        )}

        {/* A WARNING, not a failure — the Session started, the card did not move. NOT
            an `IpcErrorLine`: that component's whole contract is `role="alert"`, and
            announcing a successful launch as an alert is the mislabel `TasksBoard`'s
            boost note documents for the same reason. */}
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

        {sessions.length === 0 && task.body === null && (
          <EmptyListLine>This task has no detail yet.</EmptyListLine>
        )}

        <DialogFooter className="gap-2">
          {/* Both are `variant="default"` rather than one primary and one ghost: they
              are two ways to work the same card and neither is the safe default — the
              difference (does the card move) is exactly the difference a user should
              read as deliberate. */}
          <Button
            type="button"
            variant="outline"
            onClick={() => void launch("discuss")}
            disabled={discussDisabled}
            aria-label="Discuss"
            title={
              discussReady
                ? "Open a session that discusses this task"
                : "This Space has no `discuss` skill"
            }
          >
            <MessageSquareIcon />
            Discuss
          </Button>
          <Button
            type="button"
            onClick={() => void launch("research")}
            disabled={researchDisabled}
            aria-label="Research"
            title={
              researchReady
                ? "Open a session that researches this task, and move it to the Research column"
                : "This Space has no `research` skill"
            }
          >
            <SearchIcon />
            Research
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One quiet `label: value` line, for the fields that are data and not prose.
 *
 * `MutedCaption` owns the caption class pair (its own test censuses that pair to one
 * file), so the LABEL goes through it and the value wears the ink one step up. */
function MetaRow({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex min-w-0 shrink-0 items-baseline gap-2">
      <MutedCaption className="shrink-0">{label}</MutedCaption>
      <span className="min-w-0 break-all font-mono text-ui-xs text-foreground-subtle">
        {children}
      </span>
    </div>
  );
}
