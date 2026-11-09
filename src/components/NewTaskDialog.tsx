import { useMemo, useRef, useState } from "react";
// `ClipboardEvent` is deliberately NOT imported: `NOOP_PASTE` takes no parameter
// (a zero-argument function is assignable to `ComposerRow`'s
// `(e: ClipboardEvent<HTMLTextAreaElement>) => void`), so nothing here names the
// type — and `noUnusedLocals` would reject the binding. `DragEvent` IS named,
// because `NOOP_DROP` reads it to prevent the default file-drop navigation.
import type { DragEvent } from "react";
import {
  dirPartOfOutsideQuery,
  expandMentions,
  isOutsideSpaceQuery,
} from "../lib/skills";
import { groupConsecutiveFileWrites } from "../lib/toolGroups";
import { describeIpcError } from "../lib/ipcError";
import { sendPrompt, startTaskSession } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSettings } from "../store/settings";
import { useTasks } from "../store/tasks";
import {
  anchoredAskRequestIds,
  classifyInteractiveRequests,
  composerLockDerivations,
  historyPaginationDerivations,
  sessionKindDerivations,
  stackedAskRequests,
  turnDiffs,
} from "../lib/chatSessionDerivations";
import { useCompletionDir, useMentionCatalogs } from "../hooks/useMentionCatalogs";
import {
  useMentionPicker,
  type MentionPickerState,
} from "../hooks/useMentionPicker";
import { useAutoGrowComposer } from "../hooks/useAutoGrowComposer";
import { useWindowDropBackstop } from "../hooks/useWindowDropBackstop";
import { useChildGates } from "../hooks/useChildGates";
import { useHasPendingRequest } from "../hooks/useHasPendingRequest";
import { useSpinQuip } from "../hooks/useSpinQuip";
import { normalizeVariant } from "../lib/braille-loader";
import type { ChatComposerAttachment } from "../lib/chatAttachments";
import MessageList from "./chat/MessageList";
import ComposerRow from "./chat/ComposerRow";
import ComposerModals from "./chat/ComposerModals";
import SessionConfigBlock from "./SessionConfigBlock";
import { IpcErrorLine } from "./IpcErrorLine";
import { EmptyListLine } from "./EmptyListLine";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type { SkillInfo, StageWithTasks } from "../lib/tauri";

