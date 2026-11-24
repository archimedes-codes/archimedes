---
status: live
last-verified: 2026-11-19
verified-by: >-
  Folded from `docs/roadmap/honest-turn-outcome-surfaces.md` and its `-follow-ups.md` (both gitignored,
  neither ever committed — this file is the follow-ups' only durable copy; the plan survives separately as
  a Task-card `plan` artifact on card `tsk_076eb5dd-4ed8-45e7-91ba-1747092deb7d`) at the close of the run
  that shipped engine PR archimedes-codes/fulcrum#33 (`f5cae54`, tag `v0.5.0`, commit `3d7dfb6`, published
  to crates.io) and desktop PR #210 (`1849e53b`, `fulcrum-harness = "0.5.0"`).
  Every claim below was re-measured on the shipped trees, not copied from the plan. Engine at `v0.5.0`:
  `cargo test` **1803 passed / 0 failed / 3 ignored** (baseline before the change was 1603 / 0), clippy
  `--all-targets -- -D warnings` 0 warnings, `cargo fmt --all -- --check` clean, `check-versions.sh`
  agreeing, `PROTOCOL_VERSION` still 1, CI green on ubuntu/windows/macos, and the published `.crate`
  verified by extracting it OUTSIDE any repo (`/home/daniel/publish-verify`, confirmed
  `fatal: not a git repository`) → **1616 passed / 0 failed** (lib 1610 + 6 across five further suites),
  with the shipped manifest carrying no `[workspace]`/`members` and no `fn system_chunk`, and 2 `notice_id`s.
  Desktop at #210: `cargo test` 40 suites ok, `cargo clippy --all-targets` 0 warnings, fmt clean,
  `pnpm test` **189 files / 4606 passed / 1 skipped** (baseline 4603 + 3 new), `pnpm build` clean, CI green
  on ubuntu/windows/macos, `check-file-size.sh` pass (312 files, largest `db.rs` 2154).
  Two findings that changed the ship came from a pre-publish review and BOTH were re-derived before acting:
  the semver level (the reviewer was right, the orchestrator's patch claim was wrong) and a test name the
  orchestrator supplied that does not exist (the implementer was right, the brief was wrong — the real pin
  is `a_later_overflow_in_the_same_turn_gets_its_own_compact_and_retry`).
---

# Honest turn-outcome surfaces — known gaps

Accepted, unfixed defects and deliberately-unbuilt scope in the line of work that makes a **turn's
outcome** readable: the `{stamp}:notice:N` id family that stops harness one-liners welding into one
bubble, the emission order that keeps the truncation notice the newest display row of its turn, and the
`end_turn` whitelist behind the OS alert. Card `tsk_076eb5dd`, issue #190.

## 1. What shipped, so the gaps below have a floor

- **`{stamp}:notice:N`** — one shared counter (`TurnState::notice_seq` + `notice_id()`) for every harness
  one-liner: `auto_retry_start`, BOTH arms of `auto_retry_end`, and `extension_error`. One counter rather
  than one per arm, because the pair that must never weld is `Retrying (attempt N/M…)` followed by
  `Retry failed`, and those come from two different arms. `system_chunk` was **deleted**, so no writer of
  `{stamp}:system` remains. Measured before the fix: **103 of 104** real `:system` rows carried ≥2 welded
  one-liners (`"Retrying (attempt 2/5…)Retry succeededRetrying (attempt 3/5…)…Retry failed"`), because
  same-`messageId` `agent_message_chunk`s are appended with **no separator**.
- **`is_bookkeeping_message_id` is now `system / retract / truncate / cap / notice`.** `notice` had to
  arrive in the same commit as the id family: its only production consumer is
  `SubagentCapture::observe_sink_frame`, which skips a delta *and* refuses to set `last_message_id`, and
  `captured_text()` returns the text of `last_message_id` — an unregistered family would hand
  `"Retrying (attempt 2/5…)"` to a parent as its child's entire answer. `system` is **deliberately kept**
  although nothing writes it: rows older Workers wrote are on disk, and a peer on an older crate can still
  send the key. Pinned by `a_notice_line_is_not_captured_as_child_output`, which feeds the **stamped**
  family — the pre-existing guard hand-wrote `"system"` and would have kept passing while production broke.
- **`turn_truncated` emits after the retired-report `auto_retry_end`**, still before `turn_end` /
  `agent_settled`. See §2.
- **`retry.rs` docblocks corrected** — see §3.
- **The alert is an `end_turn` whitelist**, not a `!== "cancelled"` blacklist, so a `max_tokens` or
  `max_turn_requests` turn no longer announces itself as "finished — waiting for you". Landed separately
  under issue #193; this run verified it rather than building it.
- **The nameless tool-call drop is logged** in all three wires via `tool_call_dropped_with_no_name()`, with
  `a_healthy_tool_call_turn_records_no_drop_line` guarding the Responses `done` de-dup arm from being
  instrumented. Also already landed; verified here.

## 2. The positional footer read — the one way this can be shipped wrong

`dispositionFromRows` reads the disposition off the page's **last row only**. That was safe *because* an
`auto_retry_end` one-liner was an UPSERT on `{stamp}:system`, and `ON CONFLICT … DO UPDATE` sets
`payload_json`/`created_at` but **never `id`** — so a re-written older row never outranked the notice.

Giving the retry lines fresh ids turns them into **INSERTs**, which would outrank the notice and make the
truncated-turn footer silently disappear after a restart — on exactly the sessions most likely to be
truncated. The fix was to reorder the emit, not to widen the read: the four suppression pins
(`looks ONLY at the last row…`, `suppresses when a NEW row is inserted after the notice`, `reads the LAST
element by position, not the highest id`, `reads a re-written (upserted) older tool row as NO suppression`)
forbid the scan-back, and its docblock says so.

**The gap: nothing mechanically links the two repos.** The engine pins the order by display-row position
(`a_truncated_turn_emits_the_notice_after_the_retry_close_and_before_the_settle`, which asserts on
`MemoryStore::display_rows()` rather than on event kinds, because an event-kind assert is a *proxy* — it
stayed green when a synthetic post-notice one-liner was injected). The desktop pins the consequence. **A
reorder in fulcrum's `harness/loop/turn.rs` still reddens nothing in this repo.** The desktop test writes
the reordered arm explicitly (same two rows, one-liner last, must read as *no* disposition) and names the
engine file in its comment. That is documentation, not a guard. A cross-repo pin is the real fix and nobody
has built one.

**If §2's engine half is ever reverted or reordered without the desktop pin, neither repo's suite reddens.**

## 3. `turn_capped` does not retire a pending retry report

`retire_pending_report()` has exactly **one** production call site — `handle_truncated_turn`. The turn-cap
route (`loop.rs`, `self.emit(RpcEvent::turn_capped)` then `settle_error`) has no such call, so a turn that
retried and then hit its own turn bound leaves the report outstanding, and the **next** prompt's
`note_success()` emits `auto_retry_end { success: true }` — a "Retry succeeded" line for a turn that never
retried. Same bug class #190 closed for the `Length` route.

Left deliberately: `retire_pending_report`'s own docblock declares its scope narrow ("the cancel settles and
the mid-stream-error settle reach the same pending-report state and are NOT changed here"), and
`docs/features/abandoned-tool-rows.md` §11 row 10 records the cap route as "mechanism, **NOT measured**".
The fix is one `if let Some(attempt) = …` in the cap guard, but it changes an event stream existing tests
pin. **Note the severity moved:** since §1, that stale success line lands on its own `{stamp}:notice:N` id,
so it is now a separate visible bubble rather than text welded onto a neighbour — the unwelding made it
more visible, not more common.

## 4. The retry budget is the Worker's, and the exhaustion is untested

`attempt` moves only by `+= 1` in `next_retry_delay` and `.max(1)` in `note_success` and at the top of
`call_with_retry`. There is **no reset at any turn boundary**, and `RetryPolicy` is built once per
`AgentLoop` (`worker/core.rs`), so the budget is four retries for the **Worker's** life, shared with the
transport-error ladder. After four unrelated retries, a later turn whose reply comes back empty gets no
retry at all.

- **Untested**, and the reason is named in the docblock:
  `an_empty_turn_shares_the_retry_budget_with_the_ladder` calls `handle_prompt` **once**, so it pins the
  per-turn *ceiling* and cannot distinguish that from a per-turn reset.
- The docblock states the behaviour and **declines to call it a defect or intended** — that question belongs
  on the engine's tracker.
- **A truncated turn is never re-issued either, but for an unrelated reason**: `handle_truncated_turn`
  returns `TurnFlow::Return` unconditionally and never reaches `next_retry_delay` (ADR 0108 Decision 1).
  Do not attribute that to budget exhaustion.
- **The budget governs only RETRIED calls.** A compaction summary calls `ctx.provider.complete` directly
  and bypasses `call_with_retry` entirely, so a prompt's *total* provider-call count can exceed
  `max_attempts` — pinned at **6 calls with `max_attempts = 5`** by
  `a_later_overflow_in_the_same_turn_gets_its_own_compact_and_retry`.
- `turn.rs`'s "no second counter exists for a reason" is **TRUE** and must not be "fixed" alongside the
  sentences above; it reads like the same error and is not.

## 5. Other accepted gaps

1. **The `terminated` gate swallows the Responses drop log.** `response.incomplete` sets
   `terminated = true` **before** `Done(Length)`, so the stream-end `flush_tool_calls` never runs on an
   `incomplete` + partially-streamed `function_call`, and a log inside it cannot cover that route. Not
   restructured: issue #193 exists to establish which OpenAI-shaped wire is live first.
2. **`end_turn` is invented on IPC failure.** `useChatPromptDispatch`, `usePromptQueueFlusher` and
   `taskLaunch` each write `turnCompleted(id, "end_turn")` in a `catch`, so a rejected send claims a normal
   finish. The whitelist cannot catch it — the value genuinely *is* `end_turn`. It needs those three call
   sites to stop inventing a reason.
3. **No end-to-end proof from a live provider to the footer.** The proof is the router unit test plus the
   pins in §2.
4. **`max_turn_requests` has no *round* construction site any more, and its one producer is live.**
   The engine's per-prompt round bound was deleted in `fulcrum-harness 0.5.1` (ADR 0116); the sole
   producer of `turn_capped` is now the identical-refusal run, which the desktop maps in
   `router.rs::resolve_turn`. So the `attention.ts` `=== "end_turn"` whitelist is **load-bearing**, not
   free: it is the only thing between a refusal-capped turn and a "finished — waiting for you"
   announcement. An earlier version of this gap said the value had *zero* Rust construction sites and
   that the whitelist therefore failed closed for free — that was already false (the router is its
   first construction site) and is doubly false now.
5. **`auto_retry_end`'s `final_error` is write-only in both repos** — 0 readers in `src/`, and `normalize`'s
   `{ success, .. }` arm discards it before a frame is built. Surfacing the real retry reason needs a
   renderer decision.
6. **`unique_system_chunk` is now a misleading name** — its sibling `system_chunk` is deleted, so "unique"
   distinguishes it from nothing, and it is used only by the retraction line.
7. **`AgentLoop::text_acc` is never cleared.** One-liners used to share one key (one entry, one upserted
   row); each now mints a unique id, so entries and rows grow with session length. The row growth is the
   intended unwelding; the `text_acc` growth is incidental.
8. **fulcrum's `normalize.rs` holds four subjects** — `TurnState` plus four id minters, the bookkeeping
   predicate, and two large inline test modules: 1,939 whole-file code lines but only **549 production**.
   Fulcrum has **no file-size ratchet**: `scripts/check-file-size.sh` exists only in this repo and its walk
   (`git ls-files -- src-tauri/src src-tauri/tests src`) never sees fulcrum's `src/`. A look-at signal, not
   a defect.
9. **Auto-failover can now route a failing free provider INTO Keenable, which is metered, and the user
   sees no signal that it cost anything.** Recorded here because it is the same class as the gaps above —
   an outcome the user is entitled to read that the surfaces do not render — and because no
   `docs/features/` file covers the Search providers or the Settings → **Web search** section at all, so
   there is no closer home for it (see the note under this list).

   **The behaviour.** `AVAILABILITY_ORDER` (`fulcrum-harness` 0.7.0 `web/providers/registry.rs:16`) is
   `["brave","tavily","perplexity","searxng","keenable","duckduckgo"]`, and the auto-failover arm takes
   `AVAILABILITY_ORDER[current_idx + 1..]` and picks the first provider whose `is_available` holds
   (`registry.rs:162-172`). Keenable sits at **index 4**, immediately after all four keyed providers and
   immediately before the keyless DuckDuckGo. So for a user holding **brave + keenable**, a brave `429`
   (or `402`/`500`) now fails over **into Keenable** — a per-credit paid API — where the same failure
   previously dropped straight to free DuckDuckGo. Identically for **tavily + keenable**, **perplexity +
   keenable** and **searxng + keenable**. The other half of the change was intended: a user holding
   **only** a Keenable key now auto-resolves to Keenable rather than to DuckDuckGo.

   **Who it affects, precisely.** Only the `auto` path. Failover is gated on `was_auto_resolved`
   (`registry.rs:158`), and `resolve_provider_from` sets that flag **only** on the `AVAILABILITY_ORDER`
   walk (`:87`); an explicit `web.defaultProvider` — or a `provider` argument on the tool call — returns
   `was_auto_resolved: false` (`:64`, `:75`) and its errors propagate without failover. So the exposed
   population is a user with a Keenable key **plus** any one of the four keyed providers, left on the
   default `auto`. That is the ordinary configuration, not an exotic one.

   **Why it matters — this is metered spend.** `docs/research/keenable-as-a-search-provider.md` establishes
   that Keenable keys are **entirely unscoped with no per-key spend cap**, that Stripe auto top-up defaults
   to a **$1,000/month** ceiling on accounts that can hold a card, and that `credits_remaining` is never
   surfaced — measured: `grep -rn credits_remaining src/ src-tauri/src` returns **0** hits, and the crate
   carries no such field either. A brave rate-limit is ordinary and expected, and it used to be free. It
   now spends the user's money. The engine does report which provider answered, in the tool result's
   `details.provider` (`web/tools.rs:176`, `:185`), but nothing in `src/` reads that field, so no surface
   renders it: the spend is silent in the UI.

   **This is deliberate-by-omission, not discovered-late.** The position was an approved decision —
   research recommendation #1, `AVAILABILITY_ORDER` **position 5** — and the desktop shipped it as
   approved. What was never accounted for is the forward edge into Keenable from the four providers above
   it; the research argued only about Keenable's own forward edge (see below).

   **The fix is a crate release, so it is out of the desktop's reach.** The right shape is a per-provider
   attribute on the `SearchProvider` trait — an "is this paid / may failover enter it" flag the failover
   arm consults, so a metered provider can be auto-resolved as a *first* choice but never *fallen into*.
   That closes the **identical** existing edge for **tavily** and **perplexity**, both keyed and both
   metered, which today can also be fallen into from a provider ahead of them; Keenable merely made the
   edge cheap enough to notice. `AVAILABILITY_ORDER` is `pub` in the crate and its position was an
   approved decision, so this is not a desktop-side edit and was not attempted here.

   **Cross-reference — the research doc's line-337 claim is narrower than it reads.** That document's
   `AVAILABILITY_ORDER` decision argues position 5 is safe because it keeps failover "keyed-before-keyless
   so a Keenable `429`/`402` degrades to DDG rather than to another **paid** provider". True, and it argues
   **only** Keenable's own forward edge. It implies neutrality it does not establish, and it implies both
   directions of the edge while analyzing one. The dated correction block at the top of that file now says
   so; read that block, not the dated body sentence, for the shipped state.

   *Why this paragraph lives here:* the natural home would be a `docs/features/web-search-known-gaps.md`,
   and inventing a one-paragraph file was ruled out. Of what exists, this file is the only known-gaps page
   whose subject is **whether a user can read what actually happened to them**, and item 5 above is the
   same shape — a fact the engine produces with no reader in the UI. Note the naming rule while reading
   this: **Search provider** is not **provider**; the gap above is about Search providers and belongs to
   neither `litellm-provider-connections.md` nor ADR 0014, which own the model-endpoint sense of the word.
   If a real Web-search page is ever opened, move this item there.

## 6. The word-set is hand-mirrored across repos and has already drifted

`is_bookkeeping_message_id`'s word list lives in the **engine** and is copied by hand into ADR 0049's
Consequences and its amendments. The 2026-11-15 amendment said `system / retract / truncate`; `cap` then
landed **with no amendment**, so that text was stale twice over before `notice` arrived. ADR 0049's
2026-11-19 amendment records the drift rather than tidying it away. **Do not trust what the ADR says the
set is** — run `grep -n 'field == "notice"' src/normalize.rs` in the fulcrum tree and read what the engine
does. No CI in either repo verifies this.

## 7. Semver: why a `pub` field forced a minor, twice now

`TurnState` is a plain `pub struct`, every field `pub`, **no `#[non_exhaustive]`**. Adding a field breaks
any consumer that builds it with a struct literal, which is breaking under 0.x semver. That no literal
construction exists today (`src-tauri/tests/normalize_display_db.rs` uses `TurnState::stamped(..)`) is
evidence about **one consumer**, not an API guarantee.

The load-bearing half is the pin range: the desktop declared `fulcrum-harness = "0.4.2"` = `^0.4.2`, so a
published `0.4.3` would sit **inside** that range and any re-resolve — a bare `cargo update`, a lock
refresh, a CI run whose lock stopped matching — could pull the changed crate in before this repo's
`normalize_display_db` update landed. `0.5.0` sits outside `^0.4.2`, so the desktop stayed on 0.4.2 until
PR #210 moved the pin deliberately. This is the same reasoning `fd4dd9c` recorded for the `ToolCtx` field;
the version number is doing compatibility work, not decoration.
