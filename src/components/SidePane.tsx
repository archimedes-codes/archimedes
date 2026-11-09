import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { basenameOfPath } from "../lib/paths";
import { sessionFieldOf } from "../lib/sessionLookup";
import { useSessions } from "../store/sessions";
import ChecklistPanel from "./ChecklistPanel";
import { cn } from "./lib/utils";
import SessionConfigBlock from "./SessionConfigBlock";
import { SessionCostLine } from "./SessionCostLine";

const WIDTH_KEY = "side-pane-width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 320;

function clampWidth(w: number): number {
  return Math.min(Math.max(w, MIN_WIDTH), MAX_WIDTH);
}

function initialWidth(): number {
  const stored = localStorage.getItem(WIDTH_KEY);
  if (stored === null) return DEFAULT_WIDTH;
  const n = Number(stored);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return clampWidth(n);
}

/**
 * The right-hand side pane: a 320px-default resizable frame hosting a STATUS
 * PANEL (the ZCode `ConversationStatusPanel` treatment — NOT a tabbed
 * sidebar): a single data-gated section in one content area, rendering only
 * while it has something to show:
 *
 * - **Todo boards** (`ChecklistPanel`): the `Todos` label + `N/M` +
 *   progress header, the parent's checklist, and one labelled block per
 *   running **Subagent session** that has a board — hidden while NO board has
 *   an open item (no todos at all, or every list fully completed; the
 *   `useBoardOpenCount` derivation INSIDE `ChecklistPanel`, which counts the
 *   parent's list PLUS every running child's).
 *
 * - **Sections come and go with their data; the frame itself never does.** The
 *   pane is PERMANENT: it is always mounted at its own width and nothing in
 *   this component hides it. A board FINISHING leaves the frame standing with
 *   the data-gated Todos section gone and the session title still there —
 *   yanking the surface that just showed the work out from under the user is
 *   the behavior that was reported back when the frame could collapse, and
 *   now that every running child's board counts, a 1 → 0 dip that means "one
 *   child finished while its siblings work" is routine.
 *   What the data gates is CONTENT, never the frame: a child session earns a
 *   board block through its own board and nothing else (a child with no board
 *   earns nothing; the subagents live under the "Delegating" card + the child's
 *   transcript SHEET (`SubagentDetailHost`); their gates never render in this
 *   pane either — they are inline in the parent's transcript or hosted by
 *   `SubagentModals`, neither of which the pane mounts).
 * - **Resize:** a 4px drag handle on the frame's left edge (a `w-1`
 *   `cursor-col-resize` div, transparent hit area — a 2px
 *   `bg-foreground-subtlest/50` line shows on hover/while dragging). The
 *   width is clamped 240–480px; the live state updates on every
 *   `mousemove`, but the width is flushed to `localStorage`
 *   (`"side-pane-width"`) on `mouseup` only (NOT on every `mousemove` —
 *   ~60/s sync writes). The handle captures the pointer on `pointerdown`
 *   (released on `pointerup`/`pointercancel`) so a release outside the
 *   webview still ends the drag; a `blur` listener is the fallback.
 */
