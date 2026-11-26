import { create } from "zustand";

/**
 * The interactive store — the desktop's delegated interactive UI (Task 5).
 * Mirrors `permissions.ts` (pending prompts keyed by session id).
 *
 * **Password hygiene:** the `password` method's secret lives ONLY in the
 * modal's local `useState` — it is sent via `respondInteractiveRequest` and
 * is NEVER stored here (0010 / ADR 0022 invariant), so there is no
 * `markAnswered` step: a settled request is removed outright.
 *
 * **Session-id identity (B3):** the `sessionId` in every
 * `interactive-request` / `interactive-event` payload is the ACP session id
 * (the native `AgentLoop` is constructed with it, so the events always
 * carry it). The store keys by this ACP id, which is the same id the
 * frontend's `activeSessionId` holds (from `startSession`'s return) — so
 * the keys line up.
 */

/** A pending interactive request (an `interactive-request` event, keyed by `requestId`). */
export interface InteractiveRequestData {
  /** The frame UUID (the correlation key — never the bare `toolCallId`). */
  requestId: string;
  method: "ask" | "confirm" | "password";
  /**
   * The emitter's label. Every `interactive-request` the desktop builds today
   * carries `"native"`: `ask_flow` (`src-tauri/src/agent/harness/ask.rs`) emits
   * it verbatim, and the `sudo_run_flow` core
   * (`src-tauri/src/agent/interactive/mod.rs`) — the `confirm` / `password`
   * sub-prompts — is handed it as its `source` argument by the `AgentLoop`'s
   * tool dispatch (`src-tauri/src/agent/harness/loop.rs`), which passes the same
   * literal to `todo_apply` for its `todos_update` push, for a MAIN session and
   * a Subagent session alike. So this is NOT a main/child discriminator and
   * never was one on the wire: `"main"` and `"sudo"` exist only in Rust
   * fixtures and `bin/fake_worker.rs`. The consumers that still branch on
   * it — `AskQuestionCard`'s `source === "main"` anchoring and its `subagent:`
   * gate for the `queued` placeholder — therefore never fire on production
   * traffic. The card's "who is asking" LABEL no longer reads this field at
   * all: it resolves the child's `agentName` from `useSubagents` (see
   * `AskQuestionCard`). Todo boards no longer branch on
   * it at all: they are keyed by SESSION id, never by this label (ADR 0041), so
   * a future real `source` must arrive as a SESSION identity the Client can
   * join (child id → parent, `agentName` — what `useSubagents` already
   * provides), not a prettier string.
   */
  source: string;
  /** The invoking process's tool-call id (absent for `confirm`/`password`). */
  toolCallId?: string;
  /** The method's params: the ask schema for `ask`; `{ command, reason }` for `confirm`/`password`. */
  params: Record<string, unknown>;
}

/**
 * Whether a `method` is a PAUSE ON THE USER — a request that sits unanswered
 * until a human answers it, and therefore the thing every "this Session is
 * waiting on you" cue is derived from.
 *
 * ONE predicate, exported from the store that owns the union, because four
 * consumers ask the question and a cue that disagrees with another cue is worse
 * than no cue (the standing "one derivation, many consumers" rule
 * `useSessionStatus` documents): `childGatesOf` (which feeds the inline card,
 * the overlay and the dot), `sessionStatusOf`, the attention snapshot, and
 * `useHasPendingRequest`. Each of them hand-writing the three comparisons is
 * how a fourth `method` would be counted by one surface and dropped by
 * another — and `childGatesOf`'s comment promises the filter exists precisely
 * for that day, which `useChildGates.test.ts` now pins.
 */
export const isInteractivePause = (
  method: InteractiveRequestData["method"],
): boolean => method === "ask" || method === "confirm" || method === "password";

/**
 * One checklist item.
 *
 * The field names mirror the `manage_todo_list` wire shape. The engine crate's
 * own type for that shape keeps the old spelling — `pub struct TodoItem` at
 * `fulcrum-harness` `src/todo.rs:38` — and is NOT renamed here: it is frozen by
 * ADR 0093 alongside the tool name and the two wire strings.
 */
export interface ChecklistItem {
  content: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
}

/** The bus `TODOS_UPDATE` payload (verbatim over the wire). */
export interface TodoUpdatePayload {
  source: string;
  todos: ChecklistItem[];
}

