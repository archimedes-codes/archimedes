import { useState } from "react";
import type { ReactElement } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useTasks } from "../../store/tasks";

/**
 * The **add a Stage** field (create) — the input-and-button pair in the workflow mode
 * of the canvas's settings panel, as its own subject.
 *
 * IT HAD TWO MOUNTS AND NOW HAS ONE. The other was the footer of the board's stage
 * dialog; that dialog is deleted, so `workflows/WorkflowSettingsBody.tsx` is its only
 * home. Adding a column is a workflow-level act and not a per-column one, which is why
 * the panel's workflow mode and not a node body is where it lives.
 *
 * One piece of state, `newLabel`, and nothing else in the panel reads it — the reason
 * it lifted whole. The write goes through the store like every other write the panel
 * makes (`store/tasks` owns the optimistic paint, the re-derivation and the revert), so
 * what lives here is the draft and the one call that commits it.
 *
 * WHY A COMPONENT AND NOT A WRAPPER ELEMENT: `CatalogSearchDialog`'s `children` are
 * SIBLINGS of the scroller and a level deeper would break the `parentElement` walk
 * its sibling dialogs' tests perform. A component boundary adds no element, so the
 * `<div>` below is the same node in the same position.
 *
 * `spacePath` is `string`, not `string | null` — the one mount that uses this field
 * (`NodeSettingsPanel`'s workflow mode) early-returns on a
 * `null` Space, which makes a Spaceless mount unreachable, so `addStage`'s guard is now
 * the type's job.
 */
export function AddStageField({ spacePath }: { spacePath: string }): ReactElement {
  const createStage = useTasks((s) => s.createStage);

  const [newLabel, setNewLabel] = useState("");

  const addStage = async (): Promise<void> => {
    const label = newLabel.trim();
    if (label === "") return;
    try {
      await createStage(spacePath, label);
      // Cleared only on success: a refused collision (T1 refuses rather than
      // inventing `spike-2`) is a refusal of the SLUG, and the label the user typed
      // is still what they want to name their column.
      setNewLabel("");
    } catch {
      // The draft stands; the store's line explains the collision.
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2 border-t border-card-border pt-3">
      <Input
        aria-label="New column label"
        className="min-w-0 flex-1"
        placeholder="New column label"
        value={newLabel}
        onChange={(event) => setNewLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void addStage();
        }}
      />
      {/* A column whose name is empty is a column nobody can rename by sight, so
          the affordance is inert until there is a name — `aria-disabled` because
          `Button` is a real `<button>` and the disabled PROPERTY would also be
          read here; the guard in `addStage` is the one that actually decides. */}
      <Button
        type="button"
        variant="outline"
        aria-label="Add column"
        className="shrink-0 gap-1"
        aria-disabled={newLabel.trim() === "" || undefined}
        onClick={() => void addStage()}
      >
        <PlusIcon className="size-3.5" />
        <span>Add column</span>
      </Button>
    </div>
  );
}
