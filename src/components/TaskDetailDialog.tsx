import { useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { AgentMarkdown } from "./AgentMarkdown";
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
import type { Artifact, TaskRow, TaskSessionRow } from "../lib/tauri";

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
 * all. That is the same defect the card's sessions chip had (PR #178 found it),
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
  /** The artifact KEYS on the card being read (issue #180, spec §3) — T4's
   *  `TaskCardView.artifactKeys`, threaded by the board.
   *
   *  REQUIRED, on the same argument that made `sessions` and `costUsd` required: an
   *  optional prop compiles against every fixture and then renders NO artifact
   *  section when real data arrives — this repo's silent-green shape. The board
   *  always holds the field (REQUIRED on `TaskCardView`), so omitting it is a caller
   *  that forgot, which is a type error and not a runtime case.
   *
   *  KEYS ONLY, never content. The board read carries names because it runs for
   *  every card on every mount; the document is fetched for the ONE key the human
   *  selects (`getArtifact`), which is the split ADR 0100 exists to make cheap.
   *  NOT read off `task` — `TaskRow` has no such field by design. */
  artifactKeys: string[];
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
  artifactKeys,
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

  // THE ARTIFACT READER's state (issue #180, spec §3). `selectedKey === null` means
  // nothing is chosen: a card WITH keys does not auto-open one, because the board
  // read carries names only and fetching a document nobody asked for is exactly the
  // wire cost the keys-only payload exists to avoid.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  // Its OWN error cell, not the launch `error` above: the two failures are about
  // different things (a document that would not load vs. a Session that would not
  // start) and one cell would let a stale launch sentence sit under an artifact
  // read, or a reader failure claim the launch failed.
  const [artifactError, setArtifactError] = useState<string | null>(null);

  // The store's action (T3), read through `useTasks` and never as a bare command
  // import — ADR 0074, which `tauriBoundary.test.ts` / `tauriBarrel.test.ts` enforce.
  const getArtifact = useTasks((state) => state.getArtifact);

  // WHICH key the one in-flight read belongs to. A ref and not state: nothing
  // renders it, and it has to be readable by a resolution that lands AFTER the
  // reader has moved on to another key — a `useState` value read inside the `await`
  // below is the value this closure captured, which is exactly the stale answer.
  const requestKey = useRef<string | null>(null);

  const selectArtifact = async (key: string): Promise<void> => {
    requestKey.current = key;
    setSelectedKey(key);
    // CLEARED BEFORE the fetch, so a previous document cannot paint under a new key
    // while the new read is still in flight. This is one of TWO locks: it covers the
    // in-flight gap, and the identity check after the `await` covers the answer that
    // arrives after the reader moved on (which no clear can catch).
    setSelectedArtifact(null);
    setArtifactError(null);
    try {
      const artifact = await getArtifact(task.id, key);
      // DROPPED, not rendered, when the reader has moved on: two reads can be in
      // flight and the older one can answer LAST (a big spec over a slow IPC beats a
      // small one), and painting it would show one key's document under another —
      // a document lying about which key it is. Blanking the reader would be the
      // other wrong answer, so the late resolution changes NOTHING.
      if (requestKey.current !== key) return;
      // `null` is an ANSWER (no such artifact, or no such Task — the `getTask`
      // shape) and renders no document rather than an error sentence.
      setSelectedArtifact(artifact);
    } catch (err) {
      // Same rule for the failure: a read the reader no longer asked for must not
      // write an error sentence into the current view.
      if (requestKey.current !== key) return;
      // A rejection is the store RETHROWING (it captures to `error` AND rethrows, so
      // a caller can tell "failed" from "answered `null`").
      setArtifactError(describeIpcError(err));
    }
  };

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

  // THE OUTGOING EDGES, i.e. the buttons. Read from the SAME slice `stageLabel` came
  // from — one read, one source, for the reason that block already records: a modal
  // that painted buttons from a prop while the orchestrator read the store would be
  // two answers to "where can this card go", and the failure it prevents is a button
  // that the click beneath it refuses.
  //
  // `next_slugs` is the graph (ADR 0099) and is rendered IN ITS OWN ORDER — the row's
  // author decided that order, so it is not re-sorted here.
  //
  // NULL means UNCONFIGURED, which is NOT the same answer as the empty array: null
  // falls back to the column at `sortOrder + 1` so an existing install keeps its
  // launch button after the upgrade (the migration backfills, but a Space that has
  // never been read has no rows to backfill), while `[]` is "configured, leads
  // nowhere" and renders nothing. Collapsing the two would silently remove a working
  // button from every unconfigured board.
  //
  // An edge whose slug is no longer a column is KEPT and labelled with the SLUG, on
  // the same argument `stageLabel` above carries: "we could not name it" is a
  // different claim from "it has no column", and a destination the graph names but the
  // slice cannot resolve is exactly that case. It is also what keeps
  // `store/taskLaunch`'s skipped-column note REACHABLE from this surface — the click
  // starts the Session it was asked for, skips the move it could not perform, and the
  // note says so. Dropping the edge instead would delete a working button on a stale
  // read and leave the note block below with no path to the user at all.
  const edges = useMemo(() => {
    const current = columns?.find((c) => c.stage.slug === task.stageSlug);
    if (!current) return [];
    const slugs =
      current.stage.nextSlugs ??
      (columns ?? [])
        .filter((c) => c.stage.sortOrder === current.stage.sortOrder + 1)
        .map((c) => c.stage.slug);
    return slugs.map((slug) => {
      const stage = columns?.find((c) => c.stage.slug === slug)?.stage;
      return {
        slug,
        label: stage?.label ?? slug,
        // An unresolvable row contributes NO Skill — we never invent one for a row we
        // cannot read, which also means such a button is not gated and cannot fail.
        onEnterSkill: stage?.onEnterSkill ?? null,
      };
    });
  }, [columns, task.stageSlug]);

  const launch = async (toStageSlug: string): Promise<void> => {
    if (spacePath === null) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const outcome = await launchTaskSession(
        spacePath,
        task,
        toStageSlug,
        catalogs,
      );
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

  // EACH BUTTON IS GATED ON THE SKILL ITS OWN DESTINATION NEEDS — see the footer,
  // where that gate is spelled once per edge. What used to live here was a
  // `discussReady` / `researchReady` pair, i.e. two skill names hardcoded in the
  // component beside the two buttons that consumed them; both are gone, and the
  // catalog race they existed for is documented at the predicate that replaced them.
  const noSpace = spacePath === null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-3 sm:max-w-2xl">
        <DialogHeader className="shrink-0">
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

        {/* THE SCROLLER. Everything between the header and the footer sits inside it.

            The shell is capped at `max-h-[80vh]` and every child carried `shrink-0`,
            so a long body did not compress the dialog — it CLIPPED it, and the element
            that fell off the bottom was the footer: the launch buttons, i.e. the only
            reason to open the modal. A modal whose whole job is to show the card the
            card view truncates cannot be allowed to truncate it in turn.

            `min-h-0` is load-bearing and easy to drop: a flex item's initial
            `min-height` is `auto`, which refuses to shrink below its content, so
            `flex-1` + `overflow-y-auto` alone still grows the box past the cap and
            clips exactly as before. `flex-1` takes the leftover height, `overflow-y-auto`
            turns the overflow into scrolling instead of a cut-off edge.

            The header and the footer stay OUTSIDE on purpose: a squeezed header
            ellipsises the title, and a footer inside the scroller means the buttons are
            only reachable by scrolling past a 5000-character body — the same loss with a
            scrollbar attached.

            `gap-3` repeats the shell's own gap because these nodes are no longer direct
            children of `DialogContent`. */}
        <div
          data-testid="detail-scroll"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto"
        >
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

        {/* THE ARTIFACT READER (issue #180, spec §3): the key list, and the selected
            key's markdown rendered as a DOCUMENT.

            A Task artifact is markdown, so it goes through `AgentMarkdown` — the
            component extracted from the transcript for exactly this. Rendering it as
            `whitespace-pre-wrap` prose (which `task.body` above wears, correctly: the
            body is a blurby sentence, not a document) would put the card's limitation
            in the one surface built to remove it: no headings, no lists, no tables,
            no links.

            The KEYS came from the board read; the CONTENT is fetched for the ONE key
            the human selects (spec §1's split — the board read runs for every card on
            every mount, so a document on that payload would be every Task's every
            document on the wire). Nothing is fetched on open.

            Gated on `artifactKeys.length > 0`, and the WHOLE section sits behind it —
            no header, no list, no reader, no placeholder for a Task with no artifacts.
            A `Vec<String>` answers `[]` for that card, so this is the common shape of
            real data and it must read as nothing at all.

            A real `<button type="button">` per key and NOT a `RowButton`: this dialog
            is inside a Radix `Dialog`, so `RowButton`'s one-`role="button"`-per-row
            rule does not apply here, but the plain-button convention matches the
            sessions rows directly below and keeps the row resolvable. */}
        {artifactKeys.length > 0 && (
          <div className="flex min-h-0 flex-col gap-1">
            <MutedCaption className="shrink-0">Artifacts</MutedCaption>
            {artifactKeys.map((key) => (
              <button
                key={key}
                type="button"
                data-testid="artifact-key"
                data-artifact-key={key}
                // Which key the reader is showing — the list gives no other answer to
                // "which one am I looking at". An attribute, not a second element.
                aria-current={selectedKey === key || undefined}
                onClick={() => void selectArtifact(key)}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                  selectedKey === key && "bg-surface-hover text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-ui-xs">
                  {key}
                </span>
              </button>
            ))}
            {selectedArtifact !== null && (
              // A READER, not the dialog's own scroll: bounded and independently
              // scrollable, so a long spec does not push the launch buttons off the
              // bottom of a modal that is already capped at 80vh.
              <div
                data-testid="artifact-body"
                className="max-h-72 min-h-0 shrink-0 overflow-y-auto rounded-lg border border-border px-3 py-2"
              >
                <AgentMarkdown text={selectedArtifact.markdown} />
              </div>
            )}
            <IpcErrorLine error={artifactError} className="shrink-0" />
          </div>
        )}

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

        {sessions.length === 0 && task.body === null && artifactKeys.length === 0 && (
          <EmptyListLine>This task has no detail yet.</EmptyListLine>
        )}
        </div>
        {/* /detail-scroll — everything below this line (the footer) stays pinned. */}

        <DialogFooter className="shrink-0 gap-2">
          {/* ONE BUTTON PER OUTGOING EDGE (issue #179, spec §7.2). The pair that used
              to sit here — `discussReady` / `researchReady` and two hardcoded buttons —
              was the component asserting what the Stage rows assert, which is the split
              ADR 0098 exists to remove. The edges come from the SAME slice the stage
              label above is read from, so a Space that renames, reorders or rewires its
              columns changes these buttons with no code touched. With no outgoing edge
              the footer renders NOTHING: a last column offers no launch, and an empty
              footer beats a disabled button that can never be made to work.

              `variant="outline"` for all of them, keeping the pre-#179 choice and
              extending it: none of these is the safe default over the others, so none
              gets the filled treatment. */}
          {edges.map((dest) => {
            // EACH BUTTON IS GATED ON THE SKILL ITS OWN DESTINATION NEEDS, and not
            // merely on there being a catalog. The reasoning is the race this file
            // already documented: the catalog is an async fetch that starts EMPTY, so a
            // button enabled from the first paint is clickable before the catalog lands,
            // and that first click fails with "This Space has no `x` skill" — a sentence
            // that is FALSE two frames later. Gating on the same predicate
            // `store/taskLaunch` refuses on removes the race rather than narrowing it.
            //
            // A destination with NO Skill is NOT gated and never disabled: it has
            // nothing to wait for, so a gate here would disable a launch that cannot
            // fail. Moving a card is still useful with nothing to load.
            const disabled =
              noSpace ||
              busy ||
              (dest.onEnterSkill !== null &&
                !skills.some((sk) => sk.name === dest.onEnterSkill));
            return (
              <Button
                key={dest.slug}
                type="button"
                variant="outline"
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
