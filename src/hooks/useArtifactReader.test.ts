import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useArtifactReader } from "./useArtifactReader";
import type { Artifact } from "../lib/tauri";

/**
 * The artifact reader's hook (ADR 0114), pinned at the level its request epoch
 * actually lives. Every case here is the hook-level twin of one
 * `TaskDetailDialog.test.tsx` already pins through the DOM — the clear-before-fetch
 * case at `:842-866` and the out-of-order case at `:868-905` — because this
 * extraction is MOVE-ONLY: the hook is not allowed to be better than the block it
 * replaces, so these tests exist to prove the two locks survived the move and that
 * nothing else about the read changed.
 *
 * `getArtifact` is a plain `vi.fn()` passed in as an option. The module holds no
 * IPC of its own, so this file mocks NO barrel — the shape
 * `src/lib/tauriBarrel.test.ts:765-767` records as the preference for a non-IPC
 * module, and the reason the fetch is injected rather than selected inside.
 */

/** One artifact row, as the store's `getArtifact` answers it. */
const artifact = (key: string, markdown: string): Artifact => ({
  taskId: "tsk_1",
  key,
  markdown,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_600_000,
});

/** Resolve/reject on command, so "in flight" is observable. Copied from
 *  `useAsyncAction.test.ts`, which has the same need. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The hook always attaches a `catch`, but the deferral itself must not trip
  // vitest's unhandled-rejection check if a test rejects and then asserts before
  // the microtask runs.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Mount the reader for one card with an injected fetch. */
function mount(getArtifact: (taskId: string, key: string) => Promise<Artifact | null>) {
  return renderHook(() => useArtifactReader({ taskId: "tsk_1", getArtifact }));
}

describe("useArtifactReader — the selection and its read", () => {
  it("selecting a key fetches (taskId, key) and stores the answer", async () => {
    const getArtifact = vi.fn(async (_taskId: string, key: string) =>
      artifact(key, "# First spec"),
    );
    const { result } = mount(getArtifact);
    // Nothing is chosen on mount and nothing is fetched: a card WITH keys does
    // not auto-open one (the keys-only payload exists to avoid exactly this
    // wire cost), and there is no `useEffect` here to do it.
    expect(result.current.selectedKey).toBeNull();
    expect(result.current.selectedArtifact).toBeNull();
    expect(result.current.artifactError).toBeNull();
    expect(getArtifact).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.select("plan");
    });
    expect(getArtifact).toHaveBeenCalledTimes(1);
    expect(getArtifact).toHaveBeenCalledWith("tsk_1", "plan");
    expect(result.current.selectedKey).toBe("plan");
    expect(result.current.selectedArtifact?.markdown).toBe("# First spec");
    expect(result.current.artifactError).toBeNull();
  });

  it("stores `null` as an ANSWER and sets no error", async () => {
    // "No such artifact" (or no such Task — the `getTask` shape) is an answer and
    // not a failure. A hook that turned `null` into a sentence would make "this
    // card has no spec" unreadable as distinct from a broken read, and the
    // store's pass-through contract (`store/tasks.ts:235-237`) is pinned on it.
    const getArtifact = vi.fn(async () => null);
    const { result } = mount(getArtifact);
    await act(async () => {
      await result.current.select("spec");
    });
    expect(result.current.selectedKey).toBe("spec");
    expect(result.current.selectedArtifact).toBeNull();
    expect(result.current.artifactError).toBeNull();
  });

  it("a rejection becomes the describeIpcError sentence and does not reject select", async () => {
    // A rejection reaching here is the store RETHROWING (it captures to its own
    // `error` AND rethrows, so a caller can tell "failed" from "answered `null`").
    // The hook swallows it into `artifactError` exactly as `selectArtifact` does
    // today — the call site writes `void select(key)`, which is only safe while
    // `select` never rejects. The sentence must be `describeIpcError`'s and not a
    // narrower `String(err)`, because the dialog's error line asserts the exact
    // string.
    const getArtifact = vi.fn(async () => {
      throw new Error("ipc failed");
    });
    const { result } = mount(getArtifact);
    await act(async () => {
      await expect(result.current.select("plan")).resolves.toBeUndefined();
    });
    expect(result.current.artifactError).toBe("ipc failed");
    expect(result.current.selectedArtifact).toBeNull();
  });

  it("clears the previous document and error before the next fetch resolves", async () => {
    // THE in-flight gap — the twin of the dialog's "drops the previous document
    // while the next fetch is still in flight" (`:842-866`). The LAST read must
    // NOT answer: two settled reads reach the correct final frame without ever
    // clearing, so a case built on resolved mocks certifies nothing about the
    // clear. Three reads, so BOTH cells are standing when the hanging read
    // starts: `plan` leaves a document, `research` leaves an error sentence, and
    // the only frame `spec` may show is "selected, nothing loaded, no failure".
    // This is the FIRST of two locks; the request epoch after the `await` is the
    // second.
    const held = deferred<Artifact | null>();
    const queue: Array<() => Promise<Artifact | null>> = [
      async () => artifact("plan", "# First spec"),
      async () => {
        throw new Error("ipc failed");
      },
      () => held.promise,
    ];
    let call = 0;
    const getArtifact = vi.fn(() => queue[call++]!());
    const { result } = mount(getArtifact);
    await act(async () => {
      await result.current.select("plan");
    });
    expect(result.current.selectedArtifact?.markdown).toBe("# First spec");
    await act(async () => {
      await result.current.select("research");
    });
    expect(result.current.artifactError).toBe("ipc failed");
    act(() => {
      void result.current.select("spec");
    });
    expect(result.current.selectedKey).toBe("spec");
    expect(result.current.selectedArtifact).toBeNull();
    expect(result.current.artifactError).toBeNull();
    // The held read still lands when it is finally answered — the clear is not a
    // cancellation.
    await act(async () => {
      held.resolve(artifact("spec", "# Third document"));
      await held.promise;
    });
    expect(result.current.selectedArtifact?.markdown).toBe("# Third document");
    expect(result.current.artifactError).toBeNull();
  });
});

