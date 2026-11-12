import { describe, expect, it } from "vitest";
import { createSourceSweep } from "./sourceSweep";

/**
 * THE IPC BOUNDARY GUARD (finding 12) — a source scanner, in the shape this repo
 * already runs (`tauriBarrel.test.ts`, `classNameConvention.test.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A DUPLICATE OF `tauriBarrel.test.ts`
 * ---------------------------------------------------------------------------
 *
 * The two guards pin OPPOSITE directions of the same seam, and only one of them
 * was ever written.
 *
 * `tauriBarrel.test.ts` guards INCOMING edges: nothing outside `lib/tauri/` may
 * import a domain module directly, because a large set of test files `vi.mock`
 * `@/lib/tauri` BY MODULE PATH (the count is pinned there, per follow-up item 9,
 * and lives nowhere else) and a direct import makes those mocks inert-but-green.
 *
 * This file guards OUTGOING edges: nothing outside the IPC modules may talk to
 * Tauri at all. Finding 12 praised that property as fact — "The `invoke` boundary
 * is genuinely respected (**0** call sites outside it)" — and that sentence is
 * repeated in the plan's B2 section. Both are MEASUREMENTS of one commit restated
 * as a property of the codebase, and nothing has enforced them since. A single
 * `invoke("delete_session", …)` typed into a component would keep every existing
 * test green: components mock `@/lib/tauri`, not `@tauri-apps/api/core`, so a
 * hand-rolled call simply bypasses the mock the test believes it is standing on.
 * That is the same green-and-lying failure `tauriBarrel.test.ts` was written for,
 * arriving from the other side of the seam.
 *
 * ---------------------------------------------------------------------------
 * THE 1,259-LINE SPLIT IS DONE. THIS IS THE HALF OF FINDING 12 IT LEFT BEHIND.
 * ---------------------------------------------------------------------------
 *
 * Finding 12 has three clauses: split the file (D1, shipped `9fa594e`→`c4c10a0`),
 * own the event names (B2, shipped `bc77cb8`), and — the clause nobody took —
 * "`lib/update.ts:77` and `lib/version.ts:1` are **undocumented parallel IPC
 * modules**". B2 explicitly handed that clause on: "organising those is D1's job".
 * D1's plan section does not mention either file, so the hand-off landed nowhere.
 *
 * This file is where it lands, as an executable decision rather than a prose note:
 * the two parallel modules are NAMED in the allowlist below, with the reason each
 * is allowed to stay outside the barrel. That converts "undocumented" into
 * "documented and pinned" — which is what finding 12 actually asked for — without
 * moving two small modules across a mock seam at the wrong moment. See the block on
 * `PARALLEL_IPC_MODULES` for why moving them is a separate decision, and follow-up
 * item 10 in `docs/roadmap/frontend-component-extraction-follow-ups.md`.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 *
 * Importing `@tauri-apps/api/core` (which is where `invoke` comes from) or
 * `@tauri-apps/api/event` (where `listen` comes from) is allowed ONLY in:
 *   - the domain modules under `src/lib/tauri/`, reached through the barrel, and
 *   - the two `PARALLEL_IPC_MODULES`, each with a stated reason.
 *
 * The barrel itself is NOT allowed — it is a pure re-export surface, and an
 * `import { invoke }` appearing there would mean the split leaked.
 *
 * `@tauri-apps/api/window` and the `plugin-*` packages are OUT OF SCOPE on
 * purpose, and the distinction is the interesting part of this file: they are a
 * DIFFERENT surface with a different failure mode. `getCurrentWindow()` is the
 * window shell (chrome buttons, tiling detection) and the dialog/opener plugins
 * are native affordances; none of them carries a Session's wire state, and none
 * of them is mocked through `@/lib/tauri`, so bypassing a mock is not the hazard
 * there. Pinning them too would fold an unrelated convention into a mock-seam
 * guard and make this file's failure message lie about which rule was broken.
 * The scoping assertion at the bottom keeps that boundary honest instead of
 * leaving it as an unwritten intention.
 */

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so
// a bare `import "node:fs"` does not typecheck. The idiom `cssSource.ts`,
// `themeTokens.test.ts` and `tauriBarrel.test.ts` use.
const NODE_FS = "node:" + "fs";
const { readdirSync } = (await import(NODE_FS)) as {
  readdirSync: (
    path: string,
    options: { recursive: true; encoding: string },
  ) => string[];
};
// Reads go through the SWEEP READER (see `sourceSweep.ts`): this file lists
// `src/` and opens every path in later loops, and vitest runs test files
// concurrently across workers, so a listed path can be deleted before the open.
const sweep = createSourceSweep();

