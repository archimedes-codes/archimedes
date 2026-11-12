import { describe, expect, it } from "vitest";
import { createSourceSweep, isVanishedError } from "./sourceSweep";

/**
 * THE SWEEP READER'S OWN CONTRACT — and the non-vacuity proof the race fix
 * depends on.
 *
 * A `try { read } catch { continue }` is trivially green on a healthy tree, and
 * a `catch` that skips EVERYTHING is indistinguishable from it. So this file
 * does not test "the suite is green"; it tests the three things that separate a
 * correct skip from a swallowed error, each on a path this test creates and
 * destroys itself — no timing, no worker scheduling, no sleep:
 *
 *   1. the skip branch is REACHABLE and returns "not there" rather than throwing;
 *   2. the skip is RECORDED, so it can never be silently always-empty;
 *   3. the skip is the ONLY thing the reader tolerates — a directory, a
 *      permission error, or an unreadable file still throws.
 *
 * The scratch files live under `.tmp/` (gitignored, outside `src/`), so this
 * file cannot plant a fake source file into the tree the other sweeps grade —
 * the mistake the palette guard has to accept and this one does not have to.
 */

const NODE_FS = "node:" + "fs";
const fs = (await import(NODE_FS)) as unknown as {
  writeFileSync: (path: string, data: string) => void;
  rmSync: (
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ) => void;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  chmodSync: (path: string, mode: number) => void;
};
const NODE_URL = "node:" + "url";
const { pathToFileURL } = (await import(NODE_URL)) as {
  pathToFileURL: (path: string) => URL;
};
const NODE_PATH = "node:" + "path";
const { resolve } = (await import(NODE_PATH)) as {
  resolve: (...parts: string[]) => string;
};

const SCRATCH = ".tmp/sourceSweep";
const scratch = (name: string): string => resolve(SCRATCH, name);

/** Write a scratch file and hand back its repo-relative path. */
const plant = (name: string, body = "export const sweepProbe = 1;\n"): string => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const rel = `${SCRATCH}/${name}`;
  fs.writeFileSync(scratch(name), body);
  return rel;
};

describe("the sweep reader: a path that vanishes between listing and reading", () => {
  it("skips a listed file that was deleted before the read, and records it", () => {
    // THE branch, made reachable on purpose: create → list → delete → read.
    // This is the exact sequence the palette guard produces when a worker is
    // scheduled between two other workers' syscalls, run here without a race.
    const sweep = createSourceSweep();
    const rel = plant("vanished.ts");

    // Listed while it exists — the same claim `readdirSync` makes.
    expect(sweep.listed(rel)).toBe("export const sweepProbe = 1;\n");

    // Now delete it and read AGAIN, which is what the second pass of a sweep
    // does to a path a concurrent worker has just removed.
    fs.rmSync(scratch("vanished.ts"), { force: true });
    expect(sweep.listed(rel)).toBeNull();

    // And the skip is VISIBLE, not silently always-empty: the ledger names the
    // path and the code that made the reader give up on it.
    expect(sweep.skipped()).toEqual([{ file: rel, code: "ENOENT" }]);

    fs.rmSync(SCRATCH, { force: true, recursive: true });
  });

  it("reads a file that is PRESENT, so a leaked artifact is still graded", () => {
    // The half that keeps this from being a way to hide things. A leftover
    // `guardprobe.ts` is PRESENT, so the sweep opens it — the failure mode
    // everyone cares about is untouched by the skip branch.
    const sweep = createSourceSweep();
    const rel = plant("present.ts", "export const leaked = \"guardprobe\";\n");
    try {
      expect(sweep.listed(rel)).toContain("guardprobe");
      expect(sweep.skipped(), "a present file must never be skipped").toEqual([]);
    } finally {
      fs.rmSync(scratch("present.ts"), { force: true });
    }
  });

  it("rethrows anything that is not a vanished path (a tolerant reader is not a blind one)", () => {
    const sweep = createSourceSweep();
    fs.mkdirSync(SCRATCH, { recursive: true });

    // A DIRECTORY where a file was expected: measured on this tree, `EISDIR`,
    // not `ENOENT` — so the filter is precise rather than "any read error".
    let dirCode = "NO-THROW";
    try {
      sweep.listed("src/lib/palettes");
    } catch (error) {
      dirCode = String((error as { code?: string }).code);
    }
    expect(dirCode, "reading a directory must not be skipped").toBe("EISDIR");
    expect(isVanishedError({ code: "EISDIR" })).toBe(false);

    // An unreadable file (mode 0). Skipped on root / CI-as-root, where chmod 0
    // still reads — and said out loud rather than passed off as coverage.
    const rel = plant("unreadable.ts");
    let modeCode = "NO-THROW";
    try {
      fs.chmodSync(scratch("unreadable.ts"), 0o000);
      sweep.listed(rel);
    } catch (error) {
      modeCode = String((error as { code?: string }).code);
    } finally {
      fs.chmodSync(scratch("unreadable.ts"), 0o644);
      fs.rmSync(scratch("unreadable.ts"), { force: true });
    }
    if (modeCode === "EACCES") {
      expect(isVanishedError({ code: "EACCES" })).toBe(false);
    } else {
      expect(
        modeCode,
        `expected EACCES or a successful read (running as root?); saw ${modeCode}`,
      ).toBe("NO-THROW");
    }

    // A path that NEVER existed is still ENOENT, and skipping it is correct for
    // a listing-derived path — the ledger is what makes that auditable.
    expect(sweep.listed(`${SCRATCH}/never-existed.ts`)).toBeNull();
    expect(sweep.skipped().map((v) => v.code)).toEqual(["ENOENT"]);

    fs.rmSync(SCRATCH, { force: true, recursive: true });
  });
});

