import { MutedCaption } from "../MutedCaption";

/**
 * One field's SOURCE LABEL (ADR 0068: every field prints the layer that supplied
 * it). A component rather than an interpolated sentence so the label is its own
 * findable node — a test (and a screen reader) can point at it — and so no column
 * header can accidentally satisfy a query for one of the three words.
 */
export function LayerTag({ children }: { children: string }) {
  return <MutedCaption className="shrink-0 rounded bg-input px-1">{children}</MutedCaption>;
}
