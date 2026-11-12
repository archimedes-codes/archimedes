import { describe, expect, it } from "vitest";
import { createSourceSweep } from "./sourceSweep";

/**
 * THE `lib/tauri` BARREL GUARD (finding 12a, Task D1) — a source scanner, not a
 * linter, in the shape this repo already runs (`classNameConvention.test.ts`,
 * `themeTokens.test.ts`, `chromeButton.test.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE ACCEPTANCE CRITERION, NOT A FORMALITY
 * ---------------------------------------------------------------------------
 *
 * `src/lib/tauri.ts` was split by domain into `src/lib/tauri/*.ts`. It survives
 * as a RE-EXPORT BARREL for one reason: **many test files `vi.mock`
 * `@/lib/tauri` BY MODULE PATH** (most spreading `vi.importActual` — both counts
 * are pinned by the assertion below rather than carried by hand; the header used
 * to also state how many mockers there were and how many named `vi.fn()`
 * overrides sit inside those factories, and both had gone stale, so it no longer
 * does). A `vi.mock` on a module path intercepts only the calls
 * that travel THROUGH that path. So the moment any consumer imports a
 * moved function from `lib/tauri/sessions.ts` directly, every test that mocked
 * it through `@/lib/tauri` **silently stops intercepting — and still passes,
 * against real IPC.** That is the worst possible failure mode of this refactor:
 * green, and lying.
 *
 * A reviewer cannot catch that by reading a diff, and the test suite cannot
 * catch it by running. Only a scanner over the import graph can, and only one
 * that ALSO covers the test files (a test that imports a domain module bypasses
 * its own mock — the exact bug, from the other side). So unlike
 * `classNameConvention.test.ts`, which deliberately excludes tests, THIS scanner
 * includes them.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 *
 * The only files allowed to import from inside `src/lib/tauri/` are:
 *   - the barrel itself (`src/lib/tauri.ts`), and
 *   - the domain modules inside `src/lib/tauri/`.
 *
 * Everything else in `src/` — component, hook, store, or test — imports
 * `@/lib/tauri` (or a relative path that resolves to it). The barrel is not an
 * organizational nicety; it is the mock seam the suite rests on.
 */

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so
// a bare `import "node:fs"` does not typecheck. The idiom `cssSource.ts`,
// `themeTokens.test.ts` and `classNameConvention.test.ts` use.
const NODE_FS = "node:" + "fs";
const { readdirSync, existsSync } = (await import(NODE_FS)) as {
  readdirSync: (
    path: string,
    options: { recursive: true; encoding: string },
  ) => string[];
  existsSync: (path: string) => boolean;
};
// Reads go through the SWEEP READER, not `readFileSync`: this file lists `src/`
// and then opens every path in a later loop, and vitest runs test files
// concurrently, so a path can be deleted between the two. See `sourceSweep.ts`
// for why skipping a vanished path is the true answer and what stays loud.
const sweep = createSourceSweep();

/** The module, for the non-vacuity probe below — it CREATES and DELETES a scratch
 *  file so the skip branch can be driven on purpose instead of waited for.
 *  Reached through the same COMPUTED specifier (no `@types/node` in this app). */
const NODE_FS_MODULE = (await import(NODE_FS)) as unknown as {
  writeFileSync: (path: string, data: string) => void;
  rmSync: (path: string, options?: { force?: boolean; recursive?: boolean }) => void;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
};

const BARREL = "src/lib/tauri.ts";
const DIR = "src/lib/tauri";

/** Normalise a `readdirSync` result to the `/`-spelled repo-relative paths every
 *  path this file compares is written in. On Windows `readdirSync` returns
 *  BACKSLASH paths, so the bare `src/${p}` mapping produced
 *  `src\lib\tauri.ts` and the vacuity guard's `toContain(BARREL)` reddened on a
 *  tree nothing had changed; `resolve()` also splits importers on `/`, so a
 *  backslash importer resolved to the wrong module and would have made the
 *  bypass guard itself blind. POSIX never emits `\` in a path, so this is a
 *  no-op there. CI caught it; every local run is POSIX. */
const relPath = (dir: string, p: string): string => `${dir}/${p.replace(/\\/g, "/")}`;

/** EVERY `.ts`/`.tsx` under `src/` — tests INCLUDED, see the header. */
const SOURCES = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((p) => /\.tsx?$/.test(p))
  .map((p) => relPath("src", p))
  .sort();

/** Strip comments before scanning: a doc-comment that MENTIONS
 *  `lib/tauri/sessions` is prose, not an import — the
 *  `themeTokens.test.ts:697` lesson. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** Any module specifier: `from "…"`, `import("…")`, `import type … from "…"`. */
const SPECIFIER =
  /(?:\bfrom|\bimport)\s*\(?\s*(["'])((?:[^"'\\]|\\.)+)\1/g;

/** Resolve a specifier the way the bundler's `@` alias + Node resolution do.
 *  Returns the repo-relative path it points at, or `null` for a bare package. */
const resolve = (importer: string, spec: string): string | null => {
  let base: string;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    const parts = importer.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === ".") continue;
      else if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    base = parts.join("/");
  } else return null;
  // Extension candidates BEFORE the bare path, and before a directory: that is
  // Vite/`bundler` resolution order, and it matters here — once the split
  // lands, BOTH `src/lib/tauri.ts` and the directory `src/lib/tauri/` exist, and
  // resolving `./tauri` to the directory would hide every real edge.
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    if (existsSync(cand)) return cand;
  }
  return `${base} (unresolved)`;
};

