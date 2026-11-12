/**
 * The per-Palette grading contract — the shape a Palette supplies about itself
 * so the shared gates can grade it.
 *
 * WHY THIS FILE EXISTS AND WHY IT IMPORTS NOTHING. Every predicate the palette
 * gates run used to be written against ONE Palette (`.theme-dracula-dark`): the
 * ladder table, the off-spec allow-list, the contrast floors, the group
 * membership. Adding a Palette therefore bought no grading at all — measured in
 * `docs/research/five-more-palettes-and-the-default-rename.md` §4 — because the
 * predicates iterated `DRACULA_VALUES`, not a list of Palettes. The fix is not a
 * bigger `if`, it is moving the per-Palette FACTS out of the gate and into a row
 * the gate reads. A new Palette then adds a row and a CSS file and edits no
 * shared file.
 *
 * The type-only rule is load-bearing for the app build: `src/lib/palettes.ts`
 * (the registry, imported by `main.tsx`) and this module sit in the shipped
 * graph, and `tsc` checks `include: ["src"]` with `noUnusedLocals`. So nothing
 * here may touch Node, and nothing here may import the kit — the dependency goes
 * kit → spec type, never back.
 *
 * WHY SO MUCH OF THIS IS PER-MODE AND NOT PER-PALLETTE, which is ADR 0105 in one
 * sentence: the ladder was designed against Dracula (ADR 0096) and its rules are
 * Dracula's. A light reading cannot satisfy `card-selected > card`, because no
 * light theme publishes anything lighter than its own Base; and group
 * MEMBERSHIP itself differs — Dracula's `secondary` IS `card`, while
 * `default-light`'s `secondary #e6e6e6` sits BELOW `card #ffffff`. One shared
 * table cannot hold both, so each READING states its own groups, its own floors,
 * its own inherited set and its own declaration count. The only genuinely
 * per-Palette (not per-reading) facts are where the values come from and which
 * tokens may break ranks.
 */

import type { PaletteMode } from "./palettes";

export type { PaletteMode };

/**
 * Which declared tokens count as SURFACES — the set the ladder must classify.
 *
 * Shared rather than per-Palette because it is a fact about the app's token
 * vocabulary (which region tokens exist at all), not about a scheme. A Palette
 * that adds a region token has to say which rung it sits on: the ladder gate
 * takes every declared token matching this and fails on any it cannot place, so
 * the ladder cannot be widened past the gate by inventing a surface nobody
 * graded. `color-card-selected` is absent on purpose — it is the selection
 * STATE, graded off the ladder by `selectionRule`.
 */
export const SURFACE_TOKEN_PATTERN =
  /^color-(background|background-win-alt|chat|inspector|composer|frame|header|panel|card|popover|popover-header|input|input-focused|tab|tab-active|menu|menu-hover|toast|tooltip|tooltip-tag|secondary|tag|context-track|terminal-bg)$/;

/**
 * One graded surface group: tokens that are deliberately ONE step (the same
 * colour), ordered among the other groups by luminance.
 */
export interface LadderGroup {
  /** Why these tokens share a step, in the Palette's own words. It appears in
   *  the failure message, so a reader can tell a designed plateau from a bug. */
  readonly label: string;
  /** The tokens, named WITHOUT the `--` prefix (`color-card`). */
  readonly tokens: readonly string[];
}

/**
 * How the selection STATE is graded against the resting ladder, per reading.
 *
 * - `"strictly-above-all"`: brighter than every resting group. Dracula's rule and
 *   its spec's own ("Selection is the brightest step").
 * - `"at-or-above-card"`: must not be DIMMER than `--color-card`, and may plateau
 *   with it. Every light reading needs this (nothing publishes a value lighter
 *   than its Base) and `default-dark` needs it too — its `--color-card-selected`
 *   is `var(--color-input)`, i.e. the card itself, and its `--color-secondary` is
 *   brighter than both. ADR 0096 records those collapses as a designed degrade,
 *   not a bug, so the gate must not veto them.
 */