/**
 * The **New Task** modal — the board's creation point, which is also a real chat.
 *
 * ## What the first send does, in order (spec §3)
 *
 * `createTask` → `startTaskSession` → that Session becomes the chat → the first
 * prompt goes out with a `<task>` context block appended after the user's own
 * words. The ORDER of the first two is load-bearing, not stylistic:
 * `task_sessions.task_id` carries no foreign key (ADR 0090), so the Rust command
 * gates the link row on a `get_task` existence check — start the Session before
 * the row exists and the link is refused, leaving a card with no Session and a
 * live orphan. The store's `createTask` ACTION is used rather than the bare
 * command so the new card lands in the board the user is looking at.
 *
 * ## Why the context is the first USER message and never a system seed
 *
 * `StartEnv.system_prompt` exists and the desktop passes `None` for every main
 * Session, so a seed looks free. It is not: the harness's `(Fresh, Some(seed))`
 * start arm calls `prepend_system` and never `build_main_prompt`, so a "seeded"
 * Task Session opens blind to its own `<tools>` section, its discovered skills,
 * its `cwd` and `AGENTS.md`. `startTaskSession` therefore takes NO context
 * argument at all, and the task arrives as the first user message — the shape
 * `expandMentions` already uses for `<skill>` / `<agent>` / `<mcp>` blocks
 * (ADR 0013: expanded on send, BEFORE the message is recorded, so the bubble,
 * the persisted row and the wire text are ONE string, which is what ADR 0031's
 * content-based dedupe key compares on a resume reload).
 *
 * ## Reuse, and the two places this surface is deliberately narrower
 *
 * The transcript and the input are the SAME components the workspace uses
 * (`MessageList`, `ComposerRow`), fed by the SAME hooks and the SAME pure
 * derivations (`lib/chatSessionDerivations`, `lib/toolGroups`) — a second chat
 * SURFACE, not a second chat implementation. Two differences are deliberate:
 *
 *  - **No attachments.** `imageCapable` is `false`, so the `+` button is disabled
 *    and paste/drop stage nothing. The image lifecycle (staged object URLs, the
 *    held-for-send map, the failed-send restore) is `useChatAttachments`, and a
 *    Task's first message is a sentence about work — this modal has no reason to
 *    own that machinery, so it owns none of it.
 *  - **No `#` MCP Mention.** The MCP catalog is passed EMPTY, which switches the
 *    prefix off with no new code path: `expandMentions` finds no match and
 *    returns the text byte-identical, and the picker yields no rows so every
 *    keyboard branch stays inert. The reason is not taste. The literal
 *    `[image #3]` marker IS a `#` mention token, and the workspace's send path
 *    masks it out before expanding precisely because an MCP server named `3`
 *    would otherwise get a block appended to a prompt nobody asked for. That mask
 *    lives inside `useChatPromptDispatch.sendText`, which this modal cannot route
 *    through (see the send note) — so instead of re-implementing a load-bearing
 *    rule as a second copy, the modal removes the rule's precondition.
 *    `usePromptQueueFlusher` is absent for the same reason: nothing can be queued
 *    against a Session that does not exist yet.
 *
 * ## The send chain, and why it is the store's four verbs
 *
 * `useChatPromptDispatch` owns the workspace's send tail and the modal cannot use
 * it: the `<task>` block must be appended AFTER expansion (a Task title is free
 * text, and expanding over it would let a title containing `$some-skill` inject a
 * skill block — a card can be created by a harness tool), while `sendText`
 * expands whatever it is handed and sends exactly that. So the modal runs the
 * store-level contract directly: `addUserMessage(id, text)` → `beginTurn(id)` →
 * `sendPrompt(id, text)` with the ONE string, then `turnCompleted` — which is
 * what `sendText` does, in that order. `turnCompleted` is the ONLY frontend path
 * that clears `inTurn`; skip the settle and this composer stays locked and the
 * working indicator spins forever.
 *
 * ## The modal's Session becomes the selected one, and the footer never relies on it
 *
 * `addSession` is the store's own "a Session was started" action: it upserts the
 * row AND selects it, which is what puts the row in the sidebar (spec §3 —
 * closing the modal leaves a card AND a row) and makes this transcript the one on
 * screen. Nothing else observes the switch: `App`'s `"board"` arm unmounts
 * `ChatStream` and `SidePane` the way Settings does, on the documented reasoning
 * that the stores are the source of truth and re-hydrate on remount. The footer
 * still does NOT lean on that selection — it gets the modal's own id, or `null`
 * before the first send — so the workspace's previously-active Session is never
 * displayed and never written here, whichever way the selection moves.
 *
 * That last clause is why the reads below do NOT go through
 * `useChatSessionDerivations`: that hook takes no session-id argument and reads
 * `s.activeSessionId` inside every selector, so borrowing it would re-key this
 * surface on a value the sidebar, the tab strip and `selectSpace` all write — one
 * click elsewhere would silently repoint the modal's transcript and its composer
 * lock at a DIFFERENT conversation while the user is mid-message. So the modal
 * calls the hook's OWN pure module (`lib/chatSessionDerivations`) with its own
 * id, which is the shape that module was extracted for ("the pure logic lives in
 * `lib/chatSessionDerivations.ts`; this is a HOOK (it reads the stores)") — one
 * implementation of every predicate, and the hook is only the active-session
 * binding this surface must not adopt.
 */
