---
status: live
last-verified: 2026-11-19
verified-by: >-
  Folded from `docs/roadmap/supervisor-log-diagnostics.md` and
  `docs/roadmap/supervisor-log-diagnostics-ground-worker-arms.md` (both gitignored under
  `docs/roadmap/`, neither ever committed — this file is their only durable copy) and from the
  untracked grounding report `docs/research/supervisor-log-quadratic-display-upsert-reemission.md`
  at the close of the run that shipped engine PR #31 (`0fdddf1`, tag `v0.4.2`, published to
  crates.io; release commit `adcc0df`) plus the follow-up engine PR #32 (`6c9320d`, test-only,
  AFTER the tag — it is NOT in the published 0.4.2 artifact), and desktop PR #208 (`9997f13f`,
  pin `fulcrum-harness` 0.4.1 → 0.4.2, `Cargo.lock` checksum
  `8b699fb53a1e331a352ff8974efd4d79bc10a1935ed84a3bc9d7cbc25b775d10`).
  Every number below was re-measured on the shipped trees, not copied from the plan: the byte
  census and the one-row quadratic were re-run against the live `~/.local/share/archimedes/`
  artifacts with the research doc's own instruments (75.30%, 24.14%, 1,388×, 2,691,601 B = 51.3%,
  76.5% truncated — all reproduced exactly); every code claim was read in the PUBLISHED crate
  (`~/.cargo/registry/src/*/fulcrum-harness-0.4.2`, whose `.crate` sha256 equals the lock checksum,
  and whose eight load-bearing files are byte-identical to the engine tree at `6c9320d`) or in the
  desktop tree at `9997f13f`; the wire/DB-untouched claim is `git diff --name-only v0.4.1..v0.4.2`.
  Gates re-run for THIS doc: `scripts/check-versions.sh` → `versions match: 0.14.3`,
  `pnpm build` clean, `bash scripts/check-file-size.sh` clean (the ratchet walks only
  `*.rs`/`*.ts`/`*.tsx` under `src` and `src-tauri`, so a markdown file cannot move it).
  The full `pnpm test` / `cargo test` suites were deliberately NOT re-run for a markdown-only
  change; where a suite total appears below it is quoted from the shipped PR bodies and marked
  as reported, not re-measured. Section 10 lists what this doc could not verify.
---

# The Supervisor log stopped evicting its own diagnostics — 75% of it was one row re-serialised per token

