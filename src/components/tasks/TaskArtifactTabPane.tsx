import { AgentMarkdown } from "../AgentMarkdown";
import { IpcErrorLine } from "../IpcErrorLine";
import { MutedCaption } from "../MutedCaption";
import { absoluteTimeFromInstant, relativeTimeFromInstant } from "../../lib/sessionTime";
import type { Artifact } from "../../lib/tauri";

export interface TaskArtifactTabPaneProps {
  artifactKey: string;
  /** `null` is in-flight OR "no such artifact" (an answer). Renders no document and no
   *  error for it. */
  artifact: Artifact | null;
  /** This pane's own read failure. */
  artifactError: string | null;
}

/**
 * The document for one Task artifact tab (the pane that the retired artifact rail used to hold).
 *
 * It has NO scroller and NO `overflow-*`: it lives inside the dialog's single
 * `detail-scroll`, and a second scroller here would be the nested scrollbar the whole
 * modal exists to remove.
 */
export function TaskArtifactTabPane({
  artifactKey,
  artifact,
  artifactError,
}: TaskArtifactTabPaneProps) {
  return (
    <div data-testid="artifact-pane" className="flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-border pb-2">
        <span
          data-testid="artifact-key-label"
          className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle"
        >
          {artifactKey}
        </span>
        {artifact !== null && (
          <MutedCaption
            data-testid="artifact-updated"
            className="shrink-0"
            title={absoluteTimeFromInstant(artifact.updatedAt)}
          >
            updated {relativeTimeFromInstant(artifact.updatedAt)}
          </MutedCaption>
        )}
      </div>
      {artifact !== null && (
        <div data-testid="artifact-body" className="text-ui-base text-foreground-subtle">
          <AgentMarkdown text={artifact.markdown} />
        </div>
      )}
      <IpcErrorLine error={artifactError} />
    </div>
  );
}
