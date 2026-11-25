import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { NodeDestinations } from "./NodeDestinations";

/**
 * The **destination list** of the node-settings panel — the three states of
 * `next_slugs`, the ordered chips, the reorder/remove writes, the add-`Select`'s
 * remount, and the fan-out sentence neither the dialog row nor the canvas node
 * ever said.
 *
 * ## WHY THIS FILE EXISTS SEPARATELY FROM THE PANEL'S SUITE
 *
 * The block has its own data (the ordered list) and its own two whole-list writes,
 * and it is the only part of the panel that renders markup in a `map`. It also
 * carries the repo's most-collapse-prone three-state rule (`null` / `[]` /
 * `["a","b"]`, ADR 0099) plus the new fan-out truth, so its cases are addressable
 * on their own instead of buried in a field-by-field suite.
 *
 * ## IT MOUNTS THE COMPONENT, NOT THE PANEL
 *
 * `NodeDestinations` takes its list and its two writes as props and reads no store
 * — the same shape `stages/StageDestinations.tsx` had, and the reason the writes
 * belong to the component that owns the slug. Mounting it directly pins everything
 * here with no store, catalog or dialog in the loop. Which body mounts for which
 * selection, the shared catalog fetch and the error line are `NodeSettingsPanel`'s
 * own suite; the writes end-to-end through the store are
 * `NodeSettingsBody.test.tsx`; that the candidate list excludes the column itself
 * is pinned there too, because the exclusion is the CALLER's fact — this component
 * renders the candidates it is handed, which is what one case below pins instead.
 *
 * ## THE NEEDLES ARE INHERITED, NOT REINVENTED
 *
 * `destination-state`, `destination-<slug>`, `Add a destination for <slug>`,
 * `Remove <label> from <slug>` and `Move <label> earlier in <slug>` are the
 * accessible names and testids the board's stage dialog pinned for its destination
 * block. Keeping them identical is what makes this a transfer of
 * behaviour rather than a rewrite — a renamed needle is where a pinned behaviour
 * hides. Only `destination-fanout` is new, because nothing said it before.
 */

const candidate = (slug: string) => ({
  slug,
  label: slug[0]!.toUpperCase() + slug.slice(1),
});

/** Every OTHER column of the Space, as the caller hands it over. */
const CANDIDATES = [candidate("doing"), candidate("done"), candidate("archive")];
const labelOf = (slug: string): string =>
  CANDIDATES.find((c) => c.slug === slug)?.label ?? slug;

function renderDestinations(
  destinations: string[] | null,
  headResolvable = true,
  impliedSlug: string | null = null,
) {
  const onWrite = vi.fn();
  const onAdd = vi.fn();
  const view = render(
    <NodeDestinations
      stageSlug="backlog"
      destinations={destinations}
      candidates={CANDIDATES}
      labelOf={labelOf}
      headResolvable={headResolvable}
      impliedSlug={impliedSlug}
      onWrite={onWrite}
      onAdd={onAdd}
    />,
  );
  /** Re-render with a NEW list — what the store's paint does upstream. The
   *  add-`Select`'s remount pin below needs this: the `key` is the current list, so
   *  a test that never changes the list cannot observe the remount. */
  const withDestinations = (next: string[] | null): void => {
    view.rerender(
      <NodeDestinations
        stageSlug="backlog"
        destinations={next}
        candidates={CANDIDATES}
        labelOf={labelOf}
        onWrite={onWrite}
        onAdd={onAdd}
      />,
    );
  };
  return { onWrite, onAdd, unmount: view.unmount, withDestinations };
}

const addTrigger = (): HTMLElement =>
  screen.getByRole("combobox", { name: "Add a destination for backlog" });

/** The chips only. `/^destination-/` would also catch `destination-state` and
 *  `destination-fanout`, and the dialog's own suite had no fan-out element to
 *  exclude — the lookahead keeps the inherited `destination-<slug>` needle intact
 *  while making this query mean "the chips". */
