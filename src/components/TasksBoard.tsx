import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Settings2Icon, XIcon } from "lucide-react";
import NewTaskDialog from "./NewTaskDialog";
import StageEditor from "./StageEditor";
import TaskCard, { type TaskCardProps } from "./TaskCard";
import TaskDetailDialog from "./TaskDetailDialog";
import { EmptyListLine } from "./EmptyListLine";
import { IpcErrorLine } from "./IpcErrorLine";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { cn } from "./lib/utils";
import { useDragReorder } from "../hooks/useDragReorder";
import {
  STAGE_COLUMN_ATTRIBUTE,
  useDragCard,
  type DragCardHandlers,
  type DropTargetHandlers,
} from "../hooks/useDragCard";
import { useTasks } from "../store/tasks";
import { useSessions } from "../store/sessions";
import { launchTaskSession } from "../store/taskLaunch";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { describeIpcError } from "../lib/ipcError";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import type { StageWithTasks, TaskRow } from "../lib/tauri";

/**
 * The **Task board** — the surface `App`'s `"board"` view renders in place of the
 * chat column and the `SidePane`.
 *
 * IT LOADS ITS STORE ON MOUNT, NOT AT BOOT, and that is the load-bearing scheduling
 * decision. `App`'s boot `Promise.all([listSpaces, listSessions, sessionRecency])`
 * is untouched, so `App.test.tsx` gains no BOOT mock (whose absence is the
 * documented trap: that file's `vi.mock` factory spreads `importActual`, so an
 * un-mocked boot fetch rejects in jsdom and reddens tests that merely need a booted
 * store). The deeper reason is on the wire: `get_board` WRITES — it seeds the five
 * default stages for a Space that has none (ADR 0090's lazy seeding) — so fetching
 * it at boot would create columns in every Space on every launch, which is exactly
 * what the lazy-seeding decision refused to pay.
 *
 * TWO DRAGS, TWO HOOKS, ONE ELEMENT EACH — and the nesting is the whole design.
 * Spec §3 gives a card two verbs: a drop in ANOTHER column writes `stage_slug` and
 * runs that column's `on_enter` (`moveTask`); a drop in the SAME column writes
 * `sort_order` and nothing else (`reorderTasks`). Two hooks own those and neither is
 * generalised into the other (`useDragCard`'s header says why: the reorder hook's
 * spread surface is pinned at six keys for a byte-compared `RowButton`). Two
 * `dragProps` cannot be spread onto ONE element — the second `onDragOver`/`onDrop`
 * would silently win — so the board nests them:
 *
 *   column → `useDragCard.columnProps()`    (target half; catches an EMPTY column)
 *   slot   → `useDragReorder.dragProps()`   (within-column: the row IS the target)
 *   card   → `useDragCard.dragProps()`      (the draggable surface)
 *
 * Events bubble through all three and each answers a DIFFERENT question: the card's
 * asks "is this pointer over a column other than mine", the slot's asks "which edge
 * of which sibling am I over". A same-column drop is refused by the cross-column
 * hook and accepted by the reorder hook; a cross-column drop is refused by the
 * reorder hook (`!ids.includes` — the pointer is over no card of this column) and
 * accepted by the cross-column one. The two verbs are therefore mutually exclusive
 * BY CONSTRUCTION, not by a tie-break one of them has to remember.
 *
 * THE CARD IS A CHILD OF THE SLOT AND NOT THE SAME NODE, and that is a DOM rule
 * rather than a style choice: `draggable` inherits. A card inside a `draggable` slot
 * would make every child of a card a drag handle for BOTH surfaces at once. One
 * draggable node per gesture, one element.
 *
 * THIS BOARD HAS NO EXIT CONTROL, and that is deliberate rather than an omission.
 * ADR 0094 hoisted `SpacesList` above `App`'s view ternary, so the pane that holds
 * the `Tasks` door is on screen WHILE the board is up; with the strip acting as
 * the view switcher (N1) the pressed `Tasks` door toggles this view off and any
 * **Session** row leaves it too. Two exits per view, both owned by the pane — a
 * board-level `Back` would be a third way out that only this surface offered, and
 * it invited a reader to re-add a control the design retired.
 *
 * IT READS TWO STORES, AND ONLY SUBSCRIBES TO ONE. `useTasks` is the board's own
 * slice and is read through selectors. `useSessions` (issue #174) is read through
 * `getState()` for ONE action, `openSession`, and forwarded to every card's chip —
 * no subscription, because the board renders nothing derived from the sessions
 * store and a subscription would re-render it for nothing. The card takes the
 * action as a prop rather than reading it itself: `TaskCard` is presentational with
 * no store of its own, and `openSession` (not `setActiveSession`) is the call that
 * resolves a linked Session's owner Space by `cwd` and loads its transcript, closed
 * and archived Sessions included.
 */
