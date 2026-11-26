import type { AdvanceAdvice, AcpSessionUpdate, ChainStop, StageDto } from "../lib/tauri";
import type { TaskLaunchDestination } from "../lib/taskPrompt";

/**
 * The ONE reader of Rust's **advance advice** — the launch instruction a
 * `mark_done` claim answers with.
 *
 * ## Why this module exists beside the type
 *
 * `AdvanceAdvice` (`lib/tauri/types.ts`) is the *shape*; a shape is a compile-time
 * claim about a value that arrived over a wire, and the value arrives as
 * `unknown` — it is a field of a tool result's JSON. Someone has to decide, at
 * runtime, whether what came back is one of these before anything branches on it,
 * and that decision belongs in exactly one file. Three callers read the advice (the
 * claim path off a transcript frame, the settle fallback off the command's answer,
 * and the sentence the transcript gets), and a guard spelled three times is three
 * chances to accept a payload the other two would refuse.
 *
 * ## Why it is PURE
 *
 * No store, no IPC, no component — a function over a payload. That is deliberate
 * and it is load-bearing for the test file: `advanceAdvice.test.ts` mocks nothing,
 * so it is not one of the barrel mockers `tauriBarrel.test.ts` counts, and the
 * pinned counts do not move. `../lib/tauri` is imported with `import type` only,
 * which `verbatimModuleSyntax` compiles to nothing at all.
 *
 * ## The frame is part of the payload
 *
 * The instruction rides `rawOutput.details.advanceAdvice` on a
 * **`tool_call_update`** — the *settle* frame of a tool call. Not on the
 * `tool_call` that announced it. That is not a detail: the announcing frame exists
 * before the tool has run, so before Rust decided anything, and a reader that took
 * both would launch the next link off a promise of a decision instead of the
 * decision. `readAdvanceAdvice` therefore refuses the `tool_call` frame even when
 * the payload is sitting in front of it, and the test pins exactly that.
 *
 * ## Why the destination is built and not copied
 *
 * `destinationOf` reads all four fields out of the ONE `StageDto` the advice
 * carries — ADR 0098's rule that the Skill a Session loads, the label a sentence
 * names and the prompt it opens with cannot disagree about which column was meant.
 * This is also what lets a launch happen with **no board mounted**: the row carries
 * everything `launchTaskSession` needs, so the advice-driven arm never resolves a
 * slug against `boardsBySpace` (which is the defect that left `workflow_runs` empty
 * while 456 Sessions ran).
 *
 * ## Why the numbers come out of the payload
 *
 * `sentenceFor` renders `maxSteps` and `ceilingUsd` as the advice returned them.
 * The shipped fallbacks for both are Rust-only on purpose, so a sentence that says
 * "20" here is a policy number copied across the wire — one refactor from
 * describing a bound a person never set.
 */

/** The `reason` spellings `storage/db/advise.rs` emits, named once.
 *
 *  OWNED here because Task 4 branches on them, and the branch is the spend bound:
 *  `already_advanced` is a SILENT no-op while every other refusal closes the run and
 *  speaks. A spelling that drifts turns a 20-step bound into 20 steps per link, so
 *  the arms cannot hand-type them. The constants are the ones the Rust file's
 *  `REASON_*` block declares; the Rust side pins its own set in
 *  `agent::host_tools::tests::shape`. */
export const REASON_UNLINKED = "unlinked";
export const REASON_UNCLAIMED = "unclaimed";
export const REASON_ALREADY_ADVANCED = "already_advanced";
export const REASON_NOT_AUTOMATIC = "not_automatic";
export const REASON_NO_NEXT_STAGE = "no_next_stage";
export const REASON_MAX_STEPS = "max_steps";
export const REASON_COST_CEILING = "cost_ceiling";
/** The two ADVANCING spellings. `advanced_unnamed_edge` means the caller named an
 *  edge this board does not have and the head fired instead — it still advances, so
 *  it is not a refusal and earns no sentence. */
export const REASON_ADVANCED = "advanced";
export const REASON_ADVANCED_UNNAMED_EDGE = "advanced_unnamed_edge";

/** The four `ChainStop` spellings, as a value. The type in `lib/tauri/types.ts` is
 *  the union; this is what narrows a `string` from JSON into it, because a fifth
 *  spelling in a payload is a bound this side cannot name and must not render as one
 *  it can. */
