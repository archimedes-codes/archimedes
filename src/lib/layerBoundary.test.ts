import { describe, expect, it } from "vitest";
import { createSourceSweep } from "./sourceSweep";

/**
 * THE LAYER CENSUS (finding 13 / D3, task FE2) — a source scanner, in the shape
 * this repo already runs (`tauriBoundary.test.ts`, `tauriBarrel.test.ts`,
 * `classNameConvention.test.ts`).
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 *
 * No module under `src/lib/` may RUNTIME-import a module under `src/store/` or
 * `src/components/`. `lib/` is the lower layer: it holds transport wrappers,
 * pure derivations and DOM affordances, and it must stay usable by a store
 * without pulling the store along with it. An upward runtime edge inverts that:
 * the "pure" module now owns store state, and anything importing it inherits the
 * store's graph.
 *
 * The direction that already holds (`src/store/` → `src/components/` is 0 edges)
 * is not what this file is for. This file exists because the OTHER direction was
 * silently violated: `src/lib/sessionLifecycle.ts` was a store-layer module
 * (it drives `useInteractive`, `usePermissions`, `useQueuedPrompts`,
 * `useSessions`) misfiled under `lib/`. FE2 moves it to `src/store/`. The move
 * is the trivial half; the census is the deliverable, because without it the
 * next `lib` module imports upward too and every existing test stays green.
 *
 * ---------------------------------------------------------------------------
 * WHY A CENSUS AND NOT A COUNT, AND WHY THE PREDICATE IS THE THING UNDER TEST
 * ---------------------------------------------------------------------------
 *
 * AGENTS.md records this trap and `tauriBoundary.test.ts` records it again in
 * prose: a floor on the WALK (`expect(SOURCES.length).toBeGreaterThan(…)`)
 * proves the scanner read files. It does NOT prove the predicate found anything.
 * Corrupt the predicate and the offender set goes empty, the allowlist
 * comparison passes, and the file is green while blind. So the SAME predicate
 * instance is run twice — over the tree, and over the allowlist — exactly as
 * `tauriBoundary.test.ts` re-uses `namesWirePackages` over both sets. The
 * allowlist is not decoration: `settings.ts` and `linkify.tsx` are the proof
 * that the predicate has eyes.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME EDGES ARE THE CRIME; TYPE-ONLY EDGES ARE A DIFFERENT SEVERITY
 * ---------------------------------------------------------------------------
 *
 * `import type { X } from "../store/…"` compiles to NOTHING (this project sets
 * `verbatimModuleSyntax`), so it carries no runtime dependency, cannot create an
 * initialization cycle, and does not drag a store's module side effects into a
 * `lib` consumer. Excluding it is a decision, not an oversight, so the type-only
 * set is ENUMERATED below rather than silently dropped: a new upward type edge
 * still has to be justified here.
 *
 * The subtlety the predicate has to get right is that `type` appears in two
 * places — `import type { A } from` (whole statement type-only) and
 * `import { type A, useB } from` (a RUNTIME import that happens to carry a type
 * binding). Only the first is type-only; a predicate that greps for the word
 * `type` anywhere on the line would wave through the second, which is the
 * green-and-lying case in the other direction.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT CATCH (the honest ceiling)
 * ---------------------------------------------------------------------------
 *
 * A specifier assembled at runtime from fragments (`"@/" + "store/x"` behind a
 * computed `await import()`). It is the same ceiling `tauriBoundary.test.ts`
 * documents for the IPC boundary: a scanner defends against a mistake, not
 * against someone determined to hide an edge. Dynamic `import("literal")` and
 * `export { x } from "literal"` ARE matched, because those are the accidental
 * shapes that read as "just a re-export".
 *
 * ---------------------------------------------------------------------------
 * NON-VACUITY: THE MUTATIONS THIS FILE WAS PROVEN AGAINST (run, then reverted)
 * ---------------------------------------------------------------------------
 *
 * Not a claim — each was executed against the tree and the output recorded.
 *
 * 1. THE PREDICATE IS BLIND (the failure AGENTS.md records). Inject
 *    `if (true) return true` at the top of `isTypeOnly`, so every upward import
 *    is classified type-only and the runtime predicate finds nothing. Result:
 *    5 of 7 tests FAIL — and the decisive detail is that the HEADLINE guard
 *    `"no lib module imports upward into store/ or components/ at runtime"`
 *    PASSED GREEN, because an empty offender set satisfies it. What reddened is
 *    exactly what a walk-only floor would have missed:
 *        × the scanner actually reads the tree
 *            → expected 0 to be greater than 0        (predicate found nothing)
 *        × the predicate is NOT BLIND: it finds the allowlisted offenders itself
 *            → "the predicate matches nothing — it is blind, not satisfied"
 *        × the offender set is exactly the allowlist
 *        × the allowlist has no stale entries
 *        × type-only upward edges stay a documented, unwidened set
 *
 * 2. A REAL UPWARD EDGE APPEARS. Add `src/lib/__mutationProbe.ts` with one
 *    runtime `import { useSessions } from "../store/sessions"`. Result: 2 FAIL,
 *    and the offender NAMES ITSELF —
 *        expected [ 'src/lib/__mutationProbe.ts' ] to deeply equal []
 *
 * 3. THE SEVERITY SPLIT IS REAL, NOT DECORATION. Same probe file, but
 *    `import type { SessionsState } from "../store/sessions"`. Result: the
 *    runtime guards stay GREEN (a type edge erases, so it is not a cycle risk)
 *    while `type-only upward edges…` REDDENS — an upward type edge is still
 *    reported, in its own lane, rather than being invisible.
 *
 * 4. THE MIXED-CLAUSE TRAP. Same probe as (2) but spelled
 *    `import { type SessionsState, useSessions } from "../store/sessions"`.
 *    Result: CONVICTED as runtime (2 FAIL, names itself). This is the case a
 *    predicate written as `line.includes("type")` waves through, silently
 *    licensing a real edge.
 *
 * 5. THE STALE DIRECTION. Add an `ALLOWED` entry for `src/lib/paths.ts`, a
 *    module that imports nothing upward. Result: 3 FAIL, including
 *        × the allowlist has no stale entries
 *            → "these modules no longer import upward at runtime — shrink the
 *               allowlist": expected [ 'src/lib/paths.ts' ] to deeply equal []
 *
 * 5b. THE OTHER ALLOWLIST EDIT, and the honest note about it. DELETING the
 *    `linkify.tsx` entry while `linkify.tsx` still renders `OpenAnchor` reddens
 *    the offender guard (`expected [ 'src/lib/linkify.tsx' ] to deeply equal []`)
 *    and the set-equality pin — but NOT the stale guard, which cannot fire on a
 *    deletion by construction. The plan listed that mutation under the
 *    stale-allowlist bullet; it belongs to the offender bullet. Both directions
 *    are covered, by (5) and (5b) respectively, and asserting them as separate
 *    `it`s is what makes a failure name its direction.
 */

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so
// a bare `import "node:fs"` does not typecheck. The idiom `cssSource.ts`,
// `themeTokens.test.ts` and `tauriBoundary.test.ts` use.
const NODE_FS = "node:" + "fs";
const { readdirSync } = (await import(NODE_FS)) as {
  readdirSync: (
    path: string,
    options: { recursive: true; encoding: string },
  ) => string[];
};
// Reads go through the SWEEP READER (see `sourceSweep.ts`). This file walks
// `src/lib` RECURSIVELY and opens every path in later predicates, and vitest runs
// test files concurrently across workers — so a listed path can be deleted
// between the listing and the open. That is not hypothetical on this branch: the
// live palette guard writes `src/lib/palettes/guardprobe.ts`, which sits INSIDE
// the directory walked here.
const sweep = createSourceSweep();