**What this records.** Why `supervisor.log` rotated in ~71 seconds of streaming, why the card's own
diagnosis and its headline remedy were both wrong by an order of magnitude, what shipped instead
(engine `fulcrum-harness 0.4.2`, desktop PR #208), the two traps that a future refactor will
re-break, the sink inventory a supporter actually needs, and the half that is still deferred. Card
`tsk_6c7cabd3`. This was **a logging problem wearing a protocol bug's clothes**.

## 1. What was wrong, measured

`supervisor.log` — the `ARCHIMEDES_DEBUG=1` protocol transcript — rotated in ~71 s of streaming
because **75.30% of its bytes were `display-upsert` frames**: one accumulating display row
re-serialised IN FULL on every streamed token. `EmitPipeline::run` emits, per chunk, the delta on the
sink **and** a full snapshot via `Store::persist_display`; `compute_display_rows` builds that payload
as `state.current.push_str(text)` then `json!({ "text": state.current })`, and `IpcStore::persist_display`
frames `rows.to_vec()` with no coalescing and no diffing.

Re-measured today against the artifacts (`supervisor.log` + `supervisor.log.old`, mtime 2026-10-12,
still on disk), using the research doc's own re-runnable instruments:

| | value | re-measured |
|---|---|---|
| `display-upsert` share of inbound frame bytes | **75.30%** (5,873,649 B of 7,800,639 B) | ✓ exact |
| delta-carrying frames (`sink-frame` + `event`) | **24.14%** | ✓ exact |
| ratio, redundant snapshots : real deltas | **3.1 : 1** | ✓ |
| one `message_key` (`m18#18`) in `.old` | **1,388×**, 2,691,601 B = **51.3% of the whole 5 MB file, from one row** | ✓ exact |
| `display-upsert` lines cut mid-JSON by the 2 KB cap | **76.5%** (1,775 of 2,320) | ✓ exact |
| `.old` size vs the cap | 5,243,384 B = 5 MiB **+ 504 B**, matching `debuglog::append_to`'s `>=` rotation test | ✓ |
| `.old` byte rate over its own span | 73.2 s, 71.6 KiB/s | ✓ |

2,320 `display-upsert` lines in `.old` cover only **23 distinct `message_key`s** — the quadratic is
**row-size growth**, not row-count growth. And 76.5% of them were **already useless**: the 2 KB
`MAX_LINE_BYTES` cap left them cut mid-JSON and unparseable, so the file was spending three quarters
of its bytes writing garbage nobody could read.

**Only the log paid.** SQLite does not: `storage/batching.rs` coalesces by
`(session_id, kind, message_key)` last-wins and drops the intermediates before any write — its own
doc says a later `Display` row for the same key "is a complete snapshot, so LAST-WINS is the upsert's
own semantics and dropping the intermediates loses nothing". The renderer does not: the desktop's
`route_event` handles `WorkerInboundEvent::Store(frame)` as **persistence only**, and the engine's
`src/persist.rs` `StoreFrame::Display` arm is a `record_message` write path with no sink and no
webview emit — the UI gets the delta `sink-frame`. So the fix belonged at the log call site and
nowhere else, and **the wire and the DB path are byte-identical after it**: `git diff --name-only
v0.4.1..v0.4.2` names none of `normalize.rs`, `store_rows.rs`, `src/worker/store.rs`,
`src/persist.rs` or `src/debuglog.rs`. `Outbound::DisplayUpsert`, `DisplayRow`, `persist_display` and
`compute_display_rows` are untouched. A protocol-level delta frame would have saved Worker CPU and
IPC bytes that **no user symptom is attached to**, at the cost of a wire change plus consumer edits,
and was rejected on that basis.

## 2. The card's diagnosis was wrong, and the units trap that made it so

The card said "99.95% verbatim conversation **token deltas**" and that gating frame bodies behind a
second opt-in would buy **~4.7 hours**. Both refuted by measurement:

- The delta-carrying frames are **24.14%**; the full-snapshot re-emissions are **75.30%**. "Gate the
  frame bodies" gates the wrong 24%.
- The literal remedy — keep a 38-byte envelope per frame — measures **~28 minutes** of continuous
  streaming, not 4.7 h. At ~80–90 frame lines per active second, *any* non-trivial per-line cost
  precludes hours.

**The cause is a named trap, not a one-off arithmetic slip: the card divided diagnostic bytes — which
accrue per WALL-CLOCK hour — by ACTIVE-STREAMING seconds, and the duty cycle between those two clocks
is ~1.4–1.6%.** Re-measured on the artifacts: 132 distinct seconds carry a frame line and 147 carry a
line of any kind, over a 9,537 s (2.65 h) wall span → 1.38% and 1.54%; the research doc's 148
active-seconds / 1.6% is the same quantity measured per file and summed. Dividing the non-frame
remainder by active seconds instead of wall clock inflates the answer ~64×, and that is exactly the
10×-plus error between 28 min and 4.7 h. **A units mix between a wall-clock numerator and an
active-time denominator produced a 10× error in a retention prediction that was used to size a
user-facing decision.** When you compute retention, reachability, or cost-per-report, state which
clock each side is in. The decision-relevant column here is *continuous streaming* — a user who
reproduces a bug during a 3-minute turn and opens the log immediately lives in active time, not in
wall-clock averages.

The card's other claims did not survive either: "702 `attention:` lines in `.old`" is the exact
substring-in-a-JSON-payload trap the card itself warns about two sentences earlier (anchored, the
count is **0**; all 37 are in the other file), and "all 9 `eprintln!("harness: …")` sites" is a grep
artifact — three sites open a multi-line literal, so the prefix is not on the `eprintln!` line, and the
research doc counted **12** at the then-pin `0.3.2`. That number is the `0.3.2` census, not a current
one: 0.4.2 adds the drop-site lines, so re-count it before quoting it again.

## 3. What shipped

**Engine `fulcrum-harness 0.4.2`** — PR #31 `0fdddf1`, annotated tag `v0.4.2`, published to
crates.io (`cargo publish -p fulcrum-harness`; `release.yml` does NOT publish). **Desktop PR #208**
`9997f13f`, pin `0.4.1` → `0.4.2`, `Cargo.lock` moved only that crate's version and checksum, no
`patch.unused` stanza, so the pin took and the desktop builds the published crate.

**(a) `display-upsert` is logged as a one-line JSON summary; every other frame type stays verbatim,
unconditionally, no new flag.** The helper is `summarise_display_upsert(session_id, rows, bytes)` in
`src/worker/client.rs`, and the summary is rendered from `summarise_display_upsert`'s private
`DisplayUpsertSummary` — a `#[derive(serde::Serialize)]` struct, not a `json!` literal (see §4a). The
shipped key order is `type`, `sessionId`, `rows`, `rowKeys`, `rowKeysOmitted` (absent unless rows were
dropped), `bytes`. `rowKeys` entries carry `kind` **and** `message_key` — the two discriminators of the
SQLite coalesce triple — which is richer than the plan's shape.

- **`payload_json` is never read**, nor `created_at`. The payload is the quadratic body being removed,
  and the deltas that produced it are logged verbatim in the same file, so the row content stays
  recoverable (§8, where that is *proven*, not believed).
- **`bytes` is the pre-truncation wire length** (`l.len()`). Once the body is gone this is the only
  surviving record of the true frame size, which is what byte accounting needs.
- **The summary does not go through `log_truncated`, and that is deliberate.** `truncate_line` cuts
  bytes and appends `…`, so on this line it lands mid-JSON: the `rowKeys` array loses its closer and
  `rowKeys` is exactly what the cut removes — that is the 76.5%-unparseable failure the summary exists
  to end. So the line is bounded **by construction** instead: `MAX_SUMMARY_ROW_KEYS` (12) caps how many
  keys are *listed*, `MAX_SUMMARY_KEY_BYTES` (48) caps every listed string and the `sessionId` via
  `cut_field`, `rows` stays the frame's TRUE count, and `rowKeysOmitted` states the difference so a
  short list beside a large `rows` can never be misread. The ceiling is `MAX_SUMMARY_LINE_BYTES` =
  `debuglog::MAX_LINE_BYTES` (2 048) — the same budget every other inbound frame is cut at, so this
  frame is exempt from the truncation *mechanism* and not from the size bound.
  `a_large_row_set_is_capped_and_the_summary_stays_valid_json` asserts a 600-row frame lands under it,
  and a `debug_assert!` in the helper surfaces a broken bound in tests. **Caveat: a `debug_assert!` is
  compiled out of a release build** — there the bound rests on that arithmetic and that test.

**(b) The log call had to move BELOW the decode, and the `decode_outbound` `Err` arm must log the
malformed line itself.** A summary needs the typed frame, so the log moved from above
`decode_outbound` to below it — and that arm `continue`s, so without its own
`debuglog::log_truncated("←", &l)` the undecodable line, "a wire the two sides disagree about", would
be logged **nowhere**. It used to be covered for free by the call above the decode. ⚠ **`Err` arm of
`decode_outbound` in the inbound read loop is the regression a future refactor will re-break** — it is
the one line of this change that is invisible in a diff review, and it is guarded by
`an_undecodable_inbound_line_is_still_logged_verbatim`, which drives a non-JSON line through the real
read loop and asserts it lands in the log (`#[cfg(unix)]`; the Windows leg rests on the verbatim `_`
arm plus the unit tests). The second trap of the same move: `route_outbound` takes `frame` **by
value**, so the summary is taken from `&frame` before it. `tests/worker_log_summary.rs`'s
`a_display_upsert_reaches_the_log_as_a_summary_with_no_payload` proves the other half — that the
summary reaches the file and the payload text does not. The `←`/`→` sites had **zero** test coverage
before this.

**(c) The three provider parsers now log every tool call they discard, and the turn loop counts
streamed tool-call deltas.** Shared builders in `src/harness/provider/openai.rs` —
`tool_call_dropped_with_no_name` (parser, stage, index, `id`, `args_bytes` — the LENGTH, never the
arguments) and `tool_calls_dropped_at_stream_error` (`in_flight`, `named_any`) — written to both sinks
by `emit_harness_line`. Sites: the nameless-acc `continue` in each `flush_tool_calls`; the
**parse-time** nameless arm on Responses' `output_item.done` (a flush-only diagnostic would never fire
on the common Responses lifetime); and the latches that set `exhausted` / `terminated` and thereby make
the stream-end flush unreachable — the class the plan found and the card missed. Concretely that is
**five** arms: the in-stream `error` arm on `anthropic` and `openai`, and the transport-error arm on all
three wires, each gated on a non-empty accumulator so a healthy turn stays silent. On Responses the
`completed` / `incomplete` / `failed` / `error` terminal arms carry **no** flush-skip line, because those
arms now call `flush_tool_calls()` in-arm before latching — the loss is closed rather than logged (that
fix predates this card, from the #193 work), and §4b explains why the one Responses latch that does log
counts `!acc.done` instead of `!is_empty()`.
`TurnAccumulator.tool_call_deltas` plus `turn::settled_with_nothing_dispatched` (a pure
`-> Option<String>` with the guard *inside* it, because none of the engine's `harness:` sites has a
stderr-capture crate to test against) lets a settle that dispatched nothing say whether a call was
**streamed and lost** or **never arrived** — the only question that site is being asked, and
unanswerable before, because `acc.tool_calls` holds what the parser assembled and nothing held what
the stream carried.

**(d) One non-UTF-8 byte no longer ends a Worker's stderr drain.** `spawn_pipe_reader` in
`src/worker/client.rs` now takes `Err(ref e) if e.kind() == InvalidData => continue` (one bad byte is
not a dead pipe) and keeps `Err(_) => break` (a dead pipe has nothing left to say). Continuing cannot
spin: tokio's `read_until_internal` **consumes** the delimiter-terminated bytes before
`String::from_utf8` runs, and `finish_string_read`'s `InvalidData` path restores only the caller's
pre-existing prefix via `put_back_original_data`, which truncates the newly read bytes away. The bad
line has left the stream either way. Verified against the tokio 1.54.1 source, not asserted from the
doc comment. Driven end-to-end by `a_non_utf8_line_does_not_end_the_drain_the_lines_after_it_still_arrive`
via the fixture's `__stderr_badbytes__` raw-bytes arm (`eprintln!` takes `&str` and cannot produce an
invalid byte). **The daemon's frame reader keeps the strict rule on purpose** —
`fulcrum/src/transport/frame.rs` still `break`s on `String::from_utf8` failure, because a socket is a
protocol channel and a byte stream that is not text is not a peer worth resyncing with, while a stderr
pipe is a diagnostic pipe and a diagnosis must not be suppressed by bytes in an unrelated line. The
`worker-stderr:` prefix is byte-identical; the desktop's `worker_stderr.rs` marker still pins it.

