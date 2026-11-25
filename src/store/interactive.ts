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
 * THE `ready` MARKER — the one todo item a model writes to say "the work on this
 * Session is done, come and look at it".
 *
 * ## The convention, verbatim
 *
 * A `ChecklistItem` whose `content`, trimmed and lowercased, equals `"ready"`
 * **AND** whose `status` is `"completed"`. Exact match on the normalised string —
 * never a substring — and `completed` is mandatory.
 *
 * ## Why a CONVENTION and not a tool verb (read before "fixing" this)
 *
 * A model-facing verb is engine-gated. `TaskCall` and `trait TaskStore` live in
 * `fulcrum-harness`, a crates.io-pinned dependency (`src-tauri/Cargo.toml`), and
 * `tool_specs()` is the crate's — the desktop contributes zero tool specs. ADR 0102
 * plus roadmap item #183 (`docs/roadmap/tool-separation.md`) is the approved,
 * unbuilt fix that would let the desktop ship a verb of its own; until that lands,
 * no `TaskCall` arm and no tool spec can be added from this repo.
 *
 * And the obvious workaround does not work: the engine CONSTRUCTS
 * `TodoItem { content, status, description }` and emits the vector it built, so an
 * extra key on an item (`"ready": true`) is dropped inside the crate, before any
 * frame exists. Only the model-authored STRING survives. That is the whole reason
 * the marker is a conventional item read by desktop code, and the reason this file
 * is where the rule lives.
 *
 * ## Why `completed` is required, and why the match is exact
 *
 * A PENDING `"ready"` in a plan means "still need to make it ready" — the opposite
 * of the fact the mark reports — so the status half is not a redundant guard. And
 * `"get the board ready"` is a plan item ABOUT readiness; a substring test would
 * mark a card ready for half the English language. Both halves are pinned in
 * `interactive.test.ts`.
 *
 * ## Where the model learns this
 *
 * Nothing in the app tells a model the convention exists. It has to be told — a
 * Stage's prompt prefix, or an on-enter Skill — and `docs/features/session-ready-marker.md`
 * records that plainly, because a convention nobody announces is a convention
 * nobody uses.
 */
export const READY_MARKER_TEXT = "ready";

/** Does this item carry the **ready** marker? See `READY_MARKER_TEXT` for the rule
 *  and for why the rule is a convention rather than a wire field.
 *
 *  The `typeof` guard is not paranoia: `useMainChecklistItems` documents that the
 *  board casts ANY model-authored value out of a persisted row, so a `content` that
 *  is a number or `null` is reachable, and `.trim()` on one would throw inside the
 *  `interactive-event` listener — turning today's dropped frame into a runtime
 *  exception in a listener `App.tsx` deliberately keeps throw-free. */
export function isReadyMarker(item: ChecklistItem): boolean {
  return (
    item.status === "completed" &&
    typeof item.content === "string" &&
    item.content.trim().toLowerCase() === READY_MARKER_TEXT
  );
}

/** Does this snapshot of a board assert readiness? ONE pass, ONE answer, and the
 *  answer is per-SNAPSHOT: `applyTodoUpdate` overwrites the board, so a snapshot
 *  without the marker withdraws the claim. That is what stops the mark going
 *  sticky-within-a-turn when the model rewrites its list and drops the item. */