describe("useArtifactReader — the request epoch", () => {
  it("an out-of-order resolution cannot paint one key's document under another", async () => {
    // THE case the request epoch exists for, and the only one that can see it —
    // the twin of `TaskDetailDialog.test.tsx:868-905`. Two reads are in flight
    // and the FIRST answers LAST: a big spec over a slow IPC beating a small one.
    // `selectedKey` is `research`, so the frame that arrives for `plan` must be
    // DROPPED — painting it would show a document lying about which key it is,
    // and blanking the reader would be the other wrong answer. Clearing on select
    // cannot catch this (the late answer lands AFTER the clear), so this pins the
    // epoch and nothing else.
    const slots: Array<(v: Artifact | null) => void> = [];
    const getArtifact = vi.fn(
      () => new Promise<Artifact | null>((resolve) => slots.push(resolve)),
    );
    const { result } = mount(getArtifact);
    act(() => {
      void result.current.select("plan");
      void result.current.select("research");
    });
    expect(getArtifact).toHaveBeenCalledTimes(2);
    expect(getArtifact).toHaveBeenNthCalledWith(1, "tsk_1", "plan");
    expect(getArtifact).toHaveBeenNthCalledWith(2, "tsk_1", "research");
    // The SECOND read answers first — the normal order.
    await act(async () => {
      slots[1]!(artifact("research", "# Second report"));
      await Promise.resolve();
    });
    expect(result.current.selectedArtifact?.markdown).toBe("# Second report");
    // The FIRST read answers now, while `research` is what is selected.
    await act(async () => {
      slots[0]!(artifact("plan", "# First spec"));
      await Promise.resolve();
    });
    // The late `plan` document is dropped: the reader still holds `research`.
    expect(result.current.selectedKey).toBe("research");
    expect(result.current.selectedArtifact?.markdown).toBe("# Second report");
  });

  it("a superseded rejection writes no error sentence", async () => {
    // The same rule on the FAILURE path — the case the dialog has no DOM test
    // for, and the reason the `catch` repeats the epoch check rather than trusting
    // the clear. Without it, the late failure of the SUPERSEDED read would replace
    // the document the reader is actually looking at with a sentence about a key
    // nobody asked for any more.
    const answers: Array<(v: Artifact | null) => void> = [];
    const failures: Array<(reason: unknown) => void> = [];
    const getArtifact = vi.fn((_taskId: string, key: string) =>
      key === "plan"
        ? new Promise<Artifact | null>((_resolve, reject) => {
            failures.push(reject);
          })
        : new Promise<Artifact | null>((resolve) => {
            answers.push(resolve);
          }),
    );
    const { result } = mount(getArtifact);
    act(() => {
      void result.current.select("plan");
      void result.current.select("research");
    });
    await act(async () => {
      answers[0]!(artifact("research", "# Second report"));
      await Promise.resolve();
    });
    expect(result.current.selectedArtifact?.markdown).toBe("# Second report");
    expect(result.current.artifactError).toBeNull();
    await act(async () => {
      failures[0]!(new Error("ipc failed"));
      await Promise.resolve();
    });
    expect(result.current.artifactError).toBeNull();
    expect(result.current.selectedArtifact?.markdown).toBe("# Second report");
  });
});