## 4. Two traps that will bite again

### 4a. `serde_json`'s `Map` is a `BTreeMap` here, so `json!` does NOT preserve insertion order

`serde_json`'s `preserve_order` is a **non-default** feature and neither manifest enables it — verified
in the lock-resolved `serde_json` 1.0.154 manifest (`default = ["std"]`) and in its `map.rs`
(`MapImpl<K, V> = BTreeMap<K, V>` under `cfg(not(feature = "preserve_order"))`; the `indexmap` entries
in the lock belong to other crates). So `json!` serialises **sorted**, which would emit
`{"bytes":…,"rowKeys":…,"rows":…,"sessionId":…,"type":…}` — **`type` LAST** — and the two measurement
instruments in `docs/research/supervisor-log-quadratic-display-upsert-reemission.md` regex on
`"type":"` at the start of the body. They would have returned **0** and reported "the frames are gone"
while the change was silently doing nothing. A `#[derive(Serialize)]` struct emits **declaration**
order, so `type` is first **by construction**, and the key names are still serde's own (field name +
`camelCase`) rather than a hand-typed copy in a `format!`. ⚠ **Any future "just use `json!`" refactor
of `DisplayUpsertSummary` silently breaks the instruments** — the unit test
`summarise_display_upsert_leads_with_type_and_names_every_row_key` asserts `out.starts_with("{\"type\":\"display-upsert\"")`
and is what reddens it.

