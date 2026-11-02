import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import CodemodeCard from "./CodemodeCard";
import type { ToolCallUiStatus } from "../store/sessions";

/**
 * The `CodemodeCard`: one expandable card for a `codemode` tool call whose body
 * lists the script's NESTED calls.
 *
 * THE CONTRACT UNDER TEST (`docs/roadmap/codemode-status.md`, "Frozen cross-task
 * contracts" item 1, as AMENDED twice):
 * - Both the live `tool_execution_update` frame and the final
 *   `tool_execution_end` result serialize the PARENT's `ToolResult` —
 *   `{ content, details: { calls }, isError }` — so the nested calls are read
 *   from ONE place: `rawOutput.details.calls`. There is no `rawOutput.calls`
 *   key and no dual-key fallback; a `{calls}`-shaped `rawOutput` is not a shape
 *   any producer writes and must render zero rows.
 * - Each element carries `toolCallId = "<parentCallId>/<n>"`, and rows are
 *   reconciled by that id LAST-WRITER-WINS — a repeat collapses to one row
 *   showing the last element (tests 3 and 8).
 * - The card is PROPS-DRIVEN: no store, so no `resetStores()` and no
 *   `vi.mock("../lib/tauri")` here — the card imports no store and no tauri
 *   barrel, and these tests prove that by needing neither.
 *
 * The live `tool_execution_update` EMISSION is B1-gated (nothing emits it in
 * this tree yet), so the live path is exercised the way the card actually sees
 * it: as a `tool_call_update`-folded `rawOutput` prop, replaced by a later one.
 */

type NestedCall = {
  toolCallId: string;
  toolName: string;
  args: object;
  status: "running" | "ok" | "error" | "denied";
  text: string;
  isError: boolean;
  details: object;
};

// `over` defaults to `{}` so a plain `nested()` compiles — `strict` demands an
// argument for a required parameter, and the plan's own fixtures call it bare.
const nested = (over: Partial<NestedCall> = {}): NestedCall => ({
  toolCallId: "call_ab12/c0",
  toolName: "read",
  args: { path: "src/a.ts", offset: 1, limit: 10 },
  status: "ok",
  text: "line one\nline two",
  isError: false,
  details: {},
  ...over,
});

/** The FINAL frame: the parent tool result's `details` (C2 serializes its
 *  `ToolResult` as `{ content, details: { calls }, isError }` and the
 *  normalizer emits that verbatim as the parent row's `rawOutput`). */
const parentResult = (calls: NestedCall[]) => ({ details: { calls } });

/** A LIVE frame IS the parent's serialized `ToolResult` — the same type and the
 *  same shape as the final frame's (`tools/types.rs:42`), NOT a bespoke
 *  `{calls}` envelope. Test 3 replaces this SAME `details.calls` key. */
const liveResult = (calls: NestedCall[]) => ({
  content: [] as unknown[],
  details: { calls },
  isError: false,
});

const renderCard = (props: {
  title?: string;
  status?: ToolCallUiStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  isStreaming?: boolean;
}) =>
  render(
    <CodemodeCard
      title={props.title ?? "codemode"}
      status={props.status ?? "completed"}
      rawInput={props.rawInput}
      rawOutput={props.rawOutput}
      isStreaming={props.isStreaming}
    />,
  );

/** The rendered class list of a row's status glyph (SVG `className` is an
 *  `SVGAnimatedString` under jsdom, so the ATTRIBUTE is what is readable — the
 *  same reading `transcriptRow.test.tsx` uses for the chevron). */
