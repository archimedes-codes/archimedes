import { useEffect, useRef, useState } from "react";
import { AgentMarkdown } from "../AgentMarkdown";
import { IpcErrorLine } from "../IpcErrorLine";
import { MutedCaption } from "../MutedCaption";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface TaskDescriptionProps {
  /** `null` and `""` both read as "no description" and show the placeholder. */
  body: string | null;
  /** `null` = resting; a string = editing. Held by the dialog, so the draft survives a
   *  tab switch. */
  draft: string | null;
  onDraftChange: (next: string) => void;
  /** The caller sets `draft = body ?? ""`. */
  onStartEdit: () => void;
  /** The caller sets `draft = null` and clears the error. */
  onCancel: () => void;
  /** The caller clears the draft on success; on failure it keeps the draft and sets
   *  `error`. Never rejects. */
  onSave: (body: string | null) => Promise<void>;
  error: string | null;
}

/**
 * The Description block on the Overview tab: the body as markdown, click-to-edit.
 *
 * Props-only. The draft lives in the dialog (so Overview → artifact → Overview keeps it),
 * and this file only renders it and reports intent.
 *
 * NO `onBlur` on the textarea, and that absence IS the rule that blurring does not close
 * or save. Leaving the field keeps the draft open; Save, Cancel, Cmd/Ctrl+Enter and Escape
 * are the only ways out.
 */
export function TaskDescription({
  body,
  draft,
  onDraftChange,
  onStartEdit,
  onCancel,
  onSave,
  error,
}: TaskDescriptionProps) {
  const [saving, setSaving] = useState(false);
  // Guards the post-await `setSaving`: a successful save unmounts the editor.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const empty = body === null || body === "";
  const editing = draft !== null;

  const save = async () => {
    if (draft === null) return;
    if (draft === (body ?? "")) {
      onCancel();
      return;
    }
    // Whitespace-only clears the description. A non-empty draft is sent as typed.
    const next = draft.trim() === "" ? null : draft;
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      // A success unmounts this editor (the caller clears the draft), and React discards
      // a state update on an unmounted component, so this is safe on both paths. A
      // failure resolves with the editor still open, and this is what un-wedges it.
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <MutedCaption>Description</MutedCaption>
        {!editing && (
          <Button type="button" variant="ghost" size="xs" onClick={onStartEdit}>
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            value={draft}
            disabled={saving}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                onCancel();
              }
            }}
          />
          <IpcErrorLine error={error} />
          <div className="flex items-center justify-between gap-2">
            <MutedCaption>Cmd/Ctrl+Enter to save · Esc to cancel</MutedCaption>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={saving}
                onClick={() => void save()}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : empty ? (
        <button
          type="button"
          data-testid="task-body-empty"
          onClick={onStartEdit}
          className="cursor-pointer text-left text-ui-base text-foreground-subtlest italic hover:text-foreground-subtle"
        >
          Add a description…
        </button>
      ) : (
        <div
          data-testid="task-body"
          className="min-h-0 shrink-0 cursor-text text-ui-base text-foreground-subtle"
          onClick={(e) => {
            // A link must stay a link: its activation External-opens (`OpenAnchor`), so
            // the body's click-to-edit must not swallow it.
            if ((e.target as HTMLElement).closest("a") !== null) return;
            onStartEdit();
          }}
        >
          <AgentMarkdown text={body} />
        </div>
      )}
    </div>
  );
}