/** Every edge that reaches INTO `src/lib/tauri/` from outside the allowed set.
 *  A path that vanished between the `SOURCES` listing and this read is skipped
 *  and recorded (see `sourceSweep.ts`); it is not an offender, it is gone.
 *
 *  `files` is a parameter rather than a read of `SOURCES` inside the loop, so the
 *  non-vacuity test below can drive THIS predicate — the one the guard runs, not
 *  a copy of it — over a listing it controls. Defaulting to `SOURCES` keeps every
 *  real call site unchanged. */
const directDomainImports = (files: readonly string[] = SOURCES): string[] => {
  const offenders: string[] = [];
  for (const file of files) {
    if (file === BARREL || file.startsWith(`${DIR}/`)) continue;
    const text = sweep.listed(file);
    if (text === null) continue;
    const src = stripJsComments(text);
    for (const match of src.matchAll(SPECIFIER)) {
      const resolved = resolve(file, match[2]!);
      if (resolved && resolved.startsWith(`${DIR}/`)) {
        const line = src.slice(0, match.index ?? 0).split("\n").length;
        offenders.push(`${file}:${line} → ${resolved}`);
      }
    }
  }
  return offenders.sort();
};

/** How a name-scan helper reads: `sweep.named` for a path a literal names,
 *  `sweep.listed` for one that came out of `domainModules()`. */
type SweepRead = (file: string) => string | null;

/** The names a file declares as exports (the scanner's view of a module's API).
 *  Returns `[]` for a listed file that vanished — see `sourceSweep.ts`. */
const exportedNames = (file: string, read: SweepRead = (f) => sweep.named(f)): string[] => {
  const text = read(file);
  if (text === null) return [];
  return text
    .split("\n")
    .flatMap((line) => {
      const m = line.match(
        /^export (?:declare )?(?:async function|function|interface|type|const|let|class) ([A-Za-z0-9_]+)/,
      );
      return m ? [m[1]!] : [];
    });
};

/** The names a file RE-EXPORTS: `export { a, b as c } from "…"` and
 *  `export type { a } from "…"` and `export * from "…"`. */
const reexportedNames = (
  file: string,
  read: SweepRead = (f) => sweep.named(f),
): string[] => {
  const text = read(file);
  if (text === null) return [];
  const src = stripJsComments(text);
  const names: string[] = [];
  for (const m of src.matchAll(
    /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from/g,
  )) {
    for (const part of m[1]!.split(",")) {
      const token = part.trim();
      if (!token) continue;
      const as = token.split(/\s+as\s+/);
      names.push((as[1] ?? as[0]!).trim());
    }
  }
  return names.sort();
};

/** The domain modules that exist right now (tests excluded — they declare
 *  nothing the barrel forwards). */
const domainModules = (): string[] =>
  existsSync(DIR)
    ? readdirSync(DIR, { recursive: true, encoding: "utf8" })
        .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
        .map((p) => relPath(DIR, p))
        .sort()
    : [];

/** --------------------------------------------------------------------------
 * THE PINNED PUBLIC API.
 *
 * The list below is the export set of `src/lib/tauri.ts` — a LITERAL on
 * purpose, for the same reason `tauri.test.ts` pins command names as literals
 * and `ipc/events.test.ts` refuses to read `IPC_EVENTS` back: recomputing the
 * expectation from the file under test makes the guard green on any change. A
 * name may only enter or leave this list on purpose, in a commit that says so.
 *
 * It measures 133 names as of issue #126/#127/#132 (the provider-auth suite: 6
 * runtime wrappers + 6 type-only wire names). The header used to claim "107
 * names: 58 types + 49 functions" — prose describing a long-past commit that no
 * assertion reads; the ARRAY is the expectation, so the prose is gone rather
 * than perpetually stale.
 * -------------------------------------------------------------------------- */
