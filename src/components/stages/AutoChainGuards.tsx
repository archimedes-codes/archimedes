import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { MutedCaption } from "../MutedCaption";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useTasks } from "../../store/tasks";
import type { AutoGuards } from "../../lib/tauri";

/**
 * The Space-level **auto-chain guards** — the two numeric fields under the Stage
 * rows that bound a chain of auto-advancing columns, as its own subject, beside
 * `StrictWorkflowToggle` (its exact sibling: per-Space, seeded from its own read, one
 * `spaces`-row write, no board paint).
 *
 * ---------------------------------------------------------------------------
 * IT IS A FORM, NOT A STORE
 * ---------------------------------------------------------------------------
 *
 * Three pieces of state and nothing else: the pair as the Space ANSWERED it
 * (`guards`), and the two fields as they are being TYPED (`stepsDraft`,
 * `ceilingDraft`). No store field, no derived board state, no prop — the read and the
 * write both go through `store/tasks` like every other write in this dialog, and the
 * pair is re-read after a write rather than trusted from the paint (see `commit`).
 *
 * WHY THE DRAFT IS A STRING AND NOT A NUMBER, AND WHY THE FIELD IS NOT
 * `type="number"`. An `<input type="number">` is a field that can hold text no number
 * can represent — `"1."`, `"-"`, `e` — and a draft typed as `number` would have to
 * answer for all of them. The repo's own numeric field (`FontSizeInput`,
 * `settings/controls.tsx`) handles that by falling back to the stored value, and it
 * can afford to, because a font size has no empty state. THIS field does: `""` means
 * the CLEAR, and a `type="number"` input sanitizes un-parseable text to `""` before
 * any handler sees it — measured, not assumed (`"abc"`, `"1."`, `"-"`, `"1e999"`,
 * `"0x10"` and `"1,5"` all arrive at `onChange` as the empty string, in jsdom and in
 * the browsers whose behaviour it copies). So a `type="number"` guard field would turn
 * a stray keystroke into clearing the Space's spend bound, silently — the one
 * confusion of `null` and garbage this whole component exists to refuse. Hence a plain
 * text field with `inputMode="decimal"`: the raw text reaches the parse, garbage is
 * REFUSED there and writes nothing, and `""` stays the only spelling of a clear. The
 * stepper `min`/`step` go with the type they belonged to.
 *
 * ---------------------------------------------------------------------------
 * `NULL` IS NOT `0`, AND BOTH ARE OFFERED
 * ---------------------------------------------------------------------------
 *
 * An empty field means NOT CONFIGURED — `null` on the wire, which falls back to a
 * shipped default (`DEFAULT_AUTO_MAX_STEPS` / `DEFAULT_AUTO_CEILING_USD` in
 * `src-tauri/src/storage/db/auto_guards.rs`) and is NOT unlimited. `0` means the person
 * set the bound to zero: no auto-chaining, no spend. `setAutoGuards` takes both arms
 * and this component offers both, so the Clear control and a typed `0` are different
 * actions that must never share a code path — ADR 0082's `sessions.cost_usd`
 * discipline, applied to the thing that column's figure is measured against.
 *
 * Every write is ONE call for the PAIR, because the storage statement writes both
 * columns together and has no "keep what is there" arm: whatever is handed over is
 * what lands. So committing one field sends the other from `guards`, never from its
 * draft — a caller that sent an empty draft for the field nobody edited would clear a
 * guard the person never touched.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CAPTION NAMES THE FALLBACKS INSTEAD OF SHOWING THEM AS VALUES
 * ---------------------------------------------------------------------------
 *
 * The fields stay EMPTY for an unconfigured Space rather than showing the fallbacks,
 * and that is the whole reason the caption exists: the read reports the stored pair
 * and never substitutes the fallback, so an editor that displayed the fallback in the
 * field would make an inherited bound look like a chosen one — which is exactly the
 * distinction the `NULL` column and the constant being SEPARATE things exists to
 * preserve. So the caption cites the two constants BY NAME and does not restate their
 * values: a number copied into this file is a number that can drift from the one the
 * runtime applies, and this is not where the bound lives.
 *
 * The caption also states the ceiling's one real weakness, because hiding it would
 * advertise a guard stronger than it is. The ceiling counts `sessions.cost_usd`, and
 * `NULL` there means "no Session in this chain ever reported a figure" — NOT "it was
 * free" (ADR 0082). A chain whose Sessions never report a cost therefore spends
 * nothing as far as the ceiling can see, and the STEP bound is what stops it. This
 * component configures the guard; the runtime enforces it.
 *
 * `spacePath` is `string`, not `string | null` — `StageEditor`'s early return makes a
 * Spaceless mount unreachable, the same promise `StrictWorkflowToggle` and
 * `AddStageField` are built on.
 */
