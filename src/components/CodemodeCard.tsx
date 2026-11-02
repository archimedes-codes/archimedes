import { useEffect, useState } from "react";
import { createHighlighter, type Highlighter } from "shiki";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ToolCallUiStatus } from "../store/sessions";
import { useSettings } from "../store/settings";
import { fileIconFor } from "../lib/fileIcons";
import { useCopyButton } from "../hooks/useCopyButton";
import { StatusIcon } from "./SubagentStatusIcon";
import { ToolCallCardHeader } from "./ToolCallCardHeader";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";

/**
 * The `codemode` tool-call card: ONE expandable card whose body lists the
 * script's NESTED calls (`tools.<name>(args)` inside the QuickJS script).
 *
 * Shape precedent: `SubagentDelegatingCard` — the standard `ToolCallCardHeader`
 * shell, open by default, a `divide-y` nested-row list in the expanded body,
 * `StatusIcon` per row. The structural difference is where the children come
 * from: the subagent card subscribes to a separate store; THIS card is
 * props-driven. Its rows come from the parent message's own `rawOutput`, which
 * the reducer replaces wholesale on every frame for that message
 * (`reducer.ts:212` `rawOutput: update.rawOutput ?? prev.rawOutput`), and
 * `MessageBubble` is memoized — so the prop IS the live path. No store
 * subscription, no reducer edit, no new linkage.
 *
 * THE ONE SOURCE (`docs/roadmap/codemode-status.md`, "Frozen cross-task
 * contracts" item 1, as amended): both the live `tool_execution_update` frame
 * and the final `tool_execution_end` result carry the parent's SERIALIZED
 * `ToolResult` (`tools/types.rs:42` → `{ content, details, isError }`), and
 * `merge_json` (`normalize.rs:162`) is a shallow top-level key overwrite — so
 * live and final land the SAME shape at the SAME key, and the nested calls are
 * always read from `rawOutput.details.calls`. There is no `rawOutput.calls`
 * key: a `{calls}`-shaped `rawOutput` belongs to a superseded contract and
 * renders zero rows. The defensive reads below are for MALFORMED data (absent /
 * foreign shapes render nothing rather than throwing), not for a second key.
 *
 * Row identity is each element's `toolCallId` (`"<parentCallId>/<n>"` — opaque
 * here; the FRAME-level id is the PARENT's, which is why the fold lands on this
 * row at all) and reconciliation is last-writer-wins per id, so a repeat inside
 * one snapshot, or a live row arriving again in the final array, updates the row
 * in place instead of appending a second one.
 *
 * No `../lib/tauri` import: nested rows are not external-openable (a nested call
 * has no session of its own), and highlighting needs no IPC. That keeps this
 * file off the tauri barrel entirely — and its test off a barrel mock.
 */

/** `<Button variant="ghost" size="default">`'s base, undone — the same wall
 *  `MessageBubble`'s `CodeBlock` header carries (`COPY_GLYPH_WALL`) and for the
 *  same reasons: `ui/button.tsx` defaults to `variant: "default"`, so a bare
 *  `<Button>` paints `bg-primary text-primary-foreground h-7 px-2`. */
const COPY_GLYPH_WALL =
  "border-0 inline-block h-auto px-0 justify-start transition-none text-[length:inherit] hover:bg-transparent";

/** The ONE body class for both script branches — the string `MessageBubble`'s
 *  `CodeBlock` uses, and the same rule: the highlighted and the fallback body
 *  must never differ in shape (Shiki writes its own inline paper colour, so no
 *  background class here). */
const CODE_BODY_CLASS = "overflow-x-auto p-3 font-mono text-sm";

/**
 * The script body's highlighter — `MessageBubble`'s module-private singleton
 * pattern replicated (one instance per module), NOT a new dependency. `shiki`
 * is a devDependency and the app's unit tests are what import these components;
 * the only difference from `MessageBubble`'s copy is that this is a second
 * instance of the SAME pattern with the SAME theme/lang set — no `package.json`
 * change, no new grammar (`javascript` is already in the allowlist).
 */
let highlighterPromise: Promise<Highlighter> | null = null;
function getCodemodeHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "dracula"],
      langs: [
        "bash",
        "rust",
        "typescript",
        "javascript",
        "tsx",
        "jsx",
        "json",
        "python",
        "toml",
        "yaml",
      ],
    });
  }
  return highlighterPromise;
}

