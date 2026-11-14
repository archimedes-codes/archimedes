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
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { describeIpcError } from "../lib/ipcError";
import { useMentionCatalogs } from "../hooks/useMentionCatalogs";
import { createTaskFromDraft, SAVE_ONLY } from "../store/taskLaunch";
import type { TaskRow } from "../lib/tauri";
import type { TaskLaunchDestination } from "../lib/taskPrompt";

/**
 * The **New Task** modal — two fields and two buttons.
 *
 * ## What changed, and why it matters
 *
 * This surface used to be a real chat: `MessageList`, `ComposerRow`, a skill
 * dropdown, a model-picker footer, and the rule that the FIRST SEND created the
 * Task. That made "put this sentence on my board" impossible without starting a
 * Session, spending a provider call, and waiting — for a card that is one line of
 * text. Now the create is one `create_task` write and the LLM is opt-in: **Backlog**
 * files the card and opens nothing; **Research** files it and then launches it as a
 * Session.
 *
 * ## NO `boards` prop, and that is a decision rather than a simplification
 *
 * The columns a destination files into are resolved by `store/taskLaunch`, which reads the
 * SAME board slice the orchestrator's other rules read. The first draft took
 * `boards: readonly StageWithTasks[]` because `TasksBoard` already had the columns —
 * and that put two owners on one fact, so a modal rendered from a stale prop could
 * offer a column the write then refused to use. The board is one store; both readers
 * go to it.
 *
 * ## The two buttons are the skill choice
 *
 * The old Skill `Select` is GONE, and not for tidiness. A dropdown beside the buttons
 * would be two contradictable answers to "which skill" — the dropdown could say
 * `research` while the click said Backlog. The button IS the choice now, and
 * `lib/taskPrompt`'s destination shape is the only place a launch is described.
 *
 * Note what replaced the mode table this file used to point at. `lib/taskPrompt`'s
 * `TASK_LAUNCH_MODES` / `skillOfMode` table is DELETED (issue #179, ADR 0098): the
 * Stage row owns the Skill now. That is why the two destinations below name a slug
 * and a skill the seeded row already carries, and why `store/taskLaunch` resolves
 * them against the board rather than translating a literal — the button is still the
 * one choice, it just no longer has to be a hardcoded one to be a single answer.
 *
 * ## Two fields, and nothing inferred between them
 *
 * Title and Body are separate inputs. This surface used to be ONE textarea with the
 * rule "line 0 is the title, the rest is the body", which had two costs: a paste whose
 * first line happened to be prose silently invented a heading out of it, and a short
 * title with a long body was impossible without typing a newline you did not mean.
 * Both fields now say what they are, and the only thing derived from either is a
 * `trim()` — the body keeps its newlines as CONTENT rather than reading the first one
 * as a delimiter.
 *
 * The title is the ONLY gate on the buttons, and the body is never a fallback for it.
 * Guessing a heading from prose is exactly what the two fields exist to remove, so a
 * blank title stays disabled even when the body is full.
 *
 * Nothing else about the title is decided here: `clean_title` runs server-side
 * (whitespace collapse, one matching quote pair stripped, multi-byte-safe cap) and a
 * title that cleans to nothing REJECTS with `kind: "empty_title"` rather than falling
 * back to the raw string. Re-spelling that predicate locally would be the second
 * implementation the spec forbids, so the error path here only adds the lead-in that
 * names the action to take (ADR 0063 puts the sentence in Rust).
 *
 * ## What a failure leaves behind, and why the modal stays open
 *
 * Backlog failing writes nothing, so both fields survive. A Research failure can land
 * AFTER the card exists — at which point closing the dialog would take the
 * error line with it and leave the person believing their card was lost. So the
 * modal keeps both fields and shows the line, and the card that did get written is
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
 * has no `research` skill" — a sentence that is false two frames later. (The name in
 * that sentence is templated on the destination's own `onEnterSkill`, so it names
 * whatever Skill the surviving launch button asks for; `research` is simply the one it
 * asks for now.) Gating on the same predicate `store/taskLaunch` refuses on removes
 * the race rather than narrowing
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

/** The two buttons, in the order a person reads them: safe first.
 *
 *  Each is a DESTINATION, not a mode (issue #179). The two shipped destinations are
 *  the two seeded Stages they name, so the slug and the Skill spelled here are the
 *  seeded row's own `slug` / `on_enter_skill` — and they are hardcoded deliberately,
 *  on the decision this file already records below ("NO `boards` prop"): a modal that
 *  built one button per loaded Stage would offer a column the create then refuses,
 *  which is the same two-owners-on-one-fact defect the detail modal's header records
 *  for its own label. The store resolves the SAME two slugs against the board it
 *  reads, so the button set and the write still cannot disagree.
 *
 *  There used to be a third. It was DROPPED (ADR 0107) together with the seeded Stage
 *  it named: its `onEnterSkill` could never satisfy the gate below, so the button
 *  rendered permanently disabled behind a tooltip that was false about the Space's
 *  future. That is why the list stays hardcoded rather than following the loaded
 *  Stages — a derived list is a list that can offer a launch the create refuses, which
 *  is exactly what this one had done.
 *
 *  `SAVE_ONLY` is Backlog: a real column to file into, and `launches: false` is the
 *  one thing that makes it not a launch. */
