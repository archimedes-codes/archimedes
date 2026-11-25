import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Settings2Icon, XIcon } from "lucide-react";
import NewTaskDialog from "./NewTaskDialog";
import type { TaskCardProps } from "./TaskCard";
import TaskDetailDialog from "./TaskDetailDialog";
import { TaskColumn } from "./tasks/TaskColumn";
import { EmptyListLine } from "./EmptyListLine";
import { IpcErrorLine } from "./IpcErrorLine";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { useDragCard } from "../hooks/useDragCard";
import { useTasks } from "../store/tasks";
import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import { launchTaskSession } from "../store/taskLaunch";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { describeIpcError } from "../lib/ipcError";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import { nextStepOf } from "../lib/workflowGraph";
import { sessionStatusRollupOf } from "../lib/sessionStatusRollup";
import { useSessionStatuses } from "../hooks/useSessionStatus";
import { useTaskBoardAutoRefresh } from "../hooks/useTaskBoardAutoRefresh";
import type { SessionStatus } from "../hooks/useSessionStatus";
import type { StageWithTasks, TaskCardView, TaskRow } from "../lib/tauri";

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
 * IT READS TWO STORES AND SUBSCRIBES TO BOTH. `useTasks` is the board's own slice
 * and is read through selectors. `useSessions` is subscribed to for exactly ONE
 * primitive — `activeSpacePath`, the **Selected Space**, the tab strip's own state —
 * and that is the key this whole surface turns on: a Task board is PER-**SPACE**
 * (`CONTEXT.md`: "It is PER-SPACE, one board per Space") and ADR 0090 keys stages
 * and tasks on a `space_path` STRING with no foreign key to a Session, so a Space
 * with no Session running in it is a board with lanes, not a board that is out of
 * input. Everything else it needs from that store is the `openSession` ACTION, read
 * through `getState()` — which is not a subscription — and forwarded to every card's
 * chip. The card takes the action as a prop rather than reading it itself:
 * `TaskCard` is presentational with no store of its own, and `openSession` (not
 * `setActiveSession`) is the call that resolves a linked Session's owner Space by
 * `cwd` and loads its transcript, closed and archived Sessions included.
 *
 * THE PROP THAT USED TO CARRY THE KEY IS GONE, and issue #185 is why. `App` used to
 * hand this board `useActiveSpaceCwd()` — the ACTIVE SESSION'S `cwd` — under this
 * same prop name. One derivation with a lifecycle the board does not have: the
 * moment no Session was active (every Session archived, the last one deleted, a tab
 * clicked that owns no live Session) it became `null`, and every per-Space surface
 * behind that value went inert at once — no `get_board`, no columns, `New task` and
 * `Configure` dead — while the Session list beside the board read the store field,
 * named the same folder, and looked perfectly healthy. A per-Space view cannot take
 * its Space from a per-Session projection; it reads the selection.
 */
export interface TasksBoardProps {
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
  /** Open the **Workflows** canvas (`App`'s `"workflows"` view) — which is where the
   *  board's columns are now CONFIGURED, since the canvas's settings panel became the
   *  one editor for the stage fields and the board's own dialog was deleted with it.
   *
   *  NAMED FOR ITS DESTINATION, not for the door that calls it, and that is the
   *  convention rather than a whim: `SpacesList` declares the identical callback as
   *  `onOpenWorkflows?` and `App` hands both call sites the same
   *  `() => setView("workflows")`. Two names for one callback across two panes is how
   *  a reader ends up wiring one of them.
   *
   *  OPTIONAL on the same rule as `onReturnToWorkspace` above (the bare-`<TasksBoard />`
   *  render sites in the tests): absent means the `Configure` door is a NO-OP rather
   *  than a crash. The board does not own a view and does not start here. */
  onOpenWorkflows?: () => void;
}

