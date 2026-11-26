import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { NodeDestinations } from "./NodeDestinations";
import { EDGE_OUTCOME_SUGGESTIONS } from "../../lib/workflowEdgeWrite";

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
  outcomes: (string | null)[] | null = null,
) {
  const onWrite = vi.fn();
  const onAdd = vi.fn();
  const view = render(
    <NodeDestinations
      stageSlug="backlog"
      destinations={destinations}
      outcomes={outcomes}
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

/** The chips' DESTINATION NAMES, in chip order — the label span of each chip and nothing
 *  else.
 *
 *  The label span has its own needle (`destination-label-<slug>[:<name>]`) precisely
 *  because the name-`Select` now lives INSIDE the chip span: reading a chip's whole
 *  `textContent` returns `"Doingo name"` — the trigger's text rides along — so an order
 *  assertion built on the container would be asserting on a widget's placeholder rather
 *  than on a destination. `NodeSettingsBody.test.tsx` reads the same needle for the same
 *  reason.
 *
 *  The chip CONTAINER (`destination-<slug>[:<name>]`) remains what a test selects to make
 *  a claim about a chip as a whole — uniqueness, presence, a name in the needle. */
const chipText = (): string[] =>
  screen.getAllByTestId(/^destination-label-/).map((el) => el.textContent ?? "");

/** The NAME each chip carries, in chip order — `null` for an unnamed edge. Read off the
 *  chip container's needle, which is where the component puts the name. */
const chipNames = (): (string | null)[] =>
  screen
    .getAllByTestId(/^destination-(?!state|fanout|label)/)
    .map((el) => {
      const id = el.getAttribute("data-testid") ?? "";
      const at = id.indexOf(":");
      return at === -1 ? null : id.slice(at + 1);
    });

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
    expect(screen.getByTestId("destination-label-ghost").textContent).toBe("ghost");
  });
});