export interface TasksBoardProps {
  /** The active **Space**'s folder — the SAME derivation `SidePane` and the
   *  mention-picker catalogs use (`useActiveSpaceCwd`). `null` when no Session is
   *  active: the board renders its header and an empty line rather than calling
   *  `get_board(null)`. */
  activeSpacePath: string | null;
  /** Leave the board view: a **Session** is now open and the chat column is behind
   *  this board.
   *
   *  THE BUG THIS EXISTS FOR. `useSessions.openSession` selects the Session in the
   *  store, and the store is the source of truth — but `App`'s `"board"` arm renders
   *  this section IN PLACE OF `ChatStream`, so selecting a Session while the board is
   *  up changes the transcript nobody can see. Issue #174 shipped the card's sessions
   *  chip on the reasoning that `openSession` resolves the owner Space and loads the
   *  transcript, and all of that was true; what nobody had checked is that the view
   *  ternary above it never moved. So a chip click produced a visible nothing.
   *
   *  OPTIONAL rather than required, and only because that is the shape `SpacesList`
   *  uses for the identical callback (`onReturnToWorkspace?`) — the board's own card
   *  and modal surfaces both route through it here, so within this file it is always
   *  passed. `App` hands it the same `setView("workspace")` the Session rows and the
   *  `Tasks` door already use; the board does not own a view and does not start here. */
  onReturnToWorkspace?: () => void;
}