describe("the sweep reader: two kinds of path, two different rules", () => {
  it("named() treats a missing literal as a hard error, never a skip", () => {
    // `src/lib/tauri.ts` and every allowlist entry are named, not listed. Their
    // absence means the GUARD is broken, not that the tree moved, so it must be
    // loud. This is the assertion that stops the tolerance spreading.
    const sweep = createSourceSweep();
    let shape = "NO-THROW";
    try {
      sweep.named("src/lib/definitely-not-a-real-module.ts");
    } catch (error) {
      shape = `code=${String((error as { code?: string }).code)}`;
    }
    expect(shape).toBe("code=ENOENT");
    expect(
      sweep.skipped(),
      "a named path must never land in the skip ledger",
    ).toEqual([]);

    // And a named path that DOES exist reads fine — the guard is not simply
    // throwing on everything.
    expect(sweep.named("src/lib/sourceSweep.test.ts")).toContain("createSourceSweep");
  });

  it("resets the ledger on request, so a re-run reports only its own skips", () => {
    const sweep = createSourceSweep();
    expect(sweep.listed(`${SCRATCH}/absent.ts`)).toBeNull();
    expect(sweep.skipped()).toHaveLength(1);
    sweep.resetSkipped();
    expect(sweep.skipped()).toEqual([]);
  });
});

describe("the sweep reader: the list-then-import shape (palette discovery)", () => {
  it("skips a module deleted after the listing, and records it", async () => {
    // `listPaletteSpecs` does not read a listed file, it IMPORTS it, and the ESM
    // loader answers a deleted path with `ERR_MODULE_NOT_FOUND`, not `ENOENT`
    // (measured). A reader that only knew `ENOENT` would let this through as a
    // hard error — which is a second instance of the same race, in the directory
    // the palette guard actually writes into.
    const sweep = createSourceSweep();
    const rel = plant("vanishedModule.mjs");
    const href = pathToFileURL(scratch("vanishedModule.mjs")).href;
    const healthy = await sweep.listedModule<{ sweepProbe: number }>(href, rel);
    // Asserted on the export, not on the namespace object: a module namespace
    // carries keys (`default`, interop markers) are not part of what the sweep
    // reads, and a deep-equal here would be about Vite, not about us.
    expect(healthy?.sweepProbe).toBe(1);

    // Now a SECOND path, planted and deleted WITHOUT ever being imported: the
    // ESM loader caches by href, so re-importing the href above would answer from
    // the cache and prove nothing about the missing file.
    const goneRel = `${SCRATCH}/goneBeforeFirstImport.mjs`;
    plant("goneBeforeFirstImport.mjs");
    const goneHref = pathToFileURL(scratch("goneBeforeFirstImport.mjs")).href;
    fs.rmSync(scratch("goneBeforeFirstImport.mjs"), { force: true });
    expect(await sweep.listedModule(goneHref, goneRel)).toBeNull();
    expect(sweep.skipped()).toEqual([
      { file: goneRel, code: "ERR_MODULE_NOT_FOUND" },
    ]);

    fs.rmSync(SCRATCH, { force: true, recursive: true });
  });

  it("rethrows a module that EXISTS and fails to evaluate (a broken file is not a moving tree)", async () => {
    // THE ceiling of the import-side tolerance, and the reason it is not a
    // blanket catch. `paletteTestKit.ts`'s header says a spec file that quietly
    // failed to load would leave its Palette ungraded — so a module that throws
    // while being evaluated must stay loud.
    const sweep = createSourceSweep();
    const rel = plant("broken.mjs", 'throw new Error("broken-at-module-evaluation");\n');
    let shape = "NO-THROW";
    try {
      await sweep.listedModule(pathToFileURL(scratch("broken.mjs")).href, rel);
    } catch (error) {
      shape = String((error as Error).message);
    }
    expect(shape).toContain("broken-at-module-evaluation");
    expect(sweep.skipped(), "a broken module must never be skipped").toEqual([]);
    fs.rmSync(SCRATCH, { force: true, recursive: true });
  });

  it("rethrows a NOT-FOUND for a row that is still on disk: the stale-glob case stays loud", async () => {
    // The dangerous ambiguity, and the reason `listedModule` asks the tree and
    // not the error. `paletteTestKit.ts` builds
    // `new URL(\`./palettes/${name}\`, import.meta.url)`; Vite rewrites that at
    // TRANSFORM time, so a row the transform-time glob never saw resolves to
    // `…/src/lib/undefined` and answers `ERR_MODULE_NOT_FOUND` — the SAME code a
    // deleted row answers with. A code-only skip would swallow it, and discovery
    // would then report a Palette that simply was not there, which is the exact
    // silent-green this repo keeps writing about. Deterministic reproduction:
    // the specifier the stale glob produces, pointed at a file that exists.
    const sweep = createSourceSweep();
    const rel = plant("stillThere.mjs");
    // The kit's exact shape: a COMPUTED specifier, so Vite rewrites it against
    // the glob it saw when it transformed THIS file. Nothing named like this
    // existed then, so the href degrades to `…/src/lib/undefined` and the loader
    // answers `ERR_MODULE_NOT_FOUND` for a row that is on disk right now.
    const staleName = "aRowTheGlobNeverSaw.ts";
    const staleHref = new URL(`./palettes/${staleName}`, import.meta.url).href;

    let shape = "NO-THROW";
    try {
      await sweep.listedModule(staleHref, rel);
    } catch (error) {
      shape = String((error as Error).message);
    }
    expect(shape).toContain("STALE");
    expect(shape).toContain(rel);
    expect(
      sweep.skipped(),
      "a stale glob must never be recorded as a vanished path",
    ).toEqual([]);

    fs.rmSync(SCRATCH, { force: true, recursive: true });
  });
});
