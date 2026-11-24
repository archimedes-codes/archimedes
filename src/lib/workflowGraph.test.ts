import { describe, expect, it } from "vitest";

import { nextStepOf, nextStepSlugs } from "./workflowGraph";
import type { StageDto, StageWithTasks } from "./tauri";

/**
 * `src/lib/workflowGraph.ts` — the ONE derivation of "where does a card in this
 * column go next".
 *
 * ## Why this file is the proof and not the components' own suites
 *
 * The derivation used to be spelled twice: `nextStepOf` in `TasksBoard.tsx` (the
 * card's launch pill) and `edges` in `TaskDetailDialog.tsx` (the modal's buttons).
 * `TasksBoard.tsx`'s comment said so out loud — "spelled twice rather than hoisted
 * into `lib/` … If a third surface grows the same need, that helper is the
 * extraction to make" — and the auto-advance runtime is that third surface, so the
 * extraction happened. THIS file is what the extraction is now pinned by; the two
 * components' own suites are the proof the extraction did not change what they
 * render, and they were NOT edited to make this pass.
 *
 * ## The four cases, and the one that must never collapse
 *
 * `stages.next_slugs` holds three distinct answers and the whole file is about
 * keeping them distinct (ADR 0099):
 *
 *  - `["a", "b"]` — configured. The row's OWN order, first entry is the primary.
 *  - `null`       — UNCONFIGURED: unconstrained, so fall back to the column at
 *                   `sortOrder + 1`, which is what keeps a launch button alive on
 *                   every board that predates the graph.
 *  - `[]`         — configured, and it LEADS NOWHERE. This is a decision a person
 *                   made, and it must yield NOTHING. `nextSlugs ?? fallback` gets
 *                   this right; `nextSlugs || fallback` silently converts "stop
 *                   here" into "go to the next column", which is an automation
 *                   nobody configured — the mutation this file exists to catch.
 *
 * And a fourth, on the resolution rather than the slug list: an edge naming a slug
 * the columns do not hold. `nextStepSlugs` still reports the slug (the detail
 * modal renders that edge and its skipped-column NOTE is the surface that explains
 * the stale read), and `nextStepOf` yields NOTHING (a pill has no note to fall back
 * on — it would be a control whose click moves nothing).
 */

/** A `StageDto` with the seeded defaults, so a case states only what it varies. */
function stage(overrides: Partial<StageDto> = {}): StageDto {
  return {
    spacePath: "/w/alpha",
    slug: "backlog",
    label: "Backlog",
    sortOrder: 0,
    onEnter: "none",
    onEnterSkill: null,
    nextSlugs: null,
    auto: false,
    promptPrefix: null,
    ...overrides,
  };
}

/** The board shape the derivation reads — a column with no cards is enough. */
function column(overrides: Partial<StageDto> = {}): StageWithTasks {
  return { stage: stage(overrides), tasks: [] };
}

/** The four-column board the components' fixtures use, `sortOrder` 0..3. */
function board(
  over: Record<string, Partial<StageDto>> = {},
): StageWithTasks[] {
  return [
    column({ slug: "backlog", label: "Backlog", sortOrder: 0, ...over.backlog }),
    column({ slug: "research", label: "Research", sortOrder: 1, ...over.research }),
    column({ slug: "doing", label: "Doing", sortOrder: 2, ...over.doing }),
    column({ slug: "done", label: "Done", sortOrder: 3, ...over.done }),
  ];
}

/** A Skill-bearing column, spelled through the real field name. */
function withSkill(name: string): Partial<StageDto> {
  return { onEnterSkill: name };
}