export default function TasksBoard({
  onReturnToWorkspace,
  onOpenWorkflows,
}: TasksBoardProps) {
  // The board's Space — the SELECTED one, the same field the Session list and the
  // tab strip read. Read BEFORE the `useTasks` selectors below and not after them,
  // because zustand runs a selector synchronously inside `useSyncExternalStore`
  // during the render: a `useTasks` selector that closes over this name would read
  // it while it is still in its temporal dead zone and throw on the first render
  // (measured — it reddens every case in the file, and `tsc` calls it too).
  //
  // A PRIMITIVE selector, returning `string | null` directly and never an object or
  // an array: a selector whose result is a fresh reference on every call makes
  // zustand re-render forever (the rule at `useActiveSpaceCwd.ts`'s header and
  // `lib/sessionLookup.ts`'s), which hangs the suite rather than failing it.
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
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
      await launchTaskSession(
        activeSpacePath,
        task,
        destination.slug,
        catalogs,
      );
    } catch (err) {
      useTasks.setState({ error: describeIpcError(err) });
    }
  };

  /** The `launchStep` prop for one card, or `undefined` for "no pill".
   *
   *  The next step comes from `lib/workflowGraph`'s `nextStepOf` — the ONE
   *  derivation, now shared with the detail modal's buttons and with the
   *  auto-advance runtime. This file used to spell it here and `TaskDetailDialog`
   *  spelled it again; the comment here used to call that out and name the
   *  extraction to make once a third surface needed it. That surface arrived, the
   *  extraction was made, and the semantics (the `nextSlugs ?? sortOrder + 1`
   *  fallback, `[]` meaning "leads nowhere", an unresolvable edge yielding no pill)
   *  are pinned in `lib/workflowGraph.test.ts` rather than re-derived per surface.
   *
   *  The gate lives HERE rather than inside the card because the card holds no
   *  catalog — and the gate is the one fact about the pill a card cannot work out
   *  for itself. A destination with NO Skill is `launchReady: true` outright:
   *  nothing is waiting, so it renders on the first paint. */
  const launchStepFor = (
    column: StageWithTasks,
    task: TaskRow,
  ): TaskCardProps["launchStep"] => {
    const destination = nextStepOf(columns, column.stage);
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
  const handleTaskCreated = (
    _task: TaskRow,
    sessionId: string | null,
  ): void => {
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

  // …AND it re-reads when a TURN SETTLES, which is what makes a card the MODEL wrote
  // show up without a visit. Gap §2 item 3 of `docs/features/task-board-known-gaps.md`;
  // the trigger's evidence, the debounce and the silent-read decision are all at
  // `hooks/useTaskBoardAutoRefresh`, and the non-vacuity proof is
  // `TasksBoardAutoRefresh.test.tsx`. The board already subscribes to the sessions
  // store for `activeSpacePath`, so this hook adds a map to a subscription the surface
  // already holds rather than a new store.
  useTaskBoardAutoRefresh(activeSpacePath);

  // A STABLE array identity across renders that did not change the board. Both drag
  // hooks take the board as an argument and their handlers close over it, so a fresh
  // `?? []` every render would rebuild every handler every render — the same reason
  // `SpacesList` hoists `NO_SESSION_IDS` to module scope.
  const stages: readonly StageWithTasks[] = useMemo(
    () => columns ?? [],
    [columns],
  );

  // THE LIVE SESSION MARK, computed ONCE for the whole board.
  //
  // The union of every VISIBLE card's linked session ids goes into ONE
  // `useSessionStatuses` call and the answer is read back per card by
  // `sessionStatusFor` below. Two reasons, both already argued in this tree:
  //
  //  - a hook cannot be called inside the `stages.map(...)` → `TaskColumn` →
  //    `card.tasks.map(...)` chain at a changing list length, which is why
  //    `useSessionStatuses` and the pure `sessionStatusOf` exist as a pair;
  //  - the hook subscribes FIVE stores at once (`sessions` / `inTurn` / `prompts` /
  //    `requests` / `subagents.entries`), so a hook per card would be N
  //    subscriptions to all five and every Session's turn churn would re-render
  //    every card — the subscription-breadth cost `useSessionStatus`'s own header
  //    records for the sidebar rows and names `useSessionStatuses` as the shape the
  //    open list would want. This board takes that shape.
  //
  // The ids come from the cards and NOT from the session list: a card's mark
  // answers a question about ITS links, so a board whose every card wore the status
  // of some unrelated waiting Session would be a second answer to "what is blocked
  // on me" — and a wrong one, since the card is a Task and not a Session.
  //
  // `useMemo` on the card set, so the id array's identity is stable across renders
  // that did not change the board — the same reason `stages` and `spacePaths` are
  // memoised here and in `SpaceTabs` (a fresh array every render re-runs the hook's
  // per-id loop for the same answer).
  const linkedSessionIds = useMemo(
    () => [
      ...new Set(
        stages.flatMap((column) =>
          column.tasks.flatMap((card) =>
            card.sessions.map((link) => link.sessionId),
          ),
        ),
      ),
    ],
    [stages],
  );
  // The ONE read. `TaskDetailDialog` calls the same hook for its own session list
  // and `SpaceTabs` for the whole strip: three surfaces, one subscription each, and
  // never one per row.
  const statusById = useSessionStatuses(linkedSessionIds);

  /** The `sessionStatus` prop for one card, folded out of that card's OWN linked
   *  Sessions, or `null` for "nothing to report".
   *
   *  The PRECEDENCE is not spelled here. `sessionStatusRollupOf` is the ONE rollup,
   *  shared with `SpaceTabs`, so a `?` cannot mean one thing on a tab and another on
   *  a card two hundred pixels below it; the extraction and its reasoning are at
   *  `lib/sessionStatusRollup`.
   *
   *  A FUNCTION and not a pre-built map, for the reason `launchStepFor` gives for
   *  itself: the column renders N cards and each card's answer is its own. The card
   *  stays presentational and takes the value — it holds no store and no
   *  derivation, which its own test pins against source. */
  const sessionStatusFor = (card: TaskCardView): SessionStatus | null =>
    sessionStatusRollupOf(
      card.sessions.map((link) => statusById[link.sessionId]),
    );

  // THE `ready` MARK, read ONCE for the whole board — one subscription, the same
  // shape `statusById` above takes.
  //
  // A SELECTOR returning a PRIMITIVE (`boolean`), not an object or an array: a
  // selector whose result is a fresh reference every call makes zustand re-render
  // forever (the rule `useActiveSpaceCwd.ts` and `lib/sessionLookup.ts` record).
  // The map itself is what is subscribed, because the per-card answer needs every
  // card's links, which the selector does not have at selector time.
  //
  // The interactive store is one this board ALREADY subscribes to — through
  // `useSessionStatuses`, which reads `requests` out of it — so this is not a new
  // store on the board, it is a second map out of a store the board is already
  // bound to.
  const readyBySession = useInteractive((s) => s.ready);

  /** The `ready` prop for one card: does ANY linked Session's board carry the
   *  marker?
   *
   *  ANY, and the reason is the same one the sessions chip and the money give: a
   *  card is a Task and it can own several Sessions, and "one of my Sessions is
   *  finished and waiting for a look" is the fact a person acts on. Two Sessions
   *  marked ready is one mark, not two — the card is a two-line summary by
   *  construction and `TaskDetailDialog` is the surface that lists the Sessions
   *  individually.
   *
   *  A FUNCTION and not a pre-built map, for the identical reason `sessionStatusFor`
   *  gives: the column renders N cards and each card's answer is its own. The card
   *  stays presentational and takes the value.
   *
   *  The board hands over the FACT and does not resolve the mark. `ready` and
   *  `sessionStatus` are two inputs to ONE glyph, folded by `cardMarkOf` at the
   *  card; the board holds neither the precedence nor a reason to own it, and
   *  `sessionStatusRollupOf`'s 3-way answer is untouched because `ready` never
   *  entered it. (This comment used to claim the opposite — that both marks render
   *  whenever both are true. That pairing is what the owner rejected on a real
   *  board; see `TaskCardProps.ready`.) */
  const readyFor = (card: TaskCardView): boolean =>
    card.sessions.some((link) => readyBySession[link.sessionId] === true);

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
            Disabled with no Selected Space — literally no Space open (a Space
            with zero Sessions still enables this): `createTask(null, …)` is not
            a thing, and a dead button that opens a modal which cannot send is
            worse than one that says nothing is open. */}
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
        {/* The **Configure** door, beside `New task` and AFTER it: create first,
            configure second. Same ghost/idle-ink recipe as its neighbour so the two
            read as one pair of quiet header affordances rather than one primary
            action and one loud one, and the SAME disabled rule — with no Selected
            Space (literally no Space open) there is no column set to edit, and a
            button that navigates to a surface whose every write has no target is
            worse than one that says nothing is open.

            IT IS A NAVIGATION NOW and not a dialog. The canvas's settings panel
            (`workflows/NodeSettingsPanel.tsx`) is the ONE editor for the stage
            fields, so this door calls `onOpenWorkflows` — `App`'s
            `setView("workflows")` — instead of mounting anything. The label stays
            `Configure` rather than becoming `Open workflows`: the capability a
            person is after is unchanged, only where it lives moved, and a door that
            changes its name at the same moment it changes its destination is a door
            that reads as removed.

            WHY NOTHING IS EDITED ON THE BOARD ITSELF. A column header is a flex row
            of spans INSIDE the drop-target `<div>` that carries
            `useDragCard.columnProps()`, and `draggable` inherits to children — the
            hazard `TaskCard.tsx` records for the card itself. Clicking a label to
            rename it inside a drop zone is how "the rename starts a drag" gets
            written, so every stage edit lives behind this door. */}
        <Button
          type="button"
          variant="ghost"
          size="default"
          aria-label="Configure"
          className="h-8 shrink-0 gap-2 rounded-lg px-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          disabled={activeSpacePath === null}
          onClick={() => onOpenWorkflows?.()}
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
          <span className="min-w-0 flex-1 text-ui-sm text-warning">
            {boostNote}
          </span>
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
                sessionStatusFor={sessionStatusFor}
                readyFor={readyFor}
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
          ready={readyFor(detailCard)}
          onClose={() => setDetailTaskId(null)}
          onOpenSession={openSessionAndLeave}
          onLaunched={() => onReturnToWorkspace?.()}
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
