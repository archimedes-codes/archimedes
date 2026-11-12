import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TaskCard, { type TaskCardProps } from "./TaskCard";
import type { DragCardHandlers } from "../hooks/useDragCard";
import type { TaskLaunchDestination } from "../lib/taskPrompt";
import type { TaskRow, TaskSessionRow } from "../lib/tauri";

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so a
// bare `import "node:fs"` does not typecheck. The idiom `classNameConvention.test.ts`
// and `tauriBoundary.test.ts` use, borrowed here for the one assertion below that
// can only be made against SOURCE.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/** Strip JS comments before scanning, matching the helper
 *  `classNameConvention.test.ts` / `mutedCaption.test.ts` use. A name that appears
 *  only in a doc-comment is PROSE, not a consumer. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/**
 * `TaskCard` — one board card.
 *
 * The pin that matters here is NOT "renders a title". It is that the card spreads
 * `useDragCard`'s FIVE-key surface and does NOT reach for `useDragReorder`'s
 * six-key `DragReorderHandlers`, because that surface is pinned at six keys for a
 * byte-compared `RowButton` and the two are not interchangeable. So the drag test
 * below counts the attributes the card emits rather than trusting the prop type —
 * a component that quietly imported the wrong hook would still typecheck if someone
 * widened a type, and the DOM is what the contract is about.
 *
 * It is also NOT a `RowButton`, and the tests pin that: a `role="button"` here
 * would collide with `RowButton`'s one-role-per-row rule (`SpacesList.test.tsx`
 * reaches rows through `.closest('[role="button"]')` at eight sites), and a card is
 * not one of the five row affordances that component owns.
 */

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "tsk_1",
  spacePath: "/w/alpha",
  number: 3,
  title: "Ship the board",
  body: null,
  specPath: null,
  stageSlug: "doing",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** One `task_sessions` link (issue #174). The board hands a card its links as the
 *  wire row, OLDEST FIRST — the order `Db::task_sessions` publishes — which is why
 *  the chip's "newest" is the LAST entry and the click test below hands the array
 *  in that order on purpose. */
const link = (sessionId: string, over: Partial<TaskSessionRow> = {}): TaskSessionRow => ({
  taskId: "tsk_1",
  sessionId,
  stageSlug: "doing",
  ...over,
});

/** A callback that exists and does nothing, for the cases whose subject is not the
 *  chip's click. `onOpenSession` is a REQUIRED prop (see `TaskCardProps`), so every
 *  render has to answer "what opens the Session?" — and a `vi.fn()` per case would
 *  read like the click is what the case is about. `NO_LINKS` carries it for the
 *  anatomy cases below, which have no links for the callback to open. */
const noopOpenSession = (): void => {};

/** Same argument as above, for the card's OTHER callback. `onOpenTask` is REQUIRED
 *  because the card IS now a control (it is a `RowButton`), so a card rendered
 *  without it is a keyboard-focusable row that does nothing when activated — the
 *  exact silent-green shape this file's own `onOpenSession` pin documents, arriving
 *  one prop later. */
const noopOpenTask = (): void => {};

/** The props every render must pass, spelled out at every call site that has
 *  nothing to say about Sessions. They are REQUIRED props rather than optional ones
 *  for the same reason `TaskCardView`'s fields are required in `types.ts`: an
 *  optional prop compiles against a caller that forgot it, and a card that forgot
 *  them renders a linked card with no chip — or a chip that opens nothing. A case
 *  that cares about links overrides them; the anatomy cases below do not.
 *
 *  `launchStep` is in here as `undefined` on purpose, and it is the ONLY optional
 *  prop on the card. The pill it drives is absent for a real reason on most cards —
 *  a last Stage has no next step at all — so `undefined` is a value the production
 *  board produces, not a caller forgetting to pass something. That distinguishes it
 *  from `onOpenSession`, where an absent callback means a painted button wired to
 *  nothing; the pill simply is not painted here, which the "no CONTROLS" case below
 *  pins.
 *
 *  `artifactKeys` is `[]` because a card with NO artifacts is the common case (issue
 *  #180), and because it is a REQUIRED prop: the fixture default is what makes every
 *  existing case compile, and the cases that care about chips pass the prop beside
 *  this spread. It is NOT a field of the `task()` helper — `TaskRow` has no such
 *  field; the keys ride `TaskCardView` and arrive as their own prop. */
const NO_LINKS: Pick<
  TaskCardProps,
  | "sessions"
  | "costUsd"
  | "artifactKeys"
  | "onOpenSession"
  | "onOpenTask"
  | "launchStep"
> = {
  sessions: [],
  costUsd: null,
  artifactKeys: [],
  onOpenSession: noopOpenSession,
  onOpenTask: noopOpenTask,
  launchStep: undefined,
};

/** A card's primary next step (issue #179 §7.1), derived by the BOARD.
 *
 *  Defaults to a Skill-less destination, because that is the state that needs no
 *  catalog to be clickable and so lets a case assert the pill's SHAPE without first
 *  waiting on an async fetch. A case about the catalog gate overrides `launchReady`
 *  or gives the destination a Skill. */
const launchStep = (
  over: Partial<{
    destination: TaskLaunchDestination;
    launchReady: boolean;
    onLaunch: (destination: TaskLaunchDestination) => void;
  }> = {},
): NonNullable<TaskCardProps["launchStep"]> => ({
  destination: { slug: "approved", label: "Approved", onEnterSkill: null },
  launchReady: true,
  onLaunch: vi.fn(),
  ...over,
});

/**
 * The class STRING via the ATTRIBUTE, not `el.className` — the property is an
 * `SVGAnimatedString` for SVG elements (`MutedCaption.test.tsx` carries the same
 * note, and this helper is copied from there). It moved from inside the ladder
 * `describe` to module scope because the ANATOMY cases below read classes too, and
 * a helper two `describe` blocks away from one of its readers is a trap.
 */
function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

/** Whole class TOKENS, so a substring of a longer utility cannot satisfy a
 *  `toContain` the way it would on the raw class string. */
const classTokens = (el: Element): string[] => classOf(el).split(/\s+/);

/** A nested CONTROL inside the card, resolved by its label AND by being a real
 *  `<button>`.
 *
 *  The `tagName` filter is not a nicety, it is the discriminator: `getAllByRole("button")`
 *  also matches the CARD, because `RowButton` is a `div[role=button]` whose accessible
 *  NAME is computed recursively and therefore CONTAINS the pill's own text. So
 *  `getByRole("button", { name: /Approved/ })` is a multiple-match throw on a correct
 *  card — and the two candidates are exactly the two things the pill's pins are about
 *  (a real control, nested in a row), so separating them by element type is the honest
 *  instrument rather than a workaround. */
const controlsNamed = (label: string): HTMLElement[] =>
  screen
    .getAllByRole("button")
    .filter(
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes(label),
    );

const controlNamed = (label: string): HTMLElement => {
  const hits = controlsNamed(label);
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one <button> carrying "${label}", found ${hits.length}`,
    );
  }
  return hits[0]!;
};

/** A spread surface that records which handler ran, so the spread can be asserted
 *  as BEHAVIOUR and not only as an attribute list. */
const dragSurface = (): DragCardHandlers => ({
  draggable: true,
  onDragStart: vi.fn(),
  onDragOver: vi.fn(),
  onDrop: vi.fn(),
  onDragEnd: vi.fn(),
});

describe("TaskCard — what it renders", () => {
  it("shows the per-Space number label and the title", () => {
    render(<TaskCard task={task()} {...NO_LINKS} />);
    // `T3`, spelled as the label a person says out loud. `number` is per-Space and
    // `id` is the global key (ADR 0090) — the card shows the LABEL, and the id
    // belongs to the drag payload and every other command, never to the human.
    expect(screen.getByText("T3")).toBeTruthy();
    expect(screen.getByText("Ship the board")).toBeTruthy();
    expect(screen.queryByText("tsk_1")).toBeNull();
  });

  it("renders a card with a body and one without (body is nullable on the wire)", () => {
    const { unmount } = render(
      <TaskCard task={task({ body: "the details" })} {...NO_LINKS} />,
    );
    expect(screen.getByText("the details")).toBeTruthy();
    unmount();
    render(<TaskCard task={task({ body: null })} {...NO_LINKS} />);
    expect(screen.getByText("Ship the board")).toBeTruthy();
  });

  it("a card title wraps instead of clipping", () => {
    // The title is the card's subject, and a card that clips it to one line hides
    // the only sentence on it. `truncate` is `overflow:hidden; white-space:nowrap`
    // — it is a CLIP, so a two-line title lost its second half with no affordance.
    // `line-clamp-2` bounds the height the same way (a card strip cannot grow
    // without limit) but WRAPS to get there, and `leading-snug` is the reference's
    // title rhythm.
    //
    // Class tokens and not a rendered height: jsdom performs no layout, so the
    // honest instrument here is the utility the merge actually emitted.
    render(<TaskCard task={task()} {...NO_LINKS} />);
    const tokens = classTokens(screen.getByText("Ship the board"));
    expect(tokens).toContain("line-clamp-2");
    expect(tokens).toContain("font-medium");
    expect(tokens).toContain("leading-snug");
    expect(tokens).not.toContain("truncate");
  });

  it("a card with a spec shows the spec chip, and one without shows none", () => {
    // Net-new coverage: `specPath` is stored, crosses IPC and is read by the boost
    // prompt, but NOTHING rendered it — so no existing pin protected it and a
    // dropped field would have been silent. The chip is CONDITIONAL on the data
    // existing rather than a placeholder for its absence, and the query pins the
    // LABEL and not a `data-testid`: the string is the thing that can drift.
    const { unmount } = render(
      <TaskCard
        task={task({ specPath: "/tmp/spec.md" })}
        {...NO_LINKS}
      />,
    );
    const chip = screen.getByText("spec");
    const tokens = classTokens(chip);
    expect(tokens).toContain("rounded-full");
    // The fill must differ from BOTH surfaces a chip can land on — the column's
    // `bg-panel` and this card's `bg-card` — IN EVERY PALETTE, and `bg-chat` fails
    // that: its default-dark `color-mix` base (`--color-background-win-alt`, `#2b2b2b`)
    // IS `--color-card`, so a chip wearing it over a card composites to the card —
    // contrast 1.00, invisible. The 1.22 / 1.21 figures that justified it were
    // Dracula-only (ADR 0096's single-palette-check error). `bg-background`
    // measures 1.10/1.34 Dracula, 1.11/1.28 default-dark, 1.06/1.06 default-light; the
    // per-palette census is `src/lib/slabFloatSeparation.test.ts`.
    expect(tokens).toContain("bg-background");
    // The path itself is not the chip's text — it is a pointer, not a title, and
    // rendering it would put an absolute filesystem path on every card.
    expect(chip.textContent).toBe("spec");
    unmount();
    render(<TaskCard task={task({ specPath: null })} {...NO_LINKS} />);
    expect(screen.queryByText("spec")).toBeNull();
  });

  it("carries the task id as the drag payload handle", () => {
    // The board's drag handlers are keyed by id, so the DOM has to expose which
    // card a node is — otherwise a drop cannot say which card moved.
    render(<TaskCard task={task()} {...NO_LINKS} />);
    expect(screen.getByTestId("task-card").getAttribute("data-task-id")).toBe(
      "tsk_1",
    );
  });
});

