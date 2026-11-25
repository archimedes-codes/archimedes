/**
 * The **session `ready` marker** — the one owner of the two strings that make it
 * work. Nothing here reads a store or a database; this is a word and a sentence.
 *
 * ## What the marker is
 *
 * A model that finishes the work on its Session writes a todo item whose `content`
 * is exactly the single word `ready` and whose `status` is `completed`. The
 * desktop reads that item and puts a mark on every **Task** card the Session is
 * linked to. `store/interactive.ts` owns the DETECTION (`isReadyMarker`,
 * `boardAssertsReady`); this module owns the VOCABULARY it detects and the
 * INSTRUCTION that produces it.
 *
 * ## Why this lives in `lib/` and not beside the detector in `store/`
 *
 * The sentence has to be appended to a launch message by `lib/taskPrompt.ts`, and
 * `layerBoundary.test.ts` forbids a `lib/` module from runtime-importing a
 * `store/` module. Defining the word in `store/interactive.ts` and re-spelling it
 * in `lib/` would therefore put the SAME literal in two layers with nothing
 * enforcing that they agree — the exact drift this repo keeps documenting. So both
 * strings live here, the detector imports the word DOWNWARD, and
 * `readyMarker.test.ts` pins the sentence against the constant.
 *
 * ## Why a convention and not a verb (do not "fix" this by adding a tool)
 *
 * A model-facing verb is engine-gated. `TaskCall` and `trait TaskStore` live in
 * the crates.io-pinned `fulcrum-harness`, and `tool_specs()` is the crate's — this
 * repo contributes ZERO tool specs. The obvious shortcut is closed too: the engine
 * CONSTRUCTS `TodoItem { content, status, description }` and emits the
 * constructed vector, so an extra key on an item (`"ready": true`) is dropped
 * inside the crate, before the frame the desktop would read exists. Only the
 * model-authored STRING survives, which is why the marker is a word.
 *
 * ADR 0102 / issue #183 (`StartEnv.host_tools` + a vocabulary-free
 * `HostToolCall`) is the real fix. When it lands, this sentence moves out of the
 * launch message and into a real tool description, and the marker word retires.
 * Full contract: `docs/features/session-ready-marker.md`.
 */

/** The exact word a todo item must carry to mark its Session ready.
 *
 *  Compared as `content.trim().toLowerCase() === READY_MARKER_TEXT`, so this
 *  constant MUST stay lowercase and unspaced or the detector could never match a
 *  real item — pinned in `readyMarker.test.ts` rather than assumed. */
export const READY_MARKER_TEXT = "ready";

/** The sentence that tells a model the convention exists.
 *
 *  **A convention nobody is told about is a convention nobody uses.** Until this
 *  line shipped, nothing in the app mentioned the marker — no tool description
 *  (they are engine-owned and cannot be edited from here), no system prompt, no
 *  column. `docs/features/session-ready-marker.md` recorded that as an open gap;
 *  appending this to the launch message is how the gap closes.
 *
 *  It is appended AFTER the `<task>` block by `lib/taskPrompt.ts`'s
 *  `buildLaunchMessage`, which is deliberately the non-expanding side of the
 *  injection boundary. The string carries no `$` for that reason and
 *  `readyMarker.test.ts` pins that it stays that way.
 *
 *  Every clause is load-bearing, and the tests name which:
 *   - "exactly the single word `ready`" — the detector is EXACT, not substring, so
 *     "mark this ready" would produce an item that never marks anything;
 *   - "mark it completed" — a PENDING `ready` means "still need to make it ready",
 *     the opposite claim, so the detector requires `completed`;
 *   - "no other words in it" — the same exact-match rule, spelled where the model
 *     reads it rather than only in a detector a model never sees. */
export const readyMarkerInstruction =
  `When this task is finished and ready for a human to review, write a todo item whose content is exactly the single word \`${READY_MARKER_TEXT}\` and mark it completed — no other words in that item.`;