const chipText = (): string[] =>
  screen
    .getAllByTestId(/^destination-(?!state|fanout)/)
    .map((el) => el.textContent ?? "");

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the destination list — the three states of next_slugs (ADR 0099)", () => {
  it("says UNCONFIGURED for null, and names the fallback it implies", () => {
    renderDestinations(null);
    const state = screen.getByTestId("destination-state").textContent ?? "";
    expect(state).toContain("Unconfigured");
    // `null` is not "no edges" — it is "the column at sortOrder + 1", which is what
    // `nextStepSlugs` falls back to and what the canvas draws an edge for.
    expect(state).toContain("the column after this one");
  });

  it("NAMES the column the order implies, so the panel and the dashed wire agree", () => {
    // F1d, and the cheap version of it — the caption rather than a fourth chip. The canvas
    // draws a DASHED wire to a SPECIFIC column (`IMPLICIT_EDGE_CLASS` in
    // `workflowGraphLayout.ts`); a panel that said only "the column after this one" left
    // the two surfaces agreeing about the mechanism and disagreeing about the answer, which
    // is the same drift the `workflowEdgeWrite` extraction exists to prevent, one surface
    // over. Naming it also makes the no-op refusal legible: the sentence on screen is the
    // drop that is refused.
    //
    // A CAPTION AND NOT A CHIP, deliberately. A chip carries a remove button and a reorder
    // arrow, and neither applies to a column the row does not name — clicking remove on it
    // would have to write `[]`, which is CLOSING the column, not unlinking a destination.
    // An affordance whose verb is a lie is the dead-control shape this repo refuses, so the
    // fact is text and the chips stay the list.
    renderDestinations(null, true, "doing");
    const state = screen.getByTestId("destination-state").textContent ?? "";
    expect(state).toContain("Doing");
    expect(state).toContain("implied by the order");
    // And it is still ONE caption, not a chip: nothing may claim the implied column is a
    // stored destination.
    expect(screen.queryByTestId("destination-doing")).toBeNull();
  });

  it("does NOT name an implied column when the caller has none to name", () => {
    // The last column of a board has no `sortOrder + 1`, so `nextStepSlugs` answers `[]`
    // and the sentence must not invent a destination — the same rule that keeps the layout
    // from drawing an edge for it.
    renderDestinations(null, true, null);
    const state = screen.getByTestId("destination-state").textContent ?? "";
    expect(state).toContain("Unconfigured");
    expect(state).not.toContain("implied by the order");
  });

  it("does NOT name an implied column for [] or for a configured list", () => {
    // `[]` is CLOSED and `["x"]` is CONFIGURED — neither has a fallback, so neither gets a
    // sentence about one. Printing one for `[]` would manufacture the edge ADR 0099 exists
    // to keep deleted.
    const closed = renderDestinations([], true, "doing");
    expect(screen.getByTestId("destination-state").textContent).not.toContain(
      "implied by the order",
    );
    closed.unmount();
    renderDestinations(["done"], true, "doing");
    expect(screen.queryByText(/implied by the order/)).toBeNull();
  });

  it("says NOTHING MAY FOLLOW for [], which is never the null sentence", () => {
    renderDestinations([]);
    const state = screen.getByTestId("destination-state").textContent ?? "";
    expect(state).toContain("No destinations");
    // Collapsing `[]` into `null` tells the person their board is unconstrained when
    // they closed it on purpose, so the two sentences must not even share a substring.
    expect(state).not.toContain("Unconfigured");
  });

  it("shows the configured destinations in order, labelled by their column", () => {
    renderDestinations(["done", "doing"]);
    expect(chipText()).toEqual(["Done", "Doing"]);
  });

  it("labels an edge the columns cannot resolve with its slug, not nothing", () => {
    // A destination naming a column the read no longer holds is kept and shown by
    // its slug — `StageDestinations`' rule, inherited: dropping it would shrink the
    // workflow on screen, which is what `set_stage_next` refuses to write.
    renderDestinations(["ghost"]);
    expect(screen.getByTestId("destination-ghost").textContent).toBe("ghost");
  });
});

