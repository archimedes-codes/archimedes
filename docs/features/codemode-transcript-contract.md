---
status: live
last-verified: 2026-11-02
verified-by: every claim below re-read against THIS tree at `b4aeec80` — the producer
  (`agent/harness/loop/codemode.rs`: `NestedRow`, `NestedStatus`, `RowBook`, `Bridge::emit_live`,
  `Bridge::drain_after_script`, `ORPHAN_DRAIN`, and the `tests/codemode.rs` frame assertions), the
  pipeline (`agent/normalize.rs`'s `tool_execution_update` / `toolcall_delta` arms, `TurnState`,
  `merge_json`, `compute_display_rows`, and `harness/loop/emit.rs`'s `EmitPipeline::run`), the
  consumer (`src/lib/transcript/reducer.ts`'s `tool_call_update` arm, `src/components/CodemodeCard.tsx`),
  and the two pins on either side of the boundary (`codemode.rs`'s
  `the_nested_row_serializes_the_frozen_element_shape`, `src/components/CodemodeCard.test.tsx`).
  Line numbers are from that commit. **No `cargo` was run for this record** — the Rust tests named
  here are named as the pins that exist, not as tests observed passing.
---

# The `codemode` transcript contract — the nested-call envelope, and why it is keyed the way it is

The shape of a `codemode` card's nested-call rows, and the reason the live frame is keyed on the
**parent** call's id. This file exists because both `src/components/CodemodeCard.tsx` and its test
cited that shape to `docs/roadmap/codemode-status.md`, and `docs/roadmap/` is gitignored
(`.gitignore:31`) and deleted on ship — an authoritative citation pointing at a file that will not
exist. AGENTS.md's Docs rule is what moves it here: a durable fact belongs in `docs/features/`, not
in a comment that quotes a plan.

Read this before changing what a `tool_execution_update` frame carries, before "simplifying" the
frame key, and before adding a second place the nested calls are read from.

## 1. The element shape: seven camelCase keys, pinned on BOTH sides

Each nested-call row inside `details.calls` is one object with **exactly** these keys, camelCase:

```json
{ "toolCallId": "<parentCallId>/<n>",
  "toolName": "read",
  "args": { },
  "status": "running | ok | error | denied",
  "text": "",
  "isError": false,
  "details": { } }
```

`status` is one of four strings — `running` / `ok` / `error` / `denied` — serialized by
`NestedStatus`'s `#[serde(rename_all = "lowercase")]` (`codemode.rs:126`). `denied` means the
policy **gate** refused the call; `error` means an executor's own failure. Both arrive as
`is_error: true` on the `ToolResult`, so the distinction is a parameter (`NestedRow::settle`'s
`denied: bool`, `codemode.rs:183`), never an inference — and `CodemodeCard`'s `rowStatus` maps
`denied` to a failed glyph alongside `error`.

The element is a **type** (`NestedRow`, `codemode.rs:146`, `#[serde(rename_all = "camelCase")]`)
rather than a `json!` literal precisely so a key cannot drift from the contract silently. And the
contract is pinned **twice**, on opposite sides of the process boundary:

- **Rust:** `the_nested_row_serializes_the_frozen_element_shape`
  (`src-tauri/src/agent/harness/loop/tests/codemode.rs`, in the `#[cfg(test)] mod tests` of
  `agent/harness/loop/codemode.rs`) asserts each of the seven keys AND asserts the sorted key list
  is exactly those seven — "exactly the seven frozen keys, no more".
- **TypeScript:** the `NestedCall` type + the `nested()` fixture in
  `src/components/CodemodeCard.test.tsx`, whose `parentResult()` / `liveResult()` builders are the
  two envelope shapes the card is tested against.

**A change to the element shape must move both pins in the same commit.** One-sided change is
invisible to CI on the other side: the Rust test cannot see the TS fixture, and the TS test is not
type-checked against the Rust type.

## 2. Frame keying is the PARENT call id — the load-bearing rule

A live `tool_execution_update` frame's `tool_call_id` is **always the parent `codemode` call's id**
(`Bridge::emit_live`, `codemode.rs:1055`, which passes `self.parent_call_id`). The nested id
`<parentCallId>/<n>` appears in exactly two places and never as a frame key:

- as an element's `toolCallId` inside `details.calls`, and
- as the synthesized `ToolCall`'s `id` (`Bridge::run_nested`, which builds
  `ToolCall { id: starting.tool_call_id, … }`) — and that id **is** the policy gate's `requestId`,
  which is what lets a nested row and its permission prompt be correlated. `tests/codemode.rs`
  pins that equality (`a_nested_ask_prompts_on_the_nested_request_id_and_a_reject_denies_it`, and
  the `c1/0` assertion in `a_nested_ask_raced_by_a_stop_ends_the_script_and_keeps_the_row_running`).

**Why the key cannot be the nested id.** Three facts about the pipeline compose into the hazard:

1. `normalize.rs`'s `tool_execution_update` arm (`normalize.rs:399`) forwards `tool_call_id` +
   `partial_result` straight into a `tool_call_update` frame. It has **no announced-id guard** —
   unlike the `toolcall_delta` arm (`normalize.rs:273`), which returns NO frame for an id absent
   from `TurnState::announced_tool_calls` (the field at `normalize.rs:72`) precisely because, as the
   doc comment on those `TurnState` fields (`normalize.rs:60-66`) says, "a `tool_call_update` for an id the frontend never saw would
   create a message with `title = toolCallId`", and a following announce frame would append a
   duplicate row.
2. `compute_display_rows`' `tool_call_update` arm (`normalize.rs:767`) keys the display row on
   `toolCallId` and **mints a row for a first-seen key** (`is_new` → a fresh `tool-call`
   `DisplayRow`, upserted by `Store::persist_display`).
3. The frontend reducer matches `m.id === update.toolCallId` (`src/lib/transcript/reducer.ts:188`)
   and, on a miss, **creates a new tool-call message** — with `title: update.title ??
   update.toolCallId`, so an unannounced id renders its raw id as its title.

So a frame keyed on a nested id would spawn a **stray top-level transcript row for every nested
call** — a script making five calls would put five unnamed rows beside its one `codemode` card, in
the same transcript, at the same level as it. That is the exact hazard `normalize.rs` documents at
its `TurnState` fields; the parent-keyed frame instead folds into the row the parent's own
`tool_execution_start` already announced, which is why the card is props-driven and needs no reducer
edit and no new linkage. `tests/codemode.rs` asserts the negative half directly: no frame's
`toolCallId` may equal a nested id.

This is the part a later reader is most likely to "simplify" — keying a live frame on the id of the
call it describes reads as the obvious design, and it is the one design the pipeline cannot carry.

## 3. `partial_result` is the parent's `ToolResult`, serialized

`emit_live` builds a real `ToolResult` (`tools/types.rs:42`, `#[serde(rename_all = "camelCase")]` →
`{ content, details, isError }`) and hands `serde_json::to_value` of it to the sink. So the live
frame and the final `tool_execution_end` result are the **same type, the same key, the same shape**:
both write `rawOutput = { content, details: { calls }, isError }`.

That matters because `merge_json` (`normalize.rs:162`) is a **shallow top-level key overwrite** —
non-null fields of the patch win, no recursive merge — so `rawOutput` as a whole is replaced, and
live and final land on ONE place: `rawOutput.details.calls`. The card reads exactly that key.

A bare `{calls}` envelope would have written a DIFFERENT top-level key, leaving a second source
(`rawOutput.calls` live, `rawOutput.details.calls` final) and forcing every reader to check both.
That is not a hypothetical the design merely avoids: `CodemodeCard.test.tsx` asserts it, listing
`{ calls: [nested({})] }` among the malformed shapes and expecting **zero rows** — a
`{calls}`-shaped `rawOutput` is not a shape any producer writes. The card's defensive reads exist
for malformed/foreign data, not for a second key.

## 4. Row order is COMPLETION order, not start order

`RowBook` (`codemode.rs:236`) keeps TWO lists — `settled` and `running` — and the snapshot every
live frame and the final result carry is `settled ++ running` (`RowBook::snapshot`,
`codemode.rs:260`). A row lives in `running` while its call is in flight and moves to the TAIL of
`settled` when it finishes. Two consequences:

- rows appear in the card **as they finish**, while `Promise.all` in the script still resolves in
  ISSUE order — the two orders are allowed to differ, and `Promise.all`'s own result array is not
  what the transcript lists;
- a row that is still running is present (as `status: "running"`) rather than absent, because a
  live snapshot without it could not show a row while its tool runs.

The frontend's reconciliation is what makes the move invisible: rows are keyed by `toolCallId` with
last-writer-wins, so a row sliding from the tail into its completion slot updates in place instead
of appending a duplicate. Pinned by `the_snapshot_holds_settled_rows_then_the_ones_in_flight`
(`codemode.rs`) and by the in-place-update and repeat-id tests in `CodemodeCard.test.tsx`.

## 5. The fire-without-awaiting window

A script that starts a call and never awaits it (`tools.bash(…)` with no `await`) still gets a row.
When the script's own future resolves, `Bridge::drain_after_script` (`codemode.rs:868`) drains the
request channel and STARTS whatever arrived, then keeps polling the calls already in flight — for a
bounded window:

- **`ORPHAN_DRAIN`** (`codemode.rs:95`) — 30 seconds — after which the drain stops waiting.

The bound is deliberate: a wedged executor must not hold the turn, because the direct route
abandons a tool that outlived its model call rather than waiting for it forever. A call the drain
does not finish keeps `status: "running"`, which is the contract's word for "it started and did not
complete"; its JS promise is answered by the dropped-sender fallback, to a script that by then no
longer exists.

## 6. Accepted limit of v1: `details.calls` is bounded only by the wall clock

**Recorded, not fixed.** Nothing caps the LENGTH of the `details.calls` array. The only thing that
stops a script making nested calls is the script ending — and the only thing that stops the script
is `WALL_CLOCK` (`codemode.rs:82`, 300 seconds) or a Stop. So a script that loops over a few
thousand nested calls grows, without bound:

- the snapshot re-serialized into EVERY live frame (each frame carries the whole array, so the
  frame count and each frame's size both grow with the call count), and
- the payload of the ONE persisted `tool-call` display row, which is re-upserted in full on every
  frame (`compute_display_rows` → `Store::persist_display` → `Db::record_message`'s
  `ON CONFLICT … DO UPDATE SET payload_json = excluded.payload_json`).

An explicit cap is deliberately NOT in v1: the honest options (truncate the array, or spill the
rows somewhere the card cannot read them) each change the contract above, and no real workload has
asked for either. Treat this as an accepted limit, and treat "how many rows can a card hold" as an
open question rather than a solved one.

## 7. Per-row sizes ARE bounded — inherited from the tools, not added here

The absence above is about the ARRAY, not its elements. Each row's `text` is the joined text blocks
of one real `ToolResult`, so a row can be no larger than the tool that produced it was ever allowed
to be: `bash` output is capped at `MAX_OUTPUT_BYTES` (100 KiB, `agent/tools/exec/bash.rs:27`,
overflow drained and flagged `truncated: true`) and `read` is capped at `MAX_READ_LINES` (2000
lines, `agent/tools/exec/fs_tools.rs:10`). `details` is the tool's own `details`. So per-row size
inherits the upstream bound while the array length inherits no bound at all — which is exactly why
§6 is about the count and not the content.
