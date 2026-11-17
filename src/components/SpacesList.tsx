import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BotIcon,
  ListTodoIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import {
  type ModelDto,
  type SessionInfo,
  listModels,
  listTools,
} from "../lib/tauri";
import { sessionFieldOf } from "../lib/sessionLookup";
import { titleFor } from "../lib/sessionTitle";
import { useSessions, spaceViewFor } from "../store/sessions";
import { useDragReorder } from "../hooks/useDragReorder";
import { useSkillCatalog } from "../hooks/useSkillCatalog";
import { useAgentCatalog } from "../hooks/useAgentCatalog";
// The Agents modal's write chain (D2): the optimistic publish, the serialized
// saves, the publish epoch and the rollback-on-failure, with the settings
// document the dialog's render gate reads.
import { useAgentOverridesWrites } from "../hooks/useAgentOverridesWrites";
import SkillsDialog from "./SkillsDialog";
import AgentsDialog from "./AgentsDialog";
import DeleteSessionDialog from "./DeleteSessionDialog";
import { EmptyListLine } from "./EmptyListLine";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";
// The two row components and the **Archived** section are their own files now.
// The class consts and `spaceNameFor` they share with THIS pane live in
// `sessionRowStyles` — see the note there on why those three values have more
// than one owner and therefore need one.
import { SessionRow } from "./spaces/SessionRow";
import { ArchivedSection } from "./spaces/ArchivedSection";
import { spaceNameFor } from "./spaces/sessionRowStyles";

/**
 * THE SIDEBAR'S WIDTH — the pane owns it, because the pane is what wears it.
 *
 * The ONE reader outside this file is `App`: the chrome bar's logo segment (the
 * drag region) is the sidebar's width, so the tabs start 1px right of the
 * sidebar's right edge, where the center column begins. That is why this is a
 * shared exported constant and not a local `w-[260px]`: the segment and the
 * pane must be the SAME number, and two literals spelling 260 would drift the
 * moment one of them changed. (`App.test.tsx`'s
 * `the tabs start 1px right of the sidebar's right edge` pins the geometry that
 * depends on it — no left padding on the bar itself, so the segment's width IS
 * the tabs' offset.)
 */
export const LEFT_PANE_WIDTH = 260;

