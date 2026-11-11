import { useImperativeHandle } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act, screen, fireEvent } from "@testing-library/react";
import MessageList, { type MessageListProps } from "./MessageList";
import {
  getAttentionFocusRequest,
  setAttentionFocusRequest,
} from "../../lib/attentionFocusSignal";
import type { RenderUnit } from "../../lib/toolGroups";
import type { Message } from "../../store/sessions";
import type { PermissionPromptData } from "../../store/permissions";

const virtuosoHandleRef = {
  scrollToIndex: vi.fn(),
  autoscrollToBottom: vi.fn(),
};

let capturedVirtuosoProps: any = null;

vi.mock("react-virtuoso", () => {
  const VirtuosoStandIn = (props: any) => {
    capturedVirtuosoProps = props;
    useImperativeHandle(props.ref, () => virtuosoHandleRef, []);
    const { Header, Footer } = props.components ?? {};
    return (
      <div
        ref={(el) => {
          if (typeof props.scrollerRef === "function") {
            props.scrollerRef(el);
          }
        }}
        tabIndex={props.tabIndex ?? -1}
        data-testid="virtuoso-stand-in"
        className={props.className}
        onScroll={props.onScroll}
      >
        {Header && <Header context={props.context} />}
        {props.data?.map((item: any, i: number) => {
          const itemIndex = (props.firstItemIndex ?? 0) + i;
          const key = props.computeItemKey
            ? props.computeItemKey(itemIndex, item, props.context)
            : i;
          return (
            <div key={key}>
              {props.itemContent
                ? props.itemContent(itemIndex, item, props.context)
                : null}
            </div>
          );
        })}
        {Footer && <Footer context={props.context} />}
      </div>
    );
  };

  return {
    Virtuoso: VirtuosoStandIn,
  };
});

function simulateScrollUp(container: HTMLElement) {
  const scroller =
    container.querySelector('[data-testid="virtuoso-stand-in"]') ??
    container.querySelector('[data-testid="transcript-scroll"]') ??
    container.firstElementChild!;
  const target = scroller.firstElementChild ?? scroller;
  fireEvent.wheel(target, { deltaY: -50 });
}

let rafIdCounter = 1;
const pendingRafCallbacks = new Map<number, FrameRequestCallback>();

function stubRaf() {
  pendingRafCallbacks.clear();
  rafIdCounter = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = rafIdCounter++;
    pendingRafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    pendingRafCallbacks.delete(id);
  });
}

function flushRaf() {
  const cbs = Array.from(pendingRafCallbacks.values());
  pendingRafCallbacks.clear();
  cbs.forEach((cb) => cb(performance.now()));
}

const textMsg = (id: string, text = "hello", at = 1): Message => ({
  kind: "agent-text",
  messageId: id,
  text,
  at,
});

const userMsg = (text = "user input", at = 1): Message => ({
  kind: "user",
  text,
  at,
});

const single = (message: Message): RenderUnit => ({ kind: "single", message });

function makeProps(overrides: Partial<MessageListProps> = {}): MessageListProps {
  return {
    units: [single(textMsg("m1"))],
    activeSessionId: "s1",
    inTurn: false,
    askRequests: [],
    prompts: [],
    stackedAskRequests: [],
    childGates: [],
    hasPendingRequest: false,
    workingOrInTurn: false,
    agentState: "idle",
    turnDiffs: [],
    stopReason: undefined,
    hasMore: false,
    loadingMore: false,
    generation: 0,
    onStartReached: vi.fn(),
    ...overrides,
  };
}

// The Attention-alert focus signal is MODULE-SCOPED (no store, no React — see
// the warning in `lib/attentionFocusSignal.ts`), and the cases below raise it
// directly. A pending request left by one case is consumed by EVERY later
// `render()` in this file, which shows up as one extra
// `scrollToIndex({ index: "LAST" })` in a case that never passed the prop — the
// kind of red that reads like the feature is broken when the leak is the cause.
// FILE scope, not one `describe`: this file has nested suites.
beforeEach(() => {
  setAttentionFocusRequest(null);
});

