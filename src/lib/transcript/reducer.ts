import { unifiedPatch } from "../diff";
import type {
  AcpSessionUpdate,
  AcpToolCallStatus,
  MessageRow,
  StopReason,
  ToolCallContent,
} from "../tauri";
import type { DiffRef, Message, ToolCallUiStatus } from "../sessionTypes";
import { diffMessages } from "./identity";

export function mapStatus(status: AcpToolCallStatus | undefined): ToolCallUiStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      // pending | in_progress | unknown → still open
      return "pending";
  }
}

/**
 * The HYDRATE-path status mapper — a row read back off disk, not a live frame.
 *
 * Deliberately NOT `mapStatus`, and the two must not be collapsed back into
 * one. `mapStatus` answers "is this call still open?" for the LIVE stream,
 * where `in_progress` is the honest answer: the wire announces every call at
 * `in_progress` (`normalize.rs` — `toolcall_start`, `tool_execution_start`), so
 * treating it as settled would render every freshly-announced, genuinely-
 * running call as FINISHED until its settle frame lands seconds later, deleting
 * the live progress cue.
 *
 * A persisted row asks a different question. Disk only ever holds a status the
 * worker wrote, and a row that still reads unresolved is a call whose settle
 * frame NEVER arrived — the process died, the attempt was abandoned, the row was
 * written and never updated. `finalizeSessionMessages` already rules on exactly
 * this case for the in-memory transcript: a still-pending call becomes `failed`
 * "so the transcript doesn't show a spinner forever". Hydration must agree, or
 * every orphan re-opens on load and the transcript claims work is happening
 * that stopped before this process started.
 *
 * So: the two settled statuses pass through, EVERYTHING ELSE (including
 * `in_progress`, `pending` and `undefined`) is `failed`. This function can
 * never return `"pending"`.
 *
 * `failed` and not `completed`, for two reasons. It matches the ruling above,
 * and a `completed` card with no output renders the `(no output)` placeholder
 * that `normalizeToolOutput` shows for a non-failed call — a success-looking
 * card standing in for a call that never reported failure or success.
 */
export function mapPersistedStatus(
  status: AcpToolCallStatus | undefined,
): ToolCallUiStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      // An unresolved status ON DISK is not "still open" — it is a call whose
      // settle frame never arrived. See the doc comment above; do not widen
      // this to share `mapStatus`'s default.
      return "failed";
  }
}

/** Pull every `ToolCallContent::Diff` out of a tool call's content list. */
export function extractDiffs(content: ToolCallContent[] | undefined): DiffRef[] {
  if (!content) return [];
  const diffs: DiffRef[] = [];
  for (const item of content) {
    if (
      item.type === "diff" &&
      typeof item.path === "string" &&
      typeof item.newText === "string"
    ) {
      diffs.push({
        path: item.path,
        patch: unifiedPatch(item.path, item.oldText ?? null, item.newText),
      });
    }
  }
  return diffs;
}

