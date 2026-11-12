import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArchiveIcon,
  ArchiveXIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ListTodoIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type ModelDto,
  type SessionInfo,
  listModels,
  listTools,
} from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import { sessionFieldOf } from "../lib/sessionLookup";
import { titleFor } from "../lib/sessionTitle";
import { relativeTimeFor } from "../lib/sessionTime";
import { archivedInSpace, useSessions, spaceViewFor } from "../store/sessions";
import {
  useDragReorder,
  type DragReorderHandlers,
  type DropEdge,
} from "../hooks/useDragReorder";
import { useSessionStatus } from "../hooks/useSessionStatus";
import { useSkillCatalog } from "../hooks/useSkillCatalog";
import { useAgentCatalog } from "../hooks/useAgentCatalog";
// The Agents modal's write chain (D2): the optimistic publish, the serialized
// saves, the publish epoch and the rollback-on-failure, with the settings
// document the dialog's render gate reads.
import { useAgentOverridesWrites } from "../hooks/useAgentOverridesWrites";
import SkillsDialog from "./SkillsDialog";
import AgentsDialog from "./AgentsDialog";
import DeleteSessionDialog from "./DeleteSessionDialog";
import { SessionStatusMark } from "./SessionStatusMark";
import { SessionListRow } from "./SessionListRow";
import { RowButton } from "./RowButton";
import { EmptyListLine } from "./EmptyListLine";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";

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

function spaceNameFor(cwd: string, spaces: { path: string }[]): string {
  const match = spaces.find((s) => s.path === cwd);
  return match ? basenameOfPath(match.path) : basenameOfPath(cwd);
}

/**
 * THE SIDEBAR'S FOUR LABELLED COMMAND BUTTONS (Tasks, Skills, Agents, Settings) — one ghost
 * `<Button>` recipe, spelled ONCE because all four draw the identical box. (The two
 * that used to ride this recipe — `Open Space` and `New Session` — are gone: the
 * first left the sidebar for the chrome bar, the second is now the `+` in the
 * `Sessions` header, which is an icon button and does NOT use this recipe.)
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

/**
 * THE HOVER-REVEALED SESSION-ROW ACTIONS — Stop / Archive on a live or stored
 * row, Unarchive / Delete on an archived one. Four affordances, one box, drawn
 * by three different components (`SessionRow` and `ArchivedRow`), so the recipe
 * lives here once.
 *
 * `ROW_HOVER_ACTION` is the negation wall (groups the row does NOT spell, and
 * which `Button`'s base or the `icon-sm` size would otherwise change);
 * `SESSION_ROW_ACTION_ROW` is the row's own class list VERBATIM and comes LAST,
 * so it wins every group it spells. Both go to `cn()` at all four sites.
 *
 * What the wall undoes:
 *  - `border-0` — the base's `border` is a 1px ring; on a `size-6` box that is
 *    a 26px hit target where 24px was measured and pinned by the row's
 *    alignment, and it shifts the glyph 1px.
 *  - `transition-none` — the base fades hover colour over 150 ms. These appear
 *    on row hover ALREADY (`group-hover:flex`); layering a second fade on the
 *    fill would change what a hovering pointer sees.
 *  - `shrink` — the base's `shrink-0` is `flex-shrink: 0`. These four are flex
 *    ITEMS of the row (`RowButton` is a `flex` box), so the base would stop a
 *    long title from squeezing them the way it always could. `shrink` is
 *    `flex-shrink: 1` — the value they had.
 *
 * What the row itself wins by being LAST, and why that matters here:
 *  - `hover:bg-surface-hover` over the ghost arm's `hover:bg-hover` (different
 *    colours in default-dark and Dracula — 5% vs 10%);
 *  - `hidden` + `group-hover:flex` over the base's `inline-flex` — the
 *    hover-reveal mechanism is the whole design of this affordance and it has
 *    to survive;
 *  - `items-center`, `justify-center`, `rounded-md`, `size-6`.
 *
 * Inert additions, with the reason:
 *  - `text-foreground` and `hover:text-foreground` (the ghost arm) — the row
 *    spells NO colour and inherits one anyway: `App.tsx:360`'s root is
 *    `bg-frame text-foreground`, and nothing between it and this button sets a
 *    colour, so the arm's ink IS the inherited ink. Same computed colour;
 *  - `bg-clip-padding` — `padding-box` is CSS's initial `background-clip`, so
 *    declaring it changes nothing;
 *  - `outline-none` — `base.css:53-57` forces `outline: none !important` on
 *    every `:focus`/`:focus-visible` anyway, in every browser and again under
 *    `forced-colors`;
 *  - `disabled:*` / `aria-invalid:*` / `aria-expanded:*` — none of the four is
 *    ever disabled, and nothing sets `aria-invalid` or `aria-expanded` on it
 *    (the two view doors in this pane's command strip do — Settings and Tasks;
 *     these do not);
 *  - `text-ui-base/relaxed` — 14px/1.625 declared where the button previously
 *    inherited the UA's 16px (this app never sets a root `font-size`; it sizes
 *    text only through `--ui-font-size` and the `text-ui-*` utilities, and
 *    neither this button nor the `RowButton` it sits in spells one). Inert
 *    because there is no text: the only child is an `<svg class="size-4">`, and
 *    `size-4` is `calc(var(--spacing) * 4)` — rem, not em — inside a fixed
 *    `size-6` box. `whitespace-nowrap` and `select-none` have no text to act
 *    on either;
 *  - `[&_svg]:pointer-events-none` — the click handler is on the button, so the
 *    event is handled whether it lands on the button or is retargeted to it;
 *  - `[&_svg]:shrink-0` — the glyph is a fixed `size-4`;
 *  - `[&_svg:not([class*='size-'])]:size-3` — every icon here is created with
 *    an explicit `size-4` (`SquareIcon`, `ArchiveIcon`, `ArchiveXIcon`,
 *    `Trash2Icon`), so the `:not([class*=size-])` guard excludes all of them.
 *    This is the C2 chrome-bar trap, and it does not bite here;
 *  - `has-data-[icon=inline-*]:pr/pl` — no child carries `data-icon`
 *    (lucide-react v1.47's `createLucideIcon` sets no such attribute);
 *  - `group/button` — nothing in the tree reads that group.
 *
 * NOT `RowButton`, and this is the C4 rule, not an oversight: these are real
 * `<button>`s. A second `role="button"` inside the row would resolve every
 * `.closest('[role="button"]')` read in `SpacesList.test.tsx` to the action
 * instead of the row, and `ToolCallCard.test.tsx`'s nesting pin keeps the
 * `button`-in-`button` count at zero — `Button` renders a `<button>`, which is
 * what the row's `div[role=button]` already expects as a child.
 */