export function AutoChainGuards({ spacePath }: { spacePath: string }): ReactElement {
  const getAutoGuards = useTasks((s) => s.getAutoGuards);
  const setAutoGuards = useTasks((s) => s.setAutoGuards);

  /** The pair as the Space ANSWERED it, or `null` while unread / after a failed read.
   *  See `readGuards` for why that is NOT the same thing as an all-`null` pair. */
  const [guards, setGuards] = useState<AutoGuards | null>(null);
  /** The two fields as typed, or `null` when they show the stored value. Local for
   *  `StageRow`'s label-field reason: the store holds what the database has and this
   *  holds what is being typed, so neither is a second owner of the other. Cleared
   *  after a commit — success, refusal or refusal-to-parse — so the field falls back
   *  to what the Space actually holds. */
  const [stepsDraft, setStepsDraft] = useState<string | null>(null);
  const [ceilingDraft, setCeilingDraft] = useState<string | null>(null);

  /** Read the pair. `null` on failure rather than an all-`null` pair, because an
   *  all-`null` pair is a FACT about the Space ("nothing configured, so the shipped
   *  bound governs") and a swallowed read must not hand the fields that fact as their
   *  default — the `getBoardStrict` rule one control over, and the reason both fields
   *  render INERT while `guards` is `null` rather than pre-filling blanks. */
  const readGuards = useCallback((): void => {
    void getAutoGuards(spacePath).then(
      (value) => setGuards(value),
      // The store already wrote the sentence into `error`, which this dialog renders.
      () => setGuards(null),
    );
  }, [spacePath, getAutoGuards]);

  useEffect(() => {
    setGuards(null);
    setStepsDraft(null);
    setCeilingDraft(null);
    readGuards();
  }, [spacePath, readGuards]);

  /** Commit one field, sending the PAIR.
   *
   *  `parsed` is what the edited field's text means on the wire — `null` for empty
   *  (the clear), a number for anything parseable, or `undefined` for text that is not
   *  a number, which means "write nothing at all". The other half of the pair comes
   *  from `guards`, never from a draft. The drafts clear FIRST so every exit leaves
   *  the fields showing the stored pair, then the pair is re-read, because
   *  `setAutoGuards` captures its failure into `error` and does NOT rethrow (the
   *  `setBoardStrict` shape) — without the re-read the fields would keep showing
   *  numbers the Space refused. */
  const commit = async (
    field: "maxSteps" | "ceilingUsd",
    text: string,
  ): Promise<void> => {
    const trimmed = text.trim();
    // `""` is the clear; anything else must parse AND be a sane bound. `Number("")` is
    // `0`, which is exactly the collapse this refuses to make, hence the empty test
    // BEFORE it. A NEGATIVE is refused here and not in storage: `Db::set_auto_guards`
    // documents that it stores whatever it is handed and that "whether a number is
    // SANE is the editor's question", so a field that wrote `-5` would land a bound no
    // chain can satisfy — which the runtime would read as "stop immediately", i.e. the
    // off switch, reached by typing a minus sign.
    const parsed: number | null | undefined =
      trimmed === ""
        ? null
        : Number.isFinite(Number(trimmed)) && Number(trimmed) >= 0
          ? Number(trimmed)
          : undefined;
    setStepsDraft(null);
    setCeilingDraft(null);
    // Unparseable text, or nothing read yet, writes NOTHING and leaves the stored
    // pair standing — the field has already fallen back to it, so the person sees
    // their text replaced by what the Space holds, the rule a refused rename follows.
    if (parsed === undefined || guards === null) return;
    const next: AutoGuards =
      field === "maxSteps"
        ? { maxSteps: parsed, ceilingUsd: guards.ceilingUsd }
        : { maxSteps: guards.maxSteps, ceilingUsd: parsed };
    if (
      next.maxSteps === guards.maxSteps &&
      next.ceilingUsd === guards.ceilingUsd
    ) {
      // Nothing changed — and a blur fires on every click elsewhere in the dialog, so
      // an ungated commit would rewrite the Space's guards as the user worked. The
      // `commitLabel` gate, one control over.
      return;
    }
    await setAutoGuards(spacePath, next.maxSteps, next.ceilingUsd);
    readGuards();
  };

  /** Clear BOTH guards to not-configured, then re-read. ONE call for the pair like
   *  every other write here, and it sends `null` twice — never `0`, which is a bound a
   *  person chose and a different answer to the same question. */
  const clearGuards = async (): Promise<void> => {
    setStepsDraft(null);
    setCeilingDraft(null);
    await setAutoGuards(spacePath, null, null);
    readGuards();
  };

  /** The stored value as field text: `null` renders the EMPTY field, which is the one
   *  spelling of "not configured" this form has. `0` renders `0` — a bound, not a
   *  blank, and the difference is visible on screen. */
  const seed = (value: number | null): string => (value === null ? "" : String(value));

  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-card-border pt-2">
      <div className={GUARD_ROW}>
        <span className={GUARD_GROUP}>
          <span className={GUARD_LABEL}>
            Max steps
          </span>
          <Input
            // A TEXT field with `inputMode="decimal"`, deliberately — see the header's
            // `type="number"` note. A number input would sanitize a stray keystroke to
            // `""`, and `""` here is the CLEAR: the field would silently drop the
            // Space's spend bound on a typo.
            inputMode="decimal"
            disabled={guards === null}
            aria-label="Auto-chain maximum steps"
            className={GUARD_FIELD}
            value={stepsDraft ?? seed(guards?.maxSteps ?? null)}
            onChange={(event) => setStepsDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void commit("maxSteps", event.currentTarget.value);
              }
            }}
            onBlur={(event) => void commit("maxSteps", event.currentTarget.value)}
          />
        </span>
        <span className={GUARD_GROUP}>
          <span className={GUARD_LABEL}>
            USD ceiling
          </span>
          <Input
            // The same text-field choice as its sibling, for the same reason. The
            // ceiling is a MONEY figure, so the parse keeps the fraction and refuses a
            // negative — and unlike a stepper's `min`, which a typed value walks past,
            // the parse cannot be walked past.
            inputMode="decimal"
            disabled={guards === null}
            aria-label="Auto-chain USD ceiling"
            className={GUARD_FIELD}
            value={ceilingDraft ?? seed(guards?.ceilingUsd ?? null)}
            onChange={(event) => setCeilingDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void commit("ceilingUsd", event.currentTarget.value);
              }
            }}
            onBlur={(event) => void commit("ceilingUsd", event.currentTarget.value)}
          />
        </span>
        {/* The CLEAR, as its own control rather than folded into the fields: emptying
            a numeric field is awkward to do and awkward to read back, and a person who
            wants "back to the shipped default" should not have to discover that
            deleting the text is how they say it. */}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={guards === null}
          aria-label="Clear the auto-chain guards"
          className={GUARD_BUTTON}
          onClick={() => void clearGuards()}
        >
          <span>Clear</span>
        </Button>
      </div>
      {/* The fallbacks are NAMED, not shown as values — see the header. And the
          ceiling's blind spot is stated rather than omitted, because a caption that
          left it out would advertise a guard stronger than it is. */}
      <MutedCaption as="p" className="min-w-0">
        Unset falls back to the shipped defaults (DEFAULT_AUTO_MAX_STEPS,
        DEFAULT_AUTO_CEILING_USD), not to unlimited. The ceiling counts REPORTED
        Session costs only: a chain whose Sessions never report one looks free to it,
        and the step bound is what stops that chain.
      </MutedCaption>
    </div>
  );
}

/** The guard line: one quiet row under the rows, its own shell rather than
 *  `CONTROL_ROW` because it carries labelled FIELDS and not a cluster of small
 *  affordances. ONE consumer — this file — so it lives here, the bar
 *  `stageStyles.ts` states for itself. */
const GUARD_ROW = "flex min-w-0 flex-wrap items-center gap-2";
/** A label-and-field pair. A `<span>` and not a `<div>`: this row's items are
 *  inline-flex and a block child would take the field out of the wrap. */
const GUARD_GROUP = "flex min-w-0 items-center gap-1.5";
const GUARD_LABEL = "shrink-0 text-ui-sm text-foreground-subtle";
/** The two fields, narrow and identical — a bound you cannot compare side by side is
 *  two fields instead of one decision. */
const GUARD_FIELD = "h-6 w-24";
/** The Clear, on the `ROW_BUTTON` shape so it sits at the same weight as a row's. */
const GUARD_BUTTON =
  "shrink-0 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground";
