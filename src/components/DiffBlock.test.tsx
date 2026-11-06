import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import DiffBlock, { diffBlockRenderCount } from "./DiffBlock";

/**
 * Memoization regression (issue #155): `DiffBlock` renders a unified patch by
 * splitting it and mapping every line, and it sits inside the tool-card render
 * path — the one place a streaming turn re-renders a card whose patch has NOT
 * changed. `memo(DiffBlock)` is the only tool-card memo with unconditionally
 * correct value semantics: both props are strings, so the shallow compare is a
 * value compare (`ChangesGroupCard.messages`, `FileSummaryCard.diffs` and
 * `ToolCallCardHeader.onToggle` all receive a fresh reference per render, which
 * is why a memo THERE bails every single time and is a no-op).
 *
 * Why this measures renders instead of DOM: `DiffBlock` is a leaf — its subtree
 * is DOM only, no component child to mock (the `SessionConfigSelect.memo.test.tsx`
 * trick counts `ModelPicker`, a real child), a `memo()`'d default export is an
 * object so vitest's autospy never wraps it, and a `<Profiler onRender>` commit
 * cannot distinguish a bailout from an identical re-render. The render function
 * RUNNING is the only deterministic signal, hence the module-scoped counter.
 *
 * Every assertion is RELATIVE to a captured `before` — the counter is a
 * module global and persists across the blocks in this file, so an absolute
 * assert would leak between them.
 */

/** A plain parent whose re-render simulates a streaming/unrelated
 *  re-render of a tool card: the parent turns, DiffBlock keeps the SAME
 *  path/patch values. Strings compare by value, so the memo's shallow
 *  compare bails and the body — and the counter — are skipped. */
function TurningParent() {
  const [, setTick] = useState(0);
  return (
    <div>
      <button onClick={() => setTick((t) => t + 1)}>re-render</button>
      <DiffBlock path="/a.ts" patch={"+x\n-y"} />
    </div>
  );
}

describe("DiffBlock memoization", () => {
  it("does not re-render when the parent re-renders with identical props", () => {
    render(<TurningParent />);
    const before = diffBlockRenderCount();
    fireEvent.click(screen.getByRole("button", { name: "re-render" }));
    fireEvent.click(screen.getByRole("button", { name: "re-render" }));
    // The memo must skip: identical string props → render body (and the
    // counter) untouched. FAILS without `export default memo(DiffBlock)`.
    expect(diffBlockRenderCount()).toBe(before);
  });

  it("still re-renders when the patch changes (memo must not swallow real updates)", () => {
    const { rerender } = render(<DiffBlock path="/a.ts" patch="+x" />);
    const before = diffBlockRenderCount();
    rerender(<DiffBlock path="/a.ts" patch="+y" />);
    expect(diffBlockRenderCount()).toBe(before + 1);
  });
});