const TAURI_PUBLIC_API = [
  "AccessPolicy",
  // (permissions-section T05) The two rule-model type names, added ON PURPOSE
  // per the header above: `FilePolicy.rules` is `AccessRule[]` and a rule's
  // `direction` is `AccessDirection`. Type-only — they vanish at runtime, so
  // `TAURI_RUNTIME_API` does NOT gain them.
  "AccessDirection",
  "AccessRule",
  "AcpSessionUpdate",
  "AcpToolCallStatus",
  "AgentDefinitionDto",
  "AgentDefinitionReportDto",
  // (issue #101) The declared-`permission:` wire types, added ON PURPOSE per the
  // header above. `AgentDefinitionReportDto.filePermission` is `AgentPermissionBlock | null`
  // and `.frontmatterNotes` is `AgentFrontmatterNote[]`; the block is an ordered
  // array of `[AgentToolKey, AgentPermissionRules]` pairs whose rules are
  // `AgentPermissionRule`s carrying an `AgentPermissionAction`, and a note's
  // unsupported arm carries an `AgentUnsupportedReason`. All SEVEN are type-only —
  // they vanish at runtime, so `TAURI_RUNTIME_API` does NOT gain them, exactly as
  // `AccessDirection`/`AccessRule` above.
  "AgentFrontmatterNote",
  "AgentNameResolution",
  "AgentOverride",
  "AgentOverrideFields",
  "AgentOverrides",
  "AgentOverrideSources",
  "AgentPermissionAction",
  "AgentPermissionBlock",
  "AgentPermissionRule",
  "AgentPermissionRules",
  "AgentToolKey",
  "AgentUnsupportedReason",
  "AppSettings",
  "AskQuestionDto",
  "AskResponsePayload",
  // (attention-alert click route, T2) The `attention-alert-clicked` payload —
  // the session id an alert's body click navigates to. TYPE-ONLY: it vanishes at
  // runtime, so `TAURI_RUNTIME_API` does NOT gain it (the
  // `AccessRule`/`AccessDirection` precedent); its wrapper
  // `listenAttentionAlertClicked` DOES, among the `listen*` entries below.
  "AttentionAlertClickedPayload",
  // (issue #180 D1, spec §1, ADR 0100) The two Task-artifact wire shapes, added ON
  // PURPOSE per the header above. TYPE-ONLY — they vanish at runtime, so
  // `TAURI_RUNTIME_API` does NOT gain them (the `AccessRule`/`AccessDirection`
  // precedent). `Artifact` is the ONLY shape that carries artifact CONTENT and it
  // arrives from the single-artifact read alone; `ArtifactMeta` is what a write
  // answers with, deliberately without the content. The two command wrappers
  // (`writeArtifact`, `getArtifact`) are runtime values and enter BOTH lists, below.
  "Artifact",
  "ArtifactMeta",
  "attentionArm",
  "attentionDisarm",
  "authMcpServer",
  "cancelSession",
  "CloseReasonStr",
  "closeSession",
  "compactSession",
  // (task07a / finding 4) The compaction trigger vocabulary, added ON PURPOSE
  // per the header above: the `compaction_update` frame's `reason` field and
  // the store's `compacting` value are both this union, so the frame type
  // forces its return-type presence in the public surface. TYPE-ONLY — it
  // vanishes at runtime, so `TAURI_RUNTIME_API` does NOT gain it, exactly as
  // `AccessDirection`/`AccessRule` and the issue #101 seven above.
  "CompactionReason",
  "CompletionDirDto",
  "CompletionEntryDto",
  "ContentBlock",
  // (Task board, ADR 0090) The board command wrappers enter BOTH lists (they are
  // runtime values) and the FIVE wire shapes enter THIS list only (type-only,
  // the `AccessRule`/`AccessDirection` precedent). They land in the same commit as
  // the `src/lib/tauri.ts` re-export lines, per this file's own rule that a name
  // may only enter on purpose, in a commit that says so — `reorderTasks` entered
  // both in the commit that added its wrapper, and `startTaskSession` (A4, spec
  // §3) entered both in the commit that added its wrapper and its re-export.
  //
  // (issue #179, ADRs 0098 + 0099) The eight Stage/board-strict wrappers join it
  // here: six Stage verbs returning the already-pinned `StageRow`, plus the
  // Strict-workflow pair returning `void`/`boolean`. NO new TYPE name enters —
  // `StageRow` gains two FIELDS in the same commit, and widening an existing
  // interface moves neither list.
  "createStage",
  "createTask",
  "deleteSession",
  "deleteSpace",
  // (issue #179) Deletes a column; `deleteStage` refuses rather than stranding
  // cards, and the refusal sentence is the UI (see the wrapper's doc).
  "deleteStage",
  "editTask",
  "externalOpen",
  "FilePolicy",
  "FontSettings",
  // (issue #180 D1, spec §1) The artifact READ — the one call that brings artifact
  // content over the wire. Returns `Artifact | null`: a missing artifact and a
  // missing Task both answer `null` (absence is an answer, not an error).
  "getArtifact",
  "getBoard",
  // (issue #179) The Strict-workflow READ — the Switch seed that must agree with
  // the flag `move_task` enforces. Returns a primitive `boolean`, so no type name.
  "getBoardStrict",
  "getProviderBudget",
  "getSettings",
  "getTask",
  "getWindowState",
  // (attention-alert click route, T2) The window raise the alert's body click
  // asks for. A RUNTIME value (a command wrapper, no payload), so it enters BOTH
  // lists; no TYPE name enters with it.
  "raiseAttentionWindow",
  "HistoryPage",
  "InteractiveEventPayload",
  "InteractiveRequestClosePayload",
  "InteractiveRequestPayload",
  "InteractiveResponseDto",
  "KnownProvider",
  "listAgentDefinitionReports",
  "listAgentDefinitionsForSpace",
  "listCompletionEntries",
  // (attention-alert click route, T2) The `attention-alert-clicked` listener —
  // a RUNTIME value (a function), so it enters BOTH lists; the payload type it
  // traffics in, `AttentionAlertClickedPayload`, is TYPE-ONLY and lives in
  // `TAURI_PUBLIC_API` only (the `AccessRule`/`AccessDirection` precedent).
  "listenAttentionAlertClicked",
  "listenInteractiveEvent",
  "listenInteractiveRequest",
  "listenInteractiveRequestClose",
  "listenPermissionRequest",
  "listenSessionClosed",
  "listenSessionStalled",
  "listenSessionTitled",
  "listenSessionUpdate",
  "listenSubagentClosed",
  "listenSubagentSessionStarted",
  "listenWindowState",
  "ListingDto",
  "listKnownProviders",
  "listMcpServersEffective",
  "listModels",
  "listSessions",
  "listSkills",
  "listSpaceListing",
  "listSpaces",
  "linkSession",
  "listTools",
  "loadHistory",
  "McpServerEntry",
  "McpServerInfo",
  "MessageRow",
  "ModelDto",
  "MoveTaskOutcome",
  "OverrideSource",
  "moveTask",
  "PermissionOption",
  "PermissionOutcome",
  "PermissionRequest",
  "PermissionRequestPayload",
  "ProviderConfig",
  // (issue #126 / #127 / #132) The provider-auth suite: SIX RUNTIME names (the
  // five interactive-login wrappers + the spend/budget read) and the SIX
  // TYPE-ONLY wire names the provider row's editors name (`ProviderAuthMode`,
  // `ProviderOidcConfig`, `ProviderLoginStep`, `TeamDto`,
  // `ProviderBudgetRowDto`, `ProviderBudgetDto`). The type names vanish at
  // runtime, so `TAURI_RUNTIME_API` gains ONLY the six wrappers — the
  // `AccessRule`/`AccessDirection` precedent. This moves the pin 121 → 133
  // (the plan's §0c arithmetic said 131, having counted FOUR type names, while
  // its own §2.3 instruction re-exports SIX; the assertion compares the sorted
  // sets, so the tree wins — recorded as a deviation in the commit message).
  "ProviderAuthMode",
  "ProviderBudgetDto",
  "ProviderBudgetRowDto",
  "ProviderLoginStep",
  "ProviderOidcConfig",
  "providerLoginOauth",
  "providerLoginOidc",
  "providerLoginPasteToken",
  "providerLoginSsoChooseTeam",
  "providerLoginSsoPoll",
  "readClipboardImage",
  "readFileBytes",
  // (issue #179) The remaining five Stage/strict wrappers; `createStage`,
  // `deleteStage` and `getBoardStrict` entered above among their board siblings.
  "renameStage",
  "reorderSessions",
  "reorderSpaces",
  // (issue #179) The fourth instance of the reorder verb — column ORDER only,
  // never the transition graph (ADR 0099 keeps the two questions separate).
  "reorderStages",
  "reorderTasks",
  "respondInteractiveRequest",
  "respondPermission",
  "resumeSession",
  "saveSettings",
  "sendPrompt",
  "SessionClosedPayload",
  "SessionConfigOption",
  "SessionConfigSelectGroup",
  "SessionConfigSelectOption",
  "SessionInfo",
  "SessionRecency",
  "SessionTitledPayload",
  "SessionUpdatePayload",
  "sessionRecency",
  // (issue #179) The Strict-workflow WRITE (ADR 0099's per-Space opt-in).
  "setBoardStrict",
  "setSessionArchived",
  "setSessionConfigOption",
  // (issue #179) The two Stage writes: the launch Skill (ADR 0098) and the
  // outgoing transition graph (ADR 0099). Both return the pinned `StageRow`.
  "setStageNext",
  "setStageSkill",
  "setSpaceTrusted",
  "ShadowedAgent",
  "ShadowedSkill",
  "shellSandboxAvailable",
  "SkillInfo",
  "SpaceCheck",
  "spaceForPath",
  "SpaceRow",
  "StalledPayload",
  "StageRow",
  "StageWithTasks",
  "startSession",
  "startTaskSession",
  "StopReason",
  "SubagentClosedPayload",
  "SubagentFailureReason",
  "SubagentMetrics",
  "SubagentSessionStartedPayload",
  "TaskCardView",
  "TaskRow",
  "TaskSessionRow",
  "TeamDto",
  "testMcpServer",
  "testSearchProvider",
  // (issue #180 D1, spec §1, ADR 0100) The artifact WRITE wrapper — a RUNTIME
  // value (the two TYPE names it traffics in, `Artifact`/`ArtifactMeta`, are
  // declared above and stay out of the runtime list).
  "writeArtifact",
  "ToolCallContent",
  "WebSettings",
  "WindowFrameState",
  "WireApi",
];