describe("nextStepSlugs — the graph's slug list", () => {
  it("reads the configured edges in the ROW'S order, not re-sorted", () => {
    // The author of the row decided this order (spec §7.1); re-sorting it here
    // would put a second opinion on a fact the data already carries.
    const columns = board({ backlog: { nextSlugs: ["done", "research"] } });
    expect(nextStepSlugs(columns, columns[0]!.stage)).toEqual(["done", "research"]);
  });

  it("falls back to the column at sortOrder + 1 when nextSlugs is NULL", () => {
    // UNCONFIGURED is not "leads nowhere": an install that predates the graph
    // keeps its launch button. This is the case a `??` handles and a `||` also
    // handles, so it proves nothing on its own — the `[]` case below is the one
    // that tells them apart.
    const columns = board();
    expect(nextStepSlugs(columns, columns[0]!.stage)).toEqual(["research"]);
  });

  it("yields NOTHING for nextSlugs: [] and does NOT fall through to sortOrder + 1", () => {
    // THE case. `[]` is "configured, leads nowhere" — an explicit stop. A
    // truthy/falsy fallback (`nextSlugs || fallback`) treats an empty array as
    // absent and manufactures the edge the person deleted.
    const columns = board({ backlog: { nextSlugs: [] } });
    expect(nextStepSlugs(columns, columns[0]!.stage)).toEqual([]);
  });

  it("yields NOTHING when nextSlugs is NULL and there is no column above", () => {
    // The LAST column of an unconfigured board has no `sortOrder + 1`. An empty
    // list here is the same answer `[]` gives one layer up, and the runtime's
    // "no next stage" close is the same close either way.
    const columns = board();
    expect(nextStepSlugs(columns, columns[3]!.stage)).toEqual([]);
  });

  it("reports an edge whose row the columns do not hold", () => {
    // The slug survives even though it resolves to nothing: the detail modal
    // KEEPS such an edge, because its skipped-column note is the surface that
    // explains the stale read to the person who clicks it.
    const columns = board({ backlog: { nextSlugs: ["ghost"] } });
    expect(nextStepSlugs(columns, columns[0]!.stage)).toEqual(["ghost"]);
  });

  it("yields NOTHING for a board that was never loaded", () => {
    // `undefined` is "never read", not "no columns", and neither proves a next
    // column exists. Inventing one is how an automation fires on a guess.
    expect(nextStepSlugs(undefined, stage())).toEqual([]);
    expect(nextStepSlugs([], stage())).toEqual([]);
  });
});

describe("nextStepOf — the primary next step as a launch destination", () => {
  it("takes the FIRST configured edge and carries its row's fields", () => {
    // The first entry is the primary (spec §7.1), and the destination is the
    // whole row the launch needs: the Skill, the label the sentence names, and
    // the column's extra prompt — all from the SAME row, so a launch cannot
    // disagree with the column it was aimed at (ADR 0098).
    const columns = board({
      backlog: { nextSlugs: ["doing", "research"] },
      doing: withSkill("implement"),
    });
    expect(nextStepOf(columns, columns[0]!.stage)).toEqual({
      slug: "doing",
      label: "Doing",
      onEnterSkill: "implement",
      promptPrefix: null,
    });
  });

  it("resolves the sortOrder + 1 fallback into a real destination", () => {
    const columns = board({ research: withSkill("research") });
    expect(nextStepOf(columns, columns[0]!.stage)).toEqual({
      slug: "research",
      label: "Research",
      onEnterSkill: "research",
      promptPrefix: null,
    });
  });

  it("carries the next column's extra prompt", () => {
    // T5 is the reason this field is on the destination at all: the chain is
    // Skill A → Skill B → Skill C, EACH with its own column prose. A derivation
    // that dropped it would rebuild the bug T5 fixed, one hop deeper.
    const columns = board({
      research: { ...withSkill("implement"), promptPrefix: "Scope it first." },
    });
    expect(nextStepOf(columns, columns[0]!.stage)?.promptPrefix).toBe("Scope it first.");
  });

  it("yields NOTHING for nextSlugs: []", () => {
    const columns = board({ backlog: { nextSlugs: [] } });
    expect(nextStepOf(columns, columns[0]!.stage)).toBeUndefined();
  });

  it("yields NOTHING for an edge whose row the columns do not hold", () => {
    // The pill's own rule, and the reason it differs from `nextStepSlugs`: a
    // pill has no note to fall back on, so an unresolvable edge would be a
    // control whose click moves nothing while the sentence explaining it sits
    // on a different surface entirely.
    const columns = board({ backlog: { nextSlugs: ["ghost"] } });
    expect(nextStepOf(columns, columns[0]!.stage)).toBeUndefined();
  });

  it("yields NOTHING for a board that was never loaded", () => {
    expect(nextStepOf(undefined, stage())).toBeUndefined();
  });
});
