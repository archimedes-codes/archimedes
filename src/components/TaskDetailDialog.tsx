import { useMemo, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "./ui/button";
import { AgentMarkdown } from "./AgentMarkdown";
import { EmptyListLine } from "./EmptyListLine";
import { IpcErrorLine } from "./IpcErrorLine";
import { MutedCaption } from "./MutedCaption";
import { SessionStatusMark } from "./SessionStatusMark";
import { moneyOf } from "./SessionCostLine";
import { cn } from "./lib/utils";
import { relativeTimeFromInstant } from "../lib/sessionTime";
import { sessionFieldOf } from "../lib/sessionLookup";
import { titleFor } from "../lib/sessionTitle";
import { basenameOfPath } from "../lib/paths";
import { fileIconFor } from "../lib/fileIcons";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { useSessionStatuses } from "../hooks/useSessionStatus";
import { launchTaskSession } from "../store/taskLaunch";
import { useSessions } from "../store/sessions";
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
/** Every **Task artifact** is markdown (ADR 0100), so the key row's leading glyph is
 *  the `fileIconFor("x.md")` descriptor — the SAME `FileTextIcon` in `text-file-md`
 *  that the transcript's `FileChip` draws for a `.md` fence. Resolved ONCE at module
 *  scope: the extension-table lookup is constant, so a per-row call would re-derive
 *  the same answer for every key on the rail.
 *
 *  The glyph is what makes "has a leading icon" mean "clickable" in this dialog — the
 *  read-only `id` / `spec` rows deliberately carry none (see `MetaRow`). */
const ARTIFACT_SPEC = fileIconFor("x.md");
const ArtifactGlyph = ARTIFACT_SPEC.icon;

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

  // THE SAME SLICE THE HEADER READS. A session's `stageSlug` is what the wire carries;
  // printing it here while the header three lines above says "Stage Backlog" would put
  // two answers to one question in one modal — and this dialog is the surface that
  // already resolved the label, so the fix costs one lookup and no new read. Falls back
  // to the SLUG, on the same argument `stageLabel` carries: "we could not name it" is a
  // different claim from "it has no Stage". Both read `columns`, which is what guarantees
  // they agree rather than two rules that happen to match today.
  const stageLabelOf = (slug: string): string =>
    columns?.find((c) => c.stage.slug === slug)?.stage.label ?? slug;
  const money = moneyOf(costUsd);

  // THE SESSION ROWS' LABELS. The four slices `titleFor` / `sessionFieldOf` walk.
  // Each selector returns the store's OWN reference (never a fresh object literal),
  // which is the zustand v5 rule `lib/sessionLookup.ts` records: a selector yielding
  // a fresh object re-runs forever — a symptom that HANGS the suite rather than
  // failing it.
  //
  // `messages` is ONE selector for the whole map, not one per row: the rows are
  // rendered by `sessions.map(...)` below, so a per-id selector would be a hook call
  // inside a loop. The cost is that this dialog re-renders when any transcript
  // appends — accepted, and bounded: it is mounted only while a card is open, and
  // `titleFor` reads the FIRST user message, which never changes once it exists. The
  // alternative (a `useSessionTitles`-style batch hook) does not exist in this tree
  // and inventing one is a `src/hooks/` change this task does not own.
  const liveSessions = useSessions((s) => s.sessions);
  const historySessions = useSessions((s) => s.historySessions);
  const archivedSessions = useSessions((s) => s.archivedSessions);
  const sessionMessages = useSessions((s) => s.messages);

  // ONE call for the whole list, never one per row: a hook cannot be called inside the
  // `sessions.map(...)` below at a changing list length — the reason the pure
  // `sessionStatusOf` and this batch projection exist as a pair. `useSessionStatuses`
  // subscribes to `sessions` / `inTurn` / `prompts` / `requests` / `subagents.entries`
  // ONCE and applies the rule per id, so the dialog's marks are derived by the SAME
  // rule the sidebar row and the Space tab draw.
  const statusById = useSessionStatuses(sessions.map((row) => row.sessionId));

  // The three-list walk takes one source object. Built in the render body (NOT inside
  // a selector), so it is not a zustand return value and its freshness costs nothing.
  const lookupSource = {
    sessions: liveSessions,
    historySessions,
    archivedSessions,
  };

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
      <DialogContent
        className={cn(
          "flex max-h-[80vh] w-full flex-col gap-3",
          // THE WIDTH IS DECIDED AT OPEN, never on selection. `artifactKeys` arrive
          // with the card on the board read, so an artifact-bearing card opens wide and
          // an artifact-less one opens exactly as it does today — the common case is
          // untouched, and no dialog ever resizes itself under the cursor.
          //
          // The `sm:` form is required: the base `DialogContent` declares `sm:max-w-md`,
          // and a bare `max-w-*` lands in a different tailwind-merge group and loses to
          // it in the generated stylesheet. Composed through `cn()` rather than a bare
          // ternary, which is what `classNameConvention.test.ts` scans for.
          artifactKeys.length > 0 ? "sm:max-w-4xl" : "sm:max-w-2xl",
        )}
      >
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
        {/* The body, UNCLAMPED and rendered as MARKDOWN (spec §1). This is the field
            the card clips, so clipping it here would put the card's limitation in the
            surface that exists to remove it — and printing it as inert pre-formatted
            prose clipped it a second way: no headings, no lists, no tables, and a
            link a person wrote was text, not a control.

            `AgentMarkdown` is the transcript's renderer, so the URL policy
            (`safeUrlTransform`, ADR 0051) and the External-open routing
            (`OpenAnchor`) stay in ONE place rather than being re-spelled per surface.

            The wrapper keeps the `<p>`'s old classes so the body's INK is unchanged:
            `AgentMarkdown`'s root sets `text-ui-base` and no colour, so
            `text-foreground-subtle` cascades from here. The old pre-formatted
            whitespace class is deliberately GONE — with it a markdown document renders
            its own source newlines as gaps between every block. ADR 0101 accepted the
            cost that a single newline collapses to a space; `remark-breaks` was
            considered and rejected, and a body that wants line breaks uses a list. */}
        {task.body !== null && (
          <div
            data-testid="task-body"
            className="min-h-0 shrink-0 text-ui-base text-foreground-subtle"
          >
            <AgentMarkdown text={task.body} />
          </div>
        )}

        {/* THE ARTIFACT REGION (issue #180, spec §3): the key rail, and the selected
            key's markdown rendered as a DOCUMENT beside it.

            A Task artifact is markdown, so it goes through `AgentMarkdown` — the
            component extracted from the transcript for exactly this. Rendering it as
            inert pre-formatted prose (the shape `task.body` used to wear, and which
            this change moves the body off as well) would put the card's limitation
            in the one surface built to remove it: no headings, no lists, no tables,
            no links.

            The KEYS came from the board read; the CONTENT is fetched for the ONE key
            the human selects (spec §1's split — the board read runs for every card on
            every mount, so a document on that payload would be every Task's every
            document on the wire). Nothing is fetched on open.

            Gated on `artifactKeys.length > 0`, and the WHOLE section sits behind it —
            no header, no rail, no pane, no placeholder for a Task with no artifacts.
            A `Vec<String>` answers `[]` for that card, so this is the common shape of
            real data and it must read as nothing at all.

            A real `<button type="button">` per key and NOT a `RowButton`: this dialog
            is inside a Radix `Dialog`, so `RowButton`'s one-`role="button"`-per-row
            rule does not apply here, but the plain-button convention matches the
            sessions rows below and keeps the row resolvable. */}
        {artifactKeys.length > 0 && (
          // `shrink-0` and NO `min-h-0` — the opposite of the rule that governs the
          // SCROLLER, and the direction people get backwards. `detail-scroll` is a
          // definite-height column flex box, so a section holding `min-h-0` and the
          // default `flex-shrink: 1` is COMPRESSED the moment the unbounded pane below
          // is tall; and a compressed element with `overflow: visible` neither scrolls
          // nor grows the scroller — it PAINTS OVER the Sessions and Meta rows under
          // it, which is a worse failure than the one this region fixes. #181's clip
          // was a missing `min-h-0` on the SCROLLER, never a missing `shrink-0` on a
          // child. So the pane stays unbounded (its height IS its content's height) and
          // the section that contains it refuses to compress.
          <div
            data-testid="artifact-section"
            className="flex shrink-0 flex-col gap-1"
          >
            <MutedCaption className="shrink-0">Artifacts</MutedCaption>
            {/* TWO COLUMNS above the dialog's breakpoint, ONE STACK below it, inside the
                ONE scroller.

                The rail is `sm:sticky sm:top-0 self-start` so it survives scrolling a
                long document; `self-start` is what stops it stretching to the row's full
                height, because a stretched sticky element has nowhere to stick.

                WHY IT STACKS: `w-44` + `shrink-0` was an unconditional 176px, and the
                app declares NO minimum window width (`tauri.conf.json`'s window block
                has no `minWidth`), so a squeezed window is reachable, not hypothetical.
                At a 400px viewport the dialog runs `max-w-[calc(100%-2rem)]` = 368px and
                32px of `p-4` + 176px of rail + 8px of `gap-2` + the pane's own `px-3`
                left ~126px for DOCUMENT TEXT — headings, list indents and code columns
                crushed into a gutter, with tables scrolling sideways. So below the
                breakpoint the rail takes the row's full width and the document gets all
                of it. Both arms reach CSS because they are DIFFERENT variants — `w-full`
                is unconditional and `sm:w-44` lives inside a `min-width: 40rem` media
                query that Tailwind emits after the base utilities, so the wide arm wins
                above 640px and the narrow arm below it. (Verified against `twMerge` too,
                even though this `className` is a plain literal and no `cn()` is involved:
                the modifier puts the two in different groups, so a future caller passing
                this through `cn()` could not silently drop one — the trap `ui/dialog.tsx`
                records for a bare `max-w-*` losing to `sm:max-w-md`.)

                `sticky` moves to the `sm:` arm with the width rather than staying
                unconditional, because stickiness is a property OF THE TWO-COLUMN LAYOUT:
                a stuck element is PAINTED over whatever sits at its stuck position, so a
                sticky rail stacked ABOVE a document would cover the document's first
                lines for the whole scroll.

                CROSS-AXIS ALIGNMENT FLIPS AXES when a row becomes a column, so both
                alignment tokens are conditional. Above the breakpoint `items-start` on
                the row + `self-start` on the rail stop the rail stretching to the row's
                height — and a stretched sticky element has nowhere to stick, so without
                them `sticky` does nothing. Below it, that same `items-start` would
                shrink-wrap the DOCUMENT to its content width, crushing the measure the
                same way the fixed rail did and hiding the pane's own border; so the
                narrow arm asks for `items-stretch` (the CSS default, spelled out so the
                pin can see it) and only the wide arm asks for `items-start`. The rail's
                `self-start` is safe unconditionally — it beats the row's stretch, and a
                full-width rail is 100% of the row either way. `shrink-0` stays
                unconditional too: it refuses compression along the MAIN axis, which is
                horizontal above the breakpoint and vertical below it. */}
            <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-start">
              <div
                data-testid="artifact-rail"
                // `bg-popover` is LOAD-BEARING, not decoration. `sticky` floats the rail
                // OVER the scrolling content and `DialogContent`'s own surface is
                // `bg-popover` (`ui/dialog.tsx:66`), so a transparent rail is a stencil:
                // a long document scrolls visibly THROUGH the key rows. `rounded-md`
                // keeps its corners off the pane's border. `sm:w-44` is 11rem = 176px at
                // the 16px root — the rail width spec §3 names, now the wide-window arm.
                className="flex w-full shrink-0 flex-col gap-1 self-start rounded-md bg-popover sm:sticky sm:top-0 sm:w-44"
              >
            {artifactKeys.map((key) => (
              // THE CLICKABLE GRAMMAR (spec §2): leading glyph → key → trailing
              // chevron, and `bg-selected` when it is the key being read. No new
              // component and no new token — the glyph is the one the transcript's
              // `FileChip` draws for a `.md` fence, the chevron is already this app's
              // "this goes somewhere" mark, and `bg-selected` is the sidebar's
              // active-row fill. The 5% hover wash that used to be the ONLY thing
              // separating this row from the read-only `id` row below is no longer the
              // whole signal.
              <button
                key={key}
                type="button"
                data-testid="artifact-key"
                data-artifact-key={key}
                // Which key the reader is showing — the list gives no other answer to
                // "which one am I looking at". An attribute, not a second element.
                // `false || undefined` is `undefined`, so an unselected row simply
                // omits the attribute; this is correct and is NOT to be "fixed" to
                // `"false"`.
                aria-current={selectedKey === key || undefined}
                onClick={() => void selectArtifact(key)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm text-foreground-subtle hover:text-foreground",
                  // Exactly ONE of these reaches the class list, which is also what
                  // stops a selected row's hover from replacing its own fill (the same
                  // measured reasoning `SessionListRow.tsx:129` records).
                  selectedKey === key ? "bg-selected text-foreground" : "hover:bg-surface-hover",
                )}
              >
                <ArtifactGlyph
                  data-testid="artifact-key-glyph"
                  className={cn("size-3.5 shrink-0", ARTIFACT_SPEC.className)}
                />
                {/* The key is the row's ONLY text node — the glyph and the chevron are
                    `<svg>` elements that carry none — so `textContent` stays exactly
                    the key. */}
                <span className="min-w-0 flex-1 truncate font-mono text-ui-xs">
                  {key}
                </span>
                <ChevronRightIcon
                  data-testid="artifact-key-chevron"
                  // The lone token is fine here: the `mutedCaption.test.ts` census
                  // matches the ADJACENT PAIR `text-ui-xs text-foreground-subtlest`,
                  // and `SpacesList.tsx:1046` already spells this same glyph's chevron
                  // with it alone.
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              </button>
            ))}
              </div>
              {/* THE PANE. No `max-h`, no `overflow-y-auto`, no `shrink-0`: its height IS
                  its content's height and `detail-scroll` is the ONLY scrollbar in this
                  dialog now. The old `max-h-72 … overflow-y-auto` reader box was a
                  scrollbar nested inside the dialog's own — two in one wheel gesture, the
                  wheel-stealing kind — which is the defect spec §3 exists to remove. The
                  document grows to full height and the sticky rail follows it. */}
              {(selectedArtifact !== null || artifactError !== null) && (
                // The gate is what keeps spec §3's "artifacts, none selected → rail ONLY,
                // no placeholder pane" state true AND what keeps the `null`-is-an-answer
                // pin green: a key that answers `null` must render NO document node at all,
                // and an always-present pane would break that test.
                //
                // `sm:flex-1` and not `flex-1`: the grow is for the TWO-COLUMN row, where
                // the main axis is horizontal and this is what gives the document the width
                // the rail leaves. Below the breakpoint the row stacks, the main axis turns
                // vertical, and `flex: 1 1 0%` would put a `0%` basis on HEIGHT — a layout
                // resting on whether a percentage resolves against an indefinite height.
                // Stretched cross-axis already gives it the full width there, so the narrow
                // arm is left at plain content height. `min-w-0` stays unconditional: above
                // the breakpoint it lets a long code line shrink instead of pushing the rail
                // out, and below it it stops one unbreakable word widening the dialog.
                <div className="min-w-0 sm:flex-1">
                  {selectedArtifact !== null && (
                    <div
                      data-testid="artifact-body"
                      className="rounded-lg border border-border px-3 py-2"
                    >
                      <AgentMarkdown text={selectedArtifact.markdown} />
                    </div>
                  )}
                  {/* An artifact read failure belongs in THIS column and never in the
                      launch `error` cell — the two failures are about different things, and
                      one cell would let a stale launch sentence sit under a reader failure
                      or make a reader failure claim the launch failed. */}
                  <IpcErrorLine error={artifactError} className="shrink-0" />
                </div>
              )}
            </div>
          </div>
        )}

        {sessions.length > 0 && (
          // NOT a scroll container, and it used to be one. `overflow-y-auto` and the
          // now-inert `min-h-0` are OUT and `shrink-0` is IN, and the tempting argument
          // for leaving this alone — "it has no `max-h` and no `flex-1`, so its height is
          // content-driven and it can never scroll" — is wrong about how a flex column
          // resolves overflow. `detail-scroll` is a column flex container whose height IS
          // definite (`flex-1` inside the `max-h-[80vh]` shell), so when its children's
          // combined height exceeds it the free space is NEGATIVE and every child still
          // holding `flex-shrink: 1` is compressed to fit. The floor that would normally
          // refuse that is a flex item's initial `min-height: auto`, and `min-h-0` is
          // precisely the token that removes it — so `min-h-0` + no `shrink-0` +
          // `overflow-y-auto` meant this wrapper got squeezed the moment anything else in
          // the scroller was tall, and a squeezed `overflow-y-auto` box is a real SECOND
          // scrollbar inside one wheel gesture. Latent only while the artifact reader was
          // capped at `max-h-72` + `shrink-0`; with an unbounded pane the common case it
          // becomes the visible one. `shrink-0` is spelled rather than relied on as a
          // default so this wrapper states what every other direct child of this scroller
          // states (the body div, the artifact section, the `MetaRow`s, the note, the
          // error line). A list that cannot be scrolled and a list that never needed to
          // are the same list once the scroller owns the scroll.
          <div className="flex shrink-0 flex-col gap-1">
            <MutedCaption className="shrink-0">
              Sessions on this task
            </MutedCaption>
            {sessions.map((row) => {
              // THE ONE LABEL RULE, walked rather than re-derived. `sessionFieldOf`
              // goes live → history → archived, which is what makes an archived
              // Session's title reachable at all; `titleFor` then applies
              // title → first user message truncated → Space folder name, the same
              // rule the sidebar rows print, so the two surfaces cannot name one
              // Session differently.
              const storedTitle =
                sessionFieldOf(lookupSource, row.sessionId, "title") ?? null;
              // The Session's OWN Space folder (its `cwd` basename) is the last
              // resort `titleFor` falls back to — the same field `SpacesList`'s row
              // resolves through `spaceNameFor`. The dialog has no `cwd` on
              // `TaskSessionRow`, so the walk supplies it.
              const sessionCwd = sessionFieldOf(
                lookupSource,
                row.sessionId,
                "cwd",
              );
              // THE CHAIN, and why each step is a PAIR. `basenameOfPath`'s own doc
              // (`lib/paths.ts`) says it returns `""` for empty input AND for a bare
              // root, and that "the caller falls back to the full path" — so every
              // step is `basenameOfPath(x) || x`, because a Space opened at `/` must
              // print `/` and not an empty label. When no list knows the id (a link to
              // a Session that has been deleted) the board's own Space is the honest
              // fallback, resolved by the same rule. The trailing `|| ""` is what
              // types the chain as `string`, which `titleFor`'s `spaceName` needs.
              //
              // THE ID IS DELIBERATELY NOT IN THIS CHAIN. Printing `row.sessionId` as
              // the label is the defect spec §2 removes; every other surface that names
              // a Session goes through `titleFor` and ends at a folder name. The id
              // lives in the row's `title` attribute and `data-session-id`, which is
              // where it stays reachable. The terminal `""` is only reachable when
              // NOTHING is known about the Session and no Space is selected at all,
              // and that honest "we could not name it" is not a blank to paper over.
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
              // `statusById` is `Record<string, SessionStatus>` and `tsconfig.json`
              // does not set `noUncheckedIndexedAccess`, so the `?? "stored"` is a
              // runtime belt for an id the map cannot miss, not a type fix.
              const status = statusById[row.sessionId] ?? "stored";
              return (
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
                  // The id is DEMOTED out of the text flow, not deleted: a task being
                  // discussed across two windows is named by a session id, so it stays
                  // reachable on hover and by copy. It is no longer what a person reads
                  // first — the title is.
                  title={row.sessionId}
                  onClick={() => onOpenSession(row.sessionId)}
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  {/* THE ONE SESSION-STATE GLYPH, at the sidebar row's own size and
                      relative weight (`SpacesList.tsx:926`). No `active` — no Session is
                      "the open one" in this modal, so the mark wears the quiet ink a
                      non-active sidebar row wears. No `className` with ink either: the
                      mark owns the ink and its `className` is geometry-only. And NOT
                      `announce={false}`: in the sidebar the glyph IS the statement (its
                      "Waiting" pill was deleted), and the mark keeps that here. */}
                  <SessionStatusMark
                    status={status}
                    size={16}
                    dotSize={8}
                    testId="session-status-mark"
                  />
                  {/* `font-mono text-ui-xs` (the id's type treatment) is GONE because this
                      span now holds a human title; `truncate` stays so a long title
                      cannot push the "from Stage" caption off the row. */}
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {/* `MutedCaption` rather than the hand-spelled pair: the census in
                      `mutedCaption.test.ts` keeps that class pair to ONE file, and this
                      is exactly that caption — a quiet qualifier beside a bolder value. */}
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

        {/* META, DEMOTED TO THE BOTTOM (spec §4). These two rows used to sit ABOVE the
            artifacts, so a task id outranked the spec document — reading order should
            follow what a person came to do, and it is Body → Artifacts → Sessions →
            Meta. Both are read-only, both wear NO leading glyph (see `MetaRow`), and
            that absence is what makes "has a glyph" mean "clickable" anywhere above
            them in this list. */}
        {task.specPath !== null && (
          <MetaRow label="spec">{task.specPath}</MetaRow>
        )}
        {/* The id, in the one place it is useful: a card being discussed across two
            windows is named by its id, not by a per-Space number that repeats. It is
            quiet, it is selectable, and it is the LAST thing in the scroller. */}
        <MetaRow label="id">{task.id}</MetaRow>

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
 * file), so the LABEL goes through it and the value wears the ink one step up.
 *
 * `data-testid` / `data-meta-label` exist so the READ-ONLY-ness of these rows is
 * assertable: spec §2's whole signal is "has a leading glyph" ⇒ "clickable", so the
 * rows that are not actionable must be provably glyph-free, and an absence cannot be
 * pinned on a node with no addressable handle. This renders NO `<svg>` — that absence
 * is the point. */
function MetaRow({ label, children }: { label: string; children: string }) {
  return (
    <div data-testid="meta-row" data-meta-label={label} className="flex min-w-0 shrink-0 items-baseline gap-2">
      <MutedCaption className="shrink-0">{label}</MutedCaption>
      <span className="min-w-0 break-all font-mono text-ui-xs text-foreground-subtle">
        {children}
      </span>
    </div>
  );
}