describe("the destination list — the two whole-list writes", () => {
  it("appends a destination picked from the candidates", () => {
    const { onAdd } = renderDestinations(["doing"]);
    fireEvent.click(addTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    expect(onAdd).toHaveBeenCalledWith("done");
  });

  it("offers exactly the candidates it was handed, one item each", async () => {
    // The self-loop exclusion is the CALLER's rule (`set_stage_next` refuses a
    // self-loop, so offering it would be a control that can only fail) and it is
    // pinned where the candidate list is built, in `NodeSettingsBody.test.tsx`.
    // What THIS component promises is that it adds nothing of its own to the list.
    renderDestinations(null);
    fireEvent.click(addTrigger());
    await screen.findByRole("option", { name: "Archive" });
    expect(
      screen
        .getAllByRole("option")
        .filter((el) => /^(Doing|Done|Archive|Backlog)$/.test(el.textContent ?? ""))
        .map((el) => el.textContent),
    ).toEqual(["Doing", "Done", "Archive"]);
  });

  it("removing a destination writes the remaining list in its own order", () => {
    const { onWrite } = renderDestinations(["doing", "done"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Doing from backlog" }),
    );
    expect(onWrite).toHaveBeenCalledWith(["done"]);
  });

  it("reordering keeps the FIRST entry the card's primary next step", () => {
    const { onWrite } = renderDestinations(["doing", "done"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Move Done earlier in backlog" }),
    );
    expect(onWrite).toHaveBeenCalledWith(["done", "doing"]);
  });

  it("the first chip has no earlier slot, and the affordance is inert rather than absent", () => {
    renderDestinations(["doing", "done"]);
    expect(
      (screen.getByRole("button", {
        name: "Move Doing earlier in backlog",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: "Move Done earlier in backlog",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("the add trigger reads `Add a destination` again after an append (a second pick is not a no-op)", () => {
    const { onAdd, withDestinations } = renderDestinations(["doing"]);
    expect(addTrigger().textContent).toBe("Add a destination");
    fireEvent.click(addTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    expect(onAdd).toHaveBeenCalledWith("done");
    // The store's paint is what hands the component the longer list, and the longer
    // list is what the `key` changes on. Without that key the UNCONTROLLED `Select`
    // keeps showing `Done`, and picking `doing` again is a silent no-op the person
    // reads as a broken control.
    withDestinations(["doing", "done"]);
    expect(addTrigger().textContent).toBe("Add a destination");
  });
});

describe("the destination list — the fan-out truth", () => {
  /* `next_slugs` is an ORDERED list and the auto-chain follows `[0]` ONLY:
   * `nextStepOf` in `src/lib/workflowGraph.ts` takes
   * `nextStepSlugs(columns, stage)[0]` and returns that one column. A card lives in
   * exactly one column, so a second destination is not a second parallel Session —
   * it is one followed edge and one the chain ignores. The panel therefore NAMES the
   * live edge rather than rendering two identical-looking wires. */

  it("names the followed edge and says the others are not followed", () => {
    renderDestinations(["doing", "done"]);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toContain("Follows Doing only");
    expect(fanout).toMatch(/Done is not followed/);
    // The wrong inference, refused in words: this is not a fork.
    expect(fanout).toMatch(/one column/);
  });

  it("names every unfollowed edge when a third joins", () => {
    renderDestinations(["doing", "done", "archive"]);
    expect(screen.getByTestId("destination-fanout").textContent).toMatch(
      /Done and Archive are not followed/,
    );
  });

  it("stays silent for one destination, for [] and for null", () => {
    const { unmount } = renderDestinations(["doing"]);
    expect(screen.queryByTestId("destination-fanout")).toBeNull();
    unmount();
    renderDestinations([]);
    expect(screen.queryByTestId("destination-fanout")).toBeNull();
    unmount();
    renderDestinations(null);
    expect(screen.queryByTestId("destination-fanout")).toBeNull();
  });

  it("says the chain follows NOTHING when the head names a column the read cannot resolve", () => {
    // The ghost case, on the panel's side. `workflowGraphLayout` draws a `missing`
    // node for such an edge and `nextStepOf` yields NOTHING for it — an unresolvable
    // head has no column to launch — so the sentence must not promise a live hop.
    // `headResolvable` is the caller's answer, not a guess this component makes.
    renderDestinations(["ghost", "done"], false);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toContain("Follows ghost only");
    expect(fanout).toMatch(/no column this read can resolve/);
    expect(fanout).toMatch(/follows nothing here/);
  });

  it("does NOT claim a dead chain for a column whose label equals its own slug", () => {
    // The false positive `headResolvable` exists to refuse. `createStage` derives
    // `done` / `done` from a lowercase label, so a component that inferred staleness
    // from `labelOf(head) === head` would tell a correctly-configured owner their
    // chain is dead. Rendered with an IDENTITY `labelOf` — exactly what such a column
    // produces — and `headResolvable` left at its `true` default, because the caller
    // CAN resolve it.
    render(
      <NodeDestinations
        stageSlug="backlog"
        destinations={["done", "archive"]}
        candidates={CANDIDATES}
        labelOf={(slug) => slug}
        onWrite={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toContain("Follows done only");
    expect(fanout).not.toMatch(/follows nothing/);
  });
});