const CHAIN_STOPS: readonly ChainStop[] = [
  "no_next_stage",
  "max_steps",
  "cost_ceiling",
  "launch_refused",
];

const isString = (v: unknown): v is string => typeof v === "string";
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isNumberOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v));
const isStopOrNull = (v: unknown): v is ChainStop | null =>
  v === null || CHAIN_STOPS.includes(v as ChainStop);

/** The destination row, narrowed to the five fields a reader of an advice uses.
 *
 *  Deliberately NOT the whole `StageDto`: `nextSlugs`, `sortOrder` and `onEnter` are
 *  graph and board concerns this path must not consult — re-deriving the next column
 *  here is the second authority ADR 0098 exists to prevent, and the row's `slug`
 *  already IS the answer. `auto` is included because it is not a derivation: it says
 *  whether the chain continues *past* the column being arrived in, which the caller
 *  cannot otherwise know without a slice.
 *
 *  `nextOutcomes` is absent from the check on purpose: it is optional on the DTO (the
 *  `positionX`/`positionY` precedent) and nothing here reads it. */
function isDestinationRow(v: unknown): v is StageDto {
  if (typeof v !== "object" || v === null) return false;
  const row = v as Record<string, unknown>;
  return (
    isString(row.slug) &&
    isString(row.label) &&
    typeof row.auto === "boolean" &&
    isStringOrNull(row.onEnterSkill) &&
    isStringOrNull(row.promptPrefix)
  );
}

/** Runtime guard for a value that claims to be an [`AdvanceAdvice`].
 *
 *  Checks all NINE keys `shape.rs` pins from Rust's side. Absence is a refusal and
 *  not a `undefined`-tolerant shrug: every caller branches on these fields, and a
 *  payload that lost one downstream would otherwise be read as a well-formed advice
 *  with an `undefined` where a decision should be. */
export function isAdvanceAdvice(v: unknown): v is AdvanceAdvice {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.advance === "boolean" &&
    "stop" in a &&
    isStopOrNull(a.stop) &&
    "destination" in a &&
    (a.destination === null || isDestinationRow(a.destination)) &&
    isString(a.reason) &&
    "maxSteps" in a &&
    isNumberOrNull(a.maxSteps) &&
    "ceilingUsd" in a &&
    isNumberOrNull(a.ceilingUsd) &&
    "taskId" in a &&
    isStringOrNull(a.taskId) &&
    "spacePath" in a &&
    isStringOrNull(a.spacePath) &&
    typeof a.alreadyLaunched === "boolean"
  );
}

/** Pull the advice out of ONE `session-update` frame, or `null` for "this frame is
 *  not an instruction".
 *
 *  The whole carrier, in the order the bytes arrive: the pinned crate emits
 *  `tool_execution_end{result}` with `result = to_value(&ToolResult)`, `ToolResult`
 *  is `{content, details, isError}`, normalisation lands that on a
 *  `tool_call_update`, and `reducer.ts` already stores it as `rawOutput`. So the
 *  path is `rawOutput` → `details` → `advanceAdvice`.
 *
 *  Every step is a refusal on its own terms — a `rawOutput` that is a plain string
 *  (many tools answer text), a `details` that is not an object, a `details` with no
 *  such key — and none of them is an error. This function runs on **every** frame of
 *  every Session, so it must be cheap and silent for the 999 in 1000 that carry no
 *  advice, and it must never be the thing that breaks a transcript. */
export function readAdvanceAdvice(update: AcpSessionUpdate): AdvanceAdvice | null {
  // THE FRAME PIN. `tool_call` is the announcement — the tool has not run, so there
  // is no decision to read, whatever a fixture claims is sitting under it.
  if (update.sessionUpdate !== "tool_call_update") return null;
  const raw = update.rawOutput;
  if (typeof raw !== "object" || raw === null) return null;
  const details = (raw as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) return null;
  const advice = (details as Record<string, unknown>).advanceAdvice;
  return isAdvanceAdvice(advice) ? advice : null;
}

/** The column this advice says to launch, as the launch surface wants it — or `null`
 *  for "do not launch".
 *
 *  `advance` is the ONLY field obeyed, and `destination !== null` is not a proxy for
 *  it. The `already_advanced` arm resolves a destination internally (its dedupe has
 *  to know the column to look for) and then refuses to advance — so a reader keyed on
 *  the row would launch the link the claim path already launched, and the settle
 *  fallback exists precisely because that claim may have gone unread.
 *
 *  All four fields come from the one row (ADR 0098), so the move, the Skill token and
 *  the extra prompt cannot name three different columns. `launches` is left unset:
 *  that field belongs to the New Task modal's save-only button, and an advice that
 *  says `advance: true` means launch. */