export default function TasksBoard({
  activeSpacePath,
  onReturnToWorkspace,
}: TasksBoardProps) {
  const columns = useTasks((s) =>
    activeSpacePath ? s.boardsBySpace[activeSpacePath] : undefined,
  );
  const loading = useTasks((s) => s.loading);
  const error = useTasks((s) => s.error);
  const boostNote = useTasks((s) =>
    activeSpacePath ? s.boostNotes[activeSpacePath] : undefined,
  );
  const load = useTasks((s) => s.load);
  const moveCard = useTasks((s) => s.moveTask);
  const reorderInStage = useTasks((s) => s.reorderWithinStage);
  const dismissBoostNote = useTasks((s) => s.dismissBoostNote);
  // The Session half of a card's chip (issue #174), read through `getState()` and
  // NOT through a selector because this board needs the ACTION and not a slice of
  // state: zustand actions keep their identity for the life of the store, so a
  // subscription here would re-render the board for nothing while buying nothing.
  //
  // `openSession` and NOT `setActiveSession`: `setActiveSession` only sets an id.
  // `openSession` resolves the owner Space by `cwd` across live / stored / archived
  // membership, sets the active Space (so the tab bar follows) and loads the
  // transcript — which is what makes a CLOSED or archived Session openable from a
  // card, and it matters here because a linked Session is not structurally in the
  // card's Space (`sessions` has no `space_path`; the Space comes from `cwd`).
  //
  // Wrapped rather than handed down raw, because "open a Session" and "look at it"
  // are one intent for a person and two facts for this app. Every path out of this
  // surface to a transcript goes through the wrapper: the card's chip, the detail
  // modal's session list, and the modal's two launch buttons (which arrive through
  // `onLaunched`, since a launch calls `addSession` and not `openSession`).
  //
  // It is passed DOWN rather than imported by the card: `TaskCard` is presentational
  // and subscribes to no store, and a card that read the sessions store for itself
  // would be a second owner of "which Session is open" — see its own header.
  const openSessionAndLeave = (sessionId: string): void => {
    useSessions.getState().openSession(sessionId);
    onReturnToWorkspace?.();
  };

  // THE CATALOGS, read ONCE for the whole board and shared with both modals.
  //
  // `useMentionCatalogs` is module-cached per Space, so this is not a fourth fetch —
  // `NewTaskDialog` and `TaskDetailDialog` already mount it and share the promise. It
  // is read HERE because the card cannot be the one to read it: `TaskCard` is
  // presentational and subscribes to no store (its header argues why), and the pill's
  // gate needs a catalog the card has no business owning.
  //
  // The gate is not decoration. The catalog is an async fetch that starts EMPTY, so a
  // pill painted from the first paint is clickable before it lands and its click fails
  // with "This Space has no `x` skill" — a sentence that is FALSE two frames later.
  // Gating on the same predicate `store/taskLaunch` refuses on removes the race rather
  // than narrowing it, exactly as the detail modal's footer does.
  const { skills, agents } = useMentionCatalogs(activeSpacePath);
  const catalogs = useMemo(() => ({ skills, agents }), [skills, agents]);

  /** The board's ONE launch route, shared by the card's pill and (through
   *  `store/taskLaunch`) the detail modal's own buttons.
   *
   *  It exists so a launch from a card is not a second implementation of the ordering
   *  rules: `store/taskLaunch` owns move-before-start, the Skill gate and the
   *  in-flight guard, and this is only the call. A refusal is written into the store's
   *  `error` cell rather than thrown, because the board already renders that cell as an
   *  `IpcErrorLine` with `role="alert"` — a second error surface would be two answers
   *  to "what went wrong", and an uncaught rejection here would report nothing at all.
   *
   *  The DROP never reaches this function, and that is deliberate (spec §6.4): a drop
   *  that started a Session would render the board over the transcript its own `ask`
   *  gate needs, and `ask_flow` blocks with no timeout. */
  const launchFromCard = async (
    task: TaskRow,
    destination: TaskLaunchDestination,
  ): Promise<void> => {
    if (activeSpacePath === null) return;
    try {
      await launchTaskSession(activeSpacePath, task, destination.slug, catalogs);
    } catch (err) {
      useTasks.setState({ error: describeIpcError(err) });
    }
  };

  /** The card's PRIMARY NEXT STEP, derived from the graph rather than hardcoded.
   *
   *  The FIRST `next_slugs` entry (spec §7.1) — the row's author put that one first —
   *  and with `next_slugs` NULL the fallback is the Stage at `sortOrder + 1`, so an
   *  unconfigured board keeps a launch pill instead of silently losing it on upgrade.
   *  `nextSlugs: []` is the OTHER answer (configured, leads nowhere) and yields no
   *  pill; the two must not collapse (ADR 0099).
   *
   *  Deliberately the same derivation `TaskDetailDialog` runs, spelled twice rather
   *  than hoisted into `lib/`: the two surfaces read the same store slice, and a shared
   *  helper would have to live in `lib/` (no store) and take the columns as an
   *  argument, which is the shape both already have locally. If a third surface grows
   *  the same need, that helper is the extraction to make. */
  const nextStepOf = (
    column: StageWithTasks,
  ): TaskLaunchDestination | undefined => {
    const slugs =
      column.stage.nextSlugs ??
      (columns ?? [])
        .filter((c) => c.stage.sortOrder === column.stage.sortOrder + 1)
        .map((c) => c.stage.slug);
    const slug = slugs[0];
    if (slug === undefined) return undefined;
    const stage = columns?.find((c) => c.stage.slug === slug)?.stage;
    // An edge the slice cannot resolve yields NO pill: unlike the detail modal (which
    // keeps it, because there the skipped-column NOTE is the surface that explains the
    // stale read), a pill has no note to fall back on — it would be a control whose
    // click moves nothing, with the sentence appearing somewhere else entirely.
    return stage === undefined
      ? undefined
      : { slug: stage.slug, label: stage.label, onEnterSkill: stage.onEnterSkill };
  };

  /** The `launchStep` prop for one card, or `undefined` for "no pill".
   *
   *  The gate lives HERE rather than inside the card because the card holds no
   *  catalog — and the gate is the one fact about the pill a card cannot work out for
   *  itself. A destination with NO Skill is `launchReady: true` outright: nothing is
   *  waiting, so it renders on the first paint. */
  const launchStepFor = (
    column: StageWithTasks,
    task: TaskRow,
  ): TaskCardProps["launchStep"] => {
    const destination = nextStepOf(column);
    if (destination === undefined) return undefined;
    return {
      destination,
      launchReady:
        destination.onEnterSkill === null ||
        skills.some((s) => s.name === destination.onEnterSkill),
      onLaunch: (d) => void launchFromCard(task, d),
    };
  };

  // The New Task modal's open flag, in THIS component's state. It lives here
  // because this is where the board's columns already are — the modal needs the
  // first stage to file a Task under, and mounting it at `App` level would mean
  // a module-flag file plus a second read of this store for the same data. The
  // flag does not survive leaving the board, which is correct: the modal is the
  // board's affordance, and a Task already created survives because the store
  // and the sessions list own it, not this flag.
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // The **Stage editor**'s open flag, in the same place and for the same reasons as
  // the flag above it: the dialog needs the board's column set, the board is where
  // that set already lives, and neither survives leaving the view — which is right,
  // because both are the board's affordances while the STAGES themselves are owned
  // by the store and by the database, so closing this dialog loses nothing.
  const [stageEditorOpen, setStageEditorOpen] = useState(false);
  // The **detail modal** names a CARD by id rather than holding an open flag.
  //
  // The id is the state and not a `boolean` plus a separately-stored row, for two
  // reasons. (1) A flag plus a lookup is two cells for one fact, and the failure mode
  // of that shape is a dialog open against the card a PREVIOUS click named. (2) The
  // id is what every command takes, so the modal's launch buttons need it anyway —
  // storing the whole row would mean re-deriving nothing and going stale on everything.
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);

  /** A card the New Task modal finished with. Two outcomes, and only one of them
   *  leaves the view: a card filed to the Backlog is something to look at ON the
   *  board, while a launched Session is something this board is currently HIDING (its
   *  arm renders this section in place of `ChatStream`). So the Session id decides,
   *  and the modal's `onCreated` is what carries it — the modal has never owned a view
   *  and does not start here.
   *
   *  The card itself needs no work here: `store/tasks`' `createTask` action lands it in
   *  the column set the human is looking at rather than refetching, because `get_board`
   *  seeds stages on read and a refetch would be a wider mutation than the one being
   *  displayed. `_task` is therefore unread, and that is deliberate rather than a
   *  dropped requirement.
   *
   *  It does NOT close the modal. `NewTaskDialog` calls `onCreated` and then
   *  `onClose`, so the flag has one owner; closing here too would be a second write of
   *  the same cell, and a flag with two writers is the shape that hides which path
   *  left it open. */
  const handleTaskCreated = (_task: TaskRow, sessionId: string | null): void => {
    if (sessionId !== null) onReturnToWorkspace?.();
  };

  // The card the modal names, resolved from the CURRENT board slice. Reading it back
  // out of the store rather than freezing the row at click time means the modal shows
  // the card AS THE BOARD HAS IT: drag the card while its modal is open and the
  // modal's stage line follows, instead of describing a column the card left.
  // `undefined` (a card a reload dropped) renders no dialog at all, so a modal can
  // not outlive its own row.
  const detailCard =
    detailTaskId === null
      ? undefined
      : (columns ?? [])
          .flatMap((column) => column.tasks)
          .find((card) => card.task.id === detailTaskId);

  // The board reads its own store, on mount and whenever the Space changes. The
  // action captures its own failure into `error`, so nothing throws out of here.
  useEffect(() => {
    if (activeSpacePath === null) return;
    void load(activeSpacePath);
  }, [activeSpacePath, load]);

  // A STABLE array identity across renders that did not change the board. Both drag
  // hooks take the board as an argument and their handlers close over it, so a fresh
  // `?? []` every render would rebuild every handler every render — the same reason
  // `SpacesList` hoists `NO_SESSION_IDS` to module scope.
  const stages: readonly StageWithTasks[] = useMemo(() => columns ?? [], [columns]);

  /** The cross-column gesture, ONE instance for the whole board: it has to see every
   *  column to answer "is the pointer over a different one", so one instance per
   *  column would be N copies of one question. */
  const crossColumn = useDragCard({
    stages,
    onMove: (taskId, _fromStageSlug, toStageSlug) => {
      if (activeSpacePath === null) return;
      // `_from` is deliberately unread: Rust re-reads the row and runs the
      // DESTINATION's `on_enter`, and the client's view of the source can be stale
      // after an optimistic write. Forwarding it would give the drag a second,
      // client-side answer to a question the write already settles.
      void moveCard(activeSpacePath, taskId, toStageSlug);
    },
  });

  // Read once, then passed down: the column needs both, and reading them through the
  // hook's return object at each of N columns would be N property reads of one
  // render's answer.
  const { dragProps, columnProps, draggingTaskId, overStageSlug } = crossColumn;
  const columnDrop = columnProps();

  return (
    <section
      // ADR 0097: the frame plane is CHROME and every view surface is an ISLAND
      // above it. This root used to wear the chrome colour itself — the same one
      // the Session list is painted — so the board sat at contrast 1.00 against
      // the pane beside it and read as the background showing through rather than
      // as a surface. It now floats on the island recipe the Side pane and both
      // Settings halves wear: `m-1` (the 4px frame gap), `rounded-xl`, and the
      // transcript's own plane. `overflow-hidden` clips the island's corners, and
      // per the flexbox spec it also drops a flex item's automatic minimum size to
      // zero — which is why NO `min-height` utility is needed here on top of the
      // `min-w-0` that IS load-bearing: the parent (`content-row`) is a flex ROW,
      // so width is the main axis and without it a long row of `w-72` columns
      // would push this section wide instead of handing the overflow to the
      // scroller below.
      className="relative m-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-chat"
      data-testid="tasks-board"
      aria-label="Task board"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        {/* An `h1` because this surface replaces the whole content row while it is
            up, and a screen reader needs the surface named the way Settings' page is
            named. */}
        <h1 className="flex-1 text-ui-base font-medium">Tasks</h1>
        {/* The creation affordance. It sits in the header rather than inside a
            column because a new Task is not a property of any one column — the
            modal files it in the FIRST stage, which is a board-level fact.
            Disabled with no active Space: `createTask(null, …)` is not a thing,
            and a dead button that opens a modal which cannot send is worse than
            one that says nothing is open. */}
        <Button
          type="button"
          variant="ghost"
          size="default"
          aria-label="New task"
          className="h-8 shrink-0 gap-2 rounded-lg px-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          disabled={activeSpacePath === null}
          onClick={() => setNewTaskOpen(true)}
        >
          <PlusIcon className="size-4" />
          <span>New task</span>
        </Button>
        {/* The **Stage editor**'s door (issue #179 §8), beside `New task` and AFTER
            it: create first, configure second. Same ghost/idle-ink recipe as its
            neighbour so the two read as one pair of quiet header affordances rather
            than one primary action and one loud one, and the SAME disabled rule —
            with no active Space there is no column set to edit, and a button that
            opens a dialog whose every write has no target is worse than one that
            says nothing is open.

            WHY THE EDITING LIVES HERE AND NOT ON THE COLUMN HEADER. A column header
            is a flex row of spans INSIDE the drop-target `<div>` that carries
            `useDragCard.columnProps()`, and `draggable` inherits to children — the
            hazard `TaskCard.tsx` records for the card itself. Clicking a label to
            rename it inside a drop zone is how "the rename starts a drag" gets
            written, so every Stage edit happens behind this button instead. */}
        <Button
          type="button"
          variant="ghost"
          size="default"
          aria-label="Configure"
          className="h-8 shrink-0 gap-2 rounded-lg px-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          disabled={activeSpacePath === null}
          onClick={() => setStageEditorOpen(true)}
        >
          <Settings2Icon className="size-4" />
          <span>Configure</span>
        </Button>
      </header>

      {/* The two things a board render needs that are NOT board rows, and both are
          warnings rather than failures:
            - `boostNote`: the card MOVED and the destination's `on_enter` boost did
              not fire (spec §5's caveat 2 — a stored Session makes a `compact`
              compaction a silent no-op). Rendering it is the difference between a
              drag that is honest and one that is silently half-done.
            - `error`: the inline IPC-error line, which carries `role="alert"` so the
              failure is announced and not merely painted red.
          Both sit in the header band, ABOVE the columns: a note about a card that has
          already moved must not be attached to the column it moved into, where it
          would read as a property of the column. */}
      {boostNote && (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2"
          data-testid="boost-note"
          // `role="status"`, NOT `role="alert"`: this is not a failed action — the
          // card moved. `IpcErrorLine`'s header records that the `alert` region is
          // reserved for the things the user must react to; using it here would
          // announce a successful drag as a failure.
          role="status"
        >
          <span className="min-w-0 flex-1 text-ui-sm text-warning">{boostNote}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() =>
              activeSpacePath !== null && dismissBoostNote(activeSpacePath)
            }
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      )}
      <IpcErrorLine error={error} className="shrink-0 px-3 pb-2" />

      {activeSpacePath === null ? (
        <EmptyListLine>
          No Space is open, so there is no Task board to show.
        </EmptyListLine>
      ) : columns === undefined && loading ? (
        // `Spinner` IS the `role="status"` node (it sets it itself), so this wrapper
        // adds no second live region — a wrapper with its own `role="status"` would
        // make `getByRole("status")` throw on multiple matches.
        <div className="flex items-center gap-2 p-3">
          <Spinner className="size-4 text-foreground-subtlest" />
          <span className="text-ui-sm text-foreground-subtlest">
            Loading the task board…
          </span>
        </div>
      ) : columns === undefined ? (
        // Loaded-but-empty is NOT the same state as never-loaded, and after a failure
        // `columns` is still `undefined` — so this line is what a user sees under the
        // error, and it must not claim the board is empty when the FETCH failed.
        <EmptyListLine>The board has not loaded yet.</EmptyListLine>
      ) : (
        // The columns' scroller. Three things here are load-bearing and each one is
        // a separate decision:
        //   - `px-3 pb-3` is the LEFT EDGE. The header band and the boost-note band
        //     above both inset 12px, so an unpadded scroller started its first
        //     column at 0 and gave the board two left edges. (An earlier pass
        //     dropped this on the theory that the island's `m-1` was the gutter —
        //     `m-1` is the OUTER frame gap, the chrome plane outside the island, and
        //     not inner padding.)
        //   - `items-start` is THE switch that makes columns CONTENT-HEIGHT. This is
        //     a flex ROW, so its default `align-items: stretch` is what stretches
        //     every column to the full board height today; removing `flex-1` from the
        //     inner list would do nothing while `stretch` is in force.
        //   - `overflow-y-auto` moves the vertical scroll HERE. With content-height
        //     columns no column scrolls itself, so a tall column has to scroll the
        //     board; both axes on one element is ordinary.
        <div className="flex min-h-0 flex-1 items-start gap-2 overflow-x-auto overflow-y-auto px-3 pb-3">
          {stages.length === 0 ? (
            <EmptyListLine>This Space has no stages yet.</EmptyListLine>
          ) : (
            stages.map((column) => (
              <TaskColumn
                key={column.stage.slug}
                column={column}
                over={overStageSlug === column.stage.slug}
                draggingTaskId={draggingTaskId}
                cardDrag={dragProps}
                columnDrop={columnDrop}
                onOpenSession={openSessionAndLeave}
                onOpenTask={setDetailTaskId}
                launchStepFor={launchStepFor}
                onReorder={(ids) =>
                  reorderInStage(activeSpacePath, column.stage.slug, ids)
                }
              />
            ))
          )}
        </div>
      )}

      {/* The New Task modal (spec §3). Rendered from THIS component's flag, as a
          child of the board's `section`: `DialogContent` portals to `body`, so
          nesting it here costs nothing in layout and keeps the data it needs (the
          columns, the active Space) right where it is read. It is mounted only
          while open — a closed modal that keeps a `MessageList` and a composer
          alive would be a second idle chat surface behind the board. */}
      {detailCard !== undefined && (
        <TaskDetailDialog
          task={detailCard.task}
          sessions={detailCard.sessions}
          costUsd={detailCard.costUsd}
          artifactKeys={detailCard.artifactKeys}
          spacePath={activeSpacePath}
          onClose={() => setDetailTaskId(null)}
          onOpenSession={openSessionAndLeave}
          onLaunched={() => onReturnToWorkspace?.()}
        />
      )}

      {/* The Stage editor (issue #179 §8), mounted from this component's flag for
          the same reason and in the same shape as the two modals above it: it reads
          the board's own store slice, `DialogContent` portals to `body`, and it is
          mounted ONLY while open — a closed editor would keep a form, a catalog
          read and a `get_board_strict` round trip alive behind the board. Its
          `onClose` flips the flag here and nowhere else, so the flag has one owner.

          The editor renders its own `IpcErrorLine` for a refused Stage write, and
          the board's line above stays as the drag-refusal surface. Both can be live
          at once while the dialog is up, which is why the editor's own test scopes
          its `role="alert"` reads to the dialog. */}
      {stageEditorOpen && (
        <StageEditor
          spacePath={activeSpacePath}
          onClose={() => setStageEditorOpen(false)}
        />
      )}

      {newTaskOpen && (
        <NewTaskDialog
          spacePath={activeSpacePath}
          onClose={() => setNewTaskOpen(false)}
          onCreated={handleTaskCreated}
        />
      )}
    </section>
  );
}