### 4b. A `done` accumulator is not a lost call

On the Responses wire, `output_item.done` emits the `ToolCall` **at parse time** and deliberately
leaves the `ResponsesToolAcc` in the map with `done = true`; `flush_tool_calls` then skips it
(`if acc.done { continue; }`) so the call is not dispatched twice, and a `done` acc also suppresses the
stream-end synthetic `Done(Error)`. So a guard written as `!tool_acc.is_empty()` at a terminal latch
reports a **delivered** call as lost — and this fires on every healthy Responses turn with a tool call.
The correct gate is `filter(|acc| !acc.done).count()`, i.e. `flush_tool_calls`'s own rule. The other
two wires are immune **by construction, not by luck**: `AnthropicToolAcc` and `ToolAcc` have no `done`
field at all and their `flush_tool_calls` does `std::mem::take(&mut self.tool_acc)`, so the map is
empty before any latch can be read. That asymmetry is why the same guard is correct on two files and
wrong on the third.

## 5. The Worker's diagnostics channel — the part that changed the user-visible outcome

`diagnostics.log` is the always-on channel (ADR 0110): **no env var**, a strict no-user-content rule
(no transcript, prompt, model answer, token, bearer or file body), 1 MiB rotation. It was **dead in the
one process that needed it**. At `v0.4.1` every `diagnostics::init` in the engine sits inside a
`#[cfg(test)] mod tests`, so `record` was a silent no-op inside a `--worker` child — the Worker was
armed by nothing, and the symptom this card exists for (a tool call dropped, a turn that settled
without an answer) happens *in* the Worker and in subagent children.