/** The module, for the non-vacuity probe below — it CREATES and DELETES a scratch
 *  file so the skip branch can be driven on purpose instead of waited for.
 *  Reached through the same COMPUTED specifier (this app ships no `@types/node`). */
const NODE_FS_MODULE = (await import(NODE_FS)) as unknown as {
  writeFileSync: (path: string, data: string) => void;
  rmSync: (path: string, options?: { force?: boolean; recursive?: boolean }) => void;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
};
const fs = NODE_FS_MODULE;

/** `@tauri-apps/api/core`, SPLIT — and that is load-bearing, not style. This
 *  file's own `unmockedIpcTests` census scans TEST files for an `import`/`from`
 *  of the wire packages, and it does not care that the occurrence is inside a
 *  string literal. A probe source that spelled the specifier whole would make
 *  THIS FILE the offender its own guard reports, which is the exact trap
 *  `tauriBarrel.test.ts` records falling into (it counted 35 mockers where the
 *  tree held 33). Splitting the name keeps the probe invisible to the scanner
 *  that would otherwise convict the probe's author. */
const WIRE_PACKAGE = "@tauri-apps/api/" + "core";

/** Normalise a `readdirSync` result to `/`-spelled repo-relative paths. On
 *  Windows `readdirSync` returns BACKSLASH paths, which would break every
 *  comparison below; `tauriBarrel.test.ts` learned this on CI, where it reddened
 *  a vacuity guard on an unchanged tree. POSIX never emits `\` in a path. */
const relPath = (dir: string, p: string): string => `${dir}/${p.replace(/\\/g, "/")}`;

/** Every `.ts`/`.tsx` under `src/`, TESTS INCLUDED.
 *
 *  Tests are in scope for a different reason than they are in
 *  `tauriBarrel.test.ts`. There, a test importing a domain module bypasses its
 *  own mock. Here, a test that imports `@tauri-apps/api/core` is a legitimate
 *  case — those files mock `invoke` AT THAT PATH, which is how they pin a wire
 *  string as a literal — so the rule below exempts them EXPLICITLY and then
 *  re-checks them (see `unmockedIpcTests`) rather than hiding them from the walk.
 *  Hiding them would be the cheaper trick and the wrong one: a test that calls a
 *  real `invoke()` against a live shell is exactly the thing worth knowing about. */
const SOURCES = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((p) => /\.tsx?$/.test(p))
  .map((p) => relPath("src", p))
  .sort();

/** Strip comments before scanning: a doc-comment that MENTIONS `invoke(` is
 *  prose, not a call. `tauriBarrel.test.ts` and `themeTokens.test.ts` were both
 *  bitten by this — a comment naming a symbol reads as a consumer to a regex. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** The two packages that carry the wire surface.
 *
 *  Wrapped in the import shape (`from "…"` / `import("…")`), NOT matched bare.
 *  A bare match reads PROSE as a dependency: `tauriBarrel.test.ts` passes
 *  `"@tauri-apps/api/core"` as a string argument to its own path resolver, and
 *  the first version of this file flagged that as an unmocked IPC import. Same
 *  class of bug `themeTokens.test.ts` and `tauriBarrel.test.ts` both record being
 *  bitten by — a comment or a string that NAMES a symbol is not a consumer. */
