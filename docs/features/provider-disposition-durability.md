---
status: live
last-verified: 2026-11-18
verified-by: >-
  §1-§2 re-measured at the pin bump to engine `v0.4.1` (desktop `feat-consume-turn-disposition`,
  `fulcrum-harness = "0.4.1"`, `Cargo.lock` checksum
  `ba8eb8788f2ef0362006f9c4203bd5ea1d1b908e19a880bad554dd13797e3103`): the cap arm of `normalize.rs` and
  `cap_id()` were read in the engine tree, not quoted from the plan, and the `"cancelled"`-refusal rationale
  was measured by widening `dispositionFromRows` to accept it — exactly one pin reddened and
  `attention.test.ts` / `sessions.test.ts` stayed green, which is what forced that paragraph's rewrite.
  Gate at that bump: `cargo test` **1042 passed / 0 failed / 3 ignored**, `cargo clippy --all-targets`
  0 warnings, `cargo fmt --all -- --check` clean, `pnpm test` **189 files / 4603 passed / 1 skipped**,
  `pnpm build` clean. No test was lost: the diff adds 4 Rust test fns and removes 0, and adds 6 `it()`
  blocks with 1 rename.
  Earlier verification, still the basis for §3-§5: every claim re-measured at the head of
  `feature/provider-disposition-durability` (desktop `3a6ff501`, engine `8741b09` / tag `v0.3.1`)
  rather than copied from the plan that produced it.
  Instruments: `grep -n 'stopReasons:' src/store/sessions.ts` → **three** writers now (`openSession`,
  `resumeSession`, `turnCompleted`) where the research report measured exactly one;
  `grep -n 'export function dispositionFromRows' src/lib/transcript/reducer.ts` → present;
  `npx vitest run src/store/sessions.test.ts -t "SESSION_KEYED_FIELDS"` → green, the field count still 11;
  `grep -n '^fulcrum-harness' src-tauri/Cargo.toml` → `0.3.1`, and `Cargo.lock` carries
  `checksum = "e2b5816b84091c2e49da9e06e07ae4f9882d1ece636a4289e1b05c80ca729289"`, which is the SHA-256 of the
  `.crate` downloaded from `static.crates.io` and grepped for `TRUNCATION_DISPOSITION` **before** it was
  pinned. Gate at the pin bump: `cargo test` **1021 passed / 0 failed** across 40 targets,
  `cargo clippy --all-targets -- -D warnings` 0 warnings, `cargo fmt --all -- --check` clean,
  `pnpm test` **187 files / 4559 passed / 1 skipped**, `pnpm build` clean.
  The RED→GREEN evidence is one unchanged test run twice: `cargo test --test normalize_display_db` on the
  `0.3.0` pin failed `left: None / right: Some("length")` at the `json_extract(payload_json,'$.disposition')`
  assertion with every preceding assertion on that same row (`kind`, `message_key`, `$.text`) passing, and the
  identical test passes on the `0.3.1` pin.
---

# The truncated turn's provider disposition is durable and machine-queryable

**What this records.** A **Truncated turn** (ADR 0108) now leaves a machine-readable trace on the row the
engine *already* persisted, and a reopened Session can rebuild the footer from disk. Before this, the
disposition existed only in an in-memory Zustand map, so `Turn ended: max_tokens` rendered nothing after an
app restart — for every session, truncated or not — and the truncated-turn rate was not queryable at all.

Design decision and full evidence: `docs/research/finish-reason-persistence-placement.md`
(**Placement C**), mirrored to issue #190. The turn-level half of the decision is `ADR 0108`.

## 1. The shape

The engine's `RpcEvent::turn_truncated` frame carries `"disposition": "length"`, and
`compute_display_rows` carries it into the display row **only when present**:

```
kind = 'agent-text'
message_key = '{stamp}:truncate:N'
payload_json = {"text":"Response was truncated before completion","disposition":"length"}
```

