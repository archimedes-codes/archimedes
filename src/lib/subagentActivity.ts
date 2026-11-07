import type { Message } from "./sessionTypes";
import type { SubagentFailureReason } from "./tauri";
import { formatDuration, summarizeToolCall } from "./toolOutput";

/**
 * The pure derivations behind the `subagent` tool's card (the "Delegating"
 * card), moved VERBATIM out of `SubagentDelegatingCard.tsx` so they can be
 * unit-tested without rendering it.
 *
 * Nothing here touches a store, a hook, or JSX: `extractTargetInfo` reads the
 * tool call's `rawInput` / `rawOutput` envelopes, `estimateTokensFromMessages`
 * measures a transcript, and `getActivityDisplay` turns one row into the card's
 * third line. The card keeps the row-derivation code that feeds them.
 */

export interface RawInputTaskItem {
  task?: string;
  agent?: string;
  model?: string;
  thinking?: string;
}

export interface RawProgressItem {
  agent?: string;
  task?: string;
  status?: "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  toolCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  error?: string;
  model?: string;
  output?: string;
  recentOutput?: string[];
  toolCalls?: Array<{ name?: string; argsPreview?: string; error?: boolean } | string>;
  percent?: number;
  contextPercent?: number;
}

export interface RawResultItem {
  agent?: string;
  task?: string;
  childSessionId?: string;
  exitCode?: number;
  // The cost shape the card reads (SubagentDelegatingCard.tsx:285–286,341 —
  // `input`/`output`/`cost` and nothing else). `cacheRead`, `cacheWrite` and
  // `turns` used to be declared here too: no reader named them anywhere in
  // `src/`, no test constructed them, and no Rust producer emits them (the
  // frozen 34-key `details` vocabulary in `toolDetailsRegistry.test.ts` carries
  // no such key), so they were deleted rather than kept as a guess at a shape
  // the wire never sent. The interactive store's `cacheReadTokens` /
  // `cacheWriteTokens` cost snapshot (`store/interactive.ts`) is a DIFFERENT,
  // live shape with its own tests — not these three.
  usage?: {
    input?: number;
    output?: number;
    cost?: number;
  };
  model?: string;
  finalOutput?: string;
  error?: string;
  progressSummary?: { toolCount?: number; tokens?: number; durationMs?: number };
}

export function extractTargetInfo(rawInput: unknown, rawOutput: unknown): {
  targetTasks: string[];
  targetSessionIds: string[];
  inputItems: RawInputTaskItem[];
  progressList: RawProgressItem[];
  resultsList: RawResultItem[];
  details: Record<string, unknown> | undefined;
} {
  const targetTasks: string[] = [];
  const targetSessionIds: string[] = [];
  const inputItems: RawInputTaskItem[] = [];

  if (typeof rawInput === "object" && rawInput !== null) {
    const input = rawInput as Record<string, unknown>;
    if (typeof input.task === "string" && input.task) {
      targetTasks.push(input.task);
      inputItems.push({
        task: input.task,
        agent: typeof input.agent === "string" ? input.agent : undefined,
        model: typeof input.model === "string" ? input.model : undefined,
        thinking: typeof input.thinking === "string" ? input.thinking : undefined,
      });
    }
    if (Array.isArray(input.tasks)) {
      for (const t of input.tasks) {
        if (typeof t === "string" && t) {
          targetTasks.push(t);
          inputItems.push({ task: t });
        } else if (typeof t === "object" && t !== null) {
          const obj = t as Record<string, unknown>;
          if (typeof obj.task === "string" && obj.task) {
            targetTasks.push(obj.task);
            inputItems.push({
              task: obj.task,
              agent: typeof obj.agent === "string" ? obj.agent : undefined,
              model: typeof obj.model === "string" ? obj.model : undefined,
              thinking: typeof obj.thinking === "string" ? obj.thinking : undefined,
            });
          }
        }
      }
    }
  }

  const output = rawOutput as Record<string, unknown> | undefined;
  const details = output?.details as Record<string, unknown> | undefined;
  const progressList: RawProgressItem[] = Array.isArray(details?.progress)
    ? (details!.progress as RawProgressItem[])
    : [];
  const resultsList: RawResultItem[] = Array.isArray(details?.results)
    ? (details!.results as RawResultItem[])
    : [];

  for (const p of progressList) {
    if (p && typeof p.task === "string" && p.task) {
      targetTasks.push(p.task);
    }
  }

  for (const r of resultsList) {
    if (r) {
      if (typeof r.task === "string" && r.task) targetTasks.push(r.task);
      if (typeof r.childSessionId === "string" && r.childSessionId) {
        targetSessionIds.push(r.childSessionId);
      }
    }
  }

  return {
    targetTasks: Array.from(new Set(targetTasks)),
    targetSessionIds: Array.from(new Set(targetSessionIds)),
    inputItems,
    progressList,
    resultsList,
    details,
  };
}

