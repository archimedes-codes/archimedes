import { describe, expect, it } from "vitest";
import { readResolvedIndexCss, stripCssComments } from "./cssSource";

/**
 * THE ONE COLLISION THE ISLAND LAYOUT BUYS ON PURPOSE (ADR 0027, option B).
 *
 * The content slab — the transcript column, the side pane and the composer
 * chat column and the inspector, both reading the same Background step,
 * `#282a36`. That step is ALSO what the spec assigns to "Floating interactive
 * elements", so every float (`bg-menu`, `bg-popover`, `bg-tooltip`) is now the
 * EXACT SAME COLOUR as the surface it floats over: 1.00, not 1.0X — identical.
 *
 * This was a decision, not an oversight. The alternatives were worse:
 *   - keep the slab below the float step: the spec has no sixth dark step, so it
 *     would need an off-spec hex, which is the exact sin the spec-gate in
 *     `paletteCompleteness.test.ts` was written to reject;
 *   - move the floats UP to `#343746`: then `card`, `secondary` and `tag` have
 *     nowhere above them, and re-merging badges with the float that contains
 *     them is the elevation INVERSION this same ADR records fixing once already.
 *
 * So the floats stay, and the app pays for it here. This file exists so the
 * price is a measured, named fact rather than a rumour — the ADR's own
 * conclusion is "count it, do not recall it", and prose in `index.css` is the
 * form of this correction that keeps needing to be corrected again.
 *
 * WHAT ACTUALLY SAVES A FLOAT is its elevation affordance, and that is a
 * property of the COMPONENT, not of the palette. Hence the second half of this
 * file reads the component sources: if someone deletes a `shadow-md` or a
 * `border` from a float, the float over the chat becomes invisible and no
 * palette test can see it. That is the regression this pins.
 */

const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

const lumOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lumOf(a), lumOf(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

const dracula = (token: string): string => {
  const css = stripCssComments(readResolvedIndexCss());
  const body = css.match(/^\.theme-dracula\s*\{/m)!;
  const start = css.indexOf(body[0]!);
  const block = css.slice(start, css.indexOf("}", start));
  const v = block.match(new RegExp(`--color-${token}\\s*:\\s*([^;]+);`))![1]!;
  return v.trim().toLowerCase();
};

/**
 * A component's source with its COMMENTS removed — the only safe reader for
 * this file. Its assertions are about CLASS LISTS, and the comments in those
 * components describe the classes they document, so a raw read lets the PROSE
 * satisfy an assertion after the class itself has been deleted: a
 * "keeps its stacking context" test passed for exactly that reason while the
 * stacking context was gone. Stripping comments makes the assertion read what
 * the component actually RENDERS.
 */
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

describe("floats over the content slab (the accepted collision)", () => {
  const slab = dracula("chat");
  const floats = ["menu", "popover", "tooltip", "toast", "header", "tab"] as const;

  it("puts the slab and every float on the SAME colour — the collision is real", () => {
    // Asserted as a fact, not hoped away. If a future change gives the floats
    // their own step, THIS test is what says the trade-off has been paid off —
    // and it fails, pointing at the comment that needs deleting.
    expect(slab).toBe("#282a36");
    for (const token of floats) {
      expect(dracula(token), `--color-${token}`).toBe(slab);
    }
  });

  it("measures the collision at exactly 1.00, so fill alone cannot separate them", () => {
    for (const token of floats) {
      expect(
        contrast(dracula(token), slab),
        `--color-${token} against the slab`,
      ).toBeCloseTo(1, 5);
    }
  });

  /** Every float component and the affordance that ACTUALLY carries it, read
   *  from the source rather than assumed. `shadow` is the strong one — it is
   *  drawn outside the box, so a same-colour fill cannot eat it. `border` is
   *  weak by construction here: `--color-popover-border` aliases
   *  `--color-border`, which is Comment `#6272a4` at 2.51 on the slab — BELOW
   *  the 3:1 WCAG floor for a non-text boundary. So the border is a hint and
   *  the shadow is the separation.
   *
   *  `border` is false for `alert-dialog` and that is intentional, not an
   *  oversight to fix: it is `border-none bg-popover/98 shadow-2xl`. A
   *  full-screen modal wearing the strongest shadow in the kit does not need a
   *  hairline. It is enumerated anyway so the SHADOW is the pinned invariant
   *  for every float, and so dropping a border where one exists is a review
   *  rather than a silence. */
  const FLOATS: Array<{ file: string; label: string; border: boolean }> = [
    { file: "src/components/ui/select.tsx", label: "Select content", border: true },
    { file: "src/components/ui/dropdown-menu.tsx", label: "DropdownMenu content", border: true },
    { file: "src/components/ui/dialog.tsx", label: "Dialog content", border: true },
    { file: "src/components/ui/alert-dialog.tsx", label: "AlertDialog content", border: false },
  ];

  for (const f of FLOATS) {
    it(`${f.label} keeps its shadow — the only thing separating it from the slab`, () => {
      const cls = code(f.file);
      expect(cls, `${f.file} lost its shadow`).toMatch(/shadow-/);
      if (f.border) {
        expect(cls, `${f.file} lost its border`).toMatch(/border-(popover-border|border)\b/);
      } else {
        // `border-none` is deliberate (a full-screen modal with the strongest
        // shadow in the kit needs no hairline) — assert the DECLARATION, since a
        // `border-none` class contains the word "border" and a naive
        // not.toMatch(/border/) could never pass.
        expect(cls, `${f.file} now has a border — promote it in FLOATS`).toMatch(
          /border-none/,
        );
      }
    });
  }

  it("records that the TOOLTIP has no shadow and is the accepted casualty", () => {
    // The tooltip is the one float with neither a shadow nor a meaning that
    // survives losing its edge: `tooltip.tsx` carries `border border-border` and
    // no `shadow-*`, so over the chat column it reads as a same-colour patch
    // lifted only by a 2.51 rule.
    //
    // NOT FIXED HERE, and that is deliberate rather than lazy: the fix is a
    // `shadow-md` on the tooltip, which is a component change with its own test
    // surface (the tooltip's own suite asserts its class list), and dragging it
    // into a palette change is how an unrelated regression gets attributed to
    // the colour work. Pinned as a NEGATIVE so the gap cannot be forgotten OR
    // quietly closed by accident — if a shadow is ever added, this fails and the
    // entry gets promoted into FLOATS above.
    const cls = code("src/components/ui/tooltip.tsx");
    expect(cls).toMatch(/border-border/);
    expect(cls).not.toMatch(/shadow-/);
  });

  it("keeps the context bar's track legible against the pane it rides", () => {
    // GRADED AGAINST `inspector`, the pane's own plane — the surface the
    // track's pixels ACTUALLY land on. This gate has named the wrong surface
    // twice (the chat slab, then `composer` after the bar left the island, then
    // the `bg-input` WELL after the bar left the composer for the pane), and
    // the well is now gone too: the user rejected it as a sunken slot inside a
    // plane, and `SessionConfigBlock.tsx` says so at its top. A gate must name
    // the surface the pixels land on, so this reads `inspector`.
    //
    // THE FLOOR IS 1.2, NOT 1.3, AND THAT IS A REAL CONCESSION, not gate-
    // loosening to hide a failure: 1.3 was measurable only BECAUSE of the well.
    // Against the bare pane no non-Selection Dracula step clears 1.3 —
    // `#343746` 1.208, `#191a21` 1.218, `#21222c` 1.109 — the palette simply
    // has no step at that distance from `#282a36`. What carries the bar is the
    // FILL against the TRACK (every band clears 3:1, worst 4.33), and band-vs-
    // pane separation actually IMPROVES without the well (5.23 vs 4.33).
    // 1.2 still fails the true collisions — a track that IS the pane
    // (`#282a36`, 1.000) or the page plane under it (`#21222c`, 1.109).
    // The invariant is SEPARATION, not direction.
    const track = dracula("context-track");
    const pane = dracula("inspector");
    expect(
      contrast(track, pane),
      `track ${track} is invisible against the pane ${pane} it rides`,
    ).toBeGreaterThanOrEqual(1.2);
  });
});

/**
 * THE BOARD'S PILLS, AND WHY THEIR FILL IS `--color-background` AND NOT
 * `--color-chat` (ADR 0096 — "a contrast check in one palette proves nothing").
 *
 * The three small pills on the Task board (the `T{n}` number, the spec chip, the
 * column count) originally shipped on `bg-chat`, justified by a comment that
 * measured ONE palette: "`bg-chat` is the one token that reads on BOTH surfaces
 * it can sit near (1.22 / 1.21)". Those are Dracula figures. In `.theme-zai-dark`
 * the same token is not merely weaker, it is EXACTLY the card — not 1.0X, 1.00 —
 * by algebra, not by a colour-space approximation:
 *
 *   --color-background-win-alt: #2b2b2b
 *   --color-chat:  color-mix(in oklab, var(--color-background-win-alt) 60%, transparent)
 *   --color-card:  #2b2b2b
 *
 *   chat over card = 0.6·#2b2b2b + 0.4·(#2b2b2b) = #2b2b2b = the card itself.
 *
 * A pill is a fill on a surface it must not be. The fill therefore has to differ
 * from BOTH surfaces it can land on — the column (`bg-panel`) and the card
 * (`bg-card`) — in EVERY palette, and `bg-chat` fails that in zai-dark.
 * `bg-background` (the page step) clears both everywhere: 1.10 / 1.34 Dracula,
 * 1.11 / 1.28 zai-dark, 1.06 / 1.06 zai-light. Its ink
 * (`text-foreground-subtle`) stays readable on it in all three: 7.04 / 5.78 / 4.70.
 *
 * WHY THE SHAPE OF THESE ASSERTIONS IS SPLIT. `--color-chat` and, in the zai
 * palettes, `--color-background` too are `color-mix(…)` / `var(…)` expressions
 * that this file's own docblock already refuses to treat as a hex, so the zai
 * palettes are graded STRUCTURALLY (the fill token must not resolve to either
 * surface it lands on) and Dracula — literal hexes — is graded NUMERICALLY. And
 * the zai-dark collision is asserted as a FACT the way the float/slab collision
 * above is: this file's job is to count the price, not to hope it away.
 *
 * WHY `bg-panel` / `bg-input` / `bg-secondary` / `bg-frame` are NOT the fix: each
 * of them also hits 1.00 somewhere (`input` and `secondary` are literally the
 * card in zai-dark; `panel` and `frame` are `#ffffff` in zai-light; `panel` is
 * `#191a21` = `frame` = `input` in Dracula). The 1.00s are a property of the zai
 * collapses, not of one bad token — so the gate below is an INVARIANT (the fill
 * must not equal either surface), never a banned-token list.
 */
describe("the board pills' fill, per palette (the zai-dark collision)", () => {
  /** Read one token out of one palette block of the RESOLVED stylesheet — the
   *  same reader shape as `dracula()` above, parameterised by selector, because
   *  a single-palette reader is precisely the instrument that missed this. */
  const themeVar = (selector: string, token: string): string => {
    const css = stripCssComments(readResolvedIndexCss());
    const head = css.match(new RegExp(`^\\${selector}\\s*\\{`, "m"));
    if (!head) {
      throw new Error(`${selector} is not in the resolved stylesheet`);
    }
    const start = css.indexOf(head[0]);
    const block = css.slice(start, css.indexOf("}", start));
    const value = block.match(new RegExp(`--color-${token}\\s*:\\s*([^;]+);`));
    if (!value) {
      throw new Error(`--color-${token} is not declared in ${selector}`);
    }
    return value[1]!.trim().toLowerCase();
  };

  const PALETTES = [
    ".theme-dracula",
    ".theme-zai-dark",
    ".theme-zai-light",
  ] as const;

  for (const palette of PALETTES) {
    it(`${palette}: the pill fill is neither surface it can land on`, () => {
      // THE invariant that would have caught the bug. A pill sits on a column
      // (`bg-panel`) and beside a card (`bg-card`); if its fill token resolves to
      // either of those, the pill is a same-colour patch and no palette test
      // written against a DIFFERENT palette can see it.
      const fill = themeVar(palette, "background");
      expect(fill, `${palette}: --color-card`).not.toBe(themeVar(palette, "card"));
      expect(fill, `${palette}: --color-panel`).not.toBe(themeVar(palette, "panel"));
    });
  }

  it("measures the Dracula separation, where every token is a literal hex", () => {
    const background = dracula("background");
    const panel = dracula("panel");
    const card = dracula("card");
    // 1.05 is a floor, not a target: the palette simply has no step at a
    // comfortable distance from `#191a21` / `#343746`, and the pills are small
    // marks carrying a count, not a boundary that must clear 3:1. It is a FLOOR
    // in the sense that matters — it fails an equality collision outright.
    expect(
      contrast(background, panel),
      `${background} against the column ${panel}`,
    ).toBeGreaterThan(1.05);
    expect(
      contrast(background, card),
      `${background} against the card ${card}`,
    ).toBeGreaterThan(1.05);
  });

  it("measures the zai-dark collision at exactly 1.00 — the bug is real, not a rumour", () => {
    // Mirrors `measures the collision at exactly 1.00` above: the failure mode
    // gets ASSERTED, so a future change that breaks the algebra (giving `chat`
    // its own step in zai-dark) reddens this and points at the prose.
    const chat = themeVar(".theme-zai-dark", "chat");
    const card = themeVar(".theme-zai-dark", "card");
    // `--color-chat` is a `color-mix(…)` — compare it STRUCTURALLY, as the
    // docblock above insists, by resolving its base token inside the same block.
    const base = chat.match(/var\(--color-([a-z-]+)\)/);
    const percent = chat.match(/(\d+)%/);
    expect(base, `--color-chat in zai-dark is not a color-mix over a token: ${chat}`).toBeTruthy();
    expect(percent, `--color-chat carries no percentage: ${chat}`).toBeTruthy();
    const baseValue = themeVar(".theme-zai-dark", base![1]!);
    // THE collision, as algebra: the mix's base token IS the card token.
    expect(baseValue, "--color-background-win-alt vs --color-card").toBe(card);
    // Compositing `chat` over `card`: 0.6·base + 0.4·card, and base === card, so
    // the result is the card. Contrast is 1.00 to five places — fill alone
    // cannot separate the pill from the card it sits next to.
    const mixOver = (over: string, under: string, weight: number) => {
      const a = parseInt(over.slice(1), 16);
      const b = parseInt(under.slice(1), 16);
      const channel = (shift: number) =>
        Math.round(((a >> shift) & 255) * weight + ((b >> shift) & 255) * (1 - weight));
      return (
        "#" + [16, 8, 0].map((s) => channel(s).toString(16).padStart(2, "0")).join("")
      );
    };
    const composited = mixOver(baseValue, card, Number(percent![1]) / 100);
    expect(composited, "chat composited over card must BE the card").toBe(card);
    expect(contrast(composited, card), "zai-dark pill fill vs card").toBeCloseTo(1, 5);
  });

  /** The pills, named by the class shape that identifies them, read from the
   *  COMPONENT SOURCES. This is the half that is red before the fix: the
   *  palette invariants above hold for `bg-background` AND for the broken
   *  `bg-chat` fill, because the bug was never in the palette — it was in a
   *  class list, chosen from one palette's arithmetic. Same reason this file
   *  already reads the float components for their `shadow-`: a class a palette
   *  test cannot see is still a palette failure.
   *
   *  TWO ENTRIES, SIX PILLS: the card carries FIVE (`T{n}`, the spec chip, the
   *  sessions chip, the next-step pill and the artifact key chips) and the column
   *  carries one (the count).
   *  Issue #174 added the card's THIRD — the sessions chip — and it wears the same
   *  fill, so the entry needed no new row (each entry is FILE-scoped: the gate reads
   *  a file and censuses every `rounded-full` literal in it) but the count below did
   *  move, 2 → 3. Issue #179's primary-next-step pill is the FOURTH and moved it
   *  3 → 4 on the same reasoning. Issue #180's ARTIFACT KEY CHIPS are the FIFTH and
   *  move it 4 → 5: the chips render one pill per artifact key from ONE shared class
   *  literal, so a card with three keys still contributes exactly ONE literal here.
   *  The sequence is 2 → 3 (#174) → 4 (#179) → 5 (#180), and the TREE is the
   *  authority on the number, never this comment. A new pill in an already-censused
   *  file needs no new row, only a count that keeps failing if one of them loses its
   *  fill — which is the whole point of the census being a COUNT and not a scan. */
  const PILLS: Array<{ file: string; label: string }> = [
    {
      file: "src/components/TaskCard.tsx",
      label:
        "the card's `T{n}` pill, spec chip, sessions chip, next-step pill and artifact key chips",
    },
    { file: "src/components/TasksBoard.tsx", label: "the column count pill" },
  ];

  for (const pill of PILLS) {
    it(`${pill.file}: no pill wears a fill that collapses on a surface`, () => {
      const cls = code(pill.file);
      const literals = [...cls.matchAll(/"([^"]*rounded-full[^"]*)"/g)].map((m) => m[1]!);
      expect(literals.length, `${pill.file} has no pill class literal left`).toBeGreaterThan(0);
      for (const literal of literals) {
        // `bg-chat` is the island plane: inside the board it is the COLUMN the
        // pill's own card sits on, so a pill wearing it is a pill wearing the
        // surface under it (1.00 in zai-dark, and 1.00 against `bg-card` there).
        expect(literal, `${pill.label} fell back to the island plane`).not.toMatch(
          /(^|\s)bg-chat(\s|$)/,
        );
        expect(literal, `${pill.label} lost its page-step fill`).toMatch(
          /(^|\s)bg-background(\s|$)/,
        );
      }
      // A CENSUS, so a pill cannot dodge the gate by losing `rounded-full`.
      // The card carries FIVE (`T{n}`, the spec chip, the sessions chip, the
      // primary-next-step pill — #179's — and the artifact key chips — #180's, which
      // render N chips from ONE literal) and the column still carries one.
      const fills = literals.filter((l) => /(^|\s)bg-background(\s|$)/.test(l));
      expect(fills.length, `${pill.file} pill count drifted`).toBe(
        pill.file.endsWith("TaskCard.tsx") ? 5 : 1,
      );
    });
  }

  it("keeps the board island itself on the chat plane — the pill fix is not a ban", () => {
    // The board root is the ADR 0097 island (`m-1 rounded-xl bg-chat`, pinned by
    // `TasksBoard.test.tsx`). The defect was a PILL wearing the island plane, not
    // the island wearing it — so this pins the other side of the line, and stops
    // someone "fixing" the bug by sweeping every `bg-chat` out of the file.
    const root = code("src/components/TasksBoard.tsx").match(
      /"([^"]*m-1[^"]*rounded-xl[^"]*)"/,
    );
    expect(root, "the board root lost its rounded-xl recipe").toBeTruthy();
    expect(root![1]).toMatch(/(^|\s)bg-chat(\s|$)/);
  });
});