/** The RUNTIME values of the surface above (the rest are type-only and vanish
 *  at runtime — `Object.keys` of the real module equals this list). NO COUNT IS
 *  STATED HERE, on purpose, per this file's own header: the two numbers this
 *  comment carried ("pinned 49", then "58 as of issue #126/#127/#132") were both
 *  prose no assertion read, and the second was already wrong at the commit that
 *  wrote it — the array measures 66 today (A4's `startTaskSession` is the 66th).
 *  The array IS the expectation. */
const TAURI_RUNTIME_API = [
  "attentionArm",
  "attentionDisarm",
  "authMcpServer",
  "cancelSession",
  "closeSession",
  "compactSession",
  // (Task board, ADR 0090) The board wrappers. The SIX companion type names
  // (`StageRow`/`StageWithTasks`/`TaskCardView`/`TaskRow`/`TaskSessionRow`
  // `/MoveTaskOutcome`) are
  // in `TAURI_PUBLIC_API` ONLY — they vanish at runtime, so they never enter this
  // list (the `AccessRule`/`AccessDirection` precedent). No count stated here on
  // purpose: this file's own header says the ARRAY is the expectation.
  //
  // (issue #179, ADRs 0098 + 0099) The eight Stage/strict wrappers enter HERE too
  // — all eight are runtime values. `StageRow` gains two FIELDS in the same commit
  // and no TYPE name moves, for the reason spelled on `TAURI_PUBLIC_API`.
  "createStage",
  "createTask",
  "deleteSession",
  "deleteSpace",
  "deleteStage",
  "editTask",
  "externalOpen",
  // (issue #180 D1, spec §1) The artifact READ wrapper (see `TAURI_PUBLIC_API`).
  "getArtifact",
  "getBoard",
  "getBoardStrict",
  "getSettings",
  "getTask",
  "getWindowState",
  // (attention-alert click route, T2) The window raise the alert's body click
  // asks for. A RUNTIME value (a command wrapper, no payload), so it enters BOTH
  // lists; no TYPE name enters with it.
  "raiseAttentionWindow",
  "linkSession",
  "listAgentDefinitionReports",
  "listAgentDefinitionsForSpace",
  "listCompletionEntries",
  // (attention-alert click route, T2) The `attention-alert-clicked` listener —
  // a RUNTIME value (a function), so it enters BOTH lists; the payload type it
  // traffics in, `AttentionAlertClickedPayload`, is TYPE-ONLY and lives in
  // `TAURI_PUBLIC_API` only (the `AccessRule`/`AccessDirection` precedent).
  "listenAttentionAlertClicked",
  "listenInteractiveEvent",
  "listenInteractiveRequest",
  "listenInteractiveRequestClose",
  "listenPermissionRequest",
  "listenSessionClosed",
  "listenSessionStalled",
  "listenSessionTitled",
  "listenSessionUpdate",
  "listenSubagentClosed",
  "listenSubagentSessionStarted",
  "listenWindowState",
  "listKnownProviders",
  "listMcpServersEffective",
  "listModels",
  "listSessions",
  "listSkills",
  "listSpaceListing",
  "listSpaces",
  "listTools",
  "loadHistory",
  // (issue #126 / #127 / #132) The provider-auth suite: the five interactive
  // login wrappers + the spend/budget read — SIX new RUNTIME values, landing in
  // the same commit as the `src/lib/tauri.ts` re-export lines (this file's own
  // header: a name may only enter the list on purpose, in a commit that says
  // so). The companion TYPE-ONLY names (ProviderAuthMode / ProviderOidcConfig /
  // ProviderLoginStep / TeamDto / ProviderBudgetRowDto / ProviderBudgetDto) are
  // in `TAURI_PUBLIC_API` ONLY — they vanish at runtime, so they never enter
  // this list (the `AccessRule`/`AccessDirection` precedent). 52 → 58.
  "getProviderBudget",
  "providerLoginOauth",
  "providerLoginOidc",
  "providerLoginPasteToken",
  "providerLoginSsoChooseTeam",
  "providerLoginSsoPoll",
  "moveTask",
  "readClipboardImage",
  "readFileBytes",
  // (issue #179) The remaining five Stage/strict runtime wrappers; `createStage`,
  // `deleteStage` and `getBoardStrict` entered above among their board siblings.
  "renameStage",
  "reorderSessions",
  "reorderSpaces",
  "reorderStages",
  "reorderTasks",
  "respondInteractiveRequest",
  "respondPermission",
  "resumeSession",
  "saveSettings",
  "sendPrompt",
  "sessionRecency",
  "setBoardStrict",
  "setSessionArchived",
  "setSessionConfigOption",
  "setStageNext",
  "setStageSkill",
  "setSpaceTrusted",
  "shellSandboxAvailable",
  "spaceForPath",
  "startSession",
  // (A4, spec §3) The Task board's Session starter — a RUNTIME wrapper (it
  // returns the already-pinned `SessionInfo`, so no TYPE name enters with it).
  "startTaskSession",
  "testMcpServer",
  "testSearchProvider",
  // (issue #180 D1, spec §1, ADR 0100) The two Task-artifact command wrappers.
  // Both are RUNTIME values, so both enter this list AND `TAURI_PUBLIC_API`; the
  // two TYPE names they traffic in (`Artifact`, `ArtifactMeta`) are in
  // `TAURI_PUBLIC_API` ONLY, the `AccessRule`/`AccessDirection` precedent. Neither
  // wrapper is a model-facing tool — D1 is the human surface (see
  // `commands::tasks::tests::artifacts::d1_ships_no_model_facing_artifact_verb`).
  "writeArtifact",
];