describe("TaskCard — the artifact key chips (issue #180)", () => {
  /** Every `rounded-full` node the card renders, in document order. The census in
   *  `slabFloatSeparation.test.ts` counts the class LITERALS in the source; this is
   *  its rendered twin, and it is what lets an absent-chip case say "no EXTRA node"
   *  instead of merely "no text". */
  const pillNodes = (): Element[] =>
    Array.from(
      screen.getByTestId("task-card").querySelectorAll('[class*="rounded-full"]'),
    );

  it("a card with artifact keys renders one chip per key, beside the spec chip", () => {
    // The keys are NAMES and nothing else — the board read carries `artifactKeys`
    // alone (spec §1: one `markdown` column on that payload would put every Task's
    // every document on the wire just to render a chip), and reading a document is
    // the detail modal's job. So the card's whole artifact surface is this label
    // row, and it must not grow one.
    render(
      <TaskCard
        task={task({ specPath: "/tmp/spec.md" })}
        {...NO_LINKS}
        artifactKeys={["plan", "research"]}
      />,
    );
    for (const key of ["plan", "research"]) {
      const chip = screen.getByText(key);
      // A LABEL, not the document: the chip's whole text is the key.
      expect(chip.textContent).toBe(key);
      const tokens = classTokens(chip);
      expect(tokens).toContain("rounded-full");
      // The fill is the card's ONE pill recipe — the page step, because a chip has
      // to differ from both surfaces it can land on (`bg-panel` column, `bg-card`
      // card) in every palette, and `bg-chat` is exactly `bg-card` in default-dark.
      expect(tokens).toContain("bg-background");
      expect(tokens).not.toContain("bg-chat");
      expect(chip.tagName).toBe("SPAN");
    }
    // BESIDE the spec chip: the same sibling flow inside the card, and the spec chip
    // is still the spec chip — an artifact key never replaces it or borrows its
    // label.
    const spec = screen.getByText("spec");
    expect(spec.tagName).toBe("SPAN");
    expect(spec.parentElement).toBe(screen.getByTestId("task-card"));
    expect(screen.getByText("plan").parentElement).toBe(spec.parentElement);
    // Two keys, TWO pills, and the spec chip is untouched: `T{n}` + spec + 2 keys.
    expect(pillNodes()).toHaveLength(4);
  });

  it("a card with NO artifact keys renders NO artifact chip at all", () => {
    // The empty set is not a state to announce. The gate is `artifactKeys.length >
    // 0`, so an artifact-less card — the common case, and what the `NO_LINKS`
    // fixture default spells — renders no header line, no placeholder, no empty
    // pill. The same rule the spec chip already follows for an absent `specPath`.
    // `artifactKeys={[]}` spelled explicitly AFTER the spread (the spread would
    // overwrite a prop written before it) so the case states its own subject rather
    // than inheriting the fixture default silently.
    const { unmount } = render(
      <TaskCard
        task={task({ specPath: "/tmp/spec.md" })}
        {...NO_LINKS}
        artifactKeys={[]}
      />,
    );
    expect(pillNodes()).toHaveLength(2);
    unmount();
    render(
      <TaskCard task={task({ specPath: null })} {...NO_LINKS} artifactKeys={[]} />,
    );
    // Just the `T{n}` pill: no spec chip, no artifact chip.
    expect(pillNodes()).toHaveLength(1);
  });

  it("the artifact chips add NO [role=button] match (the one-per-row rule holds)", () => {
    // `RowButton`'s load-bearing constraint, and the reason these chips are
    // `<span>`s: `SpacesList.test.tsx` resolves rows through
    // `.closest('[role="button"]')` at eight sites, so a second match inside a card
    // would move the ancestor those reads land on. A `<button>` would not be
    // matched by the ATTRIBUTE selector, but a spelled `role` would — and a chip is
    // not a control, so the span shape is the one with nothing to get wrong.
    render(
      <TaskCard
        task={task()}
        {...NO_LINKS}
        artifactKeys={["plan", "research"]}
        drag={dragSurface()}
      />,
    );
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
    const chip = screen.getByText("research");
    expect(chip.getAttribute("role")).toBeNull();
    expect(chip.closest('[role="button"]')).toBe(screen.getByTestId("task-card"));
  });

  it("the artifact key chip carries no handler of its own (the row answers its click, once)", () => {
    // The chip is a LABEL: no `onClick`, no `role`, nothing wired. A click on it is
    // answered by the CARD's own row `onClick` — which is the intended path, since
    // spec §3 puts reading the document in the detail modal and the modal is what
    // the row opens. So the honest claim is not "a click on a key does nothing" (it
    // cannot be nothing; the chip sits INSIDE a `RowButton`) but "the chip neither
    // swallows the click nor fires a second one".
    //
    // Exactly ONE call is the mutation-sensitive form: a chip that grew its own
    // `onOpenTask` would answer TWICE, and a chip that grew `stopPropagation` —
    // right for a control, wrong for a label — would answer ZERO and make the word
    // `plan` a dead patch on a card that is otherwise clickable.
    const onOpenTask = vi.fn();
    render(
      <TaskCard
        task={task()}
        {...NO_LINKS}
        artifactKeys={["plan"]}
        onOpenTask={onOpenTask}
      />,
    );
    const chip = screen.getByText("plan");
    expect(chip.tagName).toBe("SPAN");
    fireEvent.click(chip);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith("tsk_1");
  });
});

