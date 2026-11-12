/**
 * THE SWEEP READER: how a source-scanning test opens a path it LISTED.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * Seven gates in this repo scan the source tree the same way: `readdirSync`
 * into a list, then a `readFileSync` per path in a later loop. That is two
 * syscalls separated by an interval, and the tree keeps moving through it —
 * vitest runs test FILES concurrently across workers, so while one worker is
 * between the listing and the reads another can be creating and deleting files.
 * The listing is a SNAPSHOT OF A TREE THAT IS STILL MOVING; the reader treats it
 * as stable, and gets `ENOENT` for a path that existed when it was listed.
 *
 * This branch made that live: the palette guard in
 * `paletteCompleteness.test.ts` writes `src/lib/palettes/guardprobe.ts` +
 * `src/styles/guardprobe.css` into the working tree and deletes them in a
 * `finally`, because the guard's whole point is that a row INSIDE the real
 * directory is discovered and graded. It cannot write anywhere else and still
 * test discovery. So a sibling sweep that listed `guardprobe.ts` and opened it
 * after the delete died with `ENOENT` — a red test file whose subject had never
 * done anything wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY SKIPPING IS THE TRUE ANSWER AND NOT A SWALLOWED ERROR
 * ---------------------------------------------------------------------------
 *
 * The sweep's contract is "every source file that EXISTS". A file that has been
 * deleted does not exist, so leaving it out is not a tolerated failure, it is
 * the correct reading of a tree that changed under the walk. Three consequences
 * keep that honest, and all three are asserted in `sourceSweep.test.ts`:
 *
 *  1. ONLY a vanished path is skipped. `ENOENT` (and, for `import()`,
 *     `ERR_MODULE_NOT_FOUND`) and nothing else. A permission error, an
 *     unreadable file, or a directory where a file was expected RE THROW —
 *     measured on this tree: opening a directory is `EISDIR`, a different code,
 *     so the filter is precise rather than generous.
 *  2. A PRESENT file is still read and still graded. The failure mode everyone
 *     cares about — a leaked `guardprobe.ts` riding into every gate — is
 *     untouched: a leftover is present, so it is opened. Only a file that
 *     DISAPPEARS is skipped.
 *  3. Every skip is RECORDED, by path. An unrecorded `catch { continue }` is
 *     the "pin that passes on the broken thing" this repo keeps writing about:
 *     it cannot be distinguished from a sweep that skipped the interesting
 *     file. `skipped()` makes the skip visible to an assertion.
 *
 * The race is not the palette guard's either, and this is not written only for
 * it: `docs/decisions/0034` and the scanner headers already document that this
 * tree gets walked while parallel worktrees, editors writing `*.sw?` swap files,
 * and build churn are touching it. A sweep that assumes a stable listing is
 * wrong for all of those, and the guard is simply the first thing on this branch
 * to move fast enough to hit it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TOLERANCE IS ATTACHED TO A PATH'S PROVENANCE
 * ---------------------------------------------------------------------------
 *
 * `listed()` and `named()` are deliberately different functions, because the
 * two kinds of path mean different things when they are missing:
 *
 *  - `listed(path)` — the path came out of a directory walk. It is a claim about
 *    what existed at listing time, so its absence can mean "it moved". Skip.
 *  - `named(path)` — the file under test is named by a literal (`src/lib/tauri.ts`,
 *    `src/lib/ipcError.ts`, an allowlist entry). Its absence is a BROKEN GUARD,
 *    not a moving tree, and it must be loud. Rethrow, always.
 *
 * Folding both into one tolerant reader would quietly un-gate every allowlist
 * entry and every "the file that owns this rule still exists" assertion in the
 * suite, which is a bigger loss than the flake it prevents.
 *
 * TEST-ONLY MODULE, like `cssSource.ts` and `paletteTestKit.ts`: it reads the
 * filesystem, so it must never enter the shipped graph. `node:fs` and `node:url`
 * come through COMPUTED specifiers because this app deliberately ships no
 * `@types/node` — the idiom every scanner in `src/lib/` already uses.
 */

const NODE_FS = "node:" + "fs";
const { readFileSync, existsSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
  existsSync: (path: string) => boolean;
};

/** One path the sweep left out, and the error code that made it do so. Kept as
 *  an object rather than a bare path so a failure message can show WHY. */
export type VanishedPath = { file: string; code: string };

/**
 * The error codes that mean "this path may be gone", one per reader.
 *
 *  `ENOENT` is `readFileSync`'s. `ERR_MODULE_NOT_FOUND` is what `import()` of a
 *  deleted file answers with — measured on this tree, the ESM loader does NOT
 *  surface it as `ENOENT`, so a reader that only knew the first code would let a
 *  vanished module through as a hard error. `ENOENT` is kept on the import side
 *  too: the loader has surfaced it directly for a path it could not stat.
 *
 *  For the READ side these codes are sufficient: the kernel said "no such file"
 *  about the path we were handed, and that is the whole question. For the IMPORT
 *  side they are NOT, and `listedModule` below has to ask a second question —
 *  see the comment there. */