/**
 * THE `ready` MARK — one card's entry in the slot the board read writes.
 *
 * `ready` is a COLUMN (`sessions.ready`), not a word. The `mark_done` host verb
 * sets it, `send_prompt_with_images` clears it at turn start, and `get_board`
 * publishes the OR over a card's linked Sessions as `TaskCardView.ready`. The
 * frontend reads that field and nothing else — this module holds no vocabulary, no
 * item to recognise and no sentence that teaches a model one, which is the point of
 * the change: one claim, one channel.
 *
 * A slot entry is `PRESENT AND TRUE` — the value is the card's linked Session ids,
 * which is the one hop the two optimistic clears need (they are handed a SESSION id
 * and must find the cards that link it). A card whose claim is not present is not
 * ready; "no entry" and "false" are the same answer, so neither is a lie about a
 * card nobody has read.
 *
 * ## Why the slot is keyed by (Space, card) and NOT by Session
 *
 * `TaskCardView.ready` is a per-CARD OR and does not say WHICH link carries the
 * claim. Writing it per-Session would therefore attribute one card's claim to every
 * Session the card links — and light the bell on a DIFFERENT card that happens to
 * link one of them, a card the board read reported NOT ready. `boardReadyMarks.test.ts`
 * pins exactly that case. Keying by card is what the read actually asserts; the
 * Session ids ride along in the value so `beginTurn` and `dismissSession` can still
 * resolve a Session into the cards it lights.
 *
 * ## Why the key carries the Space
 *
 * `boardsBySpace` is per-Space and so is a read, so the replace must be scoped to
 * the Space that was read (a global replace would wipe another Space's marks —
 * `boardReadyMarks.test.ts` pins it). A `spacePath` prefix makes that scoping a
 * prefix test with no auxiliary bookkeeping to keep coherent, and `readyCardKey` is
 * the only thing that spells the shape, for the writer and the reader alike.
 */
export interface ReadyCardEntry {
  /** The card the read reported — `TaskRow.id`. */
  taskId: string;
  /** `TaskCardView.ready`, exactly as the read answered it. */
  ready: boolean;
  /** The card's linked Session ids (`TaskCardView.sessions[].sessionId`). */
  sessionIds: readonly string[];
}

/** The slot key for one card in one Space. THE ONLY spelling of it — the board feed
 *  writes through it and `TasksBoard` reads through it, so the two cannot drift into
 *  two different shapes of the same string. */
export const readyCardKey = (spacePath: string, taskId: string): string =>
  `${spacePath}\u0000${taskId}`;

/**
 * One session's money and tokens, as the `cost_update` frames leave them in the
 * store (the store-entry type — NOT the wire's inner payload, which is only
 * `{ costUsd, source }`).
 *
 * `costUsd` is D5's key (issue #87). `cost` is the LEGACY alias, still read by
 * `SubagentDelegatingCard.tsx`'s `interactiveCost?.cost` link; see the note on
 * the field below for its two roles and their two expiries.
 */
export interface CostUpdatePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * The compatibility alias of `costUsd` — same value, same writer, one
   * accumulator. It has TWO ROLES and therefore TWO EXPIRIES, and deleting one
   * half while the other is still live is the mistake this note exists to stop:
   *
   * - **read-side**: `SubagentDelegatingCard.tsx`'s fallback chain reads
   *   `interactiveCost?.cost`. It expires when that link is repointed at
   *   `costUsd` — a change that is deliberately SEQUENTIAL and lands strictly
   *   after this alias exists (seam S4), never in the same wave as it.
   * - **input-side**: `applyCost` accepts a frame's legacy `cost` key. It
   *   exists only for a pre-D5 emitter, and T09's wire contract emits
   *   `{ costUsd, source }` and nothing else — so once T09's frames are in tree
   *   the only remaining producer of `cost` is a test fixture. It expires in
   *   the SAME commit as the read-side half (repoint the card, drop the input
   *   fallback, drop the field, drop the legacy test seeds).
   *
   * Note the card's own shape is an `as` assertion, not a checked annotation, so
   * `tsc` will NOT flag a `null` here against its declared `cost?: number`. The
   * safety of the alias is the card's runtime gate (`row.cost > 0`, and `null`
   * fails it), not the type checker — do not trust the types on this link.
   */
  cost?: number | null;
  /**
   * The session's cumulative USD figure, exactly as the provider reported it
   * (D4/D5). `null` is a REACHABLE, MEANINGFUL value: "no frame this session
   * carried a figure" — which is NOT the same fact as `0` ("a frame reported a
   * real zero"). A renderer that cannot tell them apart prints `$0.00` for a
   * session that spent nothing observable, which is the defect #87 was filed
   * to end.
   */
  costUsd?: number | null;
  source?: string;
}