0.4.2 arms it through a new **additive** `StartEnv::diagnostics_dir` (`#[serde(default)]`, camelCase
`diagnosticsDir`) plus `StartEnv::with_diagnostics_dir`, applied in `worker/core.rs`'s `Inbound::Start`
arm — the engine's only non-test `diagnostics::init`, deliberately applied *before* `build_loop` so
`log_wire`'s line, which fires inside `build_loop`, is observable. `StartEnv` derives neither
`#[non_exhaustive]` nor `deny_unknown_fields` and `decode_inbound` ignores unknown keys, so both wire
directions are compatible: an old Supervisor leaves the Worker unarmed (the old silence), a new
Supervisor against a 0.4.1 Worker has the key dropped. The desktop wires it as a **separate** late-wired
`diagnostics_dir` (`Arc<OnceLock<PathBuf>>` + `set_diagnostics_dir` / `with_diagnostics_dir`, mirroring
`crash_log_dir`'s shape because a `setup()`-time value cannot be a constructor argument) chained onto
the `start` envelope in `establish_worker_session` — which start and resume both route through — and
`subagent_flow.rs` inherits the parent's live value, so **child Workers are armed by the same line and
the Worker resolves no directory at any depth**.

**Why the directory crosses the wire instead of the Worker calling `dirs::data_dir()`: five tests spawn
a real Worker, send a real `start`, and inherit the developer's real data dir with no isolation.** Every
one of them reaches `default_build_loop` → `build_provider_with_headers` → `log_wire` →
`diagnostics::record`, which is line 1 of the file; self-resolution would write into every developer's
`~/.local/share/archimedes/` and into CI's. The wire-carried directory escapes this because those
fixtures build through `StartEnv::from_parts`, which leaves the field `None` — unarmed, zero test edits.
That asymmetry, not the constructor-arity question, is what decided the design. `scripts/check-test-data-dir.sh`
now catches `diagnostics.log` and `diagnostics.log.old` too; before this it matched **only**
`crash-*.log`, so a stray `diagnostics.log` walked straight past it.

`fulcrum serve` arms **neither** channel — its `start_env` forwards the client's payload verbatim and
deliberately leaves `diagnosticsDir` unset — so in a `fulcrum serve` deployment these lines reach only
whatever the daemon does with the process's stderr.

## 6. Two accepted trade-offs, stated as accepted

- **`diagnostics.log` now has two writer processes** (the Supervisor plus one Worker per session), all
  appending to the SAME file. `write_all` under `O_APPEND` makes seek-to-end-plus-write **atomic per
  inode**, and the handle opens and closes inside one call, so **no record is ever split or
  interleaved** — and that guarantee survives a rename, so a record that lands in a file a concurrent
  writer has just rotated arrives whole (in the `.old`, possibly out of order; attribution only). But
  the check-then-`rename` rotation is **not** atomic: two writers can both see the threshold and both
  rename, and the second clobbers the first's `.old` — up to 1 MiB of **already-rotated** history.
  **The live file loses nothing.** Per-Worker `diagnostics-<pid>.log` filenames were rejected because
  they would end the race by destroying the file's whole value, which is being *the one file* a
  supporter asks for; a lock around the rotate+append window was rejected as buying one megabyte of
  rotated history at the price of a new failure mode. Arming the Worker changes the **frequency** of
  the window, not its **kind**. On Windows the losing writer's next `open` can additionally fail inside
  a delete-pending window and one record is simply absent — that leg is **reasoned from std's
  `share_mode`, not measured**; no Windows host was available.
- **`Option<PathBuf>` on the wire means a non-UTF-8 directory PANICS in `encode_inbound`** rather than
  returning a `WorkerError`: serde serialises a `PathBuf` via `Path::to_str` and `encode_line`
  `.expect`s. Measured, not reasoned — `/tmp/bad\xffpath` panics with `path contains invalid UTF-8
  characters`. `String` is **worse**, because it moves the lossy conversion INTO the Worker's
  `init(PathBuf::from(s))` instead of failing at the Supervisor's encode. And on `fulcrum serve` the
  field is **client-influenced** — the daemon parses the client's `start` payload with
  `from_value::<StartEnv>` and forwards it verbatim, so a client can point a Worker's `diagnostics.log`
  at a path it chose. It is same-uid-gated by the peer-credential check (`TransportError::PeerIdentity`
  in `transport/unix`), and a same-uid process can already open any file this field could name, so it
  grants no write the peer did not have; what lands there is only counts, a closed wire-enum name and
  sanitised ids. The follow-up if it ever bites is an error around `encode_line`'s `.expect`, **not a
  type change**.

## 7. Sink inventory — "is this line visible in a default launch?"

With `ARCHIMEDES_DEBUG` unset: **dual-sink** lines (`eprintln!` + `diagnostics::record`) reach
`diagnostics.log`; **`eprintln!`-only** lines reach **nothing at all** (the Worker's stderr is always
drained, but the drain's forwarder is `debuglog::log_truncated`, which returns immediately without the
var, and the Supervisor's own stderr is inherited and never persisted — on a
Windows release build the GUI subsystem discards it outright). Verified line by line against the
published 0.4.2 artifact.

**Dual-sink → visible in a default launch:** every parser tool-call discard and every flush-skip latch
(the three `emit_harness_line` call groups across `anthropic.rs`, `openai.rs`, `responses.rs`);
the settle-with-nothing-dispatched line; `log_wire`'s `provider wire=… model=… base=…` (payload is a
closed enum, `one_field_per_line`'d id and `reduced_base_url` — never a raw `base_url`, which can
legitimately carry userinfo or a SAS query). `worker/manager/pump.rs`'s lagged-frames line is
**`record`-only** and is Supervisor-side anyway.