A **Capped** turn (issue #193 — the engine's own `MAX_MODEL_ROUNDS_PER_PROMPT` or
`MAX_IDENTICAL_REFUSAL_RUNS` bound, not a provider fact) rides the **same** `agent-text` row kind with a
different value and its **own** unique key, because the shared `{stamp}:system` key APPENDS and a second
notice would weld into the first:

```
kind        = 'agent-text'
message_key = '{stamp}:cap:N'
payload_json = {"text":"The turn was stopped by the agent's own turn limit before it finished.","disposition":"max_turn_requests"}
```

There is deliberately no third row `kind` for it. Both arms are built by hand in the engine's `normalize.rs`,
and both are the easy way to ship this wrong: that `match` ends in `_ => Vec::new()`, so **omitting** an arm
compiles clean, emits nothing, and the disposition never reaches a row while every other test stays green.
`a_capped_turn_emits_one_line_on_its_own_message_id` is the pin that reddens on the cap arm.

Read it with `json_extract(payload_json, '$.disposition')`. The write is conditional **by requirement**: an
unconditional one would add the key to every `agent_message_chunk`, and three existing tests pin exact
payloads (including the byte string `{"text":"Hello"}`).

Pinned end to end by `a_truncated_turn_persists_its_provider_disposition_where_a_client_can_read_it`
(`src-tauri/tests/normalize_display_db.rs`), which drives a real `turn_truncated` through
`normalize` → `compute_display_rows` → `persist_display` → a real `Db` and asserts the **SQL** form, not the
in-memory rows.

## 2. Two vocabularies, mapped at the reader — this is deliberate

| | Spelling | Who owns it |
|---|---|---|
| **Provider disposition** (persisted) | `"length"` — OpenTelemetry `gen_ai.response.finish_reasons` | one **model call** |
| **Turn bound** (persisted) | `"max_turn_requests"` — the client's own word, adopted by the engine | the **turn**, as a durable fact |
| **`StopReason`** (client wire) | `"max_tokens"`, `"max_turn_requests"` | the **turn**, reported to the Client |

