import { useEffect, useRef, useState } from "react";
import { BellRingIcon, CheckIcon, CopyIcon } from "lucide-react";
import { IpcErrorLine } from "../IpcErrorLine";
import { MutedCaption } from "../MutedCaption";
import { SessionStatusMark } from "../SessionStatusMark";
import { moneyOf } from "../SessionCostLine";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { absoluteTimeFromInstant, relativeTimeFromInstant } from "../../lib/sessionTime";
import { cardMarkOf } from "../../lib/sessionStatusRollup";
import { useCopyButton } from "../../hooks/useCopyButton";
import type { SessionStatus } from "../../hooks/useSessionStatus";
import type { StageWithTasks, TaskRow } from "../../lib/tauri";

export interface TaskDetailPropertiesProps {
  task: TaskRow;
  /** Stage `<Select>` options, in the given order. */
  columns: readonly StageWithTasks[] | undefined;
  /** `spacePath === null` disables the Stage control. */
  stageDisabled: boolean;
  /** The session rollup. Fed to `cardMarkOf`, which refuses anything but waiting/running. */
  status: SessionStatus | null;
  ready: boolean;
  sessionCount: number;
  /** `null` prints no money; `0` prints `$0.00` (ADR 0082). */
  costUsd: number | null;
  /** Fired with the NEW slug only when it differs from `task.stageSlug`. */
  onMoveStage: (toStageSlug: string) => Promise<void>;
  /** `null` clears. Resolves → the editor closes; rejects → it stays open. */
  onSaveSpecPath: (specPath: string | null) => Promise<void>;
  onEditingChange: (editing: boolean) => void;
  moveError: string | null;
  moveNote: string | null;
  specError: string | null;
}

/**
 * The Properties column: Stage, Status, Activity, spec path, Updated/Created and the id.
 *
 * Props-only. It reads no store and calls no IPC. The dialog wires every outward effect.
 * It is an `<aside>` with NO `overflow-*`: the one scroller in the modal is `detail-scroll`.
 */