**`eprintln!`-only → reaches nothing without the var:** the three `responses` post-terminal-item drop
lines (`output_item.added`, `function_call_arguments.delta`, `output_item.done`) — held off the
always-on channel on a **deliberate volume decision** ("one line per dropped item on a stream is not
always-on-worthy volume for a shape that has never been observed on a real wire", and the docblock says
explicitly that arming the Worker made that judgement load-bearing rather than theoretical);
`parse_arguments`' `harness: malformed tool-call arguments — using {}`; `handle_truncated_turn`'s
output-cap line; and the pre-existing `handle_empty_turn`, mid-stream-model-error, `model call failed`,
turn-bound, and unknown-`stop_reason`/`finish_reason` lines.

**Silent on every sink, still:** the missing-`index` fragment drops and the same-index `insert` clobber
in the parsers, and the unparseable-SSE-line arms. Real silent losses, not covered by this change.

When the var IS set, a dual-sink line appears in **both** files by design — `worker-stderr: harness: …`
(2 KB-cut) in `supervisor.log`, bare and uncut in `diagnostics.log`. That duplication is defended in
three docblocks and neither half may be deleted on the strength of the other; the reason it matters is
that `supervisor.log` is the file that holds transcript and reasoning content and must NOT be sent to a
supporter, while `diagnostics.log` is the small one that can be.

