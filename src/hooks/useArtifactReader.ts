import { useRef, useState } from "react";
import { describeIpcError } from "../lib/ipcError";
import type { Artifact } from "../lib/tauri";

/**
 * THE ARTIFACT READER — the selection a **Task** detail dialog's artifact rail
 * and artifact pane share, plus the **request epoch** that keeps their document
 * honest (ADR 0114).
 * ## What this hook deliberately does NOT do
 *
 * - **It stops the stale RENDER, not the work.** The epoch drops a superseded
 *   answer; it cannot stop the command that produces it. There is no
 *   `AbortController` and no `signal` here, and that is not an oversight: Tauri
 *   documents `invoke()` with NO cancellation argument, so there is nothing to
 *   plumb an abort into and an "abortable race" would be this epoch with extra
 *   ceremony. `useActionState`/`useTransition` are no better here — they are
 *   built for mutations and forms, and they order by SERIALIZING, which changes
 *   when the fetch fires.
 * - **No unmount guard.** No site in this repo has one, and adding a
 *   cancellation flag would change what a late resolve does.
 * - **`select` never rejects.** It swallows a rejection into `artifactError`
 *   exactly as `selectArtifact` did before it was lifted out of the dialog, and
 *   the call site relies on that: it writes `void select(key)`, which would
 *   become an unhandled rejection the moment `select` threw.
 *
 * ## The two locks, and why there are two
 *
 * 1. **Clear before the `await`** — a previous document cannot paint under a new
 *    key while the new read is in flight.
 * 2. **Identity check after the `await`** — the epoch comparison that DROPS a
 *    resolution belonging to a key the reader has moved on from.
 *
 * The second is the one a clear cannot catch: the late answer arrives AFTER the
 * clear, so lock 1 is blind to it and only the epoch sees it. Both are pinned —
 * lock 1 by `TaskDetailDialog.test.tsx:842-866`, lock 2 by `:868-905`, and by
 * the hook-level twins in `useArtifactReader.test.ts`.
 *
 * The vocabulary is `CONTEXT.md`'s **request epoch** (never "guard", which in
 * this repo names a source-scanning TEST instrument, and never bare "epoch",
 * which belongs to **Session incarnation**), and the hook-local ref that holds
 * it now carries that noun: `requestEpochRef`. ADR 0114 places it here on the
 * rule that **the epoch lives with the `await` that needs it** — which is also
 * why the hook owns exactly one `await` and why the fetch is INJECTED: the
 * store action's owner stays the dialog (ADR 0074), and the hook stays free of
 * any IPC import, and so of any barrel mock.
 */
export interface UseArtifactReader {
  /** The key the reader is looking at; `null` means nothing is chosen. */
  selectedKey: string | null;
  /** The document for `selectedKey`, or `null` — which is also the ANSWER
   *  "no such artifact", and renders no document rather than an error. */
  selectedArtifact: Artifact | null;
  /** The read's OWN failure sentence, never the launch's. */
  artifactError: string | null;
  /** Read `key` for the given card. Resolves (never rejects) once the read
   *  settles. */
  select: (key: string) => Promise<void>;
}

export interface UseArtifactReaderOptions {
  /** The card whose artifact is being read. */
  taskId: string;
  /** The store's `getArtifact` action, PASSED IN rather than selected here. */
  getArtifact: (taskId: string, key: string) => Promise<Artifact | null>;
}

export function useArtifactReader({
  taskId,
  getArtifact,
}: UseArtifactReaderOptions): UseArtifactReader {
  // THE ARTIFACT READER's state (issue #180, spec §3, ADR 0114). `selectedKey === null` means
  // nothing is chosen: a card WITH keys does not auto-open one, because the board
  // read carries names only and fetching a document nobody asked for is exactly the
  // wire cost the keys-only payload exists to avoid.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  // Its OWN error cell, not the dialog's launch `error`: the two failures are about
  // different things (a document that would not load vs. a Session that would not
  // start) and one cell would let a stale launch sentence sit under an artifact
  // read, or a reader failure claim the launch failed.
  const [artifactError, setArtifactError] = useState<string | null>(null);

  // WHICH key the one in-flight read belongs to. A ref and not state: nothing
  // renders it, and it has to be readable by a resolution that lands AFTER the
  // reader has moved on to another key — a `useState` value read inside the `await`
  // below is the value this closure captured, which is exactly the stale answer.
  const requestEpochRef = useRef<string | null>(null);

  const select = async (key: string): Promise<void> => {
    requestEpochRef.current = key;
    setSelectedKey(key);
    // CLEARED BEFORE the fetch, so a previous document cannot paint under a new key
    // while the new read is still in flight. This is one of TWO locks: it covers the
    // in-flight gap, and the identity check after the `await` covers the answer that
    // arrives after the reader moved on (which no clear can catch).
    setSelectedArtifact(null);
    setArtifactError(null);
    try {
      const artifact = await getArtifact(taskId, key);
      // DROPPED, not rendered, when the reader has moved on: two reads can be in
      // flight and the older one can answer LAST (a big spec over a slow IPC beats a
      // small one), and painting it would show one key's document under another —
      // a document lying about which key it is. Blanking the reader would be the
      // other wrong answer, so the late resolution changes NOTHING.
      if (requestEpochRef.current !== key) return;
      // `null` is an ANSWER (no such artifact, or no such Task — the `getTask`
      // shape) and renders no document rather than an error sentence.
      setSelectedArtifact(artifact);
    } catch (err) {
      // Same rule for the failure: a read the reader no longer asked for must not
      // write an error sentence into the current view.
      if (requestEpochRef.current !== key) return;
      // A rejection is the store RETHROWING (it captures to `error` AND rethrows, so
      // a caller can tell "failed" from "answered `null`").
      setArtifactError(describeIpcError(err));
    }
  };

  return { selectedKey, selectedArtifact, artifactError, select };
}
