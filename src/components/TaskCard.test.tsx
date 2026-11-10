import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TaskCard, { type TaskCardProps } from "./TaskCard";
import type { DragCardHandlers } from "../hooks/useDragCard";
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

/** The three props every render must pass, spelled out at every call site that has
 *  nothing to say about Sessions. They are REQUIRED props rather than optional ones
 *  for the same reason `TaskCardView`'s fields are required in `types.ts`: an
 *  optional prop compiles against a caller that forgot it, and a card that forgot
 *  them renders a linked card with no chip — or a chip that opens nothing. A case
 *  that cares about links overrides them; the anatomy cases below do not. */
const NO_LINKS: Pick<TaskCardProps, "sessions" | "costUsd" | "onOpenSession"> = {
  sessions: [],
  costUsd: null,
  onOpenSession: noopOpenSession,
};

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
    // that: its zai-dark `color-mix` base (`--color-background-win-alt`, `#2b2b2b`)
    // IS `--color-card`, so a chip wearing it over a card composites to the card —
    // contrast 1.00, invisible. The 1.22 / 1.21 figures that justified it were
    // Dracula-only (ADR 0096's single-palette-check error). `bg-background`
    // measures 1.10/1.34 Dracula, 1.11/1.28 zai-dark, 1.06/1.06 zai-light; the
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

describe("TaskCard — what it is NOT", () => {
  it("is not a RowButton: no role=button, no tabindex", () => {
    // `RowButton`'s header states the constraint: exactly ONE `role="button"` per
    // row is load-bearing, because `SpacesList.test.tsx` resolves rows through
    // `.closest('[role="button"]')` at eight sites. A card that adopted it would be
    // a sixth hand-rolled affordance and would not even be a control — a card is
    // dragged, not clicked, in v1.
    render(
      <TaskCard task={task()} {...NO_LINKS} drag={dragSurface()} />,
    );
    const el = screen.getByTestId("task-card");
    expect(el.getAttribute("role")).toBeNull();
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.tagName).toBe("DIV");
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
    // The seam is what carries the card in zai-light, where the recessed and the
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
    // this job (`--color-card-border`, retuned in `.theme-dracula` alone), so the
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
        onOpenSession={noopOpenSession}
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
        onOpenSession={noopOpenSession}
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
        onOpenSession={noopOpenSession}
      />,
    );
    expect(screen.getByText("1 session · $0.00")).toBeTruthy();
  });

  it("clicking the chip opens the newest linked session", () => {
    // NEWEST, and newest is LAST: the board's link query is
    // `ORDER BY ts.rowid ASC` — the same oldest-first order `Db::task_sessions`
    // publishes — so `sessions.at(-1)` is the most recent link. That
    // matches the board's other reader, `pick_compact_target`, which prefers the
    // last link too; two readers that disagreed about "newest" would compact one
    // Session and open another.
    const onOpenSession = vi.fn();
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_first"), link("sess_second"), link("sess_last")]}
        costUsd={0.5}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByText("3 sessions · $0.50"));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("sess_last");
  });

  it("resolves the chip's link from the list and not from an unguarded index", () => {
    // `sessions[sessions.length - 1]` is `undefined` for an EMPTY list — TypeScript
    // does not catch it here because `tsconfig.json` sets no
    // `noUncheckedIndexedAccess` (verified), so the only thing standing between that
    // `undefined` and a dereference was the JSX guard two lines below it. Move the
    // guard, or reorder the rows, and the common case (the seeded board: five
    // columns of cards with NO links) throws on render.
    //
    // `sessions.at(-1)` returns `undefined` HONESTLY, so the render gate can be put
    // on the resolved link instead of on `length` — and then the value the click
    // reads and the decision to render are the SAME value, which is the difference
    // between "two conditions that happen to agree" and "one condition".
    //
    // A source assertion because the DOM cannot see a bug that the guard prevents:
    // the failure this pins is one edit away in the future, and the repo's other
    // instrument for exactly that class is a comment-stripped source read (see the
    // `useDragCard` pin above and `tauriBoundary.test.ts`).
    const src = stripJsComments(readFileSync("src/components/TaskCard.tsx", "utf8"));
    expect(src).toContain("sessions.at(-1)");
    expect(src).not.toContain("sessions[sessions.length - 1]");
    // The gate names the RESOLVED LINK. `sessions.length > 0` as the gate over an
    // index-read `newest` is the two-conditions shape this case exists to forbid.
    expect(src).not.toContain("sessions.length > 0");
    // Vacuity guard, the same one the drag pin runs: the strip must have left real
    // code standing, or every `not.toContain` above passes on an empty string.
    expect(src).toContain("export default function TaskCard");
  });

  it("a card with no sessions renders no chip", () => {
    // The common case: the seeded board is five columns of cards with no links.
    // No chip at all — not an empty pill, not `0 sessions`, not a disabled
    // affordance that opens nothing. `specPath`'s chip above set the precedent:
    // an absent field renders nothing rather than a placeholder for its absence.
    render(<TaskCard task={task()} {...NO_LINKS} />);
    expect(screen.queryByText(/session/)).toBeNull();
    // And no stray control inside the card — the card is DRAGGED and not clicked,
    // so a second affordance that appears on every card is the one thing this
    // component's whole "not a RowButton" argument says it will not add.
    expect(
      screen.getByTestId("task-card").querySelector("button"),
    ).toBeNull();
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
        onOpenSession={onOpenSession}
      />,
    );
    const chip = screen.getByText("2 sessions · $2.50");
    expect(chip.tagName).toBe("BUTTON");
    // Focusable, and that is the property the optional-callback version silently
    // broke: a real `<button>` inside a card is in the tab order whether or not
    // anything answers it.
    expect(chip.getAttribute("type")).toBe("button");
    expect(chip.closest('[role="button"]')).toBeNull();
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
    // zai-dark (its `color-mix` base is `--color-background-win-alt` `#2b2b2b`,
    // which IS `--color-card` there), so a chip wearing it over a card composites
    // to the card: 1.00, invisible. The per-palette census is
    // `src/lib/slabFloatSeparation.test.ts`, whose pill count this chip moves from
    // 2 to 3 for this file.
    //
    // It is a real `<button type="button">` and not a `<span>` with a click
    // handler: it activates from the keyboard and it says what it is to a screen
    // reader. It does NOT carry a `role` — the card's own `role` must stay absent
    // (pinned above), and a `<button>` needs no role spelled.
    render(
      <TaskCard
        task={task()}
        sessions={[link("sess_1")]}
        costUsd={0.25}
        onOpenSession={vi.fn()}
      />,
    );
    const chip = screen.getByText("1 session · $0.25");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("type")).toBe("button");
    const tokens = classTokens(chip);
    expect(tokens).toContain("rounded-full");
    expect(tokens).toContain("bg-background");
    expect(tokens).not.toContain("bg-chat");
    expect(chip.closest('[role="button"]')).toBeNull();
  });
});