const IPC_PACKAGES = /(?:\bfrom|\bimport)\s*\(?\s*["']@tauri-apps\/api\/(?:core|event)["']/;

/** The barrel — pure re-export surface, so it must import NOTHING. */
const BARREL = "src/lib/tauri.ts";

/** The domain modules, reached only through the barrel. */
const DOMAIN_DIR = "src/lib/tauri/";

/**
 * The two IPC modules that live outside the barrel, each with the reason it is
 * allowed to. This list is the DOCUMENTATION finding 12 asked for; it is a
 * literal because an allowlist recomputed from the tree documents nothing.
 *
 * WHY THEY ARE NOT MOVED INSIDE THE BARREL, which is the obvious next question:
 *
 * Both already have a WORKING mock seam of their own. `UpdateSection.test.tsx`
 * and `SettingsPage.test.tsx` `vi.mock` `@/lib/update` and `@/lib/version`
 * WHOLESALE (no `importActual`) — the one mock shape in this repo where a name
 * the factory forgets arrives as `undefined`. Re-pointing their consumers at
 * `@/lib/tauri` would mean those two factories stop being the seam, and the barrel
 * mockers do NOT mock `checkUpdate`/`installUpdate`/`relaunchApp`/`getAppInfo` — so every one of them would start resolving the real updater
 * wrappers. That is the precise green-and-lying regression `tauriBarrel.test.ts`
 * exists to prevent, manufactured deliberately.
 *
 * `update.test.ts` and `version.test.ts` also mock `@tauri-apps/api/core`
 * DIRECTLY to pin wire strings as literals, which the 2026-10-22 lesson records
 * as on purpose: "tauri.test.ts and update.test.ts pin event names as LITERALS
 * ON PURPOSE. Do NOT deduplicate them."
 *
 * So the move is not free and not obviously right, and it is not this file's
 * job. What IS this file's job: these two names cannot disappear, multiply, or
 * gain a third sibling without a commit that says so.
 */
const PARALLEL_IPC_MODULES = [
  // The updater: `check_update`, `install_update`, `relaunch_app` and the
  // `update://progress` listener. `installUpdate`'s promise NEVER resolves on
  // Windows (the process exits inside the Rust command) — a contract its own
  // module documents, and the reason these wrappers are not a trivial fold into
  // the barrel's session-shaped surface.
  "src/lib/update.ts",
  // `app_info` — one wrapper, and the version row's only source.
  "src/lib/version.ts",
];

/** Read a LISTED file, or `""` for one that vanished between the listing and
 *  this read. An empty text matches no predicate below, so the file drops out of
 *  the census — which is the true answer (it does not exist), and `sweep.listed`
 *  has already put the path in the skip ledger, so the drop is recorded rather
 *  than silent. See `sourceSweep.ts`. */
const readListed = (file: string): string => sweep.listed(file) ?? "";

/** Files that import an IPC package, tests excluded (they have their own rule).
 *  `files` defaults to the real listing and is a parameter so the non-vacuity
 *  test below can drive THIS predicate over a listing it controls — a vanished
 *  path, created and deleted on purpose — rather than hoping two workers collide. */
const productionIpcImporters = (files: readonly string[] = SOURCES): string[] =>
  files.filter(
    (f) =>
      !/\.test\.tsx?$/.test(f) &&
      IPC_PACKAGES.test(stripJsComments(readListed(f))),
  ).sort();

/** Tests that import an IPC package WITHOUT mocking that path in the same file.
 *  A test may legitimately import `invoke` to assert on it — but only if it
 *  mocked it, or it is talking to the real thing. */
const unmockedIpcTests = (): string[] =>
  SOURCES.filter((f) => {
    if (!/\.test\.tsx?$/.test(f)) return false;
    const src = stripJsComments(readListed(f));
    if (!IPC_PACKAGES.test(src)) return false;
    // Mocked at the IPC package path, at any depth of quoting.
    return !/vi\.mock\(\s*["']@tauri-apps\/api\/(?:core|event)["']/.test(src);
  }).sort();

describe("the sweep survives a file that vanishes between listing and reading", () => {
  // THE SKIP BRANCH, DRIVEN ON PURPOSE — not a race attempt. The real ENOENT
  // needs two workers to collide (the palette guard in
  // `paletteCompleteness.test.ts` deletes `src/lib/palettes/guardprobe.ts` from
  // another process), which the full suite reproduces occasionally and a single
  // file never can. So this hands `productionIpcImporters` a listing it controls
  // and removes one of the paths from under it. `.tmp/` is gitignored and outside
  // `src/`, so a probe can never become a fake source file in the tree the other
  // sweeps grade.
  const probe = ".tmp/tauriBoundarySweep";

  it("skips a listed file that disappears mid-sweep, and records it", () => {
    fs.mkdirSync(probe, { recursive: true });
    // The offender is planted alongside the doomed path so the SECOND pass proves
    // a SKIP and not a predicate that simply found nothing: the real offender
    // must survive.
    const real = `${probe}/wire.ts`;
    const doomed = `${probe}/doomed.ts`;
    const wireSource = (): string =>
      `import { invoke } from "${WIRE_PACKAGE}";\nexport const call = () => invoke("x");\n`;
    fs.writeFileSync(real, wireSource());
    fs.writeFileSync(doomed, wireSource());
    sweep.resetSkipped();
    try {
      // Pass 1 — both exist, both are convicted. Without this, pass 2's empty
      // list would be indistinguishable from a blind predicate.
      expect(productionIpcImporters([real, doomed])).toEqual([doomed, real].sort());
      expect(sweep.skipped(), "nothing has vanished yet").toEqual([]);

      // Pass 2 — one path is deleted, the SAME listing is swept again.
      fs.rmSync(`${probe}/doomed.ts`, { force: true });
      expect(
        productionIpcImporters([real, doomed]),
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

  it("reads a listed file that is PRESENT, so a leaked artifact is still caught", () => {
    // The failure everyone cares about: a stray file left in the tree by a killed
    // run is PRESENT, so it is opened and convicted. Tolerating a vanishing path
    // must not become tolerating a stray one.
    fs.mkdirSync(probe, { recursive: true });
    const leaked = `${probe}/leaked.ts`;
    fs.writeFileSync(
      leaked,
      `import { invoke } from "${WIRE_PACKAGE}";\nexport const call = () => invoke("x");\n`,
    );
    sweep.resetSkipped();
    try {
      expect(productionIpcImporters([leaked])).toEqual([leaked]);
      expect(sweep.skipped(), "a present file is never skipped").toEqual([]);
    } finally {
      fs.rmSync(leaked, { force: true });
      fs.rmSync(probe, { force: true, recursive: true });
    }
  });

  it("a NAMED path that is missing still throws (tolerance does not leak to literals)", () => {
    // `BARREL` and the `PARALLEL_IPC_MODULES` allowlist entries are named by
    // literals. If the sweep went tolerant of those, the allowlist's
    // stale-entry test and the barrel-imports-nothing test would go green while
    // reading nothing.
    expect(() => sweep.named("src/lib/not-a-real-barrel.ts")).toThrow(/ENOENT|no such file/);
    expect(sweep.named(BARREL), "the real barrel still reads").toContain("export");
  });
});

describe("the Tauri IPC boundary (finding 12)", () => {
  it("the scanner actually reads the tree", () => {
    // Vacuity guard — the failure `themeTokens.test.ts` records being bitten by.
    // Without this, a broken walk makes every rule below green for the wrong
    // reason, and a green guard that reads nothing is worse than no guard.
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES).toContain(BARREL);
    expect(SOURCES.some((f) => f.startsWith(DOMAIN_DIR))).toBe(true);
    expect(SOURCES.some((f) => f.endsWith(".test.tsx"))).toBe(true);
    // And the scanner's subject is present: if these reached 0, the regex or the
    // package name is broken and the allowlist comparison below is vacuous.
    expect(productionIpcImporters().length).toBeGreaterThan(0);
  });

  it("only the IPC modules import the Tauri wire packages", () => {
    // SET EQUALITY in both directions, the `classNameConvention.test.ts` idiom:
    // an extra file reddens as an offender, and a deleted one reddens as a stale
    // entry. A bare count would let an addition and a removal cancel out.
    const offenders = productionIpcImporters().filter(
      (f) => !f.startsWith(DOMAIN_DIR) && !PARALLEL_IPC_MODULES.includes(f),
    );
    expect(offenders, "talk to Tauri through @/lib/tauri").toEqual([]);
  });

  it("the allowlist has no stale entries (a moved module must be removed from the list)", () => {
    // The other direction, asserted separately so a failure names the direction.
    const present = new Set(productionIpcImporters());
    const stale = PARALLEL_IPC_MODULES.filter((f) => !present.has(f));
    expect(stale, "these parallel modules no longer import the IPC packages — shrink the allowlist").toEqual(
      [],
    );
  });

  it("the barrel itself IMPORTS nothing — it only re-exports", () => {
    // `tauriBarrel.test.ts` proves the barrel holds no `invoke`/`listen` CALL.
    // This proves it holds no IMPORT either, which is the stronger claim and the
    // one that catches a leaked implementation early: a stray
    // `import { invoke } from "@tauri-apps/api/core"` in a pure re-export surface
    // means a function crept back in, and it would still typecheck.
    //
    // Careful, because the obvious assertion is wrong: the barrel is ALL
    // `export { … } from "./tauri/…"` lines, so "no `from`" reddens on a healthy
    // barrel (it matched 11 re-exports when this was written). The rule is about
    // `import`, which a re-export surface never needs.
    const src = stripJsComments(sweep.named(BARREL));
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    // And the wire packages specifically, wherever they appear — the barrel must
    // not even name them, since naming one means something is being called here.
    expect(src).not.toMatch(/@tauri-apps\/api/);
  });
});

describe("the boundary holds against the shapes a reader would not notice", () => {
  it("no production file outside the allowlist even NAMES the wire packages", () => {
    // WHY THIS IS STRICTER THAN THE RULE ABOVE, and why the stricter version is
    // the one that matters. The first version of this file matched the import
    // SHAPE (`from "@tauri-apps/api/core"`). That was demonstrated to be
    // bypassable by the idiom this repo's OWN scanners use to reach `node:fs`:
    //
    //     const CORE = "@tauri-apps/api/" + "core";
    //     const { invoke } = await import(CORE);
    //
    // That compiles, `pnpm build` is green, and it matched nothing — the
    // specifier is no longer a literal in the source. A guard that can be walked
    // past by concatenating a string is not a guard, so the rule is now about the
    // PACKAGE NAME APPEARING AT ALL, in any form, not about how it is imported.
    //
    // What this cannot catch is a specifier assembled from fragments that never
    // individually spell the package (`"@tauri-apps/" + verb + "core"`), or any
    // other deliberate obfuscation. That is the honest ceiling of a source
    // scanner: it defends against a mistake and against someone not thinking
    // about the seam, not against someone determined to hide a call. The
    // deliberate case is what the PR review is for; the accidental case is 100%
    // of the history this file was written for.
    //
    // ONE PREDICATE, used twice — over the offenders and over the allowed files.
    // The first version asserted over a literal here and a *second copy* of the
    // literal in the guard below, and a mutation test proved the consequence:
    // corrupting the offender predicate left all seven tests green, because the
    // guard was checking its own untouched copy rather than the thing under test.
    // A vacuity guard that does not share the predicate is decoration.
    //
    // `@tauri-apps/api/window` is removed first (see the scope test below) so
    // that the two components legitimately importing it do not make this red.
    const namesWirePackages = (file: string): boolean =>
      stripJsComments(readListed(file))
        .replace(/@tauri-apps\/api\/window|@tauri-apps\/plugin-[a-z-]+/g, "")
        .includes("@tauri-apps/api/");

    const offenders = SOURCES.filter(
      (f) =>
        !/\.test\.tsx?$/.test(f) &&
        !f.startsWith(DOMAIN_DIR) &&
        !PARALLEL_IPC_MODULES.includes(f) &&
        namesWirePackages(f),
    ).sort();
    expect(offenders, "talk to Tauri through @/lib/tauri").toEqual([]);

    // Vacuity guard, in the direction the allowlist makes it easy to get wrong:
    // the SAME predicate run over the ALLOWED files must find them. If it finds
    // nothing, it matches nothing anywhere and the assertion above is green
    // because it is blind — the failure `themeTokens.test.ts` records being
    // bitten by.
    const allowed = [...SOURCES.filter((f) => f.startsWith(DOMAIN_DIR)), ...PARALLEL_IPC_MODULES].filter(
      namesWirePackages,
    );
    expect(allowed.length, "the predicate matches nothing — it is blind, not satisfied").toBeGreaterThan(
      0,
    );
  });
});

describe("the boundary's declared scope (so its silence is not an accident)", () => {
  it("the window shell and plugin packages stay out of scope, on purpose", () => {
    // Asserted, not asserted-away: these DO reach Tauri from components, and this
    // file deliberately does not police them. If that scoping is ever revisited,
    // this test is the place the decision gets made visible rather than quietly
    // widened by someone adding a regex.
    const windowShell = SOURCES.filter(
      (f) =>
        !/\.test\.tsx?$/.test(f) &&
        /(?:\bfrom|\bimport)\s*\(?\s*["']@tauri-apps\/api\/window["']/.test(
          stripJsComments(readListed(f)),
        ),
    );
    expect(windowShell.sort()).toEqual([
      // The chrome buttons and the tiling/snap detector. Window geometry, not
      // Session wire state — and neither is reachable through `@/lib/tauri`.
      "src/components/WindowControls.tsx",
      "src/hooks/useWindowMaximized.ts",
    ]);
  });
});

describe("test files that touch the IPC packages mock them", () => {
  it("no test imports `invoke`/`listen` without mocking that path", () => {
    // The suite's standing convention: `vi.mock("@tauri-apps/api/core", () =>
    // ({ invoke: vi.fn() }))`. A test that skips it is calling through to a real
    // shell, which in jsdom means a rejected promise that a loose `await`
    // swallows. Pinned as a set so a new offender is named, not averaged out.
    expect(unmockedIpcTests()).toEqual([]);
  });
});
