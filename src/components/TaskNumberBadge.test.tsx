import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TaskNumberBadge } from "./TaskNumberBadge";

/**
 * `TaskNumberBadge` — the **Task badge** (`T12`) the Session list, the Side pane,
 * Settings and a board card all carry (spec D5/D6/D7, fill per D13).
 *
 * Three answers, and each is a DIFFERENT question, so each is asserted on its own:
 *
 *  - the TEXT is the number and nothing else (`"T12"`), because the badge sits
 *    INSIDE the masked title span of a row whose `textContent` is pinned for
 *    equality elsewhere — the badge's own text is the only text it contributes;
 *  - the TOOLTIP carries the Stage, and it is the STAGE SLUG rather than a label
 *    (the payload only carries `task_sessions.stage_slug`; see the component's
 *    docblock) — `null` stage answers with the bare `Task T12`, NOT with a
 *    dangling em dash;
 *  - `null` renders NOTHING — not an empty element. An empty element would eat a
 *    flex `gap` slot and, on the **Side pane**, turn a two-child column into
 *    three, which is pinned there.
 */

describe("TaskNumberBadge — the Task badge", () => {
  it("renders the number as T{n} and carries the Stage slug in the tooltip", () => {
    const { container } = render(
      <TaskNumberBadge badge={{ number: 12, stageSlug: "research" }} />,
    );
    const badge = container.firstChild as HTMLElement;
    // The text, EXACTLY. A `Task 12` or a `#12` here would read as a different
    // object than the board's `T{n}` pill it is meant to agree with.
    expect(badge.textContent).toBe("T12");
    // THE STAGE SLUG, not a label — the frozen slug at link time (D12). This is
    // the assertion that fails if someone resolves a label through the board
    // store, which is the stale/unloaded source D4 rejected.
    expect(badge.getAttribute("title")).toBe("Task T12 — started in research");
  });

  it("a badge with no Stage says Task T{n} and nothing after it", () => {
    // The linked row's `stage_slug` is NULLABLE in the payload, so this arm is
    // reachable and not defensive. The competing answer is a template that
    // appends the separator unconditionally — `"Task T12 — started in "` — which
    // is a tooltip that reads as a bug.
    const { container } = render(
      <TaskNumberBadge badge={{ number: 12, stageSlug: null }} />,
    );
    const badge = container.firstChild as HTMLElement;
    expect(badge.textContent).toBe("T12");
    expect(badge.getAttribute("title")).toBe("Task T12");
  });

  it("renders NOTHING for a null badge (no node, so no gap, no third child)", () => {
    // `container.firstChild` is null rather than the render being merely
    // text-free: an empty <span> would satisfy a textContent check and still
    // cost a flex gap in the Session row and a third child in the Side pane.
    const { container } = render(<TaskNumberBadge badge={null} />);
    expect(container.firstChild).toBeNull();
    expect(container.childNodes).toHaveLength(0);
  });

  it("wears the overlay fill and the mono small type, and nothing absolute", () => {
    // The rendered class list, so the gate cannot be satisfied by a literal that
    // the component no longer applies. `bg-surface` is the alpha OVERLAY;
    // `bg-background` is the ABSOLUTE page step, which the Session row's own
    // `bg-frame` chrome IS — measured contrast 1.00 in three dark palettes. The
    // source-level census lives in `slabFloatSeparation.test.ts`; this is the
    // render-side half of the same rule.
    const { container } = render(
      <TaskNumberBadge badge={{ number: 3, stageSlug: null }} />,
    );
    const tokens = (container.firstChild as HTMLElement).className.split(/\s+/);
    expect(tokens).toContain("bg-surface");
    expect(tokens).not.toContain("bg-background");
    expect(tokens).toContain("rounded-full");
    expect(tokens).toContain("font-mono");
    expect(tokens).toContain("text-ui-xs");
    expect(tokens).toContain("text-foreground-subtle");
    // `subtle`, not `subtlest`: `mutedCaption.test.ts` allow-lists the adjacent
    // pair `text-ui-xs text-foreground-subtlest` to `MutedCaption.tsx` alone.
    expect(tokens).not.toContain("text-foreground-subtlest");
    // The badge sits inside a span with no `gap` of its own, so it carries its
    // own right margin.
    expect(tokens).toContain("mr-1");
  });
});