export function TaskDetailProperties({
  task,
  columns,
  stageDisabled,
  status,
  ready,
  sessionCount,
  costUsd,
  onMoveStage,
  onSaveSpecPath,
  onEditingChange,
  moveError,
  moveNote,
  specError,
}: TaskDetailPropertiesProps) {
  const mark = cardMarkOf({ sessionStatus: status, ready });
  const money = moneyOf(costUsd);
  // A slug with no column still needs an option, so `SelectValue` shows the slug.
  const hasColumn = columns?.some((c) => c.stage.slug === task.stageSlug) ?? false;

  return (
    <aside
      data-testid="task-properties"
      className="flex min-w-0 shrink-0 flex-col gap-4 break-words border-t border-border pt-3 md:w-64 md:shrink-0 md:border-t-0 md:border-l md:pt-0 md:pl-4"
    >
      <div data-testid="property-row" data-property="stage" className="flex min-w-0 flex-col gap-1">
        <MutedCaption>Stage</MutedCaption>
        <Select
          value={task.stageSlug}
          onValueChange={(next) => {
            if (next !== task.stageSlug) void onMoveStage(next);
          }}
          disabled={stageDisabled}
        >
          <SelectTrigger aria-label="Stage" className="w-full min-w-0" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {columns?.map((c) => (
              <SelectItem key={c.stage.slug} value={c.stage.slug}>
                {c.stage.label}
              </SelectItem>
            ))}
            {!hasColumn && (
              <SelectItem value={task.stageSlug}>{task.stageSlug}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <IpcErrorLine error={moveError} />
        {moveNote !== null && (
          <div role="status" data-testid="move-note" className="text-ui-sm text-warning">
            {moveNote}
          </div>
        )}
      </div>

      {mark !== null && (
        <div data-testid="property-row" data-property="status" className="flex min-w-0 flex-col gap-1">
          <MutedCaption>Status</MutedCaption>
          {mark === "ready" ? (
            <span className="flex items-center gap-1.5 text-ui-sm text-foreground">
              <BellRingIcon
                aria-hidden
                data-testid="property-ready-glyph"
                className="size-3.5 shrink-0 text-warning"
              />
              Ready
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ui-sm text-foreground">
              <SessionStatusMark
                status={mark}
                size={16}
                dotSize={8}
                testId="property-status-mark"
              />
              {mark === "waiting" ? "Waiting for you" : "Running"}
            </span>
          )}
        </div>
      )}

      <div data-testid="property-row" data-property="activity" className="flex min-w-0 flex-col gap-1">
        <MutedCaption>Activity</MutedCaption>
        <span className="text-ui-sm text-foreground-subtle">
          {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          {money !== null && <> · {money}</>}
        </span>
      </div>

      <SpecPathRow
        specPath={task.specPath}
        onSave={onSaveSpecPath}
        onEditingChange={onEditingChange}
        error={specError}
      />

      <div data-testid="property-row" data-property="updated" className="flex min-w-0 flex-col gap-1">
        <MutedCaption>Updated</MutedCaption>
        <span
          className="text-ui-sm text-foreground-subtle"
          title={absoluteTimeFromInstant(task.updatedAt)}
        >
          {relativeTimeFromInstant(task.updatedAt)}
        </span>
      </div>

      <div data-testid="property-row" data-property="created" className="flex min-w-0 flex-col gap-1">
        <MutedCaption>Created</MutedCaption>
        <span
          className="text-ui-sm text-foreground-subtle"
          title={absoluteTimeFromInstant(task.createdAt)}
        >
          {relativeTimeFromInstant(task.createdAt)}
        </span>
      </div>

      <IdRow id={task.id} />
    </aside>
  );
}

/** The spec path: inert text that click-to-edits. Not a `FileChip` (ADR 0101). */
function SpecPathRow({
  specPath,
  onSave,
  onEditingChange,
  error,
}: {
  specPath: string | null;
  onSave: (specPath: string | null) => Promise<void>;
  onEditingChange: (editing: boolean) => void;
  error: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(specPath ?? "");
  // Mirrors `editing` for the unmount cleanup, which must read the value as of now.
  const editingRef = useRef(false);
  const reportRef = useRef(onEditingChange);
  reportRef.current = onEditingChange;
  const cancelledRef = useRef(false);
  // Set while a save is in flight. `saving` is the rendered mirror that disables the
  // input, so newer typing cannot be discarded when the old save resolves (Greptile P2).
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // The input, and a one-shot request to refocus it after a rejected save (see TaskDetailHeader:
  // a disabled input drops its focus, and it must be handed back once enabled again).
  const inputRef = useRef<HTMLInputElement>(null);
  const refocusRef = useRef(false);
  useEffect(() => {
    if (!saving && refocusRef.current) {
      refocusRef.current = false;
      inputRef.current?.focus();
    }
  }, [saving]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setEditingState = (next: boolean) => {
    if (editingRef.current === next) return;
    editingRef.current = next;
    setEditing(next);
    reportRef.current(next);
  };

  useEffect(
    () => () => {
      if (editingRef.current) reportRef.current(false);
    },
    [],
  );

  const open = () => {
    cancelledRef.current = false;
    setDraft(specPath ?? "");
    setEditingState(true);
  };

  const commit = () => {
    if (cancelledRef.current || savingRef.current) return;
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === (specPath ?? null)) {
      setEditingState(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    void onSave(next).then(
      () => {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
        setEditingState(false);
      },
      () => {
        savingRef.current = false;
        refocusRef.current = true;
        if (mounted.current) setSaving(false);
      },
    );
  };

  const cancel = () => {
    cancelledRef.current = true;
    setDraft(specPath ?? "");
    setEditingState(false);
  };

  return (
    <div data-testid="property-row" data-property="spec" className="flex min-w-0 flex-col gap-1">
      <MutedCaption>Spec path</MutedCaption>
      {editing ? (
        <Input
          ref={inputRef}
          size="sm"
          autoFocus
          className="font-mono"
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              cancel();
            }
          }}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          data-testid="spec-path-value"
          title={specPath ?? "Add spec path…"}
          onClick={open}
          className="min-w-0 cursor-pointer break-all text-left font-mono text-ui-xs text-foreground-subtle hover:text-foreground"
        >
          {specPath || <span className="italic text-foreground-subtlest">Add spec path…</span>}
        </button>
      )}
      <IpcErrorLine error={error} />
    </div>
  );
}

/** The task id, as text, with a copy control. The id is the key; the number is the label. */
function IdRow({ id }: { id: string }) {
  const { copied, copy } = useCopyButton(id);
  return (
    <div data-testid="property-row" data-property="id" className="flex min-w-0 flex-col gap-1">
      <MutedCaption>ID</MutedCaption>
      <div className="flex min-w-0 items-center gap-1">
        <span
          data-testid="task-id-value"
          title={id}
          className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle"
        >
          {id}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title="Copy task ID"
          onClick={copy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span className="sr-only">{copied ? "Copied" : "Copy task ID"}</span>
        </Button>
      </div>
    </div>
  );
}
