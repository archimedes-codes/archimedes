import { useEffect, useState, useSyncExternalStore } from "react";
import {
  listenInteractiveEvent,
  listenInteractiveRequest,
  listenInteractiveRequestClose,
  listenPermissionRequest,
  listenSessionClosed,
  listenSessionStalled,
  listenSessionTitled,
  listenSessionUpdate,
  listenSubagentClosed,
  listenSubagentSessionStarted,
  listSessions,
  listSpaces,
  sessionRecency,
} from "./lib/tauri";
import { createBatchedSessionUpdate } from "./lib/batchSessionUpdates";
import { INTERACTIVE_EVENTS } from "./lib/ipc/events";
import { onSessionClosed } from "./store/sessionLifecycle";
import { discardSessionMessages, useSessions } from "./store/sessions";
import { useModelCatalog } from "./store/modelCatalog";
import { usePermissions } from "./store/permissions";
import { useInteractive } from "./store/interactive";
import { useSubagents } from "./store/subagents";
import SpacesList, { LEFT_PANE_WIDTH } from "./components/SpacesList";
import SpaceTabs from "./components/SpaceTabs";
import ChatStream from "./components/ChatStream";
import SidePane from "./components/SidePane";
import WindowControls from "./components/WindowControls";
import SubagentDetailHost from "./components/SubagentDetailHost";
import { SubagentModals } from "./components/SubagentModals";
import SettingsPage from "./components/settings/SettingsPage";
import TasksBoard from "./components/TasksBoard";
import { SpaceCwdProvider } from "./components/SpaceCwd";
import { cn } from "./components/lib/utils";
import { useAttentionAlert } from "./hooks/useAttentionAlert";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
  subscribeNewSpaceDialog,
} from "./lib/newSpaceDialogState";
import NewSpaceDialog from "./components/NewSpaceDialog";
import NewSessionErrorBanner from "./components/NewSessionErrorBanner";
import { useActiveSpaceCwd } from "./hooks/useActiveSpaceCwd";
import { useSessionTitleRecovery } from "./hooks/useSessionTitleRecovery";
import { useWindowMaximized } from "./hooks/useWindowMaximized";