export type SelectionRule = "strictly-above-all" | "at-or-above-card";

/**
 * One floor entry: the ratio a token must reach, WHY, and — for an exemption —
 * the ratio at which the exemption must be deleted.
 */
export interface FloorRule {
  /** The ratio the gate enforces. 4.5 is the WCAG text minimum; anything below
   *  it is a REPORTED wall and must carry the measured number, never a
   *  rounded-down one. */
  readonly floor: number;
  /** The measurement that set the number, in the Palette's own words. It appears
   *  in the failure message, so a reader can tell a reported wall from a fudge. */
  readonly reason: string;
  /**
   * When set, the gate ALSO fails if the ratio ever reaches this value, so an
   *  exemption cannot outlive its reason. Dracula's `destructive` sets `4.5`:
   *  the brightest red the specification publishes reaches 4.33 on the raised
   *  step, and the day it clears 4.5 the exemption has to go. ADR 0105 makes
   *  this ratchet per-Palette data rather than a Dracula-only constant.
   */
  readonly expiresAt?: number;
}

/**
 * The surfaces text actually renders on, in the three classes the floors are
 * stated per. Named by TOKEN so the Palette owns them: a Palette that moves a
 * surface moves its own floors with it, instead of leaving a gate grading a
 * colour nothing paints on — the failure `paletteCompleteness.test.ts` records
 * three separate times for the context-bar track ("a gate must name the surface
 * the pixels land on").
 */
export interface TextSurfaceSet {
  /** The planes copy sits on: the page, the slab, a recessed well. */
  readonly resting: readonly string[];
  /** The raised step (cards, badges, menu hover). */
  readonly raised: readonly string[];
  /** The selection STATE, when it is a surface at all. */
  readonly selected: readonly string[];
}

/** One reading (mode) of a Palette: everything the gates grade about it. */
export interface PaletteModeSpec {
  readonly mode: PaletteMode;
  /** The elevation ladder as ordered groups, darkest first. */
  readonly ladderGroups: readonly LadderGroup[];
  /** How the selection state is graded against that ladder. */
  readonly selectionRule: SelectionRule;
  /** The token(s) that ARE the selection state (asserted off the ladder). */
  readonly selectedTokens: readonly string[];
  /** Which declared tokens count as SURFACES, so an unclassified one fails. A
   *  Palette that adds a region token cannot slip past the ladder ungraded. */
  readonly surfaceTokenPattern: RegExp;
  /** Surface tokens EXEMPT from the ladder, by name, with the reason. A track
   *  that aliases a TEXT token is not an elevation step and cannot be graded as
   *  one; alpha on a SURFACE token is refused for the same reason (ADR 0105). */
  readonly ladderExemptions: Readonly<Record<string, string>>;
  /** The surfaces the contrast floors are graded on. */
  readonly textSurfaces: TextSurfaceSet;
  /**
   * The text floor per token on the RESTING surfaces; the raised and selected
   * surfaces inherit it and override it in `raisedFloors` / `selectedFloors`.
   * A token absent from this table is held to 4.5.
   */
  readonly textFloors: Readonly<Record<string, FloorRule>>;
  /** The floor on the RESTING RAISED step. */
  readonly raisedFloors: Readonly<Record<string, FloorRule>>;
  /** The floor on the selection STATE. */
  readonly selectedFloors: Readonly<Record<string, FloorRule>>;
  /**
   * Text tokens the resolver CANNOT reach, by name, with the reason.
   *
   * A named refusal, not a skip. The Default palette's foreground family aliases
   * Tailwind v4's `--color-neutral-*` scale, which is `oklch()` with no hex
   * reading anywhere in this repo (`node_modules/tailwindcss/theme.css`), so
   * grading it would mean hardcoding a hex the browser never sees — the exact
   * "judged on someone else's surface" failure `fileIconContrast.test.ts` was
   * rewritten to stop. The kit asserts every entry really IS unresolvable, so the
   * day a Palette makes one a literal hex it must be graded.
   */
  readonly textUngradeable: Readonly<Record<string, string>>;
  /**
   * The Default dark block's tokens this reading deliberately does NOT declare —
   * inherited from `.dark` on purpose, not forgotten. Asserted as a SET EQUALITY
   * in both directions, because a one-directional check lets a token be silently
   * dropped or silently inherited. Per reading: the light reading inherits the
   * ramp and the dark descriptor readings (both have their light-safe value in
   * `@theme`), the dark reading inherits neither the ramp nor the descriptors.
   */
  readonly inheritedFromDefault: readonly string[];
  /** Tokens this reading declares that Default dark does not. Dracula dark's are
   *  the 6 ramp tokens, which live in `.dark` + `@theme` and which Dracula
   *  re-hues. */
  readonly extraBeyondDefault: readonly string[];
  /** The declaration count of THIS block, pinned so a parser that found nothing
   *  (or a block truncated at its first nested rule) cannot pass every predicate
   *  at once. */
  readonly declaredCount: number;
}