/**
 * THE SIDEBAR'S FOUR LABELLED COMMAND BUTTONS (Tasks, Skills, Agents, Settings) — one ghost
 * `<Button>` recipe, spelled ONCE because all four draw the identical box. (The two
 * that used to ride this recipe — `Open Space` and `New Session` — are gone: the
 * first left the sidebar for the chrome bar, the second is now the `+` in the
 * `Sessions` header, which is an icon button and does NOT use this recipe.)
 *
 * The four now live in TWO boxes, not one strip: **Tasks** above the list (D2) and
 * **Skills / Agents / Settings** in the band below it (D1). That is a POSITION change
 * only — every one of them still takes this recipe verbatim, which is exactly the
 * point of spelling it once: a move like that touches two `className` call sites and
 * no button's own shape.
 *
 * The FIRST argument is what `Button`'s base and the `default` size would add
 * that these two never had, and each entry only names a group the row below
 * does NOT spell (so the row always wins a group it owns — see C7's recipe):
 *  - `border-0` — the base's `border` is a 1px ring; with `h-8` it would make
 *    the row 34px and inset the label by 1px. `border-0` removes the width
 *    outright (the base's `border-transparent` alone keeps 28px→30px).
 *  - `justify-start` — the size centres content; these rows are labelled and
 *    read left-to-right (the label carries the `flex-1` that pushes any trailing
 *    element to the end — the chord `Kbd` chips that used to sit there are gone).
 *  - `transition-none` — the base fades hover colour over 150 ms; this band
 *    has never had a fade, and it stays as drawn.
 *  - `select-auto` — the base makes the label unselectable.
 *  - `whitespace-normal` — the base's `whitespace-nowrap` is a REAL repaint
 *    here, not a cosmetic one: the original row inherited `white-space: normal`
 *    from its container, so a label long enough for a narrow pane wrapped. The
 *    base would force it onto one line and overflow the 244px column.
 *  - `shrink` — the base's `shrink-0` is `flex-shrink: 0`. The parent is a
 *    `flex flex-col` box, so shrink applies to HEIGHT here, and a short pane
 *    would otherwise stop these two from compressing as they always have.
 *    `shrink` is `flex-shrink: 1`, i.e. the value they had before.
 *  - `[user-select:auto]` — the base's `select-none` makes the label
 *    unselectable. The two spellings are NOT interchangeable and the difference
 *    is which mechanism resolves it (measured against the built sheet and the
 *    real `cn()`): `select-auto` is the SAME tailwind-merge group as
 *    `select-none`, so naming it makes the merge DROP `select-none` — the merge
 *    decides. `[user-select:auto]` is an arbitrary property, a different group,
 *    so BOTH survive the merge and the CASCADE decides; `.select-none` sits at
 *    offset ~45.8k in the built sheet and `[user-select:auto]` is emitted after
 *    it (~45.9k), so this wins. Note `.select-auto` is emitted BEFORE
 *    `.select-none` (~45.7k) — so if the merge ever stopped dropping
 *    `select-none`, the plain `select-auto` spelling would lose the cascade and
 *    the label would go unselectable with nothing failing in jsdom.
 *
 * NO line-height negation is needed, and adding one would be dead code: the
 * base's `text-ui-base/relaxed` carries BOTH the size and `line-height: 1.625`,
 * and the row spells `text-ui-base` — measured, `cn("text-ui-base/relaxed",
 * "text-ui-base")` keeps only `text-ui-base`, i.e. the row's utility deletes
 * the base's whole compound, line-height included. So the row ends up with no
 * `line-height` declared at all and inherits preflight's
 * `html{line-height:1.5}` — exactly what it inherited before. (A
 * `leading-[1.5]` placed before the row is itself deleted by that same
 * `text-ui-base`, which is why it is absent rather than redundant.)
 *
 * NOT in the wall, because the row string spells it and comes LAST, so the row
 * already wins it: `hover:bg-surface-hover` (the ghost arm's `hover:bg-hover`
 * is a DIFFERENT colour in three palettes — default-dark and Dracula read 5%
 * against surface-hover's 10% — so this is exactly the conflict the recipe
 * exists for, and the row resolves it).
 *
 * The rest of the base is inert HERE, and the reason per token:
 *  - `bg-clip-padding` — no background is painted at rest;
 *  - `outline-none` — `base.css:53-57` already forces
 *    `outline: none !important` on every `:focus`/`:focus-visible`, in every
 *    browser and again under `forced-colors`;
 *  - `disabled:*` / `aria-invalid:*` / `aria-expanded:*` — none of these two
 *    is ever disabled, nothing sets `aria-invalid` on them, and none carries
 *    `aria-expanded`, so the arm's `aria-expanded:bg-hover` has no element to
 *    fire on;
 *  - `[&_svg]:pointer-events-none` — the handler is on the button, so the click
 *    is handled either way;
 *  - `[&_svg]:shrink-0` — the icons are fixed `size-4`;
 *  - `[&_svg:not([class*='size-'])]:size-3.5` — every icon here is created with
 *    an explicit `size-4`, so the `:not([class*=size-])` guard excludes all of
 *    them (this is the C2 chrome-bar trap, and it does not bite here);
 *  - `has-data-[icon=inline-*]:pr/pl` — no child carries `data-icon`
 *    (lucide-react v1.47's `createLucideIcon` sets no such attribute, and the two
 *    rows' only children are a lucide icon and a plain `<span>` label).
 */
const SIDEBAR_COMMAND_BUTTON =
  "border-0 justify-start transition-none whitespace-normal shrink [user-select:auto]";

/**
 * The box the sidebar command buttons drew, VERBATIM, before C7 routed
 * them through `<Button>`. It is the SECOND argument to `cn()` at every one of
 * the four sites, so it wins every tailwind-merge group it spells against
 * `Button`'s base and the `default` size — that ordering is what makes the swap
 * paint-neutral, and it is why this string is kept whole rather than folded
 * into the constant above. `hover:bg-surface-hover` is one of them: the ghost
 * arm's `hover:bg-hover` is a DIFFERENT colour in three palettes (default-dark and
 * Dracula read 5% where `--color-surface-hover` reads 10%), so letting the arm
 * win that group would repaint the hover fill.
 *
 * `h-8 w-full` is ALSO why the two view doors can wear this and not the chrome
 * grammar: `chromeButton.test.ts`'s source gate reserves
 * `h-7 w-7 items-center justify-center` for `chromeButton.ts` alone.
 */
const PANE_COMMAND_ROW =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui-base hover:bg-surface-hover";


/** The row ids while NO **Space** is selected. A module-level constant rather
 *  than an inline `?? []`, so the array's IDENTITY is stable across renders in
 *  that case — see `rowIds`. */
const NO_SESSION_IDS: string[] = [];