describe("the scanner actually reads the tree", () => {
  it("walks every source file including tests, and can resolve an import", () => {
    // Vacuity guard: a broken walk would leave every rule below green for the
    // wrong reason — the failure `themeTokens.test.ts` records being bitten by.
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES).toContain(BARREL);
    expect(SOURCES.some((f) => f.endsWith(".test.tsx"))).toBe(true);
    // Resolution is exercised on a REAL edge, not a synthetic one.
    expect(resolve("src/components/OpenAnchor.tsx", "../lib/tauri")).toBe(
      BARREL,
    );
    expect(resolve("src/components/OpenAnchor.tsx", "@tauri-apps/api/core")).toBe(
      null,
    );
    // And the alias form used across `src/components/settings/`.
    expect(resolve("src/components/settings/WebSearchSection.tsx", "@/lib/tauri")).toBe(
      BARREL,
    );
  });

  it("the scanner sees the mock seam it exists to protect", () => {
    // If this ever reads 0, the `vi.mock("@/lib/tauri")` factories were rewritten
    // and this whole file's premise is gone — a decision to record, not a silent
    // one. Comment-stripped, because THIS file names the idiom in prose and would
    // otherwise count itself: the first version of this assertion did exactly that
    // and reported 35 where the tree then had 33.
    const mockers = SOURCES.filter(
      (f) =>
        /\.test\.tsx?$/.test(f) &&
        /^\s*vi\.mock\(\s*["'][^"']*lib\/tauri["']/m.test(
          stripJsComments(sweep.listed(f) ?? ""),
        ),
    );
    // SET SIZE, pinned: 48 files mock the barrel by path. The number may only
    // move when a test file is added or removed, in a commit that says so — this
    // one moved 34 -> 35 when D2 wired `useAgentOverridesWrites` into `SpacesList`
    // and landed its test file, which mocks the barrel the documented way, and
    // 35 -> 36 when #85 added `store/modelCatalog.test.ts` (the catalog store the
    // subagent card's context % reads), and 36 -> 37 when the Permissions section
    // landed `components/settings/PermissionsSection.test.tsx`, which mocks the
    // barrel the documented way, and 37 -> 38 when task14b landed
    // `components/settings/McpSection.test.tsx` (the MCP badge's contract + the
    // parked needs-auth red), which mocks the barrel the documented way, and
    // 38 -> 39 when the chatstream decomposition moved `ChatStream`'s attachment
    // tests into `src/hooks/useChatAttachments.test.tsx`, which mocks the barrel
    // the documented way, and 39 -> 41 when the chatstream decomposition moved
    // the dispatch/queue/flush tests into `src/hooks/useChatPromptDispatch.test.tsx`
    // and `src/hooks/usePromptQueueFlusher.test.tsx`, which mock the barrel the
    // documented way, and 41 -> 43 when task06 (issue #135 §5) split the residual
    // `ChatStream.test.tsx` into `src/components/ChatStreamDirectoryCompletion.test.tsx`
    // and `src/components/ChatStreamChildGates.test.tsx`, which mock the barrel
    // the documented way, and 43 -> 44 when issue #126/#127/#132 landed
    // `components/settings/ProviderAuthSection.test.tsx` (the provider sign-in /
    // device-flow / paste-token surface), which mocks the barrel the documented
    // way, and 44 -> 45 when #143 added `hooks/useSessionTitleRecovery.test.ts`
    // (the focus-driven title re-read), which mocks the barrel the documented
    // way — it needs `listSessions` mocked, and this file's own rule is that a
    // mocker must spread, so an unlisted export still resolves — and 45 -> 46
    // when FE3 split `ChatStream.test.tsx`'s mention / file-completion picker
    // cluster into `src/components/ChatStreamMentionPicker.test.tsx`, which
    // mocks the barrel the documented way. The residual `ChatStream.test.tsx`
    // keeps its own barrel mock, so this is ONE new mocker and not two: the
    // other half of that split dissolved the residual `describe("ChatStream")`
    // into subject-named sibling describes inside the same file, and a
    // `describe` is not a module — dissolving a block costs no mocks at all.
    // The same arithmetic holds for 46 -> 47 when FE4 split `SpacesList.test.tsx`'s
    // Agents-modal cluster into `src/components/SpacesList.agents.test.tsx`, which
    // mocks the barrel the documented way (the Agents modal's own three catalog
    // sources plus the `saveSettings` write path, and the `getSettings` re-read its
    // read-modify-write pins); `SpacesList.test.tsx` keeps its mock for the 74 tests
    // that stayed (93 before the split, 19 moved out, none lost), so again ONE new
    // mocker and not two — and the dissolve half (the 2 Skills-button tests into a
    // sibling `describe` in the file that already mocks) costs nothing, exactly as
    // above: those 2 are inside the 74, because a `describe` that moves within its
    // own file changes no mock at all.

    //
    // And 47 -> 48 when FE2 moved
    // `src/lib/sessionLifecycle.ts` to `src/store/sessionLifecycle.ts`. That move
    // adds NO file — but the module had to re-spell its own mock from
    // `vi.mock("./tauri")` to `vi.mock("../lib/tauri")`, and it is the PATH this
    // assertion counts, so the file crossed from "not a barrel mocker by path" to
    // "one". This is the pin working, not drifting: from `store/` there is no
    // spelling of the barrel that does not name `lib/tauri`, and a barrel mocker
    // is exactly what the seam needs. It is NOT a new mock — the same factory,
    // the same `importActual` spread, one directory deeper.
    //
    // And 48 -> 50 when the task board's frontend surface (A3) landed
    // `src/store/tasks.test.ts` (the per-Space board store, driving
    // `getBoard`/`moveTask`/`reorderTasks`/`createTask`/`linkSession` — the
    // camelCase WRAPPER names, because the store imports the wrappers and mocking
    // the snake_case Rust command names would leave the real wrapper live and
    // rejecting in jsdom) and `src/components/TasksBoard.test.tsx` (the board
    // surface, which reaches the same wrappers THROUGH that store on mount). TWO new
    // mockers, not one: the store and the component each need the seam, and neither
    // can borrow the other's mock across a module boundary. The board's other two
    // test files are NOT mockers and do not move this count — `TaskCard.test.tsx`
    // renders a card from a `TaskRow` prop and `useDragCard.test.tsx` drives a hook
    // from a `stages` prop, so neither touches IPC at all, which is the shape the
    // seam prefers.
    // And 50 -> 52 when the New Task modal (A5) landed two test files, both of
    // which drive the barrel through the documented seam:
    // `components/NewTaskDialog.test.tsx` (the create-Task-then-Session send
    // path: `createTask` / `startTaskSession` / `sendPrompt` /
    // `setSessionConfigOption`, plus the composer's four catalog fetches) and
    // `components/SessionConfigBlock.test.tsx` (the new `sessionId` prop's write
    // path — `setSessionConfigOption`, which MUST be a mock or the isolation test
    // would be pinning a jsdom `invoke` rejection instead of WHICH SESSION ID was
    // written). Neither is a re-spelling of an existing mock: `SessionConfigBlock`
    // had NO test file before A5 (its behaviour was pinned from the outside,
    // through `SidePane.test.tsx`), and a prop no call site passes cannot be
    // pinned from a call-site test.
    //
    // THIS IS THE CENSUS MOVING FOR THE ONE REASON THE PIN ALLOWS — a test file
    // added, in a commit that says so. The barrel's OWN surface was NOT touched:
    // the two API pins below (`TAURI_PUBLIC_API`, `TAURI_RUNTIME_API`) are
    // untouched and green, because A5 adds no IPC wrapper — `startTaskSession`
    // and the four board commands shipped in A1/A4.
    // And 52 -> 54 when Task interaction (PR #178) landed TWO mockers, each
    // needing the seam for its own reason:
    //  - `src/store/taskLaunch.test.ts` — the launch orchestrator, which asserts on
    //    WHICH arguments reached the wire and in WHAT ORDER (create-before-start and
    //    move-before-start are load-bearing per ADR 0090's missing foreign key), and
    //    an assertion about an argument needs a spy rather than a real `invoke`.
    //  - `src/components/TaskDetailDialog.test.tsx` — the detail modal, which drives
    //    the same launch through its two buttons AND reads the skill catalog to decide
    //    whether those buttons are enabled at all. `listSkills` un-mocked would make
    //    every button permanently disabled in jsdom and the file would assert on a
    //    refusal rather than on the launch.
    // Neither re-spells an existing mock, and `src/lib/taskPrompt.test.ts` is NOT a
    // mocker — it asserts on a returned string and touches no IPC, which is the shape
    // the seam prefers.
    // And 54 -> 55 when T3 (issue #179 §8) landed ONE new mocker:
    // `src/components/StageEditor.tsx`'s own test file, which mocks the barrel the
    // documented way (it drives the seven Stage verbs, the Strict pair and the
    // artifact pair through the store, and it counts `listSkills` calls to pin the
    // "the Skill Select shares the board's one catalog fetch" rule — an assertion
    // about a call count needs a spy rather than a real `invoke`). It spreads
    // `importActual` too, so the spread half moved 53 -> 54 and the one wholesale
    // replacement is still `hooks/useWindowMaximized.test.ts`.
    //
    // T3 touches NO other file of this one's: the barrel's OWN surface was already
    // widened by T1 (the eight Stage/Strict wrappers) and T4 (the two artifact
    // wrappers), so both pinned API lists below are untouched — this is the census
    // moving for the one reason the pin allows, a TS test file added, in a commit
    // that says so.
    //
    // (attention-alert click route, T2) This census did NOT move — 55 stayed 55 and
    // the `importActual` half stayed 54. The census counts test FILES that
    // `vi.mock` the barrel by path, and T2 adds none: its new wrapper lives in an
    // existing module (`tauri/events.ts`) and the `attention_arm` change only adds
    // an argument. A later reader must not "fix" this number — the census may only
    // move when a test file is added or removed, in a commit that says so.
    //
    // And 55 -> 56 for the SAME feature's other half (attention-alert click
    // NAVIGATION, T3), which is the addition this pin exists to record: ONE new
    // test file, `src/hooks/useAttentionAlertClick.ts`'s own, which mocks the
    // barrel the documented way because the listener's whole job is calling four
    // barrel exports in a fixed order and asserting an ORDER needs a spy rather
    // than a real `invoke`. It spreads `importActual` too, so the spread half moved
    // 54 -> 55 and the one wholesale replacement is STILL
    // `hooks/useWindowMaximized.test.ts`. The feature's other new test file,
    // `src/lib/attentionFocusSignal.test.ts`, is NOT a mocker — the signal module
    // holds no IPC, so that file imports it directly, which is the shape the seam
    // prefers. T2's paragraph above stays as written: it describes the commit that
    // left this number alone, and it was correct then.
    expect(mockers).toHaveLength(56);
    // 55 of the 56 SPREAD `vi.importActual`, which is the shape that makes the
    // seam forgiving: an unlisted export still resolves. The new mocker spreads
    // too (it lists the arms its own tests drive and leaves every other barrel
    // export — `invoke` included — to the real module), so the remaining one
    // is still `hooks/useWindowMaximized.test.ts`, which replaces the module
    // wholesale — so a name it forgets is `undefined`, the case the pinned-surface
    // assertion below covers.
    expect(
      mockers.filter((f) =>
        /vi\.importActual/.test(sweep.listed(f) ?? ""),
      ).length,
).toBe(55);
  });
});