const ROW_HOVER_ACTION = "border-0 transition-none shrink";
const SESSION_ROW_ACTION_ROW =
  "hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover";

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
   *  strip is the app's view switcher now, and only `App` knows which view is up. */
  onOpenBoard?: () => void;
  /** Open the **Settings** view. The door that used to sit in the chrome bar's
   *  `ChromeControls` (deleted) — the strip is its only home, so this pane holds the
   *  app's ONE route to the settings page. */
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
  // THE STRIP IS THE VIEW SWITCHER. The Settings door moved here from the chrome
  // bar's control cluster (`ChromeControls`, deleted): the pane is permanent across
  // all three views since ADR 0094, so the door that opens a view can also be the
  // door that closes it, and the top-right of the window is left to the window
  // controls alone.
  const spaces = useSessions((s) => s.spaces);
  const sessions = useSessions((s) => s.sessions);
  const historySessions = useSessions((s) => s.historySessions);
  const archivedSessions = useSessions((s) => s.archivedSessions);
  const closeReasons = useSessions((s) => s.closeReasons);
  const sessionRecency = useSessions((s) => s.sessionRecency);
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
  const deleteTargetTitle = deleteTarget
    ? titleFor(
        deleteTargetMessages,
        spaceNameFor(deleteTarget.cwd, spaces),
        // The target IS a `SessionInfo`, so its title is already in hand —
        // the SAME label the row the user clicked shows.
        deleteTarget.title,
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
  // merely COEXISTED with Settings; once the strip IS the view switcher, "show me
  // this Session" necessarily includes leaving the page that is covering the
  // transcript — a row that opened a Session you could not see was the bug D8
  // traded away.
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
    // app's ONE control (the Settings door) IS in here, as the second of the four
    // commands in the strip at the top.
    <aside
      style={{ width: LEFT_PANE_WIDTH }}
      className="relative flex shrink-0 flex-col overflow-hidden bg-frame"
    >
      {/* THE CONTENT REGION — the action buttons, the `Sessions` header and the
          list. It used to carry an `invisible` class while the pane was collapsed,
          and that class was load-bearing THEN: clipping alone let the content paint
          INTO the 40px sliver (the buttons wrapped to one word per line, the
          `Sessions` header became "Sess", and the scroller grew a SCROLLBAR in a
          40px column). Nothing clips now, so nothing hides — the wrapper stays a
          plain flex column, and it survives as an element because the layout below
          (a `flex-1` scroller inside a `flex-1` column) needs the nesting. */}
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3">
        {/* The Task board's door, and it LEADS the strip. It joined the labelled
            commands after **Agents** (spec §3) and was later moved to the front: the
            board is where work starts, and a door below three others is a door nobody
            finds. Leading costs the adjacency the order used to defend — Settings, the
            other VIEW door, is now LAST with the two modal commands between them. See
            **Settings**' note for what that split was for and what it no longer buys.
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
        {/* The Agents modal (the ONE Agent surface — Settings has no Agents
            section). No `Kbd`, matching `Skills`: neither is a chord. `BotIcon`
            moved here from the deleted Settings nav entry. */}
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
        {/* The Settings door — the app's ONLY app control, and the reason this strip
            is the view switcher rather than a row of commands. It used to be a gear
            at the far RIGHT of the chrome bar (`ChromeControls`, deleted): the pane
            is permanent across all three views (ADR 0094), so the door lives with
            the other doors, and the bar's top-right belongs to the window manager
            alone.

            LAST in the strip, which is a position chosen for it rather than a leftover:
            the order used to be Skills / Agents / Settings / Tasks precisely so the two
            VIEW doors stayed adjacent and the two MODAL commands stayed adjacent, and
            **Tasks** moving to the front broke that. The adjacency was only ever a
            tiebreaker for where **Settings** should sit — nothing reads its neighbours,
            and the `aria-pressed` behaviour is per-button and order-independent. What
            the split genuinely still carries is the KIND difference: a modal is not a
            location, so Skills and Agents raise a dialog and carry NO `aria-pressed`;
            Settings and Tasks name a view, so they say which one is showing and toggle
            off when clicked again. That distinction is now invisible in the layout and
            lives only in the behaviour — the accepted cost of putting Tasks first. Two exits per view (N1) — its
            own door, or any **Session** row — so no view is a dead end. That is what
            makes the Settings page's own `Back` redundant (it is retired);
            this pane owns no exit control of its own.

            NOT `CHROME_BUTTON`, and that is a gate, not a preference:
            `chromeButton.test.ts`'s source gate requires `chromeButton.ts` to be the
            ONLY production file under `src/components/` carrying the chrome-bar
            geometry. `PANE_COMMAND_ROW` is `h-8 w-full` — the sidebar's box. */}
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
        />
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
function SessionRow({
  sessionId,
  spaceName,
  active,
  onOpen,
  drag,
  dropEdge,
  recencyMap,
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
      actions={actions}
    />
  );
}

/**
 * The **active Space's** Archived section: the archived rows whose `cwd` is the
 * selected Space, rendered AFTER that Space's groups and scrolling with the
 * list. COLLAPSED by default; the header (icon + "Archived" + count + chevron)
 * toggles it. The count is the SAME array the rows render, so it is the Space's
 * count and never the app-wide total.
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
function ArchivedSection({
  activeSessionId,
  onOpen,
  onDelete,
}: {
  activeSessionId: string | null;
  onOpen: (sessionId: string) => void;
  onDelete: (session: SessionInfo) => void;
}) {
  const [open, setOpen] = useState(false);
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
  return (
    <div className="px-2.5 py-1">
      <RowButton
        onClick={() => setOpen(!open)}
        className="group flex cursor-pointer items-center gap-1 rounded-lg px-1 hover:bg-surface-hover"
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
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

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
function ArchivedSessionRow({
  session,
  active,
  onOpen,
  onDelete,
  recencyMap,
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
}) {
  const messages = useSessions((s) => s.messages[session.sessionId]);
  const spaces = useSessions((s) => s.spaces);
  const unarchiveSession = useSessions((s) => s.unarchiveSession);
  const spaceName = spaceNameFor(session.cwd, spaces);
  const title = titleFor(messages, spaceName, session.title);
  const time = relativeTimeFor(session.sessionId, messages, recencyMap);
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
