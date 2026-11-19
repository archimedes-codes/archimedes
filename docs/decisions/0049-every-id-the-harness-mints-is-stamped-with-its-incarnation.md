---
status: accepted
date: 2026-10-14
superseded-by:
---

# Every id the harness mints is stamped with its incarnation

A **Session** outlives its **Worker**: a **Stalled session** is resumed by a fresh Worker whose `TurnState` is fresh, so `msg_counter` and `retract_seq` start at 0 again and the resumed session's first reply is `m1` — the id its first Worker already used. The display store UPSERTs on `UNIQUE(session_id, kind, message_key)`, so the new incarnation silently overwrites the old one's rows, and ADR 0048's Retraction, which erases BY `messageId`, can then erase history that is not its own. It is worse than a counter problem: `agent-text` rows are also keyed by the fixed `"system"` and `"default"` ids, so a resumed Worker's first system line UPSERTs over the previous Worker's and destroys it with no counter involved at all. We decided to give each **incarnation** its own id space — the **Supervisor** mints a short opaque token per `Start` envelope (`StartEnv.incarnation`) and `normalize`, the ONLY place a `messageId` is ever put on a frame, stamps every id it mints with it — so two incarnations of one Session cannot write the same harness-minted display row by construction (the one display-key family no stamp of ours scopes is `tool-call`, keyed by the provider's own id — §7 of the follow-ups).

## Consequences

- **Five id families, one rule.** `m{n}`, `m{n}#{seg}`, `retract:{n}` and the constants `system` / `default` all carry the stamp (`a3f9c1:m1`, `a3f9c1:m1#2`, `a3f9c1:retract:1`, `a3f9c1:system`). `compute_display_rows` reads ids off the frames rather than minting them, so every display key inherits the stamp **from the frame that carried it**, and a Retraction can only ever name ids carrying its own stamp — as long as the frame carried a `messageId`, which every frame that lands an `agent-text` / `agent-thought` row does (`normalize` stamps the `agent_message_chunk` / `agent_thought_chunk` / retraction frames it mints). The frames that carry no `messageId` — `tool_call*`, `session_info_update`, `config_option_update`, `compaction_update` — key on something else or produce no row; and `tool_call*` is the family that DOES land a display row (`tool-call`, keyed by the provider's `toolCallId`) while owing us no id to stamp, so it sits outside this ADR's reach by construction — recorded as §7 of `compaction-recovery-hardening-follow-ups.md`. **One residue among the keys this change stamps, recorded rather than fixed:** the no-`messageId` fallback key `default` stays BARE on both sides — `compute_display_rows`'s `.unwrap_or("default")` and the Client's `update.messageId ?? "default"`. It is reachable only from a frame carrying no `messageId` at all where one was expected, which the harness never emits, and it stays deliberately bare on both sides: the Worker's stamp never crosses to the Client (the one frame in the stream that could carry it is `session_info_update`, whose production shape is the title alone — the `incarnation` field the two-incarnation test reads is a `fake_worker` fixture addition, not a wire promise), so stamping only the persisted side would desync a row from its own live row — the worse failure.
- **The stamp's width is six lowercase hex chars** (`types::mint_incarnation` — 16.7M values). Stamps only have to differ WITHIN a Session, because everything downstream (`messages`, `native_messages`, the store's maps, the React keys) is namespaced by `session_id`, so ~100 resumes of one Session collide with probability ≈3×10⁻⁴. A collision that improbable, scoped to one Session, costs a merged transcript rather than corrupting another Session's — which is the budget this width buys; a longer token buys more safety no reader can spend.
- **One stamp per `Start` envelope** is the invariant, minted where the envelope is built (both production sites: a main session's start/resume and a **Subagent session**'s dispatch). `worker/core.rs` tolerates a second `Start` replacing the loop on a live Worker — test-only today, since a real resume always spawns a new process through `WorkerManager::attach` — and such an envelope MUST carry a fresh stamp, or the collision returns. We recorded the invariant rather than building a mechanism to police a path that should not exist.
- **No migration, and stored data cannot collide.** Rows written before this change keep their bare `m1` / `system` keys forever, and a bare key can never equal a stamped one. A Session that straddles the change mixes both shapes in one transcript and needs nothing from us, because nothing parses an id.
- **The one structural reader got a shape change.** `is_bookkeeping_message_id` decides which ids are harness bookkeeping rather than model output — the predicate that stops a discard line being handed to a parent model as its child's answer. It does NOT read a fixed position in the id: it matches the bookkeeping WORD across the id's colon fields (`id.split(':').any(|field| field == "system" || field == "retract")`) — a stamp is six hex chars and can never *be* one of those words — so both the bare shape and the stamped shape read as bookkeeping. It stays in ONE place, with a negative pin that a stamped real reply is still capturable. **Amends ADR 0048's id names:** `system` → `{stamp}:system`, `retract:N` → `{stamp}:retract:N`; the bare names stay ACCEPTED because they are the shape an UNSTAMPED writer produces — the test fixtures that hand-write these ids, and `TurnState::default()`, whose EMPTY stamp mints `:system` / `:retract:1` (ADR 0048 is merged and append-only, so it is not edited). Nothing on this path re-reads a transcript: the predicate's only caller, `SubagentCapture::observe_sink_frame`, reads LIVE frames off the Worker's stdout and never touches the `messages` table, so the bare shape is accepted for an id carrying NO stamp — not for a row some pre-change transcript persisted and someone later replays.
- **A resumed transcript keeps what the previous incarnation said.** Where a resumed Worker used to overwrite the old system line, the two now sit in the transcript as separate rows. That is the fix, not a regression to tidy up.
- **Ids never enter the model's history.** `native_messages` keys on `seq` and a `ChatMessage` carries no id, so the stamp is a display/protocol concern only; compaction, retries and the provider prompt are untouched by it.
- **Everything downstream carries ids opaquely.** `mergeDedupeKey`, `rowToMessages`, the live store's `message_retracted` filter and React keys (index-based, not id-based) need no change. The Client's own `client:N` transcript lines are a separate, unpersisted namespace and stay bare.
- **Fresh sessions are stamped too**, and so are **Subagent sessions** (which never resume): one id shape for a whole transcript beats two shapes at a lifetime boundary.