/**
 * The script body: header (glyph + `javascript` label + copy) above the
 * highlighted body. A named component because it holds hooks (mirroring
 * `MessageBubble`'s `CodeBlock`), and the header renders whether or not the
 * highlight resolved — the block never changes shape between branches.
 */
function ScriptBlock({ code }: { code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  // (ADR 0027) The syntax theme DERIVES from the palette, so an already-mounted
  // card re-highlights when the settings UI changes it — no reload.
  const palette = useSettings((s) => s.settings?.palette ?? "zai");
  const { copied, copy: handleCopy } = useCopyButton(code);
  const descriptor = fileIconFor("x.javascript");
  const Icon = descriptor.icon;

  useEffect(() => {
    let cancelled = false;
    getCodemodeHighlighter().then((highlighter) => {
      if (cancelled) return;
      try {
        setHtml(
          highlighter.codeToHtml(code, {
            lang: "javascript",
            theme: palette === "dracula" ? "dracula" : "github-dark",
          }),
        );
      } catch {
        setHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // `palette` is a dependency on purpose: it is what re-runs `codeToHtml` the
    // instant the palette changes (both themes are already loaded).
  }, [code, palette]);

  const header = (
    <div
      data-testid="codemode-script-header"
      className="flex items-center justify-between gap-2 border-b border-border bg-panel px-3 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", descriptor.className)} />
        <span
          data-testid="codemode-script-lang"
          className={cn(descriptor.className, "font-mono text-ui-caption lowercase")}
        >
          javascript
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        className={cn(COPY_GLYPH_WALL, "shrink-0 text-foreground-subtle hover:text-foreground")}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </Button>
    </div>
  );

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border">
      {header}
      {html ? (
        <div
          className={CODE_BODY_CLASS}
          // Shiki output is produced locally from the user's own agent output.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={CODE_BODY_CLASS}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/** A nested call, read defensively — `Record<string, unknown>` at the boundary
 *  (`Message.rawOutput` is `unknown`, `sessionTypes.ts:45`). */
type NestedRow = Record<string, unknown>;

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** Empty containers render no secondary line (`{}` args and `[]` args are both
 *  "the tool took nothing", and an empty pair of braces is noise). */
const argsTextOf = (args: unknown): string => {
  if (typeof args !== "object" || args === null) return "";
  const json = JSON.stringify(args);
  return json === "{}" || json === "[]" ? "" : json;
};

/** The frozen contract's element status → the glyph's status. `denied` reads as
 *  a failure (the policy gate refused the call; the model sees the same wording
 *  a direct denial returns). An absent/unknown status follows the PARENT: a
 *  still-streaming parent means the row is still in flight, a settled parent
 *  means it is done. */
function rowStatus(
  element: NestedRow,
  parentStatus: ToolCallUiStatus,
  isStreaming: boolean,
): "running" | "completed" | "failed" {
  switch (element.status) {
    case "ok":
      return "completed";
    case "error":
    case "denied":
      return "failed";
    case "running":
      return "running";
    default:
      return parentStatus === "pending" || isStreaming ? "running" : "completed";
  }
}

/**
 * ONE nested call's row: the status glyph, the nested tool's name, its args,
 * its output, and a copy affordance when there is output.
 *
 * A named component (not a block inside the card's `.map`) for the ordinary
 * rules-of-hooks reason — the row owns a `useCopyButton` — and it is the row the
 * card's test queries by `data-testid="codemode-call-row"`.
 *
 * A plain `div`, NOT a `<Button>`: unlike the subagent directory row these rows
 * have no click action (a nested call has no session of its own to open), and
 * the transcript no-band rule (ADR 0062, `lib/transcriptRow.ts`) means this row
 * spells no `bg-*` token at all.
 */
function NestedCallRow({
  row,
  parentStatus,
  isStreaming,
}: {
  row: NestedRow;
  parentStatus: ToolCallUiStatus;
  isStreaming: boolean;
}) {
  const name = typeof row.toolName === "string" ? row.toolName : "tool";
  const argsText = argsTextOf(row.args);
  const out = textOf(row.text);
  const failed = row.status === "error" || row.isError === true;
  const { copied, copy: handleCopy } = useCopyButton(out);

  return (
    <div
      data-testid="codemode-call-row"
      className="flex items-start gap-2.5 px-2 py-2"
    >
      <span className="mt-1">
        <StatusIcon status={rowStatus(row, parentStatus, isStreaming)} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate text-ui-base font-medium">{name}</span>
        {argsText !== "" && (
          <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
            {argsText}
          </span>
        )}
        {out !== "" && (
          <pre
            className={cn(
              "max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs",
              // A failed nested call keeps its output (the reason IS the output)
              // and rides the destructive ink. `text-destructive/70` is the
              // literal this file and its test BOTH spell, so the assertion
              // cannot drift from the markup.
              failed ? "text-destructive/70" : "text-foreground-subtle",
            )}
          >
            {out}
          </pre>
        )}
      </div>
      {out !== "" && (
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : `Copy ${name} output`}
          title={copied ? "Copied" : `Copy ${name} output`}
          className={cn(
            COPY_GLYPH_WALL,
            "shrink-0 text-foreground-subtle hover:text-foreground",
          )}
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </Button>
      )}
    </div>
  );
}

export default function CodemodeCard({
  title,
  status,
  rawInput,
  rawOutput,
  isStreaming = false,
}: {
  title: string;
  status: ToolCallUiStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  isStreaming?: boolean;
}) {
  // Open by default (the `SubagentDelegatingCard` precedent): the nested calls
  // ARE the interesting part of a codemode call.
  const [open, setOpen] = useState(true);

  const rawOutputObject =
    typeof rawOutput === "object" && rawOutput !== null
      ? (rawOutput as Record<string, unknown>)
      : undefined;
  const details =
    rawOutputObject &&
    typeof rawOutputObject.details === "object" &&
    rawOutputObject.details !== null
      ? (rawOutputObject.details as Record<string, unknown>)
      : undefined;

  // ── The row derivation ────────────────────────────────────────────────────
  // This region (`const calls =` … `const rows =`) is the ONE place the nested
  // calls are read, and `src/lib/toolDetailsRegistry.test.ts` walks exactly it:
  // renaming `calls`/`rows`, or moving the `details` read out of the region,
  // reddens that file's evidence guard instead of silently unregistering the
  // reader.
  const calls = Array.isArray(details?.calls)
    ? details.calls.filter(
        (call): call is NestedRow =>
          typeof call === "object" &&
          call !== null &&
          typeof (call as NestedRow).toolCallId === "string",
      )
    : [];
  // LAST-WRITER-WINS per element `toolCallId`: `Map.set` overwrites an earlier
  // element of the same id, so a repeat inside one snapshot — or a live row the
  // final array carries again — collapses to ONE row showing the LAST element.
  // A filter+map would render two rows for the same id. The Map's insertion
  // order is first-seen order, which is also completion order, so reconciliation
  // never reorders the list.
  const rows = Array.from(
    calls
      .reduce(
        (byId, element) => byId.set(element.toolCallId as string, element),
        new Map<string, NestedRow>(),
      )
      .values(),
  );
  // ──────────────────────────────────────────────────────────────────────────

  // The script body is the card's "what ran"; the nested rows follow below it.
  const script =
    typeof rawInput === "object" && rawInput !== null
      ? textOf((rawInput as Record<string, unknown>).code)
      : "";

  return (
    <div className="flex w-full flex-col">
      <ToolCallCardHeader
        title={title}
        status={status}
        rawInput={rawInput}
        rawOutput={rawOutput}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        files={[]}
        stat={undefined}
        range={undefined}
        isShell={false}
        command={undefined}
      />
      {open && (
        <>
          {script !== "" && <ScriptBlock key="codemode-script" code={script} />}
          {rows.length > 0 ? (
            <div className="mt-1 divide-y divide-border/50 rounded-xl bg-panel px-4 py-3">
              {rows.map((row) => (
                <NestedCallRow
                  key={row.toolCallId as string}
                  row={row}
                  parentStatus={status}
                  isStreaming={isStreaming}
                />
              ))}
            </div>
          ) : (
            // A live codemode call that has produced no rows yet shows a quiet
            // placeholder rather than a blank panel (the "No subagents yet."
            // pattern one card over).
            <p className="font-mono text-ui-base text-foreground-subtle">
              No nested calls yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}