export interface NewTaskDialogProps {
  /** The **Space** the board is showing: the Task's `space_path` AND the cwd
   *  `startTaskSession` starts the Session in (CONTEXT.md — a Session's `cwd` IS
   *  the Space's folder). `TasksBoard` passes the same value `App`'s
   *  `SpaceCwdProvider` uses, so board and modal cannot disagree about which
   *  folder is being worked in. `null` = no active Session, in which case there
   *  is nothing to create and the send says so instead of calling the IPC. */
  spacePath: string | null;
  /** The linked Space's columns in `get_board`'s own order, NESTED
   *  (`{ stage, tasks }`). The FIRST entry is the stage a new Task lands in;
   *  `get_board` returns stages by `sort_order`, so this is NOT re-sorted here —
   *  a second sort would be a second answer to a question the server settled.
   *  `readonly` because `TasksBoard`'s memoised board slice is a stable identity
   *  both surfaces read and neither may reorder. */
  boards: readonly StageWithTasks[];
  onClose: () => void;
}

/** The dropdown's pinned skills, in order: the two the board's workflow starts
 *  from. Each is offered ONLY if the catalog has it — `expandMentions` leaves an
 *  unmatched token VERBATIM, so an option with no catalog row would send the
 *  literal `$discuss` to the model. */
const PINNED_SKILLS = ["discuss", "research"] as const;
const NO_SKILL = "none";

/** The composer takes the attachment handlers as required props. This modal has
 *  no attachments (see the module note), so it hands over the empty list and
 *  three no-ops — module-scope constants, so their identity never changes and the
 *  composer subtree is never handed a fresh closure per render. */
const NO_ATTACHMENTS: ChatComposerAttachment[] = [];
const NOOP_REMOVE = (): void => {};
/** Staging is off, so this handler takes NO argument and does nothing. A
 *  zero-parameter function is assignable to `ComposerRow`'s
 *  `(e) => void` prop, and it deliberately does NOT `preventDefault`: that would
 *  eat the user's typed TEXT paste to stop an image that `imageCapable: false`
 *  already refuses. */
const NOOP_PASTE = (): void => {};
const NOOP_DROP = (e: DragEvent): void => {
  // The window-level backstop (`useWindowDropBackstop`) is what stops a file drop
  // navigating the webview; this handler only declines to stage.
  e.preventDefault();
};
const NOOP_ATTACH = async (): Promise<void> => {};

/** Escape a value going into an XML-ish ATTRIBUTE of a prompt-injected block.
 *
 *  `expandMentions` gets away without this by only ever interpolating names the
 *  token grammar can carry (`[a-z0-9-]`), which excludes every tag-unsafe
 *  character by construction. A **Task title is free text**: `clean_title`
 *  collapses whitespace, caps at 80 chars and strips one MATCHING SURROUNDING
 *  quote pair, so inner quotes, `<` and `>` survive into `TaskRow.title`.
 *  Unescaped, a title of `x" onload="boom` would close the attribute and add one,
 *  and a first line containing `</task>` would end the block early and let the
 *  rest of the line out of it. Both are reachable from a card a harness tool
 *  created, so this is an injection point and not a formatting nicety. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The `<task>` block: open, self-contained, LAST in the message — the
 *  `<skill>` shape (`lib/skills.ts`'s `buildBlock`), no nesting, no fence. The
 *  title is an ATTRIBUTE and is escaped; the body is element content, where the
 *  one sequence that matters is the one that could close the tag early. */
function taskBlock(
  taskId: string,
  stageSlug: string,
  title: string,
  body: string,
): string {
  return (
    `<task id="${escapeAttr(taskId)}" stage="${escapeAttr(stageSlug)}"` +
    ` title="${escapeAttr(title)}">\n` +
    `${title}\n\n` +
    `${body.replace(/<\/task>/gi, "&lt;/task>")}\n` +
    `</task>`
  );
}