## 8. Residual risks — with their status updated

**CLOSED AND PROVEN (was: believed safe, not proven).** The report's Gap 3 — "`display-upsert`
reconstructable from the deltas?" — is **closed**. Engine PR #32 (`6c9320d`) added
`the_display_row_is_recoverable_by_replaying_the_deltas_alone` to `normalize.rs`'s
`compute_display_rows_tests`: it drives one interleaved turn (reasoning → reply → tool call → MORE
reasoning under the SAME `messageId` → rest of reply), reads row state from a type whose `summary`
field is `(kind, message_key)` only — `payload_json` is discarded **by the type**, exactly as the log
discards it — and asserts that **every intermediate snapshot** the log stopped writing is reproduced by
replaying the deltas, then that the whole last-wins transcript equals the truth. Folding by
`message_key` yields the separate segments of one `messageId` (`m1#1`, `m1#2`) without collision, a
non-vacuity assertion pins that the stream really opened the second segment, and **collapsing the fold
key to the bare `messageId` reddens the test at the third chunk with the reply text welded onto the
first thought segment** — so the test measures the named failure rather than observing nothing. Say it
plainly: **this one is proven, not believed.** Note the test landed *after* the tag: it is in engine
`main` at `6c9320d` and **not** in the published `0.4.2` artifact (verified — the published
`normalize.rs` differs and does not contain it).

**Still open, and unchanged:**

