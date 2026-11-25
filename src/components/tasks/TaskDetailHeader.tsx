import { useEffect, useRef, useState } from "react";
import { Input } from "../ui/input";
import { IpcErrorLine } from "../IpcErrorLine";
import { DialogHeader, DialogTitle } from "../ui/dialog";

export interface TaskDetailHeaderProps {
  /** Rendered as `T{number}` in its own span. */
  number: number;
  title: string;
  /** Called ONLY when the trimmed draft is non-empty AND differs from `title`, with the
   *  TRIMMED draft. Resolves → the editor closes. Rejects → the editor stays open with
   *  the draft intact (the caller shows `error`). */
  onSaveTitle: (title: string) => Promise<void>;
  /** `true` when the editor opens, `false` when it closes or unmounts. Lets the dialog's
   *  `onEscapeKeyDown` suppress close while an editor is open. */
  onEditingChange: (editing: boolean) => void;
  error: string | null;
}

/**
 * The modal's pinned header: `T{n}` and the title, which click-to-edit.
 *
 * Props-only. Its one outward effect is `onSaveTitle`, which the dialog wires to the
 * store's `editTask`; this file never reads a store or calls IPC.
 */
export function TaskDetailHeader({
  number,
  title,
  onSaveTitle,
  onEditingChange,
  error,
}: TaskDetailHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  // Mirrors `editing` for the handlers and the unmount cleanup, which must read the
  // value as of NOW rather than the render that created them.
  const editingRef = useRef(false);
  // The latest reporter, so the unmount cleanup does not re-run when the caller passes a
  // fresh callback identity on every render.
  const reportRef = useRef(onEditingChange);
  reportRef.current = onEditingChange;
  // Set by Escape so the blur that follows does not save the discarded draft.
  const cancelledRef = useRef(false);
  // Set while a commit is in flight so Enter-then-blur cannot save twice. The ref guards
  // the handlers; `saving` is the RENDERED mirror, so the input is disabled while pending
  // and newer typing cannot be discarded when the old save resolves (Greptile P2).
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // The input, and a one-shot request to refocus it. A disabled input loses focus, so after
  // a REJECTED save the focus has to be handed back explicitly once it is enabled again.
  const inputRef = useRef<HTMLInputElement>(null);
  const refocusRef = useRef(false);
  useEffect(() => {
    if (!saving && refocusRef.current) {
      refocusRef.current = false;
      inputRef.current?.focus();
    }
  }, [saving]);
  // Guards the post-await state updates: a successful save unmounts the editor.
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

  // Unmount while open: the dialog must hear that the editor is gone.
  useEffect(
    () => () => {
      if (editingRef.current) reportRef.current(false);
    },
    [],
  );

  const open = () => {
    cancelledRef.current = false;
    setDraft(title);
    setEditingState(true);
  };

  const commit = () => {
    if (cancelledRef.current || savingRef.current) return;
    const next = draft.trim();
    if (next === "" || next === title) {
      setEditingState(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    void onSaveTitle(next).then(
      () => {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
        setEditingState(false);
      },
      () => {
        // Rejected: stay open with the draft. The caller renders `error`. Disabling the input
        // dropped its focus, so ask for it back once the re-render re-enables the input.
        savingRef.current = false;
        refocusRef.current = true;
        if (mounted.current) setSaving(false);
      },
    );
  };

  const cancel = () => {
    cancelledRef.current = true;
    setDraft(title);
    setEditingState(false);
  };

  return (
    <DialogHeader className="shrink-0 pr-8">
      <DialogTitle className="flex items-baseline gap-2">
        <span className="font-mono text-ui-sm text-foreground-subtle">
          T{number}
        </span>
        {editing ? (
          <Input
            ref={inputRef}
            size="sm"
            autoFocus
            className="min-w-0 flex-1"
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
            title="Click to edit title"
            className="min-w-0 cursor-pointer truncate text-left hover:text-foreground"
            onClick={open}
          >
            {title}
          </button>
        )}
      </DialogTitle>
      <IpcErrorLine error={error} />
    </DialogHeader>
  );
}
