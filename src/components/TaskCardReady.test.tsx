import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TaskCard, { type TaskCardProps } from "./TaskCard";
import type { TaskRow, TaskSessionRow } from "../lib/tauri";

/**
 * THE MARK a Task card wears — ONE glyph, and the `ready` state's half of it.
 *
 * ## Why ONE mark and not two (this file used to argue the opposite)
 *
 * `ready` first shipped as a SECOND, additive glyph beside the session mark, in
 * green, and the owner caught what the pair paints: a green check next to an amber
 * `?` reads "finished, but blocked", and the two marks disagreed about whether
 * anyone was needed. Both were "true"; the card was saying two things at once.
 *
 * The underlying fact is single — what does this card need from the person looking
 * at the board — so the card now paints ONE glyph chosen by `cardMarkOf`
 * (`waiting` > `ready` > running). The contradictory pair is UNREPRESENTABLE rather
 * than merely discouraged, which is the same reason `sessionStatusRollupOf` answers
 * one glyph for a whole group of Sessions.
 *
 * ## Why `ready` is AMBER and not green
 *
 * It was `CheckCircleIcon` in `text-success`, and that was a mistake the repo's own
 * vocabulary should have prevented: `SubagentStatusIcon`'s `completed` case draws
 * `CheckCircle2` in `text-success`, and `ChecklistPanel`'s done indicator is a
 * check circle in `text-success` too. The app spends real ink teaching that a green
 * tick means DONE. `ready` means the opposite — a person is needed NOW to review.
 *
 * So it wears `text-warning`, the attention ink this row already uses for the `?`
 * and `SubagentStatusIcon` already uses for running. Colour says "you are needed";
 * SHAPE says why: a bell for a hand-off, a question mark for a blockage, a spinner
 * for progress. Sharing the hue across the attention family is coherent precisely
 * BECAUSE only one mark ever renders.
 *
 * ## The rules it keeps from the session mark
 *
 *  - **A glyph, never a coloured word.** `text-foreground-subtlest` on `bg-card`
 *    measures 2.36 default-light / 2.18 default-dark and no palette gate can see
 *    it; a faint word on the card is the explicitly-refused shape. `text-warning`
 *    as 12px TEXT is also a recorded defect (2.12 Everforest light), which is why
 *    the ink goes on a 14px outline — WCAG non-text UI, the 3:1 class, where
 *    `text-warning` measures 3.00 on a white card.
 *  - **Its ink is its own.** `SessionStatusMark`'s `className` is GEOMETRY-only
 *    (`cn()` drops an ink utility a caller passes), so it cannot be re-inked from
 *    the card and cannot be borrowed for a fifth meaning. This is a dedicated glyph.
 *  - **Decoration.** The card is a `RowButton`, and a `div[role="button"]`'s
 *    accessible name is computed RECURSIVELY from its subtree, so an announced mark
 *    renames the card under the user between two frames. Pinned below with the real
 *    accessible-name computation, not with `textContent`.
 *  - **Zero `[role="button"]` matches** — it is an icon, like the `spec` chip and
 *    the artifact key chips are spans, because `SpacesList.test.tsx` resolves rows
 *    through `.closest('[role="button"]')` at eight sites.
 *  - **No new pill, no new caption.** It adds no `rounded-full`, no `bg-background`
 *    and no `text-ui-xs text-foreground-subtlest` pair, so the
 *    `slabFloatSeparation.test.ts` and `mutedCaption.test.ts` censuses do not move.
 */

/** The `sessionStatus` prop's own type, read off the component rather than
 *  re-spelled, so the precedence table below compiles against the REAL union and
 *  cannot invent a value the card would silently not render. */
type SessionStatusOfProp = TaskCardProps["sessionStatus"];

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "tsk_1",
  spacePath: "/w/alpha",
  number: 3,
  title: "Ship the board",
  body: null,
  stageSlug: "doing",
  specPath: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const link = (sessionId: string): TaskSessionRow => ({
  taskId: "tsk_1",
  sessionId,
  stageSlug: "doing",
});

const noop = () => {};

/** Every prop a card needs that is not this file's subject. `sessionStatus` and
 *  `ready` are REQUIRED (see `TaskCardProps`), so they are deliberately NOT in
 *  here: every case spells them, which is the point of a required prop. */
const BASE: Pick<
  TaskCardProps,
  "sessions" | "costUsd" | "artifactKeys" | "onOpenSession" | "onOpenTask"
> = {
  sessions: [link("sess_1")],
  costUsd: null,
  artifactKeys: [],
  onOpenSession: noop,
  onOpenTask: noop,
};

const card = (): HTMLElement => screen.getByTestId("task-card");

/** The `ready` glyph, or `null` for "this card is not reporting readiness".
 *  Queried by `data-testid` and not by role: it is decoration, so a role query
 *  would read `null` for the CORRECT card and could not tell silent from absent. */