describe("TaskCard — the drag surface it spreads", () => {
  it("emits draggable=true when it is handed a drag surface", () => {
    render(
      <TaskCard task={task()} {...NO_LINKS} drag={dragSurface()} />,
    );
    expect(screen.getByTestId("task-card").getAttribute("draggable")).toBe("true");
  });

  it("wires ALL FOUR of the cross-column handlers it was handed", () => {
    // Behaviour, not attributes: React attaches event handlers as props and emits
    // NO `on*` attribute, so an attribute count here would read zero for every
    // handler and certify nothing. Firing each event is the instrument that can
    // actually see the spread.
    const drag = dragSurface();
    render(<TaskCard task={task()} {...NO_LINKS} drag={drag} />);
    const el = screen.getByTestId("task-card");
    fireEvent.dragStart(el, { dataTransfer: { setData: vi.fn() } });
    fireEvent.dragEnd(el);
    fireEvent.dragOver(el);
    fireEvent.drop(el);
    expect(drag.onDragStart).toHaveBeenCalledTimes(1);
    expect(drag.onDragEnd).toHaveBeenCalledTimes(1);
    expect(drag.onDragOver).toHaveBeenCalledTimes(1);
    expect(drag.onDrop).toHaveBeenCalledTimes(1);
  });

  it("reaches for useDragCard and NOT for the six-key reorder surface", () => {
    // THE PIN, and the reason it is a source assertion. `useDragReorder`'s
    // `dragProps` is pinned at exactly six keys because `RowButton` spreads it
    // VERBATIM onto a byte-compared row; `useDragCard`'s is five. The two prop
    // types look interchangeable to `tsc` the moment anyone widens one, and the
    // DOM cannot tell them apart either — so this repo's other instrument, a source
    // scan (`tauriBoundary.test.ts`, `classNameConvention.test.ts`), is the honest
    // one. A "unify the drag hooks" sweep that points the card at the reorder hook
    // reddens HERE, in the file that owns the claim.
    // COMMENT-STRIPPED, and that is load-bearing rather than tidy: this file's own
    // doc-comment NAMES `useDragReorder` to explain why the card does not use it.
    // A raw read would convict the explanation — the same prose-as-consumer trap
    // `mutedCaption.test.ts` and `themeTokens.test.ts` both record being bitten by.
    const src = stripJsComments(readFileSync("src/components/TaskCard.tsx", "utf8"));
    expect(src).toContain("useDragCard");
    expect(src).not.toContain("useDragReorder");
    expect(src).not.toContain("DragReorderHandlers");
    // And the type it spreads is the five-key one.
    expect(src).toContain("DragCardHandlers");
    // Vacuity guard: a stripper that consumed EVERYTHING would satisfy the three
    // `not.toContain` lines trivially, so the positive read above is paired with a
    // count that only holds if real code survived the strip.
    expect(src).toContain("export default function TaskCard");
  });

  it("with no drag prop, the card is not draggable at all", () => {
    // TWO COMPETING ANSWERS: a card that defaulted to `draggable` with no handlers
    // would start a native drag that NOTHING resolves — the browser shows a drag
    // ghost, every drop is refused, and no code path runs. Absent handlers mean an
    // absent gesture.
    render(<TaskCard task={task()} {...NO_LINKS} />);
    const el = screen.getByTestId("task-card");
    expect(el.getAttribute("draggable")).toBeNull();
  });

  it("marks the card being dragged", () => {
    render(
      <TaskCard task={task()} {...NO_LINKS} drag={dragSurface()} active />,
    );
    expect(screen.getByTestId("task-card").getAttribute("data-dragging")).toBe("true");
  });

  it("does not mark a card it is merely rendering", () => {
    render(<TaskCard task={task()} {...NO_LINKS} />);
    expect(screen.getByTestId("task-card").hasAttribute("data-dragging")).toBe(false);
  });

  it("owns NO drop-target state — the column carries it, so a target is painted once", () => {
    // TWO COMPETING ANSWERS for "where does this land": the column the pointer is
    // over, or the card nearest it. The COLUMN wins (it is what `useDragCard`'s
    // hit test resolves, and an empty column has no card to mark), so a card-level
    // `data-over` would be a second answer — and on a two-card column, three borders
    // for one target.
    render(
      <TaskCard task={task()} {...NO_LINKS} drag={dragSurface()} active />,
    );
    expect(screen.getByTestId("task-card").hasAttribute("data-over")).toBe(false);
  });
});

