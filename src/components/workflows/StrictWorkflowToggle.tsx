import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { MutedCaption } from "../MutedCaption";
import { Switch } from "../ui/switch";
import { useTasks } from "../../store/tasks";

/**
 * The Space-level **Strict workflow** opt-in (ADR 0099) — the Switch in the
 * workflow mode of the canvas's settings panel, as its own subject.
 *
 * IT HAD TWO MOUNTS AND NOW HAS ONE. The other was the footer of the board's stage
 * dialog, which used to sit behind the board's `Configure` door. The panel took these
 * per-Space fields over from that dialog and the dialog has since been deleted, so the
 * duplication the paragraph below used to describe is over: `spacePath` is read by one
 * surface, through `workflows/WorkflowSettingsBody.tsx`, and `getBoardStrict` /
 * `setBoardStrict` still have exactly one owner.
 *
 * This component owns exactly ONE piece of state, `strict`, and nothing else in the
 * panel reads it — which is why it could be lifted whole. It is a move, not a redesign:
 * the Switch, the read, the write and the re-read are what the dialog rendered before,
 * carried here with the comments that explain them.
 *
 * WHY A COMPONENT AND NOT A WRAPPER ELEMENT. `CatalogSearchDialog` renders its
 * `children` as SIBLINGS of the scroller, and its header records that a level
 * deeper would break the `parentElement` walk two of the sibling dialogs' tests
 * perform. A React component boundary adds NO DOM element, so this file replaces
 * the inline `<div>` one-for-one; a shared footer `<div>` around it would have been
 * a real regression dressed up as a refactor.
 *
 * `spacePath` is `string`, not `string | null`. The one mount — `NodeSettingsPanel`'s
 * workflow mode — carries its own `if (spacePath === null) return null` early
 * return, so this is never mounted without a target and the guards the moved callbacks
 * carried are gone: the type says what the guards used to check.
 */
export function StrictWorkflowToggle({
  spacePath,
}: {
  spacePath: string;
}): ReactElement {
  const setBoardStrict = useTasks((s) => s.setBoardStrict);
  const getBoardStrict = useTasks((s) => s.getBoardStrict);

  /** `null` = NOT KNOWN (the read is in flight, or it failed). See `readStrict`. */
  const [strict, setStrict] = useState<boolean | null>(null);

  /** Read the Strict flag. `null` on failure, deliberately: `false` is a FACT about
   *  the Space and a swallowed read must not hand the Switch that fact as its
   *  default, because the whole point of reading the flag (rather than defaulting
   *  it) is that the Switch must show the SAME value `moveTask` enforces. A Switch
   *  claiming Strict over a board whose drags are all accepted is the failure
   *  `getBoardStrict`'s own doc says it exists to prevent — so an unread flag
   *  renders the Switch DISABLED, which is the one state that is not a guess. */
  const readStrict = useCallback((): void => {
    void getBoardStrict(spacePath).then(
      (value) => setStrict(value),
      // The store already wrote the sentence into `error`; the `null` keeps the
      // Switch inert. No second console line and no throw out of a mount effect.
      () => setStrict(null),
    );
  }, [spacePath, getBoardStrict]);

  useEffect(() => {
    setStrict(null);
    readStrict();
  }, [spacePath, readStrict]);

  const toggleStrict = async (next: boolean): Promise<void> => {
    // Paint from the READ, never from the click: the click is a request and the
    // write can be refused, and this Switch is the one control in this dialog that
    // claims something about what a DRAG will do.
    setStrict(next);
    await setBoardStrict(spacePath, next);
    // Re-read rather than trust the paint: the store's `setBoardStrict` captures
    // its failure into `error` and does not rethrow (the `moveTask` shape), so
    // without this the Switch would keep showing a value the Space refused.
    readStrict();
  };

  return (
    <div className="flex min-w-0 items-center justify-between gap-2 border-t border-card-border pt-3">
      <div className="flex min-w-0 items-center gap-2">
        <Switch
          checked={strict ?? false}
          // Inert while the flag is unread — see `readStrict`. Radix puts the
          // inert half on the `disabled` PROPERTY (there is no `aria-disabled`).
          disabled={strict === null}
          aria-label="Strict workflow"
          onCheckedChange={(checked) => void toggleStrict(checked)}
        />
        <span className="min-w-0 text-ui-sm text-foreground-subtle">
          Strict workflow
        </span>
      </div>
      <MutedCaption>
        {strict
          ? "Only the columns a Stage points at can receive a card"
          : "Any column can receive a card"}
      </MutedCaption>
    </div>
  );
}