const glyphClass = (row: HTMLElement): string =>
  row.querySelector("svg")?.getAttribute("class") ?? "";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CodemodeCard — nested calls from rawOutput.details.calls", () => {
  it("renders the parent header with nested rows from details.calls", () => {
    renderCard({
      status: "completed",
      rawOutput: parentResult([
        nested(),
        nested({
          toolCallId: "call_ab12/c1",
          toolName: "bash",
          args: { command: "ls" },
          text: "a.ts",
        }),
      ]),
    });

    // The header shell is present (open by default — no click needed). The
    // header never sets `aria-expanded` (it is the tooltip trigger), so the
    // proof is the visible title text, following the subagent precedent.
    expect(screen.getByText("codemode")).toBeTruthy();

    const rows = screen.getAllByTestId("codemode-call-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("read")).toBeTruthy();
    expect(within(rows[1]).getByText("bash")).toBeTruthy();
    expect(
      within(rows[0]).getByText(
        JSON.stringify({ path: "src/a.ts", offset: 1, limit: 10 }),
      ),
    ).toBeTruthy();
    expect(within(rows[1]).getByText(JSON.stringify({ command: "ls" }))).toBeTruthy();
  });

  it("opens by default and toggles closed", () => {
    // `text: ""` so the row carries no copy button — the ONE button in the card
    // is then the header toggle.
    renderCard({ rawOutput: parentResult([nested({ text: "" })]) });

    // Open by default: the nested row is in the DOM without any click.
    expect(screen.getAllByTestId("codemode-call-row")).toHaveLength(1);

    // The header row is the card's ONLY button (the failure tooltip renders
    // through a Portal and only when the parent failed, so it is absent here).
    fireEvent.click(screen.getByRole("button"));
    // The collapse is proven by the row LEAVING the DOM — not by an
    // `aria-expanded` attribute the header never sets.
    expect(screen.queryByTestId("codemode-call-row")).toBeNull();
  });

  it("updates a row in place when a live frame for a known toolCallId arrives (no duplicate)", () => {
    const c1Running = nested({
      toolCallId: "call_ab12/c1",
      status: "running",
      text: "partial output",
    });
    const { rerender } = render(
      <CodemodeCard
        title="codemode"
        status="pending"
        rawOutput={liveResult([
          nested({ toolCallId: "call_ab12/c0", status: "running", text: "working" }),
          c1Running,
        ])}
        isStreaming
      />,
    );
    expect(screen.getAllByTestId("codemode-call-row")).toHaveLength(2);
    expect(screen.getByText("working")).toBeTruthy();

    // The final `tool_execution_end` result replaces the live snapshot wholesale
    // (reducer `tool_call_update`: `rawOutput: update.rawOutput ?? prev.rawOutput`)
    // — SAME key, SAME shape, only `c0` changed.
    rerender(
      <CodemodeCard
        title="codemode"
        status="completed"
        rawOutput={parentResult([
          nested({ toolCallId: "call_ab12/c0", status: "ok", text: "finished line" }),
          c1Running,
        ])}
      />,
    );

    // Still TWO rows: the update replaced c0 in place instead of appending.
    const rows = screen.getAllByTestId("codemode-call-row");
    expect(rows).toHaveLength(2);
    // c0 shows the new text and the live text is gone.
    expect(within(rows[0]).getByText("finished line")).toBeTruthy();
    expect(within(rows[0]).queryByText("working")).toBeNull();
    // The c1 row is UNTOUCHED — the assertion that separates update-in-place
    // from append-and-restart.
    expect(within(rows[1]).getByText("partial output")).toBeTruthy();
  });

  it("maps statuses to the row glyphs", () => {
    renderCard({
      status: "completed",
      rawOutput: parentResult([
        nested({ toolCallId: "call_ab12/c0", status: "running", text: "" }),
        nested({ toolCallId: "call_ab12/c1", status: "ok", text: "" }),
        nested({ toolCallId: "call_ab12/c2", status: "error", text: "" }),
        nested({ toolCallId: "call_ab12/c3", status: "denied", text: "" }),
      ]),
    });

    const rows = screen.getAllByTestId("codemode-call-row");
    expect(rows).toHaveLength(4);
    // The glyph classes are the REAL `SubagentStatusIcon` classes — the caller
    // passes no classes of its own.
    expect(glyphClass(rows[0])).toContain("animate-spin text-warning");
    expect(glyphClass(rows[1])).toContain("text-success");
    expect(glyphClass(rows[2])).toContain("text-destructive");
    expect(glyphClass(rows[3])).toContain("text-destructive");
  });

  it("renders the empty state when there are no nested calls", () => {
    const { unmount } = renderCard({
      rawInput: { code: "await tools.read({ path: 'a.ts' })" },
      rawOutput: { details: {} },
      status: "pending",
    });
    expect(screen.getByText("No nested calls yet.")).toBeTruthy();
    expect(screen.queryByTestId("codemode-call-row")).toBeNull();
    unmount();

    // An ABSENT result reads defensively to the same empty state.
    renderCard({ status: "completed" });
    expect(screen.getByText("No nested calls yet.")).toBeTruthy();
  });

  it("renders a malformed calls array as zero rows rather than throwing", () => {
    // Defensive reads stay for MALFORMED data (absent / foreign shapes). Each of
    // these is a shape no producer writes; none may throw and all render the
    // empty state.
    const malformed: { shape: unknown; rows: number }[] = [
      { shape: undefined, rows: 0 },
      { shape: "a bare string", rows: 0 },
      { shape: {}, rows: 0 },
      { shape: { details: null }, rows: 0 },
      { shape: { details: "not an object" }, rows: 0 },
      { shape: { details: { calls: "not an array" } }, rows: 0 },
      // The OLD (pre-amendment) contract's bare `{calls}` envelope: not a key the
      // card reads, so it renders NOTHING — the single-source rule, asserted.
      { shape: { calls: [nested({})] }, rows: 0 },
      // An element without a `toolCallId` (the row key) is dropped.
      {
        shape: { details: { calls: [{ toolName: "read", status: "ok", text: "x" }] } },
        rows: 0,
      },
      // Junk elements are dropped and the ONE valid element among them still
      // renders its own row — the filter's shape, not just its silence.
      { shape: { details: { calls: [null, 7, nested({})] } }, rows: 1 },
    ];
    for (const { shape, rows } of malformed) {
      const { unmount } = renderCard({ rawOutput: shape, status: "completed" });
      expect(screen.queryAllByTestId("codemode-call-row")).toHaveLength(rows);
      if (rows === 0) expect(screen.getByText("No nested calls yet.")).toBeTruthy();
      unmount();
    }
  });

  it("renders the script block with the REAL shiki highlighter (devDependency survives)", async () => {
    const code = "const x = 1;\nexport default x;";
    const { container, unmount } = renderCard({
      rawInput: { code },
      rawOutput: parentResult([]),
      status: "completed",
    });

    // The header is there on the FIRST paint (the block never changes shape) and
    // so is the fallback `<pre>` — neither is the signal that the highlight
    // landed. `pre.shiki` is, and it arrives asynchronously out of a `useEffect`
    // (the `MessageBubble.codeblock.test.tsx` convention: every such query is
    // async).
    const header = screen.getByTestId("codemode-script-header");
    expect(screen.getByTestId("codemode-script-lang").textContent).toBe("javascript");
    expect(header.querySelector("svg")).not.toBeNull();

    const pre = await waitFor(() => {
      const found = container.querySelector("pre.shiki");
      expect(found).not.toBeNull();
      return found!;
    });
    // Genuinely highlighted, not the fallback: `pre.shiki` carrying the theme's
    // own inline paper colour and token spans. The fallback `<pre><code>` has
    // neither the class nor the inline style nor the spans.
    expect(pre.getAttribute("style") ?? "").toContain("background-color");
    expect(pre.querySelector("span")).not.toBeNull();
    unmount();

    // No `rawInput.code` → no script block at all (the rows alone fill the body).
    const empty = renderCard({ rawOutput: parentResult([nested({})]) });
    expect(empty.queryByTestId("codemode-script-header")).toBeNull();
    empty.unmount();
  });

  it("copies the script source and confirms visibly", async () => {
    const code = "const x = 1;\nconst y = 2;";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderCard({ rawInput: { code }, rawOutput: parentResult([]) });
    fireEvent.click(await screen.findByRole("button", { name: "Copy code" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(code);
  });

  it("renders errors with destructive ink and keeps the output", () => {
    renderCard({
      status: "completed",
      rawOutput: parentResult([
        nested({ status: "error", isError: true, text: "boom" }),
      ]),
    });

    const row = screen.getByTestId("codemode-call-row");
    expect(within(row).getByText("boom")).toBeTruthy();
    // The exact token the component spells (a muted destructive variant) —
    // spelled verbatim in both files so the assertion cannot drift.
    const output = within(row).getByText("boom");
    expect(output.className).toContain("text-destructive/70");
    // The args line keeps the normal muted ink.
    expect(
      within(row).getByText(JSON.stringify({ path: "src/a.ts", offset: 1, limit: 10 }))
        .className,
    ).toContain("text-foreground-subtle");
  });

  it("copies a nested row's output and confirms visibly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderCard({
      rawOutput: parentResult([
        nested({ toolName: "bash", text: "a.ts\nb.ts" }),
        nested({ toolCallId: "call_ab12/c1", toolName: "ls", text: "" }),
      ]),
    });

    const rows = screen.getAllByTestId("codemode-call-row");
    // A row with output offers the copy affordance; a row without does not.
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Copy bash output" }));
    expect(
      await within(rows[0]).findByRole("button", { name: "Copied" }),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("a.ts\nb.ts");
    expect(within(rows[1]).queryByRole("button")).toBeNull();
  });

  it("never duplicates a toolCallId even when the final array repeats it", () => {
    renderCard({
      status: "completed",
      rawOutput: parentResult([
        nested({ text: "first copy" }),
        nested({ text: "second copy" }),
      ]),
    });

    // LAST-WRITER-WINS (the Map reconcile): ONE row, showing the last element.
    const rows = screen.getAllByTestId("codemode-call-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("second copy")).toBeTruthy();
    expect(within(rows[0]).queryByText("first copy")).toBeNull();
  });

  it("keeps an unknown-status row running while the parent streams", () => {
    const withoutStatus = {
      toolCallId: "call_ab12/c0",
      toolName: "read",
      args: {},
      text: "",
      isError: false,
      details: {},
    };
    renderCard({
      status: "pending",
      isStreaming: true,
      rawOutput: { details: { calls: [withoutStatus] } },
    });

    const row = screen.getByTestId("codemode-call-row");
    expect(glyphClass(row)).toContain("animate-spin text-warning");
  });
});