/**
 * One column: its header, and the card strip that carries the within-column surface.
 *
 * A SEPARATE COMPONENT because `useDragReorder` is a hook and a hook cannot be
 * called inside `.map()` — the per-column instance needs a per-column component.
 * That is also what keeps the reorder hook's `ids` slice honest: it is exactly THIS
 * column's card ids in THIS column's order, which is the slice `reorderTasks` writes
 * (`sort_order` is per-Space, so a slice spanning two columns would renumber a card
 * the user never dragged).
 */
function TaskColumn({
  column,
  over,
  draggingTaskId,
  cardDrag,
  columnDrop,
  onOpenSession,
  onOpenTask,
  launchStepFor,
  onReorder,
}: {
  column: StageWithTasks;
  /** The pointer is over THIS column with a card from another column in hand. */
  over: boolean;
  /** The card the board is currently carrying, or `null`. */
  draggingTaskId: string | null;
  /** The board-wide cross-column card surface (`dragProps(id)`). */
  cardDrag: (taskId: string) => DragCardHandlers;
  /** The board-wide cross-column column surface (the target half). */
  columnDrop: DropTargetHandlers;
  /** Opens a Session — the board's one read of `useSessions.getState().openSession`,
   *  forwarded to every card's chip (issue #174). It is threaded through here and
   *  not read again because the board owns the store reads and this column is
   *  already a pure function of what it was handed. */
  onOpenSession: (sessionId: string) => void;
  /** Opens this card's detail modal — the board's `detailTaskId` setter. */
  onOpenTask: (taskId: string) => void;
  /** Builds this card's primary-next-step pill (issue #179 §7.1), or `undefined` for
   *  "this Stage leads nowhere".
   *
   *  A FACTORY taking `(column, task)` rather than a pre-computed value, because the
   *  column renders N cards and each pill's `onLaunch` must close over ITS OWN card —
   *  a single pre-built prop would point every card's pill at one row. The board owns
   *  the derivation and the catalog gate; this column forwards, exactly as it forwards
   *  `onOpenSession`, so no store read appears here. */
  launchStepFor: (
    column: StageWithTasks,
    task: TaskRow,
  ) => TaskCardProps["launchStep"];
  onReorder: (ids: string[]) => void;
}) {
  const ids = useMemo(
    () => column.tasks.map((t) => t.task.id),
    [column.tasks],
  );
  // The within-column gesture, reused UNCHANGED with the default `axis: "y"` — a
  // vertical strip, so the pointer's half of the target row is read off Y. Nothing
  // here computes an index: the hook already answers before-or-after for the
  // sidebar's rows and the tab strip, and a second copy of that arithmetic in the
  // board is the drift it exists to prevent.
  const reorder = useDragReorder({ ids, onReorder });

  return (
    <div
      // The marker `useDragCard`'s hit test reads to resolve which column a pointer
      // is over. The shared constant is spread rather than re-spelled as a literal so
      // the string has ONE owner — a rename in the hook cannot leave it hunting for a
      // marker nothing emits. It sits on the COLUMN and not the strip because the
      // strip is what scrolls: a rect covering only the visible part would refuse a
      // drop near a column's edge.
      {...{ [STAGE_COLUMN_ATTRIBUTE]: column.stage.slug }}
      {...columnDrop}
      data-testid={`task-column-${column.stage.slug}`}
      data-over={over ? "true" : undefined}
      // `cn()` and NOT a ternary over two class lists: `classNameConvention.test.ts`
      // gates every ternary-shaped `className` through a pinned allowlist, and here
      // `cn()` is also simply the right tool — `bg-selected` must win the background
      // group against the resting `bg-panel`, which a merge does and a concatenation
      // leaves to CSS order.
      className={cn(
        "flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-card-border bg-panel p-2",
        // The drop-target band. `border-brand` is the SAME ink the two existing drag
        // call sites use for "you will land here" (`SessionListRow`'s `border-brand`
        // edge, `SpaceTabs`' `border-brand`), so one gesture keeps one visual language.
        over && "border-brand bg-selected",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-1">
        {/* `board.stage.label` — the NESTED read. A column built from the flat shape
            (`column.label`) renders an EMPTY header here with no type error, which is
            the failure mode `TasksBoard.test.tsx` pins by name. */}
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
          {column.stage.label}
        </span>
        {/* The count is a COUNT and not a caption, so it gets a fill — and the
            fill must differ from BOTH surfaces it can sit against (the column's
            `bg-panel` and the card's `bg-card`) in EVERY palette, which is the
            check `slabFloatSeparation.test.ts` now runs per palette. `bg-chat`
            passed that in Dracula (1.22 / 1.21) and is 1.00 — invisible — against
            `bg-card` in default-dark by construction, so the pill takes the page step:
            `bg-background` measures 1.10/1.34, 1.11/1.28, 1.06/1.06. */}
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle">
          {column.tasks.length}
        </span>
        {/* The column's `on_enter` is what makes a kanban column more than a label, so
            it is visible rather than buried. */}
        {column.stage.onEnter !== "none" && (
          <span
            className="shrink-0 text-ui-sm text-foreground-subtlest"
            title={`Entering this stage runs: ${column.stage.onEnter}`}
          >
            {column.stage.onEnter}
          </span>
        )}
      </div>

      {column.tasks.length === 0 ? (
        // An EMPTY column still renders its header and this line, and it is still a
        // drop target (the column surface above). The seeded default board is five
        // columns and usually zero cards, so "empty column" is the common case.
        <EmptyListLine>No tasks.</EmptyListLine>
      ) : (
        // `flex flex-col gap-2` and NOTHING else. `flex-1` + `overflow-y-auto` are
        // deliberately GONE: they are what forced a column to fill its height and
        // scroll INTERNALLY, which is the behaviour this change removes — the column
        // now hugs its content and the BOARD scrolls (the scroller's
        // `overflow-y-auto`). `min-h-0` goes with them: it existed only to let that
        // inner scroller shrink. Pinned as classes in
        // `TasksBoard.test.tsx` ("the columns hug their content") because jsdom
        // performs no layout and a height cannot be asserted here.
        <div className="flex flex-col gap-2">
          {/* A board element is a `TaskCardView` (issue #174): the row the card
              renders sits under `.task`, so every id here reaches through it, and
              the wrapper's `sessions` / `costUsd` go to the card as the chip's two
              facts. This block used to be spelled as a `//` line comment, which is
              NOT a comment slot in JSX — jsdom printed the prose as the column's
              first child (it shows up in the DOM dump of any failing case in
              `TasksBoard.test.tsx`) and `tsc` could not see it. A brace-wrapped
              block comment is the only spelling that stays out of the render. */}
          {column.tasks.map((card) => {
            const edge = reorder.overId === card.task.id ? reorder.overEdge : null;
            return (
              // The SLOT carries the within-column surface and the drop-edge class;
              // the CARD inside it carries the cross-column surface and `draggable`.
              // Two spreads on one node would leave the second
              // `onDragOver`/`onDrop` winning in silence — see the header.
              <div
                key={card.task.id}
                data-testid="task-card-slot"
                data-edge={edge ?? undefined}
                {...reorder.dragProps(card.task.id)}
                className={cn(
                  // `border-2` is reserved for the drop edge (the
                  // `SessionListRow`/`SpaceTabs` idiom), so the slot carries no border
                  // at rest and the edge cannot be swallowed by a merge.
                  "rounded-lg",
                  edge === "before" && "border-t-2 border-brand",
                  edge === "after" && "border-b-2 border-brand",
                )}
              >
                <TaskCard
                  task={card.task}
                  sessions={card.sessions}
                  costUsd={card.costUsd}
                  artifactKeys={card.artifactKeys}
                  onOpenSession={onOpenSession}
                  onOpenTask={onOpenTask}
                  launchStep={launchStepFor(column, card.task)}
                  drag={cardDrag(card.task.id)}
                  active={draggingTaskId === card.task.id}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