const readyGlyph = (): Element | null =>
  card().querySelector('[data-testid="task-card-ready"]');

/** The session glyph (`waiting` / `running`), which keeps its own test id so the
 *  board's existing mark census keeps reading it. */
const sessionGlyph = (): Element | null =>
  card().querySelector('[data-testid="task-card-status"]');

describe("TaskCard — the ready mark", () => {
  it("a ready card shows the glyph", () => {
    render(<TaskCard task={task()} {...BASE} sessionStatus={null} ready />);
    const mark = readyGlyph();
    expect(mark).not.toBeNull();
    expect(mark!.tagName).toBe("svg");
    // AMBER, not green. The success ink is the app's DONE colour
    // (`SubagentStatusIcon`'s `completed`, `ChecklistPanel`'s done indicator) and
    // `ready` is the opposite claim — a person is needed now. Pinned as a token
    // list rather than a computed style so a palette swap cannot quietly move it.
    const tokens = (mark!.getAttribute("class") ?? "").split(/\s+/);
    expect(tokens).toContain("text-warning");
    expect(tokens).not.toContain("text-success");
  });

  it("the ready glyph is NOT a check, so it cannot read as done", () => {
    // The shape carries the meaning here: the hue is shared with the `?`, so a
    // tick would make a hand-off and a blockage the same glyph in the same colour.
    // `BellRing` is asserted by its lucide class, which is the only stable shape
    // signal available without rendering the path data.
    render(<TaskCard task={task()} {...BASE} sessionStatus={null} ready />);
    const tokens = (readyGlyph()!.getAttribute("class") ?? "").split(/\s+/);
    expect(tokens).toContain("lucide-bell-ring");
    expect(tokens.some((t) => t.includes("check"))).toBe(false);
  });

  it("a card that is not ready shows no ready glyph", () => {
    render(
      <TaskCard task={task()} {...BASE} sessionStatus={null} ready={false} />,
    );
    expect(readyGlyph()).toBeNull();
    expect(card().textContent).toContain("T3");
  });
});

describe("TaskCard — ONE mark per card (the precedence, as rendered)", () => {
  // THE REVERSED DECISION, pinned as behaviour. The case that used to live here
  // asserted the opposite — that both marks render together — and that is exactly
  // the state the owner saw and rejected. `cardMarkOf` owns the ORDER and its own
  // suite pins it exhaustively; what THIS file pins is that the card paints at most
  // one glyph, which is the part only a render can see.
  const cases: Array<[SessionStatusOfProp, boolean, string]> = [
    ["waiting", true, "waiting"],
    ["waiting", false, "waiting"],
    ["running", true, "ready"],
    ["running", false, "running"],
    [null, true, "ready"],
    [null, false, "none"],
  ];

  it.each(cases)(
    "sessionStatus=%s + ready=%s paints exactly ONE mark: %s",
    (status, ready, expected) => {
      render(
        <TaskCard task={task()} {...BASE} sessionStatus={status} ready={ready} />,
      );
      const marks = card().querySelectorAll(
        '[data-testid="task-card-ready"], [data-testid="task-card-status"]',
      );
      // THE LOAD-BEARING ASSERTION: never two glyphs on one card.
      expect(marks.length, `expected ${expected}, saw ${marks.length} marks`).toBe(
        expected === "none" ? 0 : 1,
      );
      if (expected === "ready") expect(readyGlyph()).not.toBeNull();
      if (expected === "waiting" || expected === "running") {
        expect(sessionGlyph()).not.toBeNull();
      }
    },
  );

  it("a ready card whose Session is waiting shows the QUESTION, not the bell", () => {
    // The single most important ordering: a card cannot be more urgent than
    // "answering you is blocked", and a hand-off mark must never hide a prompt.
    render(<TaskCard task={task()} {...BASE} sessionStatus="waiting" ready />);
    expect(sessionGlyph()).not.toBeNull();
    expect(readyGlyph()).toBeNull();
  });

  it("live and stored never paint a ring on a card", () => {
    // The board cannot produce these, but the SURFACE owns the rule rather than
    // trusting it — which is why the guard names them and why they are passed here
    // deliberately. A narrower prop type would make this uncompilable and therefore
    // untestable.
    for (const status of ["live", "stored"] as SessionStatusOfProp[]) {
      const { unmount } = render(
        <TaskCard task={task()} {...BASE} sessionStatus={status} ready={false} />,
      );
      expect(card().querySelectorAll('[data-testid^="task-card-"]')).toHaveLength(
        0,
      );
      unmount();
    }
  });
});