/**
 * The provider disposition persisted on the transcript's LAST row, mapped to the
 * client `StopReason` — or undefined when the last row carries none.
 *
 * WHY THIS EXISTS. `useSessions.stopReasons` is an in-memory map with no
 * `persist` middleware and it is a member of `SESSION_KEYED_FIELDS`, so it is
 * CLEARED on restart and never restored. `TranscriptFooter`'s predicate
 * short-circuits on `!stopReason`, so after a restart the truncated-turn line
 * vanishes for every session. The disposition is ALREADY durable — ADR 0108 made
 * the engine persist the notice as a `kind='agent-text'` row on the fresh unique
 * key `{stamp}:truncate:N` whose `payload_json` carries `disposition` — so this
 * is a pure READ of a row that exists, not new persistence.
 *
 * ONLY the last row of the page, and the rule is load-bearing (Decision 4). What
 * it exists to prevent is DROPPING THE SUPPRESSION GUARD: a page that carries a
 * disposition row anywhere OTHER than its tail belongs to a turn that a NEWER
 * turn has already superseded, so scanning the page for "any row with a
 * disposition" would render the truncated-turn line for a turn the footer no
 * longer describes. That is the refactor this rule forbids, and it is pinned by
 * `looks ONLY at the last row — a newer row after the notice suppresses it` and
 * `suppresses when a NEW row is inserted after the notice`.
 *
 * The read itself is POSITIONAL — index `length - 1` — and that is correct
 * because both arms of `messages_page` return ascending ids (the limited arm does
 * `ORDER BY id DESC LIMIT n+1` → truncate → `rows.reverse()`; the unlimited arm
 * is plain `ORDER BY id`), so the last element IS the id-max element. Position
 * and id keep agreeing when a frame re-writes an older row: the notice is an
 * INSERT on a key that never existed before, while the only frame its own turn
 * can still deliver AFTER it is an UPSERT onto a key that already exists — a
 * `tool_execution_end` close updates the pre-existing `tool-call` row in place,
 * and that `ON CONFLICT … DO UPDATE` sets `payload_json`/`created_at`, never
 * `id`, so it gains no newer `id`. Hence when the NEWEST turn was truncated, the
 * notice is still the page's last element even though a later frame re-wrote an
 * older row.
 *
 * THE RETRY ONE-LINER IS NO LONGER PART OF THAT ARGUMENT, and the reason the
 * positional read survives is different now. Until fulcrum PR #33 an
 * `auto_retry_end` one-liner UPSERTed onto the shared `{stamp}:system` key, and
 * that upsert — no new `id`, ever — was what kept it from outranking the notice.
 * All four harness one-liners now mint a fresh `{stamp}:notice:N` key off one
 * shared counter (engine `TurnState::notice_id`; ADR 0108's amendment), because a
 * same-`messageId` `agent_message_chunk` APPENDS with no separator and had welded
 * 103 of 104 real `:system` rows into one sentence — so a retry line is an INSERT
 * on a newer `id` and the upsert argument no longer covers it. What covers it is
 * the engine's EMISSION ORDER instead: a truncated turn emits the retired-report
 * `auto_retry_end` FIRST and `turn_truncated` after it, immediately before the
 * settle, precisely so the notice is the NEWEST display row of its own turn. So
 * the invariant moved from a persistence accident in this repo's store to a
 * guarantee the engine makes, and it is pinned from this side by
 * `pins the new emission order — a retry one-liner INSERTed before the notice
 * does not suppress it`, which feeds the rows in that order and reddens if they
 * are ever swapped there.
 *
 * So "find the newest truncate row and compare ids" is NOT the hazard, and it is
 * NOT dead on arrival: under the ascending-id invariant above it agrees with
 * reading the tail on every page `messages_page` can return, and is simply more
 * verbose and less direct. The positional contract is nonetheless a contract, so
 * it is pinned by name in `reads the LAST element by position, not the highest
 * id`, which feeds a tail `messages_page` cannot produce today — making a switch
 * to id-max a deliberate decision rather than a silent one.
 *
 * The vocabulary mapping is deliberate, and the two entries in it are NOT the
 * same kind of mapping. `"length"` is a TRANSLATION: the row carries the
 * PROVIDER spelling and the client vocabulary is `StopReason`, so the engine's
 * `"length"` becomes the client's `"max_tokens"` — two different words for one
 * fact, coined by two different layers. `"max_turn_requests"` (issue #193) is an
 * IDENTITY mapping: the client already had that word in its union (it names a
 * limit the client invented, not a provider finish reason), so the engine
 * adopted the client's spelling and there is nothing to translate. That
 * asymmetry is why the two lines read differently and why a future reader should
 * not "harmonise" them into one table.
 *
 * Neither value is ever produced by serializing an enum. The engine mints each
 * from a named constant — `TRUNCATION_DISPOSITION` (`"length"`) and
 * `TURN_CAPPED_DISPOSITION` (`"max_turn_requests"`) in its `normalize.rs` — so a
 * rename in the engine's Rust cannot silently change the bytes on disk, and the
 * constants' own docblocks carry the vocabulary contract in both directions.
 *
 * Anything else is `undefined`, INCLUDING `"cancelled"` and INCLUDING the client
 * spelling `"max_tokens"` — neither ever appears in a row, so accepting either
 * would mean the reducer minting a client value the engine never promised.
 *
 * ⚠ WHY THIS REFUSAL IS NOT THE ALERT SUPPRESSOR IT USED TO BE. Until issue #193
 * `attention.ts` gated on `stopReasons[id] !== "cancelled"`, so a `"cancelled"`
 * that survived this function really did silence a settled OS alert, and that was
 * the reason on record for refusing it. The gate is now the whitelist
 * `=== "end_turn"`, under which BOTH paths stay silent — refuse (the slot is
 * never written) or accept (the slot reads `"cancelled"`, still not `"end_turn"`).
 * Measured: widening this function to accept `"cancelled"` reddens exactly the one
 * refusal pin below and leaves `attention.test.ts` and `sessions.test.ts` green,
 * so the alert behaviour is no longer what the refusal buys. What it buys is the
 * narrower, still-real thing: an unrecognized payload value leaves the slot
 * untouched rather than writing a vocabulary entry nothing emitted, which is the
 * same discipline `sessions.ts` applies when it declines to write `undefined` for
 * "no row found".
 *
 * Never throws: `payloadJson` is disk bytes, parsed defensively exactly as
 * `rowToMessages` parses it.
 */