const VANISHED_CODES: readonly string[] = ["ENOENT", "ERR_MODULE_NOT_FOUND"];

/** True when `error` is exactly "the path is gone".
 *
 *  Exported because the non-vacuity test must assert the FILTER, not just the
 *  conclusion: a `catch` that skipped everything and a `catch` that skips only
 *  this produce the same green on a healthy tree. */
export const isVanishedError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && VANISHED_CODES.includes(code);
};

/**
 * One sweep's reader + its skip ledger.
 *
 * Created per sweeping FILE, at module scope, next to the `readdirSync` whose
 * output it reads — so the ledger belongs to the walk it describes and a test
 * can read the skips for the sweep it just ran without tripping over another
 * file's.
 */
export const createSourceSweep = (): {
  /** Read a path that came out of a LISTING. `null` means it vanished between
   *  the listing and this read — the caller skips it. Anything else throws. */
  listed: (file: string) => string | null;
  /** `import()` a module that came out of a LISTING. `null` means it vanished
   *  between the listing and this import. A module that EXISTS and throws while
   *  being evaluated re throws — that is a broken file, not a moving tree. */
  listedModule: <T>(href: string, file: string) => Promise<T | null>;
  /** Read a path a LITERAL names. Missing is a hard error, never a skip. */
  named: (file: string) => string;
  /** Every path this sweep has skipped so far, oldest first. */
  skipped: () => VanishedPath[];
  /** Forget the ledger (a test that runs a sweep twice and wants only the
   *  skips from the second run). */
  resetSkipped: () => void;
} => {
  const vanished: VanishedPath[] = [];
  const record = (file: string, error: unknown): void => {
    const code = (error as { code?: unknown } | null)?.code;
    vanished.push({ file, code: typeof code === "string" ? code : "unknown" });
  };

  const listed = (file: string): string | null => {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      if (!isVanishedError(error)) throw error;
      record(file, error);
      return null;
    }
  };

  return {
    listed,
    listedModule: async <T>(href: string, file: string): Promise<T | null> => {
      try {
        return (await import(href)) as T;
      } catch (error) {
        if (!isVanishedError(error)) {
          // A module that EXISTS and throws while being evaluated. Discovery
          // must not silently drop a spec file that failed to load — that is the
          // exact failure `paletteTestKit.ts`'s header says it exists to close.
          throw error;
        }
        // The code alone is NOT sufficient here, and this is the subtle half of
        // this module. `paletteTestKit.ts` builds its specifier as
        // `new URL(\`./palettes/${name}\`, import.meta.url)`, and Vite rewrites
        // that expression when it TRANSFORMS the file. When `name` is a row the
        // transform-time glob never saw, the specifier resolves to
        // `…/src/lib/undefined` and the loader answers
        // `ERR_MODULE_NOT_FOUND` — MEASURED, and the identical code a genuinely
        // deleted row produces. Same code, opposite meanings: "the file went
        // away" (skip) versus "the module graph is looking at a stale directory"
        // (a broken sweep that must be loud).
        //
        // So ask the tree, not the error: if the row the listing named is STILL
        // THERE, nothing vanished and this is the stale-glob case — rethrow. The
        // palette guard depends on that case staying visible; its whole mechanism
        // is a query-busted kit import that re-transforms precisely so this
        // cannot happen silently.
        if (existsSync(file)) {
          const reason = (error as { message?: string } | null)?.message;
          // `cause` is set by assignment rather than the options bag: that is an
          // ES2022 `ErrorOptions` and this app targets ES2020, so the bag does not
          // typecheck here. The original error is still attached, so the message
          // below is a wrapper and never a replacement.
          const wrapped = new Error(
            `${file} was listed and is still on disk, but importing ${href} failed` +
              `${reason ? `: ${reason}` : ""} — the module graph is holding a STALE view of the` +
              ` directory. Re-import the sweeper with a cache-busting query so its glob is` +
              ` re-evaluated (see the live guard in paletteCompleteness.test.ts); do not skip this.`,
          );
          Object.assign(wrapped, { cause: error });
          throw wrapped;
        }
        record(file, error);
        return null;
      }
    },
    // Deliberately NOT wrapped in a try/catch. See the header: a path a literal
    // names is a claim about the tree, and a broken claim is a red test.
    named: (file: string): string => readFileSync(file, "utf8"),
    skipped: (): VanishedPath[] => vanished.slice(),
    resetSkipped: (): void => {
      vanished.length = 0;
    },
  };
};