export default function SidePane() {
  const [width, setWidthState] = useState(initialWidth);

  // Live width state (the drag updates it on every `mousemove`); `widthRef`
  // mirrors it so the `mouseup` flush reads the latest value (the drag
  // effect's closure would be stale).
  const widthRef = useRef(width);
  const setWidth = useCallback((w: number) => {
    const clamped = clampWidth(w);
    widthRef.current = clamped;
    setWidthState(clamped);
  }, []);

  // The drag (track `mousemove` on `window` while dragging; the handle
  // captures the pointer so a release outside the webview still delivers
  // the `pointerup` — a `blur` listener is the fallback).
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStart.current = { x: e.clientX, width };
    setDragging(true);
    // Capture the pointer: the `pointerup` is delivered to the handle even
    // if the mouse is released outside the webview (it does NOT get lost).
    // (`pointerdown` is the only DOM event carrying `pointerId` — a
    // `mousedown` handler could not capture.)
    handleRef.current?.setPointerCapture(e.pointerId);
  };

  useEffect(() => {
    if (!dragging) return;
    // End the drag: clear `dragging` and flush the width to localStorage
    // ONCE (NOT on every `mousemove` — ~60/s sync writes). A
    // quota/lockdown throw is best-effort (the live width stays in state).
    const endDrag = () => {
      if (!dragStart.current) return;
      dragStart.current = null;
      setDragging(false);
      try {
        localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      } catch {
        // persistence is best-effort; the width lives on in state
      }
    };
    const onMove = (e: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      // The handle is on the frame's LEFT edge: dragging LEFT widens.
      setWidth(start.width - (e.clientX - start.x));
    };
    const onPointerEnd = (e: PointerEvent) => {
      // `endDrag` FIRST: if `releasePointerCapture` throws (an expired
      // `pointerId` / a non-compliant webview) the drag must still end —
      // otherwise `dragging` sticks and the width never flushes. (It is
      // idempotent via the `dragStart` guard: a later `mouseup` is a no-op.)
      endDrag();
      try {
        handleRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // capture already expired — the drag is ended above
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    // The pointer is lost (released outside the webview): `blur` clears
    // `dragging` (it does NOT stick).
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", endDrag);
    };
  }, [dragging, setWidth]);

    // The active session, which every section below keys off. The pane holds no
  // board derivation of its own any more: the Todos section's gate lives inside
  // `ChecklistPanel` (its `useBoardOpenCount`), so the pane cannot open a
  // section that renders nothing nor hide one that has something to show —
  // there is no frame-level gate left to disagree with the section's.
  const activeSessionId = useSessions((s) => s.activeSessionId);

  // The session title (the top section — the old chat header's title moved
  // here, the header is gone): the session's GENERATED title when the naming
  // pass wrote one (`SessionInfo.title`, auto-generated only), else the first
  // `user` message truncated to ~80 chars (the SAME derivation the header +
  // the sidebar rows use), else the Space's base name (the active session's
  // `cwd` — live, stored, OR archived membership; `basenameOfPath` of it — a
  // session whose cwd is no known Space still shows its folder's base name).
  const activeMessages = useSessions((s) =>
    s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
  );
  // The active session's `cwd` and its generated `title`, each read by its OWN
  // selector over the ONE three-list walk (`lib/sessionLookup.ts`). They are
  // deliberately TWO selectors and not one returning `{ cwd, title }`: zustand
  // v5 re-runs a selector that yields a FRESH OBJECT on every snapshot read, so
  // the pane would re-render forever (`useShallow` would fix it; two primitive
  // selectors are cheaper and match the shape of this file).
  const activeCwd = useSessions((s) =>
    sessionFieldOf(s, s.activeSessionId, "cwd"),
  );
  // `?? null` is KEPT, not delegated: `sessionFieldOf`'s empty case is
  // `undefined` and this selector's contract was `string | null` — the header's
  // `sessionTitle` chain below tests `storedTitle !== null` to tell "no title"
  // apart from nothing else. Collapsing the two would change what the guard
  // means, so the null stays owned here (the same reason
  // `sessionConfigOptionsOf` keeps its own `?? null` tail).
  const storedTitle = useSessions(
    (s) => sessionFieldOf(s, s.activeSessionId, "title") ?? null,
  );
  // (`find` does not narrow its result — the `kind` check on the found
  // value, THEN the `text` access, is the ChatStream pattern.)
  const firstUserMessage = activeMessages?.find((m) => m.kind === "user");
  const firstUserText =
    firstUserMessage && firstUserMessage.text !== ""
      ? firstUserMessage.text
      : undefined;
  // The title SHORT-CIRCUITS the chain: a session the naming pass titled is
  // labelled by that title, never by a prompt truncation. (`""` is treated as
  // no title — the backend never writes one, but an empty label would render
  // an invisible header.)
  const sessionTitle =
    storedTitle !== null && storedTitle !== ""
      ? storedTitle
      : firstUserText
        ? firstUserText.length > 80
          ? firstUserText.slice(0, 80)
          : firstUserText
        : activeCwd
          ? basenameOfPath(activeCwd)
          : null;

  return (
    // The frame is PERMANENT: its width is the dragged value and nothing else.
    // It used to drop to a 40px sliver while collapsed, which is why the
    // content below once carried `invisible` (clipping alone let the board paint
    // into the sliver, one character per line). Nothing clips it now, so the
    // content simply renders.
    <div
      style={{ width }}
      className="relative m-1 flex shrink-0 flex-col overflow-hidden rounded-xl bg-inspector"
    >
      {/* The 4px drag handle (left edge): transparent hit area, a 2px
          `bg-foreground-subtlest/50` line on hover / while dragging. It renders
          unconditionally — the frame is always at the dragged width, so there
          is always something to resize. */}
      <div
        ref={handleRef}
        className="absolute inset-y-0 left-0 w-1 cursor-col-resize"
        onPointerDown={onPointerDown}
      >
        <div
          // `opacity-100` / `opacity-0` are one tailwind-merge group and the two
          // arms are mutually exclusive, so the merge is the identity here
          // (`SidePane.test.tsx` anchors on the END of the attribute —
          // `/ opacity-100$/` — and `cn` emits no trailing space, so that pin
          // holds either way).
          className={cn(
            "h-full w-0.5 bg-foreground-subtlest/50",
            dragging ? "opacity-100" : "opacity-0 hover:opacity-100",
          )}
        />
      </div>
      {/* The STATUS PANEL (the ZCode `ConversationStatusPanel`
          treatment): the data-gated sections stacked in one content
          area (no tabs). The local UI state — section open/closed, scroll —
          lives in this subtree and survives every re-render of the pane. */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-4">
          {/* The session title (the old header's title — the header is
              gone, the title lives here): the generated title when there is
              one, else the first `user` message truncated to ~80 chars, else
              the Space's base name. The same gradient-fade mask the header
              used (background-agnostic). */}
          {sessionTitle !== null && (
            <div
              className="min-w-0 text-ui-base font-medium text-foreground"
              style={{
                maskImage:
                  "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
                WebkitMaskImage:
                  "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
              }}
            >
              {sessionTitle}
            </div>
          )}
          {/* The session's cumulative USD figure (#87), directly under the title
              and above the todo board. It renders NOTHING — no element, so no
              `gap-4` slot either — unless some call this session made reported a
              cost, which is the ordinary case (absence is per-CALL). The line
              itself owns the money rules; nothing is decided here. */}
          <SessionCostLine sessionId={activeSessionId} />
          {/* The todo boards (data-gated by `ChecklistPanel` — it renders
              `null` while NO board (the parent's list or a child's) has an open
              item; the gate is the panel's own `useBoardOpenCount`). */}
          <ChecklistPanel sessionId={activeSessionId} />
        </div>
      </div>
      {/* The session's config lines (Model / Reasoning / Context) — the lines
          that left the composer's bottom row. Mounted AFTER the scroll area:
          inside the scroller the block would scroll away with a growing todo
          board, and before the scroller it would sit above the title. The Model
          line and the context bar are NEVER data-gated (unlike the todo
          section); the Reasoning line renders only when the session's options
          carry a `thought_level` select. So with no active session the block is
          the Model stub and an empty 0% track. */}
      <SessionConfigBlock />
    </div>
  );
}