function App() {
  // Attention alerts (ADR 0038/0039): arm the OS notification when a Session
  // has been paused on the user, disarm on the evidence or on their input.
  // VIEW-INDEPENDENT like the listeners below — mounted with the app, not with
  // the workspace, so a pause still alerts while the Settings page is open (the
  // workspace unmounts there).
  useAttentionAlert();

  // The ⌘N / ⌘O chords (app commands, so app-scoped). SAME reason as the hook
  // above: the pane that used to own this listener (`SpacesList`) sat inside the
  // view ternary, so it was unmounted while the Settings page was open and a
  // chord declared there did not exist there. (Spec D2 has since hoisted that
  // pane out of the ternary, but the chord stays app-scoped — it is an app
  // command, and it must survive whatever the sidebar does.)
  // See `useAppShortcuts` for what it claims and what it no longer yields
  // to.
  useAppShortcuts();

  // Title recovery (#143): re-read the stored rows when the window regains
  // focus, so a `session-titled` push that was dropped cannot strand a live
  // Session's label until restart. App-scoped like the two hooks above — the
  // sidebar row it fixes is visible while the Settings page is open (the
  // workspace is unmounted there), so a hook mounted with the workspace would
  // not exist exactly when the stale label is on screen. See the hook's own doc
  // for why it calls ONLY `listSessions`.
  useSessionTitleRecovery();

  // Register the Tauri event listeners once; dispatch into the stores.
  // `listen()` is async, so cleanup must await the pending registrations
  // before unlistening: React StrictMode re-runs the effect in dev, and a
  // stale listener that never gets unregistered doubles every event.
  useEffect(() => {
    const unlistenPromises: Array<Promise<() => void>> = [];
    // Coalesce the `session-update` events into one store update per frame:
    // a local agent at a high thinking level emits ~1000 chunks/sec, and one
    // React render per event would saturate the webview main thread (the UI
    // renders at ~1fps while the GPU sits idle — see `batchSessionUpdates.ts`).
    const batchedSessionUpdate = createBatchedSessionUpdate(
      (items) => useSessions.getState().applySessionUpdates(items),
      (fn) => requestAnimationFrame(fn),
    );
    unlistenPromises.push(
      listenSessionUpdate((payload) =>
        batchedSessionUpdate({
          sessionId: payload.sessionId,
          update: payload.update,
        }),
      ),
    );
    unlistenPromises.push(
      listenSessionClosed((payload) => {
        onSessionClosed(payload.sessionId, payload.reason);
      }),
    );
    // A Worker crash (ADR 0025): the `session-stalled` event marks the
    // session STALLED in the store (the `SessionStalledBanner`'s data
    // source — the `StalledPayload` shape: `sessionId` + `at` + `crashLog`).
    unlistenPromises.push(
      listenSessionStalled((payload) =>
        useSessions
          .getState()
          .markStalled(payload.sessionId, payload.at, payload.crashLog),
      ),
    );
    // A generated session title (the naming pass): the label rides this PUSH
    // because `listSessions` is fetched ONCE at boot (below) — a title minted
    // in this run would otherwise never reach the sidebar / side pane. Since
    // #143 there IS a second route, `useSessionTitleRecovery` (a focus-driven
    // re-read merged by `mergeRefreshedSessionRows`), but the push stays the
    // INSTANT one and the recovery is the backstop for a frame this broadcast
    // dropped — do not delete this listener on the theory the pull covers it.
    unlistenPromises.push(
      listenSessionTitled(({ sessionId, title }) =>
        useSessions.getState().titleSession(sessionId, title),
      ),
    );
    unlistenPromises.push(
      listenPermissionRequest((payload) =>
        usePermissions
          .getState()
          .addPrompt(payload.sessionId, payload.requestId, payload.request),
      ),
    );
    unlistenPromises.push(
      listenInteractiveRequest((payload) =>
        useInteractive.getState().addRequest(payload.sessionId, payload),
      ),
    );
    // A DROPPED gate closes its card. Two emitters reach this one listener:
    // the `sudo_exec` drop guard (a turn cancel skips the flow's exit-path
    // cleanup — pre-fix the modal stayed open with no pending response, and a
    // late answer got `Ok(true)` with the send silently failing), and
    // `finish_subagent` (ADR 0055 — a **Subagent session** torn down with an
    // unanswered gate; the router's own pending-modal cleanup is unreachable
    // for a child, so that teardown is the emitter and keys the frame to the
    // CHILD id). `cleanup_pending_modals` emits it too, for a MAIN session.
    //
    // BOTH stores are cleared, because the gates live in TWO of them: an `ask`
    // / `confirm` / `password` prompt in `useInteractive.requests`, a
    // **Permission** prompt in `usePermissions.prompts` — and
    // `usePermissions` had NO listener at all for this event (its only removal
    // was `PermissionPrompt.tsx`'s local one on an ANSWER). So a Permission
    // card was unclosable by every emitter, including `cleanup_pending_modals`,
    // which has been emitting closes for tracked Permission modals all along
    // into a listener that ignored them. That pre-existing hole is fixed as a
    // side effect here.
    //
    // Calling both for either kind is SAFE: `removeRequest` and `removePrompt`
    // both FILTER one `requestId` out of one session's list, so the store that
    // never held it is an idempotent no-op — it does not wipe its other rows.
    unlistenPromises.push(
      listenInteractiveRequestClose((payload) => {
        useInteractive
          .getState()
          .removeRequest(payload.sessionId, payload.requestId);
        usePermissions
          .getState()
          .removePrompt(payload.sessionId, payload.requestId);
      }),
    );
    unlistenPromises.push(
      listenInteractiveEvent((payload) => {
        const s = useInteractive.getState();
        // Exhaustive over `InteractiveEventName` (the discriminants now live in
        // `ipc/events.ts`, and `InteractiveEventPayload.event` is typed as that
        // union) — adding a name there without a case here is a compile error.
        // The DEFAULT LOGS AND RETURNS: the worker builds these names with no
        // Rust-side closed set, so an unlisted-but-real frame is possible, and
        // throwing inside a listener would turn today's silent drop into a
        // runtime exception. Wire note: the bus's `COST_UPDATE` arrives as
        // `cost_update`, NOT `cost`.
        switch (payload.event) {
          case INTERACTIVE_EVENTS.todosUpdate:
            s.applyTodoUpdate(payload.sessionId, payload.payload);
            return;
          case INTERACTIVE_EVENTS.todosClear:
            // One argument: a clear names a SESSION, and the payload's `source`
            // is not consulted (ADR 0041).
            s.applyTodoClear(payload.sessionId);
            return;
          case INTERACTIVE_EVENTS.state:
            s.applyState(payload.sessionId, payload.payload);
            return;
          case INTERACTIVE_EVENTS.costUpdate:
            s.applyCost(payload.sessionId, payload.payload);
            return;
          case INTERACTIVE_EVENTS.session:
            s.applySession(payload.sessionId, payload.payload);
            return;
          default: {
            // Compile-time exhaustiveness WITHOUT a runtime throw: while every
            // `InteractiveEventName` has a case above, `unhandled` narrows to
            // `never`; add a discriminant without a handler and this line is a
            // type error. The frame is then IGNORED VISIBLY (a throw inside a
            // listener is a behaviour regression, and the worker has no
            // Rust-side closed set, so an unlisted-but-real frame is possible).
            const unhandled: never = payload.event;
            console.warn(
              `interactive-event: no handler for "${unhandled}"`,
              payload.sessionId,
            );
            return;
          }
        }
      }),
    );
    // Subagent sessions (Task 4): the `subagent-session-started` /
    // `subagent-closed` events feed the subagents store (the panel's
    // authority for subagent STATUS + the metrics SNAPSHOT — the existing
    // `listenSessionClosed` handler above stays as-is; its interactive-store
    // deletion is exactly why the metrics live in the snapshot).
    unlistenPromises.push(
      listenSubagentSessionStarted((p) =>
        useSubagents.getState().addSession({
          sessionId: p.sessionId,
          parentSessionId: p.parentSessionId,
          agentName: p.agentName,
          // (issue #47) Copied verbatim — the store never derives it, and an
          // older payload leaves it absent (which renders nothing).
          //
          // ABSENT, not present-and-`undefined`, and that is why this is a
          // conditional spread instead of a plain assignment: the field is
          // OPTIONAL precisely so a backend that predates it OMITS it, and
          // `store/subagents.ts` documents + tests that an `undefined`-valued
          // key is NOT the same shape as an absent one (`"nameResolution" in
          // entry`). An unconditional `nameResolution: p.nameResolution` made
          // every older payload through this real wiring produce the one shape
          // the store test forbids. Harmless while every reader branches on
          // `=== "unmatched"`, but the invariant is only worth having if the
          // wire path upholds it — `App.test.tsx` now pins the key's ABSENCE.
          ...(p.nameResolution !== undefined
            ? { nameResolution: p.nameResolution }
            : {}),
          task: p.task,
          status: "running",
          model: p.model,
          thinkingLevel: p.thinkingLevel,
        }),
      ),
    );
    unlistenPromises.push(
      listenSubagentClosed((p) => {
        // Discard the transcript BEFORE `markClosed` (order matters):
        // `markClosed` runs `evictOldestClosed`, which can evict this
        // entry synchronously (the oldest of 21+ closed entries by
        // insertion order) — a discard running AFTER would then no-op
        // its `entries[sessionId]` guard. The entry exists from
        // `subagent-session-started` (`dispatch_subagent` emits `started`
        // before it spawns the drive task that reaches `finish_subagent`) and
        // `running` entries are never evicted, so the discard-first order is
        // deterministic (absent an explicit user `dismiss`).
        //
        // Why discard here AT ALL: this is the ONLY frame that ever names
        // the end of a CHILD session, so it is the only thing that can free
        // the transcript the `subagent-session-started` handler's stream
        // filled in. Checked against the Rust (read only): `session-closed`
        // has exactly ONE emitter, `on_session_exited_expected`
        // (`src-tauri/src/agent/session/router.rs`), which returns without a
        // `live` entry, and the only insert into `live` is
        // `establish_worker_session` (`src-tauri/src/agent/session/mod.rs`)
        // on the main-session start / resume paths — a child has no `live`
        // entry, so no close frame ever carries its id (a crash would say
        // `session-stalled`, not a close). A child's teardown is
        // `finish_subagent` (`src-tauri/src/agent/worker/manager.rs`), which
        // emits `subagent-closed` and NOTHING else. So the
        // `listenSessionClosed` handler above cannot be the one that
        // discards here, and nothing else is: `markClosed`'s
        // `evictOldestClosed` drops the `SubagentEntry` alone and never
        // touches `useSessions.messages`, so without this call every child's
        // transcript would sit in the store for the life of the window.
        discardSessionMessages(p.sessionId);
        useSubagents
          .getState()
          .markClosed(p.sessionId, p.status, p.error, p.metrics, p.reason);
        // The child's todo board goes too — same reasoning as the discard
        // above: this is the only frame that ever names the end of a CHILD
        // session, so nothing else would free the slice (`session-closed`
        // never carries a child id, and `src-tauri/` emits no `todos_clear`
        // frame at all).
        //
        // NARROW on purpose: `applyTodoClear`, NOT `dismissSession` — the
        // latter would also wipe the child's pending gates, and that IS the
        // state ADR 0040's amendment records (paraphrased here, not quoted): a
        // closed child keeps its gate card on screen until its entry is
        // evicted.
        useInteractive.getState().applyTodoClear(p.sessionId);
      }),
    );
    return () => {
      for (const p of unlistenPromises) {
        p.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, []);

  // On boot, load the stored sessions AND spaces (the client owns history:
  // every session survives a restart). `listSessions(true)` fetches the
  // FULL list (archived included); the store splits it by the flag, and
  // `setSpaces` auto-selects (Task 5) the recent landing for boot. No
  // listener changes: close reasons flow through the existing
  // `handleSessionClosed`).
  //
  // The THIRD fetch is `sessionRecency()` — the recency AND the stored order
  // number per Session (ADR 0075: position is not evidence, so the Landing
  // Session `setSpaces` picks has to be told what recency is). Its result is
  // written BEFORE `setSpaces` for exactly that reason; see the effect below.
  //
  // The content-area view: the workspace (the default), the settings
  // page (opened from the `SpacesList`'s `Settings` door), or the Task BOARD (opened
  // from the `SpacesList`'s `Tasks` command). Both non-workspace views
  // UNMOUNT the workspace — which is now exactly `ChatStream` / `SidePane` /
  // `SubagentDetailHost`; the `SpacesList` is hoisted ABOVE the ternary and
  // mounts on all three views (spec D2), so it is no longer one of the
  // unmounted surfaces. (The ZCode `opacity-0` + `inert` pattern is for
  // keeping the workspace MOUNTED — the stores are the source of truth and
  // re-hydrate on remount, so the simpler unmount is used): a session
  // running in the background keeps streaming into the stores (the listener
  // `useEffect`s above are view-independent), and `ChatStream` / `SidePane`
  // re-read them on remount while the Session list never stopped reading them.
  //
  // THREE ARMS, AND THE THIRD NEEDS AN EXPLICIT ONE. The workspace is the
  // implicit `else` of the ternary below, so a value the ternary does not name
  // renders the WORKSPACE. Widen the union without adding the arm and `board`
  // would paint the chat column and the Side pane — a green build, a passing
  // smoke test, and no board. The `"board"` arm is therefore spelled out, not
  // fallen into.
  const [view, setView] = useState<"workspace" | "settings" | "board">("workspace");
  // The Subagent sheet needs to know about this transition, and it is told — it
  // is not rewritten. `SubagentDetailHost` lives in the ternary's else-branch, so
  // opening Settings UNMOUNTS the sheet while `useSubagentSelection` keeps its
  // value; `SubagentModals` is a sibling of the whole ternary and reads that
  // selection to decide whether to dodge the sheet, so a selection naming a sheet
  // that is not mounted would detach the card panel by the sheet's own width
  // (`SUBAGENT_SHEET_WIDTH`) and float it across the Settings page. The fix is to
  // hand that overlay the one fact it cannot see for itself — `sheetMounted` on
  // the JSX below — NOT to `select(null)` on the way in: the selection is the
  // SHEET's state (`store/subagentSelection`, written only by `SubagentDetailHost`
  // and the `SubagentDelegatingCard` rows that open the sheet), so clearing it here
  // both reached across a store boundary to fix a different component's geometry
  // and cost the user their open
  // sheet, leaving Back from Settings with the transcript closed. Keeping the
  // selection is also the cheaper answer: the sheet re-mounts with the same
  // transcript it had, and the `hidden`-class outer `div` plus the store-backed
  // rows mean nothing else needs re-syncing.
  // The Open Space dialog's flag — the SHARED module's, read with a two-arg
  // `useSyncExternalStore`. `App` is now the dialog's ONLY render site, so this
  // read is what makes the dialog survive the
  // Settings view: the raise sites are the root chord, the tab strip's `+` and
  // the sidebar's buttons, and a flag with an owner inside the workspace could
  // not be answered while the workspace is unmounted.
  const newSpaceDialogOpen = useSyncExternalStore(
    subscribeNewSpaceDialog,
    getNewSpaceDialogOpen,
  );
  const isMaximized = useWindowMaximized();
  useEffect(() => {
    Promise.all([listSessions(true), listSpaces(), sessionRecency()])
      .then(([rows, spaces, recency]) => {
        useSessions.getState().setHistorySessions(rows);
        // BEFORE setSpaces: setSpaces runs autoSelectActive, which decides the
        // Landing Session from these maps (ADR 0075). The three calls above have
        // already settled, so this ordering costs nothing and is the whole
        // contract — a swap lands boot on the map-less fallback. ONE call fills
        // BOTH the recency map and the order map: the order number rides this
        // payload precisely so boot costs no fourth IPC round-trip.
        useSessions.getState().setSessionRecency(recency);
        useSessions.getState().setSpaces(spaces);
      })
      .catch((err) =>
        console.error("failed to load stored sessions/spaces/recency", err),
      );
    // (#85) The model catalog, for the surfaces that read model METADATA (the
    // subagent card's context %). Boot loads it once, through the store so the
    // sidebar and the settings page share one fetch rather than one each — and
    // so a provider refresh has a single place to replace it.
    void useModelCatalog.getState().loadModels();
  }, []);

  // The active **Session**'s `cwd` (= its **Space**'s folder), read through the
  // ONE module that owns that derivation — `ChatStream`'s `spacePath` (the
  // picker catalogs) reads the same hook, so the Space the composer completes
  // against and the Space a relative External-open resolves against cannot
  // disagree.
  // This is `App`'s FIRST subscription to the SESSIONS store (the dialog flag
  // above is the separate `newSpaceDialogState` module, via
  // `useSyncExternalStore`), so `App` now re-renders when the session list or
  // the active session changes. Accepted deliberately — `applySessionUpdates`
  // rewrites `messages`, not the lists, so streaming does not re-render the app
  // shell — and do NOT "optimise" it with a memo wrapper: that would trade a
  // render that does not happen for a second store subscription, plus a
  // component that cannot see the context it exists to provide.
  const spaceCwd = useActiveSpaceCwd();

  return (
    <div
      className={cn(
        "flex h-screen w-screen flex-col overflow-hidden bg-frame text-foreground",
        isMaximized ? "rounded-none" : "rounded-xl",
      )}
    >
      {/* Frameless window chrome (the window is `decorations: false` in
          tauri.conf.json, so this bar replaces the native titlebar).
          BROWSER-STYLE: the Space tabs live HERE (the window titlebar
          row — the reference screenshot's tabs-in-menubar look), NOT in
          the center column. The WHOLE bar is the drag region
          (`data-tauri-drag-region="deep"` on the container): Tauri's
          drag-region script honors a BARE attribute only on the element
          a mousedown lands on DIRECTLY — the bar's children (the logo
          segment, the tab spacer) would be dead zones. "deep" extends
          the region to the whole subtree, so the bar's empty areas drag
          the window (double-click maximizes / restores) while the inner
          buttons / tabs (interactive elements without the attribute)
          still block it and stay clickable. The left segment's width
          is the sidebar's width (the tabs start where the center column
          begins; the sidebar is permanent at `LEFT_PANE_WIDTH`, so this segment
          is that same constant and cannot drift).

          THE BAR HOLDS THE TABS AND THE WINDOW CONTROLS AND NOTHING ELSE. The
          app's own control — the Settings door — is NOT here: it moved into the
          Session list's command strip (whose old chrome-bar home is deleted), so the
          top-right corner belongs to the window manager alone and the strip is
          the app's one navigation surface. The pane collapse toggles that used to
          live here are retired with the panes' collapsed flags. In the settings
          view (the workspace unmounts) the segment is `flex-1` (full width — the
          old chrome-bar layout) and the tabs are dropped (D6: Settings is not a
          tab peer). There is no app control on this bar in EITHER arm. The Settings
          view's exit is the pressed **Settings** button in the Session list (and any
          Session row leaves the view too); the page carries no exit control of its
          own — its `Back` was retired as redundant, not replaced by this. */}
      <div
        data-tauri-drag-region="deep"
        className="flex h-10 shrink-0 items-center bg-frame pr-2"
        data-testid="chrome-bar"
      >
        {view === "settings" ? (
          <div className="flex h-full flex-1 items-center pl-3">
            <img
              src="/app-icon-large.png"
              alt="Archimedes"
              className="h-4 w-4 rounded-sm object-contain select-none pointer-events-none"
              draggable={false}
            />
          </div>
        ) : (
          <>
            <div
              style={{ width: LEFT_PANE_WIDTH }}
              className="flex h-full shrink-0 items-center pl-3"
            >
              <img
                src="/app-icon-large.png"
                alt="Archimedes"
                className="h-4 w-4 rounded-sm object-contain select-none pointer-events-none"
                draggable={false}
              />
            </div>
            {/* No app control is here at all: the bar's only children are the logo
                segment, the tabs and `WindowControls`. The Settings door lives in the
                Session list's command strip, and the pane collapse toggles are
                retired entirely. */}
            <SpaceTabs />
          </>
        )}
        <WindowControls />
      </div>
      {/* Why the last new-session attempt failed, when it failed. MOUNTED OUTSIDE
          the view ternary for the same reason the ⌘N chord is mounted at this root
          (`useAppShortcuts`) and for the same reason `SubagentModals` and the root
          `NewSpaceDialog` are: the surface that used to be the ONLY reader of
          `newSessionError` — the sidebar's `New Session` `+` button `title` —
          unmounted on the Settings page back when the pane lived inside the
          ternary, so a chord that works there could fail there in total silence.
          (Spec D2 has since hoisted the Session list out of that ternary, so the
          tooltip is reachable from Settings again — the banner stays, because a
          `title` needs a hover aimed at one small button and a chord has no
          button at all.) A strip in the column (not inside the content
          row) so it spans the window instead of squeezing a pane, and it needs no
          `SpaceCwdProvider`: it reads one store field and opens nothing. */}
      <NewSessionErrorBanner />
      <div className="flex min-h-0 flex-1" data-testid="content-row">
        {/* The active **Space**'s folder for every **External open** of a
            relative path (ADR 0051), provided HERE rather than inside
            `ChatStream` because the surfaces that need it are NOT all inside
            the workspace view: the subagent transcript sheet
            (`SubagentDetailHost`) lives in the else-branch of the ternary below
            and `SubagentModals` is a sibling of that whole ternary, so only a
            provider OUTSIDE the ternary covers both — and while Settings is
            open the surfaces that remain (the overlay's cards) are still
            covered. A `Subagent session`'s Worker runs with `cwd =
            parent_cwd`, so the active Space is the right value for its
            transcript too. Without a provider `useSpaceCwd()` is `null` and
            `external_open` refuses a relative path — the safe direction, but a
            dead surface. */}
        <SpaceCwdProvider cwd={spaceCwd}>
          {/* The Session list — PERMANENT (spec D2), hence mounted ABOVE the
              ternary rather than in its else-branch. It needs no provider of its
              own (`SpacesList` reads no `useSpaceCwd`; that hook's readers are
              `MessageBubble`, `OpenAnchor`, `ToolCallCard` and `SpaceCwd`), so
              its position inside `SpaceCwdProvider` is for shape only.

              TWO ACCEPTED FACTS, both on the record so neither reads as a bug:

              1. Its `SkillsDialog` / `AgentsDialog` / `DeleteSessionDialog` are
                 `fixed` Radix portals mounted INSIDE the pane, so they are now
                 reachable while Settings is open. That is the POINT of the
                 hoist, not a leak — the pane's commands do not stop existing
                 because a page is in front of the center column.

              2. THE ARITHMETIC: on the app's default window
                 (`tauri.conf.json` → `width: 800`) the Settings view now spends
                 260 (`LEFT_PANE_WIDTH`) + 268 (`SettingsPage`'s own section
                 `aside`) = 528px on navigation, leaving 272px for section
                 content. There is NO `min_inner_size` in `tauri.conf.json` and
                 no `set_min_inner_size` anywhere in `src-tauri/src/` (both
                 verified at planning time), so nothing stops a user taking that
                 further. A minimum window size is deliberately NOT part of this
                 change — it is a separate decision with frameless-window
                 implications on Windows/Linux.

              THE STRIP IS THE VIEW SWITCHER: the pane is told which view is up, so
              its **Settings** and **Tasks** doors render pressed and toggle off, and
              it is handed the exit a **Session** row click takes. All three callbacks
              are the same `setView` the rest of this file already calls. */}
          <SpacesList
            onOpenBoard={() => setView("board")}
            onOpenSettings={() => setView("settings")}
            onReturnToWorkspace={() => setView("workspace")}
            currentView={view}
          />
          {view === "settings" ? (
            // Full width BESIDE the permanent Session list above — the
            // `SettingsPage`'s own 268px section sidebar is the second nav
            // column (spec D3: two adjacent navs on this page is accepted).
            <SettingsPage onReturnToWorkspace={() => setView("workspace")} />
          ) : view === "board" ? (
            // The Task board, in place of the chat column AND the Side pane (spec
            // §3: the board replaces the right pane). It unmounts NEITHER pane:
            // the Session list sits above this ternary now, so its own `Tasks`
            // door stays on screen and IS the board's exit (toggled off, or left
            // by any Session row) — the board carries no exit control of its own.
            // `activeSpacePath` is the
            // SAME derivation the `SpaceCwdProvider` above and `SidePane` use, so
            // the board and the transcript cannot disagree about which folder is
            // showing; `null` (no active Session) is a value `TasksBoard` renders
            // rather than one it sends to `get_board`.
            // `onReturnToWorkspace` is what makes a card's sessions reachable. The
            // board renders IN PLACE OF `ChatStream`, so `openSession` alone selects a
            // Session in the store and leaves its transcript behind this section — the
            // click reads as a visible nothing. The board is handed the SAME
            // `setView("workspace")` a Session row and the `Tasks` door already use; it
            // owns no view of its own (ADR 0095), so it is told rather than wired.
            <TasksBoard
              activeSpacePath={spaceCwd}
              onReturnToWorkspace={() => setView("workspace")}
            />
          ) : (
            <>
              {/* The center column: the chat (the Spaces are the chrome
                  bar's TABS — the old top row is gone). */}
              <div className="flex min-w-0 flex-1 flex-col">
                <ChatStream />
              </div>
              <SidePane />
              {/* The subagent transcript sheet: the `fixed` right-side panel
                  holding the SELECTED subagent's transcript (a child gate is
                  never rendered here — `SubagentModals` below and `MessageList`
                  own every gate). A `fixed` overlay, so its position in the flex
                  row does not affect layout. */}
              <SubagentDetailHost />
            </>
          )}
          {/* The child-gate overlay host: the half of every child's gates that
              the transcript structurally cannot render — every `confirm`/
              `password` `Dialog`, and the `ask`/permission of a child whose
              parent is NOT the active session (the active parent's half renders
              inline in `ChatStream`'s transcript). A SIBLING of the whole
              settings ternary, not a child of `SidePane`/`SubagentDetailHost`:
              those live in the else-branch and render NOTHING while Settings is
              open, which would strand the gates it owns. A `fixed` overlay, so
              its position in this flex row does not affect layout.
              `sheetMounted` is the one fact that split gives it: the sheet above
              unmounts with this ternary while the overlay does not, so the
              overlay is told which view is up instead of inferring it from the
              sheet's selection store (which survives the transition, so the
              user's open transcript survives it too).

              THE VALUE STAYS `view === "workspace"` — the plan for this view said
              `view !== "settings"`, and that is WRONG. `SubagentDetailHost` above is
              the sheet's ONLY render site and it lives in the else-branch, so the
              `"board"` arm unmounts the sheet exactly as Settings does. The prop's
              meaning is "the SHEET is mounted", which for `"board"` is FALSE: passing
              `view !== "settings"` would report a sheet that is not painted, and the
              overlay would slide 480px left and cap its width for a phantom sheet —
              reintroducing on a new view the exact defect the prop was introduced to
              stop. Measured, not reasoned: with `view !== "settings"` the rendered
              panel carries `right-[480px]` over the board, and
              `App.test.tsx`'s "the gate panel does NOT dodge a sheet the board view
              unmounted" case goes red on it. */}
          <SubagentModals sheetMounted={view === "workspace"} />
          {/* The Open Space dialog — the ONE render site in the app (the
              sidebar's copy is gone, and the tab strip never had one). A SIBLING
              of the whole settings ternary for exactly the reason
              `SubagentModals` above states: the else-branch renders NOTHING
              while Settings is open, so a dialog mounted in there would be
              raiseable-but-invisible on that page — the flag flips and nothing
              paints. (That is why the root mount survives spec D2 hoisting the
              sidebar out of the ternary: the rule was never about the sidebar's
              width, it is about the dialog not belonging to any view.) A `fixed`
              Radix modal, so its position in this flex row does not affect
              layout. */}
          {newSpaceDialogOpen && (
            <NewSpaceDialog onClose={() => setNewSpaceDialogOpen(false)} />
          )}
        </SpaceCwdProvider>
      </div>
    </div>
  );
}

export default App;