describe("nothing bypasses the lib/tauri barrel (D1's mock seam)", () => {
  it("no file outside src/lib/tauri/ imports a domain module directly", () => {
    // THE guard. See the header for why a violation is green-but-broken.
    expect(directDomainImports()).toEqual([]);
  });

  it("the barrel re-exports the exact pinned public API", () => {
    const through = reexportedNames(BARREL);
    const declared = exportedNames(BARREL);
    // Before the split the names are DECLARED in the barrel; after, they are
    // re-exported. Either way the barrel's surface is the pinned set.
    const surface = [...new Set([...through, ...declared])].sort();
    expect(surface).toEqual([...TAURI_PUBLIC_API].sort());
  });

  it("the runtime export set of the barrel is exactly the pinned runtime list", async () => {
    // The strongest form: what the module ACTUALLY exposes at runtime, which is
    // what `vi.importActual` spreads into the barrel-mocking test factories (the
    // count is pinned by the assertion below rather than stated here — every
    // prose copy of it has gone stale at least once). A forgotten
    // `export { fn }` here is a `undefined is not a function` in the app and a
    // silently-unmocked IPC call in a test — this catches it at the seam.
    const mod = await import("./tauri");
    expect(Object.keys(mod).sort()).toEqual([...TAURI_RUNTIME_API].sort());
  });

  it("domain modules never export the same name twice (a duplicate would silently shadow)", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const mod of domainModules()) {
      // `domainModules()` is a LISTING, so these reads are `listed` reads.
      for (const name of [
        ...exportedNames(mod, (f) => sweep.listed(f)),
        ...reexportedNames(mod, (f) => sweep.listed(f)),
      ]) {
        if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} / ${mod}`);
        else seen.set(name, mod);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("the barrel holds NO implementation — it is a pure re-export surface", () => {
    // This assertion was RED before the split (this file WAS the implementation)
    // and went green with the last module's move. It stays because a function the
    // split failed to place would otherwise drift back here silently, and because
    // a barrel holding logic is a barrel that can no longer be read as a list of
    // the domains it forwards.
    const src = stripJsComments(sweep.named(BARREL));
    expect(src).not.toMatch(/\binvoke\s*[<(]/);
    expect(src).not.toMatch(/\blisten\s*[<(]/);
    // A DECLARED function / interface / const. `export { … } from` and
    // `export type { … } from` are re-exports — the only thing that belongs here.
    expect(src).not.toMatch(/^export (async function|function|interface|const)\b/m);
    expect(src).not.toMatch(/^export type\s+[A-Za-z_]/m);
    // `export *` is banned outright: it would make the pinned-surface assertion
    // above blind, and the pinned list would stop being the contract.
    expect(src).not.toMatch(/^export \*/m);
  });

  it("no name is declared in the barrel AND re-exported from a domain module", () => {
    // The duplication guard, and it is migration-aware on purpose: while the
    // split is in progress the barrel legitimately still DECLARES the modules
    // that have not moved yet. What must never happen is a name living in BOTH
    // places — the barrel's own copy would be what `vi.importActual` spreads, so
    // the domain module (and any state or fix in it) would be dead code.
    const declared = new Set(exportedNames(BARREL));
    const dupes: string[] = [];
    for (const mod of domainModules()) {
      // `domainModules()` is a LISTING, so these reads are `listed` reads.
      for (const name of [
        ...exportedNames(mod, (f) => sweep.listed(f)),
        ...reexportedNames(mod, (f) => sweep.listed(f)),
      ]) {
        if (declared.has(name)) dupes.push(`${name} (also declared in ${BARREL})`);
      }
    }
    expect(dupes).toEqual([]);
  });
});

describe("the sweep survives a file that vanishes between listing and reading", () => {
  // THE SKIP BRANCH, PROVEN REACHABLE — not a race attempt. The full suite is the
  // only thing that reproduces the original ENOENT (the palette guard deletes
  // `src/lib/palettes/guardprobe.ts` from another worker), and a test that "hopes
  // for" a scheduling accident is not a test. So this drives the REAL predicate
  // over a listing this file controls: a path that is present when listed and
  // gone when read. `.tmp/` is gitignored and outside `src/`, so the probe cannot
  // become a fake source file in the tree the other sweeps grade.
  const probe = ".tmp/tauriBarrelSweep";
  const fs = NODE_FS_MODULE;

  /** THE PROBE'S IMPORT, BUILT BY CONCATENATION — and the one thing in this
   *  describe block that is not decoration. This file's own rule is that TESTS
   *  are in scope, so the moment a probe spells `from "@/lib/tauri/…"` as a
   *  literal, THIS FILE becomes an offender to its own guard and the header's
   *  documented trap (it once reported 35 mockers where the tree held 33, for
   *  exactly this reason) springs on the new test. Same remedy
   *  `themeTokens.test.ts` uses for the dead row-kind family it gates: split the
   *  word so the scanner cannot read prose as a consumer. `stripJsComments` drops
   *  the comment lines below, but NOT the string literals inside the planted
   *  source, so the split is what keeps the probe invisible here. */
  const PROBE_SPEC = "@/lib/" + "tauri/" + "events";
  const PROBE_TARGET = "src/lib/" + "tauri/" + "events.ts";
  const bypassSource = (): string =>
    `import { listSessions } from "${PROBE_SPEC}";\n`;

  it("skips a listed file that disappears mid-sweep, and says it did", () => {
    fs.mkdirSync(probe, { recursive: true });
    // A real bypass, planted so the predicate has something to convict, and a
    // second path that is deleted before the sweep reaches it. If the skip branch
    // were a plain `catch { continue }` this test could not tell the two apart —
    // so the offender is asserted to SURVIVE the skip.
    const real = `${probe}/bypass.ts`;
    const doomed = `${probe}/doomed.ts`;
    fs.writeFileSync(real, bypassSource());
    fs.writeFileSync(doomed, bypassSource());
    sweep.resetSkipped();
    try {
      // Pass 1 proves the listing sees both, and the predicate convicts both —
      // which is what makes pass 2 a measurement of the SKIP and not of a
      // predicate that never found anything.
      expect(directDomainImports([real, doomed])).toEqual([
        `${real}:1 → ${PROBE_TARGET}`,
        `${doomed}:1 → ${PROBE_TARGET}`,
      ]);
      expect(sweep.skipped(), "nothing has vanished yet").toEqual([]);

      // Pass 2: the file is deleted, then the SAME listing is swept again — the
      // exact sequence the guard produces from another worker.
      fs.rmSync(`${probe}/doomed.ts`, { force: true });
      const offenders = directDomainImports([real, doomed]);
      expect(offenders, "the vanished file is gone, the real one is still convicted").toEqual([
        `${real}:1 → ${PROBE_TARGET}`,
      ]);
      // And the skip is RECORDED, so the branch can never be silently
      // always-empty: this is the assertion that separates a correct skip from a
      // swallowed error.
      expect(sweep.skipped()).toEqual([{ file: doomed, code: "ENOENT" }]);
      expect(sweep.skipped()[0]!.code).toBe("ENOENT");
    } finally {
      fs.rmSync(probe, { force: true, recursive: true });
      sweep.resetSkipped();
    }
  });

  it("does NOT skip a listed file that is present (the leaked-artifact case)", () => {
    // The failure mode the guard exists for: a `guardprobe.ts` LEFT behind is
    // present, so it must be opened and graded. Tolerance for a vanishing file
    // must not become tolerance for a stray one.
    fs.mkdirSync(probe, { recursive: true });
    const leaked = `${probe}/leaked.ts`;
    fs.writeFileSync(leaked, bypassSource());
    sweep.resetSkipped();
    try {
      expect(directDomainImports([leaked])).toEqual([
        `${leaked}:1 → ${PROBE_TARGET}`,
      ]);
      expect(sweep.skipped(), "a present file is never skipped").toEqual([]);
    } finally {
      fs.rmSync(leaked, { force: true });
      fs.rmSync(probe, { force: true, recursive: true });
    }
  });

  it("still throws on a named path that is missing (tolerance does not leak to literals)", () => {
    // `src/lib/tauri.ts` and `src/lib/ipcError.ts` are named by literals. If the
    // sweep grew tolerant of THOSE, the pinned-API and ipcError-contract guards
    // below would go green while reading nothing.
    expect(() => sweep.named("src/lib/not-a-real-barrel.ts")).toThrow(/ENOENT|no such file/);
    expect(sweep.named(BARREL), "the real barrel still reads").toContain("export");
  });
});

describe("lib/ipcError.ts stays free of lib/tauri (its documented contract)", () => {
  it("ipcError imports nothing", () => {
    // `ipcError.ts:21` states the rule in prose: it is used by Settings
    // components that never touch `lib/tauri`, and a formatting helper must not
    // drag `@tauri-apps/api` in. The split must not become the reason it does.
    const src = stripJsComments(sweep.named("src/lib/ipcError.ts"));
    expect(src).not.toMatch(/\bfrom\s+["']/);
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
});