export default function SpacesList({
  onOpenBoard,
  onOpenSettings,
  onReturnToWorkspace,
  currentView = "workspace",
}: {
  /** Open the **Task board** (`App`'s `"board"` view). OPTIONAL, and the optionality
   *  is load-bearing rather than convenient: the overwhelming majority of this pane's
   *  render sites in its two test files call bare `<SpacesList />` (`grep -rn
   *  'render(<SpacesList' src | grep -c 'SpacesList />'`, re-countable — it is a
   *  property of the test list, not a constant), and a required prop would break every
   *  one of them for a prop only `App` can answer. Absent means the button is a NO-OP
   *  rather than a crash.
   *
   *  The `= {}` default is what keeps those bare call sites legal.
   *
   *  THE THREE PROPS BELOW SHARE THAT RULE, for the same reason: this pane's command
   *  surfaces are the app's view switcher now, and only `App` knows which view is up. */
  onOpenBoard?: () => void;
  /** Open the **Settings** view. The door that used to sit in the chrome bar's
   *  `ChromeControls` (deleted) — this pane's command band is its only home, so the
   *  pane holds the app's ONE route to the settings page. */
  onOpenSettings?: () => void;
  /** Leave the current view for the workspace. THE TOGGLE-OFF HALF of both view
   *  doors: clicking the door that is already pressed is how you exit Settings or
   *  the **Task board**, and a **Session** row click calls it too. Together those
   *  two routes give every view two exits (N1), so no view is a dead end and the
   *  pane needs no control of its own to get home. */
  onReturnToWorkspace?: () => void;
  /** Which view `App` is showing, so the two view doors can render pressed and
   *  toggle off. Defaults to `"workspace"` — the state a bare render is in.
   *
   *  NOT `activeView`: that name is already this component's local for the ACTIVE
   *  **Space**'s folder view (see below), which feeds `rowIds`. */
  currentView?: "workspace" | "settings" | "board";
} = {}) {
  // THE COMMAND SURFACES ARE THE VIEW SWITCHER. The Settings door moved here from
  // the chrome bar's control cluster (`ChromeControls`, deleted): the pane is
  // permanent across all three views since ADR 0094, so the door that opens a view
  // can also be the door that closes it, and the top-right of the window is left to
  // the window controls alone.
  const spaces = useSessions((s) => s.spaces);
  const sessions = useSessions((s) => s.sessions);
  const historySessions = useSessions((s) => s.historySessions);
  const archivedSessions = useSessions((s) => s.archivedSessions);
  const closeReasons = useSessions((s) => s.closeReasons);
  const sessionRecency = useSessions((s) => s.sessionRecency);
  // THE Task BADGE map (spec D3/D12): boot-fetched wholesale and replaced wholesale,
  // so the pane reads it ONCE and hands it DOWN to both row kinds — exactly the way
  // `sessionRecency` above is read once and handed down as `recencyMap`. A per-row
  // `useSessions((s) => s.taskNumbers[sessionId])` would be a SECOND way to reach a
  // pane-level map from a row, and the row's existing shape says which one stays.
  const taskNumbers = useSessions((s) => s.taskNumbers);
  // The boot order map (ADR 0075): the ONLY thing that lets a LIVE row keep its
  // slot. Read here because `spaceViewFor` needs it as an argument — the pane
  // does not otherwise care about position, and T04 renders `sessionIds`
  // straight through.
  const sessionOrder = useSessions((s) => s.sessionOrder);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
  const openSession = useSessions((s) => s.openSession);
  const deleteSession = useSessions((s) => s.deleteSession);
  // THE new-session command (Task 2's store action). This pane no longer decides
  // what "no Space selected" means — the command does, and it routes that case to
  // the Open Space dialog itself. That is why every new-session surface
  // (the `Sessions` header's `+` and the root ⌘N
  // chord) is now the same one call and cannot drift apart.
  const startSessionInActiveSpace = useSessions(
    (s) => s.startSessionInActiveSpace,
  );
  // The Skills modal (the left pane has NO skill list — ZCode parity: the
  // skills UI is a searchable modal, opened from the first of the row's two
  // remaining buttons). The catalog fetch lives in `useSkillCatalog` below (the modal
  // receives the rows as props — same hook key as the composer → one
  // shared fetch).
  const [skillsOpen, setSkillsOpen] = useState(false);
  // The Agents modal (ADR 0066 / ADR 0068) — the ONE Agent surface, mounted
  // beside Skills with the SAME shape: the fetch lives in `useAgentCatalog`, the
  // dialog takes rows as props. The settings document and the `agentOverrides`
  // write path come from `useAgentOverridesWrites` below — this mount is still the
  // only place that owns a write path, the hook is where that path now lives.
  const [agentsOpen, setAgentsOpen] = useState(false);

  // The `spaces` arrive in the MANUAL order (`list_spaces` reads the stored
  // order column), and `views = spaces.map(spaceViewFor)` INHERITS it — so the
  // tab strip and the sidebar's group order cannot disagree (spec §4). Nothing
  // here sorts, and no database column name belongs in this file.
  const views = useMemo(
    () =>
      spaces.map((s) =>
        // `{ recency }` only, on purpose: subscribing this pane to the whole
        // `messages` map would re-render the entire list on every streamed token
        // (the hazard this call site has always avoided, and still does — a ROW
        // subscribes to its own transcript, the LIST subscribes to none). The
        // boot recency map is the same SQL expression, so the close-reason
        // banner's Landing Session is decided on the same number, just read at
        // boot.
        spaceViewFor(s, sessions, historySessions, closeReasons, archivedSessions, {
          recency: sessionRecency,
        }, sessionOrder),
      ),
    [spaces, sessions, historySessions, closeReasons, archivedSessions, sessionRecency, sessionOrder],
  );
  // The ACTIVE SPACE's view — the ROW LIST's source (`sessionIds`, the rows
  // themselves and every row's Space name), NOT a new-session input any more.
  // `⌘N` used to branch on it (`undefined` → the
  // Open Space dialog); the store's `startSessionInActiveSpace` owns that
  // routing now, so this is pure derivation for the list.
  // `undefined` while no Space is selected (no Spaces yet, or the last one was
  // removed) — which is also why the list renders nothing.
  const activeView = views.find((v) => v.path === activeSpacePath);
  // Why the last new-session attempt failed (`null` when it did not fail) — the
  // sidebar's `New Session` `+` button's `title`, so a dead control says why. It
  // replaced the deleted `useStartNewConversation` hook's local `error` state: the
  // command lives in the store now, so its failure has to be readable from the
  // store too.
  const newSessionError = useSessions((s) => s.newSessionError);
  // NO ordering subscription here, on purpose (ADR 0075): the pane used to
  // subscribe to each row's last message stamp — as a primitive key, so
  // streaming would not re-sort it — purely so it could re-rank the rows for
  // display. The order now comes from the store (`sessionIds`) already settled,
  // so the pane reads NOTHING about activity for position. A ROW still
  // subscribes to its own transcript for its time label; that is per-row and
  // does not move a slot.
  // The ROW ids — a field read off the active view, not a second construction of
  // the same order (ADR 0075). The single-construction rule is what keeps the
  // DRAG and the ROWS in positional agreement: "the Nth draggable is the Nth
  // row", and two derivations of one order is two things that can drift. No
  // `useMemo`: this is a field read, and the module-level empty array keeps the
  // input identity stable while no Space is selected.
  const rowIds = activeView?.sessionIds ?? NO_SESSION_IDS;
  // THE DRAG, over that SAME array. `rowIds` IS `activeView.sessionIds` (one
  // construction of the Manual order — see the note above), so the gesture and
  // the rows read ONE sequence and cannot disagree about
  // which row is which. The pane holds NO order state of its own: the write is
  // the store's optimistic `reorderSessions`, whose own rollback restores the
  // slice it captured before the write (ADR 0075's Write path), and the gesture
  // is T05's hook, which already answers the before/after question so nothing
  // here computes an index.
  const reorderSessions = useSessions((s) => s.reorderSessions);
  const handleReorder = useCallback(
    (ids: string[]) => void reorderSessions(ids),
    [reorderSessions],
  );
  const drag = useDragReorder({ ids: rowIds, onReorder: handleReorder });

  // The active space's path for the skill catalog (a Session's `cwd` IS
  // the Space's folder — CONTEXT.md): the SELECTED space (the tab), or
  // `null` when none is selected (the catalog degrades to user-level
  // skills — the hook's `null` handling).
  const skills = useSkillCatalog(activeSpacePath);
  // The Agent definitions the ACTIVE Space can see (`cwd: null` → the user-level
  // set). The override map the modal edits is GLOBAL and identical from every
  // Space — the Space decides only which definitions get LISTED.
  const agentRows = useAgentCatalog(activeSpacePath);
  // The settings document used to be read here (`useSettings((s) => s.settings)`);
  // it now comes back from `useAgentOverridesWrites` below, which reads the same
  // store through the same selector — the dialog's render gate and its write path
  // are one owner.
  // The Agents modal's two catalogs, fetched ONCE on mount into local state —
  // the `SettingsPage.tsx` pattern, deliberately with no cache of its own (a
  // second module-level cache for two lists the modal reads on open would be
  // staleness for free).
  const [models, setModels] = useState<ModelDto[]>([]);
  const [toolNames, setToolNames] = useState<string[]>([]);
  useEffect(() => {
    listModels()
      .then(setModels)
      .catch(() => {});
    listTools()
      .then(setToolNames)
      .catch(() => {});
  }, []);

  // The Agents modal's ONE write path for `agentOverrides` — D2 moved the chain
  // (optimistic publish, serialized saves, the publish epoch, the rollback) into
  // `useAgentOverridesWrites`, because the chain is the modal's contract and not
  // this pane's: it is pinned property-by-property in
  // `hooks/useAgentOverridesWrites.test.ts`, and `SpacesList.test.tsx` (with the
  // two characterisation pins at the end of its Agents block) is the proof the
  // move preserved the behaviour. The hook also owns the settings document this
  // pane reads for the dialog's render gate — same store, same selector, one
  // fewer place that knows where the document comes from.
  //
  // What is NOT in the hook and stays named here: nothing. The epoch capture
  // moved with the chain rather than staying at a call site, because the link
  // that reads it moved too — splitting the two would put the counter and its
  // consumer in different files for no gain.
  const { settings, rolledBackWrites, patchAgentOverrides } =
    useAgentOverridesWrites();

  // The session awaiting delete confirmation (the ONLY destructive
  // action in the sidebar — archive/unarchive are reversible and have
  // no confirm). `null` = no dialog. (The selector is unconditional and
  // returns stable references — `undefined` or the transcript array —
  // so Zustand does not re-render in a loop.)
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const deleteTargetMessages = useSessions(
    (s) => (deleteTarget ? s.messages[deleteTarget.sessionId] : undefined),
  );
  // The title comes from the LIVE row, not the frozen `deleteTarget` snapshot —
  // a title minted by the naming pass while this dialog is open must relabel it
  // (the snapshot would keep naming the session the way it looked at click time).
  // `sessionFieldOf` is a primitive selector over the one three-list walk, so
  // this does not fall foul of the fresh-object re-render rule (sessionLookup.ts).
  const deleteTargetStoredTitle = useSessions((s) =>
    sessionFieldOf(s, deleteTarget?.sessionId, "title"),
  );
  const deleteTargetTitle = deleteTarget
    ? titleFor(
        deleteTargetMessages,
        spaceNameFor(deleteTarget.cwd, spaces),
        deleteTargetStoredTitle ?? deleteTarget.title,
      )
    : "";

  // The ONE new-session closure, STABLE because `startSessionInActiveSpace` is a
  // store action (stable across renders) — the `Sessions` header's `+` calls it,
  // and so does the root ⌘N chord's handler, so the two renderings of the
  // command cannot drift
  // apart. It replaces the old pair, where `useStartNewConversation` returned a
  // FRESH object every render and so re-subscribed the pane's keydown listener on
  // every render; the listener is gone (it lives at `App` root now) and so is the
  // churn. There is no `Open Space` handler here any more: that command left the
  // sidebar, and the store routes the no-Space case to the dialog itself.
  const handleNewSession = useCallback(
    () => void startSessionInActiveSpace(),
    [startSessionInActiveSpace],
  );

  // THE ROW CLICK — open the Session, then leave whatever view is up.
  //
  // This is the second exit every view has (N1) and it REVERSES ADR 0094's D8,
  // which kept Settings open across a row click. That was coherent while the pane
  // merely COEXISTED with Settings; once these command surfaces ARE the view
  // switcher, "show me this Session" necessarily includes leaving the page that is
  // covering the transcript — a row that opened a Session you could not see was the
  // bug D8 traded away.
  //
  // The order mirrors the recipe `SessionsSection`'s Reopen already documents
  // (`addSpace → openSession → onReturnToWorkspace()`): open, then leave. Both
  // are synchronous store/`App` state updates, so the order is for consistency
  // with that documented recipe and NOT for correctness — either order lands on
  // the same paint.
  //
  // One wrapper, both row types: the live/stored rows and the **Archived** section
  // take it as `onOpen`, so the exit cannot exist on one and be missing from the
  // other. The hover actions inside a row (`Stop` / `Archive` / …) call their own
  // commands and never route through here, which is right — archiving a Session is
  // not a request to change the view.
  const openSessionAndReturn = useCallback(
    (sessionId: string) => {
      openSession(sessionId);
      onReturnToWorkspace?.();
    },
    [openSession, onReturnToWorkspace],
  );


  // The ⌘N / ⌘O chord lives in `useAppShortcuts`, mounted at `App` root — NOT
  // here. It sat in this component while, and this pane is inside the
  // `view === "settings"` ternary's else-branch, so the Settings page unmounted
  // the listener and both chords stopped existing there. `App.test.tsx` pins the
  // chord from that view, and `useAppShortcuts.test.ts` owns the guard cases.

  return (
    // The pane is PERMANENT: `LEFT_PANE_WIDTH`, always. It used to be able to
    // collapse to a 40px sliver that kept the session marks and the command
    // icons drawing; that collapsed state is retired (the panes are permanent
    // surfaces), so the frame is one width and the `overflow: hidden`
    // is only what keeps a long label from pushing the center column. The pane's
    // collapse toggle is NOT here — there is no such control anywhere any more —
    // which is also why the footer row this pane used to end with is gone. The
    // app's ONE control (the Settings door) IS in here, but NOT at the top any
    // more: the commands are split across TWO surfaces inside the content region,
    // **Tasks** alone above the list (D2) and the **Skills / Agents / Settings**
    // band pinned below it (D1). The sentence this replaces said the door was "the
    // second of the four commands in the strip at the top", which stopped being
    // true the moment the band moved — read the band's own comment for why.
    <aside
      style={{ width: LEFT_PANE_WIDTH }}
      className="relative flex shrink-0 flex-col overflow-hidden bg-frame"
    >
      {/* THE CONTENT REGION — the Tasks command, the `Sessions` header, the list
          and the command band below it. It used to carry an `invisible` class while
          the pane was collapsed, and that class was load-bearing THEN: clipping alone
          let the content paint INTO the 40px sliver (the buttons wrapped to one word
          per line, the `Sessions` header became "Sess", and the scroller grew a
          SCROLLBAR in a 40px column). Nothing clips now, so nothing hides — the
          wrapper stays a plain flex column, and it survives as an element because the
          layout below (a `flex-1` scroller inside a `flex-1` column, with a
          `shrink-0` band after it) needs the nesting. */}
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3">
        {/* The Task board's door, and it is now the ONLY command ABOVE the list (D2):
            the pane reads tasks, then sessions. It joined the labelled commands after
            **Agents** (spec §3) and was later moved to the front — the board is where
            work starts, and a door below three others is a door nobody finds. It now
            sits alone in this box: the other three moved BELOW the scroller (D1), so
            the adjacency the original order defended (Settings next to Tasks, the two
            modal commands together) is gone entirely. Nothing reads neighbours — see
            the band's comment for what the KIND split still carries.
            It is a COMMAND button and NOT a section header like
            `Sessions`, because a board is one surface rather than a list of rows —
            so it takes the shared recipe verbatim and owns no chevron, no count and
            no list. `ListTodoIcon` is lucide's kanban glyph for a list of work
            items; the label is the word a person says.

            The same two halves as **Settings**: pressed while the board is up, and
            clicking the pressed door leaves it. The guard is on the door's OWN view
            and not on `currentView === "workspace"`, so board → Settings is one
            click rather than a trip back through the workspace. */}
        <Button
          type="button"
          variant="ghost"
          size="default"
          aria-pressed={currentView === "board"}
          onClick={() =>
            currentView === "board" ? onReturnToWorkspace?.() : onOpenBoard?.()
          }
          className={cn(
            SIDEBAR_COMMAND_BUTTON,
            PANE_COMMAND_ROW,
            currentView === "board" && "bg-selected",
          )}
        >
          <ListTodoIcon className="size-4" />
          <span className="flex-1 text-left">Tasks</span>
        </Button>
      </div>
      {/* The Sessions header: the label + the `New Session` `+` (right-aligned,
          next to the word `Sessions`). This replaces the `...` menu that used to
          sit here — the menu held exactly ONE item (`New Session in this Space`),
          so the affordance was a two-step gesture to reach one command. It is the
          same store action through the same closure the root ⌘N chord calls, so the
          no-Space dialog fallback comes from the store and is not re-decided here. */}
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="text-ui-base text-foreground-subtlest">Sessions</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New Session"
          title={newSessionError ?? "New Session  ⌘N"}
          onClick={handleNewSession}
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      {/* The list scroller (inside the content region above — the region is the
          flex column, this is the part that scrolls). */}
      <div className="flex-1 overflow-y-auto">
        {views.length === 0 && (
          <EmptyListLine>No spaces yet. Open a folder to get started.</EmptyListLine>
        )}
        {/* The ACTIVE space's sessions (the Spaces are the top TABS —
            the sidebar is sessions-only: no group headers, no folder
            icons, no `+`, no trust shield, no collapse chevrons — the
            list just scrolls). The rows render the MANUAL order: ONE
            sequence spanning live and stored (`activeView.sessionIds`),
            with no group headers — a row's live-ness stays visible as its
            `SessionStatusMark`, never as its position. The row's time is the
            ONE recency number (`recencyOf`: its last message, else the boot
            map's stamp), and it is deliberately DECOUPLED from its slot
            (pinned by "updates a row's relative time while its POSITION stays
            frozen").

            A ROW IS THE DROP TARGET (spec §Drag mechanics): `drag.dragProps(id)`
            rides through `SessionListRow` into `RowButton`'s `...rest`, and the
            row under the pointer wears the ONE edge class the hook's `overEdge`
            names. The target test is `drag.overId === id`, NOT `overEdge` alone —
            the hook keeps the two as separate answers precisely so a call site
            cannot paint the current edge on every row. Nothing here computes an
            index, and nothing here sorts.

            `onOpen` IS THE WRAPPER (open, then leave the view) and `active` is
            GATED by `currentView` (N1): while a peer view's door is pressed the
            pane is not "where you are", so no row may wear the selection fill.
            The store's `activeSessionId` is untouched — dimming the RENDER, not
            the fact — so toggling the door off brings the mark straight back. One
            visible consequence, and it is intended: the row's `SessionStatusMark`
            takes brighter ink on the active row, so its ink dims along with the
            fill. */}
        {activeView && (
          <div className="flex flex-col gap-0.5">
            {activeView.sessionIds.map((id) => (
              <SessionRow
                key={id}
                sessionId={id}
                spaceName={activeView.title !== "" ? activeView.title : activeView.path}
                active={currentView === "workspace" && activeSessionId === id}
                onOpen={openSessionAndReturn}
                drag={drag.dragProps(id)}
                dropEdge={drag.overId === id ? drag.overEdge : null}
                recencyMap={sessionRecency}
                badgeMap={taskNumbers}
              />
            ))}
          </div>
        )}
        {/* The **Archived** section reaches the same two rules through the OTHER
            pair of sites, and deliberately not the same TECHNIQUE: its rows gate
            on the `activeSessionId` this call site hands it (`null` while a peer
            view is pressed — `null` is already in that prop's type union, so no
            new prop is needed) rather than on an `active` ternary of their own,
            and its `onOpen` is the same wrapper. The shared `activeSessionId`
            variable is never nulled — other code reads it. */}
        <ArchivedSection
          activeSessionId={currentView === "workspace" ? activeSessionId : null}
          onOpen={openSessionAndReturn}
          onDelete={setDeleteTarget}
          badgeMap={taskNumbers}
        />
      </div>
      {/* THE COMMAND BAND — Skills / Agents / Settings, pinned BELOW the scroller and
          deliberately NOT inside it (spec D1). A door that scrolls off the bottom of a
          long Session list is a door that is not there: this is the failure ADR 0095
          exists to end, which was the Settings gear sitting in the chrome bar's
          `view === "settings"` ELSE-arm and so absent on the very view it opened.
          Also NOT a sibling of the content region — that would make it the `<aside>`'s
          `lastElementChild` and redden the pin that says the pane ends with the content
          region. Tasks stays ABOVE the list (D2): the pane reads tasks, then sessions.

          The three `<Button>s below are the strip's old second, third and fourth
          commands MOVED VERBATIM — same `variant`, `size`, `aria-pressed` (Settings
          only), `onClick` guards, class lists, icons and labels. Only their position
          changed, so every behaviour pin in `SpacesList.test.tsx` and `App.test.tsx`
          (which reaches the doors by NAME, and is position-independent) still reads.

          **Skills** — the left pane has NO skill list (ZCode parity: a searchable
          modal, and the catalog fetch lives in `useSkillCatalog` above so the composer
          and this modal share ONE fetch). No `Kbd`: it is not a chord, and neither is
          Agents.

          **Agents** — the ONE Agent surface (Settings has no Agents section).
          `BotIcon` moved here from the deleted Settings nav entry.

          **Settings** — the app's ONLY app control, and the reason this band is a view
          switcher rather than a row of commands. It used to be a gear at the far RIGHT
          of the chrome bar (`ChromeControls`, deleted): the pane is permanent across all
          three views (ADR 0094), so the door lives with the other doors, and the bar's
          top-right belongs to the window manager alone. It is LAST in the band, a
          position chosen rather than a leftover, and the KIND difference is what the
          order carries: a modal is not a location, so Skills and Agents raise a dialog
          and carry NO `aria-pressed`; Settings and Tasks name a view, so they say which
          one is showing and toggle off when clicked again. Two exits per view (N1) —
          its own door, or any **Session** row — so no view is a dead end. That is what
          makes the Settings page's own `Back` redundant (it is retired); this pane owns
          no exit control of its own.

          NOT `CHROME_BUTTON`, and that is a gate, not a preference:
          `chromeButton.test.ts`'s source gate requires `chromeButton.ts` to be the ONLY
          production file under `src/components/` carrying the chrome-bar geometry.
          `PANE_COMMAND_ROW` is `h-8 w-full` — the sidebar's box. */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-border p-2">
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => setSkillsOpen(true)}
          className={cn(SIDEBAR_COMMAND_BUTTON, PANE_COMMAND_ROW)}
        >
          <SparklesIcon className="size-4" />
          <span className="flex-1 text-left">Skills</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => setAgentsOpen(true)}
          className={cn(SIDEBAR_COMMAND_BUTTON, PANE_COMMAND_ROW)}
        >
          <BotIcon className="size-4" />
          <span className="flex-1 text-left">Agents</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="default"
          aria-pressed={currentView === "settings"}
          onClick={() =>
            currentView === "settings"
              ? onReturnToWorkspace?.()
              : onOpenSettings?.()
          }
          className={cn(
            SIDEBAR_COMMAND_BUTTON,
            PANE_COMMAND_ROW,
            // "Pressed" is ONE idiom in the pane: the same fill the active Session
            // row wears. The row's `hover:bg-surface-hover` rides along (a different
            // tailwind-merge group, so `cn()` keeps both) — a pressed door still
            // answers the pointer.
            currentView === "settings" && "bg-selected",
          )}
        >
          <SettingsIcon className="size-4" />
          <span className="flex-1 text-left">Settings</span>
        </Button>
      </div>
      {/* CLOSES the content region here, and that boundary is still structural:
          the dialogs below sit OUTSIDE it. They used to have to, because this
          region was `visibility: hidden` while the pane was collapsed and
          visibility inherits into `fixed` descendants — an inside-mount would
          have opened the modal invisibly. The collapse is gone, so nothing
          inherits any more, but the dialogs stay outside: the content region is
          the SCROLLING list's box, and a modal is not list content. */}
      </div>
      {/* NO Open Space dialog here: the render site is `App` root (the else-branch
          of the view ternary unmounts this pane while Settings is open, so a dialog
          owned here was raiseable-but-invisible on that page). The Skills and
          delete-confirm dialogs STAY — they are this pane's own, and raising them
          from the Settings page is not a thing. */}
      {skillsOpen && (
        <SkillsDialog skills={skills} onClose={() => setSkillsOpen(false)} />
      )}
      {/* The Agents modal — OUTSIDE the content region for the same structural
          reason the comment above names: the content region is the list's
          scrolling box, and this modal is not list content (it used to matter
          twice over, because that region was `visibility: hidden` while the pane
          was collapsed and visibility inherits into `fixed` descendants — that
          clip is retired with the collapse).
          `settings &&` is why the button stays clickable while the dialog waits:
          with no settings document there is nothing correct to edit (the modal
          reads `agentOverrides` off it), and `null` here means the boot load has
          not landed or failed. */}
      {agentsOpen && settings && (
        <AgentsDialog
          rows={agentRows}
          noSpaceOpen={activeSpacePath === null}
          settings={settings}
          models={models}
          tools={toolNames}
          // The mount owns the save, so it is the only place that can say "that write
          // did not land". The dialog hands its stored-pin suppression back on that
          // fact — a rolled-back edit explains nothing about the fetch-time column.
          rolledBackWrites={rolledBackWrites}
          onPatch={(next) => void patchAgentOverrides(next)}
          onClose={() => setAgentsOpen(false)}
        />
      )}
      {deleteTarget && (
        <DeleteSessionDialog
          title={deleteTargetTitle}
          onConfirm={() => {
            // The store's `deleteSession` removes the id from ALL lists
            // (live / stored / archived + messages + activeSessionId). The
            // dialog closes on success AND on failure (a stuck-open dialog
            // is worse); a failure is logged (no unhandled rejection).
            deleteSession(deleteTarget.sessionId)
              .then(() => setDeleteTarget(null))
              .catch((err) => {
                console.error("Failed to delete session:", err);
                setDeleteTarget(null);
              });
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </aside>
  );
}
