import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TaskCard, { type TaskCardProps } from "./TaskCard";
import type { TaskRow, TaskSessionRow } from "../lib/tauri";

/**
 * THE `ready` MARK ON THE CARD — the second mark a Task card can wear, and the
 * second one built under the rules the first one had to learn the hard way.
 *
 * ## Why it is a SEPARATE prop and a SEPARATE glyph, not a fifth `SessionStatus`
 *
 * `SessionStatus` is `"waiting" | "running" | "live" | "stored"` and it answers a
 * question about what a Session is DOING RIGHT NOW, derived by one function from
 * four stores. `ready` answers a different question — "the model has finished and
 * wants a look" — and it is authored by the MODEL as a todo item, not derived.
 * Adding `"ready"` to `SessionStatus` would mean editing `sessionStatusOf`,
 * `useSessionStatus`, `SpaceTabs`, `TaskDetailDialog`, the rollup's precedence and
 * `TasksBoard.test.tsx`'s dot census, and it would force two different facts into
 * one slot on one glyph. They are separate because a card can be BOTH: a Session
 * that marked itself ready and then parked on a permission is blocked on you AND
 * finished, and collapsing that into one mark throws away the more actionable
 * half.
 *
 * ## The rules it inherits from the session mark
 *
 *  - **A glyph, never a coloured word.** `text-foreground-subtlest` on `bg-card`
 *    measures 2.36 default-light / 2.18 default-dark and no palette gate can see
 *    it (both Default readings declare that token `textUngradeable`); a faint word
 *    on the card is the explicitly-refused shape. And `text-success` as a 12px
 *    WORD is not a free pass either — `default.ts` records it as a worst resting
 *    reading at 3.87.
 *  - **Its ink is its own.** `SessionStatusMark`'s `className` is GEOMETRY-only
 *    (`cn()` drops an ink utility a caller passes), so it cannot be re-inked from
 *    the card and it cannot be reused for a different meaning. This is a dedicated
 *    glyph.
 *  - **Decoration.** The card is a `RowButton`, and a `div[role="button"]`'s
 *    accessible name is computed RECURSIVELY from its subtree, so an announced
 *    mark renames the card under the user between two frames. Pinned below with
 *    the real accessible-name computation, not with `textContent`.
 *  - **Zero `[role="button"]` matches** — it is an icon, like the `spec` chip and
 *    the artifact key chips are spans, because `SpacesList.test.tsx` resolves rows
 *    through `.closest('[role="button"]')` at eight sites.
 *  - **No new pill, no new caption.** It adds no `rounded-full`, no
 *    `bg-background` and no `text-ui-xs text-foreground-subtlest` pair, so the
 *    `slabFloatSeparation.test.ts` and `mutedCaption.test.ts` censuses do not
 *    move. Pinned here as a rendered count.
 */

/** The `sessionStatus` prop's own type, read off the component rather than
 *  re-spelled, so the table in the precedence case below compiles against the REAL
 *  union and cannot invent a fifth value the card would silently not render. */
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

/** Every prop a card needs that is not this file's subject. `ready` is REQUIRED
 *  (see `TaskCardProps`), so it is deliberately NOT in here: every case below
 *  spells it, which is the point of a required prop. */
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

/** The ready glyph, or `null` for "the card does not report readiness". Queried by
 *  `data-testid` and not by role: it is decoration, so a role query would read
 *  `null` for the CORRECT card and could not tell silent from absent. */
const glyph = (): Element | null =>
  screen
    .getByTestId("task-card")
    .querySelector('[data-testid="task-card-ready"]');