export function estimateTokensFromMessages(messages: Message[]): number {
  let totalChars = 0;
  for (const m of messages) {
    if (m.kind === "user" || m.kind === "agent-text" || m.kind === "agent-thought") {
      totalChars += m.text.length;
    } else if (m.kind === "tool-call") {
      if (typeof m.rawInput === "string") totalChars += m.rawInput.length;
      else if (typeof m.rawInput === "object" && m.rawInput !== null) {
        totalChars += JSON.stringify(m.rawInput).length;
      }
      if (typeof m.rawOutput === "string") totalChars += m.rawOutput.length;
      else if (typeof m.rawOutput === "object" && m.rawOutput !== null) {
        totalChars += JSON.stringify(m.rawOutput).length;
      }
    } else if (m.kind === "diff") {
      totalChars += m.patch.length;
    }
  }
  return Math.round(totalChars / 4);
}

export interface ActivityInfo {
  glyph?: string;
  text: string;
  duration?: string;
  colorClass: string;
}

/**
 * An **open** Tool Call row — announced, not yet settled.
 *
 * `running` is compared through `as string` on purpose: `ToolCallUiStatus`
 * spells "open" as `pending` (`mapStatus` collapses the wire's `pending` /
 * `in_progress` onto it, and the wire's `in_progress` is what a tool that is
 * genuinely executing carries), so the extra comparison is a guard for a
 * producer that starts naming the state the other way. It was inline in
 * `getActivityDisplay`; the supersede scan below needs the SAME predicate, and
 * two copies of an open/closed rule is where they start disagreeing about which
 * rows count.
 */
function isOpenToolCall(
  m: Message,
): m is Extract<Message, { kind: "tool-call" }> {
  return (
    m.kind === "tool-call" &&
    (m.status === "pending" || (m.status as string) === "running")
  );
}

/**
 * The row shape `getActivityDisplay` reads. 5 fields — the card builds one per
 * delegated Subagent and passes the whole row in (it carries more, but only
 * these five are read here). Exported so the card's two row derivations can type
 * against it instead of repeating the inline literal.
 */
export interface ActivityRow {
  status: "running" | "completed" | "failed";
  error?: string;
  reason?: SubagentFailureReason;
  progress?: RawProgressItem;
  result?: RawResultItem;
}

/**
 * The card's short line for a **Dead / crashed / cancelled Subagent session**
 * (ADR 0055): a label per `SubagentFailureReason`, keyed to the four values the
 * Rust enum serialises to.
 *
 * It exists because `error` is NOT a display string: every failure path carries
 * SALVAGE prose addressed to the PARENT model ("subagent worker exited
 * unexpectedly (code 137)", "unresponsive"), and this row is one truncated line in
 * a compact list — the prose is unreadable there and duplicates what the
 * parent's own tool result already says. The code is data, so nothing here
 * string-matches `error`.
 */
export const FAILURE_LABELS: Record<SubagentFailureReason, string> = {
  unresponsive: "Unresponsive — no output for a long period",
  crashed: "Crashed",
  cancelled: "Cancelled",
  other: "Failed",
};