describe("the destination list — the two whole-list writes", () => {
  it("appends a destination picked from the candidates", () => {
    const { onAdd } = renderDestinations(["doing"]);
    fireEvent.click(addTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    expect(onAdd).toHaveBeenCalledWith("done", null);
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
    expect(onWrite).toHaveBeenCalledWith(["done"], [null]);
  });

  it("reordering keeps the FIRST entry the card's primary next step", () => {
    const { onWrite } = renderDestinations(["doing", "done"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Move Done earlier in backlog" }),
    );
    expect(onWrite).toHaveBeenCalledWith(["done", "doing"], [null, null]);
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
    expect(onAdd).toHaveBeenCalledWith("done", null);
    // The store's paint is what hands the component the longer list, and the longer
    // list is what the `key` changes on. Without that key the UNCONTROLLED `Select`
    // keeps showing `Done`, and picking `doing` again is a silent no-op the person
    // reads as a broken control.
    withDestinations(["doing", "done"]);
    expect(addTrigger().textContent).toBe("Add a destination");
  });
});

describe("the destination list — the fan-out truth", () => {
  /* `next_slugs` is an ORDERED list and, until the edge name landed, the auto-chain
   * followed `[0]` and NOTHING else: `nextStepOf` takes `nextStepSlugs(…)[0]`. A card
   * lives in exactly one column, so a second destination was one followed edge and one
   * the chain ignored, and the panel said so out loud.
   *
   * `next_outcomes` (D6/D13) changes what that sentence may claim. `advise.rs` now takes
   * "the FIRST edge whose label is the outcome the `mark_done` claim named", falling back
   * to the head when nothing matches — so a labelled non-head edge IS followed, on a
   * claim that names it. The old sentence's tail ("`<others>` are not followed") is false
   * the moment any edge carries a name, and a corrected UI beside an uncorrected sentence
   * is the citation-drift failure `docs/features/session-ready-marker.md` documents.
   *
   * What does NOT change is the count of edges that fire: still exactly ONE per claim,
   * because `tasks.stage_slug` holds one value and `idx_workflow_runs_open` is a partial
   * UNIQUE index. Routing is a CHOICE between edges, not a fork, and every sentence below
   * keeps that distinction in its own words. */

  it("says the tail is NOT followed when no edge carries a name — the unchanged sentence", () => {
    // THE "IDENTICAL TO TODAY" PIN for this caption, and the reason the labelled text is
    // a SEPARATE branch rather than a rewrite: an unlabelled board is every board that
    // exists today (`next_outcomes` has no SQL DEFAULT and is never backfilled), and its
    // sentence must be the one it has always printed.
    renderDestinations(["doing", "done"]);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toContain("Follows Doing only");
    expect(fanout).toMatch(/Done is not followed/);
    // The wrong inference, refused in words: this is not a fork.
    expect(fanout).toMatch(/one column/);
    // And the labelled wording must NOT leak into the unlabelled case.
    expect(fanout).not.toMatch(/names an edge|claim/);
  });

  it("names every unfollowed edge when a third joins, with none of them labelled", () => {
    renderDestinations(["doing", "done", "archive"]);
    expect(screen.getByTestId("destination-fanout").textContent).toMatch(
      /Done and Archive are not followed/,
    );
  });

  it("says a labelled non-head edge IS followed when a claim names it", () => {
    // THE SENTENCE THAT WENT FALSE, corrected. `done` is at index 1 — the position the
    // old text filed under "not followed" — and it now carries `success`, so a
    // `mark_done` claim naming `success` advances the card there. Printing the old
    // sentence beside that chip would be a panel contradicting its own chips.
    renderDestinations(["doing", "done"], true, null, [null, "success"]);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toContain("Follows Doing unless a claim names an edge");
    expect(fanout).toMatch(/Done \(success\) fires when a claim names success/);
    // The OLD claim, gone: `done` is no longer merely a permission.
    expect(fanout).not.toMatch(/is not followed/);
  });

  it("says exactly ONE edge fires per claim, so a named fan-out is still not a fork", () => {
    // The half of the old sentence that is still TRUE and must survive the rewrite: one
    // `stage_slug` per card and one open `workflow_runs` row per card. Routing picks a
    // door; it does not open two.
    renderDestinations(["done", "doing"], true, null, ["failed", "success"]);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toMatch(/exactly one edge fires/);
    expect(fanout).toMatch(/not several parallel runs/);
    expect(fanout).toMatch(/Done \(failed\) and Doing \(success\) fire when a claim names them/);
  });

  it("earns its place at ONE destination when that edge carries a name", () => {
    // The `length > 1` gate is right for an unlabelled list and wrong for a labelled one:
    // with a name on the only edge there IS something to disambiguate — the person who
    // just typed a name believes they configured routing. And the true thing to say is
    // that they did not: with one edge, a matching claim and a non-matching claim both
    // land on that same edge (`advise.rs` falls back to the head), so the name changes
    // nothing. A panel that stayed silent here let them keep believing otherwise.
    renderDestinations(["done"], true, null, ["failed"]);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toMatch(/names the only edge/);
    expect(fanout).toMatch(/changes nothing/);
  });

  it("still says the chain follows NOTHING when a single NAMED edge is a ghost", () => {
    // THE CLAUSE SURVIVES THE NEW BRANCH. "A claim that names it and a claim that names
    // nothing both take it" is only true of an edge that leads somewhere: `nextStepOf`
    // yields NOTHING for a slug this read cannot resolve, so a named edge to a ghost is
    // not a door at all. A one-edge branch that returned early without consulting
    // `headResolvable` would print a confident sentence about a hop the runtime refuses to
    // take — the same invention the two-edge ghost case exists to refuse.
    renderDestinations(["ghost"], false, null, ["failed"]);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    // Case-insensitive deliberately: in the two-edge branch this clause continues a
    // sentence ("… and no column this read can resolve …") and here it STARTS one, so a
    // case-sensitive pin would be pinning the punctuation of a neighbouring clause.
    expect(fanout).toMatch(/no column this read can resolve/i);
    expect(fanout).toMatch(/follows nothing here/i);
    // And the name's own sentence is still there beside it — the two claims are
    // independent, so both print.
    expect(fanout).toMatch(/changes nothing/);
  });

  it("stays silent for one UNNAMED destination, for [] and for null", () => {
    const { unmount } = renderDestinations(["doing"]);
    expect(screen.queryByTestId("destination-fanout")).toBeNull();
    unmount();
    renderDestinations(["doing"], true, null, [null]);
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
    //
    // It stays the HEAD's clause even once the tail is labelled: a tail that routes on a
    // claim does not make an unresolvable head live, so the two clauses are independent
    // and both print.
    renderDestinations(["ghost", "done"], false, null, [null, "success"]);
    const fanout = screen.getByTestId("destination-fanout").textContent ?? "";
    expect(fanout).toContain("Follows ghost");
    expect(fanout).toMatch(/no column this read can resolve/i);
    expect(fanout).toMatch(/follows nothing here/i);
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

describe("the destination list — naming an edge (D6/D13)", () => {
  /* An outcome is an OPTIONAL LABEL on an outgoing edge, and until a person can type one
   * D6's routing is unreachable: `mark_done` can name a transition all day and `advise.rs`
   * will find no edge carrying it and fall back to the head. So this is the deliverable
   * the done-when rests on, not a decoration on the chip row.
   *
   * The vocabulary is `EDGE_OUTCOME_SUGGESTIONS` — a mirror of the enum `mark_done`
   * advertises in `specs.rs`. It is a SUGGESTION and not a validator: `next_outcomes` has
   * no `CHECK` and `set_stage_next` validates labels against nothing, so a name outside
   * the list still writes and still routes. That is why the list is imported from the one
   * module that owns the edge write rather than typed out here a second time. */

  it("offers every edge a name control, and it reads `no name` when the edge carries none", () => {
    renderDestinations(["doing", "done"]);
    expect(
      screen.getByRole("combobox", {
        name: "Name the edge to Doing from backlog",
      }).textContent,
    ).toBe("no name");
    expect(
      screen.getByRole("combobox", {
        name: "Name the edge to Done from backlog",
      }).textContent,
    ).toBe("no name");
  });

  it("shows the name the edge already carries", () => {
    renderDestinations(["doing", "done"], true, null, [null, "handoff"]);
    expect(
      screen.getByRole("combobox", {
        name: "Name the edge to Done from backlog",
      }).textContent,
    ).toContain("handoff");
  });

  it("writes the WHOLE positional list when one edge is named, leaving the other slots alone", async () => {
    // A whole-list write, because that is the shape `set_stage_next` takes — and the
    // positional rule makes it dangerous: `outcomes[i]` names `slugs[i]`, so a write that
    // sent `["handoff"]` for the second edge would either mismatch the length (the
    // `EdgeOutcomeCount` refusal) or shift `failed` off the edge it belongs to. A shifted
    // label is a card that advances on the wrong claim, invisibly.
    const { onWrite } = renderDestinations(["doing", "done"], true, null, ["failed", null]);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Name the edge to Done from backlog" }),
    );
    await screen.findByRole("option", { name: "handoff" });
    fireEvent.click(screen.getByRole("option", { name: "handoff" }));
    expect(onWrite).toHaveBeenCalledWith(["doing", "done"], ["failed", "handoff"]);
  });

  it("clears a name back to `no name`, which is null and NOT the empty string", async () => {
    // `null` is the only spelling of "this edge carries no label". `""` would be a label
    // that renders as nothing — the `promptPrefix` `""`-vs-`null` defect, one column over,
    // and here it would also be a label no claim can name because the enum has no `""`.
    const { onWrite } = renderDestinations(["doing"], true, null, ["failed"]);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Name the edge to Doing from backlog" }),
    );
    await screen.findByRole("option", { name: "no name" });
    fireEvent.click(screen.getByRole("option", { name: "no name" }));
    expect(onWrite).toHaveBeenCalledWith(["doing"], [null]);
  });

  it("offers exactly the names mark_done advertises, plus `no name`", async () => {
    // Compared as a SET and as the enum's own membership, because a picker offering a name
    // the tool cannot send is a control that can only fail. `ready` is the measured case:
    // it is illegal in `specs.rs` (it contains `read`) and must not appear here.
    renderDestinations(["doing"]);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Name the edge to Doing from backlog" }),
    );
    await screen.findByRole("option", { name: "handoff" });
    const offered = screen
      .getAllByRole("option")
      .map((el) => el.textContent ?? "");
    expect(offered.sort()).toEqual(
      ["no name", ...EDGE_OUTCOME_SUGGESTIONS].sort(),
    );
    expect(offered).not.toContain("ready");
    expect(offered).not.toContain("review");
  });

  it("keys a labelled chip apart from an unlabelled one to the SAME destination", () => {
    // The testid hazard. `destination-${slug}` was unique because a destination could only
    // appear once; `["done","done"]` labelled `failed`/`success` is legal data now, and two
    // spans sharing a testid means a test — or a person using an assistive tech that reads
    // the DOM structure — cannot tell which edge it is looking at. The name joins the
    // needle exactly where it joins `edgeIdOf` on the canvas, so both surfaces name an
    // edge the same way.
    renderDestinations(["done", "done"], true, null, ["failed", "success"]);
    expect(screen.getByTestId("destination-done:failed")).toBeTruthy();
    expect(screen.getByTestId("destination-done:success")).toBeTruthy();
    expect(screen.getAllByTestId(/^destination-done/)).toHaveLength(2);
  });

  it("keeps `destination-<slug>` for an UNLABELLED edge — the inherited needle survives", () => {
    // Every existing case in this file and in `NodeSettingsBody.test.tsx` selects
    // `destination-${slug}`. Those needles staying put is the panel-side half of "an
    // unlabelled board is identical to today".
    renderDestinations(["ghost"]);
    expect(screen.getByTestId("destination-label-ghost").textContent).toBe("ghost");
    expect(screen.queryByTestId("destination-ghost:null")).toBeNull();
    // And the chip really is UNNAMED rather than named something that reads as blank.
    expect(chipNames()).toEqual([null]);
  });

  it("removes one edge of a labelled pair and keeps the other's name", async () => {
    // Removing an edge is a whole-list write of BOTH columns, and the survivor's label has
    // to ride along in the same call. Dropping index 0 shifts index 1 down by one, so the
    // outcomes list must be filtered by the SAME predicate or `success` lands on the wrong
    // edge — the shift `EdgeOutcomeCount` cannot see, because the lengths still agree.
    const { onWrite } = renderDestinations(["done", "doing"], true, null, ["failed", "success"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Done from backlog" }));
    expect(onWrite).toHaveBeenCalledWith(["doing"], ["success"]);
  });

  it("reorders a labelled pair with its names, so the head's label stays the head's", async () => {
    // Reordering `next_slugs` without reordering `next_outcomes` is the same shift defect
    // wearing a different gesture: the head is the edge a claim that names nothing takes,
    // so swapping the slugs and not the labels swaps which name the head carries.
    const { onWrite } = renderDestinations(["done", "doing"], true, null, ["failed", "success"]);
    fireEvent.click(screen.getByRole("button", { name: "Move Doing earlier in backlog" }));
    expect(onWrite).toHaveBeenCalledWith(["doing", "done"], ["success", "failed"]);
  });
});

describe("the destination list — naming the edge a NEW destination gets", () => {
  /* A drag-to-connect can carry a name (the canvas writes `null` — a pointer gesture has
   * no keyboard in it), but the panel is where a person actually composes a routing table,
   * and two of its edges to one destination is the shape they want: `done` on `failed` and
   * `done` on `success`. The add-`Select` therefore needs a name to add WITH, or the rule
   * refuses the second `done` (an unnamed duplicate) and the picker never offers it. */

  it("carries the chosen name into the add, so a second edge to one destination is reachable", async () => {
    const { onAdd } = renderDestinations(["done"]);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Name for a new edge from backlog" }),
    );
    await screen.findByRole("option", { name: "success" });
    fireEvent.click(screen.getByRole("option", { name: "success" }));
    fireEvent.click(addTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Doing" }));
    expect(onAdd).toHaveBeenCalledWith("doing", "success");
  });

  it("adds with a null name when no name was picked — the ordinary case", async () => {
    const { onAdd } = renderDestinations(["done"]);
    fireEvent.click(addTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Doing" }));
    expect(onAdd).toHaveBeenCalledWith("doing", null);
  });

  it("reports the picked name upward, so the caller can widen its candidate set with it", async () => {
    // THE REASON THERE IS A CALLBACK AT ALL. `canConnectStages` refuses an unnamed edge
    // onto a destination the list already holds and ALLOWS a named one, so WHICH OPTIONS
    // ARE LEGAL depends on the name about to be added. A caller that computed its option
    // set with `outcome = null` would never offer the second edge to one destination,
    // however the name control read — a control that cannot be reached is the
    // dead-control shape this repo refuses.
    //
    // The pick is OWNED HERE (the panel's own rule: "the drafts live here and die here")
    // and the callback is one-directional, so this case asserts the REPORT and not a
    // mirrored prop: a component that took the name back down as a prop would have two
    // owners of one draft and could write a label the trigger never showed.
    const onPending = vi.fn();
    render(
      <NodeDestinations
        stageSlug="backlog"
        destinations={["done"]}
        candidates={CANDIDATES}
        labelOf={labelOf}
        onPendingOutcomeChange={onPending}
        onWrite={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Name for a new edge from backlog" }),
    );
    await screen.findByRole("option", { name: "success" });
    fireEvent.click(screen.getByRole("option", { name: "success" }));
    expect(onPending).toHaveBeenCalledWith("success");
    // And the trigger says so — the name the payload will carry is the name on screen.
    expect(
      screen.getByRole("combobox", { name: "Name for a new edge from backlog" })
        .textContent,
    ).toContain("success");
  });

  it("reads `no name` on the add control by default", () => {
    renderDestinations(["done"]);
    expect(
      screen.getByRole("combobox", { name: "Name for a new edge from backlog" })
        .textContent,
    ).toBe("no name");
  });
});