export function boardAssertsReady(todos: readonly ChecklistItem[]): boolean {
  return todos.some(isReadyMarker);
}

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
   * Sessions whose CURRENT todo snapshot carries the **ready** marker, keyed by
   * session id. A PRESENCE map (`{ [sessionId]: true }`), so "no entry" and
   * "false" are the same answer and neither is a lie about a Session nobody has
   * heard of.
   *
   * ## Why this is an explicit slot and NOT a derivation (do not "simplify" it)
   *
   * The owner's rule is that the NEXT TURN on a Session clears the mark. That rule
   * cannot be derived from the todo list: a turn that never calls
   * `manage_todo_list` leaves the board untouched, so a derived mark would survive
   * it. And deriving `ready && !inTurn` is worse than wrong — it makes the mark
   * DISAPPEAR while a turn runs and REAPPEAR when the turn settles, which is the
   * opposite of "the next turn clears it". So the mark is written when the marker
   * arrives and cleared by the next `beginTurn`, in two places, and nothing in
   * between derives it.
   *
   * ## Why detecting it inside `applyTodoUpdate` makes this nearly free
   *
   * `applyTodoUpdate` is the ONE funnel for a session's todos — the live
   * `todos_update` listener (`App.tsx`), the reopen/resume seed
   * (`sessions.ts`, fed by `history_page`'s `todos`, which is `db.session_todos`
   * on the first page only), and `sessionLifecycle`'s carry-across-a-close all
   * route through it, and nothing else writes `todos[sessionId]`. Detecting the
   * marker THERE therefore yields live detection AND restart persistence from one
   * call, with no new column, no migration, no IPC command and no engine change.
   *
   * ## The honest boundary that falls out of it
   *
   * The mark rides the board, and a board only exists in this map once something
   * has read it. A Session whose history is opened after a restart gets its mark
   * back (the seed re-fires the detection); a Session that is never opened has no
   * `todos` and therefore no mark. That is the accepted cost of the
   * zero-migration design — the mark is live-plus-opened-history, not durable
   * board state. `docs/features/session-ready-marker.md` says so out loud.
   */
  ready: Record<string, true>;
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
   * ALSO the one place the **ready** marker is read — see `ready`'s field doc for
   * why this is the seam that makes live detection and restart persistence one and
   * the same mechanism.
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
   * The **ready** mark goes with it, on the reasoning recorded at the call below:
   * a cleared checklist no longer asserts readiness.
   */
  applyTodoClear: (sessionId: string) => void;
  /**
   * Withdraw this session's **ready** mark. Called by `sessions.ts`'s `beginTurn`
   * — the owner's rule is "the next turn on that Session clears it" — and is a
   * no-op (identical state object) when no mark is set.
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
      // THE `ready` MARK IS READ HERE, and this line is the whole reason the
      // feature costs what it costs. `applyTodoUpdate` is the ONE funnel for a
      // session's todos: the live `todos_update` listener (`App.tsx`), the
      // reopen/resume seed (`sessions.ts`, from `history_page`'s `todos`) and
      // `sessionLifecycle`'s carry-across-a-close all route through it, and
      // nothing else writes `todos[sessionId]` (verified — `grep -rn
      // "applyTodoUpdate" src` names those three and no fourth writer, and the
      // map has no other `set`). Reading the marker at the funnel therefore buys
      // live detection AND restart persistence for free, with no new column, no
      // migration, no IPC command and no engine change. Reading it in the
      // listener instead would need a second read site for the seed, and a second
      // site is where the two would drift.
      //
      // Per-SNAPSHOT, not sticky: `manage_todo_list` rewrites the whole list on
      // every call, so a snapshot WITHOUT the marker is the model withdrawing the
      // claim and the mark goes. Pinning that is what keeps the mark from
      // outliving the item that asserted it.
      const ready = boardAssertsReady(p.todos);
      if (ready === sessionId in state.ready) {
        // Nothing to change in the mark, so the map keeps its IDENTITY — a new
        // object here would re-render every reader of `ready` on every todo frame
        // (zustand compares a selector's result with `Object.is`).
        return { todos: { ...state.todos, [sessionId]: p.todos } };
      }
      const nextReady = { ...state.ready };
      if (ready) nextReady[sessionId] = true;
      else delete nextReady[sessionId];
      return {
        todos: { ...state.todos, [sessionId]: p.todos },
        ready: nextReady,
      };
    }),

  clearReady: (sessionId) =>
    set((state) => {
      // The identical-object no-op, so a `beginTurn` on a session that never
      // marked ready does not re-render anything that reads the map.
      if (!(sessionId in state.ready)) return state;
      const ready = { ...state.ready };
      delete ready[sessionId];
      return { ready };
    }),

  applyTodoClear: (sessionId) =>
    set((state) => {
      // A clear drops the mark TOO, and that is a decision rather than a
      // side effect: the board was the only thing asserting readiness, and both
      // emitters of a `todos_clear` name a Session whose claim is over — a child
      // session's teardown (`App.tsx`) and a deleted Session (`sessions.ts`'s
      // `deleteSession`). Leaving a card marked `ready` under a checklist that no
      // longer exists would be a mark asserting a fact nothing supports.
      if (!(sessionId in state.todos) && !(sessionId in state.ready))
        return state;
      // The key goes, leaving the session's board empty until the next
      // `todos_update`.
      const todos = { ...state.todos };
      delete todos[sessionId];
      const ready = { ...state.ready };
      delete ready[sessionId];
      return { todos, ready };
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
      // The mark goes with the board it was read off. `sessionLifecycle`'s
      // `onSessionClosed` re-applies the board AFTER this dismiss (it is the
      // carry that keeps a still-rendered Session's checklist on screen), and that
      // re-apply re-detects the marker — so a Session closed while still marked
      // ready gets its mark back through the very same funnel, which is the
      // correct answer: the board it is still showing still says `ready`.
      const ready = { ...state.ready };
      delete ready[sessionId];
      const agentState = { ...state.agentState };
      delete agentState[sessionId];
      const cost = { ...state.cost };
      delete cost[sessionId];
      const session = { ...state.session };
      delete session[sessionId];
      return { requests, todos, ready, agentState, cost, session };
    }),
}));
