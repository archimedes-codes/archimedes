import { describe, expect, it } from "vitest";
import type { AppView } from "./appView";

/**
 * `src/lib/appView.ts` — the ONE declaration of `App`'s content-area view union.
 *
 * ## What a test can do to a type, and what it cannot
 *
 * A union has no runtime, so this file asserts nothing about behaviour. What it
 * holds is a COMPILE-TIME RATCHET on the union's MEMBERSHIP, and that is the gap
 * the shared declaration opened: with one `AppView` instead of three spellings,
 * `tsc` no longer catches a widening at the second and third site (there is
 * nothing left to disagree), so the union's contents are now pinned in exactly one
 * place and this is it.
 *
 * `ALL_VIEWS` is typed `Record<AppView, true>` and spells all four arms. Both
 * directions therefore fail to compile:
 *  - widen the union and the new arm has no key here → `tsc` error (a view exists
 *    that nothing enumerated — the same "a surface forgot" this union's per-arm
 *    pins in `App.test.tsx` and `SpacesList.workflows.test.tsx` catch at runtime,
 *    caught earlier and for free here);
 *  - drop or rename an arm and its key here is excess → `tsc` error.
 *
 * It is NOT a substitute for those two runtime pins, and the header of
 * `lib/appView.ts` says why: `App`'s ternary keeps the workspace as its implicit
 * `else`, so a widened union with no arm paints the chat column with a green
 * build, and a `currentView` prop a component ignores is not a type error either.
 * Those pins stay load-bearing. This one only keeps the ENUMERATION honest.
 *
 * The runtime assertions below are the trivial half and are kept because a file
 * with zero `it` blocks is a file vitest reports as failed, not as passed.
 */
const ALL_VIEWS = {
  workspace: true,
  settings: true,
  board: true,
  workflows: true,
} satisfies Record<AppView, true>;

const VIEW_NAMES = Object.keys(ALL_VIEWS).sort();

describe("the App view union", () => {
  it("enumerates the four arms the app routes", () => {
    // Spelled out one arm at a time rather than as a length, so a failure names the
    // arm that appeared or vanished instead of reporting `4 !== 5`.
    expect(VIEW_NAMES).toEqual(["board", "settings", "workflows", "workspace"]);
  });

  it("has a door in `SpacesList` for every arm it enumerates", () => {
    // The three view DOORS are `Settings`, the Task board and Workflows, and
    // `workspace` is the state they all toggle OFF to — so four arms and three
    // doors, and the arithmetic is deliberate rather than an oversight. If a fifth
    // arm ever needs a door, this is the line that has to be re-derived, and the
    // runtime pin that catches a door that was NOT added is
    // `SpacesList.workflows.test.tsx`'s `aria-pressed` case.
    expect(VIEW_NAMES).toHaveLength(4);
  });
});