export default function NewTaskDialog({
  spacePath,
  boards,
  onClose,
}: NewTaskDialogProps) {
  // ── The modal's own state ────────────────────────────────────────────────
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<MentionPickerState | null>(null);
  const [skillName, setSkillName] = useState<string>(NO_SKILL);
  // The Session this dialog is about. `null` = not started yet, which is exactly
  // what the footer needs to know: an explicit `null` means "there is no Session
  // to configure", NOT "use the globally active one" — see `SessionConfigBlock`.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The double-send slot for THIS surface. The rule "one Set per chat surface"
  // is about a surface's send and its queue Flush sharing a view; this modal has
  // no Flush, and the workspace's Set belongs to a `ChatStream` that is unmounted
  // while the board is up. `busy` alone cannot carry the guard — it is state, so
  // a second Enter dispatched before the re-render reads the pre-update value —
  // which is why the pre-Session window gets its own ref below and the
  // post-Session window uses this Set, keyed by session id like the workspace's.
  const sendingRef = useRef<Set<string>>(new Set());
  const firstSendInFlight = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const createTaskInStore = useTasks((s) => s.createTask);
  const addSession = useSessions((s) => s.addSession);
  const addUserMessage = useSessions((s) => s.addUserMessage);
  const beginTurn = useSessions((s) => s.beginTurn);
  const turnCompleted = useSessions((s) => s.turnCompleted);
  const loadOlder = useSessions((s) => s.loadOlderHistory);

  // ── The store reads, every one keyed on the MODAL's session id ───────────
  // Not `activeSessionId`: the transcript, the lock and the config must describe
  // the Session THIS dialog started. Each selector returns a stored value or
  // `undefined` — never a fresh `[]`/`{}` — the stable-reference rule every
  // zustand read here follows (a selector minting a new object re-renders
  // forever, which hangs the suite rather than failing it).
  const messages =
    useSessions((s) => (sessionId ? s.messages[sessionId] : undefined)) ?? [];
  const liveSession = useSessions((s) =>
    sessionId
      ? s.sessions.find((x) => x.sessionId === sessionId)
      : undefined,
  );
  // The presence half of "is this id known to any of the three lists" — the
  // `sessionFieldOf` walk's question, asked of the modal's id rather than the
  // active one. A Session closed in this app run stays in `sessions`, so in
  // practice `liveSession` answers it; the wider walk is what keeps a Session
  // that moved to Archived mid-chat from reading as "never existed".
  const sessionIsKnown = useSessions((s) =>
    sessionId
      ? s.sessions.some((x) => x.sessionId === sessionId) ||
        s.historySessions.some((x) => x.sessionId === sessionId) ||
        s.archivedSessions.some((x) => x.sessionId === sessionId)
      : false,
  );
  const inTurn = useSessions((s) =>
    sessionId ? !!s.inTurn[sessionId] : false,
  );
  const compacting = useSessions((s) =>
    sessionId ? s.compacting[sessionId] : undefined,
  );
  const stopReason = useSessions((s) =>
    sessionId ? s.stopReasons[sessionId] : undefined,
  );
  const historyEntry = useSessions((s) =>
    sessionId ? s.history[sessionId] : undefined,
  );
  const agentState = useInteractive((s) =>
    sessionId ? s.agentState[sessionId] : undefined,
  );
  const interactiveRequests =
    useInteractive((s) => (sessionId ? s.requests[sessionId] : undefined)) ?? [];
  const prompts =
    usePermissions((s) => (sessionId ? s.prompts[sessionId] : undefined)) ?? [];
  const spinnerStyle = normalizeVariant(
    useSettings((s) => s.settings?.spinnerStyle ?? "typing"),
  );
  const emptyStateAnimation = useSettings(
    (s) => s.settings?.emptyStateAnimation ?? null,
  );

  // ── The derivations, from the SAME pure module `ChatStream` reads ────────
  const kind = sessionKindDerivations({
    liveSession,
    activeSessionIsKnown: sessionIsKnown,
    // A freshly-started Session's capabilities are the ones the start returned;
    // `addSession` stored that row, so the row is the source.
    activeCapabilities: liveSession?.capabilities,
  });
  const lock = composerLockDerivations({ agentState, inTurn, compacting });
  const quip = useSpinQuip(lock.workingOrInTurn);
  const pagination = historyPaginationDerivations({ history: historyEntry, loadOlder });
  const { askRequests, confirmRequests, passwordRequests } =
    classifyInteractiveRequests(interactiveRequests);
  const anchored = anchoredAskRequestIds(askRequests, messages);
  const stacked = stackedAskRequests(askRequests, anchored);
  const currentTurnDiffs = turnDiffs(messages).turnDiffs;
  const childGates = useChildGates(sessionId);
  const hasPendingRequest = useHasPendingRequest();

  // ── The composer's catalogs and picker (the existing hooks, unchanged) ───
  const { skills, agents, files } = useMentionCatalogs(spacePath);
  const activeRemainder = picker?.prefix === "?" ? picker.query : "";
  const outside = isOutsideSpaceQuery(activeRemainder);
  // The completion CACHE KEY is the token's DIRECTORY, not its whole remainder —
  // the derivation and its reasoning are `ChatStream`'s, mirrored here.
  const dirPrefix = outside ? dirPartOfOutsideQuery(activeRemainder) : null;
  const { dir: completion, pending: completionPending } =
    useCompletionDir(dirPrefix);
  const { filtered, note: pickerNote, activeIndex, selectMention } =
    useMentionPicker({
      draft,
      setDraft,
      draftRef,
      composerRef,
      picker,
      setPicker,
      skills,
      agents,
      mcpServers: [],
      files,
      completion,
      mcpMentionsEnabled: false,
    });
  useAutoGrowComposer(composerRef, draft);
  useWindowDropBackstop();

  const units = useMemo(() => groupConsecutiveFileWrites(messages), [messages]);

  /** The dropdown's rows: the pinned skills this Space's catalog actually has,
   *  then `No skill`. */
  const skillOptions = useMemo(() => {
    const byName = new Map(skills.map((s) => [s.name, s]));
    return PINNED_SKILLS.map((name) => byName.get(name)).filter(
      (s): s is SkillInfo => s !== undefined,
    );
  }, [skills]);

  // The board's FIRST column, read NESTED (`.stage`, never `.slug`).
  const firstStage = boards[0]?.stage;

  /** The shared send tail. `text` is ALREADY expanded and composed — the caller
   *  owns that, because the `<task>` block has to be appended after expansion. */
  const dispatch = async (targetId: string, text: string): Promise<void> => {
    if (sendingRef.current.has(targetId)) return;
    sendingRef.current.add(targetId);
    try {
      // ONE string, three consumers (the bubble, the persisted row, the wire):
      // ADR 0031's dedupe key is content-based, so any divergence re-imports this
      // turn on the next resume.
      addUserMessage(targetId, text);
      beginTurn(targetId);
      // Wiped at COMMIT, not at settle — the message is already recorded, so a
      // failed send must not resurrect it into the composer.
      setDraft("");
      const reason = await sendPrompt(targetId, text);
      turnCompleted(targetId, reason);
    } catch (err) {
      // Settle FIRST, then explain: `turnCompleted` is the only thing that
      // clears `inTurn`, and a turn that never settles locks this composer for
      // the rest of the modal's life.
      turnCompleted(targetId, "end_turn");
      setError(describeIpcError(err));
    } finally {
      sendingRef.current.delete(targetId);
    }
  };

  /** The FIRST send: create the Task, link a Session to it, send the prompt. */
  const firstSend = async (): Promise<void> => {
    const raw = draftRef.current.trim();
    if (raw === "") return;
    if (busy || firstSendInFlight.current) return;
    if (spacePath === null) {
      setError("No Space is open, so there is nothing to create a Task in.");
      return;
    }
    if (firstStage === undefined) {
      // A board with no columns cannot host a card, and `get_board` seeds five on
      // first read — so an empty board here means the fetch has not landed (or
      // failed), not a Space that is genuinely column-less.
      setError("The board has not loaded, so there is no first stage to file a Task under.");
      return;
    }
    firstSendInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // 1. THE TASK, FIRST. `clean_title` runs server-side (whitespace collapse,
      //    one quote layer stripped, multi-byte-safe cap) and a title that cleans
      //    to nothing REJECTS with `kind: "empty_title"` — it does not fall back
      //    to the raw string. So the frontend passes the first line and nothing
      //    else; re-implementing that predicate locally is the second
      //    implementation the spec forbids.
      const firstLine = raw.split("\n")[0]!.trim();
      const task = await createTaskInStore(
        spacePath,
        firstLine,
        undefined,
        firstStage.slug,
      );
      // 2. THE SESSION, linked to that id. THREE arguments: the cwd, the Task to
      //    link, and the stage the link is made FROM (the stage a later drag into
      //    a `compact` column compacts from). There is no seed parameter, so
      //    there is no way to pass task context by accident.
      const info = await startTaskSession(spacePath, task.id, firstStage.slug);
      // 3. THE SELECTION. `addSession` upserts the row AND selects it — the
      //    sidebar row and the visible transcript are then the same fact, and the
      //    store owns the switch rather than the dialog re-implementing it.
      addSession(info);
      setSessionId(info.sessionId);
      // 4. THE TEXT. The chosen skill rides the draft as a `$name` token, so the
      //    ONE expansion path handles it exactly as it handles a typed Mention
      //    (ADR 0013) — no second skill-injection code path, and the picker can
      //    only ever offer a name the token grammar can carry.
      const withSkill =
        skillName === NO_SKILL ? raw : `${raw}\n\n$${skillName}`;
      const expanded = expandMentions(withSkill, {
        skills,
        agents,
        // The `#` gate: an EMPTY catalog means the prefix expands to nothing and
        // the text stays byte-identical (see the module note).
        mcpServers: [],
      });
      // 5. THE TASK BLOCK, LAST — after the user's own words and after every
      //    expanded block, so the message reads: what you asked, then the context
      //    that frames it. The block NEVER precedes the user's words.
      const text = `${expanded}\n\n${taskBlock(
        task.id,
        task.stageSlug,
        task.title,
        firstLine,
      )}`;
      await dispatch(info.sessionId, text);
    } catch (err) {
      // Nothing was settled here on purpose: every failure this catch can see
      // happened BEFORE `dispatch` opened a turn (a failed send settles inside
      // `dispatch`'s own catch). Settling a turn that never began would overwrite
      // a stop reason for a prompt that never shipped — the same asymmetry
      // `usePromptQueueFlusher` carries a `dispatched` flag for.
      const kindOfError = (err as { kind?: unknown } | null)?.kind;
      // ADR 0063 puts the sentence in Rust, so this only ADDS a lead-in naming the
      // action to take; the server's message is appended unchanged.
      setError(
        kindOfError === "empty_title"
          ? `Give the Task a title first — ${describeIpcError(err)}.`
          : describeIpcError(err),
      );
    } finally {
      firstSendInFlight.current = false;
      setBusy(false);
    }
  };

  /** A follow-up prompt: the same Session, plain expanded text, no Task work. */
  const followUpSend = async (targetId: string): Promise<void> => {
    const raw = draftRef.current.trim();
    if (raw === "") return;
    setError(null);
    await dispatch(
      targetId,
      expandMentions(raw, { skills, agents, mcpServers: [] }),
    );
  };

  const send = async (): Promise<void> => {
    if (draftRef.current.trim() === "") return;
    if (sessionId === null) {
      await firstSend();
      return;
    }
    await followUpSend(sessionId);
  };

  // Pre-send there IS no Session to be closed or non-resumable, so the composer
  // is enabled (its whole job here is to start one). Afterwards the workspace's
  // own gate applies — a Session that died mid-chat must not look sendable.
  const composerEnabled = sessionId === null ? true : kind.composerEnabled;
  const composerLocked = busy || lock.composerLocked;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* `sm:max-w-3xl` and NOT `max-w-3xl`: `DialogContent`'s base class ends in
          `sm:max-w-md`, and a bare `max-w-*` sits in a DIFFERENT tailwind-merge
          group, so both survive to the stylesheet and the `sm:` rule wins above
          640px — the modal would silently be 28rem wide, and jsdom cannot see it.
          Pinned by `src/components/ui/dialog.test.tsx`. */}
      <DialogContent className="flex h-[80vh] w-full flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Your first message creates the Task and its Session. Closing this
            window leaves both behind.
          </DialogDescription>
        </DialogHeader>

        {/* The skill dropdown. A selection is neither a mode nor a body to
            inject: it puts a `$name` token into the FIRST message, so the skill
            expands the way typing `$discuss` in the composer does — on send,
            before the message is recorded. It retires once the message is gone,
            because changing it then would silently do nothing. */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            id="new-task-skill-label"
            className="text-ui-sm text-foreground-subtle"
          >
            Skill
          </span>
          <Select
            value={skillName}
            onValueChange={setSkillName}
            disabled={sessionId !== null}
          >
            <SelectTrigger
              size="sm"
              variant="outline"
              aria-labelledby="new-task-skill-label"
              className="w-40"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {skillOptions.map((s) => (
                <SelectItem key={s.name} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
              <SelectItem value={NO_SKILL}>No skill</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {sessionId === null ? (
          // No Session yet, so there is no transcript to paint. This is the
          // modal's honest empty state, and the line says what happens next
          // rather than leaving a blank pane that reads as a broken chat.
          <EmptyListLine>
            Send a first message to start the Task and its Session.
          </EmptyListLine>
        ) : (
          <MessageList
            units={units}
            activeSessionId={sessionId}
            inTurn={inTurn}
            askRequests={askRequests}
            prompts={prompts}
            stackedAskRequests={stacked}
            childGates={childGates}
            hasPendingRequest={hasPendingRequest}
            workingOrInTurn={lock.workingOrInTurn}
            agentState={agentState}
            turnDiffs={currentTurnDiffs}
            stopReason={stopReason}
            hasMore={pagination.hasMore}
            loadingMore={pagination.loadingMore}
            generation={pagination.generation}
            emptyStateAnimation={emptyStateAnimation}
            onStartReached={() => void loadOlder(sessionId)}
          />
        )}

        <IpcErrorLine error={error} className="shrink-0" />

        <ComposerRow
          composerRef={composerRef}
          draft={draft}
          setDraft={setDraft}
          picker={picker}
          setPicker={setPicker}
          filtered={filtered}
          note={pickerNote}
          activeIndex={activeIndex}
          completionPending={completionPending}
          selectMention={selectMention}
          attachments={NO_ATTACHMENTS}
          removeAttachment={NOOP_REMOVE}
          handlePaste={NOOP_PASTE}
          handleDrop={NOOP_DROP}
          handleAttachClick={NOOP_ATTACH}
          send={send}
          composerEnabled={composerEnabled}
          composerLocked={composerLocked}
          imageCapable={false}
          hasImages={false}
          agentState={agentState}
          workingOrInTurn={lock.workingOrInTurn}
          compacting={compacting}
          spinnerStyle={spinnerStyle}
          quip={quip}
        />

        {/* The footer. `sessionId` is passed EXPLICITLY rather than left to the
            default: before the first send it is `null` — "no Session to
            configure", the disabled stub — and NOT the workspace's
            previously-active Session, whose model this footer must never print or
            write. Afterwards it is the modal's own id, so the picker keeps
            pointing at the right Session even if the global selection moves. */}
        <div className="shrink-0 border-t border-border pt-1">
          <SessionConfigBlock sessionId={sessionId} />
        </div>

        {/* The `confirm` / `password` gates THIS Session raises. This mount is
            NOT redundant with `App`'s `SubagentModals`: that host renders a
            gate for a gate whose owner is a SUBAGENT session (it walks
            `childGatesOf`, keyed by subagent entries), so a MAIN session's
            sudo gate is rendered in exactly one place — `ComposerModals`, inside
            `ChatStream`. And the board view UNMOUNTS `ChatStream`. Without this
            line a `confirm` the Task's agent asks for would be raiseable and
            INVISIBLE, stranding the turn: ADR 0055 puts no clock on a session
            parked at a gate, so nothing else ever frees it. That is the same
            defect the spec's "must NOT unmount" rule exists to prevent, arriving
            through the other door. Rendered as a SIBLING of the footer rather
            than a child of a scrolling region, because these are Radix `Dialog`s
            (the `fixed`-overlay rule in `ComposerModals`'s own header). */}
        {sessionId !== null && (
          <ComposerModals
            activeSessionId={sessionId}
            confirmRequests={confirmRequests}
            passwordRequests={passwordRequests}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