export function getActivityDisplay(
  row: ActivityRow,
  sessionMessages: Message[] | undefined,
  now: number,
): ActivityInfo | undefined {
  // The short reason line (ADR 0055), and ONLY when there is something to say.
  // `error` is the FALLBACK, not the primary: a payload from a backend that
  // predates `reason` (or a `progress`/`result` row that never carried it) still
  // shows why. Note the order — `reason` first, so the code wins over prose
  // whenever both exist; `error` second, so a failed row with neither is not
  // silently swallowed and falls through to the `status === "failed"` arm.
  if (row.error || row.reason) {
    const text = (row.reason && FAILURE_LABELS[row.reason]) || row.error;
    if (text) {
      return { glyph: "✗", text, colorClass: "text-destructive" };
    }
  }
  if (row.status === "completed") {
    return { glyph: "✓", text: "Done", colorClass: "text-success" };
  }
  if (row.status === "failed") {
    return { glyph: "✗", text: "Failed", colorClass: "text-destructive" };
  }

  // 1. Check live subagent transcript messages if available
  if (sessionMessages && sessionMessages.length > 0) {
    // The in-flight Tool Call — and WHICH open row qualifies is the whole
    // problem. A row is announced the moment the model finishes NAMING the call
    // (`turn.rs` emits `toolcall_end` per `ProviderEvent::ToolCall`, and
    // `normalize.rs` turns it into a `tool_call` with `status: "in_progress"`),
    // and it leaves `pending` only when a `tool_call_update` settles it. So an
    // open row means one of TWO different things, and the transcript alone
    // cannot tell them apart:
    //
    //   - genuinely RUNNING — `run_tool_batch` executes a batch's calls ONE AT A
    //     TIME after the stream ends, so the batch's later calls are announced
    //     and waiting; the EARLIEST open row is the one executing; or
    //   - ORPHANED — the settle never arrived, and the row stays `pending` for
    //     the life of the child. Three producers, all reachable:
    //     `settle_error` / `settle_cancelled` emit only `turn_end` +
    //     `agent_settled` and no `tool_execution_end` (the retry and
    //     mid-stream-overflow paths DO run that close loop, these two do not),
    //     `message_retracted` drops agent text but never the tool row, and the
    //     pump's `Lagged` arm `continue`s — a dropped settle is the same orphan
    //     (#143 already treats this broadcast as droppable).
    //
    // A plain `find()` for the first open row reports the orphan on every render
    // and reports ITS age, which grows without bound; the card re-renders once a
    // second, so the line freezes on `bash: cargo test · 1m29s` while the tool
    // count and the cost — different sources, both still live — keep climbing.
    // That is the reported symptom, and it is a derivation bug, not a desync:
    // the child's frames are demonstrably arriving.
    //
    // THE DISCRIMINATOR IS POSITION, and the protocol makes it sound rather than
    // heuristic: nothing is produced WHILE a tool executes, so the rows after a
    // genuinely running call are only ever its own batch-mates — announced, and
    // open. A SETTLED row after an open one is therefore something the child did
    // AFTER that call was abandoned. So: look only at the rows following the
    // newest settled row, and among those the earliest open one is the executing
    // tool. An open row with a settled row after it is an orphan and stops
    // speaking for the child, which lets the arms below report the real latest
    // action.
    //
    // THE RESIDUAL, and it is not fixable here: an orphan followed ONLY by open
    // rows still wins, because that arrangement is byte-identical to a legitimate
    // mid-batch transcript, and `at` does not separate them either (a batch's
    // announces share a stamp, and the executing call is the earliest of them).
    // Position is the only signal the transcript carries, which is exactly why the
    // durable fix is Engine-side — settle the row when the attempt is abandoned
    // and the ambiguity never arises. Until then this is a strict improvement: it
    // fixes every orphan the child has produced work after, which is the case that
    // strands a line for minutes.
    let newestSettledIdx = -1;
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      const m = sessionMessages[i];
      if (!isOpenToolCall(m)) {
        newestSettledIdx = i;
        break;
      }
    }
    let inFlightTool: Extract<Message, { kind: "tool-call" }> | undefined;
    for (let i = newestSettledIdx + 1; i < sessionMessages.length; i++) {
      const m = sessionMessages[i];
      if (isOpenToolCall(m)) {
        inFlightTool = m;
        break;
      }
    }
    if (inFlightTool) {
      const summary = summarizeToolCall(inFlightTool.title, inFlightTool.rawInput);
      const dur = inFlightTool.at ? ` · ${formatDuration(now - inFlightTool.at)}` : "";
      return {
        glyph: "▸",
        text: `${inFlightTool.title}${summary ? `: ${summary}` : ""}`,
        duration: dur,
        colorClass: "text-foreground-subtle",
      };
    }

    // Most recent transcript action
    const lastMsg = sessionMessages[sessionMessages.length - 1];
    if (lastMsg) {
      if (lastMsg.kind === "tool-call") {
        const summary = summarizeToolCall(lastMsg.title, lastMsg.rawInput);
        const glyph = lastMsg.status === "failed" ? "✗" : "✓";
        return {
          glyph,
          text: `${lastMsg.title}${summary ? `: ${summary}` : ""}`,
          colorClass: lastMsg.status === "failed" ? "text-destructive" : "text-foreground-subtle",
        };
      }
      if (lastMsg.kind === "agent-thought") {
        const lines = lastMsg.text.split("\n").filter((l) => l.trim() !== "");
        if (lines.length > 0) {
          return {
            glyph: "▸",
            text: `[thinking] ${lines[lines.length - 1].trim()}`,
            colorClass: "text-foreground-subtlest",
          };
        }
      }
      if (lastMsg.kind === "agent-text") {
        const lines = lastMsg.text.split("\n").filter((l) => l.trim() !== "");
        if (lines.length > 0) {
          return {
            glyph: "▸",
            text: lines[lines.length - 1].trim(),
            colorClass: "text-foreground-subtlest",
          };
        }
      }
    }
  }

  // 2. Fall back to progress from details envelope
  const p = row.progress;
  if (p?.currentTool) {
    const args = p.currentToolArgs ? `: ${p.currentToolArgs}` : "";
    const dur = p.currentToolStartedAt
      ? ` · ${formatDuration(now - p.currentToolStartedAt)}`
      : "";
    return {
      glyph: "▸",
      text: `${p.currentTool}${args}`,
      duration: dur,
      colorClass: "text-foreground-subtle",
    };
  }
  if (p?.toolCalls && p.toolCalls.length > 0) {
    const last = p.toolCalls[p.toolCalls.length - 1];
    if (typeof last === "string") {
      return { glyph: "✓", text: last, colorClass: "text-foreground-subtle" };
    }
    if (last && typeof last === "object") {
      const glyph = last.error ? "✗" : "✓";
      const suffix = last.argsPreview ? `: ${last.argsPreview}` : "";
      return {
        glyph,
        text: `${last.name ?? "tool"}${suffix}`,
        colorClass: last.error ? "text-destructive" : "text-foreground-subtle",
      };
    }
  }
  if (p?.recentOutput && p.recentOutput.length > 0) {
    const lastLine = p.recentOutput[p.recentOutput.length - 1];
    if (lastLine) {
      return { glyph: "▸", text: lastLine, colorClass: "text-foreground-subtlest" };
    }
  }
  if (p?.output) {
    const lines = p.output.split("\n").filter((l) => l.trim() !== "");
    if (lines.length > 0) {
      return { glyph: "▸", text: lines[lines.length - 1], colorClass: "text-foreground-subtlest" };
    }
  }

  // 3. Fall back to result
  if (row.result) {
    const r = row.result;
    if (r.exitCode !== 0 && r.error) {
      return { glyph: "✗", text: r.error, colorClass: "text-destructive" };
    }
    if (r.finalOutput) {
      const lines = r.finalOutput.split("\n").filter((l) => l.trim() !== "");
      if (lines.length > 0) {
        return { text: lines[lines.length - 1], colorClass: "text-foreground-subtle" };
      }
    }
    return {
      glyph: r.exitCode === 0 ? "✓" : "✗",
      text: r.exitCode === 0 ? "Done" : "Failed",
      colorClass: r.exitCode === 0 ? "text-success" : "text-destructive",
    };
  }

  if (row.status === "running") {
    return { glyph: "▸", text: "Starting...", colorClass: "text-foreground-subtlest" };
  }

  return undefined;
}