const BUTTONS: {
  destination: TaskLaunchDestination;
  label: string;
  hint: string;
}[] = [
  {
    destination: SAVE_ONLY,
    label: "Backlog",
    hint: "Save this to the Backlog column. Nothing is started.",
  },
  {
    destination: { slug: "research", label: "Research", onEnterSkill: "research" },
    label: "Research",
    hint: "Save it to the Research column and open a session that researches it.",
  },
];

export default function NewTaskDialog({
  spacePath,
  onClose,
  onCreated,
}: NewTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skills only. `useMentionCatalogs` is module-cached per Space and the board surface
  // already mounted it, so this shares that fetch rather than issuing a second one.
  // The agents catalog is deliberately NOT read: this modal offers no `@` Mention, and
  // a fetch whose rows nothing renders is a fetch nothing keeps honest.
  const { skills } = useMentionCatalogs(spacePath);

  const submit = async (destination: TaskLaunchDestination): Promise<void> => {
    if (spacePath === null) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await createTaskFromDraft(spacePath, title, body, destination, {
        skills,
        agents: [],
      });
      // Report FIRST, then close: the board's `onCreated` may switch the view, and a
      // dialog that closed before the switch would leave one frame of board between the
      // click and the transcript.
      onCreated(outcome.task, outcome.sessionId);
      onClose();
    } catch (err) {
      // Stay open, keep both fields. `empty_title` gets a lead-in because the server's
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

  // The TITLE alone gates the buttons. The body is optional by design — a card is one
  // sentence and the body is the extra — so requiring both would refuse the common
  // case, and requiring neither would ship a title-less card to a server-side
  // `empty_title` rejection this dialog could have avoided.
  const hasTitle = title.trim() !== "";
  const disabledFor = (destination: TaskLaunchDestination): boolean => {
    if (spacePath === null || busy || !hasTitle) return true;
    // A save-only destination loads nothing, so it waits on nothing but the title.
    if (destination.onEnterSkill === null) return false;
    // The same predicate `store/taskLaunch` refuses on — see the module note.
    return !skills.some((s) => s.name === destination.onEnterSkill);
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
            Backlog just saves the card. Research also opens a session for it.
          </DialogDescription>
        </DialogHeader>

        {/* TWO labelled fields, wrapping `<label>` in the shape `NewSpaceDialog` uses
            (the repo has no `Label` primitive and no `htmlFor` site, so the association
            comes from nesting rather than an id). The name is load-bearing twice over:
            an `<input>` and a `<textarea>` BOTH have ARIA role `textbox`, so two
            unlabelled fields are one ambiguous "textbox" to a screen reader AND to the
            tests that resolve them. */}
        <label className="flex flex-col gap-1 text-ui-base">
          Title
          {/* A single-line `Input`, deliberately: a title that could wrap would let a
              multi-line paste back into the field the old split used to guess at. */}
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
          />
        </label>
        {/* The hint sits OUTSIDE the `<label>`, and that placement is a correctness
            detail rather than layout: a wrapping label's accessible name is its whole
            text content, so a hint nested inside would name this field
            "Body Optional. Newlines are kept." — which is both what a screen reader
            would say and what the tests resolve it by. */}
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-ui-base">
            Body
            {/* `Textarea` and not `ComposerRow`: the composer owns the Mention picker,
                the attachment lifecycle and the auto-grow that serves a chat
                transcript, and none of that belongs to a card. */}
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Anything else worth knowing?"
              rows={4}
            />
          </label>
          <span className="text-ui-sm text-foreground-subtlest">
            Optional. Newlines are kept.
          </span>
        </div>

        <IpcErrorLine error={error} className="shrink-0" />

        <DialogFooter className="gap-2">
          {BUTTONS.map(({ destination, label, hint }) => (
            <Button
              key={destination.slug}
              type="button"
              // Backlog is the safe, no-side-effect action, so it is the OUTLINE and
              // the launch is the filled one — the inverse of a destructive-first
              // footer, matching the reading order (safe first, and visibly safer). The
              // flag that decides it is the destination's own `launches`, so another
              // save-only Stage would read as safe without anyone editing this line.
              variant={destination.launches === false ? "outline" : "default"}
              onClick={() => void submit(destination)}
              disabled={disabledFor(destination)}
              aria-label={label}
              title={
                spacePath === null
                  ? "No Space is open"
                  : destination.onEnterSkill !== null &&
                      !skills.some((s) => s.name === destination.onEnterSkill)
                    ? `This Space has no \`${destination.onEnterSkill}\` skill`
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