/**
 * THE delta/total seam (issue #87; the FLIP is Fulcrum T2's).
 *
 * A `cost_update` frame carries the session's RUNNING TOTAL, so the entry IS
 * the last frame — LAST FRAME WINS — and an unknown frame (`null`) changes
 * NOTHING: `null + null = null` (still unknown), `null + x = x`, `x + null = x`
 * in the old arithmetic; `null → null`, `null → x = x`, `x → null = x` here.
 * That unknown rule is what stops D5's unknown from being manufactured into a
 * real `$0`; the inline `(prev.cost ?? 0) + (p?.cost ?? 0)` this function
 * replaced did exactly that, and it is why a session with no priced call
 * displayed `$0.00`. That half is untouched by the flip.
 *
 * WHY LAST-FRAME-WINS, in one line: the emitter now sums (`AgentLoop::cost_acc`,
 * seeded from `sessions.cost_usd` on `Resume`), so a store that also summed
 * would add the same money twice — and the DB write on the other side of the
 * same frame became an overwrite in the same commit, so a summing store would
 * disagree with the row it mirrors. The double count this used to prevent (a
 * re-delivered delta doubling the figure, ADR 0082's limit 7) is now impossible
 * at all three consumers, which is the point of the change.
 *
 * The doc comment that used to live here described this exact flip as
 * HYPOTHETICAL — "if a frame ever carries a RUNNING TOTAL, this is the only line
 * that changes… The test that reddens is named for this contract, in
 * `interactive.test.ts`." That day is this commit: the line changed, the named
 * test reddened, and nothing in `SessionCostLine.tsx` or `SidePane.tsx` moved —
 * the component reads the entry, never the frames, exactly as predicted.
 */
function combineSessionCost(
  prev: number | null,
  frame: number | null,
): number | null {
  if (prev === null) return frame;
  if (frame === null) return prev;
  // The frame's word over the previous entry: it is the emitter's own total,
  // which knows things this store cannot (a resumed loop continues the stored
  // figure; a replay restates it).
  return frame;
}

/**
 * A frame's money, or `null` for "this frame reported no figure".
 *
 * `costUsd` (D5's key) wins; the legacy `cost` key is the fallback for a
 * pre-D5 emitter. Reading them in this order — and ONCE — is what makes a
 * mixed-key frame count ONCE: a frame carrying both `{ cost: 0.005,
 * costUsd: 0.007 }` is `0.007`, never `0.012`. (Before Fulcrum T2 this sentence
 * spoke of a mixed-key SEQUENCE summing once; the sequence is last-frame-wins
 * now, but the one-read rule that stops a frame's two keys being added together
 * is untouched.)
 *
 * A value that is not a finite non-negative number is UNKNOWN, not money: a
 * string, `NaN`, `Infinity` and a negative all normalise to `null`. Nothing may
 * invent a figure here.
 */