/**
 * The resolve-miss tooltip — the ONE owner of the sentence a `no matching
 * Agent` caption explains (issue #47; the single-owner extraction is the review
 * follow-up).
 *
 * TWO surfaces print it: the Subagent directory row
 * (`SubagentDelegatingCard`) and the transcript sheet header
 * (`SubagentDetailHost`). Both hang it on the same quiet `MutedCaption`, and
 * for one period both carried the SAME literal (154 source characters, 145
 * rendered for a name as short as `reviewr`) — the shape that desynchronises
 * the first time someone rewords one of them while the other keeps the old
 * wording, which is exactly what `PROTECTED_WRITE_ROUTE` (Rust-side, same
 * program) exists to prevent on the refusal sentence. This is
 * that pattern in `src/lib/`: one exported producer, two consumers, and both
 * components' tests assert through the helper so the sentence cannot drift.
 * The extraction is output-preserving: the rendered sentence is byte-identical
 * to what the two literals produced (measured by diffing the moved string).
 *
 * WHAT THE SENTENCE OWES THE READER, and why each clause stays:
 *  - it QUOTES the name verbatim (no case fold, no trim): the marker's whole
 *    job is to make a typo visible, so it must show the exact string the
 *    resolver could not match;
 *  - it names the THREE things the child did not get — persona, tool
 *    allowlist, model override — because "no matching Agent" alone does not
 *    say what that costs;
 *  - it says the child RAN, on the parent's config: ADR 0020 makes an
 *    unmatched name a config-less dispatch and NOT an error, so copy that reads
 *    as a failure is a new bug (the same reason the caption is a quiet
 *    `text-warning` line and the row keeps its running glyph).
 *
 * It is a `title` (a hover affordance) and NOT the caption's text: the visible
 * caption stays one short phrase, and the sentence is the depth behind it. Both
 * captions' visible text is pinned in the component tests.
 */
export function unmatchedAgentTooltip(agentName: string): string {
  return (
    `No Agent definition named "${agentName}" — this child loaded no persona, ` +
    "no tool allowlist and no model override, and ran the parent's config instead."
  );
}