/** The module, for the non-vacuity probe below — it CREATES and DELETES a scratch
 *  file so the skip branch is driven on purpose rather than waited for. Same
 *  COMPUTED specifier (this app ships no `@types/node`). */
const NODE_FS_MODULE = (await import(NODE_FS)) as unknown as {
  writeFileSync: (path: string, data: string) => void;
  rmSync: (path: string, options?: { force?: boolean; recursive?: boolean }) => void;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
};
const fs = NODE_FS_MODULE;

/** Normalise a `readdirSync` result to `/`-spelled repo-relative paths. On
 *  Windows `readdirSync` returns BACKSLASH paths, which would break every
 *  comparison below; `tauriBarrel.test.ts` learned this on CI, where it reddened
 *  a vacuity guard on an unchanged tree. POSIX never emits `\` in a path. */
const relPath = (dir: string, p: string): string =>
  `${dir}/${p.replace(/\\/g, "/")}`;

/** Strip comments before scanning: a doc-comment that MENTIONS `../store/…` is
 *  prose, not a dependency. `tauriBarrel.test.ts` and `themeTokens.test.ts` were
 *  both bitten by this. `src/store/sessions.ts:865` and `:1928` name
 *  `sessionLifecycle.ts` in COMMENTS for exactly this reason. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** Every `.ts`/`.tsx` under `src/lib/` — tests INCLUDED in the walk.
 *
 *  Tests are walked but EXEMPT from the rule (see `LIB_PRODUCTION`): a test that
 *  imports a store in order to drive it is the documented way to test a
 *  cross-layer interaction (`sessionLifecycle.test.ts` asserts the real
 *  dismiss-then-file ORDER across four stores). Hiding them from the walk would
 *  be the cheaper trick; keeping them visible and exempt-by-name is the honest
 *  one, and it is what makes the exemption auditable. */
