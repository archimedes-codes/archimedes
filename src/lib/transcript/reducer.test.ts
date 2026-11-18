import { describe, expect, it } from "vitest";
import {
  applySessionUpdate,
  dispositionFromRows,
  extractDiffs,
  finalizeSessionMessages,
  mapPersistedStatus,
  mapStatus,
  rowToMessages,
} from "./reducer";
import { isStaleCompactionStart } from "./identity";
import type { AcpSessionUpdate, MessageRow } from "../tauri";
import type { Message } from "../sessionTypes";

/** A persisted `tool-call` row carrying `payload` as its `payload_json`. */
function toolRow(payload: Record<string, unknown>): MessageRow {
  return {
    id: 1,
    sessionId: "s1",
    kind: "tool-call",
    messageKey: null,
    payloadJson: JSON.stringify(payload),
    createdAt: 1000,
  };
}

/** A bare `MessageRow` fixture — every field overridable, no payload encoding. */
function msgRowBase(overrides: Partial<MessageRow> & { kind: MessageRow["kind"] }): MessageRow {
  return {
    id: 1,
    sessionId: "s1",
    messageKey: null,
    payloadJson: "{}",
    createdAt: 1000,
    ...overrides,
  };
}

describe("src/lib/transcript", () => {
  describe("mapStatus", () => {
    it("maps undefined, pending, and in_progress to pending", () => {
      expect(mapStatus(undefined)).toBe("pending");
      expect(mapStatus("pending" as any)).toBe("pending");
      expect(mapStatus("in_progress" as any)).toBe("pending");
    });

    it("maps completed and failed accurately", () => {
      expect(mapStatus("completed")).toBe("completed");
      expect(mapStatus("failed")).toBe("failed");
    });
  });

  describe("extractDiffs", () => {
    it("extracts diff entries and computes unified patch", () => {
      const diffs = extractDiffs([
        {
          type: "diff",
          path: "file.txt",
          oldText: "old content",
          newText: "new content",
        },
      ]);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].path).toBe("file.txt");
      expect(diffs[0].patch).toContain("old content");
      expect(diffs[0].patch).toContain("new content");
    });

    it("returns empty array for undefined or non-diff content", () => {
      expect(extractDiffs(undefined)).toEqual([]);
      expect(extractDiffs([{ type: "text", text: "hello" } as any])).toEqual([]);
    });
  });

  describe("applySessionUpdate — text delta appending", () => {
    it("appends consecutive chunks with the same messageId", () => {
      let messages: Message[] = [];
      const chunk1: AcpSessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg1",
        content: { type: "text", text: "Hello " },
      };
      const chunk2: AcpSessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg1",
        content: { type: "text", text: "world!" },
      };

      messages = applySessionUpdate(messages, chunk1, 100);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        kind: "agent-text",
        messageId: "msg1",
        text: "Hello ",
        at: 100,
      });

      messages = applySessionUpdate(messages, chunk2, 200);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        kind: "agent-text",
        messageId: "msg1",
        text: "Hello world!",
        at: 100,
      });
    });

    // THE FLUSH RACE (the bug the prompt queue exposed). A **Flush** inserts its
    // `user` row through `addUserMessage` — a SEPARATE action, not a harness
    // frame, and it fires from an effect on the settle edge, a microtask on a
    // DIFFERENT channel from the streamed updates. So the last chunk of the
    // answer that just settled can land AFTER that row. A `messageId` identifies
    // ONE agent message: letting the intervening client-authored row split it
    // rendered the tail as a second band, and `MessageBubble` gives an agent band
    // the composer's own token — so a truncated answer read as a prompt the user
    // never sent. The rows below are built as the STORE leaves them, because
    // `applySessionUpdate` has no `user` arm to inject them through.
    it("appends to the message with the same messageId across an intervening user row", () => {
      const messages: Message[] = [
        { kind: "agent-text", messageId: "m3", text: "Point me at the real thing — ", at: 100 },
        { kind: "user", text: "dogs!!!!", at: 150 },
      ];

      const next = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "m3",
          content: { type: "text", text: "a file or the ADR for the empty state)?" },
        } as AcpSessionUpdate,
        200,
      );

      // ONE band, back in its ORIGINAL slot, with the user row still after it —
      // the message is whole and the queue's row keeps its place in the transcript.
      expect(next.map((m) => m.kind)).toEqual(["agent-text", "user"]);
      expect(next[0]).toMatchObject({ kind: "agent-text", messageId: "m3", at: 100 });
      expect((next[0] as { text: string }).text).toBe(
        "Point me at the real thing — a file or the ADR for the empty state)?",
      );
    });

    // The widening is scoped to `user` rows ONLY. A tool-call / thought / diff is
    // part of the AGENT's own stream and remains a segmentation signal, and the
    // synthesized `"default"` id must keep the trailing-only rule — un-ided
    // chunks would otherwise merge across a whole session into one message.
    it("still starts a new message across an intervening tool-call", () => {
      let messages: Message[] = [];
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "before" },
        } as AcpSessionUpdate,
        100,
      );
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          title: "Reading",
          status: "in_progress",
          rawInput: {},
        } as AcpSessionUpdate,
        150,
      );
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "after" },
        } as AcpSessionUpdate,
        200,
      );

      expect(messages.map((m) => m.kind)).toEqual(["agent-text", "tool-call", "agent-text"]);
    });

    it("keeps the trailing-only rule for the synthesized `default` messageId", () => {
      const messages: Message[] = [
        { kind: "agent-text", messageId: "default", text: "first", at: 100 },
        { kind: "user", text: "a prompt", at: 150 },
      ];

      const next = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "second" },
        } as AcpSessionUpdate,
        200,
      );

      // Un-ided chunks carry no identity to merge on — widening them across a
      // `user` row would fuse a whole session into one message. Two stay two.
      expect(next.map((m) => m.kind)).toEqual(["agent-text", "user", "agent-text"]);
    });

    it("creates a new message when messageId changes", () => {
      let messages: Message[] = [];
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg1",
          content: { type: "text", text: "First" },
        },
        100,
      );
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg2",
          content: { type: "text", text: "Second" },
        },
        200,
      );

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ text: "First" });
      expect(messages[1]).toMatchObject({ text: "Second" });
    });
  });

  describe("applySessionUpdate & finalizeSessionMessages — tool call accumulation and status updates", () => {
    it("accumulates tool call creation and updates, tracking status through to failed", () => {
      let messages: Message[] = [];

      // Create tool call (in_progress -> pending)
      const callUpdate: AcpSessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Reading file",
        status: "in_progress",
        rawInput: { path: "test.ts" },
      };
      messages = applySessionUpdate(messages, callUpdate, 100);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: "tool-call",
        id: "call_1",
        title: "Reading file",
        status: "pending",
        rawInput: { path: "test.ts" },
      });

      // Update tool call to completed
      const completionUpdate: AcpSessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: "file content",
      };
      messages = applySessionUpdate(messages, completionUpdate, 150);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: "tool-call",
        id: "call_1",
        status: "completed",
        rawOutput: "file content",
      });

      // Another tool call that stays pending
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          title: "Writing file",
          status: "in_progress",
        },
        200,
      );

      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({ status: "pending" });

      // Finalize session messages: pending flips to failed, completed stays completed
      const finalized = finalizeSessionMessages(messages);
      expect(finalized[0]).toMatchObject({ status: "completed" });
      expect(finalized[1]).toMatchObject({ status: "failed" });
    });
  });

  describe("isStaleCompactionStart", () => {
    it("filters active compaction event when session is stalled", () => {
      const activeCompaction: AcpSessionUpdate = {
        sessionUpdate: "compaction_update",
        active: true,
        reason: "manual",
      };

      expect(isStaleCompactionStart(activeCompaction, true)).toBe(true);
      expect(isStaleCompactionStart(activeCompaction, false)).toBe(false);

      const inactiveCompaction: AcpSessionUpdate = {
        sessionUpdate: "compaction_update",
        active: false,
        reason: "manual",
      };
      expect(isStaleCompactionStart(inactiveCompaction, true)).toBe(false);
      expect(isStaleCompactionStart(inactiveCompaction, false)).toBe(false);

      const otherUpdate: AcpSessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      };
      expect(isStaleCompactionStart(otherUpdate, true)).toBe(false);
    });
  });

  describe("rowToMessages", () => {
    it("hydrates user row with text", () => {
      const row: MessageRow = {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "Hello agent" }),
        createdAt: 1000,
      };
      const result = rowToMessages(row);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        kind: "user",
        text: "Hello agent",
        at: 1000,
      });
    });

    // THE HYDRATION TRAP (#155). A row that comes off disk with an UNRESOLVED
    // status is a call whose settle frame never arrived — the same case
    // `finalizeSessionMessages` already rules on by flipping a still-pending
    // call to `failed` "so the transcript doesn't show a spinner forever".
    // Sharing `mapStatus` made `in_progress` hydrate as `pending`, so every
    // orphan row re-opened on load: the shimmer class, the present-tense verb,
    // and — in `SubagentDelegatingCard` — a 1 s `setInterval` armed per visible
    // card, all for a call that died before this process started.
    it("hydrates an in_progress tool-call row as failed, not pending", () => {
      const [msg] = rowToMessages(
        toolRow({ toolCallId: "tc1", title: "bash", status: "in_progress" }),
      );
      if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
      expect(msg.status).toBe("failed");
    });

    it("hydrates a tool-call row with NO status as failed, not pending", () => {
      const [msg] = rowToMessages(
        toolRow({ toolCallId: "tc1", title: "bash" }),
      );
      if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
      expect(msg.status).toBe("failed");
    });

    it("hydrates a pending tool-call row as failed, not pending", () => {
      const [msg] = rowToMessages(
        toolRow({ toolCallId: "tc1", title: "bash", status: "pending" }),
      );
      if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
      expect(msg.status).toBe("failed");
    });

    // The two settled statuses are the whole truth on disk and must survive
    // untouched — an unresolved row renders as `failed`, NOT as a success card
    // whose body is the `(no output)` placeholder `ToolCallCard` shows when
    // `status !== "failed"` and there is no output.
    it("hydrates completed and failed tool-call rows verbatim", () => {
      const done = rowToMessages(
        toolRow({ toolCallId: "tc1", title: "bash", status: "completed" }),
      )[0];
      const boom = rowToMessages(
        toolRow({ toolCallId: "tc2", title: "bash", status: "failed" }),
      )[0];
      if (done?.kind !== "tool-call" || boom?.kind !== "tool-call") {
        throw new Error("no tool-call message");
      }
      expect(done.status).toBe("completed");
      expect(boom.status).toBe("failed");
    });
  });

  describe("mapPersistedStatus (hydrate-only)", () => {
    it("can never return pending", () => {
      const cases: unknown[] = [
        undefined,
        null,
        "pending",
        "in_progress",
        "running",
        "queued",
        "",
        "gibberish",
      ];
      for (const status of cases) {
        expect(mapPersistedStatus(status as never)).toBe("failed");
      }
    });

    it("maps the two settled statuses accurately", () => {
      expect(mapPersistedStatus("completed")).toBe("completed");
      expect(mapPersistedStatus("failed")).toBe("failed");
    });
  });

  describe("live path is NOT the hydrate path (#155)", () => {
    // THE GUARD. The live wire announces EVERY call at `in_progress`
    // (`normalize.rs`: `toolcall_start` / `tool_execution_start`), so routing
    // the live arms through the hydrate mapper would render every freshly-
    // announced, genuinely-running tool call as FINISHED until its settle frame
    // lands seconds later — deleting the live progress cue to fix a disk bug.
    // If someone "simplifies" the two mappers back into one, this fails.
    it("still yields pending for a live tool_call announced as in_progress", () => {
      const messages = applySessionUpdate(
        [],
        {
          sessionUpdate: "tool_call",
          toolCallId: "live1",
          title: "bash",
          status: "in_progress",
        } as AcpSessionUpdate,
        100,
      );
      const [msg] = messages;
      if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
      expect(msg.status).toBe("pending");
    });

    it("still yields pending for a live tool_call_update whose id is unknown", () => {
      const messages = applySessionUpdate(
        [],
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "live2",
          title: "bash",
          status: "in_progress",
        } as AcpSessionUpdate,
        100,
      );
      const [msg] = messages;
      if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
      expect(msg.status).toBe("pending");
    });

    it("still yields pending for a live in_progress update on an existing call", () => {
      let messages = applySessionUpdate(
        [],
        {
          sessionUpdate: "tool_call",
          toolCallId: "live3",
          title: "bash",
          status: "in_progress",
        } as AcpSessionUpdate,
        100,
      );
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "live3",
          status: "in_progress",
        } as AcpSessionUpdate,
        150,
      );
      const [msg] = messages;
      if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
      expect(msg.status).toBe("pending");
    });
  });

  describe("dispositionFromRows", () => {
    // ADR 0108: a Truncated turn is TERMINAL and VISIBLE. The engine persists
    // the notice as an ordinary `agent-text` row on its own fresh key
    // (`{stamp}:truncate:N`) whose `payload_json` carries the provider
    // disposition `"length"`; the footer needs the CLIENT vocabulary
    // (`"max_tokens"`) and needs it AFTER a restart, when the in-memory
    // `stopReasons` map is `{}`. This function is the whole read side.

    /** The persisted truncation notice, exactly as the display store writes it. */
    const truncateRow = (overrides: Partial<MessageRow> = {}): MessageRow => ({
      id: 9,
      sessionId: "s1",
      kind: "agent-text",
      messageKey: "a3f9c1:truncate:0",
      payloadJson:
        '{"text":"Response was truncated before completion","disposition":"length"}',
      createdAt: 2000,
      ...overrides,
    });

    it("reads the last row's disposition and maps the provider spelling to max_tokens", () => {
      expect(dispositionFromRows([truncateRow()])).toBe("max_tokens");
    });

    // (issue #193) The engine's OWN turn bound persists its notice the same WAY
    // #190's does — an `agent-text` row whose payload carries `disposition`, and
    // the footer needs it back after a restart — but on its OWN key: the cap
    // notice rides `{stamp}:cap:N` (engine `normalize.rs`'s `cap_id()`), not
    // `{stamp}:truncate:N`. The key differs because the shared `{stamp}:system`
    // key APPENDS, so each notice mints a unique id; `dispositionFromRows` reads
    // neither key (it reads `kind` + `payloadJson` only), so the fixture passes
    // either way — which is exactly why the key is spelled correctly here rather
    // than copied from the truncation helper above. The value is an IDENTITY
    // mapping (the engine adopted the client's spelling because the client
    // invented the word), not the translation `"length"` gets; see
    // `dispositionFromRows`'s docblock for why the two lines differ.
    it("reads a capped turn's disposition (identity mapping, no translation)", () => {
      expect(
        dispositionFromRows([
          truncateRow({
            messageKey: "a3f9c1:cap:0",
            payloadJson: JSON.stringify({
              text: "Turn stopped by the agent's own turn limit",
              disposition: "max_turn_requests",
            }),
          }),
        ]),
      ).toBe("max_turn_requests");
    });

    it("ignores an agent-text row that carries no disposition key", () => {
      const plain = msgRowBase({
        kind: "agent-text",
        messageKey: "a3f9c1:m1",
        payloadJson: JSON.stringify({ text: "A normal, complete reply." }),
      });
      expect(dispositionFromRows([plain])).toBeUndefined();
    });

    it("ignores a tool-call row even when its payload carries a disposition", () => {
      expect(
        dispositionFromRows([
          toolRow({ toolCallId: "t1", title: "bash", disposition: "length" }),
        ]),
      ).toBeUndefined();
    });

    it("refuses \"cancelled\" — the engine never mints it, and the row carries provider spellings only", () => {
      // NOT the OS-alert suppressor this used to be called. `attention.ts` now
      // gates on `stopReasons[id] === "end_turn"`, so a hydrated `"cancelled"`
      // would stay silent either way; what this pins is that the reducer never
      // mints a client vocabulary entry the engine did not promise. See the
      // docblock on `dispositionFromRows` for the measurement.
      expect(
        dispositionFromRows([
          truncateRow({
            payloadJson: JSON.stringify({
              text: "Response was truncated before completion",
              disposition: "cancelled",
            }),
          }),
        ]),
      ).toBeUndefined();
    });

    it("refuses the client spelling — the row carries the PROVIDER spelling only", () => {
      expect(
        dispositionFromRows([
          truncateRow({
            payloadJson: JSON.stringify({
              text: "Response was truncated before completion",
              disposition: "max_tokens",
            }),
          }),
        ]),
      ).toBeUndefined();
    });

    it("refuses a disposition the mapping does not know", () => {
      expect(
        dispositionFromRows([
          truncateRow({
            payloadJson: JSON.stringify({
              text: "Response was truncated before completion",
              disposition: "refusal",
            }),
          }),
        ]),
      ).toBeUndefined();
    });

    it("refuses a non-string disposition", () => {
      expect(
        dispositionFromRows([
          truncateRow({
            payloadJson: JSON.stringify({
              text: "Response was truncated before completion",
              disposition: 7,
            }),
          }),
        ]),
      ).toBeUndefined();
    });

    it("never throws on an unparseable payload", () => {
      expect(
        dispositionFromRows([truncateRow({ payloadJson: "{not json" })]),
      ).toBeUndefined();
    });

    it("never throws when the payload parses to a non-object", () => {
      // `JSON.parse("null")` SUCCEEDS and hands back `null`, so a bare property
      // read on the parsed value would throw right here — and this runs on the
      // `openSession` / `resumeSession` path, where a throw would take the
      // transcript load with it. Disk bytes, so every parse outcome is reachable.
      for (const payloadJson of ["null", "7", '"a string"', "true", "[]"]) {
        expect(
          dispositionFromRows([truncateRow({ payloadJson })]),
          `payloadJson ${payloadJson} must read as no disposition, not throw`,
        ).toBeUndefined();
      }
    });

    it("returns undefined for an empty page", () => {
      expect(dispositionFromRows([])).toBeUndefined();
    });

    it("looks ONLY at the last row — a newer row after the notice suppresses it", () => {
      const newer = msgRowBase({
        id: 10,
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "a newer prompt" }),
      });
      expect(dispositionFromRows([truncateRow(), newer])).toBeUndefined();
    });

    it("reads a re-written (upserted) older tool row as NO suppression — row identity, not row order", () => {
      // Decision 4. The notice is an INSERT on a fresh unique key; every row
      // its own turn can write AFTER it is an UPSERT onto a key that already
      // exists — a `tool_execution_end` close updates the pre-existing
      // `tool-call` row IN PLACE, gaining no newer `id` (the `ON CONFLICT …
      // DO UPDATE` sets `payload_json`/`created_at`, never `id`). So the page's
      // last element is still the notice and the line must render. Note what
      // this does NOT pin: a "find the newest truncate row and compare ids"
      // refactor also passes HERE, because the upserted row holds no newer id
      // either way — the positional contract is pinned by
      // `reads the LAST element by position, not the highest id`.
      const tool = toolRow({ toolCallId: "t1", title: "bash", status: "completed" });
      // Same `id`, same `messageKey` — the row was UPSERTED in place after the
      // notice landed, so it holds no newer identity.
      const reWrittenAfterTheNotice = { ...tool, id: 8 };
      expect(
        dispositionFromRows([reWrittenAfterTheNotice, truncateRow({ id: 9 })]),
      ).toBe("max_tokens");
    });

    it("suppresses when a NEW row is inserted after the notice", () => {
      // The inverse pin: a genuinely newer turn INSERTS at least one new row
      // (a newer `id`), and the footer belongs to the NEWEST turn.
      const inserted = {
        ...toolRow({ toolCallId: "t2", title: "bash" }),
        id: 10,
      };
      expect(dispositionFromRows([truncateRow({ id: 9 }), inserted])).toBeUndefined();
    });

    it("reads the LAST element by position, not the highest id", () => {
      // This page CANNOT arise from `messages_page` today — both arms return
      // ascending ids, so the last element is always the id-max element and this
      // input is unreachable. It exists to pin the CONTRACT itself: the rule is
      // "the last row of the page", read positionally. If the SQL ordering ever
      // changes (or a caller feeds a differently-sorted page), this is the test
      // that says the function still reads the tail and not `max(id)` — i.e. a
      // "pick the row with the newest id" rewrite is a behaviour change, not a
      // no-op, and would have to be decided deliberately.
      const olderThanTheNoticeButLast = msgRowBase({
        id: 8,
        kind: "agent-text",
        messageKey: "a3f9c1:m1",
        payloadJson: JSON.stringify({ text: "A normal, complete reply." }),
      });
      expect(
        dispositionFromRows([truncateRow({ id: 9 }), olderThanTheNoticeButLast]),
      ).toBeUndefined();
    });
  });
});