describe("TaskCard — the mark is decoration, not a control", () => {
  it("the mark does not rename the card", () => {
    // THE ACCESSIBLE-NAME PIN. `TaskCard` is a `RowButton`; a `div[role="button"]`'s
    // name is computed RECURSIVELY from its subtree, so a mark carrying
    // `aria-label="Ready"` would turn the card's name into "Ship the board Ready"
    // between two frames — the same mid-turn rename that made the tab strip pass
    // `announce={false}`.
    //
    // Asserted through `getByRole`'s own `{ name }` option, which runs testing-
    // library's accessible-name computation and therefore DOES see an `aria-label`.
    // `textContent` could not: the defect this pins is invisible to it, so a
    // `textContent` assertion here would be a vacuous green.
    const { unmount } = render(
      <TaskCard task={task()} {...BASE} sessionStatus="waiting" ready />,
    );
    // The card IS named — by its own content — so the negative below is not the
    // vacuous "nothing is ever named" kind.
    expect(
      screen.getAllByRole("button", { name: /Ship the board/ }),
    ).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: /ready/i })).toHaveLength(0);
    // The mechanism, on whichever glyph actually rendered — under this precedence
    // that is the `?`, not the bell. Asserting on `readyGlyph()` here would read
    // `null` for the CORRECT card, which is the vacuous-green shape.
    const rendered = card().querySelector(
      '[data-testid="task-card-ready"], [data-testid="task-card-status"]',
    );
    expect(rendered).not.toBeNull();
    expect(rendered!.getAttribute("aria-hidden")).toBe("true");
    unmount();

    // The SAME card with the mark removed resolves to the SAME one control.
    render(
      <TaskCard task={task()} {...BASE} sessionStatus="waiting" ready={false} />,
    );
    expect(
      screen.getAllByRole("button", { name: /Ship the board/ }),
    ).toHaveLength(1);
  });

  it('adds ZERO `[role="button"]` matches and zero extra `<button>`s', () => {
    // `SpacesList.test.tsx` resolves rows through `.closest('[role="button"]')` at
    // eight sites, and `RowButton`'s contract is ONE match per row. Counted with
    // both nested controls present so the numbers describe a fully-populated card.
    render(
      <TaskCard
        task={task()}
        {...BASE}
        artifactKeys={["plan"]}
        sessionStatus="waiting"
        ready
        launchStep={{
          destination: {
            slug: "approved",
            label: "Approved",
            onEnterSkill: null,
            promptPrefix: null,
          },
          launchReady: true,
          onLaunch: vi.fn(),
        }}
      />,
    );
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
    expect(document.querySelectorAll('[role="button"]')[0]).toBe(card());
    expect(card().querySelectorAll("button")).toHaveLength(2);
    // And the mark that DID render is not one of the buttons.
    const rendered = card().querySelector(
      '[data-testid="task-card-ready"], [data-testid="task-card-status"]',
    )!;
    expect(rendered.tagName).not.toBe("BUTTON");
  });

  it("the mark is not a pill: the card's pill census does not move", () => {
    // `slabFloatSeparation.test.ts` pins the card's `bg-background` `rounded-full`
    // literal at ONE (the `T{n}` badge). A status glyph wears no fill, so the RENDERED
    // count is ONE and the glyph is not a second pill.
    render(
      <TaskCard
        task={task({ specPath: "/tmp/spec.md" })}
        {...BASE}
        artifactKeys={["plan"]}
        sessionStatus={null}
        ready
      />,
    );
    const pills = Array.from(
      card().querySelectorAll('[class*="rounded-full"]'),
    );
    expect(pills).toHaveLength(1);
    expect(pills.some((p) => p.contains(readyGlyph()!))).toBe(false);
  });

  it("the mark is a glyph with NO text beside it", () => {
    // The refused shape is a faint WORD. Asserted as the ABSENCE of the word from
    // the card's own text, so a future change that adds a `ready` caption next to
    // the glyph (inheriting `text-foreground-subtlest`'s 2.36 / 2.18 on the card)
    // goes red here rather than shipping.
    render(<TaskCard task={task()} {...BASE} sessionStatus={null} ready />);
    const text = card().textContent ?? "";
    expect(text).toContain("Ship the board");
    expect(text).not.toMatch(/ready/i);
    expect(readyGlyph()!.textContent).toBe("");
  });

  it("a click on the mark is answered by the ROW, once", () => {
    // The mark is decoration, not a second way to open something: it has no handler
    // of its own, so a pointer on it activates the card, which is the row's one
    // verb (open the detail modal).
    const onOpenTask = vi.fn();
    const onOpenSession = vi.fn();
    render(
      <TaskCard
        task={task()}
        {...BASE}
        onOpenSession={onOpenSession}
        onOpenTask={onOpenTask}
        sessionStatus={null}
        ready
      />,
    );
    fireEvent.click(readyGlyph()!);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith("tsk_1");
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});