`dispositionFromRows` (`src/lib/transcript/reducer.ts`) maps **two** values and refuses everything else:
`"length"` → `"max_tokens"` (a **translation** — the row carries the provider spelling, the client vocabulary
is `StopReason`, and the two layers coined different words for one fact), and `"max_turn_requests"` →
`"max_turn_requests"` (an **identity** mapping — the client invented that word for a limit it owns, so the
engine adopted the client's spelling and there is nothing to translate). That asymmetry is why the two lines
read differently, and why a future reader must not "harmonise" them into one table.

What it still **refuses** is everything else, including `"max_tokens"` itself (the row carries the provider
spelling only) and `"cancelled"` — neither ever appears in a row, so accepting either would mean the reducer
minting a client value the engine never promised. See the `provider disposition` entry in `CONTEXT.md`.
**Do not write `"max_tokens"` into the row**, and do not "unify" the two vocabularies.

⚠ **The refusal is no longer the OS-alert suppressor it was called.** Until issue #193 `attention.ts` gated on
`stopReasons[id] !== "cancelled"`, so a `"cancelled"` that survived `dispositionFromRows` really did silence a
settled alert, and that was the reason on record. The gate is now the whitelist `=== "end_turn"`, under which
**both** paths stay silent — refuse, so the slot is never written, or accept, so it reads `"cancelled"`, which
is still not `"end_turn"`. Measured: widening the reducer to accept `"cancelled"` reddens only its own refusal
pin and leaves `attention.test.ts` and `sessions.test.ts` green. What the refusal buys now is the narrower,
still-real thing — an unrecognized payload value leaves `stopReasons` untouched instead of writing a vocabulary
entry nothing emitted, the same discipline `sessions.ts` applies when it declines to write `undefined` for "no
row found" (§3). The whitelist is also what makes a capped turn raise no alert at all, which is why it shipped
in the same commit as the pin bump rather than as a follow-up.

Each accepted value is a **named constant**, not a serialisation of an enum: the engine mints `"length"` from
`TRUNCATION_DISPOSITION` and `"max_turn_requests"` from `TURN_CAPPED_DISPOSITION` in its `normalize.rs`, so a
rename in Rust cannot silently change the bytes on disk. Neither is derived from `FinishReason` — that enum is
`#[serde(rename_all = "snake_case")]`, so `to_value(FinishReason::ToolCalls)` yields `tool_calls`, **not**
OpenTelemetry's `tool_call`. `TRUNCATION_DISPOSITION`'s emitter is still `turn.rs`' `Length` path alone; a
second emitter must introduce its own value rather than reuse it.

## 3. Hydration: read the page's LAST row, and why

`openSession` and `resumeSession` seed `stopReasons[sessionId]` from the last row of the history page,
**before** the transcript `set(...)` (ADR 0042's seed-first ordering, as the `todos` block beside it does),
and **only when a disposition was found** — never writing `undefined` or `"end_turn"` for "no row", which
would clobber the value `a Flush whose attachment READ fails settles NO turn and keeps the previous stop
reason` protects and would resurrect a stale reason after a clean turn.

Why position and not id: both arms of `messages_page` return **ascending** ids, and the display UPSERT
(`ON CONFLICT(session_id, kind, message_key) DO UPDATE SET payload_json, created_at`) never touches `id`, so
a row re-written after the notice keeps its older id and cannot displace it. A "newest truncate row, compare
ids" rewrite is therefore **equivalent today**, not dead on arrival — the positional contract is pinned by
name anyway (`reads the LAST element by position, not the highest id`) so a switch is deliberate. **The
hazard the last-row rule exists to prevent is dropping the suppression guard**: scanning for *any* row with a
disposition renders the footer for a turn a newer turn has already superseded.

Seeding here **deliberately deviates** from the `todos` / `seedCostFromRow` precedent, which seeds only when
no entry exists. The disposition seeds **unconditionally when one is found**, because after a crash or restart
the row is fresher than the stale map entry. Harmonising it back restores the bug this fixes.

## 4. Known limits — state these, do not "fix" them silently

- **Not retroactive.** Every row written before this ship lacks the key, and correctly so: an absent key is
  indistinguishable from "stopped cleanly" on that population. Any claim about the **historical**
  truncated-turn rate cannot come from this column. Use the ADR 0108 proxy census instead.
- **500-row window.** Hydration reads `INITIAL_HISTORY_PAGE`, so a truncated turn more than 500 rows from the
  tail does not hydrate. `loadOlderHistory` deliberately does not hydrate — the footer belongs to the newest
  turn.
- **A constant, not the raw provider word.** An unrecognised provider value (`content_filter`, `refusal`)
  never reaches this row at all, because `map_finish_reason` folds unknowns to `FinishReason::Stop` before
  the frame is built. Preserving the raw word is the deferred `ChatMessage` card's job (§5).
- **A truncated Subagent turn stays invisible to its parent.** `is_bookkeeping_message_id` answers true for
  `truncate`, which excludes the notice from a child's captured text. Unchanged by this work — own card.
- **`releaseUnseenTranscripts` does not clear `stopReasons`**, so an evicted-then-reopened session keeps its
  in-memory value until hydration overwrites it. Pre-existing; the "row found" guard decides direction.
- **The reasoning-saturation shape is still invisible.** A turn whose thinking saturates the budget and whose
  wire then reports an honest `stop` with zero visible text mints **no notice at all** (ADR 0108's 2026-11-15
  amendment). Nothing here changes that; it is where the remaining user pain is.

## 5. Deferred, with its cost measured — the `ChatMessage.finish_reason` field

The card this came from proposed the field on `ChatMessage` itself. It is **safe and semantically right and
reaches nothing**: `native_messages` has no reader in the UI (resume only), so the field would not make the
footer durable. If it is ever taken up, it carries: `Option<String>` fed from the **raw wire string** (not
the folded enum — there is no `#[serde(other)]` anywhere, so a typed field makes a 5th variant a one-way door
on durable history and breaks resume on an old build); `skip_serializing_if` **not** `skip_serializing`
(`skip_serializing` would silently kill the feature — the value MUST be written to `content_json`); **no
`Default` derive** (`ChatRole` would default to `System`); **97 struct literals** (8 production / 89 test)
that the compiler enumerates for free; engine **0.4.0** + desktop pin bump in lockstep; the
`.cargo/config.toml` patch trap; **3 loud + 3 silently-vacuous** test breaks; and variant B (write only
non-`Stop`/non-`ToolCalls`, ≈125 KB) over variant A (every assistant row, ≈4.5 MB / ≈37 MB per year).

The leak-safety that card depends on is **now pinned**, not emergent: `keys_of_names`
(`src/harness/provider/test_util.rs`) asserts exact key-set equality on every wire message object carrying
`tool_calls`, on all three providers, each falsified by injecting an extra key into its builder.

## 6. Corrections this ship produced

- **The plan claimed no automated test drives `normalize` → `compute_display_rows` → a real `Db`.** False:
  `src-tauri/tests/normalize_display_db.rs` already shipped `temp_db()` + `persist_frames()` doing exactly
  that. The plan's manual DB step was automated instead, and is the RED→GREEN pin described above. A plan's
  "no test exists" claim must be checked against the tree.
- **The plan called the "compare ids" refactor dead on arrival.** It is not — the ascending-id invariant makes
  it equivalent. Corrected in the reducer's doc comment, with the real hazard named in its place.
- **`docs/research/…placement.md` §4 says `stopReasons` has "exactly one writer".** True when measured, now
  **three**. Flagged in that report's own amendment.
- **ADR 0108's 2026-11-15 amendment** (authored by a sibling card, not this one) says *"What is **not**
  persisted is the `StopReason::MaxTokens` disposition … and the provider's finish reason"*. The first half is
  now **false** — the disposition is persisted and read back. The second half (the provider's raw finish
  reason, token counts) remains true. That sentence belongs to the sibling card's uncommitted work; fix it
  there, not by editing around it.

## 7. Follow-up cards this ship deliberately did not take

Recorded here because the plan family is deleted on ship and this file is its durable copy. Each was a
**deliberate** exclusion, not an oversight, and each was verified to be out of this change's blast radius.

1. **A truncated Subagent turn is invisible to its parent.** `is_bookkeeping_message_id` answers true for
   `truncate`, so the notice is excluded from a child's captured text and never reaches the parent as a tool
   result. Whether that is *right* is an open question — the exclusion exists so the harness's own notice is
   not quoted back as if the child said it, but the cost is that a truncated child looks like a clean child
   from above.
2. **The reasoning-saturation shape mints no notice at all.** A turn whose thinking consumes the budget and
   whose wire then reports an honest `stop` with zero visible text is invisible to the disposition, to the
   ADR 0108 Falsifier's query, and to any cap sizing. ADR 0108's amendment measured it live at `xhigh`
   (`reasoning_tokens == completion_tokens`, no visible characters, `finish_reason: "stop"`). This is where
   the remaining user pain is, and it is a **different defect** from truncation.
3. **The per-turn usage/cost object.** ADR 0108's Falsifier cost half needs it; `sessions.cost_usd` is a
   session cumulative and `context_usage_json` is input-side only. Strictly separate change.
4. **`serde_json::to_string(&m).unwrap_or_default()` on the transcript write path** would write a corrupt
   row rather than error if a non-serializable field ever reaches `ChatMessage`. Found while measuring the
   deferred field's blast radius; untouched here.
5. **The `role` column disagrees with `json_extract(content_json,'$.role')` on 50 rows (0.015%)**,
   concentrated in 4 sessions, alternating pairwise. Immaterial to any total, but it makes the denormalized
   `role` column untrustworthy as a census filter — use the JSON key.
6. **The forward truncated-turn rate is now measurable and has not been measured.** §4's limits are the only
   thing standing between `json_extract(payload_json,'$.disposition')` and a real number. Cheap follow-up,
   and the single most valuable missing figure in the whole line of work.