export function destinationOf(advice: AdvanceAdvice): TaskLaunchDestination | null {
  if (!advice.advance) return null;
  const row = advice.destination;
  if (row === null) return null;
  return {
    slug: row.slug,
    label: row.label,
    onEnterSkill: row.onEnterSkill,
    promptPrefix: row.promptPrefix,
  };
}

/** A money figure for a sentence about a BOUND.
 *
 *  Neither existing formatter fits. `moneyOf` lives under `components/` and
 *  `src/store/` holds zero runtime edges into `src/components/`; `formatCost`
 *  renders a real `0` as the EMPTY string, which is right for a cost chip and wrong
 *  for a ceiling — `$0` is a bound a person can legitimately configure. So
 *  `toFixed(2)`, no cleverness. */
function usdOf(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** The sentence a refusal earns in the transcript, or `null` for "say nothing".
 *
 *  `null` is a real answer and it is the D20 discriminator:
 *   - an ADVANCING advice — the launch is the sentence, and a chain that narrated its
 *     own bookkeeping beside the Session it started would be noise;
 *   - `already_advanced` — the claim path owns this link and already spoke. The
 *     `stopChain` that would carry a sentence here CLOSES the run, and closing hands
 *     the next link a fresh `steps = 1` run, which turns a 20-step bound into 20 steps
 *     per link;
 *   - a `reason` this side does not know — a spelling from a newer Rust than this
 *     renderer. The caller records `unknown` and logs; inventing prose for a reason
 *     this file has never seen is the same guess in a friendlier font.
 *
 *  Every sentence names the reason's own spelling, so the transcript and the
 *  `stop_reason` column cannot describe two different events. */
export function sentenceFor(advice: AdvanceAdvice): string | null {
  if (advice.advance) return null;
  switch (advice.reason) {
    case REASON_ALREADY_ADVANCED:
      return null;
    case REASON_ADVANCED:
    case REASON_ADVANCED_UNNAMED_EDGE:
      return null;
    case REASON_MAX_STEPS:
      return (
        "The auto-advance chain stopped: it reached this Space's " +
        `${advice.maxSteps}-step bound (\`${REASON_MAX_STEPS}\`). The card stays where it is.`
      );
    case REASON_COST_CEILING:
      // `ceilingUsd: null` means NO figure to quote — `$0` and `null` would each
      // describe a guard that did not run, so the money clause is dropped.
      return advice.ceilingUsd === null
        ? `The auto-advance chain stopped: it reached its cost ceiling (\`${REASON_COST_CEILING}\`).`
        : `The auto-advance chain stopped: it reached this Space's ${usdOf(advice.ceilingUsd)} ` +
          `per-chain ceiling (\`${REASON_COST_CEILING}\`). The card stays where it is.`;
    case REASON_UNCLAIMED:
      // D4: a Session that never claimed is a Session that stopped talking, not one
      // that finished. The card does not move and the run closes.
      return (
        "This Session settled without calling `mark_done`, so the card was not advanced " +
        `(\`${REASON_UNCLAIMED}\`). A turn that stops talking is not a turn that finished — ` +
        "move the card yourself to continue."
      );
    case REASON_NOT_AUTOMATIC:
      // The non-auto half of the done-when: the card stays and the amber bell stays lit.
      return (
        "The column this Session was launched in is not automatic, so the card stays put " +
        `and waits for a person (\`${REASON_NOT_AUTOMATIC}\`).`
      );
    case REASON_UNLINKED:
      // The only arm with NO bound to quote — no card, so no Space, so no budget. The
      // sentence must not imply it measured anything.
      return (
        "This Session is not linked to a Task card in this window, so there was nothing " +
        `to advance (\`${REASON_UNLINKED}\`).`
      );
    case REASON_NO_NEXT_STAGE:
      return (
        "The chain stopped: the column this Session was launched in has no column after " +
        `it that this Space can name (\`${REASON_NO_NEXT_STAGE}\`). The card stays where ` +
        "it is — move it yourself to continue."
      );
    default:
      return null;
  }
}
