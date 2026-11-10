import { useState } from "react";
import { Button } from "./ui/button";
import { IpcErrorLine } from "./IpcErrorLine";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { describeIpcError } from "../lib/ipcError";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { createTaskFromDraft } from "../store/taskLaunch";
import type { TaskRow } from "../lib/tauri";
import type { TaskLaunchMode } from "../lib/taskPrompt";

/**
 * The **New Task** modal — one textarea and three buttons.
 *
 * ## What changed, and why it matters
 *
 * This surface used to be a real chat: `MessageList`, `ComposerRow`, a skill
 * dropdown, a model-picker footer, and the rule that the FIRST SEND created the
 * Task. That made "put this sentence on my board" impossible without starting a
 * Session, spending a provider call, and waiting — for a card that is one line of
 * text. Now the create is one `create_task` write and the LLM is opt-in: **Backlog**
 * files the card and opens nothing; **Discuss** and **Research** file it and then
 * launch it as a Session.
 *
 * ## NO `boards` prop, and that is a decision rather than a simplification
 *
 * The columns a mode files into are resolved by `store/taskLaunch`, which reads the
 * SAME board slice the orchestrator's other rules read. The first draft took
 * `boards: readonly StageWithTasks[]` because `TasksBoard` already had the columns —
 * and that put two owners on one fact, so a modal rendered from a stale prop could
 * offer a column the write then refused to use. The board is one store; both readers
 * go to it.
 *
 * ## The three buttons are the skill choice
 *
 * The old Skill `Select` is GONE, and not for tidiness. A dropdown beside three
 * buttons would be two contradictable answers to "which skill" — the dropdown could
 * say `research` while the click said Backlog. The button IS the choice now, and
 * `lib/taskPrompt`'s mode table is the only place a skill name is spelled.
 *
 * ## The draft splits at the first newline
 *
 * Line one is the title, everything after it is the body — ONE rule shared by all
 * three buttons, so a multi-line paste produces the same card whichever button is
 * clicked. Nothing else about the title is decided here: `clean_title` runs
 * server-side (whitespace collapse, one matching quote pair stripped, multi-byte-safe
 * cap) and a title that cleans to nothing REJECTS with `kind: "empty_title"` rather
 * than falling back to the raw string. Re-spelling that predicate locally would be
 * the second implementation the spec forbids, so the error path here only adds the
 * lead-in that names the action to take (ADR 0063 puts the sentence in Rust).
 *
 * ## What a failure leaves behind, and why the modal stays open
 *
 * Backlog failing writes nothing, so the draft survives. A Discuss/Research failure
 * can land AFTER the card exists — at which point closing the dialog would take the
 * error line with it and leave the person believing their card was lost. So the
 * modal keeps its draft and shows the line, and the card that did get written is
 * already in the board the modal sits on top of.
 *
 * ## `onCreated(task, sessionId)` is the board's cue to leave
 *
 * A launched Session is invisible behind this board (`App`'s `"board"` arm renders
 * the board in place of `ChatStream`), so the board has to switch views — and only
 * this callback knows whether a Session was started. `sessionId` is `null` for
 * Backlog, which is the difference between "stay and show the new card" and "go look
 * at the transcript".
 *
 * ## Each button is gated on the skill it needs
 *
 * The catalog is an async fetch that starts EMPTY, so a button enabled from the first
 * paint is clickable before the catalog lands, and that click fails with "This Space
 * has no `discuss` skill" — a sentence that is false two frames later. Gating on the
 * same predicate `store/taskLaunch` refuses on removes the race rather than narrowing
 * it. Backlog needs no skill and is gated only on there being a Space.
 */
export interface NewTaskDialogProps {
  /** The **Space** the board is showing: the Task's `space_path` AND the cwd a
   *  launched Session starts in. `null` = no active Session, and every button is
   *  disabled — `createTask(null, …)` is not a thing. */
  spacePath: string | null;
  onClose: () => void;
  /** Reports the card, and the Session if one was started (`null` for Backlog). The
   *  board uses the second half to decide whether to leave the view. */
  onCreated: (task: TaskRow, sessionId: string | null) => void;
}