export function dispositionFromRows(
  rows: MessageRow[],
): StopReason | undefined {
  // The LAST row of the page is the newest (both arms of `messages_page` return
  // ascending ids — see the doc comment). Spelled as an index, not `rows.at(-1)`:
  // `tsconfig.json` compiles against `lib: ["ES2020", …]` and `Array.prototype.at`
  // is ES2022, so `.at` is a type error here (`TS2550`) even though it exists at
  // runtime. Same value, and `undefined` for an empty page just as `.at(-1)` is.
  const last = rows[rows.length - 1];
  if (!last || last.kind !== "agent-text") return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(last.payloadJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof payload?.disposition !== "string") return undefined;
  // The two known dispositions → client vocabulary. Every other value is
  // refused. The first line translates, the second is an identity (see the doc
  // comment); the refusal is deliberate, but since issue #193 it is NOT the OS
  // alert suppressor its own comment used to claim.
  if (payload.disposition === "length") return "max_tokens";
  if (payload.disposition === "max_turn_requests") return "max_turn_requests";
  return undefined;
}

/**
 * Fold a text chunk into the transcript: append it to the agent-text /
 * agent-thought row that carries `messageId`, or start a new row.
 *
 * THE FLUSH RACE this replaces (the defect the **Prompt queue** exposed): the
 * old rule appended ONLY when the LAST row was that same message. A **Flush**
 * inserts its `user` row through `addUserMessage` — a separate action, fired
 * from an effect on the settle edge, i.e. a microtask on a DIFFERENT channel
 * from the streamed updates — so the final chunk of the answer that just
 * settled can arrive after that row. The last row was then the `user` row, the
 * append failed, and the tail opened a SECOND row carrying the same `messageId`.
 * `MessageBubble` deliberately gives an agent band the composer's own token
 * (`bg-composer`, "the composer's text coming back"), so a truncated answer was
 * pixel-identical to a prompt the user never typed.
 *
 * A `messageId` names ONE agent message, so IDENTITY — not adjacency — decides
 * where a chunk belongs. The scan walks back over CLIENT-authored rows only
 * (`user`): a tool-call, diff or thought is part of the agent's own stream and
 * remains a segmentation boundary, exactly as `applySessionUpdate`'s contract
 * below has always said. The synthesized `"default"` id is excluded from the
 * widening — it is the ABSENCE of an identity, and merging it backwards would
 * fuse a whole session into one message, so un-ided chunks keep the trailing-only
 * rule.
 *
 * An append that lands anywhere other than the end RE-BACKS the message into its
 * original slot and leaves the `user` rows after it in the order the user sent
 * them; the transcript never reorders a prompt to suit a late chunk.
 */