/**
 * A Palette's grading row: the facts a Palette supplies about its own CSS file.
 *
 * Lives in `src/lib/palettes/<id>.ts`, one file per Palette, DISCOVERED by
 * reading that directory (`listPaletteSpecs` in the kit). That discovery is what
 * makes the authoring waves parallel: a gate that enumerated specs by importing
 * them by name would have to be edited by every new Palette, and four Palettes
 * authored in parallel would collide on the same line.
 */
export interface PaletteSpec {
  /** The registry id this row grades. Must match a `PaletteDefinition.id` AND
   *  the file's own name, so discovery and the registry cannot disagree about
   *  which Palette a row grades. */
  readonly id: string;
  /** The CSS file that declares this Palette's blocks, relative to the repo
   *  root. Per-Palette grading reads ONLY this file — never the resolved
   *  `index.css` — because a Palette whose `@import` has not landed yet must
   *  still be gradeable, or the gate either goes red mid-plan or has to skip,
   *  which makes it vacuous for exactly the Palettes it exists to grade. */
  readonly cssFile: string;
  /** The file holding the shared base layers (`@theme`, `.dark`) that this
   *  Palette's block resolves its `var()` hops against. */
  readonly baseCssFile: string;
  /** Where the published values come from. For a third-party scheme, the spec
   *  URL; for the Default palette, the repo's own design record — because it
   *  publishes no external spec, and a reader must be able to tell the two
   *  apart. */
  readonly specSourceUrl: string;
  /** The readings this row grades. Every mode the REGISTRY declares must have a
   *  row here, and every row here must have a block in `cssFile` — both
   *  directions are asserted, so a registered mode cannot go ungraded and a
   *  graded mode cannot be a figment. */
  readonly modes: Readonly<Record<PaletteMode, PaletteModeSpec | undefined>>;
  /**
   * The value set the source publishes. Every hex a block declares must be in
   * here, or the token must be named in `offSpecAllowList`.
   *
   * For the Default palette this is the app's OWN recorded set, which makes this
   * half of the gate a REGRESSION net rather than a conformance check: a new hex
   * still has to be added deliberately, and `specSourceUrl` says which kind of
   * record the reader is looking at.
   */
  readonly publishedHexes: readonly string[];
  /**
   * Tokens allowed to carry a hex outside `publishedHexes`, each with a one-line
   * reason. Listed BY NAME, never by family — Dracula's 24 file-type descriptors
   * are the precedent: 11 hues cannot name 25 file types, and the hue IS the
   * signal.
   *
   * An entry that carries no off-spec hex anywhere in the Palette is a FREE SLOT
   * and the kit fails it: an unused exception silently licenses any future token
   * to paint that hex with no test to notice. (That is how `#353747` once sat in
   * Dracula's list, described as something it was not.) A Palette whose values
   * are all on-record — the Default palette — has an EMPTY list, and that is the
   * honest answer rather than a gate that grades nothing.
   */
  readonly offSpecAllowList: Readonly<Record<string, string>>;
}