describe("MessageList scroll behavior", () => {
  beforeEach(() => {
    stubRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();
    virtuosoHandleRef.autoscrollToBottom.mockClear();
    capturedVirtuosoProps = null;
  });

  it("4a: wires startReached prop to onStartReached", () => {
    const onStartReached = vi.fn();
    render(<MessageList {...makeProps({ onStartReached })} />);

    expect(capturedVirtuosoProps).not.toBeNull();
    expect(typeof capturedVirtuosoProps.startReached).toBe("function");

    capturedVirtuosoProps.startReached();
    expect(onStartReached).toHaveBeenCalledTimes(1);
  });

  it("4b: computeItemKey(index) returns unique, stable keys when firstItemIndex !== 0 and does not return :undefined", () => {
    const u1 = single(textMsg("m1", "one"));
    const u2 = single(textMsg("m2", "two"));
    const u3 = single(textMsg("m3", "three"));

    render(
      <MessageList
        {...makeProps({
          units: [u1, u2, u3],
          activeSessionId: "sess-abc",
        })}
      />,
    );

    const firstIndex = capturedVirtuosoProps.firstItemIndex;
    expect(firstIndex).toBeGreaterThan(0);

    const key0 = capturedVirtuosoProps.computeItemKey(firstIndex);
    const key1 = capturedVirtuosoProps.computeItemKey(firstIndex + 1);
    const key2 = capturedVirtuosoProps.computeItemKey(firstIndex + 2);

    expect(key0).toBe("sess-abc:text:m1");
    expect(key1).toBe("sess-abc:text:m2");
    expect(key2).toBe("sess-abc:text:m3");

    expect(key0).not.toContain("undefined");
    expect(key1).not.toContain("undefined");
    expect(key2).not.toContain("undefined");

    const uniqueKeys = new Set([key0, key1, key2]);
    expect(uniqueKeys.size).toBe(3);

    // itemContent returns null when unit is undefined
    expect(capturedVirtuosoProps.itemContent(firstIndex, undefined)).toBeNull();
  });

  it("4c (REGRESSION): re-render with same gate counts but MORE units (prepend and append) does NOT call scrollToIndex", () => {
    const u2 = single(textMsg("m2", "two"));
    const u3 = single(textMsg("m3", "three"));

    const { container, rerender } = render(
      <MessageList {...makeProps({ units: [u2, u3] })} />,
    );

    // Drain initial mount rAF / calls
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    // 1. Prepend older units with the same gate counts
    const u0 = single(textMsg("m0", "zero"));
    const u1 = single(textMsg("m1", "one"));
    rerender(
      <MessageList {...makeProps({ units: [u0, u1, u2, u3] })} />,
    );

    flushRaf();
    expect(
      virtuosoHandleRef.scrollToIndex,
      "scrollToIndex must NOT be called on prepend when gate counts are unchanged",
    ).not.toHaveBeenCalled();

    // 2. Live append of non-user message when user is NOT at bottom
    act(() => {
      simulateScrollUp(container);
    });
    virtuosoHandleRef.scrollToIndex.mockClear();

    const u4 = single(textMsg("m4", "four"));
    rerender(
      <MessageList {...makeProps({ units: [u0, u1, u2, u3, u4] })} />,
    );

    flushRaf();
    expect(
      virtuosoHandleRef.scrollToIndex,
      "scrollToIndex must NOT be called on append when not at bottom and gate counts are unchanged",
    ).not.toHaveBeenCalled();
  });

  it("4d: gate-count change calls scrollToIndex({ index: 'LAST', align: 'end' }) one frame later (not synchronously)", () => {
    const { rerender } = render(<MessageList {...makeProps({ prompts: [] })} />);
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    const prompt1: PermissionPromptData = {
      requestId: "p1",
      toolTitle: "Run command",
      options: [{ optionId: "allow", name: "Allow" }],
    };

    rerender(<MessageList {...makeProps({ prompts: [prompt1] })} />);

    // Must NOT have called scrollToIndex synchronously
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();

    // Must call it after one animation frame
    act(() => {
      flushRaf();
    });

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });
  });

  it("4e: tailSig change calls scrollToIndex when at bottom and does NOT when not at bottom", () => {
    const { container, rerender } = render(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hel"))] })} />,
    );
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Default atBottom is true
    rerender(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
    );
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });

    // Report user scrolled up
    act(() => {
      simulateScrollUp(container);
    });
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Re-render with streaming tail growth
    rerender(
      <MessageList
        {...makeProps({ units: [single(textMsg("m1", "hello world"))] })}
      />,
    );
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
  });

  it("4f: a new trailing user unit calls scrollToIndex even when not at bottom; re-rendering with same last user unit does not call again", () => {
    const { container, rerender } = render(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
    );
    flushRaf();

    // Mark not at bottom
    act(() => {
      simulateScrollUp(container);
    });
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Append new trailing user message
    rerender(
      <MessageList
        {...makeProps({
          units: [
            single(textMsg("m1", "hello")),
            single(userMsg("prompt 1", 100)),
          ],
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });

    virtuosoHandleRef.scrollToIndex.mockClear();

    // Re-rendering with the same last user unit (e.g. other prop changes)
    rerender(
      <MessageList
        {...makeProps({
          inTurn: true,
          units: [
            single(textMsg("m1", "hello")),
            single(userMsg("prompt 1", 100)),
          ],
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
  });

  it("4g: firstItemIndex decreases on prepend and resets to 100000 on generation change", () => {
    const u2 = single(textMsg("m2", "two"));
    const u3 = single(textMsg("m3", "three"));

    const { rerender } = render(
      <MessageList {...makeProps({ units: [u2, u3], generation: 0 })} />,
    );

    expect(capturedVirtuosoProps.firstItemIndex).toBe(100_000);

    // Prepend 2 units
    const u0 = single(textMsg("m0", "zero"));
    const u1 = single(textMsg("m1", "one"));
    rerender(
      <MessageList
        {...makeProps({ units: [u0, u1, u2, u3], generation: 0 })}
      />,
    );

    expect(capturedVirtuosoProps.firstItemIndex).toBe(99_998);

    // Generation change resets to 100000
    rerender(
      <MessageList
        {...makeProps({ units: [u0, u1, u2, u3], generation: 1 })}
      />,
    );

    expect(capturedVirtuosoProps.firstItemIndex).toBe(100_000);
  });

  it("4h: empty branch (units = []) renders plain scroll div and gate-count change writes scrollTop immediately", () => {
    const { container, rerender } = render(
      <MessageList {...makeProps({ units: [], prompts: [] })} />,
    );

    const scrollEl = container.querySelector(
      '[data-testid="transcript-scroll"]',
    ) as HTMLElement;
    expect(scrollEl).not.toBeNull();
    // Virtuoso stand-in must not be rendered
    expect(container.querySelector('[data-testid="virtuoso-stand-in"]')).toBeNull();

    let writtenScrollTop: number | undefined;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      get: () => 789,
    });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        writtenScrollTop = v;
      },
    });

    const prompt1: PermissionPromptData = {
      requestId: "p1",
      toolTitle: "Run command",
      options: [{ optionId: "allow", name: "Allow" }],
    };

    rerender(
      <MessageList {...makeProps({ units: [], prompts: [prompt1] })} />,
    );

    // Writes scrollTop immediately (without waiting for rAF)
    expect(writtenScrollTop).toBe(789);
  });

  it("4i: resets bottom-lock on generation or activeSessionId change so tailSig follow resumes after remount", () => {
    const { container, rerender } = render(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello"))],
          activeSessionId: "s1",
          generation: 0,
        })}
      />,
    );
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    // User scrolled up
    act(() => {
      simulateScrollUp(container);
    });

    // Verify tailSig changes do not scroll while scrolled up
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world"))],
          activeSessionId: "s1",
          generation: 0,
        })}
      />,
    );
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();

    // Generation change (remount) resets bottom-lock to true
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world"))],
          activeSessionId: "s1",
          generation: 1,
        })}
      />,
    );

    // Now tailSig change (growing last agent-text) DOES scroll
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world!"))],
          activeSessionId: "s1",
          generation: 1,
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });

    // Also verify activeSessionId change resets bottom-lock
    act(() => {
      simulateScrollUp(container);
    });
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Change activeSessionId without changing tailSig yet
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world!"))],
          activeSessionId: "s2",
          generation: 0,
        })}
      />,
    );
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();

    // Now change tailSig (grow last agent-text)
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world!!"))],
          activeSessionId: "s2",
          generation: 0,
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });
  });

  describe("bottom-lock and floating 'Scroll to bottom' button", () => {
    it("bottom-lock active by default: floating button is NOT visible and followOutput(true) === 'auto'", () => {
      render(<MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />);
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
      expect(capturedVirtuosoProps.followOutput(false)).toBe(false);
    });

    it("when user scrolls up (e.g. wheel up): floating button becomes visible and followOutput(true) === false", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      expect(button).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);
    });

    it("clicking floating button calls scrollToIndex('LAST', 'end'), re-engages bottom-lock (followOutput(true) === 'auto'), and hides button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      expect(button).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        button.click();
      });

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
    });

    it("when atBottomStateChange(true) fires (user reaches bottom): floating button dismisses and followOutput(true) === 'auto'", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });
      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(true);
      });
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("submitting a new user message re-engages bottom-lock (followOutput(true) === 'auto') and hides button", () => {
      const { container, rerender } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });
      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      // Submit user message
      rerender(
        <MessageList
          {...makeProps({
            units: [
              single(textMsg("m1")),
              single(userMsg("send message", 123)),
            ],
          })}
        />,
      );

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("streaming tail updates auto-scroll after re-engaging bottom-lock via floating button", () => {
      const { container, rerender } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1", "hel"))] })} />,
      );
      flushRaf();

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      act(() => {
        button.click();
      });
      virtuosoHandleRef.scrollToIndex.mockClear();

      // New streaming tail delta
      rerender(
        <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
      );

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
    });

    it("session switch starts locked with button hidden and followOutput(true) === 'auto'", () => {
      const { container, rerender } = render(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            activeSessionId: "sess-1",
          })}
        />,
      );

      act(() => {
        simulateScrollUp(container);
      });
      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      // Switch session
      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m2"))],
            activeSessionId: "sess-2",
          })}
        />,
      );

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("does not render floating button when units list is empty", () => {
      render(<MessageList {...makeProps({ units: [] })} />);
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
    });

    it("handleScroll: scrollTop decrease with distance <= 80 does not unlock", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });

      // Establish baseline scrollTop at the very bottom: scrollTop = 500 (distance = 0)
      fireEvent.scroll(scroller, { target: { scrollTop: 500 } });
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");

      // Minor upward scroll within 80px threshold: scrollTop = 450 (distanceFromBottom = 1000 - (450 + 500) = 50 <= 80)
      fireEvent.scroll(scroller, { target: { scrollTop: 450 } });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("handleScroll: scrollTop decrease with distance > 80 unlocks and shows button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });

      // Establish baseline scrollTop: scrollTop = 500 (distance = 0)
      fireEvent.scroll(scroller, { target: { scrollTop: 500 } });
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();

      // Upward scroll exceeding 80px threshold: scrollTop = 300 (distanceFromBottom = 1000 - (300 + 500) = 200 > 80)
      fireEvent.scroll(scroller, { target: { scrollTop: 300 } });

      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);
    });

    it("touch-drag down (deltaY > 5 and distance > 80) unlocks and shows button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(scroller, "scrollTop", { value: 300, configurable: true });

      const wrapper = container.firstElementChild!;

      act(() => {
        fireEvent.touchStart(wrapper, {
          touches: [{ clientY: 100 }],
        });
        fireEvent.touchMove(wrapper, {
          touches: [{ clientY: 200 }],
        });
        fireEvent.touchEnd(wrapper);
      });

      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);
    });

    it("short transcript wheel-up does not unlock or show button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;
      expect(scroller).not.toBeNull();

      Object.defineProperty(scroller, "clientHeight", {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroller, "scrollHeight", {
        value: 200,
        configurable: true,
      });

      // Mark isAtBottomRef false so wheel-up would unlock unless the short transcript guard holds
      act(() => {
        capturedVirtuosoProps.atBottomStateChange(false);
      });

      act(() => {
        simulateScrollUp(container);
      });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("rapid streaming growth with atBottomStateChange(false) followed by tailSig change continues to trigger scrollToIndex while locked", () => {
      const { rerender } = render(
        <MessageList
          {...makeProps({ units: [single(textMsg("m1", "hello"))] })}
        />,
      );
      flushRaf();
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(false);
      });

      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();

      rerender(
        <MessageList
          {...makeProps({ units: [single(textMsg("m1", "hello world"))] })}
        />,
      );

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
    });

    it("button click blurs/moves focus and scrolls to bottom", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      expect(button).not.toBeNull();

      button.focus();
      expect(document.activeElement).toBe(button);

      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        button.click();
      });

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      );
      expect(document.activeElement).toBe(scroller);
      expect(document.activeElement).not.toBe(document.body);
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
    });

    it("wheel inside a nested scrollable element does not unlock or show button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      const nested = document.createElement("div");
      nested.className = "overflow-y-auto";
      Object.defineProperty(nested, "clientHeight", { value: 100, configurable: true });
      Object.defineProperty(nested, "scrollHeight", { value: 300, configurable: true });
      nested.scrollTop = 50;
      scroller.appendChild(nested);

      act(() => {
        fireEvent.wheel(nested, { deltaY: -50 });
      });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("wheel inside a nested scrollable element on an SVG target does not unlock", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      const nested = document.createElement("div");
      nested.className = "overflow-y-auto";
      Object.defineProperty(nested, "clientHeight", { value: 100, configurable: true });
      Object.defineProperty(nested, "scrollHeight", { value: 300, configurable: true });
      nested.scrollTop = 50;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.appendChild(path);
      nested.appendChild(svg);
      scroller.appendChild(nested);

      act(() => {
        fireEvent.wheel(path, { deltaY: -50 });
      });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("handleWheel and handleTouchMove early-exit when already unlocked", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;
      expect(scroller).not.toBeNull();

      Object.defineProperty(scroller, "clientHeight", {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroller, "scrollHeight", {
        value: 2000,
        configurable: true,
      });

      // Target an element inside the scroller
      const innerTarget = (scroller.firstElementChild ?? scroller) as HTMLElement;

      // Unlock first
      act(() => {
        simulateScrollUp(container);
      });
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      const getComputedStyleSpy = vi.spyOn(window, "getComputedStyle");
      getComputedStyleSpy.mockClear();

      act(() => {
        fireEvent.wheel(innerTarget, { deltaY: -50 });
        fireEvent.touchStart(innerTarget, { touches: [{ clientY: 100 }] });
        fireEvent.touchMove(innerTarget, { touches: [{ clientY: 200 }] });
      });

      expect(getComputedStyleSpy).not.toHaveBeenCalled();
      getComputedStyleSpy.mockRestore();
    });

    it("floating button has accessible attributes, no duplicate hover class, and ChevronDown has aria-hidden='true'", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByTestId("scroll-to-bottom-button");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-label")).toBe("Scroll to bottom");
      expect(button.className).not.toContain("hover:text-foreground");

      const icon = button.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    });
  });

  /**
   * ARRIVAL SETTLE — the follow that keeps a LOCKED transcript at the bottom
   * while the transcript is still being measured.
   *
   * Opening a **Space** mounts the scroller with the bottom-lock engaged and
   * asks Virtuoso for `initialTopMostItemIndex: { index: "LAST", align: "end" }`.
   * That location is computed from ESTIMATEd row heights, and the transcript
   * then changes size underneath it: the history page lands after the mount
   * (`openSession` fetches), a code block re-measures when shiki's async
   * highlight arrives, an image attachment loads. `followOutput` fires on a
   * changed item COUNT and not on a size change, and the library's own
   * size-change re-anchor is armed exactly once, 100 ms after mount
   * (`react-virtuoso` `index.mjs` `setTimeout(B, 100)`) — so anything that
   * grows the list after that window leaves the viewport above the last row.
   *
   * That is the reported bug: opening a Space lands mid-transcript, and because
   * nothing released the lock (§2/§3 — only a gesture does) the floating button
   * stays hidden, so there is nothing to click and the user scrolls by hand.
   *
   * The settle window therefore re-asserts the bottom on every total-height
   * change WHILE locked, and closes itself the moment it has landed
   * (`atBottomStateChange(true)`), when older history is being prepended
   * (`startReached` — its anchor must survive), or when the cap is hit.
   */
  describe("arrival settle: a locked transcript re-pins while its height is still settling", () => {
    const manyUnits = (n: number): RenderUnit[] =>
      Array.from({ length: n }, (_, i) => single(textMsg(`m${i}`, `row ${i}`, i + 1)));

    const pinCalls = () =>
      virtuosoHandleRef.scrollToIndex.mock.calls.filter(
        ([loc]) => loc?.index === "LAST" && loc?.align === "end",
      ).length;

    it("a total-height change while locked re-asserts the bottom (late row measurement)", () => {
      render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(48_000);
      });
      flushRaf();

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
    });

    it("REGRESSION: the settle fires with no floating button, which is the reported state", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();

      // The lock is engaged from mount and NOTHING releases it on geometry, so
      // the stranded state has no button — this asserts the premise the fix
      // exists for, not just its effect.
      expect(
        container.querySelector('[data-testid="scroll-to-bottom-button"]'),
        "a locked transcript has no button, so a stranded arrival is unfixable by clicking",
      ).toBeNull();

      virtuosoHandleRef.scrollToIndex.mockClear();
      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(48_000);
      });
      flushRaf();

      expect(pinCalls()).toBeGreaterThan(0);
    });

    it("closes the settle once the bottom has been reached, so later height changes do NOT re-pin", () => {
      render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(true);
      });
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(48_000);
      });
      flushRaf();

      expect(
        virtuosoHandleRef.scrollToIndex,
        "once landed, a height change must not yank the viewport (it fights reading and pagination)",
      ).not.toHaveBeenCalled();
    });

    it("does NOT close the settle on atBottomStateChange(true) when the scroller measures off-bottom (the spurious early report)", () => {
      render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();

      // The shape react-virtuoso actually reports while the initial location is
      // pending: the flag says "at bottom", the GEOMETRY says 27k px away.
      const scroller = document.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;
      Object.defineProperty(scroller, "clientHeight", { value: 557, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 48_000, configurable: true });
      Object.defineProperty(scroller, "scrollTop", { value: 0, configurable: true });

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(true);
      });
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(48_000);
      });
      flushRaf();

      expect(
        virtuosoHandleRef.scrollToIndex,
        "closing on the unverified report strands the transcript with no button — the exact bug",
      ).toHaveBeenCalledWith({ index: "LAST", align: "end" });
    });

    it("closes on atBottomStateChange(true) once the geometry agrees the bottom is reached", () => {
      render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();

      const scroller = document.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;
      Object.defineProperty(scroller, "clientHeight", { value: 557, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 48_000, configurable: true });
      Object.defineProperty(scroller, "scrollTop", {
        value: 48_000 - 557, // distance === 0
        configurable: true,
      });

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(true);
      });
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(48_000);
      });
      flushRaf();

      expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
    });

    it("does NOT re-pin while unlocked (the user scrolled up and rows are still measuring)", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();

      act(() => {
        simulateScrollUp(container);
      });
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(48_000);
      });
      flushRaf();

      expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: /scroll to bottom/i }),
        "the button is the user's own escape hatch here, the settle must not steal it",
      ).not.toBeNull();
    });

    it("closes the settle on startReached so an older-history prepend keeps its scroll anchor", () => {
      const onStartReached = vi.fn();
      render(
        <MessageList
          {...makeProps({ units: manyUnits(50), hasMore: true, onStartReached })}
        />,
      );
      flushRaf();

      act(() => {
        capturedVirtuosoProps.startReached();
      });
      expect(onStartReached).toHaveBeenCalledTimes(1);
      virtuosoHandleRef.scrollToIndex.mockClear();

      // The prepend changes the total height; `useFirstItemIndex` is what must
      // own the position from here, not the settle.
      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(72_000);
      });
      flushRaf();

      expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
    });

    it("bounds the settle: a height change per frame cannot pin forever", () => {
      // A controlled clock, or this test proves nothing: every iteration lands
      // inside the 50 ms throttle, so "it stopped early" is true even with the
      // cap and the duration bound both deleted. Verified — deleting BOTH bounds
      // leaves this test green unless time actually advances.
      let clock = 1_000;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);

      try {
        render(
          <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
        );
        flushRaf();
        virtuosoHandleRef.scrollToIndex.mockClear();

        for (let i = 0; i < 40; i++) {
          clock += 60; // past the throttle, so every change is eligible to pin
          act(() => {
            capturedVirtuosoProps.totalListHeightChanged(40_000 + i * 1_000);
          });
        }

        const pinned = pinCalls();
        expect(pinned, "the settle must have done its job").toBeGreaterThan(0);
        expect(pinned, "40 eligible height changes must not mean 40 viewport yanks").toBeLessThan(40);

        // And it stays closed: the bound is terminal, not a pause.
        virtuosoHandleRef.scrollToIndex.mockClear();
        for (let i = 0; i < 10; i++) {
          clock += 60;
          act(() => {
            capturedVirtuosoProps.totalListHeightChanged(90_000 + i * 1_000);
          });
        }
        expect(
          virtuosoHandleRef.scrollToIndex,
          "a bounded settle CLOSES, it does not throttle and resume",
        ).not.toHaveBeenCalled();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("closes on the duration bound even when changes trickle in slower than the pin cap", () => {
      // Spaced at 100 ms, the PIN CAP cannot explain the stop: 24 pins would take
      // 2.4 s of this clock, so a settle that stops at ~15 pins stopped on the
      // DURATION bound. (Deleting only the cap, or only the bound, each leaves the
      // other holding the previous test green — so this is the only thing that
      // proves the bound exists.)
      let clock = 5_000;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);

      try {
        render(
          <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
        );
        flushRaf();
        const startClock = clock;
        virtuosoHandleRef.scrollToIndex.mockClear();

        const lastPinClock = { value: 0 };
        let lastPinCount = 0;
        for (let i = 0; i < 40; i++) {
          clock += 100;
          act(() => {
            capturedVirtuosoProps.totalListHeightChanged(40_000 + i * 1_000);
          });
          // Record the clock of the LAST pin, not of the last iteration: the
          // assertion below is "pinning STOPPED by ~1.5 s of this clock", and
          // reading `calls.length > 0` would record every iteration after the
          // stop and make the bound unassertable.
          const calls = pinCalls();
          if (calls > lastPinCount) {
            lastPinCount = calls;
            lastPinClock.value = clock;
          }
        }

        const pinned = pinCalls();
        expect(pinned, "the settle must have pinned at least once").toBeGreaterThan(0);
        expect(
          pinned,
          "the pin cap is 24, so reaching it would mean the duration bound never fired",
        ).toBeLessThan(24);
        expect(
          lastPinClock.value - startClock,
          "the settle must close on elapsed time, not only on a pin count",
        ).toBeLessThanOrEqual(1_600);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("closes on the pin cap when changes arrive fast enough to reach it inside the duration bound", () => {
      // The mirror of the test above: spaced at 60 ms, the 24-pin cap is reached
      // at 1.44 s of this clock — BEFORE the 1.5 s duration bound — so a settle
      // that stops at exactly the cap stopped on the cap. Two redundant guards
      // need two clocks, or deleting either one stays green.
      let clock = 10_000;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);

      try {
        render(
          <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
        );
        flushRaf();
        const startClock = clock;
        virtuosoHandleRef.scrollToIndex.mockClear();

        for (let i = 0; i < 40; i++) {
          clock += 60;
          act(() => {
            capturedVirtuosoProps.totalListHeightChanged(40_000 + i * 1_000);
          });
        }

        expect(
          pinCalls(),
          "the cap must be what stopped it, at 24 pins and under 1.5 s of this clock",
        ).toBe(24);
        expect(clock - startClock, "the loop must have outlived the cap").toBeGreaterThan(1_440);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("re-arms the settle when the floating button is clicked, so a late measurement after the click cannot strand again", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();

      // CLOSE the settle first, on the real arrival path. Without this the test
      // passes with no re-arm at all, because the settle is still open from mount.
      act(() => {
        capturedVirtuosoProps.startReached();
      });
      virtuosoHandleRef.scrollToIndex.mockClear();
      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(72_000);
      });
      flushRaf();
      expect(
        virtuosoHandleRef.scrollToIndex,
        "precondition: the settle is closed, so a height change alone pins nothing",
      ).not.toHaveBeenCalled();

      // Now: scroll up (unlock, button appears), then click it to re-lock.
      act(() => {
        simulateScrollUp(container);
      });
      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      act(() => {
        button.click();
      });
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      virtuosoHandleRef.scrollToIndex.mockClear();

      // The click landed while rows were still measuring, so the list grows again.
      // With the lock engaged the button stays hidden — so without a re-arm there
      // is no way back to the bottom but the mouse wheel.
      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(80_000);
      });
      flushRaf();

      expect(
        virtuosoHandleRef.scrollToIndex,
        "the click re-arms the settle: a re-locked transcript must finish landing",
      ).toHaveBeenCalledWith({ index: "LAST", align: "end" });
    });

    it("re-arming after an EXHAUSTED settle still pins (the re-arm resets the bounds, not just the flag)", () => {
      // The case the plain re-arm test cannot reach: the settle was closed by its
      // OWN bounds, so a re-arm that only flips the flag re-opens something that
      // closes again on its first height change — a re-arm that does nothing.
      let clock = 20_000;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);

      try {
        const { container } = render(
          <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
        );
        flushRaf();
        // Drop the mount-time gate-effect pin from the count: `pinCalls()` counts
        // every LAST/end call, and Effect 1 issues one on mount.
        virtuosoHandleRef.scrollToIndex.mockClear();

        // Exhaust the PIN CAP: 60 ms spacing reaches 24 pins at 1.44 s of this
        // clock, inside the 1.5 s duration bound, so the cap is what closes it.
        // (Spacing at 100 ms would close on the DURATION bound and leave the pin
        // count under the cap — and then a re-arm that forgets to reset the count
        // would still pin, hiding the very bug this test exists for.)
        for (let i = 0; i < 40; i++) {
          clock += 60;
          act(() => {
            capturedVirtuosoProps.totalListHeightChanged(40_000 + i * 1_000);
          });
        }
        expect(
          pinCalls(),
          "precondition: the settle ran to its 24-pin cap",
        ).toBe(24);

        // The settle is closed by its bounds, so a further change pins nothing.
        clock += 100;
        virtuosoHandleRef.scrollToIndex.mockClear();
        act(() => {
          capturedVirtuosoProps.totalListHeightChanged(90_000);
        });
        expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();

        // User scrolls up, then clicks the button.
        act(() => {
          simulateScrollUp(container);
        });
        const button = screen.getByRole("button", { name: /scroll to bottom/i });
        act(() => {
          button.click();
        });
        virtuosoHandleRef.scrollToIndex.mockClear();

        clock += 100;
        act(() => {
          capturedVirtuosoProps.totalListHeightChanged(96_000);
        });

        expect(
          virtuosoHandleRef.scrollToIndex,
          "re-arming must reset the pin count and the clock, or it re-opens a dead settle",
        ).toHaveBeenCalledWith({ index: "LAST", align: "end" });
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("does NOT pin on a height DECREASE, and never unlocks the user with its own clamp", () => {
      // react-virtuoso's own size watcher re-pins only on `SIZE_INCREASED`, and
      // for the same reason: shrinking the list makes the browser CLAMP scrollTop,
      // and `handleScroll` reads a clamped decrease as "the user scrolled up". A
      // settle that pins on a decrease therefore unlocks itself and flashes the
      // very button it exists to make unnecessary. A decrease also cannot strand:
      // clamping lands you at the bottom, not above it.
      //
      // A controlled clock, or this asserts nothing: the baseline call and the
      // decrease would fall inside one 50 ms throttle window, and "it did not
      // pin" would be the throttle's doing, not the decrease rule's. Verified —
      // deleting the decrease guard leaves this test GREEN without the clock.
      let clock = 60_000;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);

      try {
        const { container } = render(
          <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
        );
        flushRaf();

        const scroller = document.querySelector(
          '[data-testid="virtuoso-stand-in"]',
        ) as HTMLElement;
        // Start parked at the bottom of a 48 000px list.
        Object.defineProperty(scroller, "clientHeight", { value: 557, configurable: true });
        Object.defineProperty(scroller, "scrollHeight", { value: 48_000, configurable: true });
        const scrollTop = { value: 48_000 - 557 };
        Object.defineProperty(scroller, "scrollTop", {
          configurable: true,
          get: () => scrollTop.value,
          set: (v) => {
            scrollTop.value = v;
          },
        });

        // Establish the height first: until the first report nothing is measured,
        // so reporting 40 000 cold would be an INCREASE and correctly pin.
        act(() => {
          capturedVirtuosoProps.totalListHeightChanged(48_000);
        });
        clock += 100;
        virtuosoHandleRef.scrollToIndex.mockClear();

        // A row collapses: the list shrinks by 8 000px, well outside the throttle.
        act(() => {
          capturedVirtuosoProps.totalListHeightChanged(40_000);
        });

        expect(
          virtuosoHandleRef.scrollToIndex,
          "a decrease cannot strand a locked transcript, so pinning on it is a yank",
        ).not.toHaveBeenCalled();

        // Now let the browser clamp, as it would after that shrink, and confirm the
        // component still reads itself as at the bottom (no button).
        act(() => {
          scrollTop.value = 40_000 - 557;
          fireEvent.scroll(scroller, { target: { scrollTop: 40_000 - 557 } });
        });
        expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
        expect(container).toBeTruthy();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("re-arming also resets the height baseline, so growth after a shrink still pins", () => {
      // The click can land while rows are collapsing as well as growing. If the
      // re-arm kept the pre-click height, a 90 000 → 80 000 collapse followed by
      // 85 000 of growth would read as a DECREASE against the stale baseline and
      // the re-armed settle would never pin.
      let clock = 40_000;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);

      try {
        const { container } = render(
          <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
        );
        flushRaf();

        // Park the baseline HIGH while the settle is open...
        act(() => {
          capturedVirtuosoProps.totalListHeightChanged(90_000);
        });
        clock += 100;
        // ...then close it, and let the list COLLAPSE while it is closed. The
        // handler returns before touching the baseline when the settle is shut,
        // so 90 000 is what survives into the re-arm — that staleness is the bug.
        act(() => {
          capturedVirtuosoProps.startReached();
        });
        clock += 100;
        act(() => {
          capturedVirtuosoProps.totalListHeightChanged(80_000);
        });

        act(() => {
          simulateScrollUp(container);
        });
        const button = screen.getByRole("button", { name: /scroll to bottom/i });
        act(() => {
          button.click();
        });
        virtuosoHandleRef.scrollToIndex.mockClear();

        clock += 100;
        act(() => {
          capturedVirtuosoProps.totalListHeightChanged(85_000); // growth, but below 90 000
        });
        flushRaf();

        expect(
          virtuosoHandleRef.scrollToIndex,
          "growth after a re-arm must pin even when the list is smaller than before the click",
        ).toHaveBeenCalledWith({ index: "LAST", align: "end" });
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("does NOT close on the vacuous atBottomStateChange(true) of a not-yet-sized list", () => {
      // Measured in a real browser at mount: react-virtuoso reports
      // atBottom(true) while the item list still has no height, so
      // scrollHeight === clientHeight and distance is a VACUOUS 0 — there is
      // nothing to scroll yet. Closing there strands the transcript on the very
      // next height report (48 000px lands, distance becomes 47 443), which is
      // the bug this whole settle exists to fix.
      render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();

      const scroller = document.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;
      Object.defineProperty(scroller, "clientHeight", { value: 557, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 557, configurable: true });
      Object.defineProperty(scroller, "scrollTop", { value: 0, configurable: true });

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(true);
      });
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(48_000);
      });
      flushRaf();

      expect(
        virtuosoHandleRef.scrollToIndex,
        "a non-scrollable box has not 'arrived at the bottom', it has not been measured",
      ).toHaveBeenCalledWith({ index: "LAST", align: "end" });
    });

    it("coalesces several height changes in one frame into a single pin", () => {
      render(
        <MessageList {...makeProps({ units: manyUnits(50), hasMore: true })} />,
      );
      flushRaf();
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.totalListHeightChanged(40_000);
        capturedVirtuosoProps.totalListHeightChanged(41_000);
        capturedVirtuosoProps.totalListHeightChanged(42_000);
      });
      flushRaf();

      expect(pinCalls()).toBe(1);
    });
  });

  /**
   * ATTENTION-ALERT CLICK FOCUS — the one-shot `focusRequest` prop.
   *
   * The listener that raises it lives with `App` and runs in a Tauri event
   * callback OUTSIDE React, so it cannot scroll anything itself; it leaves a
   * pending `{ sessionId, nonce }` and this component consumes it (see
   * `MessageList.tsx`'s Effect 4). These cases pin the four properties the
   * consumer has to have, and the first one is the reason the signal exists at
   * all: the count-keyed gate effect CANNOT cover this transition.
   */
  describe("attention-alert click focus (the one-shot focusRequest)", () => {
    const pinCalls = () =>
      virtuosoHandleRef.scrollToIndex.mock.calls.filter(
        ([loc]) => loc?.index === "LAST" && loc?.align === "end",
      ).length;

    it("a pending request scrolls to the bottom even though the user had scrolled up (isBottomLocked false, gate counts unchanged)", () => {
      const { container, rerender } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      flushRaf();

      // The user scrolled up: the lock is released and the floating button is
      // up — the state the click has to overcome.
      act(() => {
        simulateScrollUp(container);
      });
      expect(
        container.querySelector('[data-testid="scroll-to-bottom-button"]'),
      ).not.toBeNull();
      virtuosoHandleRef.scrollToIndex.mockClear();

      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            focusRequest: { sessionId: "s1", nonce: 1 },
          })}
        />,
      );

      // Synchronous (not one frame later, as Effect 1 does): the click is a
      // deliberate arrival, the same as a button click.
      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
      // The same HANDSHAKE the floating button performs — the scroller takes
      // focus so it does not drop to `<body>` when the button unmounts — because
      // the consumer calls `handleScrollToBottom` rather than a second scroll
      // authority.
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      );
      expect(scroller?.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(scroller);
      // And the lock is back, so the button is gone (the follow resumes).
      expect(
        container.querySelector('[data-testid="scroll-to-bottom-button"]'),
      ).toBeNull();
      // The pending value is DRAINED by the consumer that acted on it, so no
      // later mount replays the scroll.
      expect(getAttentionFocusRequest()).toBeNull();
    });

    it("one-gate → one-gate: the request scrolls where the count-keyed gate effect fires nothing", () => {
      // THE motivating transition (spec §4): clicking an alert for a Session
      // with one gate while another one-gate Session is open. Effect 1 keys on
      // `prompts.length`, so the counts do not change and it stays silent; case
      // 4c above already proves that blindness for units, and this proves the fix
      // reaches past it.
      const prompt1: PermissionPromptData = {
        requestId: "p1",
        toolTitle: "Run command",
        options: [{ optionId: "allow", name: "Allow" }],
      };
      const { container, rerender } = render(
        <MessageList
          {...makeProps({ units: [single(textMsg("m1"))], prompts: [prompt1] })}
        />,
      );
      flushRaf();
      act(() => {
        simulateScrollUp(container);
      });
      virtuosoHandleRef.scrollToIndex.mockClear();

      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            // A DIFFERENT prompt object, the SAME count — the count-keyed
            // effect cannot see this change either.
            prompts: [{ ...prompt1, requestId: "p2", toolTitle: "Edit file" }],
            focusRequest: { sessionId: "s1", nonce: 7 },
          })}
        />,
      );

      expect(pinCalls()).toBe(1);
      expect(getAttentionFocusRequest()).toBeNull();
    });

    it("a repeat click with a NEW nonce scrolls again; the SAME nonce does not (idempotent per nonce)", () => {
      // The idempotency half is what makes a StrictMode / Session-switch double
      // MOUNT scroll once rather than twice: the signal module outlives the
      // remount, so the consumed-nonce ref — not the drain — is what stops the
      // replay.
      const { rerender } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      flushRaf();
      virtuosoHandleRef.scrollToIndex.mockClear();

      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            focusRequest: { sessionId: "s1", nonce: 1 },
          })}
        />,
      );
      expect(pinCalls()).toBe(1);

      // The SAME nonce in a fresh object (a re-render, or a second mount reading
      // the same request before the drain landed): no second scroll.
      virtuosoHandleRef.scrollToIndex.mockClear();
      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            focusRequest: { sessionId: "s1", nonce: 1 },
          })}
        />,
      );
      expect(pinCalls()).toBe(0);

      // A NEW nonce is a NEW click on the same Session and must re-fire — the
      // reason the request carries a nonce instead of just a session id.
      setAttentionFocusRequest({ sessionId: "s1", nonce: 2 });
      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            focusRequest: { sessionId: "s1", nonce: 2 },
          })}
        />,
      );
      expect(pinCalls()).toBe(1);
    });

    it("a request for a DIFFERENT session does not scroll this transcript and is left pending", () => {
      const { rerender } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      flushRaf();
      virtuosoHandleRef.scrollToIndex.mockClear();
      setAttentionFocusRequest({ sessionId: "s2", nonce: 1 });

      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            focusRequest: { sessionId: "s2", nonce: 1 },
          })}
        />,
      );

      expect(
        virtuosoHandleRef.scrollToIndex,
        "an `s1` transcript must not answer an `s2` request",
      ).not.toHaveBeenCalled();
      // Left PENDING, not drained: `openSession` mounts the matching transcript,
      // which consumes it then. Draining here would eat the user's click.
      expect(getAttentionFocusRequest()).toEqual({ sessionId: "s2", nonce: 1 });
    });

    it("the EMPTY branch drains a matching request without scrolling (a stored session's first frame)", () => {
      // `openSession` fetches the history page, so the first frame a STORED
      // session renders is the empty branch — no Virtuoso, nothing to scroll,
      // and the gate card is already on screen. The branch must consume the
      // request so a later mount does not replay it.
      setAttentionFocusRequest({ sessionId: "s1", nonce: 3 });

      const { container } = render(
        <MessageList
          {...makeProps({
            units: [],
            focusRequest: { sessionId: "s1", nonce: 3 },
          })}
        />,
      );

      expect(container.querySelector('[data-testid="virtuoso-stand-in"]')).toBeNull();
      expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
      expect(getAttentionFocusRequest()).toBeNull();
    });

    it("the EMPTY branch leaves a request for another session pending", () => {
      setAttentionFocusRequest({ sessionId: "s2", nonce: 4 });

      render(
        <MessageList
          {...makeProps({
            units: [],
            focusRequest: { sessionId: "s2", nonce: 4 },
          })}
        />,
      );

      expect(getAttentionFocusRequest()).toEqual({ sessionId: "s2", nonce: 4 });
    });
  });
});