function frameCost(p: CostUpdatePayload | undefined): number | null {
  const raw = p?.costUsd ?? p?.cost;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

interface InteractiveState {
  /** Pending interactive requests, keyed by the ACP session id. */
  requests: Record<string, InteractiveRequestData[]>;
  /**
   * One session's OWN `manage_todo_list` list, keyed by that session's id
   * (main OR Subagent); one Session runs one Agent harness, so exactly one
   * board (ADR 0041). Boards are persistent session state seeded on
   * open/resume; a clear leaves the board empty until the next `todos_update`.
   */
  todos: Record<string, ChecklistItem[]>;
  /**
   * The cards the LAST BOARD READ reported **ready**, keyed by
   * [`readyCardKey`] (Space + Task id). PRESENCE is the claim; the value is that
   * card's linked Session ids, which is the one hop the two optimistic clears need
   * (they are handed a SESSION id and must find the cards that link it). A card
   * with no key is not ready, so "no entry" and "false" are the same answer and
   * neither is a lie about a card nobody has read.
   *
   * ## Why this is an explicit slot and NOT a derivation (do not "simplify" it)
   *
   * The durable fact is `sessions.ready`, and the board read carries it — so this
   * map is not the store of the claim, it is the RENDER HALF of it, and it exists
   * for one reason: `useTaskBoardAutoRefresh` re-reads the board only on
   * `inTurn`'s FALLING edge. Without a slot the bell would therefore stay lit for
   * the whole of the next turn, and `cardMarkOf` ranks `ready` ABOVE `running` —
   * the "running but ready" pair the owner rejected on a real board. The
   * `beginTurn` clear bridges exactly that gap, and the next settle's read confirms
   * it, because the Rust-side turn-start clear has already zeroed the column.
   *
   * Deriving `ready && !inTurn` instead is worse than wrong: it makes the mark
   * vanish while a turn runs and REAPPEAR when it settles, which is the opposite of
   * "the next turn clears it". `the mark does NOT come back when the turn settles`
   * in `sessionReadyMark.test.ts` and its board twin in
   * `TasksBoardReady.test.ts.ts` are what stop that shape coming back.
   *
   * ## Why the key is (Space, card) and NOT a Session id
   *
   * `TaskCardView.ready` is a per-CARD OR over the card's linked Sessions and does
   * not say WHICH link carries the claim. Writing it per-Session would attribute one
   * card's claim to every Session it links, and light the bell on a DIFFERENT card
   * that happens to share one of them — a card the read reported NOT ready.
   * `a card that only links the UNREADY half of a ready card's links stays
   * unmarked` in `boardReadyMarks.test.ts` is that case. The Space half of the key
   * is what lets a read replace only the Space it read; a global replace would wipe
   * another Space's marks, and a Space nobody is looking at gets no read at all.
   *
   * ## What this map is NOT any more
   *
   * It used to be scraped out of a Session's todo list — a `completed` item whose
   * content was the single word `ready` — and it used to be keyed by Session, which
   * meant a Session whose history had never been read had no mark. Both halves are
   * retired: `mark_done` sets the column, `send_prompt_with_images` clears it, and
   * the board read is the only thing that feeds this map.
   */
  ready: Record<string, readonly string[]>;
  /** The agent state machine (`working`/`idle`/`blocked`) — wired, not rendered in v1. */
  agentState: Record<string, "working" | "idle" | "blocked">;
  /**
   * One session's cumulative money + tokens, keyed by session id (issue #87).
   * **Rendered** — `SessionCostLine` reads this entry and prints the figure
   * under the session title (via `lib/sessionCost.ts`, which falls back to the
   * session ROW's `costUsd` when this map holds no entry). Written by
   * `applyCost`, from `cost_update` FRAMES, and by `seedCostFromRow`, which
   * copies a stored TOTAL off the DB row at resume.
   *
   * The money field is a SNAPSHOT of the emitter's total, not a local sum
   * (Fulcrum T2): `combineSessionCost` takes the last frame's word. The direct
   * write rule for a stored figure SURVIVES that change, for a different reason
   * than it did — `applyCost` no longer adds, but it also writes the four TOKEN
   * fields, and tokens are never persisted, so routing a hydrator's stored total
   * through it would fabricate a `0`-token entry that
   * `SubagentDelegatingCard`'s context-% chain then prefers over its own
   * sources. Write it directly (the way `sessions.ts` copies `contextUsage` off
   * the row).
   */
  cost: Record<string, unknown>;
  /** The last `session` push payload — wired, not rendered in v1. */
  session: Record<string, unknown>;

  /** Add a request (dedup by `requestId` — a re-delivered frame replaces). */
  addRequest: (sessionId: string, data: InteractiveRequestData) => void;
  /** Remove a settled request. */
  removeRequest: (sessionId: string, requestId: string) => void;
  /**
   * A `todos_update` push: replace this session's board. The payload's
   * `source` is NOT consulted (ADR 0041).
   *
   * Writes `todos` and NOTHING else. It used to also read the **ready** marker out
   * of the snapshot, and that is gone: readiness is a column now
   * (`sessions.ready`), and the board read is its only reader — see
   * [`applyReadyMarks`]. Two channels for one claim is what this removed.
   */
  applyTodoUpdate: (sessionId: string, payload: unknown) => void;
  /**
   * A `todos_clear` push: drop this session's WHOLE board. The payload's
   * `source` is not consulted — a clear names a SESSION, never a label
   * (ADR 0041).
   *
   * The key is DELETED, leaving the session's board empty until the next
   * `todos_update`.
   *
   * It used to drop the **ready** mark with the board, and that arm went with the
   * word: a checklist says nothing about readiness once readiness is a column, so
   * a cleared board is no longer a reason to withdraw a bell. A Session that stops
   * being ready has its column cleared in Rust and the next read says so; a
   * DELETED Session is cleared by `dismissSession`, which is the close that actually
   * means the claim is over.
   */
  applyTodoClear: (sessionId: string) => void;
  /**
   * THE BOARD FEED — replace ONE Space's **ready** marks with what a board read
   * just reported. Called by `tasks.ts` after `load`/`refresh` produce columns,
   * through THIS ACTION and never by poking the map, the same discipline
   * [`clearReady`] exists for.
   *
   * ## Scope: the Space that was read, and only that Space
   *
   * Every key of this Space is replaced (so a claim the read no longer carries
   * goes, and a card that left the board leaves the slot) and every key of any
   * OTHER Space is left standing — `boardsBySpace` is per-Space, a read covers one,
   * and a Space the user is not looking at gets no read at all. Pinned by
   * `the board feed replaces ONE Space's marks only` in `boardReadyMarks.test.ts`.
   *
   * ## Identity: an unchanged read changes NOTHING
   *
   * A read that agrees with the slot returns the identical state object. `zustand`
   * compares a selector's result with `Object.is` and `TasksBoard` subscribes to
   * this map, so a fresh object per read would re-render the whole board every time
   * the auto-refresh fires.
   *
   * ## The three writers of this map, all of them deliberate
   *
   *  1. **This action** — the board feed. The durable answer: it lands the
   *     `sessions.ready` column the `mark_done` verb sets and
   *     `send_prompt_with_images` clears, on every mount read and every
   *     auto-refresh, for Sessions that were never opened.
   *  2. **[`clearReady`]**, from `sessions.ts`'s `beginTurn` — the OPTIMISTIC
   *     clear. The column is already zeroed in Rust by then, but no read is
   *     scheduled until the turn's falling edge, so without it the card wears a
   *     bell through the whole turn that disproves it.
   *  3. **`dismissSession`** — the same optimistic withdrawal when a Session's
   *     Worker goes away, so a dismissed Session's bell does not survive until
   *     that Space's next board read, which can be minutes.
   *
   * Three writers of one map is accepted, not accidental: ONE writes what is TRUE
   * and the other two write what is TRUE A MOMENT EARLIER. Nothing between them
   * derives anything.
   */
  applyReadyMarks: (
    spacePath: string,
    entries: readonly ReadyCardEntry[],
  ) => void;
  /**
   * Withdraw every **ready** mark held by a card that links this Session. Called
   * by `sessions.ts`'s `beginTurn` — the owner's rule is "the next turn on that
   * Session clears it" — and a no-op (identical state object) when no such mark
   * exists.
   *
   * It takes a SESSION id while the slot is keyed by CARD, and that is the whole
   * reason a slot entry carries the card's Session ids: `beginTurn` knows which
   * Session started, and the card the bell is on is one hop away.
   *
   * Lives HERE rather than being spelled as a `useInteractive.setState` from
   * `sessions.ts` so the mark has one owner, and so the cross-store edge is an
   * ACTION like the `applyTodoUpdate` / `applyTodoClear` calls `sessions.ts`
   * already makes rather than a foreign write into someone else's map.
   */
  clearReady: (sessionId: string) => void;
  /** A `state` push (`{ state }`) — store, don't render in v1. */
  applyState: (sessionId: string, payload: unknown) => void;
  /**
   * A `cost_update` push: this frame's figure becomes this session's figure
   * (issue #87; the VALUE is the session's RUNNING TOTAL since Fulcrum T2 — see
   * `combineSessionCost`). Frames only: a stored total belongs to
   * `seedCostFromRow`, because `applyCost` also writes the token fields a frame
   * carries and a DB row carries none.
   */
  applyCost: (sessionId: string, payload: unknown) => void;
  /**
   * Seed a resumed session's figure from its stored row (issue #105).
   *
   * Writes the key DIRECTLY and never routes through `applyCost`: since Fulcrum
   * T2 the money field is last-frame-wins so `applyCost` no longer adds a total
   * to itself, but it still normalises the payload AND writes the four token
   * fields, and a stored row has no tokens — so the direct write stays, and the
   * "no token keys on the seeded entry" pin is what catches a mis-routed seed.
   * Seeds only when no entry exists, so live frames already in the map are
   * never clobbered. Writes BOTH `costUsd` and `cost` (rule R1) so the card's
   * alias link sees the figure too, and leaves the token fields absent —
   * they are not persisted and the card's context-% chain must keep falling
   * through to its own sources (see the plan's fact 3).
   *
   * `costUsd == null` (a `NULL` column: no call ever reported a cost) seeds
   * NOTHING. An entry holding `costUsd: null` is a REPORT — "frames arrived,
   * none carried a figure" — which `lib/sessionCost.ts`'s `costUsdOf` reads as
   * "render nothing", so writing one for an unknown stored figure would suppress
   * the very row this seed reads.
   */
  seedCostFromRow: (
    sessionId: string,
    costUsd: number | null | undefined,
  ) => void;
  /** A `session` push — store, don't render in v1. */
  applySession: (sessionId: string, payload: unknown) => void;
  /** Clear everything for a session (called on `session-closed`). */
  dismissSession: (sessionId: string) => void;
}

/** Do two slot entries name the SAME set of linked Sessions, in the order the board
 *  published them? An entry's ids are what the two optimistic clears resolve
 *  through, so a card whose links CHANGED is a changed entry even when it is ready
 *  both times — a stale id list would leave a newly linked Session unable to clear
 *  the bell. Order-insensitive on purpose: the value is a set, and a board read that
 *  re-publishes the same links in another order is not a new fact. */
const sameLinks = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.length === b.length &&
  a.every((id) => b.includes(id));

/** Is this slot key a card in this Space? The prefix IS the Space half of
 *  [`readyCardKey`], which is why no auxiliary per-Space bookkeeping is needed to
 *  scope a replace. */
const keyIsInSpace = (key: string, spacePath: string): boolean =>
  key.startsWith(`${spacePath}\u0000`);

export const useInteractive = create<InteractiveState>((set) => ({
  requests: {},
  todos: {},
  ready: {},
  agentState: {},
  cost: {},
  session: {},

  addRequest: (sessionId, data) =>
    set((state) => {
      const existing = (state.requests[sessionId] ?? []).filter(
        (r) => r.requestId !== data.requestId,
      );
      return {
        requests: { ...state.requests, [sessionId]: [...existing, data] },
      };
    }),

  removeRequest: (sessionId, requestId) =>
    set((state) => {
      const list = (state.requests[sessionId] ?? []).filter(
        (r) => r.requestId !== requestId,
      );
      return { requests: { ...state.requests, [sessionId]: list } };
    }),

  applyTodoUpdate: (sessionId, payload) =>
    set((state) => {
      const p = payload as { todos?: ChecklistItem[] } | null;
      if (!p || !Array.isArray(p.todos)) return state;
      // Branch-free on purpose: the board is keyed by the SESSION id the frame
      // already carries, never by `payload.source` — every frame the desktop
      // emits says `"native"` for a Main session and a Subagent session alike,
      // so any branch on that label mis-files the board (ADR 0041). Do not
      // "restore" one.
      //
      // This used to also read the `ready` marker out of the snapshot — one pass
      // over `p.todos` looking for a `completed` item whose content was the word
      // `ready` — and to write the mark alongside the board. Both are gone:
      // readiness is `sessions.ready`, a column the `mark_done` verb sets, and the
      // board read is its only reader (`applyReadyMarks`). The snapshot write below
      // is the whole job now.
      return { todos: { ...state.todos, [sessionId]: p.todos } };
    }),

  applyReadyMarks: (spacePath, entries) =>
    set((state) => {
      // The claims this read carries, and the links each ready card has. A card the
      // read reports NOT ready contributes NOTHING — presence is the claim — and a
      // ready card that links NO Session contributes nothing either: there is no
      // Session to resolve an optimistic clear through, and `readyFor` could not
      // have read such a card anyway.
      const claims = new Map<string, readonly string[]>();
      for (const entry of entries) {
        if (!entry.ready || entry.sessionIds.length === 0) continue;
        claims.set(readyCardKey(spacePath, entry.taskId), entry.sessionIds);
      }
      // THE NEXT MAP, built before anything is decided: this Space's keys are
      // REPLACED wholesale (a claim the read withdrew goes, and a card that left the
      // board leaves the slot) and every OTHER Space's keys are carried over
      // untouched, because a board read describes one Space and a Space nobody is
      // looking at is never read.
      const next: Record<string, readonly string[]> = {};
      for (const [key, ids] of Object.entries(state.ready)) {
        if (!keyIsInSpace(key, spacePath)) next[key] = ids;
      }
      for (const [key, ids] of claims) next[key] = ids;
      // IDENTITY PRESERVED when the read agrees with the slot. `TasksBoard`
      // subscribes to this map and zustand compares a selector's result with
      // `Object.is`, so a fresh object on every read re-renders the whole board
      // every time the auto-refresh fires — and the auto-refresh fires on every
      // turn. Same SIZE and then a per-key compare: the sizes can only agree when
      // this Space's key set is unchanged, so the compare is over what a read
      // touches and nothing else.
      const keys = Object.keys(state.ready);
      if (keys.length === Object.keys(next).length) {
        const agreed = keys.every((key) =>
          keyIsInSpace(key, spacePath)
            ? sameLinks(next[key], state.ready[key])
            : next[key] === state.ready[key],
        );
        if (agreed) return state;
      }
      return { ready: next };
    }),

  clearReady: (sessionId) =>
    set((state) => {
      // The identical-object no-op, so a `beginTurn` on a Session that lights no
      // card does not re-render anything that reads the map.
      const keys = Object.keys(state.ready).filter((key) =>
        (state.ready[key] ?? []).includes(sessionId),
      );
      if (keys.length === 0) return state;
      const ready = { ...state.ready };
      for (const key of keys) delete ready[key];
      return { ready };
    }),

  applyTodoClear: (sessionId) =>
    set((state) => {
      // The BOARD only — the ready arm went with the word. A cleared checklist
      // says nothing about readiness once readiness is a column, so a clear is no
      // longer a reason to withdraw a bell: a Session that stops being ready has
      // `sessions.ready` cleared in Rust and the next board read says so, and a
      // DELETED Session goes through `dismissSession`, which is the close that
      // actually means the claim is over.
      if (!(sessionId in state.todos)) return state;
      // The key goes, leaving the session's board empty until the next
      // `todos_update`.
      const todos = { ...state.todos };
      delete todos[sessionId];
      return { todos };
    }),

  applyState: (sessionId, payload) =>
    set((state) => {
      const s = (payload as { state?: string } | null)?.state;
      if (s !== "working" && s !== "idle" && s !== "blocked") return state;
      return { agentState: { ...state.agentState, [sessionId]: s } };
    }),

  applyCost: (sessionId, payload) =>
    set((state) => {
      const p = payload as CostUpdatePayload | undefined;
      const prev = state.cost[sessionId] as CostUpdatePayload | undefined;
      // NO first-frame fast path (rule R3). This used to early-return
      // `{ ...state.cost, [sessionId]: payload }` — storing frame #1 RAW —
      // which left a one-frame session with a key set that depended on the
      // frame COUNT: a legacy first frame had no `costUsd` (so the renderer
      // printed nothing while money existed) and a D5 first frame had no
      // `cost` (so the card's alias link read `undefined`). Every frame now
      // takes the identical normalise → combine → write-both-keys path, with
      // `null` standing in for "no previous entry" — which is exactly the
      // identity `combineSessionCost` needs.
      // The `typeof` half is carried over from the branch this replaced: an
      // entry written outside `applyCost` (a hand-written `setState` in a test,
      // or a future hydrator) is not necessarily an object. It is belt-and-braces,
      // not arithmetic — `frameCost` on a non-object is `null` anyway, which is
      // the same answer the guard produces.
      const hadEntry = prev !== undefined && typeof prev === "object";
      const money = combineSessionCost(
        hadEntry ? frameCost(prev) : null,
        frameCost(p),
      );
      const next: CostUpdatePayload = {
        inputTokens: (prev?.inputTokens ?? 0) + (p?.inputTokens ?? 0),
        outputTokens: (prev?.outputTokens ?? 0) + (p?.outputTokens ?? 0),
        cacheReadTokens:
          (prev?.cacheReadTokens ?? 0) + (p?.cacheReadTokens ?? 0),
        cacheWriteTokens:
          (prev?.cacheWriteTokens ?? 0) + (p?.cacheWriteTokens ?? 0),
        // ONE total, written under BOTH names (rule R1). `null` — not `0`, and
        // not an absent key — is the honest spelling of "nothing reported yet";
        // the card's `row.cost > 0` gate treats `null` and `undefined` alike, so
        // the alias is safe in the unknown state.
        cost: money,
        costUsd: money,
        source: p?.source ?? prev?.source,
      };
      return { cost: { ...state.cost, [sessionId]: next } };
    }),

  applySession: (sessionId, payload) =>
    set((state) => ({ session: { ...state.session, [sessionId]: payload } })),

  seedCostFromRow: (sessionId, costUsd) =>
    set((state) => {
      // `null` / `undefined` is "the row never reported a figure" — NOT a zero.
      // No entry is created (see the action's doc: an entry holding `null` is a
      // report, and this is the absence case).
      if (costUsd === null || costUsd === undefined) return state;
      // A live entry wins: the map holds this run's frames, which are fresher
      // than the row this seed was read from. (The `in` test, not a truthiness
      // test — an entry that exists holding `null` is still an entry.)
      if (sessionId in state.cost) return state;
      // THE DIRECT WRITE. `applyCost` is the other door into this key and it is
      // the WRONG one for a stored total: `combineSessionCost` is pure addition,
      // so `applyCost(id, { costUsd: 0.5 })` on a seeded 0.5 yields 1.0 — the
      // stored figure added to itself. Pinned by the 0.6-not-1.1 case in
      // `interactive.test.ts`.
      //
      // MONEY ONLY, and that is a decision rather than an omission: the token
      // fields are not persisted, and `SubagentDelegatingCard`'s context-% chain
      // only consults this entry when one of them is `defined`. Leaving them
      // absent keeps that chain falling through to the card's own (correct)
      // sources — see the plan's fact 3 and ADR 0082's `$0.0000` lesson.
      const next: CostUpdatePayload = { cost: costUsd, costUsd };
      return { cost: { ...state.cost, [sessionId]: next } };
    }),

  dismissSession: (sessionId) =>
    set((state) => {
      const requests = { ...state.requests };
      delete requests[sessionId];
      const todos = { ...state.todos };
      delete todos[sessionId];
      // THE THIRD WRITER of the ready slot: a Session whose Worker goes away stops
      // lighting the cards that link it. This is OPTIMISTIC and it is not redundant
      // with the next board read — `useTaskBoardAutoRefresh` only schedules a read on
      // a turn's FALLING edge, so without this a dismissed Session's bell survived
      // until someone happened to re-read that Space, which can be minutes.
      //
      // It does NOT restore on a close any more, and that is a change with the word.
      // `sessionLifecycle`'s `onSessionClosed` used to re-apply the carried board
      // after this dismiss, and the marker read at that funnel put the mark back.
      // Readiness is `sessions.ready` now, and a todo snapshot cannot speak for it:
      // the claim survives in the COLUMN, and the bell comes back with the next
      // board read that reports the column still set.
      //
      // The identity no-op, for the same reason `clearReady` has one:
      // `onSessionClosed` dismisses EVERY closed Session, and a child close on a
      // board carrying marks must not hand `TasksBoard` a fresh map to re-render
      // for. `ready` therefore keeps its IDENTITY when no key named this Session —
      // the other five maps are always rebuilt, because a close really does drop
      // those keys and they are not what this board subscribes to.
      const readyKeys = Object.keys(state.ready).filter((key) =>
        (state.ready[key] ?? []).includes(sessionId),
      );
      let ready = state.ready;
      if (readyKeys.length > 0) {
        ready = { ...state.ready };
        for (const key of readyKeys) delete ready[key];
      }
      const agentState = { ...state.agentState };
      delete agentState[sessionId];
      const cost = { ...state.cost };
      delete cost[sessionId];
      const session = { ...state.session };
      delete session[sessionId];
      return { requests, todos, ready, agentState, cost, session };
    }),
}));