/**
 * THE SPACE TABS MOVED OUT OF THIS FILE. Active and inactive used to be pinned
 * here by READING THE TAB-STRIP COMPONENT'S SOURCE TEXT: lifting the pill's
 * class literal out of the source with one regex, lifting every
 * `active ? "…" : "…"` class ternary with another, and comparing the two — plus
 * a hard failure raised when a ternary could not be found. That last part was
 * the problem in miniature: a component that expressed the same correct pair as
 * a lookup, a `cn()` call, or a variant failed at test time, so a build-green,
 * pixel-identical component arrived with zero tests run. It also punished
 * RELOCATION: moving the pill's geometry into a shared child reddened a gate
 * about how a file is WRITTEN.
 *
 * Both invariants now live where they are observable, in the rendered DOM:
 * `src/components/SpaceTabs.pill.test.tsx` renders the strip and asserts (a) the
 * pill is the same `h-8` `rounded-md` inset for the active and the inactive tab,
 * with the shape existing exactly once across the state pair, and (b) the state
 * pair differs ONLY by fill and ink — a geometry difference in either direction
 * fails it — plus the bridge ban (no `h-10`, no `rounded-t-md`, no bridge
 * shadow, no paint-order hack) over every class the strip renders. The
 * "one kind of object" claim is now STRONGER than the source gate managed: the
 * text reader could not see a duplicated geometry string inside a ternary
 * branch, whereas the rendered class list cannot contain one invisibly.
 *
 * This file keeps ONLY the gates no render can express: the palette collision
 * measurements, and the float shadow/border gates. Those are textual on purpose
 * — a `shadow-md` that a component must still CONTAIN for Tailwind's scanner to
 * emit the rule at all is a source-text fact whether or not a given test mounts
 * the component, so `FLOATS` and the tooltip's accepted casualty stay.
 */