const SOURCES = readdirSync("src/lib", { recursive: true, encoding: "utf8" })
  .filter((p) => /\.tsx?$/.test(p))
  .map((p) => relPath("src/lib", p))
  .sort();

/** Shipped `lib` modules — the only files the rule can convict. */
const LIB_PRODUCTION = SOURCES.filter((f) => !/\.test\.tsx?$/.test(f));

/** The layers a `lib` module may not reach UP into. */
const UPPER_LAYERS = ["src/store/", "src/components/"];

/** Resolve an import specifier to a repo-relative module path, or `null` for a
 *  bare package specifier (`react`, `@tauri-apps/api/core`) — those are outside
 *  the layer graph entirely.
 *
 *  Resolved, NOT string-matched: the same target is spelled `../store/sessions`
 *  from `src/lib/settings.ts`, `../../store/sessions` from
 *  `src/lib/tauri/…`, and `@/store/sessions` where the alias is used. Matching
 *  the literal `"../store/"` would be blind to the deeper nesting and to the
 *  alias, and a predicate that is blind to one spelling is the failure this whole
 *  file is written to avoid. */
const resolveSpecifier = (file: string, spec: string): string | null => {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (!spec.startsWith(".")) return null;
  const segments = file.split("/").slice(0, -1).concat(spec.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  const resolved = out.join("/");
  return resolved;
};

/** True when a resolved module path lands inside an upper layer. */
const isUpperLayer = (resolved: string): boolean =>
  UPPER_LAYERS.some((dir) => resolved === dir.replace(/\/$/, "")) ||
  UPPER_LAYERS.some((dir) => resolved.startsWith(dir));

/** Every specifier a source pulls in, tagged type-only or not.
 *
 *  Covers the shapes that create an edge: `import … from "…"`,
 *  `import type … from "…"`, `export { … } from "…"` (a re-export is a RUNTIME
 *  edge — it executes the target module), `export * from "…"`, and
 *  `import("…")` (a dynamic literal).
 *
 *  The clause pattern is `[^;'"]*?` — it may span LINES (this repo's imports are
 *  often multi-line, see `src/store/sessions.test.ts:3-16`) but may not cross a
 *  statement terminator or a quote, so two adjacent statements are never fused
 *  into one match. */
const specifiersOf = (source: string, want: "runtime" | "type"): string[] => {
  const found: string[] = [];

  const statements =
    /^[ \t]*(?:import|export)\b([^;'"]*?)\bfrom\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(statements)) {
    if (isTypeOnly(match[1]) === (want === "type")) found.push(match[2]);
  }

  // Dynamic `import("…")` — runtime by construction.
  if (want === "runtime") {
    const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of source.matchAll(dynamic)) found.push(match[1]);
  }

  return found;
};

/** Decide whether an `import`/`export … from` statement is TYPE-ONLY.
 *
 *  `import type { A } from` and `export type { A } from` → type-only.
 *  `export * from` and `export * as ns from` → RUNTIME (the star re-export
 *  executes the target). `export type * from` → type-only.
 *  `import { type A } from` → a clause whose bindings are ALL marked `type` is
 *  type-only (nothing survives compilation); a clause with even one unmarked
 *  binding is RUNTIME. That last case is what a naive `includes("type")` gets
 *  wrong, and it gets it wrong in the direction that HIDES a real edge — e.g.
 *  `import { type Foo, useBar } from "../store/x"` is a runtime edge. */
const isTypeOnly = (clause: string): boolean => {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return true;
  if (trimmed.startsWith("*")) return false;
  const braceOpen = trimmed.indexOf("{");
  const braceClose = trimmed.lastIndexOf("}");
  if (braceOpen === -1 || braceClose <= braceOpen) return false;
  const bindings = trimmed
    .slice(braceOpen + 1, braceClose)
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  if (bindings.length === 0) return false;
  return bindings.every((b) => /^type\s/.test(b));
};

/** The predicate the whole file exists to test: files under `src/lib/` with a
 *  RUNTIME edge into `src/store/` or `src/components/`. Exported for the mutation
 *  proof below — it is used over the tree AND over the allowlist.
 *
 *  A path that vanished between the `SOURCES` listing and this read yields `""`
 *  and so matches nothing — the true answer for a file that no longer exists, and
 *  `sourceSweep.ts` explains why that is a skip rather than a swallowed error. */
const runtimeUpwardImporters = (files: readonly string[]): string[] =>
  files
    .filter((file) => {
      const src = stripJsComments(sweep.listed(file) ?? "");
      return specifiersOf(src, "runtime")
        .map((spec) => resolveSpecifier(file, spec))
        .some((resolved) => resolved !== null && isUpperLayer(resolved));
    })
    .sort();

/** The same walk for TYPE-ONLY edges (documented, not convicted). */
const typeOnlyUpwardImporters = (files: readonly string[]): string[] =>
  files
    .filter((file) => {
      const src = stripJsComments(sweep.listed(file) ?? "");
      return specifiersOf(src, "type")
        .map((spec) => resolveSpecifier(file, spec))
        .some((resolved) => resolved !== null && isUpperLayer(resolved));
    })
    .sort();

/**
 * The pinned allowlist: the two `lib` modules allowed a runtime edge upward,
 * each with the reason. A literal, because a list recomputed from the tree
 * documents nothing (`tauriBoundary.test.ts`'s `PARALLEL_IPC_MODULES` is the
 * precedent).
 *
 * - `src/lib/settings.ts` — a DOM-application module (`applySettingsFont`,
 *   `applySettingsToDocument`, `loadAndApplySettings`: font and CSS custom
 *   properties on `document.documentElement`). Its ONE store import is a
 *   READ-ONLY `useSettings` (line 3) — it reads settings to paint the document,
 *   it does not drive store state, so the "misfiled store module" criterion that
 *   convicted `sessionLifecycle.ts` does not fit it. And `src/store/settings.ts`
 *   ALREADY EXISTS, so a move would need an invented name and a split of a
 *   module whose reason to live is `document`.
 *
 * - `src/lib/linkify.tsx` — renders `OpenAnchor` (line 2,
 *   `../components/OpenAnchor`) to turn autolink literals into openable anchors.
 *   An upward COMPONENT edge, deliberate and pinned: the component is a leaf
 *   render primitive, and inlining it into `lib` would duplicate the external
 *   link affordance (confirm-before-open) in two places.
 */
const ALLOWED: { file: string; reason: string }[] = [
  {
    file: "src/lib/settings.ts",
    reason:
      "DOM-application module; one READ-ONLY useSettings read (a legitimate lib resident, and src/store/settings.ts already exists)",
  },
  {
    file: "src/lib/linkify.tsx",
    reason:
      "renders OpenAnchor from ../components/OpenAnchor — a pinned render dependency on a leaf primitive",
  },
];

const ALLOWED_FILES = ALLOWED.map((a) => a.file).sort();

describe("the sweep survives a file that vanishes between listing and reading", () => {
  // THE SKIP BRANCH, DRIVEN ON PURPOSE — not a race attempt.
  //
  // THIS FILE IS EXPOSED TOO, and it is not one of the four named in the Wave-3
  // diagnosis. It walks `src/lib` RECURSIVELY, and the live palette guard writes
  // `src/lib/palettes/guardprobe.ts` — squarely inside that walk — then deletes it
  // from ANOTHER worker's `finally`. The listing this file takes at module scope
  // can therefore name a path that is gone by the time `runtimeUpwardImporters`
  // opens it, which is the same `ENOENT` that reddened `tauriBarrel.test.ts`.
  // Reproducing the collision needs full-suite scheduling, so this hands the REAL
  // predicate a listing it controls and deletes one path from under it. `.tmp/` is
  // gitignored and outside `src/`, so a probe cannot become a fake `lib` module in
  // the tree this census grades.
  const probe = ".tmp/layerSweep";
  /** An upward runtime edge — the shape this guard convicts. Written plainly:
   *  THIS file is a `.test.ts`, and tests are walked but EXEMPT by name (see
   *  `LIB_PRODUCTION`), so the scanner cannot convict its own scanner here the way
   *  it can in `tauriBarrel.test.ts`, where tests are in scope. */
  const upwardSource = (): string =>
    'import { useSettings } from "../../src/store/settings";\n';

  it("skips a listed file that disappears mid-sweep, and records it", () => {
    fs.mkdirSync(probe, { recursive: true });
    const real = `${probe}/real.ts`;
    const doomed = `${probe}/doomed.ts`;
    fs.writeFileSync(real, upwardSource());
    fs.writeFileSync(doomed, upwardSource());
    sweep.resetSkipped();
    try {
      // Pass 1: both exist, both are convicted. Without this, pass 2's shorter
      // list would not distinguish "skipped one" from "predicate reads nothing" —
      // the vacuity trap this file's own header says it exists to avoid.
      expect(runtimeUpwardImporters([real, doomed])).toEqual([doomed, real].sort());
      expect(sweep.skipped(), "nothing has vanished yet").toEqual([]);

      // Pass 2: the file is gone, the SAME listing is swept again.
      fs.rmSync(`${probe}/doomed.ts`, { force: true });
      expect(
        runtimeUpwardImporters([real, doomed]),
        "the vanished file is gone (it does not exist); the real one is still an offender",
      ).toEqual([real]);
      expect(sweep.skipped(), "the skip is recorded, never silent").toEqual([
        { file: doomed, code: "ENOENT" },
      ]);
    } finally {
      fs.rmSync(probe, { force: true, recursive: true });
      sweep.resetSkipped();
    }
  });

  it("reads a listed file that is PRESENT, so a leaked artifact is still graded", () => {
    // A leftover `guardprobe.ts` is PRESENT, so the census opens it. Tolerating a
    // vanishing path must not become tolerating a stray one.
    fs.mkdirSync(probe, { recursive: true });
    const leaked = `${probe}/leaked.ts`;
    fs.writeFileSync(leaked, upwardSource());
    sweep.resetSkipped();
    try {
      expect(runtimeUpwardImporters([leaked])).toEqual([leaked]);
      expect(sweep.skipped(), "a present file is never skipped").toEqual([]);
    } finally {
      fs.rmSync(leaked, { force: true });
      fs.rmSync(probe, { force: true, recursive: true });
    }
  });

  it("a NAMED path that is missing still throws (tolerance does not leak to literals)", () => {
    // The `ALLOWED` allowlist entries are literals. If the sweep went tolerant of
    // those, the stale-entry test above would go green on a tree where the
    // allowlisted module had been moved away.
    expect(() => sweep.named("src/lib/not-a-real-module.ts")).toThrow(/ENOENT|no such file/);
    expect(sweep.named("src/lib/settings.ts"), "a real allowlisted module still reads").toContain(
      "import",
    );
  });
});

describe("the lib layer boundary (FE2 census)", () => {
  it("the scanner actually reads the tree", () => {
    // Vacuity guard on the WALK — necessary, not sufficient (see the predicate
    // guard below, which is the one that matters).
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(SOURCES).toContain("src/lib/settings.ts");
    expect(SOURCES).toContain("src/lib/linkify.tsx");
    // Tests are walked (and exempted by name, not hidden).
    expect(SOURCES.some((f) => f.endsWith(".test.ts"))).toBe(true);
    expect(LIB_PRODUCTION.length).toBeLessThan(SOURCES.length);
    expect(LIB_PRODUCTION.length).toBeGreaterThan(50);
    // And the predicate finds SOMETHING in the tree before any allowlist is
    // consulted: if this is 0, the resolver or the layer prefix is broken and
    // every assertion below is green for the wrong reason.
    expect(runtimeUpwardImporters(SOURCES).length).toBeGreaterThan(0);
  });

  it("no lib module imports upward into store/ or components/ at runtime", () => {
    // THE guard. Offenders minus allowlist must be empty; an extra offender
    // reddens and NAMES itself.
    const offenders = runtimeUpwardImporters(LIB_PRODUCTION).filter(
      (f) => !ALLOWED_FILES.includes(f),
    );
    expect(offenders, "src/lib must not runtime-import src/store or src/components").toEqual(
      [],
    );
  });

  it("the offender set is exactly the allowlist (count pinned, not cancelled out)", () => {
    // A bare set-difference lets an addition and a removal cancel out. Pin the
    // full set both ways, and pin the count.
    const offenders = runtimeUpwardImporters(LIB_PRODUCTION);
    expect(offenders).toEqual(ALLOWED_FILES);
    expect(offenders.length).toBe(2);
  });

  it("the allowlist has no stale entries (a moved module must be removed from the list)", () => {
    // The other direction, asserted separately so a failure names the direction.
    const present = new Set(runtimeUpwardImporters(LIB_PRODUCTION));
    const stale = ALLOWED_FILES.filter((f) => !present.has(f));
    expect(
      stale,
      "these modules no longer import upward at runtime — shrink the allowlist",
    ).toEqual([]);
  });

  it("the predicate is NOT BLIND: it finds the allowlisted offenders itself", () => {
    // THE guard this file exists for. The SAME `runtimeUpwardImporters` instance
    // used above, run over the ALLOWED files. If it finds nothing, it matches
    // nothing anywhere, and the "no offenders" test is green because it is blind.
    const found = runtimeUpwardImporters(ALLOWED_FILES);
    expect(
      found.length,
      "the predicate matches nothing — it is blind, not satisfied",
    ).toBeGreaterThan(0);
    expect(found).toEqual(ALLOWED_FILES);
  });

  it("the module FE2 moved lives under store/ and is gone from lib/", () => {
    // Placement pin for the move this census was written alongside: the reason
    // `onSessionClosed` left `lib/` is that it DRIVES four stores. If it creeps
    // back, the runtime guard above reddens too — this names the cause.
    expect(SOURCES).not.toContain("src/lib/sessionLifecycle.ts");
    const storeSources = readdirSync("src/store", { recursive: true, encoding: "utf8" })
      .map((p) => relPath("src/store", p));
    expect(storeSources).toContain("src/store/sessionLifecycle.ts");
  });

  it("type-only upward edges stay a documented, unwidened set", () => {
    // Different severity, NOT invisible: `import type` erases under
    // `verbatimModuleSyntax`, so it cannot create a runtime cycle. Pinned as a
    // set so widening it is a decision taken here.
    expect(typeOnlyUpwardImporters(LIB_PRODUCTION)).toEqual([
      "src/lib/chatSessionDerivations.ts",
      "src/lib/sessionCost.ts",
    ]);
  });
});
