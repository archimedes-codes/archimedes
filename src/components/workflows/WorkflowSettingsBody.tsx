import type { ReactElement } from "react";

import { MutedCaption } from "../MutedCaption";
import { AddStageField } from "./AddStageField";
import { AutoChainGuards } from "./AutoChainGuards";
import { StrictWorkflowToggle } from "./StrictWorkflowToggle";

/**
 * The **workflow's** settings — what the panel shows when nothing is selected, i.e.
 * when the person clicked empty canvas. Three subjects, none of which belongs to a
 * column:
 *
 *  - `StrictWorkflowToggle` — does this Space's graph BIND a drag, or does any column
 *    accept one (ADR 0099);
 *  - `AutoChainGuards` — the step bound and the USD ceiling one auto-advancing chain
 *    runs under;
 *  - `AddStageField` — the name of a column that does not exist yet.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THREE SIT TOGETHER, AND WHY NONE OF THEM IS IN THE NODE BODY
 * ---------------------------------------------------------------------------
 *
 * All three are PER-SPACE: they live on the `spaces` row (or, for the add field, on
 * nothing until the command derives a slug) and they change no column. That is the
 * same partition the board's deleted stage dialog drew when it put them in a footer
 * beside the rows rather than inside one, and the panel keeps it for the same reason: a
 * per-Space setting shown inside a per-node form would be a second answer to "where do
 * I change this", and the person would look for it in the node they were just editing.
 *
 * They read together as one question — *what does this board do to a card on its own*
 * — which is why they are one body and not three loose controls: the Strict switch
 * decides whether a drag is BOUND, the guards decide how far an auto-advancing chain
 * runs once it starts, and the add field is how a step gets added to the graph at all.
 *
 * ---------------------------------------------------------------------------
 * THIS BODY ADDS NOTHING, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * It is a stack and a caption. The three subjects were moved WHOLE into this directory
 * by `git mv` and not rewritten, and they keep their own state, their own reads and
 * their own writes:
 *
 *  - `StrictWorkflowToggle` seeds from `getBoardStrict`, paints from the READ and not
 *    from the click, re-reads after the write because `setBoardStrict` captures its
 *    failure into `error` without rethrowing, and renders DISABLED while the flag is
 *    unread — because `false` would be a fact about the Space the panel invented, and a
 *    switch claiming Strict over a board whose drags are all accepted is exactly the
 *    disagreement `getBoardStrict` exists to prevent.
 *  - `AutoChainGuards` reads the pair on mount, keeps both fields INERT while it is
 *    unread (including after a FAILED read — a blank field over a Space that has a
 *    bound reads as "unset", and those are different answers), writes ONE call for the
 *    PAIR because the storage statement has no "keep what is there" arm, and refuses to
 *    be a `type="number"` field on the recorded grounds that `"abc"`, `"1."`, `"-"`,
 *    `"1e999"`, `"0x10"` and `"1,5"` all arrive at `onChange` as `""` — and `""` here is
 *    the CLEAR, so a number input would let a stray keystroke drop the Space's spend
 *    bound silently. A typed `0` is a bound, `null` is not configured, and the Clear
 *    button sends `null` twice.
 *
 * Both of those rules are pinned through this body in
 * `WorkflowSettingsBody.test.tsx`, which is where they live now that the board's stage
 * dialog is deleted — the assertions and the needles carried over from that dialog's
 * suite unchanged, only the mount differs. That file is where the `NULL` ≠ `0` arms, the
 * unparseable-text arm and the failed-read-leaves-it-disabled arm live.
 *
 * The caption below is the only new prose, and it exists because the panel's two modes
 * are easy to confuse from inside a form: it says what this screen is the settings FOR.
 */
export function WorkflowSettingsBody({
  spacePath,
}: {
  /** The Space whose `spaces` row the Strict flag and the guard pair live on.
   *  `string`, not `string | null` — the shell's early return makes a Spaceless mount
   *  unreachable, which is the same promise all three subjects are built on. */
  spacePath: string;
}): ReactElement {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid="workflow-settings-body"
    >
      <MutedCaption as="p" className="min-w-0">
        {/* Says which subject this form is editing, in the same breath as what Strict
            does — the panel swaps subjects on a click and the node body has no caption
            like this because its name is in the header. */}
        Nothing is selected, so these are the settings for the whole workflow. Pick a
        column to edit that column.
      </MutedCaption>

      <StrictWorkflowToggle spacePath={spacePath} />

      <AutoChainGuards spacePath={spacePath} />

      <AddStageField spacePath={spacePath} />
    </div>
  );
}