## Considered Options

- **Seed the counters at start** — the **Supervisor** reads the highest persisted `m{n}` / `retract:{n}` / thought segment for the session and the new `TurnState` resumes numbering from it. Rejected: it needs a query over a TEXT column (`MAX(message_key)` is lexicographic, so `m10 < m2`) parsing three key families, couples session-start to the display table that the resume path deliberately never reads, and leaves `system` and `default` colliding — because neither is a counter. Its only real advantage is that ~40 existing id assertions keep their exact values, which is not the expensive part of this change.
- **Let the loop mint its own token** at construction — no protocol change at all, and the boundary is auto-correct. Rejected: every id assertion in the suite (`"m1"`, `"m1#1"`, `"retract:2"`) degrades from an exact value to a prefix matcher — and the reason this defect shipped is that no assertion was strong enough to span two Workers — while the Worker would decide for itself the one fact the start envelope exists to tell it.
- **Stamp only the counter-derived ids** and leave the constants bare — smallest diff, half the fix, and the half it leaves is the one with no counter to seed.

## Amendment (2026-11-15) — `truncate` joins the bookkeeping word-set (issue #190, ADR 0108 amended)

The id families this ADR stamps gained a third bookkeeping counter: `{stamp}:truncate:N`, the notice a
**Truncated turn** writes about its own turn (ADR 0108's 2026-11-15 amendment). So
`is_bookkeeping_message_id`'s word-set is now `system` / `retract` / **`truncate`** —
`id.split(':').any(|f| f == "system" || f == "retract" || f == "truncate")`. The word-set-not-position
rule is what makes this a one-token change: it still accepts the bare shape (a test fixture's
`truncate:0`, or `TurnState::default()`'s EMPTY stamp), and the hex-alphabet argument still holds —
`truncate` is eight chars and carries `r`/`u`/`n`, so a six-hex stamp can never equal it. The consequence
that matters is the one this ADR already established: without the word in the set, the **Subagent
capture** hands a parent model its child's harness-written sentence as if the child had said it.
Re-run: `grep -n 'field == "truncate"' <fulcrum-harness>/src/normalize.rs`.

## Amendment (2026-11-19) — `cap` and `notice` join the word-set; `system` is kept although nothing writes it (fulcrum PR #33)

The word-set this ADR's `is_bookkeeping_message_id` consequence describes has moved twice since the
2026-11-15 amendment above, and that amendment's own text — `system` / `retract` / `truncate` — is
therefore **stale**. It is now five words:

```
system / retract / truncate / cap / notice
```

Engine-side, that is `id.split(':').any(|f| f == "system" || f == "retract" || f == "truncate" ||
f == "cap" || f == "notice")`. Two words arrived, and only one of them was recorded here:

- **`cap`** — `{stamp}:cap:N`, the notice an **agent's own turn limit** writes (`normalize.rs`'s
  `cap_id()`, issue #193). It landed **without an amendment to this file**. That is the point worth
  keeping rather than tidying away: the discipline this section is written in — *the word list lives
  in the engine and is hand-mirrored here* — **has already drifted once**. A reader of the
  2026-11-15 amendment would have concluded a three-word set and been wrong. So do not trust what
  this ADR says the set is; run the recipe below and read what the engine actually does.
- **`notice`** — `{stamp}:notice:N`, the id family every **harness one-liner** now mints (fulcrum
  PR #33, released as `fulcrum-harness` 0.5.0). `auto_retry_start`, both arms of `auto_retry_end`
  and `extension_error` went off the shared `{stamp}:system` key onto one shared counter
  (`TurnState::notice_seq` + `TurnState::notice_id`), because a same-`messageId`
  `agent_message_chunk` is APPENDED by this repo's reducer with no separator: measured on a real
  database, 103 of 104 `:system` rows carried welded text —
  `Retrying (attempt 2/5…)Retry succeededRetrying (attempt 3/5…)…Retry failed` — as one bubble.
  `system_chunk` was deleted, so **no writer of `{stamp}:system` remains anywhere**.

`system` is nonetheless **deliberately retained** in the set, and the engine's own docblock says so:
rows older Workers wrote are **on disk** carrying that key, and a peer on an older crate can still
send it. Dropping the word as dead would start accumulating historical one-liners into a **Subagent**'s
parent-facing answer as if the child had written them — the same failure the 2026-11-15 amendment
describes for a missing `truncate`, arriving by the opposite route (a word that is no longer written
but is still read). `default` stays outside the set for the reason already recorded above: it is the
no-`messageId` fallback over REAL model text.

The hex-alphabet argument still holds across all five words — a stamp is six lowercase hex chars and
`notice`, at six chars, is the only one whose *length* matches a stamp, which is why it is the word the
rule must actually be checked against; `o`/`t`/`i` are outside the hex alphabet, so a stamp still can
never equal it.

**This list is hand-mirrored from the engine, and that is the weakness.** It is not generated, not
imported, and not checked by any CI job in either repo. The re-check recipe, run in the **fulcrum**
repo:

```
grep -n 'field == "notice"' src/normalize.rs
```

— read the whole `||` chain around that line, and if it names a word this section does not, this
section is stale again and the amendment is yours to write.

What the desktop side of PR #33 is, for the record: this repo pins `fulcrum-harness = "0.5.0"` (a
`0.4.x` caret would not have admitted it, deliberately — the engine added a `pub` field to a
non-`#[non_exhaustive]` `pub struct`, which `fd4dd9c`'s precedent treats as breaking),
`normalize_display_db.rs` asserts the retry line lands on `aaaaaa:notice:0` with the unstamped-key
guard moved from the now-dead `system` to the live `notice`, and `dispositionFromRows`'s positional
last-row rule keeps working for a **different reason than it did**: the retry line is an INSERT on a
newer `id` now, so the rule holds because the engine emits `turn_truncated` *after* the retired-report
`auto_retry_end` — pinned from this side by `pins the new emission order — a retry one-liner INSERTed
before the notice does not suppress it` in `reducer.test.ts`.