1. **The two log-bearing sessions' absence from the DB is unexplained.** Re-checked today: both ids
   named in the log have **0 rows** in `sessions` and `messages`, while the (now 2.6 GB) database holds
   2,591 sessions spanning 2026-10-04 → today, **12** of them stamped on the artifacts' own day
   (`created_at` date = 2026-10-12; the report's "30 same-day" counts 2026-10-11..13). If that is a
   persistence bug it is a separate card. Its consequence for this change is real either way: **the log was the only record
   of those turns**, which argues for summarising the snapshots rather than treating the transcript as
   disposable.
2. **The 72.1 KiB/s figure is a peak burst** from one 73-second window; `supervisor.log` streams at
   0.3 KiB/s over a 9,464 s span. No distribution was measured, so every retention figure here carries
   unquantified variance.
3. **The log artifacts are 38 days old** (mtime 2026-10-12) and byte-identical to what the card
   measured, so nothing in §1 reflects any logging change since, and they are one machine's sample.
4. **Claude Code's exact debug rotation figures rest on one user reading a minified bundle. Do not cite
   them as fact.**
5. **Privacy, restated accurately:** sampling found zero credential-shaped strings; what the bodies
   carry is assistant **reasoning text**, tool I/O, thousands of filesystem paths and session ids, and
   verbatim model prose. That is the class OTel's GenAI semconv treats as sensitive and defaults to not
   capturing — the argument is conversation and reasoning content, not secrets.

## 9. The deferred half — what is still true today

Removing the snapshots took a streaming turn from **~1.7 min** of retention to **~5 min** at the 5 MB
cap. That clears a typical turn. **It does not clear a long one.** (The plan's figure is ~5.6 min; it
models the summary at ~100 B/line. Re-measured against the actual shipped shape, a realistic
`message_key` and `sessionId` make the line ~180–200 B and the model gives 4.8–5.0 min. Both are the
same model; the honest statement is "roughly 5 minutes, not the plan's 5.6", and both are far short of
the ~6.7 min that deleting the frame's lines entirely would give.)

**Gating the delta bodies (`sink-frame` + `event`, 24.14%) is the deferred step**, and it is the only
change in this area that would need a **second user-facing switch** — which reopens **ADR 0063's
one-switch decision** (that ADR names its own reopen path: *"If the switch proves too costly in
practice, reopen this bullet rather than re-deriving it"*) and would change **ADR 0110**'s gate table.
⚠ **Anyone starting that work must engage those two ADRs first, mid-design, not discover the dependency
mid-implementation.** Nothing shipped here reopens them: summarising one frame type at one call site is
unconditional and adds no tier, which is why no ADR was written for it.

Still out of scope, and still true:

- **No in-app log affordance and no Settings toggle.** Re-checked: nothing in `src/` or `src-tauri/src`
  offers a log path, reveal or toggle; the only log-adjacent affordance in the app is
  `SessionStalledBanner.tsx` handing a *crash-log* path to External open. Every GUI exemplar in the
  research corpus has a runtime toggle; `debuglog::init` is unguarded and re-callable, so one is
  mechanically available today — it is a design decision, not a capability gap.
- **`RpcEvent` has no "this turn failed" variant.** `settle_error`'s body is byte-identical to
  `settle_cancelled`'s (same three statements: close announced, `turn_abandoned`, `turn_end` +
  `agent_settled`), `turn_end` carries no reason, and the desktop's `resolve_turn` maps an un-flagged
  settle to `StopReason::EndTurn`. **A failed turn still surfaces to the user as a normal end of
  turn.** That is a real defect and a separate card; adding `eprintln!`s cannot fix it, which is why
  this change did not try.

## 10. NOT VERIFIED — listed so a reader can soften or close each

- **The five-test isolation census.** The mechanism is verified (those fixtures build through
  `StartEnv::from_parts`, which leaves `diagnostics_dir` = `None`; `worker_smoke.rs` and
  `worker_stdin.rs` take no `HOME`/`XDG_DATA_HOME` isolation at all, and `WorkerHandle::spawn` sets no
  environment). The **count "five" was not independently re-derived**: `worker_e2e.rs` holds more
  real-binary tests that send a real `start` than that, and several of them DO isolate `HOME` behind
  `test_support::ENV_LOCK` + `set_var`. Treat the number as the grounding doc's, and the *reason* as
  verified.
- **Every suite total in this area is quoted, not re-measured.** The engine's `cargo test` /
  `clippy --all-targets -D warnings` / `fmt --check` / mingw `cargo check` results and the desktop's
  `pnpm test` 189 files / 4,603 passed and `cargo test` 740 + integration targets come from the shipped
  PR bodies of #31 and #208. This repo's own engine docs disagree about test totals, and the engine
  rule is to verify tests **by name, never by count** — so no total in this file should be treated as a
  pin.
- **The Windows legs.** The `an_undecodable_inbound_line_is_still_logged_verbatim` guard is
  `#[cfg(unix)]` (a shebang script is not executable on Windows); the Windows `diagnostics`
  delete-pending rotation outcome is reasoned from std's `share_mode` and unmeasured; and the README's
  macOS `launchctl setenv` / `LSEnvironment` routes are labelled unverified-on-hardware there and are
  not asserted here either.
- **Whether a real `display-upsert` frame ever exceeds `MAX_SUMMARY_ROW_KEYS` (12).** The ordinary
  frame carries exactly one row and the doc names `message_retracted` (one row per erased thought
  segment) as the plausible large case, but no real large-row frame was observed.
- **The retention figures** (§9) are the research doc's model re-run on the artifacts, not a measured
  post-fix log: **no `ARCHIMEDES_DEBUG=1` streaming turn has been run against a 0.4.2 build on this
  box**, so no before/after bytes-per-active-second was measured on the shipped code. The 75.30% /
  1,388× / 76.5% figures are pre-fix measurements — that is what the fix removed.
- **Whether the two sessions in §8/1 have any relationship to this change.** None was found; the
  investigation was explicitly not done.

## 11. Open follow-ups

1. **Delta-body gating** (§9), with ADR 0063 and ADR 0110 engaged first.
2. **A `RpcEvent` failed-turn variant** (§9) — the user-invisibility of a failed settle.
3. **The remaining silent drops in the parsers**: missing-`index` fragments, the same-index `insert`
   clobber (OpenAI alone merges; the other two overwrite), and unparseable SSE lines — §7.
4. **The `fulcrum serve` deployment arms neither channel.** Taking that decision is one
   `.with_diagnostics_dir(…)` on the parsed env in `fulcrum/src/serve.rs`, and it is a decision about a
   deployment nobody has asked about yet.
5. **A citation-rot sweep, not a per-visit fix.** This doc deliberately names symbols and files and
   carries **no `file:line` citations**, because a line-number citation into a hot file is worth
   exactly one commit. `docs/features/abandoned-tool-rows.md` still has stale ones and its §5/§9 were
   never re-read; the engine's `context_usage` test docblock still cites line numbers that now point at
   comments. Same rule, one sweep.