function appendToMessage(
  messages: Message[],
  messageId: string,
  kind: "agent-text" | "agent-thought",
  text: string,
  at: number,
): Message[] {
  let idx = -1;
  let hit: Extract<Message, { kind: typeof kind }> | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row.kind === kind) {
      if (row.messageId === messageId) {
        idx = i;
        hit = row;
      }
      break;
    }
    if (messageId === "default" || row.kind !== "user") break;
  }

  if (idx === -1 || !hit) return [...messages, { kind, messageId, text, at }];

  const merged: Message = { ...hit, text: hit.text + text };
  if (idx === messages.length - 1) {
    // The ordinary streaming case: the row IS the tail, so this is byte-for-byte
    // the old `slice(0, -1)` spread — kept as its own branch because it is the
    // hot path and the shape every existing test pins.
    return [...messages.slice(0, -1), merged];
  }
  return [...messages.slice(0, idx), merged, ...messages.slice(idx + 1)];
}

/**
 * Pure reducer for `session-update` events: returns a NEW message array.
 *
 * - `agent_message_chunk`: appended to the agent-text message with the same
 *   `messageId`, scanning back over intervening `user` rows (a **Flush** can
 *   interleave one — see `appendToMessage`); a different `messageId`, or an
 *   intervening message from the AGENT's own stream, starts a new message —
 *   real agents emit several messages per turn, so we never just "append to the
 *   last agent-text". Identity picks the row, not adjacency.
 * - `agent_thought_chunk`: same rule over agent-thought messages.
 * - `tool_call` / `tool_call_update`: create/update the tool-call message;
 *   diffs inside the content are extracted into standalone diff messages
 *   (there is no dedicated file-edit update type).
 * - `message_retracted`: DROP every agent-text / agent-thought message that
 *   carries the retracted `messageId` (ADR 0048) — the only update that can
 *   SHRINK the array, and it returns the SAME reference when nothing matched.
 * - unknown update types: ignored (forward-compat).
 */
export function applySessionUpdate(
  messages: Message[],
  update: AcpSessionUpdate,
  at: number,
): Message[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content;
      if (!content || content.type !== "text" || typeof content.text !== "string") {
        return messages;
      }
      const text = content.text;
      if (text === "") return messages;
      const messageId = update.messageId ?? "default";
      return appendToMessage(messages, messageId, "agent-text", text, at);
    }

    case "agent_thought_chunk": {
      const content = update.content;
      if (!content || content.type !== "text" || typeof content.text !== "string") {
        return messages;
      }
      const text = content.text;
      if (text === "") return messages;
      const messageId = update.messageId ?? "default";
      return appendToMessage(messages, messageId, "agent-thought", text, at);
    }

    case "message_retracted": {
      // (ADR 0048) The attempt behind this messageId was abandoned and its
      // reply retried under the SAME id (one message_start per message), so the
      // partial text must not weld onto the retry. Live thought messages carry
      // this id WITHOUT its `#seg` suffix too (the `#seg` is a persistence
      // detail), so this clears thoughts with the text. Bookkeeping lines are
      // never the abandoned id, so they survive: since ADR 0049 they read
      // `{stamp}:system` / `{stamp}:retract:N`, and the bare `system` /
      // `retract:N` shape is what a transcript written BEFORE ADR 0049 still
      // carries — both shapes reach this filter, which compares ids verbatim
      // and normalises nothing (a stamped reply is a different row from a bare
      // one, and from another incarnation's same-counter reply).
      const kept = messages.filter(
        (m) =>
          (m.kind !== "agent-text" && m.kind !== "agent-thought") ||
          m.messageId !== update.messageId,
      );
      // Same reference when nothing matched: silence must not read as a change.
      return kept.length === messages.length ? messages : kept;
    }

    case "tool_call": {
      const diffs = extractDiffs(update.content);
      const msg: Message = {
        kind: "tool-call",
        id: update.toolCallId,
        title: update.title ?? update.toolCallId,
        status: mapStatus(update.status),
        diff: diffs[0],
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        at,
      };
      return [...messages, msg, ...diffMessages(diffs, at)];
    }

    case "tool_call_update": {
      const diffs = extractDiffs(update.content);
      const index = messages.findIndex(
        (m) => m.kind === "tool-call" && m.id === update.toolCallId,
      );
      if (index === -1) {
        // Update for a tool call we never saw: treat it as a new one.
        const msg: Message = {
          kind: "tool-call",
          id: update.toolCallId,
          title: update.title ?? update.toolCallId,
          status: mapStatus(update.status),
          diff: diffs[0],
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          at,
        };
        return [...messages, msg, ...diffMessages(diffs, at)];
      }
      const prev = messages[index];
      if (prev.kind !== "tool-call") return messages;
      const updated: Message = {
        ...prev,
        title: update.title ?? prev.title,
        status: update.status ? mapStatus(update.status) : prev.status,
        diff: diffs[0] ?? prev.diff,
        rawInput: update.rawInput ?? prev.rawInput,
        rawOutput: update.rawOutput ?? prev.rawOutput,
      };
      const next = [...messages];
      next[index] = updated;
      return [...next, ...diffMessages(diffs, at)];
    }

    default:
      return messages;
  }
}