/** The three buttons, in the order a person reads them: safe first. */
const BUTTONS: { mode: TaskLaunchMode; label: string; hint: string }[] = [
  {
    mode: "backlog",
    label: "Backlog",
    hint: "Save this to the Backlog column. Nothing is started.",
  },
  {
    mode: "discuss",
    label: "Discuss",
    hint: "Save it and open a session that discusses it.",
  },
  {
    mode: "research",
    label: "Research",
    hint: "Save it to the Research column and open a session that researches it.",
  },
];

export default function NewTaskDialog({
  spacePath,
  onClose,
  onCreated,
}: NewTaskDialogProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skills only. `useMentionCatalogs` is module-cached per Space and the board surface
  // already mounted it, so this shares that fetch rather than issuing a second one.
  // The agents catalog is deliberately NOT read: this modal offers no `@` Mention, and
  // a fetch whose rows nothing renders is a fetch nothing keeps honest.
  const { skills } = useMentionCatalogs(spacePath);

  const submit = async (mode: TaskLaunchMode): Promise<void> => {
    if (spacePath === null) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await createTaskFromDraft(spacePath, draft, mode, {
        skills,
        agents: [],
      });
      // Report FIRST, then close: the board's `onCreated` may switch the view, and a
      // dialog that closed before the switch would leave one frame of board between the
      // click and the transcript.
      onCreated(outcome.task, outcome.sessionId);
      onClose();
    } catch (err) {
      // Stay open, keep the draft. `empty_title` gets a lead-in because the server's
      // sentence alone does not say what to type.
      const kindOfError = (err as { kind?: unknown } | null)?.kind;
      setError(
        kindOfError === "empty_title"
          ? `Give the Task a title first — ${describeIpcError(err)}.`
          : describeIpcError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const hasText = draft.trim() !== "";
  const disabledFor = (mode: TaskLaunchMode): boolean => {
    if (spacePath === null || busy || !hasText) return true;
    if (mode === "backlog") return false;
    // The same predicate `store/taskLaunch` refuses on — see the module note.
    return !skills.some((s) => s.name === mode);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* `sm:max-w-3xl` and NOT `max-w-3xl`: `DialogContent`'s base class ends in
          `sm:max-w-md`, and a bare `max-w-*` sits in a DIFFERENT tailwind-merge group,
          so both survive to the stylesheet and the `sm:` rule wins above 640px. Pinned
          by `src/components/ui/dialog.test.tsx`. */}
      <DialogContent className="flex w-full flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            The first line becomes the title, the rest the body. Backlog just saves
            the card.
          </DialogDescription>
        </DialogHeader>

        {/* A plain `textarea` and not `ComposerRow`. The composer owns the Mention
            picker, the attachment lifecycle and the auto-grow that serves a chat
            transcript; none of that belongs to a card that is one sentence. It carries
            `role="textbox"` by default, which is what the tests resolve it by. */}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What needs doing?"
          rows={5}
          className="min-h-0 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-brand"
        />

        <IpcErrorLine error={error} className="shrink-0" />

        <DialogFooter className="gap-2">
          {BUTTONS.map(({ mode, label, hint }) => (
            <Button
              key={mode}
              type="button"
              // Backlog is the safe, no-side-effect action, so it is the OUTLINE and the
              // two launches are the filled ones — the inverse of a destructive-first
              // footer, matching the reading order (safe first, and visibly safer).
              variant={mode === "backlog" ? "outline" : "default"}
              onClick={() => void submit(mode)}
              disabled={disabledFor(mode)}
              aria-label={label}
              title={
                spacePath === null
                  ? "No Space is open"
                  : mode !== "backlog" &&
                      !skills.some((s) => s.name === mode)
                    ? `This Space has no \`${mode}\` skill`
                    : hint
              }
            >
              {label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