describe("TaskCard — the ready mark", () => {
  it("a ready card shows the glyph", () => {
    render(<TaskCard task={task()} {...BASE} sessionStatus={null} ready />);
    const mark = glyph();
    expect(mark).not.toBeNull();
    // The app's ONE "finished" shape: `SubagentStatusIcon`'s `completed` case and
    // `ChecklistPanel`'s done indicator both draw a check in a circle, and a third
    // spelling of "done" would be a third glyph for one fact.
    expect(mark!.tagName).toBe("svg");
    // The success ink, on a GLYPH. Measured against `bg-card` in all 13 palette
    // readings (see the case below that pins the numbers): worst 2.69
    // (Everforest light), and every one of them clears that palette's OWN recorded
    // raised-step floor for `color-success`. It is also the best-measuring of the
    // three marks a card can wear — `text-warning`'s `?` is 2.12 Everforest light /
    // 2.16 Rosé Pine light / 2.31 Catppuccin light, and the `running` spinner's
    // `text-foreground-subtlest` is 2.36 default-light / 2.18 default-dark.
    expect((mark!.getAttribute("class") ?? "").split(/\s+/)).toContain(
      "text-success",
    );
  });

  it("a card that is not ready shows no glyph", () => {
    // `false` is the value the board produces for a card no Session has marked, and
    // it renders NOTHING — no placeholder, no reserved slot, exactly like the spec
    // chip, the artifact chips and the session mark for an absent fact.
    render(
      <TaskCard task={task()} {...BASE} sessionStatus={null} ready={false} />,
    );
    expect(glyph()).toBeNull();
    expect(screen.getByTestId("task-card").textContent).toContain("T3");
  });

  it("the ready mark is DECORATION: it does not rename the card", () => {
    // THE ACCESSIBLE-NAME PIN, and it is the one that matters. `TaskCard` is a
    // `RowButton`; a `div[role="button"]`'s name is computed RECURSIVELY from its
    // subtree, so a mark carrying `aria-label="Ready"` would turn the card's name
    // into "Ship the board Ready" between two frames — the same mid-turn rename
    // that made the tab strip pass `announce={false}`.
    //
    // Asserted through `getByRole`'s own `{ name }` option, which runs testing-
    // library's accessible-name computation and therefore DOES see an `aria-label`.
    // `textContent` could not: the defect this pins is invisible to it, so a
    // `textContent` assertion here would be a vacuous green.
    //
    // `dom-accessibility-api` is the package underneath that computation but it is
    // TRANSITIVE only (pnpm's strict layout will not resolve it from `src/`), and
    // this adds no dependency — `getByRole` already reaches it.
    const { unmount } = render(
      <TaskCard task={task()} {...BASE} sessionStatus="waiting" ready />,
    );
    // The card IS named — by its own content — so the negative below is not the
    // vacuous "nothing is ever named" kind.
    expect(
      screen.getAllByRole("button", { name: /Ship the board/ }),
    ).toHaveLength(1);
    // …and the mark is not in that name. A `ready` in the name means the glyph is
    // announced, and the row is being renamed under the user.
    expect(screen.queryAllByRole("button", { name: /ready/i })).toHaveLength(0);
    // The glyph is hidden from the accessibility tree outright, which is the
    // mechanism (`aria-hidden`), not merely an absence the next frame undoes.
    expect(glyph()!.getAttribute("aria-hidden")).toBe("true");
    unmount();

    // The SAME card with the mark removed resolves to the SAME one control: the
    // glyph contributes nothing to the name in either direction.
    render(
      <TaskCard
        task={task()}
        {...BASE}
        sessionStatus="waiting"
        ready={false}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: /Ship the board/ }),
    ).toHaveLength(1);
  });

  it('the mark adds ZERO `[role="button"]` matches and zero `<button>`s', () => {
    // `SpacesList.test.tsx` resolves rows through `.closest('[role="button"]')` at
    // eight sites, and `RowButton`'s contract is ONE match per row. Counted with
    // both nested controls present (the chip and the pill are real `<button>`s) so
    // the numbers describe a fully-populated card, not an empty one.
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
    expect(document.querySelectorAll('[role="button"]')[0]).toBe(
      screen.getByTestId("task-card"),
    );
    expect(
      screen.getByTestId("task-card").querySelectorAll("button"),
    ).toHaveLength(2);
    expect(glyph()!.tagName).not.toBe("BUTTON");
  });

  it("the mark is not a pill: the card's pill census does not move", () => {
    // `slabFloatSeparation.test.ts` counts `bg-background`-filled `rounded-full`
    // literals in `TaskCard.tsx` and pins the number at FIVE. A status glyph is not
    // a pill — it wears no fill — so the count of RENDERED pills must stay what it
    // was before this mark existed: `T{n}` + spec + one artifact key + the sessions
    // chip = 4, and the mark is not a fifth.
    render(
      <TaskCard
        task={task({ specPath: "/tmp/spec.md" })}
        {...BASE}
        artifactKeys={["plan"]}
        sessionStatus="waiting"
        ready
      />,
    );
    const pills = Array.from(
      screen
        .getByTestId("task-card")
        .querySelectorAll('[class*="rounded-full"]'),
    );
    expect(pills).toHaveLength(4);
    expect(pills.some((p) => p.contains(glyph()!))).toBe(false);
  });

  it("the mark sits beside the session mark, and one never suppresses the other", () => {
    // THE PRECEDENCE DECISION, pinned as behaviour. `ready` is ADDITIVE, not a
    // precedence slot: a card whose Session marked itself ready and then parked on
    // a permission shows BOTH the check and the `?`, because both are true and the
    // pair is more actionable than either half. Making `ready` outrank `waiting`
    // would hide the prompt behind a "done" mark — the worst possible ordering of
    // these two facts.
    const cases: Array<[SessionStatusOfProp, boolean]> = [
      ["waiting", true],
      ["running", true],
      ["waiting", false],
      ["running", false],
      [null, true],
      [null, false],
    ];
    for (const [status, ready] of cases) {
      const { unmount } = render(
        <TaskCard
          task={task()}
          {...BASE}
          sessionStatus={status}
          ready={ready}
        />,
      );
      const card = screen.getByTestId("task-card");
      const hasSessionMark =
        card.querySelector('[data-testid="task-card-status"]') !== null;
      const hasReadyMark = glyph() !== null;
      expect(hasSessionMark, `sessionStatus=${status}`).toBe(status !== null);
      expect(hasReadyMark, `ready=${ready}`).toBe(ready);
      unmount();
    }
  });

  it("the mark is a glyph with NO text beside it", () => {
    // The refused shape is a faint WORD. Asserted as the ABSENCE of the word from
    // the card's own text, so a future change that adds a `ready` caption next to
    // the glyph (and inherits `text-foreground-subtlest`'s 2.36 / 2.18 on the card)
    // goes red here rather than shipping.
    render(<TaskCard task={task()} {...BASE} sessionStatus={null} ready />);
    const text = screen.getByTestId("task-card").textContent ?? "";
    expect(text).toContain("Ship the board");
    expect(text).not.toMatch(/ready/i);
    // And the glyph carries no text node of its own.
    expect(glyph()!.textContent).toBe("");
  });

  it("a click on the mark is answered by the ROW, once", () => {
    // The mark is decoration, not a second way to open something: it has no handler
    // of its own, so a pointer on it activates the card, which is the row's one
    // verb (open the detail modal). `userEvent` is not needed — `fireEvent` on the
    // glyph bubbles to the row exactly as a real click does.
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
    // The glyph sits INSIDE the row, so a click on it reaches the row's handler
    // through the normal bubble — `fireEvent.click` dispatches a bubbling click,
    // which is what a real pointer on the glyph does.
    fireEvent.click(glyph()!);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith("tsk_1");
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});