/**
 * Session-closed cleanup: mark every still-pending tool call failed so the
 * transcript doesn't show a spinner forever.
 */
export function finalizeSessionMessages(messages: Message[]): Message[] {
  return messages.map((m) =>
    m.kind === "tool-call" && m.status === "pending"
      ? { ...m, status: "failed" as const }
      : m,
  );
}

/**
 * Map a persisted `MessageRow` back to transcript messages. A tool-call row
 * also re-derives its standalone diff messages (diffs are stored inside the
 * tool call's content, not as separate rows).
 */
export function rowToMessages(row: MessageRow): Message[] {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  switch (row.kind) {
    case "user": {
      if (typeof payload.text !== "string") return [];
      const rawImages = Array.isArray(payload.images) ? payload.images : [];
      const images = rawImages
        .filter(
          (img): img is Record<string, unknown> =>
            img !== null &&
            typeof img === "object" &&
            typeof (img as Record<string, unknown>).data === "string" &&
            typeof (img as Record<string, unknown>).mimeType === "string",
        )
        .map((img) => ({
          name: typeof img.name === "string" ? img.name : "",
          mimeType: img.mimeType as string,
          sizeBytes: typeof img.sizeBytes === "number" ? img.sizeBytes : 0,
          data: img.data as string,
        }));
      return [
        {
          kind: "user",
          text: payload.text,
          at: row.createdAt,
          ...(images.length > 0 ? { images } : {}),
        },
      ];
    }
    case "agent-text":
      // An empty text is a Retraction's overwrite (the display store has no
      // DELETE), never a real bubble — so an empty row hydrates as nothing.
      return typeof payload.text === "string" && payload.text !== ""
        ? [
            {
              kind: "agent-text",
              messageId: row.messageKey ?? "default",
              text: payload.text,
              at: row.createdAt,
            },
          ]
        : [];
    case "agent-thought":
      // Empty for the same reason as `agent-text` above (ADR 0048).
      return typeof payload.text === "string" && payload.text !== ""
        ? [
            {
              kind: "agent-thought",
              messageId: row.messageKey ?? "default",
              text: payload.text,
              at: row.createdAt,
            },
          ]
        : [];
    case "tool-call": {
      const id =
        typeof payload.toolCallId === "string"
          ? payload.toolCallId
          : (row.messageKey ?? "unknown");
      const title = typeof payload.title === "string" ? payload.title : id;
      const diffs = extractDiffs(
        payload.content as ToolCallContent[] | undefined,
      );
      const msg: Message = {
        kind: "tool-call",
        id,
        title,
        status: mapPersistedStatus(payload.status as AcpToolCallStatus | undefined),
        diff: diffs[0],
        rawInput: payload.rawInput,
        rawOutput: payload.rawOutput,
        at: row.createdAt,
      };
      return [
        msg,
        ...diffs.map((d) => ({
          kind: "diff" as const,
          path: d.path,
          patch: d.patch,
          at: row.createdAt,
        })),
      ];
    }
    default:
      return [];
  }
}