describe("TaskCard — the card is a control (PR #178 inverts this)", () => {
  it("is a RowButton: role=button, tabindex=0, and Enter activates", () => {
    // THE DELIBERATE INVERSION. Until now the card was a plain `div` with no role
    // and no tabindex, on the reasoning that a card is DRAGGED and not clicked.
    // Opening a Task as a whole is the surface that reasoning deferred ("a later
    // surface" in this file's own header), and it arrived here rather than as a
    // second control on the card because a card whose whole area is not clickable
    // reads as broken once clicking it is the way to read it.
    //
    // `RowButton` and not a hand-rolled `role`: it is the repo's ONE component for
    // this affordance, and its header's constraint is exactly what the two cases
    // below re-pin — ONE `role="button"` per row, and the nested chip stays a plain
    // `<button>` with no role so it contributes zero selector matches.
    render(<TaskCard task={task()} {...NO_LINKS} drag={dragSurface()} />);
    const el = screen.getByTestId("task-card");
    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.tagName).toBe("DIV");
  });

  it("a click on the card opens the Task", () => {
    // `fireEvent.click` and not `userEvent`: the card is `draggable`, and the
    // question here is only whether the handler is wired. (That a real drag
    // suppresses the click is browser behaviour jsdom cannot produce — so the
    // `draggable` + `onClick` coexistence is pinned as DATA below instead, which is
    // the part a test here can actually see.)
    const onOpenTask = vi.fn();
    render(
      <TaskCard
        task={task()}
        {...NO_LINKS}
        onOpenTask={onOpenTask}
        drag={dragSurface()}
      />,
    );
    fireEvent.click(screen.getByText("Ship the board"));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it("Enter on the focused card opens the Task (the keyboard path)", () => {
    // A card reachable only by mouse is not reachable: the board is a grid of
    // focusable rows now, and `RowButton`'s Enter handler is the whole keyboard
    // contract. Space stays inert — that is `RowButton`'s rule, pinned in its own
    // test, and re-asserted here because a card is a bigger click target for a
    // mis-keystroke than a sidebar row is.
    const onOpenTask = vi.fn();
    render(<TaskCard task={task()} {...NO_LINKS} onOpenTask={onOpenTask} />);
    const row = screen.getByTestId("task-card");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: " " });
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it("is BOTH draggable and clickable, and the drag surface still lands", () => {
    // The two gestures share one element, and the risk is a spread that silently
    // drops the drag half. `RowButton` spreads `...rest` LAST, so `draggable` and
    // the four drag handlers survive onto the DOM after its own `role` / `onClick`.
    const drag = dragSurface();
    render(<TaskCard task={task()} {...NO_LINKS} drag={drag} />);
    const el = screen.getByTestId("task-card");
    expect(el.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(el);
    expect(drag.onDragStart).toHaveBeenCalledTimes(1);
    fireEvent.click(el);
  });

  it("the sessions chip still resolves to the CARD as its role=button ancestor", () => {
    // `RowButton`'s constraint is ONE match per row, and this is the assertion that
    // would catch a second `role` appearing (on the chip, say). It used to read
    // "closest is null" because the card had no role at all; now the card is the
    // role, so the chip must resolve TO the card and not to something nearer.
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_1")]}
        costUsd={null}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );
    const chip = screen.getByText("1 session");
    expect(chip.closest('[role="button"]')).toBe(screen.getByTestId("task-card"));
    // The chip is a real `<button>` and carries NO role of its own, so it adds
    // nothing to the selector the sidebar resolves rows through.
    expect(chip.getAttribute("role")).toBeNull();
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
  });

  it("a chip click opens the SESSION and does NOT also open the detail modal", () => {
    // THE `stopPropagation` PIN, and it reverses this file's previous measurement.
    // The chip's old comment said "there is nothing to stop" — true when the card
    // had no `onClick`. Now the card IS the affordance, so a chip click bubbles into
    // the row's handler and BOTH surfaces open: the Session appears and the modal
    // paints over it. That is not a cosmetic double-open — the modal then sits on
    // top of the transcript the user just asked to see.
    const onOpenSession = vi.fn();
    const onOpenTask = vi.fn();
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_1")]}
        costUsd={null}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={onOpenSession}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByText("1 session"));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("a card with no links is still clickable", () => {
    // The chip is conditional; the row is not. A card with no Session is the common
    // case on a fresh board and it has to open too.
    const onOpenTask = vi.fn();
    render(<TaskCard task={task()} {...NO_LINKS} onOpenTask={onOpenTask} />);
    expect(screen.queryByRole("button", { name: /session/ })).toBeNull();
    fireEvent.click(screen.getByTestId("task-card"));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });
});

describe("TaskCard — the primary-next-step pill (issue #179 §7.1)", () => {
  it("renders the destination label as a real control with the card's pill recipe", () => {
    // The pill is the card's ONE launch affordance: the primary next step, labelled
    // with the DESTINATION Stage's label (not the card's, not the current column's)
    // because the destination is what the click acts on.
    //
    // The class tokens are asserted because the recipe is a measured decision, not a
    // taste one: `bg-background` is the only fill that differs from BOTH the column's
    // `bg-panel` and the card's `bg-card` in every palette (`bg-chat` is EXACTLY
    // `bg-card` in default-dark — contrast 1.00, an invisible pill), and
    // `slabFloatSeparation.test.ts` censuses this literal. `transition-*` is absent on
    // the `FileChip` reasoning that file records.
    render(<TaskCard task={task()} {...NO_LINKS} launchStep={launchStep()} />);
    const pill = controlNamed("Approved");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("type")).toBe("button");
    const tokens = classTokens(pill);
    expect(tokens).toContain("self-start");
    expect(tokens).toContain("rounded-full");
    expect(tokens).toContain("bg-background");
    expect(tokens).not.toContain("bg-chat");
    expect(tokens).not.toContain("bg-card");
    expect(tokens.filter((t) => /^bg-/.test(t))).toEqual(["bg-background"]);
    expect(tokens.some((t) => t.startsWith("transition-"))).toBe(false);
  });

  it("carries NO role, so the card keeps its row's ONE role=button", () => {
    // THE CONSTRAINT `SpacesList.test.tsx` CANNOT PIN, which is why it lives here.
    // `RowButton`'s one-`role="button"`-per-row rule is enforced by eight
    // `.closest('[role="button"]')` sites in `SpacesList.test.tsx`, and that file never
    // MOUNTS a `TaskCard` — so without this case, a pill that spelled `role="button"`
    // would pass every existing pin while breaking the selector the sidebar resolves
    // rows through. The card is the only place the pill exists, so the only place the
    // rule can be proved is the card's own file.
    //
    // Asserted with the pill PRESENT and with a sessions chip also present, because
    // those are the two nested controls; a count taken with neither would pass on an
    // empty card and prove nothing about them.
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_1")]}
        costUsd={null}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={noopOpenSession}
        onOpenTask={noopOpenTask}
        launchStep={launchStep()}
        drag={dragSurface()}
      />,
    );
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
    // And the ONE match is the CARD: the pill resolves to it rather than being its own
    // row, which is what a sidebar `.closest()` read from a pill would return.
    expect(screen.getByText(/Approved/).closest('[role="button"]')).toBe(
      screen.getByTestId("task-card"),
    );
    expect(controlNamed("Approved").getAttribute("role")).toBeNull();
  });

  it("a pill click launches AND does NOT open the detail modal", () => {
    // THE `stopPropagation` PIN, and it is the same defect the sessions chip carries a
    // case for: the card is a `RowButton`, so an unstopped click on anything inside it
    // bubbles into the row's `onClick` and paints the detail modal ON TOP of the
    // Session the click just asked to see. Here it is worse than a double-open — the
    // modal would cover the board the launched Session is meant to leave.
    const onLaunch = vi.fn();
    const onOpenTask = vi.fn();
    render(
      <TaskCard
        task={task()}
        {...NO_LINKS}
        onOpenTask={onOpenTask}
        launchStep={launchStep({ destination: { slug: "approved", label: "Approved", onEnterSkill: null }, onLaunch })}
      />,
    );
    fireEvent.click(controlNamed("Approved"));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    // The callback receives the DESTINATION it was handed, not a value the card
    // re-derived: the card is presentational and owns no opinion about where a card
    // goes next.
    expect(onLaunch).toHaveBeenCalledWith({
      slug: "approved",
      label: "Approved",
      onEnterSkill: null,
    });
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("paints NO pill for a Skill the catalog has not landed", () => {
    // The catalog is an async fetch that starts EMPTY, so an ungated pill is clickable
    // before it lands and fails with "This Space has no `research` skill" — a sentence
    // that is false two frames later. The board therefore passes `launchReady: false`
    // and the card paints NOTHING rather than a disabled pill: a card is a compact
    // surface, and a permanently-greyed control on every card during the fetch is the
    // "second button on the card" visual pass warns about. A destination with NO Skill
    // is never in this state — nothing is waiting.
    const onLaunch = vi.fn();
    render(
      <TaskCard
        task={task()}
        {...NO_LINKS}
        launchStep={launchStep({
          destination: { slug: "research", label: "Research", onEnterSkill: "research" },
          launchReady: false,
          onLaunch,
        })}
      />,
    );
    expect(controlsNamed("Research")).toHaveLength(0);
    // Nothing clickable at all, not even a disabled affordance.
    expect(screen.getByTestId("task-card").querySelectorAll("button")).toHaveLength(
      0,
    );
    fireEvent.click(screen.getByTestId("task-card"));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("the drag surface still lands on the ROW with the pill present", () => {
    // THE RISK THE PILL ACTUALLY INTRODUCES, and the honest version of a "the drop
    // must not launch" pin. Two spreads share this element's gesture space now: the
    // card's five-key `drag` surface and a nested control that stops its own click. The
    // failure to guard against is the pill displacing `drag` (or the board answering a
    // drop from the pill's subtree), because a drop that started a Session would render
    // the board over the transcript its own `ask` gate needs — `ask_flow` blocks on a
    // oneshot with NO timeout, so the board would hang on its own launch.
    //
    // What THIS file can prove is the half at its own boundary: a drop bubbling up from
    // the pill's subtree reaches the ROW's drag handler and nothing else happens. The
    // other half — that the board's drop route never calls `launchTaskSession` — is a
    // `TasksBoard` claim and cannot be observed from a card render; it is reported as a
    // gap for `TasksBoard.test.tsx`, which this task does not own.
    const onLaunch = vi.fn();
    const onOpenTask = vi.fn();
    const drag = dragSurface();
    render(
      <TaskCard
        task={task()}
        {...NO_LINKS}
        drag={drag}
        onOpenTask={onOpenTask}
        launchStep={launchStep({ onLaunch })}
      />,
    );
    const row = screen.getByTestId("task-card");
    expect(row.getAttribute("draggable")).toBe("true");
    // A drop that BUBBLES from the pill's own subtree still resolves to the row's
    // handler — the pill neither swallows the gesture nor becomes one.
    fireEvent.drop(controlNamed("Approved"));
    expect(drag.onDrop).toHaveBeenCalledTimes(1);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onOpenTask).not.toHaveBeenCalled();
    fireEvent.dragStart(row, { dataTransfer: { setData: vi.fn() } });
    expect(drag.onDragStart).toHaveBeenCalledTimes(1);
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("renders no pill when the card's Stage has no next step", () => {
    // A last Stage (or a `next_slugs: []` that leads nowhere) means the board hands
    // down `undefined`, and the card shows nothing — the same "an absent field renders
    // nothing" rule the spec chip and the sessions chip follow.
    render(<TaskCard task={task()} {...NO_LINKS} launchStep={undefined} />);
    expect(screen.getByTestId("task-card").querySelectorAll("button")).toHaveLength(
      0,
    );
  });
});

describe("TaskCard — the surface ladder (ADR 0097: raise)", () => {
  it("a card raises", () => {
    // The raise half of the pair — the recess half lives in
    // `TasksBoard.test.tsx` ("a column recesses"). A card sits ON a column, so it
    // goes UP a rung (`bg-card`) while the column goes down (`bg-panel`): the two
    // used to share one translucent token, which made a card the same colour as
    // the column it sat in, with the separation carried entirely by the border.
    // Pinning ONE of the two would let a sweep that returns both to that shared
    // token pass half the pair, so both files carry one half.
    //
    // Token strings and not computed colours: jsdom resolves no cascade, so
    // `getComputedStyle` answers `""` here and would certify a broken card.
    render(<TaskCard task={task()} {...NO_LINKS} />);
    const tokens = classTokens(screen.getByTestId("task-card"));
    expect(tokens).toContain("bg-card");
    expect(tokens).not.toContain("bg-surface");
    // The seam is what carries the card in default-light, where the recessed and the
    // raised tokens are both `#ffffff` — and the seam is the SEAM token now, not
    // the generic border (see the matching case in `TasksBoard.test.tsx`). The
    // four quiet palettes keep `--color-card-border` aliasing `--color-border`
    // (10% alpha) exactly so that sentence stays true; only Dracula retunes it.
    expect(tokens).toContain("border-card-border");
    expect(tokens).not.toContain("border-border");
    // And the class survives `cn()`'s merge — the lifted-ink comment below the
    // string in source is a comment, not a second background, so exactly ONE
    // background token is on the node.
    expect(tokens.filter((token) => /^bg-/.test(token))).toEqual(["bg-card"]);
    expect(classOf(screen.getByTestId("task-card"))).toBeTruthy();
  });

  it("the seam is the card-border token, not the generic border", () => {
    // Dracula is the only palette whose `--color-border` is OPAQUE (`#6272a4`,
    // 3.68 against the column fill it rests on) while its elevation ladder steps
    // 1.22 / 1.47 — so a card outline drawn in that token out-shone the two fills
    // it was meant to sit between. The palette already declares a seam token for
    // this job (`--color-card-border`, retuned in `.theme-dracula-dark` alone), so the
    // card consumes THAT and the generic border is GONE rather than merely joined:
    // two border-colour utilities on one node is a tie CSS resolves by stylesheet
    // order, so a half-migrated card would still paint the loud ink on Dracula.
    //
    // Both halves are asserted because the migration is a SWAP: a pin that only
    // checked for the new token would pass on a card carrying both.
    render(<TaskCard task={task()} {...NO_LINKS} />);
    const tokens = classTokens(screen.getByTestId("task-card"));
    expect(tokens).toContain("border-card-border");
    expect(tokens).not.toContain("border-border");
  });
});

describe("TaskCard — the sessions chip (issue #174)", () => {
  /** The chip's whole label, resolved through the ONE money rule. It is spelled
   *  here rather than imported from the component: the string is the contract the
   *  card publishes, and a test that re-derived it from the implementation would
   *  certify whatever the implementation happened to print. */
  it("a card with sessions shows a chip with the count and the cost", () => {
    // The chip is the card's one statement about its Sessions: a COUNT and the
    // summed figure the board read computed in RUST (`TaskCardView.costUsd`), not
    // a per-session list — the card is small and already a drag surface.
    // `2 sessions · $1.75` is `sessions.length` plus `moneyOf(costUsd)`, and the
    // figure arrives pre-summed, so the card adds nothing.
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_old"), link("sess_new")]}
        costUsd={1.75}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={noopOpenSession}
        onOpenTask={noopOpenTask}
      />,
    );
    expect(screen.getByText("2 sessions · $1.75")).toBeTruthy();
    // The chip is the ONE session affordance — no per-session rows, no second
    // count: exactly one element in the card carries the word.
    expect(screen.getAllByText(/session/)).toHaveLength(1);
  });

  it("a card with sessions but no reported cost shows the count and NO dollar figure", () => {
    // ADR 0082 on the card, and the reason `moneyOf` is imported rather than
    // copied: `costUsd: null` means "no linked Session ever had a model call
    // report a cost", and that renders as NOTHING. A raw
    // `(costUsd ?? 0).toFixed(2)` prints `$0.00` here — "this cost nothing" —
    // which is a confident lie about money nobody measured, and it is the exact
    // collapse of "free" and "unknown" that `SessionCostLine` was written to stop.
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_1")]}
        costUsd={null}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={noopOpenSession}
        onOpenTask={noopOpenTask}
      />,
    );
    expect(screen.getByText("1 session")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
    // And no phantom separator either: the money segment is absent, not empty.
    expect(screen.getByText("1 session").textContent).toBe("1 session");
  });

  it("a card with a real zero cost shows $0.00", () => {
    // The other half of ADR 0082, and the half a `costUsd && …` gate destroys:
    // `0` is a REPORTED figure ("a call reported nothing"), so it prints. `null`
    // above and `0` here are different facts and must not render alike — which is
    // why the gate below is on `moneyOf`'s return value and not on the number's
    // truthiness (`0` is falsy, and a truthiness gate would hide a real zero).
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_1")]}
        costUsd={0}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={noopOpenSession}
        onOpenTask={noopOpenTask}
      />,
    );
    expect(screen.getByText("1 session · $0.00")).toBeTruthy();
  });

  it("clicking the chip opens the newest linked session", () => {
    // NEWEST, and newest is LAST: the board's link query is
    // `ORDER BY ts.rowid ASC` — the same oldest-first order `Db::task_sessions`
    // publishes — so the LAST element of `sessions` is the most recent link. That
    // matches the board's other reader, `pick_compact_target`, which prefers the
    // last link too; two readers that disagreed about "newest" would compact one
    // Session and open another.
    const onOpenSession = vi.fn();
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_first"), link("sess_second"), link("sess_last")]}
        costUsd={0.5}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={onOpenSession}
        onOpenTask={noopOpenTask}
      />,
    );
    fireEvent.click(screen.getByText("3 sessions · $0.50"));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("sess_last");
  });

  it("resolves the chip's link from the list and not from an unguarded index", () => {
    // What this case pins, stated once: THE LAST ELEMENT MUST NEVER BE DEREFERENCED
    // OUTSIDE A GUARD THAT HAS ALREADY ESTABLISHED THE LIST IS NON-EMPTY.
    //
    // `sessions[sessions.length - 1]` is `undefined` for an EMPTY list and TypeScript
    // does not say so — `tsconfig.json` sets no `noUncheckedIndexedAccess` (verified)
    // — so an unguarded `newest` is a value that was never resolved and still types as
    // a link. The only thing standing between it and a dereference is then whatever
    // JSX guard happens to sit below it, which is a coincidence and not a contract:
    // move the guard, or reorder the rows, and the common case (the seeded board: five
    // columns of cards with NO links) throws on render.
    //
    // The shape that satisfies this is GUARD-THEN-INDEX: resolve the link up front
    // behind a non-emptiness check that yields `undefined` for an empty list, and gate
    // the chip on that resolved value. Note what this case does NOT forbid — gating on
    // `length` is CORRECT once the index read sits inside that guard (`length > 0`
    // implies the last element exists), so an earlier revision of this pin that banned
    // the substring `sessions.length > 0` over-constrained a sound implementation and
    // is gone. `Array.prototype.at` is likewise no longer required here: it is ES2022
    // and this project's `lib` is `["ES2020", "DOM"]`, and an ES2020 target does not
    // down-level it — see the `EmptyStateFilm.test.tsx` note on the same limit.
    //
    // A source assertion because the DOM cannot see a bug that the guard prevents:
    // the failure this pins is one edit away in the future, and the repo's other
    // instrument for exactly that class is a comment-stripped source read (see the
    // `useDragCard` pin above and `tauriBoundary.test.ts`).
    const src = stripJsComments(readFileSync("src/components/TaskCard.tsx", "utf8"));
    // GUARD-THEN-INDEX, whitespace-tolerant so the assertion is about the SHAPE and
    // not about how the line happens to be wrapped: a non-emptiness check, then the
    // index read, then `undefined` for the empty case.
    expect(src).toMatch(
      /sessions\.length *>\s*0\s*\?\s*sessions\[sessions\.length\s*-\s*1\]\s*:\s*undefined/,
    );
    // And the same fact from the other side: the index read never stands alone as the
    // whole initialiser, i.e. no `const newest = sessions[sessions.length - 1];`.
    expect(src).not.toMatch(
      /const newest = sessions\[sessions\.length\s*-\s*1\]\s*;/,
    );
    // The chip is gated on the RESOLVED LINK, so the value the click reads and the
    // decision to render are ONE value and not two conditions that merely agree.
    expect(src).toMatch(/newest !== undefined/);
    // Vacuity guard, the same one the drag pin runs: the strip must have left real
    // code standing, or every negative assertion above passes on an empty string.
    expect(src).toContain("export default function TaskCard");
  });

  it("a card with no sessions renders no chip", () => {
    // The common case: the seeded board is columns of cards with no links.
    // No chip at all — not an empty pill, not `0 sessions`, not a disabled
    // affordance that opens nothing. `specPath`'s chip above set the precedent:
    // an absent field renders nothing rather than a placeholder for its absence.
    render(<TaskCard task={task()} {...NO_LINKS} />);
    expect(screen.queryByText(/session/)).toBeNull();
    // RE-PINNED, and the reason it had to move: this used to read
    // `querySelector("button")` is `null`, which asserted "the chip is the card's only
    // nested control". Issue #179 adds a SECOND nested control — the primary-next-step
    // pill — so a bare `querySelector` would now convict a correct card. What the case
    // actually owns is unchanged and stronger: with BOTH affordances absent (no links,
    // no `launchStep`) the card carries NO control at all. Counting every control is
    // what keeps that claim honest as the card grows more, and it still fails the
    // moment either affordance paints when it should not.
    expect(
      screen.getByTestId("task-card").querySelectorAll("button"),
    ).toHaveLength(0);
  });

  it("the sessions chip is a real control that opens the newest link when clicked", () => {
    // THE case this branch's own doctrine demands and no existing case made: a
    // card with links, a SPY for the callback, and all three facts asserted
    // together — the chip EXISTS, it is a `button` (so it is reachable from the
    // keyboard, which a `<span onClick>` is not), and ONE click hands the spy
    // exactly the NEWEST id. The two existing chip cases each hold a piece: one
    // clicks and reads the id but never checks the element is a control; the other
    // checks `tagName` and never clicks. Split that way, a chip that rendered a
    // focusable `<button>` wired to nothing, or a `<span>` wired correctly, still
    // left the file green.
    const onOpenSession = vi.fn();
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_alpha"), link("sess_beta")]}
        costUsd={2.5}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={onOpenSession}
        onOpenTask={noopOpenTask}
      />,
    );
    const chip = screen.getByText("2 sessions · $2.50");
    expect(chip.tagName).toBe("BUTTON");
    // Focusable, and that is the property the optional-callback version silently
    // broke: a real `<button>` inside a card is in the tab order whether or not
    // anything answers it.
    expect(chip.getAttribute("type")).toBe("button");
    // The chip resolves to the CARD's role, not to itself — PR #178 made the card
    // a `RowButton`, and this assertion used to demand `null` because the card had no
    // role at all. What has NOT changed is that the chip owns no role of its own: the
    // whole tree holds exactly ONE `[role="button"]`, which is `RowButton`'s
    // load-bearing constraint.
    expect(chip.getAttribute("role")).toBeNull();
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
    fireEvent.click(chip);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("sess_beta");
  });

  it("requires the open-session callback, so a card with links cannot be handed no way to open one", () => {
    // THE silent-green failure this branch spent two commits arguing against —
    // `sessions`/`costUsd` were made REQUIRED on exactly this ground (`types.ts`'s
    // JSDoc: an optional field "compiles against every fixture in the repo and then
    // renders nothing when real data arrives") — and `onOpenSession` was the one
    // prop left optional. `onOpenSession?:` plus a real `<button type="button">` is
    // worse than a missing chip: the card renders a keyboard-focusable control that
    // does NOTHING, and the caller that forgot the prop gets no error. Production
    // (`TasksBoard`) always passes it, which is why no behaviour test could see it.
    //
    // A SOURCE assertion, because the compiler is the instrument here and `tsc` does
    // not run inside vitest: the `?` on the prop declaration is the whole defect, and
    // the repo's own frozen-keys idiom (this file's drag-surface pin,
    // `store/tasks.test.ts`) reads source for exactly this class of claim.
    const src = stripJsComments(readFileSync("src/components/TaskCard.tsx", "utf8"));
    expect(src).not.toContain("onOpenSession?:");
    expect(src).toMatch(/onOpenSession: *\(sessionId: string\) => void;/);
    // And the call site is a PLAIN call, not `onOpenSession?.(…)`: optional chaining
    // at the call is the same silent no-op spelled one line later — a click that
    // resolves to `undefined` and reports nothing.
    expect(src).not.toContain("onOpenSession?.(");
    expect(src).toContain("onOpenSession(newest.sessionId)");
    // Vacuity guard: real code survived the strip.
    expect(src).toContain("export default function TaskCard");
  });

  it("the sessions chip wears the page-step fill, never the island plane", () => {
    // The same pill rule the board enforces for the `T{n}` pill, the spec chip and
    // the column count, now with a THIRD carrier: the fill has to differ from BOTH
    // surfaces it can sit on — the column's `bg-panel` and this card's `bg-card` —
    // in EVERY palette. `bg-chat` is the island plane and is exactly `bg-card` in
    // default-dark (its `color-mix` base is `--color-background-win-alt` `#2b2b2b`,
    // which IS `--color-card` there), so a chip wearing it over a card composites
    // to the card: 1.00, invisible. The per-palette census is
    // `src/lib/slabFloatSeparation.test.ts`, whose pill count this chip moves from
    // 2 to 3 for this file.
    //
    // It is a real `<button type="button">` and not a `<span>` with a click
    // handler: it activates from the keyboard and it says what it is to a screen
    // reader. It does NOT carry a `role` of its own: a `<button>` needs no role
    // spelled, and the card wears the row's ONE role (see the case above), so a role
    // here would be a second `[role="button"]` match in the tree the sidebar
    // resolves rows through.
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_1")]}
        costUsd={0.25}
        // REQUIRED prop (issue #180); this case is about the Sessions chip.
        artifactKeys={[]}
        onOpenSession={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );
    const chip = screen.getByText("1 session · $0.25");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("type")).toBe("button");
    const tokens = classTokens(chip);
    expect(tokens).toContain("rounded-full");
    expect(tokens).toContain("bg-background");
    expect(tokens).not.toContain("bg-chat");
    // No role ON THE CHIP (the card's role is the row's one role — see the case
    // above). This used to be `closest(…).toBeNull()`, which PR #178 inverted.
    expect(chip.getAttribute("role")).toBeNull();
  });
});
